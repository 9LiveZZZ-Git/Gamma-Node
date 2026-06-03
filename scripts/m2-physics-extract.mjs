// M2.3 extractor: carves the Rapier 2D + 3D physics core out of
// src/_monolith.tail.2.2.js into src/physics/rapier.js.
//
// The Rapier core is one contiguous block bounded by:
//   START: `/* ── Phase 8.B.1 -- Rapier 2D physics tick ──`
//          (subsection divider above `let _rapierModule = null;`)
//   END  : end of `function _findWiredBodyNodePort3D(...)`
//          (the last 3D-physics helper, immediately before
//          `function _tickGameInputs` which is game-input, not physics).
//
// Contents:
//   - Rapier 2D loader: _ensureRapier
//   - 2D wired-body helpers: _findWiredBodyNode, _findWiredBodyNodePort
//   - 2D tick: _tickPhysics (~622 lines)
//   - Phase 8.B.6 subsection divider
//   - Rapier 3D loader: _ensureRapier3D
//   - 3D tick: _tickPhysics3D (~688 lines)
//   - 3D wired-body helper: _findWiredBodyNodePort3D
//
// What stays in tail.2.2:
//   - Game inputs (_tickGameInputs) -- consumes physics state but is
//     game-logic, not physics-engine integration. Defer to a later
//     game/ peel.
//   - Destructibles (_voronoiFracture, _tickDestructibles3D) -- lives
//     ~14k lines downstream, separate cluster. Defer to M2.3.1.
//   - PBD ropes/cloth/soft (_tickRopes, _tickCloths, _tickSoftBodies)
//     -- also in the downstream cluster. Defer to M2.3.1.
//
// tail.2.2 is split at the cut into two new fragments:
//   src/_monolith.tail.2.2.1.js   (everything before the Rapier core)
//   src/_monolith.tail.2.2.2.js   (everything from _tickGameInputs on)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.
//
// Run from the repo root:  node scripts/m2-physics-extract.mjs

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

// ── Brace counter with string/template/comment skipping (shared with
// M1/M2.1/M2.2 extractors).

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

const src = readFileSync("src/_monolith.tail.2.2.js", "utf8");

// START anchor: the Phase 8.B.1 subsection divider.
const startMarker = "/* ── Phase 8.B.1 -- Rapier 2D physics tick";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of `function _findWiredBodyNodePort3D`. This function
// is the last 3D-physics helper; immediately after comes
// `function _tickGameInputs` (game-input, not physics).
const endFuncIdx = src.indexOf("function _findWiredBodyNodePort3D", cutStart);
if (endFuncIdx < 0) throw new Error("`function _findWiredBodyNodePort3D` not found");
const endBrace = funcEnd(src, endFuncIdx);

// Include trailing newline so next chunk starts cleanly at column 0.
let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;

// Cross-check: the next non-blank line after the cut should be
// `function _tickGameInputs`. Bail loudly if anchors slipped.
{
  let probe = cutEnd;
  while (probe < src.length && (src[probe] === " " || src[probe] === "\t" || src[probe] === "\r" || src[probe] === "\n")) probe++;
  const nextChunk = src.slice(probe, probe + 80);
  if (!nextChunk.includes("_tickGameInputs")) {
    console.warn("WARN: post-cut content does not start with _tickGameInputs:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("physics cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 60)));
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
writeFileSync("src/_monolith.tail.2.2.1.js", part1);
writeFileSync("src/physics/rapier.js",       physicsPart);
writeFileSync("src/_monolith.tail.2.2.2.js", part2);

// Update manifest: replace `_monolith.tail.2.2.js` with three entries.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.2.2.1.js",
  "physics/rapier.js",
  "_monolith.tail.2.2.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.tail.2.2.js")) {
  unlinkSync("src/_monolith.tail.2.2.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.3 split complete (pure relocation):");
console.log("  src/_monolith.tail.2.2.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/physics/rapier.js      ", fmt(physicsPart.length).padStart(11), "bytes   <- Rapier 2D+3D core carved out");
console.log("  src/_monolith.tail.2.2.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                        ", fmt(part1.length + physicsPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-physics-before.html gamma-node-editor.html");
