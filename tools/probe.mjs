// Quick probe harness: boots the game in headless Chromium (software WebGL),
// clicks Play, then runs a scenario module against the live page. Much
// faster than the full smoke suite for iterating on one feature, and it can
// save screenshots for visual checks.
//
//   node probe.mjs <scenario.mjs> [--preset=ultra] [--seed=42] [--size=960x540] [--out=dir]
//
// The scenario's default export gets { page, assert, shot(name), frames(n), v(fn, arg) }
// where v evaluates fn(window.__voxelands, arg) in the page. The run fails on
// any console error or page error, like the smoke test.
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const args = Object.fromEntries(
  process.argv
    .slice(3)
    .filter((a) => a.startsWith("--"))
    .map((a) => a.slice(2).split("="))
);
const scenarioPath = path.resolve(process.argv[2] || "");
const PORT = 8940 + Math.floor(Math.random() * 50);
const SEED = Number(args.seed ?? 42);
const [W, H] = (args.size || "960x540").split("x").map(Number);
const OUT = path.resolve(args.out || path.join(__dirname, "probe-out"));
fs.mkdirSync(OUT, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: W, height: H } });
const localThreeRoot = path.join(__dirname, "node_modules", "three");
await page.route("https://cdn.jsdelivr.net/npm/three@0.160.0/**", (route) => {
  const rel = new URL(route.request().url()).pathname.replace("/npm/three@0.160.0/", "");
  route.fulfill({ path: path.join(localThreeRoot, rel), contentType: "text/javascript" });
});
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
  else if (args.verbose) console.log(`  [console] ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(String(e)));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const t0 = Date.now();
await page.goto(`http://localhost:${PORT}/index.html?seed=${SEED}`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => !!window.__voxelands, null, { timeout: 60000 });
// Boot on Low (fast under software rendering), then switch to the preset asked for.
await page.evaluate(() => window.__voxelands.setGraphics("low"));
await page.click("#play-btn", { timeout: 120000 });
await page.waitForFunction(() => window.__voxelands.gameState === "playing", null, { timeout: 60000 });
if (args.preset) await page.evaluate((p) => window.__voxelands.setGraphics(p), args.preset);
console.log(`  booted in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const frames = (n = 2) =>
  page.evaluate(
    (k) =>
      new Promise((r) => {
        let i = 0;
        const f = () => (++i >= k ? r() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n
  );
const v = (fn, arg) => page.evaluate(([src, a]) => new Function("v", "arg", `return (${src})(v, arg);`)(window.__voxelands, a), [fn.toString(), arg]);
const shot = async (name) => {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  screenshot: ${file}`);
  return file;
};

let failed = false;
try {
  const scenario = await import(pathToFileURL(scenarioPath).href);
  await scenario.default({ page, assert, shot, frames, v });
} catch (err) {
  failed = true;
  console.log(`  FAIL: ${err.stack || err.message}`);
}
if (errors.length) {
  failed = true;
  console.log(`  console errors:\n    ${errors.slice(0, 10).join("\n    ")}`);
}
console.log(failed ? "PROBE FAILED" : "PROBE OK");
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
