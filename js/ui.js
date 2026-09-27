import * as THREE from "three";
import { BLOCK_INFO, HOTBAR } from "./blocks.js";
import { drawBlockIcon } from "./textures.js";

export function isMobileDevice() {
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const touch = navigator.maxTouchPoints > 0 && !window.matchMedia("(pointer: fine)").matches;
  const ua = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
  return (coarse && ua) || (touch && ua);
}

export class UI {
  constructor({ tileCanvases }) {
    this.tileCanvases = tileCanvases;
    this.hotbarEl = document.getElementById("hotbar");
    this.fpsEl = document.getElementById("fps-counter");
    this.crosshairEl = document.getElementById("crosshair");
    this.startMenuEl = document.getElementById("start-menu");
    this.pauseMenuEl = document.getElementById("pause-menu");
    this.mobileBlockEl = document.getElementById("mobile-block");
    this.seedValueEl = document.getElementById("seed-value");
    this.pauseSeedValueEl = document.getElementById("pause-seed-value");
    this.renderDistanceInput = document.getElementById("render-distance");
    this.renderDistanceValueEl = document.getElementById("render-distance-value");
    this.playBtn = document.getElementById("play-btn");
    this.resumeBtn = document.getElementById("resume-btn");
    this.copyLinkBtn = document.getElementById("copy-link-btn");
    this.orbIndicatorEl = document.getElementById("orb-indicator");
    this.graphicsSelect = document.getElementById("graphics-preset");
    this.graphicsHintEl = document.getElementById("graphics-hint");
    this._orbCooldownShown = -1;

    this.selectedIndex = 0;
    this._buildHotbar();

    this._fpsFrames = 0;
    this._fpsTimer = 0;
  }

  _buildHotbar() {
    this.hotbarEl.innerHTML = "";
    this.slotEls = [];
    HOTBAR.forEach((blockId, i) => {
      const slot = document.createElement("div");
      slot.className = "hotbar-slot";
      const label = document.createElement("div");
      label.className = "key-label";
      label.textContent = String(i + 1);
      slot.appendChild(label);

      const info = BLOCK_INFO[blockId];
      const iconCanvas = drawBlockIcon(this.tileCanvases, info, 32);
      iconCanvas.title = info.name;
      slot.appendChild(iconCanvas);

      this.hotbarEl.appendChild(slot);
      this.slotEls.push(slot);
    });
    this.setSelected(0);
  }

  setSelected(index) {
    this.selectedIndex = ((index % HOTBAR.length) + HOTBAR.length) % HOTBAR.length;
    this.slotEls.forEach((el, i) => el.classList.toggle("selected", i === this.selectedIndex));
  }

  getSelectedBlock() {
    return HOTBAR[this.selectedIndex];
  }

  updateFps(dt) {
    this._fpsFrames++;
    this._fpsTimer += dt;
    if (this._fpsTimer >= 0.5) {
      const fps = Math.round(this._fpsFrames / this._fpsTimer);
      this.fpsEl.textContent = `FPS: ${fps}`;
      this._fpsFrames = 0;
      this._fpsTimer = 0;
    }
  }

  showHud(show) {
    this.hotbarEl.classList.toggle("hidden", !show);
    this.fpsEl.classList.toggle("hidden", !show);
    this.crosshairEl.classList.toggle("hidden", !show);
    this.orbIndicatorEl.classList.toggle("hidden", !show);
  }

  // fraction: 1 = just thrown, 0 = ready to throw again.
  setOrbCooldown(fraction) {
    const rounded = Math.round(fraction * 100) / 100;
    if (rounded === this._orbCooldownShown) return; // skip redundant DOM writes
    this._orbCooldownShown = rounded;
    this.orbIndicatorEl.style.setProperty("--cd", String(rounded));
    this.orbIndicatorEl.classList.toggle("cooling", rounded > 0);
  }

  showStartMenu(seed) {
    this.seedValueEl.textContent = String(seed);
    this.startMenuEl.classList.remove("hidden");
  }

  hideStartMenu() {
    this.startMenuEl.classList.add("hidden");
  }

  showPauseMenu(seed, renderDistance) {
    this.pauseSeedValueEl.textContent = String(seed);
    this.renderDistanceInput.value = String(renderDistance);
    this.renderDistanceValueEl.textContent = String(renderDistance);
    this.pauseMenuEl.classList.remove("hidden");
  }

  hidePauseMenu() {
    this.pauseMenuEl.classList.add("hidden");
  }

  showMobileBlock() {
    this.mobileBlockEl.classList.remove("hidden");
  }
}

export function createBlockOutline() {
  const geometry = new THREE.BoxGeometry(1.002, 1.002, 1.002);
  const edges = new THREE.EdgesGeometry(geometry);
  const material = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2, depthTest: true });
  const outline = new THREE.LineSegments(edges, material);
  outline.visible = false;
  return outline;
}
