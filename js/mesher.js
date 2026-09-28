// Chunk mesher: turns a chunk's blocks + light (and a 1-block border from
// its 8 neighbors) into compact vertex buffers, with per-vertex ambient
// occlusion and smooth lighting. Pure JS (no three.js): returns typed
// arrays that world.js wraps in BufferGeometry.
//
// Per-vertex attributes:
//   position  Float32 x3  chunk-local position
//   uv        Float32 x2  texture coordinate within the block's tile
//   aData     Uint8   x4  [normalIndex * 4 + ao (0-3), sky light * 17, block light * 17, flags]
//   aExtra    Uint8   x4  [texture layer, water depth * 16, color tint (128 = none), 0]
import { CHUNK_SIZE, WORLD_HEIGHT } from "./constants.js";
import {
  BLOCK,
  IS_OPAQUE,
  RENDER_TYPE,
  RENDER,
  SHAPE_OF,
  SHAPE,
  FACE_TILES,
  WAVES,
  EMISSIVE,
  IS_LEAVES,
} from "./blocks.js";

// FOLIAGE: leaves and plants (sunlight shines through them).
export const FLAG = Object.freeze({ WAVE: 1, EMISSIVE: 2, SURFACE: 4, UNDERWATER: 8, FOLIAGE: 16 });
export const WATER_SURFACE_HEIGHT = 0.875;

const S = CHUNK_SIZE;
const H = WORLD_HEIGHT;
const P = S + 2; // padded width
const PY = H + 2; // padded height
const OX = 1;
const OZ = P;
const OY = P * P;

function pidx(x, y, z) {
  return ((y + 1) * P + (z + 1)) * P + (x + 1);
}

const padBlocks = new Uint8Array(P * P * PY);
const padLight = new Uint8Array(P * P * PY);

// Faces in FACE order (+X, -X, +Y, -Y, +Z, -Z). Corners are counter-
// clockwise seen from outside; uv(c) gives an upright texture on sides.
const FACE_DEFS = [
  { n: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], uv: (c) => [1 - c[2], c[1]] },
  { n: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], uv: (c) => [c[2], c[1]] },
  { n: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], uv: (c) => [c[0], 1 - c[2]] },
  { n: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uv: (c) => [c[0], c[2]] },
  { n: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], uv: (c) => [c[0], c[1]] },
  { n: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], uv: (c) => [1 - c[0], c[1]] },
];

const offsetOf = (dx, dy, dz) => dx * OX + dy * OY + dz * OZ;

// Precomputed per face: neighbor offset, and per corner: position, uv and
// the padded-index offsets of the (side1, side2, corner) cells in the
// neighbor layer that shade that vertex.
const FACES = FACE_DEFS.map((def, f) => {
  const [nx, ny, nz] = def.n;
  const axis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
  const tangents = [0, 1, 2].filter((a) => a !== axis);
  const unit = (a, s) => [a === 0 ? s : 0, a === 1 ? s : 0, a === 2 ? s : 0];
  const corners = def.corners.map((c) => {
    const s1 = c[tangents[0]] === 1 ? 1 : -1;
    const s2 = c[tangents[1]] === 1 ? 1 : -1;
    const t1 = unit(tangents[0], s1);
    const t2 = unit(tangents[1], s2);
    return {
      pos: c,
      uv: def.uv(c),
      side1: offsetOf(nx + t1[0], ny + t1[1], nz + t1[2]),
      side2: offsetOf(nx + t2[0], ny + t2[1], nz + t2[2]),
      corner: offsetOf(nx + t1[0] + t2[0], ny + t1[1] + t2[1], nz + t1[2] + t2[2]),
    };
  });
  return { index: f, n: def.n, neighbor: offsetOf(nx, ny, nz), corners };
});

// ---------- Growable vertex buffer builder (reused between chunks) ----------
class GeoBuilder {
  constructor(capacity = 16384) {
    this._alloc(capacity);
    this.vc = 0;
    this.ic = 0;
    this.tint = 128; // color tint written with every vertex (128 = none)
  }
  _alloc(cap) {
    const old = this.cap ? this : null;
    this.cap = cap;
    const pos = new Float32Array(cap * 3);
    const uv = new Float32Array(cap * 2);
    const data = new Uint8Array(cap * 4);
    const extra = new Uint8Array(cap * 4);
    const index = new Uint32Array(cap * 1.5);
    if (old) {
      pos.set(old.pos.subarray(0, this.vc * 3));
      uv.set(old.uv.subarray(0, this.vc * 2));
      data.set(old.data.subarray(0, this.vc * 4));
      extra.set(old.extra.subarray(0, this.vc * 4));
      index.set(old.index.subarray(0, this.ic));
    }
    this.pos = pos;
    this.uv = uv;
    this.data = data;
    this.extra = extra;
    this.index = index;
  }
  reset() {
    this.vc = 0;
    this.ic = 0;
  }
  vertex(x, y, z, u, v, d0, sky, blk, flags, layer, depth) {
    if (this.vc >= this.cap) this._alloc(this.cap * 2);
    const i = this.vc++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.uv[i * 2] = u;
    this.uv[i * 2 + 1] = v;
    this.data[i * 4] = d0;
    this.data[i * 4 + 1] = sky;
    this.data[i * 4 + 2] = blk;
    this.data[i * 4 + 3] = flags;
    this.extra[i * 4] = layer;
    this.extra[i * 4 + 1] = depth;
    this.extra[i * 4 + 2] = this.tint;
  }
  // Indices for the last 4 vertices; `flip` picks the other diagonal.
  quad(flip) {
    const b = this.vc - 4;
    const idx = this.index;
    const i = this.ic;
    if (flip) {
      idx[i] = b + 1; idx[i + 1] = b + 2; idx[i + 2] = b + 3;
      idx[i + 3] = b + 1; idx[i + 4] = b + 3; idx[i + 5] = b;
    } else {
      idx[i] = b; idx[i + 1] = b + 1; idx[i + 2] = b + 2;
      idx[i + 3] = b; idx[i + 4] = b + 2; idx[i + 5] = b + 3;
    }
    this.ic += 6;
  }
  result() {
    if (this.vc === 0) return null;
    const vc = this.vc;
    return {
      vertexCount: vc,
      position: this.pos.slice(0, vc * 3),
      uv: this.uv.slice(0, vc * 2),
      data: this.data.slice(0, vc * 4),
      extra: this.extra.slice(0, vc * 4),
      index: vc > 65535 ? this.index.slice(0, this.ic) : Uint16Array.from(this.index.subarray(0, this.ic)),
    };
  }
}

const builders = {
  [RENDER.OPAQUE]: new GeoBuilder(),
  [RENDER.CUTOUT]: new GeoBuilder(4096),
  [RENDER.WATER]: new GeoBuilder(4096),
};

// Copies the chunk and a 1-block border of its neighbors into the padded
// scratch volume. `neighbors[(dz + 1) * 3 + (dx + 1)]` is the chunk at
// offset (dx, dz) (index 4 is the chunk itself); missing ones read as open
// sky. Returns the highest y containing any non-air block.
function fillPadded(neighbors) {
  let maxY = -1;
  const center = neighbors[4];
  for (let pz = -1; pz <= S; pz++) {
    const nzi = pz < 0 ? 0 : pz >= S ? 2 : 1;
    const sz = pz & 15;
    for (let px = -1; px <= S; px++) {
      const src = neighbors[nzi * 3 + (px < 0 ? 0 : px >= S ? 2 : 1)];
      const sx = px & 15;
      let pi = pidx(px, 0, pz);
      if (src) {
        const blocks = src.blocks;
        const light = src.light;
        let si = (sz << 4) | sx;
        for (let y = 0; y < H; y++, pi += OY, si += 256) {
          padBlocks[pi] = blocks[si];
          padLight[pi] = light[si];
        }
      } else {
        for (let y = 0; y < H; y++, pi += OY) {
          padBlocks[pi] = BLOCK.AIR;
          padLight[pi] = 0xf0;
        }
      }
      // Below the world: solid and dark. Above: open sky.
      padBlocks[pidx(px, -1, pz)] = BLOCK.BEDROCK;
      padLight[pidx(px, -1, pz)] = 0;
      padBlocks[pidx(px, H, pz)] = BLOCK.AIR;
      padLight[pidx(px, H, pz)] = 0xf0;
    }
  }
  const blocks = center.blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i] !== BLOCK.AIR) {
      maxY = i >> 8;
      break;
    }
  }
  return maxY;
}

function hash01(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Smooth value noise (0-1) over the ground, with lattice cells `cell` blocks wide.
function smooth01(x, z, cell, salt) {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  let tx = fx - ix;
  let tz = fz - iz;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = hash01(ix, salt, iz);
  const b = hash01(ix + 1, salt, iz);
  const c = hash01(ix, salt, iz + 1);
  const d = hash01(ix + 1, salt, iz + 1);
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

// Natural color variation: leaves differ from tree to tree and block to
// block, grass drifts in broad patches across a meadow (128 = no tint).
function foliageTint(wx, y, wz) {
  const v = smooth01(wx, wz, 7, 3) * 0.65 + hash01(wx, y, wz) * 0.35;
  return Math.max(16, Math.min(240, Math.round(128 + (v - 0.5) * 230)));
}
export function grassTint(wx, wz) {
  const v = smooth01(wx, wz, 11, 5) * 0.75 + smooth01(wx, wz, 3, 9) * 0.25;
  return Math.max(24, Math.min(232, Math.round(128 + (v - 0.5) * 200)));
}

// Depth of water in the column at padded (x, z) starting at y and going
// down (0 if that cell isn't water).
function waterDepth(x, y, z) {
  let d = 0;
  let pi = pidx(x, y, z);
  while (d < 15 && padBlocks[pi] === BLOCK.WATER) {
    d++;
    pi -= OY;
  }
  return d;
}

const aoVals = [0, 0, 0, 0];
const skyVals = [0, 0, 0, 0];
const blkVals = [0, 0, 0, 0];

// Computes AO (0-3) and averaged sky/block light for the 4 corners of face
// `face` of the block at padded index `pi`.
function shadeCorners(pi, face) {
  const npi = pi + face.neighbor;
  const nl = padLight[npi];
  for (let c = 0; c < 4; c++) {
    const corner = face.corners[c];
    const i1 = npi - face.neighbor + corner.side1;
    const i2 = npi - face.neighbor + corner.side2;
    const i3 = npi - face.neighbor + corner.corner;
    const o1 = IS_OPAQUE[padBlocks[i1]];
    const o2 = IS_OPAQUE[padBlocks[i2]];
    const o3 = IS_OPAQUE[padBlocks[i3]];
    aoVals[c] = o1 && o2 ? 0 : 3 - (o1 + o2 + o3);
    let sky = nl >> 4;
    let blk = nl & 15;
    let n = 1;
    if (!o1) {
      sky += padLight[i1] >> 4;
      blk += padLight[i1] & 15;
      n++;
    }
    if (!o2) {
      sky += padLight[i2] >> 4;
      blk += padLight[i2] & 15;
      n++;
    }
    if (!o3 && !(o1 && o2)) {
      sky += padLight[i3] >> 4;
      blk += padLight[i3] & 15;
      n++;
    }
    skyVals[c] = Math.round((sky / n) * 17);
    blkVals[c] = Math.round((blk / n) * 17);
  }
}

function emitCubeFace(b, face, x, y, z, layer, flags, topY, depths) {
  const fi = face.index;
  for (let c = 0; c < 4; c++) {
    const corner = face.corners[c];
    const p = corner.pos;
    let vy = y + p[1];
    let vflags = flags;
    if (topY !== 1 && p[1] === 1) {
      vy = y + topY; // lowered water surface
      vflags |= FLAG.SURFACE;
    }
    b.vertex(x + p[0], vy, z + p[2], corner.uv[0], corner.uv[1], fi * 4 + aoVals[c], skyVals[c], blkVals[c], vflags, layer, depths ? depths[c] : 0);
  }
  // Split the quad along the diagonal that keeps dark corners contained.
  const a02 = aoVals[0] + aoVals[2];
  const a13 = aoVals[1] + aoVals[3];
  b.quad(a02 < a13 || (a02 === a13 && skyVals[0] + skyVals[2] + blkVals[0] + blkVals[2] < skyVals[1] + skyVals[3] + blkVals[1] + blkVals[3]));
}

function emitCross(b, x, y, z, wx, wz, id, pi) {
  const layer = FACE_TILES[id * 6 + 2];
  const l = padLight[pi];
  const sky = (l >> 4) * 17;
  const blk = (l & 15) * 17;
  // Jitter the plant's position a little so fields of grass look natural.
  const jx = (hash01(wx, y, wz) - 0.5) * 0.3;
  const jz = (hash01(wz, y, wx) - 0.5) * 0.3;
  const height = 0.85 + hash01(wx + 7, y, wz - 3) * 0.2;
  const lo = 0.15;
  const hi = 0.85;
  const top = WAVES[id] ? FLAG.WAVE : 0;
  b.tint = id === BLOCK.TALL_GRASS ? grassTint(wx, wz) : 128;
  const up = 2 * 4 + 3; // normal index "up", no AO
  const quads = [
    [lo, lo, hi, hi],
    [lo, hi, hi, lo],
  ];
  for (const [x0, z0, x1, z1] of quads) {
    const ax = x + x0 + jx;
    const az = z + z0 + jz;
    const bx = x + x1 + jx;
    const bz = z + z1 + jz;
    b.vertex(ax, y, az, 0, 0, up, sky, blk, FLAG.FOLIAGE, layer, 0);
    b.vertex(ax, y + height, az, 0, 1, up, sky, blk, top | FLAG.FOLIAGE, layer, 0);
    b.vertex(bx, y + height, bz, 1, 1, up, sky, blk, top | FLAG.FOLIAGE, layer, 0);
    b.vertex(bx, y, bz, 1, 0, up, sky, blk, FLAG.FOLIAGE, layer, 0);
    b.quad(false);
  }
  b.tint = 128;
}

// Fancy leaves (High/Ultra): two extra leaf "cards" through every leaf
// block on the outside of a canopy, turned to a random angle and a little
// larger than the block, so canopies look fuller and their silhouettes
// break up instead of reading as stacked cubes. They sway with the leaves
// and take the brightest light around the block (leaves themselves block
// sky light).
const NEIGHBOR_STEPS = [OX, -OX, OY, -OY, OZ, -OZ];
function emitLeafCards(b, x, y, z, wx, wz, id, pi) {
  const layer = FACE_TILES[id * 6 + 2];
  let sky = 0;
  let blk = 0;
  for (const step of NEIGHBOR_STEPS) {
    const l = padLight[pi + step];
    sky = Math.max(sky, l >> 4);
    blk = Math.max(blk, l & 15);
  }
  sky *= 17;
  blk *= 17;
  const flags = (WAVES[id] ? FLAG.WAVE : 0) | FLAG.FOLIAGE;
  const up = 2 * 4 + 3;
  const angle = hash01(wx, y, wz) * Math.PI;
  // Within the block's height (no fins above a flat canopy top), but wider
  // than the block, so the cards poke out past its edges and corners.
  const half = 0.66 + hash01(wz, y, wx) * 0.1;
  const cx = x + 0.5 + (hash01(wx + 3, y, wz) - 0.5) * 0.16;
  const cz = z + 0.5 + (hash01(wx, y, wz + 5) - 0.5) * 0.16;
  const y0 = y + 0.02;
  const y1 = y + 0.98;
  for (let k = 0; k < 2; k++) {
    const a = angle + k * (Math.PI / 2);
    const dx = Math.cos(a) * half;
    const dz = Math.sin(a) * half;
    b.vertex(cx - dx, y0, cz - dz, 0, 0, up, sky, blk, flags, layer, 0);
    b.vertex(cx - dx, y1, cz - dz, 0, 1, up, sky, blk, flags, layer, 0);
    b.vertex(cx + dx, y1, cz + dz, 1, 1, up, sky, blk, flags, layer, 0);
    b.vertex(cx + dx, y0, cz + dz, 1, 0, up, sky, blk, flags, layer, 0);
    b.quad(false);
  }
}

// Torch: a thin stick (2x10 sixteenths of a block) textured from the middle
// 4-pixel column of the 32x32 torch tile, whose flame sits at the top.
const TORCH_MIN = 7 / 16;
const TORCH_MAX = 9 / 16;
const TORCH_H = 10 / 16;
const TU0 = 14 / 32;
const TU1 = 18 / 32;
function emitTorch(b, x, y, z, id, pi) {
  const layer = FACE_TILES[id * 6 + 2];
  const l = padLight[pi];
  const sky = (l >> 4) * 17;
  const blk = (l & 15) * 17;
  const flags = FLAG.EMISSIVE;
  for (const face of FACES) {
    const fi = face.index;
    for (let c = 0; c < 4; c++) {
      const p = face.corners[c].pos;
      const px = x + (p[0] ? TORCH_MAX : TORCH_MIN);
      const py = y + p[1] * TORCH_H;
      const pz = z + (p[2] ? TORCH_MAX : TORCH_MIN);
      let u;
      let v;
      const [fu, fv] = face.corners[c].uv;
      if (fi === 2) {
        u = TU0 + fu * (TU1 - TU0); // flame top
        v = 16 / 32 + fv * (4 / 32);
      } else if (fi === 3) {
        u = TU0 + fu * (TU1 - TU0);
        v = fv * (4 / 32);
      } else {
        u = TU0 + fu * (TU1 - TU0);
        v = fv * (20 / 32);
      }
      b.vertex(px, py, pz, u, v, fi * 4 + 3, sky, blk, flags, layer, 0);
    }
    b.quad(false);
  }
}

// neighbors: 9 chunks as described in fillPadded (center at index 4).
// options: { fancyLeaves } (see emitLeafCards).
// Returns { opaque, cutout, water } where each is null or a buffer set.
export function meshChunk(neighbors, options = {}) {
  const fancyLeaves = !!options.fancyLeaves;
  const center = neighbors[4];
  const maxY = fillPadded(neighbors);
  for (const b of Object.values(builders)) b.reset();
  const baseX = center.cx * S;
  const baseZ = center.cz * S;
  const depths = [0, 0, 0, 0];

  for (let y = 0; y <= maxY; y++) {
    for (let z = 0; z < S; z++) {
      let pi = pidx(0, y, z);
      for (let x = 0; x < S; x++, pi++) {
        const id = padBlocks[pi];
        if (id === BLOCK.AIR) continue;
        const rt = RENDER_TYPE[id];
        if (rt === RENDER.NONE) continue;
        const b = builders[rt];
        const shape = SHAPE_OF[id];
        if (shape === SHAPE.CROSS) {
          emitCross(b, x, y, z, baseX + x, baseZ + z, id, pi);
          continue;
        }
        if (shape === SHAPE.TORCH) {
          emitTorch(b, x, y, z, id, pi);
          continue;
        }

        const isWater = rt === RENDER.WATER;
        let topY = 1;
        if (isWater && padBlocks[pi + OY] !== BLOCK.WATER) topY = WATER_SURFACE_HEIGHT;
        let baseFlags = 0;
        if (WAVES[id]) baseFlags |= FLAG.WAVE;
        if (EMISSIVE[id]) baseFlags |= FLAG.EMISSIVE;
        const leaves = IS_LEAVES[id] === 1;
        if (leaves) {
          baseFlags |= FLAG.FOLIAGE;
          b.tint = foliageTint(baseX + x, y, baseZ + z);
        }
        let exposed = false;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const nid = padBlocks[pi + face.neighbor];
          if (IS_OPAQUE[nid]) continue;
          if (rt !== RENDER.OPAQUE && nid === id) continue; // glass-glass, leaf-leaf, water-water
          // Water's top face is visible from below the lowered surface even
          // if something non-opaque (e.g. a plant) sits on top; other faces
          // of water next to water were skipped above.
          exposed = true;
          shadeCorners(pi, face);
          let flags = baseFlags;
          if (id === BLOCK.GRASS) b.tint = f === 2 ? grassTint(baseX + x, baseZ + z) : 128;
          let faceDepths = null;
          if (isWater) {
            if (f === 2) {
              for (let c = 0; c < 4; c++) {
                const cp = face.corners[c].pos;
                // Average the depth of the (up to) 4 water columns meeting at this corner.
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                  const cx = x + cp[0] - (k & 1);
                  const cz = z + cp[2] - (k >> 1);
                  sum += waterDepth(cx, y, cz);
                }
                depths[c] = Math.min(255, Math.round((sum / 4) * 16));
              }
            } else {
              depths[0] = depths[1] = depths[2] = depths[3] = 16;
            }
            faceDepths = depths;
          } else if (nid === BLOCK.WATER) {
            flags |= FLAG.UNDERWATER;
          }
          emitCubeFace(b, face, x, y, z, FACE_TILES[id * 6 + f], flags, isWater ? topY : 1, faceDepths);
        }
        if (fancyLeaves && exposed && leaves) emitLeafCards(b, x, y, z, baseX + x, baseZ + z, id, pi);
        b.tint = 128;
      }
    }
  }

  return {
    opaque: builders[RENDER.OPAQUE].result(),
    cutout: builders[RENDER.CUTOUT].result(),
    water: builders[RENDER.WATER].result(),
  };
}
