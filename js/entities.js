// Dropped item entities: blocks and items lying in the world that the player
// can pick up. They fall and bounce, float in water, bob and spin, get
// pulled toward a nearby player, merge with identical stacks nearby, and
// despawn after a while. Items in unloaded chunks simply wait (no physics).
import * as THREE from "three";
import { BLOCK, IS_SOLID } from "./blocks.js";
import { maxStack } from "./items.js";
import { itemModel } from "./models.js";
import { createEntityMaterial, bindEntityLight } from "./shaders.js";

const GRAVITY = -20;
const DESPAWN_SECONDS = 300;
const PICKUP_RADIUS = 1.1;
const MAGNET_RADIUS = 2.6;
const MAX_ITEMS = 300;
const SIZE = 0.25; // half-extent used for collision

export class ItemEntities {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.items = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this.materials = {
      array: createEntityMaterial("array", world.atlas),
      color: createEntityMaterial("color"),
    };
    this._mergeTimer = 0;
    this.onPickup = null; // (item) => leftover count
  }

  // Spawns a stack at `pos` with velocity `vel`. pickupDelay: seconds before
  // it can be collected (longer for items the player throws).
  spawn(id, count, pos, vel = null, { dur, pickupDelay = 0.4 } = {}) {
    const model = itemModel(id);
    if (!model || count <= 0) return null;
    if (this.items.length >= MAX_ITEMS) this._remove(0);
    const mesh = new THREE.Mesh(model.geometry, this.materials[model.kind]);
    mesh.scale.setScalar(model.cube ? 0.3 : 0.45);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const item = {
      id,
      count,
      dur,
      mesh,
      pos: pos.clone(),
      vel: vel ? vel.clone() : new THREE.Vector3((Math.random() - 0.5) * 2, 3 + Math.random() * 1.5, (Math.random() - 0.5) * 2),
      age: 0,
      pickupDelay,
      spin: Math.random() * Math.PI * 2,
      light: { sky: 15, block: 0 },
      onGround: false,
    };
    bindEntityLight(mesh, () => item.light);
    this.group.add(mesh);
    this.items.push(item);
    this._place(item);
    return item;
  }

  _remove(i) {
    const item = this.items[i];
    this.group.remove(item.mesh);
    this.items.splice(i, 1);
  }

  clear() {
    while (this.items.length) this._remove(this.items.length - 1);
  }

  _solid(x, y, z) {
    return IS_SOLID[this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))] === 1;
  }

  _place(item) {
    const bob = item.onGround ? Math.sin(item.age * 2.5) * 0.06 + 0.1 : 0;
    item.mesh.position.set(item.pos.x, item.pos.y + SIZE + bob, item.pos.z);
    item.mesh.rotation.y = item.spin + item.age * 1.4;
  }

  update(dt, player) {
    const world = this.world;
    const center = player ? new THREE.Vector3(player.position.x, player.position.y + 0.9, player.position.z) : null;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;
      if (it.age > DESPAWN_SECONDS) {
        this._remove(i);
        continue;
      }
      const p = it.pos;
      if (!world.getChunk(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4)) continue; // frozen until loaded
      it.pickupDelay -= dt;

      // Pull toward the player once collectable.
      if (center && !player.dead && it.pickupDelay <= 0) {
        const d = center.distanceTo(p);
        if (d < PICKUP_RADIUS) {
          const left = this.onPickup ? this.onPickup(it) : it.count;
          if (left <= 0) {
            this._remove(i);
            continue;
          }
          it.count = left;
          it.pickupDelay = 1; // inventory full: try again later
        } else if (d < MAGNET_RADIUS) {
          const pull = new THREE.Vector3().subVectors(center, p).normalize().multiplyScalar(14 * dt);
          it.vel.add(pull);
        }
      }

      // Physics: gravity (buoyant in water), axis-by-axis collision with blocks.
      const inWater = world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.1), Math.floor(p.z)) === BLOCK.WATER;
      if (inWater) {
        it.vel.y += (4 - it.vel.y * 2) * dt;
        it.vel.x *= Math.exp(-2 * dt);
        it.vel.z *= Math.exp(-2 * dt);
      } else {
        it.vel.y = Math.max(it.vel.y + GRAVITY * dt, -30);
      }
      it.onGround = false;
      const nx = p.x + it.vel.x * dt;
      if (this._solid(nx + Math.sign(it.vel.x) * SIZE, p.y + 0.05, p.z)) it.vel.x *= -0.3;
      else p.x = nx;
      const nz = p.z + it.vel.z * dt;
      if (this._solid(p.x, p.y + 0.05, nz + Math.sign(it.vel.z) * SIZE)) it.vel.z *= -0.3;
      else p.z = nz;
      const ny = p.y + it.vel.y * dt;
      if (it.vel.y <= 0 && this._solid(p.x, ny, p.z)) {
        p.y = Math.floor(ny) + 1;
        it.vel.y = 0;
        it.onGround = true;
      } else if (it.vel.y > 0 && this._solid(p.x, ny + SIZE * 2, p.z)) {
        it.vel.y = 0;
      } else {
        p.y = ny;
      }
      // Stuck inside a block (e.g. one was placed on it): pop up.
      if (this._solid(p.x, p.y + 0.05, p.z)) {
        p.y = Math.floor(p.y + 0.05) + 1;
        it.vel.y = 0;
      }
      if (it.onGround) {
        const f = Math.exp(-8 * dt);
        it.vel.x *= f;
        it.vel.z *= f;
      }
      if (p.y < -20) {
        this._remove(i);
        continue;
      }
      it.light = world.lightAt(p.x, p.y + 0.3, p.z);
      this._place(it);
    }

    // Merge identical nearby stacks every so often.
    this._mergeTimer += dt;
    if (this._mergeTimer > 0.5) {
      this._mergeTimer = 0;
      this._merge();
    }
  }

  _merge() {
    for (let i = 0; i < this.items.length; i++) {
      const a = this.items[i];
      if (a.dur !== undefined || a.count >= maxStack(a.id)) continue;
      for (let j = this.items.length - 1; j > i; j--) {
        const b = this.items[j];
        if (b.id !== a.id || b.dur !== undefined) continue;
        if (a.pos.distanceToSquared(b.pos) > 0.8 * 0.8) continue;
        const room = maxStack(a.id) - a.count;
        const n = Math.min(room, b.count);
        a.count += n;
        b.count -= n;
        if (b.count <= 0) this._remove(j);
        if (a.count >= maxStack(a.id)) break;
      }
    }
  }
}
