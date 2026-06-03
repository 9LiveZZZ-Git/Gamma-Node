// M2.5 extractor: carves the rig props pane (renderRigPane +
// wireRigPaneHandlers) out of src/_monolith.tail.1.js into
// src/rig/pane.js.
//
// One contiguous block bounded by:
//   START: `/* ---------- Phase 6.5 — rig props pane ----------`
//          (sub-divider above `renderRigPane`).
//   END  : end of `function wireRigPaneHandlers(...)` -- just before
//          `function renderGroupProps` (non-rig group-props pane).
//
// Contents (~805 lines):
//   * Leading rig-pane doc comment
//   * function renderRigPane()        -- builds the rig props pane HTML
//                                        (template picker + display list,
//                                        per-display pose / FOV / blend
//                                        controls)
//   * function wireRigPaneHandlers()  -- attaches click + drag handlers
//                                        for template change, per-display
//                                        edits, edge-blend resets
//
// Future M2.5.x peels:
//   * src/rig/warp-editor.js  (openWarpEditor + closeWarpEditor +
//     _warpEditorHitTest + _warpEditorCanvasToNdc, in middle.2.js)
//   * src/rig/ai-calibration.js  (applyCalibrationCorrections,
//     _buildAICalibrationReport, exportAICalibrationReport,
//     showAICalibrationModal, resetAICalibration, in middle.2.js)
//   * src/rig/gizmo.js  (_drawGizmoFrame, in tail.2.2.2.2.2.js)
//   * Optional: _rigTileLayout (one small helper in tail.2.2.2.1.js)
//
// tail.1.js is split at the cut into two new fragments:
//   src/_monolith.tail.1.1.js   (everything before the rig sub-divider,
//                                 including the broader Properties-pane
//                                 section divider)
//   src/_monolith.tail.1.2.js   (everything from renderGroupProps onward)
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

const src = readFileSync("src/_monolith.tail.1.js", "utf8");

// START anchor: the rig sub-divider above renderRigPane.
const startMarker = "/* ---------- Phase 6.5 — rig props pane ----------";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of `function wireRigPaneHandlers`. Next function is
// `renderGroupProps` (group props, not rig).
const endFuncIdx = src.indexOf("function wireRigPaneHandlers", cutStart);
if (endFuncIdx < 0) throw new Error("`function wireRigPaneHandlers` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
// Walk past any blank lines so the next chunk starts cleanly at
// `function renderGroupProps`.
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check: next non-blank should be `function renderGroupProps`.
{
  const nextChunk = src.slice(cutEnd, cutEnd + 80);
  if (!nextChunk.includes("renderGroupProps")) {
    console.warn("WARN: post-cut content does not start with renderGroupProps:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("rig pane cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 60)));

// ── Slice
const part1 = src.slice(0, cutStart);
const rigPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + rigPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/rig", { recursive: true });
writeFileSync("src/_monolith.tail.1.1.js", part1);
writeFileSync("src/rig/pane.js",           rigPart);
writeFileSync("src/_monolith.tail.1.2.js", part2);

// Update manifest.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.1.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.1.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.1.1.js",
  "rig/pane.js",
  "_monolith.tail.1.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.tail.1.js")) {
  unlinkSync("src/_monolith.tail.1.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.5 split complete (pure relocation):");
console.log("  src/_monolith.tail.1.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/rig/pane.js          ", fmt(rigPart.length).padStart(11), "bytes   <- rig props pane carved out");
console.log("  src/_monolith.tail.1.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                      ", fmt(part1.length + rigPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.1.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-rig-pane-before.html gamma-node-editor.html");
