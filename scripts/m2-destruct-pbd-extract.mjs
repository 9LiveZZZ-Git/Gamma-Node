// M2.3.1 extractor: carves destructibles + PBD (ropes / cloth /
// soft-body) out of src/_monolith.tail.2.2.2.js into
// src/physics/destruct-pbd.js.
//
// One contiguous block bounded by:
//   START: `/* ── Sprint D.2 -- Voronoi fracture algorithm ──`
//          (subsection divider above `function _voronoiFracture`)
//   END  : end of `function _tickSoftBodies(...)`
//          (the last PBD tick; immediately followed by
//          `function _tickThirdPersonCameras`, which is camera not
//          physics).
//
// Contents:
//   - Sprint D.2: _voronoiFracture (fracture algorithm)
//   - Sprint D.4: _tickDestructibles3D (destructible-body tick)
//   - Phase 8.B.11: _ropeEndpoint (rope-attach helper)
//   - PBD ticks: _tickRopes, _tickCloths, _tickSoftBodies
//
// What stays in tail.2.2.2 for now:
//   - _buildSoftBodyMesh (line ~13551) -- a soft-body RENDERER, sits
//     ~500 lines upstream of this cluster with a non-physics sphere
//     mesh builder between them. Tight cut here keeps the relocation
//     pure; _buildSoftBodyMesh moves with the mesh/visual peel later.
//
// tail.2.2.2 is split at the cut into two new fragments:
//   src/_monolith.tail.2.2.2.1.js   (everything before the cluster)
//   src/_monolith.tail.2.2.2.2.js   (everything from _tickThirdPersonCameras on)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.
//
// Run from the repo root:  node scripts/m2-destruct-pbd-extract.mjs

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

const src = readFileSync("src/_monolith.tail.2.2.2.js", "utf8");

// START anchor: the Sprint D.2 Voronoi fracture divider.
const startMarker = "/* ── Sprint D.2 -- Voronoi fracture algorithm";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of `function _tickSoftBodies`. Next function is
// `_tickThirdPersonCameras` (camera, not physics).
const endFuncIdx = src.indexOf("function _tickSoftBodies", cutStart);
if (endFuncIdx < 0) throw new Error("`function _tickSoftBodies` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;

// Cross-check: next non-blank should be a `/* Phase 8.B.15` ThirdPersonCamera
// comment, then `function _tickThirdPersonCameras`.
{
  let probe = cutEnd;
  while (probe < src.length && (src[probe] === " " || src[probe] === "\t" || src[probe] === "\r" || src[probe] === "\n")) probe++;
  const nextChunk = src.slice(probe, probe + 120);
  if (!nextChunk.includes("ThirdPersonCamera") && !nextChunk.includes("_tickThirdPersonCameras")) {
    console.warn("WARN: post-cut content does not look like ThirdPersonCamera:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("destruct+PBD cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 70)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 40)));

// ── Slice
const part1 = src.slice(0, cutStart);
const physicsPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + physicsPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/physics", { recursive: true });
writeFileSync("src/_monolith.tail.2.2.2.1.js", part1);
writeFileSync("src/physics/destruct-pbd.js",   physicsPart);
writeFileSync("src/_monolith.tail.2.2.2.2.js", part2);

// Update manifest.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.2.2.2.1.js",
  "physics/destruct-pbd.js",
  "_monolith.tail.2.2.2.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.tail.2.2.2.js")) {
  unlinkSync("src/_monolith.tail.2.2.2.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.3.1 split complete (pure relocation):");
console.log("  src/_monolith.tail.2.2.2.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/physics/destruct-pbd.js  ", fmt(physicsPart.length).padStart(11), "bytes   <- destructibles + PBD carved out");
console.log("  src/_monolith.tail.2.2.2.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                          ", fmt(part1.length + physicsPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-destruct-pbd-before.html gamma-node-editor.html");
