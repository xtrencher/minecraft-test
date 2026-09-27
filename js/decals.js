// Bullet holes: small dark marks left on block faces by gunshots. A fixed
// pool (the oldest mark is reused); a mark disappears when its block
// changes. Painted in code like everything else.
import * as THREE from "three";

const MAX_DECALS = 96;
const SIZE = 0.16;

function makeHoleTexture() {
  const N = 32;
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(N, N);
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  // Ragged crater: a dark core, a chipped rim, a few short cracks.
  const cracks = [];
  for (let i = 0; i < 5; i++) cracks.push({ a: rand() * Math.PI * 2, len: 0.55 + rand() * 0.45 });
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5) / N - 0.5;
      const dy = (y + 0.5) / N - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const a = Math.atan2(dy, dx);
      const rim = 0.42 + Math.sin(a * 7 + 1.3) * 0.05 + (rand() - 0.5) * 0.06;
      let v = -1;
      let alpha = 0;
      if (r < rim * 0.55) {
        v = 10;
        alpha = 250;
      } else if (r < rim) {
        v = 38 + rand() * 20;
        alpha = 220;
      } else if (r < rim + 0.12) {
        v = 70;
        alpha = 90;
      }
      for (const c of cracks) {
        let da = Math.abs(a - c.a);
        da = Math.min(da, Math.PI * 2 - da);
        if (r > rim * 0.8 && r < c.len * 1.8 && da * r * N < 0.9) {
          v = 30;
          alpha = Math.max(alpha, 170);
        }
      }
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, v);
      img.data[i + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

export class BulletHoles {
  constructor(scene, world) {
    this.world = world;
    const material = new THREE.MeshBasicMaterial({
      map: makeHoleTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: true,
    });
    const geometry = new THREE.PlaneGeometry(SIZE, SIZE);
    this.decals = [];
    for (let i = 0; i < MAX_DECALS; i++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 4;
      scene.add(mesh);
      this.decals.push({ mesh, cell: null });
    }
    this.next = 0;
    world.changeListeners.push((changed) => this._onChanged(changed));
  }

  get count() {
    return this.decals.filter((d) => d.mesh.visible).length;
  }

  // Leaves a mark at `point` on the face of block `cell` ([x, y, z]) whose
  // outward normal is `normal` ([nx, ny, nz]).
  add(point, cell, normal) {
    const d = this.decals[this.next];
    this.next = (this.next + 1) % MAX_DECALS;
    const n = new THREE.Vector3(normal[0], normal[1], normal[2]);
    d.mesh.position.copy(point).addScaledVector(n, 0.004);
    d.mesh.lookAt(d.mesh.position.clone().add(n));
    d.mesh.rotateZ(Math.random() * Math.PI * 2);
    d.mesh.scale.setScalar(0.8 + Math.random() * 0.4);
    d.mesh.visible = true;
    d.cell = cell.slice();
    d.id = this.world.getBlock(cell[0], cell[1], cell[2]);
  }

  // After any edit, marks whose block is gone (or replaced) disappear. This
  // checks the (few) marks rather than the (possibly huge) list of changes.
  _onChanged() {
    for (const d of this.decals) {
      if (!d.mesh.visible) continue;
      if (this.world.getBlock(d.cell[0], d.cell[1], d.cell[2]) !== d.id) {
        d.mesh.visible = false;
        d.cell = null;
      }
    }
  }
}
