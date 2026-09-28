// First-person view of the item in hand (or a bare arm): rendered as an
// overlay scene after the world, with a cleared depth buffer so it never
// clips into walls. Animated with a swing (mining, attacking, placing), an
// equip dip when switching items, and a little walk bob.
import * as THREE from "three";
import { itemModel, MUZZLE } from "./models.js";
import { itemInfo } from "./items.js";
import { createEntityMaterial, bindEntityLight } from "./shaders.js";

const SWING_TIME = 0.28;

// A soft star-shaped flash for gun muzzles.
function makeFlashTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,240,1)");
  g.addColorStop(0.2, "rgba(255,220,150,0.9)");
  g.addColorStop(0.55, "rgba(255,150,60,0.25)");
  g.addColorStop(1, "rgba(255,120,40,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Spikes.
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = "rgba(255,210,140,0.7)";
  ctx.lineWidth = 3;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(32, 32);
    ctx.lineTo(32 + Math.cos(a) * 30, 32 + Math.sin(a) * 30);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const EQUIP_TIME = 0.2;

function armGeometry() {
  const g = new THREE.BoxGeometry(0.2, 0.2, 0.72);
  const skin = new THREE.Color().setRGB(0.86, 0.64, 0.48, THREE.SRGBColorSpace);
  const sleeve = new THREE.Color().setRGB(0.22, 0.42, 0.62, THREE.SRGBColorSpace);
  const pos = g.getAttribute("position");
  const colors = [];
  for (let i = 0; i < pos.count; i++) {
    const c = pos.getZ(i) > 0.12 ? sleeve : skin; // the part nearest the camera is a sleeve
    colors.push(c.r, c.g, c.b);
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

export class HeldItem {
  constructor(atlas) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
    this.materials = {
      array: createEntityMaterial("array", atlas),
      color: createEntityMaterial("color"),
    };
    for (const m of Object.values(this.materials)) m.uniforms.uFill.value = 0.7;
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.arm = new THREE.Mesh(armGeometry(), this.materials.color);
    this.mesh = null;
    this.itemId = null;
    this.light = { sky: 15, block: 0 };
    this.visible = true;
    this._swing = 1;
    this._equip = 1;
    this._pendingId = null;
    this._kick = 0; // recoil (0-1), decays quickly
    this._kickPower = 1;
    this._flash = 99; // seconds since the last muzzle flash
    this.windUp = 0; // 0-1: how far a throw is drawn back (charging)
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, color: new THREE.Color(6, 4.2, 2.2) }));
    this.flash.visible = false;
    this.setItem(0, true);
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  // Shows item `id` (0 / null = bare arm). Animates the switch unless `instant`.
  setItem(id, instant = false) {
    id = id || 0;
    if (this._pendingId !== null) {
      if (id === this._pendingId) return; // already switching to it
    } else if (id === this.itemId && this.mesh) {
      return;
    }
    if (!instant && this.mesh) {
      this._pendingId = id;
      this._equip = 0;
      return;
    }
    this._apply(id);
  }

  _apply(id) {
    this.itemId = id;
    if (this.mesh) this.pivot.remove(this.mesh);
    const model = id ? itemModel(id) : null;
    if (!model) {
      this.mesh = this.arm;
      this.mesh.position.set(0.5, -0.5, -0.45);
      this.mesh.rotation.set(0.55, 0.32, 0.05);
      this.kind = "arm";
    } else {
      this.mesh = new THREE.Mesh(model.geometry, this.materials[model.kind]);
      if (model.cube) {
        this.mesh.scale.setScalar(0.19);
        this.mesh.position.set(0.46, -0.27, -0.8);
        this.mesh.rotation.set(0.1, Math.PI / 4 + 0.25, 0);
        this.kind = "block";
      } else if (model.gun === "pistol") {
        this.mesh.scale.setScalar(0.6);
        this.mesh.position.set(0.22, -0.2, -0.55);
        this.mesh.rotation.set(0.02, 0.05, 0);
        this.kind = "gun";
      } else if (model.gun === "bazooka") {
        // Over the right shoulder, the whole tube in front of the eye.
        this.mesh.scale.setScalar(0.6);
        this.mesh.position.set(0.3, -0.24, -0.72);
        this.mesh.rotation.set(0.0, 0.05, 0);
        this.kind = "gun";
      } else if (model.gun === "machinegun") {
        this.mesh.scale.setScalar(0.62);
        this.mesh.position.set(0.26, -0.22, -0.55);
        this.mesh.rotation.set(0.02, 0.04, 0);
        this.kind = "gun";
      } else if (model.gun === "sniper") {
        this.mesh.scale.setScalar(0.6);
        this.mesh.position.set(0.25, -0.23, -0.6);
        this.mesh.rotation.set(0.0, 0.06, 0);
        this.kind = "gun";
      } else if (itemInfo(id)?.weapon?.kind === "grenade") {
        this.mesh.scale.setScalar(0.22);
        this.mesh.position.set(0.34, -0.26, -0.6);
        this.mesh.rotation.set(0.1, -0.5, 0.1);
        this.kind = "item";
      } else if (itemInfo(id)?.weapon?.kind === "airstrike") {
        this.mesh.scale.setScalar(0.4);
        this.mesh.position.set(0.36, -0.28, -0.58);
        this.mesh.rotation.set(0.1, -0.7, 0.15);
        this.kind = "item";
      } else {
        this.mesh.scale.setScalar(0.42);
        this.mesh.position.set(0.4, -0.27, -0.62);
        this.mesh.rotation.set(0.05, -1.05, 0.28);
        this.kind = "item";
      }
      if (model.gun) {
        this.flash.position.copy(MUZZLE[model.gun]).add(new THREE.Vector3(0, 0, -0.06));
        this.flash.scale.setScalar(model.gun === "bazooka" ? 0.55 : 0.32);
        this.mesh.add(this.flash);
      }
    }
    this.base = { pos: this.mesh.position.clone(), rot: this.mesh.rotation.clone() };
    bindEntityLight(this.mesh, () => this.light);
    this.pivot.add(this.mesh);
  }

  swing() {
    if (this.kind === "gun") return; // guns recoil instead
    if (this._swing >= 0.5) this._swing = 0;
  }

  // Fires the held gun: recoil kick and a muzzle flash.
  fire(power = 1) {
    this._kick = 1;
    this._kickPower = power;
    this._flash = 0;
  }

  get swinging() {
    return this._swing < 1;
  }

  // camera: the world camera (the held item is lit as if it faced the same
  // way). eating: seconds spent eating so far (0 = not eating).
  update(dt, player, light, camera, eating = 0) {
    this.light = light;
    this.camera.quaternion.copy(camera.quaternion);
    this.pivot.quaternion.copy(camera.quaternion);
    this._swing = Math.min(1, this._swing + dt / SWING_TIME);
    if (this._equip < 1) {
      this._equip = Math.min(1, this._equip + dt / EQUIP_TIME);
      if (this._pendingId !== null && this._equip >= 0.5) {
        this._apply(this._pendingId);
        this._pendingId = null;
      }
    }
    const m = this.mesh;
    const b = this.base;
    m.position.copy(b.pos);
    m.rotation.copy(b.rot);

    // Swing: a quick downward arc toward the center of the screen.
    const s = Math.sin(this._swing * Math.PI);
    const s2 = Math.sin(Math.sqrt(this._swing) * Math.PI);
    m.position.x -= s2 * 0.22;
    m.position.y += Math.sin(this._swing * Math.PI * 2) * 0.06;
    m.position.z -= s * 0.16;
    m.rotation.x -= s * 0.9;
    m.rotation.y += s2 * 0.25;

    // Equip: dip down and come back up with the new item.
    const eq = this._equip < 1 ? Math.sin(this._equip * Math.PI) : 0;
    m.position.y -= eq * 0.45;

    // Recoil: the gun jumps back and tips up, then settles.
    this._kick = Math.max(0, this._kick - dt * 7);
    if (this.kind === "gun" && this._kick > 0) {
      const k = this._kick * this._kick * this._kickPower;
      m.position.z += k * 0.12;
      m.position.y += k * 0.03;
      m.rotation.x += k * 0.35;
    }
    this._flash += dt;
    this._flashFrames = this._flash === dt ? 0 : (this._flashFrames || 0) + 1;
    // Visible for 50 ms, and always for at least one rendered frame.
    this.flash.visible = this._flash < 0.05 || this._flashFrames < 1;
    if (this.flash.visible) this.flash.material.rotation = Math.random() * Math.PI;

    // Drawing back a throw.
    if (this.windUp > 0) {
      const w = Math.min(1, this.windUp);
      m.position.x += w * 0.08;
      m.position.y += w * 0.12;
      m.position.z += w * 0.22;
      m.rotation.x -= w * 0.5;
    }

    // Eating: bring the food up to the mouth and nibble.
    if (eating > 0) {
      const k = Math.min(1, eating / 0.2);
      m.position.x -= 0.3 * k;
      m.position.y += (0.12 + Math.abs(Math.sin(eating * 18)) * 0.04) * k;
      m.position.z += 0.1 * k;
      m.rotation.y += 0.6 * k;
    }

    // Walk bob.
    const phase = player.walkPhase;
    const amount = player.onGround && !player.flying ? 1 : 0;
    m.position.x += Math.sin(phase) * 0.018 * amount;
    m.position.y -= Math.abs(Math.cos(phase)) * 0.028 * amount;
    this.pivot.visible = this.visible;
  }
}
