// Headless smoke test: serves the game root over HTTP and loads it in
// Chromium (software WebGL) checking for console/page errors.
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8934;

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
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-gl=swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // The sandboxed test network cannot reach cdn.jsdelivr.net (policy-blocked),
  // while a real deployed player's browser can. Redirect only the CDN import
  // to a locally npm-installed copy of the exact same pinned version, purely
  // for this smoke test — the shipped index.html still imports from the CDN.
  const localThreePath = path.join(__dirname, "node_modules", "three", "build", "three.module.js");
  await page.route("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", (route) => {
    route.fulfill({ path: localThreePath, contentType: "text/javascript" });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto(`http://localhost:${PORT}/index.html?seed=42`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Click "Click to Play" to exercise pointer lock + start of the game loop.
  try {
    const playBtn = await page.$("#play-btn");
    if (playBtn) {
      await playBtn.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      // Simulate a bit of movement/input.
      await page.keyboard.down("KeyW");
      await page.waitForTimeout(500);
      await page.keyboard.up("KeyW");
      await page.mouse.move(700, 400);
      await page.mouse.move(650, 380);
      await page.waitForTimeout(1000);
      // Exercise break/place and hotbar input.
      await page.mouse.down({ button: "left" });
      await page.waitForTimeout(100);
      await page.mouse.up({ button: "left" });
      await page.mouse.down({ button: "right" });
      await page.waitForTimeout(100);
      await page.mouse.up({ button: "right" });
      await page.keyboard.press("Digit3");
      await page.mouse.wheel(0, 200);
      await page.keyboard.press("KeyF");
      await page.waitForTimeout(1000);
    } else {
      errors.push("play button (#play-btn) not found in DOM");
    }
  } catch (err) {
    errors.push(`interaction error: ${err.message}`);
  }

  const startMenuHidden = await page.$eval("#start-menu", (el) => el.className).catch(() => "n/a");
  console.log("start-menu class:", startMenuHidden);

  const fpsText = await page.$eval("#fps-counter", (el) => el.textContent).catch(() => null);
  console.log("FPS counter text:", fpsText);

  await page.screenshot({ path: path.join(__dirname, "screenshot.png") }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}

if (errors.length > 0) {
  console.error("\nConsole/page errors detected:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
} else {
  console.log("\nNo console or page errors detected. OK.");
  process.exit(0);
}
