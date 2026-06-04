/* Compute master canvas aspect for the current preview mode + rig.
 * Used by _projectionViewportRect to pick a letterbox/pillarbox-
 * correct viewport on the visible canvas. */
function _projectionMasterAspect() {
  const mode = (state && state.rig && state.rig.previewMode) || "tile";
  const n = (state && state.rig && state.rig.displays && state.rig.displays.length) || 1;
  const fbAspect = Visual.fbWidth / Visual.fbHeight;
  if (mode === "tile") {
    const { cols, rows } = _rigTileLayout(n);
    return (cols * fbAspect) / rows;
  }
  if (mode === "equirect") return 2.0;     // 2:1 standard
  if (mode === "cylinder") return 3.0;     // wide arc
  if (mode === "fisheye")  return 1.0;     // square
  return fbAspect;
}

/* Aspect-correct viewport rect on the visible canvas (object-fit:
 * contain). Returns coords in physical pixels. */
function _projectionViewportRect(masterAspect) {
  const cw = (Visual.canvas && Visual.canvas.width)  || 1;
  const ch = (Visual.canvas && Visual.canvas.height) || 1;
  const canvasAspect = cw / ch;
  let vpW, vpH;
  if (masterAspect > canvasAspect) {
    vpW = cw;
    vpH = Math.max(1, Math.floor(cw / masterAspect));
  } else {
    vpH = ch;
    vpW = Math.max(1, Math.floor(ch * masterAspect));
  }
  const vpX = Math.floor((cw - vpW) / 2);
  const vpY = Math.floor((ch - vpH) / 2);
  return { x: vpX, y: vpY, w: vpW, h: vpH };
}

/* Encode the rig composite pass — reads the framebuffer texture
 * array, writes to the visible canvas at the projection-mode-correct
 * viewport. Updates the rig uniform with current layer count + tile
 * layout + mode. */
function _encodeRigComposite(enc) {
  if (!Visual.device || !Visual.context || !Visual.rigCompositePipeline ||
      !Visual.rigCompositeBindGroup || !Visual.rigCompositeUniformBuffer ||
      !Visual.rigDisplaysBuffer) return false;
  const layerCount = Visual.framebufferLayerViews.length || 1;
  const mode = (state && state.rig && state.rig.previewMode) || "tile";
  const modeIdx = ({ tile: 0, cylinder: 1, equirect: 2, fisheye: 3 })[mode] || 0;
  const { cols, rows } = _rigTileLayout(layerCount);

  // Compute rig bounding angles for cylinder mode. Equirect uses a
  // fixed full sphere; fisheye uses a fixed dome — only cylinder
  // adapts to the rig's actual coverage so narrow rigs (e.g. 2-flat
  // side-by-side) don't waste 90% of the canvas on empty space.
  let azMin =  Infinity, azMax = -Infinity;
  let pMin  =  Infinity, pMax  = -Infinity;
  const displays = (state && state.rig && state.rig.displays) || [];
  for (let i = 0; i < layerCount && i < displays.length; i++) {
    const d = displays[i] || {};
    const pose = d.pose || { yaw: 0, pitch: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    const azL = pose.yaw   - fov.h * 0.5;
    const azR = pose.yaw   + fov.h * 0.5;
    const pT  = pose.pitch - fov.v * 0.5;
    const pB  = pose.pitch + fov.v * 0.5;
    if (azL < azMin) azMin = azL;
    if (azR > azMax) azMax = azR;
    if (pT  < pMin)  pMin  = pT;
    if (pB  > pMax)  pMax  = pB;
  }
  if (!isFinite(azMin)) { azMin = -180; azMax = 180; pMin = -90; pMax = 90; }

  // Pack the 32-byte rigU uniform: 4 u32 + 4 f32. Use one
  // ArrayBuffer with two views to avoid writeBuffer-per-half.
  const buf = new ArrayBuffer(32);
  const ub = new Uint32Array(buf);
  const fb = new Float32Array(buf);
  ub[0] = layerCount;
  ub[1] = cols;
  ub[2] = rows;
  ub[3] = modeIdx;
  fb[4] = azMin;
  fb[5] = azMax;
  fb[6] = pMin;
  fb[7] = pMax;
  Visual.device.queue.writeBuffer(Visual.rigCompositeUniformBuffer, 0, buf);

  // Pack the rigDisplays uniform array: RIG_MAX_DISPLAYS × vec4f
  // entries each (yaw, pitch, fov_h, fov_v). Unused slots stay zero
  // so pickDisplay's loop (bounded by layer_count) never reads them.
  const dbuf = new Float32Array(RIG_MAX_DISPLAYS * 4);
  for (let i = 0; i < layerCount && i < displays.length && i < RIG_MAX_DISPLAYS; i++) {
    const d = displays[i] || {};
    const pose = d.pose || { yaw: 0, pitch: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    dbuf[i*4 + 0] = pose.yaw;
    dbuf[i*4 + 1] = pose.pitch;
    dbuf[i*4 + 2] = fov.h;
    dbuf[i*4 + 3] = fov.v;
  }
  Visual.device.queue.writeBuffer(Visual.rigDisplaysBuffer, 0, dbuf.buffer, dbuf.byteOffset, dbuf.byteLength);

  let canvasView;
  try { canvasView = Visual.context.getCurrentTexture().createView(); }
  catch (e) { console.warn("[visual] canvas getCurrentTexture failed:", e); return false; }

  const masterAspect = _projectionMasterAspect();
  const vp = _projectionViewportRect(masterAspect);

  const pass = enc.beginRenderPass({
    label: "rig-composite",
    colorAttachments: [{
      view: canvasView,
      clearValue: { r: 0, g: 0, b: 0, a: 1.0 },   // letterbox bars
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  pass.setPipeline(Visual.rigCompositePipeline);
  pass.setBindGroup(0, Visual.rigCompositeBindGroup);
  pass.setViewport(vp.x, vp.y, vp.w, vp.h, 0, 1);
  pass.draw(3);
  pass.end();
  return true;
}

/* Public API: change render resolution. Driven by the resolution
 * HUD (6.1.5) or DevTools-console use. Reallocates the FBO + rebuilds
 * the bind group + re-runs the smoke render so the user sees the
 * change immediately. Skips render-side work silently if the device
 * isn't acquired yet — resolution preference is captured for when
 * it is. The HUD pill is updated unconditionally so callers don't
 * have to know whether the device acquired or not. */
function setRenderResolution(key) {
  const r = Visual.RESOLUTIONS.find(x => x.key === key);
  if (!r) {
    console.warn("[visual] unknown render resolution:", key);
    return;
  }
  Visual.resolutionKey = key;
  Visual.fbWidth  = r.w;
  Visual.fbHeight = r.h;
  if (Visual.device && Visual.context) {
    _allocateFramebuffer();
    // _allocateFramebuffer destroys the old texture + recreates the
    // 2d-array view, so EVERY bind group that referenced the old view
    // is now pointing at a destroyed resource and will render garbage
    // / solid black. Rebuild all three: blit (legacy single-layer
    // fallback), rig composite (multi-display reader), and warp
    // (Phase 6.6.4 calibration draw). Skipping any of these silently
    // breaks the affected pipeline at the new resolution. Pre-6.6
    // this only affected rig composite; the warp bind group makes
    // it three rebuilds instead of two.
    _rebuildBlitBindGroup();
    _rebuildRigCompositeBindGroup();
    _rebuildWarpBindGroup();
    _rebuildTheaterBindGroup();
    smokeClearVisual();
  }
  _updateResolutionPill();
  console.log("[visual] render resolution = " + key + " (" + r.w + "×" + r.h + ")");
}

/* ----- Phase 6.1.5 — Visual HUD helpers ------------------------------- */

function _updateResolutionPill() {
  const pill = document.getElementById("res-pill");
  if (pill) pill.textContent = Visual.resolutionKey;
}

/* Click handler on the resolution pill. Cycles through the
 * RESOLUTIONS array in declaration order: 1080p → 1440p → 4K → 8K
 * → 1080p. Single-click is one step forward; live-performance
 * friendly (no menu, no aim required). */
function _cycleRenderResolution() {
  const i = Visual.RESOLUTIONS.findIndex(r => r.key === Visual.resolutionKey);
  const next = Visual.RESOLUTIONS[(i + 1) % Visual.RESOLUTIONS.length];
  setRenderResolution(next.key);
}

/* Phase 6.5.14 — projection-mode HUD pill. Cycles tile → cylinder →
 * equirect → fisheye. Updates state.rig.previewMode (same field the
 * props-pane dropdown writes), syncs the dropdown, re-renders so
 * the next frame uses the new mode. */
const _PREVIEW_MODES = ["tile", "cylinder", "equirect", "fisheye", "theater"];
const _PREVIEW_LABELS = { tile: "Tile", cylinder: "Cylinder", equirect: "Equirect", fisheye: "Fisheye", theater: "Theater" };

function _updateProjectionPill() {
  const pill = document.getElementById("proj-pill");
  if (!pill) return;
  const mode = (state && state.rig && state.rig.previewMode) || "tile";
  pill.textContent = _PREVIEW_LABELS[mode] || "Tile";
  // Phase 6.6.13 — body class drives the theater-mode pointer-events
  // flip on #visual-bg. Updated here so any code path that touches
  // previewMode (dropdown / pill / loadPatch / applyRigTemplate)
  // converges through the pill update and stays consistent.
  document.body.classList.toggle("theater-mode", mode === "theater");
  // Phase 6.6.13 — show touch pads when in theater mode AND device
  // is touch-capable. theater-touch-capable is set once at device-
  // init time in _wireTheaterInput; it persists. theater-touch is
  // the runtime gate.
  document.body.classList.toggle(
    "theater-touch",
    mode === "theater" && document.body.classList.contains("theater-touch-capable")
  );
  if (mode !== "theater") {
    document.body.classList.remove("theater-locked");
    // Drop any held movement keys / touch sticks so a mode switch
    // mid-walk doesn't leave the camera drifting on next theater entry.
    if (Visual && Visual.theaterCam) {
      Visual.theaterCam.keys.clear();
      Visual.theaterCam.touchMove = null;
      Visual.theaterCam.touchLook = null;
      if (Visual.theaterCam.pointerLocked && document.pointerLockElement) {
        try { document.exitPointerLock(); } catch (_) {}
      }
    }
  }
}

function _cycleProjectionMode() {
  if (!state.rig) state.rig = defaultRig();
  const cur = state.rig.previewMode || "tile";
  const i = _PREVIEW_MODES.indexOf(cur);
  const next = _PREVIEW_MODES[(i + 1) % _PREVIEW_MODES.length];
  pushHistory("rig-preview:" + next);
  state.rig.previewMode = next;
  _updateProjectionPill();
  // If the rig pane is open (nothing selected), refresh it so the
  // dropdown reflects the new mode. Otherwise the next render still
  // picks up the change from state.rig.previewMode.
  renderProps && renderProps();
  render();
}

/* Toggle the freeze flag. The future rAF loop (lands with 6.1.7's
 * VisualOutput sink) will check Visual.frozen at the top of each
 * tick and skip the render if true. Audio is unaffected. */
function setVisualFrozen(on) {
  Visual.frozen = !!on;
  const btn = document.getElementById("freeze-btn");
  if (btn) {
    btn.classList.toggle("active", Visual.frozen);
    btn.title = Visual.frozen
      ? "Frozen — visual updates paused (click to resume)"
      : "Freeze visual updates (audio keeps running). Useful for inspecting a single frame mid-set.";
  }
}
function toggleVisualFreeze() { setVisualFrozen(!Visual.frozen); }

