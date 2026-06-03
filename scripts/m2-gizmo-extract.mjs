// M2.5.2 extractor: carves the 3D rig wireframe gizmo (Phase 6.5.16)
// and the adjacent visual-overlay helpers (display labels, theater
// hint, rig HUD, text overlay, gizmo frame, canvas wiring) out of
// src/_monolith.tail.2.2.2.2.2.js into src/rig/gizmo.js.
//
// One contiguous block bounded by:
//   START: `/* ----- Phase 6.5.16 — 3D rig wireframe gizmo --` sub-divider
//   END  : end of `function _wireGizmoCanvas(...)` -- just before the
//          visual-rAF state + `function renderVisualFrame` (the main
//          per-frame visual entry point, not rig).
//
// Contents:
//   * Phase 6.5.16 sub-divider + gizmo doc comment
//   * const _gizmoCam (orbit-cam state)
//   * let _gizmoOpen, _gizmoDrag
//   * function _setGizmoOpen, toggleRigGizmo
//   * function _yawPitchToVec, _rotateDisplayPoint (rig math helpers)
//   * function _drawVisualOverlay, _drawTheaterHint,
//     _drawRigGizmoHud, _drawTextOverlay (rig-composite overlays
//     interleaved with the gizmo functions in source order)
//   * function _drawGizmoFrame (the big per-frame gizmo render)
//   * function _wireGizmoCanvas (canvas pointer events for orbit
//     drag + wheel zoom)
//
// What stays in tail.2.2.2.2.2 after the cut:
//   * Pre-cluster: scene encoder, lights, sun-time helpers, etc.
//   * Post-cluster: visual rAF loop (let _visualRafHandle,
//     renderVisualFrame, _visualRenderTick), live-control sync,
//     OSC subsystem, wire-side evaluation, etc.
//
// tail.2.2.2.2.2 is split at the cut into two new fragments:
//   src/_monolith.tail.2.2.2.2.2.1.js   (everything before Phase 6.5.16)
//   src/_monolith.tail.2.2.2.2.2.2.js   (visual rAF onward)
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

const src = readFileSync("src/_monolith.tail.2.2.2.2.2.js", "utf8");

// START anchor: the Phase 6.5.16 rig-gizmo sub-divider.
const startMarker = "/* ----- Phase 6.5.16 — 3D rig wireframe gizmo";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of `function _wireGizmoCanvas`. Next is the visual
// rAF loop (renderVisualFrame).
const endFuncIdx = src.indexOf("function _wireGizmoCanvas", cutStart);
if (endFuncIdx < 0) throw new Error("`function _wireGizmoCanvas` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check: next non-blank should be the visual-rAF block or
// `renderVisualFrame`.
{
  const nextChunk = src.slice(cutEnd, cutEnd + 200);
  if (!nextChunk.includes("_visualRafHandle") && !nextChunk.includes("renderVisualFrame")) {
    console.warn("WARN: post-cut content does not look like visual rAF:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("rig gizmo cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

// ── Slice
const part1 = src.slice(0, cutStart);
const gizmoPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + gizmoPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/rig", { recursive: true });
writeFileSync("src/_monolith.tail.2.2.2.2.2.1.js", part1);
writeFileSync("src/rig/gizmo.js",                  gizmoPart);
writeFileSync("src/_monolith.tail.2.2.2.2.2.2.js", part2);

// Update manifest.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.2.2.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.2.2.2.2.2.1.js",
  "rig/gizmo.js",
  "_monolith.tail.2.2.2.2.2.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.tail.2.2.2.2.2.js")) {
  unlinkSync("src/_monolith.tail.2.2.2.2.2.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.5.2 split complete (pure relocation):");
console.log("  src/_monolith.tail.2.2.2.2.2.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/rig/gizmo.js                 ", fmt(gizmoPart.length).padStart(11), "bytes   <- rig gizmo + overlays carved out");
console.log("  src/_monolith.tail.2.2.2.2.2.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                              ", fmt(part1.length + gizmoPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.2.2.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-gizmo-before.html gamma-node-editor.html");
