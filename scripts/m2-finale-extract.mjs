// M2.14 finale: consume the last two monolith fragments.
//
// Part A: split src/_monolith.head.js at the `/* === Node type
// registry === */` divider into:
//   src/core/preamble.js   (~0.3 KB / lines 1-9)
//       "use strict" + the APP_VERSION declaration (carries the
//       `/*__APP_VERSION__*/` placeholder that build.mjs replaces
//       with the current VERSION on every build).
//   src/nodes/colors.js    (~2 KB / lines 10-EOF)
//       Doc-comment header for the node type registry (per-entry
//       field reference) + `const COLOR = { ... }` -- the palette
//       dot + strip colors keyed by node category (oscillator /
//       noise / envelope / filter / delay / effect / analysis /
//       sample / convert / math / sink / visual / ai). Lives in
//       nodes/ since it's the chrome that nodes/registry.js consumes.
//
// Part B: wholesale rename of src/_monolith.middle.1.js (~1 KB) to
//   src/nodes/category-order.js
//       const CATEGORY_ORDER -- palette display order: Audio
//       (Oscillator / Sample / Noise / Envelope / Filter / Delay /
//       Effect / Analysis / Convert / Math), 3D scene (Scene /
//       Geometry / Material / Transform / Terrain), Game systems
//       (Physics / Game / UI / Sprite), Visual FX (Source /
//       Generator / Composite), Misc + legacy (AI / Visual / Sink /
//       User DSP). Any @gdsp-category not in this list still
//       renders via the fall-through path.
//
// After this commit there are no `_monolith.*.js` fragments left --
// the entire JS body is built from navigable src/<subsystem>/ files.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

// ── Part A: split head.js ────────────────────────────────────────
const aPath = "src/_monolith.head.js";
const aSrc = readFileSync(aPath, "utf8");

const cutAnchor = aSrc.indexOf("Node type registry");
if (cutAnchor < 0) throw new Error("`Node type registry` anchor not found in head.js");
const cutDivider = aSrc.lastIndexOf("/* ====", cutAnchor);
if (cutDivider < 0) throw new Error("opening `/* ====` for Node type registry not found");
let cut = cutDivider;
while (cut > 0 && (aSrc[cut - 1] === " " || aSrc[cut - 1] === "\t")) cut--;

console.log("Part A: head.js split at byte", cut, "line", lineOf(aSrc, cut));

const preamble = aSrc.slice(0,  cut);
const colors   = aSrc.slice(cut);
if (preamble.length + colors.length !== aSrc.length) throw new Error("A slice math wrong");

// ── Part B: rename middle.1.js ────────────────────────────────────
const bPath = "src/_monolith.middle.1.js";
const bSrc = readFileSync(bPath, "utf8");
if (!bSrc.includes("const CATEGORY_ORDER")) {
  throw new Error("expected const CATEGORY_ORDER in middle.1.js");
}
console.log("Part B: middle.1.js wholesale rename:", bSrc.length.toLocaleString(), "bytes");

// ── Write outputs
mkdirSync("src/core",  { recursive: true });
mkdirSync("src/nodes", { recursive: true });
writeFileSync("src/core/preamble.js",         preamble);
writeFileSync("src/nodes/colors.js",          colors);
writeFileSync("src/nodes/category-order.js",  bSrc);

// ── Update manifest
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const aIdx = manifest.js.indexOf("_monolith.head.js");
if (aIdx < 0) throw new Error("manifest entry _monolith.head.js not found");
manifest.js.splice(aIdx, 1, "core/preamble.js", "nodes/colors.js");

const bIdx = manifest.js.indexOf("_monolith.middle.1.js");
if (bIdx < 0) throw new Error("manifest entry _monolith.middle.1.js not found");
manifest.js.splice(bIdx, 1, "nodes/category-order.js");

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// ── Delete consumed source files
if (existsSync(aPath)) unlinkSync(aPath);
if (existsSync(bPath)) unlinkSync(bPath);

// Sanity: no _monolith.*.js should remain.
const fs = await import("node:fs");
const remaining = fs.readdirSync("src").filter(f => f.startsWith("_monolith") && f.endsWith(".js"));
if (remaining.length) {
  throw new Error("unexpected leftover monolith fragments: " + remaining.join(", "));
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.14 finale complete (pure relocation):");
console.log("  src/core/preamble.js          ", fmt(preamble.length).padStart(11), "bytes");
console.log("  src/nodes/colors.js           ", fmt(colors.length).padStart(11),   "bytes");
console.log("  src/nodes/category-order.js   ", fmt(bSrc.length).padStart(11),     "bytes");
console.log("");
console.log("No `_monolith.*.js` fragments remain. The entire JS body is now built");
console.log("from navigable src/<subsystem>/ files.");
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-finale-before.html gamma-node-editor.html");
