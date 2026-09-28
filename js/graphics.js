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

// Soft-shadow tuning, in blocks: the width of a plain filtered shadow
// edge, and the apparent size of the sun (tangent of its diameter; a bit
// larger than the real sun's, for pleasantly soft penumbrae).
const SHADOW_EDGE = 0.07;
const SUN_SIZE = 0.022;
const MAX_PENUMBRA = 0.34;

// Applies a preset. ctx: { renderer, postfx, sunLight, sky, materials (array
// of materials to recompile), chunkMaterials ({ opaque, cutout, water }),
// atlas, onResize }.
export function applyPreset(name, ctx) {
  const p = PRESETS[normalizePreset(name)];
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
