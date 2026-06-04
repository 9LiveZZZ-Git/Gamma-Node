// M2.6.6 + M2.6.7 + M2.6.8 extractor: splits the now 100%-visual
// src/_monolith.tail.2.2.2.1.2.2.3.js into three navigable files:
//
//   src/visual/atmosphere.js     -- _ensureAtmosphereLUTs +
//                                   _renderAtmosphereLUTs (Sprint
//                                   7.6.b Tier C Hillaire-2020
//                                   atmosphere LUT renderer)
//   src/visual/mesh-cache.js     -- _ensureMeshBuffers, _computeLocalAABB,
//                                   _aabbInsideFrustum, _transformAABB,
//                                   _meshCacheKey (mesh GPU buffer
//                                   cache + frustum culling helpers)
//   src/visual/mesh-builders.js  -- _buildMeshData + every primitive
//                                   builder (DebugTriangle, Rope, Cloth,
//                                   SoftBody, GLB loader, Box, Sphere,
//                                   Capsule, etc.) + _ensureThree +
//                                   _ensureMatTextures
//
// Cuts (in source order):
//   * Cut #1: at `function _ensureMeshBuffers` -- atmosphere ends,
//             mesh cache begins.
//   * Cut #2: at `function _buildMeshData` -- mesh cache ends, mesh
//             builders begin.
//   * EOF marks the end of mesh builders.
//
// The source file is fully consumed and deleted.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

// Walk back from `idx` through any leading whitespace + an immediately-
// preceding `/* ... */` block comment so the cut lands at column 0 of
// the comment's opening line (lets each new file carry its doc comment).
function leadingCommentStart(src, idx) {
  let i = idx;
  while (i > 0 && (src[i - 1] === " " || src[i - 1] === "\t" || src[i - 1] === "\r" || src[i - 1] === "\n")) i--;
  if (i >= 2 && src[i - 1] === "/" && src[i - 2] === "*") {
    const open = src.lastIndexOf("/*", i - 3);
    if (open >= 0) {
      let j = open;
      while (j > 0 && (src[j - 1] === " " || src[j - 1] === "\t")) j--;
      return j;
    }
  }
  // No leading comment found -- cut at column 0 of the function's own line.
  let j = idx;
  while (j > 0 && (src[j - 1] === " " || src[j - 1] === "\t")) j--;
  return j;
}

const sourcePath = "src/_monolith.tail.2.2.2.1.2.2.3.js";
const src = readFileSync(sourcePath, "utf8");

const cut1Anchor = src.indexOf("function _ensureMeshBuffers");
if (cut1Anchor < 0) throw new Error("`function _ensureMeshBuffers` not found");
const cut1 = leadingCommentStart(src, cut1Anchor);

const cut2Anchor = src.indexOf("function _buildMeshData", cut1);
if (cut2Anchor < 0) throw new Error("`function _buildMeshData` not found");
const cut2 = leadingCommentStart(src, cut2Anchor);

const atmosphere = src.slice(0,    cut1);
const meshCache  = src.slice(cut1, cut2);
const builders   = src.slice(cut2);

if (atmosphere.length + meshCache.length + builders.length !== src.length) {
  throw new Error("slice math wrong");
}

console.log("Three-way split bounds:");
console.log("  atmosphere    : [0,", cut1, ")  -- line 1 to", lineOf(src, cut1), " -- ", atmosphere.length.toLocaleString(), "bytes");
console.log("  mesh-cache    : [", cut1, ",", cut2, ")  -- line", lineOf(src, cut1), "to", lineOf(src, cut2), " -- ", meshCache.length.toLocaleString(), "bytes");
console.log("  mesh-builders : [", cut2, ", EOF) -- line", lineOf(src, cut2), "to", lineOf(src, src.length), " -- ", builders.length.toLocaleString(), "bytes");

mkdirSync("src/visual", { recursive: true });
writeFileSync("src/visual/atmosphere.js",    atmosphere);
writeFileSync("src/visual/mesh-cache.js",    meshCache);
writeFileSync("src/visual/mesh-builders.js", builders);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.1.2.2.3.js");
if (idx < 0) throw new Error(`manifest entry not found: _monolith.tail.2.2.2.1.2.2.3.js`);
manifest.js.splice(idx, 1,
  "visual/atmosphere.js",
  "visual/mesh-cache.js",
  "visual/mesh-builders.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync(sourcePath)) unlinkSync(sourcePath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.6.6 + M2.6.7 + M2.6.8 split complete (pure relocation):");
console.log("  src/visual/atmosphere.js   ", fmt(atmosphere.length).padStart(11), "bytes   <- atmosphere LUT renderer");
console.log("  src/visual/mesh-cache.js   ", fmt(meshCache.length).padStart(11),  "bytes   <- mesh buffers + AABB + frustum + cache-key");
console.log("  src/visual/mesh-builders.js", fmt(builders.length).padStart(11),   "bytes   <- mesh-data + every primitive builder + GLB loader");
console.log("  ────────────────────────────────────────");
console.log("  sum                        ", fmt(atmosphere.length + meshCache.length + builders.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.1.2.2.3", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-mesh-cluster-before.html gamma-node-editor.html");
