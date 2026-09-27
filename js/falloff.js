// How explosions fade with distance (pure functions, shared by the effects,
// the audio and the tests).

// Camera shake (0-1) from a blast of `radius` blocks `distance` blocks away:
// full strength near the blast, fading smoothly to nothing.
export function shakeFalloff(distance, radius) {
  const reach = radius * 6 + 20;
  const t = Math.max(0, 1 - distance / reach);
  return t * t * (3 - 2 * t); // smoothstep
}

// How an explosion `distance` blocks away sounds: overall gain, low-pass
// cutoff (Hz) and delay (s). Louder for bigger blasts (`size` 1 = grenade),
// fading smoothly and getting more muffled with distance, and arriving a
// little late (speed of sound).
export function explosionSound(distance, size = 1) {
  const s = Math.sqrt(size);
  const gain = (1.1 + 0.25 * size) / (1 + distance / (22 * s));
  const cutoff = Math.max(220, 18000 * Math.exp(-distance / (38 * s)));
  const delay = Math.min(distance / 343, 1.2);
  return { gain, cutoff, delay };
}
