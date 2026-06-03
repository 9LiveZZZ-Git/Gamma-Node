// M1 boundary finder. Locates the start and end byte indices of
//   const TYPES = { ... };
//   const _demos = [ ... ];
// inside src/_monolith.js, properly skipping strings (' " `), template
// interpolations (${...}), and comments (// /*...*/), so the brace
// counter doesn't get fooled by braces inside literal content.
//
// Run from the repo root:  node scripts/m1-find-boundaries.mjs

import { readFileSync } from "node:fs";

const src = readFileSync("src/_monolith.js", "utf8");

// Skip past the closing backtick of a template literal that starts at `i`
// (i = index AFTER the opening `). Handles `${ ... }` interpolations
// recursively. Returns the index AFTER the closing backtick.
function skipTemplate(src, i) {
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        i = skipInExpr(src, i, () => depth);
        const cc = src[i];
        if (cc === "{") { depth++; i++; }
        else if (cc === "}") { depth--; i++; }
        else { i++; }
      }
    } else {
      i++;
    }
  }
  return src.length;
}

// Skip helper used inside expressions (the bodies of ${...}). Advances
// past one "token-skip-equivalent" unit -- a comment, a string, a
// template -- and returns the new index. If no skip applies, returns i
// unchanged so the caller can advance one char.
function skipInExpr(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl < 0 ? src.length : nl + 1;
  }
  if (c === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end < 0 ? src.length : end + 2;
  }
  if (c === "'" || c === "\"") {
    const q = c;
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === q) return j + 1;
      j++;
    }
    return src.length;
  }
  if (c === "`") return skipTemplate(src, i + 1);
  return i;
}

// Find the matching close for `openChar` starting at byte `i` (the byte
// AFTER the opening char). Returns the byte index of the close.
function findMatching(src, i, openChar, closeChar) {
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2; continue;
    }
    if (c === "'" || c === "\"") {
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "`") { i = skipTemplate(src, i + 1); continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) depth--;
    i++;
  }
  return i - 1; // index of the matching close char
}

function lineOf(idx) { return src.slice(0, idx).split("\n").length; }

// ── TYPES
const typesStart = src.indexOf("const TYPES = {");
if (typesStart < 0) throw new Error("`const TYPES = {` not found");
const typesBrace = typesStart + "const TYPES = ".length; // index of `{`
const typesClose = findMatching(src, typesBrace + 1, "{", "}");
// Include the trailing semicolon `;`. The line is `};`.
let typesEnd = typesClose + 1;
if (src[typesEnd] === ";") typesEnd += 1;
console.log("TYPES   :  bytes", typesStart, "..", typesEnd,
  " lines", lineOf(typesStart), "..", lineOf(typesEnd),
  " (length", (typesEnd - typesStart).toLocaleString(), "bytes)");

// ── _demos
const demosStart = src.indexOf("const _demos = [", typesEnd);
if (demosStart < 0) throw new Error("`const _demos = [` not found (after TYPES)");
const demosBracket = demosStart + "const _demos = ".length;
const demosClose = findMatching(src, demosBracket + 1, "[", "]");
let demosEnd = demosClose + 1;
if (src[demosEnd] === ";") demosEnd += 1;
console.log("_demos  :  bytes", demosStart, "..", demosEnd,
  " lines", lineOf(demosStart), "..", lineOf(demosEnd),
  " (length", (demosEnd - demosStart).toLocaleString(), "bytes)");

// Sanity preview: the few chars before/after each boundary
function preview(i, n = 60) {
  return JSON.stringify(src.slice(Math.max(0, i - n), i + n));
}
console.log("");
console.log("TYPES start ctx :", preview(typesStart, 30));
console.log("TYPES end ctx   :", preview(typesEnd, 30));
console.log("_demos start ctx:", preview(demosStart, 30));
console.log("_demos end ctx  :", preview(demosEnd, 30));
