// M2.13 part B: middle.2.1.1 four-way split + tail.2.2.2.2.1 rename.
//
// Part B1: split src/_monolith.middle.2.1.1.js (~36 KB / ~867 lines)
// into four core/* files:
//
//   src/core/state-decl.js     (~2 KB / lines 1-36)
//       Central editor state declarations: state, selected, drag,
//       wire, nextId, collapsedCats, selectedSet, selectedGroupId,
//       view (panX/panY/zoom), panning, marquee, groupDrag,
//       spaceHeld, undoStack, redoStack.
//
//   src/core/undo-redo.js      (~12 KB / lines 37-266)
//       Undo / redo + selection + group operations:
//         UNDO_LIMIT, lastPushReason, lastPushTime,
//         snapshotState, restoreSnapshot, pushHistory,
//         undo, redo,
//         selectOne, addToSelection, selectAll, clearSelection,
//         groupSelection, ungroupSelection, deleteGroup,
//         duplicateGroup, toggleGroupCollapse, renameGroup.
//
//   src/core/state-helpers.js  (~5 KB / lines 268-413)
//       Lookup + init helpers:
//         applyView, resetView, screenToWorld,
//         uid (id generator), nodeById, defOf,
//         freshState (default state init), defaultRig (default
//         rig template applied to a fresh state).
//
//   src/rig/surface.js         (~17 KB / lines 414-867)
//       Rig surface geometry helpers (used by rig calibration +
//       warp pipeline):
//         _deriveSweetSpot, _migrateRigSurface,
//         _sweptProfilePolyline, _sweptSurfacePointGrid,
//         _raySweptSurfaceDistance, _sweptSurfaceBounds,
//         _screenProjectionPoint, _normalizeSurfaceForGizmo,
//         _sweptSurfacePreset.
//
// Part B2: wholesale rename of tail.2.2.2.2.1.js (~7 KB) to
// src/physics/controllers.js -- _tickThirdPersonCameras (TPS follow
// / orbit / over-shoulder / top-down / 2.5d / 2d-side) +
// _tickBlobControllers3D (camera-relative wired-RigidBody3D
// controller with ground-test ray + jump + plane lock).
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

// ── Part B1: middle.2.1.1 four-way split ──────────────────────────
const aPath = "src/_monolith.middle.2.1.1.js";
const aSrc = readFileSync(aPath, "utf8");

// cut1 -> at `function snapshotState` (start of undo-redo block).
const aCut1Anchor = aSrc.indexOf("function snapshotState");
if (aCut1Anchor < 0) throw new Error("`function snapshotState` not found");
// Walk back past the leading `// Undo/redo:` line comment + the
// `const UNDO_LIMIT = 200;` declaration that introduces this block.
// The undo-redo file starts at the `let undoStack = [];` line so
// snapshot includes the const + tracking state.
const undoStackIdx = aSrc.indexOf("let undoStack", 0);
if (undoStackIdx < 0) throw new Error("`let undoStack` not found");
// Walk back through the immediately-preceding comment lines.
let aCut1 = undoStackIdx;
// Walk back through the leading `// Undo/redo: ...` block (3 lines).
const undoCommentIdx = aSrc.lastIndexOf("// Undo/redo:", undoStackIdx);
if (undoCommentIdx >= 0) {
  let j = undoCommentIdx;
  while (j > 0 && (aSrc[j - 1] === " " || aSrc[j - 1] === "\t")) j--;
  aCut1 = j;
}

// cut2 -> at `function applyView` (start of view + lookups block).
const aCut2Anchor = aSrc.indexOf("function applyView");
if (aCut2Anchor < 0) throw new Error("`function applyView` not found");
const aCut2 = leadingCommentStart(aSrc, aCut2Anchor);

// cut3 -> at `function _deriveSweetSpot` (start of surface helpers).
const aCut3Anchor = aSrc.indexOf("function _deriveSweetSpot");
if (aCut3Anchor < 0) throw new Error("`function _deriveSweetSpot` not found");
const aCut3 = leadingCommentStart(aSrc, aCut3Anchor);

if (!(0 < aCut1 && aCut1 < aCut2 && aCut2 < aCut3 && aCut3 < aSrc.length)) {
  throw new Error("Part B1 cut points not strictly increasing");
}

console.log("Part B1: middle.2.1.1 four-way split:");
console.log("  cut1 (undo-redo start):     ", aCut1, "line", lineOf(aSrc, aCut1));
console.log("  cut2 (state-helpers start): ", aCut2, "line", lineOf(aSrc, aCut2));
console.log("  cut3 (rig/surface start):   ", aCut3, "line", lineOf(aSrc, aCut3));

const stateDecl    = aSrc.slice(0,    aCut1);
const undoRedo     = aSrc.slice(aCut1, aCut2);
const stateHelpers = aSrc.slice(aCut2, aCut3);
const rigSurface   = aSrc.slice(aCut3);

const aSum = stateDecl.length + undoRedo.length + stateHelpers.length + rigSurface.length;
if (aSum !== aSrc.length) throw new Error("Part B1 slice math wrong");

// ── Part B2: tail.2.2.2.2.1 wholesale rename ──────────────────────
const bPath = "src/_monolith.tail.2.2.2.2.1.js";
const bSrc = readFileSync(bPath, "utf8");
if (!bSrc.includes("_tickThirdPersonCameras") || !bSrc.includes("_tickBlobControllers3D")) {
  throw new Error("expected TPC + BlobController3D in controllers source");
}
console.log("");
console.log("Part B2: tail.2.2.2.2.1 wholesale rename:", bSrc.length.toLocaleString(), "bytes");

// ── Write outputs
mkdirSync("src/core",    { recursive: true });
mkdirSync("src/rig",     { recursive: true });
mkdirSync("src/physics", { recursive: true });

writeFileSync("src/core/state-decl.js",      stateDecl);
writeFileSync("src/core/undo-redo.js",       undoRedo);
writeFileSync("src/core/state-helpers.js",   stateHelpers);
writeFileSync("src/rig/surface.js",          rigSurface);
writeFileSync("src/physics/controllers.js",  bSrc);

// ── Update manifest
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const aIdx = manifest.js.indexOf("_monolith.middle.2.1.1.js");
if (aIdx < 0) throw new Error("manifest entry _monolith.middle.2.1.1.js not found");
manifest.js.splice(aIdx, 1,
  "core/state-decl.js",
  "core/undo-redo.js",
  "core/state-helpers.js",
  "rig/surface.js"
);

const bIdx = manifest.js.indexOf("_monolith.tail.2.2.2.2.1.js");
if (bIdx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.2.1.js not found");
manifest.js.splice(bIdx, 1, "physics/controllers.js");

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync(aPath)) unlinkSync(aPath);
if (existsSync(bPath)) unlinkSync(bPath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.13 Part B complete (pure relocation):");
console.log("  src/core/state-decl.js       ", fmt(stateDecl.length).padStart(11),    "bytes");
console.log("  src/core/undo-redo.js        ", fmt(undoRedo.length).padStart(11),     "bytes");
console.log("  src/core/state-helpers.js    ", fmt(stateHelpers.length).padStart(11), "bytes");
console.log("  src/rig/surface.js           ", fmt(rigSurface.length).padStart(11),   "bytes");
console.log("  src/physics/controllers.js   ", fmt(bSrc.length).padStart(11),         "bytes");
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-tail2-2-2-1-1-before.html gamma-node-editor.html");
