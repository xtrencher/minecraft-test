// Inventory model and slot interactions (pure logic, no DOM or three.js).
//
// A stack is { id, count } plus `dur` (remaining uses) for tools. The
// player's inventory has 36 slots: 0-8 are the hotbar, 9-35 the main area.
// UI screens hold one "cursor" stack (what the mouse is carrying) and call
// clickSlot()/quickMove()/takeCraftResult() on arrays of slots.
import { maxStack, itemInfo } from "./items.js";
import { findRecipe } from "./crafting.js";

export const HOTBAR_SIZE = 9;
export const INVENTORY_SIZE = 36;

export function makeStack(id, count = 1, dur) {
  const stack = { id, count };
  const tool = itemInfo(id)?.tool;
  if (tool) stack.dur = dur ?? tool.durability;
  return stack;
}

function canMerge(a, b) {
  return !!a && !!b && a.id === b.id && maxStack(a.id) > 1;
}

// Moves as much of `stack` as fits into slots[from..to) (merging into
// matching stacks first, then empty slots). Mutates `stack.count`; returns
// true if it was fully moved.
export function addToRange(slots, stack, from, to) {
  const limit = maxStack(stack.id);
  if (limit > 1) {
    for (let i = from; i < to && stack.count > 0; i++) {
      const s = slots[i];
      if (canMerge(s, stack) && s.count < limit) {
        const n = Math.min(stack.count, limit - s.count);
        s.count += n;
        stack.count -= n;
      }
    }
  }
  for (let i = from; i < to && stack.count > 0; i++) {
    if (slots[i]) continue;
    const n = Math.min(stack.count, limit);
    slots[i] = { ...stack, count: n };
    stack.count -= n;
  }
  return stack.count === 0;
}

export class Inventory {
  constructor() {
    this.slots = new Array(INVENTORY_SIZE).fill(null);
    this.selected = 0;
  }

  get selectedStack() {
    return this.slots[this.selected];
  }

  // Adds items (hotbar first, then the main area). Returns the count that
  // didn't fit.
  add(id, count = 1, dur) {
    if (count <= 0 || !itemInfo(id)) return count;
    const stack = makeStack(id, count, dur);
    // Merge into any existing stacks first, then fill empty slots.
    const limit = maxStack(id);
    if (limit > 1) {
      for (let i = 0; i < INVENTORY_SIZE && stack.count > 0; i++) {
        const s = this.slots[i];
        if (canMerge(s, stack) && s.count < limit) {
          const n = Math.min(stack.count, limit - s.count);
          s.count += n;
          stack.count -= n;
        }
      }
    }
    addToRange(this.slots, stack, 0, INVENTORY_SIZE);
    return stack.count;
  }

  // Whether `count` of item `id` would fit completely.
  canFit(id, count = 1) {
    const limit = maxStack(id);
    let room = 0;
    for (const s of this.slots) {
      if (!s) room += limit;
      else if (s.id === id && limit > 1) room += limit - s.count;
      if (room >= count) return true;
    }
    return false;
  }

  countItem(id) {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  // Removes up to n items from slot i; returns the removed stack (or null).
  takeFromSlot(i, n = 1) {
    const s = this.slots[i];
    if (!s) return null;
    const k = Math.min(n, s.count);
    s.count -= k;
    if (s.count <= 0) this.slots[i] = null;
    return { ...s, count: k };
  }

  consumeSelected(n = 1) {
    return this.takeFromSlot(this.selected, n);
  }

  // Wears the selected tool; returns true if it broke.
  damageSelected(amount = 1) {
    const s = this.selectedStack;
    if (!s || s.dur === undefined) return false;
    s.dur -= amount;
    if (s.dur <= 0) {
      this.slots[this.selected] = null;
      return true;
    }
    return false;
  }

  isEmpty() {
    return this.slots.every((s) => !s);
  }

  clear() {
    this.slots.fill(null);
  }

  serialize() {
    return this.slots.map((s) => (s ? (s.dur !== undefined ? [s.id, s.count, s.dur] : [s.id, s.count]) : 0));
  }

  load(data) {
    this.clear();
    if (!Array.isArray(data)) return;
    for (let i = 0; i < Math.min(data.length, INVENTORY_SIZE); i++) {
      const e = data[i];
      if (!Array.isArray(e)) continue;
      const [id, count, dur] = e;
      if (!Number.isInteger(id) || !itemInfo(id) || !Number.isInteger(count) || count <= 0) continue;
      const stack = makeStack(id, Math.min(count, maxStack(id)), Number.isInteger(dur) && dur > 0 ? dur : undefined);
      this.slots[i] = stack;
    }
  }
}

// Mouse click on slots[i] while carrying `cursor` (a stack or null).
// button 0 = left, 2 = right. Returns the new cursor. Mutates slots.
export function clickSlot(slots, i, cursor, button) {
  const slot = slots[i];
  if (button === 2) {
    if (!cursor) {
      if (!slot) return null;
      // Pick up half (rounded up).
      const half = Math.ceil(slot.count / 2);
      slot.count -= half;
      if (slot.count <= 0) slots[i] = null;
      return { ...slot, count: half };
    }
    if (!slot) {
      slots[i] = { ...cursor, count: 1 };
      cursor.count -= 1;
      return cursor.count > 0 ? cursor : null;
    }
    if (canMerge(slot, cursor) && slot.count < maxStack(slot.id)) {
      slot.count += 1;
      cursor.count -= 1;
      return cursor.count > 0 ? cursor : null;
    }
    slots[i] = cursor;
    return slot;
  }
  // Left click.
  if (!cursor) {
    slots[i] = null;
    return slot;
  }
  if (!slot) {
    slots[i] = cursor;
    return null;
  }
  if (canMerge(slot, cursor)) {
    const n = Math.min(cursor.count, maxStack(slot.id) - slot.count);
    slot.count += n;
    cursor.count -= n;
    return cursor.count > 0 ? cursor : null;
  }
  slots[i] = cursor;
  return slot;
}

// The item a crafting grid (array of stacks or null) currently produces, or null.
export function craftResult(grid, width) {
  const recipe = findRecipe(
    grid.map((s) => (s ? s.id : 0)),
    width
  );
  return recipe ? { recipe, stack: makeStack(recipe.result, recipe.count) } : null;
}

// Consumes one of each ingredient from the grid.
function consumeGrid(grid) {
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i]) continue;
    grid[i].count -= 1;
    if (grid[i].count <= 0) grid[i] = null;
  }
}

// Clicking the crafting output while carrying `cursor`. Returns the new cursor.
export function takeCraftResult(grid, width, cursor) {
  const res = craftResult(grid, width);
  if (!res) return cursor;
  const out = res.stack;
  if (cursor) {
    if (!canMerge(cursor, out) || cursor.count + out.count > maxStack(out.id)) return cursor;
    cursor.count += out.count;
  } else {
    cursor = out;
  }
  consumeGrid(grid);
  return cursor;
}

// Shift-clicking the crafting output: crafts as many times as possible
// straight into the inventory. Returns the number of crafts made.
export function craftAllInto(grid, width, inventory) {
  let made = 0;
  for (let guard = 0; guard < 64 * 9; guard++) {
    const res = craftResult(grid, width);
    if (!res || !inventory.canFit(res.stack.id, res.stack.count)) break;
    inventory.add(res.stack.id, res.stack.count, res.stack.dur);
    consumeGrid(grid);
    made++;
  }
  return made;
}

// Shift-click on inventory slot i: moves the stack between the hotbar and
// the main area. Returns true if anything moved.
export function quickMove(inventory, i) {
  const slots = inventory.slots;
  const stack = slots[i];
  if (!stack) return false;
  const before = stack.count;
  const moving = { ...stack };
  if (i < HOTBAR_SIZE) addToRange(slots, moving, HOTBAR_SIZE, INVENTORY_SIZE);
  else addToRange(slots, moving, 0, HOTBAR_SIZE);
  if (moving.count === 0) slots[i] = null;
  else stack.count = moving.count;
  return moving.count !== before;
}
