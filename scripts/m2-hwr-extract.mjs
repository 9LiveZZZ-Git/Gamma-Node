// M2.2 extractor: carves the handwriting subsystem out of
// src/_monolith.tail.2.js into src/hwr/index.js.
//
// The HWR cluster is bounded by:
//   START: the `/* Sprint 5.handwriting-multimonitor` doc comment
//          (line ~3120 of tail.2.js) -- the touchscreen-popup block
//   END  : the closing `}` of `function tryCreateFromLabel`
//          (line ~6338) -- the last HWR helper before
//          `/* === Voice input === */`.
//
// Contents (one big contiguous block, no non-HWR interleaving):
//   - Touchscreen popup window controls (_toggleToolMenu,
//     _ensureTouchChannel, _openTouchscreenWindow,
//     _buildTouchscreenHtml, _pushTouchControlsSnapshot, touch handlers)
//   - HW.1 debug image overlay
//   - Ink state: clearInk / renderInk and the ink-layer pointer
//     handlers + Recognize / Cancel / Clear button listeners
//   - HW.5 correction chips
//   - Recognize cascade: _recognizeInkStrokes, getTesseract,
//     tesseractRecognize, $P recognizer + templates, strokesToPng,
//     VLM applyVisionResult, detectShape, levenshtein,
//     _tryCreateChain, _matchTypeName, tryCreateFromLabel
//
// What stays in tail.2:
//   - Tool DOM refs (ink, inkFinalize, toolBtns, canvasWrap)
//   - inkBox / inkStrokes / inkCurrent / drawingBox / boxStart vars
//   - setTool() (handles select/connect/draw, used by all tools)
//   - Tool button click bindings
//   These are tool/canvas infrastructure used by HWR but not
//   HWR-specific. clearInk is called from setTool ⇒ relies on
//   global-scope hoisting in the concatenation bundle.
//
// tail.2 is split at the cut into two new fragments:
//   src/_monolith.tail.2.1.js   (everything before the HWR cluster)
//   src/_monolith.tail.2.2.js   (everything from Voice input on)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.
//
// Run from the repo root:  node scripts/m2-hwr-extract.mjs

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

// ── Brace counter with string/template/comment skipping (same as M1/M2.1).

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

const src = readFileSync("src/_monolith.tail.2.js", "utf8");

// START anchor: the Sprint-5 touchscreen-multimonitor doc comment.
// This appears exactly once in the codebase as a header block above
// `_toolMenu = document.getElementById("tool-draw-menu-popup");`.
const startMarker = "/* Sprint 5.handwriting-multimonitor";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

// Sanity: marker should already be at column 0; walk left through
// any column-leading whitespace just in case.
let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of `function tryCreateFromLabel(...)`.
// This is the last HWR helper. The next thing is the
// `/* === Voice input === */` section divider.
const endFuncIdx = src.indexOf("function tryCreateFromLabel", cutStart);
if (endFuncIdx < 0) throw new Error("`function tryCreateFromLabel` not found");
const endBrace = funcEnd(src, endFuncIdx);

// Walk forward to include the trailing newline so the next chunk
// starts cleanly at column 0 of the line after `}`.
let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;

// Cross-check: the next non-whitespace content after cutEnd should be
// the Voice section divider, NOT something HWR-shaped. Bail loudly if
// the anchors slipped.
{
  let probe = cutEnd;
  while (probe < src.length && (src[probe] === " " || src[probe] === "\t" || src[probe] === "\r" || src[probe] === "\n")) probe++;
  const nextChunk = src.slice(probe, probe + 80);
  if (!nextChunk.includes("Voice input") && !nextChunk.includes("/* ===")) {
    console.warn("WARN: post-cut content does not look like the Voice section:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("hwr cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 60)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 40)));

// ── Slice
const part1 = src.slice(0, cutStart);
const hwrPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + hwrPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/hwr", { recursive: true });
writeFileSync("src/_monolith.tail.2.1.js", part1);
writeFileSync("src/hwr/index.js",          hwrPart);
writeFileSync("src/_monolith.tail.2.2.js", part2);

// Update manifest: replace `_monolith.tail.2.js` with three entries.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.2.1.js",
  "hwr/index.js",
  "_monolith.tail.2.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Remove the now-replaced _monolith.tail.2.js
if (existsSync("src/_monolith.tail.2.js")) {
  unlinkSync("src/_monolith.tail.2.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.2 split complete (pure relocation):");
console.log("  src/_monolith.tail.2.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/hwr/index.js         ", fmt(hwrPart.length).padStart(11), "bytes   <- HWR carved out");
console.log("  src/_monolith.tail.2.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                      ", fmt(part1.length + hwrPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-hwr-before.html gamma-node-editor.html");
