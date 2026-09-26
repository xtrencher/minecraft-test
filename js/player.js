import * as THREE from "three";

const EYE_HEIGHT = 1.62;
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.3;
const GRAVITY = -26;
const JUMP_SPEED = 8.6;
const WALK_SPEED = 5.2;
const FLY_SPEED = 11;
const MAX_FALL_SPEED = -50;
const DOUBLE_TAP_WINDOW = 0.32;
const EPS = 1e-4;

export class Player {
  constructor(camera, world, domElement) {
    this.camera = camera;
    this.world = world;
    this.domElement = domElement;

    this.position = new THREE.Vector3(0, 40, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.stepEvent = false;
    this.jumpEvent = false;

    this.keys = new Set();
    this.locked = false;
    this._lastSpaceTime = -10;
    this._footstepDistance = 0;

    this.enabled = false;
    this.onFlightToggle = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);

    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    document.addEventListener("mousemove", this._onMouseMove);
  }

  setLocked(locked) {
    this.locked = locked;
    if (!locked) this.keys.clear();
  }

  _onKeyDown(e) {
    if (!this.locked) return;
    this.keys.add(e.code);
    if (e.code === "Space") {
      const now = performance.now() / 1000;
      if (now - this._lastSpaceTime < DOUBLE_TAP_WINDOW) {
        this.flying = !this.flying;
        this.velocity.y = 0;
        if (this.onFlightToggle) this.onFlightToggle(this.flying);
      }
      this._lastSpaceTime = now;
    }
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  _onMouseMove(e) {
    if (!this.locked) return;
    const sensitivity = 0.0022;
    this.yaw -= e.movementX * sensitivity;
    this.pitch -= e.movementY * sensitivity;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  spawnAt(wx, wz) {
    const h = this.world.heightAt(wx, wz);
    this.position.set(wx, h + 2, wz);
    this.velocity.set(0, 0, 0);
  }

  getEyePosition() {
    return new THREE.Vector3(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
  }

  // Computed directly from yaw/pitch rather than camera.getWorldDirection(),
  // since the camera's matrixWorld isn't refreshed until renderer.render()
  // runs — using it here would read one frame stale during fast look input.
  getForwardVector() {
    return new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    );
  }

  // Returns the maximum movement (same sign as delta, magnitude <= |delta|) allowed along
  // one axis before the player's AABB would overlap a solid voxel, given the current
  // (already axis-resolved) position on the other two axes.
  _sweepAxis(axis, delta) {
    if (delta === 0) return 0;
    const r = PLAYER_RADIUS;
    let minX = this.position.x - r;
    let maxX = this.position.x + r;
    let minY = this.position.y;
    let maxY = this.position.y + PLAYER_HEIGHT;
    let minZ = this.position.z - r;
    let maxZ = this.position.z + r;

    if (axis === "x") {
      if (delta > 0) maxX += delta;
      else minX += delta;
    } else if (axis === "y") {
      if (delta > 0) maxY += delta;
      else minY += delta;
    } else {
      if (delta > 0) maxZ += delta;
      else minZ += delta;
    }

    const bx0 = Math.floor(minX);
    const bx1 = Math.floor(maxX - EPS);
    const by0 = Math.floor(minY);
    const by1 = Math.floor(maxY - EPS);
    const bz0 = Math.floor(minZ);
    const bz1 = Math.floor(maxZ - EPS);

    let allowed = delta;
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        for (let bz = bz0; bz <= bz1; bz++) {
          if (!this.world.isSolidAt(bx, by, bz)) continue;
          if (axis === "x") {
            if (delta > 0) allowed = Math.min(allowed, bx - (this.position.x + r) - EPS);
            else allowed = Math.max(allowed, bx + 1 - (this.position.x - r) + EPS);
          } else if (axis === "y") {
            if (delta > 0) allowed = Math.min(allowed, by - (this.position.y + PLAYER_HEIGHT) - EPS);
            else allowed = Math.max(allowed, by + 1 - this.position.y + EPS);
          } else {
            if (delta > 0) allowed = Math.min(allowed, bz - (this.position.z + r) - EPS);
            else allowed = Math.max(allowed, bz + 1 - (this.position.z - r) + EPS);
          }
        }
      }
    }

    if (axis === "y" && delta < 0 && allowed > delta) this.onGround = true;
    return allowed;
  }

  update(dt) {
    if (!this.enabled) return;
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;

    this.jumpEvent = false;
    let moveX = 0;
    let moveZ = 0;
    if (this.keys.has("KeyW")) moveZ -= 1;
    if (this.keys.has("KeyS")) moveZ += 1;
    if (this.keys.has("KeyA")) moveX -= 1;
    if (this.keys.has("KeyD")) moveX += 1;

    const len = Math.hypot(moveX, moveZ);
    if (len > 0) {
      moveX /= len;
      moveZ /= len;
    }

    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    // Forward is -Z in camera space.
    const worldX = moveX * cosY - moveZ * sinY;
    const worldZ = -moveX * sinY - moveZ * cosY;

    const speed = this.flying ? FLY_SPEED : WALK_SPEED;
    this.velocity.x = worldX * speed;
    this.velocity.z = worldZ * speed;

    if (this.flying) {
      let vy = 0;
      if (this.keys.has("Space")) vy += 1;
      if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) vy -= 1;
      this.velocity.y = vy * speed;
    } else {
      this.velocity.y += GRAVITY * dt;
      if (this.velocity.y < MAX_FALL_SPEED) this.velocity.y = MAX_FALL_SPEED;
      if (this.onGround && this.keys.has("Space")) {
        this.velocity.y = JUMP_SPEED;
        this.jumpEvent = true;
      }
    }

    this.onGround = false;

    const dx = this._sweepAxis("x", this.velocity.x * dt);
    this.position.x += dx;
    if (dx === 0) this.velocity.x = 0;

    const dy = this._sweepAxis("y", this.velocity.y * dt);
    this.position.y += dy;
    if (Math.abs(dy - this.velocity.y * dt) > 1e-6) this.velocity.y = 0;

    const dz = this._sweepAxis("z", this.velocity.z * dt);
    this.position.z += dz;
    if (dz === 0) this.velocity.z = 0;

    this.stepEvent = false;
    if (this.onGround && !this.flying && (moveX !== 0 || moveZ !== 0)) {
      this._footstepDistance += WALK_SPEED * dt;
      if (this._footstepDistance > 2.2) {
        this._footstepDistance = 0;
        this.stepEvent = true;
      }
    }

    // Safety net: respawn if the player somehow falls below the world.
    if (this.position.y < -20) {
      this.spawnAt(Math.round(this.position.x), Math.round(this.position.z));
    }

    this.camera.position.copy(this.getEyePosition());
  }

  dispose() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    document.removeEventListener("mousemove", this._onMouseMove);
  }
}
