// M2.6.3 extractor: carves the Scene render-pass encoder
// (_encodeScenePass + scene-light + scene-environment resolvers) out
// of src/_monolith.tail.2.2.2.2.2.1.js into src/visual/scene-pass.js.
//
// One contiguous block bounded by:
//   START: `/* Encode a single Scene render pass.` doc comment
//          above `function _encodeScenePass`.
//   END  : end of `function _resolveSceneLights(...)` -- just before
//          the `Sprint 7.5.6.a part 2d -- RayTracedScene encoder`
//          section divider, which introduces a separate concern
//          (the WebSocket RT engine integration).
//
// Per the original modularization survey, _encodeScenePass is the
// second-biggest top-level function in the monolith (~1,092 lines).
// The cluster pulls it together with its closely paired light /
// environment / sun helpers.
//
// Contents (~1,460 lines):
//   * function _encodeScenePass(enc, entry)
//       - One render pass per Scene (color attachment = framebuffer
//         layer or scratch slot, depth = shared depth view).
//       - Iterates wired mesh inputs, writes viewProj + model
//         uniforms, issues one draw per mesh.
//       - Per-Scene 264-float scratch (sky / camera / fog / etc.)
//         + 64-float per-draw scratch (model + material params).
//       - Sky pass when env mode = ProceduralSky / Atmosphere /
//         HDRI -- 3-vertex fullscreen triangle.
//       - Atmosphere LUT scheduling when env.mode = atmosphere.
//   * function _resolveLightNode (single light -> Light descriptor)
//   * function _sunDirFromTime (time-of-day -> sun direction)
//   * function _sunColorFromElevation (sun color from elevation)
//   * function _resolveSceneEnvironment (env-node selector for a Scene)
//   * function _hdriPresetUrl (HDRI preset lookup)
//   * function _resolveSceneLights (collect all wired Light nodes
//     for a Scene, up to MAX_LIGHTS = 4)
//
// What stays in tail.2.2.2.2.2.1.x:
//   * Pre-cluster: 2D / 3D mesh builders (plane, sprite, tilemap,
//     parallax, scatter, terrain, water, clouds, tiled terrain,
//     torus, cylinder, cone) + `_ensureSceneInstance`
//   * Post-cluster: Sprint 7.5.6.a RT scene encoder (RtBlit pipeline,
//     scene JSON builder, WebSocket polling, env-wire builder,
//     texture allocation, _encodeRtScenePass, _encodeShaderFragPassForPlan).
//
// tail.2.2.2.2.2.1 is split at the cut into two new fragments:
//   src/_monolith.tail.2.2.2.2.2.1.1.js   (pre-cluster)
//   src/_monolith.tail.2.2.2.2.2.1.2.js   (RT scene encoder + rest)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
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

const src = readFileSync("src/_monolith.tail.2.2.2.2.2.1.js", "utf8");

const startMarker = "/* Encode a single Scene render pass.";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

const endFuncIdx = src.indexOf("function _resolveSceneLights", cutStart);
if (endFuncIdx < 0) throw new Error("`function _resolveSceneLights` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

{
  const nextChunk = src.slice(cutEnd, cutEnd + 200);
  if (!nextChunk.includes("RayTracedScene") && !nextChunk.includes("Sprint 7.5.6")) {
    console.warn("WARN: post-cut content does not look like RT scene section:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("scene-pass cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

const part1 = src.slice(0, cutStart);
const scenePart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + scenePart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

mkdirSync("src/visual", { recursive: true });
writeFileSync("src/_monolith.tail.2.2.2.2.2.1.1.js", part1);
writeFileSync("src/visual/scene-pass.js",            scenePart);
writeFileSync("src/_monolith.tail.2.2.2.2.2.1.2.js", part2);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.1.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.2.2.1.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.2.2.2.2.2.1.1.js",
  "visual/scene-pass.js",
  "_monolith.tail.2.2.2.2.2.1.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.tail.2.2.2.2.2.1.js")) {
  unlinkSync("src/_monolith.tail.2.2.2.2.2.1.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.6.3 split complete (pure relocation):");
console.log("  src/_monolith.tail.2.2.2.2.2.1.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/visual/scene-pass.js           ", fmt(scenePart.length).padStart(11), "bytes   <- _encodeScenePass + lights + env");
console.log("  src/_monolith.tail.2.2.2.2.2.1.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                                ", fmt(part1.length + scenePart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.2.2.1.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-scene-pass-before.html gamma-node-editor.html");
