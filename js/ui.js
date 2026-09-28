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
    this.graphicsSelect = document.getElementById("graphics-preset");
    this.graphicsHintEl = document.getElementById("graphics-hint");
    this.modeSelect = document.getElementById("mode-select");
    this.modeHintEl = document.getElementById("mode-hint");
    this.pauseModeSelect = document.getElementById("pause-mode-select");
    this.pauseModeHintEl = document.getElementById("pause-mode-hint");
    this.scopeOverlayEl = document.getElementById("scope-overlay");
    this.crosshairEl = document.getElementById("crosshair");
    this.debugEl = document.getElementById("debug-overlay");
    this.fovInput = document.getElementById("fov-slider");
    this.fovValueEl = document.getElementById("fov-value");
    this.sensitivityInput = document.getElementById("sensitivity-slider");
    this.sensitivityValueEl = document.getElementById("sensitivity-value");
    this.timeInput = document.getElementById("time-slider");
    this.timeValueEl = document.getElementById("time-value");
    this.timeLockInput = document.getElementById("time-lock");
    this.difficultySelect = document.getElementById("difficulty-select");
    this.mobSpawnToggle = document.getElementById("mob-spawn-toggle");
    this.volumeInputs = {
      master: document.getElementById("volume-master"),
      sfx: document.getElementById("volume-sfx"),
      mobs: document.getElementById("volume-mobs"),
      explosions: document.getElementById("volume-explosions"),
    };
    this.volumeValueEls = {
      master: document.getElementById("volume-master-value"),
      sfx: document.getElementById("volume-sfx-value"),
      mobs: document.getElementById("volume-mobs-value"),
      explosions: document.getElementById("volume-explosions-value"),
    };
    this.explosionInputs = {
      grenade: document.getElementById("explosion-grenade"),
      bazooka: document.getElementById("explosion-bazooka"),
      airstrike: document.getElementById("explosion-airstrike"),
    };
    this.explosionValueEls = {
      grenade: document.getElementById("explosion-grenade-value"),
      bazooka: document.getElementById("explosion-bazooka-value"),
      airstrike: document.getElementById("explosion-airstrike-value"),
    };

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

  setDebugVisible(show) {
    this.debugEl.classList.toggle("hidden", !show);
  }

  updateDebug(text) {
    this.debugEl.textContent = text;
  }

  // A sniper scope overlay while zoomed: masks the screen to a circle and
  // hides the ordinary crosshair (the scope draws its own).
  setScoped(active) {
    this.scopeOverlayEl.classList.toggle("visible", active);
    this.crosshairEl.style.visibility = active ? "hidden" : "";
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
