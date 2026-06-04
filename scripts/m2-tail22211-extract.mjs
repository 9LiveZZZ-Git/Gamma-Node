// M2.13 extractor: five-way split of src/_monolith.tail.2.2.2.1.1.js
// (~115 KB / ~2529 lines) at function-leading-comment boundaries.
//
//   src/physics/game-inputs.js   (~25 KB / lines 1-553)
//       Game inputs + 2D level / tilemap / pickup helpers:
//         * _tickGameInputs (KeyAxis2D, PlatformerBody2D,
//           AnimationState2D, PickupCollector, LevelGoal2D)
//         * _findWiredOrFirst (port wire resolver)
//         * Level2D / Tilemap2D parsing: _level2dParsedLayers,
//           _level2dCollidableTilemap, _tilemapCellsMatching
//         * _bodyAabb, _aabbHitsCell (overlap helpers)
//         * _tickPickupCollectors, _tickEdgeCounts,
//           _tickLevelGoals
//
//   src/visual/fp-cameras.js     (~22 KB / lines 554-1024)
//       FP (First-Person) cameras:
//         * _parseFrameSpec (parses "1280x720" etc.)
//         * _tickFPCameras (top-level dispatch)
//         * _tickFPCameraWalk (ground-walk camera with collider
//           response)
//         * _rotAroundUnit (axis-angle rotation helper)
//         * _tickFPCameraFlight (free-flight camera with
//           planet-local up)
//
//   src/visual/minimap-altimeter.js (~33 KB / lines 1025-1733)
//       Planet minimap + altimeter HUDs:
//         * _ensureMinimapCanvas, _renderPlanetMinimap,
//           _drawMinimapCameraOverlay, _tickMinimapNodes
//         * _ensureAltimeterCanvas, _ensureFlyToPanel,
//           _flyToGoClicked, _flyToModeClicked,
//           _tickAltimeterNodes
//
//   src/ui/hud-nodes.js          (~33 KB / lines 1734-2438)
//       HUD + UI nodes + leaderboards + touch pads:
//         * _ensureHudTextCanvas
//         * _ensureUiCanvas, _uiNodeIsInteractive,
//           _wireUiButtonEvents, _resolveUiAnchorPos,
//           _runCustomRender
//         * UI default draws: _drawUiButtonDefault,
//           _drawUiTextDefault, _drawUiPanelDefault,
//           _drawUiSliderDefault
//         * Leaderboards: _leaderboardLoad, _leaderboardSave,
//           _drawLeaderboardDefault, _tickLeaderboards
//         * _tickUiNodes, _tickHudTextNodes,
//           _resolveHudTextValue, _wireTouchPads
//
//   src/visual/theater-pass.js   (~3 KB / lines 2439-EOF)
//       _encodeTheaterPass (theater preview's per-frame pass
//       encoder, used by visual/theater-pipeline.js's pose update),
//       _rebuildRigCompositeBindGroup (small helper that rebinds
//       the rig composite bind group after a framebuffer reallocate).
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

const sourcePath = "src/_monolith.tail.2.2.2.1.1.js";
const src = readFileSync(sourcePath, "utf8");

// Cuts at function-leading-comment boundaries.
const cut1Anchor = src.indexOf("function _parseFrameSpec");
if (cut1Anchor < 0) throw new Error("`function _parseFrameSpec` not found");
const cut1 = leadingCommentStart(src, cut1Anchor);

const cut2Anchor = src.indexOf("function _ensureMinimapCanvas", cut1);
if (cut2Anchor < 0) throw new Error("`function _ensureMinimapCanvas` not found");
const cut2 = leadingCommentStart(src, cut2Anchor);

const cut3Anchor = src.indexOf("function _ensureHudTextCanvas", cut2);
if (cut3Anchor < 0) throw new Error("`function _ensureHudTextCanvas` not found");
const cut3 = leadingCommentStart(src, cut3Anchor);

const cut4Anchor = src.indexOf("function _encodeTheaterPass", cut3);
if (cut4Anchor < 0) throw new Error("`function _encodeTheaterPass` not found");
const cut4 = leadingCommentStart(src, cut4Anchor);

if (!(0 < cut1 && cut1 < cut2 && cut2 < cut3 && cut3 < cut4 && cut4 < src.length)) {
  throw new Error("cut points not strictly increasing");
}

console.log("M2.13 five-way split cut points:");
console.log("  cut1 (fp-cameras):       ", cut1, "line", lineOf(src, cut1));
console.log("  cut2 (minimap-altimeter):", cut2, "line", lineOf(src, cut2));
console.log("  cut3 (hud-nodes):        ", cut3, "line", lineOf(src, cut3));
console.log("  cut4 (theater-pass):     ", cut4, "line", lineOf(src, cut4));

const gameInputs = src.slice(0,    cut1);
const fpCameras  = src.slice(cut1, cut2);
const minimap    = src.slice(cut2, cut3);
const hudNodes   = src.slice(cut3, cut4);
const theaterPass= src.slice(cut4);

const sum = gameInputs.length + fpCameras.length + minimap.length + hudNodes.length + theaterPass.length;
if (sum !== src.length) throw new Error("slice math wrong");

mkdirSync("src/physics", { recursive: true });
mkdirSync("src/visual",  { recursive: true });
mkdirSync("src/ui",      { recursive: true });

writeFileSync("src/physics/game-inputs.js",        gameInputs);
writeFileSync("src/visual/fp-cameras.js",          fpCameras);
writeFileSync("src/visual/minimap-altimeter.js",   minimap);
writeFileSync("src/ui/hud-nodes.js",               hudNodes);
writeFileSync("src/visual/theater-pass.js",        theaterPass);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.1.1.js");
if (idx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.1.1.js not found");
manifest.js.splice(idx, 1,
  "physics/game-inputs.js",
  "visual/fp-cameras.js",
  "visual/minimap-altimeter.js",
  "ui/hud-nodes.js",
  "visual/theater-pass.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync(sourcePath)) unlinkSync(sourcePath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.13 five-way split complete (pure relocation):");
console.log("  src/physics/game-inputs.js       ", fmt(gameInputs.length).padStart(11), "bytes");
console.log("  src/visual/fp-cameras.js         ", fmt(fpCameras.length).padStart(11),  "bytes");
console.log("  src/visual/minimap-altimeter.js  ", fmt(minimap.length).padStart(11),    "bytes");
console.log("  src/ui/hud-nodes.js              ", fmt(hudNodes.length).padStart(11),   "bytes");
console.log("  src/visual/theater-pass.js       ", fmt(theaterPass.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                              ", fmt(sum).padStart(11), "bytes");
console.log("  original tail.2.2.2.1.1.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-tail2-2-2-1-1-before.html gamma-node-editor.html");
