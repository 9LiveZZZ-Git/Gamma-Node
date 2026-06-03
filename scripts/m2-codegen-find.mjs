// M2.1 boundary finder for codegen subsystem.
// Finds contiguous spans containing:
//   middle.js: parseGdsp + buildUserDspDef    (.gdsp parser)
//   tail.js  : exprFor + inputExpr + gatherHeaders + generateCode (C++ codegen)
// For each cluster, the START is the beginning of the leading block-comment
// (if any) above the first function; the END is the closing `}` of the
// last function (plus any trailing semicolon if it has one).

import { readFileSync } from "node:fs";

// ── Brace counter with string/template/comment skipping (same logic as M1).

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

// Find the start of the leading block comment (`/* ... */`) immediately
// above `funcStart`, if any. "Immediately above" = only blank/whitespace
// lines between the comment's `*/` and `function`. Returns funcStart if
// no such comment.
function leadingCommentStart(src, funcStart) {
  // Step backward through whitespace lines.
  let i = funcStart - 1;
  while (i >= 0 && (src[i] === " " || src[i] === "\t" || src[i] === "\r" || src[i] === "\n")) i--;
  // Now check if the previous non-whitespace char is the `/` of `*/`.
  if (i < 1 || src[i] !== "/" || src[i - 1] !== "*") return funcStart;
  // Walk back to find the `/*` that opens this comment.
  const open = src.lastIndexOf("/*", i - 2);
  if (open < 0) return funcStart;
  // Walk back from `open` through any leading whitespace on the same line
  // so the cut starts at column 0 of that line.
  let j = open;
  while (j > 0 && (src[j - 1] === " " || src[j - 1] === "\t")) j--;
  return j;
}

// Find the end of a `function name(...) { ... }` declaration that starts
// at `funcStart`. Returns the byte index just past the closing `}`.
function funcEnd(src, funcStart) {
  // Locate the `{` that opens the function body.
  let i = src.indexOf("{", funcStart);
  if (i < 0) throw new Error("no { after function at " + funcStart);
  const close = findMatching(src, i + 1, "{", "}");
  return close + 1;
}

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }
function ctx(src, idx, n = 50) { return JSON.stringify(src.slice(Math.max(0, idx - n), idx + n)); }

// ── Cluster A: middle.js -- parseGdsp + buildUserDspDef
{
  const f = "src/_monolith.middle.js";
  const src = readFileSync(f, "utf8");
  const parseGdspIdx = src.indexOf("function parseGdsp");
  const buildIdx = src.indexOf("function buildUserDspDef", parseGdspIdx);
  if (parseGdspIdx < 0 || buildIdx < 0) throw new Error("middle cluster funcs not found");
  const start = leadingCommentStart(src, parseGdspIdx);
  const end = funcEnd(src, buildIdx);
  console.log("=== Cluster A (middle.js):", f, "===");
  console.log("  start  byte", start, "line", lineOf(src, start));
  console.log("  end    byte", end,   "line", lineOf(src, end));
  console.log("  length", (end - start).toLocaleString(), "bytes");
  console.log("  start ctx:", ctx(src, start, 30));
  console.log("  end   ctx:", ctx(src, end, 30));
}

// ── Cluster B: tail.js -- exprFor + inputExpr + gatherHeaders + generateCode
{
  const f = "src/_monolith.tail.js";
  const src = readFileSync(f, "utf8");
  const exprForIdx = src.indexOf("function exprFor");
  const genIdx = src.indexOf("function generateCode", exprForIdx);
  if (exprForIdx < 0 || genIdx < 0) throw new Error("tail cluster funcs not found");
  const start = leadingCommentStart(src, exprForIdx);
  const end = funcEnd(src, genIdx);
  console.log("");
  console.log("=== Cluster B (tail.js):", f, "===");
  console.log("  start  byte", start, "line", lineOf(src, start));
  console.log("  end    byte", end,   "line", lineOf(src, end));
  console.log("  length", (end - start).toLocaleString(), "bytes");
  console.log("  start ctx:", ctx(src, start, 30));
  console.log("  end   ctx:", ctx(src, end, 30));
}
