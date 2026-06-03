// M2.1 extractor: carves the C++ codegen subsystem out of
// src/_monolith.tail.js into src/codegen/index.js.
//
// The codegen cluster is bounded by the `/* === Codegen === */` section
// divider at the top and the end of `function node_methods` at the
// bottom (the next function `highlightCpp` is UI-side syntax highlighting
// for the Code-preview tab — explicitly NOT codegen). Cluster contents:
//
//   /* === Codegen === */ section divider + supporting doc comments
//   function signalInput(def)
//   function portAccess(def, srcPortName)
//   function exprFor(nodeId, srcPortName, cgCtx)
//   function inputExpr(node, portName, cgCtx)
//   function gatherHeaders(def)
//   function generateCode()
//   function node_methods(def)
//
// _monolith.tail.js is split at the cut into two new fragments:
//   src/_monolith.tail.1.js   (everything before the codegen section)
//   src/_monolith.tail.2.js   (everything after node_methods)
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.
//
// Run from the repo root:  node scripts/m2-codegen-extract.mjs

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

// ── Brace counter with string/template/comment skipping (same as M1).

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

const src = readFileSync("src/_monolith.tail.js", "utf8");

// Anchor: locate `function exprFor`, then walk backward to find the
// preceding `/* === Codegen === */` section divider.
const exprForIdx = src.indexOf("function exprFor");
if (exprForIdx < 0) throw new Error("`function exprFor` not found in tail.js");

// Find the previous section-divider comment (`/* ====...`) — the line
// `/* =========================================================================`
// — that introduces the codegen section.
const dividerNeedle = "/* ====";
let cutStart = -1;
{
  // Look backward from exprForIdx for the dividerNeedle. Take the LAST
  // occurrence before exprForIdx (lastIndexOf within the prefix).
  cutStart = src.lastIndexOf(dividerNeedle, exprForIdx);
}
if (cutStart < 0) throw new Error("section divider `/* ====` not found before exprFor");
// Walk back through any column-leading whitespace on that line so the
// cut is at column 0.
while (cutStart > 0 && (src[cutStart - 1] === " " || src[cutStart - 1] === "\t")) cutStart--;

// Anchor: locate `function generateCode`, then `function node_methods`
// immediately after (which is the last codegen helper before the UI
// `highlightCpp` / `renderCode`).
const generateIdx = src.indexOf("function generateCode", exprForIdx);
if (generateIdx < 0) throw new Error("`function generateCode` not found");
const nodeMethodsIdx = src.indexOf("function node_methods", generateIdx);
if (nodeMethodsIdx < 0) throw new Error("`function node_methods` not found");

// End of node_methods.
const cutEnd = funcEnd(src, nodeMethodsIdx);

// ── Sanity: cluster contents
console.log("codegen cluster bounds:");
console.log("  start byte", cutStart, " line", lineOf(src, cutStart));
console.log("  end   byte", cutEnd,   " line", lineOf(src, cutEnd));
console.log("  length    ", (cutEnd - cutStart).toLocaleString(), "bytes");
console.log("  start ctx :", JSON.stringify(src.slice(cutStart, cutStart + 60)));
console.log("  end   ctx :", JSON.stringify(src.slice(cutEnd - 40, cutEnd + 40)));

// ── Slice
const tailPart1 = src.slice(0, cutStart);
const codegenPart = src.slice(cutStart, cutEnd);
const tailPart2 = src.slice(cutEnd);

if (tailPart1.length + codegenPart.length + tailPart2.length !== src.length) {
  throw new Error("slice math wrong");
}

// ── Write outputs
mkdirSync("src/codegen", { recursive: true });
writeFileSync("src/_monolith.tail.1.js", tailPart1);
writeFileSync("src/codegen/index.js",    codegenPart);
writeFileSync("src/_monolith.tail.2.js", tailPart2);

// Update manifest: replace the single `_monolith.tail.js` entry with
// three entries in source order.
const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const tailIdx = manifest.js.indexOf("_monolith.tail.js");
if (tailIdx < 0) throw new Error("manifest entry `_monolith.tail.js` not found");
manifest.js.splice(
  tailIdx, 1,
  "_monolith.tail.1.js",
  "codegen/index.js",
  "_monolith.tail.2.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Remove the now-replaced _monolith.tail.js
if (existsSync("src/_monolith.tail.js")) {
  unlinkSync("src/_monolith.tail.js");
}

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.1 split complete (pure relocation):");
console.log("  src/_monolith.tail.1.js  ", fmt(tailPart1.length).padStart(11), "bytes");
console.log("  src/codegen/index.js     ", fmt(codegenPart.length).padStart(11), "bytes   <- codegen carved out");
console.log("  src/_monolith.tail.2.js  ", fmt(tailPart2.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                      ", fmt(tailPart1.length + codegenPart.length + tailPart2.length).padStart(11), "bytes");
console.log("  original tail.js         ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-before.html gamma-node-editor.html");
