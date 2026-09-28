// The voxel world: chunk streaming, block access and edits, lighting,
// meshing, persistence of edits, and ray casting.
//
// Chunk pipeline: a chunk is *generated* (terrain + saved edits + light)
// within renderDistance + 1.5 chunks, and *meshed* once all 8 of its
// neighbors are generated (meshing reads a 1-block border from them for
// face culling, ambient occlusion and smooth light). So each chunk is
// normally meshed exactly once, and the border of loaded terrain is never
// visible with wrong faces or lighting.
import {
  BLOCK,
  BLOCK_INFO,
  IS_SOLID,
  IS_SELECTABLE,
  SHAPE_OF,
  SHAPE,
  TILE,
  isSupportedBy,
} from "./blocks.js";
import { Chunk } from "./chunk.js";
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, blockIndex, floorDiv, chunkKey } from "./constants.js";
import { setEdit } from "./storage.js";
import { TerrainGenerator } from "./terrain.js";
import { LightEngine, sampleLight } from "./light.js";
import { meshChunk } from "./mesher.js";
import { buildBlockTextures } from "./textures.js";
import { createChunkMaterials } from "./shaders.js";

export { SEA_LEVEL };

// Numeric chunk-map keys (much cheaper than strings in the hot paths).
const KEY_OFFSET = 1048576; // 2^20 chunks each way
function numKey(cx, cz) {
  return (cx + KEY_OFFSET) * 2097152 + (cz + KEY_OFFSET);
}

// A streaming plan that meshes every chunk within `r` chunks of the player
// (see World.ensureChunksAround), cached per distance.
const circlePlans = new Map();
function circlePlan(r) {
  let plan = circlePlans.get(r);
  if (!plan) {
    plan = { id: `circle:${r}`, reach: r, meshed: (cx, cz, dx, dz) => dx * dx + dz * dz <= r * r };
    circlePlans.set(r, plan);
  }
  return plan;
}

// Max filter of radius r over a W x W grid of 0/1 flags (square neighborhood).
function dilate(grid, W, r) {
  const tmp = new Uint8Array(W * W);
  const out = new Uint8Array(W * W);
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      if (!grid[z * W + x]) continue;
      for (let i = Math.max(0, x - r); i <= Math.min(W - 1, x + r); i++) tmp[z * W + i] = 1;
    }
  }
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      if (!tmp[z * W + x]) continue;
      for (let j = Math.max(0, z - r); j <= Math.min(W - 1, z + r); j++) out[j * W + x] = 1;
    }
  }
  return out;
}

// Selection boxes for non-cube shapes: [minX, minY, minZ, maxX, maxY, maxZ].
const SELECTION = {
  [SHAPE.CUBE]: [0, 0, 0, 1, 1, 1],
  [SHAPE.CROSS]: [0.15, 0, 0.15, 0.85, 0.8, 0.85],
  [SHAPE.TORCH]: [6 / 16, 0, 6 / 16, 10 / 16, 11 / 16, 10 / 16],
};

export function selectionBox(id) {
  return SELECTION[SHAPE_OF[id]] || SELECTION[SHAPE.CUBE];
}

const EDIT_REMESH_AT_ONCE = 8; // chunks rebuilt immediately after an edit
const EDIT_REMESH_BUDGET_MS = 10; // extra per-frame time for rebuilding after huge edits

export class World {
  constructor(scene, seed) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.terrain = new TerrainGenerator(this.seed);
    this.chunks = new Map(); // numKey -> Chunk
    // Player/explosion edits on top of generated terrain, grouped per chunk:
    // Map<chunkKey string, Map<localBlockIndex, blockId>> (see storage.js).
    this.edits = new Map();
    this.dirtyEditChunks = new Set(); // chunk keys with edits not yet saved

    const { texture, reliefTexture, canvases, blockColors, facePalette } = buildBlockTextures();
    this.atlas = texture;
    this.relief = reliefTexture;
    this.tileCanvases = canvases;
    this.blockColors = blockColors; // blockId -> [r,g,b] sRGB 0-1
    this.facePalette = facePalette; // linear top/side colors per block (distant terrain)
    this.materials = createChunkMaterials(texture, TILE.water, reliefTexture);
    this.meshOptions = { fancyLeaves: false }; // see mesher.js; setMeshOptions() rebuilds
    this.light = new LightEngine(this);

    this.genQueue = []; // { cx, cz, dist }
    this.genQueued = new Set(); // numKeys
    this.meshQueue = []; // chunks awaiting their first mesh
    this.meshQueued = new Set();
    this.remeshQueue = new Set(); // rebuilds from background light changes (budgeted)
    this.editRemeshQueue = new Set(); // rebuilds from block edits (next frame, unbudgeted)
    this.stats = { lastEditRemeshCount: 0, lastEditRemeshMs: 0, meshes: 0, generated: 0 };
    this._nb = new Array(9).fill(null);
    this._planCx = null;
    this._planCz = null;
    this._planId = null;
    this._meshSet = new Set(); // numKeys of the chunks the current plan meshes
    this._keep = null; // chunks the current plan keeps loaded
    this.keepChunk = null; // (chunk) => true to keep a chunk loaded outside the plan
    this.chunksHidden = false; // new chunks start hidden (the LOD system shows them)

    this.onEdit = null; // () => void, after any recorded edit
    this.onBlockPopped = null; // (x, y, z, id) when a torch/plant loses its support
    this.changeListeners = []; // fns called with (flat [x, y, z, ...]) after every edit batch
  }

  key(cx, cz) {
    return numKey(cx, cz);
  }

  getChunk(cx, cz) {
    return this.chunks.get(numKey(cx, cz));
  }

  heightAt(wx, wz) {
    return this.terrain.heightAt(wx, wz);
  }

  getBlock(wx, wy, wz) {
    if (wy < 0) return BLOCK.BEDROCK;
    if (wy >= WORLD_HEIGHT) return BLOCK.AIR;
    wx = Math.floor(wx);
    wz = Math.floor(wz);
    const chunk = this.chunks.get(numKey(wx >> 4, wz >> 4));
    if (!chunk) return BLOCK.AIR;
    return chunk.blocks[(Math.floor(wy) << 8) | ((wz & 15) << 4) | (wx & 15)];
  }

  isSolidAt(wx, wy, wz) {
    return IS_SOLID[this.getBlock(wx, wy, wz)] === 1;
  }

  // Light at a block position: { sky, block } (0-15).
  lightAt(wx, wy, wz) {
    return sampleLight(this, Math.floor(wx), Math.floor(wy), Math.floor(wz));
  }

  // Highest y whose block is solid in column (wx, wz), or -1.
  surfaceY(wx, wz) {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) if (this.isSolidAt(wx, y, wz)) return y;
    return -1;
  }

  setBlock(wx, wy, wz, id, opts) {
    return this.setBlocks([wx, wy, wz, id], opts) > 0;
  }

  // Like setBlock, but also works for a column whose chunk hasn't generated
  // yet: the edit is simply recorded (like a saved edit) and applied
  // automatically once that chunk streams in. Used for explosions that land
  // beyond the loaded terrain, out in distant/LOD ground.
  queueEdit(x, y, z, id) {
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const cx = x >> 4;
    const cz = z >> 4;
    if (this.getChunk(cx, cz)) {
      this.setBlocks([x, y, z, id]);
      return;
    }
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    setEdit(this.edits, cx, cz, blockIndex(lx, y, lz), id);
    this.dirtyEditChunks.add(chunkKey(cx, cz));
    if (this.onEdit) this.onEdit();
  }

  // Bulk edit: `list` is a flat [x, y, z, id, ...] array. Blocks in unloaded
  // chunks are skipped. Torches/plants left without support pop off. Light
  // is updated once for the whole batch, and every affected chunk (plus
  // border neighbors) is queued for a rebuild. Returns the number of blocks
  // that actually changed.
  setBlocks(list, { recordEdit = true } = {}) {
    const changed = [];
    const apply = (x, y, z, id) => {
      if (y < 0 || y >= WORLD_HEIGHT) return false;
      const chunk = this.getChunk(x >> 4, z >> 4);
      if (!chunk) return false;
      const lx = x & 15;
      const lz = z & 15;
      const idx = blockIndex(lx, y, lz);
      if (chunk.blocks[idx] === id) return false;
      chunk.blocks[idx] = id;
      changed.push(x, y, z);
      if (recordEdit) {
        setEdit(this.edits, chunk.cx, chunk.cz, idx, id);
        this.dirtyEditChunks.add(chunk.key);
      }
      this._queueEditRemesh(chunk, lx, lz);
      return true;
    };
    for (let i = 0; i < list.length; i += 4) apply(Math.floor(list[i]), Math.floor(list[i + 1]), Math.floor(list[i + 2]), list[i + 3]);
    // Blocks that needed support from a block that just changed pop off.
    for (let i = 0; i < changed.length; i += 3) {
      const x = changed[i];
      const y = changed[i + 1] + 1;
      const z = changed[i + 2];
      const above = this.getBlock(x, y, z);
      if (BLOCK_INFO[above]?.support && !isSupportedBy(above, this.getBlock(x, y - 1, z))) {
        if (apply(x, y, z, BLOCK.AIR) && this.onBlockPopped) this.onBlockPopped(x, y, z, above);
      }
    }
    if (changed.length === 0) return 0;
    for (const c of this.light.applyChanges(changed)) {
      if (c.meshed) this.editRemeshQueue.add(c);
    }
    if (recordEdit && this.onEdit) this.onEdit();
    for (const fn of this.changeListeners) fn(changed);
    return changed.length / 3;
  }

  _queueEditRemesh(chunk, lx, lz) {
    if (chunk.meshed) this.editRemeshQueue.add(chunk);
    const dx = lx === 0 ? -1 : lx === 15 ? 1 : 0;
    const dz = lz === 0 ? -1 : lz === 15 ? 1 : 0;
    if (dx === 0 && dz === 0) return;
    const add = (cx, cz) => {
      const n = this.getChunk(cx, cz);
      if (n && n.meshed) this.editRemeshQueue.add(n);
    };
    if (dx) add(chunk.cx + dx, chunk.cz);
    if (dz) add(chunk.cx, chunk.cz + dz);
    if (dx && dz) add(chunk.cx + dx, chunk.cz + dz);
  }

  // ---------- Streaming ----------

  // Plans chunk loading/unloading around the player. `plan` says which
  // chunks get meshes: either a render distance (every chunk within it), or
  // { id, reach, meshed(cx, cz, dx, dz) } from the LOD system (dx, dz: the
  // offset from the player's chunk) (the detailed area
  // around the player; `reach` bounds it in chunks, and `id` changes
  // whenever the area does). The 8 neighbors of every meshed chunk are
  // generated as well, and chunks farther than 3 from any meshed chunk are
  // unloaded (unless keepChunk(chunk) still wants them). Cheap to call every
  // frame: re-planning only runs when the player crosses into another chunk
  // or the plan changes.
  ensureChunksAround(px, pz, plan) {
    if (typeof plan === "number") plan = circlePlan(plan);
    const pcx = floorDiv(px, CHUNK_SIZE);
    const pcz = floorDiv(pz, CHUNK_SIZE);
    if (pcx === this._planCx && pcz === this._planCz && plan.id === this._planId) return;
    this._planCx = pcx;
    this._planCz = pcz;
    this._planId = plan.id;

    // Flags on a square grid around the player: meshed, generated (meshed
    // dilated by 1), kept (meshed dilated by 3).
    const R = Math.ceil(plan.reach) + 3;
    const W = 2 * R + 1;
    const meshed = new Uint8Array(W * W);
    this._meshSet = new Set();
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > (plan.reach + 1) * (plan.reach + 1)) continue;
        if (!plan.meshed(pcx + dx, pcz + dz, dx, dz)) continue;
        meshed[(dz + R) * W + (dx + R)] = 1;
        this._meshSet.add(numKey(pcx + dx, pcz + dz));
      }
    }
    const data = dilate(meshed, W, 1);
    const keep = dilate(meshed, W, 3);
    const flag = (grid, cx, cz) => {
      const dx = cx - pcx;
      const dz = cz - pcz;
      return dx >= -R && dx <= R && dz >= -R && dz <= R && grid[(dz + R) * W + (dx + R)] === 1;
    };
    this._keep = { grid: keep, flag };
    const dist2 = (cx, cz) => (cx - pcx) * (cx - pcx) + (cz - pcz) * (cz - pcz);

    this.genQueue = this.genQueue.filter((e) => {
      e.dist = dist2(e.cx, e.cz);
      if (!flag(data, e.cx, e.cz)) {
        this.genQueued.delete(numKey(e.cx, e.cz));
        return false;
      }
      return true;
    });
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (data[(dz + R) * W + (dx + R)] !== 1) continue;
        const k = numKey(pcx + dx, pcz + dz);
        if (!this.chunks.has(k) && !this.genQueued.has(k)) {
          this.genQueue.push({ cx: pcx + dx, cz: pcz + dz, dist: dx * dx + dz * dz });
          this.genQueued.add(k);
        }
      }
    }
    this.genQueue.sort((a, b) => a.dist - b.dist);

    this.releaseChunks();

    // Rebuild the mesh queue: ready, unmeshed chunks in the meshed area, nearest first.
    this.meshQueue = [];
    this.meshQueued.clear();
    for (const chunk of this.chunks.values()) {
      if (!chunk.meshed && this._meshSet.has(numKey(chunk.cx, chunk.cz)) && this._isReady(chunk)) {
        this.meshQueue.push(chunk);
        this.meshQueued.add(chunk);
      }
    }
    this.meshQueue.sort((a, b) => dist2(a.cx, a.cz) - dist2(b.cx, b.cz));
  }

  // Unloads chunks well outside the meshed area (unless keepChunk still
  // wants them, e.g. while they stand in for distant terrain being built).
  releaseChunks() {
    if (!this._keep) return 0;
    const { grid, flag } = this._keep;
    let n = 0;
    for (const [k, chunk] of this.chunks) {
      if (flag(grid, chunk.cx, chunk.cz) || (this.keepChunk && this.keepChunk(chunk))) continue;
      this.scene.remove(chunk.group);
      chunk.dispose();
      this.chunks.delete(k);
      this.remeshQueue.delete(chunk);
      this.editRemeshQueue.delete(chunk);
      n++;
    }
    return n;
  }

  // Changes how chunks are meshed (e.g. fancy leaves) and queues every
  // meshed chunk for a rebuild (spread over frames by processQueues).
  setMeshOptions(options) {
    const next = { ...this.meshOptions, ...options };
    if (Object.keys(next).every((k) => next[k] === this.meshOptions[k])) return;
    this.meshOptions = next;
    for (const chunk of this.chunks.values()) if (chunk.meshed) this.remeshQueue.add(chunk);
  }

  // True if the current plan wants chunk (cx, cz) meshed.
  wantsMesh(cx, cz) {
    return this._meshSet.has(numKey(cx, cz));
  }

  _isReady(chunk) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!this.chunks.has(numKey(chunk.cx + dx, chunk.cz + dz))) return false;
      }
    }
    return true;
  }

  _dist2(chunk) {
    const dx = chunk.cx - this._planCx;
    const dz = chunk.cz - this._planCz;
    return dx * dx + dz * dz;
  }

  _inMeshRange(chunk) {
    return this._meshSet.has(numKey(chunk.cx, chunk.cz));
  }

  // Generates and meshes queued chunks until `budgetMs` of main-thread time
  // has been spent this frame (always at least one unit of work if any is
  // pending). Chunks changed by block edits are rebuilt first and without a
  // budget, so the player sees their own edits immediately.
  processQueues(budgetMs = 4) {
    const start = performance.now();
    if (this.editRemeshQueue.size > 0) {
      // Everyday edits (a few chunks) rebuild at once. A huge blast touches
      // dozens of chunks: those are spread over several frames, nearest
      // first, within a time budget.
      let list = [...this.editRemeshQueue];
      if (list.length > EDIT_REMESH_AT_ONCE) list.sort((a, b) => this._dist2(a) - this._dist2(b));
      let n = 0;
      for (const chunk of list) {
        if (n >= EDIT_REMESH_AT_ONCE && performance.now() - start > EDIT_REMESH_BUDGET_MS) break;
        if (this.chunks.get(numKey(chunk.cx, chunk.cz)) === chunk) this._buildMesh(chunk);
        this.editRemeshQueue.delete(chunk);
        n++;
      }
      list = null;
      this.stats.lastEditRemeshCount = n;
      this.stats.lastEditRemeshMs = performance.now() - start;
      if (this.editRemeshQueue.size > 0) this.stats.spreadRemeshFrames = (this.stats.spreadRemeshFrames || 0) + 1;
    }

    let didWork = false;
    while (!didWork || performance.now() - start < budgetMs) {
      // Drop stale mesh-queue entries (already meshed or unloaded).
      while (this.meshQueue.length > 0) {
        const c = this.meshQueue[0];
        if (!c.meshed && this.chunks.get(numKey(c.cx, c.cz)) === c) break;
        this.meshQueued.delete(this.meshQueue.shift());
      }
      const nextMesh = this.meshQueue[0];
      const nextGen = this.genQueue[0];
      // Prefer meshing nearby ready chunks over generating farther ones.
      if (nextMesh && (!nextGen || this._dist2(nextMesh) <= nextGen.dist + 2)) {
        this.meshQueue.shift();
        this._buildMesh(nextMesh);
      } else if (nextGen) {
        this.genQueue.shift();
        this.genQueued.delete(numKey(nextGen.cx, nextGen.cz));
        this._generate(nextGen.cx, nextGen.cz);
      } else if (this.remeshQueue.size > 0) {
        const chunk = this.remeshQueue.values().next().value;
        this.remeshQueue.delete(chunk);
        if (chunk.meshed) this._buildMesh(chunk);
      } else {
        break;
      }
      didWork = true;
    }
  }

  // Synchronously generates (radius r + 1) and meshes (radius r) the chunks
  // around a world position, so the player can be placed there right away
  // (at startup, or when respawning far from where they died).
  prepareArea(wx, wz, r = 2) {
    const pcx = floorDiv(Math.floor(wx), CHUNK_SIZE);
    const pcz = floorDiv(Math.floor(wz), CHUNK_SIZE);
    for (let dz = -r - 1; dz <= r + 1; dz++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) this._generate(pcx + dx, pcz + dz);
    }
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const chunk = this.getChunk(pcx + dx, pcz + dz);
        if (chunk && (!chunk.meshed || this.remeshQueue.has(chunk))) this._buildMesh(chunk);
      }
    }
  }

  // True once every chunk within the render distance is generated and meshed.
  get isIdle() {
    return this.genQueue.length === 0 && this.meshQueue.length === 0 && this.editRemeshQueue.size === 0;
  }

  _generate(cx, cz) {
    const k = numKey(cx, cz);
    if (this.chunks.has(k)) return;
    const chunk = new Chunk(cx, cz);
    this.terrain.generate(chunk);
    this.applyStoredEdits(chunk);
    this.chunks.set(k, chunk);
    chunk.generated = true;
    this.stats.generated++;
    for (const c of this.light.initChunk(chunk)) {
      if (c.meshed) this.remeshQueue.add(c);
    }
    if (this.chunksHidden) chunk.group.visible = false;
    this.scene.add(chunk.group);
    // This chunk, or a neighbor that was waiting on it, may now be meshable.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunks.get(numKey(cx + dx, cz + dz));
        if (n && !n.meshed && !this.meshQueued.has(n) && this._inMeshRange(n) && this._isReady(n)) {
          this.meshQueue.push(n);
          this.meshQueued.add(n);
        }
      }
    }
  }

  _buildMesh(chunk) {
    const nb = this._nb;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) nb[(dz + 1) * 3 + (dx + 1)] = this.chunks.get(numKey(chunk.cx + dx, chunk.cz + dz)) || null;
    }
    chunk.applyMesh(meshChunk(nb, this.meshOptions), this.materials);
    chunk.meshed = true;
    chunk.meshCount = (chunk.meshCount || 0) + 1; // lets caches of chunk contents (grass.js) notice rebuilds
    this.meshQueued.delete(chunk);
    this.remeshQueue.delete(chunk);
    this.stats.meshes++;
  }

  applyStoredEdits(chunk) {
    const map = this.edits.get(chunk.key);
    if (!map) return;
    for (const [index, id] of map) chunk.blocks[index] = id;
  }

  // Replaces the in-memory edits with ones loaded from storage (called before
  // any chunk is generated, so they're applied as chunks stream in).
  loadEdits(edits) {
    this.edits = edits;
  }

  // Block id at (x, y, z) for ray casting: the real block where its chunk is
  // loaded, otherwise an approximate solid/air guess from the deterministic
  // height map (so hitscan weapons and projectiles can still hit distant,
  // unloaded/LOD terrain instead of sailing through it forever).
  _castBlock(x, y, z, heightfield) {
    if (y < 0) return BLOCK.BEDROCK;
    if (y >= WORLD_HEIGHT) return BLOCK.AIR;
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk) return chunk.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
    if (!heightfield) return BLOCK.AIR;
    return y <= this.heightAt(x, z) ? BLOCK.STONE : BLOCK.AIR;
  }

  // Voxel traversal ray cast (Amanatides & Woo). Returns
  // { block: [x,y,z], place: [x,y,z], normal: [x,y,z], id, distance } for
  // the first selectable block (non-cube blocks use their selection box), or null.
  // solidOnly: pass through non-solid blocks (plants, torches), e.g. for bullets.
  // heightfield: beyond loaded terrain, hit-test against the height map
  // instead of always passing through (on by default; block-placement/mining
  // reach never needs it since it never sees unloaded chunks).
  raycast(origin, direction, maxDistance = 6, { solidOnly = false, heightfield = true } = {}) {
    const dir = direction.clone().normalize();
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.y > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;
    let tMaxX = dir.x !== 0 ? (stepX > 0 ? x + 1 - origin.x : origin.x - x) * tDeltaX : Infinity;
    let tMaxY = dir.y !== 0 ? (stepY > 0 ? y + 1 - origin.y : origin.y - y) * tDeltaY : Infinity;
    let tMaxZ = dir.z !== 0 ? (stepZ > 0 ? z + 1 - origin.z : origin.z - z) * tDeltaZ : Infinity;
    let normal = null;
    let t = 0;
    while (t <= maxDistance) {
      const id = this._castBlock(x, y, z, heightfield);
      if (IS_SELECTABLE[id] && (!solidOnly || IS_SOLID[id])) {
        const hitT = SHAPE_OF[id] === SHAPE.CUBE ? t : rayBox(origin, dir, x, y, z, selectionBox(id));
        if (hitT !== null && hitT <= maxDistance) {
          const n = normal || [0, 0, 0];
          return {
            block: [x, y, z],
            place: normal ? [x + n[0], y + n[1], z + n[2]] : [x, y, z],
            normal: n,
            id,
            distance: hitT,
          };
        }
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX;
        t = tMaxX;
        tMaxX += tDeltaX;
        normal = [-stepX, 0, 0];
      } else if (tMaxY < tMaxZ) {
        y += stepY;
        t = tMaxY;
        tMaxY += tDeltaY;
        normal = [0, -stepY, 0];
      } else {
        z += stepZ;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        normal = [0, 0, -stepZ];
      }
    }
    return null;
  }
}

// Ray vs. an axis-aligned box inside block (bx, by, bz); returns the entry t or null.
function rayBox(origin, dir, bx, by, bz, box) {
  let tmin = 0;
  let tmax = Infinity;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const lo = [bx + box[0], by + box[1], bz + box[2]];
  const hi = [bx + box[3], by + box[4], bz + box[5]];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return null;
      continue;
    }
    let t1 = (lo[a] - o[a]) / d[a];
    let t2 = (hi[a] - o[a]) / d[a];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
