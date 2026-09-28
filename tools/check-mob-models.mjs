// Quick standalone check: builds every mob model (geometry + painted skin)
// in a real browser context and reports any construction errors, without
// booting the whole game. Much faster than the full smoke suite for
// iterating on mob-models.js.
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8935;
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage();
const localThreeRoot = path.join(__dirname, "node_modules", "three");
await page.route("https://cdn.jsdelivr.net/npm/three@0.160.0/**", (route) => {
  const rel = new URL(route.request().url()).pathname.replace("/npm/three@0.160.0/", "");
  route.fulfill({ path: path.join(localThreeRoot, rel), contentType: "text/javascript" });
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`http://localhost:${PORT}/index.html`);
const result = await page.evaluate(async () => {
  const { MODELS, createMobModel } = await import("/js/mob-models.js");
  const out = {};
  for (const kind of Object.keys(MODELS)) {
    try {
      const m = createMobModel(kind);
      let parts = 0;
      let meshes = m.meshes.length;
      m.root.traverse(() => parts++);
      m.animate({ time: 1, walkPhase: 1, walk: 1, headYaw: 0.2, headPitch: 0.1, graze: 0, hide: 0, attack: 0.5, vy: 0 });
      out[kind] = { ok: true, meshes, parts };
    } catch (err) {
      out[kind] = { ok: false, error: err.message + "\n" + err.stack };
    }
  }
  return out;
});
for (const [kind, r] of Object.entries(result)) {
  console.log(r.ok ? `  OK  ${kind}: ${r.meshes} meshes, ${r.parts} nodes` : `  FAIL  ${kind}: ${r.error}`);
}
const bad = Object.values(result).filter((r) => !r.ok).length;
if (errors.length) console.log("Page errors:\n" + errors.join("\n"));
await browser.close();
server.close();
process.exit(bad > 0 || errors.length > 0 ? 1 : 0);
