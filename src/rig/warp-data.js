/* ---------- Phase 6.6 — calibration & warp data layer ---------- */

/* A "Bourke mesh" is the calibration warp format introduced by Paul
 * Bourke for dome / panoramic projection rigs. Each vertex carries 5
 * floats:
 *
 *     (x, y,   u, v,   intensity)
 *      └────┘  └────┘  └───────┘
 *      output  source  edge-blend
 *      NDC     UV      multiplier
 *
 * The mesh is a regular (cols+1) × (rows+1) grid of vertices, forming
 * cols × rows quads. The render path (Phase 6.6.4) uploads the verts
 * as a vertex buffer and draws the grid as triangle strips, sampling
 * the display's source layer at (u, v) and writing to (x, y) on the
 * projector's framebuffer. The intensity is multiplied into the
 * fragment color so overlap regions can fade between projectors.
 *
 *   x, y       — output position in normalized device coords [-1, 1].
 *                Default identity grid: x = u*2 - 1, y = v*2 - 1.
 *                Calibration shifts these to compensate for screen
 *                curvature, projector keystoning, and lens distortion.
 *
 *   u, v       — source texture coords in [0, 1]. Default identity:
 *                u = c / cols, v = r / rows. Adjusting these is rare
 *                — calibration usually moves x/y, not u/v — but the
 *                format supports it so one display can preview a
 *                sub-region of its source layer if useful.
 *
 *   intensity  — edge-blend multiplier in [0, 1]. Default 1 (no blend).
 *                Auto-blend (Phase 6.6.11) generates ramps so adjacent
 *                projectors' intensities sum to ~1 in the overlap.
 *
 * In-memory representation: plain Array of length (cols+1)*(rows+1)*5
 * so it round-trips through JSON.stringify in .gpatch saves without
 * loss. Float32Array conversion happens at GPU upload time, not before.
 *
 * A warpMesh of `null` means "no warp" — the render path falls back to
 * the fullscreen-triangle pipeline, which is what every patch saved
 * before Phase 6.6 has. Identity warp meshes (built via
 * _makeIdentityWarpMesh) are functionally equivalent to null but allow
 * subsequent calibration edits without re-allocating the mesh. */
function _makeIdentityWarpMesh(cols, rows) {
  cols = Math.max(1, cols | 0); rows = Math.max(1, rows | 0);
  const W = cols + 1, H = rows + 1;
  const verts = new Array(W * H * 5);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      const i = (r * W + c) * 5;
      verts[i + 0] = u * 2 - 1;     // x in NDC
      verts[i + 1] = v * 2 - 1;     // y in NDC
      verts[i + 2] = u;              // u in source UV
      verts[i + 3] = v;              // v in source UV
      verts[i + 4] = 1;              // intensity (no blend)
    }
  }
  return { cols, rows, verts };
}

/* Triangular variant of the identity mesh — alternate rows are
 * offset by half a cell width so the (cols)×(rows) quads triangulate
 * into diamonds instead of axis-aligned rectangles. Useful when the
 * physical screen has curvature that doesn't align with the grid
 * axes; the diagonal edges give the warp more freedom in the
 * direction the rectangular grid wouldn't.
 *
 * The offset is applied to mesh NDC x only (preserves V mapping +
 * intensity = 1 everywhere). UVs follow the offset so source
 * sampling stays correct after warp edits. Edge columns stay pinned
 * at x = ±1 so the boundary doesn't poke outside the quad. */
function _makeTriangularWarpMesh(cols, rows) {
  const m = _makeIdentityWarpMesh(cols, rows);
  const W = cols + 1, H = rows + 1;
  const halfCell = 0.5 / cols;
  for (let r = 0; r < H; r++) {
    if ((r & 1) === 0) continue;     // even rows untouched
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 5;
      // Pinned edges so the quad's outer boundary stays a clean rectangle.
      if (c === 0 || c === cols) continue;
      // Shift x by half-cell-NDC; matching shift in u so the
      // sampled source content stays aligned to the new vertex.
      m.verts[i + 0] += halfCell * 2;
      m.verts[i + 2] += halfCell;
    }
  }
  return m;
}

/* Build a test-warp mesh: identity grid with sinusoidal bow on x +
 * a horizontal intensity ramp on the left/right edges. Used by the
 * rig pane's per-display "warp: test" toggle to verify the full
 * Phase 6.6 pipeline (warp geometry + edge-blend intensity + gamma
 * + power + black-lift) end-to-end without committing to a full
 * editor UX.
 *
 * Effects baked in:
 *   - Geometric bow: middle of each row pinches inward by 12%, top
 *     + bottom rows untouched. Demonstrates the warp vertex pipeline.
 *   - Edge intensity ramp: leftmost + rightmost ~20% of the mesh
 *     fade from intensity 0.25 at the edge to 1.0 at the inner
 *     bound. Demonstrates the intensity multiply, gamma correction,
 *     power curve, and black-lift math from 6.6.5–6.6.8. With
 *     blackLift > 0 you'll see the edges raise to a non-black floor
 *     instead of fading to black. */
function _makeTestWarpMesh(cols, rows) {
  const m = _makeIdentityWarpMesh(cols, rows);
  const W = cols + 1, H = rows + 1;
  // Width of the intensity ramp: 20% of the mesh on each side.
  const rampWidth = 0.2;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 5;
      const u = c / cols;
      const v = r / rows;
      // Geometric: pinch x toward center on the equator row.
      const k = 1.0 - 0.12 * Math.sin(Math.PI * v);
      m.verts[i + 0] *= k;
      // Intensity ramp: left edge rises from 0.25 → 1.0 across the
      // first 20% of u; right edge mirrors. Smooth (Hermite) easing
      // so the ramp reads as a soft fade, not a hard step.
      let leftRamp  = 1.0;
      let rightRamp = 1.0;
      if (u < rampWidth) {
        const t = u / rampWidth;
        const smooth = t * t * (3 - 2 * t);
        leftRamp = 0.25 + smooth * 0.75;
      }
      if (u > 1 - rampWidth) {
        const t = (1 - u) / rampWidth;
        const smooth = t * t * (3 - 2 * t);
        rightRamp = 0.25 + smooth * 0.75;
      }
      m.verts[i + 4] = Math.min(leftRamp, rightRamp);
    }
  }
  m._isTest = true;
  return m;
}

/* ------------ Phase 6.6.19 — Bezier-patch warp authoring -------------- *
 *
 * Inspired by Sajadi & Majumder, "Autocalibration of Multiprojector
 * CAVE-Like Immersive Environments" (IEEE TVCG 2012, doc 6060818).
 *
 * The paper represents a projector→display warp as a single rational
 * Bezier patch BX,BY (and BZ for full 3D, but our 2D pipeline only
 * needs BX,BY). For our authoring use case we use a *non*-rational
 * Bezier (all weights 1) since the perspective-invariance argument
 * doesn't apply when the user is hand-editing — they want shape,
 * not a fitted-to-physics representation.
 *
 * Tradeoff vs the existing 33×33-vertex mesh authoring:
 *   Mesh:   N² draggable points, exact local control, but tedious
 *           for smooth curved warps and visible faceting at low N.
 *   Bezier: ~25 draggable points (default 5×5 = degree 4), smooth
 *           C^∞ everywhere, much faster to author for sphere/dome
 *           warps. Not all warps are reachable (Bezier of finite
 *           degree can't have arbitrary local detail), but a 5×5
 *           patch is enough for AlloSphere-class smooth surfaces.
 *
 * Storage: a Bezier patch lives as `m._bezier = { cols, rows, ctrl }`
 * piggy-backing on the existing warpMesh object. ctrl is a flat
 * (cols+1)*(rows+1)*2 array of (x, y) NDC positions in row-major
 * order. The mesh's `verts` field stays the source of truth for the
 * GPU pipeline — when the user drags a control point we re-tessellate
 * verts from ctrl. This means zero shader changes; the runtime
 * doesn't even know it's looking at a Bezier output.
 *
 * Round-trip: JSON.stringify preserves the `_bezier` field through
 * .gpatch saves. On load, _validateWarpMesh ignores extra fields so
 * the bezier rides along with the mesh.
 */

/* Bernstein basis B_i^n(t) = C(n,i) t^i (1-t)^(n-i), for i = 0..n.
 * Returned as a flat array of length n+1. We compute binomial coeffs
 * incrementally to avoid factorial blowup. */
function _bernsteinBasis(n, t) {
  const out = new Array(n + 1);
  const u = 1 - t;
  // B_0^n(t) = (1-t)^n.
  out[0] = Math.pow(u, n);
  // B_i^n(t) = C(n,i) t^i (1-t)^(n-i). Incremental binomial: C(n,i)
  // = C(n,i-1) * (n-i+1) / i.
  let coef = 1;
  for (let i = 1; i <= n; i++) {
    coef = coef * (n - i + 1) / i;
    out[i] = coef * Math.pow(t, i) * Math.pow(u, n - i);
  }
  return out;
}

/* Tensor-product Bezier surface evaluation at (u, v) ∈ [0,1]².
 * ctrl is a flat row-major (cols+1)*(rows+1)*2 array of (x, y).
 * Returns {x, y} of the surface at (u, v). */
function _bezierEval(ctrl, cols, rows, u, v) {
  const Bu = _bernsteinBasis(cols, u);
  const Bv = _bernsteinBasis(rows, v);
  const W = cols + 1;
  let x = 0, y = 0;
  for (let j = 0; j <= rows; j++) {
    const bvj = Bv[j];
    for (let i = 0; i <= cols; i++) {
      const w = Bu[i] * bvj;
      const k = (j * W + i) * 2;
      x += w * ctrl[k];
      y += w * ctrl[k + 1];
    }
  }
  return { x, y };
}

/* Build an identity Bezier control-point grid: a uniform (cols+1)×
 * (rows+1) grid of NDC positions spanning [-1, +1]² with no warp.
 * The Bezier surface of a regular control grid reproduces the affine
 * map exactly (linear-precision property), so identity in → identity
 * out. */
function _makeIdentityBezier(cols, rows) {
  cols = Math.max(1, cols | 0); rows = Math.max(1, rows | 0);
  const W = cols + 1, H = rows + 1;
  const ctrl = new Array(W * H * 2);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 2;
      ctrl[i + 0] = (c / cols) * 2 - 1;
      ctrl[i + 1] = (r / rows) * 2 - 1;
    }
  }
  return { cols, rows, ctrl };
}

/* Tessellate a Bezier patch into a fine warp mesh suitable for the
 * existing GPU pipeline. UVs + intensity stay regular (uniform source
 * sampling, no edge-blend); only NDC (x, y) are overridden by Bezier
 * eval. The resulting mesh carries `m._bezier = bezier` so the editor
 * can recognize bezier-authored meshes on reopen. */
function _bezierToWarpMesh(bezier, meshCols, meshRows) {
  meshCols = Math.max(2, meshCols | 0);
  meshRows = Math.max(2, meshRows | 0);
  const m = _makeIdentityWarpMesh(meshCols, meshRows);
  const W = meshCols + 1, H = meshRows + 1;
  for (let r = 0; r < H; r++) {
    const v = r / meshRows;
    for (let c = 0; c < W; c++) {
      const u = c / meshCols;
      const p = _bezierEval(bezier.ctrl, bezier.cols, bezier.rows, u, v);
      const idx = (r * W + c) * 5;
      m.verts[idx + 0] = p.x;
      m.verts[idx + 1] = p.y;
    }
  }
  // Carry the bezier control grid on the mesh as the source of truth.
  // Slice ctrl so future drags don't share the input array.
  m._bezier = { cols: bezier.cols, rows: bezier.rows, ctrl: bezier.ctrl.slice() };
  return m;
}

/* Re-tessellate the mesh's vert positions from its current `_bezier`
 * control grid. Called after every Bezier control-point drag. UVs +
 * intensity are preserved (only NDC x, y change). meshCols/meshRows
 * are pulled from the existing mesh so we don't change tessellation
 * density mid-edit. */
function _rebuildMeshFromBezier(m) {
  if (!m || !m._bezier) return;
  const cols = m.cols, rows = m.rows, W = cols + 1, H = rows + 1;
  for (let r = 0; r < H; r++) {
    const v = r / rows;
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const p = _bezierEval(m._bezier.ctrl, m._bezier.cols, m._bezier.rows, u, v);
      const idx = (r * W + c) * 5;
      m.verts[idx + 0] = p.x;
      m.verts[idx + 1] = p.y;
    }
  }
}

/* Default tessellation density for the GPU mesh derived from a
 * Bezier patch. 32×32 quads = 33² = 1089 vertices — fine enough that
 * the smooth Bezier surface doesn't show faceting on a 1080p output,
 * cheap enough to re-tessellate on every drag at 60fps. */
const BEZIER_MESH_TESS = 32;

/* ------------ Phase 6.6.3 — CSV / MPCDI exporters ---------------------- */

/* CRC-32 (IEEE 802.3 polynomial 0xEDB88320). Required by the ZIP
 * spec for every file entry's checksum. Pre-built table is built
 * once on first use and cached. ~3 KB lookup table; trivial. */
let _crc32Table = null;
function _crc32(buf) {
  if (!_crc32Table) {
    _crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crc32Table[n] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* Pure-JS ZIP encoder. Takes { filename: Uint8Array, ... } and
 * returns a Uint8Array containing a valid ZIP archive. No external
 * deps — uses the well-defined ZIP format directly. STORED method
 * only (no DEFLATE) — keeps the encoder simple and the resulting
 * file is just as readable by any unzip tool. MPCDI bundles are
 * small (XML + a few CSV files) so the ~zero compression penalty is
 * fine. ZIP64 not used (4 GB / 64K caps still well above any
 * realistic MPCDI payload). */
function _writeZipArchive(files) {
  const enc = new TextEncoder();
  const entries = [];
  let offset = 0;
  // Per-entry: build local header, write data, record central-dir info.
  const chunks = [];
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const crc = _crc32(data);
    const localHeader = new ArrayBuffer(30);
    const lhView = new DataView(localHeader);
    lhView.setUint32(0,  0x04034b50, true);    // signature
    lhView.setUint16(4,  20,         true);    // version needed
    lhView.setUint16(6,  0,          true);    // flags
    lhView.setUint16(8,  0,          true);    // method (0 = STORED)
    lhView.setUint16(10, 0,          true);    // mod time
    lhView.setUint16(12, 0,          true);    // mod date
    lhView.setUint32(14, crc,        true);    // CRC-32
    lhView.setUint32(18, data.length, true);   // compressed size (== uncompressed for STORED)
    lhView.setUint32(22, data.length, true);   // uncompressed size
    lhView.setUint16(26, nameBytes.length, true);
    lhView.setUint16(28, 0, true);             // extra field length
    chunks.push(new Uint8Array(localHeader), nameBytes, data);
    entries.push({ name: nameBytes, crc, size: data.length, offset });
    offset += 30 + nameBytes.length + data.length;
  }
  // Central directory.
  const cdStart = offset;
  for (const e of entries) {
    const cdHeader = new ArrayBuffer(46);
    const cdView = new DataView(cdHeader);
    cdView.setUint32(0,  0x02014b50, true);
    cdView.setUint16(4,  20, true);            // version made by
    cdView.setUint16(6,  20, true);            // version needed
    cdView.setUint16(8,  0,  true);            // flags
    cdView.setUint16(10, 0,  true);            // method
    cdView.setUint16(12, 0,  true);            // mod time
    cdView.setUint16(14, 0,  true);            // mod date
    cdView.setUint32(16, e.crc, true);
    cdView.setUint32(20, e.size, true);
    cdView.setUint32(24, e.size, true);
    cdView.setUint16(28, e.name.length, true);
    cdView.setUint16(30, 0,  true);            // extra
    cdView.setUint16(32, 0,  true);            // comment
    cdView.setUint16(34, 0,  true);            // disk
    cdView.setUint16(36, 0,  true);            // internal attrs
    cdView.setUint32(38, 0,  true);            // external attrs
    cdView.setUint32(42, e.offset, true);
    chunks.push(new Uint8Array(cdHeader), e.name);
    offset += 46 + e.name.length;
  }
  const cdEnd = offset;
  // EOCD.
  const eocd = new ArrayBuffer(22);
  const eView = new DataView(eocd);
  eView.setUint32(0,  0x06054b50, true);
  eView.setUint16(4,  0, true);
  eView.setUint16(6,  0, true);
  eView.setUint16(8,  entries.length, true);
  eView.setUint16(10, entries.length, true);
  eView.setUint32(12, cdEnd - cdStart, true);
  eView.setUint32(16, cdStart, true);
  eView.setUint16(20, 0, true);
  chunks.push(new Uint8Array(eocd));
  // Concat.
  let total = 0; for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/* Serialize a Bourke warp mesh to text. Format:
 *     2
 *     N M
 *     x y u v intensity            (per vertex, row-major)
 *
 * Six decimals on the floats — finer than any visible difference at
 * 1080p, smaller than 16-byte floats but accurate enough to round-
 * trip the editor's drag precision. */
function _serializeBourkeMesh(mesh) {
  if (!_validateWarpMesh(mesh)) throw new Error("invalid warp mesh");
  const W = mesh.cols + 1, H = mesh.rows + 1;
  const lines = ["2", W + " " + H];
  for (let i = 0; i < W * H; i++) {
    const o = i * 5;
    lines.push(
      mesh.verts[o + 0].toFixed(6) + " " +
      mesh.verts[o + 1].toFixed(6) + " " +
      mesh.verts[o + 2].toFixed(6) + " " +
      mesh.verts[o + 3].toFixed(6) + " " +
      mesh.verts[o + 4].toFixed(6)
    );
  }
  return lines.join("\n") + "\n";
}

/* Generate a minimal MPCDI XML manifest describing the rig. Per-
 * region warp/alpha file references are written as Bourke CSV
 * filenames (our exporter writes CSVs into the bundle, not PFM).
 * External tools that strictly expect PFM may reject these; that's
 * a follow-on (6.6.3b). For round-trip with our own importer the
 * output is correct. */
function _serializeMpcdiXml(rig, opts) {
  const displays = rig && Array.isArray(rig.displays) ? rig.displays : [];
  const warpExt = (opts && opts.warpExt) || "pfm";
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<MPCDI version="2.0" profile="3d" geometric_unit="mm" date="' + new Date().toISOString().slice(0,10) + '" exporter="Gamma-Node-' + APP_VERSION + '">');
  parts.push('  <display id="display1">');
  parts.push('    <buffer id="buffer1" Xresolution="' + (rig.masterRes ? rig.masterRes[0] : 1920) + '" Yresolution="' + (rig.masterRes ? rig.masterRes[1] : 1080) + '">');
  for (let i = 0; i < displays.length; i++) {
    const d = displays[i];
    if (!d) continue;
    const pose = d.pose || { yaw: 0, pitch: 0, roll: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    const id   = d.id   || ("region" + i);
    const fname = id + "_warp." + warpExt;
    parts.push('      <region id="' + id + '" x="0" y="0" xsize="1" ysize="1">');
    parts.push('        <frustum>');
    parts.push('          <yaw>'   + pose.yaw   + '</yaw>');
    parts.push('          <pitch>' + pose.pitch + '</pitch>');
    parts.push('          <roll>'  + (pose.roll || 0) + '</roll>');
    parts.push('          <rightAngle>' + ( fov.h * 0.5) + '</rightAngle>');
    parts.push('          <leftAngle>'  + (-fov.h * 0.5) + '</leftAngle>');
    parts.push('          <upAngle>'    + ( fov.v * 0.5) + '</upAngle>');
    parts.push('          <downAngle>'  + (-fov.v * 0.5) + '</downAngle>');
    parts.push('        </frustum>');
    if (d.warpMesh) {
      parts.push('        <files>');
      parts.push('          <fileSet region="' + id + '">');
      parts.push('            <geometryWarpFile>' + fname + '</geometryWarpFile>');
      parts.push('          </fileSet>');
      parts.push('        </files>');
    }
    parts.push('      </region>');
  }
  parts.push('    </buffer>');
  parts.push('  </display>');
  parts.push('</MPCDI>');
  return parts.join("\n") + "\n";
}

/* Trigger a browser download of a Blob with the given filename. */
function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

/* User-facing: download a single display's warp mesh as a Bourke
 * CSV file. Filename derives from the display's id + name. */
function exportBourkeMeshForDisplay(displayIdx) {
  const d = state.rig && state.rig.displays && state.rig.displays[displayIdx];
  if (!d) return;
  if (!_validateWarpMesh(d.warpMesh)) {
    alert("Display " + displayIdx + " has no warp mesh to export.\n\nClick ✎ edit + drag a point to create one, or use Auto-blend rig.");
    return;
  }
  try {
    const text = _serializeBourkeMesh(d.warpMesh);
    const safe = String(d.name || d.id || ("display" + displayIdx)).replace(/[^A-Za-z0-9_-]/g, "_");
    _downloadBlob(new Blob([text], { type: "text/plain" }), safe + "_warp.csv");
  } catch (e) {
    alert("Could not export warp mesh:\n\n" + (e && e.message ? e.message : String(e)));
  }
}

/* User-facing: download the whole rig as an MPCDI ZIP bundle.
 *
 * Phase 6.6.3b — bundles include BOTH a Bourke .csv AND a 1024×1024
 * PFM rasterization of each warp mesh. CSV is what our own importer
 * round-trips through; PFM is what VESA-spec MPCDI consumers (VIOSO,
 * dome-projection.com tools, Resolume strict mode) expect. The XML
 * references the PFM so external tools find their format; the CSV
 * is alongside as a fallback that's also more diff-friendly. */
function exportMpcdiBundle() {
  if (!state.rig || !Array.isArray(state.rig.displays)) {
    alert("No rig to export.");
    return;
  }
  try {
    const enc = new TextEncoder();
    const files = {};
    let warpedCount = 0;
    const includePfm = state.rig.displays.some(d => d && _validateWarpMesh(d.warpMesh));
    state.rig.displays.forEach((d, i) => {
      if (!d || !_validateWarpMesh(d.warpMesh)) return;
      const id = d.id || ("region" + i);
      files[id + "_warp.csv"] = enc.encode(_serializeBourkeMesh(d.warpMesh));
      // PFM rasterization is heavier (~1024×1024×3×4 = 12 MB per mesh)
      // — only generate when there's actually a mesh to write.
      files[id + "_warp.pfm"] = _serializePfm(d.warpMesh, 1024, 1024);
      warpedCount++;
    });
    files["mpcdi.xml"] = enc.encode(_serializeMpcdiXml(state.rig, { warpExt: includePfm ? "pfm" : "csv" }));
    const zip = _writeZipArchive(files);
    const fname = (state.patchName || "rig") + ".mpcdi";
    _downloadBlob(new Blob([zip], { type: "application/octet-stream" }), fname);
    console.log("[mpcdi-export]", fname, "(" + state.rig.displays.length + " displays, " + warpedCount + " with warps × PFM+CSV each)");
  } catch (e) {
    alert("Could not export MPCDI bundle:\n\n" + (e && e.message ? e.message : String(e)));
  }
}

