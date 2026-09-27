// 3D grass near the player (High and Ultra presets): instanced tufts of
// thin blades standing on grass blocks that have open air above them. They
// are lit like the terrain (the voxel light above the block, sun shadows),
// sway in the wind, bend away from the player's feet, and shrink away
// toward the edge of their radius so they never pop in or out.
//
// Each chunk's grass tops are found once and cached until the chunk is
// rebuilt (an edit or a light change); the instance buffer is refilled when
// the player has moved a little or a chunk nearby changed.
import * as THREE from "three";
import { BLOCK } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT } from "./constants.js";
import { createGrassMaterial } from "./shaders.js";

const BLADES = 10;
const MAX_TUFTS = 12000;
const REBUILD_DISTANCE = 1.5; // blocks moved before the tufts are refilled

function hash(x, z, k) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(k | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// One tuft: BLADES thin, slightly leaning triangles spread over a block top.
function tuftGeometry() {
  const pos = [];
  const tip = [];
  const nrm = [];
  for (let b = 0; b < BLADES; b++) {
    const r = (k) => hash(b, 17, k);
    const angle = r(0) * Math.PI * 2;
    const dist = Math.sqrt(r(1)) * 0.42;
    const bx = Math.cos(angle) * dist;
    const bz = Math.sin(angle) * dist;
    const facing = r(2) * Math.PI;
    const dx = Math.cos(facing);
    const dz = Math.sin(facing);
    const width = 0.018 + r(3) * 0.02;
    const height = 0.3 + r(4) * 0.4;
    const lean = (r(5) - 0.5) * 0.24;
    pos.push(bx - dx * width, 0, bz - dz * width, bx + dx * width, 0, bz + dz * width, bx - dz * lean, height, bz + dx * lean);
    tip.push(0, 0, 1);
    for (let k = 0; k < 3; k++) nrm.push(-dz, 0, dx);
  }
  return { pos: new Float32Array(pos), tip: new Float32Array(tip), nrm: new Float32Array(nrm) };
}

export class GrassField {
  constructor(scene, world) {
    this.world = world;
    const tuft = tuftGeometry();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(tuft.pos, 3));
    g.setAttribute("aTip", new THREE.BufferAttribute(tuft.tip, 1));
    g.setAttribute("aBladeNormal", new THREE.BufferAttribute(tuft.nrm, 3));
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TUFTS * 3), 3);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TUFTS * 3), 3);
    this.aLight = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TUFTS * 2), 2);
    for (const a of [this.aOffset, this.aRot, this.aLight]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("iOffset", this.aOffset);
    g.setAttribute("iRotScaleTint", this.aRot);
    g.setAttribute("iLight", this.aLight);
    g.instanceCount = 0;
    this.geometry = g;

    // Blades take the grass texture's average color (linear), a bit richer.
    const p = world.facePalette.top;
    const i = BLOCK.GRASS * 3;
    this.material = createGrassMaterial(new THREE.Color(p[i] * 1.05, p[i + 1] * 1.1, p[i + 2] * 0.95));
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.density = 0; // tufts per grass block (0 = off)
    this.radius = 16;
    this._cache = new WeakMap(); // chunk -> { version, tops: Float32Array [x, y, z, sky, block, ...] }
    this._builtAt = new THREE.Vector3(Infinity, 0, 0);
    this._versions = new Map(); // chunk -> mesh count at the last fill
    this.count = 0;
  }

  // density: tufts per grass block (0 turns the grass off); radius in blocks.
  configure({ density, radius }) {
    this.density = density;
    this.radius = radius;
    this.material.uniforms.uRadius.value = radius;
    this.mesh.visible = density > 0;
    this._builtAt.set(Infinity, 0, 0);
  }

  // Grass blocks with air above in one chunk, with the light above them.
  _tops(chunk) {
    const version = chunk.meshCount || 0;
    const cached = this._cache.get(chunk);
    if (cached && cached.version === version) return cached.tops;
    const S = CHUNK_SIZE;
    const blocks = chunk.blocks;
    const light = chunk.light;
    const out = [];
    for (let y = 1; y < WORLD_HEIGHT - 1; y++) {
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const i = (y * S + z) * S + x;
          if (blocks[i] !== BLOCK.GRASS || blocks[i + S * S] !== BLOCK.AIR) continue;
          const l = light[i + S * S];
          out.push(chunk.cx * S + x, y + 1, chunk.cz * S + z, (l >> 4) / 15, (l & 15) / 15);
        }
      }
    }
    const tops = new Float32Array(out);
    this._cache.set(chunk, { version, tops });
    return tops;
  }

  _chunksInRange(px, pz) {
    const r = this.radius;
    const list = [];
    for (let cz = Math.floor((pz - r) / CHUNK_SIZE); cz <= Math.floor((pz + r) / CHUNK_SIZE); cz++) {
      for (let cx = Math.floor((px - r) / CHUNK_SIZE); cx <= Math.floor((px + r) / CHUNK_SIZE); cx++) {
        const chunk = this.world.getChunk(cx, cz);
        if (chunk && chunk.meshed && chunk.group.visible) list.push(chunk);
      }
    }
    return list;
  }

  update(playerPos) {
    if (this.density <= 0) return;
    this.material.uniforms.uPlayer.value.copy(playerPos);
    const chunks = this._chunksInRange(playerPos.x, playerPos.z);
    let changed = this._builtAt.distanceTo(playerPos) > REBUILD_DISTANCE || chunks.length !== this._versions.size;
    if (!changed) {
      for (const chunk of chunks) {
        if (this._versions.get(chunk) !== (chunk.meshCount || 0)) {
          changed = true;
          break;
        }
      }
    }
    if (changed) this._fill(chunks, playerPos);
  }

  _fill(chunks, playerPos) {
    this._builtAt.copy(playerPos);
    this._versions.clear();
    const off = this.aOffset.array;
    const rot = this.aRot.array;
    const lit = this.aLight.array;
    const r2 = this.radius * this.radius;
    let n = 0;
    for (const chunk of chunks) {
      this._versions.set(chunk, chunk.meshCount || 0);
      const tops = this._tops(chunk);
      for (let i = 0; i < tops.length && n < MAX_TUFTS; i += 5) {
        const x = tops[i];
        const z = tops[i + 2];
        const dx = x + 0.5 - playerPos.x;
        const dz = z + 0.5 - playerPos.z;
        if (dx * dx + dz * dz > r2) continue;
        for (let k = 0; k < this.density && n < MAX_TUFTS; k++) {
          off[n * 3] = x + 0.5 + (hash(x, z, k * 3) - 0.5) * 0.5;
          off[n * 3 + 1] = tops[i + 1];
          off[n * 3 + 2] = z + 0.5 + (hash(x, z, k * 3 + 1) - 0.5) * 0.5;
          rot[n * 3] = hash(x, z, k * 3 + 2) * Math.PI * 2;
          rot[n * 3 + 1] = 0.75 + hash(z, x, k) * 0.5;
          rot[n * 3 + 2] = 0.88 + hash(x + 7, z, k) * 0.24;
          lit[n * 2] = tops[i + 3];
          lit[n * 2 + 1] = tops[i + 4];
          n++;
        }
      }
    }
    this.count = n;
    this.geometry.instanceCount = n;
    // Upload only the part in use.
    for (const a of [this.aOffset, this.aRot, this.aLight]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n) * a.itemSize);
      a.needsUpdate = true;
    }
  }
}
