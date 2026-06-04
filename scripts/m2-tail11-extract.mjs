// M2.12 extractor: five-way split of src/_monolith.tail.1.1.js
// (~109 KB / ~2700 lines) at functional boundaries.
//
//   src/ui/browser-demos.js   (~30 KB / lines 1-738)
//       Demo browser + prefab browser + drop helpers + loadDemo:
//         * Demo browser: _deriveDemoTags, brRenderDemos,
//           brRenderDemoTypeRail, brRenderDemoGrid
//         * Prefab browser: _prefabBrowserCount, brRenderPrefabs,
//           brRenderPrefabTypeRail, brRenderPrefabGrid
//         * Canvas drop targets: _canvasDropPoint,
//           _dropServerAsset, _dropStockPrefab,
//           _hideAllOverlays, _cleanupBeforePatchSwitch
//         * loadDemo (the main demo load entry point)
//
//   src/ui/browser-assets.js  (~24 KB / lines 739-1303)
//       Asset browser:
//         brRenderAssets, brRenderSourceList, brRenderTypeRail,
//         brCollectAssets, brRenderAssetGrid, brAssetThumb,
//         brOpenConnectModal, brCloseConnectModal,
//         brWireAssetDropZone.
//
//   src/ui/palette.js         (~13 KB / lines 1304-1588)
//       Palette public entry points:
//         renderPalette, brRenderNodes (renderPalette delegates),
//         highlightMatch, escapeText, escapeAttr, addFromPalette,
//         _wirePatchCanvasAssetDrop.
//
//   src/ui/render.js          (~31 KB / lines 1589-2282)
//       Geometry + Render section:
//         NODE_W, portPos, isConnected (Geometry block),
//         render() main entry, makePort, portsCompatible,
//         SIGNAL_PORT_TYPES + VISUAL_PORT_TYPES, _snapRadiusFor,
//         findSnapPort, _pickSnap, _setWireSnap, _clearWireSnap,
//         flashRejectPort, wirePath, _expandConnectionToSelection,
//         _commitWireConnection, _maybeAutoRangeSlider, renderWires.
//
//   src/ui/props-pane.js      (~12 KB / lines 2283-EOF)
//       Properties pane section (group props + node props + the
//       per-port row editors that follow). This file ends at EOF
//       of tail.1.1.js.
//
// Source file fully consumed and deleted.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
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

const sourcePath = "src/_monolith.tail.1.1.js";
const src = readFileSync(sourcePath, "utf8");

// Anchors:
// cut1 -> at function brRenderAssets (start of asset browser)
const cut1Anchor = src.indexOf("function brRenderAssets");
if (cut1Anchor < 0) throw new Error("`function brRenderAssets` not found");
const cut1 = leadingCommentStart(src, cut1Anchor);

// cut2 -> at the "Public-facing entry points" subsection comment
const cut2Anchor = src.indexOf("Public-facing entry points", cut1);
if (cut2Anchor < 0) throw new Error("`Public-facing entry points` anchor not found");
// Walk back to the line-comment open `/* ─── ` (or `/* ----`).
let cut2Pos = src.lastIndexOf("/*", cut2Anchor);
if (cut2Pos < 0) throw new Error("opening /* for public entry points not found");
let cut2 = cut2Pos;
while (cut2 > 0 && (src[cut2 - 1] === " " || src[cut2 - 1] === "\t")) cut2--;

// cut3 -> at the "Geometry" section divider
const cut3Anchor = src.indexOf("* Geometry", cut2);
if (cut3Anchor < 0) throw new Error("`Geometry` anchor not found");
const cut3Divider = src.lastIndexOf("/* ====", cut3Anchor);
if (cut3Divider < 0) throw new Error("`/* ====` not found before Geometry");
let cut3 = cut3Divider;
while (cut3 > 0 && (src[cut3 - 1] === " " || src[cut3 - 1] === "\t")) cut3--;

// cut4 -> at the "Properties pane" section divider
const cut4Anchor = src.indexOf("Properties pane", cut3);
if (cut4Anchor < 0) throw new Error("`Properties pane` anchor not found");
const cut4Divider = src.lastIndexOf("/* ====", cut4Anchor);
if (cut4Divider < 0) throw new Error("`/* ====` not found before Properties pane");
let cut4 = cut4Divider;
while (cut4 > 0 && (src[cut4 - 1] === " " || src[cut4 - 1] === "\t")) cut4--;

if (!(0 < cut1 && cut1 < cut2 && cut2 < cut3 && cut3 < cut4 && cut4 < src.length)) {
  throw new Error("cut points not strictly increasing");
}

console.log("M2.12 five-way split cut points:");
console.log("  cut1 (assets start):     ", cut1, "line", lineOf(src, cut1));
console.log("  cut2 (palette start):    ", cut2, "line", lineOf(src, cut2));
console.log("  cut3 (geometry/render):  ", cut3, "line", lineOf(src, cut3));
console.log("  cut4 (props pane):       ", cut4, "line", lineOf(src, cut4));

const browserDemos  = src.slice(0,    cut1);
const browserAssets = src.slice(cut1, cut2);
const palette       = src.slice(cut2, cut3);
const render        = src.slice(cut3, cut4);
const propsPane     = src.slice(cut4);

const sum = browserDemos.length + browserAssets.length + palette.length + render.length + propsPane.length;
if (sum !== src.length) throw new Error("slice math wrong");

mkdirSync("src/ui", { recursive: true });
writeFileSync("src/ui/browser-demos.js",  browserDemos);
writeFileSync("src/ui/browser-assets.js", browserAssets);
writeFileSync("src/ui/palette.js",        palette);
writeFileSync("src/ui/render.js",         render);
writeFileSync("src/ui/props-pane.js",     propsPane);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.1.1.js");
if (idx < 0) throw new Error("manifest entry _monolith.tail.1.1.js not found");
manifest.js.splice(idx, 1,
  "ui/browser-demos.js",
  "ui/browser-assets.js",
  "ui/palette.js",
  "ui/render.js",
  "ui/props-pane.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync(sourcePath)) unlinkSync(sourcePath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.12 five-way split complete (pure relocation):");
console.log("  src/ui/browser-demos.js  ", fmt(browserDemos.length).padStart(11),  "bytes");
console.log("  src/ui/browser-assets.js ", fmt(browserAssets.length).padStart(11), "bytes");
console.log("  src/ui/palette.js        ", fmt(palette.length).padStart(11),       "bytes");
console.log("  src/ui/render.js         ", fmt(render.length).padStart(11),        "bytes");
console.log("  src/ui/props-pane.js     ", fmt(propsPane.length).padStart(11),     "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                      ", fmt(sum).padStart(11), "bytes");
console.log("  original tail.1.1.js     ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-tail11-before.html gamma-node-editor.html");
