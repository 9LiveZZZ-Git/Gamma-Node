// M2.5.1 extractor: carves the rig warp editor (mesh + Bezier modes,
// state, draw, hit-test, pointer handlers) out of
// src/_monolith.middle.2.js into src/rig/warp-editor.js.
//
// One contiguous block bounded by:
//   START: `/* ------------ Phase 6.6.9 — mesh warp editor state + helpers --` sub-divider
//   END  : end of `function _wireWarpEditor(...)` -- just before
//          `function _autoWarpMeshForDisplay` (auto-warp / calibration,
//          peeled in a later M2.5.x).
//
// Contents (~1,100 lines):
//   * Phase 6.6.9 sub-divider + doc comment
//   * const _warpEditor (editor state singleton)
//   * function _resampleWarpMesh
//   * function _cloneWarpMesh
//   * function openWarpEditor
//   * function closeWarpEditor
//   * function _updateWarpEditorModeUI
//   * function _drawWarpEditor (mesh + Bezier visualization)
//   * function _warpEditorHitTest
//   * function _warpEditorCanvasToNdc
//   * let _warpEditorWired = false (one-time wiring guard)
//   * function _wireWarpEditor (~1500-line event-handler block)
//
// What stays in middle.2 (deferred to later M2.5.x peels):
//   * Earlier mesh utility helpers: _makeIdentityWarpMesh,
//     _makeTriangularWarpMesh, _makeTestWarpMesh (~lines 910-1100)
//     -- scattered far upstream; move as part of a later cleanup
//   * _bezierToWarpMesh, _makeIdentityBezier (Bezier core) -- also
//     scattered upstream
//   * _autoWarpMeshForDisplay, _applyAutoWarpToRig, _validateWarpMesh
//     (auto-warp / calibration -- adjacent downstream, M2.5.2 candidate)
//   * applyCalibrationCorrections, _buildAICalibrationReport,
//     exportAICalibrationReport, showAICalibrationModal,
//     resetAICalibration (AI calibration -- separate peel)
//
// middle.2 is split at the cut into two new fragments:
//   src/_monolith.middle.2.1.js   (everything before Phase 6.6.9)
//   src/_monolith.middle.2.2.js   (everything from _autoWarpMeshForDisplay on)
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

const src = readFileSync("src/_monolith.middle.2.js", "utf8");

// START anchor: the Phase 6.6.9 mesh warp editor sub-divider.
const startMarker = "/* ------------ Phase 6.6.9 — mesh warp editor";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of `function _wireWarpEditor`. The next function
// `_autoWarpMeshForDisplay` is auto-warp / calibration.
const endFuncIdx = src.indexOf("function _wireWarpEditor", cutStart);
if (endFuncIdx < 0) throw new Error("`function _wireWarpEditor` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check: next non-blank should be the auto-warp doc comment
// or function declaration.
{
  const nextChunk = src.slice(cutEnd, cutEnd + 120);
  if (!nextChunk.includes("_autoWarpMeshForDisplay") && !nextChunk.includes("Build a warp mesh for one display")) {
    console.warn("WARN: post-cut content does not look like auto-warp:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("warp editor cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

// ── Slice
const part1 = src.slice(0, cutStart);
const warpPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + warpPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/rig", { recursive: true });
writeFileSync("src/_monolith.middle.2.1.js", part1);
writeFileSync("src/rig/warp-editor.js",      warpPart);
writeFileSync("src/_monolith.middle.2.2.js", part2);

// Update manifest.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.middle.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.middle.2.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.middle.2.1.js",
  "rig/warp-editor.js",
  "_monolith.middle.2.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.middle.2.js")) {
  unlinkSync("src/_monolith.middle.2.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.5.1 split complete (pure relocation):");
console.log("  src/_monolith.middle.2.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/rig/warp-editor.js     ", fmt(warpPart.length).padStart(11), "bytes   <- warp editor carved out");
console.log("  src/_monolith.middle.2.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                        ", fmt(part1.length + warpPart.length + part2.length).padStart(11), "bytes");
console.log("  original middle.2.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-warp-editor-before.html gamma-node-editor.html");
