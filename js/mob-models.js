// Box-model mobs with skins painted in code. Each species is a set of boxes
// ("parts") hinged at pivots, like classic voxel-game mobs: the skin texture
// is packed automatically (one unfolded-box region per part) and painted
// pixel by pixel, the geometry's UVs point into those regions, and a small
// per-species function animates the pivots (legs, head, arms, ears).
//
// All four designs are original: the Fluffalo (a rust-furred, humped grazer
// with a cream mane, a beard and upswept horns), the Hoplet (a striped sand-colored
// hopper with tall ears), the Mossback (a slow tortoise whose shell grows moss
// and flowers, and who hides inside it when hurt) and the Zombie (a hunched,
// pallid shambler in torn maroon rags with glowing amber eyes).
import * as THREE from "three";
import { createEntityMaterial } from "./shaders.js";

const TS = 2; // skin texels per model pixel
const PX = 1 / 16; // blocks per model pixel
const ATLAS_W = 128;

// ---------- Painting helpers ----------

function hex(h) {
  return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function shade(c, f) {
  return [c[0] * f, c[1] * f, c[2] * f];
}

function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Brightness jitter per texel (or per `cell`-sized block of texels).
function grain(c, x, y, s, amount, cell = 1) {
  return shade(c, 1 + (hash(Math.floor(x / cell), Math.floor(y / cell), s) - 0.5) * amount);
}

const FACES = ["top", "bottom", "right", "front", "left", "back"];

// ---------- Skin (packed texture) ----------

class Skin {
  constructor(parts) {
    let x = 0;
    let y = 0;
    let rowH = 0;
    this.regions = {};
    for (const p of parts) {
      const [w, h, d] = p.size;
      const rw = Math.round(2 * (w + d) * TS);
      const rh = Math.round((h + d) * TS);
      if (x + rw > ATLAS_W) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      this.regions[p.name] = { u: x, v: y, w, h, d };
      x += rw;
      rowH = Math.max(rowH, rh);
    }
    let H = 16;
    while (H < y + rowH) H *= 2;
    this.W = ATLAS_W;
    this.H = H;
    this.data = new Uint8ClampedArray(this.W * H * 4);
  }

  // Texel rectangle of one face of a part's region.
  rect(part, face) {
    const { u, v, w, h, d } = this.regions[part];
    const W = Math.round(w * TS);
    const Hh = Math.round(h * TS);
    const D = Math.round(d * TS);
    switch (face) {
      case "top": return { x: u + D, y: v, w: W, h: D };
      case "bottom": return { x: u + D + W, y: v, w: W, h: D };
      case "right": return { x: u, y: v + D, w: D, h: Hh };
      case "front": return { x: u + D, y: v + D, w: W, h: Hh };
      case "left": return { x: u + D + W, y: v + D, w: D, h: Hh };
      default: return { x: u + 2 * D + W, y: v + D, w: W, h: Hh }; // back
    }
  }

  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = (y * this.W + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = 255;
  }

  // fn(fx, fy, fw, fh) returns a color or null (leave as is). Conventions:
  // fy = 0 is the top edge of side faces (the back edge of the top face);
  // fx = 0 is the left edge as seen from outside, so on the front face it's
  // the -X side, and on the right (+X) face it's the front edge.
  face(part, face, fn) {
    const r = this.rect(part, face);
    for (let fy = 0; fy < r.h; fy++) {
      for (let fx = 0; fx < r.w; fx++) {
        const c = fn(fx, fy, r.w, r.h);
        if (c) this.set(r.x + fx, r.y + fy, c);
      }
    }
  }

  // Every face of a part: fn(face, fx, fy, fw, fh).
  part(part, fn) {
    for (const f of FACES) this.face(part, f, (x, y, w, h) => fn(f, x, y, w, h));
  }

  texture() {
    const canvas = document.createElement("canvas");
    canvas.width = this.W;
    canvas.height = this.H;
    canvas.getContext("2d").putImageData(new ImageData(this.data, this.W, this.H), 0, 0);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapLinearFilter;
    t.generateMipmaps = true;
    return t;
  }
}

// Distance (texels) from the front edge on a side face.
function fromFront(face, fx, fw) {
  return face === "right" ? fx : fw - 1 - fx;
}

// ---------- Geometry ----------

function boxGeometry(skin, part) {
  const [w, h, d] = part.size;
  const [fx0, fy0, fz0] = part.from;
  const x0 = fx0 * PX;
  const y0 = fy0 * PX;
  const z0 = fz0 * PX;
  const x1 = (fx0 + w) * PX;
  const y1 = (fy0 + h) * PX;
  const z1 = (fz0 + d) * PX;
  const faces = {
    front: { n: [0, 0, 1], v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    back: { n: [0, 0, -1], v: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
    right: { n: [1, 0, 0], v: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
    left: { n: [-1, 0, 0], v: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    top: { n: [0, 1, 0], v: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
    bottom: { n: [0, -1, 0], v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
  };
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  const e = 0.02; // keep samples inside the face's texels
  for (const [name, f] of Object.entries(faces)) {
    const r = skin.rect(part.name, name);
    const u0 = (r.x + e) / skin.W;
    const u1 = (r.x + r.w - e) / skin.W;
    const vt = 1 - (r.y + e) / skin.H;
    const vb = 1 - (r.y + r.h - e) / skin.H;
    const uvs = name === "bottom" ? [[u0, vt], [u1, vt], [u1, vb], [u0, vb]] : [[u0, vb], [u1, vb], [u1, vt], [u0, vt]];
    const base = pos.length / 3;
    for (let i = 0; i < 4; i++) {
      pos.push(...f.v[i]);
      nor.push(...f.n);
      uv.push(...uvs[i]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ---------- Species definitions ----------
// Parts: size [w, h, d] and pivot/from in model pixels (1/16 block). The mob
// faces +Z; its origin is at the center of its feet. `from` is the box's
// min corner relative to the pivot. `parent` hangs a part on another part;
// `rigid` parts never move on their own and are merged into the parent's
// mesh (fewer draw calls).

const FLUFFALO = {
  parts: [
    { name: "body", size: [14, 11, 18], pivot: [0, 8, 0], from: [-7, 0, -9] },
    { name: "hump", size: [12, 6, 10], pivot: [0, 19, 0], from: [-6, 0, -1], parent: "body", rigid: true },
    { name: "head", size: [8, 8, 7], pivot: [0, 16, 8], from: [-4, -6, 0] },
    { name: "snout", size: [6, 4, 2], pivot: [0, 16, 8], from: [-3, -6, 7], parent: "head", rigid: true },
    { name: "beard", size: [4, 4, 2], pivot: [0, 16, 8], from: [-2, -10, 6], parent: "head", rigid: true },
    { name: "hornL", size: [4, 2, 2], pivot: [0, 16, 8], from: [-7, -1, 3], parent: "head", rigid: true },
    { name: "hornR", size: [4, 2, 2], pivot: [0, 16, 8], from: [3, -1, 3], parent: "head", rigid: true },
    { name: "tipL", size: [2, 4, 2], pivot: [0, 16, 8], from: [-8, 1, 3], parent: "head", rigid: true },
    { name: "tipR", size: [2, 4, 2], pivot: [0, 16, 8], from: [6, 1, 3], parent: "head", rigid: true },
    { name: "legFL", size: [4, 8, 4], pivot: [-4.5, 8, 6], from: [-2, -8, -2] },
    { name: "legFR", size: [4, 8, 4], pivot: [4.5, 8, 6], from: [-2, -8, -2] },
    { name: "legBL", size: [4, 8, 4], pivot: [-4.5, 8, -6], from: [-2, -8, -2] },
    { name: "legBR", size: [4, 8, 4], pivot: [4.5, 8, -6], from: [-2, -8, -2] },
  ],
  paint(s) {
    // A rust-furred highland grazer with a cream mane (the fluff it drops),
    // a dark face, a beard and upswept horns.
    const fur = hex(0xa4612f);
    const furDark = hex(0x6e3b1d);
    const mane = hex(0xeadcc0);
    const maneDark = hex(0xc6b28c);
    const face = hex(0x3b2a21);
    const hoof = hex(0x1f1712);
    const shaggy = (x, y, seed, fh, f, a, b) => {
      // Long strands: vertical streaks that darken toward a ragged fringe.
      let c = mix(a, b, hash(x, Math.floor(y / 4), seed) * 0.6);
      c = grain(c, x, y, seed + 1, 0.14);
      if (f !== "top" && f !== "bottom") {
        c = shade(c, 1 - (y / fh) * 0.25);
        if (y > fh - 3 && hash(x, 0, seed + 2) > 0.5) c = shade(c, 0.7);
      }
      return c;
    };
    s.part("body", (f, x, y, w, h) => (f === "bottom" ? grain(furDark, x, y, 10, 0.15) : shaggy(x, y, 11, h, f, fur, furDark)));
    s.part("hump", (f, x, y, w, h) => (f === "bottom" ? grain(maneDark, x, y, 12, 0.1) : shaggy(x, y, 13, h, f, mane, maneDark)));
    s.part("head", (f, x, y, w, h) => {
      // Dark face under a cream forelock.
      const lock = f === "top" || (y < h * 0.3 && hash(x, 0, 14) > 0.25) || y < h * 0.18;
      let c = lock ? shaggy(x, y, 15, h, f, mane, maneDark) : grain(face, x, y, 16, 0.18);
      if (f === "front") {
        const ey = Math.round(h * 0.42);
        for (const ex of [2, w - 4]) {
          if (y >= ey && y < ey + 2 && x >= ex && x < ex + 2) c = x === ex && y === ey ? [236, 214, 170] : [12, 8, 6];
        }
      }
      return c;
    });
    s.part("snout", (f, x, y, w, h) => {
      let c = grain(hex(0x5e4a42), x, y, 17, 0.1);
      if (f === "front" && y === Math.floor(h / 2) && (x === 2 || x === w - 3)) c = [22, 14, 12]; // nostrils
      return c;
    });
    s.part("beard", (f, x, y, w, h) => shaggy(x, y, 18, h, f, mane, maneDark));
    for (const horn of ["hornL", "hornR", "tipL", "tipR"]) {
      s.part(horn, (f, x, y, w, h) => {
        const tip = horn.startsWith("tip") && (y < 3 || f === "top");
        return grain(tip ? hex(0x4a3f33) : hex(0xded2b0), x, y, 19, 0.12);
      });
    }
    for (const leg of ["legFL", "legFR", "legBL", "legBR"]) {
      s.part(leg, (f, x, y, w, h) => {
        if (f === "bottom" || y >= h - 3) return grain(hoof, x, y, 20, 0.2);
        if (y < h * 0.5) return shaggy(x, y, 21, h, f, fur, furDark);
        return grain(furDark, x, y, 22, 0.18);
      });
    }
  },
  animate(p, st) {
    const swing = Math.sin(st.walkPhase) * 0.55 * st.walk;
    p.legFL.rotation.x = swing;
    p.legBR.rotation.x = swing;
    p.legFR.rotation.x = -swing;
    p.legBL.rotation.x = -swing;
    p.head.rotation.y = st.headYaw;
    p.head.rotation.x = -st.headPitch + st.graze * 0.9 + Math.sin(st.time * 1.3) * 0.03;
  },
};

const HOPLET = {
  parts: [
    { name: "body", size: [6, 5, 8], pivot: [0, 3, 0], from: [-3, 0, -4] },
    { name: "head", size: [5, 5, 5], pivot: [0, 6, 3], from: [-2.5, 0, 0] },
    { name: "earL", size: [2, 6, 1], pivot: [-1.5, 11, 5], from: [-1, 0, -0.5], parent: "head" },
    { name: "earR", size: [2, 6, 1], pivot: [1.5, 11, 5], from: [-1, 0, -0.5], parent: "head" },
    { name: "tail", size: [3, 3, 2], pivot: [0, 5, -4], from: [-1.5, -1, -2], parent: "body" },
    { name: "legBL", size: [2, 3, 5], pivot: [-2.5, 3, -2], from: [-1, -3, -2] },
    { name: "legBR", size: [2, 3, 5], pivot: [2.5, 3, -2], from: [-1, -3, -2] },
    { name: "legFL", size: [1.5, 3, 1.5], pivot: [-1.5, 3, 3], from: [-0.75, -3, -0.75] },
    { name: "legFR", size: [1.5, 3, 1.5], pivot: [1.5, 3, 3], from: [-0.75, -3, -0.75] },
  ],
  paint(s) {
    const fur = hex(0xc99a5f);
    const belly = hex(0xf0e3c9);
    const stripe = hex(0x70492a);
    const furry = (x, y, seed) => grain(mix(fur, hex(0xb3844d), hash(x, y >> 1, seed) * 0.4), x, y, seed + 1, 0.12);
    s.part("body", (f, x, y, w, h) => {
      if (f === "bottom") return grain(belly, x, y, 21, 0.08);
      // Three dark stripes across the back, running down the flanks.
      const along = f === "top" ? y : f === "right" || f === "left" ? w - 1 - fromFront(f, x, w) : -1;
      const stripeRow = along >= 0 && [3, 7, 11].some((k) => Math.abs(along - k) < 1);
      if (stripeRow && (f === "top" || y < h * 0.55)) return grain(stripe, x, y, 22, 0.15);
      if ((f === "right" || f === "left" || f === "front" || f === "back") && y > h * 0.7) return grain(belly, x, y, 23, 0.08);
      return furry(x, y, 24);
    });
    s.part("head", (f, x, y, w, h) => {
      let c = furry(x, y, 25);
      if (f === "front") {
        if (y >= h * 0.55) c = grain(belly, x, y, 26, 0.08); // pale muzzle
        if (y === 3 && (x === 1 || x === w - 2)) c = [16, 12, 10];
        if (y === 3 && (x === 2 || x === w - 3)) c = [20, 14, 12];
        if (y === 4 && (x === 1 || x === w - 2)) c = [22, 16, 14];
        if (y === 2 && (x === 1 || x === w - 2)) c = [240, 236, 226]; // glints
        if (y === 6 && (x === 4 || x === 5)) c = hex(0xe07f8a); // nose
      }
      return c;
    });
    for (const ear of ["earL", "earR"]) {
      s.part(ear, (f, x, y, w, h) => {
        if (f === "front" && x > 0 && x < w - 1 && y > 1) return grain(hex(0xe8a4a2), x, y, 27, 0.1);
        if (y < 2) return grain(stripe, x, y, 28, 0.2); // dark tips
        return furry(x, y, 29);
      });
    }
    s.part("tail", (f, x, y) => grain([248, 246, 240], x, y, 30, 0.08));
    for (const leg of ["legBL", "legBR", "legFL", "legFR"]) {
      s.part(leg, (f, x, y, w, h) => (y >= h - 2 || f === "bottom" ? grain(belly, x, y, 31, 0.1) : furry(x, y, 32)));
    }
  },
  animate(p, st) {
    // Hops: hind legs kick back in the air, ears stream back, body tilts.
    const air = THREE.MathUtils.clamp(st.vy / 5, -1, 1);
    p.legBL.rotation.x = p.legBR.rotation.x = air > 0 ? -air * 0.9 : Math.sin(st.walkPhase) * 0.4 * st.walk;
    p.legFL.rotation.x = p.legFR.rotation.x = air * 0.7;
    p.body.rotation.x = -air * 0.2;
    p.earL.rotation.x = p.earR.rotation.x = -0.25 - Math.max(0, air) * 0.6 + Math.sin(st.time * 2.2) * 0.05;
    p.earL.rotation.z = 0.12;
    p.earR.rotation.z = -0.12;
    p.head.rotation.y = st.headYaw;
    p.head.rotation.x = -st.headPitch;
    p.tail.rotation.y = Math.sin(st.time * 9) * 0.15 * st.walk;
  },
};

const MOSSBACK = {
  parts: [
    { name: "shell", size: [14, 7, 16], pivot: [0, 3, 0], from: [-7, 0, -8] },
    { name: "dome", size: [10, 2, 12], pivot: [0, 10, 0], from: [-5, 0, -6], parent: "shell", rigid: true },
    { name: "head", size: [5, 5, 6], pivot: [0, 5, 7], from: [-2.5, -2, 0] },
    { name: "legFL", size: [4, 4, 4], pivot: [-5, 4, 5], from: [-2, -4, -2] },
    { name: "legFR", size: [4, 4, 4], pivot: [5, 4, 5], from: [-2, -4, -2] },
    { name: "legBL", size: [4, 4, 4], pivot: [-5, 4, -5], from: [-2, -4, -2] },
    { name: "legBR", size: [4, 4, 4], pivot: [5, 4, -5], from: [-2, -4, -2] },
    { name: "tail", size: [2, 2, 3], pivot: [0, 4, -8], from: [-1, -1, -3] },
  ],
  paint(s) {
    const plate = hex(0x4b5a2c);
    const seam = hex(0x2f3a1b);
    const moss = hex(0x6fa03a);
    const rim = hex(0x8f7d4c);
    const skin = hex(0x7d8a68);
    const shellTex = (f, x, y, w, h, seed) => {
      // Plates with dark seams, a pale rim, moss growing on the upper half.
      let c = grain(plate, x, y, seed, 0.14);
      const cell = 6;
      if (x % cell === 0 || (y + (Math.floor(x / cell) % 2) * 3) % cell === 0) c = grain(seam, x, y, seed + 1, 0.1);
      if (f !== "top" && f !== "bottom" && y >= h - 3) c = grain(rim, x, y, seed + 2, 0.12);
      const up = f === "top" ? 1 : 1 - y / h;
      if (hash(x >> 1, y >> 1, seed + 3) < up * 0.55) c = grain(moss, x, y, seed + 4, 0.25);
      if (f === "bottom") c = grain(hex(0xb7a877), x, y, seed + 5, 0.1);
      return c;
    };
    s.part("shell", (f, x, y, w, h) => shellTex(f, x, y, w, h, 41));
    s.part("dome", (f, x, y, w, h) => {
      let c = grain(moss, x, y, 42, 0.3);
      // Tiny flowers in the moss.
      const r = hash(x, y, 43);
      if (f === "top" && r > 0.94) c = r > 0.97 ? hex(0xf2d04a) : hex(0xe882ab);
      return c;
    });
    const scaly = (x, y, seed) => {
      let c = grain(skin, x, y, seed, 0.12);
      if (((x >> 1) + (y >> 1)) % 3 === 0) c = shade(c, 0.86);
      return c;
    };
    s.part("head", (f, x, y, w, h) => {
      let c = scaly(x, y, 44);
      if ((f === "right" || f === "left") && fromFront(f, x, w) === 2 && (y === 3 || y === 4)) c = y === 3 ? [230, 230, 215] : [14, 14, 12];
      if ((f === "right" || f === "left") && fromFront(f, x, w) === 3 && (y === 3 || y === 4)) c = [16, 16, 14];
      if (f === "front" && y === 7) c = shade(c, 0.55); // mouth line
      return c;
    });
    for (const leg of ["legFL", "legFR", "legBL", "legBR", "tail"]) {
      s.part(leg, (f, x, y, w, h) => (f === "bottom" || (leg !== "tail" && y >= h - 1) ? grain(hex(0x4a5040), x, y, 45, 0.2) : scaly(x, y, 46)));
    }
  },
  animate(p, st) {
    const hide = st.hide;
    const swing = Math.sin(st.walkPhase) * 0.45 * st.walk * (1 - hide);
    p.legFL.rotation.x = swing;
    p.legBR.rotation.x = swing;
    p.legFR.rotation.x = -swing;
    p.legBL.rotation.x = -swing;
    // Hiding pulls the head and legs into the shell.
    p.head.position.z = (7 - hide * 5.5) * PX;
    for (const leg of ["legFL", "legFR", "legBL", "legBR"]) p[leg].position.y = (4 + hide * 3) * PX;
    p.shell.position.y = (3 - hide * 2.5) * PX;
    p.head.rotation.y = st.headYaw * (1 - hide);
    p.head.rotation.x = -st.headPitch + Math.sin(st.time * 1.7) * 0.05;
  },
};

const ZOMBIE = {
  parts: [
    { name: "legL", size: [4, 12, 4], pivot: [-2, 12, 0], from: [-2, -12, -2] },
    { name: "legR", size: [4, 12, 4], pivot: [2, 12, 0], from: [-2, -12, -2] },
    { name: "body", size: [8, 12, 4], pivot: [0, 12, 0], from: [-4, 0, -2] },
    { name: "head", size: [8, 8, 8], pivot: [0, 24, 0], from: [-4, 0, -4], parent: "body" },
    { name: "armL", size: [4, 12, 4], pivot: [-6, 22, 0], from: [-2, -10, -2], parent: "body" },
    { name: "armR", size: [4, 12, 4], pivot: [6, 22, 0], from: [-2, -10, -2], parent: "body" },
  ],
  paint(s) {
    const skinA = hex(0x8e9c98);
    const skinB = hex(0x74887a);
    const rag = hex(0x5b2733);
    const ragDark = hex(0x40192a);
    const pants = hex(0x39404f);
    const flesh = (x, y, seed) => {
      let c = mix(skinA, skinB, hash(x >> 1, y >> 1, seed));
      c = grain(c, x, y, seed + 1, 0.12);
      if (hash(x, y, seed + 2) > 0.95) c = shade(c, 0.75); // blotches
      return c;
    };
    // Torn edge: a jagged boundary row per column.
    const jag = (x, seed, base, amp) => base + Math.floor(hash(x, 0, seed) * amp);
    s.part("head", (f, x, y, w, h) => {
      let c = flesh(x, y, 51);
      // Stringy dark hair on top and the back.
      if (f === "top" && hash(x, y >> 2, 52) > 0.45) c = grain(hex(0x2e2a26), x, y, 53, 0.2);
      if ((f === "back" || f === "right" || f === "left") && y < jag(x, 54, 2, 4) && hash(x, 0, 55) > 0.3) c = grain(hex(0x2e2a26), x, y, 56, 0.2);
      if (f === "front") {
        // Sunken sockets with glowing amber pupils.
        for (const ex of [2, 10]) {
          if (y >= 5 && y < 9 && x >= ex && x < ex + 4) c = shade(flesh(x, y, 57), 0.35);
          if (y >= 6 && y < 8 && x >= ex + 1 && x < ex + 3) c = [255, 176, 40];
        }
        // Brow ridge shadow.
        if (y === 4 && ((x >= 2 && x < 6) || (x >= 10 && x < 14))) c = shade(c, 0.7);
        // A stitched, crooked mouth with a few teeth.
        if (y === 12 && x >= 4 && x < 12) c = [36, 22, 24];
        if (y === 11 && (x === 5 || x === 8 || x === 10)) c = [168, 158, 118];
        if (y === 13 && (x === 6 || x === 9)) c = [36, 22, 24];
        // A scar across one cheek.
        if (x + y === 17 && x >= 11 && x <= 14) c = hex(0x6b4b52);
      }
      return c;
    });
    s.part("body", (f, x, y, w, h) => {
      // Torn maroon tunic, ragged hem showing skin, rope belt.
      const hem = jag(x, 61, h - 5, 4);
      if (y >= hem) return flesh(x, y, 62);
      if (y >= h - 9 && y < h - 7) return grain(hex(0x8b6a3c), x, y, 63, 0.15);
      let c = grain(mix(rag, ragDark, hash(x >> 2, y >> 2, 64) * 0.6), x, y, 65, 0.15);
      if (hash(x >> 1, y >> 1, 66) > 0.93) c = flesh(x, y, 67); // holes
      if (f === "front" && y < 3 && x >= 5 && x < 11) c = flesh(x, y, 68); // collar gap
      return c;
    });
    for (const arm of ["armL", "armR"]) {
      s.part(arm, (f, x, y, w, h) => {
        const sleeve = jag(x, 71, 8, 4);
        if (f === "top" || y < sleeve) return grain(mix(rag, ragDark, hash(x >> 2, y >> 2, 72) * 0.6), x, y, 73, 0.15);
        let c = flesh(x, y, 74);
        if (f === "bottom" || y >= h - 2) c = grain(hex(0x3b3533), x, y, 75, 0.2); // dark nails
        return c;
      });
    }
    for (const leg of ["legL", "legR"]) {
      s.part(leg, (f, x, y, w, h) => {
        if (f === "bottom" || y >= h - 2) return shade(flesh(x, y, 81), 0.8);
        const cuff = jag(x, 82, h - 8, 3);
        if (y >= cuff) return flesh(x, y, 83);
        let c = grain(pants, x, y, 84, 0.14);
        if (f === "front" && y >= 9 && y < 12 && x >= 2 && x < 6) c = flesh(x, y, 85); // torn knee
        return c;
      });
    }
  },
  animate(p, st) {
    const swing = Math.sin(st.walkPhase) * 0.7 * st.walk;
    p.legL.rotation.x = swing;
    p.legR.rotation.x = -swing;
    // Arms reach forward, swaying; an attack swings them down hard.
    const reach = -1.35 + Math.sin(st.time * 2.1) * 0.06;
    const hit = Math.sin(st.attack * Math.PI) * 0.9;
    p.armL.rotation.x = reach + swing * 0.25 + hit;
    p.armR.rotation.x = reach - swing * 0.25 + hit;
    p.armL.rotation.z = -0.08;
    p.armR.rotation.z = 0.08;
    p.body.rotation.x = 0.12 + hit * 0.15; // hunched
    p.body.rotation.z = Math.sin(st.walkPhase * 0.5) * 0.05 * st.walk;
    p.head.rotation.y = st.headYaw;
    p.head.rotation.x = -st.headPitch - 0.12;
  },
};

const SKELETON = {
  parts: [
    { name: "legL", size: [4, 12, 4], pivot: [-2, 12, 0], from: [-2, -12, -2] },
    { name: "legR", size: [4, 12, 4], pivot: [2, 12, 0], from: [-2, -12, -2] },
    { name: "body", size: [7, 12, 3], pivot: [0, 12, 0], from: [-3.5, 0, -1.5] },
    { name: "head", size: [7, 7, 7], pivot: [0, 24, 0], from: [-3.5, 0, -3.5], parent: "body" },
    { name: "armL", size: [3, 12, 3], pivot: [-5, 23, 0], from: [-1.5, -11, -1.5], parent: "body" },
    { name: "armR", size: [3, 12, 3], pivot: [5, 23, 0], from: [-1.5, -11, -1.5], parent: "body" },
  ],
  paint(s) {
    const bone = hex(0xd8d2bf);
    const boneDark = hex(0xb3ab90);
    const strap = hex(0x4a3b2a);
    const boned = (x, y, seed) => {
      let c = grain(bone, x, y, seed, 0.1);
      if (hash(x, y >> 1, seed + 1) > 0.9) c = boneDark;
      return c;
    };
    s.part("head", (f, x, y, w, h) => {
      let c = boned(x, y, 121);
      if (f === "front") {
        for (const ex of [1, 9]) if (y >= 3 && y < 5 && x >= ex && x < ex + 3) c = y === 3 ? [180, 220, 235] : [10, 10, 10];
        if (y === 9 && x >= 2 && x < 12) c = boneDark; // jaw line
      }
      return c;
    });
    s.part("body", (f, x, y, w, h) => {
      let c = boned(x, y, 122);
      if (f === "front" && ((x + y) % 5 === 0)) c = shade(c, 0.85); // ribs
      if (f === "front" && y >= h - 4) c = grain(strap, x, y, 123, 0.15); // a quiver strap
      return c;
    });
    for (const arm of ["armL", "armR"]) s.part(arm, (f, x, y, w, h) => boned(x, y, 124));
    for (const leg of ["legL", "legR"]) s.part(leg, (f, x, y, w, h) => boned(x, y, 125));
  },
  animate(p, st) {
    const swing = Math.sin(st.walkPhase) * 0.6 * st.walk;
    p.legL.rotation.x = swing;
    p.legR.rotation.x = -swing;
    const draw = st.attack < 1 ? (1 - st.attack) * 0.9 : 0; // draws the bow before releasing
    p.armL.rotation.x = -1.1 - draw * 0.3;
    p.armR.rotation.x = -1.1 + draw * 0.5;
    p.armL.rotation.z = -0.1;
    p.armR.rotation.z = 0.1;
    p.body.rotation.z = Math.sin(st.walkPhase * 0.5) * 0.04 * st.walk;
    p.head.rotation.y = st.headYaw;
    p.head.rotation.x = -st.headPitch;
  },
};

const SPIDER = {
  parts: [
    { name: "body", size: [8, 7, 11], pivot: [0, 5, 2], from: [-4, -3.5, -3.5] },
    { name: "abdomen", size: [9, 9, 9], pivot: [0, 5, -7], from: [-4.5, -4.5, -4.5], parent: "body", rigid: true },
    { name: "head", size: [5, 5, 4], pivot: [0, 5, 7], from: [-2.5, -2.5, 0], parent: "body", rigid: true },
    { name: "leg1L", size: [8, 1, 1], pivot: [-4, 6, 3], from: [-8, -0.5, -0.5] },
    { name: "leg2L", size: [8, 1, 1], pivot: [-4, 6, 1], from: [-8, -0.5, -0.5] },
    { name: "leg3L", size: [8, 1, 1], pivot: [-4, 6, -1], from: [-8, -0.5, -0.5] },
    { name: "leg4L", size: [8, 1, 1], pivot: [-4, 6, -3], from: [-8, -0.5, -0.5] },
    { name: "leg1R", size: [8, 1, 1], pivot: [4, 6, 3], from: [0, -0.5, -0.5] },
    { name: "leg2R", size: [8, 1, 1], pivot: [4, 6, 1], from: [0, -0.5, -0.5] },
    { name: "leg3R", size: [8, 1, 1], pivot: [4, 6, -1], from: [0, -0.5, -0.5] },
    { name: "leg4R", size: [8, 1, 1], pivot: [4, 6, -3], from: [0, -0.5, -0.5] },
  ],
  paint(s) {
    const fur = hex(0x1c1a22);
    const furLight = hex(0x332f3d);
    const marking = hex(0x8a2f3a);
    const eye = hex(0xc23b3b);
    const spiderTex = (x, y, seed) => grain(mix(fur, furLight, hash(x >> 1, y >> 1, seed) * 0.5), x, y, seed + 1, 0.16);
    s.part("body", (f, x, y, w, h) => spiderTex(x, y, 131));
    s.part("abdomen", (f, x, y, w, h) => {
      let c = spiderTex(x, y, 132);
      if (f !== "bottom" && ((x + y) % 6 === 0)) c = grain(marking, x, y, 133, 0.15);
      return c;
    });
    s.part("head", (f, x, y, w, h) => {
      let c = spiderTex(x, y, 134);
      if (f === "front" && y >= 1 && y < 3) {
        if (x === 0 || x === 1 || x === w - 2 || x === w - 1) c = eye;
      }
      return c;
    });
    for (const leg of ["leg1L", "leg2L", "leg3L", "leg4L", "leg1R", "leg2R", "leg3R", "leg4R"]) {
      s.part(leg, (f, x, y, w, h) => spiderTex(x, y, 135));
    }
  },
  animate(p, st) {
    const t = st.walkPhase;
    const legs = ["leg1L", "leg2L", "leg3L", "leg4L", "leg1R", "leg2R", "leg3R", "leg4R"];
    for (let i = 0; i < legs.length; i++) {
      const side = i < 4 ? 1 : -1;
      const phase = t + (i % 4) * 1.5 + (i < 4 ? 0 : Math.PI);
      const swing = Math.sin(phase) * 0.35 * st.walk;
      p[legs[i]].rotation.z = side * (0.5 + swing);
      p[legs[i]].rotation.y = Math.cos(phase) * 0.2 * st.walk;
    }
    p.body.rotation.y = st.headYaw * 0.4;
  },
};

const COW = {
  parts: [
    { name: "body", size: [14, 12, 20], pivot: [0, 11, 0], from: [-7, 0, -10] },
    { name: "head", size: [7, 7, 6], pivot: [0, 15, 10], from: [-3.5, -5, 0] },
    { name: "earL", size: [1, 2, 3], pivot: [-3.5, 18, 12], from: [-3, -1, -1.5], parent: "head", rigid: true },
    { name: "earR", size: [1, 2, 3], pivot: [3.5, 18, 12], from: [2, -1, -1.5], parent: "head", rigid: true },
    { name: "tail", size: [1, 6, 1], pivot: [0, 14, -10], from: [-0.5, -6, -1], parent: "body" },
    { name: "legFL", size: [4, 11, 4], pivot: [-4.5, 11, 7], from: [-2, -11, -2] },
    { name: "legFR", size: [4, 11, 4], pivot: [4.5, 11, 7], from: [-2, -11, -2] },
    { name: "legBL", size: [4, 11, 4], pivot: [-4.5, 11, -7], from: [-2, -11, -2] },
    { name: "legBR", size: [4, 11, 4], pivot: [4.5, 11, -7], from: [-2, -11, -2] },
  ],
  paint(s) {
    const hideA = hex(0x3a2e26);
    const hideB = hex(0xe8dfce);
    const nose = hex(0x2a2320);
    const hoof = hex(0x18130f);
    const patchy = (x, y, w, h, seed, top) => {
      const p1 = hash(Math.floor(x / 3), Math.floor((y + (top ? 0 : 4)) / 3), seed);
      const p2 = hash(Math.floor(x / 5) + 11, Math.floor(y / 5) + 7, seed + 1);
      const dark = p1 > 0.42 || p2 > 0.78;
      return grain(dark ? hideA : hideB, x, y, seed + 2, 0.1);
    };
    s.part("body", (f, x, y, w, h) => (f === "bottom" ? grain(hideB, x, y, 141, 0.1) : patchy(x, y, w, h, 142, f === "top")));
    s.part("head", (f, x, y, w, h) => {
      if (f === "front" && y >= h - 3 && x >= 2 && x < w - 2) return grain(hex(0xd9a793), x, y, 143, 0.1); // muzzle
      if (f === "front" && y === h - 4 && (x === 2 || x === w - 3)) return nose;
      return patchy(x, y, w, h, 144, f === "top");
    });
    for (const ear of ["earL", "earR"]) s.part(ear, () => grain(hideA, 0, 0, 145, 0.1));
    s.part("tail", (f, x, y, w, h) => (y > h - 3 ? grain(hex(0x1c1712), x, y, 146, 0.15) : grain(hideA, x, y, 147, 0.1)));
    for (const leg of ["legFL", "legFR", "legBL", "legBR"]) {
      s.part(leg, (f, x, y, w, h) => (y >= h - 2 ? grain(hoof, x, y, 148, 0.15) : patchy(x, y, w, h, 149, false)));
    }
  },
  animate(p, st) {
    const swing = Math.sin(st.walkPhase) * 0.4 * st.walk;
    p.legFL.rotation.x = swing;
    p.legBR.rotation.x = swing;
    p.legFR.rotation.x = -swing;
    p.legBL.rotation.x = -swing;
    p.tail.rotation.x = Math.sin(st.time * 2) * 0.15;
    p.head.rotation.y = st.headYaw;
    p.head.rotation.x = -st.headPitch + st.graze * 0.85;
  },
};

const PIG = {
  parts: [
    { name: "body", size: [10, 8, 15], pivot: [0, 7, 0], from: [-5, 0, -7.5] },
    { name: "head", size: [6, 6, 5], pivot: [0, 9, 7.5], from: [-3, -3, 0] },
    { name: "snout", size: [3, 2, 1], pivot: [0, 8, 12.5], from: [-1.5, -1, 0], parent: "head", rigid: true },
    { name: "earL", size: [2, 2, 1], pivot: [-2.5, 12, 8], from: [-1.5, 0, -0.5], parent: "head", rigid: true },
    { name: "earR", size: [2, 2, 1], pivot: [2.5, 12, 8], from: [-0.5, 0, -0.5], parent: "head", rigid: true },
    { name: "legFL", size: [3, 6, 3], pivot: [-3, 6, 5], from: [-1.5, -6, -1.5] },
    { name: "legFR", size: [3, 6, 3], pivot: [3, 6, 5], from: [-1.5, -6, -1.5] },
    { name: "legBL", size: [3, 6, 3], pivot: [-3, 6, -5], from: [-1.5, -6, -1.5] },
    { name: "legBR", size: [3, 6, 3], pivot: [3, 6, -5], from: [-1.5, -6, -1.5] },
  ],
  paint(s) {
    const skinA = hex(0xdf9c92);
    const skinB = hex(0xc47f79);
    const pink = (x, y, seed) => grain(mix(skinA, skinB, hash(x >> 1, y >> 1, seed) * 0.5), x, y, seed + 1, 0.1);
    s.part("body", (f, x, y, w, h) => pink(x, y, 151));
    s.part("head", (f, x, y, w, h) => pink(x, y, 152));
    s.part("snout", (f, x, y, w, h) => {
      if (f === "front" && (x === 0 || x === w - 1)) return [40, 20, 20];
      return grain(hex(0xe8b0a6), x, y, 153, 0.08);
    });
    for (const ear of ["earL", "earR"]) s.part(ear, () => pink(1, 1, 154));
    for (const leg of ["legFL", "legFR", "legBL", "legBR"]) {
      s.part(leg, (f, x, y, w, h) => (y >= h - 1 ? [40, 24, 22] : pink(x, y, 155)));
    }
  },
  animate(p, st) {
    const swing = Math.sin(st.walkPhase) * 0.45 * st.walk;
    p.legFL.rotation.x = swing;
    p.legBR.rotation.x = swing;
    p.legFR.rotation.x = -swing;
    p.legBL.rotation.x = -swing;
    p.head.rotation.y = st.headYaw;
    p.head.rotation.x = -st.headPitch + st.graze * 0.7;
  },
};

const CHICKEN = {
  parts: [
    { name: "body", size: [6, 7, 8], pivot: [0, 8, 0], from: [-3, -3.5, -4] },
    { name: "head", size: [4, 4, 4], pivot: [0, 12, 3], from: [-2, -1, 0], parent: "body" },
    { name: "beak", size: [2, 1, 2], pivot: [0, 12, 7], from: [-1, -1, 0], parent: "head", rigid: true },
    { name: "comb", size: [2, 2, 2], pivot: [0, 15, 5], from: [-1, -1, -1], parent: "head", rigid: true },
    { name: "wingL", size: [1, 4, 5], pivot: [-3, 9, 0], from: [-1, -4, -2.5], parent: "body" },
    { name: "wingR", size: [1, 4, 5], pivot: [3, 9, 0], from: [0, -4, -2.5], parent: "body" },
    { name: "tail", size: [1, 5, 3], pivot: [0, 10, -4], from: [-0.5, -1, -3], parent: "body", rigid: true },
    { name: "legL", size: [1, 4, 1], pivot: [-1.5, 4, 0], from: [-0.5, -4, -0.5] },
    { name: "legR", size: [1, 4, 1], pivot: [1.5, 4, 0], from: [-0.5, -4, -0.5] },
  ],
  paint(s) {
    const white = hex(0xf2ece0);
    const brown = hex(0x8a5a34);
    const comb = hex(0xc23b3b);
    const beakC = hex(0xe8b23a);
    const feather = (x, y, seed) => grain(mix(white, brown, hash(x >> 1, y >> 2, seed) * 0.3), x, y, seed + 1, 0.12);
    s.part("body", (f, x, y, w, h) => feather(x, y, 161));
    s.part("head", (f, x, y, w, h) => {
      if (f === "front" && y === 1 && (x === 0 || x === w - 1)) return [20, 16, 12];
      return feather(x, y, 162);
    });
    s.part("beak", () => beakC);
    s.part("comb", () => comb);
    for (const wing of ["wingL", "wingR"]) s.part(wing, (f, x, y, w, h) => feather(x, y, 163));
    s.part("tail", (f, x, y, w, h) => feather(x, y, 164));
    for (const leg of ["legL", "legR"]) s.part(leg, () => beakC);
  },
  animate(p, st) {
    const peck = Math.sin(st.time * 4) * 0.02;
    p.legL.rotation.x = Math.sin(st.walkPhase) * 0.6 * st.walk;
    p.legR.rotation.x = -Math.sin(st.walkPhase) * 0.6 * st.walk;
    p.wingL.rotation.z = 0.15 + Math.sin(st.time * 6) * 0.06 * st.walk;
    p.wingR.rotation.z = -0.15 - Math.sin(st.time * 6) * 0.06 * st.walk;
    p.head.rotation.y = st.headYaw;
    p.head.rotation.x = -st.headPitch + peck;
    p.head.position.y = 12 * PX - Math.max(0, Math.sin(st.time * 4)) * 0.03;
  },
};

// Small flying/decorative critters (butterflies, parrots, fish): a lighter
// rig, animated by simple wing/tail flaps rather than the walk cycle.
const BUTTERFLY = {
  parts: [
    { name: "body", size: [1, 1, 3], pivot: [0, 0, 0], from: [-0.5, -0.5, -1.5] },
    { name: "wingL", size: [5, 3, 1], pivot: [0, 0.5, 0], from: [-5, -1.5, -0.5] },
    { name: "wingR", size: [5, 3, 1], pivot: [0, 0.5, 0], from: [0, -1.5, -0.5] },
  ],
  paint(s) {
    const hues = [hex(0xf7b733), hex(0xe94f9b), hex(0x4cc9f0), hex(0xf72585)];
    const hue = hues[Math.floor(hash(1, 1, s.seed) * hues.length)];
    s.part("body", () => hex(0x2a2018));
    for (const wing of ["wingL", "wingR"]) {
      s.part(wing, (f, x, y, w, h) => {
        if (f !== "front" && f !== "back") return shade(hue, 0.7);
        const d = Math.hypot(x - w * 0.6, y - h * 0.4);
        return d < w * 0.35 ? hex(0xfff6d8) : hue;
      });
    }
  },
  animate(p, st) {
    const flap = Math.sin(st.time * 14) * 0.9 + 0.9;
    p.wingL.rotation.z = flap;
    p.wingR.rotation.z = -flap;
    p.body.rotation.y = st.headYaw;
  },
};

const PARROT = {
  parts: [
    { name: "body", size: [4, 5, 7], pivot: [0, 4, 0], from: [-2, -2.5, -3.5] },
    { name: "head", size: [3, 3, 3], pivot: [0, 6.5, 3], from: [-1.5, -1, 0], parent: "body" },
    { name: "beak", size: [2, 1, 2], pivot: [0, 6, 6], from: [-1, -0.5, 0], parent: "head", rigid: true },
    { name: "wingL", size: [1, 3, 4], pivot: [-2, 5, 0], from: [-1, -2.5, -2], parent: "body" },
    { name: "wingR", size: [1, 3, 4], pivot: [2, 5, 0], from: [0, -2.5, -2], parent: "body" },
    { name: "tail", size: [2, 2, 5], pivot: [0, 4, -3.5], from: [-1, -1, -5], parent: "body" },
  ],
  paint(s) {
    const body = hex(0x2f9e44);
    const belly = hex(0xf7b733);
    const blue = hex(0x2b6fd1);
    const beakC = hex(0x2a2320);
    s.part("body", (f, x, y, w, h) => (f === "bottom" ? grain(belly, x, y, 171, 0.1) : grain(body, x, y, 172, 0.1)));
    s.part("head", () => grain(blue, 3, 3, 173, 0.1));
    s.part("beak", () => beakC);
    for (const wing of ["wingL", "wingR"]) s.part(wing, (f, x, y, w, h) => grain(body, x, y, 174, 0.12));
    s.part("tail", (f, x, y, w, h) => grain(hex(0xd6336c), x, y, 175, 0.1));
  },
  animate(p, st) {
    const flap = Math.sin(st.time * 10) * 0.5;
    p.wingL.rotation.z = 0.3 + flap;
    p.wingR.rotation.z = -0.3 - flap;
    p.tail.rotation.x = Math.sin(st.time * 2) * 0.1;
    p.head.rotation.y = st.headYaw;
    p.head.rotation.x = -st.headPitch;
  },
};

const FISH = {
  parts: [
    { name: "body", size: [3, 4, 10], pivot: [0, 0, 0], from: [-1.5, -2, -5] },
    { name: "tail", size: [1, 4, 4], pivot: [0, 0, -5], from: [-0.5, -2, -4], parent: "body" },
    { name: "finTop", size: [1, 2, 4], pivot: [0, 2, 0], from: [-0.5, 0, -2], parent: "body", rigid: true },
  ],
  paint(s) {
    const hues = [hex(0xe8863a), hex(0x4cc9f0), hex(0xc9184a), hex(0xffd166)];
    const hue = hues[Math.floor(hash(2, 5, s.seed) * hues.length)];
    s.part("body", (f, x, y, w, h) => (f === "bottom" ? shade(hue, 0.7) : grain(hue, x, y, 181, 0.14)));
    s.part("tail", () => shade(hue, 0.85));
    s.part("finTop", () => shade(hue, 0.9));
  },
  animate(p, st) {
    const wig = Math.sin(st.time * 7) * 0.35;
    p.tail.rotation.y = wig;
    p.body.rotation.y = st.headYaw * 0.5 + Math.sin(st.time * 3.5) * 0.15;
  },
};

const VILLAGER = {
  parts: [
    { name: "legL", size: [4, 11, 4], pivot: [-2, 11, 0], from: [-2, -11, -2] },
    { name: "legR", size: [4, 11, 4], pivot: [2, 11, 0], from: [-2, -11, -2] },
    { name: "body", size: [8, 11, 5], pivot: [0, 11, 0], from: [-4, 0, -2.5] },
    { name: "head", size: [7, 7, 7], pivot: [0, 22, 0], from: [-3.5, 0, -3.5], parent: "body" },
    { name: "nose", size: [2, 2, 2], pivot: [0, 26, 4.5], from: [-1, -1, 0], parent: "head", rigid: true },
    { name: "armL", size: [3, 10, 3], pivot: [-5.5, 21, 0], from: [-1.5, -9, -1.5], parent: "body" },
    { name: "armR", size: [3, 10, 3], pivot: [5.5, 21, 0], from: [-1.5, -9, -1.5], parent: "body" },
  ],
  paint(s) {
    const skin = hex(0xd9a066);
    const robe = hex(0x8a6a3c);
    const robeDark = hex(0x6a4f2b);
    const trim = hex(0xb9925a);
    const pants = hex(0x4a4438);
    const cloth = (x, y, seed, base) => grain(base, x, y, seed, 0.1);
    s.part("head", (f, x, y, w, h) => {
      let c = grain(skin, x, y, 91, 0.08);
      if (f === "top") c = grain(mix(skin, hex(0x3a2a1c), 0.5), x, y, 92, 0.15); // hair
      if (f === "front") {
        if (y >= 2 && y < 4 && (x === 1 || x === w - 2)) c = [30, 24, 20]; // eyes
        if (y === 5) c = shade(c, 0.85); // mouth shadow line
      }
      return c;
    });
    s.part("nose", () => hex(0xc98f57));
    s.part("body", (f, x, y, w, h) => {
      if (f === "front" && y < 3 && x >= 2 && x < 6) return grain(trim, x, y, 93, 0.1); // collar
      let c = cloth(x, y, 94, robe);
      if ((x + y) % 7 === 0) c = cloth(x, y, 95, robeDark);
      if (f === "front" && y >= h - 3) c = grain(trim, x, y, 96, 0.1); // hem band
      return c;
    });
    for (const arm of ["armL", "armR"]) {
      s.part(arm, (f, x, y, w, h) => (y >= h - 2 || f === "bottom" ? grain(skin, x, y, 97, 0.08) : cloth(x, y, 98, robe)));
    }
    for (const leg of ["legL", "legR"]) {
      s.part(leg, (f, x, y, w, h) => grain(pants, x, y, 99, 0.1));
    }
  },
  animate(p, st) {
    const swing = Math.sin(st.walkPhase) * 0.55 * st.walk;
    p.legL.rotation.x = swing;
    p.legR.rotation.x = -swing;
    p.armL.rotation.x = -swing * 0.6;
    p.armR.rotation.x = swing * 0.6;
    p.body.rotation.z = Math.sin(st.walkPhase * 0.5) * 0.04 * st.walk;
    p.head.rotation.y = st.headYaw;
    p.head.rotation.x = -st.headPitch;
  },
};

export const MODELS = {
  fluffalo: FLUFFALO,
  hoplet: HOPLET,
  mossback: MOSSBACK,
  zombie: ZOMBIE,
  villager: VILLAGER,
  skeleton: SKELETON,
  spider: SPIDER,
  cow: COW,
  pig: PIG,
  chicken: CHICKEN,
  butterfly: BUTTERFLY,
  parrot: PARROT,
  fish: FISH,
};

// Shared per species: skin texture, material and part geometries.
const built = new Map();

// Concatenates indexed geometries (same attributes) into one.
function mergeGeometries(list) {
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const size = list[0].getAttribute(name).itemSize;
    const arrays = list.map((g) => g.getAttribute(name).array);
    const merged = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrays) {
      merged.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(merged, size));
  }
  const idx = [];
  let base = 0;
  for (const g of list) {
    for (const i of g.index.array) idx.push(i + base);
    base += g.getAttribute("position").count;
  }
  out.setIndex(idx);
  return out;
}

function buildSpecies(kind) {
  if (built.has(kind)) return built.get(kind);
  const def = MODELS[kind];
  const skin = new Skin(def.parts);
  def.paint(skin);
  const texture = skin.texture();
  const material = createEntityMaterial("map", texture);
  // Rigid parts are baked into their parent's geometry.
  const pieces = {};
  for (const part of def.parts) {
    const g = boxGeometry(skin, part);
    let owner = part;
    while (owner.rigid) {
      const parent = def.parts.find((q) => q.name === owner.parent);
      g.translate((owner.pivot[0] - parent.pivot[0]) * PX, (owner.pivot[1] - parent.pivot[1]) * PX, (owner.pivot[2] - parent.pivot[2]) * PX);
      owner = parent;
    }
    (pieces[owner.name] ||= []).push(g);
  }
  const geometries = {};
  for (const [name, list] of Object.entries(pieces)) geometries[name] = list.length === 1 ? list[0] : mergeGeometries(list);
  const entry = { def, skin, texture, material, geometries };
  built.set(kind, entry);
  return entry;
}

// Creates a model instance: { root, tilt, parts, meshes, animate(state) }.
// `root` is positioned/rotated by the mob; `tilt` is used for death.
export function createMobModel(kind) {
  const { def, material, geometries } = buildSpecies(kind);
  const root = new THREE.Group();
  const tilt = new THREE.Group();
  root.add(tilt);
  const parts = {};
  const meshes = [];
  for (const part of def.parts) {
    if (part.rigid) continue;
    const group = new THREE.Group();
    const parent = part.parent ? def.parts.find((q) => q.name === part.parent) : null;
    const pp = parent ? parent.pivot : [0, 0, 0];
    group.position.set((part.pivot[0] - pp[0]) * PX, (part.pivot[1] - pp[1]) * PX, (part.pivot[2] - pp[2]) * PX);
    const mesh = new THREE.Mesh(geometries[part.name], material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    (parent ? parts[parent.name] : tilt).add(group);
    parts[part.name] = group;
    meshes.push(mesh);
  }
  return {
    root,
    tilt,
    parts,
    meshes,
    animate: (state) => def.animate(parts, state),
  };
}

// The painted skin as a canvas (for debugging / a model viewer).
export function skinCanvas(kind) {
  const { skin } = buildSpecies(kind);
  const canvas = document.createElement("canvas");
  canvas.width = skin.W;
  canvas.height = skin.H;
  canvas.getContext("2d").putImageData(new ImageData(skin.data, skin.W, skin.H), 0, 0);
  return canvas;
}
