/* Phase 7 §5.5.g -- Minimap HUD node renderer. Driven by the
 * presence of a Minimap node in the patch (no toggle pill -- delete
 * the node to hide). Draws the actual terrain top-down from the
 * patch's first TiledTerrain: samples the same fBm formula the
 * mesh builder uses, colors each sample by altitude band, scales
 * up via a tmp canvas + drawImage so 60×60 samples produce a
 * smooth-looking ~200px overlay. Camera dot + heading line render
 * on top. Position controlled by the Minimap node's corner /
 * margin / size params. */
function _ensureMinimapCanvas() {
  let c = document.getElementById("hud-minimap");
  if (c) return c;
  c = document.createElement("canvas");
  c.id = "hud-minimap";
  c.style.cssText =
    "position:fixed;z-index:85;border:1px solid rgba(120,140,170,0.35);" +
    "border-radius:6px;background:rgba(8,11,16,0.55);" +
    "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "box-shadow:0 4px 18px rgba(0,0,0,0.45);pointer-events:none;display:none;";
  document.body.appendChild(c);
  return c;
}

// Re-usable tmp canvas for the heightmap raster. Created once + reused
// every frame to avoid GC churn.
let _minimapTmp = null;

/* Planet minimap: azimuthal-orthographic hemisphere centered on the
 * camera's surface projection. Each pixel maps to (u, v) ∈ [-1, 1];
 * pixels with u² + v² > 1 are background (off the visible hemisphere).
 * For pixels inside the disc, compute the surface direction via
 *   dir = up*sqrt(1 - u² - v²) + east*u + north*v
 * where up = camera-radial, north = projection of world +Y onto the
 * tangent plane (gracefully degenerates when camera is exactly polar
 * by falling back to camera's local up). The cell graph's spatial
 * hash makes per-pixel nearest-cell lookup O(1)-ish (3³ bucket scan
 * × ~15 candidates = ~30 dot products). */
function _renderPlanetMinimap(img, RES, planet, minimapNode) {
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  if (!cam || !cam.params) {
    // Just paint a dark background.
    for (let i = 0; i < RES * RES; i++) {
      img.data[i*4+0] = 8; img.data[i*4+1] = 11; img.data[i*4+2] = 18; img.data[i*4+3] = 255;
    }
    return;
  }
  const cp = cam.params;
  const px = (typeof cp.posX === "number") ? cp.posX : 0;
  const py = (typeof cp.posY === "number") ? cp.posY : 0;
  const pz = (typeof cp.posZ === "number") ? cp.posZ : 0;
  const dx0 = px - planet.centerX, dy0 = py - planet.centerY, dz0 = pz - planet.centerZ;
  const rCam = Math.hypot(dx0, dy0, dz0) || 1;
  // Camera-surface up = radial unit vector
  const upX = dx0 / rCam, upY = dy0 / rCam, upZ = dz0 / rCam;
  // North reference: world +Y projected onto tangent plane. If camera
  // is near polar (radial ≈ world Y), use forward as a tiebreaker.
  let nx = 0, ny = 1, nz = 0;
  let nDotUp = nx*upX + ny*upY + nz*upZ;
  if (Math.abs(nDotUp) > 0.999) {
    // Polar fallback: use camera's local up as the north reference.
    const cux = (typeof cp.upX === "number") ? cp.upX : 0;
    const cuy = (typeof cp.upY === "number") ? cp.upY : 1;
    const cuz = (typeof cp.upZ === "number") ? cp.upZ : 0;
    nx = cux; ny = cuy; nz = cuz;
    nDotUp = nx*upX + ny*upY + nz*upZ;
  }
  // Gram-Schmidt: north = north - (north·up)*up, then normalize.
  nx -= upX * nDotUp; ny -= upY * nDotUp; nz -= upZ * nDotUp;
  const nLen = Math.hypot(nx, ny, nz) || 1;
  nx /= nLen; ny /= nLen; nz /= nLen;
  // East = north × up (right-handed)
  const ex = ny*upZ - nz*upY, ey = nz*upX - nx*upZ, ez = nx*upY - ny*upX;

  const p = minimapNode.params || {};
  const range = Math.max(0.1, Math.min(2.0, p.range || 1.0));   // 1.0 = full hemisphere
  // Sprint 10-5b: cubemap-sourced minimap. Mirrors the planet's actual
  // render path -- _samplePlanetMapCubemap for elev, _earthSurfaceColorAt
  // for color -- so the minimap visually matches what the 3D mesh shows.
  const cubemap = planet.mapNode._cubemap;
  const seaLevel = planet.seaLevel;

  for (let pyi = 0; pyi < RES; pyi++) {
    for (let pxi = 0; pxi < RES; pxi++) {
      const u = ((pxi + 0.5) / RES * 2 - 1) * range;
      const v = ((pyi + 0.5) / RES * 2 - 1) * range;
      const r2 = u*u + v*v;
      const o = (pyi * RES + pxi) * 4;
      if (r2 > 1) {
        // Off the visible hemisphere -- paint deep space.
        img.data[o+0] = 6; img.data[o+1] = 8; img.data[o+2] = 14; img.data[o+3] = 255;
        continue;
      }
      const w = Math.sqrt(1 - r2);
      // North on canvas is screen-up (-v); flip sign to get conventional map.
      const dx = upX*w + ex*u + nx*(-v);
      const dy = upY*w + ey*u + ny*(-v);
      const dz = upZ*w + ez*u + nz*(-v);
      // Cubemap sample + Earth-LUT color. Same lat formula as the chunk
      // builder + Earth cubemap bake so positions / colors are consistent.
      const elev = _samplePlanetMapCubemap(cubemap, dx, dy, dz);
      const latDeg = Math.asin(Math.max(-1, Math.min(1, dy))) * 180 / Math.PI;
      const lonDeg = -Math.atan2(dz, dx) * 180 / Math.PI;
      const col = _earthSurfaceColorAt(latDeg, lonDeg, elev, seaLevel);
      const shade = 0.55 + 0.45 * w;   // curvature shading
      img.data[o+0] = Math.max(0, Math.min(255, Math.floor(col[0] * shade * 255)));
      img.data[o+1] = Math.max(0, Math.min(255, Math.floor(col[1] * shade * 255)));
      img.data[o+2] = Math.max(0, Math.min(255, Math.floor(col[2] * shade * 255)));
      img.data[o+3] = 255;
    }
  }
}

/* Overlay (camera dot + heading line + N label) for the planet minimap.
 * Heading line is the camera's forward direction projected onto the
 * local east/north tangent plane. */
function _drawMinimapCameraOverlay(ctx, W, H, size, planet) {
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  const mx = W * 0.5, my = H * 0.5;
  // Recompute east/north (matches _renderPlanetMinimap convention).
  let headingX = 0, headingY = 1;
  if (cam && cam.params) {
    const cp = cam.params;
    const px = (typeof cp.posX === "number") ? cp.posX : 0;
    const py = (typeof cp.posY === "number") ? cp.posY : 0;
    const pz = (typeof cp.posZ === "number") ? cp.posZ : 0;
    const dx0 = px - planet.centerX, dy0 = py - planet.centerY, dz0 = pz - planet.centerZ;
    const rCam = Math.hypot(dx0, dy0, dz0) || 1;
    const upX = dx0 / rCam, upY = dy0 / rCam, upZ = dz0 / rCam;
    let nx = 0, ny = 1, nz = 0;
    let nDotUp = nx*upX + ny*upY + nz*upZ;
    if (Math.abs(nDotUp) > 0.999) {
      nx = (typeof cp.upX === "number") ? cp.upX : 0;
      ny = (typeof cp.upY === "number") ? cp.upY : 1;
      nz = (typeof cp.upZ === "number") ? cp.upZ : 0;
      nDotUp = nx*upX + ny*upY + nz*upZ;
    }
    nx -= upX * nDotUp; ny -= upY * nDotUp; nz -= upZ * nDotUp;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen; ny /= nLen; nz /= nLen;
    const ex = ny*upZ - nz*upY, ey = nz*upX - nx*upZ, ez = nx*upY - ny*upX;
    // Camera forward (target - pos), projected onto east/north plane.
    const tx = (typeof cp.targetX === "number") ? cp.targetX : 0;
    const ty = (typeof cp.targetY === "number") ? cp.targetY : 0;
    const tz = (typeof cp.targetZ === "number") ? cp.targetZ : 1;
    const fx = tx - px, fy = ty - py, fz = tz - pz;
    headingX = fx*ex + fy*ey + fz*ez;
    headingY = fx*nx + fy*ny + fz*nz;
    const hl = Math.hypot(headingX, headingY) || 1;
    headingX /= hl; headingY /= hl;
  }
  const len = Math.max(10, size * 0.10);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = Math.max(1.4, size * 0.012);
  ctx.beginPath();
  ctx.moveTo(mx, my);
  // Canvas Y grows downward; screen-up = -Y. headingY=+1 means "north"
  // which we want at the top of the minimap.
  ctx.lineTo(mx + headingX * len, my - headingY * len);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 220, 90, 1)";
  ctx.strokeStyle = "rgba(20, 20, 20, 0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mx, my, Math.max(3.5, size * 0.022), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = Math.max(10, Math.floor(size * 0.06)) + "px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText("N", W * 0.5, 14);
  ctx.textAlign = "left";

  // Scale label: hemisphere arc-distance from center to disc edge.
  // At range=1.0 the disc edge is the horizon (angular dist = 90°
  // around the planet, ~10000 km on Earth). Useful as a magnitude
  // marker -- not a strict scale bar.
  const arcKm = (planet.radius * Math.PI * 0.5 / 1000) * 1.0;
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText(Math.round(arcKm).toLocaleString() + " km horizon", 6, H - 6);
}

function _tickMinimapNodes() {
  if (!state || !Array.isArray(state.nodes)) return;
  const minimapNode = state.nodes.find(n => n && n.type === "Minimap");
  const canvas = _ensureMinimapCanvas();
  // HUD overlays only show in live mode. Otherwise the patch
  // editor's node graph competes with the overlay for the corner.
  if (!minimapNode || (typeof isLiveMode === "function" && !isLiveMode())) {
    canvas.style.display = "none";
    return;
  }
  // §5.5.g -- HUD overlays require the Minimap to be wired into a
  // Scene's hud1..hud4 input. The wire establishes "this minimap
  // belongs to this scene". If unwired, hide -- the user must drop
  // a wire to make it appear, so demos using multiple Scenes can
  // route HUDs to specific ones.
  const hudWire = state.edges && state.edges.find(e =>
    e && e.from && e.from.node === minimapNode.id && e.from.port === "hud"
  );
  if (!hudWire || !hudWire.to) {
    canvas.style.display = "none";
    return;
  }
  // Source: prefer a planet (PlanetMap with built cells) -- planet
  // patches show an azimuthal-ortho hemisphere centered on the
  // camera's surface projection. Fall back to TiledTerrain for the
  // legacy XZ heightmap minimap. If neither, hide.
  const planet = _findPlanetInfo();
  // Sprint 10-5b: minimap now reads from the baked Earth cubemap, not
  // from cells (Earth mode skips the cell graph entirely). cubemap is
  // baked lazily; ensure it before checking ready-ness.
  if (planet && planet.mapNode && !planet.mapNode._cubemap) {
    try { _ensurePlanetMapCubemap(planet.mapNode); } catch (_) {}
  }
  const planetReady = planet && planet.mapNode && planet.mapNode._cubemap;
  const tt = planetReady ? null : state.nodes.find(n => n && n.type === "TiledTerrain");
  if (!planetReady && (!tt || !tt.params)) {
    canvas.style.display = "none";
    return;
  }
  const p   = minimapNode.params || {};
  const size   = Math.max(80, Math.min(600, p.size   || 200));
  const margin = Math.max(0, p.margin || 18);
  const opacity = Math.max(0.05, Math.min(1.0, (typeof p.opacity === "number") ? p.opacity : 0.90));
  const range  = Math.max(0.1, Math.min(10, p.range || 1.0));
  const corner = (typeof p.corner === "string") ? p.corner : "top-right";

  canvas.style.display = "block";
  canvas.style.opacity = opacity;
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width  = size;
    canvas.height = size;
  }
  canvas.style.width  = size + "px";
  canvas.style.height = size + "px";
  canvas.style.top = canvas.style.bottom = canvas.style.left = canvas.style.right = "";
  if (corner === "top-right") { canvas.style.top = margin + "px"; canvas.style.right = margin + "px"; }
  else if (corner === "top-left") { canvas.style.top = margin + "px"; canvas.style.left = margin + "px"; }
  else if (corner === "bottom-left") { canvas.style.bottom = margin + "px"; canvas.style.left = margin + "px"; }
  else { canvas.style.bottom = margin + "px"; canvas.style.right = margin + "px"; }

  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  const RES = Math.min(96, Math.max(32, Math.floor(size / 3)));
  if (!_minimapTmp || _minimapTmp.width !== RES) {
    _minimapTmp = document.createElement("canvas");
    _minimapTmp.width  = RES;
    _minimapTmp.height = RES;
  }
  const tmpCtx = _minimapTmp.getContext("2d");
  const img = tmpCtx.createImageData(RES, RES);

  if (planetReady) {
    _renderPlanetMinimap(img, RES, planet, minimapNode);
    tmpCtx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(_minimapTmp, 0, 0, W, H);
    _drawMinimapCameraOverlay(ctx, W, H, size, planet);
    return;
  }


  // World disc covered by the minimap. Range=1 matches the terrain's
  // visible-chunk disc; larger range shows more world (zoomed out).
  const ttp = tt.params;
  const cs  = Math.max(1, ttp.chunkSize || 64);
  const r   = Math.max(0, Math.floor(ttp.chunkRadius || 0));
  const visibleDiameter = (2 * r + 1) * cs;
  const worldDiameter   = visibleDiameter * range;
  const noise = {
    seed:       (typeof ttp.seed       === "number") ? ttp.seed       : 7.42,
    frequency:  (typeof ttp.frequency  === "number") ? ttp.frequency  : 0.008,
    octaves:    (typeof ttp.octaves    === "number") ? ttp.octaves    : 6,
    lacunarity: (typeof ttp.lacunarity === "number") ? ttp.lacunarity : 2.05,
    gain:       (typeof ttp.gain       === "number") ? ttp.gain       : 0.5,
    ridges:     (typeof ttp.ridges     === "number") ? ttp.ridges     : 0.0,
    plateau:    (typeof ttp.plateau    === "number") ? ttp.plateau    : 0.0,
    // §5.5.e-8 -- intentionally NOT applying erosion here (8 neighbor
    // samples × iterations would burn tens of ms per frame). The
    // map silhouette + altitude bands are good enough without it.
    // Island params ARE applied (cheap -- 1 mask sample per pixel)
    // so the minimap correctly shows the archipelago silhouette.
    islandParams: _findTiledIslandParams(tt)
  };
  // Center the disc on the wired camera (or origin if none).
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  let camX = 0, camZ = 0, camYaw = 0;
  if (cam && cam.params) {
    camX = (typeof cam.params.posX === "number") ? cam.params.posX : 0;
    camZ = (typeof cam.params.posZ === "number") ? cam.params.posZ : 0;
    camYaw = (typeof cam.params.yaw === "number") ? cam.params.yaw : 0;
  }

  // Fill pixel buffer. Each pixel = one fBm sample colored by band.
  for (let py = 0; py < RES; py++) {
    for (let px = 0; px < RES; px++) {
      const u = (px + 0.5) / RES;
      const v = (py + 0.5) / RES;
      const wx = camX + (u - 0.5) * worldDiameter;
      const wz = camZ + (v - 0.5) * worldDiameter;
      const h01 = _tiledTerrainHeightAt(wx, wz, noise);
      let rT, gT, bT;
      if (h01 < 0.25) {
        const t = h01 / 0.25;
        rT = 0.20 + t * 0.20; gT = 0.32 + t * 0.30; bT = 0.55 - t * 0.20;
      } else if (h01 < 0.55) {
        const t = (h01 - 0.25) / 0.30;
        rT = 0.36 + t * 0.10; gT = 0.58 - t * 0.12; bT = 0.26 + t * 0.04;
      } else if (h01 < 0.80) {
        const t = (h01 - 0.55) / 0.25;
        rT = 0.48 + t * 0.20; gT = 0.42 + t * 0.18; bT = 0.36 + t * 0.10;
      } else {
        const t = (h01 - 0.80) / 0.20;
        rT = 0.85 + t * 0.15; gT = 0.86 + t * 0.14; bT = 0.88 + t * 0.12;
      }
      // §5.5.e-11 -- LERP terrain color toward ocean blue based on
      // island land-amount. Shows the archipelago silhouette on the
      // minimap exactly the way the rendered mesh shows it in 3D.
      const land = noise.islandParams ? _tiledIslandLandAmount(wx, wz, noise.islandParams) : 1;
      const rC = rT * land + 0.08 * (1 - land);
      const gC = gT * land + 0.18 * (1 - land);
      const bC = bT * land + 0.38 * (1 - land);
      // Cheap hillshade -- darken by a finite-diff slope in X so
      // the map reads as 3D-feeling instead of flat color blobs.
      const dx = 1.0 / RES * worldDiameter * 0.5;
      const hL = (px > 0)       ? _tiledTerrainHeightAt(wx - dx, wz, noise) : h01;
      const hR = (px < RES - 1) ? _tiledTerrainHeightAt(wx + dx, wz, noise) : h01;
      const shade = 1.0 + (hL - hR) * 0.6 * land;
      const o = (py * RES + px) * 4;
      img.data[o + 0] = Math.max(0, Math.min(255, Math.floor(rC * shade * 255)));
      img.data[o + 1] = Math.max(0, Math.min(255, Math.floor(gC * shade * 255)));
      img.data[o + 2] = Math.max(0, Math.min(255, Math.floor(bC * shade * 255)));
      img.data[o + 3] = 255;
    }
  }
  tmpCtx.putImageData(img, 0, 0);
  // Scale up to canvas size using browser smoothing.
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(_minimapTmp, 0, 0, W, H);

  // Camera dot + heading line at the canvas center (camera is the
  // anchor for the disc so it's always centered).
  const mx = W * 0.5, my = H * 0.5;
  const len = Math.max(10, size * 0.10);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = Math.max(1.4, size * 0.012);
  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(mx + Math.sin(camYaw) * len, my + Math.cos(camYaw) * len);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 220, 90, 1)";
  ctx.strokeStyle = "rgba(20, 20, 20, 0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mx, my, Math.max(3.5, size * 0.022), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Compass label (north arrow). In our convention yaw=0 looks +Z,
  // which is "south" by typical map orientation -- N points -Z so
  // it draws at the top when camYaw=0 (where forward is +Z = south
  // on the map). Just label the screen-up direction "N" so users
  // get a stable orientation reference.
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = Math.max(10, Math.floor(size * 0.06)) + "px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText("N", W * 0.5, 14);
  ctx.textAlign = "left";

  // Scale label.
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText(`${Math.round(worldDiameter).toLocaleString()}m`, 6, H - 6);
}

/* Phase 7 §5.5.h-27 -- Altimeter HUD overlay. Renders a small
 * fixed-position canvas in a screen corner with the patch's
 * FPCamera/Camera altitude + optional speed indicator. */
function _ensureAltimeterCanvas() {
  let c = document.getElementById("hud-altimeter");
  if (c) return c;
  c = document.createElement("canvas");
  c.id = "hud-altimeter";
  c.style.cssText =
    "position:fixed;z-index:85;border:1px solid rgba(120,140,170,0.35);" +
    "border-radius:6px;background:rgba(8,11,16,0.55);" +
    "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "box-shadow:0 4px 18px rgba(0,0,0,0.45);pointer-events:none;display:none;";
  document.body.appendChild(c);
  return c;
}

/* Sprint 10-5b -- fly-to-coordinates panel + walk/fly mode toggle.
 * DOM overlay (not canvas) so we can use real inputs + buttons.
 * Positioned just below the altimeter HUD. Shown whenever the HUD is. */
function _ensureFlyToPanel() {
  let panel = document.getElementById("hud-flyto");
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "hud-flyto";
  panel.style.cssText =
    "position:fixed;z-index:86;border:1px solid rgba(120,140,170,0.35);" +
    "border-radius:6px;background:rgba(8,11,16,0.62);" +
    "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "box-shadow:0 4px 18px rgba(0,0,0,0.45);" +
    "padding:8px 10px;color:rgba(255,255,255,0.88);" +
    "font:11px ui-monospace,'SF Mono',Menlo,monospace;display:none;" +
    "pointer-events:auto;user-select:none;width:240px;box-sizing:border-box;";
  const inputCss = "width:62px;padding:2px 4px;background:rgba(0,0,0,0.4);"
                 + "border:1px solid rgba(120,140,170,0.3);border-radius:3px;"
                 + "color:rgba(255,255,255,0.95);font:inherit;text-align:right;";
  const btnCss = "padding:4px 8px;background:rgba(70,90,120,0.55);"
               + "border:1px solid rgba(140,170,200,0.5);border-radius:3px;"
               + "color:rgba(255,255,255,0.95);font:inherit;cursor:pointer;flex:1;";
  panel.innerHTML = ''
    + '<div style="display:grid;grid-template-columns:30px 1fr 30px 1fr;gap:4px 4px;align-items:center;margin-bottom:6px;">'
    + '  <span style="opacity:0.7;">LAT</span><input id="flyto-lat" type="number" step="0.5" placeholder="0" style="' + inputCss + '"/>'
    + '  <span style="opacity:0.7;">LON</span><input id="flyto-lon" type="number" step="0.5" placeholder="0" style="' + inputCss + '"/>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:30px 1fr 30px 1fr;gap:4px 4px;align-items:center;margin-bottom:6px;">'
    + '  <span style="opacity:0.7;">ALT</span><input id="flyto-alt" type="number" step="10" placeholder="100" style="' + inputCss + '"/>'
    + '  <span style="opacity:0.5;">km</span><span></span>'
    + '</div>'
    + '<div style="display:flex;gap:4px;">'
    + '  <button id="flyto-go"   style="' + btnCss + '">FLY TO</button>'
    + '  <button id="flyto-mode" style="' + btnCss + '">MODE: WALK</button>'
    + '</div>';
  document.body.appendChild(panel);
  panel.querySelector("#flyto-go").addEventListener("click", _flyToGoClicked);
  panel.querySelector("#flyto-mode").addEventListener("click", _flyToModeClicked);
  // Prevent input keystrokes from being captured by the WASD camera.
  for (const inp of panel.querySelectorAll("input")) {
    inp.addEventListener("keydown", (e) => e.stopPropagation());
    inp.addEventListener("keyup",   (e) => e.stopPropagation());
  }
  return panel;
}

function _flyToGoClicked() {
  const panel = document.getElementById("hud-flyto");
  if (!panel || !state || !Array.isArray(state.nodes)) return;
  const latDeg = parseFloat(panel.querySelector("#flyto-lat").value);
  const lonDeg = parseFloat(panel.querySelector("#flyto-lon").value);
  const altKm  = parseFloat(panel.querySelector("#flyto-alt").value);
  if (isNaN(latDeg) || isNaN(lonDeg)) { console.warn("[flyto] lat/lon required"); return; }
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  const pl = _findPlanetInfo();
  if (!cam || !cam.params || !pl) { console.warn("[flyto] need wired Camera + Planet"); return; }
  const altM = (isNaN(altKm) ? 100 : altKm) * 1000;
  const latR = latDeg * Math.PI / 180;
  const lonR = lonDeg * Math.PI / 180;
  const cosLat = Math.cos(latR);
  // Sprint 10-6 v6: convert user-friendly lon to internal coords with
  // an east-west flip. The bake stores real-world east at internal -Z
  // direction (so it renders on screen RIGHT). For user typing lon=87
  // to land at the same place the cubemap put real-world lon=87 data,
  // we negate the uz component: internal_lon = -user_lon.
  const ux = cosLat * Math.cos(lonR);
  const uy = Math.sin(latR);
  const uz = -cosLat * Math.sin(lonR);
  const rAlt = pl.radius + altM;
  const newPx = pl.centerX + rAlt * ux;
  const newPy = pl.centerY + rAlt * uy * pl.polRatio;
  const newPz = pl.centerZ + rAlt * uz;
  cam.params.posX = newPx;
  cam.params.posY = newPy;
  cam.params.posZ = newPz;
  // Sprint 10-6 v5: set camera orientation on teleport.
  // Previously target/up survived from pre-teleport orientation,
  // meaning "forward" pointed in whatever direction the camera last
  // happened to face -- usually NOT a useful direction at the new
  // lat/lon. Now we set:
  //   up      = radial outward (camera upright on the surface)
  //   forward = local east (along +lon tangent)
  // So pressing W after teleport reliably moves you eastward, and
  // mouse-look rotates around the local horizon plane as expected.
  // Tangent basis at (lat, lon):
  //   east  = (-sinLon, 0, -cosLon)  ← Z negated for v6 east-west flip
  //   up    = (cosLat*cosLon, sinLat, -cosLat*sinLon) = (ux, uy, uz)
  // East tangent points in the direction of increasing user_lon. Since
  // internal_lon = -user_lon, increasing user_lon = decreasing internal_lon,
  // and the tangent of decreasing internal_lon is the negation of the
  // standard east tangent (-sinLon, 0, cosLon) → (-sinLon, 0, -cosLon).
  // Same world direction as the cubemap's east hemisphere (now on
  // screen RIGHT).
  const sinLon = Math.sin(lonR), cosLon = Math.cos(lonR);
  const eastX = -sinLon, eastY = 0, eastZ = -cosLon;
  cam.params.upX = ux; cam.params.upY = uy; cam.params.upZ = uz;
  cam.params.targetX = newPx + eastX;
  cam.params.targetY = newPy + eastY;
  cam.params.targetZ = newPz + eastZ;
  // Engage fly mode so we don't immediately snap to terrain on arrival.
  cam.params.walkMode = 0;
  // Reset cached surf so walk-mode (if you switch later) doesn't try
  // to use a surf from the old location.
  const fpcInput = Visual.fpcInput;
  if (fpcInput) {
    fpcInput._cachedSurf = null;
    fpcInput._cachedSurfTime = 0;
  }
  console.log("[flyto] teleported to lat=" + latDeg.toFixed(2) + " lon=" + lonDeg.toFixed(2)
              + " alt=" + (altM/1000).toFixed(0) + "km (mode=FLY, facing east)");
}

function _flyToModeClicked() {
  if (!state || !Array.isArray(state.nodes)) return;
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  if (!cam || !cam.params) return;
  const cur = (typeof cam.params.walkMode === "number") ? cam.params.walkMode : 1;
  cam.params.walkMode = (cur >= 0.5) ? 0 : 1;
  console.log("[flyto] mode -> " + (cam.params.walkMode >= 0.5 ? "WALK" : "FLY"));
}

function _tickAltimeterNodes() {
  if (!state || !Array.isArray(state.nodes)) return;
  const altNode = state.nodes.find(n => n && n.type === "Altimeter");
  const canvas = _ensureAltimeterCanvas();
  if (!altNode || (typeof isLiveMode === "function" && !isLiveMode())) {
    canvas.style.display = "none";
    return;
  }
  const hudWire = state.edges && state.edges.find(e =>
    e && e.from && e.from.node === altNode.id && e.from.port === "hud"
  );
  if (!hudWire || !hudWire.to) {
    canvas.style.display = "none";
    return;
  }
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  if (!cam || !cam.params) {
    canvas.style.display = "none";
    return;
  }
  const p = altNode.params || {};
  const corner    = (typeof p.corner === "string") ? p.corner : "top-left";
  const margin    = Math.max(0, p.margin || 18);
  const opacity   = Math.max(0.05, Math.min(1.0, (typeof p.opacity === "number") ? p.opacity : 0.90));
  const showSpeed = ((typeof p.showSpeed === "number") ? p.showSpeed : 1) >= 0.5;

  const posX = (typeof cam.params.posX === "number") ? cam.params.posX : 0;
  const posY = (typeof cam.params.posY === "number") ? cam.params.posY : 0;
  const posZ = (typeof cam.params.posZ === "number") ? cam.params.posZ : 0;

  // §planet-spec Phase 7.h-overhaul -- globe altimeter.
  //   MSL = |camera - planet_center| - planet_radius
  //   AGL = MSL - heightmap_at_camera's_surface_projection
  // For terrain patches (no planet), MSL falls back to plain posY
  // (legacy behavior) and AGL is hidden.
  let mslMeters = posY, aglMeters = null;
  let latDeg = null, lonDeg = null;
  const pl = _findPlanetInfo();
  if (pl) {
    const dx = posX - pl.centerX, dy = posY - pl.centerY, dz = posZ - pl.centerZ;
    const r = Math.hypot(dx, dy, dz);
    mslMeters = r - pl.radius;
    // Sprint 10-5b: latitude / longitude readout. Camera-to-center
    // direction projected on the unit sphere; same convention as
    // _buildEarthCubemap (lat = asin(uy), lon = atan2(uz, ux)) so
    // probe locations the user reads off the HUD match the DEM
    // sample locations exactly.
    if (r > 1e-6) {
      const ux = dx / r, uy = dy / r, uz = dz / r;
      latDeg = Math.asin(Math.max(-1, Math.min(1, uy))) * 180 / Math.PI;
      // Sprint 10-6 v6: negate atan2(uz,ux) so display matches the
      // visible planet orientation (east on screen RIGHT). Right-handed
      // lookAt puts world +Z on screen LEFT, so what's at internal
      // lon=+90 (atan2=+90) appears on the user's left; we want the
      // HUD to report real-world lon (east=positive).
      lonDeg = -Math.atan2(uz, ux) * 180 / Math.PI;
    }
    // Sprint 8-8: AGL via shared _planetMeshSurfacePos helper. It
    // applies the polRatio-corrected unit-sphere direction (matches
    // _buildPlanetMesh + per-frame detail-patch encoder), looks up
    // the cell, and uses the (R + alt, R*pr + alt, R + alt) surface-
    // position formula so AGL stays consistent with what walk mode
    // and flight collision see -- no more 4km readout error on
    // non-equator mountains.
    const surf = _planetMeshSurfacePos(posX, posY, posZ, pl);
    // Sprint 10-5b-fix v3: drop the `_cells` requirement -- Earth mode
    // has no cells but still has a cubemap, and _planetMeshSurfacePos
    // returns a real surf in that case. AGL now reads correctly in
    // Earth mode (was always null -> hidden -> the "no AGL" symptom).
    if (surf && pl.mapNode) {
      const sdx = surf.x - pl.centerX, sdy = surf.y - pl.centerY, sdz = surf.z - pl.centerZ;
      aglMeters = r - Math.hypot(sdx, sdy, sdz);
    }
  }

  const fmtAlt = function(m) {
    const a = Math.abs(m);
    if (a >= 1000) return (m / 1000).toFixed(a >= 100000 ? 0 : 2) + " km";
    return m.toFixed(0) + " m";
  };
  const fmtLat = function(d) {
    return Math.abs(d).toFixed(3) + "° " + (d >= 0 ? "N" : "S");
  };
  const fmtLon = function(d) {
    return Math.abs(d).toFixed(3) + "° " + (d >= 0 ? "E" : "W");
  };
  // §bonus-perf-foot-12 (2026-05-25) -- user feedback: MSL is
  // unreliable (terrain-relative changes don't reflect in MSL when
  // moving across continents at constant AGL); AGL is what the
  // player actually feels. Promote AGL to the primary big readout;
  // MSL falls back only when AGL isn't computable (no planet, or
  // surface sample failed).
  const primary = (aglMeters !== null) ? aglMeters : mslMeters;
  const primaryLabel = (aglMeters !== null) ? "AGL" : (pl ? "MSL" : "ALT");
  const primaryStr = fmtAlt(primary);
  const latStr = (latDeg === null) ? null : fmtLat(latDeg);
  const lonStr = (lonDeg === null) ? null : fmtLon(lonDeg);

  const W = 240;
  let H = 44;
  if (latStr !== null)              H += 22;
  if (lonStr !== null)              H += 22;
  if (showSpeed)                    H += 32;

  canvas.style.display = "block";
  canvas.style.opacity = opacity;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
  }
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  canvas.style.top = canvas.style.bottom = canvas.style.left = canvas.style.right = "";
  if (corner === "top-right")    { canvas.style.top    = margin + "px"; canvas.style.right = margin + "px"; }
  else if (corner === "top-left"){ canvas.style.top    = margin + "px"; canvas.style.left  = margin + "px"; }
  else if (corner === "bottom-left") { canvas.style.bottom = margin + "px"; canvas.style.left  = margin + "px"; }
  else                           { canvas.style.bottom = margin + "px"; canvas.style.right = margin + "px"; }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  let y = 16;
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText(primaryLabel, 12, y);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "bold 22px ui-monospace, monospace";
  ctx.fillText(primaryStr, 12, y + 22);
  y += 38;

  if (latStr !== null) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("LAT", 12, y);
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.font = "bold 14px ui-monospace, monospace";
    ctx.fillText(latStr, 40, y);
    y += 22;
  }
  if (lonStr !== null) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("LON", 12, y);
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.font = "bold 14px ui-monospace, monospace";
    ctx.fillText(lonStr, 40, y);
    y += 22;
  }

  if (showSpeed) {
    const baseSpeed = (typeof cam.params.walkSpeed === "number") ? cam.params.walkSpeed : 10;
    let speedStr;
    if (baseSpeed >= 1000) speedStr = (baseSpeed / 1000).toFixed(2) + " km/s";
    else                   speedStr = Math.round(baseSpeed) + " m/s";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("SPEED  " + speedStr + "  (×4 sprint)", 12, y + 12);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillText("hold X faster · Z slower", 12, y + 24);
  }

  // Sprint 10-5b: fly-to panel + mode toggle. Position it just below
  // the altimeter HUD on the same corner. Only shown when a Planet is
  // wired (lat/lon teleport needs a planet center to project against).
  const flyPanel = _ensureFlyToPanel();
  if (pl) {
    flyPanel.style.display = "block";
    flyPanel.style.opacity = opacity;
    flyPanel.style.top = flyPanel.style.bottom = flyPanel.style.left = flyPanel.style.right = "";
    const gap = 6;
    if (corner === "top-right") {
      flyPanel.style.top = (margin + H + gap) + "px";
      flyPanel.style.right = margin + "px";
    } else if (corner === "top-left") {
      flyPanel.style.top = (margin + H + gap) + "px";
      flyPanel.style.left = margin + "px";
    } else if (corner === "bottom-left") {
      flyPanel.style.bottom = (margin + H + gap) + "px";
      flyPanel.style.left = margin + "px";
    } else {
      flyPanel.style.bottom = (margin + H + gap) + "px";
      flyPanel.style.right = margin + "px";
    }
    // Update mode button label each tick.
    const modeBtn = flyPanel.querySelector("#flyto-mode");
    if (modeBtn) {
      const isWalk = ((typeof cam.params.walkMode === "number") ? cam.params.walkMode : 1) >= 0.5;
      modeBtn.textContent = isWalk ? "MODE: WALK → FLY" : "MODE: FLY → WALK";
    }
  } else {
    flyPanel.style.display = "none";
  }
}

