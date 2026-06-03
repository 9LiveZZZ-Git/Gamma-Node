import { readFileSync } from "node:fs";
const h = readFileSync("gamma-node-editor.html", "utf8");

// Real </script> tags (NOT preceded by backslash, which would be the
// `<\/script>` escape used inside JS template strings).
const realClose = [];
{
  let i = 0;
  while ((i = h.indexOf("</script>", i)) >= 0) {
    if (h[i - 1] === "\\") { i += 1; continue; }
    realClose.push(i);
    i += 9;
  }
}
console.log("real </script> tags:", realClose.length);
for (const pos of realClose) {
  const line = h.slice(0, pos).split("\n").length;
  console.log("  </script> at byte", pos, "line", line);
}

// Real <script> opening tags (not backslash-escaped).
const realOpen = [];
{
  let i = 0;
  while ((i = h.indexOf("<script", i)) >= 0) {
    if (h[i - 1] === "\\") { i += 1; continue; }
    const e = h.indexOf(">", i);
    const tag = h.slice(i, e + 1);
    realOpen.push({ pos: i, end: e + 1, hasSrc: tag.includes("src="), tag });
    i = e + 1;
  }
}
const srcless = realOpen.filter(o => !o.hasSrc);
console.log("\nreal <script> tags:", realOpen.length, "(" + srcless.length + " without src=)");
for (const o of srcless) {
  const line = h.slice(0, o.pos).split("\n").length;
  console.log("  line", line, ":", o.tag.replace(/\s+/g, " ").slice(0, 80));
}

const inlineOpen = srcless[0];
const inlineClose = realClose[realClose.length - 1];
console.log("\nINLINE JS BLOCK:");
console.log("  opens at byte", inlineOpen.pos, "(content starts at", inlineOpen.end + ")");
console.log("  closes at byte", inlineClose);
console.log("  inline JS body length:", inlineClose - inlineOpen.end, "bytes");

// Style boundaries
const styleOpen = h.indexOf("<style>");
const styleClose = h.indexOf("</style>");
console.log("\nINLINE CSS BLOCK:");
console.log("  <style> at byte", styleOpen, "(content starts at", styleOpen + 7 + ")");
console.log("  </style> at byte", styleClose);
console.log("  CSS body length:", styleClose - (styleOpen + 7), "bytes");

// APP_VERSION line
const m = h.match(/const APP_VERSION = "[^"]+";/);
console.log("\nAPP_VERSION line:", m ? JSON.stringify(m[0]) : "NOT FOUND");
const versionFile = readFileSync("VERSION", "utf8").trim();
console.log("VERSION file    :", JSON.stringify(versionFile));
