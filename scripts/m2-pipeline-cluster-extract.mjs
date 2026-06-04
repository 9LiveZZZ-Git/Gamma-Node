// M2.6.9 + M2.6.10 + M2.6.11 extractor: consumes the two remaining
// tail.2.2.2.1.2.2.x fragments that sit between the WGSL shader files
// in the manifest.
//
// tail.2.2.2.1.2.2.1.js is split at the Sprint 7.5.3c ShaderMat
// section divider:
//   src/visual/perf.js       (~16 KB)
//       lines 1-182: MSAA texture management + perf overlay +
//       per-frame perf counters (§bonus-perf-diag for the SVT/DEM
//       transition slow zone)
//   src/visual/pipelines.js  (~26 KB)
//       lines 183-end: ShaderMat preset library + mesh bind-group
//       layout + env-texture / HDRI parsing + mesh pipeline cache
//
// tail.2.2.2.1.2.2.2.js is renamed wholesale (the file is now 100%
// sprite + sky WebGPU render pipelines):
//   src/visual/sprite-sky.js  (~9 KB)
//       _ensureSpriteBindGroupLayout, _ensureSpriteShaderModule,
//       _ensureSpritePipeline, _ensureSpriteSampler,
//       _ensureSpriteInstance, _ensureSkyPipeline
//
// Both temporary tail fragments are then fully consumed and deleted.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

// ── A: split tail.2.2.2.1.2.2.1.js ─────────────────────────────────
const aPath = "src/_monolith.tail.2.2.2.1.2.2.1.js";
const aSrc = readFileSync(aPath, "utf8");

// Cut at the Sprint 7.5.3c -- ShaderMat preset library section divider.
const aCutAnchor = aSrc.indexOf("Sprint 7.5.3c -- ShaderMat preset library");
if (aCutAnchor < 0) throw new Error("ShaderMat section divider not found in tail.2.2.2.1.2.2.1.js");
// Walk back to the `/* ====` that opens the section comment.
const aDividerOpen = aSrc.lastIndexOf("/* ====", aCutAnchor);
if (aDividerOpen < 0) throw new Error("opening `/* ====` not found for ShaderMat section");
let aCut = aDividerOpen;
while (aCut > 0 && (aSrc[aCut - 1] === " " || aSrc[aCut - 1] === "\t")) aCut--;

const perf      = aSrc.slice(0,    aCut);
const pipelines = aSrc.slice(aCut);
if (perf.length + pipelines.length !== aSrc.length) throw new Error("A slice math wrong");

console.log("tail.2.2.2.1.2.2.1 split at byte", aCut, "line", lineOf(aSrc, aCut));
console.log("  perf      :", perf.length.toLocaleString(), "bytes");
console.log("  pipelines :", pipelines.length.toLocaleString(), "bytes");

// ── B: rename tail.2.2.2.1.2.2.2.js wholesale ─────────────────────
const bPath = "src/_monolith.tail.2.2.2.1.2.2.2.js";
const bSrc = readFileSync(bPath, "utf8");
if (!bSrc.includes("_ensureSpritePipeline") || !bSrc.includes("_ensureSkyPipeline")) {
  throw new Error("expected sprite + sky pipelines in tail.2.2.2.1.2.2.2.js");
}
console.log("tail.2.2.2.1.2.2.2 rename: ", bSrc.length.toLocaleString(), "bytes");

// ── Write outputs
mkdirSync("src/visual", { recursive: true });
writeFileSync("src/visual/perf.js",       perf);
writeFileSync("src/visual/pipelines.js",  pipelines);
writeFileSync("src/visual/sprite-sky.js", bSrc);

// ── Update manifest
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const aIdx = manifest.js.indexOf("_monolith.tail.2.2.2.1.2.2.1.js");
if (aIdx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.1.2.2.1.js not found");
manifest.js.splice(aIdx, 1, "visual/perf.js", "visual/pipelines.js");

const bIdx = manifest.js.indexOf("_monolith.tail.2.2.2.1.2.2.2.js");
if (bIdx < 0) throw new Error("manifest entry _monolith.tail.2.2.2.1.2.2.2.js not found");
manifest.js.splice(bIdx, 1, "visual/sprite-sky.js");

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// ── Delete consumed source files
if (existsSync(aPath)) unlinkSync(aPath);
if (existsSync(bPath)) unlinkSync(bPath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.6.9 + M2.6.10 + M2.6.11 split complete (pure relocation):");
console.log("  src/visual/perf.js      ", fmt(perf.length).padStart(11), "bytes   <- MSAA + perf overlay + perf counters");
console.log("  src/visual/pipelines.js ", fmt(pipelines.length).padStart(11), "bytes   <- ShaderMat + mesh bind groups + HDRI + mesh pipeline");
console.log("  src/visual/sprite-sky.js", fmt(bSrc.length).padStart(11), "bytes   <- sprite + sky WebGPU render pipelines");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-pipeline-cluster-before.html gamma-node-editor.html");
