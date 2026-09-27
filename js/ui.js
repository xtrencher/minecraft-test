export function isMobileDevice() {
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const touch = navigator.maxTouchPoints > 0 && !window.matchMedia("(pointer: fine)").matches;
  const ua = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
  return (coarse && ua) || (touch && ua);
}

const MODE_HINTS = {
  survival: "Health, fall damage and drowning. Mine with tools, collect drops, craft, eat to heal.",
  creative: "Unlimited blocks from the E palette, instant mining, flight (double-tap Space), no damage.",
};

// Menus (start / pause), the FPS counter and the Blast Orb indicator. The
// hotbar, hearts and death screen live in hud.js.
export class UI {
  constructor() {
    this.hudEl = document.getElementById("hud");
    this.fpsEl = document.getElementById("fps-counter");
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
    this.modeSelect = document.getElementById("mode-select");
    this.modeHintEl = document.getElementById("mode-hint");
    this.pauseModeSelect = document.getElementById("pause-mode-select");
    this.pauseModeHintEl = document.getElementById("pause-mode-hint");
    this._orbCooldownShown = -1;

    this._fpsFrames = 0;
    this._fpsTimer = 0;
  }

  setModeShown(mode) {
    this.modeSelect.value = mode;
    this.pauseModeSelect.value = mode;
    this.modeHintEl.textContent = MODE_HINTS[mode] || "";
    this.pauseModeHintEl.textContent = MODE_HINTS[mode] || "";
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
    this.hudEl.classList.toggle("hidden", !show);
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
