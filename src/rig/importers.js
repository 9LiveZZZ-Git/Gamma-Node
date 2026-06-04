/* ------------ Phase 6.6.2 — MPCDI / Bourke CSV importers --------------- */

/* Minimal in-browser ZIP reader. Uses the well-defined ZIP central
 * directory format + browser's DecompressionStream("deflate-raw")
 * for DEFLATE-compressed entries. No external dependencies — saves
 * the single-HTML-file invariant.
 *
 * Returns { "filename.ext": Uint8Array, ... } for every entry in
 * the archive. STORED (uncompressed) and DEFLATE methods are
 * supported; everything else throws. ZIP64 is not supported (4 GB
 * cap on individual files, 64K cap on entry count) — fine for any
 * realistic MPCDI bundle.
 *
 * The EOCD scan walks backward up to 65535 bytes from end of file
 * (max comment length per the spec). Most ZIPs have EOCD in the
 * last 22 bytes so the loop is fast in practice. */
async function _readZipArchive(buffer) {
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const len = view.byteLength;
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65535 - 22); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP: EOCD signature not found — file may not be a valid ZIP");

  const numEntries = view.getUint16(eocd + 10, true);
  const cdOffset   = view.getUint32(eocd + 16, true);

  const files = {};
  let p = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) {
      throw new Error("ZIP: bad central directory entry at offset " + p);
    }
    const method     = view.getUint16(p + 10, true);
    const compSize   = view.getUint32(p + 20, true);
    const nameLen    = view.getUint16(p + 28, true);
    const extraLen   = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff   = view.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // Read local file header to skip to actual data.
    if (view.getUint32(localOff, true) !== 0x04034b50) {
      throw new Error("ZIP: bad local header for " + name);
    }
    const lfhNameLen  = view.getUint16(localOff + 26, true);
    const lfhExtraLen = view.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lfhNameLen + lfhExtraLen;
    const compData = u8.subarray(dataOff, dataOff + compSize);

    if (method === 0) {
      // Stored — copy out so caller can keep the slice past archive lifetime.
      files[name] = new Uint8Array(compData);
    } else if (method === 8) {
      // DEFLATE — pipe through the browser's decompressor.
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([compData]).stream().pipeThrough(ds);
      const chunks = [];
      const reader = stream.getReader();
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      files[name] = out;
    } else {
      throw new Error("ZIP: unsupported compression method " + method + " for " + name + " (only STORED + DEFLATE)");
    }
  }
  return files;
}

/* Parse a Paul-Bourke-style warp mesh CSV.
 *
 * Format (Bourke "MeshFile2"):
 *   line 1: format version — usually "2" for the standard format,
 *           sometimes "MESH" or omitted; we just consume it.
 *   line 2: N M — grid dimensions (number of vertices wide × tall)
 *   lines 3..N*M+2: x y u v intensity   (whitespace-separated floats)
 *
 * Tolerates: leading/trailing whitespace, comment lines (#…),
 * multiple whitespace types between tokens, optional "MESH" or
 * "v2" magic on line 1.
 *
 * Note on dimensions: Bourke's "N nodes" = our (cols + 1). Output
 * mesh has cols = N - 1, rows = M - 1. */
function _parseBourkeMeshCsv(text) {
  const stripped = text.replace(/\r/g, "").split("\n")
    .map(l => l.replace(/#.*$/, "").trim())
    .filter(l => l.length > 0);
  if (stripped.length < 2) throw new Error("Bourke mesh: too few lines");
  // Magic: "2" or "MESH" or "v2" or just version
  let cursor = 0;
  if (/^[a-zA-Z]/.test(stripped[0]) || stripped[0].length <= 3) cursor = 1;
  // Grid dimensions
  const dimTokens = stripped[cursor].split(/\s+/);
  if (dimTokens.length < 2) throw new Error("Bourke mesh: missing N M dimensions");
  const N = parseInt(dimTokens[0], 10);
  const M = parseInt(dimTokens[1], 10);
  if (!Number.isFinite(N) || !Number.isFinite(M) || N < 2 || M < 2) {
    throw new Error("Bourke mesh: invalid dimensions " + N + "×" + M);
  }
  cursor++;
  const expected = N * M;
  const verts = new Array(expected * 5);
  let written = 0;
  for (let i = cursor; i < stripped.length && written < expected; i++) {
    const tokens = stripped[i].split(/\s+/);
    if (tokens.length < 5) continue;       // tolerate stray non-vertex lines
    const x = parseFloat(tokens[0]);
    const y = parseFloat(tokens[1]);
    const u = parseFloat(tokens[2]);
    const v = parseFloat(tokens[3]);
    const int = parseFloat(tokens[4]);
    if (![x,y,u,v,int].every(Number.isFinite)) continue;
    const off = written * 5;
    verts[off + 0] = x;
    verts[off + 1] = y;
    verts[off + 2] = u;
    verts[off + 3] = v;
    verts[off + 4] = int;
    written++;
  }
  if (written !== expected) {
    throw new Error("Bourke mesh: expected " + expected + " vertices, got " + written);
  }
  return { cols: N - 1, rows: M - 1, verts };
}

/* Parse an MPCDI XML manifest for rig geometry.
 *
 * VESA MPCDI 2.0 schema is large; we only consume the geometry-
 * essential subset:
 *   <MPCDI><display><buffer><region><frustum>
 *      <yaw>, <pitch>, <roll>
 *      <rightAngle>, <leftAngle>, <upAngle>, <downAngle>
 *
 * fov.h = rightAngle - leftAngle (typically ~symmetric)
 * fov.v = upAngle    - downAngle
 * pose  = (yaw, pitch, roll)
 *
 * Returns an array of partial Display objects ready for
 * _makeDisplay overrides. Warp / alpha file references are captured
 * but the binary parsers (PFM, PNG) ship in 6.6.2b — for now we
 * surface them as warpFileRef / alphaFileRef on the display so a
 * future ticket can wire them up. */
function _parseMpcdiXml(xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  const parseErr = dom.querySelector("parsererror");
  if (parseErr) throw new Error("MPCDI XML: " + (parseErr.textContent || "parse failed"));
  const root = dom.documentElement;
  if (!root || root.nodeName.toUpperCase() !== "MPCDI") {
    throw new Error("MPCDI XML: root element should be <MPCDI>, got <" + (root && root.nodeName) + ">");
  }

  const displays = [];
  let idx = 0;
  for (const buffer of root.querySelectorAll("display buffer")) {
    for (const region of buffer.querySelectorAll("region")) {
      const frustum = region.querySelector("frustum");
      const f = (sel) => {
        const el = frustum && frustum.querySelector(sel);
        const v = el ? parseFloat(el.textContent) : 0;
        return Number.isFinite(v) ? v : 0;
      };
      const yaw   = f("yaw");
      const pitch = f("pitch");
      const roll  = f("roll");
      const rA = f("rightAngle"), lA = f("leftAngle");
      const uA = f("upAngle"),    dA = f("downAngle");
      const fovH = Math.max(1, Math.abs(rA - lA));
      const fovV = Math.max(1, Math.abs(uA - dA));
      const id = region.getAttribute("id") || ("region" + idx);

      const fileSet = region.querySelector("fileSet");
      const warpFile  = fileSet && fileSet.querySelector("geometryWarpFile");
      const alphaFile = fileSet && fileSet.querySelector("alphaMap");

      displays.push({
        id: id,
        name: id,
        pose: { yaw, pitch, roll },
        fov:  { h: fovH, v: fovV },
        worldUv: { minU: idx / 4, minV: 0, maxU: (idx + 1) / 4, maxV: 1 }, // placeholder; replaced after we know count
        warpFileRef:  warpFile  ? warpFile.textContent.trim()  : null,
        alphaFileRef: alphaFile ? alphaFile.textContent.trim() : null
      });
      idx++;
    }
  }

  if (displays.length === 0) {
    throw new Error("MPCDI XML: no <region> elements found inside <buffer>s");
  }
  // Re-stripe worldUv evenly across the imported displays. Users can
  // tweak per-display worldUv after import; this gives a reasonable
  // default that matches what the rig templates produce.
  const n = displays.length;
  for (let i = 0; i < n; i++) {
    displays[i].worldUv = { minU: i / n, minV: 0, maxU: (i + 1) / n, maxV: 1 };
  }
  return displays;
}

/* User-facing: pop a file picker for a Bourke CSV warp file, parse,
 * apply to the given display. Surfaces parse errors via alert so
 * the user knows what went wrong with a mis-formatted file. Drops
 * GPU cache so the next frame rebuilds with the new mesh. */
function importBourkeMeshForDisplay(displayIdx) {
  const d = state.rig && state.rig.displays && state.rig.displays[displayIdx];
  if (!d) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,.txt,.data";
  input.onchange = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const mesh = _parseBourkeMeshCsv(text);
      if (!_validateWarpMesh(mesh)) throw new Error("Parsed mesh failed validation");
      pushHistory("warp-import:" + d.id);
      d.warpMesh = mesh;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      if (state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
        state.rig.templateKey = "custom";
      }
      renderProps && renderProps();
      render();
      console.log("[warp-import]", file.name, "→ display", displayIdx, ":", mesh.cols + "×" + mesh.rows);
    } catch (e) {
      alert("Could not import warp mesh:\n\n" + (e && e.message ? e.message : String(e)));
    }
  };
  input.click();
}

/* User-facing: pop a file picker for an MPCDI bundle (.mpcdi or
 * .zip). Reads the ZIP, parses mpcdi.xml, replaces the rig with
 * the imported display set. Warp + blend file references are
 * captured but their binary parsers (PFM, PNG) ship in 6.6.2b —
 * the rig geometry alone is meaningful (correct poses + FOVs +
 * display count) and the user can always run "Auto-blend rig"
 * afterward to populate intensity ramps. */
function importMpcdiBundle() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".mpcdi,.zip";
  input.onchange = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const archive = await _readZipArchive(buf);
      // Find mpcdi.xml — case-insensitive, in archive root or any
      // subdirectory. Fall back to any .xml file if the canonical
      // name isn't present (some bundles rename it).
      const xmlName = Object.keys(archive).find(n => /(^|\/)mpcdi\.xml$/i.test(n))
                    || Object.keys(archive).find(n => /\.xml$/i.test(n));
      if (!xmlName) throw new Error("No mpcdi.xml (or any .xml) found in archive");
      const xmlText = new TextDecoder("utf-8").decode(archive[xmlName]);
      const imported = _parseMpcdiXml(xmlText);
      if (!state.rig) state.rig = defaultRig();
      pushHistory("mpcdi-import:" + file.name);
      state.rig.templateKey = "custom";
      state.rig.displays    = imported.map((d, i) => _makeDisplay(d.id, d.name, {
        pose: d.pose,
        fov:  d.fov,
        worldUv: d.worldUv
      }));
      // Validate VisualOutput display-index pointers against new count.
      const max = state.rig.displays.length - 1;
      state.nodes.forEach(n => {
        if (n.type === "VisualOutput" && n.params && typeof n.params.display === "number") {
          if (n.params.display > max) n.params.display = max;
        }
      });
      // Reallocate FBO + rebuild bind groups since display count changed.
      if (Visual.device) {
        _allocateFramebuffer();
        _rebuildBlitBindGroup();
        _rebuildRigCompositeBindGroup();
        _rebuildWarpBindGroup();
        _rebuildTheaterBindGroup();
      }

      // Phase 6.6.2b — load referenced warp + blend files from the
      // archive. Each imported display may have warpFileRef + alphaFileRef
      // pointing at PFM / PNG / CSV files inside the bundle. Resolve
      // the references, parse based on extension, apply to display.
      let warpsApplied = 0, blendsApplied = 0;
      const warnings = [];
      for (let i = 0; i < imported.length; i++) {
        const meta = imported[i];
        const display = state.rig.displays[i];
        if (!meta || !display) continue;
        // Warp file → display.warpMesh
        if (meta.warpFileRef) {
          const data = _archiveLookup(archive, meta.warpFileRef);
          if (!data) {
            warnings.push("Display " + i + ": warp file '" + meta.warpFileRef + "' not in archive");
          } else {
            try {
              const ext = (meta.warpFileRef.match(/\.([a-z0-9]+)$/i) || ["",""])[1].toLowerCase();
              if (ext === "pfm") {
                const pfm = _parsePfm(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
                display.warpMesh = _pfmToBourkeMesh(pfm, 16, 16);
                warpsApplied++;
              } else if (ext === "csv" || ext === "txt" || ext === "data") {
                const text = new TextDecoder("utf-8").decode(data);
                display.warpMesh = _parseBourkeMeshCsv(text);
                display.warpMesh._isCustom = true;
                warpsApplied++;
              } else {
                warnings.push("Display " + i + ": unsupported warp format '" + ext + "'");
              }
            } catch (we) {
              warnings.push("Display " + i + " warp parse: " + we.message);
            }
          }
        }
        // Alpha PNG → display.warpMesh.intensity (paint over whatever
        // warp mesh exists; if no warp mesh, create an identity first
        // so blend ramps have somewhere to live).
        if (meta.alphaFileRef) {
          const data = _archiveLookup(archive, meta.alphaFileRef);
          if (!data) {
            warnings.push("Display " + i + ": alpha file '" + meta.alphaFileRef + "' not in archive");
          } else {
            if (!display.warpMesh) display.warpMesh = _makeIdentityWarpMesh(16, 16);
            try {
              await _applyPngBlendMap(data, display.warpMesh);
              display.warpMesh._isCustom = true;
              blendsApplied++;
            } catch (be) {
              warnings.push("Display " + i + " alpha apply: " + be.message);
            }
          }
        }
        if (display.warpMesh && Visual && Visual._warpCache) {
          Visual._warpCache.delete(display.id);
        }
      }

      // Auto-blend ONLY for displays that didn't get explicit alpha
      // maps from the bundle — preserve hand-painted blend ramps.
      _applyAutoBlendToRig({ skipHistory: true, keepTemplate: true });
      const msgLines = [
        "Imported " + imported.length + " displays from " + file.name,
        warpsApplied  + " warp file(s) applied",
        blendsApplied + " alpha map(s) applied"
      ];
      if (warnings.length) {
        msgLines.push("");
        msgLines.push("Warnings:");
        for (const w of warnings.slice(0, 8)) msgLines.push("  " + w);
        if (warnings.length > 8) msgLines.push("  ... and " + (warnings.length - 8) + " more");
      }
      const msg = msgLines.join("\n");
      console.log("[mpcdi-import]", msg);
      renderProps && renderProps();
      render();
      alert(msg);
    } catch (e) {
      alert("Could not import MPCDI bundle:\n\n" + (e && e.message ? e.message : String(e)));
    }
  };
  input.click();
}

/* ------------ Phase 6.6.2b — PFM + PNG binary parsers ------------------ */

/* Parse a Portable Float Map (PFM). Header is plain ASCII followed
 * by raw float32 data:
 *
 *     PF                        # 3-channel (RGB) — MPCDI warp uses this
 *     [or Pf]                   # 1-channel (grayscale)
 *     WIDTH HEIGHT
 *     ±SCALE                    # negative = little-endian, positive = big-endian
 *     <binary float32 data, width × height × channels>
 *
 * Returns { width, height, channels, data } with pixel data flipped
 * to top-to-bottom row order (PFM stores rows bottom-up by spec, so
 * we invert at parse time so callers can index naturally with
 * row 0 = top of image). */
function _parsePfm(buffer) {
  const u8 = new Uint8Array(buffer);
  let p = 0;
  const readLine = () => {
    let start = p;
    while (p < u8.length && u8[p] !== 0x0A && u8[p] !== 0x0D) p++;
    const line = new TextDecoder("ascii").decode(u8.subarray(start, p));
    while (p < u8.length && (u8[p] === 0x0A || u8[p] === 0x0D)) p++;
    return line.trim();
  };
  const magic = readLine();
  let channels;
  if (magic === "PF")      channels = 3;
  else if (magic === "Pf") channels = 1;
  else throw new Error("PFM: unexpected magic '" + magic + "' (expected 'PF' or 'Pf')");

  // Some tools emit a comment before the dims line.
  let dimsLine;
  while (true) {
    dimsLine = readLine();
    if (!dimsLine.startsWith("#")) break;
  }
  const dimMatch = dimsLine.match(/^(\d+)\s+(\d+)/);
  if (!dimMatch) throw new Error("PFM: bad dimensions line '" + dimsLine + "'");
  const width  = parseInt(dimMatch[1], 10);
  const height = parseInt(dimMatch[2], 10);

  const scaleLine = readLine();
  const scale = parseFloat(scaleLine);
  if (!Number.isFinite(scale)) throw new Error("PFM: bad scale '" + scaleLine + "'");
  const littleEndian = scale < 0;

  const numFloats = width * height * channels;
  const expectedBytes = numFloats * 4;
  const remainingBytes = u8.length - p;
  if (remainingBytes < expectedBytes) {
    throw new Error("PFM: truncated data (need " + expectedBytes + " B, got " + remainingBytes + ")");
  }
  // Build a fresh Float32Array, flipping rows top-to-bottom on the way.
  const data = new Float32Array(numFloats);
  const dv = new DataView(buffer, p);
  for (let r = 0; r < height; r++) {
    const srcRow = height - 1 - r;          // PFM rows are bottom-up
    for (let c = 0; c < width; c++) {
      for (let k = 0; k < channels; k++) {
        const srcIdx = (srcRow * width + c) * channels + k;
        const dstIdx = (r * width + c) * channels + k;
        data[dstIdx] = dv.getFloat32(srcIdx * 4, littleEndian);
      }
    }
  }
  return { width, height, channels, data };
}

/* Convert a PFM warp file to our Bourke mesh format. PFM stores
 * per-pixel source UV (channel 0 = u, channel 1 = v); we subsample
 * at a grid of (cols+1) × (rows+1) vertices. Default resolution
 * 16×16 — fine enough for any visible warp at 1080p, light enough
 * that the editor's modal stays responsive when the user opens
 * one for tweaking.
 *
 * The PFM is already top-to-bottom (we flipped at parse time), and
 * our mesh's r=0 maps to NDC bottom — which is image-bottom in
 * our convention. So mesh row r samples PFM row (rows - r) to keep
 * the orientation correct. */
function _pfmToBourkeMesh(pfm, cols, rows) {
  cols = cols || 16;
  rows = rows || 16;
  const W = cols + 1, H = rows + 1;
  const mesh = _makeIdentityWarpMesh(cols, rows);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      // PFM is top-to-bottom; mesh r=0 is NDC-bottom = image-bottom.
      // Sample at (1 - v) of PFM height to get image-bottom for r=0.
      const px = Math.max(0, Math.min(pfm.width  - 1, Math.round(u * (pfm.width  - 1))));
      const py = Math.max(0, Math.min(pfm.height - 1, Math.round((1 - v) * (pfm.height - 1))));
      const idx = (py * pfm.width + px) * pfm.channels;
      const sourceU = pfm.data[idx];
      const sourceV = pfm.channels > 1 ? pfm.data[idx + 1] : 0;
      const off = (r * W + c) * 5;
      mesh.verts[off + 0] = u * 2 - 1;        // identity NDC for projector pixel
      mesh.verts[off + 1] = v * 2 - 1;
      mesh.verts[off + 2] = sourceU;          // source UV from PFM
      mesh.verts[off + 3] = sourceV;
      mesh.verts[off + 4] = 1;                // intensity from alpha PNG (separate)
    }
  }
  mesh._isCustom = true;                       // imported = treat as user data
  return mesh;
}

/* Sample a PNG blend-map at every mesh vertex position and write
 * the values into the mesh's intensity field. Uses createImageBitmap
 * + an OffscreenCanvas-like draw to read pixel data without dragging
 * any 3rd-party PNG decoder. The R channel is used for grayscale
 * (every channel is identical for true grayscale bitmaps; for RGB
 * blend maps the standard is to use the red component). */
async function _applyPngBlendMap(pngBytes, mesh) {
  if (!_validateWarpMesh(mesh)) throw new Error("invalid mesh for blend-map application");
  const blob = new Blob([pngBytes], { type: "image/png" });
  const bmp  = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width  = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;

  const W = mesh.cols + 1, H = mesh.rows + 1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      // Sample at the mesh vertex's projector-NDC position (mx, my).
      // Image coord: (mx*0.5 + 0.5) × (W-1), (1 - (my*0.5 + 0.5)) × (H-1)
      const off = (r * W + c) * 5;
      const mx = mesh.verts[off + 0];
      const my = mesh.verts[off + 1];
      const ix = Math.max(0, Math.min(bmp.width  - 1, Math.round((mx * 0.5 + 0.5)       * (bmp.width  - 1))));
      const iy = Math.max(0, Math.min(bmp.height - 1, Math.round((1 - (my * 0.5 + 0.5)) * (bmp.height - 1))));
      const pi = (iy * bmp.width + ix) * 4;
      mesh.verts[off + 4] = px[pi] / 255;     // red channel as intensity
    }
  }
  return mesh;
}

/* Resolve a relative file reference inside the MPCDI archive against
 * the archive's file map. MPCDI references can be naked filenames
 * ("region1_warp.pfm") or paths ("pfm/region1_warp.pfm"); look up
 * canonical name first, then any case-insensitive suffix match. */
function _archiveLookup(archive, ref) {
  if (!ref) return null;
  if (archive[ref]) return archive[ref];
  const refLower = ref.toLowerCase();
  for (const k of Object.keys(archive)) {
    if (k.toLowerCase() === refLower) return archive[k];
    if (k.toLowerCase().endsWith("/" + refLower)) return archive[k];
  }
  return null;
}

/* ------------ Phase 6.6.3b — PFM warp export --------------------------- */

/* Rasterize a Bourke warp mesh to a PFM file. For each pixel in the
 * output PFM we find which mesh quad covers that NDC position (after
 * deformation) and bilinear-interpolate the source UV stored in the
 * mesh. Pixels not covered get (0, 0, 0).
 *
 * Algorithm: walk each mesh quad, split into 2 triangles, scanline
 * each triangle with barycentric interpolation. ~O(width × height)
 * total work — fast enough for 1024×1024 in <1s on a typical CPU.
 *
 * Output PFM convention: we write row-0-at-bottom (per PFM spec),
 * which matches our mesh's NDC convention (r=0 at bottom). */
function _serializePfm(mesh, outW, outH) {
  outW = outW || 1024;
  outH = outH || 1024;
  if (!_validateWarpMesh(mesh)) throw new Error("invalid mesh for PFM export");

  // RGB float buffer, top-to-bottom rows internally; we'll flip on
  // write so the file matches PFM's bottom-up convention.
  const pixels = new Float32Array(outW * outH * 3);
  const W = mesh.cols + 1;

  // Helper: rasterize one triangle. Each vertex carries (mx, my) in
  // NDC + (mu, mv) source UV. Pixel (px, py) maps to NDC
  // ((px+0.5)/outW * 2 - 1, (py+0.5)/outH * 2 - 1).
  const drawTri = (a, b, c) => {
    const minMx = Math.min(a.mx, b.mx, c.mx);
    const maxMx = Math.max(a.mx, b.mx, c.mx);
    const minMy = Math.min(a.my, b.my, c.my);
    const maxMy = Math.max(a.my, b.my, c.my);
    const minPx = Math.max(0,        Math.floor((minMx * 0.5 + 0.5) * outW));
    const maxPx = Math.min(outW - 1, Math.ceil ((maxMx * 0.5 + 0.5) * outW));
    const minPy = Math.max(0,        Math.floor((minMy * 0.5 + 0.5) * outH));
    const maxPy = Math.min(outH - 1, Math.ceil ((maxMy * 0.5 + 0.5) * outH));
    const denom = (b.my - c.my) * (a.mx - c.mx) + (c.mx - b.mx) * (a.my - c.my);
    if (Math.abs(denom) < 1e-12) return;
    const invDenom = 1 / denom;
    for (let py = minPy; py <= maxPy; py++) {
      for (let px = minPx; px <= maxPx; px++) {
        const mx = (px + 0.5) / outW * 2 - 1;
        const my = (py + 0.5) / outH * 2 - 1;
        const w0 = ((b.my - c.my) * (mx - c.mx) + (c.mx - b.mx) * (my - c.my)) * invDenom;
        const w1 = ((c.my - a.my) * (mx - c.mx) + (a.mx - c.mx) * (my - c.my)) * invDenom;
        const w2 = 1 - w0 - w1;
        // Inside-triangle test (small epsilon to cover edge pixels).
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const u = a.mu * w0 + b.mu * w1 + c.mu * w2;
        const v = a.mv * w0 + b.mv * w1 + c.mv * w2;
        const idx = (py * outW + px) * 3;
        pixels[idx + 0] = u;
        pixels[idx + 1] = v;
        pixels[idx + 2] = 0;
      }
    }
  };

  for (let r = 0; r < mesh.rows; r++) {
    for (let c = 0; c < mesh.cols; c++) {
      const v00 = (r       * W + c    ) * 5;
      const v10 = (r       * W + c + 1) * 5;
      const v01 = ((r + 1) * W + c    ) * 5;
      const v11 = ((r + 1) * W + c + 1) * 5;
      const verts = [v00, v10, v01, v11].map(off => ({
        mx: mesh.verts[off + 0],
        my: mesh.verts[off + 1],
        mu: mesh.verts[off + 2],
        mv: mesh.verts[off + 3]
      }));
      drawTri(verts[0], verts[1], verts[2]);
      drawTri(verts[2], verts[1], verts[3]);
    }
  }

  // Header — text — followed by binary float data, rows bottom-up.
  const header = new TextEncoder().encode("PF\n" + outW + " " + outH + "\n-1.0\n");
  const out = new Uint8Array(header.length + outW * outH * 3 * 4);
  out.set(header, 0);
  const dv = new DataView(out.buffer, out.byteOffset + header.length);
  for (let r = 0; r < outH; r++) {
    const srcRow = outH - 1 - r;            // flip to bottom-up
    for (let c = 0; c < outW; c++) {
      const dstIdx = (r * outW + c) * 3;
      const srcIdx = (srcRow * outW + c) * 3;
      dv.setFloat32(dstIdx * 4 + 0, pixels[srcIdx + 0], true);
      dv.setFloat32(dstIdx * 4 + 4, pixels[srcIdx + 1], true);
      dv.setFloat32(dstIdx * 4 + 8, pixels[srcIdx + 2], true);
    }
  }
  return out;
}

