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
  // Sun shadows (see SUN_SHADOW): filter radius in shadow-map texels for
  // cascades 0-2, and the blocker-search radius for cascade 0 (w);
  // penumbra texels per unit of depth difference (contact-hardening soft
  // shadows); quality 1 = 6 taps, 2 = 12 taps, 3 = soft penumbrae (PCSS).
  uCascadeSoft: { value: new THREE.Vector4(1, 1, 1, 8) },
  uPcssScale: { value: 0 },
  uShadowQuality: { value: 1 },
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

// How much the shadow map can be trusted here: 1 well inside the shadow
// camera's frustum, fading to 0 at its edges and beyond (and 0 when there
// are no shadow maps at all, as on the Low preset).
float shadowCoverage() {
  #if defined(WORLD_LIT) && defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    // The largest (last) cascade reaches farthest.
    vec4 sc = vDirectionalShadowCoord[NUM_DIR_LIGHT_SHADOWS - 1];
    vec3 c = sc.xyz / sc.w;
    vec2 e = min(c.xy, 1.0 - c.xy);
    return smoothstep(0.0, 0.06, min(e.x, e.y)) * step(c.z, 1.0);
  #else
    return 0.0;
  #endif
}

// How much direct sun (or moon) light reaches a surface. The shadow map
// decides where it covers the scene; beyond it, the voxel sky light stands
// in, so distant caves and overhangs stay dark.
float sunVisibility(float sky, float shadow) {
  float skyVis = smoothstep(0.55, 0.95, clamp(sky, 0.0, 1.0));
  return mix(skyVis, shadow, shadowCoverage());
}

// sky / blk: voxel sky and block light (0-1) at the surface; ao: ambient
// occlusion (0 = fully occluded corner, 1 = open); shadow: the shadow map.
vec3 worldLighting(vec3 N, float sky, float blk, float ao, float shadow) {
  // Interpolated light values can overshoot their 0-1 range (MSAA shades
  // edge pixels outside thin triangles): clamp, or pow() and the torch
  // curve turn them into NaN / infinity.
  sky = clamp(sky, 0.0, 1.0);
  blk = clamp(blk, 0.0, 1.0);
  ao = clamp(ao, 0.0, 1.0);
  float ndl = max(dot(N, uLightDir), 0.0);
  // Ambient occlusion only darkens ambient light: in sunlight, a corner
  // isn't darker, it's only darker in the shade.
  vec3 direct = uLightColor * ndl * sunVisibility(sky, shadow);
  vec3 hemi = mix(uAmbientGround, uAmbientSky, N.y * 0.5 + 0.5);
  float aoF = 0.32 + 0.68 * ao;
  vec3 indirect = (hemi * skyCurve(sky) + uTorchColor * torchCurve(blk) + vec3(0.006, 0.007, 0.01)) * aoF;
  // Slight per-axis shading so walls in full shade still read as distinct faces.
  return (direct + indirect) * (1.0 - abs(N.x) * 0.07);
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

// Cascaded sun shadows. The sun has up to three shadow maps of growing
// size around the player (graphics.js / sky.js); each fragment uses the
// finest one that covers it, blending into the next near its edge. Edges
// are filtered over a rotated Poisson disc; on the soft quality, the
// finest cascade first searches for the occluder and widens the filter
// with its distance (percentage-closer soft shadows), so a shadow is crisp
// where an object meets the ground and soft farther away.
const SUN_SHADOW = /* glsl */ `
uniform vec4 uCascadeSoft;
uniform float uPcssScale;
uniform float uShadowQuality;
#if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
const vec2 POISSON16[16] = vec2[16](
  vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725), vec2(-0.09418410, -0.92938870), vec2(0.34495938, 0.29387760),
  vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464), vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
  vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420), vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
  vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590), vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790));

float shadowDepth(sampler2D map, vec2 uv) {
  return unpackRGBAToDepth(texture2D(map, uv));
}

mat2 shadowRotation() {
  // Interleaved gradient noise: a different disc rotation per pixel turns
  // banding into fine grain.
  float a = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

float shadowPCF(sampler2D map, vec2 texel, vec3 c, float radius, mat2 rot) {
  int taps = uShadowQuality > 1.5 ? (uShadowQuality > 2.5 ? 16 : 12) : 6;
  float lit = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= taps) break;
    lit += step(c.z, shadowDepth(map, c.xy + rot * POISSON16[i] * radius * texel));
  }
  return lit / float(taps);
}

float shadowSoft(sampler2D map, vec2 texel, vec3 c, mat2 rot) {
  float search = uCascadeSoft.w;
  float sum = 0.0;
  float n = 0.0;
  for (int i = 0; i < 16; i++) {
    float d = shadowDepth(map, c.xy + rot * POISSON16[i] * search * texel);
    if (d < c.z) {
      sum += d;
      n += 1.0;
    }
  }
  if (n < 0.5) return 1.0;
  float radius = clamp((c.z - sum / n) * uPcssScale, uCascadeSoft.x, search);
  return shadowPCF(map, texel, c, radius, rot);
}

// 1 well inside cascade i's map, fading to 0 at its edges.
float cascadeFade(vec3 c) {
  vec2 e = min(c.xy, 1.0 - c.xy);
  return smoothstep(0.0, 0.07, min(e.x, e.y)) * step(c.z, 1.0);
}

#define SUN_CASCADE(i, soft) { \
  vec4 sc = vDirectionalShadowCoord[i]; \
  vec3 c = sc.xyz / sc.w; \
  c.z += directionalLightShadows[i].shadowBias; \
  float f = cascadeFade(c) * weight; \
  if (f > 0.0) { \
    vec2 texel = 1.0 / directionalLightShadows[i].shadowMapSize; \
    float s = (soft) ? shadowSoft(directionalShadowMap[i], texel, c, rot) : shadowPCF(directionalShadowMap[i], texel, c, uCascadeSoft[i], rot); \
    result += s * f; \
    weight -= f; \
  } \
}

float sunShadow() {
  mat2 rot = shadowRotation();
  float result = 0.0;
  float weight = 1.0; // not yet covered by a finer cascade
  SUN_CASCADE(0, uShadowQuality > 2.5)
  #if NUM_DIR_LIGHT_SHADOWS > 1
    if (weight > 0.0) SUN_CASCADE(1, false)
  #endif
  #if NUM_DIR_LIGHT_SHADOWS > 2
    if (weight > 0.0) SUN_CASCADE(2, false)
  #endif
  // Beyond every cascade: lit here; worldLighting falls back to the voxel
  // sky light there (shadowCoverage).
  return result + weight;
}
#else
float sunShadow() { return 1.0; }
#endif
`;

const FRAGMENT_LIGHT_INCLUDES = /* glsl */ `
#define WORLD_LIT
#include <common>
#include <packing>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
${SUN_SHADOW}
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
centroid varying vec2 vLight;
centroid varying float vAo;
flat varying float vFlags;
flat varying float vFace;
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
  vFace = float(ni);
  vViewPosition = -mvPosition.xyz;
}
`;

const chunkFragment = /* glsl */ `
uniform highp sampler2DArray uAtlas;
uniform highp sampler2DArray uRelief;
uniform float uEmissiveBoost;
uniform float uCaustics;
varying vec3 vTexCoord;
varying vec3 vWorldPos;
varying vec3 vNormal;
centroid varying vec2 vLight;
centroid varying float vAo;
flat varying float vFlags;
flat varying float vFace;
varying vec3 vViewPosition;
${FRAGMENT_LIGHT_INCLUDES}
${WORLD_COMMON}
${POINT_LIGHTS}

#ifdef USE_NORMALMAP
// Directions of increasing u and v on each face (see mesher.js FACE_DEFS),
// so the relief map's tangent-space normals turn into world normals.
const vec3 FACE_T[6] = vec3[6](vec3(0.0, 0.0, -1.0), vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0),
  vec3(1.0, 0.0, 0.0), vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0));
const vec3 FACE_B[6] = vec3[6](vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, -1.0),
  vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0));

// Parallax occlusion mapping: steps into the height field along the view
// ray (tangent space, vts) and returns where it enters the surface.
vec2 parallaxUv(vec3 uvw, vec3 vts, float depthScale) {
  float steps = mix(28.0, 10.0, clamp(vts.z, 0.0, 1.0));
  float layer = 1.0 / steps;
  vec2 delta = vts.xy / max(vts.z, 0.2) * depthScale * layer;
  vec2 uv = uvw.xy;
  float cur = 0.0;
  float depth = 1.0 - textureLod(uRelief, vec3(uv, uvw.z), 0.0).b;
  for (int i = 0; i < 28; i++) {
    if (float(i) >= steps || cur >= depth) break;
    uv -= delta;
    cur += layer;
    depth = 1.0 - textureLod(uRelief, vec3(uv, uvw.z), 0.0).b;
  }
  // Refine between the last two steps.
  vec2 prev = uv + delta;
  float after = depth - cur;
  float before = (1.0 - textureLod(uRelief, vec3(prev, uvw.z), 0.0).b) - (cur - layer);
  float w = clamp(after / (after - before + 1e-5), 0.0, 1.0);
  return mix(uv, prev, w);
}
#endif

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
  vec3 uvw = vTexCoord;
  vec3 N = vNormal;
  float dist = length(vViewPosition);
  int flags = int(vFlags + 0.5);
  #ifdef USE_NORMALMAP
    int fi = int(vFace + 0.5);
    vec3 T = FACE_T[fi];
    vec3 B = FACE_B[fi];
    vec3 V = normalize(cameraPosition - vWorldPos);
    #if defined(USE_POM) && !defined(CUTOUT)
      // Up close, pixels get real depth; faded out with distance.
      float pomFade = 1.0 - smoothstep(10.0, 20.0, dist);
      if (pomFade > 0.0) uvw.xy = parallaxUv(uvw, vec3(dot(V, T), dot(V, B), dot(V, N)), 0.065 * pomFade);
    #endif
  #endif
  vec4 tex = texture(uAtlas, uvw);
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
  float shadow = sunShadow();
  #ifdef USE_NORMALMAP
    // Per-pixel relief: bumps catch and lose the light, with a specular
    // highlight whose sharpness follows the material's roughness.
    vec4 relief = texture(uRelief, uvw);
    vec2 nxy = (relief.xy * 2.0 - 1.0) * (1.0 - smoothstep(24.0, 56.0, dist));
    vec3 nts = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
    N = normalize(T * nts.x + B * nts.y + vNormal * nts.z);
  #endif
  vec3 light = worldLighting(N, vLight.x, vLight.y, vAo, shadow);
  #if NUM_POINT_LIGHTS > 0
    light += pointLighting(N, -vViewPosition);
  #endif
  vec3 color = albedo * light;
  #ifdef USE_NORMALMAP
    float rough = max(relief.a, 0.08);
    vec3 H = normalize(uLightDir + V);
    float ndh = max(dot(N, H), 0.0);
    float a2 = rough * rough * rough * rough;
    float dd = ndh * ndh * (a2 - 1.0) + 1.0;
    float lh = max(dot(uLightDir, H), 0.1);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    float spec = a2 / (3.14159 * dd * dd) * fres / (4.0 * lh * lh);
    color += uLightColor * spec * max(dot(N, uLightDir), 0.0) * sunVisibility(vLight.x, shadow) * dot(albedo, vec3(0.3, 0.5, 0.2)) * 2.0;
  #endif
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
centroid varying vec2 vLight;
centroid varying float vDepth;
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
  // Keep in sync with js/water.js (surfaceHeight).
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
centroid varying vec2 vLight;
centroid varying float vDepth;
varying vec3 vViewPosition;
varying vec2 vUv;
#ifdef WATER_SCREEN
  // The finished world image and depth behind the water (see postfx.js).
  uniform sampler2D tSceneColor;
  uniform sampler2D tSceneDepth;
  uniform vec2 uScreenSize;
  uniform float uCamNear;
  uniform float uCamFar;
  uniform mat4 uProjection; // three only declares projectionMatrix in vertex shaders
#endif
${FRAGMENT_LIGHT_INCLUDES}
${WORLD_COMMON}
${POINT_LIGHTS}

#ifdef WATER_SCREEN
// Distance along the view axis of a depth-buffer value.
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uCamNear * uCamFar / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
}

vec2 toScreen(vec3 viewPos) {
  vec4 c = uProjection * vec4(viewPos, 1.0);
  return c.xy / c.w * 0.5 + 0.5;
}

#ifdef WATER_SSR
// Screen-space reflection: marches the reflected ray (view space) through
// the depth buffer, refines the first crossing, and returns the color there
// (rgb) with how far to trust it (a: fades at the screen edges and with
// ray length; 0 for a miss).
vec4 traceReflection(vec3 origin, vec3 dir) {
  float stepLen = 0.3;
  vec3 p = origin;
  for (int i = 0; i < 48; i++) {
    vec3 prev = p;
    p += dir * stepLen;
    stepLen *= 1.09;
    if (-p.z < uCamNear) break;
    vec2 uv = toScreen(p);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float sceneZ = linearDepth(texture2D(tSceneDepth, uv).r);
    float rayZ = -p.z;
    if (rayZ > sceneZ && rayZ - sceneZ < stepLen * 1.5 + 0.35) {
      vec3 a = prev;
      vec3 b = p;
      for (int k = 0; k < 5; k++) {
        vec3 m = (a + b) * 0.5;
        if (-m.z > linearDepth(texture2D(tSceneDepth, toScreen(m)).r)) b = m;
        else a = m;
      }
      vec2 huv = toScreen(b);
      vec2 edge = min(huv, 1.0 - huv);
      float trust = smoothstep(0.0, 0.1, min(edge.x, edge.y)) * (1.0 - smoothstep(24.0, 48.0, float(i)));
      return vec4(texture2D(tSceneColor, huv).rgb, trust);
    }
  }
  return vec4(0.0);
}
#endif
#endif

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
  // Seen from below exactly when the camera is under the drawn surface
  // (decided once per frame on the CPU with the same wave function), not
  // per fragment: near the waterline, wave crests rise above the eye, and a
  // per-fragment test drew them as bands of "underside" water.
  bool fromBelow = uUnderwater > 0.5;
  if (fromBelow) N = -N;
  float shadow = sunShadow();
  float skyL = vLight.x;
  float blkL = vLight.y;
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 lightAmt = worldLighting(vec3(0.0, 1.0, 0.0), skyL, blkL, 1.0, shadow);
  #if NUM_POINT_LIGHTS > 0
    lightAmt += pointLighting(vec3(0.0, 1.0, 0.0), -vViewPosition);
  #endif

  #ifdef WATER_SCREEN
  {
    // Physically based-ish water over the finished world image: what's
    // behind is bent by the waves, absorbed by the water on its way to the
    // eye (red first, so shallows are clear turquoise and depths blue), plus
    // the water's own scattered light; reflections come from the image
    // itself (Ultra) or the sky; foam where the water gets shallow.
    vec2 suv = gl_FragCoord.xy / uScreenSize;
    float surfZ = vViewPosition.z;
    vec3 color;
    if (fromBelow) {
      // From under water: the world above shows through Snell's window;
      // outside it the surface mirrors the water below (total internal reflection).
      vec3 above = texture2D(tSceneColor, clamp(suv + N.xz * 0.04, 0.001, 0.999)).rgb;
      vec3 mirror = uWaterFogColor * 2.0 * max(skyCurve(skyL), 0.15);
      color = mix(mirror, above * vec3(0.75, 0.9, 0.95), smoothstep(0.3, 0.55, ndv));
    } else {
      vec2 ruv = clamp(suv + clamp(N.xz * 0.35 / max(surfZ, 0.5), -0.05, 0.05), 0.001, 0.999);
      float floorZ = linearDepth(texture2D(tSceneDepth, ruv).r);
      if (floorZ < surfZ) {
        // Something in front of the water there: don't borrow its pixels.
        ruv = suv;
        floorZ = linearDepth(texture2D(tSceneDepth, suv).r);
      }
      vec3 behind = texture2D(tSceneColor, ruv).rgb;
      if (any(isnan(behind)) || any(isinf(behind))) behind = vec3(0.0);
      float pathLen = max(floorZ - surfZ, 0.0) * length(vViewPosition) / max(surfZ, 1e-3);
      vec3 T = exp(-vec3(0.46, 0.11, 0.07) * pathLen);
      vec3 scatter = vec3(0.012, 0.075, 0.13) * lightAmt;
      vec3 under = behind * T + scatter * (1.0 - T);

      vec3 R = reflect(-V, N);
      vec3 Rs = vec3(R.x, abs(R.y), R.z);
      vec3 refl = skyColor(Rs) * mix(0.2, 1.0, smoothstep(0.35, 0.9, skyL));
      #ifdef WATER_SSR
        vec4 ssr = traceReflection(-vViewPosition, normalize((viewMatrix * vec4(R, 0.0)).xyz));
        refl = mix(refl, ssr.rgb, ssr.a);
      #endif
      float rs = max(dot(Rs, uLightDir), 0.0);
      refl += uLightColor * (pow(rs, 400.0) * 7.0 + pow(rs, 60.0) * 0.35) * shadow * smoothstep(0.5, 0.95, skyL);
      color = mix(under, refl, fresnel);
      if (top) {
        // Foam along shores and around anything standing in the water.
        float vdepth = pathLen * max(V.y, 0.05);
        float n = sin(vWorldPos.x * 3.7 + uTime * 1.7) * sin(vWorldPos.z * 3.1 - uTime * 1.3);
        float foam = (1.0 - smoothstep(0.0, 0.45, vdepth)) * (0.55 + 0.45 * n);
        color += vec3(0.85) * foam * 0.4 * lightAmt;
      }
    }
    color = applyFog(color, vWorldPos);
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
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
// Grass blades (see grass.js)
// ---------------------------------------------------------------------------
// Instanced tufts of thin blades standing on grass blocks near the player,
// lit like the terrain (voxel light at the block, sun shadows), with light
// shining through the blades when you look toward the sun.

const grassVertex = /* glsl */ `
attribute float aTip;       // 0 at a blade's base, 1 at its tip
attribute vec3 aBladeNormal;
attribute vec3 iOffset;     // tuft position (top of the grass block)
attribute vec3 iRotScaleTint;
attribute vec2 iLight;      // sky, block light above the block (0-1)
uniform vec3 uPlayer;       // the player's feet
uniform float uRadius;
uniform float uTime;
uniform float uWaveStrength;
varying float vTip;
varying vec2 vLight;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vTint;
#include <common>
#include <shadowmap_pars_vertex>
void main() {
  float c = cos(iRotScaleTint.x);
  float s = sin(iRotScaleTint.x);
  mat2 rot = mat2(c, s, -s, c);
  vec3 p = position;
  p.xz = rot * p.xz;
  // Shrink away toward the edge of the field, so tufts never pop in or out.
  float d = distance(iOffset.xz, uPlayer.xz);
  float fade = 1.0 - smoothstep(uRadius * 0.65, uRadius, d);
  p.y *= iRotScaleTint.y * fade;
  vec3 wp = iOffset + p;
  // Wind: layered gusts, strongest at the tips.
  float t = uTime;
  float w = sin(t * 1.7 + wp.x * 0.6 + wp.z * 0.45) * 0.5 + sin(t * 2.9 + wp.x * 0.25 - wp.z * 0.8) * 0.3
          + sin(t * 6.3 + wp.x * 1.9 + wp.z * 1.4) * 0.12;
  wp.xz += vec2(w, w * 0.6) * 0.1 * aTip * aTip * uWaveStrength;
  // Blades bend away from the player's feet.
  vec2 away = wp.xz - uPlayer.xz;
  float near = (1.0 - smoothstep(0.25, 1.0, length(away))) * (1.0 - smoothstep(0.4, 1.4, abs(iOffset.y - uPlayer.y)));
  wp.xz += normalize(away + vec2(1e-4)) * near * 0.3 * aTip;
  wp.y -= near * 0.12 * aTip;
  vec4 worldPosition = vec4(wp, 1.0);
  vec3 n = normalize(vec3((rot * aBladeNormal.xz) * 0.4, 1.0));
  vec3 transformedNormal = (viewMatrix * vec4(n, 0.0)).xyz;
  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vTip = aTip;
  vLight = iLight;
  vWorldPos = wp;
  vNormal = n;
  vTint = iRotScaleTint.z;
}
`;

const grassFragment = /* glsl */ `
uniform vec3 uGrassColor;
varying float vTip;
varying vec2 vLight;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vTint;
${FRAGMENT_LIGHT_INCLUDES}
${WORLD_COMMON}
void main() {
  // From the ground's own color at the base to lighter, yellower tips.
  vec3 albedo = mix(uGrassColor * 0.9, uGrassColor * 1.4 + vec3(0.035, 0.03, 0.0), vTip) * vTint;
  float shadow = sunShadow();
  vec3 light = worldLighting(vNormal, vLight.x, vLight.y, mix(0.72, 1.0, vTip), shadow);
  // Sunlight shining through the blades.
  vec3 V = normalize(cameraPosition - vWorldPos);
  float through = pow(max(dot(-V, uLightDir), 0.0), 4.0) * vTip * sunVisibility(vLight.x, shadow);
  vec3 color = albedo * light + albedo * uLightColor * through * 0.7;
  color = applyFog(color, vWorldPos);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createGrassMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: litUniforms({
      uGrassColor: { value: color },
      uPlayer: { value: new THREE.Vector3() },
      uRadius: { value: 16 },
    }),
    vertexShader: grassVertex,
    fragmentShader: grassFragment,
    lights: true,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// Distant terrain (level of detail, see lod-mesher.js)
// ---------------------------------------------------------------------------
// Flat-coloured blocky columns lit with the same model as the chunks (full
// sky light: they're the open surface, and beyond the shadow maps' reach).
// Water gets the near water's body colour, depth, fresnel sky reflection and
// sun glint, without waves (too far away to see them).

const lodVertex = /* glsl */ `
attribute vec4 aColor; // sRGB colour, ambient occlusion
attribute vec4 aInfo;  // normal index, kind, water depth
varying vec3 vColor;
varying float vAo;
varying vec3 vWorldPos;
flat varying vec3 vNormal;
flat varying float vKind;
varying float vDepth;

const vec3 FACE_NORMALS[6] = vec3[6](
  vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0),
  vec3(0.0, -1.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vWorldPos = worldPosition.xyz;
  vColor = pow(aColor.rgb, vec3(2.2));
  vAo = aColor.a;
  vNormal = FACE_NORMALS[int(aInfo.x + 0.5)];
  vKind = aInfo.y;
  vDepth = aInfo.z;
}
`;

const lodFragment = /* glsl */ `
varying vec3 vColor;
varying float vAo;
varying vec3 vWorldPos;
flat varying vec3 vNormal;
flat varying float vKind;
varying float vDepth;
${WORLD_COMMON}

void main() {
  vec3 N = vNormal;
  int kind = int(vKind + 0.5);
  vec3 color = vColor * worldLighting(N, 1.0, 0.0, vAo, 1.0);
  if (kind == 1) {
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
    vec3 lightAmt = worldLighting(up, 1.0, 0.0, 1.0, 1.0);
    float deepness = 1.0 - exp(-max(vDepth, 0.05) * 0.42);
    vec3 body = mix(vec3(0.07, 0.36, 0.40), vec3(0.015, 0.08, 0.2), deepness) * lightAmt;
    // The sandy floor showing through shallow water.
    vec3 floorCol = vColor * lightAmt * 0.55 * exp(-vDepth * vec3(0.5, 0.22, 0.16));
    vec3 base = mix(floorCol, body, mix(0.5, 0.93, deepness));
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 refl = skyColor(R);
    // A broad glint: at this distance the waves blur the sun's reflection.
    float rs = max(dot(R, uLightDir), 0.0);
    refl += uLightColor * (pow(rs, 150.0) * 2.5 + pow(rs, 24.0) * 0.25);
    color = mix(base, refl, fresnel);
  }
  color = applyFog(color, vWorldPos);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createLodMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...worldUniforms },
    vertexShader: lodVertex,
    fragmentShader: lodFragment,
  });
}

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

export function createChunkMaterials(atlas, waterLayer, relief) {
  const opaque = new THREE.ShaderMaterial({
    uniforms: litUniforms({ uAtlas: { value: atlas }, uRelief: { value: relief }, uEmissiveBoost: { value: 4.0 } }),
    vertexShader: chunkVertex,
    fragmentShader: chunkFragment,
    lights: true,
  });
  const cutout = new THREE.ShaderMaterial({
    uniforms: litUniforms({ uAtlas: { value: atlas }, uRelief: { value: relief }, uEmissiveBoost: { value: 4.0 } }),
    vertexShader: chunkVertex,
    fragmentShader: chunkFragment,
    lights: true,
    side: THREE.DoubleSide,
    defines: { CUTOUT: "" },
  });
  const water = new THREE.ShaderMaterial({
    uniforms: litUniforms({
      uAtlas: { value: atlas },
      uWaterLayer: { value: waterLayer },
      tSceneColor: { value: null },
      tSceneDepth: { value: null },
      uScreenSize: { value: new THREE.Vector2(1, 1) },
      uCamNear: { value: 0.1 },
      uCamFar: { value: 1000 },
      uProjection: { value: new THREE.Matrix4() },
    }),
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

// ---------------------------------------------------------------------------
// Entities (dropped items, the held item, mobs)
// ---------------------------------------------------------------------------
// Lit with the same model as terrain. There is no per-vertex voxel light, so
// each object supplies the light level at its position through uniforms,
// set per draw in onBeforeRender (see bindEntityLight below).

const entityVertex = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec3 vViewPosition;
varying vec2 vUv;
#ifdef USE_ARRAY_TEX
  attribute float aLayer;
  varying float vLayer;
#endif
#if defined(USE_COLOR) || defined(USE_INSTANCING_COLOR)
  varying vec3 vColor;
#endif
#include <common>
#include <shadowmap_pars_vertex>
void main() {
  vec4 localPos = vec4(position, 1.0);
  vec3 objectNormal = normal;
  #ifdef USE_INSTANCING
    localPos = instanceMatrix * localPos;
    objectNormal = mat3(instanceMatrix) * objectNormal;
  #endif
  vec4 worldPosition = modelMatrix * localPos;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  vec3 transformedNormal = normalMatrix * objectNormal;
  #include <shadowmap_vertex>
  vWorldPos = worldPosition.xyz;
  vNormalW = normalize(mat3(modelMatrix) * objectNormal);
  vViewPosition = -mvPosition.xyz;
  vUv = uv;
  #ifdef USE_ARRAY_TEX
    vLayer = aLayer;
  #endif
  #if defined(USE_INSTANCING_COLOR)
    vColor = instanceColor;
  #elif defined(USE_COLOR)
    vColor = color;
  #endif
}
`;

const entityFragment = /* glsl */ `
uniform vec2 uLight;   // sky, block light at the object (0-1)
uniform vec3 uFlash;   // additive tint (hit flash)
uniform float uGlow;   // 0-1: how much bright texels glow (mob eyes)
uniform float uOpacity;
uniform float uFill;   // extra ambient (the held item stays readable when backlit)
#ifdef USE_ARRAY_TEX
  uniform highp sampler2DArray uAtlas;
  varying float vLayer;
#endif
#ifdef USE_MAP
  uniform sampler2D uMap;
#endif
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec3 vViewPosition;
varying vec2 vUv;
#if defined(USE_COLOR) || defined(USE_INSTANCING_COLOR)
  varying vec3 vColor;
#endif
${FRAGMENT_LIGHT_INCLUDES}
${WORLD_COMMON}
${POINT_LIGHTS}
void main() {
  vec4 albedo = vec4(1.0);
  #ifdef USE_ARRAY_TEX
    albedo = texture(uAtlas, vec3(vUv, vLayer));
  #endif
  #ifdef USE_MAP
    albedo = texture2D(uMap, vUv);
  #endif
  #if defined(USE_COLOR) || defined(USE_INSTANCING_COLOR)
    albedo.rgb *= vColor;
  #endif
  if (albedo.a < 0.5) discard;
  vec3 N = normalize(vNormalW);
  if (!gl_FrontFacing) N = -N;
  float shadow = sunShadow();
  vec3 light = worldLighting(N, uLight.x, uLight.y, 1.0, shadow);
  light += (uAmbientSky * skyCurve(uLight.x) + uTorchColor * torchCurve(uLight.y)) * uFill;
  #if NUM_POINT_LIGHTS > 0
    light += pointLighting(N, -vViewPosition);
  #endif
  vec3 color = albedo.rgb * light + uFlash;
  if (uGlow > 0.0) {
    float lum = max(albedo.r, max(albedo.g, albedo.b));
    color = mix(color, albedo.rgb * 5.0, uGlow * smoothstep(0.55, 0.9, lum));
  }
  color = applyFog(color, vWorldPos);
  gl_FragColor = vec4(color, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// kind: "array" (block faces from the texture array; needs an aLayer attribute),
// "color" (vertex colors), or "map" (a regular 2D texture).
export function createEntityMaterial(kind, texture = null, { transparent = false, side = THREE.FrontSide } = {}) {
  const defines = {};
  const uniforms = litUniforms({
    uLight: { value: new THREE.Vector2(1, 0) },
    uFlash: { value: new THREE.Color(0, 0, 0) },
    uGlow: { value: 0 },
    uOpacity: { value: 1 },
    uFill: { value: 0 },
  });
  if (kind === "array") {
    defines.USE_ARRAY_TEX = "";
    uniforms.uAtlas = { value: texture };
  } else if (kind === "map") {
    defines.USE_MAP = "";
    uniforms.uMap = { value: texture };
  }
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: entityVertex,
    fragmentShader: entityFragment,
    lights: true,
    defines,
    vertexColors: kind === "color",
    transparent,
    side,
  });
}

// Makes `mesh` (and any child meshes) upload its own light level and flash
// color right before it's drawn. getState() returns { sky, block, flash?, glow? }.
export function bindEntityLight(object, getState) {
  object.traverse((m) => {
    if (!m.isMesh) return;
    m.onBeforeRender = (renderer, scene, camera, geometry, material) => {
      if (!material.uniforms || !material.uniforms.uLight) return;
      const s = getState();
      material.uniforms.uLight.value.set(s.sky / 15, s.block / 15);
      if (s.flash) material.uniforms.uFlash.value.copy(s.flash);
      else material.uniforms.uFlash.value.setRGB(0, 0, 0);
      material.uniforms.uGlow.value = s.glow ?? 0;
      material.uniformsNeedUpdate = true;
    };
  });
}
