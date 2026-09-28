// Strict ES-module parse check for every game module: `node --check` treats
// .js files loosely and can miss real bracket-mismatch bugs (see PROGRESS.md,
// round 3). Actually importing each module forces a real parse; we only flag
// SyntaxErrors, since many modules throw ordinary runtime errors outside a
// browser (no three.js/DOM globals here), which is expected and not a bug.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsDir = path.join(__dirname, "..", "js");
const files = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js"));

let bad = 0;
for (const f of files) {
  try {
    await import(pathToFileURL(path.join(jsDir, f)).href);
  } catch (err) {
    if (err instanceof SyntaxError) {
      bad++;
      console.log(`SYNTAX ERROR in ${f}: ${err.message}`);
    }
    // Other errors (missing 'three', no `document`, etc.) are expected outside a browser.
  }
}
console.log(bad === 0 ? `OK: ${files.length} files parsed cleanly.` : `${bad} file(s) with real syntax errors.`);
process.exit(bad > 0 ? 1 : 0);
