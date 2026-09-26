// localStorage persistence for block edits, scoped per world seed.
// All keys are prefixed to avoid clashing with anything else on the page's origin.

const PREFIX = "voxelands_v1_";

export function editsKey(seed) {
  return `${PREFIX}edits_${seed}`;
}

export function loadEdits(seed) {
  try {
    const raw = localStorage.getItem(editsKey(seed));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    console.warn("Voxelands: failed to load saved edits", err);
    return [];
  }
}

export function saveEdits(seed, flatArray) {
  try {
    localStorage.setItem(editsKey(seed), JSON.stringify(flatArray));
    return true;
  } catch (err) {
    console.warn("Voxelands: failed to save world edits (storage full or unavailable)", err);
    return false;
  }
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(`${PREFIX}settings`);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch (err) {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(`${PREFIX}settings`, JSON.stringify(settings));
  } catch (err) {
    console.warn("Voxelands: failed to save settings", err);
  }
}
