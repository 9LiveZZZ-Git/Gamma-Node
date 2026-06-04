// M2.8 extractor: five-way split of the post-OSC head of
// src/_monolith.tail.2.2.2.2.2.2.js into navigable concern files.
//
// Cuts at major section dividers (all `/* ====` style):
//
//   src/visual/render-loop-controls.js  (~2 KB / lines 1-51)
//       _tickVideoFileTrigs (VideoFile trigger events per frame),
//       startVisualRenderLoop / stopVisualRenderLoop (rAF start/stop --
//       small helpers that pair with visual/render-loop.js's main loop)
//
//   src/ui/modes.js                     (~5 KB / lines 52-167)
//       Phase 6.7.5 Live Mode + Phase 6.7.1 Graph hidden toggle:
//         isLiveMode / setLiveMode / toggleLiveMode / _scheduleLiveIdleFade
//         isGraphHidden / setGraphHidden / toggleGraphHidden
//
//   src/ui/capture.js                   (~37 KB / lines 168-902)
//       All capture concerns:
//         * Phase 6.7.2 Capture frame to PNG (with HUD compositing)
//         * Phase 6.7.3 Capture video to WebM via MediaRecorder
//         * v0.2.19 Per-display PNG capture
//         * v0.2.21 Per-display video recording
//
//   src/persistence/export.js           (~24 KB / lines 903-1437)
//       v0.2.21 Offline WAV render (audioBufferToWavBlob, MP3 via
//       lamejs) + v0.2.23 Standalone HTML export + v0.2.19 Export
//       center modal control.
//
//   src/audio/preview.js                (~111 KB / lines 1438-3794)
//       Phase 6.5.1 Audio bridge (SAB between worklet + main) +
//       Phase 4 in-browser wasm-clang preview compile + meter loop:
//         * Preview progress UI (show/hide/start/end/stage/sub/tick/finish)
//         * Compile pipeline (collect exposed setters, wrap for
//           preview, render build pane, progress mapping, tar parse,
//           ensure compile worker)
//         * Meter (setMeterMode, startMeterLoop / stopMeterLoop,
//           _updateVideoAudioGains, disconnectMic)
//
// Everything from `KeywordSpotter detection pipeline` (line ~3795)
// onward stays in tail.2.2.2.2.2.2.js for later peels.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

const sourcePath = "src/_monolith.tail.2.2.2.2.2.2.js";
const src = readFileSync(sourcePath, "utf8");

// Cut at the leading section divider whose comment contains the given marker.
function cutAtDivider(src, marker, from = 0) {
  const anchor = src.indexOf(marker, from);
  if (anchor < 0) throw new Error(`anchor not found: ${marker}`);
  const open = src.lastIndexOf("/* ====", anchor);
  if (open < 0) throw new Error(`/* ==== not found before: ${marker}`);
  let pos = open;
  while (pos > 0 && (src[pos - 1] === " " || src[pos - 1] === "\t")) pos--;
  return pos;
}

const cut1 = cutAtDivider(src, "Live Mode");           // line 52
const cut2 = cutAtDivider(src, "Capture frame", cut1); // line 168
const cut3 = cutAtDivider(src, "Offline audio render", cut2); // line 903
const cut4 = cutAtDivider(src, "Audio bridge", cut3);  // line 1438
const cut5 = cutAtDivider(src, "KeywordSpotter detection pipeline", cut4); // line 3795

if (!(0 < cut1 && cut1 < cut2 && cut2 < cut3 && cut3 < cut4 && cut4 < cut5 && cut5 < src.length)) {
  throw new Error("cut points not strictly increasing");
}

console.log("post-OSC five-way split cut points:");
console.log("  cut1 (live-mode start):", cut1, "line", lineOf(src, cut1));
console.log("  cut2 (capture start):  ", cut2, "line", lineOf(src, cut2));
console.log("  cut3 (export start):   ", cut3, "line", lineOf(src, cut3));
console.log("  cut4 (preview start):  ", cut4, "line", lineOf(src, cut4));
console.log("  cut5 (KWS start):      ", cut5, "line", lineOf(src, cut5));

const renderLoopCtrl = src.slice(0,    cut1);
const modes          = src.slice(cut1, cut2);
const capture        = src.slice(cut2, cut3);
const exportFns      = src.slice(cut3, cut4);
const preview        = src.slice(cut4, cut5);
const rest           = src.slice(cut5);

const sum = renderLoopCtrl.length + modes.length + capture.length + exportFns.length + preview.length + rest.length;
if (sum !== src.length) throw new Error("slice math wrong");

mkdirSync("src/visual",      { recursive: true });
mkdirSync("src/ui",          { recursive: true });
mkdirSync("src/persistence", { recursive: true });
mkdirSync("src/audio",       { recursive: true });

writeFileSync("src/visual/render-loop-controls.js", renderLoopCtrl);
writeFileSync("src/ui/modes.js",                    modes);
writeFileSync("src/ui/capture.js",                  capture);
writeFileSync("src/persistence/export.js",          exportFns);
writeFileSync("src/audio/preview.js",               preview);
writeFileSync(sourcePath,                           rest);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.2.js");
if (idx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.2.2.2.js not found");
manifest.js.splice(idx, 0,
  "visual/render-loop-controls.js",
  "ui/modes.js",
  "ui/capture.js",
  "persistence/export.js",
  "audio/preview.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.8 five-way split complete (pure relocation):");
console.log("  src/visual/render-loop-controls.js", fmt(renderLoopCtrl.length).padStart(11), "bytes   <- video trigs + start/stop render loop");
console.log("  src/ui/modes.js                   ", fmt(modes.length).padStart(11),          "bytes   <- Live Mode + Graph hidden");
console.log("  src/ui/capture.js                 ", fmt(capture.length).padStart(11),        "bytes   <- frame PNG + video WebM + per-display");
console.log("  src/persistence/export.js         ", fmt(exportFns.length).padStart(11),      "bytes   <- WAV render + HTML export + export modal");
console.log("  src/audio/preview.js              ", fmt(preview.length).padStart(11),        "bytes   <- audio bridge + preview compile + meter");
console.log("  src/_monolith.tail.2.2.2.2.2.2.js ", fmt(rest.length).padStart(11),           "bytes   (in-place rewrite, post-preview content)");
console.log("  ────────────────────────────────────────");
console.log("  sum                               ", fmt(sum).padStart(11), "bytes");
console.log("  original tail.2.2.2.2.2.2.js      ", fmt(src.length).padStart(11), "bytes");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-postosc-before.html gamma-node-editor.html");
