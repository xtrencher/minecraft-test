// Shaders for the world: one shared lighting/sky/fog model used by terrain,
// water, the sky dome and entities, so everything is lit and fogged the
// same way.
//
// Lighting model (per fragment, HDR linear):
//   direct   = sun (or moon) color * N.L * shadow map * (only where sky light is high)
//   ambient  = hemisphere sky color * f(voxel sky light)   -> dark caves, bright meadows
//   torch    = warm light color * f(voxel block light)     -> torches and glowing blocks
//   all scaled by per-vertex ambient occlusion
// The sky is an analytic gradient (zenith/horizon colors, a sunset glow
// band toward the sun, Mie-like halo) driven by uniforms from sky.js. Fog
// fades distant geometry into *that* sky color in the view direction, so
// terrain melts into the horizon, warmer toward a setting sun.
import * as THREE from "three";

// Shared uniform objects. Materials reference these same objects, so
// updating a value here updates every material at once.
export const worldUniforms = {
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  uLightDir: { value: new THREE.Vector3(0, 1, 0) },
  uLightColor: { value: new THREE.Color(1, 1, 1) },
  uSkyZenith: { value: new THREE.Color(0.2, 0.4, 1) },
  uSkyHorizon: { value: new THREE.Color(0.7, 0.8, 1) },
  uSkyGlow: { value: new THREE.Color(0, 0, 0) },
  uSunGlowColor: { value: new THREE.Color(1, 0.9, 0.7) },
  uAmbientSky: { value: new THREE.Color(0.5, 0.6, 0.8) },
  uAmbientGround: { value: new THREE.Color(0.3, 0.28, 0.25) },
  uTorchColor: { value: new THREE.Color(1.05, 0.62, 0.28) },
  uTime: { value: 0 },
  uNight: { value: 0 },
  uFog: { value: new THREE.Vector4(80, 150, 0.004, 0.0) }, // start, end, haze density, low mist
  uUnderwater: { value: 0 },
  uWaterFogColor: { value: new THREE.Color(0.02, 0.1, 0.16) },
  uWaveStrength: { value: 1 },
  uCaustics: { value: 1 },
};

export const WORLD_COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGlow;
uniform vec3 uSunGlowColor;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform vec3 uTorchColor;
uniform float uTime;
uniform float uNight;
uniform vec4 uFog;
uniform float uUnderwater;
uniform vec3 uWaterFogColor;
uniform float uWaveStrength;

// Sky radiance in direction dir (no sun disc, moon or stars).
vec3 skyColor(vec3 dir) {
  float h = dir.y;
  float up = max(h, 0.0);
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(up, 0.5));
  col = mix(col, uSkyHorizon * 0.55, clamp(-h * 2.5, 0.0, 1.0));
  float mu = dot(dir, uSunDir);
  float band = exp(-abs(h) * 5.0);
  float toward = pow(max(mu, 0.0), 2.0) * 0.75 + (mu * 0.5 + 0.5) * 0.25;
  col += uSkyGlow * band * toward;
  float sunUp = smoothstep(-0.12, 0.08, uSunDir.y);
  col += uSunGlowColor * (pow(max(mu, 0.0), 10.0) * 0.1 + pow(max(mu, 0.0), 150.0) * 0.45) * sunUp;
  return col;
}

// Fades a world-space point into the sky/haze (or underwater murk).
vec3 applyFog(vec3 color, vec3 worldPos) {
  vec3 d = worldPos - cameraPosition;
  float dist = length(d);
  if (uUnderwater > 0.5) {
    return mix(color, uWaterFogColor, 1.0 - exp(-dist * 0.085));
  }
  vec3 dir = d / max(dist, 0.001);
  float edge = smoothstep(uFog.x, uFog.y, dist);
  float haze = (1.0 - exp(-dist * uFog.z)) * 0.45;
  float mist = uFog.w * exp(-max(worldPos.y - 24.0, 0.0) * 0.14) * (1.0 - exp(-dist * 0.025));
  float f = 1.0 - (1.0 - edge) * (1.0 - haze) * (1.0 - clamp(mist, 0.0, 0.7));
  vec3 fogCol = skyColor(normalize(vec3(dir.x, max(dir.y, 0.0) * 0.35 + 0.02, dir.z)));
  return mix(color, fogCol, clamp(f, 0.0, 1.0));
}

// Converts a 0-1 light level to brightness (gentle falloff, like classic voxel lighting).
float skyCurve(float l) { return pow(l, 1.7); }
// Classic voxel-game light curve: bright near the source, falling off fast.
float torchCurve(float l) { return l / (4.0 - 3.0 * l); }

vec3 worldLighting(vec3 N, float sky, float blk, float ao, float shadow) {
  float ndl = max(dot(N, uLightDir), 0.0);
  float skyVis = smoothstep(0.55, 0.95, sky);
  vec3 direct = uLightColor * ndl * shadow * skyVis;
  vec3 hemi = mix(uAmbientGround, uAmbientSky, N.y * 0.5 + 0.5);
  float aoF = 0.32 + 0.68 * ao;
  vec3 indirect = hemi * skyCurve(sky) + uTorchColor * torchCurve(blk) + vec3(0.006, 0.007, 0.01);
  vec3 light = direct * (0.55 + 0.45 * aoF) + indirect * aoF;
  // Slight per-axis shading so walls in full shade still read as distinct faces.
  return light * (1.0 - abs(N.x) * 0.07);
}
`;

// Dynamic point lights (the Blast Orb glow and explosion flash) via three's
// own point-light uniforms; the light count never changes at runtime.
const POINT_LIGHTS = /* glsl */ `
#if NUM_POINT_LIGHTS > 0
vec3 pointLighting(vec3 N, vec3 viewPos) {
  vec3 sum = vec3(0.0);
  vec3 nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
    vec3 lv = pointLights[i].position - viewPos;
    float d = length(lv);
    float att = getDistanceAttenuation(d, pointLights[i].distance, pointLights[i].decay);
    sum += pointLights[i].color * att * max(dot(nv, lv / max(d, 1e-4)), 0.0);
  }
  return sum * RECIPROCAL_PI;
}
#endif
`;

const FRAGMENT_LIGHT_INCLUDES = /* glsl */ `
#include <common>
#include <packing>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
`;

// ---------------------------------------------------------------------------
// Terrain (opaque + cutout)
// ---------------------------------------------------------------------------

const chunkVertex = /* glsl */ `
attribute vec4 aData;  // normal*4+ao, sky*17, block*17, flags
attribute vec4 aExtra; // texture layer, water depth*16
varying vec3 vTexCoord;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vLight;
varying float vAo;
flat varying float vFlags;
varying vec3 vViewPosition;
uniform float uTime;
uniform float uWaveStrength;
#include <common>
#include <shadowmap_pars_vertex>

const vec3 FACE_NORMALS[6] = vec3[6](
  vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0),
  vec3(0.0, -1.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));

vec3 windOffset(vec3 p) {
  float t = uTime;
  float w = sin(t * 1.6 + p.x * 0.55 + p.z * 0.4) * 0.5
          + sin(t * 2.4 + p.x * 0.3 - p.z * 0.7) * 0.35
          + sin(t * 5.3 + p.x * 1.7 + p.z * 1.3) * 0.15;
  return vec3(w, w * 0.2, w * 0.6) * 0.075 * uWaveStrength;
}

void main() {
  float packedNA = aData.x;
  int ni = int(packedNA * 0.25 + 0.01);
  float ao = packedNA - float(ni) * 4.0;
  int flags = int(aData.w + 0.5);
  vec3 objectNormal = FACE_NORMALS[ni];
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  if ((flags & 1) != 0) worldPosition.xyz += windOffset(worldPosition.xyz);
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  vec3 transformedNormal = normalMatrix * objectNormal;
  #include <shadowmap_vertex>
  vTexCoord = vec3(uv, aExtra.x);
  vWorldPos = worldPosition.xyz;
  vNormal = objectNormal;
  vLight = aData.yz / 255.0;
  vAo = ao / 3.0;
  vFlags = aData.w;
  vViewPosition = -mvPosition.xyz;
}
`;

const chunkFragment = /* glsl */ `
uniform highp sampler2DArray uAtlas;
uniform float uEmissiveBoost;
uniform float uCaustics;
varying vec3 vTexCoord;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vLight;
varying float vAo;
flat varying float vFlags;
varying vec3 vViewPosition;
${FRAGMENT_LIGHT_INCLUDES}
${WORLD_COMMON}
${POINT_LIGHTS}

// Animated caustic network (thin bright lines), for surfaces under water.
// Domain-warped sine interference; bounded to [0, 1] by construction.
float caustics(vec2 p, float t) {
  vec2 q = p;
  for (int n = 0; n < 3; n++) {
    float fn = float(n);
    q += vec2(sin(q.y * 1.3 + t * 0.9 + fn), cos(q.x * 1.1 - t * 0.8 + fn * 1.7)) * 0.45;
  }
  float v = sin(q.x * 2.0) * sin(q.y * 2.0);
  return pow(1.0 - abs(v), 12.0);
}

void main() {
  vec4 tex = texture(uAtlas, vTexCoord);
  #ifdef CUTOUT
    // Thin cutout textures (grass, leaves) would dissolve at a distance as
    // mipmapping averages their alpha down; boost alpha with the mip level.
    vec2 tdx = dFdx(vTexCoord.xy * 32.0);
    vec2 tdy = dFdy(vTexCoord.xy * 32.0);
    float lod = 0.5 * log2(max(dot(tdx, tdx), dot(tdy, tdy)));
    tex.a *= 1.0 + max(lod, 0.0) * 0.3;
    if (tex.a < 0.5) discard;
  #endif
  vec3 albedo = tex.rgb;
  vec3 N = vNormal;
  float shadow = getShadowMask();
  vec3 light = worldLighting(N, vLight.x, vLight.y, vAo, shadow);
  #if NUM_POINT_LIGHTS > 0
    light += pointLighting(N, -vViewPosition);
  #endif
  vec3 color = albedo * light;
  int flags = int(vFlags + 0.5);
  if ((flags & 2) != 0) {
    // Glowing blocks: their bright texels emit light (HDR, picked up by bloom).
    float lum = max(albedo.r, max(albedo.g, albedo.b));
    color = mix(color, albedo * uEmissiveBoost, smoothstep(0.3, 0.85, lum));
  }
  if ((flags & 8) != 0 && uCaustics > 0.0) {
    float c = caustics(vWorldPos.xz * 0.6 + vWorldPos.y * 0.2, uTime * 0.7);
    color += albedo * uLightColor * c * shadow * 0.35 * uCaustics * smoothstep(0.2, 0.7, vLight.x);
  }
  color = applyFog(color, vWorldPos);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Shadow-map depth for cutout geometry: alpha-tested (so leaves and grass
// cast lacy shadows, not solid squares) and waving like the visible mesh.
const cutoutDepthVertex = /* glsl */ `
attribute vec4 aData;
attribute vec4 aExtra;
varying vec3 vTexCoord;
uniform float uTime;
uniform float uWaveStrength;
#include <common>
vec3 windOffset(vec3 p) {
  float t = uTime;
  float w = sin(t * 1.6 + p.x * 0.55 + p.z * 0.4) * 0.5
          + sin(t * 2.4 + p.x * 0.3 - p.z * 0.7) * 0.35
          + sin(t * 5.3 + p.x * 1.7 + p.z * 1.3) * 0.15;
  return vec3(w, w * 0.2, w * 0.6) * 0.075 * uWaveStrength;
}
void main() {
  int flags = int(aData.w + 0.5);
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  if ((flags & 1) != 0) worldPosition.xyz += windOffset(worldPosition.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vTexCoord = vec3(uv, aExtra.x);
}
`;

const cutoutDepthFragment = /* glsl */ `
uniform highp sampler2DArray uAtlas;
varying vec3 vTexCoord;
#include <common>
#include <packing>
void main() {
  if (texture(uAtlas, vTexCoord).a < 0.5) discard;
  gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
}
`;

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

const waterVertex = /* glsl */ `
attribute vec4 aData;
attribute vec4 aExtra;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vLight;
varying float vDepth;
varying vec3 vViewPosition;
varying vec2 vUv;
uniform float uTime;
uniform float uWaveStrength;
#include <common>
#include <shadowmap_pars_vertex>

const vec3 FACE_NORMALS[6] = vec3[6](
  vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0),
  vec3(0.0, -1.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));

float waveHeight(vec2 p, float t) {
  return (sin(p.x * 0.8 + t * 1.3) * 0.5 + sin(p.y * 0.65 - t * 1.05) * 0.5
        + sin((p.x + p.y) * 1.7 + t * 2.2) * 0.22) * 0.055 * uWaveStrength;
}

void main() {
  float packedNA = aData.x;
  int ni = int(packedNA * 0.25 + 0.01);
  int flags = int(aData.w + 0.5);
  vec3 objectNormal = FACE_NORMALS[ni];
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  if ((flags & 4) != 0) worldPosition.y += waveHeight(worldPosition.xz, uTime) - 0.06 * uWaveStrength;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  vec3 transformedNormal = normalMatrix * objectNormal;
  #include <shadowmap_vertex>
  vWorldPos = worldPosition.xyz;
  vNormal = objectNormal;
  vLight = aData.yz / 255.0;
  vDepth = aExtra.y / 16.0;
  vViewPosition = -mvPosition.xyz;
  vUv = uv;
}
`;

const waterFragment = /* glsl */ `
uniform highp sampler2DArray uAtlas;
uniform float uWaterLayer;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vLight;
varying float vDepth;
varying vec3 vViewPosition;
varying vec2 vUv;
${FRAGMENT_LIGHT_INCLUDES}
${WORLD_COMMON}
${POINT_LIGHTS}

// Surface normal from a sum of travelling waves (analytic derivatives)
// plus fine ripples from the water texture.
vec3 waterNormal(vec2 p, float t) {
  float s = 0.055 * uWaveStrength;
  vec2 g = vec2(0.0);
  g.x += cos(p.x * 0.8 + t * 1.3) * 0.8 * 0.5;
  g.y += cos(p.y * 0.65 - t * 1.05) * 0.65 * 0.5;
  float c3 = cos((p.x + p.y) * 1.7 + t * 2.2) * 1.7 * 0.22;
  g += vec2(c3);
  g *= s;
  // Small ripples in two directions.
  vec2 r = vec2(
    sin(p.x * 3.1 + p.y * 1.3 + t * 3.0) + sin(p.x * 5.3 - p.y * 2.9 - t * 4.1) * 0.5,
    sin(p.y * 3.4 - p.x * 1.1 + t * 2.6) + sin(p.y * 6.1 + p.x * 2.3 + t * 3.7) * 0.5);
  g += r * 0.02 * uWaveStrength;
  return normalize(vec3(-g.x, 1.0, -g.y));
}

void main() {
  bool top = vNormal.y > 0.5;
  vec3 N = top ? waterNormal(vWorldPos.xz, uTime) : vNormal;
  vec3 V = normalize(cameraPosition - vWorldPos);
  bool fromBelow = dot(V, vNormal) < 0.0;
  if (fromBelow) N = -N;
  float shadow = getShadowMask();
  float skyL = vLight.x;
  float blkL = vLight.y;
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 lightAmt = worldLighting(vec3(0.0, 1.0, 0.0), skyL, blkL, 1.0, shadow);
  #if NUM_POINT_LIGHTS > 0
    lightAmt += pointLighting(vec3(0.0, 1.0, 0.0), -vViewPosition);
  #endif

  // What you see into the water: bluer and darker the deeper it is.
  float depth = max(vDepth, 0.05);
  float deepness = 1.0 - exp(-depth * 0.42);
  vec3 body = mix(vec3(0.07, 0.36, 0.40), vec3(0.015, 0.08, 0.2), deepness) * lightAmt;
  float tex = texture(uAtlas, vec3(vWorldPos.xz * 0.25 + uTime * 0.02, uWaterLayer)).b;
  body *= 0.85 + tex * 0.3;
  float alpha = mix(0.5, 0.93, deepness);

  vec3 color;
  if (fromBelow) {
    // Looking up at the surface from under water: a bright, watery window.
    color = mix(uWaterFogColor * 2.0, skyColor(vec3(0.0, 1.0, 0.0)) * 0.6, 0.35) * max(skyCurve(skyL), 0.15);
    alpha = 0.8;
  } else {
    // Reflection of the sky (dimmed where the water is shaded from the sky)
    // plus a sharp glint of the sun.
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 refl = skyColor(R) * mix(0.2, 1.0, smoothstep(0.35, 0.9, skyL));
    float rs = max(dot(R, uLightDir), 0.0);
    float spec = pow(rs, 400.0) * 7.0 + pow(rs, 60.0) * 0.35;
    refl += uLightColor * spec * shadow * smoothstep(0.5, 0.95, skyL);
    color = mix(body, refl, fresnel);
    alpha = mix(alpha, 1.0, fresnel);
    // Foam where the water meets the shore.
    if (top) {
      float n = sin(vWorldPos.x * 3.7 + uTime * 1.7) * sin(vWorldPos.z * 3.1 - uTime * 1.3);
      float foam = (1.0 - smoothstep(0.0, 0.55, vDepth)) * (0.55 + 0.45 * n);
      color += vec3(0.85) * foam * 0.4 * lightAmt;
      alpha = clamp(alpha + foam * 0.35, 0.0, 1.0);
    }
  }
  color = applyFog(color, vWorldPos);
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Sky dome
// ---------------------------------------------------------------------------

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const skyFragment = /* glsl */ `
varying vec3 vDir;
uniform float uCloudCoverage;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uCloudHeight;
uniform float uStarAngle;
uniform float uWriteSkyMask; // 1: alpha = sky mask (post-processing), 0: opaque alpha (drawing to the screen)
${WORLD_COMMON}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float cloudFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < CLOUD_OCTAVES; i++) {
    s += vnoise(p) * a;
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s / (1.0 - pow(0.5, float(CLOUD_OCTAVES)));
}

float stars(vec3 dir) {
  // Stars turn with the sky.
  float c = cos(uStarAngle);
  float s = sin(uStarAngle);
  vec3 d = vec3(c * dir.x - s * dir.y, s * dir.x + c * dir.y, dir.z);
  vec3 p = d * 170.0;
  vec3 cell = floor(p);
  float h = hash13(cell);
  if (h < 0.991) return 0.0;
  vec3 offs = vec3(hash13(cell + 1.7), hash13(cell + 5.3), hash13(cell + 9.1)) - 0.5;
  float dist = length(fract(p) - 0.5 - offs * 0.5);
  float brightness = (h - 0.991) / 0.009;
  float twinkle = 0.75 + 0.25 * sin(uTime * (1.5 + h * 4.0) + h * 91.0);
  return smoothstep(0.22, 0.0, dist) * (0.4 + brightness * 1.6) * twinkle;
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyColor(dir);
  float horizonFade = smoothstep(-0.02, 0.03, dir.y);

  // Moon: a cratered disc with a soft halo.
  float mm = dot(dir, uMoonDir);
  float moonUp = smoothstep(-0.05, 0.05, uMoonDir.y);
  float moonDisc = smoothstep(0.99935, 0.9996, mm);
  vec3 md = dir - uMoonDir * mm;
  float crater = vnoise(md.xy * 900.0 + md.z * 300.0) * 0.5 + vnoise(md.yz * 2200.0) * 0.5;
  vec3 moonCol = vec3(1.0, 1.02, 1.08) * (0.55 + 0.45 * crater) * 2.2;

  // Stars fade in as the sky darkens.
  float starAmt = uNight * horizonFade * (1.0 - moonDisc);
  col += vec3(0.9, 0.95, 1.1) * stars(dir) * starAmt;

  col = mix(col, moonCol, moonDisc * moonUp * horizonFade);
  col += vec3(0.08, 0.1, 0.16) * pow(max(mm, 0.0), 400.0) * moonUp * 2.0;

  // Sun disc (very bright: bloom turns it into a glowing ball).
  float mu = dot(dir, uSunDir);
  float sunDisc = smoothstep(0.99955, 0.99972, mu);
  col += uSunGlowColor * sunDisc * 45.0 * horizonFade * smoothstep(-0.1, 0.02, uSunDir.y);

  // Clouds: a layer of soft fbm clouds at uCloudHeight, lit from the sun side.
  float cloudA = 0.0;
  #if CLOUD_OCTAVES > 0
  if (dir.y > 0.005) {
    float t = (uCloudHeight - cameraPosition.y) / dir.y;
    vec2 p = cameraPosition.xz + dir.xz * t;
    vec2 q = p * 0.0028 + vec2(uTime * 0.006, uTime * 0.0021);
    float n = cloudFbm(q);
    float cover = smoothstep(1.0 - uCloudCoverage, 1.0 - uCloudCoverage + 0.28, n);
    float n2 = cloudFbm(q + normalize(uSunDir.xz + 1e-4) * 0.035);
    float lit = clamp(0.55 + (n - n2) * 4.0, 0.0, 1.0);
    vec3 cloudCol = mix(uCloudShade, uCloudLit, lit);
    // Silver lining near the sun.
    cloudCol += uSunGlowColor * pow(max(mu, 0.0), 12.0) * 0.6 * (1.0 - cover);
    float fade = smoothstep(0.005, 0.25, dir.y);
    cloudA = cover * fade * 0.94;
    col = mix(col, cloudCol, cloudA);
  }
  #endif

  if (uUnderwater > 0.5) {
    // Seen from under water, the sky is just a brighter patch of murk above.
    col = uWaterFogColor * (1.0 + 2.5 * smoothstep(-0.1, 0.9, dir.y));
    cloudA = 1.0;
  }
  // Alpha marks sky visibility for the light-shaft pass (0 = open sky). When
  // drawing straight to the canvas it must stay opaque: three.js creates the
  // WebGL context with an alpha channel, so alpha 0 would make the page show
  // through.
  gl_FragColor = vec4(col, mix(1.0, cloudA, uWriteSkyMask));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Material factories
// ---------------------------------------------------------------------------

function litUniforms(extra) {
  return { ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights), ...worldUniforms, ...extra };
}

export function createChunkMaterials(atlas, waterLayer) {
  const opaque = new THREE.ShaderMaterial({
    uniforms: litUniforms({ uAtlas: { value: atlas }, uEmissiveBoost: { value: 4.0 } }),
    vertexShader: chunkVertex,
    fragmentShader: chunkFragment,
    lights: true,
  });
  const cutout = new THREE.ShaderMaterial({
    uniforms: litUniforms({ uAtlas: { value: atlas }, uEmissiveBoost: { value: 4.0 } }),
    vertexShader: chunkVertex,
    fragmentShader: chunkFragment,
    lights: true,
    side: THREE.DoubleSide,
    defines: { CUTOUT: "" },
  });
  const water = new THREE.ShaderMaterial({
    uniforms: litUniforms({ uAtlas: { value: atlas }, uWaterLayer: { value: waterLayer } }),
    vertexShader: waterVertex,
    fragmentShader: waterFragment,
    lights: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const cutoutDepth = new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uTime: worldUniforms.uTime, uWaveStrength: worldUniforms.uWaveStrength },
    vertexShader: cutoutDepthVertex,
    fragmentShader: cutoutDepthFragment,
    side: THREE.DoubleSide,
  });
  // Emissive blocks share the materials above; `uEmissiveBoost` is kept in
  // sync across both terrain materials by sky/graphics code.
  return { opaque, cutout, water, cutoutDepth };
}

export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...worldUniforms,
      uCloudCoverage: { value: 0.4 },
      uCloudLit: { value: new THREE.Color(1, 1, 1) },
      uCloudShade: { value: new THREE.Color(0.6, 0.65, 0.75) },
      uCloudHeight: { value: 150 },
      uStarAngle: { value: 0 },
      uWriteSkyMask: { value: 1 },
    },
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    defines: { CLOUD_OCTAVES: 4 },
  });
}
