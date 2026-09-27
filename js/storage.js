// localStorage persistence for block edits and settings, scoped per world seed.
// All keys are prefixed to avoid clashing with anything else on the page's origin.
//
// In memory, edits are a Map<chunkKey, Map<localBlockIndex, blockId>> so a
// newly generated chunk can apply just its own edits in O(its edits).
//
// On disk (format v2), each chunk's edits are run-length encoded: records of
// [index lo byte, index hi byte, run length, block id] for runs of
// consecutive block indices that share the same id, base64-encoded. A Blast
// Orb crater (~2000 blocks) compresses to ~1 KB instead of ~24 KB as the
// original flat JSON array, which matters against the ~5 MB storage quota.
// The original v1 format (a flat [x,y,z,id, ...] array) is still read.
import { CHUNK_SIZE, WORLD_HEIGHT, blockIndex, floorDiv, chunkKey } from "./constants.js";

const PREFIX = "voxelands_v1_";
const BLOCKS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

export function editsKey(seed) {
  return `${PREFIX}edits_${seed}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const STEP = 0x8000; // stay well under engine argument-count limits
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.slice(i, i + STEP));
  }
  return btoa(binary);
}

function base64ToBytes(str) {
  const binary = atob(str);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeChunkEdits(map) {
  const indices = [...map.keys()].sort((a, b) => a - b);
  const bytes = [];
  let i = 0;
  while (i < indices.length) {
    const start = indices[i];
    const id = map.get(start);
    let len = 1;
    while (i + len < indices.length && len < 255 && indices[i + len] === start + len && map.get(indices[i + len]) === id) {
      len++;
    }
    bytes.push(start & 0xff, start >> 8, len, id);
    i += len;
  }
  return bytesToBase64(bytes);
}

export function decodeChunkEdits(str) {
  const map = new Map();
  const bytes = base64ToBytes(str);
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const start = bytes[i] | (bytes[i + 1] << 8);
    const len = bytes[i + 2];
    const id = bytes[i + 3];
    for (let k = 0; k < len && start + k < BLOCKS_PER_CHUNK; k++) map.set(start + k, id);
  }
  return map;
}

export function setEdit(edits, cx, cz, index, id) {
  const key = chunkKey(cx, cz);
  let map = edits.get(key);
  if (!map) {
    map = new Map();
    edits.set(key, map);
  }
  map.set(index, id);
}

function editsFromLegacyArray(arr) {
  const edits = new Map();
  for (let i = 0; i + 3 < arr.length; i += 4) {
    const wx = arr[i];
    const wy = arr[i + 1];
    const wz = arr[i + 2];
    const id = arr[i + 3];
    if (![wx, wy, wz, id].every(Number.isInteger) || wy < 0 || wy >= WORLD_HEIGHT || id < 0 || id > 255) continue;
    const cx = floorDiv(wx, CHUNK_SIZE);
    const cz = floorDiv(wz, CHUNK_SIZE);
    setEdit(edits, cx, cz, blockIndex(wx - cx * CHUNK_SIZE, wy, wz - cz * CHUNK_SIZE), id);
  }
  return edits;
}

// Accepts parsed JSON in either format; returns the in-memory Map form.
export function parseEdits(data) {
  if (Array.isArray(data)) return editsFromLegacyArray(data);
  const edits = new Map();
  if (!data || data.v !== 2 || typeof data.chunks !== "object" || data.chunks === null) return edits;
  for (const [key, encoded] of Object.entries(data.chunks)) {
    if (typeof encoded !== "string" || !/^-?\d+,-?\d+$/.test(key)) continue;
    try {
      edits.set(key, decodeChunkEdits(encoded));
    } catch (err) {
      // One corrupted chunk shouldn't discard the rest of the world's edits.
      console.warn(`Voxelands: skipping unreadable saved edits for chunk ${key}`, err);
    }
  }
  return edits;
}

// Serializes edits to the v2 format. `cache` (Map<chunkKey, string>) keeps
// each chunk's encoded form between saves so only `dirtyKeys` get re-encoded.
export function serializeEdits(edits, cache = null, dirtyKeys = null) {
  const chunks = {};
  for (const [key, map] of edits) {
    if (map.size === 0) continue;
    let encoded = cache && (!dirtyKeys || !dirtyKeys.has(key)) ? cache.get(key) : undefined;
    if (encoded === undefined) {
      encoded = encodeChunkEdits(map);
      if (cache) cache.set(key, encoded);
    }
    chunks[key] = encoded;
  }
  return { v: 2, chunks };
}

export function loadEdits(seed) {
  try {
    const raw = localStorage.getItem(editsKey(seed));
    if (!raw) return new Map();
    return parseEdits(JSON.parse(raw));
  } catch (err) {
    console.warn("Voxelands: failed to load saved edits", err);
    return new Map();
  }
}

export function saveEdits(seed, edits, cache = null, dirtyKeys = null) {
  try {
    localStorage.setItem(editsKey(seed), JSON.stringify(serializeEdits(edits, cache, dirtyKeys)));
    return true;
  } catch (err) {
    console.warn("Voxelands: failed to save world edits (storage full or unavailable)", err);
    return false;
  }
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(`${PREFIX}settings`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(`${PREFIX}settings`, JSON.stringify(settings));
  } catch (err) {
    console.warn("Voxelands: failed to save settings", err);
  }
}

// Player state per world: game mode, position, view, health, breath,
// inventory, selected slot and time of day. Small JSON; saved alongside edits.
export function playerKey(seed) {
  return `${PREFIX}player_${seed}`;
}

export function loadPlayer(seed) {
  try {
    const raw = localStorage.getItem(playerKey(seed));
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === "object" && data.v === 1 ? data : null;
  } catch (err) {
    return null;
  }
}

export function savePlayer(seed, data) {
  try {
    localStorage.setItem(playerKey(seed), JSON.stringify({ v: 1, ...data }));
    return true;
  } catch (err) {
    console.warn("Voxelands: failed to save player state", err);
    return false;
  }
}
