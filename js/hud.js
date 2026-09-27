// In-game HUD: the inventory-backed hotbar, health hearts, air bubbles, the
// name of the selected item, a red flash when hurt, and the death screen.
// All pixel art (hearts, bubbles) is drawn in code.
import { HOTBAR_SIZE } from "./inventory.js";
import { MAX_HEALTH, MAX_AIR } from "./player.js";
import { SlotView, stackLabel } from "./slot-view.js";

const PX = 2; // screen pixels per art pixel

// 9x8 heart: k outline, r red, h highlight, d shade, . empty.
const HEART = [
  ".kkk.kkk.",
  "krrrkrrrk",
  "krhrrrrrk",
  "krrrrrrdk",
  ".krrrrdk.",
  "..krrdk..",
  "...kdk...",
  "....k....",
];

const BUBBLE = [
  "..kkkkk..",
  ".kbbbbbk.",
  "kbwwbbbbk",
  "kbwbbbbbk",
  "kbbbbbbbk",
  "kbbbbbbck",
  "kbbbbbcck",
  ".kbbbcck.",
  "..kkkkk..",
];

const COLORS = {
  k: "#1a0606",
  r: "#e3222c",
  h: "#ffb7b0",
  d: "#9e1119",
  e: "#3a2a2a",
  w: "#ffffff",
  b: "#4aa8ff",
  c: "#2c6fc9",
};

// Draws pixel art rows; `fill(x, ch)` may substitute colors per column.
function drawArt(rows, fill = (x, ch) => ch) {
  const canvas = document.createElement("canvas");
  canvas.width = rows[0].length * PX;
  canvas.height = rows.length * PX;
  const ctx = canvas.getContext("2d");
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = fill(x, row[x]);
      if (ch === "." || !COLORS[ch]) continue;
      ctx.fillStyle = COLORS[ch];
      ctx.fillRect(x * PX, y * PX, PX, PX);
    }
  });
  return canvas;
}

function heartArt(kind, flash = false) {
  const inner = (x, ch) => {
    if (ch === "k") return flash ? "w" : "k";
    if (ch === ".") return ".";
    if (kind === "empty" || (kind === "half" && x > 4)) return "e";
    return ch;
  };
  return drawArt(HEART, inner);
}

export class Hud {
  constructor({ icons, inventory }) {
    this.icons = icons;
    this.inventory = inventory;
    this.rootEl = document.getElementById("hud");
    this.hotbarEl = document.getElementById("hotbar");
    this.heartsEl = document.getElementById("hearts");
    this.bubblesEl = document.getElementById("bubbles");
    this.itemNameEl = document.getElementById("item-name");
    this.damageEl = document.getElementById("damage-flash");
    this.modeEl = document.getElementById("mode-badge");
    this.deathEl = document.getElementById("death-screen");
    this.deathCauseEl = document.getElementById("death-cause");
    this.respawnBtn = document.getElementById("respawn-btn");
    this.chargeEl = document.getElementById("attack-charge");
    this.chargeFill = this.chargeEl.firstElementChild;
    this._charge = 1;

    this.art = {
      full: heartArt("full"),
      half: heartArt("half"),
      empty: heartArt("empty"),
      fullFlash: heartArt("full", true),
      halfFlash: heartArt("half", true),
      emptyFlash: heartArt("empty", true),
      bubble: drawArt(BUBBLE),
    };

    this.hearts = [];
    for (let i = 0; i < MAX_HEALTH / 2; i++) {
      const c = document.createElement("canvas");
      c.width = this.art.full.width;
      c.height = this.art.full.height;
      c.className = "heart";
      this.heartsEl.appendChild(c);
      this.hearts.push({ el: c, ctx: c.getContext("2d"), shown: "" });
    }
    this.bubbles = [];
    for (let i = 0; i < MAX_AIR; i++) {
      const c = document.createElement("canvas");
      c.width = this.art.bubble.width;
      c.height = this.art.bubble.height;
      c.getContext("2d").drawImage(this.art.bubble, 0, 0);
      c.className = "bubble";
      this.bubblesEl.appendChild(c);
      this.bubbles.push(c);
    }

    this.slots = [];
    this.hotbarEl.innerHTML = "";
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const view = new SlotView(icons, "hotbar-slot");
      const label = document.createElement("div");
      label.className = "key-label";
      label.textContent = String(i + 1);
      view.el.appendChild(label);
      this.hotbarEl.appendChild(view.el);
      this.slots.push(view);
    }
    this._selected = -1;
    this._nameTimer = 0;
    this._lastName = "";
    this._shownHealth = -1;
    this._shownAir = -1;
    this._flashTime = 99;
    this._mode = null;
    this._wasLow = false;
  }

  show(visible) {
    this.rootEl.classList.toggle("hidden", !visible);
  }

  // Refreshes the hotbar slots and selection (cheap when nothing changed).
  refreshHotbar() {
    const inv = this.inventory;
    for (let i = 0; i < HOTBAR_SIZE; i++) this.slots[i].set(inv.slots[i]);
    if (inv.selected !== this._selected) {
      if (this._selected >= 0) this.slots[this._selected].el.classList.remove("selected");
      this._selected = inv.selected;
      this.slots[this._selected].el.classList.add("selected");
    }
    // Show the item's name briefly whenever the held item changes.
    const name = stackLabel(inv.selectedStack);
    const id = inv.selectedStack ? inv.selectedStack.id : 0;
    const key = `${this._selected}:${id}`;
    if (key !== this._lastName) {
      this._lastName = key;
      if (name) {
        this.itemNameEl.textContent = name;
        this._nameTimer = 2.2;
      } else {
        this._nameTimer = 0;
      }
    }
  }

  // Attack recharge (0-1): a small bar under the crosshair while < 1.
  setAttackCharge(charge) {
    const shown = charge >= 1 ? 1 : Math.round(charge * 20) / 20;
    if (shown === this._charge) return;
    this._charge = shown;
    this.chargeEl.classList.toggle("hidden", shown >= 1);
    this.chargeFill.style.width = `${Math.round(shown * 100)}%`;
  }

  hurt() {
    this._flashTime = 0;
  }

  update(dt, player) {
    this.refreshHotbar();
    this._nameTimer -= dt;
    this.itemNameEl.style.opacity = String(Math.max(0, Math.min(1, this._nameTimer / 0.4)));

    if (player.mode !== this._mode) {
      this._mode = player.mode;
      this.modeEl.textContent = player.creative ? "Creative" : "";
      this.modeEl.classList.toggle("hidden", !player.creative);
      this.heartsEl.classList.toggle("hidden", player.creative);
      this._shownHealth = -1;
    }

    // Hearts: re-drawn when health changes or while flashing after damage.
    this._flashTime += dt;
    const flashing = this._flashTime < 0.6 && Math.floor(this._flashTime * 10) % 2 === 0;
    const hp = Math.ceil(player.health);
    const sig = `${hp}:${flashing}`;
    if (sig !== this._shownHealth && !player.creative) {
      this._shownHealth = sig;
      for (let i = 0; i < this.hearts.length; i++) {
        const h = this.hearts[i];
        const v = hp - i * 2;
        const kind = v >= 2 ? "full" : v === 1 ? "half" : "empty";
        const art = this.art[flashing ? `${kind}Flash` : kind];
        h.ctx.clearRect(0, 0, h.el.width, h.el.height);
        h.ctx.drawImage(art, 0, 0);
      }
    }
    // Low health: the hearts jitter.
    const low = !player.creative && !player.dead && hp <= 4;
    if (low || this._wasLow) {
      for (let i = 0; i < this.hearts.length; i++) {
        const y = low ? Math.round((Math.random() - 0.5) * 3) : 0;
        this.hearts[i].el.style.transform = y ? `translateY(${y}px)` : "";
      }
      this._wasLow = low;
    }

    // Air bubbles: only while breath is being used.
    const showAir = !player.creative && (player.headInWater || player.air < MAX_AIR - 0.01);
    this.bubblesEl.classList.toggle("hidden", !showAir);
    if (showAir) {
      const n = Math.ceil(player.air - 0.001);
      if (n !== this._shownAir) {
        this._shownAir = n;
        this.bubbles.forEach((b, i) => (b.style.visibility = i < n ? "visible" : "hidden"));
      }
    }

    // Red vignette flash when hurt.
    // (plus a slow pulse while health is low).
    this._time = (this._time || 0) + dt;
    const f = Math.max(0, 1 - this._flashTime / 0.5) * 0.8;
    const pulse = low ? 0.22 + 0.12 * Math.sin(this._time * 5) : 0;
    const opacity = Math.round(Math.max(f, pulse) * 100) / 100;
    if (opacity !== this._shownFlash) {
      this._shownFlash = opacity;
      this.damageEl.style.opacity = String(opacity);
    }
  }

  showDeath(message) {
    this.deathCauseEl.textContent = message;
    this.deathEl.classList.remove("hidden");
    // Replaying the entrance animation.
    this.deathEl.classList.remove("show");
    void this.deathEl.offsetWidth;
    this.deathEl.classList.add("show");
    // The button unlocks after a moment so a panicked click doesn't skip the screen.
    this.respawnBtn.disabled = true;
    clearTimeout(this._respawnTimer);
    this._respawnTimer = setTimeout(() => (this.respawnBtn.disabled = false), 900);
  }

  hideDeath() {
    this.deathEl.classList.add("hidden");
    this.deathEl.classList.remove("show");
  }
}
