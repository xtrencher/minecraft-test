// Mobs: three passive animals and one hostile zombie. Handles spawning
// (animals on sunny grass, zombies in darkness: at night or in caves),
// despawning, simple AI with obstacle-aware steering (walk toward a goal,
// hop up 1-block steps, detour around walls, avoid water and cliffs),
// physics against the voxel world, melee combat both ways, damage from Blast
// Orb explosions and daylight, death animations, drops and sounds.
import * as THREE from "three";
import { BLOCK, IS_SOLID } from "./blocks.js";
import { ITEM, meleeDamage } from "./items.js";
import { sweepAxis, rayAabb } from "./physics.js";
import { createMobModel } from "./mob-models.js";
import { bindEntityLight } from "./shaders.js";

const GRAVITY = -26;
const MAX_PASSIVE = 14;
const MAX_HOSTILE = 10;
const SPAWN_INTERVAL = 0.4;
const DESPAWN_FAR = 128; // blocks: removed at once beyond this
const HOSTILE_LINGER = 48; // blocks: zombies this far away despawn over time
const MOB_INVULNERABLE = 0.4;
const DEATH_TIME = 0.9;

// drops: [itemId, min, max, chance]
export const SPECIES = {
  fluffalo: {
    name: "Fluffalo", hostile: false, health: 10, r: 0.45, h: 1.45, eye: 1.05,
    speed: 1.3, fleeSpeed: 3.6, maxDrop: 2, weight: 4,
    drops: [[ITEM.FLUFF, 1, 2, 1], [ITEM.RAW_MEAT, 1, 2, 1]],
  },
  hoplet: {
    name: "Hoplet", hostile: false, health: 4, r: 0.25, h: 0.7, eye: 0.55,
    speed: 2.3, fleeSpeed: 5, maxDrop: 3, weight: 3, hop: true,
    drops: [[ITEM.RAW_MEAT, 1, 1, 1], [ITEM.FLUFF, 1, 1, 0.3]],
  },
  mossback: {
    name: "Mossback", hostile: false, health: 14, r: 0.45, h: 0.8, eye: 0.35,
    speed: 0.7, fleeSpeed: 0.7, maxDrop: 1, weight: 2, hides: true,
    drops: [[ITEM.RAW_MEAT, 1, 3, 1], [ITEM.APPLE, 1, 1, 0.15]],
  },
  zombie: {
    name: "Zombie", hostile: true, health: 20, r: 0.3, h: 1.95, eye: 1.7,
    speed: 1.1, chaseSpeed: 2.9, maxDrop: 3, damage: 3, sight: 20,
    drops: [[ITEM.COAL, 0, 2, 1], [ITEM.IRON_INGOT, 1, 1, 0.08], [ITEM.APPLE, 1, 1, 0.05]],
  },
};

const PASSIVE_KINDS = Object.keys(SPECIES).filter((k) => !SPECIES[k].hostile);

// Seconds for a full-strength swing with the given tool.
function attackCooldown(tool) {
  if (!tool) return 0.35;
  if (tool.type === "sword") return 0.6;
  if (tool.type === "axe") return 0.9;
  return 0.8;
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class MobManager {
  constructor({ scene, world, player, entities, audio, effects, sky }) {
    this.world = world;
    this.player = player;
    this.entities = entities;
    this.audio = audio;
    this.effects = effects;
    this.sky = sky;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mobs = [];
    this._nextId = 1;
    this._spawnTimer = 0;
    this._seeded = false;
    this.enabled = true;
    this.lastAttackTime = -10; // game time of the player's last swing
    this.time = 0;
    this.kills = 0;
    this.onPlayerHurt = null; // (mob) => void
    this._tmp = new THREE.Vector3();
    this._flashColor = new THREE.Color();
    this._c0 = new THREE.Color();
    this._c1 = new THREE.Color();
  }

  get count() {
    return this.mobs.length;
  }

  countOf(hostile) {
    let n = 0;
    for (const m of this.mobs) if (!m.dead && m.spec.hostile === hostile) n++;
    return n;
  }

  // ---------- Spawning ----------

  spawn(kind, x, y, z) {
    const spec = SPECIES[kind];
    if (!spec) return null;
    const model = createMobModel(kind);
    const m = {
      id: this._nextId++,
      kind,
      spec,
      model,
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(),
      knock: new THREE.Vector3(),
      move: new THREE.Vector2(),
      yaw: Math.random() * Math.PI * 2,
      headYaw: 0,
      headPitch: 0,
      health: spec.health,
      hurtTime: 99,
      invulnerable: 0,
      dead: false,
      deathTime: 0,
      onGround: false,
      inWater: false,
      peakY: null,
      walkPhase: Math.random() * 6,
      walk: 0,
      graze: 0,
      hide: 0,
      attackCooldown: 0,
      attack: 1,
      stagger: 0, // seconds of being knocked off balance (no own movement)
      burnTimer: 0,
      burning: false,
      soundTimer: 3 + Math.random() * 8,
      ai: { state: "idle", timer: Math.random() * 3, dirX: 0, dirZ: 1, detour: 0, detourX: 0, detourZ: 0, side: Math.random() < 0.5 ? 1 : -1, target: false },
      light: { sky: 15, block: 0, flash: new THREE.Color(), glow: spec.hostile ? 1 : 0 },
    };
    bindEntityLight(model.root, () => m.light);
    this.group.add(model.root);
    this.mobs.push(m);
    this._place(m);
    return m;
  }

  _remove(i) {
    const m = this.mobs[i];
    this.group.remove(m.model.root);
    this.mobs.splice(i, 1);
  }

  clear() {
    while (this.mobs.length) this._remove(this.mobs.length - 1);
  }

  _chunkReady(x, z) {
    const c = this.world.getChunk(Math.floor(x) >> 4, Math.floor(z) >> 4);
    return !!c && c.meshed;
  }

  _freeAt(x, y, z, h) {
    for (let k = 0; k < Math.ceil(h); k++) {
      const id = this.world.getBlock(x, y + k, z);
      if (IS_SOLID[id] || id === BLOCK.WATER) return false;
    }
    return true;
  }

  // Effective light for spawning: block light, or sky light dimmed at night.
  _effectiveLight(x, y, z) {
    const l = this.world.lightAt(x + 0.5, y + 0.5, z + 0.5);
    return Math.max(l.block, l.sky * (0.2 + 0.8 * this.sky.daylight));
  }

  _trySpawnPassive(minDist, maxDist, room = MAX_PASSIVE - this.countOf(false)) {
    if (room <= 0) return 0;
    const p = this.player.position;
    const a = Math.random() * Math.PI * 2;
    const d = minDist + Math.random() * (maxDist - minDist);
    const x = Math.floor(p.x + Math.cos(a) * d);
    const z = Math.floor(p.z + Math.sin(a) * d);
    if (!this._chunkReady(x, z)) return 0;
    const top = this.world.surfaceY(x, z);
    if (top < 0 || this.world.getBlock(x, top, z) !== BLOCK.GRASS) return 0;
    if (this.world.lightAt(x + 0.5, top + 1.5, z + 0.5).sky < 10) return 0;
    const kind = this._pickPassive();
    const herd = kind === "mossback" ? 1 + (Math.random() < 0.3 ? 1 : 0) : 2 + Math.floor(Math.random() * 2);
    const n = Math.min(herd, room);
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const sx = x + (i === 0 ? 0 : Math.floor(Math.random() * 5) - 2);
      const sz = z + (i === 0 ? 0 : Math.floor(Math.random() * 5) - 2);
      const st = this.world.surfaceY(sx, sz);
      if (st < 0 || this.world.getBlock(sx, st, sz) !== BLOCK.GRASS || !this._chunkReady(sx, sz)) continue;
      if (!this._freeAt(sx, st + 1, sz, SPECIES[kind].h)) continue;
      this.spawn(kind, sx + 0.5, st + 1, sz + 0.5);
      spawned++;
    }
    return spawned;
  }

  _pickPassive() {
    const total = PASSIVE_KINDS.reduce((s, k) => s + SPECIES[k].weight, 0);
    let r = Math.random() * total;
    for (const k of PASSIVE_KINDS) {
      r -= SPECIES[k].weight;
      if (r <= 0) return k;
    }
    return PASSIVE_KINDS[0];
  }

  // Zombies appear in darkness: on the surface at night, or in unlit caves.
  _trySpawnHostile() {
    const p = this.player.position;
    const a = Math.random() * Math.PI * 2;
    const d = 18 + Math.random() * 26;
    const x = Math.floor(p.x + Math.cos(a) * d);
    const z = Math.floor(p.z + Math.sin(a) * d);
    if (!this._chunkReady(x, z)) return false;
    const top = this.world.surfaceY(x, z);
    if (top < 0) return false;
    // Start from the surface or from a random depth, then look for a floor.
    let y = Math.random() < 0.5 ? top + 1 : 2 + Math.floor(Math.random() * Math.max(1, top - 3));
    for (let k = 0; k < 12 && y > 1; k++, y--) {
      const below = this.world.getBlock(x, y - 1, z);
      if (!IS_SOLID[below] || below === BLOCK.LEAVES) continue;
      if (!this._freeAt(x, y, z, SPECIES.zombie.h)) continue;
      if (this._effectiveLight(x, y, z) > 4) return false;
      this.spawn("zombie", x + 0.5, y, z + 0.5);
      return true;
    }
    return false;
  }

  _updateSpawning(dt) {
    if (!this.enabled) return;
    if (!this._seeded && this._chunkReady(this.player.position.x, this.player.position.z)) {
      // Start the world with some animals around.
      this._seeded = true;
      for (let i = 0; i < 40 && this.countOf(false) < MAX_PASSIVE - 2; i++) this._trySpawnPassive(10, 40, MAX_PASSIVE - 2 - this.countOf(false));
    }
    this._spawnTimer -= dt;
    if (this._spawnTimer > 0) return;
    this._spawnTimer = SPAWN_INTERVAL;
    if (this.countOf(false) < MAX_PASSIVE && Math.random() < 0.3) this._trySpawnPassive(24, 56);
    if (this.countOf(true) < MAX_HOSTILE) this._trySpawnHostile();
  }

  // ---------- Steering ----------

  // What lies one step ahead in direction (dx, dz): "open", "step" (a
  // 1-block rise to jump), "wall", "water" or "cliff".
  _probe(m, dx, dz) {
    const w = this.world;
    const reach = m.spec.r + 0.45;
    const bx = Math.floor(m.pos.x + dx * reach);
    const bz = Math.floor(m.pos.z + dz * reach);
    const by = Math.floor(m.pos.y + 0.05);
    const cells = Math.ceil(m.spec.h);
    const solid = (y) => IS_SOLID[w.getBlock(bx, y, bz)] === 1;
    if (solid(by)) {
      for (let k = 1; k <= cells; k++) if (solid(by + k)) return "wall";
      if (IS_SOLID[w.getBlock(Math.floor(m.pos.x), by + cells, Math.floor(m.pos.z))]) return "wall"; // no room to jump
      return "step";
    }
    for (let k = 1; k < cells; k++) if (solid(by + k)) return "wall";
    if (w.getBlock(bx, by, bz) === BLOCK.WATER) return "water";
    let drop = 0;
    while (drop < 6 && !solid(by - 1 - drop)) {
      if (w.getBlock(bx, by - 1 - drop, bz) === BLOCK.WATER) return "water";
      drop++;
    }
    return drop > m.spec.maxDrop ? "cliff" : "open";
  }

  // Adjusts a desired direction around obstacles. Returns { x, z, jump } or
  // null if every direction nearby is blocked.
  _steer(m, dx, dz) {
    const ok = (x, z) => {
      const p = this._probe(m, x, z);
      if (p === "open" || (p === "water" && m.inWater)) return { x, z, jump: false };
      if (p === "step") return { x, z, jump: true };
      return null;
    };
    if (m.ai.detour > 0) {
      const r = ok(m.ai.detourX, m.ai.detourZ);
      if (r) return r;
    }
    let r = ok(dx, dz);
    if (r) return r;
    for (const a of [0.7, 1.4, 2.1]) {
      for (const s of [m.ai.side, -m.ai.side]) {
        const c = Math.cos(a * s);
        const sn = Math.sin(a * s);
        const x = dx * c - dz * sn;
        const z = dx * sn + dz * c;
        r = ok(x, z);
        if (r) {
          m.ai.detour = 0.8;
          m.ai.detourX = x;
          m.ai.detourZ = z;
          return r;
        }
      }
    }
    m.ai.side = -m.ai.side;
    return null;
  }

  // ---------- AI ----------

  _canTarget() {
    const p = this.player;
    return !p.dead && !p.creative;
  }

  _think(m, dt) {
    const ai = m.ai;
    const p = this.player.position;
    const dx = p.x - m.pos.x;
    const dz = p.z - m.pos.z;
    const distH = Math.hypot(dx, dz);
    ai.timer -= dt;
    ai.detour = Math.max(0, ai.detour - dt);
    let goalX = 0;
    let goalZ = 0;
    let speed = 0;
    let lookAtPlayer = distH < 6;

    if (m.spec.hostile) {
      const dy = p.y - m.pos.y;
      if (this._canTarget() && distH < (ai.target ? m.spec.sight * 1.4 : m.spec.sight) && Math.abs(dy) < 10) ai.target = true;
      else ai.target = false;
      if (ai.target) {
        lookAtPlayer = true;
        if (distH > 0.6) {
          goalX = dx / distH;
          goalZ = dz / distH;
          speed = m.spec.chaseSpeed;
        }
        // Swing at the player when in reach (not while reeling from a hit).
        if (m.stagger <= 0 && distH < m.spec.r + 1.05 && Math.abs(dy) < 1.6 && m.attackCooldown <= 0) this._attackPlayer(m, dx / (distH || 1), dz / (distH || 1));
      }
    }

    if (!ai.target) {
      if (ai.state === "flee" && ai.timer > 0) {
        // Run away from the player, with a little zig-zag.
        const away = Math.atan2(-dx, -dz) + Math.sin(this.time * 3 + m.id) * 0.5;
        goalX = Math.sin(away);
        goalZ = Math.cos(away);
        speed = m.spec.fleeSpeed;
        lookAtPlayer = false;
      } else if (ai.state === "hide" && ai.timer > 0) {
        speed = 0;
        lookAtPlayer = false;
      } else if (ai.state === "wander" && ai.timer > 0) {
        goalX = ai.dirX;
        goalZ = ai.dirZ;
        speed = m.spec.speed;
        lookAtPlayer = false;
      } else if (ai.state === "idle" && ai.timer > 0) {
        speed = 0;
      } else {
        // Pick the next thing to do.
        if (Math.random() < 0.55) {
          const a = Math.random() * Math.PI * 2;
          ai.state = "wander";
          ai.dirX = Math.sin(a);
          ai.dirZ = Math.cos(a);
          ai.timer = 2 + Math.random() * 4;
        } else {
          ai.state = "idle";
          ai.timer = 2 + Math.random() * 5;
          m.grazeUntil = !m.spec.hostile && Math.random() < 0.5 ? this.time + 1.5 + Math.random() * 2 : 0;
        }
      }
    }

    let jump = false;
    if (speed > 0) {
      const s = this._steer(m, goalX, goalZ);
      if (s) {
        goalX = s.x;
        goalZ = s.z;
        jump = s.jump;
      } else {
        speed = 0;
        if (ai.state === "wander") ai.timer = 0; // try something else
      }
    }
    // In water: keep paddling, and climb out onto the bank.
    if (m.inWater && speed > 0) jump = jump || m.blocked;
    // Hoplets travel by hopping.
    if (m.spec.hop && speed > 0 && m.onGround) jump = true;

    // Head and body orientation.
    const moveYaw = speed > 0 ? Math.atan2(goalX, goalZ) : m.yaw;
    m.yaw += THREE.MathUtils.clamp(angleDiff(moveYaw, m.yaw), -6 * dt, 6 * dt);
    let headYaw = 0;
    let headPitch = 0;
    if (lookAtPlayer && !this.player.dead) {
      headYaw = THREE.MathUtils.clamp(angleDiff(Math.atan2(dx, dz), m.yaw), -1.1, 1.1);
      const eyeDy = this.player.getEyePosition().y - (m.pos.y + m.spec.eye);
      headPitch = THREE.MathUtils.clamp(Math.atan2(eyeDy, Math.max(0.5, distH)), -0.6, 0.6);
    }
    m.headYaw += (headYaw - m.headYaw) * Math.min(1, dt * 6);
    m.headPitch += (headPitch - m.headPitch) * Math.min(1, dt * 6);
    return { x: goalX, z: goalZ, speed, jump };
  }

  _attackPlayer(m, nx, nz) {
    m.attackCooldown = 1.0;
    m.attack = 0;
    const applied = this.player.damage(m.spec.damage, m.kind);
    if (applied) {
      this.player.applyImpulse(this._tmp.set(nx * 6, 4, nz * 6));
      if (this.onPlayerHurt) this.onPlayerHurt(m);
    }
    this.audio.playMob(m.kind, "attack", this._distTo(m));
  }

  _distTo(m) {
    return m.pos.distanceTo(this.player.position);
  }

  // ---------- Physics ----------

  _physics(m, dt, want) {
    const w = this.world;
    const spec = m.spec;
    const waterFeet = w.getBlock(Math.floor(m.pos.x), Math.floor(m.pos.y + 0.2), Math.floor(m.pos.z)) === BLOCK.WATER;
    const waterBody = w.getBlock(Math.floor(m.pos.x), Math.floor(m.pos.y + spec.h * 0.55), Math.floor(m.pos.z)) === BLOCK.WATER;
    m.inWater = waterFeet || waterBody;

    // A mob reeling from a hit doesn't steer, so the knockback carries it.
    const speed = m.stagger > 0 ? 0 : want.speed * (m.inWater ? 0.6 : 1) * (m.burning && spec.hostile ? 1.15 : 1);
    const accel = m.onGround || m.inWater ? 10 : 2;
    const k = Math.min(1, accel * dt);
    m.move.x += (want.x * speed - m.move.x) * k;
    m.move.y += (want.z * speed - m.move.y) * k;
    const kd = Math.exp(-(m.onGround ? 8 : 1) * dt);
    m.knock.x *= kd;
    m.knock.z *= kd;
    m.vel.x = m.move.x + m.knock.x;
    m.vel.z = m.move.y + m.knock.z;

    if (m.inWater) {
      m.vel.y += (waterBody ? 16 : -12) * dt;
      m.vel.y = THREE.MathUtils.clamp(m.vel.y, -3, 2.4);
    } else {
      m.vel.y = Math.max(m.vel.y + GRAVITY * dt, -40);
    }
    if (want.jump && (m.onGround || (m.inWater && !waterBody))) m.vel.y = spec.hop ? 6.4 : 8.2;
    else if (want.jump && m.inWater) m.vel.y = Math.max(m.vel.y, 5);

    const wasOnGround = m.onGround;
    m.onGround = false;
    const ax = m.vel.x * dt;
    const dx = sweepAxis(w, m.pos, spec.r, spec.h, "x", ax);
    m.pos.x += dx;
    const dy0 = m.vel.y * dt;
    const dy = sweepAxis(w, m.pos, spec.r, spec.h, "y", dy0);
    if (dy0 < 0 && dy > dy0) m.onGround = true;
    m.pos.y += dy;
    if (Math.abs(dy - dy0) > 1e-6) m.vel.y = 0;
    const az = m.vel.z * dt;
    const dz = sweepAxis(w, m.pos, spec.r, spec.h, "z", az);
    m.pos.z += dz;
    m.blocked = Math.abs(dx - ax) > 1e-6 || Math.abs(dz - az) > 1e-6;
    if (Math.abs(dx - ax) > 1e-6) m.knock.x = 0;
    if (Math.abs(dz - az) > 1e-6) m.knock.z = 0;

    // Fall damage (not for hoppers, who land softly).
    if (m.onGround || m.inWater) {
      if (m.peakY !== null && !m.inWater && !spec.hop && !wasOnGround) {
        const dmg = Math.floor(m.peakY - m.pos.y - 3);
        if (dmg > 0) this._hurt(m, dmg, null, 0);
      }
      m.peakY = null;
    } else {
      m.peakY = m.peakY === null ? m.pos.y : Math.max(m.peakY, m.pos.y);
    }

    const horiz = Math.hypot(dx, dz) / Math.max(dt, 1e-4);
    m.walk += ((horiz > 0.3 ? Math.min(1, horiz / 2) : 0) - m.walk) * Math.min(1, dt * 8);
    m.walkPhase += horiz * dt * (spec.hop ? 3 : 4.2);
  }

  // Mobs push each other (and away from the player) instead of overlapping.
  _separate(dt) {
    const list = this.mobs;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.dead) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.dead) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const min = a.spec.r + b.spec.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || Math.abs(a.pos.y - b.pos.y) > 1.5) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = ((min - d) / min) * 6 * dt;
        a.knock.x -= (dx / d) * push;
        a.knock.z -= (dz / d) * push;
        b.knock.x += (dx / d) * push;
        b.knock.z += (dz / d) * push;
      }
      const p = this.player.position;
      const dx = a.pos.x - p.x;
      const dz = a.pos.z - p.z;
      const min = a.spec.r + 0.3;
      const d2 = dx * dx + dz * dz;
      if (!this.player.dead && d2 < min * min && a.pos.y < p.y + 1.8 && a.pos.y + a.spec.h > p.y) {
        const d = Math.sqrt(d2) || 0.01;
        a.knock.x += (dx / d) * 10 * dt;
        a.knock.z += (dz / d) * 10 * dt;
      }
    }
  }

  // ---------- Damage ----------

  // Damages a mob; (nx, nz) is the knockback direction and `kb` its strength.
  _hurt(m, amount, dir, kb) {
    if (m.dead || m.invulnerable > 0 || amount <= 0) return false;
    if (m.spec.hides && m.hide > 0.5) amount *= 0.5; // the shell takes most of it
    m.health -= amount;
    m.hurtTime = 0;
    m.invulnerable = MOB_INVULNERABLE;
    if (dir && kb > 0) {
      m.stagger = 0.45;
      m.move.set(0, 0);
      m.knock.x += dir.x * kb;
      m.knock.z += dir.z * kb;
      m.vel.y = Math.max(m.vel.y, Math.min(4.2, kb * 0.8));
    }
    const dist = this._distTo(m);
    if (m.health <= 0) {
      m.dead = true;
      m.deathTime = 0;
      this.kills++;
      this.audio.playMob(m.kind, "death", dist);
      return true;
    }
    this.audio.playMob(m.kind, "hurt", dist);
    if (!m.spec.hostile) {
      if (m.spec.hides) {
        m.ai.state = "hide";
        m.ai.timer = 4 + Math.random() * 2;
      } else {
        m.ai.state = "flee";
        m.ai.timer = 3 + Math.random() * 2;
      }
    }
    return true;
  }

  _die(i) {
    const m = this.mobs[i];
    const c = m.pos;
    // A puff of smoke, then the drops.
    const grey = this._c0.setRGB(0.85, 0.85, 0.85);
    const grey2 = this._c1.setRGB(0.5, 0.5, 0.5);
    for (let k = 0; k < 10; k++) {
      this.effects.smoke.spawn({
        x: c.x + (Math.random() - 0.5) * m.spec.r * 2,
        y: c.y + Math.random() * m.spec.h * 0.7,
        z: c.z + (Math.random() - 0.5) * m.spec.r * 2,
        vx: (Math.random() - 0.5) * 1.2,
        vy: 0.6 + Math.random() * 0.9,
        vz: (Math.random() - 0.5) * 1.2,
        life: 0.7 + Math.random() * 0.5,
        size0: 0.25,
        size1: 0.6,
        color0: grey,
        color1: grey2,
        alpha: 0.8,
        drag: 2,
      });
    }
    for (const [id, min, max, chance] of m.spec.drops) {
      if (Math.random() > chance) continue;
      const n = min + Math.floor(Math.random() * (max - min + 1));
      if (n > 0) this.entities.spawn(id, n, new THREE.Vector3(c.x, c.y + 0.4, c.z));
    }
    this._remove(i);
  }

  // Explosions hurt and fling mobs like they do the player, scaled by size.
  explosion(center, radius) {
    const reach = radius * 1.8;
    const size = Math.sqrt(radius / 7);
    for (const m of this.mobs) {
      if (m.dead) continue;
      const d = this._tmp.set(m.pos.x - center.x, m.pos.y + m.spec.h / 2 - center.y, m.pos.z - center.z);
      const dist = d.length();
      if (dist >= reach) continue;
      const f = 1 - dist / reach;
      const dmg = Math.floor(30 * size * Math.pow(f, 1.3));
      const dir = { x: d.x / (dist || 1), z: d.z / (dist || 1) };
      m.invulnerable = 0;
      this._hurt(m, dmg, dir, Math.min(30, f * 16 * size));
      m.vel.y = Math.max(m.vel.y, Math.min(20, f * 12 * size));
    }
  }

  // A bullet (or other projectile) hits `mob` travelling along `dir`.
  shoot(mob, damage, dir, knockback = 4) {
    const len = Math.hypot(dir.x, dir.z) || 1;
    mob.invulnerable = 0; // every shot counts
    return this._hurt(mob, damage, { x: dir.x / len, z: dir.z / len }, knockback);
  }

  // The first living mob whose body is within `r` of point `p`, or null.
  sphereHit(p, r) {
    for (const m of this.mobs) {
      if (m.dead) continue;
      const hr = m.spec.r + r;
      if (Math.abs(p.x - m.pos.x) < hr && Math.abs(p.z - m.pos.z) < hr && p.y > m.pos.y - r && p.y < m.pos.y + m.spec.h + r) return m;
    }
    return null;
  }

  // ---------- Player combat ----------

  // 0-1: how recharged the player's next swing is.
  charge(tool) {
    return Math.min(1, (this.time - this.lastAttackTime) / attackCooldown(tool));
  }

  // A swing that hit nothing still resets the charge.
  swing() {
    this.lastAttackTime = this.time;
  }

  // The nearest living mob under the crosshair within `reach`, or null.
  raycast(origin, dir, reach) {
    let best = null;
    const min = new THREE.Vector3();
    const max = new THREE.Vector3();
    for (const m of this.mobs) {
      if (m.dead) continue;
      const r = m.spec.r + 0.08;
      min.set(m.pos.x - r, m.pos.y, m.pos.z - r);
      max.set(m.pos.x + r, m.pos.y + m.spec.h + 0.05, m.pos.z + r);
      const t = rayAabb(origin, dir, min, max, reach);
      if (t !== null && (!best || t < best.distance)) best = { mob: m, distance: t };
    }
    return best;
  }

  // The player hits `mob` with `tool` (item tool info or null). Returns true
  // if the hit landed.
  attack(mob, tool) {
    const player = this.player;
    const charge = this.charge(tool);
    this.lastAttackTime = this.time;
    if (mob.dead) return false;
    let dmg = meleeDamage(tool) * (0.2 + 0.8 * charge * charge);
    // Critical hit: striking while falling.
    const crit = charge > 0.9 && !player.onGround && !player.inWater && player.velocity.y < -1;
    if (crit) dmg *= 1.5;
    const dx = mob.pos.x - player.position.x;
    const dz = mob.pos.z - player.position.z;
    const d = Math.hypot(dx, dz) || 1;
    const kb = (5 + (player.sprinting ? 3 : 0)) * (0.4 + 0.6 * charge);
    const hit = this._hurt(mob, dmg, { x: dx / d, z: dz / d }, kb);
    if (hit) {
      this.audio.playHit(crit);
      if (crit) this._critSparks(mob);
    }
    return hit;
  }

  _critSparks(m) {
    const c = this._c0.setRGB(3, 2.4, 0.9);
    for (let i = 0; i < 12; i++) {
      this.effects.glow.spawn({
        x: m.pos.x, y: m.pos.y + m.spec.h * 0.7, z: m.pos.z,
        vx: (Math.random() - 0.5) * 5, vy: Math.random() * 4, vz: (Math.random() - 0.5) * 5,
        life: 0.4 + Math.random() * 0.3, size0: 0.12, size1: 0.02, color0: c, gravity: 0.3, drag: 3,
      });
    }
  }

  // Whether any mob's body overlaps block (x, y, z) (to block placement).
  overlapsBlock(x, y, z) {
    for (const m of this.mobs) {
      if (m.dead) continue;
      const r = m.spec.r;
      if (x + 1 > m.pos.x - r && x < m.pos.x + r && z + 1 > m.pos.z - r && z < m.pos.z + r && y + 1 > m.pos.y && y < m.pos.y + m.spec.h) return true;
    }
    return false;
  }

  // ---------- Per frame ----------

  update(dt) {
    this.time += dt;
    this._updateSpawning(dt);
    const p = this.player.position;
    const daylight = this.sky.daylight;

    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      m.hurtTime += dt;
      m.invulnerable = Math.max(0, m.invulnerable - dt);
      m.attackCooldown -= dt;
      m.attack = Math.min(1, m.attack + dt / 0.35);
      m.stagger = Math.max(0, m.stagger - dt);

      if (m.dead) {
        m.deathTime += dt;
        if (m.deathTime >= DEATH_TIME) {
          this._die(i);
          continue;
        }
      } else {
        // Despawning: far away, in unloaded terrain, or (zombies) lingering far off.
        const dist = Math.hypot(m.pos.x - p.x, m.pos.z - p.z);
        if (dist > DESPAWN_FAR || !this.world.getChunk(Math.floor(m.pos.x) >> 4, Math.floor(m.pos.z) >> 4) || m.pos.y < -10) {
          this._remove(i);
          continue;
        }
        if (m.spec.hostile && dist > HOSTILE_LINGER && Math.random() < dt / 20) {
          this._remove(i);
          continue;
        }
        const want = this._think(m, dt);
        this._physics(m, dt, want);
        this._sounds(m, dt);
        this._daylight(m, dt, daylight);
      }
      const l = this.world.lightAt(m.pos.x, m.pos.y + m.spec.h * 0.6, m.pos.z);
      m.light.sky = l.sky;
      m.light.block = l.block;
      this._place(m);
    }
    this._separate(dt);
  }

  _sounds(m, dt) {
    m.soundTimer -= dt;
    if (m.soundTimer > 0) return;
    m.soundTimer = (m.spec.hostile ? 4 : 7) + Math.random() * 9;
    const d = this._distTo(m);
    if (d < 24) this.audio.playMob(m.kind, "idle", d);
  }

  // Zombies burn in direct daylight.
  _daylight(m, dt, daylight) {
    m.burning = m.spec.hostile && daylight > 0.6 && m.light.sky >= 13 && !m.inWater;
    if (!m.burning) return;
    m.burnTimer += dt;
    if (m.burnTimer >= 1) {
      m.burnTimer = 0;
      m.invulnerable = 0;
      this._hurt(m, 2, null, 0);
    }
    if (Math.random() < dt * 14) {
      const c = this._c0.setRGB(3.2, 1.2, 0.25);
      const c2 = this._c1.setRGB(0.6, 0.12, 0.02);
      this.effects.glow.spawn({
        x: m.pos.x + (Math.random() - 0.5) * 0.5, y: m.pos.y + Math.random() * m.spec.h, z: m.pos.z + (Math.random() - 0.5) * 0.5,
        vy: 1 + Math.random(), life: 0.5, size0: 0.35, size1: 0.1, color0: c, color1: c2,
      });
    }
  }

  // Positions and animates the model.
  _place(m) {
    const model = m.model;
    model.root.position.copy(m.pos);
    model.root.rotation.y = m.yaw;
    // Hit flash (red), burning (orange), and a red, tipping-over death.
    const hurt = Math.max(0, 1 - m.hurtTime / 0.3);
    const f = m.light.flash;
    if (m.dead) f.setRGB(0.55, 0, 0);
    else if (hurt > 0) f.setRGB(0.6 * hurt, 0, 0);
    else if (m.burning) f.setRGB(0.25, 0.08, 0);
    else f.setRGB(0, 0, 0);
    if (m.dead) {
      const t = Math.min(1, m.deathTime / 0.35);
      model.tilt.rotation.z = t * t * Math.PI * 0.5;
      model.tilt.position.y = t * m.spec.r * 0.5;
    }
    if (!m.spec.hostile) {
      const grazing = m.grazeUntil && this.time < m.grazeUntil && m.walk < 0.1;
      m.graze += ((grazing ? 1 : 0) - m.graze) * 0.1;
    }
    if (m.spec.hides) m.hide += ((m.ai.state === "hide" && m.ai.timer > 0 ? 1 : 0) - m.hide) * 0.15;
    model.animate({
      walkPhase: m.walkPhase,
      walk: m.walk,
      headYaw: m.headYaw,
      headPitch: m.headPitch,
      time: this.time + m.id * 1.7,
      vy: m.onGround ? 0 : m.vel.y,
      graze: m.graze,
      hide: m.hide,
      attack: m.attack,
    });
  }
}
