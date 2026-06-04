// M2.6.2 extractor: carves the remaining two large WGSL const strings
// (_SPRITE_WGSL and _ATM_LUT_WGSL) out of
// src/_monolith.tail.2.2.2.1.2.2.js into:
//   src/visual/shaders/sprite.wgsl.js
//   src/visual/shaders/atmosphere.wgsl.js
//
// Each const sits between its related functions in the file:
//   _SPRITE_WGSL  -- after _ensureMeshPipeline, before
//                    _ensureSpriteBindGroupLayout.
//   _ATM_LUT_WGSL -- inside the atmosphere LUTs section, before
//                    _ensureAtmosphereLUTs.
//
// Because the two cuts are NON-CONTIGUOUS, the tail file is split
// into three fragments so the manifest's concat order preserves
// the original byte layout:
//   src/_monolith.tail.2.2.2.1.2.2.1.js   (pre-sprite bytes)
//   src/visual/shaders/sprite.wgsl.js     (_SPRITE_WGSL block)
//   src/_monolith.tail.2.2.2.1.2.2.2.js   (between sprite and atm)
//   src/visual/shaders/atmosphere.wgsl.js (_ATM_LUT_WGSL block)
//   src/_monolith.tail.2.2.2.1.2.2.3.js   (post-atm bytes)
//
// Each cut includes the const's leading doc comment (if any).
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

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

// ── Find the bounds of `const NAME = \`...\`;` plus any leading
// block-comment that immediately precedes it (separated only by
// blank lines).
function constDeclBounds(src, name) {
  const declIdx = src.indexOf(`const ${name}`);
  if (declIdx < 0) throw new Error(`const ${name} not found`);

  // Walk back through any whitespace + a leading /* ... */ comment.
  let cutStart = declIdx;
  while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t" || src[cutStart - 1] === "\r" || src[cutStart - 1] === "\n")) cutStart--;
  if (cutStart >= 2 && src[cutStart - 1] === "/" && src[cutStart - 2] === "*") {
    const open = src.lastIndexOf("/*", cutStart - 3);
    if (open >= 0) {
      let j = open;
      while (j > 0 && (src[j - 1] === " " || src[j - 1] === "\t")) j--;
      cutStart = j;
    } else {
      cutStart = declIdx;
      while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;
    }
  } else {
    cutStart = declIdx;
    while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;
  }

  const eqIdx = src.indexOf("=", declIdx);
  if (eqIdx < 0) throw new Error(`= after const ${name} not found`);
  let openTickIdx = eqIdx + 1;
  while (openTickIdx < src.length && (src[openTickIdx] === " " || src[openTickIdx] === "\t" || src[openTickIdx] === "\r" || src[openTickIdx] === "\n")) openTickIdx++;
  if (src[openTickIdx] !== "`") throw new Error(`expected opening backtick after = for ${name}`);
  const closeTickIdx = skipTemplate(src, openTickIdx + 1);

  let cutEnd = closeTickIdx;
  if (src[cutEnd] === ";") cutEnd++;
  while (cutEnd < src.length && (src[cutEnd] === "\r" || src[cutEnd] === "\n")) cutEnd++;

  return { cutStart, cutEnd };
}

const sourceFile = "src/_monolith.tail.2.2.2.1.2.2.js";
const src = readFileSync(sourceFile, "utf8");

// Locate both consts in source order.
const spriteBounds = constDeclBounds(src, "_SPRITE_WGSL");
const atmBounds    = constDeclBounds(src, "_ATM_LUT_WGSL");

if (atmBounds.cutStart <= spriteBounds.cutEnd) {
  throw new Error("_ATM_LUT_WGSL appears to overlap _SPRITE_WGSL");
}

console.log("_SPRITE_WGSL  bounds: start byte", spriteBounds.cutStart, " line", lineOf(src, spriteBounds.cutStart), " length", (spriteBounds.cutEnd - spriteBounds.cutStart).toLocaleString());
console.log("_ATM_LUT_WGSL bounds: start byte", atmBounds.cutStart,    " line", lineOf(src, atmBounds.cutStart),    " length", (atmBounds.cutEnd - atmBounds.cutStart).toLocaleString());

// ── Slice into FIVE pieces in source order:
//     [0, spriteStart) -- tail.2.2.2.1.2.2.1.js
//     [spriteStart, spriteEnd) -- visual/shaders/sprite.wgsl.js
//     [spriteEnd, atmStart) -- tail.2.2.2.1.2.2.2.js
//     [atmStart, atmEnd) -- visual/shaders/atmosphere.wgsl.js
//     [atmEnd, EOF) -- tail.2.2.2.1.2.2.3.js
const part1   = src.slice(0,                     spriteBounds.cutStart);
const sprite  = src.slice(spriteBounds.cutStart, spriteBounds.cutEnd);
const part2   = src.slice(spriteBounds.cutEnd,   atmBounds.cutStart);
const atm     = src.slice(atmBounds.cutStart,    atmBounds.cutEnd);
const part3   = src.slice(atmBounds.cutEnd);

if (part1.length + sprite.length + part2.length + atm.length + part3.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/visual/shaders", { recursive: true });
writeFileSync("src/_monolith.tail.2.2.2.1.2.2.1.js", part1);
writeFileSync("src/visual/shaders/sprite.wgsl.js",   sprite);
writeFileSync("src/_monolith.tail.2.2.2.1.2.2.2.js", part2);
writeFileSync("src/visual/shaders/atmosphere.wgsl.js", atm);
writeFileSync("src/_monolith.tail.2.2.2.1.2.2.3.js", part3);

// Update manifest: replace the single tail entry with the five new
// entries in source order.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.1.2.2.js");
if (idx < 0) throw new Error("manifest entry `_monolith.tail.2.2.2.1.2.2.js` not found");
manifest.js.splice(
  idx, 1,
  "_monolith.tail.2.2.2.1.2.2.1.js",
  "visual/shaders/sprite.wgsl.js",
  "_monolith.tail.2.2.2.1.2.2.2.js",
  "visual/shaders/atmosphere.wgsl.js",
  "_monolith.tail.2.2.2.1.2.2.3.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Remove the original (now fully split).
if (existsSync(sourceFile)) unlinkSync(sourceFile);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.6.2 split complete (pure relocation):");
console.log("  src/_monolith.tail.2.2.2.1.2.2.1.js  ", fmt(part1.length).padStart(11), "bytes");
console.log("  src/visual/shaders/sprite.wgsl.js    ", fmt(sprite.length).padStart(11), "bytes   <- _SPRITE_WGSL");
console.log("  src/_monolith.tail.2.2.2.1.2.2.2.js  ", fmt(part2.length).padStart(11), "bytes");
console.log("  src/visual/shaders/atmosphere.wgsl.js", fmt(atm.length).padStart(11),    "bytes   <- _ATM_LUT_WGSL");
console.log("  src/_monolith.tail.2.2.2.1.2.2.3.js  ", fmt(part3.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                                  ", fmt(part1.length + sprite.length + part2.length + atm.length + part3.length).padStart(11), "bytes");
console.log("  original tail.2.2.2.1.2.2.js         ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-wgsl-strings-before.html gamma-node-editor.html");
