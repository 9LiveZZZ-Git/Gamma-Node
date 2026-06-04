// M2.7 extractor: three-way split of the OSC + wire-eval region at
// the head of src/_monolith.tail.2.2.2.2.2.2.js into:
//
//   src/audio/osc-in.js     -- OSC input core (WS client +
//                              pattern dispatcher + capture / learn
//                              + mirror-value helpers)
//   src/core/wire-eval.js   -- JS-side wire value reader (called
//                              every frame to read non-audio-rate
//                              wire values) + math template eval
//   src/audio/osc-out.js    -- OSC output ticker + status pill +
//                              patch-change hook
//
// Cuts at section / function boundaries:
//   cut1 = at the doc comment for `function _readWireJsSideValue`
//          (where wire-eval begins, after the OSC-input cluster)
//   cut2 = at the doc comment for `function _tickOscOut`
//          (where OSC-output resumes, after wire-eval)
//   cut3 = at the doc comment for `function _tickVideoFileTrigs`
//          (the next concern after the OSC-output cluster)
//
// tail.2.2.2.2.2.2.js is split at these three points into:
//   [0, cut1)     -> src/audio/osc-in.js
//   [cut1, cut2)  -> src/core/wire-eval.js
//   [cut2, cut3)  -> src/audio/osc-out.js
//   [cut3, EOF)   -> src/_monolith.tail.2.2.2.2.2.2.js  (in-place rewrite)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

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
  let j = idx;
  while (j > 0 && (src[j - 1] === " " || src[j - 1] === "\t")) j--;
  return j;
}

const sourcePath = "src/_monolith.tail.2.2.2.2.2.2.js";
const src = readFileSync(sourcePath, "utf8");

const cut1Anchor = src.indexOf("function _readWireJsSideValue");
if (cut1Anchor < 0) throw new Error("`function _readWireJsSideValue` not found");
const cut1 = leadingCommentStart(src, cut1Anchor);

const cut2Anchor = src.indexOf("function _tickOscOut", cut1);
if (cut2Anchor < 0) throw new Error("`function _tickOscOut` not found");
const cut2 = leadingCommentStart(src, cut2Anchor);

const cut3Anchor = src.indexOf("function _tickVideoFileTrigs", cut2);
if (cut3Anchor < 0) throw new Error("`function _tickVideoFileTrigs` not found");
const cut3 = leadingCommentStart(src, cut3Anchor);

if (!(0 < cut1 && cut1 < cut2 && cut2 < cut3 && cut3 < src.length)) {
  throw new Error("cut points are not strictly increasing");
}

console.log("OSC + wire-eval split cut points:");
console.log("  cut1 (wire-eval start):", cut1, "line", lineOf(src, cut1));
console.log("  cut2 (osc-out start):  ", cut2, "line", lineOf(src, cut2));
console.log("  cut3 (post-osc start): ", cut3, "line", lineOf(src, cut3));

const oscIn    = src.slice(0,    cut1);
const wireEval = src.slice(cut1, cut2);
const oscOut   = src.slice(cut2, cut3);
const rest     = src.slice(cut3);

if (oscIn.length + wireEval.length + oscOut.length + rest.length !== src.length) {
  throw new Error("slice math wrong");
}

mkdirSync("src/audio", { recursive: true });
mkdirSync("src/core",  { recursive: true });
writeFileSync("src/audio/osc-in.js",   oscIn);
writeFileSync("src/core/wire-eval.js", wireEval);
writeFileSync("src/audio/osc-out.js",  oscOut);
writeFileSync(sourcePath,              rest);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.2.js");
if (idx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.2.2.2.js not found");
manifest.js.splice(idx, 0,
  "audio/osc-in.js",
  "core/wire-eval.js",
  "audio/osc-out.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.7 three-way split complete (pure relocation):");
console.log("  src/audio/osc-in.js               ", fmt(oscIn.length).padStart(11),    "bytes   <- OSC input core");
console.log("  src/core/wire-eval.js             ", fmt(wireEval.length).padStart(11), "bytes   <- JS-side wire value reader + math template eval");
console.log("  src/audio/osc-out.js              ", fmt(oscOut.length).padStart(11),   "bytes   <- OSC output ticker + pill + patch hook");
console.log("  src/_monolith.tail.2.2.2.2.2.2.js ", fmt(rest.length).padStart(11),     "bytes   (in-place rewrite, post-OSC content)");
console.log("  ────────────────────────────────────────");
console.log("  sum                               ", fmt(oscIn.length + wireEval.length + oscOut.length + rest.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.2.2.2.js      ", fmt(src.length).padStart(11), "bytes");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-osc-wire-before.html gamma-node-editor.html");
