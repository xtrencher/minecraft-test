// Item icons and inventory slot widgets shared by the hotbar and the
// inventory / crafting screens. Icons are drawn once per item id and cached;
// a slot only redraws when its stack actually changes.
import { BLOCK_INFO } from "./blocks.js";
import { itemInfo } from "./items.js";
import { itemIconCanvas } from "./itemtextures.js";
import { drawBlockIcon } from "./textures.js";

const ICON = 32;

export class IconCache {
  constructor(tileCanvases) {
    this.tileCanvases = tileCanvases;
    this.cache = new Map();
  }

  // A 32x32 canvas for item `id` (block ids get an isometric cube), or null.
  get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const info = itemInfo(id);
    let canvas = null;
    if (info?.block) canvas = drawBlockIcon(this.tileCanvases, BLOCK_INFO[info.block], ICON);
    else if (info) canvas = itemIconCanvas(id);
    this.cache.set(id, canvas);
    return canvas;
  }
}

export function stackLabel(stack) {
  if (!stack) return "";
  const info = itemInfo(stack.id);
  if (!info) return "";
  if (stack.dur !== undefined && info.tool) return `${info.name} (${stack.dur}/${info.tool.durability})`;
  if (info.food) return `${info.name} (heals ${info.food / 2} ♥)`;
  return info.name;
}

// One slot: a square with the item icon, a stack count and a durability bar.
export class SlotView {
  constructor(icons, className = "slot") {
    this.icons = icons;
    this.el = document.createElement("div");
    this.el.className = className;
    this.canvas = document.createElement("canvas");
    this.canvas.width = ICON;
    this.canvas.height = ICON;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.countEl = document.createElement("span");
    this.countEl.className = "slot-count";
    this.barEl = document.createElement("div");
    this.barEl.className = "slot-dur hidden";
    this.barFill = document.createElement("div");
    this.barEl.appendChild(this.barFill);
    this.el.append(this.canvas, this.countEl, this.barEl);
    this._sig = null;
    this.stack = null;
  }

  set(stack) {
    this.stack = stack;
    const sig = stack ? `${stack.id}:${stack.count}:${stack.dur ?? ""}` : "";
    if (sig === this._sig) return;
    this._sig = sig;
    this.ctx.clearRect(0, 0, ICON, ICON);
    this.countEl.textContent = "";
    this.barEl.classList.add("hidden");
    if (!stack) return;
    const icon = this.icons.get(stack.id);
    if (icon) this.ctx.drawImage(icon, 0, 0, ICON, ICON);
    if (stack.count > 1) this.countEl.textContent = String(stack.count);
    const tool = itemInfo(stack.id)?.tool;
    if (tool && stack.dur !== undefined && stack.dur < tool.durability) {
      const f = Math.max(0, stack.dur / tool.durability);
      this.barFill.style.width = `${Math.round(f * 100)}%`;
      this.barFill.style.background = `hsl(${Math.round(f * 120)}, 90%, 50%)`;
      this.barEl.classList.remove("hidden");
    }
  }
}
