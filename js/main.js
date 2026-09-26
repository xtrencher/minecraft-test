import * as THREE from "three";
import { World, SEA_LEVEL } from "./world.js";
import { Player } from "./player.js";
import { UI, isMobileDevice, createBlockOutline } from "./ui.js";
import { BLOCK } from "./blocks.js";

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

let renderDistance = 4;
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

// Synchronously generate the chunks around spawn so the player never falls
// through unloaded terrain before streaming catches up.
world.ensureChunksAround(spawnX, spawnZ, renderDistance);
{
  let guard = 0;
  while (world.genQueue.length > 0 && guard < 4000) {
    world.processQueues(8, 8);
    guard++;
  }
}

// ---------- UI ----------
const ui = new UI({ atlasCanvas: world.atlasTexture.image });
ui.showStartMenu(SEED);

// ---------- Player ----------
const player = new Player(camera, world, canvas);
player.spawnAt(spawnX, spawnZ);

const blockOutline = createBlockOutline();
scene.add(blockOutline);

// ---------- Pointer lock / menu flow ----------
let gameState = "start"; // "start" | "playing" | "paused"

function requestLock() {
  canvas.requestPointerLock();
}

ui.playBtn.addEventListener("click", () => {
  requestLock();
});

ui.resumeBtn.addEventListener("click", () => {
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
  renderDistance = Number(ui.renderDistanceInput.value);
  ui.renderDistanceValueEl.textContent = String(renderDistance);
  scene.fog.far = renderDistance * 16 * 0.9;
});

ui.copyLinkBtn.addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("seed", String(SEED));
  navigator.clipboard?.writeText(url.toString()).catch(() => {});
});

canvas.addEventListener("click", () => {
  if (gameState !== "playing") requestLock();
});

// ---------- Main loop ----------
const clock = new THREE.Clock();
const MAX_DT = 0.05;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), MAX_DT);

  if (gameState === "playing") {
    player.update(dt);
    world.ensureChunksAround(player.position.x, player.position.z, renderDistance);
  }
  world.processQueues(2, 3);

  ui.updateFps(dt);
  renderer.render(scene, camera);
}

animate();
