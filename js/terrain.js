// Procedural terrain generation (pure JS, no three.js). The height map and
// tree placement are unchanged from the first version of the game, so a
// given seed still produces the same landscape (and shared seed links keep
// working); newer features (caves, ores, plants) only add to it.
import { Noise, hash2, mulberry32 } from "./noise.js";
import { TreeGrower } from "./trees.js";
import { BLOCK } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from "./constants.js";

const BASE_HEIGHT = 26;
const AMPLITUDE = 14;
const PLANT_SALT = 0x5bd1e995;

// Caves: tunnels where two independent 3D noise fields are both near zero
// (their intersection forms long winding "spaghetti" worms), plus rare large
// caverns where a third field is high. Sampled on a coarse lattice and
// trilinearly interpolated (noise is the expensive part).
const CAVE_STEP = 4;
const TUNNEL_FREQ_XZ = 0.021;
const TUNNEL_FREQ_Y = 0.032;
const TUNNEL_WIDTH = 0.068;
const CAVERN_FREQ_XZ = 0.012;
const CAVERN_FREQ_Y = 0.022;
const CAVERN_THRESHOLD = 0.56;

// Ore veins: [block, veins per chunk, min size, max size, min y, max y].
const VEINS = [
  [BLOCK.COAL_ORE, 16, 3, 9, 5, 50],
  [BLOCK.IRON_ORE, 11, 3, 7, 3, 40],
  [BLOCK.GOLD_ORE, 3, 3, 6, 2, 22],
  [BLOCK.DIAMOND_ORE, 1.4, 2, 5, 1, 13],
  [BLOCK.GRAVEL, 5, 8, 16, 4, 45],
];

function hash3(seed, x, y, z) {
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 1103515245) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class TerrainGenerator {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.noise = new Noise(this.seed);
    this.caveNoise = new Noise((this.seed ^ 0x6a09e667) >>> 0);
    this.trees = new TreeGrower(this);
  }

  heightAt(wx, wz) {
    const n = this.noise.fbm2(wx, wz, 4, 0.5, 2, 1 / 80);
    return Math.floor(BASE_HEIGHT + n * AMPLITUDE);
  }

  // Where new players start: the first land column along a diagonal from the
  // origin, moved to the nearest land column that no tree stands in (so
  // nobody starts on top of a canopy). Returns [wx, wz].
  spawnColumn() {
    let bx = 0;
    let bz = 0;
    for (let i = 0; i < 10 && this.heightAt(bx, bz) <= SEA_LEVEL + 1; i++) {
      bx += 6;
      bz += 4;
    }
    for (let r = 0; r <= 16; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = bx + dx;
          const z = bz + dz;
          if (this.heightAt(x, z) > SEA_LEVEL + 1 && !this.trees.coversColumn(x, z)) return [x, z];
        }
      }
    }
    return [bx, bz];
  }

  // Whether the cave carver removes solid terrain at (wx, y, wz) above sea
  // level. Samples the same noise lattice as _carveCaves (lattice points sit
  // at world multiples of CAVE_STEP, stored as 32-bit floats there, so the
  // result is identical), which lets trees rooted in a neighbouring chunk
  // know whether their ground exists without generating that chunk.
  isCarved(wx, y, wz) {
    const n = this.caveNoise;
    const fx = wx / CAVE_STEP;
    const fy = y / CAVE_STEP;
    const fz = wz / CAVE_STEP;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const k = Math.floor(fz);
    const tx = fx - i;
    const ty = fy - j;
    const tz = fz - k;
    const sample = (fn) => {
      const at = (ii, jj, kk) => Math.fround(fn(ii * CAVE_STEP, jj * CAVE_STEP, kk * CAVE_STEP));
      const c00 = at(i, j, k) + (at(i + 1, j, k) - at(i, j, k)) * tx;
      const c10 = at(i, j, k + 1) + (at(i + 1, j, k + 1) - at(i, j, k + 1)) * tx;
      const c01 = at(i, j + 1, k) + (at(i + 1, j + 1, k) - at(i, j + 1, k)) * tx;
      const c11 = at(i, j + 1, k + 1) + (at(i + 1, j + 1, k + 1) - at(i, j + 1, k + 1)) * tx;
      const c0 = c00 + (c10 - c00) * tz;
      const c1 = c01 + (c11 - c01) * tz;
      return c0 + (c1 - c0) * ty;
    };
    const a = sample((x, yy, z) => n.perlin3(x * TUNNEL_FREQ_XZ, yy * TUNNEL_FREQ_Y, z * TUNNEL_FREQ_XZ));
    const b = sample((x, yy, z) => n.perlin3(x * TUNNEL_FREQ_XZ + 71.3, yy * TUNNEL_FREQ_Y - 33.1, z * TUNNEL_FREQ_XZ + 19.7));
    if (a * a + b * b < TUNNEL_WIDTH * TUNNEL_WIDTH) return true;
    if (y >= 34) return false;
    const c = sample((x, yy, z) => n.perlin3(x * CAVERN_FREQ_XZ - 51.9, yy * CAVERN_FREQ_Y + 12.4, z * CAVERN_FREQ_XZ - 83.2));
    return c > CAVERN_THRESHOLD + Math.max(0, y - 20) * 0.012;
  }

  // Fills a zeroed chunk.blocks array for the chunk at (chunk.cx, chunk.cz).
  generate(chunk) {
    const S = CHUNK_SIZE;
    const blocks = chunk.blocks;
    const baseX = chunk.cx * S;
    const baseZ = chunk.cz * S;
    const idx = (x, y, z) => (y * S + z) * S + x;

    // Heights for this chunk plus a 1-column border (needed by the cave rule below).
    const H = new Int16Array((S + 2) * (S + 2));
    const hAt = (lx, lz) => H[(lz + 1) * (S + 2) + (lx + 1)];
    for (let lz = -1; lz <= S; lz++) {
      for (let lx = -1; lx <= S; lx++) H[(lz + 1) * (S + 2) + (lx + 1)] = this.heightAt(baseX + lx, baseZ + lz);
    }

    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        const h = hAt(lx, lz);
        const isBeach = h <= SEA_LEVEL + 1;
        const top = Math.min(WORLD_HEIGHT - 1, Math.max(h, SEA_LEVEL));
        for (let y = 0; y <= top; y++) {
          let id;
          if (y > h) id = BLOCK.WATER;
          else if (y === h) id = isBeach ? BLOCK.SAND : BLOCK.GRASS;
          else if (y > h - 4) id = isBeach ? BLOCK.SAND : BLOCK.DIRT;
          else id = BLOCK.STONE;
          blocks[idx(lx, y, lz)] = id;
        }
        // Bedrock floor: solid at y=0, ragged at y=1.
        blocks[idx(lx, 0, lz)] = BLOCK.BEDROCK;
        if (hash3(this.seed, baseX + lx, 1, baseZ + lz) < 0.5) blocks[idx(lx, 1, lz)] = BLOCK.BEDROCK;
      }
    }

    this._carveCaves(blocks, baseX, baseZ, hAt);
    this._placeVeins(blocks, chunk.cx, chunk.cz);
    this._placeCrystals(blocks, baseX, baseZ);

    // Trees (trees.js): every tree whose crown or roots reach into this
    // chunk, including trees rooted in neighbouring chunks.
    this.trees.placeInChunk(blocks, chunk.cx, chunk.cz);

    // Ground cover: tall grass everywhere on grass, flowers in patches.
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        const h = hAt(lx, lz);
        if (h + 1 >= WORLD_HEIGHT) continue;
        const ground = idx(lx, h, lz);
        const above = idx(lx, h + 1, lz);
        if (blocks[ground] !== BLOCK.GRASS || blocks[above] !== BLOCK.AIR) continue;
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const r = hash2(this.seed ^ PLANT_SALT, wx, wz);
        const patch = this.noise.perlin2(wx * 0.045 + 31.7, wz * 0.045 - 12.3); // -0.7..0.7
        const flowerChance = Math.max(0, patch - 0.15) * 0.25;
        if (r < flowerChance) {
          blocks[above] = hash2(this.seed ^ 0x2f6b, wx, wz) < 0.5 ? BLOCK.FLOWER_RED : BLOCK.FLOWER_YELLOW;
        } else if (r < flowerChance + 0.11 + Math.max(0, -patch) * 0.1) {
          blocks[above] = BLOCK.TALL_GRASS;
        }
      }
    }
  }

  _carveCaves(blocks, baseX, baseZ, hAt) {
    const S = CHUNK_SIZE;
    const n = this.caveNoise;
    const NX = S / CAVE_STEP + 1;
    const NY = Math.ceil(WORLD_HEIGHT / CAVE_STEP) + 1;
    const lattice = (fn) => {
      const a = new Float32Array(NX * NY * NX);
      for (let j = 0; j < NY; j++) {
        for (let k = 0; k < NX; k++) {
          for (let i = 0; i < NX; i++) a[(j * NX + k) * NX + i] = fn(baseX + i * CAVE_STEP, j * CAVE_STEP, baseZ + k * CAVE_STEP);
        }
      }
      return a;
    };
    const A = lattice((x, y, z) => n.perlin3(x * TUNNEL_FREQ_XZ, y * TUNNEL_FREQ_Y, z * TUNNEL_FREQ_XZ));
    const B = lattice((x, y, z) => n.perlin3(x * TUNNEL_FREQ_XZ + 71.3, y * TUNNEL_FREQ_Y - 33.1, z * TUNNEL_FREQ_XZ + 19.7));
    const C = lattice((x, y, z) => n.perlin3(x * CAVERN_FREQ_XZ - 51.9, y * CAVERN_FREQ_Y + 12.4, z * CAVERN_FREQ_XZ - 83.2));
    const sample = (a, x, y, z) => {
      const fx = x / CAVE_STEP;
      const fy = y / CAVE_STEP;
      const fz = z / CAVE_STEP;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const k = Math.floor(fz);
      const tx = fx - i;
      const ty = fy - j;
      const tz = fz - k;
      const at = (ii, jj, kk) => a[(jj * NX + kk) * NX + ii];
      const c00 = at(i, j, k) + (at(i + 1, j, k) - at(i, j, k)) * tx;
      const c10 = at(i, j, k + 1) + (at(i + 1, j, k + 1) - at(i, j, k + 1)) * tx;
      const c01 = at(i, j + 1, k) + (at(i + 1, j + 1, k) - at(i, j + 1, k)) * tx;
      const c11 = at(i, j + 1, k + 1) + (at(i + 1, j + 1, k + 1) - at(i, j + 1, k + 1)) * tx;
      const c0 = c00 + (c10 - c00) * tz;
      const c1 = c01 + (c11 - c01) * tz;
      return c0 + (c1 - c0) * ty;
    };
    const w2 = TUNNEL_WIDTH * TUNNEL_WIDTH;
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        const h = hAt(lx, lz);
        // Water never flows in this game, so a cave cell must never touch
        // water: below sea level, only carve where this column and its four
        // neighbors have at least 2 blocks of ground above the cell.
        const m = Math.min(h, hAt(lx + 1, lz), hAt(lx - 1, lz), hAt(lx, lz + 1), hAt(lx, lz - 1));
        const top = Math.min(h, WORLD_HEIGHT - 1);
        for (let y = 2; y <= top; y++) {
          if (y <= SEA_LEVEL && y > m - 2) continue;
          const i = (y * S + lz) * S + lx;
          const id = blocks[i];
          if (id === BLOCK.AIR || id === BLOCK.WATER || id === BLOCK.BEDROCK) continue;
          const a = sample(A, lx, y, lz);
          const b = sample(B, lx, y, lz);
          let carve = a * a + b * b < w2;
          if (!carve && y < 34) carve = sample(C, lx, y, lz) > CAVERN_THRESHOLD + Math.max(0, y - 20) * 0.012;
          if (carve) blocks[i] = BLOCK.AIR;
        }
      }
    }
  }

  // Blobby ore/gravel veins made by short random walks through stone.
  _placeVeins(blocks, cx, cz) {
    const S = CHUNK_SIZE;
    const rand = mulberry32((this.seed ^ Math.imul(cx, 0x9e3779b1) ^ Math.imul(cz, 0x85ebca6b)) >>> 0);
    for (const [id, perChunk, minSize, maxSize, minY, maxY] of VEINS) {
      const count = Math.floor(perChunk) + (rand() < perChunk % 1 ? 1 : 0);
      for (let v = 0; v < count; v++) {
        let x = Math.floor(rand() * S);
        let y = minY + Math.floor(rand() * (maxY - minY + 1));
        let z = Math.floor(rand() * S);
        const size = minSize + Math.floor(rand() * (maxSize - minSize + 1));
        for (let k = 0; k < size; k++) {
          if (x >= 0 && x < S && z >= 0 && z < S && y >= 1 && y < WORLD_HEIGHT) {
            const i = (y * S + z) * S + x;
            if (blocks[i] === BLOCK.STONE) blocks[i] = id;
          }
          const axis = Math.floor(rand() * 3);
          const step = rand() < 0.5 ? -1 : 1;
          if (axis === 0) x += step;
          else if (axis === 1) y += step;
          else z += step;
        }
      }
    }
  }

  // Glowing Lumen crystals embedded in the ceilings of deep caves.
  _placeCrystals(blocks, baseX, baseZ) {
    const S = CHUNK_SIZE;
    for (let y = 3; y < 22; y++) {
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const i = (y * S + z) * S + x;
          if (blocks[i] !== BLOCK.AIR) continue;
          const above = i + S * S;
          if (blocks[above] !== BLOCK.STONE) continue;
          if (hash3(this.seed ^ 0x51ed27, baseX + x, y, baseZ + z) > 0.022) continue;
          blocks[above] = BLOCK.LUMEN;
          // A small cluster around it.
          if (x + 1 < S && blocks[above + 1] === BLOCK.STONE && hash3(this.seed, baseX + x, y + 1, baseZ + z) < 0.5) blocks[above + 1] = BLOCK.LUMEN;
          if (z + 1 < S && blocks[above + S] === BLOCK.STONE && hash3(this.seed, baseX + x, y + 2, baseZ + z) < 0.4) blocks[above + S] = BLOCK.LUMEN;
        }
      }
    }
  }
}
