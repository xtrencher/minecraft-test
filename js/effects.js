// Explosions (grenades, bazooka rockets): carve a crater out of the terrain
// in one batched edit, let water flood in where the sea is breached, and
// sell it with debris, a fireball, sparks, smoke, a dust ring, a shockwave,
// a light flash, camera shake and a boom. Everything scales with the blast
// radius; shake and sound fall off smoothly with the listener's distance.
// Also owns the shared particle pools and the persistent dynamic lights.
import * as THREE from "three";
import { LAYER_FX } from "./layers.js";
import { BLOCK } from "./blocks.js";
import { SEA_LEVEL, WORLD_HEIGHT } from "./constants.js";
import { DebrisPool, BillboardPool } from "./particles.js";
import { shakeFalloff } from "./falloff.js";

export const GRENADE_RADIUS = 7;
// Was 5x a grenade's radius; reduced to a third of that size.
export const BAZOOKA_RADIUS = (GRENADE_RADIUS * 5) / 3;
export const AIRSTRIKE_METEOR_RADIUS = GRENADE_RADIUS * 1.3;
const MAX_BLAST_RADIUS = 40; // hard cap on the carve radius (cost grows with r^3)
const MAX_FLOOD_CELLS = 12000; // bound on how much water one blast can let in
// Craters are wide, flat ellipsoids (roughly this many times wider than
// deep) rather than spheres, closer to how a real blast digs into the ground.
const CRATER_VERTICAL_SCALE = 2;
// Per-weapon explosion-size multipliers, changed live from the settings menu.
export const explosionScale = { grenade: 1, bazooka: 1, airstrike: 1 };

// A lumpy crater shape: the blast radius varies smoothly with direction (a
// few random low-frequency waves over the sphere of directions). Because the
// radius depends only on direction, the carved region is star-shaped around
// the center: every removed block has a path of removed blocks back to the
// center, so a blast never leaves sealed air bubbles inside the crater wall.
function makeCraterShape(lumpiness) {
  const waves = [];
  for (let i = 0; i < 3; i++) {
    const v = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    const freq = 2 + Math.random() * 2;
    waves.push({ x: (v[0] / len) * freq, y: (v[1] / len) * freq, z: (v[2] / len) * freq, phase: Math.random() * Math.PI * 2 });
  }
  return (ux, uy, uz) => {
    let sum = 0;
    for (const w of waves) sum += Math.sin(w.x * ux + w.y * uy + w.z * uz + w.phase);
    return (sum / waves.length) * lumpiness;
  };
}

// Trauma-based camera shake: explosions add "trauma" (0-1) that decays over
// time; the visible shake scales with trauma^2 so small bumps stay subtle.
export class CameraShake {
  constructor() {
    this.trauma = 0;
    this.time = 0;
  }

  add(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 0.9);
  }

  // Offsets the camera after the player has positioned it for this frame.
  apply(camera) {
    if (this.trauma <= 0) return;
    const s = this.trauma * this.trauma;
    const t = this.time * 22;
    // Sums of sines at unrelated frequencies: smooth, non-repeating jitter.
    const n1 = Math.sin(t * 1.0) * 0.5 + Math.sin(t * 2.31 + 1.7) * 0.3 + Math.sin(t * 4.13 + 0.3) * 0.2;
    const n2 = Math.sin(t * 1.13 + 4.1) * 0.5 + Math.sin(t * 2.71 + 0.2) * 0.3 + Math.sin(t * 3.97 + 2.9) * 0.2;
    const n3 = Math.sin(t * 0.93 + 2.3) * 0.5 + Math.sin(t * 2.53 + 5.1) * 0.3 + Math.sin(t * 4.41 + 1.1) * 0.2;
    camera.position.x += n1 * s * 0.3;
    camera.position.y += n2 * s * 0.3;
    camera.position.z += n3 * s * 0.3;
    camera.rotation.x += n2 * s * 0.045;
    camera.rotation.y += n3 * s * 0.03;
    camera.rotation.z += n1 * s * 0.06;
  }
}

export class EffectsSystem {
  constructor(scene, world, audio) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.lastExplosion = null;
    this.explosionCount = 0;
    this.shake = new CameraShake();
    this.listener = new THREE.Vector3(); // where the player's ears are
    // Called with (position, radius, source) after each explosion, so the
    // game can damage and fling the player and mobs.
    this.onExplosion = null;

    this.debris = new DebrisPool(scene, world, 700);
    this.smoke = new BillboardPool(scene, 520, { additive: false });
    this.glow = new BillboardPool(scene, 700, { additive: true });

    // The light count never changes at runtime: adding/removing a light makes
    // three.js recompile every lit material, which would hitch on every shot
    // and explosion. So these lights always exist and are dimmed to zero
    // while unused.
    this.projectileLight = new THREE.PointLight(0xff9a40, 0, 16, 1.6); // rocket exhaust
    this.flashLight = new THREE.PointLight(0xffb060, 0, 60, 1.3); // explosion flash
    this.muzzleLight = new THREE.PointLight(0xffc070, 0, 12, 1.8); // gun muzzle flash
    scene.add(this.projectileLight, this.flashLight, this.muzzleLight);
    // Lights shine in every render pass (world, water, effects).
    for (const light of [this.projectileLight, this.flashLight, this.muzzleLight]) light.layers.enableAll();
    this._flashTime = Infinity;
    this._flashPower = 0;
    this._muzzleTime = Infinity;

    this._rings = [];
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.85, 1, 64),
        new THREE.MeshBasicMaterial({
          color: 0xffd9a0,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      ring.layers.set(LAYER_FX);
      ring.userData.age = Infinity;
      ring.userData.radius = GRENADE_RADIUS;
      scene.add(ring);
      this._rings.push(ring);
    }

    this._tmpColor0 = new THREE.Color();
    this._colors = {
      fireHot: new THREE.Color(1.0, 0.55, 0.16),
      fireMid: new THREE.Color(1.0, 0.4, 0.07),
      fireEnd: new THREE.Color(0.5, 0.09, 0.02),
      smokeDark: new THREE.Color(0.12, 0.11, 0.1),
      smokeLight: new THREE.Color(0.42, 0.4, 0.38),
      dust: new THREE.Color(0.5, 0.43, 0.34),
      spark: new THREE.Color(1.0, 0.8, 0.45),
    };
  }

  // Removes blocks in a lumpy, flattened ellipsoid around `center` (never
  // bedrock; water absorbs the blast) in one batched edit; returns the
  // removed blocks as a flat [x, y, z, id, ...] array. Columns whose chunk
  // isn't loaded yet (a very long-range shot into distant/LOD terrain) are
  // carved approximately against the deterministic height map instead, and
  // queued as block edits that apply automatically once that chunk loads.
  _carve(center, radius) {
    const world = this.world;
    const lumpiness = Math.max(0.75, radius * 0.1);
    const r = Math.min(radius, MAX_BLAST_RADIUS) - lumpiness;
    const shape = makeCraterShape(lumpiness);
    const reach = Math.ceil(r + lumpiness);
    const vReach = Math.ceil(reach / CRATER_VERTICAL_SCALE);
    const bx = Math.floor(center.x);
    const by = Math.floor(center.y);
    const bz = Math.floor(center.z);
    const removed = [];
    const edits = [];
    const y0 = Math.max(0, by - vReach);
    const y1 = Math.min(WORLD_HEIGHT - 1, by + vReach);
    const maxR2 = (r + lumpiness) * (r + lumpiness);
    for (let x = bx - reach; x <= bx + reach; x++) {
      for (let z = bz - reach; z <= bz + reach; z++) {
        const ox = x + 0.5 - center.x;
        const oz = z + 0.5 - center.z;
        const h2 = ox * ox + oz * oz;
        if (h2 > maxR2) continue;
        // Read the column straight from its chunk (this loop visits up to
        // ~300k cells for a bazooka blast); fall back to the height map for
        // terrain that hasn't generated yet.
        const chunk = world.getChunk(x >> 4, z >> 4);
        const blocks = chunk ? chunk.blocks : null;
        const col = ((z & 15) << 4) | (x & 15);
        const surfaceY = blocks ? 0 : world.heightAt(x, z);
        for (let y = y0; y <= y1; y++) {
          let id;
          if (blocks) {
            id = blocks[(y << 8) | col];
            if (id === BLOCK.AIR || id === BLOCK.WATER || id === BLOCK.BEDROCK) continue;
          } else {
            if (y < 2 || y > surfaceY) continue; // approximate: solid ground below the surface, never bedrock
            id = y >= surfaceY - 3 ? BLOCK.GRASS : BLOCK.STONE;
          }
          const oy = (y + 0.5 - center.y) * CRATER_VERTICAL_SCALE;
          const d2 = h2 + oy * oy;
          if (d2 > maxR2) continue;
          const d = Math.sqrt(d2);
          if (d > 0.5 && d > r + shape(ox / d, oy / d, oz / d)) continue;
          removed.push(x, y, z, id);
          if (blocks) edits.push(x, y, z, BLOCK.AIR);
          else world.queueEdit(x, y, z, BLOCK.AIR);
        }
      }
    }
    // One bulk edit: a single light update and one rebuild per affected chunk.
    world.setBlocks(edits);
    return removed;
  }

  // Carved cells at or below sea level that connect to existing water fill
  // back in, so a blast at the shore or under the sea doesn't leave a dry
  // air pocket held up by invisible walls of water. The water also spreads
  // into any older air space the blast breached below sea level (an earlier
  // crater, a dug tunnel), up to MAX_FLOOD_CELLS blocks.
  // Public for block mining too: a mined block next to the sea fills in.
  floodInto(removed) {
    const world = this.world;
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    // Seeds: carved (now air) cells at or below sea level touching water.
    const queue = [];
    for (let i = 0; i < removed.length; i += 4) {
      const x = removed[i];
      const y = removed[i + 1];
      const z = removed[i + 2];
      if (y > SEA_LEVEL) continue;
      if (dirs.some(([dx, dy, dz]) => world.getBlock(x + dx, y + dy, z + dz) === BLOCK.WATER)) queue.push(x, y, z);
    }
    if (queue.length === 0) return;
    // Breadth-first, so the cells nearest the breach (the crater itself)
    // fill before the cap is reached somewhere down a connected cave.
    const filled = new Set();
    const edits = [];
    let head = 0;
    while (head < queue.length && filled.size < MAX_FLOOD_CELLS) {
      const x = queue[head++];
      const y = queue[head++];
      const z = queue[head++];
      const key = `${x},${y},${z}`;
      if (filled.has(key) || world.getBlock(x, y, z) !== BLOCK.AIR || !world.getChunk(x >> 4, z >> 4)) continue;
      filled.add(key);
      edits.push(x, y, z, BLOCK.WATER);
      for (const [dx, dy, dz] of dirs) {
        const ny = y + dy;
        if (ny > SEA_LEVEL || ny < 0) continue;
        if (!filled.has(`${x + dx},${ny},${z + dz}`) && world.getBlock(x + dx, ny, z + dz) === BLOCK.AIR) queue.push(x + dx, ny, z + dz);
      }
    }
    world.setBlocks(edits);
  }

  // Blows up at `position`. source: "grenade" | "bazooka" | "airstrike" (for
  // death messages and the per-weapon explosion-size setting).
  explode(position, { radius = GRENADE_RADIUS, source = "grenade" } = {}) {
    radius *= explosionScale[source] ?? 1;
    const t0 = performance.now();
    const removed = this._carve(position, radius);
    this.floodInto(removed);
    const carveMs = performance.now() - t0;
    this._spawnExplosionParticles(position, removed, radius);

    // Summary of the most recent blast (read by the smoke test and handy
    // when poking at the game from the dev console).
    let maxDist = 0;
    for (let i = 0; i < removed.length; i += 4) {
      const d = Math.hypot(removed[i] + 0.5 - position.x, removed[i + 1] + 0.5 - position.y, removed[i + 2] + 0.5 - position.z);
      if (d > maxDist) maxDist = d;
    }
    const distance = position.distanceTo(this.listener);
    const size = radius / GRENADE_RADIUS;
    // Close blasts rattle the camera hard; distant ones barely or not at all.
    const shake = Math.min(1, shakeFalloff(distance, radius) * (0.9 + 0.2 * size));
    this.shake.add(shake);
    if (this.audio) this.audio.playExplosion(distance, size);

    this.flashLight.position.copy(position);
    this.flashLight.distance = 40 + radius * 3;
    this._flashPower = 900 * Math.sqrt(size);
    this._flashTime = 0;
    this.lastExplosion = { x: position.x, y: position.y, z: position.z, radius, source, removed: removed.length / 4, maxDist, carveMs, distance, shake };
    this.explosionCount++;
    if (this.onExplosion) this.onExplosion(position, radius, source);
  }

  _spawnExplosionParticles(center, removed, radius) {
    const c = this._colors;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const size = radius / GRENADE_RADIUS; // 1 for a grenade, 5 for the bazooka
    const big = Math.sqrt(size);

    // Debris: a sample of the destroyed blocks, tinted by block type.
    const maxDebris = Math.round(170 * Math.min(big, 2.4));
    const blockCount = removed.length / 4;
    const step = Math.max(1, Math.floor(blockCount / maxDebris));
    const color = this._tmpColor0;
    for (let i = Math.floor(Math.random() * step) * 4; i < removed.length; i += step * 4) {
      const x = removed[i] + 0.5;
      const y = removed[i + 1] + 0.5;
      const z = removed[i + 2] + 0.5;
      const rgb = this.world.blockColors[removed[i + 3]] || [0.6, 0.6, 0.6];
      const shade = rnd(0.7, 1.15);
      color.setRGB(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade, THREE.SRGBColorSpace);
      let dx = x - center.x;
      let dy = y - center.y;
      let dz = z - center.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const speed = rnd(7, 17) * big;
      dx = (dx / len) * speed;
      dz = (dz / len) * speed;
      dy = (dy / len) * speed * 0.6 + rnd(4, 11) * big;
      this.debris.spawn(x, y, z, dx, dy, dz, rnd(0.14, 0.34) * Math.min(big, 1.8), color, rnd(1.4, 3.0) * Math.min(big, 1.6));
    }

    // Fireball core.
    const fire = Math.round(40 * Math.min(size, 3));
    for (let i = 0; i < fire; i++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(-0.4, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(2, 9) * big);
      this.glow.spawn({
        x: center.x + rnd(-1, 1) * big, y: center.y + rnd(-0.5, 1) * big, z: center.z + rnd(-1, 1) * big,
        vx: v.x, vy: v.y + 1.5 * big, vz: v.z,
        life: rnd(0.35, 0.9) * Math.min(big, 1.8), size0: rnd(1.5, 3) * big, size1: rnd(4, 7.5) * big,
        color0: c.fireHot, color1: Math.random() < 0.5 ? c.fireMid : c.fireEnd,
        alpha: 0.42, drag: 3.5 / big, gravity: -0.12,
      });
    }

    // Sparks flying far out of the blast.
    const sparks = Math.round(70 * Math.min(big, 2));
    for (let i = 0; i < sparks; i++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(0, 1.2), rnd(-1, 1)).normalize().multiplyScalar(rnd(10, 26) * big);
      this.glow.spawn({
        x: center.x, y: center.y + 0.5, z: center.z,
        vx: v.x, vy: v.y, vz: v.z,
        life: rnd(0.4, 1.1) * Math.min(big, 1.6), size0: rnd(0.15, 0.3) * Math.min(big, 1.6), size1: 0.05,
        color0: c.spark, color1: c.fireMid,
        alpha: 1, drag: 1.2, gravity: 0.7,
      });
    }

    // Billowing smoke column.
    const smoke = Math.round(44 * Math.min(size, 3.5));
    for (let i = 0; i < smoke; i++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(0, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(1.5, 6) * big);
      this.smoke.spawn({
        x: center.x + rnd(-2, 2) * big, y: center.y + rnd(-0.5, 2) * big, z: center.z + rnd(-2, 2) * big,
        vx: v.x, vy: v.y + rnd(1.5, 4) * big, vz: v.z,
        life: rnd(2.2, 4.8) * Math.min(big, 1.7), size0: rnd(2, 4) * big, size1: rnd(6, 10) * big,
        color0: c.smokeDark, color1: c.smokeLight,
        alpha: rnd(0.45, 0.7), drag: 1.4 / big, gravity: -0.04,
      });
    }

    // Dust ring racing outward along the ground.
    const dust = Math.round(22 * Math.min(big, 2.2));
    for (let i = 0; i < dust; i++) {
      const a = (i / dust) * Math.PI * 2 + rnd(-0.1, 0.1);
      const speed = rnd(9, 15) * big;
      this.smoke.spawn({
        x: center.x, y: center.y - 0.5, z: center.z,
        vx: Math.cos(a) * speed, vy: rnd(0.2, 1.2), vz: Math.sin(a) * speed,
        life: rnd(1.2, 2.2) * Math.min(big, 1.7), size0: 1.5 * big, size1: rnd(4, 6) * big,
        color0: c.dust, color1: c.smokeLight,
        alpha: 0.4, drag: 2.2 / big,
      });
    }

    // Expanding shockwave ring.
    const ring = this._rings.find((r) => r.userData.age > 0.6) || this._rings[0];
    ring.position.set(center.x, center.y + 0.2, center.z);
    ring.userData.age = 0;
    ring.userData.radius = radius;
    ring.visible = true;
  }

  // A brief muzzle flash of light at `pos` (the pistol and the bazooka).
  muzzleFlash(pos, strength = 1) {
    this.muzzleLight.position.copy(pos);
    this.muzzleLight.userData.strength = strength;
    this._muzzleTime = 0;
  }

  update(dt) {
    this.shake.update(dt);

    // Explosion flash: bright, then a fast exponential falloff.
    this._flashTime += dt;
    this.flashLight.intensity = this._flashTime < 1.5 ? this._flashPower * Math.exp(-this._flashTime * 6) : 0;
    this._muzzleTime += dt;
    this.muzzleLight.intensity = this._muzzleTime < 0.08 ? 40 * (this.muzzleLight.userData.strength || 1) * (1 - this._muzzleTime / 0.08) : 0;

    for (const ring of this._rings) {
      if (!ring.visible) continue;
      ring.userData.age += dt;
      const dur = 0.45 * Math.sqrt(ring.userData.radius / GRENADE_RADIUS);
      const t = ring.userData.age / dur;
      if (t >= 1) {
        ring.visible = false;
        continue;
      }
      const s = 1 + t * ring.userData.radius * 2.6;
      ring.scale.set(s, s, s);
      ring.material.opacity = 0.85 * (1 - t) * (1 - t);
    }

    this.debris.update(dt);
    this.smoke.update(dt);
    this.glow.update(dt);
  }
}
