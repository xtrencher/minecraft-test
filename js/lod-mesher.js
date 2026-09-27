// Distant terrain (level of detail): simplified meshes of the landscape
// beyond the fully detailed chunks. Pure JS (no three.js), so it runs in a
// Web Worker (lod-worker.js), or on the main thread as a fallback, and can
// be unit-tested in Node.
//
// A tile at level L (1, 2, 3, ...) is LOD_CELLS x LOD_CELLS square cells of
// 2^L x 2^L blocks, so it covers 2^(L+1) x 2^(L+1) chunks. Each cell is one
// blocky column at the ground height sampled at the cell's centre (from the
// terrain generator, plus any player edits there): a flat top, and walls
// down to lower neighbours, so distant land keeps the voxel look. Water is a
// flat surface at the drawn water level that carries its depth (the shader
// colours it like real water). Trees are boxes on levels 1-3; farther out
// they're a tint of the grass. Every tile border gets a deep "skirt" wall,
// so tiles of different levels, and the detailed chunks, never leave gaps.
//
// Output (per tile, positions relative to the tile's corner):
//   position Float32 x3
//   color    Uint8   x4  [sRGB r, g, b, ambient occlusion] (normalized)
//   info     Uint8   x4  [normal index (as in the chunk mesher), kind, water depth, 0]
//   index    Uint16/Uint32
import { TerrainGenerator } from "./terrain.js";
import { BLOCK, IS_SOLID } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from "./constants.js";
import { WATER_SURFACE_HEIGHT } from "./mesher.js";

export const LOD_CELLS = 32;
// Trees are drawn as boxes up to this level; beyond, they only tint the grass.
export const LOD_TREE_MAX_LEVEL = 3;
// The resting water surface (see js/water.js: the waves average out to this).
export const LOD_WATER_TOP = SEA_LEVEL + WATER_SURFACE_HEIGHT - 0.06;
export const LOD_KIND = Object.freeze({ LAND: 0, WATER: 1, LEAVES: 2 });

// Blocks across one tile at `level`.
export function tileSpan(level) {
  return LOD_CELLS << level;
}

// Chunks across one tile at `level`.
export function tileChunks(level) {
  return (LOD_CELLS << level) / CHUNK_SIZE;
}

// Tree canopy coverage of grassland (about 16% of the ground is under
// leaves, more when seen at a low angle), used to tint grass where trees
// aren't drawn.
const FAR_TREE_TINT = 0.28;
const EDIT_CACHE_MAX = 256;

// Terrain columns for LOD sampling: the generator's height map, plus the
// real blocks of chunks the player has edited (so a crater stays visible
// from afar).
export class LodTerrain {
  constructor(seed) {
    this.terrain = new TerrainGenerator(seed);
    this.edits = new Map(); // "cx,cz" -> flat [blockIndex, id, ...]
    this._edited = new Map(); // "cx,cz" -> { blocks, top, id, depth } (cache, LRU order)
  }

  // Replaces the recorded edits of one chunk (an empty list clears them).
  setChunkEdits(key, list) {
    if (list && list.length > 0) this.edits.set(key, list);
    else this.edits.delete(key);
    this._edited.delete(key);
  }

  _editedChunk(cx, cz) {
    const key = cx + "," + cz;
    const list = this.edits.get(key);
    if (!list) return null;
    let c = this._edited.get(key);
    if (c) return c;
    const S = CHUNK_SIZE;
    const blocks = new Uint8Array(S * WORLD_HEIGHT * S);
    this.terrain.generate({ cx, cz, blocks });
    for (let i = 0; i < list.length; i += 2) blocks[list[i]] = list[i + 1];
    const top = new Float32Array(S * S);
    const id = new Uint8Array(S * S);
    const depth = new Uint8Array(S * S);
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        const col = lz * S + lx;
        top[col] = 1;
        id[col] = BLOCK.BEDROCK;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const b = blocks[(y * S + lz) * S + lx];
          // Trees are drawn separately; plants and torches are too small.
          if (b === BLOCK.AIR || b === BLOCK.LEAVES || b === BLOCK.WOOD) continue;
          if (b !== BLOCK.WATER && !IS_SOLID[b]) continue;
          if (b === BLOCK.WATER) {
            let d = 0;
            while (y - d >= 0 && blocks[((y - d) * S + lz) * S + lx] === BLOCK.WATER) d++;
            top[col] = y + (LOD_WATER_TOP - SEA_LEVEL);
            depth[col] = Math.min(255, d);
          } else {
            top[col] = y + 1;
          }
          id[col] = b;
          break;
        }
      }
    }
    c = { blocks, top, id, depth };
    this._edited.set(key, c);
    if (this._edited.size > EDIT_CACHE_MAX) this._edited.delete(this._edited.keys().next().value);
    return c;
  }

  // The visible surface of column (wx, wz): out.top (y of the top face),
  // out.id (its block) and out.depth (water depth, 0 on land).
  sample(wx, wz, out) {
    if (this.edits.size > 0) {
      const c = this._editedChunk(wx >> 4, wz >> 4);
      if (c) {
        const col = (wz & 15) * CHUNK_SIZE + (wx & 15);
        out.top = c.top[col];
        out.id = c.id[col];
        out.depth = c.depth[col];
        return out;
      }
    }
    const h = this.terrain.heightAt(wx, wz);
    if (h < SEA_LEVEL) {
      out.top = LOD_WATER_TOP;
      out.id = BLOCK.WATER;
      out.depth = SEA_LEVEL - h;
    } else {
      out.top = h + 1;
      out.id = h <= SEA_LEVEL + 1 ? BLOCK.SAND : BLOCK.GRASS;
      out.depth = 0;
    }
    return out;
  }

  // Trunk height of the tree rooted at (wx, wz), or 0 (also 0 once the
  // player has cut it down or blown it up).
  treeAt(wx, wz) {
    const t = this.terrain.treeAt(wx, wz);
    if (t === 0 || this.edits.size === 0) return t;
    const c = this._editedChunk(wx >> 4, wz >> 4);
    if (!c) return t;
    const h = this.terrain.heightAt(wx, wz);
    return c.blocks[((h + 1) * CHUNK_SIZE + (wz & 15)) * CHUNK_SIZE + (wx & 15)] === BLOCK.WOOD ? t : 0;
  }
}

// Growable vertex/index buffers.
class MeshOut {
  constructor() {
    this.cap = 4096;
    this.n = 0; // vertices
    this.position = new Float32Array(this.cap * 3);
    this.color = new Uint8Array(this.cap * 4);
    this.info = new Uint8Array(this.cap * 4);
    this.minY = Infinity;
    this.maxY = -Infinity;
  }

  _grow() {
    this.cap *= 2;
    const p = new Float32Array(this.cap * 3);
    p.set(this.position);
    this.position = p;
    const c = new Uint8Array(this.cap * 4);
    c.set(this.color);
    this.color = c;
    const f = new Uint8Array(this.cap * 4);
    f.set(this.info);
    this.info = f;
  }

  vertex(x, y, z, rgb, ao, normal, kind, depth) {
    if (this.n === this.cap) this._grow();
    const i = this.n++;
    this.position[i * 3] = x;
    this.position[i * 3 + 1] = y;
    this.position[i * 3 + 2] = z;
    this.color[i * 4] = rgb[0];
    this.color[i * 4 + 1] = rgb[1];
    this.color[i * 4 + 2] = rgb[2];
    this.color[i * 4 + 3] = ao;
    this.info[i * 4] = normal;
    this.info[i * 4 + 1] = kind;
    this.info[i * 4 + 2] = depth;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  // Horizontal top face (normal +y) over [xa, xb] x [za, zb] at height y.
  top(xa, xb, za, zb, y, rgb, kind, depth) {
    this.vertex(xa, y, za, rgb, 255, 2, kind, depth);
    this.vertex(xa, y, zb, rgb, 255, 2, kind, depth);
    this.vertex(xb, y, zb, rgb, 255, 2, kind, depth);
    this.vertex(xb, y, za, rgb, 255, 2, kind, depth);
  }

  // Vertical wall facing +x/-x (normal 0/1) at x, over [za, zb] x [ya, yb].
  wallX(normal, x, za, zb, ya, yb, rgb, aoLow, kind, depth) {
    if (normal === 0) {
      this.vertex(x, ya, za, rgb, aoLow, 0, kind, depth);
      this.vertex(x, yb, za, rgb, 255, 0, kind, depth);
      this.vertex(x, yb, zb, rgb, 255, 0, kind, depth);
      this.vertex(x, ya, zb, rgb, aoLow, 0, kind, depth);
    } else {
      this.vertex(x, ya, za, rgb, aoLow, 1, kind, depth);
      this.vertex(x, ya, zb, rgb, aoLow, 1, kind, depth);
      this.vertex(x, yb, zb, rgb, 255, 1, kind, depth);
      this.vertex(x, yb, za, rgb, 255, 1, kind, depth);
    }
  }

  // Vertical wall facing +z/-z (normal 4/5) at z, over [xa, xb] x [ya, yb].
  wallZ(normal, z, xa, xb, ya, yb, rgb, aoLow, kind, depth) {
    if (normal === 4) {
      this.vertex(xa, ya, z, rgb, aoLow, 4, kind, depth);
      this.vertex(xb, ya, z, rgb, aoLow, 4, kind, depth);
      this.vertex(xb, yb, z, rgb, 255, 4, kind, depth);
      this.vertex(xa, yb, z, rgb, 255, 4, kind, depth);
    } else {
      this.vertex(xa, ya, z, rgb, aoLow, 5, kind, depth);
      this.vertex(xa, yb, z, rgb, 255, 5, kind, depth);
      this.vertex(xb, yb, z, rgb, 255, 5, kind, depth);
      this.vertex(xb, ya, z, rgb, aoLow, 5, kind, depth);
    }
  }

  // A box without its bottom face.
  box(xa, xb, ya, yb, za, zb, rgbTop, rgbSide, kind, aoLow) {
    this.top(xa, xb, za, zb, yb, rgbTop, kind, 0);
    this.wallX(0, xb, za, zb, ya, yb, rgbSide, aoLow, kind, 0);
    this.wallX(1, xa, za, zb, ya, yb, rgbSide, aoLow, kind, 0);
    this.wallZ(4, zb, xa, xb, ya, yb, rgbSide, aoLow, kind, 0);
    this.wallZ(5, za, xa, xb, ya, yb, rgbSide, aoLow, kind, 0);
  }

  finish() {
    const n = this.n;
    const quads = n / 4;
    const index = n > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      const i = q * 6;
      index[i] = v;
      index[i + 1] = v + 1;
      index[i + 2] = v + 2;
      index[i + 3] = v;
      index[i + 4] = v + 2;
      index[i + 5] = v + 3;
    }
    return {
      position: this.position.slice(0, n * 3),
      color: this.color.slice(0, n * 4),
      info: this.info.slice(0, n * 4),
      index,
      vertexCount: n,
      minY: n > 0 ? this.minY : 0,
      maxY: n > 0 ? this.maxY : 0,
    };
  }
}

function toSrgbByte(v) {
  const c = Math.max(0, Math.min(1, v));
  return Math.round(Math.pow(c, 1 / 2.2) * 255);
}

// palette: { top: Float32Array(256 * 3), side: Float32Array(256 * 3) } with
// each block's average texture colour (linear 0-1). Returns per-id sRGB
// byte triplets, plus the tinted "grass with trees" colour.
export function makeLodPalette(palette) {
  const top = [];
  const side = [];
  for (let id = 0; id < 256; id++) {
    const t = [palette.top[id * 3], palette.top[id * 3 + 1], palette.top[id * 3 + 2]];
    const s = [palette.side[id * 3], palette.side[id * 3 + 1], palette.side[id * 3 + 2]];
    top.push(t.map(toSrgbByte));
    side.push(s.map(toSrgbByte));
  }
  const g = BLOCK.GRASS * 3;
  const l = BLOCK.LEAVES * 3;
  const forest = [0, 1, 2].map((k) => toSrgbByte(palette.top[g + k] * (1 - FAR_TREE_TINT) + palette.top[l + k] * 0.8 * FAR_TREE_TINT));
  return { top, side, forest };
}

const _s = { top: 0, id: 0, depth: 0 };

// Builds the mesh for tile (tx, tz) at `level`. pal: from makeLodPalette.
export function buildLodTile(lt, level, tx, tz, pal) {
  const N = LOD_CELLS;
  const P = N + 2; // with a one-cell border of neighbours
  const step = 1 << level;
  const span = N * step;
  const x0 = tx * span;
  const z0 = tz * span;
  const half = step >> 1;
  const top = new Float32Array(P * P);
  const id = new Uint8Array(P * P);
  const depth = new Uint8Array(P * P);
  let lowest = Infinity;
  for (let j = 0; j < P; j++) {
    for (let i = 0; i < P; i++) {
      lt.sample(x0 + (i - 1) * step + half, z0 + (j - 1) * step + half, _s);
      const k = j * P + i;
      top[k] = _s.top;
      id[k] = _s.id;
      depth[k] = Math.min(15, _s.depth);
      if (_s.top < lowest) lowest = _s.top;
    }
  }
  // Skirts reach well below anything a neighbouring (finer) tile can show
  // near the border.
  const skirtBottom = Math.max(0, Math.floor(lowest) - step - 3);
  const trees = level <= LOD_TREE_MAX_LEVEL;
  const cellTop = (k) => (id[k] === BLOCK.GRASS && !trees ? pal.forest : pal.top[id[k]]);
  const kindOf = (k) => (id[k] === BLOCK.WATER ? LOD_KIND.WATER : LOD_KIND.LAND);
  const out = new MeshOut();

  // Tops, merged along x into runs of equal height and surface.
  for (let j = 0; j < N; j++) {
    let i = 0;
    while (i < N) {
      const k = (j + 1) * P + i + 1;
      let e = i + 1;
      while (e < N) {
        const k2 = (j + 1) * P + e + 1;
        if (top[k2] !== top[k] || id[k2] !== id[k] || depth[k2] !== depth[k]) break;
        e++;
      }
      out.top(i * step, e * step, j * step, (j + 1) * step, top[k], cellTop(k), kindOf(k), depth[k]);
      i = e;
    }
  }

  // Walls down to lower neighbours; at the tile border, skirts. Runs of
  // cells with identical walls are merged along the border direction.
  const wall = (k, nk, border) => {
    const y = top[k];
    if (border) return skirtBottom < y ? skirtBottom : null;
    const ny = top[nk];
    return ny < y ? ny : null;
  };
  const aoFor = (ya, yb) => Math.round(255 * (yb - ya <= 1.5 ? 0.62 : 0.62 + Math.min(0.3, (yb - ya - 1.5) * 0.05)));
  // +x / -x walls: for each cell column i, runs along z.
  for (const dir of [1, -1]) {
    const normal = dir > 0 ? 0 : 1;
    for (let i = 0; i < N; i++) {
      const border = dir > 0 ? i === N - 1 : i === 0;
      const x = (dir > 0 ? i + 1 : i) * step;
      let j = 0;
      while (j < N) {
        const k = (j + 1) * P + i + 1;
        const bottom = wall(k, k + dir, border);
        if (bottom === null) {
          j++;
          continue;
        }
        let e = j + 1;
        while (e < N) {
          const k2 = (e + 1) * P + i + 1;
          if (top[k2] !== top[k] || id[k2] !== id[k] || depth[k2] !== depth[k] || wall(k2, k2 + dir, border) !== bottom) break;
          e++;
        }
        const water = id[k] === BLOCK.WATER;
        const rgb = water ? pal.top[id[k]] : pal.side[id[k]];
        out.wallX(normal, x, j * step, e * step, bottom, top[k], rgb, aoFor(bottom, top[k]), kindOf(k), depth[k]);
        j = e;
      }
    }
  }
  // +z / -z walls: for each cell row j, runs along x.
  for (const dir of [1, -1]) {
    const normal = dir > 0 ? 4 : 5;
    for (let j = 0; j < N; j++) {
      const border = dir > 0 ? j === N - 1 : j === 0;
      const z = (dir > 0 ? j + 1 : j) * step;
      let i = 0;
      while (i < N) {
        const k = (j + 1) * P + i + 1;
        const bottom = wall(k, k + dir * P, border);
        if (bottom === null) {
          i++;
          continue;
        }
        let e = i + 1;
        while (e < N) {
          const k2 = (j + 1) * P + e + 1;
          if (top[k2] !== top[k] || id[k2] !== id[k] || depth[k2] !== depth[k] || wall(k2, k2 + dir * P, border) !== bottom) break;
          e++;
        }
        const water = id[k] === BLOCK.WATER;
        const rgb = water ? pal.top[id[k]] : pal.side[id[k]];
        out.wallZ(normal, z, i * step, e * step, bottom, top[k], rgb, aoFor(bottom, top[k]), kindOf(k), depth[k]);
        i = e;
      }
    }
  }

  // Trees: canopy boxes standing on the cell they grow in (a trunk too on
  // the nearest level). Only chunk-interior columns can hold a tree root.
  if (trees) {
    const leafTop = pal.top[BLOCK.LEAVES];
    const leafSide = pal.side[BLOCK.LEAVES];
    const wood = pal.side[BLOCK.WOOD];
    const inset = 0.25;
    for (let wz = z0; wz < z0 + span; wz++) {
      const lz = wz & 15;
      if (lz < 3 || lz >= CHUNK_SIZE - 3) continue;
      for (let wx = x0; wx < x0 + span; wx++) {
        const lx = wx & 15;
        if (lx < 3 || lx >= CHUNK_SIZE - 3) continue;
        const trunk = lt.treeAt(wx, wz);
        if (trunk === 0) continue;
        const i = Math.floor((wx - x0) / step);
        const j = Math.floor((wz - z0) / step);
        const k = (j + 1) * P + i + 1;
        if (id[k] === BLOCK.WATER) continue;
        const base = top[k];
        const x = wx - x0;
        const z = wz - z0;
        // Canopy: a 5x5 block of leaves 3 high, with a 3x3 cap on top (too
        // small to matter on the farthest tree level).
        out.box(x - 2 + inset, x + 3 - inset, base + trunk - 3, base + trunk, z - 2 + inset, z + 3 - inset, leafTop, leafSide, LOD_KIND.LEAVES, 190);
        if (level < LOD_TREE_MAX_LEVEL) out.box(x - 1 + inset, x + 2 - inset, base + trunk, base + trunk + 1, z - 1 + inset, z + 2 - inset, leafTop, leafSide, LOD_KIND.LEAVES, 210);
        if (level === 1) out.box(x + 0.3, x + 0.7, base, base + trunk - 3, z + 0.3, z + 0.7, wood, wood, LOD_KIND.LAND, 160);
      }
    }
  }

  const mesh = out.finish();
  mesh.level = level;
  mesh.tx = tx;
  mesh.tz = tz;
  mesh.x0 = x0;
  mesh.z0 = z0;
  mesh.span = span;
  return mesh;
}
