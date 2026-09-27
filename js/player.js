import * as THREE from "three";
import { BLOCK } from "./blocks.js";
import { sweepAxis } from "./physics.js";

const EYE_HEIGHT = 1.62;
const SNEAK_EYE_DROP = 0.3;
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.3;
const GRAVITY = -26;
const JUMP_SPEED = 8.6;
const WALK_SPEED = 4.6;
const SPRINT_SPEED = 6.3;
const SNEAK_SPEED = 1.5;
const SWIM_SPEED = 2.6;
const FLY_SPEED = 11;
const FLY_SPRINT_SPEED = 19;
const MAX_FALL_SPEED = -50;
const WATER_GRAVITY = -7;
const WATER_MAX_SINK = -3;
const DOUBLE_TAP_WINDOW = 0.32;

export const MAX_HEALTH = 20; // half-hearts
export const MAX_AIR = 10; // bubbles (seconds of breath)
const INVULNERABLE_TIME = 0.5;
const REGEN_DELAY = 4; // seconds without damage before health regenerates
const REGEN_INTERVAL = 2.5; // seconds per half-heart
const SAFE_FALL = 3; // blocks you can fall without damage

export const BASE_FOV = 75;

export class Player {
  constructor(camera, world, domElement) {
    this.camera = camera;
    this.world = world;
    this.domElement = domElement;

    this.position = new THREE.Vector3(0, 40, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    // External horizontal push (explosions, hits). Kept separate from the
    // input-driven velocity, which is recomputed every frame, and decays
    // quickly on the ground and slowly in the air.
    this.knockback = new THREE.Vector3(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.sprinting = false;
    this.sneaking = false;
    this.inWater = false;
    this.headInWater = false;
    this.mode = "survival"; // "survival" | "creative"

    this.health = MAX_HEALTH;
    this.air = MAX_AIR;
    this.dead = false;
    this.hurtTime = 99; // seconds since the last damage (drives hurt effects)
    this._invulnerable = 0;
    this._lastDamage = 0;
    this._deathTime = 0;
    this._sinceDamage = 99;
    this._regenTimer = 0;
    this._drownTimer = 0;
    this._voidTimer = 0;
    this._airborneMaxY = null;
    this._eyeOffset = 0; // smoothed sneak camera drop

    this.stepEvent = false;
    this.jumpEvent = false;
    this.splashEvent = false;
    this.stepBlock = BLOCK.AIR;
    this.walkPhase = 0; // advances while walking (view/held-item bobbing)

    this.keys = new Set();
    this.locked = false;
    this._lastSpaceTime = -10;
    this._lastWTime = -10;
    this._footstepDistance = 0;
    this.fov = BASE_FOV;

    this.enabled = false;
    this.onFlightToggle = null;
    this.onHurt = null; // (amount, cause) => void
    this.onDeath = null; // (cause) => void

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);

    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    document.addEventListener("mousemove", this._onMouseMove);
  }

  get creative() {
    return this.mode === "creative";
  }

  setMode(mode) {
    this.mode = mode === "creative" ? "creative" : "survival";
    if (!this.creative && this.flying) {
      this.flying = false;
      if (this.onFlightToggle) this.onFlightToggle(false);
    }
    this._airborneMaxY = null;
  }

  setLocked(locked) {
    this.locked = locked;
    if (!locked) {
      this.keys.clear();
      this.sprinting = false;
    }
  }

  _onKeyDown(e) {
    if (!this.locked) return;
    // The event's own timestamp, so a slow frame between two taps doesn't
    // break a double-tap.
    const now = (e.timeStamp || performance.now()) / 1000;
    if (e.code === "KeyW" && !e.repeat) {
      // Double-tap W to sprint.
      if (now - this._lastWTime < DOUBLE_TAP_WINDOW) this.sprinting = true;
      this._lastWTime = now;
    }
    this.keys.add(e.code);
    if (e.code === "Space" && !e.repeat) {
      if (this.creative && now - this._lastSpaceTime < DOUBLE_TAP_WINDOW) {
        this.flying = !this.flying;
        this.velocity.y = 0;
        if (this.onFlightToggle) this.onFlightToggle(this.flying);
        this._lastSpaceTime = -10; // a third tap starts a new double-tap
      } else {
        this._lastSpaceTime = now;
      }
    }
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
    if (e.code === "KeyW") this.sprinting = false;
  }

  _onMouseMove(e) {
    if (!this.locked || this.dead) return;
    const sensitivity = 0.0022;
    this.yaw -= e.movementX * sensitivity;
    this.pitch -= e.movementY * sensitivity;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  // Places the player standing on top of column (wx, wz).
  spawnAt(wx, wz) {
    const top = this.world.surfaceY ? this.world.surfaceY(wx, wz) : -1;
    const h = top >= 0 ? top : this.world.heightAt(wx, wz);
    this.position.set(wx + 0.5, h + 1.05, wz + 0.5);
    this.velocity.set(0, 0, 0);
    this.knockback.set(0, 0, 0);
    this._airborneMaxY = null;
  }

  // Full health and breath, alive again (used on respawn).
  revive() {
    this.health = MAX_HEALTH;
    this.air = MAX_AIR;
    this.dead = false;
    this.hurtTime = 99;
    this._deathTime = 0;
    this._invulnerable = 1.5;
    this._lastDamage = 0;
    this._eyeOffset = 0;
    this._sinceDamage = 99;
    this.flying = false;
    this.sprinting = false;
  }

  // Pushes the player: the horizontal part becomes decaying knockback, the
  // vertical part is added straight to the velocity (ignored while flying).
  applyImpulse(impulse) {
    this.knockback.x += impulse.x;
    this.knockback.z += impulse.z;
    if (!this.flying) this.velocity.y = Math.max(this.velocity.y, 0) + impulse.y;
  }

  // Deals damage in half-hearts. Returns true if it was applied (creative
  // players, the dead and the briefly invulnerable take none).
  damage(amount, cause) {
    if (this.dead || this.creative || amount <= 0) return false;
    // Right after a hit only a stronger hit counts (and only its excess).
    let applied = amount;
    if (this._invulnerable > 0) {
      if (amount <= this._lastDamage) return false;
      applied = amount - this._lastDamage;
    } else {
      this._invulnerable = INVULNERABLE_TIME;
    }
    this._lastDamage = amount;
    this.health = Math.max(0, this.health - applied);
    this._sinceDamage = 0;
    this.hurtTime = 0;
    if (this.onHurt) this.onHurt(amount, cause);
    if (this.health <= 0) {
      this.dead = true;
      this._deathTime = 0;
      this.sprinting = false;
      this.flying = false;
      if (this.onDeath) this.onDeath(cause);
    }
    return true;
  }

  heal(amount) {
    if (this.dead) return 0;
    const before = this.health;
    this.health = Math.min(MAX_HEALTH, this.health + amount);
    return this.health - before;
  }

  getEyePosition() {
    return new THREE.Vector3(this.position.x, this.position.y + EYE_HEIGHT - this._eyeOffset, this.position.z);
  }

  // Computed directly from yaw/pitch rather than camera.getWorldDirection(),
  // since the camera's matrixWorld isn't refreshed until renderer.render()
  // runs — using it here would read one frame stale during fast look input.
  getForwardVector() {
    return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  // Points the camera from the player's eyes along the current yaw/pitch,
  // with a brief roll when hurt and a fall to the side when dead.
  syncCamera() {
    let roll = 0;
    let drop = 0;
    if (this.hurtTime < 0.4) roll = Math.sin((this.hurtTime / 0.4) * Math.PI) * 0.1;
    if (this.dead) {
      const k = Math.min(1, this._deathTime / 0.55);
      roll = k * k * 1.2;
      drop = k * k * 1.15;
    }
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.set(this.pitch, this.yaw, roll);
    this.camera.position.copy(this.getEyePosition());
    this.camera.position.y -= drop;
  }

  // Maximum movement along one axis before the player's box would overlap a
  // solid voxel (see physics.js); also detects landing on the ground.
  _sweepAxis(axis, delta) {
    const allowed = sweepAxis(this.world, this.position, PLAYER_RADIUS, PLAYER_HEIGHT, axis, delta);
    if (axis === "y" && delta < 0 && allowed > delta) this.onGround = true;
    return allowed;
  }

  // Whether a solid block lies under the player's footprint if it were at (x, z).
  _hasSupportAt(x, z) {
    const r = PLAYER_RADIUS - 0.02;
    const y = Math.floor(this.position.y - 0.4);
    for (let bx = Math.floor(x - r); bx <= Math.floor(x + r); bx++) {
      for (let bz = Math.floor(z - r); bz <= Math.floor(z + r); bz++) {
        if (this.world.isSolidAt(bx, y, bz)) return true;
      }
    }
    return false;
  }

  _waterAt(yOffset) {
    const p = this.position;
    return this.world.getBlock(Math.floor(p.x), Math.floor(p.y + yOffset), Math.floor(p.z)) === BLOCK.WATER;
  }

  update(dt) {
    if (!this.enabled) return;
    this.jumpEvent = false;
    this.splashEvent = false;
    this.stepEvent = false;
    this._invulnerable = Math.max(0, this._invulnerable - dt);
    this.hurtTime += dt;

    if (this.dead) {
      this._deathTime += dt;
      this.syncCamera();
      return;
    }

    let moveX = 0;
    let moveZ = 0;
    if (this.keys.has("KeyW")) moveZ -= 1;
    if (this.keys.has("KeyS")) moveZ += 1;
    if (this.keys.has("KeyA")) moveX -= 1;
    if (this.keys.has("KeyD")) moveX += 1;
    if ((this.keys.has("ControlLeft") || this.keys.has("ControlRight")) && this.keys.has("KeyW")) this.sprinting = true;
    const shift = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    this.sneaking = shift && !this.flying;
    if (this.sneaking || moveZ >= 0) this.sprinting = false;

    const len = Math.hypot(moveX, moveZ);
    if (len > 0) {
      moveX /= len;
      moveZ /= len;
    }

    const wasInWater = this.inWater;
    this.inWater = this._waterAt(0.4) || this._waterAt(1.0);
    this.headInWater = this._waterAt(EYE_HEIGHT - this._eyeOffset);
    if (this.inWater && !wasInWater && this.velocity.y < -4) this.splashEvent = true;

    // Rotate the camera-space input (x = right, z = backward, since the camera
    // looks down -Z) by the yaw around +Y into world space. At yaw 0, W gives
    // (0, -1) = forward and D gives (1, 0) = right; in general forward is
    // (-sin yaw, -cos yaw), matching getForwardVector().
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const worldX = moveX * cosY + moveZ * sinY;
    const worldZ = -moveX * sinY + moveZ * cosY;

    let speed;
    if (this.flying) speed = this.sprinting ? FLY_SPRINT_SPEED : FLY_SPEED;
    else if (this.inWater) speed = this.sprinting ? SWIM_SPEED * 1.4 : SWIM_SPEED;
    else if (this.sneaking) speed = SNEAK_SPEED;
    else speed = this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    this.velocity.x = worldX * speed + this.knockback.x;
    this.velocity.z = worldZ * speed + this.knockback.z;
    const knockbackDecay = Math.exp(-(this.onGround ? 7 : 1.2) * dt);
    this.knockback.x *= knockbackDecay;
    this.knockback.z *= knockbackDecay;

    const space = this.keys.has("Space");
    if (this.flying) {
      let vy = 0;
      if (space) vy += 1;
      if (shift) vy -= 1;
      this.velocity.y = vy * speed;
    } else if (this.inWater) {
      this.velocity.y = Math.max(this.velocity.y + WATER_GRAVITY * dt, WATER_MAX_SINK);
      if (space) this.velocity.y = Math.min(this.velocity.y + 28 * dt, 3.6);
    } else {
      this.velocity.y += GRAVITY * dt;
      if (this.velocity.y < MAX_FALL_SPEED) this.velocity.y = MAX_FALL_SPEED;
      if (this.onGround && space) {
        this.velocity.y = JUMP_SPEED;
        this.jumpEvent = true;
      }
    }

    const wasOnGround = this.onGround;
    this.onGround = false;
    const edgeGuard = this.sneaking && wasOnGround && this.velocity.y <= 0;

    let dx = this._sweepAxis("x", this.velocity.x * dt);
    // Sneaking: don't walk off the edge of a block.
    if (edgeGuard && dx !== 0 && !this._hasSupportAt(this.position.x + dx, this.position.z)) dx = 0;
    this.position.x += dx;
    const blockedX = Math.abs(dx) < Math.abs(this.velocity.x * dt) - 1e-6;
    if (dx === 0) {
      this.velocity.x = 0;
      this.knockback.x = 0;
    }

    const dy = this._sweepAxis("y", this.velocity.y * dt);
    this.position.y += dy;
    if (Math.abs(dy - this.velocity.y * dt) > 1e-6) this.velocity.y = 0;

    let dz = this._sweepAxis("z", this.velocity.z * dt);
    if (edgeGuard && dz !== 0 && !this._hasSupportAt(this.position.x, this.position.z + dz)) dz = 0;
    this.position.z += dz;
    const blockedZ = Math.abs(dz) < Math.abs(this.velocity.z * dt) - 1e-6;
    if (dz === 0) {
      this.velocity.z = 0;
      this.knockback.z = 0;
    }

    // Climb out of water onto a ledge when swimming against it.
    if (this.inWater && space && (blockedX || blockedZ)) this.velocity.y = Math.max(this.velocity.y, 6);
    if (this.sprinting && (blockedX || blockedZ) && !this.inWater) this.sprinting = false;

    this._updateFall();
    this._updateVitals(dt);

    // Footsteps (only when actually walking on the ground).
    const walking = this.onGround && !this.flying && (moveX !== 0 || moveZ !== 0);
    if (walking) {
      this.walkPhase += speed * dt * 1.6;
      this._footstepDistance += speed * dt;
      if (this._footstepDistance > (this.sprinting ? 2.6 : 2.1)) {
        this._footstepDistance = 0;
        this.stepEvent = !this.sneaking;
        this.stepBlock = this.world.getBlock(Math.floor(this.position.x), Math.floor(this.position.y - 0.2), Math.floor(this.position.z));
      }
    }

    // Camera: sneaking lowers the eyes; sprinting widens the field of view.
    const eyeTarget = this.sneaking ? SNEAK_EYE_DROP : 0;
    this._eyeOffset += (eyeTarget - this._eyeOffset) * Math.min(1, dt * 12);
    const fovTarget = BASE_FOV + (this.sprinting ? 9 : 0) + (this.flying && this.sprinting ? 6 : 0);
    this.fov += (fovTarget - this.fov) * Math.min(1, dt * 8);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.syncCamera();
  }

  // Fall damage is based on the height fallen from the highest point of the
  // jump/fall, so jumping in place never hurts and water breaks any fall.
  _updateFall() {
    const y = this.position.y;
    if (this.flying || this.inWater || this.creative) {
      this._airborneMaxY = null;
      return;
    }
    if (!this.onGround) {
      this._airborneMaxY = this._airborneMaxY === null ? y : Math.max(this._airborneMaxY, y);
      return;
    }
    if (this._airborneMaxY !== null) {
      const fell = this._airborneMaxY - y;
      this._airborneMaxY = null;
      const dmg = Math.floor(fell - SAFE_FALL);
      if (dmg > 0) this.damage(dmg, "fall");
    }
  }

  _updateVitals(dt) {
    this._sinceDamage += dt;
    // Breath: drains with the head under water, refills quickly above it.
    if (this.headInWater && !this.creative) {
      this.air = Math.max(0, this.air - dt);
      if (this.air <= 0) {
        this._drownTimer += dt;
        if (this._drownTimer >= 1) {
          this._drownTimer = 0;
          this.damage(2, "drown");
        }
      }
    } else {
      this.air = Math.min(MAX_AIR, this.air + dt * 4);
      this._drownTimer = 0;
    }
    // Falling out of the world.
    if (this.position.y < -8) {
      if (this.creative) {
        this.position.y = 70;
        this.velocity.y = 0;
      } else {
        this._voidTimer += dt;
        if (this._voidTimer >= 0.5) {
          this._voidTimer = 0;
          this._invulnerable = 0;
          this.damage(4, "void");
        }
      }
    }
    // Natural regeneration after a while without damage.
    if (this.health < MAX_HEALTH && this._sinceDamage > REGEN_DELAY) {
      this._regenTimer += dt;
      if (this._regenTimer >= REGEN_INTERVAL) {
        this._regenTimer = 0;
        this.heal(1);
      }
    } else {
      this._regenTimer = 0;
    }
  }

  dispose() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    document.removeEventListener("mousemove", this._onMouseMove);
  }
}
