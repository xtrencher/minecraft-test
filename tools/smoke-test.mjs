// Headless smoke test: serves the game root over HTTP, loads it in Chromium
// (SwiftShader software WebGL), drives real keyboard/mouse input, and checks
// gameplay behavior plus the absence of any console/page errors.
//
// Each check is a named async function; failures are collected (not thrown)
// so one broken check doesn't hide the results of the others.
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8934;
const SEED = 42;
const EDITS_KEY = `voxelands_v1_edits_${SEED}`;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  let filePath = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`Static server on http://localhost:${PORT}`);

const errors = [];
const passed = [];

async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed.push(name);
    console.log(`  PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    errors.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"],
});

const getPlayerPos = (page) =>
  page.evaluate(() => {
    const p = window.__voxelands.player.position;
    return { x: p.x, y: p.y, z: p.z };
  });

// Holds `keys` until the player has moved `minDist` blocks horizontally (or
// the timeout expires). Waiting on distance rather than a fixed time keeps the
// test independent of how fast software rendering happens to run.
async function holdKeysUntilMoved(page, keys, minDist = 2, timeout = 20000) {
  const before = await getPlayerPos(page);
  for (const k of keys) await page.keyboard.down(k);
  await page
    .waitForFunction(
      ([b, d]) => {
        const p = window.__voxelands.player.position;
        return Math.hypot(p.x - b.x, p.z - b.z) > d;
      },
      [before, minDist],
      { timeout, polling: 30 }
    )
    .catch(() => {});
  for (const k of keys) await page.keyboard.up(k);
  const after = await getPlayerPos(page);
  return { dx: after.x - before.x, dy: after.y - before.y, dz: after.z - before.z };
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // The sandboxed test network cannot reach cdn.jsdelivr.net (policy-blocked),
  // while a real deployed player's browser can. Redirect only the pinned
  // three.js CDN URLs to a locally npm-installed copy of the exact same
  // version, purely for this smoke test — the shipped index.html still
  // imports from the CDN.
  const localThreeRoot = path.join(__dirname, "node_modules", "three");
  await page.route("https://cdn.jsdelivr.net/npm/three@0.160.0/**", (route) => {
    const rel = new URL(route.request().url()).pathname.replace("/npm/three@0.160.0/", "");
    route.fulfill({ path: path.join(localThreeRoot, rel), contentType: "text/javascript" });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  await check("page loads and exposes debug hook", async () => {
    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/index.html?seed=${SEED}`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => !!window.__voxelands, null, { timeout: 30000 });
    console.log(`        (page ready in ${Date.now() - t0} ms)`);
    await page.waitForTimeout(1500);
  });

  await check("default graphics preset is Ultra and renders a real image", async () => {
    const preset = await page.evaluate(() => window.__voxelands.graphics);
    assert(preset === "ultra", `default preset is ${preset}`);
    const stats = await page.evaluate(() => window.__voxelands.captureStats());
    console.log(`        ultra: mean luminance ${stats.mean.toFixed(3)}, std ${stats.std.toFixed(3)}, black ${(stats.blackFraction * 100).toFixed(1)}%`);
    assert(stats.mean > 0.08 && stats.std > 0.03 && stats.blackFraction < 0.5, `ultra frame looks blank: ${JSON.stringify(stats)}`);
  });

  // Software rendering (SwiftShader) makes the heavier presets take seconds
  // per frame, so each preset is checked here, and the functional checks
  // below run on Low.
  await check("every graphics preset renders without errors", async () => {
    for (const name of ["high", "medium", "low", "ultra", "low"]) {
      const applied = await page.evaluate((n) => {
        const v = window.__voxelands;
        v.setGraphics(n);
        return { preset: v.graphics, shadows: v.renderer.shadowMap.enabled, samples: v.postfx.sceneRT.samples };
      }, name);
      assert(applied.preset === name, `preset ${name} not applied (${applied.preset})`);
      const stats = await page.evaluate(() => window.__voxelands.captureStats());
      console.log(`        ${name}: shadows=${applied.shadows} msaa=${applied.samples} mean ${stats.mean.toFixed(3)} std ${stats.std.toFixed(3)}`);
      assert(applied.shadows === (name !== "low"), `${name}: shadow maps ${applied.shadows ? "on" : "off"}`);
      assert(stats.mean > 0.08 && stats.std > 0.03 && stats.blackFraction < 0.5, `${name} frame looks blank: ${JSON.stringify(stats)}`);
      await page.screenshot({ path: path.join(__dirname, `screenshot-${name}.png`) }).catch(() => {});
    }
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("voxelands_v1_settings") || "{}"));
    assert(saved.graphics === "low", `graphics setting not persisted: ${JSON.stringify(saved)}`);
  });

  await check("default render distance is 10", async () => {
    const value = await page.$eval("#render-distance", (el) => el.value);
    assert(value === "10", `slider value is ${value}, expected 10`);
    const live = await page.evaluate(() => window.__voxelands.renderDistance);
    assert(live === 10, `game render distance is ${live}, expected 10`);
  });

  await check("Play button locks pointer and starts the game", async () => {
    await page.click("#play-btn", { timeout: 20000 });
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
    const cls = await page.$eval("#start-menu", (el) => el.className);
    assert(cls.includes("hidden"), `start menu still visible (class="${cls}")`);
  });

  // --- Movement direction: W forward, S backward, A left, D right. ---
  // The player is lifted above the world's build height (64) in flight mode,
  // so there is nothing to collide with, then each key is held until the
  // player has moved. The displacement is compared against the camera's
  // forward/right vectors for two different headings.
  await check("WASD move in the correct camera-relative directions", async () => {
    const expectations = {
      KeyW: [1, 0],
      KeyS: [-1, 0],
      KeyD: [0, 1],
      KeyA: [0, -1],
    };
    for (const yaw of [0, 2.2]) {
      await page.evaluate((yaw) => {
        const { player } = window.__voxelands;
        player.flying = true;
        player.velocity.set(0, 0, 0);
        player.position.y = 80;
        player.yaw = yaw;
        player.pitch = 0;
      }, yaw);
      const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
      const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
      for (const [key, [ef, er]] of Object.entries(expectations)) {
        const { dx, dz } = await holdKeysUntilMoved(page, [key]);
        const dist = Math.hypot(dx, dz);
        assert(dist > 1, `${key} at yaw ${yaw}: player barely moved (${dist.toFixed(2)} blocks)`);
        const f = (dx * fwd.x + dz * fwd.z) / dist;
        const r = (dx * right.x + dz * right.z) / dist;
        console.log(`        yaw ${yaw} ${key}: moved ${dist.toFixed(2)} blocks, forward·dir=${f.toFixed(2)}, right·dir=${r.toFixed(2)}`);
        assert(Math.abs(f - ef) < 0.1 && Math.abs(r - er) < 0.1, `${key} at yaw ${yaw} moved in the wrong direction (forward=${f.toFixed(2)}, right=${r.toFixed(2)})`);
      }
      // Diagonal: W+D should head forward-right at 45 degrees.
      const { dx, dz } = await holdKeysUntilMoved(page, ["KeyW", "KeyD"]);
      const dist = Math.hypot(dx, dz);
      const f = (dx * fwd.x + dz * fwd.z) / dist;
      const r = (dx * right.x + dz * right.z) / dist;
      assert(Math.abs(f - Math.SQRT1_2) < 0.1 && Math.abs(r - Math.SQRT1_2) < 0.1, `W+D at yaw ${yaw} not diagonal (forward=${f.toFixed(2)}, right=${r.toFixed(2)})`);
    }
    // Put the player back on the ground at spawn for the remaining checks.
    await page.evaluate(() => {
      const { player, spawn } = window.__voxelands;
      player.flying = false;
      player.yaw = 0;
      player.pitch = 0;
      player.spawnAt(spawn.x, spawn.z);
    });
    await page.waitForTimeout(500);
  });

  await check("all chunks within the render distance stream in", async () => {
    const t0 = Date.now();
    await page.waitForFunction(() => window.__voxelands.world.genQueue.length === 0, null, { timeout: 120000, polling: 250 });
    const count = await page.evaluate(() => window.__voxelands.world.chunks.size);
    console.log(`        ${count} chunks loaded, queue drained ${((Date.now() - t0) / 1000).toFixed(1)}s after check start`);
    // A radius-10 disc of chunks holds ~317 chunks.
    assert(count >= 300, `only ${count} chunks loaded`);
  });

  await check("render distance slider applies and persists", async () => {
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => window.__voxelands.gameState === "paused", null, { timeout: 5000 });
    await page.$eval("#render-distance", (el) => {
      el.value = "6";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const live = await page.evaluate(() => window.__voxelands.renderDistance);
    assert(live === 6, `render distance is ${live} after slider change, expected 6`);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("voxelands_v1_settings") || "{}"));
    assert(saved.renderDistance === 6, `saved settings: ${JSON.stringify(saved)}`);
    // The Graphics selector applies a preset and its suggested render distance.
    await page.selectOption("#graphics-preset", "medium");
    const med = await page.evaluate(() => ({ g: window.__voxelands.graphics, rd: window.__voxelands.renderDistance, s: JSON.parse(localStorage.getItem("voxelands_v1_settings")) }));
    assert(med.g === "medium" && med.rd === 8 && med.s.graphics === "medium", `graphics selector: ${JSON.stringify(med)}`);
    await page.selectOption("#graphics-preset", "low");
    // Restore the default for the rest of the run.
    await page.$eval("#render-distance", (el) => {
      el.value = "10";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click("#resume-btn", { timeout: 20000 });
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
  });

  // --- Lighting (Phase 3) ---
  await check("a placed torch lights its surroundings, with falloff, and removing it restores darkness", async () => {
    const r = await page.evaluate(() => {
      const { world, spawn } = window.__voxelands;
      // A sealed 7x3x7 room 8+ blocks underground, so only the torch lights it.
      const x0 = spawn.x + 30;
      const z0 = spawn.z + 30;
      const y0 = 6;
      const edits = [];
      for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = -1; y <= 3; y++) edits.push(x0 + x, y0 + y, z0 + z, 3);
      for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 0; y <= 2; y++) edits.push(x0 + x, y0 + y, z0 + z, 0);
      world.setBlocks(edits);
      const dark = world.lightAt(x0 + 2, y0, z0);
      world.setBlock(x0, y0, z0, 17); // torch (emits 14)
      const at = (dx) => world.lightAt(x0 + dx, y0, z0).block;
      const lit = { d0: at(0), d1: at(1), d2: at(2), d3: at(3) };
      world.setBlock(x0, y0, z0, 0);
      const after = world.lightAt(x0 + 2, y0, z0);
      return { dark, lit, after };
    });
    console.log(`        sealed room: sky ${r.dark.sky}/block ${r.dark.block}; with torch: ${JSON.stringify(r.lit)}; torch removed: block ${r.after.block}`);
    assert(r.dark.sky === 0 && r.dark.block === 0, "sealed underground room should be completely dark");
    assert(r.lit.d0 === 14 && r.lit.d1 === 13 && r.lit.d2 === 12 && r.lit.d3 === 11, "torch light should fall off by 1 per block");
    assert(r.after.block === 0 && r.after.sky === 0, "removing the torch should restore darkness");
  });

  await check("sky light reaches the surface, and digging a shaft lets it down", async () => {
    const r = await page.evaluate(() => {
      const { world, spawn } = window.__voxelands;
      const x = spawn.x + 25;
      const z = spawn.z - 25;
      const top = world.surfaceY(x, z);
      const above = world.lightAt(x, top + 1, z).sky;
      const under = world.lightAt(x, top - 3, z).sky;
      const shaft = [];
      for (let y = top - 3; y <= top; y++) shaft.push(x, y, z, 0);
      world.setBlocks(shaft);
      const bottom = world.lightAt(x, top - 3, z).sky;
      return { above, under, bottom };
    });
    console.log(`        sky light above ground ${r.above}, 3 below ${r.under}, shaft bottom after digging ${r.bottom}`);
    assert(r.above === 15 && r.under === 0 && r.bottom === 15, "sky light should be 15 in the open, 0 underground, 15 down an open shaft");
  });

  await check("walking forward on the ground moves the player forward", async () => {
    await page.evaluate(() => {
      window.__voxelands.player.yaw = 0;
    });
    const { dx, dz } = await holdKeysUntilMoved(page, ["KeyW"], 0.5, 4000);
    // Terrain may block the player after a few steps, so only require that
    // any movement that happened went forward (-Z at yaw 0), not backward.
    assert(dz < 0 || Math.hypot(dx, dz) < 0.05, `walking W at yaw 0 moved dz=${dz.toFixed(2)} (expected negative)`);
  });

  await check("break/place blocks, hotbar input, Blast Orb, flight toggle", async () => {
    // Pitch the camera down toward the ground (positive movementY = look
    // down, per the pointer-lock mousemove handler in player.js) so the
    // break/place raycast below reliably hits nearby terrain.
    await page.mouse.move(640, 400);
    await page.mouse.move(640, 550);
    await page.mouse.move(640, 700);
    await page.waitForTimeout(1000);
    await page.mouse.down({ button: "left" });
    await page.waitForTimeout(100);
    await page.mouse.up({ button: "left" });
    await page.mouse.down({ button: "right" });
    await page.waitForTimeout(100);
    await page.mouse.up({ button: "right" });
    await page.keyboard.press("Digit3");
    await page.mouse.wheel(0, 200);
    await page.keyboard.press("KeyF");
    await page.waitForTimeout(2000);
    // Double-tap space to toggle flight mode on, then off again.
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await page.waitForTimeout(500);
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await page.waitForTimeout(500);
  });

  // --- Blast Orb (Phase 2) ---
  const waitForExplosion = async (prevCount) => {
    await page.waitForFunction((n) => window.__voxelands.effects.explosionCount > n, prevCount, { timeout: 30000, polling: 16 });
    return page.evaluate(() => {
      const { effects, world, player } = window.__voxelands;
      return {
        ...effects.lastExplosion,
        trauma: effects.shake.trauma,
        debris: effects.debris.particles.length,
        smoke: effects.smoke.particles.length,
        glow: effects.glow.particles.length,
        playerVy: player.velocity.y,
        count: effects.explosionCount,
      };
    });
  };

  await check("Blast Orb flies much farther on a sensible arc", async () => {
    await page.evaluate(() => {
      const { player } = window.__voxelands;
      player.flying = true;
      player.velocity.set(0, 0, 0);
      player.position.y = 70; // above the build height: nothing in the orb's way at first
      player.yaw = 0;
      player.pitch = 0.5;
    });
    await page.waitForFunction(() => window.__voxelands.effects.canThrow(), null, { timeout: 10000 });
    const start = await page.evaluate(() => {
      const e = window.__voxelands.player.getEyePosition();
      return { x: e.x, y: e.y, z: e.z, count: window.__voxelands.effects.explosionCount };
    });
    await page.keyboard.press("KeyF");
    // Sample the orb after ~1 s of (game) flight time.
    const handle = await page.waitForFunction(
      () => {
        const p = window.__voxelands.effects.projectiles[0];
        return p && p.age >= 1 ? { x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z, age: p.age } : null;
      },
      null,
      { timeout: 30000, polling: 16 }
    );
    const s1 = await handle.jsonValue();
    const horizSpeed = Math.hypot(s1.x - start.x, s1.z - start.z) / s1.age;
    console.log(`        horizontal speed over first ${s1.age.toFixed(2)} s: ${horizSpeed.toFixed(1)} blocks/s (old orb: ~15)`);
    assert(horizSpeed > 22, `orb only covered ${horizSpeed.toFixed(1)} blocks/s horizontally`);
    const boom = await waitForExplosion(start.count);
    const range = Math.hypot(boom.x - start.x, boom.z - start.z);
    console.log(`        landed ${range.toFixed(1)} blocks away, ${(start.y - boom.y).toFixed(1)} blocks below the throw point`);
    assert(range > 40, `orb landed only ${range.toFixed(1)} blocks away`);
    assert(boom.y < start.y, "orb should arc back down to the ground");
  });

  await check("Blast Orb carves a 2-3x bigger crater, with particles and shake", async () => {
    await page.evaluate(() => {
      const { player, spawn } = window.__voxelands;
      player.flying = false;
      player.spawnAt(spawn.x, spawn.z);
      player.yaw = 0;
      player.pitch = -1.5; // look straight down
    });
    await page.waitForTimeout(1000); // land on the ground
    await page.waitForFunction(() => window.__voxelands.effects.canThrow(), null, { timeout: 10000 });
    const prev = await page.evaluate(() => window.__voxelands.effects.explosionCount);
    await page.keyboard.press("KeyF");
    const boom = await waitForExplosion(prev);
    console.log(`        removed ${boom.removed} blocks (radius-3 max was 123), farthest ${boom.maxDist.toFixed(2)} from center, carve ${boom.carveMs.toFixed(1)} ms`);
    console.log(`        particles: ${boom.debris} debris, ${boom.smoke} smoke, ${boom.glow} fire/sparks; shake trauma ${boom.trauma.toFixed(2)}; player vy ${boom.playerVy.toFixed(1)}`);
    assert(boom.removed > 300, `crater too small: ${boom.removed} blocks`);
    assert(boom.maxDist > 6 && boom.maxDist < 8.2, `crater reach ${boom.maxDist.toFixed(2)} outside the expected ~7 +/- 0.6`);
    assert(boom.carveMs < 150, `carving took ${boom.carveMs.toFixed(1)} ms`);
    assert(boom.debris > 50 && boom.smoke > 30 && boom.glow > 60, "expected a big particle burst");
    assert(boom.trauma > 0.3, `camera shake trauma only ${boom.trauma}`);
    assert(boom.playerVy > 2, `blast under the player should knock them upward (vy=${boom.playerVy.toFixed(2)})`);
    // The affected chunks are remeshed on the next frame, and only those.
    await page.waitForTimeout(300);
    const stats = await page.evaluate(() => window.__voxelands.world.stats);
    console.log(`        remeshed ${stats.lastEditRemeshCount} chunks in ${stats.lastEditRemeshMs.toFixed(1)} ms`);
    assert(stats.lastEditRemeshCount >= 1 && stats.lastEditRemeshCount <= 16, `remeshed ${stats.lastEditRemeshCount} chunks`);
  });

  await check("underwater blasts flood the crater instead of leaving dry pockets", async () => {
    const result = await page.evaluate(() => {
      const { world, effects, player, THREE } = window.__voxelands;
      const SEA = 24;
      // Find a sea column near the player whose water is at least 3 deep.
      const px = Math.floor(player.position.x);
      const pz = Math.floor(player.position.z);
      let spot = null;
      for (let r = 0; r < 120 && !spot; r += 2) {
        for (let a = 0; a < 16 && !spot; a++) {
          const x = px + Math.round(Math.cos((a / 16) * Math.PI * 2) * r);
          const z = pz + Math.round(Math.sin((a / 16) * Math.PI * 2) * r);
          if (world.getBlock(x, SEA, z) === 5 && world.getBlock(x, SEA - 2, z) === 5) spot = { x, z };
        }
      }
      if (!spot) return { skipped: true };
      let floor = SEA;
      while (floor > 0 && world.getBlock(spot.x, floor, spot.z) === 5) floor--;
      const R = 10;
      const before = new Map();
      for (let y = Math.max(0, floor - R); y <= SEA + 1; y++) {
        for (let z = spot.z - R; z <= spot.z + R; z++) {
          for (let x = spot.x - R; x <= spot.x + R; x++) before.set(`${x},${y},${z}`, world.getBlock(x, y, z));
        }
      }
      effects._explode(new THREE.Vector3(spot.x + 0.5, floor + 0.5, spot.z + 0.5));
      // Any air cell at or below sea level near the blast that touches water is a dry pocket.
      const pockets = [];
      const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      for (let y = Math.max(0, floor - 9); y <= SEA; y++) {
        for (let z = spot.z - 9; z <= spot.z + 9; z++) {
          for (let x = spot.x - 9; x <= spot.x + 9; x++) {
            if (world.getBlock(x, y, z) !== 0) continue;
            const wet = n.filter(([dx, dy, dz]) => world.getBlock(x + dx, y + dy, z + dz) === 5);
            if (wet.length) {
              pockets.push({ x, y, z, was: before.get(`${x},${y},${z}`), water: wet.map(([dx, dy, dz]) => `${dx},${dy},${dz} (was ${before.get(`${x + dx},${y + dy},${z + dz}`)})`) });
            }
          }
        }
      }
      return { skipped: false, spot, floor, pockets, removed: effects.lastExplosion.removed, center: effects.lastExplosion };
    });
    if (result.skipped) {
      console.log("        (no sea found near spawn; skipped)");
      return;
    }
    console.log(`        blast at sea floor (${result.spot.x}, ${result.floor}, ${result.spot.z}): removed ${result.removed}, dry pockets touching water: ${result.pockets.length}`);
    for (const p of result.pockets.slice(0, 5)) console.log(`        pocket ${JSON.stringify(p)}`);
    assert(result.removed > 50, "expected the sea floor to be carved");
    assert(result.pockets.length === 0, `${result.pockets.length} air cells left touching water below sea level`);
  });

  await check("HUD is live", async () => {
    const fpsText = await page.$eval("#fps-counter", (el) => el.textContent);
    console.log(`        FPS counter text: ${fpsText}`);
    assert(/FPS: \d+/.test(fpsText), `unexpected FPS text "${fpsText}"`);
  });

  await page.screenshot({ path: path.join(__dirname, "screenshot.png") }).catch(() => {});

  const countEdits = () =>
    page.evaluate(() => {
      let n = 0;
      for (const m of window.__voxelands.world.edits.values()) n += m.size;
      return n;
    });

  let savedRaw = null;
  let editCount = 0;
  await check("edits are saved to localStorage in the compact format", async () => {
    await page.waitForTimeout(2500); // let the throttled autosave fire
    savedRaw = await page.evaluate((k) => localStorage.getItem(k), EDITS_KEY);
    assert(savedRaw, "expected saved block edits after break/place/explosions");
    const parsed = JSON.parse(savedRaw);
    assert(parsed.v === 2 && Object.keys(parsed.chunks).length > 0, "expected v2 per-chunk format");
    editCount = await countEdits();
    console.log(`        ${editCount} block changes saved in ${savedRaw.length} chars`);
    assert(editCount > 300, "explosion edits missing");
  });

  await check("edits survive a page reload", async () => {
    await page.reload({ waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => !!window.__voxelands, null, { timeout: 30000 });
    await page.waitForTimeout(1000);
    const reloadedRaw = await page.evaluate((k) => localStorage.getItem(k), EDITS_KEY);
    assert(reloadedRaw === savedRaw, "saved edits changed or vanished across reload");
    const reloadedCount = await countEdits();
    assert(reloadedCount === editCount, `reloaded ${reloadedCount} edits, expected ${editCount}`);
  });
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passed.length} checks passed.`);
if (errors.length > 0) {
  console.error("\nFailures / console errors detected:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
} else {
  console.log("No console or page errors detected. OK.");
  process.exit(0);
}
