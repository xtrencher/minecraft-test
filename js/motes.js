// Tiny particles drifting in the water around the camera while it's
// submerged (plankton, silt), catching the light. The points live in a box
// that wraps around the camera in the vertex shader, so they're always
// nearby without ever being moved on the CPU.
import * as THREE from "three";
import { LAYER_FX } from "./layers.js";

const COUNT = 420;
const BOX = 14; // blocks

const vertex = /* glsl */ `
attribute vec4 aSeed; // xyz: position in the box (0-1), w: size/phase
uniform vec3 uCam;
uniform float uTime;
uniform float uScale;
varying float vAlpha;
void main() {
  // Slow drift plus a gentle wobble, wrapped into the box around the camera.
  vec3 drift = vec3(0.011, 0.006, -0.008) * uTime + vec3(sin(uTime * 0.7 + aSeed.w * 40.0), sin(uTime * 0.5 + aSeed.w * 23.0), cos(uTime * 0.6 + aSeed.w * 31.0)) * 0.01;
  vec3 p = fract(aSeed.xyz + drift - uCam / ${BOX.toFixed(1)}) - 0.5;
  vec3 world = uCam + p * ${BOX.toFixed(1)};
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(p) * 2.0; // 0 at the camera, ~1 at the box edge
  vAlpha = (1.0 - smoothstep(0.55, 1.0, d)) * smoothstep(0.02, 0.12, d) * (0.45 + 0.55 * fract(aSeed.w * 7.0));
  gl_PointSize = uScale * (0.035 + aSeed.w * 0.05) / max(-mv.z, 0.1);
}
`;

const fragment = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c)) * vAlpha;
  gl_FragColor = vec4(uColor * a, a);
}
`;

export class UnderwaterMotes {
  constructor(scene) {
    const seeds = new Float32Array(COUNT * 4);
    let s = 12345;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    const g = new THREE.BufferGeometry();
    g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    // three needs a position attribute to know the vertex count.
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uScale: { value: 600 },
        uColor: { value: new THREE.Color(0.6, 0.85, 0.9) },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.layers.set(LAYER_FX);
    scene.add(this.points);
  }

  // light: 0-1 brightness of the water around the camera.
  update(camPos, time, underwater, light, viewportHeight) {
    this.points.visible = underwater;
    if (!underwater) return;
    const u = this.material.uniforms;
    u.uCam.value.copy(camPos);
    u.uTime.value = time;
    u.uScale.value = viewportHeight * 0.9;
    u.uColor.value.setRGB(0.5 * light, 0.78 * light, 0.85 * light);
  }
}
