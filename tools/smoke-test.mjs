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
  // Any Chromium build works; set CHROMIUM_PATH to use your own.
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
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
      world.prepareArea(x0, z0, 1); // edits need loaded chunks (it may be outside the detailed area)
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

  await check("default render distance is 20 chunks, up to 100", async () => {
    const slider = await page.$eval("#render-distance", (el) => ({ value: el.value, max: el.max }));
    assert(slider.value === "20" && slider.max === "100", `slider ${JSON.stringify(slider)}, expected 20 of max 100`);
    const live = await page.evaluate(() => window.__voxelands.renderDistance);
    assert(live === 20, `game render distance is ${live}, expected 20`);
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

  await check("animals spawn around the player at the start", async () => {
    const s = await page.evaluate(() => {
      const { mobs } = window.__voxelands;
      return { passive: mobs.countOf(false), kinds: [...new Set(mobs.mobs.map((m) => m.kind))] };
    });
    console.log(`        ${s.passive} animals around the player: ${s.kinds.join(", ")}`);
    assert(s.passive >= 3, `expected a few animals near spawn, found ${s.passive}`);
  });

  // Every chunk within the render distance is drawn exactly once: either as
  // a detailed chunk or inside one LOD tile. `inner`: gaps within half the
  // render distance (the rim may briefly lag behind while new tiles build).
  const lodCoverage = () =>
    page.evaluate(() => {
      const { world, lod, player } = window.__voxelands;
      const rd = lod.renderDistance;
      const pcx = Math.floor(player.position.x / 16);
      const pcz = Math.floor(player.position.z / 16);
      const tiles = [...lod.tiles.values()].filter((t) => t.mesh && t.mesh.visible).map((t) => [t.x0 / 16, t.z0 / 16, (32 << t.level) / 16]);
      const r = { gaps: 0, inner: 0, overlaps: 0, checked: 0, chunks: 0, tiles: tiles.length };
      for (let dz = -rd; dz <= rd; dz++) {
        for (let dx = -rd; dx <= rd; dx++) {
          if (dx * dx + dz * dz > (rd - 1) * (rd - 1)) continue;
          const cx = pcx + dx;
          const cz = pcz + dz;
          let n = 0;
          const chunk = world.getChunk(cx, cz);
          if (chunk && chunk.meshed && chunk.group.visible) {
            n++;
            r.chunks++;
          }
          for (const [x0, z0, c] of tiles) if (cx >= x0 && cx < x0 + c && cz >= z0 && cz < z0 + c) n++;
          r.checked++;
          if (n === 0) {
            r.gaps++;
            if (dx * dx + dz * dz <= (rd * rd) / 4) r.inner++;
          }
          if (n > 1) r.overlaps++;
        }
      }
      return r;
    });
  const waitStreamed = (timeout = 300000) =>
    page.waitForFunction(() => window.__voxelands.world.isIdle && window.__voxelands.lod.isIdle, null, { timeout, polling: 250 });

  await check("detailed chunks and distant LOD tiles stream in and cover the land exactly once", async () => {
    const t0 = Date.now();
    await waitStreamed();
    const s = await page.evaluate(() => {
      const { lod, world } = window.__voxelands;
      const levels = {};
      for (const t of lod.tiles.values()) levels[t.level] = (levels[t.level] || 0) + 1;
      return { levels, tiles: lod.tiles.size, vertices: lod.stats.vertices, chunks: world.chunks.size, worker: !!lod.worker, fallback: lod.fallbackReason };
    });
    const cov = await lodCoverage();
    console.log(`        streamed in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${cov.chunks} detailed chunks shown (${s.chunks} loaded), ${s.tiles} LOD tiles by level ${JSON.stringify(s.levels)}, ${s.vertices} LOD vertices, built in a worker: ${s.worker}`);
    assert(s.worker && !s.fallback, `LOD tiles should build in a Web Worker (${s.fallback})`);
    assert(cov.gaps === 0 && cov.overlaps === 0, `coverage: ${JSON.stringify(cov)}`);
    assert(cov.chunks > 40 && s.tiles > 10, `expected detailed chunks near the player and LOD tiles farther out: ${JSON.stringify(cov)}`);
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
    assert(med.g === "medium" && med.rd === 16 && med.s.graphics === "medium", `graphics selector: ${JSON.stringify(med)}`);
    await page.selectOption("#graphics-preset", "low");
    // Restore the default for the rest of the run.
    await page.$eval("#render-distance", (el) => {
      el.value = "20";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click("#resume-btn", { timeout: 20000 });
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
  });

  // --- Level of detail (Round 3, Phase 3) ---
  await check("LOD: flying across the land hands over between chunks and tiles with no gaps or overlaps", async () => {
    await page.evaluate(() => window.__voxelands.setMode("creative")); // to fly (back to survival below)
    await waitStreamed();
    const worst = { overlaps: 0, inner: 0 };
    let samples = 0;
    // 14 chunks east, a chunk at a time, looking at the coverage each time.
    for (let i = 0; i < 14; i++) {
      await page.evaluate(() => {
        const p = window.__voxelands.player;
        p.flying = true;
        p.velocity.set(0, 0, 0);
        p.position.x += 16;
        p.position.y = 60;
      });
      for (let k = 0; k < 3; k++) {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const cov = await lodCoverage();
        worst.overlaps = Math.max(worst.overlaps, cov.overlaps);
        worst.inner = Math.max(worst.inner, cov.inner);
        samples++;
      }
    }
    await waitStreamed();
    const end = await lodCoverage();
    console.log(`        ${samples} samples while moving: worst ${worst.overlaps} overlapping chunks, ${worst.inner} gaps within half the render distance; settled: ${JSON.stringify(end)}`);
    assert(worst.overlaps === 0 && worst.inner === 0, `hand-over problems while moving: ${JSON.stringify(worst)}`);
    assert(end.gaps === 0 && end.overlaps === 0, `after settling: ${JSON.stringify(end)}`);
  });

  await check("LOD: a crater stays visible in the distant terrain", async () => {
    // Dig a whole chunk out down to y = 10 (every LOD cell size samples it),
    // then fly 12 chunks away so it's drawn as a LOD tile.
    const site = await page.evaluate(() => {
      const { world, player } = window.__voxelands;
      const cx = Math.floor(player.position.x / 16);
      const cz = Math.floor(player.position.z / 16) + 1;
      const e = [];
      for (let y = 10; y < 64; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) e.push(cx * 16 + x, y, cz * 16 + z, 0);
      world.setBlocks(e);
      player.position.x -= 12 * 16;
      return { x: cx * 16 + 8, z: cz * 16 + 8 };
    });
    await waitStreamed();
    const r = await page.evaluate(({ x, z }) => {
      const { lod, world } = window.__voxelands;
      const tile = [...lod.tiles.values()].find((t) => t.mesh && t.mesh.visible && x >= t.x0 && x < t.x0 + (32 << t.level) && z >= t.z0 && z < t.z0 + (32 << t.level));
      if (!tile) return { tile: null, chunkShown: !!world.getChunk(x >> 4, z >> 4)?.group.visible };
      // The top face over the site.
      const g = tile.mesh.geometry;
      const pos = g.attributes.position.array;
      const info = g.attributes.aInfo.array;
      let top = null;
      for (let v = 0; v < pos.length / 3; v += 4) {
        if (info[v * 4] !== 2 || info[v * 4 + 1] === 2) continue;
        const xs = [pos[v * 3], pos[v * 3 + 6]];
        const zs = [pos[v * 3 + 2], pos[v * 3 + 8]];
        const lx = x - tile.x0;
        const lz = z - tile.z0;
        if (lx >= Math.min(...xs) && lx <= Math.max(...xs) && lz >= Math.min(...zs) && lz <= Math.max(...zs)) top = pos[v * 3 + 1];
      }
      return { tile: tile.key, top, ground: world.heightAt(x, z) };
    }, site);
    console.log(`        crater site drawn by LOD tile ${r.tile}: surface at y=${r.top} (natural ground ${r.ground})`);
    assert(r.tile && r.top !== null && r.top <= 11, `the LOD tile should show the crater: ${JSON.stringify(r)}`);
  });

  await check("LOD: render distance 64 builds off the main thread without long frames, and memory is freed", async () => {
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.lod.stats.maxUpdateMs = 0;
      v.setRenderDistance(64);
    });
    const t0 = Date.now();
    await waitStreamed(900000);
    const far = await page.evaluate(() => {
      const { lod, camera } = window.__voxelands;
      return { tiles: lod.tiles.size, vertices: lod.stats.vertices, maxUpdateMs: lod.stats.maxUpdateMs, far: camera.far };
    });
    const cov = await lodCoverage();
    console.log(`        render distance 64: ${far.tiles} tiles, ${far.vertices} vertices, streamed in ${((Date.now() - t0) / 1000).toFixed(1)} s; longest LOD update ${far.maxUpdateMs.toFixed(1)} ms; camera far ${far.far}`);
    assert(cov.gaps === 0 && cov.overlaps === 0, `coverage at 64: ${JSON.stringify(cov)}`);
    assert(far.maxUpdateMs < 40, `a LOD update took ${far.maxUpdateMs.toFixed(1)} ms on the main thread`);
    assert(far.far >= 64 * 16, `camera far plane ${far.far} is short of the render distance`);
    // Far away, then back to the default distance: everything out of range is released.
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.setRenderDistance(20);
      v.player.position.x += 1500;
    });
    await waitStreamed();
    const after = await page.evaluate(() => {
      const { lod, world, player } = window.__voxelands;
      const pcx = Math.floor(player.position.x / 16);
      const pcz = Math.floor(player.position.z / 16);
      let farChunks = 0;
      for (const c of world.chunks.values()) if (Math.hypot(c.cx - pcx, c.cz - pcz) > 20) farChunks++;
      const meshes = lod.group.children.length;
      return { tiles: lod.tiles.size, leaves: lod.leafCount, meshes, chunks: world.chunks.size, farChunks };
    });
    console.log(`        after moving 1500 blocks at distance 20: ${after.tiles} tiles (${after.meshes} meshes), ${after.chunks} chunks loaded, ${after.farChunks} beyond 20 chunks`);
    assert(after.tiles === after.leaves && after.meshes === after.tiles && after.farChunks === 0, `stale tiles or chunks kept: ${JSON.stringify(after)}`);
    // Back to the world spawn for the rest of the checks.
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.world.prepareArea(v.spawn.x, v.spawn.z, 2);
      v.player.flying = false;
      v.player.spawnAt(v.spawn.x, v.spawn.z);
      v.setMode("survival");
    });
    await waitStreamed();
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

  await check("lighting: ambient occlusion never dims direct sunlight, and out-of-range light values stay finite", async () => {
    // Compiles the game's real lighting function (WORLD_COMMON) into a tiny
    // shader and evaluates it for chosen inputs on the GPU.
    const r = await page.evaluate(async () => {
      const { THREE, renderer, uniforms } = window.__voxelands;
      const { WORLD_COMMON } = await import("./js/shaders.js");
      const cases = [
        // [sky, blk, ao, shadow]
        [1, 0, 1, 1],
        [1, 0, 0, 1],
        [-0.4, 1.6, -0.5, 1], // what MSAA can extrapolate at triangle edges
        [1.3, -0.2, 2, 1],
      ];
      const rt = new THREE.WebGLRenderTarget(cases.length, 1, { type: THREE.FloatType });
      const saved = { sky: uniforms.uAmbientSky.value.clone(), ground: uniforms.uAmbientGround.value.clone(), dir: uniforms.uLightDir.value.clone(), color: uniforms.uLightColor.value.clone() };
      // Direct light only: ambient off, sun straight along +X at intensity 1.
      uniforms.uAmbientSky.value.set(0, 0, 0);
      uniforms.uAmbientGround.value.set(0, 0, 0);
      uniforms.uLightDir.value.set(1, 0, 0);
      uniforms.uLightColor.value.set(1, 1, 1);
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...uniforms, uCases: { value: cases.map((c) => new THREE.Vector4(...c)) } },
        vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
        fragmentShader: `#include <common>\n${WORLD_COMMON}\nuniform vec4 uCases[${cases.length}];\nvoid main() {\n  vec4 c = uCases[int(gl_FragCoord.x)];\n  vec3 l = worldLighting(vec3(1.0, 0.0, 0.0), c.x, c.y, c.z, c.w);\n  gl_FragColor = vec4(l, (any(isnan(l)) || any(isinf(l))) ? 1.0 : 0.0);\n}`,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      const scene = new THREE.Scene();
      scene.add(quad);
      const cam = new THREE.Camera();
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      const px = new Float32Array(cases.length * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, cases.length, 1, px);
      renderer.setRenderTarget(null);
      uniforms.uAmbientSky.value.copy(saved.sky);
      uniforms.uAmbientGround.value.copy(saved.ground);
      uniforms.uLightDir.value.copy(saved.dir);
      uniforms.uLightColor.value.copy(saved.color);
      rt.dispose();
      mat.dispose();
      return [...px];
    });
    const lum = (i) => r[i * 4];
    const bad = (i) => r[i * 4 + 3] > 0.5 || !Number.isFinite(r[i * 4]);
    console.log(`        direct light on a face: open corner ${lum(0).toFixed(3)}, fully occluded corner ${lum(1).toFixed(3)}; extrapolated inputs -> ${lum(2).toFixed(3)}, ${lum(3).toFixed(3)}`);
    // (A tiny constant ambient floor still takes AO: allow 1%.)
    assert(Math.abs(lum(0) - lum(1)) < 0.01 * lum(0) && lum(0) > 0.5, "ambient occlusion must not change direct sunlight");
    assert(!bad(2) && !bad(3), "out-of-range light inputs must not produce NaN/Inf");
    const decl = await page.evaluate(() => {
      const m = window.__voxelands.world.materials;
      return m.opaque.fragmentShader.includes("centroid varying vec2 vLight") && m.water.fragmentShader.includes("centroid varying vec2 vLight");
    });
    assert(decl, "per-vertex light should use centroid interpolation");
  });

  await check("water: just above the drawn surface is not 'under water', just below is", async () => {
    const r = await page.evaluate(() => {
      const { world, spawn, uniforms, water } = window.__voxelands;
      let spot = null;
      for (let rad = 5; rad < 150 && !spot; rad += 3) {
        for (let a = 0; a < 24 && !spot; a++) {
          const x = Math.round(spawn.x + Math.cos((a / 24) * 6.283) * rad);
          const z = Math.round(spawn.z + Math.sin((a / 24) * 6.283) * rad);
          if (world.getBlock(x, 24, z) === 5 && world.getBlock(x, 25, z) === 0 && world.getBlock(x, 22, z) === 5) spot = { x: x + 0.5, z: z + 0.5 };
        }
      }
      if (!spot) return null;
      const t = uniforms.uTime.value;
      const ws = uniforms.uWaveStrength.value;
      const surf = water.surfaceHeight(24, spot.x, spot.z, t, ws);
      return {
        surf,
        above: water.isUnderwater(world, spot.x, surf + 0.03, spot.z, t, ws),
        topOfCell: water.isUnderwater(world, spot.x, 24.99, spot.z, t, ws),
        below: water.isUnderwater(world, spot.x, surf - 0.03, spot.z, t, ws),
        deep: water.isUnderwater(world, spot.x, 23.5, spot.z, t, ws),
      };
    });
    if (!r) {
      console.log("        (no open sea found near spawn; skipped)");
      return;
    }
    console.log(`        surface at y=${r.surf.toFixed(3)}: above ${r.above}, top of the block ${r.topOfCell}, below ${r.below}, deeper ${r.deep}`);
    assert(!r.above && !r.topOfCell && r.below && r.deep, "under-water test must follow the drawn surface, not the block grid");
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

  await check("creative: instant break, place from the hotbar, scroll, flight toggle; the Blast Orb and F key are gone", async () => {
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
    const before = await page.evaluate(() => window.__voxelands.effects.explosionCount);
    await page.keyboard.press("KeyF");
    await page.waitForTimeout(800);
    const orb = await page.evaluate(() => ({ n: window.__voxelands.effects.explosionCount, ui: !!document.getElementById("orb-indicator"), fn: typeof window.__voxelands.effects.throwOrb }));
    assert(orb.n === before && !orb.ui && orb.fn === "undefined", `the Blast Orb should be gone: ${JSON.stringify(orb)}`);
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

  // --- Weapons (round 3) ---
  const waitForExplosion = async (prevCount, timeout = 60000) => {
    await page.waitForFunction((n) => window.__voxelands.effects.explosionCount > n, prevCount, { timeout, polling: 16 });
    return page.evaluate(() => {
      const { effects, player, uniforms } = window.__voxelands;
      return {
        ...effects.lastExplosion,
        trauma: effects.shake.trauma,
        debris: effects.debris.particles.length,
        smoke: effects.smoke.particles.length,
        glow: effects.glow.particles.length,
        playerVy: player.velocity.y,
        count: effects.explosionCount,
        time: uniforms.uTime.value,
      };
    });
  };

  // A long floating stone runway (21 x 47) with open air above; the player
  // stands at its +Z end looking down its length (-Z).
  const runway = (offX, offZ, y = 45) =>
    page.evaluate(
      ([offX, offZ, y]) => {
        const v = window.__voxelands;
        const x0 = v.spawn.x + offX;
        const z0 = v.spawn.z + offZ;
        v.world.prepareArea(x0, z0 - 17, 2); // edits need loaded chunks
        const e = [];
        for (let dx = -10; dx <= 10; dx++) {
          for (let dz = -40; dz <= 6; dz++) {
            e.push(x0 + dx, y, z0 + dz, 3);
            for (let dy = 1; dy <= 8; dy++) e.push(x0 + dx, y + dy, z0 + dz, 0);
          }
        }
        v.world.setBlocks(e);
        const p = v.player;
        p.flying = false;
        p.velocity.set(0, 0, 0);
        p.knockback.set(0, 0, 0);
        p.position.set(x0 + 0.5, y + 1, z0 + 4.5);
        p.yaw = 0;
        p.pitch = 0.05;
        return { x: x0, y, z: z0 };
      },
      [offX, offZ, y]
    );

  const giveWeapons = () =>
    page.evaluate(() => {
      const inv = window.__voxelands.inventory;
      inv.slots[0] = { id: 286, count: 1 }; // grenade
      inv.slots[1] = { id: 287, count: 1 }; // pistol
      inv.slots[2] = { id: 288, count: 1 }; // bazooka
    });

  await check("grenades: hold to charge (bar shown), quick click lobs short, full charge throws far; they bounce, 5 s fuse", async () => {
    await giveWeapons();
    await page.keyboard.press("Digit1");
    const throwOnce = async (full) => {
      await page.evaluate(() => (window.__vys = []));
      const prev = await page.evaluate(() => window.__voxelands.effects.explosionCount);
      await page.mouse.down({ button: "right" });
      let barShown = false;
      if (full) {
        await page.waitForFunction(() => window.__voxelands.weapons.charge > 0.3, null, { timeout: 30000, polling: 16 });
        barShown = await page.$eval("#throw-charge", (el) => !el.classList.contains("hidden"));
        await page.waitForFunction(() => window.__voxelands.weapons.charge >= 1, null, { timeout: 60000, polling: 16 });
      }
      await page.mouse.up({ button: "right" });
      const t0 = await page.evaluate(() => window.__voxelands.uniforms.uTime.value);
      await page.waitForFunction(
        (n) => {
          const v = window.__voxelands;
          const g = v.weapons.grenades[0];
          if (g) window.__vys.push(g.vel.y);
          return v.effects.explosionCount > n;
        },
        prev,
        { timeout: 120000, polling: 16 }
      );
      const r = await page.evaluate(() => {
        const v = window.__voxelands;
        const e = v.effects.lastExplosion;
        const p = v.player.position;
        let bounce = false;
        for (let i = 1; i < window.__vys.length; i++) if (window.__vys[i - 1] < -1 && window.__vys[i] > 0.3) bounce = true;
        return { dist: Math.hypot(e.x - p.x, e.z - p.z), bounce, t: v.uniforms.uTime.value, source: e.source, radius: e.radius };
      });
      return { ...r, fuse: r.t - t0, barShown };
    };
    await runway(40, 10);
    const quick = await throwOnce(false);
    await runway(40, 10);
    const far = await throwOnce(true);
    console.log(`        quick click: ${quick.dist.toFixed(1)} blocks; full charge: ${far.dist.toFixed(1)} blocks; fuse ${far.fuse.toFixed(2)} s; bounced: ${quick.bounce || far.bounce}`);
    assert(far.barShown, "the throw charge bar should show while charging");
    assert(quick.dist < 10 && far.dist > 18, "a full charge should throw much farther than a quick click");
    assert(far.bounce || quick.bounce, "grenades should bounce off the ground");
    assert(Math.abs(far.fuse - 5) < 0.4 && far.source === "grenade" && far.radius === 7, `grenade fuse/size wrong: ${JSON.stringify(far)}`);
  });

  await check("a grenade blast carves a ~7-block crater, with particles, shake, knockback and a local rebuild", async () => {
    await page.evaluate(() => {
      const { player, spawn } = window.__voxelands;
      player.flying = false;
      player.spawnAt(spawn.x, spawn.z);
      player.yaw = 0;
      player.pitch = -1.5; // look straight down
    });
    await page.keyboard.press("Digit1");
    await page.waitForTimeout(800); // land on the ground
    const prev = await page.evaluate(() => window.__voxelands.effects.explosionCount);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    const boom = await waitForExplosion(prev);
    console.log(`        removed ${boom.removed} blocks, farthest ${boom.maxDist.toFixed(2)} from center, carve ${boom.carveMs.toFixed(1)} ms`);
    console.log(`        particles: ${boom.debris} debris, ${boom.smoke} smoke, ${boom.glow} fire/sparks; shake trauma ${boom.trauma.toFixed(2)}; player vy ${boom.playerVy.toFixed(1)}`);
    assert(boom.removed > 300, `crater too small: ${boom.removed} blocks`);
    assert(boom.maxDist > 6 && boom.maxDist < 8.2, `crater reach ${boom.maxDist.toFixed(2)} outside the expected ~7 +/- 0.6`);
    assert(boom.carveMs < 150, `carving took ${boom.carveMs.toFixed(1)} ms`);
    assert(boom.debris > 50 && boom.smoke > 30 && boom.glow > 60, "expected a big particle burst");
    assert(boom.trauma > 0.3, `camera shake trauma only ${boom.trauma}`);
    assert(boom.playerVy > 2, `blast under the player should knock them upward (vy=${boom.playerVy.toFixed(2)})`);
    await page.waitForTimeout(300);
    const stats = await page.evaluate(() => window.__voxelands.world.stats);
    console.log(`        remeshed ${stats.lastEditRemeshCount} chunks in ${stats.lastEditRemeshMs.toFixed(1)} ms`);
    assert(stats.lastEditRemeshCount >= 1 && stats.lastEditRemeshCount <= 16, `remeshed ${stats.lastEditRemeshCount} chunks`);
  });

  await check("a grenade that hits a mob directly goes off at once", async () => {
    const a = await runway(-40, 10);
    await giveWeapons();
    await page.keyboard.press("Digit1");
    await page.evaluate(({ x, y, z }) => {
      const v = window.__voxelands;
      v.mobs.enabled = false;
      v.mobs.clear();
      v.sky.setSunAngle(Math.PI * 1.5); // night: zombies don't burn
      v.player.pitch = 0;
      const zb = v.mobs.spawn("zombie", x + 0.5, y + 1, z - 2.5);
      zb.ai.state = "idle";
      zb.ai.timer = 999;
      window.__zb = zb;
    }, a);
    const prev = await page.evaluate(() => window.__voxelands.effects.explosionCount);
    await page.mouse.down({ button: "right" });
    await page.waitForFunction(() => window.__voxelands.weapons.charge > 0.5, null, { timeout: 30000, polling: 16 });
    await page.mouse.up({ button: "right" });
    const t0 = await page.evaluate(() => window.__voxelands.uniforms.uTime.value);
    const boom = await waitForExplosion(prev);
    const dead = await page.evaluate(() => window.__zb.dead);
    console.log(`        exploded ${(boom.time - t0).toFixed(2)} s after the throw; zombie dead: ${dead}`);
    assert(boom.time - t0 < 2 && dead, "a direct hit should explode at once and kill the zombie");
    await page.evaluate(() => {
      window.__voxelands.mobs.clear();
      window.__voxelands.sky.setSunAngle(Math.PI * 0.4);
    });
  });

  await check("pistol: every click fires (no reload), bullets leave holes and hurt mobs with knockback", async () => {
    const a = await runway(-40, -60);
    await giveWeapons();
    await page.keyboard.press("Digit2");
    await page.evaluate(({ x, y, z }) => {
      const v = window.__voxelands;
      v.world.setBlocks([x - 1, y + 1, z - 3, 3, x, y + 1, z - 3, 3, x + 1, y + 1, z - 3, 3, x, y + 2, z - 3, 3]); // a little wall
      v.player.pitch = -0.2;
    }, a);
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => ({ shots: window.__voxelands.weapons.shots, holes: window.__voxelands.decals.count }));
    for (let i = 0; i < 6; i++) {
      await page.mouse.down({ button: "right" });
      await page.mouse.up({ button: "right" });
      await page.waitForTimeout(150);
    }
    const after = await page.evaluate(() => ({ shots: window.__voxelands.weapons.shots, holes: window.__voxelands.decals.count }));
    console.log(`        6 clicks -> ${after.shots - before.shots} shots, ${after.holes - before.holes} bullet holes`);
    assert(after.shots - before.shots === 6 && after.holes - before.holes === 6, "every click should fire and leave a hole in the wall");
    // Breaking the wall removes its bullet holes.
    await page.evaluate(({ x, y, z }) => window.__voxelands.world.setBlocks([x - 1, y + 1, z - 3, 0, x, y + 1, z - 3, 0, x + 1, y + 1, z - 3, 0, x, y + 2, z - 3, 0]), a);
    const holesLeft = await page.evaluate(() => window.__voxelands.decals.count);
    assert(holesLeft === before.holes, "bullet holes should vanish with their block");
    // Shoot a zombie (at night, so it isn't also burning in daylight).
    const r = await page.evaluate(({ x, y, z }) => {
      const v = window.__voxelands;
      v.sky.setSunAngle(Math.PI * 1.5);
      const zb = v.mobs.spawn("zombie", x + 0.5, y + 1, z - 4.5);
      zb.ai.state = "idle";
      zb.ai.timer = 999;
      window.__zb = zb;
      const eye = v.player.getEyePosition();
      v.player.yaw = Math.atan2(-(zb.pos.x - eye.x), -(zb.pos.z - eye.z));
      v.player.pitch = Math.atan2(zb.pos.y + 1.2 - eye.y, Math.hypot(zb.pos.x - eye.x, zb.pos.z - eye.z));
      return { d0: zb.pos.z };
    }, a);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(300);
    const hit = await page.evaluate(() => ({ hp: window.__zb.health, z: window.__zb.pos.z, flash: window.__zb.hurtTime < 1 }));
    console.log(`        zombie hit: health 20 -> ${hit.hp}, pushed from z=${r.d0.toFixed(2)} to ${hit.z.toFixed(2)}`);
    assert(hit.hp === 15 && hit.flash, "a pistol shot should deal 5 damage");
    assert(hit.z < r.d0 - 0.2, "a pistol shot should knock the zombie back");
    await page.evaluate(() => {
      window.__voxelands.mobs.clear();
      window.__voxelands.sky.setSunAngle(Math.PI * 0.4);
    });
  });

  await check("weapons are used on right-click instead of placing blocks", async () => {
    const a = await runway(-40, 10);
    await giveWeapons();
    await page.keyboard.press("Digit2");
    await aimAt(page, [a.x, a.y, a.z + 2]);
    const target = await page.evaluate(() => window.__voxelands.interaction.target);
    assert(target, "should be aiming at the floor");
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(200);
    const placed = await page.evaluate(({ x, y, z }) => window.__voxelands.world.getBlock(x, y + 1, z + 2), a);
    assert(placed === 0, "right-click with a pistol must not place a block");
  });

  await check("bazooka: a fast, nearly flat rocket with a smoke trail and a blast 5x a grenade's", async () => {
    const a = await runway(-110, 0);
    await giveWeapons();
    await page.keyboard.press("Digit3");
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.player.pitch = -0.045;
      v.world.stats.spreadRemeshFrames = 0;
    });
    await page.waitForTimeout(300);
    const prev = await page.evaluate(() => window.__voxelands.effects.explosionCount);
    const smoke0 = await page.evaluate(() => window.__voxelands.effects.smoke.particles.length);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    const fly = await page
      .waitForFunction(
        () => {
          const r = window.__voxelands.weapons.rockets[0];
          return r && r.age > 0.15 ? { age: r.age, speed: r.vel.length(), vy: r.vel.y, smoke: window.__voxelands.effects.smoke.particles.length } : null;
        },
        null,
        { timeout: 20000, polling: 16 }
      )
      .then((h) => h.jsonValue());
    const boom = await waitForExplosion(prev);
    const r = await page.evaluate(() => ({ falling: window.__voxelands.falling.active }));
    await page.waitForFunction(() => window.__voxelands.world.editRemeshQueue.size === 0, null, { timeout: 60000 });
    console.log(`        rocket: ${fly.speed.toFixed(0)} blocks/s, vertical ${fly.vy.toFixed(2)}; blast radius ${boom.radius}: removed ${boom.removed}, reach ${boom.maxDist.toFixed(1)}, carve ${boom.carveMs.toFixed(0)} ms, ${r.falling} falling blocks`);
    assert(fly.speed > 60 && Math.abs(fly.vy) < 5 && fly.smoke > smoke0, "the rocket should fly fast and nearly straight, trailing smoke");
    assert(boom.source === "bazooka" && boom.radius === 35 && boom.maxDist > 28 && boom.maxDist < 38, `bazooka blast should be ~35 blocks: ${JSON.stringify(boom)}`);
    assert(r.falling <= 64, "falling blocks must stay capped");
  });

  await check("explosions shake the camera less the farther away they are", async () => {
    const r = await page.evaluate(() => {
      const v = window.__voxelands;
      const { effects, THREE, player } = v;
      const eye = player.getEyePosition();
      effects.listener.copy(eye);
      const out = [];
      for (const d of [6, 40, 90, 200]) {
        const at = eye.clone().add(new THREE.Vector3(d, 30, 0)); // up in the air: no crater
        effects.explode(at, { radius: 7 });
        out.push(effects.lastExplosion.shake);
      }
      effects.shake.trauma = 0;
      return out;
    });
    console.log(`        grenade shake at 6/40/90/200 blocks: ${r.map((x) => x.toFixed(2)).join(", ")}`);
    assert(r[0] > r[1] && r[1] > r[2] && r[3] === 0, "shake should fall off with distance to nothing");
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
      effects.explode(new THREE.Vector3(spot.x + 0.5, floor + 0.5, spot.z + 0.5), { radius: 7 });
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

  // --- Loose blocks and sounds ---
  await check("sand and gravel fall: a column drops together and stacks, gravel breaks on a torch", async () => {
    // Let sand disturbed by earlier blasts finish falling first.
    await page.waitForFunction(() => window.__voxelands.falling.active === 0, null, { timeout: 60000, polling: 50 });
    const site = await setupArena(page, 12, -12, 40);
    await page.evaluate(({ x, y, z }) => {
      const { world } = window.__voxelands;
      const e = [];
      for (let k = 1; k <= 3; k++) e.push(x, y + k, z - 3, 3); // stone pillar
      for (let k = 4; k <= 9; k++) e.push(x, y + k, z - 3, 4); // 6 sand on top
      e.push(x + 2, y + 1, z - 3, 17, x + 2, y + 2, z - 3, 3, x + 2, y + 3, z - 3, 12); // torch, stone, gravel
      world.setBlocks(e);
    }, site);
    const still = await page.evaluate(() => window.__voxelands.falling.active);
    assert(still === 0, "supported sand must not fall");
    await page.evaluate(({ x, y, z }) => {
      const { world } = window.__voxelands;
      world.setBlocks([x, y + 1, z - 3, 0, x, y + 2, z - 3, 0, x, y + 3, z - 3, 0, x + 2, y + 2, z - 3, 0]);
    }, site);
    await page.waitForFunction(() => window.__voxelands.falling.active > 0, null, { timeout: 10000, polling: 16 });
    const falling = await page.evaluate(() => window.__voxelands.falling.active);
    await page.waitForFunction(() => window.__voxelands.falling.active === 0, null, { timeout: 60000, polling: 50 });
    const r = await page.evaluate(({ x, y, z }) => {
      const { world } = window.__voxelands;
      const col = [];
      for (let k = 0; k <= 9; k++) col.push(world.getBlock(x, y + k, z - 3));
      return { col, torch: [world.getBlock(x + 2, y + 1, z - 3), world.getBlock(x + 2, y + 2, z - 3), world.getBlock(x + 2, y + 3, z - 3)] };
    }, site);
    console.log(`        ${falling} blocks fell; column now ${JSON.stringify(r.col)}; torch column ${JSON.stringify(r.torch)}`);
    assert(JSON.stringify(r.col) === "[3,4,4,4,4,4,4,0,0,0]", "the whole sand column should land stacked on the floor");
    assert(JSON.stringify(r.torch) === "[17,0,0]", "gravel landing on a torch should break, leaving the torch");
  });

  await check("explosions: loose blocks animate up to a cap, the rest settle at once, nothing floats", async () => {
    const r = await page.evaluate(() => {
      const v = window.__voxelands;
      const { world, spawn, THREE, falling, effects } = v;
      const x0 = spawn.x - 30;
      const z0 = spawn.z - 30;
      const y = 30;
      const e = [];
      for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) for (let yy = y; yy <= y + 20; yy++) e.push(x0 + dx, yy, z0 + dz, yy < y + 8 ? 3 : yy < y + 14 ? 4 : 0);
      world.setBlocks(e);
      falling.update(0.016);
      const before = falling.settledInstantly;
      effects.explode(new THREE.Vector3(x0 + 0.5, y + 8, z0 + 0.5), { radius: 7 });
      const t0 = performance.now();
      falling.update(0.016);
      window.__sandArea = { x0, z0, y };
      return { active: falling.active, settled: falling.settledInstantly - before, ms: performance.now() - t0 };
    });
    console.log(`        blast in a sand bank: ${r.active} blocks animating, ${r.settled} settled at once (${r.ms.toFixed(1)} ms)`);
    assert(r.active > 0 && r.active <= 64 && r.settled > 0, `expected a capped number of falling blocks: ${JSON.stringify(r)}`);
    await page.waitForFunction(() => window.__voxelands.falling.active === 0, null, { timeout: 120000, polling: 100 });
    const floating = await page.evaluate(() => {
      const { world } = window.__voxelands;
      const s = window.__sandArea;
      let n = 0;
      for (let dx = -12; dx <= 12; dx++) {
        for (let dz = -12; dz <= 12; dz++) {
          for (let yy = s.y + 1; yy <= s.y + 20; yy++) {
            const id = world.getBlock(s.x0 + dx, yy, s.z0 + dz);
            const below = world.getBlock(s.x0 + dx, yy - 1, s.z0 + dz);
            if ((id === 4 || id === 12) && (below === 0 || below === 5)) n++;
          }
        }
      }
      return n;
    });
    assert(floating === 0, `${floating} sand blocks left floating`);
  });

  await check("sound effects all play; the jump and burp sounds are gone", async () => {
    const r = await page.evaluate(() => {
      const a = window.__voxelands.audio;
      a.ensureStarted();
      const failed = [];
      const calls = { playBreak: ["stone"], playPlace: ["glass"], playDig: ["wood"], playFootstep: ["sand"], playPickup: [], playClick: [], playCraft: [], playEat: [], playToolBreak: [], playHurt: [], playDeath: [], playSplash: [], playFlightToggle: [true], playThrow: [], playHit: [true], playSwing: [], playExplosion: [40] };
      for (const [k, args] of Object.entries(calls)) {
        try {
          a[k](...args);
        } catch (e) {
          failed.push(`${k}: ${e.message}`);
        }
      }
      for (const kind of ["fluffalo", "hoplet", "mossback", "zombie"]) {
        for (const ev of ["idle", "hurt", "death", "attack"]) {
          try {
            a.playMob(kind, ev, 4);
          } catch (e) {
            failed.push(`${kind}/${ev}: ${e.message}`);
          }
        }
      }
      return { failed, jump: typeof a.playJump, burp: typeof a.playBurp };
    });
    assert(r.failed.length === 0, `sounds failed: ${r.failed.join("; ")}`);
    assert(r.jump === "undefined" && r.burp === "undefined", "jump and burp sounds should be removed");
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
      // Mobs are exercised by their own checks below; keep these deterministic.
      v.mobs.enabled = false;
      v.mobs.clear();
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
      const { player, spawn, world } = window.__voxelands;
      const p = player.position;
      return {
        hp: player.health,
        d: Math.hypot(p.x - (spawn.x + 0.5), p.z - (spawn.z + 0.5)),
        dry: world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.5), Math.floor(p.z)) === 0,
        hidden: document.getElementById("death-screen").classList.contains("hidden"),
      };
    });
    // At the world spawn, or the nearest dry spot if a blast crater flooded it.
    assert(after.hp === 20 && after.d < 25 && after.dry && after.hidden, `respawn should restore full health at spawn: ${JSON.stringify(after)}`);
    void site;
  });

  await check("survival: your own grenade at your feet is deadly", async () => {
    await setupArena(page, 20, -20);
    await giveWeapons();
    await page.keyboard.press("Digit1");
    await page.evaluate(() => {
      window.__voxelands.player.pitch = -1.5;
    });
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    // The 5 s fuse is game time: at the software renderer's few frames per
    // second (each clamped to 50 ms of game time) that can take a minute or more.
    await page.waitForFunction(() => window.__voxelands.gameState === "dead", null, { timeout: 240000, polling: 30 });
    const cause = await page.$eval("#death-cause", (el) => el.textContent);
    console.log(`        death cause: "${cause}"`);
    assert(cause === "Blown up by your own grenade", `unexpected cause "${cause}"`);
    await page.waitForFunction(() => !document.getElementById("respawn-btn").disabled, null, { timeout: 10000 });
    await page.click("#respawn-btn", { timeout: 20000 });
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
  });

  await check("survival: a bazooka fired point blank kills you", async () => {
    const a = await runway(-110, 90);
    await giveWeapons();
    await page.keyboard.press("Digit3");
    await page.evaluate(({ x, y, z }) => {
      const v = window.__voxelands;
      v.player.health = 20;
      v.world.setBlocks([x, y + 1, z + 3, 3, x, y + 2, z + 3, 3]); // a wall right in front
      v.player.pitch = 0;
    }, a);
    await page.waitForTimeout(300);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await page.waitForFunction(() => window.__voxelands.gameState === "dead", null, { timeout: 60000, polling: 30 });
    const cause = await page.$eval("#death-cause", (el) => el.textContent);
    console.log(`        death cause: "${cause}"`);
    assert(cause === "Blown up by your own bazooka", `unexpected cause "${cause}"`);
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

  // --- Mobs and combat (Phase 5) ---
  // A night-time arena: a floating stone platform, the player at one end.
  const mobArena = async (offX, offZ, extra = "") => {
    // Start each check alive and in control, whatever the previous one did.
    if ((await page.evaluate(() => window.__voxelands.gameState)) === "dead") {
      await page.evaluate(() => window.__voxelands.respawn());
      await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
    }
    return page.evaluate(
      ([offX, offZ, extra]) => {
        const v = window.__voxelands;
        v.sky.setSunAngle(Math.PI * 1.5); // midnight
        v.mobs.clear();
        v.mobs.enabled = false;
        v.entities.clear();
        const x0 = v.spawn.x + offX;
        const z0 = v.spawn.z + offZ;
        const y = 46;
        v.world.prepareArea(x0, z0, 1); // edits need loaded chunks
        const e = [];
        for (let dx = -6; dx <= 6; dx++) {
          for (let dz = -10; dz <= 10; dz++) {
            e.push(x0 + dx, y, z0 + dz, 3);
            for (let dy = 1; dy <= 5; dy++) e.push(x0 + dx, y + dy, z0 + dz, 0);
          }
        }
        // Obstacles across the whole width: a 1-block step, or a water moat.
        for (let dx = -6; dx <= 6; dx++) {
          if (extra === "step") e.push(x0 + dx, y + 1, z0 - 2, 3);
          if (extra === "moat") e.push(x0 + dx, y, z0 - 2, 5, x0 + dx, y, z0 - 3, 5);
        }
        v.world.setBlocks(e);
        v.player.velocity.set(0, 0, 0);
        v.player.knockback.set(0, 0, 0);
        v.player.position.set(x0 + 0.5, y + 1, z0 + 6.5);
        v.player.yaw = 0;
        v.player.pitch = 0;
        v.player.health = 20;
        return { x: x0, y, z: z0 };
      },
      [offX, offZ, extra]
    );
  };

  await check("a zombie chases the player at night, climbs a 1-block step, and hits for damage", async () => {
    const a = await mobArena(-30, 30, "step");
    await page.evaluate(({ x, y, z }) => {
      window.__zombie = window.__voxelands.mobs.spawn("zombie", x + 0.5, y + 1, z - 7.5);
    }, a);
    await page.waitForFunction(() => window.__voxelands.player.health < 20, null, { timeout: 120000, polling: 50 });
    const s = await page.evaluate(() => ({ hp: window.__voxelands.player.health, z: window.__zombie.pos.z, y: window.__zombie.pos.y, target: window.__zombie.ai.target }));
    console.log(`        hit: player health ${s.hp}/20; zombie crossed the step to z=${s.z.toFixed(1)}`);
    assert(s.target && s.z > a.z - 2 && s.hp <= 17, `zombie should have crossed the step and hit: ${JSON.stringify(s)}`);
  });

  await check("sword combat: charged hits, knockback, hit flash, death animation, drops", async () => {
    await page.evaluate(() => {
      const v = window.__voxelands;
      v.inventory.clear();
      v.inventory.slots[0] = { id: 272, count: 1, dur: 251 }; // iron sword (6 damage)
      v.inventory.selected = 0;
    });
    const aimAtZombie = () =>
      page.evaluate(() => {
        const v = window.__voxelands;
        const z = window.__zombie;
        const eye = v.player.getEyePosition();
        const dx = z.pos.x - eye.x;
        const dy = z.pos.y + 1.3 - eye.y;
        const dz = z.pos.z - eye.z;
        v.player.yaw = Math.atan2(-dx, -dz);
        v.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        v.player.health = 20;
        // Hold off its attacks for a moment: a zombie hit knocks the player
        // into the air, and a hit while falling is a critical hit.
        z.attackCooldown = Math.max(z.attackCooldown, 4);
      });
    // A fully charged first hit, standing on the ground.
    await aimAtZombie();
    await page.waitForFunction(() => window.__voxelands.player.onGround && window.__voxelands.interaction.entityHit && window.__voxelands.mobs.charge(window.__voxelands.interaction.tool) >= 1, null, { timeout: 20000, polling: 30 });
    const before = await page.evaluate(() => {
      const z = window.__zombie;
      const p = window.__voxelands.player.position;
      return { hp: z.health, dist: Math.hypot(z.pos.x - p.x, z.pos.z - p.z) };
    });
    await page.mouse.down({ button: "left" });
    await page.waitForTimeout(30);
    await page.mouse.up({ button: "left" });
    const hit = await page.evaluate(() => ({ hp: window.__zombie.health, flash: window.__zombie.light.flash.r, dur: window.__voxelands.inventory.slots[0].dur }));
    assert(Math.abs(before.hp - hit.hp - 6) < 0.01, `a charged iron sword hit should deal 6 (health ${before.hp} -> ${hit.hp})`);
    assert(hit.flash > 0.2 && hit.dur === 250, `expected a red hit flash and sword wear: ${JSON.stringify(hit)}`);
    // Knockback: the zombie is thrown back before it can close in again.
    const after = await page
      .waitForFunction(
        (d0) => {
          const z = window.__zombie;
          const p = window.__voxelands.player.position;
          const d = Math.hypot(z.pos.x - p.x, z.pos.z - p.z);
          return d > d0 + 0.5 ? d : false;
        },
        before.dist,
        { timeout: 20000, polling: 16 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    console.log(`        charged hit: 6 damage; knocked back from ${before.dist.toFixed(2)} to ${after ? after.toFixed(2) : "?"} blocks`);
    assert(after !== null, "the hit should knock the zombie back");
    // An immediate second swing is weak (attack cooldown).
    await aimAtZombie();
    await page.evaluate(() => {
      const v = window.__voxelands;
      window.__hpBefore = window.__zombie.health;
      v.mobs.lastAttackTime = v.mobs.time; // just swung
      window.__zombie.invulnerable = 0;
      v.mobs.attack(window.__zombie, v.interaction.tool);
    });
    const weak = await page.evaluate(() => window.__hpBefore - window.__zombie.health);
    assert(weak > 0 && weak < 2, `an uncharged swing should be weak (dealt ${weak})`);
    // Finish it off.
    for (let i = 0; i < 10; i++) {
      if (await page.evaluate(() => window.__zombie.dead)) break;
      await aimAtZombie();
      await page.waitForFunction(() => window.__zombie.dead || (window.__voxelands.interaction.entityHit && window.__voxelands.mobs.charge(window.__voxelands.interaction.tool) >= 1), null, { timeout: 20000, polling: 30 });
      await page.mouse.down({ button: "left" });
      await page.waitForTimeout(30);
      await page.mouse.up({ button: "left" });
    }
    const dying = await page.evaluate(() => ({ dead: window.__zombie.dead, tilt: window.__zombie.model.tilt.rotation.z }));
    assert(dying.dead, "the zombie should be dead");
    await page.waitForFunction(() => window.__voxelands.mobs.count === 0, null, { timeout: 30000, polling: 50 });
    const kills = await page.evaluate(() => window.__voxelands.mobs.kills);
    assert(kills >= 1, "kill not counted");
  });

  await check("killing an animal drops its items, which the player collects", async () => {
    const a = await mobArena(-30, 60);
    await page.evaluate(({ x, y, z }) => {
      const v = window.__voxelands;
      v.sky.setSunAngle(Math.PI * 0.5); // noon
      window.__animal = v.mobs.spawn("fluffalo", x + 0.5, y + 1, z + 4.5);
      window.__animal.ai.state = "idle";
      window.__animal.ai.timer = 999;
      v.inventory.clear();
      v.inventory.slots[0] = { id: 273, count: 1, dur: 1562 }; // diamond sword (7)
      v.inventory.selected = 0;
    }, a);
    for (let i = 0; i < 6; i++) {
      if (await page.evaluate(() => window.__animal.dead)) break;
      await page.evaluate(() => {
        const v = window.__voxelands;
        const m = window.__animal;
        // Catch up with it (it runs away once hurt).
        const d = Math.hypot(m.pos.x - v.player.position.x, m.pos.z - v.player.position.z) || 1;
        if (d > 2.2) v.player.position.set(m.pos.x - ((m.pos.x - v.player.position.x) / d) * 2, m.pos.y, m.pos.z - ((m.pos.z - v.player.position.z) / d) * 2);
        const eye = v.player.getEyePosition();
        const dx = m.pos.x - eye.x;
        const dy = m.pos.y + 0.8 - eye.y;
        const dz = m.pos.z - eye.z;
        v.player.yaw = Math.atan2(-dx, -dz);
        v.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      });
      await page.waitForFunction(() => window.__animal.dead || (window.__voxelands.interaction.entityHit && window.__voxelands.mobs.charge(window.__voxelands.interaction.tool) >= 1), null, { timeout: 20000, polling: 30 });
      const fled = await page.evaluate(() => window.__animal.ai.state);
      if (i > 0) assert(fled === "flee" || (await page.evaluate(() => window.__animal.dead)), `a hurt animal should flee (state ${fled})`);
      await page.mouse.down({ button: "left" });
      await page.waitForTimeout(30);
      await page.mouse.up({ button: "left" });
    }
    await page.waitForFunction(() => window.__voxelands.mobs.count === 0, null, { timeout: 30000, polling: 50 });
    const drops = await page.evaluate(() => window.__voxelands.entities.items.map((i) => i.id));
    assert(drops.includes(265) && drops.includes(263), `a Fluffalo should drop fluff and raw meat (dropped ${JSON.stringify(drops)})`);
    // Walk over to where they fell.
    await page.evaluate(() => {
      const v = window.__voxelands;
      const it = v.entities.items[0];
      v.player.position.set(it.pos.x, it.pos.y + 0.1, it.pos.z + 0.5);
    });
    await page.waitForFunction(() => window.__voxelands.inventory.countItem(265) > 0 && window.__voxelands.inventory.countItem(263) > 0, null, { timeout: 60000, polling: 100 });
    const inv = await page.evaluate(() => ({ fluff: window.__voxelands.inventory.countItem(265), meat: window.__voxelands.inventory.countItem(263) }));
    console.log(`        Fluffalo dropped and the player picked up ${inv.fluff} fluff and ${inv.meat} raw meat`);
  });

  await check("zombies won't walk into water", async () => {
    const a = await mobArena(-60, 30, "moat");
    await page.evaluate(({ x, y, z }) => {
      window.__zombie = window.__voxelands.mobs.spawn("zombie", x + 0.5, y + 1, z - 7.5);
      window.__wet = false;
      window.__wetTimer = setInterval(() => {
        if (window.__zombie.inWater) window.__wet = true;
      }, 20);
    }, a);
    // Give it plenty of game time to reach the moat and look for a way around.
    await page.evaluate(() => (window.__t0 = window.__voxelands.mobs.time));
    await page.waitForFunction(() => window.__voxelands.mobs.time > window.__t0 + 10, null, { timeout: 180000, polling: 200 });
    const s = await page.evaluate(({ z }) => {
      clearInterval(window.__wetTimer);
      return { wet: window.__wet, zz: window.__zombie.pos.z, edge: z - 3, hp: window.__voxelands.player.health, target: window.__zombie.ai.target };
    }, a);
    console.log(`        zombie waited at the moat (z=${s.zz.toFixed(2)}, water starts at ${s.edge}), chasing=${s.target}`);
    assert(!s.wet && s.zz < s.edge && s.hp === 20 && s.target, `zombie should chase but stop at the water: ${JSON.stringify(s)}`);
  });

  await check("a zombie's hit can kill: the death screen says Killed by a zombie", async () => {
    await page.evaluate(() => {
      const v = window.__voxelands;
      const p = v.player.position;
      v.mobs.clear();
      window.__zombie = v.mobs.spawn("zombie", p.x, p.y, p.z - 1.2);
      v.inventory.clear();
      v.player.health = 2;
    });
    await page.waitForFunction(() => window.__voxelands.gameState === "dead", null, { timeout: 60000, polling: 50 });
    await page.waitForTimeout(500);
    const cause = await page.$eval("#death-cause", (el) => el.textContent);
    const title = await page.$eval("#death-screen .noob", (el) => el.textContent);
    await page.screenshot({ path: path.join(__dirname, "screenshot-zombie-death.png") }).catch(() => {});
    assert(title === "NOOB!" && cause === "Killed by a zombie", `death screen: "${title}" / "${cause}"`);
    await page.waitForFunction(() => !document.getElementById("respawn-btn").disabled, null, { timeout: 10000 });
    await page.click("#respawn-btn", { timeout: 20000 });
    await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
  });

  await check("mob caps, despawning, daylight burning, explosion damage, creative immunity", async () => {
    const a = await mobArena(-60, 60);
    const s = await page.evaluate(({ x, y, z }) => {
      const v = window.__voxelands;
      const { mobs, player, spawn, THREE, sky } = v;
      const setTime = (angle) => {
        sky.setSunAngle(angle);
        sky.update(0, player.getEyePosition(), player.getForwardVector());
      };
      // Spawning at night around the world spawn respects the caps.
      mobs.clear();
      mobs.enabled = true;
      player.spawnAt(spawn.x, spawn.z);
      setTime(Math.PI * 1.5);
      for (let i = 0; i < 600; i++) mobs._updateSpawning(0.5);
      const hostile = mobs.countOf(true);
      const passive = mobs.countOf(false);
      // Far-away mobs despawn.
      const far = mobs.spawn("zombie", player.position.x + 200, 40, player.position.z);
      mobs.update(0.016);
      const farGone = !mobs.mobs.includes(far);
      mobs.clear();
      mobs.enabled = false;
      // Back on the open arena: zombies burn in daylight.
      player.position.set(x + 0.5, y + 1, z + 6.5);
      setTime(Math.PI * 0.5);
      const zb = mobs.spawn("zombie", x + 0.5, y + 1, z - 6.5);
      let burned = false;
      for (let i = 0; i < 60; i++) {
        mobs.update(0.05);
        burned = burned || zb.burning;
      }
      burned = burned && zb.health < 20;
      // Explosions hurt mobs.
      mobs.clear();
      const f = mobs.spawn("fluffalo", x + 0.5, y + 1, z - 6.5);
      mobs.explosion(new THREE.Vector3(x + 1, y + 1.5, z - 6), 7);
      const blasted = f.dead;
      // Creative players are ignored.
      mobs.clear();
      v.setMode("creative");
      setTime(Math.PI * 1.5);
      const c = mobs.spawn("zombie", x + 0.5, y + 1, z + 4.5);
      for (let i = 0; i < 20; i++) mobs.update(0.05);
      const ignored = !c.ai.target && player.health === 20;
      mobs.clear();
      v.setMode("survival");
      return { hostile, passive, farGone, burned, blasted, ignored };
    }, a);
    console.log(`        after 600 spawn ticks at night: ${s.hostile} zombies, ${s.passive} animals`);
    assert(s.hostile > 0 && s.hostile <= 10 && s.passive <= 14, `mob caps: ${JSON.stringify(s)}`);
    assert(s.farGone && s.burned && s.blasted && s.ignored, `mob rules: ${JSON.stringify(s)}`);
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
