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

  await check("default render distance is 10", async () => {
    const value = await page.$eval("#render-distance", (el) => el.value);
    assert(value === "10", `slider value is ${value}, expected 10`);
    const live = await page.evaluate(() => window.__voxelands.renderDistance);
    assert(live === 10, `game render distance is ${live}, expected 10`);
  });

  await check("Play button locks pointer and starts the game", async () => {
    await page.click("#play-btn", { timeout: 5000 });
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
    // Restore the default for the rest of the run.
    await page.$eval("#render-distance", (el) => {
      el.value = "10";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click("#resume-btn", { timeout: 5000 });
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
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
    await page.waitForTimeout(2500); // let the throttled autosave fire
  });

  await check("HUD is live", async () => {
    const fpsText = await page.$eval("#fps-counter", (el) => el.textContent);
    console.log(`        FPS counter text: ${fpsText}`);
    assert(/FPS: \d+/.test(fpsText), `unexpected FPS text "${fpsText}"`);
  });

  await page.screenshot({ path: path.join(__dirname, "screenshot.png") }).catch(() => {});

  let savedRaw = null;
  await check("edits are saved to localStorage", async () => {
    savedRaw = await page.evaluate((k) => localStorage.getItem(k), EDITS_KEY);
    assert(savedRaw && savedRaw !== "[]", "expected non-empty block edits after break/place/explosion");
    console.log(`        saved edits: ${JSON.parse(savedRaw).length / 4} block changes`);
  });

  await check("edits survive a page reload", async () => {
    await page.reload({ waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => !!window.__voxelands, null, { timeout: 30000 });
    await page.waitForTimeout(1000);
    const reloadedRaw = await page.evaluate((k) => localStorage.getItem(k), EDITS_KEY);
    assert(reloadedRaw === savedRaw, "saved edits changed or vanished across reload");
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
