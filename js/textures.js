// Procedural 32x32 pixel-art textures, painted in code (no image files).
//
// Each tile is painted into an RGBA byte array using a small toolkit:
// tileable value noise (so textures repeat seamlessly across blocks),
// quantized color ramps (the crisp, banded pixel-art look), tileable
// Voronoi cells (cobblestone, gravel, crystals) and hand-placed details.
// All block tiles go into one mipmapped THREE.DataArrayTexture (one layer
// per tile, so mipmapping never bleeds between tiles); canvases of the
// same pixels are kept for UI icons.
import * as THREE from "three";
import { TILE_NAMES, BLOCK_INFO } from "./blocks.js";

export const TEX = 32;

// ---------- Small deterministic helpers ----------

function hashInt(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function strSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function makeRand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hex(h) {
  return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
}

// ---------- Tile canvas ----------

class Tile {
  constructor(name) {
    this.name = name;
    this.seed = strSeed(name);
    this.rand = makeRand(this.seed);
    this.data = new Uint8ClampedArray(TEX * TEX * 4);
  }

  // Tileable value noise with `period` lattice cells across the tile.
  noise(x, y, period, salt = 0, periodY = period) {
    const fx = (x / TEX) * period;
    const fy = (y / TEX) * periodY;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const s = this.seed + salt * 7919;
    const h = (i, j) => hashInt(((i % period) + period) % period, ((j % periodY) + periodY) % periodY, s);
    const a = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * tx;
    const b = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  }

  fbm(x, y, period, octaves = 3, salt = 0, periodY = period) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.noise(x, y, period << o, salt + o, periodY << o) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  }

  set(x, y, rgb, a = 255) {
    x = ((x % TEX) + TEX) % TEX;
    y = ((y % TEX) + TEX) % TEX;
    const i = (y * TEX + x) * 4;
    this.data[i] = rgb[0];
    this.data[i + 1] = rgb[1];
    this.data[i + 2] = rgb[2];
    this.data[i + 3] = a;
  }

  get(x, y) {
    x = ((x % TEX) + TEX) % TEX;
    y = ((y % TEX) + TEX) % TEX;
    const i = (y * TEX + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  alpha(x, y) {
    return this.data[(y * TEX + x) * 4 + 3];
  }

  // Multiplies the pixel's color by `f` (darken < 1 < lighten).
  shade(x, y, f) {
    const c = this.get(x, y);
    this.set(x, y, [c[0] * f, c[1] * f, c[2] * f], c[3]);
  }

  forEach(fn) {
    for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) fn(x, y);
  }

  // Tileable Voronoi: returns a function (x, y) -> { d1, d2, cell, cx, cy }.
  voronoi(count, salt = 0, jitter = 1) {
    const pts = [];
    const r = makeRand(this.seed + salt * 131);
    for (let i = 0; i < count; i++) pts.push([r() * TEX, r() * TEX, r()]);
    return (x, y) => {
      let d1 = 1e9;
      let d2 = 1e9;
      let best = 0;
      for (let i = 0; i < pts.length; i++) {
        for (let ox = -TEX; ox <= TEX; ox += TEX) {
          for (let oy = -TEX; oy <= TEX; oy += TEX) {
            const dx = pts[i][0] + ox - (x + 0.5);
            const dy = pts[i][1] + oy - (y + 0.5);
            const d = Math.sqrt(dx * dx + dy * dy * jitter);
            if (d < d1) {
              d2 = d1;
              d1 = d;
              best = i;
            } else if (d < d2) d2 = d;
          }
        }
      }
      const p = pts[best];
      return { d1, d2, cell: best, value: p[2], cx: p[0], cy: p[1] };
    };
  }
}

// Picks a color from a dark->light ramp for t in [0, 1] (quantized).
function ramp(colors, t) {
  const i = Math.max(0, Math.min(colors.length - 1, Math.floor(clamp01(t) * colors.length)));
  return colors[i];
}

function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scaleRgb(c, f) {
  return [c[0] * f, c[1] * f, c[2] * f];
}

// ---------- Palettes ----------

const P = {
  dirt: [0x3f2a1b, 0x553a26, 0x684830, 0x7b573a, 0x8f6746, 0x9f7652].map(hex),
  grass: [0x2c581d, 0x386b25, 0x467f2e, 0x549237, 0x62a441, 0x74b84c, 0x8acb5b].map(hex),
  stone: [0x535358, 0x5f5f65, 0x6b6b71, 0x77777d, 0x838389, 0x909096, 0x9d9da3].map(hex),
  sand: [0xc4ad76, 0xd0b983, 0xdac48f, 0xe3ce9b, 0xebd8a8, 0xf2e2b6].map(hex),
  bark: [0x3a2719, 0x4d3421, 0x5f432b, 0x705034, 0x805d3d, 0x926c48].map(hex),
  ringsLight: [0xa77c4a, 0xb58955, 0xc19662, 0xcca36f].map(hex),
  planks: [0x7d5a34, 0x8e673c, 0x9d7445, 0xab804e, 0xb88c58, 0xc49863].map(hex),
  leaves: [0x1b4417, 0x24561d, 0x2e6824, 0x397b2b, 0x468e33, 0x57a03d, 0x6ab148].map(hex),
  water: [0x1a4a8e, 0x2157a0, 0x2965b1, 0x3274c0, 0x3c82cc].map(hex),
  bedrock: [0x151517, 0x242427, 0x333337, 0x46464a, 0x5a5a5f, 0x707075].map(hex),
  gravel: [0x5b5754, 0x6b6763, 0x7c7771, 0x8d8780, 0x9e978f, 0x746a5f, 0x877a6a].map(hex),
  brick: [0x7a3224, 0x8c3b2a, 0x9d4530, 0xad5037, 0xbb5c41].map(hex),
  wool: [0xc9c3b8, 0xd6d0c5, 0xe1dcd2, 0xebe7df, 0xf5f2ec].map(hex),
  birchBark: [0xa9a49a, 0xc4bfb4, 0xd8d3c8, 0xe6e2d8, 0xf1eee6].map(hex),
  birchLeaves: [0x3f6a1f, 0x4f7f26, 0x62942f, 0x76a83a, 0x8bbb47, 0xa2cc58].map(hex),
  pineBark: [0x2a1a12, 0x3b251a, 0x4d3122, 0x5f3d2a, 0x724a33, 0x86583c].map(hex),
  pineRings: [0x9a6d45, 0xab7c50, 0xba8a5c].map(hex),
  pineNeedles: [0x0f2f25, 0x16402f, 0x1e5139, 0x286244, 0x357350, 0x44845c].map(hex),
};

// ---------- Painters ----------

function paintDirt(t, salt = 0) {
  t.forEach((x, y) => {
    const f = t.fbm(x, y, 4, 3, salt) * 0.65 + t.rand() * 0.35;
    t.set(x, y, ramp(P.dirt, f * 1.1 - 0.05));
  });
  // Pebbles: small light stones with a highlight and a shadow pixel.
  for (let i = 0; i < 9; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    const w = t.rand() < 0.5 ? 2 : 3;
    const c = t.rand() < 0.5 ? hex(0xa58563) : hex(0x8b6e52);
    for (let dx = 0; dx < w; dx++) t.set(x + dx, y, c);
    for (let dx = 0; dx < w - 1; dx++) t.set(x + dx, y + 1, scaleRgb(c, 0.9));
    t.set(x, y, scaleRgb(c, 1.18));
    t.set(x + w - 1, y + 1, hex(0x3d2a1c));
  }
  for (let i = 0; i < 22; i++) t.set(Math.floor(t.rand() * TEX), Math.floor(t.rand() * TEX), hex(0x35241a));
  // Thin, wandering roots.
  for (let i = 0; i < 3; i++) {
    let x = Math.floor(t.rand() * TEX);
    let y = Math.floor(t.rand() * TEX);
    const len = 4 + Math.floor(t.rand() * 5);
    for (let k = 0; k < len; k++) {
      t.set(x, y, hex(0x4a3222));
      x += t.rand() < 0.6 ? 1 : 0;
      y += t.rand() < 0.5 ? 1 : 0;
    }
  }
  // A few grey flint chips with a bright edge.
  for (let i = 0; i < 4; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    t.set(x, y, hex(0x8a8580));
    t.set(x + 1, y, hex(0x6d6965));
    t.set(x, y - 1, hex(0xb3aea7));
  }
}

function paintGrassTop(t) {
  t.forEach((x, y) => {
    // Broad clumps (light and dark patches) under the fine speckle.
    const clump = t.fbm(x, y, 2, 2, 21) - 0.5;
    const f = t.fbm(x, y, 4, 3) * 0.5 + t.rand() * 0.42 + clump * 0.35;
    t.set(x, y, ramp(P.grass, f));
  });
  // Shadowed gaps between clumps of blades.
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    t.set(x, y, P.grass[0]);
    if (t.rand() < 0.5) t.set(x + 1, y, P.grass[1]);
  }
  // Blades: short vertical strokes, lighter at the tip.
  for (let i = 0; i < 110; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    const len = 2 + Math.floor(t.rand() * 2);
    const light = t.rand() < 0.55;
    for (let k = 0; k < len; k++) {
      const shadeIdx = light ? 4 + (k === 0 ? 2 : 1) : 1 + (k === 0 ? 1 : 0);
      t.set(x, y + k, P.grass[Math.min(P.grass.length - 1, shadeIdx)]);
    }
  }
  // A few tiny yellow-green sun flecks.
  for (let i = 0; i < 10; i++) t.set(Math.floor(t.rand() * TEX), Math.floor(t.rand() * TEX), hex(0xa3d66a));
}

function paintGrassSide(t) {
  paintDirt(t, 3);
  const fringe = [];
  for (let x = 0; x < TEX; x++) {
    let depth = 5 + Math.floor(t.noise(x, 0, 8, 5) * 3);
    if (t.rand() < 0.22) depth += 1 + Math.floor(t.rand() * 3); // occasional drip
    fringe.push(depth);
  }
  for (let x = 0; x < TEX; x++) {
    const depth = fringe[x];
    for (let y = 0; y < depth; y++) {
      const f = t.fbm(x, y, 4, 2, 9) * 0.6 + t.rand() * 0.4;
      t.set(x, y, ramp(P.grass, f * 0.9 + (y < 2 ? 0.12 : 0)));
    }
    t.set(x, depth, hex(0x274a19)); // dark lip of the overhang
    t.shade(x, depth + 1, 0.72); // soft shadow on the dirt below
  }
}

function paintStone(t, salt = 0) {
  t.forEach((x, y) => {
    const large = t.fbm(x, y, 2, 4, salt); // big mottled patches
    const grain = t.noise(x, y, 16, salt + 5); // fine grain
    const f = large * 0.72 + grain * 0.28 + (t.rand() - 0.5) * 0.14;
    t.set(x, y, ramp(P.stone, (f - 0.5) * 2.1 + 0.52)); // stretch contrast around the middle
  });
  // Pits: a dark pixel with a light rim below/right, like tiny recesses.
  for (let i = 0; i < 16; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    t.set(x, y, hex(0x46464b));
    t.set(x + 1, y + 1, hex(0xa2a2a8));
  }
  // A couple of short hairline cracks.
  for (let i = 0; i < 2; i++) {
    let x = Math.floor(t.rand() * TEX);
    let y = Math.floor(t.rand() * TEX);
    const len = 4 + Math.floor(t.rand() * 6);
    for (let k = 0; k < len; k++) {
      t.set(x, y, hex(0x4a4a4f));
      x += 1;
      if (t.rand() < 0.45) y += t.rand() < 0.5 ? -1 : 1;
    }
  }
  for (let i = 0; i < 18; i++) t.set(Math.floor(t.rand() * TEX), Math.floor(t.rand() * TEX), hex(0xa9a9af));
  // Faint strata: gently wavy darker bands running across the rock.
  t.forEach((x, y) => {
    const band = Math.sin((y + Math.sin(x * 0.3 + t.noise(x, 0, 4, 13) * 4) * 1.6) * 0.7);
    if (band > 0.93) t.shade(x, y, 0.9);
  });
  // Mica specks that catch the light.
  for (let i = 0; i < 7; i++) t.set(Math.floor(t.rand() * TEX), Math.floor(t.rand() * TEX), hex(0xc4c6cf));
}

function paintCobblestone(t) {
  const vor = t.voronoi(13, 1);
  t.forEach((x, y) => {
    const v = vor(x, y);
    const edge = v.d2 - v.d1;
    if (edge < 1.1) {
      t.set(x, y, hex(0x38383c));
      return;
    }
    // Rounded stones: lit from the top-left, shaded toward the bottom-right.
    let dx = x + 0.5 - v.cx;
    let dy = y + 0.5 - v.cy;
    if (dx > TEX / 2) dx -= TEX;
    if (dx < -TEX / 2) dx += TEX;
    if (dy > TEX / 2) dy -= TEX;
    if (dy < -TEX / 2) dy += TEX;
    const light = -(dx + dy) * 0.045;
    const f = 0.3 + v.value * 0.45 + light + t.rand() * 0.12 - (edge < 2.1 ? 0.2 : 0);
    t.set(x, y, ramp(P.stone, f));
  });
}

function paintSand(t) {
  t.forEach((x, y) => {
    const phase = (y + t.fbm(x, y, 4, 2, 4) * 7) * 0.75;
    const ripple = Math.sin(phase) * 0.12;
    // Crests lit on their windward side, shaded on the lee side.
    const slope = Math.cos(phase) * 0.07;
    const f = t.fbm(x, y, 8, 2) * 0.35 + t.rand() * 0.45 + ripple + slope + 0.12;
    t.set(x, y, ramp(P.sand, f));
  });
  // Coarse grains: a dark pixel with a light one beside it.
  for (let i = 0; i < 14; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    t.set(x, y, hex(0xb49c68));
    t.set(x + 1, y, hex(0xf6ead0));
  }
  // Tiny pale shell fragments.
  for (let i = 0; i < 3; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    t.set(x, y, hex(0xfbf3e3));
    t.set(x + 1, y, hex(0xe9d9c0));
    t.set(x, y + 1, hex(0xd9c6a4));
  }
  for (let i = 0; i < 22; i++) t.set(Math.floor(t.rand() * TEX), Math.floor(t.rand() * TEX), hex(0xad9563));
  for (let i = 0; i < 12; i++) t.set(Math.floor(t.rand() * TEX), Math.floor(t.rand() * TEX), hex(0xf8eed0));
}

function paintGravel(t) {
  const vor = t.voronoi(30, 2);
  t.forEach((x, y) => {
    const v = vor(x, y);
    if (v.d2 - v.d1 < 0.9) {
      t.set(x, y, hex(0x3c3936));
      return;
    }
    let dx = x + 0.5 - v.cx;
    let dy = y + 0.5 - v.cy;
    if (Math.abs(dx) > TEX / 2) dx -= Math.sign(dx) * TEX;
    if (Math.abs(dy) > TEX / 2) dy -= Math.sign(dy) * TEX;
    const base = P.gravel[Math.floor(v.value * P.gravel.length)];
    const f = 1 - (dx + dy) * 0.05 + (t.rand() - 0.5) * 0.12;
    t.set(x, y, scaleRgb(base, f));
  });
}

function paintBark(t) {
  t.forEach((x, y) => {
    // Vertical fibers: noise that varies across the trunk but barely along
    // it, with the x coordinate gently meandering so grooves aren't ruler-straight.
    const mx = x + Math.sin(y * 0.35 + t.noise(x, 0, 4, 9) * 6) * 0.9;
    const fiber = t.fbm(mx, y, 8, 2, 0, 1);
    const along = t.noise(x, y, 4, 3, 8) * 0.25;
    const f = fiber * 0.75 + along + (t.rand() - 0.5) * 0.12;
    let col;
    if (f < 0.34) col = P.bark[0]; // deep groove
    else if (f < 0.42) col = P.bark[1];
    else col = ramp(P.bark, (f - 0.42) * 1.9 + 0.3);
    t.set(x, y, col);
  });
  // Ridge highlights where a groove's right edge catches the light.
  t.forEach((x, y) => {
    const c = t.get(x, y);
    const l = t.get(x - 1, y);
    if (l[0] === P.bark[0][0] && c[0] > P.bark[2][0]) t.set(x, y, P.bark[5]);
  });
  // A knot.
  const kx = 8 + Math.floor(t.rand() * 16);
  const ky = 8 + Math.floor(t.rand() * 16);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const d = dx * dx + (dy * dy) / 2.5;
      if (d <= 1.2) t.set(kx + dx, ky + dy, d < 0.5 ? hex(0x2a1b12) : hex(0x6a4c34));
    }
  }
}

function paintWoodTop(t) {
  const c = (TEX - 1) / 2;
  t.forEach((x, y) => {
    const edge = Math.max(Math.abs(x - c), Math.abs(y - c));
    if (edge > 13.5) {
      t.set(x, y, ramp(P.bark, t.fbm(x, y, 8, 2) * 0.7 + t.rand() * 0.3));
      return;
    }
    const r = Math.hypot(x - c, y - c) + t.fbm(x, y, 4, 2, 7) * 2.6;
    const ring = (r / 2.6) % 1;
    let col = ring < 0.32 ? hex(0x8a6237) : ramp(P.ringsLight, 0.25 + ring * 0.6 + t.rand() * 0.15);
    if (edge > 12.5) col = scaleRgb(col, 0.82); // inner edge shadow
    t.set(x, y, col);
  });
  t.set(15, 15, hex(0x5a3b20));
  t.set(16, 16, hex(0x5a3b20));
}

function paintPlanks(t) {
  const joints = [10, 26, 4, 18];
  const bases = [0.45, 0.62, 0.38, 0.55];
  for (let board = 0; board < 4; board++) {
    const y0 = board * 8;
    for (let y = y0; y < y0 + 8; y++) {
      for (let x = 0; x < TEX; x++) {
        const grain = t.fbm(x, y, 2, 3, board, 16);
        let f = bases[board] + (grain - 0.5) * 0.55 + (t.rand() - 0.5) * 0.08;
        if (y === y0) f += 0.14; // top edge catches light
        t.set(x, y, ramp(P.planks, f));
      }
      t.set(joints[board], y, hex(0x5a3e22));
      t.set(joints[board] + 1, y, scaleRgb(ramp(P.planks, bases[board] + 0.2), 1));
    }
    for (let x = 0; x < TEX; x++) t.set(x, y0 + 7, hex(0x5c3f23)); // seam
    // Nail heads next to the joint.
    t.set(joints[board] - 2, y0 + 2, hex(0x4a3524));
    t.set(joints[board] + 3, y0 + 4, hex(0x4a3524));
  }
}

function paintLeaves(t) {
  t.forEach((x, y) => {
    t.set(x, y, ramp(P.leaves, 0.15 + t.fbm(x, y, 4, 2) * 0.3), 255);
  });
  // Individual leaves: small clusters lit from the top-left.
  for (let i = 0; i < 95; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    const f = 0.35 + t.rand() * 0.65;
    const c = ramp(P.leaves, f);
    t.set(x, y, c);
    t.set(x + 1, y, c);
    t.set(x, y + 1, scaleRgb(c, 0.86));
    t.set(x + 1, y + 1, scaleRgb(c, 0.72));
    if (f > 0.7) t.set(x, y, scaleRgb(c, 1.18));
  }
  // Some leaves catch the sun: a bright tip and a darker midrib.
  for (let i = 0; i < 18; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    t.set(x, y, P.leaves[6]);
    t.set(x + 1, y + 1, P.leaves[5]);
    t.set(x + 1, y, P.leaves[2]);
  }
  // Gaps between leaves let light (and the sky) through.
  t.forEach((x, y) => {
    if (t.noise(x, y, 8, 11) * 0.7 + t.rand() * 0.3 < 0.17) t.set(x, y, [0, 0, 0], 0);
  });
}

// Birch bark: pale, papery, with dark horizontal lenticels and black scars.
function paintBirchBark(t) {
  t.forEach((x, y) => {
    const f = t.fbm(x, y, 4, 2, 3, 16) * 0.6 + t.rand() * 0.3 + t.noise(x, y, 2, 7) * 0.2;
    t.set(x, y, ramp(P.birchBark, f));
  });
  // Lenticels: short dark horizontal dashes.
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    const len = 2 + Math.floor(t.rand() * 4);
    for (let k = 0; k < len; k++) t.set(x + k, y, t.rand() < 0.75 ? hex(0x3a3531) : hex(0x6b655d));
  }
  // Black scars where branches fell off: an eye shape.
  for (let i = 0; i < 2; i++) {
    const cx = Math.floor(t.rand() * TEX);
    const cy = Math.floor(t.rand() * TEX);
    for (let dx = -3; dx <= 3; dx++) {
      const h = dx === 0 ? 1 : Math.abs(dx) < 3 ? 1 : 0;
      for (let dy = -h; dy <= h; dy++) t.set(cx + dx, cy + dy, dy === 0 ? hex(0x191715) : hex(0x2e2a27));
    }
  }
}

function paintBirchTop(t) {
  const c = (TEX - 1) / 2;
  t.forEach((x, y) => {
    const edge = Math.max(Math.abs(x - c), Math.abs(y - c));
    if (edge > 13.5) {
      t.set(x, y, ramp(P.birchBark, t.fbm(x, y, 8, 2) * 0.6 + t.rand() * 0.3));
      return;
    }
    const r = Math.hypot(x - c, y - c) + t.fbm(x, y, 4, 2, 7) * 2.2;
    const ring = (r / 2.2) % 1;
    const col = ring < 0.3 ? hex(0xc9b58c) : mixRgb(hex(0xe2d3ae), hex(0xecdfbf), t.rand());
    t.set(x, y, edge > 12.5 ? scaleRgb(col, 0.85) : col);
  });
}

// Leaves with individual light-edged leaflets, some yellowed, and gaps.
function paintFoliage(t, pal, count, gap) {
  t.forEach((x, y) => {
    t.set(x, y, ramp(pal, 0.12 + t.fbm(x, y, 4, 2) * 0.3), 255);
  });
  for (let i = 0; i < count; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    const f = 0.3 + t.rand() * 0.7;
    let c = ramp(pal, f);
    if (t.rand() < 0.08) c = mixRgb(c, hex(0xb8b24a), 0.45); // a yellowing leaf
    t.set(x, y, c);
    t.set(x + 1, y, c);
    t.set(x, y + 1, scaleRgb(c, 0.85));
    t.set(x + 1, y + 1, scaleRgb(c, 0.7));
    if (f > 0.72) t.set(x, y, scaleRgb(c, 1.2));
  }
  t.forEach((x, y) => {
    if (t.noise(x, y, 8, 11) * 0.7 + t.rand() * 0.3 < gap) t.set(x, y, [0, 0, 0], 0);
  });
}

// Pine bark: dark, scaly plates split by deep vertical fissures.
function paintPineBark(t) {
  const vor = t.voronoi(18, 4, 0.25); // cells stretched vertically
  t.forEach((x, y) => {
    const v = vor(x, y);
    const edge = v.d2 - v.d1;
    if (edge < 0.9) {
      t.set(x, y, P.pineBark[0]);
      return;
    }
    const f = 0.35 + v.value * 0.4 + (t.rand() - 0.5) * 0.18 + (edge < 1.8 ? -0.12 : 0.06);
    t.set(x, y, ramp(P.pineBark, f));
  });
  // Resin: a few amber drops.
  for (let i = 0; i < 2; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    t.set(x, y, hex(0xc98a2c));
    t.set(x, y + 1, hex(0x9a6120));
  }
}

function paintPineTop(t) {
  const c = (TEX - 1) / 2;
  t.forEach((x, y) => {
    const edge = Math.max(Math.abs(x - c), Math.abs(y - c));
    if (edge > 13.5) {
      t.set(x, y, ramp(P.pineBark, t.fbm(x, y, 8, 2) * 0.7 + t.rand() * 0.3));
      return;
    }
    const r = Math.hypot(x - c, y - c) + t.fbm(x, y, 4, 2, 7) * 1.8;
    const ring = (r / 1.8) % 1;
    const col = ring < 0.35 ? hex(0x7a5232) : ramp(P.pineRings, t.rand());
    t.set(x, y, edge > 12.5 ? scaleRgb(col, 0.82) : col);
  });
}

// Needles: clusters of short diagonal strokes, dark blue-green.
function paintPineNeedles(t) {
  t.forEach((x, y) => t.set(x, y, ramp(P.pineNeedles, 0.1 + t.fbm(x, y, 4, 2) * 0.3), 255));
  for (let i = 0; i < 70; i++) {
    const x = Math.floor(t.rand() * TEX);
    const y = Math.floor(t.rand() * TEX);
    const c = ramp(P.pineNeedles, 0.35 + t.rand() * 0.65);
    const dir = t.rand() < 0.5 ? 1 : -1;
    const len = 3 + Math.floor(t.rand() * 3);
    for (let k = 0; k < len; k++) t.set(x + k * dir, y + k, k === 0 ? scaleRgb(c, 1.15) : c);
  }
  t.forEach((x, y) => {
    if (t.noise(x, y, 8, 5) * 0.65 + t.rand() * 0.35 < 0.2) t.set(x, y, [0, 0, 0], 0);
  });
}

function paintGlass(t) {
  t.forEach((x, y) => t.set(x, y, [200, 225, 235], 0));
  const frame = hex(0xe6f3f7);
  const frameDark = hex(0x9cc3cf);
  for (let i = 0; i < TEX; i++) {
    t.set(i, 0, frame);
    t.set(0, i, frame);
    t.set(i, TEX - 1, frameDark);
    t.set(TEX - 1, i, frameDark);
  }
  // Diagonal glints.
  const glint = [255, 255, 255];
  for (let k = 0; k < 6; k++) t.set(4 + k, 9 - k, glint);
  for (let k = 0; k < 3; k++) t.set(4 + k, 14 - k, glint);
  for (let k = 0; k < 4; k++) t.set(20 + k, 27 - k, [220, 240, 248]);
}

function paintWater(t) {
  t.forEach((x, y) => {
    const f = t.fbm(x, y, 4, 3) * 0.7 + Math.sin((x + y * 0.5 + t.fbm(x, y, 2, 2, 3) * 8) * 0.6) * 0.12 + 0.15;
    t.set(x, y, ramp(P.water, f));
  });
}

function paintOre(t, colors) {
  paintStone(t, 17);
  const [dark, mid, light] = colors.map(hex);
  const r = makeRand(t.seed + 99);
  // Nuggets: chunky rounded blobs, each lit from the top-left with a dark
  // bottom-right rim so they read as embedded lumps.
  const nuggets = [];
  for (let i = 0; i < 7; i++) nuggets.push([2 + r() * 28, 2 + r() * 28, 1.3 + r() * 1.1]);
  t.forEach((x, y) => {
    for (const [cx, cy, rad] of nuggets) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy) + (hashInt(x, y, t.seed) - 0.5) * 0.7;
      if (d > rad) continue;
      const lit = -(dx + dy) / (rad * 1.6);
      t.set(x, y, lit > 0.35 ? light : lit < -0.35 ? dark : mid);
      return;
    }
  });
  // Rim shadow just outside each nugget on its lower-right side.
  t.forEach((x, y) => {
    for (const [cx, cy, rad] of nuggets) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > rad + 0.3 && d < rad + 1.1 && x + 0.5 > cx - 0.5 && y + 0.5 > cy - 0.5) {
        t.shade(x, y, 0.62);
        return;
      }
    }
  });
}

function paintBedrock(t) {
  t.forEach((x, y) => {
    const f = t.noise(x, y, 16, 0) * 0.6 + t.noise(x, y, 8, 1) * 0.25 + t.rand() * 0.15;
    t.set(x, y, ramp(P.bedrock, f * 1.3 - 0.15));
  });
}

function paintTorch(t) {
  t.forEach((x, y) => t.set(x, y, [0, 0, 0], 0));
  // Stick: rows 17-31, 4 px wide (x 14-17), lit from the left.
  const wood = [hex(0x8f673b), hex(0x7a5530), hex(0x6a4828), hex(0x523620)];
  for (let y = 17; y < TEX; y++) for (let i = 0; i < 4; i++) t.set(14 + i, y, wood[i]);
  // Flame: rows 12-16, bright core fading to orange (these pixels glow).
  const flame = [
    [0xffe46b, 0xfff6c8, 0xfff6c8, 0xffe46b],
    [0xffcf45, 0xfff1a8, 0xfff1a8, 0xffcf45],
    [0xffb030, 0xffe070, 0xffe070, 0xffb030],
    [0xff9124, 0xffc445, 0xffc445, 0xff9124],
    [0xe8631a, 0xff8a26, 0xff8a26, 0xe8631a],
  ];
  for (let r = 0; r < 5; r++) for (let i = 0; i < 4; i++) t.set(14 + i, 12 + r, hex(flame[r][i]));
  // Flicker tip above the stick (visible in the icon).
  t.set(15, 11, hex(0xffd65a));
  t.set(16, 10, hex(0xffe89a));
}

function paintLumen(t) {
  const vor = t.voronoi(9, 5);
  t.forEach((x, y) => {
    const v = vor(x, y);
    const edge = v.d2 - v.d1;
    if (edge < 1.2) {
      t.set(x, y, hex(0x4a2e0c));
      return;
    }
    const core = clamp01(1 - v.d1 / 7);
    const f = core * 0.8 + v.value * 0.15 + t.rand() * 0.1;
    const col = f > 0.75 ? hex(0xfff6c4) : f > 0.55 ? hex(0xffe27a) : f > 0.35 ? hex(0xffc445) : f > 0.18 ? hex(0xe89a2c) : hex(0xb8701c);
    t.set(x, y, col);
  });
}

function paintCraftingTop(t) {
  paintPlanks(t);
  const frame = hex(0x5c3f23);
  const frameLight = hex(0x8a6238);
  for (let i = 0; i < TEX; i++) {
    for (const w of [0, 1]) {
      t.set(i, w, w === 0 ? frame : frameLight);
      t.set(w, i, w === 0 ? frame : frameLight);
      t.set(i, TEX - 1 - w, frame);
      t.set(TEX - 1 - w, i, frame);
    }
  }
  // 3x3 crafting grid in the middle.
  for (let k = 0; k <= 3; k++) {
    for (let i = 7; i <= 25; i++) {
      t.set(7 + k * 6, i, hex(0x4a3220));
      t.set(i, 7 + k * 6, hex(0x4a3220));
    }
  }
}

function paintCraftingSide(t, front) {
  paintPlanks(t);
  // Dark band: the table top's edge.
  for (let x = 0; x < TEX; x++) {
    for (let y = 0; y < 6; y++) t.set(x, y, ramp(P.bark, 0.3 + t.rand() * 0.3 + (y === 0 ? 0.3 : 0)));
    t.set(x, 6, hex(0x3a2616));
  }
  // Legs: darker vertical posts at the edges.
  for (let y = 7; y < TEX; y++) {
    for (const x of [0, 1, TEX - 2, TEX - 1]) t.shade(x, y, 0.7);
  }
  if (front) {
    // A saw hanging on the front.
    for (let x = 8; x < 22; x++) for (let y = 12; y < 16; y++) t.set(x, y, y === 12 ? hex(0xd9dde0) : hex(0xb4b9bd));
    for (let x = 8; x < 22; x += 2) t.set(x, 16, hex(0x8f9498));
    for (let y = 11; y < 17; y++) for (let x = 22; x < 26; x++) t.set(x, y, hex(0x6b4424));
  } else {
    // A hammer.
    for (let y = 10; y < 26; y++) t.set(16, y, hex(0x7a5530));
    for (let y = 10; y < 26; y++) t.set(17, y, hex(0x5e4026));
    for (let x = 12; x < 22; x++) for (let y = 9; y < 13; y++) t.set(x, y, y === 9 ? hex(0x9ea3a8) : hex(0x6f757a));
  }
}

function paintTallGrass(t) {
  t.forEach((x, y) => t.set(x, y, [0, 0, 0], 0));
  const r = makeRand(t.seed + 3);
  for (let i = 0; i < 13; i++) {
    let x = 2 + r() * 27;
    const h = 12 + Math.floor(r() * 18);
    const lean = (r() - 0.5) * 0.35;
    for (let k = 0; k < h; k++) {
      const y = TEX - 1 - k;
      const f = k / h;
      const col = mixRgb(hex(0x2a5a1b), hex(0x86c957), f);
      t.set(Math.floor(x), y, col);
      if (k < h * 0.4 && r() < 0.5) t.set(Math.floor(x) + 1, y, scaleRgb(col, 0.8));
      x += lean;
    }
  }
}

function paintFlower(t, petals) {
  t.forEach((x, y) => t.set(x, y, [0, 0, 0], 0));
  const stem = hex(0x2f6b22);
  for (let y = 15; y < TEX; y++) t.set(15, y, y % 5 === 0 ? hex(0x3c7f2a) : stem);
  // Leaves on the stem.
  for (let k = 0; k < 4; k++) {
    t.set(14 - k, 25 - Math.floor(k / 2), hex(0x3f8a2c));
    t.set(16 + k, 22 - Math.floor(k / 2), hex(0x3f8a2c));
  }
  const [dark, mid, light, center] = petals.map(hex);
  const cx = 15;
  const cy = 11;
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      const d = Math.hypot(dx, dy * 1.1);
      const ang = Math.atan2(dy, dx);
      const petalR = 3.2 + Math.abs(Math.sin(ang * 2.5)) * 2;
      if (d > petalR) continue;
      let col = d < 1.6 ? center : dy < -1 || dx < -1 ? light : mid;
      if (d > petalR - 1 && dy > 0) col = dark;
      t.set(cx + dx, cy + dy, col);
    }
  }
}

function paintBricks(t) {
  t.forEach((x, y) => {
    const row = Math.floor(y / 8);
    const yy = y % 8;
    const offset = row % 2 === 0 ? 0 : 8;
    const xx = (x + offset) % TEX;
    const col = Math.floor(xx / 16);
    if (yy === 7 || xx % 16 === 15) {
      t.set(x, y, yy === 7 ? hex(0xb3aa9c) : hex(0xa39b8e));
      return;
    }
    const brickShade = hashInt(row, col, t.seed);
    let f = 0.25 + brickShade * 0.5 + (t.fbm(x, y, 8, 2) - 0.5) * 0.3 + (t.rand() - 0.5) * 0.1;
    if (yy === 0) f += 0.18; // top edge highlight
    if (yy === 6) f -= 0.15;
    t.set(x, y, ramp(P.brick, f));
  });
}

function paintWool(t) {
  t.forEach((x, y) => {
    // Knitted rows: little V shapes.
    const v = ((x + (y % 4 < 2 ? 0 : 2)) % 4) / 3;
    const f = 0.35 + t.fbm(x, y, 8, 2) * 0.35 + (y % 2 === 0 ? 0.1 : -0.05) + v * 0.12 + t.rand() * 0.1;
    t.set(x, y, ramp(P.wool, f));
  });
}

const PAINTERS = {
  grass_top: paintGrassTop,
  grass_side: paintGrassSide,
  dirt: (t) => paintDirt(t),
  stone: (t) => paintStone(t),
  sand: paintSand,
  wood_side: paintBark,
  wood_top: paintWoodTop,
  leaves: paintLeaves,
  planks: paintPlanks,
  glass: paintGlass,
  water: paintWater,
  cobblestone: paintCobblestone,
  bedrock: paintBedrock,
  gravel: paintGravel,
  coal_ore: (t) => paintOre(t, [0x121214, 0x26262a, 0x5a5a62]),
  iron_ore: (t) => paintOre(t, [0x8a5a3c, 0xcf9c78, 0xf0d2b8]),
  gold_ore: (t) => paintOre(t, [0xb07d12, 0xf2cf35, 0xfff3a3]),
  diamond_ore: (t) => paintOre(t, [0x1c8f99, 0x55dde4, 0xd2fdff]),
  torch: paintTorch,
  lumen: paintLumen,
  crafting_table_top: paintCraftingTop,
  crafting_table_side: (t) => paintCraftingSide(t, false),
  crafting_table_front: (t) => paintCraftingSide(t, true),
  tall_grass: paintTallGrass,
  flower_red: (t) => paintFlower(t, [0x8f1a1a, 0xd4302b, 0xff6f5f, 0x3b1a0e]),
  flower_yellow: (t) => paintFlower(t, [0xc98a0a, 0xf5cf2f, 0xfff29a, 0xd9661a]),
  bricks: paintBricks,
  wool: paintWool,
  birch_side: paintBirchBark,
  birch_top: paintBirchTop,
  birch_leaves: (t) => paintFoliage(t, P.birchLeaves, 110, 0.2),
  pine_side: paintPineBark,
  pine_top: paintPineTop,
  pine_leaves: paintPineNeedles,
};

export function paintTile(name) {
  const painter = PAINTERS[name];
  if (!painter) throw new Error(`No texture painter for tile "${name}"`);
  const t = new Tile(name);
  painter(t);
  return t.data;
}

// ---------- Relief: height, normal and roughness maps ----------
//
// Each tile also gets a relief map (for the High/Ultra terrain shader's
// normal mapping, parallax and specular light), stored as RGBA bytes:
//   r, g: the tangent-space normal's x and y (u right, v up), 0.5 = flat
//   b:    height (1 = top, 0 = deepest), for parallax occlusion mapping
//   a:    roughness (0 = glossy, 1 = matte)
// Heights come from each material's own structure where it has one (the
// stone's mottling, the domes of cobbles and gravel, sand ripples), plus
// brightness: in these pixel-art textures, light pixels are the raised
// bits (pebbles, blades, leaf clusters) and dark ones the cracks and gaps.

const RELIEF = {
  // name: [bump strength, base roughness, weight of brightness in the height]
  grass_top: [2.2, 0.72, 1],
  grass_side: [2.0, 0.85, 1],
  dirt: [2.2, 0.95, 1],
  stone: [2.6, 0.72, 0.45],
  cobblestone: [3.2, 0.78, 0.25],
  sand: [1.6, 0.9, 0.5],
  gravel: [3.0, 0.82, 0.3],
  leaves: [2.4, 0.5, 1],
  wood_side: [3.0, 0.88, 1],
  wood_top: [1.6, 0.8, 1],
  planks: [2.0, 0.66, 1],
  bricks: [2.6, 0.85, 1],
  bedrock: [3.0, 0.85, 1],
  coal_ore: [2.6, 0.72, 0.6],
  iron_ore: [2.6, 0.6, 0.6],
  gold_ore: [2.6, 0.5, 0.6],
  diamond_ore: [2.6, 0.4, 0.6],
  glass: [0.6, 0.08, 1],
  lumen: [2.2, 0.3, 1],
  wool: [1.4, 1.0, 1],
  birch_side: [2.2, 0.8, 1],
  birch_top: [1.6, 0.8, 1],
  birch_leaves: [2.2, 0.5, 1],
  pine_side: [3.4, 0.9, 1],
  pine_top: [1.6, 0.8, 1],
  pine_leaves: [2.0, 0.55, 1],
};

function luminance(p, i) {
  return (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255;
}

// Structural height (0-1) for materials that have a shape beyond their
// brightness, or null.
function structureHeight(name, t) {
  const h = new Float32Array(TEX * TEX);
  const wrap = (d) => (d > TEX / 2 ? d - TEX : d < -TEX / 2 ? d + TEX : d);
  if (name === "stone" || name.endsWith("_ore")) {
    t.forEach((x, y) => (h[y * TEX + x] = t.fbm(x, y, 2, 4, 0) * 0.8 + t.noise(x, y, 16, 5) * 0.2));
  } else if (name === "cobblestone" || name === "gravel") {
    const vor = name === "cobblestone" ? t.voronoi(13, 1) : t.voronoi(30, 2);
    const size = name === "cobblestone" ? 4.5 : 2.6;
    t.forEach((x, y) => {
      const v = vor(x, y);
      const edge = Math.min(1, (v.d2 - v.d1) / size);
      const r = Math.hypot(wrap(x + 0.5 - v.cx), wrap(y + 0.5 - v.cy)) / (size * 1.6);
      h[y * TEX + x] = Math.sqrt(edge) * 0.75 + Math.max(0, 1 - r) * 0.25; // rounded stones, low mortar
    });
  } else if (name === "sand") {
    t.forEach((x, y) => (h[y * TEX + x] = Math.sin((y + t.fbm(x, y, 4, 2, 4) * 7) * 0.75) * 0.5 + 0.5));
  } else {
    return null;
  }
  return h;
}

function paintRelief(name, t) {
  const [strength, rough, lumWeight] = RELIEF[name] || [1.2, 0.85, 1];
  const p = t.data;
  const structure = structureHeight(name, t);
  const height = new Float32Array(TEX * TEX);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const i = y * TEX + x;
      if (p[i * 4 + 3] < 128) {
        height[i] = 0; // holes in leaves and plants
        continue;
      }
      const lum = luminance(p, i * 4);
      height[i] = structure ? structure[i] * (1 - lumWeight) + lum * lumWeight : lum;
    }
  }
  // Normalize to the full 0-1 range so every material uses the whole depth.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < height.length; i++) {
    if (p[i * 4 + 3] < 128) continue;
    lo = Math.min(lo, height[i]);
    hi = Math.max(hi, height[i]);
  }
  const span = hi - lo > 1e-4 ? hi - lo : 1;
  for (let i = 0; i < height.length; i++) height[i] = p[i * 4 + 3] < 128 ? 0 : (height[i] - lo) / span;
  const hAt = (x, y) => height[((y + TEX) % TEX) * TEX + ((x + TEX) % TEX)];
  const out = new Uint8Array(TEX * TEX * 4);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const i = y * TEX + x;
      // Canvas rows go down, texture v goes up: d/dv = -d/dy.
      const du = (hAt(x + 1, y) - hAt(x - 1, y)) * 0.5;
      const dv = -(hAt(x, y + 1) - hAt(x, y - 1)) * 0.5;
      let nx = -du * strength;
      let ny = -dv * strength;
      const len = Math.hypot(nx, ny, 1);
      nx /= len;
      ny /= len;
      const lum = luminance(p, i * 4);
      out[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      out[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[i * 4 + 2] = Math.round(height[i] * 255);
      // Raised, lighter bits are a little smoother (worn), crevices rougher.
      out[i * 4 + 3] = Math.round(clamp01(rough + (0.5 - height[i]) * 0.16 - (lum - 0.5) * 0.08) * 255);
    }
  }
  return out;
}

// Pixels and relief map of one tile.
function paintTileWithRelief(name) {
  const painter = PAINTERS[name];
  if (!painter) throw new Error(`No texture painter for tile "${name}"`);
  const t = new Tile(name);
  painter(t);
  return { pixels: t.data, relief: paintRelief(name, t) };
}

function tileCanvas(pixels) {
  const canvas = document.createElement("canvas");
  canvas.width = TEX;
  canvas.height = TEX;
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels), TEX, TEX), 0, 0);
  return canvas;
}

// Builds every block tile. Returns:
//   texture: THREE.DataArrayTexture (one layer per TILE_NAMES entry)
//   reliefTexture: the matching normal / height / roughness layers
//   canvases: tile name -> 32x32 canvas (for UI icons)
//   blockColors: block id -> [r, g, b] (sRGB 0-1) average visible color
//   facePalette: { top, side }: Float32Array(256 * 3), each block's average
//     top / side texture color in linear light (for distant terrain)
const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

export function buildBlockTextures() {
  const layers = TILE_NAMES.length;
  const data = new Uint8Array(TEX * TEX * 4 * layers);
  const reliefData = new Uint8Array(TEX * TEX * 4 * layers);
  const canvases = {};
  const tileAvg = [];
  const tileLinear = [];
  for (let l = 0; l < layers; l++) {
    const { pixels, relief } = paintTileWithRelief(TILE_NAMES[l]);
    // DataArrayTexture rows start at v = 0 (the bottom), canvas rows at the
    // top, so flip vertically while copying.
    for (let y = 0; y < TEX; y++) {
      data.set(pixels.subarray(y * TEX * 4, (y + 1) * TEX * 4), (l * TEX * TEX + (TEX - 1 - y) * TEX) * 4);
      reliefData.set(relief.subarray(y * TEX * 4, (y + 1) * TEX * 4), (l * TEX * TEX + (TEX - 1 - y) * TEX) * 4);
    }
    canvases[TILE_NAMES[l]] = tileCanvas(pixels);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 128) continue;
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
      n++;
    }
    tileAvg.push(n ? [r / n / 255, g / n / 255, b / n / 255] : [0.8, 0.8, 0.8]);
    // The average in linear light, which is what a fully mipmapped texture
    // shows from far away (used for distant terrain).
    let lr = 0;
    let lg = 0;
    let lb = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 128) continue;
      lr += SRGB_TO_LINEAR[pixels[i]];
      lg += SRGB_TO_LINEAR[pixels[i + 1]];
      lb += SRGB_TO_LINEAR[pixels[i + 2]];
    }
    tileLinear.push(n ? [lr / n, lg / n, lb / n] : [0.6, 0.6, 0.6]);
  }

  const texture = new THREE.DataArrayTexture(data, TEX, TEX, layers);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;

  // Relief (normal, height, roughness): linear data, crisp per pixel like
  // the colors, so every texel reads as a tiny bevelled facet.
  const reliefTexture = new THREE.DataArrayTexture(reliefData, TEX, TEX, layers);
  reliefTexture.format = THREE.RGBAFormat;
  reliefTexture.type = THREE.UnsignedByteType;
  reliefTexture.colorSpace = THREE.NoColorSpace;
  reliefTexture.magFilter = THREE.NearestFilter;
  reliefTexture.minFilter = THREE.NearestMipmapLinearFilter;
  reliefTexture.generateMipmaps = true;
  reliefTexture.wrapS = THREE.RepeatWrapping;
  reliefTexture.wrapT = THREE.RepeatWrapping;
  reliefTexture.needsUpdate = true;

  const blockColors = {};
  for (const info of Object.values(BLOCK_INFO)) {
    const top = tileAvg[info.faces.top];
    const side = tileAvg[info.faces.side];
    blockColors[info.id] = [(top[0] + side[0]) / 2, (top[1] + side[1]) / 2, (top[2] + side[2]) / 2];
  }
  const facePalette = { top: new Float32Array(256 * 3), side: new Float32Array(256 * 3) };
  for (const info of Object.values(BLOCK_INFO)) {
    facePalette.top.set(tileLinear[info.faces.top], info.id * 3);
    facePalette.side.set(tileLinear[info.faces.side], info.id * 3);
  }
  return { texture, reliefTexture, canvases, blockColors, facePalette };
}

// Draws a block as a small isometric cube icon (or a flat sprite for
// plants/torches) onto a new canvas of `size` pixels.
export function drawBlockIcon(canvases, info, size = 32) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const tileName = (idx) => TILE_NAMES[idx];
  if (info.shape !== 0) {
    ctx.drawImage(canvases[tileName(info.faces.side)], 0, 0, size, size);
    return canvas;
  }
  const s = size / 2;
  const h = size / 4;
  // Darkens a copy of a tile (only where it has pixels) for the side faces.
  const shaded = (src, darkness) => {
    const c = document.createElement("canvas");
    c.width = TEX;
    c.height = TEX;
    const cctx = c.getContext("2d");
    cctx.drawImage(src, 0, 0);
    cctx.globalCompositeOperation = "source-atop";
    cctx.fillStyle = `rgba(0,0,0,${darkness})`;
    cctx.fillRect(0, 0, TEX, TEX);
    return c;
  };
  const topC = canvases[tileName(info.faces.top)];
  const rightC = shaded(canvases[tileName(info.faceTiles[4])], 0.42);
  const leftC = shaded(canvases[tileName(info.faceTiles[0])], 0.24);
  // Top face: a rhombus.
  ctx.setTransform(s / TEX, h / TEX, -s / TEX, h / TEX, s, 0);
  ctx.drawImage(topC, 0, 0);
  // Left face.
  ctx.setTransform(s / TEX, h / TEX, 0, s / TEX, 0, h);
  ctx.drawImage(leftC, 0, 0);
  // Right face.
  ctx.setTransform(s / TEX, -h / TEX, 0, s / TEX, s, 2 * h);
  ctx.drawImage(rightC, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}
