// M2.5.3 extractor: carves the rig calibration block (Phase 6.6.20.8
// auto-capture + 6.6.20.10 AI analysis) out of
// src/_monolith.middle.2.1.js into src/rig/calibration.js.
//
// One contiguous block bounded by:
//   START: `/* ------------ Phase 6.6.20.8 — Auto-capture calibration`
//   END  : end of `function resetAICalibration` (the last AI-calibration
//          helper) -- next is the Bourke / MPCDI / PFM mesh import
//          parsers, a separate concern peeled later.
//
// Contents (~1,550 lines):
//   * Phase 6.6.20.8 -- Auto-capture calibration
//       - _waitForFrames
//       - _directionInCoverage
//       - per-direction capture + coverage helpers
//   * Phase 6.6.20.10 -- AI calibration analysis
//       - _arrayBufferToBase64
//       - per-display VLM analysis pipeline producing yaw / pitch /
//         FOV / Bezier corrections
//       - applyCalibrationCorrections (apply deltas to state.rig)
//       - _buildAICalibrationReport (markdown report builder)
//       - exportAICalibrationReport (download .md)
//       - showAICalibrationModal (review-and-apply UI)
//       - resetAICalibration (clear edits, restore template defaults)
//
// What stays in middle.2.1.x (deferred to later peels):
//   * Phase 6.6 warp mesh builders (_makeIdentityWarpMesh, etc.)
//   * Phase 6.6.19 Bezier authoring (_bernsteinBasis, _bezierEval, etc.)
//   * Phase 6.6.3 exporters (_writeZipArchive, _serializeBourkeMesh, etc.)
//   * Bourke / MPCDI / PFM importers (_parseBourkeMeshCsv, etc.)
//
// middle.2.1 is split at the cut into two new fragments:
//   src/_monolith.middle.2.1.1.js   (everything before Phase 6.6.20.8)
//   src/_monolith.middle.2.1.2.js   (everything from _parseBourkeMeshCsv on)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

// ── Brace counter (shared with M1/M2.x extractors).

function skipTemplate(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && s[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < s.length && depth > 0) {
        const cc = s[i];
        if (cc === "/" && s[i + 1] === "/") { const nl = s.indexOf("\n", i); i = nl < 0 ? s.length : nl + 1; }
        else if (cc === "/" && s[i + 1] === "*") { const end = s.indexOf("*/", i + 2); i = end < 0 ? s.length : end + 2; }
        else if (cc === "'" || cc === "\"") { const q = cc; i++; while (i < s.length) { if (s[i] === "\\") { i += 2; continue; } if (s[i] === q) { i++; break; } i++; } }
        else if (cc === "`") { i = skipTemplate(s, i + 1); }
        else { if (cc === "{") depth++; else if (cc === "}") depth--; i++; }
      }
    } else { i++; }
  }
  return s.length;
}

function findMatching(s, i, openChar, closeChar) {
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") { const nl = s.indexOf("\n", i); i = nl < 0 ? s.length : nl + 1; continue; }
    if (c === "/" && s[i + 1] === "*") { const end = s.indexOf("*/", i + 2); i = end < 0 ? s.length : end + 2; continue; }
    if (c === "'" || c === "\"") { const q = c; i++; while (i < s.length) { if (s[i] === "\\") { i += 2; continue; } if (s[i] === q) { i++; break; } i++; } continue; }
    if (c === "`") { i = skipTemplate(s, i + 1); continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) depth--;
    i++;
  }
  return i - 1;
}

function funcEnd(src, funcStart) {
  const i = src.indexOf("{", funcStart);
  if (i < 0) throw new Error("no { after function at " + funcStart);
  return findMatching(src, i + 1, "{", "}") + 1;
}

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

// ── Boundaries

const src = readFileSync("src/_monolith.middle.2.1.js", "utf8");

// START anchor: the Phase 6.6.20.8 Auto-capture calibration sub-divider.
const startMarker = "/* ------------ Phase 6.6.20.8 — Auto-capture calibration";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of `function resetAICalibration`. Next is
// `_parseBourkeMeshCsv` (mesh import parsers).
const endFuncIdx = src.indexOf("function resetAICalibration", cutStart);
if (endFuncIdx < 0) throw new Error("`function resetAICalibration` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check: next non-blank should be `_parseBourkeMeshCsv` or
// its leading doc comment about "Bourke".
{
  const nextChunk = src.slice(cutEnd, cutEnd + 200);
  if (!nextChunk.includes("_parseBourkeMeshCsv") && !nextChunk.includes("Bourke")) {
    console.warn("WARN: post-cut content does not look like Bourke importer:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("rig calibration cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

// ── Slice
const part1 = src.slice(0, cutStart);
const calibPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + calibPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/rig", { recursive: true });
writeFileSync("src/_monolith.middle.2.1.1.js", part1);
writeFileSync("src/rig/calibration.js",        calibPart);
writeFileSync("src/_monolith.middle.2.1.2.js", part2);

// Update manifest.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.middle.2.1.js");
if (idx < 0) throw new Error("manifest entry `_monolith.middle.2.1.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.middle.2.1.1.js",
  "rig/calibration.js",
  "_monolith.middle.2.1.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.middle.2.1.js")) {
  unlinkSync("src/_monolith.middle.2.1.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.5.3 split complete (pure relocation):");
console.log("  src/_monolith.middle.2.1.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/rig/calibration.js       ", fmt(calibPart.length).padStart(11), "bytes   <- auto-capture + AI calibration carved out");
console.log("  src/_monolith.middle.2.1.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                          ", fmt(part1.length + calibPart.length + part2.length).padStart(11), "bytes");
console.log("  original middle.2.1.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-calibration-before.html gamma-node-editor.html");
