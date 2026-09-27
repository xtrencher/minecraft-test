// Block registry: pure data (no three.js), shared by terrain generation,
// lighting, meshing, physics and UI. Block ids are persisted in saves, so
// existing ids must never change meaning; new blocks get new ids.

export const BLOCK = Object.freeze({
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  WOOD: 6,
  LEAVES: 7,
  PLANKS: 8,
  GLASS: 9,
  COBBLESTONE: 10,
  BEDROCK: 11,
  GRAVEL: 12,
  COAL_ORE: 13,
  IRON_ORE: 14,
  GOLD_ORE: 15,
  DIAMOND_ORE: 16,
  TORCH: 17,
  LUMEN: 18,
  CRAFTING_TABLE: 19,
  TALL_GRASS: 20,
  FLOWER_RED: 21,
  FLOWER_YELLOW: 22,
  BRICKS: 23,
  WOOL: 24,
});

// Texture layers of the block texture array, in order. Painted procedurally
// by textures.js; a block face refers to a layer by name.
export const TILE_NAMES = [
  "grass_top",
  "grass_side",
  "dirt",
  "stone",
  "sand",
  "wood_side",
  "wood_top",
  "leaves",
  "planks",
  "glass",
  "water",
  "cobblestone",
  "bedrock",
  "gravel",
  "coal_ore",
  "iron_ore",
  "gold_ore",
  "diamond_ore",
  "torch",
  "lumen",
  "crafting_table_top",
  "crafting_table_side",
  "crafting_table_front",
  "tall_grass",
  "flower_red",
  "flower_yellow",
  "bricks",
  "wool",
];
export const TILE = Object.freeze(Object.fromEntries(TILE_NAMES.map((name, i) => [name, i])));

// Render buckets and shapes (numeric for use in hot loops).
export const RENDER = Object.freeze({ NONE: 0, OPAQUE: 1, CUTOUT: 2, WATER: 3 });
export const SHAPE = Object.freeze({ CUBE: 0, CROSS: 1, TORCH: 2 });

const DEFAULTS = {
  render: RENDER.OPAQUE,
  shape: SHAPE.CUBE,
  solid: true, // collides with players/mobs/projectiles
  opaque: true, // hides neighboring faces, blocks light, casts ambient occlusion
  lightFilter: 0, // extra light lost passing through (non-opaque blocks only)
  skyPass: false, // full-strength sky light passes straight down without loss
  emission: 0, // light level emitted (0-15)
  emissive: false, // renders glowing (independent of the light it emits)
  wave: false, // sways in the wind
  selectable: true, // can be targeted by the crosshair
  replaceable: false, // placing a block into this cell just replaces it
  support: null, // "solid": needs a solid block below; "soil": needs grass/dirt below
  liquid: false,
};

// faces: a tile name for all faces, or { top, bottom, side, front? }.
const DEFS = {
  [BLOCK.AIR]: { name: "Air", render: RENDER.NONE, solid: false, opaque: false, skyPass: true, selectable: false, replaceable: true, faces: "stone" },
  [BLOCK.GRASS]: { name: "Grass Block", faces: { top: "grass_top", bottom: "dirt", side: "grass_side" } },
  [BLOCK.DIRT]: { name: "Dirt", faces: "dirt" },
  [BLOCK.STONE]: { name: "Stone", faces: "stone" },
  [BLOCK.SAND]: { name: "Sand", faces: "sand" },
  [BLOCK.WATER]: {
    name: "Water",
    faces: "water",
    render: RENDER.WATER,
    solid: false,
    opaque: false,
    lightFilter: 1,
    selectable: false,
    replaceable: true,
    liquid: true,
  },
  [BLOCK.WOOD]: { name: "Log", faces: { top: "wood_top", bottom: "wood_top", side: "wood_side" } },
  [BLOCK.LEAVES]: { name: "Leaves", faces: "leaves", render: RENDER.CUTOUT, opaque: false, lightFilter: 1, wave: true },
  [BLOCK.PLANKS]: { name: "Planks", faces: "planks" },
  [BLOCK.GLASS]: { name: "Glass", faces: "glass", render: RENDER.CUTOUT, opaque: false, skyPass: true },
  [BLOCK.COBBLESTONE]: { name: "Cobblestone", faces: "cobblestone" },
  [BLOCK.BEDROCK]: { name: "Bedrock", faces: "bedrock" },
  [BLOCK.GRAVEL]: { name: "Gravel", faces: "gravel" },
  [BLOCK.COAL_ORE]: { name: "Coal Ore", faces: "coal_ore" },
  [BLOCK.IRON_ORE]: { name: "Iron Ore", faces: "iron_ore" },
  [BLOCK.GOLD_ORE]: { name: "Gold Ore", faces: "gold_ore" },
  [BLOCK.DIAMOND_ORE]: { name: "Diamond Ore", faces: "diamond_ore" },
  [BLOCK.TORCH]: {
    name: "Torch",
    faces: "torch",
    render: RENDER.CUTOUT,
    shape: SHAPE.TORCH,
    solid: false,
    opaque: false,
    skyPass: true,
    emission: 14,
    emissive: true,
    support: "solid",
  },
  [BLOCK.LUMEN]: { name: "Lumen Crystal", faces: "lumen", emission: 15, emissive: true },
  [BLOCK.CRAFTING_TABLE]: {
    name: "Crafting Table",
    faces: { top: "crafting_table_top", bottom: "planks", side: "crafting_table_side", front: "crafting_table_front" },
  },
  [BLOCK.TALL_GRASS]: {
    name: "Tall Grass",
    faces: "tall_grass",
    render: RENDER.CUTOUT,
    shape: SHAPE.CROSS,
    solid: false,
    opaque: false,
    skyPass: true,
    wave: true,
    replaceable: true,
    support: "soil",
  },
  [BLOCK.FLOWER_RED]: {
    name: "Red Blossom",
    faces: "flower_red",
    render: RENDER.CUTOUT,
    shape: SHAPE.CROSS,
    solid: false,
    opaque: false,
    skyPass: true,
    wave: true,
    support: "soil",
  },
  [BLOCK.FLOWER_YELLOW]: {
    name: "Sunpetal",
    faces: "flower_yellow",
    render: RENDER.CUTOUT,
    shape: SHAPE.CROSS,
    solid: false,
    opaque: false,
    skyPass: true,
    wave: true,
    support: "soil",
  },
  [BLOCK.BRICKS]: { name: "Bricks", faces: "bricks" },
  [BLOCK.WOOL]: { name: "Wool", faces: "wool" },
};

// Face order used everywhere: +X, -X, +Y (top), -Y (bottom), +Z, -Z.
export const FACE = Object.freeze({ PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 });

export const BLOCK_INFO = {};
for (const [idStr, def] of Object.entries(DEFS)) {
  const id = Number(idStr);
  const info = { id, ...DEFAULTS, ...def };
  const f = typeof def.faces === "string" ? { top: def.faces, bottom: def.faces, side: def.faces } : def.faces;
  const side = TILE[f.side];
  // Per-face tile layer in FACE order. A "front" face (crafting table) is
  // shown on +Z and -Z; the other sides use "side".
  const front = f.front ? TILE[f.front] : side;
  info.faceTiles = [side, side, TILE[f.top], TILE[f.bottom], front, front];
  info.faces = { top: TILE[f.top], bottom: TILE[f.bottom], side };
  for (const t of info.faceTiles) {
    if (t === undefined) throw new Error(`Block ${info.name}: unknown texture tile in ${JSON.stringify(def.faces)}`);
  }
  BLOCK_INFO[id] = info;
}

// ---------- Flat lookup tables for hot loops (indexed by block id) ----------
function table(fn) {
  const t = new Uint8Array(256);
  for (const info of Object.values(BLOCK_INFO)) t[info.id] = fn(info);
  return t;
}

// Unknown ids (e.g. from a newer save) behave like opaque, solid stone.
export const IS_OPAQUE = table((b) => (b.opaque ? 1 : 0));
export const IS_SOLID = table((b) => (b.solid ? 1 : 0));
export const LIGHT_FILTER = table((b) => b.lightFilter);
export const SKY_PASS = table((b) => (b.skyPass ? 1 : 0));
export const EMISSION = table((b) => b.emission);
export const RENDER_TYPE = table((b) => b.render);
export const SHAPE_OF = table((b) => b.shape);
export const WAVES = table((b) => (b.wave ? 1 : 0));
export const EMISSIVE = table((b) => (b.emissive ? 1 : 0));
export const IS_LIQUID = table((b) => (b.liquid ? 1 : 0));
export const IS_SELECTABLE = table((b) => (b.selectable ? 1 : 0));
export const IS_REPLACEABLE = table((b) => (b.replaceable ? 1 : 0));
for (let id = 0; id < 256; id++) {
  if (!BLOCK_INFO[id]) {
    IS_OPAQUE[id] = 1;
    IS_SOLID[id] = 1;
    RENDER_TYPE[id] = RENDER.OPAQUE;
    IS_SELECTABLE[id] = 1;
  }
}
// FACE_TILES[id * 6 + face] = texture layer.
export const FACE_TILES = new Uint8Array(256 * 6);
for (let id = 0; id < 256; id++) {
  const info = BLOCK_INFO[id] || BLOCK_INFO[BLOCK.STONE];
  for (let f = 0; f < 6; f++) FACE_TILES[id * 6 + f] = info.faceTiles[f];
}

export function isOpaque(id) {
  return IS_OPAQUE[id] === 1;
}

export function isSolid(id) {
  return IS_SOLID[id] === 1;
}

export function isTransparent(id) {
  return id !== BLOCK.AIR && IS_OPAQUE[id] === 0;
}

export function blockName(id) {
  return BLOCK_INFO[id]?.name ?? `Block #${id}`;
}

// Whether block `id` placed at a cell is supported by `belowId` underneath.
export function isSupportedBy(id, belowId) {
  const support = BLOCK_INFO[id]?.support;
  if (!support) return true;
  if (support === "soil") return belowId === BLOCK.GRASS || belowId === BLOCK.DIRT;
  return IS_SOLID[belowId] === 1 && IS_OPAQUE[belowId] === 1;
}

// Blocks placeable from the (pre-inventory) hotbar.
export const HOTBAR = [
  BLOCK.GRASS,
  BLOCK.DIRT,
  BLOCK.STONE,
  BLOCK.COBBLESTONE,
  BLOCK.PLANKS,
  BLOCK.WOOD,
  BLOCK.GLASS,
  BLOCK.TORCH,
  BLOCK.LUMEN,
];
