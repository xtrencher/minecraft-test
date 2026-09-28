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

---

# Round 2 — upgrade log

## Phase 1: Bug fixes — DONE

**1. Inverted W/S movement (fixed).** Root cause in `Player.update()` (`js/player.js`): the camera-space input vector (x = right, z = backward, because the camera looks down −Z) was rotated into world space with the wrong sign on both `moveZ` terms (`worldX = moveX·cos − moveZ·sin`, `worldZ = −moveX·sin − moveZ·cos`). That produced `(+sin yaw, +cos yaw)` for W, i.e. exactly the *negated* forward vector, while the strafe terms happened to be right (which is why A/D worked). Fixed to the proper rotation about +Y (`worldX = moveX·cos + moveZ·sin`, `worldZ = −moveX·sin + moveZ·cos`), which makes W produce `(−sin yaw, −cos yaw)`, the same forward vector `getForwardVector()` uses for aiming.

**Test first, then fix:** I wrote the new movement check before touching `player.js` and confirmed it failed on the old code (`KeyW at yaw 0 moved in the wrong direction (forward=-1.00)`), then applied the fix and watched it pass. The check lifts the player above the build height in flight mode (nothing to collide with), holds each of W/S/A/D, and compares the measured displacement with the camera's forward/right vectors at two different headings (yaw 0 and 2.2), plus W+D for the 45° diagonal and a walking-on-the-ground check. It waits on *distance moved* rather than a fixed time, so it's robust to slow software rendering. To make this possible, `main.js` now exposes a small debug/test hook, `window.__voxelands` (world, player, camera, spawn, game state, render distance); no game code depends on it.

**2. Default render distance is now 10 chunks** (was 4), still adjustable in the pause menu (slider range widened to 2–16), and the chosen value is now saved in `localStorage` (`voxelands_v1_settings`) so it sticks across reloads.

Going from 4 to 10 chunks means ~6× more chunks (317 vs. ~50), and the old startup code generated *every* chunk in range synchronously before the first frame, while the per-frame loop re-scanned and re-sorted the whole queue every single frame. So the render-distance change came with streaming changes to keep it smooth:
- Only a radius-2 area around spawn is generated synchronously (so the player can't fall through); the rest streams in while the start menu is showing. Page-ready time stays under ~1 s.
- `World.processQueues(budgetMs)` is now **time-budgeted** (5 ms/frame while playing, 14 ms while a menu is open) instead of "N chunks per frame", so frame time stays bounded no matter how expensive a chunk is.
- `ensureChunksAround()` only re-plans (queue re-prioritization, unloading) when the player crosses into a new chunk or the render distance changes, and it now drops queued chunks that fell out of range instead of generating them just to unload them.
- Chunks touched by block edits go into a separate queue that is remeshed first, unbudgeted, so the player's own edits never wait behind background streaming.

Measured in headless Chromium: chunk generation ≈ 0.1 ms and meshing ≈ 1.2 ms per chunk, so the full radius-10 world is ~1 s of main-thread work spread across frames.

**Testing:** The smoke test was restructured into named checks (a failure in one no longer hides the others): page load, default render distance (slider *and* live game value), Play/pointer-lock, per-key movement directions, full streaming of the radius-10 area (≥300 chunks), slider change applied + persisted, walking, break/place/hotbar/Blast Orb/flight, HUD, edit persistence across reload. All 11 checks pass with zero console errors. The CDN redirect in the test now covers any file under the pinned `three@0.160.0` path (needed for three.js addons later), and `three@0.160.0` is now declared (exact version) in `tools/package.json` instead of being an undocumented manual install.

## Phase 2: Blast Orb upgrade — DONE

**Bigger blast.** Radius 3 → **7** (≈2.3×; ~1,000 blocks per surface blast vs. at most 123 before), with a hard cap (`MAX_BLAST_RADIUS = 9`) since cost grows with r³. The crater is no longer a perfect sphere: its radius varies smoothly with *direction* (three random low-frequency waves over the sphere of directions), which gives a lumpy, natural crater while keeping the carved region star-shaped around the center.

**Farther throw on a sensible arc.** Throw speed 18 → 32 blocks/s, a small upward "lob" added to the aim so a level throw arcs instead of dropping, light air drag so the arc steepens naturally at the end, and the orb inherits half of the thrower's velocity. Measured: ~25 blocks/s horizontal over the first second vs. ~15 before; a throw from altitude landed ~71 blocks away. In water the orb slows sharply and sinks, exploding on the sea floor. Movement is sub-stepped (≤ 0.2 blocks per collision check), so the faster orb can't tunnel through a one-block wall.

**Stronger effects.** Instanced debris cubes tinted by the actual blocks destroyed (colors derived from the block textures, so they'll stay correct when textures change), bouncing off terrain; an additive fireball; sparks; a billowing smoke column; a dust ring racing along the ground; an expanding shockwave ring; a bright light flash; the orb itself glows and trails embers. **Screen shake** is trauma-based (shake ∝ trauma², decaying), scaled by distance to the blast. Blasts also **knock the player back** (new `Player.applyImpulse`, a decaying knockback velocity kept separate from input-driven movement), including an upward kick when it goes off at your feet. **Sound**: all audio now goes through a master gain + dynamics compressor, and the explosion is layered (sub-bass thump, distorted noise body with a falling filter, a sharp crack, a long rumble tail, a patter of falling debris), attenuated and slightly delayed by distance. A HUD indicator next to the hotbar shows the orb's cooldown as a radial sweep (one of the "missing HUD feedback" items from the first round's self-assessment).

**Performance.**
- Only affected chunks are rebuilt: edits queue their chunk (plus a neighbor if the edit is on a chunk border) into the edit-remesh queue, which is deduplicated, so a blast remeshes ~4 chunks, measured at ~7 ms in headless Chromium. Carving itself takes ~2–9 ms.
- Particles use fixed-capacity pools (one instanced draw call each) that recycle the oldest particle when full; nothing is allocated per particle.
- **Fixed a hitch that existed before:** every thrown orb used to add a `THREE.PointLight` and remove it on impact. Changing the light count forces three.js to recompile every lit material, so each throw and each explosion stalled. The orb light and the explosion flash are now two persistent lights that are dimmed to zero when idle.
- **Save format v2.** A radius-7 blast is ~2,000 block edits, which in the old flat JSON `[x,y,z,id,…]` format is ~24 KB per blast, enough to exhaust the ~5 MB localStorage quota after a few hundred blasts. Edits are now kept in memory per chunk (`Map<chunk, Map<blockIndex, id>>`, which also made applying saved edits to a newly generated chunk O(its own edits) instead of O(all edits in the world)), and saved as run-length-encoded, base64 records per chunk, re-encoding only chunks changed since the last save. A crater compresses ~17× (1,419 blocks → 796 chars). Old saves are still read.

**Bug caught by the new test (and fixed):** the first version of the ragged crater used an independent random threshold per block, so a block slightly *farther* from the center could be removed while a *closer* one survived, leaving sealed air bubbles inside crater walls. The "underwater blasts flood" check found one: a later blast next to an earlier crater exposed such a bubble to water, leaving a dry air cell held up by water. Fixed at the root with the star-shaped crater described above, and the flood fill now also flows into older air space that a blast breaches below sea level (an earlier crater, a dug tunnel), capped at 4,000 blocks per blast.

**Water behavior.** Water absorbs the blast (water blocks aren't destroyed), and carved cells at or below sea level that connect to water are refilled with water, so a blast at the shore or on the sea floor doesn't leave a dry pocket walled in by water.

**Testing.** New smoke-test checks: orb speed and range (sampled after 1 s of game time, so independent of frame rate), crater size and reach (6–8.2 blocks), carve time, particle burst, shake, upward knockback, "only nearby chunks remeshed" (≤ 16), underwater flooding (no air cell below sea level may touch water), and the v2 save format surviving a reload with the exact same edit count. New `tools/unit-tests.mjs` (Node, no browser) covers the save format: random round-trips, runs longer than 255, index extremes, legacy-format reading, the encode cache, corrupted data (one bad chunk doesn't lose the rest), and garbage input. `npm test` in `/tools` now runs both suites. All 14 smoke checks and 7 unit tests pass with zero console errors; screenshots confirmed the fireball, debris, smoke, flash lighting and a flooded shoreline crater.

**Known limitations.** Water doesn't flow in general (it's static, as before); the refill is a one-time fill at the moment of the blast. Explosions don't drop items; that would flood the world with thousands of item entities, so blasted blocks are simply destroyed.

## Phase 3: Graphics overhaul ("RTX look") — DONE

Real ray tracing isn't available in WebGL, so the look is built from the techniques shader packs use, on a new rendering and lighting architecture. Everything is still procedural and built on plain ES modules plus three.js r160 from the CDN (no addons were needed; the post-processing is custom).

**Voxel lighting engine (`js/light.js`, new).** Minecraft-style flood-fill lighting with two channels per block, stored per chunk: *sky light* (sunlight from above: 15 in the open, decaying sideways under overhangs, 0 in sealed caves) and *block light* (from emissive blocks). Leaves and water attenuate light. New chunks are lit including light flowing in from and out to their loaded neighbors; edits use the classic two-phase BFS (remove light that depended on the changed cells, then re-propagate), processed as one batch for bulk edits like a Blast Orb crater. This is what makes caves dark, lets torches light a room with proper occlusion by walls, and drives mob spawning in Phase 5. Because incremental light removal is famously easy to get subtly wrong, it's verified in `tools/unit-tests.mjs` against a brute-force reference solver (repeated relaxation to the fixed point): identical results for every cell after lighting chunks in random load orders and after 60 random edit batches (including 400-block ones). I also mutation-tested the test: removing either of two key rules from the engine (the sky-light "straight down at full strength" dependency, the light-source re-seeding during removal) makes it fail.

**New chunk pipeline and mesher (`js/world.js`, `js/mesher.js`, `js/chunk.js`, `js/terrain.js`).**
- A chunk is generated (terrain + saved edits + light) within render distance + 1.5, but only *meshed* once all 8 neighbors exist, since meshing reads a 1-block border from them. Each chunk is therefore normally meshed exactly once (no more "remesh all neighbors when a chunk loads"), and the edge of loaded terrain never shows wrong faces or lighting.
- The mesher copies the chunk plus its border into a padded scratch volume, so every neighbor/AO/light lookup is plain index arithmetic, and writes compact typed arrays (reused growable buffers): position, uv, and two packed `Uint8x4` attributes (normal + AO, sky light, block light, flags; texture layer, water depth).
- **Per-vertex ambient occlusion** (the classic 3-neighbor corner test) and **smooth lighting** (averaging the light of the 4 cells around each vertex, skipping opaque ones), with the quad split along the diagonal that keeps dark corners contained.
- Water surfaces sit slightly lowered and carry per-vertex water depth (average of the 4 columns at each corner) for depth-based color; plants are cross-shaped quads with a little random jitter; torches are thin 3D sticks.
- Block access, edits (`setBlocks` bulk API: one light update, one rebuild per affected chunk), support rules (plants/torches pop off when their support goes), and a proper voxel-traversal (DDA) ray cast that also hits the smaller selection boxes of torches and plants. Chunk maps use numeric keys in the hot paths.
- Measured per chunk in headless Chromium: terrain 0.07 ms, lighting 0.16 ms, meshing 0.65 ms (~2,300 vertices). The whole radius-10 world is ~0.4 s of CPU spread across frames; a Blast Orb crater rebuilds its 4 chunks in ~2.5 ms.
- Terrain keeps the original height map and tree placement exactly (shared seeds still produce the same landscape) and adds tall grass and flower patches.

**Shaders (`js/shaders.js`, new).** One shared lighting/sky/fog model for terrain, water, sky and particles:
- **Lighting:** sun (moon at night) × N·L × **shadow map**, applied only where sky light is high (so caves beyond the shadow map's range stay unlit); hemisphere sky ambient scaled by voxel sky light; warm torch light using the classic `f/(4−3f)` voxel-light curve; everything modulated by AO. Glowing texels of emissive blocks output HDR values that bloom.
- **Shadows** (`PCFSoftShadowMap` on High/Ultra): one directional light that follows the player, centered slightly ahead of the view and snapped to whole shadow-map texels so edges don't crawl as you move. Cutout geometry (leaves, grass) uses an alpha-tested, wind-animated depth material, so trees cast lacy shadows instead of solid blocks. The sun hands over to the moon at dusk, with both faded to zero at the switch so shadows never jump.
- **Sky:** an analytic, keyframed atmosphere (zenith/horizon gradients, a sunset/sunrise glow band concentrated toward the sun, Mie-like halo) driven by sun elevation through noon, golden hour, sunset, twilight and night; an HDR sun disc (bloom turns it into a glowing ball); a cratered moon with a halo; twinkling stars that rotate with the sky; soft fbm clouds lit from the sun side with silver linings.
- **Fog / aerial perspective:** geometry fades into *the sky color in the view direction* (so distant terrain melts into the horizon and glows warmer toward a setting sun), plus distance haze, and a murky blue fog under water.
- **Water:** sky reflections with Fresnel, an animated wave surface (vertex waves plus analytic normals plus ripples), a specular sun glint, depth-based color and opacity (turquoise shallows, deep blue depths), shoreline foam, a distinct look from below the surface, and animated **caustics** projected on underwater surfaces.
- **Wind:** leaves and plant tops sway (vertex animation, matched in the shadow pass).

**Post-processing (`js/postfx.js`, new).** The scene renders into a half-float HDR target with MSAA, then: **bloom** (soft-knee bright pass + 13-tap downsample chain + tent upsample chain accumulating every level); **light shafts** (radial blur toward the sun of a sky mask that the sky shader writes into alpha, so terrain and clouds occlude the rays); and a composite pass with exposure, the same **ACES** fit three.js uses (so Low, which uses three's tone mapping directly, matches), a **color grade** (saturation, contrast, split toning), vignette, underwater tint/wobble, and dithering. Exposure follows time of day, and **eye adaptation** slowly brightens the view in dark places (less so when a torch is near).

**Textures (`js/textures.js`, new).** All block textures were redesigned at **32×32** and painted in code with a small toolkit: tileable value noise (seamless repeats), quantized color ramps (crisp, banded pixel-art shading), tileable Voronoi (cobblestone, gravel, crystals) and hand-placed details (pebbles in dirt, fibrous grass blades, engraved cracks and pits in stone, vertical bark fibers and knots, growth rings, planks with seams and nail heads, leaf clusters with gaps, shaded ore nuggets, a crafting table with tools, a torch flame, glowing crystal cells). They live in one mipmapped `DataArrayTexture` (a layer per tile, so mipmaps never bleed between tiles as in an atlas), with anisotropic filtering, crisp nearest magnification, and a mip-aware alpha boost so sparse cutouts (grass, leaves) don't dissolve at a distance. Hotbar icons are drawn as isometric mini-cubes from the same pixels.

**Emissive blocks.** The **Torch** (light 14) and **Lumen Crystal** (a glowstone-like block, light 15) light their surroundings through the light engine and glow (HDR + bloom). The hotbar now has 9 slots: grass, dirt, stone, cobblestone, planks, log, glass, torch, lumen crystal. (Other new block types, like ores, gravel, bricks and wool, are defined and textured now and put into play in Phase 4.)

**Graphics presets (`js/graphics.js`, new).** A **Graphics** selector in the pause menu (Low / Medium / High / Ultra), saved in `localStorage`, **defaulting to Ultra**:
- **Low:** no post-processing (direct rendering with ACES tone mapping), no shadow maps, native pixel ratio, fewer cloud octaves, no waves or caustics. Built to run smoothly on weak laptops.
- **Medium:** 1024² shadows, bloom, 2× MSAA.
- **High:** 2048² soft shadows, bloom, light shafts, caustics, 4× MSAA.
- **Ultra:** 4096² soft shadows over a wider area, 6-level bloom, light shafts, caustics, 4× MSAA, up to 2× pixel ratio, 16× anisotropy.

Picking a preset also applies its suggested render distance (Low 6, Medium 8, High/Ultra 10), which the slider can still override. The light rig never changes shape at runtime (adding or removing lights would force every lit material to recompile), and switching presets recompiles only what's needed.

**Bugs found and fixed along the way:**
1. **Horizon blobs from NaN pixels.** The first caustics formula divided by `sin(…)`, producing 0/0 → NaN or ±∞ on some pixels; bloom's blur smeared those into huge white blobs along the shoreline. Replaced with a caustic pattern that's bounded to [0, 1] by construction, and made the bloom prefilter and composite discard NaN/Inf pixels as a safety net.
2. **White sky on Low.** The sky writes its light-shaft mask into alpha (0 = open sky). three.js r160 always creates the WebGL context *with* an alpha channel (it only emulates `alpha: false` by clearing to opaque), so on Low, which draws straight to the canvas, the page background showed through the sky. The sky now writes opaque alpha when not rendering into the post-processing target.
3. **FPS counter could never show below 20 (pre-existing).** It was fed the frame delta *after* clamping to 50 ms, so slow frames were hidden. It now uses the real frame time.
4. **Camera inside the ground behind the start menu (pre-existing).** The camera was only positioned once the player started updating. It's now synced to the player's eyes while menus are open.

**Testing.** New smoke-test checks: default preset is Ultra and renders a real image (mean/variance of the actual pixels read back from the drawing buffer); every preset renders a real image without errors and sets up shadows/MSAA as specified; the pause-menu Graphics selector applies a preset plus its render distance and persists it; a torch in a sealed underground room lights it with exact falloff (14, 13, 12, 11) and removing it restores darkness; sky light is 15 in the open, 0 underground, and flows down a freshly dug shaft. Because software rendering makes Ultra take seconds per frame in the sandbox, the gameplay checks run on Low after all presets have been verified. **18 smoke checks and 11 unit tests pass, with zero console errors.** I also reviewed screenshots of noon, golden hour, sunset, night, a torch-lit night meadow, a torch-lit cave, above/under water, light shafts through trees, and an AO close-up (under software rendering).

**Known limitations.** Water reflects the sky only (no terrain reflections, which would need screen-space reflections or a planar pass); water transparency has no refraction distortion. The light shafts are subtle (screen-space, only while the sun is on screen). Shadow maps cover a limited area around the player (72 blocks on Ultra), so shadows fade out beyond that. Real-GPU performance couldn't be measured in the sandbox, which only has a software renderer.

## Phase 4: Missing core features — DONE

**What was missing.** Compared with Minecraft's core loop (*gather → craft better tools → build and survive*), the game was a creative-only sandbox: nine infinite blocks, instant breaking, no health, no items, no inventory. I implemented everything on the phase's list, prioritizing the pieces that make up that loop (punch a tree → planks → crafting table → wooden pickaxe → stone tools → iron → diamonds, with real danger along the way), and deliberately left out features that add screens or bookkeeping without changing the loop much: **hunger** (food heals you directly instead), **furnaces** (smelting is crafting with coal, same progression, no second UI with timers), chests, beds, armor, experience and flowing water.

**Survival and Creative.** Chosen per world in the start menu (new worlds default to Survival), switchable any time in the pause menu, and saved with the world. *Creative*: a palette of every item in the inventory screen, instant breaking, blocks aren't used up, flight (double-tap Space, now creative-only), no damage, middle-click picks the targeted block into the hotbar. *Survival*: everything below.

**Health and damage (`js/player.js`).** 10 hearts. **Fall damage** counts from the peak of the fall (1 half-heart per block beyond 3; landing in water breaks any fall). **Drowning**: 10 seconds of breath shown as bubbles, then a heart per second. Falling into the void hurts fast. The player's **own Blast Orb** hurts, lethally up close, scaling down with distance (plus the existing knockback). After a hit there's a short invulnerability window in which only a *stronger* hit counts, and only by its excess (so a blast right after a fall still lands). Health regenerates slowly after 4 s without damage. Feedback: red screen-edge flash, blinking hearts, a quick camera roll, a grunt; at low health the hearts jitter and the edges pulse red.

**Death and respawn.** I built the dramatic death screen now rather than in Phase 5, since fall, drowning and orb deaths need it already (Phase 5 adds the mob causes): a dark red overlay, a huge **"NOOB!"** that slams in, then shakes and pulses, the cause below it ("Fell from a high place", "Drowned", "Fell out of the world", "Blown up by your own Blast Orb", and "Sent flying by your own Blast Orb" for a fatal landing after being launched by one), and a **Respawn** button (enabled after a moment so a panicked click doesn't skip the screen). The camera tips over as you die, your inventory spills onto the ground where you died, and you respawn at the world spawn with full health. Creative players can't die.

**Mining and drops (`js/items.js`, `js/interaction.js`).** Break time is hardness × (1.5 if the tool can harvest the block, otherwise 5) ÷ tool speed, as in Minecraft. Tool tiers gate drops: stone and coal need a pickaxe, iron needs stone or better, gold and diamond need iron or better; logs and planks mine faster with an axe, soil with a shovel. A 10-stage crack overlay shows progress, and chips fly off the face being hit with a per-material dig sound. Drops follow the familiar rules: grass gives dirt, stone gives cobblestone, coal and diamond ore drop the item, glass and tall grass drop nothing, leaves sometimes drop an apple or a stick, and torches or flowers that lose their support pop off as items. Tools wear out (durability bar, a clank when one breaks). A block mined next to the sea lets the water in.

**Items on the ground (`js/entities.js`, `js/models.js`).** Dropped items are real 3D objects: blocks as textured mini-cubes, everything else (tools, food, torches, flowers) as extruded pixel sprites built from the icon's pixels. They fall, bounce, float in water, bob and spin, get pulled into you when you're close (with a pickup pop), merge with identical stacks nearby, and despawn after 5 minutes (at most 300 exist). **Q** throws the held item (Ctrl+Q the whole stack).

**Inventory (`js/inventory.js`, `js/inventory-ui.js`, `js/hud.js`).** 36 slots: the 9-slot hotbar plus 27 more. **E** opens the inventory screen, which uses the standard mouse controls: left click picks up, puts down, swaps or merges a stack; right click takes half or places one; shift-click moves between hotbar and inventory; number keys swap the hovered slot with a hotbar slot; Q drops from the hovered slot; clicking outside the panel drops what you're carrying. Hovering shows the item's name (tools also show their remaining uses). The HUD hotbar shows the real inventory with stack counts and durability bars, plus the item's name when you switch.

**Crafting (`js/crafting.js`).** A 2×2 grid in the inventory, 3×3 at a **crafting table** (right-click it; sneak to place blocks against it instead). Shaped recipes match anywhere in the grid and mirrored; shapeless recipes match any arrangement. Recipes: planks, sticks, crafting table, torches, wool, golden apple, and 16 tools (sword, pickaxe, axe, shovel in wood, stone, iron and diamond). Smelting with coal: ore + coal → ingot, raw meat + coal → cooked meat, 4 sand + coal → 4 glass, 4 cobblestone + coal → 4 stone, 4 gravel + coal → 4 bricks. Since nobody knows a new game's recipes, the screen has a **recipe book**: every recipe that fits the current grid, the ones you can make right now highlighted, and clicking one moves the ingredients from your inventory into the grid. Shift-clicking the result crafts as many as possible.

**Ores and caves (`js/terrain.js`, `js/noise.js`).** Winding 3D-noise tunnels plus larger caverns deep down, carved so they never breach the sea (no dry air pockets held up by water) and never break the bedrock floor (now ragged, two layers). Ore veins by depth: coal (y 5–50), iron (3–40), gold (2–22), rare diamonds (1–13), and gravel pockets; lumen crystals grow on deep cave ceilings as natural light sources. The original height map, trees and shared seeds are unchanged. About 1 ms per chunk.

**More block types.** Now actually in play: coal/iron/gold/diamond ore, gravel, bricks, wool, crafting table, torch, lumen crystal, tall grass, flowers, bedrock. New items: sticks, coal, iron and gold ingots, diamonds, apples, golden apples, raw and cooked meat, fluff (meat and fluff come from Phase 5's animals), and the 16 tools. All icons are painted in code (`js/itemtextures.js`).

**Sprint, sneak and swimming.** Sprint with Ctrl or a double-tap of W (faster, wider FOV; stops when you sneak or run into a wall). Sneak with Shift (slow, lowers the camera, and won't walk you off an edge). In water you move slower, Space swims up, you can climb out onto a ledge, and there's a splash.

**In your hand (`js/held-item.js`).** The held item (or a bare arm) is drawn in first person as an overlay, so it never clips into walls. It's lit by the light where you stand, swings when you mine, place or attack, dips when you switch items, bobs as you walk, and is raised to your mouth while eating (hold right-click with food; eating takes about a second).

**Persistence.** Per world: game mode, position, view direction, health, breath, inventory, selected slot and time of day, saved every 5 seconds and when leaving the page, restored on load. Leaving mid-game asks for confirmation first (Ctrl+W while sprinting with Ctrl would otherwise close the tab).

**Sounds (`js/audio.js`).** Procedural break, place, dig and footstep sounds per material (stone, wood, dirt, grass, sand, glass, cloth, plants), plus pickup, crafting, eating, burp, hurt, death, tool break, splash and UI click sounds.

**Bugs found and fixed along the way:**
1. **Blast floods stopped short in caves.** With caves, a sea-floor blast can breach a cave system. The flood fill was depth-first, so it snaked down a tunnel and hit its cell cap while cells right next to the crater were still dry. It's now breadth-first (the crater fills first), with the cap raised to 12,000 cells (a full-cap flood measured 36 ms).
2. **Double-taps failed after a slow frame.** Double-tap detection used the time the handler ran, so a slow frame between the two taps broke it. It now uses the events' own timestamps, and a third tap no longer toggles flight twice.
3. **Stronger hits ignored.** The first version of the invulnerability window ignored *any* damage for 0.5 s, so a Blast Orb right after a fall did nothing. Now the excess of a stronger hit applies.

**Testing.** Unit tests (Node) grew to 22: terrain determinism and the unchanged height map; caves never leave air touching water or break the bedrock; sensible amounts of caves, ores and crystals; generation speed; every recipe uses real items; recipe matching (position, mirroring, extra items); tool tiers gating drops and speed; inventory add/merge/overflow and durability; slot click semantics; crafting output (take, shift-craft-all, quick move); inventory save/load with garbage rejection. The browser smoke test grew to 28 checks, driving real mouse and keyboard input: a new world starts in Survival with 10 hearts and an empty inventory; creative instant-break, placing from the hotbar without using it up, scrolling, flight toggle; mining dirt by hand takes time (the block cracks first), drops, and the drop flies into your hotbar; stone mined with a wooden pickaxe gives cobblestone and costs 1 durability; E opens the inventory and a log is crafted into 4 planks with real clicks; right-clicking a crafting table opens a 3×3 grid, the recipe book marks what's craftable and fills the grid, and shift-clicking crafts a pickaxe; eating an apple heals; a 5.5-block fall costs exactly a heart, a 30-block fall shows the NOOB! screen with "Fell from a high place" and spills the inventory, and Respawn restores full health at spawn; your own Blast Orb at your feet kills with "Blown up by your own Blast Orb"; breath runs out under water, bubbles show, and health drops; creative players take no damage from a long fall; the hotbar HUD shows counts and durability; mode, inventory and position survive a reload. All pass with zero console errors.

**Known limitations.** Items lying on the ground aren't saved (they vanish on reload). Water is still static apart from the fill when a blast or a mined block opens a path to the sea. The held item doesn't receive shadows. No drag-to-spread in the inventory screen.

## Phase 5: Mobs and combat — DONE

**Mob models (`js/mob-models.js`, new).** Mobs are box models hinged at pivots, in the classic voxel-game style, but all four designs are original. Each species lists its boxes (size, pivot, parent); the skin texture is packed automatically (one unfolded-box region per part) and painted pixel by pixel in code at 2 texels per model pixel, so faces, fur, shell plates and rags get crisp detail. Parts that never move on their own (horns, beard, hump, shell dome) are baked into their parent's mesh, so a mob costs 6–9 draw calls. Mobs use the same entity shader as dropped items, so they're lit by the voxel light where they stand (dark in caves, warm by torches), cast shadows, flash red when hit, and can have glowing texels (the zombie's eyes bloom at night).

**The species (`js/mobs.js`, new).**
- **Fluffalo** (passive): a rust-furred, humped highland grazer with a cream mane, a beard and upswept horns. Wanders, stops to graze, looks at you when you're close, bolts when hurt. 5 hearts. Drops fluff (craft 4 into wool) and raw meat.
- **Hoplet** (passive): a small sand-colored hopper with dark stripes across its back, tall pink-lined ears and a white tail. Travels in hops (ears stream back, hind legs kick), flees fast. 2 hearts. Drops raw meat, sometimes fluff.
- **Mossback** (passive): a slow tortoise whose plated shell grows moss and tiny flowers. When hurt it doesn't run: it pulls its head and legs into its shell and hides for a few seconds, taking half damage meanwhile. 7 hearts. Drops raw meat, sometimes an apple.
- **Zombie** (hostile): a hunched, pallid shambler in torn maroon rags, arms reaching forward, with sunken sockets and glowing amber eyes. Spawns in darkness, chases you, swings its arms down to hit for 1.5 hearts with knockback (once a second), groans. Burns and dies in direct daylight. 10 hearts. Drops coal, rarely an iron ingot or an apple.

**AI and pathfinding.** Animals switch between idling (sometimes grazing), wandering in a random direction, and fleeing from you (the Mossback hides instead). Zombies notice a survival-mode player within 20 blocks (and keep chasing to 28), turn their head to track you, and ignore creative players. Movement uses simple obstacle-aware steering rather than full path search: each step probes the column ahead and classifies it as *open*, a *1-block step* (jump), a *wall*, *water* or a *cliff* (drops over 2 blocks for animals, 3 for zombies). When the direct way is blocked, the mob tries detours at ±40°, ±80° and ±120°, preferring one side and remembering a working detour for a moment so it doesn't dither. Mobs never walk into water on purpose; one that ends up in water floats and paddles out.

**Physics.** Mobs collide with the world using the same box-sweep code as the player (moved into the new `js/physics.js`, which the player now uses too), with gravity, knockback, fall damage (not for the hoppers), and gentle pushing so mobs don't overlap each other or you.

**Spawning and despawning.** Animals appear in small herds on sunlit grass 24–56 blocks away (plus an initial herd around you when a world starts), up to 14. Zombies spawn 18–44 blocks away wherever it's dark (block light and night-dimmed sky light at most 4): on the surface at night, or in unlit caves at any time. Up to 10. Mobs more than 128 blocks away or in unloaded terrain are removed at once; zombies more than 48 blocks away fade out over time (on average 20 s). Mobs aren't saved.

**Combat.** Melee uses an attack charge like modern Minecraft: a sword recharges in 0.6 s, an axe in 0.9 s, other tools in 0.8 s, the bare hand in 0.35 s. Hitting early deals as little as 20% damage, and a small bar under the crosshair shows the recharge. Damage comes from the weapon (hand 1, swords 4–7 by material, axes and other tools less). Hitting while falling is a critical hit (×1.5, with sparks and a sharper sound). Hits knock the mob back (harder while sprinting), flash it red, and give it a short invulnerability window. Swords wear by 1 per hit, other tools by 2. Swinging at thin air resets the charge. You can hit mobs within 3.5 blocks (5 in creative), and mobs block block placement. Dead mobs flash red, topple over, then vanish in a puff of smoke and drop their items. Blast Orb explosions hurt and fling mobs just like the player.

**Sounds (`js/audio.js`).** Procedural voices per species (the Fluffalo's low grumble, the Hoplet's squeaks, the Mossback's clicks, the zombie's groan and attack growl), each with hurt and death variants and fading with distance, plus a hit thwack, a crit crack and a swing whoosh.

**Death by mobs.** A zombie's killing blow brings up the NOOB! screen with "Killed by a zombie". Respawning now searches for the nearest dry spot around the world spawn, because the smoke test showed that a Blast Orb crater at spawn can flood and would otherwise respawn you underwater.

**Bugs found and fixed along the way:**
1. **Knockback that didn't knock back.** The smoke test showed that a sword hit barely moved a zombie: its own chase movement toward the player cancelled the push immediately. A hit mob is now staggered for a moment (no steering and no attacks), so the knockback carries it.
2. **Animal cap overshoot.** Herds spawned whole, so the passive count could exceed its cap by two. Herd size is now clamped to the remaining room.
3. **Flooded respawn point.** See above.
4. **A too-familiar design.** My first Fluffalo (cream wool, brown face, short legs) read as a sheep in screenshots, so I redesigned it (rust fur, cream mane, hump, beard, upswept horns) to keep the mobs original.

**Testing.** New unit tests for the shared collision code (sweeps stop exactly at floors and walls; ray-box hits, misses and distance limits), for 24 in total. New browser smoke checks, all with real mouse input on purpose-built night arenas: animals spawn around a new player; a zombie chases the player, climbs a 1-block step and hits for 1.5 hearts; a fully charged iron-sword hit deals exactly 6 damage, flashes the zombie red, wears the sword by 1 and knocks the zombie back, while an immediate second swing is weak; the zombie dies, topples and is removed; a hurt Fluffalo flees, and killing it drops fluff and raw meat that the player collects; a chasing zombie stops at a water moat and never gets wet; a zombie's killing blow shows NOOB! with "Killed by a zombie"; after 600 spawn ticks at night the caps hold (10 zombies, at most 14 animals); a zombie 200 blocks away despawns; a zombie in daylight burns; a blast kills an animal; zombies ignore creative players. 35 smoke checks and 24 unit tests pass with zero console errors.

**Known limitations.** Steering isn't real path search, so a maze or a pit can leave a zombie stuck; zombies notice you through walls (no line-of-sight check); mobs don't drown and aren't saved.

## Round 2 — final summary

**What changed in this round.** Voxelands went from a creative-only block sandbox to a small survival game with a much more ambitious look:

1. **Phase 1:** fixed the inverted W/S movement (with a test that checks the direction of every key at two headings), and made 10 chunks the default render distance, with time-budgeted streaming so it doesn't freeze the page.
2. **Phase 2:** the Blast Orb became a proper explosive: a 2–3× bigger lumpy crater, a farther arcing throw, fire, smoke, debris, shockwave, flash lighting, screen shake and a layered boom. Only affected chunks rebuild, and the save format shrank ~17×.
3. **Phase 3:** a new rendering and lighting architecture: flood-fill voxel light, smooth lighting and AO, soft sun shadows, HDR bloom, light shafts, ACES tone mapping and grading, an analytic sky with sunsets, stars and a moon, reflective animated water with caustics, glowing torches and crystals, all-new 32×32 textures, and Low/Medium/High/Ultra presets.
4. **Phase 4:** survival and creative modes, health with fall/drowning/void/explosion damage, the NOOB! death screen and respawn, timed mining with tool tiers and drops, item entities, a 36-slot inventory, 2×2 and 3×3 crafting with a recipe book, caves and ores, sprinting, sneaking, swimming, a first-person held item, and player persistence.
5. **Phase 5:** three original passive animals and an original zombie, with steering that climbs steps and avoids water and cliffs, spawning by light level, caps and despawning, and melee combat with attack charge, crits, knockback, hit flashes, death animations, drops and sounds.

The codebase grew from ~2,000 lines of JavaScript in 11 modules to ~10,800 lines in 34 modules (plus a ~580-line `index.html` and ~1,700 lines of tests). It's still plain ES modules with no build step, still loads only three.js r160 from the pinned CDN, and still has no asset files.

**Testing.** Every phase ended with `node --check` on the changed files, both test suites, and a check for zero console errors. At the end: **24 unit tests** (save format, the light engine against a brute-force reference solver, terrain and caves, recipes, mining rules, inventory logic, collision) and **35 browser smoke checks** that drive the real game with keyboard and mouse input in headless Chromium, all passing with zero console errors. The smoke test caught real bugs in every phase (sealed air bubbles in crater walls, NaN pixels blooming into white blobs, a white sky on Low, blast floods stopping short in caves, a flooded respawn point, double-taps lost in slow frames).

**Known issues and limitations.**
- **Performance on real GPUs is unmeasured.** The sandbox only has a software renderer (2–5 FPS even on Low), so I verified correctness and per-system CPU costs (chunk generation ~1 ms, meshing ~0.7 ms, a crater rebuild ~2.5 ms), not frame rates. Ultra (4096² soft shadows, 4× MSAA HDR, up to 2× pixel ratio) is meant for decent desktop GPUs; if it isn't smooth, Medium or Low should be.
- **Water is static.** It only fills in when a blast or a mined block opens a path to the sea (up to 12,000 cells per event); there's no flowing water.
- **Mob pathfinding is steering, not search.** Zombies climb steps and detour around walls, but a maze, or a pit between you and them, can leave them stuck. They also notice you through walls (no line-of-sight check), and mobs don't drown.
- **Not saved:** mobs and items lying on the ground vanish on reload (block edits, the player, inventory, mode and time of day are saved).
- **Deliberately left out:** hunger, furnaces, chests, beds, armor, experience, doors, biomes. Smelting is crafting with coal instead.
- Terrain generation and meshing still run on the main thread (time-budgeted per frame); a Web Worker would make streaming smoother at high render distances. Of Round 1's wish list, the DDA ray cast, the sun/moon/stars, underwater rendering and the Blast Orb cooldown indicator are done; greedy meshing (harder now that every vertex carries its own AO and light), Web Workers and biomes are still open.
- The held item isn't shadowed, water reflects only the sky (no terrain reflections or refraction), and light shafts only appear while the sun is on screen.
- Pointer lock quirks: browsers sometimes refuse to re-lock the mouse (for example within about a second of pressing Esc during play). When that happens after closing the inventory, the pause menu appears and one click resumes.

**Honest self-assessment.**
- *What went well:* the phases build on each other cleanly. The Phase 3 voxel light engine is what makes caves dark, torches meaningful, and zombies spawn in the right places in Phase 5. The inventory and crafting logic was written as pure, unit-tested modules before any UI existed, so the UI stayed thin. The smoke test paid for itself repeatedly by catching real bugs in systems that looked fine in screenshots. The game now has an actual survival loop, from punching a tree to diamond tools with zombies at night, and it all stays procedural.
- *What's weaker:* I couldn't judge the "RTX look" or the smoothness on real hardware, only through software-rendered screenshots, so the graphics tuning (exposure, bloom, fog density) may need adjustment on a real GPU. Mob AI is simple. It's believable at a glance, but not clever. The mob and item art is decent programmer art; a pixel artist would do better. main.js has grown into a long wiring file that could be split (game state machine, persistence, rendering).
- *Scope decisions:* when something threatened to balloon (real pathfinding, flowing water, furnaces with timers), I chose the simpler version, and noted it above rather than leaving it half-finished.

---

# Round 3 — upgrade log

## Phase 1: Bug fixes — DONE

**1. Water glitch (screenshot 1).** *Root cause:* two different definitions of "under water". The top block of a body of water draws its surface lowered (at 0.875 of the block, minus a little more, moved by waves), but the game decided "the camera is under water" from the block grid: any eye position inside a water block's cell counted. With the eye just above the drawn surface (swimming at the surface, standing in shallows), the whole screen got the murky under-water fog. On top of that, the water shader decided *per fragment* whether it was looking at the surface from below, by which side of the face the camera was on. Near the waterline, wave crests rise above the eye, so a band of surface quads along a crest was drawn with the "underside" colour: the strip of light teal quads in the screenshot. I reproduced both in the sandbox with the eye at 0.86, 0.9 and 0.95 of the top water block. *Fix:* a new `js/water.js` holds the surface/wave formula shared with the shader and decides once per frame whether the eye is below the *drawn* surface; the water shader uses that one camera state for every face. Verified with the same renders: above the surface you now see the surface from above with no fog, and there is no band.

**2. Lighting (screenshot 2).** *Diagnosis:* the lighting function multiplied direct sunlight by the per-vertex ambient occlusion (down to 0.69 at an occluded corner) and by a factor from the voxel sky light level. AO is interpolated across each 1-block face, so a sunlit face touching the ground or another block got a large diagonal dark gradient unrelated to any shadow: lit and shaded at the same time. The sky-light factor did the same under overhangs, where the shadow map said "lit" but the voxel light said "dark". *Fix:* direct light is now decided by the shadow map wherever it covers the scene. It fades to the voxel sky light only beyond the shadow map's range, and on Low, which has no shadow maps (so distant caves stay dark). Ambient occlusion now only darkens *ambient* light, as in reality: a corner in full sun isn't darker, only a corner in the shade is. I verified this with before/after renders of the same inner-corner scene and pixel diffs, which show exactly the AO gradients disappearing from sunlit faces and sunlit ground. The dark wedge that remains near a sunlit inner corner is the neighbouring block's real shadow.

**3. Black "outlines" through water and terrain (screenshot 3).** *Diagnosis:* these are NaN/infinite pixels, not lines. With MSAA (Medium and up), a pixel on a triangle's edge can be shaded at its centre even when that point lies outside the triangle, so per-vertex values get *extrapolated*. For faces seen nearly edge-on (thin slivers, like the vertical sides of seabed steps viewed from above), the extrapolated voxel light can go below 0 or above 1. `pow(light, 1.7)` of a negative number is NaN, and the torch curve `l / (4 − 3l)` divides by zero at 4/3. The post-processing guard turned those pixels black, and because blending water over a NaN pixel is still NaN, they showed through even deep, almost opaque water. That's why they appeared exactly along the edges of steps and holes. *Fix:* the per-vertex light, AO and water depth now use `centroid` interpolation (never extrapolated outside the triangle), and the lighting function clamps its inputs as well. *Honest caveat:* the sandbox's software renderer doesn't extrapolate at MSAA edges, so I couldn't reproduce the lines themselves (a render with NaN pixels marked in magenta showed none). The evidence points to this cause: crisp black through almost opaque water, only along silhouettes of thin faces, and only with MSAA. A new test compiles the real lighting function on the GPU and checks that extrapolated inputs give finite results.

**4. Sand gravity (new `js/falling.js`).** Sand and gravel fall when nothing solid is under them. Every edit batch reports its changed cells, and a loose block that lost its support detaches *together with the whole loose column resting on it*, so a column falls as one and lands stacked. Falling blocks are entities with gravity (the real block texture, lit by the voxel light) that turn back into blocks where they land. They fall through air, water and plants, and a block that lands in a torch's cell breaks into an item (as in Minecraft). Works after explosions, mining, placing sand in mid-air, and chains. For performance, at most 64 blocks animate at a time; any further loose columns settle instantly with one batched edit (moved straight down to where they'd land). A blast in a sand bank animated 64 blocks and settled 161 more in 1.2 ms.

**5. Sound cleanup (`js/audio.js`, rewritten).** Almost every sound is now shaped noise with natural envelopes: resonant filters give it the material (a woody knock, a glassy chink), and several layered grains give texture. The only pitched sounds left are creature voices, which run a buzzy source through vowel-like formant filters with vibrato and breath instead of bare oscillator sweeps.
- **Removed:** the jump sound (as asked), and the burp after eating (odd, synthetic).
- **Redesigned:**
  - **Block sounds:** stone has a click plus a low body; wood a resonant knock (was a sine "boop"); grass, plants and sand are grain rustles; dirt a soft thud; cloth a muffled pat. Glass is now a cluster of resonant noise chinks (was sine tones).
  - **Small feedback sounds:** item pickup is a soft pop (was a sine chirp), and the UI click a quiet tick (was a harsh square wave). Crafting is two woody taps (was a triangle-wave chirp), and tool break a snap with bits (was a square-wave squeal).
  - **Hurt and death:** getting hurt is a dull body thud (was a sawtooth "grunt"), and dying a heavy thud plus a low rumble (was a 1.2 s descending sawtooth).
  - **Movement and weapons:** the flight toggle and the throw are soft air whooshes (were sine sweeps), and a weapon hit is a noise thwack (was a triangle-wave thump).
  - **Mob voices** go through formant filters: the Fluffalo grumbles, the Hoplet squeaks breathily, the Mossback clicks and hisses, and the zombie moans hollowly (all were raw sawtooth or sine sweeps).
- **Kept as they were:** footsteps (now using the new material sounds), the splash (now with droplets), the swing whoosh and the explosion.

**Testing.** New smoke checks:
- **Lighting:** the real lighting function, compiled into a tiny GPU shader, gives the same direct light for an open and a fully occluded corner (0.936 vs 0.932; the difference is a constant ambient floor), and finite values for out-of-range inputs; the terrain and water shaders use centroid light.
- **Water:** the under-water test follows the drawn surface: just above it, and anywhere in the rest of the top block, is not under water; just below it and deeper is.
- **Sand gravity:** a 6-block sand column on a pillar falls together when the pillar is removed and lands stacked, while supported sand stays put. Gravel landing on a torch breaks and leaves the torch.
- **Explosions and loose blocks:** a blast in a sand bank animates at most 64 blocks, settles the rest in one batch, and leaves nothing floating.
- **Sounds:** every sound effect and mob voice plays without errors, and the jump and burp sounds are gone.

**40 smoke checks and 24 unit tests pass with zero console errors.**

## Phase 2: Weapons, part 1 — DONE

**Blast Orb → Grenade.** The Blast Orb, its separate HUD indicator and the F key are gone. The **Grenade** is now a normal item (stack of 1 in creative, craftable from 1 iron ingot + 2 coal). With it selected, holding right-click charges the throw, and a small bar under the crosshair fills (red glow when full). A quick click lobs it about 6 blocks; a full charge (1.5 s) throws it about 25. It's a physical object: gravity, sub-stepped collision with blocks, bounces with energy loss (restitution 0.38) plus friction, and it rolls to a stop. It explodes after a 5 s fuse (it blinks red), or at once when it hits a mob directly. The blast size is unchanged (radius 7).

**Pistol** (new `js/weapons.js`, crafted from 3 iron ingots + 1 plank). Right-click fires a hitscan shot with slight spread. It hits the first solid block (bullets pass through grass, flowers and torches) or the first mob hitbox, whichever is nearer.
- **On blocks:** sparks, dust in the block's colour, a ricochet sound, and a bullet hole decal (`js/decals.js`, pooled, 96 at most). A hole disappears when its block is broken or blown up.
- **On mobs:** 5 damage and knockback, with a hit flash and blood puffs.
- **Every shot:** a muzzle flash (an additive sprite plus a short point light), a recoil kick on the camera and the gun model, and a noise-based gunshot sound.

**Bazooka** (crafted from 8 iron ingots around a grenade). Right-click fires a rocket from the tube (or from the eye when the tube is inside a wall) toward the crosshair point.
- **Flight:** 75 blocks/s, nearly flat (gravity -2.5), with a glowing exhaust (a sprite plus a moving light) and a smoke trail. It lives up to 12 s or until it leaves the loaded terrain.
- **Collision:** each step casts a ray against blocks and mob hitboxes, so it can't tunnel through thin walls or small mobs.
- **Blast:** radius 35 (5× the grenade), with a much bigger fireball, more debris, a heavy shake, a longer and deeper boom, and strong knockback. You can kill yourself with it: "Blown up by your own bazooka" (a fall right after your own blast reads "Sent flying by your own bazooka"; grenades work the same way).

**Controls.** With a grenade, pistol or bazooka selected, right-click uses the weapon instead of placing a block. There's no ammo and no reloading. Every click fires, with only a tiny minimum interval (70 ms pistol, 200 ms bazooka, 120 ms between grenade throws).

**Hitboxes and damage.** Mobs have ray and sphere hit tests (`mobs.raycast`, `mobs.sphereHit`), used by bullets, rockets and grenades. Explosions damage and fling mobs and the player by distance, scaled with the blast size. Damage and knockback are capped so a bazooka throws a mob far but not into orbit.

**Explosion falloff (all explosives, new pure `js/falloff.js`).**
- **Camera shake:** falls smoothly with distance (smoothstep to zero at `6 × radius + 20` blocks), so a grenade 40 blocks away is a light rumble and one 90 blocks away is felt only through sound.
- **Sound:** gain drops with distance, a low-pass filter closes (18 kHz up close, down to about 220 Hz far away) so distant blasts are muffled, and the sound is delayed by distance / 343 m/s (capped at 1.2 s). Bigger blasts are louder, deeper and longer.

**Performance of big blasts.** A bazooka blast can remove tens of thousands of blocks, so:
- **Carving:** reads chunk arrays directly, column by column, and applies everything with one batched `setBlocks` (one light update, one change notification).
- **Rebuilds:** chunks are no longer all rebuilt in the same frame. The 8 nearest rebuild at once, then more only while the frame's 10 ms edit budget lasts; the rest continue over the next frames, nearest first.
- **Loose blocks:** falling sand is capped at 64 animated blocks; any more settle instantly in one batch (Phase 1).
- **Measured in the sandbox's software renderer:** a surface bazooka blast removed 21,270 blocks with 68 ms of carving. A worst-case underground blast removed about 67,000 blocks in about 170 ms total (carving plus light), with the chunk rebuilds spread over several frames. That's a hitch, but no longer a freeze.

**Other fixes.**
- The held item now follows the selected slot every frame (it could get out of sync when the slot changed without a key press).
- A pending equip animation no longer restarts every frame.
- Gun models were resized and posed so they sit in the lower right like the other tools (the bazooka's rear used to clip the near plane as a black block).

**Testing.** New and rewritten smoke checks, all using real mouse input:
- **Grenade throw:** holding the button shows the charge bar; a quick click lands about 6 blocks away and a full charge about 25; grenades bounce; the fuse is 5.05 s.
- **Grenade blast:** the crater is still about 7 blocks (radius 6.7, 523 blocks).
- **Direct hit:** a grenade thrown straight at a zombie explodes 0.4 s after the throw and kills it.
- **Pistol:** 6 clicks give 6 shots and 6 bullet holes, with no reload. A zombie hit takes exactly 5 damage and is pushed back, and the holes disappear with their blocks.
- **Right-click with a weapon:** places no block.
- **Bazooka:** the rocket flies at 75 blocks/s with little drop and a smoke trail; the blast radius is 35 (21,270 blocks removed, reach 34.9); falling blocks stay within the cap.
- **Shake:** a grenade shakes the camera 0.56 at 6 blocks, 0.11 at 40, and 0 at 90 and 200.
- **Deaths:** your own grenade at your feet, and a point-blank bazooka shot, both kill you in survival with the right death message.
- **Removed:** the old Blast Orb checks. The creative check now also asserts that F does nothing and the orb UI is gone.

New unit tests check that shake and loudness fall monotonically with distance, that distant blasts are muffled and delayed, and that bigger blasts are louder.

While running these, the full suite exposed two test-order problems, which I fixed:
1. The "animals spawn at the start" check ran after weapon checks that clear mobs, so it now runs before them.
2. The sword check could be hit by the zombie between aiming and swinging. A hit knocks the player into the air, which turned the swing into a critical hit, so the check now holds off the zombie's attack and waits until the player is on the ground.

**46 smoke checks and 26 unit tests pass with zero console errors.**

## Phase 3: Render distance with level of detail — DONE

**What changed for the player.** The render distance slider now goes up to **100 chunks** (1,600 blocks), and the default is **20** (was 10, max 16). Only the area around the player is drawn in full detail. Beyond it, the land is drawn with simplified, blocky meshes that get coarser with distance, so far-away hills, beaches, lakes and forests are visible out to the horizon.

**How it works (new `js/lod.js`, `js/lod-mesher.js`, `js/lod-worker.js`).**
- **Quadtree of tiles.** The ground is divided into a quadtree of square tiles. A tile at level L covers 2^(L+1) × 2^(L+1) chunks as 32 × 32 cells of 2^L blocks. It splits into its 4 children while the player is closer than `detailDistance × 2^(L−1)` chunks (with a quarter-tile of hysteresis, so walking back and forth over a boundary doesn't flip it). So cells are 2 blocks from about the detail distance out, 4 blocks from twice that, 8 from four times, and so on: the step grows in proportion to distance.
- **Detail area.** A split level-1 tile is the "detail" area. Its chunks are generated, lit and meshed by the World exactly as before. Mobs, physics, falling blocks and explosions only exist there (and in its one-chunk margin).
- **Tile meshes.** Each cell is a column at the ground height sampled at the cell centre from the terrain generator: a flat top, plus walls down to lower neighbours, so distant land keeps the voxel look.
  - **Merging:** tops are merged into runs, and walls along the border direction.
  - **Water:** a flat surface at the drawn water level that carries its depth. The LOD shader colours it like the near water (depth colour, sandy floor, fresnel sky reflection, sun glint).
  - **Trees:** canopy boxes on levels 1–3 (they use the same tree placement rule as terrain generation, now shared through `TerrainGenerator.treeAt`, verified to generate byte-identical chunks). Farther out, trees become a tint of the grass.
  - **Skirts:** every tile border gets a deep wall, so tiles of different levels, and the detail area, never leave cracks.
- **Colours** come from each block's texture average in linear light (what a mipmapped texture shows from far away), and the tiles use the same lighting and fog code as the chunks.
- **Player edits reach distant terrain.** For chunks the player has changed, the worker generates the real chunk, applies the saved edits and uses its actual surface, and it drops trees that were cut down or blown up. A crater stays visible from afar, and tiles over an edited chunk are rebuilt when needed.
- **Web Worker.** Tile meshes are built in a module Web Worker (nearest first, a few requests in flight so a new plan can re-prioritize), and handed back as transferable typed arrays. The main thread only turns them into geometry, within 3 ms per frame. If module workers aren't available, tiles are built on the main thread within a per-frame budget instead.
- **Seamless hand-over.** The planned leaves exactly partition the ground, and a region keeps its old look until the new one is complete:
  - When a tile splits, it stays visible until all its children, or all its chunks, are ready. Around the player, a gap is preferred over coarse ground underfoot.
  - When tiles merge, the children (or chunks) stay visible, and loaded, until the parent tile is built.
  - New chunks start hidden, and the LOD system decides which ones show.
- **Memory.**
  - Tiles that are neither planned nor needed as a stand-in are disposed.
  - Chunks more than 3 chunks outside the detail area are unloaded. Chunks that were only kept as stand-ins are released as soon as they're no longer shown, not only at the next re-plan.
  - After a 1,500-block move, the test finds exactly the planned tiles and no chunk beyond the render distance.
- **Fog and far plane.** Fog ends at the render distance as before, and the camera's far plane now follows the render distance (at least 1,000).
- **Presets** now set how far full detail reaches (`detailDistance`) and suggest a render distance:

  | Preset | Full detail distance | Suggested render distance |
  |---|---|---|
  | Low | 4 chunks | 12 |
  | Medium | 6 chunks | 16 |
  | High | 8 chunks | 20 |
  | Ultra | 8 chunks | 20 |

  The detail area on Ultra (about 320 chunks) is about what Ultra drew in full before at distance 10. The render distance slider still goes to 100 on every preset.

**Measured.**
- **Build cost:** a Node benchmark builds a tile in 1–5 ms.
- **Tiles at each render distance (Ultra):**

  | Render distance | LOD tiles | Vertices | Memory | Total build time |
  |---|---|---|---|---|
  | 20 | 70 | about 290k | 6 MB | about 0.3 s |
  | 64 | 224 | 1.4M | 32 MB | — |
  | 100 | 300 | 2.4M | 52 MB | about 0.3 s |

- **In the browser, on Low:** render distance 64 streamed in within 3.8 s after its detail area was loaded. The longest main-thread LOD update (plan, uploads and visibility pass) was 2.8 ms.
- **Transition quality:** I rendered the same view at render distance 16 twice on High, once with LOD beyond 8 chunks and once with every chunk in full detail (797 chunks). The mean pixel difference is 2.1/255, mostly in the shapes of distant tree canopies. Side-by-side crops of the horizon are hard to tell apart.

**Testing.** New unit tests (lod-mesher.js, in Node):
- Tiles are well-formed, and every cell top sits at the terrain height sampled at its centre.
- Walls exactly cover every height step inside a tile (total wall area equals the sum of height differences), and skirts cover all four borders, reaching below the tile's lowest surface.
- Trees are boxes on near levels and a tint far away.
- A dug-out chunk lowers the distant surface and removes its tree, and clearing the edits restores both.

New smoke checks:
- The default render distance is 20 of a maximum of 100.
- Detail chunks and LOD tiles stream in, built in a worker, and **every chunk within the render distance is drawn exactly once** (no gaps, no overlaps).
- Flying 14 chunks while sampling coverage every couple of frames finds no overlaps and no gaps inside half the render distance at any moment (42 samples), and full coverage after settling.
- A crater dug 12 chunks away shows in the distant tile (surface y=10 instead of 25).
- Render distance 64 streams in with short main-thread updates and a far plane beyond it, and moving 1,500 blocks away releases every out-of-range tile and chunk.

The test arenas that are built at an offset from spawn now load their chunks first (`prepareArea`), because with the smaller detail area on Low they may lie outside it.

**49 smoke checks and 30 unit tests pass with zero console errors.**

## Phase 4: Graphics upgrade — DONE

**Relief textures (High and Ultra).**
- **Relief maps:** every block texture now has a matching relief map (a second texture array): a tangent-space normal, a height and a roughness per pixel. The heights come from each material's own structure where it has one: the stone's mottling, the domes of cobbles and gravel (from the same Voronoi cells that paint them), and the sand's ripples. Brightness fills in the rest, because in these pixel-art textures light pixels are the raised bits (pebbles, blades, leaf clusters) and dark ones the cracks.
- **Lighting:** the terrain shader turns the relief into per-pixel normals, with each face's tangent frame taken from the mesher's UV layout, so bumps catch and lose the sun. A GGX specular highlight follows each pixel's roughness: leaves and ore get a sheen, while dirt stays matte.
- **Parallax (Ultra):** parallax occlusion mapping (up to 28 steps, refined between the last two) gives nearby pixels real depth, fading out between 10 and 20 blocks.
- **Richer textures:** grass has clumps and shaded gaps; dirt has roots and flint chips; stone has faint strata and mica specks; sand has lit ripple crests, coarse grains and shell bits; leaves have sunlit leaflets.

**Cascaded, soft sun shadows.**
- **Cascades:**
  - Ultra: 3 shadow maps of growing size (±22, ±64 and ±180 blocks, 2048² each).
  - High: 2 maps (±28 and ±110).
  - Medium: 1 map.
  - Each map is snapped to its own texel grid. Each pixel uses the finest map that covers it and blends into the next near its edge. Beyond all of them the voxel sky light takes over, as before. The extra cascade lights give no light of their own, so three's built-in materials don't get lit three times.
- **Soft edges:** filtering is done in the shader, over a Poisson disc rotated per pixel (interleaved gradient noise), with 6, 12 or 16 taps depending on the preset. On Ultra the finest cascade uses percentage-closer soft shadows: it first searches for the occluder, then widens the filter with its distance. A post's shadow is crisp where it meets the ground and soft farther away, like a real sun.

**Water (High and Ultra).** The frame is now drawn in two passes (new `js/layers.js`):
1. **The world**, without water. Its colour and depth are resolved from the multisampled buffer (depth into a depth texture).
2. **The water**, which reads that image, followed by transparent effects (smoke, sparks, exhaust) on top. The second pass reuses the frame's shadow maps.

The water shader:
- **Refraction:** bends what's behind by the wave normals (without borrowing pixels from anything in front of the water).
- **Absorption:** uses the real thickness of water along the view ray (from the depth buffer), with red absorbed first. Shallows are clear and turquoise, over the sand and seabed caustics; depths fade to deep blue.
- **Reflections:** on Ultra, screen-space reflections march the reflected ray through the depth buffer (48 steps, 5 refinement steps, fading at the screen edges); on High, and wherever that misses, the sky is reflected.
- **Fresnel and glint:** a fresnel blend between the two, plus the sun glint.
- **Foam:** where the water gets shallow along the view ray, so it follows shores and anything standing in the water.
- **From below:** the world above shows through Snell's window, and total internal reflection shows beyond it.

Low and Medium keep the cheaper blended water.

**Vegetation (High and Ultra).**
- **3D grass:** instanced tufts of thin blades on grass blocks with air above: 1 per block within 16 blocks on High, 2 within 24 on Ultra. They are lit like the terrain (voxel light, sun shadows, light through the blades), sway in the wind, bend away from the player's feet, and shrink away toward the edge so they never pop. Each chunk's grass tops are cached until the chunk is rebuilt.
- **Fuller leaves:** each leaf block on the outside of a canopy gets two extra leaf cards at a random angle. They stay within the block's height, so flat canopy tops don't sprout fins, and poke out past its edges and corners, which breaks up the cube silhouette. They sway with the leaves, and toggling the preset rebuilds chunks gradually.

**Low stays light.** Low has no shadow maps, no post-processing, no relief sampling, the old water, no grass and no leaf cards. Its frame is the same as before, apart from the richer textures.

**Bug found by the probe.** The first High/Ultra run failed because the new water shader used `projectionMatrix` in the fragment stage, which three.js only declares for vertex shaders. The shader didn't compile, so water on those presets broke. The projection is now passed as its own uniform.

**Testing.** Two new smoke checks:
- **Presets:** each preset sets the right number of cascades, relief textures, parallax, water mode, grass level and leaf cards.
- **Ultra functional check:** a purpose-built pool with a white floor under 1 block of water on one side and 12 blocks on the other.
  - **Water:** the shallow half shows the floor through the water (luminance 229) while the deep half is dark blue (57).
  - **Rendering:** all 3 shadow cascades render, there are 2,824 grass tufts around the player, and fuller leaves add cards to a leaf chunk.
  - **Low:** switching back turns the extras off.

I also checked every feature visually in the sandbox on a relief test wall, a floating leaf slab, a pool with a sloping sandy seabed and markers, and underwater views.

**51 smoke checks and 30 unit tests pass with zero console errors.**

## Phase 5: Visual realism — DONE

The three references were the mood target: light shafts in teal water, a grassy marsh with mist over the water, and realistic trees. The world stays blocky; the atmosphere and the life on it are what changed.

**1. Under water (new `js/motes.js`, `UW_RAYS` in `js/postfx.js`).**
- **Light shafts (High/Ultra):** a volumetric pass at a third of the resolution. It marches each view ray through the water, up to the first surface in the depth buffer. At every step it traces the light back up to where it entered the surface, along the sun direction refracted into the water, and samples slowly drifting bands of focused light there. So the shafts are slanted like the sun, move like caustics, and fade with depth and distance. Their strength follows the sky light at the eye, so a sealed, flooded cave has none.
- **Colour:** the water murk is now teal. It gets brighter looking up toward the surface and glows toward the sun, where earlier it was a flat dark blue.
- **Motes (every preset):** 420 particles drift in a 14-block box that wraps around the camera in the vertex shader, so they never have to be moved on the CPU. They show only while the camera is submerged.

**2. Sunbeams through clouds and canopies.** The light-shaft pass marches toward the sun through the sky mask:
- **What blocks the sun:** the sky shader writes cloud cover into it, and terrain and leaves block it. Light pours through gaps in clouds, foliage and terrain.
- **Quality:** the march is dithered per pixel (no banding), with 72 samples on Ultra and 48 on High.
- **Dawn and dusk:** the shafts get stronger and much wider in the low, hazy light at the ends of the day.
- **Tested:** in the sandbox with a leafy wall between the camera and a low sun, with rays streaming through each gap.

**3. Mist over water.** The fog now has a thin mist layer lying on the water level:
- **Physics:** its density falls off exponentially with height, and the fog integrates it exactly along each view ray, so it looks right both from the shore and from a hilltop.
- **Movement:** smooth noise makes it drift in patches.
- **Timing and colour:** it is about 7× denser around sunrise and sunset than at noon (a little denser at night too), and warmed by the low sun.
- **Presets:** half strength on Low and 0.8 on Medium. It costs only a few shader instructions.

**4. Ground plants (rewritten `js/grass.js`).** Instanced plants on the blocks around the player (High: within 20 blocks; Ultra: within 32, denser):
- **Grass:** short tufts, and tall arching grass that yellows toward the tips (2.2 per block on Ultra).
- **Reeds:** stalks with cattails and long leaves, along shores and standing in shallow water.
- **Ferns:** where sky light is reduced under trees.
- **Flowers:** five colours, in scattered patches.

Each plant type is its own geometry with per-vertex colours. All are lit like the terrain (voxel light, shadows, light shining through), sway in the wind (tall plants more), bend away from the player's feet, and thin out and shrink toward the edge of the radius. Medium and Low have none.

**5. Trees (new `js/trees.js`).**
- **Four species:**
  - **Oak:** irregular crowns of 2–3 overlapping blobs with noisy, ragged edges and a few holes, sometimes with a branch reaching into a side blob.
  - **Birch:** tall and slender, with pale bark and narrow crowns.
  - **Pine:** tall, dark trunks with tiered, tapering rings of needles.
  - **Old oak (rare):** a 2×2 trunk, roots that run through the ground's top block, crooked branches and a huge crown.
- **Where they grow:** forests and meadows alternate following a noise field; birches and pines grow in groves, and pines take over high ground. Trees keep a minimum distance: the one with the lower placement hash wins, which is symmetric, so no generation order is needed.
- **New blocks:** birch log and leaves, pine log and needles, and oak wood (bark on every face, for branches and roots, so they don't show sawn-off rings). They have new textures, craft into planks and appear in the creative inventory. Mobs don't spawn on any kind of leaves.
- **Across chunk borders:** crowns and roots now reach up to 9 blocks from the trunk. Each chunk places every tree that reaches into it, in one fixed order, and each tree's "is my ground carved away by a cave?" check uses a new per-block cave test. That test samples the same noise lattice as chunk generation, and matched it on all 68,482 blocks I compared. So every chunk agrees on which trees exist.
- **Distant terrain:** the LOD tiles draw a crown per species (a narrow two-tier cone for pines, a wide crown for old oaks).
- **Leaves and plants:** sunlight shines through them when you look toward the sun (a new foliage flag in the mesher). They also vary in colour: from tree to tree and block to block, and across broad patches of meadow for grass tops and tall grass (a per-vertex tint).
- **Existing worlds:** tree placement and shapes changed, and cave carving matches the old generator exactly. Saved worlds keep all their edits, but trees in untouched areas regrow in the new shapes. The height map, caves and ores are unchanged.

**6. Softer haze and aerial perspective.**
- **Height:** the haze is now thickest near the ground and thins with height (integrated along the ray, scale height 40 blocks), so a view from a hilltop gets clearer.
- **Colour:** it takes the sky's colour toward the horizon, plus a forward-scattering glow around the sun.
- **Result:** distant hills fade into warm, soft light at dawn and into blue at noon, as in the references.

**Performance.**
- **Generation:** chunk generation with the new trees takes 1.0 ms per chunk in the unit test on an idle machine, and up to 2.2 ms while the browser tests run alongside (limit 3 ms; the old trees cost about 0.45 ms less). The shape cache stores 4 bytes per tree block.
- **Leaves:** leaf blocks per chunk average about the same as before (66); forests are denser, meadows sparser.
- **Plants:** the Ultra plant layers hold about 3,500–6,000 instances around the player.
- **Shafts and mist:** the underwater shafts run only while submerged (24 steps per pixel at a third of the resolution); the mist is a few shader instructions.
- **Low and Medium** get the new trees and a little mist and haze math, but no plants and no shafts.

**Process fix.** The first Phase 5 browser run failed to load the game, although `node --check` had passed:
- A GLSL comment with backticks ended its JavaScript template string early.
- A patch duplicated a function header in textures.js.

`node --check` doesn't parse these files strictly as ES modules, so both slipped through. The smoke test would have caught them, but I now also run a strict ES-module parse of every file after each change.

**Bug found by the smoke run: spawning on a tree.** The first full run failed the grenade crater check: its grenade blew away only 41 blocks. The player had started on top of a birch crown, and the grenade went off up there. The spawn column was picked from the height map alone, and the bigger crowns now often grow over it: 38 of 300 worlds I checked started the player on a tree. The spawn now moves to the nearest land column that no tree stands in (`TerrainGenerator.spawnColumn`). The check uses the tree shapes, so no chunks need to be generated. The crater check also gives itself a grenade now instead of relying on the check before it.

**Testing.**
- **New unit test (spawn):** in 120 worlds the player starts on land with nothing solid above; 12 of those spawns had to move off a tree.
- **New unit test (trees):** all four species grow (2,852 oaks, 997 birches, 1,303 pines and 81 old oaks in three 640×640 areas). Every block of every tree in a 7×7-chunk region ends up in the generated chunks (23 trees, 13 of them spanning chunk borders, 0 blocks missing).
- **Ultra plants check:** on a purpose-built marsh (grass, a beach, shallow and deeper water, a leafy roof) there are tall and short grass, reeds and ferns, and at least three tree species grow near spawn.
- **Ultra atmosphere check:**
  - Under water, the light shafts render and the motes show (and hide again above water). In a sealed, flooded stone cell there are no shafts.
  - The mist over water is more than 3× denser at dawn than at noon.
  - Facing a low sun through a gappy leaf wall draws sunbeams.

**53 smoke checks and 32 unit tests pass with zero console errors.**

## Round 3 — final summary

**What changed in this round.**

1. **Phase 1 (bug fixes):**
   - **Water surface:** the glitch at the surface is gone; the game and the shader now share one definition of "under water".
   - **Lighting:** ambient occlusion no longer darkens sunlit faces.
   - **Black edges:** the black NaN pixels along edges seen through water with MSAA are gone.
   - **Sand and gravel** now fall when nothing supports them.
   - **Sounds:** almost every sound was rebuilt from shaped noise, and the jump and burp sounds are gone.
2. **Phase 2 (weapons):**
   - **Grenade:** the Blast Orb became an item with a charged throw, bounces and a 5-second fuse.
   - **Pistol:** hitscan shots with sparks and bullet holes.
   - **Bazooka:** a rocket with five times the grenade's blast radius.
   - **Distance:** camera shake, sound and damage all fall off with distance from a blast.
3. **Phase 3 (level of detail):**
   - **Range:** render distance goes up to 100 chunks (default 20).
   - **Far terrain:** a quadtree of simplified tiles, built in a Web Worker, surrounds the full-detail area. The land is covered exactly once (no gaps, no overlaps).
   - **Edits and memory:** player edits show in the far terrain, and memory is freed behind the player.
4. **Phase 4 (graphics):**
   - **Textures:** relief textures with normal maps and specular light, plus parallax on Ultra.
   - **Shadows:** cascaded soft shadows with contact hardening.
   - **Water:** drawn over the finished world image, for refraction, absorption and reflections.
   - **Vegetation:** 3D grass and fuller leaves.
5. **Phase 5 (visual realism):**
   - **Light:** light shafts and drifting motes under water, and sunbeams through clouds and canopies.
   - **Air:** mist over water at dawn and dusk, and haze that thins with height.
   - **Plants:** grass, reeds, ferns and flowers.
   - **Trees:** four procedural species that grow across chunk borders.

The codebase grew from ~10,800 lines of JavaScript in 34 modules to ~15,200 lines in 46 modules, plus a ~560-line `index.html` and ~2,800 lines of tests. It is still plain ES modules with no build step, it still loads only three.js r160 from the pinned CDN, and it still has no asset files.

**Testing.**
- **Per phase:** every phase ended with `node --check` on the changed files (plus a strict ES-module parse since Phase 5), both test suites, and a check for zero console errors.
- **At the end:** **32 unit tests** and **53 browser smoke checks** pass with zero console errors. That is up from 24 and 35 at the end of Round 2.
- **Real bugs the browser runs caught this round:**
  - The High/Ultra water shader didn't compile (found by a test render).
  - New players started on top of trees.
  - Two syntax errors got past `node --check`.
- **Test fixes:** some checks depended on test order or timing. I fixed their causes rather than adding retries.

**Known issues and limitations.**
- **Performance on real GPUs is still unmeasured.** The sandbox renders with a software rasterizer (a few FPS), so I verified correctness and CPU-side costs, not frame rates. Ultra does a lot per frame:
  - 3 shadow maps (2048² each) with contact-hardening soft shadows;
  - 4× MSAA HDR, parallax, and a second pass for the water with screen-space reflections;
  - up to ~6,000 instanced plants and 72-sample sunbeams.

  Ultra is meant for good desktop GPUs; High, Medium and Low scale down step by step. At render distance 64 the far terrain is ~690,000 vertices, and more at 100.
- **Saved worlds from before Phase 5 grow new trees.** Tree generation changed; the height map, caves and ores didn't.
  - **Edits:** saved edits are kept, but untouched areas regrow trees in the new shapes.
  - **Gaps:** old edits apply on top of the new trees, so a tree felled in an old save can leave a gap in a new crown.
- **Some effects only use what's on screen or skip shadows:**
  - **Reflections:** on Ultra they only show what's on screen, and fall back to the sky elsewhere.
  - **Sunbeams** appear only when the sun is on or near the screen.
  - **Underwater shafts** are computed, not shadowed. They ignore shade on the water surface (from a tree overhanging a pond, say). They do follow the sky light at the eye, so a sealed, flooded cave has none.
- **Plants grow only near the player:** within 20 blocks on High and 32 on Ultra. Farther grass is the block texture. Plants don't cast shadows.
- **Distant trees are simple:** the far terrain draws each crown as one or two boxes, and farther out only as a tint of the ground.
- **Main-thread work:** chunk generation and meshing still run on the main thread (time-budgeted per frame); only the distant tiles are built in a worker.
- **Unchanged from Round 2:**
  - Water doesn't flow.
  - Mob pathfinding is steering, not search.
  - Mobs and dropped items aren't saved.
  - Pointer lock quirks remain.

**Honest self-assessment.**
- *What went well:*
  - **Root causes first:** the Phase 1 fixes started from root causes reproduced in the sandbox (the two definitions of "under water", AO applied to direct light).
  - **LOD safety:** exact tests cover the LOD system (flying across the land, every point is drawn exactly once, by a chunk or a tile). That made the hand-over logic safe to change.
  - **Trees:** trees that cross chunk borders are deterministic without any generation order, and a unit test checks that every block lands.
  - **Smoke tests:** they kept catching things screenshots would have missed.
- *What's weaker:*
  - **Tuning:** I tuned all the visuals from software-rendered screenshots. On a real GPU the balance of haze, mist, bloom and light shafts may need adjusting, and Ultra may be too heavy for mid-range hardware.
  - **Large files:** `shaders.js` (1,300 lines) and `main.js` are now large; the shaders would be easier to work on split per material.
  - **Look, not detail:** the plants and trees are procedural approximations that capture the mood of the reference pictures, not their detail.
- *Scope decisions:* I picked the cheaper version of each effect:
  - screen-space sunbeams and computed underwater shafts instead of shadow-mapped volumetric light;
  - instanced plants near the player instead of across the whole view;
  - boxes for distant tree crowns.

  Each was much cheaper and close enough for the look.

## Round 3 follow-up: a blank sky-blue screen at startup — DONE

**Report.** After Round 3, starting the game showed only a plain sky-blue page: no menu, no error.

**What that screen is.** It's the page's background colour. Every panel starts hidden until the game's script shows the start menu, so either the script never got that far (an error, or a file that failed to load), or it did but the page never got to show the result.

**What I checked.**
- **Real server, random worlds:** a fresh clone of the pushed branch, served by the same `serve` that `start.sh` and `start.bat` run, started every time in headless Chromium with no errors. That included random worlds; every earlier test had used seed 42.
- **Same code as players get:** the tests use the same three.js version as the pinned CDN copy (0.160.0). `serve` sends content-hash ETags, so browsers re-check every file and don't mix stale files with new ones.
- **A startup timeline showed the likely cause.** The game's script finished after 0.9 s, but the page couldn't show anything until the GPU had finished the first frame, and on Ultra that includes compiling every shader. That took 3.9 s here (0.7 s on Low), and the sky-blue background was all there was to see in the meantime.
- **Why it can be much worse elsewhere:** Phases 4 and 5 made the High and Ultra shaders much bigger (soft shadows over three cascades, parallax, reflections, light shafts). Compiling large shaders can be far slower on some systems, notably Windows, where browsers translate WebGL shaders for Direct3D. A first frame that takes too long can also make the graphics driver reset. Either way the result is exactly that screen, possibly for good.
- **Limits:** I couldn't reproduce the reporting machine (the sandbox only has a software renderer). So the fix addresses this most likely cause, and makes any other cause show up on the page.

**The fix.**
1. **The menu first.**
   - The page shows a **Loading…** panel from its very first paint.
   - The start menu goes up before any heavy GPU work. The shaders then compile in the background where the browser can (`KHR_parallel_shader_compile`), while the world streams in.
   - The Play button says **Preparing graphics…** until the shaders are ready, and only then is the world drawn. Switching presets works the same way.
   - On Ultra here, the menu now shows after 0.6 s instead of 4.8 s.
2. **Graphics on the start menu.** The Graphics setting is on the start menu too, and a hint suggests a lower one if preparing takes more than 12 s.
3. **Safe start.**
   - The game remembers whether the last start got as far as drawing the world. If it didn't (the tab hung, or the driver gave up), the next start lowers the preset a step and says so.
   - If the browser loses the WebGL context mid-game, the game saves, lowers the setting and asks for a reload.
   - `?graphics=low` (or `medium`, `high`, `ultra`) in the address picks a setting.
4. **Errors on the page.** Until the game has started, any failure is shown with what to try, instead of a blank page:
   - **Opened as a file:** use `start.bat` or `./start.sh`.
   - **A game file couldn't load:** offline, or the three.js CDN is blocked.
   - **Mismatched files after an update:** reload with Ctrl+Shift+R (Cmd+Shift+R on a Mac).
   - **Any other script error:** the error text is shown.
   - **WebGL didn't start:** turn on hardware acceleration, update the browser and drivers, and restart the browser after a driver crash.

**Also fixed.** `normalizePreset` accepted any name that exists on a plain object (such as `constructor`).

**Testing.** Four new smoke checks, each in a fresh browser profile:
- **Startup order:** the loading panel paints at once, and the start menu comes up before the world is drawn, with Play waiting for the shaders. `?graphics=low` starts on Low.
- **Safe start:** after a start that never showed the world, the next one starts on High with a notice.
- **Error messages:** opened as a file, a missing file, mismatched files and no WebGL each show the right message.
- **Lost context:** losing the WebGL context saves the player, lowers the setting (Medium to Low) and shows the reload panel.

**57 smoke checks and 32 unit tests pass with zero console errors.**
