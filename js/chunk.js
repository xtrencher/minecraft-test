// A 16 x 64 x 16 column of blocks with its light values and render meshes.
import * as THREE from "three";
import { BLOCK } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT, blockIndex, chunkKey } from "./constants.js";
import { LAYER_WATER } from "./layers.js";

export { CHUNK_SIZE, WORLD_HEIGHT, blockIndex };

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.blocks = new Uint8Array(CHUNK_SIZE * WORLD_HEIGHT * CHUNK_SIZE);
    // High nibble: sky light, low nibble: block light (see light.js).
    this.light = new Uint8Array(CHUNK_SIZE * WORLD_HEIGHT * CHUNK_SIZE);
    this.generated = false;
    this.meshed = false;
    this.group = new THREE.Group();
    this.group.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    this.meshes = { opaque: null, cutout: null, water: null };
  }

  inBounds(lx, ly, lz) {
    return lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < WORLD_HEIGHT && lz >= 0 && lz < CHUNK_SIZE;
  }

  getBlock(lx, ly, lz) {
    if (!this.inBounds(lx, ly, lz)) return BLOCK.AIR;
    return this.blocks[blockIndex(lx, ly, lz)];
  }

  setBlock(lx, ly, lz, id) {
    if (!this.inBounds(lx, ly, lz)) return;
    this.blocks[blockIndex(lx, ly, lz)] = id;
  }

  // Replaces the render meshes with freshly built buffers (see mesher.js).
  applyMesh(buffers, materials) {
    this._setMesh("opaque", buffers.opaque, materials.opaque, true, null);
    this._setMesh("cutout", buffers.cutout, materials.cutout, true, materials.cutoutDepth);
    this._setMesh("water", buffers.water, materials.water, false, null);
  }

  _setMesh(kind, buf, material, castShadow, depthMaterial) {
    const existing = this.meshes[kind];
    if (!buf) {
      if (existing) {
        this.group.remove(existing);
        existing.geometry.dispose();
        this.meshes[kind] = null;
      }
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(buf.position, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(buf.uv, 2));
    geometry.setAttribute("aData", new THREE.BufferAttribute(buf.data, 4));
    geometry.setAttribute("aExtra", new THREE.BufferAttribute(buf.extra, 4));
    geometry.setIndex(new THREE.BufferAttribute(buf.index, 1));
    geometry.computeBoundingSphere();
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geometry;
      return;
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    if (depthMaterial) mesh.customDepthMaterial = depthMaterial;
    if (kind === "water") mesh.layers.set(LAYER_WATER); // drawn in its own pass (see postfx.js)
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.meshes[kind] = mesh;
  }

  dispose() {
    for (const mesh of Object.values(this.meshes)) {
      if (mesh) mesh.geometry.dispose();
    }
    this.meshes = { opaque: null, cutout: null, water: null };
  }
}
