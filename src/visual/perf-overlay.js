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

