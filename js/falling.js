// Loose blocks (sand, gravel) fall when nothing solid is underneath them.
//
// Every edit batch reports its changed cells (World.onBlocksChanged); a
// loose block whose support is gone detaches together with the whole loose
// column resting on it, so a column falls as one and lands stacked. Falling
// blocks are entities with gravity that turn back into blocks where they
// land (or break into an item if they land in a torch's cell). To keep huge
// explosions cheap, only MAX_ACTIVE blocks animate at once; any further
// loose columns settle instantly with one batched edit.
import * as THREE from "three";
import { BLOCK, IS_SOLID, IS_REPLACEABLE, HAS_GRAVITY } from "./blocks.js";
import { itemModel } from "./models.js";
import { createEntityMaterial, bindEntityLight } from "./shaders.js";
import { WORLD_HEIGHT } from "./constants.js";

const GRAVITY = -26;
const MAX_FALL_SPEED = 40;
export const MAX_ACTIVE = 64;

export class FallingBlocks {
  constructor(scene, world) {
    this.world = world;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.material = createEntityMaterial("array", world.atlas);
    this.entities = [];
    this._pending = []; // flat [x, y, z, ...] cells to check
    this.settledInstantly = 0; // loose blocks moved without animation (stats / tests)
    this.onBreak = null; // (x, y, z, id): a falling block broke (landed in a torch's cell)
    world.onBlocksChanged = (changed) => this._notify(changed);
  }

  get active() {
    return this.entities.length;
  }

  // A changed cell may leave a loose block above it unsupported, and a
  // changed cell may itself now hold an unsupported loose block.
  _notify(changed) {
    const w = this.world;
    for (let i = 0; i < changed.length; i += 3) {
      const x = changed[i];
      const y = changed[i + 1];
      const z = changed[i + 2];
      if (HAS_GRAVITY[w.getBlock(x, y + 1, z)]) this._pending.push(x, y + 1, z);
      if (HAS_GRAVITY[w.getBlock(x, y, z)]) this._pending.push(x, y, z);
    }
  }

  _unsupported(x, y, z) {
    return y > 0 && !IS_SOLID[this.world.getBlock(x, y - 1, z)];
  }

  // Detaches loose columns whose support is gone.
  _processPending() {
    if (this._pending.length === 0) return;
    const w = this.world;
    const cells = this._pending;
    this._pending = [];
    const seen = new Set();
    const animate = []; // columns: [x, y0, z, ids[]]
    const settle = [];
    let budget = MAX_ACTIVE - this.entities.length;
    for (let i = 0; i < cells.length; i += 3) {
      const x = cells[i];
      let y = cells[i + 1];
      const z = cells[i + 2];
      if (!HAS_GRAVITY[w.getBlock(x, y, z)] || !this._unsupported(x, y, z)) continue;
      // The bottom of the loose run, then everything loose stacked on it.
      while (y > 0 && HAS_GRAVITY[w.getBlock(x, y - 1, z)]) y--;
      const key = `${x},${y},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ids = [];
      for (let yy = y; yy < WORLD_HEIGHT && HAS_GRAVITY[w.getBlock(x, yy, z)]; yy++) ids.push(w.getBlock(x, yy, z));
      if (ids.length <= budget) {
        animate.push([x, y, z, ids]);
        budget -= ids.length;
      } else {
        settle.push([x, y, z, ids]);
      }
    }
    if (animate.length) {
      const edits = [];
      for (const [x, y, z, ids] of animate) {
        for (let k = 0; k < ids.length; k++) {
          edits.push(x, y + k, z, BLOCK.AIR);
          this._spawn(ids[k], x, y + k, z);
        }
      }
      w.setBlocks(edits);
    }
    if (settle.length) this._settle(settle);
  }

  // Moves whole loose columns straight down to where they would land, in
  // one edit batch (no animation).
  _settle(columns) {
    const w = this.world;
    const clear = [];
    const place = [];
    for (const [x, y, z, ids] of columns) {
      let floor = y - 1;
      while (floor >= 0 && !IS_SOLID[w.getBlock(x, floor, z)]) floor--;
      const land = floor + 1;
      if (land === y) continue;
      for (let k = 0; k < ids.length; k++) clear.push(x, y + k, z, BLOCK.AIR);
      for (let k = 0; k < ids.length; k++) place.push(x, land + k, z, ids[k]);
      this.settledInstantly += ids.length;
    }
    // Clear first, then place, so a column that drops less than its own
    // height ends up correct.
    w.setBlocks(clear.concat(place));
  }

  _spawn(id, x, y, z) {
    const model = itemModel(id);
    const mesh = new THREE.Mesh(model.geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const e = { id, x, z, y, vy: 0, mesh, light: { sky: 15, block: 0 } };
    bindEntityLight(mesh, () => e.light);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.group.add(mesh);
    this.entities.push(e);
  }

  _remove(i) {
    this.group.remove(this.entities[i].mesh);
    this.entities.splice(i, 1);
  }

  clear() {
    while (this.entities.length) this._remove(this.entities.length - 1);
  }

  update(dt) {
    this._processPending();
    const w = this.world;
    const landed = [];
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (!w.getChunk(e.x >> 4, e.z >> 4)) {
        this._remove(i);
        continue;
      }
      e.vy = Math.max(e.vy + GRAVITY * dt, -MAX_FALL_SPEED);
      const ny = e.y + e.vy * dt;
      // Check every cell the bottom passes through this step, starting with
      // the one it's in (a block below may have just landed there).
      let land = null;
      for (let c = Math.floor(e.y); c >= Math.floor(ny); c--) {
        if (c < 0 || IS_SOLID[w.getBlock(e.x, c, e.z)]) {
          land = c + 1;
          break;
        }
      }
      if (land === null) {
        e.y = ny;
        e.light = w.lightAt(e.x + 0.5, e.y + 0.5, e.z + 0.5);
        e.mesh.position.y = e.y + 0.5;
        continue;
      }
      e.landY = land;
      landed.push(e);
      this._remove(i);
    }
    // Lowest first, so blocks landing in one column in the same step stack up.
    landed.sort((a, b) => a.landY - b.landY);
    for (const e of landed) this._land(e);
  }

  _land(e) {
    const w = this.world;
    // On top of the solid block found below (or of whatever landed on it first).
    let y = e.landY;
    while (y < WORLD_HEIGHT && IS_SOLID[w.getBlock(e.x, y, e.z)]) y++;
    if (y >= WORLD_HEIGHT) return;
    const here = w.getBlock(e.x, y, e.z);
    if (here === BLOCK.AIR || IS_REPLACEABLE[here]) w.setBlock(e.x, y, e.z, e.id);
    else if (this.onBreak) this.onBreak(e.x, y, e.z, e.id);
  }
}
