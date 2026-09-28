// The player's own body, shown in the third-person camera modes (F5): the
// "player" box model from mob-models.js, lit by the voxel light where the
// player stands, with the held item in its right hand. It walks, sneaks,
// looks where the player looks, and swings its arm when the first-person
// view would.
import * as THREE from "three";
import { createMobModel } from "./mob-models.js";
import { itemModel } from "./models.js";
import { itemInfo } from "./items.js";
import { createEntityMaterial, bindEntityLight } from "./shaders.js";

const PX = 1 / 16;
const GUN_BASIS = new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));

export class PlayerAvatar {
  constructor(scene, atlas) {
    this.model = createMobModel("player");
    this.root = this.model.root;
    this.root.visible = false;
    scene.add(this.root);
    this.light = { sky: 15, block: 0 };
    bindEntityLight(this.root, () => this.light);
    this.materials = {
      array: createEntityMaterial("array", atlas),
      color: createEntityMaterial("color"),
    };
    // The item sits in a socket at the right hand (the arm hangs 10 px down).
    this.socket = new THREE.Group();
    this.socket.position.set(0, -10 * PX, 1.2 * PX);
    this.model.parts.armR.add(this.socket);
    this.itemId = null;
    this.itemMesh = null;
    this._walk = 0;
    this._bodyYaw = 0;
  }

  setItem(id) {
    id = id || 0;
    if (id === this.itemId) return;
    this.itemId = id;
    if (this.itemMesh) {
      this.socket.remove(this.itemMesh);
      this.itemMesh = null;
    }
    const model = id ? itemModel(id) : null;
    if (!model) return;
    const mesh = new THREE.Mesh(model.geometry, this.materials[model.kind]);
    mesh.castShadow = true;
    if (model.cube) {
      mesh.scale.setScalar(0.28);
      mesh.rotation.set(0, Math.PI / 4, 0);
      mesh.position.set(0, -0.05, 0.08);
    } else if (model.gun) {
      // Guns point along the arm's "forward" when it's raised to aim.
      // The barrel (-Z) runs out along the arm (-Y), the top faces +Z.
      mesh.scale.setScalar(model.gun === "pistol" ? 0.55 : 0.75);
      mesh.setRotationFromMatrix(GUN_BASIS);
      mesh.position.set(0, -0.02, 0.05);
    } else {
      // Tools and sprites: held upright, blade forward.
      mesh.scale.setScalar(0.55);
      mesh.rotation.set(0, -Math.PI / 2, Math.PI / 4);
      mesh.position.set(0, 0.05, 0.12);
    }
    bindEntityLight(mesh, () => this.light);
    this.itemMesh = mesh;
    this.socket.add(mesh);
  }

  // visible: third person. swing: 0-1 progress of the arm swing (1 = idle).
  update(dt, player, light, { visible, swing = 1, heldId = 0 }) {
    this.root.visible = visible && !player.dead;
    if (!this.root.visible) return;
    this.light = light;
    this.setItem(heldId);
    const p = player.position;
    this.root.position.set(p.x, p.y, p.z);
    // The body turns with the view, the head follows at once; while walking
    // the body lines up with the view quickly, standing still it lags a bit.
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    const moving = speed > 0.5 && player.onGround;
    this._walk += ((moving ? Math.min(1, speed / 4.6) : 0) - this._walk) * Math.min(1, dt * 10);
    let diff = player.yaw - this._bodyYaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const maxLag = 0.75;
    if (moving) this._bodyYaw += diff * Math.min(1, dt * 12);
    else if (Math.abs(diff) > maxLag) this._bodyYaw += diff - Math.sign(diff) * maxLag;
    diff = Math.atan2(Math.sin(player.yaw - this._bodyYaw), Math.cos(player.yaw - this._bodyYaw));
    this.root.rotation.y = this._bodyYaw + Math.PI;
    const weapon = itemInfo(heldId)?.weapon?.kind;
    const aim = weapon === "pistol" ? "one" : weapon && weapon !== "grenade" && weapon !== "airstrike" ? "two" : null;
    this.model.animate({
      walkPhase: player.walkPhase,
      walk: this._walk,
      headPitch: player.pitch,
      headYaw: diff,
      swing,
      sneak: player.sneaking,
      aim,
    });
  }
}
