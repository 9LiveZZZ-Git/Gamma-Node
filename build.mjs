// Gamma Node — build.
//
//   src/shell.html         + INLINE_CSS, INLINE_JS, APP_VERSION placeholders
//   src/styles/<files>     + concatenated in src/build-order.json order
//   src/<js files>         + concatenated in src/build-order.json order
//   VERSION (root)         + injected as the APP_VERSION string literal
//  ────────────────────────────────────────────────────────────────────
//   gamma-node-editor.html   the shipped / Pages / emailable artifact
//
// Zero dependencies. Just `node build.mjs`. The build is a pure
// concatenation + inline + token substitution — no parsing, no
// minification, no reordering.
//
// The M0 invariant: until the source files are intentionally changed,
// the built `gamma-node-editor.html` is byte-identical (or a trivial
// whitespace-only diff) to today's. `git diff gamma-node-editor.html`
// should be empty after a pure-relocation split. If it isn't, the
// split was wrong.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");

const order = JSON.parse(readFileSync(join(SRC, "build-order.json"), "utf8"));
const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();

// Concatenate CSS files in manifest order.
const css = (order.css || [])
  .map(f => readFileSync(join(SRC, "styles", f), "utf8"))
  .join("");

// Concatenate JS files in manifest order, then inject the version.
// `replace` with a function callback avoids the $-substitution that
// happens with a literal-string replacement — important for byte-
// identical output if the JS contains $.
let js = (order.js || [])
  .map(f => readFileSync(join(SRC, f), "utf8"))
  .join("");
js = js.replace("/*__APP_VERSION__*/", () => JSON.stringify(version));

const shell = readFileSync(join(SRC, "shell.html"), "utf8");
const out = shell
  .replace("/*__INLINE_CSS__*/", () => css)
  .replace("/*__INLINE_JS__*/", () => js);

writeFileSync(join(ROOT, "gamma-node-editor.html"), out);

console.log(
  "built gamma-node-editor.html  " +
  (out.length / 1024 / 1024).toFixed(2) + " MB  " +
  "version " + version
);
