// One-time setup for the prompt harness: downloads every reference
// image declared in PMAP_AI_REFERENCES (extracted from the editor)
// to refs/<key>.png so the iterating agent can Read them locally
// without re-fetching Wikimedia each iteration. Idempotent -- skips
// files already on disk unless --force.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promises as fs } from "node:fs";
import puppeteer from "puppeteer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const EDITOR_PATH = resolve(REPO_ROOT, "gamma-node-editor.html");
const REFS_DIR = resolve(__dirname, "refs");

async function main() {
  const force = process.argv.includes("--force");
  await fs.mkdir(REFS_DIR, { recursive: true });

  // Pull the references map from the editor via headless Chrome so we
  // don't duplicate the URL list. Same source of truth.
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto("file:///" + EDITOR_PATH.replace(/\\/g, "/"), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__PMAP && window.__PMAP.references, { timeout: 20000 });
  const refs = await page.evaluate(() => {
    const out = {};
    for (const k in window.__PMAP.references) {
      out[k] = window.__PMAP.references[k];
    }
    return out;
  });
  await browser.close();

  // Download each ref (server-side fetch, no CORS).
  const keys = Object.keys(refs);
  console.log("downloading " + keys.length + " reference images to refs/");
  let downloaded = 0, skipped = 0, failed = 0;
  for (const k of keys) {
    const ref = refs[k];
    const outPath = resolve(REFS_DIR, k + ".png");
    if (!force) {
      try { await fs.access(outPath); skipped++; continue; } catch {}
    }
    try {
      // Throttle to respect Wikimedia's rate limits (1.5 s between requests).
      await new Promise(r => setTimeout(r, 1500));
      const resp = await fetch(ref.url, { headers: { "User-Agent": "Gamma-Node-Editor/0.1 (https://github.com/9LiveZZZ-Git/Gamma-Node; lpfreiburg@ucsb.edu) PromptHarness/0.1" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const buf = Buffer.from(await resp.arrayBuffer());
      await fs.writeFile(outPath, buf);
      downloaded++;
      console.log("  ✓ " + k + " (" + buf.length + " bytes) -- " + ref.credit);
    } catch (e) {
      failed++;
      console.error("  ✗ " + k + ": " + e.message);
    }
  }
  // Write a manifest with credits for the journal / docs.
  const manifest = { downloadedAt: new Date().toISOString(), references: refs };
  await fs.writeFile(resolve(REFS_DIR, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
  console.log("done: " + downloaded + " downloaded, " + skipped + " skipped, " + failed + " failed");
}

main().catch((e) => { console.error(e); process.exit(1); });
