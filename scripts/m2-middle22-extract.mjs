// M2.12 part B: middle.2.2 four-way split + tail.1.2 wholesale rename.
//
// Part B1: split src/_monolith.middle.2.2.js into four files at
// section boundaries:
//   src/rig/templates.js     (~17 KB / lines 1-310)
//       Edge-blend defaults (_defaultEdgeBlend, _migrateEdgeBlend),
//       _makeDisplay (display constructor), const RIG_TEMPLATES
//       (the built-in rig templates: AlloSphere 26-display, etc.),
//       _evenAzimuthRing (azimuth-ring helper), applyRigTemplate
//       (apply a template, rebuilding state.rig.displays).
//
//   src/core/state.js        (~24 KB / lines 311-525)
//       Core state mutations + DOM refs:
//         * Group helpers: groupOfNode, groupById,
//           isInCollapsedGroup, groupBounds, computeGroupPorts
//         * reset (clear state to defaults / demo)
//         * makeNode (the central node spawner -- normalizes type,
//           assigns id, materializes default params)
//         * DOM ref consts (udspList, udspSource, udspStatus, tabs,
//           copyBtn, canvasWorld, marqueeEl, viewHud)
//         * getUdspText / setUdspText (User DSP textarea getters)
//
//   src/ui/node-browser.js   (~43 KB / lines 526-1289)
//       Node browser (palette categorization + search):
//         * brDeriveTags (extract tags from node name + def)
//         * _BR_HOST_NODES / _BR_DRAW_NODES / _BR_CAT_META /
//           _VISUAL_SUBCAT / _VISUAL_ROUTE / _BR_NEW_NODES
//         * _brCatMeta, _deriveNodeCategory
//         * brState (the browser state singleton with search + cat
//           filter + drawer)
//         * brParseSearch, brNodeMatches, brHighlight
//         * brRenderRail, brRenderNodes, brRenderDrawer,
//           brSwitchTab.
//
//   src/assets/parallax-bg.js (~14 KB / lines 1290-EOF)
//       Default parallax-background asset bootstrap:
//         PARALLAX_BG_VERSION (bump on art change),
//         _ensureParallaxBgAssets (idempotent on DOMContentLoaded),
//         _makeParallaxSkySprite / Mountains / Forest generators.
//
// Part B2: wholesale rename of src/_monolith.tail.1.2.js to
// src/ui/render-props.js (which holds renderGroupProps + renderProps
// -- the Properties pane implementation; pairs with the existing
// ui/props-pane.js header that lives upstream in the manifest).
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

// ── Part B1: middle.2.2.js four-way split ─────────────────────────
const aPath = "src/_monolith.middle.2.2.js";
const aSrc = readFileSync(aPath, "utf8");

// cut1 -> at `function groupOfNode` (start of group helpers).
const aCut1Anchor = aSrc.indexOf("function groupOfNode");
if (aCut1Anchor < 0) throw new Error("`function groupOfNode` not found");
const aCut1 = leadingCommentStart(aSrc, aCut1Anchor);

// cut2 -> at the User DSP / node-browser break (line ~526). The
// section divider preceding node-browser code is "Node browser".
const aCut2Anchor = aSrc.indexOf("function brDeriveTags", aCut1);
if (aCut2Anchor < 0) throw new Error("`function brDeriveTags` not found");
// Walk back to the preceding `/* ====` section divider.
const aCut2DivIdx = aSrc.lastIndexOf("/* ====", aCut2Anchor);
if (aCut2DivIdx < 0) throw new Error("section divider before brDeriveTags not found");
let aCut2 = aCut2DivIdx;
while (aCut2 > 0 && (aSrc[aCut2 - 1] === " " || aSrc[aCut2 - 1] === "\t")) aCut2--;

// cut3 -> at PARALLAX_BG_VERSION (default-assets parallax bg).
const aCut3Anchor = aSrc.indexOf("const PARALLAX_BG_VERSION", aCut2);
if (aCut3Anchor < 0) throw new Error("`const PARALLAX_BG_VERSION` not found");
const aCut3 = leadingCommentStart(aSrc, aCut3Anchor);

if (!(0 < aCut1 && aCut1 < aCut2 && aCut2 < aCut3 && aCut3 < aSrc.length)) {
  throw new Error("Part B1 cut points not strictly increasing");
}

console.log("Part B1: middle.2.2.js four-way split:");
console.log("  cut1 (state start):       ", aCut1, "line", lineOf(aSrc, aCut1));
console.log("  cut2 (node-browser start):", aCut2, "line", lineOf(aSrc, aCut2));
console.log("  cut3 (parallax-bg start): ", aCut3, "line", lineOf(aSrc, aCut3));

const rigTemplates = aSrc.slice(0,    aCut1);
const coreState    = aSrc.slice(aCut1, aCut2);
const nodeBrowser  = aSrc.slice(aCut2, aCut3);
const parallaxBg   = aSrc.slice(aCut3);

const aSum = rigTemplates.length + coreState.length + nodeBrowser.length + parallaxBg.length;
if (aSum !== aSrc.length) throw new Error("Part B1 slice math wrong");

// ── Part B2: tail.1.2.js wholesale rename ─────────────────────────
const bPath = "src/_monolith.tail.1.2.js";
const bSrc = readFileSync(bPath, "utf8");
if (!bSrc.includes("function renderGroupProps") || !bSrc.includes("function renderProps")) {
  throw new Error("expected renderGroupProps + renderProps in render-props source");
}

console.log("");
console.log("Part B2: tail.1.2.js wholesale rename:", bSrc.length.toLocaleString(), "bytes");

// ── Write outputs
mkdirSync("src/rig",    { recursive: true });
mkdirSync("src/core",   { recursive: true });
mkdirSync("src/ui",     { recursive: true });
mkdirSync("src/assets", { recursive: true });

writeFileSync("src/rig/templates.js",      rigTemplates);
writeFileSync("src/core/state.js",         coreState);
writeFileSync("src/ui/node-browser.js",    nodeBrowser);
writeFileSync("src/assets/parallax-bg.js", parallaxBg);
writeFileSync("src/ui/render-props.js",    bSrc);

// ── Update manifest
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const aIdx = manifest.js.indexOf("_monolith.middle.2.2.js");
if (aIdx < 0) throw new Error("manifest entry _monolith.middle.2.2.js not found");
manifest.js.splice(aIdx, 1,
  "rig/templates.js",
  "core/state.js",
  "ui/node-browser.js",
  "assets/parallax-bg.js"
);

const bIdx = manifest.js.indexOf("_monolith.tail.1.2.js");
if (bIdx < 0) throw new Error("manifest entry _monolith.tail.1.2.js not found");
manifest.js.splice(bIdx, 1, "ui/render-props.js");

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync(aPath)) unlinkSync(aPath);
if (existsSync(bPath)) unlinkSync(bPath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.12 Part B complete (pure relocation):");
console.log("  src/rig/templates.js      ", fmt(rigTemplates.length).padStart(11), "bytes");
console.log("  src/core/state.js         ", fmt(coreState.length).padStart(11),    "bytes");
console.log("  src/ui/node-browser.js    ", fmt(nodeBrowser.length).padStart(11),  "bytes");
console.log("  src/assets/parallax-bg.js ", fmt(parallaxBg.length).padStart(11),   "bytes");
console.log("  src/ui/render-props.js    ", fmt(bSrc.length).padStart(11),         "bytes");
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-tail11-before.html gamma-node-editor.html");
