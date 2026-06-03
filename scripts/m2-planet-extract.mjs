// M2.4 extractor: carves the foundational Planet subsystem (cells,
// biomes, climate, rivers, heightmap verbs, AI plan, landmass measure,
// Earth DEM sampler) out of src/_monolith.tail.2.2.2.2.js into
// src/planet/index.js.
//
// One contiguous block bounded by:
//   START: `/* §planet-spec Phase 4.c -- camera position for the Planet's`
//          doc comment above `function _planetCameraPos`.
//   END  : end of `function _earthDEMSampleMeters` (the bilinear DEM
//          sampler) -- immediately before
//          `/* === Sprint 10-6 -- streamed high-resolution DEM tiles === */`.
//
// Contents (~3,335 lines):
//   * Camera + projection: _planetCameraPos, _findPlanetForProjection,
//     _projectFlatToPlanet, _planetSpherify
//   * Cell model: _buildCellTriangulation, _buildFibonacciCells,
//     _buildCellSpatialHash, _findNearestCell, _samplePlanetCells*,
//     _buildCellNeighbors, _ensurePlanetMapCells,
//     _planetMapCacheKey / _planetMapCellsKey, _planetEnhanceRidges,
//     _samplePlanetCellsIDWBoosted
//   * Biomes: PLANET_BIOMES_NAMES / DETAIL_DEFAULTS / TEX_STYLES /
//     SHAPES / COLORS / MATRIX, _planetBiomeStyle*, _planetBiomeId
//   * Climate: _resolveClimateConfig, _planetClimate, _ensurePlanetClimate
//   * Rivers: _planetRivers, _ensurePlanetRivers
//   * Heightmap verbs: _planetVerbReset / Hill / Pit / Range / Smooth
//     / SmoothCap / HillXY / PitXY / RangeXY / Strait / Add / Multiply
//     / Invert / Mask, _planetRunDSL, _planetPostDSL,
//     _planetMeasureLandmass, _planetTemplatePowers + range/cap utils
//   * AI plan: _parseAIPlan, _applyAIPlan
//   * Cubemap base64: _encodeCubemapBase64, _decodeCubemapBase64
//   * Earth DEM core: const _EARTH_DEM, _decodeTerrariumPixel,
//     _loadEarthDEMTile, _loadEarthDEM, _earthDEMSampleMeters
//
// Deferred to M2.4.1 (next pass):
//   * Sprint 10-6 streamed high-res DEM tiles (const _EARTH_TILES, ...)
//   * Sprint 10-5c SVT data structures + page management
//   * _planetSampleElevationCached, Earth cubemap build + hydraulic
//     erosion, _buildCustomCellCubemap, _ensurePlanetMapCubemap
//   * Planet chunks + mesh chunks + detail patches (_planetVisibleChunks,
//     _buildSinglePlanetChunk, _ensurePlanetChunks, _buildPlanet,
//     _buildSinglePlanetMeshChunk, _ensurePlanetMeshChunks,
//     _loopSubdividePlanet, _buildPlanetMesh, _buildPlanetDetailPatch,
//     _ensurePlanetDetailPatchBuffer)
//
// tail.2.2.2.2 is split at the cut into two new fragments:
//   src/_monolith.tail.2.2.2.2.1.js   (pre-planet: _tickThirdPersonCameras
//                                       + _tickBlobControllers3D)
//   src/_monolith.tail.2.2.2.2.2.js   (Sprint 10-6 onward)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
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

const src = readFileSync("src/_monolith.tail.2.2.2.2.js", "utf8");

// START anchor: the doc comment immediately above `_planetCameraPos`.
// Distinctive marker.
const startMarker = "/* §planet-spec Phase 4.c -- camera position for the Planet's";
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) throw new Error(`start marker not found: ${startMarker}`);

let cutStart = startIdx;
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// END anchor: end of `function _earthDEMSampleMeters`. Next section
// divider after this function is `/* === Sprint 10-6 -- streamed
// high-resolution DEM tiles === */`.
const endFuncIdx = src.indexOf("function _earthDEMSampleMeters", cutStart);
if (endFuncIdx < 0) throw new Error("`function _earthDEMSampleMeters` not found");
const endBrace = funcEnd(src, endFuncIdx);

let cutEnd = endBrace;
if (src[cutEnd] === "\n") cutEnd++;
// Walk forward past any blank lines so the next chunk starts cleanly
// at the Sprint 10-6 divider.
while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

// Cross-check: next non-blank should be the Sprint 10-6 divider.
{
  const nextChunk = src.slice(cutEnd, cutEnd + 120);
  if (!nextChunk.includes("Sprint 10-6") && !nextChunk.includes("DEM tiles")) {
    console.warn("WARN: post-cut content does not look like Sprint 10-6:");
    console.warn(JSON.stringify(nextChunk));
  }
}

console.log("planet cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 80)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 60)));

// ── Slice
const part1 = src.slice(0, cutStart);
const planetPart = src.slice(cutStart, cutEnd);
const part2 = src.slice(cutEnd);

if (part1.length + planetPart.length + part2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/planet", { recursive: true });
writeFileSync("src/_monolith.tail.2.2.2.2.1.js", part1);
writeFileSync("src/planet/index.js",             planetPart);
writeFileSync("src/_monolith.tail.2.2.2.2.2.js", part2);

// Update manifest.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.2.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.2.2.2.2.1.js",
  "planet/index.js",
  "_monolith.tail.2.2.2.2.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync("src/_monolith.tail.2.2.2.2.js")) {
  unlinkSync("src/_monolith.tail.2.2.2.2.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.4 split complete (pure relocation):");
console.log("  src/_monolith.tail.2.2.2.2.1.js", fmt(part1.length).padStart(11), "bytes");
console.log("  src/planet/index.js            ", fmt(planetPart.length).padStart(11), "bytes   <- Planet model carved out");
console.log("  src/_monolith.tail.2.2.2.2.2.js", fmt(part2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                            ", fmt(part1.length + planetPart.length + part2.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.2.js       ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-planet-before.html gamma-node-editor.html");
