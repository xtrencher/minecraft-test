// The inventory screen (E) and the crafting table screen: the player's 36
// slots, a 2x2 (inventory) or 3x3 (table) crafting grid with its result, a
// recipe book that fills the grid for you, and in creative mode a palette
// of every item. Items are moved with the mouse like in classic voxel games:
// left click picks up / puts down a stack, right click splits or places
// one, shift-click moves between areas, number keys swap with the hotbar.
import { itemInfo, maxStack, CREATIVE_ITEMS } from "./items.js";
import { RECIPES, fitsGrid } from "./crafting.js";
import { HOTBAR_SIZE, INVENTORY_SIZE, makeStack, clickSlot, craftResult, takeCraftResult, craftAllInto, quickMove } from "./inventory.js";
import { SlotView, stackLabel } from "./slot-view.js";

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (parent) parent.appendChild(e);
  return e;
}

// Ingredient counts of a recipe: Map<itemId, count>.
function recipeNeeds(recipe) {
  const need = new Map();
  if (recipe.type === "shaped") {
    for (const row of recipe.pattern) {
      for (const ch of row) {
        if (ch === ".") continue;
        const id = recipe.key[ch];
        need.set(id, (need.get(id) || 0) + 1);
      }
    }
  } else {
    for (const id of recipe.ingredients) need.set(id, (need.get(id) || 0) + 1);
  }
  return need;
}

function recipeText(recipe) {
  const parts = [];
  for (const [id, n] of recipeNeeds(recipe)) parts.push(`${n} ${itemInfo(id).name}`);
  const out = itemInfo(recipe.result).name + (recipe.count > 1 ? ` x${recipe.count}` : "");
  return `${out}: ${parts.join(" + ")}`;
}

export class InventoryScreen {
  constructor({ icons, inventory, audio }) {
    this.icons = icons;
    this.inventory = inventory;
    this.audio = audio;
    this.onDrop = null; // (stack) => void: throw items out into the world
    this.onChange = null; // () => void: inventory contents changed

    this.root = document.getElementById("inventory-screen");
    this.root.innerHTML = "";
    this.panel = el("div", "inv-panel", this.root);
    this.titleEl = el("div", "inv-title", this.panel);
    const body = el("div", "inv-body", this.panel);
    const left = el("div", "inv-left", body);

    this.paletteEl = el("div", "inv-palette", left);
    this.craftEl = el("div", "inv-craft", left);
    this.gridEl = el("div", "craft-grid", this.craftEl);
    el("div", "craft-arrow", this.craftEl).textContent = "➜";
    this.resultView = new SlotView(icons, "slot result-slot");
    this.craftEl.appendChild(this.resultView.el);
    this._bindSlot(this.resultView.el, { area: "result" });

    el("div", "inv-label", left).textContent = "Inventory";
    this.mainEl = el("div", "inv-grid", left);
    this.hotbarEl = el("div", "inv-grid inv-hotbar", left);

    this.bookWrap = el("div", "recipe-book", body);
    el("div", "inv-label", this.bookWrap).textContent = "Recipes";
    this.bookEl = el("div", "recipe-list", this.bookWrap);

    this.invViews = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const v = new SlotView(icons);
      (i < HOTBAR_SIZE ? this.hotbarEl : this.mainEl).appendChild(v.el);
      this._bindSlot(v.el, { area: "inv", index: i });
      this.invViews.push(v);
    }
    // Main area first (rows 1-3), hotbar last, as in the classic layout.
    this.mainEl.append(...this.invViews.slice(HOTBAR_SIZE).map((v) => v.el));

    this.paletteViews = CREATIVE_ITEMS.map((id, i) => {
      const v = new SlotView(icons);
      v.set(makeStack(id, 1));
      this.paletteEl.appendChild(v.el);
      this._bindSlot(v.el, { area: "palette", index: i });
      return v;
    });

    this.cursorView = new SlotView(icons, "slot cursor-slot");
    this.root.appendChild(this.cursorView.el);
    this.tooltipEl = el("div", "inv-tooltip hidden", this.root);

    this.grid = [];
    this.gridViews = [];
    this.width = 2;
    this.cursor = null;
    this.kind = null;
    this.creative = false;
    this.hover = null;
    this._bookSig = null;

    this.root.addEventListener("mousedown", (e) => {
      if (e.target === this.root) this._dropCursor(e.button === 2);
    });
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    this.root.addEventListener("mousemove", (e) => this._moveCursor(e.clientX, e.clientY));
  }

  get isOpen() {
    return this.kind !== null;
  }

  // kind: "inventory" (2x2 crafting, or the item palette in creative) or "table" (3x3).
  open(kind, creative) {
    this.kind = kind;
    this.creative = creative;
    const palette = creative && kind === "inventory";
    this.width = kind === "table" ? 3 : 2;
    this.titleEl.textContent = kind === "table" ? "Crafting Table" : palette ? "Creative Inventory" : "Crafting";
    this.paletteEl.classList.toggle("hidden", !palette);
    this.craftEl.classList.toggle("hidden", palette);
    this.bookWrap.classList.toggle("hidden", palette);
    this.grid = new Array(this.width * this.width).fill(null);
    this.gridEl.innerHTML = "";
    this.gridEl.style.gridTemplateColumns = `repeat(${this.width}, auto)`;
    this.gridViews = this.grid.map((_, i) => {
      const v = new SlotView(this.icons);
      this.gridEl.appendChild(v.el);
      this._bindSlot(v.el, { area: "grid", index: i });
      return v;
    });
    this._bookSig = null;
    this.root.classList.remove("hidden");
    this.refresh();
  }

  // Puts the crafting grid and the carried stack back into the inventory
  // (anything that doesn't fit is dropped) and hides the screen.
  close() {
    if (!this.isOpen) return;
    const leftovers = [];
    for (const s of [...this.grid, this.cursor]) {
      if (!s) continue;
      const left = this.inventory.add(s.id, s.count, s.dur);
      if (left > 0) leftovers.push({ ...s, count: left });
    }
    this.grid = [];
    this.cursor = null;
    this.kind = null;
    this.hover = null;
    this.root.classList.add("hidden");
    this.tooltipEl.classList.add("hidden");
    for (const s of leftovers) if (this.onDrop) this.onDrop(s);
    this._changed();
  }

  _changed() {
    if (this.onChange) this.onChange();
  }

  _bindSlot(elem, ref) {
    elem.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._click(ref, e.button, e.shiftKey);
    });
    elem.addEventListener("mouseenter", () => {
      this.hover = ref;
      this._showTooltip();
    });
    elem.addEventListener("mouseleave", () => {
      if (this.hover === ref) this.hover = null;
      this.tooltipEl.classList.add("hidden");
    });
  }

  _stackAt(ref) {
    if (ref.area === "inv") return this.inventory.slots[ref.index];
    if (ref.area === "grid") return this.grid[ref.index];
    if (ref.area === "palette") return makeStack(CREATIVE_ITEMS[ref.index], 1);
    if (ref.area === "result") return craftResult(this.grid, this.width)?.stack ?? null;
    return null;
  }

  _showTooltip() {
    const stack = this.hover ? this._stackAt(this.hover) : null;
    const text = stackLabel(stack);
    this.tooltipEl.textContent = text;
    this.tooltipEl.classList.toggle("hidden", !text || !!this.cursor);
  }

  _moveCursor(x, y) {
    this._mx = x;
    this._my = y;
    this.cursorView.el.style.transform = `translate(${x - 20}px, ${y - 20}px)`;
    this.tooltipEl.style.transform = `translate(${x + 16}px, ${y - 30}px)`;
  }

  _click(ref, button, shift) {
    if (button !== 0 && button !== 2) return;
    const inv = this.inventory;
    let sound = true;
    if (ref.area === "inv") {
      if (shift && !this.cursor) sound = quickMove(inv, ref.index);
      else this.cursor = clickSlot(inv.slots, ref.index, this.cursor, button);
    } else if (ref.area === "grid") {
      if (shift && !this.cursor && this.grid[ref.index]) {
        const s = this.grid[ref.index];
        s.count = inv.add(s.id, s.count, s.dur);
        if (s.count <= 0) this.grid[ref.index] = null;
      } else {
        this.cursor = clickSlot(this.grid, ref.index, this.cursor, button);
      }
    } else if (ref.area === "result") {
      if (shift) sound = craftAllInto(this.grid, this.width, inv) > 0;
      else {
        const before = this.cursor;
        const beforeCount = before ? before.count : 0;
        this.cursor = takeCraftResult(this.grid, this.width, this.cursor);
        sound = this.cursor !== before || (this.cursor && this.cursor.count !== beforeCount);
      }
      if (sound && this.audio) this.audio.playCraft();
      sound = false;
    } else if (ref.area === "palette") {
      const id = CREATIVE_ITEMS[ref.index];
      if (this.cursor) this.cursor = null; // dropping onto the palette deletes the stack
      else if (shift) inv.add(id, maxStack(id));
      else this.cursor = makeStack(id, button === 2 ? 1 : maxStack(id));
    }
    if (sound && this.audio) this.audio.playClick();
    this.refresh();
    this._changed();
    this._showTooltip();
  }

  // Throws the carried stack (or one item of it) out of the screen.
  _dropCursor(one) {
    if (!this.cursor) return;
    let dropped;
    if (one && this.cursor.count > 1) {
      dropped = { ...this.cursor, count: 1 };
      this.cursor.count -= 1;
    } else {
      dropped = this.cursor;
      this.cursor = null;
    }
    if (this.onDrop) this.onDrop(dropped);
    this.refresh();
  }

  // Keyboard while the screen is open: 1-9 swaps the hovered slot with that
  // hotbar slot, Q drops from the hovered slot. Returns true if handled.
  handleKey(code, ctrl) {
    const m = /^Digit([1-9])$/.exec(code);
    if (m && this.hover && (this.hover.area === "inv" || this.hover.area === "grid")) {
      const h = Number(m[1]) - 1;
      const slots = this.hover.area === "inv" ? this.inventory.slots : this.grid;
      const i = this.hover.index;
      if (slots === this.inventory.slots && i === h) return true;
      const tmp = this.inventory.slots[h];
      this.inventory.slots[h] = slots[i];
      slots[i] = tmp;
      this.refresh();
      this._changed();
      return true;
    }
    if (m && this.hover && this.hover.area === "palette") {
      const id = CREATIVE_ITEMS[this.hover.index];
      this.inventory.slots[Number(m[1]) - 1] = makeStack(id, maxStack(id));
      this.refresh();
      this._changed();
      return true;
    }
    if (code === "KeyQ" && this.hover && this.hover.area === "inv") {
      const s = this.inventory.takeFromSlot(this.hover.index, ctrl ? 64 : 1);
      if (s && this.onDrop) this.onDrop(s);
      this.refresh();
      this._changed();
      return true;
    }
    return false;
  }

  // ---------- Recipe book ----------

  _recipesForBook() {
    return RECIPES.filter((r) => fitsGrid(r, this.width));
  }

  // Everything the player can use for crafting right now: inventory + grid + cursor.
  _available() {
    const have = new Map();
    for (const s of [...this.inventory.slots, ...this.grid, this.cursor]) {
      if (s) have.set(s.id, (have.get(s.id) || 0) + s.count);
    }
    return have;
  }

  _canCraft(recipe, have) {
    for (const [id, n] of recipeNeeds(recipe)) if ((have.get(id) || 0) < n) return false;
    return true;
  }

  _refreshBook() {
    if (this.bookWrap.classList.contains("hidden")) return;
    const have = this._available();
    const recipes = this._recipesForBook();
    const flags = recipes.map((r) => this._canCraft(r, have));
    const sig = `${this.width}:${flags.join("")}`;
    if (sig === this._bookSig) return;
    this._bookSig = sig;
    this.bookEl.innerHTML = "";
    // Craftable recipes first.
    const order = recipes.map((r, i) => i).sort((a, b) => flags[b] - flags[a]);
    for (const i of order) {
      const recipe = recipes[i];
      const v = new SlotView(this.icons, `slot recipe${flags[i] ? " craftable" : ""}`);
      v.set(makeStack(recipe.result, recipe.count));
      v.el.title = recipeText(recipe);
      v.el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this._fillRecipe(recipe) && this.audio) this.audio.playClick();
      });
      this.bookEl.appendChild(v.el);
    }
  }

  // Moves the ingredients for `recipe` from the inventory into the grid.
  _fillRecipe(recipe) {
    // Return what's in the grid first so its items count as available.
    for (let i = 0; i < this.grid.length; i++) {
      const s = this.grid[i];
      if (!s) continue;
      const left = this.inventory.add(s.id, s.count, s.dur);
      this.grid[i] = left > 0 ? { ...s, count: left } : null;
    }
    if (this.grid.some((s) => s)) return false; // inventory full
    const cells = [];
    if (recipe.type === "shaped") {
      recipe.pattern.forEach((row, r) => {
        for (let c = 0; c < row.length; c++) if (row[c] !== ".") cells.push([r * this.width + c, recipe.key[row[c]]]);
      });
    } else {
      recipe.ingredients.forEach((id, i) => cells.push([i, id]));
    }
    for (const [, id] of cells) if (this.inventory.countItem(id) < cells.filter((c) => c[1] === id).length) return false;
    for (const [cell, id] of cells) {
      const i = this.inventory.slots.findIndex((s) => s && s.id === id);
      this.grid[cell] = this.inventory.takeFromSlot(i, 1);
    }
    this.refresh();
    this._changed();
    return true;
  }

  refresh() {
    if (!this.isOpen) return;
    for (let i = 0; i < INVENTORY_SIZE; i++) this.invViews[i].set(this.inventory.slots[i]);
    for (let i = 0; i < this.gridViews.length; i++) this.gridViews[i].set(this.grid[i]);
    const res = this.grid.length ? craftResult(this.grid, this.width) : null;
    this.resultView.set(res ? res.stack : null);
    this.resultView.el.classList.toggle("ready", !!res);
    this.cursorView.set(this.cursor);
    this.cursorView.el.classList.toggle("hidden", !this.cursor);
    this._refreshBook();
  }
}
