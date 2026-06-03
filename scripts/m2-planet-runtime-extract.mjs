// M2.4.1 extractor: carves the planet GPU runtime (DEM tile streaming,
// SVT, Earth cubemap build, planet chunks, planet mesh, detail patches)
// out of src/_monolith.tail.2.2.2.2.2.js into src/planet/runtime.js.
//
// One contiguous block bounded by:
//   START: the `/* === Sprint 10-6 -- streamed high-resolution DEM tiles`
//          section divider at byte 0 (the file's first content).
//   END  : end of `function _ensurePlanetDetailPatchBuffer` -- the last
//          planet helper before the non-planet `_buildPlane` 2D mesh
//          builder.
//
// Contents (~3,725 lines):
//   * Sprint 10-6 streamed DEM tiles: const _EARTH_TILES,
//     _loadHighResTile, _sampleHighResDEMMeters, _metersToElev,
//     _ensureHighResTileForDir, _ensureHighResTilesForChunk,
//     _invalidateChunksForTile
//   * Sprint 10-5c SVT (Sparse Virtual Texturing): const _SVT,
//     _ensureSVT, _svtAllocateSlot, _svtTableForZoom,
//     _svtWritePageTable, _svtMarkUnresident, _svtEvictLRU,
//     _svtGeneratePage, _svtUploadPage, _svtTest, _svtQueueIfNew,
//     _svtQueueChunkPages, _svtTickGeneration,
//     _ensureSVTDefaultPageTable, _depthToZoom
//   * Elevation cache: _planetSampleElevationCached
//   * Earth cubemap data: const _EARTH_CONTINENTS, _EARTH_RIDGES
//   * Earth helpers: _earthElevationAt, _earthClimateAt,
//     _biomeMatrixSample, _bandIndexFractional, _earthSurfaceColorAt,
//     _buildEarthCubemap, _erodeFaceHydraulic (hydraulic erosion)
//   * Cubemap builders/samplers: _buildCustomCellCubemap,
//     _ensurePlanetMapCubemap, _samplePlanetMapCubemap,
//     _findPlanetMapForPlanet
//   * Chunks (low-res quadtree LOD): _planetChunkKey,
//     _planetVisibleChunks, _resolvePlanetGeom,
//     _buildSinglePlanetChunk, _planetGlobalCacheKey,
//     _ensurePlanetChunks, _buildPlanet
//   * Mesh chunks (real 3D geometry): _resolvePlanetMeshGeom,
//     _planetMeshGlobalCacheKey, _buildSinglePlanetMeshChunk,
//     _ensurePlanetMeshChunks, _loopSubdividePlanet, _buildPlanetMesh
//   * Detail patches: _buildPlanetDetailPatch,
//     _ensurePlanetDetailPatchBuffer
//
// What stays in tail.2.2.2.2.2 after the cut:
//   * Non-planet mesh builders (_buildPlane, _buildSprite,
//     _buildTileSpriteOverlay, _buildParallaxLayer2D,
//     _buildSpriteScatter2D, etc.)
//   * Tilemap2D + terrain noise helpers
//   * _planetColorForHeight + _planetSunDir (small scattered planet
//     helpers nestled among non-planet builders -- relocating them
//     would require non-contiguous cuts; defer to a later pass)
//   * Tiled terrain (archipelago)
//   * Clouds3D chunks, scene encoder, lights, sun-time helpers, etc.
//
// Cut details:
//   Since cutStart = 0, no pre-cluster fragment is created. The split
//   produces:
//     src/planet/runtime.js   <- the cluster
//     src/_monolith.tail.2.2.2.2.2.js  <- replaced in-place with the
//                                         post-cluster content (which
//                                         keeps the same name since
//                                         the pre-cluster was empty).
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync
} from "node:fs";

// ── Brace counter (shared with M1/M2.x extractors).

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

// ── Boundaries

const src = readFileSync("src/_monolith.tail.2.2.2.2.2.js", "utf8");

// START anchor: the file should begin with the Sprint 10-6 divider.
// Confirm and use byte 0.
if (!src.startsWith("/* ====")) {
  throw new Error("source file does not start with `/* ====` divider");
}
if (!src.slice(0, 200).includes("Sprint 10-6")) {
  throw new Error("expected `Sprint 10-6` near the top of the file");
}
const cutStart = 0;

// END anchor: end of `function _ensurePlanetDetailPatchBuffer`. Next
// function is `_buildPlane` (non-planet 2D mesh builder).
const endFuncIdx = src.indexOf("function _ensurePlanetDetailPatchBuffer", cutStart);
if (endFuncIdx < 0) throw new Error("`function _ensurePlanetDetailPatchBuffer` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
// Walk past any blank lines so the next chunk starts cleanly at the
// `_buildPlane` doc comment.
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check: next non-blank should mention `_buildPlane` or `Plane`.
{
  const nextChunk = src.slice(cutEnd, cutEnd + 120);
  if (!nextChunk.includes("Plane") && !nextChunk.includes("_buildPlane")) {
    console.warn("WARN: post-cut content does not look like _buildPlane:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("planet runtime cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 80)));

// ── Slice (no pre-cluster fragment since cutStart === 0)
const planetPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (planetPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/planet", { recursive: true });
writeFileSync("src/planet/runtime.js",            planetPart);
// Overwrite the existing tail.2.2.2.2.2.js with the post-cluster content.
writeFileSync("src/_monolith.tail.2.2.2.2.2.js",  part2);

// Update manifest: insert `planet/runtime.js` BEFORE the existing
// `_monolith.tail.2.2.2.2.2.js` entry (which now holds only the
// post-cluster bytes).
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.2.2.js` not found");
manifest.js.splice(idx, 0, "planet/runtime.js");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.4.1 split complete (pure relocation):");
console.log("  src/planet/runtime.js            ", fmt(planetPart.length).padStart(11), "bytes   <- planet GPU runtime carved out");
console.log("  src/_monolith.tail.2.2.2.2.2.js  ", fmt(part2.length).padStart(11), "bytes   (in-place rewrite, post-cluster content)");
console.log("  ────────────────────────────────────────");
console.log("  sum                              ", fmt(planetPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.2.2.js       ", fmt(src.length).padStart(11), "bytes");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-planet-runtime-before.html gamma-node-editor.html");
