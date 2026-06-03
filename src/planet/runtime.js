/* =========================================================================
 * Sprint 10-6 -- streamed high-resolution DEM tiles for foot-level relief.
 *
 * Architecture: the global zoom-3 grid (10-5b) is too coarse for foot
 * scale -- ~5 km/pixel = smoothed peaks. As the camera approaches the
 * surface, chunks subdivide deeper (quadtree LOD); each chunk depth has
 * an appropriate Mapzen zoom level for its size. Tiles fetch on demand
 * as chunks are built, get cached in memory, and trigger chunk re-bake
 * when they arrive so the now-detailed elevation flows into the VBO.
 *
 * Per-vertex sampling never blocks on a fetch -- it returns the best
 * cached zoom and falls back to the macro cubemap if nothing closer
 * is loaded yet. Chunks rebuild progressively as new tiles arrive.
 *
 * Depth → zoom mapping (chunk edge ÷ 32 px/edge ≈ pixel resolution):
 *   depth ≤ 5  → zoom 3   (macro cubemap covers it)
 *   depth 6-7  → zoom 5   (~1.2 km/px)
 *   depth 8-9  → zoom 7   (~300 m/px)
 *   depth 10-11→ zoom 9   (~75 m/px)
 *   depth 12-13→ zoom 11  (~19 m/px)
 *   depth 14-15→ zoom 13  (~5 m/px)
 *   depth ≥ 16 → zoom 14  (~2.4 m/px, near Mapzen ceiling of 15)
 *
 * Memory: each tile = 256² × 4 bytes = 256 KB. 500 tile cap ≈ 128 MB.
 * Browser HTTP cache covers second+ loads at ~no cost. */
const _EARTH_TILES = {
  cache: new Map(),          // "z/x/y" -> { meters: Float32Array(256*256), z, x, y, t }
  pending: new Set(),        // "z/x/y" currently fetching
  loadCount: 0,              // bumped on every successful load (chunk cache key)
  maxEntries: 500,
};

/* =========================================================================
 * Sprint 10-5c -- Sparse Virtual Texturing (SVT) for planet surface
 * detail. Phase 10-5c-a: data structures + GPU resource allocation.
 *
 * The big idea: instead of computing surface detail per-fragment every
 * frame (or per-vertex once), maintain a small fixed-size GPU "atlas"
 * that holds the currently-visible pages of a much larger logical
 * "virtual" texture. Pages are 128×128 texels; the atlas is 4096×4096
 * (= 32×32 = 1024 page slots). The virtual texture per cube face is
 * 256×256 pages = 32768×32768 texels (~300m/texel at Earth scale at
 * the deepest single-zoom version; multi-zoom mipmap pyramid added in
 * 10-5c-f gets us down to ~1-10 m/texel near camera).
 *
 * Per-fragment cost in shader: one page-table indirection sample, one
 * atlas sample. The indirection lets us decouple GPU memory (~70 MB
 * atlas + page table) from the addressable detail surface (theoretical
 * many-GB virtual texture). Same pattern as id Tech 5 MegaTexture,
 * Frostbite/Unreal SVT, Far Cry 5/6.
 *
 * Phased breakdown:
 *   10-5c-a  THIS COMMIT: allocate atlas + page table + residency
 *            tracking. Pages all empty, no shader integration yet --
 *            verifies infrastructure stands up.
 *   10-5c-b  Procedural page fill (CPU first, GPU compute later) using
 *            existing biome + climate functions. Pages have content
 *            but aren't sampled by shader yet.
 *   10-5c-c  Shader bindings + virtual UV → page table → atlas sample,
 *            with fallback to existing per-fragment procedural when
 *            page not resident. First visible SVT.
 *   10-5c-d  Feedback render pass: only generate pages the camera
 *            actually needs.
 *   10-5c-e  LRU eviction (cap atlas memory).
 *   10-5c-f  Multi-zoom mipmap pyramid (proper LOD across distance).
 *   10-5c-g  Normal + roughness channels + PBR lighting.
 */
const _SVT = {
  // Atlas configuration. Tuned for 4096² atlas with 128² pages.
  // 32×32 = 1024 page slots, RGBA8 = 64 MB GPU.
  ATLAS_DIM:    4096,    // atlas texture is ATLAS_DIM × ATLAS_DIM
  PAGE_SIZE:    128,     // each page is PAGE_SIZE × PAGE_SIZE texels
  SLOTS_PER_ROW: 32,     // ATLAS_DIM / PAGE_SIZE
  TOTAL_SLOTS:  1024,    // SLOTS_PER_ROW²
  // Virtual texture per face: PAGES_PER_FACE_EDGE² pages per cube face.
  // 10-5c-h2 adds a fine zoom alongside this base. BASE stays at 256
  // (zoom 8, ~300 m/texel) for orbital + mid-range; fine zoom is
  // 1024² (zoom 10, ~78 m/texel) for near-camera.
  PAGES_PER_FACE_EDGE: 256,   // BASE zoom 8: 256² = 65536 pages/face
  // Multi-zoom additions (sprint 10-5c-h2).
  FINE_PAGES_PER_FACE_EDGE: 1024,  // FINE zoom 10: 1024² pages/face
  // GPU resources (allocated lazily in _ensureSVT).
  atlasTexture: null,            // RGBA8 albedo
  atlasView:    null,
  atlasSampler: null,
  // Sprint 10-5c-g: normal-map atlas. RGB encodes tangent-space
  // normal (XYZ in [-1, 1] mapped to [0, 1] per channel, Z = up).
  // Generated procedurally alongside albedo from noise gradient.
  // Same 4096² RGBA8 size as albedo (64 MB).
  normalAtlas:     null,
  normalAtlasView: null,
  // Sprint 10-5c-h: PBR material atlas. Packs roughness + metallic +
  // ambient occlusion into RGBA8 for one atlas sample:
  //   R = roughness (0 = mirror, 1 = matte)
  //   G = metallic  (0 = dielectric, 1 = pure metal)
  //   B = AO        (1 = no occlusion, 0 = fully occluded)
  //   A = reserved
  // 64 MB GPU. Total SVT footprint with all three atlases: ~200 MB.
  materialAtlas:     null,
  materialAtlasView: null,
  // Base page table: 256×256 R32Uint × 6 face layers. ~6 MB.
  // Each texel = (slotY << 16) | slotX, or PAGE_UNRESIDENT.
  pageTableTexture: null,
  pageTableView:    null,
  // Sprint 10-5c-h2: fine-zoom page table (1024² × 6 R32Uint, ~25 MB).
  // Same encoding as the base. Atlas slots are SHARED -- a page from
  // either zoom takes one of the 1024 slots.
  finePageTableTexture: null,
  finePageTableView:    null,
  // JS-side residency state.
  // residency: Map "face/x/y" → { slotX, slotY, lastFrame, generated }
  residency: new Map(),
  // freeSlots: pool of unused (slotX, slotY) pairs.
  freeSlots: [],
  // Frame counter for LRU.
  frame: 0,
  // Statistics for logging / diagnostics.
  stats: { pagesGenerated: 0, pagesEvicted: 0, atlasSamples: 0 },
  // Bytes-per-pixel for the page table indirection. Pack atlas slot
  // ID (10 bits) + future flags (lod level, channel mask) into uint32.
  PAGE_UNRESIDENT: 0xFFFFFFFF,
  // Sprint 10-5c-d: pages waiting to be generated. Queue ordered
  // FIFO (chunks visible earliest get pages first); keys set lets
  // _svtQueueIfNew O(1) dedupe.
  generationQueue: [],
  queueKeys: new Set(),
  // SVT virtual texture zoom levels. 10-5c-h2 adds the FINE level for
  // near-camera detail; BASE keeps long-range coverage cheap.
  BASE_ZOOM: 8,
  FINE_ZOOM: 10,
  // Legacy alias for code that still references TARGET_ZOOM.
  TARGET_ZOOM: 8,
};

/* Allocate the SVT atlas + page table + initialize the free-slot pool.
 * Idempotent: returns immediately if already allocated. Returns true
 * on success, false on failure (e.g., no device). */
function _ensureSVT() {
  if (_SVT.atlasTexture) return true;
  if (!Visual.device) return false;
  const device = Visual.device;
  try {
    _SVT.atlasTexture = device.createTexture({
      label: "svt-atlas",
      size: [_SVT.ATLAS_DIM, _SVT.ATLAS_DIM, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_DST |
             GPUTextureUsage.STORAGE_BINDING,
    });
    _SVT.atlasView = _SVT.atlasTexture.createView();
    _SVT.atlasSampler = device.createSampler({
      label: "svt-atlas-sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    // Sprint 10-5c-g: normal-map atlas, identical size + slot layout
    // as the albedo atlas. Per-texel content = tangent-space normal
    // packed RGBA8 (XYZ in [0,1] = [-1,1]; A unused for now).
    _SVT.normalAtlas = device.createTexture({
      label: "svt-normal-atlas",
      size: [_SVT.ATLAS_DIM, _SVT.ATLAS_DIM, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    _SVT.normalAtlasView = _SVT.normalAtlas.createView();
    // Sprint 10-5c-h: PBR material atlas. R=rough, G=metal, B=AO.
    _SVT.materialAtlas = device.createTexture({
      label: "svt-material-atlas",
      size: [_SVT.ATLAS_DIM, _SVT.ATLAS_DIM, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    _SVT.materialAtlasView = _SVT.materialAtlas.createView();
    // Base page table: 6 layers, each 256×256 R32Uint = ~6 MB.
    _SVT.pageTableTexture = device.createTexture({
      label: "svt-page-table-base",
      size: [_SVT.PAGES_PER_FACE_EDGE, _SVT.PAGES_PER_FACE_EDGE, 6],
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_DST |
             GPUTextureUsage.STORAGE_BINDING,
      dimension: "2d",
    });
    _SVT.pageTableView = _SVT.pageTableTexture.createView({ dimension: "2d-array" });
    // Sprint 10-5c-h2: fine page table, 6 layers × 1024² R32Uint = ~25 MB.
    _SVT.finePageTableTexture = device.createTexture({
      label: "svt-page-table-fine",
      size: [_SVT.FINE_PAGES_PER_FACE_EDGE, _SVT.FINE_PAGES_PER_FACE_EDGE, 6],
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_DST |
             GPUTextureUsage.STORAGE_BINDING,
      dimension: "2d",
    });
    _SVT.finePageTableView = _SVT.finePageTableTexture.createView({ dimension: "2d-array" });
    // Initialize base page table to all-unresident.
    const unresidentBuf = new Uint32Array(
      _SVT.PAGES_PER_FACE_EDGE * _SVT.PAGES_PER_FACE_EDGE * 6
    );
    unresidentBuf.fill(_SVT.PAGE_UNRESIDENT);
    device.queue.writeTexture(
      { texture: _SVT.pageTableTexture },
      unresidentBuf,
      { bytesPerRow: _SVT.PAGES_PER_FACE_EDGE * 4,
        rowsPerImage: _SVT.PAGES_PER_FACE_EDGE },
      [_SVT.PAGES_PER_FACE_EDGE, _SVT.PAGES_PER_FACE_EDGE, 6]
    );
    // Initialize fine page table to all-unresident. ~25 MB upload --
    // one-time at startup; if this slows things noticeably we can
    // defer to first-use (e.g., when camera approaches surface).
    const fineUnresidentBuf = new Uint32Array(
      _SVT.FINE_PAGES_PER_FACE_EDGE * _SVT.FINE_PAGES_PER_FACE_EDGE * 6
    );
    fineUnresidentBuf.fill(_SVT.PAGE_UNRESIDENT);
    device.queue.writeTexture(
      { texture: _SVT.finePageTableTexture },
      fineUnresidentBuf,
      { bytesPerRow: _SVT.FINE_PAGES_PER_FACE_EDGE * 4,
        rowsPerImage: _SVT.FINE_PAGES_PER_FACE_EDGE },
      [_SVT.FINE_PAGES_PER_FACE_EDGE, _SVT.FINE_PAGES_PER_FACE_EDGE, 6]
    );
    // Build free-slot pool (all slots free initially).
    _SVT.freeSlots = [];
    for (let sy = _SVT.SLOTS_PER_ROW - 1; sy >= 0; sy--) {
      for (let sx = _SVT.SLOTS_PER_ROW - 1; sx >= 0; sx--) {
        _SVT.freeSlots.push({ x: sx, y: sy });
      }
    }
    console.log("[svt] allocated atlas " + _SVT.ATLAS_DIM + "² (" + _SVT.TOTAL_SLOTS
              + " slots × " + _SVT.PAGE_SIZE + "² = "
              + (_SVT.ATLAS_DIM * _SVT.ATLAS_DIM * 4 / 1024 / 1024).toFixed(0) + " MB)"
              + ", page table 6 × " + _SVT.PAGES_PER_FACE_EDGE + "² R32Uint ("
              + (_SVT.PAGES_PER_FACE_EDGE * _SVT.PAGES_PER_FACE_EDGE * 6 * 4 / 1024 / 1024).toFixed(1)
              + " MB)");
    return true;
  } catch (err) {
    console.warn("[svt] allocation failed:", err);
    return false;
  }
}

/* Allocate a free atlas slot for a logical page (face, pageX, pageY).
 * Returns { slotX, slotY } or null if atlas is full (10-5c-e will add
 * LRU eviction; for now we just return null which means "no slot,
 * fall back to procedural"). */
function _svtAllocateSlot(face, zoom, pageX, pageY) {
  const key = face + "/" + zoom + "/" + pageX + "/" + pageY;
  const existing = _SVT.residency.get(key);
  if (existing) {
    existing.lastFrame = _SVT.frame;
    return { slotX: existing.slotX, slotY: existing.slotY };
  }
  if (_SVT.freeSlots.length === 0) {
    if (!_svtEvictLRU()) return null;
  }
  const slot = _SVT.freeSlots.pop();
  _SVT.residency.set(key, {
    slotX: slot.x,
    slotY: slot.y,
    lastFrame: _SVT.frame,
    generated: false,
    face: face, zoom: zoom, pageX: pageX, pageY: pageY,
  });
  return slot;
}

/* Pick the correct page-table texture for a given zoom level. */
function _svtTableForZoom(zoom) {
  if (zoom === _SVT.FINE_ZOOM) return _SVT.finePageTableTexture;
  return _SVT.pageTableTexture;
}

/* Update a single page-table entry. Sprint 10-5c-h2: takes zoom too
 * to pick which of the two page tables to write to. */
function _svtWritePageTable(face, zoom, pageX, pageY, slotX, slotY) {
  const tex = _svtTableForZoom(zoom);
  if (!tex || !Visual.device) return;
  const packed = ((slotY & 0xFFFF) << 16) | (slotX & 0xFFFF);
  const buf = new Uint32Array([packed]);
  Visual.device.queue.writeTexture(
    {
      texture: tex,
      origin: { x: pageX, y: pageY, z: face },
    },
    buf,
    { bytesPerRow: 4, rowsPerImage: 1 },
    [1, 1, 1]
  );
}

function _svtMarkUnresident(face, zoom, pageX, pageY) {
  const tex = _svtTableForZoom(zoom);
  if (!tex || !Visual.device) return;
  const buf = new Uint32Array([_SVT.PAGE_UNRESIDENT]);
  Visual.device.queue.writeTexture(
    {
      texture: tex,
      origin: { x: pageX, y: pageY, z: face },
    },
    buf,
    { bytesPerRow: 4, rowsPerImage: 1 },
    [1, 1, 1]
  );
}

/* Sprint 10-5c-e: evict the oldest-touched resident page and return
 * its freed slot. Skips pages touched within the last 2 frames (so
 * we don't thrash pages that are still in the visible set this frame).
 * Returns true if an eviction happened (slot pushed to freeSlots),
 * false if no evictable page found (rare -- only if all 1024 slots
 * have been touched in the last 2 frames, which means visible-page
 * count exceeds atlas capacity).
 *
 * Cost: O(N) linear scan through residency Map. With N=1024 entries
 * × maybe 10 evictions/frame = 10k iterations/frame -- fine. Future
 * optimization: maintain a sorted-by-lastFrame structure if profile
 * shows this is hot. */
function _svtEvictLRU() {
  let oldestKey = null;
  let oldestFrame = Infinity;
  const cutoffFrame = _SVT.frame - 1;   // skip pages touched in last 2 frames
  for (const [key, res] of _SVT.residency) {
    if (res.lastFrame >= cutoffFrame) continue;
    if (res.lastFrame < oldestFrame) {
      oldestFrame = res.lastFrame;
      oldestKey = key;
    }
  }
  if (!oldestKey) return false;
  const evict = _SVT.residency.get(oldestKey);
  _SVT.residency.delete(oldestKey);
  // Sprint 10-5c-h2: zoom-aware unresident write.
  _svtMarkUnresident(evict.face, evict.zoom || _SVT.BASE_ZOOM, evict.pageX, evict.pageY);
  _SVT.freeSlots.push({ x: evict.slotX, y: evict.slotY });
  _SVT.stats.pagesEvicted++;
  if ((typeof window !== "undefined" && window.__PLANET_LOG) &&
      (_SVT.stats.pagesEvicted === 1 || _SVT.stats.pagesEvicted % 64 === 0)) {
    console.log("[svt-evict] page " + evict.face + "/z" + (evict.zoom || _SVT.BASE_ZOOM)
              + "/" + evict.pageX + "/" + evict.pageY
              + " (lastFrame=" + evict.lastFrame + ", now=" + _SVT.frame
              + ") → freed slot (" + evict.slotX + "," + evict.slotY + ")"
              + " | total evictions: " + _SVT.stats.pagesEvicted);
  }
  return true;
}

/* Sprint 10-5c-b: generate the RGBA content for a single SVT page.
 * Sprint 10-5c-g: also generates a tangent-space normal map from
 * noise gradient. Returns { albedo, normal } as Uint8ClampedArrays
 * sized PAGE_SIZE² × 4 each, or null on failure.
 *
 * Normal computation: sample a high-frequency value-noise at two
 * tiny offsets along the page's local tangent + bitangent, finite-
 * difference to get the gradient, pack into RGB as [(N.x+1)/2,
 * (N.y+1)/2, N.z] with N.z reconstructed = sqrt(1 - x² - y²). */
function _svtGeneratePage(face, zoom, pageX, pageY, pmap) {
  if (face < 0 || face > 5) return null;
  const cubemap = pmap ? _ensurePlanetMapCubemap(pmap) : null;
  const seaLevel = (pmap && pmap.params && typeof pmap.params.seaLevel === "number")
                   ? pmap.params.seaLevel : 0.5;
  const albedo   = new Uint8ClampedArray(_SVT.PAGE_SIZE * _SVT.PAGE_SIZE * 4);
  const normal   = new Uint8ClampedArray(_SVT.PAGE_SIZE * _SVT.PAGE_SIZE * 4);
  const material = new Uint8ClampedArray(_SVT.PAGE_SIZE * _SVT.PAGE_SIZE * 4);
  const faceData = _PLANET_FACES[face];
  const nX = faceData.n[0], nY = faceData.n[1], nZ = faceData.n[2];
  const tX = faceData.t[0], tY = faceData.t[1], tZ = faceData.t[2];
  const bX = faceData.b[0], bY = faceData.b[1], bZ = faceData.b[2];
  // Sprint 10-5c-h2: zoom determines how much of the face one page covers.
  // pagesPerEdge differs between base (256) and fine (1024).
  const pagesPerEdge = (zoom === _SVT.FINE_ZOOM)
    ? _SVT.FINE_PAGES_PER_FACE_EDGE : _SVT.PAGES_PER_FACE_EDGE;
  const uPageMin = -1 + 2 * pageX / pagesPerEdge;
  const vPageMin = -1 + 2 * pageY / pagesPerEdge;
  const uStep = 2 / (pagesPerEdge * _SVT.PAGE_SIZE);
  const vStep = 2 / (pagesPerEdge * _SVT.PAGE_SIZE);
  // Bump-noise wavelength + amplitude. Noise samples at world-space
  // position to stay consistent across pages.
  const bumpFreq = 0.5;     // 2 m wavelength
  const bumpAmp  = 0.4;     // tangent-space normal slope range
  // §revert-suppression (2026-05-25) -- foot-perf cut from 2-oct to
  // 1-oct chasing the 9 fps bug. Real bug was horizon cull. Restored
  // to 2-octave so SVT normal maps regain the fine bump detail. Cost:
  // ~40 ms/page (vs 20 ms at 1-oct). Combined with the bumped 12 ms
  // SVT budget, pages still drain ~1.5× faster than the pre-revert
  // baseline because the budget grew more than the per-page cost.
  const _bumpNoise = function(wx, wy, wz) {
    const n1 = _terrainValueNoise3D(wx * bumpFreq,        wy * bumpFreq,        wz * bumpFreq,        37.1);
    const n2 = _terrainValueNoise3D(wx * bumpFreq * 4.0,  wy * bumpFreq * 4.0,  wz * bumpFreq * 4.0,  91.7);
    return n1 * 0.6 + n2 * 0.4;
  };
  // Approximate Earth-scale world position per page sample. Each
  // page covers ~40 km of terrain, each texel ~300 m. Use a fixed
  // world-scale offset (in meters) for the gradient samples.
  const planetR = (pmap && pmap.params && typeof pmap.params.radius === "number") ? pmap.params.radius : 6378000;
  const gradEpsilon = 1.5;  // 1.5 m offset for finite difference
  let aIdx = 0, nIdx = 0, mIdx = 0;
  for (let py = 0; py < _SVT.PAGE_SIZE; py++) {
    const v = vPageMin + (py + 0.5) * vStep;
    for (let px = 0; px < _SVT.PAGE_SIZE; px++) {
      const u = uPageMin + (px + 0.5) * uStep;
      // Cube position → unit sphere (matches _buildEarthCubemap).
      const cx = nX + tX*u + bX*v;
      const cy = nY + tY*u + bY*v;
      const cz = nZ + tZ*u + bZ*v;
      const cxx = cx*cx, cyy = cy*cy, czz = cz*cz;
      const sx = cx * Math.sqrt(Math.max(0, 1 - cyy*0.5 - czz*0.5 + cyy*czz/3));
      const sy = cy * Math.sqrt(Math.max(0, 1 - cxx*0.5 - czz*0.5 + cxx*czz/3));
      const sz = cz * Math.sqrt(Math.max(0, 1 - cxx*0.5 - cyy*0.5 + cxx*cyy/3));
      const inv = 1 / Math.max(1e-12, Math.sqrt(sx*sx + sy*sy + sz*sz));
      const ux = sx*inv, uy = sy*inv, uz = sz*inv;
      // Macro elevation from cubemap.
      const elev = cubemap ? _samplePlanetMapCubemap(cubemap, ux, uy, uz) : 0.5;
      const latDeg = Math.asin(Math.max(-1, Math.min(1, uy))) * 180 / Math.PI;
      const lonDeg = -Math.atan2(uz, ux) * 180 / Math.PI;
      const col = _earthSurfaceColorAt(latDeg, lonDeg, elev, seaLevel);
      albedo[aIdx++] = Math.max(0, Math.min(255, Math.floor(col[0] * 255)));
      albedo[aIdx++] = Math.max(0, Math.min(255, Math.floor(col[1] * 255)));
      albedo[aIdx++] = Math.max(0, Math.min(255, Math.floor(col[2] * 255)));
      albedo[aIdx++] = 255;
      // Normal from noise gradient. Sample at world position +ε along
      // east + north tangents; finite-difference gives bump slope.
      // East tangent: (-sinLon, 0, cosLon). North tangent: roughly +Y projection.
      const wx = ux * planetR, wy = uy * planetR, wz = uz * planetR;
      const eastX = -Math.sin(lonDeg * Math.PI / 180);
      const eastZ =  Math.cos(lonDeg * Math.PI / 180);
      const h0  = _bumpNoise(wx, wy, wz);
      const hEx = _bumpNoise(wx + eastX*gradEpsilon, wy, wz + eastZ*gradEpsilon);
      const hNy = _bumpNoise(wx, wy + gradEpsilon, wz);
      const gradU = (hEx - h0) * bumpAmp;
      const gradV = (hNy - h0) * bumpAmp;
      // Tangent-space normal: (gradU, gradV, sqrt(1 - gradU² - gradV²)).
      // Negate gradients so heights bumping UP push the normal TOWARD camera.
      let nxT = -gradU;
      let nyT = -gradV;
      let nzT = Math.sqrt(Math.max(0.01, 1.0 - nxT*nxT - nyT*nyT));
      const nlen = Math.sqrt(nxT*nxT + nyT*nyT + nzT*nzT);
      nxT /= nlen; nyT /= nlen; nzT /= nlen;
      normal[nIdx++] = Math.max(0, Math.min(255, Math.floor((nxT * 0.5 + 0.5) * 255)));
      normal[nIdx++] = Math.max(0, Math.min(255, Math.floor((nyT * 0.5 + 0.5) * 255)));
      normal[nIdx++] = Math.max(0, Math.min(255, Math.floor((nzT * 0.5 + 0.5) * 255)));
      normal[nIdx++] = 255;
      // Sprint 10-5c-h: PBR material. Biome-aware roughness.
      //   Snow / ice (cold):   0.65 -- slightly rough
      //   Rock (high elev):    0.40 -- smoother, can glint
      //   Sand (hot + dry):    0.55 -- moderate
      //   Forest (temp + wet): 0.88 -- very diffuse
      //   Grassland (default): 0.78
      // Metallic stays 0 (natural terrain isn't metallic). AO = 1
      // (no occlusion baked yet; future: derive from elev curvature).
      const elevMSL_m = Math.max(0, (elev - seaLevel) / Math.max(0.001, 1 - seaLevel) * 8848);
      const absLatRad = Math.abs(latDeg) * Math.PI / 180;
      const T_base = 30 * Math.cos(absLatRad) - 5;
      const T = T_base - 6.5 * (elevMSL_m / 1000);
      let _matP = 0.45;
      const absLatLoc = Math.abs(latDeg);
      _matP += 0.45 * Math.exp(-Math.pow((absLatLoc -  0) / 12, 2));
      _matP -= 0.35 * Math.exp(-Math.pow((absLatLoc - 25) / 10, 2));
      _matP += 0.25 * Math.exp(-Math.pow((absLatLoc - 55) / 12, 2));
      _matP -= 0.30 * Math.exp(-Math.pow((absLatLoc - 80) / 12, 2));
      _matP = Math.max(0, Math.min(1, _matP));
      let rough;
      if (T < -5)                            rough = 0.65;  // snow/ice
      else if (elevMSL_m > 2000)             rough = 0.40;  // high rock
      else if (T > 18 && _matP < 0.3)        rough = 0.55;  // hot desert
      else if (T > 0  && _matP > 0.6)        rough = 0.88;  // forest
      else                                   rough = 0.78;  // default grassland
      material[mIdx++] = Math.max(0, Math.min(255, Math.floor(rough * 255)));
      material[mIdx++] = 0;     // metallic = 0
      material[mIdx++] = 255;   // AO = 1
      material[mIdx++] = 255;   // reserved
    }
  }
  return { albedo: albedo, normal: normal, material: material };
}

/* End-to-end: allocate slot, generate page pixels, upload to atlas,
 * update page table. Returns true on success, false on failure
 * (atlas full -- 10-5c-e LRU eviction lands later). */
function _svtUploadPage(face, zoom, pageX, pageY, pmap) {
  if (!_SVT.atlasTexture || !Visual.device) return false;
  const slot = _svtAllocateSlot(face, zoom, pageX, pageY);
  if (!slot) return false;
  const key = face + "/" + zoom + "/" + pageX + "/" + pageY;
  const res = _SVT.residency.get(key);
  if (res && res.generated) return true;        // already done
  const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
  const data = _svtGeneratePage(face, zoom, pageX, pageY, pmap);
  if (!data) return false;
  // Albedo upload.
  Visual.device.queue.writeTexture(
    {
      texture: _SVT.atlasTexture,
      origin: { x: slot.x * _SVT.PAGE_SIZE, y: slot.y * _SVT.PAGE_SIZE, z: 0 },
    },
    data.albedo,
    { bytesPerRow: _SVT.PAGE_SIZE * 4, rowsPerImage: _SVT.PAGE_SIZE },
    [_SVT.PAGE_SIZE, _SVT.PAGE_SIZE, 1]
  );
  // Sprint 10-5c-g: normal-map upload to the paired atlas slot.
  if (_SVT.normalAtlas && data.normal) {
    Visual.device.queue.writeTexture(
      {
        texture: _SVT.normalAtlas,
        origin: { x: slot.x * _SVT.PAGE_SIZE, y: slot.y * _SVT.PAGE_SIZE, z: 0 },
      },
      data.normal,
      { bytesPerRow: _SVT.PAGE_SIZE * 4, rowsPerImage: _SVT.PAGE_SIZE },
      [_SVT.PAGE_SIZE, _SVT.PAGE_SIZE, 1]
    );
  }
  // Sprint 10-5c-h: PBR material upload (R=rough, G=metal, B=AO).
  if (_SVT.materialAtlas && data.material) {
    Visual.device.queue.writeTexture(
      {
        texture: _SVT.materialAtlas,
        origin: { x: slot.x * _SVT.PAGE_SIZE, y: slot.y * _SVT.PAGE_SIZE, z: 0 },
      },
      data.material,
      { bytesPerRow: _SVT.PAGE_SIZE * 4, rowsPerImage: _SVT.PAGE_SIZE },
      [_SVT.PAGE_SIZE, _SVT.PAGE_SIZE, 1]
    );
  }
  _svtWritePageTable(face, zoom, pageX, pageY, slot.x, slot.y);
  if (res) res.generated = true;
  _SVT.stats.pagesGenerated++;
  const dtMs = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;
  if ((typeof window !== "undefined" && window.__PLANET_LOG) &&
      _SVT.stats.pagesGenerated % 16 === 1) {
    console.log("[svt] generated page " + face + "/z" + zoom + "/" + pageX + "/" + pageY
              + " → slot (" + slot.x + "," + slot.y + ") in " + dtMs.toFixed(1) + "ms"
              + " | total: " + _SVT.stats.pagesGenerated + " pages, "
              + _SVT.residency.size + " resident, "
              + _SVT.freeSlots.length + " free slots");
  }
  return true;
}

/* Convenience: console-callable test that generates a small ring of
 * pages around the +X face center. Lets the user kick the tires
 * without waiting for chunk-build integration (lands in 10-5c-c).
 * Usage in DevTools: _svtTest()  or  _svtTest(2, 5)  (face, count). */
function _svtTest(face, count) {
  if (typeof face !== "number") face = 0;
  if (typeof count !== "number") count = 16;
  if (!_ensureSVT()) { console.warn("[svt-test] SVT not allocated"); return; }
  const pmap = (typeof state !== "undefined" && state && Array.isArray(state.nodes))
    ? state.nodes.find(n => n && n.type === "PlanetMap") : null;
  if (!pmap) { console.warn("[svt-test] no PlanetMap node found"); return; }
  const half = _SVT.PAGES_PER_FACE_EDGE / 2;
  const ring = Math.ceil(Math.sqrt(count));
  let made = 0;
  for (let dy = -Math.floor(ring/2); dy <= Math.floor(ring/2) && made < count; dy++) {
    for (let dx = -Math.floor(ring/2); dx <= Math.floor(ring/2) && made < count; dx++) {
      const pageX = half + dx;
      const pageY = half + dy;
      if (pageX < 0 || pageX >= _SVT.PAGES_PER_FACE_EDGE) continue;
      if (pageY < 0 || pageY >= _SVT.PAGES_PER_FACE_EDGE) continue;
      const ok = _svtUploadPage(face, _SVT.BASE_ZOOM, pageX, pageY, pmap);
      if (ok) made++;
    }
  }
  console.log("[svt-test] generated " + made + " pages around face " + face + " center");
}
// Expose to console for manual testing.
if (typeof window !== "undefined") window._svtTest = _svtTest;

/* Sprint 10-5c-d: queue + tick for automatic page residency based
 * on chunk visibility. Replaces the manual _svtTest trigger with
 * "pages auto-generate for visible chunks within a per-frame budget."
 *
 * Per chunk in the visible set, figure out which page(s) it spans at
 * SVT zoom 8 (256² pages per face). Deep chunks (depth ≥ 8) fall in
 * one page; shallow chunks span multiple pages. Add unique entries
 * to a FIFO queue and process under a per-frame ms budget. */
function _svtQueueIfNew(face, zoom, pageX, pageY) {
  const pagesPerEdge = (zoom === _SVT.FINE_ZOOM)
    ? _SVT.FINE_PAGES_PER_FACE_EDGE : _SVT.PAGES_PER_FACE_EDGE;
  if (pageX < 0 || pageX >= pagesPerEdge) return;
  if (pageY < 0 || pageY >= pagesPerEdge) return;
  const key = face + "/" + zoom + "/" + pageX + "/" + pageY;
  const existing = _SVT.residency.get(key);
  if (existing && existing.generated) {
    existing.lastFrame = _SVT.frame;
    return;
  }
  if (_SVT.queueKeys.has(key)) return;
  _SVT.queueKeys.add(key);
  _SVT.generationQueue.push({ face: face, zoom: zoom, pageX: pageX, pageY: pageY });
}

/* Sprint 10-5c-h2: per-chunk page queueing across BOTH zoom levels.
 * Base (Z=8) page always queued so coarse fallback exists even at
 * orbit. Fine (Z=10) page queued only when the chunk is deep enough
 * that fine pages would meaningfully resolve (depth ≥ 10). Deeper
 * chunks share pages with neighbors automatically since we round
 * ix/iy down by stepFactor. */
function _svtQueueChunkPages(face, depth, ix, iy) {
  // Always queue base.
  const baseZ = _SVT.BASE_ZOOM;
  if (depth >= baseZ) {
    const stepBase = 1 << (depth - baseZ);
    _svtQueueIfNew(face, baseZ, Math.floor(ix / stepBase), Math.floor(iy / stepBase));
  } else {
    // Chunk spans multiple base pages -- enqueue all of them.
    const span = 1 << (baseZ - depth);
    const startX = ix * span, startY = iy * span;
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        _svtQueueIfNew(face, baseZ, startX + dx, startY + dy);
      }
    }
  }
  // Queue fine only when chunk is at least as deep as fine zoom.
  // depth 10+ chunks map 1:1 to fine pages; deeper chunks share.
  const fineZ = _SVT.FINE_ZOOM;
  if (depth >= fineZ) {
    const stepFine = 1 << (depth - fineZ);
    _svtQueueIfNew(face, fineZ, Math.floor(ix / stepFine), Math.floor(iy / stepFine));
  }
}

function _svtTickGeneration(pmap, budgetMs) {
  if (!pmap || !_SVT.atlasTexture) return;
  if (_SVT.generationQueue.length === 0) return;
  const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
  let processed = 0;
  while (_SVT.generationQueue.length > 0) {
    const item = _SVT.generationQueue.shift();
    const key = item.face + "/" + item.zoom + "/" + item.pageX + "/" + item.pageY;
    _SVT.queueKeys.delete(key);
    const existing = _SVT.residency.get(key);
    if (existing && existing.generated) continue;
    const ok = _svtUploadPage(item.face, item.zoom, item.pageX, item.pageY, pmap);
    if (!ok) {
      // _svtAllocateSlot returns null only if LRU eviction couldn't
      // find a candidate (all 1024 slots touched this frame --
      // means visible-page count exceeds atlas capacity). In that
      // case bail this frame; next frame's visibility set will be
      // smaller (we're paused, presumably) and eviction will find
      // candidates.
      break;
    }
    processed++;
    if (((typeof performance !== "undefined") ? performance.now() : 0) - t0 > budgetMs) break;
  }
  if (typeof _PERFSTATS !== "undefined" && processed > 0) {
    _PERFSTATS.svtPagesGenThisFrame += processed;
  }
  _SVT.frame++;
  if (processed > 0 && _SVT.frame % 60 === 0 &&
      (typeof window !== "undefined" && window.__PLANET_LOG)) {
    // Sparse log so the user can see residency growing without
    // log spam every frame.
    console.log("[svt] residency: " + _SVT.residency.size + "/" + _SVT.TOTAL_SLOTS
              + " slots, " + _SVT.generationQueue.length + " queued, "
              + _SVT.stats.pagesGenerated + " generated, "
              + _SVT.stats.pagesEvicted + " evicted total");
  }
}

/* Sprint 10-5c-c: a tiny all-unresident page table texture used by
 * the bind group when the real SVT page table isn't allocated yet
 * (e.g., device just came up, no PlanetMap in patch). Keeps the
 * pipeline layout valid; shader sees PAGE_UNRESIDENT and falls back
 * to per-fragment procedural. */
function _ensureSVTDefaultPageTable() {
  if (Visual.svtPageTableDefaultView) return Visual.svtPageTableDefaultView;
  if (!Visual.device) return null;
  const tex = Visual.device.createTexture({
    label: "svt-pagetable-default",
    size: [1, 1, 6],
    format: "r32uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const buf = new Uint32Array([0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF,
                               0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF]);
  Visual.device.queue.writeTexture(
    { texture: tex },
    buf,
    { bytesPerRow: 4, rowsPerImage: 1 },
    [1, 1, 6]
  );
  Visual.svtPageTableDefault = tex;
  Visual.svtPageTableDefaultView = tex.createView({ dimension: "2d-array" });
  return Visual.svtPageTableDefaultView;
}

function _depthToZoom(depth) {
  // Sprint 10-6 v8: bumped deepest from 14 → 15 (Mapzen's max). At
  // foot level (depth 16+) this gives ~1.2 m/px instead of ~2.4 m/px.
  if (depth <= 5)  return 3;
  if (depth <= 7)  return 5;
  if (depth <= 9)  return 7;
  if (depth <= 11) return 9;
  if (depth <= 13) return 11;
  if (depth <= 15) return 13;
  return 15;
}

/* Idempotent. No-op if cached or already in-flight. */
function _loadHighResTile(z, x, y) {
  const key = z + "/" + x + "/" + y;
  if (_EARTH_TILES.cache.has(key) || _EARTH_TILES.pending.has(key)) return;
  // LRU-ish: drop oldest entries if over cap. Map iteration is insertion order.
  if (_EARTH_TILES.cache.size >= _EARTH_TILES.maxEntries) {
    const firstKey = _EARTH_TILES.cache.keys().next().value;
    _EARTH_TILES.cache.delete(firstKey);
  }
  _EARTH_TILES.pending.add(key);
  if (typeof _PERFSTATS !== "undefined") {
    _PERFSTATS.demTilesFetched++;
    _PERFSTATS.totalDemTilesFetched++;
  }
  _loadEarthDEMTile(z, x, y).then((imgData) => {
    const meters = new Float32Array(256 * 256);
    const px = imgData.data;
    for (let py = 0; py < 256; py++) {
      for (let pxIdx = 0; pxIdx < 256; pxIdx++) {
        const i4 = (py * 256 + pxIdx) * 4;
        meters[py * 256 + pxIdx] = _decodeTerrariumPixel(px[i4], px[i4+1], px[i4+2]);
      }
    }
    _EARTH_TILES.cache.set(key, { meters, z: z, x: x, y: y, t: performance.now() });
    _EARTH_TILES.pending.delete(key);
    _EARTH_TILES.loadCount++;
    if (typeof _PERFSTATS !== "undefined") {
      _PERFSTATS.demTilesArrived++;
      _PERFSTATS.totalDemTilesArrived++;
    }
    // Logged sparingly (every 16 tiles) so progress is visible without spam.
    if (_EARTH_TILES.loadCount % 16 === 1 &&
        (typeof window !== "undefined" && window.__PLANET_LOG)) {
      console.log("[earth-dem-hires] cached " + _EARTH_TILES.cache.size + " tiles ("
                  + _EARTH_TILES.pending.size + " in flight, "
                  + _EARTH_TILES.loadCount + " loaded total)");
    }
    // Sprint 10-6 v2: selective invalidation -- drop only chunks
    // whose lat/lon bounds overlap THIS tile, not every chunk on
    // the planet. Removes the "world constantly moves" thrash
    // (was: every 64-tile batch dropped 3000+ chunks; now: 1-4
    // chunks per tile on average).
    _invalidateChunksForTile(z, x, y);
  }).catch((err) => {
    _EARTH_TILES.pending.delete(key);
    // Silent on individual tile failures -- common at zoom edges over water.
  });
}

/* Sample any cached high-res tile that covers (lat, lon) at the given zoom.
 * Returns meters, or NaN if no tile cached. Does NOT trigger a fetch.
 *
 * Sprint 10-6 v8: cross-tile bilinear. Previously the bilinear was
 * clipped at the host tile's pixel boundary (x1 = min(255, x0+1)),
 * which left a 1-pixel discontinuity at every tile edge -- visible as
 * thin grid seams across the planet. Now when a corner of the bilinear
 * footprint falls into a neighbor tile, we look that neighbor up and
 * sample from it instead. If the neighbor isn't cached we degrade
 * gracefully by clamping to the host tile edge (old behavior). */
function _sampleHighResDEMMeters(latDeg, lonDeg, zoom) {
  if (latDeg > 85.05 || latDeg < -85.05) return NaN;
  const latRad = latDeg * Math.PI / 180;
  const yNorm = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
  let lonN = lonDeg;
  while (lonN >  180) lonN -= 360;
  while (lonN < -180) lonN += 360;
  const xNorm = (lonN + 180) / 360;
  const tilesPerEdge = 1 << zoom;
  const tx = Math.floor(xNorm * tilesPerEdge);
  const ty = Math.floor(yNorm * tilesPerEdge);
  const hostKey = zoom + "/" + tx + "/" + ty;
  const hostTile = _EARTH_TILES.cache.get(hostKey);
  if (!hostTile) return NaN;

  // Position within the host tile in pixel coords. Range [-0.5, 255.5)
  // when the lat/lon falls inside this tile -- can extend outside that
  // range when the bilinear's right/bottom corner needs the neighbor.
  const pxF = (xNorm * tilesPerEdge - tx) * 256 - 0.5;
  const pyF = (yNorm * tilesPerEdge - ty) * 256 - 0.5;
  const x0 = Math.floor(pxF);
  const y0 = Math.floor(pyF);
  const wx = pxF - x0;
  const wy = pyF - y0;

  // For each corner of the bilinear (x,y), figure out which tile it
  // belongs to and read the appropriate pixel. Neighbors in -x, -y,
  // +x, +y direction; corner cases hit ±x ±y diagonal neighbor.
  // _readPixel returns either the neighbor's pixel OR the clamped
  // host pixel if neighbor isn't loaded.
  const _readPixel = function(localX, localY) {
    let tileX = tx, tileY = ty;
    let ix = localX, iy = localY;
    if (ix < 0)    { tileX -= 1; ix += 256; }
    if (ix > 255)  { tileX += 1; ix -= 256; }
    if (iy < 0)    { tileY -= 1; iy += 256; }
    if (iy > 255)  { tileY += 1; iy -= 256; }
    // Wrap longitude tile index (anti-meridian).
    if (tileX < 0)            tileX += tilesPerEdge;
    if (tileX >= tilesPerEdge) tileX -= tilesPerEdge;
    // Latitude can't wrap (Mercator).
    if (tileY < 0 || tileY >= tilesPerEdge) {
      // Polar fallthrough -- clamp to host edge.
      const cx = Math.max(0, Math.min(255, localX));
      const cy = Math.max(0, Math.min(255, localY));
      return hostTile.meters[cy * 256 + cx];
    }
    if (tileX === tx && tileY === ty) {
      return hostTile.meters[iy * 256 + ix];
    }
    const nbrKey = zoom + "/" + tileX + "/" + tileY;
    const nbrTile = _EARTH_TILES.cache.get(nbrKey);
    if (nbrTile) return nbrTile.meters[iy * 256 + ix];
    // Neighbor not cached -- clamp to host edge (old behavior, leaves
    // a small seam but at least no NaN/hole).
    const cx = Math.max(0, Math.min(255, localX));
    const cy = Math.max(0, Math.min(255, localY));
    return hostTile.meters[cy * 256 + cx];
  };

  const e00 = _readPixel(x0,     y0);
  const e10 = _readPixel(x0 + 1, y0);
  const e01 = _readPixel(x0,     y0 + 1);
  const e11 = _readPixel(x0 + 1, y0 + 1);
  return (e00 * (1 - wx) + e10 * wx) * (1 - wy)
       + (e01 * (1 - wx) + e11 * wx) * wy;
}

/* Convert meters → normalized elev (matches _earthElevationAt mapping). */
function _metersToElev(m) {
  if (m >= 0) return 0.5 + Math.min(0.5, (m / 8848) * 0.5);
  return Math.max(0, 0.5 + (m / 11034) * 0.5);
}

/* Trigger fetch for the tile covering a unit-sphere direction at the
 * given zoom. Idempotent. */
function _ensureHighResTileForDir(ux, uy, uz, zoom) {
  const latDeg = Math.asin(Math.max(-1, Math.min(1, uy))) * 180 / Math.PI;
  if (latDeg > 85.05 || latDeg < -85.05) return;
  // Sprint 10-6 v6: negate atan2 -> see _earthDEMSampleMeters comment.
  const lonDeg = -Math.atan2(uz, ux) * 180 / Math.PI;
  const latRad = latDeg * Math.PI / 180;
  const yNorm = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
  let lonN = lonDeg;
  while (lonN >  180) lonN -= 360;
  while (lonN < -180) lonN += 360;
  const xNorm = (lonN + 180) / 360;
  const tilesPerEdge = 1 << zoom;
  const tx = Math.max(0, Math.min(tilesPerEdge - 1, Math.floor(xNorm * tilesPerEdge)));
  const ty = Math.max(0, Math.min(tilesPerEdge - 1, Math.floor(yNorm * tilesPerEdge)));
  _loadHighResTile(zoom, tx, ty);
}

/* For each of the 5 representative points on the chunk (4 corners + center),
 * trigger a fetch of the covering tile at the chunk's appropriate zoom.
 * 4 corners ensure tiles that straddle the chunk boundary all get fetched. */
function _ensureHighResTilesForChunk(info, zoom) {
  const face = _PLANET_FACES[info.face];
  const corners = [
    [info.uMin, info.vMin], [info.uMax, info.vMin],
    [info.uMin, info.vMax], [info.uMax, info.vMax],
    [(info.uMin + info.uMax) * 0.5, (info.vMin + info.vMax) * 0.5]
  ];
  for (let i = 0; i < corners.length; i++) {
    const u = corners[i][0], v = corners[i][1];
    const cx = face.n[0] + face.t[0]*u + face.b[0]*v;
    const cy = face.n[1] + face.t[1]*u + face.b[1]*v;
    const cz = face.n[2] + face.t[2]*u + face.b[2]*v;
    const cxx = cx*cx, cyy = cy*cy, czz = cz*cz;
    const sx = cx * Math.sqrt(Math.max(0, 1 - cyy*0.5 - czz*0.5 + cyy*czz/3));
    const sy = cy * Math.sqrt(Math.max(0, 1 - cxx*0.5 - czz*0.5 + cxx*czz/3));
    const sz = cz * Math.sqrt(Math.max(0, 1 - cxx*0.5 - cyy*0.5 + cxx*cyy/3));
    const invLen = 1 / Math.max(1e-12, Math.sqrt(sx*sx + sy*sy + sz*sz));
    _ensureHighResTileForDir(sx*invLen, sy*invLen, sz*invLen, zoom);
  }
}

/* Sprint 10-6 v2: when a new tile arrives, drop any cached chunk whose
 * lat/lon AABB overlaps the tile's area. Those chunks will rebuild on
 * the next frame with the now-available finer elevation; chunks
 * outside the tile's area are left alone (no thrash). */
function _invalidateChunksForTile(z, tx, ty) {
  if (!Visual.planetMeshChunkCache) return;
  // Tile bounds in lat/lon. Slippy-map convention: tile (z, tx, ty)
  // covers xNorm = [tx, tx+1] / 2^z, yNorm = [ty, ty+1] / 2^z.
  const tilesPerEdge = 1 << z;
  const tileLonMin = (tx     / tilesPerEdge) * 360 - 180;
  const tileLonMax = ((tx+1) / tilesPerEdge) * 360 - 180;
  // Inverse Mercator: lat = atan(sinh(π * (1 - 2*yNorm))) (deg).
  // ty=0 is the NORTHERN edge, ty=tilesPerEdge-1 is the SOUTHERN.
  const yNorm0 = ty     / tilesPerEdge;
  const yNorm1 = (ty+1) / tilesPerEdge;
  const tileLatMax = Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm0))) * 180 / Math.PI;
  const tileLatMin = Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm1))) * 180 / Math.PI;

  let droppedTotal = 0;
  for (const [nodeId, entry] of Visual.planetMeshChunkCache) {
    const keysToDelete = [];
    for (const [chunkKey, chunk] of entry.chunks) {
      const cb = chunk.latLonBounds;
      if (!cb) continue;
      // Lat AABB overlap: standard 1D interval intersect.
      if (cb.latMax < tileLatMin || cb.latMin > tileLatMax) continue;
      // Lon AABB overlap: AM-aware. If either side wraps, conservatively
      // say overlap (rare and chunks-near-AM aren't common cases).
      let lonOverlap;
      if (cb.crossesAM || cb.nearPole) {
        lonOverlap = true;
      } else {
        lonOverlap = !(cb.lonMax < tileLonMin || cb.lonMin > tileLonMax);
      }
      if (lonOverlap) keysToDelete.push(chunkKey);
    }
    for (const k of keysToDelete) {
      const c = entry.chunks.get(k);
      try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
      try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
      entry.chunks.delete(k);
      droppedTotal++;
    }
  }
  if (typeof _PERFSTATS !== "undefined" && droppedTotal > 0) {
    _PERFSTATS.chunksInvalidated += droppedTotal;
    _PERFSTATS.totalChunksInvalidated += droppedTotal;
  }
  // Log only when we actually dropped something AND it's a sparse event
  // (every 32 tiles for the noisy startup phase).
  if (droppedTotal > 0 && _EARTH_TILES.loadCount % 32 === 0 &&
      (typeof window !== "undefined" && window.__PLANET_LOG)) {
    console.log("[earth-dem-hires] tile " + z + "/" + tx + "/" + ty
              + " selectively invalidated " + droppedTotal + " chunks (vs "
              + (Visual.planetMeshChunkCache.size > 0 ? "thousands" : "0")
              + " under old per-batch invalidation)");
  }
}

/* Best-available elevation sampler. Tries cached high-res tiles from highest
 * zoom downward, falls back to the macro cubemap. Does NOT trigger fetches
 * -- safe to call from collision / AGL / per-vertex chunk build paths.
 *
 * v0.3.358 fix: iterate ALL zoom levels 14 down to 5 (step -1, not -2).
 * Previous step-of-2 sampled only even zooms (14, 12, 10, 8, 6) while
 * _depthToZoom fetches at odd zooms (5, 7, 9, 11, 13) plus 14. Result:
 * only the single depth-16 chunk under the camera (which fetches zoom
 * 14) ever got high-res data -- producing the "one square rising at
 * Everest" symptom while every other Himalayan chunk fell back to the
 * smooth macro cubemap. */
function _planetSampleElevationCached(cubemap, ux, uy, uz) {
  if (!cubemap) return 0;
  // Only bother checking high-res if any tiles are loaded at all.
  if (_EARTH_TILES.cache.size > 0) {
    const latDeg = Math.asin(Math.max(-1, Math.min(1, uy))) * 180 / Math.PI;
    // Sprint 10-6 v6: negate atan2 -> see _earthDEMSampleMeters comment.
    const lonDeg = -Math.atan2(uz, ux) * 180 / Math.PI;
    // Try from highest zoom down. First hit wins.
    for (let z = 14; z >= 5; z--) {
      const m = _sampleHighResDEMMeters(latDeg, lonDeg, z);
      if (!isNaN(m)) return _metersToElev(m);
    }
  }
  return _samplePlanetMapCubemap(cubemap, ux, uy, uz);
}

const _EARTH_CONTINENTS = [
  { name: "Africa",       lat:    5, lon:   20, hw: 35, hh: 35, rot:   5, base: 0.62 },
  { name: "Eurasia",      lat:   50, lon:   80, hw: 90, hh: 25, rot:   0, base: 0.62 },
  { name: "S Asia",       lat:   18, lon:   95, hw: 30, hh: 18, rot:  10, base: 0.60 },
  { name: "Arabia",       lat:   23, lon:   45, hw: 12, hh: 12, rot:  10, base: 0.60 },
  { name: "N America",    lat:   45, lon: -100, hw: 40, hh: 30, rot:   0, base: 0.62 },
  { name: "Cent America", lat:   18, lon:  -90, hw: 12, hh:  8, rot:  20, base: 0.58 },
  { name: "S America",    lat:  -20, lon:  -62, hw: 18, hh: 30, rot:  10, base: 0.62 },
  { name: "Australia",    lat:  -25, lon:  135, hw: 20, hh: 12, rot:   0, base: 0.60 },
  { name: "Antarctica",   lat:  -85, lon:    0, hw:180, hh: 12, rot:   0, base: 0.68 },
  { name: "Greenland",    lat:   75, lon:  -40, hw: 18, hh: 12, rot:   0, base: 0.70 },
  { name: "Indonesia",    lat:   -3, lon:  115, hw: 18, hh:  6, rot:   0, base: 0.58 },
  { name: "Madagascar",   lat:  -20, lon:   47, hw:  3, hh: 10, rot:  10, base: 0.60 },
  { name: "UK + Ireland", lat:   55, lon:   -3, hw:  4, hh:  6, rot:   0, base: 0.58 },
  { name: "Japan",        lat:   37, lon:  138, hw:  3, hh:  9, rot:  20, base: 0.58 },
  { name: "New Zealand",  lat:  -42, lon:  173, hw:  3, hh:  8, rot:  10, base: 0.58 },
];

const _EARTH_RIDGES = [
  { name: "Himalayas",   width: 4, boost: 0.30, pts: [
    {lat:36, lon:71}, {lat:33, lon:78}, {lat:30, lon:84}, {lat:28, lon:92}
  ]},
  { name: "Andes",       width: 3, boost: 0.28, pts: [
    {lat: 10, lon:-73}, {lat:  0, lon:-78}, {lat:-15, lon:-72},
    {lat:-30, lon:-70}, {lat:-45, lon:-72}, {lat:-52, lon:-73}
  ]},
  { name: "Rockies",     width: 4, boost: 0.22, pts: [
    {lat:65, lon:-145}, {lat:55, lon:-128}, {lat:45, lon:-115},
    {lat:38, lon:-110}, {lat:32, lon:-106}
  ]},
  { name: "Alpine belt", width: 3, boost: 0.20, pts: [
    {lat:44, lon: -4}, {lat:45, lon:  7}, {lat:47, lon: 14},
    {lat:42, lon: 28}, {lat:42, lon: 44}, {lat:37, lon: 53}
  ]},
  { name: "Urals",       width: 2, boost: 0.15, pts: [
    {lat:68, lon:65}, {lat:60, lon:60}, {lat:52, lon:58}
  ]},
  { name: "Atlas",       width: 2, boost: 0.15, pts: [
    {lat:33, lon:-7}, {lat:32, lon: 1}, {lat:30, lon: 8}
  ]},
  { name: "GreatDivide", width: 2, boost: 0.12, pts: [
    {lat:-15, lon:145}, {lat:-25, lon:150}, {lat:-35, lon:148}
  ]},
  { name: "Scandes",     width: 2, boost: 0.14, pts: [
    {lat:70, lon:22}, {lat:65, lon:14}, {lat:60, lon: 9}
  ]},
];

function _earthElevationAt(lat, lon) {
  // Sprint 10-5b: real DEM path. Trigger lazy load on first call.
  // If loaded, return real meters mapped to [0, 1]; else ellipse fallback.
  if (!_EARTH_DEM.loaded && !_EARTH_DEM.loading && !_EARTH_DEM.loadFailed) {
    _loadEarthDEM().catch((err) => console.warn("[earth-dem] load error:", err));
  }
  if (_EARTH_DEM.loaded) {
    const m = _earthDEMSampleMeters(lat, lon);
    if (!isNaN(m)) {
      // Map meters → [0, 1] with sea level at 0.5.
      // Land: 0..8848m → 0.5..1.0 (Everest at top).
      // Ocean: -11034..0m → 0.0..0.5 (Mariana at bottom).
      if (m >= 0) return 0.5 + Math.min(0.5, (m / 8848) * 0.5);
      return Math.max(0, 0.5 + (m / 11034) * 0.5);
    }
    // m is NaN -> polar region; fall through to ellipse.
  }
  // Ellipse approximation (used until DEM loads + for polar regions).
  let landMax = 0.30;     // deep-ocean baseline
  for (let i = 0; i < _EARTH_CONTINENTS.length; i++) {
    const c = _EARTH_CONTINENTS[i];
    let dlon = lon - c.lon;
    while (dlon >  180) dlon -= 360;
    while (dlon < -180) dlon += 360;
    const dlat = lat - c.lat;
    const cosLat = Math.cos(c.lat * Math.PI / 180);
    const dlonScaled = dlon * cosLat;
    const cr = Math.cos(c.rot * Math.PI / 180);
    const sr = Math.sin(c.rot * Math.PI / 180);
    const ex =  cr * dlonScaled + sr * dlat;
    const ey = -sr * dlonScaled + cr * dlat;
    const d2 = (ex / c.hw) * (ex / c.hw) + (ey / c.hh) * (ey / c.hh);
    if (d2 < 1) {
      const falloff = Math.pow(1 - d2, 0.4);
      const elev = c.base + falloff * 0.05;
      if (elev > landMax) landMax = elev;
    }
  }
  // 2) Mountain-ridge boost. Closest point on each ridge polyline.
  let ridgeBoost = 0;
  for (let i = 0; i < _EARTH_RIDGES.length; i++) {
    const r = _EARTH_RIDGES[i];
    let bestDist = 1e9;
    for (let j = 0; j < r.pts.length - 1; j++) {
      const a = r.pts[j], b = r.pts[j + 1];
      const cosLatMid = Math.cos((a.lat + b.lat) * 0.5 * Math.PI / 180);
      let aLon = a.lon, bLon = b.lon, qLon = lon;
      while (qLon - aLon >  180) qLon -= 360;
      while (qLon - aLon < -180) qLon += 360;
      while (bLon - aLon >  180) bLon -= 360;
      while (bLon - aLon < -180) bLon += 360;
      const ax = aLon * cosLatMid, ay = a.lat;
      const bx = bLon * cosLatMid, by = b.lat;
      const px = qLon * cosLatMid, py = lat;
      const segLen2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
      let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / Math.max(1e-9, segLen2);
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * (bx - ax);
      const cy = ay + t * (by - ay);
      const d = Math.hypot(px - cx, py - cy);
      if (d < bestDist) bestDist = d;
    }
    if (bestDist < r.width) {
      const w = Math.max(0, 1 - bestDist / r.width);
      ridgeBoost = Math.max(ridgeBoost, w * w * r.boost);
    }
  }
  if (landMax > 0.5) landMax += ridgeBoost;
  return Math.max(0, Math.min(1, landMax));
}

/* Sprint 10-3 -- continuous climate field driving the Whittaker biome
 * lookup. Replaces the 10-5a-fix 5-band lat-only LUT with proper
 * temperature + precipitation fields computed per-vertex from (lat,
 * elevation, lon-driven coast proximity).
 *
 * Climate model:
 *   Temperature: T_baseline(lat) - lapse_rate * elev_above_sea (m)
 *     T_baseline = 30 °C * cos(|lat|) - 5  (warm equator, cool poles)
 *     lapse_rate = 6.5 °C / 1000 m  (real atmospheric lapse rate)
 *   Precipitation: combines Hadley-cell + polar-dry pattern
 *     equator (lat 0): wet (ITCZ rain belt)
 *     subtropical (lat ±25): dry (subtropical highs, desert latitudes)
 *     mid-latitude (lat ±50-60): wet (westerlies storm track)
 *     polar (lat > 70): dry (cold air holds little moisture)
 *
 * Biome lookup: 4×4 Whittaker matrix indexed by (temp_band, precip_band),
 * bilinearly interpolated for smooth transitions. Snow line at T < -5°C
 * regardless of biome; ice/glaciers at very cold. */
function _earthClimateAt(latDeg, elev, seaLevel) {
  const elevMSL = Math.max(0, (elev - seaLevel) / Math.max(0.001, 1 - seaLevel) * 8848);
  const absLat = Math.abs(latDeg);
  const latRad = absLat * Math.PI / 180;
  // Temperature (°C). Real-world fits reasonably with cos-curve baseline
  // minus standard atmospheric lapse.
  const T_baseline = 30 * Math.cos(latRad) - 5;
  const T = T_baseline - 6.5 * (elevMSL / 1000);
  // Precipitation (relative 0–1). Sum of Gaussian peaks/troughs at the
  // characteristic latitudes:
  //   peak ITCZ at lat 0           (amp +0.45, σ 12)
  //   trough subtropical at lat 25 (amp -0.35, σ 10)
  //   peak westerlies at lat 55    (amp +0.25, σ 12)
  //   trough polar at lat 80       (amp -0.30, σ 12)
  let P = 0.45;
  P += 0.45 * Math.exp(-Math.pow((absLat -  0) / 12, 2));
  P -= 0.35 * Math.exp(-Math.pow((absLat - 25) / 10, 2));
  P += 0.25 * Math.exp(-Math.pow((absLat - 55) / 12, 2));
  P -= 0.30 * Math.exp(-Math.pow((absLat - 80) / 12, 2));
  P = Math.max(0, Math.min(1, P));
  return { T, P, elevMSL };
}

/* Sprint 10-3 polish: 8×8 Whittaker biome color matrix (64 entries).
 * Rows = temperature bands (cold→hot), cols = precipitation bands
 * (dry→wet). Bilinearly interpolated for smooth transitions.
 *
 * Real-world biome reference:
 *   Cold-dry  → arctic desert / Antarctic dry valleys
 *   Cold-wet  → tundra → taiga as it warms
 *   Cool-dry  → cold steppe (Mongolia, Patagonia)
 *   Cool-wet  → boreal forest / mixed taiga
 *   Temp-dry  → cold desert (Gobi, Great Basin)
 *   Temp-wet  → temperate deciduous + rainforest (Pacific NW)
 *   Sub-dry   → Mediterranean scrub / chaparral
 *   Sub-wet   → subtropical broadleaf forest
 *   Hot-dry   → Sahara / Arabian / Australian desert
 *   Hot-wet   → tropical rainforest (Amazon, Congo, Indonesia)
 *
 * Colors tuned to match satellite Earth imagery aesthetic: warm-tan
 * deserts, dark forest greens, golden savannas, gray-white tundras. */
const _BIOME_COLOR_MATRIX = [
  // Row 0: Arctic (T < -10):
  //         hyper-arid          arid                semi-arid           dry-sub             moist               wet                 v-wet               hyper-wet
  [ [0.72,0.72,0.66], [0.70,0.71,0.66], [0.68,0.70,0.66], [0.65,0.69,0.66], [0.62,0.68,0.65], [0.58,0.66,0.64], [0.55,0.65,0.62], [0.52,0.62,0.60] ],
  // Row 1: Subarctic (T -10..-2):
  [ [0.68,0.65,0.55], [0.62,0.63,0.52], [0.58,0.62,0.50], [0.52,0.60,0.48], [0.46,0.58,0.45], [0.40,0.55,0.42], [0.36,0.52,0.40], [0.32,0.48,0.38] ],
  // Row 2: Cold continental (T -2..6):
  [ [0.70,0.62,0.45], [0.65,0.60,0.42], [0.58,0.58,0.40], [0.48,0.55,0.36], [0.38,0.52,0.34], [0.30,0.50,0.32], [0.25,0.46,0.30], [0.22,0.42,0.28] ],
  // Row 3: Cool temperate (T 6..12):
  [ [0.72,0.62,0.42], [0.66,0.62,0.38], [0.58,0.60,0.34], [0.46,0.58,0.32], [0.36,0.55,0.30], [0.28,0.52,0.28], [0.24,0.48,0.26], [0.20,0.45,0.25] ],
  // Row 4: Warm temperate (T 12..18):
  [ [0.78,0.66,0.42], [0.70,0.64,0.38], [0.62,0.62,0.34], [0.50,0.60,0.30], [0.40,0.58,0.28], [0.30,0.55,0.26], [0.24,0.50,0.24], [0.20,0.46,0.22] ],
  // Row 5: Subtropical (T 18..24):
  [ [0.82,0.68,0.42], [0.76,0.66,0.40], [0.68,0.64,0.36], [0.56,0.60,0.32], [0.42,0.58,0.28], [0.30,0.54,0.24], [0.22,0.48,0.20], [0.18,0.44,0.18] ],
  // Row 6: Tropical (T 24..28):
  [ [0.85,0.70,0.44], [0.80,0.66,0.40], [0.72,0.62,0.34], [0.58,0.58,0.28], [0.42,0.55,0.24], [0.28,0.52,0.20], [0.16,0.46,0.18], [0.10,0.40,0.15] ],
  // Row 7: Hot tropical (T > 28):
  [ [0.88,0.72,0.46], [0.83,0.68,0.42], [0.75,0.64,0.36], [0.60,0.60,0.30], [0.40,0.55,0.22], [0.22,0.48,0.18], [0.12,0.40,0.16], [0.06,0.34,0.12] ]
];
const _BIOME_T_BREAKS = [-10, -2, 6, 12, 18, 24, 28, 34];   // 8 boundary points
const _BIOME_P_BREAKS = [0.05, 0.18, 0.30, 0.42, 0.55, 0.68, 0.82, 0.95];

/* Helper: bilinear sample of the 8×8 biome matrix given fractional
 * row / col positions. Clamps to grid extents. */
function _biomeMatrixSample(rowF, colF) {
  rowF = Math.max(0, Math.min(7, rowF));
  colF = Math.max(0, Math.min(7, colF));
  const row0 = Math.max(0, Math.min(6, Math.floor(rowF)));
  const row1 = row0 + 1;
  const col0 = Math.max(0, Math.min(6, Math.floor(colF)));
  const col1 = col0 + 1;
  const wr = rowF - row0;
  const wc = colF - col0;
  const c00 = _BIOME_COLOR_MATRIX[row0][col0];
  const c10 = _BIOME_COLOR_MATRIX[row0][col1];
  const c01 = _BIOME_COLOR_MATRIX[row1][col0];
  const c11 = _BIOME_COLOR_MATRIX[row1][col1];
  return [
    (c00[0]*(1-wc) + c10[0]*wc)*(1-wr) + (c01[0]*(1-wc) + c11[0]*wc)*wr,
    (c00[1]*(1-wc) + c10[1]*wc)*(1-wr) + (c01[1]*(1-wc) + c11[1]*wc)*wr,
    (c00[2]*(1-wc) + c10[2]*wc)*(1-wr) + (c01[2]*(1-wc) + c11[2]*wc)*wr
  ];
}

/* Helper: find fractional index of value v in a monotonic increasing
 * breakpoint array. Returns 0 below first, len-1 above last, and
 * interpolated fractional index between. */
function _bandIndexFractional(v, breaks) {
  if (v <= breaks[0]) return 0;
  if (v >= breaks[breaks.length - 1]) return breaks.length - 1;
  for (let i = 0; i < breaks.length - 1; i++) {
    if (v >= breaks[i] && v < breaks[i+1]) {
      return i + (v - breaks[i]) / (breaks[i+1] - breaks[i]);
    }
  }
  return 0;
}

function _earthSurfaceColorAt(latDeg, lonDeg, elev, seaLevel) {
  // Ocean: deeper = darker blue. Unchanged.
  if (elev <= seaLevel) {
    const depth = (seaLevel - elev) / Math.max(0.001, seaLevel);
    const shoreR = 0.18, shoreG = 0.36, shoreB = 0.52;
    const deepR  = 0.04, deepG  = 0.10, deepB  = 0.22;
    return [
      shoreR + (deepR - shoreR) * depth,
      shoreG + (deepG - shoreG) * depth,
      shoreB + (deepB - shoreB) * depth
    ];
  }
  // Compute climate at this point.
  const climate = _earthClimateAt(latDeg, elev, seaLevel);
  const T = climate.T, P = climate.P;
  // Permanent ice/snow override: very cold = solid white regardless of
  // biome. T < -15 = perpetual ice (Antarctica interior, Greenland ice cap).
  if (T < -15) return [0.92, 0.95, 0.98];

  // Bilinear sample the 8×8 biome matrix.
  const rowF = _bandIndexFractional(T, _BIOME_T_BREAKS);
  const colF = _bandIndexFractional(P, _BIOME_P_BREAKS);
  let [r, g, b] = _biomeMatrixSample(rowF, colF);

  // Sub-biome micro-variation: ±4% color jitter per lat/lon hash. Breaks
  // up the otherwise uniform color blocks. Tuned subtle -- enough to
  // suggest "patches of darker/lighter forest" without reading as noise.
  // Hash uses both lat AND lon (and elev as a 3rd seed) so adjacent
  // pixels get different jitter.
  const hashS = Math.sin(latDeg * 12.9898 + lonDeg * 78.233 + elev * 3145.7);
  const jitter = (hashS - Math.floor(hashS)) - 0.5;  // -0.5..0.5
  const microAmp = 0.06;  // ±3% per channel after multiply
  r += jitter * microAmp;
  g += jitter * microAmp * 0.8;  // less green jitter = more natural
  b += jitter * microAmp * 0.6;

  // Snow streaks: T in [-15, -5] blends snow into the biome color.
  if (T < -5) {
    const snowBlend = Math.min(1, (-5 - T) / 10);
    const snowR = 0.92, snowG = 0.95, snowB = 0.98;
    r = r + (snowR - r) * snowBlend;
    g = g + (snowG - g) * snowBlend;
    b = b + (snowB - b) * snowBlend;
  }
  // Altitudinal snow line (mountain caps): scales with latitude.
  // Equator ~4500 m, temperate ~3000 m, polar ~1500 m. Smooth transition
  // up to 1km above the snow line for partial cover (rocky-icy mix).
  const snowLine = (T > 10) ? 4500 : (T > 0) ? 3000 : 1500;
  if (climate.elevMSL > snowLine) {
    const snowAmt = Math.min(1, (climate.elevMSL - snowLine) / 1000);
    const snowR = 0.92, snowG = 0.95, snowB = 0.98;
    r = r + (snowR - r) * snowAmt;
    g = g + (snowG - g) * snowAmt;
    b = b + (snowB - b) * snowAmt;
  }
  // Coastal beach strip: very low land near shore = sandy tan.
  // Approximates beaches/coastal plain. Only fires for warm-enough
  // climates (no beaches on polar coasts where it's just rocky tundra).
  const coastBand = (elev - seaLevel) / Math.max(0.001, 1 - seaLevel);
  if (coastBand < 0.015 && T > 0) {
    const beachAmt = Math.min(1, (0.015 - coastBand) / 0.015);
    const beachR = 0.82, beachG = 0.74, beachB = 0.58;
    const tropicalBeachAmt = Math.min(1, (T - 0) / 20);  // ramp in by 20°C
    const blendStrength = beachAmt * tropicalBeachAmt * 0.7;
    r = r + (beachR - r) * blendStrength;
    g = g + (beachG - g) * blendStrength;
    b = b + (beachB - b) * blendStrength;
  }
  return [r, g, b];
}

function _buildEarthCubemap(resolution) {
  const res = Math.max(16, Math.min(2048, Math.floor(resolution || 512)));
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const face = _PLANET_FACES[f];
    const nX = face.n[0], nY = face.n[1], nZ = face.n[2];
    const tX = face.t[0], tY = face.t[1], tZ = face.t[2];
    const bX = face.b[0], bY = face.b[1], bZ = face.b[2];
    const data = new Float32Array(res * res);
    for (let iy = 0; iy < res; iy++) {
      const v = ((iy + 0.5) / res) * 2 - 1;
      for (let ix = 0; ix < res; ix++) {
        const u = ((ix + 0.5) / res) * 2 - 1;
        const cx = nX + tX * u + bX * v;
        const cy = nY + tY * u + bY * v;
        const cz = nZ + tZ * u + bZ * v;
        const cxx = cx*cx, cyy = cy*cy, czz = cz*cz;
        const sx = cx * Math.sqrt(Math.max(0, 1 - cyy*0.5 - czz*0.5 + cyy*czz/3));
        const sy = cy * Math.sqrt(Math.max(0, 1 - cxx*0.5 - czz*0.5 + cxx*czz/3));
        const sz = cz * Math.sqrt(Math.max(0, 1 - cxx*0.5 - cyy*0.5 + cxx*cyy/3));
        const invLen = 1 / Math.max(1e-12, Math.sqrt(sx*sx + sy*sy + sz*sz));
        const ux = sx * invLen, uy = sy * invLen, uz = sz * invLen;
        const latDeg = Math.asin(Math.max(-1, Math.min(1, uy))) * 180 / Math.PI;
        // Sprint 10-6 v6: negate atan2 so the cubemap stores real-world
        // EAST data at the direction that renders on screen RIGHT.
        // (Right-handed lookAt puts world +Z on screen LEFT.)
        const lonDeg = -Math.atan2(uz, ux) * 180 / Math.PI;
        data[iy * res + ix] = _earthElevationAt(latDeg, lonDeg);
      }
    }
    faces.push(data);
  }
  return { resolution: res, faces };
}

/* Sprint 10-2 -- hydraulic erosion via Sebastian Lague's droplet
 * algorithm (Inria HAL inria-00402079 / "Coding Adventure:
 * Hydraulic Erosion" YouTube). For each face: spawn N random
 * water droplets, walk each one ~30 steps downhill, transfer
 * sediment from steeper segments to flatter ones. Cumulative
 * water flux per texel is tracked in a parallel drainage array.
 * Result: branching valleys carved into the macro heightmap +
 * a drainage texture that lights up along river paths.
 *
 * Operates per-face on the cubemap (~512² each). Droplets that
 * walk off the face edge are discarded -- minor seam artifact
 * acceptable at face boundaries since the cube-sphere corner is
 * already a noisy region. Droplets that drop into ocean (height
 * < seaLevel) are also stopped (no underwater carving).
 *
 * Defaults tuned for our normalized [0, 1] heightmap range:
 * inertia=0.05, sedimentCapacityFactor=4, minSlope=0.01,
 * depositSpeed=0.3, erodeSpeed=0.3, gravity=4, evaporate=0.01,
 * erodeRadius=3 (brush spread to avoid single-pixel carving).
 *
 * Cost: ~30k droplets × 30 steps × 4 bilinear samples × 6 faces
 * = ~22M ops, ~0.5-1.5 s in JS at typical res. One-time per
 * cubemap key change. */
function _erodeFaceHydraulic(face, drainage, res, seaLevel, params) {
  const inertia = (params && params.inertia) || 0.05;
  const capacityFactor = (params && params.capacityFactor) || 4.0;
  const minSlope = (params && params.minSlope) || 0.01;
  const depositSpeed = (params && params.depositSpeed) || 0.3;
  const erodeSpeed = (params && params.erodeSpeed) || 0.3;
  const gravity = (params && params.gravity) || 4.0;
  const evaporate = (params && params.evaporate) || 0.01;
  const numDroplets = (params && params.numDroplets) || 30000;
  const maxSteps = (params && params.maxSteps) || 30;
  const erodeRadius = (params && params.erodeRadius) || 3;
  const initSpeed = 1.0;
  const initWater = 1.0;
  // Pre-build erosion brush: square kernel of weights that
  // diminish with distance to brush center. Carving with a
  // brush (vs single pixel) avoids 1-pixel-deep channels and
  // gives smoother river valleys.
  const brushSize = erodeRadius * 2 + 1;
  const brushW = new Float32Array(brushSize * brushSize);
  let brushWeightSum = 0;
  for (let by = -erodeRadius; by <= erodeRadius; by++) {
    for (let bx = -erodeRadius; bx <= erodeRadius; bx++) {
      const d2 = bx*bx + by*by;
      if (d2 > erodeRadius * erodeRadius) continue;
      const w = 1 - Math.sqrt(d2) / erodeRadius;
      brushW[(by + erodeRadius) * brushSize + (bx + erodeRadius)] = w;
      brushWeightSum += w;
    }
  }
  for (let i = 0; i < brushW.length; i++) brushW[i] /= brushWeightSum;

  // Simple LCG seeded by face content hash so erosion is
  // deterministic per face (won't drift between runs).
  let rngS = 0;
  for (let i = 0; i < Math.min(64, face.length); i++) rngS = (rngS * 31 + Math.floor(face[i] * 1000)) | 0;
  if (rngS === 0) rngS = 1;
  const rng = function() {
    rngS = (Math.imul(rngS, 1664525) + 1013904223) | 0;
    return (rngS >>> 0) / 4294967296;
  };

  for (let d = 0; d < numDroplets; d++) {
    let px = rng() * (res - 1);
    let py = rng() * (res - 1);
    let vx = 0, vy = 0;
    let water = initWater;
    let sediment = 0;
    let speed = initSpeed;
    for (let step = 0; step < maxSteps; step++) {
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      if (ix < 0 || ix >= res - 1 || iy < 0 || iy >= res - 1) break;
      const fx = px - ix;
      const fy = py - iy;
      const h00 = face[iy * res + ix];
      const h10 = face[iy * res + ix + 1];
      const h01 = face[(iy + 1) * res + ix];
      const h11 = face[(iy + 1) * res + ix + 1];
      // Bilinear height + gradient at (px, py).
      const h = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy)
              + h01 * (1 - fx) * fy       + h11 * fx * fy;
      if (h < seaLevel) break;          // hit ocean -- no underwater carving
      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
      const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      // Update velocity: lerp between previous direction and steepest descent.
      vx = vx * inertia - gx * (1 - inertia);
      vy = vy * inertia - gy * (1 - inertia);
      const vLen = Math.hypot(vx, vy);
      if (vLen < 1e-6) break;
      vx /= vLen; vy /= vLen;
      const npx = px + vx;
      const npy = py + vy;
      const nix = Math.floor(npx);
      const niy = Math.floor(npy);
      if (nix < 0 || nix >= res - 1 || niy < 0 || niy >= res - 1) break;
      const nfx = npx - nix;
      const nfy = npy - niy;
      const nh00 = face[niy * res + nix];
      const nh10 = face[niy * res + nix + 1];
      const nh01 = face[(niy + 1) * res + nix];
      const nh11 = face[(niy + 1) * res + nix + 1];
      const hNew = nh00 * (1 - nfx) * (1 - nfy) + nh10 * nfx * (1 - nfy)
                 + nh01 * (1 - nfx) * nfy       + nh11 * nfx * nfy;
      const dh = hNew - h;
      const capacity = Math.max(-dh, minSlope) * speed * water * capacityFactor;
      if (sediment > capacity || dh > 0) {
        // Deposit sediment back into the heightmap. Going uphill =
        // forced deposit (fill the pit); otherwise deposit excess
        // sediment proportional to depositSpeed.
        const amount = (dh > 0) ? Math.min(dh, sediment) : (sediment - capacity) * depositSpeed;
        sediment -= amount;
        face[iy * res + ix]           += amount * (1 - fx) * (1 - fy);
        face[iy * res + ix + 1]       += amount * fx       * (1 - fy);
        face[(iy + 1) * res + ix]     += amount * (1 - fx) * fy;
        face[(iy + 1) * res + ix + 1] += amount * fx       * fy;
      } else {
        // Erode. Spread the carve across the brush so we don't
        // make 1-pixel-deep channels.
        const amount = Math.min((capacity - sediment) * erodeSpeed, -dh);
        for (let by = -erodeRadius; by <= erodeRadius; by++) {
          const yy = iy + by;
          if (yy < 0 || yy >= res) continue;
          for (let bx = -erodeRadius; bx <= erodeRadius; bx++) {
            const xx = ix + bx;
            if (xx < 0 || xx >= res) continue;
            const w = brushW[(by + erodeRadius) * brushSize + (bx + erodeRadius)];
            if (w <= 0) continue;
            const carved = Math.min(amount * w, face[yy * res + xx] - seaLevel);
            if (carved > 0) {
              face[yy * res + xx] -= carved;
              sediment += carved;
            }
          }
        }
      }
      // Track cumulative water passing through this cell -- the
      // drainage signal that will paint rivers in the render.
      drainage[iy * res + ix] += water;
      // Update speed (downhill gains, uphill loses) + evaporate.
      speed = Math.sqrt(Math.max(0, speed * speed + dh * gravity));
      water *= (1 - evaporate);
      px = npx; py = npy;
    }
  }
}

/* Sprint 10-5a -- the custom-source cubemap bake (formerly inlined in
 * _ensurePlanetMapCubemap). Bakes a 6×res² cubemap by sampling the
 * IDW-blended cell-graph elevation at each texel, with the ridge-
 * boost applied in-place. Used when PlanetMap.source === "custom"
 * (hand-painted maps); the "earth" source uses _buildEarthCubemap
 * instead. */
function _buildCustomCellCubemap(node, cells, hash, ridgeBoost, res) {
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const face = _PLANET_FACES[f];
    const nX = face.n[0], nY = face.n[1], nZ = face.n[2];
    const tX = face.t[0], tY = face.t[1], tZ = face.t[2];
    const bX = face.b[0], bY = face.b[1], bZ = face.b[2];
    const data = new Float32Array(res * res);
    for (let iy = 0; iy < res; iy++) {
      const v = ((iy + 0.5) / res) * 2 - 1;
      for (let ix = 0; ix < res; ix++) {
        const u = ((ix + 0.5) / res) * 2 - 1;
        const cx = nX + tX * u + bX * v;
        const cy = nY + tY * u + bY * v;
        const cz = nZ + tZ * u + bZ * v;
        const cxx = cx*cx, cyy = cy*cy, czz = cz*cz;
        const sx = cx * Math.sqrt(Math.max(0, 1 - cyy*0.5 - czz*0.5 + cyy*czz/3));
        const sy = cy * Math.sqrt(Math.max(0, 1 - cxx*0.5 - czz*0.5 + cxx*czz/3));
        const sz = cz * Math.sqrt(Math.max(0, 1 - cxx*0.5 - cyy*0.5 + cxx*cyy/3));
        const invLen = 1 / Math.max(1e-12, Math.sqrt(sx*sx + sy*sy + sz*sz));
        const ux = sx * invLen, uy = sy * invLen, uz = sz * invLen;
        data[iy * res + ix] = _samplePlanetCellsIDWBoosted(cells, hash, ridgeBoost, ux, uy, uz);
      }
    }
    faces.push(data);
  }
  return faces;
}

function _ensurePlanetMapCubemap(node) {
  if (!node || !node.params) return null;
  const key = _planetMapCacheKey(node);
  if (node._cubemap && node._cubemapKey === key) return node._cubemap;
  const p = node.params;
  const res = Math.max(16, Math.min(2048, Math.floor((typeof p.resolution === "number") ? p.resolution : 256)));

  // §planet-spec Phase 7.b -- if the patch carries a baked cubemap
  // that matches the current params, decode it instead of re-baking.
  // Allows authored maps (Phase 7.d painter output) to survive save +
  // reload. The cubemapKey tag in params is the same fingerprint the
  // bake uses, so any param edit invalidates the saved data and we
  // re-bake (overwriting the stale cubemapData on the next save).
  if (typeof p.cubemapData === "string" && p.cubemapKey === key
      && typeof p.cubemapDataRes === "number" && p.cubemapDataRes === res) {
    const decoded = _decodeCubemapBase64(p.cubemapData, res);
    if (decoded) {
      node._cubemap = decoded;
      node._cubemapKey = key;
      if (!Visual._planetMapLoadLogged) {
        Visual._planetMapLoadLogged = true;
        console.log("[planet-map] loaded " + res + "² × 6 cubemap from patch (skipped re-bake)");
      }
      return node._cubemap;
    }
  }

  // Sprint 10-7 -- source toggle restored. Three valid values:
  //   "earth"   programmatic Earth bake (10-5a / 10-5b real DEM)
  //   "remix"   procedural plate paste-up (10-8 series). For now this
  //             aliases to "earth" until 10-8c lands the paste path;
  //             toggling to remix re-bakes but yields the same Earth
  //             cubemap. UI exists so 10-8d's controls can read it.
  //   "custom"  cell-graph bake (Azgaar / Phase-7-painter)
  //
  // The 10-5a-fix v3 hard pin to "earth" is lifted now that the bake
  // is confirmed working; cell-graph custom is reachable again for
  // users who painted maps. The cache key (_planetMapCacheKey)
  // includes src= so swapping source invalidates the cubemap.
  let source = (typeof p.source === "string") ? p.source : "earth";
  if (source !== "earth" && source !== "remix" && source !== "custom") {
    console.warn("[planet-map] unknown source \"" + source + "\" -- defaulting to earth");
    source = "earth";
  }
  if (source === "remix") {
    // Stub until 10-8c. Log once so the toggle is visibly wired but
    // it's not silently doing nothing different.
    if (!Visual._planetRemixStubLogged) {
      Visual._planetRemixStubLogged = true;
      console.log("[planet-map] source=\"remix\" stub: 10-8 paste pipeline not yet wired; falling back to earth bake.");
    }
    source = "earth";
  }
  let faces;
  let cells = null;       // only built in "custom" branch
  let hash = null;
  let ridgeBoost = null;
  let t0 = (typeof performance !== "undefined") ? performance.now() : 0;
  if (source === "earth") {
    const eTo = (typeof performance !== "undefined") ? performance.now() : 0;
    const earthCubemap = _buildEarthCubemap(res);
    faces = earthCubemap.faces;
    const dt = ((typeof performance !== "undefined") ? performance.now() : 0) - eTo;
    // Dump face-elevation stats so we can tell if the bake actually
    // produced varied terrain or just baked sea level everywhere.
    let cMin = Infinity, cMax = -Infinity, cSum = 0, nLand = 0, nOcean = 0, nTotal = 0;
    const seaLvl = (typeof node.params.seaLevel === "number") ? node.params.seaLevel : 0.5;
    for (let f = 0; f < faces.length; f++) {
      const arr = faces[f];
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v < cMin) cMin = v;
        if (v > cMax) cMax = v;
        cSum += v;
        if (v > seaLvl) nLand++; else nOcean++;
        nTotal++;
      }
    }
    const landPct = (100 * nLand / nTotal).toFixed(1);
    console.log("[planet-map] EARTH bake done: " + res + "² × 6 faces in " + dt.toFixed(0) + "ms"
                + " | source=" + (_EARTH_DEM.loaded ? "REAL DEM" : "ellipse fallback")
                + " | elev range=[" + cMin.toFixed(3) + ", " + cMax.toFixed(3) + "]"
                + " mean=" + (cSum/nTotal).toFixed(3) + " seaLevel=" + seaLvl
                + " | land=" + landPct + "% ocean=" + (100-parseFloat(landPct)).toFixed(1) + "%");
  } else {
    // Custom source: existing cell-graph bake path.
    cells = _ensurePlanetMapCells(node);
    hash = node._cellsHash;
    if (!node._ridgeBoost || node._ridgeBoostKey !== key) {
      const tR = (typeof performance !== "undefined") ? performance.now() : 0;
      if (node._cellNeighbors && typeof node._cellNeighborsK === "number") {
        node._ridgeBoost = _planetEnhanceRidges(cells, node._cellNeighbors, node._cellNeighborsK);
      } else {
        node._ridgeBoost = new Float32Array(cells.count);
      }
      node._ridgeBoostKey = key;
      if (!Visual._planetRidgeLogged) {
        Visual._planetRidgeLogged = true;
        let ridgeCellCount = 0, maxBoost = 0;
        for (let i = 0; i < cells.count; i++) {
          if (node._ridgeBoost[i] > 0) { ridgeCellCount++; if (node._ridgeBoost[i] > maxBoost) maxBoost = node._ridgeBoost[i]; }
        }
        const tdR = ((typeof performance !== "undefined") ? performance.now() : 0) - tR;
        console.log("[planet-map] ridge boost: " + ridgeCellCount + "/" + cells.count + " cells boosted (max +" + maxBoost.toFixed(3) + ") in " + tdR.toFixed(1) + "ms");
      }
    }
    ridgeBoost = node._ridgeBoost;
    faces = _buildCustomCellCubemap(node, cells, hash, ridgeBoost, res);
  }

  const dtMs = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;

  // Sprint 10-2: hydraulic erosion pass. Operates on each face in-
  // place; modifies elevations + accumulates a parallel drainage
  // texture per face. Drainage is sampled by the chunk vertex
  // shader to tint river paths blue. Erosion scaling: numDroplets
  // grows with face area so deeper-res cubemaps get proportionally
  // more droplets (constant per-texel coverage).
  const dropletsPerFace = Math.round(res * res * 0.12);  // ~30k @ 512², ~120k @ 1024²
  const drainageFaces = [];
  // Sea-level threshold for erosion (stop carving below this). Read
  // from the wired PlanetMesh's seaLevel if any are in the graph;
  // otherwise default 0.5 (the PlanetMesh registry default).
  let _eroSeaLevel = 0.5;
  if (typeof state !== "undefined" && state && Array.isArray(state.nodes)) {
    const pmesh = state.nodes.find(n => n && n.type === "PlanetMesh");
    if (pmesh && pmesh.params && typeof pmesh.params.seaLevel === "number") {
      _eroSeaLevel = Math.max(0, Math.min(1, pmesh.params.seaLevel));
    }
  }
  const eroT0 = (typeof performance !== "undefined") ? performance.now() : 0;
  for (let f = 0; f < 6; f++) {
    const d = new Float32Array(res * res);
    _erodeFaceHydraulic(faces[f], d, res, _eroSeaLevel, {
      numDroplets: dropletsPerFace,
      maxSteps: 30,
      erodeRadius: 3,
      inertia: 0.05,
      capacityFactor: 4.0,
      depositSpeed: 0.3,
      erodeSpeed: 0.3,
      gravity: 4.0,
      evaporate: 0.01,
      minSlope: 0.01
    });
    drainageFaces.push(d);
  }
  const eroDtMs = ((typeof performance !== "undefined") ? performance.now() : 0) - eroT0;
  node._drainage = { resolution: res, faces: drainageFaces };
  if (!Visual._planetErodeLogged) {
    Visual._planetErodeLogged = true;
    let maxFlux = 0, riverTexels = 0;
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i < drainageFaces[f].length; i++) {
        const v = drainageFaces[f][i];
        if (v > maxFlux) maxFlux = v;
        if (v > 50) riverTexels++;
      }
    }
    console.log("[planet-erode] " + (6 * dropletsPerFace) + " droplets × 30 steps × 6 faces in "
                + eroDtMs.toFixed(0) + "ms; max drainage flux=" + maxFlux.toFixed(1)
                + ", river texels (flux>50)=" + riverTexels + "/" + (6 * res * res));
  }

  node._cubemap = { resolution: res, faces };
  node._cubemapKey = key;
  // §planet-spec Phase 7.b -- serialize the freshly-baked cubemap
  // into node.params so a subsequent .gpatch save captures it and
  // reload skips the bake. Re-bake on param change naturally
  // overwrites cubemapData here (key tag invalidates the cached copy).
  try {
    p.cubemapData = _encodeCubemapBase64(node._cubemap);
    p.cubemapDataRes = res;
    p.cubemapKey = key;
  } catch (err) {
    console.warn("[planet-map] cubemap base64 encode failed:", err);
  }
  if (!Visual._planetMapBakeLogged) {
    Visual._planetMapBakeLogged = true;
    console.log("[planet-map] baked " + res + "² × 6 cubemap in " + dtMs.toFixed(1) + "ms; serialized "
                + (p.cubemapData ? Math.round(p.cubemapData.length / 1024) + "KB to params.cubemapData" : "(encode failed)"));
  }
  return node._cubemap;
}

/* §planet-spec Phase 7.a -- sample the cubemap at a unit direction.
 * Bilinear over 4 texels of the picked face. */
function _samplePlanetMapCubemap(cubemap, ux, uy, uz) {
  const absX = Math.abs(ux), absY = Math.abs(uy), absZ = Math.abs(uz);
  let face, u, v, denom;
  if (absX >= absY && absX >= absZ) {
    denom = absX;
    if (ux > 0) { face = 0; u = -uz/denom; v = uy/denom; }
    else        { face = 1; u =  uz/denom; v = uy/denom; }
  } else if (absY >= absZ) {
    denom = absY;
    if (uy > 0) { face = 2; u = ux/denom; v =  uz/denom; }
    else        { face = 3; u = ux/denom; v = -uz/denom; }
  } else {
    denom = absZ;
    if (uz > 0) { face = 4; u =  ux/denom; v = uy/denom; }
    else        { face = 5; u = -ux/denom; v = uy/denom; }
  }
  const res = cubemap.resolution;
  const data = cubemap.faces[face];
  const fx = ((u + 1) * 0.5) * res - 0.5;
  const fy = ((v + 1) * 0.5) * res - 0.5;
  const ix = Math.max(0, Math.min(res - 2, Math.floor(fx)));
  const iy = Math.max(0, Math.min(res - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - ix));
  const ty = Math.max(0, Math.min(1, fy - iy));
  const a = data[iy * res + ix];
  const b = data[iy * res + ix + 1];
  const c = data[(iy + 1) * res + ix];
  const d = data[(iy + 1) * res + ix + 1];
  return a*(1-tx)*(1-ty) + b*tx*(1-ty) + c*(1-tx)*ty + d*tx*ty;
}

/* §planet-spec Phase 7.a -- resolve the PlanetMap (if any) wired to
 * a Planet node's heightmap input. Returns the cubemap data structure
 * or null. Cached on the PlanetMap node so subsequent reads are
 * zero-cost until its params change. */
function _findPlanetMapForPlanet(planetNode) {
  if (!state || !Array.isArray(state.edges) || !planetNode) return null;
  const edge = state.edges.find(e =>
    e && e.to && e.to.node === planetNode.id && e.to.port === "heightmap"
  );
  if (!edge || !edge.from) return null;
  const src = state.nodes.find(n => n && n.id === edge.from.node);
  if (!src || src.type !== "PlanetMap") return null;
  return _ensurePlanetMapCubemap(src);
}

/* §planet-spec Phase 4.c -- recursive quadtree split per face. Each
 * node represents a square region of one cube face in (u, v) ∈
 * [uMin, uMax] × [vMin, vMax]. Split rule: distance from camera to
 * chunk's sphere-center < chunkEdge * splitFactor → split. Bounded
 * by maxDepth so a camera on the surface doesn't infinitely recurse.
 *
 * Returns a flat array of leaf descriptors. Built per mesh-rebuild;
 * the rebuild cadence is governed by _meshCacheKey, which quantizes
 * the camera position to ~radius/2^maxDepth so we only rebuild when
 * the camera crosses a finest-level chunk boundary. */
function _planetChunkKey(face, depth, ix, iy) {
  return face + "|" + depth + "|" + ix + "|" + iy;
}

function _planetVisibleChunks(camPos, radius, heightScale, maxDepth, splitFactor, localTerrainR) {
  const out = [];
  // §planet-spec Phase 4.d -- horizon-occlusion cull. The visible cap
  // of a sphere with center O, radius R from a camera at distance d
  // is the set of points with dot(P/R, OC/d) > R/d -- i.e. inside the
  // cone of half-angle arccos(R/d) around the OC axis. A chunk whose
  // center direction has dot < R/d - safetyMargin is fully behind the
  // horizon and is dropped (along with all of its would-be children).
  // safetyMargin = chunkAngularHalfExtent + heightScale/R, so we don't
  // drop chunks whose mountain peaks could poke above the local
  // horizon, or whose corners extend past the center direction.
  // §bonus-perf-foot-9 (2026-05-25) -- the original gate
  // `cMag > elevRadius * 1.001` required camera to be 10 km above
  // mean sea level before horizon cull engaged. At foot altitude
  // (1.8 m) it was disabled, and depth-2 far-side chunks (~2,500 km
  // wide, on the opposite side of Earth) went through full GPU
  // pipeline. The depth histogram showed d2:73 chunks appearing
  // exactly at the 60→9 fps cliff. New gate: `cMag > radius` (any
  // altitude above mean sphere). The existing elevationSlack +
  // chunkArc still protect mountain-peak chunks from being culled,
  // so this is safe.
  const cs2  = camPos.x*camPos.x + camPos.y*camPos.y + camPos.z*camPos.z;
  const cMag = Math.sqrt(cs2);
  // §bonus-perf-foot-11 -- AGL-correct horizon. localTerrainR (passed
  // in) = mean sphere radius + local terrain elevation under the
  // camera. The camera's effective altitude for horizon purposes is
  // (cMag - localTerrainR) = AGL. Horizon angle uses localTerrainR
  // as the visible-cap reference, so a camera 100m above a 5km
  // mountain gets a horizon cone matching 100m AGL (~0.32°), not
  // 5.1km MSL (~2.3°). Fixes the cliff where MSL inflated chunk
  // count over terrain. Falls back to `radius` when caller didn't
  // pass localTerrainR (other call sites unchanged).
  const refR = (typeof localTerrainR === "number" && localTerrainR > 0) ? localTerrainR : radius;
  const camOutside = cMag > refR;
  // §bonus-perf-foot-10 -- angle-space horizon (radians).
  const horizonAngle = camOutside ? Math.acos(Math.max(-1, Math.min(1, refR / cMag))) : Math.PI;
  const camDX = camOutside ? camPos.x / cMag : 0;
  const camDY = camOutside ? camPos.y / cMag : 0;
  const camDZ = camOutside ? camPos.z / cMag : 0;
  // §bonus-5km-deload (2026-05-25) -- elevationSlack rewritten using
  // the sagitta-correct formula. A peak of height H at arc-distance D
  // from the sub-camera point is occluded by Earth's bulge when
  // D²/(2R) > h_cam + H. Solving for D gives the max arc distance a
  // peak of height H stays above the local horizon:
  //   D_max = sqrt(2R * (h_cam + H))
  //   → angular distance D_max/R = sqrt(2(h_cam + H)/R)
  // The horizonAngle already covers the sqrt(2*h_cam/R) part. The
  // SLACK we need is the additional angle for an H-tall feature, i.e.
  //   slack = sqrt(2*H/R)
  // (Worst-case: when h_cam→0, this matches exactly. When h_cam>>H,
  //  slightly over-estimates, but cull is supposed to be conservative.)
  //
  // For Earth + 8.8 km Everest heightScale:
  //   old: 8800/6378000 = 0.00138 rad (0.08°)   → ~15 km horizon disc
  //   new: sqrt(2*8800/6378000) = 0.0525 rad (3°) → ~333 km horizon disc
  //
  // Was the cause of the user's "world deloads under 5km" report --
  // descending below 5km AGL shrank the horizonAngle proportionally
  // and the linear slack couldn't compensate. The sqrt slack stays
  // constant regardless of altitude so the visible disc is bounded by
  // peak terrain elevation, not camera height.
  const elevationSlack = camOutside ? Math.sqrt(2 * Math.max(0, heightScale) / Math.max(1e-6, radius)) : 0;
  function recurse(face, uMin, uMax, vMin, vMax, depth, ix, iy) {
    const uMid = (uMin + uMax) * 0.5;
    const vMid = (vMin + vMax) * 0.5;
    const f = _PLANET_FACES[face];
    const cx = f.n[0] + f.t[0] * uMid + f.b[0] * vMid;
    const cy = f.n[1] + f.t[1] * uMid + f.b[1] * vMid;
    const cz = f.n[2] + f.t[2] * uMid + f.b[2] * vMid;
    const sph = _planetSpherify(cx, cy, cz);
    // Conservative chunk angular half-extent: diagonal of (uMax-uMin)
    // × (vMax-vMin) face square mapped to sphere arc. The 0.6 factor
    // is sqrt(2)*π/8 rounded up to cover spherified warping near face
    // corners. Children are subsets of their parent so culling at a
    // parent depth is safe -- if the parent's furthest point is behind
    // horizon, every child's furthest point is too.
    const chunkArc = (uMax - uMin) * 0.6;   // angular half-extent (rad)
    if (camOutside) {
      const sphDot = sph[0]*camDX + sph[1]*camDY + sph[2]*camDZ;
      // §bonus-perf-foot-10 -- angle-space cull. The chunk is OK if
      // its center is within (horizonAngle + chunkArc + elevationSlack)
      // angular distance from sub-camera point. acos(sphDot) gives that
      // angular distance; if it's beyond the visible cap, cull. Cheap
      // (~few thousand acos calls per frame; the depth-2/4 chunks that
      // used to slip through were the actual GPU cost we're avoiding).
      const sphAngle = Math.acos(Math.max(-1, Math.min(1, sphDot)));
      if (sphAngle > horizonAngle + chunkArc + elevationSlack) {
        return;
      }
    }
    const wx = sph[0] * radius, wy = sph[1] * radius, wz = sph[2] * radius;
    const dx = camPos.x - wx, dy = camPos.y - wy, dz = camPos.z - wz;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    // Chunk world-edge length ≈ (uMax-uMin) * radius * π/4. The π/4
    // factor is the per-radian-of-face conversion (one cube face spans
    // π/2 radians; one unit of (u,v) ∈ [-1,1] spans half of that).
    const chunkEdge = (uMax - uMin) * radius * (Math.PI * 0.25);
    if (depth < maxDepth && dist < chunkEdge * splitFactor) {
      const cd = depth + 1;
      recurse(face, uMin, uMid, vMin, vMid, cd, ix*2,   iy*2);
      recurse(face, uMid, uMax, vMin, vMid, cd, ix*2+1, iy*2);
      recurse(face, uMin, uMid, vMid, vMax, cd, ix*2,   iy*2+1);
      recurse(face, uMid, uMax, vMid, vMax, cd, ix*2+1, iy*2+1);
      return;
    }
    out.push({ face, uMin, uMax, vMin, vMax, depth, ix, iy });
  }
  for (let f = 0; f < 6; f++) recurse(f, -1, 1, -1, 1, 0, 0, 0);
  return out;
}

/* §planet-spec Phase 6b -- shared planet params resolver. Same logic
 * the old monolithic _buildPlanet ran at its top; pulled out so both
 * the per-chunk builder and the streaming entry can read identical
 * values without duplicating param defaults. */
function _resolvePlanetGeom(p) {
  const polRatio = Math.max(0.5, Math.min(1.5, (typeof p.polarRadiusRatio === "number") ? p.polarRadiusRatio : 1.0));
  return {
    r:        (typeof p.radius   === "number") ? p.radius   : 1000,
    polRatio,
    polRatio2: polRatio * polRatio,
    cxC: (typeof p.centerX === "number") ? p.centerX : 0,
    cyC: (typeof p.centerY === "number") ? p.centerY : 0,
    czC: (typeof p.centerZ === "number") ? p.centerZ : 0,
    segs: Math.max(1, Math.min(64, Math.floor((typeof p.segments === "number") ? p.segments : 16))),
    maxDepth:    Math.max(0, Math.min(14, Math.floor((typeof p.maxDepth    === "number") ? p.maxDepth    : 6))),
    splitFactor: Math.max(0.1, Math.min(50, (typeof p.splitFactor === "number") ? p.splitFactor : 5.0)),
    hs:       (typeof p.heightScale === "number") ? p.heightScale : 0,
    seaLevel: Math.max(0, Math.min(1, (typeof p.seaLevel === "number") ? p.seaLevel : 0.5)),
    noiseDef: {
      seed:       (typeof p.seed       === "number") ? p.seed       : 7.3,
      frequency:  (typeof p.frequency  === "number") ? p.frequency  : 1.0,
      octaves:    Math.max(1, Math.min(20, Math.floor((typeof p.octaves === "number") ? p.octaves : 6))),
      lacunarity: (typeof p.lacunarity === "number") ? p.lacunarity : 2.0,
      gain:       (typeof p.gain       === "number") ? p.gain       : 0.5,
      ridges:     (typeof p.ridges     === "number") ? p.ridges     : 0
    }
  };
}

/* §planet-spec Phase 6b -- per-chunk Planet vertex / index builder.
 * Carved out of the old monolithic _buildPlanet so the streaming entry
 * can build chunks one at a time under a per-frame time budget --
 * mirrors TiledTerrain's _buildSingleChunk pattern. Each chunk gets
 * its OWN GPU vertex+index buffer (destroyed when the chunk leaves
 * the visible quadtree set). Caller supplies info = { face, uMin,
 * uMax, vMin, vMax, depth, ix, iy, segs } -- segs is the per-chunk
 * resolution (placeholder phase passes segs=2 for instant builds;
 * upgrade phase passes the param's full segs). camPos is the planet-
 * LOCAL camera position used for CDLOD morph + chunk-distance octave
 * truncation. */
function _buildSinglePlanetChunk(node, info, camPos, sun, ambient, planetMap) {
  if (!Visual.device) return null;
  const p = node.params || {};
  const geom = _resolvePlanetGeom(p);
  const r = geom.r, polRatio = geom.polRatio, polRatio2 = geom.polRatio2;
  const cxC = geom.cxC, cyC = geom.cyC, czC = geom.czC;
  const hs = geom.hs, seaLevel = geom.seaLevel;
  const splitFactor = geom.splitFactor;
  const segs = info.segs;
  const sunX = sun[0], sunY = sun[1], sunZ = sun[2];
  const noiseDef = geom.noiseDef;
  // §planet-spec Phase 7.a -- if a PlanetMap is wired, sample height
  // from the baked cubemap instead of running 3D fBm. The cubemap was
  // baked from the same fBm at high res, so the visual is identical
  // for now -- this commit just proves the data flow.
  const useCubemap = !!planetMap;

  const face = _PLANET_FACES[info.face];
  const nX = face.n[0], nY = face.n[1], nZ = face.n[2];
  const tX = face.t[0], tY = face.t[1], tZ = face.t[2];
  const bX = face.b[0], bY = face.b[1], bZ = face.b[2];

  // Per-chunk octave count + CDLOD morph (Phase 3 + Phase 5).
  const chunkEdge = (info.uMax - info.uMin) * r * (Math.PI * 0.25);
  const spacing = chunkEdge / Math.max(1, segs);
  const lodOctF = (hs !== 0)
    ? _octavesForSpacing(noiseDef.frequency, spacing, noiseDef.octaves)
    : 0;
  const effOctavesF = Math.min(noiseDef.octaves, lodOctF);
  const uMidC = (info.uMin + info.uMax) * 0.5;
  const vMidC = (info.vMin + info.vMax) * 0.5;
  const cxMid = nX + tX * uMidC + bX * vMidC;
  const cyMid = nY + tY * uMidC + bY * vMidC;
  const czMid = nZ + tZ * uMidC + bZ * vMidC;
  const sphMid = _planetSpherify(cxMid, cyMid, czMid);
  const ddx = camPos.x - sphMid[0] * r;
  const ddy = camPos.y - sphMid[1] * r;
  const ddz = camPos.z - sphMid[2] * r;
  const chunkDist = Math.sqrt(ddx*ddx + ddy*ddy + ddz*ddz);
  const splitThreshold = chunkEdge * splitFactor;
  const morph = Math.max(0, Math.min(1, (chunkDist / Math.max(1e-6, splitThreshold)) - 1));
  const morphedOctavesF = Math.max(0, effOctavesF - morph);
  const chunkNoise = Object.assign({}, noiseDef, { effectiveOctavesF: morphedOctavesF });

  const N = segs + 1;
  const verts = new Float32Array(N * N * 11);
  const indices = new Uint32Array(segs * segs * 6);
  let vWrite = 0, iWrite = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let iy = 0; iy <= segs; iy++) {
    const fy01 = iy / segs;
    const v = info.vMin + (info.vMax - info.vMin) * fy01;
    for (let ix = 0; ix <= segs; ix++) {
      const fx01 = ix / segs;
      const u = info.uMin + (info.uMax - info.uMin) * fx01;
      const cx = nX + tX * u + bX * v;
      const cy = nY + tY * u + bY * v;
      const cz = nZ + tZ * u + bZ * v;
      const cxx = cx * cx, cyy = cy * cy, czz = cz * cz;
      const sx = cx * Math.sqrt(Math.max(0, 1 - cyy * 0.5 - czz * 0.5 + cyy * czz / 3));
      const sy = cy * Math.sqrt(Math.max(0, 1 - cxx * 0.5 - czz * 0.5 + cxx * czz / 3));
      const sz = cz * Math.sqrt(Math.max(0, 1 - cxx * 0.5 - cyy * 0.5 + cxx * cyy / 3));
      const invLen = 1 / Math.max(1e-12, Math.sqrt(sx*sx + sy*sy + sz*sz));
      const ux = sx * invLen, uy = sy * invLen, uz = sz * invLen;
      let h;
      if (hs === 0) {
        h = 0;
      } else if (useCubemap) {
        h = _samplePlanetMapCubemap(planetMap, ux, uy, uz);
      } else {
        h = _terrainFBM3D(ux, uy, uz, chunkNoise);
      }
      let rad;
      if (h <= seaLevel || hs === 0) {
        rad = r;
      } else {
        const above = (h - seaLevel) / Math.max(1e-6, 1 - seaLevel);
        rad = r + hs * above;
      }
      const baseCol = (hs !== 0) ? _planetColorForHeight(h, seaLevel) :
                                   [ux * 0.5 + 0.5, uy * 0.5 + 0.5, uz * 0.5 + 0.5];
      const nxn = ux;
      const nyn = uy / polRatio2;
      const nzn = uz;
      const ninv = 1 / Math.max(1e-12, Math.sqrt(nxn*nxn + nyn*nyn + nzn*nzn));
      const nuX = nxn * ninv, nuY = nyn * ninv, nuZ = nzn * ninv;
      const lambert = Math.max(ambient, nuX * sunX + nuY * sunY + nuZ * sunZ);
      const altitude = rad - r;
      const px = cxC + r * ux + altitude * ux;
      const py = cyC + r * uy * polRatio + altitude * uy;
      const pz = czC + r * uz + altitude * uz;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      verts[vWrite++] = px;
      verts[vWrite++] = py;
      verts[vWrite++] = pz;
      verts[vWrite++] = baseCol[0] * lambert;
      verts[vWrite++] = baseCol[1] * lambert;
      verts[vWrite++] = baseCol[2] * lambert;
      verts[vWrite++] = nuX; verts[vWrite++] = nuY; verts[vWrite++] = nuZ;
      verts[vWrite++] = fx01; verts[vWrite++] = fy01;
    }
  }
  for (let iy = 0; iy < segs; iy++) {
    for (let ix = 0; ix < segs; ix++) {
      const a = iy * N + ix;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      indices[iWrite++] = a; indices[iWrite++] = c; indices[iWrite++] = b;
      indices[iWrite++] = b; indices[iWrite++] = c; indices[iWrite++] = d;
    }
  }

  const vertexBuffer = Visual.device.createBuffer({
    label: "planet-vb-" + info.face + "-" + info.depth + "-" + info.ix + "-" + info.iy + "-" + segs,
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(verts);
  vertexBuffer.unmap();
  const indexBuffer = Visual.device.createBuffer({
    label: "planet-ib-" + info.face + "-" + info.depth + "-" + info.ix + "-" + info.iy + "-" + segs,
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(indexBuffer.getMappedRange()).set(indices);
  indexBuffer.unmap();

  return {
    vertexBuffer,
    indexBuffer,
    indexCount: iWrite,
    aabbMin: new Float32Array([minX, minY, minZ]),
    aabbMax: new Float32Array([maxX, maxY, maxZ]),
    face: info.face,
    depth: info.depth,
    ix: info.ix,
    iy: info.iy
  };
}

/* §planet-spec Phase 6b -- cache key for Planet GLOBAL geometry
 * params. When any of these change, every cached chunk is destroyed
 * and re-built fresh. Camera position is NOT in the key; chunk
 * visibility is managed by _ensurePlanetChunks via the visible-set
 * Map diff (chunks leaving the set get dropped, chunks entering get
 * built incrementally under a budget). */
function _planetGlobalCacheKey(node) {
  const p = node.params || {};
  return [
    p.radius, p.polarRadiusRatio,
    p.centerX, p.centerY, p.centerZ,
    p.segments, p.maxDepth, p.splitFactor,
    p.heightScale, p.seaLevel,
    p.seed, p.frequency, p.octaves, p.lacunarity, p.gain, p.ridges
  ].join(",");
}

/* §planet-spec Phase 6b -- streaming entry for Planet meshes.
 * Mirrors _ensureTiledTerrainChunks: per-chunk VBO+IBO+AABB stored in
 * a Map keyed by (face, depth, ix, iy). Each frame:
 *   1. Nuke everything if global geometry params changed.
 *   2. Compute the visible chunk set (quadtree split + horizon cull).
 *   3. Drop chunks no longer in the visible set (destroy GPU buffers).
 *   4. Two-phase incremental build under a time budget:
 *      - Phase 1: any visible chunk WITHOUT a cached entry gets a
 *        segs=2 placeholder (~9 verts, builds in <0.5ms). Guarantees
 *        every visible chunk has SOMETHING to draw within a frame or
 *        two of entering the visible set.
 *      - Phase 2: chunks whose currentLod < segs get upgraded. Old
 *        buffer destroyed only after the new one is in hand so the
 *        visible mesh never goes empty.
 * Returns the same {tiledChunks, aabbMin, aabbMax} shape the encoder
 * already understands -- the field name is "tiledChunks" purely for
 * encoder compatibility (the encoder doesn't care what produced it). */
function _ensurePlanetChunks(node) {
  if (!Visual.device) return null;
  if (!Visual.planetChunkCache) Visual.planetChunkCache = new Map();
  let entry = Visual.planetChunkCache.get(node.id);
  if (!entry) {
    entry = { chunks: new Map(), globalKey: null };
    Visual.planetChunkCache.set(node.id, entry);
  }

  // §planet-spec Phase 7.a -- look up any wired PlanetMap and include
  // its cubemap key in the global cache so a PlanetMap param change
  // invalidates every Planet chunk (the heights changed).
  const planetMap = _findPlanetMapForPlanet(node);
  const planetMapKey = planetMap
    ? ("pm:" + planetMap.resolution + ":" + planetMap.faces[0].length)
    : "pm0";
  // Also include the PlanetMap node's own cache key string if present
  // so editing the PlanetMap (Phase 7.d painter) rebuilds Planet chunks.
  let pmNodeKey = "";
  if (state && Array.isArray(state.edges)) {
    const edge = state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "heightmap"
    );
    if (edge && edge.from) {
      const src = state.nodes.find(n => n && n.id === edge.from.node);
      if (src && src.type === "PlanetMap") pmNodeKey = _planetMapCacheKey(src);
    }
  }
  const globalKey = _planetGlobalCacheKey(node) + "|" + planetMapKey + "|" + pmNodeKey;
  if (globalKey !== entry.globalKey) {
    for (const c of entry.chunks.values()) {
      try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
      try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
    }
    entry.chunks.clear();
    entry.globalKey = globalKey;
  }

  const p = node.params || {};
  const geom = _resolvePlanetGeom(p);
  const r = geom.r, hs = geom.hs, maxDepth = geom.maxDepth, splitFactor = geom.splitFactor, segs = geom.segs;
  const camPosWorld = _planetCameraPos(node);
  const camPos = {
    x: camPosWorld.x - geom.cxC,
    y: camPosWorld.y - geom.cyC,
    z: camPosWorld.z - geom.czC
  };
  const visList = _planetVisibleChunks(camPos, r, hs, maxDepth, splitFactor);
  // Keyed visible map for O(1) lookup + diff against cache.
  const visible = new Map();
  for (const v of visList) {
    visible.set(_planetChunkKey(v.face, v.depth, v.ix, v.iy), v);
  }

  // Drop chunks no longer visible.
  const keysToDrop = [];
  for (const key of entry.chunks.keys()) {
    if (!visible.has(key)) keysToDrop.push(key);
  }
  for (const key of keysToDrop) {
    const c = entry.chunks.get(key);
    try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
    try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
    entry.chunks.delete(key);
  }

  const sun = _planetSunDir();
  const ambient = 0.18;

  // Sort pending work closest-first so the near-camera chunks build
  // before the limb. Use chunk depth as a "closer is deeper" proxy.
  const phPending = [];
  for (const [key, info] of visible) {
    if (entry.chunks.has(key)) continue;
    phPending.push({ key, info });
  }
  phPending.sort((a, b) => b.info.depth - a.info.depth);
  const PH_BUDGET_MS = 8;
  const phStart = performance.now();
  for (let i = 0; i < phPending.length; i++) {
    const item = phPending[i];
    const ph = _buildSinglePlanetChunk(node, Object.assign({}, item.info, { segs: 2 }), camPos, sun, ambient, planetMap);
    if (ph) {
      ph.currentLod = 2;
      entry.chunks.set(item.key, ph);
    }
    if (performance.now() - phStart > PH_BUDGET_MS) break;
  }

  const upPending = [];
  for (const [key, info] of visible) {
    const c = entry.chunks.get(key);
    if (!c || c.currentLod === segs) continue;
    upPending.push({ key, info, c });
  }
  upPending.sort((a, b) => b.info.depth - a.info.depth);
  const UP_BUDGET_MS = 12;
  const upStart = performance.now();
  for (let i = 0; i < upPending.length; i++) {
    const item = upPending[i];
    const proper = _buildSinglePlanetChunk(node, Object.assign({}, item.info, { segs }), camPos, sun, ambient, planetMap);
    if (proper) {
      try { item.c.vertexBuffer && item.c.vertexBuffer.destroy(); } catch (_) {}
      try { item.c.indexBuffer  && item.c.indexBuffer.destroy();  } catch (_) {}
      proper.currentLod = segs;
      entry.chunks.set(item.key, proper);
    }
    if (performance.now() - upStart > UP_BUDGET_MS) break;
  }

  // Aggregate AABB for outer-frustum cull.
  let aabbMin, aabbMax;
  if (entry.chunks.size === 0) {
    aabbMin = new Float32Array([0, 0, 0]);
    aabbMax = new Float32Array([0, 0, 0]);
  } else {
    aabbMin = new Float32Array([Infinity, Infinity, Infinity]);
    aabbMax = new Float32Array([-Infinity, -Infinity, -Infinity]);
    for (const c of entry.chunks.values()) {
      if (c.aabbMin[0] < aabbMin[0]) aabbMin[0] = c.aabbMin[0];
      if (c.aabbMin[1] < aabbMin[1]) aabbMin[1] = c.aabbMin[1];
      if (c.aabbMin[2] < aabbMin[2]) aabbMin[2] = c.aabbMin[2];
      if (c.aabbMax[0] > aabbMax[0]) aabbMax[0] = c.aabbMax[0];
      if (c.aabbMax[1] > aabbMax[1]) aabbMax[1] = c.aabbMax[1];
      if (c.aabbMax[2] > aabbMax[2]) aabbMax[2] = c.aabbMax[2];
    }
  }
  const allChunks = [];
  for (const c of entry.chunks.values()) allChunks.push(c);
  return {
    tiledChunks: allChunks,
    vertexBuffer: null,
    indexBuffer: null,
    vertexCount: 0,
    indexCount: 0,
    aabbMin,
    aabbMax,
    cacheKey: "planet-streamed"
  };
}

/* §planet-spec Phase 6b -- legacy monolithic builder kept as a no-op
 * fallback. The streaming path (_ensurePlanetChunks) is the only
 * caller route now via _ensureMeshBuffers's type dispatch. If
 * something ever routes through _buildMeshData for a Planet node
 * (unexpected), return an empty mesh rather than crashing. */
function _buildPlanet(node) {
  return null;   // streaming path is the real route; _ensureMeshBuffers handles null safely
}

/* Sprint 9-2 -- PlanetMesh quadtree streaming. Mirrors the legacy
 * Planet path (_ensurePlanetChunks / _buildSinglePlanetChunk) but
 * sources elevation from the wired PlanetMap's cell graph instead
 * of runtime fbm. Same per-chunk VBO/IBO + visible-set Map + two-
 * phase placeholder/upgrade build + frustum cull machinery -- the
 * geometry plumbing is unchanged; only the height function differs.
 *
 * Per-frame: walk the cube-sphere quadtree from the camera; each
 * face root recurses, splitting when distance < chunkEdge * split-
 * Factor with horizon-occlusion culling. Visible chunks are built
 * lazily (segs=2 placeholder first, then upgraded to full segs
 * under a time budget). Chunks leaving the visible set get their
 * GPU buffers destroyed. */
function _resolvePlanetMeshGeom(p) {
  const polRatio = Math.max(0.5, Math.min(1.5, (typeof p.polarRadiusRatio === "number") ? p.polarRadiusRatio : 1.0));
  return {
    r:        (typeof p.radius   === "number") ? p.radius   : 1000,
    polRatio,
    polRatio2: polRatio * polRatio,
    cxC: (typeof p.centerX === "number") ? p.centerX : 0,
    cyC: (typeof p.centerY === "number") ? p.centerY : 0,
    czC: (typeof p.centerZ === "number") ? p.centerZ : 0,
    // Sprint 10-4 v9: floor relaxed back to original cap range.
    // v8 hard-floored at 64/20 to fix the user's old saved patch,
    // but the better fix was to update the demo itself (which now
    // sets segments=128 maxDepth=22 explicitly). Floor stays low
    // (2/0) so user-tuned-down patches still work for performance
    // reasons.
    segs:        Math.max(2, Math.min(128, Math.floor((typeof p.segments === "number") ? p.segments : 96))),
    maxDepth:    Math.max(0, Math.min(24, Math.floor((typeof p.maxDepth    === "number") ? p.maxDepth    : 22))),
    splitFactor: Math.max(0.1, Math.min(50, (typeof p.splitFactor === "number") ? p.splitFactor : 5.0)),
    hs:       (typeof p.heightScale === "number") ? p.heightScale : 0,
    seaLevel: Math.max(0, Math.min(1, (typeof p.seaLevel === "number") ? p.seaLevel : 0.5))
  };
}

function _planetMeshGlobalCacheKey(node) {
  const p = node.params || {};
  return [
    p.radius, p.polarRadiusRatio,
    p.centerX, p.centerY, p.centerZ,
    p.segments, p.maxDepth, p.splitFactor,
    p.heightScale, p.seaLevel
  ].join(",");
}

function _buildSinglePlanetMeshChunk(node, info, camPos, sun, ambient, pmap, cells) {
  if (!Visual.device) return null;
  const p = node.params || {};
  const geom = _resolvePlanetMeshGeom(p);
  const r = geom.r, polRatio = geom.polRatio, polRatio2 = geom.polRatio2;
  const cxC = geom.cxC, cyC = geom.cyC, czC = geom.czC;
  const hs = geom.hs, seaLevel = geom.seaLevel;
  const segs = info.segs;
  const sunX = sun[0], sunY = sun[1], sunZ = sun[2];

  // Sprint 10-1: ensure the baked heightmap cubemap exists. This is
  // a once-per-PlanetMap operation (key-cached); subsequent chunks
  // reuse the already-baked faces. Sprint 10-2 added an erosion
  // pass that modifies these faces in-place + populates pmap._drainage
  // (parallel cubemap of cumulative water flux per texel). The chunk
  // builder samples both: heightmap for elevation, drainage for
  // river tinting along carved channels.
  const _planetCubemap = pmap ? _ensurePlanetMapCubemap(pmap) : null;
  const _planetDrainage = (pmap && pmap._drainage) || null;
  // Sprint 10-5a-fix v3: Azgaar / paint color path RIPPED OUT.
  // Always render Earth-mode color (latitude + elevation LUT).
  // The cell-graph IDW branch below the `if (_planetIsEarth)` is
  // dead code; will be deleted once Earth is confirmed visible.
  const _planetIsEarth = true;
  // Sprint 10-6: trigger high-res tile fetches for this chunk's area
  // ONCE per build (not per vertex). Tiles arrive async, bump the
  // global _EARTH_TILES.loadCount, which is in the chunk cache key
  // -- so chunks rebuild and pick up the new detail on subsequent
  // frames. Depth-aware zoom: deeper chunks fetch finer tiles.
  if (_planetIsEarth && info.depth > 5) {
    _ensureHighResTilesForChunk(info, _depthToZoom(info.depth));
  }

  const face = _PLANET_FACES[info.face];
  const nX = face.n[0], nY = face.n[1], nZ = face.n[2];
  const tX = face.t[0], tY = face.t[1], tZ = face.t[2];
  const bX = face.b[0], bY = face.b[1], bZ = face.b[2];

  // Per-cell biome / river / lake coloring -- same recipe as the
  // legacy single-mesh path so the planet looks identical from
  // orbit, just chunked toward the camera now.
  const RIVER_BLUE = [0.20, 0.45, 0.75];
  const RIVER_BIG  = [0.15, 0.32, 0.62];
  const colorForCell = function(idx, elev) {
    if (cells.lake && cells.lake[idx]) return PLANET_BIOMES_COLORS[0];
    if (cells.riverId && cells.riverId[idx] >= 0 && cells.flux && elev >= seaLevel) {
      const flx = cells.flux[idx];
      const t = Math.min(1, Math.max(0, (flx - 30) / 200));
      return [
        RIVER_BLUE[0] + (RIVER_BIG[0] - RIVER_BLUE[0]) * t,
        RIVER_BLUE[1] + (RIVER_BIG[1] - RIVER_BLUE[1]) * t,
        RIVER_BLUE[2] + (RIVER_BIG[2] - RIVER_BLUE[2]) * t
      ];
    }
    if (cells.biome) return PLANET_BIOMES_COLORS[cells.biome[idx]];
    return _planetColorForHeight(elev, seaLevel);
  };
  const biomeForCell = function(idx, elev) {
    if (cells.lake && cells.lake[idx]) return 0;
    if (cells.riverId && cells.riverId[idx] >= 0 && cells.flux && elev >= seaLevel) return 0;
    if (cells.biome) return cells.biome[idx];
    return 0;
  };

  const N = segs + 1;
  // Sprint 9-2c: extended 14-float layout with per-vertex lowPos.xyz
  // for Strugar CDLOD vertex morphing. Per-chunk split distance
  // (`morphLow`) packed into uv.y so the vertex shader has it
  // without per-chunk uniforms. The morph closes LOD boundaries
  // at exactly the moment the parent takes over -- skirts (9-2b)
  // stay as belt-and-suspenders for the rare visual edge cases
  // (camera grazing a LOD seam from extreme angles, mid-morph
  // float-precision drift).
  //
  // Per-chunk morphLow = chunkEdge * splitFactor (= this chunk's
  // own split distance). The parent's split distance is exactly
  // 2*morphLow, giving morph delta = morphLow.
  const chunkEdgeM = (info.uMax - info.uMin) * r * (Math.PI * 0.25);
  const morphLow = chunkEdgeM * geom.splitFactor;
  // Sprint 9-6: per-chunk hash offset for the detail noise. Two
  // chunks of the same biome at different planet locations now get
  // different noise patterns -- breaks the "same desert shape on
  // the other side of the planet" failure mode at zero per-vertex
  // cost (one hash, used as a constant offset to every noise call
  // in this chunk).
  const _chunkOffset = _planetChunkNoiseOffset(info.face, info.depth, info.ix, info.iy);
  // Sprint 9-2b: skirts. 1-vert-thick ring around the 4 edges,
  // projected radially inward to the bare spheroid surface.
  const SKIRT_VERT_COUNT = 4 * (N - 1);
  const totalVerts = N * N + SKIRT_VERT_COUNT;
  const SKIRT_INDEX_COUNT = 4 * segs * 6;
  const totalIndices = segs * segs * 6 + SKIRT_INDEX_COUNT;
  // 14 floats per vertex: pos.xyz (3) + color.rgb (3) + normal.xyz (3)
  // + uv.xy (2: biomeId, morphLow) + lowPos.xyz (3) = 14.
  const verts = new Float32Array(totalVerts * 14);
  const indices = new Uint32Array(totalIndices);
  let vWrite = 0, iWrite = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // Per-vertex direction + position scratch for skirt construction
  // AND for lowPos bilinear interp. Keeping a second pass lets us
  // write the final VBO with lowPos already known per vertex.
  const edgeDirs = new Float32Array(N * N * 3);
  const edgeAlt  = new Float32Array(N * N);
  const edgeCol  = new Float32Array(N * N * 3);
  const edgeBId  = new Float32Array(N * N);
  const edgeNrm  = new Float32Array(N * N * 3);
  // High positions: needed to compute lowPos as bilinear interp of
  // even-grid neighbors (the parent grid's vertex set is exactly
  // this chunk's verts at even (gx, gy); odd-positioned verts
  // morph toward the interpolation of their parent-grid
  // neighbors).
  const highPosX = new Float32Array(N * N);
  const highPosY = new Float32Array(N * N);
  const highPosZ = new Float32Array(N * N);

  // Pass 1: compute high positions + per-vertex shading data.
  // (No VBO writes yet -- we need to know neighbor highPos values
  // to compute lowPos via bilinear interp before writing.)
  for (let iy = 0; iy <= segs; iy++) {
    const fy01 = iy / segs;
    const v = info.vMin + (info.vMax - info.vMin) * fy01;
    for (let ix = 0; ix <= segs; ix++) {
      const fx01 = ix / segs;
      const u = info.uMin + (info.uMax - info.uMin) * fx01;
      const cx = nX + tX * u + bX * v;
      const cy = nY + tY * u + bY * v;
      const cz = nZ + tZ * u + bZ * v;
      const cxx = cx * cx, cyy = cy * cy, czz = cz * cz;
      const sx = cx * Math.sqrt(Math.max(0, 1 - cyy * 0.5 - czz * 0.5 + cyy * czz / 3));
      const sy = cy * Math.sqrt(Math.max(0, 1 - cxx * 0.5 - czz * 0.5 + cxx * czz / 3));
      const sz = cz * Math.sqrt(Math.max(0, 1 - cxx * 0.5 - cyy * 0.5 + cxx * cyy / 3));
      const invLen = 1 / Math.max(1e-12, Math.sqrt(sx*sx + sy*sy + sz*sz));
      const ux = sx * invLen, uy = sy * invLen, uz = sz * invLen;
      // Sprint 10-1: route elevation through the baked cubemap
      // instead of per-vertex K=3 IDW cell scan. _ensurePlanetMap-
      // Cubemap (called once outside the loop) bakes the cell
      // graph at the PlanetMap node's resolution (default 256² /
      // face, bumped to 1024² in Phase 10), applying the SAME K=3
      // IDW kernel that 9-4 had per-vertex -- moves the smoothing
      // cost from per-frame chunk build to one-time bake. Bilinear
      // sample is 4 texel reads + 3 lerps vs ~30 dot products,
      // ~5x faster per vertex. Sets up 10-2 (hydraulic erosion
      // runs on this same cubemap) and 10-3 (continuous climate
      // fields are derived from the eroded cubemap).
      // Sprint 10-1d: per-vertex detail-noise displacement REMOVED.
      // Was producing the uniformly-speckled noise pattern visible
      // at both orbit + ground in playtest. The full Phase 10 plan
      // puts noise BACK in 10-4 as amplification gated by slope +
      // drainage from 10-2's hydraulic erosion, not as unconditional
      // displacement on top of macro. Until then the chunk altitude
      // is JUST the cubemap-baked macro elevation (10-1a/b output
      // with ridge enhancement), and the surface reads as flat-
      // shaded sphere with macro continents and ridge mountains.
      // That's the correct intermediate state -- erosion (10-2)
      // carves rivers into this, climate (10-3) drives biome color,
      // and amplification (10-4) adds detail noise back ONLY where
      // it makes physical sense (mountain flanks, dunes, river
      // banks).
      // Sprint 10-5a-fix v3: cells may be null in Earth mode. Elevation
      // always comes from the cubemap; cellIdx is only consumed by the
      // (dead) custom color path below. Skip the lookup when no cells.
      const cellIdx = cells ? _findNearestCell(cells, pmap._cellsHash, ux, uy, uz) : -1;
      // Sprint 10-6: per-vertex sample uses best-cached high-res tile
      // (via _planetSampleElevationCached) and falls back to the macro
      // cubemap when nothing closer is cached. Fetch trigger for this
      // chunk's tiles happens ONCE outside the loop (see below) -- per
      // vertex we never block on the network.
      const elev = _planetCubemap
        ? _planetSampleElevationCached(_planetCubemap, ux, uy, uz)
        : (cells ? _samplePlanetCellsIDW(cells, pmap._cellsHash, ux, uy, uz) : 0);
      let altitude = 0;
      if (elev > seaLevel && hs !== 0) {
        altitude = hs * (elev - seaLevel) / Math.max(1e-6, 1 - seaLevel);
      }
      // Sprint 10-4 v3: biome-aware amplification + drainage gating.
      //
      // Builds on v2's 80m-base ridged fbm with two physical gates:
      //   (a) biome -- noise PROFILE varies by climate.
      //       Deserts get sharper ridges (dune crests / wind-cut rock).
      //       Forests get smoother, lower amp (organic terrain).
      //       Mountains get rocky/cliff-like regardless of biome.
      //   (b) drainage -- chunks near 10-2 river channels get REDUCED
      //       amplification (preserves the carved valley silhouette
      //       instead of bumping noise into the water path).
      if (info.depth >= 10 && elev > seaLevel && _planetIsEarth) {
        const landH = (elev - seaLevel) / Math.max(0.001, 1 - seaLevel);

        // Climate lookup -- match the per-vertex coloring path.
        const _ampLatDeg = Math.asin(Math.max(-1, Math.min(1, uy))) * 180 / Math.PI;
        const _ampClimate = _earthClimateAt(_ampLatDeg, elev, seaLevel);
        const _ampT = _ampClimate.T, _ampP = _ampClimate.P;

        // Biome-driven noise profile.
        let ridges = 0.55;
        let ampM = 30;
        let freqMul = 1.0;
        if (_ampClimate.elevMSL > 2000) {
          // High mountains: rocky, sharp ridges, taller amp regardless
          // of biome below (snow-line transitions in color, but the
          // terrain stays craggy).
          ridges = 0.75;
          ampM = 50;
          freqMul = 1.0;
        } else if (_ampT > 18 && _ampP < 0.3) {
          // Hot + dry desert: dune crests. Anisotropy is hard to fake
          // with isotropic fbm, but high ridges + medium amp at higher
          // freq reads as crinkly sand-rock surfaces.
          ridges = 0.7;
          ampM = 22;
          freqMul = 1.3;
        } else if (_ampT > 0 && _ampP > 0.6) {
          // Temperate/tropical wet forest: smooth, low-amp, organic.
          // Bumps read as 'rolling hills under canopy' not 'rocks'.
          ridges = 0.15;
          ampM = 12;
          freqMul = 0.7;
        } else if (_ampT < -5) {
          // Tundra / polar: smooth, minimal amp (wind + ice scour
          // leaves a flat-ish surface).
          ridges = 0.25;
          ampM = 8;
          freqMul = 0.8;
        }
        // Default: grassland / steppe / mixed -- v2 defaults retained.

        const noiseDef = {
          frequency: (1 / 80) * freqMul,
          octaves: Math.min(8, Math.max(3, info.depth - 7)),
          lacunarity: 2.0,
          gain: 0.5,
          ridges: ridges,
          seed: 17.3
        };
        const n = _terrainFBM3D(
          r * ux + cxC,
          r * uy + cyC,
          r * uz + czC,
          noiseDef
        );

        // Drainage gate: reduce amp where water flux is high. 10-2
        // already carved the macro elevation along these paths; we
        // don't want noise to re-fill the carved channels.
        let drainageGate = 1.0;
        if (_planetDrainage) {
          const flux = _samplePlanetMapCubemap(_planetDrainage, ux, uy, uz);
          // smoothstep over 50..400 flux (same range chunk color uses
          // for river tinting -- consistent gate threshold).
          const riverAmt = Math.max(0, Math.min(1, (flux - 50) / 350));
          drainageGate = 1.0 - riverAmt * 0.85;  // 15% noise even on rivers
        }

        altitude += (n - 0.5) * 2 * ampM * landH * drainageGate;
      }
      // Sprint 9-3: VBO holds vertices RELATIVE to the planet's
      // center (anchorF64). The per-frame mv_rtc model matrix
      // re-adds the anchor in f64-composed view space so the GPU
      // never sees the absolute world coordinate at Earth radius.
      // For frustum culling the AABB still needs to be in WORLD
      // coords (the cam frustum planes are world-space), so the
      // AABB tracking adds the center back below.
      const px = r * ux           + altitude * ux;
      const py = r * uy * polRatio + altitude * uy;
      const pz = r * uz           + altitude * uz;
      // Sprint 10-5a-fix: in Earth mode, color comes from elevation
      // + latitude directly (climate-band LUT) -- no cell-graph
      // biome reads, no per-cell hash tint, no quilt overlay. The
      // K=3 IDW blend path below stays for source="custom"
      // (hand-painted) maps where the user IS authoring per-cell
      // biome.
      let blendR, blendG, blendB;
      if (_planetIsEarth) {
        // Unit-sphere direction → lat/lon for the climate lookup.
        // (ux/uy/uz already computed above for the cubemap sample.)
        const _latDeg = Math.asin(Math.max(-1, Math.min(1, uy))) * 180 / Math.PI;
        const _lonDeg = -Math.atan2(uz, ux) * 180 / Math.PI;  // east-west flip (see 10-6 v6)
        const _earthCol = _earthSurfaceColorAt(_latDeg, _lonDeg, elev, seaLevel);
        blendR = _earthCol[0];
        blendG = _earthCol[1];
        blendB = _earthCol[2];
      } else {
        // Custom-source path: K=3 IDW cell-color blend + per-cell tint.
        const _idw = _samplePlanetCellsK3(cells, pmap._cellsHash, ux, uy, uz);
        const c0 = (_idw.i0 >= 0) ? colorForCell(_idw.i0, cells.elevations[_idw.i0]) : _planetColorForHeight(elev, seaLevel);
        const c1 = (_idw.i1 >= 0) ? colorForCell(_idw.i1, cells.elevations[_idw.i1]) : c0;
        const c2 = (_idw.i2 >= 0) ? colorForCell(_idw.i2, cells.elevations[_idw.i2]) : c0;
        blendR = (_idw.w0 * c0[0] + _idw.w1 * c1[0] + _idw.w2 * c2[0]) / _idw.wSum;
        blendG = (_idw.w0 * c0[1] + _idw.w1 * c1[1] + _idw.w2 * c2[1]) / _idw.wSum;
        blendB = (_idw.w0 * c0[2] + _idw.w1 * c1[2] + _idw.w2 * c2[2]) / _idw.wSum;
        // Per-cell hash micro-tint (custom mode only).
        if (_idw.i0 >= 0) {
          const _ti = _idw.i0;
          const tintR = (Math.sin(_ti * 12.9898) * 0.5 + 0.5 - 0.5) * 0.10;
          const tintG = (Math.sin(_ti * 78.233) * 0.5 + 0.5 - 0.5) * 0.10;
          const tintB = (Math.sin(_ti * 4.1414) * 0.5 + 0.5 - 0.5) * 0.10;
          blendR = blendR * (1 + tintR);
          blendG = blendG * (1 + tintG);
          blendB = blendB * (1 + tintB);
        }
      }
      // Sprint 10-1d: color breakup noise REMOVED along with the
      // noise terrain displacement. Per-cell hash tint above gives
      // enough adjacent-cell variation without overlaying value
      // noise. Phase 10 climate field (10-3) is the proper way to
      // get smooth color variation -- temperature + moisture +
      // slope drive color directly, not random noise modulation.
      //
      // Sprint 10-2: river tint from drainage cubemap. _ensure-
      // PlanetMapCubemap populated pmap._drainage with cumulative
      // water-flux per texel; high-flux cells = river channels.
      // Sample with the same cubemap projection used for elevation;
      // smoothly tint toward river-blue where flux passes threshold.
      // Only tints land cells (elev > seaLevel) so ocean isn't
      // double-coloured.
      if (_planetDrainage && elev > seaLevel) {
        const flux = _samplePlanetMapCubemap(_planetDrainage, ux, uy, uz);
        // smoothstep across 50..400 flux: subtle creek at 50,
        // big river by 400. Capped at 0.85 so river color blends
        // with the biome behind it (not pure blue) -- looks like
        // a river through forest, not a blue line.
        const riverAmt = Math.max(0, Math.min(0.85, (flux - 50) / 350));
        if (riverAmt > 0) {
          const _riverR = 0.18, _riverG = 0.38, _riverB = 0.62;
          blendR = blendR + (_riverR - blendR) * riverAmt;
          blendG = blendG + (_riverG - blendG) * riverAmt;
          blendB = blendB + (_riverB - blendB) * riverAmt;
        }
      }
      const baseCol = [blendR, blendG, blendB];
      // Sprint 10-5b-fix: biomeId drives fs_unlit_vc's marine-vs-land
      // branch (bId==0 = water Fresnel-Schlick reflection of sky -->
      // EVERYTHING renders blue if biomeId is always 0). With cells=null
      // we previously defaulted biomeId = 0, which made the chunk renderer
      // treat the entire planet as water -- the actual root cause of
      // "minimap shows continents but 3D is a blue sphere." In Earth
      // mode, derive biomeId from elevation directly: above seaLevel is
      // land (1), below is marine (0). Same threshold the Earth color
      // LUT uses.
      let biomeId;
      if (cellIdx >= 0) {
        biomeId = biomeForCell(cellIdx, elev);
      } else if (_planetIsEarth) {
        biomeId = (elev > seaLevel) ? 1 : 0;
      } else {
        biomeId = 0;
      }
      // Smooth oblate-spheroid radial; used as a fallback for
      // degenerate triangles in the face-normal pass below.
      const nxn = ux;
      const nyn = uy / polRatio2;
      const nzn = uz;
      const ninv = 1 / Math.max(1e-12, Math.sqrt(nxn*nxn + nyn*nyn + nzn*nzn));
      const nuX = nxn * ninv, nuY = nyn * ninv, nuZ = nzn * ninv;

      // World-space AABB for frustum cull (add the anchor back).
      const wpx = px + cxC, wpy = py + cyC, wpz = pz + czC;
      if (wpx < minX) minX = wpx; if (wpx > maxX) maxX = wpx;
      if (wpy < minY) minY = wpy; if (wpy > maxY) maxY = wpy;
      if (wpz < minZ) minZ = wpz; if (wpz > maxZ) maxZ = wpz;

      const gi = iy * N + ix;
      highPosX[gi] = px;
      highPosY[gi] = py;
      highPosZ[gi] = pz;
      edgeDirs[gi*3+0] = ux; edgeDirs[gi*3+1] = uy; edgeDirs[gi*3+2] = uz;
      edgeAlt[gi] = altitude;
      // Sprint 9-4-fix: store BASE color (no lambert). Lambert is
      // re-applied in pass 2 below using the face-normal-accumulated
      // shading normal, so ridges/valleys catch sun.
      edgeCol[gi*3+0] = baseCol[0];
      edgeCol[gi*3+1] = baseCol[1];
      edgeCol[gi*3+2] = baseCol[2];
      edgeBId[gi] = biomeId;
      edgeNrm[gi*3+0] = nuX; edgeNrm[gi*3+1] = nuY; edgeNrm[gi*3+2] = nuZ;
    }
  }

  // Sprint 9-4-fix Pass 1.5: face-normal accumulation. The radial
  // normal stored in edgeNrm gives smooth-sphere shading even when
  // the surface has bumps from detail noise. Override it with the
  // area-weighted face normal so geometry actually reads as 3D.
  // Skirt verts (built below) inherit edgeNrm from their ring
  // vertex, so they pick up the terrain normal automatically.
  const accumNX = new Float32Array(N * N);
  const accumNY = new Float32Array(N * N);
  const accumNZ = new Float32Array(N * N);
  for (let jy = 0; jy < segs; jy++) {
    for (let jx = 0; jx < segs; jx++) {
      const a = jy * N + jx;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      // Cross-product gives one face-normal per triangle. Sign is
      // checked + flipped per-vertex at normalization time so
      // backface-culling-off winding doesn't matter.
      const e1x = highPosX[b] - highPosX[a], e1y = highPosY[b] - highPosY[a], e1z = highPosZ[b] - highPosZ[a];
      const e2x = highPosX[c] - highPosX[a], e2y = highPosY[c] - highPosY[a], e2z = highPosZ[c] - highPosZ[a];
      let fnx = e1y*e2z - e1z*e2y;
      let fny = e1z*e2x - e1x*e2z;
      let fnz = e1x*e2y - e1y*e2x;
      accumNX[a] += fnx; accumNY[a] += fny; accumNZ[a] += fnz;
      accumNX[b] += fnx; accumNY[b] += fny; accumNZ[b] += fnz;
      accumNX[c] += fnx; accumNY[c] += fny; accumNZ[c] += fnz;
      const e3x = highPosX[d] - highPosX[b], e3y = highPosY[d] - highPosY[b], e3z = highPosZ[d] - highPosZ[b];
      const e4x = highPosX[c] - highPosX[b], e4y = highPosY[c] - highPosY[b], e4z = highPosZ[c] - highPosZ[b];
      fnx = e3y*e4z - e3z*e4y;
      fny = e3z*e4x - e3x*e4z;
      fnz = e3x*e4y - e3y*e4x;
      accumNX[b] += fnx; accumNY[b] += fny; accumNZ[b] += fnz;
      accumNX[c] += fnx; accumNY[c] += fny; accumNZ[c] += fnz;
      accumNX[d] += fnx; accumNY[d] += fny; accumNZ[d] += fnz;
    }
  }
  for (let i = 0; i < N * N; i++) {
    const ax = accumNX[i], ay = accumNY[i], az = accumNZ[i];
    const len = Math.hypot(ax, ay, az);
    if (len > 1e-9) {
      let nx = ax / len, ny = ay / len, nz = az / len;
      // Outward-orientation check via the unit-sphere radial
      // (chunk verts are always on the outside of the sphere so
      // radial dot > 0 means outward).
      const rdot = nx * edgeDirs[i*3+0] + ny * edgeDirs[i*3+1] + nz * edgeDirs[i*3+2];
      if (rdot < 0) { nx = -nx; ny = -ny; nz = -nz; }
      edgeNrm[i*3+0] = nx;
      edgeNrm[i*3+1] = ny;
      edgeNrm[i*3+2] = nz;
    }
    // else: keep the radial fallback from pass 1.
  }

  // Pass 2: write interior verts. lowPos comes from bilinear interp
  // of even-grid neighbors. Even-indexed verts (parent-grid) have
  // lowPos == highPos (no morph). Odd verts interpolate between
  // their parent-grid neighbors so the morph end (morph=1) snaps
  // exactly to the parent's emulated grid.
  vWrite = 0;
  for (let iy = 0; iy <= segs; iy++) {
    for (let ix = 0; ix <= segs; ix++) {
      const gi = iy * N + ix;
      // Compute lowPos.
      const xOdd = (ix & 1) === 1;
      const yOdd = (iy & 1) === 1;
      let lpX, lpY, lpZ;
      if (!xOdd && !yOdd) {
        lpX = highPosX[gi]; lpY = highPosY[gi]; lpZ = highPosZ[gi];
      } else if (xOdd && !yOdd) {
        const a = iy * N + (ix - 1);
        const b = iy * N + (ix + 1);
        lpX = 0.5 * (highPosX[a] + highPosX[b]);
        lpY = 0.5 * (highPosY[a] + highPosY[b]);
        lpZ = 0.5 * (highPosZ[a] + highPosZ[b]);
      } else if (!xOdd && yOdd) {
        const a = (iy - 1) * N + ix;
        const b = (iy + 1) * N + ix;
        lpX = 0.5 * (highPosX[a] + highPosX[b]);
        lpY = 0.5 * (highPosY[a] + highPosY[b]);
        lpZ = 0.5 * (highPosZ[a] + highPosZ[b]);
      } else {
        // Both odd: lerp 4 even-grid corners.
        const a = (iy - 1) * N + (ix - 1);
        const b = (iy - 1) * N + (ix + 1);
        const c = (iy + 1) * N + (ix - 1);
        const d = (iy + 1) * N + (ix + 1);
        lpX = 0.25 * (highPosX[a] + highPosX[b] + highPosX[c] + highPosX[d]);
        lpY = 0.25 * (highPosY[a] + highPosY[b] + highPosY[c] + highPosY[d]);
        lpZ = 0.25 * (highPosZ[a] + highPosZ[b] + highPosZ[c] + highPosZ[d]);
      }
      // Sprint 9-4-fix: lambert per vertex with the face-normal-
      // accumulated terrain normal. Now ridges catch sun + valleys
      // shadow, instead of the old uniform radial-normal shading.
      const nx = edgeNrm[gi*3+0], ny = edgeNrm[gi*3+1], nz = edgeNrm[gi*3+2];
      const lambert = Math.max(ambient, nx * sunX + ny * sunY + nz * sunZ);
      // Sprint 9-6 / 10-1c: slope-modulated color (Outerra trick).
      // Where face normal diverges from radial, blend biome toward
      // rock-grey so cliffs / mountain sides read as rock. 10-1c
      // tightened the threshold from "rock at 32° slope" to "rock
      // only above 53° slope" so noise-induced micro-slopes
      // don't trigger the rock blend on every triangle (which
      // produced the "lava between mountains" reads in playtest).
      // Rock color also lightened (0.45/0.42/0.38 → 0.55/0.50/
      // 0.45) so the cliff color reads as light-rock-grey instead
      // of dark-brown / lava.
      const radX = edgeDirs[gi*3+0], radY = edgeDirs[gi*3+1], radZ = edgeDirs[gi*3+2];
      const slopeCos = nx * radX + ny * radY + nz * radZ;
      const slopeAmt = 1 - Math.max(0, Math.min(1, (slopeCos - 0.30) / 0.30));
      const rockR = 0.55, rockG = 0.50, rockB = 0.45;
      const slopedR = edgeCol[gi*3+0] + (rockR - edgeCol[gi*3+0]) * slopeAmt;
      const slopedG = edgeCol[gi*3+1] + (rockG - edgeCol[gi*3+1]) * slopeAmt;
      const slopedB = edgeCol[gi*3+2] + (rockB - edgeCol[gi*3+2]) * slopeAmt;
      verts[vWrite++] = highPosX[gi];
      verts[vWrite++] = highPosY[gi];
      verts[vWrite++] = highPosZ[gi];
      verts[vWrite++] = slopedR * lambert;
      verts[vWrite++] = slopedG * lambert;
      verts[vWrite++] = slopedB * lambert;
      verts[vWrite++] = nx;
      verts[vWrite++] = ny;
      verts[vWrite++] = nz;
      verts[vWrite++] = edgeBId[gi];
      verts[vWrite++] = morphLow;       // uv.y -- per-vertex copy
      verts[vWrite++] = lpX;
      verts[vWrite++] = lpY;
      verts[vWrite++] = lpZ;
    }
  }
  // Interior triangulation (unchanged).
  for (let iy = 0; iy < segs; iy++) {
    for (let ix = 0; ix < segs; ix++) {
      const a = iy * N + ix;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      indices[iWrite++] = a; indices[iWrite++] = c; indices[iWrite++] = b;
      indices[iWrite++] = b; indices[iWrite++] = c; indices[iWrite++] = d;
    }
  }

  // Sprint 9-2b: skirt construction. Walk the ring of edge verts in
  // four passes (top edge L->R, right edge T->B, bottom R->L, left
  // B->T) and emit one skirt vertex per ring step. Skirt index is
  // (N*N) + ringOrder; the index map below remembers which grid
  // vertex each skirt vert sits below so triangulation can connect
  // them. The radial inward shift uses the SAME (ux, uy, uz)
  // direction as the edge vert but with altitude = 0 -- guarantees
  // the skirt sits below the edge along the oblate-spheroid normal,
  // even at non-equator latitudes.
  const skirtVertOf = new Int32Array(N * N);  // grid -> skirt index, -1 = no skirt
  for (let i = 0; i < N * N; i++) skirtVertOf[i] = -1;
  const skirtBase = N * N;
  let skirtIdx = skirtBase;
  function emitSkirt(gi) {
    if (skirtVertOf[gi] >= 0) return skirtVertOf[gi];
    const ux = edgeDirs[gi*3+0], uy = edgeDirs[gi*3+1], uz = edgeDirs[gi*3+2];
    // Sprint 10-5b-fix: skirt drop now covers the full heightScale so
    // chunks with mountain peaks (up to ~hs altitude) don't expose gaps
    // to neighbor chunks at sea level. Old constant r*0.0005 = ~3km on
    // Earth was way too short for 20-80 km mountain peaks -- produced
    // the rectangular "holes" the user saw between high and low chunks.
    // 1.5x hs gives a safety margin for adjacent-chunk-altitude deltas.
    // Falls back to radial 0.05% for hs=0 (custom flat-planet patches).
    const skirtDrop = (hs > 0) ? -(hs * 1.5) : -(r * 0.0005);
    // Sprint 9-3: skirt position planet-center-relative too.
    const px = (r + skirtDrop) * ux;
    const py = (r + skirtDrop) * uy * polRatio;
    const pz = (r + skirtDrop) * uz;
    // 14-float vertex (CDLOD layout). morphLow = 0 disables morph
    // on skirt verts (they're spheroid-anchored, no parent geometry
    // to morph toward); lowPos = highPos for same reason.
    // Sprint 9-4-fix: bake lambert into the skirt color too,
    // matching the per-vertex shading now used for interior verts.
    // edgeCol is base color (no lambert) per the pass-1 change;
    // skirt's lambert uses its ring vertex's accumulated normal.
    const skNx = edgeNrm[gi*3+0], skNy = edgeNrm[gi*3+1], skNz = edgeNrm[gi*3+2];
    const skLambert = Math.max(ambient, skNx * sunX + skNy * sunY + skNz * sunZ);
    verts[vWrite++] = px;
    verts[vWrite++] = py;
    verts[vWrite++] = pz;
    verts[vWrite++] = edgeCol[gi*3+0] * skLambert;
    verts[vWrite++] = edgeCol[gi*3+1] * skLambert;
    verts[vWrite++] = edgeCol[gi*3+2] * skLambert;
    verts[vWrite++] = skNx;
    verts[vWrite++] = skNy;
    verts[vWrite++] = skNz;
    verts[vWrite++] = edgeBId[gi];
    verts[vWrite++] = 0;        // morphLow = 0 -> skirt never morphs
    verts[vWrite++] = px;       // lowPos = highPos for skirts
    verts[vWrite++] = py;
    verts[vWrite++] = pz;
    // World-space AABB tracking for skirt verts.
    const wpx = px + cxC, wpy = py + cyC, wpz = pz + czC;
    if (wpx < minX) minX = wpx; if (wpx > maxX) maxX = wpx;
    if (wpy < minY) minY = wpy; if (wpy > maxY) maxY = wpy;
    if (wpz < minZ) minZ = wpz; if (wpz > maxZ) maxZ = wpz;
    skirtVertOf[gi] = skirtIdx;
    return skirtIdx++;
  }
  function skirtEdge(getGi) {
    // getGi(t) returns the grid index of the t-th vert along this
    // edge (t = 0..segs). We emit skirts for both endpoints, then
    // bridge each consecutive pair (t, t+1) with two triangles
    // wound so the skirt faces outward (back-face cull would drop
    // it if we got this wrong).
    for (let t = 0; t < segs; t++) {
      const giA = getGi(t),     giB = getGi(t + 1);
      const skA = emitSkirt(giA), skB = emitSkirt(giB);
      // Quad (giA, giB, skB, skA). Triangulated CCW from outside:
      // pick the winding that matches the interior tris next to it.
      indices[iWrite++] = giA; indices[iWrite++] = skA; indices[iWrite++] = giB;
      indices[iWrite++] = giB; indices[iWrite++] = skA; indices[iWrite++] = skB;
    }
  }
  skirtEdge(t => 0 * N + t);                  // top edge (iy = 0)
  skirtEdge(t => t * N + segs);               // right edge (ix = segs)
  skirtEdge(t => segs * N + (segs - t));      // bottom edge (iy = segs), reversed
  skirtEdge(t => (segs - t) * N + 0);         // left edge (ix = 0), reversed

  const vertexBuffer = Visual.device.createBuffer({
    label: "planetmesh-vb-" + info.face + "-" + info.depth + "-" + info.ix + "-" + info.iy + "-" + segs,
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(verts);
  vertexBuffer.unmap();
  const indexBuffer = Visual.device.createBuffer({
    label: "planetmesh-ib-" + info.face + "-" + info.depth + "-" + info.ix + "-" + info.iy + "-" + segs,
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(indexBuffer.getMappedRange()).set(indices);
  indexBuffer.unmap();

  // Sprint 10-6 v2: per-chunk lat/lon bounds for selective tile
  // invalidation. We sample the 4 corners + center of the chunk in
  // cube coords, project to unit sphere, convert to (lat, lon), and
  // compute an AABB. When a high-res tile loads, _invalidateChunks-
  // ForTile checks this AABB to decide whether this chunk needs
  // rebuilding (vs blowing away every chunk on the planet).
  // For chunks near the pole or crossing the antimeridian, the bounds
  // become coarse (extreme polar chunks fall back to "always invalidate"
  // via a flag) -- acceptable for MVP, polar terrain is sparse anyway.
  const _latLonBounds = (function() {
    const face = _PLANET_FACES[info.face];
    const samples = [
      [info.uMin, info.vMin], [info.uMax, info.vMin],
      [info.uMin, info.vMax], [info.uMax, info.vMax],
      [(info.uMin + info.uMax) * 0.5, (info.vMin + info.vMax) * 0.5]
    ];
    const lats = [], lons = [];
    let nearPole = false;
    for (let i = 0; i < samples.length; i++) {
      const u = samples[i][0], v = samples[i][1];
      const cx = face.n[0] + face.t[0]*u + face.b[0]*v;
      const cy = face.n[1] + face.t[1]*u + face.b[1]*v;
      const cz = face.n[2] + face.t[2]*u + face.b[2]*v;
      const cxx = cx*cx, cyy = cy*cy, czz = cz*cz;
      const sx = cx * Math.sqrt(Math.max(0, 1 - cyy*0.5 - czz*0.5 + cyy*czz/3));
      const sy = cy * Math.sqrt(Math.max(0, 1 - cxx*0.5 - czz*0.5 + cxx*czz/3));
      const sz = cz * Math.sqrt(Math.max(0, 1 - cxx*0.5 - cyy*0.5 + cxx*cyy/3));
      const inv = 1 / Math.max(1e-12, Math.sqrt(sx*sx + sy*sy + sz*sz));
      const ux_ = sx*inv, uy_ = sy*inv, uz_ = sz*inv;
      const lat = Math.asin(Math.max(-1, Math.min(1, uy_))) * 180 / Math.PI;
      const lon = Math.atan2(uz_, ux_) * 180 / Math.PI;
      lats.push(lat);
      lons.push(lon);
      if (Math.abs(lat) > 80) nearPole = true;
    }
    let latMin = Infinity, latMax = -Infinity;
    for (const l of lats) { if (l < latMin) latMin = l; if (l > latMax) latMax = l; }
    // Antimeridian wrap detection: if any pair of lons differs by >180
    // (impossible in real-space; means we crossed -180/+180 boundary),
    // mark as crossing and use the full lon range.
    let lonMin = Infinity, lonMax = -Infinity;
    let crossesAM = false;
    for (let i = 0; i < lons.length; i++) {
      for (let j = i + 1; j < lons.length; j++) {
        if (Math.abs(lons[i] - lons[j]) > 180) { crossesAM = true; break; }
      }
      if (crossesAM) break;
    }
    if (!crossesAM) {
      for (const l of lons) { if (l < lonMin) lonMin = l; if (l > lonMax) lonMax = l; }
    } else {
      lonMin = -180; lonMax = 180;
    }
    // Polar chunks: a chunk near the pole spans all longitudes when
    // projected to lat/lon. Be conservative.
    if (nearPole) { lonMin = -180; lonMax = 180; }
    // 5% margin: the 4-corners-and-center sample doesn't exactly hit
    // the chunk's true lat/lon extrema (extrema can lie on edges, not
    // corners). Small margin catches tiles that nick the chunk edge.
    const latMargin = Math.max(0.1, (latMax - latMin) * 0.05);
    const lonMargin = Math.max(0.1, (lonMax - lonMin) * 0.05);
    latMin -= latMargin; latMax += latMargin;
    if (!crossesAM && !nearPole) { lonMin -= lonMargin; lonMax += lonMargin; }
    return { latMin, latMax, lonMin, lonMax, crossesAM, nearPole };
  })();

  return {
    vertexBuffer,
    indexBuffer,
    indexCount: iWrite,
    aabbMin: new Float32Array([minX, minY, minZ]),
    aabbMax: new Float32Array([maxX, maxY, maxZ]),
    face: info.face,
    depth: info.depth,
    ix: info.ix,
    iy: info.iy,
    // Sprint 9-3 -- chunk's anchor in f64 world coords. Used by the
    // encoder to compose mv_rtc per draw via _composeRtcModelView.
    // For now all chunks of a PlanetMesh share the planet center
    // (single per-mesh anchor); future 9-3b swaps in per-chunk
    // centroids for sub-meter precision near the surface.
    anchorF64: { x: cxC, y: cyC, z: czC },
    latLonBounds: _latLonBounds
  };
}

function _ensurePlanetMeshChunks(node) {
  if (!Visual.device) return null;
  if (!Visual.planetMeshChunkCache) Visual.planetMeshChunkCache = new Map();
  let entry = Visual.planetMeshChunkCache.get(node.id);
  if (!entry) {
    entry = { chunks: new Map(), globalKey: null };
    Visual.planetMeshChunkCache.set(node.id, entry);
  }

  // Find wired PlanetMap. PlanetMesh requires one -- the elevation
  // source. Without it we emit no chunks (consistent with the old
  // single-mesh builder's null-return behavior).
  let pmap = null;
  if (state && Array.isArray(state.edges)) {
    const ed = state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "heightmap"
    );
    if (ed && ed.from) {
      pmap = state.nodes.find(n => n && n.id === ed.from.node && n.type === "PlanetMap") || null;
    }
  }
  if (!pmap) {
    return { tiledChunks: [], vertexBuffer: null, indexBuffer: null,
             vertexCount: 0, indexCount: 0,
             aabbMin: new Float32Array([0,0,0]), aabbMax: new Float32Array([0,0,0]),
             cacheKey: "planetmesh-no-map" };
  }
  // Sprint 10-5a-fix v3: Earth mode skips the 240k-cell Fibonacci
  // graph + 16-neighbor table (was the 8.8s startup stall) since
  // elevation comes from the baked Earth cubemap and color comes
  // from the lat+elev LUT. Cells are only needed for the (now-
  // unreachable) custom paint path. Same skip for climate + rivers
  // -- those are cell-graph derivations and were producing the
  // wrong biome quilt anyway. Leave a dummy hash so the cache-key
  // composition below doesn't choke on a missing field.
  let cells = null;
  if (!pmap._cellsKey) pmap._cellsKey = "earth-mode-no-cells";
  // Sprint 10-5b: ensure the cubemap is current BEFORE computing the
  // chunk cache key. The bake updates pmap._cubemapKey, which the key
  // below reads -- if we deferred to per-chunk build time, the chunk
  // invalidation would double-fire (once for null key, once for new
  // key). Single bake + single invalidation cycle this way.
  _ensurePlanetMapCubemap(pmap);

  // Invalidate the whole chunk cache when global geometry params OR
  // the wired PlanetMap's cells/cubemap change (elevation edits in
  // the painter bump pmap._cellsKey; DEM-load re-bakes bump
  // pmap._cubemapKey). Both must be in the chunk key, otherwise the
  // cubemap can change under our feet but the VBOs (with elevations
  // baked into vertex Y) never rebuild.
  const cellsTag   = (typeof pmap._cellsKey   === "string") ? pmap._cellsKey   : "no-cells";
  const cubemapTag = (typeof pmap._cubemapKey === "string") ? pmap._cubemapKey : "no-cubemap";
  // Sprint 10-6 v2: tile-bucket REMOVED from the chunk cache key.
  // Selective per-chunk invalidation (_invalidateChunksForTile) now
  // handles tile-load rebuilds at finer granularity -- bulk cache key
  // bump just thrashed every chunk on the planet every 64 tiles.
  const pmKey = cellsTag + "|" + cubemapTag;
  const globalKey = _planetMeshGlobalCacheKey(node) + "|" + pmKey;
  if (globalKey !== entry.globalKey) {
    const oldChunkCount = entry.chunks.size;
    for (const c of entry.chunks.values()) {
      try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
      try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
    }
    entry.chunks.clear();
    // v0.3.381 diagnostic: locate the FIRST char where old/new diverge.
    // The "tail" log in 10-6 v3 only showed last 60 chars; mystery
    // invalidations where the tail looks identical happen when the
    // diff is earlier in the key. Print first-diff position + 30-char
    // context window around it so we can see exactly what changed.
    if (entry.globalKey !== null) {
      const oldK = String(entry.globalKey);
      const newK = globalKey;
      let diffAt = -1;
      const maxScan = Math.min(oldK.length, newK.length);
      for (let i = 0; i < maxScan; i++) {
        if (oldK.charCodeAt(i) !== newK.charCodeAt(i)) { diffAt = i; break; }
      }
      if (diffAt === -1 && oldK.length !== newK.length) diffAt = maxScan;
      const ctxStart = Math.max(0, diffAt - 20);
      const ctxEnd   = Math.min(Math.max(oldK.length, newK.length), diffAt + 30);
      console.log("[planetmesh-quadtree] chunk cache invalidated (" + oldChunkCount + " chunks dropped)."
                + " diff at char " + diffAt + " / lens=" + oldK.length + "→" + newK.length
                + "\n  old: ..." + oldK.slice(ctxStart, ctxEnd) + "..."
                + "\n  new: ..." + newK.slice(ctxStart, ctxEnd) + "...");
    }
    entry.globalKey = globalKey;
  }

  const geom = _resolvePlanetMeshGeom(node.params || {});
  // §bonus-perf-foot-11 -- sample terrain elevation under the camera
  // so the horizon cull can use AGL (altitude above local ground)
  // instead of MSL (altitude above mean sphere). When the camera is
  // 100m above a 5km mountain plateau, MSL says 5100m of altitude and
  // the horizon cone is 2.3° wide → ~70 d6 chunks slip through. AGL
  // says 100m and the cone shrinks to 0.32° → 1-2 chunks. The latter
  // is what the camera can ACTUALLY see.
  const pmapCubemap = pmap ? _ensurePlanetMapCubemap(pmap) : null;
  const seaLevel = (pmap && pmap.params && typeof pmap.params.seaLevel === "number") ? pmap.params.seaLevel : 0.5;
  const camPosWorld = _planetCameraPos(node);
  const camPos = {
    x: camPosWorld.x - geom.cxC,
    y: camPosWorld.y - geom.cyC,
    z: camPosWorld.z - geom.czC
  };
  // §bonus-perf-foot-11 -- compute local terrain elevation under the
  // camera (radial sub-camera direction → sample cubemap → meters).
  // Used by the cull for AGL-correct horizon math.
  let localTerrainR = geom.r;
  if (pmapCubemap) {
    const cMagJs = Math.sqrt(camPos.x*camPos.x + camPos.y*camPos.y + camPos.z*camPos.z);
    if (cMagJs > 1) {
      const sx = camPos.x / cMagJs, sy = camPos.y / cMagJs, sz = camPos.z / cMagJs;
      const elev01 = _planetSampleElevationCached(pmapCubemap, sx, sy, sz);
      // Match the chunk-builder's elev → meters convention:
      // above sea level: (elev - seaLevel) / (1 - seaLevel) * heightScale
      const aboveSea = elev01 > seaLevel
        ? (elev01 - seaLevel) / Math.max(1e-6, 1 - seaLevel) * geom.hs
        : 0;
      // §bonus-perf-foot-12 -- CLAMP terrain elev so camera is always
      // at least 1m above it. The low-res cubemap (~10 km/texel) can
      // return mountain-peak averages for valley locations, which would
      // give localTerrainR > cMag → camOutside=false → horizon cull
      // DISABLED → all chunks pass → 9 fps. The clamp keeps the cull
      // engaged even when the elev sample lies; worst case is a
      // slightly bigger horizon cone than reality, which over-includes
      // but doesn't over-exclude.
      localTerrainR = Math.min(geom.r + aboveSea, cMagJs - 1.0);
    }
  }
  const visList = _planetVisibleChunks(camPos, geom.r, geom.hs, geom.maxDepth, geom.splitFactor, localTerrainR);
  const visible = new Map();
  for (const v of visList) {
    visible.set(_planetChunkKey(v.face, v.depth, v.ix, v.iy), v);
  }

  // Sprint 10-5c-d: queue SVT page generation for each visible chunk.
  // Pages are uploaded in _svtTickGeneration below within a per-frame
  // ms budget so we don't stall the chunk build pass. Replaces the
  // manual _svtTest console trigger.
  if (_SVT.atlasTexture) {
    for (const v of visList) _svtQueueChunkPages(v.face, v.depth, v.ix, v.iy);
    // §revert-suppression (2026-05-25) -- was 30 ms (too much: capped
    // fps at 33), dropped to 6 ms chasing the 9 fps foot bug. Real
    // bug was horizon cull; SVT budget at 6 ms was overly cautious
    // and the queue rarely drained. 12 ms is the middle ground --
    // 2x more pages per frame so foot-level SVT actually catches up,
    // without the 30 ms cap. Worker-side generation still the proper
    // long-term fix.
    _svtTickGeneration(pmap, 12);
  }

  // Drop chunks that left the visible set.
  const keysToDrop = [];
  for (const key of entry.chunks.keys()) {
    if (!visible.has(key)) keysToDrop.push(key);
  }
  for (const key of keysToDrop) {
    const c = entry.chunks.get(key);
    try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
    try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
    entry.chunks.delete(key);
  }

  const sun = _planetSunDir();
  const ambient = 0.18;

  // Two-phase incremental build under per-frame time budgets. Phase 1
  // = segs=2 placeholder so every visible chunk has SOMETHING within a
  // frame. Phase 2 = upgrade to full segs. Same shape as legacy Planet.
  // §bonus-sub5k (2026-05-25) -- per-chunk distance to camera. The
  // previous sort by depth was a rough proxy (deeper = usually closer)
  // but broke down near LOD boundaries; foreground gaps were filled
  // alongside far-away background chunks. Sort by ACTUAL distance from
  // camera so the visible disc fills outward from feet, not arbitrarily.
  // Reuses _planetSpherify to get the sphere-surface position.
  const _distSq = function(info) {
    if (typeof info._dSq === "number") return info._dSq;
    const uMid = (info.uMin !== undefined && info.uMax !== undefined) ? (info.uMin + info.uMax) * 0.5 : 0;
    const vMid = (info.vMin !== undefined && info.vMax !== undefined) ? (info.vMin + info.vMax) * 0.5 : 0;
    const f = _PLANET_FACES[info.face];
    const cx = f.n[0] + f.t[0] * uMid + f.b[0] * vMid;
    const cy = f.n[1] + f.t[1] * uMid + f.b[1] * vMid;
    const cz = f.n[2] + f.t[2] * uMid + f.b[2] * vMid;
    const sph = _planetSpherify(cx, cy, cz);
    const wx = sph[0] * geom.r, wy = sph[1] * geom.r, wz = sph[2] * geom.r;
    const dx = camPos.x - wx, dy = camPos.y - wy, dz = camPos.z - wz;
    info._dSq = dx*dx + dy*dy + dz*dz;
    return info._dSq;
  };

  const phPending = [];
  for (const [key, info] of visible) {
    if (entry.chunks.has(key)) continue;
    phPending.push({ key, info });
  }
  // Nearest first -- foreground gets a placeholder ASAP.
  phPending.sort((a, b) => _distSq(a.info) - _distSq(b.info));
  // §bonus-sub5k -- 8 → 14 ms. At 32-seg quality the 5 km disc needs
  // ~670 chunks built; old budget = 2 chunks/frame = 5.6 sec full fill.
  // 14 ms eats more frame budget but the cull keeps the camera at
  // 60 fps headroom and the LOD pyramid fills 2× faster.
  const PH_BUDGET_MS = 14;
  const phStart = performance.now();
  let phBuilt = 0;
  for (let i = 0; i < phPending.length; i++) {
    const item = phPending[i];
    const ph = _buildSinglePlanetMeshChunk(node, Object.assign({}, item.info, { segs: 2 }), camPos, sun, ambient, pmap, cells);
    if (ph) {
      ph.currentLod = 2;
      entry.chunks.set(item.key, ph);
      phBuilt++;
    }
    if (performance.now() - phStart > PH_BUDGET_MS) break;
  }
  const phMs = performance.now() - phStart;

  const upPending = [];
  for (const [key, info] of visible) {
    const c = entry.chunks.get(key);
    if (!c || c.currentLod === geom.segs) continue;
    upPending.push({ key, info, c });
  }
  // Nearest first for upgrade too -- the placeholder mesh under your
  // feet must become full-res before far chunks get upgraded.
  upPending.sort((a, b) => _distSq(a.info) - _distSq(b.info));
  // §bonus-sub5k -- 12 → 18 ms. Same reasoning as PH bump.
  const UP_BUDGET_MS = 18;
  const upStart = performance.now();
  let upBuilt = 0;
  for (let i = 0; i < upPending.length; i++) {
    const item = upPending[i];
    const proper = _buildSinglePlanetMeshChunk(node, Object.assign({}, item.info, { segs: geom.segs }), camPos, sun, ambient, pmap, cells);
    if (proper) {
      try { item.c.vertexBuffer && item.c.vertexBuffer.destroy(); } catch (_) {}
      try { item.c.indexBuffer  && item.c.indexBuffer.destroy();  } catch (_) {}
      proper.currentLod = geom.segs;
      entry.chunks.set(item.key, proper);
      upBuilt++;
    }
    if (performance.now() - upStart > UP_BUDGET_MS) break;
  }
  const upMs = performance.now() - upStart;
  // §bonus-sub5k -- queue depth into perf so we see backlog draining.
  if (typeof _PERFSTATS !== "undefined") {
    _PERFSTATS.chunkPhQueue = phPending.length - phBuilt;
    _PERFSTATS.chunkUpQueue = upPending.length - upBuilt;
  }

  if (typeof _PERFSTATS !== "undefined") {
    _PERFSTATS.chunksVisible += visible.size;
    _PERFSTATS.chunksBuilt += phBuilt + upBuilt;
    _PERFSTATS.chunkBuildMs += phMs + upMs;
    _PERFSTATS.totalChunksBuilt += phBuilt + upBuilt;
  }

  // Aggregate AABB for the outer (whole-mesh) frustum cull.
  let aabbMin, aabbMax;
  if (entry.chunks.size === 0) {
    aabbMin = new Float32Array([0, 0, 0]);
    aabbMax = new Float32Array([0, 0, 0]);
  } else {
    aabbMin = new Float32Array([Infinity, Infinity, Infinity]);
    aabbMax = new Float32Array([-Infinity, -Infinity, -Infinity]);
    for (const c of entry.chunks.values()) {
      if (c.aabbMin[0] < aabbMin[0]) aabbMin[0] = c.aabbMin[0];
      if (c.aabbMin[1] < aabbMin[1]) aabbMin[1] = c.aabbMin[1];
      if (c.aabbMin[2] < aabbMin[2]) aabbMin[2] = c.aabbMin[2];
      if (c.aabbMax[0] > aabbMax[0]) aabbMax[0] = c.aabbMax[0];
      if (c.aabbMax[1] > aabbMax[1]) aabbMax[1] = c.aabbMax[1];
      if (c.aabbMax[2] > aabbMax[2]) aabbMax[2] = c.aabbMax[2];
    }
  }
  const allChunks = [];
  for (const c of entry.chunks.values()) allChunks.push(c);
  if (!Visual._planetMeshQuadtreeLogged) {
    Visual._planetMeshQuadtreeLogged = true;
    console.log("[planetmesh-quadtree] first build:"
      + " visible=" + visible.size
      + " resident=" + entry.chunks.size
      + " maxDepth=" + geom.maxDepth
      + " splitFactor=" + geom.splitFactor.toFixed(1)
      + " segs=" + geom.segs);
  }
  return {
    tiledChunks: allChunks,
    vertexBuffer: null,
    indexBuffer: null,
    vertexCount: 0,
    indexCount: 0,
    aabbMin,
    aabbMax,
    cacheKey: "planetmesh-streamed"
  };
}

/* §planet-spec Phase 7.d-azgaar -- direct cell-mesh planet builder.
 * Mirrors Azgaar's 3D scene mode (newMesh/createMesh in
 * ref-azgaar-fmg/public/modules/ui/3d.js): each cell of the wired
 * PlanetMap becomes ONE mesh vertex at unit_direction * (R +
 * heightScale * altitudeFactor); triangles connect mutually-adjacent
 * cells via the K=6 nearest-neighbor table. NO chunking, NO cubemap
 * intermediate, NO smoothing of cell elevations -- peak cells produce
 * sharp peaks because each peak cell IS one mesh vertex with its own
 * elevation. */
/* Loop subdivision for the displaced PlanetMesh. One pass:
 *   - For each existing edge {a, b} (shared by 2 triangles on a
 *     closed manifold), create new "edge vertex" at
 *       p_new = (3/8)(p_a + p_b) + (1/8)(p_c1 + p_c2)
 *     where c1, c2 are the apex vertices of the two adjacent
 *     triangles. Classic Loop edge-vertex stencil.
 *   - For each existing vertex v with degree n, move it to
 *       p_new = (1 - n*β) * p_v + β * sum(neighbors)
 *     with Warren's β = (5/8 - (3/8 + (1/4)*cos(2π/n))²) / n
 *     for n > 3, β = 3/16 for n = 3. (n = 6 gives β = 1/16 — the
 *     limit case for the regular hex tiling.)
 *   - For each triangle (a, b, c), emit 4 children using the new
 *     edge vertices eAB, eBC, eCA: three corner triangles
 *     (a,eAB,eCA), (b,eBC,eAB), (c,eCA,eBC) + one center
 *     triangle (eAB,eBC,eCA), preserving CCW-from-outside winding.
 *
 * Vertex count goes from N → N + E, triangle count goes 4×.
 * At N=60k that's 240k verts / 480k triangles — fine for WebGPU.
 * Returns edgeParents so the caller can interpolate vertex
 * attributes (elevation, color) for the new edge vertices. */
function _loopSubdividePlanet(positions3, tris, N) {
  const T = tris.length / 3;
  const edgeMap = new Map();
  for (let t = 0; t < T; t++) {
    const i0 = tris[t*3], i1 = tris[t*3+1], i2 = tris[t*3+2];
    for (let e = 0; e < 3; e++) {
      const a = (e === 0) ? i0 : (e === 1) ? i1 : i2;
      const b = (e === 0) ? i1 : (e === 1) ? i2 : i0;
      const c = (e === 0) ? i2 : (e === 1) ? i0 : i1;
      const lo = (a < b) ? a : b, hi = (a < b) ? b : a;
      const key = lo * N + hi;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { a: lo, b: hi, c1: c, c2: -1, newIdx: -1 };
        edgeMap.set(key, edge);
      } else if (edge.c2 < 0) {
        edge.c2 = c;
      }
    }
  }
  const adj = new Array(N);
  for (let i = 0; i < N; i++) adj[i] = [];
  for (const edge of edgeMap.values()) {
    adj[edge.a].push(edge.b);
    adj[edge.b].push(edge.a);
  }
  const E = edgeMap.size;
  const newV = N + E;
  let eIdx = N;
  for (const edge of edgeMap.values()) edge.newIdx = eIdx++;

  const newPositions = new Float32Array(newV * 3);
  for (let i = 0; i < N; i++) {
    const n = adj[i].length;
    if (n === 0) {
      newPositions[i*3+0] = positions3[i*3+0];
      newPositions[i*3+1] = positions3[i*3+1];
      newPositions[i*3+2] = positions3[i*3+2];
      continue;
    }
    let beta;
    if (n === 3) beta = 3/16;
    else {
      const inner = 3/8 + 0.25 * Math.cos(2 * Math.PI / n);
      beta = (5/8 - inner * inner) / n;
    }
    const selfW = 1 - n * beta;
    let sx = positions3[i*3+0] * selfW;
    let sy = positions3[i*3+1] * selfW;
    let sz = positions3[i*3+2] * selfW;
    for (let j = 0; j < n; j++) {
      const k = adj[i][j];
      sx += positions3[k*3+0] * beta;
      sy += positions3[k*3+1] * beta;
      sz += positions3[k*3+2] * beta;
    }
    newPositions[i*3+0] = sx;
    newPositions[i*3+1] = sy;
    newPositions[i*3+2] = sz;
  }
  for (const edge of edgeMap.values()) {
    const a = edge.a, b = edge.b;
    const c1 = edge.c1, c2 = (edge.c2 >= 0) ? edge.c2 : edge.c1;
    const idx = edge.newIdx;
    newPositions[idx*3+0] = 0.375 * (positions3[a*3+0] + positions3[b*3+0])
                          + 0.125 * (positions3[c1*3+0] + positions3[c2*3+0]);
    newPositions[idx*3+1] = 0.375 * (positions3[a*3+1] + positions3[b*3+1])
                          + 0.125 * (positions3[c1*3+1] + positions3[c2*3+1]);
    newPositions[idx*3+2] = 0.375 * (positions3[a*3+2] + positions3[b*3+2])
                          + 0.125 * (positions3[c1*3+2] + positions3[c2*3+2]);
  }

  const newTris = new Uint32Array(T * 4 * 3);
  let outIdx = 0;
  for (let t = 0; t < T; t++) {
    const a = tris[t*3], b = tris[t*3+1], c = tris[t*3+2];
    const eAB = edgeMap.get((a<b?a:b) * N + (a<b?b:a)).newIdx;
    const eBC = edgeMap.get((b<c?b:c) * N + (b<c?c:b)).newIdx;
    const eCA = edgeMap.get((c<a?c:a) * N + (c<a?a:c)).newIdx;
    newTris[outIdx++] = a;   newTris[outIdx++] = eAB; newTris[outIdx++] = eCA;
    newTris[outIdx++] = b;   newTris[outIdx++] = eBC; newTris[outIdx++] = eAB;
    newTris[outIdx++] = c;   newTris[outIdx++] = eCA; newTris[outIdx++] = eBC;
    newTris[outIdx++] = eAB; newTris[outIdx++] = eBC; newTris[outIdx++] = eCA;
  }

  const edgeParents = new Int32Array(E * 2);
  for (const edge of edgeMap.values()) {
    edgeParents[(edge.newIdx - N) * 2 + 0] = edge.a;
    edgeParents[(edge.newIdx - N) * 2 + 1] = edge.b;
  }
  return { positions: newPositions, tris: newTris, edgeParents: edgeParents, oldCount: N, newCount: newV };
}

// Sprint 9-1: cube-sphere face basis. Each entry maps (u, v) in [-1, 1]
// to a point on the corresponding cube face. Winding is verified per
// face to come out CCW when viewed from outside the sphere using the
// quad order (i,j) -> (i+1,j) -> (i+1,j+1) -> (i,j+1).
const _CUBE_FACES = [
  { name: "+X", apply: function(u, v) { return [ 1,  v, -u]; } },
  { name: "-X", apply: function(u, v) { return [-1,  v,  u]; } },
  { name: "+Y", apply: function(u, v) { return [ u,  1, -v]; } },
  { name: "-Y", apply: function(u, v) { return [ u, -1,  v]; } },
  { name: "+Z", apply: function(u, v) { return [ u,  v,  1]; } },
  { name: "-Z", apply: function(u, v) { return [-u,  v, -1]; } }
];

/* Sprint 9-1 -- cube-sphere planet mesh replacing the Fibonacci-
 * Voronoi single-mesh path. Six static face grids; each vertex is
 * projected onto the unit sphere, looked up in the PlanetMap cell
 * graph for elevation + biome, then placed on the oblate spheroid
 * at radius + altitude.
 *
 * This is the static-base step of the Phase 9 cube-sphere quadtree
 * pivot (docs/PLANET-SCALE-TERRAIN.md §9.4). The quadtree (9-2) will
 * subdivide leaves toward the camera; CDLOD morphing (9-2) handles
 * LOD seams. For now everything is one static base mesh -- the
 * planet will look chunky compared to the old 240k-cell Fibonacci
 * mesh at the same resolution, but the topology is now compatible
 * with subdivision.
 *
 * The previous per-vertex detail-noise displacement (vs_main planet
 * branch) and the camera-anchored detail patch (vs_planet_detail)
 * are both retired: the patch synthesis defaults off in
 * _resolveSceneMeshes; the per-vertex displacement defaults to 0 in
 * the encoder. Both code paths remain in the file for now in case
 * rollback is needed, but ship un-fired. */
function _buildPlanetMesh(node) {
  if (!state || !Array.isArray(state.edges)) {
    console.warn("[planet-mesh] no state.edges yet, skipping mesh");
    return null;
  }
  // Find wired PlanetMap.
  const edge = state.edges.find(e =>
    e && e.to && e.to.node === node.id && e.to.port === "heightmap"
  );
  let pmap = null;
  if (edge && edge.from) {
    pmap = state.nodes.find(n => n && n.id === edge.from.node && n.type === "PlanetMap") || null;
  }
  if (!pmap) {
    console.warn("[planet-mesh] no wired PlanetMap on heightmap input for node", node.id);
    return null;
  }
  const cells = _ensurePlanetMapCells(pmap);
  if (!cells || !pmap._cellsHash) {
    console.warn("[planet-mesh] PlanetMap cells not ready",
                 { cells: !!cells, hash: !!pmap._cellsHash });
    return null;
  }

  // Read PlanetMesh params.
  const p = node.params || {};
  const r = (typeof p.radius === "number") ? p.radius : 1000;
  const polRatio = Math.max(0.5, Math.min(1.5, (typeof p.polarRadiusRatio === "number") ? p.polarRadiusRatio : 1.0));
  const cxC = (typeof p.centerX === "number") ? p.centerX : 0;
  const cyC = (typeof p.centerY === "number") ? p.centerY : 0;
  const czC = (typeof p.centerZ === "number") ? p.centerZ : 0;
  const hs = (typeof p.heightScale === "number") ? p.heightScale : 0;
  const seaLevel = Math.max(0, Math.min(1, (typeof p.seaLevel === "number") ? p.seaLevel : 0.5));
  // Sprint 9-1: vertices per cube-face edge. Static base mesh; the
  // quadtree (9-2) will subdivide leaves toward the camera. 129
  // gives ~100k verts total (6 * 129^2) vs the old Fibonacci ~240k
  // cells -- ~2.4x lower density, but uniform across the sphere
  // and ready for parent/child subdivision.
  const gridRes = Math.max(8, Math.min(513, Math.floor((typeof p.gridResolution === "number") ? p.gridResolution : 129)));

  // §planet-spec Phase 7.e -- compute climate + biomes + rivers
  // once per (cellsKey, seaLevel) combination. Painter edits to
  // elevation currently DO NOT invalidate this cache; add an
  // explicit bump if/when sub-cell edits are needed.
  _ensurePlanetClimate(pmap, seaLevel);
  _ensurePlanetRivers(pmap, seaLevel);

  const N = gridRes;
  const vertsPerFace = N * N;
  const totalVerts = vertsPerFace * 6;
  const quadsPerFace = (N - 1) * (N - 1);
  const totalTris = quadsPerFace * 6 * 2;

  // Pass 1: positions + per-vertex cell lookup. Each face is a
  // regular (u, v) grid in [-1, 1]; project to unit sphere via
  // normalize, look up the PlanetMap cell at that direction for
  // elevation + biome, place on the oblate spheroid at radius +
  // altitude. The same noise/biome data the old Fibonacci path
  // produced flows through unchanged; only the topology is new.
  const positions3 = new Float32Array(totalVerts * 3);
  const vertCellIdx = new Int32Array(totalVerts);
  let altMax = 0;
  const t0 = performance.now();
  for (let f = 0; f < 6; f++) {
    const face = _CUBE_FACES[f];
    const fOff = f * vertsPerFace;
    for (let j = 0; j < N; j++) {
      const vCoord = -1 + 2 * j / (N - 1);
      for (let i = 0; i < N; i++) {
        const uCoord = -1 + 2 * i / (N - 1);
        const cube = face.apply(uCoord, vCoord);
        const cLen = Math.hypot(cube[0], cube[1], cube[2]);
        const ux = cube[0] / cLen;
        const uy = cube[1] / cLen;
        const uz = cube[2] / cLen;
        const cellIdx = _findNearestCell(cells, pmap._cellsHash, ux, uy, uz);
        const elev = (cellIdx >= 0) ? cells.elevations[cellIdx] : 0;
        let altitude = 0;
        if (elev > seaLevel && hs !== 0) {
          altitude = hs * (elev - seaLevel) / Math.max(1e-6, 1 - seaLevel);
          if (altitude > altMax) altMax = altitude;
        }
        const vi = fOff + j * N + i;
        positions3[vi * 3 + 0] = cxC + r * ux           + altitude * ux;
        positions3[vi * 3 + 1] = cyC + r * uy * polRatio + altitude * uy;
        positions3[vi * 3 + 2] = czC + r * uz           + altitude * uz;
        vertCellIdx[vi] = cellIdx;
      }
    }
  }
  if (!Visual._planetMeshDisplaceLogged) {
    Visual._planetMeshDisplaceLogged = true;
    console.log("[planet-mesh] cube-sphere displacement check:"
      + " seaLevel=" + seaLevel.toFixed(2)
      + " heightScale=" + hs + "m"
      + " max altitude=" + altMax.toFixed(0) + "m"
      + " (=" + (100 * altMax / r).toFixed(3) + "% of radius)");
  }

  // Triangulate each face. Quad (a,b,c,d) = (i,j) -> (i+1,j) ->
  // (i+1,j+1) -> (i,j+1). Per-face analysis verified this winds
  // CCW from outside the sphere for all six _CUBE_FACES entries.
  const tris = new Uint32Array(totalTris * 3);
  let tIdx = 0;
  for (let f = 0; f < 6; f++) {
    const fOff = f * vertsPerFace;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = fOff + j * N + i;
        const b = fOff + j * N + (i + 1);
        const c = fOff + (j + 1) * N + (i + 1);
        const d = fOff + (j + 1) * N + i;
        tris[tIdx++] = a; tris[tIdx++] = b; tris[tIdx++] = c;
        tris[tIdx++] = a; tris[tIdx++] = c; tris[tIdx++] = d;
      }
    }
  }

  // Pass 2: face-normal accumulation.
  const normals3 = new Float32Array(totalVerts * 3);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t+1], c = tris[t+2];
    const ax = positions3[a*3], ay = positions3[a*3+1], az = positions3[a*3+2];
    const bx = positions3[b*3], by = positions3[b*3+1], bz = positions3[b*3+2];
    const cx = positions3[c*3], cy = positions3[c*3+1], cz = positions3[c*3+2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const fnx = e1y*e2z - e1z*e2y;
    const fny = e1z*e2x - e1x*e2z;
    const fnz = e1x*e2y - e1y*e2x;
    normals3[a*3+0] += fnx; normals3[a*3+1] += fny; normals3[a*3+2] += fnz;
    normals3[b*3+0] += fnx; normals3[b*3+1] += fny; normals3[b*3+2] += fnz;
    normals3[c*3+0] += fnx; normals3[c*3+1] += fny; normals3[c*3+2] += fnz;
  }

  // Pass 3: interleave + Lambert + biome color. Same per-cell
  // lookup as the Fibonacci path (river / lake / biome); the only
  // change is iterating cube-sphere verts instead of Voronoi cells.
  const sun = _planetSunDir();
  const sunX = sun[0], sunY = sun[1], sunZ = sun[2];
  const ambient = 0.18;
  const RIVER_BLUE = [0.20, 0.45, 0.75];
  const RIVER_BIG  = [0.15, 0.32, 0.62];
  const colorForCell = function(idx, elev) {
    if (cells.lake && cells.lake[idx]) return PLANET_BIOMES_COLORS[0];
    if (cells.riverId && cells.riverId[idx] >= 0 && cells.flux && elev >= seaLevel) {
      const flx = cells.flux[idx];
      const t = Math.min(1, Math.max(0, (flx - 30) / 200));
      return [
        RIVER_BLUE[0] + (RIVER_BIG[0] - RIVER_BLUE[0]) * t,
        RIVER_BLUE[1] + (RIVER_BIG[1] - RIVER_BLUE[1]) * t,
        RIVER_BLUE[2] + (RIVER_BIG[2] - RIVER_BLUE[2]) * t
      ];
    }
    if (cells.biome) return PLANET_BIOMES_COLORS[cells.biome[idx]];
    return _planetColorForHeight(elev, seaLevel);
  };
  const biomeForCell = function(idx, elev) {
    if (cells.lake && cells.lake[idx]) return 0;
    if (cells.riverId && cells.riverId[idx] >= 0 && cells.flux && elev >= seaLevel) return 0;
    if (cells.biome) return cells.biome[idx];
    return 0;
  };

  const verts = new Float32Array(totalVerts * 11);
  for (let i = 0; i < totalVerts; i++) {
    const px = positions3[i*3+0], py = positions3[i*3+1], pz = positions3[i*3+2];
    let nx = normals3[i*3+0], ny = normals3[i*3+1], nz = normals3[i*3+2];
    let nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; }
    else {
      const dx = px - cxC, dy = py - cyC, dz = pz - czC;
      const dl = Math.hypot(dx, dy, dz) || 1;
      nx = dx / dl; ny = dy / dl; nz = dz / dl;
    }
    const radialDot = nx * (px - cxC) + ny * (py - cyC) + nz * (pz - czC);
    if (radialDot < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const cellIdx = vertCellIdx[i];
    const elev = (cellIdx >= 0) ? cells.elevations[cellIdx] : seaLevel;
    const baseCol = (cellIdx >= 0) ? colorForCell(cellIdx, elev) : _planetColorForHeight(elev, seaLevel);
    const biomeId = (cellIdx >= 0) ? biomeForCell(cellIdx, elev) : 0;
    const lambert = Math.max(ambient, nx * sunX + ny * sunY + nz * sunZ);
    const base = i * 11;
    verts[base + 0] = px;
    verts[base + 1] = py;
    verts[base + 2] = pz;
    verts[base + 3] = baseCol[0] * lambert;
    verts[base + 4] = baseCol[1] * lambert;
    verts[base + 5] = baseCol[2] * lambert;
    verts[base + 6] = nx;
    verts[base + 7] = ny;
    verts[base + 8] = nz;
    verts[base + 9] = biomeId;
    verts[base + 10] = 0;
  }
  if (!Visual._planetMeshBuiltLogged) {
    Visual._planetMeshBuiltLogged = true;
    console.log("[planet-mesh] cube-sphere built: " + totalVerts + " verts + " + totalTris + " tris (6 faces × " + N + "×" + N + ") in " + (performance.now() - t0).toFixed(0) + "ms");
  }
  return { verts, indices: tris };
}

// Phase 8 sprint 8-7: PlanetDetailPatch -- static (u, v) grid mesh.
// vs_planet_detail transforms each vertex into the camera's local
// tangent plane every frame, projects onto the planet surface, and
// displaces by detail_noise_height. The output position is in WORLD
// space; the static grid stored here is just a parameter space.
//
// Vertex layout matches the standard interleaved 11-float format
// (pos.xyz, color.rgb, normal.xyz, uv.xy) so existing pipelines
// can consume it without VsIn changes. We pack the (u, v) grid coord
// into pos.xy and leave pos.z = 0; the vertex shader treats this as
// the grid parameter, not a world position.
// Builds the static (u, v) grid mesh used by the planet detail
// patch. Sprint 8-7b refactor: callable directly with a gridDim
// (used by _ensurePlanetDetailPatchBuffer's per-gridDim cache); the
// `node` argument is left optional for backward compat.
function _buildPlanetDetailPatch(nodeOrGridDim) {
  let N;
  if (typeof nodeOrGridDim === "number") {
    N = nodeOrGridDim;
  } else {
    const p = (nodeOrGridDim && nodeOrGridDim.params) || {};
    N = (typeof p.detailPatchGridDim === "number") ? p.detailPatchGridDim
      : (typeof p.gridDim === "number") ? p.gridDim
      : 96;
  }
  N = Math.max(2, Math.min(256, Math.floor(N)));
  const vCount = N * N;
  const triCount = (N - 1) * (N - 1) * 2;
  const verts = new Float32Array(vCount * 11);
  const indices = new Uint32Array(triCount * 3);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const v = j / (N - 1);
      const off = (j * N + i) * 11;
      verts[off + 0] = u;        // grid x in [0, 1]
      verts[off + 1] = v;        // grid y in [0, 1]
      verts[off + 2] = 0;        // unused (vertex shader rebuilds world pos)
      verts[off + 3] = 1;        // color placeholder (overwritten in vs)
      verts[off + 4] = 1;
      verts[off + 5] = 1;
      verts[off + 6] = 0;        // normal placeholder
      verts[off + 7] = 1;
      verts[off + 8] = 0;
      verts[off + 9] = 0;        // uv.x (biome ID will be set in vs from per-draw)
      verts[off + 10] = 0;
    }
  }
  let t = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const v00 = j * N + i;
      const v10 = j * N + (i + 1);
      const v01 = (j + 1) * N + i;
      const v11 = (j + 1) * N + (i + 1);
      indices[t++] = v00; indices[t++] = v10; indices[t++] = v11;
      indices[t++] = v00; indices[t++] = v11; indices[t++] = v01;
    }
  }
  return { verts, indices };
}

// Phase 8 sprint 8-7b -- per-gridDim GPU buffer cache for the detail
// patch. Same shape as the standard meshBufferCache entries (vertex
// buffer + index buffer + counts + aabb) so the encoder can treat
// the patch like any other mesh.
function _ensurePlanetDetailPatchBuffer(gridDim) {
  if (!Visual._planetDetailPatchBufCache) {
    Visual._planetDetailPatchBufCache = new Map();
  }
  const key = "g" + gridDim;
  let buf = Visual._planetDetailPatchBufCache.get(key);
  if (buf) return buf;
  if (!Visual.device) return null;
  const { verts, indices } = _buildPlanetDetailPatch(gridDim);
  const vbo = Visual.device.createBuffer({
    label: "planet-detail-patch-vbo-" + gridDim,
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  Visual.device.queue.writeBuffer(vbo, 0, verts.buffer, verts.byteOffset, verts.byteLength);
  const ibo = Visual.device.createBuffer({
    label: "planet-detail-patch-ibo-" + gridDim,
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
  });
  Visual.device.queue.writeBuffer(ibo, 0, indices.buffer, indices.byteOffset, indices.byteLength);
  // AABB is the unit (u, v) box. Vertex shader transforms it
  // into planet world space per-frame; frustum culling uses a
  // generous loose bound since the per-frame transform is dynamic.
  // We disable culling for the patch by feeding a huge AABB.
  const big = 1e9;
  buf = {
    vertexBuffer: vbo,
    indexBuffer: ibo,
    vertexCount: verts.length / 11,
    indexCount:  indices.length,
    aabbMin: new Float32Array([-big, -big, -big]),
    aabbMax: new Float32Array([ big,  big,  big])
  };
  Visual._planetDetailPatchBufCache.set(key, buf);
  return buf;
}


