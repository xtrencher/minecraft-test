// Fast unit tests for the game's pure-logic modules, run directly in Node
// (no browser). Complements smoke-test.mjs, which drives the real game.
import assert from "node:assert/strict";
import { encodeChunkEdits, decodeChunkEdits, parseEdits, serializeEdits, setEdit } from "../js/storage.js";
import { CHUNK_SIZE, WORLD_HEIGHT, blockIndex } from "../js/constants.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.stack?.split("\n").slice(0, 3).join("\n        ")}`);
  }
}

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log("Save format (storage.js)");

await test("chunk edits round-trip through the run-length encoding", () => {
  const rand = rng(1);
  for (let trial = 0; trial < 50; trial++) {
    const map = new Map();
    const n = Math.floor(rand() * 3000);
    for (let i = 0; i < n; i++) {
      map.set(Math.floor(rand() * CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT), Math.floor(rand() * 256));
    }
    const decoded = decodeChunkEdits(encodeChunkEdits(map));
    assert.equal(decoded.size, map.size);
    for (const [k, v] of map) assert.equal(decoded.get(k), v, `index ${k}`);
  }
});

await test("long runs (> 255) and index extremes encode correctly", () => {
  const map = new Map();
  for (let i = 0; i < 1000; i++) map.set(i, 0); // one long run of air
  map.set(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT - 1, 7); // last index in a chunk
  const decoded = decodeChunkEdits(encodeChunkEdits(map));
  assert.deepEqual([...decoded.entries()].sort((a, b) => a[0] - b[0]), [...map.entries()].sort((a, b) => a[0] - b[0]));
});

await test("a Blast Orb-sized crater compresses to a small fraction of the legacy format", () => {
  const map = new Map();
  let legacyLen = 0;
  const r = 7;
  for (let y = 20; y < 36; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        if ((x - 8) ** 2 + (y - 28) ** 2 + (z - 8) ** 2 <= r * r) {
          map.set(blockIndex(x, y, z), 0);
          legacyLen += `${x},${y},${z},0,`.length;
        }
      }
    }
  }
  const encoded = encodeChunkEdits(map);
  console.log(`        ${map.size} blocks: ${encoded.length} chars vs ~${legacyLen} chars in the old flat-array format`);
  assert.ok(encoded.length * 5 < legacyLen, "expected at least 5x smaller than the legacy encoding");
});

await test("legacy flat [x,y,z,id,...] saves are still read correctly", () => {
  const legacy = [0, 22, 8, 0, -3, 23, 9, 5, -17, 10, 33, 8];
  const edits = parseEdits(legacy);
  assert.equal(edits.get("0,0").get(blockIndex(0, 22, 8)), 0);
  assert.equal(edits.get("-1,0").get(blockIndex(13, 23, 9)), 5);
  assert.equal(edits.get("-2,2").get(blockIndex(15, 10, 1)), 8);
});

await test("serialize -> JSON -> parse preserves every edit, with and without the encode cache", () => {
  const edits = new Map();
  const rand = rng(7);
  for (let i = 0; i < 2000; i++) {
    setEdit(edits, Math.floor(rand() * 9) - 4, Math.floor(rand() * 9) - 4, Math.floor(rand() * 16384), Math.floor(rand() * 20));
  }
  const cache = new Map();
  const first = JSON.stringify(serializeEdits(edits, cache, new Set(edits.keys())));
  // Change one chunk; only it is marked dirty, the rest come from the cache.
  setEdit(edits, 0, 0, 123, 9);
  const second = JSON.parse(JSON.stringify(serializeEdits(edits, cache, new Set(["0,0"]))));
  const parsed = parseEdits(second);
  assert.equal(parsed.size, edits.size);
  for (const [key, map] of edits) {
    for (const [idx, id] of map) assert.equal(parsed.get(key).get(idx), id);
  }
  assert.notEqual(first, JSON.stringify(second));
});

await test("one corrupted chunk doesn't discard the other chunks' edits", () => {
  const edits = new Map();
  setEdit(edits, 0, 0, 5, 3);
  setEdit(edits, 1, 0, 6, 4);
  const data = serializeEdits(edits);
  data.chunks["1,0"] = "@@not base64@@";
  const warn = console.warn;
  console.warn = () => {};
  try {
    const parsed = parseEdits(data);
    assert.equal(parsed.get("0,0").get(5), 3);
    assert.equal(parsed.has("1,0"), false);
  } finally {
    console.warn = warn;
  }
});

await test("garbage input yields no edits instead of throwing", () => {
  for (const bad of [null, 42, "x", {}, { v: 3 }, { v: 2, chunks: null }, { v: 2, chunks: { "a,b": "AAAA" } }]) {
    assert.equal(parseEdits(bad).size, 0);
  }
});

// ---------------------------------------------------------------------------
console.log("\nLight engine (light.js) vs. brute-force reference");

const { LightEngine } = await import("../js/light.js");
const { BLOCK, IS_OPAQUE, LIGHT_FILTER, SKY_PASS, EMISSION } = await import("../js/blocks.js");

const H = WORLD_HEIGHT;
const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function makeTestWorld(size, seed) {
  const rand = rng(seed);
  const chunks = new Map();
  const world = {
    getChunk: (cx, cz) => chunks.get(`${cx},${cz}`),
    chunks,
    get(x, y, z) {
      const c = world.getChunk(x >> 4, z >> 4);
      return c && y >= 0 && y < H ? c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)] : undefined;
    },
    set(x, y, z, id) {
      world.getChunk(x >> 4, z >> 4).blocks[(y << 8) | ((z & 15) << 4) | (x & 15)] = id;
    },
  };
  const allBlocks = [];
  for (let cx = 0; cx < size; cx++) {
    for (let cz = 0; cz < size; cz++) {
      allBlocks.push({ cx, cz, blocks: new Uint8Array(16 * 16 * H), light: new Uint8Array(16 * 16 * H) });
    }
  }
  // Terrain: rolling height field, water below y=20, caves, trees, glass,
  // overhangs, and light sources both underground and on the surface.
  const W = size * 16;
  const heightAt = (x, z) => Math.floor(22 + 6 * Math.sin(x * 0.21) * Math.cos(z * 0.17) + 3 * Math.sin((x + z) * 0.4));
  for (const c of allBlocks) chunks.set(`${c.cx},${c.cz}`, c);
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < W; z++) {
      const h = heightAt(x, z);
      for (let y = 0; y < H; y++) {
        let id = BLOCK.AIR;
        if (y <= h) id = y > h - 3 ? BLOCK.DIRT : BLOCK.STONE;
        else if (y <= 20) id = BLOCK.WATER;
        world.set(x, y, z, id);
      }
    }
  }
  const blob = (x0, y0, z0, r, id) => {
    for (let x = x0 - r; x <= x0 + r; x++) {
      for (let y = y0 - r; y <= y0 + r; y++) {
        for (let z = z0 - r; z <= z0 + r; z++) {
          if (x < 0 || z < 0 || x >= W || z >= W || y < 0 || y >= H) continue;
          if ((x - x0) ** 2 + (y - y0) ** 2 + (z - z0) ** 2 <= r * r) world.set(x, y, z, id);
        }
      }
    }
  };
  for (let i = 0; i < size * size * 3; i++) blob(Math.floor(rand() * W), 4 + Math.floor(rand() * 20), Math.floor(rand() * W), 2 + Math.floor(rand() * 3), BLOCK.AIR);
  for (let i = 0; i < size * size * 2; i++) {
    const x = Math.floor(rand() * W);
    const z = Math.floor(rand() * W);
    const h = heightAt(x, z);
    if (h <= 20) continue;
    for (let y = h + 1; y <= h + 4; y++) world.set(x, y, z, BLOCK.WOOD);
    blob(x, h + 5, z, 2, BLOCK.LEAVES);
  }
  for (let i = 0; i < size * size * 4; i++) {
    const x = Math.floor(rand() * W);
    const z = Math.floor(rand() * W);
    const y = 2 + Math.floor(rand() * 40);
    world.set(x, y, z, [BLOCK.TORCH, BLOCK.LUMEN, BLOCK.GLASS, BLOCK.STONE][Math.floor(rand() * 4)]);
  }
  // A floating roof, so there is shade that has to be filled in sideways.
  for (let x = 3; x < 12; x++) for (let z = 3; z < 12; z++) world.set(x, 45, z, BLOCK.PLANKS);
  return { world, chunkList: allBlocks, rand, W };
}

// Recomputes all light from scratch by relaxing until nothing changes.
function referenceLight(world, chunkList) {
  const ref = new Map();
  for (const c of chunkList) ref.set(c, new Uint8Array(16 * 16 * H));
  for (const c of chunkList) {
    const L = ref.get(c);
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        let level = 15;
        for (let y = H - 1; y >= 0; y--) {
          const idx = (y << 8) | (lz << 4) | lx;
          const id = c.blocks[idx];
          if (IS_OPAQUE[id]) break;
          if (!(level === 15 && SKY_PASS[id])) level -= 1 + LIGHT_FILTER[id];
          if (level <= 0) break;
          L[idx] = level << 4;
        }
      }
    }
    for (let idx = 0; idx < L.length; idx++) L[idx] |= EMISSION[c.blocks[idx]];
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of chunkList) {
      const L = ref.get(c);
      for (let idx = 0; idx < L.length; idx++) {
        const sky = L[idx] >> 4;
        const blk = L[idx] & 15;
        if (sky <= 1 && blk <= 1) continue;
        const x = c.cx * 16 + (idx & 15);
        const y = idx >> 8;
        const z = c.cz * 16 + ((idx >> 4) & 15);
        for (let d = 0; d < 6; d++) {
          const [dx, dy, dz] = DIRS[d];
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          const nc = world.getChunk((x + dx) >> 4, (z + dz) >> 4);
          if (!nc) continue;
          const nidx = (ny << 8) | (((z + dz) & 15) << 4) | ((x + dx) & 15);
          const nid = nc.blocks[nidx];
          if (IS_OPAQUE[nid]) continue;
          const NL = ref.get(nc);
          const scost = d === 3 && sky === 15 && SKY_PASS[nid] ? 0 : 1 + LIGHT_FILTER[nid];
          const bcost = 1 + LIGHT_FILTER[nid];
          if (sky - scost > NL[nidx] >> 4) {
            NL[nidx] = (NL[nidx] & 15) | ((sky - scost) << 4);
            changed = true;
          }
          if (blk - bcost > (NL[nidx] & 15)) {
            NL[nidx] = (NL[nidx] & 0xf0) | (blk - bcost);
            changed = true;
          }
        }
      }
    }
  }
  return ref;
}

function compareLight(world, chunkList, label) {
  const ref = referenceLight(world, chunkList);
  let mismatches = 0;
  let first = null;
  for (const c of chunkList) {
    const R = ref.get(c);
    for (let idx = 0; idx < R.length; idx++) {
      if (R[idx] !== c.light[idx]) {
        mismatches++;
        if (!first) {
          first = `chunk ${c.cx},${c.cz} x=${idx & 15} y=${idx >> 8} z=${(idx >> 4) & 15} block=${c.blocks[idx]}: engine sky/blk ${c.light[idx] >> 4}/${c.light[idx] & 15}, reference ${R[idx] >> 4}/${R[idx] & 15}`;
        }
      }
    }
  }
  assert.equal(mismatches, 0, `${label}: ${mismatches} cells differ from the reference; first: ${first}`);
}

await test("chunks lit one at a time in random order match a full recompute", () => {
  for (const seed of [11, 12, 13]) {
    const { world, chunkList, rand } = makeTestWorld(3, seed);
    const order = [...chunkList].sort(() => rand() - 0.5);
    // Chunks "load" one by one: only already-loaded chunks are visible to the engine.
    const loaded = new Map();
    const view = { getChunk: (cx, cz) => loaded.get(`${cx},${cz}`) };
    const engine = new LightEngine(view);
    for (const c of order) {
      loaded.set(`${c.cx},${c.cz}`, c);
      engine.initChunk(c);
    }
    compareLight(world, chunkList, `seed ${seed}`);
  }
});

await test("random batches of block edits keep light identical to a full recompute", () => {
  const { world, chunkList, rand, W } = makeTestWorld(3, 99);
  const engine = new LightEngine(world);
  for (const c of chunkList) engine.initChunk(c);
  compareLight(world, chunkList, "initial");
  const palette = [BLOCK.AIR, BLOCK.AIR, BLOCK.AIR, BLOCK.STONE, BLOCK.TORCH, BLOCK.LUMEN, BLOCK.LEAVES, BLOCK.GLASS, BLOCK.WATER, BLOCK.PLANKS];
  for (let round = 0; round < 60; round++) {
    const changes = [];
    const n = 1 + Math.floor(rand() * (round % 10 === 0 ? 400 : 6)); // occasionally a big blast-sized batch
    const cx0 = Math.floor(rand() * W);
    const cy0 = Math.floor(rand() * 50);
    const cz0 = Math.floor(rand() * W);
    for (let i = 0; i < n; i++) {
      const x = Math.min(W - 1, Math.max(0, cx0 + Math.floor((rand() - 0.5) * 16)));
      const y = Math.min(H - 1, Math.max(0, cy0 + Math.floor((rand() - 0.5) * 16)));
      const z = Math.min(W - 1, Math.max(0, cz0 + Math.floor((rand() - 0.5) * 16)));
      world.set(x, y, z, palette[Math.floor(rand() * palette.length)]);
      changes.push(x, y, z);
    }
    engine.applyChanges(changes);
    compareLight(world, chunkList, `after edit round ${round} (${n} changes)`);
  }
});

await test("digging to the top of the world and roofing a column update sky light", () => {
  const { world, chunkList } = makeTestWorld(2, 5);
  const engine = new LightEngine(world);
  for (const c of chunkList) engine.initChunk(c);
  // Place a block at the very top of the world over an open column.
  world.set(20, H - 1, 20, BLOCK.STONE);
  engine.applyChanges([20, H - 1, 20]);
  compareLight(world, chunkList, "roof at top");
  world.set(20, H - 1, 20, BLOCK.AIR);
  engine.applyChanges([20, H - 1, 20]);
  compareLight(world, chunkList, "roof removed");
});

await test("changed-chunk set includes neighbors when light changes on a border", () => {
  const { world, chunkList } = makeTestWorld(2, 8);
  const engine = new LightEngine(world);
  for (const c of chunkList) engine.initChunk(c);
  // A torch right at the corner between chunks (15,15) of chunk 0,0.
  let y = H - 1;
  while (y > 0 && world.get(15, y - 1, 15) === BLOCK.AIR) y--;
  world.set(15, y, 15, BLOCK.TORCH);
  const changed = engine.applyChanges([15, y, 15]);
  const keys = new Set([...changed].map((c) => `${c.cx},${c.cz}`));
  for (const k of ["0,0", "1,0", "0,1", "1,1"]) assert.ok(keys.has(k), `expected chunk ${k} in changed set, got ${[...keys]}`);
});

// ---------------------------------------------------------------------------
console.log("\nTerrain generation (terrain.js)");

const { TerrainGenerator } = await import("../js/terrain.js");
const { SEA_LEVEL } = await import("../js/constants.js");

function generateRegion(seed, size, ox = 0, oz = 0) {
  const gen = new TerrainGenerator(seed);
  const chunks = new Map();
  for (let cx = ox; cx < ox + size; cx++) {
    for (let cz = oz; cz < oz + size; cz++) {
      const c = { cx, cz, blocks: new Uint8Array(16 * 16 * H) };
      gen.generate(c);
      chunks.set(`${cx},${cz}`, c);
    }
  }
  const get = (x, y, z) => {
    const c = chunks.get(`${x >> 4},${z >> 4}`);
    if (!c || y < 0 || y >= H) return undefined;
    return c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
  };
  return { gen, chunks, get };
}

await test("generation is deterministic and keeps the original height map", () => {
  const a = generateRegion(1234, 2);
  const b = generateRegion(1234, 2);
  for (const [k, c] of a.chunks) assert.deepEqual(c.blocks, b.chunks.get(k).blocks, `chunk ${k} differs between runs`);
  // Surface blocks sit exactly at heightAt (unless a cave opened the surface there).
  let matches = 0;
  let total = 0;
  for (let x = 0; x < 32; x++) {
    for (let z = 0; z < 32; z++) {
      const h = a.gen.heightAt(x, z);
      total++;
      if ([BLOCK.GRASS, BLOCK.SAND].includes(a.get(x, h, z))) matches++;
    }
  }
  assert.ok(matches / total > 0.9, `only ${matches}/${total} columns have their surface at heightAt`);
});

await test("caves never leave air touching water, and never break the bedrock floor", () => {
  for (const seed of [42, 7, 99991]) {
    const { chunks, get } = generateRegion(seed, 5, -2, -2);
    let wet = 0;
    for (let x = -32 + 1; x < 48 - 1; x++) {
      for (let z = -32 + 1; z < 48 - 1; z++) {
        assert.equal(get(x, 0, z), BLOCK.BEDROCK, `hole in the bedrock floor at ${x},${z}`);
        for (let y = 1; y <= SEA_LEVEL; y++) {
          if (get(x, y, z) !== BLOCK.AIR) continue;
          for (const [dx, dy, dz] of DIRS) {
            if (get(x + dx, y + dy, z + dz) === BLOCK.WATER) wet++;
          }
        }
      }
    }
    assert.equal(wet, 0, `seed ${seed}: ${wet} air cells touch water`);
  }
});

await test("caves, ores and crystals appear in sensible amounts", () => {
  const { gen, chunks } = generateRegion(42, 6);
  const counts = {};
  let underground = 0;
  let caveAir = 0;
  for (const c of chunks.values()) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const h = gen.heightAt(c.cx * 16 + lx, c.cz * 16 + lz);
        for (let y = 2; y < h - 3; y++) {
          const id = c.blocks[(y << 8) | (lz << 4) | lx];
          underground++;
          if (id === BLOCK.AIR) caveAir++;
          counts[id] = (counts[id] || 0) + 1;
        }
      }
    }
  }
  const n = chunks.size;
  const per = (id) => ((counts[id] || 0) / n).toFixed(1);
  console.log(`        underground cave air ${((caveAir / underground) * 100).toFixed(1)}%; per chunk: coal ${per(BLOCK.COAL_ORE)}, iron ${per(BLOCK.IRON_ORE)}, gold ${per(BLOCK.GOLD_ORE)}, diamond ${per(BLOCK.DIAMOND_ORE)}, gravel ${per(BLOCK.GRAVEL)}, lumen ${per(BLOCK.LUMEN)}`);
  assert.ok(caveAir / underground > 0.015 && caveAir / underground < 0.2, "cave volume out of range");
  assert.ok(counts[BLOCK.COAL_ORE] > counts[BLOCK.IRON_ORE] && counts[BLOCK.IRON_ORE] > counts[BLOCK.GOLD_ORE], "ore rarity order");
  assert.ok((counts[BLOCK.DIAMOND_ORE] || 0) > 0 && counts[BLOCK.DIAMOND_ORE] < counts[BLOCK.GOLD_ORE], "diamonds should exist but be rarer than gold");
  assert.ok((counts[BLOCK.LUMEN] || 0) > 0, "no lumen crystals generated");
});

await test("trees: oaks, birches, pines and old oaks grow, and trees are whole across chunk borders", async () => {
  const { TREE } = await import("../js/trees.js");
  const counts = {};
  for (const seed of [42, 7, 12345]) {
    const gen = new TerrainGenerator(seed);
    for (let x = -320; x < 320; x++) {
      for (let z = -320; z < 320; z++) {
        const r = gen.trees.rootAt(x, z);
        if (r) counts[r.species] = (counts[r.species] || 0) + 1;
      }
    }
  }
  console.log(`        oak ${counts[TREE.OAK]}, birch ${counts[TREE.BIRCH]}, pine ${counts[TREE.PINE]}, old oak ${counts[TREE.OLD_OAK]} in three 640x640 areas`);
  for (const sp of [TREE.OAK, TREE.BIRCH, TREE.PINE, TREE.OLD_OAK]) assert.ok(counts[sp] > 0, `no trees of species ${sp}`);
  assert.ok(counts[TREE.OLD_OAK] < counts[TREE.OAK] / 4, "old oaks should be rare");
  // Every leaf and trunk block of every tree in a region ends up in the
  // generated chunks, even where the tree spans several chunks.
  const { gen, get } = generateRegion(42, 7, -3, -3);
  let trees = 0;
  let crossing = 0;
  let missing = 0;
  for (let x = -48 + 10; x < 64 - 10; x++) {
    for (let z = -48 + 10; z < 64 - 10; z++) {
      const root = gen.trees.rootAt(x, z);
      if (!root) continue;
      trees++;
      const shape = gen.trees.shape(root);
      let spans = false;
      for (let i = 0; i < shape.length; i += 4) {
        const X = x + shape[i];
        const Y = root.h + 1 + shape[i + 1];
        const Z = z + shape[i + 2];
        if (Y < 1 || Y >= H || shape[i + 1] < 0) continue;
        if (X >> 4 !== x >> 4 || Z >> 4 !== z >> 4) spans = true;
        if (get(X, Y, Z) === BLOCK.AIR) missing++;
      }
      if (spans) crossing++;
    }
  }
  console.log(`        ${trees} trees in the region, ${crossing} spanning chunk borders, ${missing} blocks missing`);
  assert.ok(trees > 15 && crossing > 5, `too few trees to check (${trees}, ${crossing} crossing)`);
  assert.equal(missing, 0, "every tree block should be placed, whichever chunk it falls in");
});

await test("new players start on the ground, never on top of a tree", async () => {
  let moved = 0;
  for (let i = 0; i < 120; i++) {
    const seed = i === 0 ? 42 : i * 7919;
    const gen = new TerrainGenerator(seed);
    const [x, z] = gen.spawnColumn();
    const h = gen.heightAt(x, z);
    assert.ok(h > SEA_LEVEL + 1, `seed ${seed}: spawn (${x}, ${z}) is not on land`);
    if (Math.hypot(x, z) > 0 && gen.heightAt(0, 0) > SEA_LEVEL + 1) moved++;
    // Nothing solid above the ground in the generated chunk (plants are fine).
    const { IS_SOLID } = await import("../js/blocks.js");
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const blocks = new Uint8Array(16 * 16 * H);
    gen.generate({ cx, cz, blocks });
    for (let y = h + 1; y < H; y++) {
      const id = blocks[(y * 16 + (z - cz * 16)) * 16 + (x - cx * 16)];
      assert.ok(!IS_SOLID[id], `seed ${seed}: block ${id} above the spawn at y=${y}`);
    }
  }
  console.log(`        120 worlds, ${moved} spawns moved to the side of a tree`);
  assert.ok(moved > 0, "some spawns should have needed moving off a tree");
});

await test("terrain generation is fast enough to stream (< 3 ms per chunk)", () => {
  const gen = new TerrainGenerator(5);
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) gen.generate({ cx: i, cz: -i, blocks: new Uint8Array(16 * 16 * H) });
  const ms = (performance.now() - t0) / 40;
  console.log(`        ${ms.toFixed(2)} ms per chunk`);
  assert.ok(ms < 3, `${ms.toFixed(2)} ms per chunk`);
});

// ---------------------------------------------------------------------------
console.log("\nItems, crafting and inventory (items.js, crafting.js, inventory.js)");

const { ITEM, itemInfo, breakTime, canHarvest, blockDrops, maxStack } = await import("../js/items.js");
const { findRecipe, RECIPES } = await import("../js/crafting.js");
const { Inventory, clickSlot, takeCraftResult, craftAllInto, quickMove, makeStack } = await import("../js/inventory.js");

await test("every recipe's ingredients and results are real items", () => {
  for (const r of RECIPES) {
    assert.ok(itemInfo(r.result), `unknown result ${r.result}`);
    const ids = r.type === "shaped" ? Object.values(r.key) : r.ingredients;
    for (const id of ids) assert.ok(itemInfo(id), `unknown ingredient ${id}`);
  }
});

await test("recipes match anywhere in the grid, mirrored, and not with extra items", () => {
  const P = BLOCK.PLANKS;
  const S = ITEM.STICK;
  // Log -> 4 planks in any slot of the 2x2 grid.
  for (let i = 0; i < 4; i++) {
    const g = [0, 0, 0, 0];
    g[i] = BLOCK.WOOD;
    const r = findRecipe(g, 2);
    assert.equal(r?.result, BLOCK.PLANKS);
    assert.equal(r.count, 4);
  }
  // Sticks: two planks stacked vertically, in either column of a 3x3 grid.
  assert.equal(findRecipe([0, 0, P, 0, 0, P, 0, 0, 0], 3)?.result, ITEM.STICK);
  assert.equal(findRecipe([P, 0, 0, P, 0, 0, 0, 0, 0], 3)?.result, ITEM.STICK);
  assert.equal(findRecipe([P, P, 0, 0], 2), null, "two planks side by side are not sticks");
  // Pickaxe needs the exact T shape.
  const C = BLOCK.COBBLESTONE;
  assert.equal(findRecipe([C, C, C, 0, S, 0, 0, S, 0], 3)?.result, ITEM.STONE_PICKAXE);
  assert.equal(findRecipe([C, C, C, 0, S, 0, S, 0, 0], 3), null);
  // Axe matches mirrored.
  assert.equal(findRecipe([C, C, 0, C, S, 0, 0, S, 0], 3)?.result, ITEM.STONE_AXE);
  assert.equal(findRecipe([C, C, 0, S, C, 0, S, 0, 0], 3)?.result, ITEM.STONE_AXE);
  // Shapeless smelting ignores order and position.
  assert.equal(findRecipe([ITEM.COAL, 0, 0, BLOCK.IRON_ORE], 2)?.result, ITEM.IRON_INGOT);
  assert.equal(findRecipe([ITEM.COAL, BLOCK.IRON_ORE, BLOCK.IRON_ORE, 0], 2), null, "extra ore should not match");
  // The 5-ingredient glass recipe can't fit in the 2x2 grid but works in the table.
  assert.equal(findRecipe([BLOCK.SAND, BLOCK.SAND, BLOCK.SAND, BLOCK.SAND, ITEM.COAL, 0, 0, 0, 0], 3)?.result, BLOCK.GLASS);
});

await test("mining: tool tiers gate drops and speed up breaking", () => {
  const woodPick = itemInfo(ITEM.WOOD_PICKAXE).tool;
  const stonePick = itemInfo(ITEM.STONE_PICKAXE).tool;
  const ironPick = itemInfo(ITEM.IRON_PICKAXE).tool;
  const stoneAxe = itemInfo(ITEM.STONE_AXE).tool;
  assert.equal(canHarvest(BLOCK.STONE, null), false, "stone by hand drops nothing");
  assert.equal(canHarvest(BLOCK.STONE, woodPick), true);
  assert.equal(canHarvest(BLOCK.IRON_ORE, woodPick), false);
  assert.equal(canHarvest(BLOCK.IRON_ORE, stonePick), true);
  assert.equal(canHarvest(BLOCK.DIAMOND_ORE, stonePick), false);
  assert.equal(canHarvest(BLOCK.DIAMOND_ORE, ironPick), true);
  assert.equal(canHarvest(BLOCK.BEDROCK, ironPick), false);
  assert.equal(breakTime(BLOCK.BEDROCK, ironPick), Infinity);
  assert.ok(Math.abs(breakTime(BLOCK.STONE, null) - 7.5) < 1e-9);
  assert.ok(Math.abs(breakTime(BLOCK.STONE, woodPick) - 1.125) < 1e-9);
  assert.ok(breakTime(BLOCK.WOOD, stoneAxe) < breakTime(BLOCK.WOOD, null));
  assert.equal(breakTime(BLOCK.TORCH, null), 0);
  assert.deepEqual(blockDrops(BLOCK.STONE, woodPick), [[BLOCK.COBBLESTONE, 1]]);
  assert.deepEqual(blockDrops(BLOCK.GRASS, null), [[BLOCK.DIRT, 1]]);
  assert.deepEqual(blockDrops(BLOCK.COAL_ORE, woodPick), [[ITEM.COAL, 1]]);
  assert.deepEqual(blockDrops(BLOCK.GLASS, null), []);
  assert.deepEqual(blockDrops(BLOCK.LEAVES, null, () => 0.01), [[ITEM.APPLE, 1]]);
});

await test("inventory add/merge/overflow and tool durability", () => {
  const inv = new Inventory();
  assert.equal(inv.add(BLOCK.DIRT, 100), 0);
  assert.equal(inv.slots[0].count, 64);
  assert.equal(inv.slots[1].count, 36);
  assert.equal(inv.add(BLOCK.DIRT, 10), 0);
  assert.equal(inv.slots[1].count, 46, "merges into the partial stack");
  assert.equal(inv.add(ITEM.IRON_SWORD, 2), 0);
  assert.equal(inv.slots[2].count, 1, "tools don't stack");
  assert.equal(inv.slots[3].count, 1);
  assert.equal(inv.slots[2].dur, itemInfo(ITEM.IRON_SWORD).tool.durability);
  for (let i = 0; i < 40; i++) inv.add(BLOCK.STONE + (i % 2 ? 0 : 7), 64); // fill it up
  assert.ok(inv.add(BLOCK.WOOL, 5) > 0, "a full inventory reports leftovers");
  assert.equal(inv.canFit(BLOCK.WOOL, 1), false);
  // Durability: a wooden pickaxe breaks after its last use.
  const inv2 = new Inventory();
  inv2.add(ITEM.WOOD_PICKAXE);
  inv2.slots[0].dur = 2;
  assert.equal(inv2.damageSelected(), false);
  assert.equal(inv2.damageSelected(), true);
  assert.equal(inv2.slots[0], null);
});

await test("slot clicks: pick up, place, split, merge, swap", () => {
  const slots = [makeStack(BLOCK.DIRT, 10), makeStack(BLOCK.DIRT, 60), null, makeStack(BLOCK.STONE, 3)];
  let cursor = clickSlot(slots, 0, null, 2); // right-click: take half
  assert.equal(cursor.count, 5);
  assert.equal(slots[0].count, 5);
  cursor = clickSlot(slots, 2, cursor, 2); // right-click on empty: place one
  assert.equal(slots[2].count, 1);
  assert.equal(cursor.count, 4);
  cursor = clickSlot(slots, 1, cursor, 0); // left-click: merge up to 64
  assert.equal(slots[1].count, 64);
  assert.equal(cursor, null, "all 4 fit");
  cursor = clickSlot(slots, 3, null, 0); // pick up the stone
  cursor = clickSlot(slots, 0, cursor, 0); // swap stone and dirt
  assert.equal(slots[0].id, BLOCK.STONE);
  assert.equal(cursor.id, BLOCK.DIRT);
  assert.equal(cursor.count, 5);
});

await test("crafting output: take, shift-craft all, quick-move", () => {
  const inv = new Inventory();
  const grid = [makeStack(BLOCK.WOOD, 3), null, null, null];
  let cursor = takeCraftResult(grid, 2, null);
  assert.equal(cursor.id, BLOCK.PLANKS);
  assert.equal(cursor.count, 4);
  assert.equal(grid[0].count, 2);
  cursor = takeCraftResult(grid, 2, cursor); // stacks onto the cursor
  assert.equal(cursor.count, 8);
  assert.equal(craftAllInto(grid, 2, inv), 1);
  assert.equal(inv.countItem(BLOCK.PLANKS), 4);
  assert.equal(grid[0], null);
  inv.add(BLOCK.SAND, 5);
  const sandSlot = inv.slots.findIndex((s) => s && s.id === BLOCK.SAND);
  assert.ok(quickMove(inv, sandSlot));
  assert.ok(inv.slots.findIndex((s) => s && s.id === BLOCK.SAND) >= 9, "hotbar -> main");
});

await test("inventory survives serialize/load and rejects garbage", () => {
  const inv = new Inventory();
  inv.add(BLOCK.TORCH, 12);
  inv.add(ITEM.DIAMOND_PICKAXE);
  inv.slots[1].dur = 99;
  const data = JSON.parse(JSON.stringify(inv.serialize()));
  const inv2 = new Inventory();
  inv2.load(data);
  assert.deepEqual(inv2.slots[0], { id: BLOCK.TORCH, count: 12 });
  assert.deepEqual(inv2.slots[1], { id: ITEM.DIAMOND_PICKAXE, count: 1, dur: 99 });
  inv2.load([[9999, 3], ["x"], [BLOCK.DIRT, -4], [BLOCK.DIRT, 500], 5]);
  assert.equal(inv2.slots[0], null);
  assert.equal(inv2.slots[3].count, maxStack(BLOCK.DIRT), "counts are clamped to the stack size");
});

console.log("\nCollision (physics.js)");
{
  const { sweepAxis, boxInSolid, rayAabb } = await import("../js/physics.js");
  // A tiny voxel world: a floor at y = 0 and a wall at x = 5.
  const world = { isSolidAt: (x, y, z) => y === 0 || (x === 5 && y >= 1 && y <= 2) };
  const v = (x, y, z) => ({ x, y, z });

  await test("sweeps stop exactly at floors and walls, and pass through open space", () => {
    const pos = v(2.5, 1, 2.5);
    const down = sweepAxis(world, pos, 0.3, 1.8, "y", -0.5);
    assert.ok(Math.abs(down) < 1e-3, `standing on the floor, can't sink (moved ${down})`);
    const toWall = sweepAxis(world, pos, 0.3, 1.8, "x", 5);
    assert.ok(Math.abs(pos.x + toWall + 0.3 - 5) < 1e-3, "stops with the box's face at the wall");
    const away = sweepAxis(world, pos, 0.3, 1.8, "x", -1.5);
    assert.equal(away, -1.5, "free movement is unchanged");
    const over = sweepAxis(world, v(2.5, 3, 2.5), 0.3, 1.8, "x", 5);
    assert.equal(over, 5, "above the 2-high wall nothing blocks");
    assert.ok(boxInSolid(world, v(5.2, 1, 2.5), 0.3, 1.8) && !boxInSolid(world, v(3, 1, 3), 0.3, 1.8));
  });

  await test("ray vs box: hits from outside, misses beside, respects the max distance", () => {
    const min = v(4, 1, -0.5);
    const max = v(5, 3, 0.5);
    assert.ok(Math.abs(rayAabb(v(0, 2, 0), v(1, 0, 0), min, max, 10) - 4) < 1e-9);
    assert.equal(rayAabb(v(0, 2, 2), v(1, 0, 0), min, max, 10), null);
    assert.equal(rayAabb(v(0, 2, 0), v(1, 0, 0), min, max, 3), null);
    assert.equal(rayAabb(v(4.5, 2, 0), v(1, 0, 0), min, max, 10), 0, "starting inside counts as an immediate hit");
  });
}

console.log("\nExplosion falloff (falloff.js)");
{
  const { shakeFalloff, explosionSound } = await import("../js/falloff.js");
  await test("camera shake fades smoothly with distance, to nothing far away, and reaches farther for bigger blasts", () => {
    let prev = Infinity;
    for (let d = 0; d <= 300; d += 5) {
      const s = shakeFalloff(d, 7);
      assert.ok(s <= prev + 1e-12 && s >= 0 && s <= 1, `not monotonic at ${d}`);
      prev = s;
    }
    assert.equal(shakeFalloff(0, 7), 1);
    assert.equal(shakeFalloff(200, 7), 0);
    assert.ok(shakeFalloff(80, 35) > shakeFalloff(80, 7), "a bazooka shakes from farther away");
  });

  await test("explosions sound quieter, more muffled and later with distance; bigger blasts are louder", () => {
    let prev = explosionSound(0, 1);
    for (let d = 10; d <= 400; d += 10) {
      const s = explosionSound(d, 1);
      assert.ok(s.gain < prev.gain && s.cutoff <= prev.cutoff && s.delay > prev.delay, `not smooth at ${d}`);
      prev = s;
    }
    assert.ok(explosionSound(400, 1).cutoff < 500, "far explosions are muffled to a rumble");
    assert.ok(explosionSound(0, 1).cutoff > 15000, "close explosions are crisp");
    assert.ok(explosionSound(60, 5).gain > explosionSound(60, 1).gain, "the bazooka is louder");
  });
}

console.log("\nDistant terrain (lod-mesher.js)");
{
  const { LodTerrain, buildLodTile, makeLodPalette, tileSpan, LOD_CELLS, LOD_WATER_TOP, LOD_KIND } = await import("../js/lod-mesher.js");
  const { BLOCK } = await import("../js/blocks.js");
  const { SEA_LEVEL } = await import("../js/constants.js");
  const flat = new Float32Array(256 * 3).fill(0.4);
  const pal = makeLodPalette({ top: flat, side: flat });
  const seed = 4242;

  // Faces of a built tile, from its quads: { normal, kind, x0, x1, y0, y1, z0, z1 }.
  const facesOf = (m) => {
    const faces = [];
    for (let v = 0; v < m.vertexCount; v += 4) {
      const xs = [];
      const ys = [];
      const zs = [];
      for (let k = 0; k < 4; k++) {
        xs.push(m.position[(v + k) * 3]);
        ys.push(m.position[(v + k) * 3 + 1]);
        zs.push(m.position[(v + k) * 3 + 2]);
      }
      faces.push({ normal: m.info[v * 4], kind: m.info[v * 4 + 1], x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0: Math.min(...zs), z1: Math.max(...zs) });
    }
    return faces;
  };

  await test("tiles are well-formed: quads, valid indices, tops at the terrain height sampled at each cell's centre", () => {
    const lt = new LodTerrain(seed);
    for (const level of [1, 2, 4]) {
      const m = buildLodTile(lt, level, -1, 2, pal);
      const step = 1 << level;
      assert.equal(m.vertexCount % 4, 0);
      assert.equal(m.index.length, (m.vertexCount / 4) * 6);
      for (const i of m.index) assert.ok(i < m.vertexCount);
      for (const p of m.position) assert.ok(Number.isFinite(p));
      // Every cell centre is covered by exactly one terrain top at its sampled height.
      const tops = facesOf(m).filter((f) => f.normal === 2 && f.kind !== LOD_KIND.LEAVES);
      for (let j = 0; j < LOD_CELLS; j += 5) {
        for (let i = 0; i < LOD_CELLS; i += 3) {
          const cx = i * step + step / 2;
          const cz = j * step + step / 2;
          const hits = tops.filter((f) => f.x0 < cx && f.x1 > cx && f.z0 < cz && f.z1 > cz);
          assert.equal(hits.length, 1, `cell ${i},${j} at level ${level}: ${hits.length} tops`);
          const h = lt.terrain.heightAt(m.x0 + cx, m.z0 + cz);
          assert.ok(Math.abs(hits[0].y0 - (h < SEA_LEVEL ? LOD_WATER_TOP : h + 1)) < 1e-4, `cell ${i},${j}: top ${hits[0].y0}, ground ${h}`);
        }
      }
      assert.equal(m.span, tileSpan(level));
    }
  });

  await test("walls exactly cover every height step inside a tile, and skirts close every border", () => {
    const lt = new LodTerrain(seed);
    for (const level of [1, 3]) {
      const m = buildLodTile(lt, level, 3, -2, pal);
      const step = 1 << level;
      const N = LOD_CELLS;
      const heights = [];
      for (let j = 0; j < N; j++) {
        const row = [];
        for (let i = 0; i < N; i++) {
          const out = {};
          lt.sample(m.x0 + i * step + step / 2, m.z0 + j * step + step / 2, out);
          row.push(out.top);
        }
        heights.push(row);
      }
      let expected = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          if (i + 1 < N) expected += Math.abs(heights[j][i + 1] - heights[j][i]) * step;
          if (j + 1 < N) expected += Math.abs(heights[j + 1][i] - heights[j][i]) * step;
        }
      }
      const walls = facesOf(m).filter((f) => f.normal !== 2 && f.kind !== LOD_KIND.LEAVES && !(f.x1 - f.x0 < 1 && f.z1 - f.z0 < 1));
      const onBorder = (f) => (f.normal < 2 ? f.x0 === 0 || f.x0 === N * step : f.z0 === 0 || f.z0 === N * step);
      const inner = walls.filter((f) => !onBorder(f));
      const border = walls.filter((f) => !inner.includes(f));
      const area = inner.reduce((a, f) => a + (f.y1 - f.y0) * Math.max(f.x1 - f.x0, f.z1 - f.z0), 0);
      assert.ok(Math.abs(area - expected) < 1e-3, `level ${level}: wall area ${area} vs height steps ${expected}`);
      // Skirts: along each of the 4 borders, walls cover the full length,
      // reaching from below the lowest top in the tile up to each cell's top.
      const lowest = Math.min(...heights.flat());
      for (const [normal, len] of [[0, N * step], [1, N * step], [4, N * step], [5, N * step]]) {
        const side = border.filter((f) => f.normal === normal && (normal < 2 ? f.x0 === (normal === 0 ? N * step : 0) : f.z0 === (normal === 4 ? N * step : 0)));
        const covered = side.reduce((a, f) => a + Math.max(f.x1 - f.x0, f.z1 - f.z0), 0);
        assert.equal(covered, len, `level ${level}: skirt ${normal} covers ${covered} of ${len}`);
        for (const f of side) assert.ok(f.y0 <= lowest - step, "skirts reach below the tile's lowest surface");
      }
    }
  });

  await test("trees become canopy boxes on near levels and a grass tint far away", () => {
    const lt = new LodTerrain(seed);
    const near = buildLodTile(lt, 2, 0, 0, pal);
    const leaves = facesOf(near).filter((f) => f.kind === LOD_KIND.LEAVES).length;
    let trees = 0;
    for (let z = 0; z < near.span; z++) for (let x = 0; x < near.span; x++) if (lt.treeAt(x, z) && lt.terrain.heightAt(x, z) >= SEA_LEVEL) trees++;
    assert.ok(trees > 5 && leaves >= trees * 5, `${trees} trees, ${leaves} leaf faces`);
    const far = buildLodTile(lt, 4, 0, 0, pal);
    assert.equal(facesOf(far).filter((f) => f.kind === LOD_KIND.LEAVES).length, 0);
  });

  await test("player edits show in distant terrain: a crater lowers the surface and felled trees disappear", () => {
    const lt = new LodTerrain(seed);
    // Find a tree and dig out its whole chunk down to y = 10.
    let tree = null;
    for (let z = 0; z < 512 && !tree; z++) for (let x = 0; x < 512 && !tree; x++) if (lt.treeAt(x, z)) tree = [x, z];
    assert.ok(tree, "no tree found");
    const cx = tree[0] >> 4;
    const cz = tree[1] >> 4;
    const list = [];
    for (let y = 10; y < 64; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) list.push((y * 16 + z) * 16 + x, BLOCK.AIR);
    lt.setChunkEdits(`${cx},${cz}`, list);
    const out = {};
    lt.sample(cx * 16 + 5, cz * 16 + 7, out);
    assert.equal(out.top, 10);
    assert.equal(lt.treeAt(tree[0], tree[1]), null);
    lt.setChunkEdits(`${cx},${cz}`, []);
    assert.ok(lt.treeAt(tree[0], tree[1]), "clearing the edits restores the tree");
  });
}

console.log("\nFlowing water (watersim.js)");
{
  const { WaterSim, MAX_FLOW_DISTANCE } = await import("../js/watersim.js");
  const { BLOCK } = await import("../js/blocks.js");

  // A minimal stand-in for World: a sparse block map plus the same
  // getChunk/getBlock/setBlock/changeListeners contract WaterSim relies on.
  class FakeWorld {
    constructor() {
      this.blocks = new Map();
      this.loaded = new Set();
      this.changeListeners = [];
    }
    k(x, y, z) {
      return `${x},${y},${z}`;
    }
    load(cx, cz) {
      this.loaded.add(`${cx},${cz}`);
    }
    getChunk(cx, cz) {
      return this.loaded.has(`${cx},${cz}`) || undefined;
    }
    getBlock(x, y, z) {
      return this.blocks.get(this.k(x, y, z)) ?? BLOCK.AIR;
    }
    setBlock(x, y, z, id) {
      const key = this.k(x, y, z);
      if (this.blocks.get(key) === id) return false;
      this.blocks.set(key, id);
      const changed = [x, y, z];
      for (const fn of this.changeListeners) fn(changed);
      return true;
    }
  }
  const floor = (w, x0, x1, y, z0, z1) => {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) w.setBlock(x, y, z, BLOCK.STONE);
  };
  const loadArea = (w, x0, x1, z0, z1) => {
    for (let x = (x0 >> 4) - 1; x <= (x1 >> 4) + 1; x++) for (let z = (z0 >> 4) - 1; z <= (z1 >> 4) + 1; z++) w.load(x, z);
  };
  const drain = (sim, max = 2000) => {
    let steps = 0;
    while (sim.activeCount > 0 && steps++ < max) sim.update(9999);
    return steps;
  };

  await test("water falls to fill a hole dug beneath it, instead of floating", () => {
    const w = new FakeWorld();
    loadArea(w, -5, 5, -5, 5);
    floor(w, -3, 3, 10, -3, 3);
    w.setBlock(0, 11, 0, BLOCK.WATER); // resting on the floor
    const sim = new WaterSim(w);
    // Dig a 3-deep hole under the water (as an explosion would), then let it react.
    w.setBlock(0, 10, 0, BLOCK.AIR);
    w.setBlock(0, 9, 0, BLOCK.AIR);
    w.setBlock(0, 8, 0, BLOCK.AIR);
    drain(sim);
    assert.equal(w.getBlock(0, 11, 0), BLOCK.WATER, "the original water should still be there");
    assert.equal(w.getBlock(0, 10, 0), BLOCK.WATER, "water should fall into the hole below it");
    assert.equal(w.getBlock(0, 9, 0), BLOCK.WATER);
    assert.equal(w.getBlock(0, 8, 0), BLOCK.WATER, "water should reach the bottom of the hole");
  });

  await test("water spreads sideways from a source up to a limited distance, and no farther", () => {
    const w = new FakeWorld();
    loadArea(w, -2, 20, -2, 2);
    floor(w, -1, 20, 10, -1, 1);
    w.setBlock(0, 11, 0, BLOCK.WATER);
    const sim = new WaterSim(w);
    sim.active.add(sim._key(0, 11, 0)); // wake it manually: it was placed before the sim existed
    drain(sim);
    for (let x = 1; x <= MAX_FLOW_DISTANCE; x++) assert.equal(w.getBlock(x, 11, 0), BLOCK.WATER, `should have reached x=${x}`);
    assert.equal(w.getBlock(MAX_FLOW_DISTANCE + 1, 11, 0), BLOCK.AIR, "flow should stop at its maximum distance");
  });

  await test("a flow dries up once its source is removed", () => {
    const w = new FakeWorld();
    loadArea(w, -2, 8, -2, 2);
    floor(w, -1, 8, 10, -1, 1);
    w.setBlock(0, 11, 0, BLOCK.WATER);
    const sim = new WaterSim(w);
    sim.active.add(sim._key(0, 11, 0));
    drain(sim);
    assert.equal(w.getBlock(2, 11, 0), BLOCK.WATER, "sanity: the flow should have spread first");
    w.setBlock(0, 11, 0, BLOCK.AIR); // remove the source
    drain(sim);
    for (let x = 0; x <= MAX_FLOW_DISTANCE; x++) assert.equal(w.getBlock(x, 11, 0), BLOCK.AIR, `x=${x} should have dried up`);
  });

  await test("original terrain water never dries up on its own (an untouched lake stays full)", () => {
    const w = new FakeWorld();
    loadArea(w, -2, 2, -2, 2);
    floor(w, -1, 1, 10, -1, 1);
    w.setBlock(0, 11, 0, BLOCK.WATER);
    const sim = new WaterSim(w);
    // Wake it without any real edit nearby (as a neighboring, unrelated dig might).
    sim.active.add(sim._key(0, 11, 0));
    drain(sim);
    assert.equal(w.getBlock(0, 11, 0), BLOCK.WATER, "an original water block with solid support should never dry up");
  });

  await test("update() only processes a bounded number of cells per call (throttled)", () => {
    const w = new FakeWorld();
    loadArea(w, -2, 30, -2, 2);
    floor(w, -1, 30, 10, -1, 1);
    w.setBlock(0, 11, 0, BLOCK.WATER);
    const sim = new WaterSim(w);
    sim.active.add(sim._key(0, 11, 0));
    let calls = 0;
    while (sim.activeCount > 0 && calls < 50) {
      const before = sim.processed;
      sim.update(1); // a budget of exactly one cell per call
      assert.ok(sim.processed - before <= 1, "a budget of 1 should tick at most one cell per call");
      calls++;
    }
    assert.ok(calls > 1, `spreading across several cells should take more than one throttled call (took ${calls})`);
  });
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
