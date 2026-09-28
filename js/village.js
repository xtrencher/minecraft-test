// Villages: a rare, deterministic structure (simple houses, paths and a
// small farm plot) placed like a giant "tree" — pure logic, chunk-spanning,
// no player/mob code here (see mobs.js for the villagers that walk around
// one once the player gets close). One village per world grid cell, at most,
// decided by a hash so no chunk needs to generate to know where they are.
import { hash2, mulberry32 } from "./noise.js";
import { BLOCK } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from "./constants.js";
import { BIOME } from "./biomes.js";

const CELL = 320; // world grid cell size a village candidate is picked from
const CHANCE = 0.35; // fraction of cells that actually get a village
const PAD_RADIUS = 15; // the flattened pad reaches this far from the center
export const VILLAGE_REACH = PAD_RADIUS + 2;
const GOOD_BIOMES = new Set([BIOME.PLAINS, BIOME.SAVANNA, BIOME.FOREST, BIOME.BIRCH_FOREST, BIOME.DESERT]);

const CENTER_SALT = 0x6a1f3c9b;
const PLACE_SALT = 0x2d84af11;

export class VillageGrower {
  // terrain: the TerrainGenerator (heightAt, biomeAt).
  constructor(terrain) {
    this.terrain = terrain;
    this.seed = terrain.seed;
    this._centers = new Map(); // "cellX,cellZ" -> center or null (cache)
    this._shapes = new Map(); // "x,z" -> flat [dx, dy, dz, id, ...]
  }

  _cellCenter(cellX, cellZ) {
    const key = `${cellX},${cellZ}`;
    if (this._centers.has(key)) return this._centers.get(key);
    let center = null;
    if (hash2((this.seed ^ CENTER_SALT) >>> 0, cellX, cellZ) < CHANCE) {
      const jx = hash2((this.seed ^ PLACE_SALT) >>> 0, cellX, cellZ);
      const jz = hash2((this.seed ^ PLACE_SALT ^ 0x9e37) >>> 0, cellX, cellZ);
      const x = cellX * CELL + Math.floor(jx * (CELL - VILLAGE_REACH * 2)) + VILLAGE_REACH;
      const z = cellZ * CELL + Math.floor(jz * (CELL - VILLAGE_REACH * 2)) + VILLAGE_REACH;
      const h = this.terrain.heightAt(x, z);
      const biome = this.terrain.biomeAt(x, z);
      if (h > SEA_LEVEL + 2 && GOOD_BIOMES.has(biome)) center = { x, z, groundY: h };
    }
    this._centers.set(key, center);
    if (this._centers.size > 400) this._centers.clear();
    return center;
  }

  // Every village whose reach could overlap a box from (x0,z0) to (x1,z1).
  _villagesNear(x0, z0, x1, z1) {
    const out = [];
    const c0x = Math.floor((x0 - VILLAGE_REACH) / CELL);
    const c1x = Math.floor((x1 + VILLAGE_REACH) / CELL);
    const c0z = Math.floor((z0 - VILLAGE_REACH) / CELL);
    const c1z = Math.floor((z1 + VILLAGE_REACH) / CELL);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const c = this._cellCenter(cx, cz);
        if (c) out.push(c);
      }
    }
    return out;
  }

  // The nearest village within maxDist of (wx, wz), or null. Used by the mob
  // system to spawn villagers once the player is close to one.
  nearestVillage(wx, wz, maxDist) {
    let best = null;
    let bestD = maxDist * maxDist;
    for (const c of this._villagesNear(wx - maxDist, wz - maxDist, wx + maxDist, wz + maxDist)) {
      const d = (c.x - wx) ** 2 + (c.z - wz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // Blocks of a village, relative to (center.x, center.groundY, center.z):
  // flat [dx, dy, dz, id, ...]. dy=0 is the pad surface itself.
  shape(center) {
    const key = `${center.x},${center.z}`;
    let s = this._shapes.get(key);
    if (s) return s;
    const rand = mulberry32((this.seed ^ Math.imul(center.x, 0x9e3779b1) ^ Math.imul(center.z, 0x85ebca6b) ^ 0x76a3) >>> 0);
    const out = [];
    // The flattened pad: grass (or sand in the desert), gravel paths in a
    // cross through the middle.
    const sandy = this.terrain.biomeAt(center.x, center.z) === BIOME.DESERT;
    const padTop = sandy ? BLOCK.SAND : BLOCK.GRASS;
    const padFill = sandy ? BLOCK.SAND : BLOCK.DIRT;
    for (let dz = -PAD_RADIUS; dz <= PAD_RADIUS; dz++) {
      for (let dx = -PAD_RADIUS; dx <= PAD_RADIUS; dx++) {
        if (dx * dx + dz * dz > PAD_RADIUS * PAD_RADIUS) continue;
        const onPath = Math.abs(dx) <= 1 || Math.abs(dz) <= 1;
        out.push(dx, 0, dz, onPath ? BLOCK.GRAVEL : padTop);
        for (let dy = -6; dy < 0; dy++) out.push(dx, dy, dz, padFill);
        for (let dy = 1; dy <= 9; dy++) out.push(dx, dy, dz, BLOCK.AIR);
      }
    }
    // Two simple houses, doors facing the middle.
    house(out, -9, -9, "z+");
    house(out, 4, 4, "z-");
    // A small farm patch: tilled dirt with scattered "crop" tall grass.
    for (let dz = 6; dz <= 9; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        out.push(dx, 0, dz, BLOCK.DIRT);
        if (rand() < 0.75) out.push(dx, 1, dz, BLOCK.TALL_GRASS);
      }
    }
    s = Int16Array.from(out);
    if (this._shapes.size > 200) this._shapes.clear();
    this._shapes.set(key, s);
    return s;
  }

  // Places every village that overlaps chunk (cx, cz).
  placeInChunk(blocks, cx, cz) {
    const S = CHUNK_SIZE;
    const bx = cx * S;
    const bz = cz * S;
    const idx = (x, y, z) => (y * S + z) * S + x;
    for (const center of this._villagesNear(bx, bz, bx + S, bz + S)) {
      const shape = this.shape(center);
      for (let i = 0; i < shape.length; i += 4) {
        const wx = center.x + shape[i];
        const wz = center.z + shape[i + 2];
        const lx = wx - bx;
        const lz = wz - bz;
        if (lx < 0 || lx >= S || lz < 0 || lz >= S) continue;
        const y = center.groundY + shape[i + 1];
        if (y < 1 || y >= WORLD_HEIGHT) continue;
        blocks[idx(lx, y, lz)] = shape[i + 3];
      }
    }
  }

  // The nearest village center a mob spawner (or debug overlay) can use, or
  // null; a thin, more convenient wrapper over nearestVillage.
  villageBounds(center) {
    return { x: center.x, z: center.z, radius: PAD_RADIUS };
  }
}

// A 6x6 house footprint (walls y 1-4, a stepped roof above), with a doorway
// on the given side facing the village middle. `ox, oz` is the corner
// (minimum x/z) of the footprint, relative to the village center.
function house(out, ox, oz, doorSide) {
  const W = 6;
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < W; z++) {
      const edge = x === 0 || x === W - 1 || z === 0 || z === W - 1;
      if (!edge) continue;
      const isDoor =
        (doorSide === "z+" && z === W - 1 && (x === 2 || x === 3)) ||
        (doorSide === "z-" && z === 0 && (x === 2 || x === 3)) ||
        (doorSide === "x+" && x === W - 1 && (z === 2 || z === 3)) ||
        (doorSide === "x-" && x === 0 && (z === 2 || z === 3));
      for (let y = 1; y <= 4; y++) {
        if (isDoor && y <= 2) continue;
        out.push(ox + x, y, oz + z, BLOCK.PLANKS);
      }
    }
  }
  // A simple tapering roof.
  for (let x = -1; x <= W; x++) for (let z = -1; z <= W; z++) out.push(ox + x, 5, oz + z, BLOCK.OAK_BARK);
  for (let x = 1; x < W - 1; x++) for (let z = 1; z < W - 1; z++) out.push(ox + x, 6, oz + z, BLOCK.OAK_BARK);
  for (let x = 2; x < W - 2; x++) for (let z = 2; z < W - 2; z++) out.push(ox + x, 7, oz + z, BLOCK.OAK_BARK);
  // A torch beside the doorway, standing on the pad just outside it.
  let tx = 2;
  let tz = 0;
  if (doorSide === "z+") tz = W;
  else if (doorSide === "z-") tz = -1;
  else if (doorSide === "x+") {
    tx = W;
    tz = 2;
  } else if (doorSide === "x-") {
    tx = -1;
    tz = 2;
  }
  out.push(ox + tx, 1, oz + tz, BLOCK.TORCH);
}
