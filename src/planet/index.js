/* §planet-spec Phase 4.c -- camera position for the Planet's
 * quadtree split. Mirrors _tiledTerrainAnchor but in 3D: prefers
 * FPCamera, falls back to any Camera. The Planet is assumed centered
 * at the world origin (no Translate wrapping yet); future origin-
 * shifting RTC anchors will subtract the planet center here. */
function _planetCameraPos(node) {
  if (state && Array.isArray(state.nodes)) {
    const fpc = state.nodes.find(n => n && n.type === "FPCamera");
    const cam = fpc || state.nodes.find(n => n && n.type === "Camera");
    if (cam && cam.params) {
      return {
        x: (typeof cam.params.posX === "number") ? cam.params.posX : 0,
        y: (typeof cam.params.posY === "number") ? cam.params.posY : 0,
        z: (typeof cam.params.posZ === "number") ? cam.params.posZ : 0
      };
    }
  }
  // Fall back to a "no camera, show coarse 6-root quadtree" position:
  // sit a few radii away on +Z. Not great but keeps the demo browsable
  // before a camera is wired.
  const p = node && node.params ? node.params : {};
  const r = (typeof p.radius === "number") ? p.radius : 1000;
  return { x: 0, y: 0, z: r * 3 };
}

/* Phil Nowell spherified-cube warp on a single point. Pulled out as
 * a helper so the chunk-split center calculation matches what the
 * vertex builder writes. Pass cube-face position in [-1, 1]^3,
 * receive unit-sphere position. */
/* §planet-spec Phase 5+ -- find a Planet node in the patch and
 * return its center + radius + polRatio for sphere-projection of
 * other mesh-gen nodes (TiledTerrain, Water, Clouds3D). Returns null
 * if no Planet is wired -- callers fall back to flat-XZ behavior so
 * non-planet patches (Walkable Terrain etc.) keep working unchanged. */
function _findPlanetForProjection() {
  if (!state || !Array.isArray(state.nodes)) return null;
  const pl = state.nodes.find(n => n && n.type === "Planet");
  if (!pl || !pl.params) return null;
  const r = (typeof pl.params.radius === "number") ? pl.params.radius : 1000;
  return {
    cx: (typeof pl.params.centerX === "number") ? pl.params.centerX : 0,
    cy: (typeof pl.params.centerY === "number") ? pl.params.centerY : 0,
    cz: (typeof pl.params.centerZ === "number") ? pl.params.centerZ : 0,
    r:  r,
    polRatio: Math.max(0.5, Math.min(1.5, (typeof pl.params.polarRadiusRatio === "number") ? pl.params.polarRadiusRatio : 1.0))
  };
}

/* §planet-spec Phase 5+ -- project a flat-XZ world position onto the
 * Planet's actual sphere. The spawn point at world (0, 0, 0) is treated
 * as the planet's pole (unit_vec (0, 1, 0)). A vertex at world (wx, y,
 * wz) is on the planet's sphere at lat/lon corresponding to arc-length
 * offset (wx, wz) from the pole, at altitude y above the surface.
 *
 * Oblate planets (polRatio < 1) compress the sphere SURFACE on Y, but
 * altitude added above the surface is NOT scaled -- a 1700m spawn is
 * 1700m above the surface regardless of polRatio. The previous version
 * multiplied the full radial position by polRatio, which caused a
 * (1-polRatio)*r ≈ 21km drop on Earth-radius planets. Surface point
 * is computed in ellipsoid coords; altitude added along radial unit
 * vector (a close approximation to the true ellipsoid surface normal
 * for y << r).
 *
 * planet = { cx, cy, cz, r, polRatio }. Returns [x, y, z]. */
function _projectFlatToPlanet(wx, y, wz, planet) {
  const d = Math.sqrt(wx * wx + wz * wz);
  let ux, uy, uz;
  if (d < 1e-6) {
    ux = 0; uy = 1; uz = 0;
  } else {
    const theta = d / planet.r;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    ux = st * wx / d;
    uy = ct;
    uz = st * wz / d;
  }
  // Ellipsoid surface point.
  const sx = planet.cx + planet.r * ux;
  const sy = planet.cy + planet.r * uy * planet.polRatio;
  const sz = planet.cz + planet.r * uz;
  // Altitude along radial direction, unscaled.
  return [
    sx + y * ux,
    sy + y * uy,
    sz + y * uz
  ];
}

function _planetSpherify(cx, cy, cz) {
  const cxx = cx * cx, cyy = cy * cy, czz = cz * cz;
  const sx = cx * Math.sqrt(Math.max(0, 1 - cyy * 0.5 - czz * 0.5 + cyy * czz / 3));
  const sy = cy * Math.sqrt(Math.max(0, 1 - cxx * 0.5 - czz * 0.5 + cxx * czz / 3));
  const sz = cz * Math.sqrt(Math.max(0, 1 - cxx * 0.5 - cyy * 0.5 + cxx * cyy / 3));
  const invLen = 1 / Math.max(1e-12, Math.sqrt(sx*sx + sy*sy + sz*sz));
  return [sx * invLen, sy * invLen, sz * invLen];
}

/* §planet-spec Phase 7.d-azgaar -- triangulate the spherical cell
 * graph by walking the K-nearest-neighbor table. Mirrors how Azgaar's
 * 3D scene mode renders his 2D grid: each cell becomes ONE vertex,
 * triangles connect mutually-adjacent cells. Result: a mesh with N
 * vertices and ~2N triangles (N = cellCount) where each vertex's
 * elevation maps DIRECTLY to its cell's h -- no smoothing, no cubemap
 * rasterization, no per-chunk oversampling. Peaks pop because each
 * peak cell IS one vertex with its own elevation, not a 92km-wide
 * plateau.
 *
 * Algorithm: for each cell i, for each pair of its neighbors (n1, n2)
 * where i < n1 < n2 and n2 is also in n1's neighbor list, emit a
 * triangle. The strict ordering guarantees each triangle emits once.
 * Winding fixed to CCW-from-outside via cross-product sign check
 * against i's radial direction (= i's position on the unit sphere).
 *
 * Misses some Delaunay triangles when a true Delaunay neighbor isn't
 * in the K=6 nearest list (rare for well-distributed Fibonacci
 * points). Result is "mostly correct" with occasional small holes
 * far from the camera. Spherical-Delaunay-via-stereographic would be
 * the rigorous fix; this is the simple approximation. */
function _buildCellTriangulation(positions, neighbors, K, N, hash) {
  // Proper spherical Delaunay triangulation in two passes:
  //
  //  Pass 1 -- Voronoi-edge test. For each candidate edge (i, j) in
  //  i's K-nearest, compute the spherical midpoint M = normalize(i+j)
  //  on the unit sphere. dot(i, M) = dot(j, M) (i and j equidistant
  //  from M by symmetry). The edge (i, j) is a Voronoi edge iff no
  //  other cell c is closer to M than i is, i.e. dot(c, M) <=
  //  dot(i, M) for all c. We check this against i's K-nearest AND
  //  j's K-nearest -- those are the only candidates that could
  //  possibly be closer. Voronoi-edge implies BOTH cells lie on
  //  each other's boundary, so the test is symmetric (no asymmetric-
  //  K-nearest problem like the earlier emit-everything approach).
  //
  //  Pass 2 -- Per-cell fan triangulation. For each cell i, sort its
  //  Voronoi neighbors by azimuth in i's local tangent plane. Emit a
  //  triangle for each consecutive pair (n1, n2) of sorted neighbors,
  //  guarded by i < n1 && i < n2 to ensure each triangle emits
  //  exactly once (from the smallest-index vertex's fan). Winding
  //  fixed to CCW-from-outside via the cross-product check.
  //
  //  Result: ~120k triangles at N=60k (matches sphere topology
  //  2(N-2) ≈ 2N) without the spike-fin artifacts the naive emit-
  //  all-pairs approach produced.

  // ---- Pass 1: Voronoi adjacency lists ----
  //
  // Two-stage rejection per candidate edge (i, j):
  //
  //   Stage A -- angular-distance pre-filter. True Voronoi neighbors
  //   on Fibonacci-distributed points are at distance ≤ ~3× the
  //   typical cell spacing (worst case for Voronoi). Anything farther
  //   is definitely not a Voronoi edge. Reject early.
  //
  //   Stage B -- empty-circle test at the spherical midpoint M.
  //   Check cells in:
  //     - i's K-nearest (catches close interlopers near i)
  //     - j's K-nearest (catches close interlopers near j)
  //     - 3³ spatial-hash buckets around M (catches interlopers near
  //       M itself -- CRITICAL for any non-tiny edge, otherwise long
  //       fake edges pass when their midpoint sits in a region not
  //       in either endpoint's K-nearest)
  //
  // Prior bug: only checked i's & j's K-nearest. For a long edge,
  // those neighbors all cluster near the endpoints, far from M, so
  // they don't fail the test. The edge was accepted as Voronoi →
  // spike-fin triangle. Spatial-hash-near-M fixes this.
  const typicalAngular = Math.sqrt(4 * Math.PI / N);
  const cosMaxEdge = Math.cos(3 * typicalAngular);  // reject edges with dot(i,j) < this
  // 1e-9 was too tight: Fibonacci has many near-equidistant
  // candidates and float-precision noise made the empty-circle test
  // reject genuine Voronoi edges. 1e-6 ≈ ~0.1° tolerance, well
  // below the ~0.8° typical-cell-spacing.
  const slack = 1e-6;
  let candCount = 0, rejPre = 0, rejI = 0, rejJ = 0, rejM = 0, accepted = 0;
  const GRID = hash.GRID;
  const vAdj = new Array(N);
  for (let i = 0; i < N; i++) vAdj[i] = [];
  for (let i = 0; i < N; i++) {
    const ix = positions[i * 3 + 0];
    const iy = positions[i * 3 + 1];
    const iz = positions[i * 3 + 2];
    for (let k = 0; k < K; k++) {
      const j = neighbors[i * K + k];
      if (j < 0 || j === i) continue;
      // K-nearest is asymmetric on Fibonacci: edge {i,j} can have
      // j ∈ N(i) but i ∉ N(j), or vice-versa. The old j<=i skip lost
      // edges in Case 3 (j ∉ N(i), i ∈ N(j)) because outer=i didn't
      // see j AND outer=j saw i but bailed on i<=j. Now we process
      // every directed candidate; the includes-check below dedupes
      // so each unordered edge runs the Voronoi check at most once.
      const vAdjI = vAdj[i];
      let already = false;
      for (let q = 0; q < vAdjI.length; q++) {
        if (vAdjI[q] === j) { already = true; break; }
      }
      if (already) continue;
      candCount++;
      const jx = positions[j * 3 + 0];
      const jy = positions[j * 3 + 1];
      const jz = positions[j * 3 + 2];
      const dotIJ = ix * jx + iy * jy + iz * jz;
      if (dotIJ < cosMaxEdge) { rejPre++; continue; }
      let mx = ix + jx, my = iy + jy, mz = iz + jz;
      const ml = Math.sqrt(mx*mx + my*my + mz*mz);
      if (ml < 1e-9) continue;
      const mlinv = 1 / ml;
      mx *= mlinv; my *= mlinv; mz *= mlinv;
      const dotIM = ix * mx + iy * my + iz * mz;
      let isVoronoi = true;
      let rejBy = 0;
      for (let k2 = 0; k2 < K; k2++) {
        const c = neighbors[i * K + k2];
        if (c < 0 || c === j) continue;
        const dotCM = positions[c*3]*mx + positions[c*3+1]*my + positions[c*3+2]*mz;
        if (dotCM > dotIM + slack) { isVoronoi = false; rejBy = 1; break; }
      }
      if (isVoronoi) {
        for (let k2 = 0; k2 < K; k2++) {
          const c = neighbors[j * K + k2];
          if (c < 0 || c === i) continue;
          const dotCM = positions[c*3]*mx + positions[c*3+1]*my + positions[c*3+2]*mz;
          if (dotCM > dotIM + slack) { isVoronoi = false; rejBy = 2; break; }
        }
      }
      if (isVoronoi) {
        const mix = Math.max(0, Math.min(GRID - 1, Math.floor((mx + 1) * 0.5 * GRID)));
        const miy = Math.max(0, Math.min(GRID - 1, Math.floor((my + 1) * 0.5 * GRID)));
        const miz = Math.max(0, Math.min(GRID - 1, Math.floor((mz + 1) * 0.5 * GRID)));
        outer: for (let dx = -1; dx <= 1; dx++) {
          const bx = mix + dx; if (bx < 0 || bx >= GRID) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const by = miy + dy; if (by < 0 || by >= GRID) continue;
            for (let dz = -1; dz <= 1; dz++) {
              const bz = miz + dz; if (bz < 0 || bz >= GRID) continue;
              const bk = bx * GRID * GRID + by * GRID + bz;
              const bucket = hash.buckets.get(bk);
              if (!bucket) continue;
              for (let b = 0; b < bucket.length; b++) {
                const c = bucket[b];
                if (c === i || c === j) continue;
                const dotCM = positions[c*3]*mx + positions[c*3+1]*my + positions[c*3+2]*mz;
                if (dotCM > dotIM + slack) { isVoronoi = false; rejBy = 3; break outer; }
              }
            }
          }
        }
      }
      if (!isVoronoi) {
        if (rejBy === 1) rejI++;
        else if (rejBy === 2) rejJ++;
        else rejM++;
      } else {
        accepted++;
        vAdj[i].push(j);
        vAdj[j].push(i);
      }
    }
  }
  console.log("[planet-mesh] voronoi-edge stats: cands=" + candCount + " rejPre=" + rejPre + " rejI=" + rejI + " rejJ=" + rejJ + " rejM=" + rejM + " accepted=" + accepted);

  // ---- Brute-force fallback for low-degree cells ----
  // Some edges between cells where NEITHER cell is in the other's
  // K-nearest get missed entirely (especially with cell jitter
  // creating local density variations). For each cell with deg < 5
  // after the main pass, brute-force-scan all N cells to find
  // potential missing Voronoi neighbors. O(low_deg × N × K) for the
  // empty-circle re-test, ~few seconds at N=240k -- worth it to
  // close the hole-cluster.
  {
    const lowDegInit = [];
    for (let i = 0; i < N; i++) if (vAdj[i].length < 5) lowDegInit.push(i);
    const lowDegCount = lowDegInit.length;
    let bfRecovered = 0;
    if (lowDegCount > 0) {
      const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
      const bfTopK = 30;  // examine the closest 30 cells for each low-deg cell
      const bfCand = [];
      for (let lc = 0; lc < lowDegInit.length; lc++) {
        const i = lowDegInit[lc];
        const ix = positions[i*3+0], iy = positions[i*3+1], iz = positions[i*3+2];
        // Find true 30 nearest by brute scan.
        bfCand.length = 0;
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const d = ix*positions[j*3] + iy*positions[j*3+1] + iz*positions[j*3+2];
          if (d > cosMaxEdge) bfCand.push({ idx: j, dot: d });
        }
        bfCand.sort(function(a, b) { return b.dot - a.dot; });
        const limit = Math.min(bfTopK, bfCand.length);
        for (let q = 0; q < limit; q++) {
          const j = bfCand[q].idx;
          // Skip if edge already exists.
          let already = false;
          for (let kk = 0; kk < vAdj[i].length; kk++) {
            if (vAdj[i][kk] === j) { already = true; break; }
          }
          if (already) continue;
          // Empty-circle test against ALL cells (brute, expensive but
          // bounded to the lowDegCount × bfTopK iterations).
          const jx = positions[j*3+0], jy = positions[j*3+1], jz = positions[j*3+2];
          let mx = ix + jx, my = iy + jy, mz = iz + jz;
          const ml = Math.sqrt(mx*mx + my*my + mz*mz);
          if (ml < 1e-9) continue;
          const mlinv = 1 / ml;
          mx *= mlinv; my *= mlinv; mz *= mlinv;
          const dotIM = ix*mx + iy*my + iz*mz;
          // Find any falsifier in N(i), N(j), and a SMALL local scan
          // around M; same checks as Pass 1, just confirming.
          let isVoronoi = true;
          for (let k2 = 0; k2 < K && isVoronoi; k2++) {
            const c = neighbors[i * K + k2];
            if (c < 0 || c === j) continue;
            const dotCM = positions[c*3]*mx + positions[c*3+1]*my + positions[c*3+2]*mz;
            if (dotCM > dotIM + slack) isVoronoi = false;
          }
          for (let k2 = 0; k2 < K && isVoronoi; k2++) {
            const c = neighbors[j * K + k2];
            if (c < 0 || c === i) continue;
            const dotCM = positions[c*3]*mx + positions[c*3+1]*my + positions[c*3+2]*mz;
            if (dotCM > dotIM + slack) isVoronoi = false;
          }
          if (isVoronoi) {
            // Brute falsifier search: scan all candidates for any closer cell to M
            for (let q2 = 0; q2 < bfCand.length && isVoronoi; q2++) {
              const c = bfCand[q2].idx;
              if (c === j) continue;
              const dotCM = positions[c*3]*mx + positions[c*3+1]*my + positions[c*3+2]*mz;
              if (dotCM > dotIM + slack) isVoronoi = false;
            }
          }
          if (isVoronoi) {
            vAdj[i].push(j);
            vAdj[j].push(i);
            bfRecovered++;
          }
        }
      }
      const dt = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;
      console.log("[planet-mesh] brute-force fallback: " + lowDegCount + " low-deg cells scanned in " + dt.toFixed(0) + "ms, recovered " + bfRecovered + " edges");
    }
  }

  // ---- Degree-distribution diagnostic ----
  // Voronoi cells on a sphere should have avg degree (3N-6)*2/N ≈ 6.
  // Cells with degree < 5 are under-connected -> likely sources of
  // triangle holes.
  {
    const degHist = new Array(20).fill(0);
    const lowDegCells = [];
    let degMax = 0, sumDeg = 0;
    for (let i = 0; i < N; i++) {
      const d = vAdj[i].length;
      sumDeg += d;
      if (d > degMax) degMax = d;
      if (d < degHist.length) degHist[d]++;
      if (d < 5) {
        lowDegCells.push({
          i: i, deg: d,
          x: positions[i*3], y: positions[i*3+1], z: positions[i*3+2]
        });
      }
    }
    const avgDeg = sumDeg / N;
    let histStr = "";
    for (let d = 0; d < 12; d++) histStr += "d" + d + "=" + degHist[d] + " ";
    console.log("[planet-mesh] degree histogram: " + histStr + "avg=" + avgDeg.toFixed(3) + " max=" + degMax + " #low(<5)=" + lowDegCells.length);

    // Lat/lon 2D histogram: 6 lat bands × 6 lon bands = 36 cells
    // lat bands: [-90, -60), [-60, -30), [-30, 0), [0, 30), [30, 60), [60, 90]
    // lon bands: [-180, -120), [-120, -60), [-60, 0), [0, 60), [60, 120), [120, 180]
    if (lowDegCells.length > 0) {
      const latLonHist = []; for (let r = 0; r < 6; r++) { latLonHist[r] = [0,0,0,0,0,0]; }
      for (let k = 0; k < lowDegCells.length; k++) {
        const c = lowDegCells[k];
        const lat = Math.asin(Math.max(-1, Math.min(1, c.y))) * 180 / Math.PI;
        const lon = Math.atan2(c.z, c.x) * 180 / Math.PI;
        const latBand = Math.max(0, Math.min(5, Math.floor((lat + 90) / 30)));
        const lonBand = Math.max(0, Math.min(5, Math.floor((lon + 180) / 60)));
        latLonHist[latBand][lonBand]++;
      }
      console.log("[planet-mesh] low-deg cells by lat × lon (6×6 grid, 30°×60° bins):");
      console.log("  lat\\lon  -180..-120  -120..-60  -60..0  0..60  60..120  120..180");
      const latLabels = ["-90..-60", "-60..-30", "-30..0  ", "0..30   ", "30..60  ", "60..90  "];
      for (let r = 5; r >= 0; r--) {
        let row = "  " + latLabels[r] + "  ";
        for (let cc = 0; cc < 6; cc++) {
          row += "    " + String(latLonHist[r][cc]).padStart(3);
        }
        console.log(row);
      }
    }

    // ---- Single-cell trace: pick first deg=0 cell, dump its 12 K-nearest
    // and the Voronoi-test outcome for each. Reveals exactly why every
    // edge from this cell is being rejected. ----
    let traceCell = -1;
    for (let i = 0; i < N; i++) { if (vAdj[i].length === 0) { traceCell = i; break; } }
    if (traceCell < 0) {
      for (let i = 0; i < N; i++) { if (vAdj[i].length < 3) { traceCell = i; break; } }
    }
    if (traceCell >= 0) {
      const i = traceCell;
      const ix = positions[i*3], iy = positions[i*3+1], iz = positions[i*3+2];
      const lat = Math.asin(iy) * 180 / Math.PI, lon = Math.atan2(iz, ix) * 180 / Math.PI;
      console.log("[planet-mesh] trace cell " + i + " deg=" + vAdj[i].length + " pos=(" + ix.toFixed(4) + "," + iy.toFixed(4) + "," + iz.toFixed(4) + ") lat=" + lat.toFixed(1) + "° lon=" + lon.toFixed(1) + "°");
      console.log("  cosMaxEdge=" + cosMaxEdge.toFixed(6) + " (= reject if dot(i,j) < this) typicalAng=" + typicalAngular.toFixed(6) + " rad = " + (typicalAngular*180/Math.PI).toFixed(3) + "°");

      // Brute-force the TRUE K-nearest by scanning all N cells. Compare
      // against what _buildCellNeighbors returned to confirm whether the
      // spatial-hash scan is dropping cells.
      const bfBest = [];
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const d = ix*positions[j*3] + iy*positions[j*3+1] + iz*positions[j*3+2];
        bfBest.push({ idx: j, dot: d });
      }
      bfBest.sort(function(a, b) { return b.dot - a.dot; });
      const trueK = bfBest.slice(0, K);
      let trueKStr = "  TRUE K-nearest (brute-force, N=" + N + "): ";
      for (let q = 0; q < trueK.length; q++) {
        const ang = Math.acos(Math.max(-1, Math.min(1, trueK[q].dot))) * 180 / Math.PI;
        trueKStr += trueK[q].idx + "@" + ang.toFixed(3) + "° ";
      }
      console.log(trueKStr);
      let hashKStr = "  HASH K-nearest (what _buildCellNeighbors gave): ";
      for (let q = 0; q < K; q++) {
        const j = neighbors[i*K+q];
        if (j < 0) { hashKStr += "-1 "; continue; }
        const d = ix*positions[j*3] + iy*positions[j*3+1] + iz*positions[j*3+2];
        const ang = Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
        hashKStr += j + "@" + ang.toFixed(3) + "° ";
      }
      console.log(hashKStr);
      // Diff: which TRUE neighbors are missing from HASH?
      const hashSet = new Set();
      for (let q = 0; q < K; q++) { const j = neighbors[i*K+q]; if (j >= 0) hashSet.add(j); }
      const missing = trueK.filter(function(t) { return !hashSet.has(t.idx); });
      if (missing.length > 0) {
        let mStr = "  *** HASH MISSED " + missing.length + " of top " + K + " true neighbors: ";
        for (let q = 0; q < missing.length; q++) {
          const m = missing[q];
          const mx = positions[m.idx*3], my = positions[m.idx*3+1], mz = positions[m.idx*3+2];
          const mbx = Math.max(0, Math.min(GRID - 1, Math.floor((mx + 1) * 0.5 * GRID)));
          const mby = Math.max(0, Math.min(GRID - 1, Math.floor((my + 1) * 0.5 * GRID)));
          const mbz = Math.max(0, Math.min(GRID - 1, Math.floor((mz + 1) * 0.5 * GRID)));
          const ang = Math.acos(Math.max(-1, Math.min(1, m.dot))) * 180 / Math.PI;
          mStr += m.idx + "@" + ang.toFixed(3) + "°(bucket " + mbx + "," + mby + "," + mbz + ") ";
        }
        console.log(mStr);
        // Also log the trace cell's own bucket for comparison.
        const ibx = Math.max(0, Math.min(GRID - 1, Math.floor((ix + 1) * 0.5 * GRID)));
        const iby = Math.max(0, Math.min(GRID - 1, Math.floor((iy + 1) * 0.5 * GRID)));
        const ibz = Math.max(0, Math.min(GRID - 1, Math.floor((iz + 1) * 0.5 * GRID)));
        console.log("  trace cell " + i + " is in bucket (" + ibx + "," + iby + "," + ibz + ")");
      }
      for (let k = 0; k < K; k++) {
        const j = neighbors[i * K + k];
        if (j < 0) { console.log("  k=" + k + " j=-1 (empty slot)"); continue; }
        const jx = positions[j*3], jy = positions[j*3+1], jz = positions[j*3+2];
        const dotIJ = ix*jx + iy*jy + iz*jz;
        const ang = Math.acos(Math.max(-1, Math.min(1, dotIJ))) * 180 / Math.PI;
        let verdict;
        if (dotIJ < cosMaxEdge) {
          verdict = "REJECT prefilter (dot=" + dotIJ.toFixed(6) + " < " + cosMaxEdge.toFixed(6) + ", ang=" + ang.toFixed(3) + "°)";
        } else {
          // Re-run the empty-circle test, find first falsifier
          let mx = ix+jx, my = iy+jy, mz = iz+jz;
          const ml = Math.sqrt(mx*mx+my*my+mz*mz); mx/=ml; my/=ml; mz/=ml;
          const dotIM = ix*mx+iy*my+iz*mz;
          let falsifier = -1, falsifierAdv = 0, falsifierSrc = "";
          for (let k2 = 0; k2 < K && falsifier < 0; k2++) {
            const c = neighbors[i*K+k2];
            if (c < 0 || c === j) continue;
            const dotCM = positions[c*3]*mx + positions[c*3+1]*my + positions[c*3+2]*mz;
            if (dotCM > dotIM + slack) { falsifier = c; falsifierAdv = dotCM - dotIM; falsifierSrc = "N(i)"; }
          }
          for (let k2 = 0; k2 < K && falsifier < 0; k2++) {
            const c = neighbors[j*K+k2];
            if (c < 0 || c === i) continue;
            const dotCM = positions[c*3]*mx + positions[c*3+1]*my + positions[c*3+2]*mz;
            if (dotCM > dotIM + slack) { falsifier = c; falsifierAdv = dotCM - dotIM; falsifierSrc = "N(j)"; }
          }
          if (falsifier >= 0) {
            const fx = positions[falsifier*3], fy = positions[falsifier*3+1], fz = positions[falsifier*3+2];
            const fLat = Math.asin(fy)*180/Math.PI, fLon = Math.atan2(fz,fx)*180/Math.PI;
            verdict = "REJECT by " + falsifierSrc + " falsifier=" + falsifier + " adv=" + falsifierAdv.toExponential(2) + " falsifierLat=" + fLat.toFixed(1) + "° lon=" + fLon.toFixed(1) + "°";
          } else {
            verdict = "ACCEPT (but vAdj says rejected -- bug in M-bucket scan?)";
          }
        }
        console.log("  k=" + k + " j=" + j + " ang=" + ang.toFixed(3) + "° " + verdict);
      }
    }
  }

  // ---- Pass 2: azimuth-fan triangulation around each cell ----
  //
  // Replaces the older 3-cycle enumeration. 3-cycle only emits a
  // triangle when all 3 edges already exist in vAdj, so quads /
  // pentagons / hexagons (polygonal faces in the Voronoi graph
  // where some "diagonal" edge failed the empty-circle test) show
  // up as visible holes in the mesh. With jitter creating many
  // near-cocircular configurations, this is a real loss (~18k
  // missing triangles at N=240k).
  //
  // Fan approach: for each cell i, sort vAdj[i] by azimuth around
  // i (using world +Y as the north reference, +X near the poles).
  // Emit a triangle for each consecutive pair (incl. wrap-around).
  // Dedup via min/mid/max key so each triangle emits once across
  // the three vertices that fan to it. This naturally triangulates
  // any polygonal face -- a quad gets a fan from each vertex, after
  // dedup we keep one valid split. Mathematically not pure Voronoi
  // for those faces, but visually closes the holes.
  const triKeys = new Set();
  const tris = [];
  for (let i = 0; i < N; i++) {
    const vNbrs = vAdj[i];
    const len = vNbrs.length;
    if (len < 3) continue;
    const ix = positions[i * 3 + 0];
    const iy = positions[i * 3 + 1];
    const iz = positions[i * 3 + 2];
    // Local tangent basis at cell i (north ref world +Y, fallback +X).
    let nrx = 0, nry = 1, nrz = 0;
    if (Math.abs(iy) > 0.95) { nrx = 1; nry = 0; nrz = 0; }
    const nDotU = nrx*ix + nry*iy + nrz*iz;
    let tnx = nrx - ix*nDotU, tny = nry - iy*nDotU, tnz = nrz - iz*nDotU;
    const tnl = Math.hypot(tnx, tny, tnz) || 1;
    tnx /= tnl; tny /= tnl; tnz /= tnl;
    // east = up × north (right-handed tangent)
    const tex = iy*tnz - iz*tny, tey = iz*tnx - ix*tnz, tez = ix*tny - iy*tnx;
    // Compute azimuth per neighbor.
    const azs = new Float32Array(len);
    for (let q = 0; q < len; q++) {
      const n = vNbrs[q];
      const dx = positions[n*3]   - ix;
      const dy = positions[n*3+1] - iy;
      const dz = positions[n*3+2] - iz;
      const dotE = dx*tex + dy*tey + dz*tez;
      const dotN = dx*tnx + dy*tny + dz*tnz;
      azs[q] = Math.atan2(dotE, dotN);
    }
    // Argsort by azimuth (small arrays, insertion sort).
    const order = new Int32Array(len);
    for (let q = 0; q < len; q++) order[q] = q;
    for (let q = 1; q < len; q++) {
      const t = order[q]; const ta = azs[t];
      let p = q - 1;
      while (p >= 0 && azs[order[p]] > ta) { order[p+1] = order[p]; p--; }
      order[p+1] = t;
    }
    // Emit triangles (i, n_k, n_{k+1}) wrapping around.
    for (let k = 0; k < len; k++) {
      const a = vNbrs[order[k]];
      const b = vNbrs[order[(k+1) % len]];
      const v0 = i, v1 = a, v2 = b;
      // Dedup key: sorted (min, mid, max).
      let mn, md, mx;
      if (v0 < v1) { if (v1 < v2) { mn=v0; md=v1; mx=v2; }
                    else if (v0 < v2) { mn=v0; md=v2; mx=v1; }
                    else              { mn=v2; md=v0; mx=v1; } }
      else        { if (v0 < v2) { mn=v1; md=v0; mx=v2; }
                    else if (v1 < v2) { mn=v1; md=v2; mx=v0; }
                    else              { mn=v2; md=v1; mx=v0; } }
      // Use BigInt key to avoid collisions at large N
      const key = mn + "," + md + "," + mx;
      if (triKeys.has(key)) continue;
      triKeys.add(key);
      // CCW winding from outside.
      const e01x = positions[a*3]   - ix;
      const e01y = positions[a*3+1] - iy;
      const e01z = positions[a*3+2] - iz;
      const e02x = positions[b*3]   - ix;
      const e02y = positions[b*3+1] - iy;
      const e02z = positions[b*3+2] - iz;
      const cxn = e01y * e02z - e01z * e02y;
      const cyn = e01z * e02x - e01x * e02z;
      const czn = e01x * e02y - e01y * e02x;
      const outward = cxn * ix + cyn * iy + czn * iz;
      if (outward >= 0) tris.push(i, a, b);
      else              tris.push(i, b, a);
    }
  }
  return new Uint32Array(tris);
}

/* Cube-face basis lookup (n, t, b) for face 0..5. Same axes as
 * _buildPlanet's `faces[]` table. Pulled into a top-level constant so
 * the chunk-set helper and the builder agree. */
const _PLANET_FACES = [
  { n: [ 1, 0, 0], t: [0, 0,-1], b: [0, 1, 0] }, // +X
  { n: [-1, 0, 0], t: [0, 0, 1], b: [0, 1, 0] }, // -X
  { n: [ 0, 1, 0], t: [1, 0, 0], b: [0, 0, 1] }, // +Y
  { n: [ 0,-1, 0], t: [1, 0, 0], b: [0, 0,-1] }, // -Y
  { n: [ 0, 0, 1], t: [1, 0, 0], b: [0, 1, 0] }, // +Z
  { n: [ 0, 0,-1], t: [-1,0, 0], b: [0, 1, 0] }  // -Z
];

/* §planet-spec Phase 7.a -- PlanetMap cubemap bake + sample.
 *
 * A PlanetMap node owns a 6-face cubemap of normalized fBm heights.
 * Faces are indexed 0..5 matching _PLANET_FACES. Each face is a
 * resolution×resolution Float32Array; texel (ix, iy) covers (u, v) ∈
 * [-1, 1]² where u = (ix + 0.5) / res * 2 - 1, same for v. The
 * spherify warp maps that face position to a unit-sphere direction;
 * we sample _terrainFBM3D at that direction with the node's noise
 * params and store the result.
 *
 * Sampling (used by Planet's per-vertex height read): given a unit
 * direction, find the cube face by max-component test, project to
 * face-local (u, v), bilinear-sample the 4 nearest texels. Inverse
 * of the bake's face projection, by construction. */
/* Sprint 10-1b -- ridge enhancement (the procedural-tectonic
 * substitute for Cortial 2019's plate-boundary uplift). For each
 * high cell whose neighbors are ALSO high, boost its elevation in
 * proportion to how many high neighbors it has. Effect: a chain of
 * adjacent high cells (linear mountain RANGE) gets every cell along
 * the chain pushed up, so the range stands out as a continuous spine
 * relative to isolated peaks. Lone high cells get zero boost, so
 * "blob hills" with one high cell don't get amplified.
 *
 * Sized for our cell defaults: peak threshold 0.62 (just above the
 * 0.5 sea level so the ridge mask doesn't trigger on coastal
 * lowlands), boost factor 0.06 per extra high neighbor (so 6
 * neighbors -> max +0.3 boost, ~30% elevation lift for ridge
 * spines). Clamped at 1.0 so we don't drive cells past peak.
 *
 * Output: Float32Array(cells.count) of additive boost. Cached on
 * the node as _ridgeBoost (re-derived when cellsKey changes). */
function _planetEnhanceRidges(cells, neighbors, K) {
  const n = cells.count;
  const boost = new Float32Array(n);
  const peakThresh = 0.62;
  const ridgeThresh = 0.55;
  const perNbrBoost = 0.06;
  for (let i = 0; i < n; i++) {
    if (cells.elevations[i] < peakThresh) continue;
    let highCount = 0;
    for (let k = 0; k < K; k++) {
      const ni = neighbors[i * K + k];
      if (ni < 0) break;
      if (cells.elevations[ni] >= ridgeThresh) highCount++;
    }
    // Cells with 2+ high neighbors are likely part of a spine
    // (chains, not isolated peaks). Boost by (count - 1) so a
    // 2-neighbor cell gets one unit, 6-neighbor gets 5 units.
    if (highCount >= 2) {
      const b = (highCount - 1) * perNbrBoost;
      boost[i] = Math.min(0.35, b);
    }
  }
  return boost;
}

/* Sprint 10-1b -- variant of _samplePlanetCellsIDW that adds the
 * tectonic ridge boost (if present) into the per-cell elevation
 * before the K=3 weighted blend. Used by _ensurePlanetMapCubemap so
 * the baked surface inherits the ridge enhancement; the rest of
 * the renderer (chunk builder) reads from the cubemap and never
 * sees the boost array. */
function _samplePlanetCellsIDWBoosted(cells, hash, boost, ux, uy, uz) {
  const GRID = hash.GRID;
  const ix0 = Math.max(0, Math.min(GRID - 1, Math.floor((ux + 1) * 0.5 * GRID)));
  const iy0 = Math.max(0, Math.min(GRID - 1, Math.floor((uy + 1) * 0.5 * GRID)));
  const iz0 = Math.max(0, Math.min(GRID - 1, Math.floor((uz + 1) * 0.5 * GRID)));
  let i0 = -1, i1 = -1, i2 = -1;
  let d0 = -2, d1 = -2, d2 = -2;
  for (let dx = -1; dx <= 1; dx++) {
    const bx = ix0 + dx;
    if (bx < 0 || bx >= GRID) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const by = iy0 + dy;
      if (by < 0 || by >= GRID) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const bz = iz0 + dz;
        if (bz < 0 || bz >= GRID) continue;
        const bucket = hash.buckets.get(bx * GRID * GRID + by * GRID + bz);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const cidx = bucket[i];
          const dot = ux * cells.positions[cidx*3]
                    + uy * cells.positions[cidx*3+1]
                    + uz * cells.positions[cidx*3+2];
          if (dot > d0)      { i2 = i1; d2 = d1; i1 = i0; d1 = d0; i0 = cidx; d0 = dot; }
          else if (dot > d1) { i2 = i1; d2 = d1; i1 = cidx; d1 = dot; }
          else if (dot > d2) { i2 = cidx; d2 = dot; }
        }
      }
    }
  }
  if (i0 < 0) {
    for (let i = 0; i < cells.count; i++) {
      const dot = ux * cells.positions[i*3]
                + uy * cells.positions[i*3+1]
                + uz * cells.positions[i*3+2];
      if (dot > d0)      { i2 = i1; d2 = d1; i1 = i0; d1 = d0; i0 = i; d0 = dot; }
      else if (dot > d1) { i2 = i1; d2 = d1; i1 = i; d1 = dot; }
      else if (dot > d2) { i2 = i; d2 = dot; }
    }
  }
  const w0 = 1.0 / (2.0 - 2.0 * d0 + 1e-6);
  const w1 = (i1 >= 0) ? 1.0 / (2.0 - 2.0 * d1 + 1e-6) : 0;
  const w2 = (i2 >= 0) ? 1.0 / (2.0 - 2.0 * d2 + 1e-6) : 0;
  const wSum = w0 + w1 + w2;
  const e0 = Math.min(1, cells.elevations[i0] + (boost ? boost[i0] : 0));
  const e1 = (i1 >= 0) ? Math.min(1, cells.elevations[i1] + (boost ? boost[i1] : 0)) : e0;
  const e2 = (i2 >= 0) ? Math.min(1, cells.elevations[i2] + (boost ? boost[i2] : 0)) : e0;
  return (w0 * e0 + w1 * e1 + w2 * e2) / wSum;
}

function _planetMapCacheKey(node) {
  const p = node.params || {};
  // §planet-spec Phase 7.d -- cellsVersion gets bumped by the painter
  // each time a brush stroke mutates cells.elevations.
  // Sprint 10-1b -- "p10b" invalidated pre-Phase-10 bakes.
  // Sprint 10-2 -- "p10c" invalidates the 10-1b bakes too so the
  // hydraulic-erosion pass runs (rivers, drainage, carved valleys).
  // Sprint 10-5a -- "p10e" + source tag invalidates again so the
  // Earth/custom-mode toggle is reflected. Mode change re-bakes.
  // Sprint 10-5a-fix v2 -- "p10f" invalidates again so any cubemap
  // baked during the strict-equality bug (Earth elev + custom color
  // path mismatch) is dropped on load.
  const ver = (typeof node._cellsVersion === "number") ? node._cellsVersion : 0;
  const src = (typeof p.source === "string") ? p.source : "earth";
  // Sprint 10-7 -- key carries actual src so swapping source via the
  // PlanetMap dropdown invalidates the cached cubemap and re-bakes.
  // "p13i" bumps schema (was "p13h" hardcoded src=earth-densepoly).
  return [
    p.resolution, p.cellCount,
    p.seed, p.frequency, p.octaves,
    p.lacunarity, p.gain, p.ridges,
    "v" + ver, "p13i", "src=" + src,
    _EARTH_DEM.loaded ? "dem=real" : "dem=ellipse"
  ].join(",");
}

/* §planet-spec Phase 7.c -- spherical Fibonacci lattice (Keinert et al.
 * 2015 mapping, classic golden-angle form). Produces N near-uniformly
 * spaced unit-sphere points. For each point, sample the noise field
 * at that direction to seed an initial elevation; biome + plateId
 * default to placeholder values until Phase 7.e wires the climate
 * pipeline + plate tectonics.
 *
 * Cells are stored as parallel arrays (positions Float32Array of 3*N
 * floats, elevations Float32Array of N, biomes Uint8Array of N,
 * plateIds Int16Array of N) for cache-friendly iteration and easy
 * serialization. Phase 7.d painter mutates `elevations` directly. */
function _buildFibonacciCells(N, noiseDef, jitter) {
  const positions = new Float32Array(N * 3);
  const elevations = new Float32Array(N);
  const biomes = new Uint8Array(N);                    // 0 = ocean placeholder
  const plateIds = new Int16Array(N);                  // -1 = unassigned
  const phi = Math.PI * (3 - Math.sqrt(5));            // golden angle
  // Jitter scales with typical cell spacing on a unit sphere
  // (~ 2/sqrt(N) Euclidean for uniform-area sampling). jitter ∈ [0, 1]
  // where 1 ≈ one full cell spacing. The deterministic seed
  // (noiseDef.seed) drives a small LCG so re-rolls with the same
  // seed produce the same jittered layout.
  const jitterAmt = (typeof jitter === "number" ? Math.max(0, Math.min(1, jitter)) : 0) * 2.0 / Math.sqrt(Math.max(1, N));
  let s = ((noiseDef && typeof noiseDef.seed === "number") ? Math.floor(noiseDef.seed * 65537) : 1) | 0;
  if (s === 0) s = 1;
  const rng = function() {
    // 32-bit LCG, output in [0, 1)
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) / 4294967296);
  };
  for (let i = 0; i < N; i++) {
    const y0 = 1 - 2 * i / Math.max(1, N - 1);
    const r = Math.sqrt(Math.max(0, 1 - y0 * y0));
    const theta = phi * i;
    let x = Math.cos(theta) * r;
    let y = y0;
    let z = Math.sin(theta) * r;
    if (jitterAmt > 0) {
      x += (rng() - 0.5) * jitterAmt;
      y += (rng() - 0.5) * jitterAmt;
      z += (rng() - 0.5) * jitterAmt;
      const inv = 1 / Math.sqrt(x*x + y*y + z*z);
      x *= inv; y *= inv; z *= inv;
    }
    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    elevations[i] = _terrainFBM3D(x, y, z, noiseDef);
    biomes[i] = 0;
    plateIds[i] = -1;
  }
  return { positions, elevations, biomes, plateIds, count: N };
}

/* §planet-spec Phase 7.c -- 3D bucket-grid hash on the unit cube for
 * fast nearest-cell lookup. Each cell goes in a 16³ grid bucket by
 * its (x, y, z) ∈ [-1, 1]. Query: project the lookup direction into
 * the same grid, then check the 3×3×3 neighbor buckets and pick the
 * cell with maximum dot product (= minimum angular distance). Falls
 * back to a brute-force O(N) scan if the local neighborhood is
 * empty (rare, near the boundary). With N=10k cells and a 16³ grid
 * the average bucket has 2-3 cells, so per-query work is ~50-80
 * dot products. */
function _buildCellSpatialHash(cells) {
  // GRID size adapts to cell count so per-bucket density stays sane.
  // Target ~10-20 cells/bucket: G ≈ (N / 10)^(1/3) for the surface-on-
  // 3D-cube density we actually have. At N=10k: G≈10 (≤16 cap).
  // At N=60k: G≈18 (cap to 24). At N=240k: G≈29. At N=1M: G≈46.
  // Without this, 240k cells hit 60 per bucket and the K-nearest
  // candidate buffer overflowed → holes in the triangulation.
  const N = cells.count;
  const GRID = Math.max(8, Math.min(48, Math.round(Math.pow(N / 10, 1/3))));
  const buckets = new Map();
  for (let i = 0; i < N; i++) {
    const x = cells.positions[i * 3 + 0];
    const y = cells.positions[i * 3 + 1];
    const z = cells.positions[i * 3 + 2];
    const ix = Math.max(0, Math.min(GRID - 1, Math.floor((x + 1) * 0.5 * GRID)));
    const iy = Math.max(0, Math.min(GRID - 1, Math.floor((y + 1) * 0.5 * GRID)));
    const iz = Math.max(0, Math.min(GRID - 1, Math.floor((z + 1) * 0.5 * GRID)));
    const k = ix * GRID * GRID + iy * GRID + iz;
    let bucket = buckets.get(k);
    if (!bucket) { bucket = []; buckets.set(k, bucket); }
    bucket.push(i);
  }
  return { buckets, GRID };
}

function _findNearestCell(cells, hash, ux, uy, uz) {
  const GRID = hash.GRID;
  const ix0 = Math.max(0, Math.min(GRID - 1, Math.floor((ux + 1) * 0.5 * GRID)));
  const iy0 = Math.max(0, Math.min(GRID - 1, Math.floor((uy + 1) * 0.5 * GRID)));
  const iz0 = Math.max(0, Math.min(GRID - 1, Math.floor((uz + 1) * 0.5 * GRID)));
  let best = -1, bestDot = -2;
  for (let dx = -1; dx <= 1; dx++) {
    const ix = ix0 + dx;
    if (ix < 0 || ix >= GRID) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const iy = iy0 + dy;
      if (iy < 0 || iy >= GRID) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const iz = iz0 + dz;
        if (iz < 0 || iz >= GRID) continue;
        const k = ix * GRID * GRID + iy * GRID + iz;
        const bucket = hash.buckets.get(k);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const cidx = bucket[i];
          const px = cells.positions[cidx * 3 + 0];
          const py = cells.positions[cidx * 3 + 1];
          const pz = cells.positions[cidx * 3 + 2];
          const dot = ux * px + uy * py + uz * pz;
          if (dot > bestDot) { bestDot = dot; best = cidx; }
        }
      }
    }
  }
  if (best < 0) {
    // Fallback: empty neighborhood, do a brute scan. Rare.
    for (let i = 0; i < cells.count; i++) {
      const px = cells.positions[i * 3 + 0];
      const py = cells.positions[i * 3 + 1];
      const pz = cells.positions[i * 3 + 2];
      const dot = ux * px + uy * py + uz * pz;
      if (dot > bestDot) { bestDot = dot; best = i; }
    }
  }
  return best;
}

/* §planet-spec Phase 7.d+ -- inverse-distance-weighted sample of K
 * nearest cells. Replaces the flat-shaded nearest-cell lookup in the
 * cubemap bake so the rendered surface SMOOTHLY interpolates between
 * cell elevations instead of showing 92km-wide flat voronoi patches.
 * Conceptually mirrors what Azgaar's 3D scene mode does at the mesh
 * level (per-cell-corner vertex elevation, continuous between cells).
 *
 * Weight = 1 / (chordSq + epsilon). chordSq = 2 - 2*dot, monotonic
 * with angular distance, no acos needed. For K=3 the result is a
 * smooth field that concentrates near cells with elevated h. Peak
 * cells produce sharp peaks (heightScale * max_local_h); ocean cells
 * produce smooth basins.
 *
 * Returns the IDW-interpolated elevation. */
function _samplePlanetCellsIDW(cells, hash, ux, uy, uz) {
  const GRID = hash.GRID;
  const ix0 = Math.max(0, Math.min(GRID - 1, Math.floor((ux + 1) * 0.5 * GRID)));
  const iy0 = Math.max(0, Math.min(GRID - 1, Math.floor((uy + 1) * 0.5 * GRID)));
  const iz0 = Math.max(0, Math.min(GRID - 1, Math.floor((uz + 1) * 0.5 * GRID)));
  // Track K=3 nearest cells by max dot product.
  let i0 = -1, i1 = -1, i2 = -1;
  let d0 = -2, d1 = -2, d2 = -2;
  for (let dx = -1; dx <= 1; dx++) {
    const bx = ix0 + dx;
    if (bx < 0 || bx >= GRID) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const by = iy0 + dy;
      if (by < 0 || by >= GRID) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const bz = iz0 + dz;
        if (bz < 0 || bz >= GRID) continue;
        const k = bx * GRID * GRID + by * GRID + bz;
        const bucket = hash.buckets.get(k);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const cidx = bucket[i];
          const dot = ux * cells.positions[cidx * 3 + 0]
                    + uy * cells.positions[cidx * 3 + 1]
                    + uz * cells.positions[cidx * 3 + 2];
          // Insertion-sort top 3.
          if (dot > d0)      { i2 = i1; d2 = d1; i1 = i0; d1 = d0; i0 = cidx; d0 = dot; }
          else if (dot > d1) { i2 = i1; d2 = d1; i1 = cidx; d1 = dot; }
          else if (dot > d2) { i2 = cidx; d2 = dot; }
        }
      }
    }
  }
  if (i0 < 0) {
    // Fallback: brute scan if 3x3x3 neighborhood was empty (rare).
    for (let i = 0; i < cells.count; i++) {
      const dot = ux * cells.positions[i * 3 + 0]
                + uy * cells.positions[i * 3 + 1]
                + uz * cells.positions[i * 3 + 2];
      if (dot > d0)      { i2 = i1; d2 = d1; i1 = i0; d1 = d0; i0 = i; d0 = dot; }
      else if (dot > d1) { i2 = i1; d2 = d1; i1 = i; d1 = dot; }
      else if (dot > d2) { i2 = i; d2 = dot; }
    }
  }
  // chordSq = 2 - 2*dot. Closer cell = smaller chord = larger weight.
  // epsilon avoids div-by-0 when texel sits exactly at a cell center.
  const w0 = 1.0 / (2.0 - 2.0 * d0 + 1e-6);
  const w1 = (i1 >= 0) ? 1.0 / (2.0 - 2.0 * d1 + 1e-6) : 0;
  const w2 = (i2 >= 0) ? 1.0 / (2.0 - 2.0 * d2 + 1e-6) : 0;
  const wSum = w0 + w1 + w2;
  const e0 = cells.elevations[i0];
  const e1 = (i1 >= 0) ? cells.elevations[i1] : e0;
  const e2 = (i2 >= 0) ? cells.elevations[i2] : e0;
  return (w0 * e0 + w1 * e1 + w2 * e2) / wSum;
}

/* Sprint 9-6 -- K=3 IDW kernel that returns the 3 nearest cell
 * indices + their weights (instead of a single blended scalar
 * like _samplePlanetCellsIDW). Lets callers blend per-cell data
 * other than elevation -- specifically biome colors, where we
 * want the same kernel that smooths elevation to also smooth
 * the color transitions across biome boundaries. */
function _samplePlanetCellsK3(cells, hash, ux, uy, uz) {
  const GRID = hash.GRID;
  const ix0 = Math.max(0, Math.min(GRID - 1, Math.floor((ux + 1) * 0.5 * GRID)));
  const iy0 = Math.max(0, Math.min(GRID - 1, Math.floor((uy + 1) * 0.5 * GRID)));
  const iz0 = Math.max(0, Math.min(GRID - 1, Math.floor((uz + 1) * 0.5 * GRID)));
  let i0 = -1, i1 = -1, i2 = -1;
  let d0 = -2, d1 = -2, d2 = -2;
  for (let dx = -1; dx <= 1; dx++) {
    const bx = ix0 + dx;
    if (bx < 0 || bx >= GRID) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const by = iy0 + dy;
      if (by < 0 || by >= GRID) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const bz = iz0 + dz;
        if (bz < 0 || bz >= GRID) continue;
        const bucket = hash.buckets.get(bx * GRID * GRID + by * GRID + bz);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const cidx = bucket[i];
          const dot = ux * cells.positions[cidx * 3]
                    + uy * cells.positions[cidx * 3 + 1]
                    + uz * cells.positions[cidx * 3 + 2];
          if (dot > d0)      { i2 = i1; d2 = d1; i1 = i0; d1 = d0; i0 = cidx; d0 = dot; }
          else if (dot > d1) { i2 = i1; d2 = d1; i1 = cidx; d1 = dot; }
          else if (dot > d2) { i2 = cidx; d2 = dot; }
        }
      }
    }
  }
  if (i0 < 0) {
    for (let i = 0; i < cells.count; i++) {
      const dot = ux * cells.positions[i * 3]
                + uy * cells.positions[i * 3 + 1]
                + uz * cells.positions[i * 3 + 2];
      if (dot > d0)      { i2 = i1; d2 = d1; i1 = i0; d1 = d0; i0 = i; d0 = dot; }
      else if (dot > d1) { i2 = i1; d2 = d1; i1 = i; d1 = dot; }
      else if (dot > d2) { i2 = i; d2 = dot; }
    }
  }
  const w0 = 1.0 / (2.0 - 2.0 * d0 + 1e-6);
  const w1 = (i1 >= 0) ? 1.0 / (2.0 - 2.0 * d1 + 1e-6) : 0;
  const w2 = (i2 >= 0) ? 1.0 / (2.0 - 2.0 * d2 + 1e-6) : 0;
  return { i0, i1, i2, w0, w1, w2, wSum: w0 + w1 + w2 };
}

/* §planet-spec Phase 7.c -- get or build the cell graph for a
 * PlanetMap node. Cached on node._cells with a key over (cellCount,
 * seed, frequency, octaves, lacunarity, gain, ridges). Resolution
 * isn't in the key -- cells are independent of the cubemap raster. */
function _planetMapCellsKey(node) {
  const p = node.params || {};
  return [
    p.cellCount, p.seed, p.frequency, p.octaves,
    p.lacunarity, p.gain, p.ridges, p.jitter
  ].join(",");
}

/* §planet-spec Phase 7.d-templates -- pre-compute K=6 nearest other
 * cells per cell. Used by template verbs (Hill BFS, Range walk, Smooth)
 * to traverse the spherical cell graph -- our equivalent of Azgaar's
 * 2D `cells.c[i]` neighbor array. Spatial hash scan over 5×5×5 buckets
 * around each cell (~190 candidates at 30k cells in a 16³ grid),
 * partial sort to keep top K. ~10ms at N=30k cells. Stored as a
 * flat Int32Array(N*K) for cache-friendly iteration. */
function _buildCellNeighbors(cells, hash, K) {
  const N = cells.count;
  const result = new Int32Array(N * K);
  const GRID = hash.GRID;
  // Reusable arrays to avoid per-cell GC churn.
  //
  // BUG (fixed by the scan-order change below): the previous row-major
  // scan iterated dx=-2..+2 so it visited bx = ix0-2 FIRST. In dense
  // lat bands (e.g. lat ~28°N where ~3750 cells crowd into one y-slab
  // and most live near +x), the buffer filled with FAR-bucket cells
  // before the scan ever reached the cell's own bucket. K-nearest then
  // returned cells from the far buckets; the cell's TRUE Voronoi
  // neighbors (sitting in its own bucket) were dropped. Manifested
  // as a deg=0 cluster at lat ~28°N lon ~0°-7° (brute-force confirmed
  // 10/12 true neighbors were in bucket (15,11,8), the cell's own).
  //
  // Fix: visit the cell's own bucket (offset 0) FIRST, then expand
  // outward via OFFSETS = [0, -1, +1, -2, +2]. Buffer cap raised
  // to 8192 -- at 240k cells with adaptive GRID=29 we have ~20
  // cells/bucket × ~125 buckets in 5³ = up to ~2500 candidates,
  // and 2048 was overflowing for cells in dense lat bands. 8192
  // gives 4× headroom; minor extra memory.
  const OFFSETS = [0, -1, 1, -2, 2];
  const candIdx = new Int32Array(8192);
  const candDot = new Float32Array(8192);
  for (let i = 0; i < N; i++) {
    const px = cells.positions[i * 3 + 0];
    const py = cells.positions[i * 3 + 1];
    const pz = cells.positions[i * 3 + 2];
    const ix0 = Math.max(0, Math.min(GRID - 1, Math.floor((px + 1) * 0.5 * GRID)));
    const iy0 = Math.max(0, Math.min(GRID - 1, Math.floor((py + 1) * 0.5 * GRID)));
    const iz0 = Math.max(0, Math.min(GRID - 1, Math.floor((pz + 1) * 0.5 * GRID)));
    let nCand = 0;
    for (let ddx = 0; ddx < 5 && nCand < 8192; ddx++) {
      const bx = ix0 + OFFSETS[ddx]; if (bx < 0 || bx >= GRID) continue;
      for (let ddy = 0; ddy < 5 && nCand < 8192; ddy++) {
        const by = iy0 + OFFSETS[ddy]; if (by < 0 || by >= GRID) continue;
        for (let ddz = 0; ddz < 5 && nCand < 8192; ddz++) {
          const bz = iz0 + OFFSETS[ddz]; if (bz < 0 || bz >= GRID) continue;
          const k = bx * GRID * GRID + by * GRID + bz;
          const bucket = hash.buckets.get(k);
          if (!bucket) continue;
          for (let b = 0; b < bucket.length && nCand < 8192; b++) {
            const cidx = bucket[b];
            if (cidx === i) continue;
            const dot = px * cells.positions[cidx * 3 + 0]
                      + py * cells.positions[cidx * 3 + 1]
                      + pz * cells.positions[cidx * 3 + 2];
            candIdx[nCand] = cidx;
            candDot[nCand] = dot;
            nCand++;
          }
        }
      }
    }
    // Partial selection sort -- pick top K by max dot product.
    for (let k = 0; k < K; k++) {
      let bestPos = -1, bestDot = -2;
      for (let c = k; c < nCand; c++) {
        if (candDot[c] > bestDot) { bestDot = candDot[c]; bestPos = c; }
      }
      if (bestPos < 0) {
        result[i * K + k] = -1;
      } else {
        result[i * K + k] = candIdx[bestPos];
        // Swap into the front so subsequent picks don't reconsider.
        candIdx[bestPos] = candIdx[k]; candIdx[k] = result[i * K + k];
        candDot[bestPos] = candDot[k]; candDot[k] = bestDot;
      }
    }
  }
  return result;
}

function _ensurePlanetMapCells(node) {
  if (!node || !node.params) return null;
  const key = _planetMapCellsKey(node);
  if (node._cells && node._cellsKey === key) return node._cells;
  const p = node.params;
  const N = Math.max(100, Math.min(1000000, Math.floor((typeof p.cellCount === "number") ? p.cellCount : 10000)));
  const noiseOcts = Math.max(1, Math.min(20, Math.floor((typeof p.octaves === "number") ? p.octaves : 6)));
  const noiseDef = {
    seed:       (typeof p.seed       === "number") ? p.seed       : 7.3,
    frequency:  (typeof p.frequency  === "number") ? p.frequency  : 1.0,
    octaves:    noiseOcts,
    effectiveOctavesF: noiseOcts,
    lacunarity: (typeof p.lacunarity === "number") ? p.lacunarity : 2.0,
    gain:       (typeof p.gain       === "number") ? p.gain       : 0.5,
    ridges:     (typeof p.ridges     === "number") ? p.ridges     : 0
  };
  const jitter = (typeof p.jitter === "number") ? p.jitter : 0;
  const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
  const cells = _buildFibonacciCells(N, noiseDef, jitter);
  const hash = _buildCellSpatialHash(cells);
  // K=12 (was 10, was 6). Voronoi cells on a sphere typically have
  // 5-8 true neighbors but the spherical Delaunay test inspects all
  // K candidates for the empty-circle property. K=10 left ~334 edges
  // / ~69 triangles missing on N=60k (99.94% of theoretical
  // 3N-6=179994 / 2(N-2)=119996); K=12 widens the candidate window
  // to close the residual holes where local density variation pushes
  // a true neighbor past the 10th-nearest slot.
  // K bumped 12 → 16 for safety at 240k cells with position jitter.
  // K=12 was tuned for 60k unjittered Fibonacci; jitter introduces
  // local density variation so some cells legitimately have 8-10
  // true Voronoi neighbors and the empty-circle test needs a few
  // more candidates as falsifier pool.
  const NEIGHBORS_K = 16;
  const neighbors = _buildCellNeighbors(cells, hash, NEIGHBORS_K);
  const dt = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;
  node._cells = cells;
  node._cellsHash = hash;
  node._cellNeighbors = neighbors;
  node._cellNeighborsK = NEIGHBORS_K;
  node._cellsKey = key;
  if (!Visual._planetMapCellsLogged) {
    Visual._planetMapCellsLogged = true;
    console.log("[planet-map] built " + N + "-cell Fibonacci graph + " + hash.GRID + "³ spatial hash + " + NEIGHBORS_K + "-neighbor table in " + dt.toFixed(1) + "ms");
  }
  return cells;
}

/* §planet-spec Phase 7.e -- biome system, ported from Azgaar's
 * Fantasy Map Generator (ref-azgaar-fmg/src/modules/biomes.ts +
 * public/main.js calculateTemperatures + generatePrecipitation).
 *
 * Pipeline:
 *   1. Temperature: latitude-based sea-level temp (tropical /
 *      mid-lat / polar gradients, Azgaar's constants) minus altitude
 *      lapse (6.5°C / km, capped at a climate-realistic 9km peak so
 *      heightScale exaggeration doesn't break the formula).
 *   2. Precipitation: spherical wind-pass sim. Cells grouped into 5°
 *      latitude bands, sorted by longitude, walked west→east with
 *      Azgaar's getPrecipitation logic (humidity pickup over water,
 *      orographic rainshadow on mountains, latitude-band modifier
 *      table). Skips Azgaar's east-flowing winds for now -- one
 *      direction gives ~90% of the realism.
 *   3. Biome lookup: Azgaar's 5×26 biomesMatrix indexed by moisture
 *      band (0..4) × temperature band (clamp(20 - T, 0, 25)).
 *      Special cases: marine (h<seaLevel), glacier (T<-5°C),
 *      hot desert (T≥25°C, no river, moisture<8), wetland
 *      (high moisture at low altitude).
 *
 * Output: cells.temp (Float32), cells.prec (Float32), cells.biome
 * (Uint8). Caller renders by biome color. */

const PLANET_BIOMES_NAMES = [
  "Marine", "Hot desert", "Cold desert", "Savanna", "Grassland",
  "Tropical seasonal forest", "Temperate deciduous forest",
  "Tropical rainforest", "Temperate rainforest", "Taiga",
  "Tundra", "Glacier", "Wetland"
];

// Phase 8 sprint 8-4 -- per-biome detail-noise defaults.
// One row per biome (13). Each row:
//   [amp_m, baseFreq, roughness, lacunarity,
//    shape, warpStrength, warpFreq, textureStyleId]
// shape:           0=fbm 1=ridged 2=billowed 3=dunes 4=cracks
// textureStyleId:  0=none 1=rock 2=sand 3=grass 4=snow 5=ice 6=dirt
// Sprint 9-4: AAA-scale amplitudes. The old 0.5-4 m amps produced
// sub-noise micro-bumps invisible at foot level (~30x too low per
// the research dive: Outerra, Iñigo Quilez, Carpentier, Star
// Citizen all sit in the 20-200 m range for visible relief while
// keeping the macro silhouette readable from orbit).
// Sprint 9-5: mountain biomes promoted to Swiss/Jordan turbulence
// (analytic-derivative gradient feedback). Glacier + Taiga + Tundra
// run Swiss (alpine erosion: sharp ridges, smooth valleys); tropical
// rainforest runs Jordan (fluvial erosion: river-carved gulleys).
// Other biomes keep their existing shapes (Hot desert = dunes,
// flatter biomes = fbm) since Swiss/Jordan are ~5x noise cost and
// the difference is only visible on actual mountains.
//   col 0 = amplitude (m, peak displacement)
//   col 1 = baseFreq (1/m, ≈ 1/wavelength_max)
//   col 2 = roughness (per-octave amp ratio, ≈ gain)
//   col 3 = lacunarity (per-octave freq ratio)
//   col 4 = shape enum  0=fbm 1=ridged 2=billowed 3=dunes 4=cracks
//                       5=Swiss (alpine erosion) 6=Jordan (fluvial)
//   col 5 = warpStrength  (Swiss: 0.10-0.20; Jordan: 0.30-0.40)
//   col 6 = warpFreq
//   col 7 = textureStyleId
// Sprint 10-1c: amps halved. At foot-level chunk depth (16) the
// vertex spacing is ~9.5 m; previous 200 m amp glacier produced
// neighbor-vertex height deltas of up to 200 m → atan(200/9.5)
// ≈ 87° slope between vertices, which triggered slope-mod rock
// color EVERYWHERE (the "lava between mountains" effect). Halving
// the amps drops worst-case slope to ~55° -- visible relief
// without saturating the slope mask. Macro elevation from the
// cubemap (~hundreds-of-meters to km) still dominates the macro
// shape; detail noise is now ~10% of macro instead of overwhelming.
const PLANET_BIOME_DETAIL_DEFAULTS = [
  [  0.0, 0.0010, 0.50, 2.0, 0.0, 0.0,    0.0,    0.0],  // 0 Marine (flat)
  [ 40.0, 0.0010, 0.55, 2.0, 3.0, 0.4,    0.0005, 2.0],  // 1 Hot desert (dunes)
  [ 25.0, 0.0010, 0.55, 2.0, 3.0, 0.3,    0.0005, 6.0],  // 2 Cold desert
  [ 15.0, 0.0008, 0.50, 2.0, 0.0, 0.0,    0.0,    6.0],  // 3 Savanna (rolling hills)
  [ 10.0, 0.0005, 0.50, 2.0, 0.0, 0.0,    0.0,    3.0],  // 4 Grassland (gentle hills)
  [ 20.0, 0.0012, 0.50, 2.0, 0.0, 0.0,    0.0,    3.0],  // 5 Trop seasonal forest
  [ 30.0, 0.0010, 0.55, 2.0, 0.0, 0.0,    0.0,    3.0],  // 6 Temp deciduous forest
  [ 25.0, 0.0012, 0.50, 2.0, 6.0, 0.35,   0.0,    3.0],  // 7 Trop rainforest (Jordan)
  [ 35.0, 0.0010, 0.55, 2.0, 0.0, 0.0,    0.0,    3.0],  // 8 Temp rainforest
  [ 60.0, 0.0008, 0.60, 2.0, 5.0, 0.15,   0.0,    1.0],  // 9 Taiga (Swiss)
  [ 45.0, 0.0006, 0.55, 2.0, 5.0, 0.12,   0.0,    4.0],  // 10 Tundra (Swiss)
  [100.0, 0.0006, 0.65, 2.0, 5.0, 0.18,   0.0,    5.0],  // 11 Glacier (Swiss)
  [  8.0, 0.0008, 0.40, 2.0, 0.0, 0.0,    0.0,    3.0]   // 12 Wetland (flat-ish)
];
const PLANET_BIOME_TEX_STYLES = [
  "none", "rock", "sand", "grass", "snow", "ice", "dirt"
];
const PLANET_BIOME_SHAPES = [
  "fbm", "ridged", "billowed", "dunes", "cracks", "swiss", "jordan"
];

// Phase 8 sprint 8-5 -- thumbnail generation for the texture browser.
// CPU port of the WGSL _biome_texture_style math; doesn't need to be
// pixel-identical (it's a preview), just recognizable per style.
function _planetBiomeStyleHash2D(x, y) {
  const k = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return k - Math.floor(k);
}
function _planetBiomeStyleNoise2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = _planetBiomeStyleHash2D(xi,     yi);
  const b = _planetBiomeStyleHash2D(xi + 1, yi);
  const c = _planetBiomeStyleHash2D(xi,     yi + 1);
  const d = _planetBiomeStyleHash2D(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function _planetBiomeStyleThumbnail(styleId, size) {
  const W = size || 56;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = W;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = x / W * 6;
      const py = y / W * 6;
      const n  = _planetBiomeStyleNoise2D(px, py);
      let r = 0.5, g = 0.5, b = 0.5;
      if (styleId === 1) {
        const ridged = 1 - Math.abs(n * 2 - 1);
        const v = ridged * ridged * 0.7 + 0.3;
        r = v;       g = v * 0.95;  b = v * 0.88;
      } else if (styleId === 2) {
        const nv = _planetBiomeStyleNoise2D(px * 0.5, py * 0.5);
        const v = nv * 0.5 + 0.6;
        r = v * 1.08; g = v * 0.96; b = v * 0.72;
      } else if (styleId === 3) {
        const nv = _planetBiomeStyleNoise2D(px * 1.5, py * 1.5);
        const v = 0.45 + nv * 0.45;
        r = v * 0.78; g = v * 1.04; b = v * 0.62;
      } else if (styleId === 4) {
        const nv = _planetBiomeStyleNoise2D(px * 3, py * 3);
        const v = 0.85 + nv * 0.15;
        r = v;        g = v;        b = v * 1.02;
      } else if (styleId === 5) {
        const ridged = 1 - Math.abs(n * 2 - 1);
        const v = 0.55 + (1 - ridged * ridged) * 0.4;
        r = v * 0.92; g = v * 1.02; b = v * 1.08;
      } else if (styleId === 6) {
        const nv = _planetBiomeStyleNoise2D(px * 0.8, py * 0.8);
        const v = 0.45 + nv * 0.4;
        r = v * 0.95; g = v * 0.78; b = v * 0.58;
      } else {
        r = g = b = 0.4;
      }
      const k = (y * W + x) * 4;
      img.data[k    ] = Math.max(0, Math.min(255, Math.round(r * 255)));
      img.data[k + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      img.data[k + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}
const _planetBiomeStyleThumbCache = new Map();
function _planetBiomeStyleGetThumbnail(styleId) {
  const key = "s" + styleId;
  if (!_planetBiomeStyleThumbCache.has(key)) {
    _planetBiomeStyleThumbCache.set(key, _planetBiomeStyleThumbnail(styleId, 56));
  }
  return _planetBiomeStyleThumbCache.get(key);
}

// Azgaar's hex colors parsed to [r,g,b] floats. Order matches getId().
const PLANET_BIOMES_COLORS = [
  [0.275, 0.431, 0.671],  // 0  Marine             #466eab
  [0.984, 0.906, 0.624],  // 1  Hot desert         #fbe79f
  [0.710, 0.722, 0.529],  // 2  Cold desert        #b5b887
  [0.824, 0.816, 0.510],  // 3  Savanna            #d2d082
  [0.784, 0.839, 0.561],  // 4  Grassland          #c8d68f
  [0.714, 0.851, 0.365],  // 5  Trop seasonal      #b6d95d
  [0.161, 0.737, 0.337],  // 6  Temperate deci     #29bc56
  [0.490, 0.796, 0.208],  // 7  Tropical rainf     #7dcb35
  [0.251, 0.612, 0.263],  // 8  Temperate rainf    #409c43
  [0.294, 0.420, 0.196],  // 9  Taiga              #4b6b32
  [0.588, 0.471, 0.294],  // 10 Tundra             #96784b
  [0.835, 0.906, 0.922],  // 11 Glacier            #d5e7eb
  [0.043, 0.569, 0.192]   // 12 Wetland            #0b9131
];

// Azgaar's biomesMatrix verbatim. rows = moisture band (0..4),
// cols = temperature band (0..25; col = clamp(20 - T, 0, 25)).
const PLANET_BIOMES_MATRIX = [
  [1,1,1,1,1,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,10],
  [3,3,3,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,9,9,9,9,10,10,10],
  [5,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,9,9,9,9,9,10,10,10],
  [5,6,6,6,6,6,6,8,8,8,8,8,8,8,8,8,8,9,9,9,9,9,9,10,10,10],
  [7,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,9,9,9,9,9,9,9,10,10]
];

function _planetBiomeId(temperature, moisture, h, seaLevel, hasRiver) {
  if (h < seaLevel) return 0;                     // marine
  if (temperature < -5) return 11;                // glacier
  if (temperature >= 25 && !hasRiver && moisture < 8) return 1;  // hot desert
  // Wetland (biome 12) classification REMOVED 2026-05-21. The
  // moisture > threshold + low elevation rule produced single-cell
  // wetland speckles ("waterholes everywhere") wherever the precip
  // sim happened to deposit a humid spot. Lakes are now produced by
  // the depression-fill detector in _planetRivers (cells.lake mask),
  // which is geographically meaningful (closed basins) and biomes
  // around lakes get their normal biome from the temp/moisture
  // matrix below.
  const moistBand = Math.min(Math.floor(moisture / 5), 4);
  const tempBand = Math.max(0, Math.min(25, 20 - Math.floor(temperature)));
  return PLANET_BIOMES_MATRIX[moistBand][tempBand];
}

// Default climate configuration matching Azgaar's Configure World
// panel. All temps in °C; precipPct is a percentage multiplier on
// the base wind-sim humidity (113 = +13% wetter than the bare sim).
// winds[] holds 6 entries in degrees (0=N, 90=E, 180=S, 270=W) for
// the 6 latitude bands spanning 90°N..90°S in 30° steps -- the
// climate code only uses the E/W component (sign of sin(deg)) to
// pick walk direction per band.
const _PLANET_CLIMATE_DEFAULTS = {
  equatorC:    20,
  northPoleC: -29,
  southPoleC: -40,
  precipPct:  113,
  tropicNorth:  16,
  tropicSouth: -20,
  lapseRateC:  6.5,    // °C per km
  peakAltM:    9000,   // climate-altitude saturation (independent of heightScale)
  // 6 bands top-to-bottom (60-90°N, 30-60°N, 0-30°N, 0-30°S, 30-60°S, 60-90°S).
  // Default values approximate Earth: polar easterlies, mid-lat
  // westerlies, tropical easterlies (trade winds).
  winds: [90, 270, 90, 90, 270, 90]
};

function _resolveClimateConfig(c) {
  c = c || {};
  const D = _PLANET_CLIMATE_DEFAULTS;
  return {
    equatorC:    (typeof c.equatorC === "number")    ? c.equatorC    : D.equatorC,
    northPoleC:  (typeof c.northPoleC === "number")  ? c.northPoleC  : D.northPoleC,
    southPoleC:  (typeof c.southPoleC === "number")  ? c.southPoleC  : D.southPoleC,
    precipPct:   (typeof c.precipPct === "number")   ? c.precipPct   : D.precipPct,
    tropicNorth: (typeof c.tropicNorth === "number") ? c.tropicNorth : D.tropicNorth,
    tropicSouth: (typeof c.tropicSouth === "number") ? c.tropicSouth : D.tropicSouth,
    lapseRateC:  (typeof c.lapseRateC === "number")  ? c.lapseRateC  : D.lapseRateC,
    peakAltM:    (typeof c.peakAltM === "number")    ? c.peakAltM    : D.peakAltM,
    winds:       Array.isArray(c.winds) && c.winds.length === 6 ? c.winds.slice() : D.winds.slice()
  };
}

/* Compute climate (temp, prec, biome) for every cell on the planet.
 * One-shot; caller should cache via a key that mixes cells.elevations
 * + seaLevel + climate-config so painter edits OR setting changes
 * trigger a re-compute. */
function _planetClimate(cells, seaLevel, climateOpts) {
  const cfg = _resolveClimateConfig(climateOpts);
  const N = cells.count;
  if (!cells.temp || cells.temp.length !== N) cells.temp = new Float32Array(N);
  if (!cells.prec || cells.prec.length !== N) cells.prec = new Float32Array(N);
  else cells.prec.fill(0);  // re-zero so reruns don't accumulate
  if (!cells.biome || cells.biome.length !== N) cells.biome = new Uint8Array(N);

  // --- Pass 1: temperature per cell (Azgaar calculateTemperatures). ---
  const T_EQ = cfg.equatorC, T_NP = cfg.northPoleC, T_SP = cfg.southPoleC;
  const TROPIC_N = cfg.tropicNorth, TROPIC_S = cfg.tropicSouth, TROP_GRAD = 0.15;
  const tempNT = T_EQ - TROPIC_N * TROP_GRAD;
  const tempST = T_EQ + TROPIC_S * TROP_GRAD;
  const northGrad = (tempNT - T_NP) / (90 - TROPIC_N);
  const southGrad = (tempST - T_SP) / (90 + TROPIC_S);
  const CLIMATE_PEAK_M = cfg.peakAltM;
  const LAPSE_PER_M = cfg.lapseRateC / 1000;

  for (let i = 0; i < N; i++) {
    const y = cells.positions[i * 3 + 1];
    const lat = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
    let seaT;
    if (lat <= 16 && lat >= -20) {
      seaT = T_EQ - Math.abs(lat) * TROP_GRAD;
    } else if (lat > 0) {
      seaT = tempNT - (lat - TROPIC_N) * northGrad;
    } else {
      seaT = tempST + (lat - TROPIC_S) * southGrad;
    }
    const h = cells.elevations[i];
    let altM = 0;
    if (h > seaLevel) {
      altM = CLIMATE_PEAK_M * (h - seaLevel) / Math.max(1e-6, 1 - seaLevel);
    }
    cells.temp[i] = seaT - altM * LAPSE_PER_M;
  }

  // --- Pass 2: precipitation (Azgaar generatePrecipitation, sphere). ---
  // Group cells by 5° latitude band; within each band sort by lon;
  // walk west→east with humidity transfer + orographic drop. Skips
  // east-flowing winds for now -- one direction reads convincingly.
  const BAND_DEG = 5;
  const NUM_BANDS = Math.ceil(180 / BAND_DEG);
  const bands = new Array(NUM_BANDS);
  for (let b = 0; b < NUM_BANDS; b++) bands[b] = [];
  const latCache = new Float32Array(N);
  const lonCache = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = cells.positions[i * 3 + 0];
    const y = cells.positions[i * 3 + 1];
    const z = cells.positions[i * 3 + 2];
    const lat = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
    const lon = Math.atan2(z, x) * 180 / Math.PI;
    latCache[i] = lat;
    lonCache[i] = lon;
    const bandIdx = Math.min(NUM_BANDS - 1, Math.max(0, Math.floor((lat + 90) / BAND_DEG)));
    bands[bandIdx].push(i);
  }
  // Azgaar's latitudeModifier — 18 bands of 5°, 0°→85+.
  const LAT_MOD = [4, 2, 2, 2, 1, 1, 2, 2, 2, 2, 3, 3, 2, 2, 1, 1, 1, 0.5];
  const MAX_PASS_H = 0.85;
  // Modifier from Azgaar's pointsInput.dataset.cells / 10000 ** 0.25
  // (we have N cells, scale to that). precipPct (config) multiplies
  // the base humidity-budget (Azgaar's precInput, default 100%).
  const cellsMod = Math.pow(N / 10000, 0.25);
  const modifier = cellsMod * (cfg.precipPct / 100);
  // Wind direction per latitude band. cfg.winds has 6 entries
  // spanning 60-90°N, 30-60°N, 0-30°N, 0-30°S, 30-60°S, 60-90°S
  // (top to bottom). We only use the E/W component to choose the
  // walk direction across each 5° latitude band's cells.
  function windEastward(latCenter) {
    // Map latCenter (-90..90) to a band index 0..5.
    // bands: 0=[60..90], 1=[30..60], 2=[0..30], 3=[-30..0], 4=[-60..-30], 5=[-90..-60]
    let bi;
    if (latCenter >=  60) bi = 0;
    else if (latCenter >=  30) bi = 1;
    else if (latCenter >=   0) bi = 2;
    else if (latCenter >= -30) bi = 3;
    else if (latCenter >= -60) bi = 4;
    else                       bi = 5;
    const deg = cfg.winds[bi] || 0;
    // sin(deg in radians) -- positive = east-going, negative = west-going.
    return Math.sin(deg * Math.PI / 180) >= 0;
  }
  for (let b = 0; b < NUM_BANDS; b++) {
    const list = bands[b];
    if (list.length === 0) continue;
    const latCenter = (b * BAND_DEG) - 90 + BAND_DEG * 0.5;
    const eastward = windEastward(latCenter);
    // Sort by longitude: ascending = walk W→E (easterly wind result),
    // descending = walk E→W (westerly wind result). The walk direction
    // is what determines where moisture COMES FROM in the sim.
    if (eastward) list.sort(function(a, b) { return lonCache[a] - lonCache[b]; });
    else          list.sort(function(a, b) { return lonCache[b] - lonCache[a]; });
    const absLat = Math.abs(latCenter);
    const latBandIdx = Math.min(LAT_MOD.length - 1, Math.max(0, Math.floor((absLat - 1) / 5)));
    const latMod = LAT_MOD[latBandIdx];
    const maxPrec = Math.min(255, 120 * modifier * latMod);
    let humidity = Math.max(0, maxPrec - cells.elevations[list[0]] * 100);
    if (humidity <= 0) continue;
    for (let k = 0; k < list.length; k++) {
      const cidx = list[k];
      const T = cells.temp[cidx];
      if (T < -5) continue;  // permafrost: no flux
      const h = cells.elevations[cidx];
      if (h < seaLevel) {
        // Water: pick up moisture, coastal drop on next-land
        humidity = Math.min(humidity + 5 * modifier, maxPrec);
        cells.prec[cidx] += 5 * modifier;
        if (k + 1 < list.length && cells.elevations[list[k + 1]] >= seaLevel) {
          cells.prec[list[k + 1]] += Math.max(humidity / 15, 1);
        }
        continue;
      }
      // Land: drop precipitation; orographic if next is higher.
      const passable = h <= MAX_PASS_H;
      let precip;
      if (!passable) {
        precip = humidity;
      } else {
        const normalLoss = Math.max(humidity / (10 * modifier), 1);
        const nextH = (k + 1 < list.length) ? cells.elevations[list[k + 1]] : h;
        const diff = Math.max(nextH - h, 0);
        const mod = (nextH / 0.7) * (nextH / 0.7);
        precip = Math.min(humidity, normalLoss + diff * mod * 100);
      }
      cells.prec[cidx] += precip;
      const evap = precip > 1.5 ? 1 : 0;
      humidity = passable ? Math.max(0, Math.min(humidity - precip + evap, maxPrec)) : 0;
    }
  }

  // --- Pass 3: biome lookup. ---
  for (let i = 0; i < N; i++) {
    const moist = Math.min(255, cells.prec[i] + 4);  // Azgaar adds +4 from neighbor mean; we cheat
    cells.biome[i] = _planetBiomeId(cells.temp[i], moist, cells.elevations[i], seaLevel, false);
  }
}

/* §planet-spec Phase 7.e-rivers -- port Azgaar's hydrology
 * (ref-azgaar-fmg/src/modules/river-generator.ts) to the spherical
 * cell graph. Pipeline:
 *
 *   1. Depression filling (Planchon-Darboux iteration): for each
 *      land cell, if the lowest neighbor is higher than this cell,
 *      raise this cell to (lowest + ε) so water always has a path
 *      downhill. Operates on a COPY of elevations so visible
 *      terrain isn't perturbed.
 *
 *   2. Flow direction: each land cell's lowest neighbor on the
 *      filled grid. Stored in cells.flowDir.
 *
 *   3. Flux accumulation: sort land cells by filled-height
 *      descending (highest first). Each cell adds its
 *      precipitation to its own flux, then donates the total
 *      to its flow-target. Result: cells.flux[i] = total water
 *      passing through cell i.
 *
 *   4. River extraction: cells with flux ≥ MIN_FLUX are river
 *      cells. Walk forward from each "source" (river cell with
 *      no upstream river inflow) along flowDir until the path
 *      ends in ocean or merges into another river. cells.riverId
 *      identifies which river each cell belongs to.
 *
 * Output: cells.filledH, cells.flowDir, cells.flux, cells.riverId,
 * cells.riverPaths (Array<{cells: number[], mouthFlux: number}>). */
function _planetRivers(cells, neighbors, K, seaLevel) {
  const N = cells.count;
  const filledH = new Float32Array(cells.elevations);

  // Pass 1: depression filling.
  const EPS = 1e-4;
  const MAX_ITER = 40;
  let iter;
  for (iter = 0; iter < MAX_ITER; iter++) {
    let changed = 0;
    for (let i = 0; i < N; i++) {
      if (filledH[i] < seaLevel) continue;
      let lowest = Infinity;
      for (let k = 0; k < K; k++) {
        const j = neighbors[i * K + k];
        if (j < 0) continue;
        if (filledH[j] < lowest) lowest = filledH[j];
      }
      if (filledH[i] < lowest + EPS) {
        filledH[i] = lowest + EPS;
        changed++;
      }
    }
    if (changed === 0) break;
  }

  // Pass 1.5: lake detection. Cells whose original elevation was
  // raised by the depression-fill above were inside CLOSED BASINS.
  //
  // Filter to reject rasterization-noise pits (user reported 'too
  // many lakes' after the first pass):
  //   LAKE_DELTA   = 0.008  (was 0.003) -- require deeper closure
  //   MIN_NEIGHBORS = 2     (was 1)     -- 3+ contiguous cells
  // Only basins with 3+ contiguous cells survive. Real lakes
  // (Caspian, Great Lakes) easily clear this; speckle doesn't.
  const LAKE_DELTA = 0.008;
  const MIN_LAKE_NEIGHBORS = 2;
  const lake = new Uint8Array(N);
  const candidate = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (cells.elevations[i] < seaLevel) continue;
    if (filledH[i] - cells.elevations[i] > LAKE_DELTA) candidate[i] = 1;
  }
  let lakeCells = 0;
  for (let i = 0; i < N; i++) {
    if (!candidate[i]) continue;
    let nbCount = 0;
    for (let k = 0; k < K; k++) {
      const j = neighbors[i * K + k];
      if (j >= 0 && candidate[j]) {
        nbCount++;
        if (nbCount >= MIN_LAKE_NEIGHBORS) break;
      }
    }
    if (nbCount >= MIN_LAKE_NEIGHBORS) { lake[i] = 1; lakeCells++; }
  }
  cells.lake = lake;
  cells.lakeCells = lakeCells;

  // Pass 2: flow direction per cell.
  const flowDir = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (filledH[i] < seaLevel) continue;
    let bestJ = -1, bestH = filledH[i];
    for (let k = 0; k < K; k++) {
      const j = neighbors[i * K + k];
      if (j < 0) continue;
      if (filledH[j] < bestH) { bestH = filledH[j]; bestJ = j; }
    }
    flowDir[i] = bestJ;
  }

  // Pass 3: flux accumulation. Sort land cells by filledH desc.
  const flux = new Float32Array(N);
  const landCells = [];
  for (let i = 0; i < N; i++) {
    if (cells.elevations[i] >= seaLevel) landCells.push(i);
  }
  landCells.sort(function(a, b) { return filledH[b] - filledH[a]; });
  for (let idx = 0; idx < landCells.length; idx++) {
    const i = landCells[idx];
    const prec = cells.prec ? cells.prec[i] : 1.0;
    flux[i] += Math.max(0.1, prec * 0.1);
    const j = flowDir[i];
    if (j >= 0 && filledH[j] >= seaLevel) {
      flux[j] += flux[i];
    }
  }

  cells.filledH = filledH;
  cells.flowDir = flowDir;
  cells.flux = flux;

  // Pass 4: river extraction.
  const MIN_FLUX = 30;
  const isRiver = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (flux[i] >= MIN_FLUX && cells.elevations[i] >= seaLevel) isRiver[i] = 1;
  }
  const inDeg = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (!isRiver[i]) continue;
    const j = flowDir[i];
    if (j >= 0 && isRiver[j]) inDeg[j]++;
  }
  const riverId = new Int32Array(N).fill(-1);
  const riverPaths = [];
  const visited = new Uint8Array(N);
  let nextRiverId = 0;
  for (let i = 0; i < N; i++) {
    if (!isRiver[i] || inDeg[i] > 0 || visited[i]) continue;
    const path = [];
    let cur = i;
    while (cur >= 0 && isRiver[cur] && !visited[cur]) {
      path.push(cur);
      visited[cur] = 1;
      riverId[cur] = nextRiverId;
      cur = flowDir[cur];
    }
    // Include the final ocean cell so the river visibly reaches the coast.
    if (cur >= 0 && !isRiver[cur]) path.push(cur);
    if (path.length >= 3) {
      const mouthCell = path[path.length - 2];
      riverPaths.push({ cells: path, mouthFlux: flux[mouthCell] || 0 });
      nextRiverId++;
    }
  }
  cells.riverId = riverId;
  cells.riverPaths = riverPaths;

  return {
    riverCells: riverPaths.reduce(function(s, r) { return s + r.cells.length; }, 0),
    riverCount: riverPaths.length,
    depressionIters: iter
  };
}

function _ensurePlanetRivers(pmapNode, seaLevel) {
  if (!pmapNode || !pmapNode._cells || !pmapNode._cellNeighbors) return null;
  // §planet-spec Phase 7.e -- cellsVersion bump invalidates river
  // cache too (rivers depend on cells.elevations + cells.prec).
  const ver = (typeof pmapNode._cellsVersion === "number") ? pmapNode._cellsVersion : 0;
  const key = pmapNode._cellsKey + ":sea=" + seaLevel.toFixed(4) + ":v" + ver + ":r";
  if (pmapNode._riversKey === key && pmapNode._cells.flux) return pmapNode._cells;
  const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
  const stats = _planetRivers(pmapNode._cells, pmapNode._cellNeighbors, pmapNode._cellNeighborsK, seaLevel);
  pmapNode._riversKey = key;
  const dt = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;
  const lakeCount = pmapNode._cells.lakeCells || 0;
  console.log("[planet-mesh] rivers computed in " + dt.toFixed(0) + "ms (v" + ver + "): "
    + stats.riverCount + " rivers / " + stats.riverCells + " river-cells / "
    + lakeCount + " lake-cells (depression-fill " + stats.depressionIters + " iters)");
  return pmapNode._cells;
}

function _ensurePlanetClimate(pmapNode, seaLevel) {
  if (!pmapNode || !pmapNode._cells) return null;
  // §planet-spec Phase 7.e -- cellsVersion (bumped by the painter
  // on each edit) MUST be in the climate key so paintbrush changes
  // to cells.elevations propagate through temperature → precip →
  // biome recomputation. ALSO include the climate config so
  // settings changes invalidate the cache.
  const ver = (typeof pmapNode._cellsVersion === "number") ? pmapNode._cellsVersion : 0;
  const cfg = _resolveClimateConfig(pmapNode.params && pmapNode.params.climate);
  const climateKey = cfg.equatorC + "/" + cfg.northPoleC + "/" + cfg.southPoleC
    + "/" + cfg.precipPct + "/" + cfg.tropicNorth + "/" + cfg.tropicSouth
    + "/" + cfg.lapseRateC + "/" + cfg.peakAltM + "/" + cfg.winds.join(",");
  const key = pmapNode._cellsKey + ":sea=" + seaLevel.toFixed(4) + ":v" + ver + ":c=" + climateKey;
  if (pmapNode._climateKey === key && pmapNode._cells.biome) return pmapNode._cells;
  const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
  _planetClimate(pmapNode._cells, seaLevel, cfg);
  pmapNode._climateKey = key;
  const dt = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;
  // Quick biome histogram for the log. Fires every recompute (not
  // gated) so painter edits are visible in the console.
  const hist = new Array(PLANET_BIOMES_NAMES.length).fill(0);
  for (let i = 0; i < pmapNode._cells.count; i++) hist[pmapNode._cells.biome[i]]++;
  const top = hist.map(function(c, i) { return { c, name: PLANET_BIOMES_NAMES[i] }; })
    .filter(function(o) { return o.c > 0; })
    .sort(function(a, b) { return b.c - a.c; })
    .slice(0, 6)
    .map(function(o) { return o.name + "=" + o.c; })
    .join(" ");
  console.log("[planet-mesh] climate computed in " + dt.toFixed(0) + "ms (v" + ver + "): " + top);
  return pmapNode._cells;
}

/* §planet-spec Phase 7.d-templates -- verb primitives + stock recipes.
 * Mirrors Azgaar's heightmap-generator pattern (addHill, addRange,
 * smooth, etc.) ported to operate on our spherical cell graph instead
 * of his 2D Voronoi. Verbs mutate cells.elevations directly; the
 * painter calls _planetApplyTemplate(name, cells, neighbors, K) which
 * runs a sequence of verbs that produces a recognisable map type
 * (continents, pangea, archipelago, plateau, fragmented). */

function _planetVerbReset(cells) {
  for (let i = 0; i < cells.count; i++) cells.elevations[i] = 0;
}

function _planetVerbHill(cells, neighbors, K, count, heightRange) {
  // BFS from random seed with multiplicative-decay-along-edges. Each
  // step: nextDelta = currDelta ^ blobPower * jitter(0.9..1.1). When
  // delta drops below 0.01, propagation stops naturally.
  //
  // BUG-FIX (2026-05-21): Azgaar runs the exponent on the 0..100 raw
  // scale where x^k DECAYS (k < 1, x > 1 → result < x). We store
  // delta in 0..1, so a naive `Math.pow(delta[c], blobPower)` actually
  // INCREASES the value (0.5^0.93 = 0.52, hop UPWARD), making
  // propagation effectively unlimited and Hills fill the entire cap.
  // The fix scales up before pow and back down after.
  const blobPower = 0.99;
  const N = cells.count;
  const delta = new Float32Array(N);
  const visited = new Uint8Array(N);
  for (let h = 0; h < count; h++) {
    delta.fill(0);
    visited.fill(0);
    const seedIdx = Math.floor(Math.random() * N);
    const peak = heightRange[0] + Math.random() * (heightRange[1] - heightRange[0]);
    delta[seedIdx] = peak;
    visited[seedIdx] = 1;
    let queue = [seedIdx];
    while (queue.length > 0) {
      const next = [];
      for (let q = 0; q < queue.length; q++) {
        const c = queue[q];
        const cd = delta[c];
        const propagated = Math.pow(cd * 100, blobPower) / 100;
        if (propagated <= 0.01) continue;
        for (let k = 0; k < K; k++) {
          const n = neighbors[c * K + k];
          if (n < 0 || visited[n]) continue;
          // Per-hop jitter widened from ±10% to ±30% (2026-05-21). The
          // tighter range Azgaar uses produced near-circular blobs; the
          // wider range gives ragged, fractal-feeling coastlines. Still
          // bounded: max factor 1.3 is below the growth threshold ~1.21
          // at delta=0.5 only barely, so most paths still decay -- the
          // outline just gets jagged instead of round.
          const nd = propagated * (0.7 + Math.random() * 0.6);
          if (nd > 0.01) {
            delta[n] = nd;
            visited[n] = 1;
            next.push(n);
          }
        }
      }
      queue = next;
    }
    for (let i = 0; i < N; i++) {
      cells.elevations[i] = Math.max(0, Math.min(1, cells.elevations[i] + delta[i]));
    }
  }
}

function _planetVerbPit(cells, neighbors, K, count, heightRange) {
  // Same blob propagation as _planetVerbHill, applied as a SUBTRACTION
  // to elevations (digs a pit). See bug-fix note in _planetVerbHill.
  const blobPower = 0.99;
  const N = cells.count;
  const delta = new Float32Array(N);
  const visited = new Uint8Array(N);
  for (let h = 0; h < count; h++) {
    delta.fill(0);
    visited.fill(0);
    const seedIdx = Math.floor(Math.random() * N);
    const peak = heightRange[0] + Math.random() * (heightRange[1] - heightRange[0]);
    delta[seedIdx] = peak;
    visited[seedIdx] = 1;
    let queue = [seedIdx];
    while (queue.length > 0) {
      const next = [];
      for (let q = 0; q < queue.length; q++) {
        const c = queue[q];
        const propagated = Math.pow(delta[c] * 100, blobPower) / 100;
        if (propagated <= 0.01) continue;
        for (let k = 0; k < K; k++) {
          const n = neighbors[c * K + k];
          if (n < 0 || visited[n]) continue;
          // Per-hop jitter widened from ±10% to ±30% (2026-05-21). The
          // tighter range Azgaar uses produced near-circular blobs; the
          // wider range gives ragged, fractal-feeling coastlines. Still
          // bounded: max factor 1.3 is below the growth threshold ~1.21
          // at delta=0.5 only barely, so most paths still decay -- the
          // outline just gets jagged instead of round.
          const nd = propagated * (0.7 + Math.random() * 0.6);
          if (nd > 0.01) {
            delta[n] = nd;
            visited[n] = 1;
            next.push(n);
          }
        }
      }
      queue = next;
    }
    for (let i = 0; i < N; i++) {
      cells.elevations[i] = Math.max(0, Math.min(1, cells.elevations[i] - delta[i]));
    }
  }
}

function _planetVerbRange(cells, neighbors, K, count, heightRange) {
  const N = cells.count;
  for (let r = 0; r < count; r++) {
    const startIdx = Math.floor(Math.random() * N);
    let endIdx = Math.floor(Math.random() * N);
    // Reroll if endpoints too close (degenerate range).
    let tries = 0;
    while (endIdx === startIdx && tries < 4) { endIdx = Math.floor(Math.random() * N); tries++; }
    const peak = heightRange[0] + Math.random() * (heightRange[1] - heightRange[0]);
    // Greedy walk: each step pick the neighbor closest to endpoint.
    const tex = cells.positions[endIdx * 3 + 0];
    const tey = cells.positions[endIdx * 3 + 1];
    const tez = cells.positions[endIdx * 3 + 2];
    let current = startIdx;
    const trace = [current];
    const visited = new Uint8Array(N);
    visited[current] = 1;
    for (let step = 0; step < 200; step++) {
      if (current === endIdx) break;
      let best = -1, bestDot = -2;
      for (let k = 0; k < K; k++) {
        const ni = neighbors[current * K + k];
        if (ni < 0 || visited[ni]) continue;
        const dot = tex * cells.positions[ni * 3 + 0]
                  + tey * cells.positions[ni * 3 + 1]
                  + tez * cells.positions[ni * 3 + 2];
        if (dot > bestDot) { bestDot = dot; best = ni; }
      }
      if (best < 0) break;
      visited[best] = 1;
      trace.push(best);
      current = best;
    }
    // Apply peak at trace + 0.5 to immediate neighbors (range slope).
    for (let t = 0; t < trace.length; t++) {
      const idx = trace[t];
      cells.elevations[idx] = Math.max(0, Math.min(1, cells.elevations[idx] + peak));
      for (let k = 0; k < K; k++) {
        const ni = neighbors[idx * K + k];
        if (ni < 0) continue;
        cells.elevations[ni] = Math.max(0, Math.min(1, cells.elevations[ni] + peak * 0.5));
      }
    }
  }
}

function _planetVerbSmooth(cells, neighbors, K, iterations) {
  const N = cells.count;
  const next = new Float32Array(N);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < N; i++) {
      let sum = cells.elevations[i];
      let cnt = 1;
      for (let k = 0; k < K; k++) {
        const ni = neighbors[i * K + k];
        if (ni >= 0) { sum += cells.elevations[ni]; cnt++; }
      }
      next[i] = sum / cnt;
    }
    for (let i = 0; i < N; i++) cells.elevations[i] = next[i];
  }
}

/* §planet-spec Phase 7.d/templates -- the Azgaar template DSL.
 *
 * Each template is a verbatim port of Azgaar's
 * public/config/heightmap-templates.js line, with verbs run against
 * our spherical cell graph (cells.elevations[i] in [0,1]) instead of
 * his 2D grid (cells.h[i] in [0,100]). The DSL row format is:
 *
 *   Verb count height x-range y-range
 *
 * where count + height + x/y-range can each be "N" or "M-N" (random
 * pick within range), and on the sphere x ∈ [0,100] maps to longitude
 * [-180°, +180°], y ∈ [0,100] maps to latitude [+90°, -90°] (top-of-
 * map convention matches Azgaar's). Special height tokens "all",
 * "land", "0-100" act as elevation filters for Add/Multiply. Strait
 * uses "vertical" or "horizontal" instead of x-range. Mask ignores
 * x/y. Add/Multiply factors: a leading minus is preserved. */

function _parseRange(s, def) {
  if (s === undefined || s === null) return def;
  const str = String(s);
  if (str === "all" || str === "land" || str === "vertical" || str === "horizontal") return str;
  // Range like "20-30" but also handle "Add -20" where the value
  // itself is negative (no range, just a single signed number).
  const m = str.match(/^(-?\d+(?:\.\d+)?)(?:-(-?\d+(?:\.\d+)?))?$/);
  if (!m) return def;
  const a = parseFloat(m[1]);
  if (m[2] === undefined) return [a, a];
  return [a, parseFloat(m[2])];
}
function _pickInRange(r) {
  if (!Array.isArray(r)) return r;
  return r[0] + Math.random() * (r[1] - r[0]);
}
function _pickInRangeInt(r) {
  if (!Array.isArray(r)) return Math.floor(r);
  return Math.floor(r[0] + Math.random() * (r[1] - r[0] + 1));
}

// Convert Azgaar's percentage x/y range to a (lon, lat) bounding box
// on the sphere. x ∈ [0,100] → lon [-π, +π]; y ∈ [0,100] → lat
// [+π/2, -π/2] (north on top, matches a map).
function _xyRangeToLatLon(xRange, yRange) {
  const xs = Array.isArray(xRange) ? xRange : [0, 100];
  const ys = Array.isArray(yRange) ? yRange : [0, 100];
  const lonMin = (xs[0] / 100) * 2 * Math.PI - Math.PI;
  const lonMax = (xs[1] / 100) * 2 * Math.PI - Math.PI;
  const latMin = Math.PI * 0.5 - (ys[1] / 100) * Math.PI;
  const latMax = Math.PI * 0.5 - (ys[0] / 100) * Math.PI;
  return { lonMin, lonMax, latMin, latMax };
}

// Filter: cells whose unit-sphere direction falls in the (lat, lon)
// bbox. Returns a Uint8Array(N) where 1 = in-box.
function _cellsInBBox(cells, lonMin, lonMax, latMin, latMax) {
  const N = cells.count;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const x = cells.positions[i*3+0], y = cells.positions[i*3+1], z = cells.positions[i*3+2];
    const lat = Math.asin(Math.max(-1, Math.min(1, y)));
    const lon = Math.atan2(z, x);
    if (lat < latMin || lat > latMax) continue;
    if (lonMin <= lonMax) {
      if (lon < lonMin || lon > lonMax) continue;
    } else {
      // wraps the dateline
      if (lon < lonMin && lon > lonMax) continue;
    }
    mask[i] = 1;
  }
  return mask;
}

function _pickCellInBBox(cells, mask) {
  // Reservoir-sample one cell from the masked set.
  const N = cells.count;
  let count = 0, pick = -1;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    count++;
    if (Math.random() < 1 / count) pick = i;
  }
  return pick;
}

// --- Cap geometry: a "continent area" on the sphere ---
//
// Azgaar's templates describe ONE landmass on a rectangular grid.
// To make them produce a recognizable continent on our sphere, we
// constrain the template to a circular cap (center direction + radius
// in radians). All x/y coordinates in the DSL map to cap-local
// stereographic coords (0..100% within the cap), so x=50% is the
// cap center, x=0 / x=100 are the cap edges. Cells outside the cap
// are untouched by the template's verbs -- they stay at sea level
// (= ocean).
//
// Per-template metadata (PLANET_TEMPLATE_CAPS) controls how many
// caps to place per "apply" and how big each one is, matching Azgaar's
// stock template intent: volcano = 1 tiny cap, pangea = 1 huge cap,
// archipelago = many small scattered caps, etc.

function _makeCap(cx, cy, cz, radiusRad) {
  // Orthonormalize basis at cap center. Use world +Y as the "north"
  // hint; if the cap is near a pole, fall back to +X so the basis
  // doesn't collapse.
  let nx = 0, ny = 1, nz = 0;
  if (Math.abs(cy) > 0.95) { nx = 1; ny = 0; nz = 0; }
  // v = north projected onto tangent plane at c (i.e., n − (n·c)c).
  const ndotc = nx*cx + ny*cy + nz*cz;
  let vx = nx - cx*ndotc, vy = ny - cy*ndotc, vz = nz - cz*ndotc;
  const vlen = Math.hypot(vx, vy, vz) || 1;
  vx /= vlen; vy /= vlen; vz /= vlen;
  // u = c × v (east axis, right-handed).
  const ux = cy*vz - cz*vy;
  const uy = cz*vx - cx*vz;
  const uz = cx*vy - cy*vx;
  return { cx, cy, cz, ux, uy, uz, vx, vy, vz,
           radius: radiusRad, cosRadius: Math.cos(radiusRad) };
}

function _makeRandomCap(radiusRad) {
  // Uniform-on-sphere center pick.
  const y = 1 - Math.random() * 2;
  const r = Math.sqrt(Math.max(0, 1 - y*y));
  const theta = Math.random() * 2 * Math.PI;
  return _makeCap(Math.cos(theta)*r, y, Math.sin(theta)*r, radiusRad);
}

function _makeCapAtLatLon(latDeg, lonDeg, radiusRad) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const r = Math.cos(lat);
  return _makeCap(r * Math.cos(lon), Math.sin(lat), r * Math.sin(lon), radiusRad);
}

// Project cell i to cap-local Azgaar coords. Returns { inCap, x, y }
// with x,y ∈ [0, 100]: x=50 at cap center horizontally, y=0 at the
// top of the cap (north), y=100 at the bottom.
function _capProject(cells, i, cap) {
  const px = cells.positions[i*3+0];
  const py = cells.positions[i*3+1];
  const pz = cells.positions[i*3+2];
  const dot = px*cap.cx + py*cap.cy + pz*cap.cz;
  if (dot < cap.cosRadius) return { inCap: false, x: 50, y: 50 };
  // Tangent direction = p − (p·c)c, normalized.
  const tx = px - dot*cap.cx, ty = py - dot*cap.cy, tz = pz - dot*cap.cz;
  const tlen = Math.hypot(tx, ty, tz);
  if (tlen < 1e-9) return { inCap: true, x: 50, y: 50 };
  const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
  const fraction = ang / cap.radius;  // 0 = center, 1 = edge
  const tnx = tx/tlen, tny = ty/tlen, tnz = tz/tlen;
  const localU = tnx*cap.ux + tny*cap.uy + tnz*cap.uz;
  const localV = tnx*cap.vx + tny*cap.vy + tnz*cap.vz;
  // [-1, 1] disc coords scaled by radial fraction (so cells span the
  // full cap-local extent linearly with angle).
  const sx = localU * fraction;
  const sy = localV * fraction;
  // North-on-top convention matches Azgaar's y=0 = top of map.
  return { inCap: true, x: (sx + 1) * 50, y: (1 - sy) * 50 };
}

function _capBBoxMask(cells, cap, xRange, yRange) {
  const N = cells.count;
  const mask = new Uint8Array(N);
  const xMin = xRange[0], xMax = xRange[1];
  const yMin = yRange[0], yMax = yRange[1];
  for (let i = 0; i < N; i++) {
    const p = _capProject(cells, i, cap);
    if (!p.inCap) continue;
    if (p.x < xMin || p.x > xMax) continue;
    if (p.y < yMin || p.y > yMax) continue;
    mask[i] = 1;
  }
  return mask;
}

function _capInsideMask(cells, cap) {
  const N = cells.count;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const px = cells.positions[i*3+0];
    const py = cells.positions[i*3+1];
    const pz = cells.positions[i*3+2];
    if (px*cap.cx + py*cap.cy + pz*cap.cz >= cap.cosRadius) mask[i] = 1;
  }
  return mask;
}

// Azgaar's blobPower / linePower scale with cell count so blobs and
// ranges cover the same ANGULAR area on the sphere regardless of how
// dense the cell graph is. Without this, at 240k cells our blobs
// only spread through the same NUMBER of cells as at 10k -- but
// each cell is 1/24 the area, so continents look tiny. Curve fit
// to Azgaar's lookup (heightmap-generator.ts getBlobPower /
// getLinePower):
//   blobPower(N) = 1 − 100 / N^0.87  → 240k ≈ 0.9988
//   linePower(N) = 1 − 10  / N^0.43  → 240k ≈ 0.939
// Per-vertex detail stays intact (cells are still small for sharp
// peaks); blobs / ranges just spread to more of them so continents
// fill the cap properly.
function _planetTemplatePowers(N) {
  const blobPower = Math.max(0.93, Math.min(0.9995, 1 - 100 / Math.pow(N, 0.87)));
  const linePower = Math.max(0.75, Math.min(0.96, 1 - 10  / Math.pow(N, 0.43)));
  return { blobPower, linePower };
}

// --- Verb implementations (cap-aware, cell-count-scaled decay) ---

function _planetVerbHillXY(cells, neighbors, K, cap, count, heightRange, xRange, yRange, powers) {
  // BUG-FIX (2026-05-21): see _planetVerbHill -- exponentiation must
  // run in 0..100 scale so x^blobPower decays with k<1 (Azgaar's
  // Uint8Array semantics). Storing delta in 0..1 and naively raising
  // to k<1 INCREASES the value, so propagation runs forever and the
  // BFS fills the entire cap.
  const N = cells.count;
  const blobPower = powers.blobPower;
  const mask = _capBBoxMask(cells, cap, xRange, yRange);
  // Restrict blob BFS to cap-interior cells so blobs don't leak across
  // continents in multi-cap templates (caused random islands / ocean
  // perturbations between continents and outside the cap).
  const insideCap = _capInsideMask(cells, cap);
  const delta = new Float32Array(N);
  const visited = new Uint8Array(N);
  for (let h = 0; h < count; h++) {
    delta.fill(0); visited.fill(0);
    const seed = _pickCellInBBox(cells, mask);
    if (seed < 0) continue;
    const peak = _pickInRange(heightRange) / 100;
    delta[seed] = peak; visited[seed] = 1;
    let q = [seed];
    while (q.length > 0) {
      const next = [];
      for (let p = 0; p < q.length; p++) {
        const c = q[p];
        const prop = Math.pow(delta[c] * 100, blobPower) / 100;
        if (prop <= 0.01) continue;
        for (let k = 0; k < K; k++) {
          const n = neighbors[c*K+k];
          if (n < 0 || visited[n] || !insideCap[n]) continue;
          const nd = prop * (0.7 + Math.random() * 0.6);  // ±30% jitter -- see _planetVerbHill note
          if (nd > 0.01) { delta[n] = nd; visited[n] = 1; next.push(n); }
        }
      }
      q = next;
    }
    for (let i = 0; i < N; i++) {
      cells.elevations[i] = Math.max(0, Math.min(1, cells.elevations[i] + delta[i]));
    }
  }
}

function _planetVerbPitXY(cells, neighbors, K, cap, count, heightRange, xRange, yRange, powers) {
  // BUG-FIX (2026-05-21): same propagation fix as _planetVerbHillXY.
  const N = cells.count;
  const blobPower = powers.blobPower;
  const mask = _capBBoxMask(cells, cap, xRange, yRange);
  const insideCap = _capInsideMask(cells, cap);
  const delta = new Float32Array(N);
  const visited = new Uint8Array(N);
  for (let h = 0; h < count; h++) {
    delta.fill(0); visited.fill(0);
    const seed = _pickCellInBBox(cells, mask);
    if (seed < 0) continue;
    const depth = _pickInRange(heightRange) / 100;
    delta[seed] = depth; visited[seed] = 1;
    let q = [seed];
    while (q.length > 0) {
      const next = [];
      for (let p = 0; p < q.length; p++) {
        const c = q[p];
        const prop = Math.pow(delta[c] * 100, blobPower) / 100;
        if (prop <= 0.01) continue;
        for (let k = 0; k < K; k++) {
          const n = neighbors[c*K+k];
          if (n < 0 || visited[n] || !insideCap[n]) continue;
          const nd = prop * (0.7 + Math.random() * 0.6);  // ±30% jitter -- see _planetVerbHill note
          if (nd > 0.01) { delta[n] = nd; visited[n] = 1; next.push(n); }
        }
      }
      q = next;
    }
    for (let i = 0; i < N; i++) {
      cells.elevations[i] = Math.max(0, Math.min(1, cells.elevations[i] - delta[i]));
    }
  }
}

// Range / Trough: greedy ridge walk start → end, then BFS frontier
// expansion with linePower-decayed height per layer. Matches
// Azgaar's addRange (heightmap-generator.ts:158). Decay runs in his
// 0-100 scale (h = h^linePower - 1) so the curve behaves correctly
// at our N=240k where linePower ≈ 0.94. Result: proper mountain
// ranges with sloped sides, not the old single-row ridges.
function _planetVerbRangeXY(cells, neighbors, K, cap, count, heightRange, xRange, yRange, sign, powers) {
  sign = (sign === undefined) ? 1 : sign;
  const N = cells.count;
  const linePower = powers.linePower;
  const mask = _capBBoxMask(cells, cap, xRange, yRange);
  const insideCap = _capInsideMask(cells, cap);
  for (let r = 0; r < count; r++) {
    const startIdx = _pickCellInBBox(cells, mask);
    if (startIdx < 0) continue;
    let endIdx = _pickCellInBBox(cells, mask);
    let tries = 0;
    while ((endIdx < 0 || endIdx === startIdx) && tries < 4) { endIdx = _pickCellInBBox(cells, mask); tries++; }
    if (endIdx < 0) endIdx = startIdx;
    const used = new Uint8Array(N);
    // Greedy ridge walk (restricted to cap-interior so ridges don't
    // walk through the ocean into other continents).
    const tex = cells.positions[endIdx*3+0], tey = cells.positions[endIdx*3+1], tez = cells.positions[endIdx*3+2];
    const range = [startIdx];
    used[startIdx] = 1;
    let cur = startIdx;
    for (let step = 0; step < 400; step++) {
      if (cur === endIdx) break;
      let best = -1, bestDot = -2;
      for (let k = 0; k < K; k++) {
        const ni = neighbors[cur*K+k];
        if (ni < 0 || used[ni] || !insideCap[ni]) continue;
        const dot = tex*cells.positions[ni*3] + tey*cells.positions[ni*3+1] + tez*cells.positions[ni*3+2];
        const adj = (Math.random() > 0.85) ? dot * 0.5 + 0.5 : dot;
        if (adj > bestDot) { bestDot = adj; best = ni; }
      }
      if (best < 0) break;
      used[best] = 1; range.push(best); cur = best;
    }
    // BFS frontier expansion with height decay (cap-interior only).
    let h100 = _pickInRange(heightRange);
    let queue = range.slice();
    while (queue.length > 0) {
      const frontier = queue;
      queue = [];
      const delta = sign * (h100 / 100);
      for (let f = 0; f < frontier.length; f++) {
        const idx = frontier[f];
        const jitter = 0.85 + Math.random() * 0.30;
        cells.elevations[idx] = Math.max(0, Math.min(1, cells.elevations[idx] + delta * jitter));
      }
      h100 = Math.pow(h100, linePower) - 1;
      if (h100 < 2) break;
      for (let f = 0; f < frontier.length; f++) {
        const idx = frontier[f];
        for (let k = 0; k < K; k++) {
          const ni = neighbors[idx*K+k];
          if (ni < 0 || used[ni] || !insideCap[ni]) continue;
          used[ni] = 1;
          queue.push(ni);
        }
      }
    }
  }
}

// Strait cuts a sea channel WITHIN the cap. "vertical" = north-south,
// "horizontal" = east-west. Width ~7% of the cap radius at center,
// fading to 0 at the edges. Depth is EXPONENTIAL (heights[i] **= exp)
// matching Azgaar's addStrait (heightmap-generator.ts:428) -- a cell
// at 0.80 becomes 0.41 (≈half), 0.50 becomes 0.20 (sealevel), 0.30
// becomes 0.10 (ocean). This is much more aggressive than the
// previous fixed -0.15 subtract, which left mid-elevation cells well
// above sealevel and never actually carved a sea channel.
//
// 2026-05-21 fix: prior implementation used a fixed subtract that
// never cut through Hill-core regions even with cleanup disabled.
function _planetVerbStrait(cells, neighbors, K, cap, count, orientation) {
  const N = cells.count;
  for (let r = 0; r < count; r++) {
    const offset = (Math.random() - 0.5) * 0.7;   // ±35% off-center
    const width = 0.14;                            // cap-radius units (was 0.10)
    for (let i = 0; i < N; i++) {
      const proj = _capProject(cells, i, cap);
      if (!proj.inCap) continue;
      const lx = (proj.x - 50) / 50;
      const ly = (50 - proj.y) / 50;
      const d = (orientation === "vertical") ? Math.abs(lx - offset) : Math.abs(ly - offset);
      if (d >= width) continue;
      const t = 1 - d / width;                    // 1 at center, 0 at edge
      // Center exp = 0.80 (deep cut), edge exp = 1.0 (no change).
      const exp = 0.80 + 0.20 * (1 - t);
      const h100 = cells.elevations[i] * 100;
      if (h100 <= 0) continue;
      const newH = Math.pow(h100, exp) / 100;
      cells.elevations[i] = Math.max(0, Math.min(1, newH));
    }
  }
}

// Add / Multiply / Invert operate on cells INSIDE the cap. heightFilter
// can be "all", "land", or a [lo, hi] elevation range (Azgaar 0-100).
function _planetVerbAdd(cells, cap, value, heightFilter) {
  const N = cells.count;
  const v = value / 100;
  let elevMin = 0, elevMax = 1;
  if (heightFilter === "land") elevMin = 0.20;
  else if (Array.isArray(heightFilter)) { elevMin = heightFilter[0] / 100; elevMax = heightFilter[1] / 100; }
  const inMask = _capInsideMask(cells, cap);
  for (let i = 0; i < N; i++) {
    if (!inMask[i]) continue;
    if (cells.elevations[i] < elevMin || cells.elevations[i] > elevMax) continue;
    cells.elevations[i] = Math.max(0, Math.min(1, cells.elevations[i] + v));
  }
}

function _planetVerbMultiply(cells, cap, factor, heightFilter) {
  const N = cells.count;
  let elevMin = 0, elevMax = 1;
  if (heightFilter === "land") elevMin = 0.20;
  else if (Array.isArray(heightFilter)) { elevMin = heightFilter[0] / 100; elevMax = heightFilter[1] / 100; }
  const inMask = _capInsideMask(cells, cap);
  for (let i = 0; i < N; i++) {
    if (!inMask[i]) continue;
    if (cells.elevations[i] < elevMin || cells.elevations[i] > elevMax) continue;
    cells.elevations[i] = Math.max(0, Math.min(1, cells.elevations[i] * factor));
  }
}

function _planetVerbInvert(cells, cap, probability) {
  if (Math.random() > probability) return;
  const N = cells.count;
  const inMask = _capInsideMask(cells, cap);
  for (let i = 0; i < N; i++) {
    if (!inMask[i]) continue;
    cells.elevations[i] = Math.max(0, Math.min(1, 1 - cells.elevations[i]));
  }
}

// Mask centered on the cap. Azgaar's templates assume a 2:1
// rectangle where Mask 4 leaves ~half the map above sea level with
// a soft edge fade. Our circular caps with radial (1-dist)^4 fall-
// off would zero the outer 70% of every cap → continents end up as
// little dots in the cap center. Fix: use a CENTRAL PLATEAU shape
// where cells in the inner 60% of the cap get full weight (no
// dampening), and only the outer 40% fades from 1 → 0 with the
// power curve. Matches Azgaar's effective "most of cap is land,
// soft edge to ocean" behavior.
//
// Cells outside the cap are left alone -- other caps own them in
// multi-cap templates.
function _planetVerbMask(cells, cap, power) {
  const N = cells.count;
  const absPow = Math.max(1, Math.abs(power));
  const invert = power < 0;
  const PLATEAU = 0.6;
  for (let i = 0; i < N; i++) {
    const proj = _capProject(cells, i, cap);
    if (!proj.inCap) continue;
    const lx = (proj.x - 50) / 50;
    const ly = (50 - proj.y) / 50;
    const dist = Math.min(1, Math.hypot(lx, ly));
    // edgeFraction: 0 in the inner plateau, climbs 0→1 across the
    // outer (1 - PLATEAU) zone.
    const edgeFraction = Math.max(0, (dist - PLATEAU) / (1 - PLATEAU));
    let t = 1 - edgeFraction;   // 1 inside plateau, fades to 0 at cap edge
    if (invert) t = edgeFraction;
    cells.elevations[i] *= Math.pow(Math.max(0, Math.min(1, t)), absPow);
  }
}

// Smooth runs only on cap-interior cells; the cap boundary then
// naturally smooths toward 0 (ocean) for a soft coastline instead of
// a hard edge.
function _planetVerbSmoothCap(cells, neighbors, K, cap, iterations) {
  const N = cells.count;
  const inMask = _capInsideMask(cells, cap);
  const next = new Float32Array(N);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < N; i++) {
      if (!inMask[i]) { next[i] = cells.elevations[i]; continue; }
      let sum = cells.elevations[i];
      let cnt = 1;
      for (let k = 0; k < K; k++) {
        const ni = neighbors[i * K + k];
        if (ni >= 0) { sum += cells.elevations[ni]; cnt++; }
      }
      next[i] = sum / cnt;
    }
    for (let i = 0; i < N; i++) cells.elevations[i] = next[i];
  }
}

// --- DSL parser / executor ---

function _planetRunDSL(template, cells, neighbors, K, cap, powers) {
  const lines = template.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const verb = parts[0];
    const arg1 = parts[1], arg2 = parts[2], arg3 = parts[3], arg4 = parts[4];
    switch (verb) {
      case "Hill": {
        const count = _pickInRangeInt(_parseRange(arg1, [1,1]));
        const h = _parseRange(arg2, [50,50]);
        _planetVerbHillXY(cells, neighbors, K, cap, count, h, _parseRange(arg3, [0,100]), _parseRange(arg4, [0,100]), powers);
        break;
      }
      case "Pit": {
        const count = _pickInRangeInt(_parseRange(arg1, [1,1]));
        const h = _parseRange(arg2, [10,20]);
        _planetVerbPitXY(cells, neighbors, K, cap, count, h, _parseRange(arg3, [0,100]), _parseRange(arg4, [0,100]), powers);
        break;
      }
      case "Range": {
        const count = _pickInRangeInt(_parseRange(arg1, [1,1]));
        const h = _parseRange(arg2, [30,50]);
        _planetVerbRangeXY(cells, neighbors, K, cap, count, h, _parseRange(arg3, [0,100]), _parseRange(arg4, [0,100]), 1, powers);
        break;
      }
      case "Trough": {
        const count = _pickInRangeInt(_parseRange(arg1, [1,1]));
        const h = _parseRange(arg2, [10,20]);
        _planetVerbRangeXY(cells, neighbors, K, cap, count, h, _parseRange(arg3, [0,100]), _parseRange(arg4, [0,100]), -1, powers);
        break;
      }
      case "Strait": {
        const count = _pickInRangeInt(_parseRange(arg1, [1,1]));
        _planetVerbStrait(cells, neighbors, K, cap, count, arg2);
        break;
      }
      case "Smooth": {
        const iter = _pickInRangeInt(_parseRange(arg1, [1,1]));
        _planetVerbSmoothCap(cells, neighbors, K, cap, iter);
        break;
      }
      case "Add": {
        const v = parseFloat(arg1);
        const filt = (arg2 === "all" || arg2 === "land") ? arg2 : _parseRange(arg2, "all");
        _planetVerbAdd(cells, cap, v, filt);
        break;
      }
      case "Multiply": {
        const f = parseFloat(arg1);
        const filt = (arg2 === "all" || arg2 === "land") ? arg2 : _parseRange(arg2, "all");
        _planetVerbMultiply(cells, cap, f, filt);
        break;
      }
      case "Mask": {
        _planetVerbMask(cells, cap, parseFloat(arg1));
        break;
      }
      case "Invert": {
        const p = parseFloat(arg1);
        _planetVerbInvert(cells, cap, p);
        break;
      }
      default:
        console.warn("[planet-map] unknown DSL verb:", verb);
    }
  }
}

/* Post-DSL pipeline: gentle smoothing → coastline cleanup → piecewise
 * remap. Shared by every path that mutates cells.elevations through
 * the DSL (AI-generation path; future undo/redo restore; etc.). */
function _planetPostDSL(cells, neighbors, K, seaLevel, opts) {
  // opts (all optional):
  //   skipSmoothing: boolean -- skip the 2-iteration alpha=0.30 averaging pass
  //   skipCleanup:   boolean -- skip the morphological coastline open
  //                             (use this for the LANDMASS-FIRST pass to
  //                             preserve fractal Strait cuts + 1-cell bays;
  //                             the cleanup's 55% land-neighbor threshold
  //                             otherwise re-fills any sea channel narrower
  //                             than ~half the neighbor radius)
  //   landNbrThreshold: number in [0..1] -- overrides the 0.55 default if
  //                                          you want to tune cleanup
  //                                          aggressiveness without disabling
  const skipSmoothing = !!(opts && opts.skipSmoothing);
  const skipCleanup   = !!(opts && opts.skipCleanup);
  const threshold     = (opts && typeof opts.landNbrThreshold === "number")
    ? opts.landNbrThreshold : 0.55;
  // Gentle smoothing -- closes single-cell anomalies without
  // flattening mountains.
  if (!skipSmoothing) {
    const N = cells.count;
    const next = new Float32Array(N);
    const alpha = 0.30;
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < N; i++) {
        let sum = 0, cnt = 0;
        for (let k = 0; k < K; k++) {
          const ni = neighbors[i * K + k];
          if (ni >= 0) { sum += cells.elevations[ni]; cnt++; }
        }
        const avg = (cnt > 0) ? sum / cnt : cells.elevations[i];
        next[i] = cells.elevations[i] * (1 - alpha) + avg * alpha;
      }
      for (let i = 0; i < N; i++) cells.elevations[i] = next[i];
    }
  }
  // Coastline cleanup (morphological "open" on land + ocean).
  if (!skipCleanup) {
    const N = cells.count;
    const AZ_SL = 0.20;
    let bumped = 0, dropped = 0;
    const flagL = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const e = cells.elevations[i];
      if (e >= AZ_SL || e < AZ_SL - 0.10) continue;
      let landCount = 0, totalNbr = 0;
      for (let k = 0; k < K; k++) {
        const ni = neighbors[i * K + k];
        if (ni < 0) continue;
        totalNbr++;
        if (cells.elevations[ni] >= AZ_SL) landCount++;
      }
      if (totalNbr > 0 && landCount >= Math.max(4, Math.floor(totalNbr * threshold))) flagL[i] = 1;
    }
    for (let i = 0; i < N; i++) if (flagL[i]) { cells.elevations[i] = AZ_SL + 0.02; bumped++; }
    const flagO = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const e = cells.elevations[i];
      if (e < AZ_SL || e > AZ_SL + 0.10) continue;
      let oceanCount = 0, totalNbr = 0;
      for (let k = 0; k < K; k++) {
        const ni = neighbors[i * K + k];
        if (ni < 0) continue;
        totalNbr++;
        if (cells.elevations[ni] < AZ_SL) oceanCount++;
      }
      if (totalNbr > 0 && oceanCount >= Math.max(4, Math.floor(totalNbr * threshold))) flagO[i] = 1;
    }
    for (let i = 0; i < N; i++) if (flagO[i]) { cells.elevations[i] = AZ_SL - 0.02; dropped++; }
    if (bumped + dropped > 0) {
      console.log("[planet-map] coastline cleanup: bumped " + bumped + " lake cells, dropped " + dropped + " ocean-speck cells");
    }
  }
  // Piecewise remap Azgaar's logical 0-1 (0.20 = sea level) → ours.
  const sl = (typeof seaLevel === "number") ? seaLevel : 0.55;
  if (Math.abs(sl - 0.20) > 1e-6) {
    const AZ_SL = 0.20;
    const N = cells.count;
    for (let i = 0; i < N; i++) {
      const h = cells.elevations[i];
      let e;
      if (h <= AZ_SL) e = (h / AZ_SL) * sl;
      else            e = sl + ((h - AZ_SL) / (1 - AZ_SL)) * (1 - sl);
      cells.elevations[i] = Math.max(0, Math.min(1, e));
    }
  }
}

/* AI map generation. Sends the user's prompt to the configured LLM
 * provider (PROVIDERS[aiSettings.provider]) along with a system
 * prompt that explains our DSL + cap geometry, then expects JSON
 * back with { caps: [{lat, lon, radiusDeg, verbs}, ...] }. Each cap
 * runs the DSL against the cell graph. Post-DSL pipeline (smooth,
 * cleanup, remap) is identical to the old preset path. */
// _PLANET_AI_SYSTEM_PROMPT removed 2026-05-21 -- AI pipeline is now feature-only; landmass comes from GeoJSON import or brush.

// AI audit machinery removed 2026-05-21 -- the editor's AI features for
// planet maps were retired; landmass + features come from the brush,
// GeoJSON import, or Azgaar full JSON import.

function _parseAIPlan(rawResponse) {
  let json = String(rawResponse).trim();
  json = json.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  // If the model wrapped the JSON in commentary, salvage the first {...} block.
  const firstBrace = json.indexOf("{");
  const lastBrace  = json.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) json = json.slice(firstBrace, lastBrace + 1);
  let parsed;
  try { parsed = JSON.parse(json); }
  catch (e) { throw new Error("model returned invalid JSON: " + e.message + "\n" + json.slice(0, 300)); }
  if (!parsed || !Array.isArray(parsed.caps)) throw new Error("response missing 'caps' array");
  if (parsed.caps.length === 0) throw new Error("response had 0 caps");
  return parsed;
}

function _applyAIPlan(plan, cells, neighbors, K, seaLevel, lockedCenter, opts) {
  // opts:
  //   skipReset    -- don't zero elevations before applying the plan.
  //                   Use this for feature audits that build ON TOP of
  //                   an existing landmass (stamped GeoJSON, hand-
  //                   painted, or previous feature additions).
  //   lockLand     -- snapshot land vs ocean BEFORE applying verbs;
  //                   after applying, restore any cell whose land/ocean
  //                   status flipped to its pre-application value. Use
  //                   this to prevent feature audits from accidentally
  //                   creating or destroying landmass.
  //   skipCleanup  -- forwarded to _planetPostDSL; preserves fractal
  //                   coast / Strait cuts.
  //   skipSmoothing -- forwarded to _planetPostDSL.
  opts = opts || {};
  // Snapshot land/ocean status BEFORE applying if lockLand requested.
  let preLandMask = null;
  if (opts.lockLand) {
    preLandMask = new Uint8Array(cells.count);
    for (let i = 0; i < cells.count; i++) {
      preLandMask[i] = cells.elevations[i] >= seaLevel ? 1 : 0;
    }
  }
  if (!opts.skipReset) _planetVerbReset(cells);
  const powers = _planetTemplatePowers(cells.count);
  for (let i = 0; i < plan.caps.length; i++) {
    const c = plan.caps[i];
    const radDeg = Math.max(8, Math.min(90, Number(c.radiusDeg) || 50));
    const radRad = radDeg * Math.PI / 180;
    let cap;
    if (i === 0 && lockedCenter && typeof lockedCenter.lat === "number") {
      cap = _makeCapAtLatLon(lockedCenter.lat, lockedCenter.lon, radRad);
    } else {
      const lat = Math.max(-89, Math.min(89, Number(c.lat) || 0));
      const lon = ((Number(c.lon) || 0) + 540) % 360 - 180;
      cap = _makeCapAtLatLon(lat, lon, radRad);
    }
    _planetRunDSL(String(c.verbs || ""), cells, neighbors, K, cap, powers);
  }
  // lockLand: restore the pre-application land/ocean status. A cell
  // that was OCEAN gets its elevation pulled below seaLevel (clamp to
  // seaLevel - 0.02); a cell that was LAND gets pushed above (clamp
  // to seaLevel + 0.02 if it would otherwise be below). The cell's
  // ABSOLUTE elevation is preserved if the lock direction agrees with
  // what the verbs produced -- only flips are corrected.
  if (preLandMask) {
    for (let i = 0; i < cells.count; i++) {
      const wasLand = preLandMask[i] === 1;
      const e = cells.elevations[i];
      const isLand = e >= seaLevel;
      if (wasLand && !isLand)      cells.elevations[i] = seaLevel + 0.02;
      else if (!wasLand && isLand) cells.elevations[i] = seaLevel - 0.02;
    }
  }
  _planetPostDSL(cells, neighbors, K, seaLevel, opts);
}

/* Per-preset / per-flavor reference images. Each entry maps a short
 * key to {url, credit, sourcePage, appliesTo}. CORS-friendly
 * Wikimedia thumbnails (400px ≈ 30-100 KB PNG). When the user picks a
 * preset, the painter selects the matching ref and attaches it to the
 * initial generation call as a style example for the LLM. All refs
 * must be in EQUIRECTANGULAR projection so they match our painter. */
const PMAP_AI_REFERENCES = {
  // --- LANDMASS-FIRST references (binary land/ocean from Azgaar Fantasy
  //     Map Generator's Continents + Old World templates -- these are the
  //     style targets for the initial AI pass which generates LANDMASS
  //     SHAPE only. Served via raw.githubusercontent.com with CORS open.
  //     Stored in tools/pmap-harness/refs/landmass/ in this repo.) ---
  landmassTwoContinents: {
    url: "https://raw.githubusercontent.com/9LiveZZZ-Git/Gamma-Node/main/tools/pmap-harness/refs/landmass/Patealand%202026-05-21-09-17.png",
    credit: "Patealand world (Azgaar FMG Continents template) -- MIT-licensed FMG output",
    sourcePage: "https://github.com/Azgaar/Fantasy-Map-Generator",
    appliesTo: "Earth-like 2 continents preset -- two distinct landmasses with sea channel + scattered islands"
  },
  landmassOldWorld: {
    url: "https://raw.githubusercontent.com/9LiveZZZ-Git/Gamma-Node/main/tools/pmap-harness/refs/landmass/Chareia%202026-05-21-09-18.png",
    credit: "Chareia world (Azgaar FMG Old World template) -- MIT-licensed FMG output",
    sourcePage: "https://github.com/Azgaar/Fantasy-Map-Generator",
    appliesTo: "Old World preset -- elongated twin landmasses with isthmus middle"
  },
  landmassMultiContinent: {
    url: "https://raw.githubusercontent.com/9LiveZZZ-Git/Gamma-Node/main/tools/pmap-harness/refs/landmass/Cheia%202026-05-21-09-20.png",
    credit: "Cheia world (Azgaar FMG Continents template) -- MIT-licensed FMG output",
    sourcePage: "https://github.com/Azgaar/Fantasy-Map-Generator",
    appliesTo: "Earth-like 5 continents, twin continents, continental drift presets"
  },
  landmassPangaea: {
    url: "https://raw.githubusercontent.com/9LiveZZZ-Git/Gamma-Node/main/tools/pmap-harness/refs/landmass/Barteland%202026-05-21-09-20.png",
    credit: "Barteland world (Azgaar FMG Pangea template) -- MIT-licensed FMG output",
    sourcePage: "https://github.com/Azgaar/Fantasy-Map-Generator",
    appliesTo: "Pangaea preset -- one big supercontinent with offshore islands"
  },
  landmassFragmented: {
    url: "https://raw.githubusercontent.com/9LiveZZZ-Git/Gamma-Node/main/tools/pmap-harness/refs/landmass/Bely%202026-05-21-09-19.png",
    credit: "Bely world (Azgaar FMG Continents template) -- MIT-licensed FMG output",
    sourcePage: "https://github.com/Azgaar/Fantasy-Map-Generator",
    appliesTo: "Mediterranean, volcanic arcs presets -- two-cluster layout with inland features"
  },
};

const _planetRefCache = {};
async function _loadPlanetReference(refKey) {
  if (!refKey || !PMAP_AI_REFERENCES[refKey]) return null;
  if (refKey in _planetRefCache) return _planetRefCache[refKey];
  const def = PMAP_AI_REFERENCES[refKey];
  try {
    const resp = await fetch(def.url, { mode: "cors" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const blob = await resp.blob();
    const buf = await blob.arrayBuffer();
    const u8 = new Uint8Array(buf);
    let str = "";
    for (let i = 0; i < u8.length; i++) str += String.fromCharCode(u8[i]);
    const b64 = btoa(str);
    _planetRefCache[refKey] = b64;
    console.log("[planet-map] ref '" + refKey + "' loaded (" + Math.round(u8.length / 1024) + " KB)");
    return b64;
  } catch (e) {
    _planetRefCache[refKey] = null;
    console.warn("[planet-map] ref '" + refKey + "' fetch failed (likely CORS):", e.message || e);
    return null;
  }
}

/* Landmass area measurement. Counts cells above sea level after
 * cap-DSL run + post-DSL pipeline. Earth's two big landmass clusters
 * (Americas + Eurasia-Africa) together cover ~22% of the planet
 * surface; all Earth land is ~29%. We use 22-30% as the "Earth-like"
 * target band; the AI prompt is told to design for it and the painter
 * displays the resulting % in the status line. */
function _planetMeasureLandmass(cells, seaLevel) {
  const N = cells.count;
  const sl = (typeof seaLevel === "number") ? seaLevel : 0.55;
  let landCells = 0;
  for (let i = 0; i < N; i++) if (cells.elevations[i] >= sl) landCells++;
  return { landCells, totalCells: N, landFraction: landCells / N };
}

async function _capturePainterPng(canvas) {
  // Returns base64-encoded PNG of the painter's 2D equirect canvas.
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error("canvas.toBlob returned null")); return; }
      try {
        const buf = await blob.arrayBuffer();
        const u8 = new Uint8Array(buf);
        let str = "";
        for (let i = 0; i < u8.length; i++) str += String.fromCharCode(u8[i]);
        resolve(btoa(str));
      } catch (e) { reject(e); }
    }, "image/png");
  });
}

/* AI generation w/ optional vision-audit rounds.
 *
 * Round 0: send the user prompt → get plan → apply + render.
 * Rounds 1..N: capture rendered painter PNG → send (prompt + previous
 *              plan + image) → get revised plan → apply + render.
/* §planet-spec Phase 7.f-geo -- GeoJSON LANDMASS STAMPER.
 *
 * Accepts an Azgaar FMG Cells GeoJSON export (FeatureCollection of
 * Voronoi cell polygons in [lon, lat] degrees with properties.height
 * + properties.type), rasterizes the LAND polygons to a binary mask,
 * then stamps the mask onto our spherical cell graph.
 *
 * This is the deterministic alternative to AI generation: drop in
 * any GeoJSON (Earth, Azgaar export, hand-authored polygons) and
 * the cell graph's elevations are set to exactly that landmass shape.
 *
 * Land detection rules:
 *   1. properties.height is a number > 0 (Azgaar exports in meters
 *      OR the 0-100 logical scale -- both have negative = ocean)
 *   2. properties.type !== "ocean" (fallback when no height)
 *   3. All other features default to ocean
 *
 * Coordinate handling:
 *   - lon clamped/wrapped to [-180, 180]
 *   - lat clamped to [-90, 90] (Azgaar exports sometimes exceed
 *     this slightly due to pixel-to-degree scaling artifacts)
 *
 * Resolution: 2048x1024 rasterization gives 0.18° resolution -- finer
 * than our N=60k cell graph's per-cell angular extent (~1.3°) so the
 * stamp's fidelity is bound by cell density, not raster resolution.
 *
 * After stamping, runs postDSL with skipCleanup+skipSmoothing so the
 * piecewise sealevel remap fires but the stamped binary mask is
 * preserved verbatim. Returns { landCells, totalCells, landFraction,
 * featuresProcessed, landFeatures, rasterMs, stampMs }. */
/* §planet-spec Phase 7.f-azgaar -- AZGAAR FULL JSON STAMPER.
 *
 * Accepts an Azgaar Fantasy Map Generator FULL JSON export (the
 * one you get from "Export -> Save as JSON" in FMG, NOT the Cells
 * GeoJSON). Format (from FMG v1.122+):
 *   - info: { width, height, ... }
 *   - mapCoordinates: { latN, latS, lonW, lonE }   (pixel->lat/lon)
 *   - pack.cells: [{ i, v, p, h, ... }]            (h is 0..100, sealevel=20)
 *   - pack.vertices: [{ i, p }]                    (p is [px, py] pixel)
 *
 * For each pack.cells entry, reconstruct the polygon from its
 * vertex IDs (cell.v -> vertices[id].p), convert pixel-space
 * polygon to lat/lon via mapCoordinates, rasterize the polygon
 * in a grayscale value encoding the cell's h.
 *
 * Politics (cultures, burgs, states, provinces, religions,
 * markers, routes, zones) are deliberately IGNORED -- this only
 * cares about height + biome.
 *
 * Detection: full JSON has `pack.cells` as an array of objects
 * with .h .v .p properties. GeoJSON has `features` as an array
 * of objects with .geometry / .properties. _planetStampLandmass
 * below auto-dispatches based on top-level shape. */
async function _planetStampAzgaarJSON(json, cells, neighbors, K, seaLevel, onStatus) {
  if (!json || !json.pack || !Array.isArray(json.pack.cells) || !Array.isArray(json.pack.vertices)) {
    throw new Error("input is not a valid Azgaar full JSON (missing pack.cells or pack.vertices)");
  }
  const cellsSrc = json.pack.cells;
  const verts = json.pack.vertices;
  const N = cells.count;
  const info = json.info || {};
  const mapCoords = json.mapCoordinates || {};
  const W_src = info.width  || 1600;
  const H_src = info.height || 800;
  // mapCoords: latN (north edge lat) and latS (south edge lat); same
  // for lon. Default to full sphere if not present.
  const latN = (typeof mapCoords.latN === "number") ? mapCoords.latN : 90;
  const latS = (typeof mapCoords.latS === "number") ? mapCoords.latS : -90;
  const lonW = (typeof mapCoords.lonW === "number") ? mapCoords.lonW : -180;
  const lonE = (typeof mapCoords.lonE === "number") ? mapCoords.lonE : 180;

  onStatus && onStatus("rasterizing " + cellsSrc.length + " cells…");
  const W = 2048, H = 1024;
  const t0 = performance.now();
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);

  // Convert pixel (px, py) in the source map to canvas pixel (cx, cy)
  // in our 2048x1024 rasterizer:
  //   1. pixel -> source lat/lon via mapCoordinates
  //   2. lat/lon -> canvas pixel (full sphere, equirect)
  function srcToCanvas(px, py) {
    // Source pixel space: x=0 -> lonW, x=W_src -> lonE; y=0 -> latN, y=H_src -> latS.
    const lon = lonW + (px / W_src) * (lonE - lonW);
    const lat = latN - (py / H_src) * (latN - latS);
    let lonC = ((lon + 180) % 360 + 360) % 360 - 180;
    let latC = Math.max(-90, Math.min(90, lat));
    return [(lonC + 180) / 360 * W, (90 - latC) / 180 * H];
  }

  // Azgaar h is 0..100 with sealevel at 20. Convert to grayscale:
  //   ocean (h < 20):  grey 0..50   matches our GeoJSON decoder
  //   land  (h >= 20): grey 53..255 matches our GeoJSON decoder
  function azgaarHeightToGrey(h_int) {
    if (h_int < 20) {
      const t = h_int / 20;  // 0..1
      return Math.round(t * 50);
    } else {
      const t = (h_int - 20) / 80;  // 0..1 as h goes 20..100
      return 53 + Math.round(Math.max(0, Math.min(1, t)) * 202);
    }
  }

  // Two-pass draw: ocean (h<20) first, land on top so any overlap
  // resolves in favor of land. Within each pass, sort by h asc so
  // bigger heights paint over smaller heights -- mountain peaks
  // dominate their cells visually.
  let landCount = 0, oceanCount = 0;
  const oceanIdx = [], landIdx = [];
  for (let i = 0; i < cellsSrc.length; i++) {
    const c = cellsSrc[i];
    if (!c || !Array.isArray(c.v) || c.v.length < 3) continue;
    if (typeof c.h !== "number") continue;
    if (c.h < 20) oceanIdx.push(i); else landIdx.push(i);
  }
  oceanIdx.sort((a, b) => cellsSrc[a].h - cellsSrc[b].h);
  landIdx.sort((a, b) => cellsSrc[a].h - cellsSrc[b].h);

  function drawCell(idx) {
    const c = cellsSrc[idx];
    const grey = azgaarHeightToGrey(c.h);
    ctx.fillStyle = "rgb(" + grey + "," + grey + "," + grey + ")";
    ctx.beginPath();
    for (let j = 0; j < c.v.length; j++) {
      const vid = c.v[j];
      const v = verts[vid];
      if (!v || !Array.isArray(v.p)) continue;
      const [cx, cy] = srcToCanvas(v.p[0], v.p[1]);
      if (j === 0) ctx.moveTo(cx, cy);
      else         ctx.lineTo(cx, cy);
    }
    ctx.closePath();
    ctx.fill();
  }
  for (const i of oceanIdx) { drawCell(i); oceanCount++; }
  for (const i of landIdx)  { drawCell(i);  landCount++;  }
  const rasterMs = performance.now() - t0;

  // Stamp pixel -> cell elevation.
  onStatus && onStatus("stamping " + N + " cells…");
  const t1 = performance.now();
  const img = ctx.getImageData(0, 0, W, H);
  const data = img.data;
  let landCells = 0;
  for (let i = 0; i < N; i++) {
    const x = cells.positions[i*3], y = cells.positions[i*3+1], z = cells.positions[i*3+2];
    const lat = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
    const lon = Math.atan2(z, x) * 180 / Math.PI;
    let px = Math.floor((lon + 180) / 360 * W);
    let py = Math.floor((90 - lat) / 180 * H);
    if (px < 0) px = 0; else if (px >= W) px = W - 1;
    if (py < 0) py = 0; else if (py >= H) py = H - 1;
    const grey = data[(py * W + px) * 4];
    let logical;
    if (grey <= 51) {
      logical = (grey / 50) * 0.196;
    } else {
      const t = (grey - 53) / 202;
      logical = 0.208 + t * (1.0 - 0.208);
    }
    cells.elevations[i] = logical;
    if (logical >= 0.20) landCells++;
  }
  const stampMs = performance.now() - t1;

  _planetPostDSL(cells, neighbors, K, seaLevel, { skipCleanup: true, skipSmoothing: true });
  if (cells.biome) cells.biome.fill(0);
  if (cells.flux)  cells.flux.fill(0);
  if (cells.riverId) cells.riverId.fill(-1);
  if (cells.lake) cells.lake.fill(0);

  return {
    landCells, totalCells: N, landFraction: landCells / N,
    featuresProcessed: cellsSrc.length,
    landFeatures: landCount, oceanFeatures: oceanCount,
    rasterMs: +rasterMs.toFixed(1), stampMs: +stampMs.toFixed(1),
    format: "azgaar"
  };
}

// Dispatcher -- auto-detect format and route to the right stamper.
async function _planetStampLandmass(json, cells, neighbors, K, seaLevel, onStatus) {
  if (json && json.pack && Array.isArray(json.pack.cells) && Array.isArray(json.pack.vertices)) {
    return _planetStampAzgaarJSON(json, cells, neighbors, K, seaLevel, onStatus);
  }
  if (json && Array.isArray(json.features)) {
    return _planetStampGeoJSON(json, cells, neighbors, K, seaLevel, onStatus);
  }
  throw new Error("unsupported file: expected an Azgaar FMG full JSON (.json with pack.cells) or a GeoJSON FeatureCollection (.geojson with features)");
}

async function _planetStampGeoJSON(geojson, cells, neighbors, K, seaLevel, onStatus) {
  if (!geojson || !Array.isArray(geojson.features)) {
    throw new Error("input must be a GeoJSON FeatureCollection with features array");
  }
  const N = cells.count;
  onStatus && onStatus("rasterizing " + geojson.features.length + " features…");

  // Step 1: rasterize EVERY feature (land + ocean) to a GRAYSCALE
  // canvas where the pixel value encodes the cell's Azgaar logical
  // height (0..1 with sea level at 0.20):
  //
  //   Ocean cells (h_meters < 0 OR type === "ocean"):
  //     0..50 in 0-255 grey  -->  0.00..0.196 in 0..1 logical
  //   Land cells (h_meters > 0):
  //     53..255 in 0-255 grey -->  0.208..1.000 in 0..1 logical
  //
  // Heights are linearly normalized against a 10000m reference
  // (Earth-ish: Everest ~8848m, Mariana Trench ~-11034m). Caps
  // beyond the reference saturate. Choice of 10000m gives a
  // sensible distribution for Azgaar exports (whose max can
  // reach 20000+m due to heightExponent inflation).
  const W = 2048, H = 1024;
  const t0 = performance.now();
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);   // ocean-floor default
  const HEIGHT_REF = 10000;  // meters at which we saturate to 1.0 / 0.0

  function heightToGrey(h_m, isOcean) {
    if (isOcean) {
      // -HEIGHT_REF..0 maps to 0..50 grey (0.00..0.196 logical).
      const t = Math.max(0, Math.min(1, (h_m + HEIGHT_REF) / HEIGHT_REF));
      return Math.round(t * 50);
    } else {
      // 0..HEIGHT_REF maps to 53..255 grey (0.208..1.000 logical).
      const t = Math.max(0, Math.min(1, h_m / HEIGHT_REF));
      return 53 + Math.round(t * 202);
    }
  }

  let landFeatures = 0, oceanFeatures = 0;
  // Sort features so OCEAN features draw FIRST (they're the
  // "background"), then LAND on top -- the ocean polygons may
  // overlap land slightly due to coordinate rounding, and we want
  // land to win.
  const featsOcean = [];
  const featsLand  = [];
  for (const feat of geojson.features) {
    if (!feat || !feat.geometry) continue;
    const props = feat.properties || {};
    const h = (typeof props.height === "number") ? props.height : null;
    const t = props.type;
    const isOcean = (h !== null) ? h < 0 : (t === "ocean");
    (isOcean ? featsOcean : featsLand).push({ feat, h, isOcean });
  }
  function drawFeats(list) {
    for (const item of list) {
      const { feat, h, isOcean } = item;
      const hM = (h !== null) ? h : (isOcean ? -200 : 100);  // fallback if no height
      const grey = heightToGrey(hM, isOcean);
      ctx.fillStyle = "rgb(" + grey + "," + grey + "," + grey + ")";
      if (isOcean) oceanFeatures++; else landFeatures++;
      const geom = feat.geometry;
      const polys = (geom.type === "Polygon")      ? [geom.coordinates]
                  : (geom.type === "MultiPolygon") ? geom.coordinates
                  : null;
      if (!polys) continue;
      for (const poly of polys) {
        ctx.beginPath();
        for (const ring of poly) {
          for (let i = 0; i < ring.length; i++) {
            const pt = ring[i];
            if (!Array.isArray(pt) || pt.length < 2) continue;
            let lon = pt[0], lat = pt[1];
            lon = ((lon + 180) % 360 + 360) % 360 - 180;
            if (lat < -90) lat = -90;
            else if (lat > 90) lat = 90;
            const px = (lon + 180) / 360 * W;
            const py = (90 - lat) / 180 * H;
            if (i === 0) ctx.moveTo(px, py);
            else         ctx.lineTo(px, py);
          }
          ctx.closePath();
        }
        ctx.fill("evenodd");
      }
    }
  }
  drawFeats(featsOcean);
  drawFeats(featsLand);
  const rasterMs = performance.now() - t0;

  // Step 2: stamp pixel grey -> cell elevation.
  onStatus && onStatus("stamping " + N + " cells…");
  const t1 = performance.now();
  const img = ctx.getImageData(0, 0, W, H);
  const data = img.data;
  let landCells = 0;
  for (let i = 0; i < N; i++) {
    const x = cells.positions[i*3], y = cells.positions[i*3+1], z = cells.positions[i*3+2];
    const lat = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
    const lon = Math.atan2(z, x) * 180 / Math.PI;
    let px = Math.floor((lon + 180) / 360 * W);
    let py = Math.floor((90 - lat) / 180 * H);
    if (px < 0) px = 0; else if (px >= W) px = W - 1;
    if (py < 0) py = 0; else if (py >= H) py = H - 1;
    const grey = data[(py * W + px) * 4];
    // Decode grey -> Azgaar logical height (0..1, sealevel 0.20).
    // grey 0..50  = 0.00..0.196 logical (ocean)
    // grey 53..255 = 0.208..1.000 logical (land)
    let logical;
    if (grey <= 51) {
      logical = (grey / 50) * 0.196;
    } else {
      const t = (grey - 53) / 202;
      logical = 0.208 + t * (1.0 - 0.208);
    }
    cells.elevations[i] = logical;
    if (logical >= 0.20) landCells++;
  }
  const stampMs = performance.now() - t1;

  // Step 3: run postDSL JUST for the sealevel remap. Skip cleanup +
  // smoothing so the height-stamped topography is preserved.
  _planetPostDSL(cells, neighbors, K, seaLevel, { skipCleanup: true, skipSmoothing: true });

  // Invalidate climate / rivers if they were computed.
  if (cells.biome) cells.biome.fill(0);
  if (cells.flux)  cells.flux.fill(0);
  if (cells.riverId) cells.riverId.fill(-1);
  if (cells.lake) cells.lake.fill(0);

  return {
    landCells,
    totalCells: N,
    landFraction: landCells / N,
    featuresProcessed: geojson.features.length,
    landFeatures,
    oceanFeatures,
    rasterMs: +rasterMs.toFixed(1),
    stampMs: +stampMs.toFixed(1)
  };
}

// _planetGenerateFromAI removed 2026-05-21 -- AI feature pipeline retired.


/* §planet-spec Phase 7.b -- serialize / deserialize the cubemap as
 * base64-encoded R16 unorm. 256² × 6 = 393k texels × 2 bytes = 786KB
 * raw → ~1.05MB base64. Cubemap data lives in node.params.cubemapData
 * (the patch's JSON), so save/reload round-trips the authored map.
 * Use Uint16 normalized [0, 65535] -> [0, 1] (R16 unorm) -- 1/65535
 * height resolution × 8km heightScale = 0.12m precision, way more
 * than needed for visible terrain. */
function _encodeCubemapBase64(cubemap) {
  const res = cubemap.resolution;
  const totalU16 = 6 * res * res;
  const u16 = new Uint16Array(totalU16);
  for (let f = 0; f < 6; f++) {
    const data = cubemap.faces[f];
    const base = f * res * res;
    for (let i = 0; i < data.length; i++) {
      const v = Math.max(0, Math.min(1, data[i]));
      u16[base + i] = Math.round(v * 65535);
    }
  }
  const u8 = new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
  // Chunked btoa to avoid building a single multi-MB string in one
  // String.fromCharCode call (some browsers cap arg count at ~64k).
  const chunkSize = 32768;
  let s = "";
  for (let i = 0; i < u8.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, u8.length);
    s += String.fromCharCode.apply(null, u8.subarray(i, end));
  }
  return btoa(s);
}

function _decodeCubemapBase64(b64, res) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  const u16 = new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2);
  const faces = [];
  const expected = 6 * res * res;
  if (u16.length !== expected) {
    console.warn("[planet-map] decoded cubemap size mismatch: got " + u16.length + " u16, expected " + expected + " for res " + res);
    return null;
  }
  for (let f = 0; f < 6; f++) {
    const data = new Float32Array(res * res);
    const base = f * res * res;
    for (let i = 0; i < res * res; i++) data[i] = u16[base + i] / 65535;
    faces.push(data);
  }
  return { resolution: res, faces };
}

/* Sprint 10-5a -- programmatic Earth cubemap. Replaces the
 * Azgaar fbm-on-cells baseline (blob continents) with hardcoded
 * Earth geometry: 15 named continents/islands as rotated ellipses,
 * 8 named mountain ranges as polyline ridges. The bake produces
 * a 6×N² cubemap of elevations in [0, 1] where 0.5 = sea level.
 * 10-1b ridge enhancement + 10-2 erosion run on top so the
 * coastlines + drainage networks emerge from real-Earth-shaped
 * geometry. Sprint 10-5b will swap the hardcoded geometry for an
 * actual ETOPO1/GEBCO DEM fetch; the rest of the pipeline stays
 * identical.
 *
 * Continent ellipses: each entry is (lat, lon, halfWidth°,
 * halfHeight°, rotation°, baseElev). Land if rotated-ellipse
 * distance < 1.
 * Ridge polylines: each entry is a list of lat/lon points + a
 * cross-section width + an elevation boost. Closest-point on
 * each segment determines how much boost a query point gets.
 * Boost only applies on land so mid-ocean ridges don't appear.
 *
 * Sprint 10-5b -- real DEM path. AWS Terrain Tiles (Mapzen
 * terrarium PNG format, S3-hosted, CORS-enabled, no key).
 * URL: https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
 * Encoding per pixel: height_m = (R*256 + G + B/256) - 32768
 * Range: -11034 m (Mariana) to 8848 m (Everest).
 *
 * Strategy: lazy fetch on first _earthElevationAt call. While
 * loading, return the ellipse approximation so something shows.
 * On completion: clear all PlanetMap cubemap caches so the next
 * bake re-runs with real DEM. Zoom 3 = 64 tiles ≈ 2-4 MB total
 * fetched once, browser HTTP-cached after.
 *
 * Web-Mercator caveat: tiles top out at |lat| ≈ 85.05° -- polar
 * regions (Antarctica, Greenland's far north) fall through to
 * the ellipse fallback. Acceptable for v1; future iteration can
 * splice in polar stereographic tiles. */
const _EARTH_DEM = {
  zoom: 3,                  // 2^3 = 8 tiles per edge, 64 total
  tileSize: 256,
  width:  8 * 256,
  height: 8 * 256,
  data: null,
  loaded: false,
  loading: false,
  loadPromise: null,
  loadFailed: false
};

function _decodeTerrariumPixel(r, g, b) {
  return (r * 256 + g + b / 256) - 32768;
}

function _loadEarthDEMTile(z, x, y) {
  return new Promise((resolve, reject) => {
    const url = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/"
              + z + "/" + x + "/" + y + ".png";
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, 256, 256));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("tile fetch failed: " + url));
    img.src = url;
  });
}

function _loadEarthDEM() {
  if (_EARTH_DEM.loaded || _EARTH_DEM.loadFailed) return _EARTH_DEM.loadPromise;
  if (_EARTH_DEM.loading) return _EARTH_DEM.loadPromise;
  _EARTH_DEM.loading = true;
  const z = _EARTH_DEM.zoom;
  const tilesPerEdge = 1 << z;
  const totalTiles = tilesPerEdge * tilesPerEdge;
  const W = _EARTH_DEM.width;
  const H = _EARTH_DEM.height;
  const data = new Float32Array(W * H);
  console.log("[earth-dem] fetching " + totalTiles
              + " Mapzen terrarium tiles at zoom " + z
              + " (~" + (totalTiles * 60 / 1024).toFixed(1) + " MB) ...");
  const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
  const tasks = [];
  let failedTiles = 0;
  for (let ty = 0; ty < tilesPerEdge; ty++) {
    for (let tx = 0; tx < tilesPerEdge; tx++) {
      const _tx = tx, _ty = ty;
      tasks.push(_loadEarthDEMTile(z, _tx, _ty).then((imgData) => {
        const px = imgData.data;
        const baseX = _tx * 256;
        const baseY = _ty * 256;
        for (let py = 0; py < 256; py++) {
          for (let pxIdx = 0; pxIdx < 256; pxIdx++) {
            const i4 = (py * 256 + pxIdx) * 4;
            data[(baseY + py) * W + (baseX + pxIdx)] =
              _decodeTerrariumPixel(px[i4], px[i4 + 1], px[i4 + 2]);
          }
        }
      }).catch((err) => {
        failedTiles++;
        console.warn("[earth-dem] tile (" + _tx + ", " + _ty + ") failed:", err.message);
      }));
    }
  }
  _EARTH_DEM.loadPromise = Promise.all(tasks).then(() => {
    if (failedTiles >= totalTiles * 0.5) {
      _EARTH_DEM.loadFailed = true;
      _EARTH_DEM.loading = false;
      console.warn("[earth-dem] FAILED -- " + failedTiles + "/" + totalTiles
                   + " tiles missing. Falling back to ellipse approximation permanently.");
      return;
    }
    _EARTH_DEM.data = data;
    _EARTH_DEM.loaded = true;
    _EARTH_DEM.loading = false;
    const dt = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;
    // Diagnostic: dump elevation stats + a few known-location samples
    // so we can verify the decode + projection are working.
    let dMin = Infinity, dMax = -Infinity, dSum = 0, nonZero = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < dMin) dMin = v;
      if (v > dMax) dMax = v;
      dSum += v;
      if (v !== 0) nonZero++;
    }
    console.log("[earth-dem] LOADED " + (totalTiles - failedTiles) + "/" + totalTiles
                + " tiles (" + W + "×" + H + " mercator grid) in "
                + (dt / 1000).toFixed(1) + "s. min=" + dMin.toFixed(0)
                + "m max=" + dMax.toFixed(0) + "m mean=" + (dSum/data.length).toFixed(0)
                + "m nonzero=" + nonZero + "/" + data.length);
    // Sample at known-Earth locations to sanity-check projection.
    const probes = [
      { name: "Atlantic eq",  lat:   0, lon: -30 },
      { name: "Africa cent",  lat:   0, lon:  25 },
      { name: "Himalaya",     lat:  28, lon:  85 },
      { name: "Pacific eq",   lat:   0, lon: 180 },
      { name: "Andes",        lat: -25, lon: -70 },
      { name: "Greenland",    lat:  70, lon: -40 },
      { name: "Sahara",       lat:  25, lon:   5 },
      { name: "Amazon",       lat:  -5, lon: -60 }
    ];
    for (const p of probes) {
      const m = _earthDEMSampleMeters(p.lat, p.lon);
      console.log("[earth-dem]   probe " + p.name + " (lat="+p.lat+", lon="+p.lon+") = " + m.toFixed(0) + "m");
    }
    console.log("[earth-dem] invalidating PlanetMap cubemaps for re-bake ...");
    if (typeof state !== "undefined" && state && Array.isArray(state.nodes)) {
      let invalidated = 0;
      for (const n of state.nodes) {
        if (n && n.type === "PlanetMap") {
          n._cubemap = null;
          n._cubemapKey = null;
          if (n.params) {
            n.params.cubemapData = null;
            n.params.cubemapKey = null;
          }
          invalidated++;
        }
      }
      if (invalidated > 0) console.log("[earth-dem] invalidated " + invalidated + " PlanetMap node(s)");
    }
  });
  return _EARTH_DEM.loadPromise;
}

// Sample DEM at (lat, lon) using inverse Web Mercator projection.
// Returns meters, or NaN if outside the Mercator-projectable band.
function _earthDEMSampleMeters(latDeg, lonDeg) {
  if (!_EARTH_DEM.loaded || !_EARTH_DEM.data) return NaN;
  if (latDeg > 85.05 || latDeg < -85.05) return NaN;  // polar fallthrough
  const latRad = latDeg * Math.PI / 180;
  // Mercator y_norm in [0, 1]: 0 = north pole limit, 1 = south pole limit
  const yNorm = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
  // Sprint 10-6 v6: lonDeg here is REAL-WORLD lon (east = +). Callers
  // doing dir→lat/lon negate atan2(uz,ux) at their site so internal
  // world coords (where +Z appears on screen LEFT per right-handed
  // lookAt) get correctly mapped to real-world (east on screen RIGHT).
  let lonN = lonDeg;
  while (lonN >  180) lonN -= 360;
  while (lonN < -180) lonN += 360;
  const xNorm = (lonN + 180) / 360;
  const W = _EARTH_DEM.width;
  const H = _EARTH_DEM.height;
  // Bilinear sample.
  const fx = xNorm * W - 0.5;
  const fy = yNorm * H - 0.5;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const wx = fx - Math.floor(fx);
  const wy = fy - Math.floor(fy);
  const d = _EARTH_DEM.data;
  const e00 = d[y0 * W + x0];
  const e10 = d[y0 * W + x1];
  const e01 = d[y1 * W + x0];
  const e11 = d[y1 * W + x1];
  return (e00 * (1 - wx) + e10 * wx) * (1 - wy)
       + (e01 * (1 - wx) + e11 * wx) * wy;
}

