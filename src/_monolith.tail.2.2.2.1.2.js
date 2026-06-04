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

/* Phase 6.6.30 + v0.2.16 — walk the patch graph from each VisualOutput
 * and build a per-VO render schedule plus a flat key->entry map for
 * texture-input resolution. Three properties to maintain:
 *
 *   1. Scratch slots are RELATIVE indices (0..SCRATCH_BUDGET-1) into
 *      the per-parity scratch texture. Per-VO counters reset to 0,
 *      with separate counters for "a" and "b" textures.
 *
 *   2. Per-VO schedule is post-order DFS (leaves first, target last)
 *      so by the time a composition pass runs, all its upstream
 *      scratch slots have been written this frame.
 *
 *   3. v0.2.16 — chain depth tracked recursively. depth=0 = direct
 *      VO consumer (writes framebuffer). depth=N = N levels above
 *      the VO in the chain (writes scratch). Each entry carries:
 *        readKey  = (depth     % 2 === 0) ? "a" : "b"
 *        writeKey = ((depth-1) % 2 === 0) ? "a" : "b"   (depth >= 1)
 *      Composition shaders bind READ key for their texture and
 *      attach a layer of the WRITE key's scratch texture. They are
 *      always different parities, so WebGPU never sees the same
 *      texture in both TextureBinding and RenderAttachment in one pass.
 *
 * planKey:    `${sourceNodeId}@${consumerVOId}` -- unique per
 *             (source × consumer VO) pair. Lookup target for
 *             _resolveTextureInputLayer.
 * planEntry:  { node, def, layerIdx, consumerVO, isScratch,
 *               depth, readKey, writeKey }. layerIdx is RELATIVE to
 *             whichever scratch texture writeKey selects (for
 *             isScratch) or the framebuffer display layer (direct). */
function _buildRenderPlan(visualOutputs) {
  const plan = new Map();
  const schedules = new Map();
  if (!Array.isArray(state.edges) || !Array.isArray(state.nodes)) {
    return { plan, schedules };
  }

  const rigDisplayCount = (state.rig && state.rig.displays) ? state.rig.displays.length : 1;
  const SCRATCH_BUDGET = (typeof Visual.scratchBudget === "number") ? Visual.scratchBudget : 8;

  for (const vo of visualOutputs) {
    const sched = [];
    schedules.set(vo.id, sched);
    // Per-parity scratch counters (v0.2.16). Each parity has up to
    // SCRATCH_BUDGET slots; the per-VO walk uses one slot from the
    // matching counter per scratch entry.
    let counterA = 0;
    let counterB = 0;

    function walk(nodeId, isViaCompPort, depth) {
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;
      const def = TYPES[node.type];
      // v0.3.3 — "ai-vision-canvas" is the second kind that participates
      // in the visual render plan. Doesn't have a WGSL shader; instead
      // the framework queues a copyExternalImageToTexture from a 2D
      // canvas (where the detection loop drew video + landmark overlay)
      // straight into the assigned framebuffer/scratch layer. The plan
      // walker treats it like a shader-frag for layer assignment +
      // post-order DFS scheduling, then _encodeShaderFragPassForPlan
      // dispatches by kind at encode time.
      if (!def) return;
      // R.2: StageManager is a texture router — trace through
      // only the active stage's input, skip inactive scenes.
      if (def.kind === "stage-manager") {
        const activeIdx = Math.floor(node.params && typeof node.params.current === "number" ? node.params.current : 0);
        const portName = "in" + Math.max(0, Math.min(3, activeIdx));
        const wire = state.edges.find(e =>
          e && e.to && e.to.node === nodeId && e.to.port === portName
        );
        if (wire && wire.from) walk(wire.from.node, isViaCompPort, depth);
        return;
      }
      const isShaderFrag = def.kind === "shader-frag" &&
                           (typeof def.wgsl === "string" || typeof def.wgsl === "function");
      const isAiCanvas   = def.kind === "ai-vision-canvas";
      // Sprint 7.5.3a -- Scene nodes also produce a layer (their
      // 3D render lands in a framebuffer / scratch layer like a
      // shader-frag's output), so they participate in the plan
      // walk. Mesh + Camera inputs aren't layer-producers and
      // get resolved at encode time, not via the plan.
      const isScene      = def.kind === "scene";
      // Sprint 7.5.6.a part 2d -- RayTracedScene is the RT
      // equivalent of Scene; same plan-walker treatment. Its
      // output is a blit of the streamed RT texture onto the
      // assigned framebuffer/scratch layer.
      const isSceneRt    = def.kind === "scene-rt";
      if (!isShaderFrag && !isAiCanvas && !isScene && !isSceneRt) return;

      const planKey = node.id + "@" + vo.id;
      if (plan.has(planKey)) return;

      // readKey: which scratch texture THIS node reads from when it
      //   binds the composition layout (= parity of depth).
      // writeKey: which scratch texture THIS scratch entry writes to.
      //   Always opposite parity of readKey so a single pass never
      //   binds + attaches the same texture.
      const readKey  = (depth      % 2 === 0) ? "a" : "b";
      const writeKey = isViaCompPort
        ? (((depth - 1) % 2 === 0) ? "a" : "b")
        : null;

      let layerIdx;
      let isScratch;
      if (isViaCompPort) {
        if (writeKey === "a") {
          if (counterA >= SCRATCH_BUDGET) return;
          layerIdx = counterA++;
        } else {
          if (counterB >= SCRATCH_BUDGET) return;
          layerIdx = counterB++;
        }
        isScratch = true;
      } else {
        layerIdx = (vo.params && typeof vo.params.display === "number")
          ? (vo.params.display | 0) : 0;
        if (layerIdx < 0) layerIdx = 0;
        if (layerIdx >= rigDisplayCount) layerIdx = rigDisplayCount - 1;
        isScratch = false;
      }

      const entry = { node, def, layerIdx, consumerVO: vo, isScratch, depth, readKey, writeKey };
      plan.set(planKey, entry);

      // Recurse FIRST (post-order DFS) so leaves render before
      // their downstream consumers within the schedule.
      if (Array.isArray(def.ins)) {
        for (const port of def.ins) {
          if (!port || port.t !== "texture") continue;
          const wire = state.edges.find(e =>
            e && e.to && e.to.node === nodeId && e.to.port === port.n
          );
          if (!wire || !wire.from) continue;
          walk(wire.from.node, true, depth + 1);
        }
      }
      // Sprint 7.5.3c push 5 -- Scene nodes also need to schedule
      // upstream visuals wired into any ShaderMat's `texture` input
      // somewhere down the mesh chain. Walk through mesh-typed
      // inputs (mesh1..mesh4) through transforms + materials until
      // we hit a mesh-gen leaf, calling `walk` on any texture input
      // encountered on a ShaderMat node. The upstream gets
      // scheduled into a scratch slot before this Scene renders.
      if (isScene && Array.isArray(def.ins)) {
        const visited = new Set();
        const walkMeshChainForTextures = (chainNodeId, chainDepth) => {
          if (chainDepth > 16 || visited.has(chainNodeId)) return;
          visited.add(chainNodeId);
          const chainNode = state.nodes.find(n => n && n.id === chainNodeId);
          if (!chainNode) return;
          const chainDef = TYPES[chainNode.type];
          if (!chainDef) return;
          // Any texture-typed input on this chain node gets walked
          // (covers ShaderMat.texture). Schedule the upstream into
          // a scratch slot at depth+1 from THIS Scene.
          if (Array.isArray(chainDef.ins)) {
            for (const port of chainDef.ins) {
              if (!port || port.t !== "texture") continue;
              const w = state.edges.find(e =>
                e && e.to && e.to.node === chainNodeId && e.to.port === port.n
              );
              if (w && w.from) walk(w.from.node, true, depth + 1);
            }
          }
          // Recurse upstream through the chain. mesh-gen is a leaf.
          if (chainDef.kind === "material" || chainDef.kind === "mesh-transform") {
            const meshWire = state.edges.find(e =>
              e && e.to && e.to.node === chainNodeId && e.to.port === "mesh"
            );
            if (meshWire && meshWire.from) {
              walkMeshChainForTextures(meshWire.from.node, chainDepth + 1);
            }
          }
        };
        for (const port of def.ins) {
          if (!port || port.t !== "mesh") continue;
          const meshWire = state.edges.find(e =>
            e && e.to && e.to.node === nodeId && e.to.port === port.n
          );
          if (!meshWire || !meshWire.from) continue;
          walkMeshChainForTextures(meshWire.from.node, 0);
        }
      }
      sched.push(entry);
    }

    const incoming = state.edges.find(e =>
      e && e.to && e.to.node === vo.id && e.to.port === "in"
    );
    if (incoming && incoming.from) walk(incoming.from.node, false, 0);
  }
  return { plan, schedules };
}

/* =========================================================================
 * Sprint 7.5.3a -- 3D mesh pipeline + Scene render pass
 *
 * Unlit vertex-color pipeline for the smoke-test phase. The vertex
 * shader transforms (model * viewProj) and passes a vec3 color
 * attribute through to the fragment shader. Sprint 7.5.3c replaces
 * this with materials (UnlitMat / PhongMat / PhysicalMat / ShaderMat).
 *
 * Pipeline state:
 *   vertex buffer:   (pos.xyz, color.rgb) interleaved float32
 *   topology:        triangle-list (mesh nodes drive this in 7.5.3b
 *                    when they pick e.g. triangle-strip for cylinder
 *                    sides)
 *   cull:            none (mesh sources control winding directly)
 *   depth-test:      less, depth-write enabled, depth32float
 *   blend:           premultiplied alpha (standard for video layers)
 *
 * The bind group layout has a single uniform buffer at @binding(0)
 * holding viewProj (mat4) + model (mat4) = 128 bytes. Per-mesh draws
 * overwrite the model portion + queue.writeBuffer before each draw. */
/* Sprint 7.5.3c -- mesh shader module with one vertex shader + three
 * fragment entry points so the pipeline cache can serve every
 * material flavor from a single compiled module. Vertex layout
 * grew to (pos.xyz, color.rgb, normal.xyz) -- 9 floats per vertex,
 * stride 36 bytes -- so Phong has real surface normals to dot
 * against the light direction. Normal is transformed by the model
 * matrix here (works for rotation + uniform scale + translation;
 * non-uniform scale gives slight inaccuracy, acceptable for sprint
 * scope). Per-Scene + per-draw uniforms are split: viewProj +
 * camera eye + light data stays constant for every draw in a
 * Scene; model matrix + material params change per mesh. */
const _MESH_WGSL =
`// Sprint 7.5.3c push 3 -- multi-light. Up to 4 lights per Scene
// (MAX_LIGHTS); each fragment loops over lightCount and accumulates
// contributions from each enabled light. Three supported types
// dispatched via pos.w:
//   0 = directional: pos.xyz is unit direction TO the light
//   1 = point:       pos.xyz is world position; falloff via params.x range
//   2 = spot:        pos.xyz is world position; spotDir.xyz is the spot's
//                    pointing direction; params.y/z are cos(innerAngle/2)
//                    + cos(outerAngle/2) for the cone-edge smooth falloff
struct Light {
  pos:     vec4<f32>,
  color:   vec4<f32>,
  params:  vec4<f32>,
  spotDir: vec4<f32>,
};

struct PerScene {
  viewProj:   mat4x4<f32>,
  eye:        vec4<f32>,        // .xyz = camera world position
  lightCount: vec4<f32>,        // .x = active light count (1..4)
  lights:     array<Light, 4>,
  // Sprint 7.5.4 -- environment / IBL. envParams.x is the mode:
  //   0 = no environment wired -> hardcoded blue-gray hemisphere-IBL
  //       fallback (matches pre-7.5.4 look so existing patches don't
  //       shift colors when the buffer layout grows).
  //   1 = GradientSky: 3-stop gradient driven by direction.y, with
  //       envSky.rgb at +Y, envHorizon.rgb at the equator, and
  //       envGround.rgb at -Y. envParams.y is intensity multiplier.
  //   2 = ProceduralSky (7.5.4.c): hand-tuned Rayleigh+Mie style
  //       scattering. envSun.xyz = direction TO the sun (computed
  //       JS-side from time-of-day), envSun.w = visibility in [0,1]
  //       (0 below horizon, smoothly 1 above). envParams.z =
  //       turbidity (haze; pushes color toward horizon tones),
  //       envParams.w = mieG (forward-scatter anisotropy, ~0.76).
  //       envSky/envHorizon/envGround unused for this mode.
  // Future modes (Skybox = 3, HDRI = 4) re-use the same shape, bind
  // a cubemap/equirect texture, and dispatch in sample_env.
  envParams:  vec4<f32>,
  envSky:     vec4<f32>,
  envHorizon: vec4<f32>,
  envGround:  vec4<f32>,
  envSun:     vec4<f32>,
  // Sprint 7.5.4.c-sky -- camera basis for the sky background pass.
  // Pre-computed JS-side from the same eye/target/up the viewProj
  // matrix uses, so the sky's reconstructed world ray matches what
  // the meshes are projected against. .w slots:
  //   camRight.w   = tan(fov/2) * aspect
  //   camUp.w      = tan(fov/2)
  //   camForward.w = 0 for perspective, 1 for ortho (ortho sky uses
  //                  a flat color from camForward direction).
  camRight:   vec4<f32>,
  camUp:      vec4<f32>,
  camForward: vec4<f32>,
  // Sprint 7.5.4.d -- volumetric-ish clouds. 2D fbm on a cloud plane
  // sampled per view ray. ProceduralSky resolver packs these; other
  // env sources leave them zero (no clouds shown).
  //   envCloudParams.x = coverage [0,1]
  //   envCloudParams.y = density multiplier (0 = clear sky)
  //   envCloudParams.z = wind X offset (= windSpeedX * elapsed_s)
  //   envCloudParams.w = wind Z offset (= windSpeedZ * elapsed_s)
  envCloudParams: vec4<f32>,
  // Sprint 7.5.4.e -- distance fog (Scene-level, not env-side).
  //   envFogParams.x  = density (Beer-Lambert e^(-density * dist))
  //   envFogParams.y  = start distance (no fog inside this)
  //   envFogParams.z  = height falloff (0 = uniform; >0 = ground fog)
  //   envFogParams.w  = autoPullEnv (>0.5 = sample env in camera-fwd
  //                    for fog color; otherwise use envFogColor.rgb)
  //   envFogColor.rgb = manual fog color
  envFogParams: vec4<f32>,
  envFogColor:  vec4<f32>,
  // Sprint 7.6.a-atm -- planet-aware atmosphere (Tier B single-
  // scattering Rayleigh+Mie). When envPlanet.w > 0 a planet is wired
  // in the scene and fs_sky switches from flat-ground scattering to
  // proper spherical integration through the atmosphere shell.
  //   envPlanet.xyz   = planet center (world space)
  //   envPlanet.w     = planet surface radius (world units, 0 = no planet)
  //   envPlanetAtm.x  = atmosphere top radius (planetR * (1 + atmFrac))
  //   envPlanetAtm.y  = Rayleigh scale height (world units)
  //   envPlanetAtm.z  = Mie scale height (world units)
  //   envPlanetAtm.w  = sun radiance multiplier (calibrated ~22 for Earth)
  envPlanet:    vec4<f32>,
  envPlanetAtm: vec4<f32>,
  // Sprint 7.6.b-atm Tier-C.0+ -- planet geometry. The planet is
  // rendered as an oblate spheroid (Y axis scaled by polRatio),
  // so the atmosphere must intersect/sample against the SAME
  // ellipsoid shape rather than a sphere. envPlanetGeom.x carries
  // the polRatio; remaining slots reserved for future expansion
  // (e.g. axial-tilt quaternion when planets get rotation).
  //   envPlanetGeom.x = polRatio (1.0 = perfect sphere)
  //   envPlanetGeom.y = terrain height at camera's lat/lon, m above
  //                     planetR (0 = camera over ocean / sea level).
  //                     Sprint 10-6 v7: used to shift LUT lookup from
  //                     MSL to AGL so atmosphere references local
  //                     terrain rather than always sea level.
  //   envPlanetGeom.zw = reserved
  envPlanetGeom: vec4<f32>,
  // Sprint 8-4 -- per-biome detail-noise parameters editable via the
  // PlanetMap modal's Biomes tab. 13 biomes x 2 vec4 each:
  //   biomeParams[k*2 + 0] = (amplitude_m, baseFreq, roughness, lacunarity)
  //   biomeParams[k*2 + 1] = (shape, warpStrength, warpFreq, textureStyleId)
  // shape enum: 0 fbm, 1 ridged, 2 billowed, 3 dunes, 4 cracks.
  // textureStyleId enum:
  //   0 = none (biome color only),
  //   1 = rock (ridged gray overlay),
  //   2 = sand (dune-like warm overlay),
  //   3 = grass (fbm green overlay),
  //   4 = snow (fbm white sparkle),
  //   5 = ice (cracked cyan overlay),
  //   6 = dirt (brown patches).
  // JS packs from PlanetMap.node.params.biomes[] each frame; defaults
  // mirror what the previous WGSL const BIOME_DETAIL_PARAMS held.
  biomeParams: array<vec4<f32>, 26>,
  // Sprint 9-3 -- projection-only matrix (no view). Paired with a
  // per-draw mv_rtc (view * translate(anchorF64) composed in f64)
  // for vs_planet_cdlod, so the catastrophic (anchor - camera)
  // subtraction happens in f64 on CPU before the f32 GPU upload.
  // Other variants still use uS.viewProj + uD.model with absolute
  // world vertices -- behavior unchanged for them.
  proj: mat4x4<f32>,
};

// Sprint 7.5.4.e -- ACES filmic tonemap. Maps HDR (values > 1) into
// LDR [0,1] smoothly so bright highlights preserve detail instead
// of clipping at the framebuffer write. For values <= 1 the curve
// is nearly identity (slight contrast bump); HDR values get
// compressed nicely. Applied at the end of every lit fragment
// shader so HDRI / ProceduralSky output doesn't blow out.
fn tonemap_aces(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  let num = x * (a * x + b);
  let den = x * (c * x + d) + e;
  return clamp(num / max(den, vec3<f32>(1e-5)), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Sprint 7.5.4.d -- 2D value noise + fbm for clouds. Sampled on a
// virtual cloud plane (at world altitude h) via view ray intersect.
// Wind drifts the noise UV over time (offsets are pre-computed JS).
fn _hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn _noise2d(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = _hash21(i);
  let b = _hash21(i + vec2<f32>(1.0, 0.0));
  let c = _hash21(i + vec2<f32>(0.0, 1.0));
  let d = _hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn _fbm(p: vec2<f32>) -> f32 {
  var v: f32 = 0.0;
  var amp: f32 = 0.5;
  var freq: f32 = 1.0;
  for (var i = 0; i < 5; i = i + 1) {
    v = v + amp * _noise2d(p * freq);
    freq = freq * 2.07;
    amp  = amp  * 0.5;
  }
  return v;
}

// === Phase 8 sprint 8-1: deterministic detail-noise foundation ===
// (spec: docs/PLANET-SCALE-TERRAIN.md §8.2)
//
// 3D value noise + FBM with per-octave deterministic seeds. Same world
// coordinate always yields the same result for the same octave index,
// regardless of LOD level or camera distance, so flying down toward
// the surface is purely ADDITIVE -- low-LOD octaves stay identical
// when more octaves are layered on.
//
// The biomeId parameter on detail_noise is reserved (sprint 8-2 will
// route it through a per-biome parameter LUT). For sprint 8-1 every
// biome uses the same default amplitude / frequency / shape.
//
// LOC budget per the spec: ~200 WGSL for §8.2. This implementation
// is ~80 LOC -- compact because we ride on the existing _hash21
// infrastructure shape.
fn _hash13(p: vec3<f32>) -> f32 {
  // 3D position -> [0, 1] hash. Single-sine hash is fine for value
  // noise; lattice scale of (127.1, 311.7, 74.7) matches the planet-
  // map's existing convention so debugging across the codebase reads
  // consistently. Multiply by a large prime to spread the output.
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}

fn _value_noise_3d(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  // Smoothstep interpolation in each axis for C1 continuity.
  let u = f * f * (3.0 - 2.0 * f);
  let c000 = _hash13(i);
  let c100 = _hash13(i + vec3<f32>(1.0, 0.0, 0.0));
  let c010 = _hash13(i + vec3<f32>(0.0, 1.0, 0.0));
  let c110 = _hash13(i + vec3<f32>(1.0, 1.0, 0.0));
  let c001 = _hash13(i + vec3<f32>(0.0, 0.0, 1.0));
  let c101 = _hash13(i + vec3<f32>(1.0, 0.0, 1.0));
  let c011 = _hash13(i + vec3<f32>(0.0, 1.0, 1.0));
  let c111 = _hash13(i + vec3<f32>(1.0, 1.0, 1.0));
  let x00 = mix(c000, c100, u.x);
  let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x);
  let x11 = mix(c011, c111, u.x);
  let y0  = mix(x00, x10, u.y);
  let y1  = mix(x01, x11, u.y);
  return mix(y0, y1, u.z);  // [0, 1]
}

/* Sprint 10-4 v7: biome-aware procedural surface textures.
 *
 * Each function takes a world-space position and returns an RGB
 * MULTIPLIER (centered around 1.0) that modulates the per-vertex
 * biome color. Combined with the per-fragment 4-octave detail
 * brightness modulation, this gives terrain a distinct surface
 * character per biome -- sand looks like sand, rock looks rocky,
 * etc. -- without needing textured maps or virtual texturing.
 *
 * All four functions are cheap: 2-3 value_noise_3d samples each.
 * Output channels are loosely correlated for natural color
 * variation rather than independent RGB jitter. */
// Sprint 10-4 v9: per-channel modulation amplitudes halved across all
// four texture profiles. v7 was visibly noisy at high mesh density;
// v9 reads as 'surface character' instead of 'pattern'.
fn _surface_tex_grass(p: vec3<f32>) -> vec3<f32> {
  let n_patch  = _value_noise_3d(p * 0.7)  - 0.5;
  let n_blade  = _value_noise_3d(p * 8.0)  - 0.5;
  let mix1 = n_patch * 0.5 + n_blade * 0.4;
  return vec3<f32>(1.0 + mix1 * 0.06,
                   1.0 + mix1 * 0.04,
                   1.0 + mix1 * 0.03);
}

fn _surface_tex_sand(p: vec3<f32>) -> vec3<f32> {
  let stripe = sin(p.x * 1.2) * 0.5 + 0.5;
  let n_dune = _value_noise_3d(p * 0.3)  - 0.5;
  let n_fine = _value_noise_3d(p * 6.0)  - 0.5;
  let mix1 = n_dune * 0.3 + n_fine * 0.4 + (stripe - 0.5) * 0.2;
  return vec3<f32>(1.0 + mix1 * 0.05,
                   1.0 + mix1 * 0.05,
                   1.0 + mix1 * 0.06);
}

fn _surface_tex_rock(p: vec3<f32>) -> vec3<f32> {
  let n_macro = _value_noise_3d(p * 0.5)  - 0.5;
  let n_crack = _value_noise_3d(p * 3.0)  - 0.5;
  let cracks  = smoothstep(0.15, 0.20, abs(n_crack));
  let mix1 = n_macro * 0.4 - (1.0 - cracks) * 0.25;
  return vec3<f32>(1.0 + mix1 * 0.09,
                   1.0 + mix1 * 0.08,
                   1.0 + mix1 * 0.06);
}

fn _surface_tex_snow(p: vec3<f32>) -> vec3<f32> {
  let n_drift = _value_noise_3d(p * 0.4)  - 0.5;
  let n_crust = _value_noise_3d(p * 4.0)  - 0.5;
  let mix1 = n_drift * 0.5 + n_crust * 0.3;
  return vec3<f32>(1.0 + mix1 * 0.025,
                   1.0 + mix1 * 0.025,
                   1.0 + mix1 * 0.03);
}

// Map camera altitude to detail octave count. Spec values, §8.4:
//   > 100km  : 0  (orbital -- base cubemap only)
//    10-100km: 2  (1km features)
//     1-10km : 4  (100m features)
//   100m-1km : 6  (10m features)
//    10-100m: 8  (1m features)
//        <10m: 10 (0.1m pebbles)
// Sprint 8-6 follow-up (closes the 8.4 spec): smooth crossfade
// between bands in log2(altitude) space so descending through a
// boundary doesn't suddenly pop a new octave in. The fractional
// part of the return value is the in-progress next octave's
// amplitude (detail_noise consumes it as a per-octave amp scale).
fn _detail_octaves(altitude_m: f32) -> f32 {
  let logAlt = log2(max(altitude_m, 1.0));
  // §revert-suppression (2026-05-25) -- foot-2 capped this at 6
  // octaves based on a Nyquist argument that was moot for the
  // PlanetMesh path (vs_planet_cdlod doesn't call detail_noise).
  // Real foot-perf bug was horizon-cull (fixed foot-9/10/11/12).
  // Restored to the original §8.4 spec ramp so other shaders that
  // DO call detail_noise (vs_main, vs_planet_detail, etc.) get
  // full feature resolution at foot.
  //   > 100km  : 0  (orbital -- base cubemap only)
  //    10-100km: 2  (1km features)
  //     1-10km : 4  (100m features)
  //   100m-1km : 6  (10m features)
  //    10-100m: 8  (1m features)
  //        <10m: 10 (0.1m pebbles)
  if (logAlt <= 3.32)  { return 10.0; }
  if (logAlt <= 6.64)  { return 10.0 - (logAlt -  3.32) / 3.32 * 2.0; }
  if (logAlt <= 9.97)  { return  8.0 - (logAlt -  6.64) / 3.33 * 2.0; }
  if (logAlt <= 13.29) { return  6.0 - (logAlt -  9.97) / 3.32 * 2.0; }
  if (logAlt <= 16.61) { return  4.0 - (logAlt - 13.29) / 3.32 * 4.0; }
  return 0.0;
}

// === Phase 8 sprint 8-2: per-biome detail params + noise shapes ===
// (spec: docs/PLANET-SCALE-TERRAIN.md §8.3 + §8.6)
//
// 2026-05-22 sprint 8-4: BIOME_DETAIL_PARAMS moved from a WGSL const
// to a runtime uniform (uS.biomeParams[]) so the PlanetMap modal's
// Biomes tab can edit them without WGSL recompiles. Indexing is the
// same: biomeId * 2 + 0 = (amp, freq, roughness, lacunarity),
// biomeId * 2 + 1 = (shape, warpStrength, warpFreq, textureStyleId).

// === Sprint 8-4: built-in procedural biome texture styles ===
// Per-biome textureStyleId selects one of these built-in overlays;
// the overlay is multiplied into the biome's base color so the
// biome's hue still tints through the texture. Wired landTexture
// (PlanetMesh.landTexture) takes priority over the style if both
// are set.
fn _biome_texture_style(worldPos: vec3<f32>, styleId: u32) -> vec3<f32> {
  let scale = 0.001;
  let p = worldPos * scale;
  if (styleId == 1u) {
    // Rock: ridged value-noise gives broken-cliff look. Gray-ish.
    let n = _value_noise_3d(p);
    let r = 1.0 - abs(n * 2.0 - 1.0);
    let v = r * r * 0.7 + 0.3;
    return vec3<f32>(v, v * 0.95, v * 0.88);
  }
  if (styleId == 2u) {
    // Sand: low-freq fbm + warm-yellow tint, dune-direction biased.
    let n = _value_noise_3d(p * 0.5);
    let v = n * 0.5 + 0.6;
    return vec3<f32>(v * 1.08, v * 0.96, v * 0.72);
  }
  if (styleId == 3u) {
    // Grass: medium-freq fbm + green tint, slightly darker patches.
    let n = _value_noise_3d(p * 1.5);
    let v = 0.45 + n * 0.45;
    return vec3<f32>(v * 0.78, v * 1.04, v * 0.62);
  }
  if (styleId == 4u) {
    // Snow: white with high-freq sparkle.
    let n = _value_noise_3d(p * 3.0);
    let v = 0.85 + n * 0.15;
    return vec3<f32>(v, v, v * 1.02);
  }
  if (styleId == 5u) {
    // Ice: cracked (inverted ridged) cyan; the cracks read as
    // darker veins through a lighter base.
    let n = _value_noise_3d(p);
    let r = 1.0 - abs(n * 2.0 - 1.0);
    let v = 0.55 + (1.0 - r * r) * 0.4;
    return vec3<f32>(v * 0.92, v * 1.02, v * 1.08);
  }
  if (styleId == 6u) {
    // Dirt: low-freq blotches in brown.
    let n = _value_noise_3d(p * 0.8);
    let v = 0.45 + n * 0.4;
    return vec3<f32>(v * 0.95, v * 0.78, v * 0.58);
  }
  // 0 (or unknown): no overlay, identity multiplier.
  return vec3<f32>(1.0);
}

// Apply a per-octave noise shape to a signed [-1, 1] noise sample.
fn _noise_apply_shape(n: f32, shape: u32) -> f32 {
  if (shape == 1u) {
    // Ridged: (1 - |n|)^2. Sharp ridges, [0, 1] range.
    let r = 1.0 - abs(n);
    return r * r;
  }
  if (shape == 2u) {
    // Billowed: |n|. Round bumps, [0, 1] range.
    return abs(n);
  }
  if (shape == 3u) {
    // Dunes: same as ridged for now; the anisotropic domain warp
    // (sprint 8-3 polish) will operate on worldPos before fbm.
    let r = 1.0 - abs(n);
    return r * r;
  }
  if (shape == 4u) {
    // Cracks: inverted ridged for negative-going crevasses, [-1, 0].
    let r = 1.0 - abs(n);
    return -r * r;
  }
  // shape == 0 fbm (default) -- pass through.
  return n;
}

// detail_noise(worldPos, biomeId, maxOctaveF): deterministic biome-
// styled fBm. Reads per-biome amplitude / freq / shape from
// uS.biomeParams[] uniform (sprint 8-4) -- editable via the
// PlanetMap modal's Biomes tab.
//
// 8.4 crossfade: maxOctaveF is a FLOAT. The integer part is the
// number of fully-summed octaves; the fractional part scales the
// final partial octave. _detail_octaves returns this continuously
// so descending through an altitude band smoothly ramps in the
// new octave instead of popping it.
fn detail_noise(worldPos: vec3<f32>, biomeId: u32, maxOctaveF: f32) -> f32 {
  let bId = min(biomeId, 12u);
  let row0 = uS.biomeParams[bId * 2u + 0u];
  let row1 = uS.biomeParams[bId * 2u + 1u];
  let amplitude  = row0.x;
  let baseFreq   = row0.y;
  let roughness  = row0.z;
  let lacunarity = row0.w;
  let shape: u32 = u32(row1.x + 0.5);
  let warpStrength = row1.y;
  let warpFreq     = row1.z;

  if (amplitude <= 0.0 || maxOctaveF <= 0.0) { return 0.0; }

  // 8.6 follow-up: dunes shape gets an anisotropic domain warp so
  // crests align like real wind-built dunes. Other shapes pass
  // worldPos through unchanged.
  var samplePos = worldPos;
  if (shape == 3u && warpStrength > 0.0) {
    let radial = samplePos - uS.envPlanet.xyz;
    let radialLen = length(radial);
    let radialDir = select(vec3<f32>(0.0, 1.0, 0.0), radial / max(radialLen, 1.0), radialLen > 0.5);
    var crestRef = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(radialDir, crestRef)) > 0.99) {
      crestRef = vec3<f32>(1.0, 0.0, 0.0);
    }
    let crest = normalize(crestRef - radialDir * dot(crestRef, radialDir));
    let warpN = _value_noise_3d(samplePos * max(warpFreq, 1e-7)) * 2.0 - 1.0;
    // 50m of warp at warpStrength=1 is enough to give dunes a
    // smooth crest curve at orbital scale; scaled by per-biome
    // strength so the user can dial it.
    samplePos = samplePos + crest * (warpN * warpStrength * 50.0);
  }

  let maxFullOct = u32(floor(maxOctaveF));
  let lastFrac   = maxOctaveF - f32(maxFullOct);
  let totalOctaves = maxFullOct + select(0u, 1u, lastFrac > 0.001);

  var sum: f32  = 0.0;
  var freq: f32 = baseFreq;
  var amp: f32  = 1.0;
  var ampSum: f32 = 0.0;
  for (var k: u32 = 0u; k < totalOctaves; k = k + 1u) {
    // Per-octave offset = deterministic seed depending ONLY on k.
    // LOD-stable: octave k contributes the same value at the same
    // worldPos regardless of maxOctaveF.
    let offset = vec3<f32>(
      f32(k) * 13.37,
      f32(k) * 7.91,
      f32(k) * 23.45
    );
    let p = samplePos * freq + offset;
    let nRaw = _value_noise_3d(p) * 2.0 - 1.0;  // [-1, 1]
    let nShaped = _noise_apply_shape(nRaw, shape);
    // 8.4 crossfade: scale the last partial octave by lastFrac so
    // its contribution ramps 0->1 across the band boundary.
    var ampThis = amp;
    if (k == maxFullOct && lastFrac > 0.001 && lastFrac < 0.999) {
      ampThis = amp * lastFrac;
    }
    sum    = sum    + ampThis * nShaped;
    ampSum = ampSum + ampThis;
    freq = freq * lacunarity;
    amp  = amp  * roughness;
  }
  if (ampSum < 1e-6) { return 0.0; }
  // Final amplitude scaling via biome's amplitude. The /ampSum
  // normalizes the fbm sum to roughly the shape's natural range, then
  // amplitude * 0.01 converts meters-of-feature to the [0..1] color-
  // modulation scale used by the brightness visualization in
  // fs_unlit_vc. (Vertex displacement uses detail_noise_height which
  // strips the 0.01 to recover meters.)
  return (sum / ampSum) * amplitude * 0.01;
}

// Phase 8 sprint 8-6: meters-scaled detail noise for vertex displacement.
// Strips the 0.01 color-modulation scale to recover real meters.
fn detail_noise_height(worldPos: vec3<f32>, biomeId: u32, maxOctaveF: f32) -> f32 {
  return detail_noise(worldPos, biomeId, maxOctaveF) * 100.0;
}

// Sample clouds for a given world view direction. Returns vec4
// where rgb = lit cloud color and a = coverage alpha (0 = no
// cloud, 1 = fully opaque). Only meaningful for upward view dirs
// (dir.y > small threshold); below horizon -> 0.
fn sample_clouds(dir: vec3<f32>) -> vec4<f32> {
  let coverage = uS.envCloudParams.x;
  let density  = uS.envCloudParams.y;
  if (coverage <= 0.0 || density <= 0.0) {
    return vec4<f32>(0.0);
  }
  // Below horizon -> no clouds. Smooth fade-in near the horizon
  // band so clouds don't pop at the edge.
  let yMask = smoothstep(0.0, 0.12, dir.y);
  if (yMask <= 0.0) {
    return vec4<f32>(0.0);
  }
  // §5.5.h-13 -- fixed-distance cloud "shell" instead of an infinite
  // flat cloud plane. The flat plane had wildly non-uniform parallax
  // response to rotation: near-zenith clouds at t = H/dir.y were
  // close (a few km) while horizon clouds were at hundreds of km, so
  // panning the camera moved them at very different rates -- exactly
  // the symptom that read as a parallax issue when looking left or
  // right or up. A constant-distance shell (pos = dir * R) keeps
  // angular size and rotation response uniform across the dome.
  //
  // R = 8000m -- typical distant cloud feel. Clouds appear at the
  // same effective distance whether you look up or toward the
  // horizon. World-anchoring still works: the scene encoder pre-
  // subtracts camera.xz from the wind offset so noise tracks world
  // XZ as the camera translates.
  let R = 8000.0;
  let pos = dir * R;
  let wind = uS.envCloudParams.zw;
  let xz = (pos.xz - wind) * 0.0006;
  // Fractal density via 5-octave fbm; coverage threshold gates it
  // (real cloud fronts have sharp edges, fbm is too smooth alone).
  let raw = _fbm(xz);
  let alpha = smoothstep(coverage * 0.85, coverage * 0.85 + 0.22, raw) * density * yMask;
  // Cloud color: lit white-warm by sun (cos_theta with sunDir gives
  // a coarse forward-scatter brightening), darkened by self-shadow
  // approximation (1 - alpha gives a fake "thicker = darker bottom").
  let cos_theta = clamp(dot(normalize(dir), uS.envSun.xyz), -1.0, 1.0);
  let sunUp     = max(uS.envSun.y, 0.0);
  let scatter   = pow(max(cos_theta * 0.5 + 0.5, 0.0), 2.0);
  // Color picks a warm tint near sunset, cool at midday.
  let sun_elev = clamp(uS.envSun.y, -1.0, 1.0);
  let lit = mix(vec3<f32>(1.10, 0.85, 0.65),
                vec3<f32>(1.05, 1.02, 0.98),
                smoothstep(0.0, 0.35, sun_elev));
  let shadow = vec3<f32>(0.35, 0.40, 0.50);
  // Day intensity: clouds are dim at night, bright by day.
  let day = smoothstep(-0.10, 0.20, sun_elev);
  let cloudCol = mix(shadow, lit, scatter * uS.envSun.w) * day;
  return vec4<f32>(cloudCol, clamp(alpha, 0.0, 0.95));
}

// Sprint 7.5.4.c-sky -- background sky pass. Fullscreen triangle
// at clip-space z=1 (far plane); depth-test "less-equal" lets it
// pass only where no mesh has written a smaller depth. Result:
// the sky fills uncovered background pixels with sample_env(rayDir).
//
// Without this pass the Scene's clearR/G/B shows through behind
// meshes, even when an env is wired -- meaning glossy reflections
// of the sky showed up but the actual sky behind didn't. With it,
// the env source becomes a true skybox.

struct SkyVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldDir: vec3<f32>,
};

@vertex
fn vs_sky(@builtin(vertex_index) vid: u32) -> SkyVsOut {
  // Oversized fullscreen triangle: (-1,-3), (3,1), (-1,1) covers
  // the viewport with vertices outside the screen, avoiding the
  // hypotenuse-of-two-tris seam.
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>( 3.0,  1.0),
    vec2<f32>(-1.0,  1.0)
  );
  let p = positions[vid];
  var out: SkyVsOut;
  // §planet-spec Phase 1 -- reverse-Z. Far plane in WebGPU clip
  // space is now ndc_z=0 (was 1). With depth-test "greater-equal"
  // + depth-clear=0, this fragment passes wherever no mesh wrote
  // anything closer to the near plane (ndc_z=1).
  out.pos = vec4<f32>(p.x, p.y, 0.0, 1.0);
  // Reconstruct world-space ray dir from screen coords + camera
  // basis. Perspective: dir = forward + p.x * tanHFov*aspect * right
  //                                    + p.y * tanHFov        * up
  // Ortho: dir = forward (constant; sky becomes a flat color, fine
  // for the rare ortho-camera case).
  let isOrtho = uS.camForward.w > 0.5;
  let pdir = uS.camForward.xyz
           + p.x * uS.camRight.w * uS.camRight.xyz
           + p.y * uS.camUp.w    * uS.camUp.xyz;
  // 2026-05-21 -- DO NOT normalize here. The fragment shader normalizes.
  // Reason: linear interpolation of NORMALIZED vertex vectors is not the
  // same as normalize() of the linearly-interpolated UN-normalized
  // vectors. For this oversized fullscreen triangle (vertices at
  // (-1,-3), (3,1), (-1,1)), the un-normalized pdir at each vertex is
  //   v = camForward + p.x * tanHFovAspect * camRight + p.y * tanHFov * camUp
  // which IS linear in (p.x, p.y). Hardware interpolation reconstructs
  // the correct (un-normalized) ray at every screen pixel. If we
  // normalize first, the magnitudes diverge between vertices (the
  // off-screen vertex at (-1,-3) has much larger |v| than the on-screen
  // ones), and the interpolated unit vectors no longer point along the
  // true view ray. Symptoms: stars + Milky Way visibly stretched off-
  // axis; atmosphere shell intersections happen for the WRONG ray
  // direction, so the rendered halo appears as a separate sphere
  // offset from the planet body.
  out.worldDir = select(pdir, uS.camForward.xyz, isOrtho);
  return out;
}

// Sprint 7.5.4.e -- distance fog blend. Applied at end of lit
// fragment shaders. Beer-Lambert exp(-density * (dist - start))
// with optional height falloff so ground fog doesn't tint distant
// mountaintops. Defined here (after sample_env) so the
// autoPull-from-env path can call sample_env() in the camera-
// forward direction for a fog color that matches the sky horizon.
fn apply_fog(color: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  let density = uS.envFogParams.x;
  if (density <= 0.0) { return color; }
  let start = uS.envFogParams.y;
  let hf    = uS.envFogParams.z;
  let dist  = length(uS.eye.xyz - worldPos);
  let beyond = max(dist - start, 0.0);
  var heightFactor: f32 = 1.0;
  if (hf > 0.0) {
    heightFactor = smoothstep(hf * 2.0, 0.0, worldPos.y);
  }
  let factor = 1.0 - exp(-density * beyond * heightFactor);
  var fogCol: vec3<f32>;
  if (uS.envFogParams.w > 0.5) {
    // 7.5.4.e-fix2 -- project camera-forward to the horizon (y=0)
    // before sampling env. Pre-fix used raw camForward.xyz: when
    // the camera tilts down at all (any look-down framing) it
    // picked up the env's GROUND color (warm dim brown), which is
    // nearly identical to most floor materials -> fog tint read as
    // invisible against the floor. Real atmospheric perspective
    // tints distant geometry toward the HORIZON color regardless
    // of camera tilt; forcing y=0 + renormalize gives that
    // consistently. The +1e-4 nudges away from the degenerate
    // straight-up camera (cross-of-y-axis -> 0 vector).
    let camFwd = uS.camForward.xyz;
    let horizDir = normalize(vec3<f32>(camFwd.x, 0.0, camFwd.z) + vec3<f32>(1e-4, 0.0, 0.0));
    fogCol = sample_env(horizDir);
  } else {
    fogCol = uS.envFogColor.rgb;
  }
  return mix(color, fogCol, clamp(factor, 0.0, 1.0));
}

@fragment
fn fs_sky(in: SkyVsOut) -> @location(0) vec4<f32> {
  // Sprint 7.5.4.c-polish -- sky background pass includes the
  // features (disk / moon / stars / Milky Way) on top of the
  // smooth scattering. sample_env is smooth-only (for IBL safety);
  // this dispatch path is the only place features show up so that
  // a high-frequency star can't end up reflected through a smooth
  // surface normal and alias.
  let dir = normalize(in.worldDir);
  let mode = u32(uS.envParams.x);
  var col: vec3<f32>;
  if (mode == 2u) {
    // 2026-05-21 Sprint 7.6.a-atm v4 -- camera-altitude-gated
    // scattering. sample_planet_atmosphere now returns 0 when the
    // camera is above the atmosphere shell, so:
    //   * From the SURFACE: full atmospheric scattering -> blue sky.
    //   * From ORBIT: pure space -- limb glow visible only as
    //     aerial_perspective on the planet body itself, no
    //     disconnected halo around the silhouette.
    // The transition has a 10%-of-thickness fade band so crossing
    // the Karman line doesn't pop visually.
    if (uS.envPlanet.w > 0.0) {
      // C.4 -- sky-view LUT replaces per-pixel atmosphere integration.
      // One texture sample instead of 16x8 = 128 inner evaluations.
      // Features (sun disk / moon / stars / Milky Way) stay per-pixel
      // because they're point/line features that would alias through
      // the 192x108 LUT resolution.
      col = sample_skyview_lut(dir)
          + sample_procedural_sky_features(dir);
    } else {
      col = sample_procedural_sky(dir);
    }
  } else {
    col = sample_env(dir);
  }
  // Sprint 7.5.4.d -- composite clouds over the sky background.
  // ProceduralSky resolver packs cloud coverage/density/wind; for
  // other env sources cloud params stay 0 (sample_clouds returns
  // zero-alpha, no visible change).
  let cloud = sample_clouds(dir);
  col = mix(col, cloud.rgb, cloud.a);
  // 7.5.4.e -- ACES tonemap so HDR-range values (sun disk, bright
  // HDRI pixels) don't clip-blow-out at the framebuffer write.
  return vec4<f32>(tonemap_aces(col), 1.0);
}

// Sprint 7.5.4.c-physics -- atmospheric scattering with proper
// Rayleigh + Mie phase functions and Beer-Lambert extinction along
// the sun ray. NOT integrated multi-scattering (that needs precomp
// tables, e.g. Bruneton); single-scattering with the right shape:
//   * sun's color reddens through atmospheric path (extinction)
//   * sky's zenith blue comes from Rayleigh in-scatter
//   * Mie halo around sun + brownish horizon haze from aerosols
//
// Sub-divided into:
//   sample_procedural_sky_smooth(dir)   - smooth gradient + halo
//     only (no point-features). For IBL ambient on PBR surfaces;
//     the high-freq star/disk features alias badly through smooth
//     surface normals so they're factored out.
//   sample_procedural_sky_features(dir) - sun disk + moon + stars
//     + Milky Way. Background-only.
//   sample_procedural_sky(dir)          - = smooth + features.

// Wavelength-dependent Rayleigh extinction (~1/λ⁴; blue scatters
// most). Ratios tuned so one full atmospheric path produces an
// observed sunset-red residual on the sun. Mie is gray, scaled
// by turbidity (aerosol load).
const SKY_BETA_R = vec3<f32>(0.030, 0.070, 0.170);
const SKY_PATH_SCALE = 4.0;

fn _sky_optical_depth(cos_zenith: f32) -> f32 {
  // Chapman-style approximation: 1 at zenith, large at horizon.
  // +0.05 floor prevents the 1/cos singularity at horizon.
  return 1.0 / max(cos_zenith + 0.05, 0.08);
}

fn _sky_sun_extinction(sunCosZenith: f32, turbidity: f32) -> vec3<f32> {
  let depth = _sky_optical_depth(sunCosZenith);
  let betaM = vec3<f32>(0.030) * turbidity;
  return exp(-(SKY_BETA_R + betaM) * depth * SKY_PATH_SCALE);
}

fn sample_procedural_sky_smooth(dir: vec3<f32>) -> vec3<f32> {
  let sunDir    = uS.envSun.xyz;
  let sunVis    = uS.envSun.w;
  let turbidity = uS.envParams.z;
  let mieG      = uS.envParams.w;
  let intensity = uS.envParams.y;

  let view_y   = clamp(dir.y, -1.0, 1.0);
  let sun_elev = clamp(sunDir.y, -1.0, 1.0);
  let day      = smoothstep(-0.08, 0.18, sun_elev);

  // === DAY: Rayleigh + Mie single-scattering ===
  let betaR = SKY_BETA_R;
  let betaM = vec3<f32>(0.030) * turbidity;
  let cos_theta = clamp(dot(dir, sunDir), -1.0, 1.0);
  let cos2 = cos_theta * cos_theta;

  // Rayleigh phase: 3/(16π) × (1 + cos²θ). Symmetric, adds to both
  // forward and backward view directions.
  let phaseR = 0.0596 * (1.0 + cos2);
  // Mie phase: Cornette-Shanks improved HG. Strongly forward-
  // scattering -> bright halo around sun + brown horizon haze.
  let g  = clamp(mieG, 0.0, 0.95);
  let g2 = g * g;
  let phaseM_denom = pow(max(1.0 + g2 - 2.0 * g * cos_theta, 1e-4), 1.5);
  let phaseM = 0.119 * (1.0 - g2) * (1.0 + cos2) / ((2.0 + g2) * phaseM_denom);

  // Optical depths along view + sun rays.
  let sunCosZenith  = max(sun_elev, -0.05);
  let viewCosZenith = max(view_y, 0.0);
  let sunDepth  = _sky_optical_depth(sunCosZenith);
  let viewDepth = _sky_optical_depth(viewCosZenith);

  // Beer-Lambert sun extinction: ratio of sunlight surviving its
  // trip from atmosphere edge to the observer. At zenith ≈ neutral
  // white; at horizon, blue extinguishes first, leaving deep red.
  let extinction = exp(-(betaR + betaM) * sunDepth * SKY_PATH_SCALE);
  let sunRadiance = vec3<f32>(1.5, 1.4, 1.3) * extinction;

  // Single in-scattering integral approximation. Real integral is
  // ∫ phase × Lsun × T(view) dx along view ray; here we collapse
  // the integral to phase × sunRadiance × (1 - exp(-tau_view))
  // which preserves the day/dusk/zenith color shapes without the
  // precomp table cost.
  //
  // 7.5.4.c-polish3 -- bumped main multiplier 14 -> 80. The earlier
  // value was tuned against the rays-coefficients-in-isolation but
  // produced a sky that read as "nearly black at noon." 80 lands
  // noon-zenith roughly at vec3(0.33, 0.49, 0.74) -- close to the
  // pre-physics hand-tuned (0.28, 0.50, 0.92).
  let viewExt = exp(-(betaR + betaM) * viewDepth * SKY_PATH_SCALE * 0.6);
  let inScatterR = sunRadiance * betaR * phaseR;
  let inScatterM = sunRadiance * betaM * phaseM;
  var sky_day = (inScatterR + inScatterM) * (1.0 - viewExt) * 80.0;

  // 7.5.4.c-polish3 -- multi-scattering ambient. Single-scattering
  // gets the colors right but is too dim in directions away from
  // the sun (real atmospheres get filled in by light bouncing 2+
  // times among air molecules). Add a sun-elevation-gated blue
  // ambient that scales with viewExt -- more fill at horizon (more
  // air = more bounces), less at zenith. Without this the half of
  // the sky opposite the sun reads as nearly black.
  let multiScatter = vec3<f32>(0.18, 0.42, 0.92) *
                     smoothstep(-0.05, 0.35, sun_elev) *
                     (1.0 - viewExt);
  sky_day = sky_day + multiScatter * 1.4;

  // === NIGHT ===
  let zen_night = vec3<f32>(0.015, 0.022, 0.060);
  let hor_night = vec3<f32>(0.045, 0.050, 0.095);
  let sky_night = mix(hor_night, zen_night, smoothstep(0.0, 1.0, max(view_y, 0.0)));

  // §5.5.h-11 -- below-horizon "ground" used to be a hard-coded warm-
  // brown (vec3(0.18, 0.13, 0.10)) which read as a brown earth band at
  // the horizon when the sky was exposed past the edge of a finite
  // water/terrain plane. Continue the sky color instead, just darker.
  // Real terrain/water overdraws this where it covers; where it's
  // exposed (water plane edges, gaps), it now reads as a darker
  // continuation of the atmospheric horizon rather than fake earth.
  var col = mix(sky_night, sky_day, day);
  if (view_y < 0.0) {
    let fade = clamp(1.0 + view_y * 1.5, 0.4, 1.0);
    col = col * fade;
  }

  // Sun-halo Mie glow (smooth; the disk itself lives in _features).
  let halo = phaseM * sunVis * 1.0;
  col = col + halo * sunRadiance;

  // §5.5.h-26 -- atmospheric altitude fade. Real atmosphere is mostly
  // gone by ~80km. Below 20km camera Y we're in full sky; ramps to
  // 0 (space) over the 20-80km band. Applied to the smooth path only
  // so sun / stars / Milky Way (sample_procedural_sky_features) stay
  // visible from above the atmosphere. Used by fs_sky, fs_water,
  // fs_horizon, fs_clouds, and IBL sampling so everything that reads
  // the sky stays consistent as the camera climbs out of atmosphere.
  let camY = uS.eye.y;
  let atmFade = clamp(1.0 - (camY - 20000.0) / 60000.0, 0.0, 1.0);
  return col * intensity * atmFade;
}

// Sprint 7.6.a-atm -- TIER B planet-aware single-scattering
// atmosphere (Nishita 1993 / Hillaire 2020 simplified to single
// bounce). Replaces the flat-ground sample_procedural_sky_smooth
// whenever uS.envPlanet.w > 0 (a planet is wired in the scene).
//
// The shader integrates Rayleigh + Mie in-scattering along the
// view ray segment that lies INSIDE the atmosphere shell:
//   1. Compute ray ∩ atmosphere-top sphere (entry/exit).
//   2. If ray ∩ planet surface comes before exit, clip there
//      (cam->ground segment is what scatters).
//   3. Sample N points along the segment. At each, compute the
//      atmosphere density (exp altitude decay), accumulate view-
//      ray optical depth, then trace a sun ray from the sample
//      point and accumulate its optical depth. Combine to find
//      this sample's attenuated in-scatter contribution.
//   4. Apply Rayleigh + Mie phase functions, sum, return.
//
// This handles all camera positions:
//   - Surface: blue sky, sunset red, sun extinction
//   - Atmosphere flight: thinning blue, brighter at altitude
//   - Orbit: black space + bright limb glow around planet silhouette
//
// Coefficients are Earth-calibrated (5.8e-6 / 13.5e-6 / 33.1e-6
// per meter for RGB Rayleigh, 21e-6 for Mie) and rescaled by
// EARTH_R / planetR so the OPTICAL DEPTH per unit world distance
// looks Earth-like regardless of our world-unit scale.
const ATM_EARTH_R: f32 = 6371000.0;

// Sprint 7.6.b-atm Tier-C.0 -- atmosphere integral result. The
// previous return-just-the-in-scatter approach (vec3) lacked the
// view-path TRANSMITTANCE which is what makes the planet body fade
// into atmosphere color at the limb. With transmittance included
// the caller can do:
//   final_color = surface_color * transmittance + in_scatter
// at the silhouette this becomes ~0 * ~0 + bright_atm = bright_atm,
// matching the sky-pass scattering and closing the visible gap.
struct AtmResult {
  inScatter:    vec3<f32>,
  transmittance: vec3<f32>
};

// Ray-ELLIPSOID intersection (oblate spheroid with Y-axis scaled by
// polRatio). The planet renders with Y compressed by polRatio (the
// Earth's WGS84 ratio = 0.9966); to align the atmosphere shell with
// the actual rendered planet shape, intersect against the matching
// ellipsoid instead of a sphere.
//
// Trick: scale the ray's Y by 1/polRatio. In that scaled space the
// ellipsoid is a unit sphere of radius r, and t parameters transfer
// 1:1 with the unscaled ray (because we scale both origin and dir
// by the same factor, the t parameter still indexes the original
// world-space position along the ray). Standard quadratic from
// |O + t*D|² = r², but using the general form because the scaled
// direction is no longer unit-length.
fn _atm_ray_ellipsoid(origin: vec3<f32>, dir: vec3<f32>, center: vec3<f32>, r: f32, polRatio: f32) -> vec2<f32> {
  let invPol = 1.0 / max(polRatio, 1e-6);
  let scale  = vec3<f32>(1.0, invPol, 1.0);
  let oc = (origin - center) * scale;
  let dd = dir * scale;
  let A = dot(dd, dd);
  let B = dot(oc, dd);
  let C = dot(oc, oc) - r * r;
  let h = B * B - A * C;
  if (h < 0.0) { return vec2<f32>(0.0, -1.0); }
  let s = sqrt(h);
  let invA = 1.0 / max(A, 1e-12);
  return vec2<f32>((-B - s) * invA, (-B + s) * invA);
}

// Backward-compat sphere intersection. Equivalent to ellipsoid with
// polRatio=1 -- some non-atmospheric callers may still use this.
fn _atm_ray_sphere(origin: vec3<f32>, dir: vec3<f32>, center: vec3<f32>, r: f32) -> vec2<f32> {
  let oc = origin - center;
  let b = dot(oc, dir);
  let c = dot(oc, oc) - r * r;
  let h = b * b - c;
  if (h < 0.0) { return vec2<f32>(0.0, -1.0); }
  let s = sqrt(h);
  return vec2<f32>(-b - s, -b + s);
}

// Internal core: integrate Rayleigh+Mie in-scatter along [rayOrigin,
// rayOrigin + rayDir*t1] segment, where t1 is automatically computed
// as either atmosphere-shell exit OR ground intersection OR maxDist
// (whichever is closest). maxDist < 0 means "no fragment limit"
// (the sky-pass usage); maxDist >= 0 clips to that distance (the
// aerial-perspective usage, where the fragment's surface stops the
// view ray short of the planet's far atmosphere shell).
fn _atm_integrate(rayOrigin: vec3<f32>, rayDir: vec3<f32>, maxDist: f32) -> AtmResult {
  let sunDir   = uS.envSun.xyz;
  let sunVis   = uS.envSun.w;
  let planetC  = uS.envPlanet.xyz;
  let planetR  = uS.envPlanet.w;
  let atmR     = uS.envPlanetAtm.x;
  let scaleHR  = uS.envPlanetAtm.y;
  let scaleHM  = uS.envPlanetAtm.z;
  let sunI     = uS.envPlanetAtm.w;
  let turbidity = max(uS.envParams.z, 0.5);

  if (planetR <= 0.0 || atmR <= planetR) {
    return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0));
  }

  // Tier C.0+ -- pull polRatio so atmosphere and planet match shape.
  let polRatio = max(0.5, min(2.0, uS.envPlanetGeom.x));
  let invPol = 1.0 / polRatio;

  let unitScale = ATM_EARTH_R / planetR;
  let betaR = vec3<f32>(5.8e-6, 13.5e-6, 33.1e-6) * unitScale;
  let betaM = vec3<f32>(21.0e-6) * unitScale * turbidity;

  let atmHit = _atm_ray_ellipsoid(rayOrigin, rayDir, planetC, atmR, polRatio);
  if (atmHit.y < 0.0) { return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0)); }
  var t0 = max(atmHit.x, 0.0);
  var t1 = atmHit.y;

  // Clip to ground if the ray would otherwise pass through the planet.
  let groundHit = _atm_ray_ellipsoid(rayOrigin, rayDir, planetC, planetR, polRatio);
  if (groundHit.x > 0.0 && groundHit.x < t1) { t1 = groundHit.x; }
  // Clip to fragment (aerial-perspective mode): when a surface is in
  // front of the atmosphere far side, stop the integral at the surface.
  if (maxDist >= 0.0 && maxDist < t1) { t1 = maxDist; }

  let segLen = t1 - t0;
  if (segLen <= 0.0) { return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0)); }

  let NUM_SAMPLES = 16;
  let dt = segLen / 16.0;
  var inScatterR = vec3<f32>(0.0);
  var inScatterM = vec3<f32>(0.0);
  var opticalDepthR = 0.0;
  var opticalDepthM = 0.0;
  // Sprint 7.6.b-atm Tier-C.3 -- accumulator for multi-scattering
  // contribution. At each view-ray sample we add the LUT-precomputed
  // isotropic-bounce energy weighted by (a) local Rayleigh+Mie
  // density (so high altitudes contribute less) and (b) the camera-
  // to-sample transmittance (so multi-scattering on the far side of
  // a thick column gets attenuated correctly).
  var multiScatterAccum = vec3<f32>(0.0);
  // atmThickness needed by sample_multiscatter_lut for V-axis remap.
  let atmThickness = atmR - planetR;

  // Altitude above ellipsoid surface: scale Y by 1/polRatio to bring
  // the planet into a unit-sphere shape, compute (|p_scaled| - r), then
  // approximate altitude in world units. Exact altitude-above-ellipsoid
  // is more complex (closest-point calculation), but for atmospheric
  // density purposes this approximation is accurate enough -- the
  // density curve is exponential so small errors in altitude have
  // tiny effect.
  let scaleAxes = vec3<f32>(1.0, invPol, 1.0);

  for (var i: i32 = 0; i < NUM_SAMPLES; i = i + 1) {
    let t = t0 + (f32(i) + 0.5) * dt;
    let p = rayOrigin + rayDir * t;
    let h = max(0.0, length((p - planetC) * scaleAxes) - planetR);

    let densityR = exp(-h / scaleHR) * dt;
    let densityM = exp(-h / scaleHM) * dt;
    opticalDepthR = opticalDepthR + densityR;
    opticalDepthM = opticalDepthM + densityM;

    // Sprint 7.6.b-atm Tier-C.3 -- multi-scattering contribution at
    // this sample. The LUT was baked for a sphere-centered geometry,
    // so we compute the sample's "up" direction (radial) and the
    // sun's projection onto it. atmThickness here matches the LUT's
    // V-axis range. The result is energy/m of integrated multi-bounce
    // light that we weight by local density × view-path attenuation
    // to get a per-sample contribution to the eye's color.
    let upDir = normalize((p - planetC) * scaleAxes);
    let cosSZ = dot(upDir, sunDir);
    let msLut = sample_multiscatter_lut(cosSZ, h, atmThickness);
    // View-path transmittance from camera to THIS sample (Beer-Lambert
    // along the segment we've already integrated).
    let viewExtSoFar = betaR * opticalDepthR + betaM * 1.1 * opticalDepthM;
    let viewTransSoFar = exp(-viewExtSoFar);
    let scatterCoeff = betaR * densityR + betaM * densityM;
    multiScatterAccum = multiScatterAccum + msLut * scatterCoeff * viewTransSoFar;

    // Sun-ray segment from p outward (uS.envSun is direction TO sun).
    let sunHit = _atm_ray_ellipsoid(p, sunDir, planetC, atmR, polRatio);
    if (sunHit.y < 0.0) { continue; }
    // Skip samples where the sun is blocked by the planet itself.
    let sunGround = _atm_ray_ellipsoid(p, sunDir, planetC, planetR, polRatio);
    if (sunGround.x > 0.0 && sunGround.x < sunHit.y) { continue; }

    let sunSegLen = sunHit.y;
    let SUN_SAMPLES = 8;
    let dtSun = sunSegLen / 8.0;
    var sunDepthR = 0.0;
    var sunDepthM = 0.0;
    for (var j: i32 = 0; j < SUN_SAMPLES; j = j + 1) {
      let ts = (f32(j) + 0.5) * dtSun;
      let ps = p + sunDir * ts;
      let hs = max(0.0, length((ps - planetC) * scaleAxes) - planetR);
      sunDepthR = sunDepthR + exp(-hs / scaleHR) * dtSun;
      sunDepthM = sunDepthM + exp(-hs / scaleHM) * dtSun;
    }

    let totalExt = betaR * (opticalDepthR + sunDepthR)
                 + betaM * 1.1 * (opticalDepthM + sunDepthM);
    let attenuation = exp(-totalExt);

    inScatterR = inScatterR + densityR * attenuation;
    inScatterM = inScatterM + densityM * attenuation;
  }

  // Phase functions: Rayleigh (3/16π × (1+cos²)) + Mie (Cornette-Shanks).
  let cosTheta = dot(rayDir, sunDir);
  let cos2 = cosTheta * cosTheta;
  let phaseR = 0.0596831 * (1.0 + cos2);
  let g = clamp(uS.envParams.w, 0.0, 0.95);
  let g2 = g * g;
  let mDenom = pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
  let phaseM = 0.1193662 * (1.0 - g2) * (1.0 + cos2) / ((2.0 + g2) * mDenom);

  // Sprint 7.6.b-atm Tier-C.3 -- combine single + multi-scattering.
  // Single-scatter uses the proper phase functions. Multi-scatter is
  // already isotropic (1/4π absorbed into the LUT) so we add it as-is,
  // modulated by sunI * sunVis so a hidden sun produces no extra
  // multi-bounce light.
  //
  // 2026-05-21 follow-up: with multi-scatter at unit weight the
  // aerial-perspective contribution dominates the planet's surface
  // (terrain reads as a uniform blue haze, can't see the land).
  // Hillaire-typical multi-bounce contribution is 10-30% of single-
  // bounce; we scale by 0.15 to land squarely in that range. Can
  // tune up later once the unit-scaling pipeline is validated, but
  // this restores surface readability immediately.
  let MS_SCALE: f32 = 0.15;
  let result = sunI * sunVis * (betaR * phaseR * inScatterR
                              + betaM * phaseM * inScatterM
                              + multiScatterAccum * MS_SCALE);
  // Sprint 7.6.b-atm Tier-C.0 -- view-path transmittance (Beer-Lambert).
  // Per-channel since Rayleigh scattering is wavelength-dependent;
  // BLUE attenuates faster than RED so distant ground reads warm
  // through atmosphere (the "sunset-tint on the far hills" effect).
  let viewExt = betaR * opticalDepthR + betaM * 1.1 * opticalDepthM;
  let transmittance = exp(-viewExt);
  return AtmResult(max(result, vec3<f32>(0.0)), transmittance);
}

// PUBLIC: sky-pass usage. View ray runs to the atmosphere far side
// (or ground intersection). Returns the in-scatter integrated along
// the full view path -- this is the SKY COLOR for that direction.
//
// 2026-05-21 Sprint 7.6.b -- ungated. The earlier v4 altitude gate
// was a band-aid for the missing transmittance term on the planet
// body. Now that Tier C.0 applies transmittance correctly, the
// planet body's silhouette fades to atmospheric color naturally
// and the sky-pass scattering shows the atmosphere as a VISIBLE
// BAND ABOVE the planet body -- exactly what real orbital photos
// show (Earth's thin blue limb extending above the solid surface).
// The two compositions meet seamlessly at the silhouette because
// they integrate the same atmosphere along adjacent rays.
fn sample_planet_atmosphere(rayOrigin: vec3<f32>, rayDir: vec3<f32>) -> vec3<f32> {
  let planetR = uS.envPlanet.w;
  let atmR    = uS.envPlanetAtm.x;
  if (planetR <= 0.0 || atmR <= planetR) {
    return vec3<f32>(0.0);
  }
  let r = _atm_integrate(rayOrigin, rayDir, -1.0);
  return r.inScatter;
}

// PUBLIC: AERIAL PERSPECTIVE for a lit fragment. Returns BOTH the
// in-scatter (additive on top of surface) AND the view-path
// transmittance (multiplicative on the surface color), packed into
// AtmResult. Caller uses:
//   let ap = aerial_perspective(uS.eye.xyz, in.worldPos);
//   final = surface_color * ap.transmittance + ap.inScatter;
//
// At grazing angles (limb) the long atmospheric path drops
// transmittance toward zero so the surface color FADES OUT into
// pure atmospheric scattering, closing the visible gap between the
// planet body and the sky-pass scattering. This is the C.0 fix
// that ships ahead of the full Hillaire LUT pipeline.
fn aerial_perspective(camPos: vec3<f32>, fragPos: vec3<f32>) -> AtmResult {
  let v = fragPos - camPos;
  let dist = length(v);
  if (dist < 1.0) { return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0)); }
  let dir = v / dist;
  return _atm_integrate(camPos, dir, dist);
}

// C.5 -- Aerial-perspective LUT sample. Looks up the precomputed
// in-scatter + transmittance for a surface fragment at world position
// fragPos. Faster than the per-pixel aerial_perspective integrator
// (one trilinear lookup vs 16+16 ray samples).
//
// The LUT is a 2D-array (32 layers, each layer = one depth slice).
// We sample two adjacent layers and lerp manually because WGSL's
// 2D-array sampling doesn't interpolate across layers automatically.
//
// Distance-to-layer mapping is quadratic: layer_f = (N-1) *
// sqrt(distance / maxDist), inverting the LUT-generation formula.
// The clip-space coords come from projecting fragPos through the
// existing viewProj; v is flipped because of the same NDC<->UV
// convention noted in the LUT v-flip fix.
// 2026-05-22 STRUCTURAL FIX -- the depth-layer ring-banding the user
// reported was a fundamental consequence of the aerial-perspective
// LUT having a depth axis: per-LUT-voxel sample-vs-density aliasing
// is baked into the LUT contents, and no amount of inter-layer
// filtering can recover it.
//
// Replacement: use the existing sky-view LUT for in-scatter (it
// already integrates camera-in-direction to ground-or-atm-exit) and
// the transmittance LUT for the camera-to-surface transmittance
// (one analytic lookup, since for surface fragments the ray ENDS at
// the ground intersection -- exactly where T_LUT clips). Both LUTs
// have NO depth axis, so no depth-layer aliasing whatsoever.
//
// Caveats: assumes the surface fragment is approximately at the
// ground intersection distance (true for the planet mesh; not for
// arbitrary elevated geometry on top of the planet). Adequate for
// our use case; for full Bruneton-style analytic aerial perspective
// with arbitrary surface elevations, a 3D pre-baked single-scatter
// LUT would be needed.
fn sample_aerial_perspective_lut(camPos: vec3<f32>, fragPos: vec3<f32>) -> AtmResult {
  let v = fragPos - camPos;
  let dist = length(v);
  if (dist < 1.0) { return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0)); }
  let dir = v / dist;

  let planetC = uS.envPlanet.xyz;
  let planetR = uS.envPlanet.w;
  let atmR    = uS.envPlanetAtm.x;
  let atmThk  = atmR - planetR;

  if (planetR <= 0.0 || atmR <= planetR) {
    return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0));
  }

  // Atmosphere entry point. Camera may be outside the atm shell
  // (orbital view); cam-to-entry is vacuum (T=1, zero scatter) so
  // the meaningful aerial-perspective path is entry-to-fragment.
  let oc = camPos - planetC;
  let b  = dot(oc, dir);
  let cAtm = dot(oc, oc) - atmR * atmR;
  var entryPos = camPos;
  if (cAtm > 0.0) {
    let hAtm = b * b - cAtm;
    if (hAtm < 0.0) {
      // Ray doesn't intersect the atmosphere at all.
      return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0));
    }
    let sAtm = sqrt(hAtm);
    let tEnter = -b - sAtm;
    if (tEnter > 0.0) { entryPos = camPos + dir * tEnter; }
  }

  // Per-channel transmittance via direct transmittance LUT lookup.
  // T_LUT(cosVZ, alt) returns the transmittance from a point at
  // altitude alt along direction cosVZ to atm edge OR ground
  // (whichever comes first). For a ray heading toward a surface
  // fragment the LUT clips at ground = the fragment, so this single
  // lookup is T(entry, frag) analytically. (T(cam, entry) = 1 when
  // camera is outside the atm, so T(cam, frag) = T_LUT.)
  //
  // Sprint 10-6 v7: shift LUT lookup from MSL to AGL by subtracting
  // the terrain height at the camera's lat/lon (envPlanetGeom.y).
  // The LUT is calibrated assuming density falls off from planetR
  // (sea level) -- but a camera on a 5 km mountain peak should see
  // through THIN air (it's above the densest atmosphere layer), not
  // through 5 km of sea-level dense air. Subtracting terrain shifts
  // the reference so vT=0 (densest LUT row) corresponds to the local
  // terrain rather than always to sea level.
  let entryRadial = entryPos - planetC;
  let entryRadialLen = length(entryRadial);
  let terrainAtCam = max(0.0, uS.envPlanetGeom.y);
  let entryAltMSL = max(0.0, entryRadialLen - planetR);
  let entryAlt = max(0.0, entryAltMSL - terrainAtCam);
  let entryUp  = entryRadial / max(entryRadialLen, 1.0);
  let cosVZ = dot(dir, entryUp);
  let uT = sqrt(clamp(cosVZ * 0.5 + 0.5, 0.0, 1.0));
  let vT = sqrt(clamp(entryAlt / max(atmThk, 1.0), 0.0, 1.0));
  let transmittance = textureSampleLevel(atmTransmittanceLUT, atmLutSampler,
                                          vec2<f32>(uT, 1.0 - vT), 0.0).rgb;

  // In-scatter via the existing sky-view LUT. For directions where
  // the ray hits the ground (true for every surface pixel by
  // definition), the sky-view LUT integrated FROM the camera in
  // that direction TO the ground hit -- exactly the aerial-
  // perspective in-scatter. No depth axis = no depth aliasing.
  let inScatterFull = sample_skyview_lut(dir);

  // Sprint 10-6 v6 -- distance-aware aerial perspective, retuned.
  // Previous 25 km scale height was still too aggressive at typical
  // surface viewing distances. The atmosphere LUT is MSL-referenced
  // (densest at sea level), so when standing on a mountain or flying
  // low over terrain, looking horizontally at terrain a few km away
  // gave heavy fog -- user reported "atmosphere peaks 1km above the
  // surface, surface is very foggy." 80 km scale height matches
  // typical clear-day terrestrial visibility (you can see mountains
  // 50+ km away clearly on a good day) while still fogging the
  // 100+ km horizon and orbital-to-ground transition.
  //
  //   dist 1 km   -> apScale 0.012 (basically clear)
  //   dist 5 km   -> apScale 0.06  (clear)
  //   dist 25 km  -> apScale 0.27  (light haze)
  //   dist 50 km  -> apScale 0.46  (moderate haze)
  //   dist 100 km -> apScale 0.71  (heavy haze)
  //   dist 200 km -> apScale 0.92  (mostly fog)
  //
  // Proper fix later: feed terrain altitude into the LUT so AP
  // density references AGL (height above terrain) instead of MSL
  // (height above sea level). For now, the wider scale just makes
  // the visible-vs-fogged transition match physical intuition.
  let apScale = 1.0 - exp(-dist / 80000.0);
  let inScatter = inScatterFull * apScale;
  let transmittanceScaled = mix(vec3<f32>(1.0), transmittance, apScale);

  return AtmResult(inScatter, transmittanceScaled);
}

/* ---- Sprint 7.6.a-night: photorealistic stars + Milky Way helpers.
 *
 * Three components combined per fragment:
 *  1) Multi-magnitude starfield  -- 3 grid scales = 3 magnitude bands,
 *     density boosted near the galactic plane (Hipparcos density rises
 *     ~5× inside |b|<10°).
 *  2) Galactic-frame Milky Way   -- band intensity from |sin(b)|,
 *     center-vs-anticenter asymmetry, 3-octave cloud fbm + threshold-
 *     cut dust lanes, warm bulge → cool disk color gradient.
 *  3) HII nebula highlights      -- rare reddish-pink blobs gated by a
 *     low-freq mask, only on the bright side of the band.
 *
 * All in pure WGSL; no textures, no CPU upload. Uses smooth value
 * noise instead of raw lattice hash because the Milky Way needs
 * cloud-like continuity across the visible band.
 */

fn _sky_hash3(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}

fn _sky_vnoise3(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // smootherstep
  let c000 = _sky_hash3(i + vec3<f32>(0.0, 0.0, 0.0));
  let c100 = _sky_hash3(i + vec3<f32>(1.0, 0.0, 0.0));
  let c010 = _sky_hash3(i + vec3<f32>(0.0, 1.0, 0.0));
  let c110 = _sky_hash3(i + vec3<f32>(1.0, 1.0, 0.0));
  let c001 = _sky_hash3(i + vec3<f32>(0.0, 0.0, 1.0));
  let c101 = _sky_hash3(i + vec3<f32>(1.0, 0.0, 1.0));
  let c011 = _sky_hash3(i + vec3<f32>(0.0, 1.0, 1.0));
  let c111 = _sky_hash3(i + vec3<f32>(1.0, 1.0, 1.0));
  let x00 = mix(c000, c100, u.x);
  let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x);
  let x11 = mix(c011, c111, u.x);
  let y0  = mix(x00, x10, u.y);
  let y1  = mix(x01, x11, u.y);
  return mix(y0, y1, u.z);
}

fn _sky_fbm3(p: vec3<f32>, octaves: i32) -> f32 {
  var amp:  f32 = 0.5;
  var freq: f32 = 1.0;
  var sum:  f32 = 0.0;
  var norm: f32 = 0.0;
  for (var i: i32 = 0; i < octaves; i = i + 1) {
    sum  = sum  + amp * _sky_vnoise3(p * freq);
    norm = norm + amp;
    amp  = amp  * 0.5;
    freq = freq * 2.03;      // jittered to break axis-aligned pulses
  }
  return sum / max(norm, 1e-6);
}

/* Star color from a temperature hash in [0,1]. Skewed toward cool
 * reds (real stellar IMF: most stars are M-class) with rare blue
 * giants -- pow(0.55) remaps a uniform hash so the bulk of stars
 * land in the warm half. */
fn _sky_star_color(tIn: f32) -> vec3<f32> {
  let t = pow(clamp(tIn, 0.0, 1.0), 0.55);
  if (t < 0.30) {
    return mix(vec3<f32>(1.00, 0.55, 0.32),     // M red
               vec3<f32>(1.00, 0.78, 0.55),     // K orange
               t / 0.30);
  } else if (t < 0.55) {
    return mix(vec3<f32>(1.00, 0.78, 0.55),
               vec3<f32>(1.00, 1.00, 0.96),     // G/F yellow-white
               (t - 0.30) / 0.25);
  } else if (t < 0.80) {
    return mix(vec3<f32>(1.00, 1.00, 0.96),
               vec3<f32>(0.86, 0.92, 1.00),     // A white-blue
               (t - 0.55) / 0.25);
  } else {
    return mix(vec3<f32>(0.86, 0.92, 1.00),
               vec3<f32>(0.62, 0.74, 1.00),     // B/O blue
               (t - 0.80) / 0.20);
  }
}

/* Galactic frame projection. Returns vec2(sin(galLat), cos(galLon))
 * where galLat = 0 on the plane, ±π/2 at the poles, and galLon = 0
 * pointing toward the galactic center. The Gram-Schmidt step keeps
 * the center direction perpendicular to the pole regardless of how
 * the pole guess is normalized. */
fn _sky_galactic(dir: vec3<f32>) -> vec2<f32> {
  let galPole = normalize(vec3<f32>(0.45, 0.75, -0.48));
  let guess   = vec3<f32>(0.80, 0.10, 0.59);
  let center  = normalize(guess - galPole * dot(guess, galPole));
  let sinLat  = dot(dir, galPole);
  let inPlane = normalize(dir - galPole * sinLat);
  let lonCos  = dot(inPlane, center);
  return vec2<f32>(sinLat, lonCos);
}

/* Standard HSV→RGB (Sam Hocevar's branchless form). Used by the
 * mantis-shrimp nebula pass to cycle through the full color wheel
 * instead of mixing two anchor colors. */
fn _sky_hsv_to_rgb(c: vec3<f32>) -> vec3<f32> {
  let K = vec4<f32>(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx,
                   clamp(p - K.xxx, vec3<f32>(0.0), vec3<f32>(1.0)),
                   c.y);
}

/* Volumetric Milky Way + unrealistic nebula raymarch.
 *
 * Earlier sprint baked the band analytically (single sample per
 * fragment of bandFalloff × cloudNoise × dustMask). That reads as
 * a flat painted streak -- no depth. This pass marches the view
 * ray through a 3D density field constrained near the galactic
 * plane, so overlapping cloud structures actually composite over
 * each other and the band gets the parallax-y feel of clouds at
 * different distances. Hue is sampled per-step from an independent
 * fbm and run through HSV with full-wheel cycling, giving the
 * mantis-shrimp palette (cyan / magenta / lime / hot pink / violet
 * / electric blue) rather than the realistic warm-bulge → cool-
 * disk gradient.
 *
 * Cost: ~16 steps × (3-oct density fbm + 2-oct hue fbm + 1 vnoise)
 * per ray that touches the band. Early-outs aggressively when far
 * from the plane (|sin b| > 0.42) and on alpha saturation. */
fn _sky_volumetric_band(dir: vec3<f32>,
                        sinLat: f32,
                        lonCos: f32,
                        starVis: f32) -> vec3<f32> {
  let absLat = abs(sinLat);
  if (absLat > 0.42) {
    return vec3<f32>(0.0);
  }
  let bandCore = exp(-absLat * absLat * 22.0);
  let centerW  = pow(clamp(0.5 + 0.5 * lonCos, 0.0, 1.0), 1.4);

  var accum    = vec3<f32>(0.0);
  var alpha:   f32 = 0.0;
  let STEPS:   i32 = 16;
  let TSTART:  f32 = 1.0;
  let TSTEP:   f32 = 0.14;

  for (var i: i32 = 0; i < STEPS; i = i + 1) {
    let t = TSTART + TSTEP * f32(i);
    let p = dir * t;

    // Density. Carved into band shape so wide cutoff doesn't paint
    // a uniform glow above the disk. (dN - 0.40) * 2.5 gives a
    // sharper edge than raw fbm.
    let dN = _sky_fbm3(p * 2.2 + vec3<f32>(7.3, 1.1, 4.9), 3);
    let density = clamp((dN - 0.40) * 2.5, 0.0, 1.0)
                * bandCore
                * (0.35 + 0.65 * centerW);
    if (density < 0.003) { continue; }

    // Hue: independent low-freq fbm + a high-freq detail term
    // + small per-step phase to give different depths different
    // hues (parallax-color illusion). lonCos pushes the hue across
    // the band so the center isn't the same shade as the wings.
    let hueN1 = _sky_fbm3(p * 1.3 + vec3<f32>(11.7, -3.4, 8.8), 2);
    let hueN2 = _sky_vnoise3(p * 5.1 + vec3<f32>(0.7, 4.2, -1.6));
    let hue   = fract(hueN1 * 1.9
                      + hueN2 * 0.40
                      + lonCos * 0.18
                      + f32(i) * 0.011);
    let sat   = mix(0.70, 1.00, smoothstep(0.0, 1.0, density));
    let val   = 1.0 + 0.7 * smoothstep(0.55, 0.95, density);
    let stepCol = _sky_hsv_to_rgb(vec3<f32>(hue, sat, val));

    accum = accum + stepCol * density * (1.0 - alpha);
    alpha = min(1.0, alpha + density * 0.45);
    if (alpha > 0.97) { break; }
  }

  return accum * starVis * 1.5;
}

fn sample_procedural_sky_features(dir: vec3<f32>) -> vec3<f32> {
  let sunDir    = uS.envSun.xyz;
  let sunVis    = uS.envSun.w;
  let turbidity = uS.envParams.z;
  let intensity = uS.envParams.y;
  let moonPhase = uS.envSky.w;   // packed by JS; 0/1=new, 0.5=full

  let view_y   = clamp(dir.y, -1.0, 1.0);
  let sun_elev = clamp(sunDir.y, -1.0, 1.0);
  let day      = smoothstep(-0.08, 0.18, sun_elev);
  let night    = 1.0 - day;
  // §planet-spec Phase 5+ -- stars also pop out at altitude even
  // during the day, because the atmosphere is thin enough that sun
  // glare doesn't drown them anywhere except near the sun direction.
  // star_vis is whichever is brighter (it's night, OR we're in space).
  //
  // Sprint 7.6.a-atm BUG-FIX 2026-05-21: previously altFade used
  // uS.eye.y (world Y altitude) which assumed Y-up flat ground.
  // On a PLANET the camera can be on any face -- a camera at 200km
  // altitude on the +X side of the planet has eye.y=0, so altFade
  // was permanently 0 and stars never appeared even when actually
  // in space. Use planet-aware altitude when a planet is wired:
  // distance-from-planet-center minus surface radius. Falls back to
  // eye.y for non-planet scenes.
  //
  // Transition band 50km -> 100km matches the Karman line (100km =
  // physical space-boundary by international convention; below that
  // is "atmosphere", above is "space"). Stars fade in across the
  // upper-atmosphere band so the transition is smooth instead of
  // a hard pop at the planet's atmosphere-top radius.
  var altitude_m: f32;
  if (uS.envPlanet.w > 0.0) {
    altitude_m = max(0.0, length(uS.eye.xyz - uS.envPlanet.xyz) - uS.envPlanet.w);
  } else {
    altitude_m = uS.eye.y;
  }
  let altFade  = clamp((altitude_m - 50000.0) / 50000.0, 0.0, 1.0);
  let star_vis = max(night, altFade);

  var col = vec3<f32>(0.0);

  // --- Sun. 0.53° angular diameter -- our actual sun's apparent
  //     size from Earth orbit (sun radius 696,000 km / 1 AU). The
  //     bright HDR disc gets clipped to pure white by the ACES
  //     tonemap, while the wide halo carries the glow into the
  //     surrounding sky so the eye reads "luminous body" rather
  //     than just "bright pixel."
  //
  //     Math:
  //       angle from sun center = acos(cos_theta)
  //       cos(0.265°) ≈ 0.999989  (full sun edge, radius 0.265°)
  //       cos(0.443°) ≈ 0.99997   (~0.18° anti-aliased rim)
  //       cos(5°)     ≈ 0.99619   (outer halo edge)
  //
  //     Brightness:
  //       disc peak = 220 × sunDiskColor (≈480 raw red) -- ACES clips
  //                   to white in the center, leaving the edge of the
  //                   disc to fade through the tone curve
  //       halo peak = 6 × sunDiskColor with a cubic falloff toward
  //                   the edge, simulating atmospheric forward scatter
  //                   + atmospheric+lens corona feel
  let cos_theta = clamp(dot(dir, sunDir), -1.0, 1.0);
  let sunExt = _sky_sun_extinction(max(sun_elev, -0.05), turbidity);
  let sunDiskColor = sunExt * vec3<f32>(2.2, 2.0, 1.8);

  let disk = smoothstep(0.99997, 0.999989, cos_theta) * sunVis;
  col = col + disk * sunDiskColor * 220.0;

  let halo_r = smoothstep(0.99619, 0.999989, cos_theta) * sunVis;
  let halo = halo_r * halo_r * halo_r;
  col = col + halo * sunDiskColor * 6.0;

  // --- Moon. Placed directly opposite the sun (full-moon position).
  //     Phase param modulates lit fraction via sin(phase·π) -- gives
  //     0 (new) at moonPhase=0/1 and 1 (full) at moonPhase=0.5. v1
  //     just brightness-modulates; a proper crescent shape would
  //     compute per-pixel lit hemisphere via sphere math.
  let moonDir    = -sunDir;
  let cos_moon   = clamp(dot(dir, moonDir), -1.0, 1.0);
  let moon_vis   = clamp(night, 0.0, 1.0);
  let phaseLit   = sin(clamp(moonPhase, 0.0, 1.0) * 3.14159265);
  let moon_disk  = smoothstep(0.99988, 0.99996, cos_moon) * moon_vis * 5.0 * phaseLit;
  let moon_halo  = smoothstep(0.985, 0.9999, cos_moon)   * moon_vis * 0.05 * phaseLit;
  let moon_color = vec3<f32>(0.92, 0.95, 1.00);
  col = col + (moon_disk + moon_halo) * moon_color;

  // --- Sprint 7.6.a-night: photoreal starfield + galactic Milky Way.
  //
  // Three components rolled into one if-block. Helpers are above the
  // function: _sky_hash3 (lattice hash), _sky_vnoise3 (smooth value
  // noise -- needed because raw lattice hash repeats visibly across
  // the Milky Way's wide band), _sky_fbm3 (3-octave fbm for cloud
  // structure), _sky_star_color (stellar-IMF biased temperature →
  // color), _sky_galactic (returns sin(b), cos(l) in galactic frame).
  //
  // §planet-spec Phase 5+: view_y > 0 gate removed -- in space the
  // user looks DOWN at the planet and stars are visible everywhere
  // not occluded by it; planet mesh depth-tests against the sky.
  if (star_vis > 0.001) {
    let gal     = _sky_galactic(dir);
    let sinLat  = gal.x;                         // sin(galactic lat)
    let lonCos  = gal.y;                         // cos(galactic lon)
    let absLat  = abs(sinLat);
    let bandFalloff = exp(-absLat * absLat * 28.0);   // ~10° band
    let densityBoost = 1.0 + 3.0 * bandFalloff;       // plane bias

    // --- 1) BRIGHT stars (rare, coarse grid). m≈1 magnitude class.
    let p1 = floor(dir * 80.0);
    let h1 = _sky_hash3(p1);
    let t1 = _sky_hash3(p1 + vec3<f32>(7.0, 13.0, 19.0));
    let tw1 = 0.65 + 0.35 * _sky_hash3(p1 + vec3<f32>(91.0, 53.0, 11.0));
    let amt1 = smoothstep(0.998, 1.0, h1) * star_vis * 3.5;
    col = col + _sky_star_color(t1) * amt1 * tw1;

    // --- 2) MID stars (medium grid). m≈3 magnitude class.
    let p2 = floor(dir * 220.0);
    let h2 = _sky_hash3(p2);
    let t2 = _sky_hash3(p2 + vec3<f32>(7.0, 13.0, 19.0));
    let tw2 = 0.60 + 0.40 * _sky_hash3(p2 + vec3<f32>(91.0, 53.0, 11.0));
    let thr2 = 0.995 - 0.005 * bandFalloff;          // looser near plane
    let amt2 = smoothstep(thr2, 1.0, h2) * star_vis * 1.5 * densityBoost;
    col = col + _sky_star_color(t2) * amt2 * tw2;

    // --- 3) DIM stars (fine grid). m≈5+ magnitude class. The bulk
    //     of visible stars on a dark site come from this layer.
    let p3 = floor(dir * 520.0);
    let h3 = _sky_hash3(p3);
    let t3 = _sky_hash3(p3 + vec3<f32>(7.0, 13.0, 19.0));
    let tw3 = 0.60 + 0.40 * _sky_hash3(p3 + vec3<f32>(91.0, 53.0, 11.0));
    let thr3 = 0.992 - 0.010 * bandFalloff;
    let amt3 = smoothstep(thr3, 1.0, h3) * star_vis * 0.7 * densityBoost;
    col = col + _sky_star_color(t3) * amt3 * tw3;

    // --- 4) Volumetric Milky Way + mantis-shrimp nebulas.
    //     Replaces the previous flat painted band + separate HII
    //     blob pass. Raymarches the view ray through a 3D density
    //     field constrained near the galactic plane and accumulates
    //     emissive color from independent hue fbm sampled per step.
    //     Full HSV-wheel cycling gives the saturated cyan / magenta
    //     / lime / hot-pink / violet palette instead of the realistic
    //     warm-brown / cool-blue duo.
    col = col + _sky_volumetric_band(dir, sinLat, lonCos, star_vis);
  }

  return col * intensity;
}

fn sample_procedural_sky(dir: vec3<f32>) -> vec3<f32> {
  return sample_procedural_sky_smooth(dir) + sample_procedural_sky_features(dir);
}

// Sprint 7.5.4 -- sample the wired environment by direction. Used
// for hemisphere IBL ambient on lit materials (Phong, PBR). dir
// should be a normalized world-space vector (e.g. the surface
// normal for diffuse ambient, the reflection vector for specular).
fn sample_env(dir: vec3<f32>) -> vec3<f32> {
  let mode = u32(uS.envParams.x);
  if (mode == 1u) {
    // GradientSky: 3-stop. Above horizon -> mix(horizon, sky); below
    // -> mix(horizon, ground). smoothstep softens the equator band
    // so a glossy reflection doesn't show a knife edge.
    let t = clamp(dir.y, -1.0, 1.0);
    let intensity = uS.envParams.y;
    if (t > 0.0) {
      return mix(uS.envHorizon.rgb, uS.envSky.rgb,    smoothstep(0.0, 1.0, t)) * intensity;
    } else {
      return mix(uS.envHorizon.rgb, uS.envGround.rgb, smoothstep(0.0, 1.0, -t)) * intensity;
    }
  }
  if (mode == 2u) {
    // 2026-05-21 Sprint 7.6.a-atm -- IBL ambient: if a planet is
    // wired use Tier B planet atmosphere (proper sky color from the
    // camera's altitude), else fall back to the legacy flat-ground
    // smooth sky. Features (disk/moon/stars) never go through IBL.
    // C.4 -- now backed by the sky-view LUT (same precomputed
    // atmosphere color as fs_sky), so IBL ambient on planet-aware
    // surfaces stays consistent with the visible sky.
    if (uS.envPlanet.w > 0.0) {
      return sample_skyview_lut(dir);
    }
    return sample_procedural_sky_smooth(dir);
  }
  if (mode == 3u) {
    // Sprint 7.5.4.b -- HDRI / Skybox. Equirectangular texture
    // sample. envParams.y is the intensity multiplier (lets users
    // dial exposure without re-loading the file). textureSampleLevel
    // at LOD 0 -- mipmap generation for the env texture is a future
    // polish; without it the diffuse IBL sample (which would
    // benefit from a low LOD for smoothing) can show high-freq
    // texels in matte reflections.
    let uv = dir_to_equirect_uv(dir);
    let hdr = textureSampleLevel(envTexture, envSampler, uv, 0.0);
    return hdr.rgb * uS.envParams.y;
  }
  // Default: pre-7.5.4 hardcoded hemisphere-IBL. Two-stop gradient
  // from cool sky to warm ground via the up-axis-aligned mix that
  // fs_pbr used inline pre-refactor.
  let envSkyD    = vec3<f32>(0.55, 0.62, 0.78);
  let envGroundD = vec3<f32>(0.18, 0.16, 0.14);
  return mix(envGroundD, envSkyD, dir.y * 0.5 + 0.5);
}
struct PerDraw {
  model:      mat4x4<f32>,
  baseColor:  vec4<f32>,   // .rgb = material color, .a = vertex-color mix amount (0 = pure material color, 1 = pure vertex color)
  matParams:  vec4<f32>,   // .x = shininess (Phong/Terrain), .y = ambient (Phong/Terrain), .z = metallic (PBR) / slopeRockiness (Terrain), .w = roughness (PBR) / vertexMix (Terrain)
  // v0.3.123 Phase 7 §5.5.c -- TerrainMaterial. Four band slots,
  // each holding an RGB color in .rgb and an altitude threshold
  // (or softness for band4) in .a. Ignored by every other material;
  // they read only model + baseColor + matParams. fs_terrain reads
  // these to do altitude+slope-blended shading.
  band1:      vec4<f32>,   // .rgb = sand color,   .a = alt1 (top of band1)
  band2:      vec4<f32>,   // .rgb = grass color,  .a = alt2
  band3:      vec4<f32>,   // .rgb = rock color,   .a = alt3
  band4:      vec4<f32>,   // .rgb = snow color,   .a = softness (smoothstep half-width)
  // v0.3.126 Phase 7 §5.5.c-3 -- vsParams for vertex-shader
  // heightmap displacement (ProceduralTerrain → Terrain.heightmap).
  //   x = heightScale   (multiplier applied to sampled height)
  //   y = worldSize     (full extent of the grid, used to compute
  //                      world-space derivatives for the normal)
  //   z = unused
  //   w = heightmap layer index in the scratch texture array
  // Read only by vs_terrain. vs_main ignores it.
  vsParams:   vec4<f32>,
  // v0.3.129 TerrainMaterial v2 -- detail + bump param blocks.
  //   detailParams.x = detailScale     (macro noise frequency)
  //   detailParams.y = detailStrength  (macro variation amount)
  //   detailParams.z = microScale      (micro noise frequency)
  //   detailParams.w = microStrength   (micro speckle amount)
  //   bumpParams.x   = edgeJitter      (noise on band boundaries)
  //   bumpParams.y   = bumpStrength    (procedural normal perturb)
  //   bumpParams.z   = snowMaskAmount  (snow only on flat tops)
  //   bumpParams.w   = unused
  // Read only by fs_terrain. Other fragment shaders ignore.
  detailParams: vec4<f32>,
  bumpParams:   vec4<f32>,
  // §5.5.h-5 -- Water-specific extra slot. waterExtra.xy = disc
  // center tile (X, Z) so the LOD-match shader uses the ACTUAL
  // disc center (with forwardBias applied) instead of the camera
  // tile -- otherwise water foam misaligns east/west of the
  // player when they look around. Other material shaders ignore.
  waterExtra:   vec4<f32>,
  // §5.5.h-21 -- cloud-shadow params (Clouds3D node, if wired).
  //   cloudExtra.x = cloud altitude (slab base Y)
  //   cloudExtra.y = cloud coverage (0..1; 0 = disabled)
  //   cloudExtra.z = cloud noise scale (world XZ frequency)
  //   cloudExtra.w = cloud seed
  // Read by fs_water to project the water pixel up along the sun
  // ray and sample cloud density; if a cloud is overhead the water
  // pixel is shadowed. Other material shaders ignore.
  cloudExtra:   vec4<f32>,
  // Phase 8 sprint 8-3b -- PlanetMesh texture inputs.
  //   planetExtra.x = land texture layer (-1 = no land texture wired)
  //   planetExtra.y = water texture layer (-1 = no water texture wired)
  //   planetExtra.z = textureScale (inverse world units per repeat)
  //   planetExtra.w = textureMix (0 = pure biome, 1 = pure texture)
  // Read only by fs_unlit_vc's planet-aware branch.
  planetExtra:  vec4<f32>,
};
@group(0) @binding(0) var<uniform> uS: PerScene;
@group(0) @binding(1) var<uniform> uD: PerDraw;

// Sprint 7.5.3c push 5 -- texture binding for ShaderMat. Bound to
// the scratch texture array (matched parity with Scene's readKey
// since Scene is depth=0 → readKey="a", upstreams of ShaderMat at
// depth=1 → writeKey="a"). Unused by non-ShaderMat materials, but
// always present in the BGL so the pipeline layout is uniform.
@group(0) @binding(2) var srcTexture: texture_2d_array<f32>;
@group(0) @binding(3) var srcSampler: sampler;

// Sprint 7.5.4.b -- env texture for HDRI / Skybox equirect sampling.
// Bound to a 1x1 mid-gray when no HDRI is loaded; sample_env mode 3
// is the only path that reads it. RGBA16Float so HDR values > 1
// pass through (clamp happens at framebuffer write).
@group(0) @binding(4) var envTexture: texture_2d<f32>;
@group(0) @binding(5) var envSampler: sampler;

// Sprint 7.6.b-atm Tier-C.1 -- atmosphere LUTs. Updated each frame
// before the scene pass by _renderAtmosphereLUTs. Sampled in
// _atm_integrate to add the multi-scattering term (the limb glow
// term that lights the side of the atmosphere opposite the sun).
//   binding 6 = transmittance LUT (256 x 64 RGBA16F)
//   binding 7 = multi-scattering LUT (32 x 32 RGBA16F)
//   binding 8 = LUT sampler (linear, clamp-to-edge)
// All three default to a 1x1 black texture / env sampler when no
// planet is wired; sample sites guard on uS.envPlanet.w > 0 anyway.
@group(0) @binding(6) var atmTransmittanceLUT: texture_2d<f32>;
@group(0) @binding(7) var atmMultiScatterLUT:  texture_2d<f32>;
@group(0) @binding(8) var atmLutSampler:       sampler;
// C.4 -- sky-view LUT: full-sphere precomputed atmospheric color for
// the current camera position, indexed by (azimuth, elevation) in the
// camera's planet-local frame. fs_sky samples this in one texture
// fetch instead of running its own per-pixel atmosphere integral.
@group(0) @binding(9) var atmSkyViewLUT:       texture_2d<f32>;
// Sprint 10-5c-c: Sparse Virtual Texture bindings. Atlas is a single
// 4096² RGBA8 texture holding 32×32 = 1024 page slots of 128² each.
// Page table is a 256² R32Uint × 6-layer array, one layer per cube
// face, encoding (slotY << 16) | slotX for resident pages or
// 0xFFFFFFFF for unresident.
@group(0) @binding(10) var svtAtlas:       texture_2d<f32>;
@group(0) @binding(11) var svtSampler:     sampler;
@group(0) @binding(12) var svtPageTable:   texture_2d_array<u32>;
// Sprint 10-5c-g: paired normal-map atlas, same 1024-slot layout as
// svtAtlas. RGB encodes tangent-space normal (XYZ in [-1, 1] via
// (raw - 0.5) * 2). Sampled with the same atlas UV.
@group(0) @binding(13) var svtNormalAtlas: texture_2d<f32>;
// Sprint 10-5c-h: PBR material atlas. R=rough, G=metal, B=AO, A=reserved.
@group(0) @binding(14) var svtMaterialAtlas: texture_2d<f32>;
// Sprint 10-5c-h2: fine-zoom page table (1024² pages per face, 6 layers).
// Sampled first; base table (binding 12) used as fallback when fine
// page is unresident.
@group(0) @binding(15) var svtPageTableFine: texture_2d_array<u32>;
// Phase 8.B.15 A.4 -- per-material PBR maps (PhysicalMat textures).
// Bound to 1x1 defaults when a material has no map so existing
// untextured meshes are byte-identical: albedo=white (x1 = no-op),
// normal=(0.5,0.5,1) (tangent +Z = no perturb), rough/metal=white
// (x1 = uses the material's scalar param unchanged). Sampled in
// fs_pbr with srcSampler (binding 3) at the mesh's uv.
@group(0) @binding(16) var matAlbedoTex:   texture_2d<f32>;
@group(0) @binding(17) var matNormalTex:   texture_2d<f32>;
@group(0) @binding(18) var matRoughTex:    texture_2d<f32>;
@group(0) @binding(19) var matMetalTex:    texture_2d<f32>;

/* SVT sampling helper. Given a unit-sphere world direction, returns
 * (rgb, pageResidentFlag). Flag = 1.0 if the page was resident in
 * the atlas and rgb is valid sampled detail; 0.0 if not resident,
 * caller should fall back to per-fragment procedural.
 *
 * Implementation:
 *   1. Pick cube face by max-axis test.
 *   2. Compute face-local (u, v) ∈ [0, 1] via spherify-inverse.
 *      (For now use simple atan2-style projection -- not the exact
 *      inverse of the bake's spherify warp. Close enough at 256²
 *      page resolution; refine to true inverse in 10-5c-f.)
 *   3. Compute (pageX, pageY) and local UV within page.
 *   4. textureLoad page-table → packed slot id.
 *   5. If unresident (= 0xFFFFFFFF), return flag=0.
 *   6. Else sample atlas at slot+local UV with linear filter. */
struct SvtSample {
  albedo:    vec3<f32>,
  normal:    vec3<f32>,   // tangent-space normal, normalized
  roughness: f32,         // 0 = mirror, 1 = matte
  metallic:  f32,         // 0 = dielectric, 1 = pure metal
  ao:        f32,         // 1 = no occlusion
  resident:  f32,         // 1.0 if page resident, 0.0 otherwise
};

/* Cube direction → (face, faceUV in [-1,1]). Shared by both base and
 * fine zoom samplers. */
fn _svt_face_uv(dir: vec3<f32>) -> vec3<f32> {
  let absX = abs(dir.x);
  let absY = abs(dir.y);
  let absZ = abs(dir.z);
  var face: f32 = 0.0;
  var u: f32 = 0.0;
  var v: f32 = 0.0;
  if (absX >= absY && absX >= absZ) {
    let inv = 1.0 / absX;
    if (dir.x > 0.0) { face = 0.0; u = -dir.z * inv; v = dir.y * inv; }
    else             { face = 1.0; u =  dir.z * inv; v = dir.y * inv; }
  } else if (absY >= absZ) {
    let inv = 1.0 / absY;
    if (dir.y > 0.0) { face = 2.0; u = dir.x * inv; v =  dir.z * inv; }
    else             { face = 3.0; u = dir.x * inv; v = -dir.z * inv; }
  } else {
    let inv = 1.0 / absZ;
    if (dir.z > 0.0) { face = 4.0; u =  dir.x * inv; v = dir.y * inv; }
    else             { face = 5.0; u = -dir.x * inv; v = dir.y * inv; }
  }
  return vec3<f32>(u, v, face);
}

/* Common atlas sample given a slot + within-page UV. */
fn _svt_read_atlas(slotX: u32, slotY: u32, inPageU: f32, inPageV: f32) -> SvtSample {
  var out: SvtSample;
  let slotsPerRow: f32 = 32.0;
  let atlasU = (f32(slotX) + inPageU) / slotsPerRow;
  let atlasV = (f32(slotY) + inPageV) / slotsPerRow;
  out.albedo = textureSampleLevel(svtAtlas, svtSampler, vec2<f32>(atlasU, atlasV), 0.0).rgb;
  let nRaw = textureSampleLevel(svtNormalAtlas, svtSampler, vec2<f32>(atlasU, atlasV), 0.0).rgb;
  out.normal = normalize((nRaw - vec3<f32>(0.5)) * 2.0);
  let mRaw = textureSampleLevel(svtMaterialAtlas, svtSampler, vec2<f32>(atlasU, atlasV), 0.0);
  out.roughness = mRaw.r;
  out.metallic  = mRaw.g;
  out.ao        = mRaw.b;
  out.resident  = 1.0;
  return out;
}

/* Try the fine page table first (1024² per face = ~78 m/texel); if
 * unresident, fall back to the base page table (256² per face =
 * ~300 m/texel). Caller checks .resident and falls back further
 * to per-fragment procedural if both miss. */
fn _svt_sample(dir: vec3<f32>) -> SvtSample {
  var out: SvtSample;
  out.albedo    = vec3<f32>(0.0);
  out.normal    = vec3<f32>(0.0, 0.0, 1.0);
  out.roughness = 0.78;
  out.metallic  = 0.0;
  out.ao        = 1.0;
  out.resident  = 0.0;

  let fuv = _svt_face_uv(dir);
  let u = fuv.x; let v = fuv.y; let face = i32(fuv.z);
  let uv01 = vec2<f32>(u * 0.5 + 0.5, v * 0.5 + 0.5);

  // FINE first: 1024 pages per face.
  let pagesFine: f32 = 1024.0;
  let pageFineFx = uv01.x * pagesFine;
  let pageFineFy = uv01.y * pagesFine;
  let pageFineX = i32(floor(pageFineFx));
  let pageFineY = i32(floor(pageFineFy));
  let inPageFineU = fract(pageFineFx);
  let inPageFineV = fract(pageFineFy);
  let fineEntry = textureLoad(svtPageTableFine,
                              vec2<i32>(pageFineX, pageFineY), face, 0).r;
  if (fineEntry != 0xFFFFFFFFu) {
    let slotX = fineEntry & 0xFFFFu;
    let slotY = (fineEntry >> 16u) & 0xFFFFu;
    return _svt_read_atlas(slotX, slotY, inPageFineU, inPageFineV);
  }

  // BASE fallback: 256 pages per face.
  let pagesBase: f32 = 256.0;
  let pageBaseFx = uv01.x * pagesBase;
  let pageBaseFy = uv01.y * pagesBase;
  let pageBaseX = i32(floor(pageBaseFx));
  let pageBaseY = i32(floor(pageBaseFy));
  let inPageBaseU = fract(pageBaseFx);
  let inPageBaseV = fract(pageBaseFy);
  let baseEntry = textureLoad(svtPageTable,
                              vec2<i32>(pageBaseX, pageBaseY), face, 0).r;
  if (baseEntry == 0xFFFFFFFFu) {
    return out;   // both unresident
  }
  let baseSlotX = baseEntry & 0xFFFFu;
  let baseSlotY = (baseEntry >> 16u) & 0xFFFFu;
  return _svt_read_atlas(baseSlotX, baseSlotY, inPageBaseU, inPageBaseV);
}

/* Sprint 10-5c-h: standard GGX/Smith/Schlick microfacet BRDF.
 * Used by fs_unlit_vc when SVT material data is resident, layered
 * over the existing baked-lambert vertex color. Adds proper
 * specular highlight that responds to view angle + sun direction
 * + material roughness. */
fn _pbr_specular(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>,
                 albedo: vec3<f32>, roughness: f32, metallic: f32) -> vec3<f32> {
  let H = normalize(V + L);
  let NoH = max(0.0, dot(N, H));
  let NoV = max(0.0, dot(N, V));
  let NoL = max(0.0, dot(N, L));
  let VoH = max(0.0, dot(V, H));
  // GGX / Trowbridge-Reitz normal distribution.
  let a  = max(0.01, roughness * roughness);
  let a2 = a * a;
  let NoH2 = NoH * NoH;
  let denom = NoH2 * (a2 - 1.0) + 1.0;
  let D = a2 / (3.14159265 * denom * denom);
  // Smith Schlick GGX geometric occlusion.
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let GV = NoV / (NoV * (1.0 - k) + k + 0.0001);
  let GL = NoL / (NoL * (1.0 - k) + k + 0.0001);
  let G  = GV * GL;
  // Schlick Fresnel. F0=0.04 for dielectric, albedo for metallic.
  let F0 = mix(vec3<f32>(0.04), albedo, metallic);
  let F  = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - VoH, 5.0);
  return (D * G * F) / max(4.0 * NoV * NoL, 0.001);
}

// Sample the multi-scattering LUT. Axes match fs_lut_multiscatter:
//   u = sunZenithCos in [-1, 1] mapped linearly to [0, 1]
//   v = sqrt(altitude / atmThickness) in [0, 1]
// 2026-05-22 fix: v inverted -- LUT is written with high-altitude
// at the top row (UV.v=0) because NDC.y=+1 maps to pixel.y=0 in
// WebGPU framebuffer convention.
fn sample_multiscatter_lut(cosSZ: f32, alt: f32, atmThickness: f32) -> vec3<f32> {
  let u = clamp(cosSZ * 0.5 + 0.5, 0.0, 1.0);
  let v = sqrt(clamp(alt / max(atmThickness, 1.0), 0.0, 1.0));
  return textureSampleLevel(atmMultiScatterLUT, atmLutSampler, vec2<f32>(u, 1.0 - v), 0.0).rgb;
}

// C.4 -- sample the sky-view LUT for a world-space view direction.
// Must match the (u, v) mapping used by fs_lut_skyview on the JS side.
// Local frame: zenith = (eye - planetCenter), north reference = world
// +Y projected to horizon plane (fallback +X near poles), east =
// up x north. Output is the pre-integrated atmospheric in-scatter
// for that direction including sun multiplier (in_scatter * sunI).
fn sample_skyview_lut(dir: vec3<f32>) -> vec3<f32> {
  let radial = uS.eye.xyz - uS.envPlanet.xyz;
  let radialLen = length(radial);
  if (radialLen < 1.0) { return vec3<f32>(0.0); }
  let localUp = radial / radialLen;
  var northRef = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(dot(localUp, northRef)) > 0.99) {
    northRef = vec3<f32>(1.0, 0.0, 0.0);
  }
  let localNorth = normalize(northRef - dot(northRef, localUp) * localUp);
  let localEast  = cross(localUp, localNorth);

  let dotUp = clamp(dot(dir, localUp), -1.0, 1.0);
  let elevation = asin(dotUp);
  let horizonProj = dir - dotUp * localUp;
  let horizonLen = max(length(horizonProj), 1e-6);
  let horizon = horizonProj / horizonLen;
  let cosAz = dot(horizon, localNorth);
  let sinAz = dot(horizon, localEast);
  let azimuth = atan2(sinAz, cosAz);

  // C.6 -- limb-aware v. v=0.5 is the planet's limb (matches the
  // LUT-generation re-parameterization), with sqrt remap putting the
  // bulk of the LUT v-resolution right at the limb regardless of
  // altitude.
  let planetR = uS.envPlanet.w;
  let sinBeta  = clamp(planetR / max(radialLen, planetR + 1.0), 0.0, 1.0);
  let limbElev = asin(sinBeta) - 1.5707963;

  let u = (azimuth + 3.14159265359) / 6.28318530718;
  var v: f32;
  if (elevation > limbElev) {
    let t = sqrt(clamp((elevation - limbElev) / max(1.5707963 - limbElev, 1e-4), 0.0, 1.0));
    v = 0.5 + t * 0.5;
  } else {
    let t = sqrt(clamp((limbElev - elevation) / max(limbElev + 1.5707963, 1e-4), 0.0, 1.0));
    v = 0.5 - t * 0.5;
  }
  // Flip v for NDC<->UV convention (LUT writes "v>=0.5 = above limb"
  // at NDC.y>=0 which lands at the TOP of the texture, UV.v=0).
  return textureSampleLevel(atmSkyViewLUT, atmLutSampler, vec2<f32>(u, 1.0 - v), 0.0).rgb;
}

// Sprint 7.5.4.b -- world ray direction -> equirect UV. Standard
// convention: U around the +Y axis (atan2(z, x)), V from zenith
// to nadir (asin(-y)). Polyhaven + most authoring tools use this
// orientation. If a particular HDRI looks rotated 180° on the X
// axis the caller can rotate dir before sampling.
fn dir_to_equirect_uv(dir: vec3<f32>) -> vec2<f32> {
  let inv_pi  = 0.31830988618;
  let inv_2pi = 0.15915494309;
  let u = atan2(dir.z, dir.x) * inv_2pi + 0.5;
  let v = asin(clamp(-dir.y, -1.0, 1.0)) * inv_pi + 0.5;
  return vec2<f32>(u, v);
}

// Phase 7 §5.5.c-2 -- triplanar projection helpers. The standard
// solve for texturing surfaces where regular UVs stretch (cliffs
// on a terrain heightmap, organic / sculpted meshes, etc.). The
// idea: sample the texture three times -- once for each world-
// axis projection (XY / XZ / ZY plane) -- and blend by the
// squared normal components. Faces aligned with each axis pick
// up that axis's sample.
//
//   triplanar_weights(n, k) -- pure weight computation. k=4 typical
//                              (sharper = each axis dominates more
//                              on faces aligned with it; k=2 is
//                              softer / more blended).
//   triplanar_sample_array  -- sample a texture_2d_array<f32>
//                              (the editor's scratch texture is
//                              one of these) at a specific layer.
//                              Use this from ShaderMat presets or
//                              future mesh materials that consume
//                              upstream visual outputs.
fn triplanar_weights(normal: vec3<f32>, sharpness: f32) -> vec3<f32> {
  let blend = pow(abs(normal), vec3<f32>(max(sharpness, 0.001)));
  let sum   = max(blend.x + blend.y + blend.z, 0.0001);
  return blend / sum;
}

fn triplanar_sample_array(tex: texture_2d_array<f32>, samp: sampler,
                          layer: u32, worldPos: vec3<f32>,
                          normal: vec3<f32>, scale: f32,
                          sharpness: f32) -> vec4<f32> {
  let w = triplanar_weights(normal, sharpness);
  // Per-axis plane projection: X-axis face samples ZY, Y-axis face
  // samples XZ (top-down), Z-axis face samples XY.
  let uvX = fract(worldPos.zy * scale);
  let uvY = fract(worldPos.xz * scale);
  let uvZ = fract(worldPos.xy * scale);
  let cX = textureSampleLevel(tex, samp, uvX, layer, 0.0);
  let cY = textureSampleLevel(tex, samp, uvY, layer, 0.0);
  let cZ = textureSampleLevel(tex, samp, uvZ, layer, 0.0);
  return cX * w.x + cY * w.y + cZ * w.z;
}

struct VsIn  {
  @location(0) pos:    vec3<f32>,
  @location(1) color:  vec3<f32>,
  @location(2) normal: vec3<f32>,
  @location(3) uv:     vec2<f32>
};
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) color:    vec3<f32>,
  @location(2) normal:   vec3<f32>,
  @location(3) uv:       vec2<f32>
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  var localPos = in.pos;

  // === Phase 8 sprint 8-6: planet-aware vertex displacement ===
  // (spec: docs/PLANET-SCALE-TERRAIN.md §8.5 part a)
  // The encoder sets uD.vsParams.z = 1.0 for PlanetMesh draws (and 0
  // elsewhere) so we can selectively displace planet vertices without
  // affecting other meshes in the same scene. Displacement is along
  // the radial direction (outward from planet center), magnitude
  // proportional to the biome's amplitude * detail_noise output.
  // Octaves auto-scale with camera altitude per _detail_octaves.
  //
  // For the planet mesh the model matrix is identity, so local-space
  // pos already equals world-space pos -- the displacement is
  // applied directly to in.pos before the model transform.
  if (uD.vsParams.z > 0.5 && uS.envPlanet.w > 0.0) {
    let radialVec = localPos - uS.envPlanet.xyz;
    let radialLen = length(radialVec);
    let radialDir = radialVec / max(radialLen, 1.0);
    let camAlt = max(0.0, length(uS.eye.xyz - uS.envPlanet.xyz) - uS.envPlanet.w);
    let octavesF = _detail_octaves(camAlt);
    if (octavesF > 0.0) {
      let bId = u32(clamp(round(in.uv.x), 0.0, 12.0));
      let dispH = detail_noise_height(localPos, bId, octavesF);
      // uD.vsParams.x carries an optional displacement-scale multiplier
      // (PlanetMesh.params.displacementScale, default 1.0). Lets the
      // user crank up vertex relief without changing biome amplitudes.
      let dispScale = max(0.0, uD.vsParams.x);
      localPos = localPos + radialDir * (dispH * dispScale);
    }
  }

  let world  = uD.model * vec4<f32>(localPos, 1.0);
  out.worldPos = world.xyz;
  out.pos    = uS.viewProj * world;
  out.color  = in.color;
  let n4     = uD.model * vec4<f32>(in.normal, 0.0);
  out.normal = normalize(n4.xyz);
  out.uv     = in.uv;
  return out;
}

// === Phase 8 sprint 8-7: vs_planet_detail (camera-anchored patch) ===
// (spec: docs/PLANET-SCALE-TERRAIN.md §8.7)
//
// Input vertex carries (u, v) grid coords in pos.xy (range [0, 1]).
// Vertex shader rebuilds world position every frame:
//   1. Compute the camera's local tangent frame on the planet
//      (radial up, projected-world-Y north, east = up × north).
//   2. Convert (u, v) -> tangent offsets in meters using patchSize.
//   3. Place the patch vertex on the planet surface at (camera under
//      point + tangent offsets), then radial-project onto the actual
//      OBLATE SPHEROID surface (sprint 8-7c -- the previous "project
//      onto sphere" version floated the patch above the planet at
//      non-equator latitudes because polRatio compresses the planet's
//      Y axis by ~0.34% / ~22km at the poles).
//   4. Apply detail_noise_height displacement along radial.
//
// Biome colors are baked in as a WGSL const array so the vertex
// shader can output the proper biome color directly (sprint 8-7c --
// the previous gray-with-alpha-fade hack made the patch read as a
// flat gray square instead of biome-tinted terrain).
//
// Per-draw uniforms (vsParams):
//   x = patchSize (meters)
//   y = biomeId (encoded as f32, rounded)
//   z = displacementScale
//   w = maxAltitude (meters; encoder skips the draw above this)
const _PLANET_BIOME_COLORS_VS: array<vec3<f32>, 13> = array<vec3<f32>, 13>(
  vec3<f32>(0.275, 0.431, 0.671),  // 0 Marine
  vec3<f32>(0.984, 0.906, 0.624),  // 1 Hot desert
  vec3<f32>(0.710, 0.722, 0.529),  // 2 Cold desert
  vec3<f32>(0.824, 0.816, 0.510),  // 3 Savanna
  vec3<f32>(0.784, 0.839, 0.561),  // 4 Grassland
  vec3<f32>(0.714, 0.851, 0.365),  // 5 Tropical seasonal forest
  vec3<f32>(0.161, 0.737, 0.337),  // 6 Temperate deciduous forest
  vec3<f32>(0.490, 0.796, 0.208),  // 7 Tropical rainforest
  vec3<f32>(0.251, 0.612, 0.263),  // 8 Temperate rainforest
  vec3<f32>(0.376, 0.529, 0.310),  // 9 Taiga
  vec3<f32>(0.561, 0.580, 0.486),  // 10 Tundra
  vec3<f32>(0.835, 0.906, 0.922),  // 11 Glacier
  vec3<f32>(0.227, 0.471, 0.337)   // 12 Wetland
);

@vertex
fn vs_planet_detail(in: VsIn) -> VsOut {
  var out: VsOut;
  let uv = in.pos.xy;  // grid coord [0, 1]
  let planetC = uS.envPlanet.xyz;
  let planetR = uS.envPlanet.w;
  let polRatio = max(0.5, min(2.0, uS.envPlanetGeom.x));

  // Camera radial / under-camera surface point.
  let radialFromCam = uS.eye.xyz - planetC;
  let radialLen = max(length(radialFromCam), planetR + 1.0);
  let camUp = radialFromCam / radialLen;
  let camAlt = max(0.0, radialLen - planetR);

  // Local tangent frame: north = world +Y projected to horizon plane;
  // fallback to +X near the planet poles. east = up x north.
  var northRef = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(dot(camUp, northRef)) > 0.99) {
    northRef = vec3<f32>(1.0, 0.0, 0.0);
  }
  let localNorth = normalize(northRef - camUp * dot(northRef, camUp));
  let localEast  = cross(camUp, localNorth);

  // Tangent-plane offset from camera-under point.
  let patchSize = max(uD.vsParams.x, 1.0);
  let offsetEast  = (uv.x - 0.5) * patchSize;
  let offsetNorth = (uv.y - 0.5) * patchSize;
  // The camera-under point on the OBLATE SPHEROID (not sphere) -- same
  // direction as camUp, but the spheroid radius depends on direction.
  let cuY2 = camUp.y * camUp.y;
  let invPr2 = 1.0 / (polRatio * polRatio);
  let camRadiusOnSpheroid = planetR / sqrt(1.0 - cuY2 + cuY2 * invPr2);
  let cameraUnder = planetC + camUp * camRadiusOnSpheroid;
  let tangentPos  = cameraUnder + localEast * offsetEast + localNorth * offsetNorth;

  // Project onto the OBLATE SPHEROID (sprint 8-7c fix). For a point
  // along direction d at distance t from planet center, the spheroid
  // intersection is t = planetR / sqrt(dx² + dy²/pr² + dz²).
  let projDir = normalize(tangentPos - planetC);
  let pdx2 = projDir.x * projDir.x;
  let pdy2 = projDir.y * projDir.y;
  let pdz2 = projDir.z * projDir.z;
  let surfaceR = planetR / sqrt(pdx2 + pdy2 * invPr2 + pdz2);
  var surfacePos = planetC + projDir * surfaceR;

  // Detail noise displacement.
  let biomeId = u32(clamp(uD.vsParams.y + 0.5, 0.0, 12.0));
  let octF = _detail_octaves(camAlt);
  var dispH = 0.0;
  if (octF > 0.0) {
    dispH = detail_noise_height(surfacePos, biomeId, octF);
  }
  let dispScale = uD.vsParams.z;
  // Sprint 8-7d:
  //  * uD.baseColor.w carries the macro-elevation under the camera
  //    (JS samples PlanetMap.cells at the camera's lat/lon each
  //    frame). Adding it to the radial offset places the patch at
  //    the same altitude as the surrounding PlanetMesh terrain
  //    instead of bare sea level -- fixes the "patch floats below
  //    me when I'm on a mountain" / "patch floats above me when I'm
  //    in a basin" complaint.
  //  * Displacement is clamped >= 0 (positive-only) so the patch
  //    never sinks below the radial baseline. Half-negative noise
  //    used to make the patch lose the depth-test against the
  //    coarse mesh at displaced-down vertices, producing a "polka
  //    dot" artifact.
  let macroElev = uD.baseColor.w;
  let positiveH = max(dispH, 0.0) * dispScale;
  // +2m floor: tiny constant bias to win the depth-test against the
  // coarse PlanetMesh in flat regions where macroElev and positiveH
  // are both zero.
  surfacePos = surfacePos + projDir * (macroElev + positiveH + 2.0);

  // Biome color + simple Lambert lighting against the sun direction.
  // Matches the JS-side baked lighting in _buildPlanetMesh so the
  // patch reads at the same illumination as the surrounding coarse
  // mesh.
  let biomeColor = _PLANET_BIOME_COLORS_VS[biomeId];
  let sunDir = uS.envSun.xyz;
  let ambient = 0.18;
  let lambert = max(ambient, dot(projDir, sunDir));

  out.worldPos = surfacePos;
  out.pos = uS.viewProj * vec4<f32>(surfacePos, 1.0);
  out.color = biomeColor * lambert;
  out.normal = projDir;
  out.uv = vec2<f32>(f32(biomeId), 0.0);
  return out;
}

// === Sprint 9-2c: vs_planet_cdlod (Strugar CDLOD vertex morphing) ===
// Per-vertex morph between this LOD's position (highPos) and the
// parent LOD's emulated position (lowPos, computed JS-side as the
// bilinear interp of even-grid neighbors). The morph factor goes
// 0→1 over the outer half of this chunk's LOD range so adjacent
// chunks at different LODs meet at identical positions on their
// shared edge -- no cracks, no skirts needed.
//
// Vertex layout (14 floats, stride 56):
//   loc 0: pos.xyz     -- highPos (this LOD's vertex world position)
//   loc 1: color.rgb   -- vertex-baked Lambert
//   loc 2: normal.xyz  -- oblate-spheroid surface normal
//   loc 3: uv.xy       -- x = biomeId (for fs biome routing),
//                         y = morphLow (this chunk's split distance)
//   loc 4: lowPos.xyz  -- parent-LOD-emulated vertex position
//
// Morph formula (Strugar 2010):
//   morph = clamp((dist - morphLow) / morphLow * 2 - 1, 0, 1)
// At dist = morphLow (close): morph = -1 → 0. No morph.
// At dist = 1.5 * morphLow:    morph = 0. Still no morph.
// At dist = 2 * morphLow:      morph = 1. Fully morphed → snap to parent.
// Parent's split distance is exactly 2*morphLow (chunkEdge doubles
// at every LOD step), so at the moment the parent takes over the
// child has finished morphing -- no pop.
struct VsInCDLOD {
  @location(0) pos:    vec3<f32>,
  @location(1) color:  vec3<f32>,
  @location(2) normal: vec3<f32>,
  @location(3) uv:     vec2<f32>,
  @location(4) lowPos: vec3<f32>
};
@vertex
fn vs_planet_cdlod(in: VsInCDLOD) -> VsOut {
  var out: VsOut;
  // Sprint 9-3: uD.model carries mv_rtc = view * translate(anchorF64),
  // composed JS-side in f64 so the catastrophic (anchor - camera)
  // subtraction happens before f32 downcast. in.pos is anchor-relative
  // (small magnitude) so uD.model * in.pos yields a VIEW-SPACE position
  // directly. Distance to camera = length(viewSpacePos) since rotation
  // preserves length. Output projection uses proj-only (uS.proj).
  //
  // Sprint 9-4-fix: out.worldPos must be in WORLD space (fragments
  // sample biome textures triplanar against it, run atmosphere height
  // math, etc.). Writing viewSpacePos to worldPos made the textures
  // slide with the camera (water-like effect) and the atmosphere
  // render as a translucent shell inside the planet. Recover world
  // coords by adding the f32 anchor approximation (uD.vsParams.xyz):
  // world = anchor + local. This loses sub-meter precision at Earth
  // radius, which is fine for the consumers; the precision-critical
  // path (clip-space output) still uses the f64-composed mv_rtc.
  let highView4 = uD.model * vec4<f32>(in.pos,    1.0);
  let lowView4  = uD.model * vec4<f32>(in.lowPos, 1.0);
  let highPos = highView4.xyz;
  let lowPos  = lowView4.xyz;

  let dist = length(highPos);  // world distance to camera (rotation-invariant)
  let morphLow = in.uv.y;
  var morph: f32 = 0.0;
  if (morphLow > 0.0) {
    morph = clamp((dist - morphLow) / morphLow * 2.0 - 1.0, 0.0, 1.0);
  }
  let morphedPos   = mix(highPos, lowPos, morph);
  let morphedLocal = mix(in.pos,  in.lowPos, morph);

  let anchorF32 = uD.vsParams.xyz;
  out.worldPos = anchorF32 + morphedLocal;
  out.pos = uS.proj * vec4<f32>(morphedPos, 1.0);
  out.color = in.color;
  // Normal: in.normal is already world-oriented (the oblate-spheroid
  // surface normal computed JS-side). Translation doesn't affect a
  // direction, so we just pass it through normalized. (Previously
  // ran in.normal through uD.model, which rotated it into view space
  // and gave fragments a wrong normal -- contributed to the broken
  // sun lighting on the surface.)
  out.normal = normalize(in.normal);
  out.uv = in.uv;
  return out;
}

// Phase 7 §5.5.h-25 -- vs_horizon. Same VsOut shape as vs_main, but
// applies a planet-curvature Y warp to each vertex based on the
// camera's altitude. At low altitude the warp factor is 0 (flat
// world); as the camera flies up past altLow, the factor ramps to
// 1 over [altLow, altHigh], at which point distant vertices drop
// by  d * d / (2R)  where d = horizontal distance from the camera
// and R is the planet radius. From up high the horizon impostor
// curves off into a sphere section, giving a planet look.
//   band1.x = altLow  (no curve below this camera Y)
//   band1.y = altHigh (full curve above this camera Y)
//   band1.z = planetRadius
//   band1.w = unused
@vertex
fn vs_horizon(in: VsIn) -> VsOut {
  var out: VsOut;
  let world4 = uD.model * vec4<f32>(in.pos, 1.0);
  let altLow  = uD.band1.x;
  let altHigh = max(altLow + 1.0, uD.band1.y);
  let R       = max(1000.0, uD.band1.z);
  let camY    = uS.eye.y;
  let t = clamp((camY - altLow) / (altHigh - altLow), 0.0, 1.0);
  let curvature = t * t * (3.0 - 2.0 * t);     // smoothstep
  let dxz = world4.xz - uS.eye.xz;
  let d2  = dot(dxz, dxz);
  let yDrop = (d2 / (2.0 * R)) * curvature;
  let warped = vec4<f32>(world4.x, world4.y - yDrop, world4.z, 1.0);
  out.worldPos = warped.xyz;
  out.pos    = uS.viewProj * warped;
  out.color  = in.color;
  let n4     = uD.model * vec4<f32>(in.normal, 0.0);
  out.normal = normalize(n4.xyz);
  out.uv     = in.uv;
  return out;
}

// Phase 7 §5.5.c-3 -- vs_terrain. Samples the heightmap texture
// (the bound scratch texture array at the layer vsParams.w
// occupies) for per-vertex Y displacement, and recomputes the
// surface normal via central-difference of texel neighbors. The
// fragment side sees this through the standard VsOut interface
// (worldPos / normal / uv) so any fragment shader (Phong, PBR,
// Unlit, Terrain) works on top -- the pipeline cache pairs
// vs_terrain with whichever fragment entry the material picks.
//
// textureLoad (not textureSample) since:
//   1. WebGPU restricts vertex shaders from using filtering
//      samplers (the binding 3 sampler is filterable).
//   2. We want exact texel reads for the finite-difference
//      normal computation anyway.
@vertex
fn vs_terrain(in: VsIn) -> VsOut {
  var out: VsOut;
  let layer     = i32(uD.vsParams.w);
  let hScale    = uD.vsParams.x;
  let worldSize = max(uD.vsParams.y, 0.0001);

  let dims  = vec2<i32>(textureDimensions(srcTexture));
  let dimsF = vec2<f32>(dims);

  // Clamp UV to [0, 1] then map to texel coords. Read center +
  // four cardinal neighbors with one-texel offset for the
  // finite-difference normal.
  let uvC = clamp(in.uv, vec2<f32>(0.0), vec2<f32>(1.0));
  let cC  = vec2<i32>(clamp(uvC * dimsF, vec2<f32>(0.0), dimsF - vec2<f32>(1.0)));
  let cL  = vec2<i32>(max(cC.x - 1, 0),         cC.y);
  let cR  = vec2<i32>(min(cC.x + 1, dims.x - 1), cC.y);
  let cD  = vec2<i32>(cC.x, max(cC.y - 1, 0));
  let cU  = vec2<i32>(cC.x, min(cC.y + 1, dims.y - 1));

  let hC = textureLoad(srcTexture, cC, layer, 0).r;
  let hL = textureLoad(srcTexture, cL, layer, 0).r;
  let hR = textureLoad(srcTexture, cR, layer, 0).r;
  let hD = textureLoad(srcTexture, cD, layer, 0).r;
  let hU = textureLoad(srcTexture, cU, layer, 0).r;

  // World units per texel = worldSize / textureDimension. Tangent
  // along X is (worldDx, dydx, 0); along Z is (0, dydz, worldDz);
  // cross(tangent_z, tangent_x) gives the up-pointing normal.
  let worldDx = worldSize / dimsF.x;
  let worldDz = worldSize / dimsF.y;
  let dydx = (hR - hL) * hScale * 0.5 / worldDx;
  let dydz = (hU - hD) * hScale * 0.5 / worldDz;
  let nLocal = normalize(vec3<f32>(-dydx, 1.0, -dydz));

  // Y-displace by sampled height. (hC - 1) keeps the same Y
  // convention as the CPU-build path: peaks (hC=1) land at the
  // mesh baseline (in.pos.y = yOffset), valleys (hC=0) descend
  // to in.pos.y - heightScale. Matches §5.5.a's "peaks at horizon"
  // default so the wired-up version looks the same as the
  // unwired CPU mode.
  let displaced = vec3<f32>(in.pos.x, in.pos.y + (hC - 1.0) * hScale, in.pos.z);
  let world     = uD.model * vec4<f32>(displaced, 1.0);
  let n4        = uD.model * vec4<f32>(nLocal, 0.0);

  out.worldPos = world.xyz;
  out.pos      = uS.viewProj * world;
  out.color    = in.color;
  out.normal   = normalize(n4.xyz);
  out.uv       = in.uv;
  return out;
}

// Legacy unlit-vertex-color fallback. Default fragment when no
// material is wired on a mesh-gen primitive -- preserves the
// "you get colors immediately" behavior from sprints a + b.
//
// 2026-05-21 Sprint 7.6.a-atm -- when a planet is wired
// (envPlanet.w > 0) the planet's lit surface gets AERIAL
// PERSPECTIVE applied: in-scatter from camera to fragment is
// added to the surface color. This is what makes the planet
// look like it has an ATMOSPHERE ON IT (blue haze near horizon,
// gentle blue tint on distant ground, integrated limb glow that
// flows from the planet body into the sky -- not a sharp
// silhouette with separate sky-glow).
@fragment
fn fs_unlit_vc(in: VsOut) -> @location(0) vec4<f32> {
  if (uS.envPlanet.w > 0.0) {
    // Sprint 7.6.b-atm Tier-C.0 -- correct aerial perspective:
    // surface_color * transmittance + in_scatter. The transmittance
    // term is what was missing in v2 -- without it the planet body's
    // base color sat on top of any scattering, creating the visible
    // gap at the silhouette the user reported. With per-channel
    // Beer-Lambert transmittance, grazing-angle fragments fade
    // through warm-tinted color and finally into pure atmospheric
    // scattering at the limb, matching the sky-pass color smoothly.
    // C.5 -- aerial-perspective LUT replaces the per-pixel integrator.
    // One trilinear lookup (two textureSampleLevel + manual lerp
    // across adjacent depth slices) instead of 16+16 samples per
    // pixel. The mono transmittance loses wavelength-dependent
    // wash-out (warm sunset hue on distant ground) until C.6 splits
    // the transmittance into a second LUT.
    let ap = sample_aerial_perspective_lut(uS.eye.xyz, in.worldPos);
    // === Phase 8 sprint 8-3 + extras ===
    // (spec: docs/PLANET-SCALE-TERRAIN.md §8.5 fragment-path)
    //
    // Per-biome rendering:
    //   * Marine (bId == 0) -- water shading via Fresnel-mixed sky
    //     reflection (sample_skyview_lut on the reflection vector)
    //     over a deep-blue base; sprint 8-3 polish replaces the flat
    //     biome-color blue that read as "painted on" with a real
    //     reflective surface.
    //   * Land biomes -- macro-scale color variation (~100km
    //     patches, visible from orbit) breaks up the flat biome
    //     palette; per-biome detail_noise brightness modulation as
    //     before; normal perturbation from the detail_noise gradient
    //     adds real-time bump lighting on top of the baked Lambert.
    let bId = u32(clamp(round(in.uv.x), 0.0, 12.0));
    let _altitude_m = max(0.0, length(uS.eye.xyz - uS.envPlanet.xyz) - uS.envPlanet.w);
    let _max_oct    = _detail_octaves(_altitude_m);
    var color = in.color;

    let texScale = uD.planetExtra.z;
    let texMix   = uD.planetExtra.w;
    if (bId == 0u) {
      // Marine cell -- water shading. Schlick Fresnel weighted mix
      // between deep-blue subsurface and the sky-view LUT reflected
      // through the surface normal. At normal incidence we read
      // ~2% reflectance (water IOR ~1.33); at grazing angles the
      // Fresnel term ramps to 1.0 and the surface acts like a mirror.
      let surfN = normalize(in.normal);
      let viewDir = normalize(uS.eye.xyz - in.worldPos);
      let cosVN = max(dot(viewDir, surfN), 0.0);
      let fresnel = pow(1.0 - cosVN, 5.0);
      let f0 = 0.02;
      let reflectance = f0 + (1.0 - f0) * fresnel;
      let reflectDir = reflect(-viewDir, surfN);
      let skyRefl = sample_skyview_lut(reflectDir);
      // Deep-blue base. Slightly darker than the flat biome blue so
      // the Fresnel-mixed reflection reads more strongly.
      var waterBase = vec3<f32>(0.04, 0.14, 0.24);
      // Phase 8 sprint 8-3b: if a waterTexture is wired, mix it into
      // the subsurface base before Fresnel. texMix controls strength;
      // texture is triplanar-sampled in world space.
      let waterTexLayer = i32(uD.planetExtra.y);
      if (waterTexLayer >= 0) {
        let tex = triplanar_sample_array(srcTexture, srcSampler,
                    u32(waterTexLayer), in.worldPos, surfN,
                    texScale, 4.0);
        waterBase = mix(waterBase, tex.rgb, texMix);
      }
      color = mix(waterBase, skyRefl, clamp(reflectance, 0.0, 1.0));
    } else {
      // Land biome. Sprint 10-1d / 10-2 RIP-OUT: per-pixel noise
      // color modulation + procedural texture styles + bump
      // perturbation REMOVED.
      let surfN = normalize(in.normal);
      // Sprint 10-5c-c/g: SVT sample. Tries to fetch a pre-baked
      // albedo + tangent-space normal from the atlas. If the page
      // is resident:
      //   - blend SVT albedo over vertex color
      //   - transform tangent-space normal to world space (via
      //     east/north tangent basis on the sphere)
      //   - re-light: divide out the baked vertex lambert, apply
      //     the perturbed-normal lambert. Result: visible bump
      //     shading without changing the rest of the lighting pipeline.
      let planetCenter2 = uS.envPlanet.xyz;
      let planetR2      = uS.envPlanet.w;
      let radial2       = in.worldPos - planetCenter2;
      let radLen2       = length(radial2);
      let svtDir        = radial2 / max(radLen2, 1.0);
      let svtSample     = _svt_sample(svtDir);
      if (svtSample.resident > 0.5) {
        // Albedo blend.
        color = mix(color, svtSample.albedo, 0.80);
        // Build tangent basis on the sphere surface. East = (-sinLon,
        // 0, cosLon) handling our east-west flip convention. Up =
        // radial (surfN). North = up × east.
        let latR  = asin(clamp(svtDir.y, -1.0, 1.0));
        let lonR  = -atan2(svtDir.z, svtDir.x);   // 10-6 east-west flip
        let east  = vec3<f32>(-sin(lonR), 0.0, cos(lonR));
        let upR   = svtDir;
        let north = normalize(cross(upR, east));
        let eastN = normalize(cross(north, upR));
        // Transform tangent-space normal (x=east, y=north, z=up).
        let tn = svtSample.normal;
        let worldN = normalize(eastN * tn.x + north * tn.y + upR * tn.z);
        // Recompute lambert with perturbed normal vs baked one.
        let sunDir = uS.envSun.xyz;
        let perturbLambert = max(0.18, dot(worldN, sunDir));
        let baseLambert    = max(0.18, dot(upR, sunDir));
        // Scale color by ratio. Clamped so dark areas don't blow out.
        color = color * clamp(perturbLambert / baseLambert, 0.6, 1.4);
        // Sprint 10-5c-h: PBR specular term layered on top. Uses the
        // SVT material atlas (roughness + metallic) and the perturbed
        // surface normal. Specular highlight reads as a glint where
        // the sun reflects toward the camera through the half-vector.
        // AO multiplied into the diffuse component (darkens corners).
        let viewDir = normalize(uS.eye.xyz - in.worldPos);
        let spec = _pbr_specular(worldN, viewDir, sunDir,
                                  svtSample.albedo,
                                  svtSample.roughness,
                                  svtSample.metallic);
        // Scaled down so spec stays subtle on natural terrain. PBR
        // peak can be very bright; clamp keeps it grounded.
        let specStrength = 0.6;
        color = color * svtSample.ao + spec * perturbLambert * specStrength;
      }
      let landTexLayer = i32(uD.planetExtra.x);
      if (landTexLayer >= 0) {
        let tex = triplanar_sample_array(srcTexture, srcSampler,
                    u32(landTexLayer), in.worldPos, surfN,
                    texScale, 4.0);
        let tinted = tex.rgb * color * 2.0;
        color = mix(color, tinted, texMix);
      }
      // §bonus-perf-foot (2026-05-25) -- the procedural detail-noise
      // + climate-blend texture blocks below are the FALLBACK for
      // pixels where SVT didn't catch up. When SVT IS resident, the
      // atlas already encodes biome color + per-texel bump detail +
      // PBR material, and re-running this work on top is the
      // foot-level perf bottleneck (~12 noise calls + ~10 exp/pow
      // per pixel). Gate on svtSample.resident so:
      //   resident=1 (steady state): skip both blocks entirely
      //   resident=0 (chunk just entered view, pages streaming):
      //                run the full procedural so the surface
      //                stays detailed during the brief load window.
      // §bonus-perf-foot-7 RESULT (2026-05-25): user data showed
      // fps unchanged at 9.2 with this block fully skipped. Per-
      // fragment procedural is NOT the bottleneck. Reverted to
      // original gate; cost is elsewhere (suspect: rasterizer
      // efficiency on the 1100+ tiny chunks at foot, see foot-8).
      if (svtSample.resident < 0.5) {
        // §revert-suppression (2026-05-25) -- multi-scale detail
        // restored to 4 octaves (was cut to 2 chasing the 9 fps
        // bug; foot-7 binary diag proved fragment cost wasn't it).
        let camDistL = length(uS.eye.xyz - in.worldPos);
        let macroFade = 1.0 - smoothstep(500.0,  2000.0, camDistL);
        let midFade   = 1.0 - smoothstep(150.0,   500.0, camDistL);
        let nearFade  = 1.0 - smoothstep(50.0,    200.0, camDistL);
        let microFade = 1.0 - smoothstep(15.0,     50.0, camDistL);
        if (macroFade > 0.001) {
          let n1 = _value_noise_3d(in.worldPos * 0.02)  - 0.5;
          let n2 = _value_noise_3d(in.worldPos * 0.125) - 0.5;
          let n3 = _value_noise_3d(in.worldPos * 0.66)  - 0.5;
          let n4 = _value_noise_3d(in.worldPos * 3.30)  - 0.5;
          let det =  n1 * 0.03 * macroFade
                   + n2 * 0.05 * midFade
                   + n3 * 0.06 * nearFade
                   + n4 * 0.07 * microFade;
          color = color * (1.0 + det);
        }
        if (midFade > 0.001) {
          let planetCenter = uS.envPlanet.xyz;
          let planetRrad   = uS.envPlanet.w;
          let radialVec = in.worldPos - planetCenter;
          let radLen    = length(radialVec);
          let radDir    = radialVec / max(radLen, 1.0);
          let _absLat = abs(degrees(asin(clamp(radDir.y, -1.0, 1.0))));
          let _elevMSL = max(0.0, radLen - planetRrad);
          let _Tbase = 30.0 * cos(radians(_absLat)) - 5.0;
          let _T     = _Tbase - 6.5 * (_elevMSL / 1000.0);
          var _P: f32 = 0.45;
          _P = _P + 0.45 * exp(-pow((_absLat -  0.0) / 12.0, 2.0));
          _P = _P - 0.35 * exp(-pow((_absLat - 25.0) / 10.0, 2.0));
          _P = _P + 0.25 * exp(-pow((_absLat - 55.0) / 12.0, 2.0));
          _P = _P - 0.30 * exp(-pow((_absLat - 80.0) / 12.0, 2.0));
          _P = clamp(_P, 0.0, 1.0);
          let snowLineAlt = select(select(1500.0, 3000.0, _T > 0.0), 4500.0, _T > 10.0);
          let snowW = clamp((-_T) / 10.0 + max(0.0, (_elevMSL - snowLineAlt) / 1500.0), 0.0, 1.0);
          let sandW = clamp((_T - 18.0) / 6.0, 0.0, 1.0) * clamp((0.30 - _P) / 0.10, 0.0, 1.0);
          let rockW = clamp((_elevMSL - 2000.0) / 1500.0, 0.0, 1.0);
          let grassW = max(0.0, 1.0 - snowW - sandW - rockW);
          // §revert-suppression -- 4-way weighted blend restored
          // (was dominant-only pick in foot-6). Smooth transitions
          // between biomes rather than crisp boundaries.
          let tg = _surface_tex_grass(in.worldPos);
          let tr = _surface_tex_rock(in.worldPos);
          let ts = _surface_tex_sand(in.worldPos);
          let tw = _surface_tex_snow(in.worldPos);
          let texW = tg * grassW + tr * rockW + ts * sandW + tw * snowW;
          color = color * mix(vec3<f32>(1.0), texW, midFade);
        }
      }
    }

    let col = color * ap.transmittance + ap.inScatter;
    return vec4<f32>(tonemap_aces(col), 1.0);
  }
  return vec4<f32>(in.color, 1.0);
}

// UnlitMat: solid material color, optionally mixed with vertex color
// via baseColor.a. Default state (a=0) is pure material color.
@fragment
fn fs_unlit(in: VsOut) -> @location(0) vec4<f32> {
  let c = mix(uD.baseColor.rgb, in.color, uD.baseColor.a);
  return vec4<f32>(c, 1.0);
}

// Evaluate light i at a world-space surface point. Returns
// (xyz = unit direction TOWARD the light, w = combined attenuation).
//
//   directional (type 0): w = 1 always, direction = pos.xyz
//   point       (type 1): quadratic distance falloff over params.x range
//   spot        (type 2): point + cone factor smoothstep'd between
//                         params.y (cos inner) and params.z (cos outer)
fn _eval_light_i(idx: u32, worldPos: vec3<f32>) -> vec4<f32> {
  let L = uS.lights[idx];
  let typ = L.pos.w;
  if (typ < 0.5) {
    return vec4<f32>(normalize(L.pos.xyz), 1.0);
  }
  // Point + spot share the world-position math.
  let toLight = L.pos.xyz - worldPos;
  let dist = length(toLight);
  let range = max(0.001, L.params.x);
  let distFalloff = clamp(1.0 - dist / range, 0.0, 1.0);
  let dir = toLight / max(dist, 0.001);
  if (typ < 1.5) {
    return vec4<f32>(dir, distFalloff * distFalloff);
  }
  // Spot light: additional cone-angle smoothstep. spotDir is the
  // direction the spot is POINTING (away from the source toward the
  // illuminated area); we need the angle between -dir and spotDir.
  let spotDir = normalize(L.spotDir.xyz);
  let cosAngle = dot(-dir, spotDir);
  let cosInner = L.params.y;
  let cosOuter = L.params.z;
  let coneFalloff = clamp((cosAngle - cosOuter) / max(0.0001, cosInner - cosOuter), 0.0, 1.0);
  return vec4<f32>(dir, distFalloff * distFalloff * coneFalloff);
}

// PhongMat fragment: loop over enabled lights + sum each light's
// (diffuse + specular) contribution scaled by attenuation. ambient
// applied once at the end so multi-light scenes don't blow out.
@fragment
fn fs_phong(in: VsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let v = normalize(uS.eye.xyz - in.worldPos);
  let shin   = max(1.0, uD.matParams.x);
  let amb    = clamp(uD.matParams.y, 0.0, 1.0);
  let albedo = mix(uD.baseColor.rgb, in.color, uD.baseColor.a);
  let nLights = u32(uS.lightCount.x);

  var lit: vec3<f32> = albedo * amb;     // ambient base
  for (var i: u32 = 0u; i < nLights; i = i + 1u) {
    let L     = uS.lights[i];
    let info  = _eval_light_i(i, in.worldPos);
    let l     = info.xyz;
    let atten = info.w;
    let h     = normalize(l + v);
    let nDotL = max(dot(n, l), 0.0);
    let spec  = pow(max(dot(n, h), 0.0), shin) * step(0.001, nDotL);
    let li    = L.color.rgb * L.color.w;
    lit = lit + albedo * nDotL * (1.0 - amb) * atten * li
              + vec3<f32>(spec) * atten * li * 0.6;
  }
  // 7.5.4.e -- fog + tonemap, matches fs_pbr.
  let fogged = apply_fog(lit, in.worldPos);
  // 2026-05-21 Sprint 7.6.b-atm Tier-C.0 -- correct aerial
  // perspective with transmittance. See fs_unlit_vc for the
  // motivation; the formula matches: surface * T + in_scatter.
  var withAtm = fogged;
  if (uS.envPlanet.w > 0.0) {
    // C.5 -- LUT lookup instead of per-pixel atmosphere integration.
    let ap = sample_aerial_perspective_lut(uS.eye.xyz, in.worldPos);
    withAtm = withAtm * ap.transmittance + ap.inScatter;
  }
  return vec4<f32>(tonemap_aces(withAtm), 1.0);
}

// Phase 7 §5.5.h-3 -- terrain noise helpers, JS-mirror in WGSL.
// Each function shadows its JS namesake exactly so shore foam
// lines up with the rendered terrain mesh edge. Explicit type
// literals throughout to avoid any abstract-int / abstract-float
// inference surprise.
// §5.5.h-7 -- bit-identical to JS _terrainHash. i32 multiply +
// XOR + shift, no sin(). Now the water shader's noise matches the
// mesh build's noise EXACTLY at any world coord.
fn _tw_hash(ix: i32, iy: i32, seed: f32) -> f32 {
  // Must mirror _terrainHash(...) in JS bit-for-bit. Use u32 shifts so the
  // right-shift is logical (zero-fill) -- WGSL right-shift on i32 is
  // arithmetic (sign-extending), which caps the output range at [0, 0.5).
  let ss: i32 = i32(floor(seed * 1000.0));
  var h: u32 = bitcast<u32>((ix * 374761393) ^ (iy * 668265263) ^ (ss * 2147483647));
  h = h ^ (h >> 13u);
  h = h * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}
fn _tw_valueNoise(p: vec2<f32>, seed: f32) -> f32 {
  let i = floor(p);
  let fr = p - i;
  let ix: i32 = i32(i.x);
  let iy: i32 = i32(i.y);
  let a = _tw_hash(ix,     iy,     seed);
  let b = _tw_hash(ix + 1, iy,     seed);
  let c = _tw_hash(ix,     iy + 1, seed);
  let d = _tw_hash(ix + 1, iy + 1, seed);
  // §planet-spec Phase 3 -- quintic interpolation matches the JS
  // _terrainValueNoise. C2 continuous; kills second-derivative seams
  // at lattice cell boundaries.
  let s = fr * fr * fr * (fr * (fr * vec2<f32>(6.0) - vec2<f32>(15.0)) + vec2<f32>(10.0));
  let ab = a + (b - a) * s.x;
  let cd = c + (d - c) * s.x;
  return ab + (cd - ab) * s.y;
}
// §planet-spec Phase 3 -- continuous octave count. Caller passes
// octavesF as f32 (not i32 like before); fractional values fade
// the last octave in by their fractional amount so LOD transitions
// stop popping. octavesF == 5.0 reproduces the legacy 5-octave fBm
// behavior exactly. Mirrors the JS _terrainFBM.
fn _tw_baseHeight(wx: f32, wz: f32, freq: f32, octavesF: f32, lac: f32, gain: f32, ridges: f32, seed: f32, plateau: f32) -> f32 {
  var p = vec2<f32>(wx, wz) * max(0.001, freq);
  var amp: f32 = 1.0;
  var sum: f32 = 0.0;
  var maxAmp: f32 = 0.0;
  let r = clamp(ridges, 0.0, 1.0);
  let totalOctF: f32 = clamp(octavesF, 0.0, 20.0);
  let fullOcts: i32 = i32(floor(totalOctF));
  let frac: f32   = totalOctF - f32(fullOcts);
  for (var ii: i32 = 0; ii < fullOcts; ii = ii + 1) {
    var s = _tw_valueNoise(p, seed);
    let ridge = 1.0 - abs(2.0 * s - 1.0);
    s = s * (1.0 - r) + ridge * ridge * r;
    sum = sum + s * amp;
    maxAmp = maxAmp + amp;
    p = p * lac;
    amp = amp * gain;
  }
  if (frac > 0.0) {
    var s = _tw_valueNoise(p, seed);
    let ridge = 1.0 - abs(2.0 * s - 1.0);
    s = s * (1.0 - r) + ridge * ridge * r;
    sum = sum + s * amp * frac;
    maxAmp = maxAmp + amp * frac;
  }
  var h = clamp(sum / max(1e-6, maxAmp), 0.0, 1.0);
  if (plateau > 0.001) {
    let k = 1.0 + clamp(plateau, 0.0, 1.0) * 4.0;
    h = pow(clamp(h, 0.0, 1.0), k);
  }
  return h;
}
// §5.5.h-21 -- 4-octave fbm matched bit-for-bit with the JS-side
// Clouds3D mesh build (_terrainValueNoise + the same 4-octave loop).
// Used by fs_water to project water pixels up along the sun ray
// and sample cloud density for shadow. Returns 0..1; threshold the
// result against (1 - coverage) to get a binary in-cloud mask.
fn _tw_cloudDensity(wx: f32, wz: f32, scale: f32, seed: f32) -> f32 {
  var n: f32 = 0.0;
  var amp: f32 = 0.5;
  var freq: f32 = 1.0;
  var maxAmp: f32 = 0.0;
  for (var oct: i32 = 0; oct < 4; oct = oct + 1) {
    n = n + amp * _tw_valueNoise(vec2<f32>(wx * scale * freq, wz * scale * freq), seed + f32(oct) * 3.7);
    maxAmp = maxAmp + amp;
    amp  = amp  * 0.55;
    freq = freq * 2.07;
  }
  return n / max(1e-6, maxAmp);
}

fn _tw_islandLand(wx: f32, wz: f32, maskFreq: f32, maskSeed: f32, threshold: f32, softness: f32) -> f32 {
  let m = _tw_valueNoise(vec2<f32>(wx, wz) * maskFreq, maskSeed);
  let lo = threshold - softness;
  let hi = threshold + softness;
  let u = clamp((m - lo) / max(1e-6, hi - lo), 0.0, 1.0);
  return u * u * (3.0 - 2.0 * u);
}

// Phase 7 §5.5.h-4 -- LOD-matched terrain sampling. The TiledTerrain
// mesh is discretized at chunkSize / lodSegs (e.g. 128m vertex
// spacing in the outer LOD ring). Sampling exact noise in the
// water shader gives a smooth curve that doesn't align with the
// visible mesh edge -- the foam line drifts away from the actual
// island shore. Fix: snap to the same grid the mesh uses and
// bilinear-interp the 4 corner heights. Now depth matches the
// rendered terrain pixel-for-pixel.
fn _tw_lodSegs(dxAbs: i32, dzAbs: i32, radius: i32, baseSegs: i32) -> i32 {
  let ring = max(dxAbs, dzAbs);
  if (radius <= 0) { return baseSegs; }
  let t = f32(ring) / f32(radius);
  if (t <= 0.20) { return baseSegs; }
  if (t <= 0.40) { return max(2, baseSegs / 2); }
  if (t <= 0.60) { return max(2, baseSegs / 4); }
  if (t <= 0.80) { return max(2, baseSegs / 8); }
  return 2;
}
fn _tw_finalY_at(wx: f32, wz: f32,
                 t_freq: f32, t_octsF: f32, t_lac: f32, t_gain: f32, t_ridges: f32,
                 t_seed: f32, t_plateau: f32, t_hs: f32, t_yOff: f32,
                 archipel: f32, t_sink: f32,
                 m_freq: f32, m_seed: f32, m_thresh: f32, m_soft: f32,
                 beachStr: f32, beachFreq: f32) -> f32 {
  let h = _tw_baseHeight(wx, wz, t_freq, t_octsF, t_lac, t_gain, t_ridges, t_seed, t_plateau);
  var ty = (h - 1.0) * t_hs + t_yOff;
  if (archipel > 0.5) {
    let landAmt = _tw_islandLand(wx, wz, m_freq, m_seed, m_thresh, m_soft);
    // §5.5.h-11 coastal peak squash. Mirror of JS _tiledFinalY: scale
    // above-sea-level elevation by landAmt^2 so peaks only emerge
    // well inland. Keeps the water shader's shore-detect aligned
    // with the rendered mesh.
    if (ty > t_yOff) {
      let peakAmt = landAmt * landAmt;
      ty = t_yOff + (ty - t_yOff) * peakAmt;
    }
    // §5.5.h-9 beach band -- mirror of the JS _tiledFinalY beach
    // blend so the water shader's shore detect samples the same
    // flattened beach elevation the rendered mesh shows.
    if (beachStr > 0.0 && landAmt > 0.0 && landAmt < 0.95) {
      let bn = _tw_valueNoise(vec2<f32>(wx, wz) * beachFreq, m_seed + 17.3);
      let coastal = min(1.0, landAmt / 0.5) * min(1.0, (0.95 - landAmt) / 0.4);
      let beachy = max(0.0, (bn - 0.45) / 0.25);
      let blend = min(1.0, coastal * beachy * beachStr);
      let beachY = t_yOff + 4.0;
      ty = ty * (1.0 - blend) + beachY * blend;
    }
    let seaFloor = t_yOff - t_sink;
    ty = ty * landAmt + seaFloor * (1.0 - landAmt);
  }
  return ty;
}

// Phase 7 §5.5.h -- fs_water. Animated wave normals + Fresnel sky
// mix + shore detect from terrain sampling. Per-draw layout:
//   baseColor.rgb = water color, baseColor.a = fresnelStrength
//   matParams    = (seaLevel, waveFreq, waveSpeed, waveAmp)
//   band1.rgba   = (skyR, skyG, skyB, time)
//   band2.rgba   = (noiseSeed, noiseFreq, noiseOctaves, plateau)
//   band3.rgba   = (lacunarity, gain, ridges, heightScale)
//   band4.rgba   = (yOffset, sinkDepth, archipelagoFlag, islandMaskFreq)
//   vsParams     = (islandMaskSeed, threshold, softness, foamWidth)
//   detailParams = (shallowDepth, waveShoreFreq, foamR, foamG)
//   bumpParams   = (foamB, _, _, _)
@fragment
fn fs_water(in: VsOut) -> @location(0) vec4<f32> {
  let waterColor = uD.baseColor.rgb;
  let fresnelStr = max(0.0, uD.baseColor.a);
  let seaLevel   = uD.matParams.x;
  let waveFreq   = max(0.00001, uD.matParams.y);
  let waveSpeed  = uD.matParams.z;
  let waveAmp    = max(0.0, uD.matParams.w);
  let skyColor   = uD.band1.rgb;
  let t          = uD.band1.w;
  // Terrain noise params (auto-pulled from patch's TiledTerrain by encoder).
  let t_seed     = uD.band2.x;
  let t_freq     = uD.band2.y;
  // §planet-spec Phase 3 -- continuous octave count (was i32 cast).
  let t_octsF    = uD.band2.z;
  let t_plateau  = uD.band2.w;
  let t_lac      = uD.band3.x;
  let t_gain     = uD.band3.y;
  let t_ridges   = uD.band3.z;
  let t_hs       = uD.band3.w;
  let t_yOff     = uD.band4.x;
  let t_sink     = uD.band4.y;
  let archipel   = uD.band4.z;        // 1.0 = archipelago, 0.0 = no island mask
  let m_freq     = uD.band4.w;
  let m_seed     = uD.vsParams.x;
  let m_thresh   = uD.vsParams.y;
  let m_soft     = uD.vsParams.z;
  let foamWidth  = max(0.001, uD.vsParams.w);
  let shallowDp  = max(0.001, uD.detailParams.x);
  let waveShoreF = uD.detailParams.y;
  let foamColor  = vec3<f32>(uD.detailParams.z, uD.detailParams.w, uD.bumpParams.x);

  let wp = in.worldPos;

  // ---- Terrain height under this water fragment ----
  // §5.5.h-4 -- LOD-matched bilinear sample. The water shader needs
  // to see the EXACT same height the rendered mesh shows or the
  // foam line drifts off the visible shore. Snap to the LOD grid
  // for this fragment's chunk (LOD picked by Chebyshev distance
  // from the camera tile, matching _tiledTerrainLodSegments
  // formula), then bilinear-interp the 4 corners.
  let chunkSize  = uD.bumpParams.y;
  let baseSegsP  = i32(uD.bumpParams.z);
  let chunkRadP  = i32(uD.bumpParams.w);
  var depth: f32 = 1000.0;   // open-ocean fallback when terrain unconfigured
  if (t_hs > 0.001 && t_freq > 0.0000001 && chunkSize > 0.001 && baseSegsP > 0) {
    // §5.5.h-5 -- use the ACTUAL disc center (with forwardBias),
    // not just the camera tile. Otherwise the LOD ring calculation
    // is off by the forwardBias shift and water foam misaligns
    // east/west of the player.
    let discTx = i32(uD.waterExtra.x);
    let discTz = i32(uD.waterExtra.y);
    // §5.5.h-9 -- beach band params from upstream TiledTerrain. Z=0
    // disables beaches; otherwise W is the beach noise freq.
    let beachStr  = uD.waterExtra.z;
    let beachFreq = uD.waterExtra.w;
    let myTx   = i32(floor(wp.x / chunkSize));
    let myTz   = i32(floor(wp.z / chunkSize));
    let segs   = _tw_lodSegs(abs(myTx - discTx), abs(myTz - discTz), max(0, chunkRadP), baseSegsP);
    let dStep = chunkSize / f32(segs);
    let gx = floor(wp.x / dStep) * dStep;
    let gz = floor(wp.z / dStep) * dStep;
    let fx = clamp((wp.x - gx) / dStep, 0.0, 1.0);
    let fz = clamp((wp.z - gz) / dStep, 0.0, 1.0);
    // §planet-spec Phase 3 -- LOD-aware octave count. Sample at the
    // SAME truncated octave count the chunked mesh used for this
    // chunk's LOD; otherwise water foam picks up high-freq detail
    // that the chunked mesh doesn't have and drifts off the shore.
    let octavesByLod = clamp(log2(1.0 / (2.0 * t_freq * dStep)), 0.0, 20.0);
    let t_octsF_lod  = min(t_octsF, octavesByLod);
    let y00 = _tw_finalY_at(gx,         gz,
                            t_freq, t_octsF_lod, t_lac, t_gain, t_ridges, t_seed, t_plateau,
                            t_hs, t_yOff, archipel, t_sink, m_freq, m_seed, m_thresh, m_soft,
                            beachStr, beachFreq);
    let y10 = _tw_finalY_at(gx + dStep, gz,
                            t_freq, t_octsF_lod, t_lac, t_gain, t_ridges, t_seed, t_plateau,
                            t_hs, t_yOff, archipel, t_sink, m_freq, m_seed, m_thresh, m_soft,
                            beachStr, beachFreq);
    let y01 = _tw_finalY_at(gx,         gz + dStep,
                            t_freq, t_octsF_lod, t_lac, t_gain, t_ridges, t_seed, t_plateau,
                            t_hs, t_yOff, archipel, t_sink, m_freq, m_seed, m_thresh, m_soft,
                            beachStr, beachFreq);
    let y11 = _tw_finalY_at(gx + dStep, gz + dStep,
                            t_freq, t_octsF_lod, t_lac, t_gain, t_ridges, t_seed, t_plateau,
                            t_hs, t_yOff, archipel, t_sink, m_freq, m_seed, m_thresh, m_soft,
                            beachStr, beachFreq);
    let terrainY = y00 * (1.0 - fx) * (1.0 - fz)
                 + y10 * fx        * (1.0 - fz)
                 + y01 * (1.0 - fx) * fz
                 + y11 * fx        * fz;
    depth = max(0.0, seaLevel - terrainY);
    // §5.5.h-7 -- distance fade removed. The new integer-bit hash
    // is bit-identical between JS and WGSL, so shader noise
    // matches mesh noise at every distance -- no more scattered
    // distant patches. Shore + shallow tint visible to the horizon.
  }

  // ---- Wave normals: multi-scale + landmass-aware drift ----
  // §5.5.h-20 -- three fBm layers (long swell, chop, fine ripple)
  // each drifting in a different direction so the surface reads as
  // a real hierarchy of motion instead of one big sloshing field.
  // Drift gets BIASED by the island mask gradient so when shore is
  // off to one side, the wave field bends TOWARD land -- waves
  // approach the beach perpendicular instead of flowing straight
  // past as if the island weren't there. Only sampled when the
  // archipelago mask is active; open-ocean patches pay nothing.
  var shoreBias = vec2<f32>(0.0);
  if (archipel > 0.5) {
    let dR = 90.0;
    let mE_ = _tw_islandLand(wp.x + dR, wp.z, m_freq, m_seed, m_thresh, m_soft);
    let mW_ = _tw_islandLand(wp.x - dR, wp.z, m_freq, m_seed, m_thresh, m_soft);
    let mN_ = _tw_islandLand(wp.x, wp.z - dR, m_freq, m_seed, m_thresh, m_soft);
    let mS_ = _tw_islandLand(wp.x, wp.z + dR, m_freq, m_seed, m_thresh, m_soft);
    let grad = vec2<f32>((mE_ - mW_) * 0.5, (mS_ - mN_) * 0.5);
    let gMag = length(grad);
    let biasAmt = clamp(gMag * 5.0, 0.0, 1.0);
    if (biasAmt > 0.0) {
      shoreBias = normalize(grad + vec2<f32>(1e-6)) * biasAmt * waveSpeed * 1.4;
    }
  }
  let driftA = vec2<f32>( t * waveSpeed * 0.6,  t * waveSpeed * 0.4) + t * shoreBias;
  let driftB = vec2<f32>(-t * waveSpeed * 0.3,  t * waveSpeed * 0.5) + t * shoreBias * 0.7;
  let driftC = vec2<f32>( t * waveSpeed * 0.9, -t * waveSpeed * 0.7) + t * shoreBias * 0.5;
  let uvA = wp.xz * waveFreq        + driftA;
  let uvB = wp.xz * waveFreq * 2.5  + driftB;
  let uvC = wp.xz * waveFreq * 6.2  + driftC;
  let eps = 0.025;
  let hC = _fbm(uvA)
         + _fbm(uvB) * 0.5
         + _fbm(uvC) * 0.28;
  let hX = _fbm(uvA + vec2<f32>(eps, 0.0))
         + _fbm(uvB + vec2<f32>(eps, 0.0)) * 0.5
         + _fbm(uvC + vec2<f32>(eps, 0.0)) * 0.28;
  let hZ = _fbm(uvA + vec2<f32>(0.0, eps))
         + _fbm(uvB + vec2<f32>(0.0, eps)) * 0.5
         + _fbm(uvC + vec2<f32>(0.0, eps)) * 0.28;
  // §5.5.h-20 -- shore amplitude fade. Wave chop tapers in shallow
  // water so the surface lies flatter near the beach (real wave
  // physics: friction with the seafloor damps amplitude before the
  // wave breaks; here we just attenuate the normal perturbation).
  let shoreAmpFade = clamp(depth / (shallowDp * 0.6), 0.25, 1.0);
  let waveAmpEff = waveAmp * shoreAmpFade;
  let dx = (hX - hC) / eps;
  let dz = (hZ - hC) / eps;
  let n = normalize(vec3<f32>(-dx * waveAmpEff, 1.0, -dz * waveAmpEff));

  let v = normalize(uS.eye.xyz - in.worldPos);

  // ---- Shore color: shallow water tints toward foam-light, depth
  // > shallowDp tints toward dark deep-blue. Smoothstep both for
  // soft gradients. ----
  let shallowAmt = 1.0 - smoothstep(0.0, shallowDp, depth);
  let deepAmt    = smoothstep(shallowDp, shallowDp * 8.0, depth);
  // Shallow shore color = water shifted toward sand-tinted teal.
  let shoreColor = vec3<f32>(0.55, 0.78, 0.74);
  let deepColor  = vec3<f32>(0.05, 0.10, 0.20);
  var bodyColor = mix(waterColor, shoreColor, shallowAmt);
  bodyColor = mix(bodyColor, deepColor, deepAmt);

  // ---- Fresnel mix with sky ----
  // §5.5.h-19 -- sample the upstream Environment (ProceduralSky /
  // HDRI / Gradient) along the reflected view ray so the water's
  // reflection actually matches what's in the sky. Falls back to
  // the static skyR/G/B params when no env is wired (mode=0).
  let cosTheta = max(0.0, dot(n, v));
  let f0 = 0.02;
  let fresnel = clamp(f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0), 0.0, 1.0);
  let depthFresnelFade = clamp(depth / (shallowDp * 0.5), 0.0, 1.0);
  let mixT = clamp(fresnel * fresnelStr * depthFresnelFade, 0.0, 1.0);
  let reflectedDir = reflect(-v, n);
  let envMode = u32(uS.envParams.x);
  var skySample: vec3<f32>;
  if (envMode == 2u) {
    // smooth-only so sun-disk doesn't double-up with the explicit
    // glint pass below; the disk lives in sample_procedural_sky.
    skySample = sample_procedural_sky_smooth(reflectedDir);
  } else if (envMode != 0u) {
    skySample = sample_env(reflectedDir);
  } else {
    skySample = skyColor;
  }
  var outRGB = mix(bodyColor, skySample, mixT);

  // §5.5.h-19 -- sun glint. Sharp Blinn-Phong highlight at the
  // half-vector. shininess=300 keeps the spot tight, sunCol is hot
  // (HDR > 1) so it survives tonemap as a bright sparkle. Modulated
  // by sun visibility (uS.envSun.w) so glint dies at night and at
  // the depth-fresnel fade so it doesn't appear on shallow shore
  // water where you can see straight to the bottom.
  let sunDir = uS.envSun.xyz;
  let sunVis = max(0.0, uS.envSun.w);
  let halfV  = normalize(sunDir + v);
  let specCos = max(0.0, dot(n, halfV));
  let specPow: f32 = 300.0;
  let spec = pow(specCos, specPow) * sunVis * 2.6 * depthFresnelFade;
  let sunCol = vec3<f32>(1.7, 1.55, 1.25);
  outRGB = outRGB + spec * sunCol;

  // ---- SHORE FOAM ----
  // Foam intensity peaks where depth < foamWidth and falls off
  // toward open water. Two layers:
  //   1. Static foam band at the shoreline (just depth-driven)
  //   2. Moving "wave crest" lines that sweep TOWARD shore as the
  //      sin wave's phase advances with t. Crests appear at integer
  //      values of (depth * waveShoreF - t * waveSpeed * 0.8).
  let depthN  = depth / foamWidth;                // 0 at shore, 1 at foamWidth deep
  let staticFoam = pow(clamp(1.0 - depthN, 0.0, 1.0), 1.5);
  let phase = depth * waveShoreF - t * waveSpeed * 1.2;
  let crest = 0.5 + 0.5 * sin(phase * 6.28318);
  // Wave-noise modulation so the crests aren't perfectly parallel.
  let crestNoise = _fbm(wp.xz * 0.04 + vec2<f32>(t * 0.3, 0.0));
  let movingFoam = pow(crest, 6.0) * (0.5 + 0.5 * crestNoise)
                   * clamp(1.0 - depthN * 1.5, 0.0, 1.0);   // only near shore
  let foamAmt = clamp(staticFoam + movingFoam, 0.0, 1.0);
  outRGB = mix(outRGB, foamColor, foamAmt);

  // §5.5.h-21 -- cloud shadows. Project this water pixel UP the sun
  // ray to the cloud altitude and sample cloud density there; if a
  // puff is overhead, darken the water + cut the sun glint. The
  // cloud params come from any Clouds3D node in the patch (packed
  // by the encoder into cloudExtra). coverage=0 disables. Skip
  // entirely when the sun is below the horizon -- nothing to cast.
  let cloudCov = uD.cloudExtra.y;
  let sunUp    = max(0.0, sunDir.y);
  if (cloudCov > 0.001 && sunUp > 0.05 && sunVis > 0.01) {
    let cloudAlt = uD.cloudExtra.x;
    let cScale   = uD.cloudExtra.z;
    let cSeed    = uD.cloudExtra.w;
    // Trace from water surface up to cloud altitude along the
    // sun direction. dx/dz are the XZ offset to the sample point.
    let tCloud = (cloudAlt - wp.y) / max(sunDir.y, 0.05);
    let cx = wp.x + sunDir.x * tCloud;
    let cz = wp.z + sunDir.z * tCloud;
    let cn = _tw_cloudDensity(cx, cz, cScale, cSeed);
    let lo = 1.0 - cloudCov;
    let shadowAmt = smoothstep(lo - 0.08, lo + 0.10, cn);
    // 0.50 max darkening keeps shadowed water still visible, just
    // overcast. Multiply on top of the existing color (shadow tints
    // toward a cooler dim variant of itself, not pure black).
    let shadowTint = vec3<f32>(0.55, 0.62, 0.74);
    let shadowMix  = mix(vec3<f32>(1.0), shadowTint, shadowAmt * 0.5);
    outRGB = outRGB * shadowMix;
  }

  let fogged = apply_fog(outRGB, in.worldPos);
  let mapped = tonemap_aces(fogged);
  // Alpha: deeper water more opaque, shallow + steep view = see-through
  let alphaBase = clamp(0.4 + 0.5 * depthFresnelFade + 0.3 * mixT, 0.3, 0.92);
  // Premultiply for the blend state (src=one, dst=one-minus-src-alpha)
  return vec4<f32>(mapped * alphaBase, alphaBase);
}

// Phase 7 §5.5.h-14 -- fs_clouds. Cloud-plane fragment shader.
// Reads world XZ from in.worldPos (the cloud plane is at a fixed
// world Y), samples two layers of fbm to give a puffy two-tone
// look, and blends against the existing framebuffer via the
// pipeline's premultiplied-alpha state. PerDraw legend:
//   baseColor.rgb = cloud color, baseColor.a = density multiplier
//   matParams     = (coverage, scale, time, _)
//   band1.xy      = (windX, windZ) -- already camera-XZ-anchored
//                   by the encoder so the noise sample tracks world
//                   coords; windX/Z continues to drift via the
//                   ProceduralSky-style wind params on the node.
// §5.5.h-17 -- fs_clouds. Reads from a CPU-built displaced cloud
// mesh (Clouds3D builder). All shape info is baked into vertex
// positions + normals; per-vertex alpha (color.r) was set by the
// builder via a smoothstep around the coverage threshold, so cloud
// edges fade softly into the sky. The shader does cheap Phong-style
// lighting + sky-color composite. No ray-marching.
//   baseColor.rgb = cloud color, baseColor.a = density multiplier
//   matParams.x   = ambient (overall fill light, 0..1)
//   matParams.y   = sunStrength (sun-dot contribution, 0..2)
@fragment
fn fs_clouds(in: VsOut) -> @location(0) vec4<f32> {
  let cloudColor  = uD.baseColor.rgb;
  let densityMult = max(0.0, uD.baseColor.a);
  let ambientK    = clamp(uD.matParams.x, 0.0, 1.0);
  let sunK        = max(0.0, uD.matParams.y);

  // Per-vertex soft-edge alpha was packed into color.r by the
  // mesh builder. Drop fragments where the cloud has fully faded
  // into a gap; gives clean sky breaks instead of polygon edges.
  let edgeAlpha = clamp(in.color.r, 0.0, 1.0);
  let alpha = clamp(edgeAlpha * densityMult, 0.0, 1.0);
  if (alpha <= 0.005) { discard; }

  // Phong-ish shading. Vertex normals were finite-differenced from
  // the displaced height field so the sides of puffs catch sun and
  // the flat tops + valleys read as different shades.
  let n = normalize(in.normal);
  let sunDir = uS.envSun.xyz;
  let sunDot = max(0.0, dot(n, sunDir)) * uS.envSun.w;
  let lit = cloudColor * (ambientK + sunDot * sunK);

  // Composite against the sky background sampled inline so the
  // shader can output opaque (alpha=1) with depth-write enabled.
  // The sky pass runs last and skips pixels with depth < 1, so
  // we'd otherwise see the Scene.clearR/G/B bleeding through any
  // translucent cloud fragments.
  let viewDir = normalize(in.worldPos - uS.eye.xyz);
  let mode = u32(uS.envParams.x);
  var bgCol: vec3<f32>;
  if (mode == 2u) {
    bgCol = sample_procedural_sky(viewDir);
  } else {
    bgCol = sample_env(viewDir);
  }
  let outRGB = mix(bgCol, lit, alpha);
  return vec4<f32>(tonemap_aces(outRGB), 1.0);
}

// Phase 7 §5.5.h-24 -- fs_horizon. Per-fragment cull of the
// TerrainHorizon impostor inside the chunked-disc radius, plus
// gentle Phong shading from the sun so lighting matches fs_terrain
// at the meeting line. The fragment shader is the cleanest fix for
// the impostor "swatching over" the chunked terrain: depth-test
// alone can't reliably keep the chunked detail in front because
// the impostor uses fewer noise octaves and isn't always slightly
// below the chunked surface.
//   baseColor.rgb = unused (vertex colors drive surface color)
//   matParams.x   = innerRadius (discard within this XZ distance)
//   matParams.y   = fadeWidth   (smoothstep band beyond innerRadius)
//   matParams.z   = ambient
//   matParams.w   = sunStrength
@fragment
fn fs_horizon(in: VsOut) -> @location(0) vec4<f32> {
  let innerR   = max(0.0, uD.matParams.x);
  let fadeW    = max(1.0, uD.matParams.y);
  let ambientK = clamp(uD.matParams.z, 0.0, 1.0);
  let sunK     = max(0.0, uD.matParams.w);

  let camPos = uS.eye.xyz;

  // §planet-spec Phase 1.5 -- altitude visibility gate. The
  // impostor is coarse / tiled-looking and only useful as a far-
  // distance backdrop. Hide it entirely below visAltLow; fade in
  // over [visAltLow, visAltHigh]. band1.w = visAltLow,
  // band2.x = visAltHigh.
  let visAltLow  = uD.band1.w;
  let visAltHigh = max(visAltLow + 1.0, uD.band2.x);
  let altVis = smoothstep(visAltLow, visAltHigh, camPos.y);
  if (altVis <= 0.001) { discard; }

  let dxz = in.worldPos.xz - camPos.xz;
  let r = length(dxz);
  if (r < innerR) { discard; }
  let fadeIn = clamp((r - innerR) / fadeW, 0.0, 1.0) * altVis;

  let n = normalize(in.normal);
  let sunDir = uS.envSun.xyz;
  let sunDot = max(0.0, dot(n, sunDir)) * uS.envSun.w;
  let baseCol = in.color;
  let lit = baseCol * (ambientK + sunDot * sunK);
  // Apply fog so the impostor blends to atmosphere color at the
  // outer edge, matching how the chunked terrain reads at distance.
  let fogged = apply_fog(lit, in.worldPos);
  // fadeIn ramps the impostor in over the band; the fade is done by
  // alpha-blending against the sky color sampled inline (so we can
  // output opaque + depth-write like the cloud shader).
  let viewDir = normalize(in.worldPos - camPos);
  let mode = u32(uS.envParams.x);
  var bgCol: vec3<f32>;
  if (mode == 2u) {
    bgCol = sample_procedural_sky_smooth(viewDir);
  } else if (mode != 0u) {
    bgCol = sample_env(viewDir);
  } else {
    bgCol = fogged;
  }
  let outRGB = mix(bgCol, fogged, fadeIn);
  return vec4<f32>(tonemap_aces(outRGB), 1.0);
}

// Phase 7 §5.5.c TerrainMaterial v2 (v0.3.129) -- AAA-style
// terrain shading. Altitude bands + slope rock + slope-masked
// snow + multi-scale detail noise (macro variation + micro
// speckle) sampled triplanar (so cliffs don't stretch) +
// procedural bump from micro-noise gradients + edge jitter on
// the band thresholds for organic-looking transitions instead
// of horizontal stripes.
//
// Cost: ~8 fbm evaluations per fragment (3 macro triplanar +
// 3 micro triplanar + 2 for bump finite-difference). Cheap by
// modern GPU standards but not free at 4K.
@fragment
fn fs_terrain(in: VsOut) -> @location(0) vec4<f32> {
  let n0 = normalize(in.normal);
  let v  = normalize(uS.eye.xyz - in.worldPos);
  let shin   = max(1.0, uD.matParams.x);
  let amb    = clamp(uD.matParams.y, 0.0, 1.0);
  let slopeK = uD.matParams.z;
  let vMix   = clamp(uD.matParams.w, 0.0, 1.0);

  // v2 detail + bump knobs.
  let detailScale    = max(0.0001, uD.detailParams.x);
  let detailStrength = clamp(uD.detailParams.y, 0.0, 1.0);
  let microScale     = max(0.0001, uD.detailParams.z);
  let microStrength  = clamp(uD.detailParams.w, 0.0, 1.0);
  let edgeJitter     = clamp(uD.bumpParams.x,  0.0, 1.0);
  let bumpStrength   = clamp(uD.bumpParams.y,  0.0, 1.0);
  let snowMaskAmt    = clamp(uD.bumpParams.z,  0.0, 1.0);

  // Triplanar weights -- used for both detail-noise blending and
  // any future texture sampling. Sharpness = 4 (standard).
  let triW = triplanar_weights(n0, 4.0);

  // Macro detail noise: low-frequency variation per band. Sample
  // on three world-axis planes + blend by triplanar weights so
  // the variation doesn't stretch on cliffs.
  let wmac = in.worldPos * detailScale;
  let macroX = _fbm(wmac.zy);
  let macroY = _fbm(wmac.xz);
  let macroZ = _fbm(wmac.xy);
  let macroN = macroX * triW.x + macroY * triW.y + macroZ * triW.z;

  // Micro detail noise: high-frequency speckle / surface texture.
  let wmic = in.worldPos * microScale;
  let microX = _fbm(wmic.zy);
  let microY = _fbm(wmic.xz);
  let microZ = _fbm(wmic.xy);
  let micro = microX * triW.x + microY * triW.y + microZ * triW.z;

  // Edge jitter: shift each band boundary by macro noise so the
  // transitions follow the terrain instead of running as
  // horizontal stripes. Range ±edgeJitter * 2 world units.
  let jitter = (macroN - 0.5) * edgeJitter * 2.0;
  let alt1 = uD.band1.w + jitter;
  let alt2 = uD.band2.w + jitter;
  let alt3 = uD.band3.w + jitter;
  let soft = max(0.001, uD.band4.w);

  let y   = in.worldPos.y;
  let w12 = smoothstep(alt1 - soft, alt1 + soft, y);
  let w23 = smoothstep(alt2 - soft, alt2 + soft, y);
  let w34 = smoothstep(alt3 - soft, alt3 + soft, y);

  let c12  = mix(uD.band1.rgb, uD.band2.rgb, w12);
  let c123 = mix(c12,          uD.band3.rgb, w23);

  // Slope-masked snow. Pure flat (n.y near 1) gets full snow;
  // steep faces (n.y near 0) skip it so cliffs above the snow
  // line still read as rock. snowMaskAmt=0 disables masking
  // (snow on every surface), 1 makes the mask strict.
  let flatness   = smoothstep(0.55, 0.92, n0.y);
  let snowFactor = w34 * mix(1.0, flatness, snowMaskAmt);
  let band       = mix(c123, uD.band4.rgb, snowFactor);

  // Slope-rockiness: blend rock-band color in on steep faces so
  // they read as stone regardless of altitude.
  let slope    = 1.0 - n0.y;
  let rockMask = clamp(slope * slopeK, 0.0, 1.0);
  var albedoBase = mix(band, uD.band3.rgb, rockMask);

  // Color variation: each band tinted by macro (±detailStrength)
  // and speckled by micro (±microStrength). Multiplicative so
  // tint stays in linear band rather than washing out.
  let macroTint = 1.0 + (macroN - 0.5) * detailStrength * 0.6;
  let microTint = 1.0 + (micro - 0.5) * microStrength * 0.4;
  albedoBase = albedoBase * macroTint * microTint;

  let albedo = mix(albedoBase, in.color, vMix);

  // Procedural bump: perturb the normal by the gradient of micro
  // noise. Cheap finite-difference -- one extra fbm sample per
  // axis (already have the center sample from earlier). Gives
  // surface micro-detail under lighting without normal maps.
  var n = n0;
  if (bumpStrength > 0.001) {
    let eps = 1.0 / max(microScale, 0.1) * 0.05;
    let dxPos = (in.worldPos + vec3<f32>(eps, 0.0, 0.0)) * microScale;
    let dzPos = (in.worldPos + vec3<f32>(0.0, 0.0, eps)) * microScale;
    // Sample the X-projection plane for dx, Z-projection for dz
    // (matches the dominant-axis approximation; for typical
    // upward-facing terrain triplanar weights are biased toward Y).
    let mxDx = _fbm(dxPos.zy);
    let mzDz = _fbm(dzPos.xy);
    let bumpX = (mxDx - microX) / max(eps, 0.0001);
    let bumpZ = (mzDz - microZ) / max(eps, 0.0001);
    let perturb = vec3<f32>(-bumpX, 0.0, -bumpZ) * bumpStrength * 0.04;
    n = normalize(n0 + perturb);
  }

  // Phong-style accumulation over enabled lights.
  let nLights = u32(uS.lightCount.x);
  var lit: vec3<f32> = albedo * amb;
  for (var i: u32 = 0u; i < nLights; i = i + 1u) {
    let L     = uS.lights[i];
    let info  = _eval_light_i(i, in.worldPos);
    let l     = info.xyz;
    let atten = info.w;
    let h     = normalize(l + v);
    let nDotL = max(dot(n, l), 0.0);
    let spec  = pow(max(dot(n, h), 0.0), shin) * step(0.001, nDotL);
    let li    = L.color.rgb * L.color.w;
    lit = lit + albedo * nDotL * (1.0 - amb) * atten * li
              + vec3<f32>(spec) * atten * li * 0.25;
  }
  let fogged = apply_fog(lit, in.worldPos);
  return vec4<f32>(tonemap_aces(fogged), 1.0);
}

// PhysicalMat fragment: Cook-Torrance microfacet BRDF (GGX D,
// Schlick-GGX G, Schlick F). Same metallic-roughness workflow as
// before, now summed over enabled lights.
@fragment
fn fs_pbr(in: VsOut) -> @location(0) vec4<f32> {
  var n = normalize(in.normal);
  // A.4 -- tangent-space normal map via screen-space derivatives (no
  // vertex tangents needed). Derivatives are taken at top level
  // (uniform control flow); the perturb is guarded so the default
  // map (0.5,0.5,1)->(0,0,1) and degenerate UVs leave n untouched.
  // A.4 -- matParams.x = UV tile factor (default 1). meshSampler is
  // repeat, so >1 tiles seamless maps across large faces. TBN uses
  // unscaled-uv derivatives -- the uniform scale cancels in the
  // normalize below, so the tangent frame is unaffected.
  let uvTile = max(uD.matParams.x, 0.0001);
  let uvT  = in.uv * uvTile;
  let dp1  = dpdx(in.worldPos);
  let dp2  = dpdy(in.worldPos);
  let duv1 = dpdx(in.uv);
  let duv2 = dpdy(in.uv);
  let nMap = textureSample(matNormalTex, srcSampler, uvT).xyz * 2.0 - 1.0;
  if (abs(nMap.x) + abs(nMap.y) > 0.01) {
    let dp2perp = cross(dp2, n);
    let dp1perp = cross(n, dp1);
    let Tt = dp2perp * duv1.x + dp1perp * duv2.x;
    let Bt = dp2perp * duv1.y + dp1perp * duv2.y;
    let denom = max(dot(Tt, Tt), dot(Bt, Bt));
    if (denom > 1e-12) {
      let invmax = inverseSqrt(denom);
      n = normalize(mat3x3<f32>(Tt * invmax, Bt * invmax, n) * nMap);
    }
  }
  let v = normalize(uS.eye.xyz - in.worldPos);
  let nDotV = max(dot(n, v), 0.0);
  // A.4 -- per-material maps. White/identity defaults make these a
  // no-op for untextured meshes (albedo x1, rough/metal x scalar param).
  let albTex = textureSample(matAlbedoTex, srcSampler, uvT).rgb;
  let albedo    = mix(uD.baseColor.rgb, in.color, uD.baseColor.a) * albTex;
  let metallic  = clamp(uD.matParams.z * textureSample(matMetalTex, srcSampler, uvT).r, 0.0, 1.0);
  let roughness = clamp(uD.matParams.w * textureSample(matRoughTex, srcSampler, uvT).r, 0.04, 1.0);
  let alpha  = roughness * roughness;
  let alpha2 = alpha * alpha;
  let F0 = mix(vec3<f32>(0.04), albedo, metallic);
  let kk = (roughness + 1.0) * (roughness + 1.0) / 8.0;

  var total: vec3<f32> = vec3<f32>(0.0);
  let nLights = u32(uS.lightCount.x);
  for (var i: u32 = 0u; i < nLights; i = i + 1u) {
    let L     = uS.lights[i];
    let info  = _eval_light_i(i, in.worldPos);
    let l     = info.xyz;
    let atten = info.w;
    let h     = normalize(l + v);
    let nDotL = max(dot(n, l), 0.0);
    let nDotH = max(dot(n, h), 0.0);
    let hDotV = max(dot(h, v), 0.0);

    let F = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - hDotV, 5.0);
    let denom_d = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
    let D = alpha2 / (3.14159265 * denom_d * denom_d);
    let g_v = nDotV / (nDotV * (1.0 - kk) + kk);
    let g_l = nDotL / (nDotL * (1.0 - kk) + kk);
    let G = g_v * g_l;
    let specular = (D * F * G) / max(4.0 * nDotL * nDotV, 0.001);

    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - metallic);
    let diffuse = kD * albedo / 3.14159265;

    let li = L.color.rgb * L.color.w;
    total = total + (diffuse + specular) * li * nDotL * atten;
  }

  // Sprint 7.5.4 -- IBL ambient via sample_env(). Mode 0 = pre-7.5.4
  // hardcoded hemisphere; mode 1+ = wired environment (e.g.
  // GradientSky). Diffuse uses the surface normal direction so the
  // top of the sphere reads the sky color; specular uses the
  // reflection vector so a low-roughness metal reflects whatever the
  // env shows in the direction the camera-bounce ray would go.
  let r = reflect(-v, n);
  let envDiffuse = sample_env(n);
  let envSpec    = sample_env(r);
  let kS_amb = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - nDotV, 5.0);
  let kD_amb = (vec3<f32>(1.0) - kS_amb) * (1.0 - metallic);
  // Roughness-aware IBL specular. There's no prefiltered env mip
  // chain, so approximate gloss falloff two ways: blend the sharp
  // mirror sample toward the soft diffuse-direction sample as
  // roughness rises (a fake blur), and fade specular strength by
  // (1-roughness)². Keeps a chrome surface (rough≈0) a crisp mirror
  // while brick / concrete / plaster (rough≈1) read matte instead of
  // wet-shiny. The +0.04 floor preserves a faint grazing rim.
  let invR    = 1.0 - roughness;
  let envR    = mix(envSpec, envDiffuse, roughness * roughness);
  let specAmt = invR * invR + 0.04;
  let ambient = kD_amb * albedo * envDiffuse * 0.5
              + kS_amb * envR * specAmt;
  // 7.5.4.e -- fog + tonemap. Fog mixes toward env-horizon color at
  // far distances; ACES compresses HDR ambient into [0,1] so HDRI /
  // ProceduralSky bright reflections don't blow out.
  let lit = total + ambient;
  let fogged = apply_fog(lit, in.worldPos);
  return vec4<f32>(tonemap_aces(fogged), 1.0);
}`;

/* Sprint 7.5.3a -- (re)allocate the depth + MSAA color textures at
 * the current Visual.msaaSampleCount. Called from _allocateFramebuffer
 * and from setMsaaSampleCount when the HUD pill cycles. The MSAA
 * color texture is only allocated when sampleCount > 1; the depth
 * texture is always allocated (with matching sampleCount). */
function _ensureMsaa3DTextures() {
  if (!Visual.device || !Visual.fbWidth || !Visual.fbHeight) return;
  const sc = Math.max(1, Visual.msaaSampleCount | 0);
  // Depth -- always allocated.
  if (Visual.depthTexture) {
    try { Visual.depthTexture.destroy(); } catch (_) {}
  }
  Visual.depthTexture = Visual.device.createTexture({
    label: "visual-depth-" + sc + "x-" + Visual.resolutionKey,
    size: [Visual.fbWidth, Visual.fbHeight, 1],
    sampleCount: sc,
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT
  });
  Visual.depthTextureView = Visual.depthTexture.createView({ label: "visual-depth-view" });
  // MSAA color -- only when sc > 1. We render into this and resolve
  // to the framebuffer layer at end-of-pass.
  if (Visual.msaaColorTexture) {
    try { Visual.msaaColorTexture.destroy(); } catch (_) {}
    Visual.msaaColorTexture     = null;
    Visual.msaaColorTextureView = null;
  }
  if (sc > 1) {
    Visual.msaaColorTexture = Visual.device.createTexture({
      label: "visual-msaa-color-" + sc + "x-" + Visual.resolutionKey,
      size: [Visual.fbWidth, Visual.fbHeight, 1],
      sampleCount: sc,
      format: Visual.fbFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    Visual.msaaColorTextureView = Visual.msaaColorTexture.createView({ label: "visual-msaa-color-view" });
  }
  // The mesh pipeline is sampleCount-keyed, so changing sc means
  // future _ensureMeshPipeline(sc) calls hit a fresh cache slot.
  // Existing entries for other sample counts stay -- cheap, lets
  // the user toggle 1x <-> 4x without paying shader compile cost
  // on every flip.
}

function setMsaaSampleCount(n) {
  n = (n === 4 || n === 8) ? n : 1;
  if (n === Visual.msaaSampleCount) return;
  Visual.msaaSampleCount = n;
  _ensureMsaa3DTextures();
  _updateMsaaPill();
}
function cycleMsaa() {
  // 1 -> 4 -> 8 -> 1. 8x is not universally supported, but WebGPU
  // surfaces a validation error at pipeline create time which we
  // catch + display in the HUD; we still LET the user try it on
  // adapters that have it.
  const cur = Visual.msaaSampleCount;
  setMsaaSampleCount(cur === 1 ? 4 : (cur === 4 ? 8 : 1));
}
function _updateMsaaPill() {
  const pill = document.getElementById("msaa-pill");
  if (!pill) return;
  const sc = Visual.msaaSampleCount;
  pill.textContent = sc + "x MSAA";
  pill.classList.toggle("active", sc > 1);
  pill.title = sc === 1
    ? "MSAA disabled (1x). Click to cycle 1x -> 4x -> 8x. Affects only 3D Scene passes; existing shader-frag passes stay single-sample."
    : "MSAA " + sc + "x. Click to cycle. Anti-aliases triangle edges in Scene render passes via WebGPU resolveTarget. Costs ~" + sc + "x the depth + color memory of the 3D pass.";
}

// Sprint 7.5.3a -- one-shot diagnostic logs so we can see exactly
// where the 3D render path stops if a smoke-test demo shows blank.
// Each flag is flipped true on first success so we don't spam the
// console every frame.
const _SCENE_DIAG = { pipeline: false, instance: false, encode: false, draw: false, cull: false };

/* =========================================================================
 * §bonus-perf-diag (2026-05-25) -- focused per-frame perf counters for
 * the SVT/DEM transition slow zone. User reports 9 fps at foot, drop
 * happens "exactly where SVT ends and DEM begins". This block makes
 * the suspect hot paths visible:
 *
 *   chunksVisible   -- total visible chunks this frame (cull-pass count)
 *   chunksBuilt     -- chunks rebuilt this frame (CPU vertex noise +
 *                      DEM resample + GPU upload)
 *   chunkBuildMs    -- ms spent in chunk build this frame
 *   demTilesFetched -- DEM tile fetches kicked off this frame
 *   demTilesArrived -- DEM tile arrivals this frame (each triggers
 *                      _invalidateChunksForTile → chunk rebuilds)
 *   chunksInvalidated -- chunks killed by tile arrivals this frame
 *   svtPagesGenThisFrame -- pages drained from SVT queue this frame
 *
 * Updated by the chunk-build path + DEM loader + SVT tick. Dumped to
 * console every 60 frames if any counter > 0. Also surfaced via
 * window.__PERFSTATS so user can poll from console:
 *   __PERFSTATS.snapshot()
 */
const _PERFSTATS = {
  frame: 0,
  chunksVisible: 0,
  chunksBuilt: 0,
  chunkBuildMs: 0,
  demTilesFetched: 0,
  demTilesArrived: 0,
  chunksInvalidated: 0,
  svtPagesGenThisFrame: 0,
  // Rolling totals so a snapshot has the cumulative picture too.
  totalChunksBuilt: 0,
  totalDemTilesFetched: 0,
  totalDemTilesArrived: 0,
  totalChunksInvalidated: 0,
  // Frame-time stats (rolling 60-frame window).
  frameMs: 0,
  frameMsWindow: [],
};
function _perfFrameReset() {
  _PERFSTATS.frame++;
  _PERFSTATS.chunksVisible = 0;
  _PERFSTATS.chunksBuilt = 0;
  _PERFSTATS.chunkBuildMs = 0;
  _PERFSTATS.chunkPhQueue = 0;
  _PERFSTATS.chunkUpQueue = 0;
  _PERFSTATS.demTilesFetched = 0;
  _PERFSTATS.demTilesArrived = 0;
  _PERFSTATS.chunksInvalidated = 0;
  _PERFSTATS.svtPagesGenThisFrame = 0;
}
function _perfFrameDump() {
  // §bonus-perf-diag v2 -- dump every 30 frames (was 60) so we get
  // more samples during a slow-down period. Always dumps (even when
  // counters near 0) so we always see the frame-time line at any
  // altitude. fps is the headline metric -- median of frameMsWindow
  // so a single spike doesn't poison the average; draws is the last
  // frame's count, useful for tracking per-chunk overhead.
  if (_PERFSTATS.frame % 30 !== 0) return;
  let medMs = 0;
  if (_PERFSTATS.frameMsWindow.length > 0) {
    const sorted = _PERFSTATS.frameMsWindow.slice().sort((a, b) => a - b);
    medMs = sorted[Math.floor(sorted.length / 2)];
  }
  const fps = medMs > 0 ? (1000 / medMs).toFixed(1) : "?";
  const draws = (typeof Visual !== "undefined" && Visual.perf)
    ? Visual.perf.drawCalls : 0;
  // §log-quiet -- the [perf] line is useful when chasing perf, noise
  // otherwise. Gated behind window.__PLANET_LOG (default off). Set
  // window.__PLANET_LOG = true in console to re-enable.
  if (!(typeof window !== "undefined" && window.__PLANET_LOG)) return;
  console.log("[perf] f=" + _PERFSTATS.frame
    + " fps=" + fps + " (" + medMs.toFixed(1) + "ms)"
    + " draws=" + draws
    + " vis=" + _PERFSTATS.chunksVisible
    + " built=" + _PERFSTATS.chunksBuilt + "(" + _PERFSTATS.chunkBuildMs.toFixed(1) + "ms)"
    + " qPh=" + _PERFSTATS.chunkPhQueue + " qUp=" + _PERFSTATS.chunkUpQueue
    + " demFetch=" + _PERFSTATS.demTilesFetched
    + " demArrive=" + _PERFSTATS.demTilesArrived
    + " invald=" + _PERFSTATS.chunksInvalidated
    + " svtPg=" + _PERFSTATS.svtPagesGenThisFrame
    + " | cumDEM=" + _PERFSTATS.totalDemTilesArrived
    + "/" + _PERFSTATS.totalDemTilesFetched);
}
if (typeof window !== "undefined") {
  window.__PERFSTATS = _PERFSTATS;
  window.__PERFSTATS.snapshot = function () {
    return {
      frame: _PERFSTATS.frame,
      chunksVisible: _PERFSTATS.chunksVisible,
      chunksBuilt: _PERFSTATS.chunksBuilt,
      chunkBuildMs: _PERFSTATS.chunkBuildMs,
      demTilesFetched: _PERFSTATS.demTilesFetched,
      demTilesArrived: _PERFSTATS.demTilesArrived,
      chunksInvalidated: _PERFSTATS.chunksInvalidated,
      svtPagesGenThisFrame: _PERFSTATS.svtPagesGenThisFrame,
      total: {
        chunksBuilt: _PERFSTATS.totalChunksBuilt,
        demTilesFetched: _PERFSTATS.totalDemTilesFetched,
        demTilesArrived: _PERFSTATS.totalDemTilesArrived,
        chunksInvalidated: _PERFSTATS.totalChunksInvalidated,
      }
    };
  };
}

/* =========================================================================
 * Sprint 7.5.3c -- ShaderMat preset library
 *
 * Each preset is a WGSL function body defining
 *   fn surface_shade(s: SurfaceIn) -> vec3<f32>
 * which receives the fragment's world position + normal + per-vertex
 * color and returns the final surface RGB. The full module wrapping
 * lives in _buildShaderMatWgsl: a copy of the standard _MESH_WGSL
 * (so presets have access to uS/uD uniforms + the standard vertex
 * shader) plus the preset code + an fs_shadermat fragment entry that
 * calls surface_shade.
 *
 * The matParams slots get reinterpreted for ShaderMat:
 *   matParams.x = time      (wire MasterClock.phase * 2π for periodic effects)
 *   matParams.y = freq      (cycles per unit area / per second)
 *   matParams.z = intensity (effect strength)
 *   matParams.w = reserved
 * baseColor.rgb is the tint color (each preset uses it differently).
 *
 * Future: arbitrary user WGSL via a code-editor UI. Out of scope for
 * sprint 7.5.3c; the preset path establishes the infrastructure. */
const _SHADERMAT_PRESETS = {
  /* Iridescent -- view-angle-dependent rainbow. Classic oil-slick /
   * soap-bubble look. Color shifts as the camera moves around the
   * mesh; time advances the hue cycle. */
  iridescent: `
fn surface_shade(s: SurfaceIn) -> vec3<f32> {
  let v = normalize(uS.eye.xyz - s.worldPos);
  let fres = pow(1.0 - max(dot(normalize(s.normal), v), 0.0), 2.0);
  let phase = fres * uD.matParams.y * 6.0 + uD.matParams.x;
  let r = sin(phase + 0.0)   * 0.5 + 0.5;
  let g = sin(phase + 2.094) * 0.5 + 0.5;
  let b = sin(phase + 4.189) * 0.5 + 0.5;
  let hue = vec3<f32>(r, g, b);
  return mix(uD.baseColor.rgb, hue, uD.matParams.z);
}
`,

  /* Plasma -- classic four-sine plasma noise on the surface in
   * world space. Time scrolls the pattern; freq scales the scale
   * of the noise; intensity blends with the baseColor tint. */
  plasma: `
fn surface_shade(s: SurfaceIn) -> vec3<f32> {
  let t = uD.matParams.x;
  let f = uD.matParams.y;
  let p = s.worldPos * f;
  let r = length(p);
  let v = sin(p.x * 1.0 + t)
        + sin(p.y * 1.0 + t * 0.7)
        + sin(p.z * 1.0 + t * 1.3)
        + sin(r       * 1.5 - t * 2.0);
  let v01 = v * 0.25 * 0.5 + 0.5;
  let hue = vec3<f32>(
    sin(v01 * 6.28 + 0.0) * 0.5 + 0.5,
    sin(v01 * 6.28 + 2.0) * 0.5 + 0.5,
    sin(v01 * 6.28 + 4.0) * 0.5 + 0.5
  );
  return mix(uD.baseColor.rgb, hue, uD.matParams.z);
}
`,

  /* Scanlines -- animated horizontal stripes scrolling around the
   * mesh. Reads like a sci-fi hologram. freq controls density,
   * time scrolls. */
  scanlines: `
fn surface_shade(s: SurfaceIn) -> vec3<f32> {
  let band = sin(s.worldPos.y * uD.matParams.y * 6.28 - uD.matParams.x * 4.0);
  let lit  = smoothstep(-0.4, 0.4, band);
  let glow = pow(lit, 3.0);
  let v    = normalize(uS.eye.xyz - s.worldPos);
  let fres = pow(1.0 - max(dot(normalize(s.normal), v), 0.0), 2.0);
  let baseCol = uD.baseColor.rgb;
  let hot   = baseCol * 1.6 + vec3<f32>(0.0, 0.4, 0.6);
  let surface = mix(baseCol * 0.15, hot, glow);
  return surface + vec3<f32>(0.2, 0.6, 0.9) * fres * uD.matParams.z * 0.5;
}
`,

  /* FresnelEdge -- bright edges via Fresnel falloff. Center stays
   * dim; grazing edges glow. Classic rim-light fake. baseColor is
   * the rim color; matParams.z controls overall brightness. */
  fresnelEdge: `
fn surface_shade(s: SurfaceIn) -> vec3<f32> {
  let v = normalize(uS.eye.xyz - s.worldPos);
  let nDotV = max(dot(normalize(s.normal), v), 0.0);
  let rim = pow(1.0 - nDotV, max(0.5, uD.matParams.y));
  let core = uD.baseColor.rgb * 0.08;
  let edge = uD.baseColor.rgb * uD.matParams.z;
  return mix(core, edge, rim);
}
`,

  /* Texture -- sample an upstream visual node's output (StarNest,
   * Voronoi, MatrixRain, ShapeTunnel, Plasma, etc.) as the surface
   * texture. The upstream is auto-scheduled into a scratch slot by
   * the plan walker; the slot index lands in matParams.w.
   *
   * UV mapping: each primitive emits proper per-vertex UVs from
   * its builder (sphere = equirectangular; box = per-face 0..1;
   * plane = planar; torus = (major, minor); cylinder = (theta, y);
   * cone = (theta, apex-to-base)). The fragment just samples at
   * s.uv -- no spherical-from-worldPos approximation needed.
   * matParams.y = freq tiles the UV; matParams.z = intensity
   * scales brightness; baseColor.rgb tints (multiplicative). */
  texture: `
fn surface_shade(s: SurfaceIn) -> vec3<f32> {
  let layer = u32(max(0.0, uD.matParams.w));
  let tile  = max(0.001, uD.matParams.y);
  let uv    = fract(s.uv * tile);
  let tex   = textureSampleLevel(srcTexture, srcSampler, uv, layer, 0.0);
  return tex.rgb * uD.baseColor.rgb * uD.matParams.z;
}
`,

  /* Phase 7 §5.5.c-2 -- triplanar variant of the texture preset.
   * Skips per-vertex UVs entirely; instead projects the upstream
   * texture onto three world-axis planes (XY / XZ / ZY) and blends
   * by the squared normal so each face picks up its aligned plane.
   * The classic solve for procedurally-textured terrain (where
   * vertex UVs stretch on cliffs) and any other mesh where UV
   * unwrapping would be awkward. Wire ProceduralTerrain.out (or
   * any visual node) into ShaderMat.texture; pick this preset.
   * matParams.y = scale (world units per texture wrap; 0.05 ≈
   * 20m per repeat is sensible for terrain); matParams.x reused
   * as sharpness (4 default; 1..8 useful range -- higher = more
   * axis-aligned, lower = softer cross-blending). */
  "texture-triplanar": `
fn surface_shade(s: SurfaceIn) -> vec3<f32> {
  let layer     = u32(max(0.0, uD.matParams.w));
  let scale     = max(0.0001, uD.matParams.y);
  let sharpness = max(0.5, uD.matParams.x);
  let tex = triplanar_sample_array(srcTexture, srcSampler,
                                    layer, s.worldPos,
                                    normalize(s.normal),
                                    scale, sharpness);
  return tex.rgb * uD.baseColor.rgb * uD.matParams.z;
}
`
};

const _SHADERMAT_PRESET_NAMES = Object.keys(_SHADERMAT_PRESETS);

/* Build the complete WGSL module for a ShaderMat preset. Includes
 * the standard _MESH_WGSL (so presets can use uS/uD + the shared
 * vertex shader) + a SurfaceIn struct + the preset's body + an
 * fs_shadermat fragment entry that hooks it all together. */
function _buildShaderMatWgsl(presetCode) {
  return _MESH_WGSL +
    "\n\n// === ShaderMat preset injection (sprint 7.5.3c) ===\n" +
    "struct SurfaceIn {\n" +
    "  worldPos: vec3<f32>,\n" +
    "  normal:   vec3<f32>,\n" +
    "  color:    vec3<f32>,\n" +
    "  uv:       vec2<f32>,\n" +
    "};\n" +
    presetCode + "\n" +
    "@fragment fn fs_shadermat(in: VsOut) -> @location(0) vec4<f32> {\n" +
    "  var s: SurfaceIn;\n" +
    "  s.worldPos = in.worldPos;\n" +
    "  s.normal   = normalize(in.normal);\n" +
    "  s.color    = in.color;\n" +
    "  s.uv       = in.uv;\n" +
    "  let rgb    = surface_shade(s);\n" +
    "  return vec4<f32>(rgb, 1.0);\n" +
    "}\n";
}

/* Lazy-build the shader module for one ShaderMat preset. Cached
 * forever (presets don't change across a session). Each preset
 * gets its own module + async getCompilationInfo for error
 * surfacing. Returns null on unknown preset name. */
function _ensureShaderMatModule(presetName) {
  if (!Visual.shaderMatModules) Visual.shaderMatModules = new Map();
  if (Visual.shaderMatModules.has(presetName)) return Visual.shaderMatModules.get(presetName);
  if (!Visual.device) return null;
  const body = _SHADERMAT_PRESETS[presetName];
  if (!body) {
    console.warn("[scene] unknown ShaderMat preset:", presetName);
    return null;
  }
  const wgsl = _buildShaderMatWgsl(body);
  let module;
  try {
    module = Visual.device.createShaderModule({
      label: "shadermat-" + presetName,
      code: wgsl
    });
  } catch (e) {
    console.warn("[scene] ShaderMat preset '" + presetName + "' shader compile threw:", e);
    return null;
  }
  Visual.shaderMatModules.set(presetName, module);
  module.getCompilationInfo().then(info => {
    const errs = info.messages.filter(m => m.type === "error");
    if (errs.length) {
      console.error("[scene] ShaderMat preset '" + presetName + "' WGSL errors:");
      for (const m of errs) console.error("  line " + m.lineNum + " col " + m.linePos + ": " + m.message);
    }
  });
  return module;
}

/* Sprint 7.5.3c bug fix -- BGL build extracted so it's available
 * before any pipeline is created. _ensureSceneInstance needs the
 * BGL to build per-slot bind groups, and it's called BEFORE the
 * pipeline path inside _encodeScenePass. Without this helper the
 * chicken-and-egg ordering means scene instances never allocate
 * and every render bails (the v0.3.53 regression). */
function _ensureMeshBindGroupLayout() {
  if (Visual.meshBindGroupLayout) return Visual.meshBindGroupLayout;
  if (!Visual.device) return null;
  Visual.meshBindGroupLayout = Visual.device.createBindGroupLayout({
    label: "mesh-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      // Sprint 7.5.3c push 5 -- texture + sampler for ShaderMat
      // texture sampling. Always present in the BGL so the pipeline
      // layout matches for all material types; non-texture materials
      // simply don't reference the bindings in their WGSL.
      // v0.3.126 §5.5.c-3 -- VERTEX visibility added so vs_terrain
      // can textureLoad the heightmap for per-vertex Y displacement.
      // The sampler at binding 3 stays fragment-only (vertex
      // textureLoad doesn't use a sampler, so the constraint that
      // "vertex shaders can't use filtering samplers" doesn't bite).
      { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array", multisampled: false } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      // Sprint 7.5.4.b -- env texture + sampler for HDRI / Skybox
      // equirectangular sampling (mode 3 in sample_env). Always
      // present in the BGL; bound to a 1x1 default when no HDRI is
      // loaded (mode != 3 never reads it). RGBA16Float so HDR values
      // > 1 pass through; tonemap happens implicitly at framebuffer
      // clamp time for now (future polish: explicit ACES pass).
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      // Sprint 7.6.b-atm Tier-C.1 -- atmosphere LUTs. Two 2-D textures
      // recomputed per-frame by _renderAtmosphereLUTs (a pair of small
      // render-to-texture passes). Sampled by fs_sky / _atm_integrate
      // for fast transmittance + multi-scattering lookups instead of
      // re-integrating each per-pixel.
      //   6 = transmittance LUT  (256x64 RGBA16F): per-altitude × view-
      //       zenith Beer-Lambert sun extinction.
      //   7 = multi-scattering LUT (32x32 RGBA16F): per-altitude × sun-
      //       zenith isotropic-bounce contribution. Fills in the side
      //       of the atmosphere opposite the sun.
      //   8 = LUT sampler (linear, clamp). Shared by both reads.
      // Always present in the BGL so the pipeline layout is uniform;
      // bound to 1×1 default textures when no planet is in the patch
      // (sample sites guard on uS.envPlanet.w > 0 before reading).
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      // C.4 -- sky-view LUT. Camera-dependent precomputed atmosphere
      // color in (azimuth, elevation) form so fs_sky becomes a single
      // texture sample instead of per-pixel atmosphere integration.
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      // C.7 cleanup -- bindings 10/11 (the aerial-perspective LUT
      // pair) were removed when sample_aerial_perspective_lut was
      // rewritten to use the sky-view + transmittance LUTs directly.
      // Sprint 10-5c-c: SVT bindings reuse those freed slots.
      //   10 = SVT atlas texture (4096² RGBA8) -- procedural surface
      //        detail, sparsely populated by _svtUploadPage.
      //   11 = SVT atlas sampler (linear, clamp).
      //   12 = SVT page table (256² R32Uint × 6 layers, one per face).
      //        Encodes (slotY << 16) | slotX for resident pages,
      //        0xFFFFFFFF for unresident.
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 12, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint",  viewDimension: "2d-array", multisampled: false } },
      // Sprint 10-5c-g: normal-map atlas. Same 4096² layout as
      // binding 10 (albedo); slot coords matched 1:1 with albedo so
      // the shader uses the same atlas UV for both.
      { binding: 13, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      // Sprint 10-5c-h: PBR material atlas. R=rough, G=metal, B=AO.
      { binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      // Sprint 10-5c-h2: fine-zoom page table. Same format as binding 12
      // (R32Uint array, 6 layers, one per face) but at 1024² entries
      // per layer instead of 256² for ~4× finer resolution per page.
      { binding: 15, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint", viewDimension: "2d-array", multisampled: false } },
      // A.4 -- per-material PBR maps (albedo / normal / rough / metal).
      // 1x1 defaults bound when a material has no map (no-op).
      { binding: 16, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 17, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 18, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 19, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
    ]
  });
  Visual.meshPipelineLayout = Visual.device.createPipelineLayout({
    label: "mesh-pl",
    bindGroupLayouts: [Visual.meshBindGroupLayout]
  });
  return Visual.meshBindGroupLayout;
}

/* Sprint 7.5.4.b -- env texture management. A single GPUTexture
 * (RGBA16Float, 2D, equirect) holds the currently-loaded HDRI /
 * Skybox image. Initialized to 1×1 mid-gray at editor load so
 * Scene bind groups have something to bind even when no env source
 * is wired. When an HDRI loads, the texture is destroyed + replaced
 * at the HDR's actual size, and Visual.sceneInstances is cleared
 * so the next render rebuilds bind groups against the new texture
 * view. The env sampler stays the same (repeat U / clamp V for
 * equirect seam handling). */
function _ensureEnvTextureDefault() {
  if (Visual.envTexture) return;
  if (!Visual.device) return;
  Visual.envTexture = Visual.device.createTexture({
    label: "env-texture-default-1x1",
    size: [1, 1, 1],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  Visual.envTextureView = Visual.envTexture.createView({ label: "env-texture-view" });
  // 1×1 mid-gray (rgba half-float). Just to satisfy bind group
  // binding -- never actually sampled when no HDRI is loaded
  // (sample_env's mode dispatch skips mode 3).
  const data = new Uint16Array([_floatToHalf(0.5), _floatToHalf(0.5), _floatToHalf(0.5), _floatToHalf(1.0)]);
  Visual.device.queue.writeTexture(
    { texture: Visual.envTexture },
    data,
    { bytesPerRow: 8 },
    { width: 1, height: 1, depthOrArrayLayers: 1 }
  );
  if (!Visual.envSampler) {
    Visual.envSampler = Visual.device.createSampler({
      label: "env-sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge"
    });
  }
}

/* A.4 -- default 1×1 textures for the per-material PBR map bindings
 * (16=albedo, 17=normal, 18=rough, 19=metal). White for albedo /
 * rough / metal (x1 no-op); (128,128,255) for normal = tangent +Z =
 * no perturbation. Bound for every mesh that has no map so the
 * existing untextured look is byte-identical. */
function _ensureMatDefaultTextures() {
  if (Visual.matWhiteTexView && Visual.matNormalTexView) return;
  if (!Visual.device) return;
  const mk = (label, rgba) => {
    const tex = Visual.device.createTexture({
      label, size: [1, 1, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    Visual.device.queue.writeTexture(
      { texture: tex }, new Uint8Array(rgba),
      { bytesPerRow: 4 }, { width: 1, height: 1, depthOrArrayLayers: 1 }
    );
    return tex.createView({ label: label + "-view" });
  };
  Visual.matWhiteTexView  = mk("mat-white-1x1",  [255, 255, 255, 255]);
  Visual.matNormalTexView = mk("mat-normal-1x1", [128, 128, 255, 255]);
}

/* Sprint 7.5.4.b -- single-precision → half-precision (IEEE 754
 * binary16) bit conversion. WebGPU wants RGBA16Float for HDR
 * uploads; JS has no native f16 type so we pack the bits manually.
 * Handles normals + zero + infinity; subnormals collapse to zero
 * (negligible for HDR-range color values). */
function _floatToHalf(val) {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 127 + 15;
  let mant = (x >> 13) & 0x3ff;
  if (exp >= 31) return sign | 0x7c00 | (mant ? 0x200 : 0); // inf / NaN
  if (exp <= 0) return sign;                                // zero / subnormal
  return sign | (exp << 10) | mant;
}

/* Sprint 7.5.4.b -- Radiance .hdr / RGBE parser. The format:
 *   - ASCII header (FORMAT=32-bit_rle_rgbe), terminated by blank line
 *   - Resolution line ("-Y H +X W" most common; top-to-bottom)
 *   - Body: H scanlines, each W pixels of RLE-encoded RGBE
 *
 * RGBE → RGB float: f = 2^(E - 128) / 256; R = r*f, G = g*f, B = b*f.
 * Returns { width, height, data } where data is a Float32Array of
 * length width*height*3 in row-major order, top-to-bottom. */
function _parseHdr(bytes) {
  let i = 0;
  // --- ASCII header: read until blank line.
  let header = "";
  while (i < bytes.length) {
    const c = String.fromCharCode(bytes[i++]);
    header += c;
    if (header.endsWith("\n\n")) break;
  }
  if (!header.includes("RADIANCE")) {
    throw new Error("not a Radiance .hdr (no #?RADIANCE token)");
  }
  // --- Resolution line: "-Y H +X W".
  let resLine = "";
  while (i < bytes.length) {
    const c = String.fromCharCode(bytes[i++]);
    if (c === "\n") break;
    resLine += c;
  }
  const m = resLine.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
  if (!m) throw new Error("unsupported HDR resolution line: " + resLine);
  const height = parseInt(m[1], 10);
  const width  = parseInt(m[2], 10);
  // --- Pixel body. Each scanline is either old-style raw RGBE or
  // new-style RLE (marker 0x02 0x02 high-byte low-byte).
  const out = new Float32Array(width * height * 3);
  const scanline = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (i + 4 > bytes.length) throw new Error("HDR: scanline header truncated at y=" + y);
    const r0 = bytes[i], g0 = bytes[i + 1], b0 = bytes[i + 2], e0 = bytes[i + 3];
    if (r0 === 0x02 && g0 === 0x02 && (b0 & 0x80) === 0) {
      // New-style RLE. Width is in (b0 << 8) | e0; should equal width.
      const decodedWidth = (b0 << 8) | e0;
      if (decodedWidth !== width) {
        throw new Error("HDR: RLE width mismatch (got " + decodedWidth + ", expected " + width + ")");
      }
      i += 4;
      // Decode 4 channels (R, G, B, E) separately.
      for (let ch = 0; ch < 4; ch++) {
        let x = 0;
        while (x < width) {
          if (i >= bytes.length) throw new Error("HDR: RLE truncated y=" + y + " ch=" + ch);
          const n = bytes[i++];
          if (n > 128) {
            // Run: repeat next byte (n - 128) times.
            const run = n - 128;
            const v = bytes[i++];
            for (let k = 0; k < run && x < width; k++) {
              scanline[x * 4 + ch] = v;
              x++;
            }
          } else {
            // Dump: n raw bytes.
            for (let k = 0; k < n && x < width; k++) {
              scanline[x * 4 + ch] = bytes[i++];
              x++;
            }
          }
        }
      }
    } else {
      // Old-style: raw RGBE pixels, no RLE. The 4 bytes we just
      // peeked are the first pixel; continue reading the rest.
      scanline[0] = r0; scanline[1] = g0; scanline[2] = b0; scanline[3] = e0;
      i += 4;
      for (let x = 1; x < width; x++) {
        scanline[x * 4 + 0] = bytes[i++];
        scanline[x * 4 + 1] = bytes[i++];
        scanline[x * 4 + 2] = bytes[i++];
        scanline[x * 4 + 3] = bytes[i++];
      }
    }
    // Convert scanline RGBE to float RGB into out.
    for (let x = 0; x < width; x++) {
      const r = scanline[x * 4 + 0];
      const g = scanline[x * 4 + 1];
      const b = scanline[x * 4 + 2];
      const e = scanline[x * 4 + 3];
      if (e === 0) {
        // RGBE pixels with exponent=0 are pure black; everything's zero.
        out[(y * width + x) * 3 + 0] = 0;
        out[(y * width + x) * 3 + 1] = 0;
        out[(y * width + x) * 3 + 2] = 0;
      } else {
        const f = Math.pow(2, e - 128) / 256;
        out[(y * width + x) * 3 + 0] = r * f;
        out[(y * width + x) * 3 + 1] = g * f;
        out[(y * width + x) * 3 + 2] = b * f;
      }
    }
  }
  return { width, height, data: out };
}

/* Sprint 7.5.4.b -- HDRI cache + loader. Keyed by URL; promises
 * deduplicated so multiple HDRI nodes pointing at the same file
 * don't re-fetch + re-parse. Pre-converts the parsed Float32 RGB
 * to RGBA16Float so the actual texture upload is fast. */
function _ensureHdriCache() {
  if (!Visual._hdriCache) Visual._hdriCache = new Map();
}
function _loadHdri(url) {
  _ensureHdriCache();
  if (Visual._hdriCache.has(url)) return Visual._hdriCache.get(url);
  const promise = (async () => {
    const t0 = performance.now();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("HDRI fetch " + url + " -> HTTP " + resp.status);
    const buf = await resp.arrayBuffer();
    const { width, height, data } = _parseHdr(new Uint8Array(buf));
    // RGBA half-float for GPU upload. Alpha = 1.0 in half-float.
    const ALPHA_ONE = 0x3c00;
    const half = new Uint16Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      half[i * 4 + 0] = _floatToHalf(data[i * 3 + 0]);
      half[i * 4 + 1] = _floatToHalf(data[i * 3 + 1]);
      half[i * 4 + 2] = _floatToHalf(data[i * 3 + 2]);
      half[i * 4 + 3] = ALPHA_ONE;
    }
    const dt = performance.now() - t0;
    console.log("[hdri] loaded " + url + " (" + width + "x" + height + ", " +
                Math.round(buf.byteLength / 1024) + "KB) in " + Math.round(dt) + "ms");
    return { width, height, half };
  })();
  Visual._hdriCache.set(url, promise);
  return promise;
}

/* Sprint 7.5.4.b -- apply a loaded HDRI to the global env texture.
 * Destroys + reallocates Visual.envTexture at the HDRI's size, writes
 * the data, and clears Visual.sceneInstances so the next render
 * rebuilds bind groups against the new texture view. Idempotent --
 * if the same HDRI is already applied, no-op. */
function _applyHdriToEnvTexture(hdri, urlForLabel) {
  if (!Visual.device) return;
  if (Visual._envTextureUrl === urlForLabel) return;
  if (Visual.envTexture) {
    try { Visual.envTexture.destroy(); } catch (_) {}
  }
  Visual.envTexture = Visual.device.createTexture({
    label: "env-texture-" + (urlForLabel || "hdri") + "-" + hdri.width + "x" + hdri.height,
    size: [hdri.width, hdri.height, 1],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  Visual.envTextureView = Visual.envTexture.createView({ label: "env-texture-view" });
  Visual.device.queue.writeTexture(
    { texture: Visual.envTexture },
    hdri.half,
    { bytesPerRow: hdri.width * 8 },  // RGBA × 2 bytes per half-float
    { width: hdri.width, height: hdri.height, depthOrArrayLayers: 1 }
  );
  Visual._envTextureUrl = urlForLabel;
  // Force Scene bind groups to rebuild against the new texture view.
  if (Visual.sceneInstances && Visual.sceneInstances.size > 0) {
    Visual.sceneInstances.clear();
  }
}

function _ensureMeshPipeline(materialType, sampleCount, displaced, vsVariant) {
  if (!Number.isFinite(sampleCount) || sampleCount < 1) sampleCount = 1;
  // Sprint 7.5.3c -- pipeline cache keyed by material type AND
  // sample count. v0.3.126 §5.5.c-3 -- added a third axis,
  // `displaced` (boolean), for the GPU heightmap-displacement
  // vertex shader. When true, the pipeline uses vs_terrain
  // instead of vs_main; same fragment entry.
  // Phase 8 sprint 8-7 -- fourth axis, vsVariant (string), for
  // alternate vertex shaders (currently "planet_detail" -> the
  // camera-anchored detail patch). null/undefined = default vs_main.
  if (!materialType) materialType = "unlit-vc";
  const variantTag = vsVariant ? ("-" + vsVariant) : "";
  const key = materialType + "-" + (displaced ? "d" : "s") + "-" + sampleCount + "x" + variantTag;
  if (Visual.meshPipelineCache.has(key)) {
    return Visual.meshPipelineCache.get(key);
  }
  if (!Visual.device) return null;
  // Two uniform buffers: per-Scene (viewProj + light + eye) at
  // binding 0, per-draw (model + material) at binding 1. Both
  // visible to vertex AND fragment stages.
  if (!_ensureMeshBindGroupLayout()) return null;
  // Sprint 7.5.3c -- ShaderMat presets live in their own modules
  // (each preset has unique WGSL). For non-ShaderMat materials,
  // use the shared module exposing every fragment entry point.
  let module, fragEntry;
  if (materialType.indexOf("shadermat-") === 0) {
    const presetName = materialType.substring("shadermat-".length);
    module = _ensureShaderMatModule(presetName);
    if (!module) return null;
    fragEntry = "fs_shadermat";
  } else {
    if (!Visual.meshShaderModule) {
      let mod;
      try {
        mod = Visual.device.createShaderModule({ label: "mesh-shader", code: _MESH_WGSL });
      } catch (e) {
        console.warn("[scene] mesh shader compile failed:", e);
        return null;
      }
      Visual.meshShaderModule = mod;
      // Surface WGSL errors via getCompilationInfo (createShaderModule
      // doesn't throw on bad WGSL; errors arrive async).
      mod.getCompilationInfo().then(info => {
        const errs = info.messages.filter(m => m.type === "error");
        if (errs.length) {
          console.error("[scene] mesh shader WGSL errors:");
          for (const m of errs) {
            console.error("  line " + m.lineNum + " col " + m.linePos + ": " + m.message);
          }
        } else {
          const warns = info.messages.filter(m => m.type === "warning");
          if (warns.length) console.warn("[scene] mesh shader WGSL warnings:", warns);
        }
      });
    }
    module = Visual.meshShaderModule;
    fragEntry =
      materialType === "pbr"      ? "fs_pbr"     :
      materialType === "phong"    ? "fs_phong"   :
      materialType === "terrain"  ? "fs_terrain" :
      materialType === "water"    ? "fs_water"   :
      materialType === "clouds"   ? "fs_clouds"  :
      materialType === "horizon"  ? "fs_horizon" :
      materialType === "unlit"    ? "fs_unlit"   :
      /* default unlit-vc */        "fs_unlit_vc";
  }
  // v0.3.126 §5.5.c-3 -- vs_terrain samples the bound scratch
  // heightmap for per-vertex Y displacement when `displaced` is
  // true. Same VsOut interface so any fragment shader works on top.
  // §5.5.h-25 -- horizon material gets vs_horizon for planet-
  // curvature blend.
  const vsEntry = (vsVariant === "planet_cdlod")  ? "vs_planet_cdlod"
                : (vsVariant === "planet_detail") ? "vs_planet_detail"
                : (materialType === "horizon")    ? "vs_horizon"
                : displaced                       ? "vs_terrain"
                :                                   "vs_main";
  // Sprint 9-2c: planet_cdlod uses an extended 14-float vertex
  // layout (adds lowPos.xyz at @location(4)). Other variants stay on
  // the standard 11-float layout. Stride matters here -- the
  // pipeline's expected attribute strides must match what
  // _buildSinglePlanetMeshChunk uploads.
  const vertexBuffers = (vsVariant === "planet_cdlod") ? [{
    arrayStride: 14 * 4,
    attributes: [
      { shaderLocation: 0, offset: 0,      format: "float32x3" },  // pos (highPos)
      { shaderLocation: 1, offset: 3 * 4,  format: "float32x3" },  // color
      { shaderLocation: 2, offset: 6 * 4,  format: "float32x3" },  // normal
      { shaderLocation: 3, offset: 9 * 4,  format: "float32x2" },  // uv (x=biomeId, y=morphLow)
      { shaderLocation: 4, offset: 11 * 4, format: "float32x3" }   // lowPos (parent-grid-emulated vertex)
    ]
  }] : [{
    // Vertex layout (sprint 7.5.3c push 6): 11 floats per
    // vertex = position (3) + color (3) + normal (3) + uv (2).
    // Stride 44 bytes. UV added for proper per-mesh texture
    // mapping in ShaderMat(preset=texture); each primitive
    // builder emits a natural mapping for its shape.
    arrayStride: 11 * 4,
    attributes: [
      { shaderLocation: 0, offset: 0,     format: "float32x3" },  // position
      { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },  // color
      { shaderLocation: 2, offset: 6 * 4, format: "float32x3" },  // normal
      { shaderLocation: 3, offset: 9 * 4, format: "float32x2" }   // uv
    ]
  }];
  let pipeline;
  try {
    pipeline = Visual.device.createRenderPipeline({
      label: "mesh-pipeline-" + materialType + "-" + (displaced ? "d-" : "") + sampleCount + "x" + (vsVariant ? ("-" + vsVariant) : ""),
      layout: Visual.meshPipelineLayout,
      vertex: {
        module,
        entryPoint: vsEntry,
        buffers: vertexBuffers
      },
      fragment: {
        module,
        entryPoint: fragEntry,
        targets: [{
          format: Visual.fbFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
          }
        }]
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
        frontFace: "ccw"
      },
      depthStencil: {
        format: "depth32float",
        // §planet-spec Phase 1 -- reverse-Z. Near plane is ndc_z=1,
        // far plane is ndc_z=0. "greater" passes closer-to-near
        // fragments (was "less" under the standard mapping).
        depthCompare: "greater",
        // §5.5.h-14 -- clouds composite the sky background inline
        // and output opaque (alpha=1), so they DO write depth like
        // any other opaque mesh. Water is semi-transparent so it
        // must NOT write depth (objects behind it need to show).
        depthWriteEnabled: materialType !== "water"
      },
      multisample: { count: sampleCount }
    });
  } catch (e) {
    console.warn("[scene] mesh pipeline " + materialType + " " + sampleCount + "x failed:", e);
    if (materialType === "water") {
      console.error("[water] PIPELINE CREATION FAILED. fragEntry=" + fragEntry + " err=", e);
      console.error("[water] this means fs_water has a WGSL error -- check the earlier '[scene] mesh shader WGSL errors:' log for the line + column of the error.");
    }
    if (sampleCount !== 1) {
      console.warn("[scene] falling back to 1x MSAA");
      Visual.msaaSampleCount = 1;
      _ensureMsaa3DTextures();
      _updateMsaaPill();
      return _ensureMeshPipeline(materialType, 1, displaced);
    }
    return null;
  }
  Visual.meshPipelineCache.set(key, pipeline);
  if (materialType === "water") {
    console.log("[water] pipeline created OK. fragEntry=" + fragEntry + " key=" + key);
  }
  if (!_SCENE_DIAG.pipeline) {
    _SCENE_DIAG.pipeline = true;
    console.log("[scene] first mesh pipeline built (" + materialType + ", sampleCount=" + sampleCount + "x, fbFormat=" + Visual.fbFormat + ")");
  }
  return pipeline;
}

/* Sprint plat-2a-render -- sprite WGSL. Reuses the standard 11-float
 * vertex layout (pos3 + color3 + normal3 + uv2) so existing Sprite
 * meshes work unchanged; only the shader and bind-group layout change.
 *
 * The vertex shader composes modelViewProj from the per-draw uniform
 * and remaps the quad's [0,1] UV into the sub-rect for the current
 * frame in a spritesheet. flipX mirrors U for left-facing animations.
 *
 * The fragment shader samples the bound sprite texture, multiplies by
 * the per-draw tint, and outputs premultiplied alpha to match Scene's
 * blend state (srcFactor=ONE, dstFactor=ONE_MINUS_SRC_ALPHA).
 *
 * UV convention: the Sprite mesh builder emits UVs with (0,0) at the
 * BOTTOM-LEFT corner (consistent with the vertex order). Textures
 * have (0,0) at the TOP-LEFT (standard image convention). The shader
 * flips V (v_tex = 1 - v_mesh) so the visible sprite shows the image
 * right-side-up in screen space. */
const _SPRITE_WGSL = `
struct DrawU {
  modelViewProj: mat4x4<f32>,
  tint:          vec4<f32>,        // multiply through after texture sample
  frameMeta:     vec4<f32>,        // .x = frame, .y = framesX, .z = framesY, .w = flipX
};

@group(0) @binding(0) var<uniform> draw: DrawU;
@group(0) @binding(1) var spriteTex: texture_2d<f32>;
@group(0) @binding(2) var spriteSampler: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) tint: vec4<f32>,
};

@vertex
fn vs_sprite(
  @location(0) inPos: vec3<f32>,
  @location(1) inColor: vec3<f32>,
  @location(2) inNormal: vec3<f32>,
  @location(3) inUV: vec2<f32>,
) -> VsOut {
  var out: VsOut;
  out.pos = draw.modelViewProj * vec4<f32>(inPos, 1.0);

  let fx = max(draw.frameMeta.y, 1.0);
  let fy = max(draw.frameMeta.z, 1.0);
  let totalFrames = fx * fy;
  let frame = clamp(draw.frameMeta.x, 0.0, totalFrames - 1.0);
  let frameCol = floor(frame - floor(frame / fx) * fx);  // = frame % fx
  let frameRow = floor(frame / fx);
  let cellW = 1.0 / fx;
  let cellH = 1.0 / fy;

  // Sprite mesh UV: (0,0) bottom-left, (1,1) top-right.
  // Texture UV: (0,0) top-left. Flip V here so the bottom-left of the
  // SPRITE shows the bottom-left of the IMAGE (intuitive for level art).
  var u = inUV.x;
  let v = 1.0 - inUV.y;
  if (draw.frameMeta.w >= 0.5) { u = 1.0 - u; }
  out.uv = vec2<f32>(
    (frameCol + u) * cellW,
    (frameRow + v) * cellH
  );
  // Per-vertex color (from Sprite's tintR/G/B at build time) AND the
  // per-draw tint compose together. Both default to white so the
  // user can choose either path (build-time or animated).
  out.tint = vec4<f32>(inColor, 1.0) * draw.tint;
  return out;
}

@fragment
fn fs_sprite(in: VsOut) -> @location(0) vec4<f32> {
  let texColor = textureSample(spriteTex, spriteSampler, in.uv);
  let result = texColor * in.tint;
  // Premultiplied alpha output (matches mesh-pipeline blend state).
  return vec4<f32>(result.rgb * result.a, result.a);
}
`;

function _ensureSpriteBindGroupLayout() {
  if (Visual.spriteBindGroupLayout) return Visual.spriteBindGroupLayout;
  if (!Visual.device) return null;
  Visual.spriteBindGroupLayout = Visual.device.createBindGroupLayout({
    label: "sprite-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
    ]
  });
  Visual.spritePipelineLayout = Visual.device.createPipelineLayout({
    label: "sprite-pl",
    bindGroupLayouts: [Visual.spriteBindGroupLayout]
  });
  return Visual.spriteBindGroupLayout;
}

function _ensureSpriteShaderModule() {
  if (Visual.spriteShaderModule) return Visual.spriteShaderModule;
  if (!Visual.device) return null;
  let mod;
  try {
    mod = Visual.device.createShaderModule({ label: "sprite-shader", code: _SPRITE_WGSL });
  } catch (e) {
    console.warn("[sprite] shader compile failed:", e);
    return null;
  }
  Visual.spriteShaderModule = mod;
  mod.getCompilationInfo().then(info => {
    const errs = info.messages.filter(m => m.type === "error");
    if (errs.length) {
      console.error("[sprite] shader WGSL errors:");
      for (const m of errs) {
        console.error("  line " + m.lineNum + " col " + m.linePos + ": " + m.message);
      }
    }
  });
  return mod;
}

function _ensureSpritePipeline(sampleCount) {
  const key = sampleCount;
  if (Visual.spritePipelineCache.has(key)) {
    return Visual.spritePipelineCache.get(key);
  }
  if (!Visual.device) return null;
  if (!_ensureSpriteBindGroupLayout()) return null;
  const module = _ensureSpriteShaderModule();
  if (!module) return null;
  let pipeline;
  try {
    pipeline = Visual.device.createRenderPipeline({
      label: "sprite-pipeline-" + sampleCount + "x",
      layout: Visual.spritePipelineLayout,
      vertex: {
        module,
        entryPoint: "vs_sprite",
        buffers: [{
          arrayStride: 11 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0,     format: "float32x3" },  // position
            { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },  // color
            { shaderLocation: 2, offset: 6 * 4, format: "float32x3" },  // normal (unused)
            { shaderLocation: 3, offset: 9 * 4, format: "float32x2" }   // uv
          ]
        }]
      },
      fragment: {
        module,
        entryPoint: "fs_sprite",
        targets: [{
          format: Visual.fbFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
          }
        }]
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
        frontFace: "ccw"
      },
      depthStencil: {
        format: "depth32float",
        // Reverse-Z compare matches the mesh pipeline so sprites
        // composite correctly with 3D meshes in the same scene.
        depthCompare: "greater",
        depthWriteEnabled: true
      },
      multisample: { count: sampleCount }
    });
  } catch (e) {
    console.warn("[sprite] pipeline " + sampleCount + "x failed:", e);
    return null;
  }
  Visual.spritePipelineCache.set(key, pipeline);
  if (!Visual._spriteFirstPipelineLogged) {
    Visual._spriteFirstPipelineLogged = true;
    console.log("[sprite] first pipeline built (sampleCount=" + sampleCount + "x, fbFormat=" + Visual.fbFormat + ")");
  }
  return pipeline;
}

/* Return (or create) a cached GPUSampler for the given filter mode.
 * Sprites with `filterMode: "nearest"` get crisp pixel-art edges;
 * "linear" gets bilinear-filtered smooth sampling. Both clamp at
 * the texture edge (sprite UV is always 0..cellW × 0..cellH, never
 * sampled outside its frame's sub-rect). */
function _ensureSpriteSampler(filterMode, wrapMode) {
  const fk = (filterMode === "linear") ? "linear" : "nearest";
  // Sprint platformer-parallax -- per-axis wrap mode. Parallax layers
  // need repeat-U so the bg can cycle indefinitely as the camera moves
  // through the level without UV running off the texture edge. Default
  // stays clamp so existing Sprite / TileSpriteOverlay behavior doesn't
  // change. wrapMode = "clamp" | "repeat" | "repeat-x" | "repeat-y".
  let wU = "clamp-to-edge", wV = "clamp-to-edge";
  if (wrapMode === "repeat") { wU = "repeat"; wV = "repeat"; }
  else if (wrapMode === "repeat-x") { wU = "repeat"; }
  else if (wrapMode === "repeat-y") { wV = "repeat"; }
  const key = fk + ":" + wU + ":" + wV;
  if (Visual.spriteSamplers.has(key)) return Visual.spriteSamplers.get(key);
  if (!Visual.device) return null;
  const sampler = Visual.device.createSampler({
    label: "sprite-sampler-" + key,
    magFilter: fk,
    minFilter: fk,
    mipmapFilter: fk,
    addressModeU: wU,
    addressModeV: wV
  });
  Visual.spriteSamplers.set(key, sampler);
  return sampler;
}

/* Per-sprite-node draw-state allocator. Creates the uniform buffer +
 * bind group ONCE per sprite node, then updates the bind group only
 * when the bound texture view (or sampler filter mode) changes. The
 * uniform is rewritten every frame from `scratch` via writeBuffer. */
function _ensureSpriteInstance(spriteNode, textureView, sampler) {
  if (!Visual.device) return null;
  let inst = Visual.spriteInstances.get(spriteNode.id);
  if (!inst) {
    const uniformBuffer = Visual.device.createBuffer({
      label: "sprite-draw-uniform-" + spriteNode.id,
      // 24 floats × 4 bytes = 96 bytes; round up to 256 for safety
      // (some implementations want larger min uniform size).
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    inst = {
      uniformBuffer,
      bindGroup: null,
      boundTextureView: null,
      boundSampler: null,
      scratch: new Float32Array(24)
    };
    Visual.spriteInstances.set(spriteNode.id, inst);
  }
  // Rebuild bind group when texture view or sampler swaps (e.g., the
  // ImageURL finishes loading, or the user changes filterMode).
  if (inst.boundTextureView !== textureView || inst.boundSampler !== sampler) {
    inst.bindGroup = Visual.device.createBindGroup({
      label: "sprite-bg-" + spriteNode.id,
      layout: Visual.spriteBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: inst.uniformBuffer } },
        { binding: 1, resource: textureView },
        { binding: 2, resource: sampler }
      ]
    });
    inst.boundTextureView = textureView;
    inst.boundSampler = sampler;
  }
  return inst;
}

/* Sprint 7.5.4.c-sky -- background sky pipeline. Shares the same
 * pipeline layout as mesh pipelines (binding 0 = perScene) but
 * uses a different vertex / fragment entry pair (vs_sky / fs_sky)
 * and depth-state: less-equal compare + no depth write. Drawn AT
 * the end of the Scene mesh draws so the depth buffer is already
 * populated; sky fragments only land on pixels with depth == 1
 * (i.e. nothing covered them). No vertex buffer -- the shader
 * builds its own positions from @builtin(vertex_index). Cached
 * per sample count because pipelines are MSAA-keyed in WebGPU. */
function _ensureSkyPipeline(sampleCount) {
  if (!Number.isFinite(sampleCount) || sampleCount < 1) sampleCount = 1;
  if (!Visual._skyPipelineCache) Visual._skyPipelineCache = new Map();
  const key = "sky-" + sampleCount + "x";
  if (Visual._skyPipelineCache.has(key)) {
    return Visual._skyPipelineCache.get(key);
  }
  if (!Visual.device) return null;
  if (!_ensureMeshBindGroupLayout()) return null;
  // Reuse Visual.meshShaderModule; vs_sky / fs_sky live in the same
  // shared mesh shader source as fs_pbr.
  if (!Visual.meshShaderModule) {
    try {
      Visual.meshShaderModule = Visual.device.createShaderModule({
        label: "mesh-shader", code: _MESH_WGSL
      });
    } catch (e) {
      console.warn("[scene] mesh shader compile failed (sky):", e);
      return null;
    }
  }
  let pipeline;
  try {
    pipeline = Visual.device.createRenderPipeline({
      label: "sky-pipeline-" + sampleCount + "x",
      layout: Visual.meshPipelineLayout,
      vertex: { module: Visual.meshShaderModule, entryPoint: "vs_sky" },
      fragment: {
        module: Visual.meshShaderModule,
        entryPoint: "fs_sky",
        targets: [{ format: Visual.fbFormat }]
      },
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
      depthStencil: {
        format: "depth32float",
        // §planet-spec Phase 1 -- reverse-Z. Sky vertex writes ndc_z=0
        // (the new "far plane"); pass where depth still == 0 (no mesh
        // has drawn anything closer to ndc_z=1).
        depthCompare: "greater-equal",
        depthWriteEnabled: false
      },
      multisample: { count: sampleCount }
    });
  } catch (e) {
    console.warn("[scene] sky pipeline " + sampleCount + "x failed:", e);
    return null;
  }
  Visual._skyPipelineCache.set(key, pipeline);
  return pipeline;
}

/* ========================================================================
 * Sprint 7.6.b-atm Tier C -- atmosphere precomputation LUTs (Hillaire 2020).
 * ========================================================================
 *
 * Two small textures regenerated each frame and sampled by fs_sky /
 * _atm_integrate for fast lookup instead of re-integrating per-pixel:
 *
 *   transmittance LUT  (256 x 64,  rgba16float)
 *     Per (altitude, viewZenith) pair, the Beer-Lambert sun extinction
 *     exp(-Σβ τ) for a ray that exits the atmosphere shell. Replaces
 *     the inner sun-ray loop in _atm_integrate's per-sample work.
 *
 *   multi-scattering LUT (32 x 32, rgba16float)
 *     Per (altitude, sunZenithCos) pair, the isotropic second-bounce
 *     contribution averaged over sphere directions. THIS is the term
 *     that lights the shadowed side of the atmosphere (single-scatter
 *     only lights the sun-facing side). User-visible: limb glow no
 *     longer biased toward the sun in orbital screenshots.
 *
 * Both LUTs are computed via fullscreen render-to-texture passes (a
 * choice over compute pipelines for parity with the rest of the
 * editor's WebGPU surface area; the LUTs are tiny and a render pass
 * was already a well-trodden path). One uniform buffer feeds the
 * planet/atmosphere params -- the same shape as PerScene's
 * envPlanet / envPlanetAtm / envPlanetGeom slots so the math lines up
 * with what _atm_integrate already computes.
 *
 * Layout:
 *   _ATM_LUT_WGSL                  -- the two LUT fragment shaders
 *   _ensureAtmosphereLUTs()        -- texture + pipeline + sampler init
 *   _renderAtmosphereLUTs(enc, …)  -- per-frame dispatch
 *   Visual.atmLutUniformBuffer     -- 64-byte UBO (4 vec4s)
 *   Visual.atmTransmittanceLUT/View
 *   Visual.atmMultiScatterLUT/View
 *   Visual.atmLutSampler           -- linear, clamp-to-edge
 *   Visual.atmLut1x1Default/View   -- 1x1 black default bound when no
 *                                     planet is wired (mesh BGL parity)
 * ====================================================================== */

const _ATM_LUT_WGSL = `
// ATM_PARAMS layout matches the JS-side _atmLutScratch pack:
//   planet.xyz        = planet center (unused inside LUTs; shells are
//                        computed in planet-local space).
//   planet.w          = planet surface radius (world units).
//   atm.x             = atmosphere top radius.
//   atm.y             = Rayleigh scale height.
//   atm.z             = Mie scale height.
//   atm.w             = sun irradiance multiplier.
//   sun.xyz           = world-space direction TO sun (unused in
//                        transmittance LUT; multi-scatter LUT
//                        synthesizes its own sun dir from sunZenith).
//   sun.w             = mieG (forward-scatter anisotropy).
//   misc.x            = turbidity (Mie multiplier).
//   misc.y            = polRatio (unused in LUTs -- atmosphere shell
//                        is treated as a sphere for LUT purposes; the
//                        oblateness is < 0.4% and the LUT axes don't
//                        depend on planet orientation).
//   misc.z            = LUT_WIDTH (transmittance LUT only; informational).
//   misc.w            = LUT_HEIGHT.
struct AtmParams {
  planet: vec4<f32>,
  atm:    vec4<f32>,
  sun:    vec4<f32>,
  misc:   vec4<f32>,
  // C.4 -- camera info for sky-view LUT. .xyz = world-space camera
  // position; .w reserved (precomputed altitude if useful later).
  // Transmittance + multi-scatter LUTs ignore this slot.
  camera: vec4<f32>,
  // C.7 cleanup -- camera basis (camRight/Up/Forward) was packed
  // here for the now-removed aerial-perspective LUT. Sky-view LUT
  // computes its own local frame from camera + planet center, so no
  // basis is needed any more.
};
@group(0) @binding(0) var<uniform> uA: AtmParams;

// C.7 cleanup -- AerialSlice / uASlice / fs_lut_aerial all removed
// after the structural fix; only the in-scatter (transmittance,
// multi-scatter, sky-view) LUTs remain.

const ATM_EARTH_R: f32 = 6371000.0;

// Beer-Lambert per-channel extinction from a planet-local origin in
// the indicated direction, integrating until the atmosphere shell
// exit (or planet ground, whichever comes first). Returns
// exp(-(βR * τR + βM * 1.1 * τM)) so the consumer multiplies it
// straight into sun irradiance.
fn atm_transmittance_local(
  origin: vec3<f32>,
  dir:    vec3<f32>,
  planetR: f32,
  atmR:    f32,
  scaleHR: f32,
  scaleHM: f32,
  turbidity: f32,
  unitScale: f32,
) -> vec3<f32> {
  let b = dot(origin, dir);
  let cAtm = dot(origin, origin) - atmR * atmR;
  let hAtm = b * b - cAtm;
  if (hAtm < 0.0) { return vec3<f32>(1.0); }
  let sAtm = sqrt(hAtm);
  let tExit = max(-b + sAtm, 0.0);
  // If origin is inside atmosphere & ray escapes, tExit is the path
  // length to the far shell. Clip to ground if needed.
  var tEnd = tExit;
  let cGnd = dot(origin, origin) - planetR * planetR;
  let hGnd = b * b - cGnd;
  if (hGnd > 0.0) {
    let sGnd = sqrt(hGnd);
    let tG = -b - sGnd;
    if (tG > 0.0 && tG < tEnd) { tEnd = tG; }
  }
  if (tEnd <= 0.0) { return vec3<f32>(1.0); }
  let SAMPLES: i32 = 32;
  let dt = tEnd / f32(SAMPLES);
  var opticalR: f32 = 0.0;
  var opticalM: f32 = 0.0;
  for (var i: i32 = 0; i < SAMPLES; i = i + 1) {
    let t = (f32(i) + 0.5) * dt;
    let p = origin + dir * t;
    let h = max(0.0, length(p) - planetR);
    opticalR = opticalR + exp(-h / scaleHR) * dt;
    opticalM = opticalM + exp(-h / scaleHM) * dt;
  }
  let betaR = vec3<f32>(5.8e-6, 13.5e-6, 33.1e-6) * unitScale;
  let betaM = vec3<f32>(21.0e-6) * unitScale * turbidity;
  return exp(-(betaR * opticalR + betaM * 1.1 * opticalM));
}

struct VsLutOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_lut(@builtin(vertex_index) vid: u32) -> VsLutOut {
  // Oversized fullscreen triangle; uv covers [0,1]^2 over the
  // visible viewport quadrant.
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>( 3.0,  1.0),
    vec2<f32>(-1.0,  1.0)
  );
  let p = positions[vid];
  var out: VsLutOut;
  out.pos = vec4<f32>(p.x, p.y, 0.5, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
  return out;
}

// Transmittance LUT pixel. Maps screen-space uv to (viewZenithCos,
// altitude) with sqrt non-linearity (more samples near horizon and
// near ground where atmospheric detail is highest).
@fragment
fn fs_lut_transmittance(in: VsLutOut) -> @location(0) vec4<f32> {
  let planetR = uA.planet.w;
  let atmR    = uA.atm.x;
  let scaleHR = uA.atm.y;
  let scaleHM = uA.atm.z;
  let turbidity = max(uA.misc.x, 0.5);

  if (planetR <= 0.0 || atmR <= planetR) {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
  }

  // Axes: u in [0,1] -> cosVZ in [-1, 1] with sqrt remapping.
  //       v in [0,1] -> alt in [0, atmThickness] with sqrt remapping.
  let u = clamp(in.uv.x, 0.0, 1.0);
  let v = clamp(in.uv.y, 0.0, 1.0);
  let cosVZ  = 2.0 * (u * u) - 1.0;
  let sinVZ  = sqrt(max(0.0, 1.0 - cosVZ * cosVZ));
  let atmThk = atmR - planetR;
  let alt    = (v * v) * atmThk;

  // Planet-local frame: ground "up" = +Y, view direction in YZ plane.
  let origin = vec3<f32>(0.0, planetR + alt, 0.0);
  let dir    = vec3<f32>(0.0, cosVZ, sinVZ);

  let unitScale = ATM_EARTH_R / planetR;
  let T = atm_transmittance_local(origin, dir, planetR, atmR,
                                   scaleHR, scaleHM, turbidity, unitScale);
  return vec4<f32>(T, 1.0);
}

@group(0) @binding(1) var ttex: texture_2d<f32>;
@group(0) @binding(2) var mtex: texture_2d<f32>;
@group(0) @binding(3) var tsamp: sampler;

// Sample the transmittance LUT for an arbitrary (altitude,
// viewZenithCos) pair. Matches the axis mapping used by
// fs_lut_transmittance so the round-trip is exact (modulo bilinear
// filtering). The LUT is sampled with clamp-to-edge so out-of-range
// queries fall back to the nearest valid value.
//
// 2026-05-22 fix: WebGPU NDC.y=+1 maps to framebuffer pixel.y=0 (top),
// but sampler UV.v=0 ALSO maps to pixel.y=0. So NDC.y and UV.v are
// INVERSE-related. The LUT is written with high-altitude / zenith at
// the top row (UV.v=0); to read it back we must invert v.
fn sample_transmittance_lut(
  T: texture_2d<f32>, S: sampler,
  cosVZ: f32, alt: f32, atmThickness: f32,
) -> vec3<f32> {
  let u = sqrt(clamp(cosVZ * 0.5 + 0.5, 0.0, 1.0));
  let v = sqrt(clamp(alt / max(atmThickness, 1.0), 0.0, 1.0));
  return textureSampleLevel(T, S, vec2<f32>(u, 1.0 - v), 0.0).rgb;
}

// C.4 -- helpers using the module-scope bindings (cleaner sample sites
// in fs_lut_skyview where we sample both LUTs per ray sample).
fn _lut_T(cosVZ: f32, alt: f32, atmThk: f32) -> vec3<f32> {
  return sample_transmittance_lut(ttex, tsamp, cosVZ, alt, atmThk);
}
fn _lut_MS(cosSZ: f32, alt: f32, atmThk: f32) -> vec3<f32> {
  let u = clamp(cosSZ * 0.5 + 0.5, 0.0, 1.0);
  let v = sqrt(clamp(alt / max(atmThk, 1.0), 0.0, 1.0));
  return textureSampleLevel(mtex, tsamp, vec2<f32>(u, 1.0 - v), 0.0).rgb;
}

// Multi-scattering LUT pixel. Computes the isotropic-bounce
// contribution to in-scatter for a point at the given altitude with
// the sun at the given zenith. Uses the transmittance LUT for fast
// per-direction attenuation. The integral averages over sphere
// directions (Fibonacci-ish), accumulating direct single-scatter
// for the second bounce; the result is what the view-ray integrator
// adds at each sample point to account for multi-bounce light.
//
// Reference: Hillaire 2020 §5 "Multiple Scattering".
@fragment
fn fs_lut_multiscatter(in: VsLutOut) -> @location(0) vec4<f32> {
  let planetR = uA.planet.w;
  let atmR    = uA.atm.x;
  let scaleHR = uA.atm.y;
  let scaleHM = uA.atm.z;
  let turbidity = max(uA.misc.x, 0.5);

  if (planetR <= 0.0 || atmR <= planetR) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // Axes: u -> cosSZ in [-1, 1] (linear). v -> alt with sqrt.
  let u = clamp(in.uv.x, 0.0, 1.0);
  let v = clamp(in.uv.y, 0.0, 1.0);
  let cosSZ  = 2.0 * u - 1.0;
  let sinSZ  = sqrt(max(0.0, 1.0 - cosSZ * cosSZ));
  let atmThk = atmR - planetR;
  let alt    = (v * v) * atmThk;

  let origin = vec3<f32>(0.0, planetR + alt, 0.0);
  let sunDir = vec3<f32>(0.0, cosSZ, sinSZ);

  let unitScale = ATM_EARTH_R / planetR;
  let betaR = vec3<f32>(5.8e-6, 13.5e-6, 33.1e-6) * unitScale;
  let betaM = vec3<f32>(21.0e-6) * unitScale * turbidity;

  // Sphere-direction averaging. SQRT_N x SQRT_N samples over the
  // sphere using equal-area mapping (lat in [-1,1], lon in [0, 2π)).
  // 8x8 = 64 directions per pixel is the Hillaire-paper default;
  // multi-scattering is smooth so this is plenty.
  let SQRT_N: i32 = 8;
  let TOTAL = f32(SQRT_N * SQRT_N);
  var L = vec3<f32>(0.0);
  var FMS = vec3<f32>(0.0);
  for (var i: i32 = 0; i < SQRT_N; i = i + 1) {
    for (var j: i32 = 0; j < SQRT_N; j = j + 1) {
      let randU = (f32(i) + 0.5) / f32(SQRT_N);
      let randV = (f32(j) + 0.5) / f32(SQRT_N);
      let phi = 2.0 * 3.14159265 * randU;
      let cosT = 1.0 - 2.0 * randV;
      let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
      let rayDir = vec3<f32>(sinT * cos(phi), cosT, sinT * sin(phi));

      // March along this direction. Capture single-scatter sum plus
      // an "amount of light that escapes back to space" factor (FMS)
      // that the consumer multiplies for the geometric series sum.
      let b = dot(origin, rayDir);
      let cAtm = dot(origin, origin) - atmR * atmR;
      let hAtm = b * b - cAtm;
      if (hAtm < 0.0) { continue; }
      let sAtm = sqrt(hAtm);
      var tEnd = max(-b + sAtm, 0.0);
      let cGnd = dot(origin, origin) - planetR * planetR;
      let hGnd = b * b - cGnd;
      var hitGround = false;
      if (hGnd > 0.0) {
        let tG = -b - sqrt(hGnd);
        if (tG > 0.0 && tG < tEnd) { tEnd = tG; hitGround = true; }
      }
      if (tEnd <= 0.0) { continue; }
      let M: i32 = 20;
      let dt = tEnd / f32(M);
      var tau = vec3<f32>(0.0);
      var L_dir = vec3<f32>(0.0);
      var Fms_dir = vec3<f32>(0.0);
      for (var k: i32 = 0; k < M; k = k + 1) {
        let t = (f32(k) + 0.5) * dt;
        let p = origin + rayDir * t;
        let h = max(0.0, length(p) - planetR);
        let densR = exp(-h / scaleHR);
        let densM = exp(-h / scaleHM);
        let dTau  = (betaR * densR + betaM * 1.1 * densM) * dt;
        let tauMid = tau + dTau * 0.5;
        let T_view = exp(-tauMid);
        // Sun transmittance from p along sun direction, via the LUT.
        let upDir   = normalize(p);
        let cosVZsun = dot(upDir, sunDir);
        let T_sun = sample_transmittance_lut(ttex, tsamp,
                      cosVZsun, h, atmThk);
        // Sun visible only if no planet shadow along sun ray.
        let bp = dot(p, sunDir);
        let cgp = dot(p, p) - planetR * planetR;
        let hg = bp * bp - cgp;
        var sunVis = 1.0;
        if (hg > 0.0) {
          let tg = -bp - sqrt(hg);
          if (tg > 0.0) { sunVis = 0.0; }
        }
        let scatter = (betaR * densR + betaM * densM);
        // Single-bounce contribution at this sample (isotropic phase
        // 1/4π absorbed into the LUT, since we're averaging over
        // sphere directions anyway).
        L_dir = L_dir + T_view * scatter * T_sun * sunVis * dt;
        // Multi-scatter "feedback" coefficient: how much energy stays
        // in atmosphere (Hillaire eq. 7).
        Fms_dir = Fms_dir + T_view * scatter * dt;
        tau = tau + dTau;
      }
      L  = L  + L_dir;
      FMS = FMS + Fms_dir;
    }
  }
  L  = L  / TOTAL;
  FMS = FMS / TOTAL;
  // Closed-form geometric series for infinite-bounce multi-scattering:
  //   Lmulti = L / (1 - FMS)
  // FMS is clamped < 1 to keep the series convergent.
  let one = vec3<f32>(1.0);
  let denom = max(one - FMS, vec3<f32>(0.001));
  let Lmulti = L / denom;
  return vec4<f32>(Lmulti, 1.0);
}

// C.4 -- Sky-view LUT pixel. The LUT encodes the integrated sky color
// as seen from the CURRENT camera position, indexed by (azimuth,
// elevation) in the camera's LOCAL frame (zenith-aligned with the
// planet-radial direction; north reference = world +Y projected to
// the horizon plane, falling back to +X near the poles).
//
// Per-pixel work:
//   1. Decode uv -> (azimuth, elevation), with horizon-weighted v.
//   2. Build the world-space ray direction.
//   3. Ray-march atmosphere from the camera, sampling the precomputed
//      transmittance + multi-scatter LUTs per step.
//
// 30 view samples + 2 LUT lookups each = much cheaper than the 16x8
// double integral in the legacy per-pixel sky shader; fs_sky in the
// mesh module then becomes one texture lookup.
@fragment
fn fs_lut_skyview(in: VsLutOut) -> @location(0) vec4<f32> {
  let planetC = uA.planet.xyz;
  let planetR = uA.planet.w;
  let atmR    = uA.atm.x;
  let scaleHR = uA.atm.y;
  let scaleHM = uA.atm.z;
  let sunI    = uA.atm.w;
  let sunDir  = uA.sun.xyz;
  let mieG    = uA.sun.w;
  let turbidity = max(uA.misc.x, 0.5);
  let eye     = uA.camera.xyz;

  if (planetR <= 0.0 || atmR <= planetR) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // Local frame.
  let radial = eye - planetC;
  let radialLen = length(radial);
  if (radialLen < 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let localUp = radial / radialLen;
  var northRef = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(dot(localUp, northRef)) > 0.99) {
    northRef = vec3<f32>(1.0, 0.0, 0.0);
  }
  let localNorth = normalize(northRef - dot(northRef, localUp) * localUp);
  let localEast  = cross(localUp, localNorth);

  // C.6 -- limb-aware v-axis. The "limb" is the angle (below horizon)
  // where the planet's silhouette sits from the camera; for a surface
  // observer it coincides with the horizon (limb=0), for orbit it
  // approaches -π/2 (nadir). Putting v=0.5 at the limb keeps maximum
  // resolution at the visible planet edge at every altitude, which
  // fixes the every-50km pulsing the prior horizon-anchored mapping
  // showed. Above the limb is sky, below is planet body.
  let sinBeta  = clamp(planetR / max(radialLen, planetR + 1.0), 0.0, 1.0);
  let limbElev = asin(sinBeta) - 1.5707963;  // in [-π/2, 0]

  let azimuth = in.uv.x * 6.28318530718 - 3.14159265359;
  var elevation: f32;
  if (in.uv.y >= 0.5) {
    let t = (in.uv.y - 0.5) * 2.0;
    elevation = limbElev + (1.5707963 - limbElev) * t * t;
  } else {
    let t = (0.5 - in.uv.y) * 2.0;
    elevation = limbElev - (limbElev + 1.5707963) * t * t;
  }
  let cosEl = cos(elevation);
  let sinEl = sin(elevation);
  let sinAz = sin(azimuth);
  let cosAz = cos(azimuth);
  let dir = localEast * (sinAz * cosEl)
          + localUp   *  sinEl
          + localNorth * (cosAz * cosEl);

  let atmThk = atmR - planetR;
  let unitScale = ATM_EARTH_R / planetR;
  let betaR = vec3<f32>(5.8e-6, 13.5e-6, 33.1e-6) * unitScale;
  let betaM = vec3<f32>(21.0e-6) * unitScale * turbidity;

  // Ray-atmosphere intersect (sphere; oblateness is < 0.4% and the LUT
  // doesn't carry polRatio).
  let oc = eye - planetC;
  let b  = dot(oc, dir);
  let cAtm = dot(oc, oc) - atmR * atmR;
  let hAtm = b * b - cAtm;
  if (hAtm < 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let sAtm = sqrt(hAtm);
  var t0 = max(-b - sAtm, 0.0);
  var t1 = -b + sAtm;
  let cGnd = dot(oc, oc) - planetR * planetR;
  let hGnd = b * b - cGnd;
  if (hGnd > 0.0) {
    let tg = -b - sqrt(hGnd);
    if (tg > 0.0 && tg < t1) { t1 = tg; }
  }
  let segLen = t1 - t0;
  if (segLen <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }

  // Phase functions.
  let cosTheta = dot(dir, sunDir);
  let cos2 = cosTheta * cosTheta;
  let phaseR = 0.0596831 * (1.0 + cos2);
  let g = clamp(mieG, 0.0, 0.95);
  let g2 = g * g;
  let mDenom = pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
  let phaseM = 0.1193662 * (1.0 - g2) * (1.0 + cos2) / ((2.0 + g2) * mDenom);

  // C.7 -- importance sampling. Match the aerial-perspective LUT's
  // approach: concentrate samples near the end of the segment closest
  // to the planet ground (densest atmosphere). Bump 48 -> 64 samples
  // alongside the remap.
  let h_at_t0 = max(0.0, length(eye + dir * t0 - planetC) - planetR);
  let h_at_t1 = max(0.0, length(eye + dir * t1 - planetC) - planetR);
  let concAtEnd: f32 = select(0.0, 1.0, h_at_t0 > h_at_t1);

  let SAMPLES: i32 = 64;
  let invN = 1.0 / f32(SAMPLES);
  var inScatter   = vec3<f32>(0.0);
  var transmittance = vec3<f32>(1.0);

  for (var i: i32 = 0; i < SAMPLES; i = i + 1) {
    let u = (f32(i) + 0.5) * invN;
    let gLow  = u * u;
    let gHigh = 1.0 - (1.0 - u) * (1.0 - u);
    let dgLow  = 2.0 * u;
    let dgHigh = 2.0 * (1.0 - u);
    let uMapped = mix(gLow,  gHigh,  concAtEnd);
    let dgScale = mix(dgLow, dgHigh, concAtEnd);
    let t  = t0 + segLen * uMapped;
    let dt = segLen * dgScale * invN;
    let p = eye + dir * t;
    let pRadial = p - planetC;
    let h = max(0.0, length(pRadial) - planetR);
    let densR = exp(-h / scaleHR);
    let densM = exp(-h / scaleHM);
    let dTau  = (betaR * densR + betaM * 1.1 * densM) * dt;
    let segT  = exp(-dTau);

    // Sun ray from p.
    let pUp = pRadial / max(length(pRadial), 1.0);
    let cosVZsun = dot(pUp, sunDir);
    let sunT = _lut_T(cosVZsun, h, atmThk);

    // Sun shadowed by planet?
    let bp = dot(pRadial, sunDir);
    let cgp = dot(pRadial, pRadial) - planetR * planetR;
    let hg = bp * bp - cgp;
    var sunVis = 1.0;
    if (hg > 0.0) {
      let tg = -bp - sqrt(hg);
      if (tg > 0.0) { sunVis = 0.0; }
    }

    // Single scatter from this sample.
    let singleR = betaR * phaseR * densR;
    let singleM = betaM * phaseM * densM;
    let single = (singleR + singleM) * sunT * sunVis;

    // Multi-scatter from this sample (scaled to match the consumer-side
    // weighting we use in _atm_integrate's planet-aware path).
    let ms = _lut_MS(cosVZsun, h, atmThk);
    let scatter = betaR * densR + betaM * densM;
    let MS_SCALE: f32 = 0.15;
    let multi = ms * scatter * MS_SCALE;

    let contrib = (single + multi) * transmittance * dt;
    inScatter = inScatter + contrib;
    transmittance = transmittance * segT;
  }

  // sunI absorbed into the returned in-scatter so fs_sky's sample is
  // ready-to-use without further scaling.
  return vec4<f32>(inScatter * sunI, 1.0);
}

// C.7 cleanup -- fs_lut_aerial + AerialOut + AerialSlice / uASlice
// were here. ~180 LOC of per-voxel ray-marching against the
// exponential atmospheric density curve, removed after the
// structural fix moved aerial perspective onto the existing
// sky-view + transmittance LUTs (no depth axis = no ring aliasing).
`;

function _ensureAtmosphereLUTs() {
  if (!Visual.device) return null;
  if (Visual._atmLutsReady) return Visual._atmLutsReady;

  const dev = Visual.device;

  // Default 1x1 textures for "no planet wired" -- BGL needs a binding
  // even when LUTs aren't meaningful. Black RGBA so any accidental
  // sample returns zero contribution.
  if (!Visual.atmLut1x1Default) {
    Visual.atmLut1x1Default = dev.createTexture({
      label: "atm-lut-default-1x1",
      size: [1, 1, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const zero = new Uint16Array([0, 0, 0, 0]);
    dev.queue.writeTexture(
      { texture: Visual.atmLut1x1Default },
      zero,
      { bytesPerRow: 8 },
      { width: 1, height: 1, depthOrArrayLayers: 1 }
    );
    Visual.atmLut1x1DefaultView = Visual.atmLut1x1Default.createView({
      label: "atm-lut-default-1x1-view"
    });
  }

  if (!Visual.atmTransmittanceLUT) {
    Visual.atmTransmittanceLUT = dev.createTexture({
      label: "atm-transmittance-lut-256x64",
      size: [256, 64, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    Visual.atmTransmittanceLUTView = Visual.atmTransmittanceLUT.createView({
      label: "atm-transmittance-lut-view"
    });
  }
  if (!Visual.atmMultiScatterLUT) {
    Visual.atmMultiScatterLUT = dev.createTexture({
      label: "atm-multiscatter-lut-32x32",
      size: [32, 32, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    Visual.atmMultiScatterLUTView = Visual.atmMultiScatterLUT.createView({
      label: "atm-multiscatter-lut-view"
    });
  }
  // C.4 -- Sky-view LUT. 384 x 216 covers the full sphere in
  // (azimuth, elevation) with horizon-weighted v for finer sampling
  // near the horizon where atmospheric detail is highest. Regenerated
  // every frame in lock-step with the camera position.
  //
  // 2026-05-22 bump 192x108 -> 384x216: at orbital altitudes the
  // limb angle from nadir is acos(planetR/(planetR+h)) which shifts
  // about 0.7 LUT rows per 50km of altitude on the previous
  // resolution; the row boundary moving across the limb produced a
  // visible brightness "pulse" as the user climbed. 4x pixels at
  // 256-byte cost per pixel is still tiny; LUT generation stays
  // sub-millisecond on modern GPUs.
  if (!Visual.atmSkyViewLUT) {
    Visual.atmSkyViewLUT = dev.createTexture({
      label: "atm-skyview-lut-384x216",
      size: [384, 216, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    Visual.atmSkyViewLUTView = Visual.atmSkyViewLUT.createView({
      label: "atm-skyview-lut-view"
    });
  }
  // C.7 cleanup -- the aerial-perspective LUT pair (3D-style 2D-array
  // textures + per-layer views + their pipeline + slice buffer +
  // slice BGL) used to live here. Removed after the structural fix
  // (sample_aerial_perspective_lut now reads sky-view + transmittance
  // LUTs directly with no depth axis = no ring banding). Frees ~128 MB
  // of GPU memory and ~128 render passes / frame.

  if (!Visual.atmLutSampler) {
    Visual.atmLutSampler = dev.createSampler({
      label: "atm-lut-sampler",
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge"
    });
  }

  if (!Visual.atmLutUniformBuffer) {
    Visual.atmLutUniformBuffer = dev.createBuffer({
      label: "atm-lut-uniforms",
      // 5 * vec4<f32> = 80 bytes (planet, atm, sun, misc, camera). The
      // camera basis slots that C.5 added were dropped in C.7 cleanup
      // alongside the aerial-perspective LUT removal.
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    Visual.atmLutScratch = new Float32Array(20);
  }
  // C.7 cleanup -- slice buffer / scratch removed alongside the
  // aerial-perspective LUT pipeline.

  if (!Visual.atmLutShaderModule) {
    try {
      Visual.atmLutShaderModule = dev.createShaderModule({
        label: "atm-lut-shader", code: _ATM_LUT_WGSL
      });
    } catch (e) {
      console.warn("[atm-lut] shader module compile failed:", e);
      return null;
    }
  }

  // All three LUT pipelines share a single BGL:
  //   0 = uniform buffer (planet + atm + sun + misc + camera)
  //   1 = transmittance LUT texture (sampled by multi-scatter + sky-view)
  //   2 = multi-scatter LUT texture (sampled by sky-view)
  //   3 = linear/clamp sampler
  // Bindings the entry-point doesn't reach (e.g. ttex/mtex in
  // fs_lut_transmittance) are still required to be present in the
  // bind group; we point them at the 1x1 default.
  if (!Visual.atmLutBGL) {
    Visual.atmLutBGL = dev.createBindGroupLayout({
      label: "atm-lut-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
      ]
    });
  }

  if (!Visual.atmTransmittancePipeline) {
    try {
      Visual.atmTransmittancePipeline = dev.createRenderPipeline({
        label: "atm-transmittance-pipeline",
        layout: dev.createPipelineLayout({
          label: "atm-lut-pl",
          bindGroupLayouts: [Visual.atmLutBGL]
        }),
        vertex:   { module: Visual.atmLutShaderModule, entryPoint: "vs_lut" },
        fragment: {
          module: Visual.atmLutShaderModule,
          entryPoint: "fs_lut_transmittance",
          targets: [{ format: "rgba16float" }]
        },
        primitive: { topology: "triangle-list", cullMode: "none" }
      });
    } catch (e) {
      console.warn("[atm-lut] transmittance pipeline failed:", e);
      return null;
    }
  }
  if (!Visual.atmMultiScatterPipeline) {
    try {
      Visual.atmMultiScatterPipeline = dev.createRenderPipeline({
        label: "atm-multiscatter-pipeline",
        layout: dev.createPipelineLayout({
          label: "atm-lut-pl-ms",
          bindGroupLayouts: [Visual.atmLutBGL]
        }),
        vertex:   { module: Visual.atmLutShaderModule, entryPoint: "vs_lut" },
        fragment: {
          module: Visual.atmLutShaderModule,
          entryPoint: "fs_lut_multiscatter",
          targets: [{ format: "rgba16float" }]
        },
        primitive: { topology: "triangle-list", cullMode: "none" }
      });
    } catch (e) {
      console.warn("[atm-lut] multi-scatter pipeline failed:", e);
      return null;
    }
  }
  if (!Visual.atmSkyViewPipeline) {
    try {
      Visual.atmSkyViewPipeline = dev.createRenderPipeline({
        label: "atm-skyview-pipeline",
        layout: dev.createPipelineLayout({
          label: "atm-lut-pl-sv",
          bindGroupLayouts: [Visual.atmLutBGL]
        }),
        vertex:   { module: Visual.atmLutShaderModule, entryPoint: "vs_lut" },
        fragment: {
          module: Visual.atmLutShaderModule,
          entryPoint: "fs_lut_skyview",
          targets: [{ format: "rgba16float" }]
        },
        primitive: { topology: "triangle-list", cullMode: "none" }
      });
    } catch (e) {
      console.warn("[atm-lut] sky-view pipeline failed:", e);
      return null;
    }
  }

  // Bind groups: each LUT pipeline reads only the LUTs that came before
  // it. The 1x1 default fills slots the entry point never reaches.
  if (!Visual.atmTransmittanceBindGroup) {
    Visual.atmTransmittanceBindGroup = dev.createBindGroup({
      label: "atm-transmittance-bg",
      layout: Visual.atmLutBGL,
      entries: [
        { binding: 0, resource: { buffer: Visual.atmLutUniformBuffer } },
        { binding: 1, resource: Visual.atmLut1x1DefaultView },
        { binding: 2, resource: Visual.atmLut1x1DefaultView },
        { binding: 3, resource: Visual.atmLutSampler }
      ]
    });
  }
  if (!Visual.atmMultiScatterBindGroup) {
    Visual.atmMultiScatterBindGroup = dev.createBindGroup({
      label: "atm-multiscatter-bg",
      layout: Visual.atmLutBGL,
      entries: [
        { binding: 0, resource: { buffer: Visual.atmLutUniformBuffer } },
        { binding: 1, resource: Visual.atmTransmittanceLUTView },
        { binding: 2, resource: Visual.atmLut1x1DefaultView },
        { binding: 3, resource: Visual.atmLutSampler }
      ]
    });
  }
  if (!Visual.atmSkyViewBindGroup) {
    Visual.atmSkyViewBindGroup = dev.createBindGroup({
      label: "atm-skyview-bg",
      layout: Visual.atmLutBGL,
      entries: [
        { binding: 0, resource: { buffer: Visual.atmLutUniformBuffer } },
        { binding: 1, resource: Visual.atmTransmittanceLUTView },
        { binding: 2, resource: Visual.atmMultiScatterLUTView },
        { binding: 3, resource: Visual.atmLutSampler }
      ]
    });
  }

  // C.7 cleanup -- aerial-perspective slice BGL, slice bind group,
  // and pipeline removed.

  Visual._atmLutsReady = true;
  return true;
}

/* Per-frame dispatch: writes both LUTs assuming the caller has a
 * GPUCommandEncoder open. Called by the visual frame loop ONCE per
 * frame BEFORE any scene pass that might sample the LUTs. The same
 * LUTs are shared across all scenes in a frame -- the planet params
 * shouldn't change mid-frame, and the LUTs are camera-independent. */
function _renderAtmosphereLUTs(enc, planetInfo, camera, sunDirOverride) {
  if (!_ensureAtmosphereLUTs()) return false;
  // Skip LUT regeneration when no planet is wired -- the BGL has the
  // 1x1 default bound at the mesh-pass binding and _atm_integrate
  // guards on uS.envPlanet.w > 0 anyway.
  if (!planetInfo || !(planetInfo.radius > 0)) {
    Visual._atmLutsHavePlanetData = false;
    return false;
  }

  const dev = Visual.device;
  const planetR = planetInfo.radius;
  const atmTop  = planetR * 1.0157;
  const scaleHR = planetR * 0.001334;
  const scaleHM = planetR * 0.000188;
  const sunI    = 22.0;
  const turbidity = (typeof planetInfo.turbidity === "number") ? planetInfo.turbidity : 1.3;
  const polRatio  = (typeof planetInfo.polRatio  === "number" && planetInfo.polRatio > 0)
    ? planetInfo.polRatio : 1.0;
  const sunDir = (sunDirOverride && sunDirOverride.length >= 3)
    ? sunDirOverride
    : ((planetInfo.sunDir && planetInfo.sunDir.length >= 3)
        ? planetInfo.sunDir
        : [0, 1, 0]);
  // Sky-view LUT only needs the camera position (the local frame is
  // derived in-shader from eye - planetCenter).
  const eye = (camera && camera.eye) ? camera.eye : [0, 0, 0];

  const u = Visual.atmLutScratch;
  u[0] = planetInfo.centerX || 0;
  u[1] = planetInfo.centerY || 0;
  u[2] = planetInfo.centerZ || 0;
  u[3] = planetR;
  u[4] = atmTop;
  u[5] = scaleHR;
  u[6] = scaleHM;
  u[7] = sunI;
  u[8]  = sunDir[0]; u[9] = sunDir[1]; u[10] = sunDir[2];
  u[11] = (typeof planetInfo.mieG === "number") ? planetInfo.mieG : 0.76;
  u[12] = turbidity;
  u[13] = polRatio;
  u[14] = 256;
  u[15] = 64;
  // C.4 camera slot. (C.5's camera-basis vec4s were here too; removed
  // in C.7 cleanup alongside the aerial-perspective LUT.)
  u[16] = eye[0]; u[17] = eye[1]; u[18] = eye[2]; u[19] = 0;

  dev.queue.writeBuffer(Visual.atmLutUniformBuffer, 0, u.buffer, 0, 80);

  // Transmittance LUT.
  {
    const pass = enc.beginRenderPass({
      label: "atm-transmittance-lut-pass",
      colorAttachments: [{
        view: Visual.atmTransmittanceLUTView,
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(Visual.atmTransmittancePipeline);
    pass.setBindGroup(0, Visual.atmTransmittanceBindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }
  // Multi-scattering LUT (samples transmittance LUT just written).
  {
    const pass = enc.beginRenderPass({
      label: "atm-multiscatter-lut-pass",
      colorAttachments: [{
        view: Visual.atmMultiScatterLUTView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(Visual.atmMultiScatterPipeline);
    pass.setBindGroup(0, Visual.atmMultiScatterBindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }
  // Sky-view LUT (samples transmittance + multi-scatter LUTs).
  if (Visual.atmSkyViewPipeline && Visual.atmSkyViewBindGroup) {
    const pass = enc.beginRenderPass({
      label: "atm-skyview-lut-pass",
      colorAttachments: [{
        view: Visual.atmSkyViewLUTView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(Visual.atmSkyViewPipeline);
    pass.setBindGroup(0, Visual.atmSkyViewBindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  Visual._atmLutsHavePlanetData = true;
  return true;
}

/* Build / fetch a mesh's GPU buffers. DebugTriangle is the only
 * mesh-gen kind in sprint 7.5.3a; future primitives will dispatch
 * here based on node.type with vertex data built procedurally
 * (Box: 36 verts + indices; Sphere: stacks*slices interpolated;
 * etc). Cache keyed by node.id; invalidated when params that change
 * geometry change (sprint 7.5.3b handles invalidation via a
 * version counter set when relevant params mutate). */
function _ensureMeshBuffers(meshEntry) {
  const node = meshEntry.node;
  // Phase 8 sprint 8-7b: synthesized detail-patch entries (added by
  // _resolveSceneMeshes when a PlanetMesh is in the scene) share the
  // PlanetMesh node but use a static (u, v) grid buffer cached
  // globally per gridDim.
  if (meshEntry.isPlanetDetailPatch) {
    const gridDim = Math.max(2, Math.min(256, Math.floor(
      (node.params && node.params.detailPatchGridDim) || 96
    )));
    return _ensurePlanetDetailPatchBuffer(gridDim);
  }
  // §5.5.e-6 -- TiledTerrain uses incremental per-chunk streaming
  // (own VBO+IBO per chunk, dropped/built individually as the camera
  // disc shifts). Route to the dedicated path so the monolithic
  // cache-or-rebuild logic below is bypassed entirely.
  if (node.type === "TiledTerrain") {
    return _ensureTiledTerrainChunks(node);
  }
  if (node.type === "Clouds3D") {
    return _ensureClouds3DChunks(node);
  }
  // §planet-spec Phase 6b -- Planet uses the same per-chunk streaming
  // pattern (per-chunk VBOs + two-phase placeholder/upgrade build under
  // a time budget) so deep maxDepth + flying close to the surface
  // doesn't stall the main thread on monolithic-mesh rebuilds.
  if (node.type === "Planet") {
    return _ensurePlanetChunks(node);
  }
  // Sprint 9-2: PlanetMesh routes through the cube-sphere quadtree
  // streaming path (same per-chunk pattern Planet uses, but reading
  // elevation from the wired PlanetMap's cell graph). Replaces the
  // sprint 9-1 static cube-sphere single-mesh builder, which is now
  // unreachable but kept in the file as a reference fallback.
  if (node.type === "PlanetMesh") {
    return _ensurePlanetMeshChunks(node);
  }
  const cached = Visual.meshBufferCache.get(node.id);
  if (cached && _meshCacheKey(node) === cached.cacheKey) return cached;
  // Params changed -- destroy + rebuild. Cheap (just a couple of
  // GPU buffers); avoids stale geometry when the user tweaks
  // dimensions in the props pane.
  if (cached) {
    try { cached.vertexBuffer && cached.vertexBuffer.destroy(); } catch (_) {}
    try { cached.indexBuffer  && cached.indexBuffer.destroy();  } catch (_) {}
    Visual.meshBufferCache.delete(node.id);
  }
  if (!Visual.device) return null;
  const built = _buildMeshData(node);
  if (!built) return null;
  const { verts, indices, chunks } = built;
  const vertexBuffer = Visual.device.createBuffer({
    label: "mesh-vb-" + node.id,
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(verts);
  vertexBuffer.unmap();
  let indexBuffer = null, indexCount = 0;
  if (indices) {
    indexBuffer = Visual.device.createBuffer({
      label: "mesh-ib-" + node.id,
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint32Array(indexBuffer.getMappedRange()).set(indices);
    indexBuffer.unmap();
    indexCount = indices.length;
  }
  // Sprint 5.10 -- compute the local-space AABB from vertex data so
  // the encoder can frustum-cull this mesh. Cheap (one pass over
  // verts) and cached alongside the GPU buffers; invalidated by the
  // same cacheKey check above when geometry params change.
  const aabb = _computeLocalAABB(verts);
  const out = {
    vertexBuffer,
    vertexCount: verts.length / 11,  // Sprint 7.5.3c push 6: 11 floats per vertex (pos + color + normal + uv)
    indexBuffer,
    indexCount,
    cacheKey: _meshCacheKey(node),
    aabbMin: aabb.min,
    aabbMax: aabb.max,
    // §5.5.e-2 -- per-chunk draw ranges + AABBs. Only set for
    // TiledTerrain (it's the only mesh-gen that emits chunks[]
    // from _buildMeshData). When present, the encoder issues one
    // drawIndexed per visible chunk + skips off-frustum chunks.
    chunks: chunks || null
  };
  Visual.meshBufferCache.set(node.id, out);
  return out;
}

/* Sprint 5.10 -- local-space AABB from interleaved vertex data.
 * Vertex stride is 11 floats: pos (3) + color (3) + normal (3) + uv
 * (2); position is at indices 0..2. Returns { min: [x,y,z], max:
 * [x,y,z] }. Empty verts -> degenerate zero-size AABB at origin
 * (caller's cull test treats this as outside the frustum). */
function _computeLocalAABB(verts) {
  if (!verts || verts.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const stride = 11;
  const n = verts.length / stride;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = i * stride;
    const px = verts[k], py = verts[k + 1], pz = verts[k + 2];
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/* Sprint 5.10 -- AABB-vs-frustum test. 6-plane SAT: for each plane
 * (a, b, c, d) with normal pointing inside the frustum, find the
 * AABB corner farthest along the normal (the "positive corner");
 * if even that corner is on the negative side of the plane, the
 * AABB is fully outside the frustum -> cull. Otherwise either
 * intersecting or inside -> draw.
 *
 * worldMin / worldMax are the WORLD-SPACE AABB after transforming
 * the local-space AABB through the mesh's model matrix. Cheap to
 * derive: pass the 8 local corners through the matrix + take new
 * min/max. */
function _aabbInsideFrustum(planes, worldMin, worldMax) {
  for (let p = 0; p < 6; p++) {
    const a = planes[p * 4 + 0];
    const b = planes[p * 4 + 1];
    const c = planes[p * 4 + 2];
    const d = planes[p * 4 + 3];
    const px = (a > 0) ? worldMax[0] : worldMin[0];
    const py = (b > 0) ? worldMax[1] : worldMin[1];
    const pz = (c > 0) ? worldMax[2] : worldMin[2];
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/* Sprint 5.10 -- transform a local AABB through a model matrix to
 * get the world-space AABB. Transforms all 8 corners then takes
 * min/max (vs the cheaper but less accurate "transform center +
 * extend by half-diagonal" — the 8-corner version is tight under
 * rotation, which matters when meshes are rotated 45° away from
 * axis-aligned). worldMin / worldMax are written into the supplied
 * Float32Array(3) outputs to avoid per-frame allocation. */
function _transformAABB(localMin, localMax, model, outMin, outMax) {
  let nx = Infinity, ny = Infinity, nz = Infinity;
  let xx = -Infinity, xy = -Infinity, xz = -Infinity;
  const m0 = model[0], m1 = model[1], m2 = model[2];
  const m4 = model[4], m5 = model[5], m6 = model[6];
  const m8 = model[8], m9 = model[9], m10 = model[10];
  const m12 = model[12], m13 = model[13], m14 = model[14];
  for (let i = 0; i < 8; i++) {
    const x = (i & 1) ? localMax[0] : localMin[0];
    const y = (i & 2) ? localMax[1] : localMin[1];
    const z = (i & 4) ? localMax[2] : localMin[2];
    const wx = m0 * x + m4 * y + m8  * z + m12;
    const wy = m1 * x + m5 * y + m9  * z + m13;
    const wz = m2 * x + m6 * y + m10 * z + m14;
    if (wx < nx) nx = wx; if (wx > xx) xx = wx;
    if (wy < ny) ny = wy; if (wy > xy) xy = wy;
    if (wz < nz) nz = wz; if (wz > xz) xz = wz;
  }
  outMin[0] = nx; outMin[1] = ny; outMin[2] = nz;
  outMax[0] = xx; outMax[1] = xy; outMax[2] = xz;
}

/* Param-fingerprint string used to invalidate the mesh cache when a
 * primitive's dimensions / segment counts change. Each primitive
 * type lists the params that actually affect geometry. */
function _meshCacheKey(node) {
  const p = node.params || {};
  switch (node.type) {
    case "DebugTriangle": return "tri:" + (p.scale || 1);
    case "Box":           return "box:" + [p.width, p.height, p.depth].join(",");
    case "Sphere":        return "sph:" + [p.radius, p.stacks, p.slices].join(",");
    case "Capsule":       return "cap:" + [p.radius, p.halfHeight, p.slices].join(",");
    case "DestructibleBody3D": return "destruct:" + node.id + ":" + (node.params && node.params.destroyed ? "d" + Math.floor(performance.now()) : "s");
    case "Rope3D":        return "rope:" + node.id + ":" + (node._ropeVer || 0);
    case "Cloth3D":       return "cloth:" + node.id + ":" + (node._clothVer || 0);
    case "SoftBody3D":    return "soft:" + node.id + ":" + (node._sbVer || 0);
    case "LoadGLB":       return "glb:" + node.id + ":" + (node.params && node.params.url) + ":" + (node.params && node.params.scale) + ":" + (node.params && node.params.autoFit) + ":" + (node._glbState || "") + ":" + (node._glbVer || 0);
    case "Planet":        {
      // §planet-spec Phase 4.c/e -- include a quantized PLANET-LOCAL
      // camera position so the quadtree rebuilds when the camera
      // crosses a finest-depth chunk boundary. Quantum = radius /
      // 2^maxDepth (≈ leaf-chunk edge near the camera). The center
      // params shift the cam-to-planet origin -- two Planet nodes at
      // different centers can share the same camera and still rebuild
      // independently.
      const r = (typeof p.radius === "number") ? p.radius : 1000;
      const md = Math.max(0, Math.min(14, Math.floor((typeof p.maxDepth === "number") ? p.maxDepth : 6)));
      const quantum = r / Math.pow(2, md);
      const cxC = (typeof p.centerX === "number") ? p.centerX : 0;
      const cyC = (typeof p.centerY === "number") ? p.centerY : 0;
      const czC = (typeof p.centerZ === "number") ? p.centerZ : 0;
      const c = _planetCameraPos(node);
      const qx = Math.round((c.x - cxC) / quantum);
      const qy = Math.round((c.y - cyC) / quantum);
      const qz = Math.round((c.z - czC) / quantum);
      return "plt:" + [
        p.radius, p.polarRadiusRatio,
        p.centerX, p.centerY, p.centerZ,
        p.segments, p.maxDepth, p.splitFactor,
        p.heightScale, p.seaLevel,
        p.seed, p.frequency, p.octaves, p.lacunarity, p.gain, p.ridges,
        qx, qy, qz
      ].join(",");
    }
    case "PlanetMesh":    {
      // §planet-spec Phase 7.d-azgaar -- cache key includes the wired
      // PlanetMap's cells key so editing PlanetMap (or its painter)
      // rebuilds the mesh from updated cell elevations.
      let pmKey = "no-map";
      if (state && Array.isArray(state.edges)) {
        const edge = state.edges.find(e =>
          e && e.to && e.to.node === node.id && e.to.port === "heightmap"
        );
        if (edge && edge.from) {
          const src = state.nodes.find(n => n && n.id === edge.from.node);
          if (src && src.type === "PlanetMap") {
            pmKey = _planetMapCacheKey(src);
          }
        }
      }
      return "pmesh:" + [
        p.radius, p.polarRadiusRatio,
        p.centerX, p.centerY, p.centerZ,
        p.heightScale, p.seaLevel,
        pmKey
      ].join(",");
    }
    case "Plane":         return "pln:" + [p.width, p.depth].join(",");
    case "Sprite":        return "spr:" + [p.width, p.height, p.anchorX, p.anchorY, p.tintR, p.tintG, p.tintB, p.tintA].join(",");
    case "Tilemap2D":     return "tmap:" + [p.tileData, p.tileSize, p.originX, p.originY,
                                            p.color1R, p.color1G, p.color1B,
                                            p.color2R, p.color2G, p.color2B,
                                            p.color3R, p.color3G, p.color3B,
                                            p.color4R, p.color4G, p.color4B,
                                            p.color5R, p.color5G, p.color5B,
                                            p.skipRenderChars,
                                            // Phase 2 tileset fields. tileMap object
                                            // stringified so JSON identity invalidates
                                            // when the user remaps chars.
                                            p.tileset || "",
                                            (typeof p.tileMap === "object" ? JSON.stringify(p.tileMap) : (p.tileMap || "")),
                                            p.tilesetFramesX || 0,
                                            p.tilesetFramesY || 0,
                                            p.depthZ || 0].join(",");
    case "TileSpriteOverlay": {
      // Cache key includes the wired tilemap's tileData + this node's
      // params so the overlay mesh rebuilds on tile-data mutation
      // (PickupCollector clearing collected eggs). Bob amplitude > 0
      // also bakes a time bucket into the key so the bob is visible.
      const tmap = (typeof _findWiredOrFirst === "function")
        ? _findWiredOrFirst(node, "tilemap", "Tilemap2D") : null;
      const tdata = tmap ? (tmap.params && tmap.params.tileData) || "" : "";
      const bobBucket = (p.bobAmplitude > 0)
        ? Math.floor(performance.now() / 60) : 0;
      return "tso:" + [
        tdata, p.tileChar, p.scale, p.anchorX, p.anchorY,
        p.frame, p.framesX, p.framesY,
        p.tintR, p.tintG, p.tintB, p.tintA,
        p.bobAmplitude, p.bobSpeed, bobBucket,
        p.depthZ
      ].join(",");
    }
    case "ParallaxLayer2D": {
      // Mesh follows the camera, so the cache key includes the
      // (quantized) camera position. 0.05 world-unit quantum is
      // small enough that scroll feels smooth + large enough that
      // we don't rebuild the mesh every render frame for static
      // cameras. Also include canvas dims so a resize rebuilds.
      let cposX = 0, cposY = 0;
      let camSrc = null;
      if (node._levelCameraNodeId) {
        camSrc = state.nodes.find(n => n && n.id === node._levelCameraNodeId);
      } else if (state && Array.isArray(state.edges)) {
        const wire = state.edges.find(e =>
          e && e.to && e.to.node === node.id && e.to.port === "camera"
        );
        if (wire && wire.from) {
          camSrc = state.nodes.find(n => n && n.id === wire.from.node);
        }
      }
      if (camSrc && camSrc.params) {
        cposX = camSrc.params.posX || 0;
        cposY = camSrc.params.posY || 0;
      }
      const qX = Math.round(cposX * 20) / 20;   // 0.05 unit quantum
      const qY = Math.round(cposY * 20) / 20;
      const cw = (typeof Visual !== "undefined" && Visual.canvas) ? (Visual.canvas.width  | 0) : 0;
      const ch = (typeof Visual !== "undefined" && Visual.canvas) ? (Visual.canvas.height | 0) : 0;
      return "plx:" + [
        qX, qY, cw, ch,
        p.parallaxX, p.texWorldWidth,
        p.screenScaleY, p.screenAnchorY, p.worldOffsetY,
        p.tintR, p.tintG, p.tintB, p.tintA,
        p.depthZ
      ].join(",");
    }
    case "SpriteScatter2D":
      return "ss2d:" + [
        p.positions, p.scale, p.anchorX, p.anchorY,
        p.frame, p.framesX, p.framesY,
        p.tintR, p.tintG, p.tintB, p.tintA,
        p.depthZ
      ].join(",");
    case "Torus":         return "tor:" + [p.majorRadius, p.minorRadius, p.majorSlices, p.minorSlices].join(",");
    case "Cylinder":      return "cyl:" + [p.radius, p.height, p.slices].join(",");
    case "Cone":          return "con:" + [p.radius, p.height, p.slices].join(",");
    case "Terrain":       {
      // v0.3.126 §5.5.c-3 -- include heightmap-wired state so the
      // mesh cache rebuilds when the user wires / unwires
      // ProceduralTerrain (flat-grid vs CPU-displaced).
      const wired = Array.isArray(state.edges) && state.edges.some(e =>
        e && e.to && e.to.node === node.id && e.to.port === "heightmap"
      );
      return "ter:" + [
        p.sizeMode, p.worldSize, p.heightScale, p.yOffset, p.segments,
        p.seed, p.frequency, p.octaves, p.lacunarity, p.gain, p.ridges,
        wired ? "g" : "c"
      ].join(",");
    }
    case "TerrainHorizon": {
      // §5.5.h-23 -- include the macro-tile in the key so crossing
      // tileSize triggers a rebuild centered on the new tile. Also
      // include the upstream TiledTerrain's noise params so the
      // horizon stays in sync with the chunked disc.
      const tile = _terrainHorizonMacroTile(node);
      const tt = (state && Array.isArray(state.nodes))
        ? state.nodes.find(n => n && n.type === "TiledTerrain") : null;
      const ttp = (tt && tt.params) || {};
      const ip  = tt ? _findTiledIslandParams(tt) : null;
      // §planet-spec Phase 1.5 -- visAltLow/visAltHigh DON'T need to
      // be in the cache key (the mesh geometry is identical at any
      // altitude; only the fragment shader's discard threshold
      // changes, and that's a per-frame uniform).
      // §planet-spec Phase 3 -- noiseFreqScale gone; octavesCap added.
      return "thr:" + [
        p.extent, p.subdivisions, p.tileSize, p.yBias, p.octavesCap,
        tile.tx, tile.tz,
        ttp.seed, ttp.frequency, ttp.octaves, ttp.lacunarity, ttp.gain,
        ttp.ridges, ttp.plateau, ttp.heightScale, ttp.yOffset,
        ip ? (ip.mode + ":" + ip.maskFreq + ":" + ip.maskSeed + ":" + ip.maskThreshold +
              ":" + ip.maskSoftness + ":" + ip.sinkDepth) : "i0"
      ].join(",");
    }
    // TiledTerrain doesn't use _meshCacheKey -- _ensureTiledTerrainChunks
    // manages its own per-chunk cache keyed by (tileX, tileZ, lod).
    case "Water":         {
      // §planet-spec Phase 6b -- with a Planet in the patch, Water is
      // a static 6-face cube-sphere shell wrapping the planet at sea
      // radius. Geometry depends only on Planet's center/radius/polRatio
      // and the seaLevel offset -- NOT on the camera (the sphere
      // wraps everything from any angle). No camera quantum needed.
      const planet = _findPlanetForProjection();
      if (planet) {
        return "water-sph:" + [
          p.seaLevel || 0,
          planet.cx, planet.cy, planet.cz, planet.r, planet.polRatio
        ].join(",");
      }
      return "water:" + (p.seaLevel || 0);
    }
    default:              return node.type;
  }
}

/* Build vertex + index arrays for a mesh-gen node. Returns {verts,
 * indices} or null on unknown type. Vertex layout is (pos.xyz,
 * color.rgb) interleaved float32 -- matches the pipeline's vertex
 * buffer layout exactly. Color is generated per-primitive: Box uses
 * distinct per-face colors; everything else uses normal-derived
 * shading (color = (normal + 1) * 0.5, so each direction maps to
 * a distinct hue) for an immediately-legible 3D shape. Materials
 * in sprint 7.5.3c replace this with proper lit shading. */
function _buildMeshData(node) {
  switch (node.type) {
    case "DebugTriangle": return _buildDebugTriangle(node);
    case "Box":           return _buildBox(node);
    case "Sphere":        return _buildSphere(node);
    case "Capsule":       return _buildCapsule(node);
    case "DestructibleBody3D": return _buildDestructibleMesh(node);
    case "Rope3D":        return _buildRopeMesh(node);
    case "Cloth3D":       return _buildClothMesh(node);
    case "SoftBody3D":    return _buildSoftBodyMesh(node);
    case "LoadGLB":       return _buildGLBMesh(node);
    case "Planet":        return _buildPlanet(node);
    case "PlanetMesh":    return _buildPlanetMesh(node);
    case "Plane":         return _buildPlane(node);
    case "Sprite":        return _buildSprite(node);
    case "Tilemap2D":         return _buildTilemap2D(node);
    case "TileSpriteOverlay": return _buildTileSpriteOverlay(node);
    case "ParallaxLayer2D":   return _buildParallaxLayer2D(node);
    case "SpriteScatter2D":   return _buildSpriteScatter2D(node);
    case "Torus":         return _buildTorus(node);
    case "Cylinder":      return _buildCylinder(node);
    case "Cone":          return _buildCone(node);
    case "Terrain":       return _buildTerrain(node);
    case "Water":            return _buildWater(node);
    case "TerrainHorizon":   return _buildTerrainHorizon(node);
    // Clouds3D handled by the chunked streaming path in
    // _ensureMeshBuffers; not reachable here.
    default: return null;
  }
}

function _buildDebugTriangle(node) {
  const s = (node.params && typeof node.params.scale === "number") ? node.params.scale : 1.0;
  // pos.xyz  color.rgb       normal.xyz  uv.xy  -- triangle faces +Z, normal = (0, 0, 1).
  const verts = new Float32Array([
    -0.866*s, -0.5*s, 0,     1, 0, 0,      0, 0, 1,   0,   0,
     0.866*s, -0.5*s, 0,     0, 1, 0,      0, 0, 1,   1,   0,
     0,        1.0*s, 0,     0.3, 0.5, 1,  0, 0, 1,   0.5, 1
  ]);
  return { verts, indices: null };
}

/* Rope3D -- tube mesh swept along the PBD particle polyline (set by
 * _tickRopes). K-sided ring per particle, oriented by a parallel-
 * transport-ish frame; rings connected by quads. 11-float vertex
 * format (pos3 + color3 + normal3 + uv2). Falls back to a straight
 * line between the attach points if the sim hasn't run yet. */
function _buildRopeMesh(node) {
  const p = node.params || {};
  const radius = Math.max(0.01, (typeof p.radius === "number") ? p.radius : 0.12);
  const col = [
    (typeof p.r === "number") ? p.r : 0.45,
    (typeof p.g === "number") ? p.g : 0.32,
    (typeof p.b === "number") ? p.b : 0.2
  ];
  // Particle centerline. If the sim hasn't populated _particles yet,
  // synthesize a straight segment from the static attach params.
  let pts = (node._particles && node._particles.length >= 2)
    ? node._particles.map(q => [q.x, q.y, q.z])
    : null;
  if (!pts) {
    const ax = p.ax || 0, ay = (typeof p.ay === "number") ? p.ay : 6, az = p.az || 0;
    const bx = p.bx || 0, by = p.by || 0, bz = p.bz || 0;
    const segs = Math.max(2, Math.min(64, Math.round((typeof p.segments === "number") ? p.segments : 16)));
    pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push([ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t]);
    }
  }
  const M = pts.length;          // rings
  const K = 6;                   // sides per ring
  const verts = new Float32Array(M * K * 11);
  const indices = new Uint32Array((M - 1) * K * 6);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1e-6; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
  let v = 0;
  for (let i = 0; i < M; i++) {
    // Tangent via central difference.
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(M - 1, i + 1)];
    let tan = norm(sub(next, prev));
    if (!isFinite(tan[0])) tan = [0, 1, 0];
    // Frame: pick an up not parallel to tangent.
    let up = (Math.abs(tan[1]) > 0.9) ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(tan, up));
    const w = norm(cross(tan, u));
    const c = pts[i];
    const tv = i / (M - 1);
    for (let k = 0; k < K; k++) {
      const ang = (k / K) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const nx = u[0] * ca + w[0] * sa, ny = u[1] * ca + w[1] * sa, nz = u[2] * ca + w[2] * sa;
      verts[v++] = c[0] + nx * radius; verts[v++] = c[1] + ny * radius; verts[v++] = c[2] + nz * radius;
      verts[v++] = col[0]; verts[v++] = col[1]; verts[v++] = col[2];
      verts[v++] = nx; verts[v++] = ny; verts[v++] = nz;
      verts[v++] = k / K; verts[v++] = tv;
    }
  }
  let ii = 0;
  for (let i = 0; i < M - 1; i++) {
    for (let k = 0; k < K; k++) {
      const a = i * K + k;
      const b = i * K + (k + 1) % K;
      const c = (i + 1) * K + k;
      const d = (i + 1) * K + (k + 1) % K;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }
  return { verts, indices };
}

/* Cloth3D -- triangulate the PBD particle grid (set by _tickCloths)
 * into a mesh. Per-vertex normals from the grid tangents. The scene
 * pipeline is cullMode:"none", so a single-sided grid shows both
 * faces. Falls back to a flat resting sheet from params if the sim
 * hasn't run yet. 11-float verts (pos3 + color3 + normal3 + uv2). */
function _buildClothMesh(node) {
  const p = node.params || {};
  const col = [
    (typeof p.r === "number") ? p.r : 0.7,
    (typeof p.g === "number") ? p.g : 0.2,
    (typeof p.b === "number") ? p.b : 0.25
  ];
  let P = node._cloth, dims = node._clothDims;
  if (!P || !dims) {
    // Flat fallback from params.
    const nx = Math.max(2, Math.min(40, Math.round((typeof p.resX === "number") ? p.resX : 16)));
    const ny = Math.max(2, Math.min(40, Math.round((typeof p.resY === "number") ? p.resY : 10)));
    const W = (typeof p.width === "number") ? p.width : 6;
    const H = (typeof p.height === "number") ? p.height : 4;
    const ox = p.originX || 0, oy = (typeof p.originY === "number") ? p.originY : 6, oz = p.originZ || 0;
    const cols = nx + 1, rows = ny + 1;
    P = new Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      P[j * cols + i] = { x: ox + (i / nx) * W, y: oy - (j / ny) * H, z: oz };
    }
    dims = { nx, ny, cols, rows };
  }
  const { cols, rows } = dims;
  const idx = (i, j) => j * cols + i;
  const verts = new Float32Array(cols * rows * 11);
  let v = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = P[idx(i, j)];
      // Tangents via neighbor differences (clamped at edges).
      const r0 = P[idx(Math.min(cols - 1, i + 1), j)], l0 = P[idx(Math.max(0, i - 1), j)];
      const d0 = P[idx(i, Math.min(rows - 1, j + 1))], u0 = P[idx(i, Math.max(0, j - 1))];
      const tx = r0.x - l0.x, ty = r0.y - l0.y, tz = r0.z - l0.z;
      const bx = d0.x - u0.x, by = d0.y - u0.y, bz = d0.z - u0.z;
      // normal = tangent × bitangent
      let nxN = ty * bz - tz * by, nyN = tz * bx - tx * bz, nzN = tx * by - ty * bx;
      const nl = Math.hypot(nxN, nyN, nzN) || 1e-6;
      nxN /= nl; nyN /= nl; nzN /= nl;
      verts[v++] = c.x; verts[v++] = c.y; verts[v++] = c.z;
      verts[v++] = col[0]; verts[v++] = col[1]; verts[v++] = col[2];
      verts[v++] = nxN; verts[v++] = nyN; verts[v++] = nzN;
      verts[v++] = i / (cols - 1); verts[v++] = j / (rows - 1);
    }
  }
  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let ii = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = idx(i, j), b = idx(i + 1, j), cc = idx(i, j + 1), d = idx(i + 1, j + 1);
      indices[ii++] = a; indices[ii++] = cc; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = cc; indices[ii++] = d;
    }
  }
  return { verts, indices };
}

/* SoftBody3D -- render the deforming shell of the res³ particle
 * lattice (set by _tickSoftBodies). INDEXED with shared surface
 * vertices + SMOOTH (area-weighted) normals accumulated across all
 * adjacent faces — so the cube edges round off and the jelly reads
 * smooth rather than faceted. Falls back to the rest cube. */
function _buildSoftBodyMesh(node) {
  const p = node.params || {};
  const col = [
    (typeof p.r === "number") ? p.r : 0.55,
    (typeof p.g === "number") ? p.g : 0.85,
    (typeof p.b === "number") ? p.b : 0.65
  ];
  let P = node._sb, R = node._sbR;
  if (!P || !R) {
    R = Math.max(2, Math.min(8, Math.round((typeof p.res === "number") ? p.res : 5)));
    const size = Math.max(0.2, (typeof p.size === "number") ? p.size : 2.5);
    const ox = p.originX || 0, oy = (typeof p.originY === "number") ? p.originY : 6, oz = p.originZ || 0;
    const step = size / (R - 1), base = { x: ox - size/2, y: oy - size/2, z: oz - size/2 };
    P = new Array(R*R*R);
    for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++)
      P[(k*R+j)*R+i] = { x: base.x+i*step, y: base.y+j*step, z: base.z+k*step };
  }
  const idx = (i, j, k) => (k * R + j) * R + i;
  // One shared vertex per SURFACE particle (so edge/corner verts are
  // shared between faces and their normals average → rounded edges).
  const vmap = new Map();
  const vparts = [];
  const isSurf = (i, j, k) => i === 0 || i === R-1 || j === 0 || j === R-1 || k === 0 || k === R-1;
  for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    if (isSurf(i, j, k)) { vmap.set(idx(i, j, k), vparts.length); vparts.push(idx(i, j, k)); }
  }
  const VN = vparts.length;
  const px = new Float32Array(VN), py = new Float32Array(VN), pz = new Float32Array(VN);
  const nx = new Float32Array(VN), ny = new Float32Array(VN), nz = new Float32Array(VN);
  for (let v = 0; v < VN; v++) { const q = P[vparts[v]]; px[v] = q.x; py[v] = q.y; pz[v] = q.z; }

  const tri = [];
  const quad = (a, b, c, d) => {
    const va = vmap.get(a), vb = vmap.get(b), vc = vmap.get(c), vd = vmap.get(d);
    tri.push(va, vb, vc, va, vc, vd);
  };
  for (let a = 0; a < R - 1; a++) {
    for (let b = 0; b < R - 1; b++) {
      quad(idx(0, a, b), idx(0, a, b+1), idx(0, a+1, b+1), idx(0, a+1, b));            // -X
      quad(idx(R-1, a, b), idx(R-1, a+1, b), idx(R-1, a+1, b+1), idx(R-1, a, b+1));    // +X
      quad(idx(a, 0, b), idx(a+1, 0, b), idx(a+1, 0, b+1), idx(a, 0, b+1));            // -Y
      quad(idx(a, R-1, b), idx(a, R-1, b+1), idx(a+1, R-1, b+1), idx(a+1, R-1, b));    // +Y
      quad(idx(a, b, 0), idx(a, b+1, 0), idx(a+1, b+1, 0), idx(a+1, b, 0));            // -Z
      quad(idx(a, b, R-1), idx(a+1, b, R-1), idx(a+1, b+1, R-1), idx(a, b+1, R-1));    // +Z
    }
  }
  // Accumulate face normals into shared verts (area-weighted = raw
  // cross product, not normalized per-face).
  for (let t = 0; t < tri.length; t += 3) {
    const i0 = tri[t], i1 = tri[t+1], i2 = tri[t+2];
    const e1x = px[i1]-px[i0], e1y = py[i1]-py[i0], e1z = pz[i1]-pz[i0];
    const e2x = px[i2]-px[i0], e2y = py[i2]-py[i0], e2z = pz[i2]-pz[i0];
    const fx = e1y*e2z - e1z*e2y, fy = e1z*e2x - e1x*e2z, fz = e1x*e2y - e1y*e2x;
    nx[i0]+=fx; ny[i0]+=fy; nz[i0]+=fz;
    nx[i1]+=fx; ny[i1]+=fy; nz[i1]+=fz;
    nx[i2]+=fx; ny[i2]+=fy; nz[i2]+=fz;
  }
  const verts = new Float32Array(VN * 11);
  for (let v = 0; v < VN; v++) {
    let a = nx[v], b = ny[v], c = nz[v];
    const l = Math.hypot(a, b, c) || 1e-6; a/=l; b/=l; c/=l;
    const o = v * 11;
    verts[o] = px[v]; verts[o+1] = py[v]; verts[o+2] = pz[v];
    verts[o+3] = col[0]; verts[o+4] = col[1]; verts[o+5] = col[2];
    verts[o+6] = a; verts[o+7] = b; verts[o+8] = c;
    verts[o+9] = 0; verts[o+10] = 0;
  }
  return { verts, indices: new Uint32Array(tri) };
}

/* ── Phase 8.B.15 / §8.F -- LoadGLB glTF import ───────────────────── */
let _threeModPromise = null;
/* Lazy-load three.js + GLTFLoader from a CDN that resolves the bare
 * "three" import inside the loader (esm.sh). Same dynamic-import
 * pattern as Rapier / transformers.js — no build step, no bundling. */
function _ensureThree() {
  if (_threeModPromise) return _threeModPromise;
  console.log("[glb] loading three.js + GLTFLoader…");
  _threeModPromise = (async () => {
    const THREE = await import("https://esm.sh/three@0.160.0");
    const mod = await import("https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js");
    console.log("[glb] three.js ready");
    return { THREE, GLTFLoader: mod.GLTFLoader };
  })();
  return _threeModPromise;
}

/* Resolve a LoadGLB url param to a fetchable URL. server:<id> streams
 * from the compile-server asset host; asset:<name> resolves through
 * the cached server manifest; http(s) is used directly. */
function _resolveGLBUrl(url) {
  if (typeof url !== "string" || !url) return null;
  const base = _serverAssetsBase || (typeof localServerEndpoint === "string" ? localServerEndpoint : null);
  if (url.startsWith("server:")) {
    const id = url.slice(7);
    return base ? base + "/assets/" + encodeURIComponent(id) : null;
  }
  if (url.startsWith("asset:")) {
    const name = url.slice(6).toLowerCase();
    const hit = (_serverAssets || []).find(a => a && (a.id === name || (a.name || "").toLowerCase() === name));
    if (hit && base) return base + "/assets/" + encodeURIComponent(hit.id);
    return null;
  }
  if (/^https?:\/\//.test(url)) return url;
  return null;
}

/* Merge every Mesh primitive in a parsed glTF into one editor-format
 * buffer (pos3 + color3 + normal3 + uv2), world-transformed, with the
 * material base color baked into the vertex color. */
function _gltfToEditorMesh(gltf, THREE, params) {
  const scale = (params && typeof params.scale === "number") ? params.scale : 1;
  const verts = [], indices = [];
  let vbase = 0;
  const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!root) return { verts: new Float32Array(0), indices: new Uint32Array(0) };
  root.updateMatrixWorld(true);
  const vtmp = new THREE.Vector3(), ntmp = new THREE.Vector3();
  const wm = new THREE.Matrix4(), im = new THREE.Matrix4();
  root.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    const g = obj.geometry;
    const pos = g.attributes && g.attributes.position;
    if (!pos) return;
    const nrm = g.attributes.normal, uv = g.attributes.uv, idx = g.index;
    let cr = 0.8, cg = 0.8, cb = 0.8;
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    if (mat && mat.color) { cr = mat.color.r; cg = mat.color.g; cb = mat.color.b; }
    const count = pos.count;
    // InstancedMesh (common in city kits for repeated windows / props):
    // emit the geometry once PER INSTANCE, composing each instance
    // matrix with the object's world matrix. Plain meshes = 1 pass.
    const instN = (obj.isInstancedMesh && obj.count) ? obj.count : 1;
    for (let inst = 0; inst < instN; inst++) {
      if (obj.isInstancedMesh) { obj.getMatrixAt(inst, im); wm.multiplyMatrices(obj.matrixWorld, im); }
      else { wm.copy(obj.matrixWorld); }
      const nm = new THREE.Matrix3().getNormalMatrix(wm);
      for (let i = 0; i < count; i++) {
        vtmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(wm);
        let nx = 0, ny = 1, nz = 0;
        if (nrm) { ntmp.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyMatrix3(nm).normalize(); nx = ntmp.x; ny = ntmp.y; nz = ntmp.z; }
        const u = uv ? uv.getX(i) : 0, v = uv ? uv.getY(i) : 0;
        verts.push(vtmp.x * scale, vtmp.y * scale, vtmp.z * scale, cr, cg, cb, nx, ny, nz, u, v);
      }
      if (idx) { for (let i = 0; i < idx.count; i++) indices.push(vbase + idx.getX(i)); }
      else { for (let i = 0; i < count; i++) indices.push(vbase + i); }
      vbase += count;
    }
  });
  // autoFit > 0: normalize to a consistent size regardless of the
  // source mesh's units. Centers on X/Z, rests the base at y=0, and
  // scales so the largest dimension = autoFit world units. Fixes the
  // "props come at wildly different scales / off-origin" problem.
  const autoFit = (params && typeof params.autoFit === "number") ? params.autoFit : 0;
  if (autoFit > 0 && verts.length) {
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < verts.length; i += 11) {
      const x = verts[i], y = verts[i+1], z = verts[i+2];
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
    const maxDim = Math.max(mxx - mnx, mxy - mny, mxz - mnz) || 1;
    const s = autoFit / maxDim;
    const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2;
    for (let i = 0; i < verts.length; i += 11) {
      verts[i]   = (verts[i]   - cx)  * s;
      verts[i+1] = (verts[i+1] - mny) * s;   // base sits on y = 0
      verts[i+2] = (verts[i+2] - cz)  * s;
    }
  }
  return { verts: new Float32Array(verts), indices: new Uint32Array(indices) };
}

async function _loadGLB(node) {
  node._glbState = "loading";
  node._glbUrl = node.params && node.params.url;
  try {
    const u0 = node.params && node.params.url;
    // server:/asset: urls need the compile-server base — probe it (and
    // the manifest for asset:<name>) if the Assets tab hasn't already.
    if (typeof u0 === "string" && (u0.startsWith("server:") || u0.startsWith("asset:"))) {
      if (!_serverAssetsBase && typeof probeLocalServer === "function") {
        try { await probeLocalServer(); } catch (_) {}
        if (!_serverAssetsBase && typeof localServerEndpoint === "string") _serverAssetsBase = localServerEndpoint;
      }
      if (u0.startsWith("asset:") && (!_serverAssets || !_serverAssets.length) &&
          typeof brRefreshServerAssets === "function") {
        try { await brRefreshServerAssets(); } catch (_) {}
      }
    }
    const url = _resolveGLBUrl(u0);
    if (!url) throw new Error("unresolved url: " + (node.params && node.params.url) + " (compile-server running?)");
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const { THREE, GLTFLoader } = await _ensureThree();
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      try { loader.parse(buf, "", resolve, reject); } catch (e) { reject(e); }
    });
    const mesh = _gltfToEditorMesh(gltf, THREE, node.params);
    if (!mesh.verts.length) throw new Error("no geometry in glTF");
    // Free three.js GPU/CPU resources — we only keep the extracted
    // vertex buffers, so the parsed scene + its (often large) embedded
    // textures shouldn't linger and balloon memory.
    try {
      const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      root && root.traverse(o => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const mm of mats) {
          if (!mm) continue;
          for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"]) {
            if (mm[k] && mm[k].dispose) mm[k].dispose();
          }
          if (mm.dispose) mm.dispose();
        }
      });
    } catch (_) {}
    node._glbMesh = mesh;
    node._glbState = "ready";
    node._glbVer = (node._glbVer || 0) + 1;
    if (node.params) node.params.ready = 1;
    console.log("[glb] " + node.id + " loaded: " + (mesh.verts.length / 11) + " verts");
  } catch (e) {
    console.warn("[glb] " + node.id + " load failed:", e && e.message);
    node._glbState = "error";
    if (node.params) node.params.ready = 0;
  }
}

/* Small placeholder cube shown while a GLB loads / on error. */
function _glbPlaceholder() {
  const h = 0.5, c = [0.45, 0.5, 0.6];
  const fb = _buildBox({ params: { width: 1, height: 1, depth: 1 } });
  // recolor to a neutral grey-blue
  for (let i = 0; i < fb.verts.length; i += 11) { fb.verts[i+3] = c[0]; fb.verts[i+4] = c[1]; fb.verts[i+5] = c[2]; }
  return fb;
}

function _buildGLBMesh(node) {
  // Kick a (re)load when first seen or when the url changed.
  if (!node._glbState || (node.params && node.params.url !== node._glbUrl)) {
    node._glbState = "queued";
    node._glbMesh = null;
    _loadGLB(node);
  }
  if (node._glbState === "ready" && node._glbMesh) return node._glbMesh;
  return _glbPlaceholder();
}

/* ── Phase 8.B.15 A.4 -- PhysicalMat PBR texture maps ────────────── */
/* Decode one map URL (server:/asset:/http) into a GPUTexture view.
 * jpg/png/webp via createImageBitmap; .exr via three.js EXRLoader
 * (FloatType → RGBA8). `fmt` = the WebGPU texture format. */
async function _loadMatTexture(rawUrl, fmt) {
  if (rawUrl.startsWith("server:") || rawUrl.startsWith("asset:")) {
    // Make sure the manifest is loaded — the EXR-vs-bitmap sniff below
    // needs the on-disk filename, and a demo may load before the user
    // ever opens the Assets tab.
    if ((!_serverAssets || !_serverAssets.length) && typeof brRefreshServerAssets === "function") {
      try { await brRefreshServerAssets(); } catch (_) {}
    }
    if (!_serverAssetsBase && typeof probeLocalServer === "function") {
      try { await probeLocalServer(); } catch (_) {}
      if (!_serverAssetsBase && typeof localServerEndpoint === "string") _serverAssetsBase = localServerEndpoint;
    }
  }
  const url = _resolveGLBUrl(rawUrl) || (/^https?:\/\//.test(rawUrl) ? rawUrl : null);
  if (!url) throw new Error("unresolved url: " + rawUrl);
  // Server/asset ids are slugged without an extension, so sniff the
  // real on-disk filename from the manifest to decide EXR-vs-bitmap
  // (Poly Haven ships normal/rough maps as .exr).
  let isExr = /\.exr(\?|$)/i.test(rawUrl) || /\.exr(\?|$)/i.test(url);
  if (!isExr && (rawUrl.startsWith("server:") || rawUrl.startsWith("asset:"))) {
    const ref = rawUrl.replace(/^(server|asset):/, "").toLowerCase();
    const hit = (_serverAssets || []).find(a => a && (a.id === ref || (a.name || "").toLowerCase() === ref));
    if (hit && /\.exr$/i.test(hit.file || hit.name || "")) isExr = true;
  }
  if (isExr) {
    const { THREE } = await _ensureThree();
    const mod = await import("https://esm.sh/three@0.160.0/examples/jsm/loaders/EXRLoader.js");
    const loader = new mod.EXRLoader();
    if (loader.setDataType) loader.setDataType(THREE.FloatType);
    const tex = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
    const w = tex.image.width, h = tex.image.height, src = tex.image.data;
    const ch = Math.max(1, Math.round(src.length / (w * h)));
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const r = src[i * ch] || 0, g = (ch > 1 ? src[i * ch + 1] : src[i * ch]) || 0, b = (ch > 2 ? src[i * ch + 2] : src[i * ch]) || 0;
      out[i*4]   = Math.max(0, Math.min(255, Math.round(r * 255)));
      out[i*4+1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      out[i*4+2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      out[i*4+3] = 255;
    }
    const gt = Visual.device.createTexture({
      label: "mat-exr", size: [w, h, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    Visual.device.queue.writeTexture({ texture: gt }, out, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
    if (tex.dispose) tex.dispose();
    return gt.createView({ label: "mat-exr-view" });
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const gt = Visual.device.createTexture({
    label: "mat-tex", size: [bmp.width, bmp.height, 1], format: fmt,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  });
  Visual.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: gt }, [bmp.width, bmp.height]);
  if (bmp.close) bmp.close();
  return gt.createView({ label: "mat-tex-view" });
}

/* Kick off (idempotent) loads for a PhysicalMat node's map params,
 * stashing the resolved views as node._mapAlbedo / _mapNormal /
 * _mapRough / _mapMetal. The draw loop reads those + rebinds the slot. */
function _ensureMatTextures(node) {
  if (!node || !node.params || !Visual.device) return;
  const p = node.params;
  const jobs = [
    ["albedoMap", "_mapAlbedo", "rgba8unorm"],
    ["normalMap", "_mapNormal", "rgba8unorm"],
    ["roughMap",  "_mapRough",  "rgba8unorm"],
    ["metalMap",  "_mapMetal",  "rgba8unorm"]
  ];
  for (const [param, key, fmt] of jobs) {
    const url = (typeof p[param] === "string") ? p[param].trim() : "";
    const sk = key + "Url";
    if (!url) { node[key] = null; node[sk] = ""; continue; }
    if (node[sk] === url) continue;       // already loading/loaded this url
    node[sk] = url;
    node[key] = null;
    _loadMatTexture(url, fmt)
      .then(view => { node[key] = view; })
      .catch(e => console.warn("[mat] " + param + " (" + url + ") failed: " + (e && e.message)));
  }
}

/* Box -- 24 verts (4 per face, NOT shared between faces) so each
 * face can have its own color/normal. 36 indices = 6 faces × 2
 * triangles × 3 verts. Standard cube oriented with +Y up.
 *
 * Face colors (Pantone-ish): +X red, -X cyan, +Y green, -Y magenta,
 * +Z blue, -Z yellow. Easy to identify which face you're looking at. */
function _buildBox(node) {
  const p = node.params || {};
  const hw = ((typeof p.width  === "number") ? p.width  : 1) * 0.5;
  const hh = ((typeof p.height === "number") ? p.height : 1) * 0.5;
  const hd = ((typeof p.depth  === "number") ? p.depth  : 1) * 0.5;
  // Face order: +X, -X, +Y, -Y, +Z, -Z. Each face: 4 verts in
  // CCW order viewed from outside, with explicit normal. Per-face
  // UVs cover the full 0..1 square so each face gets a complete
  // copy of the source texture.
  const faces = [
    { c: [1.00, 0.22, 0.22], n: [ 1, 0, 0], verts: [
      [ hw, -hh, -hd], [ hw,  hh, -hd], [ hw,  hh,  hd], [ hw, -hh,  hd] ]},  // +X
    { c: [0.22, 0.92, 0.95], n: [-1, 0, 0], verts: [
      [-hw, -hh,  hd], [-hw,  hh,  hd], [-hw,  hh, -hd], [-hw, -hh, -hd] ]},  // -X
    { c: [0.45, 0.96, 0.35], n: [ 0, 1, 0], verts: [
      [-hw,  hh,  hd], [ hw,  hh,  hd], [ hw,  hh, -hd], [-hw,  hh, -hd] ]},  // +Y
    { c: [0.96, 0.35, 0.92], n: [ 0,-1, 0], verts: [
      [-hw, -hh, -hd], [ hw, -hh, -hd], [ hw, -hh,  hd], [-hw, -hh,  hd] ]},  // -Y
    { c: [0.40, 0.55, 1.00], n: [ 0, 0, 1], verts: [
      [-hw, -hh,  hd], [ hw, -hh,  hd], [ hw,  hh,  hd], [-hw,  hh,  hd] ]},  // +Z
    { c: [0.98, 0.92, 0.30], n: [ 0, 0,-1], verts: [
      [ hw, -hh, -hd], [-hw, -hh, -hd], [-hw,  hh, -hd], [ hw,  hh, -hd] ]}   // -Z
  ];
  // Per-face UV order matches the vert order: BL, TL, TR, BR.
  // Triangulation (0,1,2 / 0,2,3) traces the full unit square.
  const faceUvs = [[0, 0], [0, 1], [1, 1], [1, 0]];
  const verts = new Float32Array(24 * 11);
  const indices = new Uint32Array(36);
  let v = 0, i = 0, base = 0;
  for (const f of faces) {
    for (let k = 0; k < 4; k++) {
      const pos = f.verts[k];
      const uv  = faceUvs[k];
      verts[v++] = pos[0]; verts[v++] = pos[1]; verts[v++] = pos[2];
      verts[v++] = f.c[0]; verts[v++] = f.c[1]; verts[v++] = f.c[2];
      verts[v++] = f.n[0]; verts[v++] = f.n[1]; verts[v++] = f.n[2];
      verts[v++] = uv[0];  verts[v++] = uv[1];
    }
    indices[i++] = base + 0; indices[i++] = base + 1; indices[i++] = base + 2;
    indices[i++] = base + 0; indices[i++] = base + 2; indices[i++] = base + 3;
    base += 4;
  }
  return { verts, indices };
}

/* Sphere -- UV sphere with `stacks` horizontal slices + `slices`
 * vertical meridians. (stacks+1)*(slices+1) verts, 2*stacks*slices*3
 * indices. Color from surface normal (= normalized position for a
 * unit sphere) mapped (n + 1) * 0.5 -- each direction is a distinct
 * pastel hue. */
function _buildSphere(node) {
  const p = node.params || {};
  const r = (typeof p.radius === "number") ? p.radius : 1;
  const stacks = Math.max(2, Math.min(64, Math.floor((typeof p.stacks === "number") ? p.stacks : 16)));
  const slices = Math.max(3, Math.min(128, Math.floor((typeof p.slices === "number") ? p.slices : 24)));
  // Equirectangular UV: u = slice (longitude), v = stack (latitude
  // from north pole). The seam at u=0/1 is automatically handled
  // by including sl=slices vertex (same position as sl=0, but with
  // u=1 instead of u=0).
  const verts = new Float32Array((stacks + 1) * (slices + 1) * 11);
  const indices = new Uint32Array(stacks * slices * 6);
  let v = 0, i = 0;
  for (let st = 0; st <= stacks; st++) {
    const phi = Math.PI * (st / stacks);                // 0..π (north pole to south)
    const sphi = Math.sin(phi), cphi = Math.cos(phi);
    const vv = st / stacks;
    for (let sl = 0; sl <= slices; sl++) {
      const theta = 2 * Math.PI * (sl / slices);        // 0..2π around Y
      const sth = Math.sin(theta), cth = Math.cos(theta);
      const nx = sphi * cth, ny = cphi, nz = sphi * sth;
      verts[v++] = r * nx; verts[v++] = r * ny; verts[v++] = r * nz;
      verts[v++] = nx * 0.5 + 0.5;
      verts[v++] = ny * 0.5 + 0.5;
      verts[v++] = nz * 0.5 + 0.5;
      verts[v++] = nx; verts[v++] = ny; verts[v++] = nz;
      verts[v++] = sl / slices; verts[v++] = vv;
    }
  }
  for (let st = 0; st < stacks; st++) {
    for (let sl = 0; sl < slices; sl++) {
      const a = st * (slices + 1) + sl;
      const b = a + slices + 1;
      indices[i++] = a;     indices[i++] = b;     indices[i++] = a + 1;
      indices[i++] = a + 1; indices[i++] = b;     indices[i++] = b + 1;
    }
  }
  return { verts, indices };
}

function _buildCapsule(node) {
  const p = node.params || {};
  const r = Math.max(0.01, (typeof p.radius === "number") ? p.radius : 0.25);
  const hh = Math.max(0, (typeof p.halfHeight === "number") ? p.halfHeight : 0.5);
  const sl = Math.max(4, Math.min(48, Math.floor((typeof p.slices === "number") ? p.slices : 12)));
  const capStacks = Math.max(2, Math.floor(sl / 2));
  const totalStacks = capStacks * 2 + 1;
  const vertCount = (totalStacks + 1) * (sl + 1);
  const verts = new Float32Array(vertCount * 11);
  const indices = new Uint32Array(totalStacks * sl * 6);
  let vi = 0, ii = 0;
  for (let st = 0; st <= totalStacks; st++) {
    let phi, yOff;
    if (st <= capStacks) {
      phi = Math.PI * 0.5 * (st / capStacks);
      yOff = hh;
    } else if (st <= capStacks * 2) {
      phi = Math.PI * 0.5;
      yOff = hh - (st - capStacks) / capStacks * 2 * hh;
    } else {
      phi = Math.PI * 0.5 + Math.PI * 0.5 * ((st - capStacks * 2) / capStacks);
      yOff = -hh;
    }
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let s = 0; s <= sl; s++) {
      const th = 2 * Math.PI * (s / sl);
      const nx = sp * Math.cos(th), nz = sp * Math.sin(th), ny = cp;
      const px = r * nx, py = r * ny + yOff, pz = r * nz;
      verts[vi++] = px; verts[vi++] = py; verts[vi++] = pz;
      verts[vi++] = nx * 0.5 + 0.5; verts[vi++] = ny * 0.5 + 0.5; verts[vi++] = nz * 0.5 + 0.5;
      verts[vi++] = nx; verts[vi++] = ny; verts[vi++] = nz;
      verts[vi++] = s / sl; verts[vi++] = st / totalStacks;
    }
  }
  for (let st = 0; st < totalStacks; st++) {
    for (let s = 0; s < sl; s++) {
      const a = st * (sl + 1) + s, b = a + sl + 1;
      indices[ii++] = a; indices[ii++] = b; indices[ii++] = a + 1;
      indices[ii++] = a + 1; indices[ii++] = b; indices[ii++] = b + 1;
    }
  }
  return { verts, indices };
}

