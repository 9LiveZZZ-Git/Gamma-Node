// M1 extractor: carves
//   const TYPES = { ... };      -> src/nodes/registry.js
//   const _demos = [ ... ];     -> src/demos/index.js
// out of src/_monolith.js, splitting the surrounding monolith into
//   src/_monolith.head.js     (everything before TYPES)
//   src/_monolith.middle.js   (between TYPES and _demos)
//   src/_monolith.tail.js     (everything after _demos)
// and updating src/build-order.json to concatenate them in source order.
//
// Pure relocation: no code is changed. After this, `node build.mjs`
// must regenerate a byte-identical gamma-node-editor.html.
//
// Run from the repo root:  node scripts/m1-extract.mjs

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

const src = readFileSync("src/_monolith.js", "utf8");

// ── Brace counter that skips strings ('  "  `) with their escapes,
// template interpolations ${...}, and comments (// /* */).

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
        if (cc === "/" && s[i + 1] === "/") {
          const nl = s.indexOf("\n", i);
          i = nl < 0 ? s.length : nl + 1;
        } else if (cc === "/" && s[i + 1] === "*") {
          const end = s.indexOf("*/", i + 2);
          i = end < 0 ? s.length : end + 2;
        } else if (cc === "'" || cc === "\"") {
          const q = cc; i++;
          while (i < s.length) {
            if (s[i] === "\\") { i += 2; continue; }
            if (s[i] === q) { i++; break; }
            i++;
          }
        } else if (cc === "`") {
          i = skipTemplate(s, i + 1);
        } else {
          if (cc === "{") depth++;
          else if (cc === "}") depth--;
          i++;
        }
      }
    } else { i++; }
  }
  return s.length;
}

function findMatching(s, i, openChar, closeChar) {
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl + 1; continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2; continue;
    }
    if (c === "'" || c === "\"") {
      const q = c; i++;
      while (i < s.length) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "`") { i = skipTemplate(s, i + 1); continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) depth--;
    i++;
  }
  return i - 1;
}

// ── Find TYPES boundary
const typesStart = src.indexOf("const TYPES = {");
if (typesStart < 0) throw new Error("`const TYPES = {` not found");
const typesBrace = typesStart + "const TYPES = ".length;
const typesClose = findMatching(src, typesBrace + 1, "{", "}");
let typesEnd = typesClose + 1;
if (src[typesEnd] === ";") typesEnd += 1;

// ── Find _demos boundary (after TYPES so we don't get a false match)
const demosStart = src.indexOf("const _demos = [", typesEnd);
if (demosStart < 0) throw new Error("`const _demos = [` not found");
const demosBracket = demosStart + "const _demos = ".length;
const demosClose = findMatching(src, demosBracket + 1, "[", "]");
let demosEnd = demosClose + 1;
if (src[demosEnd] === ";") demosEnd += 1;

// ── Slice into 5 parts (pure cut, no transformation)
const head    = src.slice(0,         typesStart);
const types   = src.slice(typesStart, typesEnd);
const middle  = src.slice(typesEnd,   demosStart);
const demos   = src.slice(demosStart, demosEnd);
const tail    = src.slice(demosEnd);

const sumLen = head.length + types.length + middle.length + demos.length + tail.length;
if (sumLen !== src.length) {
  throw new Error("slice math wrong: sum " + sumLen + " != src " + src.length);
}

// ── Write outputs
mkdirSync("src/nodes", { recursive: true });
mkdirSync("src/demos", { recursive: true });
writeFileSync("src/_monolith.head.js",   head);
writeFileSync("src/nodes/registry.js",   types);
writeFileSync("src/_monolith.middle.js", middle);
writeFileSync("src/demos/index.js",      demos);
writeFileSync("src/_monolith.tail.js",   tail);

// Update the manifest
const manifest = {
  css: ["app.css"],
  js: [
    "_monolith.head.js",
    "nodes/registry.js",
    "_monolith.middle.js",
    "demos/index.js",
    "_monolith.tail.js"
  ]
};
writeFileSync("src/build-order.json", JSON.stringify(manifest, null, 2) + "\n");

// Remove the now-replaced _monolith.js
if (existsSync("src/_monolith.js")) {
  unlinkSync("src/_monolith.js");
}

const fmt = n => n.toLocaleString();
console.log("M1 split complete (pure relocation):");
console.log("  src/_monolith.head.js     ", fmt(head.length).padStart(11), "bytes");
console.log("  src/nodes/registry.js     ", fmt(types.length).padStart(11), "bytes   <- TYPES carved out");
console.log("  src/_monolith.middle.js   ", fmt(middle.length).padStart(11), "bytes");
console.log("  src/demos/index.js        ", fmt(demos.length).padStart(11), "bytes   <- _demos carved out");
console.log("  src/_monolith.tail.js     ", fmt(tail.length).padStart(11), "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                       ", fmt(sumLen).padStart(11), "bytes");
console.log("  original src/_monolith.js ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m1-before.html gamma-node-editor.html");
