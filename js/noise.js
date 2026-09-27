// Seeded PRNG (mulberry32) and a from-scratch 2D Perlin noise implementation.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple deterministic hash for per-column randomness (tree placement etc).
export function hash2(seed, x, z) {
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export class Noise {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.perm = new Uint8Array(512);
    this._init();
  }

  _init() {
    const rand = mulberry32(this.seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  static fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  static lerp(t, a, b) {
    return a + t * (b - a);
  }

  grad2(hash, x, y) {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
  }

  // Classic Perlin noise, roughly in range [-1, 1].
  perlin2(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = Noise.fade(x);
    const v = Noise.fade(y);
    const p = this.perm;
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];
    const x1 = Noise.lerp(u, this.grad2(aa, x, y), this.grad2(ba, x - 1, y));
    const x2 = Noise.lerp(u, this.grad2(ab, x, y - 1), this.grad2(bb, x - 1, y - 1));
    return Noise.lerp(v, x1, x2) * 0.7;
  }

  // Fractal Brownian motion built from perlin2, normalized to roughly [-1, 1].
  fbm2(x, y, octaves = 4, persistence = 0.5, lacunarity = 2, scale = 1) {
    let amp = 1;
    let freq = scale;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.perlin2(x * freq, y * freq) * amp;
      max += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return sum / max;
  }
}
