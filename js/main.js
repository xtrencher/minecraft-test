import * as THREE from "three";
import { World, SEA_LEVEL, selectionBox } from "./world.js";
import { Player } from "./player.js";
import { UI, isMobileDevice, createBlockOutline } from "./ui.js";
import { BLOCK, IS_REPLACEABLE, isSupportedBy } from "./blocks.js";
import { Audio } from "./audio.js";
import { Sky } from "./sky.js";
import { loadEdits, saveEdits, loadSettings, saveSettings } from "./storage.js";
import { EffectsSystem } from "./effects.js";
import { PostFX } from "./postfx.js";
import { PRESETS, applyPreset, normalizePreset } from "./graphics.js";
import { worldUniforms } from "./shaders.js";

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
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.getDrawingBufferSize(drawingSize);
  postfx.setSize(drawingSize.x, drawingSize.y);
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
while (!world.isIdle) world.processQueues(Infinity);
world.ensureChunksAround(spawnX, spawnZ, renderDistance);

// Main-thread milliseconds per frame spent generating/meshing chunks. Larger
// while a menu is open (nothing to keep smooth), smaller while playing.
const STREAM_BUDGET_PLAYING_MS = 5;
const STREAM_BUDGET_MENU_MS = 14;

// ---------- UI ----------
const ui = new UI({ tileCanvases: world.tileCanvases });
ui.renderDistanceInput.min = String(MIN_RENDER_DISTANCE);
ui.renderDistanceInput.max = String(MAX_RENDER_DISTANCE);
ui.renderDistanceInput.value = String(renderDistance);
ui.renderDistanceValueEl.textContent = String(renderDistance);
ui.graphicsSelect.value = graphicsPreset;
ui.showStartMenu(SEED);

// ---------- Player ----------
const player = new Player(camera, world, canvas);
player.spawnAt(spawnX, spawnZ);

const blockOutline = createBlockOutline();
scene.add(blockOutline);

const audio = new Audio();
const sky = new Sky(scene, sunLight, hemiLight);
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
  setRenderDistance(ui.renderDistanceInput.value);
});

ui.copyLinkBtn.addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("seed", String(SEED));
  navigator.clipboard?.writeText(url.toString()).catch(() => {});
});

// ---------- Hotbar selection ----------
const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"];
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
    const box = selectionBox(currentTarget.id);
    blockOutline.scale.set(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
    blockOutline.position.set(bx + (box[0] + box[3]) / 2, by + (box[1] + box[4]) / 2, bz + (box[2] + box[5]) / 2);
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
    const blockId = ui.getSelectedBlock();
    // Placing onto something replaceable (tall grass) replaces it in place.
    const target = IS_REPLACEABLE[currentTarget.id] ? currentTarget.block : currentTarget.place;
    const [px, py, pz] = target;
    if (IS_REPLACEABLE[world.getBlock(px, py, pz)] && !playerAabbOverlaps(px, py, pz) && isSupportedBy(blockId, world.getBlock(px, py - 1, pz))) {
      world.setBlock(px, py, pz, blockId);
      audio.playPlace();
    }
  }
});

canvas.addEventListener("click", () => {
  if (gameState !== "playing") requestLock();
});

// ---------- Rendering state ----------
const sunWorldPos = new THREE.Vector3();
const lookDir = new THREE.Vector3();
let eyeAdaptation = 1;
let underwater = false;

function updateEnvironment(dt) {
  const eye = player.getEyePosition();
  lookDir.copy(player.getForwardVector());
  sky.update(dt, eye, lookDir);
  worldUniforms.uTime.value += dt;

  // Under water: murky blue fog and a tinted, wobbly screen.
  const eyeBlock = world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
  underwater = eyeBlock === BLOCK.WATER;
  worldUniforms.uUnderwater.value = underwater ? 1 : 0;
  const eyeLight = world.lightAt(eye.x, eye.y, eye.z);
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
  if (preset.post) {
    sunWorldPos.copy(camera.position).addScaledVector(worldUniforms.uSunDir.value, 400);
    const sunUp = THREE.MathUtils.smoothstep(worldUniforms.uSunDir.value.y, -0.02, 0.12);
    postfx.render(scene, camera, {
      exposure,
      sunWorldPos,
      sunColor: worldUniforms.uSunGlowColor.value,
      raysStrength: underwater ? 0 : 0.85 * sunUp,
      underwater,
      night: worldUniforms.uNight.value,
      bloomStrength: 0.11,
      time: worldUniforms.uTime.value,
    });
  } else {
    renderer.toneMappingExposure = exposure;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
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
  uniforms: worldUniforms,
  spawn: { x: spawnX, z: spawnZ },
  setGraphics,
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
};

// ---------- Main loop ----------
const clock = new THREE.Clock();
const MAX_DT = 0.05;

function animate() {
  requestAnimationFrame(animate);
  const frameTime = clock.getDelta();
  const dt = Math.min(frameTime, MAX_DT); // simulation step (clamped after hitches)

  if (gameState === "playing") {
    player.update(dt);
    world.ensureChunksAround(player.position.x, player.position.z, renderDistance);
    if (player.stepEvent) audio.playFootstep();
    if (player.jumpEvent) audio.playJump();
    effects.listener.copy(player.getEyePosition());
    effects.update(dt);
    effects.shake.apply(camera);
    ui.setOrbCooldown(effects.cooldownFraction());
  } else {
    player.syncCamera(); // keep the view behind the menus sensible
  }
  world.processQueues(gameState === "playing" ? STREAM_BUDGET_PLAYING_MS : STREAM_BUDGET_MENU_MS);

  if (pendingSave && performance.now() - lastSaveTime > 2000) flushSave();
  updateTargetBlock();
  updateEnvironment(dt);

  ui.updateFps(frameTime); // real frame time, so slow frames aren't hidden by the clamp
  renderFrame();
}

animate();
