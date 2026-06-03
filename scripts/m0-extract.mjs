// M0 one-time extractor: slices the current gamma-node-editor.html into
//
//   src/shell.html         HTML skeleton with the INLINE_CSS,
//                          INLINE_JS placeholders
//   src/styles/app.css     the CSS body, verbatim
//   src/_monolith.js       the inline JS body, verbatim,
//                          with `const APP_VERSION = "x";` tokenized to
//                          `const APP_VERSION = APP_VERSION_TOKEN;`
//   src/build-order.json   the concatenation manifest
//
// No code is changed -- this is a pure relocation. After running this,
// `node build.mjs` should regenerate a byte-identical
// `gamma-node-editor.html` (modulo the APP_VERSION token, which the
// build re-inserts from the root VERSION file).
//
// Run from the repo root:  node scripts/m0-extract.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const h = readFileSync("gamma-node-editor.html", "utf8");

// ── CSS boundaries: the inline <style>...</style> block.
const styleOpen = h.indexOf("<style>");
const styleClose = h.indexOf("</style>");
if (styleOpen < 0 || styleClose < 0) throw new Error("<style> tags not found");
const cssStart = styleOpen + "<style>".length;
const cssEnd   = styleClose;

// ── JS boundaries: the FIRST real (un-backslash-escaped, no-src) <script>
// tag opens it; the LAST real </script> closes it. Embedded literal
// `<\/script>` strings inside JS template literals are skipped by the
// backslash check, so they don't trip the boundary finder.
let jsOpen = -1, jsOpenEnd = -1;
{
  let i = 0;
  while ((i = h.indexOf("<script", i)) >= 0) {
    if (h[i - 1] === "\\") { i += 1; continue; }
    const e = h.indexOf(">", i);
    const tag = h.slice(i, e + 1);
    if (!tag.includes("src=")) { jsOpen = i; jsOpenEnd = e + 1; break; }
    i = e + 1;
  }
}
if (jsOpen < 0) throw new Error("inline <script> (no src=) not found");

let jsClose = -1;
{
  let i = 0;
  while ((i = h.indexOf("</script>", i)) >= 0) {
    if (h[i - 1] === "\\") { i += 1; continue; }
    jsClose = i;
    i += 9;
  }
}
if (jsClose < 0) throw new Error("matching </script> not found");

const cssContent = h.slice(cssStart, cssEnd);
const jsContent  = h.slice(jsOpenEnd, jsClose);

// ── Tokenize APP_VERSION inside the JS body so the build can inject the
// VERSION file at build time. The exact line stays the same shape, just
// with a comment placeholder where the string literal was.
const versionRe = /const APP_VERSION = "([^"]+)";/;
const m = jsContent.match(versionRe);
if (!m) throw new Error("APP_VERSION line not found in inline JS");
const versionStr = m[1];
const tokenizedJs = jsContent.replace(versionRe, "const APP_VERSION = /*__APP_VERSION__*/;");

// Sanity check: VERSION file should match what's in the HTML.
const versionFile = readFileSync("VERSION", "utf8").trim();
if (versionStr !== versionFile) {
  console.warn("WARNING: APP_VERSION (" + versionStr + ") differs from VERSION file (" + versionFile + ")");
}

// ── Compose shell.html: original file with the CSS body and JS body
// replaced by the placeholders, byte ranges precise.
const shell =
  h.slice(0, cssStart) +
  "/*__INLINE_CSS__*/" +
  h.slice(cssEnd, jsOpenEnd) +
  "/*__INLINE_JS__*/" +
  h.slice(jsClose);

// ── Write outputs.
mkdirSync("src/styles", { recursive: true });
writeFileSync("src/styles/app.css", cssContent);
writeFileSync("src/_monolith.js", tokenizedJs);
writeFileSync("src/shell.html", shell);
writeFileSync(
  "src/build-order.json",
  JSON.stringify({ css: ["app.css"], js: ["_monolith.js"] }, null, 2) + "\n"
);

console.log("extracted:");
console.log("  src/shell.html        ", shell.length.toLocaleString(), "bytes");
console.log("  src/styles/app.css    ", cssContent.length.toLocaleString(), "bytes");
console.log("  src/_monolith.js      ", tokenizedJs.length.toLocaleString(), "bytes (APP_VERSION tokenized)");
console.log("  src/build-order.json  ", "manifest");
console.log("APP_VERSION extracted   :", versionStr);
console.log("VERSION file            :", versionFile);
console.log("\nNext: run `node build.mjs` and verify `git diff gamma-node-editor.html` is empty.");
