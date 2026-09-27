// The animated water surface, shared by the water shader (shaders.js) and
// the game logic, so "is the camera under water?" agrees exactly with what
// is drawn. The top of a water column is drawn WATER_SURFACE_HEIGHT into its
// top block, lowered a little more and moved by travelling waves.
import { WATER_SURFACE_HEIGHT } from "./mesher.js";
import { BLOCK } from "./blocks.js";

export const WAVE_SINK = 0.06; // extra lowering of the surface (times wave strength)

// Wave displacement at world (x, z) and time t; keep in sync with
// waveHeight() in the water vertex shader.
export function waveHeight(x, z, t, strength) {
  return (Math.sin(x * 0.8 + t * 1.3) * 0.5 + Math.sin(z * 0.65 - t * 1.05) * 0.5 + Math.sin((x + z) * 1.7 + t * 2.2) * 0.22) * 0.055 * strength;
}

// World-space height of the water surface drawn in top water block `by`
// at (x, z).
export function surfaceHeight(by, x, z, t, strength) {
  return by + WATER_SURFACE_HEIGHT + waveHeight(x, z, t, strength) - WAVE_SINK * strength;
}

// Whether point (x, y, z) is under the drawn water surface.
export function isUnderwater(world, x, y, z, t, strength) {
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);
  if (world.getBlock(bx, by, bz) !== BLOCK.WATER) return false;
  if (world.getBlock(bx, by + 1, bz) === BLOCK.WATER) return true; // deeper than the top block
  return y < surfaceHeight(by, x, z, t, strength);
}
