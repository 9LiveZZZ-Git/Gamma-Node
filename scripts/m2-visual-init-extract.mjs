// M2.10 extractor: nine peels in one commit.
//
// Part A: split src/_monolith.tail.2.2.1.js (~183 KB / ~1900 lines)
// into 8 navigable files at section-divider boundaries:
//
//   src/audio/voice-input.js          (~5 KB / lines 3-137)
//       Voice input: tap to record, transcribe via Gemma 4 (E2B/E4B
//       native audio encoders) or bundled Whisper-tiny fallback.
//
//   src/ui/mobile-palette.js          (<1 KB / lines 138-149)
//       Mobile palette open/close toggle + close-on-tap-node.
//
//   src/ui/keyboard-shortcuts.js      (~2 KB / lines 151-180)
//       Tool keyboard shortcuts (V/D/W + AI smart-link), gated by
//       audio-preview playing state so KeyboardIn doesn't steal.
//
//   src/visual/core.js                (~22 KB / lines 181-677)
//       Phase 4 audio-preview doc + Phase 6.1 Visual subsystem doc
//       + the central `const Visual = { ... };` namespace
//       (per-device state singleton: device, context, canvas,
//       framebuffer / scratch / rig composite buffers, sample
//       count, perf state, mesh / sprite / sky pipeline caches,
//       atmosphere LUTs cache, scene instances, warp cache, etc.).
//
//   src/visual/framebuffer.js         (~25 KB / lines 678-1136)
//       Phase 6.1.4 render-target framebuffer + blit pipeline:
//       _allocateFramebuffer, blit shader module, blit bind group
//       layout, blit pipeline creation, scratch texture allocation.
//
//   src/visual/rig-composite-pipeline.js (~13 KB / lines 1137-1356)
//       Phase 6.5.9 / 6.5.10 rig composite pipeline -- the
//       WebGPU pipeline that samples the framebuffer texture
//       array + lays out N display layers onto the visible canvas
//       using the rig's previewMode (tile / theater / fisheye).
//
//   src/visual/warp-pipeline.js       (~18 KB / lines 1357-1698)
//       Phase 6.6.4 calibration warp pipeline -- per-display
//       quad-to-warp-mesh rendering for projector calibration
//       (each display's warp mesh maps NDC -> warped UV before the
//       final blit, so projector pose mismatch is corrected per
//       fragment).
//
//   src/visual/theater-pipeline.js    (~98 KB / lines 1699-EOF)
//       Phase 6.6.13 theater (3D-explorable) preview pipeline +
//       theater step camera + wire theater/FPC input + planet
//       surface Y / FPC sample ground / terrain collider helpers
//       + planet info + planet noise (value noise 3D, Swiss /
//       Jordan turbulence, octave rot mat, chunk noise offset) +
//       mesh-surface-pos / AGL helpers + wireGameInput +
//       Phase 8.A.x lifecycle / stage / prefab / pool / state
//       machine ticks (which were stranded at the end of this
//       file in source order). Mislabeled but pure relocation
//       preserves the original byte positions.
//
//   Source tail.2.2.1.js is fully consumed and deleted.
//
// Part B: collapse src/_monolith.tail.2.2.2.2.2.2.js (~38 KB) into
// src/ui/bootstrap.js wholesale:
//
//   src/ui/bootstrap.js               (~38 KB)
//       The last bits of bootstrap / dev infrastructure:
//         * Smoke test (initial paint verification)
//         * Hot-reload trigger
//         * Panel sizing / collapse / maximize
//           (savePanelPrefs, installResize, setPaletteCollapsed)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

// ── Part A: tail.2.2.1.js eight-way split ─────────────────────────
const aPath = "src/_monolith.tail.2.2.1.js";
const aSrc = readFileSync(aPath, "utf8");

function cutAtDivider(src, marker, from = 0, prefix = "/* ====") {
  const anchor = src.indexOf(marker, from);
  if (anchor < 0) throw new Error(`anchor not found: ${marker}`);
  const open = src.lastIndexOf(prefix, anchor);
  if (open < 0) throw new Error(`${prefix} not found before: ${marker}`);
  let pos = open;
  while (pos > 0 && (src[pos - 1] === " " || src[pos - 1] === "\t")) pos--;
  return pos;
}

const aCut1 = cutAtDivider(aSrc, "Mobile palette toggle");                    // line 138
const aCut2 = cutAtDivider(aSrc, "Tool keyboard shortcuts", aCut1);           // line 151
const aCut3 = cutAtDivider(aSrc, "Phase 4 — Real-time audio preview", aCut2); // line 181
// For Phase 6.x dividers, the same phase name appears as an inline
// comment inside the const Visual body earlier in the file, so use
// the full divider prefix as the anchor.
function cutAtFullDivider(src, fullMarker, from = 0) {
  const idx = src.indexOf(fullMarker, from);
  if (idx < 0) throw new Error(`full divider not found: ${fullMarker}`);
  let pos = idx;
  while (pos > 0 && (src[pos - 1] === " " || src[pos - 1] === "\t")) pos--;
  return pos;
}
const aCut4 = cutAtFullDivider(aSrc, "/* ----- Phase 6.1.4 —",        aCut3); // line 678
const aCut5 = cutAtFullDivider(aSrc, "/* ----- Phase 6.5.9",          aCut4); // line 1137
const aCut6 = cutAtFullDivider(aSrc, "/* ----- Phase 6.6.4 —",        aCut5); // line 1357
const aCut7 = cutAtFullDivider(aSrc, "/* ----- Phase 6.6.13 —",       aCut6); // line 1699

if (!(0 < aCut1 && aCut1 < aCut2 && aCut2 < aCut3 && aCut3 < aCut4 && aCut4 < aCut5 && aCut5 < aCut6 && aCut6 < aCut7 && aCut7 < aSrc.length)) {
  throw new Error("Part A cut points not strictly increasing");
}

console.log("Part A: tail.2.2.1.js eight-way split:");
console.log("  cut1 (mobile palette):    ", aCut1, "line", lineOf(aSrc, aCut1));
console.log("  cut2 (keyboard shortcuts):", aCut2, "line", lineOf(aSrc, aCut2));
console.log("  cut3 (visual core):       ", aCut3, "line", lineOf(aSrc, aCut3));
console.log("  cut4 (framebuffer):       ", aCut4, "line", lineOf(aSrc, aCut4));
console.log("  cut5 (rig composite):     ", aCut5, "line", lineOf(aSrc, aCut5));
console.log("  cut6 (warp pipeline):     ", aCut6, "line", lineOf(aSrc, aCut6));
console.log("  cut7 (theater pipeline):  ", aCut7, "line", lineOf(aSrc, aCut7));

const voiceInput     = aSrc.slice(0,     aCut1);
const mobilePalette  = aSrc.slice(aCut1, aCut2);
const keyShortcuts   = aSrc.slice(aCut2, aCut3);
const visualCore     = aSrc.slice(aCut3, aCut4);
const framebuffer    = aSrc.slice(aCut4, aCut5);
const rigComposite   = aSrc.slice(aCut5, aCut6);
const warpPipeline   = aSrc.slice(aCut6, aCut7);
const theaterPipeline= aSrc.slice(aCut7);

const aSum = voiceInput.length + mobilePalette.length + keyShortcuts.length + visualCore.length + framebuffer.length + rigComposite.length + warpPipeline.length + theaterPipeline.length;
if (aSum !== aSrc.length) throw new Error("A slice math wrong");

// ── Part B: tail.2.2.2.2.2.2.js wholesale to ui/bootstrap.js ──────
const bPath = "src/_monolith.tail.2.2.2.2.2.2.js";
const bSrc = readFileSync(bPath, "utf8");
if (!bSrc.includes("Smoke test") || !bSrc.includes("Panel sizing")) {
  throw new Error("expected smoke test + panel sizing in bootstrap source");
}
console.log("");
console.log("Part B: tail.2.2.2.2.2.2.js wholesale rename:", bSrc.length.toLocaleString(), "bytes");

// ── Write outputs
mkdirSync("src/audio",  { recursive: true });
mkdirSync("src/ui",     { recursive: true });
mkdirSync("src/visual", { recursive: true });

writeFileSync("src/audio/voice-input.js",                voiceInput);
writeFileSync("src/ui/mobile-palette.js",                mobilePalette);
writeFileSync("src/ui/keyboard-shortcuts.js",            keyShortcuts);
writeFileSync("src/visual/core.js",                      visualCore);
writeFileSync("src/visual/framebuffer.js",               framebuffer);
writeFileSync("src/visual/rig-composite-pipeline.js",    rigComposite);
writeFileSync("src/visual/warp-pipeline.js",             warpPipeline);
writeFileSync("src/visual/theater-pipeline.js",          theaterPipeline);

writeFileSync("src/ui/bootstrap.js", bSrc);

// ── Update manifest
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const aIdx = manifest.js.indexOf("_monolith.tail.2.2.1.js");
if (aIdx < 0) throw new Error("manifest entry _monolith.tail.2.2.1.js not found");
manifest.js.splice(aIdx, 1,
  "audio/voice-input.js",
  "ui/mobile-palette.js",
  "ui/keyboard-shortcuts.js",
  "visual/core.js",
  "visual/framebuffer.js",
  "visual/rig-composite-pipeline.js",
  "visual/warp-pipeline.js",
  "visual/theater-pipeline.js"
);

const bIdx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.2.js");
if (bIdx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.2.2.2.js not found");
manifest.js.splice(bIdx, 1, "ui/bootstrap.js");

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// ── Delete consumed source files
if (existsSync(aPath)) unlinkSync(aPath);
if (existsSync(bPath)) unlinkSync(bPath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.10 nine-peel split complete (pure relocation):");
console.log("  src/audio/voice-input.js              ", fmt(voiceInput.length).padStart(11), "bytes");
console.log("  src/ui/mobile-palette.js              ", fmt(mobilePalette.length).padStart(11), "bytes");
console.log("  src/ui/keyboard-shortcuts.js          ", fmt(keyShortcuts.length).padStart(11), "bytes");
console.log("  src/visual/core.js                    ", fmt(visualCore.length).padStart(11), "bytes   <- const Visual namespace");
console.log("  src/visual/framebuffer.js             ", fmt(framebuffer.length).padStart(11), "bytes");
console.log("  src/visual/rig-composite-pipeline.js  ", fmt(rigComposite.length).padStart(11), "bytes");
console.log("  src/visual/warp-pipeline.js           ", fmt(warpPipeline.length).padStart(11), "bytes");
console.log("  src/visual/theater-pipeline.js        ", fmt(theaterPipeline.length).padStart(11), "bytes");
console.log("  src/ui/bootstrap.js                   ", fmt(bSrc.length).padStart(11), "bytes   <- smoke + hot-reload + panel sizing");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-visual-init-before.html gamma-node-editor.html");
