// M2.5.5 extractor: splits the remaining src/_monolith.middle.2.1.2.js
// (which is now 100% rig code) into two files under src/rig/.
//
// middle.2.1.2.js contents (verified):
//   Lines 1-233 : Phase 6.6.20.13 v2 iterative AI calibration wrapper
//                 (runAICalibrationFlow + runAICalibrationIterative)
//   Line  234   : blank
//   Line  235+  : Phase 6.6.2 MPCDI / Bourke CSV importers
//                 + Phase 6.6.2b PFM + PNG binary parsers
//                 + Phase 6.6.3b PFM warp export
//
// Split point: the `/* ------------ Phase 6.6.2 — MPCDI / Bourke CSV
// importers ------ */` sub-divider at line 235. Everything before that
// (the iterative-calib block) becomes src/rig/iterative-calib.js;
// everything from that divider to EOF becomes src/rig/importers.js.
//
// Outcome: middle.2.1.2.js is fully consumed and deleted. Manifest
// gets `rig/iterative-calib.js` + `rig/importers.js` in place of
// `_monolith.middle.2.1.2.js`.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

const src = readFileSync("src/_monolith.middle.2.1.2.js", "utf8");

// Find the split point: the Phase 6.6.2 sub-divider.
const splitMarker = "/* ------------ Phase 6.6.2 — MPCDI / Bourke CSV importers";
const splitIdx = src.indexOf(splitMarker);
if (splitIdx < 0) throw new Error(`split marker not found: ${splitMarker}`);

// Cut at column 0 of the sub-divider's line.
let splitAt = splitIdx;
while (splitAt > 0 && (src[splitAt - 1] === " " || src[splitAt - 1] === "\t")) splitAt--;

console.log("middle.2.1.2 split:");
console.log("  total length    ", src.length.toLocaleString(), "bytes");
console.log("  split at byte   ", splitAt, " line", lineOf(src, splitAt));
console.log("  pre-split  end  :", JSON.stringify(src.slice(Math.max(0, splitAt - 60), splitAt)));
console.log("  post-split start:", JSON.stringify(src.slice(splitAt, splitAt + 80)));

const iterativePart = src.slice(0, splitAt);
const importersPart = src.slice(splitAt);

if (iterativePart.length + importersPart.length !== src.length) {
  throw new Error("slice math wrong");
}

// Write the two new files.
mkdirSync("src/rig", { recursive: true });
writeFileSync("src/rig/iterative-calib.js", iterativePart);
writeFileSync("src/rig/importers.js",       importersPart);

// Update manifest: replace `_monolith.middle.2.1.2.js` with the two
// new rig files (in source order: iterative-calib, then importers).
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.middle.2.1.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.middle.2.1.2.js` not found");
manifest.js.splice(
  idx, 1,
  "rig/iterative-calib.js",
  "rig/importers.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Delete the now-fully-consumed source file.
if (existsSync("src/_monolith.middle.2.1.2.js")) {
  unlinkSync("src/_monolith.middle.2.1.2.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.5.5 split complete (pure relocation):");
console.log("  src/rig/iterative-calib.js", fmt(iterativePart.length).padStart(11), "bytes   <- Phase 6.6.20.13 v2 iterative wrapper");
console.log("  src/rig/importers.js      ", fmt(importersPart.length).padStart(11), "bytes   <- Bourke/MPCDI/PFM importers + PFM exporter");
console.log("  ────────────────────────────────────────");
console.log("  sum                       ", fmt(iterativePart.length + importersPart.length).padStart(11), "bytes");
console.log("  original middle.2.1.2.js  ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-import-export-before.html gamma-node-editor.html");
