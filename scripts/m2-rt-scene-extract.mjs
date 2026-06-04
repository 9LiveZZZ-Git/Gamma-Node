// M2.6.4 extractor: carves the RayTracedScene encoder + WebSocket
// client (Sprint 7.5.6.a part 2d) out of
// src/_monolith.tail.2.2.2.2.2.1.2.js into src/visual/rt-scene.js.
//
// One contiguous block bounded by:
//   START: file start (byte 0) -- the `Sprint 7.5.6.a part 2d --
//          RayTracedScene encoder + WebSocket client` section divider.
//   END  : end of `function _encodeRtScenePass(...)`. Next function
//          is `_encodeShaderFragPassForPlan` (not RT-specific -- the
//          shader-frag encoder for the render plan).
//
// Contents (~1,120 lines):
//   * Sprint 7.5.6.a section divider + RT-scene lifecycle doc
//   * _ensureRtBlitPipeline (RGBA copy of decoded frame -> scratch
//     texture)
//   * _ensureRtSceneInstance (per-node WS state: ws, status, width,
//     height, texture, textureView, bindGroup, pendingFrame,
//     frameCount, lastFrameAt, error)
//   * _rtBuildSceneJson (initial scene patch sent over WS)
//   * _rtExtractLight, _rtExtractMaterial, _rtExtractCamera,
//     _rtFindUpstreamMesh / Material / ByPort / WalkChainUpstream
//     (graph walkers that pluck the wired upstream scene state)
//   * _rtMeshAverageColor (cheap surface tint summary for fallback)
//   * _rtComputeSceneSignature (hash of patch shape for diff
//     reduction)
//   * _rtScenePollAndSend (per-frame diff patch over WS; material /
//     light / camera / quality tier patches per RAYTRACING.md
//     Section 5.6.g)
//   * _rtBuildEnvWire (env shape over the wire)
//   * _rtSceneAllocateTexture (sized to remote frame dims, RGBA8)
//   * _encodeRtScenePass (compose decoded RT frame onto the Scene's
//     scratch / framebuffer layer)
//
// What stays in tail.2.2.2.2.2.1.2 after the cut:
//   * _encodeShaderFragPassForPlan (the visual-graph shader-frag
//     encoder; not RT-specific, will peel separately later).
//
// Since the cluster starts at byte 0, no pre-cluster fragment is
// created. The split rewrites tail.2.2.2.2.2.1.2.js in place with
// just the post-cluster bytes; visual/rt-scene.js is inserted into
// the manifest immediately before it.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync
} from "node:fs";

function skipTemplate(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && s[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < s.length && depth > 0) {
        const cc = s[i];
        if (cc === "/" && s[i + 1] === "/") { const nl = s.indexOf("\n", i); i = nl < 0 ? s.length : nl + 1; }
        else if (cc === "/" && s[i + 1] === "*") { const end = s.indexOf("*/", i + 2); i = end < 0 ? s.length : end + 2; }
        else if (cc === "'" || cc === "\"") { const q = cc; i++; while (i < s.length) { if (s[i] === "\\") { i += 2; continue; } if (s[i] === q) { i++; break; } i++; } }
        else if (cc === "`") { i = skipTemplate(s, i + 1); }
        else { if (cc === "{") depth++; else if (cc === "}") depth--; i++; }
      }
    } else { i++; }
  }
  return s.length;
}

function findMatching(s, i, openChar, closeChar) {
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") { const nl = s.indexOf("\n", i); i = nl < 0 ? s.length : nl + 1; continue; }
    if (c === "/" && s[i + 1] === "*") { const end = s.indexOf("*/", i + 2); i = end < 0 ? s.length : end + 2; continue; }
    if (c === "'" || c === "\"") { const q = c; i++; while (i < s.length) { if (s[i] === "\\") { i += 2; continue; } if (s[i] === q) { i++; break; } i++; } continue; }
    if (c === "`") { i = skipTemplate(s, i + 1); continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) depth--;
    i++;
  }
  return i - 1;
}

function funcEnd(src, funcStart) {
  const i = src.indexOf("{", funcStart);
  if (i < 0) throw new Error("no { after function at " + funcStart);
  return findMatching(src, i + 1, "{", "}") + 1;
}

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

const src = readFileSync("src/_monolith.tail.2.2.2.2.2.1.2.js", "utf8");

if (!src.startsWith("/* =====")) {
  throw new Error("source file does not start with the Sprint 7.5.6.a section divider");
}
if (!src.slice(0, 300).includes("RayTracedScene")) {
  throw new Error("expected RayTracedScene marker near top of file");
}
const cutStart = 0;

const endFuncIdx = src.indexOf("function _encodeRtScenePass", cutStart);
if (endFuncIdx < 0) throw new Error("`function _encodeRtScenePass` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

{
  const nextChunk = src.slice(cutEnd, cutEnd + 200);
  if (!nextChunk.includes("_encodeShaderFragPassForPlan")) {
    console.warn("WARN: post-cut content does not start with _encodeShaderFragPassForPlan:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("rt-scene cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

const rtPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (rtPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

mkdirSync("src/visual", { recursive: true });
writeFileSync("src/visual/rt-scene.js",              rtPart);
writeFileSync("src/_monolith.tail.2.2.2.2.2.1.2.js", part2);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.1.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.2.2.1.2.js` not found");
manifest.js.splice(idx, 0, "visual/rt-scene.js");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.6.4 split complete (pure relocation):");
console.log("  src/visual/rt-scene.js              ", fmt(rtPart.length).padStart(11), "bytes   <- RT scene encoder + WebSocket client");
console.log("  src/_monolith.tail.2.2.2.2.2.1.2.js ", fmt(part2.length).padStart(11), "bytes   (in-place rewrite)");
console.log("  ────────────────────────────────────────");
console.log("  sum                                 ", fmt(rtPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.2.2.1.2.js      ", fmt(src.length).padStart(11), "bytes");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-rt-scene-before.html gamma-node-editor.html");
