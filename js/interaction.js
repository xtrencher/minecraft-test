// What the player does with the mouse and the item in hand: mining blocks
// (timed by hardness and tool in survival, instant in creative) with a crack
// overlay, drops and tool wear; placing blocks; eating food; opening
// crafting tables; dropping items (Q); creative pick-block (middle click).
// Melee attacks go through `entityTarget`, which the mob system provides.
import * as THREE from "three";
import { BLOCK, BLOCK_INFO, IS_REPLACEABLE, SHAPE, SHAPE_OF, isSupportedBy } from "./blocks.js";
import { itemInfo, breakTime, blockDrops, canHarvest } from "./items.js";
import { buildCrackStages } from "./itemtextures.js";
import { selectionBox } from "./world.js";
import { HOTBAR_SIZE, makeStack } from "./inventory.js";
import { SEA_LEVEL } from "./constants.js";
import { MAX_HEALTH } from "./player.js";

const REACH_SURVIVAL = 4.5;
const REACH_CREATIVE = 6;
const BREAK_DELAY = 0.25; // pause after breaking a block before the next one starts (survival)
const CREATIVE_BREAK_REPEAT = 0.22;
const PLACE_REPEAT = 0.22;
const EAT_TIME = 1.1;

function createOutline() {
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
  const material = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.7 });
  const outline = new THREE.LineSegments(edges, material);
  outline.visible = false;
  return outline;
}

function createCrackMesh() {
  const textures = buildCrackStages().map((canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
  const material = new THREE.MeshBasicMaterial({
    map: textures[0],
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.006, 1.006, 1.006), material);
  mesh.visible = false;
  mesh.renderOrder = 5;
  return { mesh, textures };
}

export class Interaction {
  constructor({ scene, world, player, inventory, entities, audio, effects, held }) {
    this.world = world;
    this.player = player;
    this.inventory = inventory;
    this.entities = entities;
    this.audio = audio;
    this.effects = effects;
    this.held = held;

    this.outline = createOutline();
    scene.add(this.outline);
    const crack = createCrackMesh();
    this.crackMesh = crack.mesh;
    this.crackTextures = crack.textures;
    scene.add(this.crackMesh);

    this.target = null; // block raycast hit
    this.leftDown = false;
    this.rightDown = false;
    this.mining = null; // { x, y, z, id, progress, time }
    this._breakCooldown = 0;
    this._placeTimer = 0;
    this._digSoundTimer = 0;
    this.eating = 0; // seconds spent eating the held food (0 = not eating)
    this._eatSoundTimer = 0;
    this._color = new THREE.Color();

    // Hooks set by the game.
    this.onOpenTable = null; // () => void
    this.onChange = null; // () => void: inventory contents changed
    // Mob system: (origin, dir, reach) => { distance, attack(tool) } or null.
    this.entityTarget = null;
    this.canPlaceAt = null; // (x, y, z) => bool: false if a mob stands there
  }

  get reach() {
    return this.player.creative ? REACH_CREATIVE : REACH_SURVIVAL;
  }

  _tool() {
    const s = this.inventory.selectedStack;
    return s ? itemInfo(s.id)?.tool ?? null : null;
  }

  _changed() {
    if (this.onChange) this.onChange();
  }

  // ---------- Input ----------

  mouseDown(button) {
    if (button === 0) {
      this.leftDown = true;
      this._breakCooldown = 0;
      this._primary();
    } else if (button === 2) {
      this.rightDown = true;
      this._placeTimer = 0;
      this._use();
    } else if (button === 1) {
      this._pickBlock();
    }
  }

  mouseUp(button) {
    if (button === 0) {
      this.leftDown = false;
      this._stopMining();
    } else if (button === 2) {
      this.rightDown = false;
      this.eating = 0;
    }
  }

  release() {
    this.leftDown = false;
    this.rightDown = false;
    this.eating = 0;
    this._stopMining();
  }

  // Q: throw one of the held item (the whole stack with Ctrl).
  dropSelected(all) {
    const s = this.inventory.selectedStack;
    if (!s) return;
    const dropped = this.inventory.consumeSelected(all ? s.count : 1);
    this.throwStack(dropped);
    this.held.swing();
    this._changed();
  }

  // Throws a stack out in front of the player.
  throwStack(stack) {
    if (!stack) return;
    const eye = this.player.getEyePosition();
    const dir = this.player.getForwardVector();
    const pos = eye.clone().addScaledVector(dir, 0.4);
    pos.y -= 0.35;
    const vel = dir.clone().multiplyScalar(5.5);
    vel.y += 1.8;
    this.entities.spawn(stack.id, stack.count, pos, vel, { dur: stack.dur, pickupDelay: 1.6 });
  }

  // ---------- Targeting ----------

  updateTarget(active) {
    if (!active) {
      this.target = null;
      this.outline.visible = false;
      this.crackMesh.visible = false;
      return;
    }
    const origin = this.player.getEyePosition();
    const dir = this.player.getForwardVector();
    this.target = this.world.raycast(origin, dir, this.reach);
    // A mob in front of the block takes the crosshair.
    this.entityHit = this.entityTarget ? this.entityTarget(origin, dir, this.reach) : null;
    if (this.entityHit && this.target && this.target.distance < this.entityHit.distance) this.entityHit = null;
    if (this.entityHit) this.target = null;

    if (this.target) {
      const [bx, by, bz] = this.target.block;
      const box = selectionBox(this.target.id);
      this.outline.scale.set(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
      this.outline.position.set(bx + (box[0] + box[3]) / 2, by + (box[1] + box[4]) / 2, bz + (box[2] + box[5]) / 2);
      this.outline.visible = true;
    } else {
      this.outline.visible = false;
    }
  }

  // ---------- Left button: attack / mine ----------

  _primary() {
    this.held.swing();
    if (this.entityHit) {
      this.entityHit.attack(this._tool(), this.inventory);
      this._changed();
      return;
    }
    if (this.target) this._startMining();
  }

  _startMining() {
    const [x, y, z] = this.target.block;
    const id = this.world.getBlock(x, y, z);
    if (id === BLOCK.AIR) return;
    if (this.player.creative) {
      this._breakBlock(x, y, z, id, false);
      this._breakCooldown = CREATIVE_BREAK_REPEAT;
      return;
    }
    const time = breakTime(id, this._tool());
    this.mining = { x, y, z, id, progress: 0, time };
    this._digSoundTimer = 0;
    if (time === 0) {
      this._breakBlock(x, y, z, id, true);
      this.mining = null;
      this._breakCooldown = BREAK_DELAY;
    }
  }

  _stopMining() {
    this.mining = null;
    this.crackMesh.visible = false;
  }

  _updateMining(dt) {
    if (!this.leftDown) return;
    if (this._breakCooldown > 0) {
      this._breakCooldown -= dt;
      if (this._breakCooldown > 0) return;
    }
    if (this.entityHit) {
      // Holding the button against a mob keeps swinging at it (cooldown in the mob system).
      this._stopMining();
      if (!this.held.swinging) this._primary();
      return;
    }
    if (!this.target) {
      this._stopMining();
      return;
    }
    const [x, y, z] = this.target.block;
    const m = this.mining;
    if (!m || m.x !== x || m.y !== y || m.z !== z || this.world.getBlock(x, y, z) !== m.id) {
      this._startMining();
      return;
    }
    if (!this.held.swinging) this.held.swing();
    if (m.time === Infinity) return; // unbreakable (bedrock)
    m.progress += dt / m.time;
    this._digSoundTimer -= dt;
    if (this._digSoundTimer <= 0) {
      this._digSoundTimer = 0.24;
      this.audio.playDig(BLOCK_INFO[m.id].sound);
      this._hitParticles(x, y, z, m.id, this.target.normal, 2);
    }
    if (m.progress >= 1) {
      this._breakBlock(x, y, z, m.id, true);
      this._stopMining();
      this._breakCooldown = BREAK_DELAY;
    }
  }

  _breakBlock(x, y, z, id, survival) {
    const world = this.world;
    const tool = this._tool();
    if (!world.setBlock(x, y, z, BLOCK.AIR)) return;
    this.audio.playBreak(BLOCK_INFO[id].sound);
    this._hitParticles(x, y, z, id, null, 14);
    // A block mined next to the sea lets the water in.
    if (y <= SEA_LEVEL) this.effects.floodInto([x, y, z, id]);
    if (!survival) return;
    for (const [itemId, count] of blockDrops(id, tool)) {
      this.entities.spawn(itemId, count, new THREE.Vector3(x + 0.5, y + 0.25, z + 0.5));
    }
    if (tool && BLOCK_INFO[id].hardness > 0) {
      if (this.inventory.damageSelected(1)) this.audio.playToolBreak();
    }
    this._changed();
  }

  // Items dropped by blocks that break on their own (a torch whose wall was
  // mined, a flower whose soil was removed).
  blockPopped(x, y, z, id) {
    if (this.player.creative) return;
    for (const [itemId, count] of blockDrops(id, null)) {
      this.entities.spawn(itemId, count, new THREE.Vector3(x + 0.5, y + 0.25, z + 0.5));
    }
  }

  _hitParticles(x, y, z, id, normal, count) {
    const rgb = this.world.blockColors[id] || [0.6, 0.6, 0.6];
    const c = this._color;
    const box = selectionBox(id);
    for (let i = 0; i < count; i++) {
      let px = x + box[0] + Math.random() * (box[3] - box[0]);
      let py = y + box[1] + Math.random() * (box[4] - box[1]);
      let pz = z + box[2] + Math.random() * (box[5] - box[2]);
      if (normal) {
        // Chips fly off the face being hit.
        if (normal[0]) px = x + (normal[0] > 0 ? 1.05 : -0.05);
        if (normal[1]) py = y + (normal[1] > 0 ? 1.05 : -0.05);
        if (normal[2]) pz = z + (normal[2] > 0 ? 1.05 : -0.05);
      }
      const shade = 0.7 + Math.random() * 0.4;
      c.setRGB(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade, THREE.SRGBColorSpace);
      const n = normal || [0, 0, 0];
      this.effects.debris.spawn(
        px, py, pz,
        (Math.random() - 0.5) * 3 + n[0] * 2,
        Math.random() * 3 + 1 + n[1] * 2,
        (Math.random() - 0.5) * 3 + n[2] * 2,
        0.06 + Math.random() * 0.06,
        c,
        0.5 + Math.random() * 0.5
      );
    }
  }

  // ---------- Right button: use / place / eat ----------

  _use() {
    const stack = this.inventory.selectedStack;
    const info = stack ? itemInfo(stack.id) : null;
    const t = this.target;
    // Crafting tables open (sneak to place against them instead).
    if (t && t.id === BLOCK.CRAFTING_TABLE && !this.player.sneaking) {
      this.release();
      if (this.onOpenTable) this.onOpenTable();
      return;
    }
    if (info?.food) {
      if (!this.player.creative && this.player.health < MAX_HEALTH) this.eating = 0.0001;
      return;
    }
    if (info?.block) this._place(stack.id);
  }

  _place(blockId) {
    const t = this.target;
    if (!t) return;
    // Placing onto something replaceable (tall grass) replaces it in place.
    const [px, py, pz] = IS_REPLACEABLE[t.id] ? t.block : t.place;
    const world = this.world;
    if (!IS_REPLACEABLE[world.getBlock(px, py, pz)]) return;
    if (BLOCK_INFO[blockId].solid && this._overlapsPlayer(px, py, pz)) return;
    if (BLOCK_INFO[blockId].solid && this.canPlaceAt && !this.canPlaceAt(px, py, pz)) return;
    if (!isSupportedBy(blockId, world.getBlock(px, py - 1, pz))) return;
    if (!world.setBlock(px, py, pz, blockId)) return;
    this.audio.playPlace(BLOCK_INFO[blockId].sound);
    this.held.swing();
    if (!this.player.creative) this.inventory.consumeSelected(1);
    this._changed();
  }

  _overlapsPlayer(bx, by, bz) {
    const p = this.player.position;
    const r = 0.3;
    const overlapsXZ = bx + 1 > p.x - r && bx < p.x + r && bz + 1 > p.z - r && bz < p.z + r;
    const overlapsY = by + 1 > p.y && by < p.y + 1.8;
    return overlapsXZ && overlapsY;
  }

  _updateUse(dt) {
    if (!this.rightDown) return;
    const stack = this.inventory.selectedStack;
    const info = stack ? itemInfo(stack.id) : null;
    if (this.eating > 0) {
      if (!info?.food || this.player.creative) {
        this.eating = 0;
        return;
      }
      this.eating += dt;
      this._eatSoundTimer -= dt;
      if (this._eatSoundTimer <= 0) {
        this._eatSoundTimer = 0.21;
        this.audio.playEat();
      }
      if (this.eating >= EAT_TIME) {
        this.player.heal(info.food);
        this.inventory.consumeSelected(1);
        this.audio.playBurp();
        this.eating = 0;
        this._changed();
      }
      return;
    }
    this._placeTimer += dt;
    if (this._placeTimer >= PLACE_REPEAT) {
      this._placeTimer = 0;
      this._use();
    }
  }

  // Creative: middle click puts the targeted block in the hotbar.
  _pickBlock() {
    if (!this.player.creative || !this.target) return;
    const id = this.target.id;
    if (!itemInfo(id)) return;
    const inv = this.inventory;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (inv.slots[i] && inv.slots[i].id === id) {
        inv.selected = i;
        return;
      }
    }
    let slot = inv.selected;
    if (inv.slots[slot]) {
      const empty = inv.slots.slice(0, HOTBAR_SIZE).findIndex((s) => !s);
      if (empty >= 0) slot = empty;
    }
    inv.slots[slot] = makeStack(id, 64);
    inv.selected = slot;
    this._changed();
  }

  // ---------- Per frame ----------

  update(dt) {
    this._updateMining(dt);
    this._updateUse(dt);

    // Crack overlay on the block being mined.
    const m = this.mining;
    if (m && m.progress > 0 && m.time !== Infinity && SHAPE_OF[m.id] === SHAPE.CUBE) {
      const stage = Math.min(9, Math.floor(m.progress * 10));
      if (this.crackMesh.material.map !== this.crackTextures[stage]) {
        this.crackMesh.material.map = this.crackTextures[stage];
        this.crackMesh.material.needsUpdate = true;
      }
      this.crackMesh.position.set(m.x + 0.5, m.y + 0.5, m.z + 0.5);
      this.crackMesh.visible = true;
    } else {
      this.crackMesh.visible = false;
    }
  }

  // Progress of the block being mined (0-1), for tests and the HUD.
  get miningProgress() {
    return this.mining ? Math.min(1, this.mining.progress) : 0;
  }

  // Whether the held tool can harvest the targeted block (e.g. for hints).
  get canHarvestTarget() {
    return this.target ? canHarvest(this.target.id, this._tool()) : false;
  }
}
