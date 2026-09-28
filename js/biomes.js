// Biome classification: smooth, low-frequency temperature and moisture
// fields (plus the column's height and how mountainous the terrain is
// there) pick a biome for any column. Pure logic (no three.js), callable
// independently per-column exactly like TerrainGenerator.heightAt, so trees
// and decoration can query it for any column without generating a chunk.
import { Noise } from "./noise.js";
import { SEA_LEVEL } from "./constants.js";

export const BIOME = Object.freeze({
  DEEP_OCEAN: 0,
  OCEAN: 1,
  WARM_OCEAN: 2,
  BEACH: 3,
  RIVER: 4,
  PLAINS: 5,
  FOREST: 6,
  BIRCH_FOREST: 7,
  DARK_FOREST: 8,
  TAIGA: 9,
  SNOWY_TAIGA: 10,
  SNOWY_PLAINS: 11,
  DESERT: 12,
  SAVANNA: 13,
  JUNGLE: 14,
  SWAMP: 15,
  BADLANDS: 16,
  MOUNTAINS: 17,
});

export const BIOME_NAMES = {
  [BIOME.DEEP_OCEAN]: "Deep Ocean",
  [BIOME.OCEAN]: "Ocean",
  [BIOME.WARM_OCEAN]: "Warm Ocean",
  [BIOME.BEACH]: "Beach",
  [BIOME.RIVER]: "River",
  [BIOME.PLAINS]: "Plains",
  [BIOME.FOREST]: "Forest",
  [BIOME.BIRCH_FOREST]: "Birch Forest",
  [BIOME.DARK_FOREST]: "Dark Forest",
  [BIOME.TAIGA]: "Taiga",
  [BIOME.SNOWY_TAIGA]: "Snowy Taiga",
  [BIOME.SNOWY_PLAINS]: "Snowy Plains",
  [BIOME.DESERT]: "Desert",
  [BIOME.SAVANNA]: "Savanna",
  [BIOME.JUNGLE]: "Jungle",
  [BIOME.SWAMP]: "Swamp",
  [BIOME.BADLANDS]: "Badlands",
  [BIOME.MOUNTAINS]: "Mountains",
};

// Biomes cold enough that their ground is snow-capped and their trees (if
// any) are pines.
export function isSnowy(biome) {
  return biome === BIOME.SNOWY_PLAINS || biome === BIOME.SNOWY_TAIGA || biome === BIOME.MOUNTAINS;
}

export function isOceanBiome(biome) {
  return biome === BIOME.DEEP_OCEAN || biome === BIOME.OCEAN || biome === BIOME.WARM_OCEAN;
}

export class BiomeSource {
  constructor(seed) {
    this.tempNoise = new Noise((seed ^ 0x1a2b3c4d) >>> 0);
    this.moistNoise = new Noise((seed ^ 0x5e6f7081) >>> 0);
  }

  // Smooth climate fields, roughly in [-0.7, 0.7]: t = cold..hot, m = dry..wet.
  climate(wx, wz) {
    const t = this.tempNoise.fbm2(wx, wz, 2, 0.5, 2, 1 / 480);
    const m = this.moistNoise.fbm2(wx + 4000, wz - 4000, 2, 0.5, 2, 1 / 420);
    return { t, m };
  }

  // h: terrain height at (wx, wz). mountainT: 0-1, how mountainous. river:
  // whether this column sits in a river channel (both from terrain.js, which
  // already computes them while finding the height).
  biomeAt(wx, wz, h, mountainT, river) {
    if (h < SEA_LEVEL - 1) {
      const { t } = this.climate(wx, wz);
      if (h < SEA_LEVEL - 10) return BIOME.DEEP_OCEAN;
      return t > 0.3 ? BIOME.WARM_OCEAN : BIOME.OCEAN;
    }
    if (river && h <= SEA_LEVEL + 3) return BIOME.RIVER;
    if (h <= SEA_LEVEL + 1) return BIOME.BEACH;
    if (mountainT > 0.5) return BIOME.MOUNTAINS;
    const { t, m } = this.climate(wx, wz);
    if (t < -0.28) return m > -0.05 ? BIOME.SNOWY_TAIGA : BIOME.SNOWY_PLAINS;
    if (t > 0.4) {
      if (m > 0.25) return BIOME.JUNGLE;
      if (m > -0.15) return BIOME.SAVANNA;
      return BIOME.DESERT;
    }
    if (t > 0.12 && m < -0.35) return BIOME.BADLANDS;
    if (m > 0.4) return BIOME.SWAMP;
    if (m > 0.12) {
      if (t < 0.02) return BIOME.TAIGA;
      return m > 0.3 ? BIOME.DARK_FOREST : BIOME.FOREST;
    }
    if (m > -0.1) return BIOME.BIRCH_FOREST;
    return BIOME.PLAINS;
  }
}
