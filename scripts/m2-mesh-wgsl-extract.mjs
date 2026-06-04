// M2.6.1 extractor: carves the giant `const _MESH_WGSL = `...`;`
// shader module string (Sprint 7.5.3a/c -- 3D mesh pipeline shader)
// out of src/_monolith.tail.2.2.2.1.2.2.js into
// src/visual/shaders/mesh.wgsl.js.
//
// Per the modularization plan §3, big WGSL const strings move into
// src/visual/shaders/*.wgsl.js so they're navigable as shader source
// rather than buried inside the JS that uses them.
//
// One contiguous block bounded by:
//   START: file start (byte 0) -- the Sprint 7.5.3a section divider
//          that introduces the mesh pipeline shader.
//   END  : the `;` that closes the `const _MESH_WGSL = ` ... `;`
//          declaration (the backtick template literal's closing
//          backtick, the `;`, and trailing newline). Next is the
//          `_ensureMsaa3DTextures` function's leading doc comment.
//
// Contents (~3,458 lines / ~150 KB):
//   * Sprint 7.5.3a + 7.5.3c doc-comment block explaining the mesh
//     pipeline (vertex layout, depth/blend state, bind groups,
//     per-Scene vs per-draw uniform split)
//   * const _MESH_WGSL = `...`;
//       - struct Light, struct PerScene, struct PerDraw
//       - one vertex shader + three fragment entry points (unlit,
//         phong, physical) sharing a single compiled module
//       - up to 4 lights per Scene (directional / point / spot)
//         dispatched via pos.w
//       - HDRI env sampling, fog + ACES tonemap
//
// What stays in tail.2.2.2.1.2.2 (candidates for further M2.6.x):
//   * MSAA / perf / ShaderMat / mesh pipelines / sprite pipelines /
//     sky pipeline / atmosphere LUTs / mesh-buffer caching / mesh
//     builders -- all in this same file, follow-up peels target
//     `visual/mesh-pipelines.js`, `visual/sprite.js`, `visual/sky.js`,
//     `visual/atmosphere.js`, `visual/mesh-builders.js`, plus more
//     `visual/shaders/*.wgsl.js` files for _SPRITE_WGSL (line ~4371)
//     and _ATM_LUT_WGSL (line ~4710).
//
// Since the cluster starts at byte 0, no pre-cluster fragment is
// created. tail.2.2.2.1.2.2.js is rewritten in place with just the
// post-cluster bytes; visual/shaders/mesh.wgsl.js is inserted before
// it in the manifest.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync
} from "node:fs";

// ── Template-aware scanner.

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

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

// ── Boundaries

const src = readFileSync("src/_monolith.tail.2.2.2.1.2.2.js", "utf8");

if (!src.startsWith("/* =====")) {
  throw new Error("source file does not start with the Sprint 7.5.3a section divider");
}
const cutStart = 0;

// Find `const _MESH_WGSL = ` then the opening backtick, then walk the
// template to its closing backtick.
const declIdx = src.indexOf("const _MESH_WGSL");
if (declIdx < 0) throw new Error("`const _MESH_WGSL` not found");
const eqIdx = src.indexOf("=", declIdx);
if (eqIdx < 0) throw new Error("`=` after `const _MESH_WGSL` not found");
// Skip whitespace + newline to the opening backtick.
let openTickIdx = eqIdx + 1;
while (openTickIdx < src.length && (src[openTickIdx] === " " || src[openTickIdx] === "\t" || src[openTickIdx] === "\r" || src[openTickIdx] === "\n")) openTickIdx++;
if (src[openTickIdx] !== "`") throw new Error("expected opening backtick after `=`");
const closeTickIdx = skipTemplate(src, openTickIdx + 1); // returns index past closing backtick

let cutEnd = closeTickIdx;
// Skip the closing `;`.
if (src[cutEnd] === ";") cutEnd++;
// Walk past trailing newlines so the next chunk starts cleanly at
// the next doc comment / function.
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check: next non-blank should be the MSAA doc comment or
// `_ensureMsaa3DTextures`.
{
  const nextChunk = src.slice(cutEnd, cutEnd + 200);
  if (!nextChunk.includes("_ensureMsaa3DTextures") && !nextChunk.includes("MSAA")) {
    console.warn("WARN: post-cut content does not look like MSAA setup:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("_MESH_WGSL cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

const wgslPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (wgslPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

mkdirSync("src/visual/shaders", { recursive: true });
writeFileSync("src/visual/shaders/mesh.wgsl.js",   wgslPart);
writeFileSync("src/_monolith.tail.2.2.2.1.2.2.js", part2);

// Insert before the existing tail entry.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.1.2.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.1.2.2.js` not found");
manifest.js.splice(idx, 0, "visual/shaders/mesh.wgsl.js");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.6.1 split complete (pure relocation):");
console.log("  src/visual/shaders/mesh.wgsl.js   ", fmt(wgslPart.length).padStart(11), "bytes   <- mesh shader WGSL carved out");
console.log("  src/_monolith.tail.2.2.2.1.2.2.js ", fmt(part2.length).padStart(11), "bytes   (in-place rewrite)");
console.log("  ────────────────────────────────────────");
console.log("  sum                               ", fmt(wgslPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.1.2.2.js      ", fmt(src.length).padStart(11), "bytes");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-mesh-wgsl-before.html gamma-node-editor.html");
