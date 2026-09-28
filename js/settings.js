// Player settings: defaults, validation, and the tabbed settings panel in the
// pause menu. Everything here is saved in localStorage (storage.js) under one
// JSON object, so a setting added later simply falls back to its default in
// older saves, and garbage values are clamped back into range on load.

export const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"];

// Damage dealt to the player by creatures, per difficulty. Peaceful also
// stops hostile creatures from spawning (and removes the ones around).
export const DIFFICULTY_DAMAGE = { peaceful: 0, easy: 0.5, normal: 1, hard: 1.5 };

export const AUDIO_CATEGORIES = [
  ["master", "Master volume"],
  ["blocks", "Blocks and footsteps"],
  ["weapons", "Weapons and explosions"],
  ["creatures", "Creatures"],
  ["player", "Player (hurt, splash)"],
  ["ui", "Menus and pickups"],
];

export const DEFAULT_SETTINGS = {
  renderDistance: 10,
  graphics: "ultra",
  gfxOverrides: {},
  fov: 75,
  sensitivity: 1,
  invertY: false,
  volume: { master: 1, blocks: 1, weapons: 1, creatures: 1, player: 1, ui: 1 },
  explosionScale: { grenade: 1, bazooka: 1, airstrike: 1 },
  mobSpawning: true,
  difficulty: "normal",
  timeLocked: false,
  showFps: true,
};

function num(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// Returns a complete, valid settings object from whatever was saved.
export function normalizeSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_SETTINGS;
  const out = { ...s };
  out.fov = num(s.fov, 50, 110, d.fov);
  out.sensitivity = num(s.sensitivity, 0.1, 4, d.sensitivity);
  out.invertY = s.invertY === true;
  out.volume = {};
  for (const [k] of AUDIO_CATEGORIES) out.volume[k] = num(s.volume?.[k], 0, 1, 1);
  out.explosionScale = {};
  for (const k of Object.keys(d.explosionScale)) out.explosionScale[k] = num(s.explosionScale?.[k], 0.4, 2, 1);
  out.mobSpawning = s.mobSpawning !== false;
  out.difficulty = DIFFICULTIES.includes(s.difficulty) ? s.difficulty : d.difficulty;
  out.timeLocked = s.timeLocked === true;
  out.showFps = s.showFps !== false;
  out.gfxOverrides = s.gfxOverrides && typeof s.gfxOverrides === "object" ? { ...s.gfxOverrides } : {};
  return out;
}

// "HH:MM" for a 0-24 clock time.
export function formatHours(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// ---------- Settings panel ----------
// Wires the tabbed settings panel in the pause menu. `hooks` receives each
// change: { onChange(key, value) }. Controls are plain DOM elements declared
// in index.html; this only switches tabs and keeps the value labels in sync.
export class SettingsPanel {
  constructor() {
    this.tabs = [...document.querySelectorAll(".settings-tab")];
    this.pages = [...document.querySelectorAll(".settings-page")];
    for (const tab of this.tabs) tab.addEventListener("click", () => this.show(tab.dataset.page));
    this.show("video");
  }

  show(page) {
    for (const t of this.tabs) t.classList.toggle("active", t.dataset.page === page);
    for (const p of this.pages) p.classList.toggle("hidden", p.dataset.page !== page);
    this.current = page;
  }

  // Binds a range input + its value label. format(v) -> label text.
  static range(id, value, format, onInput) {
    const input = document.getElementById(id);
    const label = document.getElementById(`${id}-value`);
    input.value = String(value);
    if (label) label.textContent = format(Number(value));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (label) label.textContent = format(v);
      onInput(v);
    });
    return {
      input,
      set(v) {
        input.value = String(v);
        if (label) label.textContent = format(Number(v));
      },
    };
  }

  static select(id, value, onChange) {
    const el = document.getElementById(id);
    el.value = String(value);
    el.addEventListener("change", () => onChange(el.value));
    return el;
  }

  static checkbox(id, value, onChange) {
    const el = document.getElementById(id);
    el.checked = !!value;
    el.addEventListener("change", () => onChange(el.checked));
    return el;
  }
}
