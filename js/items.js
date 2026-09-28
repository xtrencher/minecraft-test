// Item registry (pure data, no three.js). Item ids below 256 are blocks
// (same id as the block, placeable); ids from 256 up are plain items: tools,
// materials and food. Like block ids, item ids are saved with the player's
// inventory, so existing ids must never change meaning.
import { BLOCK, BLOCK_INFO } from "./blocks.js";

export const ITEM = Object.freeze({
  STICK: 256,
  COAL: 257,
  IRON_INGOT: 258,
  GOLD_INGOT: 259,
  DIAMOND: 260,
  APPLE: 261,
  GOLDEN_APPLE: 262,
  RAW_MEAT: 263,
  COOKED_MEAT: 264,
  FLUFF: 265,
  WOOD_SWORD: 270,
  STONE_SWORD: 271,
  IRON_SWORD: 272,
  DIAMOND_SWORD: 273,
  WOOD_PICKAXE: 274,
  STONE_PICKAXE: 275,
  IRON_PICKAXE: 276,
  DIAMOND_PICKAXE: 277,
  WOOD_AXE: 278,
  STONE_AXE: 279,
  IRON_AXE: 280,
  DIAMOND_AXE: 281,
  WOOD_SHOVEL: 282,
  STONE_SHOVEL: 283,
  IRON_SHOVEL: 284,
  DIAMOND_SHOVEL: 285,
  GRENADE: 286,
  PISTOL: 287,
  BAZOOKA: 288,
  MACHINE_GUN: 289,
  SNIPER_RIFLE: 290,
  AIRSTRIKE: 291,
});

// Tool materials: tier (what they can harvest), mining speed multiplier,
// durability (uses), and melee damage for a sword (other tools hit weaker).
export const MATERIALS = {
  wood: { tier: 1, speed: 2, durability: 60, sword: 4, color: "wood" },
  stone: { tier: 2, speed: 4, durability: 132, sword: 5, color: "stone" },
  iron: { tier: 3, speed: 6, durability: 251, sword: 6, color: "iron" },
  diamond: { tier: 4, speed: 8, durability: 1562, sword: 7, color: "diamond" },
};

const HAND_DAMAGE = 1;

const ITEM_DEFS = {
  [ITEM.STICK]: { name: "Stick", icon: "stick" },
  [ITEM.COAL]: { name: "Coal", icon: "coal" },
  [ITEM.IRON_INGOT]: { name: "Iron Ingot", icon: "iron_ingot" },
  [ITEM.GOLD_INGOT]: { name: "Gold Ingot", icon: "gold_ingot" },
  [ITEM.DIAMOND]: { name: "Diamond", icon: "diamond" },
  [ITEM.APPLE]: { name: "Apple", icon: "apple", food: 4 },
  [ITEM.GOLDEN_APPLE]: { name: "Golden Apple", icon: "golden_apple", food: 20 },
  [ITEM.RAW_MEAT]: { name: "Raw Meat", icon: "raw_meat", food: 2 },
  [ITEM.COOKED_MEAT]: { name: "Cooked Meat", icon: "cooked_meat", food: 8 },
  [ITEM.FLUFF]: { name: "Fluff", icon: "fluff" },
  // Weapons never run out: unlimited ammo, no reloading.
  [ITEM.GRENADE]: { name: "Grenade", icon: "grenade", stack: 1, weapon: { kind: "grenade" } },
  [ITEM.PISTOL]: { name: "Pistol", icon: "pistol", stack: 1, weapon: { kind: "pistol" } },
  [ITEM.BAZOOKA]: { name: "Bazooka", icon: "bazooka", stack: 1, weapon: { kind: "bazooka" } },
  [ITEM.MACHINE_GUN]: { name: "Machine Gun", icon: "machinegun", stack: 1, weapon: { kind: "machinegun" } },
  [ITEM.SNIPER_RIFLE]: { name: "Sniper Rifle", icon: "sniper", stack: 1, weapon: { kind: "sniper" } },
  [ITEM.AIRSTRIKE]: { name: "Airstrike Designator", icon: "airstrike", stack: 1, weapon: { kind: "airstrike" } },
};

const TOOL_KINDS = [
  ["SWORD", "sword", "Sword"],
  ["PICKAXE", "pickaxe", "Pickaxe"],
  ["AXE", "axe", "Axe"],
  ["SHOVEL", "shovel", "Shovel"],
];
for (const [matKey, mat] of Object.entries(MATERIALS)) {
  for (const [kindKey, type, label] of TOOL_KINDS) {
    const id = ITEM[`${matKey.toUpperCase()}_${kindKey}`];
    const matName = matKey === "wood" ? "Wooden" : matKey[0].toUpperCase() + matKey.slice(1);
    ITEM_DEFS[id] = {
      name: `${matName} ${label}`,
      icon: `${type}_${matKey}`,
      stack: 1,
      tool: {
        type,
        tier: mat.tier,
        speed: mat.speed,
        durability: mat.durability,
        damage: type === "sword" ? mat.sword : type === "axe" ? mat.sword - 1 : Math.max(2, mat.sword - 3),
      },
    };
  }
}

const itemCache = new Map();

// Info for any item id: { id, name, stack, icon, block?, tool?, food? }, or null.
export function itemInfo(id) {
  if (itemCache.has(id)) return itemCache.get(id);
  let info = null;
  if (id > 0 && id < 256 && BLOCK_INFO[id] && id !== BLOCK.AIR) {
    const b = BLOCK_INFO[id];
    info = { id, name: b.name, stack: 64, block: id, icon: null };
  } else if (ITEM_DEFS[id]) {
    info = { id, stack: 64, ...ITEM_DEFS[id] };
  }
  itemCache.set(id, info);
  return info;
}

export function maxStack(id) {
  return itemInfo(id)?.stack ?? 64;
}

export function isValidItem(id) {
  return itemInfo(id) !== null;
}

// ---------- Mining ----------

// Whether `tool` (item info's .tool, or null for the bare hand) gets drops from the block.
export function canHarvest(blockId, tool) {
  const b = BLOCK_INFO[blockId];
  if (!b || b.hardness < 0) return false;
  if (b.minTier === 0) return true;
  return !!tool && tool.type === b.tool && tool.tier >= b.minTier;
}

// Seconds to break the block in survival (Infinity if unbreakable):
// hardness * (harvestable ? 1.5 : 5) / tool speed, as in classic voxel games.
export function breakTime(blockId, tool) {
  const b = BLOCK_INFO[blockId];
  if (!b || b.hardness < 0) return Infinity;
  if (b.hardness === 0) return 0;
  const speed = tool && b.tool && tool.type === b.tool ? tool.speed : 1;
  return (b.hardness * (canHarvest(blockId, tool) ? 1.5 : 5)) / speed;
}

// Items dropped when a block is broken in survival: array of [itemId, count].
export function blockDrops(blockId, tool, rand = Math.random) {
  if (!canHarvest(blockId, tool)) return [];
  switch (blockId) {
    case BLOCK.GRASS:
      return [[BLOCK.DIRT, 1]];
    case BLOCK.STONE:
      return [[BLOCK.COBBLESTONE, 1]];
    case BLOCK.COAL_ORE:
      return [[ITEM.COAL, 1]];
    case BLOCK.DIAMOND_ORE:
      return [[ITEM.DIAMOND, 1]];
    case BLOCK.GLASS:
    case BLOCK.TALL_GRASS:
    case BLOCK.VINE:
      return [];
    case BLOCK.LEAVES: {
      const r = rand();
      if (r < 0.06) return [[ITEM.APPLE, 1]];
      if (r < 0.1) return [[ITEM.STICK, 1]];
      return [];
    }
    case BLOCK.BIRCH_LEAVES:
    case BLOCK.PINE_LEAVES:
    case BLOCK.WILLOW_LEAVES:
      return rand() < 0.05 ? [[ITEM.STICK, 1]] : [];
    default:
      return [[blockId, 1]];
  }
}

export function meleeDamage(tool) {
  return tool ? tool.damage : HAND_DAMAGE;
}

// Everything offered in the creative inventory, in display order.
export const CREATIVE_ITEMS = [
  BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.COBBLESTONE, BLOCK.SAND, BLOCK.GRAVEL, BLOCK.WOOD, BLOCK.PLANKS,
  BLOCK.LEAVES, BLOCK.OAK_BARK, BLOCK.BIRCH_LOG, BLOCK.BIRCH_LEAVES, BLOCK.PINE_LOG, BLOCK.PINE_LEAVES, BLOCK.GLASS, BLOCK.BRICKS, BLOCK.WOOL, BLOCK.CRAFTING_TABLE, BLOCK.TORCH, BLOCK.LUMEN, BLOCK.BEDROCK,
  BLOCK.COAL_ORE, BLOCK.IRON_ORE, BLOCK.GOLD_ORE, BLOCK.DIAMOND_ORE, BLOCK.TALL_GRASS, BLOCK.FLOWER_RED, BLOCK.FLOWER_YELLOW,
  BLOCK.SNOW, BLOCK.TERRACOTTA, BLOCK.CACTUS, BLOCK.DEAD_BUSH, BLOCK.CORAL, BLOCK.SEAGRASS, BLOCK.KELP,
  BLOCK.WILLOW_LOG, BLOCK.WILLOW_LEAVES, BLOCK.VINE, BLOCK.LILY_PAD, BLOCK.CORAL_FAN,
  ITEM.STICK, ITEM.COAL, ITEM.IRON_INGOT, ITEM.GOLD_INGOT, ITEM.DIAMOND, ITEM.FLUFF,
  ITEM.APPLE, ITEM.GOLDEN_APPLE, ITEM.RAW_MEAT, ITEM.COOKED_MEAT,
  ITEM.WOOD_SWORD, ITEM.STONE_SWORD, ITEM.IRON_SWORD, ITEM.DIAMOND_SWORD,
  ITEM.WOOD_PICKAXE, ITEM.STONE_PICKAXE, ITEM.IRON_PICKAXE, ITEM.DIAMOND_PICKAXE,
  ITEM.WOOD_AXE, ITEM.STONE_AXE, ITEM.IRON_AXE, ITEM.DIAMOND_AXE,
  ITEM.WOOD_SHOVEL, ITEM.STONE_SHOVEL, ITEM.IRON_SHOVEL, ITEM.DIAMOND_SHOVEL,
  ITEM.GRENADE, ITEM.PISTOL, ITEM.BAZOOKA, ITEM.MACHINE_GUN, ITEM.SNIPER_RIFLE, ITEM.AIRSTRIKE,
];

// Slots 0-5 of a brand new game's hotbar (both modes): a full loadout so a
// new player has every weapon to try immediately.
export const STARTING_WEAPONS = [ITEM.PISTOL, ITEM.GRENADE, ITEM.BAZOOKA, ITEM.MACHINE_GUN, ITEM.AIRSTRIKE, ITEM.SNIPER_RIFLE];
