// HDR post-processing pipeline (used by the Medium, High and Ultra presets):
//
//   scene -> HDR render target (half float, MSAA). With screen-space water
//            (High/Ultra) in two passes: the world (layer 0), then the
//            water (layer 1), which reads the resolved world color and
//            depth for refraction, absorption and reflections, then the
//            transparent effects (layer 2) on top of both.
//         -> bloom: bright-pass + 13-tap downsample chain, tent upsample
//            chain accumulating every level (soft, wide glow)
//         -> light shafts (Ultra/High): radial blur toward the sun of the
//            sky mask the sky shader writes into alpha
//         -> composite: exposure, ACES filmic tone mapping (same curve as
//            three.js uses on the Low preset), color grade, vignette,
//            underwater tint / damage flash, dithering, sRGB output.
import * as THREE from "three";
import { LAYER_WORLD, LAYER_WATER, LAYER_FX } from "./layers.js";

const FS_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const PREFILTER = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
vec3 tap(vec2 o) {
  vec3 c = texture2D(tInput, vUv + uTexel * o).rgb;
  // Never let a stray NaN/Inf pixel get smeared across the screen by the blur.
  if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
  return clamp(c, vec3(0.0), vec3(64.0));
}
void main() {
  // 13-tap downsample (Jimenez 2014), resistant to flickering fireflies.
  vec3 c = tap(vec2(0.0)) * 0.125
    + (tap(vec2(-2.0, 2.0)) + tap(vec2(2.0, 2.0)) + tap(vec2(-2.0, -2.0)) + tap(vec2(2.0, -2.0))) * 0.03125
    + (tap(vec2(0.0, 2.0)) + tap(vec2(-2.0, 0.0)) + tap(vec2(2.0, 0.0)) + tap(vec2(0.0, -2.0))) * 0.0625
    + (tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0)) + tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0))) * 0.125;
  // Soft-knee bright pass: only light brighter than the threshold blooms.
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  gl_FragColor = vec4(c * contrib, 1.0);
}
`;

const DOWNSAMPLE = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tInput, vUv + uTexel * o).rgb; }
void main() {
  vec3 c = tap(vec2(0.0)) * 0.125
    + (tap(vec2(-2.0, 2.0)) + tap(vec2(2.0, 2.0)) + tap(vec2(-2.0, -2.0)) + tap(vec2(2.0, -2.0))) * 0.03125
    + (tap(vec2(0.0, 2.0)) + tap(vec2(-2.0, 0.0)) + tap(vec2(2.0, 0.0)) + tap(vec2(0.0, -2.0))) * 0.0625
    + (tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0)) + tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0))) * 0.125;
  gl_FragColor = vec4(c, 1.0);
}
`;

const UPSAMPLE = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uScale;
varying vec2 vUv;
void main() {
  // 9-tap tent filter; blended additively onto the next larger level.
  vec4 d = uTexel.xyxy * vec4(1.0, 1.0, -1.0, 0.0);
  vec3 s = texture2D(tInput, vUv - d.xy).rgb;
  s += texture2D(tInput, vUv - d.wy).rgb * 2.0;
  s += texture2D(tInput, vUv - d.zy).rgb;
  s += texture2D(tInput, vUv + d.zw).rgb * 2.0;
  s += texture2D(tInput, vUv).rgb * 4.0;
  s += texture2D(tInput, vUv + d.xw).rgb * 2.0;
  s += texture2D(tInput, vUv + d.zy).rgb;
  s += texture2D(tInput, vUv + d.wy).rgb * 2.0;
  s += texture2D(tInput, vUv + d.xy).rgb;
  gl_FragColor = vec4(s * (uScale / 16.0), 1.0);
}
`;

const GODRAYS = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uSun;
uniform float uAspect;
uniform float uSpread; // how far from the sun the shafts reach (smaller = wider)
varying vec2 vUv;
#ifndef SAMPLES
#define SAMPLES 48
#endif
void main() {
  // March from the pixel toward the sun through the sky mask (the sky
  // shader writes alpha 0 for open sky, clouds and everything solid block
  // it), so light pours through gaps in clouds, canopies and terrain.
  vec2 uv = vUv;
  vec2 delta = (uv - uSun) * (0.95 / float(SAMPLES));
  // Dither the start so the shafts don't band.
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  uv -= delta * jitter;
  float illum = 1.0;
  float sum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    uv -= delta;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float sky = 1.0 - texture2D(tScene, uv).a;
    vec2 dd = (uv - uSun) * vec2(uAspect, 1.0);
    sum += sky * exp(-dot(dd, dd) * uSpread) * illum;
    illum *= 0.968;
  }
  gl_FragColor = vec4(vec3(sum / float(SAMPLES)), 1.0);
}
`;

// Light shafts under water: the view ray is marched through the water up
// to the first surface behind it (depth buffer); at each step the light is
// traced back up to where it entered the water surface (along the refracted
// sun direction), where slowly drifting bands of focused light make the
// rays. Brighter near the surface and nearby, fading into the murk.
const UW_RAYS = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uLight;     // refracted sun direction (toward the sun)
uniform float uSurfaceY; // water surface above the camera
uniform float uTime;
varying vec2 vUv;
float bands(vec2 p, float t) {
  float a = sin(p.x * 0.9 + t * 0.55 + sin(p.y * 0.43 + t * 0.21) * 1.6);
  float b = sin(p.y * 1.13 - t * 0.41 + sin(p.x * 0.37 - t * 0.17) * 1.8);
  float c = sin((p.x - p.y) * 0.61 + t * 0.33);
  return pow(clamp((a * b + c * 0.6) * 0.45 + 0.5, 0.0, 1.0), 5.0);
}
void main() {
  float depth = texture2D(tDepth, vUv).r;
  vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 ray = w.xyz / w.w - uCamPos;
  float len = min(length(ray), 30.0);
  vec3 dir = normalize(ray);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 slant = uLight.xz / max(uLight.y, 0.3);
  float sum = 0.0;
  for (int i = 0; i < 24; i++) {
    float t = (float(i) + jitter) / 24.0 * len;
    vec3 q = uCamPos + dir * t;
    float below = uSurfaceY - q.y;
    if (below < 0.0) continue;
    sum += bands((q.xz + slant * below) * 0.42, uTime) * exp(-below * 0.085 - t * 0.055);
  }
  gl_FragColor = vec4(vec3(sum / 24.0 * len / 12.0), 1.0);
}
`;
const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tRays;
uniform float uBloomStrength;
uniform float uRaysStrength;
uniform vec3 uRaysColor;
uniform float uExposure;
uniform float uSaturation;
uniform float uContrast;
uniform float uVignette;
uniform float uUnderwater;
uniform float uNearLava;
uniform float uDamage;
uniform float uNight;
uniform vec2 uResolution;
uniform float uTime;
varying vec2 vUv;

// The ACES fit three.js uses for ACESFilmicToneMapping (kept identical so
// the Low preset, which uses three's tone mapping directly, matches).
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  if (uUnderwater > 0.5) {
    // Gentle refraction wobble under water.
    uv += vec2(sin(uv.y * 24.0 + uTime * 2.1), cos(uv.x * 20.0 + uTime * 1.7)) * 0.0025;
  }
  if (uNearLava > 0.001) {
    // Heat shimmer: faster, finer wobble than the underwater one, strongest
    // low in the frame (rising off the lava) and fading with distance.
    float rise = mix(1.0, 0.35, vUv.y);
    uv += vec2(sin((uv.y + uTime * 0.15) * 90.0), cos((uv.x + uTime * 0.1) * 70.0)) * 0.0018 * uNearLava * rise;
  }
  vec3 col = texture2D(tScene, uv).rgb;
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  #ifdef USE_BLOOM
    col += texture2D(tBloom, uv).rgb * uBloomStrength;
  #endif
  #ifdef USE_RAYS
    col += texture2D(tRays, uv).r * uRaysColor * uRaysStrength;
  #endif
  col = acesFilmic(col * uExposure);
  // Grade in display (gamma) space.
  col = sRGBTransferOETF(vec4(col, 1.0)).rgb;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation * (1.0 - uNight * 0.25));
  col = (col - 0.5) * uContrast + 0.5;
  // Split toning: slightly cool shadows, warm highlights.
  col *= mix(vec3(0.97, 1.0, 1.05), vec3(1.03, 1.0, 0.96), smoothstep(0.1, 0.8, luma));
  if (uUnderwater > 0.5) col = mix(col, col * vec3(0.55, 0.9, 1.05), 0.6);
  if (uNearLava > 0.001) col = mix(col, col * vec3(1.12, 0.92, 0.8), 0.5 * uNearLava);
  // Vignette, plus a red pulse at the screen edges when hurt.
  vec2 q = vUv - 0.5;
  float v = smoothstep(0.85, 0.2, length(q * vec2(1.1, 1.0)));
  col *= mix(1.0, v, uVignette);
  col = mix(col, vec3(0.75, 0.0, 0.0), uDamage * smoothstep(0.25, 0.75, length(q)) * 0.7);
  // Dither to hide banding in dark gradients.
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    const ext = renderer.extensions;
    this.hdrType = ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float") ? THREE.HalfFloatType : THREE.UnsignedByteType;

    const rtOpts = { type: this.hdrType, depthBuffer: false, stencilBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter };
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { ...rtOpts, depthBuffer: true, samples: 4 });
    // The MSAA depth is resolved into this texture too (read by the water pass).
    this.sceneRT.depthTexture = new THREE.DepthTexture(1, 1);
    this.sceneRT.depthTexture.type = THREE.UnsignedIntType;
    this.waterMaterial = null; // set by setWaterMaterial()
    this.screenWater = false;
    this.bloomRTs = [];
    for (let i = 0; i < 6; i++) this.bloomRTs.push(new THREE.WebGLRenderTarget(1, 1, rtOpts));
    this.raysRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);

    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsScene = new THREE.Scene();
    this.fsMesh = new THREE.Mesh(tri, null);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);

    const mat = (fragmentShader, uniforms, extra = {}) =>
      new THREE.ShaderMaterial({ vertexShader: FS_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra });
    this.prefilterMat = mat(PREFILTER, {
      tInput: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 2.0 },
      uKnee: { value: 0.7 },
    });
    this.downMat = mat(DOWNSAMPLE, { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upMat = mat(
      UPSAMPLE,
      { tInput: { value: null }, uTexel: { value: new THREE.Vector2() }, uScale: { value: 1 } },
      { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
    );
    this.raysMat = mat(GODRAYS, { tScene: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uAspect: { value: 1 }, uSpread: { value: 8 } });
    this.uwRaysMat = mat(UW_RAYS, {
      tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uLight: { value: new THREE.Vector3(0, 1, 0) },
      uSurfaceY: { value: 0 },
      uTime: { value: 0 },
    });
    this._viewProj = new THREE.Matrix4();
    this.compositeMat = mat(COMPOSITE, {
      tScene: { value: this.sceneRT.texture },
      tBloom: { value: null },
      tRays: { value: this.raysRT.texture },
      uBloomStrength: { value: 0.12 },
      uRaysStrength: { value: 0 },
      uRaysColor: { value: new THREE.Color(1, 0.9, 0.7) },
      uExposure: { value: 1 },
      uSaturation: { value: 1.16 },
      uContrast: { value: 1.06 },
      uVignette: { value: 0.35 },
      uUnderwater: { value: 0 },
      uNearLava: { value: 0 },
      uDamage: { value: 0 },
      uNight: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
    });

    this.bloomLevels = 5;
    this.godRays = false;
    this.lastRays = { kind: null, strength: 0 }; // which light shafts the last frame drew (stats / tests)
    this.width = 1;
    this.height = 1;
    this._sunNdc = new THREE.Vector3();
  }

  // The chunk water material, which gets the world image and depth in the
  // two-pass mode.
  setWaterMaterial(material) {
    this.waterMaterial = material;
  }

  // screenWater: draw water in its own pass over the resolved world (needs
  // MSAA, so the pass can read the world image while drawing into the
  // multisampled buffer).
  // raySamples: steps of the light-shaft march (more = smoother shafts).
  configure({ msaa = 4, bloomLevels = 5, godRays = false, screenWater = false, raySamples = 48 } = {}) {
    if (this.raysMat.defines.SAMPLES !== raySamples) {
      this.raysMat.defines.SAMPLES = raySamples;
      this.raysMat.needsUpdate = true;
    }
    if (this.sceneRT.samples !== msaa) {
      this.sceneRT.dispose();
      this.sceneRT.samples = msaa;
    }
    this.screenWater = screenWater && msaa > 0;
    this.bloomLevels = Math.max(0, Math.min(this.bloomRTs.length, bloomLevels));
    this.godRays = godRays;
    const defines = {};
    if (this.bloomLevels > 0) defines.USE_BLOOM = "";
    if (godRays) defines.USE_RAYS = "";
    this.compositeMat.defines = defines;
    this.compositeMat.needsUpdate = true;
  }

  setSize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.sceneRT.setSize(this.width, this.height);
    let w = this.width;
    let h = this.height;
    for (const rt of this.bloomRTs) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      rt.setSize(w, h);
    }
    this.raysRT.setSize(Math.max(1, Math.floor(this.width / 3)), Math.max(1, Math.floor(this.height / 3)));
    this.compositeMat.uniforms.uResolution.value.set(this.width, this.height);
  }

  _pass(material, target) {
    this.fsMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCamera);
  }

  // Renders `scene` through the pipeline to the screen. `overlay` (optional)
  // is { scene, camera } drawn on top with a cleared depth buffer (e.g. a
  // held item). `params`: exposure, sunWorldPos (Vector3), sunColor.
  render(scene, camera, params, overlay = null) {
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    r.setRenderTarget(this.sceneRT);
    r.autoClear = true;
    if (this.screenWater && this.waterMaterial) {
      const mask = camera.layers.mask;
      camera.layers.set(LAYER_WORLD);
      r.render(scene, camera); // resolves color and depth for the water pass
      const u = this.waterMaterial.uniforms;
      u.tSceneColor.value = this.sceneRT.texture;
      u.tSceneDepth.value = this.sceneRT.depthTexture;
      u.uScreenSize.value.set(this.width, this.height);
      u.uCamNear.value = camera.near;
      u.uCamFar.value = camera.far;
      u.uProjection.value.copy(camera.projectionMatrix);
      camera.layers.set(LAYER_WATER);
      camera.layers.enable(LAYER_FX);
      r.autoClear = false;
      const autoShadow = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false; // reuse this frame's shadow maps
      r.render(scene, camera);
      r.shadowMap.autoUpdate = autoShadow;
      camera.layers.mask = mask;
    } else {
      r.render(scene, camera);
    }
    if (overlay) {
      r.autoClear = false;
      r.clearDepth();
      r.render(overlay.scene, overlay.camera);
    }
    r.autoClear = false;

    // Bloom.
    if (this.bloomLevels > 0) {
      const levels = this.bloomRTs.slice(0, this.bloomLevels);
      this.prefilterMat.uniforms.tInput.value = this.sceneRT.texture;
      this.prefilterMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
      this._pass(this.prefilterMat, levels[0]);
      for (let i = 1; i < levels.length; i++) {
        this.downMat.uniforms.tInput.value = levels[i - 1].texture;
        this.downMat.uniforms.uTexel.value.set(1 / levels[i - 1].width, 1 / levels[i - 1].height);
        this._pass(this.downMat, levels[i]);
      }
      for (let i = levels.length - 1; i > 0; i--) {
        this.upMat.uniforms.tInput.value = levels[i].texture;
        this.upMat.uniforms.uTexel.value.set(1 / levels[i].width, 1 / levels[i].height);
        this.upMat.uniforms.uScale.value = 1;
        this._pass(this.upMat, levels[i - 1]);
      }
      this.compositeMat.uniforms.tBloom.value = levels[0].texture;
    }

    // Light shafts: under water, rays from the surface; otherwise sunbeams
    // (only while the sun is up and roughly in front of the camera).
    let rays = 0;
    if (this.godRays && params.underwater && params.underwaterRays > 0 && params.surfaceY !== undefined) {
      const u = this.uwRaysMat.uniforms;
      u.tDepth.value = this.sceneRT.depthTexture;
      this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      u.uInvViewProj.value.copy(this._viewProj).invert();
      u.uCamPos.value.copy(camera.position);
      u.uLight.value.copy(params.underwaterLight);
      u.uSurfaceY.value = params.surfaceY;
      u.uTime.value = params.time ?? 0;
      this._pass(this.uwRaysMat, this.raysRT);
      rays = params.underwaterRays;
      this.lastRays = { kind: "underwater", strength: rays };
    } else if (this.godRays && params.sunWorldPos) {
      const ndc = this._sunNdc.copy(params.sunWorldPos).project(camera);
      const facing = ndc.z < 1 && Math.abs(ndc.x) < 1.8 && Math.abs(ndc.y) < 1.8;
      if (facing && params.raysStrength > 0) {
        this.raysMat.uniforms.tScene.value = this.sceneRT.texture;
        this.raysMat.uniforms.uSun.value.set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);
        this.raysMat.uniforms.uAspect.value = this.width / this.height;
        this.raysMat.uniforms.uSpread.value = params.raysSpread ?? 8;
        this._pass(this.raysMat, this.raysRT);
        const edgeFade = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(ndc.x), Math.abs(ndc.y)), 0.9, 1.8);
        rays = params.raysStrength * edgeFade;
        this.lastRays = { kind: "sun", strength: rays };
      }
    }
    if (rays === 0) this.lastRays = { kind: null, strength: 0 };

    const cu = this.compositeMat.uniforms;
    cu.tScene.value = this.sceneRT.texture;
    cu.uExposure.value = params.exposure ?? 1;
    cu.uRaysStrength.value = rays;
    if (params.underwater && params.underwaterColor) cu.uRaysColor.value.copy(params.underwaterColor);
    else if (params.sunColor) cu.uRaysColor.value.copy(params.sunColor);
    cu.uUnderwater.value = params.underwater ? 1 : 0;
    cu.uNearLava.value = params.nearLava ?? 0;
    cu.uDamage.value = params.damage ?? 0;
    cu.uNight.value = params.night ?? 0;
    cu.uBloomStrength.value = params.bloomStrength ?? 0.12;
    cu.uTime.value = params.time ?? 0;
    this._pass(this.compositeMat, null);
    r.autoClear = prevAutoClear;
  }

  dispose() {
    this.sceneRT.dispose();
    for (const rt of this.bloomRTs) rt.dispose();
    this.raysRT.dispose();
  }
}
