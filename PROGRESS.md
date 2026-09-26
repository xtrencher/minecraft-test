# Voxelands — Progress Log

## Milestone 1: Core terrain + first-person controls — DONE

**What works:**
- Procedural terrain generated with a from-scratch seeded 2D Perlin noise (`js/noise.js`, `mulberry32` PRNG + classic Perlin permutation table + fBM). Grass/dirt/stone/sand/water-level terrain (`js/world.js`).
- World seed is read from `?seed=NUMBER` in the URL (random if absent) and displayed on the start menu and pause menu.
- First-person controls in `js/player.js`: WASD movement relative to camera yaw, mouse look (pointer-lock based, pitch clamped to avoid flipping), Space to jump, gravity, and swept-AABB vs. voxel-grid collision resolved per-axis (x, y, z independently) so the player slides along walls/ground correctly.
- Procedurally generated pixel-art texture atlas (canvas-drawn, no external images) in `js/blocks.js` — grass top/side, dirt, stone, sand, wood (side+top rings), leaves, planks, glass, water, TNT.
- Chunk data storage + face-culled meshing in `js/chunk.js` (only exposed faces are emitted; opaque/cutout/water get separate geometries/materials).
- Basic chunk streaming loop already wired in `js/world.js`/`js/main.js` since terrain can't render at all otherwise (generation + initial meshing spread across frames via a queue).
- Trees and a sea-level water table are generated as part of the base terrain generator (in `world.generateTerrain`/`placeTree`) since they're intrinsic to the height-map algorithm — full atmosphere polish (day/night, fog tuning, clouds, animated water) still lands in the Milestone 4 commit.
- Hotbar UI, crosshair, FPS counter, start menu and pause menu shells exist (`js/ui.js`, `index.html`) though block breaking/placing input isn't wired yet (Milestone 2).
- Mobile/touch devices get a friendly "keyboard & mouse required" message instead of a broken canvas.

**Testing:** Set up a headless Chromium smoke test under `/tools` (Playwright-core driving the pre-installed sandboxed Chromium with SwiftShader software WebGL). The sandbox's network policy blocks `cdn.jsdelivr.net` (confirmed via the proxy status endpoint — policy denial, not a bug), so the test does an npm-installed local copy of the exact same pinned `three@0.160.0` and uses Playwright's `page.route()` to redirect only the CDN URL to that local file *for the test itself*; `index.html` still imports three.js from the CDN for real players, who won't be behind this sandbox proxy. The test loads the page, clicks Play, simulates WASD + mouse movement, and asserts zero `console.error`/`pageerror` events. It currently passes with 0 errors and a live FPS counter. A screenshot confirmed terrain, trees, textures, hotbar and crosshair all render correctly.

**Known bugs / simplifications:**
- No block breaking/placing yet (Milestone 2).
- Render distance slider exists in the pause menu DOM but isn't wired to `world.ensureChunksAround` yet — using a fixed default of 4 chunks for now.
- No day/night, fog tuning by distance, or clouds yet — flat sky-blue background + a fixed light rig.
- No sound effects wired yet (Audio class exists but isn't called from gameplay events).
- No save/load of edits yet (nothing to save until breaking/placing exists).

## Milestone 2: Building — DONE

**What works:**
- Left click breaks the targeted block, right click places the selected hotbar block, both via a simple incremental voxel raycast (`world.raycast`, 0.05 step, 6 block reach) run every frame from the camera eye position.
- Found and fixed a real bug while wiring this up: `player.getForwardVector()` was using `camera.getWorldDirection()`, but the camera's `matrixWorld` is only refreshed inside `renderer.render()`, which runs *after* the raycast in the frame loop — so the aim direction was one frame stale during fast mouse movement. Replaced with a direct trig computation from yaw/pitch (`js/player.js`), which is also cheaper.
- A black wireframe box (`THREE.EdgesGeometry` + `LineSegments`) outlines the currently targeted block, hidden when nothing is in range.
- Hotbar of 8 placeable blocks (grass, dirt, stone, sand, wood, leaves, planks, glass) selectable via number keys 1-8 and the mouse scroll wheel; selection wraps around.
- Placing is blocked if the target cell isn't air or would overlap the player's own bounding box (prevents self-trapping).
- Right-click's context menu is suppressed on the canvas.
- Editing a block immediately re-meshes its chunk (and neighbor chunks too, if the edit sits on a chunk boundary) so face culling stays correct after edits.
- Break/place now trigger placeholder procedural sound effects (the Audio class was pulled forward from Milestone 5 since it made sense to wire sound feedback at the same time as the interaction).

**Testing:** Extended the Playwright smoke test to click-hold left/right mouse buttons, press a hotbar digit key, and scroll the wheel, then assert zero console errors. Passed. Screenshot confirms hotbar selection updates correctly (digit + wheel combined landed on slot 4/Sand as expected).

**Known bugs / simplifications:**
- No visual particle effect when breaking a block yet (kept simple — only the Blast Orb in Milestone 6 gets particles).
- Raycast step size (0.05) is a fixed small increment rather than a DDA/voxel-traversal algorithm; simpler to reason about and fast enough at this range, but not the most efficient approach possible.

## Milestone 3: Performance + infinite world — pending
## Milestone 3: Performance + infinite world — pending
## Milestone 4: Atmosphere — pending
## Milestone 5: Persistence + polish — pending
## Milestone 6: Signature feature — pending
