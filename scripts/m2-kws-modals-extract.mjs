// M2.9 extractor: six-way split of the remaining
// src/_monolith.tail.2.2.2.2.2.2.js (KWS + keyboard + monitor +
// node editor + drawable modals + asset registry).
//
// All cuts land at `/* ===` / `/* ---` section-divider boundaries.
//
//   src/audio/keyword-spotter.js  (~22 KB / lines 1-510)
//       KeywordSpotter detection pipeline -- envelope + cosine-sim
//       transcript match + setter-index find + per-node teardown.
//
//   src/ui/keyboard-piano.js      (~21 KB / lines 511-928)
//       Keyboard-input driver (QWERTY -> MIDI) + on-screen piano
//       widget + per-key frequency override modal.
//
//   src/ui/monitor-controls.js    (~21 KB / lines 929-1442)
//       Monitor controls (Button + Slider host nodes) + slider
//       curve helpers + curve drawing.
//
//   src/ui/node-editor.js         (~106 KB / lines 1443-3880)
//       Per-node code editor (CodeMirror dual-pane raw/gdsp,
//       category detection, class-from-template / wrapper, override
//       save/revert), plus the in-flight node configurator modals:
//       climate config, planet map editor, tiling config, ramp
//       modal. Sits as one big block in source order.
//
//   src/ui/drawable-modals.js     (~134 KB / lines 3881-7102)
//       The drawable-shape editor modals all bundled together
//       (consecutive in source order):
//         * Drawable ADSR (EnvDraw)
//         * Automation lane (single + multi)
//         * Color curves (16-point LUT per channel)
//         * Piano roll
//         * Wavetable editor (single-cycle drawable waveform)
//         * Wavescan modal (3D-stacked 512-frame view)
//         * Sample waveform editor (SamplePlayer / Granular)
//
//   src/assets/registry.js        (~165 KB / lines 7103-11002)
//       Sample asset registry + IndexedDB persistence + Sprite
//       Creator / Sprite Studio modal + per-tilemap layer painter
//       + per-scatter-layer placement canvas + asset folder
//       creation + folder editor modal + audio file decode.
//
// Everything from `Smoke test` divider (line ~11003) onward stays
// in tail.2.2.2.2.2.2.js for a final mop-up commit.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

const sourcePath = "src/_monolith.tail.2.2.2.2.2.2.js";
const src = readFileSync(sourcePath, "utf8");

// Cut at the leading section divider line whose text contains the marker.
// Walks left to column 0.
function cutAt(src, marker, from = 0, dividerPrefix = "/* ----") {
  const anchor = src.indexOf(marker, from);
  if (anchor < 0) throw new Error(`anchor not found: ${marker}`);
  const open = src.lastIndexOf(dividerPrefix, anchor);
  if (open < 0) throw new Error(`${dividerPrefix} not found before: ${marker}`);
  let pos = open;
  while (pos > 0 && (src[pos - 1] === " " || src[pos - 1] === "\t")) pos--;
  return pos;
}

const cut1 = cutAt(src, "Keyboard-input driver");           // line 511
const cut2 = cutAt(src, "Monitor controls (Button + Slider", cut1);  // line 929
const cut3 = cutAt(src, "Per-node code editor", cut2, "/* ====");    // line 1443
const cut4 = cutAt(src, "Drawable ADSR (EnvDraw node) modal", cut3, "/* ====");  // line 3881
const cut5 = cutAt(src, "SAMPLE ASSET REGISTRY", cut4, "/* ====");   // line 7103
const cut6 = cutAt(src, "Smoke test", cut5);                          // line 11003

if (!(0 < cut1 && cut1 < cut2 && cut2 < cut3 && cut3 < cut4 && cut4 < cut5 && cut5 < cut6 && cut6 < src.length)) {
  throw new Error("cut points not strictly increasing");
}

console.log("M2.9 six-way split cut points:");
console.log("  cut1 (keyboard start): ", cut1, "line", lineOf(src, cut1));
console.log("  cut2 (monitor start):  ", cut2, "line", lineOf(src, cut2));
console.log("  cut3 (node-editor):    ", cut3, "line", lineOf(src, cut3));
console.log("  cut4 (drawable modals):", cut4, "line", lineOf(src, cut4));
console.log("  cut5 (asset registry): ", cut5, "line", lineOf(src, cut5));
console.log("  cut6 (smoke test):     ", cut6, "line", lineOf(src, cut6));

const kws        = src.slice(0,    cut1);
const keyboard   = src.slice(cut1, cut2);
const monitor    = src.slice(cut2, cut3);
const nodeEditor = src.slice(cut3, cut4);
const drawables  = src.slice(cut4, cut5);
const assets     = src.slice(cut5, cut6);
const rest       = src.slice(cut6);

const sum = kws.length + keyboard.length + monitor.length + nodeEditor.length + drawables.length + assets.length + rest.length;
if (sum !== src.length) throw new Error("slice math wrong: " + sum + " vs " + src.length);

mkdirSync("src/audio",  { recursive: true });
mkdirSync("src/ui",     { recursive: true });
mkdirSync("src/assets", { recursive: true });

writeFileSync("src/audio/keyword-spotter.js", kws);
writeFileSync("src/ui/keyboard-piano.js",     keyboard);
writeFileSync("src/ui/monitor-controls.js",   monitor);
writeFileSync("src/ui/node-editor.js",        nodeEditor);
writeFileSync("src/ui/drawable-modals.js",    drawables);
writeFileSync("src/assets/registry.js",       assets);
writeFileSync(sourcePath,                     rest);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.2.js");
if (idx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.2.2.2.js not found");
manifest.js.splice(idx, 0,
  "audio/keyword-spotter.js",
  "ui/keyboard-piano.js",
  "ui/monitor-controls.js",
  "ui/node-editor.js",
  "ui/drawable-modals.js",
  "assets/registry.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.9 six-way split complete (pure relocation):");
console.log("  src/audio/keyword-spotter.js     ", fmt(kws.length).padStart(11),        "bytes");
console.log("  src/ui/keyboard-piano.js         ", fmt(keyboard.length).padStart(11),   "bytes");
console.log("  src/ui/monitor-controls.js       ", fmt(monitor.length).padStart(11),    "bytes");
console.log("  src/ui/node-editor.js            ", fmt(nodeEditor.length).padStart(11), "bytes");
console.log("  src/ui/drawable-modals.js        ", fmt(drawables.length).padStart(11),  "bytes");
console.log("  src/assets/registry.js           ", fmt(assets.length).padStart(11),     "bytes");
console.log("  src/_monolith.tail.2.2.2.2.2.2.js", fmt(rest.length).padStart(11),       "bytes   (post-asset content)");
console.log("  ────────────────────────────────────────");
console.log("  sum                              ", fmt(sum).padStart(11), "bytes");
console.log("  original tail.2.2.2.2.2.2.js     ", fmt(src.length).padStart(11), "bytes");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-kws-modals-before.html gamma-node-editor.html");
