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

## Milestone 3: Performance + infinite world — DONE

**What works:**
- 16x16 chunk columns (full world height, no vertical chunking) stream in/out around the player (`World.ensureChunksAround`), sorted by distance so the nearest missing chunks generate first.
- Generation and initial meshing happen a couple of chunks per frame (`processQueues`), not all at once, so moving into new terrain doesn't stutter; the very first load (around the spawn point) is done synchronously up front instead, so the player never spawns over a hole.
- Hidden-face culling: each block only emits the faces that border a non-opaque neighbor, checking across chunk boundaries into the world for edge blocks (`Chunk.buildMesh`). Opaque, cutout (leaves/glass), and water blocks get separate geometries/materials.
- Editing or generating a chunk also queues its already-loaded neighbors for a remesh, so newly-exposed/hidden boundary faces are corrected without a full rebuild of everything.
- Chunks outside `renderDistance + 2` are unloaded (geometry disposed, removed from the scene) each time the player moves.
- Live FPS counter in the top-left corner, updated twice a second.
- Render distance slider in the pause menu (2-10 chunks, default 4) is wired directly to `ensureChunksAround` and the fog's far plane, taking effect immediately.

**Testing:** Re-ran the Playwright smoke test holding W for 3 seconds (crossing chunk boundaries, forcing load/unload cycles) — zero console errors.

**Known bugs / simplifications:**
- No greedy meshing (merging coplanar faces into larger quads) — plain per-face culling only. Good enough at the default render distance; a larger render distance on very weak GPUs would show it first.
- Chunk generation/meshing runs on the main thread (no Web Worker), which is why it's throttled to a couple of chunks per frame rather than being fully async.

## Milestone 4: Atmosphere — DONE

**What works:**
- Trees were already generated as part of the terrain generator since Milestone 1 (see that entry) — nothing new needed there.
- Day/night cycle (`js/sky.js`, new module): a 3-minute full cycle moves a directional "sun" light in an arc around the player, with intensity fading to a dim (but never pitch-black) floor at night; ambient light intensity follows the same curve so the world stays readable after dark.
- Sky color and fog color both lerp between night/day/sunset tones based on sun height, recomputed every frame and kept in sync with each other (fog color always matches the sky so the render-distance edge stays invisible).
- Distance fog's far plane is tied to the render-distance setting (already wired in Milestone 3), so raising render distance pushes fog out further and vice versa.
- Semi-transparent water: existing translucent blue material now also animates — opacity gently pulses and its color tints subtly over time for a shimmering effect.
- Cloud layer: a large textured plane floats above the world and follows the player horizontally, with a slowly-scrolling procedurally-drawn puff texture and brightness that dims at night.

**Bug found + fixed during this milestone:** the cloud plane's "empty" (fully transparent) texture regions rendered as a solid tinted slab instead of vanishing, under the sandbox's software WebGL (SwiftShader) — visible as a hard straight seam across the sky in the smoke-test screenshot. Diagnosed by toggling the mesh's visibility to confirm it was the cloud plane, then switched from alpha-blended transparency to alpha-tested cutout rendering (`alphaTest: 0.4`, `transparent: false`) — the same robust technique already used for leaves/glass blocks — which discards fragments outright instead of blending them. Confirmed fixed via a fresh screenshot (clean sky, no seam) and doubles as evidence the leaves/glass cutout approach elsewhere is the right call for this renderer, too.

**Also decided against animating water via texture-offset scrolling:** the water material shares the single block atlas texture with every other block type (to keep one draw-texture for the whole world), so shifting that texture's UV offset for a "flowing" look would have bled into neighboring atlas tiles (stone, sand, etc. sampled at the wrong spot) for every other block, not just water. Used opacity/color pulsing instead, which is visually adequate and touches nothing shared.

**Testing:** Re-ran the Playwright smoke test (0 console errors) and visually verified via screenshots at multiple points in this milestone, including the before/after of the cloud transparency fix.

**Known bugs / simplifications:**
- No stars or moon at night, just a dark sky tone — kept simple given time budget.
- Sun is a light source only, not a visible disc in the sky.
- Cloud puffs are static in shape (only their scroll offset and world position under the player move); no cloud regeneration.

## Milestone 5: Persistence + polish — DONE

**What works:**
- Block edits (breaks and placements) are saved to `localStorage` as a compact flat `[x,y,z,id, x,y,z,id, ...]` array, keyed per-seed (`voxelands_v1_edits_<seed>`) so different worlds don't clobber each other. All keys use the `voxelands_v1_` prefix so the game never touches unrelated data on its origin.
- Saving is throttled (at most once every 2 seconds while edits are pending) rather than on every single block change, and also flushed immediately on `beforeunload` and on tab-hide (`visibilitychange`), so closing the tab or switching away doesn't lose the last few edits.
- Loading happens before terrain generation: saved edits for the current seed are read at startup and re-applied on top of the freshly-generated chunks as they stream in, so a saved world looks exactly as it was left.
- `js/storage.js` wraps every `localStorage` call in try/catch and logs a warning instead of throwing if storage is full, disabled, or unavailable (private browsing, quota exceeded, etc.) — the game keeps running either way, it just won't persist that session.
- Start menu (seed display + controls list) and pause menu (render distance, seed, controls, copy-world-link button) were already built in earlier milestones; verified both still work correctly with the fuller feature set.
- Web Audio sound effects are now fully wired: break, place, footsteps (distance-triggered while walking on the ground), and jump, all synthesized procedurally (noise bursts + oscillators, no audio files). The AudioContext is started on the first "Play"/"Resume" click to satisfy browser autoplay policies.

**Testing:** Extended the smoke test to check `localStorage` after a break+place sequence, then reload the page and confirm the saved edits persist across the reload. Passed — verified a real edit round-trip (`[1,23,5,1]`, i.e. a single coordinate whose final state survived a break-then-place-back sequence, since only the latest value per coordinate needs to persist). Zero console errors throughout, including through the reload.

**Known bugs / simplifications:**
- No explicit "world saved" UI indicator — saving is silent/automatic. Given the scope, decided this is the right default (no interruption), but a future version could add a small toast.
- Footstep sound doesn't vary by block type walked on (grass vs. stone vs. sand) — a single generic footstep sound for simplicity.

## Milestone 6: Signature feature — DONE

**Chosen feature: the Blast Orb.** Press `F` to throw a glowing projectile (with its own point light) that arcs under gravity; on impact with any block it carves a spherical crater (radius 3) out of the terrain, plays a procedural explosion sound, and bursts into a shower of small fading cube particles. It has a 3-second cooldown so it can't be spammed. I picked this over other ideas I considered (a generative ambient soundtrack, fireflies at night) because it's the most *actively fun* to trigger repeatedly, gives instant, satisfying, visible feedback, and reuses systems already built for building/breaking (world.setBlock, chunk remeshing, persistence) rather than requiring a whole new subsystem — low risk to implement well within the remaining time, high payoff in "delight per keypress."

**Bonus mechanic (folded in earlier since it lives in `player.js`'s input handling): double-tap Space toggles Creative Flight** — gravity is disabled, Space/Shift move up/down, and movement speed increases. This makes it fast and satisfying to survey builds or explore terrain, and is a one-line-of-intent, low-risk feature (reuses the exact same movement/collision code path, just skips gravity and reads two extra keys).

**What works:**
- `js/effects.js` (new module): projectile physics, sphere-carving explosion (skips any already-air cells so it's cheap on repeated blasts in the same spot), and a small particle-burst pool that fades and shrinks each particle over ~1 second before disposing it.
- Explosions correctly go through `world.setBlock`, so blast damage persists to `localStorage` and re-meshes affected chunks (and their neighbors, if the blast crosses a chunk boundary) exactly like a manual break.
- Flight toggle plays a distinct rising/falling tone via the Audio module so the mode switch has clear feedback even though there's no HUD flight indicator.

**Testing:** Extended the smoke test to press F and wait for the explosion, then confirmed via `localStorage` that a real spherical cluster of blocks was cleared (dozens of coordinates set to id 0 around a center point) and survived a page reload. Also exercised the double-tap-Space flight toggle twice (on/off) with no console errors. A screenshot after the explosion shows a clean carved-out crater in the terrain.

**Known bugs / simplifications:**
- No HUD indicator for the Blast Orb's cooldown or for flight mode being active — a future version could add a small icon/timer.
- Explosion crater is a perfect sphere with no partial-block "damage" states — blocks are either fully there or fully gone, consistent with the rest of the voxel model.

## Testing, README, and final self-assessment — DONE

**Testing summary:** A headless Chromium (SwiftShader software WebGL) smoke test lives under `/tools` and was re-run after every milestone. Its final form: loads the page, clicks Play, drives WASD + mouse-look, breaks and places blocks, switches hotbar slots via digit key and scroll wheel, throws the Blast Orb and confirms a real crater was carved, toggles flight on/off via double-tap Space, and verifies block edits survive a full page reload via `localStorage` — all while asserting zero `console.error`/`pageerror` events. It currently passes cleanly. It also caught two real, non-cosmetic-only bugs before they shipped (see below), which is exactly what it was for.

**Bugs the automated test + review caught and fixed along the way:**
1. **Stale aim direction.** `player.getForwardVector()` originally called `camera.getWorldDirection()`, but the camera's `matrixWorld` is only refreshed inside `renderer.render()`, which runs *after* the per-frame block raycast — so the block outline/break/place aim was one frame stale during fast mouse movement. Fixed by computing the forward vector directly from yaw/pitch.
2. **Cloud transparency bug under software WebGL.** The cloud layer's "empty" texture regions rendered as a solid tinted slab (visible as a hard seam across the sky) instead of vanishing. Diagnosed by toggling the mesh's visibility, then fixed by switching from alpha-blended transparency to alpha-tested cutout rendering (the same technique already used for leaves/glass), which discards fragments instead of blending them.

Also deliberately avoided a third bug before writing any code for it: animating water by scrolling its texture's UV offset would have bled into every other block's texture, since water shares one atlas texture with the rest of the world to keep a single draw material. Used opacity/color pulsing instead.

## Self-assessment

**What I'm happy with:**
- The whole thing is genuinely playable end-to-end: walk, jump, look around, terrain streams in smoothly, breaking/placing feels responsive, day turns to night, water sits below the surface at a consistent sea level across the whole map, and worlds persist and reload correctly by seed.
- The procedural texture atlas holds up surprisingly well for something drawn with `fillRect` loops — grass, wood rings, and the leafy gap pattern in particular read clearly at a glance.
- Finding and fixing the stale-camera-matrix bug and the cloud-transparency bug before ever showing them to a human is the best outcome I could have hoped for from the "set up one headless test" instruction — both were real, easy-to-miss bugs, not just style nits.
- The Blast Orb ended up more satisfying than I expected from the plan — reusing the existing block-edit/persistence pipeline instead of building a parallel "damage" system kept it simple and made it "just work" with saving/reloading for free.

**What I'd improve with more time:**
- **Greedy meshing.** Right now every exposed block face is its own quad; merging coplanar faces into larger quads would cut vertex counts substantially at higher render distances and is the single biggest remaining performance lever.
- **Web Workers for chunk generation.** Terrain generation and meshing run on the main thread, throttled to a couple of chunks per frame to avoid stutter. Moving this to a worker would let chunks stream in faster without ever risking a dropped frame.
- **A proper voxel DDA raycast** instead of the fixed 0.05-step incremental raycast used for block targeting — functionally fine at this scale, but not the "correct" algorithm.
- **Biome variety.** Right now there's one continuous height-based biome (grass/dirt/stone/sand/water) with no temperature/moisture variation — deserts, snow, or stone mountains at altitude would go a long way for visual variety.
- **A visible sun/moon disc and stars**, rather than just a light source and color-graded sky — would sell the day/night cycle even harder.
- **In-game feedback for the Blast Orb cooldown and flight mode** (a small HUD icon/timer) — both work correctly but are currently silent about their own state beyond a sound cue.
- **Underwater rendering** (a blue tint/fog overlay when the camera is submerged) isn't implemented — swimming into water currently looks the same as being above it, aside from the translucent blocks themselves.
- I'd also want to test on a couple of real GPUs/browsers rather than only the sandbox's software renderer — SwiftShader caught real bugs, but it's not a substitute for confirming smoothness on real hardware at higher render distances.

**Rough size:** ~2,000 lines of JavaScript across 11 modules (`main.js` ~275, `world.js` ~280, `blocks.js` ~245, `player.js` ~235, `chunk.js` ~155, `ui.js` ~120, `effects.js` ~125, `sky.js` ~95, `audio.js` ~90, `noise.js` ~90, `storage.js` ~50), plus a ~240-line `index.html` and a small standalone test harness under `/tools`.
