// Voxel light engine: Minecraft-style flood-fill lighting with two channels
// per block, stored per chunk in `chunk.light` (Uint8Array, one byte per
// block): high nibble = sky light, low nibble = block light, each 0-15.
//
// Rules (shared with the brute-force reference in tools/unit-tests.mjs):
// - Opaque blocks hold no light (except emissive ones, which hold their own
//   emission) and never let light in.
// - Moving into a neighbor costs 1 level, plus the neighbor's lightFilter
//   (leaves, water).
// - Sky light at full strength (15) moving straight down into a "skyPass"
//   block (air, glass, plants) costs nothing, so open sky columns stay 15
//   all the way down. Above the top of the world is treated as sky 15.
// - Block light starts at each emissive block's emission level.
//
// Incremental updates use the classic two-phase BFS (removal, then
// re-propagation), processing a whole batch of block changes at once.
// Pure JS (no three.js), so it is unit-tested directly in Node.
import { CHUNK_SIZE, WORLD_HEIGHT } from "./constants.js";
import { IS_OPAQUE, LIGHT_FILTER, SKY_PASS, EMISSION } from "./blocks.js";

export const SKY = 0;
export const BLK = 1;

const H = WORLD_HEIGHT;
const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 1, -1, 0, 0];
const DZ = [0, 0, 0, 0, 1, -1];
const DOWN = 3;

if (CHUNK_SIZE !== 16) throw new Error("light.js assumes 16-wide chunks (bit arithmetic)");

// Growable FIFO of int32 values.
class IntQueue {
  constructor(capacity = 4096) {
    this.buf = new Int32Array(capacity);
    this.head = 0;
    this.tail = 0;
  }
  get empty() {
    return this.head === this.tail;
  }
  _grow(extra) {
    const live = this.tail - this.head;
    if (this.head > 0 && live + extra <= this.buf.length) {
      this.buf.copyWithin(0, this.head, this.tail);
    } else {
      const next = new Int32Array(Math.max(this.buf.length * 2, live + extra));
      next.set(this.buf.subarray(this.head, this.tail));
      this.buf = next;
    }
    this.head = 0;
    this.tail = live;
  }
  push3(a, b, c) {
    if (this.tail + 3 > this.buf.length) this._grow(3);
    const buf = this.buf;
    buf[this.tail] = a;
    buf[this.tail + 1] = b;
    buf[this.tail + 2] = c;
    this.tail += 3;
  }
  push4(a, b, c, d) {
    if (this.tail + 4 > this.buf.length) this._grow(4);
    const buf = this.buf;
    buf[this.tail] = a;
    buf[this.tail + 1] = b;
    buf[this.tail + 2] = c;
    buf[this.tail + 3] = d;
    this.tail += 4;
  }
  shift() {
    const v = this.buf[this.head++];
    if (this.head === this.tail) this.head = this.tail = 0;
    return v;
  }
}

function getLevel(chunk, idx, ch) {
  return ch === SKY ? chunk.light[idx] >> 4 : chunk.light[idx] & 15;
}

function setLevel(chunk, idx, ch, v) {
  const l = chunk.light;
  l[idx] = ch === SKY ? (l[idx] & 0x0f) | (v << 4) : (l[idx] & 0xf0) | v;
}

export class LightEngine {
  // world: anything with getChunk(cx, cz) -> chunk | undefined, where a
  // chunk has cx, cz, blocks (Uint8Array) and light (Uint8Array).
  constructor(world) {
    this.world = world;
    this.queue = new IntQueue();
    this.removeQueue = new IntQueue();
    // Chunks whose light changed (plus neighbors of changed border cells,
    // whose smooth lighting samples across the border) during the last call.
    this.changed = new Set();
    this._cx = 0;
    this._cz = 0;
    this._chunkCache = null;
    this._cacheValid = false;
  }

  _chunk(wx, wz) {
    const cx = wx >> 4;
    const cz = wz >> 4;
    if (!this._cacheValid || cx !== this._cx || cz !== this._cz) {
      this._cx = cx;
      this._cz = cz;
      this._chunkCache = this.world.getChunk(cx, cz) || null;
      this._cacheValid = true;
    }
    return this._chunkCache;
  }

  _begin() {
    this._cacheValid = false; // chunks may have loaded/unloaded since last call
    this.changed.clear();
  }

  _markChanged(chunk, lx, lz) {
    this.changed.add(chunk);
    if (lx !== 0 && lx !== 15 && lz !== 0 && lz !== 15) return;
    const dx = lx === 0 ? -1 : lx === 15 ? 1 : 0;
    const dz = lz === 0 ? -1 : lz === 15 ? 1 : 0;
    const w = this.world;
    let n;
    if (dx !== 0 && (n = w.getChunk(chunk.cx + dx, chunk.cz))) this.changed.add(n);
    if (dz !== 0 && (n = w.getChunk(chunk.cx, chunk.cz + dz))) this.changed.add(n);
    if (dx !== 0 && dz !== 0 && (n = w.getChunk(chunk.cx + dx, chunk.cz + dz))) this.changed.add(n);
  }

  // Spreads light outward from every queued cell (x, y, z) on channel `ch`.
  _propagate(ch) {
    const q = this.queue;
    while (!q.empty) {
      const x = q.shift();
      const y = q.shift();
      const z = q.shift();
      const c = this._chunk(x, z);
      if (!c) continue;
      const level = getLevel(c, (y << 8) | ((z & 15) << 4) | (x & 15), ch);
      if (level <= 1) continue;
      for (let d = 0; d < 6; d++) {
        const ny = y + DY[d];
        if (ny < 0 || ny >= H) continue;
        const nx = x + DX[d];
        const nz = z + DZ[d];
        const nc = this._chunk(nx, nz);
        if (!nc) continue;
        const nidx = (ny << 8) | ((nz & 15) << 4) | (nx & 15);
        const id = nc.blocks[nidx];
        if (IS_OPAQUE[id]) continue;
        const cost = ch === SKY && d === DOWN && level === 15 && SKY_PASS[id] ? 0 : 1 + LIGHT_FILTER[id];
        const nl = level - cost;
        if (nl > getLevel(nc, nidx, ch)) {
          setLevel(nc, nidx, ch, nl);
          this._markChanged(nc, nx & 15, nz & 15);
          q.push3(nx, ny, nz);
        }
      }
    }
  }

  // Removes light that depended on the queued cells (x, y, z, oldLevel),
  // queueing the boundary cells that are lit from elsewhere for
  // re-propagation.
  _remove(ch) {
    const rq = this.removeQueue;
    const q = this.queue;
    while (!rq.empty) {
      const x = rq.shift();
      const y = rq.shift();
      const z = rq.shift();
      const level = rq.shift();
      for (let d = 0; d < 6; d++) {
        const ny = y + DY[d];
        if (ny < 0 || ny >= H) continue;
        const nx = x + DX[d];
        const nz = z + DZ[d];
        const nc = this._chunk(nx, nz);
        if (!nc) continue;
        const nidx = (ny << 8) | ((nz & 15) << 4) | (nx & 15);
        const nl = getLevel(nc, nidx, ch);
        if (nl === 0) continue;
        // A dimmer neighbor was (possibly) lit through this cell; a full-sky
        // cell straight below a full-sky cell was lit by that column.
        if (nl < level || (ch === SKY && d === DOWN && level === 15 && nl === 15)) {
          setLevel(nc, nidx, ch, 0);
          this._markChanged(nc, nx & 15, nz & 15);
          rq.push4(nx, ny, nz, nl);
          if (ch === BLK) {
            const e = EMISSION[nc.blocks[nidx]];
            if (e > 0) {
              // Light sources keep their own light; re-seed them.
              setLevel(nc, nidx, ch, e);
              q.push3(nx, ny, nz);
            }
          }
        } else {
          q.push3(nx, ny, nz); // lit from elsewhere: it will refill the gap
        }
      }
    }
  }

  // Computes light for a freshly generated chunk (blocks already filled),
  // including light flowing in from and out to already-lit loaded
  // neighbors. Returns the set of *other* chunks whose light changed.
  initChunk(chunk) {
    this._begin();
    const L = chunk.light;
    const B = chunk.blocks;
    L.fill(0);
    const baseX = chunk.cx * 16;
    const baseZ = chunk.cz * 16;

    // --- Sky light, straight-down column pass. ---
    // tops[column] = lowest y of the column's unbroken full-sky (15) run.
    const tops = new Int16Array(256);
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        let level = 15;
        let top = H;
        for (let y = H - 1; y >= 0; y--) {
          const idx = (y << 8) | (lz << 4) | lx;
          const id = B[idx];
          if (IS_OPAQUE[id]) break;
          if (!(level === 15 && SKY_PASS[id])) level -= 1 + LIGHT_FILTER[id];
          if (level <= 0) break;
          if (level === 15) top = y;
          L[idx] = level << 4;
        }
        tops[(lz << 4) | lx] = top;
      }
    }

    // --- Seeds for sideways spreading. ---
    // A full-sky cell can only light something dimmer if a horizontally
    // adjacent column's full-sky run starts higher up; cells attenuated by
    // leaves/water can spread too.
    const q = this.queue;
    const neighborTop = (lx, lz) => {
      if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) return tops[(lz << 4) | lx];
      const nc = this._chunk(baseX + lx, baseZ + lz);
      if (!nc) return -1; // unloaded: nothing to spread into
      const ix = lx & 15;
      const iz = lz & 15;
      let y = H - 1;
      while (y >= 0 && nc.light[(y << 8) | (iz << 4) | ix] >> 4 === 15) y--;
      return y + 1;
    };
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const top = tops[(lz << 4) | lx];
        const maxN = Math.max(neighborTop(lx + 1, lz), neighborTop(lx - 1, lz), neighborTop(lx, lz + 1), neighborTop(lx, lz - 1));
        const wx = baseX + lx;
        const wz = baseZ + lz;
        for (let y = top; y < maxN; y++) q.push3(wx, y, wz);
        for (let y = top - 1; y >= 0; y--) {
          if (L[(y << 8) | (lz << 4) | lx] >> 4 <= 1) break; // levels only fall going down
          q.push3(wx, y, wz);
        }
      }
    }
    this._pushInflow(chunk, SKY);
    this._propagate(SKY);

    // --- Block light from emitters in this chunk. ---
    for (let idx = 0; idx < L.length; idx++) {
      const e = EMISSION[B[idx]];
      if (e > 0) {
        L[idx] = (L[idx] & 0xf0) | e;
        q.push3(baseX + (idx & 15), idx >> 8, baseZ + ((idx >> 4) & 15));
      }
    }
    this._pushInflow(chunk, BLK);
    this._propagate(BLK);

    this.changed.delete(chunk);
    return this.changed;
  }

  // Queues the border cells of loaded neighbor chunks that could light a
  // dimmer cell just inside `chunk`.
  _pushInflow(chunk, ch) {
    const q = this.queue;
    const sides = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [sx, sz] of sides) {
      const nc = this.world.getChunk(chunk.cx + sx, chunk.cz + sz);
      if (!nc) continue;
      for (let i = 0; i < 16; i++) {
        // (nlx, nlz): the neighbor's border column; (lx, lz): ours beside it.
        const nlx = sx === 1 ? 0 : sx === -1 ? 15 : i;
        const nlz = sz === 1 ? 0 : sz === -1 ? 15 : i;
        const lx = sx === 1 ? 15 : sx === -1 ? 0 : i;
        const lz = sz === 1 ? 15 : sz === -1 ? 0 : i;
        for (let y = 0; y < H; y++) {
          const nidx = (y << 8) | (nlz << 4) | nlx;
          const nl = getLevel(nc, nidx, ch);
          if (nl <= 1) continue;
          const idx = (y << 8) | (lz << 4) | lx;
          if (IS_OPAQUE[chunk.blocks[idx]]) continue;
          if (getLevel(chunk, idx, ch) < nl - 1) q.push3(nc.cx * 16 + nlx, y, nc.cz * 16 + nlz);
        }
      }
    }
  }

  // Updates light after a batch of block changes. The blocks must already
  // be set in their chunks; `changes` is a flat [x, y, z, x, y, z, ...]
  // array of world coordinates. Returns the set of chunks whose light
  // changed (including neighbors of changed border cells).
  applyChanges(changes) {
    this._begin();
    for (const ch of [SKY, BLK]) {
      const rq = this.removeQueue;
      const q = this.queue;
      // 1. Remove whatever light the changed cells held.
      for (let i = 0; i < changes.length; i += 3) {
        const x = changes[i];
        const y = changes[i + 1];
        const z = changes[i + 2];
        const c = this._chunk(x, z);
        if (!c || y < 0 || y >= H) continue;
        const idx = (y << 8) | ((z & 15) << 4) | (x & 15);
        const old = getLevel(c, idx, ch);
        if (old > 0) {
          setLevel(c, idx, ch, 0);
          this._markChanged(c, x & 15, z & 15);
          rq.push4(x, y, z, old);
        }
      }
      this._remove(ch);

      // 2. Seed new light: new emitters, and light flowing into any changed
      //    cell that now lets light through.
      for (let i = 0; i < changes.length; i += 3) {
        const x = changes[i];
        const y = changes[i + 1];
        const z = changes[i + 2];
        const c = this._chunk(x, z);
        if (!c || y < 0 || y >= H) continue;
        const idx = (y << 8) | ((z & 15) << 4) | (x & 15);
        const id = c.blocks[idx];
        if (ch === BLK && EMISSION[id] > 0) {
          if (EMISSION[id] > getLevel(c, idx, ch)) {
            setLevel(c, idx, ch, EMISSION[id]);
            this._markChanged(c, x & 15, z & 15);
          }
          q.push3(x, y, z);
        }
        if (IS_OPAQUE[id]) continue;
        if (ch === SKY && y === H - 1) {
          const v = SKY_PASS[id] ? 15 : 14 - LIGHT_FILTER[id];
          if (v > getLevel(c, idx, ch)) {
            setLevel(c, idx, ch, v);
            this._markChanged(c, x & 15, z & 15);
            q.push3(x, y, z);
          }
        }
        for (let d = 0; d < 6; d++) {
          const ny = y + DY[d];
          if (ny < 0 || ny >= H) continue;
          const nx = x + DX[d];
          const nz = z + DZ[d];
          const nc = this._chunk(nx, nz);
          if (nc && getLevel(nc, (ny << 8) | ((nz & 15) << 4) | (nx & 15), ch) > 1) q.push3(nx, ny, nz);
        }
      }
      this._propagate(ch);
    }
    return this.changed;
  }
}

// Reads the light at a world position from a world (getChunk). Returns
// { sky, block } levels (0-15); unloaded or out-of-range cells read as open sky.
export function sampleLight(world, x, y, z) {
  if (y >= H) return { sky: 15, block: 0 };
  if (y < 0) return { sky: 0, block: 0 };
  const c = world.getChunk(x >> 4, z >> 4);
  if (!c) return { sky: 15, block: 0 };
  const v = c.light[(y << 8) | ((z & 15) << 4) | (x & 15)];
  return { sky: v >> 4, block: v & 15 };
}
