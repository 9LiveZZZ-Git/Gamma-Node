// M2.6.5 mop-up: the remaining src/_monolith.tail.2.2.2.2.2.1.2.js is
// now 100% the single `_encodeShaderFragPassForPlan` function (the
// shader-frag encoder for the visual-graph render plan -- the
// counterpart to _buildRenderPlan, which feeds it the per-entry
// schedule).
//
// Rename the file to src/visual/shader-frag-pass.js and update the
// manifest. Pure relocation -- no content change, just a path move.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

const sourcePath = "src/_monolith.tail.2.2.2.2.2.1.2.js";
const targetPath = "src/visual/shader-frag-pass.js";

const src = readFileSync(sourcePath, "utf8");

// Sanity: the file should contain exactly _encodeShaderFragPassForPlan
// and no other top-level function. Loose check via leading content.
if (!src.includes("_encodeShaderFragPassForPlan")) {
  throw new Error("expected _encodeShaderFragPassForPlan in source file");
}

mkdirSync("src/visual", { recursive: true });
writeFileSync(targetPath, src);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.2.2.2.2.1.2.js");
if (idx < 0) throw new Error(`manifest entry not found: _monolith.tail.2.2.2.2.2.1.2.js`);
manifest.js.splice(idx, 1, "visual/shader-frag-pass.js");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync(sourcePath)) unlinkSync(sourcePath);

const fmt = n => n.toLocaleString();
console.log("M2.6.5 rename complete (pure relocation):");
console.log("  src/visual/shader-frag-pass.js", fmt(src.length).padStart(11), "bytes   <- _encodeShaderFragPassForPlan");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-shader-frag-before.html gamma-node-editor.html");
