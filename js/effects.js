// Signature feature: the Blast Orb — a thrown projectile that explodes on
// impact, carving a large crater out of the terrain with debris, fire,
// smoke, sparks, a shockwave, a light flash, screen shake and a big boom.
import * as THREE from "three";
import { BLOCK, isSolid } from "./blocks.js";
import { SEA_LEVEL } from "./constants.js";
import { DebrisPool, BillboardPool } from "./particles.js";

const GRAVITY = -20;
const ORB_SPEED = 32; // was 18: the orb now flies roughly 2-3x as far
const ORB_LOB = 0.12; // extra upward aim so a level throw arcs instead of dropping
const ORB_AIR_DRAG = 0.12; // per second; makes the arc steepen naturally at the end
const ORB_WATER_DRAG = 3.0; // the orb slows sharply and sinks in water
const ORB_INHERIT = 0.5; // fraction of the thrower's velocity the orb inherits
const ORB_LIFETIME = 7;
const ORB_SPAWN_AHEAD = 0.35;
const MAX_SUBSTEP = 0.2; // blocks per collision sub-step, so a fast orb can't tunnel through a 1-block wall

export const BLAST_RADIUS = 7; // was 3
const BLAST_LUMPINESS = 0.75; // max +/- change of the crater radius with direction (blocks)
const MAX_BLAST_RADIUS = 9; // hard cap on the carve radius (cost grows with r^3)
export const ORB_COOLDOWN = 3;

const MAX_DEBRIS_PER_BLAST = 170;
const MAX_FLOOD_CELLS = 4000; // bound on how much water one blast can let in

// A lumpy crater shape: the blast radius varies smoothly with direction (a
// few random low-frequency waves over the sphere of directions). Because the
// radius depends only on direction, the carved region is star-shaped around
// the center: every removed block has a path of removed blocks back to the
// center, so a blast never leaves sealed air bubbles inside the crater wall
// (which a per-block random edge did).
function makeCraterShape() {
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
    return (sum / waves.length) * BLAST_LUMPINESS;
  };
}

function makeGlowTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,220,160,0.7)");
  g.addColorStop(0.6, "rgba(255,140,60,0.18)");
  g.addColorStop(1, "rgba(255,120,40,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
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
    this.projectiles = [];
    this.cooldown = 0;
    this.lastExplosion = null;
    this.explosionCount = 0;
    this.shake = new CameraShake();
    this.listener = new THREE.Vector3(); // where the player's ears are (for sound attenuation)
    // Called with (position, radius) after each explosion, so the game can
    // apply knockback (and later damage) to the player.
    this.onExplosion = null;

    this._orbGeo = new THREE.SphereGeometry(0.2, 12, 10);
    this._orbMaterial = new THREE.MeshBasicMaterial({ color: 0xffc070 });
    this._glowMaterial = new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false, // additive glow shouldn't pick up (and add) the fog color
    });

    this.debris = new DebrisPool(scene, world, 500);
    this.smoke = new BillboardPool(scene, 260, { additive: false });
    this.glow = new BillboardPool(scene, 420, { additive: true });

    // The light count never changes at runtime: adding/removing a light makes
    // three.js recompile every lit material, which would hitch on every
    // throw and explosion. So these two lights always exist and are simply
    // dimmed to zero while unused.
    this.orbLight = new THREE.PointLight(0xff9a40, 0, 14, 1.6);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 60, 1.3);
    scene.add(this.orbLight, this.flashLight);
    this._flashTime = Infinity;

    this._rings = [];
    for (let i = 0; i < 2; i++) {
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
      ring.userData.age = Infinity;
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
      trail: new THREE.Color(1.0, 0.65, 0.25),
    };
  }

  canThrow() {
    return this.cooldown <= 0;
  }

  // Fraction of the cooldown remaining (1 = just thrown, 0 = ready).
  cooldownFraction() {
    return Math.max(0, this.cooldown) / ORB_COOLDOWN;
  }

  throwOrb(origin, direction, throwerVelocity = null) {
    if (!this.canThrow()) return false;
    this.cooldown = ORB_COOLDOWN;

    const dir = direction.clone().normalize();
    dir.y += ORB_LOB;
    dir.normalize();
    const velocity = dir.clone().multiplyScalar(ORB_SPEED);
    if (throwerVelocity) velocity.addScaledVector(throwerVelocity, ORB_INHERIT);

    const mesh = new THREE.Mesh(this._orbGeo, this._orbMaterial);
    mesh.position.copy(origin).addScaledVector(dir, ORB_SPAWN_AHEAD);
    const glow = new THREE.Sprite(this._glowMaterial);
    glow.scale.setScalar(1.6);
    mesh.add(glow);
    this.scene.add(mesh);
    this.projectiles.push({ mesh, velocity, life: ORB_LIFETIME, age: 0 });
    if (this.audio) this.audio.playThrow();
    return true;
  }

  // Removes blocks in a lumpy sphere around `center`; returns the removed
  // blocks as a flat [x, y, z, id, ...] array.
  _carve(center, radius) {
    const world = this.world;
    const r = Math.min(radius, MAX_BLAST_RADIUS - BLAST_LUMPINESS);
    const shape = makeCraterShape();
    const reach = Math.ceil(r + BLAST_LUMPINESS);
    const bx = Math.floor(center.x);
    const by = Math.floor(center.y);
    const bz = Math.floor(center.z);
    const removed = [];
    const edits = [];
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const x = bx + dx;
          const y = by + dy;
          const z = bz + dz;
          // Distance from the blast center to this block's center.
          const ox = x + 0.5 - center.x;
          const oy = y + 0.5 - center.y;
          const oz = z + 0.5 - center.z;
          const d = Math.hypot(ox, oy, oz);
          if (d > r + BLAST_LUMPINESS) continue;
          if (d > 0.5 && d > r + shape(ox / d, oy / d, oz / d)) continue;
          const id = world.getBlock(x, y, z);
          // Water absorbs the blast rather than being blown away.
          if (id === BLOCK.AIR || id === BLOCK.WATER) continue;
          if (!world.getChunk(x >> 4, z >> 4)) continue;
          removed.push(x, y, z, id);
          edits.push(x, y, z, BLOCK.AIR);
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
  _floodCarved(removed) {
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
    const filled = new Set();
    const edits = [];
    while (queue.length > 0 && filled.size < MAX_FLOOD_CELLS) {
      const z = queue.pop();
      const y = queue.pop();
      const x = queue.pop();
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

  _explode(position) {
    const t0 = performance.now();
    const removed = this._carve(position, BLAST_RADIUS);
    this._floodCarved(removed);
    const carveMs = performance.now() - t0;
    this._spawnExplosionParticles(position, removed);

    // Summary of the most recent blast (read by the smoke test and handy
    // when poking at the game from the dev console).
    let maxDist = 0;
    for (let i = 0; i < removed.length; i += 4) {
      const d = Math.hypot(removed[i] + 0.5 - position.x, removed[i + 1] + 0.5 - position.y, removed[i + 2] + 0.5 - position.z);
      if (d > maxDist) maxDist = d;
    }
    this.lastExplosion = { x: position.x, y: position.y, z: position.z, removed: removed.length / 4, maxDist, carveMs };
    this.explosionCount++;

    const distance = position.distanceTo(this.listener);
    if (this.audio) this.audio.playExplosion(distance);
    // Close blasts rattle the camera hard; distant ones barely nudge it.
    this.shake.add(THREE.MathUtils.clamp(1.15 - distance / (BLAST_RADIUS * 5), 0, 1));

    this.flashLight.position.copy(position);
    this._flashTime = 0;
    if (this.onExplosion) this.onExplosion(position, BLAST_RADIUS);
  }

  _spawnExplosionParticles(center, removed) {
    const c = this._colors;
    const rnd = (a, b) => a + Math.random() * (b - a);

    // Debris: a sample of the destroyed blocks, tinted by block type.
    const blockCount = removed.length / 4;
    const step = Math.max(1, Math.floor(blockCount / MAX_DEBRIS_PER_BLAST));
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
      const speed = rnd(7, 17);
      dx = (dx / len) * speed;
      dz = (dz / len) * speed;
      dy = (dy / len) * speed * 0.6 + rnd(4, 11);
      this.debris.spawn(x, y, z, dx, dy, dz, rnd(0.14, 0.34), color, rnd(1.4, 3.0));
    }

    // Fireball core.
    for (let i = 0; i < 40; i++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(-0.4, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(2, 9));
      this.glow.spawn({
        x: center.x + rnd(-1, 1), y: center.y + rnd(-0.5, 1), z: center.z + rnd(-1, 1),
        vx: v.x, vy: v.y + 1.5, vz: v.z,
        life: rnd(0.35, 0.9), size0: rnd(1.5, 3), size1: rnd(4, 7.5),
        color0: c.fireHot, color1: Math.random() < 0.5 ? c.fireMid : c.fireEnd,
        alpha: 0.42, drag: 3.5, gravity: -0.12,
      });
    }

    // Sparks flying far out of the blast.
    for (let i = 0; i < 70; i++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(0, 1.2), rnd(-1, 1)).normalize().multiplyScalar(rnd(10, 26));
      this.glow.spawn({
        x: center.x, y: center.y + 0.5, z: center.z,
        vx: v.x, vy: v.y, vz: v.z,
        life: rnd(0.4, 1.1), size0: rnd(0.15, 0.3), size1: 0.05,
        color0: c.spark, color1: c.fireMid,
        alpha: 1, drag: 1.2, gravity: 0.7,
      });
    }

    // Billowing smoke column.
    for (let i = 0; i < 44; i++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(0, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(1.5, 6));
      this.smoke.spawn({
        x: center.x + rnd(-2, 2), y: center.y + rnd(-0.5, 2), z: center.z + rnd(-2, 2),
        vx: v.x, vy: v.y + rnd(1.5, 4), vz: v.z,
        life: rnd(2.2, 4.8), size0: rnd(2, 4), size1: rnd(6, 10),
        color0: c.smokeDark, color1: c.smokeLight,
        alpha: rnd(0.45, 0.7), drag: 1.4, gravity: -0.04,
      });
    }

    // Dust ring racing outward along the ground.
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + rnd(-0.1, 0.1);
      const speed = rnd(9, 15);
      this.smoke.spawn({
        x: center.x, y: center.y - 0.5, z: center.z,
        vx: Math.cos(a) * speed, vy: rnd(0.2, 1.2), vz: Math.sin(a) * speed,
        life: rnd(1.2, 2.2), size0: 1.5, size1: rnd(4, 6),
        color0: c.dust, color1: c.smokeLight,
        alpha: 0.4, drag: 2.2,
      });
    }

    // Expanding shockwave ring.
    const ring = this._rings.find((r) => r.userData.age > 0.6) || this._rings[0];
    ring.position.set(center.x, center.y + 0.2, center.z);
    ring.userData.age = 0;
    ring.visible = true;
  }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
    this.shake.update(dt);

    const world = this.world;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const pos = p.mesh.position;
      p.age += dt;
      const inWater = world.getBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)) === BLOCK.WATER;
      p.velocity.y += GRAVITY * (inWater ? 0.25 : 1) * dt;
      p.velocity.multiplyScalar(Math.exp(-(inWater ? ORB_WATER_DRAG : ORB_AIR_DRAG) * dt));

      // Sub-stepped movement so the orb can't skip through thin walls.
      let hit = false;
      const travel = p.velocity.length() * dt;
      const steps = Math.max(1, Math.ceil(travel / MAX_SUBSTEP));
      const stepDt = dt / steps;
      for (let s = 0; s < steps; s++) {
        pos.addScaledVector(p.velocity, stepDt);
        if (isSolid(world.getBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)))) {
          hit = true;
          break;
        }
      }
      p.life -= dt;

      // Glowing ember trail.
      for (let k = 0; k < 2; k++) {
        this.glow.spawn({
          x: pos.x + (Math.random() - 0.5) * 0.15,
          y: pos.y + (Math.random() - 0.5) * 0.15,
          z: pos.z + (Math.random() - 0.5) * 0.15,
          vx: (Math.random() - 0.5) * 0.6, vy: Math.random() * 0.6, vz: (Math.random() - 0.5) * 0.6,
          life: 0.35 + Math.random() * 0.3, size0: 0.35, size1: 0.05,
          color0: this._colors.trail, alpha: 0.8,
        });
      }
      const pulse = 1 + Math.sin(p.age * 18) * 0.12;
      p.mesh.scale.setScalar(pulse);

      if (hit || p.life <= 0 || pos.y < -8) {
        if (pos.y >= 0) this._explode(pos.clone());
        this.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }

    // The orb light follows the newest orb in flight.
    const newest = this.projectiles[this.projectiles.length - 1];
    if (newest) {
      this.orbLight.position.copy(newest.mesh.position);
      this.orbLight.intensity = 18;
    } else {
      this.orbLight.intensity = 0;
    }

    // Explosion flash: bright, then a fast exponential falloff.
    this._flashTime += dt;
    this.flashLight.intensity = this._flashTime < 1.2 ? 900 * Math.exp(-this._flashTime * 7) : 0;

    for (const ring of this._rings) {
      if (!ring.visible) continue;
      ring.userData.age += dt;
      const t = ring.userData.age / 0.45;
      if (t >= 1) {
        ring.visible = false;
        continue;
      }
      const s = 1 + t * BLAST_RADIUS * 2.6;
      ring.scale.set(s, s, s);
      ring.material.opacity = 0.85 * (1 - t) * (1 - t);
    }

    this.debris.update(dt);
    this.smoke.update(dt);
    this.glow.update(dt);
  }
}
