import * as THREE from "three";
import { Noise, hash2 } from "./noise.js";
import { BLOCK, isSolid, createMaterials, buildTextureAtlas } from "./blocks.js";
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from "./chunk.js";

export const SEA_LEVEL = 24;
const BASE_HEIGHT = 26;
const AMPLITUDE = 14;
const TREE_CHANCE = 0.02;

function floorDiv(a, b) {
  return Math.floor(a / b);
}

export class World {
  constructor(scene, seed) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.noise = new Noise(this.seed);
    this.chunks = new Map();
    this.edits = new Map(); // "wx,wy,wz" -> blockId
    this.dirty = false;

    const { texture } = buildTextureAtlas();
    this.atlasTexture = texture;
    this.materials = createMaterials(texture);

    this.genQueue = [];
    this.genQueued = new Set();
    this.remeshQueue = new Set(); // boundary fix-ups after neighbors load (budgeted)
    this.editRemeshQueue = new Set(); // chunks changed by block edits (remeshed next frame)
    this._planCx = null;
    this._planCz = null;
    this._planR = null;

    this.onEdit = null; // callback(wx,wy,wz,id)
  }

  key(cx, cz) {
    return cx + "," + cz;
  }

  getChunk(cx, cz) {
    return this.chunks.get(this.key(cx, cz));
  }

  heightAt(wx, wz) {
    const n = this.noise.fbm2(wx, wz, 4, 0.5, 2, 1 / 80);
    return Math.floor(BASE_HEIGHT + n * AMPLITUDE);
  }

  getBlock(wx, wy, wz) {
    if (wy < 0) return BLOCK.STONE;
    if (wy >= WORLD_HEIGHT) return BLOCK.AIR;
    const cx = floorDiv(wx, CHUNK_SIZE);
    const cz = floorDiv(wz, CHUNK_SIZE);
    const chunk = this.getChunk(cx, cz);
    if (!chunk) return BLOCK.AIR;
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    return chunk.getBlock(lx, wy, lz);
  }

  isSolidAt(wx, wy, wz) {
    return isSolid(this.getBlock(wx, wy, wz));
  }

  setBlock(wx, wy, wz, id, { recordEdit = true, remesh = true } = {}) {
    if (wy < 0 || wy >= WORLD_HEIGHT) return false;
    const cx = floorDiv(wx, CHUNK_SIZE);
    const cz = floorDiv(wz, CHUNK_SIZE);
    const chunk = this.getChunk(cx, cz);
    if (!chunk) return false;
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    chunk.setBlock(lx, wy, lz, id);

    if (recordEdit) {
      this.edits.set(`${wx},${wy},${wz}`, id);
      this.dirty = true;
      if (this.onEdit) this.onEdit();
    }

    if (remesh) {
      this.editRemeshQueue.add(chunk);
      // Also remesh neighbor chunks if the edit is on a chunk boundary.
      if (lx === 0) this._queueRemeshAt(cx - 1, cz);
      if (lx === CHUNK_SIZE - 1) this._queueRemeshAt(cx + 1, cz);
      if (lz === 0) this._queueRemeshAt(cx, cz - 1);
      if (lz === CHUNK_SIZE - 1) this._queueRemeshAt(cx, cz + 1);
    }
    return true;
  }

  _queueRemeshAt(cx, cz) {
    const c = this.getChunk(cx, cz);
    if (c) this.editRemeshQueue.add(c);
  }

  // Plans chunk loading/unloading around the player. Cheap to call every
  // frame: the (relatively expensive) re-planning only runs when the player
  // crosses into a different chunk or the render distance changes.
  ensureChunksAround(px, pz, renderDistance) {
    const pcx = floorDiv(px, CHUNK_SIZE);
    const pcz = floorDiv(pz, CHUNK_SIZE);
    if (pcx === this._planCx && pcz === this._planCz && renderDistance === this._planR) return;
    this._planCx = pcx;
    this._planCz = pcz;
    this._planR = renderDistance;

    const r2 = renderDistance * renderDistance;

    // Re-prioritize already-queued chunks around the new center, dropping
    // any that fell out of range so we never generate a chunk only to
    // unload it again.
    this.genQueue = this.genQueue.filter((entry) => {
      const dx = entry.cx - pcx;
      const dz = entry.cz - pcz;
      entry.dist = dx * dx + dz * dz;
      if (entry.dist > r2) {
        this.genQueued.delete(this.key(entry.cx, entry.cz));
        return false;
      }
      return true;
    });

    for (let dx = -renderDistance; dx <= renderDistance; dx++) {
      for (let dz = -renderDistance; dz <= renderDistance; dz++) {
        const dist = dx * dx + dz * dz;
        if (dist > r2) continue;
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = this.key(cx, cz);
        if (!this.chunks.has(key) && !this.genQueued.has(key)) {
          this.genQueue.push({ cx, cz, dist });
          this.genQueued.add(key);
        }
      }
    }

    this.genQueue.sort((a, b) => a.dist - b.dist);

    const unloadDist = renderDistance + 2;
    for (const [key, chunk] of this.chunks) {
      const dx = chunk.cx - pcx;
      const dz = chunk.cz - pcz;
      if (dx * dx + dz * dz > unloadDist * unloadDist) {
        this.scene.remove(chunk.group);
        chunk.dispose();
        this.chunks.delete(key);
        this.remeshQueue.delete(chunk);
        this.editRemeshQueue.delete(chunk);
      }
    }
  }

  // Generates/meshes queued chunks until `budgetMs` of main-thread time has
  // been spent this frame (always at least one unit of work if any is
  // pending). Chunks touched by block edits are remeshed first and without a
  // budget, so the player sees their own edits immediately.
  processQueues(budgetMs = 4) {
    const start = performance.now();

    if (this.editRemeshQueue.size > 0) {
      for (const chunk of this.editRemeshQueue) {
        chunk.buildMesh(this.materials);
        this.remeshQueue.delete(chunk);
      }
      this.editRemeshQueue.clear();
    }

    let didWork = false;
    while (!didWork || performance.now() - start < budgetMs) {
      if (this.genQueue.length > 0) {
        this._generateNext();
      } else if (this.remeshQueue.size > 0) {
        const chunk = this.remeshQueue.values().next().value;
        this.remeshQueue.delete(chunk);
        chunk.buildMesh(this.materials);
      } else {
        break;
      }
      didWork = true;
    }
  }

  _generateNext() {
    const { cx, cz } = this.genQueue.shift();
    const key = this.key(cx, cz);
    this.genQueued.delete(key);
    if (this.chunks.has(key)) return;
    const chunk = new Chunk(cx, cz, this);
    this.generateTerrain(chunk);
    this.applyStoredEdits(chunk);
    chunk.generated = true;
    chunk.buildMesh(this.materials);
    this.chunks.set(key, chunk);
    this.scene.add(chunk.group);

    // Neighboring chunks may now have newly-hidden/exposed boundary faces.
    for (const [ncx, ncz] of [[cx - 1, cz], [cx + 1, cz], [cx, cz - 1], [cx, cz + 1]]) {
      const n = this.getChunk(ncx, ncz);
      if (n) this.remeshQueue.add(n);
    }
  }

  generateTerrain(chunk) {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const h = this.heightAt(wx, wz);
        const isBeach = h <= SEA_LEVEL + 1;

        for (let ly = 0; ly < WORLD_HEIGHT; ly++) {
          let id = BLOCK.AIR;
          if (ly > h) {
            id = ly <= SEA_LEVEL ? BLOCK.WATER : BLOCK.AIR;
          } else if (ly === h) {
            id = isBeach ? BLOCK.SAND : BLOCK.GRASS;
          } else if (ly > h - 4) {
            id = isBeach ? BLOCK.SAND : BLOCK.DIRT;
          } else {
            id = BLOCK.STONE;
          }
          if (id !== BLOCK.AIR) chunk.setBlock(lx, ly, lz, id);
        }
      }
    }

    // Trees: only rooted well inside the chunk so canopies never cross chunk borders.
    for (let lz = 3; lz < CHUNK_SIZE - 3; lz++) {
      for (let lx = 3; lx < CHUNK_SIZE - 3; lx++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const h = this.heightAt(wx, wz);
        if (h <= SEA_LEVEL + 1 || h >= WORLD_HEIGHT - 10) continue;
        const r = hash2(this.seed, wx, wz);
        if (r >= TREE_CHANCE) continue;
        this.placeTree(chunk, lx, h, lz, r);
      }
    }
  }

  placeTree(chunk, lx, h, lz, r) {
    const trunkHeight = 4 + Math.floor(r * 30000) % 3;
    for (let i = 1; i <= trunkHeight; i++) {
      chunk.setBlock(lx, h + i, lz, BLOCK.WOOD);
    }
    const canopyCenterY = h + trunkHeight;
    for (let dy = -2; dy <= 1; dy++) {
      const radius = dy >= 1 ? 1 : 2;
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (dx * dx + dz * dz > radius * radius + 0.5) continue;
          const lx2 = lx + dx;
          const lz2 = lz + dz;
          const ly2 = canopyCenterY + dy;
          if (!chunk.inBounds(lx2, ly2, lz2)) continue;
          if (chunk.getBlock(lx2, ly2, lz2) === BLOCK.AIR) {
            chunk.setBlock(lx2, ly2, lz2, BLOCK.LEAVES);
          }
        }
      }
    }
  }

  applyStoredEdits(chunk) {
    if (this.edits.size === 0) return;
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    for (const [key, id] of this.edits) {
      const [wx, wy, wz] = key.split(",").map(Number);
      const cx = floorDiv(wx, CHUNK_SIZE);
      const cz = floorDiv(wz, CHUNK_SIZE);
      if (cx !== chunk.cx || cz !== chunk.cz) continue;
      chunk.setBlock(wx - baseX, wy, wz - baseZ, id);
    }
  }

  loadEdits(editsArray) {
    // editsArray: flat [wx,wy,wz,id, ...]
    for (let i = 0; i < editsArray.length; i += 4) {
      const wx = editsArray[i];
      const wy = editsArray[i + 1];
      const wz = editsArray[i + 2];
      const id = editsArray[i + 3];
      this.edits.set(`${wx},${wy},${wz}`, id);
    }
  }

  serializeEdits() {
    const out = [];
    for (const [key, id] of this.edits) {
      const [wx, wy, wz] = key.split(",").map(Number);
      out.push(wx, wy, wz, id);
    }
    return out;
  }

  // Simple incremental voxel raycast. Returns { block:[x,y,z], place:[x,y,z], normal } or null.
  raycast(origin, direction, maxDistance = 6, step = 0.05) {
    const pos = origin.clone();
    const dir = direction.clone().normalize();
    let prevBlock = null;
    for (let t = 0; t < maxDistance; t += step) {
      const bx = Math.floor(pos.x);
      const by = Math.floor(pos.y);
      const bz = Math.floor(pos.z);
      const id = this.getBlock(bx, by, bz);
      if (isSolid(id)) {
        return {
          block: [bx, by, bz],
          place: prevBlock ?? [bx, by, bz],
        };
      }
      prevBlock = [bx, by, bz];
      pos.addScaledVector(dir, step);
    }
    return null;
  }
}
