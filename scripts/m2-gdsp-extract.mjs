// M2.1.1 extractor: carves the .gdsp / User DSP subsystem out of
// src/_monolith.middle.js into src/nodes/gdsp.js.
//
// The cluster is bounded by two section dividers in middle.js:
//   START: /* === User DSP === */
//   END  : the next /* ====...  (which is the State section divider)
// Cluster contents:
//   /* === User DSP === */ section divider
//   const USER_DSP_SOURCES = {};
//   const USER_DSP_META = {};
//   function parseGdsp(source)
//   function buildUserDspDef(source)
//   function registerUserDsp(source)
//   function unregisterUserDsp(name)
//   function stripGdspHeader(source)
//   function exportGdsp(name)
//
// _monolith.middle.js is split at the cut into two new fragments:
//   src/_monolith.middle.1.js   (everything before the User DSP section)
//   src/_monolith.middle.2.js   (everything from /* === State === */ on)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.
//
// Run from the repo root:  node scripts/m2-gdsp-extract.mjs

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

const src = readFileSync("src/_monolith.middle.js", "utf8");

// Locate the User DSP section divider. The actual marker is the line
// `/* =========================================================================`
// immediately above `* User DSP`. We search for that distinctive pair.
const userDspMarker = src.indexOf("* User DSP");
if (userDspMarker < 0) throw new Error("`* User DSP` marker not found");
// Walk backward to the `/* ====` that opens this comment block.
const dividerOpen = src.lastIndexOf("/* ====", userDspMarker);
if (dividerOpen < 0) throw new Error("opening `/* ====` not found for User DSP section");
// Cut at column 0 of that line.
let cutStart = dividerOpen;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// Locate the END: the next `/* ====` AFTER `function exportGdsp` -- this
// is the State section divider.
const exportGdspIdx = src.indexOf("function exportGdsp", cutStart);
if (exportGdspIdx < 0) throw new Error("`function exportGdsp` not found");
const nextDivider = src.indexOf("/* ====", exportGdspIdx);
if (nextDivider < 0) throw new Error("next `/* ====` divider not found after exportGdsp");
let cutEnd = nextDivider;
// Walk backward through any leading whitespace on the divider's line so
// the cut ends just before that line (the divider stays with the next chunk).
while (cutEnd > 0 && (src[cutEnd - 1] === " " || src[cutEnd - 1] === "\t")) cutEnd--;

function lineOf(idx) { return src.slice(0, idx).split("\n").length; }

console.log("gdsp cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 60)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 40)));

// ── Slice
const middlePart1 = src.slice(0, cutStart);
const gdspPart    = src.slice(cutStart, cutEnd);
const middlePart2 = src.slice(cutEnd);

if (middlePart1.length + gdspPart.length + middlePart2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/nodes", { recursive: true });
writeFileSync("src/_monolith.middle.1.js", middlePart1);
writeFileSync("src/nodes/gdsp.js",         gdspPart);
writeFileSync("src/_monolith.middle.2.js", middlePart2);

// Update manifest: replace `_monolith.middle.js` with three entries.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.middle.js");
if (idx < 0) throw new Error("manifest entry `_monolith.middle.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.middle.1.js",
  "nodes/gdsp.js",
  "_monolith.middle.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Remove the now-replaced _monolith.middle.js
if (existsSync("src/_monolith.middle.js")) {
  unlinkSync("src/_monolith.middle.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.1.1 split complete (pure relocation):");
console.log("  src/_monolith.middle.1.js", fmt(middlePart1.length).padStart(11), "bytes");
console.log("  src/nodes/gdsp.js        ", fmt(gdspPart.length).padStart(11), "bytes   <- .gdsp pipeline carved out");
console.log("  src/_monolith.middle.2.js", fmt(middlePart2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                      ", fmt(middlePart1.length + gdspPart.length + middlePart2.length).padStart(11), "bytes");
console.log("  original middle.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-gdsp-before.html gamma-node-editor.html");
