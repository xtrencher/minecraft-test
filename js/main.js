import * as THREE from "three";
import { World, SEA_LEVEL } from "./world.js";
import { Player, MAX_HEALTH, MAX_AIR } from "./player.js";
import { UI, isMobileDevice } from "./ui.js";
import { BLOCK, BLOCK_INFO, HOTBAR } from "./blocks.js";
import { Audio } from "./audio.js";
import { Sky } from "./sky.js";
import { loadEdits, saveEdits, loadSettings, saveSettings, loadPlayer, savePlayer } from "./storage.js";
import { EffectsSystem } from "./effects.js";
import { PostFX } from "./postfx.js";
import { PRESETS, applyPreset, normalizePreset } from "./graphics.js";
import { worldUniforms } from "./shaders.js";
import { Inventory, HOTBAR_SIZE, makeStack } from "./inventory.js";
import { itemInfo } from "./items.js";
import { IconCache } from "./slot-view.js";
import { Hud } from "./hud.js";
import { InventoryScreen } from "./inventory-ui.js";
import { ItemEntities } from "./entities.js";
import { HeldItem } from "./held-item.js";
import { Interaction } from "./interaction.js";
import { MobManager } from "./mobs.js";
import { isUnderwater, surfaceHeight } from "./water.js";
import { FallingBlocks } from "./falling.js";
import { WeaponSystem } from "./weapons.js";
import { BulletHoles } from "./decals.js";
import { GRENADE_RADIUS } from "./effects.js";

// ---------- Seed ----------
function parseSeedFromURL() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("seed");
  if (raw !== null && raw !== "" && !Number.isNaN(Number(raw))) {
    return Math.abs(Math.floor(Number(raw))) >>> 0;
  }
  return Math.floor(Math.random() * 2147483647) >>> 0;
}

const SEED = parseSeedFromURL();

// ---------- Mobile guard ----------
if (isMobileDevice()) {
  document.getElementById("mobile-block").classList.remove("hidden");
  throw new Error("Voxelands: mobile device detected, game not started.");
}

// ---------- Renderer / scene / camera ----------
const canvas = document.getElementById("game-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
if (!renderer.capabilities.isWebGL2) {
  document.getElementById("webgl-block").classList.remove("hidden");
  throw new Error("Voxelands: WebGL 2 is required.");
}
renderer.setSize(window.innerWidth, window.innerHeight);
// Used only when post-processing is off (Low preset); otherwise the
// composite pass tone-maps with the same ACES curve.
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();

// ---------- Settings ----------
const DEFAULT_RENDER_DISTANCE = 10;
const MIN_RENDER_DISTANCE = 2;
const MAX_RENDER_DISTANCE = 16;
const settings = loadSettings();

function clampRenderDistance(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_RENDER_DISTANCE;
  return Math.max(MIN_RENDER_DISTANCE, Math.min(MAX_RENDER_DISTANCE, n));
}

let renderDistance = clampRenderDistance(settings.renderDistance ?? DEFAULT_RENDER_DISTANCE);
let graphicsPreset = normalizePreset(settings.graphics);

// Built-in three.js materials (debris, particles) use this fog; the world's
// own shaders use the shared uniforms in shaders.js (same distances).
scene.fog = new THREE.Fog(0x9fc3e8, 60, 150);

function updateFogDistances() {
  const end = (renderDistance - 0.3) * 16;
  const start = end * 0.72;
  worldUniforms.uFog.value.set(start, end, 0.0024, 0.0);
  scene.fog.near = start;
  scene.fog.far = end;
}
updateFogDistances();

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

// The light rig never changes shape at runtime (adding/removing lights would
// force every lit material to recompile): one shadow-casting directional
// light (sun or moon), one hemisphere light for built-in materials.
const hemiLight = new THREE.HemisphereLight(0xbfd6ff, 0x3a3228, 1);
scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xffffff, 1);
scene.add(sunLight);
scene.add(sunLight.target);

const postfx = new PostFX(renderer);
const drawingSize = new THREE.Vector2();
let held = null;
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.getDrawingBufferSize(drawingSize);
  postfx.setSize(drawingSize.x, drawingSize.y);
  if (held) held.resize(camera.aspect);
}
window.addEventListener("resize", onResize);

// ---------- World ----------
const world = new World(scene, SEED);
world.loadEdits(loadEdits(SEED));

let pendingSave = false;
let lastSaveTime = 0;
world.onEdit = () => {
  pendingSave = true;
};

// Encoded form of each edited chunk, reused between saves so only chunks
// changed since the last save get re-encoded.
const encodedEditCache = new Map();

function findSpawnColumn() {
  let bestX = 0;
  let bestZ = 0;
  for (let r = 0; r < 40; r += 4) {
    const h = world.heightAt(bestX, bestZ);
    if (h > SEA_LEVEL + 1) return [bestX, bestZ];
    bestX += 6;
    bestZ += 4;
  }
  return [bestX, bestZ];
}

const [spawnX, spawnZ] = findSpawnColumn();

// A saved player (position, inventory, ...) for this world, if any.
const savedPlayer = loadPlayer(SEED);
const savedPos = Array.isArray(savedPlayer?.pos) && savedPlayer.pos.length === 3 && savedPlayer.pos.every(Number.isFinite) ? savedPlayer.pos : null;
const startX = savedPos ? savedPos[0] : spawnX + 0.5;
const startZ = savedPos ? savedPos[2] : spawnZ + 0.5;

// Synchronously generate just the chunks right around the start so the
// player never falls through unloaded terrain; everything else out to the
// full render distance streams in over the next frames (while the start
// menu is showing), instead of freezing the page for seconds at startup.
const INITIAL_SYNC_RADIUS = 2;
world.prepareArea(startX, startZ, INITIAL_SYNC_RADIUS);
world.ensureChunksAround(startX, startZ, renderDistance);

// Main-thread milliseconds per frame spent generating/meshing chunks. Larger
// while a menu is open (nothing to keep smooth), smaller while playing.
const STREAM_BUDGET_PLAYING_MS = 5;
const STREAM_BUDGET_MENU_MS = 14;

// ---------- Player, inventory, HUD ----------
const ui = new UI();
ui.renderDistanceInput.min = String(MIN_RENDER_DISTANCE);
ui.renderDistanceInput.max = String(MAX_RENDER_DISTANCE);
ui.renderDistanceInput.value = String(renderDistance);
ui.renderDistanceValueEl.textContent = String(renderDistance);
ui.graphicsSelect.value = graphicsPreset;

const player = new Player(camera, world, canvas);
const inventory = new Inventory();
const audio = new Audio();
const sky = new Sky(scene, sunLight, hemiLight);
const effects = new EffectsSystem(scene, world, audio);
const icons = new IconCache(world.tileCanvases);
const hud = new Hud({ icons, inventory });
const entities = new ItemEntities(scene, world);
held = new HeldItem(world.atlas);
held.resize(camera.aspect);
const interaction = new Interaction({ scene, world, player, inventory, entities, audio, effects, held });
const invScreen = new InventoryScreen({ icons, inventory, audio });
const mobs = new MobManager({ scene, world, player, entities, audio, effects, sky });
const falling = new FallingBlocks(scene, world);
const decals = new BulletHoles(scene, world);
const weapons = new WeaponSystem({ scene, world, player, effects, audio, mobs, held, decals });
interaction.weapons = weapons;
interaction.combat = mobs;

// The creative starter hotbar (the classic building blocks).
function fillCreativeHotbar() {
  HOTBAR.forEach((id, i) => {
    if (i < HOTBAR_SIZE && !inventory.slots[i]) inventory.slots[i] = makeStack(id, 64);
  });
}

if (savedPlayer) {
  player.setMode(savedPlayer.mode);
  if (savedPos) {
    player.position.set(savedPos[0], savedPos[1], savedPos[2]);
    // Stuck in terrain (e.g. edits lost)? Stand on top instead.
    if (world.isSolidAt(Math.floor(savedPos[0]), Math.floor(savedPos[1] + 0.1), Math.floor(savedPos[2]))) {
      player.spawnAt(Math.floor(savedPos[0]), Math.floor(savedPos[2]));
    }
  } else {
    player.spawnAt(spawnX, spawnZ);
  }
  if (Number.isFinite(savedPlayer.yaw)) player.yaw = savedPlayer.yaw;
  if (Number.isFinite(savedPlayer.pitch)) player.pitch = Math.max(-1.55, Math.min(1.55, savedPlayer.pitch));
  if (Number.isFinite(savedPlayer.health)) player.health = Math.max(1, Math.min(MAX_HEALTH, savedPlayer.health));
  if (Number.isFinite(savedPlayer.air)) player.air = Math.max(0, Math.min(MAX_AIR, savedPlayer.air));
  inventory.load(savedPlayer.inv);
  if (Number.isInteger(savedPlayer.sel)) inventory.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, savedPlayer.sel));
  if (Number.isFinite(savedPlayer.time)) sky.time = savedPlayer.time;
} else {
  player.spawnAt(spawnX, spawnZ);
}
let newWorld = !savedPlayer;
ui.setModeShown(player.mode);
ui.showStartMenu(SEED);
held.setItem(inventory.selectedStack?.id ?? 0, true);

function playerState() {
  // A dead player is saved as respawned: their items were dropped in the world.
  const p = player.dead ? null : player.position;
  return {
    mode: player.mode,
    pos: p ? [round3(p.x), round3(p.y), round3(p.z)] : null,
    yaw: round3(player.yaw),
    pitch: round3(player.pitch),
    health: player.dead ? MAX_HEALTH : player.health,
    air: player.dead ? MAX_AIR : round3(player.air),
    inv: inventory.serialize(),
    sel: inventory.selected,
    time: round3(sky.time),
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

let playerDirty = false;
let lastPlayerSave = 0;

function flushSave() {
  if (pendingSave) {
    saveEdits(SEED, world.edits, encodedEditCache, world.dirtyEditChunks);
    world.dirtyEditChunks.clear();
    pendingSave = false;
  }
  lastSaveTime = performance.now();
  if (!newWorld || playerDirty) {
    savePlayer(SEED, playerState());
    playerDirty = false;
    newWorld = false;
    lastPlayerSave = performance.now();
  }
}

// Leaving the page mid-game (e.g. Ctrl+W while sprinting with Ctrl) asks
// for confirmation first; the world is saved either way.
window.addEventListener("beforeunload", (e) => {
  flushSave();
  if (gameState === "playing" || gameState === "inventory") {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});

function markInventoryChanged() {
  playerDirty = true;
  hud.refreshHotbar();
  held.setItem(inventory.selectedStack?.id ?? 0);
}

interaction.onChange = markInventoryChanged;
invScreen.onChange = markInventoryChanged;
invScreen.onDrop = (stack) => interaction.throwStack(stack);
world.onBlockPopped = (x, y, z, id) => interaction.blockPopped(x, y, z, id);
falling.onBreak = (x, y, z, id) => interaction.blockPopped(x, y, z, id);

entities.onPickup = (item) => {
  if (player.dead) return item.count;
  const left = inventory.add(item.id, item.count, item.dur);
  if (left < item.count) {
    audio.playPickup();
    markInventoryChanged();
  }
  return left;
};

player.onFlightToggle = (enabled) => audio.playFlightToggle(enabled);

// ---------- Damage, death and respawn ----------
const DEATH_MESSAGES = {
  fall: "Fell from a high place",
  drown: "Drowned",
  void: "Fell out of the world",
  grenade: "Blown up by your own grenade",
  bazooka: "Blown up by your own bazooka",
  grenade_fall: "Sent flying by your own grenade",
  bazooka_fall: "Sent flying by your own bazooka",
  zombie: "Killed by a zombie",
};
let lastBlastHitTime = -Infinity;
let lastBlastSource = "grenade";
let deathCause = null;

player.onHurt = (amount, cause) => {
  hud.hurt();
  audio.playHurt();
  playerDirty = true;
};

player.onDeath = (cause) => {
  // A fall right after being launched by an explosion was the explosive's doing.
  if (cause === "fall" && performance.now() - lastBlastHitTime < 6000) cause = `${lastBlastSource}_fall`;
  deathCause = cause;
  audio.playDeath();
  if (invScreen.isOpen) invScreen.close();
  interaction.release();
  dropEverything();
  gameState = "dead";
  hud.showDeath(DEATH_MESSAGES[cause] || cause || "You died");
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  playerDirty = true;
};

// Everything in the inventory spills out where the player died.
function dropEverything() {
  const at = player.position.clone();
  at.y += 0.8;
  for (let i = 0; i < inventory.slots.length; i++) {
    const s = inventory.slots[i];
    if (!s) continue;
    const vel = new THREE.Vector3((Math.random() - 0.5) * 5, 2 + Math.random() * 3, (Math.random() - 0.5) * 5);
    entities.spawn(s.id, s.count, at, vel, { dur: s.dur, pickupDelay: 2 });
  }
  inventory.clear();
  markInventoryChanged();
}

// The column nearest the world spawn with open air (not water) above solid
// ground: a crater may have flooded the original spot.
function safeSpawnColumn() {
  for (let r = 0; r <= 24; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = spawnX + dx;
        const z = spawnZ + dz;
        const top = world.surfaceY(x, z);
        if (top >= 0 && world.getBlock(x, top + 1, z) === BLOCK.AIR && world.getBlock(x, top + 2, z) === BLOCK.AIR) return [x, z];
      }
    }
  }
  return [spawnX, spawnZ];
}

function respawn() {
  if (gameState !== "dead") return;
  hud.hideDeath();
  world.prepareArea(spawnX + 0.5, spawnZ + 0.5, INITIAL_SYNC_RADIUS);
  player.revive();
  player.spawnAt(...safeSpawnColumn());
  player.yaw = 0;
  player.pitch = 0;
  player.syncCamera();
  world.ensureChunksAround(player.position.x, player.position.z, renderDistance);
  deathCause = null;
  playerDirty = true;
  gameState = "paused";
  audio.ensureStarted();
  requestLock();
}
hud.respawnBtn.addEventListener("click", respawn);

// Explosions hurt (lethally up close) and shove the player away from the
// blast center with an upward kick, falling off with distance and scaled
// by the size of the blast (a bazooka rocket is 5 grenades wide).
effects.onExplosion = (center, radius, source) => {
  mobs.explosion(center, radius);
  const size = Math.sqrt(radius / GRENADE_RADIUS);
  const offset = player.position.clone();
  offset.y += 0.9; // body center
  offset.sub(center);
  const dist = offset.length();
  const hurtReach = radius * 1.8;
  if (dist < hurtReach && !player.dead) {
    const dmg = Math.floor(30 * size * Math.pow(1 - dist / hurtReach, 1.3));
    if (dmg > 0 && player.damage(dmg, source)) {
      lastBlastHitTime = performance.now();
      lastBlastSource = source;
    }
  }
  const reach = radius * 2.2;
  if (dist >= reach || player.dead) return;
  const strength = Math.min(40, (1 - dist / reach) * 22 * size);
  if (dist < 1e-3) offset.set(0, 1, 0);
  offset.normalize();
  offset.y = Math.max(offset.y, 0) + 0.45;
  offset.normalize().multiplyScalar(strength);
  offset.y = Math.min(offset.y, 13 * Math.min(size, 1.6));
  player.applyImpulse(offset);
  if (!player.creative) {
    lastBlastHitTime = performance.now();
    lastBlastSource = source;
  }
};

// ---------- Game mode ----------
function setMode(mode) {
  const before = player.mode;
  player.setMode(mode);
  ui.setModeShown(player.mode);
  if (player.creative && before !== "creative" && inventory.isEmpty()) {
    fillCreativeHotbar();
    markInventoryChanged();
  }
  playerDirty = true;
}

ui.modeSelect.addEventListener("change", () => setMode(ui.modeSelect.value));
ui.pauseModeSelect.addEventListener("change", () => setMode(ui.pauseModeSelect.value));

// ---------- Graphics ----------
const allWorldMaterials = [world.materials.opaque, world.materials.cutout, world.materials.water, world.materials.cutoutDepth];

function setGraphics(name, { adoptRenderDistance = false } = {}) {
  graphicsPreset = normalizePreset(name);
  const preset = applyPreset(graphicsPreset, {
    renderer,
    postfx,
    sunLight,
    sky,
    atlas: world.atlas,
    materials: allWorldMaterials,
    onResize,
  });
  if (adoptRenderDistance) setRenderDistance(preset.renderDistance);
  ui.graphicsSelect.value = graphicsPreset;
  ui.graphicsHintEl.textContent = describePreset(graphicsPreset);
  settings.graphics = graphicsPreset;
  saveSettings(settings);
}

function describePreset(name) {
  const p = PRESETS[name];
  const parts = [];
  parts.push(p.shadows ? `${p.shadows}px sun shadows` : "no shadows");
  parts.push(p.post ? "HDR bloom & color grading" : "no post-processing");
  if (p.godRays) parts.push("light shafts");
  if (p.caustics) parts.push("water caustics");
  return `${parts.join(", ")}. Suggested render distance: ${p.renderDistance}.`;
}

function setRenderDistance(value) {
  renderDistance = clampRenderDistance(value);
  ui.renderDistanceInput.value = String(renderDistance);
  ui.renderDistanceValueEl.textContent = String(renderDistance);
  updateFogDistances();
  settings.renderDistance = renderDistance;
  saveSettings(settings);
}

setGraphics(graphicsPreset);

ui.graphicsSelect.addEventListener("change", () => {
  // Picking a preset also applies its suggested render distance; the slider
  // can still be changed afterwards.
  setGraphics(ui.graphicsSelect.value, { adoptRenderDistance: true });
});

// ---------- Game state / pointer lock ----------
// "start": title menu. "playing": pointer locked, in control. "paused":
// pause menu (or waiting for the pointer to lock again). "inventory": an
// inventory/crafting screen is open (the world keeps running). "dead": the
// death screen.
let gameState = "start";

function requestLock() {
  const result = canvas.requestPointerLock();
  // Newer browsers return a promise that rejects if the lock is refused
  // (e.g. right after Esc); the pause menu then offers to resume.
  if (result && typeof result.catch === "function") result.catch(() => showPause());
}

function showPause() {
  if (gameState === "start" || gameState === "dead" || gameState === "inventory") return;
  if (document.pointerLockElement === canvas) return;
  gameState = "paused";
  player.enabled = false;
  interaction.release();
  ui.showHud(false);
  ui.showPauseMenu(SEED, renderDistance);
}

ui.playBtn.addEventListener("click", () => {
  audio.ensureStarted();
  setMode(ui.modeSelect.value);
  markInventoryChanged();
  requestLock();
});

ui.resumeBtn.addEventListener("click", () => {
  audio.ensureStarted();
  requestLock();
});

document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === canvas;
  player.setLocked(locked);
  if (locked) {
    gameState = "playing";
    player.enabled = true;
    ui.hideStartMenu();
    ui.hidePauseMenu();
    ui.showHud(true);
  } else if (gameState === "playing" || gameState === "paused") {
    showPause();
  }
});
document.addEventListener("pointerlockerror", () => showPause());

function openInventory(kind) {
  if (gameState !== "playing") return;
  interaction.release();
  gameState = "inventory";
  invScreen.open(kind, player.creative);
  document.exitPointerLock();
}

function closeInventory() {
  if (gameState !== "inventory") return;
  invScreen.close();
  gameState = "paused";
  requestLock();
}

interaction.onOpenTable = () => openInventory("table");

ui.renderDistanceInput.addEventListener("input", () => {
  setRenderDistance(ui.renderDistanceInput.value);
});

ui.copyLinkBtn.addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("seed", String(SEED));
  navigator.clipboard?.writeText(url.toString()).catch(() => {});
});

// ---------- Keyboard ----------
const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"];

function selectSlot(i) {
  inventory.selected = ((i % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
  interaction.eating = 0;
  weapons.cancel();
  markInventoryChanged();
}

window.addEventListener("keydown", (e) => {
  if (gameState === "inventory") {
    if (e.code === "KeyE" || e.code === "Escape") {
      e.preventDefault();
      closeInventory();
    } else if (invScreen.handleKey(e.code, e.ctrlKey)) {
      e.preventDefault();
    }
    return;
  }
  if (gameState !== "playing") return;
  const idx = DIGIT_CODES.indexOf(e.code);
  if (idx !== -1) selectSlot(idx);
  if (e.repeat) return;
  if (e.code === "KeyE") openInventory("inventory");
  else if (e.code === "KeyQ") interaction.dropSelected(e.ctrlKey);
});

canvas.addEventListener("wheel", (e) => {
  if (gameState !== "playing") return;
  selectSlot(inventory.selected + (e.deltaY > 0 ? 1 : -1));
});

// ---------- Mouse ----------
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

document.addEventListener("mousedown", (e) => {
  if (gameState !== "playing") return;
  if (e.button === 1) e.preventDefault();
  interaction.mouseDown(e.button);
});

document.addEventListener("mouseup", (e) => {
  interaction.mouseUp(e.button);
});

canvas.addEventListener("click", () => {
  if (gameState === "paused") requestLock();
});

// ---------- Rendering state ----------
const sunWorldPos = new THREE.Vector3();
const lookDir = new THREE.Vector3();
let eyeAdaptation = 1;
let underwater = false;
let heldLight = { sky: 15, block: 0 };

function updateEnvironment(dt) {
  const eye = player.getEyePosition();
  lookDir.copy(player.getForwardVector());
  sky.update(dt, eye, lookDir);
  worldUniforms.uTime.value += dt;

  // Under water (below the drawn, waving surface): murky blue fog and a
  // tinted, wobbly screen.
  underwater = isUnderwater(world, eye.x, eye.y, eye.z, worldUniforms.uTime.value, worldUniforms.uWaveStrength.value);
  worldUniforms.uUnderwater.value = underwater ? 1 : 0;
  const eyeLight = world.lightAt(eye.x, eye.y, eye.z);
  heldLight = eyeLight;
  const wl = Math.max(0.15, (eyeLight.sky / 15) * sky.daylight + 0.1);
  worldUniforms.uWaterFogColor.value.setRGB(0.02 * wl, 0.11 * wl, 0.16 * wl);

  // Eye adaptation: brighten gradually in dark places (caves, at night), less
  // so when a torch is nearby.
  const ambient = Math.max((eyeLight.sky / 15) * (0.25 + 0.75 * sky.daylight), (eyeLight.block / 15) * 0.9);
  const target = 1 + (1 - ambient) * 0.45;
  eyeAdaptation += (target - eyeAdaptation) * Math.min(1, dt * 1.5);

  scene.fog.color.copy(sky.horizonColor);
}

function renderFrame() {
  const exposure = sky.exposure * eyeAdaptation;
  const preset = PRESETS[graphicsPreset];
  sky.material.uniforms.uWriteSkyMask.value = preset.post ? 1 : 0;
  // The item in hand is drawn on top of the world (fresh depth buffer).
  const showHeld = gameState === "playing" || gameState === "inventory";
  const overlay = showHeld ? { scene: held.scene, camera: held.camera } : null;
  if (preset.post) {
    sunWorldPos.copy(camera.position).addScaledVector(worldUniforms.uSunDir.value, 400);
    const sunUp = THREE.MathUtils.smoothstep(worldUniforms.uSunDir.value.y, -0.02, 0.12);
    postfx.render(
      scene,
      camera,
      {
        exposure,
        sunWorldPos,
        sunColor: worldUniforms.uSunGlowColor.value,
        raysStrength: underwater ? 0 : 0.85 * sunUp,
        underwater,
        night: worldUniforms.uNight.value,
        bloomStrength: 0.11,
        time: worldUniforms.uTime.value,
      },
      overlay
    );
  } else {
    renderer.toneMappingExposure = exposure;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    if (overlay) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlay.scene, overlay.camera);
      renderer.autoClear = true;
    }
  }
}

// ---------- Debug / test hook ----------
// Exposes live game objects so the headless smoke test (tools/smoke-test.mjs)
// can verify behavior like movement direction, and for poking at the game
// from the browser dev console. Not used by any game code.
window.__voxelands = {
  THREE,
  world,
  player,
  camera,
  scene,
  renderer,
  effects,
  sky,
  postfx,
  inventory,
  entities,
  interaction,
  invScreen,
  mobs,
  falling,
  weapons,
  decals,
  audio,
  water: { isUnderwater, surfaceHeight },
  hud,
  held,
  uniforms: worldUniforms,
  spawn: { x: spawnX, z: spawnZ },
  setGraphics,
  setMode,
  respawn,
  flushSave,
  // Renders one frame and returns simple statistics of the image (mean and
  // standard deviation of luminance, share of near-black pixels). Read back
  // synchronously right after rendering, while the drawing buffer is valid.
  captureStats() {
    renderFrame();
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0;
    let sum2 = 0;
    let black = 0;
    const n = w * h;
    for (let i = 0; i < px.length; i += 4) {
      const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      sum += l;
      sum2 += l * l;
      if (l < 0.02) black++;
    }
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), blackFraction: black / n, width: w, height: h };
  },
  get graphics() {
    return graphicsPreset;
  },
  get gameState() {
    return gameState;
  },
  get renderDistance() {
    return renderDistance;
  },
  get deathCause() {
    return deathCause;
  },
};

// ---------- Main loop ----------
const clock = new THREE.Clock();
const MAX_DT = 0.05;

function animate() {
  requestAnimationFrame(animate);
  const frameTime = clock.getDelta();
  const dt = Math.min(frameTime, MAX_DT); // simulation step (clamped after hitches)

  // The world keeps running behind the inventory and death screens; only
  // the pause and start menus freeze it.
  const running = gameState === "playing" || gameState === "inventory" || gameState === "dead";
  if (running) {
    player.update(dt);
    world.ensureChunksAround(player.position.x, player.position.z, renderDistance);
    if (player.stepEvent) audio.playFootstep(BLOCK_INFO[player.stepBlock]?.sound);
    if (player.splashEvent) audio.playSplash();
    effects.listener.copy(player.getEyePosition());
    effects.update(dt);
    effects.shake.apply(camera);
    entities.update(dt, player);
    mobs.update(dt);
    falling.update(dt);
    // A drawn throw is dropped if the grenade leaves the hand (thrown away, swapped).
    if (weapons.charging && itemInfo(inventory.selectedStack?.id)?.weapon?.kind !== "grenade") weapons.cancel();
    weapons.update(dt);
  } else {
    player.syncCamera(); // keep the view behind the menus sensible
  }
  world.processQueues(gameState === "playing" ? STREAM_BUDGET_PLAYING_MS : STREAM_BUDGET_MENU_MS);

  interaction.updateTarget(gameState === "playing");
  if (gameState === "playing") interaction.update(dt);
  if (gameState === "inventory") invScreen.refresh();

  const now = performance.now();
  if (pendingSave && now - lastSaveTime > 2000) flushSave();
  if (running && now - lastPlayerSave > 5000) {
    playerDirty = true;
    flushSave();
  }
  updateEnvironment(dt);
  hud.update(dt, player);
  hud.setAttackCharge(gameState === "playing" ? mobs.charge(interaction.tool) : 1);
  hud.setThrowCharge(gameState === "playing" ? weapons.charge : 0);
  held.setItem(inventory.selectedStack?.id ?? 0); // follows the selected slot (no-op when unchanged)
  held.update(dt, player, heldLight, camera, interaction.eating);

  ui.updateFps(frameTime); // real frame time, so slow frames aren't hidden by the clamp
  renderFrame();
}

animate();
