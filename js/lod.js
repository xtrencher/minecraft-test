// Level of detail: full-detail chunks near the player, simplified tiles
// (lod-mesher.js) out to the render distance.
//
// The ground is divided into a quadtree of square tiles. A tile at level L
// covers 2^(L+1) x 2^(L+1) chunks with cells of 2^L blocks, and is split
// into its four children while the player is closer to it than
// detailDistance * 2^(L-1) chunks (with a little hysteresis, so walking
// back and forth over a boundary doesn't flip it). A split level-1 tile is
// "detail": its chunks are generated, lit and meshed by the World as
// before. Every other leaf is drawn as one LOD tile mesh, built in a Web
// Worker, nearest first. So the step size grows with distance at a steady
// ratio (at detailDistance D, cells are 2 blocks from about D chunks out, 4
// from 2D, 8 from 4D...).
//
// Hand-overs are seamless: the leaves exactly partition the ground, and a
// region keeps its old representation until the new one is complete. When
// a tile splits, it stays visible until all of its children (or chunks) are
// ready; when tiles merge, the children stay visible until the parent tile
// is built. New chunks start hidden, and this module decides which ones show.
import * as THREE from "three";
import { LodTerrain, buildLodTile, makeLodPalette, tileChunks } from "./lod-mesher.js";
import { createLodMaterial } from "./shaders.js";
import { CHUNK_SIZE } from "./constants.js";

const MAX_LEVEL = 6; // root tiles: 128 x 128 chunks
const MAX_IN_FLIGHT = 4; // worker requests at once (few, so re-planning can re-prioritize)
const UPLOAD_BUDGET_MS = 3; // main-thread time per frame for turning results into meshes
const LOCAL_BUILD_BUDGET_MS = 5; // per frame, when tiles are built on the main thread

function tileKey(level, tx, tz) {
  return `${level}:${tx}:${tz}`;
}

function flattenEdits(map) {
  const list = new Array(map.size * 2);
  let i = 0;
  for (const [index, id] of map) {
    list[i++] = index;
    list[i++] = id;
  }
  return list;
}

export class LodSystem {
  // options.worker: false builds tiles on the main thread (also the automatic
  // fallback when module workers aren't available).
  constructor(scene, world, seed, { worker = true } = {}) {
    this.world = world;
    this.seed = seed;
    this.group = new THREE.Group();
    this.group.name = "lod";
    scene.add(this.group);
    this.material = createLodMaterial();

    this.renderDistance = 20; // chunks
    this.detailDistance = 8; // chunks
    this.tiles = new Map(); // key -> { key, level, tx, tz, x0, z0, mesh, building, stale }
    this.roots = [];
    this._split = new Set(); // keys of split tiles in the current plan
    this._leafKeys = new Set(); // keys of LOD leaves in the current plan
    this._detail = new Set(); // "tx,tz" of level-1 detail tiles
    this._pcx = null;
    this._pcz = null;
    this._replan = true;
    this._planCount = 0;
    this._queue = [];
    this._queueDirty = false;
    this._inFlight = new Map(); // request id -> tile
    this._requestId = 0;
    this._results = []; // [{ tile, mesh }]
    this._dirty = true; // visibility needs recomputing
    this._lastMeshCount = -1;
    this._shownChunks = new Set();
    this._shownTiles = new Set();
    this._editedChunks = new Set();
    // maxUpdateMs: the longest main-thread update so far (tests reset it).
    this.stats = { built: 0, tiles: 0, shownTiles: 0, shownChunks: 0, vertices: 0, plans: 0, lastUpdateMs: 0, maxUpdateMs: 0 };

    // The chunk plan handed to World.ensureChunksAround.
    this.worldPlan = { id: "lod:0", reach: 0, meshed: (cx, cz, dx, dz) => this._isDetailChunk(cx, cz, dx, dz) };
    world.chunksHidden = true;
    for (const chunk of world.chunks.values()) chunk.group.visible = false;
    world.keepChunk = (chunk) => this._shownChunks.has(chunk);
    world.changeListeners.push((changed) => {
      for (let i = 0; i < changed.length; i += 3) this._editedChunks.add(`${changed[i] >> 4},${changed[i + 2] >> 4}`);
    });

    this.worker = null;
    this.local = null;
    this.fallbackReason = null;
    if (worker) this._startWorker();
    else this._useLocalBuilder("disabled");
  }

  // ---------- Tile building ----------

  _allEdits() {
    const out = [];
    for (const [key, map] of this.world.edits) out.push([key, flattenEdits(map)]);
    return out;
  }

  _startWorker() {
    try {
      const w = new Worker(new URL("./lod-worker.js", import.meta.url), { type: "module" });
      w.onmessage = (e) => this._onWorkerMessage(e.data);
      w.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this._useLocalBuilder(`worker error: ${e && e.message}`);
      };
      w.postMessage({ type: "init", seed: this.seed, palette: this.world.facePalette, edits: this._allEdits() });
      this.worker = w;
    } catch (err) {
      this._useLocalBuilder(String(err));
    }
  }

  // Builds tiles on the main thread instead (time-budgeted per frame).
  _useLocalBuilder(reason) {
    this.fallbackReason = reason;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const tile of this._inFlight.values()) tile.building = false;
    this._inFlight.clear();
    const terrain = new LodTerrain(this.seed);
    for (const [key, list] of this._allEdits()) terrain.setChunkEdits(key, list);
    this.local = { terrain, palette: makeLodPalette(this.world.facePalette) };
    this._queueDirty = true;
  }

  _onWorkerMessage(m) {
    if (m.type !== "tile") return;
    const tile = this._inFlight.get(m.id);
    this._inFlight.delete(m.id);
    if (!tile) return;
    tile.building = false;
    this._results.push({ tile, mesh: m.mesh });
    // Keep the worker busy even when frames are slow.
    if (!this._queueDirty) this._dispatch();
  }

  // Sends changed chunk edits to the builder and marks the tiles over those
  // chunks stale (rebuilt when needed; the old mesh shows until then).
  _flushEdits() {
    if (this._editedChunks.size === 0) return;
    for (const key of this._editedChunks) {
      const map = this.world.edits.get(key);
      const list = map ? flattenEdits(map) : [];
      if (this.worker) this.worker.postMessage({ type: "edits", key, list });
      if (this.local) this.local.terrain.setChunkEdits(key, list);
      const [cx, cz] = key.split(",").map(Number);
      for (let level = 1; level <= MAX_LEVEL; level++) {
        const c = tileChunks(level);
        const tile = this.tiles.get(tileKey(level, Math.floor(cx / c), Math.floor(cz / c)));
        if (tile) {
          tile.stale = true;
          this._queueDirty = true;
        }
      }
    }
    this._editedChunks.clear();
  }

  _rebuildQueue() {
    this._queueDirty = false;
    const q = [];
    for (const key of this._leafKeys) {
      const tile = this.tiles.get(key);
      if (tile && !tile.building && (!tile.mesh || tile.stale)) q.push(tile);
    }
    q.sort((a, b) => a.d - b.d);
    this._queue = q;
  }

  _dispatch() {
    if (this.worker) {
      while (this._inFlight.size < MAX_IN_FLIGHT && this._queue.length > 0) {
        const tile = this._queue.shift();
        if (!this._wantsBuild(tile)) continue;
        tile.building = true;
        tile.stale = false;
        const id = ++this._requestId;
        this._inFlight.set(id, tile);
        this.worker.postMessage({ type: "build", id, level: tile.level, tx: tile.tx, tz: tile.tz });
      }
    } else if (this.local) {
      const start = performance.now();
      while (this._queue.length > 0 && performance.now() - start < LOCAL_BUILD_BUDGET_MS) {
        const tile = this._queue.shift();
        if (!this._wantsBuild(tile)) continue;
        tile.stale = false;
        const mesh = buildLodTile(this.local.terrain, tile.level, tile.tx, tile.tz, this.local.palette);
        this._results.push({ tile, mesh });
      }
    }
  }

  _wantsBuild(tile) {
    return this.tiles.get(tile.key) === tile && this._leafKeys.has(tile.key) && !tile.building && (!tile.mesh || tile.stale);
  }

  _applyResults() {
    const start = performance.now();
    while (this._results.length > 0 && performance.now() - start < UPLOAD_BUDGET_MS) {
      const { tile, mesh } = this._results.shift();
      if (this.tiles.get(tile.key) !== tile) continue; // dropped meanwhile
      this._setMesh(tile, mesh);
      if (tile.stale) this._queueDirty = true;
      this.stats.built++;
      this._dirty = true;
    }
  }

  _setMesh(tile, data) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.position, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(data.color, 4, true));
    g.setAttribute("aInfo", new THREE.BufferAttribute(data.info, 4));
    g.setIndex(new THREE.BufferAttribute(data.index, 1));
    const half = data.span / 2;
    const midY = (data.minY + data.maxY) / 2;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(half, midY, half), Math.hypot(half, half, (data.maxY - data.minY) / 2) + 1);
    tile.vertices = data.vertexCount;
    if (tile.mesh) {
      tile.mesh.geometry.dispose();
      tile.mesh.geometry = g;
      return;
    }
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(tile.x0, 0, tile.z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    this.group.add(mesh);
    tile.mesh = mesh;
  }

  _disposeTile(tile) {
    if (tile.mesh) {
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      tile.mesh = null;
    }
    this.tiles.delete(tile.key);
  }

  // ---------- Planning ----------

  // renderDistance: chunks to draw at all; detailDistance: chunks drawn in
  // full detail (roughly; see the file comment).
  configure({ renderDistance, detailDistance }) {
    if (renderDistance !== undefined && renderDistance !== this.renderDistance) {
      this.renderDistance = renderDistance;
      this._replan = true;
    }
    if (detailDistance !== undefined && detailDistance !== this.detailDistance) {
      this.detailDistance = detailDistance;
      this._replan = true;
    }
  }

  // Re-plans the quadtree when the player enters another chunk (or the
  // configuration changed). Returns true if the plan changed.
  plan(px, pz) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    if (!this._replan && pcx === this._pcx && pcz === this._pcz) return false;
    this._replan = false;
    this._pcx = pcx;
    this._pcz = pcz;
    const ctx = { cx: pcx + 0.5, cz: pcz + 0.5, split: new Set(), leaves: new Set(), detail: new Set(), reach: 0 };
    const RD = this.renderDistance;
    const c = tileChunks(MAX_LEVEL);
    const roots = [];
    for (let tz = Math.floor((ctx.cz - RD) / c); tz <= Math.floor((ctx.cz + RD) / c); tz++) {
      for (let tx = Math.floor((ctx.cx - RD) / c); tx <= Math.floor((ctx.cx + RD) / c); tx++) {
        const node = this._visit(MAX_LEVEL, tx, tz, ctx);
        if (node) roots.push(node);
      }
    }
    this.roots = roots;
    this._split = ctx.split;
    this._leafKeys = ctx.leaves;
    this._detail = ctx.detail;
    this._planCount++;
    this.stats.plans = this._planCount;
    this.worldPlan = {
      id: `lod:${this._planCount}`,
      reach: Math.min(RD, ctx.reach),
      meshed: this.worldPlan.meshed,
    };
    // Tiles no longer needed by the plan are dropped by the next display
    // pass once nothing shows them.
    this._queueDirty = true;
    this._dirty = true;
    return true;
  }

  _visit(level, tx, tz, ctx) {
    const c = tileChunks(level);
    const x0 = tx * c;
    const z0 = tz * c;
    const dx = Math.max(x0 - ctx.cx, 0, ctx.cx - (x0 + c));
    const dz = Math.max(z0 - ctx.cz, 0, ctx.cz - (z0 + c));
    const d = Math.hypot(dx, dz);
    if (d >= this.renderDistance) return null;
    const key = tileKey(level, tx, tz);
    const threshold = this.detailDistance * 2 ** (level - 1);
    const split = d < threshold || (this._split.has(key) && d < threshold + c * 0.25);
    const node = { key, level, tx, tz, d, children: null, detail: false, ready: false };
    if (!split) {
      ctx.leaves.add(key);
      let tile = this.tiles.get(key);
      if (!tile) {
        tile = { key, level, tx, tz, x0: x0 * CHUNK_SIZE, z0: z0 * CHUNK_SIZE, mesh: null, building: false, stale: false, d, vertices: 0 };
        this.tiles.set(key, tile);
      }
      tile.d = d;
      return node;
    }
    ctx.split.add(key);
    if (level === 1) {
      node.detail = true;
      ctx.detail.add(`${tx},${tz}`);
      // The farthest chunk of this tile, for the World's search radius.
      const fx = Math.max(Math.abs(x0 - ctx.cx + 0.5), Math.abs(x0 + c - 1 - ctx.cx + 0.5));
      const fz = Math.max(Math.abs(z0 - ctx.cz + 0.5), Math.abs(z0 + c - 1 - ctx.cz + 0.5));
      ctx.reach = Math.max(ctx.reach, Math.ceil(Math.hypot(fx, fz)));
      return node;
    }
    node.children = [];
    for (let b = 0; b < 2; b++) {
      for (let a = 0; a < 2; a++) {
        const child = this._visit(level - 1, tx * 2 + a, tz * 2 + b, ctx);
        if (child) node.children.push(child);
      }
    }
    return node;
  }

  // Chunk (cx, cz), dx/dz from the player's chunk: meshed in full detail?
  _isDetailChunk(cx, cz, dx, dz) {
    const R = this.renderDistance;
    if (dx * dx + dz * dz > R * R) return false;
    const c = tileChunks(1);
    return this._detail.has(`${Math.floor(cx / c)},${Math.floor(cz / c)}`);
  }

  // ---------- Display ----------

  _inRange(cx, cz) {
    const dx = cx - this._pcx;
    const dz = cz - this._pcz;
    return dx * dx + dz * dz <= this.renderDistance * this.renderDistance;
  }

  // All chunks of level-1 tile (tx, tz) that should show are meshed.
  _chunksReady(tx, tz) {
    const c = tileChunks(1);
    for (let cz = tz * c; cz < tz * c + c; cz++) {
      for (let cx = tx * c; cx < tx * c + c; cx++) {
        if (!this._inRange(cx, cz)) continue;
        const chunk = this.world.getChunk(cx, cz);
        if (!chunk || !chunk.meshed) return false;
      }
    }
    return true;
  }

  _showChunks(tx, tz, out) {
    const c = tileChunks(1);
    for (let cz = tz * c; cz < tz * c + c; cz++) {
      for (let cx = tx * c; cx < tx * c + c; cx++) {
        if (!this._inRange(cx, cz)) continue;
        const chunk = this.world.getChunk(cx, cz);
        if (chunk && chunk.meshed) out.chunks.add(chunk);
      }
    }
  }

  _mesh(key) {
    const tile = this.tiles.get(key);
    return tile && tile.mesh ? tile : null;
  }

  // Can (level, tx, tz) be shown entirely with finer pieces still resident
  // (tiles, or chunks at level 1)? Looks `depth` levels down.
  _fineReady(level, tx, tz, depth) {
    if (level === 1) return this._chunksReady(tx, tz);
    if (depth === 0) return false;
    for (let b = 0; b < 2; b++) {
      for (let a = 0; a < 2; a++) {
        const cx = tx * 2 + a;
        const cz = tz * 2 + b;
        if (!this._mesh(tileKey(level - 1, cx, cz)) && !this._fineReady(level - 1, cx, cz, depth - 1)) return false;
      }
    }
    return true;
  }

  _showFine(level, tx, tz, depth, out) {
    if (level === 1) return this._showChunks(tx, tz, out);
    if (depth === 0) return;
    for (let b = 0; b < 2; b++) {
      for (let a = 0; a < 2; a++) {
        const cx = tx * 2 + a;
        const cz = tz * 2 + b;
        const tile = this._mesh(tileKey(level - 1, cx, cz));
        if (tile) out.tiles.add(tile);
        else this._showFine(level - 1, cx, cz, depth - 1, out);
      }
    }
  }

  // Bottom-up: can this node be shown completely at its planned detail (or
  // finer, for leaves whose tile isn't built yet)?
  _computeReady(node) {
    if (node.detail) node.ready = this._chunksReady(node.tx, node.tz);
    else if (!node.children) node.ready = !!this._mesh(node.key) || this._fineReady(node.level, node.tx, node.tz, 2);
    else {
      let all = true;
      for (const child of node.children) if (!this._computeReady(child)) all = false;
      node.ready = all;
    }
    return node.ready;
  }

  _emit(node, out) {
    const own = this._mesh(node.key);
    if (node.detail) {
      // Keep showing the old LOD tile until all its chunks are meshed (but
      // never around the player: rather a gap than coarse ground underfoot).
      if (!node.ready && own && node.d >= 2) out.tiles.add(own);
      else this._showChunks(node.tx, node.tz, out);
      return;
    }
    if (!node.children) {
      if (own) out.tiles.add(own);
      else this._showFine(node.level, node.tx, node.tz, 2, out);
      return;
    }
    if (!node.ready && own) {
      out.tiles.add(own);
      return;
    }
    for (const child of node.children) this._emit(child, out);
  }

  _display() {
    this._dirty = false;
    const out = { tiles: new Set(), chunks: new Set() };
    for (const root of this.roots) this._computeReady(root);
    for (const root of this.roots) this._emit(root, out);
    let vertices = 0;
    for (const tile of this.tiles.values()) {
      if (!tile.mesh) continue;
      const shown = out.tiles.has(tile);
      tile.mesh.visible = shown;
      if (shown) vertices += tile.vertices;
    }
    let released = false;
    for (const chunk of this._shownChunks) {
      if (out.chunks.has(chunk)) continue;
      chunk.group.visible = false;
      released = true;
    }
    for (const chunk of out.chunks) chunk.group.visible = true;
    this._shownChunks = out.chunks;
    // Chunks that were only kept loaded to be shown can go now.
    if (released) this.world.releaseChunks();
    this._shownTiles = out.tiles;
    // Free tiles that are neither planned nor needed as a stand-in.
    for (const tile of [...this.tiles.values()]) {
      if (!this._leafKeys.has(tile.key) && !out.tiles.has(tile)) this._disposeTile(tile);
    }
    this.stats.tiles = this.tiles.size;
    this.stats.shownTiles = out.tiles.size;
    this.stats.shownChunks = out.chunks.size;
    this.stats.vertices = vertices;
  }

  // Per frame, after the World has streamed chunks.
  update() {
    const start = performance.now();
    this._flushEdits();
    this._applyResults();
    if (this._queueDirty) this._rebuildQueue();
    this._dispatch();
    const meshes = this.world.stats.meshes;
    if (this._dirty || meshes !== this._lastMeshCount) {
      this._lastMeshCount = meshes;
      this._display();
    }
    const ms = performance.now() - start;
    this.stats.lastUpdateMs = ms;
    this.stats.maxUpdateMs = Math.max(this.stats.maxUpdateMs, ms);
  }

  // True when every planned tile is built, current, and shown.
  get isIdle() {
    if (this._results.length > 0 || this._inFlight.size > 0) return false;
    for (const key of this._leafKeys) {
      const tile = this.tiles.get(key);
      if (!tile || !tile.mesh || tile.stale || !tile.mesh.visible) return false;
    }
    return true;
  }

  get leafCount() {
    return this._leafKeys.size;
  }

  // Is the chunk currently drawn (in full detail)?
  isChunkShown(chunk) {
    return this._shownChunks.has(chunk);
  }
}
