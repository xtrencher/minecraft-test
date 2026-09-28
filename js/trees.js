// Procedural trees: where they grow, which species, and their shapes. Pure
// JS (no three.js), shared by terrain generation, the distant-terrain
// worker and the unit tests.
//
// Species:
//   oak      a short trunk under an irregular crown of 2-3 overlapping blobs,
//            sometimes with a branch reaching into a side blob
//   birch    a tall, slender white trunk with a narrow crown
//   pine     a tall dark trunk with tiered, tapering rings of needles (on
//            high ground and in pine groves)
//   old oak  rare, in dense forests: a 2x2 trunk, roots spreading over the
//            ground, big crooked branches and a huge crown
// Forests and meadows follow a low-frequency noise field; birches and pines
// grow in groves, and pines also take over high ground. Trees keep a minimum distance from each
// other (the one with the lower placement hash wins, which is symmetric and
// needs no generation order). Crowns may reach across chunk borders: every
// chunk places all trees whose reach overlaps it, in one fixed order, so
// each chunk gets exactly its share of every tree.
import { hash2, mulberry32 } from "./noise.js";
import { BLOCK } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from "./constants.js";
import { BIOME } from "./biomes.js";

export const TREE = Object.freeze({ OAK: 1, BIRCH: 2, PINE: 3, OLD_OAK: 4, WILLOW: 5 });
export const TREE_NAMES = { 1: "oak", 2: "birch", 3: "pine", 4: "old oak", 5: "willow" };
// No block of a tree is farther than this from its root column.
export const TREE_REACH = 9;

const PLACE_SALT = 0x2c1b3c6d;
const KIND_SALT = 0x297a2d39;
const MAX_DENSITY = 0.026;
const SPACING = { 1: 2, 2: 2, 3: 2, 4: 5, 5: 3 };

// Biomes with no trees at all.
const NO_TREE_BIOMES = new Set([BIOME.DESERT, BIOME.BADLANDS, BIOME.SNOWY_PLAINS, BIOME.MOUNTAINS, BIOME.BEACH, BIOME.OCEAN, BIOME.WARM_OCEAN, BIOME.DEEP_OCEAN, BIOME.RIVER]);
// Density multiplier per biome (<=1, since MAX_DENSITY is the global cap):
// open savanna and plains are sparse, swamps sparser still, jungles and dark
// forests are the densest.
const BIOME_DENSITY = {
  [BIOME.JUNGLE]: 1,
  [BIOME.DARK_FOREST]: 0.95,
  [BIOME.FOREST]: 0.7,
  [BIOME.BIRCH_FOREST]: 0.7,
  [BIOME.TAIGA]: 0.65,
  [BIOME.SNOWY_TAIGA]: 0.5,
  [BIOME.SWAMP]: 0.32,
  [BIOME.PLAINS]: 0.4,
  [BIOME.SAVANNA]: 0.14,
};
const LOG = { 1: BLOCK.WOOD, 2: BLOCK.BIRCH_LOG, 3: BLOCK.PINE_LOG, 4: BLOCK.WOOD, 5: BLOCK.WILLOW_LOG };
const LEAF = { 1: BLOCK.LEAVES, 2: BLOCK.BIRCH_LEAVES, 3: BLOCK.PINE_LEAVES, 4: BLOCK.LEAVES, 5: BLOCK.WILLOW_LEAVES };
// Branches and roots show bark all round (no sawn-off rings).
const BARK = { 1: BLOCK.OAK_BARK, 2: BLOCK.BIRCH_LOG, 3: BLOCK.PINE_LOG, 4: BLOCK.OAK_BARK, 5: BLOCK.WILLOW_LOG };

// Small integer hash in [0, 1) for per-voxel jitter.
function hash3(seed, x, y, z) {
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 1103515245) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class TreeGrower {
  // terrain: the TerrainGenerator (heightAt, isCarved, noise).
  constructor(terrain) {
    this.terrain = terrain;
    this.seed = terrain.seed;
    this.noise = terrain.noise;
    this._roots = new Map(); // "x,z" -> root or null (cache)
    this._shapes = new Map(); // "x,z" -> flat [dx, dy, dz, id, ...] (cache)
  }

  // Trees per column here: open areas with none, sparse single trees, and
  // dense forests, following a low-frequency noise field.
  _density(wx, wz) {
    const forest = this.noise.perlin2(wx * 0.011 + 17.3, wz * 0.011 - 9.1);
    const t = Math.min(1, Math.max(0, (forest + 0.12) / 0.62));
    const density = t <= 0 ? 0 : 0.0006 + (MAX_DENSITY - 0.0006) * t * t * (3 - 2 * t);
    return { density, forest };
  }

  // A column that may hold a tree (before spacing and ground checks):
  // { r, species, h } or null.
  _candidate(wx, wz) {
    const r = hash2((this.seed ^ PLACE_SALT) >>> 0, wx, wz);
    if (r >= MAX_DENSITY) return null;
    const h = this.terrain.heightAt(wx, wz);
    if (h <= SEA_LEVEL + 1 || h >= WORLD_HEIGHT - 16) return null;
    const biome = this.terrain.biomeAt(wx, wz);
    if (NO_TREE_BIOMES.has(biome)) return null;
    const { density, forest } = this._density(wx, wz);
    const scaled = density * (BIOME_DENSITY[biome] ?? 1);
    if (scaled <= 0 || r >= scaled) return null;
    const k = hash2((this.seed ^ KIND_SALT) >>> 0, wx, wz);
    let species = TREE.OAK;
    if (biome === BIOME.TAIGA || biome === BIOME.SNOWY_TAIGA) species = TREE.PINE;
    else if (biome === BIOME.BIRCH_FOREST) species = TREE.BIRCH;
    else if (biome === BIOME.SWAMP) species = TREE.WILLOW;
    else if (biome === BIOME.DARK_FOREST && k < 0.22) species = TREE.OLD_OAK;
    else if ((biome === BIOME.FOREST || biome === BIOME.PLAINS) && forest > 0.28 && k < 0.12) species = TREE.OLD_OAK;
    return { r, species, h, biome };
  }

  // The tree rooted in column (wx, wz): { x, z, h, species, log, leaf } or null.
  rootAt(wx, wz) {
    // Most columns are rejected by their hash alone (no caching needed).
    if (hash2((this.seed ^ PLACE_SALT) >>> 0, wx, wz) >= MAX_DENSITY) return null;
    const key = `${wx},${wz}`;
    if (this._roots.has(key)) return this._roots.get(key);
    let root = null;
    const c = this._candidate(wx, wz);
    if (c && !this.terrain.isCarved(wx, c.h, wz)) {
      // Keep clear of stronger neighbours (lower hash wins).
      let clear = true;
      const R = SPACING[TREE.OLD_OAK];
      for (let dz = -R; dz <= R && clear; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx === 0 && dz === 0) continue;
          const d2 = dx * dx + dz * dz;
          if (d2 > R * R) continue;
          const o = this._candidate(wx + dx, wz + dz);
          if (!o) continue;
          const need = Math.max(SPACING[c.species], SPACING[o.species]);
          if (d2 <= need * need && (o.r < c.r || (o.r === c.r && (dx < 0 || (dx === 0 && dz < 0))))) {
            clear = false;
            break;
          }
        }
      }
      if (clear) root = { x: wx, z: wz, h: c.h, species: c.species, biome: c.biome, log: LOG[c.species], bark: BARK[c.species], leaf: LEAF[c.species] };
    }
    if (this._roots.size > 20000) this._roots.clear();
    this._roots.set(key, root);
    return root;
  }

  // Blocks of a tree, relative to the block above its ground: flat
  // Int8Array [dx, dy, dz, id, ...]. dy = -1 is the ground block itself (roots).
  shape(root) {
    const key = `${root.x},${root.z}`;
    let s = this._shapes.get(key);
    if (s) return s;
    const rand = mulberry32((this.seed ^ Math.imul(root.x, 0x9e3779b1) ^ Math.imul(root.z, 0x85ebca6b) ^ 0x51f15e) >>> 0);
    const out = [];
    const log = root.log;
    const bark = root.bark;
    const leaf = root.leaf;
    const blobs = [];
    const jitterSeed = (this.seed ^ Math.imul(root.x, 7919) ^ Math.imul(root.z, 104729)) | 0;
    // Branch: logs from `from` stepping toward `to` (inclusive of the end).
    const branch = (fx, fy, fz, tx, ty, tz) => {
      const n = Math.max(Math.abs(tx - fx), Math.abs(tz - fz), Math.abs(ty - fy));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        out.push(Math.round(fx + (tx - fx) * t), Math.round(fy + (ty - fy) * t), Math.round(fz + (tz - fz) * t), bark);
      }
    };
    let trunkTop = 0;
    if (root.species === TREE.OAK) {
      const T = 4 + Math.floor(rand() * 3);
      trunkTop = T;
      for (let y = 0; y < T; y++) out.push(0, y, 0, log);
      const cy = T - 1 + rand() * 0.6;
      blobs.push({ x: 0, y: cy, z: 0, rx: 2.3 + rand() * 0.9, ry: 1.9 + rand() * 0.6, rz: 2.3 + rand() * 0.9 });
      const extra = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < extra; i++) {
        const a = rand() * Math.PI * 2;
        const d = 1.4 + rand() * 1.0;
        const b = { x: Math.cos(a) * d, y: cy - 0.6 + rand() * 1.2, z: Math.sin(a) * d, rx: 1.6 + rand() * 0.7, ry: 1.5 + rand() * 0.5, rz: 1.6 + rand() * 0.7 };
        blobs.push(b);
        if (rand() < 0.6) branch(0, T - 2, 0, Math.round(b.x * 0.8), Math.round(b.y - 0.5), Math.round(b.z * 0.8));
      }
    } else if (root.species === TREE.BIRCH) {
      const T = 6 + Math.floor(rand() * 3);
      trunkTop = T;
      for (let y = 0; y < T; y++) out.push(0, y, 0, log);
      const r = 1.5 + rand() * 0.6;
      blobs.push({ x: 0, y: T - 1.2, z: 0, rx: r, ry: 2.6 + rand() * 0.8, rz: r });
      if (rand() < 0.5) {
        const a = rand() * Math.PI * 2;
        blobs.push({ x: Math.cos(a) * 1.2, y: T - 2.6, z: Math.sin(a) * 1.2, rx: 1.2, ry: 1.2, rz: 1.2 });
      }
    } else if (root.species === TREE.PINE) {
      const T = 8 + Math.floor(rand() * 4);
      trunkTop = T;
      for (let y = 0; y < T; y++) out.push(0, y, 0, log);
      const rmax = 2.5 + rand() * 0.9;
      const base = 2 + Math.floor(rand() * 2);
      for (let y = base; y <= T + 1; y++) {
        const t = (y - base) / (T + 1 - base);
        const tier = (y - base) % 2 === 0 ? 1 : 0.68;
        const radius = (rmax * (1 - t) + 0.45) * tier;
        const R = Math.ceil(radius);
        for (let dz = -R; dz <= R; dz++) {
          for (let dx = -R; dx <= R; dx++) {
            if (dx === 0 && dz === 0 && y < T) continue;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d <= radius + (hash3(jitterSeed, dx, y, dz) - 0.5) * 0.5) out.push(dx, y, dz, leaf);
          }
        }
      }
      out.push(0, T, 0, leaf, 0, T + 1, 0, leaf, 0, T + 2, 0, leaf);
    } else if (root.species === TREE.WILLOW) {
      // A short, gently leaning trunk under a broad, drooping crown.
      const T = 5 + Math.floor(rand() * 2);
      trunkTop = T;
      const lean = rand() < 0.5 ? 1 : -1;
      for (let y = 0; y < T; y++) out.push(Math.round((y / (T - 1)) * lean), y, 0, log);
      const topX = lean;
      const r = 2.7 + rand() * 0.8;
      blobs.push({ x: topX, y: T - 0.5, z: 0, rx: r, ry: 1.7 + rand() * 0.4, rz: r });
      blobs.push({ x: topX, y: T + 0.7, z: 0, rx: r * 0.65, ry: 1.2, rz: r * 0.65 });
    } else {
      // Old oak: a 2x2 trunk, roots, crooked branches, a huge crown.
      const T = 7 + Math.floor(rand() * 3);
      trunkTop = T;
      for (let y = 0; y < T; y++) for (let k = 0; k < 4; k++) out.push(k & 1, y, k >> 1, log);
      const roots = 4 + Math.floor(rand() * 3);
      for (let i = 0; i < roots; i++) {
        const a = ((i + rand() * 0.6) / roots) * Math.PI * 2;
        const len = 2 + Math.floor(rand() * 3);
        for (let s = 1; s <= len; s++) {
          const px = Math.round(0.5 + Math.cos(a) * (1 + s));
          const pz = Math.round(0.5 + Math.sin(a) * (1 + s));
          out.push(px, -1, pz, bark);
          if (s === 1) out.push(px, 0, pz, bark);
        }
      }
      const branches = 3 + Math.floor(rand() * 3);
      for (let i = 0; i < branches; i++) {
        const a = ((i + rand() * 0.7) / branches) * Math.PI * 2;
        const y0 = T - 4 + Math.floor(rand() * 3);
        const len = 3 + Math.floor(rand() * 3);
        let px = 0.5;
        let py = y0;
        let pz = 0.5;
        for (let s = 0; s < len; s++) {
          px += Math.cos(a);
          pz += Math.sin(a);
          py += 0.45 + rand() * 0.35;
          out.push(Math.round(px - 0.5), Math.round(py), Math.round(pz - 0.5), bark);
        }
        const r = 2.0 + rand() * 0.8;
        blobs.push({ x: px - 0.5, y: py + 0.8, z: pz - 0.5, rx: r, ry: r * 0.75, rz: r });
      }
      blobs.push({ x: 0.5, y: T + 0.5, z: 0.5, rx: 3.3 + rand() * 1.0, ry: 2.3 + rand() * 0.6, rz: 3.3 + rand() * 1.0 });
    }
    // Leaves: the union of the blobs, with ragged, noisy edges and a few
    // gaps near the surface.
    if (blobs.length > 0) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const b of blobs) {
        x0 = Math.min(x0, Math.floor(b.x - b.rx));
        x1 = Math.max(x1, Math.ceil(b.x + b.rx));
        y0 = Math.min(y0, Math.floor(b.y - b.ry));
        y1 = Math.max(y1, Math.ceil(b.y + b.ry));
        z0 = Math.min(z0, Math.floor(b.z - b.rz));
        z1 = Math.max(z1, Math.ceil(b.z + b.rz));
      }
      y0 = Math.max(y0, Math.min(2, trunkTop - 1));
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            let e = Infinity;
            for (const b of blobs) {
              const dx = (x - b.x) / b.rx;
              const dy = (y - b.y) / b.ry;
              const dz = (z - b.z) / b.rz;
              e = Math.min(e, dx * dx + dy * dy + dz * dz);
            }
            const j = hash3(jitterSeed, x, y, z);
            if (e + j * 0.45 >= 1.05) continue;
            if (e > 0.6 && hash3(jitterSeed ^ 0x3a5, x, y, z) < 0.1) continue;
            out.push(x, y, z, leaf);
          }
        }
      }
      if (root.species === TREE.WILLOW) {
        // Weeping strands: leaves draping from the crown's edge toward the water.
        const strands = 12 + Math.floor(rand() * 8);
        const crown = blobs[0];
        for (let i = 0; i < strands; i++) {
          const a = rand() * Math.PI * 2;
          const d = (0.55 + rand() * 0.45) * crown.rx;
          const sx = Math.round(crown.x + Math.cos(a) * d);
          const sz = Math.round(crown.z + Math.sin(a) * d);
          const sy0 = Math.round(crown.y);
          const len = 2 + Math.floor(rand() * 4);
          for (let k = 1; k <= len; k++) out.push(sx, sy0 - k, sz, leaf);
        }
      }
      if ((root.biome === BIOME.JUNGLE || root.biome === BIOME.SWAMP) && root.species !== TREE.WILLOW) {
        // Hanging vines/lianas under jungle and swamp canopies.
        const vines = 3 + Math.floor(rand() * 4);
        for (let i = 0; i < vines; i++) {
          const b = blobs[Math.floor(rand() * blobs.length)];
          const a = rand() * Math.PI * 2;
          const d = rand() * b.rx;
          const vx = Math.round(b.x + Math.cos(a) * d);
          const vz = Math.round(b.z + Math.sin(a) * d);
          const vy0 = Math.round(b.y - b.ry * 0.5);
          const len = 2 + Math.floor(rand() * 4);
          for (let k = 1; k <= len; k++) out.push(vx, vy0 - k, vz, BLOCK.VINE);
        }
      }
    }
    s = Int8Array.from(out); // offsets and ids are small: 4 bytes per block
    if (this._shapes.size > 600) this._shapes.clear();
    this._shapes.set(key, s);
    return s;
  }

  // Places every tree that reaches into chunk (cx, cz). Logs may replace
  // air, leaves and plants (and the ground block itself for roots); leaves
  // only fill air. Trees are applied in a fixed order (by root position), so
  // overlaps come out the same in every chunk.
  placeInChunk(blocks, cx, cz) {
    const S = CHUNK_SIZE;
    const bx = cx * S;
    const bz = cz * S;
    const R = TREE_REACH;
    const roots = [];
    for (let wz = bz - R; wz < bz + S + R; wz++) {
      for (let wx = bx - R; wx < bx + S + R; wx++) {
        const root = this.rootAt(wx, wz);
        if (root) roots.push(root);
      }
    }
    roots.sort((a, b) => a.x - b.x || a.z - b.z);
    for (const root of roots) {
      const shape = this.shape(root);
      const ox = root.x - bx;
      const oz = root.z - bz;
      const oy = root.h + 1;
      for (let i = 0; i < shape.length; i += 4) {
        const x = ox + shape[i];
        const z = oz + shape[i + 2];
        if (x < 0 || x >= S || z < 0 || z >= S) continue;
        const y = oy + shape[i + 1];
        if (y < 1 || y >= WORLD_HEIGHT) continue;
        const idx = (y * S + z) * S + x;
        const cur = blocks[idx];
        const id = shape[i + 3];
        if (id === root.leaf) {
          if (cur === BLOCK.AIR) blocks[idx] = id;
        } else if (shape[i + 1] === -1) {
          // Roots run through the ground's top block, never through the air.
          if (cur === BLOCK.GRASS || cur === BLOCK.DIRT) blocks[idx] = id;
        } else if (cur === BLOCK.AIR || isLeafOrPlant(cur)) {
          blocks[idx] = id;
        }
      }
    }
  }

  // Whether any tree (trunk, roots or crown) stands in column (wx, wz): used
  // to keep the world spawn off tree tops.
  coversColumn(wx, wz) {
    const R = TREE_REACH;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const root = this.rootAt(wx + dx, wz + dz);
        if (!root) continue;
        const s = this.shape(root);
        for (let i = 0; i < s.length; i += 4) if (s[i] === -dx && s[i + 2] === -dz) return true;
      }
    }
    return false;
  }

  // Rough crown of a tree for distant terrain: { cy, rx, ry, top } in blocks
  // relative to the block above the ground (see lod-mesher.js).
  crown(root) {
    if (root.crown) return root.crown;
    const shape = this.shape(root);
    let lo = Infinity;
    let hi = -Infinity;
    let r = 0;
    for (let i = 0; i < shape.length; i += 4) {
      if (shape[i + 3] !== root.leaf) continue;
      lo = Math.min(lo, shape[i + 1]);
      hi = Math.max(hi, shape[i + 1]);
      r = Math.max(r, Math.abs(shape[i] + 0.5 - (root.species === TREE.OLD_OAK ? 1 : 0.5)), Math.abs(shape[i + 2] + 0.5 - (root.species === TREE.OLD_OAK ? 1 : 0.5)));
    }
    root.crown = { bottom: lo, top: hi + 1, radius: Math.max(1, r * 0.85) };
    return root.crown;
  }
}

function isLeafOrPlant(id) {
  return (
    id === BLOCK.LEAVES || id === BLOCK.BIRCH_LEAVES || id === BLOCK.PINE_LEAVES || id === BLOCK.WILLOW_LEAVES ||
    id === BLOCK.TALL_GRASS || id === BLOCK.FLOWER_RED || id === BLOCK.FLOWER_YELLOW || id === BLOCK.VINE
  );
}
