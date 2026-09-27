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

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
