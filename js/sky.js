// Day/night cycle: moves the sun and moon, derives sky, ambient and light
// colors from the sun's elevation (keyframed for noon, golden hour, sunset,
// twilight and night), drives the sky dome, and places the shadow-casting
// directional light (sun by day, moon by night) around the player.
import * as THREE from "three";
import { worldUniforms, createSkyMaterial } from "./shaders.js";

export const DAY_LENGTH = 600; // seconds for a full day/night cycle
const DAY_SHARE = 0.62; // fraction of the cycle with the sun above the horizon
const SUN_TILT = 0.42; // radians the sun's path is tilted off the zenith
const START_ANGLE = 0.33 * Math.PI; // mid-morning

// Keyframes indexed by sun elevation e = sunDir.y (-1..1). Colors are HDR linear.
const KEYS = [
  {
    e: -1.0,
    zenith: [0.0022, 0.0035, 0.011],
    horizon: [0.007, 0.012, 0.028],
    glow: [0, 0, 0],
    sunGlow: [0, 0, 0],
    ambSky: [0.0174, 0.0232, 0.0452],
    ambGround: [0.0058, 0.0064, 0.0093],
    cloudLit: [0.035, 0.045, 0.07],
    cloudShade: [0.012, 0.016, 0.028],
  },
  {
    e: -0.3,
    zenith: [0.0022, 0.0035, 0.011],
    horizon: [0.007, 0.012, 0.028],
    glow: [0, 0, 0],
    sunGlow: [0, 0, 0],
    ambSky: [0.0174, 0.0232, 0.0452],
    ambGround: [0.0058, 0.0064, 0.0093],
    cloudLit: [0.035, 0.045, 0.07],
    cloudShade: [0.012, 0.016, 0.028],
  },
  {
    e: -0.12,
    zenith: [0.012, 0.02, 0.055],
    horizon: [0.05, 0.045, 0.075],
    glow: [0.3, 0.1, 0.05],
    sunGlow: [0.3, 0.1, 0.04],
    ambSky: [0.029, 0.0319, 0.058],
    ambGround: [0.0087, 0.0081, 0.0104],
    cloudLit: [0.12, 0.08, 0.1],
    cloudShade: [0.03, 0.03, 0.05],
  },
  {
    e: -0.03,
    zenith: [0.03, 0.045, 0.14],
    horizon: [0.42, 0.18, 0.11],
    glow: [1.35, 0.34, 0.07],
    sunGlow: [1.3, 0.4, 0.1],
    ambSky: [0.07, 0.064, 0.093],
    ambGround: [0.023, 0.017, 0.017],
    cloudLit: [1.0, 0.4, 0.22],
    cloudShade: [0.14, 0.09, 0.14],
  },
  {
    e: 0.05,
    zenith: [0.08, 0.14, 0.38],
    horizon: [0.9, 0.46, 0.24],
    glow: [2.0, 0.66, 0.16],
    sunGlow: [1.7, 0.72, 0.3],
    ambSky: [0.174, 0.174, 0.22],
    ambGround: [0.07, 0.052, 0.041],
    cloudLit: [1.7, 0.9, 0.52],
    cloudShade: [0.32, 0.24, 0.3],
  },
  {
    e: 0.16,
    zenith: [0.14, 0.3, 0.8],
    horizon: [0.88, 0.8, 0.72],
    glow: [0.5, 0.3, 0.14],
    sunGlow: [1.4, 1.0, 0.7],
    ambSky: [0.29, 0.3248, 0.4176],
    ambGround: [0.1276, 0.1102, 0.087],
    cloudLit: [1.7, 1.55, 1.35],
    cloudShade: [0.6, 0.62, 0.7],
  },
  {
    e: 0.4,
    zenith: [0.12, 0.33, 1.0],
    horizon: [0.72, 0.86, 1.05],
    glow: [0.08, 0.06, 0.04],
    sunGlow: [1.3, 1.15, 0.95],
    ambSky: [0.3596, 0.4176, 0.5336],
    ambGround: [0.1624, 0.145, 0.116],
    cloudLit: [1.9, 1.9, 1.85],
    cloudShade: [0.78, 0.82, 0.9],
  },
  {
    e: 1.0,
    zenith: [0.1, 0.3, 1.0],
    horizon: [0.68, 0.84, 1.06],
    glow: [0, 0, 0],
    sunGlow: [1.3, 1.2, 1.0],
    ambSky: [0.3828, 0.4408, 0.5568],
    ambGround: [0.174, 0.1566, 0.1276],
    cloudLit: [2.0, 2.0, 1.95],
    cloudShade: [0.82, 0.86, 0.94],
  },
];

// Direct sunlight color by elevation (before the fade at the horizon).
const SUN_KEYS = [
  { e: 0.0, c: [0.8, 0.3, 0.1] },
  { e: 0.08, c: [1.3, 0.72, 0.38] },
  { e: 0.25, c: [1.65, 1.38, 1.06] },
  { e: 1.0, c: [1.78, 1.64, 1.42] },
];
const MOON_LIGHT = [0.1, 0.13, 0.24];

function lerpKeys(keys, e, field, out) {
  let i = 0;
  while (i < keys.length - 2 && e > keys[i + 1].e) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const t = THREE.MathUtils.clamp((e - a.e) / (b.e - a.e), 0, 1);
  const ca = a[field];
  const cb = b[field];
  return out.setRGB(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
}

// Depth range of the shadow cameras (blocks), centered on the player.
export const SHADOW_DEPTH = 360;

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export class Sky {
  // cascadeLights: extra shadow-only directional lights (intensity 0) for
  // the larger shadow cascades; sunLight is the finest cascade and the one
  // that lights three's built-in materials.
  constructor(scene, sunLight, hemiLight, cascadeLights = []) {
    this.scene = scene;
    this.sunLight = sunLight;
    this.hemiLight = hemiLight;
    this.shadowLights = [sunLight, ...cascadeLights];
    this.time = this._timeForAngle(START_ANGLE);
    this.sunAngle = START_ANGLE;
    this.cascades = [{ extent: 64, mapSize: 2048 }];

    this.material = createSkyMaterial();
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), this.material);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    scene.add(this.dome);

    this._tmp = new THREE.Color();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._center = new THREE.Vector3();
    this.horizonColor = new THREE.Color();
    this.exposure = 1;
    this.locked = false;
  }

  // Cycle time (seconds) at which the sun is at `angle` (0 = sunrise, PI = sunset).
  _timeForAngle(angle) {
    const a = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const phase = a < Math.PI ? (a / Math.PI) * DAY_SHARE : DAY_SHARE + ((a - Math.PI) / Math.PI) * (1 - DAY_SHARE);
    return phase * DAY_LENGTH;
  }

  setSunAngle(angle) {
    this.time = this._timeForAngle(angle);
  }

  // The sun's angle along its path for the current cycle time.
  _angleForTime(time) {
    const phase = (((time % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH) / DAY_LENGTH;
    return phase < DAY_SHARE ? (phase / DAY_SHARE) * Math.PI : Math.PI + ((phase - DAY_SHARE) / (1 - DAY_SHARE)) * Math.PI;
  }

  // Clock time, 0-24 (sunrise at 6:00, sunset at 18:00).
  get hours() {
    const a = this._angleForTime(this.time);
    return (6 + (a / Math.PI) * 12) % 24;
  }

  setHours(h) {
    const t = ((((Number(h) || 0) - 6) % 24) + 24) % 24;
    this.setSunAngle((t / 12) * Math.PI);
  }

  get isNight() {
    return worldUniforms.uSunDir.value.y < -0.05;
  }

  // 0 at full night, 1 at full day.
  get daylight() {
    return smoothstep(-0.15, 0.2, worldUniforms.uSunDir.value.y);
  }

  update(dt, center, forward) {
    // A locked clock (settings menu) keeps the sun where it is.
    if (!this.locked) this.time = (this.time + dt) % DAY_LENGTH;
    const angle = this._angleForTime(this.time);
    this.sunAngle = angle;

    const u = worldUniforms;
    const sunDir = u.uSunDir.value.set(Math.cos(angle), Math.sin(angle) * Math.cos(SUN_TILT), Math.sin(angle) * Math.sin(SUN_TILT)).normalize();
    u.uMoonDir.value.copy(sunDir).negate();
    const e = sunDir.y;

    lerpKeys(KEYS, e, "zenith", u.uSkyZenith.value);
    lerpKeys(KEYS, e, "horizon", u.uSkyHorizon.value);
    lerpKeys(KEYS, e, "glow", u.uSkyGlow.value);
    lerpKeys(KEYS, e, "sunGlow", u.uSunGlowColor.value);
    lerpKeys(KEYS, e, "ambSky", u.uAmbientSky.value);
    lerpKeys(KEYS, e, "ambGround", u.uAmbientGround.value);
    lerpKeys(KEYS, e, "cloudLit", this.material.uniforms.uCloudLit.value);
    lerpKeys(KEYS, e, "cloudShade", this.material.uniforms.uCloudShade.value);
    u.uNight.value = 1 - smoothstep(-0.2, -0.02, e);
    this.material.uniforms.uStarAngle.value = angle;

    // The shadow-casting light is the sun while it's up, the moon otherwise.
    // Both are faded to zero around the switch so shadows never jump.
    const lightColor = u.uLightColor.value;
    if (e > -0.04) {
      u.uLightDir.value.copy(sunDir);
      lerpKeys(SUN_KEYS, Math.max(e, 0), "c", lightColor).multiplyScalar(smoothstep(-0.04, 0.06, e));
    } else {
      u.uLightDir.value.copy(u.uMoonDir.value);
      lightColor.setRGB(MOON_LIGHT[0], MOON_LIGHT[1], MOON_LIGHT[2]).multiplyScalar(smoothstep(-0.04, -0.2, e));
    }

    // Built-in three.js materials (debris, orb, particles) use real lights:
    // Lambert divides by PI, so scale by PI to match the terrain shader.
    this.sunLight.color.copy(lightColor);
    this.sunLight.intensity = Math.PI;
    this.hemiLight.color.copy(u.uAmbientSky.value);
    this.hemiLight.groundColor.copy(u.uAmbientGround.value);
    this.hemiLight.intensity = Math.PI;

    // Horizon color in the view direction, for three's built-in fog.
    this.horizonColor.copy(u.uSkyHorizon.value);

    // Night is dark, but the eye adapts a bit (like in classic voxel games).
    this.exposure = THREE.MathUtils.lerp(1.1, 0.8, smoothstep(-0.15, 0.25, e));

    for (let i = 0; i < this.cascades.length; i++) this._placeShadowLight(this.shadowLights[i], this.cascades[i], center, forward);
    this.dome.position.copy(center);
  }

  // Centers a shadow camera a little ahead of the player and snaps it to
  // whole shadow-map texels so shadow edges don't crawl as the player moves.
  _placeShadowLight(light, cascade, center, forward) {
    const dir = worldUniforms.uLightDir.value;
    const c = this._center.copy(center);
    if (forward) {
      c.x += forward.x * cascade.extent * 0.35;
      c.z += forward.z * cascade.extent * 0.35;
    }
    const right = this._right.set(0, 1, 0).cross(dir).normalize();
    const up = this._up.copy(dir).cross(right).normalize();
    const texel = (2 * cascade.extent) / cascade.mapSize;
    const r = Math.round(c.dot(right) / texel) * texel;
    const v = Math.round(c.dot(up) / texel) * texel;
    const f = c.dot(dir);
    light.target.position.set(0, 0, 0).addScaledVector(right, r).addScaledVector(up, v).addScaledVector(dir, f);
    light.position.copy(light.target.position).addScaledVector(dir, SHADOW_DEPTH / 2);
    light.target.updateMatrixWorld();
  }

  // cascades: [{ extent, mapSize }] from the finest to the largest (at most
  // one per shadow light). Only the first cascades.length lights cast shadows.
  configureShadows(cascades) {
    this.cascades = cascades.slice(0, this.shadowLights.length);
    this.shadowLights.forEach((light, i) => {
      const cascade = this.cascades[i];
      light.castShadow = !!cascade;
      if (!cascade) return;
      light.shadow.mapSize.set(cascade.mapSize, cascade.mapSize);
      const texel = (2 * cascade.extent) / cascade.mapSize;
      light.shadow.bias = -0.0003;
      light.shadow.normalBias = texel * 1.2;
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
      const cam = light.shadow.camera;
      cam.left = -cascade.extent;
      cam.right = cascade.extent;
      cam.top = cascade.extent;
      cam.bottom = -cascade.extent;
      cam.near = 1;
      cam.far = SHADOW_DEPTH;
      cam.updateProjectionMatrix();
    });
  }
}
