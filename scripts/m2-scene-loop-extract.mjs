// M2.6.17 + M2.6.18 extractor: two visual peels in one commit.
//
// M2.6.17 -- Rename tail.2.2.2.2.2.1.1.js wholesale as
//            src/visual/scene-builders.js. The file is now 100%
//            visual scene-builder code:
//              * 2D builders: _buildPlane, _buildSprite,
//                _buildTileSpriteOverlay, _buildParallaxLayer2D,
//                _buildSpriteScatter2D, _tilemap2dUsesTileset,
//                _buildTilemap2D
//              * Terrain noise + builders: _terrainHash family,
//                _terrainValueNoise / 3D, _terrainFBM / 3D,
//                _octavesForSpacing, _buildTerrain, _buildWater
//              * TerrainHorizon: _terrainHorizonMacroTile,
//                _buildTerrainHorizon
//              * Clouds3D: _clouds* chunking + builder
//              * TiledTerrain (archipelago): _tiledTerrain* family,
//                chunking + builder + erosion + island params
//              * 3D primitives: _buildTorus, _buildCylinder,
//                _buildCone
//              * _ensureSceneInstance (Scene instance allocator
//                + per-Scene scratch / slots / per-mesh uniforms)
//              * Two stranded planet helpers: _planetColorForHeight,
//                _planetSunDir -- candidates for a future move to
//                planet/runtime.js but keep their original byte
//                position here to preserve byte-identical.
//
// M2.6.18 -- Head-split tail.2.2.2.2.2.2.js at the OSC section
//            divider. Lines 1-~440 become src/visual/render-loop.js:
//              * Phase 6.1.7 render loop (rAF):
//                renderVisualFrame (per-frame entry point that calls
//                _encodeVisualGraph, blits the rig composite, ticks
//                the perf overlay), _visualRenderTick (the rAF
//                trampoline)
//              * _refreshLiveControlSetters, _pushLiveControlsToWorklet
//                (Phase 6.4.6 live-control mirror -- Live Mode pushes
//                slider edits to the worklet)
//            Everything from the OSC section divider onward stays in
//            tail.2.2.2.2.2.2.js (OSC, wire-side eval, live mode,
//            graph hidden, video capture, etc. -- separate peels).
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

// ── M2.6.17: rename scene-builders file ───────────────────────────
const aPath = "src/_monolith.tail.2.2.2.2.2.1.1.js";
const aSrc = readFileSync(aPath, "utf8");

if (!aSrc.includes("_buildPlane") || !aSrc.includes("_ensureSceneInstance")) {
  throw new Error("expected _buildPlane and _ensureSceneInstance in scene-builders source");
}

// ── M2.6.18: head-split render loop ───────────────────────────────
const bPath = "src/_monolith.tail.2.2.2.2.2.2.js";
const bSrc = readFileSync(bPath, "utf8");

// Cut at the OSC section divider (`Phase 7.x -- OSC` -- the next
// `/* ==== */` after _pushLiveControlsToWorklet).
const bCutAnchor = bSrc.indexOf("function _oscWsUrl");
if (bCutAnchor < 0) throw new Error("`function _oscWsUrl` not found in render-loop source");
const bCutDivider = bSrc.lastIndexOf("/* ====", bCutAnchor);
if (bCutDivider < 0) throw new Error("opening `/* ====` for OSC section not found");
let bCut = bCutDivider;
while (bCut > 0 && (bSrc[bCut - 1] === " " || bSrc[bCut - 1] === "\t")) bCut--;

const renderLoop = bSrc.slice(0, bCut);
const bRest      = bSrc.slice(bCut);
if (renderLoop.length + bRest.length !== bSrc.length) throw new Error("B slice math wrong");

console.log("M2.6.17: tail.2.2.2.2.2.1.1 wholesale rename ->",
            aSrc.length.toLocaleString(), "bytes");
console.log("M2.6.18: tail.2.2.2.2.2.2 head-split at byte",
            bCut, "line", lineOf(bSrc, bCut));
console.log("  render-loop:", renderLoop.length.toLocaleString(), "bytes");
console.log("  rest      :", bRest.length.toLocaleString(), "bytes");

// ── Write outputs
mkdirSync("src/visual", { recursive: true });
writeFileSync("src/visual/scene-builders.js", aSrc);
writeFileSync("src/visual/render-loop.js",    renderLoop);
writeFileSync(bPath,                          bRest);

// ── Update manifest
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const aIdx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.1.1.js");
if (aIdx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.2.2.1.1.js not found");
manifest.js.splice(aIdx, 1, "visual/scene-builders.js");

const bIdx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.2.js");
if (bIdx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.2.2.2.js not found");
manifest.js.splice(bIdx, 0, "visual/render-loop.js");

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync(aPath)) unlinkSync(aPath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.6.17 + M2.6.18 split complete (pure relocation):");
console.log("  src/visual/scene-builders.js  ", fmt(aSrc.length).padStart(11), "bytes   <- 2D/3D scene mesh builders + _ensureSceneInstance");
console.log("  src/visual/render-loop.js     ", fmt(renderLoop.length).padStart(11), "bytes   <- renderVisualFrame + _visualRenderTick + live controls");
console.log("  src/_monolith.tail.2.2.2.2.2.2", fmt(bRest.length).padStart(11), "bytes   (in-place rewrite, post-render-loop content)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-scene-loop-before.html gamma-node-editor.html");
