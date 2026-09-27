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

// Builds a floating 9x9 stone platform with open air above it, well away
// from spawn, and stands the player in the middle facing -Z. Returns the
// platform's center block.
async function setupArena(page, offX = 20, offZ = 20, y = 46) {
  return page.evaluate(
    ([offX, offZ, y]) => {
      const { world, player, spawn } = window.__voxelands;
      const x0 = spawn.x + offX;
      const z0 = spawn.z + offZ;
      const edits = [];
      for (let dx = -4; dx <= 4; dx++) {
        for (let dz = -4; dz <= 4; dz++) {
          edits.push(x0 + dx, y, z0 + dz, 3);
          for (let dy = 1; dy <= 5; dy++) edits.push(x0 + dx, y + dy, z0 + dz, 0);
        }
      }
      world.setBlocks(edits);
      player.flying = false;
      player.velocity.set(0, 0, 0);
      player.knockback.set(0, 0, 0);
      player.position.set(x0 + 0.5, y + 1, z0 + 0.5);
      player.yaw = 0;
      player.pitch = 0;
      return { x: x0, y, z: z0 };
    },
    [offX, offZ, y]
  );
}

// Turns the view toward the center of block [x, y, z] and waits until the
// crosshair raycast targets it.
async function aimAt(page, block) {
  await page.evaluate(([x, y, z]) => {
    const { player } = window.__voxelands;
    const eye = player.getEyePosition();
    const dx = x + 0.5 - eye.x;
    const dy = y + 0.5 - eye.y;
    const dz = z + 0.5 - eye.z;
    player.yaw = Math.atan2(-dx, -dz);
    player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, block);
  await page
    .waitForFunction(
      ([x, y, z]) => {
        const t = window.__voxelands.interaction.target;
        return t && t.block[0] === x && t.block[1] === y && t.block[2] === z;
      },
      block,
      { timeout: 10000, polling: 30 }
    )
    .catch(() => {});
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
  // Leaving the page mid-game asks for confirmation (beforeunload); accept it.
  page.on("dialog", (dialog) => dialog.accept());

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

  await check("a new world starts in Survival with full health and an empty inventory", async () => {
    const s = await page.evaluate(() => {
      const v = window.__voxelands;
      return {
        mode: v.player.mode,
        health: v.player.health,
        empty: v.inventory.isEmpty(),
        hearts: document.querySelectorAll("#hearts canvas").length,
        heartsVisible: !document.getElementById("hearts").classList.contains("hidden"),
      };
    });
    assert(s.mode === "survival" && s.health === 20 && s.empty, `unexpected start state ${JSON.stringify(s)}`);
    assert(s.hearts === 10 && s.heartsVisible, `expected 10 visible hearts: ${JSON.stringify(s)}`);
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

  await check("creative: instant break, place from the hotbar, scroll, Blast Orb, flight toggle", async () => {
    await page.evaluate(() => window.__voxelands.setMode("creative"));
    const site = await setupArena(page, 12, 12);
    const target = [site.x, site.y + 1, site.z - 2];
    await page.evaluate(([x, y, z]) => window.__voxelands.world.setBlock(x, y, z, 1), target);
    await aimAt(page, target);
    await page.mouse.down({ button: "left" });
    await page.waitForTimeout(100);
    await page.mouse.up({ button: "left" });
    const broken = await page.evaluate(([x, y, z]) => window.__voxelands.world.getBlock(x, y, z), target);
    assert(broken === 0, `creative left click should break the block instantly (block is ${broken})`);
    // The creative hotbar starts with the building blocks; slot 3 is stone.
    await page.keyboard.press("Digit3");
    const sel = await page.evaluate(() => window.__voxelands.inventory.selectedStack);
    assert(sel && sel.id === 3, `slot 3 should hold stone: ${JSON.stringify(sel)}`);
    await aimAt(page, [site.x, site.y, site.z - 2]); // the floor where the block was
    await page.mouse.down({ button: "right" });
    await page.waitForTimeout(100);
    await page.mouse.up({ button: "right" });
    const placed = await page.evaluate(([x, y, z]) => window.__voxelands.world.getBlock(x, y, z), target);
    const count = await page.evaluate(() => window.__voxelands.inventory.selectedStack.count);
    assert(placed === 3 && count === 64, `right click should place stone without using it up (block ${placed}, count ${count})`);
    await page.mouse.wheel(0, 200);
    await page.waitForFunction(() => window.__voxelands.inventory.selected === 3, null, { timeout: 5000 });
    await page.keyboard.press("KeyF");
    await page.waitForTimeout(1500);
    // Double-tap space to toggle flight mode on, then off again. (Real key
    // presses from the test driver arrive a slow software-rendered frame
    // apart, too far apart for a double-tap, so both taps are dispatched
    // in one go.)
    const doubleTapSpace = () =>
      page.evaluate(() => {
        for (let i = 0; i < 2; i++) {
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " " }));
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " " }));
        }
      });
    await doubleTapSpace();
    await page.waitForFunction(() => window.__voxelands.player.flying, null, { timeout: 5000 });
    await doubleTapSpace();
    await page.waitForFunction(() => !window.__voxelands.player.flying, null, { timeout: 5000 });
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

  // --- Survival (Phase 4) ---
  const invState = () =>
    page.evaluate(() => {
      const v = window.__voxelands;
      return { slots: v.inventory.serialize(), selected: v.inventory.selected, health: v.player.health, state: v.gameState };
    });

  await check("survival: mining takes time by hand, drops the block, and it gets picked up", async () => {
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.setMode("survival");
      v.inventory.clear();
      v.entities.clear();
    });
    const site = await setupArena(page);
    const target = [site.x, site.y + 1, site.z - 2];
    await page.evaluate(([x, y, z]) => window.__voxelands.world.setBlock(x, y, z, 2), target); // dirt
    await aimAt(page, target);
    await page.mouse.down({ button: "left" });
    // Dirt by hand takes 0.75 s of game time: first it cracks, then it breaks.
    await page.waitForFunction(() => window.__voxelands.interaction.miningProgress > 0.1, null, { timeout: 20000, polling: 16 });
    const mid = await page.evaluate(([x, y, z]) => ({ id: window.__voxelands.world.getBlock(x, y, z), cracks: window.__voxelands.interaction.crackMesh.visible }), target);
    assert(mid.id === 2 && mid.cracks, `block should still be there, cracking, while being mined (${JSON.stringify(mid)})`);
    await page.waitForFunction(([x, y, z]) => window.__voxelands.world.getBlock(x, y, z) === 0, target, { timeout: 60000, polling: 50 });
    await page.mouse.up({ button: "left" });
    // The dropped dirt flies to the player and lands in the hotbar.
    await page.waitForFunction(() => window.__voxelands.inventory.countItem(2) === 1, null, { timeout: 60000, polling: 100 });
    const inv = await invState();
    console.log(`        dirt mined by hand and collected: slot 1 = ${JSON.stringify(inv.slots[0])}`);
    // Stone needs a pickaxe: with a wooden one it drops cobblestone and wears the tool.
    await page.evaluate(([x, y, z]) => {
      const v = window.__voxelands;
      v.world.setBlock(x, y, z, 3);
      v.inventory.slots[1] = { id: 274, count: 1, dur: 60 };
      v.inventory.selected = 1;
    }, target);
    await aimAt(page, target);
    await page.mouse.down({ button: "left" });
    await page.waitForFunction(([x, y, z]) => window.__voxelands.world.getBlock(x, y, z) === 0, target, { timeout: 90000, polling: 50 });
    await page.mouse.up({ button: "left" });
    await page.waitForFunction(() => window.__voxelands.inventory.countItem(10) === 1, null, { timeout: 60000, polling: 100 });
    const pick = await page.evaluate(() => window.__voxelands.inventory.slots[1]);
    console.log(`        stone mined with a wooden pickaxe -> cobblestone; pickaxe durability ${pick.dur}/60`);
    assert(pick.id === 274 && pick.dur === 59, `pickaxe should lose 1 durability: ${JSON.stringify(pick)}`);
  });

  await check("inventory screen: E opens it, a log crafts into planks by hand, E closes it", async () => {
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.inventory.clear();
      v.inventory.slots[0] = { id: 6, count: 2 }; // 2 logs
      v.inventory.selected = 0;
    });
    await page.keyboard.press("KeyE");
    await page.waitForFunction(() => window.__voxelands.gameState === "inventory", null, { timeout: 10000 });
    const visible = await page.$eval("#inventory-screen", (el) => !el.classList.contains("hidden"));
    assert(visible, "inventory screen should be visible");
    // Pick up the logs, put one into the 2x2 grid, the rest back.
    await page.click(".inv-hotbar .slot:nth-child(1)", { timeout: 20000 });
    await page.click(".craft-grid .slot:nth-child(1)", { button: "right", timeout: 20000 });
    await page.click(".inv-hotbar .slot:nth-child(1)", { timeout: 20000 });
    const result = await page.evaluate(() => window.__voxelands.invScreen.resultView.stack);
    assert(result && result.id === 8 && result.count === 4, `a log should craft into 4 planks: ${JSON.stringify(result)}`);
    await page.click(".result-slot", { timeout: 20000 });
    await page.click(".inv-hotbar .slot:nth-child(2)", { timeout: 20000 });
    await page.screenshot({ path: path.join(__dirname, "screenshot-inventory.png") }).catch(() => {});
    await page.keyboard.press("KeyE");
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
    const inv = await invState();
    console.log(`        after crafting: ${JSON.stringify(inv.slots.filter(Boolean))}`);
    assert(JSON.stringify(inv.slots[0]) === "[6,1]" && JSON.stringify(inv.slots[1]) === "[8,4]", `expected 1 log + 4 planks, got ${JSON.stringify(inv.slots.slice(0, 3))}`);
  });

  await check("crafting table: the recipe book fills the 3x3 grid and crafts a pickaxe", async () => {
    const site = await setupArena(page);
    const table = [site.x, site.y + 1, site.z - 2];
    await page.evaluate(([x, y, z]) => {
      const v = window.__voxelands;
      v.inventory.clear();
      v.inventory.slots[0] = { id: 8, count: 3 }; // planks
      v.inventory.slots[1] = { id: 256, count: 2 }; // sticks
      v.world.setBlock(x, y, z, 19);
    }, table);
    await aimAt(page, table);
    await page.mouse.down({ button: "right" });
    await page.waitForTimeout(50);
    await page.mouse.up({ button: "right" });
    await page.waitForFunction(() => window.__voxelands.gameState === "inventory", null, { timeout: 10000 });
    const kind = await page.evaluate(() => ({ kind: window.__voxelands.invScreen.kind, cells: window.__voxelands.invScreen.grid.length }));
    assert(kind.kind === "table" && kind.cells === 9, `right-clicking a crafting table should open a 3x3 grid: ${JSON.stringify(kind)}`);
    const craftable = await page.$$eval(".recipe.craftable", (els) => els.map((e) => e.title.split(":")[0]));
    console.log(`        craftable with 3 planks + 2 sticks: ${craftable.join(", ")}`);
    assert(craftable.includes("Wooden Pickaxe") && !craftable.includes("Crafting Table"), "the recipe book should mark what can be crafted");
    await page.click('.recipe.craftable[title^="Wooden Pickaxe"]', { timeout: 20000 });
    const result = await page.evaluate(() => window.__voxelands.invScreen.resultView.stack);
    assert(result && result.id === 274, `recipe book should set up a wooden pickaxe: ${JSON.stringify(result)}`);
    await page.click(".result-slot", { modifiers: ["Shift"], timeout: 20000 });
    await page.keyboard.press("KeyE");
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
    const count = await page.evaluate(() => ({ pick: window.__voxelands.inventory.countItem(274), planks: window.__voxelands.inventory.countItem(8), sticks: window.__voxelands.inventory.countItem(256) }));
    assert(count.pick === 1 && count.planks === 0 && count.sticks === 0, `expected a pickaxe and no leftovers: ${JSON.stringify(count)}`);
  });

  await check("survival: eating an apple heals", async () => {
    await setupArena(page);
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.inventory.clear();
      v.inventory.slots[0] = { id: 261, count: 2 };
      v.inventory.selected = 0;
      v.player.health = 10;
    });
    await page.mouse.down({ button: "right" });
    await page.waitForFunction(() => window.__voxelands.inventory.countItem(261) === 1, null, { timeout: 60000, polling: 50 });
    await page.mouse.up({ button: "right" });
    const hp = await page.evaluate(() => window.__voxelands.player.health);
    assert(hp >= 14, `an apple should heal 2 hearts (health ${hp})`);
  });

  await check("survival: falls hurt, a long fall kills, the NOOB! death screen shows the cause, Respawn works", async () => {
    const site = await setupArena(page);
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.player.health = 20;
      v.player.position.y += 5.5; // a 5.5-block drop: 2 half-hearts of damage
    });
    await page.waitForFunction(() => window.__voxelands.player.onGround && window.__voxelands.player.health < 20, null, { timeout: 30000, polling: 30 });
    const small = await page.evaluate(() => window.__voxelands.player.health);
    assert(small === 18, `a 5.5-block fall should cost 1 heart (health ${small})`);
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.inventory.clear();
      v.inventory.slots[0] = { id: 10, count: 5 };
      v.entities.clear();
      v.player.position.y += 30;
    });
    await page.waitForFunction(() => window.__voxelands.gameState === "dead", null, { timeout: 30000, polling: 30 });
    await page.waitForTimeout(1000);
    const dead = await page.evaluate(() => ({
      visible: !document.getElementById("death-screen").classList.contains("hidden"),
      title: document.querySelector("#death-screen .noob").textContent,
      cause: document.getElementById("death-cause").textContent,
      dropped: window.__voxelands.entities.items.length,
      empty: window.__voxelands.inventory.isEmpty(),
    }));
    await page.screenshot({ path: path.join(__dirname, "screenshot-death.png") }).catch(() => {});
    console.log(`        death screen: "${dead.title}" / "${dead.cause}"; ${dead.dropped} item stack(s) dropped`);
    assert(dead.visible && dead.title === "NOOB!" && dead.cause === "Fell from a high place", `unexpected death screen ${JSON.stringify(dead)}`);
    assert(dead.dropped >= 1 && dead.empty, "the inventory should spill out on death");
    await page.waitForFunction(() => !document.getElementById("respawn-btn").disabled, null, { timeout: 10000 });
    await page.click("#respawn-btn", { timeout: 20000 });
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
    const after = await page.evaluate(() => {
      const { player, spawn } = window.__voxelands;
      return { hp: player.health, dx: player.position.x - (spawn.x + 0.5), dz: player.position.z - (spawn.z + 0.5), hidden: document.getElementById("death-screen").classList.contains("hidden") };
    });
    assert(after.hp === 20 && Math.hypot(after.dx, after.dz) < 0.01 && after.hidden, `respawn should restore full health at spawn: ${JSON.stringify(after)}`);
    void site;
  });

  await check("survival: your own Blast Orb at your feet is deadly", async () => {
    await setupArena(page, 20, -20);
    await page.evaluate(() => {
      const { player } = window.__voxelands;
      player.pitch = -1.5;
    });
    await page.waitForFunction(() => window.__voxelands.effects.canThrow(), null, { timeout: 20000 });
    await page.keyboard.press("KeyF");
    await page.waitForFunction(() => window.__voxelands.gameState === "dead", null, { timeout: 30000, polling: 30 });
    const cause = await page.$eval("#death-cause", (el) => el.textContent);
    console.log(`        death cause: "${cause}"`);
    assert(cause === "Blown up by your own Blast Orb", `unexpected cause "${cause}"`);
    await page.waitForFunction(() => !document.getElementById("respawn-btn").disabled, null, { timeout: 10000 });
    await page.click("#respawn-btn", { timeout: 20000 });
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
  });

  await check("drowning: breath runs out under water, then health drops", async () => {
    const site = await setupArena(page, -20, 20);
    await page.evaluate(({ x, y, z }) => {
      const { world, player } = window.__voxelands;
      const edits = [];
      for (let dy = 1; dy <= 3; dy++) edits.push(x, y + dy, z, 5);
      world.setBlocks(edits);
      player.air = 0.3;
    }, site);
    await page.waitForFunction(() => window.__voxelands.player.health < 20, null, { timeout: 30000, polling: 30 });
    const s = await page.evaluate(() => ({ air: window.__voxelands.player.air, bubbles: !document.getElementById("bubbles").classList.contains("hidden") }));
    assert(s.air === 0 && s.bubbles, `expected empty breath and visible bubbles: ${JSON.stringify(s)}`);
    await page.evaluate(({ x, y, z }) => {
      const { world, player } = window.__voxelands;
      world.setBlocks([x, y + 1, z, 0, x, y + 2, z, 0, x, y + 3, z, 0]);
      player.health = 20;
    }, site);
  });

  await check("creative players take no damage", async () => {
    await page.evaluate(() => window.__voxelands.setMode("creative"));
    await setupArena(page);
    await page.evaluate(() => {
      window.__voxelands.player.position.y += 30;
    });
    await page.waitForFunction(() => window.__voxelands.player.onGround, null, { timeout: 30000, polling: 30 });
    const s = await page.evaluate(() => ({ hp: window.__voxelands.player.health, state: window.__voxelands.gameState, hearts: document.getElementById("hearts").classList.contains("hidden") }));
    assert(s.hp === 20 && s.state === "playing" && s.hearts, `creative fall: ${JSON.stringify(s)}`);
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.setMode("survival");
      v.inventory.clear();
      v.inventory.slots[4] = { id: 276, count: 1, dur: 100 };
      v.inventory.slots[7] = { id: 4, count: 33 };
      v.inventory.selected = 4;
    });
  });

  await check("HUD is live", async () => {
    const fpsText = await page.$eval("#fps-counter", (el) => el.textContent);
    console.log(`        FPS counter text: ${fpsText}`);
    assert(/FPS: \d+/.test(fpsText), `unexpected FPS text "${fpsText}"`);
    const hud = await page.evaluate(() => ({
      counts: [...document.querySelectorAll("#hotbar .slot-count")].map((e) => e.textContent).join(","),
      selected: [...document.querySelectorAll("#hotbar .hotbar-slot")].findIndex((e) => e.classList.contains("selected")),
      durability: [...document.querySelectorAll("#hotbar .slot-dur")].filter((e) => !e.classList.contains("hidden")).length,
    }));
    assert(hud.counts.includes("33") && hud.selected === 4 && hud.durability === 1, `hotbar should show the inventory: ${JSON.stringify(hud)}`);
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

  let savedPlayer = null;
  await check("edits survive a page reload", async () => {
    savedPlayer = await page.evaluate(() => {
      const v = window.__voxelands;
      v.flushSave();
      return { mode: v.player.mode, inv: JSON.stringify(v.inventory.serialize()), selected: v.inventory.selected, x: v.player.position.x, z: v.player.position.z };
    });
    await page.reload({ waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => !!window.__voxelands, null, { timeout: 30000 });
    await page.waitForTimeout(1000);
    const reloadedRaw = await page.evaluate((k) => localStorage.getItem(k), EDITS_KEY);
    assert(reloadedRaw === savedRaw, "saved edits changed or vanished across reload");
    const reloadedCount = await countEdits();
    assert(reloadedCount === editCount, `reloaded ${reloadedCount} edits, expected ${editCount}`);
  });

  await check("game mode, inventory and position survive a page reload", async () => {
    const now = await page.evaluate(() => {
      const v = window.__voxelands;
      return { mode: v.player.mode, inv: JSON.stringify(v.inventory.serialize()), selected: v.inventory.selected, x: v.player.position.x, z: v.player.position.z, menuMode: document.getElementById("mode-select").value };
    });
    assert(now.mode === savedPlayer.mode && now.menuMode === savedPlayer.mode, `mode ${now.mode}/${now.menuMode}, expected ${savedPlayer.mode}`);
    assert(now.inv === savedPlayer.inv && now.selected === savedPlayer.selected, `inventory changed across reload: ${now.inv} vs ${savedPlayer.inv}`);
    assert(Math.hypot(now.x - savedPlayer.x, now.z - savedPlayer.z) < 0.01, "position not restored");
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
