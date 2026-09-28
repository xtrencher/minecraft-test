// Ground plants near the player (High and Ultra presets), drawn as
// instanced pixel-art cards on top of the blocks:
//   grass tufts   dense blades of varying heights and greens on grass blocks
//   tall grass    taller tufts with seed heads mixed in
//   ferns         arching fronds in the shade of trees
//   flowers       five colors, in scattered patches
//   reeds         two-block-tall stalks along shores and in shallow water
//   cattails      reeds with brown spikes
//   lily pads     floating flat on calm, shallow water near the shore
// Every plant is a set of crossed cards textured from the same block texture
// array as the world, in exactly the pixel-art style of the tall-grass block
// (textures.js), so near and far grass look alike. Everything is lit like
// the terrain (the voxel light above the block, sun shadows, light shining
// through when you look toward the sun), sways in the shared wind, bends
// away from the player's feet, and thins out and shrinks toward the edge of
// the radius so nothing pops in or out.
//
// Each chunk's plant spots are found once and cached until the chunk is
// rebuilt (an edit or a light change); the instance buffers are refilled
// when the player has moved a little or a chunk nearby changed.
import * as THREE from "three";
import { BLOCK, TILE } from "./blocks.js";
import { CHUNK_SIZE, WORLD_HEIGHT } from "./constants.js";
import { createGrassMaterial } from "./shaders.js";
import { grassTint } from "./mesher.js";

const REBUILD_DISTANCE = 1.5; // blocks moved before the plants are refilled

// Spot kinds (bit flags) found by the chunk scan.
const GRASS_TOP = 1;
const SHORE = 2;
const SHADE = 4;
const SHALLOW = 8; // one block of water over soil, open air above
const WATER_TOP = 16; // an open water surface 1-3 blocks deep

// Settings per level (1 = High, 2 = Ultra): radius in blocks, tufts per block.
const LEVELS = {
  1: { radius: 20, short: 1.2, tall: 0.7 },
  2: { radius: 32, short: 2.2, tall: 1.4 },
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

// ---------- Card geometry ----------
// Per vertex: position, uv (the tile, v = 0 at the bottom), "tip" (0 at the
// ground, 1 at the top: wind sway), "step" (texture layer offset from the
// instance's layer: the upper card of a two-block reed) and "flat" (1 for a
// card lying on the water).

class Shape {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.tip = [];
    this.step = [];
    this.flat = [];
    this.index = [];
  }

  // A vertical card through the plant's center at angle `a`, `w` wide,
  // from height y0 to y1 (tip values t0..t1), layer offset `step`.
  card(a, w, y0, y1, t0, t1, step = 0) {
    const dx = Math.cos(a) * w * 0.5;
    const dz = Math.sin(a) * w * 0.5;
    const b = this.pos.length / 3;
    this.pos.push(-dx, y0, -dz, dx, y0, dz, dx, y1, dz, -dx, y1, -dz);
    this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    this.tip.push(t0, t0, t1, t1);
    for (let i = 0; i < 4; i++) {
      this.step.push(step);
      this.flat.push(0);
    }
    this.index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }

  // A flat, horizontal card (lily pad), `w` across.
  flatCard(w) {
    const h = w * 0.5;
    const b = this.pos.length / 3;
    this.pos.push(-h, 0, h, h, 0, h, h, 0, -h, -h, 0, -h);
    this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) {
      this.tip.push(0);
      this.step.push(0);
      this.flat.push(1);
    }
    this.index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }

  geometry() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("aTip", new THREE.Float32BufferAttribute(this.tip, 1));
    g.setAttribute("aStep", new THREE.Float32BufferAttribute(this.step, 1));
    g.setAttribute("aFlat", new THREE.Float32BufferAttribute(this.flat, 1));
    g.setIndex(this.index);
    return g;
  }
}

function buildShapes() {
  const shapes = {};
  // Tufts: three cards 60 degrees apart (full from every side).
  const tuft = new Shape();
  for (let k = 0; k < 3; k++) tuft.card((k * Math.PI) / 3, 1, 0, 1, 0, 1);
  shapes.tuft = tuft;
  // Flowers and ferns: two crossed cards.
  const cross = new Shape();
  for (let k = 0; k < 2; k++) cross.card((k * Math.PI) / 2 + Math.PI / 4, 1, 0, 1, 0, 1);
  shapes.cross = cross;
  // Reeds: two crossed cards stacked two blocks high (bottom tile, then the
  // top tile one layer later in the texture array).
  const reed = new Shape();
  for (let k = 0; k < 2; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    reed.card(a, 1, 0, 1, 0, 0.45, 0);
    reed.card(a, 1, 1, 2, 0.45, 1, 1);
  }
  shapes.reed = reed;
  const pad = new Shape();
  pad.flatCard(0.9);
  shapes.pad = pad;
  return shapes;
}

const FLOWER_LAYERS = [TILE.flower_red, TILE.flower_yellow, TILE.flower_blue, TILE.flower_white, TILE.flower_pink];

// One plant layer (one shape): its instance buffers and mesh.
class Layer {
  constructor(shape, material, capacity, group) {
    const g = shape.geometry();
    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.light = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.layer = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.offset, this.params, this.light, this.layer]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("iOffset", this.offset);
    g.setAttribute("iParams", this.params);
    g.setAttribute("iLight", this.light);
    g.setAttribute("iLayer", this.layer);
    g.instanceCount = 0;
    this.geometry = g;
    this.capacity = capacity;
    this.count = 0;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    group.add(this.mesh);
  }

  add(x, y, z, angle, width, height, tint, sky, blk, layer) {
    if (this.count >= this.capacity) return;
    const n = this.count++;
    const o = this.offset.array;
    o[n * 3] = x;
    o[n * 3 + 1] = y;
    o[n * 3 + 2] = z;
    const p = this.params.array;
    p[n * 4] = angle;
    p[n * 4 + 1] = width;
    p[n * 4 + 2] = height;
    p[n * 4 + 3] = tint;
    this.light.array[n * 2] = sky;
    this.light.array[n * 2 + 1] = blk;
    this.layer.array[n] = layer;
  }

  commit() {
    this.geometry.instanceCount = this.count;
    // Upload only the part in use.
    for (const a of [this.offset, this.params, this.light, this.layer]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, this.count) * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

export class GrassField {
  constructor(scene, world) {
    this.world = world;
    this.material = createGrassMaterial(world.atlas);
    this.mesh = new THREE.Group(); // all plant types
    this.mesh.visible = false;
    scene.add(this.mesh);
    const shapes = buildShapes();
    this.layers = {
      tuft: new Layer(shapes.tuft, this.material, 16000, this.mesh),
      cross: new Layer(shapes.cross, this.material, 3000, this.mesh),
      reed: new Layer(shapes.reed, this.material, 2000, this.mesh),
      pad: new Layer(shapes.pad, this.material, 1500, this.mesh),
    };

    this.density = 0; // level: 0 off, 1 High, 2 Ultra
    this.radius = 16;
    this._cache = new WeakMap(); // chunk -> { version, spots: Float32Array [x, y, z, sky, block, kind, depth, ...] }
    this._builtAt = new THREE.Vector3(Infinity, 0, 0);
    this._versions = new Map(); // chunk -> mesh count at the last fill
    this.count = 0;
    this.counts = {}; // plants per kind at the last fill (stats / tests)
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
  // kind of place it is (grass, shore, shade, shallow or open water).
  _spots(chunk) {
    const version = chunk.meshCount || 0;
    const cached = this._cache.get(chunk);
    if (cached && cached.version === version) return cached.spots;
    const S = CHUNK_SIZE;
    const L = S * S;
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
    const soil = (id) => id === BLOCK.SAND || id === BLOCK.DIRT || id === BLOCK.GRASS || id === BLOCK.GRAVEL;
    const out = [];
    for (let y = 1; y < WORLD_HEIGHT - 1; y++) {
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const i = (y * S + z) * S + x;
          if (blocks[i + L] !== BLOCK.AIR) continue;
          const id = blocks[i];
          let kind = 0;
          let depth = 0;
          if (id === BLOCK.GRASS) {
            kind = GRASS_TOP;
          } else if (id === BLOCK.WATER) {
            // How deep is the water here, and what's under it?
            let k = i;
            while (depth < 4 && k >= L && blocks[k] === BLOCK.WATER) {
              depth++;
              k -= L;
            }
            if (depth === 1 && soil(blocks[i - L])) kind = SHALLOW; // reeds stand in it
            else if (depth <= 3 && blocks[k] !== BLOCK.WATER && blocks[k] !== BLOCK.AIR) kind = WATER_TOP; // lily pads float on it
            else continue;
          } else if (id !== BLOCK.SAND && id !== BLOCK.DIRT) {
            continue;
          }
          if (kind !== SHALLOW && kind !== WATER_TOP && waterNear(bx + x, y, bz + z)) kind |= SHORE;
          if (kind === 0) continue; // bare sand or dirt away from water
          const l = light[i + L];
          if (l >> 4 < 14) kind |= SHADE;
          // Plants stand on the block's top (in shallow water: on its floor;
          // lily pads: on the water surface).
          const py = kind & SHALLOW ? y : kind & WATER_TOP ? y + 0.875 : y + 1;
          out.push(bx + x, py, bz + z, (l >> 4) / 15, (l & 15) / 15, kind, depth);
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
    const { tuft, cross, reed, pad } = this.layers;
    const counts = { tuft: 0, tall: 0, fern: 0, flower: 0, reed: 0, cattail: 0, lily: 0 };
    const r = this.radius;
    for (const chunk of chunks) {
      this._versions.set(chunk, chunk.meshCount || 0);
      const spots = this._spots(chunk);
      for (let i = 0; i < spots.length; i += 7) {
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
        const px = (k) => x + 0.5 + (hash(x, z, k) - 0.5) * 0.7;
        const pz = (k) => z + 0.5 + (hash(z, x, k) - 0.5) * 0.7;
        const angle = (k) => hash(x, z, k + 7) * Math.PI * 2;
        const tintHere = grassTint(x, z) / 255;
        const tint = (k) => Math.min(0.95, Math.max(0.05, tintHere + (hash(x + 3, z, k) - 0.5) * 0.12));
        if (kind & WATER_TOP) {
          // Lily pads in patches on calm water near the shore.
          const patch = smooth(x, z, 7, 41);
          if (hash(x, z, 61) < Math.max(0, patch - 0.45) * 1.6 * keep) {
            pad.add(px(4), y, pz(4), angle(4), 0.75 + hash(x, z, 62) * 0.5, 1, 0.5, sky, blk, TILE.lily_pad);
            counts.lily++;
          }
          continue;
        }
        if (kind & (SHALLOW | SHORE)) {
          if (hash(x, z, 91) < (kind & SHALLOW ? 0.55 : 0.4) * keep) {
            const cattail = smooth(x, z, 5, 19) > 0.55;
            reed.add(px(1), y, pz(1), angle(1), 0.9 + hash(x, z, 5) * 0.3, 0.75 + hash(x, z, 6) * 0.35, tint(1), sky, blk, cattail ? TILE.cattail_bottom : TILE.reed_bottom);
            counts[cattail ? "cattail" : "reed"]++;
          }
          if (!(kind & GRASS_TOP)) continue;
        }
        // Flowers in scattered patches.
        if (hash(x, z, 93) < Math.max(0, smooth(x, z, 9, 17) - 0.58) * 1.1 * keep) {
          const layer = FLOWER_LAYERS[Math.floor(smooth(x, z, 6, 29) * 4.999)];
          cross.add(px(2), y, pz(2), angle(2), 0.7, 0.6 + hash(x, z, 6) * 0.25, 0.5, sky, blk, layer);
          counts.flower++;
        }
        // Ferns in the shade.
        if (kind & SHADE && hash(x, z, 95) < 0.4 * keep) {
          cross.add(px(3), y, pz(3), angle(3), 1.1, 0.8 + hash(x, z, 8) * 0.5, tint(3), sky, blk, TILE.fern);
          counts.fern++;
          continue;
        }
        // Lush grass: short tufts everywhere, taller tufts in drifts. Heights
        // vary per tuft (and the tiles hold blades of many heights).
        const tallDrift = smooth(x, z, 6, 23);
        const nTall = cfg.tall * keep * (0.4 + tallDrift * 1.2) + hash(x, z, 97);
        for (let k = 0; k + 1 <= nTall; k++) {
          tuft.add(px(10 + k), y, pz(10 + k), angle(10 + k), 0.85 + hash(x, z, 30 + k) * 0.3, 0.65 + hash(z, x, k) * 0.45, tint(10 + k), sky, blk, TILE.tall_grass);
          counts.tall++;
        }
        const nShort = cfg.short * keep + hash(x, z, 99);
        for (let k = 0; k + 1 <= nShort; k++) {
          const b = hash(x, z, 40 + k) < 0.5;
          tuft.add(px(20 + k), y, pz(20 + k), angle(20 + k), 0.8 + hash(x, z, 50 + k) * 0.35, 0.55 + hash(z, x, 20 + k) * 0.5, tint(20 + k), sky, blk, b ? TILE.grass_tuft : TILE.grass_tuft_b);
          counts.tuft++;
        }
      }
    }
    let n = 0;
    for (const layer of Object.values(this.layers)) {
      layer.commit();
      n += layer.count;
    }
    this.count = n;
    this.counts = counts;
  }
}
