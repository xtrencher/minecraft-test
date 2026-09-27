// Particle pools for explosions and other effects. Each pool is a single
// instanced draw call with a fixed capacity that is reused across effects:
// no per-particle meshes or materials are created or disposed at runtime,
// and when a pool is full the oldest particle is recycled.
import * as THREE from "three";

const GRAVITY = -24;

// ---------- Debris: lit, tumbling cubes that bounce off terrain ----------

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();

export class DebrisPool {
  constructor(scene, world, capacity = 500) {
    this.world = world;
    this.capacity = capacity;
    this.particles = [];

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Create the color attribute up front (setColorAt would create it lazily,
    // changing the shader variant mid-game and forcing a recompile).
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  // color: THREE.Color (linear), size in blocks, life in seconds.
  spawn(x, y, z, vx, vy, vz, size, color, life) {
    if (this.particles.length >= this.capacity) this.particles.shift();
    this.particles.push({
      x, y, z, vx, vy, vz, size, life, maxLife: life,
      r: color.r, g: color.g, b: color.b,
      rx: Math.random() * 6.28, ry: Math.random() * 6.28, rz: Math.random() * 6.28,
      sx: (Math.random() - 0.5) * 16, sy: (Math.random() - 0.5) * 16, sz: (Math.random() - 0.5) * 16,
    });
  }

  update(dt) {
    const world = this.world;
    const list = this.particles;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) continue;

      p.vy += GRAVITY * dt;
      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      const nz = p.z + p.vz * dt;
      if (world.isSolidAt(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        if (world.isSolidAt(Math.floor(p.x), Math.floor(ny), Math.floor(p.z))) {
          // Hit the ground (or a ceiling): bounce with heavy damping.
          p.vy *= -0.3;
          p.vx *= 0.55;
          p.vz *= 0.55;
          p.sx *= 0.5;
          p.sy *= 0.5;
          p.sz *= 0.5;
        } else {
          // Hit a wall.
          p.vx *= -0.35;
          p.vz *= -0.35;
        }
      } else {
        p.x = nx;
        p.y = ny;
        p.z = nz;
      }
      p.rx += p.sx * dt;
      p.ry += p.sy * dt;
      p.rz += p.sz * dt;

      // Shrink away over the last 0.4 s of life.
      const s = p.size * Math.min(1, p.life / 0.4);
      _quat.setFromEuler(_euler.set(p.rx, p.ry, p.rz));
      _matrix.compose(_pos.set(p.x, p.y, p.z), _quat, _scale.set(s, s, s));
      this.mesh.setMatrixAt(n, _matrix);
      this.mesh.setColorAt(n, _color.setRGB(p.r, p.g, p.b));
      list[n++] = p;
    }
    list.length = n;
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

// ---------- Billboards: camera-facing soft quads (fire, smoke, sparks) ----------

const billboardVertex = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec2 iSizeRot; // x = size, y = rotation
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = iColor;
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iSizeRot.y);
  float s = sin(iSizeRot.y);
  vec2 corner = position.xy * iSizeRot.x;
  mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const billboardFragment = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  // Soft round falloff with a slightly lumpy edge so puffs don't look like discs.
  float lump = 0.12 * sin(atan(p.y, p.x) * 5.0 + vColor.a * 7.0);
  float a = 1.0 - smoothstep(0.35 + lump, 1.0, r);
  if (a <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    #ifdef ADDITIVE
      gl_FragColor.a *= 1.0 - fogFactor; // additive light just fades out in fog
    #else
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
    #endif
  #endif
  #include <colorspace_fragment>
}
`;

export class BillboardPool {
  // additive: true for glowing particles (fire, sparks), false for smoke.
  constructor(scene, capacity = 300, { additive = false } = {}) {
    this.capacity = capacity;
    this.particles = [];

    const base = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute("position", base.getAttribute("position"));
    geometry.setAttribute("uv", base.getAttribute("uv"));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSizeRot = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("iPos", this.aPos);
    geometry.setAttribute("iColor", this.aColor);
    geometry.setAttribute("iSizeRot", this.aSizeRot);
    geometry.instanceCount = 0;
    this.geometry = geometry;

    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      vertexShader: billboardVertex,
      fragmentShader: billboardFragment,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      defines: additive ? { ADDITIVE: "" } : {},
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 11;
    scene.add(this.mesh);
  }

  // opts: { x,y,z, vx,vy,vz, life, size0, size1, color0, color1 (THREE.Color),
  //         alpha, gravity (multiplier), drag (per second), spin }
  spawn(o) {
    if (this.particles.length >= this.capacity) this.particles.shift();
    this.particles.push({
      x: o.x, y: o.y, z: o.z,
      vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
      life: o.life, maxLife: o.life,
      size0: o.size0, size1: o.size1 ?? o.size0,
      c0: o.color0, c1: o.color1 ?? o.color0,
      alpha: o.alpha ?? 1,
      gravity: o.gravity ?? 0,
      drag: o.drag ?? 0,
      rot: Math.random() * 6.28,
      spin: o.spin ?? (Math.random() - 0.5) * 2,
    });
  }

  update(dt) {
    const list = this.particles;
    const pos = this.aPos.array;
    const col = this.aColor.array;
    const sr = this.aSizeRot.array;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy = p.vy * damp + GRAVITY * p.gravity * dt;
      p.vz *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.spin * dt;

      const t = 1 - p.life / p.maxLife; // normalized age 0 -> 1
      const grow = 1 - (1 - t) * (1 - t); // ease-out growth
      const fadeIn = Math.min(1, t / 0.08);
      const alpha = p.alpha * fadeIn * Math.pow(1 - t, 1.5);

      pos[n * 3] = p.x;
      pos[n * 3 + 1] = p.y;
      pos[n * 3 + 2] = p.z;
      col[n * 4] = p.c0.r + (p.c1.r - p.c0.r) * t;
      col[n * 4 + 1] = p.c0.g + (p.c1.g - p.c0.g) * t;
      col[n * 4 + 2] = p.c0.b + (p.c1.b - p.c0.b) * t;
      col[n * 4 + 3] = alpha;
      sr[n * 2] = p.size0 + (p.size1 - p.size0) * grow;
      sr[n * 2 + 1] = p.rot;
      list[n++] = p;
    }
    list.length = n;
    this.geometry.instanceCount = n;
    if (n > 0) {
      this.aPos.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aSizeRot.needsUpdate = true;
    }
  }
}
