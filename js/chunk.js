import * as THREE from "three";
import { BLOCK, BLOCK_INFO, isOpaque, isTransparent, tileUVInset } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT, blockIndex, chunkKey } from "./constants.js";

export { CHUNK_SIZE, WORLD_HEIGHT, blockIndex };

const FACES = [
  // dir, corners (CCW when viewed from outside), normal
  { dir: [1, 0, 0], normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], key: "side" },
  { dir: [-1, 0, 0], normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], key: "side" },
  { dir: [0, 1, 0], normal: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], key: "top" },
  { dir: [0, -1, 0], normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], key: "bottom" },
  { dir: [0, 0, 1], normal: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], key: "side" },
  { dir: [0, 0, -1], normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], key: "side" },
];

// Simple per-face shading to fake ambient occlusion / directional light cheaply.
const FACE_SHADE = {
  top: 1.0,
  bottom: 0.5,
  side: 0.75,
};

export class Chunk {
  constructor(cx, cz, world) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.world = world;
    this.blocks = new Uint8Array(CHUNK_SIZE * WORLD_HEIGHT * CHUNK_SIZE);
    this.generated = false;
    this.group = new THREE.Group();
    this.group.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.opaqueMesh = null;
    this.cutoutMesh = null;
    this.waterMesh = null;
    this.needsRemesh = false;
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

  dispose() {
    for (const mesh of [this.opaqueMesh, this.cutoutMesh, this.waterMesh]) {
      if (mesh) {
        mesh.geometry.dispose();
      }
    }
  }

  buildMesh(materials) {
    const opaqueGeo = { pos: [], norm: [], uv: [], idx: [], color: [] };
    const cutoutGeo = { pos: [], norm: [], uv: [], idx: [], color: [] };
    const waterGeo = { pos: [], norm: [], uv: [], idx: [], color: [] };

    const worldBaseX = this.cx * CHUNK_SIZE;
    const worldBaseZ = this.cz * CHUNK_SIZE;

    for (let ly = 0; ly < WORLD_HEIGHT; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const id = this.getBlock(lx, ly, lz);
          if (id === BLOCK.AIR) continue;
          const info = BLOCK_INFO[id];
          if (!info) continue;

          let target;
          if (info.liquid) target = waterGeo;
          else if (info.cutout || info.transparent) target = cutoutGeo;
          else target = opaqueGeo;

          for (const face of FACES) {
            const nx = lx + face.dir[0];
            const ny = ly + face.dir[1];
            const nz = lz + face.dir[2];
            let neighborId;
            if (this.inBounds(nx, ny, nz)) {
              neighborId = this.getBlock(nx, ny, nz);
            } else {
              neighborId = this.world.getBlock(worldBaseX + nx, ny, worldBaseZ + nz);
            }

            let renderFace;
            if (info.liquid) {
              renderFace = neighborId === BLOCK.AIR;
            } else if (info.cutout || info.transparent) {
              renderFace = neighborId === BLOCK.AIR || (neighborId !== id && !isOpaque(neighborId));
            } else {
              renderFace = neighborId === BLOCK.AIR || !isOpaque(neighborId);
            }
            if (!renderFace) continue;

            const tile = info.faces[face.key] ?? info.faces.side;
            const [u0, v0, u1, v1] = tileUVInset(tile);
            const uvs = [
              [u1, v0],
              [u1, v1],
              [u0, v1],
              [u0, v0],
            ];

            const shade = FACE_SHADE[face.key] ?? 1.0;
            const startIndex = target.pos.length / 3;
            for (let c = 0; c < 4; c++) {
              const corner = face.corners[c];
              target.pos.push(lx + corner[0], ly + corner[1], lz + corner[2]);
              target.norm.push(face.normal[0], face.normal[1], face.normal[2]);
              target.uv.push(uvs[c][0], uvs[c][1]);
              target.color.push(shade, shade, shade);
            }
            target.idx.push(startIndex, startIndex + 1, startIndex + 2, startIndex, startIndex + 2, startIndex + 3);
          }
        }
      }
    }

    this._applyGeometry("opaqueMesh", opaqueGeo, materials.opaque);
    this._applyGeometry("cutoutMesh", cutoutGeo, materials.cutout);
    this._applyGeometry("waterMesh", waterGeo, materials.water);
  }

  _applyGeometry(field, data, material) {
    const existing = this[field];
    if (existing) {
      this.group.remove(existing);
      existing.geometry.dispose();
      this[field] = null;
    }
    if (data.pos.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.pos, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(data.norm, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(data.uv, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(data.color, 3));
    geometry.setIndex(data.idx);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    this.group.add(mesh);
    this[field] = mesh;
  }
}
