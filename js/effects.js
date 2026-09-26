// Signature feature: the Blast Orb — a thrown projectile that explodes on impact,
// carving a spherical crater out of the terrain and spawning a particle burst.
import * as THREE from "three";
import { BLOCK } from "./blocks.js";

const GRAVITY = -18;
const ORB_SPEED = 18;
const BLAST_RADIUS = 3;
const COOLDOWN = 3;

export class EffectsSystem {
  constructor(scene, world, audio) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.projectiles = [];
    this.particles = [];
    this.cooldown = 0;

    const orbGeo = new THREE.SphereGeometry(0.18, 10, 8);
    this.orbMaterial = new THREE.MeshBasicMaterial({ color: 0xff8c3c });
    this._orbGeo = orbGeo;

    const particleGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    this._particleGeo = particleGeo;
    this._particleMat = new THREE.MeshBasicMaterial({ color: 0xffb066 });
  }

  canThrow() {
    return this.cooldown <= 0;
  }

  throwOrb(origin, direction) {
    if (!this.canThrow()) return false;
    this.cooldown = COOLDOWN;
    const mesh = new THREE.Mesh(this._orbGeo, this.orbMaterial);
    mesh.position.copy(origin);
    const light = new THREE.PointLight(0xff8c3c, 1.5, 6);
    mesh.add(light);
    this.scene.add(mesh);
    this.projectiles.push({
      mesh,
      velocity: direction.clone().normalize().multiplyScalar(ORB_SPEED),
      life: 4,
    });
    if (this.audio) this.audio.playThrow();
    return true;
  }

  _explode(position) {
    const cx = Math.round(position.x);
    const cy = Math.round(position.y);
    const cz = Math.round(position.z);
    const r = BLAST_RADIUS;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          const wx = cx + dx;
          const wy = cy + dy;
          const wz = cz + dz;
          if (this.world.getBlock(wx, wy, wz) !== BLOCK.AIR) {
            this.world.setBlock(wx, wy, wz, BLOCK.AIR);
          }
        }
      }
    }
    if (this.audio) this.audio.playExplosion();
    this._spawnParticles(position);
  }

  _spawnParticles(position) {
    const count = 22;
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this._particleGeo, this._particleMat);
      mesh.position.copy(position);
      this.scene.add(mesh);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      const speed = 3 + Math.random() * 4;
      const velocity = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta)
      ).multiplyScalar(speed);
      this.particles.push({ mesh, velocity, life: 0.6 + Math.random() * 0.4 });
    }
  }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.velocity.y += GRAVITY * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.life -= dt;

      const bx = Math.floor(p.mesh.position.x);
      const by = Math.floor(p.mesh.position.y);
      const bz = Math.floor(p.mesh.position.z);
      const hit = this.world.getBlock(bx, by, bz) !== BLOCK.AIR;

      if (hit || p.life <= 0) {
        this._explode(p.mesh.position);
        this.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.velocity.y += GRAVITY * 0.6 * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.life -= dt;
      const s = Math.max(0, p.life);
      p.mesh.scale.setScalar(s);
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
      }
    }
  }
}
