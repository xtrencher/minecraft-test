// Procedural 32x32 item icons (tools, materials, food) and the block-breaking
// crack overlay, painted in code. Icons are built from simple shapes (thick
// lines, discs, polygons) filled with a material's color ramp, lit from the
// top-left, and outlined in a dark color: the classic item-sprite look.
import { itemInfo } from "./items.js";

const N = 32;

function hex(h) {
  return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
}

const RAMPS = {
  wood: [0x4a3018, 0x6b4726, 0x8c6035, 0xae7c47, 0xc99a5e].map(hex),
  stone: [0x3e3e43, 0x5a5a61, 0x77777f, 0x95959d, 0xb4b4bb].map(hex),
  iron: [0x5d6166, 0x8d9298, 0xb8bdc3, 0xdadee2, 0xf6f8f9].map(hex),
  diamond: [0x0f6f78, 0x22a9b1, 0x4fd6db, 0x93eff1, 0xdcffff].map(hex),
  gold: [0x8a5d0a, 0xc28a17, 0xe6b52c, 0xf8d95a, 0xfff3b0].map(hex),
  coal: [0x0c0c0e, 0x1a1a1e, 0x2a2a30, 0x44444c, 0x6a6a74].map(hex),
  red: [0x5e0b10, 0x8f141a, 0xc2242a, 0xe5483f, 0xff8c7a].map(hex),
  meat: [0x6e1621, 0xa3293a, 0xcf4b5f, 0xe9798a, 0xf8b3bc].map(hex),
  cooked: [0x3a1d0c, 0x5e3316, 0x87501f, 0xae7336, 0xcf9a5c].map(hex),
  cloth: [0xa8a193, 0xc5bfb1, 0xdcd7cb, 0xefece4, 0xffffff].map(hex),
  leaf: [0x1f5a17, 0x2f7d22, 0x46a034, 0x6cc24c, 0x9be07a].map(hex),
};

class Canvas {
  constructor() {
    this.data = new Uint8ClampedArray(N * N * 4);
    this.mask = new Uint8Array(N * N); // material index + 1 per pixel (0 = empty)
    this.shade = new Float32Array(N * N); // extra brightness per pixel (-1..1)
  }
  // Fills pixels inside `inside(x, y)` with ramp index `mat`, optionally
  // with a per-pixel brightness offset.
  fill(mat, inside, bright = () => 0) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!inside(x + 0.5, y + 0.5)) continue;
        const i = y * N + x;
        this.mask[i] = mat + 1;
        this.shade[i] = bright(x + 0.5, y + 0.5);
      }
    }
  }
  line(mat, x0, y0, x1, y1, width, bright) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    this.fill(
      mat,
      (x, y) => {
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
        const px = x0 + dx * t - x;
        const py = y0 + dy * t - y;
        return px * px + py * py <= (width / 2) * (width / 2);
      },
      bright
    );
  }
  disc(mat, cx, cy, rx, ry = rx, bright) {
    this.fill(mat, (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, bright);
  }
  poly(mat, pts, bright) {
    this.fill(
      mat,
      (x, y) => {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i];
          const [xj, yj] = pts[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      },
      bright
    );
  }
  // Converts the material mask into colors: base ramp level from the shade,
  // lit from the top-left (edges facing up-left brighter, down-right darker),
  // then a dark outline around the whole silhouette.
  render(ramps, outline = [24, 18, 14]) {
    const at = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? 0 : this.mask[y * N + x]);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const m = this.mask[i];
        const o = i * 4;
        if (!m) {
          if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) {
            this.data[o] = outline[0];
            this.data[o + 1] = outline[1];
            this.data[o + 2] = outline[2];
            this.data[o + 3] = 255;
          }
          continue;
        }
        const ramp = ramps[m - 1];
        let level = 2 + this.shade[i] * 2;
        if (at(x - 1, y - 1) !== m || at(x, y - 1) !== m) level += 1; // top-left edge catches light
        if (at(x + 1, y + 1) !== m || at(x, y + 1) !== m) level -= 1; // bottom-right edge in shade
        const c = ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(level)))];
        this.data[o] = c[0];
        this.data[o + 1] = c[1];
        this.data[o + 2] = c[2];
        this.data[o + 3] = 255;
      }
    }
    return this.data;
  }
}

// Brightness across a thick diagonal (0 at the center line, +/- toward the edges).
function across(x0, y0, x1, y1, amount) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  return (x, y) => (((x - x0) * -dy + (y - y0) * dx) / len) * amount;
}

// Tools: handle from bottom-left toward top-right, head at the top.
function paintTool(type, mat) {
  const c = new Canvas();
  const HANDLE = 0;
  const HEAD = 1;
  if (type === "sword") {
    c.line(HEAD, 12, 20, 27.5, 4.5, 4.2, across(12, 20, 27.5, 4.5, 0.45));
    c.line(HANDLE, 9, 16, 16, 23, 2.8); // cross-guard
    c.line(HANDLE, 5, 27, 11, 21, 2.5);
    c.disc(HANDLE, 4.5, 27.5, 1.8);
  } else if (type === "pickaxe") {
    c.line(HANDLE, 5, 28, 19, 14, 2.7);
    // A crescent across the tip of the handle, perpendicular to it and bulging
    // away from it (circle centered further down the handle's axis).
    const cx = 11;
    const cy = 21;
    const mid = -Math.PI / 4;
    const span = 0.8;
    c.fill(HEAD, (x, y) => {
      const d = Math.hypot(x - cx, y - cy);
      const a = Math.atan2(y - cy, x - cx) - mid;
      if (Math.abs(a) > span) return false;
      const taper = 1 - (a / span) ** 2 * 0.65; // thinner toward the points
      return d > 15.2 - 2.1 * taper && d < 15.2 + 1.9 * taper;
    }, (x, y) => (x + y < 30 ? 0.35 : -0.15));
  } else if (type === "axe") {
    c.line(HANDLE, 5, 28, 22, 11, 2.7);
    // A blade on one side of the handle with a curved cutting edge.
    c.poly(HEAD, [[14, 17], [21, 10], [18, 4], [13, 2.5], [8.5, 5], [7, 10], [9, 14]], (x, y) => (x + y < 18 ? 0.4 : -0.1));
  } else {
    // Shovel.
    c.line(HANDLE, 5, 28, 19, 14, 2.7);
    c.poly(HEAD, [[17, 11], [21, 6], [26, 5], [27, 10], [24, 15], [19, 16]], (x, y) => (x + y < 26 ? 0.35 : -0.2));
  }
  return c.render([RAMPS.wood, RAMPS[mat]]);
}

function paintIngot(ramp) {
  const c = new Canvas();
  c.poly(0, [[5, 17], [17, 11], [28, 15], [16, 21]], () => 0.6); // top
  c.poly(0, [[5, 17], [16, 21], [16, 26], [5, 22]], () => -0.35); // front
  c.poly(0, [[16, 21], [28, 15], [28, 20], [16, 26]], () => -0.05); // side
  return c.render([ramp]);
}

const PAINTERS = {
  stick: () => {
    const c = new Canvas();
    c.line(0, 7, 26, 25, 8, 2.6);
    return c.render([RAMPS.wood]);
  },
  coal: () => {
    const c = new Canvas();
    c.disc(0, 14, 17, 8, 7, (x, y) => (x + y < 28 ? 0.4 : -0.2));
    c.disc(0, 20, 14, 6, 6, (x, y) => (x + y < 30 ? 0.5 : 0));
    c.disc(0, 18, 21, 6, 5);
    return c.render([RAMPS.coal], [6, 6, 8]);
  },
  iron_ingot: () => paintIngot(RAMPS.iron),
  gold_ingot: () => paintIngot(RAMPS.gold),
  diamond: () => {
    const c = new Canvas();
    c.poly(0, [[16, 5], [26, 12], [16, 28], [6, 12]], (x, y) => (y < 12 ? 0.6 : x < 16 ? 0.1 : -0.4));
    return c.render([RAMPS.diamond], [8, 40, 48]);
  },
  apple: () => paintApple(RAMPS.red),
  golden_apple: () => paintApple(RAMPS.gold),
  raw_meat: () => paintMeat(RAMPS.meat, false),
  cooked_meat: () => paintMeat(RAMPS.cooked, true),
  fluff: () => {
    const c = new Canvas();
    for (const [x, y, r] of [[12, 17, 6], [19, 14, 7], [21, 20, 6], [14, 22, 5], [16, 11, 5]]) {
      c.disc(0, x, y, r, r, (px, py) => (px + py < x + y - 2 ? 0.5 : -0.1));
    }
    return c.render([RAMPS.cloth], [110, 104, 92]);
  },
};

function paintApple(ramp) {
  const c = new Canvas();
  c.disc(1, 16, 18, 9.5, 9, (x, y) => (x + y < 30 ? 0.35 : -0.2));
  c.line(0, 16, 10, 17, 4, 1.8); // stem
  c.disc(2, 21, 6, 3.5, 2); // leaf
  c.disc(1, 12, 14, 1.6, 1.6, () => 1); // highlight
  return c.render([RAMPS.wood, ramp, RAMPS.leaf]);
}

function paintMeat(ramp, cooked) {
  const c = new Canvas();
  c.disc(0, 15, 17, 11, 7.5, (x, y) => (y < 15 ? 0.35 : -0.15));
  c.disc(1, 26, 21, 2.6, 2.4); // bone end
  c.line(1, 23, 19, 27, 22, 2.2);
  // Marbling (raw) or grill marks (cooked).
  if (cooked) {
    for (const x of [10, 15, 20]) c.line(0, x, 12, x - 4, 22, 1.2, () => -2);
  } else {
    c.line(1, 8, 16, 20, 13, 1.3);
    c.line(1, 10, 21, 18, 19, 1.1);
  }
  return c.render([ramp, RAMPS.cloth]);
}

export function paintItemIcon(iconName) {
  if (PAINTERS[iconName]) return PAINTERS[iconName]();
  const m = /^(sword|pickaxe|axe|shovel)_(wood|stone|iron|diamond)$/.exec(iconName);
  if (m) return paintTool(m[1], m[2]);
  throw new Error(`No item icon painter for "${iconName}"`);
}

function toCanvas(pixels) {
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels), N, N), 0, 0);
  return canvas;
}

// Icon pixels + canvas for an item (non-block) id, cached.
const iconCache = new Map();
export function itemIconPixels(id) {
  const info = itemInfo(id);
  if (!info || !info.icon) return null;
  if (!iconCache.has(info.icon)) iconCache.set(info.icon, paintItemIcon(info.icon));
  return iconCache.get(info.icon);
}

const canvasCache = new Map();
export function itemIconCanvas(id) {
  const info = itemInfo(id);
  if (!info || !info.icon) return null;
  if (!canvasCache.has(info.icon)) canvasCache.set(info.icon, toCanvas(itemIconPixels(id)));
  return canvasCache.get(info.icon);
}

// Ten crack overlay stages for blocks being mined (transparent + dark cracks).
export function buildCrackStages() {
  let seed = 1234567;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  // Many short, branching cracks scattered over the face; each segment gets
  // a "birth time" so later stages show more and longer cracks.
  const segments = [];
  const grow = (x, y, ang, len, t0, depth) => {
    for (let i = 0; i < len; i++) {
      const nx = x + Math.cos(ang) * 1.4;
      const ny = y + Math.sin(ang) * 1.4;
      segments.push([x, y, nx, ny, t0 + i * 0.045]);
      x = nx;
      y = ny;
      ang += (rand() - 0.5) * 1.1;
      if (depth < 2 && rand() < 0.2) grow(x, y, ang + (rand() < 0.5 ? 1 : -1) * (0.7 + rand() * 0.7), Math.floor(len * 0.5), t0 + i * 0.045, depth + 1);
    }
  };
  for (let k = 0; k < 14; k++) {
    const start = k === 0 ? 0 : rand() * 0.55;
    const x = 4 + rand() * 24;
    const y = 4 + rand() * 24;
    const ang = rand() * Math.PI * 2;
    grow(x, y, ang, 5 + Math.floor(rand() * 7), start, 0);
    grow(x, y, ang + Math.PI, 3 + Math.floor(rand() * 5), start, 1);
  }
  const stages = [];
  for (let s = 1; s <= 10; s++) {
    const c = new Canvas();
    for (const [x0, y0, x1, y1, born] of segments) {
      if (born <= s / 10) c.line(0, x0, y0, x1, y1, 1.15);
    }
    const data = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      if (!c.mask[i]) continue;
      data[i * 4] = 20;
      data[i * 4 + 1] = 16;
      data[i * 4 + 2] = 14;
      data[i * 4 + 3] = 200;
    }
    stages.push(toCanvas(data));
  }
  return stages;
}
