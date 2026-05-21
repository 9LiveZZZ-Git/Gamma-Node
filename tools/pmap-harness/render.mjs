// PMAP prompt-harness renderer.
//
// Drives gamma-node-editor.html in headless Chrome and uses its
// exported window.__PMAP API to:
//   1. Build a cell graph (default N=4000 for fast iteration)
//   2. Parse the supplied JSON plan
//   3. Apply the plan to the cells
//   4. Render an equirectangular preview (720x360)
//   5. Measure landmass and cap count
//   6. Save the PNG + metrics to disk
//
// Usage:
//   node render.mjs --plan runs/0001/plan.json --out runs/0001/result.png [--cells 4000] [--sealevel 20]
//
// Exits 0 on success. Writes a sibling .json with measurements.

import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { promises as fs } from "node:fs";
import puppeteer from "puppeteer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const EDITOR_PATH = resolve(REPO_ROOT, "gamma-node-editor.html");

function parseArgs(argv) {
  const args = { cells: 4000, sealevel: 0.5, mode: "biome" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--plan")      args.plan = argv[++i];
    else if (k === "--out")  args.out = argv[++i];
    else if (k === "--cells")    args.cells = +argv[++i];
    else if (k === "--sealevel") args.sealevel = +argv[++i];
    else if (k === "--landmass") args.mode = "landmass";
  }
  if (!args.plan || !args.out) {
    console.error("usage: node render.mjs --plan <path> --out <path.png> [--cells N] [--sealevel S] [--landmass]");
    console.error("  --landmass  binary land/ocean render (matches Azgaar style) instead of biome colors");
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const planJson = await fs.readFile(args.plan, "utf8");
  const planRawForLLM = planJson; // pass the raw text the LLM would emit

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    // Surface page console errors to our stderr so the agent sees them.
    page.on("pageerror", (err) => console.error("[page error]", err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        console.error("[page " + msg.type() + "]", msg.text());
      }
    });
    await page.goto("file:///" + EDITOR_PATH.replace(/\\/g, "/"), { waitUntil: "domcontentloaded" });
    // Wait up to 20 s for __PMAP to be exposed (the editor's script
    // runs the export at the very end, so this signals load is done).
    await page.waitForFunction(() => typeof window.__PMAP === "object" && window.__PMAP && typeof window.__PMAP.buildCells === "function", { timeout: 20000 });

    const result = await page.evaluate(async (planText, N, seaLevel, mode) => {
      const P = window.__PMAP;
      // Default noise + jitter values match the editor's PlanetMap node defaults.
      const noiseDef = { seed: 7.3, frequency: 1.0, octaves: 6, effectiveOctavesF: 6, lacunarity: 2.0, gain: 0.5, ridges: 0 };
      const jitter = 0.0;
      const t0 = performance.now();
      const cells = P.buildCells(N, noiseDef, jitter);
      // Zero the cells' base noise so we render PURE plan output --
      // the harness compares against reference heightmaps where the
      // LLM's caps + verbs are the only signal. Otherwise FBM noise
      // washes out the difference between iterations.
      cells.elevations.fill(0);
      const hash = P.buildHash(cells);
      const K = 16;
      const neighbors = P.buildNeighbors(cells, hash, K);
      const t1 = performance.now();

      let plan;
      try { plan = P.parsePlan(planText); }
      catch (e) { return { error: "parsePlan failed: " + e.message }; }
      P.applyPlan(plan, cells, neighbors, K, seaLevel, null);
      const t2 = performance.now();

      // Equirect render: lat (90..-90 top-to-bottom) on Y, lon (-180..+180) on X.
      const W = 720, H = 360;
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(W, H);
      const data = img.data;
      // Pre-build a pixel -> nearest-cell map by direct great-circle nearest using P.buildHash.
      // P doesn't expose findNearest, but we can compute it inline.
      const GRID = hash.GRID;
      const buckets = hash.buckets;
      function nearestCellDot(ux, uy, uz) {
        const ix0 = Math.max(0, Math.min(GRID - 1, Math.floor((ux + 1) * 0.5 * GRID)));
        const iy0 = Math.max(0, Math.min(GRID - 1, Math.floor((uy + 1) * 0.5 * GRID)));
        const iz0 = Math.max(0, Math.min(GRID - 1, Math.floor((uz + 1) * 0.5 * GRID)));
        let best = -1, bestDot = -2;
        for (let dx = -1; dx <= 1; dx++) {
          const ix = ix0 + dx; if (ix < 0 || ix >= GRID) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const iy = iy0 + dy; if (iy < 0 || iy >= GRID) continue;
            for (let dz = -1; dz <= 1; dz++) {
              const iz = iz0 + dz; if (iz < 0 || iz >= GRID) continue;
              const k = ix * GRID * GRID + iy * GRID + iz;
              const bucket = buckets.get(k);
              if (!bucket) continue;
              for (let b = 0; b < bucket.length; b++) {
                const ci = bucket[b];
                const dot = ux * cells.positions[ci*3] + uy * cells.positions[ci*3+1] + uz * cells.positions[ci*3+2];
                if (dot > bestDot) { bestDot = dot; best = ci; }
              }
            }
          }
        }
        if (best < 0) {
          for (let i = 0; i < cells.count; i++) {
            const dot = ux * cells.positions[i*3] + uy * cells.positions[i*3+1] + uz * cells.positions[i*3+2];
            if (dot > bestDot) { bestDot = dot; best = i; }
          }
        }
        return best;
      }
      for (let py = 0; py < H; py++) {
        const lat = (1 - (py + 0.5) / H) * 180 - 90;          // +90 at top
        const latR = lat * Math.PI / 180;
        const cy = Math.sin(latR);
        const cosLat = Math.cos(latR);
        for (let px = 0; px < W; px++) {
          const lon = ((px + 0.5) / W) * 360 - 180;
          const lonR = lon * Math.PI / 180;
          const ux = Math.cos(lonR) * cosLat;
          const uz = Math.sin(lonR) * cosLat;
          const cidx = nearestCellDot(ux, cy, uz);
          const elev = cells.elevations[cidx];
          let r, g, b;
          if (mode === "landmass") {
            // Binary land/ocean -- match Azgaar's heightmap-editor render
            // (light-blue/white land on dark-navy ocean) so visual
            // comparisons against the user's Fantasy Heightmaps are
            // like-for-like.
            if (elev >= seaLevel) { r = 0.92; g = 0.96; b = 0.99; }
            else                  { r = 0.05; g = 0.13; b = 0.30; }
          } else {
            const c = P.colorForHeight(elev, seaLevel);
            r = c[0]; g = c[1]; b = c[2];
          }
          const k = (py * W + px) * 4;
          data[k    ] = Math.max(0, Math.min(255, Math.round(r * 255)));
          data[k + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
          data[k + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
          data[k + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      const t3 = performance.now();

      const lm = P.measureLandmass(cells, seaLevel);
      // Cell elevation distribution (for log analysis).
      let lo = Infinity, hi = -Infinity, sum = 0, sumSq = 0, abovePeak = 0, aboveMtn = 0;
      for (let i = 0; i < cells.elevations.length; i++) {
        const v = cells.elevations[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sum += v;
        sumSq += v*v;
        if (v >= 70) aboveMtn++;
        if (v >= 90) abovePeak++;
      }
      const mean = sum / cells.elevations.length;
      const variance = sumSq / cells.elevations.length - mean*mean;

      return {
        pngDataUrl: canvas.toDataURL("image/png"),
        timings: { cells: +(t1 - t0).toFixed(1), apply: +(t2 - t1).toFixed(1), render: +(t3 - t2).toFixed(1) },
        capCount: plan.caps.length,
        landFraction: +lm.landFraction.toFixed(4),
        landCells: lm.landCells,
        totalCells: lm.totalCells,
        elev: {
          min: +lo.toFixed(2), max: +hi.toFixed(2), mean: +mean.toFixed(2),
          stddev: +Math.sqrt(Math.max(0, variance)).toFixed(2),
          aboveMountain: aboveMtn, aboveMountainPct: +(aboveMtn / cells.elevations.length * 100).toFixed(1),
          abovePeak: abovePeak, abovePeakPct: +(abovePeak / cells.elevations.length * 100).toFixed(1)
        },
        capSummaries: plan.caps.map(c => ({
          lat: c.lat, lon: c.lon, radiusDeg: c.radiusDeg,
          verbCount: String(c.verbs || "").split("\n").filter(s => s.trim()).length
        }))
      };
    }, planRawForLLM, args.cells, args.sealevel, args.mode);

    if (result.error) {
      console.error("[render] " + result.error);
      process.exit(3);
    }
    // Save PNG.
    const b64 = result.pngDataUrl.replace(/^data:image\/png;base64,/, "");
    await fs.writeFile(args.out, Buffer.from(b64, "base64"));
    // Save sibling metrics JSON.
    const metricsPath = args.out.replace(/\.png$/i, ".metrics.json");
    const metrics = { ...result };
    delete metrics.pngDataUrl;
    await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2));

    console.log(JSON.stringify({
      ok: true,
      out: args.out,
      metrics: metricsPath,
      capCount: result.capCount,
      landPct: +(result.landFraction * 100).toFixed(2),
      timings: result.timings,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
