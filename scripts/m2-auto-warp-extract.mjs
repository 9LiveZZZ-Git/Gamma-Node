// M2.5.6 extractor: carves the rig auto-blend + auto-warp + warp-mesh
// validator out of src/_monolith.middle.2.2.js into
// src/rig/auto-warp.js.
//
// One contiguous block bounded by:
//   START: `/* ------------ Phase 6.6.11 — auto-blend overlap detection`
//          at byte 0 (the file's first content).
//   END  : end of `function _validateWarpMesh(...)` -- just before the
//          edge-blend defaults + rig-template / _makeDisplay block
//          (display-construction territory, peeled separately later).
//
// Contents (~758 lines):
//   * Phase 6.6.11 -- auto-blend overlap detection
//       - _computeOverlapBands
//       - _projectorFramebufferUV
//       - _makeScreenSpaceBlendMesh
//       - _makeAutoBlendMesh
//   * Phase 6.6.15 -- auto-warp from screen geometry
//       - _raySphereDistance, _rayCylinderDistanceY
//       - _autoWarpMeshForDisplay (ray-cast each grid vertex onto the
//         screen surface, project back to audience UV)
//       - _applyBezierCorrectionsToMesh, _applyKeystoneCornersToMesh
//       - _applyAutoWarpToRig, _applyAutoBlendToRig
//   * Mesh validator: _validateWarpMesh (post-load sanity check
//     called from migrateDisplayShape)
//
// What stays in middle.2.2 (deferred to later peels):
//   * _defaultEdgeBlend, _migrateEdgeBlend (edge-blend defaults +
//     .gpatch migration -- belongs with rig-template defaults)
//   * _makeDisplay (display constructor)
//   * _evenAzimuthRing (template helper)
//   * applyRigTemplate (template apply)
//   * Group / makeNode / patch state (post-rig content)
//
// Since cutStart = 0, no pre-cluster fragment is created. The split
// rewrites _monolith.middle.2.2.js in place with just the post-cluster
// bytes and inserts rig/auto-warp.js into the manifest before it.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync
} from "node:fs";

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

const src = readFileSync("src/_monolith.middle.2.2.js", "utf8");

if (!src.startsWith("/* ------------ Phase 6.6.11")) {
  throw new Error("source file does not start with the Phase 6.6.11 sub-divider");
}
const cutStart = 0;

// END anchor: end of `_validateWarpMesh`. Next is `_defaultEdgeBlend`
// (rig-template territory).
const endFuncIdx = src.indexOf("function _validateWarpMesh", cutStart);
if (endFuncIdx < 0) throw new Error("`function _validateWarpMesh` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check.
{
  const nextChunk = src.slice(cutEnd, cutEnd + 200);
  if (!nextChunk.includes("_defaultEdgeBlend") && !nextChunk.includes("Edge-blend")) {
    console.warn("WARN: post-cut content does not look like edge-blend defaults:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("auto-warp cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

const autoWarpPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (autoWarpPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

mkdirSync("src/rig", { recursive: true });
writeFileSync("src/rig/auto-warp.js",        autoWarpPart);
writeFileSync("src/_monolith.middle.2.2.js", part2);

// Insert rig/auto-warp.js into the manifest BEFORE the existing
// _monolith.middle.2.2.js entry.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.middle.2.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.middle.2.2.js` not found");
manifest.js.splice(idx, 0, "rig/auto-warp.js");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.5.6 split complete (pure relocation):");
console.log("  src/rig/auto-warp.js          ", fmt(autoWarpPart.length).padStart(11), "bytes   <- auto-blend + auto-warp + warp-mesh validator");
console.log("  src/_monolith.middle.2.2.js   ", fmt(part2.length).padStart(11), "bytes   (rewritten in place)");
console.log("  ────────────────────────────────────────");
console.log("  sum                           ", fmt(autoWarpPart.length + part2.length).padStart(11), "bytes");
console.log("  original middle.2.2.js        ", fmt(src.length).padStart(11), "bytes");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-auto-warp-before.html gamma-node-editor.html");
