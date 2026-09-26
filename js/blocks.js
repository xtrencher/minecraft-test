// Block definitions and procedurally-generated pixel-art texture atlas.
import * as THREE from "three";
import { mulberry32 } from "./noise.js";

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
  TNT: 10,
});

export const TILE = Object.freeze({
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WOOD_SIDE: 5,
  WOOD_TOP: 6,
  LEAVES: 7,
  PLANKS: 8,
  GLASS: 9,
  WATER: 10,
  TNT_SIDE: 11,
  TNT_TOP: 12,
});

export const TILE_SIZE = 16;
export const TILES_PER_ROW = 8;
export const ATLAS_SIZE = TILE_SIZE * TILES_PER_ROW;

// Per-block face tile lookup: { top, bottom, side }
export const BLOCK_INFO = {
  [BLOCK.GRASS]: { name: "Grass", opaque: true, transparent: false, liquid: false, faces: { top: TILE.GRASS_TOP, bottom: TILE.DIRT, side: TILE.GRASS_SIDE } },
  [BLOCK.DIRT]: { name: "Dirt", opaque: true, transparent: false, liquid: false, faces: { top: TILE.DIRT, bottom: TILE.DIRT, side: TILE.DIRT } },
  [BLOCK.STONE]: { name: "Stone", opaque: true, transparent: false, liquid: false, faces: { top: TILE.STONE, bottom: TILE.STONE, side: TILE.STONE } },
  [BLOCK.SAND]: { name: "Sand", opaque: true, transparent: false, liquid: false, faces: { top: TILE.SAND, bottom: TILE.SAND, side: TILE.SAND } },
  [BLOCK.WATER]: { name: "Water", opaque: false, transparent: true, liquid: true, faces: { top: TILE.WATER, bottom: TILE.WATER, side: TILE.WATER } },
  [BLOCK.WOOD]: { name: "Wood", opaque: true, transparent: false, liquid: false, faces: { top: TILE.WOOD_TOP, bottom: TILE.WOOD_TOP, side: TILE.WOOD_SIDE } },
  [BLOCK.LEAVES]: { name: "Leaves", opaque: false, transparent: true, cutout: true, liquid: false, faces: { top: TILE.LEAVES, bottom: TILE.LEAVES, side: TILE.LEAVES } },
  [BLOCK.PLANKS]: { name: "Planks", opaque: true, transparent: false, liquid: false, faces: { top: TILE.PLANKS, bottom: TILE.PLANKS, side: TILE.PLANKS } },
  [BLOCK.GLASS]: { name: "Glass", opaque: false, transparent: true, cutout: true, liquid: false, faces: { top: TILE.GLASS, bottom: TILE.GLASS, side: TILE.GLASS } },
  [BLOCK.TNT]: { name: "TNT", opaque: true, transparent: false, liquid: false, faces: { top: TILE.TNT_TOP, bottom: TILE.TNT_TOP, side: TILE.TNT_SIDE } },
};

export const HOTBAR = [BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.SAND, BLOCK.WOOD, BLOCK.LEAVES, BLOCK.PLANKS, BLOCK.GLASS];

export function isOpaque(id) {
  if (id === BLOCK.AIR) return false;
  const info = BLOCK_INFO[id];
  return info ? info.opaque : true;
}

export function isTransparent(id) {
  if (id === BLOCK.AIR) return false;
  const info = BLOCK_INFO[id];
  return info ? !!info.transparent : false;
}

export function isSolid(id) {
  if (id === BLOCK.AIR) return false;
  const info = BLOCK_INFO[id];
  if (!info) return true;
  return !info.liquid;
}

function tileXY(tileIndex) {
  const col = tileIndex % TILES_PER_ROW;
  const row = Math.floor(tileIndex / TILES_PER_ROW);
  return [col * TILE_SIZE, row * TILE_SIZE];
}

// Canvas pixel-space coordinates of a tile (for drawImage crops, e.g. UI icons).
export function tileCanvasXY(tileIndex) {
  return tileXY(tileIndex);
}

function rectRand(rand, min, max) {
  return min + rand() * (max - min);
}

function drawSpeckled(ctx, x, y, base, variance, rand, alpha = 255) {
  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      const v = (rand() - 0.5) * variance;
      const r = Math.max(0, Math.min(255, base[0] + v));
      const g = Math.max(0, Math.min(255, base[1] + v));
      const b = Math.max(0, Math.min(255, base[2] + v));
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${alpha / 255})`;
      ctx.fillRect(x + px, y + py, 1, 1);
    }
  }
}

function drawGrassTop(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [86, 158, 58], 40, rand);
}

function drawGrassSide(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [122, 88, 58], 30, rand);
  for (let px = 0; px < TILE_SIZE; px++) {
    const edge = 3 + Math.floor(rand() * 2);
    for (let py = 0; py < edge; py++) {
      const v = (rand() - 0.5) * 40;
      const r = Math.max(0, Math.min(255, 86 + v));
      const g = Math.max(0, Math.min(255, 158 + v));
      const b = Math.max(0, Math.min(255, 58 + v));
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x + px, y + py, 1, 1);
    }
  }
}

function drawDirt(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [122, 88, 58], 30, rand);
}

function drawStone(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [128, 128, 132], 26, rand);
  for (let i = 0; i < 10; i++) {
    const px = Math.floor(rand() * TILE_SIZE);
    const py = Math.floor(rand() * TILE_SIZE);
    const c = 90 + Math.floor(rand() * 20);
    ctx.fillStyle = `rgb(${c},${c},${c + 2})`;
    ctx.fillRect(x + px, y + py, 1, 1);
  }
}

function drawSand(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [222, 202, 145], 18, rand);
}

function drawWoodSide(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [117, 84, 51], 14, rand);
  for (let px = 0; px < TILE_SIZE; px += 3) {
    for (let py = 0; py < TILE_SIZE; py++) {
      const v = (rand() - 0.5) * 20 - 10;
      const r = Math.max(0, Math.min(255, 90 + v));
      const g = Math.max(0, Math.min(255, 62 + v));
      const b = Math.max(0, Math.min(255, 38 + v));
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x + px, y + py, 1, 1);
    }
  }
}

function drawWoodTop(ctx, x, y, rand) {
  const cx = x + TILE_SIZE / 2;
  const cy = y + TILE_SIZE / 2;
  drawSpeckled(ctx, x, y, [200, 170, 120], 12, rand);
  for (let r = 1; r < 8; r += 2) {
    ctx.strokeStyle = `rgba(120,85,50,0.8)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawLeaves(ctx, x, y, rand) {
  // Leave transparent by default; fill ~72% of pixels for a leafy, gappy look.
  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      if (rand() < 0.72) {
        const v = (rand() - 0.5) * 40;
        const g = Math.max(0, Math.min(255, 110 + v));
        ctx.fillStyle = `rgba(${40 + (v * 0.3) | 0},${g | 0},${30},1)`;
        ctx.fillRect(x + px, y + py, 1, 1);
      }
    }
  }
}

function drawPlanks(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [186, 140, 90], 14, rand);
  ctx.fillStyle = "rgba(110,75,45,0.55)";
  for (let py = 3; py < TILE_SIZE; py += 4) {
    ctx.fillRect(x, y + py, TILE_SIZE, 1);
  }
  ctx.fillRect(x + 4, y, 1, 4);
  ctx.fillRect(x + 12, y + 4, 1, 4);
  ctx.fillRect(x + 8, y + 8, 1, 4);
  ctx.fillRect(x + 2, y + 12, 1, 4);
}

function drawGlass(ctx, x, y, rand) {
  ctx.fillStyle = "rgba(200,230,235,0.28)";
  ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillRect(x, y, TILE_SIZE, 1);
  ctx.fillRect(x, y, 1, TILE_SIZE);
  ctx.fillStyle = "rgba(80,110,115,0.5)";
  ctx.fillRect(x, y + TILE_SIZE - 1, TILE_SIZE, 1);
  ctx.fillRect(x + TILE_SIZE - 1, y, 1, TILE_SIZE);
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.fillRect(x + 3, y + 3, 2, 2);
  ctx.fillRect(x + 9, y + 8, 2, 2);
}

function drawWater(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [55, 110, 200], 20, rand, 235);
}

function drawTntSide(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [190, 60, 40], 12, rand);
  ctx.fillStyle = "rgba(240,240,230,0.9)";
  ctx.fillRect(x, y + 6, TILE_SIZE, 4);
  ctx.fillStyle = "rgba(30,30,30,0.85)";
  ctx.fillRect(x + 6, y + 7, 4, 2);
}

function drawTntTop(ctx, x, y, rand) {
  drawSpeckled(ctx, x, y, [190, 60, 40], 12, rand);
  ctx.fillStyle = "rgba(240,240,230,0.9)";
  ctx.fillRect(x + 4, y + 4, 8, 8);
}

export function buildTextureAtlas() {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext("2d");
  const rand = mulberry32(1337);

  const drawers = [
    [TILE.GRASS_TOP, drawGrassTop],
    [TILE.GRASS_SIDE, drawGrassSide],
    [TILE.DIRT, drawDirt],
    [TILE.STONE, drawStone],
    [TILE.SAND, drawSand],
    [TILE.WOOD_SIDE, drawWoodSide],
    [TILE.WOOD_TOP, drawWoodTop],
    [TILE.LEAVES, drawLeaves],
    [TILE.PLANKS, drawPlanks],
    [TILE.GLASS, drawGlass],
    [TILE.WATER, drawWater],
    [TILE.TNT_SIDE, drawTntSide],
    [TILE.TNT_TOP, drawTntTop],
  ];

  for (const [tile, fn] of drawers) {
    const [x, y] = tileXY(tile);
    fn(ctx, x, y, rand);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return { texture, canvas };
}

export function createMaterials(atlasTexture) {
  const opaque = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true });
  const cutout = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
  const water = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true, transparent: true, opacity: 0.68, depthWrite: false, side: THREE.DoubleSide });
  return { opaque, cutout, water };
}

// UV rect [u0, v0, u1, v1] for a tile index (v flipped because canvas y grows downward).
export function tileUV(tileIndex) {
  const col = tileIndex % TILES_PER_ROW;
  const row = Math.floor(tileIndex / TILES_PER_ROW);
  const u0 = (col * TILE_SIZE) / ATLAS_SIZE;
  const u1 = ((col + 1) * TILE_SIZE) / ATLAS_SIZE;
  const v0 = 1 - ((row + 1) * TILE_SIZE) / ATLAS_SIZE;
  const v1 = 1 - (row * TILE_SIZE) / ATLAS_SIZE;
  return [u0, v0, u1, v1];
}

// Small inset to avoid texture bleeding at tile edges when sampled at grazing angles.
const INSET = 0.5 / ATLAS_SIZE;
export function tileUVInset(tileIndex) {
  const [u0, v0, u1, v1] = tileUV(tileIndex);
  return [u0 + INSET, v0 + INSET, u1 - INSET, v1 - INSET];
}
