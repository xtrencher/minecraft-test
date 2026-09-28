// Crafting recipes and grid matching (pure logic).
//
// Shaped recipes are matched after trimming empty rows/columns from the
// grid, so a 2x2 pattern works anywhere in a 3x3 table, and they also match
// mirrored left-to-right. Shapeless recipes match a multiset of items.
// There is no furnace: "smelting" is crafting with coal as the fuel.
import { BLOCK } from "./blocks.js";
import { ITEM } from "./items.js";

const shaped = (pattern, key, result, count = 1) => ({ type: "shaped", pattern, key, result, count });
const shapeless = (ingredients, result, count = 1) => ({ type: "shapeless", ingredients, result, count });

const TOOL_MATERIALS = [
  ["WOOD", BLOCK.PLANKS],
  ["STONE", BLOCK.COBBLESTONE],
  ["IRON", ITEM.IRON_INGOT],
  ["DIAMOND", ITEM.DIAMOND],
];

export const RECIPES = [
  shapeless([BLOCK.WOOD], BLOCK.PLANKS, 4),
  shapeless([BLOCK.BIRCH_LOG], BLOCK.PLANKS, 4),
  shapeless([BLOCK.PINE_LOG], BLOCK.PLANKS, 4),
  shapeless([BLOCK.OAK_BARK], BLOCK.PLANKS, 4),
  shaped(["P", "P"], { P: BLOCK.PLANKS }, ITEM.STICK, 4),
  shaped(["PP", "PP"], { P: BLOCK.PLANKS }, BLOCK.CRAFTING_TABLE),
  shaped(["C", "S"], { C: ITEM.COAL, S: ITEM.STICK }, BLOCK.TORCH, 4),
  shaped(["FF", "FF"], { F: ITEM.FLUFF }, BLOCK.WOOL),
  shaped(["GGG", "GAG", "GGG"], { G: ITEM.GOLD_INGOT, A: ITEM.APPLE }, ITEM.GOLDEN_APPLE),
  // Smelting with coal.
  shapeless([BLOCK.IRON_ORE, ITEM.COAL], ITEM.IRON_INGOT),
  shapeless([BLOCK.GOLD_ORE, ITEM.COAL], ITEM.GOLD_INGOT),
  shapeless([ITEM.RAW_MEAT, ITEM.COAL], ITEM.COOKED_MEAT),
  shapeless([BLOCK.SAND, BLOCK.SAND, BLOCK.SAND, BLOCK.SAND, ITEM.COAL], BLOCK.GLASS, 4),
  shapeless([BLOCK.COBBLESTONE, BLOCK.COBBLESTONE, BLOCK.COBBLESTONE, BLOCK.COBBLESTONE, ITEM.COAL], BLOCK.STONE, 4),
  shapeless([BLOCK.GRAVEL, BLOCK.GRAVEL, BLOCK.GRAVEL, BLOCK.GRAVEL, ITEM.COAL], BLOCK.BRICKS, 4),
  // Weapons (they never run out of ammo, so each is crafted once).
  shapeless([ITEM.IRON_INGOT, ITEM.COAL, ITEM.COAL], ITEM.GRENADE),
  shaped(["III", "P.."], { I: ITEM.IRON_INGOT, P: BLOCK.PLANKS }, ITEM.PISTOL),
  shaped(["III", "IGI", "III"], { I: ITEM.IRON_INGOT, G: ITEM.GRENADE }, ITEM.BAZOOKA),
  shaped(["III", "ISI", "I.I"], { I: ITEM.IRON_INGOT, S: ITEM.STICK }, ITEM.MACHINE_GUN),
  shaped(["..D", "III", "S.."], { D: ITEM.DIAMOND, I: ITEM.IRON_INGOT, S: ITEM.STICK }, ITEM.SNIPER_RIFLE),
  shaped(["IGI", "ICI", "III"], { I: ITEM.IRON_INGOT, G: ITEM.GOLD_INGOT, C: ITEM.COAL }, ITEM.AIRSTRIKE),
];
for (const [mat, m] of TOOL_MATERIALS) {
  RECIPES.push(shaped(["M", "M", "S"], { M: m, S: ITEM.STICK }, ITEM[`${mat}_SWORD`]));
  RECIPES.push(shaped(["MMM", ".S.", ".S."], { M: m, S: ITEM.STICK }, ITEM[`${mat}_PICKAXE`]));
  RECIPES.push(shaped(["MM", "MS", ".S"], { M: m, S: ITEM.STICK }, ITEM[`${mat}_AXE`]));
  RECIPES.push(shaped(["M", "S", "S"], { M: m, S: ITEM.STICK }, ITEM[`${mat}_SHOVEL`]));
}

// grid: array of item ids (0 = empty), row-major, `width` columns.
// Returns the trimmed rows as arrays of ids.
function trim(grid, width) {
  const height = grid.length / width;
  let minR = height;
  let maxR = -1;
  let minC = width;
  let maxC = -1;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!grid[r * width + c]) continue;
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
    }
  }
  if (maxR < 0) return [];
  const rows = [];
  for (let r = minR; r <= maxR; r++) rows.push(grid.slice(r * width + minC, r * width + maxC + 1));
  return rows;
}

function matchShaped(recipe, rows, mirrored) {
  const p = recipe.pattern;
  if (p.length !== rows.length || p[0].length !== rows[0].length) return false;
  for (let r = 0; r < p.length; r++) {
    for (let c = 0; c < p[r].length; c++) {
      const ch = p[r][mirrored ? p[r].length - 1 - c : c];
      const want = ch === "." ? 0 : recipe.key[ch];
      if ((rows[r][c] || 0) !== want) return false;
    }
  }
  return true;
}

function matchShapeless(recipe, items) {
  if (items.length !== recipe.ingredients.length) return false;
  const need = [...recipe.ingredients].sort((a, b) => a - b);
  const have = [...items].sort((a, b) => a - b);
  return need.every((v, i) => v === have[i]);
}

// Returns the matching recipe for the grid (array of item ids or 0), or null.
export function findRecipe(grid, width) {
  const rows = trim(grid, width);
  if (rows.length === 0) return null;
  const items = grid.filter((id) => id);
  for (const recipe of RECIPES) {
    if (recipe.type === "shaped") {
      if (matchShaped(recipe, rows, false) || matchShaped(recipe, rows, true)) return recipe;
    } else if (matchShapeless(recipe, items)) {
      return recipe;
    }
  }
  return null;
}

// Recipes whose shape fits a grid of the given width (2 = inventory, 3 = table).
export function fitsGrid(recipe, width) {
  if (recipe.type === "shaped") return recipe.pattern.length <= width && recipe.pattern[0].length <= width;
  return recipe.ingredients.length <= width * width;
}
