// 3D models for items (dropped on the ground and held in first person):
// cube blocks become textured mini-cubes; everything else (tools, food,
// torches, flowers) becomes an "extruded sprite", a thin slab built from
// the icon's pixels, like classic voxel games show items in 3D.
import * as THREE from "three";
import { BLOCK_INFO, SHAPE, TILE_NAMES } from "./blocks.js";
import { itemInfo } from "./items.js";
import { itemIconPixels } from "./itemtextures.js";
import { paintTile } from "./textures.js";

// Face corners/uv orientation matching the terrain mesher (+X, -X, +Y, -Y, +Z, -Z).
const CUBE_FACES = [
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], uv: (p) => [1 - p[2], p[1]] },
  { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], uv: (p) => [p[2], p[1]] },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], uv: (p) => [p[0], 1 - p[2]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uv: (p) => [p[0], p[2]] },
  { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], uv: (p) => [p[0], p[1]] },
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], uv: (p) => [1 - p[0], p[1]] },
];

// A 1x1x1 cube centered at the origin whose faces sample the block's layers
// of the block texture array (attribute aLayer).
export function blockCubeGeometry(blockId) {
  const info = BLOCK_INFO[blockId];
  const pos = [];
  const nor = [];
  const uv = [];
  const layer = [];
  const idx = [];
  CUBE_FACES.forEach((f, fi) => {
    const base = pos.length / 3;
    for (const p of f.c) {
      pos.push(p[0] - 0.5, p[1] - 0.5, p[2] - 0.5);
      nor.push(...f.n);
      uv.push(...f.uv(p));
      layer.push(info.faceTiles[fi]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aLayer", new THREE.Float32BufferAttribute(layer, 1));
  g.setIndex(idx);
  return g;
}

// Extrudes 32x32 RGBA pixels into a slab 1 unit wide and `depth` thick,
// centered at the origin, with per-vertex colors (linear). Front/back faces
// merge runs of same-colored pixels in each row; edge faces are added only
// where a pixel borders transparency.
export function spriteGeometry(pixels, depth = 1 / 16) {
  const N = 32;
  const pos = [];
  const nor = [];
  const col = [];
  const idx = [];
  const color = new THREE.Color();
  const opaque = (x, y) => x >= 0 && y >= 0 && x < N && y < N && pixels[(y * N + x) * 4 + 3] >= 128;
  const rgbAt = (x, y) => {
    const i = (y * N + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2]];
  };
  const X = (x) => x / N - 0.5;
  const Y = (y) => 0.5 - y / N;
  const quad = (a, b, c, d, n, rgb, shade = 1) => {
    color.setRGB((rgb[0] / 255) * shade, (rgb[1] / 255) * shade, (rgb[2] / 255) * shade, THREE.SRGBColorSpace);
    const base = pos.length / 3;
    for (const p of [a, b, c, d]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      col.push(color.r, color.g, color.b);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const zf = depth / 2;
  const zb = -depth / 2;
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      if (!opaque(x, y)) {
        x++;
        continue;
      }
      const rgb = rgbAt(x, y);
      let x2 = x + 1;
      while (x2 < N && opaque(x2, y)) {
        const c = rgbAt(x2, y);
        if (c[0] !== rgb[0] || c[1] !== rgb[1] || c[2] !== rgb[2]) break;
        x2++;
      }
      // Front (+Z) and back (-Z), both counter-clockwise from outside.
      quad([X(x), Y(y + 1), zf], [X(x2), Y(y + 1), zf], [X(x2), Y(y), zf], [X(x), Y(y), zf], [0, 0, 1], rgb);
      quad([X(x2), Y(y + 1), zb], [X(x), Y(y + 1), zb], [X(x), Y(y), zb], [X(x2), Y(y), zb], [0, 0, -1], rgb);
      x = x2;
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!opaque(x, y)) continue;
      const rgb = rgbAt(x, y);
      if (!opaque(x, y - 1)) quad([X(x), Y(y), zf], [X(x + 1), Y(y), zf], [X(x + 1), Y(y), zb], [X(x), Y(y), zb], [0, 1, 0], rgb, 1.05);
      if (!opaque(x, y + 1)) quad([X(x), Y(y + 1), zb], [X(x + 1), Y(y + 1), zb], [X(x + 1), Y(y + 1), zf], [X(x), Y(y + 1), zf], [0, -1, 0], rgb, 0.7);
      if (!opaque(x - 1, y)) quad([X(x), Y(y + 1), zb], [X(x), Y(y + 1), zf], [X(x), Y(y), zf], [X(x), Y(y), zb], [-1, 0, 0], rgb, 0.85);
      if (!opaque(x + 1, y)) quad([X(x + 1), Y(y + 1), zf], [X(x + 1), Y(y + 1), zb], [X(x + 1), Y(y), zb], [X(x + 1), Y(y), zf], [1, 0, 0], rgb, 0.85);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  return g;
}

// Merges parts ({ geometry, color: 0xrrggbb (sRGB), matrix? }) into one
// non-indexed geometry with per-vertex colors (for the "color" material).
function mergeColored(parts) {
  const pos = [];
  const nor = [];
  const col = [];
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  for (const part of parts) {
    const g = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    if (part.matrix) g.applyMatrix4(part.matrix);
    c.setHex(part.color, THREE.SRGBColorSpace);
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      v.set(n.getX(i), n.getY(i), n.getZ(i)).normalize();
      nor.push(v.x, v.y, v.z);
      col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}

const at = (x, y, z, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// First-person gun models, built along -Z (the barrel points forward), in
// blocks. The muzzle sits at MUZZLE[kind] (model space).
export const MUZZLE = {
  pistol: new THREE.Vector3(0, 0.045, -0.36),
  bazooka: new THREE.Vector3(0, 0, -0.78),
};

function pistolGeometry() {
  const steel = 0x2f3238;
  const dark = 0x1b1c20;
  const grip = 0x3c2a1c;
  return mergeColored([
    { geometry: box(0.085, 0.09, 0.46), color: steel, matrix: at(0, 0.05, -0.12) }, // slide
    { geometry: box(0.05, 0.05, 0.1), color: dark, matrix: at(0, 0.03, -0.37) }, // barrel tip
    { geometry: box(0.075, 0.05, 0.3), color: dark, matrix: at(0, -0.01, -0.1) }, // frame
    { geometry: box(0.08, 0.26, 0.11), color: grip, matrix: at(0, -0.14, 0.05, 0.28) }, // grip
    { geometry: box(0.02, 0.07, 0.02), color: dark, matrix: at(0, -0.06, -0.08) }, // trigger
    { geometry: box(0.03, 0.02, 0.12), color: dark, matrix: at(0, -0.09, -0.1) }, // trigger guard
    { geometry: box(0.02, 0.025, 0.02), color: 0x9aa0a8, matrix: at(0, 0.105, -0.33) }, // front sight
    { geometry: box(0.05, 0.025, 0.02), color: 0x9aa0a8, matrix: at(0, 0.105, 0.08) }, // rear sight
  ]);
}

function bazookaGeometry() {
  const olive = 0x4d5c2a;
  const oliveDark = 0x39441f;
  const steel = 0x2b2e34;
  const tube = new THREE.CylinderGeometry(0.1, 0.1, 1.5, 12, 1, true);
  const cap = (r) => new THREE.CylinderGeometry(r, r, 0.08, 12);
  const flare = new THREE.CylinderGeometry(0.1, 0.15, 0.2, 12, 1, true);
  const rx = Math.PI / 2;
  return mergeColored([
    { geometry: tube, color: olive, matrix: at(0, 0, 0, rx) },
    { geometry: new THREE.CylinderGeometry(0.085, 0.085, 1.49, 12, 1, true).scale(-1, 1, 1), color: 0x121212, matrix: at(0, 0, 0, rx) }, // inside
    { geometry: cap(0.115), color: steel, matrix: at(0, 0, -0.74, rx) }, // muzzle ring
    { geometry: cap(0.112), color: oliveDark, matrix: at(0, 0, -0.2, rx) }, // bands
    { geometry: cap(0.112), color: oliveDark, matrix: at(0, 0, 0.3, rx) },
    { geometry: flare, color: steel, matrix: at(0, 0, 0.84, -rx) }, // rear flare
    { geometry: box(0.05, 0.1, 0.14), color: steel, matrix: at(-0.02, 0.14, -0.1) }, // sight
    { geometry: box(0.06, 0.2, 0.08), color: 0x3c2a1c, matrix: at(0, -0.18, 0.05, 0.2) }, // grip
    { geometry: box(0.06, 0.16, 0.07), color: 0x3c2a1c, matrix: at(0, -0.16, -0.35, 0.2) }, // front grip
    { geometry: box(0.03, 0.05, 0.03), color: steel, matrix: at(0, -0.1, -0.02) }, // trigger
  ]);
}

// A thrown grenade (about 0.3 blocks tall), centered at the origin.
export function grenadeGeometry() {
  return mergeColored([
    { geometry: new THREE.SphereGeometry(0.1, 10, 8).scale(1, 1.2, 1), color: 0x4a5a26 },
    { geometry: new THREE.CylinderGeometry(0.04, 0.05, 0.06, 8), color: 0x8a9096, matrix: at(0, 0.13, 0) },
    { geometry: box(0.02, 0.14, 0.03), color: 0x8a9096, matrix: at(0.05, 0.06, 0, 0, 0, -0.35) }, // lever
  ]);
}

// A bazooka rocket pointing along -Z.
export function rocketGeometry() {
  const rx = -Math.PI / 2;
  const fin = box(0.02, 0.16, 0.14);
  return mergeColored([
    { geometry: new THREE.CylinderGeometry(0.07, 0.07, 0.55, 10), color: 0x5a6630, matrix: at(0, 0, 0, rx) },
    { geometry: new THREE.ConeGeometry(0.07, 0.2, 10), color: 0x2b2e34, matrix: at(0, 0, -0.37, rx) },
    { geometry: fin, color: 0x2b2e34, matrix: at(0, 0, 0.22) },
    { geometry: fin, color: 0x2b2e34, matrix: at(0, 0, 0.22, 0, 0, Math.PI / 2) },
  ]);
}

const modelCache = new Map();

// { geometry, kind: "array" | "color", cube: boolean, gun? } for an item id, cached.
export function itemModel(id) {
  if (modelCache.has(id)) return modelCache.get(id);
  const info = itemInfo(id);
  let model = null;
  if (info?.block) {
    const b = BLOCK_INFO[info.block];
    if (b.shape === SHAPE.CUBE) model = { geometry: blockCubeGeometry(info.block), kind: "array", cube: true };
    else model = { geometry: spriteGeometry(paintTile(TILE_NAMES[b.faces.side])), kind: "color", cube: false };
  } else if (info?.weapon && (info.weapon.kind === "pistol" || info.weapon.kind === "bazooka")) {
    const geometry = info.weapon.kind === "pistol" ? pistolGeometry() : bazookaGeometry();
    model = { geometry, kind: "color", cube: false, gun: info.weapon.kind };
  } else if (info) {
    model = { geometry: spriteGeometry(itemIconPixels(id)), kind: "color", cube: false };
  }
  modelCache.set(id, model);
  return model;
}
