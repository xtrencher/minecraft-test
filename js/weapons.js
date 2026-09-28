// Weapons: grenades (charge-thrown, bouncing, 5 s fuse, instant on a direct
// hit on a mob), the pistol (hitscan: sparks and bullet holes on blocks,
// damage and knockback on mobs) and the bazooka (a fast rocket with a smoke
// trail that explodes on terrain or mobs with a huge blast). No ammo and no
// reloading: every click fires, with only a tiny minimum interval.
import * as THREE from "three";
import { BLOCK, IS_SOLID } from "./blocks.js";
import { itemInfo } from "./items.js";
import { grenadeGeometry, rocketGeometry } from "./models.js";
import { createEntityMaterial, bindEntityLight } from "./shaders.js";
import { GRENADE_RADIUS, BAZOOKA_RADIUS, AIRSTRIKE_METEOR_RADIUS } from "./effects.js";
import { LAYER_FX } from "./layers.js";

export const THROW_CHARGE_TIME = 1.5; // seconds to a full-strength throw
const THROW_SPEED_MIN = 6;
const THROW_SPEED_MAX = 27;
export const GRENADE_FUSE = 5;
const GRENADE_R = 0.13;
const GRENADE_GRAVITY = -20;
const RESTITUTION = 0.38;
export const PISTOL_DAMAGE = 5;
const PISTOL_RANGE = 160;
export const ROCKET_SPEED = 75;
const ROCKET_GRAVITY = -2.5;
const ROCKET_LIFE = 12;
const MIN_INTERVAL = { grenade: 0.12, pistol: 0.07, bazooka: 0.2 };

// Machine gun: automatic while held, tracers, spread and recoil that climb
// the longer the trigger is held, and settle again once it's released.
export const MACHINEGUN_DAMAGE = 3;
const MACHINEGUN_RANGE = 140;
const MACHINEGUN_RATE = 12; // shots per second

// Sniper rifle: a toggled scope (zoomed FOV + overlay), a single very
// long-range, high-damage hitscan shot per left click.
export const SNIPER_DAMAGE = 22;
const SNIPER_RANGE = 400;
const SNIPER_ZOOM_FOV = 15;

// Airstrike designator: aim a laser at a spot and fire; after a delay a rain
// of meteors falls on the target and on random spots around it.
export const AIRSTRIKE_DELAY = 5;
const AIRSTRIKE_COOLDOWN = 8;
const AIRSTRIKE_METEOR_COUNT = 7;
const AIRSTRIKE_SPREAD_MIN = 15;
const AIRSTRIKE_SPREAD_MAX = 25;
const AIRSTRIKE_AIM_RANGE = 500;

function glowTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,230,1)");
  g.addColorStop(0.25, "rgba(255,200,120,0.8)");
  g.addColorStop(0.6, "rgba(255,120,40,0.2)");
  g.addColorStop(1, "rgba(255,100,30,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class WeaponSystem {
  constructor({ scene, world, player, effects, audio, mobs, held, decals, inventory }) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.effects = effects;
    this.audio = audio;
    this.mobs = mobs;
    this.held = held;
    this.decals = decals;
    this.inventory = inventory;
    this.grenades = [];
    this.rockets = [];
    this.meteors = [];
    this.airstrikes = []; // pending { pos, timer }
    this.charging = false;
    this.chargeTime = 0;
    this._cooldown = 0;
    this._mgFiring = false;
    this._mgTimer = 0;
    this._mgHeat = 0; // 0-1: climbs while firing, drives spread and recoil
    this.scoped = false;
    this.shots = 0; // pistol/machine-gun/sniper shots fired (stats / tests)
    this.material = createEntityMaterial("color");
    this._grenadeGeo = grenadeGeometry();
    this._rocketGeo = rocketGeometry();
    this._meteorGeo = new THREE.SphereGeometry(0.35, 8, 6);
    this._exhaustMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
      color: new THREE.Color(3, 1.8, 0.8),
    });
    this._c = {
      spark: new THREE.Color(1.6, 1.1, 0.5),
      blink: new THREE.Color(3, 0.25, 0.1),
      smoke: new THREE.Color(0.5, 0.48, 0.45),
      smokeEnd: new THREE.Color(0.7, 0.68, 0.66),
      exhaust: new THREE.Color(2.2, 1.2, 0.4),
      blood: new THREE.Color(0.45, 0.04, 0.04),
      tmp: new THREE.Color(),
    };
    this._v = new THREE.Vector3();

    // A small pool of fading tracer lines, reused round-robin (machine gun, sniper).
    this._tracers = [];
    for (let i = 0; i < 14; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const mat = new THREE.LineBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      line.layers.set(LAYER_FX);
      scene.add(line);
      this._tracers.push({ line, age: 999 });
    }
    this._tracerNext = 0;

    // The airstrike designator's laser sight, shown while it's the selected item.
    const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this._laser = new THREE.Line(laserGeo, new THREE.LineBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this._laser.frustumCulled = false;
    this._laser.visible = false;
    this._laser.layers.set(LAYER_FX);
    scene.add(this._laser);
    this._laserDot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3030, fog: false }));
    this._laserDot.visible = false;
    this._laserDot.layers.set(LAYER_FX);
    scene.add(this._laserDot);
  }

  // 0-1 while a throw is being drawn back.
  get charge() {
    return this.charging ? Math.min(1, this.chargeTime / THROW_CHARGE_TIME) : 0;
  }

  // ---------- Input ----------

  // Right button pressed with a weapon selected.
  press(kind) {
    if (kind === "grenade") {
      if (this._cooldown > 0) return;
      this.charging = true;
      this.chargeTime = 0;
      return;
    }
    if (kind === "machinegun") {
      this._mgFiring = true;
      return;
    }
    if (kind === "sniper") {
      this.scoped = !this.scoped;
      this._applyScope();
      return;
    }
    if (kind === "airstrike") {
      if (this._cooldown > 0) return;
      this._cooldown = AIRSTRIKE_COOLDOWN;
      this.fireAirstrike();
      return;
    }
    if (this._cooldown > 0) return;
    this._cooldown = MIN_INTERVAL[kind] || 0.1;
    if (kind === "pistol") this.firePistol();
    else if (kind === "bazooka") this.fireBazooka();
  }

  // Right button released: a drawn grenade is thrown; the machine gun stops
  // its automatic fire.
  release() {
    this._mgFiring = false;
    if (!this.charging) return;
    const power = this.charge;
    this.charging = false;
    this.chargeTime = 0;
    this._cooldown = MIN_INTERVAL.grenade;
    this.throwGrenade(power);
  }

  // Un-scopes the sniper (or clears its FOV/sensitivity override, if it was
  // already off, harmlessly).
  _applyScope() {
    this.player.zoomFov = this.scoped ? SNIPER_ZOOM_FOV : null;
    this.player.zoomSensMul = this.scoped ? 0.28 : 1;
  }

  // Switching items, opening a screen or dying drops a drawn throw, stops
  // the machine gun and un-scopes the sniper.
  cancel() {
    this.charging = false;
    this.chargeTime = 0;
    this._mgFiring = false;
    if (this.scoped) {
      this.scoped = false;
      this._applyScope();
    }
  }

  // The sniper fires on left click (right click toggles its scope instead).
  fireSniper() {
    const p = this.player;
    const eye = p.getEyePosition();
    const dir = p.getForwardVector();
    this.shots++;
    const blockHit = this.world.raycast(eye, dir, SNIPER_RANGE, { solidOnly: true });
    const mobHit = this.mobs.raycast(eye, dir, blockHit ? blockHit.distance : SNIPER_RANGE);
    const muzzle = this._handPoint(0.9, 0.26, 0.14);
    this.effects.muzzleFlash(muzzle, 1.8);
    this.held.fire(1.6);
    p.kick(0.07);
    this.audio.playSniperShot ? this.audio.playSniperShot() : this.audio.playGunshot();
    const isMob = !!mobHit && (!blockHit || mobHit.distance < blockHit.distance);
    const dist = isMob ? mobHit.distance : blockHit ? blockHit.distance : SNIPER_RANGE;
    const endPoint = eye.clone().addScaledVector(dir, dist);
    this._spawnTracer(muzzle, endPoint);
    if (isMob) {
      this.mobs.shoot(mobHit.mob, SNIPER_DAMAGE, dir, 6);
      this._burst(endPoint, dir.clone().negate(), this._c.blood, 12, 4.5);
      return { type: "mob", mob: mobHit.mob, point: endPoint };
    }
    if (blockHit) {
      if (this._isRealBlock(endPoint)) {
        const n = blockHit.normal;
        const normal = new THREE.Vector3(n[0], n[1], n[2]);
        this.decals.add(endPoint, blockHit.block, n);
        this._burst(endPoint, normal, this._c.spark, 6, 2.2);
      }
      this.audio.playRicochet(Math.min(blockHit.distance, 300));
      return { type: "block", block: blockHit.block, point: endPoint, distance: blockHit.distance };
    }
    return { type: "miss" };
  }

  // A single machine-gun shot (called repeatedly from update() while held).
  fireMachineGun() {
    const p = this.player;
    const eye = p.getEyePosition();
    const dir = p.getForwardVector();
    // Spread and camera recoil both grow the longer the trigger is held.
    const spread = 0.006 + this._mgHeat * 0.03;
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();
    this.shots++;
    const blockHit = this.world.raycast(eye, dir, MACHINEGUN_RANGE, { solidOnly: true });
    const mobHit = this.mobs.raycast(eye, dir, blockHit ? blockHit.distance : MACHINEGUN_RANGE);
    const muzzle = this._handPoint(0.7, 0.3, 0.16);
    this.effects.muzzleFlash(muzzle, 0.85);
    this.held.fire(0.55);
    p.kick(0.016 + this._mgHeat * 0.022);
    this.audio.playMachineGun ? this.audio.playMachineGun() : this.audio.playGunshot();
    const isMob = !!mobHit && (!blockHit || mobHit.distance < blockHit.distance);
    const dist = isMob ? mobHit.distance : blockHit ? blockHit.distance : MACHINEGUN_RANGE;
    const endPoint = eye.clone().addScaledVector(dir, dist);
    this._spawnTracer(muzzle, endPoint);
    if (isMob) {
      this.mobs.shoot(mobHit.mob, MACHINEGUN_DAMAGE, dir, 2);
      this._burst(endPoint, dir.clone().negate(), this._c.blood, 5, 2.5);
      return;
    }
    if (blockHit && this._isRealBlock(endPoint)) {
      const n = blockHit.normal;
      const normal = new THREE.Vector3(n[0], n[1], n[2]);
      this.decals.add(endPoint, blockHit.block, n);
      for (let i = 0; i < 4; i++) {
        const v = normal.clone().multiplyScalar(2 + Math.random() * 3).add(new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 2, (Math.random() - 0.5) * 4));
        this.effects.glow.spawn({ x: endPoint.x, y: endPoint.y, z: endPoint.z, vx: v.x, vy: v.y, vz: v.z, life: 0.12 + Math.random() * 0.2, size0: 0.05, size1: 0.02, color0: this._c.spark, gravity: 0.6, drag: 2 });
      }
    }
    if (blockHit) this.audio.playRicochet(blockHit.distance);
  }

  // Locks the airstrike target where the laser currently points; the meteor
  // rain lands there (and around it) after AIRSTRIKE_DELAY seconds.
  fireAirstrike() {
    const target = this._aimPoint(AIRSTRIKE_AIM_RANGE);
    this.airstrikes.push({ pos: target.clone(), timer: AIRSTRIKE_DELAY });
    this.audio.playLockOn ? this.audio.playLockOn() : this.audio.playThrow();
  }

  _spawnMeteorRain(center) {
    for (let i = 0; i < AIRSTRIKE_METEOR_COUNT; i++) {
      const centered = i === 0;
      const ang = Math.random() * Math.PI * 2;
      const dist = centered ? 0 : AIRSTRIKE_SPREAD_MIN + Math.random() * (AIRSTRIKE_SPREAD_MAX - AIRSTRIKE_SPREAD_MIN);
      const tx = center.x + Math.cos(ang) * dist;
      const tz = center.z + Math.sin(ang) * dist;
      const groundY = this.world.heightAt(Math.floor(tx), Math.floor(tz));
      const startY = Math.max(center.y, groundY) + 34 + Math.random() * 14;
      const start = new THREE.Vector3(tx, startY, tz);
      const target = new THREE.Vector3(tx, groundY, tz);
      const dir = target.clone().sub(start).normalize();
      const speed = 42 + Math.random() * 12;
      const mesh = new THREE.Mesh(this._meteorGeo, this.material);
      mesh.castShadow = true;
      const m = { pos: start.clone(), vel: dir.multiplyScalar(speed), mesh, age: 0, light: { sky: 15, block: 0 } };
      bindEntityLight(mesh, () => m.light);
      mesh.position.copy(start);
      this.scene.add(mesh);
      this.meteors.push(m);
    }
    this.effects.glow.spawn({ x: center.x, y: center.y + 1, z: center.z, life: 0.4, size0: 2, size1: 0.5, color0: this._c.blink, alpha: 0.8 });
  }

  _updateMeteor(m, dt) {
    m.age += dt;
    m.vel.y -= 24 * dt;
    const step = m.vel.clone().multiplyScalar(dt);
    const len = step.length() || 0.0001;
    const dir = step.clone().divideScalar(len);
    const blockHit = this.world.raycast(m.pos, dir, len, { solidOnly: true });
    if (blockHit) {
      m.pos.addScaledVector(dir, Math.max(0, blockHit.distance - 0.05));
      return true;
    }
    m.pos.add(step);
    if (this.mobs.sphereHit(m.pos, 0.35)) return true;
    m.mesh.position.copy(m.pos);
    m.mesh.rotation.x += dt * 6;
    m.mesh.rotation.z += dt * 4;
    m.light = this.world.lightAt(m.pos.x, m.pos.y, m.pos.z);
    this.effects.glow.spawn({ x: m.pos.x, y: m.pos.y, z: m.pos.z, vx: (Math.random() - 0.5) * 0.5, vy: 0.2, vz: (Math.random() - 0.5) * 0.5, life: 0.3 + Math.random() * 0.2, size0: 0.4, size1: 0.1, color0: this._c.exhaust, alpha: 0.85 });
    this.effects.smoke.spawn({ x: m.pos.x, y: m.pos.y, z: m.pos.z, vx: 0, vy: 0.3, vz: 0, life: 1.2, size0: 0.3, size1: 1.2, color0: this._c.smoke, color1: this._c.smokeEnd, alpha: 0.3, drag: 1 });
    if (m.pos.y < -20 || m.age > 8) return true;
    return false;
  }

  // A block hit is "real" (a loaded chunk) vs. an approximate heightfield
  // guess for unloaded/distant terrain, which shouldn't get decals or sparks.
  _isRealBlock(point) {
    return !!this.world.getChunk(Math.floor(point.x) >> 4, Math.floor(point.z) >> 4);
  }

  _spawnTracer(a, b) {
    const t = this._tracers[this._tracerNext];
    this._tracerNext = (this._tracerNext + 1) % this._tracers.length;
    const pos = t.line.geometry.attributes.position;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    t.line.geometry.computeBoundingSphere();
    t.age = 0;
    t.line.visible = true;
    t.line.material.opacity = 0.9;
  }

  _updateLaser(active) {
    this._laser.visible = active;
    this._laserDot.visible = active;
    if (!active) return;
    const origin = this._handPoint(0.5, 0.24, 0.15);
    const target = this._aimPoint(AIRSTRIKE_AIM_RANGE);
    const pos = this._laser.geometry.attributes.position;
    pos.setXYZ(0, origin.x, origin.y, origin.z);
    pos.setXYZ(1, target.x, target.y, target.z);
    pos.needsUpdate = true;
    this._laser.geometry.computeBoundingSphere();
    this._laserDot.position.copy(target);
  }

  // Where a shot or throw leaves the hand, in world space (just right of
  // and below the eyes, a little ahead).
  _handPoint(forwardDist, right = 0.28, down = 0.2) {
    const p = this.player;
    const eye = p.getEyePosition();
    const f = p.getForwardVector();
    const r = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    return eye.addScaledVector(f, forwardDist).addScaledVector(r, right).add(new THREE.Vector3(0, -down, 0));
  }

  // The world point under the crosshair (for aiming projectiles from the hand).
  _aimPoint(range = 200) {
    const eye = this.player.getEyePosition();
    const dir = this.player.getForwardVector();
    const hit = this.world.raycast(eye, dir, range, { solidOnly: true });
    return eye.addScaledVector(dir, hit ? hit.distance : range);
  }

  // ---------- Grenade ----------

  // power 0-1: a quick click lobs it a short way, a full charge throws far.
  throwGrenade(power) {
    const p = this.player;
    const dir = p.getForwardVector();
    dir.y += 0.12; // a little lob so level throws arc
    dir.normalize();
    const speed = THROW_SPEED_MIN + (THROW_SPEED_MAX - THROW_SPEED_MIN) * power;
    const vel = dir.multiplyScalar(speed);
    vel.x += p.velocity.x * 0.5;
    vel.z += p.velocity.z * 0.5;
    const pos = this._handPoint(0.45, 0.18, 0.12);
    // Never start inside a wall.
    if (IS_SOLID[this.world.getBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))]) pos.copy(p.getEyePosition());
    const mesh = new THREE.Mesh(this._grenadeGeo, this.material);
    mesh.castShadow = true;
    const g = { pos, vel, age: 0, mesh, light: { sky: 15, block: 0 }, spin: new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize(), angle: 0, blink: 0, power };
    bindEntityLight(mesh, () => g.light);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.grenades.push(g);
    this.held.swing();
    this.audio.playThrow();
    return g;
  }

  _solidAt(x, y, z) {
    return IS_SOLID[this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))] === 1;
  }

  _updateGrenade(g, dt) {
    g.age += dt;
    const w = this.world;
    const pos = g.pos;
    const vel = g.vel;
    const inWater = w.getBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)) === BLOCK.WATER;
    vel.y += GRENADE_GRAVITY * (inWater ? 0.3 : 1) * dt;
    if (inWater) vel.multiplyScalar(Math.exp(-2.5 * dt));
    // Sub-stepped, axis-separated movement with bounces.
    const steps = Math.max(1, Math.ceil((vel.length() * dt) / 0.08));
    const sdt = dt / steps;
    let resting = false;
    for (let s = 0; s < steps; s++) {
      for (const axis of ["x", "y", "z"]) {
        const d = vel[axis] * sdt;
        if (d === 0) continue;
        const probe = pos.clone();
        probe[axis] += d + Math.sign(d) * GRENADE_R;
        if (this._solidAt(probe.x, probe.y, probe.z)) {
          const impact = Math.abs(vel[axis]);
          vel[axis] = -vel[axis] * RESTITUTION;
          // Friction along the surface it hit.
          for (const other of ["x", "y", "z"]) if (other !== axis) vel[other] *= axis === "y" ? 0.72 : 0.88;
          if (axis === "y" && d < 0) {
            if (Math.abs(vel.y) < 1.2) vel.y = 0;
            resting = true;
          }
          if (impact > 2) this.audio.playGrenadeBounce(Math.min(1, impact / 15), pos.distanceTo(this.player.getEyePosition()));
        } else {
          pos[axis] += d;
        }
      }
    }
    // Rolling to a stop on the ground.
    if (resting || this._solidAt(pos.x, pos.y - GRENADE_R - 0.02, pos.z)) {
      const f = Math.exp(-3 * dt);
      vel.x *= f;
      vel.z *= f;
    }
    const speed = vel.length();
    g.angle += speed * dt * 4;
    g.mesh.position.copy(pos);
    g.mesh.quaternion.setFromAxisAngle(g.spin, g.angle);
    g.light = w.lightAt(pos.x, pos.y, pos.z);

    // A red light blinks on the fuse, faster as it runs out.
    const left = GRENADE_FUSE - g.age;
    g.blink -= dt;
    if (g.blink <= 0) {
      g.blink = left > 2 ? 0.5 : left > 1 ? 0.25 : 0.1;
      this.effects.glow.spawn({ x: pos.x, y: pos.y + 0.16, z: pos.z, life: 0.08, size0: 0.25, size1: 0.2, color0: this._c.blink, alpha: 1 });
    }

    // A direct hit on a mob sets it off at once.
    if (g.age > 0.05 && this.mobs.sphereHit(pos, GRENADE_R)) return true;
    return g.age >= GRENADE_FUSE || pos.y < -20;
  }

  // ---------- Pistol ----------

  firePistol() {
    const p = this.player;
    const eye = p.getEyePosition();
    const dir = p.getForwardVector();
    // A tiny spread, so rapid fire isn't a laser.
    dir.x += (Math.random() - 0.5) * 0.004;
    dir.y += (Math.random() - 0.5) * 0.004;
    dir.z += (Math.random() - 0.5) * 0.004;
    dir.normalize();
    this.shots++;
    const blockHit = this.world.raycast(eye, dir, PISTOL_RANGE, { solidOnly: true });
    const mobHit = this.mobs.raycast(eye, dir, blockHit ? blockHit.distance : PISTOL_RANGE);
    const muzzle = this._handPoint(0.7, 0.26, 0.17);
    this.effects.muzzleFlash(muzzle, 1);
    this.held.fire(1);
    p.kick(0.035);
    this.audio.playGunshot();
    if (mobHit) {
      const hitPoint = eye.clone().addScaledVector(dir, mobHit.distance);
      this.mobs.shoot(mobHit.mob, PISTOL_DAMAGE, dir, 3.5);
      this._burst(hitPoint, dir.clone().negate(), this._c.blood, 8, 3);
      return { type: "mob", mob: mobHit.mob, point: hitPoint };
    }
    if (blockHit) {
      const point = eye.clone().addScaledVector(dir, blockHit.distance);
      const n = blockHit.normal;
      const normal = new THREE.Vector3(n[0], n[1], n[2]);
      this.decals.add(point, blockHit.block, n);
      // Sparks off the face, plus dust in the block's color.
      for (let i = 0; i < 9; i++) {
        const v = normal.clone().multiplyScalar(2 + Math.random() * 4).add(new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 3, (Math.random() - 0.5) * 5));
        this.effects.glow.spawn({ x: point.x, y: point.y, z: point.z, vx: v.x, vy: v.y, vz: v.z, life: 0.15 + Math.random() * 0.25, size0: 0.07, size1: 0.02, color0: this._c.spark, gravity: 0.6, drag: 2 });
      }
      const rgb = this.world.blockColors[blockHit.id] || [0.6, 0.6, 0.6];
      this._burst(point, normal, this._c.tmp.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace), 6, 2.5);
      this.audio.playRicochet(blockHit.distance);
      return { type: "block", block: blockHit.block, point };
    }
    return { type: "miss" };
  }

  _burst(point, normal, color, count, speed) {
    for (let i = 0; i < count; i++) {
      this.effects.debris.spawn(
        point.x + normal.x * 0.05, point.y + normal.y * 0.05, point.z + normal.z * 0.05,
        normal.x * speed + (Math.random() - 0.5) * speed, normal.y * speed + Math.random() * speed, normal.z * speed + (Math.random() - 0.5) * speed,
        0.04 + Math.random() * 0.05, color, 0.4 + Math.random() * 0.4
      );
    }
  }

  // ---------- Bazooka ----------

  fireBazooka() {
    const p = this.player;
    const start = this._handPoint(0.9, 0.3, 0.19);
    // Fly toward whatever is under the crosshair.
    const target = this._aimPoint();
    const dir = target.clone().sub(start);
    if (dir.lengthSq() < 1) dir.copy(p.getForwardVector());
    dir.normalize();
    const eye = p.getEyePosition();
    // Point blank against a wall: start from the eyes so it hits the wall.
    if (IS_SOLID[this.world.getBlock(Math.floor(start.x), Math.floor(start.y), Math.floor(start.z))]) start.copy(eye);
    const mesh = new THREE.Mesh(this._rocketGeo, this.material);
    mesh.castShadow = true;
    const exhaust = new THREE.Sprite(this._exhaustMat);
    exhaust.layers.set(LAYER_FX);
    exhaust.position.set(0, 0, 0.36);
    exhaust.scale.setScalar(0.7);
    mesh.add(exhaust);
    const r = { pos: start.clone(), vel: dir.clone().multiplyScalar(ROCKET_SPEED), age: 0, mesh, exhaust, light: { sky: 15, block: 0 } };
    bindEntityLight(mesh, () => r.light);
    mesh.position.copy(start);
    mesh.lookAt(start.clone().add(dir));
    mesh.rotateY(Math.PI); // the model points along -Z
    this.scene.add(mesh);
    this.rockets.push(r);
    this.effects.muzzleFlash(start, 2.5);
    this.held.fire(2.2);
    p.kick(0.09);
    p.applyImpulse(dir.clone().multiplyScalar(-2.5).setY(0));
    this.audio.playRocketLaunch();
    // Backblast smoke behind the shoulder.
    const back = start.clone().addScaledVector(dir, -1.4);
    for (let i = 0; i < 10; i++) {
      this.effects.smoke.spawn({
        x: back.x, y: back.y, z: back.z,
        vx: -dir.x * (3 + Math.random() * 4) + (Math.random() - 0.5) * 2, vy: Math.random() * 1.5, vz: -dir.z * (3 + Math.random() * 4) + (Math.random() - 0.5) * 2,
        life: 1 + Math.random(), size0: 0.5, size1: 2.2, color0: this._c.smoke, color1: this._c.smokeEnd, alpha: 0.5, drag: 2.5,
      });
    }
    return r;
  }

  // Returns the explosion point, or null (keep flying), or false (gone).
  _updateRocket(r, dt) {
    r.age += dt;
    r.vel.y += ROCKET_GRAVITY * dt;
    const step = r.vel.clone().multiplyScalar(dt);
    const len = step.length();
    const dir = step.clone().divideScalar(len || 1);
    const blockHit = this.world.raycast(r.pos, dir, len, { solidOnly: true });
    const mobHit = this.mobs.raycast(r.pos, dir, blockHit ? blockHit.distance : len);
    if (mobHit) return r.pos.clone().addScaledVector(dir, mobHit.distance);
    if (blockHit) return r.pos.clone().addScaledVector(dir, Math.max(0, blockHit.distance - 0.3));
    // Smoke trail and glowing exhaust along the path.
    for (let i = 0; i < 3; i++) {
      const t = Math.random();
      this.effects.smoke.spawn({
        x: r.pos.x + step.x * t, y: r.pos.y + step.y * t, z: r.pos.z + step.z * t,
        vx: (Math.random() - 0.5) * 0.6, vy: 0.3 + Math.random() * 0.4, vz: (Math.random() - 0.5) * 0.6,
        life: 1.2 + Math.random() * 1.2, size0: 0.35, size1: 1.6, color0: this._c.smoke, color1: this._c.smokeEnd, alpha: 0.45, drag: 1,
      });
    }
    this.effects.glow.spawn({ x: r.pos.x, y: r.pos.y, z: r.pos.z, life: 0.12, size0: 0.5, size1: 0.1, color0: this._c.exhaust, alpha: 0.9 });
    r.pos.add(step);
    r.mesh.position.copy(r.pos);
    r.mesh.lookAt(r.pos.clone().add(dir));
    r.mesh.rotateY(Math.PI);
    r.exhaust.scale.setScalar(0.6 + Math.random() * 0.3);
    r.light = this.world.lightAt(r.pos.x, r.pos.y, r.pos.z);
    // Keeps flying over distant/unloaded terrain (its raycast above already
    // hit-tests the height map out there) rather than vanishing unexploded.
    if (r.age > ROCKET_LIFE || r.pos.y < -20 || r.pos.y > 300) return false;
    return null;
  }

  // ---------- Per frame ----------

  update(dt) {
    this._cooldown = Math.max(0, this._cooldown - dt);
    if (this.charging) this.chargeTime += dt;
    this.held.windUp = this.charge;

    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      if (this._updateGrenade(g, dt)) {
        this.scene.remove(g.mesh);
        this.grenades.splice(i, 1);
        if (g.pos.y > -20) this.effects.explode(g.pos.clone(), { radius: GRENADE_RADIUS, source: "grenade" });
      }
    }
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const result = this._updateRocket(r, dt);
      if (result === null) continue;
      this.scene.remove(r.mesh);
      this.rockets.splice(i, 1);
      if (result) this.effects.explode(result, { radius: BAZOOKA_RADIUS, source: "bazooka" });
    }
    // The exhaust light follows the newest rocket in flight.
    const newest = this.rockets[this.rockets.length - 1];
    const light = this.effects.projectileLight;
    if (newest) {
      light.position.copy(newest.pos);
      light.intensity = 30;
    } else {
      light.intensity = 0;
    }

    // Stop mid-effect automatically if the active item changed under us
    // (e.g. picked in the inventory screen rather than the hotbar keys).
    const activeKind = itemInfo(this.inventory?.selectedStack?.id)?.weapon?.kind;
    if (this._mgFiring && activeKind !== "machinegun") this._mgFiring = false;
    if (this.scoped && activeKind !== "sniper") {
      this.scoped = false;
      this._applyScope();
    }

    // Machine gun: automatic fire while held, with climbing spread/recoil
    // that settle again once the trigger is released.
    if (this._mgFiring) {
      this._mgTimer -= dt;
      this._mgHeat = Math.min(1, this._mgHeat + dt * 1.5);
      let guard = 0;
      while (this._mgTimer <= 0 && guard++ < 4) {
        this._mgTimer += 1 / MACHINEGUN_RATE;
        this.fireMachineGun();
      }
    } else {
      this._mgTimer = 0;
      this._mgHeat = Math.max(0, this._mgHeat - dt * 2.5);
    }

    // Pending airstrikes: after the delay, rain meteors on the target.
    for (let i = this.airstrikes.length - 1; i >= 0; i--) {
      const a = this.airstrikes[i];
      a.timer -= dt;
      if (a.timer <= 0) {
        this._spawnMeteorRain(a.pos);
        this.airstrikes.splice(i, 1);
      }
    }
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      if (this._updateMeteor(m, dt)) {
        this.scene.remove(m.mesh);
        this.meteors.splice(i, 1);
        this.effects.explode(m.pos.clone(), { radius: AIRSTRIKE_METEOR_RADIUS, source: "airstrike" });
      }
    }

    // The laser sight tracks the aim point while the designator is held.
    this._updateLaser(activeKind === "airstrike");

    // Tracer lines fade quickly.
    for (const t of this._tracers) {
      if (t.age > 0.14) continue;
      t.age += dt;
      t.line.material.opacity = Math.max(0, 0.9 * (1 - t.age / 0.12));
      if (t.age > 0.12) t.line.visible = false;
    }
  }

  // Direction and speed of a throw of the given power (for tests).
  static throwSpeed(power) {
    return THROW_SPEED_MIN + (THROW_SPEED_MAX - THROW_SPEED_MIN) * power;
  }
}
