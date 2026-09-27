// Web Worker that builds distant-terrain (LOD) tile meshes off the main
// thread (see lod-mesher.js for the meshes and lod.js for the tiles).
//
// Messages in:  { type: "init", seed, palette, edits: [[key, list], ...] }
//               { type: "edits", key, list }   (a chunk's edits changed)
//               { type: "build", id, level, tx, tz }
// Messages out: { type: "tile", id, mesh }     (typed arrays transferred)
import { LodTerrain, buildLodTile, makeLodPalette } from "./lod-mesher.js";

let terrain = null;
let palette = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    terrain = new LodTerrain(m.seed);
    palette = makeLodPalette(m.palette);
    for (const [key, list] of m.edits) terrain.setChunkEdits(key, list);
  } else if (m.type === "edits") {
    terrain.setChunkEdits(m.key, m.list);
  } else if (m.type === "build") {
    const mesh = buildLodTile(terrain, m.level, m.tx, m.tz, palette);
    self.postMessage({ type: "tile", id: m.id, mesh }, [mesh.position.buffer, mesh.color.buffer, mesh.info.buffer, mesh.index.buffer]);
  }
};
