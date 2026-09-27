// Render layers (THREE.Layers channels). On the High and Ultra presets the
// frame is drawn in two passes (see postfx.js): first the world, then the
// water, which reads the finished world image and depth behind it (for
// refraction, absorption and reflections), then transparent effects on top
// of both. On the other presets one pass draws all layers.
export const LAYER_WORLD = 0;
export const LAYER_WATER = 1;
export const LAYER_FX = 2;
