// Smoke test for the GeoJSON landmass stamper.
// Usage: node stamp-test.mjs --geojson <path> [--cells N] [--out PATH]

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promises as fs } from "node:fs";
import puppeteer from "puppeteer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const EDITOR_PATH = resolve(REPO_ROOT, "gamma-node-editor.html");

function parseArgs(argv) {
  const args = { cells: 8000, out: "stamp-test.png" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--geojson")    args.geojson = argv[++i];
    else if (k === "--cells") args.cells = +argv[++i];
    else if (k === "--out")   args.out = argv[++i];
  }
  if (!args.geojson) {
    console.error("usage: node stamp-test.mjs --geojson <path> [--cells N] [--out PATH]");
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const geoText = await fs.readFile(args.geojson, "utf8");

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => console.error("[page error]", err.message));
    page.on("console", (msg) => { if (msg.type() === "error" || msg.type() === "warning") console.error("[" + msg.type() + "]", msg.text()); });
    await page.goto("file:///" + EDITOR_PATH.replace(/\\/g, "/"), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__PMAP && window.__PMAP.stampGeoJSON, { timeout: 20000 });

    const result = await page.evaluate(async (geoText, N) => {
      const P = window.__PMAP;
      const noise = { seed: 7.3, frequency: 1.0, octaves: 6, effectiveOctavesF: 6, lacunarity: 2.0, gain: 0.5, ridges: 0 };
      const cells = P.buildCells(N, noise, 0);
      cells.elevations.fill(0);
      const hash = P.buildHash(cells);
      const K = 16;
      const neighbors = P.buildNeighbors(cells, hash, K);
      const seaLevel = 0.5;

      let geojson;
      try { geojson = JSON.parse(geoText); }
      catch (e) { return { error: "GeoJSON parse: " + e.message }; }

      const stats = await P.stampGeoJSON(geojson, cells, neighbors, K, seaLevel, () => {});
      // Elevation histogram so we can verify heights actually vary.
      let elevMin = Infinity, elevMax = -Infinity, sum = 0;
      const elevBuckets = { ocean: 0, sealevel: 0, low: 0, mid: 0, high: 0, peak: 0 };
      for (let i = 0; i < cells.count; i++) {
        const e = cells.elevations[i];
        if (e < elevMin) elevMin = e;
        if (e > elevMax) elevMax = e;
        sum += e;
        if (e < seaLevel * 0.5) elevBuckets.ocean++;
        else if (e < seaLevel) elevBuckets.sealevel++;
        else if (e < seaLevel + 0.1) elevBuckets.low++;
        else if (e < seaLevel + 0.25) elevBuckets.mid++;
        else if (e < seaLevel + 0.4) elevBuckets.high++;
        else elevBuckets.peak++;
      }
      stats.elev = { min: +elevMin.toFixed(3), max: +elevMax.toFixed(3), mean: +(sum / cells.count).toFixed(3), buckets: elevBuckets };

      // Render to equirect canvas in LANDMASS mode (binary land/ocean).
      const W = 720, H = 360;
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(W, H);
      const data = img.data;
      const buckets = hash.buckets, GRID = hash.GRID;
      function nearest(ux, uy, uz) {
        const ix0 = Math.max(0, Math.min(GRID - 1, Math.floor((ux + 1) * 0.5 * GRID)));
        const iy0 = Math.max(0, Math.min(GRID - 1, Math.floor((uy + 1) * 0.5 * GRID)));
        const iz0 = Math.max(0, Math.min(GRID - 1, Math.floor((uz + 1) * 0.5 * GRID)));
        let best = -1, bestDot = -2;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const ix = ix0 + dx, iy = iy0 + dy, iz = iz0 + dz;
          if (ix < 0 || ix >= GRID || iy < 0 || iy >= GRID || iz < 0 || iz >= GRID) continue;
          const b = buckets.get(ix * GRID * GRID + iy * GRID + iz);
          if (!b) continue;
          for (const ci of b) {
            const dot = ux * cells.positions[ci*3] + uy * cells.positions[ci*3+1] + uz * cells.positions[ci*3+2];
            if (dot > bestDot) { bestDot = dot; best = ci; }
          }
        }
        return best;
      }
      for (let py = 0; py < H; py++) {
        const lat = (1 - (py + 0.5) / H) * 180 - 90;
        const latR = lat * Math.PI / 180;
        const cy = Math.sin(latR), cosLat = Math.cos(latR);
        for (let px = 0; px < W; px++) {
          const lon = ((px + 0.5) / W) * 360 - 180;
          const lonR = lon * Math.PI / 180;
          const ci = nearest(Math.cos(lonR) * cosLat, cy, Math.sin(lonR) * cosLat);
          const e = cells.elevations[ci];
          let r, g, b;
          if (e >= seaLevel) { r = 0.92; g = 0.96; b = 0.99; }
          else                { r = 0.05; g = 0.13; b = 0.30; }
          const k = (py * W + px) * 4;
          data[k] = r * 255 | 0; data[k+1] = g * 255 | 0; data[k+2] = b * 255 | 0; data[k+3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      return { stats, png: canvas.toDataURL("image/png") };
    }, geoText, args.cells);

    if (result.error) {
      console.error("[stamp-test]", result.error);
      process.exit(3);
    }
    const b64 = result.png.replace(/^data:image\/png;base64,/, "");
    await fs.writeFile(args.out, Buffer.from(b64, "base64"));
    console.log(JSON.stringify({ ok: true, out: args.out, ...result.stats }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
