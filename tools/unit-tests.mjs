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

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
