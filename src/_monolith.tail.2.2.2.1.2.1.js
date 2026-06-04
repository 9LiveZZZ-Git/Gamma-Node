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

/* =========================================================================
 * Phase 6.7.4 -- Performance overlay
 *
 * Per-frame counters (drawCalls, passes) incremented by the encoder
 * monkey-patch installed in ensureGPUDevice. Frame-time captured by
 * a perf.now() bracket around renderVisualFrame() in _visualRenderTick.
 * EMA-smoothed (alpha 0.10 -- ~10-frame window) so the displayed
 * values are stable but still responsive. DOM updater throttled to
 * ~5 Hz (every 200 ms) so the overlay itself doesn't drag perf when
 * open.
 *
 * GPU-side timing (timestamp-query) deliberately out of scope for
 * this iteration: requires pass-descriptor surgery on every
 * beginRenderPass call site. The infra (feature-detect, query set,
 * resolve buffer) lands in a follow-up when there's a clear need.
 * For now we ship CPU-side metrics + draw / pass / pipeline counts. */
function _installPerfEncoderWrap(device) {
  if (!device || Visual.perf.encoderWrapped) return;
  const origCreate = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = function(desc) {
    const enc = origCreate(desc);
    const origBeginRP = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = function(passDesc) {
      const pass = origBeginRP(passDesc);
      Visual.perf.passes++;
      const origDraw = pass.draw.bind(pass);
      pass.draw = function(a, b, c, d) {
        Visual.perf.drawCalls++;
        return origDraw(a, b, c, d);
      };
      if (pass.drawIndexed) {
        const origDi = pass.drawIndexed.bind(pass);
        pass.drawIndexed = function(a, b, c, d, e) {
          Visual.perf.drawCalls++;
          return origDi(a, b, c, d, e);
        };
      }
      return pass;
    };
    // Compute passes count toward "passes" too -- future-proof for
    // Phase 9 compute work (particles, GPU FFT). Same wrap shape.
    if (enc.beginComputePass) {
      const origBeginCP = enc.beginComputePass.bind(enc);
      enc.beginComputePass = function(passDesc) {
        const pass = origBeginCP(passDesc);
        Visual.perf.passes++;
        if (pass.dispatchWorkgroups) {
          const origDw = pass.dispatchWorkgroups.bind(pass);
          pass.dispatchWorkgroups = function(a, b, c) {
            Visual.perf.drawCalls++;
            return origDw(a, b, c);
          };
        }
        return pass;
      };
    }
    return enc;
  };
  Visual.perf.encoderWrapped = true;
}

function _resetPerfFrameCounters() {
  Visual.perf.drawCalls = 0;
  Visual.perf.passes = 0;
}

function _tickPerfOverlay(t, frameTimeMs) {
  const p = Visual.perf;
  // EMA-smooth all four core metrics. Alpha 0.10 = ~10-frame window
  // at 60 fps, so the readouts move within ~150 ms of a real change
  // but don't jitter on per-frame noise.
  p.frameTimeMs = frameTimeMs;
  p.emaFrameTimeMs = p.emaFrameTimeMs ? p.emaFrameTimeMs * 0.90 + frameTimeMs * 0.10 : frameTimeMs;
  p.emaDrawCalls  = p.emaDrawCalls   ? p.emaDrawCalls   * 0.90 + p.drawCalls   * 0.10 : p.drawCalls;
  p.emaPasses     = p.emaPasses      ? p.emaPasses      * 0.90 + p.passes      * 0.10 : p.passes;
  // DOM update throttled to ~5 Hz. When closed, skip the DOM entirely.
  if (!p.visible) return;
  if (t - p.lastDomUpdateT < 200) return;
  p.lastDomUpdateT = t;
  _renderPerfOverlay();
}

function _renderPerfOverlay() {
  const p = Visual.perf;
  const fps    = Math.round(_fpsAvg);
  const frame  = p.emaFrameTimeMs;
  const draws  = Math.round(p.emaDrawCalls);
  const passes = Math.round(p.emaPasses);
  // Pipeline cache: count entries whose compilation completed.
  let pipelines = 0;
  if (Visual.shaderPipelineCache) {
    for (const v of Visual.shaderPipelineCache.values()) {
      if (v && v.pipeline) pipelines++;
    }
  }
  // Visual-side node count -- only the patch nodes that participate
  // in the render graph (shader-frag + ai-vision-canvas + composition).
  // Cheaper to estimate from Visual.shaderInstances.size which tracks
  // exactly what got an instance allocated.
  const nodes = (Visual.shaderInstances && Visual.shaderInstances.size) || 0;

  const set = (id, txt, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = txt;
    el.classList.remove("warn", "bad", "muted");
    if (cls) el.classList.add(cls);
  };
  set("perf-fps",       fps   + " fps");
  // Frame-time color cliffs: <16.6 ms = green, 16.6..33.3 = warn, >33.3 = bad.
  const frameCls = frame > 33.3 ? "bad" : (frame > 16.6 ? "warn" : null);
  set("perf-frame",     frame.toFixed(2) + " ms", frameCls);
  set("perf-gpu",       "—",                       "muted");
  set("perf-draws",     String(draws));
  set("perf-passes",    String(passes));
  set("perf-pipelines", String(pipelines));
  set("perf-nodes",     String(nodes));
}

function setPerfOverlayVisible(on) {
  on = !!on;
  if (on === Visual.perf.visible) return;
  Visual.perf.visible = on;
  document.body.classList.toggle("perf-open", on);
  const overlay = document.getElementById("perf-overlay");
  if (overlay) overlay.setAttribute("aria-hidden", on ? "false" : "true");
  const pill = document.getElementById("perf-pill");
  if (pill) pill.classList.toggle("active", on);
  // Force one immediate refresh so the user doesn't see stale dashes
  // for up to 200 ms after toggling on.
  if (on) {
    Visual.perf.lastDomUpdateT = 0;
    _renderPerfOverlay();
  }
}
function togglePerfOverlay() { setPerfOverlayVisible(!Visual.perf.visible); }

/* Frame-rate readout updater. Called from the future rAF loop with
 * the timestamp DOMHighResTimeStamp argument. Maintains an exponential
 * moving average so the displayed number doesn't jitter every frame —
 * α = 0.05 gives a ~20-frame (≈ ⅓ s at 60 fps) effective window,
 * smooth without lagging too much. The readout DOM update is
 * throttled to once every ~10 frames to avoid layout thrash; the
 * underlying Visual.fps stays continuously current for any other
 * consumer that wants the precise number. */
let _fpsLastT = 0;
let _fpsAvg = 0;
let _fpsUpdateAccum = 0;
function _tickFpsReadout(t) {
  if (_fpsLastT > 0) {
    const dt = t - _fpsLastT;
    if (dt > 0) {
      const inst = 1000 / dt;
      _fpsAvg = _fpsAvg ? _fpsAvg * 0.95 + inst * 0.05 : inst;
      Visual.fps = _fpsAvg;
    }
  }
  _fpsLastT = t;
  _fpsUpdateAccum++;
  if (_fpsUpdateAccum >= 10) {
    _fpsUpdateAccum = 0;
    const el = document.getElementById("fps-readout");
    if (el) el.textContent = Math.round(_fpsAvg) + " fps";
  }
}

/* Compute the aspect-correct viewport rect inside the visible canvas
 * for a framebuffer of (fbW, fbH). Mirrors object-fit: contain — the
 * FBO scales uniformly to fit inside the canvas; remaining area is
 * letterbox (top/bottom) or pillarbox (left/right) bars. Returns the
 * viewport in physical pixels (canvas drawing-buffer space). */
function _blitViewport() {
  const cw = (Visual.canvas && Visual.canvas.width)  || 1;
  const ch = (Visual.canvas && Visual.canvas.height) || 1;
  const fbW = Visual.fbWidth  || 1;
  const fbH = Visual.fbHeight || 1;
  const scale = Math.min(cw / fbW, ch / fbH);
  const vpW = Math.max(1, Math.floor(fbW * scale));
  const vpH = Math.max(1, Math.floor(fbH * scale));
  const vpX = Math.floor((cw - vpW) / 2);
  const vpY = Math.floor((ch - vpH) / 2);
  return { x: vpX, y: vpY, w: vpW, h: vpH };
}

/* Smoke render — two passes. Pass 1 clears the framebuffer to a
 * recognizable debug color (slightly bluer than the editor backdrop
 * so an inspector can see "yes the FBO is being drawn into"). Pass 2
 * blits the FBO onto the visible canvas through the fullscreen-quad
 * pipeline with object-fit: contain letterbox math.
 *
 * Until shader nodes ship in 6.4.x, the FBO content is just a flat
 * clear. The point is to prove end-to-end:
 *   device → FBO render pass → texture binding → blit pipeline →
 *   canvas present
 * works. Live Mode is the easiest way to see the result — toggle L
 * on a touch-device-sized window and you'll see a near-black canvas
 * with subtle blue tint, possibly with letterbox bars if the window's
 * aspect doesn't match the FBO. Aspect-mismatch is the visible proof
 * that the blit math is correct. */
function smokeClearVisual() {
  if (!Visual.device || !Visual.context || !Visual.framebufferView ||
      !Visual.blitPipeline || !Visual.blitBindGroup) return;

  const enc = Visual.device.createCommandEncoder({ label: "smoke" });

  // Pass 1: clear FBO to debug color.
  enc.beginRenderPass({
    label: "fbo-smoke-clear",
    colorAttachments: [{
      view: Visual.framebufferView,
      clearValue: { r: 10/255, g: 14/255, b: 22/255, a: 1.0 },
      loadOp: "clear",
      storeOp: "store"
    }]
  }).end();

  // Pass 2: blit FBO to visible canvas with letterbox bars.
  let canvasView;
  try { canvasView = Visual.context.getCurrentTexture().createView(); }
  catch (e) {
    console.warn("[visual] canvas getCurrentTexture failed:", e);
    return;
  }
  const vp = _blitViewport();
  const blit = enc.beginRenderPass({
    label: "fbo-blit",
    colorAttachments: [{
      view: canvasView,
      // Letterbox bars: pure black so they read as "no signal" rather
      // than competing with the visual content.
      clearValue: { r: 0, g: 0, b: 0, a: 1.0 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  blit.setPipeline(Visual.blitPipeline);
  blit.setBindGroup(0, Visual.blitBindGroup);
  blit.setViewport(vp.x, vp.y, vp.w, vp.h, 0, 1);
  blit.draw(3);   // fullscreen triangle
  blit.end();

  Visual.device.queue.submit([enc.finish()]);
}

/* ----- Phase 6.2.1 — shader pipeline cache + per-instance state ------- */

/* FNV-1a 32-bit hash of a string. Cheap, no crypto, enough entropy
 * to disambiguate WGSL bodies in our cache. Returns a hex string so
 * we can use it as a Map key + label suffix interchangeably. */
function _fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/* Shared bind-group layout for all built-in shader-frag nodes:
 *   binding 0 → uniform buffer (preamble + per-node params)
 * Composition nodes in 6.4.x that consume input textures will need a
 * different layout (texture + sampler + uniform); they'll define
 * their own cache keys to avoid colliding with this one. */
/* Phase 6.5.3 — refresh the SAB FFT region from the main-thread
 * analyser. The 2048-point fftAnalyser pair gives 1024 source bins;
 * we downsample to 256 log-spaced bins (one per ~1/26th of an
 * octave), max-pool L+R per bin, normalize to 0..1. Result lands in
 * the SAB so the per-frame GPU copy below picks it up consistently
 * with the scalar path. */
let _fftScratchL = null;
let _fftScratchR = null;
function _updateAudioFft() {
  if (!audioBridge.available) return;
  const aL = previewState.fftAnalyserL;
  const aR = previewState.fftAnalyserR;
  if (!aL || !aR) return;
  const binCount = aL.frequencyBinCount;
  if (!_fftScratchL || _fftScratchL.length !== binCount) {
    _fftScratchL = new Uint8Array(binCount);
    _fftScratchR = new Uint8Array(binCount);
  }
  aL.getByteFrequencyData(_fftScratchL);
  aR.getByteFrequencyData(_fftScratchR);
  const ctx = previewState.audioCtx;
  const sr  = (ctx && ctx.sampleRate) || 48000;
  const fMin = 20.0;
  const fMax = Math.min(20000.0, sr * 0.5);
  const logRange = Math.log(fMax / fMin);
  const fftSize  = aL.fftSize;
  for (let k = 0; k < AUDIO_BRIDGE_FFT_COUNT; k++) {
    const freqLo = fMin * Math.exp(logRange * k       / AUDIO_BRIDGE_FFT_COUNT);
    const freqHi = fMin * Math.exp(logRange * (k + 1) / AUDIO_BRIDGE_FFT_COUNT);
    let binLo = (freqLo * fftSize / sr) | 0;
    let binHi = Math.max(binLo + 1, Math.ceil(freqHi * fftSize / sr));
    if (binHi > binCount) binHi = binCount;
    let peak = 0;
    for (let b = binLo; b < binHi; b++) {
      const v = _fftScratchL[b] > _fftScratchR[b] ? _fftScratchL[b] : _fftScratchR[b];
      if (v > peak) peak = v;
    }
    audioBridge.floats[AUDIO_BRIDGE_FFT_BASE + k] = peak * (1.0 / 255.0);
  }
}

/* Phase 6.5.2 + 6.5.3 + 6.5.4 — read SAB scalar slots + FFT bins
 * into the global GPU audio uniform buffer + overlay the JS-side
 * MasterClock state. Runs once per frame from renderVisualFrame().
 * One writeBuffer of 1088 B; always runs when device + buffer exist,
 * even if no shader reads u_audio. */
function _writeAudioUniform() {
  if (!Visual.device || !Visual.audioUniformBuffer || !Visual.audioUniformScratch) return;
  const sc = Visual.audioUniformScratch;
  if (audioBridge.available) {
    // Copy scalar section (16 f32) from SAB.
    for (let i = 0; i < 16; i++) {
      sc[i] = audioBridge.floats[AUDIO_BRIDGE_SCALAR_BASE + i];
    }
    // Copy FFT section (256 f32) right after scalars in the scratch.
    for (let i = 0; i < 256; i++) {
      sc[16 + i] = audioBridge.floats[AUDIO_BRIDGE_FFT_BASE + i];
    }
  } else {
    // Bridge unavailable -> zero out so shaders behave deterministically.
    for (let i = 0; i < 272; i++) sc[i] = 0;
  }
  // Phase 6.5.4 — overlay global clock values from the FIRST
  // MasterClock node in the patch. Runs even when the audio bridge
  // isn't available, since clock state is main-thread derived (no
  // worklet roundtrip). Lets any shader read u_audio.values[2..3]
  // for tempo-sync without needing a wired clockReact param.
  _writeClockUniformSlots(sc);
  Visual.device.queue.writeBuffer(
    Visual.audioUniformBuffer, 0,
    sc.buffer, sc.byteOffset, sc.byteLength
  );
}

/* Phase 6.5.4 — surface MasterClock as global audio-uniform scalars.
 * Layout (4 slots in values[2].w + 4 in values[3]):
 *   slot 11 (values[2].w) = bpm        (raw, e.g. 120.0)
 *   slot 12 (values[3].x) = bar        (cubic-decay envelope, 1.0 at downbeat → ~0 just before next bar)
 *   slot 13 (values[3].y) = beat       (cubic-decay envelope per beat)
 *   slot 14 (values[3].z) = sixteenth  (cubic-decay envelope per 1/16 note — high-frequency shimmer)
 *   slot 15 (values[3].w) = phase      (continuous 0..1 ramp within current beat)
 *
 * Source is the FIRST MasterClock node in state.nodes (lookup via
 * state.nodes.find). Multiple MasterClocks aren't really sensible
 * (patches should have one tempo); the first wins.
 *
 * No MasterClock in patch -> slots zero so shaders see "no tempo."
 * This means even unwired shaders can opt into tempo reactivity by
 * reading u_audio.values[3] in their WGSL -- no registry change
 * needed, no explicit clockReact wire required. The wired-param
 * path (Plasma.clockReact from MasterClock.beat, etc.) keeps working
 * unchanged; this is a parallel/complementary path. */
function _writeClockUniformSlots(sc) {
  // Defensive default if patch state isn't ready.
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) {
    sc[11] = 0; sc[12] = 0; sc[13] = 0; sc[14] = 0; sc[15] = 0;
    return;
  }
  const mc = state.nodes.find(n => n && n.type === "MasterClock");
  if (!mc) {
    sc[11] = 0; sc[12] = 0; sc[13] = 0; sc[14] = 0; sc[15] = 0;
    return;
  }
  sc[11] = _masterClockOutputValue(mc, "bpm");
  sc[12] = _masterClockOutputValue(mc, "bar");
  sc[13] = _masterClockOutputValue(mc, "beat");
  sc[14] = _masterClockOutputValue(mc, "sixteenth");
  sc[15] = _masterClockOutputValue(mc, "phase");
}

function _ensureStandardShaderLayout() {
  if (Visual.standardShaderBgl) return;
  Visual.standardShaderBgl = Visual.device.createBindGroupLayout({
    label: "shader-frag-standard-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      // Phase 6.5.2 — audio uniform always bound. Shaders that don't
      // declare it in WGSL just ignore it (WebGPU treats extra bind
      // layout entries as harmless when the shader doesn't sample).
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ]
  });
  Visual.standardShaderPipelineLayout = Visual.device.createPipelineLayout({
    label: "shader-frag-standard-pl",
    bindGroupLayouts: [Visual.standardShaderBgl]
  });
}

/* Phase 6.3.2 — bind-group layout for feedback shader-frag nodes.
 * Adds a sampled texture_2d_array binding (the global feedback /
 * history texture, populated by an end-of-frame
 * copyTextureToTexture from the framebuffer) plus a sampler.
 * Pipeline cache keys disambiguate between standard / feedback by
 * appending the layout tag to the WGSL hash. */
function _ensureFeedbackShaderLayout() {
  if (Visual.feedbackShaderBgl) return;
  Visual.feedbackShaderBgl = Visual.device.createBindGroupLayout({
    label: "shader-frag-feedback-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      // Phase 6.5.2 — audio uniform at binding 3 (same convention
      // as standard / composition layouts).
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ]
  });
  Visual.feedbackShaderPipelineLayout = Visual.device.createPipelineLayout({
    label: "shader-frag-feedback-pl",
    bindGroupLayouts: [Visual.feedbackShaderBgl]
  });
}

/* Phase 6.6.30 — bind-group layout for composition shader-frag nodes
 * (BlendShader / MaskShader / ColorCorrect / Pixelate / Posterize /
 * EdgeDetect / Blur). Same shape as feedback (uniform + texture +
 * sampler) but binds Visual.scratchArrayView -- a SEPARATE scratch
 * texture from the framebuffer + feedbackArray. Composition reads
 * SAME-FRAME scratch content (written by upstream shader-frag passes
 * earlier in the same submit) instead of 1-frame-lagged framebuffer
 * history, so a single composition node distributes correctly when
 * wired to multiple VOs: each VO's render loop overwrites scratch
 * slots with its OWN pose-correct upstream renders before the
 * consumer composition pass reads them. */
function _ensureCompositionShaderLayout() {
  if (Visual.compositionShaderBgl) return;
  Visual.compositionShaderBgl = Visual.device.createBindGroupLayout({
    label: "shader-frag-composition-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      // Phase 6.5.2 — audio uniform at binding 3.
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ]
  });
  Visual.compositionShaderPipelineLayout = Visual.device.createPipelineLayout({
    label: "shader-frag-composition-pl",
    bindGroupLayouts: [Visual.compositionShaderBgl]
  });
}

/* v0.3.34 — composition + feedback hybrid bind layout. Composition's
 * scratch texture at binding 1 (same-frame upstream input) PLUS the
 * feedback array at binding 4 (last-frame composite). Shared sampler
 * at binding 2 + audio uniform at binding 3 (same convention as the
 * other layouts).
 *
 * Used by the CRT shader's phosphor-persistence path: the shader
 * reads its live upstream signal via the scratch binding (just like
 * any composition shader) AND samples last-frame output via the
 * feedback binding to model phosphor decay. Single pass, no chained-
 * node workaround. */
function _ensureCompositionFeedbackShaderLayout() {
  if (Visual.compositionFeedbackShaderBgl) return;
  Visual.compositionFeedbackShaderBgl = Visual.device.createBindGroupLayout({
    label: "shader-frag-compositionfeedback-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } }
    ]
  });
  Visual.compositionFeedbackShaderPipelineLayout = Visual.device.createPipelineLayout({
    label: "shader-frag-compositionfeedback-pl",
    bindGroupLayouts: [Visual.compositionFeedbackShaderBgl]
  });
}

/* Phase 7.1 — bind-group layout for video-source shader-frag nodes
 * (Webcam, VideoFile, ScreenShare). Same shape as standard +
 * sampler + an externalTexture (the live video frame, imported
 * each render frame via device.importExternalTexture). External
 * textures expire at the end of the task they're created in, so
 * the bind group itself is rebuilt every frame -- handled in
 * _encodeShaderFragPassForPlan when entry.def.bindLayout === "video-source". */
function _ensureVideoSourceShaderLayout() {
  if (Visual.videoSourceShaderBgl) return;
  Visual.videoSourceShaderBgl = Visual.device.createBindGroupLayout({
    label: "shader-frag-videosource-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      // Audio uniform at binding 3, same as every other shader-frag layout.
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ]
  });
  Visual.videoSourceShaderPipelineLayout = Visual.device.createPipelineLayout({
    label: "shader-frag-videosource-pl",
    bindGroupLayouts: [Visual.videoSourceShaderBgl]
  });
}

/* Get-or-create a render pipeline for a WGSL body. Returns the cache
 * entry: { promise, pipeline, error }. First call kicks off async
 * compile; subsequent calls share the promise. Renderer reads
 * .pipeline directly — null means "not ready yet, skip this frame
 * gracefully". */
function _getShaderPipeline(wgsl, bindLayout) {
  bindLayout = bindLayout || "standard";
  _ensureStandardShaderLayout();
  if (bindLayout === "feedback")             _ensureFeedbackShaderLayout();
  if (bindLayout === "composition")          _ensureCompositionShaderLayout();
  if (bindLayout === "composition-feedback") _ensureCompositionFeedbackShaderLayout();
  if (bindLayout === "video-source")         _ensureVideoSourceShaderLayout();
  const key = _fnv1a(wgsl) + "@" + bindLayout;
  let entry = Visual.shaderPipelineCache.get(key);
  if (entry) return entry;

  const pipelineLayout = bindLayout === "feedback"
    ? Visual.feedbackShaderPipelineLayout
    : bindLayout === "composition"
      ? Visual.compositionShaderPipelineLayout
      : bindLayout === "composition-feedback"
        ? Visual.compositionFeedbackShaderPipelineLayout
        : bindLayout === "video-source"
          ? Visual.videoSourceShaderPipelineLayout
          : Visual.standardShaderPipelineLayout;

  entry = { key, promise: null, pipeline: null, error: null };
  entry.promise = (async () => {
    try {
      const module = Visual.device.createShaderModule({
        label: "shader-frag-" + key,
        code: wgsl
      });
      const pipeline = await Visual.device.createRenderPipelineAsync({
        label: "shader-frag-pipeline-" + key,
        layout: pipelineLayout,
        vertex:   { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_main", targets: [{ format: Visual.fbFormat }] },
        primitive: { topology: "triangle-list" }
      });
      entry.pipeline = pipeline;
      return pipeline;
    } catch (e) {
      entry.error = e;
      console.warn("[visual] shader-frag compile failed (key=" + key + "):", e);
      throw e;
    }
  })();
  Visual.shaderPipelineCache.set(key, entry);
  return entry;
}

/* Build (or refresh) per-node uniform buffer + bind group + tracked
 * pipeline entry. Returns { uniformBuffer, bindGroup, scratch,
 * pipelineEntry }. Hot-reload story (Phase 6.2.2):
 *
 *   • The pipelineEntry stored on the instance points at the cache
 *     entry it's currently rendering with.
 *   • When def.wgsl changes (user-edited shader-frag .gdsp), the
 *     desired entry changes too. We DON'T swap immediately — that
 *     would flicker to smoke-clear during the async compile. Instead
 *     we only flip inst.pipelineEntry once the new entry's pipeline
 *     is actually ready. The old pipeline keeps rendering until then.
 *   • When def.uniformBytes changes (param count edited), the buffer
 *     itself has to be reallocated; the old buffer is destroyed and a
 *     fresh bind group is built. Pipeline entry is also re-checked.
 *
 * Phase 6.6.23 — dynamic WGSL. def.wgsl can now be EITHER a string
 * (every instance shares one compiled pipeline, hashed by the WGSL
 * source) or a function (srcNode) => string (each call computes
 * the WGSL fresh from the node's current params; same-string
 * outputs still share a cached pipeline via the hash key, but
 * different params that change the source recompile lazily on
 * the first frame they're seen). The function form lets a single
 * registry entry produce per-node WGSL — used by the upcoming
 * MeshText conversion (param 'text' compiled into the bitmap
 * lookup table) and any future user-DSP node whose generated
 * shader depends on its own params. The function MUST be pure +
 * deterministic for a given node; non-deterministic output would
 * cause every frame to look up a new cache entry and trigger
 * an endless compile cascade. */
function _ensureShaderInstance(nodeId, def, srcNode, scratchReadKey) {
  let inst = Visual.shaderInstances.get(nodeId);
  const bindLayout = def.bindLayout || "standard";
  // v0.2.16 — composition bind layout supports two scratch textures
  // (A and B) for ping-pong; caller passes scratchReadKey ("a" or "b")
  // to pick which one this instance binds for reading. Defaults to "a"
  // for backwards compat with callers that don't pass it.
  if (!scratchReadKey) scratchReadKey = "a";
  // Phase 6.6.23 — resolve dynamic WGSL. If the function throws,
  // log it once + bail; caller falls back gracefully (returns
  // null, _encodeShaderFragPassForVO checks for it).
  let wgsl;
  try {
    wgsl = (typeof def.wgsl === "function")
      ? def.wgsl(srcNode || {})
      : def.wgsl;
  } catch (e) {
    if (!def._dynWgslWarned) {
      console.warn("[visual] dynamic WGSL function threw for node " + nodeId + ":", e);
      def._dynWgslWarned = true;
    }
    return null;
  }
  if (typeof wgsl !== "string" || wgsl.length === 0) return null;
  const desiredEntry = _getShaderPipeline(wgsl, bindLayout);

  // Reallocate when the buffer size, bindLayout, or texture-view ref
  // doesn't match (fresh node, user edited params, framebuffer
  // resized so the view's stale, etc).
  const feedbackView    = (bindLayout === "feedback" || bindLayout === "composition-feedback")
                          ? Visual.feedbackArrayView : null;
  const compositionView = (bindLayout === "composition" || bindLayout === "composition-feedback")
    ? (scratchReadKey === "b" ? Visual.scratchArrayViewB : Visual.scratchArrayViewA)
    : null;
  const samplerRef      = (bindLayout === "feedback" || bindLayout === "composition" ||
                           bindLayout === "composition-feedback" || bindLayout === "video-source")
                          ? Visual.blitSampler : null;
  const layoutMismatch     = inst && inst._bindLayout !== bindLayout;
  const feedbackViewStale  = inst && (bindLayout === "feedback" || bindLayout === "composition-feedback")
                                  && inst._feedbackView !== feedbackView;
  const compViewStale      = inst && (bindLayout === "composition" || bindLayout === "composition-feedback")
                                  && inst._compositionView !== compositionView;
  if (!inst || inst._uniformBytes !== def.uniformBytes || layoutMismatch || feedbackViewStale || compViewStale) {
    if (inst && inst.uniformBuffer) {
      try { inst.uniformBuffer.destroy(); } catch (_) {}
    }
    const bytes = def.uniformBytes;
    const buf = Visual.device.createBuffer({
      label: "shader-frag-uniform-" + nodeId,
      size:  bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    // Phase 6.5.2 — audio uniform buffer is bound at binding 3 in all
    // three layouts. Provide the same buffer regardless of bind layout.
    const audioBuf = Visual.audioUniformBuffer
      ? { binding: 3, resource: { buffer: Visual.audioUniformBuffer } }
      : null;
    let bg;
    if (bindLayout === "feedback" && feedbackView && samplerRef) {
      bg = Visual.device.createBindGroup({
        label: "shader-frag-feedback-bg-" + nodeId,
        layout: Visual.feedbackShaderBgl,
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: feedbackView },
          { binding: 2, resource: samplerRef },
          audioBuf
        ].filter(Boolean)
      });
    } else if (bindLayout === "composition" && compositionView && samplerRef) {
      bg = Visual.device.createBindGroup({
        label: "shader-frag-composition-bg-" + nodeId,
        layout: Visual.compositionShaderBgl,
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: compositionView },
          { binding: 2, resource: samplerRef },
          audioBuf
        ].filter(Boolean)
      });
    } else if (bindLayout === "composition-feedback" && compositionView && feedbackView && samplerRef) {
      // v0.3.34 -- composition + feedback hybrid. Bind composition's
      // scratch at slot 1 (live upstream input) AND the feedback
      // array at slot 4 (last-frame composite output). The CRT
      // shader's phosphor-persistence path samples both.
      bg = Visual.device.createBindGroup({
        label: "shader-frag-compositionfeedback-bg-" + nodeId,
        layout: Visual.compositionFeedbackShaderBgl,
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: compositionView },
          { binding: 2, resource: samplerRef },
          audioBuf,
          { binding: 4, resource: feedbackView }
        ].filter(Boolean)
      });
    } else if (bindLayout === "video-source") {
      // Phase 7.1 — video-source bind group has to be rebuilt every
      // frame because GPUExternalTexture is single-task-scoped. Leave
      // bg=null here; _encodeShaderFragPassForPlan creates a fresh
      // bind group right before the render pass using the live
      // external texture handed back from device.importExternalTexture.
      bg = null;
    } else {
      bg = Visual.device.createBindGroup({
        label: "shader-frag-bg-" + nodeId,
        layout: Visual.standardShaderBgl,
        entries: [
          { binding: 0, resource: { buffer: buf } },
          audioBuf
        ].filter(Boolean)
      });
    }
    inst = {
      uniformBuffer:    buf,
      bindGroup:        bg,
      scratch:          new Float32Array(bytes / 4),
      _uniformBytes:    bytes,
      _bindLayout:      bindLayout,
      _feedbackView:    feedbackView,
      _compositionView: compositionView,
      pipelineEntry:    desiredEntry
    };
    Visual.shaderInstances.set(nodeId, inst);
    return inst;
  }

  // Same instance, possibly different WGSL. Swap pipelineEntry only
  // when the desired entry has actually compiled — the old entry
  // keeps rendering during the compile so users don't see a flicker.
  if (inst.pipelineEntry !== desiredEntry && desiredEntry && desiredEntry.pipeline) {
    inst.pipelineEntry = desiredEntry;
  }
  return inst;
}

/* Drop any cached GPU state for a node (called when it's deleted
 * from the patch). Cheap garbage collection. Free to call on any
 * node id — no-ops if no state was cached. */
function _disposeShaderInstance(nodeId) {
  // v0.3.2 — restructured so non-shader-frag node teardowns (video
  // sources, MediaPipe AI nodes) still fire even when there's no
  // shader instance to clean up. Previously the `if (!inst) return`
  // skipped the new branches for nodes that don't HAVE a shader
  // instance (e.g. HandLandmarker), leaking the camera + detector.
  const inst = Visual.shaderInstances.get(nodeId);
  if (inst) {
    try { inst.uniformBuffer && inst.uniformBuffer.destroy(); } catch (_) {}
    Visual.shaderInstances.delete(nodeId);
  }
  // Phase 7.1 — tear down any active video source (Webcam / VideoFile
  // / ScreenShare) tied to this node. Stops the MediaStream tracks
  // (releases the camera / mic from the OS) and detaches the hidden
  // <video> element so the GC can collect it.
  _disposeVideoSource(nodeId);
  // Phase 7.1b — MediaPipe AI node cleanup. Stops the detection rAF
  // loop, closes the WASM detector, releases the camera stream.
  _disposeMediapipeNode(nodeId);
  // Sprint 7.5.3a/c -- 3D scene resource cleanup. Per-Scene
  // shared uniform + per-slot uniforms.
  const sceneInst = Visual.sceneInstances && Visual.sceneInstances.get(nodeId);
  if (sceneInst) {
    try { sceneInst.perSceneBuffer && sceneInst.perSceneBuffer.destroy(); } catch (_) {}
    if (Array.isArray(sceneInst.slots)) {
      for (const slot of sceneInst.slots) {
        try { slot.perDrawBuffer && slot.perDrawBuffer.destroy(); } catch (_) {}
      }
    }
    Visual.sceneInstances.delete(nodeId);
  }
  const meshBuf = Visual.meshBufferCache && Visual.meshBufferCache.get(nodeId);
  if (meshBuf) {
    try { meshBuf.vertexBuffer && meshBuf.vertexBuffer.destroy(); } catch (_) {}
    try { meshBuf.indexBuffer  && meshBuf.indexBuffer.destroy();  } catch (_) {}
    Visual.meshBufferCache.delete(nodeId);
  }
  // Sprint 7.5.6.a part 2d -- RT scene instance cleanup. Close the
  // WS, destroy the GPU texture. Reconnect timer cleared.
  const rtInst = Visual.rtSceneInstances && Visual.rtSceneInstances.get(nodeId);
  if (rtInst) {
    if (rtInst.reconnectTimer) {
      clearTimeout(rtInst.reconnectTimer);
      rtInst.reconnectTimer = null;
    }
    if (rtInst.ws) {
      try { rtInst.ws.send(JSON.stringify({ type: "render-stop" })); } catch (_) {}
      try { rtInst.ws.close(); } catch (_) {}
    }
    try { rtInst.texture && rtInst.texture.destroy(); } catch (_) {}
    Visual.rtSceneInstances.delete(nodeId);
  }
}

/* =========================================================================
 * Phase 7.1 — Video sources (Webcam, VideoFile, ScreenShare)
 *
 * Each video-source node owns:
 *   - An HTMLVideoElement (hidden, never attached to the visible DOM)
 *   - A MediaStream / src URL feeding that element
 *   - A "ready" flag flipped true once videoEl.readyState >= 2
 *     (HAVE_CURRENT_DATA -- meaning the first frame has decoded and
 *     is ready to sample).
 *
 * Per render frame, the framework calls
 *   device.importExternalTexture({ source: videoEl })
 * to get a fresh GPUExternalTexture, builds a bind group around it,
 * and draws a fullscreen triangle that samples + writes to the
 * framebuffer (or scratch) layer assigned by the render plan walker.
 *
 * External textures are single-task-scoped per the WebGPU spec, so
 * the bind group MUST be rebuilt every frame -- there's no "cache
 * the bind group" optimization available. Per-frame bind-group
 * creation is cheap (single small allocation, no GPU sync). Tested
 * comfortably under 1ms on a typical machine. */

const _videoSources = new Map();   // nodeId -> { videoEl, stream, ready, error, requesting, kind, src }

/* v0.3.19 — deterministic ordering of VideoFile / Webcam nodes that
 * have outgoing audio wires from outL or outR. Both the JS-side audio
 * router and the codegen use this exact ordering so the channel
 * allocation agrees on which video source feeds setVidL_N / setVidR_N.
 *
 * Sorted by node ID (stable across runs); capped at MAX so the C++
 * wrapper has a fixed dispatch table size. */
const MAX_VIDEO_AUDIO_SRC = 4;
function _videoAudioSrcNodes() {
  if (typeof state === "undefined" || !state) return [];
  if (!Array.isArray(state.nodes) || !Array.isArray(state.edges)) return [];
  return state.nodes
    .filter(n => n && (n.type === "VideoFile" || n.type === "Webcam" || n.type === "ScreenShare"))
    .filter(n => state.edges.some(e =>
      e && e.from && e.from.node === n.id &&
      (e.from.port === "outL" || e.from.port === "outR")
    ))
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, MAX_VIDEO_AUDIO_SRC);
}

async function _ensureWebcamStream(nodeId) {
  let entry = _videoSources.get(nodeId);
  // v0.3.19 — if the audio flag changed since the stream was created,
  // tear down + re-request so the new audioTracks state takes effect.
  // _audioWanted is stamped on the entry below; we read params via
  // the live node so the toggle in the props pane drives this.
  const node = (typeof state !== "undefined" && state && Array.isArray(state.nodes))
    ? state.nodes.find(n => n && n.id === nodeId) : null;
  const audioWanted = !!(node && node.params && node.params.audioEnabled);
  if (entry && entry._audioWanted !== audioWanted) {
    _disposeVideoSource(nodeId);
    entry = null;
  }
  if (entry) return entry;
  entry = { videoEl: null, stream: null, ready: false, error: null, requesting: true, kind: "webcam", _audioWanted: audioWanted };
  _videoSources.set(nodeId, entry);
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia not available in this browser context");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: audioWanted
    });
    const videoEl = document.createElement("video");
    videoEl.srcObject = stream;
    videoEl.playsInline = true;
    videoEl.muted = true;
    videoEl.autoplay = true;
    // play() can reject when no user gesture has fired; we swallow the
    // error and let videoEl.readyState >= 2 gate the frame anyway.
    try { await videoEl.play(); } catch (_) {}
    entry.stream  = stream;
    entry.videoEl = videoEl;
    entry.ready   = true;
    console.log("[webcam] node " + nodeId + " stream live: " +
                videoEl.videoWidth + "×" + videoEl.videoHeight +
                (audioWanted ? " (audio: " + stream.getAudioTracks().length + " track)" : ""));
    // v0.3.19 — if Web Audio is up, re-route now that the stream
    // (possibly with audio track) is live.
    if (typeof ensureVideoAudioConnected === "function" &&
        typeof previewState !== "undefined" && previewState && previewState.workletNode) {
      try { ensureVideoAudioConnected(); } catch (e) {
        console.warn("[webcam] post-init routing failed:", e);
      }
    }
  } catch (e) {
    console.warn("[webcam] node " + nodeId + " getUserMedia failed:", e);
    entry.error = e;
  } finally {
    entry.requesting = false;
  }
  return entry;
}

/* v0.3.22 — ScreenShare init. getDisplayMedia() opens the browser's
 * source picker (full screen / window / tab). Per the spec this MUST
 * be invoked from a user gesture -- the props-pane "Pick source"
 * button is that gesture; we never call this from the render loop or
 * any setInterval timer (Chrome rejects with "Permission denied" if
 * the call frame isn't gesture-tagged).
 *
 * Different from Webcam in three ways:
 *   1. Different stream source: getDisplayMedia, not getUserMedia.
 *   2. User-controlled lifecycle: the browser's "Stop sharing" UI
 *      ends the track outside our control. We hook videoTrack.onended
 *      to clean up + re-render the props pane so the user sees the
 *      "not sharing" state.
 *   3. Audio behavior: getDisplayMedia({ audio: true }) gives system
 *      audio on tab + window shares (Chrome / Edge on Windows when
 *      the user checks "Share audio" in the picker). Where the
 *      browser refuses audio, the stream has no audio tracks and the
 *      routing path is a silent no-op. */
async function _ensureScreenShareStream(nodeId) {
  let entry = _videoSources.get(nodeId);
  if (entry) return entry;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    console.warn("[screenshare] getDisplayMedia not available in this browser");
    return null;
  }
  // Resolve the node so we can honor its audio toggle.
  const node = (typeof state !== "undefined" && state && Array.isArray(state.nodes))
    ? state.nodes.find(n => n && n.id === nodeId) : null;
  const audioWanted = !!(node && node.params && node.params.audioEnabled);
  entry = { videoEl: null, stream: null, ready: false, error: null, requesting: true, kind: "screen", _audioWanted: audioWanted };
  _videoSources.set(nodeId, entry);
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: audioWanted
    });
    // Wire the user's "Stop sharing" button (browser UI) so we tear
    // down our entry the moment they end the share. Without this the
    // patch would keep referencing a stopped stream + render nothing.
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener("ended", () => {
        console.log("[screenshare] node " + nodeId + " ended (user stopped sharing)");
        _disposeVideoSource(nodeId);
        if (typeof renderProps === "function") {
          try { renderProps(); } catch (_) {}
        }
        if (typeof render === "function") {
          try { render(); } catch (_) {}
        }
      });
    }
    const videoEl = document.createElement("video");
    videoEl.srcObject   = stream;
    videoEl.playsInline = true;
    videoEl.muted       = true;     // audio path goes through Web Audio (MSS); muting the el avoids browser double-playback
    videoEl.autoplay    = true;
    try { await videoEl.play(); } catch (_) {}
    entry.stream  = stream;
    entry.videoEl = videoEl;
    entry.ready   = true;
    console.log("[screenshare] node " + nodeId + " sharing " +
                videoEl.videoWidth + "×" + videoEl.videoHeight +
                (audioWanted && stream.getAudioTracks().length
                  ? " (with system audio: 1 track)"
                  : " (no audio)"));
    // Hook into the worklet's video-audio merger if the patch is
    // already playing -- same idempotent path Webcam / VideoFile use.
    if (typeof ensureVideoAudioConnected === "function" &&
        typeof previewState !== "undefined" && previewState && previewState.workletNode) {
      try { ensureVideoAudioConnected(); } catch (e) {
        console.warn("[screenshare] post-init routing failed:", e);
      }
    }
  } catch (e) {
    // Cancel button in the picker rejects the promise; that's expected
    // (not a real error). Log quietly + clear the entry so the next
    // click re-opens the picker.
    if (e && e.name === "NotAllowedError") {
      console.log("[screenshare] node " + nodeId + " picker dismissed");
    } else {
      console.warn("[screenshare] node " + nodeId + " getDisplayMedia failed:", e);
    }
    entry.error = e;
    _videoSources.delete(nodeId);
    return null;
  } finally {
    if (entry) entry.requesting = false;
  }
  return entry;
}

function _disposeVideoSource(nodeId) {
  const entry = _videoSources.get(nodeId);
  if (!entry) return;
  // v0.3.19 — tear down Web Audio routing first so the worklet's
  // input 1 stops receiving samples from a stale source.
  if (typeof previewState !== "undefined" && previewState && previewState.videoRoutings) {
    const r = previewState.videoRoutings.get(nodeId);
    if (r) {
      try { r.splitter.disconnect(); } catch (_) {}
      previewState.videoRoutings.delete(nodeId);
    }
  }
  if (entry._directGain) {
    try { entry._directGain.disconnect(); } catch (_) {}
  }
  if (entry._mediaSource) {
    try { entry._mediaSource.disconnect(); } catch (_) {}
  }
  if (entry.stream) {
    try { entry.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
  }
  if (entry.videoEl) {
    try { entry.videoEl.srcObject = null; entry.videoEl.removeAttribute("src"); } catch (_) {}
    try { entry.videoEl.pause(); } catch (_) {}
    if (entry.videoEl.parentNode) entry.videoEl.parentNode.removeChild(entry.videoEl);
  }
  if (entry.objectUrl) {
    try { URL.revokeObjectURL(entry.objectUrl); } catch (_) {}
  }
  _videoSources.delete(nodeId);
}

/* v0.3.11 — VideoFile init. Distinct from _ensureWebcamStream
 * (which calls getUserMedia); this one loads an arbitrary URL into
 * an HTMLVideoElement. Same _videoSources storage so the video-
 * source render path + the landmark-node texture-input lookup both
 * find it. Loops indefinitely; respects URL changes by reloading. */
async function _ensureVideoFile(nodeId, params) {
  const fileUrl = (params && params.fileUrl) || "";
  let entry = _videoSources.get(nodeId);
  // If a different URL is requested, dispose + reinitialize.
  if (entry && entry.fileUrl !== fileUrl) {
    _disposeVideoSource(nodeId);
    entry = null;
  }
  if (entry) return entry;
  // v0.3.14 — silent no-op when fileUrl is empty. The previous behaviour
  // logged a noisy "fileUrl is empty" error every render frame the user
  // had a VideoFile with no file picked yet. Now we just leave the node
  // unregistered; downstream landmarks treat "no _videoSources entry"
  // as "no upstream" + fall back to own cam (or wait, depending on flow).
  // The moment the user picks a file, _ensureVideoFile is re-called with
  // a non-empty URL + falls through to the real init below.
  if (!fileUrl) return null;
  entry = {
    videoEl: null, stream: null, ready: false, error: null,
    requesting: true, kind: "videofile", fileUrl, objectUrl: null
  };
  _videoSources.set(nodeId, entry);
  try {
    const videoEl = document.createElement("video");
    videoEl.src         = fileUrl;
    videoEl.playsInline = true;
    // v0.3.16 — audio playback. The default browser policy requires a
    // user gesture before audio plays; the user picking the file (or
    // hitting any transport button) qualifies, so unmuted autoplay
    // usually succeeds. If the policy blocks playback, the video
    // continues silent + frames keep decoding, which is fine.
    const audioOn = !params || params.audioEnabled !== 0;
    const vol     = (params && typeof params.volume === "number") ? params.volume : 1.0;
    videoEl.muted       = !audioOn;
    videoEl.volume      = Math.max(0, Math.min(1, vol));
    videoEl.loop        = true;
    videoEl.autoplay    = true;
    // Important: importExternalTexture requires the video to have
    // started decoding frames. Wait for the first loadeddata event
    // (with a sane timeout) before flagging ready.
    await new Promise((resolve, reject) => {
      const onLoaded = () => { videoEl.removeEventListener("loadeddata", onLoaded); resolve(); };
      const onError  = (e) => { videoEl.removeEventListener("error", onError); reject(e); };
      videoEl.addEventListener("loadeddata", onLoaded, { once: true });
      videoEl.addEventListener("error", onError, { once: true });
      setTimeout(() => resolve(), 5000);   // safety: assume it eventually loads
    });
    // v0.3.15 — apply transport params on init.
    if (params && typeof params.playbackRate === "number" && params.playbackRate > 0) {
      videoEl.playbackRate = params.playbackRate;
    }
    if (params && params.paused) {
      try { videoEl.pause(); } catch (_) {}
    } else {
      try { await videoEl.play(); } catch (_) {}
    }
    entry.videoEl = videoEl;
    entry.ready = true;
    console.log("[videofile] node " + nodeId + " playing " +
                fileUrl.slice(0, 80) + " (" +
                (videoEl.videoWidth || "?") + "×" + (videoEl.videoHeight || "?") +
                " @ " + (videoEl.playbackRate || 1).toFixed(2) + "x" +
                (params && params.paused ? ", paused" : "") + ")");
    // v0.3.19 — if the audio context is already up (user hit Play
    // before this VideoFile was initialized), re-run the routing so
    // this new videoEl gets a MediaElementSource + connects to the
    // worklet merger. Otherwise the next Play picks it up.
    if (typeof ensureVideoAudioConnected === "function" &&
        typeof previewState !== "undefined" && previewState && previewState.workletNode) {
      try { ensureVideoAudioConnected(); } catch (e) {
        console.warn("[videofile] post-init routing failed:", e);
      }
    }
  } catch (e) {
    console.warn("[videofile] init failed for node " + nodeId + ":", e);
    entry.error = e;
  } finally {
    entry.requesting = false;
  }
  return entry;
}

/* v0.3.12 — resolve a landmark node's "video" texture input. Three
 * possible source kinds:
 *
 *   { kind: "video",   videoEl, srcNodeId }
 *     Upstream is a video-element source (Webcam / VideoFile etc) +
 *     the element has a frame ready. MediaPipe samples videoEl
 *     directly -- zero extra GPU work.
 *
 *   { kind: "texture", srcNodeId, srcType }
 *     Upstream is any other shader-frag node (Plasma, Butterflies,
 *     BlendShader, Gradient, etc). Its output lives on a framebuffer
 *     / scratch GPU layer; the landmark blits that layer to a per-
 *     node WebGPU canvas each frame + feeds the canvas to MediaPipe.
 *     The bgMode=1 overlay draws the same canvas content so the
 *     display matches what the detector saw.
 *
 *   null
 *     No wire on the "video" input. Caller falls back to its own
 *     getUserMedia camera. */
function _findUpstreamVideoSource(nodeId) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.edges)) return null;
  const edge = state.edges.find(e =>
    e && e.to && e.to.node === nodeId && e.to.port === "video");
  if (!edge || !edge.from) return null;
  const srcNode = state.nodes && state.nodes.find(n => n.id === edge.from.node);
  if (!srcNode) return null;
  const srcDef = TYPES[srcNode.type];
  const isVideoElementSource = srcDef && srcDef.bindLayout === "video-source";
  if (isVideoElementSource) {
    // v0.3.14 — if the source is a VideoFile with no file picked yet,
    // it has nothing to offer; treat as no-wire so downstream landmarks
    // keep using their own webcam (or whatever was previously bound)
    // instead of tearing it down + waiting on an empty source.
    if (srcNode.type === "VideoFile" &&
        !(srcNode.params && srcNode.params.fileUrl)) {
      return null;
    }
    // v0.3.22 — ScreenShare has no fileUrl + requires a user gesture
    // to init (so we don't auto-call _ensureScreenShareStream here).
    // Treat "no stream yet" the same as VideoFile with empty fileUrl:
    // the wire silently falls back until the user clicks pick.
    if (srcNode.type === "ScreenShare" && !_videoSources.has(srcNode.id)) {
      return null;
    }
    if (srcNode.type === "VideoFile")        _ensureVideoFile(srcNode.id, srcNode.params || {});
    else if (srcNode.type === "Webcam")      _ensureWebcamStream(srcNode.id);
    // ScreenShare: no auto-init -- existing stream picked up via
    // _videoSources lookup below.
    const src = _videoSources.get(srcNode.id);
    if (src && src.ready && src.videoEl && src.videoEl.readyState >= 2) {
      return { kind: "video", videoEl: src.videoEl, srcNodeId: srcNode.id };
    }
    // Wire exists but the upstream video element isn't decoded yet
    // (VideoFile still loading, Webcam permission still pending).
    // "pending" tells callers to WAIT instead of falling back.
    return { kind: "pending", srcNodeId: srcNode.id, srcType: srcNode.type };
  }
  return { kind: "texture", srcNodeId: srcNode.id, srcType: srcNode.type };
}

/* Back-compat wrapper -- still used by external call sites that only
 * care about the videoEl case. */
function _findUpstreamVideoEl(nodeId) {
  const src = _findUpstreamVideoSource(nodeId);
  return (src && src.kind === "video") ? src.videoEl : null;
}

/* =========================================================================
 * Phase 7.1b — MediaPipe Tasks Vision (AI vision sources)
 *
 * Lazy-loaded ESM module from jsdelivr (~3 MB WASM + JS, cached after
 * first fetch). Once loaded, individual node types (HandLandmarker
 * first, PoseLandmarker + FaceLandmarker to follow) instantiate
 * their own detector + camera stream and write detection results
 * into _mediapipeNodes.<id>.latest. Wired-param resolver (the same
 * one that handles Slider + MasterClock) reads .latest each render
 * frame and substitutes the value into downstream shader uniforms.
 *
 * Shader-side wiring works out of the box because all MediaPipe
 * output ports are param-typed. Audio-side wiring (drive a BiquadLP
 * cutoff with hand height, etc) needs a JS->SAB->worklet->C++ setter
 * bridge that doesn't exist yet -- that's follow-on work in a wider
 * "live control" sprint.
 *
 * Models hosted by Google: float16 builds from
 * https://storage.googleapis.com/mediapipe-models/. The CDN-cached
 * .task files are typically <10 MB each, decoded into GPU memory on
 * first detection. Subsequent reloads are instant (browser cache). */

let _mediapipeVisionPromise = null;
async function _loadMediaPipeVision() {
  if (_mediapipeVisionPromise) return _mediapipeVisionPromise;
  _mediapipeVisionPromise = (async () => {
    const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm");
    const FilesetResolver = mod.FilesetResolver;
    const HandLandmarker  = mod.HandLandmarker;
    const PoseLandmarker  = mod.PoseLandmarker;
    const FaceLandmarker  = mod.FaceLandmarker;
    const filesets = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
    );
    console.log("[mediapipe] tasks-vision loaded (wasm + filesets)");
    return { filesets, HandLandmarker, PoseLandmarker, FaceLandmarker };
  })().catch(e => {
    console.warn("[mediapipe] load failed:", e);
    _mediapipeVisionPromise = null;   // allow retry on next call
    throw e;
  });
  return _mediapipeVisionPromise;
}

// Per-node state: nodeId -> { kind, detector, videoEl, stream, latest,
//                             ready, requesting, error, rafHandle }
const _mediapipeNodes = new Map();

async function _ensureMediapipeCamera(entry) {
  if (entry.stream) return entry.stream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("getUserMedia not available");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  const videoEl = document.createElement("video");
  videoEl.srcObject  = stream;
  videoEl.playsInline = true;
  videoEl.muted      = true;
  videoEl.autoplay   = true;
  try { await videoEl.play(); } catch (_) {}
  // Wait for first frame so detectForVideo doesn't see a zero-dim source.
  await new Promise(resolve => {
    if (videoEl.readyState >= 2) resolve();
    else videoEl.addEventListener("loadeddata", () => resolve(), { once: true });
  });
  entry.stream  = stream;
  entry.videoEl = videoEl;
  return stream;
}

/* v0.3.12 — pick the right input source for a landmark detector.
 * Three branches:
 *   1. "video"   — upstream is video-element-backed (Webcam/VideoFile)
 *                  → borrow its <video> element, mark sharedVideoEl
 *                  so cleanup doesn't tear down a stream another node
 *                  owns. MediaPipe samples videoEl directly.
 *   2. "texture" — upstream is any other shader-frag (Plasma /
 *                  Butterflies / BlendShader / Gradient etc) → set up
 *                  a per-landmark WebGPU canvas (entry.gpuInputCanvas).
 *                  The render path blits the upstream's framebuffer
 *                  layer into this canvas each frame; MediaPipe + the
 *                  drawCanvas bg both read the canvas content.
 *   3. fallback  — no wire OR upstream not ready → open own getUserMedia
 *                  camera (the v0.3.6 default). */
async function _ensureMediapipeSource(nodeId, entry) {
  const upstream = _findUpstreamVideoSource(nodeId);
  if (upstream && upstream.kind === "video") {
    entry.videoEl         = upstream.videoEl;
    entry.sharedVideoEl   = true;
    entry.useTextureSource = false;
    entry.upstreamNodeId  = upstream.srcNodeId;
    return upstream.videoEl;
  }
  if (upstream && upstream.kind === "texture") {
    _allocateGpuInputCanvas(entry);
    entry.useTextureSource = true;
    entry.upstreamNodeId   = upstream.srcNodeId;
    entry.sharedVideoEl    = false;
    entry.videoEl          = null;
    console.log("[landmark] node " + nodeId + " using TEXTURE source from " +
                upstream.srcType + "(" + upstream.srcNodeId + ")");
    return null;
  }
  if (upstream && upstream.kind === "pending") {
    // v0.3.13 — wire exists to a video source that's still loading
    // (VideoFile decoding, Webcam permission pending, etc). Defer:
    // don't open own camera, don't allocate anything yet. The
    // detection loop's _resolveSourceForTick will retry each frame
    // until the upstream becomes ready, then transition the entry
    // into "video" mode.
    entry.awaitingUpstream = true;
    entry.upstreamNodeId   = upstream.srcNodeId;
    entry.sharedVideoEl    = false;
    entry.useTextureSource = false;
    entry.videoEl          = null;
    console.log("[landmark] node " + nodeId + " waiting for " +
                upstream.srcType + "(" + upstream.srcNodeId + ") to load");
    return null;
  }
  // No wire: own camera (the v0.3.6 default).
  await _ensureMediapipeCamera(entry);
  entry.sharedVideoEl    = false;
  entry.useTextureSource = false;
  return entry.videoEl;
}

/* v0.3.13 — allocate the WebGPU-context'd canvas the render path
 * blits the upstream's framebuffer/scratch layer into each frame.
 * Factored out of _ensureMediapipeSource so both the init path and
 * the deferred "now ready" transition in the detection loop can
 * call it. */
function _allocateGpuInputCanvas(entry) {
  if (entry.gpuInputCanvas) return entry.gpuInputCanvas;
  const w = Visual.fbWidth  || 1920;
  const h = Visual.fbHeight || 1080;
  entry.gpuInputCanvas = document.createElement("canvas");
  entry.gpuInputCanvas.width  = w;
  entry.gpuInputCanvas.height = h;
  entry.gpuInputCtx = entry.gpuInputCanvas.getContext("webgpu");
  if (entry.gpuInputCtx && Visual.device) {
    entry.gpuInputCtx.configure({
      device: Visual.device,
      format: Visual.presentationFormat,
      alphaMode: "premultiplied"
    });
  }
  return entry.gpuInputCanvas;
}

async function _ensureHandLandmarker(nodeId, params) {
  let entry = _mediapipeNodes.get(nodeId);
  if (entry) return entry;
  entry = {
    kind: "hand", detector: null, videoEl: null, stream: null,
    latest: null, ready: false, requesting: true, error: null, rafHandle: null,
    // v0.3.3 — texture-output infrastructure. drawCanvas is sized to
    // match the framebuffer so a single copyExternalImageToTexture per
    // frame fills the assigned layer without per-pixel scaling. The
    // detection loop draws the source video frame (scaled to canvas
    // dims) + the landmark skeleton overlay; ai-vision-canvas render
    // path queues the copy each frame.
    drawCanvas: null, drawCtx: null, params: params || {}
  };
  _mediapipeNodes.set(nodeId, entry);
  try {
    const { HandLandmarker, filesets } = await _loadMediaPipeVision();
    await _ensureMediapipeSource(nodeId, entry);
    entry.detector = await HandLandmarker.createFromOptions(filesets, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numHands: Math.max(1, Math.min(4, (params && params.maxHands) || 2)),
      minHandDetectionConfidence: (params && typeof params.minConfidence === "number") ? params.minConfidence : 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    // Allocate the draw canvas now that we know the framebuffer size.
    // Mirrors the editor's current render resolution so the copy
    // queued in _encodeShaderFragPassForPlan fills the framebuffer
    // layer 1:1 without per-pixel scaling.
    const w = Visual.fbWidth  || 1920;
    const h = Visual.fbHeight || 1080;
    entry.drawCanvas = document.createElement("canvas");
    entry.drawCanvas.width  = w;
    entry.drawCanvas.height = h;
    entry.drawCtx = entry.drawCanvas.getContext("2d", { alpha: true });
    entry.ready = true;
    console.log("[handlandmarker] node " + nodeId + " ready (numHands=" +
                entry.detector.numHands + ", canvas=" + w + "×" + h + ")");
    _startMediapipeLoop(nodeId);
  } catch (e) {
    console.warn("[handlandmarker] init failed for node " + nodeId + ":", e);
    entry.error = e;
  } finally {
    entry.requesting = false;
  }
  return entry;
}

/* MediaPipe hand-skeleton wiring per the official spec. 21 landmarks:
 *   0 wrist
 *   1-4   thumb (CMC, MCP, IP, TIP)
 *   5-8   index (MCP, PIP, DIP, TIP)
 *   9-12  middle
 *   13-16 ring
 *   17-20 pinky
 * Connections walk each finger from MCP -> TIP + cross-link the MCPs. */
const _HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],          // thumb
  [0,5],[5,6],[6,7],[7,8],          // index
  [5,9],[9,10],[10,11],[11,12],     // middle
  [9,13],[13,14],[14,15],[15,16],   // ring
  [13,17],[17,18],[18,19],[19,20],  // pinky
  [0,17]                            // wrist-to-pinky-base (palm edge)
];

/* v0.3.17 — aspect-preserving "contain" fit for landmark debug
 * overlays. Returns the destination rect (dx, dy, dw, dh) sized to
 * fit `source` (HTMLVideoElement or HTMLCanvasElement) into a w×h
 * canvas without warping. Bars (if any) are centered + the caller
 * is responsible for clearing them to a bg color (we paint black
 * first when bgMode === 1, so the letterbox bars are black).
 *
 * Why "contain" instead of "cover":
 *   - Landmark x/y arrive normalized 0..1 relative to the source
 *     frame. Cover-cropping would push landmarks off the canvas
 *     sides; contain keeps every detection visible + aligned with
 *     the visible bg.
 *   - The user's mental model is "this is the frame MediaPipe saw"
 *     -- showing the full frame matches that, with bars instead
 *     of cropping.
 *
 * Same-aspect inputs (camera 16:9 into 16:9 canvas, gpuInputCanvas
 * sized to Visual.fbWidth × fbHeight into landmark drawCanvas sized
 * identically) return { dx: 0, dy: 0, dw: w, dh: h } -- no bars. */
function _videoFitRect(source, w, h) {
  if (!source) return { dx: 0, dy: 0, dw: w, dh: h };
  const sw = source.videoWidth  || source.width  || 0;
  const sh = source.videoHeight || source.height || 0;
  if (sw <= 0 || sh <= 0) return { dx: 0, dy: 0, dw: w, dh: h };
  const srcAR = sw / sh;
  const dstAR = w  / h;
  let dw, dh;
  if (srcAR > dstAR) { dw = w; dh = w / srcAR; }
  else               { dh = h; dw = h * srcAR; }
  return { dx: (w - dw) / 2, dy: (h - dh) / 2, dw, dh };
}

/* Draw the latest detection onto the entry's 2D canvas. Called from
 * the detection rAF loop after detectForVideo. bgMode = 1 paints the
 * source video frame first (camera + overlay); bgMode = 0 leaves the
 * canvas transparent and only draws the skeleton (for blending the
 * overlay over a different source via BlendShader). */
function _drawHandLandmarkerOverlay(entry, params) {
  const ctx = entry.drawCtx;
  const cvs = entry.drawCanvas;
  if (!ctx || !cvs) return;
  const w = cvs.width, h = cvs.height;
  const result = entry.latest;
  const bgMode = (params && typeof params.bgMode === "number") ? params.bgMode : 1;
  const _mirrorParam = (params && typeof params.mirrored === "number") ? params.mirrored : 1;
  // v0.3.15 — mirror is a selfie-cam convenience only. When the
  // landmark is fed by an upstream wire (Webcam / VideoFile / any
  // shader-frag texture), the source already controls its own
  // orientation, so we display it as-is. Mirror only applies to the
  // own-getUserMedia fallback (no upstream).
  const _isOwnCamera = !entry.useTextureSource && !entry.sharedVideoEl;
  const mirrored = _isOwnCamera ? _mirrorParam : 0;
  const lineWidth = (params && typeof params.lineWidth === "number") ? params.lineWidth : 2.5;
  const dotRadius = (params && typeof params.dotRadius === "number") ? params.dotRadius : 4;

  // v0.3.17 — letterbox the bg + remap landmark coords into the same
  // fit rect so dots line up with the visible video content. Now also
  // handles texture-source bg (gpuInputCanvas, blitted from upstream
  // shader-frag the same frame) -- previously Hand's draw missed this
  // case + showed an empty bg when fed from Plasma / Butterflies / etc.
  let fit;
  if (bgMode === 0) {
    ctx.clearRect(0, 0, w, h);
    fit = { dx: 0, dy: 0, dw: w, dh: h };
  } else if (entry.useTextureSource && entry.gpuInputCanvas) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = _videoFitRect(entry.gpuInputCanvas, w, h);
    ctx.save();
    if (mirrored > 0.5) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(entry.gpuInputCanvas, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  } else if (entry.videoEl && entry.videoEl.readyState >= 2) {
    // Black-fill first so any letterbox bars are visible.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = _videoFitRect(entry.videoEl, w, h);
    ctx.save();
    if (mirrored > 0.5) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(entry.videoEl, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = { dx: 0, dy: 0, dw: w, dh: h };
  }
  entry._lastFit = fit;   // stashed for HandKeyboard zone overlay.
  if (!result || !result.landmarks) return;
  ctx.lineWidth = lineWidth;
  ctx.lineCap   = "round";
  for (let i = 0; i < result.landmarks.length; i++) {
    const hand = result.landmarks[i];
    if (!hand || hand.length < 21) continue;
    const handedness = (result.handednesses && result.handednesses[i] && result.handednesses[i][0]);
    // MediaPipe's "handedness" is from the camera's POV, so a
    // mirrored selfie cam reports the user's RIGHT hand as Left.
    // We swap names back in display land for intuitive "your left
    // hand is phosphor green" UX.
    let name = handedness ? handedness.categoryName : "Unknown";
    if (mirrored > 0.5) name = (name === "Left" ? "Right" : (name === "Right" ? "Left" : name));
    const color = (name === "Right") ? "rgb(131, 232, 255)"   // cyan
                : (name === "Left")  ? "rgb(200, 232, 90)"    // phosphor green
                : "rgb(232, 140, 60)";                         // amber fallback
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    // Skeleton lines.
    for (let k = 0; k < _HAND_CONNECTIONS.length; k++) {
      const [a, b] = _HAND_CONNECTIONS[k];
      let ax = hand[a].x, bx = hand[b].x;
      if (mirrored > 0.5) { ax = 1.0 - ax; bx = 1.0 - bx; }
      ctx.beginPath();
      ctx.moveTo(fit.dx + ax * fit.dw, fit.dy + hand[a].y * fit.dh);
      ctx.lineTo(fit.dx + bx * fit.dw, fit.dy + hand[b].y * fit.dh);
      ctx.stroke();
    }
    // Landmark dots. Wrist (0) bigger, fingertips bigger than knuckles.
    for (let j = 0; j < hand.length; j++) {
      const lm = hand[j];
      let x = lm.x;
      if (mirrored > 0.5) x = 1.0 - x;
      const r = (j === 0) ? dotRadius * 1.6
              : (j === 4 || j === 8 || j === 12 || j === 16 || j === 20) ? dotRadius * 1.2
              : dotRadius;
      ctx.beginPath();
      ctx.arc(fit.dx + x * fit.dw, fit.dy + lm.y * fit.dh, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* Per-node detection rAF loop. Runs detectForVideo every frame the
 * video element has a fresh frame ready. Result lands on entry.latest
 * for the wired-param resolver to pick up. Cancelled by dispose. */
function _startMediapipeLoop(nodeId) {
  const entry = _mediapipeNodes.get(nodeId);
  if (!entry || !entry.detector) return;
  let lastVideoTimeMs = -1;
  // v0.3.14 — full dynamic source resolution per tick. Tracks the
  // current "source key" (a hashable identity for the active source)
  // and transitions when it changes. Covers: wire added after init,
  // wire removed after init, fileUrl changed, source ready / not
  // ready / re-loading.
  //
  // Initial source key derives from whatever _ensureMediapipeSource
  // already set up during init -- so the first tick doesn't tear
  // down the just-allocated camera/canvas.
  function initialSourceKey(e) {
    if (e.awaitingUpstream)  return "pending:" + e.upstreamNodeId;
    if (e.useTextureSource)  return "texture:" + e.upstreamNodeId;
    if (e.sharedVideoEl)     return "video:"   + e.upstreamNodeId;
    if (e.videoEl)           return "owncam";
    return null;
  }
  let lastSourceKey = initialSourceKey(entry);
  let transitioning = false;

  function sourceKey(upstream) {
    if (!upstream)                  return "owncam";
    if (upstream.kind === "video")  return "video:"   + upstream.srcNodeId;
    if (upstream.kind === "texture") return "texture:" + upstream.srcNodeId;
    if (upstream.kind === "pending") return "pending:" + upstream.srcNodeId;
    return "owncam";
  }

  async function transition(e, upstream) {
    transitioning = true;
    try {
      // Tear down the previous source.
      if (e.stream && !e.sharedVideoEl) {
        try { e.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      }
      if (e.gpuInputCtx) {
        try { e.gpuInputCtx.unconfigure(); } catch (_) {}
      }
      e.stream            = null;
      e.videoEl           = null;
      e.gpuInputCanvas    = null;
      e.gpuInputCtx       = null;
      e.gpuInputBindGroup = null;
      e._gpuInputSrcView  = null;
      e.sharedVideoEl     = false;
      e.useTextureSource  = false;
      e.upstreamNodeId    = null;

      if (!upstream) {
        // No wire → own getUserMedia camera.
        await _ensureMediapipeCamera(e);
      } else if (upstream.kind === "video") {
        e.videoEl        = upstream.videoEl;
        e.sharedVideoEl  = true;
        e.upstreamNodeId = upstream.srcNodeId;
        console.log("[landmark] node " + nodeId + " → video source " +
                    upstream.srcType + "(" + upstream.srcNodeId + ")");
      } else if (upstream.kind === "texture") {
        _allocateGpuInputCanvas(e);
        e.useTextureSource = true;
        e.upstreamNodeId   = upstream.srcNodeId;
        console.log("[landmark] node " + nodeId + " → texture source " +
                    upstream.srcType + "(" + upstream.srcNodeId + ")");
      } else if (upstream.kind === "pending") {
        // Wire exists but upstream's videoEl isn't decoded yet. Don't
        // allocate anything; just wait. Next tick will retry.
        e.upstreamNodeId = upstream.srcNodeId;
      }
    } finally {
      transitioning = false;
      lastVideoTimeMs = -1;   // reset for new video stream's currentTime baseline
    }
  }

  const drawNow = (e) => {
    if (!e.drawCanvas) return;
    const liveNode = state && Array.isArray(state.nodes)
      ? state.nodes.find(n => n.id === nodeId) : null;
    const liveParams = liveNode ? liveNode.params : e.params;
    if (e.kind === "hand")              _drawHandLandmarkerOverlay(e, liveParams);
    else if (e.kind === "handkeyboard") _drawHandKeyboardOverlay(e, liveParams);
    else if (e.kind === "pose")         _drawPoseLandmarkerOverlay(e, liveParams);
    else if (e.kind === "face")         _drawFaceLandmarkerOverlay(e, liveParams);
  };

  const tick = () => {
    const e = _mediapipeNodes.get(nodeId);
    if (!e || !e.detector) return;   // disposed
    const upstream = _findUpstreamVideoSource(nodeId);
    const key = sourceKey(upstream);
    if (key !== lastSourceKey && !transitioning) {
      lastSourceKey = key;
      transition(e, upstream)
        .catch(err => console.warn("[landmark] transition failed:", err))
        .finally(() => { e.rafHandle = requestAnimationFrame(tick); });
      return;
    }
    if (transitioning) {
      // Don't double-arm; the transition's finally re-schedules.
      return;
    }
    // Pending state has no source to detect on yet.
    if (upstream && upstream.kind === "pending") {
      e.rafHandle = requestAnimationFrame(tick);
      return;
    }
    // Detection.
    if (e.useTextureSource) {
      if (e.gpuInputCanvas) {
        try {
          e.latest = e.detector.detectForVideo(e.gpuInputCanvas, performance.now());
          drawNow(e);
        } catch (_) {}
      }
    } else {
      const v = e.videoEl;
      if (v && v.readyState >= 2 && v.currentTime !== lastVideoTimeMs) {
        lastVideoTimeMs = v.currentTime;
        try {
          e.latest = e.detector.detectForVideo(v, performance.now());
          drawNow(e);
        } catch (_) {}
      }
    }
    e.rafHandle = requestAnimationFrame(tick);
  };
  entry.rafHandle = requestAnimationFrame(tick);
}

function _disposeMediapipeNode(nodeId) {
  const entry = _mediapipeNodes.get(nodeId);
  if (!entry) return;
  if (entry.rafHandle) { try { cancelAnimationFrame(entry.rafHandle); } catch (_) {} }
  if (entry.detector && typeof entry.detector.close === "function") {
    try { entry.detector.close(); } catch (_) {}
  }
  // v0.3.11 — only stop the stream / detach the videoEl if WE own
  // it. When the source video came from an upstream Webcam / VideoFile
  // via the new "video" texture input, the upstream node still owns
  // it and we'd be ripping the camera out from under siblings.
  if (!entry.sharedVideoEl) {
    if (entry.stream) {
      try { entry.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    if (entry.videoEl) {
      try { entry.videoEl.srcObject = null; entry.videoEl.pause(); } catch (_) {}
    }
  }
  // v0.3.12 — texture-source path: unconfigure the WebGPU context on
  // the per-node input canvas so its swap-chain resources are released.
  if (entry.gpuInputCtx) {
    try { entry.gpuInputCtx.unconfigure(); } catch (_) {}
  }
  entry.gpuInputCanvas    = null;
  entry.gpuInputCtx       = null;
  entry.gpuInputBindGroup = null;
  _mediapipeNodes.delete(nodeId);
}

/* Wired-param resolver helper for HandLandmarker. Outputs:
 *   numHands              integer 0..N
 *   h{n}_x / _y / _z      wrist position (normalized 0..1; mirrored for selfie cam)
 *   h{n}_pinch            thumb-tip ↔ index-tip distance, ~0..0.30 typical
 *   h{n}_open             0=fist, 1=spread (heuristic from avg fingertip distance)
 *   h{n}_rot              wrist→middle-base angle, -1..1 (radians/π)
 * where n = 1..maxHands. */
function _handLandmarkerValue(node, portName) {
  const entry = _mediapipeNodes.get(node.id);
  if (!entry) {
    // Lazy-init on first read. Returns 0 this tick; next reads pick up
    // detections once the model + camera are warm.
    _ensureHandLandmarker(node.id, node.params || {});
    return 0;
  }
  if (!entry.ready || !entry.latest) return 0;
  const hands = entry.latest.landmarks || [];
  // v0.3.7 — binary "is anything being tracked" gate. Useful for
  // triggering a synth on as soon as a hand enters the camera and
  // muting it when the hand leaves, regardless of gesture pose.
  if (portName === "present")  return hands.length > 0 ? 1 : 0;
  if (portName === "numHands") return hands.length;
  const m = portName.match(/^h(\d+)_(.+)$/);
  if (!m) return 0;
  const handIdx = parseInt(m[1], 10) - 1;
  const which = m[2];
  if (handIdx < 0 || handIdx >= hands.length) return 0;
  const hand = hands[handIdx];
  if (!hand || hand.length < 21) return 0;
  // Wrist = 0; fingertips: thumb 4, index 8, middle 12, ring 16, pinky 20.
  // Bases:    thumb 1, index 5, middle 9, ring 13, pinky 17.
  if (which === "x")   return hand[0].x;
  if (which === "y")   return hand[0].y;
  if (which === "z")   return hand[0].z;
  if (which === "pinch") {
    const dx = hand[4].x - hand[8].x;
    const dy = hand[4].y - hand[8].y;
    const dz = (hand[4].z || 0) - (hand[8].z || 0);
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }
  if (which === "open") {
    const wrist = hand[0];
    const tips = [4, 8, 12, 16, 20];
    let sum = 0;
    for (const t of tips) {
      const dx = hand[t].x - wrist.x;
      const dy = hand[t].y - wrist.y;
      sum += Math.sqrt(dx*dx + dy*dy);
    }
    const avg = sum / tips.length;
    // Empirically fist ~0.10, fully-spread ~0.30; map to [0, 1].
    return Math.max(0, Math.min(1, (avg - 0.10) / 0.20));
  }
  if (which === "rot") {
    const wrist = hand[0];
    const mb = hand[9];
    return Math.atan2(mb.y - wrist.y, mb.x - wrist.x) / Math.PI;
  }
  return 0;
}

/* =========================================================================
 * v0.3.9 — PoseLandmarker (MediaPipe full-body pose detection)
 *
 * 33 landmarks per detected person. We track the major joints (head,
 * shoulders, elbows, wrists, hips, knees) and expose them as 22 x/y
 * pairs + present + numPoses. Same init + detection-loop + drawing
 * pattern as HandLandmarker; the body-skeleton draws as a stick
 * figure in cyan with phosphor dots at the joints. */

const _POSE_CONNECTIONS = [
  // Shoulders + torso square
  [11, 12], [11, 23], [12, 24], [23, 24],
  // Left arm
  [11, 13], [13, 15],
  // Right arm
  [12, 14], [14, 16],
  // Left leg
  [23, 25], [25, 27],
  // Right leg
  [24, 26], [26, 28]
];

async function _ensurePoseLandmarker(nodeId, params) {
  let entry = _mediapipeNodes.get(nodeId);
  if (entry) return entry;
  entry = {
    kind: "pose", detector: null, videoEl: null, stream: null,
    latest: null, ready: false, requesting: true, error: null, rafHandle: null,
    drawCanvas: null, drawCtx: null, params: params || {}
  };
  _mediapipeNodes.set(nodeId, entry);
  try {
    const { PoseLandmarker, filesets } = await _loadMediaPipeVision();
    await _ensureMediapipeSource(nodeId, entry);
    entry.detector = await PoseLandmarker.createFromOptions(filesets, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numPoses: Math.max(1, Math.min(4, (params && params.maxPoses) || 1)),
      minPoseDetectionConfidence: (params && typeof params.minConfidence === "number") ? params.minConfidence : 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    const w = Visual.fbWidth  || 1920;
    const h = Visual.fbHeight || 1080;
    entry.drawCanvas = document.createElement("canvas");
    entry.drawCanvas.width  = w;
    entry.drawCanvas.height = h;
    entry.drawCtx = entry.drawCanvas.getContext("2d", { alpha: true });
    entry.ready = true;
    console.log("[poselandmarker] node " + nodeId + " ready (canvas=" + w + "×" + h + ")");
    _startMediapipeLoop(nodeId);
  } catch (e) {
    console.warn("[poselandmarker] init failed for node " + nodeId + ":", e);
    entry.error = e;
  } finally {
    entry.requesting = false;
  }
  return entry;
}

function _drawPoseLandmarkerOverlay(entry, params) {
  const ctx = entry.drawCtx;
  const cvs = entry.drawCanvas;
  if (!ctx || !cvs) return;
  const w = cvs.width, h = cvs.height;
  const result = entry.latest;
  const bgMode = (params && typeof params.bgMode === "number") ? params.bgMode : 1;
  const _mirrorParam = (params && typeof params.mirrored === "number") ? params.mirrored : 1;
  // v0.3.15 — mirror is a selfie-cam convenience only. When the
  // landmark is fed by an upstream wire (Webcam / VideoFile / any
  // shader-frag texture), the source already controls its own
  // orientation, so we display it as-is. Mirror only applies to the
  // own-getUserMedia fallback (no upstream).
  const _isOwnCamera = !entry.useTextureSource && !entry.sharedVideoEl;
  const mirrored = _isOwnCamera ? _mirrorParam : 0;
  const lineWidth = (params && typeof params.lineWidth === "number") ? params.lineWidth : 3;
  const dotRadius = (params && typeof params.dotRadius === "number") ? params.dotRadius : 5;

  // v0.3.17 — letterbox the bg + remap landmark coords into the same
  // fit rect so dots line up with the visible video content.
  let fit;
  if (bgMode === 0) {
    ctx.clearRect(0, 0, w, h);
    fit = { dx: 0, dy: 0, dw: w, dh: h };
  } else if (entry.useTextureSource && entry.gpuInputCanvas) {
    // v0.3.12 — bg comes from the upstream shader-frag (Plasma /
    // Butterflies / etc) blitted to entry.gpuInputCanvas earlier in
    // the same visual frame. Mirror transform is applied here so
    // the landmark coord mirroring (in the loop below) lines up.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = _videoFitRect(entry.gpuInputCanvas, w, h);
    ctx.save();
    if (mirrored > 0.5) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(entry.gpuInputCanvas, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  } else if (entry.videoEl && entry.videoEl.readyState >= 2) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = _videoFitRect(entry.videoEl, w, h);
    ctx.save();
    if (mirrored > 0.5) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(entry.videoEl, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = { dx: 0, dy: 0, dw: w, dh: h };
  }
  entry._lastFit = fit;
  if (!result || !result.landmarks || result.landmarks.length === 0) return;
  const skeletonColor   = "rgb(131, 232, 255)";   // cyan
  const jointColor      = "rgb(200, 232, 90)";    // phosphor
  ctx.lineWidth = lineWidth;
  ctx.lineCap   = "round";
  for (let pi = 0; pi < result.landmarks.length; pi++) {
    const pose = result.landmarks[pi];
    if (!pose || pose.length < 33) continue;
    ctx.strokeStyle = skeletonColor;
    for (let k = 0; k < _POSE_CONNECTIONS.length; k++) {
      const [a, b] = _POSE_CONNECTIONS[k];
      const pa = pose[a], pb = pose[b];
      if (!pa || !pb) continue;
      let ax = pa.x, bx = pb.x;
      if (mirrored > 0.5) { ax = 1.0 - ax; bx = 1.0 - bx; }
      ctx.beginPath();
      ctx.moveTo(fit.dx + ax * fit.dw, fit.dy + pa.y * fit.dh);
      ctx.lineTo(fit.dx + bx * fit.dw, fit.dy + pb.y * fit.dh);
      ctx.stroke();
    }
    ctx.fillStyle = jointColor;
    // Highlight the major joints — index list mirrors what we expose
    // as output ports so the on-screen dots map to the wireable values.
    const KEY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26];
    for (const j of KEY_JOINTS) {
      const lm = pose[j];
      if (!lm) continue;
      let x = lm.x;
      if (mirrored > 0.5) x = 1.0 - x;
      const r = (j === 0) ? dotRadius * 1.4 : dotRadius;
      ctx.beginPath();
      ctx.arc(fit.dx + x * fit.dw, fit.dy + lm.y * fit.dh, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function _poseLandmarkerValue(node, portName) {
  const entry = _mediapipeNodes.get(node.id);
  if (!entry) { _ensurePoseLandmarker(node.id, node.params || {}); return 0; }
  if (!entry.ready || !entry.latest) return 0;
  const poses = entry.latest.landmarks || [];
  if (portName === "present")  return poses.length > 0 ? 1 : 0;
  if (portName === "numPoses") return poses.length;
  if (poses.length === 0) return 0;
  const pose = poses[0];
  if (!pose || pose.length < 33) return 0;
  // landmark-index map for the surfaced ports
  const idx = ({
    nose_x: 0,  nose_y: 0,
    lshoulder_x: 11, lshoulder_y: 11,
    rshoulder_x: 12, rshoulder_y: 12,
    lelbow_x: 13,    lelbow_y: 13,
    relbow_x: 14,    relbow_y: 14,
    lwrist_x: 15,    lwrist_y: 15,
    rwrist_x: 16,    rwrist_y: 16,
    lhip_x: 23,      lhip_y: 23,
    rhip_x: 24,      rhip_y: 24,
    lknee_x: 25,     lknee_y: 25,
    rknee_x: 26,     rknee_y: 26
  })[portName];
  if (idx == null) return 0;
  const lm = pose[idx];
  if (!lm) return 0;
  return portName.endsWith("_x") ? lm.x : lm.y;
}

/* =========================================================================
 * v0.3.9 — FaceLandmarker (468-point face mesh + 52 blendshapes)
 *
 * We don't try to expose 468 landmarks as port wires (overwhelming).
 * Instead we surface the 14 most expressive blendshape coefficients
 * (0..1) plus face position (center of mass). Blendshapes are
 * MediaPipe's expression-coefficient outputs -- pre-trained to
 * detect smile, jaw drop, eye blinks, brow movement, etc. */

async function _ensureFaceLandmarker(nodeId, params) {
  let entry = _mediapipeNodes.get(nodeId);
  if (entry) return entry;
  entry = {
    kind: "face", detector: null, videoEl: null, stream: null,
    latest: null, ready: false, requesting: true, error: null, rafHandle: null,
    drawCanvas: null, drawCtx: null, params: params || {}
  };
  _mediapipeNodes.set(nodeId, entry);
  try {
    const { FaceLandmarker, filesets } = await _loadMediaPipeVision();
    await _ensureMediapipeSource(nodeId, entry);
    entry.detector = await FaceLandmarker.createFromOptions(filesets, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numFaces: Math.max(1, Math.min(4, (params && params.maxFaces) || 1)),
      minFaceDetectionConfidence: (params && typeof params.minConfidence === "number") ? params.minConfidence : 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: true
    });
    const w = Visual.fbWidth  || 1920;
    const h = Visual.fbHeight || 1080;
    entry.drawCanvas = document.createElement("canvas");
    entry.drawCanvas.width  = w;
    entry.drawCanvas.height = h;
    entry.drawCtx = entry.drawCanvas.getContext("2d", { alpha: true });
    entry.ready = true;
    console.log("[facelandmarker] node " + nodeId + " ready (canvas=" + w + "×" + h + ")");
    _startMediapipeLoop(nodeId);
  } catch (e) {
    console.warn("[facelandmarker] init failed for node " + nodeId + ":", e);
    entry.error = e;
  } finally {
    entry.requesting = false;
  }
  return entry;
}

function _drawFaceLandmarkerOverlay(entry, params) {
  const ctx = entry.drawCtx;
  const cvs = entry.drawCanvas;
  if (!ctx || !cvs) return;
  const w = cvs.width, h = cvs.height;
  const result = entry.latest;
  const bgMode = (params && typeof params.bgMode === "number") ? params.bgMode : 1;
  const _mirrorParam = (params && typeof params.mirrored === "number") ? params.mirrored : 1;
  // v0.3.15 — mirror is a selfie-cam convenience only. When the
  // landmark is fed by an upstream wire (Webcam / VideoFile / any
  // shader-frag texture), the source already controls its own
  // orientation, so we display it as-is. Mirror only applies to the
  // own-getUserMedia fallback (no upstream).
  const _isOwnCamera = !entry.useTextureSource && !entry.sharedVideoEl;
  const mirrored = _isOwnCamera ? _mirrorParam : 0;
  const dotRadius = (params && typeof params.dotRadius === "number") ? params.dotRadius : 1.5;

  // v0.3.17 — letterbox the bg + remap landmark coords into the same
  // fit rect so dots line up with the visible video content.
  let fit;
  if (bgMode === 0) {
    ctx.clearRect(0, 0, w, h);
    fit = { dx: 0, dy: 0, dw: w, dh: h };
  } else if (entry.useTextureSource && entry.gpuInputCanvas) {
    // v0.3.12 — bg comes from the upstream shader-frag (Plasma /
    // Butterflies / etc) blitted to entry.gpuInputCanvas earlier in
    // the same visual frame. Mirror transform is applied here so
    // the landmark coord mirroring (in the loop below) lines up.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = _videoFitRect(entry.gpuInputCanvas, w, h);
    ctx.save();
    if (mirrored > 0.5) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(entry.gpuInputCanvas, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  } else if (entry.videoEl && entry.videoEl.readyState >= 2) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = _videoFitRect(entry.videoEl, w, h);
    ctx.save();
    if (mirrored > 0.5) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(entry.videoEl, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = { dx: 0, dy: 0, dw: w, dh: h };
  }
  entry._lastFit = fit;
  if (!result || !result.faceLandmarks) return;
  // Draw the 468-point mesh as a phosphor dot cloud. Light alpha so
  // the face stays readable underneath.
  ctx.fillStyle = "rgba(200, 232, 90, 0.65)";
  for (let fi = 0; fi < result.faceLandmarks.length; fi++) {
    const mesh = result.faceLandmarks[fi];
    for (let j = 0; j < mesh.length; j++) {
      const lm = mesh[j];
      let x = lm.x;
      if (mirrored > 0.5) x = 1.0 - x;
      ctx.beginPath();
      ctx.arc(fit.dx + x * fit.dw, fit.dy + lm.y * fit.dh, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* Helper: extract a blendshape coefficient by MediaPipe category name.
 * Result.faceBlendshapes[faceIdx].categories is an array of
 * { categoryName, score, index, displayName }. Returns 0 if missing. */
function _faceBlendshape(result, name) {
  if (!result || !result.faceBlendshapes || result.faceBlendshapes.length === 0) return 0;
  const cats = result.faceBlendshapes[0].categories || [];
  for (let i = 0; i < cats.length; i++) {
    if (cats[i].categoryName === name) return cats[i].score || 0;
  }
  return 0;
}

function _faceLandmarkerValue(node, portName) {
  const entry = _mediapipeNodes.get(node.id);
  if (!entry) { _ensureFaceLandmarker(node.id, node.params || {}); return 0; }
  if (!entry.ready || !entry.latest) return 0;
  const r = entry.latest;
  const faces = r.faceLandmarks || [];
  if (portName === "present")  return faces.length > 0 ? 1 : 0;
  if (portName === "numFaces") return faces.length;
  if (faces.length === 0) return 0;
  // Face position = nose-tip landmark (index 1 in MediaPipe's 468-pt mesh).
  if (portName === "face_x") return faces[0][1] ? faces[0][1].x : 0;
  if (portName === "face_y") return faces[0][1] ? faces[0][1].y : 0;
  // Blendshape lookup -- categoryName matches our port name verbatim.
  return _faceBlendshape(r, portName);
}

/* =========================================================================
 * v0.3.10 — HandKeyboard (MediaPipe hand-x → musical scale)
 *
 * Same MediaPipe HandLandmarker detector as the HandLandmarker node,
 * but the resolver maps wrist x-position (after mirror handling) to
 * a scale-degree index → MIDI note → frequency. The canvas overlay
 * draws hand skeleton + thin vertical guide lines marking each
 * scale-step zone, so the user can see at a glance where to point
 * the hand for each note. */

const _SCALE_INTERVALS = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 3, 5, 7, 10],           // minor pentatonic — friendlier for live noodling
  chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

async function _ensureHandKeyboard(nodeId, params) {
  let entry = _mediapipeNodes.get(nodeId);
  if (entry) return entry;
  entry = {
    kind: "handkeyboard", detector: null, videoEl: null, stream: null,
    latest: null, ready: false, requesting: true, error: null, rafHandle: null,
    drawCanvas: null, drawCtx: null, params: params || {}
  };
  _mediapipeNodes.set(nodeId, entry);
  try {
    const { HandLandmarker, filesets } = await _loadMediaPipeVision();
    await _ensureMediapipeSource(nodeId, entry);
    entry.detector = await HandLandmarker.createFromOptions(filesets, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numHands: Math.max(1, Math.min(4, (params && params.maxHands) || 1)),
      minHandDetectionConfidence: (params && typeof params.minConfidence === "number") ? params.minConfidence : 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    const w = Visual.fbWidth  || 1920;
    const h = Visual.fbHeight || 1080;
    entry.drawCanvas = document.createElement("canvas");
    entry.drawCanvas.width  = w;
    entry.drawCanvas.height = h;
    entry.drawCtx = entry.drawCanvas.getContext("2d", { alpha: true });
    entry.ready = true;
    console.log("[handkeyboard] node " + nodeId + " ready (canvas=" + w + "×" + h + ")");
    _startMediapipeLoop(nodeId);
  } catch (e) {
    console.warn("[handkeyboard] init failed for node " + nodeId + ":", e);
    entry.error = e;
  } finally {
    entry.requesting = false;
  }
  return entry;
}

/* Compute (noteIdx, midi, freq) for a given x-position + scale config.
 * x is clamped to [0, 1] after mirror handling by the caller. Returns
 * null when the scale lookup is empty (defensive; should never happen
 * with the registry default of "pentatonic"). */
function _handKeyboardScaleMap(x, params) {
  const mode      = (params && params.scaleMode) || "pentatonic";
  const octaves   = Math.max(1, Math.min(4, (params && params.octaves) || 2));
  const scaleRoot = (params && typeof params.scaleRoot === "number") ? params.scaleRoot : 60;
  const scale     = _SCALE_INTERVALS[mode] || _SCALE_INTERVALS.pentatonic;
  if (!scale.length) return null;
  const totalSteps = scale.length * octaves;
  let step = Math.floor(x * totalSteps);
  if (step < 0) step = 0;
  if (step >= totalSteps) step = totalSteps - 1;
  const octave        = Math.floor(step / scale.length);
  const stepInOctave  = step % scale.length;
  const midi          = scaleRoot + octave * 12 + scale[stepInOctave];
  const freq          = 440 * Math.pow(2, (midi - 69) / 12);
  return { noteIdx: step, midi, freq, totalSteps };
}

function _drawHandKeyboardOverlay(entry, params) {
  // First draw the standard hand-tracking overlay (camera + skeleton).
  _drawHandLandmarkerOverlay(entry, params);
  const ctx = entry.drawCtx;
  const cvs = entry.drawCanvas;
  if (!ctx || !cvs) return;
  const w = cvs.width, h = cvs.height;
  const mode = (params && params.scaleMode) || "pentatonic";
  const scale = _SCALE_INTERVALS[mode] || _SCALE_INTERVALS.pentatonic;
  const octaves = Math.max(1, Math.min(4, (params && params.octaves) || 2));
  const totalSteps = scale.length * octaves;
  if (totalSteps < 1) return;
  // Highlight the active zone first so the skeleton draws over it.
  const r = entry.latest;
  let activeStep = -1;
  if (r && r.landmarks && r.landmarks.length > 0) {
    const hand = r.landmarks[0];
    if (hand && hand.length > 0) {
      let hx = hand[0].x;
      const mirrored = (params && params.mirrored) ? 1 : 0;
      if (mirrored) hx = 1.0 - hx;
      if (hx >= 0 && hx <= 1) {
        activeStep = Math.min(totalSteps - 1, Math.floor(hx * totalSteps));
      }
    }
  }
  // v0.3.17 — overlay zones in the letterboxed source rect (stashed
  // by the base draw above), not the full canvas. The wrist x in the
  // scale-map call below is in source-normalized [0,1] space, so the
  // zone the wrist lights up has to be drawn inside the same source
  // rect or the overlay drifts off the wrist position.
  const fit = entry._lastFit || { dx: 0, dy: 0, dw: w, dh: h };
  if (activeStep >= 0) {
    const zoneL = fit.dx + (activeStep    ) / totalSteps * fit.dw;
    const zoneR = fit.dx + (activeStep + 1) / totalSteps * fit.dw;
    ctx.fillStyle = "rgba(200, 232, 90, 0.18)";
    ctx.fillRect(zoneL, fit.dy, zoneR - zoneL, fit.dh);
  }
  // Zone divider lines + octave dividers (heavier).
  ctx.strokeStyle = "rgba(178, 100, 200, 0.40)";
  ctx.lineWidth = 1;
  for (let i = 1; i < totalSteps; i++) {
    const isOctaveBoundary = (i % scale.length === 0);
    ctx.lineWidth = isOctaveBoundary ? 2 : 1;
    ctx.strokeStyle = isOctaveBoundary
      ? "rgba(178, 100, 200, 0.75)"
      : "rgba(178, 100, 200, 0.30)";
    const x = fit.dx + (i / totalSteps) * fit.dw;
    ctx.beginPath();
    ctx.moveTo(x, fit.dy + fit.dh * 0.78);
    ctx.lineTo(x, fit.dy + fit.dh);
    ctx.stroke();
  }
}

function _handKeyboardValue(node, portName) {
  const entry = _mediapipeNodes.get(node.id);
  if (!entry) { _ensureHandKeyboard(node.id, node.params || {}); return 0; }
  if (!entry.ready || !entry.latest) return 0;
  const hands = entry.latest.landmarks || [];
  const present = hands.length > 0 ? 1 : 0;
  if (portName === "present" || portName === "gate") return present;
  if (!present) return 0;
  const hand = hands[0];
  if (!hand || hand.length < 21) return 0;
  // Use wrist (0) x — palm center would be more stable but wrist
  // is more responsive for "pointing" gestures.
  let x = hand[0].x;
  const mirrored = (node.params && node.params.mirrored) ? 1 : 0;
  if (mirrored) x = 1.0 - x;
  if (x < 0) x = 0; if (x > 1) x = 1;
  const mapped = _handKeyboardScaleMap(x, node.params || {});
  if (!mapped) return 0;
  if (portName === "freq")     return mapped.freq;
  if (portName === "midi")     return mapped.midi;
  if (portName === "note_idx") return mapped.noteIdx;
  return 0;
}

/* =========================================================================
 * v0.3.37 -- BlobTracker. Classical-CV blob detection + temporal
 * tracking with stable IDs and exponential smoothing.
 *
 * Pipeline per frame (all CPU-side):
 *   1. Sample source video onto a 160x90 work canvas (~14k px; fast
 *      to getImageData + iterate).
 *   2. Build a 1-bit mask based on the active detection mode:
 *      - luma: pixel.luma >= threshold
 *      - color: rgb-distance to (targetR/G/B) <= colorTolerance
 *      - motion: |pixel.luma - prevFrame.luma| > threshold
 *   3. Two-pass connected-components via union-find on the mask.
 *   4. Compute area + centroid + bounding box per component;
 *      filter by minBlobSize; sort by area descending; keep top N.
 *   5. Greedy nearest-neighbor match to previous frame's blobs
 *      (within a max distance) -- carries stable id + age.
 *   6. Exponential smoothing on x, y, size.
 *
 * Performance: ~1-2 ms per frame on a modern machine. Sub-rAF cost
 * even at 60fps. No model download, no ML, no permission prompts
 * beyond the regular getUserMedia (only fires when no upstream
 * video is wired). ======================================================================== */

const _BLOB_GRID_W = 160;
const _BLOB_GRID_H = 90;

async function _ensureBlobTracker(nodeId, params) {
  let entry = _mediapipeNodes.get(nodeId);
  if (entry) return entry;
  entry = {
    kind: "blob",
    videoEl: null, stream: null,
    latest: null, ready: false, requesting: true, error: null, rafHandle: null,
    drawCanvas: null, drawCtx: null,
    smallCanvas: null, smallCtx: null,
    prevFrameLuma: null,
    tracked: [],            // [{id, x, y, size, minX, minY, maxX, maxY, age}]
    nextId: 1,
    params: params || {}
  };
  _mediapipeNodes.set(nodeId, entry);
  try {
    // Source resolution: same path MediaPipe uses -- supports
    // upstream Webcam / VideoFile / ScreenShare wires + falls back
    // to own getUserMedia camera. Sets entry.videoEl + sharedVideoEl
    // flag.
    await _ensureMediapipeSource(nodeId, entry);
    const w = Visual.fbWidth  || 1920;
    const h = Visual.fbHeight || 1080;
    entry.drawCanvas = document.createElement("canvas");
    entry.drawCanvas.width  = w;
    entry.drawCanvas.height = h;
    entry.drawCtx = entry.drawCanvas.getContext("2d", { alpha: true });
    // Small work canvas for downsampled pixel access. willReadFrequently
    // is the spec'd hint for getImageData-heavy paths (Chrome 110+).
    entry.smallCanvas = document.createElement("canvas");
    entry.smallCanvas.width  = _BLOB_GRID_W;
    entry.smallCanvas.height = _BLOB_GRID_H;
    entry.smallCtx = entry.smallCanvas.getContext("2d", {
      alpha: false, willReadFrequently: true
    });
    entry.ready = true;
    console.log("[blobtracker] node " + nodeId + " ready (grid=" +
                _BLOB_GRID_W + "x" + _BLOB_GRID_H + ", canvas=" + w + "x" + h + ")");
    _startBlobTrackerLoop(nodeId);
  } catch (e) {
    console.warn("[blobtracker] init failed for node " + nodeId + ":", e);
    entry.error = e;
  } finally {
    entry.requesting = false;
  }
  return entry;
}

/* Per-frame detection rAF. Cancels cleanly via dispose; no work when
 * the source video isn't decoded yet. */
function _startBlobTrackerLoop(nodeId) {
  const entry = _mediapipeNodes.get(nodeId);
  if (!entry) return;
  function tick() {
    if (!_mediapipeNodes.has(nodeId)) return;   // disposed
    const e = _mediapipeNodes.get(nodeId);
    if (e !== entry) return;
    try {
      // v0.3.40 -- two valid source types:
      //   (a) own-camera or upstream video-element wire -> e.videoEl
      //       has the live frames (HTMLVideoElement readyState gate).
      //   (b) upstream texture source (e.g. ShapeTunnel.out) ->
      //       e.gpuInputCanvas holds the blitted upstream content,
      //       populated by the visual render encoder each frame
      //       (see _encodeShaderFragPassForPlan ai-vision-canvas
      //       branch). The texture canvas has no readyState; we
      //       just need useTextureSource + the canvas object.
      // The previous version only checked (a) so texture-source
      // wires never triggered detection.
      const hasVideo   = e.videoEl && e.videoEl.readyState >= 2 && e.videoEl.videoWidth > 0;
      const hasTexture = e.useTextureSource && e.gpuInputCanvas;
      if (hasVideo || hasTexture) {
        _processBlobFrame(e);
      }
      _drawBlobOverlay(e, e.params);
    } catch (err) {
      // Don't kill the loop on a single bad frame; just log + retry.
      console.warn("[blobtracker] tick error:", err);
    }
    e.rafHandle = requestAnimationFrame(tick);
  }
  entry.rafHandle = requestAnimationFrame(tick);
}

/* Sample the video, threshold, label connected components, match to
 * previous frame's blobs. Writes entry.latest = { blobs: [...] }. */
function _processBlobFrame(entry) {
  const sm = entry.smallCanvas;
  const ctx = entry.smallCtx;
  const W = sm.width, H = sm.height;
  const params = entry.params || {};

  // Mirror flag only applies when source is the OWN getUserMedia
  // selfie cam -- upstream wires (VideoFile, Webcam shared, texture
  // sources) are already authored at their intended orientation.
  const isOwnCamera = !entry.useTextureSource && !entry.sharedVideoEl;
  const mirrorParam = (typeof params.mirrored === "number") ? params.mirrored : 1;
  const mirrored = isOwnCamera ? mirrorParam : 0;

  // Sample video onto the small work canvas. The aspect-fit on the
  // overlay is centered (letterbox style), but for blob detection
  // we stretch-fit to fill the whole 160x90 grid -- centroid x/y
  // map straight back to [0, 1] UV on the source's content rect.
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (mirrored > 0.5) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  // Source can be the videoEl OR the gpuInputCanvas (texture-source path).
  const src = (entry.useTextureSource && entry.gpuInputCanvas) ? entry.gpuInputCanvas
                                                                : entry.videoEl;
  if (src) {
    try { ctx.drawImage(src, 0, 0, W, H); } catch (_) {}
  }
  ctx.restore();

  let imgData;
  try { imgData = ctx.getImageData(0, 0, W, H); } catch (_) { return; }
  const px = imgData.data;
  const total = W * H;

  // Build the mask based on detection mode.
  const mode      = (typeof params.mode      === "number") ? params.mode      : 0;
  const threshold = (typeof params.threshold === "number") ? params.threshold : 0.6;
  const tgtR      = ((typeof params.targetR === "number") ? params.targetR : 1.0) * 255;
  const tgtG      = ((typeof params.targetG === "number") ? params.targetG : 0.2) * 255;
  const tgtB      = ((typeof params.targetB === "number") ? params.targetB : 0.2) * 255;
  const colTol    = ((typeof params.colorTolerance === "number") ? params.colorTolerance : 0.25) * 255;

  const mask = new Uint8Array(total);
  if (mode === 1) {
    // Color match.
    const tolSq = colTol * colTol * 3;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const dr = px[i]     - tgtR;
      const dg = px[i + 1] - tgtG;
      const db = px[i + 2] - tgtB;
      mask[j] = (dr * dr + dg * dg + db * db) <= tolSq ? 1 : 0;
    }
  } else if (mode === 2) {
    // Motion: |this frame luma - last frame luma| > threshold.
    if (!entry.prevFrameLuma || entry.prevFrameLuma.length !== total) {
      entry.prevFrameLuma = new Uint8Array(total);
    }
    const mt = threshold * 64;   // 0..1 -> 0..64 luma diff (8-bit space)
    const prev = entry.prevFrameLuma;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const luma = (px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722) | 0;
      const diff = luma > prev[j] ? luma - prev[j] : prev[j] - luma;
      mask[j] = diff > mt ? 1 : 0;
      prev[j] = luma;
    }
  } else if (mode === 3) {
    // v0.3.41 -- 'value' mode (HSV value / max-channel). Picks up
    // saturated colors regardless of hue. Rec.709 luma's weighting
    // (R=0.21, G=0.72, B=0.07) makes red and especially blue shapes
    // invisible to the 'luma' threshold even when fully bright; max
    // channel treats them equally. Best mode for synthetic colorful
    // content (ShapeTunnel / Plasma / Butterflies); use 'luma' for
    // real-world camera content where luminance is the natural axis.
    const vt = threshold * 255;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const v = r > g ? (r > b ? r : b) : (g > b ? g : b);
      mask[j] = v >= vt ? 1 : 0;
    }
  } else {
    // Luma threshold (default). Rec.709 weighted -- good for real
    // video where luminance is the perceptually natural axis. For
    // colorful synthetic content prefer mode='value' which weights
    // all hues equally.
    const lt = threshold * 255;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const luma = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
      mask[j] = luma >= lt ? 1 : 0;
    }
  }

  // Connected components via union-find. 4-connectivity (left + up
  // neighbors during raster scan). labelParent[i] = parent of label i;
  // findRoot collapses paths.
  const labels = new Int32Array(total);
  const parent = [0];
  function findRoot(l) {
    let r = l;
    while (parent[r] !== r) r = parent[r];
    // Path compression
    let cur = l;
    while (parent[cur] !== r) { const next = parent[cur]; parent[cur] = r; cur = next; }
    return r;
  }
  function unite(a, b) {
    const ra = findRoot(a);
    const rb = findRoot(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else         parent[ra] = rb;
  }
  let nextLabel = 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!mask[idx]) continue;
      const left = x > 0 ? labels[idx - 1] : 0;
      const up   = y > 0 ? labels[idx - W] : 0;
      if (left && up) {
        labels[idx] = left < up ? left : up;
        if (left !== up) unite(left, up);
      } else if (left) {
        labels[idx] = left;
      } else if (up) {
        labels[idx] = up;
      } else {
        labels[idx] = nextLabel;
        parent[nextLabel] = nextLabel;
        nextLabel++;
      }
    }
  }

  // Accumulate per-component stats.
  const stats = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const l = labels[idx];
      if (!l) continue;
      const r = findRoot(l);
      let s = stats.get(r);
      if (!s) { s = { area: 0, sx: 0, sy: 0, mnX: x, mnY: y, mxX: x, mxY: y }; stats.set(r, s); }
      s.area++;
      s.sx += x;
      s.sy += y;
      if (x < s.mnX) s.mnX = x;
      if (x > s.mxX) s.mxX = x;
      if (y < s.mnY) s.mnY = y;
      if (y > s.mxY) s.mxY = y;
    }
  }

  // Filter + sort + cap.
  const minSz = Math.max(1, (typeof params.minBlobSize === "number") ? params.minBlobSize : 30);
  const maxBlobs = Math.max(1, Math.min(4, (typeof params.maxBlobs === "number") ? params.maxBlobs : 4));
  const found = [];
  for (const s of stats.values()) {
    if (s.area < minSz) continue;
    found.push({
      x: s.sx / s.area / W,
      y: s.sy / s.area / H,
      size: s.area / total,
      minX: s.mnX / W, minY: s.mnY / H,
      maxX: (s.mxX + 1) / W, maxY: (s.mxY + 1) / H
    });
  }
  found.sort((a, b) => b.size - a.size);
  const topN = found.slice(0, maxBlobs);

  // Greedy nearest-neighbor track-association. Each new blob picks
  // the closest still-unmatched previous blob within MAX_MATCH_DIST.
  // Un-matched previous blobs decay out; un-matched new blobs get a
  // fresh ID.
  const smoothing = Math.max(0, Math.min(0.95,
    (typeof params.smoothing === "number") ? params.smoothing : 0.6));
  const MAX_MATCH_DIST_SQ = 0.15 * 0.15;   // 15% of frame width
  const prev = entry.tracked || [];
  const used = new Uint8Array(prev.length);
  const next = [];
  for (const b of topN) {
    let bestIdx = -1, bestD = MAX_MATCH_DIST_SQ;
    for (let i = 0; i < prev.length; i++) {
      if (used[i]) continue;
      const dx = prev[i].x - b.x;
      const dy = prev[i].y - b.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      used[bestIdx] = 1;
      const p = prev[bestIdx];
      next.push({
        id:   p.id,
        x:    p.x    * smoothing + b.x    * (1 - smoothing),
        y:    p.y    * smoothing + b.y    * (1 - smoothing),
        size: p.size * smoothing + b.size * (1 - smoothing),
        minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY,
        age:  p.age + 1
      });
    } else {
      next.push({
        id:   entry.nextId++,
        x:    b.x, y: b.y, size: b.size,
        minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY,
        age:  1
      });
    }
  }
  // Stable ordering: keep blobs in id order so b1 / b2 / etc don't
  // flip across frames when sizes shift.
  next.sort((a, b) => a.id - b.id);
  entry.tracked = next;
  entry.latest = { blobs: next };
}

/* Draw the source video as background + bounding box + centroid +
 * stable id label per tracked blob. Mirrors the landmark-overlay
 * pattern: clean letterboxed source + colored overlays per blob. */
function _drawBlobOverlay(entry, params) {
  const ctx = entry.drawCtx;
  const cvs = entry.drawCanvas;
  if (!ctx || !cvs) return;
  const w = cvs.width, h = cvs.height;
  params = params || {};
  const bgMode = (typeof params.bgMode === "number") ? params.bgMode : 1;
  const isOwnCamera = !entry.useTextureSource && !entry.sharedVideoEl;
  const mirrored = isOwnCamera ? ((typeof params.mirrored === "number") ? params.mirrored : 1) : 0;
  const lineWidth = (typeof params.lineWidth === "number") ? params.lineWidth : 2.5;
  const dotRadius = (typeof params.dotRadius === "number") ? params.dotRadius : 5;

  let fit;
  if (bgMode === 0) {
    ctx.clearRect(0, 0, w, h);
    fit = { dx: 0, dy: 0, dw: w, dh: h };
  } else if (bgMode === 2 && entry.smallCanvas) {
    // Mask preview: upscale the small canvas (last thresholded view)
    // to drawCanvas. Useful for tuning threshold + targetRGB live.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = _videoFitRect(entry.smallCanvas, w, h);
    ctx.save();
    if (mirrored > 0.5) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(entry.smallCanvas, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  } else if (entry.useTextureSource && entry.gpuInputCanvas) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = _videoFitRect(entry.gpuInputCanvas, w, h);
    ctx.save();
    if (mirrored > 0.5) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(entry.gpuInputCanvas, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  } else if (entry.videoEl && entry.videoEl.readyState >= 2) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = _videoFitRect(entry.videoEl, w, h);
    ctx.save();
    if (mirrored > 0.5) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(entry.videoEl, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    fit = { dx: 0, dy: 0, dw: w, dh: h };
  }
  entry._lastFit = fit;

  const result = entry.latest;
  if (!result || !result.blobs || result.blobs.length === 0) return;

  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.font = "bold 16px monospace";
  ctx.textBaseline = "top";

  for (let i = 0; i < result.blobs.length; i++) {
    const b = result.blobs[i];
    // Color cycle by id; 60-degree HSL hue steps give 6 distinct
    // colors before repeating (more than the 4-blob cap).
    const hue = ((b.id - 1) * 67) % 360;
    const stroke = "hsla(" + hue + ", 90%, 65%, 0.95)";
    const fill   = "hsla(" + hue + ", 90%, 65%, 0.95)";
    ctx.strokeStyle = stroke;
    ctx.fillStyle   = fill;

    // v0.3.39 -- blob coords already come from the mirrored small-
    // canvas detection pass (we mirror before getImageData in
    // _processBlobFrame), so they're already in mirrored-display
    // space. The previous code applied an additional un-mirror here
    // which flipped boxes onto the OPPOSITE side from the visible
    // object. Draw directly at b.minX/b.maxX/b.x without mirroring.
    const bx = fit.dx + b.minX * fit.dw;
    const by = fit.dy + b.minY * fit.dh;
    const bw = (b.maxX - b.minX) * fit.dw;
    const bh = (b.maxY - b.minY) * fit.dh;
    ctx.strokeRect(bx, by, bw, bh);

    // Centroid dot (also in mirrored-display space already).
    const px = fit.dx + b.x * fit.dw;
    const py = fit.dy + b.y * fit.dh;
    ctx.beginPath();
    ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
    ctx.fill();

    // ID label.
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    const label = "#" + b.id + "  " + (b.size * 100).toFixed(1) + "%";
    const m = ctx.measureText(label);
    ctx.fillRect(bx + 2, by + 2, m.width + 8, 20);
    ctx.fillStyle = stroke;
    ctx.fillText(label, bx + 6, by + 4);
  }
}

/* Wire-resolver: read a per-port value off the latest blob detection.
 * Same convention as _handLandmarkerValue: returns 0 when no detection
 * is ready yet. */
function _blobTrackerValue(node, portName) {
  const entry = _mediapipeNodes.get(node.id);
  if (!entry) { _ensureBlobTracker(node.id, node.params || {}); return 0; }
  if (!entry.ready || !entry.latest) return 0;
  const blobs = entry.latest.blobs || [];
  if (portName === "present")  return blobs.length > 0 ? 1 : 0;
  if (portName === "numBlobs") return blobs.length;
  // bN_x / bN_y / bN_size for N in 1..4.
  const m = portName.match(/^b([1-4])_(x|y|size)$/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    const field = m[2];
    if (idx >= 0 && idx < blobs.length) {
      const b = blobs[idx];
      if (field === "x")    return b.x;
      if (field === "y")    return b.y;
      if (field === "size") return b.size;
    }
  }
  return 0;
}

/* Standard uniform-buffer preamble. Phase 6.5.7 grew this from 32 to
 * 64 bytes to add per-display awareness (u_view + u_world_uv). The
 * full layout (16 floats = 64 bytes):
 *
 *   floats  0-3  / bytes  0-15  → u_resolution: vec4f (w, h, 1/w, 1/h)
 *   float   4    / bytes 16-19  → u_time: f32 (seconds since device acquired)
 *   float   5    / bytes 20-23  → u_dt: f32 (seconds since previous frame)
 *   float   6    / bytes 24-27  → u_layer: f32 (the array-layer index of
 *                                  the framebuffer this shader writes to —
 *                                  i.e. THIS display's index in state.rig.displays).
 *                                  Phase 6.3.2 added this so feedback /
 *                                  composition shaders can sample the right
 *                                  layer of feedback / intermediate textures.
 *                                  Older shaders keep declaring `_pad0: vec2f`
 *                                  in their struct; layout is identical so they
 *                                  just don't reference the slot.
 *   float   7    / bytes 28-31  → u_fov_v_deg: f32 (vertical fov of THIS
 *                                  display in degrees — companion to
 *                                  u_view.w which carries fov_h_deg).
 *                                  Phase 6.4 polish added this so shaders
 *                                  can compute global (yaw, pitch) for
 *                                  angular-uniform cell math, vs. the
 *                                  world_uv math which produces visibly
 *                                  non-uniform cells on curved screens.
 *   floats  8-11 / bytes 32-47  → u_view: vec4f (yaw, pitch, roll, fov_h_deg) of THIS display
 *   floats 12-15 / bytes 48-63  → u_world_uv: vec4f (minU, minV, maxU, maxV) on rig master canvas
 *
 * User shader params start at byte 64 (float index 16). Shaders that
 * want to span multiple displays sample their content using
 *   let world_uv = mix(u.u_world_uv.xy, u.u_world_uv.zw, in.uv);
 * Single-display rigs default to u_world_uv = (0,0,1,1) so existing
 * shaders that read in.uv directly behave identically. */
/* Phase 6.6.20.3 — pack the rig's screen-surface descriptor into a
 * shader's uniform scratch buffer at the given Float32 base index.
 * Layout (8 floats, 2 vec4s):
 *
 *   [base+0..3] u_surface = (type, radius, param_a, param_b)
 *   [base+4..7] u_surface_path = (yawStart, yawEnd, _, _)
 *
 * type codes:
 *   0 = none / free / plane    → defaults to unit sphere full range
 *   1 = sphere                 → param_a = -90, param_b = 90 (full)
 *   2 = cylinder               → param_a = -length/2, param_b = +length/2
 *   3 = swept (arc profile)    → param_a = pitchStart, param_b = pitchEnd
 *   4 = swept (vertical profile) → param_a = yMin, param_b = yMax
 *
 * This lets surface-aware shaders (Checkerboard, Voronoi as of 6.6.20.3)
 * read `u.u_surface.x` to dispatch to the right parameterization, and
 * use param_a / param_b / yawStart / yawEnd to compute equal-area
 * normalized UV for cell math.
 *
 * No-curved-surface fallback (stype=0): emits "fake unit sphere" so
 * shaders in tile/equirect/fisheye preview modes still render uniform
 * cells. The shader treats stype=0 the same as a full sphere of radius 1. */
function _packSurfaceUniforms(scratch, base) {
  const surface = (state && state.rig && state.rig.surface) || null;
  const surfaceVisible = !!(state && state.rig && state.rig.surfaceVisible !== false);
  const isCurved = !!(surface && surfaceVisible &&
    (surface.type === "sphere" || surface.type === "cylinder" || surface.type === "swept"));
  if (!isCurved) {
    scratch[base + 0] = 0;        // type: none
    scratch[base + 1] = 1;        // radius (unit fallback)
    scratch[base + 2] = -90;      // pitchStart fallback
    scratch[base + 3] = 90;       // pitchEnd fallback
    scratch[base + 4] = -180;     // yawStart fallback
    scratch[base + 5] = 180;      // yawEnd fallback
    scratch[base + 6] = 0;
    scratch[base + 7] = 0;
    return;
  }
  if (surface.type === "sphere") {
    scratch[base + 0] = 1;
    scratch[base + 1] = surface.radius || 5;
    scratch[base + 2] = -90;
    scratch[base + 3] = 90;
    scratch[base + 4] = -180;
    scratch[base + 5] = 180;
    scratch[base + 6] = 0;
    scratch[base + 7] = 0;
    return;
  }
  if (surface.type === "cylinder") {
    const L = surface.length || 5;
    scratch[base + 0] = 2;
    scratch[base + 1] = surface.radius || 5;
    scratch[base + 2] = -L * 0.5;
    scratch[base + 3] =  L * 0.5;
    scratch[base + 4] = -180;
    scratch[base + 5] = 180;
    scratch[base + 6] = 0;
    scratch[base + 7] = 0;
    return;
  }
  // type === "swept"
  const profile = surface.profile || {};
  const path = surface.path || { yawStart: -180, yawEnd: 180 };
  if (profile.kind === "vertical") {
    scratch[base + 0] = 4;
    scratch[base + 1] = profile.radius || 5;
    scratch[base + 2] = profile.yMin != null ? profile.yMin : -2.5;
    scratch[base + 3] = profile.yMax != null ? profile.yMax :  2.5;
  } else {
    scratch[base + 0] = 3;
    scratch[base + 1] = profile.radius || 5;
    scratch[base + 2] = profile.pitchStart != null ? profile.pitchStart : -90;
    scratch[base + 3] = profile.pitchEnd   != null ? profile.pitchEnd   :  90;
  }
  scratch[base + 4] = path.yawStart != null ? path.yawStart : -180;
  scratch[base + 5] = path.yawEnd   != null ? path.yawEnd   :  180;
  scratch[base + 6] = 0;
  scratch[base + 7] = 0;
}

/* Phase 6.6.25 — Text node mesh-text WGSL generator. The Text
 * node's `wgsl` field is a function (node) => string that bakes
 * the user's text param into the shader as a const glyph-index
 * array, alongside the static 5x7 bitmap font for A-Z + 0-9 +
 * space + dash + period + bang (40 glyphs total, 280 rows). The
 * function form uses the v0.1.98 dynamic-WGSL infra: each text
 * value compiles to its own pipeline (cached by hash), the old
 * pipeline keeps rendering until the new one is ready (no
 * flicker), unsupported chars become spaces.
 *
 * Why dynamic WGSL instead of uniform-passed glyphs: simpler.
 * No vec4u packing, no Uint32Array view of a Float32Array, no
 * shader-side glyph-from-uniform helper. Cost is one pipeline
 * compile per unique text value (~10-50 ms, async, cached). For
 * a Text node that rarely changes after authoring, that's
 * imperceptible. */
const _TEXT_FONT_ROWS = [
  // A-Z (indices 0-25); each entry = 7 row bitmasks (5 bits, MSB=col 0).
  [14, 17, 17, 31, 17, 17, 17], // A
  [30, 17, 17, 30, 17, 17, 30], // B
  [14, 17, 16, 16, 16, 17, 14], // C
  [30, 17, 17, 17, 17, 17, 30], // D
  [31, 16, 16, 30, 16, 16, 31], // E
  [31, 16, 16, 30, 16, 16, 16], // F
  [14, 17, 16, 23, 17, 17, 14], // G
  [17, 17, 17, 31, 17, 17, 17], // H
  [31,  4,  4,  4,  4,  4, 31], // I
  [ 7,  2,  2,  2,  2, 18, 12], // J
  [17, 18, 20, 24, 20, 18, 17], // K
  [16, 16, 16, 16, 16, 16, 31], // L
  [17, 27, 21, 17, 17, 17, 17], // M
  [17, 25, 21, 19, 17, 17, 17], // N
  [14, 17, 17, 17, 17, 17, 14], // O
  [30, 17, 17, 30, 16, 16, 16], // P
  [14, 17, 17, 17, 21, 18, 13], // Q
  [30, 17, 17, 30, 20, 18, 17], // R
  [15, 16, 16, 14,  1,  1, 30], // S
  [31,  4,  4,  4,  4,  4,  4], // T
  [17, 17, 17, 17, 17, 17, 14], // U
  [17, 17, 17, 17, 17, 10,  4], // V
  [17, 17, 17, 17, 21, 21, 10], // W
  [17, 17, 10,  4, 10, 17, 17], // X
  [17, 17, 10,  4,  4,  4,  4], // Y
  [31,  2,  4,  8, 16, 16, 31], // Z
  // 0-9 (indices 26-35)
  [14, 17, 19, 21, 25, 17, 14], // 0
  [ 4, 12,  4,  4,  4,  4, 14], // 1
  [14, 17,  1,  2,  4,  8, 31], // 2
  [30,  1,  1, 14,  1,  1, 30], // 3
  [ 2,  6, 10, 18, 31,  2,  2], // 4
  [31, 16, 16, 30,  1,  1, 30], // 5
  [14, 17, 16, 30, 17, 17, 14], // 6
  [31,  1,  2,  4,  8,  8,  8], // 7
  [14, 17, 17, 14, 17, 17, 14], // 8
  [14, 17, 17, 15,  1, 17, 14], // 9
  // space (36)
  [ 0,  0,  0,  0,  0,  0,  0],
  // dash (37)
  [ 0,  0,  0, 14,  0,  0,  0],
  // period (38)
  [ 0,  0,  0,  0,  0, 12, 12],
  // ! (39)
  [ 4,  4,  4,  4,  4,  0,  4]
];

function _textCharToGlyphIdx(ch) {
  if (!ch) return 36;             // space
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 90)  return c - 65;        // A-Z
  if (c >= 97 && c <= 122) return c - 97;        // a-z lowercased
  if (c >= 48 && c <= 57)  return c - 48 + 26;   // 0-9
  if (ch === '-') return 37;
  if (ch === '.') return 38;
  if (ch === '!') return 39;
  return 36;                                     // unknown -> space
}

function _buildTextShaderWGSL(node) {
  const rawText = (node && node.params && typeof node.params.text === "string")
    ? node.params.text
    : "GAMMA NODE";
  const MAX = 32;
  const trimmed = rawText.slice(0, MAX);
  const glyphIdx = [];
  for (let i = 0; i < MAX; i++) {
    glyphIdx.push(_textCharToGlyphIdx(trimmed[i] || ""));
  }
  const textLen = trimmed.length;

  // Flatten the font rows into a 280-element array of u32 row
  // bitmasks; baked into the shader as a const at module scope.
  const fontFlat = [];
  for (const glyph of _TEXT_FONT_ROWS) {
    for (const row of glyph) fontFlat.push(row);
  }
  const fontStr = fontFlat.map(v => v + "u").join(", ");
  const glyphsStr = glyphIdx.map(g => g + "u").join(", ");

  return `struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  u_layer:      f32,
  u_fov_v_deg:  f32,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,    // x=yawDeg, y=pitchDeg, z=sizeDeg, w=plateOpacity
  color:        vec4f,    // x=r, y=g, z=b, w=_
  bgColor:      vec4f,    // x=bgR, y=bgG, z=bgB, w=_
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn frag_to_global_angles(uv: vec2f) -> vec2f {
  // Standard basis-rotation gnomonic (see WireframeCalibration shader).
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  let fwd = vec3f(sy * cp, sp, cy * cp);
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  let dir = normalize(local_x * right + local_y * up + fwd);
  let pitch_out = asin(clamp(dir.y, -1.0, 1.0));
  let yaw_out   = atan2(dir.x, dir.z);
  return vec2f(yaw_out * 57.29577951, pitch_out * 57.29577951);
}

const TEXT_LEN: u32 = ${textLen}u;
const TEXT_GLYPHS: array<u32, ${MAX}> = array<u32, ${MAX}>(${glyphsStr});
const FONT: array<u32, 280> = array<u32, 280>(${fontStr});

fn glyph_pixel(g: u32, x: i32, y: i32) -> bool {
  if (g >= 40u) { return false; }
  if (x < 0 || x > 4 || y < 0 || y > 6) { return false; }
  let row = FONT[g * 7u + u32(y)];
  let bit = (row >> u32(4 - x)) & 1u;
  return bit == 1u;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let ang = frag_to_global_angles(in.uv);
  let yaw   = ang.x;
  let pitch = ang.y;

  let yaw_c   = u.params.x;
  let pitch_c = u.params.y;
  let size    = max(2.0, u.params.z);
  let plateA  = clamp(u.params.w, 0.0, 1.0);

  // Each char is 5 cells wide, 7 cells tall + 1 cell spacing.
  // Cell size derived so total height = sizeDeg.
  let cell    = size / 7.0;
  let nchars  = max(1.0, f32(TEXT_LEN));
  let text_w  = (nchars * 6.0 - 1.0) * cell;
  let text_h  = size;

  // Yaw delta with proper plus/minus 180 wrap.
  var dy = yaw - yaw_c;
  if (dy >  180.0) { dy = dy - 360.0; }
  if (dy < -180.0) { dy = dy + 360.0; }
  let dp = pitch - pitch_c;

  let pad      = cell * 0.5;
  let in_plate = abs(dy) <= text_w * 0.5 + pad && abs(dp) <= text_h * 0.5 + pad;
  let in_text  = abs(dy) <= text_w * 0.5      && abs(dp) <= text_h * 0.5;

  var col = vec3<f32>(0.0);

  if (in_plate) {
    col = mix(vec3<f32>(0.0), u.bgColor.rgb, plateA);
  }

  if (in_text) {
    let x_norm = (dy + text_w * 0.5) / text_w;       // 0..1 left-to-right
    let y_norm = (dp + text_h * 0.5) / text_h;       // 0..1 bottom-to-top
    let cci = i32(floor(x_norm * nchars * 6.0));
    let row = i32(floor((1.0 - y_norm) * 7.0));
    let char_idx = cci / 6;
    let local_col = cci - char_idx * 6;
    if (local_col >= 0 && local_col < 5 && row >= 0 && row <= 6 && u32(char_idx) < TEXT_LEN) {
      let g = TEXT_GLYPHS[char_idx];
      if (glyph_pixel(g, local_col, row)) {
        col = u.color.rgb;
      }
    }
  }

  return vec4<f32>(col, 1.0);
}`;
}

function _writeShaderPreamble(scratch, dtSec, display, worldUvOverride, layerIdx) {
  const t = (performance.now() - Visual.startTime) * 0.001;
  scratch[0]  = Visual.fbWidth;
  scratch[1]  = Visual.fbHeight;
  scratch[2]  = 1.0 / Visual.fbWidth;
  scratch[3]  = 1.0 / Visual.fbHeight;
  scratch[4]  = t;
  scratch[5]  = dtSec;
  scratch[6]  = (typeof layerIdx === "number" && Number.isFinite(layerIdx)) ? layerIdx : 0;
  // Phase 6.4 polish — u_fov_v_deg companion to u_view.w (fov_h).
  // Lets shaders compute global angular position for uniform-on-sphere
  // cell math (Checkerboard / Voronoi / NoiseShader). Defaults to 60°
  // when no display info is available — matches the most common preset.
  scratch[7]  = (display && display.fov && display.fov.v) || 60;
  // Defensive: missing display falls back to a single-display default
  // so the preamble is always well-formed. Same defaults make a new
  // editor with no rig (shouldn't happen, freshState provides one)
  // still produce sensible u_world_uv = (0,0,1,1).
  const pose = (display && display.pose) || { yaw: 0, pitch: 0, roll: 0 };
  const fov  = (display && display.fov)  || { h: 90, v: 60 };
  // worldUvOverride is the per-VO normalized slice computed from the
  // shader's actual consumer set (see _renderWorldUvForVO). Falls back
  // to the rig display's slice when no override given (which happens
  // for non-shader-frag callers — there are none today, but safe).
  const wuv = worldUvOverride || (display && display.worldUv) || { minU: 0, minV: 0, maxU: 1, maxV: 1 };
  scratch[8]  = pose.yaw   || 0;
  scratch[9]  = pose.pitch || 0;
  scratch[10] = pose.roll  || 0;
  scratch[11] = fov.h      || 90;
  scratch[12] = wuv.minU != null ? wuv.minU : 0;
  scratch[13] = wuv.minV != null ? wuv.minV : 0;
  scratch[14] = wuv.maxU != null ? wuv.maxU : 1;
  scratch[15] = wuv.maxV != null ? wuv.maxV : 1;
}

/* Find every VisualOutput in the patch that consumes the same shader
 * source as `vo`. Returns the array including `vo` itself. Used by
 * _renderWorldUvForVO to decide whether the shader is solo-consumed
 * (full coverage) or shared across multiple displays (slice the
 * shared canvas).
 *
 * Trade-off: O(N×E) per render frame for N nodes × E edges. Trivial
 * for typical patches; could be cached on graph mutation if profiling
 * ever shows it matters. */
function _coConsumerVOs(currentVO, srcId) {
  if (!state || !Array.isArray(state.nodes) || !Array.isArray(state.edges)) return [currentVO];
  const out = [];
  for (const candidate of state.nodes) {
    if (candidate.type !== "VisualOutput") continue;
    const incomingEdge = state.edges.find(e =>
      e.to.node === candidate.id && e.to.port === "in"
    );
    if (!incomingEdge || incomingEdge.from.node !== srcId) continue;
    out.push(candidate);
  }
  return out.length ? out : [currentVO];
}

/* Compute the per-VO render-time u_world_uv. Two regimes:
 *
 *   Solo consumer (this is the only VO wired to this shader source):
 *     return (0, 0, 1, 1) — shader renders FULL coverage on this
 *     display. A pinwheel sees a complete pinwheel; a gradient runs
 *     edge-to-edge.
 *
 *   Shared consumer (≥ 2 VOs wired to the same shader source):
 *     compute the bounding rect of all consumer displays' rig
 *     worldUvs, then return THIS VO's display slice normalized to
 *     that bbox so the union spans 0..1 across the consumers.
 *     A pinwheel wired to both displays of side-by-side renders
 *     once-per-display with its center exactly at the seam.
 *
 * The normalization step matters when consumers don't cover the
 * full rig: e.g. on AlloSphere-like (16 displays), wiring a shader
 * into VO0 + VO15 produces a "shared canvas" that's just those two
 * displays' worldUv union; the in-between displays just don't
 * receive the shader's output. */
function _renderWorldUvForVO(currentVO, srcId) {
  const displays = (state && state.rig && state.rig.displays) || [];
  if (displays.length === 0) return { minU: 0, minV: 0, maxU: 1, maxV: 1 };

  // Phase 6.5.15+ — global shader-center offset (degrees of yaw/pitch).
  // Solo and multi paths convert this to a normalized u/v shift via
  // different denominators (see below). Subtracting the shift from
  // the slice min/max effectively rotates the shader's content within
  // the rig — positive yaw shift pulls the pinwheel center toward
  // the right of the rig's view.
  const sCYaw   = (state.rig && typeof state.rig.shaderCenterYaw   === "number") ? state.rig.shaderCenterYaw   : 0;
  const sCPitch = (state.rig && typeof state.rig.shaderCenterPitch === "number") ? state.rig.shaderCenterPitch : 0;

  const consumers = _coConsumerVOs(currentVO, srcId);
  const myIdx  = (currentVO.params && typeof currentVO.params.display === "number") ? (currentVO.params.display | 0) : 0;
  const myDisp = displays[Math.max(0, Math.min(myIdx, displays.length - 1))];

  // Solo consumer → full coverage on its display. ShaderCenter shift
  // denominator is the display's own FOV so 1 fov_h of yaw shift
  // moves the content one full screen. (Doesn't crop content; the
  // shader sees u_world_uv outside [0,1] and renders accordingly.)
  if (consumers.length <= 1) {
    const fovH = (myDisp && myDisp.fov && myDisp.fov.h) || 90;
    const fovV = (myDisp && myDisp.fov && myDisp.fov.v) || 60;
    const u_shift = sCYaw   / fovH;
    const v_shift = sCPitch / fovV;
    return {
      minU: 0 - u_shift, minV: 0 - v_shift,
      maxU: 1 - u_shift, maxV: 1 - v_shift
    };
  }

  // Shared shader → compute bbox of consumer-display slices in raw
  // worldUv space, normalize this VO's slice to that bbox. Then
  // apply shaderCenter shift, denominated by the consumer set's
  // total azimuth/pitch coverage in degrees.
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  let azMinDeg = Infinity, azMaxDeg = -Infinity;
  let pitchMinDeg = Infinity, pitchMaxDeg = -Infinity;
  for (const otherVO of consumers) {
    const idx = (otherVO.params && typeof otherVO.params.display === "number") ? (otherVO.params.display | 0) : 0;
    const d = displays[Math.max(0, Math.min(idx, displays.length - 1))];
    if (!d) continue;
    // worldUv bbox for normalization
    if (d.worldUv) {
      if (d.worldUv.minU < minU) minU = d.worldUv.minU;
      if (d.worldUv.minV < minV) minV = d.worldUv.minV;
      if (d.worldUv.maxU > maxU) maxU = d.worldUv.maxU;
      if (d.worldUv.maxV > maxV) maxV = d.worldUv.maxV;
    }
    // Degree bbox for shaderCenter denominator
    const pose = d.pose || { yaw: 0, pitch: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    const azL = pose.yaw   - fov.h * 0.5;
    const azR = pose.yaw   + fov.h * 0.5;
    const pT  = pose.pitch - fov.v * 0.5;
    const pB  = pose.pitch + fov.v * 0.5;
    if (azL < azMinDeg)   azMinDeg = azL;
    if (azR > azMaxDeg)   azMaxDeg = azR;
    if (pT  < pitchMinDeg) pitchMinDeg = pT;
    if (pB  > pitchMaxDeg) pitchMaxDeg = pB;
  }
  if (!isFinite(minU)) return { minU: 0, minV: 0, maxU: 1, maxV: 1 };

  const w = (maxU - minU) || 1;
  const h = (maxV - minV) || 1;
  const wuv = (myDisp && myDisp.worldUv) || { minU: 0, minV: 0, maxU: 1, maxV: 1 };

  // Convert shaderCenter degrees → normalized worldUv shift.
  // Consumer set's azim range covers (azMaxDeg - azMinDeg) degrees;
  // in normalized worldUv space (after bbox div) that's [0, 1].
  // So 1 normalized u unit = (azMaxDeg - azMinDeg) degrees.
  const azRange = isFinite(azMinDeg) ? Math.max(0.001, azMaxDeg - azMinDeg) : 360;
  const piRange = isFinite(pitchMinDeg) ? Math.max(0.001, pitchMaxDeg - pitchMinDeg) : 180;
  const u_shift = sCYaw   / azRange;
  const v_shift = sCPitch / piRange;

  return {
    minU: (wuv.minU - minU) / w - u_shift,
    minV: (wuv.minV - minV) / h - v_shift,
    maxU: (wuv.maxU - minU) / w - u_shift,
    maxV: (wuv.maxV - minV) / h - v_shift
  };
}

/* Encode a shader-frag pass for one VisualOutput → its display layer.
 * The instance is keyed by VO node id (not source shader) because
 * different VOs targeting the same shader still need their OWN
 * uniform buffer to hold their display-specific u_view + u_world_uv.
 * The pipeline cache key is the WGSL hash, so all instances of the
 * same shader share one compiled pipeline regardless of how many
 * VOs they feed.
 *
 * Returns true if a pass was actually encoded (pipeline ready,
 * instance built, layer view exists); false if any prerequisite
 * is missing — caller falls back gracefully. */
/* Phase 6.6.24 — resolve a shader-frag node's texture-typed input
 * port to the display layer of its upstream source's VisualOutput.
 *
 * Walk: edge ending at (node.id, portName) -> source node id ->
 * any VisualOutput in the patch whose `in` port is wired to that
 * source -> that VO's params.display. Returns -1 when:
 *   • No edge wired to that port.
 *   • Source has no downstream VisualOutput.
 *   • No state / no displays.
 *
 * Composition shader-frags use this in writeUniforms to fill the
 * per-input layer-index uniform slots: when a texture port is
 * wired, the framework's resolved layer wins; when unwired,
 * the manual layer-index param (the legacy Phase 6.6.22 form)
 * stays in place. WGSL treats a value < 0 as "ignore / black"
 * so unwired ports render neutrally instead of garbage. */
/* Phase 6.6.28 — runtime param-wire resolver. For a shader-frag
 * node, build a shallow copy of node.params where each `t: "param"`
 * input port that has a wire connected has its value replaced by
 * the live source value (Slider's current params.value for now;
 * future: LFO / Ramp / etc. via a shared signal-rate sampler).
 * The returned object is passed in lieu of node.params to the
 * registry's writeUniforms — existing code that does
 * `node.params.mix` automatically picks up the wired Slider value.
 *
 * Limited to Slider sources in this MVP. Audio-rate nodes (LFO,
 * envelope, etc.) would need to hand off their current sample
 * value from the AudioWorklet to the main thread each frame; that
 * SAB-based audio bridge is Phase 6.5. */
function _resolveNodeParams(node) {
  const out = Object.assign({}, node && node.params);
  if (typeof state === "undefined" || !state ||
      !Array.isArray(state.edges) || !Array.isArray(state.nodes)) return out;
  const def = TYPES[node && node.type];
  if (!def || !Array.isArray(def.ins)) return out;
  for (const port of def.ins) {
    // Phase 6.5.4 — substitute for any SIGNAL-typed input that
    // reduces to a per-frame scalar. param + audio + clock all
    // surface as one float to the shader; gate is a trigger
    // (different semantics) so it stays out of substitution.
    if (!port) continue;
    if (port.t !== "param" && port.t !== "audio" && port.t !== "clock") continue;
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === port.n
    );
    if (!wire || !wire.from) continue;
    // Sprint 7.5.3a -- unified with the OscOut path. _readWireJsSideValue
    // dispatches on source type (Slider, MasterClock, HandLandmarker,
    // PoseLandmarker, FaceLandmarker, HandKeyboard, BlobTracker, OscIn,
    // Sine/Saw/Square/Phasor audio mirrors, AD/AR/ADSR envelope mirrors,
    // AND the full cmath / arithmetic math-template family via
    // _evalMathTemplateJsSide recursion). Single source of truth for
    // "what does this wire produce, JS-side?". Returns null when the
    // source has no JS mirror -- in that case we keep the node's static
    // param value (the existing fallback).
    const v = _readWireJsSideValue(wire);
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      out[port.n] = v;
    }
  }
  return out;
}

/* =========================================================================
 * Sprint 7.5.3a -- 3D scene math helpers
 *
 * Column-major 4x4 matrix utilities matching the WebGPU + GLSL
 * convention (vec4 = mat * vec). All matrices are Float32Array(16)
 * laid out in column-major order:
 *
 *   m[ 0..3 ]  =  column 0 (m00 m10 m20 m30)
 *   m[ 4..7 ]  =  column 1
 *   m[ 8..11]  =  column 2
 *   m[12..15]  =  column 3 (translation)
 *
 * Helpers here are intentionally minimal -- just lookAt + perspective
 * + ortho + multiply + identity + per-element transform builders.
 * Sprint 7.5.3b adds rotation chains via the Translate/Rotate/Scale
 * transform nodes; for now Scene only consumes the camera matrices. */
function _mat4Identity() {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

function _mat4Multiply(out, a, b) {
  // out = a * b. Aliasing safe (uses temporaries).
  const a00=a[0],a01=a[4],a02=a[8],a03=a[12];
  const a10=a[1],a11=a[5],a12=a[9],a13=a[13];
  const a20=a[2],a21=a[6],a22=a[10],a23=a[14];
  const a30=a[3],a31=a[7],a32=a[11],a33=a[15];
  const b00=b[0],b01=b[4],b02=b[8],b03=b[12];
  const b10=b[1],b11=b[5],b12=b[9],b13=b[13];
  const b20=b[2],b21=b[6],b22=b[10],b23=b[14];
  const b30=b[3],b31=b[7],b32=b[11],b33=b[15];
  out[0]  = a00*b00 + a01*b10 + a02*b20 + a03*b30;
  out[1]  = a10*b00 + a11*b10 + a12*b20 + a13*b30;
  out[2]  = a20*b00 + a21*b10 + a22*b20 + a23*b30;
  out[3]  = a30*b00 + a31*b10 + a32*b20 + a33*b30;
  out[4]  = a00*b01 + a01*b11 + a02*b21 + a03*b31;
  out[5]  = a10*b01 + a11*b11 + a12*b21 + a13*b31;
  out[6]  = a20*b01 + a21*b11 + a22*b21 + a23*b31;
  out[7]  = a30*b01 + a31*b11 + a32*b21 + a33*b31;
  out[8]  = a00*b02 + a01*b12 + a02*b22 + a03*b32;
  out[9]  = a10*b02 + a11*b12 + a12*b22 + a13*b32;
  out[10] = a20*b02 + a21*b12 + a22*b22 + a23*b32;
  out[11] = a30*b02 + a31*b12 + a32*b22 + a33*b32;
  out[12] = a00*b03 + a01*b13 + a02*b23 + a03*b33;
  out[13] = a10*b03 + a11*b13 + a12*b23 + a13*b33;
  out[14] = a20*b03 + a21*b13 + a22*b23 + a23*b33;
  out[15] = a30*b03 + a31*b13 + a32*b23 + a33*b33;
  return out;
}

function _mat4LookAt(eye, target, up) {
  // Right-handed lookAt -- standard graphics convention. View matrix
  // maps from world space to camera space (camera at origin, looking
  // down -Z, +Y up).
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-6) { zx = 0; zy = 0; zz = 1; }
  else            { zx /= len; zy /= len; zz /= len; }
  // x = up × z (normalized). If up is parallel to z we fall back to
  // the world X axis to avoid a zero-length cross.
  let xx = up[1]*zz - up[2]*zy;
  let xy = up[2]*zx - up[0]*zz;
  let xz = up[0]*zy - up[1]*zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) { xx = 1; xy = 0; xz = 0; }
  else            { xx /= len; xy /= len; xz /= len; }
  // y = z × x (already orthogonal so no renormalize needed)
  const yx = zy*xz - zz*xy;
  const yy = zz*xx - zx*xz;
  const yz = zx*xy - zy*xx;
  const m = new Float32Array(16);
  m[0]=xx; m[1]=yx; m[2]=zx;  m[3]=0;
  m[4]=xy; m[5]=yy; m[6]=zy;  m[7]=0;
  m[8]=xz; m[9]=yz; m[10]=zz; m[11]=0;
  m[12] = -(xx*eye[0] + xy*eye[1] + xz*eye[2]);
  m[13] = -(yx*eye[0] + yy*eye[1] + yz*eye[2]);
  m[14] = -(zx*eye[0] + zy*eye[1] + zz*eye[2]);
  m[15] = 1;
  return m;
}

/* §planet-spec Phase 2 -- f64 lookAt + RTC compose helpers.
 *
 * f32 mantissa is 24 bits, so the representable step size at planet
 * scale (camera near 6.378 Mm from world origin) is ~0.76 m. That's
 * fatal for ground-level vertex detail. The fix is RTC (Relative-To-
 * Center): every mesh declares an optional f64 `anchorF64`; the
 * per-frame ModelView is composed as
 *
 *     mv_rtc = view * translate(anchorF64) * model_local
 *
 * in f64 (JS Number precision, 16 digits) and downcast to f32 only
 * at the GPU upload boundary. The catastrophic subtraction
 * (anchor - eye, both at Earth-radius magnitudes) happens in f64 so
 * the result is a small camera-relative offset; vertex coords stay
 * local (small) too, and f32 GPU math operates only on small numbers.
 *
 * THIS COMMIT IS SCAFFOLDING ONLY -- adds the helpers + returns
 * `eyeF64` / `viewF64` from _evaluateCamera. No existing mesh uses
 * anchorF64 yet; behavior is bit-identical until Phase 3 begins
 * refactoring meshes to local coords + per-chunk anchors.
 *
 * Mesh convention (when Phase 3 lands):
 *   mesh.anchorF64 = { x, y, z }       -- f64 world position of the
 *                                         mesh's local origin.
 *   mesh.transform = Float32Array(16)  -- model_local. Vertices in
 *                                         the VBO are coords
 *                                         RELATIVE to the anchor.
 *   anchorF64 omitted / null           -- legacy absolute-world-coord
 *                                         path (current behavior).
 */
function _mat4LookAtF64(eye, target, up) {
  // Same math as _mat4LookAt but returns a plain JS Array(16) so the
  // entries retain f64 precision -- Float32Array would downcast.
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-6) { zx = 0; zy = 0; zz = 1; }
  else            { zx /= len; zy /= len; zz /= len; }
  let xx = up[1]*zz - up[2]*zy;
  let xy = up[2]*zx - up[0]*zz;
  let xz = up[0]*zy - up[1]*zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) { xx = 1; xy = 0; xz = 0; }
  else            { xx /= len; xy /= len; xz /= len; }
  const yx = zy*xz - zz*xy;
  const yy = zz*xx - zx*xz;
  const yz = zx*xy - zy*xx;
  const m = new Array(16);
  m[0]=xx; m[1]=yx; m[2]=zx;  m[3]=0;
  m[4]=xy; m[5]=yy; m[6]=zy;  m[7]=0;
  m[8]=xz; m[9]=yz; m[10]=zz; m[11]=0;
  m[12] = -(xx*eye[0] + xy*eye[1] + xz*eye[2]);
  m[13] = -(yx*eye[0] + yy*eye[1] + yz*eye[2]);
  m[14] = -(zx*eye[0] + zy*eye[1] + zz*eye[2]);
  m[15] = 1;
  return m;
}

function _composeRtcModelView(viewF64, anchorF64, modelLocal) {
  // §planet-spec Phase 2 -- compose mv_rtc = view * translate(anchor)
  // * model_local in f64, downcast to Float32Array for upload.
  //
  //   viewF64   = plain JS Array(16) from _mat4LookAtF64
  //   anchorF64 = { x, y, z }    OR null (treated as origin)
  //   modelLocal = Float32Array(16) (the mesh's local transform; can
  //                                  be reused legacy m.transform when
  //                                  anchorF64 represents the world
  //                                  origin and vertices are already
  //                                  in world coords).
  //
  // view * translate(anchor): only the translation column changes.
  // Columns 0..2 = view columns 0..2 (the rotation block is preserved).
  // Column 3 = view * vec4(anchor.x, anchor.y, anchor.z, 1).
  const ax = anchorF64 ? anchorF64.x : 0;
  const ay = anchorF64 ? anchorF64.y : 0;
  const az = anchorF64 ? anchorF64.z : 0;
  const vt = new Array(16);
  vt[0]  = viewF64[0];  vt[1]  = viewF64[1];  vt[2]  = viewF64[2];  vt[3]  = viewF64[3];
  vt[4]  = viewF64[4];  vt[5]  = viewF64[5];  vt[6]  = viewF64[6];  vt[7]  = viewF64[7];
  vt[8]  = viewF64[8];  vt[9]  = viewF64[9];  vt[10] = viewF64[10]; vt[11] = viewF64[11];
  vt[12] = viewF64[0]*ax + viewF64[4]*ay + viewF64[8] *az + viewF64[12];
  vt[13] = viewF64[1]*ax + viewF64[5]*ay + viewF64[9] *az + viewF64[13];
  vt[14] = viewF64[2]*ax + viewF64[6]*ay + viewF64[10]*az + viewF64[14];
  vt[15] = viewF64[3]*ax + viewF64[7]*ay + viewF64[11]*az + viewF64[15];
  // vt * modelLocal -- final 4x4 multiply, still in f64.
  const mv = new Array(16);
  _mat4Multiply(mv, vt, modelLocal);
  // Downcast to Float32Array at the very last moment.
  return Float32Array.from(mv);
}

function _mat4Perspective(fovYRad, aspect, near, far) {
  // WebGPU clip space: z in [0,1].
  // §planet-spec Phase 1 -- reverse-Z. The near plane now maps to
  // ndc_z = 1, far plane to ndc_z = 0. f32 depth precision is
  // distributed near-uniformly across the range instead of being
  // 99% bunched up at the near plane like the standard mapping; with
  // depth32float + reverse-Z, near=0.1 / far=1e8 z-fights becomes
  // a non-issue. Paired with depthCompare: "greater" and
  // depthClearValue: 0.0 in the pipeline + pass setup.
  const f = 1.0 / Math.tan(fovYRad * 0.5);
  const m = new Float32Array(16);
  const nf = 1.0 / (near - far);
  m[0]  = f / aspect;
  m[5]  = f;
  m[10] = -near * nf;          // (near)/(far - near)
  m[11] = -1;
  m[14] = -near * far * nf;    // (near*far)/(far - near)
  return m;
}

/* Sprint 7.5.3b -- elementary affine transforms. Each returns a fresh
 * Float32Array(16) in column-major order. Compose via _mat4Multiply
 * to build chained model matrices. Standard right-handed coordinate
 * system; rotation angles in RADIANS (degrees converted at the node
 * boundary via DEG_TO_RAD). */
function _mat4Translate(x, y, z) {
  const m = _mat4Identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

function _mat4Scale(sx, sy, sz) {
  const m = new Float32Array(16);
  m[0] = sx; m[5] = sy; m[10] = sz; m[15] = 1;
  return m;
}

function _mat4RotateX(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = c;  m[6] = s;
  m[9] = -s; m[10] = c;
  m[15] = 1;
  return m;
}

function _mat4RotateY(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = new Float32Array(16);
  m[0] = c;  m[2] = -s;
  m[5] = 1;
  m[8] = s;  m[10] = c;
  m[15] = 1;
  return m;
}

function _mat4RotateZ(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = new Float32Array(16);
  m[0] = c;  m[1] = s;
  m[4] = -s; m[5] = c;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function _mat4Ortho(left, right, bottom, top, near, far) {
  const m = new Float32Array(16);
  const lr = 1.0 / (left - right);
  const bt = 1.0 / (bottom - top);
  const nf = 1.0 / (near - far);
  m[0]  = -2 * lr;
  m[5]  = -2 * bt;
  m[10] = nf;                  // z maps to [0, 1] in WebGPU clip space
  m[12] = (left + right) * lr;
  m[13] = (top + bottom) * bt;
  m[14] = near * nf;
  m[15] = 1;
  return m;
}

/* Resolve a Camera node's params + return a small {viewMat, projMat,
 * viewProj} object. Called by Scene's encode pass; cached by frame
 * via Visual._frameCameraCache so multiple Scenes wired to the same
 * Camera don't recompute the matrices. The cache is cleared at the
 * top of each frame in renderVisualFrame. */
function _evaluateCamera(cameraNode, fbW, fbH) {
  // Sprint 7.5.3a -- resolve wired param inputs first so external
  // sources (Slider, MasterClock, Sin/Cos chains, OscIn, etc) can
  // drive camera position / orientation / fov in real time. Falls
  // back to the node's static params for unwired inputs.
  const p = cameraNode ? _resolveNodeParams(cameraNode) : {};
  const px = (typeof p.posX === "number") ? p.posX : 0;
  const py = (typeof p.posY === "number") ? p.posY : 0;
  const pz = (typeof p.posZ === "number") ? p.posZ : 5;
  const tx = (typeof p.targetX === "number") ? p.targetX : 0;
  const ty = (typeof p.targetY === "number") ? p.targetY : 0;
  const tz = (typeof p.targetZ === "number") ? p.targetZ : 0;
  const ux = (typeof p.upX === "number") ? p.upX : 0;
  const uy = (typeof p.upY === "number") ? p.upY : 1;
  const uz = (typeof p.upZ === "number") ? p.upZ : 0;
  const fov = (typeof p.fov === "number") ? p.fov : 60;
  const near = (typeof p.near === "number") ? p.near : 0.1;
  const far  = (typeof p.far  === "number") ? p.far  : 100;
  const mode = (typeof p.mode === "number") ? p.mode : 0;   // 0 = perspective, 1 = ortho
  const aspect = Math.max(0.01, fbW / Math.max(1, fbH));
  const view = _mat4LookAt([px, py, pz], [tx, ty, tz], [ux, uy, uz]);
  // §planet-spec Phase 2 -- also retain the view matrix as plain
  // JS Numbers (f64) so RTC-aware draws can compose ModelView in
  // f64 before downcasting. Cheap (16 multiplies); same math as
  // the f32 view, just no Float32Array downcast.
  const viewF64 = _mat4LookAtF64([px, py, pz], [tx, ty, tz], [ux, uy, uz]);
  let proj;
  if (mode === 1) {
    // Ortho: scale fov-equivalent vertical half-height by 1 unit at
    // distance 1, so an 'orthoSize' param of N means the view is N
    // world-units tall.
    const size = (typeof p.orthoSize === "number") ? p.orthoSize : 4;
    proj = _mat4Ortho(-size * aspect, size * aspect, -size, size, near, far);
  } else {
    proj = _mat4Perspective(fov * 0.01745329251994, aspect, near, far);
  }
  const viewProj = new Float32Array(16);
  _mat4Multiply(viewProj, proj, view);
  // Sprint 7.5.4.c-sky -- camera basis vectors + tan(fov/2) for the
  // background sky pass to reconstruct world-space rays from screen
  // coords. Derived from the same eye/target/up the view matrix is
  // built from so they match exactly.
  let fx = tx - px, fy = ty - py, fz = tz - pz;
  let flen = Math.hypot(fx, fy, fz) || 1.0;
  fx /= flen; fy /= flen; fz /= flen;
  let rx = fy * uz - fz * uy;
  let ry = fz * ux - fx * uz;
  let rz = fx * uy - fy * ux;
  let rlen = Math.hypot(rx, ry, rz) || 1.0;
  rx /= rlen; ry /= rlen; rz /= rlen;
  const uxC = ry * fz - rz * fy;
  const uyC = rz * fx - rx * fz;
  const uzC = rx * fy - ry * fx;
  const tanHalfFov = (mode === 1) ? 1.0 : Math.tan(fov * 0.01745329251994 * 0.5);
  // Sprint 5.10 -- 6-plane frustum extracted from the view-projection
  // matrix. Each plane is (a, b, c, d) with normal (a, b, c) pointing
  // INSIDE the frustum; a point is inside iff a*x + b*y + c*z + d >= 0
  // for ALL planes. Standard derivation: combine rows of viewProj.
  //   left   = row3 + row0
  //   right  = row3 - row0
  //   bottom = row3 + row1
  //   top    = row3 - row1
  //   near   = row2          (WebGPU clip z in [0, 1])
  //   far    = row3 - row2
  // viewProj is stored column-major (mat[col][row]) -- "row k" is
  // viewProj[k], viewProj[k+4], viewProj[k+8], viewProj[k+12].
  const vp = viewProj;
  const r0x = vp[0], r0y = vp[4], r0z = vp[8],  r0w = vp[12];
  const r1x = vp[1], r1y = vp[5], r1z = vp[9],  r1w = vp[13];
  const r2x = vp[2], r2y = vp[6], r2z = vp[10], r2w = vp[14];
  const r3x = vp[3], r3y = vp[7], r3z = vp[11], r3w = vp[15];
  const planes = new Float32Array(24);
  // left
  planes[0]  = r3x + r0x; planes[1]  = r3y + r0y; planes[2]  = r3z + r0z; planes[3]  = r3w + r0w;
  // right
  planes[4]  = r3x - r0x; planes[5]  = r3y - r0y; planes[6]  = r3z - r0z; planes[7]  = r3w - r0w;
  // bottom
  planes[8]  = r3x + r1x; planes[9]  = r3y + r1y; planes[10] = r3z + r1z; planes[11] = r3w + r1w;
  // top
  planes[12] = r3x - r1x; planes[13] = r3y - r1y; planes[14] = r3z - r1z; planes[15] = r3w - r1w;
  // near
  planes[16] = r2x;       planes[17] = r2y;       planes[18] = r2z;       planes[19] = r2w;
  // far
  planes[20] = r3x - r2x; planes[21] = r3y - r2y; planes[22] = r3z - r2z; planes[23] = r3w - r2w;
  return {
    view, proj, viewProj, eye: [px, py, pz],
    // §planet-spec Phase 2 -- f64-precision sibling fields for RTC.
    // `eye` (f32 array) stays for back-compat; `eyeF64` is the
    // canonical world-space camera position consumers should pair
    // with mesh.anchorF64 in _composeRtcModelView. `viewF64` is the
    // matching view matrix in f64.
    eyeF64: { x: px, y: py, z: pz },
    viewF64,
    camRight:   [rx,  ry,  rz,  tanHalfFov * aspect],
    camUp:      [uxC, uyC, uzC, tanHalfFov],
    camForward: [fx,  fy,  fz,  (mode === 1) ? 1 : 0],
    // 5.10 -- 6 frustum planes for cull testing. Float32Array(24)
    // packed as 6 × vec4(a,b,c,d). Order: L/R/B/T/N/F.
    frustumPlanes: planes
  };
}

/* Sprint 8.0.2-e -- OrthoCamera2D pre-pass. Translates the 2D node's
 * high-level params (posX, posY, orthoSize, pixelSnap) into the
 * Camera-shape fields _evaluateCamera reads (target, up, mode=1,
 * orthoSize). pixelSnap quantizes the posX/posY to the nearest
 * 1/pixelsPerUnit to eliminate sub-pixel shimmer for retro art.
 *
 * Sets posZ=0, target = (posX, posY, posZ-1) so forward is -Z and
 * up is +Y -- standard 2D screen convention (X right, Y up, Z out
 * of screen). orthoSize feeds the ortho half-height directly. */
function _syncOrthoCamera2D(node, fbW, fbH) {
  const p = _resolveNodeParams(node);
  const np = node.params || (node.params = {});
  const snap = (typeof p.pixelSnap === "number") ? p.pixelSnap : 1;
  const ppu  = (typeof p.pixelsPerUnit === "number" && p.pixelsPerUnit > 0) ? p.pixelsPerUnit : 32;
  let px = (typeof p.posX === "number") ? p.posX : 0;
  let py = (typeof p.posY === "number") ? p.posY : 0;
  if (snap >= 0.5) {
    px = Math.round(px * ppu) / ppu;
    py = Math.round(py * ppu) / ppu;
  }
  np.posX    = px;
  np.posY    = py;
  np.posZ    = 0;
  np.targetX = px;
  np.targetY = py;
  np.targetZ = -1;
  np.upX     = 0; np.upY = 1; np.upZ = 0;
  np.mode    = 1;
  np.fov     = 60;
  // orthoSize already lives in params; _evaluateCamera reads it.
}

/* Sprint 8.0.2-e -- OrthoCamera25D pre-pass. Translates the angle
 * preset (or custom yaw/pitch) + focus point (posX/Y/Z) + distance
 * into a full Camera-shape (posX/Y/Z = camera position, targetX/Y/Z =
 * focus point, upX/Y/Z, mode=1, orthoSize).
 *
 * forward = (cos(pitch)*sin(yaw), -sin(pitch), -cos(pitch)*cos(yaw))
 *   ... yaw rotates around +Y, pitch tilts down toward target.
 * camera = focus - forward * distance.
 *
 * The convention is: yaw=0 + pitch=0 looks toward -Z; yaw=+90° rotates
 * the camera right (looks toward +X); pitch=+90° looks straight down. */
function _syncOrthoCamera25D(node) {
  const p = _resolveNodeParams(node);
  const np = node.params || (node.params = {});
  const angle = (typeof p.angle === "string") ? p.angle : "iso";
  let yawDeg, pitchDeg;
  if (angle === "iso")             { yawDeg = 45; pitchDeg = 30; }
  else if (angle === "iso-narrow") { yawDeg = 30; pitchDeg = 45; }
  else if (angle === "top-down")   { yawDeg =  0; pitchDeg = 90; }
  else if (angle === "side")       { yawDeg =  0; pitchDeg =  0; }
  else                              { // "custom"
    yawDeg   = (typeof p.yaw   === "number") ? p.yaw   : 45;
    pitchDeg = (typeof p.pitch === "number") ? p.pitch : 30;
  }
  const yawR   = yawDeg   * 0.01745329251994;
  const pitchR = pitchDeg * 0.01745329251994;
  const cy = Math.cos(yawR),   sy = Math.sin(yawR);
  const cp = Math.cos(pitchR), sp = Math.sin(pitchR);
  // forward (unit, from camera toward focus)
  const fx =  cp * sy;
  const fy = -sp;
  const fz = -cp * cy;
  const fx0 = (typeof p.posX === "number") ? p.posX : 0;
  const fy0 = (typeof p.posY === "number") ? p.posY : 0;
  const fz0 = (typeof p.posZ === "number") ? p.posZ : 0;
  const dist = (typeof p.distance === "number" && p.distance > 0) ? p.distance : 20;
  np.targetX = fx0;
  np.targetY = fy0;
  np.targetZ = fz0;
  np.posX    = fx0 - fx * dist;
  np.posY    = fy0 - fy * dist;
  np.posZ    = fz0 - fz * dist;
  np.upX     = 0; np.upY = 1; np.upZ = 0;
  np.mode    = 1;
  np.fov     = 60;
  // orthoSize already in params; _evaluateCamera reads it.
}

/* Resolve the camera wired into a Scene node's "camera" input. Falls
 * back to a default-pose camera object when nothing is wired so the
 * Scene still renders something instead of black. */
function _resolveSceneCamera(sceneNode, fbW, fbH) {
  if (!Visual._frameCameraCache) Visual._frameCameraCache = new Map();
  const wire = state.edges && state.edges.find(e =>
    e && e.to && e.to.node === sceneNode.id && e.to.port === "camera"
  );
  if (wire && wire.from) {
    const cached = Visual._frameCameraCache.get(wire.from.node);
    if (cached) return cached;
    const src = state.nodes.find(n => n && n.id === wire.from.node);
    if (src && (
      src.type === "Camera" || src.type === "FPCamera" ||
      src.type === "OrthoCamera2D" || src.type === "OrthoCamera25D" ||
      src.type === "ThirdPersonCamera"
    )) {
      // §8.0.2-e -- OrthoCamera2D/25D synthesize the Camera-shape
      // fields (target, up, mode, fov, etc) from their high-level
      // params (anchor + angle preset / pixel snap) before
      // _evaluateCamera runs its standard matrix math.
      if (src.type === "OrthoCamera2D")  _syncOrthoCamera2D(src, fbW, fbH);
      if (src.type === "OrthoCamera25D") _syncOrthoCamera25D(src);
      const c = _evaluateCamera(src, fbW, fbH);
      Visual._frameCameraCache.set(wire.from.node, c);
      return c;
    }
  }
  // No camera wired -- synthesize a sensible default so 3D content
  // still appears for users who haven't wired a Camera yet.
  return _evaluateCamera({ params: {} }, fbW, fbH);
}

/* Sprint 7.5.3b -- build the local mat4 for a mesh-transform node.
 * Reads the node's params (or wired-in scalar inputs via
 * _resolveNodeParams) and returns the appropriate affine. Identity
 * for unknown node types. */
const _DEG_TO_RAD = Math.PI / 180.0;

function _buildTransformMatrix(node) {
  const p = _resolveNodeParams(node);
  if (node.type === "Translate") {
    const x = (typeof p.x === "number") ? p.x : 0;
    const y = (typeof p.y === "number") ? p.y : 0;
    const z = (typeof p.z === "number") ? p.z : 0;
    return _mat4Translate(x, y, z);
  }
  if (node.type === "Scale") {
    const u = (typeof p.uniform === "number") ? p.uniform : 0;
    if (u !== 0) return _mat4Scale(u, u, u);     // uniform != 0 overrides
    const x = (typeof p.x === "number") ? p.x : 1;
    const y = (typeof p.y === "number") ? p.y : 1;
    const z = (typeof p.z === "number") ? p.z : 1;
    return _mat4Scale(x, y, z);
  }
  if (node.type === "Rotate") {
    const ax = ((typeof p.angleX === "number") ? p.angleX : 0) * _DEG_TO_RAD;
    const ay = ((typeof p.angleY === "number") ? p.angleY : 0) * _DEG_TO_RAD;
    const az = ((typeof p.angleZ === "number") ? p.angleZ : 0) * _DEG_TO_RAD;
    // Compose Rx then Ry then Rz so the user's intuition "first
    // angleX, then angleY, then angleZ" matches the result (vertex
    // sees Rz * Ry * Rx * v = inner-most rotation first).
    const mx = _mat4RotateX(ax);
    const my = _mat4RotateY(ay);
    const mz = _mat4RotateZ(az);
    const tmp = new Float32Array(16);
    const out = new Float32Array(16);
    _mat4Multiply(tmp, my, mx);
    _mat4Multiply(out, mz, tmp);
    return out;
  }
  return _mat4Identity();
}

/* Walk a Scene node's mesh* inputs + return an array of {node, def,
 * transform} entries for each wired mesh source. transform is the
 * accumulated model matrix from the chain of mesh-transform nodes
 * between the Scene and the leaf mesh-gen.
 *
 * Chain semantics (matching the standard scene-graph convention):
 *   leaf-gen → T_inner → T_middle → T_outer → Scene
 * yields a model matrix of M = T_outer · T_middle · T_inner, so the
 * inner-most transform is applied to vertices FIRST. e.g.
 *   Box → Rotate(45deg Y) → Translate(2, 0, 0) → Scene
 * rotates the box around its own origin, THEN translates it out --
 * a satellite-style orbit rather than a swing-around-a-point.
 *
 * To get the "swing around the world origin" behavior, flip the chain:
 *   Box → Translate(2, 0, 0) → Rotate(45deg Y) → Scene
 *
 * Cycle guard at depth 16 -- meshes never chain that deep in practice
 * but a malformed save (self-referential transform) would loop forever
 * without it. */
const _MESH_CHAIN_DEPTH_LIMIT = 16;

function _walkMeshChain(nodeId, accMat, accMaterial, depth) {
  if (depth > _MESH_CHAIN_DEPTH_LIMIT) {
    console.warn("[scene] mesh chain depth limit hit at node " + nodeId + " -- cycle?");
    return null;
  }
  const node = state.nodes.find(n => n && n.id === nodeId);
  if (!node) return null;
  const def = TYPES[node.type];
  if (!def) return null;
  if (def.kind === "mesh-gen") {
    return { node, def, transform: accMat, material: accMaterial };
  }
  if (def.kind === "mesh-transform") {
    const local = _buildTransformMatrix(node);
    // accMat is the world-side accumulator (closer to Scene); we
    // multiply local into the RIGHT side so leaf-side transforms
    // end up rightmost in the product (applied first to vertices).
    const next = new Float32Array(16);
    _mat4Multiply(next, accMat, local);
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "mesh"
    );
    if (!wire || !wire.from) return null;
    return _walkMeshChain(wire.from.node, next, accMaterial, depth + 1);
  }
  if (def.kind === "material") {
    // Sprint 7.5.3c -- material wrapper. The inner mesh is rendered
    // with this material's surface shader. Outer material wins if
    // multiple are stacked (closest to Scene -- the outermost
    // wrapper -- is the one that applies). accMaterial is set on
    // first encounter walking root-to-leaf; subsequent (inner)
    // material wrappers are ignored.
    const myMaterial = accMaterial || _buildMaterialDescriptor(node);
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "mesh"
    );
    if (!wire || !wire.from) return null;
    return _walkMeshChain(wire.from.node, accMat, myMaterial, depth + 1);
  }
  return null;
}

/* Resolve the params of a material node into a flat descriptor used
 * by _encodeScenePass. Material types: "unlit", "phong". */
function _buildMaterialDescriptor(matNode) {
  const p = _resolveNodeParams(matNode);
  if (matNode.type === "UnlitMat") {
    return {
      type: "unlit",
      params: {
        r: (typeof p.r === "number") ? p.r : 1.0,
        g: (typeof p.g === "number") ? p.g : 1.0,
        b: (typeof p.b === "number") ? p.b : 1.0,
        vertexMix: (typeof p.vertexMix === "number") ? p.vertexMix : 0.0
      }
    };
  }
  if (matNode.type === "PhongMat") {
    return {
      type: "phong",
      params: {
        r: (typeof p.r === "number") ? p.r : 0.85,
        g: (typeof p.g === "number") ? p.g : 0.85,
        b: (typeof p.b === "number") ? p.b : 0.92,
        vertexMix: (typeof p.vertexMix === "number") ? p.vertexMix : 0.0,
        shininess: (typeof p.shininess === "number") ? Math.max(1.0, p.shininess) : 32.0,
        ambient:   (typeof p.ambient   === "number") ? p.ambient   : 0.15
      }
    };
  }
  if (matNode.type === "PhysicalMat") {
    return {
      type: "pbr",
      node: matNode,            // A.4 -- needed so the draw loop can read map params + cache loaded views
      params: {
        r: (typeof p.r === "number") ? p.r : 0.85,
        g: (typeof p.g === "number") ? p.g : 0.85,
        b: (typeof p.b === "number") ? p.b : 0.85,
        vertexMix: (typeof p.vertexMix === "number") ? p.vertexMix : 0.0,
        metallic:  (typeof p.metallic  === "number") ? Math.max(0, Math.min(1, p.metallic))  : 0.0,
        roughness: (typeof p.roughness === "number") ? Math.max(0.04, Math.min(1, p.roughness)) : 0.5,
        uvScale:   (typeof p.uvScale   === "number" && p.uvScale > 0) ? p.uvScale : 1.0
      }
    };
  }
  if (matNode.type === "TerrainMaterial") {
    return {
      type: "terrain",
      params: {
        // Slot map: read by the writer in _encodeScenePass. Default
        // values match the Terrain node's default -hs..0 Y range
        // with peaks at 0 (heightScale=12, yOffset=0).
        color1R: (typeof p.color1R === "number") ? p.color1R : 0.85,
        color1G: (typeof p.color1G === "number") ? p.color1G : 0.78,
        color1B: (typeof p.color1B === "number") ? p.color1B : 0.55,
        alt1:    (typeof p.alt1    === "number") ? p.alt1    : -8,
        color2R: (typeof p.color2R === "number") ? p.color2R : 0.40,
        color2G: (typeof p.color2G === "number") ? p.color2G : 0.55,
        color2B: (typeof p.color2B === "number") ? p.color2B : 0.30,
        alt2:    (typeof p.alt2    === "number") ? p.alt2    : -4,
        color3R: (typeof p.color3R === "number") ? p.color3R : 0.45,
        color3G: (typeof p.color3G === "number") ? p.color3G : 0.40,
        color3B: (typeof p.color3B === "number") ? p.color3B : 0.35,
        alt3:    (typeof p.alt3    === "number") ? p.alt3    : -1,
        color4R: (typeof p.color4R === "number") ? p.color4R : 0.92,
        color4G: (typeof p.color4G === "number") ? p.color4G : 0.94,
        color4B: (typeof p.color4B === "number") ? p.color4B : 0.98,
        softness:       (typeof p.softness       === "number") ? p.softness       : 1.0,
        slopeRockiness: (typeof p.slopeRockiness === "number") ? p.slopeRockiness : 1.5,
        shininess:      (typeof p.shininess      === "number") ? Math.max(1, p.shininess) : 8.0,
        ambient:        (typeof p.ambient        === "number") ? p.ambient        : 0.22,
        vertexMix:      (typeof p.vertexMix      === "number") ? p.vertexMix      : 0.0,
        // v0.3.129 v2 detail + bump + snow-mask knobs.
        detailScale:    (typeof p.detailScale    === "number") ? p.detailScale    : 0.5,
        detailStrength: (typeof p.detailStrength === "number") ? p.detailStrength : 0.35,
        microScale:     (typeof p.microScale     === "number") ? p.microScale     : 3.0,
        microStrength:  (typeof p.microStrength  === "number") ? p.microStrength  : 0.20,
        edgeJitter:     (typeof p.edgeJitter     === "number") ? p.edgeJitter     : 1.5,
        bumpStrength:   (typeof p.bumpStrength   === "number") ? p.bumpStrength   : 0.4,
        snowMaskAmount: (typeof p.snowMaskAmount === "number") ? p.snowMaskAmount : 0.8
      }
    };
  }
  if (matNode.type === "ShaderMat") {
    // Sprint 7.5.3c -- preset name from the enum index. The
    // matParams slots get reinterpreted here: shininess=time,
    // ambient=freq, metallic=intensity, roughness=texLayer (for
    // the "texture" preset; unused otherwise). The descriptor
    // stores them under their legacy names so the _encodeScenePass
    // writer works unchanged.
    const presetIdx = (typeof p.preset === "number") ? Math.floor(p.preset) : 0;
    const presetName = _SHADERMAT_PRESET_NAMES[presetIdx] || _SHADERMAT_PRESET_NAMES[0];
    return {
      type: "shadermat-" + presetName,
      node: matNode,            // sprint 7.5.3c push 5 -- needed for texture-input lookup at encode time
      params: {
        r: (typeof p.r === "number") ? p.r : 0.7,
        g: (typeof p.g === "number") ? p.g : 0.85,
        b: (typeof p.b === "number") ? p.b : 1.0,
        vertexMix: 0,
        shininess: (typeof p.time      === "number") ? p.time      : 0,
        ambient:   (typeof p.freq      === "number") ? p.freq      : 1.0,
        metallic:  (typeof p.intensity === "number") ? p.intensity : 1.0,
        roughness: 0
      }
    };
  }
  return null;
}

/* Sprint Level2D Phase 1a -- expand a Level2D into per-layer
 * synthetic mesh entries. Each entry looks (to the rest of the
 * encoder) like a regular Tilemap2D / ParallaxLayer2D / SpriteScatter2D
 * node, so all existing mesh + sprite pipeline paths work unchanged.
 * Synthetic node IDs are stable per (parentId, layerIdx) so
 * Visual.meshBufferCache keys stay stable across renders.
 *
 * Returns an array of mesh entries (same shape as `resolved` in
 * _resolveSceneMeshes). Empty array if the layers JSON is empty
 * or malformed (logs the parse error once per node). */
function _expandLevel2DLayers(levelNode, baseTransform, baseMaterial) {
  if (!levelNode) return [];
  const def = TYPES[levelNode.type];
  if (!def) return [];
  // Phase 5a -- use the cached parsed layers so gameplay-tick
  // mutations (PickupCollector clearing '4' cells, etc) persist
  // across frames instead of being overwritten by a fresh parse.
  const layers = _level2dParsedLayers(levelNode);
  if (!Array.isArray(layers) || layers.length === 0) return [];
  // Camera resolution: if Level2D.camera is wired, use it; else
  // fall back to the first OrthoCamera2D / Camera in the patch.
  // (Same fallback logic ParallaxLayer2D used standalone.)
  let camNodeId = null;
  if (Array.isArray(state.edges)) {
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === levelNode.id && e.to.port === "camera"
    );
    if (wire && wire.from) {
      const src = state.nodes.find(n => n && n.id === wire.from.node);
      if (src) camNodeId = src.id;
    }
  }
  if (!camNodeId) {
    const cam = state.nodes.find(n => n && (n.type === "OrthoCamera2D" || n.type === "Camera" || n.type === "FPCamera"));
    if (cam) camNodeId = cam.id;
  }
  const out = [];
  const TYPE_MAP = {
    tilemap:  "Tilemap2D",
    parallax: "ParallaxLayer2D",
    scatter:  "SpriteScatter2D"
  };
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer || typeof layer !== "object") continue;
    const synthType = TYPE_MAP[layer.type];
    if (!synthType) {
      console.warn("[Level2D " + levelNode.id + "] layer " + i + " unknown type: " + layer.type);
      continue;
    }
    // Phase 4a -- chunk tilemap layers above the threshold. Each
    // chunk becomes its own synthetic Tilemap2D node with its own
    // mesh cache entry, so a 1000-col level only rebuilds the
    // chunks the user actually edits, and empty chunks (all '.')
    // emit no mesh at all -- the cheap part of sparse maps.
    if (layer.type === "tilemap") {
      const chunked = _expandTilemapLayerChunks(levelNode, layer, i, camNodeId, baseTransform, baseMaterial);
      if (chunked) {
        for (const e of chunked) out.push(e);
        continue;
      }
    }
    // Default path: emit a single synthetic node for the whole layer.
    const synthId = levelNode.id + ":lyr" + i + ":" + synthType;
    const synthParams = Object.assign({}, layer);
    delete synthParams.type;
    delete synthParams.name;
    delete synthParams.collides;
    const synthNode = {
      id: synthId,
      type: synthType,
      params: synthParams,
      _isSynthetic: true,
      _levelLayer: layer,
      _levelParentId: levelNode.id,
      _levelCameraNodeId: camNodeId
    };
    out.push({
      node: synthNode,
      def: TYPES[synthType],
      transform: baseTransform,
      material: baseMaterial,
      _level2DLayer: true,
      _level2DLayerName: layer.name || ("layer" + i)
    });
  }
  return out;
}

/* Phase 4a -- split a tilemap layer's tileData into fixed-size
 * cell chunks, each emitted as its own synthetic Tilemap2D node.
 *
 * Returns:
 *   null               -- layer is small enough to stay single-mesh
 *   [synthEntries...]  -- one entry per non-empty chunk
 *
 * Chunk size is 64x64 cells (~4 KB of verts in the worst case);
 * threshold to chunk at all is 4096 cells total (so a typical
 * 17x8 demo map stays single-mesh, but a 170x80 or 1000x80 map
 * splits into manageable buffers).
 *
 * Empty chunks (every cell is '.' or ' ') emit nothing -- crucial
 * for sparse maps where most of the world is sky. */
const _LVL_TILEMAP_CHUNK_THRESHOLD = 4096;   // total cells; below this stay single-mesh
const _LVL_TILEMAP_CHUNK_W = 64;
const _LVL_TILEMAP_CHUNK_H = 64;

function _expandTilemapLayerChunks(levelNode, layer, layerIdx, camNodeId, baseTransform, baseMaterial) {
  const tileData = (typeof layer.tileData === "string") ? layer.tileData : "";
  if (!tileData.length) return null;
  const rowsArr = tileData.split("\n");
  const parentRows = rowsArr.length;
  const parentCols = rowsArr.reduce((m, r) => Math.max(m, r.length), 0);
  if (parentCols === 0) return null;
  if (parentRows * parentCols <= _LVL_TILEMAP_CHUNK_THRESHOLD) return null;
  const ts = (typeof layer.tileSize === "number" && layer.tileSize > 0) ? layer.tileSize : 1;
  const ox = (typeof layer.originX === "number") ? layer.originX : 0;
  const oy = (typeof layer.originY === "number") ? layer.originY : 0;
  const cxParent = (parentCols - 1) * 0.5;
  const cyParent = (parentRows - 1) * 0.5;
  const chunkW = _LVL_TILEMAP_CHUNK_W;
  const chunkH = _LVL_TILEMAP_CHUNK_H;
  const nChunkX = Math.ceil(parentCols / chunkW);
  const nChunkY = Math.ceil(parentRows / chunkH);
  const out = [];
  let emitted = 0, skipped = 0;
  for (let cr = 0; cr < nChunkY; cr++) {
    const r0 = cr * chunkH;
    const r1 = Math.min(parentRows, r0 + chunkH);
    const thisChunkH = r1 - r0;
    for (let cc = 0; cc < nChunkX; cc++) {
      const c0 = cc * chunkW;
      const c1 = Math.min(parentCols, c0 + chunkW);
      const thisChunkW = c1 - c0;
      // Slice tileData for this chunk + check for empty.
      let chunkNonEmpty = false;
      const chunkLines = new Array(thisChunkH);
      for (let rr = 0; rr < thisChunkH; rr++) {
        const srcLine = rowsArr[r0 + rr] || "";
        const sub = srcLine.substring(c0, c1).padEnd(thisChunkW, ".");
        chunkLines[rr] = sub;
        if (!chunkNonEmpty) {
          for (let k = 0; k < sub.length; k++) {
            const ch = sub[k];
            if (ch !== "." && ch !== " ") { chunkNonEmpty = true; break; }
          }
        }
      }
      if (!chunkNonEmpty) { skipped++; continue; }
      // World origin for this chunk: position its center cell so that
      // the chunk's cells land at the SAME world positions as the
      // un-chunked parent would. Derivation in CLAUDE.md / Phase 4
      // commit: chunkOX = (cc*chunkW - cxParent + cxChunk) * ts + ox.
      const cxChunk = (thisChunkW - 1) * 0.5;
      const cyChunk = (thisChunkH - 1) * 0.5;
      const chunkOX = (c0 - cxParent + cxChunk) * ts + ox;
      const chunkOY = (cyParent - r0 - cyChunk) * ts + oy;
      const synthParams = Object.assign({}, layer);
      delete synthParams.type;
      delete synthParams.name;
      delete synthParams.collides;
      synthParams.tileData = chunkLines.join("\n");
      synthParams.originX  = chunkOX;
      synthParams.originY  = chunkOY;
      const synthId = levelNode.id + ":lyr" + layerIdx + ":c" + cr + "_" + cc + ":Tilemap2D";
      const synthNode = {
        id: synthId,
        type: "Tilemap2D",
        params: synthParams,
        _isSynthetic: true,
        _levelLayer: layer,
        _levelParentId: levelNode.id,
        _levelCameraNodeId: camNodeId,
        // Hooks for the upcoming Phase 4b frustum culling: precomputed
        // world AABB for this chunk so the dispatch can early-out
        // without re-parsing tileData. minY/maxY computed assuming
        // row 0 is at +Y (matches _buildTilemap2D's convention).
        _levelChunkBounds: {
          minX: chunkOX - thisChunkW * 0.5 * ts,
          maxX: chunkOX + thisChunkW * 0.5 * ts,
          minY: chunkOY - thisChunkH * 0.5 * ts,
          maxY: chunkOY + thisChunkH * 0.5 * ts
        }
      };
      out.push({
        node: synthNode,
        def: TYPES["Tilemap2D"],
        transform: baseTransform,
        material: baseMaterial,
        _level2DLayer: true,
        _level2DLayerName: (layer.name || ("layer" + layerIdx)) + ":c" + cr + "_" + cc
      });
      emitted++;
    }
  }
  if (!levelNode._lvlChunkLogged || levelNode._lvlChunkLogged !== parentRows + "x" + parentCols) {
    levelNode._lvlChunkLogged = parentRows + "x" + parentCols;
    console.log("[Level2D " + levelNode.id + "] lyr" + layerIdx + " chunked " +
      parentCols + "x" + parentRows + " into " + emitted + " non-empty + " + skipped + " empty (" +
      chunkW + "x" + chunkH + " cells per chunk)");
  }
  return out;
}

function _resolveSceneMeshes(sceneNode) {
  const meshes = [];
  const def = TYPES[sceneNode.type];
  if (!def || !Array.isArray(def.ins)) return meshes;
  for (const port of def.ins) {
    if (!port || port.t !== "mesh") continue;
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === sceneNode.id && e.to.port === port.n
    );
    if (!wire || !wire.from) continue;
    // Phase 8.A.5 -- Pool wires fan out into one mesh entry per
    // active voice. Pre-emptive check before the PrefabInstance
    // intercept since Pool is its own type.
    const poolSrc = state.nodes.find(n => n && n.id === wire.from.node);
    if (poolSrc && poolSrc.type === "Pool" && wire.from.port === "mesh") {
      const voiceEntries = _expandPoolVoices(poolSrc, _mat4Identity(), null);
      for (const e of voiceEntries) {
        if (e.node && !_isNodeActive(e.node)) continue;
        meshes.push(e);
      }
      continue;
    }
    // Phase 8.A.3 -- PrefabInstance wires pierce the abstraction:
    // a wire from instance.mesh redirects to the exposed child's
    // actual mesh port before _walkMeshChain runs.
    const prefabResolved = _prefabResolveFromEndpoint(wire);
    const startNodeId = prefabResolved ? prefabResolved.node : wire.from.node;
    const resolved = _walkMeshChain(startNodeId, _mat4Identity(), null, 0);
    if (!resolved) continue;
    // Phase 8.A.2-filtering: drop mesh chains rooted at a node in an
    // inactive stage. The leaf is the actual mesh source (Tilemap2D,
    // Sprite, Level2D, Box, etc); intermediate transforms don't have
    // stage tags. So gating on the leaf is enough.
    if (resolved.node && !_isNodeActive(resolved.node)) continue;
    // Level2D Phase 1a: expand into per-layer synthetic entries.
    // The Level2D node itself emits nothing; its layers become
    // independent mesh entries that the existing sprite + mesh
    // pipelines handle as if they were wired one-per-slot.
    if (resolved.node && resolved.node.type === "Level2D") {
      const layerEntries = _expandLevel2DLayers(resolved.node, resolved.transform, resolved.material);
      for (const e of layerEntries) meshes.push(e);
      continue;
    }
    meshes.push(resolved);

    // Phase 8 sprint 8-7b: when the resolved leaf is a PlanetMesh,
    // also synthesize a "detail patch" mesh entry beside it. The
    // patch entry borrows the PlanetMesh node's params (now hosting
    // the detail-patch knobs directly) so the user doesn't need to
    // wire a separate node.
    if (resolved.node && resolved.node.type === "PlanetMesh") {
      const pp = resolved.node.params || {};
      // Sprint 9-1: detail patch retired in favor of cube-sphere
      // quadtree (Phase 9). Default off when param is missing; old
      // saves with explicit detailPatchEnabled=1 still synthesize.
      const enabled = (typeof pp.detailPatchEnabled === "number")
        ? pp.detailPatchEnabled >= 0.5
        : false;
      if (enabled) {
        meshes.push({
          node: resolved.node,
          def: resolved.def,
          transform: resolved.transform,
          material: resolved.material,
          isPlanetDetailPatch: true
        });
      }
    }
  }
  return meshes;
}

/* Phase 6.5.4 — JS-side MasterClock value computation. Mirrors the
 * C++ GammaMasterClock helper class (registry line ~9405) but uses
 * performance.now() as the time source instead of audio sample
 * counts. Returns a different shape per output port:
 *
 *   bpm                          → the static bpm param (constant)
 *   phase                        → 0..1 ramp within current beat
 *                                  (linear, matches C++ behavior)
 *   bar / beat / quarter /       → cubic-decay envelope per subdivision
 *   eighth / sixteenth             (1.0 at the rising edge, ~0 just
 *                                  before next edge). Different from
 *                                  the C++ form (which emits a
 *                                  one-sample 1.0 pulse) -- the
 *                                  envelope shape is more useful for
 *                                  shader uniforms than a sparse gate.
 *
 * Periods:
 *   bar       = 4 beats
 *   beat      = 1 beat
 *   quarter   = 1 beat  (quarter-note = beat; matches C++ naming)
 *   eighth    = 0.5 beat
 *   sixteenth = 0.25 beat
 *
 * Drift vs the audio-side C++ MasterClock: both sides use BPM-based
 * time math; the C++ side uses sample-accurate sampleCount/sampleRate,
 * we use wall-clock performance.now(). At 48 kHz typical clock-drift
 * is sub-ms per minute -- imperceptible for visuals. Sample-accurate
 * audio-driven sync (worklet writes ticks to SAB) is a follow-on
 * ticket once we have wasm-export plumbing. */
function _masterClockOutputValue(node, portName) {
  const bpm = Math.max(1, (node && node.params && typeof node.params.bpm === "number") ? node.params.bpm : 120);
  const startT = (typeof Visual !== "undefined" && Visual && Visual.startTime) ? Visual.startTime : 0;
  const tSec = (performance.now() - startT) * 0.001;
  const totalBeats = tSec * (bpm / 60.0);
  if (portName === "bpm")   return bpm;
  if (portName === "phase") return totalBeats - Math.floor(totalBeats);
  const fracOf = (period) => {
    const x = totalBeats / period;
    return x - Math.floor(x);
  };
  if (portName === "bar")       { const f = fracOf(4.0);   const m = 1.0 - f; return m * m * m; }
  if (portName === "beat")      { const f = fracOf(1.0);   const m = 1.0 - f; return m * m * m; }
  if (portName === "quarter")   { const f = fracOf(1.0);   const m = 1.0 - f; return m * m * m; }
  if (portName === "eighth")    { const f = fracOf(0.5);   const m = 1.0 - f; return m * m * m; }
  if (portName === "sixteenth") { const f = fracOf(0.25);  const m = 1.0 - f; return m * m * m; }
  return 0;
}

/* Phase 6.6.28 — wrap a node so its .params reads return the wire-
 * resolved values. Used to pass into def.writeUniforms + dynamic
 * wgsl functions without changing their (node, scratch) signature. */
function _nodeWithResolvedParams(node) {
  if (!node) return node;
  const resolved = _resolveNodeParams(node);
  // Object.assign here intentionally clones the node shallowly so we
  // don't mutate the user's patch state with a swapped .params.
  return Object.assign({}, node, { params: resolved });
}

function _resolveTextureInputLayer(node, portName, consumerVOId) {
  if (typeof state === "undefined" || !state ||
      !Array.isArray(state.edges) || !Array.isArray(state.nodes)) return -1;
  const incoming = state.edges.find(e =>
    e && e.to && e.to.node === node.id && e.to.port === portName
  );
  if (!incoming) return -1;
  const sourceNodeId = incoming.from && incoming.from.node;
  if (!sourceNodeId) return -1;
  // Phase 6.6.26 — first try the current frame's render plan
  // (scratch-layer assignments + direct-VO assignments). The plan
  // key is `${sourceNodeId}@${consumerVOId}` so we get the
  // pose-correct render of the source for this specific consumer.
  if (Visual._currentRenderPlan && consumerVOId) {
    const planEntry = Visual._currentRenderPlan.get(sourceNodeId + "@" + consumerVOId);
    if (planEntry && planEntry.layerIdx >= 0) return planEntry.layerIdx;
  }
  // Legacy fallback (pre-6.6.26): direct downstream VisualOutput on
  // the source itself. Only matters if the plan didn't capture it
  // for some reason (e.g. called without consumerVOId).
  const vo = state.nodes.find(n =>
    n && n.type === "VisualOutput" &&
    state.edges.some(e =>
      e && e.from && e.from.node === sourceNodeId &&
      e.to && e.to.node === n.id && e.to.port === "in"
    )
  );
  if (!vo) return -1;
  let layerIdx = (vo.params && typeof vo.params.display === "number")
    ? (vo.params.display | 0) : 0;
  if (layerIdx < 0) layerIdx = 0;
  const layerCount = (Visual.framebufferLayerViews &&
                      Visual.framebufferLayerViews.length) || 1;
  if (layerIdx >= layerCount) layerIdx = layerCount - 1;
  return layerIdx;
}

function _encodeShaderFragPassForVO(enc, vo, src, def, dtSec, layerIdx) {
  const layerView = Visual.framebufferLayerViews[layerIdx];
  if (!layerView) return false;
  // Phase 6.6.23 — pass the source node so def.wgsl can be a
  // (srcNode) => string function. Null inst means the dynamic
  // WGSL function threw or returned non-string; skip frame.
  // Phase 6.6.28 — substitute wire-resolved param values so the
  // dynamic WGSL function (e.g. Text's text param) sees live
  // Slider values, not just the manual fallback.
  const srcResolvedForInst = _nodeWithResolvedParams(src);
  const inst = _ensureShaderInstance(vo.id, def, srcResolvedForInst);
  if (!inst) return false;
  const entry = inst.pipelineEntry;
  if (!entry || !entry.pipeline) return false;

  // Pack uniforms — preamble (with this VO's display pose + a
  // per-consumer-set worldUv) first, then the registry-declared
  // writer for per-shader params. Note: writeUniforms receives the
  // SOURCE node (the shader producer) since that's where the
  // shader's params live; the VO is just the display routing target.
  //
  // u_world_uv is computed from the SHADER'S CONSUMER SET, not the
  // raw rig display slice. Solo consumer → (0,0,1,1) so the shader
  // renders full coverage on its display (one pinwheel = one full
  // pinwheel). Shared shader (multiple VOs wired to same source) →
  // each VO gets its slice within the consumer-set bbox so the
  // shader spans the connected displays correctly.
  const display = state.rig && state.rig.displays && state.rig.displays[layerIdx];
  const renderWuv = _renderWorldUvForVO(vo, src.id);
  _writeShaderPreamble(inst.scratch, dtSec, display, renderWuv, layerIdx);
  // Phase 6.6.28 — pass the wire-resolved src (computed above for
  // the dynamic WGSL function) to writeUniforms too. writeUniforms
  // sees node.params as the merged view (manual params + wired
  // Slider values), existing registry code is unchanged.
  if (typeof def.writeUniforms === "function") {
    def.writeUniforms(srcResolvedForInst, inst.scratch);
  }
  // Phase 6.6.24 — for each composition shader-frag with declared
  // texture input ports + a textureInputSlots map (port -> scratch
  // slot), resolve the wired source -> downstream-VO display layer
  // and OVERRIDE the slot writeUniforms just filled with its manual
  // default. Unwired ports leave the manual default in place so the
  // user can still type a layer index when no VO is downstream of
  // their source. textureInputSlots is opt-in per-def -- nodes that
  // don't declare it (most shader-frags) skip this entirely.
  const slotMap = def.textureInputSlots;
  if (slotMap && Array.isArray(def.ins)) {
    for (const port of def.ins) {
      if (!port || port.t !== "texture") continue;
      const slot = slotMap[port.n];
      if (typeof slot !== "number") continue;
      const resolved = _resolveTextureInputLayer(src, port.n, vo.id);
      if (resolved >= 0) inst.scratch[slot] = resolved;
    }
  }
  Visual.device.queue.writeBuffer(inst.uniformBuffer, 0, inst.scratch.buffer, inst.scratch.byteOffset, inst.scratch.byteLength);

  const pass = enc.beginRenderPass({
    label: "shader-frag-" + def.kind + "-" + src.type + "-vo-" + vo.id + "-layer-" + layerIdx,
    colorAttachments: [{
      view: layerView,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  pass.setPipeline(entry.pipeline);
  pass.setBindGroup(0, inst.bindGroup);
  pass.draw(3);
  pass.end();
  return true;
}

/* Encode a bare render pass that clears one framebuffer layer to
 * solid black. Used for layers that don't get a shader pass this
 * frame — either no VisualOutput targets them (orphan layers in a
 * multi-display rig with fewer VOs than displays) or the targeting
 * VO has no valid source (just disconnected, or source isn't a
 * shader-frag, or the pipeline is still compiling). Without this,
 * GPU texture memory persists across frames and the compositor
 * samples stale content — visible as "frozen on last input" after
 * disconnect. */
function _encodeLayerClear(enc, layerIdx) {
  const layerView = Visual.framebufferLayerViews[layerIdx];
  if (!layerView) return;
  enc.beginRenderPass({
    label: "fbo-layer-clear-" + layerIdx,
    colorAttachments: [{
      view: layerView,
      clearValue: { r: 0, g: 0, b: 0, a: 1.0 },
      loadOp: "clear",
      storeOp: "store"
    }]
  }).end();
}

/* Walk every VisualOutput in the patch and encode a render pass for
 * each that has a wired shader-frag source. ALSO clears any layer
 * that didn't receive a shader pass this frame (orphan layers OR
 * unsourced VOs) so disconnect-then-reconnect doesn't leak stale
 * content. Returns true whenever there's ≥ 1 VisualOutput in the
 * patch — composite runs in that case to show the rig grid with
 * black cells where appropriate. Returns false only when the patch
 * has zero VOs, in which case the legacy smoke-clear fallback path
 * takes over.
 *
 * Phase 6.5.6: same shader feeding multiple VOs runs N times, each
 * with display-specific uniforms. Pipeline cache hashes by WGSL so
 * all N share one compiled pipeline; only the bind groups + uniform
 * buffers differ. The user-confirmed "pinwheel spans two displays"
 * behavior comes from each shader pass reading its display's
 * u_world_uv slice and outputting the corresponding portion of the
 * shared world.
 *
 * Multi-stage chains (Gradient → Blur → VisualOutput) still need
 * intermediate textures + ping-pong FBO management — that's 6.3.2.
 * Today: VisualOutput.in must come directly from a shader-frag
 * source. */
function _encodeVisualGraph(enc, dtSec) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return false;
  const visualOutputs = state.nodes.filter(n => n.type === "VisualOutput");
  if (visualOutputs.length === 0) return false;
  const layerCount = Visual.framebufferLayerViews.length || 1;
  const renderedLayers = new Set();

  // Phase 6.6.30 — build the per-VO render plan + render schedules.
  // Each VO has its own ordered sequence of passes: scratch passes
  // (upstream composition inputs, rendered with THIS VO's pose) then
  // the VO's direct shader-frag pass. Scratch slots are RELATIVE
  // indices into Visual.scratchTexture (0..SCRATCH_BUDGET-1) and
  // get REUSED across consumer VOs -- consumer A's scratch passes
  // write the slots, A's composition reads them, then B's scratch
  // passes overwrite the same slots before B's composition reads.
  // Same-frame reads via the composition bind layout, so no 1-frame
  // lag and per-VO pose correctness even when one composition node
  // distributes to 26 displays.
  const planResult = _buildRenderPlan(visualOutputs);
  Visual._currentRenderPlan = planResult.plan;

  for (const vo of visualOutputs) {
    const schedule = planResult.schedules.get(vo.id) || [];
    for (const entry of schedule) {
      const ok = _encodeShaderFragPassForPlan(enc, entry, dtSec);
      if (ok && !entry.isScratch) renderedLayers.add(entry.layerIdx);
    }
  }

  // Clear every framebuffer layer that didn't get a shader pass this
  // frame — covers unwired VOs, orphan layers, pipeline-still-
  // compiling new shader-frags. Scratch slots don't need clearing
  // (next frame's per-VO render overwrites them, and unused ones
  // sample to whatever was there last — but no composition node
  // reads them unless wired, and unwired texture ports return the
  // manual layer-index fallback instead).
  for (let i = 0; i < layerCount; i++) {
    if (!renderedLayers.has(i)) _encodeLayerClear(enc, i);
  }
  return true;
}

