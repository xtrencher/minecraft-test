// Ground plants near the player (High and Ultra presets), drawn as
// instanced meshes on top of the blocks:
//   short tufts   thin blades on every grass block
//   tall grass    taller, arching blades (dense on Ultra)
//   reeds         stalks with cattails along shores and in shallow water
//   ferns         arching fronds in the shade of trees
//   flowers       small blossoms in scattered patches
// Everything is lit like the terrain (the voxel light above the block, sun
// shadows, light shining through when you look toward the sun), sways in the
// wind, bends away from the player's feet, and thins out and shrinks toward
// the edge of the radius so nothing pops in or out.
//
// Each chunk's plant spots are found once and cached until the chunk is
// rebuilt (an edit or a light change); the instance buffers are refilled
// when the player has moved a little or a chunk nearby changed.
import * as THREE from "three";
import { BLOCK } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT } from "./constants.js";
import { createGrassMaterial } from "./shaders.js";

const REBUILD_DISTANCE = 1.5; // blocks moved before the plants are refilled

// Ground-cover blocks the mesher hides on High/Ultra (mesher.js
// hideGroundPlants); this field's own tufts and flowers replace them.
const GROUND_COVER_IDS = new Set([BLOCK.TALL_GRASS, BLOCK.FLOWER_RED, BLOCK.FLOWER_YELLOW]);

// Spot kinds (bit flags) found by the chunk scan.
const GRASS_TOP = 1;
const SHORE = 2;
const SHADE = 4;
const SHALLOW = 8;

// Settings per level (1 = High, 2 = Ultra): radius in blocks, tufts per block.
const LEVELS = {
  1: { radius: 20, short: 1, tall: 1 },
  2: { radius: 32, short: 1, tall: 2.2 },
};

function hash(x, z, k) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(k | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(x, z, cell, salt) {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  let tx = fx - ix;
  let tz = fz - iz;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = hash(ix, iz, salt);
  const b = hash(ix + 1, iz, salt);
  const c = hash(ix, iz + 1, salt);
  const d = hash(ix + 1, iz + 1, salt);
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

function rnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Plant geometry ----------
// Per vertex: position, color (linear), "tip" (0 at the ground, 1 at the top:
// wind sway and ambient occlusion), a normal for lighting, and "paint" (1
// where the instance's own color replaces the vertex color: flower petals).

class Shape {
  constructor() {
    this.pos = [];
    this.col = [];
    this.tip = [];
    this.nrm = [];
    this.paint = [];
  }

  tri(a, b, c, colA, colB, colC, tA, tB, tC, n, paint = 0) {
    this.pos.push(...a, ...b, ...c);
    this.col.push(...colA, ...colB, ...colC);
    this.tip.push(tA, tB, tC);
    for (let i = 0; i < 3; i++) this.nrm.push(n[0], n[1], n[2]);
    this.paint.push(paint, paint, paint);
  }

  // A blade, stalk or frond from `base`, rising `height` in `seg` segments,
  // bending `bend` blocks along direction d, tapering from width w0 to a point.
  blade(base, d, height, w0, bend, colBase, colTip, seg = 2) {
    const side = [-d[1], d[0]];
    const n = [side[0], 0, side[1]];
    const pts = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const off = bend * t * t;
      pts.push([base[0] + d[0] * off, base[1] + height * t * (1 - 0.3 * Math.min(1, Math.abs(bend)) * t), base[2] + d[1] * off, w0 * (1 - t * 0.92)]);
    }
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let i = 0; i < seg; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const tp = i / seg;
      const tq = (i + 1) / seg;
      const cp = mix(colBase, colTip, tp);
      const cq = mix(colBase, colTip, tq);
      const pl = [p[0] - side[0] * p[3], p[1], p[2] - side[1] * p[3]];
      const pr = [p[0] + side[0] * p[3], p[1], p[2] + side[1] * p[3]];
      if (i === seg - 1) {
        this.tri(pl, pr, [q[0], q[1], q[2]], cp, cp, cq, tp, tp, tq, n);
      } else {
        const ql = [q[0] - side[0] * q[3], q[1], q[2] - side[1] * q[3]];
        const qr = [q[0] + side[0] * q[3], q[1], q[2] + side[1] * q[3]];
        this.tri(pl, pr, qr, cp, cp, cq, tp, tp, tq, n);
        this.tri(pl, qr, ql, cp, cq, cq, tp, tq, tq, n);
      }
    }
  }

  geometry() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("aColor", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aTip", new THREE.Float32BufferAttribute(this.tip, 1));
    g.setAttribute("aBladeNormal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("aPaint", new THREE.Float32BufferAttribute(this.paint, 1));
    return g;
  }
}

// grass: [r, g, b] linear average color of the grass block's top.
function buildShapes(grass) {
  const g = (f, add = [0, 0, 0]) => [grass[0] * f + add[0], grass[1] * f + add[1], grass[2] * f + add[2]];
  const shapes = {};
  {
    // Short tufts: thin blades spread over the block.
    const s = new Shape();
    const r = rnd(11);
    for (let b = 0; b < 10; b++) {
      const a = r() * Math.PI * 2;
      const dist = Math.sqrt(r()) * 0.42;
      const dir = r() * Math.PI * 2;
      s.blade([Math.cos(a) * dist, 0, Math.sin(a) * dist], [Math.cos(dir), Math.sin(dir)], 0.3 + r() * 0.4, 0.018 + r() * 0.02, (r() - 0.5) * 0.25, g(0.9), g(1.4, [0.035, 0.03, 0]), 1);
    }
    shapes.short = s;
  }
  {
    // Tall grass: longer blades arching outward, yellowing toward the tips.
    const s = new Shape();
    const r = rnd(23);
    for (let b = 0; b < 9; b++) {
      const a = r() * Math.PI * 2;
      const dist = Math.sqrt(r()) * 0.36;
      s.blade([Math.cos(a) * dist, 0, Math.sin(a) * dist], [Math.cos(a), Math.sin(a)], 0.6 + r() * 0.5, 0.03 + r() * 0.02, 0.15 + r() * 0.3, g(0.8), g(1.35, [0.07, 0.05, 0]), 3);
    }
    shapes.tall = s;
  }
  {
    // Reeds: tall stalks, cattails on some, and long arching leaves.
    const s = new Shape();
    const r = rnd(37);
    const cat = [0.2, 0.1, 0.04];
    for (let b = 0; b < 5; b++) {
      const a = r() * Math.PI * 2;
      const dist = Math.sqrt(r()) * 0.3;
      const x = Math.cos(a) * dist;
      const z = Math.sin(a) * dist;
      const h = 1.3 + r() * 0.8;
      const dir = r() * Math.PI;
      const d = [Math.cos(dir), Math.sin(dir)];
      s.blade([x, 0, z], d, h, 0.028, 0.05, [0.2, 0.3, 0.09], [0.36, 0.45, 0.16], 3);
      if (r() < 0.6) {
        // A cattail: two crossed narrow diamonds high up the stalk.
        const y0 = h * 0.62;
        const y1 = h * 0.86;
        for (const [ux, uz] of [d, [-d[1], d[0]]]) {
          const w = 0.07;
          const my = (y0 + y1) / 2;
          const n = [-uz, 0, ux];
          s.tri([x, y0, z], [x + ux * w, my, z + uz * w], [x, y1, z], cat, cat, cat, 0.65, 0.75, 0.86, n);
          s.tri([x, y0, z], [x, y1, z], [x - ux * w, my, z - uz * w], cat, cat, cat, 0.65, 0.86, 0.75, n);
        }
      }
    }
    for (let b = 0; b < 3; b++) {
      const a = r() * Math.PI * 2;
      s.blade([Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1], [Math.cos(a), Math.sin(a)], 0.9 + r() * 0.5, 0.045, 0.45 + r() * 0.3, [0.18, 0.3, 0.08], [0.42, 0.5, 0.18], 3);
    }
    shapes.reed = s;
  }
  {
    // Ferns: fronds rising and arching outward.
    const s = new Shape();
    const r = rnd(41);
    const n = 7;
    for (let b = 0; b < n; b++) {
      const a = ((b + r() * 0.5) / n) * Math.PI * 2;
      s.blade([0, 0, 0], [Math.cos(a), Math.sin(a)], 0.45 + r() * 0.25, 0.13, 0.55 + r() * 0.25, [0.05, 0.16, 0.04], [0.18, 0.38, 0.1], 4);
    }
    shapes.fern = s;
  }
  {
    // Flowers: stems with a small star of petals (colored per instance).
    const s = new Shape();
    const r = rnd(53);
    for (let b = 0; b < 3; b++) {
      const a = r() * Math.PI * 2;
      const dist = r() * 0.28;
      const x = Math.cos(a) * dist;
      const z = Math.sin(a) * dist;
      const h = 0.32 + r() * 0.24;
      const dir = r() * Math.PI;
      s.blade([x, 0, z], [Math.cos(dir), Math.sin(dir)], h, 0.016, 0.04, [0.14, 0.28, 0.07], [0.24, 0.4, 0.12], 2);
      const pr = 0.08 + r() * 0.03;
      const white = [1, 1, 1];
      for (let p = 0; p < 5; p++) {
        const pa = (p / 5) * Math.PI * 2 + r() * 0.3;
        const pb = pa + 0.55;
        s.tri([x, h, z], [x + Math.cos(pa) * pr, h + 0.025, z + Math.sin(pa) * pr], [x + Math.cos(pb) * pr, h + 0.025, z + Math.sin(pb) * pr], white, white, white, 1, 1, 1, [0, 1, 0], 1);
      }
      const eye = [0.9, 0.65, 0.12];
      s.tri([x - 0.02, h + 0.03, z], [x + 0.02, h + 0.03, z], [x, h + 0.03, z + 0.025], eye, eye, eye, 1, 1, 1, [0, 1, 0]);
    }
    shapes.flower = s;
  }
  return shapes;
}

const FLOWER_COLORS = [
  [0.85, 0.12, 0.1],
  [0.95, 0.75, 0.12],
  [0.55, 0.3, 0.85],
  [0.95, 0.95, 0.92],
  [0.95, 0.45, 0.65],
];

// One plant type: its instance buffers and mesh.
class Layer {
  constructor(shape, material, capacity, group) {
    const g = shape.geometry();
    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.rot = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.light = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.paint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    for (const a of [this.offset, this.rot, this.light, this.paint]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("iOffset", this.offset);
    g.setAttribute("iRotScaleTint", this.rot);
    g.setAttribute("iLight", this.light);
    g.setAttribute("iPaint", this.paint);
    g.instanceCount = 0;
    this.geometry = g;
    this.capacity = capacity;
    this.count = 0;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    group.add(this.mesh);
  }

  add(x, y, z, angle, scale, tint, sky, blk, paint = null) {
    if (this.count >= this.capacity) return;
    const n = this.count++;
    const o = this.offset.array;
    o[n * 3] = x;
    o[n * 3 + 1] = y;
    o[n * 3 + 2] = z;
    const r = this.rot.array;
    r[n * 3] = angle;
    r[n * 3 + 1] = scale;
    r[n * 3 + 2] = tint;
    this.light.array[n * 2] = sky;
    this.light.array[n * 2 + 1] = blk;
    const p = this.paint.array;
    p[n * 3] = paint ? paint[0] : 1;
    p[n * 3 + 1] = paint ? paint[1] : 1;
    p[n * 3 + 2] = paint ? paint[2] : 1;
  }

  commit() {
    this.geometry.instanceCount = this.count;
    // Upload only the part in use.
    for (const a of [this.offset, this.rot, this.light, this.paint]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, this.count) * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

export class GrassField {
  constructor(scene, world) {
    this.world = world;
    const p = world.facePalette.top;
    const i = BLOCK.GRASS * 3;
    const grass = [p[i] * 1.05, p[i + 1] * 1.1, p[i + 2] * 0.95];
    this.material = createGrassMaterial();
    this.mesh = new THREE.Group(); // all plant types
    this.mesh.visible = false;
    scene.add(this.mesh);
    const shapes = buildShapes(grass);
    this.layers = {
      short: new Layer(shapes.short, this.material, 7000, this.mesh),
      tall: new Layer(shapes.tall, this.material, 9000, this.mesh),
      reed: new Layer(shapes.reed, this.material, 1500, this.mesh),
      fern: new Layer(shapes.fern, this.material, 1500, this.mesh),
      flower: new Layer(shapes.flower, this.material, 1500, this.mesh),
    };

    this.density = 0; // level: 0 off, 1 High, 2 Ultra
    this.radius = 16;
    this._cache = new WeakMap(); // chunk -> { version, spots: Float32Array [x, y, z, sky, block, kind, ...] }
    this._builtAt = new THREE.Vector3(Infinity, 0, 0);
    this._versions = new Map(); // chunk -> mesh count at the last fill
    this.count = 0;
  }

  // level: 0 turns the plants off, 1 = High, 2 = Ultra.
  configure({ level }) {
    this.density = level;
    const cfg = LEVELS[level];
    this.radius = cfg ? cfg.radius : 16;
    this.material.uniforms.uRadius.value = this.radius;
    this.mesh.visible = !!cfg;
    this._builtAt.set(Infinity, 0, 0);
  }

  // Plant spots in one chunk: open ground with the light above it, and what
  // kind of place it is (grass, shore, shade, shallow water).
  _spots(chunk) {
    const version = chunk.meshCount || 0;
    const cached = this._cache.get(chunk);
    if (cached && cached.version === version) return cached.spots;
    const S = CHUNK_SIZE;
    const blocks = chunk.blocks;
    const light = chunk.light;
    const w = this.world;
    const bx = chunk.cx * S;
    const bz = chunk.cz * S;
    const waterNear = (x, y, z) => {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          if ((dx || dz) && w.getBlock(x + dx, y, z + dz) === BLOCK.WATER) return true;
        }
      }
      return false;
    };
    const out = [];
    for (let y = 1; y < WORLD_HEIGHT - 1; y++) {
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const i = (y * S + z) * S + x;
          const above = blocks[i + S * S];
          // Ground cover (tall grass, flowers) isn't meshed on this preset
          // (see mesher.js hideGroundPlants): these tufts and flowers replace
          // it, so spots under it are open for planting just like bare air.
          if (above !== BLOCK.AIR && !GROUND_COVER_IDS.has(above)) continue;
          const id = blocks[i];
          let kind = 0;
          if (id === BLOCK.GRASS) {
            kind = GRASS_TOP;
          } else if (id === BLOCK.WATER) {
            // Shallow water over ground: reeds stand in it.
            const below = blocks[i - S * S];
            if (below !== BLOCK.SAND && below !== BLOCK.DIRT && below !== BLOCK.GRASS && below !== BLOCK.GRAVEL) continue;
            kind = SHALLOW;
          } else if (id !== BLOCK.SAND && id !== BLOCK.DIRT) {
            continue;
          }
          if (!(kind & SHALLOW) && waterNear(bx + x, y, bz + z)) kind |= SHORE;
          if (kind === 0) continue; // bare sand or dirt away from water
          const l = light[i + S * S];
          if (l >> 4 < 14) kind |= SHADE;
          // Plants stand on the block's top (in shallow water: on its floor).
          out.push(bx + x, kind & SHALLOW ? y : y + 1, bz + z, (l >> 4) / 15, (l & 15) / 15, kind);
        }
      }
    }
    const spots = new Float32Array(out);
    this._cache.set(chunk, { version, spots });
    return spots;
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
    const cfg = LEVELS[this.density];
    this._builtAt.copy(playerPos);
    this._versions.clear();
    for (const layer of Object.values(this.layers)) layer.count = 0;
    const { short, tall, reed, fern, flower } = this.layers;
    const r = this.radius;
    for (const chunk of chunks) {
      this._versions.set(chunk, chunk.meshCount || 0);
      const spots = this._spots(chunk);
      for (let i = 0; i < spots.length; i += 6) {
        const x = spots[i];
        const y = spots[i + 1];
        const z = spots[i + 2];
        const dx = x + 0.5 - playerPos.x;
        const dz = z + 0.5 - playerPos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > r) continue;
        // Thinner toward the edge (the shader also shrinks what's left).
        const t = Math.min(1, Math.max(0, (d - r * 0.45) / (r * 0.55)));
        const keep = 1 - t * t * (3 - 2 * t);
        const sky = spots[i + 3];
        const blk = spots[i + 4];
        const kind = spots[i + 5];
        const px = (k) => x + 0.5 + (hash(x, z, k) - 0.5) * 0.6;
        const pz = (k) => z + 0.5 + (hash(z, x, k) - 0.5) * 0.6;
        const angle = (k) => hash(x, z, k + 7) * Math.PI * 2;
        const tint = (k) => 0.86 + hash(x + 3, z, k) * 0.26;
        if (kind & (SHALLOW | SHORE)) {
          if (hash(x, z, 91) < (kind & SHALLOW ? 0.35 : 0.5) * keep) reed.add(px(1), y, pz(1), angle(1), 0.8 + hash(x, z, 5) * 0.45, tint(1), sky, blk);
          if (!(kind & GRASS_TOP)) continue;
        }
        // Flowers in scattered patches.
        if (hash(x, z, 93) < Math.max(0, smooth(x, z, 9, 17) - 0.58) * 1.1 * keep) {
          const c = FLOWER_COLORS[Math.floor(smooth(x, z, 6, 29) * 4.999)];
          flower.add(px(2), y, pz(2), angle(2), 0.9 + hash(x, z, 6) * 0.3, 1, sky, blk, c);
          continue;
        }
        // Ferns in the shade.
        if (kind & SHADE && hash(x, z, 95) < 0.4 * keep) {
          fern.add(px(3), y, pz(3), angle(3), 0.8 + hash(x, z, 8) * 0.5, tint(3), sky, blk);
          continue;
        }
        const nTall = cfg.tall * keep + hash(x, z, 97);
        for (let k = 0; k + 1 <= nTall; k++) tall.add(px(10 + k), y, pz(10 + k), angle(10 + k), 0.75 + hash(z, x, k) * 0.5, tint(10 + k), sky, blk);
        const nShort = cfg.short * keep + hash(x, z, 99);
        for (let k = 0; k + 1 <= nShort; k++) short.add(px(20 + k), y, pz(20 + k), angle(20 + k), 0.75 + hash(z, x, 20 + k) * 0.5, tint(20 + k), sky, blk);
      }
    }
    let n = 0;
    for (const layer of Object.values(this.layers)) {
      layer.commit();
      n += layer.count;
    }
    this.count = n;
  }
}
