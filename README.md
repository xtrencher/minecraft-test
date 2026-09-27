# Voxelands

A procedurally generated voxel survival sandbox that runs entirely in the
browser: no install, no build step, no accounts. Inspired by block-building
survival games, built from scratch with plain JavaScript and
[Three.js](https://threejs.org/).

Everything is generated in code at runtime: the terrain, every block
texture, item icon and mob skin, the models, and all the sound effects.
There are no image, model or audio files.

## Play

Open the game (see **Running locally** below), pick **Survival** or
**Creative** on the start screen, and click **Click to Play** to lock your
mouse.

- **Survival:** start with nothing. Punch a tree for logs, turn them into
  planks and a crafting table, make a wooden pickaxe, dig down for stone,
  coal and iron, and work your way up to diamond tools. Watch your hearts:
  falls, drowning, zombies and your own Blast Orb can all kill you.
- **Creative:** every block and item from the inventory palette, instant
  mining, flight, and no damage.

You can switch modes at any time in the pause menu. Each world remembers its
mode, your position, inventory and health.

### Controls

| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Look around | Mouse |
| Jump / swim up | `Space` |
| Sprint | `Ctrl` + `W`, or double-tap `W` |
| Sneak (slow, won't walk off edges) | `Shift` |
| Mine a block / attack (hold to keep mining) | Left click |
| Place a block / use / eat (hold to eat) | Right click |
| Open a crafting table | Right click it (`Shift` + right click places against it) |
| Select hotbar slot | `1`-`9` or scroll wheel |
| Inventory and crafting | `E` |
| Drop the held item (whole stack with `Ctrl`) | `Q` |
| Throw a Blast Orb | `F` |
| Fly up / down (Creative) | Double-tap `Space` to toggle, then `Space` / `Shift` |
| Pick the targeted block (Creative) | Middle click |
| Pause menu (render distance, graphics, game mode) | `Esc` |

**In the inventory screen:** left click picks up, puts down or swaps a stack;
right click takes half or places one; `Shift` + click moves a stack between
the hotbar and the inventory (or crafts as many as possible when clicking the
result); number keys swap the hovered slot with a hotbar slot; `Q` drops from
the hovered slot; clicking outside the window drops what you're carrying.
The **Recipes** list shows everything that fits the grid, with what you can
make right now highlighted: click one to fill the grid.

### Survival basics

- **Health:** 10 hearts. They come back slowly on their own; food heals
  faster (apples, cooked meat, and the golden apple, which heals fully).
- **Mining:** harder blocks take longer; the right tool is much faster.
  Stone and coal need a pickaxe; iron needs a stone pickaxe or better; gold
  and diamonds need iron or better. Tools wear out.
- **Crafting:** 2x2 in your inventory, 3x3 at a crafting table. There is no
  furnace: smelting is crafting with coal (ore + coal gives an ingot, raw +
  coal gives cooked meat, 4 sand + coal gives 4 glass, 4 cobblestone + coal
  gives 4 stone, 4 gravel + coal gives 4 bricks). Tools come in wood, stone,
  iron and diamond: sword, pickaxe, axe and shovel.
- **Caves and ores:** caves wind underground with coal, iron, gold and, deep
  down, diamonds. Glowing lumen crystals grow on deep cave ceilings.
- **Dying** shows a big red **NOOB!** with the cause. You drop everything
  where you died and respawn at the world spawn with full health.

### Creatures

- **Fluffalo:** a shaggy, humped grazer with a cream mane. Drops fluff (4
  fluff craft into wool) and raw meat.
- **Hoplet:** a striped little hopper with tall ears. Quick to flee.
- **Mossback:** a slow, moss-covered tortoise that hides in its shell when
  hit.
- **Zombie:** comes out in the dark (at night, or in unlit caves), chases
  you, and hits hard. Zombies burn in daylight. Swords recharge between
  swings (watch the bar under the crosshair); hit while falling for a
  critical hit.

### The Blast Orb

Press `F` to lob a glowing orb. Where it lands it blasts out a big crater,
with fire, smoke, debris, a shockwave, screen shake and a boom. It has a
short cooldown (the round indicator next to the hotbar). Blasts below sea
level let the water in. In Survival it hurts you (and anything else) up
close, so throw it far.

## Graphics

The pause menu has a **Graphics** setting, saved in your browser:

- **Low:** no shadows or post-processing. For weak laptops.
- **Medium:** sun shadows and bloom.
- **High:** soft shadows, bloom, light shafts and water caustics.
- **Ultra** (default): higher-resolution shadows over a wider area, stronger
  bloom, and full resolution on high-DPI screens.

Picking a preset also sets its suggested render distance, which you can
still change with the slider (2 to 16 chunks; default 10).

## Sharing a world

Every world is generated from a numeric **seed**. The same seed always
generates the same terrain.

- The seed is shown on the start menu and in the pause menu.
- To share a world, use **Copy world link** in the pause menu, or add
  `?seed=NUMBER` to the page's URL, e.g. `https://your-deployment-url/?seed=12345`.
- Opening the game without `?seed=` generates a new random world each time.

Your block edits, position, inventory and settings are saved in your
browser's local storage, per seed, on your device only. Other players who
open the same seed link get the untouched world. Creatures and items lying
on the ground aren't saved.

## Running locally

You need [Node.js](https://nodejs.org/) installed (for `npx`), nothing else.
The game itself has no dependencies; `npx serve` is just an easy local
static file server (the game must be served over HTTP, not opened as a
`file://` URL, for ES module imports to work).

**Windows:**
```
start.bat
```

**macOS / Linux:**
```
./start.sh
```

Either script starts a local server and prints a URL (typically
`http://localhost:5173`). Open it in your browser.

## Deploying

This is a static site: the folder can be hosted as is, including on GitHub
Pages. The `.nojekyll` file makes GitHub Pages serve the `js/` folder
correctly. All imports use relative paths.

## Tests

`/tools` has two test suites (`cd tools && npm install && npm test`; the
smoke test needs a Chromium binary, set with the `CHROMIUM_PATH` environment
variable):

- `unit-tests.mjs`: fast Node tests of the pure logic (save format, the
  voxel light engine against a brute-force reference, terrain and caves,
  recipes, mining rules, inventory, collision).
- `smoke-test.mjs`: loads the real game in headless Chromium and plays it
  with real keyboard and mouse input: movement, every graphics preset,
  lighting, the Blast Orb, mining and pickup, crafting through the inventory
  screens, eating, fall and drowning damage, the death screen, zombies
  chasing and fighting, and saving and reloading. It fails on any console
  error.

## Tech notes

- Plain ES modules, no bundler. Three.js r160 comes from a CDN through an
  import map pinned to an exact version (see `index.html`).
- Terrain, caves and ore veins use seeded 2D/3D Perlin noise written from
  scratch (`js/noise.js`, `js/terrain.js`).
- Lighting is a Minecraft-style flood-fill voxel light engine (sky light and
  block light) feeding per-vertex smooth lighting and ambient occlusion
  (`js/light.js`, `js/mesher.js`), combined with sun shadow maps, HDR bloom,
  light shafts and ACES tone mapping (`js/shaders.js`, `js/postfx.js`).
- Block textures (32x32), item icons and mob skins are painted pixel by
  pixel in code (`js/textures.js`, `js/itemtextures.js`, `js/mob-models.js`).
- All sounds are synthesized with the Web Audio API (`js/audio.js`).
- See `PROGRESS.md` for the full development log, design decisions, known
  issues and a self-assessment.
