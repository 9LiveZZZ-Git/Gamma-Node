// M2.5.4 extractor: carves the rig warp data layer (Phase 6.6 warp
// mesh builders + 6.6.19 Bezier authoring + 6.6.3 CSV / MPCDI
// exporters) out of src/_monolith.middle.2.1.1.js into
// src/rig/warp-data.js.
//
// One contiguous block bounded by:
//   START: `/* ---------- Phase 6.6 — calibration & warp data layer ----------`
//   END  : end of file (the Phase-6.6.20.8 calibration block that
//          previously followed was carved out in M2.5.3).
//
// Contents (~525 lines):
//   * Phase 6.6 sub-divider + Bourke-mesh format doc comment
//   * Warp mesh builders: _makeIdentityWarpMesh,
//     _makeTriangularWarpMesh, _makeTestWarpMesh
//   * Phase 6.6.19 -- Bezier-patch warp authoring
//       - _bernsteinBasis, _bezierEval
//       - _makeIdentityBezier
//       - _bezierToWarpMesh, _rebuildMeshFromBezier
//   * Phase 6.6.3 -- CSV / MPCDI exporters
//       - _crc32 (ZIP CRC), _writeZipArchive
//       - _serializeBourkeMesh (Paul-Bourke CSV format)
//       - _serializeMpcdiXml (MPCDI manifest)
//       - _downloadBlob
//       - exportBourkeMeshForDisplay (one .csv per display)
//       - exportMpcdiBundle (zipped CSVs + PFMs + mpcdi.xml)
//
// Since the cluster ends at EOF, no post-cluster fragment is created.
// The split rewrites _monolith.middle.2.1.1.js in place (truncating
// it to the pre-cluster content, lines 1-867) and adds rig/warp-data.js
// to the manifest immediately after.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

const src = readFileSync("src/_monolith.middle.2.1.1.js", "utf8");

// START anchor.
const startMarker = "/* ---------- Phase 6.6 — calibration & warp data layer ----------";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of file.
const cutEnd = src.length;

console.log("warp data cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(Math.max(0, cutEnd - 60), cutEnd)));

// ── Slice (no post-cluster fragment since cutEnd === EOF)
const part1 = src.slice(0, cutStart);
const warpDataPart = src.slice(cutStart, cutEnd);

if (part1.length + warpDataPart.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/rig", { recursive: true });
// Rewrite middle.2.1.1.js in place with just the pre-cluster bytes.
writeFileSync("src/_monolith.middle.2.1.1.js", part1);
writeFileSync("src/rig/warp-data.js",          warpDataPart);

// Update manifest: insert rig/warp-data.js immediately after the
// existing _monolith.middle.2.1.1.js entry.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.middle.2.1.1.js");
if (idx < 0) throw new Error("manifest entry `_monolith.middle.2.1.1.js` not found");
manifest.js.splice(idx + 1, 0, "rig/warp-data.js");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.5.4 split complete (pure relocation):");
console.log("  src/_monolith.middle.2.1.1.js (rewritten in place)", fmt(part1.length).padStart(11), "bytes");
console.log("  src/rig/warp-data.js                              ", fmt(warpDataPart.length).padStart(11), "bytes   <- warp meshes + Bezier + exporters carved out");
console.log("  ────────────────────────────────────────");
console.log("  sum                                               ", fmt(part1.length + warpDataPart.length).padStart(11), "bytes");
console.log("  original middle.2.1.1.js                          ", fmt(src.length).padStart(11), "bytes");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-warp-data-before.html gamma-node-editor.html");
