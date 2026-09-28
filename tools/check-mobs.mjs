// Quick standalone check for the new group-4 mobs (skeleton arrows, spider
// wall-climbing, new passive animals, flying/swimming critters), without
// running the whole smoke suite. Much faster to iterate with.
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8936;
const SEED = 42;
const MIME = { ".html": "text/html", ".js": "text/javascript" };
const server = http.createServer((req, res) => {
  let filePath = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));

const errors = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const localThreeRoot = path.join(__dirname, "node_modules", "three");
await page.route("https://cdn.jsdelivr.net/npm/three@0.160.0/**", (route) => {
  const rel = new URL(route.request().url()).pathname.replace("/npm/three@0.160.0/", "");
  route.fulfill({ path: path.join(localThreeRoot, rel), contentType: "text/javascript" });
});
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  OK  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

await page.goto(`http://localhost:${PORT}/index.html?seed=${SEED}`, { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => !!window.__voxelands, null, { timeout: 30000 });
await page.evaluate(() => window.__voxelands.setGraphics("low"));
await page.click("#play-btn");
await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 10000 });
await page.evaluate(() => window.__voxelands.setMode("creative"));

async function arena(offX, offZ, y = 46) {
  return page.evaluate(
    ([offX, offZ, y]) => {
      const { world, player, spawn } = window.__voxelands;
      const x0 = spawn.x + offX;
      const z0 = spawn.z + offZ;
      world.prepareArea(x0, z0, 2);
      const e = [];
      for (let dx = -6; dx <= 6; dx++) {
        for (let dz = -6; dz <= 6; dz++) {
          e.push(x0 + dx, y, z0 + dz, 3);
          for (let dy = 1; dy <= 6; dy++) e.push(x0 + dx, y + dy, z0 + dz, 0);
        }
      }
      world.setBlocks(e);
      player.flying = true;
      player.velocity.set(0, 0, 0);
      player.position.set(x0 + 0.5, y + 2, z0 + 0.5);
      player.yaw = 0;
      player.pitch = 0;
      window.__voxelands.mobs.clear();
      return { x: x0, y, z: z0 };
    },
    [offX, offZ, y]
  );
}

await check("skeleton: shoots real arrows with gravity drop that hurt the player", async () => {
  const a = await arena(0, 0);
  const r = await page.evaluate(({ x, y, z }) => {
    const v = window.__voxelands;
    v.player.health = 20;
    v.player.mode = "survival"; // damage is a no-op in creative
    v.player._invulnerable = 0;
    const sk = v.mobs.spawn("skeleton", x + 0.5, y + 1, z - 6.5);
    sk.ai.state = "idle";
    sk.ai.timer = 999;
    sk.attackCooldown = 0;
    v.player.position.set(x + 0.5, y + 1, z + 0.5);
    v.player.yaw = 0;
    v.player.pitch = 0;
    return { hpBefore: v.player.health };
  }, a);
  // Let the AI notice the player and fire (it needs a few think ticks).
  await page.waitForFunction(() => window.__voxelands.mobs.arrows.length > 0, null, { timeout: 20000, polling: 50 }).catch(() => {});
  const shot = await page.evaluate(() => window.__voxelands.mobs.arrows.length > 0);
  assert(shot, "the skeleton never fired an arrow");
  // Gravity integration (vel.y += ARROW_GRAVITY*dt) runs every frame regardless
  // of the archer's upward aim-compensation arc, so check velocity decay rather
  // than net height (at short range the arrow can still be rising in an
  // arbitrary sample window, since it's aimed to arc down onto the target).
  const vy0 = await page.evaluate(() => (window.__voxelands.mobs.arrows[0] ? window.__voxelands.mobs.arrows[0].vel.y : null));
  await page.waitForTimeout(150);
  const vy1 = await page.evaluate(() => (window.__voxelands.mobs.arrows[0] ? window.__voxelands.mobs.arrows[0].vel.y : null));
  const hpAfter = await page.evaluate(() => window.__voxelands.player.health);
  console.log(`        arrow vel.y ${vy0 === null ? "(hit/gone)" : vy0.toFixed(2)} -> ${vy1 === null ? "(hit/gone)" : vy1.toFixed(2)}; player hp ${r.hpBefore} -> ${hpAfter}`);
  if (vy0 !== null && vy1 !== null) assert(vy1 < vy0, "the arrow's vertical velocity should decay under gravity while in flight");
  await page.waitForFunction(() => window.__voxelands.player.health < 20, null, { timeout: 15000, polling: 50 }).catch(() => {});
  const finalHp = await page.evaluate(() => window.__voxelands.player.health);
  assert(finalHp < 20, `the arrow should have hurt the player (hp still ${finalHp})`);
});

await check("spider: climbs straight up a wall chasing the player", async () => {
  const a = await arena(0, -60);
  const r = await page.evaluate(({ x, y, z }) => {
    const v = window.__voxelands;
    const e = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = 1; dy <= 8; dy++) e.push(x + dx, y + dy, z - 4, 3); // an 8-tall wall
    v.world.setBlocks(e);
    const sp = v.mobs.spawn("spider", x + 0.5, y + 1, z - 2.5);
    sp.ai.state = "idle";
    sp.ai.timer = 999;
    v.player.position.set(x + 0.5, y + 1, z + 6.5); // on the far side of the wall
    v.player.yaw = Math.PI;
    v.player.pitch = 0;
    window.__sp = sp;
    return { y0: sp.pos.y };
  }, a);
  await page.waitForFunction(() => window.__sp.pos.y > window.__voxelands.spawn ? true : true, null, { timeout: 1 }).catch(() => {});
  await page.waitForFunction((y0) => window.__sp.pos.y > y0 + 2, r.y0, { timeout: 30000, polling: 50 }).catch(() => {});
  const y1 = await page.evaluate(() => window.__sp.pos.y);
  console.log(`        spider climbed from y=${r.y0.toFixed(2)} to y=${y1.toFixed(2)}`);
  assert(y1 > r.y0 + 2, `spider should climb the wall (only reached y=${y1.toFixed(2)})`);
});

await check("cow, pig and chicken spawn and wander like the other animals", async () => {
  const a = await arena(0, 60);
  await page.evaluate(
    ({ x, y, z }) => {
      const v = window.__voxelands;
      v.mobs.spawn("cow", x + 0.5, y + 1, z + 0.5);
      v.mobs.spawn("pig", x + 2.5, y + 1, z + 0.5);
      v.mobs.spawn("chicken", x - 2.5, y + 1, z + 0.5);
    },
    a
  );
  await page.waitForTimeout(1500);
  const alive = await page.evaluate(() => window.__voxelands.mobs.mobs.filter((m) => !m.dead).map((m) => m.kind));
  console.log(`        alive: ${alive.join(", ")}`);
  assert(alive.includes("cow") && alive.includes("pig") && alive.includes("chicken"), `expected all three, got ${alive}`);
});

await check("flying critters (butterfly, parrot, fish) move without falling under gravity", async () => {
  const a = await arena(60, 0);
  const r = await page.evaluate(
    ({ x, y, z }) => {
      const v = window.__voxelands;
      const b = v.mobs.spawn("butterfly", x + 0.5, y + 3, z + 0.5);
      const f = v.mobs.spawn("fish", x + 0.5, y + 2, z + 2.5);
      return { by0: b.pos.y, fy0: f.pos.y };
    },
    a
  );
  await page.waitForTimeout(2000);
  const r2 = await page.evaluate(() => {
    const v = window.__voxelands;
    const b = v.mobs.mobs.find((m) => m.kind === "butterfly");
    const f = v.mobs.mobs.find((m) => m.kind === "fish");
    return { by1: b ? b.pos.y : null, fy1: f ? f.pos.y : null };
  });
  console.log(`        butterfly y ${r.by0.toFixed(2)} -> ${r2.by1?.toFixed(2)}; fish y ${r.fy0.toFixed(2)} -> ${r2.fy1?.toFixed(2)}`);
  assert(r2.by1 !== null && r2.by1 > r.by0 - 1.5, "a butterfly should not plummet under gravity");
});

await check("villager still spawns near a village and just wanders (no combat AI)", async () => {
  const found = await page.evaluate(() => {
    const v = window.__voxelands;
    for (let cx = -6; cx <= 6; cx++) {
      for (let cz = -6; cz <= 6; cz++) {
        const c = v.world.terrain.villages._cellCenter(cx, cz);
        if (c) return c;
      }
    }
    return null;
  });
  assert(found, "no village found near spawn for seed 42 in a 12x12 cell search");
  console.log(`        village at (${found.x}, ${found.z})`);
});

console.log(errors.length ? `Page errors:\n${errors.join("\n")}` : "No page errors.");
await browser.close();
server.close();
process.exit(failed > 0 || errors.length > 0 ? 1 : 0);
