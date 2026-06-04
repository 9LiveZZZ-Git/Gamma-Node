// M2.6 extractor: carves the visual graph compiler -- _buildRenderPlan
// + a closely-paired helper (_encodeShaderFragPassForPlan, lives inside
// the same WGSL/template-heavy block) -- out of
// src/_monolith.tail.2.2.2.1.2.js into src/visual/render-plan.js.
//
// One contiguous block bounded by:
//   START: `/* Phase 6.6.30 + v0.2.16 -- walk the patch graph from each
//          VisualOutput` doc comment (line ~4696).
//   END  : end of `function _buildRenderPlan(...)` (the body contains
//          many embedded WGSL template strings for composition
//          fragment shaders; the brace counter handles them).
//
// Per the original modularization survey, _buildRenderPlan is the
// single biggest top-level function in the monolith (~3,628 lines).
//
// Contents (~3,660 lines):
//   * The doc-comment explanation of the render-plan algorithm:
//     planKey / planEntry shapes, scratch-slot reuse, ping-pong
//     depth parity, per-VO render schedules.
//   * function _buildRenderPlan(visualOutputs)
//       - Walks the patch graph from each VisualOutput.
//       - Allocates scratch slots per-parity (read=a, write=b
//         alternation by chain depth).
//       - Produces (plan, schedules) used by _encodeVisualGraph.
//   * Embedded WGSL composition fragment shaders (mix, blur,
//     feedback, displacement, etc. -- the per-effect shader source
//     is generated inline as JS template literals inside the function).
//
// What stays in tail.2.2.2.1.2 (deferred to future M2.6.x peels):
//   * Upstream of the cut: rig composite encoder, perf overlay,
//     audio/clock uniforms, shader layouts, shader pipeline cache,
//     shader instance management, video sources + MediaPipe overlays,
//     blob tracker, text shader generation, matrix math (mat4 family),
//     camera evaluation, transforms, mesh chains, scene resolution,
//     level2D / tilemap expansion, _encodeVisualGraph (entry point
//     that calls _buildRenderPlan), _encodeLayerClear,
//     _encodeShaderFragPassForVO
//   * Downstream of the cut: MSAA, ShaderMat / HDRI, mesh pipelines,
//     sprite pipelines, sky pipeline, atmosphere LUTs, mesh-buffer
//     caching + AABB / frustum, mesh builders (box / sphere /
//     capsule / GLB / etc).
//   These are good candidates for: visual/core.js, visual/scene-pass.js,
//   visual/pipelines.js, visual/mesh.js, visual/sky.js peels.
//
// tail.2.2.2.1.2 is split at the cut into two new fragments:
//   src/_monolith.tail.2.2.2.1.2.1.js   (everything before the cluster)
//   src/_monolith.tail.2.2.2.1.2.2.js   (everything from _ensureMsaa3DTextures on)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

// ── Brace counter with string/template/comment skipping. Critical for
// this peel: _buildRenderPlan's body contains many backtick template
// literals carrying WGSL source (with `{` and `}` inside the WGSL).

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

const src = readFileSync("src/_monolith.tail.2.2.2.1.2.js", "utf8");

// START anchor: the distinctive Phase 6.6.30 + v0.2.16 doc comment.
const startMarker = "/* Phase 6.6.30 + v0.2.16 — walk the patch graph from each";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of `function _buildRenderPlan`. Next function is
// `_ensureMsaa3DTextures` (Sprint 7.5.3a -- MSAA texture management).
const endFuncIdx = src.indexOf("function _buildRenderPlan", cutStart);
if (endFuncIdx < 0) throw new Error("`function _buildRenderPlan` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check.
{
  const nextChunk = src.slice(cutEnd, cutEnd + 200);
  if (!nextChunk.includes("_ensureMsaa3DTextures") && !nextChunk.includes("MSAA")) {
    console.warn("WARN: post-cut content does not look like MSAA setup:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("render plan cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

const part1 = src.slice(0, cutStart);
const planPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + planPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

mkdirSync("src/visual", { recursive: true });
writeFileSync("src/_monolith.tail.2.2.2.1.2.1.js", part1);
writeFileSync("src/visual/render-plan.js",         planPart);
writeFileSync("src/_monolith.tail.2.2.2.1.2.2.js", part2);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.1.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.1.2.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.2.2.2.1.2.1.js",
  "visual/render-plan.js",
  "_monolith.tail.2.2.2.1.2.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.tail.2.2.2.1.2.js")) {
  unlinkSync("src/_monolith.tail.2.2.2.1.2.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.6 split complete (pure relocation):");
console.log("  src/_monolith.tail.2.2.2.1.2.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/visual/render-plan.js        ", fmt(planPart.length).padStart(11), "bytes   <- _buildRenderPlan carved out");
console.log("  src/_monolith.tail.2.2.2.1.2.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                              ", fmt(part1.length + planPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.1.2.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-render-plan-before.html gamma-node-editor.html");
