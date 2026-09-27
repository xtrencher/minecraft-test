// Day/night cycle (moving sun, sky/fog color) and a drifting cloud layer.
import * as THREE from "three";
import { mulberry32 } from "./noise.js";
import { WORLD_HEIGHT } from "./chunk.js";

const DAY_LENGTH = 180; // seconds for a full day/night cycle
const NIGHT_COLOR = new THREE.Color(0x0b1130);
const DAY_COLOR = new THREE.Color(0x8fc7f0);
const SUNSET_COLOR = new THREE.Color(0xff9a55);

function buildCloudTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  const rand = mulberry32(9001);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  for (let i = 0; i < 26; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const blobs = 4 + Math.floor(rand() * 5);
    for (let b = 0; b < blobs; b++) {
      const ox = (rand() - 0.5) * 60;
      const oy = (rand() - 0.5) * 30;
      const r = 14 + rand() * 26;
      ctx.beginPath();
      ctx.ellipse(cx + ox, cy + oy, r, r * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 5);
  return texture;
}

export class Sky {
  constructor(scene, ambientLight, sunLight) {
    this.scene = scene;
    this.ambientLight = ambientLight;
    this.sunLight = sunLight;
    this.time = DAY_LENGTH * 0.28;
    this.skyColor = new THREE.Color();

    const cloudTexture = buildCloudTexture();
    const cloudGeo = new THREE.PlaneGeometry(600, 600);
    // Alpha-tested cutout (like the leaves/glass block materials) rather than
    // alpha-blended transparency: blended fragments over the empty parts of
    // this texture rendered as a solid tinted slab under software WebGL
    // (SwiftShader), so fragments are fully discarded below the threshold
    // instead of blended.
    this.cloudMaterial = new THREE.MeshBasicMaterial({
      map: cloudTexture,
      transparent: false,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    });
    this.cloudMesh = new THREE.Mesh(cloudGeo, this.cloudMaterial);
    this.cloudMesh.rotation.x = -Math.PI / 2;
    this.cloudMesh.position.y = WORLD_HEIGHT + 30;
    scene.add(this.cloudMesh);
  }

  update(dt, playerPosition) {
    this.time = (this.time + dt) % DAY_LENGTH;
    const angle = (this.time / DAY_LENGTH) * Math.PI * 2;
    const sunHeight = Math.sin(angle);

    const dir = new THREE.Vector3(Math.cos(angle), sunHeight, 0.35).normalize();
    this.sunLight.position.copy(playerPosition).addScaledVector(dir, 200);
    this.sunLight.target.position.copy(playerPosition);

    const dayT = THREE.MathUtils.clamp((sunHeight + 0.15) / 0.55, 0, 1);
    this.skyColor.copy(NIGHT_COLOR).lerp(DAY_COLOR, dayT);
    const sunsetFactor = Math.max(0, 1 - Math.abs(sunHeight) / 0.3);
    this.skyColor.lerp(SUNSET_COLOR, sunsetFactor * 0.35);

    this.scene.background = this.skyColor;
    if (this.scene.fog) this.scene.fog.color.copy(this.skyColor);

    this.sunLight.intensity = 0.15 + Math.max(0, sunHeight) * 0.85;
    this.ambientLight.intensity = 0.22 + Math.max(0, sunHeight) * 0.4;

    const cloudBrightness = 0.5 + dayT * 0.5;
    this.cloudMaterial.color.setScalar(cloudBrightness);
    this.cloudMesh.position.x = playerPosition.x;
    this.cloudMesh.position.z = playerPosition.z;
    this.cloudMaterial.map.offset.x += dt * 0.004;
    this.cloudMaterial.map.offset.y += dt * 0.0015;
  }
}
