// M2.6.12 through M2.6.16 extractor: splits the big remaining
// src/_monolith.tail.2.2.2.1.2.1.js (~209 KB / ~4690 lines) into
// five navigable visual files in one commit.
//
// Five-way split at section boundaries:
//
//   src/visual/projection.js   (~6 KB)
//       lines 1-249: projection-master-aspect, projection viewport
//       rect, _encodeRigComposite (the WebGPU rig composite encoder
//       pass -- rig-related but tightly coupled to visual pipeline
//       state, keeps with visual/), setRenderResolution,
//       _updateResolutionPill, _cycleRenderResolution,
//       _updateProjectionPill, _cycleProjectionMode,
//       setVisualFrozen, toggleVisualFreeze.
//
//   src/visual/perf-overlay.js (~11 KB)
//       lines 250-507: Phase 6.7.4 performance overlay --
//       _installPerfEncoderWrap, _resetPerfFrameCounters,
//       _tickPerfOverlay, _renderPerfOverlay, setPerfOverlayVisible,
//       togglePerfOverlay, _tickFpsReadout, _blitViewport,
//       smokeClearVisual, _fnv1a (hash helper).
//
//   src/visual/shader-cache.js (~24 KB)
//       lines 508-1022: SAB FFT bridge, audio + clock uniform
//       writers, shader bind-group layouts (standard / feedback /
//       composition / composition-feedback / video-source),
//       _getShaderPipeline (the WGSL -> pipeline cache),
//       _ensureShaderInstance + _disposeShaderInstance (per-VO
//       shader instance management).
//
//   src/visual/video-sources.js (~85 KB)
//       lines 1023-2966: ALL video / MediaPipe vision processing
//       in one self-contained block:
//         * Phase 7.1 video sources (_videoAudioSrcNodes,
//           _disposeVideoSource, _findUpstreamVideoSource, etc.)
//         * Phase 7.1b MediaPipe Tasks Vision (_allocateGpuInputCanvas,
//           _videoFitRect, hand / pose / face / hand-keyboard
//           landmarker overlay draws + value extractors,
//           _startMediapipeLoop, _disposeMediapipeNode)
//         * BlobTracker classical-CV blob detection
//
//   src/visual/scene-graph.js (~83 KB)
//       lines 2969-EOF: the visual-side graph evaluation and pass
//       encoding:
//         * _packSurfaceUniforms (rig surface params for
//           surface-aware shaders)
//         * _textCharToGlyphIdx, _buildTextShaderWGSL (Text node
//           shader generator)
//         * _writeShaderPreamble (per-VO uniform preamble writer)
//         * _coConsumerVOs, _renderWorldUvForVO (per-VO context
//           resolution)
//         * _resolveNodeParams (node param resolver)
//         * mat4 math family (Identity, Multiply, LookAt,
//           LookAtF64, _composeRtcModelView, Perspective,
//           Translate, Scale, RotateX/Y/Z, Ortho)
//         * _evaluateCamera, _syncOrthoCamera2D / 25D,
//           _resolveSceneCamera (camera evaluation)
//         * _buildTransformMatrix, _walkMeshChain,
//           _buildMaterialDescriptor (graph walkers)
//         * _expandLevel2DLayers, _expandTilemapLayerChunks
//           (Level2D / Tilemap2D mesh expansion)
//         * _resolveSceneMeshes (Scene mesh collection)
//         * _masterClockOutputValue, _nodeWithResolvedParams,
//           _resolveTextureInputLayer
//         * _encodeShaderFragPassForVO (per-VO shader-frag pass
//           encoder -- counterpart to visual/shader-frag-pass.js's
//           _encodeShaderFragPassForPlan, which dispatches into this
//           via the per-VO render schedule)
//         * _encodeLayerClear
//         * _encodeVisualGraph (the visual entry point that calls
//           _buildRenderPlan and runs each VO's schedule)
//
// Source file is fully consumed and deleted.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

// Walk back through whitespace + an immediately-preceding `/* ... */`
// block comment so the cut lands at column 0 of the comment's opening
// line.
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

const sourcePath = "src/_monolith.tail.2.2.2.1.2.1.js";
const src = readFileSync(sourcePath, "utf8");

// ── Find each cut point ────────────────────────────────────────────

// Cut A: at the Phase 6.7.4 Performance overlay section divider.
const cutAAnchor = src.indexOf("Phase 6.7.4 -- Performance overlay");
if (cutAAnchor < 0) throw new Error("Performance overlay anchor not found");
const cutADivider = src.lastIndexOf("/* ====", cutAAnchor);
if (cutADivider < 0) throw new Error("opening divider for perf overlay not found");
let cutA = cutADivider;
while (cutA > 0 && (src[cutA - 1] === " " || src[cutA - 1] === "\t")) cutA--;

// Cut B: at the "Shared bind-group layout" doc comment that begins
// the shader-cache cluster.
const cutBAnchor = src.indexOf("Shared bind-group layout for all built-in shader-frag nodes", cutA);
if (cutBAnchor < 0) throw new Error("bind-group layout anchor not found");
// Walk back to the `/*` that opens this comment.
const cutBCommentOpen = src.lastIndexOf("/*", cutBAnchor);
if (cutBCommentOpen < 0) throw new Error("opening `/*` for bind-group layout comment not found");
let cutB = cutBCommentOpen;
while (cutB > 0 && (src[cutB - 1] === " " || src[cutB - 1] === "\t")) cutB--;

// Cut C: at the Phase 7.1 Video sources section divider.
const cutCAnchor = src.indexOf("Phase 7.1 — Video sources", cutB);
if (cutCAnchor < 0) throw new Error("Phase 7.1 video sources anchor not found");
const cutCDivider = src.lastIndexOf("/* ====", cutCAnchor);
if (cutCDivider < 0) throw new Error("opening divider for video sources not found");
let cutC = cutCDivider;
while (cutC > 0 && (src[cutC - 1] === " " || src[cutC - 1] === "\t")) cutC--;

// Cut D: at the leading doc comment of `function _packSurfaceUniforms`.
const cutDAnchor = src.indexOf("function _packSurfaceUniforms", cutC);
if (cutDAnchor < 0) throw new Error("`function _packSurfaceUniforms` not found");
const cutD = leadingCommentStart(src, cutDAnchor);

// ── Sanity: cuts must be strictly increasing.
if (!(0 < cutA && cutA < cutB && cutB < cutC && cutC < cutD && cutD < src.length)) {
  throw new Error("cut points are not strictly increasing");
}

console.log("Five-way split cut points:");
console.log("  cutA (perf-overlay start):", cutA, "line", lineOf(src, cutA));
console.log("  cutB (shader-cache start):", cutB, "line", lineOf(src, cutB));
console.log("  cutC (video-sources start):", cutC, "line", lineOf(src, cutC));
console.log("  cutD (scene-graph start):",  cutD, "line", lineOf(src, cutD));

// ── Slice
const projection   = src.slice(0,    cutA);
const perfOverlay  = src.slice(cutA, cutB);
const shaderCache  = src.slice(cutB, cutC);
const videoSources = src.slice(cutC, cutD);
const sceneGraph   = src.slice(cutD);

const sum = projection.length + perfOverlay.length + shaderCache.length + videoSources.length + sceneGraph.length;
if (sum !== src.length) throw new Error("slice math wrong: " + sum + " vs " + src.length);

// ── Write outputs
mkdirSync("src/visual", { recursive: true });
writeFileSync("src/visual/projection.js",    projection);
writeFileSync("src/visual/perf-overlay.js",  perfOverlay);
writeFileSync("src/visual/shader-cache.js",  shaderCache);
writeFileSync("src/visual/video-sources.js", videoSources);
writeFileSync("src/visual/scene-graph.js",   sceneGraph);

// ── Update manifest
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.1.2.1.js");
if (idx < 0) throw new Error(`manifest entry not found: _monolith.tail.2.2.2.1.2.1.js`);
manifest.js.splice(idx, 1,
  "visual/projection.js",
  "visual/perf-overlay.js",
  "visual/shader-cache.js",
  "visual/video-sources.js",
  "visual/scene-graph.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync(sourcePath)) unlinkSync(sourcePath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.6.12 - M2.6.16 split complete (pure relocation):");
console.log("  src/visual/projection.js   ", fmt(projection.length).padStart(11),   "bytes");
console.log("  src/visual/perf-overlay.js ", fmt(perfOverlay.length).padStart(11),  "bytes");
console.log("  src/visual/shader-cache.js ", fmt(shaderCache.length).padStart(11),  "bytes");
console.log("  src/visual/video-sources.js", fmt(videoSources.length).padStart(11), "bytes");
console.log("  src/visual/scene-graph.js  ", fmt(sceneGraph.length).padStart(11),   "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                        ", fmt(sum).padStart(11), "bytes");
console.log("  original tail.2.2.2.1.2.1  ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-big-visual-before.html gamma-node-editor.html");
