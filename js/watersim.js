// Flowing water: source blocks (the vast, untouched lakes/oceans/rivers the
// terrain generator paints) plus flowing water that spreads sideways and
// falls into holes, the way it does in Minecraft. Fixes water blocks left
// floating in mid-air after a block under them is dug out or blown away.
//
// Only "active" water is simulated: a block edit anywhere near water wakes
// the water touching it (World.changeListeners), and only woken cells sit in
// a queue, processed a bounded number per frame (see update()). The vast
// majority of the world's water is never touched and costs nothing.
//
// Original terrain water (never touched by the sim) behaves as an infinite
// source. Water the simulation itself creates by flowing remembers exactly
// which neighbor it flowed from (its "parent") and a level (0 = fed by a
// source or by falling water, up to MAX_FLOW_DISTANCE sideways from one).
// Drying up checks only that one parent cell, never a neighbor's cached
// level: that's what keeps a cut-off flow from "propping itself up" by
// borrowing support from a cell that only ever existed because of it in the
// first place (the same class of bug a naive flood-fill removal hits, and
// the reason the voxel light engine two-phases its own removal).
import { BLOCK, IS_REPLACEABLE } from "./blocks.js";
import { WORLD_HEIGHT } from "./constants.js";

export const MAX_FLOW_DISTANCE = 4; // sideways reach of a flow from its source, in blocks
const BUDGET_PER_FRAME = 300;

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class WaterSim {
  constructor(world) {
    this.world = world;
    this.active = new Set(); // "x,y,z" keys due for a tick
    this.meta = new Map(); // "x,y,z" -> { level, parent: [x,y,z] } for sim-made flow cells
    this.processed = 0; // cells ticked (stats / tests)
    world.changeListeners.push((changed, opts) => this._onEdit(changed, opts));
  }

  get activeCount() {
    return this.active.size;
  }

  _key(x, y, z) {
    return `${x},${y},${z}`;
  }

  // A changed cell may expose water to a new hole (beside or below it), or
  // be a water cell itself (placed, or laid bare by a removed neighbor).
  // recordEdit: false means the batch is out-of-band scaffolding (test
  // arenas, world setup), not a real player/explosion edit, so water leaves
  // it alone.
  _onEdit(changed, { recordEdit = true } = {}) {
    if (!recordEdit) return;
    for (let i = 0; i < changed.length; i += 3) {
      const x = changed[i];
      const y = changed[i + 1];
      const z = changed[i + 2];
      this._wake(x, y, z);
      this._wakeAround(x, y, z);
    }
  }

  _wakeAround(x, y, z) {
    this._wake(x + 1, y, z);
    this._wake(x - 1, y, z);
    this._wake(x, y + 1, z);
    this._wake(x, y - 1, z);
    this._wake(x, y, z + 1);
    this._wake(x, y, z - 1);
  }

  _wake(x, y, z) {
    if (this.world.getBlock(x, y, z) === BLOCK.WATER) this.active.add(this._key(x, y, z));
  }

  // Processes up to `budget` active cells; any cells still needing another
  // look stay (or get re-added) for the next call.
  update(budget = BUDGET_PER_FRAME) {
    if (this.active.size === 0) return;
    let n = 0;
    for (const key of this.active) {
      if (n >= budget) break;
      n++;
      this.active.delete(key);
      this._tick(key);
    }
    this.processed += n;
  }

  _tick(key) {
    const world = this.world;
    const [x, y, z] = key.split(",").map(Number);
    if (!world.getChunk(x >> 4, z >> 4) || world.getBlock(x, y, z) !== BLOCK.WATER) {
      this.meta.delete(key);
      return;
    }
    const info = this.meta.get(key); // absent = untouched terrain water (an infinite source)
    let level = 0;
    if (info) {
      const [px, py, pz] = info.parent;
      if (world.getBlock(px, py, pz) !== BLOCK.WATER) {
        // Its one and only support is gone: dry up, and let whatever this
        // cell itself was supporting find out about it in turn.
        world.setBlock(x, y, z, BLOCK.AIR);
        this.meta.delete(key);
        this._wakeAround(x, y, z);
        return;
      }
      level = info.level;
    }

    // Fall: an open cell directly below becomes full-strength falling water.
    if (y > 0) {
      const belowId = world.getBlock(x, y - 1, z);
      if (belowId !== BLOCK.WATER && IS_REPLACEABLE[belowId]) this._place(x, y - 1, z, 0, [x, y, z]);
    }

    // Spread sideways into open cells, one level weaker each step, up to the
    // flow's reach.
    if (level < MAX_FLOW_DISTANCE) {
      for (const [dx, dz] of SIDES) {
        const nx = x + dx;
        const nz = z + dz;
        const id = world.getBlock(nx, y, nz);
        if (id === BLOCK.WATER || !IS_REPLACEABLE[id]) continue;
        this._place(nx, y, nz, level + 1, [x, y, z]);
      }
    }
  }

  _place(x, y, z, level, parent) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const world = this.world;
    if (!world.getChunk(x >> 4, z >> 4)) return;
    const key = this._key(x, y, z);
    const id = world.getBlock(x, y, z);
    if (id === BLOCK.WATER) {
      const cur = this.meta.get(key);
      const curLevel = cur ? cur.level : 0;
      if (level < curLevel) {
        this.meta.set(key, { level, parent });
        this.active.add(key);
      }
      return;
    }
    if (IS_REPLACEABLE[id]) {
      world.setBlock(x, y, z, BLOCK.WATER);
      this.meta.set(key, { level, parent });
      this.active.add(key);
    }
  }
}
