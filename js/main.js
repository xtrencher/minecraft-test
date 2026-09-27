import * as THREE from "three";
import { World, SEA_LEVEL } from "./world.js";
import { Player } from "./player.js";
import { UI, isMobileDevice, createBlockOutline } from "./ui.js";
import { BLOCK } from "./blocks.js";
import { Audio } from "./audio.js";
import { Sky } from "./sky.js";
import { loadEdits, saveEdits, loadSettings, saveSettings } from "./storage.js";
import { EffectsSystem } from "./effects.js";

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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const skyColor = new THREE.Color(0x8fc7f0);
scene.background = skyColor;

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
scene.fog = new THREE.Fog(skyColor.getHex(), 20, renderDistance * 16 * 0.9);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambientLight);
const sunLight = new THREE.DirectionalLight(0xffffff, 0.9);
sunLight.position.set(50, 100, 30);
scene.add(sunLight);
scene.add(sunLight.target);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

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

function flushSave() {
  if (!pendingSave) return;
  saveEdits(SEED, world.edits, encodedEditCache, world.dirtyEditChunks);
  world.dirtyEditChunks.clear();
  pendingSave = false;
  lastSaveTime = performance.now();
}

window.addEventListener("beforeunload", flushSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});

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

// Synchronously generate just the chunks right around spawn so the player
// never falls through unloaded terrain; everything else out to the full
// render distance streams in over the next frames (while the start menu is
// showing), instead of freezing the page for seconds at startup.
const INITIAL_SYNC_RADIUS = 2;
world.ensureChunksAround(spawnX, spawnZ, INITIAL_SYNC_RADIUS);
while (world.genQueue.length > 0 || world.remeshQueue.size > 0) {
  world.processQueues(Infinity);
}
world.ensureChunksAround(spawnX, spawnZ, renderDistance);

// Main-thread milliseconds per frame spent generating/meshing chunks. Larger
// while a menu is open (nothing to keep smooth), smaller while playing.
const STREAM_BUDGET_PLAYING_MS = 5;
const STREAM_BUDGET_MENU_MS = 14;

// ---------- UI ----------
const ui = new UI({ atlasCanvas: world.atlasTexture.image });
ui.renderDistanceInput.min = String(MIN_RENDER_DISTANCE);
ui.renderDistanceInput.max = String(MAX_RENDER_DISTANCE);
ui.renderDistanceInput.value = String(renderDistance);
ui.renderDistanceValueEl.textContent = String(renderDistance);
ui.showStartMenu(SEED);

// ---------- Player ----------
const player = new Player(camera, world, canvas);
player.spawnAt(spawnX, spawnZ);

const blockOutline = createBlockOutline();
scene.add(blockOutline);

const audio = new Audio();
const sky = new Sky(scene, ambientLight, sunLight);
const effects = new EffectsSystem(scene, world, audio);

player.onFlightToggle = (enabled) => audio.playFlightToggle(enabled);

// Blast Orb explosions shove the player away from the blast center (with an
// upward kick), falling off with distance.
effects.onExplosion = (center, radius) => {
  const offset = player.position.clone();
  offset.y += 0.9; // body center
  offset.sub(center);
  const dist = offset.length();
  const reach = radius * 2.2;
  if (dist >= reach) return;
  const strength = (1 - dist / reach) * 22;
  if (dist < 1e-3) offset.set(0, 1, 0);
  offset.normalize();
  offset.y = Math.max(offset.y, 0) + 0.45;
  offset.normalize().multiplyScalar(strength);
  offset.y = Math.min(offset.y, 13);
  player.applyImpulse(offset);
};

// ---------- Pointer lock / menu flow ----------
let gameState = "start"; // "start" | "playing" | "paused"

function requestLock() {
  canvas.requestPointerLock();
}

ui.playBtn.addEventListener("click", () => {
  audio.ensureStarted();
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
  } else if (gameState !== "start") {
    gameState = "paused";
    player.enabled = false;
    ui.showHud(false);
    ui.showPauseMenu(SEED, renderDistance);
  }
});

ui.renderDistanceInput.addEventListener("input", () => {
  renderDistance = clampRenderDistance(ui.renderDistanceInput.value);
  ui.renderDistanceValueEl.textContent = String(renderDistance);
  scene.fog.far = renderDistance * 16 * 0.9;
  settings.renderDistance = renderDistance;
  saveSettings(settings);
});

ui.copyLinkBtn.addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("seed", String(SEED));
  navigator.clipboard?.writeText(url.toString()).catch(() => {});
});

// ---------- Hotbar selection ----------
const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8"];
window.addEventListener("keydown", (e) => {
  if (gameState !== "playing") return;
  const idx = DIGIT_CODES.indexOf(e.code);
  if (idx !== -1) ui.setSelected(idx);
});

canvas.addEventListener("wheel", (e) => {
  if (gameState !== "playing") return;
  ui.setSelected(ui.selectedIndex + (e.deltaY > 0 ? 1 : -1));
});

// ---------- Signature feature: Blast Orb ----------
window.addEventListener("keydown", (e) => {
  if (gameState !== "playing" || e.code !== "KeyF" || e.repeat) return;
  effects.throwOrb(player.getEyePosition(), player.getForwardVector(), player.velocity);
});

// ---------- Breaking / placing blocks ----------
const raycastOrigin = new THREE.Vector3();
let currentTarget = null;

function playerAabbOverlaps(bx, by, bz) {
  const px = player.position.x;
  const pz = player.position.z;
  const r = 0.3;
  const overlapsXZ = bx + 1 > px - r && bx < px + r && bz + 1 > pz - r && bz < pz + r;
  const overlapsY = by + 1 > player.position.y && by < player.position.y + 1.8;
  return overlapsXZ && overlapsY;
}

function updateTargetBlock() {
  if (gameState !== "playing") {
    currentTarget = null;
    blockOutline.visible = false;
    return;
  }
  raycastOrigin.copy(player.getEyePosition());
  const dir = player.getForwardVector();
  currentTarget = world.raycast(raycastOrigin, dir, 6);
  if (currentTarget) {
    const [bx, by, bz] = currentTarget.block;
    blockOutline.position.set(bx + 0.5, by + 0.5, bz + 0.5);
    blockOutline.visible = true;
  } else {
    blockOutline.visible = false;
  }
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

document.addEventListener("mousedown", (e) => {
  if (gameState !== "playing" || !currentTarget) return;
  if (e.button === 0) {
    const [bx, by, bz] = currentTarget.block;
    if (world.getBlock(bx, by, bz) !== BLOCK.AIR) {
      world.setBlock(bx, by, bz, BLOCK.AIR);
      audio.playBreak();
    }
  } else if (e.button === 2) {
    const [px, py, pz] = currentTarget.place;
    if (world.getBlock(px, py, pz) === BLOCK.AIR && !playerAabbOverlaps(px, py, pz)) {
      world.setBlock(px, py, pz, ui.getSelectedBlock());
      audio.playPlace();
    }
  }
});

canvas.addEventListener("click", () => {
  if (gameState !== "playing") requestLock();
});

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
  spawn: { x: spawnX, z: spawnZ },
  get gameState() {
    return gameState;
  },
  get renderDistance() {
    return renderDistance;
  },
};

// ---------- Main loop ----------
const clock = new THREE.Clock();
const MAX_DT = 0.05;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), MAX_DT);

  if (gameState === "playing") {
    player.update(dt);
    world.ensureChunksAround(player.position.x, player.position.z, renderDistance);
    if (player.stepEvent) audio.playFootstep();
    if (player.jumpEvent) audio.playJump();
    effects.listener.copy(player.getEyePosition());
    effects.update(dt);
    effects.shake.apply(camera);
    ui.setOrbCooldown(effects.cooldownFraction());
  }
  world.processQueues(gameState === "playing" ? STREAM_BUDGET_PLAYING_MS : STREAM_BUDGET_MENU_MS);

  if (pendingSave && performance.now() - lastSaveTime > 2000) flushSave();
  updateTargetBlock();
  sky.update(dt, player.position);

  // Animate water via opacity/tint pulsing rather than a texture-offset scroll:
  // the water material shares the block atlas texture with every other block
  // type, so shifting its UV offset would bleed into neighboring atlas tiles.
  const waterMat = world.materials.water;
  const waterT = performance.now() / 1000;
  waterMat.opacity = 0.62 + Math.sin(waterT * 0.6) * 0.08;
  const tint = 0.85 + Math.sin(waterT * 0.9) * 0.15;
  waterMat.color.setRGB(tint * 0.7, tint * 0.85, 1.0);

  ui.updateFps(dt);
  renderer.render(scene, camera);
}

animate();
