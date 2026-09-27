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

const modelCache = new Map();

// { geometry, kind: "array" | "color", cube: boolean } for an item id, cached.
export function itemModel(id) {
  if (modelCache.has(id)) return modelCache.get(id);
  const info = itemInfo(id);
  let model = null;
  if (info?.block) {
    const b = BLOCK_INFO[info.block];
    if (b.shape === SHAPE.CUBE) model = { geometry: blockCubeGeometry(info.block), kind: "array", cube: true };
    else model = { geometry: spriteGeometry(paintTile(TILE_NAMES[b.faces.side])), kind: "color", cube: false };
  } else if (info) {
    model = { geometry: spriteGeometry(itemIconPixels(id)), kind: "color", cube: false };
  }
  modelCache.set(id, model);
  return model;
}
