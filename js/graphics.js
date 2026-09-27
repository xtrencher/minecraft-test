// Graphics presets. Each preset trades visual features for speed; "low" is
// meant to run smoothly on weak laptops (no post-processing, no shadow
// maps, native pixel ratio, cheap sky and water), "ultra" turns everything on.
// renderDistance is the suggested view distance in chunks (applied when a
// preset is picked); detailDistance is how far (in chunks, roughly) terrain
// is drawn in full detail before simplified LOD tiles take over.
import * as THREE from "three";
import { worldUniforms } from "./shaders.js";

export const PRESETS = {
  low: {
    label: "Low",
    post: false,
    shadows: 0,
    shadowExtent: 0,
    softShadows: false,
    msaa: 0,
    maxPixelRatio: 1,
    bloomLevels: 0,
    godRays: false,
    cloudOctaves: 2,
    waves: 0,
    caustics: 0,
    anisotropy: 1,
    renderDistance: 12,
    detailDistance: 4,
  },
  medium: {
    label: "Medium",
    post: true,
    shadows: 1024,
    shadowExtent: 40,
    softShadows: false,
    msaa: 2,
    maxPixelRatio: 1,
    bloomLevels: 4,
    godRays: false,
    cloudOctaves: 3,
    waves: 1,
    caustics: 0,
    anisotropy: 4,
    renderDistance: 16,
    detailDistance: 6,
  },
  high: {
    label: "High",
    post: true,
    shadows: 2048,
    shadowExtent: 56,
    softShadows: true,
    msaa: 4,
    maxPixelRatio: 1.5,
    bloomLevels: 5,
    godRays: true,
    cloudOctaves: 4,
    waves: 1,
    caustics: 1,
    anisotropy: 8,
    renderDistance: 20,
    detailDistance: 8,
  },
  ultra: {
    label: "Ultra",
    post: true,
    shadows: 4096,
    shadowExtent: 72,
    softShadows: true,
    msaa: 4,
    maxPixelRatio: 2,
    bloomLevels: 6,
    godRays: true,
    cloudOctaves: 5,
    waves: 1,
    caustics: 1,
    anisotropy: 16,
    renderDistance: 20,
    detailDistance: 8,
  },
};

export const PRESET_ORDER = ["low", "medium", "high", "ultra"];
export const DEFAULT_PRESET = "ultra";

export function normalizePreset(name) {
  return PRESETS[name] ? name : DEFAULT_PRESET;
}

// Applies a preset. ctx: { renderer, postfx, sunLight, sky, materials (array
// of materials to recompile), atlas, onResize }.
export function applyPreset(name, ctx) {
  const p = PRESETS[normalizePreset(name)];
  const { renderer, postfx, sunLight, sky } = ctx;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.maxPixelRatio));

  const shadows = p.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = p.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  sunLight.castShadow = shadows;
  if (shadows) {
    sunLight.shadow.mapSize.set(p.shadows, p.shadows);
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 0.03;
    if (sunLight.shadow.map) {
      sunLight.shadow.map.dispose();
      sunLight.shadow.map = null;
    }
    sky.configureShadows(p.shadowExtent, p.shadows);
  }

  postfx.configure({ msaa: p.msaa, bloomLevels: p.bloomLevels, godRays: p.godRays });
  sky.material.defines.CLOUD_OCTAVES = p.cloudOctaves;
  worldUniforms.uWaveStrength.value = p.waves;
  worldUniforms.uCaustics.value = p.caustics;

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  ctx.atlas.anisotropy = Math.max(1, Math.min(p.anisotropy, maxAniso));
  ctx.atlas.needsUpdate = true;

  // Shadow/tone-mapping/define changes need fresh shader programs.
  for (const m of ctx.materials) m.needsUpdate = true;
  sky.material.needsUpdate = true;
  if (ctx.onResize) ctx.onResize();
  return p;
}
