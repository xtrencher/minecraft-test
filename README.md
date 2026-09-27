# Voxelands

A tiny procedurally-generated voxel world that runs entirely in the browser —
no install, no build step, no accounts. Inspired by block-building sandbox
games, built from scratch with plain JavaScript and [Three.js](https://threejs.org/).

Every terrain feature, texture, and sound effect is generated in code at
runtime — there are no external image or audio assets.

## Play

Open `index.html` (see **Running locally** below), click "Click to Play" to
lock your mouse, and you're in.

### Controls

| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Look around | Mouse |
| Jump | `Space` |
| Toggle flight (fly up/down with Space/Shift) | Double-tap `Space` |
| Break block | Left click |
| Place block | Right click |
| Select hotbar slot | `1`-`8` or scroll wheel |
| Throw Blast Orb (see below) | `F` |
| Pause / open menu | `Esc` |

### The Blast Orb

Your signature tool: press `F` to lob a glowing orb. Wherever it lands, it
blasts out a crater of terrain in a small explosion, complete with a particle
burst and a sound effect. It has a short cooldown, so use it to quickly dig,
clear space for a build, or just for fun. Explosions are permanent and saved
like any other block edit.

## Sharing a world

Every world is generated from a numeric **seed**. Two players using the same
seed (and who haven't edited it) will see exactly the same terrain.

- The current seed is shown on the start menu and in the pause menu.
- To share your world, use the **"Copy world link"** button in the pause
  menu, or manually add `?seed=NUMBER` to the page's URL, e.g.:

  ```
  https://your-deployment-url/?seed=12345
  ```

- Opening the game with no `?seed=` in the URL generates a new random world
  each time.

Note that block edits (breaking/placing/explosions) are saved to your
browser's local storage per-seed, on your device only — they aren't shared
with other players who open the same seed link.

## Running locally

You need [Node.js](https://nodejs.org/) installed (for `npx`) — nothing else.
The game itself has zero dependencies; `npx serve` is just an easy way to get
a local static file server (the game must be served over HTTP, not opened
directly as a `file://` URL, for ES module imports to work).

**Windows:**
```
start.bat
```

**macOS / Linux:**
```
./start.sh
```

Either script starts a local server and prints a URL (typically
`http://localhost:5173`) — open it in your browser.

## Deploying

This is a static site: everything under this folder can be hosted as-is,
including on GitHub Pages. The `.nojekyll` file is included so GitHub Pages
serves the `js/` folder correctly. All imports use relative paths.

## Tech notes

- Plain ES modules, no bundler. Three.js is loaded from a CDN via an import
  map pinned to an exact version (see `index.html`).
- Terrain uses a from-scratch seeded Perlin noise implementation
  (`js/noise.js`) — no noise library.
- All block textures are drawn pixel-by-pixel onto a canvas at startup to
  build a texture atlas (`js/blocks.js`) — no image files.
- All sound effects are synthesized with the Web Audio API (`js/audio.js`) —
  no audio files.
- See `PROGRESS.md` for the full development log, design decisions, and a
  self-assessment.
