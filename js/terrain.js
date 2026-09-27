// Procedural terrain generation (pure JS, no three.js). The height map and
// tree placement are unchanged from the first version of the game, so a
// given seed still produces the same landscape (and shared seed links keep
// working); newer features only add to it.
import { Noise, hash2 } from "./noise.js";
import { BLOCK } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from "./constants.js";

const BASE_HEIGHT = 26;
const AMPLITUDE = 14;
const TREE_CHANCE = 0.02;
const PLANT_SALT = 0x5bd1e995;

export class TerrainGenerator {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.noise = new Noise(this.seed);
  }

  heightAt(wx, wz) {
    const n = this.noise.fbm2(wx, wz, 4, 0.5, 2, 1 / 80);
    return Math.floor(BASE_HEIGHT + n * AMPLITUDE);
  }

  // Fills a zeroed chunk.blocks array for the chunk at (chunk.cx, chunk.cz).
  generate(chunk) {
    const blocks = chunk.blocks;
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    const heights = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const h = this.heightAt(baseX + lx, baseZ + lz);
        heights[lz * CHUNK_SIZE + lx] = h;
        const isBeach = h <= SEA_LEVEL + 1;
        const top = Math.min(WORLD_HEIGHT - 1, Math.max(h, SEA_LEVEL));
        for (let y = 0; y <= top; y++) {
          let id;
          if (y > h) id = BLOCK.WATER;
          else if (y === h) id = isBeach ? BLOCK.SAND : BLOCK.GRASS;
          else if (y > h - 4) id = isBeach ? BLOCK.SAND : BLOCK.DIRT;
          else id = BLOCK.STONE;
          blocks[(y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx] = id;
        }
      }
    }

    // Trees: only rooted well inside the chunk so canopies never cross chunk borders.
    for (let lz = 3; lz < CHUNK_SIZE - 3; lz++) {
      for (let lx = 3; lx < CHUNK_SIZE - 3; lx++) {
        const h = heights[lz * CHUNK_SIZE + lx];
        if (h <= SEA_LEVEL + 1 || h >= WORLD_HEIGHT - 10) continue;
        const r = hash2(this.seed, baseX + lx, baseZ + lz);
        if (r >= TREE_CHANCE) continue;
        this._placeTree(blocks, lx, h, lz, r);
      }
    }

    // Ground cover: tall grass everywhere on grass, flowers in patches.
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const h = heights[lz * CHUNK_SIZE + lx];
        if (h + 1 >= WORLD_HEIGHT) continue;
        const ground = (h * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
        const above = ground + CHUNK_SIZE * CHUNK_SIZE;
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

  _placeTree(blocks, lx, h, lz, r) {
    const S = CHUNK_SIZE;
    const set = (x, y, z, id) => {
      if (x < 0 || x >= S || z < 0 || z >= S || y < 0 || y >= WORLD_HEIGHT) return;
      blocks[(y * S + z) * S + x] = id;
    };
    const get = (x, y, z) => blocks[(y * S + z) * S + x];
    const trunkHeight = 4 + (Math.floor(r * 30000) % 3);
    for (let i = 1; i <= trunkHeight; i++) set(lx, h + i, lz, BLOCK.WOOD);
    const canopyCenterY = h + trunkHeight;
    for (let dy = -2; dy <= 1; dy++) {
      const radius = dy >= 1 ? 1 : 2;
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (dx * dx + dz * dz > radius * radius + 0.5) continue;
          const y = canopyCenterY + dy;
          if (y < 0 || y >= WORLD_HEIGHT) continue;
          if (get(lx + dx, y, lz + dz) === BLOCK.AIR) set(lx + dx, y, lz + dz, BLOCK.LEAVES);
        }
      }
    }
  }
}
