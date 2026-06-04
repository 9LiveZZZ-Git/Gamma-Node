// M2.5.7 mop-up: carves the single _rigTileLayout helper out of
// src/_monolith.tail.2.2.2.1.js into src/rig/tile-layout.js.
//
// This is the last rig straggler identified in the modularization
// survey -- a small ~25-line helper that picks a rectangular tile
// layout for N displays (hand-tuned for the built-in template counts
// 1/2/3/4/6/8/12/16/20/24/26/32, generic ceil(sqrt(N)) fallback for
// arbitrary counts like MPCDI imports).
//
// One contiguous block bounded by:
//   START: leading doc comment `/* Pick a sensible rectangular tile
//          layout for N displays. ... */`
//   END  : end of `function _rigTileLayout(n)`. Next is
//          `_projectionMasterAspect` (general projection math used
//          by the rig composite -- not strictly rig, stays in tail).
//
// tail.2.2.2.1 is split at the cut into two new fragments:
//   src/_monolith.tail.2.2.2.1.1.js   (pre-helper bytes)
//   src/_monolith.tail.2.2.2.1.2.js   (post-helper bytes)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
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

const src = readFileSync("src/_monolith.tail.2.2.2.1.js", "utf8");

// START anchor: the leading doc comment unique to _rigTileLayout.
const startMarker = "/* Pick a sensible rectangular tile layout for N displays.";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor.
const endFuncIdx = src.indexOf("function _rigTileLayout", cutStart);
if (endFuncIdx < 0) throw new Error("`function _rigTileLayout` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check.
{
  const nextChunk = src.slice(cutEnd, cutEnd + 200);
  if (!nextChunk.includes("_projectionMasterAspect") && !nextChunk.includes("preview mode")) {
    console.warn("WARN: post-cut content does not look like _projectionMasterAspect:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("rig tile-layout helper bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

const part1 = src.slice(0, cutStart);
const helperPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + helperPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

mkdirSync("src/rig", { recursive: true });
writeFileSync("src/_monolith.tail.2.2.2.1.1.js", part1);
writeFileSync("src/rig/tile-layout.js",          helperPart);
writeFileSync("src/_monolith.tail.2.2.2.1.2.js", part2);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.1.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.1.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.2.2.2.1.1.js",
  "rig/tile-layout.js",
  "_monolith.tail.2.2.2.1.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.tail.2.2.2.1.js")) {
  unlinkSync("src/_monolith.tail.2.2.2.1.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.5.7 split complete (pure relocation):");
console.log("  src/_monolith.tail.2.2.2.1.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/rig/tile-layout.js         ", fmt(helperPart.length).padStart(11), "bytes   <- _rigTileLayout (last rig straggler)");
console.log("  src/_monolith.tail.2.2.2.1.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                            ", fmt(part1.length + helperPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.1.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-tile-layout-before.html gamma-node-editor.html");
