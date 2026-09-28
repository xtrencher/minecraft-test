// Graphics presets. Each preset trades visual features for speed; "low" is
// meant to run smoothly on weak laptops (no post-processing, no shadow
// maps, native pixel ratio, cheap sky and water), "ultra" turns everything on.
// renderDistance is the suggested view distance in chunks (applied when a
// preset is picked); detailDistance is how far (in chunks, roughly) terrain
// is drawn in full detail before simplified LOD tiles take over.
import * as THREE from "three";
import { worldUniforms } from "./shaders.js";
import { SHADOW_DEPTH } from "./sky.js";

export const PRESETS = {
  low: {
    label: "Low",
    post: false,
    cascades: [], // sun shadow maps: [half-extent in blocks, map size], finest first
    shadowQuality: 0,
    msaa: 0,
    maxPixelRatio: 1,
    bloomLevels: 0,
    godRays: false,
    cloudOctaves: 2,
    waves: 0,
    caustics: 0,
    anisotropy: 1,
    normalMap: false,
    pom: false,
    grass: 0,
    fancyLeaves: false,
    water: "simple",
    mist: 0.5, // strength of the low mist over water
    raySamples: 32,
    renderDistance: 12,
    detailDistance: 4,
  },
  medium: {
    label: "Medium",
    post: true,
    cascades: [[40, 1024]],
    shadowQuality: 1,
    msaa: 2,
    maxPixelRatio: 1,
    bloomLevels: 4,
    godRays: false,
    cloudOctaves: 3,
    waves: 1,
    caustics: 0,
    anisotropy: 4,
    normalMap: false,
    pom: false,
    grass: 0,
    fancyLeaves: false,
    water: "simple",
    mist: 0.8, // strength of the low mist over water
    raySamples: 32,
    renderDistance: 16,
    detailDistance: 6,
  },
  high: {
    label: "High",
    post: true,
    cascades: [[28, 2048], [110, 2048]],
    shadowQuality: 2,
    msaa: 4,
    maxPixelRatio: 1.5,
    bloomLevels: 5,
    godRays: true,
    cloudOctaves: 4,
    waves: 1,
    caustics: 1,
    anisotropy: 8,
    normalMap: true,
    pom: false,
    grass: 1,
    fancyLeaves: true,
    water: "refract",
    mist: 1.0, // strength of the low mist over water
    raySamples: 48,
    renderDistance: 20,
    detailDistance: 8,
  },
  ultra: {
    label: "Ultra",
    post: true,
    cascades: [[22, 2048], [64, 2048], [180, 2048]],
    shadowQuality: 3,
    msaa: 4,
    maxPixelRatio: 2,
    bloomLevels: 6,
    godRays: true,
    cloudOctaves: 5,
    waves: 1,
    caustics: 1,
    anisotropy: 16,
    normalMap: true,
    pom: true,
    grass: 2,
    fancyLeaves: true,
    water: "ssr",
    mist: 1.0, // strength of the low mist over water
    raySamples: 72,
    renderDistance: 20,
    detailDistance: 8,
  },
};

export const PRESET_ORDER = ["low", "medium", "high", "ultra"];
export const DEFAULT_PRESET = "ultra";

export function normalizePreset(name) {
  return PRESET_ORDER.includes(name) ? name : DEFAULT_PRESET;
}

// The next preset down (Low stays Low).
export function lowerPreset(name) {
  return PRESET_ORDER[Math.max(0, PRESET_ORDER.indexOf(normalizePreset(name)) - 1)];
}

// Individual graphics options that can override the chosen preset (settings
// menu). Each maps a user-facing choice onto preset fields. The value shown
// for an option that isn't overridden is read back from the preset with
// `get`, so the menu always shows what is actually in effect.
const SHADOW_TIERS = { off: "low", low: "medium", medium: "high", high: "ultra" };
export const GFX_OPTIONS = {
  shadows: {
    label: "Shadows",
    choices: [["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]],
    get: (p) => Object.keys(SHADOW_TIERS).find((k) => PRESETS[SHADOW_TIERS[k]].cascades.length === p.cascades.length) || "off",
    apply: (p, v) => {
      const src = PRESETS[SHADOW_TIERS[v]] || PRESETS.low;
      p.cascades = src.cascades;
      p.shadowQuality = src.shadowQuality;
    },
  },
  antialias: {
    label: "Anti-aliasing",
    choices: [["0", "Off"], ["2", "2x MSAA"], ["4", "4x MSAA"]],
    get: (p) => String(p.post ? p.msaa : 0),
    apply: (p, v) => {
      p.msaa = Number(v) || 0;
    },
  },
  bloom: {
    label: "Bloom",
    choices: [["on", "On"], ["off", "Off"]],
    get: (p) => (p.post && p.bloomLevels > 0 ? "on" : "off"),
    apply: (p, v) => {
      if (v === "on") {
        p.post = true;
        p.bloomLevels = Math.max(p.bloomLevels, 4);
      } else {
        p.bloomLevels = 0;
      }
    },
  },
  godRays: {
    label: "Light shafts",
    choices: [["on", "On"], ["off", "Off"]],
    get: (p) => (p.post && p.godRays ? "on" : "off"),
    apply: (p, v) => {
      p.godRays = v === "on";
      if (p.godRays) p.post = true;
    },
  },
  water: {
    label: "Water",
    choices: [["simple", "Simple"], ["refract", "Refractive"], ["ssr", "Reflective + refractive"]],
    get: (p) => p.water,
    apply: (p, v) => {
      p.water = ["simple", "refract", "ssr"].includes(v) ? v : "simple";
      if (p.water !== "simple") p.post = true;
    },
  },
  plants: {
    label: "3D plants",
    choices: [["0", "Off"], ["1", "Normal"], ["2", "Dense"]],
    get: (p) => String(p.grass),
    apply: (p, v) => {
      p.grass = Math.max(0, Math.min(2, Number(v) || 0));
    },
  },
  leaves: {
    label: "Fancy leaves",
    choices: [["on", "On"], ["off", "Off"]],
    get: (p) => (p.fancyLeaves ? "on" : "off"),
    apply: (p, v) => {
      p.fancyLeaves = v === "on";
    },
  },
  relief: {
    label: "Texture relief",
    choices: [["off", "Flat"], ["normal", "Normal maps"], ["parallax", "Parallax"]],
    get: (p) => (p.pom ? "parallax" : p.normalMap ? "normal" : "off"),
    apply: (p, v) => {
      p.normalMap = v !== "off";
      p.pom = v === "parallax";
    },
  },
  clouds: {
    label: "Clouds",
    choices: [["fast", "Fast"], ["fancy", "Fancy"]],
    get: (p) => (p.cloudOctaves >= 4 ? "fancy" : "fast"),
    apply: (p, v) => {
      p.cloudOctaves = v === "fancy" ? 5 : 2;
    },
  },
};

// The preset's settings with the user's per-option overrides applied.
export function resolvePreset(name, overrides = {}) {
  const p = { ...PRESETS[normalizePreset(name)] };
  for (const [key, opt] of Object.entries(GFX_OPTIONS)) {
    if (overrides && overrides[key] !== undefined && overrides[key] !== null) opt.apply(p, String(overrides[key]));
  }
  // Water drawn over the finished image needs the multisampled HDR target.
  if (p.water !== "simple" && p.msaa === 0) p.msaa = 2;
  if (!p.post) {
    p.bloomLevels = 0;
    p.godRays = false;
  }
  return p;
}

// Soft-shadow tuning, in blocks: the width of a plain filtered shadow
// edge, and the apparent size of the sun (tangent of its diameter; a bit
// larger than the real sun's, for pleasantly soft penumbrae).
const SHADOW_EDGE = 0.07;
const SUN_SIZE = 0.022;
const MAX_PENUMBRA = 0.34;

// Applies a preset. ctx: { renderer, postfx, sunLight, sky, materials (array
// of materials to recompile), chunkMaterials ({ opaque, cutout, water }),
// atlas, onResize, overrides (per-option overrides, see GFX_OPTIONS) }.
export function applyPreset(name, ctx) {
  const p = resolvePreset(name, ctx.overrides);
  const { renderer, postfx, sky } = ctx;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.maxPixelRatio));

  // Cascaded sun shadows (filtered in the shaders, see SUN_SHADOW).
  const shadows = p.cascades.length > 0;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  sky.configureShadows(p.cascades.map(([extent, mapSize]) => ({ extent, mapSize })));
  const texels = [0, 1, 2].map((i) => (p.cascades[i] ? (2 * p.cascades[i][0]) / p.cascades[i][1] : 1));
  const u = worldUniforms;
  u.uCascadeSoft.value.set(
    Math.min(4, Math.max(1, SHADOW_EDGE / texels[0])),
    Math.min(4, Math.max(1, SHADOW_EDGE / texels[1])),
    Math.min(4, Math.max(1, SHADOW_EDGE / texels[2])),
    Math.min(16, Math.max(4, MAX_PENUMBRA / texels[0]))
  );
  u.uPcssScale.value = (SHADOW_DEPTH * SUN_SIZE) / texels[0];
  u.uShadowQuality.value = p.shadowQuality;

  // Water: drawn over the finished world image (refraction, absorption,
  // reflections) on High/Ultra; the simple blended surface otherwise.
  const screenWater = p.post && p.msaa > 0 && p.water !== "simple";
  postfx.configure({ msaa: p.msaa, bloomLevels: p.bloomLevels, godRays: p.godRays, screenWater, raySamples: p.raySamples });
  if (ctx.chunkMaterials) {
    const water = ctx.chunkMaterials.water;
    setDefine(water, "WATER_SCREEN", screenWater);
    setDefine(water, "WATER_SSR", screenWater && p.water === "ssr");
    water.transparent = !screenWater;
    water.depthWrite = screenWater;
  }
  sky.material.defines.CLOUD_OCTAVES = p.cloudOctaves;
  u.uWaveStrength.value = p.waves;
  u.uCaustics.value = p.caustics;

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  ctx.atlas.anisotropy = Math.max(1, Math.min(p.anisotropy, maxAniso));
  ctx.atlas.needsUpdate = true;

  // Terrain relief: normal maps (and parallax up close) on the top presets.
  if (ctx.chunkMaterials) {
    for (const m of [ctx.chunkMaterials.opaque, ctx.chunkMaterials.cutout]) {
      setDefine(m, "USE_NORMALMAP", p.normalMap);
      setDefine(m, "USE_POM", p.pom);
    }
  }

  // Shadow/tone-mapping/define changes need fresh shader programs.
  for (const m of ctx.materials) m.needsUpdate = true;
  sky.material.needsUpdate = true;
  if (ctx.onResize) ctx.onResize();
  return p;
}

function setDefine(material, name, on) {
  if (on) material.defines[name] = "";
  else delete material.defines[name];
}
