function _tickVideoFileTrigs() {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  for (const node of state.nodes) {
    if (!node || node.type !== "VideoFile") continue;
    const src = _videoSources.get(node.id);
    if (!src || !src.videoEl) continue;
    // Find the wire feeding `trig`.
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "trig");
    if (!wire || !wire.from) {
      // No wire -- clear any retained state so a future wire-add doesn't
      // see a stale "lastValue" that suppresses the first edge.
      _videoFileTrigState.delete(node.id);
      continue;
    }
    const srcNode = state.nodes.find(n => n && n.id === wire.from.node);
    if (!srcNode) continue;
    let v = 0;
    if (srcNode.type === "MasterClock") {
      v = _masterClockOutputValue(srcNode, wire.from.port);
    } else if (srcNode.type === "Slider") {
      v = (srcNode.params && typeof srcNode.params.value === "number")
        ? srcNode.params.value : 0;
    } else if (srcNode.type === "HandLandmarker") {
      v = _handLandmarkerValue(srcNode, wire.from.port);
    } else if (srcNode.type === "PoseLandmarker") {
      v = _poseLandmarkerValue(srcNode, wire.from.port);
    } else if (srcNode.type === "FaceLandmarker") {
      v = _faceLandmarkerValue(srcNode, wire.from.port);
    } else if (srcNode.type === "HandKeyboard") {
      v = _handKeyboardValue(srcNode, wire.from.port);
    }
    const last = _videoFileTrigState.get(node.id) || 0;
    _videoFileTrigState.set(node.id, v);
    if (last <= 0.5 && v > 0.5) {
      try { src.videoEl.currentTime = 0; } catch (_) {}
    }
  }
}

function startVisualRenderLoop() {
  if (_visualRafHandle != null) return;
  _visualRafHandle = requestAnimationFrame(_visualRenderTick);
}
function stopVisualRenderLoop() {
  if (_visualRafHandle != null) {
    cancelAnimationFrame(_visualRafHandle);
    _visualRafHandle = null;
  }
}

/* =========================================================================
 * Live Mode — Phase 6.7.5 (shipped early, ahead of full visual layer)
 *
 * One-toggle full-screen visual mode. Hides the entire editor UI via
 * a body class, leaving only the visual canvas. Designed for live-
 * performance use: the moment you go on stage, you don't want palette /
 * properties / code / preview chrome competing with the projected
 * visuals.
 *
 * Three ways in/out:
 *   • Toolbar "◐" button (#btn-live-mode)
 *   • Hotkey `L` (context-aware: skipped when typing in any text input)
 *   • Hotkey `Escape` from inside live mode (safety exit; never
 *     ambiguous since modals close before this fires)
 *
 * Idle-fade: after 2.5 s of pointer stillness in live mode, the floating
 * "Exit Live" affordance fades to opacity 0 and the cursor hides. Any
 * pointermove restores both. Keeps the visual frame clean during long
 * sustained passages.
 * ======================================================================== */

let liveMode = false;
let _liveIdleTimer = null;
const LIVE_IDLE_MS = 2500;

function isLiveMode() { return liveMode; }

function setLiveMode(on) {
  on = !!on;
  if (on === liveMode) return;
  liveMode = on;
  document.body.classList.toggle("live-mode", liveMode);
  const btn = document.getElementById("btn-live-mode");
  if (btn) btn.classList.toggle("active", liveMode);
  if (liveMode) {
    // Drop focus from any text input so the L-key exit doesn't get
    // swallowed by an open Code / JSON tab textarea.
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }
    document.body.classList.remove("live-idle");
    document.body.classList.add("cursor-revealed");
    _scheduleLiveIdleFade();
  } else {
    document.body.classList.remove("live-idle", "cursor-revealed");
    if (_liveIdleTimer) { clearTimeout(_liveIdleTimer); _liveIdleTimer = null; }
    // v0.2.24 — exiting Live Mode also exits Viewer Mode so the
    // editor chrome is fully visible. Viewer-mode CSS hides toolbar
    // / palette / footer; without dropping the class, an L-press
    // from a standalone viewer would just show a blank page.
    // (Reload to re-enter viewer mode.)
    document.body.classList.remove("viewer-mode");
    // Hide all UI/HUD overlays now — they're a live-mode-only affordance.
    // Done explicitly (not via the render tick) so they vanish even if
    // the visual loop is frozen / paused in edit mode.
    if (typeof _hideAllOverlays === "function") _hideAllOverlays(false);
  }
}

function toggleLiveMode() { setLiveMode(!liveMode); }

function _scheduleLiveIdleFade() {
  if (_liveIdleTimer) clearTimeout(_liveIdleTimer);
  _liveIdleTimer = setTimeout(() => {
    if (!liveMode) return;
    document.body.classList.add("live-idle");
    document.body.classList.remove("cursor-revealed");
  }, LIVE_IDLE_MS);
}

// Reveal exit affordance + cursor on any movement / interaction in live
// mode. Pointermove on document fires for both mouse and touch.
window.addEventListener("pointermove", () => {
  if (!liveMode) return;
  if (document.body.classList.contains("live-idle") ||
      !document.body.classList.contains("cursor-revealed")) {
    document.body.classList.remove("live-idle");
    document.body.classList.add("cursor-revealed");
  }
  _scheduleLiveIdleFade();
}, { passive: true });

// Wire button + hotkeys at end of init (after the existing keydown
// handlers register so we can early-return cleanly without fighting
// them). Done at the bottom of this script block.

/* =========================================================================
 * Phase 6.7.1 — Hide-graph toggle (H key)
 *
 * Body class `graph-hidden` drops #canvas-world (the node-graph surface
 * with nodes + wires SVG). Header, palette, properties pane, bottom
 * tabs, and the visual HUD all stay visible -- the WebGPU canvas
 * underneath is now unobstructed, perfect for showing visuals without
 * fully committing to Live Mode (which collapses the entire editor).
 *
 * Same input-guard pattern as Live Mode (L key):
 *   - Skip when typing in a text input
 *   - Skip when audio preview is playing (H is also mapped to MIDI A4
 *     in QWERTY_TO_MIDI, line ~36883 -- a ringing-out note wins)
 * ======================================================================== */

let graphHidden = false;
function isGraphHidden() { return graphHidden; }
function setGraphHidden(on) {
  on = !!on;
  if (on === graphHidden) return;
  graphHidden = on;
  document.body.classList.toggle("graph-hidden", graphHidden);
  const pill = document.getElementById("graph-hide-pill");
  if (pill) {
    pill.classList.toggle("active", graphHidden);
    pill.textContent = graphHidden ? "▣" : "⊟";
  }
}
function toggleGraphHidden() { setGraphHidden(!graphHidden); }

/* =========================================================================
 * Phase 6.7.2 — Capture frame → PNG
 *
 * Snapshots the visible WebGPU canvas. Resolution = canvas drawing-buffer
 * size (window inner-W/H × devicePixelRatio per sizeVisualCanvas). On a
 * Retina iPad / 4K display this is already >= 1080p; on standard 1080p
 * monitors it matches the screen.
 *
 * Note about render-resolution: Visual.fbWidth × Visual.fbHeight is the
 * OFFSCREEN framebuffer size (the user-selectable 1080p/1440p/4K/8K
 * pipeline cap). The visible canvas downsamples or upsamples that to
 * fit the viewport. For now we capture the visible canvas; a follow-up
 * could compose to a fbWidth×fbHeight target for true 4K screenshots
 * regardless of viewport size. ~95% of the cases this already covers.
 *
 * Implementation: WebGPU's canvas context is preserved across frames
 * by default with `preserveDrawingBuffer` semantics handled via
 * `alphaMode: "premultiplied"` configure. We wait one rAF so the
 * canvas has the freshest frame, then `toBlob('image/png')`. */
/* Sprint hud-text -- composite Visual.canvas + all visible HUD
 * overlays onto a target 2D canvas. Used by both screenshot
 * (captureVisualFrame) and video (startVideoCapture) so HUDs
 * appear in saved frames + recordings the same way they appear
 * on screen. Before this, HUDs lived on separate position:fixed
 * canvases that Visual.canvas.toBlob / .captureStream couldn't see.
 *
 * Coordinate mapping: HUD canvases position themselves in screen-space
 * (px from screen edge). Visual.canvas has its own CSS size +
 * backing-store size; we scale HUD positions by the same ratio so
 * the HUD lands at the same RELATIVE position in the output. */
function _compositeFrameWithHuds(target) {
  if (!target || !Visual.canvas) return;
  const tctx = target.getContext("2d");
  if (!tctx) return;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, target.width, target.height);
  // Base: the WebGPU canvas. drawImage supports HTMLCanvasElement
  // including WebGPU-backed ones in modern browsers.
  tctx.drawImage(Visual.canvas, 0, 0, target.width, target.height);
  // Overlays: every visible #hud-* canvas. Compute each one's
  // bounding rect relative to Visual.canvas + scale to target.
  const vRect = Visual.canvas.getBoundingClientRect();
  if (vRect.width === 0 || vRect.height === 0) return;
  const sx = target.width  / vRect.width;
  const sy = target.height / vRect.height;
  const huds = document.querySelectorAll('canvas[id^="hud-"]');
  for (const h of huds) {
    if (!h || h.style.display === "none") continue;
    if (h.offsetWidth === 0 || h.offsetHeight === 0) continue;
    const hr = h.getBoundingClientRect();
    // Skip HUDs that don't overlap the visual canvas (e.g., a HUD
    // pinned to a corner that's off-screen on a tiny viewport).
    if (hr.right < vRect.left || hr.left > vRect.right) continue;
    if (hr.bottom < vRect.top || hr.top > vRect.bottom) continue;
    const x = (hr.left - vRect.left) * sx;
    const y = (hr.top  - vRect.top)  * sy;
    const w = hr.width  * sx;
    const z = hr.height * sy;
    // Respect HUD's opacity (set inline via style.opacity).
    const op = parseFloat(h.style.opacity);
    tctx.globalAlpha = Number.isFinite(op) ? op : 1.0;
    tctx.drawImage(h, x, y, w, z);
  }
  tctx.globalAlpha = 1.0;
}

async function captureVisualFrame() {
  if (!Visual.canvas) return;
  // One rAF tick so the canvas has the latest rendered frame.
  await new Promise(r => requestAnimationFrame(r));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Toast the user that capture is running -- toBlob can take 30-200 ms
  // on 4K+; without a hint they wonder if the click registered.
  const pill = document.getElementById("snap-btn");
  const original = pill ? pill.textContent : null;
  if (pill) { pill.textContent = "…"; pill.classList.add("active"); }
  // Composite Visual.canvas + HUDs onto a one-shot canvas, then
  // toBlob from that. Falls back to direct Visual.canvas if any HUDs
  // are present and compositing seems to have failed (defensive).
  const composite = document.createElement("canvas");
  composite.width  = Visual.canvas.width;
  composite.height = Visual.canvas.height;
  _compositeFrameWithHuds(composite);
  try {
    await new Promise((resolve, reject) => {
      composite.toBlob((blob) => {
        if (!blob) { reject(new Error("toBlob returned null")); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "gamma-frame-" + stamp + ".png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        resolve();
      }, "image/png");
    });
  } catch (e) {
    console.warn("[capture] frame failed:", e);
  } finally {
    if (pill) {
      pill.textContent = original;
      pill.classList.remove("active");
    }
  }
}

/* =========================================================================
 * Phase 6.7.3 — Capture video → WebM (MediaRecorder)
 *
 * Toggle button: first click starts recording (canvas video + audio if a
 * preview is playing), second click stops + triggers a .webm download.
 * The HUD pill turns red + counts elapsed seconds while recording, with
 * a soft pulse animation so it's unambiguously "live" mid-set.
 *
 * Video: canvas.captureStream(60) gives a continuous 60 fps track of
 * everything WebGPU draws to the visible canvas. Captures the
 * displayed image -- so warp + edge-blend + rig-composite all land in
 * the recording exactly as they appear on screen.
 *
 * Audio: if previewState.workletNode exists, we connect() it to a
 * MediaStreamDestinationNode in the same AudioContext. The connect()
 * is additive (the worklet's existing connection to ctx.destination
 * stays live, so audio still plays through speakers during recording).
 * No audio preview -> video-only recording. */
let _videoRecorder = null;
let _videoChunks = null;
let _videoStartT = 0;
let _videoTimer = null;
let _videoAudioTap = null;   // { dest, srcNode } so we can disconnect on stop
let _videoMimeType = "video/webm";
// Sprint hud-text -- persistent compositor for video capture. Created
// on startVideoCapture, updated each render frame via _tickCaptureCompositor,
// fed to MediaRecorder via captureStream so HUDs end up in the .webm.
let _captureCompositor = null;

/* Called from the visual render tick after all HUDs have updated.
 * No-op when no recording is in flight, so the per-frame cost is
 * a single null check during normal runs. */
function _tickCaptureCompositor() {
  if (!_videoRecorder || !_captureCompositor) return;
  _compositeFrameWithHuds(_captureCompositor);
}

function _pickWebmMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return null;
}

function captureVideoToggle() {
  if (_videoRecorder) {
    stopVideoCapture();
  } else {
    startVideoCapture();
  }
}

function startVideoCapture() {
  if (!Visual.canvas) return;
  const mime = _pickWebmMimeType();
  if (!mime) {
    console.warn("[capture] no supported WebM mime-type for MediaRecorder in this browser");
    return;
  }
  _videoMimeType = mime;
  // Build the compositor canvas at the same backing-store size as
  // Visual.canvas so HUD geometry maps 1:1 and bitrate budget isn't
  // wasted upscaling. captureStream gives us a 60 fps track of the
  // composite (Visual.canvas + HUDs) rather than the raw WebGPU canvas.
  if (!_captureCompositor) _captureCompositor = document.createElement("canvas");
  _captureCompositor.width  = Visual.canvas.width;
  _captureCompositor.height = Visual.canvas.height;
  // Prime the compositor BEFORE captureStream so the first frame has
  // valid pixels instead of blank.
  _compositeFrameWithHuds(_captureCompositor);
  let stream;
  try {
    stream = _captureCompositor.captureStream(60);
  } catch (e) {
    console.warn("[capture] compositor.captureStream failed:", e);
    return;
  }
  // Tap the audio worklet if a preview is running. dest is in the same
  // AudioContext as the worklet -- no resampling, sample-accurate sync.
  const ctx  = previewState && previewState.audioCtx;
  const node = previewState && previewState.workletNode;
  if (ctx && node) {
    try {
      const dest = ctx.createMediaStreamDestination();
      node.connect(dest);
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
      _videoAudioTap = { dest, srcNode: node };
    } catch (e) {
      console.warn("[capture] audio tap failed (recording video-only):", e);
      _videoAudioTap = null;
    }
  } else {
    _videoAudioTap = null;
  }
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  } catch (e) {
    console.warn("[capture] MediaRecorder constructor failed:", e);
    _disposeVideoAudioTap();
    return;
  }
  _videoRecorder = rec;
  _videoChunks = [];
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) _videoChunks.push(ev.data); };
  rec.onstop = () => {
    const blob = new Blob(_videoChunks, { type: mime });
    _videoChunks = null;
    if (blob.size > 0) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.download = "gamma-capture-" + stamp + ".webm";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
    _disposeVideoAudioTap();
    _videoRecorder = null;
    _updateVideoUi(false);
  };
  rec.start(1000);  // 1s chunks -- safer for long recordings (memory cap)
  _videoStartT = performance.now();
  _updateVideoUi(true);
  if (_videoTimer) clearInterval(_videoTimer);
  _videoTimer = setInterval(_updateVideoElapsed, 250);
}

function stopVideoCapture() {
  if (!_videoRecorder) return;
  try { _videoRecorder.stop(); } catch (e) { console.warn("[capture] recorder.stop:", e); }
  if (_videoTimer) { clearInterval(_videoTimer); _videoTimer = null; }
}

function _disposeVideoAudioTap() {
  if (!_videoAudioTap) return;
  try { _videoAudioTap.srcNode.disconnect(_videoAudioTap.dest); }
  catch (_) {}
  _videoAudioTap = null;
}

function _updateVideoUi(recording) {
  const pill = document.getElementById("video-rec-pill");
  if (!pill) return;
  pill.classList.toggle("recording", recording);
  if (recording) {
    pill.textContent = "● 00:00";
    pill.title = "Stop recording — writes .webm to your Downloads";
  } else {
    pill.textContent = "●";
    pill.title = "Start video capture — records canvas + audio to a .webm file. Click again to stop.";
  }
}

function _updateVideoElapsed() {
  const pill = document.getElementById("video-rec-pill");
  if (!pill || !_videoRecorder) return;
  const s = Math.floor((performance.now() - _videoStartT) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  pill.textContent = "● " + mm + ":" + ss;
  // Keep the Export-modal's REC tag in sync if the modal is open.
  const tag = document.getElementById("exp-rec-state-tag");
  if (tag) {
    tag.style.display = "inline-block";
    tag.textContent = "REC " + mm + ":" + ss;
  }
}

/* =========================================================================
 * v0.2.19 — per-display PNG capture at target resolution
 *
 * The composite-preview capture above (Visual.canvas.toBlob) grabs
 * what's on screen: rig-composite, theater, cylinder, etc., at the
 * viewport's CSS-size × DPR. That's "what the operator sees."
 *
 * Per-display capture is different: it pulls the raw framebuffer
 * layer for a single display at Visual.fbWidth × Visual.fbHeight
 * (the user-selected render resolution -- 1080p / 1440p / 4K / 8K).
 * Those are the actual pixels each projector receives, independent
 * of preview mode + viewport size. Useful for:
 *   - Authoring at one resolution but capturing reference frames at
 *     another (e.g. previewing in fisheye but exporting 4K per-tile)
 *   - Verifying the post-warp pre-blend output of a specific tile
 *   - Bundling all displays into a ZIP for offline analysis (the
 *     calibration walks already use the same Visual.framebuffer
 *     readback path, but on the composite output -- this is the
 *     pre-composite per-tile content)
 *
 * Mechanism: copyTextureToBuffer from Visual.framebuffer at the
 * (x=0, y=0, z=displayIdx) origin, with a width/height of the
 * framebuffer. WebGPU requires bytesPerRow to be a multiple of 256;
 * after the readback we strip that padding when copying into the
 * tightly-packed ImageData buffer.
 *
 * RGBA8 readback works because Visual.fbFormat is "rgba8unorm" --
 * byte order matches ImageData. If the format ever shifts (e.g.
 * to rgba16float for HDR), this path needs a tone-map step.
 * ======================================================================== */

async function capturePerDisplayPng(displayIdx) {
  if (!Visual.device || !Visual.framebuffer) {
    throw new Error("WebGPU not ready / no framebuffer");
  }
  const layerCount = (Visual.framebufferLayerViews && Visual.framebufferLayerViews.length) || 0;
  if (displayIdx < 0 || displayIdx >= layerCount) {
    throw new Error("displayIdx " + displayIdx + " out of range (0.." + (layerCount - 1) + ")");
  }
  // One rAF so the framebuffer has the freshest rendered content.
  await new Promise(r => requestAnimationFrame(r));
  const w = Visual.fbWidth, h = Visual.fbHeight;
  const bpp = 4;             // rgba8unorm
  const unpaddedRow = w * bpp;
  const paddedRow = Math.ceil(unpaddedRow / 256) * 256;  // WebGPU alignment
  const bufSize = paddedRow * h;
  const readback = Visual.device.createBuffer({
    label: "per-display-readback-" + displayIdx,
    size: bufSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const enc = Visual.device.createCommandEncoder({ label: "per-display-capture-" + displayIdx });
  enc.copyTextureToBuffer(
    {
      texture: Visual.framebuffer,
      origin: { x: 0, y: 0, z: displayIdx }
    },
    {
      buffer: readback,
      bytesPerRow: paddedRow,
      rowsPerImage: h
    },
    { width: w, height: h, depthOrArrayLayers: 1 }
  );
  Visual.device.queue.submit([enc.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(readback.getMappedRange());
  // Tight-pack into the ImageData backing buffer, stripping the
  // padding bytes between rows.
  const tight = new Uint8ClampedArray(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const srcStart = y * paddedRow;
    const dstStart = y * unpaddedRow;
    tight.set(mapped.subarray(srcStart, srcStart + unpaddedRow), dstStart);
  }
  readback.unmap();
  readback.destroy();
  // Encode through a 2D canvas. OffscreenCanvas would let us run
  // this off the main thread someday; for now a plain canvas is fine
  // -- toBlob is async + only fires at viable points.
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx2 = canvas.getContext("2d");
  if (!ctx2) throw new Error("2d context unavailable");
  const imgData = new ImageData(tight, w, h);
  ctx2.putImageData(imgData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if (!b) reject(new Error("toBlob returned null"));
      else resolve(b);
    }, "image/png");
  });
}

/* Bundle every rig display into a single .zip. Uses the same
 * _writeZipArchive helper the MPCDI / auto-capture flows use, with
 * a flat layout: display-NN-id.png inside the archive root. */
async function captureAllDisplaysZip(progressFn) {
  if (!Visual.framebufferLayerViews || !Visual.framebufferLayerViews.length) {
    throw new Error("no framebuffer layers");
  }
  const N = Visual.framebufferLayerViews.length;
  const files = {};
  for (let i = 0; i < N; i++) {
    if (typeof progressFn === "function") progressFn(i, N);
    const disp = state && state.rig && state.rig.displays && state.rig.displays[i];
    const idStr = disp && disp.id ? String(disp.id) : ("d" + i);
    const safeId = idStr.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
    const nn = String(i).padStart(2, "0");
    const blob = await capturePerDisplayPng(i);
    files["display-" + nn + "-" + safeId + ".png"] = new Uint8Array(await blob.arrayBuffer());
  }
  // Sidecar meta.json so the user can correlate display index to pose.
  const meta = {
    timestamp: new Date().toISOString(),
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : "?",
    fbWidth: Visual.fbWidth,
    fbHeight: Visual.fbHeight,
    fbFormat: Visual.fbFormat,
    displayCount: N,
    displays: (state && state.rig && state.rig.displays || []).slice(0, N).map((d, i) => d ? {
      idx: i, id: d.id, name: d.name,
      pose: d.pose || { yaw: 0, pitch: 0, roll: 0 },
      fov:  d.fov  || { h: 90, v: 60 }
    } : { idx: i, missing: true })
  };
  files["meta.json"] = new TextEncoder().encode(JSON.stringify(meta, null, 2));
  if (typeof progressFn === "function") progressFn(N, N);
  const zip = _writeZipArchive(files);
  return new Blob([zip], { type: "application/zip" });
}

/* v0.2.22 — timed composite A/V recording.
 *
 * The "deferred" item for offline render-with-visual mux'd into mp4
 * would need a WebCodecs+container pipeline (VideoEncoder + a webm
 * muxer + AudioEncoder + sync). Significant lift. The practical
 * version that ships today: start a normal composite WebM recording
 * (canvas.captureStream(60) + MediaRecorder, same path as the
 * untimed toggle) but auto-stop after a user-specified duration.
 * Output: a single .webm with audio + visual in sync, matching what
 * the live operator would see at exactly N seconds.
 *
 * Different from the toggle: no need to remember to stop, no risk
 * of grabbing the wrong moment. Plus the stop timer fires from a
 * setTimeout so the user can cancel by clicking the button before
 * the time runs out (which calls stopVideoCapture() and clears the
 * timer). */
let _timedAVTimer = null;
async function startTimedAVRecording(durationSec) {
  durationSec = Math.max(1, Math.min(3600, Number(durationSec) || 30));
  startVideoCapture();
  if (!_videoRecorder) throw new Error("captureStream / MediaRecorder unavailable");
  if (_timedAVTimer) clearTimeout(_timedAVTimer);
  _timedAVTimer = setTimeout(() => {
    _timedAVTimer = null;
    if (_videoRecorder) stopVideoCapture();
  }, durationSec * 1000);
  return durationSec;
}
function cancelTimedAVRecording() {
  if (_timedAVTimer) { clearTimeout(_timedAVTimer); _timedAVTimer = null; }
  if (_videoRecorder) stopVideoCapture();
}

/* =========================================================================
 * v0.2.21 — per-display video recording (.webm-per-layer, bundled in ZIP)
 *
 * One MediaRecorder per rig display. For each display:
 *   - Allocate an offscreen <canvas> at Visual.fbWidth × Visual.fbHeight
 *     (the SAME texture-array layer's native resolution; viewport DPR
 *     does not affect this).
 *   - Get a WebGPU context from the canvas, configure with the same
 *     device + presentation format used by the visible canvas.
 *   - Build a bind group for the existing Visual.blitPipeline that
 *     samples framebufferLayerViews[i].
 *   - Each frame, after the main render loop finishes Visual.framebuffer,
 *     encode a blit pass into each per-display canvas's swapchain
 *     texture. WebGPU presents each canvas independently.
 *   - canvas.captureStream(60) feeds a MediaRecorder. Audio tap is
 *     per-recorder (each gets its own MediaStreamDestinationNode
 *     hanging off previewState.workletNode).
 *
 * Stop: stop every recorder, await all "stop" events, bundle the chunks
 * into a ZIP with display-NN-<id>.webm entries + meta.json.
 *
 * Memory cost note: at 1080p × 8 displays = ~63 MB of swapchain memory;
 * at 4K × 26 (AlloSphere) = ~850 MB. The sub-line in the menu calls
 * out the heavy case so the user knows what they're committing to. */

const perDisplayRec = {
  active: false,
  canvases: [],
  contexts: [],
  bindGroups: [],
  recorders: [],
  chunks: [],
  audioTaps: [],
  startT: 0,
  mime: "video/webm",
  fbWidth: 0,
  fbHeight: 0,
  layerCount: 0,
  uiTimer: null
};

function perDisplayRecordingActive() { return perDisplayRec.active; }

function perDisplayRecordingToggle() {
  if (perDisplayRec.active) {
    return _stopPerDisplayRecordingAndDownload();
  }
  return _startPerDisplayRecording();
}

async function _startPerDisplayRecording() {
  if (perDisplayRec.active) return;
  if (!Visual.device || !Visual.blitPipeline || !Visual.framebufferLayerViews ||
      !Visual.framebufferLayerViews.length) {
    throw new Error("WebGPU not ready / no rig displays");
  }
  const mime = _pickWebmMimeType();
  if (!mime) throw new Error("No supported WebM mime-type for MediaRecorder");
  const N = Visual.framebufferLayerViews.length;
  perDisplayRec.mime = mime;
  perDisplayRec.fbWidth  = Visual.fbWidth;
  perDisplayRec.fbHeight = Visual.fbHeight;
  perDisplayRec.layerCount = N;
  perDisplayRec.canvases = [];
  perDisplayRec.contexts = [];
  perDisplayRec.bindGroups = [];
  perDisplayRec.recorders = [];
  perDisplayRec.chunks = [];
  perDisplayRec.audioTaps = [];

  for (let i = 0; i < N; i++) {
    const c = document.createElement("canvas");
    c.width  = Visual.fbWidth;
    c.height = Visual.fbHeight;
    c.style.cssText = "position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;visibility:hidden;pointer-events:none;";
    document.body.appendChild(c);
    const ctx = c.getContext("webgpu");
    if (!ctx) {
      console.warn("[per-display] failed to get WebGPU context for layer", i);
      c.remove();
      perDisplayRec.canvases.push(null);
      perDisplayRec.contexts.push(null);
      perDisplayRec.bindGroups.push(null);
      perDisplayRec.recorders.push(null);
      perDisplayRec.chunks.push([]);
      perDisplayRec.audioTaps.push(null);
      continue;
    }
    ctx.configure({
      device: Visual.device,
      format: Visual.presentationFormat,
      alphaMode: "premultiplied"
    });
    const bg = Visual.device.createBindGroup({
      label: "per-display-blit-bg-" + i,
      layout: Visual.blitBindGroupLayout,
      entries: [
        { binding: 0, resource: Visual.framebufferLayerViews[i] },
        { binding: 1, resource: Visual.blitSampler }
      ]
    });
    const stream = c.captureStream(60);
    // Per-recorder audio tap — each MediaRecorder needs its own
    // MediaStreamDestinationNode because a MediaStream's audio tracks
    // can't be shared across recorders. The worklet output node fans
    // out to ctx.destination (speakers) AND every tap dest.
    let audioTap = null;
    if (previewState && previewState.audioCtx && previewState.workletNode) {
      try {
        const dest = previewState.audioCtx.createMediaStreamDestination();
        previewState.workletNode.connect(dest);
        for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
        audioTap = { dest, srcNode: previewState.workletNode };
      } catch (e) {
        console.warn("[per-display] audio tap failed for layer", i, e);
      }
    }
    let rec = null;
    const chunks = [];
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
      rec.start(1000);
    } catch (e) {
      console.warn("[per-display] MediaRecorder ctor failed for layer", i, e);
      if (audioTap) { try { audioTap.srcNode.disconnect(audioTap.dest); } catch (_) {} audioTap = null; }
      try { ctx.unconfigure(); } catch (_) {}
      c.remove();
      perDisplayRec.canvases.push(null);
      perDisplayRec.contexts.push(null);
      perDisplayRec.bindGroups.push(null);
      perDisplayRec.recorders.push(null);
      perDisplayRec.chunks.push([]);
      perDisplayRec.audioTaps.push(null);
      continue;
    }
    perDisplayRec.canvases.push(c);
    perDisplayRec.contexts.push(ctx);
    perDisplayRec.bindGroups.push(bg);
    perDisplayRec.recorders.push(rec);
    perDisplayRec.chunks.push(chunks);
    perDisplayRec.audioTaps.push(audioTap);
  }
  perDisplayRec.active = true;
  perDisplayRec.startT = performance.now();
  _updatePerDisplayRecUi(true);
  if (perDisplayRec.uiTimer) clearInterval(perDisplayRec.uiTimer);
  perDisplayRec.uiTimer = setInterval(_updatePerDisplayElapsed, 250);
}

async function _stopPerDisplayRecordingAndDownload() {
  if (!perDisplayRec.active) return;
  // Halt the render-loop blit hook FIRST so no further commands target
  // the recorder canvases. The recorders will flush their last data on
  // stop().
  perDisplayRec.active = false;
  if (perDisplayRec.uiTimer) { clearInterval(perDisplayRec.uiTimer); perDisplayRec.uiTimer = null; }

  const stops = perDisplayRec.recorders.map(rec => {
    if (!rec || rec.state === "inactive") return Promise.resolve();
    return new Promise(resolve => {
      rec.addEventListener("stop", () => resolve(), { once: true });
      try { rec.stop(); } catch (_) { resolve(); }
    });
  });
  await Promise.all(stops);

  const N = perDisplayRec.layerCount;
  const files = {};
  const ext = perDisplayRec.mime.includes("webm") ? "webm" : "bin";
  for (let i = 0; i < N; i++) {
    const chunks = perDisplayRec.chunks[i];
    if (!chunks || !chunks.length) continue;
    const blob = new Blob(chunks, { type: perDisplayRec.mime });
    const disp = state && state.rig && state.rig.displays && state.rig.displays[i];
    const idStr = disp && disp.id ? String(disp.id) : ("d" + i);
    const safeId = idStr.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
    const nn = String(i).padStart(2, "0");
    files["display-" + nn + "-" + safeId + "." + ext] = new Uint8Array(await blob.arrayBuffer());
  }
  const elapsedS = (performance.now() - perDisplayRec.startT) / 1000;
  files["meta.json"] = new TextEncoder().encode(JSON.stringify({
    timestamp: new Date().toISOString(),
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : "?",
    durationSec: elapsedS,
    fbWidth:  perDisplayRec.fbWidth,
    fbHeight: perDisplayRec.fbHeight,
    fbFormat: Visual.fbFormat,
    mime: perDisplayRec.mime,
    fps: 60,
    displayCount: N,
    displays: (state && state.rig && state.rig.displays || []).slice(0, N).map((d, i) => d ? {
      idx: i, id: d.id, name: d.name,
      pose: d.pose || { yaw: 0, pitch: 0, roll: 0 },
      fov:  d.fov  || { h: 90, v: 60 }
    } : { idx: i, missing: true })
  }, null, 2));
  const zip = _writeZipArchive(files);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  _downloadBlob(new Blob([zip], { type: "application/zip" }), "gamma-perdisplay-rec-" + stamp + ".zip");

  // Cleanup canvases + audio taps + reset state
  for (let i = 0; i < perDisplayRec.canvases.length; i++) {
    const c = perDisplayRec.canvases[i];
    const ctx = perDisplayRec.contexts[i];
    const tap = perDisplayRec.audioTaps[i];
    if (tap) { try { tap.srcNode.disconnect(tap.dest); } catch (_) {} }
    if (ctx) { try { ctx.unconfigure(); } catch (_) {} }
    if (c && c.parentNode) c.parentNode.removeChild(c);
  }
  perDisplayRec.canvases = [];
  perDisplayRec.contexts = [];
  perDisplayRec.bindGroups = [];
  perDisplayRec.recorders = [];
  perDisplayRec.chunks = [];
  perDisplayRec.audioTaps = [];
  _updatePerDisplayRecUi(false);
}

/* Per-frame blit hook — called from renderVisualFrame() after the
 * composite/theater/warp passes complete. Encodes one blit pass per
 * active recorder canvas; uses the SAME command encoder as the main
 * frame so everything submits in one Visual.device.queue.submit. */
function _encodePerDisplayBlitsIntoEncoder(enc) {
  if (!perDisplayRec.active) return;
  const N = perDisplayRec.contexts.length;
  for (let i = 0; i < N; i++) {
    const ctx = perDisplayRec.contexts[i];
    const bg  = perDisplayRec.bindGroups[i];
    if (!ctx || !bg) continue;
    let view;
    try { view = ctx.getCurrentTexture().createView(); }
    catch (e) {
      // The browser dropped the canvas's swapchain (e.g. tab backgrounded).
      // Skip this frame; future frames will retry.
      continue;
    }
    const pass = enc.beginRenderPass({
      label: "per-display-blit-" + i,
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 1.0 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(Visual.blitPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }
}

function _updatePerDisplayRecUi(recording) {
  const tag = document.getElementById("exp-rec-pd-tag");
  if (tag) tag.style.display = recording ? "inline-block" : "none";
  const btn = document.getElementById("exp-rec-perdisplay");
  if (btn) {
    const nameEl = btn.querySelector(".export-action-name");
    if (nameEl) {
      // Preserve trailing REC tag inside the name span (it's a child).
      // Re-render label text but keep the tag node alive.
      const tagInside = nameEl.querySelector(".recording-tag");
      nameEl.firstChild && (nameEl.firstChild.textContent =
        recording ? "Stop per-display recording → ZIP " : "Record per-display → ZIP ");
      if (tagInside) {
        tagInside.style.display = recording ? "inline-block" : "none";
      }
    }
  }
}

function _updatePerDisplayElapsed() {
  if (!perDisplayRec.active) return;
  const tag = document.getElementById("exp-rec-pd-tag");
  if (!tag) return;
  const s = Math.floor((performance.now() - perDisplayRec.startT) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  tag.textContent = "REC " + mm + ":" + ss;
}

/* =========================================================================
 * v0.2.21 — Offline audio render to WAV (high-quality)
 *
 * Runs the cached patch wasm through an OfflineAudioContext (no audio
 * device, no real-time deadline) for the requested duration. Output:
 * stereo 16-bit PCM WAV at the sample rate of the realtime preview
 * context (typically 48 kHz). Higher than real-time playback in
 * practice because the worklet's audio quantum is the same but the
 * host can run it as fast as the CPU allows.
 *
 * Requires the wasm bytes from the most recent successful compile --
 * previewState.lastWasm is populated in previewCompileAndPlay before
 * the transfer to the realtime worklet (see the two
 * `previewState.lastWasm = wasmBytes.slice(0)` lines).
 *
 * The OfflineAudioContext is a fresh BaseAudioContext: addModule the
 * processor source, instantiate a new AudioWorkletNode, send it the
 * cached wasm via postMessage. No realtime SAB bridge in offline mode
 * (audio uniform path is a visual concern; render-to-file doesn't
 * need it). MIDI / mic / clock-driven setters all run from the
 * worklet's auto-fire body the same way they do realtime. */
async function renderOfflineAudio(durationSec) {
  if (!previewState || !previewState.lastWasm) {
    throw new Error("No compiled wasm cached. Click ▶ once to compile the patch, then try again.");
  }
  durationSec = Math.max(0.1, Math.min(3600, Number(durationSec) || 30));
  const sampleRate = (previewState.audioCtx && previewState.audioCtx.sampleRate) || 48000;
  const numChannels = 2;
  const lengthSamples = Math.max(1, Math.floor(durationSec * sampleRate));
  const offCtx = new OfflineAudioContext({
    numberOfChannels: numChannels,
    length: lengthSamples,
    sampleRate: sampleRate
  });
  const blob = new Blob([PREVIEW_PROCESSOR_SRC], { type: "application/javascript" });
  const url  = URL.createObjectURL(blob);
  try {
    await offCtx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(offCtx, "gamma-preview-processor", {
    outputChannelCount: [numChannels],
    // v0.3.19 — second input slot reserved for VideoSrc aggregate (see
    // live-preview path). For offline render there are no Web Audio
    // sources to feed it so it stays silent + the worklet's vid-buf
    // writes turn into zero samples; harmless.
    numberOfInputs: 2,
    numberOfOutputs: 1
  });
  node.connect(offCtx.destination);
  // Clone the cached wasm so we don't detach the master copy when we
  // transfer it to the offline worklet.
  const wasmClone = previewState.lastWasm.slice(0);
  // Wait for the worklet to confirm "loaded" before starting the render.
  // The worklet posts "loaded" once instantiation completes; without
  // this we'd start with an empty processor that emits silence.
  const loaded = new Promise((resolve, reject) => {
    let timer = null;
    const onmsg = (ev) => {
      if (!ev || !ev.data) return;
      if (ev.data.type === "loaded") {
        node.port.removeEventListener("message", onmsg);
        if (timer) clearTimeout(timer);
        resolve();
      } else if (ev.data.type === "error") {
        node.port.removeEventListener("message", onmsg);
        if (timer) clearTimeout(timer);
        reject(new Error(ev.data.error || "worklet load error"));
      }
    };
    node.port.addEventListener("message", onmsg);
    node.port.start();
    // Safety timeout: if no "loaded" arrives in 8 s, abort. WASM instantiation
    // for typical patches completes well under 1 s.
    timer = setTimeout(() => {
      node.port.removeEventListener("message", onmsg);
      reject(new Error("worklet load timeout"));
    }, 8000);
  });
  node.port.postMessage({ type: "load", wasmBytes: wasmClone }, [wasmClone]);
  await loaded;
  const audioBuffer = await offCtx.startRendering();
  return audioBuffer;
}

/* Encode an AudioBuffer to a WAV Blob. v0.2.22 — supports three
 * common bit depths:
 *   16    → signed PCM, 2 B/sample        (default, CD-quality, ~10 MB/min stereo @ 48kHz)
 *   24    → signed PCM, 3 B/sample        (DAW-friendly, ~15 MB/min)
 *   32    → IEEE float, 4 B/sample        (archival, lossless headroom, ~20 MB/min)
 * Format code in the fmt chunk: 1 for PCM (16/24), 3 for IEEE float (32).
 * Clamps to [-1, 1] before quantization; for 32-bit float the samples
 * are written verbatim (no clamping; signals above 0 dBFS preserved
 * for downstream processing). */
function audioBufferToWavBlob(audioBuffer, bitDepth) {
  bitDepth = (bitDepth === 24 || bitDepth === 32) ? bitDepth : 16;
  const isFloat       = (bitDepth === 32);
  const bytesPerSamp  = bitDepth / 8;
  const numChannels   = audioBuffer.numberOfChannels;
  const sampleRate    = audioBuffer.sampleRate;
  const length        = audioBuffer.length;
  const channelData   = [];
  for (let ch = 0; ch < numChannels; ch++) channelData.push(audioBuffer.getChannelData(ch));
  const dataBytes = length * numChannels * bytesPerSamp;
  const buf  = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  let p = 0;
  const wstr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };
  wstr("RIFF");
  view.setUint32(p, 36 + dataBytes, true);                    p += 4;
  wstr("WAVE");
  wstr("fmt ");
  view.setUint32(p, 16, true);                                p += 4;  // fmt chunk size (16 = canonical PCM/float)
  view.setUint16(p, isFloat ? 3 : 1, true);                   p += 2;  // 1=PCM, 3=IEEE float
  view.setUint16(p, numChannels, true);                       p += 2;
  view.setUint32(p, sampleRate, true);                        p += 4;
  view.setUint32(p, sampleRate * numChannels * bytesPerSamp, true); p += 4;  // byte rate
  view.setUint16(p, numChannels * bytesPerSamp, true);        p += 2;  // block align
  view.setUint16(p, bitDepth, true);                          p += 2;  // bits per sample
  wstr("data");
  view.setUint32(p, dataBytes, true);                         p += 4;

  // Write payload — bit-depth-specific.
  let off = 44;
  if (isFloat) {
    // 32-bit IEEE float. No clamping -- pass-through; signal headroom
    // above 0 dBFS preserved for archival / pre-mastering use.
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        view.setFloat32(off, channelData[ch][i], true);
        off += 4;
      }
    }
  } else if (bitDepth === 24) {
    // 24-bit signed PCM, little-endian three-byte words. Range
    // [-8388608, 8388607]. JS doesn't have setInt24; pack manually.
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let s = channelData[ch][i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        const v = (s < 0) ? Math.round(s * 0x800000) : Math.round(s * 0x7FFFFF);
        view.setUint8(off,     v        & 0xFF);
        view.setUint8(off + 1, (v >> 8)  & 0xFF);
        view.setUint8(off + 2, (v >> 16) & 0xFF);
        off += 3;
      }
    }
  } else {
    // 16-bit signed PCM (default). Range [-32768, 32767].
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let s = channelData[ch][i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        const v = (s < 0) ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
        view.setInt16(off, v, true);
        off += 2;
      }
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

/* v0.2.22 — MP3 export via lamejs (loaded from CDN on first use).
 *
 * Dynamic-import pattern mirrors the AI panel: don't load the library
 * unless the user asks for MP3. ~270 KB total (lame.min.js), cached
 * by the browser after first fetch.
 *
 * Encoding: float32 -> int16 -> Mp3Encoder.encodeBuffer in 1152-sample
 * (MP3 frame-size) chunks. Mono and stereo both supported; lamejs's
 * encoder takes (left, right) for stereo or just (mono) for mono. */
let _lamejsLoadPromise = null;
function _loadLamejs() {
  if (typeof globalThis.lamejs !== "undefined") return Promise.resolve(globalThis.lamejs);
  if (_lamejsLoadPromise) return _lamejsLoadPromise;
  // Pinned UMD bundle; the JsDelivr mirror is heavily cached. Falls
  // back to unpkg if the first host fails.
  const urls = [
    "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js",
    "https://unpkg.com/lamejs@1.2.1/lame.min.js"
  ];
  _lamejsLoadPromise = (async () => {
    for (const url of urls) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = url;
          s.async = true;
          s.onload  = () => resolve();
          s.onerror = () => reject(new Error("script load failed: " + url));
          document.head.appendChild(s);
        });
        if (typeof globalThis.lamejs !== "undefined") return globalThis.lamejs;
      } catch (e) {
        console.warn("[mp3] lamejs CDN attempt failed:", e);
      }
    }
    throw new Error("Could not load lamejs from any CDN (jsdelivr / unpkg)");
  })();
  return _lamejsLoadPromise;
}

async function audioBufferToMp3Blob(audioBuffer, bitrateKbps) {
  const lib = await _loadLamejs();
  bitrateKbps = Math.max(64, Math.min(320, bitrateKbps || 320));
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate  = audioBuffer.sampleRate;
  const length      = audioBuffer.length;
  const Mp3Encoder  = lib.Mp3Encoder;
  if (!Mp3Encoder) throw new Error("lamejs.Mp3Encoder missing — wrong build");
  const enc = new Mp3Encoder(numChannels, sampleRate, bitrateKbps);
  const dataL = audioBuffer.getChannelData(0);
  const dataR = numChannels > 1 ? audioBuffer.getChannelData(1) : null;
  // MP3 frame size is 1152 samples. Encode in chunks of that to keep
  // the encoder's internal buffers small + flush smoothly at the end.
  const CHUNK = 1152;
  const chunks = [];
  const toI16 = (buf, start, end) => {
    const out = new Int16Array(end - start);
    for (let i = start; i < end; i++) {
      let s = buf[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i - start] = (s < 0) ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
    }
    return out;
  };
  for (let i = 0; i < length; i += CHUNK) {
    const end = Math.min(i + CHUNK, length);
    const L = toI16(dataL, i, end);
    let mp3buf;
    if (dataR) {
      const R = toI16(dataR, i, end);
      mp3buf = enc.encodeBuffer(L, R);
    } else {
      mp3buf = enc.encodeBuffer(L);
    }
    if (mp3buf && mp3buf.length > 0) chunks.push(new Uint8Array(mp3buf));
  }
  const tail = enc.flush();
  if (tail && tail.length > 0) chunks.push(new Uint8Array(tail));
  return new Blob(chunks, { type: "audio/mpeg" });
}

/* =========================================================================
 * v0.2.23 — Standalone HTML export
 *
 * Bakes the current patch into a self-contained copy of the editor
 * HTML. Fetches our own HTML via fetch(location.href), injects a
 * `<script type="application/json" id="gamma-embedded-patch">` block
 * carrying state JSON, and downloads the result. The loader at the
 * very bottom of the script body (search for "Standalone HTML loader")
 * picks up the embed and calls _applyLoadedPatch before the first
 * render — so opening the exported file replaces the demo patch with
 * the embedded one.
 *
 * Browser autoplay restrictions still apply: audio won't start until
 * the user clicks ▶ in the exported file (same as the editor). The
 * autoLiveMode option auto-enters Live Mode after device acquisition
 * so the visual layer fills the screen on open without a manual
 * toggle. Press L to flip back to the editor.
 *
 * Caveats vs. the roadmap §9 "pre-warmed WGSL pipeline cache" spec:
 * the cache is per-device, can't be serialized portably. WGSL hashes
 * (the cache keys) are the same regardless, so first-frame compile
 * latency on the exported file is identical to the editor's. */
async function exportStandaloneHtml(options) {
  options = options || {};
  const autoLiveMode = options.autoLiveMode !== false;       // default true
  const viewerMode   = options.viewerMode   !== false;       // default true — "stripped viewer"
  const bundleWasm   = options.bundleWasm   !== false;       // default true when viewerMode

  // Viewer mode requires a compiled patch wasm so the page can run
  // self-contained (no daemon, no Wasmer SDK fetch). The wasm bytes
  // are cached in previewState.lastWasm by the realtime / offline
  // render paths (cloned via slice() BEFORE the postMessage transfer
  // -- see the two "previewState.lastWasm = wasmBytes.slice(0)" lines
  // in previewCompileAndPlay).
  //
  // v0.2.25 — if no cached wasm, auto-compile now. Saves the user
  // a manual "click ▶, then click Export" two-step. Uses the same
  // local-cli / Wasmer SDK pipeline as the realtime play path. We
  // report progress through the standalone-button's nameEl + the
  // modal status line via the caller's progress callback below.
  if (viewerMode && bundleWasm) {
    const cached = previewState && previewState.lastWasm && previewState.lastWasm.byteLength;
    if (!cached) {
      try {
        const progress = typeof options.progress === "function" ? options.progress : null;
        if (progress) progress("No cached wasm — compiling patch first…");
        const bytes = await compilePatchForExport(progress);
        if (!bytes || bytes.byteLength === 0) {
          throw new Error("Compile returned empty wasm");
        }
        // Cache for future exports + any subsequent ▶ click.
        previewState.lastWasm = bytes.slice(0);
      } catch (e) {
        throw new Error("Auto-compile for viewer failed: " + (e && e.message || e) +
          ". Start gamma-compile-server or click ▶ first to compile, then retry Export.");
      }
    }
  }

  // 1. Fetch our own HTML. fetch on a file:// URL is blocked by
  //    browsers -- the export must be triggered from an http(s)-
  //    served editor. The standalone OUTPUT, on the other hand,
  //    works from file:// because the wasm + patch are embedded.
  let html;
  try {
    const res = await fetch(location.href, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    html = await res.text();
  } catch (e) {
    throw new Error("Could not fetch editor HTML (" + e.message +
      "). The Export action must be triggered from the editor served via http(s); " +
      "the EXPORTED file then works anywhere (file:// included).");
  }
  if (!/<\/body>/i.test(html)) {
    throw new Error("Self HTML missing </body> -- unexpected file shape");
  }

  // 2. Build the embed blocks. A literal close-script tag inside
  //    embedded JSON would close the parent script prematurely;
  //    escape it to "<\/script>" so the HTML parser sees text but
  //    the JSON round-trip preserves the bytes. (Same reason this
  //    source file writes its own close tags via the CLOSE
  //    constant; otherwise the editor's <script> block closes
  //    mid-function.)
  const patchJson = JSON.stringify(state, _omitRuntimeKeys, 2);
  const safeJson  = patchJson.replace(/<\/script/gi, "<\\/script");
  const cfgJson   = JSON.stringify({
    autoLiveMode,
    viewerMode,
    exportedAt: new Date().toISOString(),
    fromVersion: (typeof APP_VERSION !== "undefined" ? APP_VERSION : "?")
  });
  const CLOSE = "<\/script>";   // see comment above

  let embed =
    '<script type="application/json" id="gamma-embedded-patch">\n' + safeJson + '\n' + CLOSE + '\n' +
    '<script type="application/json" id="gamma-embedded-config">\n' + cfgJson  + '\n' + CLOSE + '\n';

  // 3. Bundle the patch wasm as base64 if viewer mode requested it.
  //    Use chunked btoa to avoid String.fromCharCode.apply argument-
  //    length limits on large buffers (some browsers cap at ~125k
  //    arguments). 32 KB chunks are safe.
  let wasmKb = 0;
  if (viewerMode && bundleWasm && previewState.lastWasm) {
    const u8 = new Uint8Array(previewState.lastWasm);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
    }
    const b64 = btoa(bin);
    wasmKb = u8.length / 1024;
    embed +=
      '<script type="application/octet-stream" id="gamma-embedded-wasm">' + b64 + CLOSE + '\n';
  }

  // 4. Strip any embed left over from a previous export so a re-
  //    export cycle doesn't compound the embed blocks.
  html = html.replace(
    /<script[^>]+id\s*=\s*["']gamma-embedded-(?:patch|config|wasm)["'][^>]*>[\s\S]*?<\/script>\s*/gi,
    ""
  );

  // 5. Insert the fresh embeds BEFORE the main inline editor <script>
  //    (the only <script> tag with no attributes — all the others
  //    have src= or defer). v0.2.24 used </body> here, but that
  //    trailing position meant the main script's boot IIFE ran BEFORE
  //    the parser reached the embed tags + getElementById returned
  //    null -- the exported file opened a blank editor with no patch
  //    loaded. Pre-script injection guarantees the data tags are in
  //    the DOM by the time the IIFE looks them up.
  const scriptInjected = html.replace(/<script>/, embed + "<script>");
  if (scriptInjected === html) {
    throw new Error("Could not locate inline <script> tag in editor HTML — exported file would not auto-load. (Editor source may have changed; please file a bug.)");
  }
  html = scriptInjected;

  // 6. Viewer mode: strip external script/link tags that don't work
  //    from file:// and produce noisy console errors. The viewer
  //    doesn't need any of them:
  //      - coi-serviceworker.min.js relies on serviceworker registration
  //        which file:// disallows; without it crossOriginIsolated is
  //        false + SAB is unavailable, so audio-reactive shaders go
  //        silent. The audio still PLAYS -- visuals just don't react.
  //      - CodeMirror CDN scripts + stylesheets only feed the User DSP
  //        editor which viewer mode hides anyway. The udspEditor init
  //        already guards `typeof CodeMirror === "undefined"`.
  if (viewerMode) {
    html = html.replace(/<script[^>]+src=["']coi-serviceworker[^"']*["'][^>]*>\s*<\/script>\s*/gi, "");
    html = html.replace(/<script[^>]+src=["']https:\/\/cdn\.jsdelivr\.net\/npm\/codemirror[^"']*["'][^>]*>\s*<\/script>\s*/gi, "");
    html = html.replace(/<link[^>]+href=["']https:\/\/cdn\.jsdelivr\.net\/npm\/codemirror[^"']*["'][^>]*\/?>\s*/gi, "");
    // Google Fonts preconnects + stylesheet — emit cross-origin
    // warnings on file:// and aren't structurally required (CSS
    // falls back to system fonts gracefully). Strip in viewer mode
    // for a quieter console; the editor keeps them because the
    // typography matters for the authoring UI.
    html = html.replace(/<link[^>]+rel=["']preconnect["'][^>]*href=["']https:\/\/fonts\.[^"']*["'][^>]*\/?>\s*/gi, "");
    html = html.replace(/<link[^>]+href=["']https:\/\/fonts\.googleapis\.com\/[^"']*["'][^>]*\/?>\s*/gi, "");
  }

  // 7. Update <title> for browser-history/tab-strip identification.
  const className = ((state && state.patchName) || "MyPatch")
    .replace(/[^A-Za-z0-9_-]/g, "");
  const titleTag = viewerMode ? " — Gamma Node viewer" : " — Gamma Node patch";
  html = html.replace(
    /<title>[^<]*<\/title>/i,
    "<title>" + className + titleTag + "</title>"
  );

  return {
    html,
    filename: (viewerMode ? "gamma-viewer-" : "gamma-standalone-") + className + ".html",
    size: html.length,
    wasmKb,
    viewerMode
  };
}

/* =========================================================================
 * v0.2.19 — Export center modal control
 * ======================================================================== */

function _openExportModal() {
  const modal = document.getElementById("export-modal");
  if (!modal) return;
  // Refresh dynamic bits before the user sees the modal:
  //   - preview mode name in the composite-preview sub-line
  //   - target resolution in the per-display action sub-line
  //   - display selector (populated from current state.rig)
  //   - recording-state tag mirrors the HUD pill
  const modeEl = document.getElementById("exp-preview-mode");
  if (modeEl) {
    const pm = (state && state.rig && state.rig.previewMode) || "tile";
    modeEl.textContent = pm === "theater" ? "theater (3D explorable camera)" : pm;
  }
  const dimsEl = document.getElementById("exp-fb-dims");
  if (dimsEl) dimsEl.textContent = (Visual.fbWidth || "?") + "×" + (Visual.fbHeight || "?");
  // Resolved .h filename = patchName sanitized (matches what
  // wrapForPreview + the gen-C++ tab use). Falls back to MyPatch.h.
  const hdrNameEl = document.getElementById("exp-header-name");
  if (hdrNameEl) {
    const className = ((state && state.patchName) || "MyPatch").replace(/[^A-Za-z0-9_]/g, "") || "MyPatch";
    hdrNameEl.textContent = className + ".h";
  }
  const sel = document.getElementById("exp-display-pick");
  if (sel) {
    sel.innerHTML = "";
    const displays = (state && state.rig && state.rig.displays) || [];
    if (displays.length === 0) {
      const opt = document.createElement("option");
      opt.value = "-1";
      opt.textContent = "(no rig displays)";
      opt.disabled = true;
      sel.appendChild(opt);
    } else {
      for (let i = 0; i < displays.length; i++) {
        const d = displays[i];
        const name = d && (d.name || d.id) ? (d.name || d.id) : "display " + i;
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = "Display " + String(i).padStart(2, "0") + " — " + name +
          "   " + (Visual.fbWidth || "?") + "×" + (Visual.fbHeight || "?");
        sel.appendChild(opt);
      }
    }
  }
  const tag = document.getElementById("exp-rec-state-tag");
  if (tag) tag.style.display = _videoRecorder ? "inline-block" : "none";
  // v0.2.21 — per-display rec state + dims, audio render context info.
  const pdDimsEl = document.getElementById("exp-rec-pd-dims");
  if (pdDimsEl) pdDimsEl.textContent = (Visual.fbWidth || "?") + "×" + (Visual.fbHeight || "?");
  _updatePerDisplayRecUi(perDisplayRecordingActive());
  const srEl = document.getElementById("exp-audio-sr");
  if (srEl) {
    const sr = (previewState && previewState.audioCtx && previewState.audioCtx.sampleRate) || 48000;
    srEl.textContent = String(sr);
  }
  const status = document.getElementById("exp-status");
  if (status) { status.textContent = ""; status.className = "export-status"; }
  modal.style.display = "flex";
}

function _closeExportModal() {
  const modal = document.getElementById("export-modal");
  if (modal) modal.style.display = "none";
}

function _setExportStatus(msg, kind) {
  const el = document.getElementById("exp-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "export-status" + (kind ? " " + kind : "");
}

const PREVIEW = {
  // URL of the pre-built Gamma static-library tarball. Produce locally
  // via wasm-build/build-gamma-wasm.sh and host it under /assets/ on the
  // same origin as the editor. See wasm-build/README.md.
  gammaArchiveUrl: "assets/gamma-wasm-v3.tar.gz",
  gammaArchiveCacheKey: "gamma-wasm-archive-v3",
  // Wasmer SDK — pinned via unpkg (NOT esm.run; the latter rebundles
  // and breaks the SDK's relative-URL lookup of its sibling WASM blob,
  // which surfaces as "WebAssembly: HTTP status code is not ok" on
  // init()). Matches the canonical example in
  // https://wasmer.io/posts/clang-in-browser
  wasmerSdkUrl: "https://unpkg.com/@wasmer/sdk@0.10.0/dist/index.mjs",
  // Local compile-server (the gamma-compile-server npm package, runs
  // as a daemon on the user's machine). When detected via the health
  // probe at first Play click, compile requests route there instead
  // of the in-browser Wasmer path — full Emscripten, ~5–15 s per
  // compile, sidesteps the in-browser OOM. See the package README:
  //   github.com/9LiveZZZ-Git/gamma-compile-server
  localServerUrl: "http://localhost:8765",
  localServerProbeTimeoutMs: 250,
  // Compile debounce after a graph mutation.
  hotReloadDebounceMs: 250,
  // Audio quantum (Web Audio standard).
  quantumFrames: 128
};

const previewState = {
  state: "idle",          // idle | compiling | playing | paused | error
  audioCtx: null,
  workletNode: null,
  worker: null,
  workerReady: null,      // Promise that resolves when worker is ready
  pendingCompile: null,   // debounce timer
  lastWrapped: null,      // last wrapped C++ string we sent to compile
  archiveBuffer: null     // ArrayBuffer of the Gamma tarball (cached after first fetch)
};

/* =========================================================================
 * Phase 6.5.1 — Audio bridge (SharedArrayBuffer between worklet + main)
 *
 * Layout (4 KB total, indexed as Int32 + Float32 views over the same SAB):
 *   Header (8 × i32 = 32 bytes):
 *     [0] magic 'GAMA' (0x474D4143)
 *     [1] version (1)
 *     [2] frame counter (Atomics-incremented per audio quantum)
 *     [3] sample rate reinterpret as i32 (read via Float32 view)
 *     [4..7] reserved
 *   Scalars (16 × f32 at indices 8..23):
 *     16 scalar bridge slots. 6.5.2 EnvFollow / 6.5.4 Clock / future
 *     audio-rate-to-uniform nodes register their slot here.
 *   FFT bins (256 × f32 at indices 24..279):
 *     6.5.3 FFTBins writes magnitude bins per quantum.
 *   Remaining bytes 1120..4095 reserved for future expansion (waveform
 *     buffer, gate triggers, etc.).
 *
 * Concurrency model: the worklet is the SOLE writer for slots; the main
 * thread READS only. Atomics.add on the frame counter (index 2) signals
 * "new quantum is in", but each f32 slot read is naturally tear-free at
 * 32-bit alignment so we don't need locks for scalar values. The main
 * thread reads once per requestAnimationFrame and writes to GPU uniform
 * buffers; the worklet runs at audio-quantum rate (~2.7 ms at 48k/128).
 *
 * Slot allocation strategy (deferred to 6.5.2+): each bridge node
 * registers a slot via audioBridge.allocScalar() which returns a stable
 * index. The slot index is baked into the codegen so the wasm-side
 * tick function writes to bridgeFloats[8 + slotIdx]. For 6.5.1 (this
 * commit) the worklet writes ONE smoke-test value (master peak from
 * the audio output buffer) to slot 0 so we can verify the plumbing
 * round-trips before wiring it to shader-frag uniforms. */
const AUDIO_BRIDGE_SAB_BYTES   = 4096;
const AUDIO_BRIDGE_SCALAR_BASE = 8;       // f32 index of slot 0
const AUDIO_BRIDGE_SCALAR_COUNT = 16;
const AUDIO_BRIDGE_FFT_BASE    = 24;      // f32 index of FFT bin 0
const AUDIO_BRIDGE_FFT_COUNT   = 256;
const AUDIO_BRIDGE_MAGIC       = 0x474D4143;  // 'GAMA' little-endian

const audioBridge = {
  sab:        null,
  floats:     null,   // Float32Array view over the whole SAB
  ints:       null,   // Int32Array view over the whole SAB
  available:  false,
  // 6.5.1 — fixed slot assignment so the main thread can read a known
  // value without waiting for a registration handshake. 6.5.2+ will
  // formalize allocation via the EnvFollow/Clock/FFT bridge nodes.
  TEST_MASTER_PEAK_SLOT: 0,

  init() {
    if (this.sab) return true;
    // SharedArrayBuffer needs cross-origin isolation (COOP/COEP). The
    // editor's coi-serviceworker turns this on in production; if it
    // isn't active the bridge stays disabled and readScalar() returns
    // 0. Bridge nodes that depend on it can still ship; they just
    // produce zero until the user gets COOP/COEP right.
    if (typeof SharedArrayBuffer === "undefined" ||
        typeof self !== "undefined" && !self.crossOriginIsolated) {
      this.available = false;
      console.warn("[audio-bridge] SharedArrayBuffer unavailable -- " +
                   "crossOriginIsolated=" + (typeof self !== "undefined" ? self.crossOriginIsolated : "n/a") +
                   "; bridge stays disabled");
      return false;
    }
    try {
      this.sab    = new SharedArrayBuffer(AUDIO_BRIDGE_SAB_BYTES);
      this.floats = new Float32Array(this.sab);
      this.ints   = new Int32Array(this.sab);
      this.ints[0] = AUDIO_BRIDGE_MAGIC;
      this.ints[1] = 1;
      this.ints[2] = 0;
      this.available = true;
      console.log("[audio-bridge] SAB allocated, " + AUDIO_BRIDGE_SAB_BYTES + " B, " +
                  AUDIO_BRIDGE_SCALAR_COUNT + " scalar slots + " +
                  AUDIO_BRIDGE_FFT_COUNT + " FFT bins");
      return true;
    } catch (e) {
      this.available = false;
      console.warn("[audio-bridge] SAB allocation failed:", e);
      return false;
    }
  },

  /* Read a scalar bridge slot. Returns 0 when the bridge isn't
   * available or idx is out of range. Tear-free at 32-bit alignment;
   * stale data is acceptable -- the worklet always writes the latest
   * value, so a read just gets whatever the most recent quantum saw. */
  readScalar(idx) {
    if (!this.available || idx < 0 || idx >= AUDIO_BRIDGE_SCALAR_COUNT) return 0;
    return this.floats[AUDIO_BRIDGE_SCALAR_BASE + idx];
  },

  /* Read one FFT magnitude bin. Same tear-free + stale-OK contract. */
  readFftBin(idx) {
    if (!this.available || idx < 0 || idx >= AUDIO_BRIDGE_FFT_COUNT) return 0;
    return this.floats[AUDIO_BRIDGE_FFT_BASE + idx];
  },

  /* Atomically read the per-quantum frame counter. Diagnostic /
   * health-check: if this doesn't tick over multiple rAF frames, the
   * worklet isn't writing (audio is dead or the worklet hasn't
   * received the bridge-init message yet). */
  frameCounter() {
    if (!this.available) return 0;
    return Atomics.load(this.ints, 2);
  }
};

const previewBtnPlay = document.getElementById("btn-preview-play");
const previewBtnStop = document.getElementById("btn-preview-stop");
const previewStatusEl = document.getElementById("preview-status");
const previewGroupEl = previewBtnPlay && previewBtnPlay.closest(".preview-group");

/* ------------- Compile progress tracker ------------- */
/* Stage list ordered by execution. `baseline` is the first-run estimate
 * in milliseconds; after a successful compile the actual measured time
 * is cached to localStorage and overrides the baseline next session,
 * so ETAs become honest (cached clang load is ~5 s, not 3 min). */
const PREVIEW_STAGES = [
  { id: "prepare",     label: "preparing",                    baseline: 200    },
  { id: "import-sdk",  label: "loading Wasmer SDK",           baseline: 1500   },
  { id: "init-sdk",    label: "initializing runtime",         baseline: 800    },
  { id: "load-clang",  label: "loading clang/clang package",  baseline: 180000 },
  { id: "fetch-gamma", label: "fetching Gamma archive",       baseline: 800    },
  { id: "extract",     label: "extracting + staging",         baseline: 300    },
  { id: "write-patch", label: "writing patch source",         baseline: 50     },
  { id: "compile",     label: "invoking clang + linking",     baseline: 12000  },
  { id: "load-wasm",   label: "loading audio worklet",        baseline: 200    }
];
const PREVIEW_BASELINE_KEY = "gamma-preview-stage-times-v1";

(function loadCachedBaselines() {
  try {
    const raw = localStorage.getItem(PREVIEW_BASELINE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw);
    PREVIEW_STAGES.forEach(s => {
      if (typeof cached[s.id] === "number" && cached[s.id] > 0) {
        s.baseline = cached[s.id];
      }
    });
  } catch (_) {}
})();

const previewProgress = {
  startTime: 0,
  stageIdx: -1,
  stageStart: 0,
  subProgress: 0,    // 0..1, or 0 for "unknown / indeterminate"
  tickerId: null
};

function fmtDuration(ms) {
  if (ms < 950) return Math.max(0, Math.round(ms)) + "ms";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const sr = s % 60;
  return m + "m " + (sr < 10 ? "0" : "") + sr + "s";
}

function previewProgressShow() {
  const el = document.getElementById("preview-progress");
  if (el) el.style.display = "inline-flex";
}
function previewProgressHide() {
  const el = document.getElementById("preview-progress");
  if (el) el.style.display = "none";
}

function previewProgressStart() {
  previewProgress.startTime = Date.now();
  previewProgress.stageIdx = -1;
  previewProgress.subProgress = 0;
  previewProgressShow();
  if (previewProgress.tickerId) clearInterval(previewProgress.tickerId);
  previewProgress.tickerId = setInterval(previewProgressTick, 250);
  previewProgressTick();
}

function previewProgressEnd(saveBaselines) {
  if (previewProgress.tickerId) clearInterval(previewProgress.tickerId);
  previewProgress.tickerId = null;
  if (saveBaselines) {
    // Mark the in-flight stage as completed too.
    if (previewProgress.stageIdx >= 0) {
      const cur = PREVIEW_STAGES[previewProgress.stageIdx];
      cur.lastMeasured = Date.now() - previewProgress.stageStart;
    }
    try {
      const out = {};
      PREVIEW_STAGES.forEach(s => {
        if (s.lastMeasured > 0) out[s.id] = s.lastMeasured;
      });
      localStorage.setItem(PREVIEW_BASELINE_KEY, JSON.stringify(out));
    } catch (_) {}
  }
  previewProgressHide();
}

function previewProgressStage(stageId, sub) {
  // Record actual time for the previously active stage.
  if (previewProgress.stageIdx >= 0) {
    const prev = PREVIEW_STAGES[previewProgress.stageIdx];
    prev.lastMeasured = Date.now() - previewProgress.stageStart;
  }
  const idx = PREVIEW_STAGES.findIndex(s => s.id === stageId);
  if (idx < 0) return;   // unknown stage id — ignore
  previewProgress.stageIdx = idx;
  previewProgress.stageStart = Date.now();
  previewProgress.subProgress = (typeof sub === "number" && sub > 0) ? Math.min(1, sub) : 0;
  previewProgressTick();
}

function previewProgressSub(sub) {
  if (typeof sub !== "number") return;
  previewProgress.subProgress = Math.max(0, Math.min(1, sub));
  previewProgressTick();
}

function previewProgressTick() {
  if (previewProgress.stageIdx < 0) return;
  const fill = document.getElementById("preview-progress-fill");
  const meta = document.getElementById("preview-progress-meta");
  if (!fill || !meta) return;

  const totalBaseline = PREVIEW_STAGES.reduce((s, x) => s + x.baseline, 0);
  const completedBaseline = PREVIEW_STAGES
    .slice(0, previewProgress.stageIdx)
    .reduce((s, x) => s + x.baseline, 0);
  const stage = PREVIEW_STAGES[previewProgress.stageIdx];
  const stageElapsed = Date.now() - previewProgress.stageStart;

  // Stage contribution: real fraction if known, else time-based estimate
  // capped at 90% so an over-running stage doesn't wedge the bar at 100%.
  let stageContribution;
  let indeterminate = false;
  if (previewProgress.subProgress > 0) {
    stageContribution = stage.baseline * previewProgress.subProgress;
  } else {
    indeterminate = true;
    stageContribution = Math.min(stage.baseline * 0.9, stageElapsed);
  }
  const totalContribution = completedBaseline + stageContribution;
  const fraction = Math.min(0.99, totalContribution / totalBaseline);

  fill.classList.toggle("indeterminate", indeterminate);
  if (!indeterminate) {
    fill.style.width = (fraction * 100).toFixed(1) + "%";
  }

  const elapsed = Date.now() - previewProgress.startTime;
  const remaining = Math.max(0, totalBaseline - totalContribution);
  meta.innerHTML =
    `<span class="stage-name">${stage.label}</span> · ` +
    `${previewProgress.stageIdx + 1}/${PREVIEW_STAGES.length} · ` +
    `${fmtDuration(elapsed)} elapsed · ` +
    `<span class="eta">~${fmtDuration(remaining)} left</span>`;
}

function previewProgressFinish() {
  // Snap bar to 100% briefly before hiding.
  const fill = document.getElementById("preview-progress-fill");
  if (fill) {
    fill.classList.remove("indeterminate");
    fill.style.width = "100%";
  }
  setTimeout(() => previewProgressEnd(true), 450);
}

function setPreviewStatus(state, msg) {
  const prev = previewState.state;
  previewState.state = state;
  previewState.lastStatusMsg = msg || state;
  if (state === "error") previewState.lastErrorMsg = msg || state;
  // Touchscreen-popup status pip mirrors playing<->stopped.
  if (prev !== state && typeof _pushTouchControlsSnapshot === "function") {
    _pushTouchControlsSnapshot();
  }
  // Console timeline so the pipeline is visible in DevTools too —
  // useful when the pill text is truncated or moves too fast.
  console.log("[preview] " + state + (msg ? " — " + msg : ""));
  if (!previewStatusEl) return;
  previewStatusEl.className = "preview-status " + state;
  previewStatusEl.textContent = msg || state;
  if (previewGroupEl) {
    previewGroupEl.classList.remove("compiling", "playing", "paused", "error");
    if (state !== "idle") previewGroupEl.classList.add(state);
  }
  if (previewBtnStop) {
    previewBtnStop.disabled = !(state === "playing" || state === "paused" || state === "compiling");
  }
  if (previewBtnPlay) {
    previewBtnPlay.textContent = state === "playing" ? "❚❚" : "▶";
    previewBtnPlay.title = state === "playing"
      ? "Pause playback"
      : state === "paused"
        ? "Resume playback"
        : "Compile patch and start playback";
  }
  const copyBtn = document.getElementById("btn-copy-status");
  if (copyBtn) {
    // Show whenever there's anything worth sharing — useful during
    // long compiles so you can paste the current step without waiting
    // for it to error out.
    copyBtn.style.display = state === "idle" ? "none" : "inline-flex";
    copyBtn.title = state === "error"
      ? "Copy error message + last patch C++"
      : "Copy current preview state";
  }
}

/* Copy-error helpers — flash button green for 1s on success. */
function flashCopied(btn, oldLabel) {
  btn.classList.add("copied");
  const prevText = btn.textContent;
  if (oldLabel !== undefined) btn.textContent = oldLabel;
  setTimeout(() => {
    btn.classList.remove("copied");
    if (oldLabel !== undefined) btn.textContent = prevText;
  }, 1200);
}

(function setupCopyButtons() {
  const copyStatusBtn = document.getElementById("btn-copy-status");
  if (copyStatusBtn) copyStatusBtn.addEventListener("click", async () => {
    // Bundle the current state with patch info + diagnostic context so
    // a single paste is enough to debug from. Works equally well during
    // a long compile (shows what step we're on) or after an error.
    const lines = [];
    const headerLabel = previewState.state === "error" ? "preview error" : "preview state";
    lines.push("Gamma Node Editor v" + APP_VERSION + " — " + headerLabel);
    lines.push("UA: " + navigator.userAgent);
    lines.push("crossOriginIsolated: " + (typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : "(undefined)"));
    lines.push("SharedArrayBuffer: " + (typeof SharedArrayBuffer !== "undefined" ? "available" : "missing"));
    lines.push("State: " + previewState.state);
    lines.push("Pill: " + (previewState.lastStatusMsg || "(none)"));
    if (previewState.lastErrorMsg) {
      lines.push("Last error: " + previewState.lastErrorMsg);
    }
    // Pull whatever the Build pane's compile-output section is showing.
    // That's where compile-error / warnings stderr is rendered, so the
    // header copy now includes it without making the user switch tabs.
    const stderrEl = document.getElementById("build-stderr");
    const stderrText = stderrEl ? (stderrEl.textContent || "").trim() : "";
    if (stderrText) {
      lines.push("");
      lines.push("--- compile output (clang stderr) ---");
      lines.push(stderrText);
    }
    if (previewState.lastWrapped) {
      lines.push("");
      lines.push("--- last wrapped patch C++ ---");
      lines.push(previewState.lastWrapped);
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(copyStatusBtn, "✓");
    } catch (e) {
      copyStatusBtn.title = "Copy failed: " + e.message;
    }
  });

  const copyStderrBtn = document.getElementById("btn-copy-stderr");
  if (copyStderrBtn) copyStderrBtn.addEventListener("click", async () => {
    const out = document.getElementById("build-stderr");
    if (!out) return;
    const lines = [];
    lines.push("Gamma Node Editor v" + APP_VERSION + " — build output");
    lines.push("UA: " + navigator.userAgent);
    lines.push("");
    lines.push(out.textContent);
    if (previewState.lastWrapped) {
      lines.push("");
      lines.push("--- last wrapped patch C++ ---");
      lines.push(previewState.lastWrapped);
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      flashCopied(copyStderrBtn, "✓ Copied");
    } catch (e) {
      copyStderrBtn.textContent = "✗ " + e.message;
    }
  });
})();

/* ------------- Adapter wrapper ------------- */
/* Wraps the editor's emitted patch class in a C-linkage shim that the
 * worklet can call. The setter table maps exposed-setter index → name,
 * so the main thread can post {setterIndex, value} without re-stringifying
 * setter names on every parameter change. */
function collectExposedSetters() {
  // Mirrors generateCode's setter-emission loop. Returns
  // [{name, isGate, nodeId, key, nodeType}] in the SAME order
  // generateCode emits — so index N here corresponds to the index
  // the wasm switch dispatches on. The keyboard handler uses nodeId
  // + key to find the freq setter for a KeyboardIn node.
  const setters = [];
  const used = new Set();
  state.nodes.forEach(n => {
    const def = defOf(n);
    if (!def || !def.cppType) return;
    const auto = def.autoExpose || [];
    const uiOnly = def.uiOnlyParams || [];
    Object.keys(n.params).forEach(k => {
      if (uiOnly.includes(k)) return;
      if (!state.exposed[n.id + "." + k] && !auto.includes(k)) return;
      if (def.paramOptions && def.paramOptions[k]) return;
      let name = k;
      if (used.has(name)) name = n.id + "_" + k;
      used.add(name);
      setters.push({ name, isGate: false, nodeId: n.id, key: k, nodeType: n.type });
    });
    def.ins.forEach(p => {
      if (p.t !== "gate") return;
      if (!state.exposed[n.id + "." + p.n] && !auto.includes(p.n)) return;
      let name = p.n === "trig" ? "trigger" : p.n;
      if (used.has(name)) name = name + "_" + n.id;
      used.add(name);
      setters.push({ name, isGate: true, nodeId: n.id, key: p.n, nodeType: n.type });
    });
    (def.hostGates || []).forEach(gn => {
      let name = gn === "trig" ? "trigger" : gn;
      if (used.has(name)) name = name + "_" + n.id;
      used.add(name);
      setters.push({ name, isGate: true, nodeId: n.id, key: gn, nodeType: n.type });
    });
  });
  return setters;
}

function wrapForPreview(patchSource, className) {
  className = className || "MyPatch";
  const setters = collectExposedSetters();
  // Detect stereo vs mono by scanning the return type the patch class
  // declared. Supports the existing OutputStereo / Output sinks.
  const isStereo = /std::pair<float,float>\s+operator/.test(patchSource);

  let setterDispatch = "";
  let gateAutoFireBody = "";
  setters.forEach((s, i) => {
    if (s.isGate) {
      setterDispatch += `        case ${i}: gPatch->${s.name}(); break;\n`;
      // Fire each gate once at init so envelopes etc. are audible
      // by default. Without this, the demo patch (Sine × AD →
      // BiquadLP → Output) is silent because the AD never resets.
      // Re-trigger via preview_set(<gate index>, 0) from the worklet
      // (e.g. driven by a future MasterClock node).
      gateAutoFireBody += `    gPatch->${s.name}();\n`;
    } else {
      setterDispatch += `        case ${i}: gPatch->${s.name}(v); break;\n`;
    }
  });

  // Mic-input wiring — if the patch has at least one MicInput node,
  // generateCode added a setMicInput() method to the patch class.
  // The wrapper allocates a fixed mic buffer + exports a getter so
  // the worklet can write per-block input audio into it; the tick
  // body then calls gPatch->setMicInput(...) per sample before the
  // operator() call. Without MicInput we skip all of this so patches
  // with no live input still compile to the lean fixed shape.
  const hasMicInput = state.nodes.some(n => n.type === "MicInput");
  const micPrefix = hasMicInput
    ? `        if (i < gMicLen) gPatch->setMicInput(gMicBuf[i]);
`
    : "";
  // v0.3.19 — VideoSrc per-sample dispatch. One pair of setVidL_N /
  // setVidR_N calls per audio-wired VideoFile / Webcam node. The
  // worklet's process() writes inputs[1][2N..2N+1] into the matching
  // wasm buffer pair (gVidBufNL / gVidBufNR) at the top of each
  // quantum; here we drain them per sample BEFORE gPatch's operator()
  // runs so any downstream member node binds against the latest
  // sample. gVidLen mirrors the actual worklet quantum size for
  // safety against future quantum-length changes.
  const vidWrapSrc = (typeof _videoAudioSrcNodes === "function") ? _videoAudioSrcNodes() : [];
  const vidPrefix = vidWrapSrc.length
    ? `        if (i < gVidLen) {
${vidWrapSrc.map((n, idx) =>
    `            gPatch->setVidL_${idx}(gVidBuf${idx}L[i]);
            gPatch->setVidR_${idx}(gVidBuf${idx}R[i]);`
  ).join('\n')}
        }
`
    : "";
  const tickBody = isStereo
    ? `${micPrefix}${vidPrefix}        auto p = (*gPatch)();
        outL[i] = p.first;
        outR[i] = p.second;`
    : `${micPrefix}${vidPrefix}        float s = (*gPatch)();
        outL[i] = s;
        outR[i] = s;`;

  // Mic-buffer module-scope storage + exports. Buffer is sized at
  // 2048 (well above any reasonable AudioWorklet block size — 128
  // is typical, max 1024 in current Chromium). Worklet writes via
  // direct heap access (Float32Array view over wasm memory) for
  // zero-copy performance; preview_set_mic_len tells the wasm side
  // how many samples are actually valid this tick.
  const micGlobals = hasMicInput
    ? `static float gMicBuf[2048];
static int   gMicLen = 0;

PREVIEW_EXPORT(preview_get_mic_buf) const float* preview_get_mic_buf() { return gMicBuf; }
PREVIEW_EXPORT(preview_set_mic_len) void preview_set_mic_len(int n) {
    if (n < 0) n = 0;
    if (n > 2048) n = 2048;
    gMicLen = n;
}
`
    : "";

  // v0.3.19 — VideoSrc per-source ring buffers. One stereo pair per
  // audio-wired VideoFile / Webcam node. preview_get_vid_buf_N_l/r
  // returns the buffer pointer (queried by the worklet after load);
  // preview_set_vid_len mirrors the quantum size. Buffers sized 2048
  // matching the mic-buf safety margin.
  const vidGlobals = vidWrapSrc.length
    ? vidWrapSrc.map((_, idx) =>
        `static float gVidBuf${idx}L[2048];
static float gVidBuf${idx}R[2048];
PREVIEW_EXPORT(preview_get_vid_buf_${idx}_l) const float* preview_get_vid_buf_${idx}_l() { return gVidBuf${idx}L; }
PREVIEW_EXPORT(preview_get_vid_buf_${idx}_r) const float* preview_get_vid_buf_${idx}_r() { return gVidBuf${idx}R; }`
      ).join('\n') +
      `\nstatic int gVidLen = 0;
PREVIEW_EXPORT(preview_set_vid_len) void preview_set_vid_len(int n) {
    if (n < 0) n = 0;
    if (n > 2048) n = 2048;
    gVidLen = n;
}
`
    : "";

  return `${patchSource}

// ---- Preview adapter (auto-generated, do not edit) ----
// Uses Clang's export_name attribute so the resulting WASM module
// exports the right symbols for any wasm32 target (WASI / Emscripten /
// freestanding) without depending on emscripten.h.
#define PREVIEW_EXPORT(name) __attribute__((export_name(#name)))

// Override new/delete to call malloc/free directly. Without this
// libc++'s operator-new templates get instantiated and pull in a huge
// amount of header parsing (typeinfo, exception machinery, the lot).
// Patches don't need any of it; one MyPatch alloc + free at init.
extern "C" void* malloc(unsigned long);
extern "C" void  free(void*);
inline void* operator new(unsigned long n) { return malloc(n); }
inline void  operator delete(void* p) noexcept { free(p); }
inline void  operator delete(void* p, unsigned long) noexcept { free(p); }

static ${className}* gPatch = nullptr;

extern "C" {

${micGlobals}${vidGlobals}// Gamma's units cache per-sample increments at construction time from
// the global Domain. Without an explicit sample-rate set the Domain
// defaults to 1.0, which makes Sine play at the wrong pitch and AD
// complete its envelope in a single sample (audibly silent). The
// worklet calls preview_set_sr with the AudioContext's real rate
// BEFORE preview_init; preview_init also falls back to 48 kHz on
// its own as a safety net.
PREVIEW_EXPORT(preview_set_sr) void preview_set_sr(float sr) {
    if (sr > 0.f) gam::sampleRate(sr);
}

PREVIEW_EXPORT(preview_init) void preview_init() {
    if (gam::sampleRate() <= 1.0) gam::sampleRate(48000.0);
    if (gPatch) delete gPatch;
    gPatch = new ${className}();
${gateAutoFireBody}}

PREVIEW_EXPORT(preview_tick) void preview_tick(float* outL, float* outR, int n) {
    if (!gPatch) return;
    for (int i = 0; i < n; ++i) {
${tickBody}
    }
}

PREVIEW_EXPORT(preview_set) void preview_set(int setterIndex, float v) {
    if (!gPatch) return;
    switch (setterIndex) {
${setterDispatch}        default: break;
    }
}

PREVIEW_EXPORT(preview_setter_count) int preview_setter_count() { return ${setters.length}; }

}  // extern "C"
`;
}

/* ------------- Build pane renderer ------------- */
function renderBuildPane() {
  const wrapOut = document.getElementById("build-wrap-out");
  const wrapInfo = document.getElementById("build-wrap-info");
  if (!wrapOut) return;
  let patchCpp;
  try {
    patchCpp = generateCode();
  } catch (e) {
    wrapOut.textContent = "// generateCode failed: " + e.message;
    return;
  }
  // If generateCode returned a build-error comment block (cycle without
  // Delay1), surface it as-is.
  if (patchCpp.startsWith("// ❌")) {
    wrapOut.textContent = patchCpp;
    if (wrapInfo) wrapInfo.textContent = "";
    return;
  }
  const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
  const wrapped = wrapForPreview(patchCpp, className);
  wrapOut.innerHTML = highlightCpp(wrapped);
  if (wrapInfo) {
    const setters = collectExposedSetters();
    wrapInfo.textContent = `· ${wrapped.length} chars · ${setters.length} setter${setters.length===1?"":"s"}`;
  }
}

/* ------------- Compile Worker ------------- */
/* The worker is created from a Blob URL containing the compile-pipeline
 * code. This keeps the editor a single self-contained HTML file.
 *
 * Pipeline inside the worker:
 *   1. Dynamic-import @wasmer/sdk from esm.run (~few MB, cached by browser).
 *   2. wasmer.init() initializes the WebAssembly runtime.
 *   3. Wasmer.fromRegistry("clang/clang") downloads the clang/clang
 *      package on first use (~100 MB, cached in IndexedDB).
 *   4. Fetch the libgamma.a tarball, decompress (DecompressionStream),
 *      parse the tar to a flat file map, write each entry into a
 *      Wasmer Directory at /project/...
 *   5. Write the wrapped patch C++ to /project/patch.cpp.
 *   6. clang.entrypoint.run({ args: [...], mount: { "/project": dir } });
 *      args invoke clang against patch.cpp + libgamma.a → patch.wasm.
 *   7. dir.readFile("patch.wasm") → return bytes to main thread. */
const COMPILE_WORKER_SRC = String.raw`
let wasmerMod = null;
let clangPkg = null;
let projectDir = null;
let archiveStagedFor = null;   // archive URL we last staged from

function progress(stage, sub) {
  self.postMessage({ type: "progress", stage, subProgress: sub });
}

async function ensureWasmer(sdkUrl) {
  if (wasmerMod) return wasmerMod;
  if (typeof SharedArrayBuffer === "undefined" || !self.crossOriginIsolated) {
    throw new Error(
      "Cross-origin isolation is not active. The page needs to be served " +
      "with COOP=same-origin and COEP=require-corp headers. The included " +
      "coi-serviceworker should install + reload the page on first visit; " +
      "if you see this error, try reloading once more, or open the page " +
      "in a fresh tab. crossOriginIsolated=" + self.crossOriginIsolated
    );
  }
  progress("import-sdk");
  wasmerMod = await import(sdkUrl);
  progress("init-sdk");
  await wasmerMod.init();
  return wasmerMod;
}

async function ensureClang() {
  if (clangPkg) return clangPkg;
  progress("load-clang");
  clangPkg = await wasmerMod.Wasmer.fromRegistry("clang/clang");
  return clangPkg;
}

/* Minimal tar parser for the gamma-wasm archive — handles the small set
 * of header types our build script actually emits (regular files +
 * directories). Each tar header is a 512-byte block; file content
 * follows, padded up to the next 512-byte boundary. */
function parseTar(buf) {
  const out = [];
  const view = new Uint8Array(buf);
  const td = new TextDecoder();
  let off = 0;
  while (off + 512 <= view.length) {
    const header = view.subarray(off, off + 512);
    // Empty block = end of archive (tar marks end with two zero blocks).
    if (header.every(b => b === 0)) break;
    const name = td.decode(header.subarray(0, 100)).replace(/\0+$/, "");
    if (!name) { off += 512; continue; }
    const sizeStr = td.decode(header.subarray(124, 136)).replace(/[\s\0]+$/, "");
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    off += 512;
    if (typeflag === "0" || typeflag === "" || typeflag === "\0") {
      out.push({ name, content: view.slice(off, off + size) });
    }
    off += size;
    if (size % 512 !== 0) off += 512 - (size % 512);
  }
  return out;
}

async function fetchAndExtract(archiveUrl) {
  progress("fetch-gamma");
  const res = await fetch(archiveUrl);
  if (!res.ok) throw new Error("Gamma archive fetch failed: " + res.status + " from " + archiveUrl);
  // Read the body manually so we can emit byte-level progress. The
  // Content-Length header is the compressed size from GitHub Pages.
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) progress("fetch-gamma", received / total);
  }
  // Reassemble into a single Uint8Array, then decompress.
  const compressed = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { compressed.set(c, off); off += c.length; }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tarBuf = await new Response(stream).arrayBuffer();
  progress("extract");
  return parseTar(tarBuf);
}

async function stageArchive(archiveUrl) {
  if (archiveStagedFor === archiveUrl && projectDir) return projectDir;
  const entries = await fetchAndExtract(archiveUrl);
  projectDir = new wasmerMod.Directory();
  // Wasmer's Directory expects forward-slash paths. createDir is safe
  // to call repeatedly; many implementations no-op on existing dirs.
  for (const entry of entries) {
    const dirParts = entry.name.split("/").slice(0, -1);
    let cur = "";
    for (const p of dirParts) {
      cur = cur ? cur + "/" + p : p;
      try { await projectDir.createDir(cur); } catch (_) { /* already exists */ }
    }
    await projectDir.writeFile(entry.name, entry.content);
  }
  archiveStagedFor = archiveUrl;
  return projectDir;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === "warmup") {
    try {
      await ensureWasmer(msg.sdkUrl);
      // clang loads lazily on first compile (it's the biggest download,
      // so only pay the cost when the user actually clicks Play).
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "error", error: String(e && e.message || e) });
    }
    return;
  }
  if (msg.type === "compile") {
    try {
      await ensureWasmer(msg.sdkUrl);
      await ensureClang();
      const dir = await stageArchive(msg.archiveUrl);

      progress("write-patch");
      // Wipe stale outputs from prior runs so a failing compile can't
      // accidentally hand the AudioWorklet a leftover wasm from an
      // earlier successful run (e.g. smoke output sticking around when
      // a real patch compile fails). Best-effort; missing files OK.
      try { await dir.removeFile("patch.wasm"); } catch (_) {}
      try { await dir.removeFile("patch.json"); } catch (_) {}
      try { await dir.removeFile("patch.o"); }    catch (_) {}
      await dir.writeFile("patch.cpp", new TextEncoder().encode(msg.wrappedSrc));

      progress("compile");
      // Build clang argv. Two pieces are non-obvious for Wasmer's WASI
      // clang and worth flagging for the next time someone reads this:
      //
      //   -mexec-model=reactor:  tells WASI clang we're producing a
      //     library, not an executable. Without it, libc.a's
      //     __main_void.o is pulled in and asks for a main() that
      //     doesn't exist. -Wl,--no-entry alone isn't enough.
      //
      //   -Wl,--export-memory:   the WASM memory object needs its own
      //     dedicated export flag. Trying -Wl,--export=memory does
      //     NOT work — wasm-ld looks for a function symbol named
      //     'memory' and errors out (no such function).
      //
      // Per-function exports (preview_*, smoke) are handled by
      // __attribute__((export_name(...))) in the wrapped source, so
      // we don't need explicit -Wl,--export flags for them. malloc/
      // free are pulled from libc and exported explicitly so the
      // worklet can allocate output buffers.
      //
      // Link against the precompiled libgamma.a (v3 — built offline
      // with WASI-SDK clang at -O2, ABI-matched to Wasmer's WASI
      // clang). Per-patch compile is just patch.cpp + link, so
      // wall-clock is seconds instead of minutes. Currently includes
      // Domain, FFT_fftpack, fftpack++1/2, Timer; the rest of Gamma's
      // .cpp files (Conversion, DFT, Print, arr, scl, Scheduler) hit
      // signal.h / pthread issues building under WASI and need
      // build-time flags (TODO). Patches relying on header-only
      // template classes are unaffected.
      // Single-pass compile+link — two-pass attempt produced
      // "error: unknown integrated tool '-cc1'", meaning Wasmer's
      // clang/clang package can't spawn the cc1 subprocess inside its
      // WASIX sandbox. The package is wired only for one-shot
      // compile+link. So we're back to relying on the pool fitting
      // both phases at once.
      const args = [
        "-std=c++17",
        "-Wno-deprecated-declarations",
        "-Wno-pragma-once-outside-header",
        "-fno-exceptions",
        "-fno-rtti",
        "-fno-stack-protector",
        "-fno-unwind-tables",
        "-fno-asynchronous-unwind-tables",
        "-ftime-trace=/project/patch.json",
        "-mexec-model=reactor",
        "-I", "/project/include",
        "-Wl,--no-entry",
        "-Wl,--export-memory",
        ...(msg.smokeTest ? [] : [
          "-Wl,--export=malloc",
          "-Wl,--export=free"
        ]),
        "/project/patch.cpp",
        ...(msg.smokeTest ? [] : ["/project/lib/libgamma.a"]),
        "-o", "/project/patch.wasm"
      ];

      const instance = await clangPkg.entrypoint.run({
        args,
        mount: { "/project": dir }
      });
      const result = await Promise.race([
        instance.wait(),
        new Promise((_, reject) => setTimeout(() =>
          reject(new Error(
            "clang timed out after 30 minutes. Click ■ to cancel, then try " +
            "the smoke-test (★) to verify the toolchain works on a trivial " +
            "program."
          )), 1800000
        ))
      ]);

      let stderr = "";
      try { stderr = result.stderr || ""; } catch (_) {}
      let stdout = "";
      try { stdout = result.stdout || ""; } catch (_) {}

      // Pull the time-trace JSON if clang wrote one (it does even on
      // non-zero exit when -ftime-trace is set). Boil it down to a
      // few "biggest costs" lines so the user can see exactly which
      // template instantiations dominated the compile time.
      let traceSummary = "";
      try {
        const traceBytes = await dir.readFile("patch.json");
        const traceText = new TextDecoder().decode(traceBytes);
        const trace = JSON.parse(traceText);
        const events = (trace.traceEvents || []).filter(e => e.name && e.dur);
        const byName = new Map();
        for (const ev of events) {
          const key = ev.name + (ev.args && ev.args.detail ? " " + ev.args.detail : "");
          byName.set(key, (byName.get(key) || 0) + ev.dur);
        }
        const sorted = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
        // Plain string concat — backticks here would close the outer
        // String.raw worker template (recurring footgun, see header
        // comment near COMPILE_WORKER_SRC).
        traceSummary = "TOP COMPILE COSTS (microseconds):\n" +
          sorted.map(function(entry) {
            const ms = (entry[1] / 1000).toFixed(0);
            const padded = ms.length < 8 ? " ".repeat(8 - ms.length) + ms : ms;
            return "  " + padded + " ms  " + entry[0];
          }).join("\n");
      } catch (_) { /* trace file not present, fine */ }

      // Try to read the output even if exit != 0; some warnings still
      // produce a usable wasm.
      let wasmBytes = null;
      try {
        wasmBytes = await dir.readFile("patch.wasm");
      } catch (e) {
        throw Object.assign(
          new Error("clang produced no output. exit=" + (result.code !== undefined ? result.code : "?")),
          { stderr: stderr + (stdout ? "\n--- stdout ---\n" + stdout : "") + (traceSummary ? "\n\n" + traceSummary : "") }
        );
      }
      if (result.code !== undefined && result.code !== 0) {
        // Non-zero exit but file exists — probably warnings. Surface stderr
        // but still return the wasm.
        self.postMessage({ type: "warnings", stderr });
      }
      const stderrWithTrace = stderr + (traceSummary ? (stderr ? "\n\n" : "") + traceSummary : "");
      self.postMessage(
        { type: "compiled", wasmBytes: wasmBytes.buffer || wasmBytes, stderr: stderrWithTrace },
        [wasmBytes.buffer || wasmBytes]
      );
    } catch (e) {
      self.postMessage({
        type: "compile-error",
        error: String(e && e.message || e),
        stderr: String(e && e.stderr || "")
      });
    }
  }
};
`;

function ensureCompileWorker() {
  if (previewState.worker) return previewState.workerReady;
  const blob = new Blob([COMPILE_WORKER_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  previewState.worker = new Worker(url, { type: "module" });
  previewState.workerReady = new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      if (ev.data.type === "ready") {
        previewState.worker.removeEventListener("message", onMsg);
        resolve();
      } else if (ev.data.type === "error") {
        previewState.worker.removeEventListener("message", onMsg);
        reject(new Error(ev.data.error));
      }
    };
    previewState.worker.addEventListener("message", onMsg);
  });
  // Kick off warmup with the Wasmer SDK URL + cached archive if we have it.
  previewState.worker.postMessage({
    type: "warmup",
    sdkUrl: PREVIEW.wasmerSdkUrl,
    archive: previewState.archiveBuffer
  });
  return previewState.workerReady;
}

async function fetchGammaArchive() {
  if (previewState.archiveBuffer) return previewState.archiveBuffer;
  const res = await fetch(PREVIEW.gammaArchiveUrl);
  if (!res.ok) {
    throw new Error(
      `Gamma archive not found at ${PREVIEW.gammaArchiveUrl} (${res.status}). ` +
      `Build it locally with wasm-build/build-gamma-wasm.sh and host the ` +
      `output at this URL — see wasm-build/README.md.`
    );
  }
  previewState.archiveBuffer = await res.arrayBuffer();
  return previewState.archiveBuffer;
}

/* ------------- AudioWorklet processor ------------- */
const PREVIEW_PROCESSOR_SRC = String.raw`
class PreviewProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.instance = null;
    this.memory = null;
    this.outLPtr = 0;
    this.outRPtr = 0;
    this.tickFn = null;
    this.setFn = null;
    // Mic input plumbing — populated in loadModule if the wasm exports
    // the preview_get_mic_buf / preview_set_mic_len pair (i.e. patch
    // contains at least one MicInput node). Otherwise stays null and
    // process() skips the mic path entirely.
    this.micBufPtr = 0;
    this.micSetLen = null;
    this.micEnabled = false;
    // v0.3.19 — VideoSrc plumbing. After load, we scan wasm exports
    // for preview_get_vid_buf_N_l / _r pairs and stash the pointers;
    // process() then writes inputs[1] channels into them per quantum.
    // vidBufPtrs is an array of { l: <ptr>, r: <ptr> } indexed by
    // source N. vidSetLen mirrors the quantum length to gVidLen.
    this.vidBufPtrs = [];
    this.vidSetLen = null;
    this.vidEnabled = false;
    // Phase 6.5.1 — audio bridge. The main thread allocates a SAB
    // and posts it once; the worklet keeps the views alive and
    // writes scalar values + (future) FFT bins per quantum. Null
    // until bridge-init arrives; process() guards on it.
    this.bridgeFloats = null;
    this.bridgeInts   = null;
    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "load") this.loadModule(m.wasmBytes).catch(e => {
        this.port.postMessage({ type: "error", error: String(e && e.message || e) });
      });
      else if (m.type === "set" && this.setFn) this.setFn(m.index, m.value);
      else if (m.type === "stop") this.instance = null;
      else if (m.type === "bridge-init" && m.sab) {
        // Stash worklet-side views over the shared buffer. The same
        // bytes the main thread sees; tear-free for 32-bit reads.
        this.bridgeFloats = new Float32Array(m.sab);
        this.bridgeInts   = new Int32Array(m.sab);
      }
    };
  }
  async loadModule(bytes) {
    const wasmModule = await WebAssembly.compile(bytes);
    // Build a permissive imports object accepting any wasm output we
    // might produce: WASI / WASIX (Wasmer clang) / Emscripten. The
    // per-sample audio path shouldn't actually call any of these, so
    // they all stub to no-ops. WebAssembly.instantiate demands every
    // declared import resolve, so we use a Proxy per requested module
    // to synthesize a no-op for any requested name.
    const noop = () => 0;
    const wasmImports = WebAssembly.Module.imports(wasmModule);
    const imports = {};
    for (const im of wasmImports) {
      if (!imports[im.module]) {
        imports[im.module] = new Proxy({}, { get: () => noop });
      }
    }
    const instance = await WebAssembly.instantiate(wasmModule, imports);
    const exp = instance.exports;
    this.memory = exp.memory;
    if (exp._start) try { exp._start(); } catch(e) {}
    // Tell Gamma's master Domain about the actual sample rate BEFORE
    // constructing the patch — every gam::Sine / gam::AD / gam::Biquad
    // caches its per-sample increment from this. Without it the Domain
    // defaults to 1.0 which makes envelopes finish in one sample
    // (audibly silent) and oscillators play at the wrong pitch.
    if (exp.preview_set_sr) try { exp.preview_set_sr(sampleRate); } catch(e) {}
    if (exp.preview_init) exp.preview_init();
    this.tickFn = exp.preview_tick;
    this.setFn  = exp.preview_set;
    if (exp.malloc) {
      this.outLPtr = exp.malloc(128 * 4);
      this.outRPtr = exp.malloc(128 * 4);
    } else {
      this.outLPtr = 1024;
      this.outRPtr = 1024 + 128 * 4;
    }
    // Mic-input wiring — only present when the patch contains a
    // MicInput node (codegen conditionally emits these exports).
    if (exp.preview_get_mic_buf && exp.preview_set_mic_len) {
      this.micBufPtr = exp.preview_get_mic_buf();
      this.micSetLen = exp.preview_set_mic_len;
      this.micEnabled = true;
    } else {
      this.micEnabled = false;
    }
    // v0.3.19 — VideoSrc wiring. Enumerate exports for preview_get_vid_buf_N_l/r
    // pairs (N = 0, 1, ...) until the chain breaks. preview_set_vid_len
    // is shared across all sources. String concat (no template literals)
    // because this code lives inside a String.raw template -- backticks
    // would close the outer literal early.
    this.vidBufPtrs = [];
    let vIdx = 0;
    while (exp["preview_get_vid_buf_" + vIdx + "_l"] && exp["preview_get_vid_buf_" + vIdx + "_r"]) {
      this.vidBufPtrs.push({
        l: exp["preview_get_vid_buf_" + vIdx + "_l"](),
        r: exp["preview_get_vid_buf_" + vIdx + "_r"]()
      });
      vIdx++;
    }
    this.vidSetLen = exp.preview_set_vid_len || null;
    this.vidEnabled = this.vidBufPtrs.length > 0 && !!this.vidSetLen;
    this.instance = instance;
    this.processCount = 0;
    this.diagSent = false;
    const exportNames = Object.keys(exp);
    this.port.postMessage({ type: "loaded", exports: exportNames, micEnabled: this.micEnabled, vidEnabled: this.vidEnabled, vidCount: this.vidBufPtrs.length });
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.instance || !this.tickFn) {
      for (let ch = 0; ch < out.length; ch++) out[ch].fill(0);
      return true;
    }
    // Mic input — write inputs[0][0] into the wasm-side buffer before
    // running the tick. inputs[0] may be empty if no source is
    // connected; in that case set length to 0 so the tick skips the
    // setMicInput call entirely (outputs the patch with zero mic).
    if (this.micEnabled && this.micBufPtr) {
      const inMic = inputs[0] && inputs[0][0];
      const len = inMic ? Math.min(inMic.length, 2048) : 0;
      if (len > 0) {
        const heap = new Float32Array(this.memory.buffer);
        const off = this.micBufPtr >> 2;
        // .set is faster than a per-sample loop — single SIMD-style
        // memcpy under the hood. Both buffers are the same dtype so
        // no conversion happens.
        heap.set(inMic.subarray(0, len), off);
      }
      if (this.micSetLen) this.micSetLen(len);
    }
    // v0.3.19 — VideoSrc input. inputs[1] is the ChannelMerger output
    // from ensureVideoAudioConnected; each source occupies a stereo
    // pair (channels 2N, 2N+1). Write each pair into per-source wasm
    // buffers; the C++ tick wrapper drains them via setVidL_N / _R.
    if (this.vidEnabled) {
      const vidIn = inputs[1];
      let writeLen = 0;
      if (vidIn && vidIn.length > 0) {
        const heap = new Float32Array(this.memory.buffer);
        for (let s = 0; s < this.vidBufPtrs.length; s++) {
          const lCh = vidIn[s * 2];
          const rCh = vidIn[s * 2 + 1];
          // Empty channels (no source connected at that pair) are still
          // declared by the merger; they read as zero-filled or
          // undefined-length depending on Web Audio impl. Guard both.
          if (lCh && lCh.length > 0) {
            const len = Math.min(lCh.length, 2048);
            heap.set(lCh.subarray(0, len), this.vidBufPtrs[s].l >> 2);
            if (len > writeLen) writeLen = len;
          }
          if (rCh && rCh.length > 0) {
            const len = Math.min(rCh.length, 2048);
            heap.set(rCh.subarray(0, len), this.vidBufPtrs[s].r >> 2);
            if (len > writeLen) writeLen = len;
          }
        }
      }
      // Pass actual write length, NOT a fallback to quantum size --
      // if no source connected this quantum, we want the wasm tick
      // to skip the setVidL/setVidR calls entirely (vs reading stale
      // bytes from a previously-populated buffer, which would tick
      // a one-quantum click).
      if (this.vidSetLen) this.vidSetLen(writeLen);
    }
    this.tickFn(this.outLPtr, this.outRPtr, out[0].length);
    const heap = new Float32Array(this.memory.buffer);
    const lOff = this.outLPtr >> 2;
    const rOff = this.outRPtr >> 2;
    out[0].set(heap.subarray(lOff, lOff + out[0].length));
    if (out.length > 1) out[1].set(heap.subarray(rOff, rOff + out[1].length));
    // Phase 6.5.1 — audio bridge smoke test. While Phase 6.5.2+ ships
    // proper EnvFollow / FFT / Clock bridge nodes, this writes the
    // master-output peak (max |L|, |R| over the quantum) to scalar
    // slot 0 so the main thread can verify the SAB plumbing
    // round-trips even before any bridge node is in the patch. Cheap
    // -- one pass over 128 samples per quantum.
    if (this.bridgeFloats) {
      let peak = 0;
      const lBuf = out[0];
      const rBuf = out.length > 1 ? out[1] : null;
      for (let i = 0; i < lBuf.length; i++) {
        const a = lBuf[i] >= 0 ? lBuf[i] : -lBuf[i];
        if (a > peak) peak = a;
        if (rBuf) {
          const b = rBuf[i] >= 0 ? rBuf[i] : -rBuf[i];
          if (b > peak) peak = b;
        }
      }
      this.bridgeFloats[8] = peak;       // scalar slot 0 (AUDIO_BRIDGE_SCALAR_BASE)
      Atomics.add(this.bridgeInts, 2, 1); // bump quantum frame counter
    }
    // After ~50 process calls (~150ms @48k/128) report what the worklet
    // is actually emitting. Lets us tell apart "wasm produces zero" vs
    // "audio path is broken downstream of the worklet".
    if (!this.diagSent && ++this.processCount > 50) {
      this.diagSent = true;
      let peak = 0;
      const slice = heap.subarray(lOff, lOff + out[0].length);
      for (let i = 0; i < slice.length; i++) {
        const a = slice[i] >= 0 ? slice[i] : -slice[i];
        if (a > peak) peak = a;
      }
      this.port.postMessage({
        type: "diag",
        msg: "first-block peak=" + peak.toFixed(6) +
             " s[0..3]=" + slice[0].toFixed(4) + "," + slice[1].toFixed(4) + "," + slice[2].toFixed(4) + "," + slice[3].toFixed(4)
      });
    }
    return true;
  }
}
registerProcessor("gamma-preview-processor", PreviewProcessor);
`;

async function ensureAudioWorklet() {
  if (previewState.workletNode) return previewState.workletNode;
  if (!previewState.audioCtx) previewState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const blob = new Blob([PREVIEW_PROCESSOR_SRC], { type: "application/javascript" });
  const url  = URL.createObjectURL(blob);
  await previewState.audioCtx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(previewState.audioCtx, "gamma-preview-processor", {
    outputChannelCount: [2],
    // 1 input == mic (inputs[0]).
    // v0.3.19 — second input slot is the VideoSrc aggregate (inputs[1]).
    // A ChannelMerger combines all wire-routed VideoFile / Webcam audio
    // sources here (up to MAX_VIDEO_AUDIO_SRC stereo pairs = 8 channels);
    // see ensureVideoAudioConnected. Worklet's process() reads inputs[1]
    // every quantum and writes into per-source wasm buffers.
    numberOfInputs: 2,
    numberOfOutputs: 1
  });

  // Audio routing — worklet → splitter (for L/R metering) → destination.
  // The splitter feeds two analysers (one per channel). The worklet
  // ALSO connects directly to destination so audio reaches the speakers
  // without going through analysers (analysers don't pass audio through
  // to their own output, but they read from input). Actually: the
  // splitter IS in the audio path and downstream nodes hear nothing
  // unless we merge back. Use a separate fan-out: worklet → destination
  // (audio) AND worklet → splitter → analyserL / analyserR (taps only).
  const splitter = previewState.audioCtx.createChannelSplitter(2);
  const analyserL = previewState.audioCtx.createAnalyser();
  const analyserR = previewState.audioCtx.createAnalyser();
  // 16384-point FFT → 8192 bins, ~2.93 Hz/bin at 48 kHz. Maximum
  // useful resolution for steady tones — peaks read as needle-thin
  // single-bin spikes. Window length is 16384/sr ≈ 340 ms, so
  // transients shorter than that smear; this favours sustained
  // sounds over percussive analysis. smoothingTimeConstant left at
  // 0 — we do attack/release in the render loop.
  analyserL.fftSize = 16384; analyserL.smoothingTimeConstant = 0;
  analyserR.fftSize = 16384; analyserR.smoothingTimeConstant = 0;
  // Phase 6.5.3 — separate analyser pair for visual FFT reactivity.
  // 2048 fftSize = 1024 bins, ~23 Hz/bin at 48 kHz, ~43 ms window.
  // Snappy for transient response (kicks register on the frame they
  // hit, instead of smearing across 340 ms like the meter analyser).
  // smoothingTimeConstant = 0.4 gives some inter-frame smoothing so
  // visualizers don't flicker on every sample-level glitch.
  const fftAnalyserL = previewState.audioCtx.createAnalyser();
  const fftAnalyserR = previewState.audioCtx.createAnalyser();
  fftAnalyserL.fftSize = 2048; fftAnalyserL.smoothingTimeConstant = 0.4;
  fftAnalyserR.fftSize = 2048; fftAnalyserR.smoothingTimeConstant = 0.4;
  node.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);
  splitter.connect(fftAnalyserL, 0);
  splitter.connect(fftAnalyserR, 1);
  node.connect(previewState.audioCtx.destination);
  previewState.analyserL = analyserL;
  previewState.analyserR = analyserR;
  previewState.fftAnalyserL = fftAnalyserL;
  previewState.fftAnalyserR = fftAnalyserR;
  startMeterLoop();

  // Phase 6.5.1 — hand the shared bridge SAB to the worklet. Safe to
  // call on every worklet creation; audioBridge.init() is idempotent.
  // If SAB isn't available (no COOP/COEP), init returns false and the
  // worklet's process() guards on this.bridgeFloats being null.
  if (audioBridge.init()) {
    node.port.postMessage({ type: "bridge-init", sab: audioBridge.sab });
  }

  node.port.onmessage = (ev) => {
    if (ev.data.type === "loaded") {
      previewProgressFinish();
      setPreviewStatus("playing", "playing");
      console.log("[preview] worklet exports:", ev.data.exports || "(unknown)");
      console.log("[preview] audio context state:", previewState.audioCtx.state,
                  "sampleRate:", previewState.audioCtx.sampleRate,
                  "destination channelCount:", previewState.audioCtx.destination.channelCount);
    } else if (ev.data.type === "error") {
      previewProgressEnd(false);
      setPreviewStatus("error", "worklet: " + ev.data.error);
    } else if (ev.data.type === "diag") {
      console.log("[preview-diag]", ev.data.msg);
    }
  };
  previewState.workletNode = node;
  return node;
}

/* ------------- Output meter — multi-mode lab instrument ------------- */
/* Reads from the L/R AnalyserNode taps every animation frame and
 * renders one of three views to a single canvas:
 *
 *   vu     — peak + RMS horizontal bars with peak-hold tick, dB readout
 *   scope  — time-domain trace, ~5ms window, phosphor-green line
 *   fft    — log-frequency spectrum, 32 bands, dBFS
 *
 * All modes share the same AnalyserNode infrastructure so switching
 * is instantaneous. dB readouts under the canvas reflect peak.l /
 * peak.r regardless of mode — the canvas is what changes.
 *
 * Doubles as audio-path verification. If the canvas is flat and the
 * dB readouts show −∞ while preview is "playing", the wasm is not
 * producing samples. */
const METER = {
  rafId: null,
  mode: "vu",                  // vu | scope | fft
  peakHoldL: 0, peakHoldR: 0,
  peakDecayPerFrame: 0.985,
  fillDecayPerFrame: 0.92,
  smoothL: 0, smoothR: 0,
  // Per-bin smoothed dB values (sized to analyser.frequencyBinCount when
  // the loop starts). Initialised to FFT_DB_FLOOR so first frames don't
  // draw a misleading transient. Attack rises fast, release falls slow —
  // standard pro-analyzer ballistics.
  fftSmooth: null,
  fftCursor: null,             // { x, y, freq, db } — mouse hover, null when off
  fftLayout: null              // cached pixel→bin map; invalidated on resize
};
// FFT view configuration — pulled out so the render path isn't full of magic numbers.
const FFT_DB_FLOOR  = -90;
const FFT_DB_TOP    = 0;
const FFT_F_MIN     = 30;       // Hz — bottom of log range
const FFT_F_MAX     = 20000;    // Hz — top of log range (clamped to Nyquist)
const FFT_ATTACK    = 0.50;     // 0=instant, 1=never; smaller = snappier rise
const FFT_RELEASE   = 0.93;     // larger = slower fall
const FFT_HZ_GRID   = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FFT_DB_GRID   = [-80, -60, -40, -20, 0];
function dbFromAmp(amp) { if (amp < 1e-5) return -Infinity; return 20 * Math.log10(amp); }
function fmtDb(db) { if (!isFinite(db)) return "−∞"; return (db >= 0 ? "+" : "") + db.toFixed(1); }

function setMeterMode(mode) {
  METER.mode = mode;
  document.querySelectorAll(".monitor-mode-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
}
document.addEventListener("click", (ev) => {
  const t = ev.target.closest(".monitor-mode-tab");
  if (t && t.dataset.mode) setMeterMode(t.dataset.mode);
});

function startMeterLoop() {
  if (METER.rafId) return;
  const meterEl = document.getElementById("monitor-display");
  const canvas  = document.getElementById("meter-canvas");
  const cornerEl = document.getElementById("meter-overlay-corner");
  const dbL     = document.getElementById("meter-db-l");
  const dbR     = document.getElementById("meter-db-r");
  if (!meterEl || !canvas) return;
  meterEl.classList.add("active");
  meterEl.setAttribute("aria-hidden", "false");

  // Internal buffer is 2x the displayed width for crispness on HiDPI.
  // CSS sets the visual size via stretching to the container.
  const ctx = canvas.getContext("2d", { alpha: false });
  const W = canvas.width, H = canvas.height;
  const bufL = new Float32Array(previewState.analyserL.fftSize);
  const bufR = new Float32Array(previewState.analyserR.fftSize);
  const fftL = new Float32Array(previewState.analyserL.frequencyBinCount);

  // Canvas colors — phosphor lab instrument.
  const COL_PH  = "#c8e85a";                  // primary trace
  const COL_PHA = "rgba(200,232,90,0.55)";    // bar frame
  const COL_PHB = "rgba(200,232,90,0.18)";    // tick lines / grid
  const COL_BG  = "#050608";                  // panel bg
  const COL_TX  = "rgba(200,232,90,0.30)";    // tick labels
  const COL_HI  = "rgba(230,227,220,0.95)";   // peak-hold tick (warm white)
  const COL_AMB = "rgba(255,179,71,0.95)";    // warning band
  const COL_RED = "rgba(226,75,74,0.95)";     // clip band

  // FFT spectrum analyzer — pro-tool style.
  //
  // Rendering strategy: for each x-pixel inside the plot area, find the
  // bin range that maps to the log-frequency span [f, f_next]. Take the
  // max-magnitude bin in that range so spectral peaks survive the
  // downsampling (sum/avg would smear them). Convert to dB, smooth with
  // attack/release ballistics, plot the resulting curve.
  //
  // Layout: dB scale runs FFT_DB_FLOOR..FFT_DB_TOP top-to-bottom on the
  // right (labels inside the plot). Hz axis runs FFT_F_MIN..FFT_F_MAX
  // log-spaced left-to-right (labels at the bottom). Filled curve has a
  // vertical gradient from amber-at-top to phosphor-at-floor for
  // magnitude-at-a-glance reading; outline trace on top has subtle
  // phosphor glow for crisp peak resolution.
  const N_BINS = previewState.analyserL.frequencyBinCount;
  if (!METER.fftSmooth || METER.fftSmooth.length !== N_BINS) {
    METER.fftSmooth = new Float32Array(N_BINS).fill(FFT_DB_FLOOR);
  }

  // Cache per-pixel bin ranges + grid positions whenever the canvas
  // dimensions change. Cleared on canvas resize via stopMeterLoop.
  function ensureFftLayout() {
    if (METER.fftLayout && METER.fftLayout.W === W && METER.fftLayout.H === H) return METER.fftLayout;
    const sr = previewState.audioCtx ? previewState.audioCtx.sampleRate : 48000;
    const fmin = FFT_F_MIN;
    const fmax = Math.min(FFT_F_MAX, sr / 2);
    const ML = 0, MR = 38, MT = 6, MB = 18;
    const plotX = ML, plotY = MT;
    const plotW = W - ML - MR, plotH = H - MT - MB;
    const logFmin = Math.log(fmin), logFspan = Math.log(fmax) - logFmin;
    // Pixel → bin range (inclusive) + fractional bin position at the
    // pixel's CENTER. The integer range drives max-search when a pixel
    // spans multiple bins; the fractional position drives linear
    // interpolation when a pixel falls inside a single bin (the
    // common case at low frequencies on a log axis, where adjacent
    // pixels often map to fractional offsets within the same bin).
    const binLo = new Int32Array(plotW + 1);
    const binHi = new Int32Array(plotW + 1);
    const binF  = new Float32Array(plotW + 1);
    for (let px = 0; px <= plotW; px++) {
      const f0 = Math.exp(logFmin + (px       / plotW) * logFspan);
      const f1 = Math.exp(logFmin + ((px + 1) / plotW) * logFspan);
      const fc = Math.exp(logFmin + ((px + 0.5) / plotW) * logFspan);
      let lo = Math.floor(f0 * 2 * N_BINS / sr);
      let hi = Math.ceil (f1 * 2 * N_BINS / sr);
      if (lo < 0) lo = 0; if (hi >= N_BINS) hi = N_BINS - 1;
      if (hi < lo) hi = lo;
      binLo[px] = lo; binHi[px] = hi;
      binF [px] = fc * 2 * N_BINS / sr;
    }
    METER.fftLayout = {
      W, H, fmin, fmax, ML, MR, MT, MB, plotX, plotY, plotW, plotH,
      logFmin, logFspan, binLo, binHi, binF
    };
    return METER.fftLayout;
  }
  // Mouse readout — when the cursor hovers the plot, store {x, y, freq, db}
  // for the renderer to draw a crosshair + tooltip.
  function fftHandlePointer(ev) {
    const r = canvas.getBoundingClientRect();
    const cx = (ev.clientX - r.left) * (W / r.width);
    const cy = (ev.clientY - r.top)  * (H / r.height);
    const lo = METER.fftLayout;
    if (!lo || cx < lo.plotX || cx > lo.plotX + lo.plotW || cy < lo.plotY || cy > lo.plotY + lo.plotH) {
      METER.fftCursor = null;
      return;
    }
    const tF = (cx - lo.plotX) / lo.plotW;
    const freq = Math.exp(lo.logFmin + tF * lo.logFspan);
    const tD = (cy - lo.plotY) / lo.plotH;
    const db  = FFT_DB_TOP - tD * (FFT_DB_TOP - FFT_DB_FLOOR);
    METER.fftCursor = { x: cx, y: cy, freq, db };
  }
  if (!canvas.dataset.fftWired) {
    canvas.dataset.fftWired = "1";
    // Pointer events instead of mouse events so the FFT cursor readout
    // works on iPad / phone too. mouseleave maps to pointerleave.
    canvas.addEventListener("pointermove",  fftHandlePointer);
    canvas.addEventListener("pointerleave", () => { METER.fftCursor = null; });
  }

  function drawVU(pL, pR) {
    // Two horizontal bars stacked, with peak-hold tick + ladder ticks
    // at -60, -40, -20, -10, -6, -3, 0 dB.
    ctx.fillStyle = COL_BG; ctx.fillRect(0, 0, W, H);
    const ticks = [-60, -40, -20, -10, -6, -3, 0];
    const dbToX = db => {
      const pct = (db + 60) / 60;
      return Math.max(0, Math.min(1, pct)) * (W - 6) + 3;
    };
    ctx.strokeStyle = COL_PHB; ctx.lineWidth = 1; ctx.beginPath();
    ticks.forEach(d => {
      const x = dbToX(d);
      ctx.moveTo(x + 0.5, 8); ctx.lineTo(x + 0.5, H - 8);
    });
    ctx.stroke();
    // Tick labels — small, dim, Fragment Mono for instrument feel.
    ctx.fillStyle = COL_TX;
    ctx.font = "9px 'Fragment Mono', 'JetBrains Mono', monospace";
    ctx.textBaseline = "bottom"; ctx.textAlign = "center";
    ticks.forEach(d => {
      ctx.fillText((d === 0 ? "0" : d.toString()), dbToX(d), H - 1);
    });
    // Bar geometry.
    const barH = 22;
    const barY1 = 14, barY2 = barY1 + barH + 6;
    function drawBar(y, val, hold) {
      const dbV = dbFromAmp(val);
      const x   = dbToX(dbV);
      const x0  = dbToX(-60);
      // Frame
      ctx.strokeStyle = COL_PHA; ctx.strokeRect(x0 - 0.5, y - 0.5, (W - 6) - (x0 - 3) + 0.5, barH + 1);
      // Filled section. Gradient stays phosphor across most of the
      // range, warms to amber past -6 dB, red past -1 dB.
      const grad = ctx.createLinearGradient(x0, 0, W - 3, 0);
      grad.addColorStop(0, "rgba(200,232,90,0.85)");
      grad.addColorStop(0.85, "rgba(200,232,90,0.95)");
      grad.addColorStop(0.93, COL_AMB);
      grad.addColorStop(1.0,  COL_RED);
      ctx.fillStyle = grad;
      ctx.fillRect(x0, y, x - x0, barH);
      // Peak-hold tick — warm-white so it pops over both phosphor + amber.
      const xH = dbToX(dbFromAmp(hold));
      ctx.strokeStyle = COL_HI;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xH + 0.5, y - 1);
      ctx.lineTo(xH + 0.5, y + barH + 1);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    drawBar(barY1, METER.smoothL, METER.peakHoldL);
    drawBar(barY2, METER.smoothR, METER.peakHoldR);
    // L/R glyphs — Major Mono Display, lowercase, phosphor.
    ctx.fillStyle = COL_PH;
    ctx.font = "11px 'Major Mono Display', 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText("l", 7, barY1 + barH / 2);
    ctx.fillText("r", 7, barY2 + barH / 2);
  }

  function drawScope(buf) {
    ctx.fillStyle = COL_BG; ctx.fillRect(0, 0, W, H);
    // Center reference line + thirds.
    ctx.strokeStyle = COL_PHB; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2 + 0.5); ctx.lineTo(W, H / 2 + 0.5);
    ctx.moveTo(0, H / 4 + 0.5); ctx.lineTo(W, H / 4 + 0.5);
    ctx.moveTo(0, 3 * H / 4 + 0.5); ctx.lineTo(W, 3 * H / 4 + 0.5);
    ctx.stroke();
    // Trace.
    ctx.strokeStyle = COL_PH;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = COL_PH;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    const N = buf.length;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * W;
      const y = H / 2 - buf[i] * (H / 2 - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawFFT() {
    previewState.analyserL.getFloatFrequencyData(fftL);
    const lo = ensureFftLayout();
    const sm = METER.fftSmooth;
    // Per-bin attack/release smoothing. fftL[i] is in dB (-Infinity..0).
    // Floor the input to FFT_DB_FLOOR so the smoother is well-defined.
    for (let i = 0; i < N_BINS; i++) {
      let v = fftL[i];
      if (!isFinite(v) || v < FFT_DB_FLOOR) v = FFT_DB_FLOOR;
      const prev = sm[i];
      const k = (v > prev) ? FFT_ATTACK : FFT_RELEASE;
      sm[i] = prev * k + v * (1 - k);
    }

    // Background.
    ctx.fillStyle = COL_BG; ctx.fillRect(0, 0, W, H);

    // dB ↔ y, helper closures (cheap; called O(grid) times not O(W)).
    const dbSpan = FFT_DB_TOP - FFT_DB_FLOOR;
    const dbToY = db => lo.plotY + (1 - (db - FFT_DB_FLOOR) / dbSpan) * lo.plotH;
    const fToX  = f  => lo.plotX + (Math.log(f) - lo.logFmin) / lo.logFspan * lo.plotW;

    // dB grid (horizontal). Slightly brighter at 0 dB to anchor the eye.
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(200,232,90,0.10)";
    ctx.beginPath();
    FFT_DB_GRID.forEach(db => {
      const y = Math.round(dbToY(db)) + 0.5;
      ctx.moveTo(lo.plotX, y); ctx.lineTo(lo.plotX + lo.plotW, y);
    });
    ctx.stroke();
    // 0 dB highlight line.
    ctx.strokeStyle = "rgba(255,179,71,0.30)";
    ctx.beginPath();
    const y0 = Math.round(dbToY(0)) + 0.5;
    ctx.moveTo(lo.plotX, y0); ctx.lineTo(lo.plotX + lo.plotW, y0);
    ctx.stroke();

    // Hz grid (vertical) — only label the decades + 1/2/5 to avoid clutter.
    ctx.strokeStyle = "rgba(200,232,90,0.10)";
    ctx.beginPath();
    FFT_HZ_GRID.forEach(f => {
      if (f > lo.fmax) return;
      const x = Math.round(fToX(f)) + 0.5;
      ctx.moveTo(x, lo.plotY); ctx.lineTo(x, lo.plotY + lo.plotH);
    });
    ctx.stroke();

    // Compute spectrum y-values for each pixel column ONCE; reuse for
    // both the filled curve and the outline trace.
    //
    // Two strategies:
    //   - Pixel spans MULTIPLE bins (high frequencies, where the log
    //     axis compresses): take max so peaks survive.
    //   - Pixel falls INSIDE a single bin (low frequencies, where log
    //     stretches one bin across many pixels): linear-interpolate
    //     between this bin and the next using the pixel's fractional
    //     bin position. Removes the staircase look at low freqs and
    //     makes a clean sine read as a single sharp spike.
    const ys = new Float32Array(lo.plotW + 1);
    const lastBin = N_BINS - 1;
    for (let px = 0; px <= lo.plotW; px++) {
      const a = lo.binLo[px], b = lo.binHi[px];
      let v;
      if (b > a) {
        v = sm[a];
        for (let i = a + 1; i <= b; i++) if (sm[i] > v) v = sm[i];
      } else {
        const f = lo.binF[px];
        const i0 = Math.floor(f);
        const i1 = i0 < lastBin ? i0 + 1 : i0;
        const t = f - i0;
        v = sm[i0] * (1 - t) + sm[i1] * t;
      }
      ys[px] = dbToY(v);
    }

    // Filled curve — vertical gradient (warmer near 0 dB, dim near floor).
    ctx.beginPath();
    ctx.moveTo(lo.plotX, lo.plotY + lo.plotH);
    for (let px = 0; px <= lo.plotW; px++) {
      ctx.lineTo(lo.plotX + px, ys[px]);
    }
    ctx.lineTo(lo.plotX + lo.plotW, lo.plotY + lo.plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, lo.plotY, 0, lo.plotY + lo.plotH);
    grad.addColorStop(0,    "rgba(255,179,71,0.45)");      // amber at 0 dB
    grad.addColorStop(0.20, "rgba(200,232,90,0.42)");
    grad.addColorStop(0.55, "rgba(200,232,90,0.20)");
    grad.addColorStop(1,    "rgba(200,232,90,0.04)");
    ctx.fillStyle = grad;
    ctx.fill();

    // Outline trace — phosphor with subtle glow.
    ctx.beginPath();
    ctx.moveTo(lo.plotX, ys[0]);
    for (let px = 1; px <= lo.plotW; px++) ctx.lineTo(lo.plotX + px, ys[px]);
    ctx.strokeStyle = COL_PH;
    ctx.lineWidth = 1.25;
    ctx.shadowColor = COL_PH;
    ctx.shadowBlur = 3;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Axis labels — dB on the right inside the plot, Hz on the bottom.
    ctx.fillStyle = COL_TX;
    ctx.font = "9px 'Fragment Mono', 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    FFT_DB_GRID.forEach(db => {
      const y = dbToY(db);
      const label = db === 0 ? "0 dB" : (db + "");
      ctx.fillText(label, lo.plotX + lo.plotW + 4, y);
    });
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    FFT_HZ_GRID.forEach(f => {
      if (f > lo.fmax) return;
      const x = fToX(f);
      const label = f >= 1000 ? (f / 1000) + "k" : (f + "");
      ctx.fillText(label, x, lo.plotY + lo.plotH + 4);
    });

    // Mouse-hover crosshair + readout. Only drawn when fftCursor is set.
    if (METER.fftCursor) {
      const cur = METER.fftCursor;
      // Snap y to the actual spectrum height at the hovered pixel so the
      // tooltip dB matches what the user "sees" (peak at that x).
      const px = Math.max(0, Math.min(lo.plotW, Math.round(cur.x - lo.plotX)));
      const ySpec = ys[px];
      // Convert ySpec back to dB for the tooltip.
      const dbAt = FFT_DB_TOP - (ySpec - lo.plotY) / lo.plotH * dbSpan;
      ctx.strokeStyle = "rgba(230,227,220,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cur.x + 0.5, lo.plotY); ctx.lineTo(cur.x + 0.5, lo.plotY + lo.plotH);
      ctx.moveTo(lo.plotX, ySpec + 0.5); ctx.lineTo(lo.plotX + lo.plotW, ySpec + 0.5);
      ctx.stroke();
      // Marker dot at the spectrum peak under the cursor.
      ctx.fillStyle = COL_HI;
      ctx.beginPath(); ctx.arc(cur.x, ySpec, 2.5, 0, Math.PI * 2); ctx.fill();
      // Tooltip — freq + dB at cursor's spectrum point.
      const fLabel = cur.freq >= 1000 ? (cur.freq / 1000).toFixed(2) + "k Hz" : cur.freq.toFixed(0) + " Hz";
      const dLabel = (dbAt >= 0 ? "+" : "") + dbAt.toFixed(1) + " dB";
      const tip = fLabel + "  " + dLabel;
      ctx.font = "10px 'Fragment Mono', 'JetBrains Mono', monospace";
      const tw = ctx.measureText(tip).width;
      const tx = Math.min(lo.plotX + lo.plotW - tw - 6, cur.x + 8);
      const ty = Math.max(lo.plotY + 4, ySpec - 18);
      ctx.fillStyle = "rgba(5,6,8,0.85)";
      ctx.fillRect(tx - 4, ty - 2, tw + 8, 14);
      ctx.strokeStyle = "rgba(200,232,90,0.30)";
      ctx.strokeRect(tx - 4 + 0.5, ty - 2 + 0.5, tw + 8, 14);
      ctx.fillStyle = COL_PH;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(tip, tx, ty);
    }
  }

  let frame = 0;
  function tick() {
    if (!previewState.analyserL || !previewState.analyserR) {
      METER.rafId = null;
      meterEl.classList.remove("active");
      return;
    }
    previewState.analyserL.getFloatTimeDomainData(bufL);
    previewState.analyserR.getFloatTimeDomainData(bufR);
    let pL = 0, pR = 0;
    for (let i = 0; i < bufL.length; i++) {
      const aL = bufL[i] >= 0 ? bufL[i] : -bufL[i]; if (aL > pL) pL = aL;
      const aR = bufR[i] >= 0 ? bufR[i] : -bufR[i]; if (aR > pR) pR = aR;
    }
    METER.smoothL   = Math.max(pL, METER.smoothL  * METER.fillDecayPerFrame);
    METER.smoothR   = Math.max(pR, METER.smoothR  * METER.fillDecayPerFrame);
    METER.peakHoldL = Math.max(pL, METER.peakHoldL * METER.peakDecayPerFrame);
    METER.peakHoldR = Math.max(pR, METER.peakHoldR * METER.peakDecayPerFrame);
    const dbValL = dbFromAmp(METER.smoothL);
    const dbValR = dbFromAmp(METER.smoothR);
    dbL.textContent = fmtDb(dbValL);
    dbR.textContent = fmtDb(dbValR);

    if (METER.mode === "vu")    drawVU(pL, pR);
    else if (METER.mode === "scope") drawScope(bufL);
    else if (METER.mode === "fft")   drawFFT();

    // Corner readout shows the most-relevant number for the current mode.
    if (cornerEl) {
      if (METER.mode === "vu")    cornerEl.textContent = "max " + fmtDb(Math.max(dbValL, dbValR));
      else if (METER.mode === "scope") cornerEl.textContent = "± " + (Math.max(pL, pR)).toFixed(3);
      else if (METER.mode === "fft")   cornerEl.textContent = "fft 16384 · log hz";
    }

    if (METER.smoothL < 1e-4 && METER.smoothR < 1e-4) meterEl.classList.add("silent");
    else meterEl.classList.remove("silent");

    if ((++frame % 120) === 0) {
      console.log("[meter] L=" + fmtDb(dbValL) + " R=" + fmtDb(dbValR) +
                  " ctx=" + (previewState.audioCtx && previewState.audioCtx.state) +
                  " mode=" + METER.mode);
    }
    METER.rafId = requestAnimationFrame(tick);
  }
  METER.rafId = requestAnimationFrame(tick);
}
function stopMeterLoop() {
  if (METER.rafId) cancelAnimationFrame(METER.rafId);
  METER.rafId = null;
  const meterEl = document.getElementById("monitor-display");
  if (meterEl) {
    meterEl.classList.remove("active");
    meterEl.classList.add("silent");
    meterEl.setAttribute("aria-hidden", "true");
  }
  ["meter-db-l","meter-db-r"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = "−∞";
  });
  // Clear the canvas to a flat phosphor-trace baseline.
  const c = document.getElementById("meter-canvas");
  if (c) {
    const cx = c.getContext("2d");
    cx.fillStyle = "#050608"; cx.fillRect(0, 0, c.width, c.height);
    cx.strokeStyle = "rgba(200,232,90,0.18)";
    cx.beginPath(); cx.moveTo(0, c.height / 2); cx.lineTo(c.width, c.height / 2); cx.stroke();
  }
  // Drop FFT state — analyser is being recreated next time, bin count
  // and smoothed values would be stale.
  METER.fftSmooth = null;
  METER.fftLayout = null;
  METER.fftCursor = null;
  // Reset piano too.
  resetPiano();
}

/* ------------- Local compile-server detection ------------- */
/* Probe localhost:8765/health on first Play click. If the daemon is
 * up, all compile requests route there (full Emscripten, ~5–15 s).
 * If not, fall back to the in-browser Wasmer path (~OOM-prone).
 *
 * If the user has set aiSettings.compileServerUrl (e.g. for a LAN
 * daemon they're hitting from an iPad), that URL is the SOLE candidate
 * — we don't also probe localhost, since on a remote device localhost
 * just refers to the device itself and would dilute the timeout budget.
 * The probe timeout is also bumped (3 s) since LAN round-trips can be
 * slightly slower than the loopback adapter. */
let localServerStatus = null;       // null = unprobed, true = available, false = not running
let localServerEndpoint = null;     // base URL of whichever candidate responded
async function probeLocalServer() {
  if (localServerStatus !== null) return localServerStatus;
  const customUrl = (aiSettings && aiSettings.compileServerUrl || "").trim().replace(/\/+$/, "");
  // Custom URL wins; otherwise try BOTH 127.0.0.1 and localhost in
  // parallel — on some Windows setups `localhost` resolves to IPv6 ::1
  // first, which adds a slow fallback to IPv4 and trips our short
  // timeout. 127.0.0.1 is direct.
  const candidates = customUrl
    ? [customUrl]
    : ["http://127.0.0.1:8765", "http://localhost:8765"];
  const timeoutMs = customUrl
    ? Math.max(3000, PREVIEW.localServerProbeTimeoutMs)
    : Math.max(1500, PREVIEW.localServerProbeTimeoutMs);
  const results = await Promise.allSettled(candidates.map(async base => {
    const res = await fetch(base + "/health", {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (!j || j.service !== "gamma-compile-server") throw new Error("not gamma-compile-server");
    return base;
  }));
  const ok = results.find(r => r.status === "fulfilled");
  if (ok) {
    localServerEndpoint = ok.value;
    localServerStatus = true;
    console.log("[preview] local compile-server: detected at " + localServerEndpoint);
  } else {
    localServerStatus = false;
    // Log every candidate's failure reason so we can see WHY.
    const reasons = results.map((r, i) =>
      "  " + candidates[i] + " — " +
      (r.status === "rejected"
        ? (r.reason && (r.reason.name + ": " + r.reason.message) || String(r.reason))
        : "ok-but-bad-payload")
    );
    console.log("[preview] local compile-server: not detected\n" + reasons.join("\n"));
  }
  return localServerStatus;
}

async function compileViaLocalServer(wrapped, smokeTest) {
  const base = localServerEndpoint || PREVIEW.localServerUrl;
  const res = await fetch(base + "/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wrappedSrc: wrapped, optLevel: smokeTest ? "O0" : "O1" })
  });
  if (res.status === 200) {
    const stderr = decodeURIComponent(res.headers.get("X-Compile-Stderr") || "");
    const elapsed = res.headers.get("X-Compile-Elapsed-Ms") || "?";
    const wasmBytes = await res.arrayBuffer();
    return { wasmBytes, stderr: stderr + (stderr ? "\n\n" : "") + "[local-cli compile in " + elapsed + " ms]" };
  }
  // Error path: server returns JSON with { error, stderr }.
  const body = await res.json().catch(() => ({}));
  throw Object.assign(new Error(body.error || ("local-cli HTTP " + res.status)), { stderr: body.stderr || "" });
}

/* v0.2.25 — compile-only path for export.
 *
 * The standalone-viewer export needs the patch's compiled wasm but
 * shouldn't have a side effect of starting playback. previewCompileAndPlay()
 * does both; this entry point runs just the compile half and returns
 * the wasm ArrayBuffer. Uses the same local-server-first / Wasmer-SDK-
 * fallback pipeline. Throws on codegen errors (cycle without Delay1)
 * or compile failures (clang stderr surfaced through the error message).
 *
 * progressFn optional: (msg, kind) => void for status updates so the
 * Export modal can show "compiling via local-cli…" / "compiling via
 * Wasmer…" etc. without cross-wiring into the toolbar pill. */
async function compilePatchForExport(progressFn) {
  const note = (msg) => { if (typeof progressFn === "function") try { progressFn(msg); } catch (_) {} };
  note("Codegen…");
  let patchCpp;
  try {
    patchCpp = generateCode();
  } catch (e) {
    throw new Error("Codegen failed: " + e.message);
  }
  if (patchCpp.startsWith("// ❌")) {
    throw new Error("Patch has a cycle without Delay1 — fix the canvas warning before exporting");
  }
  const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
  const wrapped = wrapForPreview(patchCpp, className);
  previewState.lastWrapped = wrapped;

  // 1. Try the local compile-server first (fast, full-fidelity).
  const useLocal = await probeLocalServer();
  if (useLocal) {
    note("Compiling via local-cli…");
    const { wasmBytes } = await compileViaLocalServer(wrapped, false);
    return wasmBytes;
  }

  // 2. Fall back to the Wasmer SDK worker. Slower; may OOM on large
  //    patches per the README. Worker lives on previewState.worker.
  note("Initializing Wasmer compile worker…");
  try {
    await ensureCompileWorker();
  } catch (e) {
    throw new Error("Compile worker init failed: " + e.message + ". Start the gamma-compile-server daemon or check internet for the Wasmer SDK CDN.");
  }
  note("Compiling via Wasmer (browser)…");
  return new Promise((resolve, reject) => {
    const onReply = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === "progress" && m.stage) {
        note("Compiling… " + m.stage);
      } else if (m.type === "compiled") {
        previewState.worker.removeEventListener("message", onReply);
        const bytes = m.wasmBytes instanceof ArrayBuffer ? m.wasmBytes : m.wasmBytes.buffer;
        resolve(bytes);
      } else if (m.type === "compile-error") {
        previewState.worker.removeEventListener("message", onReply);
        reject(Object.assign(new Error(m.error || "compile failed"),
                             { stderr: m.stderr || "" }));
      }
    };
    previewState.worker.addEventListener("message", onReply);
    previewState.worker.postMessage({
      type: "compile",
      wrappedSrc: wrapped,
      archiveUrl: new URL(PREVIEW.gammaArchiveUrl, location.href).toString(),
      sdkUrl: PREVIEW.wasmerSdkUrl
    });
  });
}

/* ------------- Compile + load + play orchestration ------------- */
async function previewCompileAndPlay() {
  setPreviewStatus("compiling", "compiling…");
  previewProgressStart();
  previewProgressStage("prepare");

  let patchCpp;
  try {
    patchCpp = generateCode();
  } catch (e) {
    previewProgressEnd(false);
    setPreviewStatus("error", "codegen: " + e.message);
    return;
  }
  if (patchCpp.startsWith("// ❌")) {
    previewProgressEnd(false);
    setPreviewStatus("error", "patch has cycle without Delay1 — see canvas");
    return;
  }
  const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
  const wrapped = wrapForPreview(patchCpp, className);
  previewState.lastWrapped = wrapped;
  // Diagnostic — print the full wrapped C++ to the console so the user
  // can paste it back when debugging silent / broken patches.
  console.log("[preview] wrapped C++ (" + wrapped.length + " chars) ↓\n" + wrapped);

  // Try the local compile-server FIRST. Fast, full-fidelity, no OOM.
  // Falls through to the in-browser Wasmer path if the daemon isn't
  // running.
  const useLocal = await probeLocalServer();
  if (useLocal) {
    setPreviewStatus("compiling", "compiling via local-cli…");
    previewProgressStage("compile");
    let wasmBytes, stderr;
    try {
      ({ wasmBytes, stderr } = await compileViaLocalServer(wrapped, false));
    } catch (e) {
      previewProgressEnd(false);
      setPreviewStatus("error", "local-cli: " + e.message);
      showCompileStderr(e.stderr || "", e.message);
      return;
    }
    showCompileStderr(stderr || "", null);
    try {
      previewProgressStage("load-wasm");
      const node = await ensureAudioWorklet();
      if (previewState.audioCtx.state === "suspended") await previewState.audioCtx.resume();
      // v0.2.21 — retain a clone for offline audio render before
      // transferring the original to the worklet (postMessage with a
      // transfer list detaches the source buffer on the main thread).
      try { previewState.lastWasm = wasmBytes.slice(0); } catch (_) { previewState.lastWasm = null; }
      node.port.postMessage({ type: "load", wasmBytes }, [wasmBytes]);
    } catch (e) {
      previewProgressEnd(false);
      setPreviewStatus("error", "audio: " + e.message);
    }
    return;
  }

  try {
    await ensureCompileWorker();
  } catch (e) {
    previewProgressEnd(false);
    setPreviewStatus("error", "worker init: " + e.message);
    return;
  }

  // Send compile request. Worker streams `progress` updates with
  // stage IDs (and optional subProgress for byte-level fetch tracking)
  // while it works, then sends `compiled` or `compile-error` as the
  // terminal message.
  const wasmBytes = await new Promise((resolve, reject) => {
    const onReply = (ev) => {
      const m = ev.data;
      if (m.type === "progress") {
        if (m.stage) {
          if (typeof m.subProgress === "number" && m.subProgress > 0) {
            // Same stage as before but with an updated sub-progress.
            const stageIdx = PREVIEW_STAGES.findIndex(s => s.id === m.stage);
            if (stageIdx === previewProgress.stageIdx) {
              previewProgressSub(m.subProgress);
            } else {
              previewProgressStage(m.stage, m.subProgress);
            }
          } else {
            previewProgressStage(m.stage);
          }
          // Keep the pill text aligned for the copyable "current state".
          const stage = PREVIEW_STAGES.find(s => s.id === m.stage);
          if (stage) setPreviewStatus("compiling", "compiling… " + stage.label);
        } else if (m.step) {
          // Backwards-compat with old freeform step messages.
          setPreviewStatus("compiling", "compiling… " + m.step);
        }
      } else if (m.type === "warnings") {
        showCompileStderr(m.stderr || "", null);
      } else if (m.type === "compiled") {
        previewState.worker.removeEventListener("message", onReply);
        if (m.stderr) showCompileStderr(m.stderr, null);
        else showCompileStderr("", null);
        const bytes = m.wasmBytes instanceof ArrayBuffer ? m.wasmBytes : m.wasmBytes.buffer;
        resolve(bytes);
      } else if (m.type === "compile-error") {
        previewState.worker.removeEventListener("message", onReply);
        reject(Object.assign(new Error(m.error), { stderr: m.stderr || "" }));
      }
    };
    previewState.worker.addEventListener("message", onReply);
    previewState.worker.postMessage({
      type: "compile",
      wrappedSrc: wrapped,
      archiveUrl: new URL(PREVIEW.gammaArchiveUrl, location.href).toString(),
      sdkUrl: PREVIEW.wasmerSdkUrl
    });
  }).catch(e => {
    previewProgressEnd(false);
    setPreviewStatus("error", "compile: " + e.message);
    showCompileStderr(e.stderr || "", e.message);
    return null;
  });

  if (!wasmBytes) return;

  try {
    previewProgressStage("load-wasm");
    const node = await ensureAudioWorklet();
    if (previewState.audioCtx.state === "suspended") await previewState.audioCtx.resume();
    // Mic auto-connect — if the patch contains a MicInput node OR
    // a KeywordSpotter (which taps the mic for live detection), get
    // the stream up. Permission is requested asynchronously; if not
    // yet granted we proceed and the worklet ticks with zero mic
    // input until the user grants.
    const wantsMic = state.nodes.some(n =>
      n.type === "MicInput" || n.type === "KeywordSpotter");
    if (wantsMic) {
      try { await ensureMicConnected(); }
      catch (e) { console.warn("[preview] mic auto-connect failed:", e); }
      // Stand up the keyword-detection pipeline after the mic is
      // connected. setupAllKeywordSpotters is a no-op if the
      // patch has no KeywordSpotter nodes or none have recordings.
      setupAllKeywordSpotters();
    } else {
      // No MicInput / KeywordSpotter — make sure any prior session's
      // mic source is disconnected so we don't leak the stream or
      // feed it into a patch that doesn't want it.
      disconnectMic();
    }
    // v0.3.19 — Web Audio routing for VideoFile / Webcam audio outlets.
    // The codegen produced setVidL_N / setVidR_N setters in the wasm
    // for each audio-wired source; here we connect the matching
    // MediaElementSource / MediaStreamSource through a ChannelMerger
    // into the worklet's input 1. The worklet's load handler scans
    // the wasm for preview_get_vid_buf_N_l/_r exports and starts
    // writing inputs[1] into them per quantum.
    try { await ensureVideoAudioConnected(); }
    catch (e) { console.warn("[preview] videosrc routing failed:", e); }
    // v0.2.21 — clone for offline audio render before transfer.
    try { previewState.lastWasm = wasmBytes.slice(0); } catch (_) { previewState.lastWasm = null; }
    node.port.postMessage({ type: "load", wasmBytes }, [wasmBytes]);
    // setPreviewStatus("playing") fires when worklet posts back "loaded";
    // we finish the progress bar there too via the existing handler.
  } catch (e) {
    previewProgressEnd(false);
    setPreviewStatus("error", "audio: " + e.message);
  }
}

/* Mic stream → worklet wiring. Called from the play flow when the
 * patch has at least one MicInput node. Idempotent — multiple
 * MicInput nodes share one MediaStreamSource. If the user hasn't
 * granted mic permission yet, this prompts via getUserMedia and
 * caches the stream globally (_micStream); the props pane's
 * "Enable microphone" button uses the same path.
 *
 * Disconnect happens on previewStop() and whenever a patch without
 * MicInput plays — we don't want to leak the mic into a synth patch
 * that just happens to follow a mic patch in the editing session. */
async function ensureMicConnected() {
  if (!previewState.workletNode || !previewState.audioCtx) return;
  if (previewState.micConnected) return;
  // Pick a deviceId from the FIRST MicInput node that has one set.
  // (If multiple nodes specify different devices, only the first
  // wins for the shared stream — multi-stream support would need
  // a per-node MediaStreamSource, kept off scope for now.)
  let deviceId = "";
  state.nodes.forEach(n => {
    if (deviceId) return;
    if (n.type !== "MicInput") return;
    const id = n.params && n.params.inputSourceId;
    if (id) deviceId = id;
  });
  if (!_micStream || (deviceId && _micStream._gammaDeviceId !== deviceId)) {
    // Stop previous stream if device changed (otherwise the OS
    // mic indicator stays on for the wrong device).
    if (_micStream) {
      try { _micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      _micStream = null;
    }
    try {
      const constraints = deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream._gammaDeviceId = deviceId;
      _micStream = stream;
      const tracks = stream.getAudioTracks();
      _micDeviceLabel = tracks.length ? tracks[0].label : "default";
      await refreshMicDeviceList();
      if (typeof renderProps === "function") renderProps();
    } catch (err) {
      throw new Error("mic permission denied: " + (err && err.message || err));
    }
  }
  const src = previewState.audioCtx.createMediaStreamSource(_micStream);
  src.connect(previewState.workletNode);
  previewState.micSource = src;
  previewState.micConnected = true;
  console.log("[preview] mic connected to worklet · device:", _micDeviceLabel);
}

/* v0.3.19 — VideoSrc routing. Wires each audio-wired VideoFile / Webcam
 * node's MediaElementSource / MediaStreamSource through a ChannelMerger
 * into the worklet's input 1. Each source occupies a stereo channel
 * pair; channel index N matches the codegen setVidL_N / setVidR_N
 * dispatch.
 *
 * Direct-playback path is also wired for VideoFile (MES → GainNode →
 * ctx.destination) so the user can hear unprocessed audio when there
 * are no audio wires. When wires exist, the GainNode is muted -- the
 * patch is the audio path. Webcam skips direct playback entirely
 * (would create echo with the user's own mic).
 *
 * Called from previewPlay after the worklet is ready, and whenever
 * the patch shape changes (wire add/remove, fileUrl change). The
 * function is idempotent + handles reroute / disconnect cases. */
async function ensureVideoAudioConnected() {
  if (!previewState || !previewState.workletNode || !previewState.audioCtx) return;
  const vidNodes = (typeof _videoAudioSrcNodes === "function") ? _videoAudioSrcNodes() : [];

  // No audio-wired video sources: tear down any prior merger so the
  // worklet's input 1 stays silent.
  if (vidNodes.length === 0) {
    if (previewState.videoMerger) {
      try { previewState.videoMerger.disconnect(); } catch (_) {}
      previewState.videoMerger = null;
    }
    if (previewState.videoRoutings) {
      previewState.videoRoutings.forEach(r => {
        try { r.splitter.disconnect(); } catch (_) {}
      });
      previewState.videoRoutings.clear();
    }
    _updateVideoAudioGains();
    return;
  }

  // Allocate or reuse the global merger feeding worklet input 1.
  const numCh = MAX_VIDEO_AUDIO_SRC * 2;
  if (!previewState.videoMerger) {
    const merger = previewState.audioCtx.createChannelMerger(numCh);
    merger.connect(previewState.workletNode, 0, 1);
    previewState.videoMerger = merger;
  }
  if (!previewState.videoRoutings) previewState.videoRoutings = new Map();
  if (!previewState.videoElSources) previewState.videoElSources = new Map();

  // For each source, ensure routing at the correct channel pair.
  for (let idx = 0; idx < vidNodes.length; idx++) {
    const node = vidNodes[idx];
    const existing = previewState.videoRoutings.get(node.id);
    if (existing && existing.channelIdx === idx) continue;
    if (existing) {
      try { existing.splitter.disconnect(); } catch (_) {}
      previewState.videoRoutings.delete(node.id);
    }
    // Get / lazy-init the MediaElementSource (VideoFile) or
    // MediaStreamSource (Webcam). MES is one-shot per element so we
    // cache it on _videoSources entry.
    const srcEntry = _videoSources.get(node.id);
    if (!srcEntry) continue;
    let mes = srcEntry._mediaSource;
    if (!mes) {
      try {
        if (node.type === "VideoFile") {
          if (!srcEntry.videoEl) continue;
          mes = previewState.audioCtx.createMediaElementSource(srcEntry.videoEl);
          // Direct-playback path. GainNode value managed by
          // _updateVideoAudioGains based on audioEnabled / volume /
          // hasWire.
          const gain = previewState.audioCtx.createGain();
          gain.gain.value = 0;
          mes.connect(gain);
          gain.connect(previewState.audioCtx.destination);
          srcEntry._directGain = gain;
          // Suppress the videoEl's default audio output (now playing
          // through Web Audio instead). For Safari the MES creation
          // already does this; setting muted=true is belt-and-braces.
          try { srcEntry.videoEl.muted = true; } catch (_) {}
        } else if (node.type === "Webcam") {
          if (!srcEntry.stream || srcEntry.stream.getAudioTracks().length === 0) {
            console.log("[videosrc] Webcam node " + node.id + " has no audio track; skip routing");
            continue;
          }
          mes = previewState.audioCtx.createMediaStreamSource(srcEntry.stream);
          // No direct-playback path for Webcam — would create echo.
        } else if (node.type === "ScreenShare") {
          if (!srcEntry.stream || srcEntry.stream.getAudioTracks().length === 0) {
            console.log("[videosrc] ScreenShare node " + node.id + " has no audio track (the user didn't check 'Share audio' or the browser refused it); skip routing");
            continue;
          }
          mes = previewState.audioCtx.createMediaStreamSource(srcEntry.stream);
          // v0.3.22 — ScreenShare also skips direct-playback. With
          // most "share audio" use cases the user is recording, so
          // they want patch processing only -- direct playback of
          // system audio plus the worklet's output would double up.
        } else {
          continue;
        }
        srcEntry._mediaSource = mes;
      } catch (e) {
        console.warn("[videosrc] media-source create failed for " + node.type + " " + node.id + ":", e);
        continue;
      }
    }
    // Routing: MES → ChannelSplitter (2) → ChannelMerger pair.
    const splitter = previewState.audioCtx.createChannelSplitter(2);
    try {
      mes.connect(splitter);
      splitter.connect(previewState.videoMerger, 0, idx * 2);
      splitter.connect(previewState.videoMerger, 1, idx * 2 + 1);
    } catch (e) {
      console.warn("[videosrc] splitter wire failed:", e);
      continue;
    }
    previewState.videoRoutings.set(node.id, { channelIdx: idx, splitter });
    console.log("[videosrc] " + node.type + " " + node.id + " → worklet input 1 channels " + (idx*2) + "/" + (idx*2+1));
  }

  _updateVideoAudioGains();
}

/* v0.3.19 — refresh direct-playback gains from current node params.
 * Called whenever audioEnabled / volume changes or the wire set
 * changes. Wire-routed sources get gain=0 (the patch is the audio
 * path); unrouted ones get audioEnabled ? volume : 0. */
function _updateVideoAudioGains() {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  const wiredIds = new Set((typeof _videoAudioSrcNodes === "function" ? _videoAudioSrcNodes() : []).map(n => n.id));
  for (const node of state.nodes) {
    if (!node || (node.type !== "VideoFile" && node.type !== "Webcam")) continue;
    const srcEntry = _videoSources.get(node.id);
    if (!srcEntry || !srcEntry._directGain) continue;
    const audioOn = !(node.params && node.params.audioEnabled === 0);
    const vol = (node.params && typeof node.params.volume === "number") ? node.params.volume : 1.0;
    const hasWire = wiredIds.has(node.id);
    // Webcam never plays directly (would echo). VideoFile plays
    // directly only when there's no wire to the patch.
    let v = 0;
    if (node.type === "VideoFile" && !hasWire) v = audioOn ? vol : 0;
    srcEntry._directGain.gain.value = v;
  }
}

/* Cached audio-input device list, populated after first permission
 * grant (browsers only expose device labels once the user has
 * approved at least one mic). The MicInput props pane reads this
 * to populate the source dropdown. */
let _micDeviceList = [];
async function refreshMicDeviceList() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    _micDeviceList = all.filter(d => d.kind === "audioinput")
      .map(d => ({ deviceId: d.deviceId, label: d.label || "" }));
  } catch (e) {
    console.warn("[mic] enumerateDevices failed:", e);
  }
}

/* Record a 1.5-second snippet from the user's microphone and store
 * it as a triggerSamples entry on the given VoiceTrigger node. We
 * use the existing _micStream when available (no re-prompt) and
 * decode via an OfflineAudioContext-style capture: hook a
 * MediaStreamAudioSource into a ScriptProcessor (legacy but cheap
 * + universally available for short clips), buffer the samples,
 * stop. */
async function recordVoiceTriggerSample(node) {
  if (!node || !node.params) return;
  if (!Array.isArray(node.params.triggerSamples)) node.params.triggerSamples = [];
  // Make sure we have a stream.
  if (!_micStream) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _micStream = stream;
      const tracks = stream.getAudioTracks();
      _micDeviceLabel = tracks.length ? tracks[0].label : "default";
      await refreshMicDeviceList();
    } catch (err) {
      alert("Microphone access denied — can't record: " + (err && err.message || err));
      return;
    }
  }
  const DURATION_S = 1.5;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(_micStream);
  // ScriptProcessorNode is deprecated but still works in every
  // browser the editor targets. AudioWorklet would be cleaner but
  // requires registering a module — overkill for a 1.5 s capture.
  const PROC_BUF = 1024;
  const proc = ctx.createScriptProcessor(PROC_BUF, 1, 1);
  const target = Math.ceil(DURATION_S * ctx.sampleRate);
  const data = new Float32Array(target);
  let written = 0;
  const btn = document.getElementById("btn-vt-record");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏺ RECORDING…";
    btn.classList.add("danger");
  }
  proc.onaudioprocess = (ev) => {
    if (written >= target) return;
    const inBuf = ev.inputBuffer.getChannelData(0);
    const room = Math.min(inBuf.length, target - written);
    data.set(inBuf.subarray(0, room), written);
    written += room;
    if (written >= target) finish();
  };
  src.connect(proc);
  proc.connect(ctx.destination);   // Required to make it tick — but we'll mute via gain.
  // Wait — connecting to destination would echo the mic. Detour:
  // route through a zero-gain node so the processor still ticks.
  proc.disconnect(ctx.destination);
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;
  proc.connect(muteGain);
  muteGain.connect(ctx.destination);
  let done = false;
  function finish() {
    if (done) return;
    done = true;
    try { src.disconnect(); proc.disconnect(); muteGain.disconnect(); } catch (e) {}
    try { ctx.close(); } catch (e) {}
    pushHistory("vt-rec:" + node.id);
    const idx = node.params.triggerSamples.length + 1;
    node.params.triggerSamples.push({
      name: "rec_" + idx,
      durationSec: DURATION_S,
      sampleRate: ctx.sampleRate,
      // Store as a regular Array so it serializes cleanly into JSON
      // (Float32Array doesn't survive JSON.stringify intact).
      data: Array.from(data)
    });
    if (btn) {
      btn.disabled = false;
      btn.textContent = "⏺ Record trigger word (1.5 s)";
      btn.classList.remove("danger");
    }
    renderProps(); renderJson();
  }
  // Safety timer in case onaudioprocess starves.
  setTimeout(finish, (DURATION_S + 0.5) * 1000);
}

function disconnectMic() {
  if (previewState.micSource) {
    try { previewState.micSource.disconnect(); } catch (e) {}
    previewState.micSource = null;
  }
  previewState.micConnected = false;
  // Tear down any running KeywordSpotter detectors too — they tap
  // the same mic stream and would dangle otherwise.
  teardownAllKeywordSpotters();
}

/* =========================================================================
 * KeywordSpotter detection pipeline
 *
 * For each KeywordSpotter node with at least one triggerSamples
 * recording, run a JS-side detector that:
 *   1. Computes a 16-point normalized amplitude envelope from each
 *      recording at preview-start time (the "templates").
 *   2. Taps the live mic stream via a ScriptProcessor and maintains
 *      a rolling buffer of the last 1.5 s of audio.
 *   3. Every ~80 ms, extracts the same 16-point envelope from the
 *      buffer and compares to each template via cosine similarity.
 *   4. When the best similarity exceeds matchThreshold AND a
 *      cooldown has elapsed (so a single utterance can't fire
 *      multiple times), dispatches a setter call to fire the
 *      C++ helper's triggerFromJS hostGate.
 *
 * The 16-point envelope is computed by:
 *   - Splitting the input into 16 equal chunks
 *   - Taking RMS of each chunk
 *   - Subtracting the mean and dividing by std-dev (zero-mean unit-
 *     variance), so cosine similarity is loudness-invariant
 *
 * Limitations: amplitude-envelope shape is order-invariant
 * relative to phonemes — captures word duration + energy contour
 * but not what's actually said. Distinguishes "silence" from
 * "speech" reliably; distinguishes a sharp consonant-heavy word
 * from a soft vowel-heavy word; can't distinguish "hello" from
 * "yellow" reliably. For phoneme-level detection the next pass
 * needs MFCC features + DTW. Out of scope for v1.
 * ======================================================================== */

const KS_ENV_BINS = 16;
const KS_TEMPLATE_DURATION_S = 1.5;
const KS_DETECT_INTERVAL_MS = 80;
const KS_COOLDOWN_MS = 600;

// Map nodeId → { templates: [Float32Array(16)], spec: { sampleRate, bufferSec, ringBuf, writeIdx, scriptProc, sourceNode, intervalId, lastFireMs, threshold, fireSetterIndex }}
const _ksDetectors = new Map();

function _ksComputeEnvelope(data, len) {
  // data: typed-array-like of mono PCM samples; len: number of samples to use
  const out = new Float32Array(KS_ENV_BINS);
  const usable = Math.max(1, Math.min(len || data.length, data.length));
  const step = usable / KS_ENV_BINS;
  for (let bin = 0; bin < KS_ENV_BINS; bin++) {
    const lo = Math.floor(bin * step);
    const hi = Math.min(usable, Math.floor((bin + 1) * step));
    let sumSq = 0; let n = 0;
    for (let i = lo; i < hi; i++) { const v = data[i]; sumSq += v * v; n++; }
    out[bin] = n ? Math.sqrt(sumSq / n) : 0;
  }
  // Normalize to zero-mean, unit-variance so cosine similarity is
  // loudness-invariant. Templates and live frames both go through
  // this same normalization.
  let mean = 0;
  for (let i = 0; i < KS_ENV_BINS; i++) mean += out[i];
  mean /= KS_ENV_BINS;
  let varSum = 0;
  for (let i = 0; i < KS_ENV_BINS; i++) { const d = out[i] - mean; out[i] = d; varSum += d * d; }
  const std = Math.sqrt(varSum / KS_ENV_BINS) || 1;
  for (let i = 0; i < KS_ENV_BINS; i++) out[i] /= std;
  return out;
}

function _ksCosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < KS_ENV_BINS; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb) || 1;
  return dot / denom;
}

/* Fuzzy transcript similarity — used in whisper / hybrid modes.
 * Strips punctuation, lowercases. Returns 1 if the template
 * (typically a short word) appears as a substring of the live
 * transcript (best case for keyword spotting — user said the
 * trigger word, possibly surrounded by other speech). Falls back
 * to in-order word-overlap ratio for partial matches. */
function _ksTranscriptMatch(live, template) {
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const L = norm(live);
  const T = norm(template);
  if (!L || !T) return 0;
  if (L.includes(T)) return 1;
  if (T.includes(L)) return Math.min(1, L.length / Math.max(1, T.length));
  // In-order word overlap.
  const tWords = T.split(" ");
  const lWords = L.split(" ");
  if (!tWords.length) return 0;
  let matched = 0, li = 0;
  for (const tw of tWords) {
    while (li < lWords.length && lWords[li] !== tw) li++;
    if (li < lWords.length) { matched++; li++; }
  }
  return matched / tWords.length;
}

/* Lazy-load the Whisper-tiny pipeline (the same instance the AI-
 * prompt voice button uses, exposed via the `whisperPipeline`
 * global at the top of that block). Kept async + serialized so a
 * burst of KeywordSpotter setups doesn't trigger N parallel
 * loads. */
let _ksWhisperLoading = null;
async function _ksEnsureWhisper() {
  if (typeof whisperPipeline !== "undefined" && whisperPipeline) return whisperPipeline;
  if (_ksWhisperLoading) return _ksWhisperLoading;
  _ksWhisperLoading = (async () => {
    const tx = await getTransformersJs();
    // eslint-disable-next-line no-undef -- whisperPipeline is a top-level let in the AI section
    whisperPipeline = await tx.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en");
    return whisperPipeline;
  })();
  try {
    return await _ksWhisperLoading;
  } finally {
    _ksWhisperLoading = null;
  }
}

/* Find the setter index for a KeywordSpotter's `match` host gate.
 * Returns -1 if not found (e.g., the patch wasn't compiled with
 * the spotter, or the setter table is stale). */
function _ksFindMatchSetterIndex(nodeId) {
  if (typeof collectExposedSetters !== "function") return -1;
  const setters = collectExposedSetters();
  for (let i = 0; i < setters.length; i++) {
    const s = setters[i];
    if (s.nodeId === nodeId && s.key === "match" && s.isGate) return i;
  }
  return -1;
}

/* Stand up the detector for one KeywordSpotter node. Idempotent —
 * if a detector is already running for the node, it's torn down
 * and recreated (used when the user re-records or changes the
 * threshold or detect-mode). Async because the whisper / hybrid
 * modes load the pipeline + transcribe templates upfront. */
async function setupKeywordSpotter(node) {
  if (!node || node.type !== "KeywordSpotter") return;
  const recs = (node.params && node.params.triggerSamples) || [];
  if (!recs.length) return;
  if (!previewState.audioCtx || !_micStream) return;
  // Tear down any existing detector for this node first.
  teardownKeywordSpotter(node.id);
  // Always compute envelope templates — used by 'envelope' mode
  // directly and by 'hybrid' mode as the fast pre-filter.
  const templates = recs
    .filter(r => r && Array.isArray(r.data) && r.data.length > 0)
    .map(r => _ksComputeEnvelope(r.data, r.data.length));
  if (!templates.length) return;
  const mode = (typeof node.params.detectMode === "string") ? node.params.detectMode : "envelope";
  // For whisper / hybrid modes, transcribe each recording so we
  // have a string template to match against the live transcript.
  let templateTranscripts = null;
  if (mode === "whisper" || mode === "hybrid") {
    const statusEl = document.getElementById("ks-status-" + node.id);
    if (statusEl) statusEl.textContent = "Detector: loading Whisper-tiny (one-time, ~75 MB)…";
    try {
      const wp = await _ksEnsureWhisper();
      const validRecs = recs.filter(r => r && Array.isArray(r.data) && r.data.length > 0);
      templateTranscripts = [];
      for (let i = 0; i < validRecs.length; i++) {
        if (statusEl) statusEl.textContent = `Detector: transcribing template ${i+1}/${validRecs.length}…`;
        const audio = new Float32Array(validRecs[i].data);
        try {
          const out = await wp(audio);
          const text = (out && out.text || "").trim();
          templateTranscripts.push(text);
        } catch (e) {
          console.warn("[ks] template transcribe failed:", e);
          templateTranscripts.push("");
        }
      }
      console.info("[ks] node", node.id, "template transcripts:", templateTranscripts);
    } catch (err) {
      console.warn("[ks] whisper load failed, falling back to envelope:", err);
      if (statusEl) statusEl.textContent = "Detector: Whisper load failed — using envelope mode.";
      templateTranscripts = null;
    }
  }
  // Tap the mic into a ScriptProcessor so we can read live frames.
  const ctx = previewState.audioCtx;
  const PROC_BUF = 1024;
  const sourceNode = ctx.createMediaStreamSource(_micStream);
  const proc = ctx.createScriptProcessor(PROC_BUF, 1, 1);
  // Rolling buffer of the last KS_TEMPLATE_DURATION_S seconds.
  const bufferSamples = Math.ceil(KS_TEMPLATE_DURATION_S * ctx.sampleRate);
  const ringBuf = new Float32Array(bufferSamples);
  const state = {
    templates,
    templateTranscripts,    // null in envelope mode; array of strings in whisper/hybrid
    mode,                   // "envelope" | "whisper" | "hybrid"
    threshold: (typeof node.params.matchThreshold === "number") ? node.params.matchThreshold : 0.85,
    sampleRate: ctx.sampleRate,
    ringBuf,
    bufferSamples,
    writeIdx: 0,
    sourceNode,
    scriptProc: proc,
    muteGain: null,
    intervalId: null,
    lastFireMs: 0,
    fireSetterIndex: _ksFindMatchSetterIndex(node.id),
    transcribeInFlight: false,
    lastTranscribeMs: 0
  };
  proc.onaudioprocess = (ev) => {
    const inBuf = ev.inputBuffer.getChannelData(0);
    // Append into the circular buffer.
    for (let i = 0; i < inBuf.length; i++) {
      state.ringBuf[state.writeIdx] = inBuf[i];
      state.writeIdx = (state.writeIdx + 1) % state.bufferSamples;
    }
  };
  // Connect through a zero-gain node so the ScriptProcessor ticks
  // (it needs a destination) without echoing the mic to speakers.
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;
  sourceNode.connect(proc);
  proc.connect(muteGain);
  muteGain.connect(ctx.destination);
  state.muteGain = muteGain;
  // Run the comparison on a JS interval. Keep the work small —
  // 16-point envelope on a 1.5 s buffer + 16-element dot products
  // for each template + a few comparisons. Cheap.
  // Reusable: snapshot the rolling buffer in chronological order.
  function _snapshotBuffer() {
    const frame = new Float32Array(state.bufferSamples);
    let r = state.writeIdx;
    for (let i = 0; i < state.bufferSamples; i++) {
      frame[i] = state.ringBuf[r];
      r = (r + 1) % state.bufferSamples;
    }
    return frame;
  }
  // Reusable: dispatch the `match` host gate. Re-resolves the
  // setter index lazily since the setter order can change between
  // recompiles.
  function _fireMatch(reason, scoreText, statusEl) {
    const now = Date.now();
    if (now - state.lastFireMs <= KS_COOLDOWN_MS) return false;
    state.lastFireMs = now;
    if (state.fireSetterIndex < 0) {
      state.fireSetterIndex = _ksFindMatchSetterIndex(node.id);
    }
    if (state.fireSetterIndex >= 0 && previewState.workletNode) {
      previewState.workletNode.port.postMessage({
        type: "set",
        index: state.fireSetterIndex,
        value: 0
      });
    }
    if (statusEl) {
      statusEl.style.color = "var(--phosphor)";
      statusEl.textContent = `▲ MATCH · ${reason} ${scoreText}`;
      setTimeout(() => { if (statusEl) statusEl.style.color = ""; }, 400);
    }
    return true;
  }
  // Schedule a Whisper transcription on the current buffer if one
  // isn't already in flight and the cadence (~600 ms) has elapsed.
  // Returns immediately; the result drives _fireMatch via promise.
  // Used by both 'whisper' (sole detector) and 'hybrid' (confirm).
  function _maybeTranscribe(onResult) {
    if (state.transcribeInFlight) return;
    const now = Date.now();
    if (now - state.lastTranscribeMs < 600) return;
    state.lastTranscribeMs = now;
    state.transcribeInFlight = true;
    const frame = _snapshotBuffer();
    Promise.resolve()
      .then(() => whisperPipeline(frame))
      .then((out) => {
        const live = (out && out.text || "").trim();
        let bestSim = 0;
        if (state.templateTranscripts) {
          for (const tt of state.templateTranscripts) {
            const sim = _ksTranscriptMatch(live, tt);
            if (sim > bestSim) bestSim = sim;
          }
        }
        onResult(live, bestSim);
      })
      .catch((err) => { console.warn("[ks] transcribe error:", err); })
      .finally(() => { state.transcribeInFlight = false; });
  }
  state.intervalId = setInterval(() => {
    const statusEl = document.getElementById("ks-status-" + node.id);
    // Always compute the envelope similarity — needed for 'envelope'
    // and 'hybrid' modes, and useful as a status readout in
    // 'whisper' mode too.
    const frame = _snapshotBuffer();
    const liveEnv = _ksComputeEnvelope(frame, frame.length);
    let bestEnv = -1;
    for (let i = 0; i < state.templates.length; i++) {
      const sim = _ksCosine(liveEnv, state.templates[i]);
      if (sim > bestEnv) bestEnv = sim;
    }
    if (state.mode === "envelope") {
      if (statusEl) {
        statusEl.textContent =
          `Detector [env]: ${state.templates.length} templates · best ${bestEnv.toFixed(2)} / threshold ${state.threshold.toFixed(2)}`;
      }
      if (bestEnv > state.threshold) {
        _fireMatch("envelope", `· similarity ${bestEnv.toFixed(2)}`, statusEl);
      }
    } else if (state.mode === "whisper") {
      // Pure whisper mode — fire only on transcript match.
      if (statusEl && !state.transcribeInFlight) {
        statusEl.textContent =
          `Detector [whisper]: ${state.templates.length} templates · listening… (env ${bestEnv.toFixed(2)} unused) / threshold ${state.threshold.toFixed(2)}`;
      }
      _maybeTranscribe((live, bestSim) => {
        if (statusEl) {
          statusEl.textContent =
            `Detector [whisper]: heard "${(live || "—").slice(0, 40)}" · match ${bestSim.toFixed(2)} / threshold ${state.threshold.toFixed(2)}`;
        }
        if (bestSim > state.threshold) {
          _fireMatch("whisper", `· "${(live || "").slice(0, 30)}" match ${bestSim.toFixed(2)}`, statusEl);
        }
      });
    } else if (state.mode === "hybrid") {
      // Hybrid: envelope is the fast trigger, whisper is the
      // confirm/cancel filter. Logic — fire only when envelope
      // suggests a candidate AND whisper agrees within a recent
      // window. We keep a "pending envelope hit" state and let
      // the whisper pass either upgrade it to a fire or drop it.
      const envHot = bestEnv > state.threshold;
      const ENV_HOT_TTL_MS = 800;   // how long after envelope-hot the whisper pass has to confirm
      const now = Date.now();
      if (envHot) state.envHotUntilMs = now + ENV_HOT_TTL_MS;
      const stillHot = state.envHotUntilMs && now < state.envHotUntilMs;
      if (statusEl && !state.transcribeInFlight) {
        statusEl.textContent =
          `Detector [hybrid]: env ${bestEnv.toFixed(2)} ${stillHot ? "· hot — awaiting whisper confirm" : ""} / threshold ${state.threshold.toFixed(2)}`;
      }
      if (stillHot) {
        _maybeTranscribe((live, bestSim) => {
          if (statusEl) {
            statusEl.textContent =
              `Detector [hybrid]: env ${bestEnv.toFixed(2)} · whisper "${(live || "—").slice(0, 30)}" match ${bestSim.toFixed(2)}`;
          }
          if (bestSim > state.threshold) {
            _fireMatch("hybrid", `· env ${bestEnv.toFixed(2)} + whisper ${bestSim.toFixed(2)}`, statusEl);
            state.envHotUntilMs = 0;
          }
        });
      }
    }
  }, KS_DETECT_INTERVAL_MS);
  _ksDetectors.set(node.id, state);
}

/* Tear down the detector for one node — disconnect Web Audio
 * graph, clear the comparison interval. Called from preview stop,
 * mic disconnect, and any node-edit that invalidates the templates. */
function teardownKeywordSpotter(nodeId) {
  const s = _ksDetectors.get(nodeId);
  if (!s) return;
  if (s.intervalId) clearInterval(s.intervalId);
  try { s.sourceNode && s.sourceNode.disconnect(); } catch (e) {}
  try { s.scriptProc && s.scriptProc.disconnect(); } catch (e) {}
  try { s.muteGain && s.muteGain.disconnect(); } catch (e) {}
  _ksDetectors.delete(nodeId);
}

function teardownAllKeywordSpotters() {
  Array.from(_ksDetectors.keys()).forEach(teardownKeywordSpotter);
}

/* Re-prime templates for a single node. Called from the props
 * pane when the user adds or deletes a recording or moves the
 * threshold slider. If the node isn't currently running (no
 * preview), this is a no-op — the fresh templates will be
 * computed at next preview start. Re-transcribes templates if
 * the detector is in whisper / hybrid mode. */
async function refreshKeywordSpotterTemplates(nodeId) {
  if (!_ksDetectors.has(nodeId)) return;
  const node = nodeById(nodeId);
  if (!node) { teardownKeywordSpotter(nodeId); return; }
  const recs = (node.params && node.params.triggerSamples) || [];
  if (!recs.length) { teardownKeywordSpotter(nodeId); return; }
  const s = _ksDetectors.get(nodeId);
  s.templates = recs
    .filter(r => r && Array.isArray(r.data) && r.data.length > 0)
    .map(r => _ksComputeEnvelope(r.data, r.data.length));
  s.threshold = (typeof node.params.matchThreshold === "number") ? node.params.matchThreshold : 0.85;
  // Whisper / hybrid: re-transcribe templates if the recording
  // set changed. Threshold-only updates skip this since they
  // don't affect the templates themselves.
  if ((s.mode === "whisper" || s.mode === "hybrid") && typeof whisperPipeline !== "undefined" && whisperPipeline) {
    const validRecs = recs.filter(r => r && Array.isArray(r.data) && r.data.length > 0);
    const next = [];
    for (const r of validRecs) {
      try {
        const audio = new Float32Array(r.data);
        const out = await whisperPipeline(audio);
        next.push((out && out.text || "").trim());
      } catch (e) {
        next.push("");
      }
    }
    s.templateTranscripts = next;
    console.info("[ks] refreshed transcripts for", nodeId, ":", next);
  }
}

/* Stand up detectors for every KeywordSpotter in the current
 * patch. Called from the preview-start path after the mic stream
 * is hooked up. Async since whisper-mode setup loads the
 * pipeline + transcribes templates upfront. */
async function setupAllKeywordSpotters() {
  for (const n of state.nodes) {
    if (n.type === "KeywordSpotter") {
      try { await setupKeywordSpotter(n); }
      catch (e) { console.warn("[ks] setup failed for", n.id, e); }
    }
  }
}

function showCompileStderr(stderr, errMsg) {
  const sect = document.getElementById("build-stderr-section");
  const out  = document.getElementById("build-stderr");
  if (!sect || !out) return;
  if (!stderr && !errMsg) { sect.style.display = "none"; return; }
  sect.style.display = "block";
  out.textContent = (errMsg ? "// " + errMsg + "\n\n" : "") + (stderr || "");
}

function previewStop() {
  // If a compile is in-flight, kill the worker so user gets out of a
  // long-running clang invocation. Next Play will respawn the worker;
  // the @wasmer/sdk + clang package stay cached in IndexedDB so the
  // restart is fast (the SDK init takes ~2 s; clang reload is ~5 s
  // when cached vs the original ~3 min download).
  if (previewState.state === "compiling" && previewState.worker) {
    previewState.worker.terminate();
    previewState.worker = null;
    previewState.workerReady = null;
    previewProgressEnd(false);
    setPreviewStatus("idle", "compile canceled");
    return;
  }
  // Disconnect mic source BEFORE the audio context is closed —
  // otherwise the source's underlying MediaStreamTrack stays active
  // (different lifecycle) and the OS-level mic indicator stays on.
  disconnectMic();
  // v0.3.19 — also tear down the VideoSrc routing chain so the
  // ChannelMerger / GainNodes / MediaElementSources don't outlive
  // the audio context. We can't recreate MES for the same videoEl
  // later (one-shot per element); we clear the cached refs so a
  // future Play+ensureVideoAudioConnected can reuse the videoEls
  // (the existing _videoSources entries persist) with fresh MES.
  if (previewState.videoMerger) {
    try { previewState.videoMerger.disconnect(); } catch (_) {}
    previewState.videoMerger = null;
  }
  if (previewState.videoRoutings) {
    previewState.videoRoutings.forEach(r => {
      try { r.splitter.disconnect(); } catch (_) {}
    });
    previewState.videoRoutings.clear();
  }
  // Clear per-source MES refs so the next Play creates fresh ones
  // against the new audioCtx (MES is tied to its creation context).
  _videoSources.forEach(entry => {
    if (entry._mediaSource) {
      try { entry._mediaSource.disconnect(); } catch (_) {}
      entry._mediaSource = null;
    }
    if (entry._directGain) {
      try { entry._directGain.disconnect(); } catch (_) {}
      entry._directGain = null;
    }
  });
  if (previewState.workletNode) {
    previewState.workletNode.port.postMessage({ type: "stop" });
    previewState.workletNode.disconnect();
    previewState.workletNode = null;
  }
  if (previewState.audioCtx) {
    previewState.audioCtx.close().catch(() => {});
    previewState.audioCtx = null;
  }
  previewState.analyserL = null;
  previewState.analyserR = null;
  stopMeterLoop();
  previewProgressEnd(false);
  setPreviewStatus("idle", "idle");
}

if (previewBtnPlay) {
  previewBtnPlay.addEventListener("click", () => {
    if (previewState.state === "playing") {
      // Pause
      if (previewState.audioCtx) previewState.audioCtx.suspend();
      setPreviewStatus("paused", "paused");
    } else if (previewState.state === "paused") {
      if (previewState.audioCtx) previewState.audioCtx.resume();
      setPreviewStatus("playing", "playing");
    } else {
      previewCompileAndPlay();
    }
  });
}
if (previewBtnStop) previewBtnStop.addEventListener("click", previewStop);

/* ------------- Keyboard-input driver ------------- */
/* Maps QWERTY rows to a 1.5-octave virtual keyboard. White keys on the
 * home row (A=C4 … L=E5+), black keys on the row above. When a
 * KeyboardIn node is present in the patch and preview is playing,
 * keydown sends two messages to the worklet:
 *
 *   1. preview_set(<freq setter index for the KeyboardIn node>, freqHz)
 *   2. preview_set(<i>, 0) for each isGate setter in the patch
 *      → retriggers AD/AHD/etc. envelopes on every press.
 *
 * keyup is a no-op (held notes sustain until envelope releases on its
 * own). Doesn't capture when the focused element is text-input —
 * typing into the patch name or User-DSP editor still works. */
const QWERTY_TO_MIDI = {
  // White keys (home row) — A=C4, S=D4, D=E4, F=F4, G=G4, H=A4, J=B4, K=C5, L=D5, ";"=E5
  "a": 60, "s": 62, "d": 64, "f": 65, "g": 67, "h": 69, "j": 71, "k": 72, "l": 74, ";": 76,
  // Black keys (top row) — W=C#4, E=D#4, T=F#4, Y=G#4, U=A#4, O=C#5, P=D#5
  "w": 61, "e": 63, "t": 66, "y": 68, "u": 70, "o": 73, "p": 75
};
const kbHeldKeys = new Set();
// Per-key frequency overrides: { qwertyKey: hz }. Set rows ignore the
// MIDI mapping and the octave shift — pinned to whatever Hz the user
// typed in the keymap modal. Empty rows fall back to default behavior.
let kbCustomFreqs = (function () {
  try {
    const raw = localStorage.getItem("gamma-kb-key-freqs");
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch (_) { return {}; }
})();
function saveCustomFreqs() {
  try { localStorage.setItem("gamma-kb-key-freqs", JSON.stringify(kbCustomFreqs)); } catch (_) {}
}
// Octave-shift state. Z lowers, X raises, in 12-semitone steps.
// Persists to localStorage so the shift survives reloads.
let kbOctaveShift = (function () {
  try { return parseInt(localStorage.getItem("gamma-kb-octave-shift") || "0", 10) || 0; }
  catch (_) { return 0; }
})();
const KB_OCTAVE_MIN = -36, KB_OCTAVE_MAX = 36;     // ±3 octaves of headroom
function setKbOctaveShift(s) {
  kbOctaveShift = Math.max(KB_OCTAVE_MIN, Math.min(KB_OCTAVE_MAX, s));
  try { localStorage.setItem("gamma-kb-octave-shift", String(kbOctaveShift)); } catch (_) {}
  updateOctaveReadout();
  // Re-render piano to reposition the highlighted octave window.
  renderPiano();
  // Mirror octave label / key letters to the touchscreen popup.
  if (typeof _pushTouchControlsSnapshot === "function") _pushTouchControlsSnapshot();
}
function updateOctaveReadout() {
  const r = document.getElementById("piano-octave-readout");
  if (!r) return;
  const semis = kbOctaveShift;
  const oct = semis / 12;
  if (semis === 0) r.textContent = "octave 0";
  else r.textContent = "octave " + (oct >= 0 ? "+" : "") + oct;
}
function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

function findKeyboardSetterIndex() {
  const setters = collectExposedSetters();
  for (let i = 0; i < setters.length; i++) {
    const s = setters[i];
    if (s.nodeType === "KeyboardIn" && s.key === "freq" && !s.isGate) return i;
  }
  return -1;
}
/* Gate setters split by role. "press" = anything that should fire on
 * key-down (the default — covers AD.trig, Button.press, KeyboardIn's
 * trigger, etc.); "release" = anything bound to a key-up event. The
 * heuristic is purely by setter key name: "rel" / "release" are
 * release; everything else is press. Without this split, adding
 * KeyboardIn's rel hostGate would cause press-and-immediate-release
 * since the JS used to fire ALL gate setters on every keydown. */
function listGateSetterIndices(role) {
  role = role || "press";
  const setters = collectExposedSetters();
  const out = [];
  setters.forEach((s, i) => {
    if (!s.isGate) return;
    const isRelease = (s.key === "rel" || s.key === "release");
    if (role === "release" ? isRelease : !isRelease) out.push(i);
  });
  return out;
}

/* Trigger one note. Sends freq + every exposed gate, lights the
 * matching piano key, updates the readout. Source can be the
 * QWERTY keydown handler or a piano-key mouse click. */
function playKeyboardNote(qwertyKey) {
  if (!(qwertyKey in QWERTY_TO_MIDI)) return false;
  if (!previewState.workletNode || previewState.state !== "playing") return false;
  const kbIdx = findKeyboardSetterIndex();
  if (kbIdx < 0) return false;
  // Custom override wins; otherwise apply the octave-shifted default.
  let midi, freq;
  if (typeof kbCustomFreqs[qwertyKey] === "number" && isFinite(kbCustomFreqs[qwertyKey])) {
    freq = kbCustomFreqs[qwertyKey];
    midi = freqToMidi(freq);
  } else {
    midi = QWERTY_TO_MIDI[qwertyKey] + kbOctaveShift;
    freq = midiToFreq(midi);
  }
  previewState.workletNode.port.postMessage({ type: "set", index: kbIdx, value: freq });
  // Fire only press-style gate setters (trigger / press / reset).
  // Release-style gates (KeyboardIn.rel / ADSR.rel) fire on key-up.
  listGateSetterIndices("press").forEach(i => {
    previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
  });
  highlightPianoKey(qwertyKey, true);
  updatePianoReadout(midi, freq);
  return true;
}
// Reverse of midiToFreq — used to display a meaningful note name when
// a key has been overridden to an arbitrary Hz value.
function freqToMidi(hz) {
  if (!hz || !isFinite(hz) || hz <= 0) return 0;
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

/* Sprint 5.handwriting-multimonitor -- MIDI-direct play/release for
 * the touchscreen popup's multi-octave keyboard. playKeyboardNote
 * is QWERTY-keyed (and only handles the one octave QWERTY_TO_MIDI
 * spans); the touch keyboard can reach any MIDI note. Same audio
 * path otherwise: write freq to KeyboardIn.setFreq, fire all press
 * gates (release fires the rel gates). Also highlights the on-
 * screen piano key if the MIDI value happens to land in the visible
 * QWERTY-mapped octave -- otherwise no highlight, since the main
 * piano widget only renders that octave. */
function playKeyboardMidi(midi) {
  if (!previewState.workletNode || previewState.state !== "playing") return false;
  const kbIdx = findKeyboardSetterIndex();
  if (kbIdx < 0) return false;
  const freq = midiToFreq(midi);
  previewState.workletNode.port.postMessage({ type: "set", index: kbIdx, value: freq });
  listGateSetterIndices("press").forEach(i => {
    previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
  });
  // If the MIDI value maps to a visible QWERTY key (under the
  // current octave shift), light it up so the user sees their
  // touchscreen press on main's piano too.
  const qk = midiToQwertyAt(midi);
  if (qk) highlightPianoKey(qk, true);
  updatePianoReadout(midi, freq);
  return true;
}
function releaseKeyboardMidi(midi) {
  if (previewState.workletNode && previewState.state === "playing") {
    listGateSetterIndices("release").forEach(i => {
      previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
    });
  }
  const qk = midiToQwertyAt(midi);
  if (qk) highlightPianoKey(qk, false);
}
// Reverse-lookup: which QWERTY letter maps to this MIDI note (with
// the current octave shift applied)? Returns null if outside the
// QWERTY-mapped range. Used to highlight main's piano widget for
// touchscreen-initiated notes that land in the visible octave.
function midiToQwertyAt(midi) {
  for (const k in QWERTY_TO_MIDI) {
    if ((QWERTY_TO_MIDI[k] + kbOctaveShift) === midi) return k;
  }
  return null;
}
function releaseKeyboardNote(qwertyKey) {
  if (!(qwertyKey in QWERTY_TO_MIDI)) return;
  highlightPianoKey(qwertyKey, false);
  // Fire any release-style gate setters (KeyboardIn.rel → ADSR.rel etc).
  // Lets a held QWERTY key sustain an ADSR envelope; key-up triggers
  // the release stage. No-op if no release gate is exposed.
  if (previewState.workletNode && previewState.state === "playing") {
    listGateSetterIndices("release").forEach(i => {
      previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
    });
  }
}

document.addEventListener("keydown", (ev) => {
  if (ev.repeat) return;
  const tgt = ev.target;
  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  // Z / X — octave shift while audio is live. Active in any state so
  // users can pre-set the octave before clicking Play.
  if (k === "z") { ev.preventDefault(); setKbOctaveShift(kbOctaveShift - 12); return; }
  if (k === "x") { ev.preventDefault(); setKbOctaveShift(kbOctaveShift + 12); return; }
  if (!(k in QWERTY_TO_MIDI)) return;
  ev.preventDefault();
  if (kbHeldKeys.has(k)) return;
  kbHeldKeys.add(k);
  playKeyboardNote(k);
});
document.addEventListener("keyup", (ev) => {
  const k = ev.key.toLowerCase();
  if (k in QWERTY_TO_MIDI) {
    kbHeldKeys.delete(k);
    releaseKeyboardNote(k);
  }
});

/* ------------- On-screen piano widget ------------- */
/* Mirrors QWERTY_TO_MIDI as a one-octave-and-change visual keyboard.
 * Active state is set by playKeyboardNote / releaseKeyboardNote so
 * QWERTY presses, mouse clicks, and any future MIDI input paths all
 * surface through the same lit-key feedback. */
const PIANO_LAYOUT = [
  // [qwertyKey, "white" | "black", label] — order matches MIDI ascending
  ["a","white"], ["w","black"], ["s","white"], ["e","black"], ["d","white"],
  ["f","white"], ["t","black"], ["g","white"], ["y","black"], ["h","white"],
  ["u","black"], ["j","white"], ["k","white"], ["o","black"], ["l","white"],
  ["p","black"], [";","white"]
];
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function midiName(m) {
  return NOTE_NAMES[((m % 12) + 12) % 12] + Math.floor(m / 12 - 1);
}
function renderPiano() {
  const wrap = document.getElementById("piano-keys");
  if (!wrap) return;
  wrap.innerHTML = "";
  // Show three octaves of keys (C3..B5 = MIDI 48..83 — 21 white keys).
  // The MIDI range covered by QWERTY_TO_MIDI (60..76) plus octave shift
  // is highlighted as the playable window; out-of-window keys render
  // dimmer with no QWERTY label.
  const PLAYABLE_LO = 60 + kbOctaveShift;
  const PLAYABLE_HI = 76 + kbOctaveShift;
  // Reverse map: midi → qwerty (for the playable window).
  const midiToQwerty = {};
  Object.entries(QWERTY_TO_MIDI).forEach(([k, m]) => { midiToQwerty[m + kbOctaveShift] = k; });
  // Black-key flag per chroma.
  const isBlack = (m) => [1,3,6,8,10].includes(((m % 12) + 12) % 12);
  const RANGE_LO = 48, RANGE_HI = 83;
  let whiteIndex = 0;
  for (let m = RANGE_LO; m <= RANGE_HI; m++) {
    const black = isBlack(m);
    const qwerty = midiToQwerty[m] || null;
    const inWindow = (m >= PLAYABLE_LO && m <= PLAYABLE_HI);
    const el = document.createElement("div");
    el.className = "piano-key " + (black ? "black" : "white") + (inWindow ? "" : " inactive");
    el.dataset.midi = String(m);
    if (qwerty) el.dataset.qwerty = qwerty;
    // Custom-frequency override mark — amber underline so the user can
    // see at a glance which keys are pinned.
    if (qwerty && typeof kbCustomFreqs[qwerty] === "number") {
      el.classList.add("overridden");
    }
    // Label: QWERTY letter if this MIDI is mapped, else the note name
    // for the C key of each octave (orientation marker).
    if (qwerty) {
      el.textContent = qwerty === ";" ? ";" : qwerty;
    } else if (((m % 12) + 12) % 12 === 0 && !black) {
      // Show "C4" / "C5" / ... on every C as an orientation marker.
      el.textContent = "C" + (Math.floor(m / 12 - 1));
      el.classList.add("octave-marker");
    } else {
      el.textContent = "";
    }
    if (black) {
      el.style.left = (1 + whiteIndex * 31 - 10) + "px";
      wrap.appendChild(el);
    } else {
      wrap.appendChild(el);
      whiteIndex++;
    }
  }
  // Pointer interactions: mouse plays whichever MIDI the key carries
  // (regardless of whether it has a QWERTY mapping in the current
  // window). Lets the user reach any note via mouse without shifting.
  wrap.querySelectorAll(".piano-key").forEach(el => {
    const m = parseInt(el.dataset.midi, 10);
    const onDown = (ev) => { ev.preventDefault(); playMidi(m, el); };
    const onUp   = ()     => { releaseMidi(el); };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup",   onUp);
    el.addEventListener("pointerleave",onUp);
  });
  updateOctaveReadout();
}
// Mouse-driven note play — bypasses the qwerty→midi map so users can
// click any key in the visible 3-octave range, not just those bound
// to letters in the current window.
function playMidi(midi, keyEl) {
  if (!previewState.workletNode || previewState.state !== "playing") return;
  const kbIdx = findKeyboardSetterIndex();
  if (kbIdx < 0) return;
  const freq = midiToFreq(midi);
  previewState.workletNode.port.postMessage({ type: "set", index: kbIdx, value: freq });
  listGateSetterIndices("press").forEach(i => {
    previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
  });
  if (keyEl) keyEl.classList.add("active");
  updatePianoReadout(midi, freq);
}
/* Mouse-up on a piano key — counterpart to playMidi. Fires any
 * release-gate setters so an ADSR envelope's release stage triggers
 * when the user lets go of a clicked key. */
function releaseMidi(keyEl) {
  if (keyEl) keyEl.classList.remove("active");
  if (!previewState.workletNode || previewState.state !== "playing") return;
  listGateSetterIndices("release").forEach(i => {
    previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
  });
}
function highlightPianoKey(qwertyKey, on) {
  const wrap = document.getElementById("piano-keys");
  if (!wrap) return;
  const el = wrap.querySelector('[data-qwerty="' + qwertyKey.replace('"','\\"') + '"]');
  if (!el) return;
  el.classList.toggle("active", !!on);
}
function updatePianoReadout(midi, freq) {
  const r = document.getElementById("piano-readout");
  if (!r) return;
  r.innerHTML =
    midiName(midi) +
    ' <span class="dim">·</span> ' +
    Math.round(freq) + 'hz' +
    ' <span class="dim">·</span> ' +
    'midi ' + midi;
}
function resetPiano() {
  document.querySelectorAll(".piano-key.active").forEach(el => el.classList.remove("active"));
  const r = document.getElementById("piano-readout");
  if (r) r.innerHTML = '<span class="dim">no note</span>';
  const status = document.getElementById("monitor-status");
  if (status) status.textContent = "idle";
}
function showPiano() {
  // Piano is now part of the Monitor tab — no visibility toggle needed.
  // Just update the status readout so users know audio is live.
  const status = document.getElementById("monitor-status");
  if (status) status.textContent = "live";
}
renderPiano();

/* ------------- Per-key frequency override modal ------------- */
/* Lists every QWERTY key bound by QWERTY_TO_MIDI; user types an Hz
 * value to pin that key, leaves blank to fall back to the default
 * MIDI mapping. Pinned keys ignore octave shift. */
function openKeymapModal() {
  const modal = document.getElementById("keymap-modal");
  const grid  = document.getElementById("keymap-grid");
  if (!modal || !grid) return;
  // Build rows in MIDI ascending order to match the piano layout.
  const ordered = Object.entries(QWERTY_TO_MIDI).sort((a, b) => a[1] - b[1]);
  grid.innerHTML = "";
  ordered.forEach(([k, midi]) => {
    const defFreq = midiToFreq(midi);
    const cur = kbCustomFreqs[k];
    const isSet = typeof cur === "number" && isFinite(cur);
    const row = document.createElement("div");
    row.className = "keymap-row";
    row.innerHTML =
      '<div class="keymap-letter">' + (k === ";" ? ";" : k) + '</div>' +
      '<div class="keymap-default">' + midiName(midi) + ' · ' + defFreq.toFixed(1) + 'hz</div>' +
      '<input class="keymap-input' + (isSet ? ' set' : '') + '" type="number" step="any" min="1" placeholder="' + defFreq.toFixed(2) + '" value="' + (isSet ? cur : '') + '" data-key="' + k + '" />' +
      '<button class="keymap-clear" data-key="' + k + '" title="Clear override"' + (isSet ? '' : ' disabled') + '>×</button>';
    grid.appendChild(row);
  });
  // Wire input + clear handlers.
  grid.querySelectorAll(".keymap-input").forEach(inp => {
    inp.addEventListener("input", () => {
      const k = inp.dataset.key;
      const v = parseFloat(inp.value);
      if (isFinite(v) && v > 0) {
        kbCustomFreqs[k] = v;
        inp.classList.add("set");
        const btn = grid.querySelector('.keymap-clear[data-key="' + k.replace('"','\\"') + '"]');
        if (btn) btn.disabled = false;
      } else {
        delete kbCustomFreqs[k];
        inp.classList.remove("set");
        const btn = grid.querySelector('.keymap-clear[data-key="' + k.replace('"','\\"') + '"]');
        if (btn) btn.disabled = true;
      }
      saveCustomFreqs();
      renderPiano();
    });
  });
  grid.querySelectorAll(".keymap-clear").forEach(btn => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.key;
      delete kbCustomFreqs[k];
      saveCustomFreqs();
      const inp = grid.querySelector('.keymap-input[data-key="' + k.replace('"','\\"') + '"]');
      if (inp) { inp.value = ""; inp.classList.remove("set"); }
      btn.disabled = true;
      renderPiano();
    });
  });
  modal.style.display = "flex";
}
function closeKeymapModal() {
  const modal = document.getElementById("keymap-modal");
  if (modal) modal.style.display = "none";
}
(function setupKeymapModal() {
  const open = document.getElementById("btn-keymap-edit");
  const close = document.getElementById("btn-keymap-close");
  const done = document.getElementById("btn-keymap-done");
  const reset = document.getElementById("btn-keymap-reset");
  const modal = document.getElementById("keymap-modal");
  if (!open || !modal) return;
  open.addEventListener("click", openKeymapModal);
  if (close) close.addEventListener("click", closeKeymapModal);
  if (done)  done .addEventListener("click", closeKeymapModal);
  if (reset) reset.addEventListener("click", () => {
    kbCustomFreqs = {};
    saveCustomFreqs();
    renderPiano();
    openKeymapModal();   // rebuild the rows with cleared values
  });
  modal.addEventListener("click", e => { if (e.target === modal) closeKeymapModal(); });
})();

/* ------------- Monitor controls (Button + Slider host nodes) ------------- */
/* Renders one row per Button / Slider node in the patch. Buttons fire
 * the host-gate setter on click (one-sample pulse); sliders write the
 * value setter on input. Setter indices are looked up via
 * collectExposedSetters by nodeId. Re-rendered on render() since the
 * node set can change at any time. */
/* Curve helpers — drag position t in [0..1] → output in [min..max].
 * Used by sliders to remap the linear range input into perceptually
 * useful curves (frequency / amplitude / decay / etc.). The inverse
 * is needed to compute the slider's drag position from a stored
 * value — analytic for linear/log/exp; sCurve uses a binary search
 * since 3t² - 2t³ has no clean inverse. */

/* Sprint 5.slider-aware — heuristic ranges by destination port name.
 * When a Slider's output gets wired into a param input, we check
 * this map (lowercase port name) and if the Slider is still at its
 * spawn-time defaults (min:0/max:1/curve:linear) we snap it to a
 * sensible range so the user doesn't have to manually configure a
 * 0..20000 freq slider every time.
 *
 * Match is exact-name first, then substring. Keep entries lowercase. */
const PARAM_HEURISTICS = {
  // Pitch / frequency
  "freq":      { min: 20,    max: 20000, curve: "log" },
  "frequency": { min: 20,    max: 20000, curve: "log" },
  "cutoff":    { min: 20,    max: 20000, curve: "log" },
  "hz":        { min: 20,    max: 20000, curve: "log" },
  // Resonance
  "q":         { min: 0.5,   max: 20,    curve: "log" },
  "res":       { min: 0,     max: 1,     curve: "linear" },
  "resonance": { min: 0,     max: 1,     curve: "linear" },
  // Levels / gain
  "gain":      { min: 0,     max: 2,     curve: "exp" },
  "amp":       { min: 0,     max: 1,     curve: "exp" },
  "level":     { min: 0,     max: 1,     curve: "exp" },
  "volume":    { min: 0,     max: 1,     curve: "exp" },
  // 0..1 dials (default-ish for mix-style controls)
  "amount":    { min: 0,     max: 1,     curve: "linear" },
  "mix":       { min: 0,     max: 1,     curve: "linear" },
  "depth":     { min: 0,     max: 1,     curve: "linear" },
  "wet":       { min: 0,     max: 1,     curve: "linear" },
  "dry":       { min: 0,     max: 1,     curve: "linear" },
  "feedback":  { min: 0,     max: 0.95,  curve: "linear" },
  "damping":   { min: 0,     max: 1,     curve: "linear" },
  "width":     { min: 0,     max: 1,     curve: "linear" },
  // Time / rate
  "delay":     { min: 0,     max: 2000,  curve: "log" },
  "time":      { min: 0,     max: 2000,  curve: "log" },
  "atk":       { min: 0,     max: 5000,  curve: "log" },
  "attack":    { min: 0,     max: 5000,  curve: "log" },
  "dec":       { min: 0,     max: 5000,  curve: "log" },
  "decay":     { min: 0,     max: 5000,  curve: "log" },
  "sus":       { min: 0,     max: 1,     curve: "linear" },
  "sustain":   { min: 0,     max: 1,     curve: "linear" },
  "rel":       { min: 0,     max: 5000,  curve: "log" },
  "release":   { min: 0,     max: 5000,  curve: "log" },
  "rate":      { min: 0.01,  max: 100,   curve: "log" },
  "speed":     { min: 0.01,  max: 100,   curve: "log" },
  // Modulation
  "ratio":     { min: 0.25,  max: 16,    curve: "log" },
  "index":     { min: 0,     max: 10,    curve: "linear" },
  "modindex":  { min: 0,     max: 10,    curve: "linear" },
  "modidx":    { min: 0,     max: 10,    curve: "linear" },
  // Stereo / pan / pitch offsets
  "pan":       { min: -1,    max: 1,     curve: "linear" },
  "detune":    { min: -1200, max: 1200,  curve: "linear" },
  "semi":      { min: -24,   max: 24,    curve: "linear" },
  "semitone":  { min: -24,   max: 24,    curve: "linear" },
  "phase":     { min: 0,     max: 1,     curve: "linear" },
  "offset":    { min: 0,     max: 1,     curve: "linear" }
};

/* Look up a heuristic by destination port name. Tries exact match
 * first, then case-insensitive substring (so "filterCutoff" matches
 * "cutoff"). Returns null when no rule applies. */
function paramHeuristicFor(portName) {
  if (!portName) return null;
  const lc = portName.toLowerCase();
  if (PARAM_HEURISTICS[lc]) return PARAM_HEURISTICS[lc];
  // Substring scan -- longest key wins so "cutoff" wins over "off".
  const keys = Object.keys(PARAM_HEURISTICS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (lc.includes(k)) return PARAM_HEURISTICS[k];
  }
  return null;
}

/* "Is this slider at its spawn-time defaults?" Used to gate the
 * auto-range apply -- we don't want to clobber a user's manual
 * tuning. Defaults match the Slider registry params: value=0.5,
 * min=0, max=1, curve=linear. */
function _sliderAtDefaults(node) {
  if (!node || node.type !== "Slider") return false;
  const p = node.params || {};
  return (p.min === 0 || p.min === undefined)
      && (p.max === 1 || p.max === undefined)
      && (p.curve === "linear" || p.curve === undefined);
}

const SLIDER_CURVES = {
  linear: { fwd: t => t,                                inv: y => y },
  log:    { fwd: t => Math.log10(1 + 9 * t),            inv: y => (Math.pow(10, y) - 1) / 9 },
  exp:    { fwd: t => t * t,                            inv: y => Math.sqrt(Math.max(0, y)) },
  sCurve: { fwd: t => t * t * (3 - 2 * t),              inv: y => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (mid * mid * (3 - 2 * mid) < y) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }}
};
// LUT-driven curve mapping (drag pos t ∈ [0,1] → output 0..1).
// Inverse uses bisection — needed when the table is non-monotonic
// (free-drawn curves) so we just find the closest x for a given y.
function lutForward(t, tbl) {
  const N = tbl.length;
  if (N === 0) return t;
  const fi = Math.max(0, Math.min(1, t)) * (N - 1);
  const i0 = Math.floor(fi), i1 = Math.min(N - 1, i0 + 1);
  return tbl[i0] * (1 - (fi - i0)) + tbl[i1] * (fi - i0);
}
function lutInverse(y, tbl) {
  const N = tbl.length;
  if (N === 0) return y;
  // Linear scan for the closest table entry — fine at N=64.
  let bestT = 0, bestDist = Infinity;
  for (let i = 0; i < N; i++) {
    const d = Math.abs(tbl[i] - y);
    if (d < bestDist) { bestDist = d; bestT = i / (N - 1); }
  }
  return bestT;
}
function sliderValueFromT(t, min, max, curve, tbl) {
  let mapped;
  if (curve === "custom" && Array.isArray(tbl) && tbl.length) {
    mapped = lutForward(t, tbl);
  } else {
    const fn = (SLIDER_CURVES[curve] || SLIDER_CURVES.linear).fwd;
    mapped = fn(Math.max(0, Math.min(1, t)));
  }
  return min + (max - min) * mapped;
}
function sliderTFromValue(v, min, max, curve, tbl) {
  if (max === min) return 0;
  const yNorm = Math.max(0, Math.min(1, (v - min) / (max - min)));
  if (curve === "custom" && Array.isArray(tbl) && tbl.length) {
    return lutInverse(yNorm, tbl);
  }
  const inv = (SLIDER_CURVES[curve] || SLIDER_CURVES.linear).inv;
  return Math.max(0, Math.min(1, inv(yNorm)));
}

function renderMonitorControls() {
  const wrap = document.getElementById("monitor-controls");
  if (!wrap) return;
  const buttons = state.nodes.filter(n => n.type === "Button");
  const sliders = state.nodes.filter(n => n.type === "Slider");
  if (!buttons.length && !sliders.length) {
    wrap.innerHTML = "";
    return;
  }
  const setters = collectExposedSetters();
  const findIdx = (nodeId, key, isGate) => {
    for (let i = 0; i < setters.length; i++) {
      const s = setters[i];
      if (s.nodeId === nodeId && s.key === key && !!s.isGate === !!isGate) return i;
    }
    return -1;
  };
  wrap.innerHTML = "";
  buttons.forEach(b => {
    const idx = findIdx(b.id, "trig", true);
    const label = (b.params && typeof b.params.label === "string" && b.params.label) ? b.params.label : "press";
    const row = document.createElement("div");
    row.className = "monitor-control monitor-control-grid-button";
    row.innerHTML =
      '<span class="monitor-control-id">btn <b>' + b.id + '</b></span>' +
      '<button class="monitor-control-button"></button>' +
      '<button class="monitor-control-curve" title="Edit gate-output shape">≈</button>' +
      '<span></span>';
    const btn = row.querySelector(".monitor-control-button");
    const editBtn = row.querySelector(".monitor-control-curve");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (idx < 0 || !previewState.workletNode || previewState.state !== "playing") return;
      previewState.workletNode.port.postMessage({ type: "set", index: idx, value: 0 });
      btn.classList.add("firing");
      setTimeout(() => btn.classList.remove("firing"), 80);
    });
    editBtn.addEventListener("click", () => openRampModal("button", b.id));
    wrap.appendChild(row);
  });
  sliders.forEach(s => {
    const idx = findIdx(s.id, "value", false);
    const min = (s.params && typeof s.params.min === "number") ? s.params.min : 0;
    const max = (s.params && typeof s.params.max === "number" && s.params.max > min) ? s.params.max : (min + 1);
    // curve can be "linear" / "log" / "exp" / "sCurve" (analytic) or
    // "custom" (uses params.curveTable). Fall back to linear if unknown.
    const rawCurve = s.params && typeof s.params.curve === "string" ? s.params.curve : "linear";
    const curve = (SLIDER_CURVES[rawCurve] || rawCurve === "custom") ? rawCurve : "linear";
    const tbl = (s.params && Array.isArray(s.params.curveTable)) ? s.params.curveTable : null;
    let cur = (s.params && typeof s.params.value === "number") ? s.params.value : (min + max) / 2;
    if (cur < min) cur = min; if (cur > max) cur = max;
    if (s.params && s.params.value !== cur) s.params.value = cur;
    // Range input always uses LINEAR t in 0..1; we map to the curved
    // value on every change. Inverse-mapping the stored value seeds
    // the thumb to the right position on first render.
    const initT = sliderTFromValue(cur, min, max, curve, tbl);
    const stepT = 0.001;
    const digits = Math.max(0, Math.ceil(-Math.log10((max - min) / 1000 || 1e-4)));
    const fmtVal = v => v.toFixed(digits);
    // Sprint 5.slider-aware -- list every input port this slider's
    // out is wired to, so the user sees what the knob actually
    // drives without having to follow wires on the canvas. Format:
    //   "→ Sine#n4.freq"  (one target)
    //   "→ Sine#n4.freq, BiquadLP#n7.cutoff"  (fan-out)
    const targets = state.edges
      .filter(e => e && e.from && e.from.node === s.id)
      .map(e => {
        const dn = state.nodes.find(n => n.id === e.to.node);
        return dn ? (dn.type + "#" + dn.id + "." + e.to.port) : null;
      })
      .filter(Boolean);
    const targetTxt = targets.length
      ? ' <span class="monitor-control-conn" title="' + escapeText(targets.join(", ")) + '">→ ' + escapeText(targets.slice(0, 2).join(", ") + (targets.length > 2 ? ", +" + (targets.length - 2) : "")) + '</span>'
      : "";
    const row = document.createElement("div");
    row.className = "monitor-control monitor-control-grid-with-edit";
    row.innerHTML =
      '<span class="monitor-control-id">sld <b>' + s.id + '</b>' + targetTxt + '</span>' +
      '<input class="monitor-control-slider" type="range"' +
        ' min="0" max="1" step="' + stepT + '" value="' + initT + '" />' +
      '<button class="monitor-control-curve" title="Edit slider response curve">≈</button>' +
      '<span class="monitor-control-value">' + fmtVal(cur) + '</span>';
    const slider = row.querySelector(".monitor-control-slider");
    const editBtn = row.querySelector(".monitor-control-curve");
    const val = row.querySelector(".monitor-control-value");
    slider.addEventListener("input", () => {
      const t = Number(slider.value);
      const v = sliderValueFromT(t, min, max, curve, tbl);
      val.textContent = fmtVal(v);
      const node = state.nodes.find(n => n.id === s.id);
      if (node) node.params.value = v;
      if (idx < 0 || !previewState.workletNode || previewState.state !== "playing") return;
      previewState.workletNode.port.postMessage({ type: "set", index: idx, value: v });
      // Mirror the new value to the touchscreen popup so its slider
      // tracks main-editor drags. No-op when no popup is connected.
      if (typeof _pushTouchControlsSnapshot === "function") _pushTouchControlsSnapshot();
    });
    editBtn.addEventListener("click", () => openRampModal("slider", s.id));
    wrap.appendChild(row);
  });
  // Push a fresh controls snapshot whenever the patch's controllable
  // nodes change (renderMonitorControls runs on add/delete/edit of
  // Slider+Button nodes). KeyboardIn add/remove doesn't go through
  // here but is uncommon enough that the popup tab-switch re-request
  // covers it.
  if (typeof _pushTouchControlsSnapshot === "function") _pushTouchControlsSnapshot();
}

/* Ramp editor — modal that picks a curve / shape for a Slider or
 * Button. Same modal, two option sets: sliders pick from
 * SLIDER_CURVES; buttons pick from a small list of envelope shapes
 * that the helperClass C++ already knows how to render. */
const CURVE_TABLE_SIZE = 64;
function defaultCurveTable() {
  const t = new Array(CURVE_TABLE_SIZE);
  for (let i = 0; i < CURVE_TABLE_SIZE; i++) t[i] = i / (CURVE_TABLE_SIZE - 1);
  return t;
}
const RAMP_CONFIG = {
  slider: {
    title: "Edit slider curve",
    note:  "Pick how the slider's drag position maps to its output. Linear is 1:1; log gives finer control at the bottom (good for frequency / amplitude); exp gives finer control at the top (good for time / decay); s-curve eases in and out; custom lets you draw the response.",
    paramKey: "curve",
    defaultKey: "linear",
    options: [
      { key: "linear", label: "linear" },
      { key: "log",    label: "log" },
      { key: "exp",    label: "exp" },
      { key: "sCurve", label: "s-curve" },
      { key: "custom", label: "custom ✎" }
    ]
  },
  button: {
    title: "Edit button gate shape",
    note:  "How the button's gate output looks when pressed. pulse is a single 1.f sample (default — drives gates via Schmitt threshold). linRamp + expDecay output a 1→0 envelope over the button's duration param (ms); custom lets you draw the envelope. Wire the gate into a Mul to gate audio amplitude with the envelope.",
    paramKey: "shape",
    defaultKey: "pulse",
    options: [
      { key: "pulse",    label: "pulse" },
      { key: "linRamp",  label: "linear" },
      { key: "expDecay", label: "exp decay" },
      { key: "custom",   label: "custom ✎" }
    ]
  },
  ramp: {
    title: "Edit ramp curve",
    note:  "Pick a preset or 'custom' to draw your own response. Linear is 1:1; log gives finer control at the bottom; exp gives finer control at the top; s-curve eases in and out; expSteep is a sharper exp. Custom samples 64 points across the input — the editor saves the table directly into the patch.",
    paramKey: "shape",
    defaultKey: "linear",
    options: [
      { key: "linear",    label: "linear" },
      { key: "log",       label: "log" },
      { key: "exp",       label: "exp" },
      { key: "sCurve",    label: "s-curve" },
      { key: "expSteep",  label: "exp steep" },
      { key: "custom",    label: "custom ✎" }
    ]
  }
};
// SVG path for a curve — t in 0..1 → y in 0..1 (1 at top of card,
// 0 at bottom). Returns an "M x,y L ..." path string scaled to the
// preview viewport. For Ramp's "custom" option, samples the saved
// curveTable; for the analytic presets, evaluates the matching fn.
function rampSvgPath(option, kind, w, h, node) {
  const samples = 32;
  const pts = [];
  // Helper closures pick the y value for a given t depending on kind+option.
  // "custom" reads the saved curveTable; everything else uses an analytic fn.
  const tblOrDefault = () =>
    (node && Array.isArray(node.params && node.params.curveTable) && node.params.curveTable.length)
      ? node.params.curveTable
      : defaultCurveTable();
  let yAt;
  if (option.key === "custom") {
    const tbl = tblOrDefault();
    const N = tbl.length;
    if (kind === "button") {
      // Buttons: x axis is "time since trigger" (0=trigger, 1=end).
      // The C++ helper indexes by (1 - t) so the LUT runs from
      // trigger->silence; mirror that here for an honest preview.
      yAt = t => {
        const fi = t * (N - 1);
        const i0 = Math.floor(fi), i1 = Math.min(N - 1, i0 + 1);
        return tbl[i0] * (1 - (fi - i0)) + tbl[i1] * (fi - i0);
      };
    } else {
      yAt = t => {
        const fi = t * (N - 1);
        const i0 = Math.floor(fi), i1 = Math.min(N - 1, i0 + 1);
        return tbl[i0] * (1 - (fi - i0)) + tbl[i1] * (fi - i0);
      };
    }
  } else if (kind === "slider") {
    const fn = (SLIDER_CURVES[option.key] || SLIDER_CURVES.linear).fwd;
    yAt = fn;
  } else if (kind === "button") {
    if (option.key === "pulse")        yAt = (t, i) => i === 0 ? 1 : 0;
    else if (option.key === "linRamp") yAt = t => 1 - t;
    else /* expDecay */                yAt = t => (1 - t) * (1 - t);
  } else /* ramp */ {
    if (option.key === "log")               yAt = t => Math.log10(1 + 9 * t);
    else if (option.key === "exp")          yAt = t => t * t;
    else if (option.key === "sCurve")       yAt = t => t * t * (3 - 2 * t);
    else if (option.key === "expSteep")     yAt = t => t * t * t * t;
    else /* linear */                       yAt = t => t;
  }
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = Math.max(0, Math.min(1, yAt(t, i)));
    const x = (t * w).toFixed(1);
    const py = ((1 - y) * h).toFixed(1);
    pts.push((i === 0 ? "M" : "L") + x + "," + py);
  }
  return pts.join(" ");
}

/* Drawable curve canvas. Rendered into the modal body when the user
 * picks "custom" on a ramp-editable node. Free-draw: click+drag sets
 * the y value at each sampled x position; gaps between consecutive
 * pointer samples are linearly interpolated so a fast drag still
 * fills the table cleanly. Reset restores identity. */
function buildCurveDrawPane(node) {
  const W = 480, H = 180;
  const pad = 8;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  const tbl = (node.params && Array.isArray(node.params.curveTable) && node.params.curveTable.length)
    ? node.params.curveTable.slice()
    : defaultCurveTable();
  if (!node.params) node.params = {};
  node.params.curveTable = tbl;
  const N = tbl.length;

  const pane = document.createElement("div");
  pane.className = "curve-draw-pane";
  pane.innerHTML =
    '<svg class="curve-draw-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + (pad + plotH * 0.5) + '" x2="' + (W - pad) + '" y2="' + (pad + plotH * 0.5) + '" />' +
      '<line class="curve-grid" x1="' + (pad + plotW * 0.5) + '" y1="' + pad + '" x2="' + (pad + plotW * 0.5) + '" y2="' + (H - pad) + '" />' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + pad + '" x2="' + (W - pad) + '" y2="' + pad + '" />' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '" />' +
      '<path class="curve-fill"  d="" />' +
      '<path class="curve-line"  d="" />' +
      '<text class="curve-axis-label" x="' + (pad + 2) + '" y="' + (pad + 10) + '">1.0</text>' +
      '<text class="curve-axis-label" x="' + (pad + 2) + '" y="' + (H - pad - 2) + '">0.0</text>' +
      '<text class="curve-axis-label" x="' + (W - pad - 22) + '" y="' + (H - pad - 2) + '">1.0</text>' +
    '</svg>' +
    '<div class="curve-draw-actions">' +
      '<button class="btn" id="btn-curve-reset">Reset to linear</button>' +
      '<button class="btn" id="btn-curve-smooth">Smooth</button>' +
      '<button class="btn primary" id="btn-curve-done">Done</button>' +
    '</div>';

  const svg = pane.querySelector(".curve-draw-svg");
  const fillPath = pane.querySelector(".curve-fill");
  const linePath = pane.querySelector(".curve-line");

  function tableToPathData() {
    const pts = [];
    for (let i = 0; i < N; i++) {
      const x = pad + (i / (N - 1)) * plotW;
      const y = pad + (1 - tbl[i]) * plotH;
      pts.push((i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1));
    }
    return pts.join(" ");
  }
  function refreshPaths() {
    const d = tableToPathData();
    linePath.setAttribute("d", d);
    fillPath.setAttribute("d", d + ` L ${pad + plotW},${pad + plotH} L ${pad},${pad + plotH} Z`);
  }
  function paintFromPointer(ev, prev) {
    const r = svg.getBoundingClientRect();
    const cx = ev.clientX - r.left;
    const cy = ev.clientY - r.top;
    // Map to plot coords (pad-aware, scaled to viewBox).
    const sx = W / r.width;
    const sy = H / r.height;
    const px = (cx * sx - pad) / plotW;       // 0..1 normalized x
    const py = 1 - (cy * sy - pad) / plotH;   // 0..1 normalized y, inverted
    const i = Math.round(Math.max(0, Math.min(1, px)) * (N - 1));
    const v = Math.max(0, Math.min(1, py));
    if (prev && prev.i !== undefined) {
      // Linear-interp fill between consecutive pointer samples so a
      // fast drag still writes every bin in between.
      const lo = Math.min(prev.i, i), hi = Math.max(prev.i, i);
      if (hi > lo) {
        const a = (lo === prev.i) ? prev.v : v;
        const b = (lo === prev.i) ? v : prev.v;
        for (let k = lo; k <= hi; k++) {
          const t = (k - lo) / (hi - lo);
          tbl[k] = a * (1 - t) + b * t;
        }
      } else {
        tbl[i] = v;
      }
    } else {
      tbl[i] = v;
    }
    refreshPaths();
    return { i, v };
  }
  let last = null;
  svg.addEventListener("pointerdown", ev => {
    ev.preventDefault();
    svg.setPointerCapture(ev.pointerId);
    last = paintFromPointer(ev, null);
    pushHistory("curve:" + node.id);
  });
  svg.addEventListener("pointermove", ev => {
    if (!last) return;
    last = paintFromPointer(ev, last);
  });
  function endStroke() {
    last = null;
    // Re-render the patch + monitor + active card preview so the
    // changes ripple through to codegen and the slider/button widget.
    renderCode(); renderJson();
    if (typeof renderMonitorControls === "function") renderMonitorControls();
    refreshActiveCardPreview();
  }
  svg.addEventListener("pointerup",     endStroke);
  svg.addEventListener("pointercancel", endStroke);
  svg.addEventListener("pointerleave", () => { if (last) endStroke(); });

  pane.querySelector("#btn-curve-reset").addEventListener("click", () => {
    pushHistory("curve:" + node.id);
    for (let i = 0; i < N; i++) tbl[i] = i / (N - 1);
    refreshPaths();
    renderCode(); renderJson();
    if (typeof renderMonitorControls === "function") renderMonitorControls();
    refreshActiveCardPreview();
  });
  pane.querySelector("#btn-curve-smooth").addEventListener("click", () => {
    pushHistory("curve:" + node.id);
    const nxt = tbl.slice();
    for (let i = 1; i < N - 1; i++) nxt[i] = (tbl[i - 1] + tbl[i] + tbl[i + 1]) / 3;
    for (let i = 0; i < N; i++) tbl[i] = nxt[i];
    refreshPaths();
    renderCode(); renderJson();
    if (typeof renderMonitorControls === "function") renderMonitorControls();
    refreshActiveCardPreview();
  });
  pane.querySelector("#btn-curve-done").addEventListener("click", closeRampModal);

  function refreshActiveCardPreview() {
    // Update the preview SVG inside the "custom" card so it mirrors
    // the drawing as the user paints.
    const grid = document.getElementById("ramp-grid");
    if (!grid) return;
    const customCard = grid.querySelector('.ramp-card[data-key="custom"]');
    if (!customCard) return;
    const path = customCard.querySelector("path");
    if (!path) return;
    const d = rampSvgPath({ key: "custom" }, "ramp", 220, 56, node);
    path.setAttribute("d", d);
  }

  refreshPaths();
  return pane;
}
/* =========================================================================
 * Per-node code editor — Sprint 5.node-edit
 *
 * Each node can carry a `.override` object that replaces fields on the
 * base TYPES entry (see defOf merge). This modal lets the user edit:
 *   - cppType (member declaration type)
 *   - helperClass (C++ source for the class)
 *   - ins / outs (port lists, including types + setter method names)
 *
 * Trigger paths:
 *   - "E" key with a single node selected (and no group selected)
 *   - "✎" button rendered on the bottom edge of the selected node
 *
 * All main hotkeys (V/D/W/Z/X/E/1..5/Space/Delete) are suppressed
 * while the modal is open via a capture-phase keydown listener.
 * ======================================================================= */

let _nodeEditTargetId = null;          // id of the node being edited
let _nodeEditorOpen   = false;         // gates main hotkeys
let _nodeEditSeed     = null;          // result of _seedNodeEditCode for the current open --
                                       // carries the synth's noSigArg hint + class name so
                                       // save can wire the override correctly.

/* CodeMirror instances for the two code panes, created lazily on
 * first modal open. Same options the User DSP editor uses so the
 * per-node editor has identical syntax colouring, line numbers,
 * bracket matching, and font / theme. */
let _nodeEditCmRaw  = null;
let _nodeEditCmGdsp = null;
function _initNodeEditCm() {
  if (typeof CodeMirror === "undefined") return;
  const cmOpts = {
    mode: "text/x-c++src",
    theme: "material-darker",
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    smartIndent: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    lineWrapping: false,
    extraKeys: {
      Tab:         cm => cm.execCommand("indentMore"),
      "Shift-Tab": cm => cm.execCommand("indentLess"),
      "Cmd-/":     "toggleComment",
      "Ctrl-/":    "toggleComment"
    }
  };
  if (!_nodeEditCmRaw) {
    const ta = document.getElementById("node-edit-code");
    if (ta) {
      _nodeEditCmRaw = CodeMirror.fromTextArea(ta, cmOpts);
      // Mirror to the underlying textarea so anything legacy that reads
      // .value still sees the current text.
      _nodeEditCmRaw.on("change", () => { ta.value = _nodeEditCmRaw.getValue(); });
    }
  }
  if (!_nodeEditCmGdsp) {
    const ta = document.getElementById("node-edit-gdsp");
    if (ta) {
      _nodeEditCmGdsp = CodeMirror.fromTextArea(ta, cmOpts);
      _nodeEditCmGdsp.on("change", () => { ta.value = _nodeEditCmGdsp.getValue(); });
    }
  }
}

// Get / set wrappers that prefer the CodeMirror instance when up,
// fall back to the raw textarea (e.g. CodeMirror failed to load).
function _getRawCode()    { return _nodeEditCmRaw  ? _nodeEditCmRaw.getValue()  : document.getElementById("node-edit-code").value; }
function _setRawCode(s)   { if (_nodeEditCmRaw)  _nodeEditCmRaw.setValue(s);   else document.getElementById("node-edit-code").value = s; }
function _getGdspCode()   { return _nodeEditCmGdsp ? _nodeEditCmGdsp.getValue() : document.getElementById("node-edit-gdsp").value; }
function _setGdspCode(s)  { if (_nodeEditCmGdsp) _nodeEditCmGdsp.setValue(s); else document.getElementById("node-edit-gdsp").value = s; }

const PORT_TYPE_OPTS_IN  = ["audio", "param", "gate", "clock", "texture", "transform", "mesh", "camera", "light", "environment"];
const PORT_TYPE_OPTS_OUT = ["audio", "param", "gate", "clock", "texture", "transform", "mesh", "camera", "light", "environment"];

/* Phase 7 §5.5.e -- TiledTerrain config popup. Mounts a modal
 * dynamically (no pre-defined HTML) so the feature stays contained
 * to TiledTerrain. Live-edits node.params + re-renders the editor
 * on every change so the user sees the mesh rebuild in the visual
 * preview as they dial knobs. Closing the modal pushes one history
 * entry covering the whole edit session (debounced rebuild not
 * needed at this scale -- the mesh cache key gates on params). */
/* §planet-spec Phase 7.d -- PlanetMap equirect painter popup. Modal
 * with a 720×360 equirect canvas + raise/lower brush controls. On
 * pointerdown/move the brush modifies cells.elevations within a
 * geodesic radius of the cursor's lat/lon; the canvas re-renders
 * from the modified cells; on modal close (or every stroke end) we
 * bump node._cellsVersion which invalidates the cubemap cache and
 * triggers a re-bake next time Planet reads heights.
 *
 * Equirect mapping: pixel (px, py) ∈ [0, W) × [0, H) →
 *   lon = (px + 0.5) / W * 2π - π        (left edge = -π, right = +π)
 *   lat = π/2 - (py + 0.5) / H * π       (top = +π/2, bottom = -π/2)
 *   unit_vec = (cos(lat)*sin(lon), sin(lat), cos(lat)*cos(lon))
 *
 * Pole-pinching: a constant-pixel brush radius covers a tiny patch
 * at the equator and a huge patch at the poles. We brush in
 * GEODESIC distance (angle from the cursor's unit_vec) so the
 * affected area on the sphere is uniform regardless of latitude. */
// §planet-spec Phase 7.f-ai -- preset and keyword tables hoisted to
// module scope so the offline prompt-tester (tools/pmap-prompt-tester.html)
// PMAP_AI_PRESETS / PMAP_AI_KEYWORDS removed 2026-05-21 -- the AI
// pipeline for planet maps was retired entirely. Landmass comes from
// brush + GeoJSON / Azgaar full-JSON import; features come from the
// brush mode picker (mountain / plain / valley / ridge / smooth).


/* §planet-spec Phase 7.e-climate -- Configure World modal. Mirrors
 * Azgaar's Configure World panel functionally: equator / north pole
 * / south pole temps, precipitation %, per-band wind direction.
 * Styled with the editor's CRT/phosphor aesthetic. */
function openClimateConfigModal(node, onApply) {
  if (!node) return;
  // Pull current config (merged with defaults). Sliders edit a
  // local copy; commit on Apply.
  const baseline = _resolveClimateConfig(node.params && node.params.climate);
  const draft = JSON.parse(JSON.stringify(baseline));

  // Remove any previous instance.
  let prev = document.getElementById("climate-config-modal");
  if (prev) prev.remove();
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id = "climate-config-modal";
  back.style.display = "flex";
  back.style.zIndex = 80;
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.width = "520px";
  modal.style.maxHeight = "90vh";
  modal.style.overflowY = "auto";

  // Wind band labels (top to bottom).
  const BAND_LABELS = ["60-90°N (polar)", "30-60°N (temperate)", "0-30°N (tropical)",
                       "0-30°S (tropical)", "30-60°S (temperate)", "60-90°S (polar)"];
  // Cardinal directions: degrees (0=N, 90=E, 180=S, 270=W).
  const WIND_DIRS = [
    { deg: 0,   name: "N",  arrow: "↑" },
    { deg: 45,  name: "NE", arrow: "↗" },
    { deg: 90,  name: "E",  arrow: "→" },
    { deg: 135, name: "SE", arrow: "↘" },
    { deg: 180, name: "S",  arrow: "↓" },
    { deg: 225, name: "SW", arrow: "↙" },
    { deg: 270, name: "W",  arrow: "←" },
    { deg: 315, name: "NW", arrow: "↖" }
  ];

  // Build a slider row: <label> [slider] [value-input] [unit]
  function sliderRowHTML(id, label, val, min, max, step, unit, tooltip) {
    return ''
      + '<div class="climate-row" title="' + (tooltip || "") + '">'
      + '  <label for="' + id + '">' + label + '</label>'
      + '  <input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">'
      + '  <input type="number" id="' + id + '-v" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">'
      + '  <span class="climate-unit">' + unit + '</span>'
      + '</div>';
  }

  let windRowsHTML = "";
  for (let i = 0; i < 6; i++) {
    windRowsHTML += '<div class="climate-wind-row">'
      + '<span class="climate-band">' + BAND_LABELS[i] + '</span>'
      + '<div class="climate-wind-buttons" data-band="' + i + '">';
    for (const d of WIND_DIRS) {
      windRowsHTML += '<button type="button" class="climate-wind-btn'
        + (d.deg === draft.winds[i] ? " active" : "")
        + '" data-band="' + i + '" data-deg="' + d.deg + '" title="' + d.name + '">' + d.arrow + '</button>';
    }
    windRowsHTML += '</div></div>';
  }

  modal.innerHTML = ''
    + '<style>'
    + '#climate-config-modal .modal-head { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid var(--border); }'
    + '#climate-config-modal .modal-title { font-family:var(--font-instr); letter-spacing:0.18em; color:var(--phosphor); text-transform:lowercase; font-size:13px; }'
    + '#climate-config-modal .climate-body { padding:14px 18px; font-family:var(--font-mono); font-size:11px; color:var(--text-2); }'
    + '#climate-config-modal .climate-section { font-family:var(--font-mono); color:var(--phosphor); font-size:10px; text-transform:uppercase; letter-spacing:0.1em; margin:14px 0 6px; padding-bottom:3px; border-bottom:1px dashed var(--border); }'
    + '#climate-config-modal .climate-section:first-child { margin-top:0; }'
    + '#climate-config-modal .climate-row { display:grid; grid-template-columns:130px 1fr 64px 30px; align-items:center; gap:8px; margin:5px 0; }'
    + '#climate-config-modal .climate-row label { color:var(--text-2); }'
    + '#climate-config-modal .climate-row input[type=range] { width:100%; }'
    + '#climate-config-modal .climate-row input[type=number] { width:60px; background:var(--surface); color:var(--text); border:1px solid var(--border); padding:3px 5px; font-family:var(--font-mono); font-size:11px; border-radius:3px; }'
    + '#climate-config-modal .climate-unit { color:var(--text-3); font-size:10px; text-align:left; }'
    + '#climate-config-modal .climate-wind-row { display:grid; grid-template-columns:160px 1fr; align-items:center; gap:8px; margin:4px 0; }'
    + '#climate-config-modal .climate-band { color:var(--text-2); font-size:11px; }'
    + '#climate-config-modal .climate-wind-buttons { display:flex; gap:2px; }'
    + '#climate-config-modal .climate-wind-btn { width:24px; height:24px; padding:0; background:var(--surface); color:var(--text-3); border:1px solid var(--border); border-radius:2px; font-family:var(--font-mono); font-size:14px; cursor:pointer; transition:all 0.1s; }'
    + '#climate-config-modal .climate-wind-btn:hover { color:var(--text); border-color:var(--phosphor); }'
    + '#climate-config-modal .climate-wind-btn.active { background:var(--phosphor); color:#000; border-color:var(--phosphor); }'
    + '#climate-config-modal .climate-footer { display:flex; gap:8px; justify-content:space-between; padding:10px 14px; border-top:1px solid var(--border); }'
    + '</style>'
    + '<div class="modal-head">'
    + '  <span class="modal-title">configure world / climate</span>'
    + '  <button class="btn modal-x" id="climate-x" type="button">×</button>'
    + '</div>'
    + '<div class="climate-body">'
    + '  <div class="climate-section">temperature</div>'
    + sliderRowHTML("clim-eq",  "Equator",        draft.equatorC,    -10, 50, 1, "°C", "Sea-level temperature at the equator")
    + sliderRowHTML("clim-np",  "North Pole",     draft.northPoleC,  -60, 30, 1, "°C", "Sea-level temperature at the north pole")
    + sliderRowHTML("clim-sp",  "South Pole",     draft.southPoleC,  -60, 30, 1, "°C", "Sea-level temperature at the south pole")
    + sliderRowHTML("clim-tn",  "Tropic N edge",  draft.tropicNorth,   0, 30, 1, "°lat", "Where the equatorial heat-belt ends going north (Earth ≈ 23°N)")
    + sliderRowHTML("clim-ts",  "Tropic S edge",  draft.tropicSouth, -30,  0, 1, "°lat", "Where the equatorial heat-belt ends going south (Earth ≈ -23°S)")
    + sliderRowHTML("clim-lapse", "Lapse rate",   draft.lapseRateC,    0, 12, 0.1, "°C/km", "How fast temperature drops with altitude (Earth ≈ 6.5°C/km)")
    + sliderRowHTML("clim-peak",  "Peak altitude",draft.peakAltM,   1000, 20000, 100, "m",  "Altitude where the lapse rate saturates -- decouples climate from heightScale exaggeration")
    + '  <div class="climate-section">precipitation</div>'
    + sliderRowHTML("clim-prec", "Precipitation", draft.precipPct,  10, 300, 1, "%", "Global humidity multiplier on the wind-sim base budget")
    + '  <div class="climate-section">winds (where wind is blowing TOWARD per band)</div>'
    + windRowsHTML
    + '</div>'
    + '<div class="climate-footer">'
    + '  <button class="btn" id="clim-defaults" type="button">restore defaults</button>'
    + '  <div style="display:flex;gap:8px;">'
    + '    <button class="btn" id="clim-cancel" type="button">cancel</button>'
    + '    <button class="btn" id="clim-apply" type="button" style="background:var(--phosphor);color:#000;border-color:var(--phosphor);">apply</button>'
    + '  </div>'
    + '</div>';
  back.appendChild(modal);
  document.body.appendChild(back);

  // Helper: wire a slider + number input pair to update draft[key].
  function wireSliderPair(rangeId, key, parser) {
    const r = modal.querySelector("#" + rangeId);
    const n = modal.querySelector("#" + rangeId + "-v");
    const p = parser || ((v) => +v);
    r.addEventListener("input", () => { draft[key] = p(r.value); n.value = r.value; });
    n.addEventListener("input", () => {
      let v = p(n.value);
      const min = parseFloat(r.min), max = parseFloat(r.max);
      if (v < min) v = min; else if (v > max) v = max;
      draft[key] = v;
      r.value = v;
    });
  }
  wireSliderPair("clim-eq",    "equatorC");
  wireSliderPair("clim-np",    "northPoleC");
  wireSliderPair("clim-sp",    "southPoleC");
  wireSliderPair("clim-tn",    "tropicNorth");
  wireSliderPair("clim-ts",    "tropicSouth");
  wireSliderPair("clim-lapse", "lapseRateC", v => parseFloat(v));
  wireSliderPair("clim-peak",  "peakAltM");
  wireSliderPair("clim-prec",  "precipPct");

  // Wire wind direction buttons -- one selected per band.
  modal.querySelectorAll(".climate-wind-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const band = +btn.dataset.band;
      const deg = +btn.dataset.deg;
      draft.winds[band] = deg;
      // Update active state for this band.
      modal.querySelectorAll('.climate-wind-btn[data-band="' + band + '"]').forEach(b => {
        if (+b.dataset.deg === deg) b.classList.add("active");
        else                        b.classList.remove("active");
      });
    });
  });

  // Restore defaults: copy from _PLANET_CLIMATE_DEFAULTS into draft + UI.
  modal.querySelector("#clim-defaults").addEventListener("click", () => {
    const D = _PLANET_CLIMATE_DEFAULTS;
    draft.equatorC = D.equatorC;        modal.querySelector("#clim-eq").value    = D.equatorC;    modal.querySelector("#clim-eq-v").value    = D.equatorC;
    draft.northPoleC = D.northPoleC;    modal.querySelector("#clim-np").value    = D.northPoleC;  modal.querySelector("#clim-np-v").value    = D.northPoleC;
    draft.southPoleC = D.southPoleC;    modal.querySelector("#clim-sp").value    = D.southPoleC;  modal.querySelector("#clim-sp-v").value    = D.southPoleC;
    draft.tropicNorth = D.tropicNorth;  modal.querySelector("#clim-tn").value    = D.tropicNorth; modal.querySelector("#clim-tn-v").value    = D.tropicNorth;
    draft.tropicSouth = D.tropicSouth;  modal.querySelector("#clim-ts").value    = D.tropicSouth; modal.querySelector("#clim-ts-v").value    = D.tropicSouth;
    draft.lapseRateC = D.lapseRateC;    modal.querySelector("#clim-lapse").value = D.lapseRateC;  modal.querySelector("#clim-lapse-v").value = D.lapseRateC;
    draft.peakAltM = D.peakAltM;        modal.querySelector("#clim-peak").value  = D.peakAltM;    modal.querySelector("#clim-peak-v").value  = D.peakAltM;
    draft.precipPct = D.precipPct;      modal.querySelector("#clim-prec").value  = D.precipPct;   modal.querySelector("#clim-prec-v").value  = D.precipPct;
    draft.winds = D.winds.slice();
    modal.querySelectorAll(".climate-wind-btn").forEach(b => {
      const band = +b.dataset.band;
      const deg  = +b.dataset.deg;
      if (deg === draft.winds[band]) b.classList.add("active");
      else                           b.classList.remove("active");
    });
  });

  function close() { back.remove(); }
  modal.querySelector("#climate-x").addEventListener("click", close);
  modal.querySelector("#clim-cancel").addEventListener("click", close);
  modal.querySelector("#clim-apply").addEventListener("click", () => {
    if (!node.params) node.params = {};
    node.params.climate = draft;
    if (typeof onApply === "function") onApply(draft);
    close();
  });
  back.addEventListener("click", (ev) => { if (ev.target === back) close(); });
}


function openPlanetMapEditor(nodeId) {
  const node = state && state.nodes && state.nodes.find(n => n && n.id === nodeId);
  if (!node || node.type !== "PlanetMap") return;
  const cells = _ensurePlanetMapCells(node);
  if (!cells) return;
  const hash = node._cellsHash;
  pushHistory("planet-map-edit:open");

  let prev = document.getElementById("planet-map-modal");
  if (prev) prev.remove();
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id        = "planet-map-modal";
  back.style.display = "flex";
  back.style.zIndex = 60;
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.width = "780px";
  modal.style.maxHeight = "90vh";
  modal.style.overflowY = "auto";
  modal.innerHTML =
    '<div class="modal-head">' +
      '<span class="modal-title" style="font-family: var(--font-instr); letter-spacing: 0.18em; color: var(--phosphor); text-transform: lowercase;">planet map · ' + node.type + '#' + node.id + ' · ' + cells.count + ' cells</span>' +
      '<button class="btn modal-x" id="pmap-close" type="button">×</button>' +
    '</div>' +
    '<div id="pmap-body" style="padding: 12px 16px 16px;"></div>';
  back.appendChild(modal);
  document.body.appendChild(back);
  const body = modal.querySelector("#pmap-body");

  // Sprint 10-1d: tab system removed. Sprint 8-4's biomes-tab
  // exposed the per-biome detail-noise editor (amp / freq / shape
  // / texture style), but Phase 10 retires per-vertex detail noise
  // entirely -- terrain comes from the cubemap-baked tectonic
  // heightmap + hydraulic erosion + climate-derived biome color,
  // not from per-biome procedural noise. The biome editor served
  // an architecture we're moving past, so the whole tab is gone.
  // The painter (canvas + brush + help) is now the modal's only
  // content, appended directly to body.
  const painterPanel = document.createElement("div");
  painterPanel.id = "pmap-tab-painter";
  body.appendChild(painterPanel);

  // Canvas (equirect view of the planet's elevation, cells flat-shaded).
  // Wrapped in a scroll container so it can be zoomed via CSS transform.
  const W = 720, H = 360;
  const canvasWrap = document.createElement("div");
  canvasWrap.style.cssText =
    "width:720px;height:360px;overflow:auto;background:rgba(8,12,20,0.85);" +
    "border:1px solid var(--border);border-radius:3px;display:block;margin-bottom:10px;" +
    "scrollbar-width:thin;";
  const canvasInner = document.createElement("div");
  canvasInner.style.cssText = "width:720px;height:360px;transform-origin:0 0;";
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  canvas.style.cssText =
    "width:720px;height:360px;cursor:crosshair;image-rendering:pixelated;display:block;";
  canvasInner.appendChild(canvas);
  canvasWrap.appendChild(canvasInner);
  painterPanel.appendChild(canvasWrap);
  const ctx = canvas.getContext("2d");

  // Controls.
  const ctrls = document.createElement("div");
  ctrls.style.cssText =
    "display:flex;align-items:center;gap:14px;flex-wrap:wrap;" +
    "font-family:var(--font-mono);font-size:11px;color:var(--text-2);" +
    "padding:6px 0;";
  ctrls.innerHTML =
    '<label>brush&nbsp;<input type="range" id="pmap-size" min="2" max="40" value="8" step="1" style="vertical-align:middle"><span id="pmap-size-v" style="display:inline-block;min-width:26px;text-align:right">8°</span></label>' +
    '<label>strength&nbsp;<input type="range" id="pmap-str" min="1" max="100" value="25" step="1" style="vertical-align:middle"><span id="pmap-str-v" style="display:inline-block;min-width:30px;text-align:right">0.025</span></label>' +
    '<label><input type="radio" name="pmap-mode" value="raise" checked> raise</label>' +
    '<label><input type="radio" name="pmap-mode" value="lower"> lower</label>' +
    '<label title="pull cells toward local average"><input type="radio" name="pmap-mode" value="smooth"> smooth</label>' +
    '<label title="raise toward mountain height (0.85)"><input type="radio" name="pmap-mode" value="mountain"> mountain</label>' +
    '<label title="raise to plain height (0.30) -- flattens mountains, lifts coast"><input type="radio" name="pmap-mode" value="plain"> plain</label>' +
    '<label title="carve into mountains toward valley height (0.22) without flipping to ocean"><input type="radio" name="pmap-mode" value="valley"> valley</label>' +
    '<label title="like mountain but center spikes higher than edges"><input type="radio" name="pmap-mode" value="ridge"> ridge</label>' +
    '<span style="border-left:1px solid var(--border);height:18px;margin:0 2px;"></span>' +
    '<button class="btn" id="pmap-undo" type="button" style="padding:3px 8px;" title="Undo last stroke (Ctrl+Z)">↶ undo</button>' +
    '<button class="btn" id="pmap-redo" type="button" style="padding:3px 8px;" title="Redo (Ctrl+Y)">↷ redo</button>' +
    '<span style="border-left:1px solid var(--border);height:18px;margin:0 2px;"></span>' +
    '<button class="btn" id="pmap-zoom-out" type="button" style="padding:3px 8px;" title="Zoom out">−</button>' +
    '<span id="pmap-zoom-v" style="display:inline-block;min-width:34px;text-align:center;">100%</span>' +
    '<button class="btn" id="pmap-zoom-in" type="button" style="padding:3px 8px;" title="Zoom in">+</button>' +
    '<button class="btn" id="pmap-zoom-fit" type="button" style="padding:3px 8px;" title="Fit (1:1)">fit</button>' +
    '<span style="border-left:1px solid var(--border);height:18px;margin:0 2px;"></span>' +
    '<button class="btn" id="pmap-revert" type="button" style="padding:3px 10px;">revert</button>' +
    '<button class="btn" id="pmap-climate" type="button" style="padding:3px 10px;">show climate</button>' +
    '<button class="btn" id="pmap-climate-config" type="button" style="padding:3px 10px;" title="Configure climate (equator/pole temperatures, precipitation, winds)">⚙ world</button>' +
    '<button class="btn" id="pmap-geojson" type="button" style="padding:3px 10px;" title="Import an Azgaar FMG file (.geojson Cells export or full .json) to stamp its exact landmass + heights onto this planet">import azgaar</button>' +
    '<input type="file" id="pmap-geojson-file" accept=".geojson,.json,application/geo+json,application/json" style="display:none">';
  painterPanel.appendChild(ctrls);

  // AI panel removed 2026-05-21 -- AI keyword features retired.
  const helpRow = document.createElement("div");
  helpRow.style.cssText =
    "font-family:var(--font-mono);font-size:10px;color:var(--text-3);margin-top:6px;line-height:1.5;";
  helpRow.innerHTML =
    "drag on the canvas to paint. brush radius is in degrees of arc on the sphere " +
    "(equator: 1° ≈ 111km on earth). closing the modal bakes the modified cells " +
    "into the cubemap; the planet picks up the change on the next chunk rebuild.";
  painterPanel.appendChild(helpRow);

  // Sprint 10-1d: Biomes tab content (per-biome detail noise editor
  // + texture browser) removed. Phase 10 doesn't run per-vertex
  // detail noise -- terrain comes from cubemap + hydraulic erosion
  // (10-2) + continuous climate (10-3), and biome color is derived
  // per-fragment from temperature+moisture+slope (10-4). The per-
  // biome amp/freq/shape sliders + texture-style picker were
  // editing parameters that the renderer no longer consumes.

  // Locked continent target (shift-click on the map). When set, the
  // next re-roll places the template's first cap here.
  let lockedCenter = null;  // { lat, lon } in degrees

  // Snapshot for revert.
  const elevSnapshot = new Float32Array(cells.elevations);

  // Pre-compute pixel → nearest-cell mapping. ~260k queries × ~50
  // dot products via the spatial hash = ~13M ops, runs in 50-150ms on
  // a desktop. Done once on open; reads from it per-render are O(1).
  const pixelToCell = new Int32Array(W * H);
  const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
  for (let py = 0; py < H; py++) {
    const lat = Math.PI * 0.5 - ((py + 0.5) / H) * Math.PI;
    const clat = Math.cos(lat), slat = Math.sin(lat);
    for (let px = 0; px < W; px++) {
      const lon = ((px + 0.5) / W) * (Math.PI * 2) - Math.PI;
      const ux = clat * Math.sin(lon);
      const uy = slat;
      const uz = clat * Math.cos(lon);
      pixelToCell[py * W + px] = _findNearestCell(cells, hash, ux, uy, uz);
    }
  }
  const dtMs = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;
  console.log("[planet-map] painter pixelToCell map built in " + dtMs.toFixed(0) + "ms");

  // §planet-spec Phase 7.e -- sync painter seaLevel with the wired
  // PlanetMesh's seaLevel so rivers / biomes / coastlines match what
  // the 3D view shows. Falls back to 0.55 (matches the Foot-to-Orbit
  // demo's default) when no PlanetMesh consumes this PlanetMap.
  let seaLevel = 0.55;
  if (state && Array.isArray(state.edges)) {
    for (let i = 0; i < state.edges.length; i++) {
      const e = state.edges[i];
      if (!e || !e.from || !e.to) continue;
      if (e.from.node !== node.id || e.from.port !== "heightmap") continue;
      const consumer = state.nodes.find(n => n && n.id === e.to.node);
      if (consumer && consumer.type === "PlanetMesh" && typeof consumer.params.seaLevel === "number") {
        seaLevel = consumer.params.seaLevel;
        break;
      }
    }
  }

  // Render: walk pixels, look up cell elevation, write RGB color.
  // "show climate" toggle (button below) switches between the
  // elevation-gradient view (default) and the biome + river overlay
  // -- same colors PlanetMesh renders in 3D (Azgaar's biome palette
  // + flux-modulated river blue).
  let showClimate = false;
  const imageData = ctx.createImageData(W, H);
  const RIVER_BLUE = [0.20, 0.45, 0.75];
  const RIVER_BIG  = [0.15, 0.32, 0.62];
  function render() {
    const data = imageData.data;
    const haveBiome = showClimate && cells.biome;
    const haveLakes = showClimate && cells.lake;
    // Rivers are NO LONGER drawn cell-by-cell -- we paint them
    // afterward as proper splines (see below). Lakes and biomes
    // still render per-pixel.
    for (let i = 0; i < W * H; i++) {
      const cellIdx = pixelToCell[i];
      const elev = cells.elevations[cellIdx];
      let c;
      if (haveLakes && cells.lake[cellIdx]) {
        c = PLANET_BIOMES_COLORS[0];          // closed-basin lake = marine blue
      } else if (haveBiome) {
        c = PLANET_BIOMES_COLORS[cells.biome[cellIdx]];
      } else {
        c = _planetColorForHeight(elev, seaLevel);
      }
      const k = i * 4;
      data[k    ] = Math.max(0, Math.min(255, Math.round(c[0] * 255)));
      data[k + 1] = Math.max(0, Math.min(255, Math.round(c[1] * 255)));
      data[k + 2] = Math.max(0, Math.min(255, Math.round(c[2] * 255)));
      data[k + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    // §planet-spec Phase 7.e-rivers -- spline river overlay. Each
    // river in cells.riverPaths is a chain of cell indices. We
    // project each cell's center to canvas (px, py) via its 3D
    // unit-sphere position, then stroke a smoothed polyline using
    // quadraticCurveTo (Bezier midpoint smoothing). Stroke width
    // scales with the mouthFlux, so a small tributary draws thin
    // and a major river draws thicker. Date-line crossings break
    // the path (otherwise we'd stroke across the whole canvas).
    if (showClimate && cells.riverPaths && cells.riverPaths.length > 0) {
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(35, 80, 140, 0.92)";
      for (const river of cells.riverPaths) {
        const path = river.cells;
        if (!path || path.length < 2) continue;
        const w = Math.max(0.6, Math.min(4.0, Math.sqrt((river.mouthFlux || 30) / 30)));
        ctx.lineWidth = w;
        const pts = new Array(path.length);
        for (let i = 0; i < path.length; i++) {
          const ci = path[i];
          const cx = cells.positions[ci*3];
          const cy = cells.positions[ci*3+1];
          const cz = cells.positions[ci*3+2];
          const lat = Math.asin(Math.max(-1, Math.min(1, cy))) * 180 / Math.PI;
          const lon = Math.atan2(cz, cx) * 180 / Math.PI;
          pts[i] = [(lon + 180) / 360 * W, (90 - lat) / 180 * H];
        }
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          const cur = pts[i], nxt = pts[i + 1];
          // Date-line crossing: stroke + start a new sub-path.
          if (Math.abs(cur[0] - nxt[0]) > W * 0.5 || Math.abs(cur[0] - pts[i-1][0]) > W * 0.5) {
            ctx.stroke(); ctx.beginPath(); ctx.moveTo(cur[0], cur[1]);
            continue;
          }
          const mx = (cur[0] + nxt[0]) * 0.5;
          const my = (cur[1] + nxt[1]) * 0.5;
          ctx.quadraticCurveTo(cur[0], cur[1], mx, my);
        }
        // Final segment
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        if (Math.abs(prev[0] - last[0]) <= W * 0.5) ctx.lineTo(last[0], last[1]);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Draw the locked continent-target as a crosshair on top so the
    // user sees where re-roll will place the first cap.
    if (lockedCenter) {
      const py = Math.floor(((90 - lockedCenter.lat) / 180) * H);
      const px = Math.floor(((lockedCenter.lon + 180) / 360) * W);
      ctx.save();
      ctx.strokeStyle = "rgba(255, 220, 90, 0.95)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px - 8, py); ctx.lineTo(px + 8, py);
      ctx.moveTo(px, py - 8); ctx.lineTo(px, py + 8); ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
  render();

  // Brush controls state.
  let brushRadiusDeg = 8;
  let brushStrength = 0.025;
  let mode = "raise";
  let painting = false;
  let dirty = false;
  const sizeIn = modal.querySelector("#pmap-size");
  const sizeV  = modal.querySelector("#pmap-size-v");
  const strIn  = modal.querySelector("#pmap-str");
  const strV   = modal.querySelector("#pmap-str-v");
  sizeIn.addEventListener("input", () => {
    brushRadiusDeg = +sizeIn.value;
    sizeV.textContent = brushRadiusDeg + "°";
  });
  strIn.addEventListener("input", () => {
    brushStrength = (+strIn.value) / 1000;
    strV.textContent = brushStrength.toFixed(3);
  });
  modal.querySelectorAll('input[name="pmap-mode"]').forEach(r => {
    r.addEventListener("change", () => { if (r.checked) mode = r.value; });
  });

  // Undo / redo stacks of Float32Array snapshots. Each "stroke"
  // (pointerdown -> pointerup) or whole-canvas operation (revert,
  // import) pushes ONE snapshot of cells.elevations to undoStack.
  // Cap depth so memory doesn't blow up at large N.
  const UNDO_MAX = 30;
  const undoStack = [];
  const redoStack = [];
  function pushUndo() {
    undoStack.push(new Float32Array(cells.elevations));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;  // any new edit clears the redo history
    updateUndoUI();
  }
  function applySnapshot(snap) {
    for (let i = 0; i < cells.elevations.length; i++) cells.elevations[i] = snap[i];
    node._cellsVersion = ((typeof node._cellsVersion === "number") ? node._cellsVersion : 0) + 1;
    dirty = true;
    render();
  }
  function doUndo() {
    if (undoStack.length === 0) return;
    redoStack.push(new Float32Array(cells.elevations));
    if (redoStack.length > UNDO_MAX) redoStack.shift();
    applySnapshot(undoStack.pop());
    updateUndoUI();
  }
  function doRedo() {
    if (redoStack.length === 0) return;
    undoStack.push(new Float32Array(cells.elevations));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    applySnapshot(redoStack.pop());
    updateUndoUI();
  }
  const undoBtn = modal.querySelector("#pmap-undo");
  const redoBtn = modal.querySelector("#pmap-redo");
  function updateUndoUI() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
    undoBtn.title = "Undo last stroke (Ctrl+Z) [" + undoStack.length + "]";
    redoBtn.title = "Redo (Ctrl+Y) [" + redoStack.length + "]";
  }
  undoBtn.addEventListener("click", doUndo);
  redoBtn.addEventListener("click", doRedo);
  updateUndoUI();
  // Keyboard shortcuts -- scoped to the modal so they don't interfere
  // with other editor inputs. We attach to the modal-backdrop which
  // has focus while the modal is open.
  const kbHandler = (ev) => {
    if (!document.body.contains(back)) return;
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === "z" && !ev.shiftKey) {
      ev.preventDefault(); doUndo();
    } else if ((ev.ctrlKey || ev.metaKey) && (k === "y" || (k === "z" && ev.shiftKey))) {
      ev.preventDefault(); doRedo();
    }
  };
  window.addEventListener("keydown", kbHandler);

  // Zoom controls. The canvas lives inside canvasInner which we
  // CSS-transform; canvasWrap is the scroll container. Pointer
  // coordinate math uses getBoundingClientRect() which already
  // accounts for the CSS scale.
  const ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8];
  let zoomIdx = 0;
  const zoomVSpan = modal.querySelector("#pmap-zoom-v");
  function applyZoom() {
    const z = ZOOM_LEVELS[zoomIdx];
    canvasInner.style.transform = "scale(" + z + ")";
    canvasInner.style.width  = (W * z) + "px";
    canvasInner.style.height = (H * z) + "px";
    zoomVSpan.textContent = Math.round(z * 100) + "%";
  }
  modal.querySelector("#pmap-zoom-in").addEventListener("click", () => {
    if (zoomIdx < ZOOM_LEVELS.length - 1) { zoomIdx++; applyZoom(); }
  });
  modal.querySelector("#pmap-zoom-out").addEventListener("click", () => {
    if (zoomIdx > 0) { zoomIdx--; applyZoom(); }
  });
  modal.querySelector("#pmap-zoom-fit").addEventListener("click", () => {
    zoomIdx = 0; applyZoom();
    canvasWrap.scrollLeft = 0; canvasWrap.scrollTop = 0;
  });
  // Wheel zoom on canvas: shift+wheel zooms; wheel alone scrolls.
  canvasWrap.addEventListener("wheel", (ev) => {
    if (!ev.shiftKey) return;
    ev.preventDefault();
    if (ev.deltaY < 0 && zoomIdx < ZOOM_LEVELS.length - 1) { zoomIdx++; applyZoom(); }
    else if (ev.deltaY > 0 && zoomIdx > 0)                  { zoomIdx--; applyZoom(); }
  }, { passive: false });

  modal.querySelector("#pmap-revert").addEventListener("click", () => {
    pushUndo();
    for (let i = 0; i < cells.elevations.length; i++) cells.elevations[i] = elevSnapshot[i];
    dirty = true;
    node._cellsVersion = ((typeof node._cellsVersion === "number") ? node._cellsVersion : 0) + 1;
    render();
  });

  // Climate toggle. First click computes climate + rivers (~50-200ms,
  // cached on the node), turns on biome+river overlay; subsequent
  // clicks just toggle visibility. Painting / template re-rolls
  // invalidate the cache via _cellsVersion so the next "show climate"
  // recomputes.
  const climateBtn = modal.querySelector("#pmap-climate");
  climateBtn.addEventListener("click", () => {
    if (!showClimate) {
      _ensurePlanetClimate(node, seaLevel);
      _ensurePlanetRivers(node, seaLevel);
      showClimate = true;
      climateBtn.textContent = "hide climate";
    } else {
      showClimate = false;
      climateBtn.textContent = "show climate";
    }
    render();
  });

  // Configure World -- climate settings modal (Azgaar parity).
  modal.querySelector("#pmap-climate-config").addEventListener("click", () => {
    openClimateConfigModal(node, () => {
      // Climate config changed; cache key now mismatches. Force a
      // recompute + redraw + invalidate the cubemap so PlanetMesh
      // picks up the new biomes on the next chunk rebuild.
      node._climateKey = null;
      if (showClimate) {
        _ensurePlanetClimate(node, seaLevel);
        _ensurePlanetRivers(node, seaLevel);
        render();
      }
      dirty = true;
      pushHistory("planet-map-edit:climate");
    });
  });

  // Import GeoJSON: stamps an Azgaar FMG Cells GeoJSON's landmass
  // onto this planet's cell graph. Deterministic alternative to AI
  // generation -- the dropped file's land polygons become this
  // planet's landmass shape exactly.
  const geoBtn = modal.querySelector("#pmap-geojson");
  const geoFileIn = modal.querySelector("#pmap-geojson-file");
  geoBtn.addEventListener("click", () => geoFileIn.click());
  geoFileIn.addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    geoBtn.disabled = true;
    const origLabel = geoBtn.textContent;
    geoBtn.textContent = "...";
    try {
      const text = await file.text();
      const geojson = JSON.parse(text);
      pushUndo();  // snapshot pre-import so Ctrl+Z reverts
      const stats = await _planetStampLandmass(
        geojson, cells, node._cellNeighbors, node._cellNeighborsK, seaLevel,
        (msg) => { geoBtn.textContent = msg.length > 22 ? msg.slice(0, 20) + "…" : msg; }
      );
      dirty = true;
      // Invalidate climate / rivers cache, then redraw.
      node._cellsVersion = ((typeof node._cellsVersion === "number") ? node._cellsVersion : 0) + 1;
      render();
      console.log("[planet-map] stamped GeoJSON: "
        + stats.landFeatures + "/" + stats.featuresProcessed + " land features, "
        + (stats.landFraction * 100).toFixed(1) + "% land, "
        + "raster=" + stats.rasterMs + "ms stamp=" + stats.stampMs + "ms");
      geoBtn.textContent = "stamped " + (stats.landFraction * 100).toFixed(0) + "% land";
      setTimeout(() => { geoBtn.textContent = origLabel; }, 3000);
    } catch (e) {
      console.error("[planet-map] geojson import failed:", e);
      geoBtn.textContent = "error";
      alert("GeoJSON import failed: " + e.message);
      setTimeout(() => { geoBtn.textContent = origLabel; }, 3000);
    } finally {
      geoBtn.disabled = false;
      // Reset the input so the same file can be picked again.
      geoFileIn.value = "";
    }
  });

  // Apply one brush stamp at pixel (px, py).
  // Brush modes -- each mode is its own elevation transform applied
  // to cells under the brush (with smoothstep falloff from center).
  // The seaLevel constant here matches Azgaar's 0..1 logical scale
  // (sea level at 0.20) which the postDSL piecewise remap converts
  // to the user's final seaLevel. Target heights are in the same
  // scale so brushes work consistently across cell counts.
  function stamp(px, py) {
    const lat = Math.PI * 0.5 - ((py + 0.5) / H) * Math.PI;
    const lon = ((px + 0.5) / W) * (Math.PI * 2) - Math.PI;
    const clat = Math.cos(lat), slat = Math.sin(lat);
    const cx = clat * Math.sin(lon);
    const cy = slat;
    const cz = clat * Math.cos(lon);
    const radRad = brushRadiusDeg * Math.PI / 180;
    const cosThresh = Math.cos(radRad);

    // Pass 1: collect cells inside the brush with their falloff weights.
    // For modes that average or pull toward a target (smooth, mountain,
    // plain, valley, ridge) we need to look at the full population
    // before writing -- so a 2-pass approach (gather then apply).
    const hits = []; // [{ i, weight }]
    for (let i = 0; i < cells.count; i++) {
      const ix = i * 3;
      const dot = cx * cells.positions[ix] + cy * cells.positions[ix + 1] + cz * cells.positions[ix + 2];
      if (dot < cosThresh) continue;
      const t = (dot - cosThresh) / Math.max(1e-6, 1 - cosThresh);
      const fall = t * t * (3 - 2 * t);  // smoothstep
      hits.push({ i, w: fall });
    }
    if (hits.length === 0) { dirty = true; render(); return; }

    // Per-mode application.
    if (mode === "raise" || mode === "lower") {
      const sign = (mode === "raise") ? 1 : -1;
      for (const h of hits) {
        cells.elevations[h.i] = Math.max(0, Math.min(1, cells.elevations[h.i] + sign * brushStrength * h.w));
      }
    } else if (mode === "smooth") {
      // Pull each hit toward the local average. Falloff scales the pull.
      let sum = 0;
      for (const h of hits) sum += cells.elevations[h.i];
      const avg = sum / hits.length;
      for (const h of hits) {
        const cur = cells.elevations[h.i];
        cells.elevations[h.i] = cur + (avg - cur) * brushStrength * 10 * h.w;
      }
    } else if (mode === "mountain") {
      // Raise toward height 0.85 (mountain) with center bias.
      const TARGET = 0.85;
      for (const h of hits) {
        const cur = cells.elevations[h.i];
        if (cur >= TARGET) continue;
        const pull = (TARGET - cur) * brushStrength * 4 * h.w;
        cells.elevations[h.i] = Math.min(1, cur + pull);
      }
    } else if (mode === "plain") {
      // Pull toward height 0.30 (slightly above sealevel). Lowers
      // mountains, raises ocean cells just barely above water.
      const TARGET = 0.30;
      for (const h of hits) {
        const cur = cells.elevations[h.i];
        const pull = (TARGET - cur) * brushStrength * 4 * h.w;
        cells.elevations[h.i] = Math.max(0, Math.min(1, cur + pull));
      }
    } else if (mode === "valley") {
      // Pull toward height 0.22 (just barely above sealevel). Carves
      // valleys into mountains without flipping land to ocean.
      const TARGET = 0.22;
      for (const h of hits) {
        const cur = cells.elevations[h.i];
        if (cur <= TARGET) continue;
        const pull = (cur - TARGET) * brushStrength * 4 * h.w;
        cells.elevations[h.i] = Math.max(0, cur - pull);
      }
    } else if (mode === "ridge") {
      // Like mountain but more aggressive in the center, no effect at edges.
      // Concentric falloff: cells nearer center get pulled to higher targets.
      for (const h of hits) {
        const target = 0.30 + 0.55 * h.w;  // 0.30 at edge, 0.85 at center
        const cur = cells.elevations[h.i];
        if (cur >= target) continue;
        const pull = (target - cur) * brushStrength * 4;
        cells.elevations[h.i] = Math.min(1, cur + pull);
      }
    }
    dirty = true;
    render();
  }

  // Pointer events. Shift-click sets the continent-target lock for
  // re-roll instead of painting -- so the next template apply places
  // its first cap where you clicked. Subsequent re-rolls keep using
  // the locked point until "clear target" or another shift-click.
  canvas.addEventListener("pointerdown", (ev) => {
    const r = canvas.getBoundingClientRect();
    const px = Math.floor((ev.clientX - r.left) / r.width * W);
    const py = Math.floor((ev.clientY - r.top) / r.height * H);
    canvas.setPointerCapture(ev.pointerId);
    // Snapshot BEFORE this stroke so Ctrl+Z restores the pre-stroke state.
    pushUndo();
    painting = true;
    stamp(px, py);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!painting) return;
    const r = canvas.getBoundingClientRect();
    const px = Math.floor((ev.clientX - r.left) / r.width * W);
    const py = Math.floor((ev.clientY - r.top) / r.height * H);
    stamp(px, py);
  });
  function endPaint(ev) {
    if (painting) {
      painting = false;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
    }
  }
  canvas.addEventListener("pointerup", endPaint);
  canvas.addEventListener("pointercancel", endPaint);
  canvas.addEventListener("pointerleave", endPaint);

  // Close handler: bump cellsVersion so the cubemap re-bakes from
  // the painted cells. We do NOT immediately re-bake here (potentially
  // 100-500ms hang); the next _ensurePlanetMapCubemap call (triggered
  // by Planet's next chunk build) does it under whatever stream
  // budget exists.
  function closeModal() {
    if (dirty) {
      node._cellsVersion = ((typeof node._cellsVersion === "number") ? node._cellsVersion : 0) + 1;
      // Clear cached cubemap so the next access re-bakes from cells.
      // Also clear params.cubemapData so the stale .gpatch-serialized
      // version doesn't get used on next load.
      node._cubemap = null;
      node._cubemapKey = null;
      if (node.params) {
        delete node.params.cubemapData;
        delete node.params.cubemapDataRes;
        delete node.params.cubemapKey;
      }
      pushHistory("planet-map-edit:apply");
    }
    window.removeEventListener("keydown", kbHandler);
    back.remove();
  }
  modal.querySelector("#pmap-close").addEventListener("click", closeModal);
  back.addEventListener("click", (ev) => { if (ev.target === back) closeModal(); });
}

function openTilingConfigPopup(nodeId) {
  const node = state && state.nodes && state.nodes.find(n => n && n.id === nodeId);
  if (!node || node.type !== "TiledTerrain") return;
  // Snapshot original params for an undo on cancel.
  const original = JSON.parse(JSON.stringify(node.params || {}));
  pushHistory("tiling-config:open");

  // Build modal. Reuse the existing .modal-backdrop / .modal CSS.
  // Tear down any prior tiling-config modal first (single instance).
  let prev = document.getElementById("tiling-config-modal");
  if (prev) prev.remove();
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id        = "tiling-config-modal";
  back.style.display = "flex";
  back.style.zIndex = 60;
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.width = "440px";
  modal.style.maxHeight = "85vh";
  modal.style.overflowY = "auto";
  modal.innerHTML = `
    <div class="modal-head">
      <span class="modal-title" style="font-family: var(--font-instr); letter-spacing: 0.18em; color: var(--phosphor); text-transform: lowercase;">tiling config · ${node.type}#${node.id}</span>
      <button class="btn modal-x" id="tiling-close" type="button">×</button>
    </div>
    <div id="tiling-body" style="padding: 14px 18px 18px;"></div>
  `;
  back.appendChild(modal);
  document.body.appendChild(back);

  const body = modal.querySelector("#tiling-body");

  // §5.5.e-3 -- 2D chunk-grid preview at the top of the popup. Live
  // canvas showing all chunks colored by LOD ring, plus the wired
  // camera position + heading. Click a chunk in MANUAL anchor mode
  // to set centerX/centerZ to that chunk's center.
  const previewWrap = document.createElement("div");
  previewWrap.style.cssText =
    "margin-bottom:12px;display:flex;flex-direction:column;align-items:center;gap:6px;";
  const preview = document.createElement("canvas");
  preview.width  = 360;
  preview.height = 360;
  preview.style.cssText =
    "width:360px;height:360px;background:rgba(8,12,20,0.85);" +
    "border:1px solid var(--border);border-radius:3px;cursor:crosshair;";
  previewWrap.appendChild(preview);
  const previewLegend = document.createElement("div");
  previewLegend.style.cssText =
    "font-family:var(--font-mono);font-size:10px;color:var(--text-3);" +
    "display:flex;gap:14px;align-items:center;";
  previewLegend.innerHTML =
    `<span><span style="color:rgba(110,220,180,0.9);">█</span> inner LOD</span>` +
    `<span><span style="color:rgba(160,200,140,0.85);">█</span> mid LOD</span>` +
    `<span><span style="color:rgba(180,170,120,0.7);">█</span> outer LOD</span>` +
    `<span><span style="color:rgba(180,240,255,1);">●</span> camera</span>`;
  previewWrap.appendChild(previewLegend);
  body.appendChild(previewWrap);

  // Live-stats line. Recomputed on every input change.
  const stats = document.createElement("div");
  stats.id = "tiling-stats";
  stats.style.cssText =
    "margin-bottom:14px;padding:8px 10px;background:var(--surface-2);" +
    "border:1px solid var(--border);border-radius:3px;" +
    "font-family:var(--font-mono);font-size:11px;line-height:1.55;" +
    "color:var(--text-2);";
  body.appendChild(stats);

  const makeRow = (label, key, kind, opts) => {
    const row = document.createElement("div");
    row.className = "modal-field";
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin:7px 0;";
    const lbl = document.createElement("div");
    lbl.className = "modal-field-label";
    lbl.textContent = label;
    lbl.style.cssText = "flex:0 0 130px;font-size:12px;color:var(--text-2);";
    row.appendChild(lbl);
    let input;
    if (kind === "select") {
      input = document.createElement("select");
      input.style.cssText = "flex:1;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:var(--font-mono);font-size:12px;";
      (opts.options || []).forEach(o => {
        const op = document.createElement("option");
        op.value = o; op.textContent = o;
        if (o === (node.params || {})[key]) op.selected = true;
        input.appendChild(op);
      });
    } else if (kind === "checkbox") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!(node.params || {})[key];
    } else {
      input = document.createElement("input");
      input.type = "number";
      if (opts && typeof opts.step === "number") input.step = opts.step;
      if (opts && typeof opts.min  === "number") input.min  = opts.min;
      if (opts && typeof opts.max  === "number") input.max  = opts.max;
      input.value = (node.params || {})[key];
      input.style.cssText = "flex:1;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:var(--font-mono);font-size:12px;text-align:right;";
    }
    input.addEventListener("input", () => {
      node.params = node.params || {};
      if (kind === "checkbox") {
        node.params[key] = input.checked ? 1 : 0;
      } else if (kind === "select") {
        node.params[key] = input.value;
        refreshAnchorVisibility();
      } else {
        const v = parseFloat(input.value);
        if (!Number.isNaN(v)) node.params[key] = v;
      }
      refreshStats();
      // Re-render the editor canvas so the node label updates if
      // any port-derived UI changes. The visual preview will pick
      // up the new mesh on its next frame (cache key changes).
      render();
      refreshPreview();
    });
    row.appendChild(input);
    return { row, input };
  };

  // 2D chunk-grid preview drawer. Draws every chunk colored by its
  // LOD ring + camera dot/heading on top. Click in MANUAL mode to
  // set centerX/centerZ to the clicked chunk's center.
  const refreshPreview = () => {
    const ctx = preview.getContext("2d");
    const W = preview.width, H = preview.height;
    ctx.clearRect(0, 0, W, H);
    const p = node.params || {};
    const r  = Math.max(0, Math.floor(p.chunkRadius || 0));
    const s  = Math.max(2, Math.floor(p.segments    || 2));
    const cs = Math.max(1, p.chunkSize || 64);
    const diameter = (2 * r + 1) * cs;
    const scale    = Math.min(W, H) / (diameter * 1.05);
    // Anchor center in world space.
    const anchorWX = (p.anchorMode === "manual")
      ? (p.centerX || 0)
      : (() => {
          const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
          return (cam && cam.params && typeof cam.params.posX === "number") ? cam.params.posX : 0;
        })();
    const anchorWZ = (p.anchorMode === "manual")
      ? (p.centerZ || 0)
      : (() => {
          const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
          return (cam && cam.params && typeof cam.params.posZ === "number") ? cam.params.posZ : 0;
        })();
    const centerTileX = Math.round(anchorWX / cs);
    const centerTileZ = Math.round(anchorWZ / cs);
    // World -> canvas helpers.
    const wx0 = centerTileX * cs;
    const wz0 = centerTileZ * cs;
    const toMx = (wx) => W * 0.5 + (wx - wx0) * scale;
    const toMz = (wz) => H * 0.5 + (wz - wz0) * scale;

    const lodFor = (ring) => {
      if (r <= 0) return s;
      const t = ring / r;
      if (t <= 0.40) return s;
      if (t <= 0.70) return Math.max(2, s >> 1);
      return Math.max(2, s >> 2);
    };
    const colorFor = (seg) => {
      if (seg === s)                          return "rgba(110, 220, 180, 0.55)";
      else if (seg === Math.max(2, s >> 1))   return "rgba(160, 200, 140, 0.45)";
      else                                    return "rgba(180, 170, 120, 0.30)";
    };

    // Fill chunks by LOD color.
    for (let cz = -r; cz <= r; cz++) {
      for (let cx = -r; cx <= r; cx++) {
        const tileX = centerTileX + cx;
        const tileZ = centerTileZ + cz;
        const x0 = toMx(tileX * cs - cs * 0.5);
        const z0 = toMz(tileZ * cs - cs * 0.5);
        const x1 = toMx(tileX * cs + cs * 0.5);
        const z1 = toMz(tileZ * cs + cs * 0.5);
        const ring = Math.max(Math.abs(cx), Math.abs(cz));
        ctx.fillStyle = colorFor(lodFor(ring));
        ctx.fillRect(x0, z0, x1 - x0, z1 - z0);
      }
    }
    // Grid lines.
    ctx.strokeStyle = "rgba(110, 220, 180, 0.18)";
    ctx.lineWidth = 0.5;
    for (let i = -r; i <= r + 1; i++) {
      const px = toMx((centerTileX + i - 0.5) * cs);
      const pyA = toMz((centerTileZ - r - 0.5) * cs);
      const pyB = toMz((centerTileZ + r + 0.5) * cs);
      ctx.beginPath(); ctx.moveTo(px, pyA); ctx.lineTo(px, pyB); ctx.stroke();
      const py = toMz((centerTileZ + i - 0.5) * cs);
      const pxA = toMx((centerTileX - r - 0.5) * cs);
      const pxB = toMx((centerTileX + r + 0.5) * cs);
      ctx.beginPath(); ctx.moveTo(pxA, py); ctx.lineTo(pxB, py); ctx.stroke();
    }
    // Highlight center tile.
    ctx.strokeStyle = "rgba(180, 240, 255, 0.85)";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(
      toMx(centerTileX * cs - cs * 0.5),
      toMz(centerTileZ * cs - cs * 0.5),
      cs * scale, cs * scale
    );
    // Camera dot + heading line. Uses live posX/posZ + yaw from the
    // wired camera so the preview reflects exactly where the player is.
    const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
    if (cam && cam.params) {
      const cpx = (typeof cam.params.posX === "number") ? cam.params.posX : 0;
      const cpz = (typeof cam.params.posZ === "number") ? cam.params.posZ : 0;
      const cyw = (typeof cam.params.yaw === "number") ? cam.params.yaw : 0;
      const mx = toMx(cpx);
      const my = toMz(cpz);
      const len = 22;
      ctx.strokeStyle = "rgba(140, 220, 255, 0.95)";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + Math.sin(cyw) * len, my + Math.cos(cyw) * len);
      ctx.stroke();
      ctx.fillStyle = "rgba(180, 240, 255, 1)";
      ctx.beginPath();
      ctx.arc(mx, my, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Scale label.
    ctx.fillStyle = "rgba(110, 220, 180, 0.85)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(`${Math.round(diameter).toLocaleString()}u square`, 8, 14);
    ctx.fillText(`tile ${centerTileX},${centerTileZ}`, 8, H - 8);
  };

  // Click-to-set anchor: in manual mode, clicking a chunk sets
  // centerX/centerZ to that chunk's center. In auto mode, clicks
  // are ignored (camera drives anchor).
  preview.addEventListener("click", (ev) => {
    const p = node.params || {};
    if (p.anchorMode !== "manual") return;
    const r  = Math.max(0, Math.floor(p.chunkRadius || 0));
    const cs = Math.max(1, p.chunkSize || 64);
    const diameter = (2 * r + 1) * cs;
    const W = preview.width, H = preview.height;
    const scale    = Math.min(W, H) / (diameter * 1.05);
    const rect = preview.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * (W / rect.width);
    const my = (ev.clientY - rect.top)  * (H / rect.height);
    // Convert canvas xy back to world coords. centerTileX/Z = 0 at
    // canvas center (manual mode, no camera offset baked in).
    const wx = (mx - W * 0.5) / scale + (p.centerX || 0);
    const wz = (my - H * 0.5) / scale + (p.centerZ || 0);
    const tileX = Math.round(wx / cs);
    const tileZ = Math.round(wz / cs);
    node.params.centerX = tileX * cs;
    node.params.centerZ = tileZ * cs;
    render();
    refreshStats();
    refreshPreview();
  });

  const refreshStats = () => {
    const p = node.params || {};
    const r = Math.max(0, Math.floor(p.chunkRadius || 0));
    const s = Math.max(2, Math.floor(p.segments    || 2));
    // Walk the chunk grid the same way _buildTiledTerrain does so
    // the LOD distribution is reflected in vert / index totals. Each
    // chunk's vert count = (segs+1)² grid + 4*(segs+1) skirt-bottom
    // verts; index count = segs²*6 grid + 4*segs*6 skirt quads.
    let chunks = 0, verts = 0, inds = 0;
    const lodFor = (ring) => {
      if (r <= 0) return s;
      const t = ring / r;
      if (t <= 0.20) return s;
      if (t <= 0.40) return Math.max(2, s >> 1);
      if (t <= 0.60) return Math.max(2, s >> 2);
      if (t <= 0.80) return Math.max(2, s >> 3);
      return 2;
    };
    let lod0 = 0, lod1 = 0, lod2 = 0, lod3 = 0, lod4 = 0;
    for (let cz = -r; cz <= r; cz++) {
      for (let cx = -r; cx <= r; cx++) {
        const ring = Math.max(Math.abs(cx), Math.abs(cz));
        const seg = lodFor(ring);
        const N = seg + 1;
        verts += N * N + 4 * N;
        inds  += seg * seg * 6 + 4 * seg * 6;
        chunks++;
        if (seg === s)                              lod0++;
        else if (seg === Math.max(2, s >> 1))       lod1++;
        else if (seg === Math.max(2, s >> 2))       lod2++;
        else if (seg === Math.max(2, s >> 3))       lod3++;
        else                                        lod4++;
      }
    }
    const bytes = verts * 44 + inds * 4;
    const fmtMem = (b) => (b < 1024)
      ? b + " B"
      : (b < 1024 * 1024)
        ? (b / 1024).toFixed(1) + " kB"
        : (b / (1024 * 1024)).toFixed(2) + " MB";
    const worldExtent = (2 * r + 1) * (p.chunkSize || 64);
    stats.innerHTML =
      `<div>chunks    : <span style="color:var(--phosphor);">${chunks}</span> (${2*r+1}×${2*r+1})</div>` +
      `<div>LOD split : <span style="color:var(--phosphor);">${lod0}/${lod1}/${lod2}/${lod3}/${lod4}</span> (LOD 0..4)</div>` +
      `<div>verts     : <span style="color:var(--phosphor);">${verts.toLocaleString()}</span> (incl. skirts)</div>` +
      `<div>triangles : <span style="color:var(--phosphor);">${(inds/3).toLocaleString()}</span></div>` +
      `<div>memory    : <span style="color:var(--phosphor);">${fmtMem(bytes)}</span></div>` +
      `<div>world     : <span style="color:var(--phosphor);">${worldExtent.toLocaleString()}u</span> square</div>`;
  };

  // Section: chunking
  const secChunk = document.createElement("div");
  secChunk.style.cssText = "margin-top:6px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secChunk.textContent = "chunking";
  body.appendChild(secChunk);
  body.appendChild(makeRow("chunk size (units)", "chunkSize",   "number", { step: 1, min: 1 }).row);
  body.appendChild(makeRow("chunk radius",       "chunkRadius", "number", { step: 1, min: 0, max: 16 }).row);
  body.appendChild(makeRow("segments / chunk",   "segments",    "number", { step: 1, min: 1, max: 64 }).row);

  // Section: anchor
  const secAnchor = document.createElement("div");
  secAnchor.style.cssText = "margin-top:14px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secAnchor.textContent = "anchor";
  body.appendChild(secAnchor);
  body.appendChild(makeRow("anchor mode", "anchorMode", "select", { options: ["auto", "manual"] }).row);
  const centerXEntry = makeRow("center X (manual)", "centerX", "number", { step: 1 });
  const centerZEntry = makeRow("center Z (manual)", "centerZ", "number", { step: 1 });
  body.appendChild(centerXEntry.row);
  body.appendChild(centerZEntry.row);
  const refreshAnchorVisibility = () => {
    const manual = (node.params || {}).anchorMode === "manual";
    centerXEntry.row.style.display = manual ? "" : "none";
    centerZEntry.row.style.display = manual ? "" : "none";
  };

  // Section: noise
  const secNoise = document.createElement("div");
  secNoise.style.cssText = "margin-top:14px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secNoise.textContent = "heightmap noise";
  body.appendChild(secNoise);
  body.appendChild(makeRow("height scale",  "heightScale", "number", { step: 1 }).row);
  body.appendChild(makeRow("y offset",      "yOffset",     "number", { step: 1 }).row);
  body.appendChild(makeRow("seed",          "seed",        "number", { step: 0.1 }).row);
  body.appendChild(makeRow("frequency",     "frequency",   "number", { step: 0.005 }).row);
  body.appendChild(makeRow("octaves",       "octaves",     "number", { step: 1, min: 1, max: 8 }).row);
  body.appendChild(makeRow("lacunarity",    "lacunarity",  "number", { step: 0.05 }).row);
  body.appendChild(makeRow("gain",          "gain",        "number", { step: 0.05 }).row);
  body.appendChild(makeRow("ridges (0..1)", "ridges",      "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("plateau (0..1)", "plateau",    "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("forward bias",   "forwardBias","number", { step: 0.05, min: 0, max: 1 }).row);

  // Section: island mode.
  const secIsland = document.createElement("div");
  secIsland.style.cssText = "margin-top:14px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secIsland.textContent = "island mode";
  body.appendChild(secIsland);
  body.appendChild(makeRow("mode",              "islandMode",          "select", { options: ["off", "single", "archipelago"] }).row);
  body.appendChild(makeRow("sink depth (m)",    "islandSinkDepth",     "number", { step: 100, min: 0 }).row);
  // single-mode rows
  body.appendChild(makeRow("[single] center X", "islandCenterX",       "number", { step: 50 }).row);
  body.appendChild(makeRow("[single] center Z", "islandCenterZ",       "number", { step: 50 }).row);
  body.appendChild(makeRow("[single] radius",   "islandRadius",        "number", { step: 50, min: 1 }).row);
  body.appendChild(makeRow("[single] falloff",  "islandFalloff",       "number", { step: 0.1, min: 0.5 }).row);
  // archipelago-mode rows
  body.appendChild(makeRow("[archipelago] mask freq",      "islandMaskFreq",      "number", { step: 0.00002, min: 0.00001 }).row);
  body.appendChild(makeRow("[archipelago] mask seed",      "islandMaskSeed",      "number", { step: 0.1 }).row);
  body.appendChild(makeRow("[archipelago] threshold",      "islandMaskThreshold", "number", { step: 0.02, min: 0.0, max: 1.0 }).row);
  body.appendChild(makeRow("[archipelago] softness",       "islandMaskSoftness",  "number", { step: 0.01, min: 0.01, max: 0.5 }).row);

  // Section: erosion (baked into chunks at build time).
  const secErosion = document.createElement("div");
  secErosion.style.cssText = "margin-top:14px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secErosion.textContent = "erosion (baked at build)";
  body.appendChild(secErosion);
  body.appendChild(makeRow("strength (0=off)",      "erosionStrength",   "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("thermal",               "erosionThermal",    "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("hydraulic",             "erosionHydraulic",  "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("talus angle",           "erosionTalus",      "number", { step: 0.005 }).row);
  body.appendChild(makeRow("iterations",            "erosionIterations", "number", { step: 1, min: 1, max: 12 }).row);
  body.appendChild(makeRow("radius (world units)",  "erosionRadius",     "number", { step: 5, min: 1 }).row);

  // Footer with revert + done buttons.
  const foot = document.createElement("div");
  foot.style.cssText = "margin-top:18px;display:flex;justify-content:space-between;gap:10px;";
  const revert = document.createElement("button");
  revert.className = "btn";
  revert.textContent = "revert";
  revert.addEventListener("click", () => {
    node.params = original;
    back.remove();
    render();
  });
  const done = document.createElement("button");
  done.className = "btn";
  done.textContent = "done";
  done.addEventListener("click", () => { back.remove(); });
  foot.appendChild(revert);
  foot.appendChild(done);
  body.appendChild(foot);

  modal.querySelector("#tiling-close").addEventListener("click", () => back.remove());
  back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });

  refreshAnchorVisibility();
  refreshStats();
  refreshPreview();
}

// Phase 8.D.1 -- UI/HUD nodes are non-C++; the per-node edit modal
// switches into a "render-code" mode that hides the cppType + ports
// sections and just shows a JS code editor for the customRender
// param. Save writes back to node.params.customRender instead of
// node.override.
const _NODE_EDIT_UI_TYPES = new Set(["UIButton", "UIText", "UIPanel", "UISlider", "HUDText"]);
let _nodeEditUiMode = false;

function openNodeCodeEditor(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const def = defOf(node);
  if (!def) return;
  _nodeEditTargetId = nodeId;
  _nodeEditorOpen   = true;
  _nodeEditUiMode   = _NODE_EDIT_UI_TYPES.has(node.type);

  // 8.D.1 -- show/hide sections based on UI vs C++ mode.
  const rawView = document.getElementById("node-edit-raw-view");
  const sections = rawView ? rawView.querySelectorAll(":scope > .node-edit-section") : [];
  const modeBtn = document.getElementById("btn-node-edit-mode");
  const noteEl  = rawView ? rawView.parentNode.querySelector(".modal-note") : null;
  const validateBtn = document.getElementById("btn-node-edit-validate");
  const exportBtn   = document.getElementById("btn-node-edit-export");
  const revertBtn   = document.getElementById("btn-node-edit-revert");
  if (_nodeEditUiMode) {
    // Hide cppType + inputs + outputs sections (indices 0,1,2);
    // keep the code section (index 3) but relabel it.
    for (let i = 0; i < sections.length; i++) {
      sections[i].style.display = (i === sections.length - 1) ? "" : "none";
    }
    const codeHead = sections.length
      ? sections[sections.length - 1].querySelector(".node-edit-section-head") : null;
    if (codeHead) codeHead.textContent = "custom render code (JS body) — free vars: ctx, p, input";
    if (modeBtn) modeBtn.style.display = "none";
    if (validateBtn) validateBtn.style.display = "none";
    if (exportBtn)   exportBtn.style.display   = "none";
    if (revertBtn)   revertBtn.style.display   = "none";
    if (noteEl) {
      noteEl.innerHTML =
        "Edit the JS body that renders this node's canvas. " +
        "Free variables: <code>ctx</code> (2D context), <code>p</code> (params), <code>input</code> ({ node, width, height, hovered, pressed }). " +
        "Leave empty to use the default render.";
    }
  } else {
    // C++ mode -- show everything, restore default labels/note.
    for (let i = 0; i < sections.length; i++) sections[i].style.display = "";
    const codeHead = sections.length >= 4
      ? sections[3].querySelector(".node-edit-section-head") : null;
    if (codeHead) codeHead.textContent = "helper class (C++ source)";
    if (modeBtn) modeBtn.style.display = "";
    if (validateBtn) validateBtn.style.display = "";
    if (exportBtn)   exportBtn.style.display   = "";
    if (revertBtn)   revertBtn.style.display   = "";
    if (noteEl) {
      noteEl.innerHTML =
        "Per-node override of helperClass code and ports. Changes apply to <em>this instance only</em>; " +
        "other nodes of the same type stay on the registry default. Recompile (▶) after saving to see the new C++ in action.";
    }
  }

  document.getElementById("node-edit-title").textContent =
    (_nodeEditUiMode ? "Edit render code · " : "Edit ") + node.type + " · " + node.id;
  // UI-mode short-circuits the rest of openNodeCodeEditor's C++
  // setup -- we don't need cppType/ports/seeds. Just seed the
  // code editor with params.customRender and show the modal.
  if (_nodeEditUiMode) {
    const initial = (node.params && typeof node.params.customRender === "string")
      ? node.params.customRender : "";
    const placeholder = initial.trim() ? initial :
      "// Replace the default render with custom canvas drawing.\n" +
      "// ctx    -- canvas 2d context\n" +
      "// p      -- node params (read-write)\n" +
      "// input  -- { node, width, height, hovered, pressed }\n" +
      "//\n" +
      "// Example:\n" +
      "//   ctx.clearRect(0, 0, input.width, input.height);\n" +
      "//   ctx.fillStyle = input.hovered ? '#9be0ff' : '#3a4a60';\n" +
      "//   ctx.fillRect(0, 0, input.width, input.height);\n" +
      "//   ctx.fillStyle = '#ffffff';\n" +
      "//   ctx.font = '16px sans-serif';\n" +
      "//   ctx.textAlign = 'center';\n" +
      "//   ctx.textBaseline = 'middle';\n" +
      "//   ctx.fillText(p.label || '', input.width/2, input.height/2);\n";
    document.getElementById("node-edit-code").value = placeholder;
    document.getElementById("node-edit-gdsp").value = "";
    _nodeEditMode = "raw";
    document.getElementById("node-edit-raw-view").style.display  = "";
    document.getElementById("node-edit-gdsp-view").style.display = "none";
    const warn = document.getElementById("node-edit-warn");
    if (warn) { warn.textContent = ""; warn.classList.remove("visible", "ok"); }
    document.getElementById("node-edit-modal").style.display = "flex";
    _initNodeEditCm();
    _setRawCode(placeholder);
    _setGdspCode("");
    setTimeout(() => {
      if (_nodeEditCmRaw) { _nodeEditCmRaw.refresh(); _nodeEditCmRaw.focus(); }
    }, 0);
    return;
  }

  // Pick the right pre-fill: helper-class nodes show their existing
  // source; template / wrapper nodes show a synthesized class so
  // EVERY node has editable C++ in the modal. Save will detect what
  // shape the user authored and write the override accordingly.
  const seed = _seedNodeEditCode(def, node);
  _nodeEditSeed = seed;        // stashed for save -- carries synth's
                               // noSigArg + className hints

  const cppTypeEl = document.getElementById("node-edit-cppType");
  // For synthesized cases the cppType field should default to the
  // synth's class name (so save's override includes a matching
  // cppType) rather than the original library type or empty string.
  cppTypeEl.value = seed.synthClassName || def.cppType || "";

  // Seed the ports tables. Deep-copy so live edits don't mutate the
  // registry until "save" is clicked.
  const insArr  = (def.ins  || []).map(p => ({ n: p.n, t: p.t }));
  const outsArr = (def.outs || []).map(p => ({ n: p.n, t: p.t }));
  // Methods + gateMethods come from the synth when we synthesized,
  // otherwise from the registry def. The synth's methods ensure that
  // every audio-input setter we emitted in the class is reflected in
  // the registry's port-name -> setter map (codegen uses methods to
  // decide which setters to call per sample).
  const methods = Object.assign({}, def.methods || {});
  const gateM   = Object.assign({}, def.gateMethods || {});
  // Synthesized classes augment with their own setter map.
  if (seed.synthClassName) {
    const synth = (def.template
      ? _classFromTemplate(def, node)
      : (def.cppType ? _classFromWrapper(def, node) : null));
    if (synth) {
      if (synth.methods)     Object.assign(methods, synth.methods);
      if (synth.gateMethods) Object.assign(gateM,   synth.gateMethods);
    }
  }
  _renderPortRows("in",  insArr,  methods, gateM);
  _renderPortRows("out", outsArr, methods, gateM);

  // Update the section header so the user knows whether they're
  // editing the original source vs a synthesized class.
  const sectionHead = document.querySelector("#node-edit-raw-view .node-edit-section:last-of-type .node-edit-section-head");
  if (sectionHead) sectionHead.textContent = seed.sectionLabel;

  const codeSrc = (seed.hint ? seed.hint + "\n" : "") + seed.source;

  // Seed the raw textarea BEFORE initializing CodeMirror so that
  // fromTextArea() reads the right initial content.
  document.getElementById("node-edit-code").value = codeSrc;
  document.getElementById("node-edit-gdsp").value = "";

  // (revertBtn was already grabbed + style.display toggled above
  // for UI vs C++ mode.) Disable when no override is recorded.
  revertBtn.disabled = !node.override;

  const warn = document.getElementById("node-edit-warn");
  warn.textContent = ""; warn.classList.remove("visible", "ok");

  // Always open in "raw" (fields) view so the structure is visible.
  _nodeEditMode = "raw";
  document.getElementById("node-edit-raw-view").style.display  = "";
  document.getElementById("node-edit-gdsp-view").style.display = "none";
  // modeBtn already grabbed at function top for the UI/C++ mode toggle.
  modeBtn.textContent = ".gdsp →";
  modeBtn.title = "Toggle between fields view and a single .gdsp source (User DSP format)";

  document.getElementById("node-edit-modal").style.display = "flex";

  // Lazy init / sync CodeMirror. fromTextArea() can only run after
  // the textarea is in the DOM AND visible; the modal must be on
  // first. Refresh after layout so CodeMirror reads the correct
  // container dimensions.
  _initNodeEditCm();
  _setRawCode(codeSrc);
  _setGdspCode("");
  setTimeout(() => {
    if (_nodeEditCmRaw)  _nodeEditCmRaw.refresh();
    if (_nodeEditCmGdsp) _nodeEditCmGdsp.refresh();
    if (_nodeEditCmRaw)  _nodeEditCmRaw.focus();
  }, 0);
}

function closeNodeCodeEditor() {
  document.getElementById("node-edit-modal").style.display = "none";
  _nodeEditorOpen   = false;
  _nodeEditTargetId = null;
}

/* Renders one ports table ("in" or "out"). Each row has:
 *   - name input (free text)
 *   - type select (audio/param/gate/clock/texture/...)
 *   - setter input (only for "in" rows of type param/gate; hidden for
 *     audio inputs since they're wired by edge, not setter)
 *   - × remove button
 *
 * The arrays + methods objects passed in are mutated as the user
 * edits, so when "save" reads them they reflect the current UI. */
function _renderPortRows(dir, arr, methods, gateM) {
  const host = document.getElementById(dir === "in" ? "node-edit-ins" : "node-edit-outs");
  host.innerHTML = "";
  arr.forEach((port, idx) => {
    const row = document.createElement("div");
    row.className = "node-port-row" + (dir === "out" ? " no-setter" : "");

    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.value = port.n;
    nameIn.placeholder = "port name";
    nameIn.addEventListener("input", () => { port.n = nameIn.value.trim(); });

    const typeSel = document.createElement("select");
    (dir === "in" ? PORT_TYPE_OPTS_IN : PORT_TYPE_OPTS_OUT).forEach(t => {
      const opt = document.createElement("option");
      opt.value = t; opt.textContent = t;
      if (t === port.t) opt.selected = true;
      typeSel.appendChild(opt);
    });
    typeSel.addEventListener("change", () => {
      port.t = typeSel.value;
      // Show/hide the setter field if the type changed in/out of
      // setter-eligible territory.
      _refreshSetterCell(row, dir, port, methods, gateM);
    });

    row.appendChild(nameIn);
    row.appendChild(typeSel);

    // Setter / method-name column (in-direction only). For audio
    // inputs we still show the column to keep the grid aligned, but
    // the input is hidden -- audio inputs don't have a setter; they're
    // wired by edge into the operator() expression.
    const methCell = document.createElement("input");
    methCell.type = "text";
    methCell.placeholder = dir === "in" ? "setter / method (e.g. setFreq)" : "";
    methCell.dataset.role = "method";
    if (dir === "in") {
      const initial = port.t === "gate"
        ? (gateM[port.n] || "")
        : (methods[port.n] || "");
      methCell.value = initial;
      methCell.addEventListener("input", () => {
        if (port.t === "gate") gateM[port.n] = methCell.value.trim();
        else methods[port.n] = methCell.value.trim();
      });
    } else {
      methCell.disabled = true;
    }
    row.appendChild(methCell);
    _refreshSetterCell(row, dir, port, methods, gateM);

    const rm = document.createElement("button");
    rm.className = "node-port-rm";
    rm.title = "Remove this port";
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      arr.splice(idx, 1);
      _renderPortRows(dir, arr, methods, gateM);
    });
    row.appendChild(rm);

    host.appendChild(row);
  });
  // Re-bind the add button so its closure has the latest array ref.
  const addBtn = document.getElementById(dir === "in" ? "btn-node-add-in" : "btn-node-add-out");
  addBtn.onclick = () => {
    arr.push({ n: dir === "in" ? "input" + (arr.length + 1) : "out" + (arr.length + 1), t: "audio" });
    _renderPortRows(dir, arr, methods, gateM);
  };
  // Stash refs so save can read the final state.
  host._portsArr = arr;
  host._methods  = methods;
  host._gateM    = gateM;
}

/* Audio inputs don't have setters (they're consumed by operator()
 * directly), so we hide the setter cell for type=audio. Param/gate/
 * clock inputs DO need a setter / method name to wire JS-driven
 * values into the worklet. */
function _refreshSetterCell(row, dir, port, methods, gateM) {
  const methCell = row.querySelector('[data-role="method"]');
  if (!methCell) return;
  if (dir === "out" || port.t === "audio") {
    methCell.classList.add("port-method-empty");
    methCell.value = "";
  } else {
    methCell.classList.remove("port-method-empty");
    if (port.t === "gate") methCell.value = gateM[port.n] || "";
    else methCell.value = methods[port.n] || "";
  }
}

/* Read the current modal state, validate, write to node.override.
 * In ".gdsp" mode, parse the source first and treat the resulting
 * fields as authoritative; in "raw" mode read the form fields. */
function _saveNodeOverride() {
  if (_nodeEditTargetId == null) return;
  const node = state.nodes.find(n => n.id === _nodeEditTargetId);
  if (!node) return;
  const base = TYPES[node.type];
  if (!base) return;

  // Phase 8.D.1 -- UI/HUD nodes commit to params.customRender,
  // skipping the C++ override path.
  if (_nodeEditUiMode) {
    const code = _getRawCode();
    // Strip leading "// example" comments that came from the
    // placeholder seed (keep the user's actual edits). If the
    // entire buffer matches the placeholder pattern, treat as empty.
    const trimmed = (typeof code === "string") ? code.trim() : "";
    pushHistory("ui-customRender:" + node.id);
    node.params = node.params || {};
    // Clear any cached compiled fn so the new code re-parses.
    node._uiCustomFnCode = "";
    node._uiCustomFn = null;
    node._uiCustomErrLogged = false;
    node._uiCustomRunErrLogged = false;
    node.params.customRender = trimmed;
    console.log("[ui-edit " + node.id + "] saved customRender (" + trimmed.length + " chars)");
    closeNodeCodeEditor();
    if (typeof renderProps === "function") renderProps();
    return;
  }

  const warn = document.getElementById("node-edit-warn");
  function fail(msg) {
    warn.textContent = msg;
    warn.classList.add("visible");
  }

  let cppType, helperClass, ins, outs, methodsRaw, gateMRaw;
  if (_nodeEditMode === "gdsp") {
    const src = _getGdspCode();
    let raw;
    try { raw = _parseGdspToState(src); }
    catch (err) { return fail(".gdsp: " + (err && err.message ? err.message : String(err))); }
    cppType     = raw.cppType;
    helperClass = raw.helperClass;
    ins         = raw.ins;
    outs        = raw.outs;
    methodsRaw  = raw.methods;
    gateMRaw    = raw.gateMethods;
  } else {
    cppType     = document.getElementById("node-edit-cppType").value.trim();
    helperClass = _getRawCode();
    const insHost  = document.getElementById("node-edit-ins");
    const outsHost = document.getElementById("node-edit-outs");
    ins  = (insHost._portsArr  || []).filter(p => p.n).map(p => ({ n: p.n, t: p.t }));
    outs = (outsHost._portsArr || []).filter(p => p.n).map(p => ({ n: p.n, t: p.t }));
    methodsRaw = insHost._methods  || {};
    gateMRaw   = insHost._gateM    || {};
  }

  // Basic validation -- catches the common footguns. Codegen will
  // surface anything subtler (compile errors land in the build log).
  const seenIn = new Set();
  for (const p of ins) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.n)) return fail("Input name '" + p.n + "' isn't a valid identifier.");
    if (seenIn.has(p.n)) return fail("Duplicate input name '" + p.n + "'.");
    seenIn.add(p.n);
  }
  const seenOut = new Set();
  for (const p of outs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.n)) return fail("Output name '" + p.n + "' isn't a valid identifier.");
    if (seenOut.has(p.n)) return fail("Duplicate output name '" + p.n + "'.");
    seenOut.add(p.n);
  }

  // Build methods + gateMethods objects restricted to current input
  // port names. Gate ports go into gateMethods; everything else
  // (including audio) goes into methods. Audio inputs DO need methods
  // entries for noSigArg-style classes: prepareSample's audio-input
  // setter loop fires `n.a(...)` only when def.methods[p.n] exists.
  // Without those entries, synthesized multi-audio classes (Mul, Add,
  // Mix, ...) would output 0 because the setters never fire.
  const methods = {};
  const gateMethods = {};
  ins.forEach(p => {
    if (p.t === "gate") {
      if (gateMRaw[p.n]) gateMethods[p.n] = gateMRaw[p.n];
    } else {
      if (methodsRaw[p.n]) methods[p.n] = methodsRaw[p.n];
    }
  });

  pushHistory("edit node code");

  // Drop any edges that reference a port we just removed or renamed
  // on this node -- otherwise they'd dangle into nonexistent ports.
  const validIns  = new Set(ins.map(p => p.n));
  const validOuts = new Set(outs.map(p => p.n));
  state.edges = state.edges.filter(e => {
    if (e.from.node === node.id && !validOuts.has(e.from.port)) return false;
    if (e.to.node   === node.id && !validIns.has(e.to.port))    return false;
    return true;
  });

  // Build the override -- only store fields that ACTUALLY differ from
  // the base, so a future registry update flows through automatically
  // for fields the user didn't touch.
  const ov = {};
  if (cppType !== (base.cppType || "")) ov.cppType = cppType;
  if (helperClass !== (base.helperClass || "")) ov.helperClass = helperClass;
  if (JSON.stringify(ins)  !== JSON.stringify(base.ins  || [])) ov.ins  = ins;
  if (JSON.stringify(outs) !== JSON.stringify(base.outs || [])) ov.outs = outs;
  if (JSON.stringify(methods)     !== JSON.stringify(base.methods     || {})) ov.methods     = methods;
  if (JSON.stringify(gateMethods) !== JSON.stringify(base.gateMethods || {})) ov.gateMethods = gateMethods;

  // Codegen routing decisions: if the user is saving a real class
  // (cppType + helperClass present) and the base was a template-only
  // entry, force template = null so computeBase takes the cppType
  // path instead of inlining the template. Also derive noSigArg
  // from the audio-input count + the seed's hint: multi-audio
  // classes use the "setter for every audio input + operator()()"
  // shape that prepareSample's existing setter loop already handles.
  const hasRealClass = !!cppType && !!helperClass && /\bclass\s+\w+/.test(helperClass);
  if (hasRealClass && base.template) ov.template = null;
  // When the cppType has changed (wrapper synth, template->class
  // synth), the base extraCtor lines target the OLD class type and
  // call methods our new class likely doesn't expose. The wrapper
  // synth already inlined those calls into the wrapper's ctor; the
  // template synth doesn't need them at all. Null out so codegen's
  // patch-class ctor doesn't re-fire them.
  if (hasRealClass && cppType !== (base.cppType || "") && Array.isArray(base.extraCtor) && base.extraCtor.length) {
    ov.extraCtor = null;
  }
  if (hasRealClass) {
    const audioInCount = ins.filter(p => p.t === "audio").length;
    const clockInCount = ins.filter(p => p.t === "clock").length;
    const hasArgOp    = /operator\s*\(\s*\)\s*\(\s*float\b/.test(helperClass);
    const hasNoArgOp  = /operator\s*\(\s*\)\s*\(\s*\)/.test(helperClass);
    let noSig;
    // Prefer the explicit shape detected in the source; fall back to
    // the seed's hint (set during synthesis) when the regex doesn't
    // match cleanly (e.g. operator() split across lines).
    if (hasArgOp) noSig = false;
    else if (hasNoArgOp) noSig = true;
    else noSig = !!(_nodeEditSeed && _nodeEditSeed.noSigArg);
    // Multi-audio always needs noSigArg = true regardless of detection
    // since the single signal-arg path can only feed one of the audio
    // inputs.
    if (audioInCount + clockInCount > 1) noSig = true;
    if (noSig !== !!base.noSigArg) ov.noSigArg = noSig;
  }

  if (Object.keys(ov).length === 0) {
    delete node.override;
  } else {
    node.override = ov;
  }

  closeNodeCodeEditor();
  render();
  if (typeof renderMonitorControls === "function") renderMonitorControls();
}

function _revertNodeOverride() {
  if (_nodeEditTargetId == null) return;
  const node = state.nodes.find(n => n.id === _nodeEditTargetId);
  if (!node || !node.override) return;
  pushHistory("revert node override");
  delete node.override;
  closeNodeCodeEditor();
  render();
}

/* =========================================================================
 * .gdsp mode toggle -- alternate view of the same per-node override
 * data, using the User DSP file format (single textarea, // @gdsp-*
 * metadata + class body). Lets the user edit a built-in node's code
 * in the same format they'd use for a from-scratch User DSP class.
 *
 * Mode is a UI state ("raw" vs "gdsp"); the underlying model is the
 * same set of fields (cppType, ins, outs, methods, gateMethods,
 * helperClass). Toggling synthesizes/parses between the two views;
 * save reads whichever view is currently active. */
let _nodeEditMode = "raw"; // "raw" | "gdsp"

/* Classify a node's code form so the editor can pre-fill the modal
 * with something editable for every node, not just helperClass ones.
 *
 *   "helper"   - has a real helperClass (KeyboardIn, Slider, Button,
 *                PatchMatrix, etc.) -- show it as-is.
 *   "template" - has an inline template (Mul, Add, Mix, Abs, ...) --
 *                synthesize a class so it shows up as editable C++.
 *   "wrapper"  - has cppType pointing to a library class but no
 *                helperClass (Sine, Saw, Square, ...) -- synthesize
 *                a wrapper class delegating to the library type.
 *   "kind"     - special codegen kind (delay1, shader-frag) -- the
 *                editor surfaces what's there with a note since
 *                these paths can't currently be replaced via override.
 *   "empty"    - none of the above; show a stub. */
function _nodeCodeCategory(def) {
  if (!def) return "empty";
  if (def.kind) return "kind";
  if (def.helperClass) return "helper";
  if (def.template) return "template";
  if (def.cppType)   return "wrapper";
  return "empty";
}

/* Build a real C++ class from a template-only node's `template`
 * string + port list. Two shapes:
 *
 *   * Single audio input (Neg, Abs, AmpToDb, ...):
 *       operator()(float in) takes the audio in as arg; params
 *       become setters + state members.
 *
 *   * Multi-audio input (Mul, Add, Sub, Mix, ...):
 *       operator()() returns based on member state; both audio
 *       inputs become setters (mirrors the existing PatchMatrix /
 *       MasterMix codegen). noSigArg flag returned so the save path
 *       can set it on the override -- the prepareSample audio-input
 *       setter loop already handles this shape.
 *
 * Returns { source, className, noSigArg, methods } -- methods is the
 * port-name -> setter-name map matching the synthesized setters. */
function _classFromTemplate(def, node) {
  const className = node.type;
  const audioIns = (def.ins || []).filter(p => p.t === "audio");
  const paramIns = (def.ins || []).filter(p => p.t === "param");
  const clockIns = (def.ins || []).filter(p => p.t === "clock");
  const oneAudio = audioIns.length === 1 && clockIns.length === 0;

  // Some templates reference param keys that aren't in def.ins --
  // they live in node.params and get substituted at codegen time via
  // computeBase's `Object.keys(node.params).forEach` fallback. Const
  // (template "{value}", params.value), Clip (template references
  // {min} {max}), and Scale ({inMin}/{inMax}/{outMin}/{outMax}) all
  // need this. Collect every {key} referenced and emit a member +
  // setter for any that aren't covered by an input port.
  const templateKeys = new Set();
  const tplStr = def.template || "";
  let kmatch;
  const keyRe = /\{(\w+)\}/g;
  while ((kmatch = keyRe.exec(tplStr))) templateKeys.add(kmatch[1]);
  const knownInputs = new Set([
    ...audioIns.map(p => p.n),
    ...clockIns.map(p => p.n),
    ...paramIns.map(p => p.n)
  ]);
  const paramOnly = [];
  templateKeys.forEach(k => { if (!knownInputs.has(k)) paramOnly.push(k); });

  let s = "";
  s += "class " + className + " {\n";
  if (!oneAudio) {
    audioIns.forEach(p => { s += "    float " + p.n + "_ = 0.f;\n"; });
    clockIns.forEach(p => { s += "    float " + p.n + "_ = 0.f;\n"; });
  }
  // Members for every wired param + every template-referenced
  // params-only key. Defaults come from node.params (or def.params
  // for keys not on this instance) so the synth seeds the same
  // values the original template would have inlined.
  const allParamKeys = [...paramIns.map(p => p.n), ...paramOnly];
  allParamKeys.forEach(key => {
    let dv = (node && node.params && node.params[key] !== undefined) ? node.params[key]
           : (def.params && def.params[key] !== undefined) ? def.params[key]
           : 0;
    dv = Number(dv);
    const lit = isFinite(dv) ? dv.toFixed(4).replace(/0+$/, "0") + "f" : "0.f";
    s += "    float " + key + "_ = " + lit + ";\n";
  });
  s += "public:\n";

  // Setters: every non-signal input + every params-only template key
  // gets a name(float) setter. Codegen's existing audio-input setter
  // loop fires `n.a(...)` for noSigArg multi-audio classes; the ctor
  // body fires `n.value(<dv>)` from def.methods for params-only keys.
  const methods = {};
  if (!oneAudio) {
    audioIns.forEach(p => {
      s += "    void " + p.n + "(float v) { " + p.n + "_ = v; }\n";
      methods[p.n] = p.n;
    });
    clockIns.forEach(p => {
      s += "    void " + p.n + "(float v) { " + p.n + "_ = v; }\n";
      methods[p.n] = p.n;
    });
  }
  allParamKeys.forEach(key => {
    s += "    void " + key + "(float v) { " + key + "_ = v; }\n";
    methods[key] = key;
  });

  // Substitute {key} -> key (single-audio arg) or key_ (member).
  let expr = def.template || "";
  if (oneAudio) {
    const argName = audioIns[0].n;
    allParamKeys.forEach(key => {
      expr = expr.replace(new RegExp("\\{" + key + "\\}", "g"), key + "_");
    });
    expr = expr.replace(new RegExp("\\{" + argName + "\\}", "g"), argName);
    s += "    float operator()(float " + argName + ") {\n";
    s += "        return " + expr + ";\n";
    s += "    }\n";
  } else {
    [...audioIns, ...clockIns].forEach(p => {
      expr = expr.replace(new RegExp("\\{" + p.n + "\\}", "g"), p.n + "_");
    });
    allParamKeys.forEach(key => {
      expr = expr.replace(new RegExp("\\{" + key + "\\}", "g"), key + "_");
    });
    s += "    float operator()() {\n";
    s += "        return " + expr + ";\n";
    s += "    }\n";
  }
  s += "};\n";
  return { source: s, className, noSigArg: !oneAudio, methods };
}

/* Synthesize a thin wrapper class around a library cppType
 * (gam::Sine<>, gam::Biquad<>, ...). The wrapper holds the inner
 * instance, exposes a setter per method/gate the registry declares,
 * and delegates operator() to the inner type.
 *
 * The class name is "Custom" + the stripped library tail -- new
 * enough that it won't collide with the registry's class name in
 * the emitted header. Override.cppType is set to this new name so
 * the patch-class member declaration matches. */
function _classFromWrapper(def, node) {
  const inner = def.cppType || "";
  const baseTail = inner.replace(/<.*$/, "").split("::").pop() || (node ? node.type : "Inner");
  const className = "Custom" + baseTail;
  const audioIns = (def.ins || []).filter(p => p.t === "audio");
  const oneAudio = audioIns.length === 1;
  const noAudio  = audioIns.length === 0;

  // If the base node has extraCtor (e.g. BiquadLP's
  // "{id}.type(gam::LOW_PASS);", Reverb's resize calls), inline it
  // into the wrapper's constructor so the init still runs against
  // inner_. We rewrite {id}. -> inner_. so the call lands on the
  // library instance. The save path nulls out base.extraCtor when
  // the cppType changes -- otherwise it'd run again on the patch
  // class and call .type() on our wrapper, which doesn't expose it.
  let ctorLines = [];
  (def.extraCtor || []).forEach(t => {
    let raw = "";
    if (typeof t === "function") {
      try { raw = t(node) || ""; } catch (_) { raw = ""; }
    } else {
      raw = String(t || "");
    }
    if (!raw) return;
    // raw may contain "{id}.method(...)" or "{id}." prefixes.
    const rewritten = raw.replace(/\{id\}\./g, "inner_.").replace(/\{id\}/g, "inner_");
    rewritten.split("\n").forEach(line => {
      const trimmed = line.replace(/^\s*/, "");
      if (trimmed) ctorLines.push(trimmed);
    });
  });

  let s = "";
  s += "class " + className + " {\n";
  s += "    " + inner + " inner_;\n";
  s += "public:\n";
  if (ctorLines.length) {
    s += "    " + className + "() {\n";
    ctorLines.forEach(l => { s += "        " + l + "\n"; });
    s += "    }\n";
  }

  // For each param input that has a setter, emit a delegating setter
  // named after the setter (or after the port name if no method
  // override). Uses a Set to dedup if multiple ports share a setter.
  const emittedSetters = new Set();
  const paramMethodsOut = {};
  (def.ins || []).forEach(p => {
    if (p.t !== "param") return;
    const meth = (def.methods && def.methods[p.n]) || p.n;
    // Strip "(...)" so methods like "phase(0.f)" reduce to "phase".
    const setterName = String(meth).replace(/\(.*$/, "");
    if (emittedSetters.has(setterName)) return;
    emittedSetters.add(setterName);
    s += "    void " + setterName + "(float v) { inner_." + setterName + "(v); }\n";
    paramMethodsOut[p.n] = setterName;
  });

  // Gate inputs: emit a delegating method per gate. The gate method
  // ON THE WRAPPER takes float v so codegen's audio-input setter
  // path can call it uniformly; for the gate fire path
  // (`if ((u) > 0.5f) wrapper.method;`) we rely on the literal
  // method-with-args form ("phase(0.f)") which is left in the
  // override.gateMethods unchanged from the base.
  const gateMethodsOut = {};
  (def.ins || []).forEach(p => {
    if (p.t !== "gate") return;
    const meth = (def.gateMethods && def.gateMethods[p.n]) || "reset";
    const isLiteralCall = meth.indexOf("(") >= 0;
    const fnName = String(meth).replace(/\(.*$/, "");
    // Avoid double-emitting if the same method name was already done
    // above as a setter (rare; happens when a port's setter shares
    // the gate's method name).
    if (!emittedSetters.has(fnName)) {
      emittedSetters.add(fnName);
      if (isLiteralCall) {
        // "phase(0.f)" -> emit `void phase(float v)` that delegates so the
        // codegen call `wrap.phase(0.f)` resolves via this setter.
        s += "    void " + fnName + "(float v) { inner_." + fnName + "(v); }\n";
      } else {
        s += "    void " + fnName + "() { inner_." + fnName + "(); }\n";
      }
    }
    // gateMethods stays the same literal so codegen emits the
    // existing `wrap.<literal>` call.
    gateMethodsOut[p.n] = meth;
  });

  if (oneAudio) {
    const a = audioIns[0].n;
    s += "    float operator()(float " + a + ") { return inner_(" + a + "); }\n";
  } else if (noAudio) {
    s += "    float operator()() { return inner_(); }\n";
  } else {
    // Multi-audio wrapper -- rare; emit a noSigArg placeholder.
    audioIns.forEach(p => { s += "    float " + p.n + "_ = 0.f;\n"; });
    audioIns.forEach(p => { s += "    void "  + p.n + "(float v) { " + p.n + "_ = v; }\n"; });
    s += "    float operator()() {\n";
    s += "        // TODO: route audio inputs to the inner type as your library expects.\n";
    s += "        return inner_();\n";
    s += "    }\n";
  }
  s += "};\n";

  // Wire the existing method names (gateMethods stay literal because
  // codegen treats parenthesized methods as call expressions). The
  // additional audio-input setters when multi-audio go in methods.
  const methods = { ...(def.methods || {}), ...paramMethodsOut };
  if (!oneAudio && !noAudio) {
    audioIns.forEach(p => { methods[p.n] = p.n; });
  }
  return { source: s, className, noSigArg: !oneAudio && !noAudio, methods, gateMethods: gateMethodsOut };
}

/* Pick the right pre-fill content for the modal based on the node's
 * code category. Returns { source, sectionLabel, hint, synthClassName,
 * noSigArg } -- the modal uses these to populate the code area and
 * the section-header text. */
function _seedNodeEditCode(def, node) {
  const cat = _nodeCodeCategory(def);
  if (cat === "helper") {
    return {
      source: def.helperClass,
      sectionLabel: "helper class (C++ source)",
      hint: "",
      synthClassName: null,
      noSigArg: !!def.noSigArg
    };
  }
  if (cat === "template") {
    const { source, className, noSigArg } = _classFromTemplate(def, node);
    return {
      source,
      sectionLabel: "synthesized class (was: inline template '" + (def.template || "") + "')",
      hint: "// Original inline template: " + (def.template || "") + "\n// Editing + saving will route this node through a real class instead of the inline template.\n",
      synthClassName: className,
      noSigArg
    };
  }
  if (cat === "wrapper") {
    const { source, className, noSigArg } = _classFromWrapper(def, node);
    return {
      source,
      sectionLabel: "synthesized wrapper class (was: " + (def.cppType || "?") + ")",
      hint: "// Wraps " + (def.cppType || "?") + " from the Gamma library.\n// Edit to customize -- or replace the class entirely with your own.\n",
      synthClassName: className,
      noSigArg
    };
  }
  if (cat === "kind") {
    return {
      source: def.helperClass || ("// This node has special codegen kind '" + def.kind + "'.\n// The current code editor doesn't support overriding the codegen path itself yet.\n// You can still edit ports / cppType, but the kind-specific behavior remains."),
      sectionLabel: "node kind: " + def.kind + " (special codegen path)",
      hint: "",
      synthClassName: null,
      noSigArg: !!def.noSigArg
    };
  }
  return {
    source: "// (no source registered for this node type)\n// Add a class declaration here + a cppType above to provide one.",
    sectionLabel: "helper class (C++ source)",
    hint: "",
    synthClassName: null,
    noSigArg: false
  };
}

/* Pull the current "raw view" fields into a plain state object. */
function _captureRawState() {
  const insHost  = document.getElementById("node-edit-ins");
  const outsHost = document.getElementById("node-edit-outs");
  return {
    cppType:    document.getElementById("node-edit-cppType").value.trim(),
    helperClass: _getRawCode(),
    ins:  (insHost._portsArr  || []).filter(p => p.n).map(p => ({ n: p.n, t: p.t })),
    outs: (outsHost._portsArr || []).filter(p => p.n).map(p => ({ n: p.n, t: p.t })),
    methods:     insHost._methods  || {},
    gateMethods: insHost._gateM    || {}
  };
}

/* Synthesize a .gdsp source from a raw-state object. Used when the
 * user clicks "convert to .gdsp" so the editable text is pre-filled
 * with the equivalent .gdsp format.
 *
 * @gdsp-method is only emitted when the setter name differs from
 * the port name; @gdsp-gate only when it differs from "reset" --
 * matches the convention parseGdsp uses on the way back. */
function _synthGdspSource(raw, baseNode) {
  let s = "";
  // Class name: prefer one extracted from the helperClass body so
  // the @gdsp-name line matches the actual class declaration (which
  // parseGdsp validates). Fall back to cppType, then node type.
  let className = raw.cppType || (baseNode ? baseNode.type : "MyNode");
  const cm = (raw.helperClass || "").match(/class\s+(\w+)/);
  if (cm) className = cm[1];

  const baseDef = baseNode ? TYPES[baseNode.type] : null;
  const category = (baseDef && baseDef.category) || "UserDSP";

  s += "// @gdsp-name        " + className + "\n";
  s += "// @gdsp-category    " + category + "\n";
  if (baseDef && baseDef.description) {
    s += "// @gdsp-description " + String(baseDef.description).split("\n")[0] + "\n";
  }
  (raw.ins || []).forEach(p => {
    // @gdsp-input only supports audio/param/gate per parseGdsp's
    // type check. Visual ports (mesh/camera/texture/etc.) get
    // skipped with a TODO comment so the user notices.
    if (!["audio", "param", "gate"].includes(p.t)) {
      s += "// TODO: input '" + p.n + "' has type '" + p.t + "' which @gdsp-input doesn't accept (audio/param/gate only)\n";
      return;
    }
    let line = "// @gdsp-input       " + p.n + " " + p.t;
    // Include a default for params if the base node carries one.
    if (p.t === "param" && baseNode && baseNode.params && baseNode.params[p.n] !== undefined) {
      line += " " + baseNode.params[p.n];
    }
    s += line + "\n";
  });
  (raw.outs || []).forEach(p => {
    if (!["audio", "param", "gate"].includes(p.t)) {
      s += "// TODO: output '" + p.n + "' has type '" + p.t + "' which @gdsp-output doesn't accept (audio/param/gate only)\n";
      return;
    }
    s += "// @gdsp-output      " + p.n + " " + p.t + "\n";
  });
  Object.keys(raw.methods || {}).forEach(n => {
    const m = raw.methods[n];
    if (m && m !== n) s += "// @gdsp-method      " + n + " " + m + "\n";
  });
  Object.keys(raw.gateMethods || {}).forEach(n => {
    const m = raw.gateMethods[n];
    if (m && m !== "reset") s += "// @gdsp-gate        " + n + " " + m + "\n";
  });
  s += "\n";
  // Body: helperClass if we have one, else a stub the user can fill.
  if (raw.helperClass && raw.helperClass.trim() && !/no helper class/i.test(raw.helperClass)) {
    s += raw.helperClass;
  } else {
    s += "class " + className + " {\npublic:\n    float operator()(float in) { return in; }\n};\n";
  }
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

/* Parse a .gdsp source via the existing buildUserDspDef and map the
 * resulting def into the raw-state shape. Throws on parse / shape
 * errors -- caller surfaces those in the modal's warn area. */
function _parseGdspToState(source) {
  // buildUserDspDef enforces @gdsp-name + at least one @gdsp-input +
  // @gdsp-output and validates the class declaration matches. Throws
  // on mismatch.
  const { def, name } = buildUserDspDef(source);
  return {
    cppType:     def.cppType || name,
    helperClass: stripGdspHeader(source),
    ins:         (def.ins  || []).map(p => ({ n: p.n, t: p.t })),
    outs:        (def.outs || []).map(p => ({ n: p.n, t: p.t })),
    methods:     def.methods     || {},
    gateMethods: def.gateMethods || {}
  };
}

/* Apply a raw-state object back to the "raw view" form fields. */
function _applyRawStateToForm(rawState) {
  document.getElementById("node-edit-cppType").value = rawState.cppType || "";
  _setRawCode(rawState.helperClass || "");
  const insArr  = rawState.ins.map(p => ({ n: p.n, t: p.t }));
  const outsArr = rawState.outs.map(p => ({ n: p.n, t: p.t }));
  const methods = Object.assign({}, rawState.methods || {});
  const gateM   = Object.assign({}, rawState.gateMethods || {});
  _renderPortRows("in",  insArr,  methods, gateM);
  _renderPortRows("out", outsArr, methods, gateM);
}

/* Switch the modal between "raw" (fields) and "gdsp" (single
 * textarea) views. Converts data in the current view's shape into
 * the other shape so edits aren't lost. Surfaces parse errors in
 * the warn area when going gdsp -> raw. */
function _setNodeEditMode(mode) {
  const warnEl = document.getElementById("node-edit-warn");
  warnEl.textContent = ""; warnEl.classList.remove("visible");
  const rawView  = document.getElementById("node-edit-raw-view");
  const gdspView = document.getElementById("node-edit-gdsp-view");
  const toggle   = document.getElementById("btn-node-edit-mode");
  const node = (_nodeEditTargetId != null) ? state.nodes.find(n => n.id === _nodeEditTargetId) : null;

  if (mode === "gdsp") {
    // Pull current raw state, synthesize the .gdsp text, swap views.
    const raw = _captureRawState();
    const src = _synthGdspSource(raw, node);
    _setGdspCode(src);
    rawView.style.display  = "none";
    gdspView.style.display = "";
    toggle.textContent = "← fields";
    toggle.title = "Switch back to the fields view";
    _nodeEditMode = "gdsp";
    // CodeMirror needs a refresh whenever its container goes from
    // display:none to visible -- otherwise it measures 0px high.
    setTimeout(() => { if (_nodeEditCmGdsp) { _nodeEditCmGdsp.refresh(); _nodeEditCmGdsp.focus(); } }, 0);
  } else {
    // Going gdsp -> raw: parse the current .gdsp source and populate
    // the raw form fields. If parse fails, stay in gdsp mode and
    // surface the error so the user can fix it.
    const src = _getGdspCode();
    try {
      const raw = _parseGdspToState(src);
      _applyRawStateToForm(raw);
    } catch (err) {
      warnEl.textContent = ".gdsp parse: " + (err && err.message ? err.message : String(err));
      warnEl.classList.remove("ok");
      warnEl.classList.add("visible");
      return;       // refuse the switch; user fixes the source
    }
    rawView.style.display  = "";
    gdspView.style.display = "none";
    toggle.textContent = ".gdsp →";
    toggle.title = "Toggle between fields view and a single .gdsp source (User DSP format)";
    _nodeEditMode = "raw";
    setTimeout(() => { if (_nodeEditCmRaw) { _nodeEditCmRaw.refresh(); _nodeEditCmRaw.focus(); } }, 0);
  }
}

/* "Validate" -- runs the same checks save runs, surfaces the result
 * in the warn area, but doesn't commit anything. In .gdsp mode this
 * uses buildUserDspDef (the canonical .gdsp parser) and reports the
 * resolved ports / params count; in raw mode it checks class-name
 * match + port-name identifier validity. */
function _validateNodeOverride() {
  const warn = document.getElementById("node-edit-warn");
  function ok(msg)  { warn.textContent = msg; warn.classList.add("visible", "ok"); }
  function bad(msg) { warn.textContent = msg; warn.classList.add("visible"); warn.classList.remove("ok"); }
  if (_nodeEditMode === "gdsp") {
    try {
      const { def, name } = buildUserDspDef(_getGdspCode());
      const np = Object.keys(def.params || {}).length;
      ok("✓ " + name + "  ·  " + def.ins.length + " in, " + def.outs.length + " out, " + np + " param" + (np === 1 ? "" : "s"));
    } catch (err) {
      bad("✗ " + (err && err.message ? err.message : String(err)));
    }
    return;
  }
  // Raw mode -- mirror save's identifier checks + a class-name
  // sanity check between cppType and the source.
  const raw = _captureRawState();
  const cm = (raw.helperClass || "").match(/class\s+(\w+)/);
  // Strip template angle-brackets from cppType for the comparison
  // (e.g. "gam::Sine<>" vs "Sine" in the source -- we compare the
  // tail symbol).
  const cppTail = (raw.cppType || "").replace(/<[^>]*>/g, "").split("::").pop();
  if (cppTail && cm && cm[1] !== cppTail) {
    return bad("✗ cppType '" + raw.cppType + "' doesn't match class name '" + cm[1] + "' in source");
  }
  const seenIn = new Set();
  for (const p of raw.ins) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.n)) return bad("✗ input name '" + p.n + "' isn't a valid identifier");
    if (seenIn.has(p.n)) return bad("✗ duplicate input name '" + p.n + "'");
    seenIn.add(p.n);
  }
  const seenOut = new Set();
  for (const p of raw.outs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.n)) return bad("✗ output name '" + p.n + "' isn't a valid identifier");
    if (seenOut.has(p.n)) return bad("✗ duplicate output name '" + p.n + "'");
    seenOut.add(p.n);
  }
  ok("✓ " + raw.ins.length + " in, " + raw.outs.length + " out  ·  ready to save");
}

/* "Export .gdsp" -- writes the (synthesized or current) .gdsp source
 * to a file the user can save. Reuses exportGdsp's logic via Blob +
 * download anchor. Filename comes from the @gdsp-name when set,
 * otherwise falls back to {nodeType}_{nodeId}.gdsp. */
function _exportNodeAsGdsp() {
  let src;
  if (_nodeEditMode === "gdsp") {
    src = _getGdspCode();
  } else {
    const node = state.nodes.find(n => n && n.id === _nodeEditTargetId);
    src = _synthGdspSource(_captureRawState(), node);
  }
  let fname;
  try {
    const dirs = parseGdsp(src).directives;
    fname = (dirs.name || "").trim();
  } catch (_) {}
  if (!fname) {
    const node = state.nodes.find(n => n && n.id === _nodeEditTargetId);
    fname = node ? (node.type + "_" + node.id) : "node-override";
  }
  const blob = new Blob([src], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fname + ".gdsp";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const warn = document.getElementById("node-edit-warn");
  warn.textContent = "↓ exported " + fname + ".gdsp";
  warn.classList.add("visible", "ok");
}

// Wire the modal's buttons + esc/cmd-enter shortcuts.
document.getElementById("btn-node-edit-close").addEventListener("click", closeNodeCodeEditor);
document.getElementById("btn-node-edit-cancel").addEventListener("click", closeNodeCodeEditor);
document.getElementById("btn-node-edit-save").addEventListener("click", _saveNodeOverride);
document.getElementById("btn-node-edit-revert").addEventListener("click", _revertNodeOverride);
document.getElementById("btn-node-edit-validate").addEventListener("click", _validateNodeOverride);
document.getElementById("btn-node-edit-export").addEventListener("click", _exportNodeAsGdsp);
document.getElementById("btn-node-edit-mode").addEventListener("click", () => {
  _setNodeEditMode(_nodeEditMode === "raw" ? "gdsp" : "raw");
});
// Backdrop click closes (matches other modals).
document.getElementById("node-edit-modal").addEventListener("click", (e) => {
  if (e.target.id === "node-edit-modal") closeNodeCodeEditor();
});

/* Capture-phase keydown gate. Stops main hotkeys from firing while
 * the node editor is open: V/D/W/Z/X/1..5/etc. won't reach their
 * bubble-phase handlers. Allows Esc (close) and Ctrl/Cmd+Enter
 * (save) to pass through to the modal's own handler. */
document.addEventListener("keydown", (e) => {
  if (!_nodeEditorOpen) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeNodeCodeEditor();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    _saveNodeOverride();
    return;
  }
  // Block bubble-phase main hotkeys. Don't block keys inside the
  // modal's inputs / textareas -- the activeElement check + capture
  // semantics let typing pass through naturally; we only need to
  // prevent the keys from triggering CANVAS hotkeys.
  e.stopPropagation();
}, true);

function openNodeEditorForSelection() {
  // Trigger from E key. Only fires when EXACTLY one node is selected
  // AND no group is selected (group-collapse path wins otherwise).
  if (selectedGroupId) return false;
  if (!selectedSet || selectedSet.size !== 1) return false;
  const id = [...selectedSet][0];
  const node = state.nodes.find(n => n && n.id === id);
  if (!node) return false;
  openNodeCodeEditor(id);
  return true;
}

function openRampModal(kind, nodeId) {
  const cfg = RAMP_CONFIG[kind];
  if (!cfg) return;
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const titleEl = document.getElementById("ramp-modal-title");
  const noteEl  = document.getElementById("ramp-modal-note");
  const grid    = document.getElementById("ramp-grid");
  const modal   = document.getElementById("ramp-modal");
  const body    = modal && modal.querySelector(".modal-body");
  if (!titleEl || !grid || !modal || !body) return;
  titleEl.textContent = cfg.title + " · " + node.id;
  noteEl.textContent  = cfg.note;
  const current = (node.params && node.params[cfg.paramKey]) || cfg.defaultKey;
  // Tear down any previously-injected drawing pane before rebuilding.
  const oldPane = body.querySelector(".curve-draw-pane");
  if (oldPane) oldPane.remove();
  grid.innerHTML = "";
  const svgW = 220, svgH = 56;
  cfg.options.forEach(opt => {
    const card = document.createElement("div");
    card.className = "ramp-card" + (opt.key === current ? " active" : "");
    card.dataset.key = opt.key;
    const path = rampSvgPath(opt, kind, svgW, svgH, node);
    card.innerHTML =
      '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" preserveAspectRatio="none">' +
        '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="1.5" />' +
      '</svg>' +
      '<div class="ramp-card-label">' + opt.label + '</div>';
    card.addEventListener("click", () => {
      pushHistory("ramp:" + nodeId);
      node.params[cfg.paramKey] = opt.key;
      // Initialize the LUT lazily on first switch to "custom" so the
      // user has something to draw on.
      if (opt.key === "custom" && (!Array.isArray(node.params.curveTable) || !node.params.curveTable.length)) {
        node.params.curveTable = defaultCurveTable();
      }
      grid.querySelectorAll(".ramp-card").forEach(c => c.classList.remove("active"));
      card.classList.add("active");
      renderMonitorControls();
      renderCode(); renderJson();
      // Show / hide the drawing pane based on selection. All three
      // kinds (ramp / slider / button) share the canvas — semantics
      // differ only in how the LUT is consumed downstream (JS for
      // slider, C++ helperClass for ramp + button).
      const existingPane = body.querySelector(".curve-draw-pane");
      if (opt.key === "custom") {
        if (!existingPane) body.appendChild(buildCurveDrawPane(node));
      } else if (existingPane) {
        existingPane.remove();
      }
    });
    grid.appendChild(card);
  });
  // If we opened straight into "custom" mode, inject the drawing pane up front.
  if (current === "custom") {
    body.appendChild(buildCurveDrawPane(node));
  }
  modal.style.display = "flex";
}
function closeRampModal() {
  const modal = document.getElementById("ramp-modal");
  if (modal) modal.style.display = "none";
}

/* ====================================================================
 * Drawable ADSR (EnvDraw node) modal
 *
 * Single SVG canvas: 64-sample LUT painted with click+drag, plus a
 * draggable vertical sustain marker that splits the curve into the
 * attack half (left, plays start→sustain) and release half (right,
 * plays sustain→end). Saves directly into node.params.curveTable
 * and node.params.sustainIdx; codegen reads both via extraCtor.
 * ================================================================== */

/* ====================================================================
 * Automation lane modal (single + multi)
 *
 * Single-lane: node.params.curveTable holds the drawn shape (256 floats).
 * Multi-lane:  node.params.lanes is an array of 4 entries, each with
 *              { name, min, max, curveTable }.
 *
 * The modal canvas is shared — lane tabs at the top swap which slot
 * the painting writes into. The grid draws beat lines at 1/4 of the
 * curve length (assumes 4 beats / bar) plus heavier bar lines.
 * ================================================================== */

const AUTO_LANE_RES = 256;

function defaultAutoLaneTable() {
  // Default to a flat 0.5 line — neither extreme; user paints from there.
  const t = new Array(AUTO_LANE_RES);
  for (let i = 0; i < AUTO_LANE_RES; i++) t[i] = 0.5;
  return t;
}
function ensureAutoLaneState(node, isMulti) {
  if (!node.params) node.params = {};
  if (isMulti) {
    if (!Array.isArray(node.params.lanes) || node.params.lanes.length !== 4) {
      const tints = ["accent", "info", "param", "gate"];
      node.params.lanes = [0,1,2,3].map(i => ({
        name: "Lane " + (i+1),
        min: 0, max: 1,
        curveTable: defaultAutoLaneTable(),
        tint: tints[i]
      }));
    }
    // Each lane needs a curveTable
    node.params.lanes.forEach(l => {
      if (!Array.isArray(l.curveTable) || !l.curveTable.length) {
        l.curveTable = defaultAutoLaneTable();
      }
    });
  } else {
    if (!Array.isArray(node.params.curveTable) || !node.params.curveTable.length) {
      node.params.curveTable = defaultAutoLaneTable();
    }
  }
}

let _autoLaneActiveTab = 0;   // multi-lane only — which tab is selected

function openAutoLaneModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const isMulti = node.type === "MultiAutomationLane";
  ensureAutoLaneState(node, isMulti);
  _autoLaneActiveTab = 0;
  const titleEl = document.getElementById("auto-lane-modal-title");
  if (titleEl) titleEl.textContent = (isMulti ? "Edit multi-lane automation · " : "Edit automation lane · ") + nodeId;
  const tabsEl = document.getElementById("auto-lane-tabs");
  const paneEl = document.getElementById("auto-lane-pane");
  if (tabsEl) tabsEl.innerHTML = isMulti ? buildAutoLaneTabsHtml(node) : "";
  if (tabsEl && isMulti) {
    tabsEl.querySelectorAll(".al-tab").forEach(b => {
      b.addEventListener("click", () => {
        _autoLaneActiveTab = parseInt(b.dataset.tab, 10) || 0;
        // Re-render tabs (active state) + pane
        tabsEl.innerHTML = buildAutoLaneTabsHtml(node);
        paneEl.innerHTML = "";
        paneEl.appendChild(buildAutoLanePane(node, isMulti));
        // Re-bind tab handlers on the new DOM
        tabsEl.querySelectorAll(".al-tab").forEach(bb => {
          bb.addEventListener("click", arguments.callee);
        });
      });
    });
  }
  if (paneEl) {
    paneEl.innerHTML = "";
    paneEl.appendChild(buildAutoLanePane(node, isMulti));
  }
  const modal = document.getElementById("auto-lane-modal");
  if (modal) modal.style.display = "flex";
}
function closeAutoLaneModal() {
  const modal = document.getElementById("auto-lane-modal");
  if (modal) modal.style.display = "none";
}
(function setupAutoLaneModal() {
  const close = document.getElementById("btn-auto-lane-close");
  const modal = document.getElementById("auto-lane-modal");
  if (close) close.addEventListener("click", closeAutoLaneModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeAutoLaneModal(); });
})();

function buildAutoLaneTabsHtml(node) {
  const lanes = node.params.lanes || [];
  return `<div style="display:flex; gap:6px; margin-bottom: 8px; align-items: center;">
    <span style="font-family: var(--font-mono); font-size: 9.5px; color: var(--text-3); letter-spacing: 0.10em; text-transform: uppercase; padding-right:6px;">Lane</span>
    ${lanes.map((l, i) => {
      const active = (i === _autoLaneActiveTab) ? " active" : "";
      return `<button class="al-tab${active}" data-tab="${i}" style="padding: 4px 10px; background: ${i === _autoLaneActiveTab ? 'var(--accent)' : 'var(--surface-2)'}; color: ${i === _autoLaneActiveTab ? 'var(--accent-ink)' : 'var(--text)'}; border: 1px solid ${i === _autoLaneActiveTab ? 'var(--accent)' : 'var(--border)'}; border-radius: 3px; font-family: var(--font-mono); font-size: 10px; cursor: pointer; font-weight: ${i === _autoLaneActiveTab ? '600' : '400'};">${i+1} · ${escapeText(l.name || ('Lane ' + (i+1)))}</button>`;
    }).join("")}
  </div>`;
}

/* Builds the drawable canvas for a single curve. For multi-lane,
 * `node.params.lanes[_autoLaneActiveTab].curveTable` is the live
 * table; for single, `node.params.curveTable` is. The grid shows
 * vertical beat lines + bar lines + horizontal mid line. */
function buildAutoLanePane(node, isMulti) {
  const W = 680, H = 240;
  const pad = 10;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;

  const slot = isMulti ? node.params.lanes[_autoLaneActiveTab] : node.params;
  const tbl = slot.curveTable;
  const N = tbl.length;
  const bars = (typeof node.params.bars === "number" && node.params.bars > 0) ? node.params.bars : 4;
  // Beats per bar = 4 (assumes 4/4). Vertical lines at every beat;
  // heavier strokes at every bar boundary.
  const totalBeats = Math.max(1, Math.round(bars * 4));

  let gridLines = "";
  for (let i = 0; i <= totalBeats; i++) {
    const x = pad + (i / totalBeats) * plotW;
    const isBar = (i % 4) === 0;
    const stroke = isBar ? "rgba(200,232,90,0.35)" : "rgba(200,232,90,0.10)";
    const w = isBar ? 1 : 0.5;
    gridLines += `<line x1="${x.toFixed(1)}" y1="${pad}" x2="${x.toFixed(1)}" y2="${H - pad}" stroke="${stroke}" stroke-width="${w}" />`;
  }
  // Horizontal mid line
  gridLines += `<line x1="${pad}" y1="${pad + plotH * 0.5}" x2="${W - pad}" y2="${pad + plotH * 0.5}" stroke="rgba(200,232,90,0.10)" stroke-width="0.5" />`;

  const pane = document.createElement("div");
  pane.className = "curve-draw-pane";

  // Lane-specific color tint for multi-lane visualization
  const tintMap = { accent: "var(--accent)", info: "var(--info)", param: "var(--param)", gate: "var(--gate)" };
  const tint = (isMulti && slot.tint && tintMap[slot.tint]) ? tintMap[slot.tint] : "var(--accent)";

  pane.innerHTML =
    '<svg class="curve-draw-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:240px;">' +
      gridLines +
      `<text class="curve-axis-label" x="${pad+2}" y="${pad+10}">${(slot.max != null ? slot.max : 1).toFixed(2)}</text>` +
      `<text class="curve-axis-label" x="${pad+2}" y="${H-pad-2}">${(slot.min != null ? slot.min : 0).toFixed(2)}</text>` +
      `<text class="curve-axis-label" x="${W-pad-30}" y="${H-pad-2}">${bars} bars</text>` +
      `<path class="curve-fill" d="" style="fill: ${tint}; opacity: 0.10;"/>` +
      `<path class="curve-line" d="" style="stroke: ${tint};"/>` +
    '</svg>' +
    '<div class="envdraw-fields">' +
      '<label>Bars</label>' +
      '<input type="number" id="auto-lane-bars" min="0.25" max="64" step="0.25" />' +
      '<label>Min</label>' +
      '<input type="number" id="auto-lane-min" step="any" />' +
      '<span class="envdraw-readout" id="auto-lane-readout">— · —</span>' +
    '</div>' +
    '<div class="envdraw-fields" style="margin-top: 4px;">' +
      '<label>BPM</label>' +
      '<input type="number" id="auto-lane-bpm" min="20" max="999" step="1" />' +
      '<label>Max</label>' +
      '<input type="number" id="auto-lane-max" step="any" />' +
      '<span class="envdraw-readout" id="auto-lane-readout-2">loop · —</span>' +
    '</div>' +
    '<div class="curve-draw-actions">' +
      '<label style="display:flex; align-items:center; gap:6px; font-family: var(--font-mono); font-size: 10px; color: var(--text-2); margin-right: auto;">' +
        '<input type="checkbox" id="auto-lane-loop" />' +
        '<span>Loop</span>' +
      '</label>' +
      '<button class="btn" id="btn-auto-lane-reset">Reset (flat)</button>' +
      '<button class="btn" id="btn-auto-lane-smooth">Smooth</button>' +
      '<button class="btn primary" id="btn-auto-lane-done">Done</button>' +
    '</div>';

  const svg = pane.querySelector(".curve-draw-svg");
  const fillPath = pane.querySelector(".curve-fill");
  const linePath = pane.querySelector(".curve-line");
  const barsInp = pane.querySelector("#auto-lane-bars");
  const bpmInp = pane.querySelector("#auto-lane-bpm");
  const minInp = pane.querySelector("#auto-lane-min");
  const maxInp = pane.querySelector("#auto-lane-max");
  const loopChk = pane.querySelector("#auto-lane-loop");
  const readout = pane.querySelector("#auto-lane-readout");
  const readout2 = pane.querySelector("#auto-lane-readout-2");

  barsInp.value = bars;
  bpmInp.value = (typeof node.params.bpm === "number") ? node.params.bpm : 120;
  // Per-lane min/max in multi mode; top-level in single mode.
  const minRef = isMulti ? slot : node.params;
  minInp.value = (typeof minRef.min === "number") ? minRef.min : 0;
  maxInp.value = (typeof minRef.max === "number") ? minRef.max : 1;
  loopChk.checked = !!node.params.loop;

  function tableToPathData() {
    const pts = [];
    for (let i = 0; i < N; i++) {
      const x = pad + (i / (N - 1)) * plotW;
      const y = pad + (1 - tbl[i]) * plotH;
      pts.push((i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1));
    }
    return pts.join(" ");
  }
  function refreshPaths() {
    const d = tableToPathData();
    linePath.setAttribute("d", d);
    fillPath.setAttribute("d", d + ` L ${pad + plotW},${pad + plotH} L ${pad},${pad + plotH} Z`);
    const lo = parseFloat(minInp.value) || 0;
    const hi = parseFloat(maxInp.value) || 1;
    const bpm = parseFloat(bpmInp.value) || 120;
    const lengthSec = bars * 4 * (60 / bpm);
    readout.textContent = `range ${lo.toFixed(2)} → ${hi.toFixed(2)}`;
    readout2.textContent = `${loopChk.checked ? "loop" : "one-shot"} · ${lengthSec.toFixed(2)} s @ ${bpm} BPM`;
  }
  function paintFromPointer(ev, prev) {
    const r = svg.getBoundingClientRect();
    const sx = W / r.width;
    const sy = H / r.height;
    const px = ((ev.clientX - r.left) * sx - pad) / plotW;
    const py = 1 - ((ev.clientY - r.top) * sy - pad) / plotH;
    const i = Math.round(Math.max(0, Math.min(1, px)) * (N - 1));
    const v = Math.max(0, Math.min(1, py));
    if (prev && prev.i !== undefined) {
      const lo = Math.min(prev.i, i), hi = Math.max(prev.i, i);
      if (hi > lo) {
        const a = (lo === prev.i) ? prev.v : v;
        const b = (lo === prev.i) ? v : prev.v;
        for (let k = lo; k <= hi; k++) {
          const t = (k - lo) / (hi - lo);
          tbl[k] = a * (1 - t) + b * t;
        }
      } else {
        tbl[i] = v;
      }
    } else {
      tbl[i] = v;
    }
    refreshPaths();
    return { i, v };
  }
  let last = null;
  svg.addEventListener("pointerdown", ev => {
    ev.preventDefault();
    svg.setPointerCapture(ev.pointerId);
    pushHistory("auto-lane:" + node.id);
    last = paintFromPointer(ev, null);
  });
  svg.addEventListener("pointermove", ev => {
    if (!last) return;
    last = paintFromPointer(ev, last);
  });
  function endStroke() {
    if (!last) return;
    last = null;
    renderCode(); renderJson();
  }
  svg.addEventListener("pointerup",     endStroke);
  svg.addEventListener("pointercancel", endStroke);
  svg.addEventListener("pointerleave",  () => { if (last) endStroke(); });

  // Field commits — update on change.
  barsInp.addEventListener("change", () => {
    const v = parseFloat(barsInp.value);
    if (isFinite(v) && v > 0) {
      pushHistory("auto-lane:bars:" + node.id);
      node.params.bars = v;
      // Re-render the pane so the grid reflects the new bar count.
      const paneEl = document.getElementById("auto-lane-pane");
      paneEl.innerHTML = "";
      paneEl.appendChild(buildAutoLanePane(node, isMulti));
      renderCode(); renderJson();
    }
  });
  bpmInp.addEventListener("change", () => {
    const v = parseFloat(bpmInp.value);
    if (isFinite(v) && v > 0) {
      pushHistory("auto-lane:bpm:" + node.id);
      node.params.bpm = v;
      refreshPaths();
      renderCode(); renderJson();
    }
  });
  minInp.addEventListener("change", () => {
    const v = parseFloat(minInp.value);
    if (isFinite(v)) {
      pushHistory("auto-lane:min:" + node.id);
      if (isMulti) slot.min = v;
      else         node.params.min = v;
      refreshPaths();
      renderCode(); renderJson();
    }
  });
  maxInp.addEventListener("change", () => {
    const v = parseFloat(maxInp.value);
    if (isFinite(v)) {
      pushHistory("auto-lane:max:" + node.id);
      if (isMulti) slot.max = v;
      else         node.params.max = v;
      refreshPaths();
      renderCode(); renderJson();
    }
  });
  loopChk.addEventListener("change", () => {
    pushHistory("auto-lane:loop:" + node.id);
    node.params.loop = loopChk.checked ? 1 : 0;
    refreshPaths();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-auto-lane-reset").addEventListener("click", () => {
    pushHistory("auto-lane:reset:" + node.id);
    for (let i = 0; i < N; i++) tbl[i] = 0.5;
    refreshPaths();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-auto-lane-smooth").addEventListener("click", () => {
    pushHistory("auto-lane:smooth:" + node.id);
    const nxt = tbl.slice();
    for (let i = 1; i < N - 1; i++) nxt[i] = (tbl[i - 1] + tbl[i] + tbl[i + 1]) / 3;
    for (let i = 0; i < N; i++) tbl[i] = nxt[i];
    refreshPaths();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-auto-lane-done").addEventListener("click", closeAutoLaneModal);

  refreshPaths();
  return pane;
}

function defaultEnvDrawTable() {
  // Triangular peak at index 32 — ramp up, ramp down. Mirrors the
  // helper class's default constructor so the JS preview matches
  // the C++ side before the user paints anything.
  const N = CURVE_TABLE_SIZE;
  const sIdx = Math.floor(N / 2);
  const t = new Array(N);
  for (let i = 0; i <= sIdx; i++)     t[i] = i / sIdx;
  for (let i = sIdx + 1; i < N; i++)  t[i] = (N - 1 - i) / (N - 1 - sIdx);
  return t;
}

function openEnvDrawModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node || !node.params) return;
  if (!Array.isArray(node.params.curveTable) || !node.params.curveTable.length) {
    node.params.curveTable = defaultEnvDrawTable();
  }
  if (typeof node.params.sustainIdx !== "number") {
    node.params.sustainIdx = Math.floor(node.params.curveTable.length / 2);
  }
  const titleEl = document.getElementById("envdraw-modal-title");
  if (titleEl) titleEl.textContent = "Edit envelope · " + nodeId;
  const pane = document.getElementById("envdraw-pane");
  if (pane) {
    pane.innerHTML = "";
    pane.appendChild(buildEnvDrawPane(node));
  }
  const modal = document.getElementById("envdraw-modal");
  if (modal) modal.style.display = "flex";
}
function closeEnvDrawModal() {
  const modal = document.getElementById("envdraw-modal");
  if (modal) modal.style.display = "none";
}
(function setupEnvDrawModal() {
  const close = document.getElementById("btn-envdraw-close");
  const modal = document.getElementById("envdraw-modal");
  if (close) close.addEventListener("click", closeEnvDrawModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeEnvDrawModal(); });
})();

/* =========================================================================
 * v0.3.28 — Color curves modal. Per-channel 16-point LUT editor for
 * the ColorCurves shader-frag node.
 *
 * Modal structure:
 *   - 4 channel tabs (Master / R / G / B). Click switches the active
 *     curve being edited.
 *   - SVG plot with a grid background, the identity diagonal as a
 *     faint guide, all 4 curves overlaid (inactive ones faint), then
 *     16 draggable control points on the active curve.
 *   - Reset / Reset All / Done actions.
 *
 * Identity ramp = [0/15, 1/15, ..., 15/15]. Drag a point up/down to
 * push that input value to a different output value; the in-shader
 * sample_lut function does linear interp between adjacent points.
 *
 * Persistence: writes back to node.params.curveMaster / curveR /
 * curveG / curveB which writeUniforms packs into vec4f slots.
 * ======================================================================== */

const CURVES_N = 64;   // points per curve, bumped from 16 in v0.3.29 for paint-quality fidelity

function defaultCurveN() {
  const a = new Array(CURVES_N);
  for (let i = 0; i < CURVES_N; i++) a[i] = i / (CURVES_N - 1);
  return a;
}

// Channel descriptors. Color values are tuned so the inactive
// overlays read cleanly without distracting from the active curve.
const COLOR_CURVES_CHANNELS = [
  { key: "curveMaster", label: "Master", color: "rgba(220, 220, 220, 0.95)", faint: "rgba(220, 220, 220, 0.22)" },
  { key: "curveR",      label: "R",      color: "rgba(255,  90,  90, 0.95)", faint: "rgba(255,  90,  90, 0.22)" },
  { key: "curveG",      label: "G",      color: "rgba(110, 220,  90, 0.95)", faint: "rgba(110, 220,  90, 0.22)" },
  { key: "curveB",      label: "B",      color: "rgba( 90, 160, 255, 0.95)", faint: "rgba( 90, 160, 255, 0.22)" }
];

function openColorCurvesModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node || !node.params) return;
  // Ensure all four curves exist + are well-formed; default any
  // missing or mis-shaped slot (incl. legacy 16-point arrays from
  // v0.3.28 patches) to a fresh 64-point identity.
  for (const ch of COLOR_CURVES_CHANNELS) {
    if (!Array.isArray(node.params[ch.key]) || node.params[ch.key].length !== CURVES_N) {
      node.params[ch.key] = defaultCurveN();
    }
  }
  const titleEl = document.getElementById("colorcurves-modal-title");
  if (titleEl) titleEl.textContent = "Edit color curves · " + nodeId;
  const pane = document.getElementById("colorcurves-pane");
  if (pane) {
    pane.innerHTML = "";
    pane.appendChild(buildColorCurvesPane(node));
  }
  const modal = document.getElementById("colorcurves-modal");
  if (modal) modal.style.display = "flex";
}
function closeColorCurvesModal() {
  const modal = document.getElementById("colorcurves-modal");
  if (modal) modal.style.display = "none";
}
(function setupColorCurvesModal() {
  const close = document.getElementById("btn-colorcurves-close");
  const modal = document.getElementById("colorcurves-modal");
  if (close) close.addEventListener("click", closeColorCurvesModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeColorCurvesModal(); });
})();

function buildColorCurvesPane(node) {
  const W = 600, H = 320;
  const pad = 18;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  // Paint-mode state. activeIdx is which channel is being edited.
  // painting=true between pointerdown and pointerup. lastIdx/lastVal
  // hold the previous pointer-frame's (LUT index, value) so we can
  // linearly fill the gap on fast drags (no skipped points).
  let activeIdx = 0;
  let painting  = false;
  let lastIdx   = -1;
  let lastVal   = 0;

  const xForI = (i)  => pad + (i / (CURVES_N - 1)) * plotW;
  const yForV = (v)  => pad + (1 - v) * plotH;
  const vForY = (cy) => 1 - (cy - pad) / plotH;
  const iForX = (cx) => Math.round(((cx - pad) / plotW) * (CURVES_N - 1));

  const pane = document.createElement("div");
  pane.className = "curve-draw-pane";

  // Tab strip
  let tabsHtml = '<div class="curve-tabs" style="display:flex;gap:6px;margin-bottom:8px;">';
  COLOR_CURVES_CHANNELS.forEach((ch, idx) => {
    tabsHtml += `<button class="btn curve-tab" data-cc-tab="${idx}" style="flex:1;color:${ch.color};font-weight:${idx === 0 ? 'bold' : 'normal'};">${ch.label}</button>`;
  });
  tabsHtml += '</div>';

  // 8x8 grid + identity diagonal as a faint guide.
  let gridHtml = '';
  for (let g = 1; g < 8; g++) {
    const gx = pad + (g / 8) * plotW;
    const gy = pad + (g / 8) * plotH;
    gridHtml += `<line class="curve-grid" x1="${gx}" y1="${pad}" x2="${gx}" y2="${H - pad}" />`;
    gridHtml += `<line class="curve-grid" x1="${pad}" y1="${gy}" x2="${W - pad}" y2="${gy}" />`;
  }
  const identityDiag = `<line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${pad}" stroke="rgba(255,255,255,0.12)" stroke-dasharray="3,3" />`;

  pane.innerHTML = tabsHtml +
    '<svg class="curve-draw-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="user-select:none;cursor:crosshair;touch-action:none;">' +
      gridHtml +
      identityDiag +
      // 4 channel curves overlaid (inactive faint, active bold) +
      // 8 anchor markers along the active curve as visual reference
      // (no longer draggable -- they just hint at where the eighths
      // are along the input range).
      '<g class="cc-curves"></g>' +
      '<g class="cc-anchors"></g>' +
    '</svg>' +
    '<div class="curve-draw-actions">' +
      '<button class="btn" id="btn-cc-smooth">Smooth</button>' +
      '<button class="btn" id="btn-cc-reset">Reset channel</button>' +
      '<button class="btn" id="btn-cc-reset-all">Reset all</button>' +
      '<span style="flex:1;"></span>' +
      '<button class="btn primary" id="btn-cc-done">Done</button>' +
    '</div>';

  const svg      = pane.querySelector(".curve-draw-svg");
  const curvesG  = pane.querySelector(".cc-curves");
  const anchorsG = pane.querySelector(".cc-anchors");
  const tabBtns  = pane.querySelectorAll("[data-cc-tab]");

  function repaint() {
    // All 4 curves drawn through every point (the 64-point line is
    // already smooth at this resolution -- no need for spline math).
    // Inactive curves render faint, active bold.
    let curvesSvg = '';
    COLOR_CURVES_CHANNELS.forEach((ch, idx) => {
      const arr = node.params[ch.key];
      const stroke = (idx === activeIdx) ? ch.color : ch.faint;
      const width  = (idx === activeIdx) ? 2.0 : 1.0;
      let d = '';
      for (let i = 0; i < CURVES_N; i++) {
        const x = xForI(i).toFixed(1);
        const y = yForV(arr[i]).toFixed(1);
        d += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
      }
      curvesSvg += `<path d="${d}" stroke="${stroke}" stroke-width="${width}" fill="none" stroke-linejoin="round" />`;
    });
    curvesG.innerHTML = curvesSvg;

    // Anchor markers: 8 dots along the active curve at i = 0, 9, 18,
    // 27, 36, 45, 54, 63 (every ~9th point). Purely visual -- they
    // hint at where the 1/8 input divisions are. NOT draggable in
    // paint mode -- drag the line directly.
    const active = COLOR_CURVES_CHANNELS[activeIdx];
    const arr = node.params[active.key];
    let anchorsSvg = '';
    for (let k = 0; k < 8; k++) {
      const i = Math.round(k * (CURVES_N - 1) / 7);
      const x = xForI(i).toFixed(1);
      const y = yForV(arr[i]).toFixed(1);
      anchorsSvg += `<circle cx="${x}" cy="${y}" r="2.5" fill="${active.color}" stroke="rgba(0,0,0,0.4)" stroke-width="0.6" pointer-events="none" />`;
    }
    anchorsG.innerHTML = anchorsSvg;
  }

  function setActive(idx) {
    activeIdx = idx;
    tabBtns.forEach((b, j) => {
      b.style.fontWeight = (j === idx) ? "bold" : "normal";
      b.style.borderColor = (j === idx) ? COLOR_CURVES_CHANNELS[idx].color : "";
    });
    repaint();
  }

  // Paint mode: pointerdown / move / up. The pointerdown sets the
  // first point; each subsequent pointermove paints from the
  // previous (lastIdx, lastVal) to the current (i, v), filling in
  // every LUT index between them with a linearly-interpolated value
  // so fast drags don't leave the curve gappy.
  function paintAt(cx, cy) {
    if (!painting) return;
    const i = Math.max(0, Math.min(CURVES_N - 1, iForX(cx)));
    const v = Math.max(0, Math.min(1, vForY(cy)));
    const arr = node.params[COLOR_CURVES_CHANNELS[activeIdx].key];
    if (lastIdx < 0 || lastIdx === i) {
      arr[i] = v;
    } else {
      // Walk from lastIdx + step toward i, inclusive of i.
      const step = i > lastIdx ? 1 : -1;
      const dist = Math.abs(i - lastIdx);
      for (let k = 1; k <= dist; k++) {
        const j = lastIdx + k * step;
        const t = k / dist;
        arr[j] = lastVal + (v - lastVal) * t;
      }
    }
    lastIdx = i;
    lastVal = v;
    repaint();
  }

  svg.addEventListener("pointerdown", (e) => {
    const rect = svg.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width)  * W;
    const cy = ((e.clientY - rect.top)  / rect.height) * H;
    painting = true;
    lastIdx  = -1;   // first frame uses just the down position
    svg.setPointerCapture(e.pointerId);
    paintAt(cx, cy);
    e.preventDefault();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!painting) return;
    const rect = svg.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width)  * W;
    const cy = ((e.clientY - rect.top)  / rect.height) * H;
    paintAt(cx, cy);
  });
  function endPaint() {
    if (painting) {
      pushHistory("colorcurves:paint:" + node.id + ":" + COLOR_CURVES_CHANNELS[activeIdx].key);
    }
    painting = false;
    lastIdx  = -1;
  }
  svg.addEventListener("pointerup", endPaint);
  svg.addEventListener("pointercancel", endPaint);
  svg.addEventListener("pointerleave", endPaint);

  // Tab clicks.
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-cc-tab"), 10);
      if (!isNaN(idx)) setActive(idx);
    });
  });

  // Smooth: 3-tap moving average pass over the active curve. Useful
  // after a shaky paint stroke -- runs once per click; click again
  // for more smoothing. Endpoints are anchored (i=0, i=63) so the
  // curve doesn't drift away from clean 0..1 range.
  pane.querySelector("#btn-cc-smooth").addEventListener("click", () => {
    const arr = node.params[COLOR_CURVES_CHANNELS[activeIdx].key];
    const next = arr.slice();
    for (let i = 1; i < CURVES_N - 1; i++) {
      next[i] = (arr[i - 1] + arr[i] + arr[i + 1]) / 3;
    }
    node.params[COLOR_CURVES_CHANNELS[activeIdx].key] = next;
    pushHistory("colorcurves:smooth:" + node.id + ":" + COLOR_CURVES_CHANNELS[activeIdx].key);
    repaint();
  });

  // Reset buttons.
  pane.querySelector("#btn-cc-reset").addEventListener("click", () => {
    node.params[COLOR_CURVES_CHANNELS[activeIdx].key] = defaultCurveN();
    pushHistory("colorcurves:reset:" + node.id + ":" + COLOR_CURVES_CHANNELS[activeIdx].key);
    repaint();
  });
  pane.querySelector("#btn-cc-reset-all").addEventListener("click", () => {
    for (const ch of COLOR_CURVES_CHANNELS) node.params[ch.key] = defaultCurveN();
    pushHistory("colorcurves:reset-all:" + node.id);
    repaint();
  });
  pane.querySelector("#btn-cc-done").addEventListener("click", () => {
    closeColorCurvesModal();
  });

  setActive(0);
  return pane;
}

/* Builds the draw pane for an EnvDraw node. Mirrors buildCurveDrawPane
 * but adds a draggable sustain marker (amber dashed vertical line)
 * and tinted regions on either side of it. Painting and sustain-drag
 * use the same pointer-capture pattern; the pointerdown decides which
 * mode (paint vs sustain-drag) based on hit-test against the marker
 * grip. */
function buildEnvDrawPane(node) {
  const W = 520, H = 200;
  const pad = 8;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  const tbl = node.params.curveTable;
  const N = tbl.length;
  const HANDLE_HIT = 12;     // px hit-zone around the sustain line

  const xForIdx = (i) => pad + (i / (N - 1)) * plotW;
  const idxForX = (cx) => Math.round(((cx - pad) / plotW) * (N - 1));

  const pane = document.createElement("div");
  pane.className = "curve-draw-pane";

  const sIdx = node.params.sustainIdx;
  const sx = xForIdx(sIdx).toFixed(1);

  pane.innerHTML =
    '<svg class="curve-draw-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      // Background regions — attack (left) and release (right) tints.
      '<rect class="envdraw-region-attack"  x="' + pad + '" y="' + pad + '" width="' + (sx - pad) + '" height="' + plotH + '" />' +
      '<rect class="envdraw-region-release" x="' + sx  + '" y="' + pad + '" width="' + (W - pad - sx) + '" height="' + plotH + '" />' +
      // Grid + axis labels.
      '<line class="curve-grid" x1="' + pad + '" y1="' + (pad + plotH * 0.5) + '" x2="' + (W - pad) + '" y2="' + (pad + plotH * 0.5) + '" />' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + pad + '" x2="' + (W - pad) + '" y2="' + pad + '" />' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '" />' +
      '<text class="curve-axis-label" x="' + (pad + 2) + '" y="' + (pad + 10) + '">1.0</text>' +
      '<text class="curve-axis-label" x="' + (pad + 2) + '" y="' + (H - pad - 2) + '">0.0</text>' +
      // Curve fill + stroke.
      '<path class="curve-fill" d="" />' +
      '<path class="curve-line" d="" />' +
      // Sustain marker — dashed line plus a fat grip box at the top
      // for easy grabbing. Rendered last so it sits above the curve.
      '<line class="envdraw-sustain-line" x1="' + sx + '" y1="' + pad + '" x2="' + sx + '" y2="' + (H - pad) + '" />' +
      '<rect class="envdraw-sustain-grip" x="' + (sx - 5) + '" y="' + pad + '" width="10" height="10" />' +
      '<text class="envdraw-sustain-label" x="' + (sx - 24) + '" y="' + (pad + 22) + '">SUST</text>' +
    '</svg>' +
    '<div class="envdraw-fields">' +
      '<label>Attack</label>' +
      '<input type="number" id="envdraw-attack" min="0.001" max="10" step="0.01" />' +
      '<label>Release</label>' +
      '<input type="number" id="envdraw-release" min="0.001" max="10" step="0.01" />' +
      '<span class="envdraw-readout" id="envdraw-readout">sustain @ index — / — · 0.0 v</span>' +
    '</div>' +
    '<div class="curve-draw-actions">' +
      '<button class="btn" id="btn-envdraw-reset">Reset shape</button>' +
      '<button class="btn" id="btn-envdraw-smooth">Smooth</button>' +
      '<button class="btn primary" id="btn-envdraw-done">Done</button>' +
    '</div>';

  const svg = pane.querySelector(".curve-draw-svg");
  const fillPath = pane.querySelector(".curve-fill");
  const linePath = pane.querySelector(".curve-line");
  const regAtk = pane.querySelector(".envdraw-region-attack");
  const regRel = pane.querySelector(".envdraw-region-release");
  const sLine  = pane.querySelector(".envdraw-sustain-line");
  const sGrip  = pane.querySelector(".envdraw-sustain-grip");
  const sLabel = pane.querySelector(".envdraw-sustain-label");
  const atkInp = pane.querySelector("#envdraw-attack");
  const relInp = pane.querySelector("#envdraw-release");
  const readout = pane.querySelector("#envdraw-readout");

  atkInp.value = (typeof node.params.attack === "number") ? node.params.attack.toFixed(2) : "0.50";
  relInp.value = (typeof node.params.release === "number") ? node.params.release.toFixed(2) : "0.50";

  function tableToPathData() {
    const pts = [];
    for (let i = 0; i < N; i++) {
      const x = xForIdx(i);
      const y = pad + (1 - tbl[i]) * plotH;
      pts.push((i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1));
    }
    return pts.join(" ");
  }
  function refreshAll() {
    const d = tableToPathData();
    linePath.setAttribute("d", d);
    fillPath.setAttribute("d", d + ` L ${pad + plotW},${pad + plotH} L ${pad},${pad + plotH} Z`);
    const sIdxNow = node.params.sustainIdx;
    const sxNow = xForIdx(sIdxNow);
    regAtk.setAttribute("width", (sxNow - pad).toFixed(1));
    regRel.setAttribute("x", sxNow.toFixed(1));
    regRel.setAttribute("width", (W - pad - sxNow).toFixed(1));
    sLine.setAttribute("x1", sxNow.toFixed(1));
    sLine.setAttribute("x2", sxNow.toFixed(1));
    sGrip.setAttribute("x", (sxNow - 5).toFixed(1));
    sLabel.setAttribute("x", (sxNow - 24).toFixed(1));
    const v = (typeof tbl[sIdxNow] === "number") ? tbl[sIdxNow] : 0;
    readout.textContent = `sustain @ index ${sIdxNow} / ${N - 1} · ${v.toFixed(2)} v`;
  }

  // Mode determined on pointerdown: "paint" (free-draw curve) vs
  // "sustain" (drag the marker). Hit-test the sustain grip first
  // so the marker is always grabbable from anywhere along its
  // vertical extent (within ±HANDLE_HIT pixels).
  let mode = null;
  let last = null;

  function svgCoords(ev) {
    const r = svg.getBoundingClientRect();
    const sx = W / r.width;
    const sy = H / r.height;
    return {
      x: (ev.clientX - r.left) * sx,
      y: (ev.clientY - r.top)  * sy
    };
  }
  function paintAt(c, prev) {
    const px = (c.x - pad) / plotW;
    const py = 1 - (c.y - pad) / plotH;
    const i = Math.round(Math.max(0, Math.min(1, px)) * (N - 1));
    const v = Math.max(0, Math.min(1, py));
    if (prev && prev.i !== undefined) {
      const lo = Math.min(prev.i, i), hi = Math.max(prev.i, i);
      if (hi > lo) {
        const a = (lo === prev.i) ? prev.v : v;
        const b = (lo === prev.i) ? v : prev.v;
        for (let k = lo; k <= hi; k++) {
          const t = (k - lo) / (hi - lo);
          tbl[k] = a * (1 - t) + b * t;
        }
      } else {
        tbl[i] = v;
      }
    } else {
      tbl[i] = v;
    }
    return { i, v };
  }

  svg.addEventListener("pointerdown", ev => {
    ev.preventDefault();
    svg.setPointerCapture(ev.pointerId);
    const c = svgCoords(ev);
    const sxNow = xForIdx(node.params.sustainIdx);
    if (Math.abs(c.x - sxNow) <= HANDLE_HIT) {
      mode = "sustain";
      pushHistory("envdraw:sustain:" + node.id);
    } else {
      mode = "paint";
      pushHistory("envdraw:curve:" + node.id);
      last = paintAt(c, null);
    }
  });
  svg.addEventListener("pointermove", ev => {
    if (!mode) return;
    const c = svgCoords(ev);
    if (mode === "sustain") {
      let i = idxForX(c.x);
      if (i < 1) i = 1;
      if (i > N - 2) i = N - 2;
      node.params.sustainIdx = i;
    } else {
      last = paintAt(c, last);
    }
    refreshAll();
  });
  function endStroke() {
    if (!mode) return;
    mode = null;
    last = null;
    renderCode(); renderJson();
  }
  svg.addEventListener("pointerup",     endStroke);
  svg.addEventListener("pointercancel", endStroke);
  svg.addEventListener("pointerleave", endStroke);

  // Numeric inputs for attack / release time.
  atkInp.addEventListener("change", () => {
    const v = parseFloat(atkInp.value);
    if (isFinite(v) && v > 0) {
      pushHistory("envdraw:attack:" + node.id);
      node.params.attack = v;
      renderCode(); renderJson();
    }
  });
  relInp.addEventListener("change", () => {
    const v = parseFloat(relInp.value);
    if (isFinite(v) && v > 0) {
      pushHistory("envdraw:release:" + node.id);
      node.params.release = v;
      renderCode(); renderJson();
    }
  });

  pane.querySelector("#btn-envdraw-reset").addEventListener("click", () => {
    pushHistory("envdraw:reset:" + node.id);
    const def = defaultEnvDrawTable();
    for (let i = 0; i < N; i++) tbl[i] = def[i];
    node.params.sustainIdx = Math.floor(N / 2);
    refreshAll();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-envdraw-smooth").addEventListener("click", () => {
    pushHistory("envdraw:smooth:" + node.id);
    const nxt = tbl.slice();
    for (let i = 1; i < N - 1; i++) nxt[i] = (tbl[i - 1] + tbl[i] + tbl[i + 1]) / 3;
    for (let i = 0; i < N; i++) tbl[i] = nxt[i];
    refreshAll();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-envdraw-done").addEventListener("click", closeEnvDrawModal);

  refreshAll();
  return pane;
}
(function setupRampModal() {
  const close = document.getElementById("btn-ramp-close");
  const modal = document.getElementById("ramp-modal");
  if (close) close.addEventListener("click", closeRampModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeRampModal(); });
})();

/* ====================================================================
 * PIANO-ROLL EDITOR
 *
 * Pro-grade time × pitch sequencer modeled after Ableton Live, rendered
 * through the lab-instrument lens (CRT phosphor on near-black). Layout
 * is a 2×3 CSS grid:
 *
 *     ┌──────┬───────────────┐
 *     │ corn │ ruler         │   ← 28px ruler (bar.beat numbers)
 *     ├──────┼───────────────┤
 *     │ keys │ NOTE GRID     │   ← scroll origin (X + Y)
 *     │      │ ── scrolls ── │
 *     ├──────┼───────────────┤
 *     │ vC   │ velocity lane │   ← scrolls X with grid
 *     └──────┴───────────────┘
 *
 * Sub-divs around the grid (`overflow: hidden`) get their scrollLeft /
 * scrollTop driven by JS so everything stays aligned.
 *
 * Tools:   draw / select / erase
 * Snap:    1/16, 1/8, 1/4, 1/2, 1/1 (snap is delta-quantized for moves
 *          so off-grid notes preserve their off-grid offsets)
 * Zoom:    H × V independent presets
 * Selection: stable runtime ids on each note so re-renders don't lose
 *          the selection set.
 *
 * Storage: node.params.notes = [{ start, dur, midi, vel }, ...]. The
 * runtime adds an `_id` to each note for selection tracking; the
 * codegen + serializer ignore it (see extraCtor in the registry —
 * iterates explicit fields only).
 * ================================================================== */

const PR_PITCH_LO = 36;                       // MIDI C2 (lowest visible)
const PR_PITCH_HI = 96;                       // MIDI C7 (exclusive upper)
const PR_KEYS_W   = 64;
const PR_RULER_H  = 28;
const PR_VEL_H    = 110;
const PR_HANDLE_W = 6;                        // resize-handle width (px, screen)

const PR_ZOOM_X = [12, 18, 28, 42, 64, 96];   // px per step
const PR_ZOOM_Y = [10, 14, 18, 24, 32];       // px per pitch row
const PR_SNAP_VALUES = [1, 2, 4, 8, 16];      // steps per snap
const PR_SNAP_LABELS = ["1/16", "1/8", "1/4", "1/2", "1/1"];

const NOTE_NAMES_PR = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function prMidiName(m) {
  const idx = ((m % 12) + 12) % 12;
  return NOTE_NAMES_PR[idx] + Math.floor(m / 12 - 1);
}
function prPitchClass(m) { return ((m % 12) + 12) % 12; }
function prIsBlackKey(m) {
  const c = prPitchClass(m);
  return c === 1 || c === 3 || c === 6 || c === 8 || c === 10;
}
function prIsCKey(m) { return prPitchClass(m) === 0; }

/* Stable runtime ids on notes — selection set is keyed by these so
 * full re-renders don't blow away the selection. Stripped implicitly
 * on serialize because extraCtor iterates only the canonical fields. */
let _prNoteIdCounter = 1;
function prEnsureIds(notes) {
  notes.forEach(n => { if (n && n._id == null) n._id = "n" + (_prNoteIdCounter++); });
}

/* Editor state. Tool / snap / zoom persist across opens — once you set
 * them the first time you don't have to set them every time.
 *
 * Multi-track fields (multi / activeTrack) are populated when the
 * modal opens on a MultiPianoRoll node; for the single-track
 * PianoRoll they stay at default and the codepaths below silently
 * collapse to the single-track behavior. */
const _prEd = {
  nodeId:   null,
  multi:    false,                // true when editing a MultiPianoRoll
  activeTrack: 0,                 // 0..3 (multi mode)
  tool:     "draw",
  snapIx:   0,                    // index into PR_SNAP_VALUES
  zoomX:    2,                    // index into PR_ZOOM_X
  zoomY:    1,                    // index into PR_ZOOM_Y
  defaultVel: 1.0,
  selected: new Set(),            // runtime _ids
  drag:     null,                 // { kind, ... } during pointerdown..up
  hoverCell:null,                 // { step, midi } | null
};

/* Track of a note (defaulting to 0 for legacy single-track patches). */
function prTrackOf(n) { return (n && typeof n.track === "number") ? n.track : 0; }
function prIsActiveTrack(n) { return !_prEd.multi || prTrackOf(n) === _prEd.activeTrack; }

/* Backwards-compat alias — older code in this file references
 * _pianoRollNodeId / _pianoRollVel directly. Keep the names live. */
let _pianoRollNodeId = null;
let _pianoRollVel    = 1.0;

function prCellW() { return PR_ZOOM_X[_prEd.zoomX]; }
function prCellH() { return PR_ZOOM_Y[_prEd.zoomY]; }
function prSnapSteps() { return PR_SNAP_VALUES[_prEd.snapIx] || 1; }
function prRoundSnap(steps) {
  const s = prSnapSteps();
  return Math.round(steps / s) * s;
}

function prGetNode() {
  return state.nodes.find(n => n.id === _prEd.nodeId);
}
function prGetLen() {
  const n = prGetNode();
  if (!n) return 16;
  if (_prEd.multi) return prGetLenForTrack(_prEd.activeTrack);
  return Math.max(1, Math.min(64, parseInt(n.params.patternLen, 10) || 16));
}
/* Per-track pattern length lookup. Used by note-draw bounds checks
 * (inactive tracks may have a different length than the active one
 * — we want their notes to still render, clamped to their own
 * track's length, not the active track's). */
function prGetLenForTrack(track) {
  const n = prGetNode();
  if (!n) return 16;
  if (_prEd.multi) {
    const lens = Array.isArray(n.params.patternLens) ? n.params.patternLens : [16, 16, 16, 16];
    const v = parseInt(lens[track], 10);
    return Math.max(1, Math.min(64, isFinite(v) ? v : 16));
  }
  return Math.max(1, Math.min(64, parseInt(n.params.patternLen, 10) || 16));
}
/* Sets the active track's pattern length in either single- or multi-track
 * mode and trims notes that fall outside the new range. */
function prSetLen(v) {
  const node = prGetNode();
  if (!node) return;
  v = Math.max(1, Math.min(64, parseInt(v, 10) || 16));
  pushHistory("pr:len:" + node.id);
  if (_prEd.multi) {
    if (!Array.isArray(node.params.patternLens)) node.params.patternLens = [16, 16, 16, 16];
    node.params.patternLens[_prEd.activeTrack] = v;
    if (Array.isArray(node.params.notes)) {
      // Only trim notes belonging to the active track; other tracks'
      // patterns are independent.
      node.params.notes = node.params.notes.filter(n => {
        if (!n) return false;
        if (prTrackOf(n) !== _prEd.activeTrack) return true;
        return n.start < v;
      });
    }
  } else {
    node.params.patternLen = v;
    if (Array.isArray(node.params.notes)) {
      node.params.notes = node.params.notes.filter(n => n && n.start < v);
    }
  }
}

/* ── Rendering ──────────────────────────────────────────────────── */

function renderPianoRollGrid() {
  // Public name kept for the rest of the codebase that calls it.
  renderPianoRoll();
}

function renderPianoRoll() {
  const node = prGetNode();
  if (!node) return;
  if (!Array.isArray(node.params.notes)) node.params.notes = [];
  prEnsureIds(node.params.notes);

  const len   = prGetLen();
  const cellW = prCellW();
  const cellH = prCellH();
  const pitchCount = PR_PITCH_HI - PR_PITCH_LO;
  const gridW = len * cellW;
  const gridH = pitchCount * cellH;

  const wrap = document.getElementById("pr-grid-wrap");
  // Snapshot scroll before re-render so we can restore it.
  const sX = wrap ? wrap.scrollLeft : 0;
  const sY = wrap ? wrap.scrollTop  : 0;

  prRenderRuler(len, cellW);
  prRenderKeys(pitchCount, cellH);
  prRenderGrid(node, len, cellW, cellH, pitchCount, gridW, gridH);
  prRenderVel(node, len, cellW, gridW);

  if (wrap) {
    wrap.scrollLeft = sX;
    wrap.scrollTop  = sY;
  }
  prSyncScroll();

  prRenderStatus(node);
  prRenderReadout();
  prSyncToolbar();
}

function prRenderRuler(len, cellW) {
  const svg = document.getElementById("pr-ruler");
  if (!svg) return;
  const W = len * cellW;
  const H = PR_RULER_H;
  svg.setAttribute("width",  W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  let html = "";
  for (let s = 0; s <= len; s++) {
    const x = s * cellW;
    if (s % 16 === 0) {
      html += `<line class="pr-bar-line" x1="${x}" y1="0" x2="${x}" y2="${H}" />`;
      if (s < len) {
        const bar = (s / 16) + 1;
        html += `<text class="pr-bar-num" x="${x + 5}" y="${H - 9}">${bar}</text>`;
      }
    } else if (s % 4 === 0) {
      html += `<line class="pr-beat-line" x1="${x}" y1="${H * 0.4}" x2="${x}" y2="${H}" />`;
      if (s < len && cellW >= 22) {
        const beat = ((s % 16) / 4) + 1;
        const bar  = Math.floor(s / 16) + 1;
        html += `<text class="pr-step-num" x="${x + 3}" y="${H - 9}">${bar}.${beat}</text>`;
      }
    } else {
      html += `<line class="pr-step-line" x1="${x}" y1="${H * 0.7}" x2="${x}" y2="${H}" />`;
    }
  }
  // Pattern-end barrier
  html += `<line class="pr-end-line" x1="${len * cellW - 0.5}" y1="0" x2="${len * cellW - 0.5}" y2="${H}" />`;
  svg.innerHTML = html;
}

function prRenderKeys(pitchCount, cellH) {
  const svg = document.getElementById("pr-keys");
  if (!svg) return;
  const W = PR_KEYS_W;
  const H = pitchCount * cellH;
  svg.setAttribute("width",  W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  let html = "";
  for (let r = 0; r < pitchCount; r++) {
    const midi = PR_PITCH_HI - 1 - r;
    const y = r * cellH;
    const isC = prIsCKey(midi);
    const isB = prIsBlackKey(midi);
    const cls = isC ? "pr-key-c" : (isB ? "pr-key-black" : "pr-key-white");
    html += `<rect class="${cls}" x="0" y="${y}" width="${W}" height="${cellH}" data-midi="${midi}" />`;
    if (isB) {
      // Inset darker cap on the right, mimicking a real piano keyboard.
      html += `<rect class="pr-key-cap" x="${W * 0.50}" y="${y + 1}" width="${W * 0.50}" height="${cellH - 2}" />`;
    }
    // Label every C, plus boundary rows for orientation when zoomed in.
    if (isC) {
      const labelCls = "pr-key-label pr-key-label-c";
      const fz = Math.max(8, Math.min(11, cellH * 0.7));
      html += `<text class="${labelCls}" x="6" y="${y + cellH * 0.7}" font-size="${fz}">${prMidiName(midi)}</text>`;
    } else if (cellH >= 18) {
      // At higher zoom, label every white key for finer orientation.
      if (!isB) {
        html += `<text class="pr-key-label" x="6" y="${y + cellH * 0.7}">${prMidiName(midi)}</text>`;
      }
    }
  }
  svg.innerHTML = html;
}

function prRenderGrid(node, len, cellW, cellH, pitchCount, gridW, gridH) {
  const svg = document.getElementById("pr-grid");
  if (!svg) return;
  svg.setAttribute("width",  gridW);
  svg.setAttribute("height", gridH);
  svg.setAttribute("viewBox", `0 0 ${gridW} ${gridH}`);

  let html = "";
  // Row backgrounds — black-key rows recede, C rows get a faint phosphor
  // wash so the user can find octaves at a glance.
  for (let r = 0; r < pitchCount; r++) {
    const midi = PR_PITCH_HI - 1 - r;
    const y = r * cellH;
    const isC = prIsCKey(midi);
    const isB = prIsBlackKey(midi);
    const cls = isC ? "pr-row-c" : (isB ? "pr-row-black" : "pr-row-white");
    html += `<rect class="${cls}" x="0" y="${y}" width="${gridW}" height="${cellH}" />`;
  }
  // Horizontal pitch lines — emphasize each octave (B→C boundary).
  for (let r = 0; r <= pitchCount; r++) {
    const y = r * cellH;
    const midi = r < pitchCount ? PR_PITCH_HI - 1 - r : PR_PITCH_LO;
    const cls = prIsCKey(midi) ? "pr-step-line" : "pr-grid-line";
    html += `<line class="${cls}" x1="0" y1="${y}" x2="${gridW}" y2="${y}" />`;
  }
  // Vertical step lines — bars > beats > steps, intensity stepped down.
  for (let s = 0; s <= len; s++) {
    const x = s * cellW;
    const cls = (s % 16 === 0) ? "pr-bar-line"
              : (s % 4  === 0) ? "pr-beat-line"
              :                  "pr-step-line";
    html += `<line class="${cls}" x1="${x}" y1="0" x2="${x}" y2="${gridH}" />`;
  }
  // Notes with resize handles. In multi-track mode each note is
  // colored by its `track` field; inactive-track notes get a dim
  // class and don't render handles (and pointer-events go to their
  // siblings). The active-track set wraps single-track behavior.
  const notes = node.params.notes;
  // Render inactive-track notes first so active-track ones stack on top.
  const drawNote = (nt, drawHandles) => {
    if (!nt || nt.midi == null) return "";
    if (nt.midi < PR_PITCH_LO || nt.midi >= PR_PITCH_HI) return "";
    const ntLen = _prEd.multi ? prGetLenForTrack(prTrackOf(nt)) : len;
    if (nt.start < 0 || nt.start >= ntLen) return "";
    const dur = Math.max(1, Math.min(ntLen - nt.start, nt.dur || 1));
    const x = nt.start * cellW + 1;
    const y = (PR_PITCH_HI - 1 - nt.midi) * cellH + 1;
    const w = dur * cellW - 2;
    const h = cellH - 2;
    const sel = _prEd.selected.has(nt._id) ? " selected" : "";
    const tr  = prTrackOf(nt);
    const trCls   = _prEd.multi ? ` track-${tr + 1}` : "";
    const inactCls = (_prEd.multi && tr !== _prEd.activeTrack) ? " inactive-track" : "";
    const v = nt.vel != null ? nt.vel : 1;
    const op = Math.max(0.55, Math.min(1, 0.55 + 0.45 * v));
    let s = `<rect class="pr-note${sel}${trCls}${inactCls}" data-nid="${nt._id}" x="${x}" y="${y}" width="${w}" height="${h}" rx="2" opacity="${op}" />`;
    if (drawHandles && !inactCls && w > PR_HANDLE_W * 1.6) {
      s += `<rect class="pr-note-handle" data-nid="${nt._id}" data-handle="1" x="${x + w - PR_HANDLE_W}" y="${y}" width="${PR_HANDLE_W}" height="${h}" rx="1" />`;
    }
    return s;
  };
  // Pass 1 — inactive tracks (drawn behind)
  if (_prEd.multi) {
    notes.forEach(nt => { if (prTrackOf(nt) !== _prEd.activeTrack) html += drawNote(nt, false); });
    notes.forEach(nt => { if (prTrackOf(nt) === _prEd.activeTrack) html += drawNote(nt, true);  });
  } else {
    notes.forEach(nt => { html += drawNote(nt, true); });
  }
  // Transient overlays (preview / marquee / crosshair) — JS toggles them
  // via attribute instead of re-rendering the whole grid.
  html += `<rect class="pr-preview" x="0" y="0" width="0" height="0" style="display:none" />`;
  html += `<rect class="pr-marquee" x="0" y="0" width="0" height="0" style="display:none" />`;
  html += `<line class="pr-cross-v" x1="0" y1="0" x2="0" y2="${gridH}" style="display:none" />`;
  html += `<line class="pr-cross-h" x1="0" y1="0" x2="${gridW}" y2="0" style="display:none" />`;
  svg.innerHTML = html;
}

function prRenderVel(node, len, cellW, gridW) {
  const svg = document.getElementById("pr-vel");
  if (!svg) return;
  const H = PR_VEL_H;
  svg.setAttribute("width",  gridW);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${gridW} ${H}`);
  let html = "";
  // Background bar/beat ticks
  for (let s = 0; s <= len; s++) {
    const x = s * cellW;
    const cls = (s % 16 === 0) ? "pr-bar-line"
              : (s % 4  === 0) ? "pr-beat-line"
              :                  "pr-step-line";
    html += `<line class="${cls}" x1="${x}" y1="0" x2="${x}" y2="${H}" />`;
  }
  [0.25, 0.5, 0.75].forEach(v => {
    const y = H - v * H;
    html += `<line class="pr-vel-grid" x1="0" y1="${y}" x2="${gridW}" y2="${y}" />`;
  });
  html += `<line class="pr-vel-baseline" x1="0" y1="${H - 0.5}" x2="${gridW}" y2="${H - 0.5}" />`;

  const notes = node.params.notes;
  // Same track-stacking pattern as the grid: inactive tracks behind,
  // active in front. Inactive bars are unselectable + faded.
  const drawVelBar = (nt) => {
    if (!nt || nt.midi == null) return "";
    const ntLen = _prEd.multi ? prGetLenForTrack(prTrackOf(nt)) : len;
    if (nt.start < 0 || nt.start >= ntLen) return "";
    const x = nt.start * cellW + 2;
    const w = Math.max(2, cellW - 4);
    const v = nt.vel != null ? nt.vel : 1;
    const barH = Math.max(2, v * (H - 4));
    const y = H - barH - 1;
    const sel = _prEd.selected.has(nt._id) ? " selected" : "";
    const tr  = prTrackOf(nt);
    const trCls    = _prEd.multi ? ` track-${tr + 1}` : "";
    const inactCls = (_prEd.multi && tr !== _prEd.activeTrack) ? " inactive-track" : "";
    let s = `<rect class="pr-vel-bar${sel}${trCls}${inactCls}" data-nid="${nt._id}" x="${x}" y="${y}" width="${w}" height="${barH}" rx="1" />`;
    if (!inactCls) {
      s += `<rect class="pr-vel-handle" data-nid="${nt._id}" x="${x - 1}" y="${y - 3}" width="${w + 2}" height="6" rx="1" />`;
    }
    return s;
  };
  if (_prEd.multi) {
    notes.forEach(nt => { if (prTrackOf(nt) !== _prEd.activeTrack) html += drawVelBar(nt); });
    notes.forEach(nt => { if (prTrackOf(nt) === _prEd.activeTrack) html += drawVelBar(nt); });
  } else {
    notes.forEach(nt => { html += drawVelBar(nt); });
  }
  svg.innerHTML = html;
}

function prRenderStatus(node) {
  const cnt = document.getElementById("pr-stat-count");
  const sel = document.getElementById("pr-stat-selected");
  const snp = document.getElementById("pr-stat-snap");
  if (cnt) cnt.textContent = String((node.params.notes || []).length);
  if (sel) sel.textContent = String(_prEd.selected.size);
  if (snp) snp.textContent = PR_SNAP_LABELS[_prEd.snapIx] || "1/16";
}

function prRenderReadout() {
  const r = document.getElementById("pianoroll-readout");
  if (!r) return;
  const c = _prEd.hoverCell;
  if (!c) { r.textContent = "PITCH —    POS —.—.—"; return; }
  const bar  = Math.floor(c.step / 16) + 1;
  const beat = Math.floor((c.step % 16) / 4) + 1;
  const six  = (c.step % 4) + 1;
  const name = prMidiName(c.midi);
  r.textContent = `PITCH ${name.padEnd(4)}  POS ${bar}.${beat}.${six}`;
}

function prSyncToolbar() {
  document.querySelectorAll(".pr-tool").forEach(b => {
    b.classList.toggle("active", b.dataset.tool === _prEd.tool);
  });
  document.querySelectorAll(".pr-track").forEach(b => {
    b.classList.toggle("active", parseInt(b.dataset.track, 10) === _prEd.activeTrack);
  });
  const wrap = document.getElementById("pr-grid-wrap");
  if (wrap) wrap.dataset.tool = _prEd.tool;
  const snapEl = document.getElementById("pr-snap");
  if (snapEl) snapEl.value = String(_prEd.snapIx);
  // Sync the length + default-velocity inputs to the active track's
  // values when in multi-track mode (so switching tabs updates them).
  if (_prEd.multi) {
    const node = prGetNode();
    if (node) {
      const lenEl = document.getElementById("pianoroll-len");
      const velEl = document.getElementById("pianoroll-vel");
      if (lenEl && document.activeElement !== lenEl) lenEl.value = prGetLen();
      if (velEl && document.activeElement !== velEl) {
        const dv = (Array.isArray(node.params.defaultVels) ? Number(node.params.defaultVels[_prEd.activeTrack]) : 1) || 1;
        _prEd.defaultVel = dv;
        velEl.value = dv.toFixed(2);
      }
    }
  }
}

/* Switch which track is active in multi-track mode. Clears the
 * selection (selection from track A doesn't carry to track B), syncs
 * the toolbar, and re-renders so coloring reflects the new active. */
function prSetActiveTrack(track) {
  if (!_prEd.multi) return;
  track = Math.max(0, Math.min(3, track));
  if (track === _prEd.activeTrack) return;
  _prEd.activeTrack = track;
  _prEd.selected.clear();
  const node = prGetNode();
  if (node) node.params.activeTrack = track;
  renderPianoRoll();
}

function prSyncScroll() {
  const wrap  = document.getElementById("pr-grid-wrap");
  const ruler = document.querySelector(".pr-ruler-wrap");
  const keys  = document.querySelector(".pr-keys-wrap");
  const vel   = document.querySelector(".pr-vel-wrap");
  if (!wrap || !ruler || !keys || !vel) return;
  ruler.scrollLeft = wrap.scrollLeft;
  keys.scrollTop   = wrap.scrollTop;
  vel.scrollLeft   = wrap.scrollLeft;
}

/* ── Hit testing & cell math ────────────────────────────────────── */

function prCellAt(ev) {
  const svg = document.getElementById("pr-grid");
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  const cellW = prCellW(), cellH = prCellH();
  const cx = ev.clientX - r.left;
  const cy = ev.clientY - r.top;
  if (cx < 0 || cy < 0 || cx > r.width || cy > r.height) return null;
  const step = Math.floor(cx / cellW);
  const row  = Math.floor(cy / cellH);
  const len  = prGetLen();
  const pitchCount = PR_PITCH_HI - PR_PITCH_LO;
  if (step < 0 || step >= len) return null;
  if (row  < 0 || row  >= pitchCount) return null;
  return { step, midi: PR_PITCH_HI - 1 - row, x: cx, y: cy };
}

function prFindNote(nid) {
  const node = prGetNode();
  if (!node) return null;
  return (node.params.notes || []).find(n => n._id === nid) || null;
}

/* ── Interaction: pointer on the grid ───────────────────────────── */

function prInstallGridHandlers() {
  const svg = document.getElementById("pr-grid");
  const wrap = document.getElementById("pr-grid-wrap");
  if (!svg || !wrap) return;

  svg.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const node = prGetNode();
    if (!node) return;
    const target = ev.target;
    const isHandle = target && target.classList.contains("pr-note-handle");
    const isNote   = target && target.classList.contains("pr-note");
    const cell = prCellAt(ev);

    // Erase tool — click any note (or its handle) deletes it.
    if (_prEd.tool === "erase") {
      if (isNote || isHandle) {
        const nid = target.dataset.nid;
        prDeleteNotes([nid]);
      }
      return;
    }

    // Resize handle (any tool except erase): drag right edge to lengthen.
    if (isHandle) {
      const nid = target.dataset.nid;
      // If clicking handle of a non-selected note, replace selection.
      if (!_prEd.selected.has(nid)) {
        _prEd.selected = new Set([nid]);
      }
      const orig = {};
      _prEd.selected.forEach(id => {
        const nt = prFindNote(id);
        if (nt) orig[id] = { start: nt.start, dur: nt.dur };
      });
      _prEd.drag = { kind: "resize", anchor: cell, orig };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      pushHistory("pr:resize:" + node.id);
      return;
    }

    // Note body click — depends on tool.
    if (isNote) {
      const nid = target.dataset.nid;
      if (_prEd.tool === "draw") {
        // In pencil mode, clicking a note picks it up to move.
        if (!_prEd.selected.has(nid)) _prEd.selected = new Set([nid]);
      } else { // select
        if (ev.shiftKey) {
          if (_prEd.selected.has(nid)) _prEd.selected.delete(nid);
          else _prEd.selected.add(nid);
        } else if (!_prEd.selected.has(nid)) {
          _prEd.selected = new Set([nid]);
        }
      }
      const orig = {};
      _prEd.selected.forEach(id => {
        const nt = prFindNote(id);
        if (nt) orig[id] = { start: nt.start, midi: nt.midi };
      });
      _prEd.drag = { kind: "move", anchor: cell, orig, moved: false };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      // Snapshot history at drag start so undo reverts to the pre-drag
      // layout. If the user clicks without dragging the snapshot is a
      // duplicate of the current state — harmless (one extra no-op undo).
      pushHistory("pr:move:" + node.id);
      renderPianoRoll();
      return;
    }

    // Empty grid — depends on tool.
    if (!cell) return;
    if (_prEd.tool === "draw") {
      if (!ev.shiftKey) _prEd.selected.clear();
      _prEd.drag = { kind: "draw", anchor: cell };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      prShowPreview(cell.step, cell.midi, 1);
    } else if (_prEd.tool === "select") {
      if (!ev.shiftKey) _prEd.selected.clear();
      _prEd.drag = { kind: "marquee", origin: cell, startMembers: new Set(_prEd.selected) };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    }
    renderPianoRoll();
  });

  svg.addEventListener("pointermove", ev => {
    const cell = prCellAt(ev);
    _prEd.hoverCell = cell;
    prRenderReadout();
    prShowCrosshair(ev);
    const drag = _prEd.drag;
    if (!drag) return;
    if (drag.kind === "draw") {
      if (!cell) return;
      const lo = Math.min(drag.anchor.step, cell.step);
      const hi = Math.max(drag.anchor.step, cell.step);
      prShowPreview(lo, drag.anchor.midi, hi - lo + 1);
    } else if (drag.kind === "move") {
      if (!cell) return;
      const dStep = prRoundSnap(cell.step - drag.anchor.step);
      const dMidi = cell.midi - drag.anchor.midi;
      if (dStep !== 0 || dMidi !== 0) drag.moved = true;
      prApplyMovePreview(drag, dStep, dMidi);
    } else if (drag.kind === "resize") {
      if (!cell) return;
      const dStep = prRoundSnap(cell.step - drag.anchor.step);
      prApplyResizePreview(drag, dStep);
    } else if (drag.kind === "marquee") {
      if (!cell) return;
      prUpdateMarquee(drag.origin, cell);
      prMarqueeSelect(drag.origin, cell, drag.startMembers);
    }
  });

  function endDrag(ev) {
    const drag = _prEd.drag;
    if (!drag) return;
    if (drag.kind === "draw") {
      const cell = prCellAt(ev) || drag.anchor;
      const node = prGetNode();
      if (node) {
        const lo = Math.min(drag.anchor.step, cell.step);
        const hi = Math.max(drag.anchor.step, cell.step);
        const dur = Math.max(1, hi - lo + 1);
        pushHistory("pr:add:" + node.id);
        const newNote = { start: lo, dur, midi: drag.anchor.midi, vel: _prEd.defaultVel, _id: "n" + (_prNoteIdCounter++) };
        // Multi-track: the new note is born on the active track. The
        // codegen + .gpatch round-trip preserve the field; legacy
        // single-track patches simply omit it.
        if (_prEd.multi) newNote.track = _prEd.activeTrack;
        node.params.notes.push(newNote);
        // Auto-select the just-drawn note for chained operations.
        _prEd.selected = new Set([newNote._id]);
      }
    }
    // Move / resize already mutated state in the live preview; commit
    // means clear the drag state and renormalize.
    _prEd.drag = null;
    prHidePreview();
    prHideMarquee();
    renderPianoRoll();
    renderCode(); renderJson(); renderProps();
  }
  svg.addEventListener("pointerup",     endDrag);
  svg.addEventListener("pointercancel", () => {
    _prEd.drag = null; prHidePreview(); prHideMarquee(); renderPianoRoll();
  });
  svg.addEventListener("pointerleave", () => {
    _prEd.hoverCell = null;
    prRenderReadout();
    prHideCrosshair();
  });
}

function prShowPreview(step, midi, dur) {
  const el = document.querySelector("#pr-grid .pr-preview");
  if (!el) return;
  if (midi < PR_PITCH_LO || midi >= PR_PITCH_HI) {
    el.setAttribute("style", "display:none"); return;
  }
  const cellW = prCellW(), cellH = prCellH();
  const x = step * cellW + 1;
  const y = (PR_PITCH_HI - 1 - midi) * cellH + 1;
  const w = dur * cellW - 2;
  const h = cellH - 2;
  el.setAttribute("x", x);
  el.setAttribute("y", y);
  el.setAttribute("width", Math.max(2, w));
  el.setAttribute("height", Math.max(2, h));
  el.setAttribute("rx", "2");
  el.setAttribute("style", "");
}
function prHidePreview() {
  const el = document.querySelector("#pr-grid .pr-preview");
  if (el) el.setAttribute("style", "display:none");
}

function prUpdateMarquee(origin, cell) {
  const el = document.querySelector("#pr-grid .pr-marquee");
  if (!el) return;
  const cellW = prCellW(), cellH = prCellH();
  const x1 = Math.min(origin.x, cell.x);
  const y1 = Math.min(origin.y, cell.y);
  const w  = Math.abs(cell.x - origin.x);
  const h  = Math.abs(cell.y - origin.y);
  el.setAttribute("x", x1);
  el.setAttribute("y", y1);
  el.setAttribute("width", w);
  el.setAttribute("height", h);
  el.setAttribute("style", "");
}
function prHideMarquee() {
  const el = document.querySelector("#pr-grid .pr-marquee");
  if (el) el.setAttribute("style", "display:none");
}

function prMarqueeSelect(origin, cell, startMembers) {
  const node = prGetNode();
  if (!node) return;
  const cellW = prCellW(), cellH = prCellH();
  const xMin = Math.min(origin.x, cell.x);
  const xMax = Math.max(origin.x, cell.x);
  const yMin = Math.min(origin.y, cell.y);
  const yMax = Math.max(origin.y, cell.y);
  const next = new Set(startMembers);
  (node.params.notes || []).forEach(nt => {
    // Multi-track: marquee only catches active-track notes (Ableton
    // behavior). Other tracks are visible-but-untouchable context.
    if (_prEd.multi && prTrackOf(nt) !== _prEd.activeTrack) return;
    const dur = Math.max(1, nt.dur || 1);
    const nx1 = nt.start * cellW;
    const nx2 = (nt.start + dur) * cellW;
    const ny1 = (PR_PITCH_HI - 1 - nt.midi) * cellH;
    const ny2 = ny1 + cellH;
    if (nx2 < xMin || nx1 > xMax || ny2 < yMin || ny1 > yMax) return;
    next.add(nt._id);
  });
  _prEd.selected = next;
  // Just patch class on the existing note rects to avoid re-render churn.
  document.querySelectorAll("#pr-grid .pr-note").forEach(el => {
    el.classList.toggle("selected", next.has(el.dataset.nid));
  });
  document.querySelectorAll("#pr-vel .pr-vel-bar").forEach(el => {
    el.classList.toggle("selected", next.has(el.dataset.nid));
  });
  prRenderStatus(node);
}

function prShowCrosshair(ev) {
  const cell = _prEd.hoverCell;
  if (!cell) { prHideCrosshair(); return; }
  if (_prEd.tool !== "draw") { prHideCrosshair(); return; }
  const v = document.querySelector("#pr-grid .pr-cross-v");
  const h = document.querySelector("#pr-grid .pr-cross-h");
  if (!v || !h) return;
  const cellW = prCellW(), cellH = prCellH();
  const x = cell.step * cellW;
  const y = (PR_PITCH_HI - 1 - cell.midi) * cellH;
  v.setAttribute("x1", x); v.setAttribute("x2", x);
  v.setAttribute("style", "");
  h.setAttribute("y1", y + cellH / 2); h.setAttribute("y2", y + cellH / 2);
  h.setAttribute("style", "");
}
function prHideCrosshair() {
  const v = document.querySelector("#pr-grid .pr-cross-v");
  const h = document.querySelector("#pr-grid .pr-cross-h");
  if (v) v.setAttribute("style", "display:none");
  if (h) h.setAttribute("style", "display:none");
}

/* Live note mutation during move/resize — operate on node.params.notes
 * directly so the preview is just the next render. The drag's `orig`
 * map holds each note's pre-drag state so deltas don't accumulate. */
function prApplyMovePreview(drag, dStep, dMidi) {
  const node = prGetNode();
  if (!node) return;
  const len = prGetLen();
  Object.keys(drag.orig).forEach(id => {
    const nt = prFindNote(id);
    if (!nt) return;
    const o  = drag.orig[id];
    const dur = Math.max(1, nt.dur || 1);
    let s = o.start + dStep;
    let m = o.midi  + dMidi;
    s = Math.max(0, Math.min(len - dur, s));
    m = Math.max(PR_PITCH_LO, Math.min(PR_PITCH_HI - 1, m));
    nt.start = s; nt.midi = m;
  });
  renderPianoRoll();
}

function prApplyResizePreview(drag, dStep) {
  const node = prGetNode();
  if (!node) return;
  const len = prGetLen();
  Object.keys(drag.orig).forEach(id => {
    const nt = prFindNote(id);
    if (!nt) return;
    const o = drag.orig[id];
    let dur = o.dur + dStep;
    if (dur < 1) dur = 1;
    if (nt.start + dur > len) dur = len - nt.start;
    if (dur < 1) dur = 1;
    nt.dur = dur;
  });
  renderPianoRoll();
}

/* ── Velocity-lane drag ────────────────────────────────────────── */

function prInstallVelHandlers() {
  const svg = document.getElementById("pr-vel");
  if (!svg) return;
  let drag = null;

  function velAt(ev) {
    const r = svg.getBoundingClientRect();
    const cy = ev.clientY - r.top;
    const v = 1 - cy / r.height;
    return Math.max(0, Math.min(1, v));
  }

  svg.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    const target = ev.target;
    const isHandle = target && target.classList.contains("pr-vel-handle");
    const isBar    = target && target.classList.contains("pr-vel-bar");
    if (!isHandle && !isBar) return;
    ev.preventDefault();
    const nid = target.dataset.nid;
    const node = prGetNode();
    if (!node) return;
    const ids = _prEd.selected.has(nid) && _prEd.selected.size > 1
      ? Array.from(_prEd.selected)
      : [nid];
    const orig = {};
    ids.forEach(id => {
      const nt = prFindNote(id);
      if (nt) orig[id] = nt.vel != null ? nt.vel : 1;
    });
    drag = { ids, orig, anchorV: velAt(ev) };
    try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    pushHistory("pr:vel:" + node.id);
  });
  svg.addEventListener("pointermove", ev => {
    if (!drag) return;
    const v = velAt(ev);
    const dv = v - drag.anchorV;
    drag.ids.forEach(id => {
      const nt = prFindNote(id);
      if (!nt) return;
      nt.vel = Math.max(0, Math.min(1, drag.orig[id] + dv));
    });
    renderPianoRoll();
  });
  function endVelDrag() {
    if (!drag) return;
    drag = null;
    renderPianoRoll();
    renderCode(); renderJson();
  }
  svg.addEventListener("pointerup", endVelDrag);
  svg.addEventListener("pointercancel", endVelDrag);
}

/* ── Keyboard sidebar audition (visual only) ───────────────────── */

function prInstallKeysHandlers() {
  const svg = document.getElementById("pr-keys");
  if (!svg) return;
  // Hover highlight on a key row — light visual feedback only; no
  // auditory preview because the audio runtime is independent.
  svg.addEventListener("pointermove", ev => {
    const t = ev.target;
    svg.querySelectorAll(".pr-key-row-hover").forEach(el => el.classList.remove("pr-key-row-hover"));
    if (t && t.tagName === "rect" && t.dataset.midi != null) {
      t.classList.add("pr-key-row-hover");
    }
  });
  svg.addEventListener("pointerleave", () => {
    svg.querySelectorAll(".pr-key-row-hover").forEach(el => el.classList.remove("pr-key-row-hover"));
  });
}

/* ── Bulk operations ───────────────────────────────────────────── */

function prDeleteNotes(ids) {
  const node = prGetNode();
  if (!node) return;
  const set = new Set(ids);
  pushHistory("pr:delete:" + node.id);
  node.params.notes = (node.params.notes || []).filter(n => !set.has(n._id));
  ids.forEach(id => _prEd.selected.delete(id));
  renderPianoRoll();
  renderCode(); renderJson(); renderProps();
}

function prDeleteSelection() {
  if (!_prEd.selected.size) return;
  prDeleteNotes(Array.from(_prEd.selected));
}

function prTransposeSelection(semitones) {
  const node = prGetNode();
  if (!node || !_prEd.selected.size) return;
  pushHistory("pr:transpose:" + node.id);
  (node.params.notes || []).forEach(n => {
    if (!_prEd.selected.has(n._id)) return;
    let m = n.midi + semitones;
    m = Math.max(PR_PITCH_LO, Math.min(PR_PITCH_HI - 1, m));
    n.midi = m;
  });
  renderPianoRoll();
  renderCode(); renderJson();
}

function prDuplicateSelection() {
  const node = prGetNode();
  if (!node || !_prEd.selected.size) return;
  const len = prGetLen();
  // Duplicate offset: longest selected duration, so the copy starts
  // immediately after the last edge of the selection.
  const sel = (node.params.notes || []).filter(n => _prEd.selected.has(n._id));
  if (!sel.length) return;
  const lastEnd = sel.reduce((m, n) => Math.max(m, n.start + (n.dur || 1)), 0);
  const firstStart = sel.reduce((m, n) => Math.min(m, n.start), Infinity);
  const offset = Math.max(1, lastEnd - firstStart);
  pushHistory("pr:duplicate:" + node.id);
  const newIds = new Set();
  sel.forEach(n => {
    const tr = prTrackOf(n);
    const trLen = _prEd.multi ? prGetLenForTrack(tr) : len;
    const ns = n.start + offset;
    if (ns >= trLen) return;
    const nd = Math.min(n.dur || 1, trLen - ns);
    const copy = { start: ns, dur: nd, midi: n.midi, vel: n.vel, _id: "n" + (_prNoteIdCounter++) };
    if (_prEd.multi) copy.track = tr;
    node.params.notes.push(copy);
    newIds.add(copy._id);
  });
  _prEd.selected = newIds;
  renderPianoRoll();
  renderCode(); renderJson(); renderProps();
}

function prSelectAll() {
  const node = prGetNode();
  if (!node) return;
  const all = node.params.notes || [];
  // In multi-track mode, ⌘A selects only the active track. Cmd+Shift+A
  // (handled by the keydown listener) selects across all tracks.
  const list = _prEd.multi
    ? all.filter(n => prTrackOf(n) === _prEd.activeTrack)
    : all;
  _prEd.selected = new Set(list.map(n => n._id));
  renderPianoRoll();
}
function prSelectAllTracks() {
  const node = prGetNode();
  if (!node) return;
  _prEd.selected = new Set((node.params.notes || []).map(n => n._id));
  renderPianoRoll();
}

/* ── Modal lifecycle ───────────────────────────────────────────── */

function openPianoRollModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const def  = defOf(node);
  _prEd.nodeId = nodeId;
  _pianoRollNodeId = nodeId;     // legacy alias kept live
  _prEd.multi = def && def.kind === "multiPianoRoll";
  if (!Array.isArray(node.params.notes)) node.params.notes = [];
  if (_prEd.multi) {
    if (!Array.isArray(node.params.patternLens) || node.params.patternLens.length !== 4) {
      node.params.patternLens = [16, 16, 16, 16];
    }
    if (!Array.isArray(node.params.defaultVels) || node.params.defaultVels.length !== 4) {
      node.params.defaultVels = [1, 1, 1, 1];
    }
    _prEd.activeTrack = Math.max(0, Math.min(3, parseInt(node.params.activeTrack, 10) || 0));
  } else {
    if (typeof node.params.patternLen !== "number") node.params.patternLen = 16;
    _prEd.activeTrack = 0;
  }
  prEnsureIds(node.params.notes);
  _prEd.selected.clear();
  _prEd.drag = null;
  _prEd.hoverCell = null;

  // Toolbar — toggle the multi-track class so the track-tabs group
  // reveals (CSS gates `.pr-track-group` visibility on this).
  const toolbar = document.getElementById("pr-toolbar");
  if (toolbar) toolbar.classList.toggle("multi-track", !!_prEd.multi);

  const titleEl = document.getElementById("pianoroll-modal-title");
  if (titleEl) titleEl.textContent = "[" + node.id + "]" + (_prEd.multi ? " · 4-TRACK" : "");
  const lenInput = document.getElementById("pianoroll-len");
  const velInput = document.getElementById("pianoroll-vel");
  if (lenInput) lenInput.value = prGetLen();
  if (velInput) {
    const dv = _prEd.multi
      ? (Number(node.params.defaultVels[_prEd.activeTrack]) || 1.0)
      : _prEd.defaultVel;
    _prEd.defaultVel = dv;
    velInput.value = dv.toFixed(2);
  }

  document.getElementById("pianoroll-modal").style.display = "flex";
  // Render once visible so layout calculations have real dimensions.
  requestAnimationFrame(() => {
    renderPianoRoll();
    // Center the keyboard view on C4 (MIDI 60) the first time this
    // modal opens — easier to find your bearings than starting at the
    // top of the range.
    const wrap = document.getElementById("pr-grid-wrap");
    if (wrap) {
      const targetRow = PR_PITCH_HI - 1 - 60;
      const cellH = prCellH();
      const wantTop = targetRow * cellH - wrap.clientHeight / 2 + cellH / 2;
      wrap.scrollTop = Math.max(0, wantTop);
      prSyncScroll();
    }
  });
}

function closePianoRollModal() {
  const m = document.getElementById("pianoroll-modal");
  if (m) m.style.display = "none";
  _prEd.nodeId = null;
  _pianoRollNodeId = null;
  _prEd.multi = false;
  _prEd.activeTrack = 0;
  _prEd.selected.clear();
  _prEd.drag = null;
  // Reset toolbar's multi-track flag so next single-track open is clean.
  const toolbar = document.getElementById("pr-toolbar");
  if (toolbar) toolbar.classList.remove("multi-track");
}

(function setupPianoRollModal() {
  const close   = document.getElementById("btn-pianoroll-close");
  const done    = document.getElementById("btn-pianoroll-done");
  const clr     = document.getElementById("btn-pianoroll-clear");
  const dup     = document.getElementById("btn-pianoroll-duplicate");
  const modal   = document.getElementById("pianoroll-modal");
  const lenIn   = document.getElementById("pianoroll-len");
  const velIn   = document.getElementById("pianoroll-vel");
  const snapEl  = document.getElementById("pr-snap");

  if (close) close.addEventListener("click", closePianoRollModal);
  if (done)  done.addEventListener("click", closePianoRollModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closePianoRollModal(); });

  if (clr) clr.addEventListener("click", () => {
    const node = prGetNode();
    if (!node) return;
    pushHistory("pr:clear:" + node.id);
    node.params.notes = [];
    _prEd.selected.clear();
    renderPianoRoll();
    renderCode(); renderJson(); renderProps();
  });

  if (dup) dup.addEventListener("click", prDuplicateSelection);

  if (lenIn) lenIn.addEventListener("input", () => {
    // prSetLen handles single + multi-track + per-track trim.
    prSetLen(lenIn.value);
    renderPianoRoll();
    renderCode(); renderJson(); renderProps();
  });

  if (velIn) velIn.addEventListener("input", () => {
    const v = parseFloat(velIn.value);
    if (!isFinite(v)) return;
    const clamped = Math.max(0, Math.min(1, v));
    _prEd.defaultVel = clamped;
    _pianoRollVel = clamped;
    if (_prEd.multi) {
      const node = prGetNode();
      if (node && Array.isArray(node.params.defaultVels)) {
        node.params.defaultVels[_prEd.activeTrack] = clamped;
      }
    }
  });

  if (snapEl) snapEl.addEventListener("change", () => {
    _prEd.snapIx = Math.max(0, Math.min(PR_SNAP_VALUES.length - 1, parseInt(snapEl.value, 10) || 0));
    prRenderStatus(prGetNode() || { params: { notes: [] } });
  });

  // Tool buttons
  document.querySelectorAll(".pr-tool").forEach(b => {
    b.addEventListener("click", () => {
      _prEd.tool = b.dataset.tool || "draw";
      prSyncToolbar();
    });
  });

  // Track tabs (multi-track only — group is hidden via CSS otherwise)
  document.querySelectorAll(".pr-track").forEach(b => {
    b.addEventListener("click", () => {
      const t = parseInt(b.dataset.track, 10);
      if (!isFinite(t)) return;
      prSetActiveTrack(t);
    });
  });

  // Zoom buttons
  document.querySelectorAll(".pr-zoom-btn[data-zoom]").forEach(b => {
    b.addEventListener("click", () => {
      const k = b.dataset.zoom;
      if (k === "hin")  _prEd.zoomX = Math.min(PR_ZOOM_X.length - 1, _prEd.zoomX + 1);
      if (k === "hout") _prEd.zoomX = Math.max(0, _prEd.zoomX - 1);
      if (k === "vin")  _prEd.zoomY = Math.min(PR_ZOOM_Y.length - 1, _prEd.zoomY + 1);
      if (k === "vout") _prEd.zoomY = Math.max(0, _prEd.zoomY - 1);
      renderPianoRoll();
    });
  });

  // Octave-jump buttons (vertical scroll by one octave's worth of rows)
  document.querySelectorAll(".pr-zoom-btn[data-oct]").forEach(b => {
    b.addEventListener("click", () => {
      const dir = parseInt(b.dataset.oct, 10) || 0;
      const wrap = document.getElementById("pr-grid-wrap");
      if (!wrap) return;
      // dir = +1 means scroll UP an octave (toward higher pitches at top).
      wrap.scrollTop -= dir * 12 * prCellH();
      prSyncScroll();
    });
  });

  // Scroll mirroring
  const wrap = document.getElementById("pr-grid-wrap");
  if (wrap) wrap.addEventListener("scroll", prSyncScroll, { passive: true });

  // Wheel: ctrl/cmd = zoom; shift = horizontal pan; default = vertical scroll
  if (wrap) {
    wrap.addEventListener("wheel", e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Cmd+wheel zooms horizontally (most musical context wants
        // narrower / wider, not taller / shorter rows). Hold shift to
        // zoom vertically instead.
        const upd = (e.shiftKey ? "zoomY" : "zoomX");
        const arr = (e.shiftKey ? PR_ZOOM_Y : PR_ZOOM_X);
        if (e.deltaY < 0) _prEd[upd] = Math.min(arr.length - 1, _prEd[upd] + 1);
        else              _prEd[upd] = Math.max(0, _prEd[upd] - 1);
        renderPianoRoll();
      }
    }, { passive: false });
  }

  // Keyboard shortcuts — only when the modal is open. Handled keys
  // call stopImmediatePropagation so global shortcuts (tab-switch,
  // save, select-all, etc.) don't also fire while the modal owns the
  // keyboard.
  document.addEventListener("keydown", e => {
    if (_prEd.nodeId == null) return;
    if (isTextInput(e.target)) return;
    const k = e.key;
    const handled = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (k === "Escape")      { handled(); closePianoRollModal(); return; }
    if (k === "b" || k === "B") { handled(); _prEd.tool = "draw";   prSyncToolbar(); return; }
    if (k === "v" || k === "V") { handled(); _prEd.tool = "select"; prSyncToolbar(); return; }
    if (k === "e" || k === "E") { handled(); _prEd.tool = "erase";  prSyncToolbar(); return; }
    if (k === "Delete" || k === "Backspace") { handled(); prDeleteSelection(); return; }
    if (k === "ArrowUp")   { handled(); prTransposeSelection(e.shiftKey ? 12 : 1);   return; }
    if (k === "ArrowDown") { handled(); prTransposeSelection(e.shiftKey ? -12 : -1); return; }
    if ((e.metaKey || e.ctrlKey) && (k === "a" || k === "A")) {
      handled();
      if (e.shiftKey) prSelectAllTracks(); else prSelectAll();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (k === "d" || k === "D")) { handled(); prDuplicateSelection(); return; }
    // Multi-track: 1/2/3/4 jump to that track. Without stopImmediate
    // the global tab-switcher would also fire and yank the right pane.
    if (_prEd.multi && (k === "1" || k === "2" || k === "3" || k === "4")) {
      handled(); prSetActiveTrack(parseInt(k, 10) - 1); return;
    }
  }, true);  // capture phase — fire before global document handlers

  prInstallGridHandlers();
  prInstallVelHandlers();
  prInstallKeysHandlers();
})();

/* ====================================================================
 * WAVETABLE EDITOR — single-cycle drawable waveform.
 *
 * One modal serves two callers:
 *   - WavetableOsc (mode="single") → edits node.params.table
 *   - WavetableScan (mode="frame") → edits node.params.customFrames[idx]
 *
 * The drawing surface is a single SVG with -1/0/+1 graticule lines
 * and a phosphor-glow trace for the current waveform. Click + drag
 * paints sample values; shift-drag draws a straight line from anchor.
 * Save-on-modify: every drag commit writes back to params + triggers
 * renderCode/renderJson, so the codegen + monitor reflect changes
 * without a separate Save button (DONE just closes the modal).
 *
 * When returnTo is set, closing returns control to the wavescan modal
 * (which is hidden but not destroyed) and re-renders its stacked view.
 * ================================================================= */

const WT_TABLE_LEN = 256;

const _wtEd = {
  nodeId:   null,
  mode:     "single",          // "single" | "frame"
  frameIdx: 0,
  table:    null,              // live ref into node.params (NOT a copy)
  initial:  null,              // snapshot for REVERT
  drag:     null,              // { last: { i, v }, anchor: { i, v } } during pointerdown..up
  returnTo: null,              // "wavescan" if drilled in from there
};

function wtDefaultTable() {
  // Sine cycle as the default. Gives "something to work with" rather
  // than a flat zero line on first open.
  const t = new Array(WT_TABLE_LEN);
  for (let i = 0; i < WT_TABLE_LEN; i++) {
    t[i] = Math.sin(2 * Math.PI * i / WT_TABLE_LEN);
  }
  return t;
}
function wtPresetTable(name) {
  const t = new Array(WT_TABLE_LEN);
  for (let i = 0; i < WT_TABLE_LEN; i++) {
    const p = i / WT_TABLE_LEN;
    switch (name) {
      case "sine":     t[i] = Math.sin(2 * Math.PI * p); break;
      case "saw":      t[i] = 2 * p - 1; break;
      case "square":   t[i] = p < 0.5 ? 1 : -1; break;
      case "triangle": t[i] = p < 0.5 ? (4 * p - 1) : (3 - 4 * p); break;
      case "halfSine": t[i] = p < 0.5 ? Math.sin(2 * Math.PI * p) : 0; break;
      case "hollow":   t[i] = Math.sin(2 * Math.PI * p) - 0.5 * Math.sin(4 * Math.PI * p); break;
      case "random":   t[i] = Math.random() * 2 - 1; break;
      default:         t[i] = 0;
    }
  }
  return t;
}

function wtCommitToNode() {
  const node = state.nodes.find(n => n.id === _wtEd.nodeId);
  if (!node || !_wtEd.table) return;
  if (_wtEd.mode === "single") {
    node.params.table = _wtEd.table.slice();
  } else if (_wtEd.mode === "frame") {
    if (!node.params.customFrames || typeof node.params.customFrames !== "object") {
      node.params.customFrames = {};
    }
    node.params.customFrames[_wtEd.frameIdx] = _wtEd.table.slice();
  }
  renderCode(); renderJson(); renderProps();
}

function openWavetableEditModal(opts) {
  const node = state.nodes.find(n => n.id === opts.nodeId);
  if (!node) return;
  _wtEd.nodeId   = opts.nodeId;
  _wtEd.mode     = opts.mode || "single";
  _wtEd.frameIdx = opts.frameIdx || 0;
  _wtEd.returnTo = opts.returnTo || null;
  _wtEd.drag     = null;

  // Resolve / seed the table that we'll edit. For single mode, prefer
  // an existing params.table. For frame mode, use the existing custom
  // frame override if there is one; otherwise seed from the algorithmic
  // bank (we duplicate the WavetableScan helper's bank algorithms in
  // JS so the user starts from "what the audio is currently playing").
  let initialTable;
  if (_wtEd.mode === "single") {
    initialTable = (Array.isArray(node.params.table) && node.params.table.length > 0)
      ? node.params.table.slice()
      : wtDefaultTable();
  } else {
    const cf = (node.params && node.params.customFrames) || {};
    if (Array.isArray(cf[_wtEd.frameIdx]) && cf[_wtEd.frameIdx].length > 0) {
      initialTable = cf[_wtEd.frameIdx].slice();
    } else {
      initialTable = wsBankFrameJS(node.params.bank || "sineToSaw", _wtEd.frameIdx);
    }
  }
  // Pad / truncate to WT_TABLE_LEN
  if (initialTable.length < WT_TABLE_LEN) {
    const padded = new Array(WT_TABLE_LEN);
    for (let i = 0; i < WT_TABLE_LEN; i++) {
      const t = i / WT_TABLE_LEN * (initialTable.length - 1);
      const i0 = Math.floor(t);
      const i1 = Math.min(initialTable.length - 1, i0 + 1);
      const f = t - i0;
      padded[i] = initialTable[i0] * (1 - f) + initialTable[i1] * f;
    }
    initialTable = padded;
  } else if (initialTable.length > WT_TABLE_LEN) {
    initialTable = initialTable.slice(0, WT_TABLE_LEN);
  }
  _wtEd.table = initialTable;
  _wtEd.initial = initialTable.slice();

  const titleEl = document.getElementById("wavetable-modal-title");
  if (titleEl) {
    titleEl.textContent = _wtEd.mode === "frame"
      ? `[${node.id}]  FRAME ${_wtEd.frameIdx} / 511`
      : `[${node.id}]`;
  }

  document.getElementById("wavetable-modal").style.display = "flex";
  requestAnimationFrame(() => renderWavetableCanvas());
}

function closeWavetableEditModal(commit) {
  if (commit !== false) wtCommitToNode();
  document.getElementById("wavetable-modal").style.display = "none";
  const returnTo = _wtEd.returnTo;
  _wtEd.nodeId = null;
  _wtEd.table  = null;
  _wtEd.initial = null;
  _wtEd.returnTo = null;
  _wtEd.drag = null;
  if (returnTo === "wavescan" && _wsEd.nodeId) {
    document.getElementById("wavescan-modal").style.display = "flex";
    requestAnimationFrame(() => renderWavescanCanvas());
  }
}

function renderWavetableCanvas() {
  const svg = document.getElementById("wt-canvas");
  if (!svg || !_wtEd.table) return;
  const W = svg.clientWidth || 1000;
  const H = svg.clientHeight || 480;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const PAD_X = 32;
  const PAD_Y = 24;
  const PLOT_W = W - PAD_X * 2;
  const PLOT_H = H - PAD_Y * 2;

  let html = "";
  // Vertical sample-grid lines every 16 samples; brighter every 64.
  for (let s = 0; s <= WT_TABLE_LEN; s += 16) {
    const x = PAD_X + (s / WT_TABLE_LEN) * PLOT_W;
    const cls = (s % 64 === 0) ? "wt-bound-line" : "wt-grid-line";
    html += `<line class="${cls}" x1="${x}" y1="${PAD_Y}" x2="${x}" y2="${H - PAD_Y}" />`;
  }
  // Horizontal amplitude grid: -1, -0.5, 0, +0.5, +1
  [-1, -0.5, 0, 0.5, 1].forEach(v => {
    const y = PAD_Y + PLOT_H * 0.5 * (1 - v);
    const cls = v === 0 ? "wt-zero-line" : (Math.abs(v) === 1 ? "wt-bound-line" : "wt-axis-line");
    html += `<line class="${cls}" x1="${PAD_X}" y1="${y}" x2="${W - PAD_X}" y2="${y}" />`;
    const lbl = v === 0 ? "0" : (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
    const cl2 = (Math.abs(v) === 1 || v === 0) ? "wt-axis-label wt-axis-label-bright" : "wt-axis-label";
    html += `<text class="${cl2}" x="6" y="${y + 3}">${lbl}</text>`;
  });
  // Sample-axis ticks at left edge (start / end)
  html += `<text class="wt-axis-label" x="${PAD_X}" y="${H - 6}">0</text>`;
  html += `<text class="wt-axis-label" x="${W - PAD_X - 24}" y="${H - 6}">${WT_TABLE_LEN}</text>`;

  // Filled area under the curve for visual mass + the trace itself.
  // Both use the table[i] values mapped: x = PAD_X + (i / N) * PLOT_W,
  // y = PAD_Y + 0.5 * PLOT_H * (1 - clamp(v, -1, 1)).
  let pts = "";
  for (let i = 0; i < WT_TABLE_LEN; i++) {
    const v = Math.max(-1, Math.min(1, _wtEd.table[i]));
    const x = PAD_X + (i / WT_TABLE_LEN) * PLOT_W;
    const y = PAD_Y + 0.5 * PLOT_H * (1 - v);
    pts += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " ";
  }
  // Fill polygon: trace + bottom corners
  const fillPts = pts + `L ${W - PAD_X} ${PAD_Y + 0.5 * PLOT_H} L ${PAD_X} ${PAD_Y + 0.5 * PLOT_H} Z`;
  html += `<path class="wt-trace-fill" d="${fillPts}" />`;
  html += `<path class="wt-trace" d="${pts}" />`;

  svg.innerHTML = html;

  // Update RMS / peak readouts
  let rms = 0, peak = 0;
  for (let i = 0; i < WT_TABLE_LEN; i++) {
    const v = _wtEd.table[i];
    rms += v * v;
    const av = Math.abs(v);
    if (av > peak) peak = av;
  }
  rms = Math.sqrt(rms / WT_TABLE_LEN);
  const rmsEl  = document.getElementById("wt-stat-rms");
  const peakEl = document.getElementById("wt-stat-peak");
  if (rmsEl)  rmsEl.textContent  = rms.toFixed(3);
  if (peakEl) peakEl.textContent = peak.toFixed(3);
}

function wtSampleAt(ev) {
  const svg = document.getElementById("wt-canvas");
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  const W = r.width, H = r.height;
  const PAD_X = 32, PAD_Y = 24;
  const PLOT_W = W - PAD_X * 2;
  const PLOT_H = H - PAD_Y * 2;
  const cx = ev.clientX - r.left;
  const cy = ev.clientY - r.top;
  const i = Math.max(0, Math.min(WT_TABLE_LEN - 1, Math.round((cx - PAD_X) / PLOT_W * WT_TABLE_LEN)));
  const v = Math.max(-1, Math.min(1, 1 - 2 * (cy - PAD_Y) / PLOT_H));
  return { i, v };
}

function wtPaintLine(from, to) {
  // Linear interpolation between two sample positions — fills any
  // gaps that fast cursor motion would skip over. `from` and `to` are
  // both { i, v }.
  const lo = Math.min(from.i, to.i);
  const hi = Math.max(from.i, to.i);
  if (lo === hi) {
    _wtEd.table[lo] = to.v;
    return;
  }
  const v0 = (from.i <= to.i) ? from.v : to.v;
  const v1 = (from.i <= to.i) ? to.v   : from.v;
  for (let i = lo; i <= hi; i++) {
    const t = (i - lo) / (hi - lo);
    _wtEd.table[i] = v0 * (1 - t) + v1 * t;
  }
}

function wtApplyOp(op) {
  if (!_wtEd.table) return;
  const N = WT_TABLE_LEN;
  const t = _wtEd.table;
  switch (op) {
    case "smooth": {
      const out = new Array(N);
      for (let i = 0; i < N; i++) {
        const a = t[(i - 1 + N) % N], b = t[i], c = t[(i + 1) % N];
        out[i] = (a + 2 * b + c) / 4;
      }
      _wtEd.table = out;
      break;
    }
    case "normalize": {
      let pk = 0;
      for (let i = 0; i < N; i++) { const a = Math.abs(t[i]); if (a > pk) pk = a; }
      if (pk > 0.0001) {
        const k = 1 / pk;
        for (let i = 0; i < N; i++) t[i] = t[i] * k;
      }
      break;
    }
    case "invert":  for (let i = 0; i < N; i++) t[i] = -t[i]; break;
    case "reverse": _wtEd.table = t.slice().reverse(); break;
    case "symmetrize": {
      // Mirror left half over the right half so the wave has even symmetry
      // around N/2. Useful for forcing a "pure" odd or even harmonic content.
      const half = N / 2;
      for (let i = 0; i < half; i++) {
        t[N - 1 - i] = t[i];
      }
      break;
    }
    case "zero": for (let i = 0; i < N; i++) t[i] = 0; break;
  }
  renderWavetableCanvas();
  wtCommitToNode();
}

function setupWavetableModal() {
  const modal = document.getElementById("wavetable-modal");
  const svg   = document.getElementById("wt-canvas");
  const close = document.getElementById("btn-wavetable-close");
  const done  = document.getElementById("btn-wavetable-done");
  const revert = document.getElementById("btn-wavetable-revert");
  if (!modal || !svg) return;

  if (close) close.addEventListener("click", () => closeWavetableEditModal(true));
  if (done)  done.addEventListener("click",  () => closeWavetableEditModal(true));
  if (revert) revert.addEventListener("click", () => {
    if (!_wtEd.initial) return;
    _wtEd.table = _wtEd.initial.slice();
    renderWavetableCanvas();
    wtCommitToNode();
  });
  modal.addEventListener("click", e => {
    if (e.target === modal) closeWavetableEditModal(true);
  });

  // Preset buttons — replace table with the named preset.
  document.querySelectorAll(".wt-preset-btn").forEach(b => {
    b.addEventListener("click", () => {
      _wtEd.table = wtPresetTable(b.dataset.preset);
      renderWavetableCanvas();
      wtCommitToNode();
    });
  });
  // Shape ops
  document.querySelectorAll(".wt-tool-btn[data-op]").forEach(b => {
    b.addEventListener("click", () => wtApplyOp(b.dataset.op));
  });

  // Drawing — pointer interaction on the canvas
  svg.addEventListener("pointerdown", ev => {
    if (ev.button !== 0 || !_wtEd.table) return;
    ev.preventDefault();
    const cell = wtSampleAt(ev);
    if (!cell) return;
    _wtEd.drag = {
      last: cell,
      anchor: cell,
      shift: ev.shiftKey
    };
    try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    if (ev.shiftKey) {
      // Shift-click anchors; release commits a line.
      renderWavetableCanvas();
    } else {
      _wtEd.table[cell.i] = cell.v;
      renderWavetableCanvas();
    }
  });
  svg.addEventListener("pointermove", ev => {
    const cell = wtSampleAt(ev);
    if (cell) {
      const r = document.getElementById("wavetable-readout");
      if (r) r.textContent = `SAMPLE ${String(cell.i).padStart(3)}    AMP ${cell.v.toFixed(3)}`;
    }
    if (!_wtEd.drag) return;
    if (!cell) return;
    if (_wtEd.drag.shift) {
      // Shift-drag: from anchor to current, drawing a single straight
      // line. Re-renders from a fresh _wtEd.initial copy each move so
      // we don't accumulate.
      _wtEd.table = _wtEd.initial.slice();
      wtPaintLine(_wtEd.drag.anchor, cell);
    } else {
      wtPaintLine(_wtEd.drag.last, cell);
    }
    _wtEd.drag.last = cell;
    renderWavetableCanvas();
  });
  function endWtDrag() {
    if (_wtEd.drag) {
      _wtEd.drag = null;
      wtCommitToNode();
    }
  }
  svg.addEventListener("pointerup",     endWtDrag);
  svg.addEventListener("pointercancel", endWtDrag);

  // Esc to close (only when this modal is open and we're not in the
  // wavescan modal's editor flow). Capture phase + stopImmediate so
  // global Escape handlers don't double-fire.
  document.addEventListener("keydown", e => {
    if (modal.style.display === "none") return;
    if (isTextInput(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      closeWavetableEditModal(true);
    }
  }, true);
}
setupWavetableModal();

/* ====================================================================
 * WAVESCAN MODAL — 3D-stacked view of all 512 wavetable frames.
 *
 * Renders every Nth frame as a polyline (drawing all 512 would be
 * 131K SVG points and slow to render on every scrub tick). Layout:
 * frames stack along Z with progressively smaller scale + Y offset
 * to fake perspective; the "active position" frame is rendered in
 * bright phosphor over the rest. Click any frame to drill into the
 * single-cycle wavetable editor pre-loaded with that frame's data.
 *
 * The position slider is the source of truth for both modal-local
 * scrubbing AND the live audio param (node.params.position is
 * autoExposed → the runtime AudioWorklet picks it up via setter
 * dispatch, same as Slider).
 *
 * Uses the same bank algorithms as the C++ helper so the JS preview
 * matches what compile + Play actually produces.
 * ================================================================= */

const WS_FRAMES   = 512;
const WS_SAMPLES  = 256;
const WS_VISIBLE  = 64;        // every WS_FRAMES/WS_VISIBLE-th frame drawn

const _wsEd = {
  nodeId: null,
  view:   "3d",
  scrubbing: false,
};

const WS_BANK_NAMES = ["sineToSaw", "harmonicWalk", "formantScan", "sineFold", "sineToTri", "morphPair"];
const WS_BANK_LABELS = ["SINE → SAW", "HARMONIC WALK", "FORMANT SCAN", "SINE FOLD", "SINE → TRIANGLE", "MORPH PAIR"];

/* JS port of the C++ WavetableScan bank algorithms. Returns one
 * 256-sample frame at the given fractional position (0..1). Kept
 * identical to GammaWavetableScan::setBank so the modal preview
 * matches the audio output. */
function wsBankFrameJS(bank, frameIdx) {
  const t = frameIdx / (WS_FRAMES - 1);
  const out = new Array(WS_SAMPLES);
  const TWO_PI = 2 * Math.PI;
  for (let i = 0; i < WS_SAMPLES; i++) {
    const p = i / WS_SAMPLES;
    let v = 0;
    switch (bank) {
      case "sineToSaw": case 0: {
        const s = Math.sin(TWO_PI * p);
        const saw = 2 * p - 1;
        v = s * (1 - t) + saw * t;
        break;
      }
      case "harmonicWalk": case 1: {
        const maxH = 1 + Math.floor(t * 16);
        for (let h = 1; h <= maxH; h++) v += Math.sin(TWO_PI * p * h) / h;
        v *= 0.6;
        break;
      }
      case "formantScan": case 2: {
        const shift = t * 0.5;
        let p2 = p + shift; if (p2 >= 1) p2 -= 1;
        v = Math.sin(TWO_PI * p2) * (1 - 0.5 * Math.cos(TWO_PI * p));
        break;
      }
      case "sineFold": case 3: {
        const s = Math.sin(TWO_PI * p);
        const clipped = s * (1 + t * 4);
        v = clipped > 1 ? 1 : (clipped < -1 ? -1 : clipped);
        break;
      }
      case "sineToTri": case 4: {
        const s = Math.sin(TWO_PI * p);
        const tri = (p < 0.5) ? (4 * p - 1) : (3 - 4 * p);
        v = s * (1 - t) + tri * t;
        break;
      }
      case "morphPair": case 5: {
        const a = Math.sin(TWO_PI * p);
        const ph = TWO_PI * t;
        const bb = Math.sin(TWO_PI * 3 * p + ph) * 0.5;
        v = a * (1 - t * 0.7) + bb * t * 0.7;
        break;
      }
    }
    out[i] = v;
  }
  return out;
}

function wsResolvedFrame(node, idx) {
  // Custom override beats the algorithmic frame.
  const cf = (node.params && node.params.customFrames) || {};
  if (Array.isArray(cf[idx]) && cf[idx].length > 0) return cf[idx];
  return wsBankFrameJS(node.params.bank || "sineToSaw", idx);
}

function openWavescanModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  _wsEd.nodeId = nodeId;
  _wsEd.view = "3d";
  // Initialize defaults if missing
  if (typeof node.params.position !== "number") node.params.position = 0;
  if (typeof node.params.bank !== "string")     node.params.bank = "sineToSaw";
  if (!node.params.customFrames || typeof node.params.customFrames !== "object") {
    node.params.customFrames = {};
  }

  const titleEl = document.getElementById("wavescan-modal-title");
  if (titleEl) titleEl.textContent = `[${node.id}]`;
  const bankEl = document.getElementById("ws-bank");
  if (bankEl) {
    const ix = WS_BANK_NAMES.indexOf(node.params.bank);
    bankEl.value = String(ix >= 0 ? ix : 0);
  }
  const posEl = document.getElementById("ws-position");
  if (posEl) posEl.value = String(node.params.position);
  document.querySelectorAll(".wt-tool-btn[data-view]").forEach(b => {
    b.classList.toggle("active", b.dataset.view === _wsEd.view);
  });

  document.getElementById("wavescan-modal").style.display = "flex";
  requestAnimationFrame(() => renderWavescanCanvas());
}

function closeWavescanModal() {
  document.getElementById("wavescan-modal").style.display = "none";
  _wsEd.nodeId = null;
  _wsEd.scrubbing = false;
}

function renderWavescanCanvas() {
  const node = state.nodes.find(n => n.id === _wsEd.nodeId);
  const svg = document.getElementById("ws-canvas");
  if (!node || !svg) return;
  const stage = document.getElementById("ws-stage");
  const W = (stage ? stage.clientWidth : 1200) || 1200;
  const H = (stage ? stage.clientHeight : 600) || 600;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  // Sync readouts
  const pos = Math.max(0, Math.min(1, Number(node.params.position) || 0));
  const activeFrame = Math.round(pos * (WS_FRAMES - 1));
  const r = document.getElementById("wavescan-readout");
  if (r) r.textContent = `FRAME ${String(activeFrame).padStart(3)}/${WS_FRAMES}    POS ${pos.toFixed(3)}`;
  const posR = document.getElementById("ws-pos-readout");
  if (posR) posR.textContent = pos.toFixed(3);
  const ovrEl = document.getElementById("ws-stat-overrides");
  if (ovrEl) ovrEl.textContent = String(Object.keys(node.params.customFrames || {}).length);
  const bankEl = document.getElementById("ws-stat-bank");
  if (bankEl) {
    const ix = WS_BANK_NAMES.indexOf(node.params.bank);
    bankEl.textContent = WS_BANK_LABELS[ix >= 0 ? ix : 0];
  }

  if (_wsEd.view === "grid") {
    renderWavescanGrid(node, svg, W, H);
  } else {
    renderWavescan3D(node, svg, W, H, pos);
  }
}

function renderWavescan3D(node, svg, W, H, pos) {
  // Project N visible frames into a perspective stack. Each frame i
  // (0..N-1) gets:
  //   - normalized depth z = i / (N-1)
  //   - x-offset: skew_x * (1 - z)
  //   - y-offset: top_pad + (1 - z) * span
  //   - scale  : 0.55 + 0.45 * (1 - z)
  // The visible-frame slice samples every WS_FRAMES / WS_VISIBLE-th
  // frame (so 8 of every 8 are drawn at WS_VISIBLE=64). Custom-edited
  // frames are colored with .custom; the active position highlights
  // its enclosing visible frame in bright phosphor.
  const cf = node.params.customFrames || {};
  const customSet = new Set(Object.keys(cf).map(k => parseInt(k, 10)).filter(k => isFinite(k)));
  const PAD_TOP = 40, PAD_BOT = 30;
  const SKEW = 60;                       // horizontal skew in px from front to back
  const PLOT_W = W * 0.78;
  const PLOT_X = (W - PLOT_W) * 0.5;
  const TOTAL_H = H - PAD_TOP - PAD_BOT;
  const FRAME_AMP = TOTAL_H * 0.45;      // per-frame waveform amplitude
  const SPAN = TOTAL_H - FRAME_AMP * 0.5; // vertical extent of the stack

  // Background grid — vertical guidelines at quarters of position
  let html = "";
  for (let q = 0; q <= 4; q++) {
    const xq = PLOT_X + (q / 4) * PLOT_W;
    html += `<line class="ws-grid" x1="${xq}" y1="${PAD_TOP - 10}" x2="${xq}" y2="${H - PAD_BOT + 10}" />`;
  }

  // Render frames back-to-front so closer frames overlap further ones.
  // i = WS_FRAMES - 1 is "back" (smallest, dimmest); i = 0 is "front".
  const step = Math.max(1, Math.floor(WS_FRAMES / WS_VISIBLE));
  // Always include the active frame in the visible list so the
  // highlight has something to draw onto.
  const visible = [];
  for (let i = 0; i < WS_FRAMES; i += step) visible.push(i);
  const activeFrame = Math.round(pos * (WS_FRAMES - 1));
  const nearestVisible = visible.reduce((best, v) => Math.abs(v - activeFrame) < Math.abs(best - activeFrame) ? v : best, visible[0]);
  if (!visible.includes(activeFrame)) visible.push(activeFrame);
  // Draw back-to-front
  visible.sort((a, b) => b - a);

  const projectFrame = (i) => {
    const z = i / (WS_FRAMES - 1);
    const yBase = PAD_TOP + FRAME_AMP * 0.5 + (1 - z) * SPAN * 0.85;
    const xOff  = SKEW * z;
    const scale = 0.6 + 0.4 * (1 - z);
    return { yBase, xOff, scale };
  };

  visible.forEach(i => {
    const { yBase, xOff, scale } = projectFrame(i);
    const isActive = i === activeFrame;
    const isCustom = customSet.has(i);
    const frameData = wsResolvedFrame(node, i);
    let pts = "";
    for (let s = 0; s < WS_SAMPLES; s++) {
      const v = Math.max(-1, Math.min(1, frameData[s]));
      const xs = PLOT_X + xOff + (s / WS_SAMPLES) * PLOT_W * scale;
      const ys = yBase - v * FRAME_AMP * 0.5 * scale;
      pts += (s === 0 ? "M" : "L") + xs.toFixed(2) + " " + ys.toFixed(2) + " ";
    }
    const cls = "ws-frame" + (isCustom ? " custom" : "") + (isActive ? " active" : "");
    html += `<path class="${cls}" data-frame="${i}" d="${pts}" />`;
  });

  // Position cursor — vertical bar through the stack at the projected
  // x of the active frame's start. Also draw the frame-number label.
  {
    const proj = projectFrame(activeFrame);
    const cx = PLOT_X + proj.xOff;
    html += `<line class="ws-pos-cursor" x1="${cx}" y1="${PAD_TOP - 6}" x2="${cx}" y2="${H - PAD_BOT}" />`;
    html += `<text class="ws-frame-label" x="${cx + 6}" y="${PAD_TOP + 4}">FRAME ${activeFrame}</text>`;
  }
  // Front/back depth labels
  html += `<text class="ws-frame-label" x="${PLOT_X}" y="${H - PAD_BOT + 18}">FRONT · 0</text>`;
  html += `<text class="ws-frame-label" x="${PLOT_X + PLOT_W * 0.7 + SKEW}" y="${PAD_TOP - 12}">BACK · ${WS_FRAMES - 1}</text>`;

  svg.innerHTML = html;
  wsAttachFrameClicks(svg);
}

function renderWavescanGrid(node, svg, W, H) {
  // Contact-sheet view — sample of N frames as a grid of mini
  // oscilloscope tiles. Each tile is clickable; the active tile is
  // outlined in phosphor. Useful for spotting outliers or finding a
  // specific custom frame in the bank.
  const cf = node.params.customFrames || {};
  const customSet = new Set(Object.keys(cf).map(k => parseInt(k, 10)).filter(k => isFinite(k)));
  const pos = Math.max(0, Math.min(1, Number(node.params.position) || 0));
  const activeFrame = Math.round(pos * (WS_FRAMES - 1));
  const COLS = 32;
  const ROWS = 16;          // 32 × 16 = 512 ✓
  const PAD = 12;
  const cellW = (W - PAD * 2) / COLS;
  const cellH = (H - PAD * 2) / ROWS;
  let html = "";
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      if (idx >= WS_FRAMES) continue;
      const x = PAD + c * cellW;
      const y = PAD + r * cellH;
      const isCustom = customSet.has(idx);
      const isActive = idx === activeFrame;
      const cls = "ws-grid-cell-bg" + (isCustom ? " custom" : "") + (isActive ? " active" : "");
      html += `<g class="ws-grid-cell" data-frame="${idx}">`;
      html += `<rect class="${cls}" x="${x}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" rx="1" />`;
      // Mini waveform — 32 sample points (downsampled)
      const frameData = wsResolvedFrame(node, idx);
      const innerPad = 2;
      const ix = x + innerPad;
      const iy = y + innerPad;
      const iw = cellW - innerPad * 2 - 1;
      const ih = cellH - innerPad * 2 - 1;
      const N = 32;
      let pts = "";
      for (let s = 0; s < N; s++) {
        const sIdx = Math.floor(s / N * WS_SAMPLES);
        const v = Math.max(-1, Math.min(1, frameData[sIdx]));
        const xs = ix + (s / N) * iw;
        const ys = iy + ih * 0.5 - v * ih * 0.45;
        pts += (s === 0 ? "M" : "L") + xs.toFixed(1) + " " + ys.toFixed(1) + " ";
      }
      const traceColor = isActive ? "var(--phosphor)" : (isCustom ? "var(--info)" : "rgba(200,232,90,0.4)");
      html += `<path d="${pts}" fill="none" stroke="${traceColor}" stroke-width="1" stroke-linejoin="round" />`;
      html += `</g>`;
    }
  }
  svg.innerHTML = html;
  wsAttachFrameClicks(svg);
}

function wsAttachFrameClicks(svg) {
  // Both views render with `data-frame` on clickable elements. Clicking
  // a frame opens the per-frame wavetable editor; the modal closes
  // the wavescan modal temporarily and restores it on done.
  svg.querySelectorAll("[data-frame]").forEach(el => {
    el.addEventListener("click", ev => {
      ev.preventDefault();
      const idx = parseInt(el.getAttribute("data-frame"), 10);
      if (!isFinite(idx)) return;
      // Hide wavescan modal but DON'T destroy state — _wtEd.returnTo
      // tells closeWavetableEditModal to bring us back.
      document.getElementById("wavescan-modal").style.display = "none";
      openWavetableEditModal({
        nodeId: _wsEd.nodeId,
        mode: "frame",
        frameIdx: idx,
        returnTo: "wavescan"
      });
    });
  });
}

function setupWavescanModal() {
  const modal = document.getElementById("wavescan-modal");
  const close = document.getElementById("btn-wavescan-close");
  const done  = document.getElementById("btn-wavescan-done");
  const clear = document.getElementById("btn-wavescan-clear-overrides");
  const bank  = document.getElementById("ws-bank");
  const posEl = document.getElementById("ws-position");
  if (!modal) return;

  if (close) close.addEventListener("click", closeWavescanModal);
  if (done)  done.addEventListener("click",  closeWavescanModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeWavescanModal(); });

  if (bank) bank.addEventListener("change", () => {
    const node = state.nodes.find(n => n.id === _wsEd.nodeId);
    if (!node) return;
    pushHistory("ws:bank:" + node.id);
    const ix = parseInt(bank.value, 10) || 0;
    node.params.bank = WS_BANK_NAMES[ix];
    renderWavescanCanvas();
    renderCode(); renderJson(); renderProps();
  });

  if (posEl) {
    const onPos = () => {
      const node = state.nodes.find(n => n.id === _wsEd.nodeId);
      if (!node) return;
      const v = Math.max(0, Math.min(1, parseFloat(posEl.value) || 0));
      node.params.position = v;
      renderWavescanCanvas();
      // Don't push history on every microscopic scrub event — the
      // position is a continuous knob, not a discrete commit. Final
      // value persists via the natural state mutation.
      renderCode(); renderJson();
      renderMonitorControls();
    };
    posEl.addEventListener("input", onPos);
  }

  if (clear) clear.addEventListener("click", () => {
    const node = state.nodes.find(n => n.id === _wsEd.nodeId);
    if (!node) return;
    if (!Object.keys(node.params.customFrames || {}).length) return;
    pushHistory("ws:clear-overrides:" + node.id);
    node.params.customFrames = {};
    renderWavescanCanvas();
    renderCode(); renderJson(); renderProps();
  });

  // View toggle (3D / grid)
  document.querySelectorAll(".wt-tool-btn[data-view]").forEach(b => {
    b.addEventListener("click", () => {
      _wsEd.view = b.dataset.view || "3d";
      document.querySelectorAll(".wt-tool-btn[data-view]").forEach(x => {
        x.classList.toggle("active", x.dataset.view === _wsEd.view);
      });
      renderWavescanCanvas();
    });
  });

  // Keyboard scrub: ← → moves position by 1/512; shift = 1/64.
  document.addEventListener("keydown", e => {
    if (modal.style.display === "none") return;
    if (isTextInput(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      closeWavescanModal();
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault(); e.stopImmediatePropagation();
    const node = state.nodes.find(n => n.id === _wsEd.nodeId);
    if (!node) return;
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const step = e.shiftKey ? (1 / 64) : (1 / WS_FRAMES);
    node.params.position = Math.max(0, Math.min(1, (Number(node.params.position) || 0) + dir * step));
    if (posEl) posEl.value = String(node.params.position);
    renderWavescanCanvas();
    renderCode(); renderJson();
    renderMonitorControls();
  }, true);
}
setupWavescanModal();

/* ====================================================================
 * SAMPLE WAVEFORM EDITOR — modal for SamplePlayer / StereoSamplePlayer
 * / GranularPlayer. Displays the loaded asset's waveform (downsampled
 * min/max envelope, cached on the asset record so re-opens are
 * instant), with click-drag handles for the relevant parameters:
 *   - SamplePlayer / StereoSamplePlayer: start + end time markers
 *   - GranularPlayer: position cursor
 * Drop a file onto the canvas to replace the current asset; the
 * modal stays open with the new waveform.
 * ================================================================= */

const _smEd = {
  nodeId: null,
  drag: null,        // { kind: "start" | "end" | "position" }
};

/* Precomputed min/max envelope for a sample. Cached on the asset
 * record so opening the same sample twice doesn't re-scan the
 * (potentially multi-million-sample) buffer. SM_ENVELOPE_RES is the
 * fixed bucket count — 2048 is enough resolution for any reasonable
 * display width without making the cache itself huge. */
const SM_ENVELOPE_RES = 2048;
function smEnvelopeFor(asset, channel) {
  if (!asset) return null;
  const arr = (asset.channels >= 2 && Array.isArray(asset.data)) ? asset.data[channel | 0] : asset.data;
  if (!arr || !arr.length) return null;
  // Cache slot per channel: _envCache = [chan0, chan1]
  if (!asset._envCache) asset._envCache = [];
  if (asset._envCache[channel]) return asset._envCache[channel];
  const N = arr.length;
  const buckets = Math.min(SM_ENVELOPE_RES, N);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * N / buckets);
    const hi = Math.min(N, Math.floor((b + 1) * N / buckets));
    let mn = 1e9, mx = -1e9;
    for (let i = lo; i < hi; i++) {
      const v = arr[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn > mx) { mn = 0; mx = 0; }
    min[b] = mn;
    max[b] = mx;
  }
  const env = { min, max, N };
  asset._envCache[channel] = env;
  return env;
}

function smGetNode() {
  return state.nodes.find(n => n.id === _smEd.nodeId);
}
function smGetAsset() {
  const node = smGetNode();
  if (!node) return null;
  return getAsset(node.params && node.params.assetId);
}
function smIsGranular() {
  const node = smGetNode();
  return node && node.type === "GranularPlayer";
}
function smIsStereoNode() {
  const node = smGetNode();
  return node && node.type === "StereoSamplePlayer";
}

function openSampleModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  _smEd.nodeId = nodeId;
  _smEd.drag = null;
  const titleEl = document.getElementById("sample-modal-title");
  if (titleEl) titleEl.textContent = `[${node.id}]  ${node.type}`;
  const markerLbl = document.getElementById("sample-marker-label");
  if (markerLbl) markerLbl.textContent = smIsGranular() ? "POSITION" : "MARKERS";
  document.getElementById("sample-modal").style.display = "flex";
  requestAnimationFrame(() => renderSampleCanvas());
}

function closeSampleModal() {
  document.getElementById("sample-modal").style.display = "none";
  _smEd.nodeId = null;
  _smEd.drag = null;
}

function renderSampleCanvas() {
  const node = smGetNode();
  const svg = document.getElementById("sm-canvas");
  const stage = document.getElementById("sm-stage");
  if (!node || !svg || !stage) return;
  const W = stage.clientWidth || 1100;
  const H = stage.clientHeight || 460;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const asset = smGetAsset();
  // Update header readout + status cells
  const readoutEl = document.getElementById("sample-readout");
  const fileEl = document.getElementById("sm-stat-file");
  const durEl  = document.getElementById("sm-stat-dur");
  const srEl   = document.getElementById("sm-stat-sr");
  const lenEl  = document.getElementById("sm-stat-len");
  if (asset) {
    const samp = Array.isArray(asset.data) ? asset.data[0].length : asset.data.length;
    if (readoutEl) readoutEl.textContent = `${asset.name}  ·  ${asset.durationSec.toFixed(2)}s  ·  ${asset.sampleRate}Hz`;
    if (fileEl) fileEl.textContent = asset.name;
    if (durEl)  durEl.textContent  = asset.durationSec.toFixed(2) + " s";
    if (srEl)   srEl.textContent   = asset.sampleRate + " Hz";
    if (lenEl)  lenEl.textContent  = samp.toLocaleString() + (asset.channels >= 2 ? " × 2" : "");
  } else {
    if (readoutEl) readoutEl.textContent = "no file loaded";
    if (fileEl) fileEl.textContent = "—";
    if (durEl)  durEl.textContent  = "—";
    if (srEl)   srEl.textContent   = "—";
    if (lenEl)  lenEl.textContent  = "—";
  }

  let html = "";

  if (!asset) {
    // Empty-state hint + drop target. Visual cue that the user can
    // drag a file onto the canvas to load.
    html += `<text class="sm-no-asset" x="${W / 2}" y="${H / 2 - 10}">DRAG AN AUDIO FILE HERE</text>`;
    html += `<text class="sm-no-asset" x="${W / 2}" y="${H / 2 + 16}" style="font-size:10px; letter-spacing:0.10em;">OR CLICK REPLACE… ABOVE</text>`;
    svg.innerHTML = html;
    smUpdateMarkerReadout();
    return;
  }

  const isStereo = asset.channels >= 2;
  const lanes = isStereo ? 2 : 1;
  const laneH = H / lanes;
  const PAD_Y = 16;

  for (let lane = 0; lane < lanes; lane++) {
    const env = smEnvelopeFor(asset, isStereo ? lane : 0);
    if (!env) continue;
    const y0 = lane * laneH + PAD_Y;
    const yC = lane * laneH + laneH / 2;
    const y1 = (lane + 1) * laneH - PAD_Y;
    const ampH = (laneH - PAD_Y * 2) * 0.5;
    // Center reference line
    html += `<line class="sm-wave-center" x1="0" y1="${yC}" x2="${W}" y2="${yC}" />`;
    // Top of trace — max values
    let topPath = "M 0 " + yC.toFixed(1);
    let botPath = "M 0 " + yC.toFixed(1);
    for (let p = 0; p < W; p++) {
      const b = Math.floor(p * env.min.length / W);
      const mn = Math.max(-1, Math.min(1, env.min[b]));
      const mx = Math.max(-1, Math.min(1, env.max[b]));
      const yMin = yC - mn * ampH;   // negative samples → BELOW center → larger Y
      const yMax = yC - mx * ampH;
      topPath += " L " + p + " " + yMax.toFixed(1);
      botPath += " L " + p + " " + yMin.toFixed(1);
    }
    botPath += " L " + W + " " + yC.toFixed(1) + " L 0 " + yC.toFixed(1) + " Z";
    topPath += " L " + W + " " + yC.toFixed(1) + " L 0 " + yC.toFixed(1) + " Z";
    // Filled envelope (fills both top + bottom)
    html += `<path class="sm-wave-fill" d="${topPath}" />`;
    html += `<path class="sm-wave-fill" d="${botPath}" />`;
    // Edge stroke — a single polyline tracing max+min for visual punch
    let edgePath = "M 0 " + yC.toFixed(1);
    for (let p = 0; p < W; p++) {
      const b = Math.floor(p * env.min.length / W);
      const mx = Math.max(-1, Math.min(1, env.max[b]));
      const yMax = yC - mx * ampH;
      edgePath += " L " + p + " " + yMax.toFixed(1);
    }
    for (let p = W - 1; p >= 0; p--) {
      const b = Math.floor(p * env.min.length / W);
      const mn = Math.max(-1, Math.min(1, env.min[b]));
      const yMin = yC - mn * ampH;
      edgePath += " L " + p + " " + yMin.toFixed(1);
    }
    edgePath += " Z";
    html += `<path class="sm-wave-edge" d="${edgePath}" />`;
  }
  if (isStereo) {
    html += `<line class="sm-channel-divider" x1="0" y1="${laneH}" x2="${W}" y2="${laneH}" />`;
  }

  // Marker overlays — phosphor for granular position, info-cyan for
  // sample player start/end. Coordinates derived from the params.
  const totalSec = asset.durationSec;
  const secToX = (s) => Math.max(0, Math.min(W, (s / totalSec) * W));
  if (smIsGranular()) {
    const pos = Number(node.params.position) || 0;
    const x = pos * W;
    html += `<line class="sm-handle-line position" data-handle="position" x1="${x}" y1="0" x2="${x}" y2="${H}" />`;
    html += `<rect class="sm-handle-grip position" data-handle="position" x="${x - 6}" y="${H / 2 - 8}" width="12" height="16" rx="1" />`;
    html += `<text class="sm-handle-label position" x="${x + 8}" y="14">POS ${(pos * 100).toFixed(1)}%</text>`;
  } else {
    const startSec = Number(node.params.start) || 0;
    let endSec = Number(node.params.end);
    if (!isFinite(endSec) || endSec < 0) endSec = totalSec;
    const xs = secToX(startSec);
    const xe = secToX(endSec);
    // Region between start and end — slight cyan tint for the active span
    html += `<rect class="sm-handle-zone" x="${xs}" y="0" width="${Math.max(0, xe - xs)}" height="${H}" />`;
    html += `<line class="sm-handle-line" data-handle="start" x1="${xs}" y1="0" x2="${xs}" y2="${H}" />`;
    html += `<rect class="sm-handle-grip" data-handle="start" x="${xs - 6}" y="${H / 2 - 8}" width="12" height="16" rx="1" />`;
    html += `<text class="sm-handle-label" x="${xs + 8}" y="14">START ${startSec.toFixed(2)}s</text>`;
    html += `<line class="sm-handle-line" data-handle="end" x1="${xe}" y1="0" x2="${xe}" y2="${H}" />`;
    html += `<rect class="sm-handle-grip" data-handle="end" x="${xe - 6}" y="${H / 2 - 8}" width="12" height="16" rx="1" />`;
    html += `<text class="sm-handle-label" x="${Math.max(8, xe - 80)}" y="${H - 8}">END ${endSec.toFixed(2)}s</text>`;
  }

  svg.innerHTML = html;
  smUpdateMarkerReadout();
}

function smUpdateMarkerReadout() {
  const el = document.getElementById("sm-marker-readout");
  if (!el) return;
  const node = smGetNode();
  const asset = smGetAsset();
  if (!node || !asset) { el.textContent = "—"; return; }
  if (smIsGranular()) {
    const pos = Number(node.params.position) || 0;
    const sec = pos * asset.durationSec;
    el.textContent = `pos ${(pos * 100).toFixed(1)}%  ·  ${sec.toFixed(3)}s`;
  } else {
    const s = Number(node.params.start) || 0;
    let e = Number(node.params.end);
    if (!isFinite(e) || e < 0) e = asset.durationSec;
    const span = Math.max(0, e - s);
    el.textContent = `start ${s.toFixed(2)}s  end ${e.toFixed(2)}s  span ${span.toFixed(2)}s`;
  }
}

function smXToTime(clientX) {
  const svg = document.getElementById("sm-canvas");
  const asset = smGetAsset();
  if (!svg || !asset) return 0;
  const r = svg.getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width, clientX - r.left));
  return (x / r.width) * asset.durationSec;
}
function smXToFraction(clientX) {
  const svg = document.getElementById("sm-canvas");
  if (!svg) return 0;
  const r = svg.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
}

function smInstallCanvasHandlers() {
  const svg = document.getElementById("sm-canvas");
  if (!svg) return;

  svg.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    const node = smGetNode();
    const asset = smGetAsset();
    if (!node || !asset) return;
    ev.preventDefault();
    const target = ev.target;
    let kind = null;
    if (target && target.dataset && target.dataset.handle) {
      kind = target.dataset.handle;
    } else if (smIsGranular()) {
      // Granular: clicking anywhere sets the position cursor.
      kind = "position";
      node.params.position = smXToFraction(ev.clientX);
    } else {
      // SamplePlayer: clicking near the closest marker drags that one.
      const tSec = smXToTime(ev.clientX);
      const startSec = Number(node.params.start) || 0;
      let endSec = Number(node.params.end);
      if (!isFinite(endSec) || endSec < 0) endSec = asset.durationSec;
      const distStart = Math.abs(tSec - startSec);
      const distEnd   = Math.abs(tSec - endSec);
      kind = distStart < distEnd ? "start" : "end";
    }
    _smEd.drag = { kind };
    try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    pushHistory("sample:" + kind + ":" + node.id);
    smApplyDrag(ev);
    renderSampleCanvas();
    renderCode(); renderJson();
    renderMonitorControls();
  });
  svg.addEventListener("pointermove", ev => {
    if (!_smEd.drag) return;
    smApplyDrag(ev);
    renderSampleCanvas();
    renderCode(); renderJson();
    renderMonitorControls();
  });
  function endDrag() {
    if (_smEd.drag) {
      _smEd.drag = null;
      // Final commit re-renders props pane so e.g. the start/end
      // number inputs reflect the dragged value.
      renderProps();
    }
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
}

function smApplyDrag(ev) {
  const node = smGetNode();
  const asset = smGetAsset();
  if (!node || !asset || !_smEd.drag) return;
  const kind = _smEd.drag.kind;
  if (kind === "position") {
    node.params.position = smXToFraction(ev.clientX);
  } else if (kind === "start") {
    let endSec = Number(node.params.end);
    if (!isFinite(endSec) || endSec < 0) endSec = asset.durationSec;
    const t = Math.min(endSec - 0.001, smXToTime(ev.clientX));
    node.params.start = Math.max(0, t);
  } else if (kind === "end") {
    const startSec = Number(node.params.start) || 0;
    const t = Math.max(startSec + 0.001, smXToTime(ev.clientX));
    node.params.end = Math.min(asset.durationSec, t);
  }
}

/* Drop-zone wiring — full-stage drag-and-drop. preventDefault on
 * dragover is required for the drop event to fire. The visual
 * indicator is the .sm-stage.dragover class which reveals the
 * .sm-drop-overlay. Drops anywhere on the stage replace the asset. */
function smInstallDropZone() {
  const stage = document.getElementById("sm-stage");
  if (!stage) return;
  stage.addEventListener("dragover", ev => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    stage.classList.add("dragover");
  });
  stage.addEventListener("dragleave", ev => {
    // Only drop the dragover class when leaving the stage itself
    // (not when crossing into a child element). relatedTarget is null
    // when leaving the document entirely.
    if (!stage.contains(ev.relatedTarget)) stage.classList.remove("dragover");
  });
  stage.addEventListener("drop", async ev => {
    ev.preventDefault();
    stage.classList.remove("dragover");
    const node = smGetNode();
    if (!node) return;
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f) return;
    try {
      const rec = await loadAudioFileToAsset(f);
      pushHistory("asset:drop:" + node.id);
      node.params.assetId = rec.id;
      // Reset start/end to span the full new file (so clicking trig
      // plays it from the top by default — saves a rewire step).
      if (node.type !== "GranularPlayer") {
        node.params.start = 0;
        node.params.end   = rec.durationSec;
      }
      renderSampleCanvas();
      renderProps();
      renderCode(); renderJson();
    } catch (e) {
      alert("Audio decode failed: " + (e && e.message || e));
    }
  });
}

(function setupSampleModal() {
  const modal = document.getElementById("sample-modal");
  const close = document.getElementById("btn-sample-close");
  const done  = document.getElementById("btn-sample-done");
  const repl  = document.getElementById("btn-sample-replace");
  const clr   = document.getElementById("btn-sample-clear");
  if (!modal) return;
  if (close) close.addEventListener("click", closeSampleModal);
  if (done)  done.addEventListener("click",  closeSampleModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeSampleModal(); });
  if (repl) repl.addEventListener("click", () => {
    const node = smGetNode();
    if (!node) return;
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a";
    inp.addEventListener("change", async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const rec = await loadAudioFileToAsset(f);
        pushHistory("asset:replace:" + node.id);
        node.params.assetId = rec.id;
        if (node.type !== "GranularPlayer") {
          node.params.start = 0;
          node.params.end   = rec.durationSec;
        }
        renderSampleCanvas();
        renderProps(); renderCode(); renderJson();
      } catch (e) {
        alert("Audio decode failed: " + (e && e.message || e));
      }
    });
    inp.click();
  });
  if (clr) clr.addEventListener("click", () => {
    const node = smGetNode();
    if (!node) return;
    pushHistory("asset:clear:" + node.id);
    node.params.assetId = "";
    renderSampleCanvas();
    renderProps(); renderCode(); renderJson();
  });
  // Esc to close
  document.addEventListener("keydown", e => {
    if (modal.style.display === "none") return;
    if (isTextInput(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      closeSampleModal();
    }
  }, true);
  smInstallCanvasHandlers();
  smInstallDropZone();
})();

/* ====================================================================
 * SAMPLE ASSET REGISTRY
 *
 * Sample-based nodes (SamplePlayer / StereoSamplePlayer / Granular)
 * reference audio data via an `assetId` stored on the node's params.
 * The actual Float32Array(s) live in this in-memory registry, with
 * IndexedDB-backed persistence keyed by patch filename so samples
 * survive page reloads.
 *
 * Storage shape:
 *   editor.assets : Map<assetId, AssetRecord>
 *   AssetRecord = {
 *     id, name (original filename),
 *     sampleRate (decoded SR),
 *     channels (1 = mono Float32Array; 2 = [L, R]),
 *     durationSec,
 *     data (Float32Array or [Float32Array, Float32Array])
 *   }
 *
 * Sidecar manifest: on .gpatch save we emit `<patch>.assets.json`
 * alongside the .gpatch, listing each referenced assetId and its
 * metadata. The actual sample binaries are NOT bundled with the
 * .gpatch (multi-MB stems would inflate the JSON beyond reason);
 * users keep the .wav files they originally dragged in. The IDB
 * cache keeps them browser-side for repeat editing sessions.
 *
 * Codegen embeds samples up to 256K samples (~5.3 sec @ 48k mono)
 * directly as a static constexpr float[] + load() call. Larger
 * samples emit a TODO comment with the metadata so the user can
 * wire up runtime loading on the AlloLib side.
 * ================================================================= */

const _assets = new Map();          // assetId → AssetRecord (audio)
const _spriteAssets = new Map();    // assetId → SpriteAssetRecord (§8.A.1)
const _prefabAssets = new Map();    // assetId → PrefabAssetRecord (§8.A.6)
const _folderAssets = new Map();    // assetId → AssetFolderRecord (asset-folders sprint)
let _assetIdCounter = 1;

/* Sprint asset-folders -- function registry. Each function defines the
 * slots a folder of that function exposes. Slot list is fixed per
 * function (so a Playable Character folder always has the same slots),
 * but optional slots are marked with `optional: true` -- the LLM
 * auto-sort honors that when deciding which sprites get assigned.
 *
 * Adding a new function: add an entry here, the editor + LLM prompt
 * pick it up automatically. The function name is the IDB-stored
 * key on the folder record.
 *
 * Slot descriptions are sent to the LLM during auto-sort to help it
 * pick the right sprite for each slot. Keep them concise + literal
 * (the LLM matches sprite NAMES against descriptions). */
const _ASSET_FUNCTIONS = {
  "playable-character": {
    label: "Playable Character",
    description: "Player-controlled hero. Wires into PlatformerBody2D for movement.",
    slots: [
      { name: "idle",     desc: "Standing still pose; small ambient motion (breathing, tail sway)" },
      { name: "walk",     desc: "Walking sideways, 6-8 frame cycle" },
      { name: "run",      desc: "Running sideways, faster than walk with forward lean", optional: true },
      { name: "jump-up",  desc: "Crouch + leap, body compressing then extending upward" },
      { name: "jump-apex",desc: "Mid-air arc peak, body stretched", optional: true },
      { name: "fall",     desc: "Falling downward, arms/limbs spread" },
      { name: "land",     desc: "Brief crouch on landing impact", optional: true },
      { name: "crouch",   desc: "Held crouch / duck pose", optional: true },
      { name: "attack",   desc: "Attack swing / punch / shoot pose", optional: true },
      { name: "hurt",     desc: "Damage reaction frame", optional: true }
    ]
  },
  "enemy": {
    label: "Enemy",
    description: "Hostile NPC. Same slots as Character but with simpler AI defaults.",
    slots: [
      { name: "idle",     desc: "Default pose when not actively threatening" },
      { name: "patrol",   desc: "Walking back and forth" },
      { name: "attack",   desc: "Striking the player" },
      { name: "hurt",     desc: "Damage reaction", optional: true },
      { name: "die",      desc: "Death frame" }
    ]
  },
  "npc": {
    label: "NPC (non-combat)",
    description: "Friendly or neutral. Often dialog hooks.",
    slots: [
      { name: "idle",     desc: "Standing still" },
      { name: "talk",     desc: "Talking / gesturing pose", optional: true },
      { name: "walk",     desc: "Walking", optional: true }
    ]
  },
  "decoration": {
    label: "Terrain Decoration",
    description: "Static (or looping) scenery — trees, rocks, signs, banners. No interaction.",
    slots: [
      { name: "main",     desc: "The decoration itself" }
    ]
  },
  "item": {
    label: "Item / Collectible",
    description: "Pickups, power-ups, coins. Usually has a looping idle + a one-shot collect.",
    slots: [
      { name: "idle",     desc: "Looping idle frames (twinkle, bob, sparkle)" },
      { name: "collect",  desc: "One-shot collected animation (poof, fade)", optional: true }
    ]
  },
  "interactive": {
    label: "Interactive Object",
    description: "Switches, buttons, levers. Two states + optional transition.",
    slots: [
      { name: "off",      desc: "Inactive / default state" },
      { name: "on",       desc: "Activated state" },
      { name: "transition", desc: "Animation between off and on", optional: true }
    ]
  },
  "door": {
    label: "Door / Portal",
    description: "Opens and closes; the player passes through. Often locked → unlocked.",
    slots: [
      { name: "closed",   desc: "Fully closed" },
      { name: "opening",  desc: "Mid-animation opening", optional: true },
      { name: "open",     desc: "Fully open" },
      { name: "closing",  desc: "Mid-animation closing", optional: true }
    ]
  },
  "effect": {
    label: "Effect (particles / hits)",
    description: "One-shot VFX: explosions, sparkles, hit-flashes. Frames play once.",
    slots: [
      { name: "frame0",   desc: "First frame of the effect" },
      { name: "frame1",   desc: "Second frame", optional: true },
      { name: "frame2",   desc: "Third frame", optional: true },
      { name: "frame3",   desc: "Fourth frame", optional: true }
    ]
  }
};
const ASSET_EMBED_LIMIT = 262144;   // ~5.3 sec @ 48kHz mono

/* Sprint §8.A.1 -- generic Assets namespace. Wraps the existing IDB
 * + in-memory maps so callers don't need to know which map a given
 * asset type lives in. Audio records (no `assetType` field, written
 * by the old `loadAudioFileToAsset` path) are treated as audio by
 * default for backward compat. New record types must set
 * `assetType: "sprite"` (or future "font" / "midi-clip" / etc.).
 *
 * API:
 *   Assets.put(record)       async; writes IDB + in-memory map for type
 *   Assets.get(id)           sync; returns record from whichever map holds it
 *   Assets.list({type})      sync; returns array of records (filtered by type if given)
 *   Assets.delete(id)        async; removes from IDB + memory
 *   Assets.byType(type)      sync; returns the Map for that type (live ref)
 *
 * Records always carry { id, assetType, name, createdAt, updatedAt }.
 * Type-specific fields live alongside (e.g. sprite has blob + framesX/Y;
 * audio has data + sampleRate). */
const Assets = {
  byType(type) {
    if (type === "sprite") return _spriteAssets;
    if (type === "folder") return _folderAssets;
    if (type === "prefab") return _prefabAssets;   // §8.A.6
    return _assets;  // default = audio
  },
  async put(record) {
    if (!record || !record.id) throw new Error("Assets.put: record needs an id");
    record.updatedAt = Date.now();
    if (!record.createdAt) record.createdAt = record.updatedAt;
    const map = this.byType(record.assetType);
    map.set(record.id, record);
    try { await _idbPut(record); } catch (e) { console.warn("[assets] put IDB failed:", e); }
    // §8.A.6 -- when a prefab asset is updated, invalidate all live
    // PrefabInstance refs so they re-expand from the new template
    // on the next tick.
    if (record.assetType === "prefab" && typeof _invalidatePrefabRefs === "function") {
      _invalidatePrefabRefs(record.id);
    }
    return record;
  },
  get(id) {
    if (_spriteAssets.has(id)) return _spriteAssets.get(id);
    if (_folderAssets.has(id)) return _folderAssets.get(id);
    if (_prefabAssets.has(id)) return _prefabAssets.get(id);
    if (_assets.has(id))       return _assets.get(id);
    return null;
  },
  list(opts) {
    const type = opts && opts.type;
    if (type === "sprite") return Array.from(_spriteAssets.values());
    if (type === "folder") return Array.from(_folderAssets.values());
    if (type === "prefab") return Array.from(_prefabAssets.values());
    if (type === "audio")  return Array.from(_assets.values());
    // No type filter: everything.
    return Array.from(_assets.values())
      .concat(Array.from(_spriteAssets.values()))
      .concat(Array.from(_folderAssets.values()))
      .concat(Array.from(_prefabAssets.values()));
  },
  async delete(id) {
    let found = false;
    if (_spriteAssets.has(id)) { _spriteAssets.delete(id); found = true; }
    if (_folderAssets.has(id)) { _folderAssets.delete(id); found = true; }
    if (_prefabAssets.has(id)) { _prefabAssets.delete(id); found = true; }
    if (_assets.has(id))       { _assets.delete(id);       found = true; }
    if (!found) return false;
    try { await _idbDelete(id); } catch (e) { console.warn("[assets] delete IDB failed:", e); }
    return true;
  },
  // §8.A.6 -- prefab lookup by user-facing name (case-insensitive).
  findPrefabByName(name) {
    if (typeof name !== "string") return null;
    const lower = name.toLowerCase();
    for (const rec of _prefabAssets.values()) {
      if ((rec.name || "").toLowerCase() === lower) return rec;
    }
    return null;
  },
  // Find sprite by user-facing name (case-insensitive). Used by the
  // `asset:NAME` ImageURL resolver in §8.A.2.
  findSpriteByName(name) {
    if (typeof name !== "string") return null;
    const lower = name.toLowerCase();
    for (const rec of _spriteAssets.values()) {
      if ((rec.name || "").toLowerCase() === lower) return rec;
    }
    return null;
  },
  // Find folder by user-facing name (case-insensitive). Used by the
  // scene-bulk drop handler + future SpriteCollection nodes.
  findFolderByName(name) {
    if (typeof name !== "string") return null;
    const lower = name.toLowerCase();
    for (const rec of _folderAssets.values()) {
      if ((rec.name || "").toLowerCase() === lower) return rec;
    }
    return null;
  },
  // Resolve a slot in a folder to the underlying sprite asset record.
  // Returns null if the slot is empty or the assigned sprite was deleted.
  resolveFolderSlot(folder, slotName) {
    if (!folder || !folder.slots) return null;
    const sid = folder.slots[slotName];
    if (!sid) return null;
    return _spriteAssets.get(sid) || null;
  }
};
if (typeof window !== "undefined") window.Assets = Assets;

/* Globally-held mic MediaStream + cached device label. One grant per
 * session shared across all MicInput nodes (browsers only need one
 * `getUserMedia` permission per origin). When the AudioWorklet
 * runtime integration lands [v2], this is the stream that gets
 * connected via MediaStreamAudioSourceNode → AudioWorkletNode. */
let _micStream = null;
let _micDeviceLabel = "";

function _newAssetId() {
  return "a_" + Date.now().toString(36) + "_" + (_assetIdCounter++).toString(36);
}

/* ── IndexedDB layer ─────────────────────────────────────────────
 * Single object store "assets", keyed by assetId. Float32Arrays are
 * structured-cloned natively, no serialization needed. */
const IDB_NAME = "gamma-node-assets";
const IDB_STORE = "assets";
let _idbPromise = null;
function _idbOpen() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}
async function _idbPut(record) {
  const db = await _idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function _idbDelete(id) {
  const db = await _idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function _idbLoadAll() {
  const db = await _idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* Restore all previously-stored assets into the in-memory map on
 * startup. Idempotent — calls a second time noop if already loaded. */
let _assetsLoaded = false;
async function loadAssetsFromIdb() {
  if (_assetsLoaded) return;
  _assetsLoaded = true;
  try {
    const records = await _idbLoadAll();
    let nAudio = 0, nSprite = 0, nFolder = 0, nPrefab = 0;
    records.forEach(r => {
      // §8.A.1 + asset-folders + §8.A.6 dispatch: bucket by assetType.
      // Old audio records (written before §8.A.1) have no assetType
      // field; default them to "audio" for backward compatibility.
      if      (r.assetType === "sprite") { _spriteAssets.set(r.id, r); nSprite++; }
      else if (r.assetType === "folder") { _folderAssets.set(r.id, r); nFolder++; }
      else if (r.assetType === "prefab") { _prefabAssets.set(r.id, r); nPrefab++; }
      else                               { _assets.set(r.id, r);       nAudio++; }
    });
    if (nAudio + nSprite + nFolder + nPrefab > 0) {
      console.log("[assets] loaded from IDB: " + nAudio + " audio, " + nSprite + " sprite, " +
        nFolder + " folder, " + nPrefab + " prefab");
    }
    // Refresh any open props pane so file-name labels appear.
    if (typeof renderProps === "function") renderProps();
    // Refresh the Assets tab if it's currently open.
    if (typeof brRenderAssets === "function") {
      try { brRenderAssets(); } catch (_) {}
    }
  } catch (e) {
    console.warn("[assets] IDB load failed:", e);
  }
}
// Kick off the load — no need to await; UI fills in as data arrives.
loadAssetsFromIdb();

/* ── Sprite asset creation (§8.A.1) ─────────────────────────────── */
/* Take a dropped/selected image file (PNG/JPEG/WebP/GIF), read its
 * pixel dimensions, generate a unique id + name, and store it as a
 * sprite asset (in IDB + _spriteAssets). Returns the asset record so
 * callers can immediately wire it into an ImageURL node.
 *
 * Default metadata: framesX=1, framesY=1, fps=1, anchor center. The
 * SpriteCreator UI (§8.A.2 followup) will let users edit those after
 * upload. Animation framing has to come from the user because we can't
 * auto-detect grid layout from a single PNG. */
async function loadImageFileToSpriteAsset(file, opts) {
  if (!file) return null;
  opts = opts || {};
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf], { type: file.type || "image/png" });
  // Read dimensions via createImageBitmap (faster than HTMLImageElement).
  let width = 0, height = 0;
  try {
    const bmp = await createImageBitmap(blob);
    width = bmp.width; height = bmp.height;
    if (bmp.close) try { bmp.close(); } catch (_) {}
  } catch (e) {
    console.warn("[assets] sprite decode failed for " + file.name + ":", e);
    return null;
  }
  // Derive a clean name: strip extension + collapse non-name chars.
  const baseName = (typeof opts.name === "string" && opts.name)
    ? opts.name
    : file.name.replace(/\.[^/.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-");
  const rec = {
    id: "spr_" + Date.now() + "_" + Math.floor(Math.random() * 1e6),
    assetType: "sprite",
    name: baseName,
    blob,
    mimeType: blob.type,
    width, height,
    framesX: (typeof opts.framesX === "number" && opts.framesX > 0) ? opts.framesX : 1,
    framesY: (typeof opts.framesY === "number" && opts.framesY > 0) ? opts.framesY : 1,
    fps: (typeof opts.fps === "number" && opts.fps > 0) ? opts.fps : 1,
    // §8.A.3 -- pixels per world unit. Drop-time Sprite sizing reads
    // this. Default 32 matches typical retro tile pitch.
    scale: (typeof opts.scale === "number" && opts.scale > 0) ? opts.scale : 32,
    anchor: opts.anchor || { x: 0.5, y: 0.5 },
    hitbox: opts.hitbox || null,
    palette: opts.palette || [],
    source: opts.source || "drop",   // "drop" / "creator" / "batch" / "asset:NAME"
  };
  await Assets.put(rec);
  console.log("[assets] added sprite '" + rec.name + "' (" + width + "×" + height + ") id=" + rec.id);
  return rec;
}

/* ── Sprite Studio modal (SpriteCreator-1) ──────────────────────── */
/* LLM-driven pixel art generator. Opens from the topbar 'Sprite Studio'
 * button. User types a description; Claude (or local Gemma) writes JS
 * canvas paint code; we run it against an offscreen canvas; preview
 * + save into the asset library.
 *
 * System prompt is crafted to:
 *   - Forbid corporate-IP references (no Mario, Pokemon, Disney, etc).
 *   - Produce concise canvas-2D code (no setup boilerplate).
 *   - Honor size + frame count (multi-frame strips horizontal).
 *   - Use a palette appropriate to the chosen style preset.
 *
 * Generated JS runs in `new Function('ctx', 'width', 'height', 'framesX', 'framesY', code)`.
 * The LLM is trusted via the user's own API key; v1 trades worker
 * isolation for simpler debugging. Future hardening = Worker sandbox. */
const _SS_STYLE_PROMPTS = {
  snes: "16-bit SNES era pixel art, limited palette of 16 colors, no anti-aliasing on edges (1px solid strokes only), readable silhouette, slight shading for depth using 2-3 tones per color.",
  nes:  "8-bit NES era pixel art, hard-limit to 4 colors per sprite total (one transparent + three solids), bold flat colors with no gradient, blocky silhouette.",
  gameboy: "Game Boy era pixel art, hard-limit to 4 colors from the GB palette (#0f380f, #306230, #8bac0f, #9bbc0f), no other colors.",
  modern: "Modern pixel art style, free palette, soft shading is OK, anti-aliasing on diagonals is OK, crisp silhouette."
};
function _ssBuildSystemPrompt() {
  return [
    "You are a pixel-art sprite painter. The user describes a sprite; you write JavaScript that draws it onto a CanvasRenderingContext2D.",
    "",
    "OUTPUT RULES:",
    "- Output ONLY raw JavaScript code, no markdown fences, no comments, no setup.",
    "- The available globals are: ctx (CanvasRenderingContext2D), width (number), height (number), framesX (number, columns), framesY (number, rows).",
    "- For multi-frame sprites: width and height are the FULL sheet dimensions; one frame is (width/framesX) x (height/framesY). Draw frames left-to-right, top-to-bottom.",
    "- Do NOT call any APIs other than ctx.* (no fetch, no document, no window, no eval, no new Function, no createElement).",
    "- Do NOT reference any real-world brand, franchise, character name, or company. Generic descriptions only (e.g. 'red fox', NOT 'Pokemon fox').",
    "- The canvas comes pre-cleared to transparent. Draw your sprite directly.",
    "- Use ctx.fillRect with integer coords for crisp pixels. Do not use fillStyle gradients on edges.",
    "",
    "STYLE: see the user message for the chosen preset."
  ].join("\n");
}
function _ssBuildUserPrompt(description, stylePreset, width, height, framesX, framesY) {
  const styleNote = _SS_STYLE_PROMPTS[stylePreset] || _SS_STYLE_PROMPTS.snes;
  const frameNote = (framesX > 1 || framesY > 1)
    ? `Animation: ${framesX * framesY} frames arranged as ${framesX} cols x ${framesY} rows. Each frame is ${Math.floor(width/framesX)}x${Math.floor(height/framesY)} pixels.`
    : "Single frame.";
  return [
    `Sprite description: ${description}`,
    `Sheet size: ${width}x${height} pixels.`,
    frameNote,
    `Style: ${styleNote}`,
    "",
    "Now output the JavaScript paint code:"
  ].join("\n");
}

function _ssNextPow2(n) {
  let v = 256;
  while (v < n) v *= 2;
  return v;
}

/* §sd-polish -- poll /sprite-gen/info to mark installed models in the
 * dropdown and surface the current worker state. Updates the
 * #ss-model-status line below the dropdown.
 *
 * Output shapes (small bits, all defensive):
 *   server unreachable:  "compile-server not detected (defaults shown)"
 *   server ok, none installed: "no models installed -- run scripts/install-sd.sh"
 *   server ok, X installed:    "installed: z-image-turbo, sdxl • worker: idle"
 *   worker loaded:             "installed: z-image-turbo • worker: z-image-turbo (ready)" */
async function _ssRefreshModelStatus() {
  const statusEl = document.getElementById("ss-model-status");
  const modelEl  = document.getElementById("ss-sd-model");
  if (!statusEl || !modelEl) return;
  statusEl.textContent = "checking compile-server…";
  const base = (typeof localServerEndpoint === "string" && localServerEndpoint)
    ? localServerEndpoint
    : "http://127.0.0.1:8765";
  try {
    const res = await fetch(base.replace(/\/+$/, "") + "/sprite-gen/info", {
      method: "GET",
      cache: "no-store"
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const info = await res.json();
    if (!info || !info.models) throw new Error("missing models field");
    // Decorate dropdown options with an installed marker.
    const opts = modelEl.querySelectorAll("option");
    const installed = [];
    opts.forEach(opt => {
      const m = info.models[opt.value];
      const ok = m && m.installed;
      // Strip any previous prefix added by us, then prepend new marker.
      const label = (opt.textContent || "").replace(/^(✓ |• )/, "");
      opt.textContent = (ok ? "✓ " : "• ") + label;
      if (ok) installed.push(opt.value);
    });
    let line = "";
    if (installed.length === 0) {
      line = "no models installed — run scripts/install-sd.sh in the compile-server";
    } else {
      line = "installed: " + installed.join(", ");
    }
    if (info.currentWorker) {
      line += " • worker: " + info.currentWorker.model +
              (info.currentWorker.ready ? " (ready)" : " (loading…)");
    } else {
      line += " • worker: idle";
    }
    statusEl.textContent = line;
  } catch (e) {
    statusEl.textContent = "compile-server not detected (defaults shown)";
  }
}

/* Sprint sprite-sd-1 -- call AUTOMATIC1111 webui's txt2img endpoint.
 * Returns a Blob (PNG) on success. Throws on network / API errors.
 *
 * A1111 native generation size is set per-call (we use 512×512 for
 * fidelity); the result is downsampled to the user's target sprite
 * dims via nearest-neighbor in _ssDownsampleBlob.
 *
 * Prompt construction:
 *   - Prepend pixel-art keywords matching the chosen style preset.
 *   - Append a strong negative prompt (blur / AA / gradient / artifacts).
 *   - Don't enrich with corporate IP terms; respect the system rule. */
const _SS_SD_NEGATIVE = "blurry, smooth, anti-aliased, soft, gradient, low quality, watermark, text, signature, jpeg artifacts, motion blur, dithered, noisy, scenery, environment, landscape, background details, props, multiple subjects, tiny subject, distant subject, cropped";
const _SS_SD_STYLE_PROMPTS = {
  snes:    "pixel art, 16-bit SNES style, crisp pixels, limited 16-color palette, hard edges, no anti-aliasing",
  nes:     "pixel art, 8-bit NES style, 4 colors, blocky, hard edges, no anti-aliasing",
  gameboy: "pixel art, Game Boy DMG style, 4-shade green palette (#0f380f, #306230, #8bac0f, #9bbc0f), hard edges",
  modern:  "pixel art, modern indie game style, crisp pixels, limited palette"
};
/* Composition tail appended to every SD prompt. The key things this
 * does: push subject to fill the frame (otherwise the model loves
 * to leave 60% empty space around it -- looks fine in art galleries,
 * useless for a 32×32 sprite where the subject ends up 8px tall),
 * and lock the background to plain white so the chroma-key in
 * _ssDownsampleBlob can isolate the sprite cleanly. */
const _SS_SD_COMPOSITION = "subject fills entire frame, full body in view, large centered subject, isolated subject, on plain pure white background #ffffff, no scenery, no decoration";
/* Sprint sprite-sd-2 -- call the compile-server's /sprite-gen route,
 * which proxies to a persistent Python SD worker. The server returns a
 * raw PNG; we just package it into a Blob.
 *
 * Endpoint URL: compile-server's base (auto-detected by the existing
 * compileServer.detect path; default http://127.0.0.1:8765).
 *
 * Model + LoRA defaults live server-side per the MODELS map in
 * sd-route.js; the browser only sends `model`, `prompt`, `width`,
 * `height`, `steps?`, `seed?`, and the server fills the rest. */
async function _ssCallCompileServerSD(serverBase, model, prompt, stylePreset, nativeSize, steps, seed) {
  const styleNote = _SS_SD_STYLE_PROMPTS[stylePreset] || _SS_SD_STYLE_PROMPTS.snes;
  const fullPrompt = styleNote + ", " + prompt + ", " + _SS_SD_COMPOSITION;
  const url = serverBase.replace(/\/+$/, "") + "/sprite-gen";
  const body = {
    model,
    prompt: fullPrompt,
    negative: _SS_SD_NEGATIVE,
    width: nativeSize,
    height: nativeSize,
    steps: Math.max(1, Math.floor(steps))
  };
  // Optional seed -- critical for multi-pose batches where every
  // frame must look like the same character. Caller picks one random
  // seed before the loop and passes it to every per-frame call.
  if (typeof seed === "number" && seed >= 0) body.seed = seed;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error("Cannot reach compile-server at " + serverBase
      + " — is `gamma-compile-server` running and has scripts/install-sd.sh been run? " + (e.message || e));
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.error || JSON.stringify(j);
    } catch (_) {}
    throw new Error("compile-server /sprite-gen " + res.status + ": " + detail);
  }
  const elapsedMs = res.headers.get("X-SD-Elapsed-Ms");
  const device = res.headers.get("X-SD-Device");
  if (elapsedMs || device) {
    console.log("[sprite-studio] SD generated in " + elapsedMs + "ms on " + device);
  }
  return await res.blob();
}

async function _ssCallA1111(endpoint, prompt, stylePreset, nativeSize, steps, sampler) {
  const url = (endpoint || "http://localhost:7860").replace(/\/+$/, "") + "/sdapi/v1/txt2img";
  const styleNote = _SS_SD_STYLE_PROMPTS[stylePreset] || _SS_SD_STYLE_PROMPTS.snes;
  const fullPrompt = styleNote + ", " + prompt + ", " + _SS_SD_COMPOSITION;
  const body = {
    prompt: fullPrompt,
    negative_prompt: _SS_SD_NEGATIVE,
    width: nativeSize,
    height: nativeSize,
    steps: Math.max(5, Math.min(100, Math.floor(steps))),
    sampler_name: sampler || "DPM++ 2M Karras",
    cfg_scale: 7.0,
    seed: -1
  };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error("Cannot reach A1111 at " + endpoint + " (is the webui running with --api?). " + (e.message || e));
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("A1111 " + res.status + ": " + (txt || res.statusText));
  }
  const data = await res.json();
  if (!data.images || !data.images.length) throw new Error("A1111 returned no images");
  // images[0] is a base64 PNG (no data: prefix).
  const b64 = data.images[0];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: "image/png" });
}

/* Downsample a Blob (PNG) to the target sprite dimensions using
 * nearest-neighbor filtering, returning a new PNG Blob. This is what
 * makes 1024×1024 SD output land on a 32×32 sprite as crisp pixels.
 * Also strips the (prompted) white background via a chroma-key so the
 * resulting sprite has a transparent background and can be composited
 * straight into a Scene2D without a halo. */
async function _ssDownsampleBlob(srcBlob, targetW, targetH) {
  const bmp = await createImageBitmap(srcBlob);
  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, targetW, targetH);
  if (bmp.close) try { bmp.close(); } catch (_) {}
  // Chroma-key the prompted white background. We push hard for
  // "plain pure white background" in _SS_SD_COMPOSITION, so a tight
  // threshold cleanly isolates the sprite without eating its own
  // highlights (white-on-fur is rare and usually <230 in practice).
  _ssChromaKeyWhite(canvas, ctx, 232);
  return await canvas.convertToBlob({ type: "image/png" });
}

/* Mark every pixel whose RGB channels are all ≥ `threshold` as
 * transparent. The threshold is tuned for SD's "plain white" output:
 * 232 catches near-white halos around the subject while preserving
 * the sprite's own light tones (which usually fall in the 180-220
 * range after the pixel-art LoRA/prompt collapses the palette). */
function _ssChromaKeyWhite(canvas, ctx, threshold) {
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const t = threshold ?? 232;
  let cleared = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] >= t && d[i + 1] >= t && d[i + 2] >= t) {
      d[i + 3] = 0;
      cleared++;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cleared;
}

/* Build a list of N pose-variant prompt fragments for a multi-frame
 * sprite-sheet batch. Pose names land in the model prompt as
 * "<description>, <pose>, side view, ...composition tail". Combined
 * with a shared seed across all frames, this produces a consistent
 * character animated through the poses.
 *
 * Recipes are hardcoded for the common SNES-era walk-cycle counts
 * (1 / 2 / 4 / 6 / 8). Arbitrary counts fall through to an
 * idle-alternate pattern so a 12-frame sheet still has variety. */
function _ssBuildPosePrompts(totalFrames) {
  if (totalFrames <= 1) return [""];
  if (totalFrames === 2) return ["idle stance, side view", "walking pose, side view"];
  if (totalFrames === 4) return [
    "idle stance, side view",
    "walking, right foot forward, side view",
    "idle stance mid-stride, side view",
    "walking, left foot forward, side view"
  ];
  if (totalFrames === 6) return [
    "idle stance, side view",
    "walking, right foot lift, side view",
    "walking, right foot forward, side view",
    "idle stance mid-stride, side view",
    "walking, left foot lift, side view",
    "walking, left foot forward, side view"
  ];
  if (totalFrames === 8) return [
    "idle stance, side view",
    "walking, right foot slight lift, side view",
    "walking, right foot mid stride, side view",
    "walking, right foot forward full step, side view",
    "idle stance, side view",
    "walking, left foot slight lift, side view",
    "walking, left foot mid stride, side view",
    "walking, left foot forward full step, side view"
  ];
  // Fallback for arbitrary N: alternate idle / walk / idle / walk-other.
  const variants = [
    "idle stance, side view",
    "walking, right foot forward, side view",
    "idle stance mid-stride, side view",
    "walking, left foot forward, side view"
  ];
  return Array.from({ length: totalFrames }, (_, i) => variants[i % variants.length]);
}

/* Stitch N already-downsampled per-frame blobs into a single sheet
 * canvas of dimensions (frameW*cols) × (frameH*rows). Frames are
 * laid out left-to-right, top-to-bottom -- the same convention
 * Scene2D / Sprite expects when reading framesX/framesY metadata. */
async function _ssStitchSheet(frameBlobs, frameW, frameH, cols, rows) {
  const sheetW = frameW * cols;
  const sheetH = frameH * rows;
  const canvas = new OffscreenCanvas(sheetW, sheetH);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, sheetW, sheetH);
  for (let i = 0; i < frameBlobs.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const bmp = await createImageBitmap(frameBlobs[i]);
    ctx.drawImage(bmp, col * frameW, row * frameH);
    if (bmp.close) try { bmp.close(); } catch (_) {}
  }
  return await canvas.convertToBlob({ type: "image/png" });
}

/* Strip markdown fences if Claude wrapped the code despite instructions. */
function _ssExtractJsFromResponse(text) {
  if (!text) return "";
  // Match ```javascript ... ``` or ``` ... ``` fences.
  const fence = text.match(/```(?:javascript|js)?\s*\n?([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return text.trim();
}

/* Run the generated JS against an OffscreenCanvas, return the bitmap.
 * Throws if the code errors. Time-budget: hard 2-second cap via setTimeout
 * defeats infinite loops only across yields (a tight sync loop will still
 * hang for now; Worker isolation in -2 fixes that). */
async function _ssExecutePaintCode(code, width, height, framesX, framesY) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // Match the sprite shader's "pixelated" rendering convention.
  ctx.imageSmoothingEnabled = false;
  // Throws if code is invalid JavaScript.
  const fn = new Function("ctx", "width", "height", "framesX", "framesY", code);
  fn(ctx, width, height, framesX, framesY);
  return await canvas.convertToBlob({ type: "image/png" });
}

/* Open / close the Sprite Studio modal.
 *
 * When called with a SpriteCreator nodeId, preload the modal's inputs
 * from the node's params (prompt / style / size / frames / fps / scale)
 * and remember the nodeId so Save writes the new asset name back to
 * node.params.lastAssetName. When called without a nodeId (e.g. from
 * a future topbar button or REPL), the modal opens with whatever
 * inputs are already in place. */
function _ssOpen(nodeId) {
  const modal = document.getElementById("spritestudio-modal");
  if (!modal) return;
  modal.style.display = "flex";
  modal._ssSourceNodeId = nodeId || null;
  // Prefill from the SpriteCreator node's params if one was supplied.
  if (nodeId) {
    const node = (typeof nodeById === "function") ? nodeById(nodeId) : null;
    if (node && node.params) {
      const p = node.params;
      if (typeof p.prompt   === "string") document.getElementById("ss-prompt").value = p.prompt;
      if (typeof p.style    === "string") document.getElementById("ss-preset").value = p.style;
      if (typeof p.width    === "number") document.getElementById("ss-width").value  = p.width;
      if (typeof p.height   === "number") document.getElementById("ss-height").value = p.height;
      if (typeof p.framesX  === "number") document.getElementById("ss-framesX").value = p.framesX;
      if (typeof p.framesY  === "number") document.getElementById("ss-framesY").value = p.framesY;
      if (typeof p.fps      === "number") document.getElementById("ss-fps").value    = p.fps;
      if (typeof p.scale    === "number") document.getElementById("ss-scale").value  = p.scale;
    }
  }
  // Default name to a slugified prompt-ish placeholder if empty.
  const nameEl = document.getElementById("ss-name");
  if (nameEl && !nameEl.value) nameEl.value = "sprite-" + Date.now().toString(36).slice(-5);
  // §sd-1 -- prefill SD endpoint / steps / sampler / chosen backend
  // from persisted aiSettings so the user's last picks come back.
  const backendEl = document.getElementById("ss-backend");
  if (backendEl) {
    backendEl.value = aiSettings.spriteBackend || "llm-canvas";
    if (backendEl._ssUpdateUI) backendEl._ssUpdateUI();
  }
  const sdEndpointEl = document.getElementById("ss-sd-endpoint");
  if (sdEndpointEl) sdEndpointEl.value = aiSettings.sdEndpoint || "http://localhost:7860";
  const sdStepsEl = document.getElementById("ss-sd-steps");
  if (sdStepsEl) sdStepsEl.value = aiSettings.sdSteps || 20;
  const sdSamplerEl = document.getElementById("ss-sd-sampler");
  if (sdSamplerEl) sdSamplerEl.value = aiSettings.sdSampler || "DPM++ 2M Karras";
  // §sd-polish -- model dropdown for the compile-server SD backend.
  const sdModelEl = document.getElementById("ss-sd-model");
  if (sdModelEl) sdModelEl.value = aiSettings.sdModel || "z-image-turbo";
  const sdQualityEl = document.getElementById("ss-sd-quality");
  if (sdQualityEl) sdQualityEl.value = aiSettings.sdQuality || "512";
  // Fetch /sprite-gen/info to mark which models are actually downloaded
  // on the server. Async; no spinner -- status line updates when reply
  // arrives (typically 10-50 ms for the compile-server probe).
  _ssRefreshModelStatus();
  _ssRedrawPreview(null);  // clear preview if any
  const promptEl = document.getElementById("ss-prompt");
  if (promptEl) setTimeout(() => promptEl.focus(), 50);
}
function _ssClose() {
  const modal = document.getElementById("spritestudio-modal");
  if (modal) {
    modal.style.display = "none";
    modal._ssSourceNodeId = null;
  }
}

/* ───────────────────────────────────────────────────────────────
 * Sprint tilemap-painter -- visual click-paint editor for
 * Tilemap2D nodes. Opens via the ⚙ gear handle on a Tilemap2D
 * node. Loads tileData + palette + dims into a canvas grid;
 * user paints with brush '.', '1'..'5'; Save writes the modified
 * tileData back to the node and triggers a mesh rebuild via the
 * existing meshCacheKey path.
 *
 * State held on the DOM modal element itself (modal._tme):
 *   nodeId    -- the source Tilemap2D
 *   rows[]    -- working copy of tileData split into row strings
 *   brush     -- active paint character
 *   cellPx    -- canvas-side cell size (16 px)
 *   palette   -- [{ch, color}] for swatch rendering
 *   painting  -- true while pointer is down (paint stroke)
 *   eraseMode -- true if right button held (paints '.')
 * ─────────────────────────────────────────────────────────────── */
const _TME_BRUSH_CHARS = [".", "1", "2", "3", "4", "5"];
const _TME_BRUSH_LABELS = {
  ".": "empty (sky)",
  "1": "grass / color1",
  "2": "dirt / color2",
  "3": "stone / color3",
  "4": "pickup '4'",
  "5": "goal '5'"
};

function _tmeOpen(nodeId) {
  if (!state || !Array.isArray(state.nodes)) return;
  const node = state.nodes.find(n => n && n.id === nodeId);
  if (!node || node.type !== "Tilemap2D") {
    console.warn("[tilemap-painter] node not found or not Tilemap2D: " + nodeId);
    return;
  }
  const modal = document.getElementById("tilemap-editor-modal");
  if (!modal) return;
  const p = node.params || {};
  const data = (typeof p.tileData === "string") ? p.tileData : "";
  // Split into mutable row array. Pad short rows so the grid is
  // rectangular (avoids ragged-edge clicks landing in undefined col).
  let rows = data.split(/\r?\n/);
  const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);
  rows = rows.map(r => r.padEnd(maxLen, "."));
  // Build palette swatches from the node's current color params.
  const palette = _TME_BRUSH_CHARS.map(ch => ({
    ch,
    color: _tmeColorForChar(ch, p)
  }));
  modal._tme = {
    nodeId,
    rows,
    cols: maxLen,
    nRows: rows.length,
    brush: "1",
    cellPx: 16,
    palette,
    painting: false,
    eraseMode: false
  };
  document.getElementById("tme-cols").value = maxLen;
  document.getElementById("tme-rows").value = rows.length;
  document.getElementById("tme-status").textContent =
    "Tilemap2D#" + node.id + " — " + maxLen + " × " + rows.length;
  _tmeRenderPalette();
  _tmeRenderGrid();
  modal.style.display = "flex";
}

function _tmeClose() {
  const modal = document.getElementById("tilemap-editor-modal");
  if (modal) {
    modal.style.display = "none";
    modal._tme = null;
  }
}

/* Convert a tile char to a CSS hex color using the node's palette
 * params (color1R/G/B etc). For '.' returns transparent-marker dark
 * gray so the brush UI shows it as the "empty" choice. */
function _tmeColorForChar(ch, p) {
  if (ch === "." || ch === " " || ch === "") return "#1a1f28";
  let r = 0.3, g = 0.55, b = 0.35;   // default = color1
  if (ch === "1" || ch === "#") { r = p.color1R ?? 0.30; g = p.color1G ?? 0.55; b = p.color1B ?? 0.35; }
  else if (ch === "2")          { r = p.color2R ?? 0.42; g = p.color2G ?? 0.28; b = p.color2B ?? 0.18; }
  else if (ch === "3")          { r = p.color3R ?? 0.55; g = p.color3G ?? 0.55; b = p.color3B ?? 0.62; }
  else if (ch === "4")          { r = p.color4R ?? 0.96; g = p.color4G ?? 0.90; b = p.color4B ?? 0.78; }
  else if (ch === "5")          { r = p.color5R ?? 0.92; g = p.color5G ?? 0.25; b = p.color5B ?? 0.30; }
  return "#" +
    [r, g, b].map(c => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, "0")).join("");
}

function _tmeRenderPalette() {
  const wrap = document.getElementById("tme-palette");
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!wrap || !tme) return;
  wrap.innerHTML = tme.palette.map(({ ch, color }) => {
    const active = (ch === tme.brush);
    const label = _TME_BRUSH_LABELS[ch] || ch;
    const border = active ? "var(--phosphor)" : "var(--instr-rule)";
    return '<button class="tme-brush-btn" data-brush="' + escapeAttr(ch) +
      '" style="display:flex; align-items:center; gap:8px; padding:5px 8px; ' +
      'background:var(--bg-1); color:var(--text-1); border:2px solid ' + border + '; ' +
      'border-radius:3px; cursor:pointer; font-family:var(--font-mono); font-size:10.5px; text-align:left;">' +
      '<span style="display:inline-block; width:18px; height:18px; background:' + color +
      '; border:1px solid var(--instr-rule); border-radius:2px;"></span>' +
      '<span style="opacity:0.92;">' + escapeText(ch) + '</span>' +
      '<span style="opacity:0.6; font-size:9.5px;">' + escapeText(label) + '</span>' +
      '</button>';
  }).join("");
  // Wire click handlers
  wrap.querySelectorAll(".tme-brush-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tme2 = document.getElementById("tilemap-editor-modal")._tme;
      if (!tme2) return;
      tme2.brush = btn.dataset.brush;
      _tmeRenderPalette();
    });
  });
}

function _tmeRenderGrid() {
  const canvas = document.getElementById("tme-grid");
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!canvas || !tme) return;
  const node = state.nodes.find(n => n && n.id === tme.nodeId);
  const p = (node && node.params) || {};
  const cell = tme.cellPx;
  const W = tme.cols * cell;
  const H = tme.nRows * cell;
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  // Background: dark sky gradient so '.' cells read as background.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#1a2840"); grad.addColorStop(1, "#2a3850");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Render each cell
  for (let r = 0; r < tme.nRows; r++) {
    const row = tme.rows[r];
    for (let c = 0; c < tme.cols; c++) {
      const ch = row[c] || ".";
      if (ch === "." || ch === " " || ch === "") continue;   // background already drawn
      ctx.fillStyle = _tmeColorForChar(ch, p);
      ctx.fillRect(c * cell, r * cell, cell, cell);
    }
  }
  // Grid lines (subtle)
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = 0; r <= tme.nRows; r++) { ctx.moveTo(0, r * cell + 0.5); ctx.lineTo(W, r * cell + 0.5); }
  for (let c = 0; c <= tme.cols;  c++) { ctx.moveTo(c * cell + 0.5, 0); ctx.lineTo(c * cell + 0.5, H); }
  ctx.stroke();
  // Highlight every-10th gridline + center marker so the user has
  // a sense of position (col 39.5 = world x=0 for a 80-col map).
  ctx.strokeStyle = "rgba(150,180,210,0.18)";
  ctx.beginPath();
  for (let r = 0; r <= tme.nRows; r += 5) { ctx.moveTo(0, r * cell + 0.5); ctx.lineTo(W, r * cell + 0.5); }
  for (let c = 0; c <= tme.cols;  c += 5) { ctx.moveTo(c * cell + 0.5, 0); ctx.lineTo(c * cell + 0.5, H); }
  ctx.stroke();
}

function _tmePaintCell(col, row, eraseMode) {
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!tme) return;
  if (col < 0 || col >= tme.cols || row < 0 || row >= tme.nRows) return;
  const newCh = eraseMode ? "." : tme.brush;
  const line = tme.rows[row];
  if (line[col] === newCh) return;   // no-op
  tme.rows[row] = line.substring(0, col) + newCh + line.substring(col + 1);
  // Redraw just this cell for snappy paint feel.
  const canvas = document.getElementById("tme-grid");
  const ctx = canvas.getContext("2d");
  const cell = tme.cellPx;
  const node = state.nodes.find(n => n && n.id === tme.nodeId);
  const p = (node && node.params) || {};
  // Clear cell + repaint background sliver under it
  ctx.fillStyle = "#1f2e44";
  ctx.fillRect(col * cell, row * cell, cell, cell);
  if (newCh !== "." && newCh !== " ") {
    ctx.fillStyle = _tmeColorForChar(newCh, p);
    ctx.fillRect(col * cell, row * cell, cell, cell);
  }
  // Re-stroke the cell's borders so gridlines stay visible
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.strokeRect(col * cell + 0.5, row * cell + 0.5, cell - 1, cell - 1);
}

function _tmeResize(newCols, newRows) {
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!tme) return;
  newCols = Math.max(1, Math.min(200, newCols | 0));
  newRows = Math.max(1, Math.min(100, newRows | 0));
  // Truncate or pad each existing row to newCols
  const newRowArr = [];
  for (let r = 0; r < newRows; r++) {
    if (r < tme.rows.length) {
      const old = tme.rows[r];
      newRowArr.push(old.length >= newCols ? old.substring(0, newCols) : old.padEnd(newCols, "."));
    } else {
      newRowArr.push(".".repeat(newCols));
    }
  }
  tme.rows = newRowArr;
  tme.cols = newCols;
  tme.nRows = newRows;
  document.getElementById("tme-status").textContent =
    "Tilemap2D#" + tme.nodeId + " — " + newCols + " × " + newRows + " (resized)";
  _tmeRenderGrid();
}

function _tmeSave() {
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!tme) return;
  const node = state.nodes.find(n => n && n.id === tme.nodeId);
  if (!node) return;
  pushHistory("tilemap-painter:save:" + tme.nodeId);
  node.params = node.params || {};
  const newData = tme.rows.join("\n");
  const oldLen = (node.params.tileData || "").length;
  node.params.tileData = newData;
  console.log("[tilemap-painter] saved " + tme.cols + "×" + tme.nRows +
    " to " + tme.nodeId + ": " + oldLen + " -> " + newData.length + " chars" +
    (oldLen === newData.length ? " (size unchanged; mesh cache key still differs due to content)" : ""));
  // Belt-and-braces invalidation: the cacheKey check in _ensureMeshBuffers
  // SHOULD pick up the tileData mutation on the next frame, but make it
  // explicit so a stale cache can't possibly survive a save.
  if (typeof Visual !== "undefined" && Visual.meshBufferCache) {
    const cached = Visual.meshBufferCache.get(tme.nodeId);
    if (cached) {
      try { cached.vertexBuffer && cached.vertexBuffer.destroy(); } catch (_) {}
      try { cached.indexBuffer  && cached.indexBuffer.destroy();  } catch (_) {}
      Visual.meshBufferCache.delete(tme.nodeId);
      console.log("[tilemap-painter] mesh buffer cache cleared for " + tme.nodeId);
    }
  }
  // Also clear the tilemap's collision cache so PlatformerBody2D re-parses.
  node._collisionCacheKey = null;
  node._collisionCache    = null;
  // Anything downstream that depends on this mesh (TileSpriteOverlay,
  // PickupCollector, LevelGoal2D, TileSpriteOverlay overlays) reads the
  // tileData live, so they pick up the change on their next tick.
  _tmeClose();
  if (typeof render      === "function") render();
  if (typeof renderProps === "function") renderProps();
}

/* Wire up DOM event handlers once at startup. Click + drag paints
 * with the brush; right-click drags erase to '.'. */
function _tmeInstall() {
  const modal = document.getElementById("tilemap-editor-modal");
  if (!modal || modal._tmeWired) return;
  modal._tmeWired = true;
  const closeBtn  = document.getElementById("tme-close");
  const cancelBtn = document.getElementById("tme-cancel");
  const saveBtn   = document.getElementById("tme-save");
  const resizeBtn = document.getElementById("tme-resize");
  const canvas    = document.getElementById("tme-grid");
  if (closeBtn)  closeBtn.addEventListener("click", _tmeClose);
  if (cancelBtn) cancelBtn.addEventListener("click", _tmeClose);
  if (saveBtn)   saveBtn.addEventListener("click", _tmeSave);
  if (resizeBtn) resizeBtn.addEventListener("click", () => {
    const c = parseInt(document.getElementById("tme-cols").value, 10) || 1;
    const r = parseInt(document.getElementById("tme-rows").value, 10) || 1;
    _tmeResize(c, r);
  });
  if (canvas) {
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("pointerdown", e => {
      const tme = modal._tme; if (!tme) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      tme.painting = true;
      tme.eraseMode = (e.button === 2);
      const rect = canvas.getBoundingClientRect();
      const col = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width)  / tme.cellPx);
      const row = Math.floor((e.clientY - rect.top)  * (canvas.height / rect.height) / tme.cellPx);
      _tmePaintCell(col, row, tme.eraseMode);
    });
    canvas.addEventListener("pointermove", e => {
      const tme = modal._tme; if (!tme || !tme.painting) return;
      const rect = canvas.getBoundingClientRect();
      const col = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width)  / tme.cellPx);
      const row = Math.floor((e.clientY - rect.top)  * (canvas.height / rect.height) / tme.cellPx);
      _tmePaintCell(col, row, tme.eraseMode);
    });
    canvas.addEventListener("pointerup", e => {
      const tme = modal._tme; if (!tme) return;
      tme.painting = false;
      tme.eraseMode = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    });
  }
  // ESC closes
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display !== "none") _tmeClose();
  });
  // Backdrop click closes
  modal.addEventListener("click", (e) => {
    if (e.target === modal) _tmeClose();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", _tmeInstall);
}

/* ───────────────────────────────────────────────────────────────
 * Sprint Level2D Phase 1b -- layer-list modal for Level2D nodes.
 * Visual editor for the layers JSON: add/remove/reorder layers
 * and tweak per-layer fields (depthZ, parallaxX, texture URL,
 * tileData, etc.) without hand-editing JSON in the props pane.
 *
 * State held on the modal DOM element (modal._lvl):
 *   nodeId   -- the Level2D being edited
 *   layers[] -- working copy of params.layers (parsed JSON)
 *
 * Defaults for "+ Add" use sensible starting points so a freshly
 * added layer is immediately visible (e.g. a new parallax layer
 * defaults to the parallax-sky asset at depthZ=60). User tunes
 * from there. Save serializes back; Cancel discards working copy.
 * ─────────────────────────────────────────────────────────────── */

const _LVL_LAYER_DEFAULTS = {
  parallax: {
    type: "parallax", name: "parallax-bg",
    depthZ: 40,
    parallaxX: 0.15,
    texWorldWidth: 30,
    screenScaleY: 0.7,
    screenAnchorY: 0.5,
    worldOffsetY: 0,
    tintR: 1, tintG: 1, tintB: 1, tintA: 1,
    texture: "asset:parallax-sky",
    wrapMode: "repeat-x",
    filterMode: "linear"
  },
  tilemap: {
    type: "tilemap", name: "tilemap",
    depthZ: 0,
    collides: true,
    tileSize: 1,
    originX: 0, originY: 0,
    tileData: "................\n................\n................\n................\n................\n................\n11111111111111111\n22222222222222222",
    color1R: 0.30, color1G: 0.55, color1B: 0.35,
    color2R: 0.42, color2G: 0.28, color2B: 0.18,
    color3R: 0.55, color3G: 0.55, color3B: 0.62,
    color4R: 0.96, color4G: 0.90, color4B: 0.78,
    color5R: 0.92, color5G: 0.25, color5B: 0.30,
    skipRenderChars: "",
    // Phase 2 tileset path. Default to the shipped demo-tileset
    // so a fresh tilemap layer renders textured immediately. Set
    // tileset to "" to fall back to the vertex-color palette path.
    tileset: "asset:demo-tileset",
    tileMap: { "1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5, "7": 6, "8": 7 },
    tilesetFramesX: 4,
    tilesetFramesY: 2
  },
  scatter: {
    type: "scatter", name: "scatter",
    depthZ: -0.3,
    texture: "asset:grass-tuft",
    filterMode: "nearest",
    wrapMode: "clamp",
    positions: "-10,-3.5;-5,-3.5;0,-3.5;5,-3.5;10,-3.5",
    scale: 0.6,
    anchorX: 0.5, anchorY: 0,
    frame: 0, framesX: 1, framesY: 1,
    tintR: 1, tintG: 1, tintB: 1, tintA: 1
  }
};

function _lvlOpen(nodeId) {
  if (!state || !Array.isArray(state.nodes)) return;
  const node = state.nodes.find(n => n && n.id === nodeId);
  if (!node || node.type !== "Level2D") {
    console.warn("[level-editor] node not found or not Level2D: " + nodeId);
    return;
  }
  const modal = document.getElementById("level2d-editor-modal");
  if (!modal) return;
  // Parse current layers JSON. If malformed, log + start with empty.
  let layers = [];
  try {
    const raw = (node.params && typeof node.params.layers === "string") ? node.params.layers : "[]";
    layers = JSON.parse(raw);
    if (!Array.isArray(layers)) layers = [];
  } catch (e) {
    console.warn("[level-editor] layers JSON parse failed, starting empty: " + e.message);
    layers = [];
  }
  modal._lvl = {
    nodeId,
    // Deep clone so cancel discards changes.
    layers: JSON.parse(JSON.stringify(layers)),
    // Per-layer-idx painter state (active brush, painting flag).
    // Lives only while the modal is open; not persisted to the patch.
    paintState: {},
    // Per-layer-idx scatter canvas state (drag/hover, cached bitmap).
    scatterState: {},
    // Per-layer-idx ephemeral state. _prevTileSize is captured here
    // (not on layer itself) so it doesn't leak into the saved JSON.
    layerState: {}
  };
  // Seed _prevTileSize for tilemap layers so the first tileSize edit
  // can compare against the open-time value (Phase 3.1 auto-resize).
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l && l.type === "tilemap") {
      modal._lvl.layerState[i] = { _prevTileSize: (typeof l.tileSize === "number" && l.tileSize > 0) ? l.tileSize : 1 };
    }
  }
  document.getElementById("lvl-status").textContent =
    "Level2D#" + node.id + " — " + layers.length + " layer(s)";
  _lvlRenderList();
  modal.style.display = "flex";
}

function _lvlClose() {
  const modal = document.getElementById("level2d-editor-modal");
  if (modal) {
    modal.style.display = "none";
    modal._lvl = null;
  }
}

function _lvlAddLayer(type) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const template = _LVL_LAYER_DEFAULTS[type];
  if (!template) { console.warn("[level-editor] unknown layer type: " + type); return; }
  // Clone template + give a unique-ish name based on count.
  const clone = JSON.parse(JSON.stringify(template));
  const sameTypeCount = lvl.layers.filter(l => l && l.type === type).length;
  clone.name = type + (sameTypeCount > 0 ? "-" + (sameTypeCount + 1) : "");
  lvl.layers.push(clone);
  _lvlRenderList();
}

function _lvlMoveLayer(idx, dir) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const tgt = idx + dir;
  if (tgt < 0 || tgt >= lvl.layers.length) return;
  const tmp = lvl.layers[idx];
  lvl.layers[idx] = lvl.layers[tgt];
  lvl.layers[tgt] = tmp;
  _lvlRenderList();
}

function _lvlDeleteLayer(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  lvl.layers.splice(idx, 1);
  _lvlRenderList();
}

/* Mutate a single field on a layer + skip re-render (the input
 * already shows the new value; re-rendering would lose focus). */
function _lvlSetField(idx, field, value) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl || idx >= lvl.layers.length) return;
  lvl.layers[idx][field] = value;
  // Update layer count + name display in the status line.
  const layer = lvl.layers[idx];
  if (field === "name" || field === "depthZ") {
    _lvlUpdateCardHeader(idx);
  }
}

function _lvlUpdateCardHeader(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const headEl = document.getElementById("lvl-card-head-" + idx);
  if (headEl && layer) {
    headEl.textContent = (layer.name || "(unnamed)") + "  ·  " + layer.type + "  ·  z=" + (layer.depthZ ?? 0);
  }
}

function _lvlRenderList() {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  const wrap = document.getElementById("lvl-layers");
  const countEl = document.getElementById("lvl-layer-count");
  if (!wrap || !lvl) return;
  if (countEl) countEl.textContent = lvl.layers.length + " layer(s)";
  // Build all cards via innerHTML for speed, then wire handlers.
  wrap.innerHTML = lvl.layers.map((layer, idx) => _lvlRenderCard(layer, idx)).join("");
  // Wire reorder / delete / field-edit handlers on each card.
  for (let idx = 0; idx < lvl.layers.length; idx++) _lvlWireCard(idx);
  // Phase 2b: async-hydrate the tilemap painter for any tilemap
  // layer. Fire-and-forget; await happens inside the hydrate fn.
  for (let idx = 0; idx < lvl.layers.length; idx++) {
    const layer = lvl.layers[idx];
    if (layer && layer.type === "tilemap") {
      _lvlWireTilemapPainter(idx);
      _lvlHydrateTilemapPainter(idx);
    } else if (layer && layer.type === "scatter") {
      // Phase 3: scatter placement canvas.
      _lvlWireScatterCanvas(idx);
      _lvlHydrateScatterCanvas(idx);
    }
  }
}

function _lvlRenderCard(layer, idx) {
  const name = escapeText(layer.name || "(unnamed)");
  const type = layer.type || "?";
  const z = layer.depthZ ?? 0;
  // Color-code by type so the eye can scan the layer stack.
  const typeColor = type === "parallax" ? "#8aa3d0"
                  : type === "tilemap"  ? "#9bd0a0"
                  : type === "scatter"  ? "#d0a98a"
                  : "#888";
  let bodyHtml = "";
  if (type === "parallax") bodyHtml = _lvlRenderParallaxFields(layer, idx);
  else if (type === "tilemap") bodyHtml = _lvlRenderTilemapFields(layer, idx);
  else if (type === "scatter") bodyHtml = _lvlRenderScatterFields(layer, idx);
  else bodyHtml = '<div style="font-family:var(--font-mono); font-size:10px; color:#ff8060;">unknown layer type: ' + escapeText(type) + '</div>';
  return '' +
    '<div class="lvl-card" data-idx="' + idx + '" style="border:1px solid var(--instr-rule); border-radius:4px; background:var(--bg-1); padding:8px 10px;">' +
      '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">' +
        '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:' + typeColor + ';"></span>' +
        '<span id="lvl-card-head-' + idx + '" style="flex:1; font-family:var(--font-mono); font-size:11px; color:var(--text-1);">' + name + '  ·  ' + escapeText(type) + '  ·  z=' + z + '</span>' +
        '<button class="btn lvl-up"     data-idx="' + idx + '" title="Move up (drawn earlier / further back)">↑</button>' +
        '<button class="btn lvl-down"   data-idx="' + idx + '" title="Move down (drawn later / closer to camera)">↓</button>' +
        '<button class="btn lvl-delete" data-idx="' + idx + '" title="Remove this layer" style="color:#ff8060;">×</button>' +
      '</div>' +
      '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 12px;">' +
        '<div>' +
          '<div class="lvl-label">NAME</div>' +
          '<input class="lvl-name-in"  data-idx="' + idx + '" type="text"   value="' + escapeAttr(layer.name || "") + '" />' +
        '</div>' +
        '<div>' +
          '<div class="lvl-label">DEPTH-Z  (lower = nearer)</div>' +
          '<input class="lvl-z-in"     data-idx="' + idx + '" type="number" step="0.1" value="' + (layer.depthZ ?? 0) + '" />' +
        '</div>' +
      '</div>' +
      bodyHtml +
    '</div>';
}

function _lvlRenderParallaxFields(layer, idx) {
  return '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 12px; margin-top:6px;">' +
    '<div><div class="lvl-label">TEXTURE</div><input class="lvl-x-in"      data-idx="' + idx + '" data-field="texture"      type="text"   value="' + escapeAttr(layer.texture || "") + '" /></div>' +
    '<div><div class="lvl-label">PARALLAX-X  (0..1)</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="parallaxX" type="number" step="0.01" value="' + (layer.parallaxX ?? 0.15) + '" /></div>' +
    '<div><div class="lvl-label">TEX WORLD WIDTH</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="texWorldWidth" type="number" step="1" value="' + (layer.texWorldWidth ?? 30) + '" /></div>' +
    '<div><div class="lvl-label">SCREEN SCALE-Y</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="screenScaleY" type="number" step="0.05" value="' + (layer.screenScaleY ?? 1.0) + '" /></div>' +
    '<div><div class="lvl-label">SCREEN ANCHOR-Y</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="screenAnchorY" type="number" step="0.05" value="' + (layer.screenAnchorY ?? 0.5) + '" /></div>' +
    '<div><div class="lvl-label">WORLD OFFSET-Y</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="worldOffsetY" type="number" step="0.1" value="' + (layer.worldOffsetY ?? 0) + '" /></div>' +
    '<div><div class="lvl-label">FILTER</div>' +
      '<select class="lvl-x-in" data-idx="' + idx + '" data-field="filterMode">' +
        '<option value="nearest"' + (layer.filterMode === "nearest" ? " selected" : "") + '>nearest</option>' +
        '<option value="linear"'  + (layer.filterMode === "linear"  ? " selected" : "") + '>linear</option>' +
      '</select>' +
    '</div>' +
    '<div><div class="lvl-label">WRAP</div>' +
      '<select class="lvl-x-in" data-idx="' + idx + '" data-field="wrapMode">' +
        '<option value="clamp">clamp</option>' +
        '<option value="repeat"'   + (layer.wrapMode === "repeat"   ? " selected" : "") + '>repeat</option>' +
        '<option value="repeat-x"' + (layer.wrapMode === "repeat-x" ? " selected" : "") + '>repeat-x</option>' +
        '<option value="repeat-y"' + (layer.wrapMode === "repeat-y" ? " selected" : "") + '>repeat-y</option>' +
      '</select>' +
    '</div>' +
    '</div>';
}

function _lvlRenderTilemapFields(layer, idx) {
  const data = (layer.tileData || "");
  const rows = data.split("\n").length;
  const cols = data.split("\n").reduce((m, r) => Math.max(m, r.length), 0);
  const tileMapStr = (typeof layer.tileMap === "object" && layer.tileMap !== null)
    ? JSON.stringify(layer.tileMap)
    : (typeof layer.tileMap === "string" ? layer.tileMap : "");
  const tilesetEnabled = !!(layer.tileset && layer.tileset.length);
  // Phase 2b -- visual painter. Two canvases (palette + paint grid).
  // Hydrated asynchronously by _lvlHydrateTilemapPainter once the
  // tileset bitmap loads. Always emit the painter container so
  // toggling tileset on/off rebinds without a full card rerender;
  // hydrate writes a "set tileset" placeholder when empty.
  return '<div style="margin-top:6px;">' +
    '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 12px;">' +
      '<div><div class="lvl-label">TILE SIZE (world units)</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="tileSize" type="number" step="0.1" value="' + (layer.tileSize ?? 1) + '" /></div>' +
      '<div><div class="lvl-label">COLLIDES (Phase 5 actually enforces)</div>' +
        '<select class="lvl-x-in" data-idx="' + idx + '" data-field="collides">' +
          '<option value="true"'  + (layer.collides !== false ? " selected" : "") + '>yes</option>' +
          '<option value="false"' + (layer.collides === false ? " selected" : "") + '>no</option>' +
        '</select></div>' +
      '<div><div class="lvl-label">ORIGIN-X</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="originX" type="number" step="0.1" value="' + (layer.originX ?? 0) + '" /></div>' +
      '<div><div class="lvl-label">ORIGIN-Y</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="originY" type="number" step="0.1" value="' + (layer.originY ?? 0) + '" /></div>' +
      '<div><div class="lvl-label">SKIP RENDER CHARS</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="skipRenderChars" type="text" value="' + escapeAttr(layer.skipRenderChars || "") + '" /></div>' +
    '</div>' +
    '<div style="margin-top:8px; padding:8px; border:1px dashed var(--instr-rule); border-radius:3px; background:rgba(80,120,80,0.05);">' +
      '<div style="font-family:var(--font-mono); font-size:9.5px; color:' + (tilesetEnabled ? "#9bd0a0" : "var(--text-3)") + '; letter-spacing:0.06em; margin-bottom:6px;">TILESET  ·  textured rendering ' + (tilesetEnabled ? "ACTIVE" : "OFF (clear tileset URL = vertex-color squares)") + '</div>' +
      '<div style="display:grid; grid-template-columns: 2fr 1fr 1fr; gap:6px 12px;">' +
        '<div><div class="lvl-label">TILESET (asset URL)</div><input class="lvl-x-in lvl-tileset-in" data-idx="' + idx + '" data-field="tileset" type="text" placeholder="asset:demo-tileset" value="' + escapeAttr(layer.tileset || "") + '" /></div>' +
        '<div><div class="lvl-label">FRAMES-X</div><input class="lvl-x-in lvl-tileset-shape-in" data-idx="' + idx + '" data-field="tilesetFramesX" type="number" step="1" min="1" value="' + (layer.tilesetFramesX ?? 4) + '" /></div>' +
        '<div><div class="lvl-label">FRAMES-Y</div><input class="lvl-x-in lvl-tileset-shape-in" data-idx="' + idx + '" data-field="tilesetFramesY" type="number" step="1" min="1" value="' + (layer.tilesetFramesY ?? 2) + '" /></div>' +
      '</div>' +
    '</div>' +
    '<div id="lvl-painter-' + idx + '" style="margin-top:8px;">' +
      '<div style="display:flex; align-items:flex-start; gap:14px; flex-wrap:wrap;">' +
        '<div style="flex:0 0 auto;">' +
          '<div class="lvl-label">PALETTE  ·  click to pick brush  ·  green = active</div>' +
          '<canvas id="lvl-pal-' + idx + '" style="display:block; image-rendering:pixelated; cursor:pointer; background:#0e1218; border:1px solid var(--instr-rule); border-radius:2px;"></canvas>' +
          '<div id="lvl-brush-' + idx + '" style="margin-top:4px; font-family:var(--font-mono); font-size:9.5px; color:var(--text-3);">brush: —</div>' +
        '</div>' +
        '<div style="flex:1 1 auto; min-width:240px;">' +
          '<div class="lvl-label">CANVAS  ·  click/drag = paint  ·  right-click/drag = erase  ·  ' + cols + ' × ' + rows + '</div>' +
          '<div style="overflow:auto; max-width:100%; max-height:280px; background:#101820; border:1px solid var(--instr-rule); border-radius:2px;">' +
            '<canvas id="lvl-paint-' + idx + '" style="display:block; image-rendering:pixelated; cursor:crosshair;"></canvas>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<details style="margin-top:8px;">' +
      '<summary style="cursor:pointer; font-family:var(--font-mono); font-size:9.5px; color:var(--text-3); letter-spacing:0.05em;">RAW  ·  tileMap JSON + tileData (advanced)</summary>' +
      '<div style="margin-top:6px;">' +
        '<div class="lvl-label">TILE MAP  ·  JSON: char -> tile index (painter writes here; edit to fine-tune)</div>' +
        '<input class="lvl-x-in lvl-tilemap-in" data-idx="' + idx + '" data-field="tileMap" type="text" placeholder=\'{"1":0,"2":1,"3":2}\' value="' + escapeAttr(tileMapStr) + '" style="font-family:ui-monospace,monospace;" />' +
      '</div>' +
      '<div style="margin-top:6px;">' +
        '<div class="lvl-label">TILE DATA  ·  ' + cols + ' × ' + rows + '  (painter writes here; edit to bulk-paste or resize)</div>' +
        '<textarea class="lvl-x-in lvl-tiledata-in" data-idx="' + idx + '" data-field="tileData" spellcheck="false" wrap="off" style="width:100%; height:140px; padding:4px 6px; background:var(--bg-2); color:var(--text-1); border:1px solid var(--instr-rule); border-radius:2px; font-family:ui-monospace, monospace; font-size:10px; resize:vertical; white-space:pre;">' + escapeText(data) + '</textarea>' +
      '</div>' +
    '</details>' +
  '</div>';
}

function _lvlRenderScatterFields(layer, idx) {
  return '<div style="margin-top:6px;">' +
    '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 12px;">' +
      '<div><div class="lvl-label">TEXTURE</div><input class="lvl-x-in lvl-scatter-tex-in" data-idx="' + idx + '" data-field="texture" type="text"   value="' + escapeAttr(layer.texture || "") + '" /></div>' +
      '<div><div class="lvl-label">SCALE</div><input class="lvl-x-in lvl-scatter-cfg-in"   data-idx="' + idx + '" data-field="scale"   type="number" step="0.05" value="' + (layer.scale ?? 1) + '" /></div>' +
      '<div><div class="lvl-label">ANCHOR-X</div><input class="lvl-x-in lvl-scatter-cfg-in" data-idx="' + idx + '" data-field="anchorX" type="number" step="0.1" value="' + (layer.anchorX ?? 0.5) + '" /></div>' +
      '<div><div class="lvl-label">ANCHOR-Y (0=bottom-pin)</div><input class="lvl-x-in lvl-scatter-cfg-in" data-idx="' + idx + '" data-field="anchorY" type="number" step="0.1" value="' + (layer.anchorY ?? 0) + '" /></div>' +
      '<div><div class="lvl-label">FILTER</div>' +
        '<select class="lvl-x-in" data-idx="' + idx + '" data-field="filterMode">' +
          '<option value="nearest"' + (layer.filterMode !== "linear" ? " selected" : "") + '>nearest</option>' +
          '<option value="linear"'  + (layer.filterMode === "linear" ? " selected" : "") + '>linear</option>' +
        '</select></div>' +
      '<div><div class="lvl-label">FRAME</div><input class="lvl-x-in lvl-scatter-cfg-in" data-idx="' + idx + '" data-field="frame" type="number" step="1" value="' + (layer.frame ?? 0) + '" /></div>' +
    '</div>' +
    // Phase 3: world-space placement canvas. Sprite icons drawn at
    // each (x,y); click empty space to add, drag instance to move,
    // right-click to delete. Auto-fits bounds to existing instances.
    '<div id="lvl-scatter-mount-' + idx + '" style="margin-top:8px;">' +
      '<div class="lvl-label">CANVAS  ·  click empty = add sprite  ·  drag = move  ·  right-click = delete  ·  <span id="lvl-scatter-status-' + idx + '">0 instance(s)</span></div>' +
      '<div style="overflow:hidden; background:#101820; border:1px solid var(--instr-rule); border-radius:2px;">' +
        '<canvas id="lvl-scatter-' + idx + '" width="480" height="260" style="display:block; image-rendering:pixelated; cursor:crosshair; touch-action:none;"></canvas>' +
      '</div>' +
    '</div>' +
    '<details style="margin-top:8px;">' +
      '<summary style="cursor:pointer; font-family:var(--font-mono); font-size:9.5px; color:var(--text-3); letter-spacing:0.05em;">RAW  ·  positions string (advanced)</summary>' +
      '<div style="margin-top:6px;">' +
        '<div class="lvl-label">POSITIONS  ·  format: "x,y[,scale[,frame[,flipX]]]; ..."  (canvas writes here; edit to bulk-paste)</div>' +
        '<textarea class="lvl-x-in lvl-scatter-positions-in" data-idx="' + idx + '" data-field="positions" spellcheck="false" style="width:100%; height:80px; padding:4px 6px; background:var(--bg-2); color:var(--text-1); border:1px solid var(--instr-rule); border-radius:2px; font-family:ui-monospace, monospace; font-size:10px; resize:vertical;">' + escapeText(layer.positions || "") + '</textarea>' +
      '</div>' +
    '</details>' +
  '</div>';
}

function _lvlWireCard(idx) {
  const wrap = document.getElementById("lvl-layers");
  if (!wrap) return;
  const card = wrap.querySelector('.lvl-card[data-idx="' + idx + '"]');
  if (!card) return;
  card.querySelectorAll(".lvl-up").forEach(b => b.addEventListener("click", () => _lvlMoveLayer(idx, -1)));
  card.querySelectorAll(".lvl-down").forEach(b => b.addEventListener("click", () => _lvlMoveLayer(idx, +1)));
  card.querySelectorAll(".lvl-delete").forEach(b => b.addEventListener("click", () => {
    if (confirm("Delete layer '" + (document.getElementById("lvl-card-head-" + idx)?.textContent || idx) + "'?")) _lvlDeleteLayer(idx);
  }));
  // Name field
  card.querySelectorAll(".lvl-name-in").forEach(inp => {
    inp.addEventListener("input", () => _lvlSetField(idx, "name", inp.value));
  });
  // DepthZ field
  card.querySelectorAll(".lvl-z-in").forEach(inp => {
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) _lvlSetField(idx, "depthZ", v);
    });
  });
  // Phase 3.1 auto-resize: on tileSize blur, if value changed since
  // open/last-commit, nearest-neighbor rescale tileData so the world
  // extent (cols*ts × rows*ts) is preserved. tileSize=1 -> 0.1 grows
  // a 17x8 grid to 170x80 etc. Uses change event so we don't fire
  // mid-keystroke ("0.1" passes through "0" first).
  const modalLvl = (function () {
    const m = document.getElementById("level2d-editor-modal");
    return m && m._lvl;
  })();
  if (modalLvl && modalLvl.layers[idx] && modalLvl.layers[idx].type === "tilemap") {
    const tsInp = card.querySelector('input[data-field="tileSize"]');
    if (tsInp) {
      tsInp.addEventListener("change", () => {
        const newSize = parseFloat(tsInp.value);
        if (!Number.isFinite(newSize) || newSize <= 0) return;
        const layerState = (modalLvl.layerState && modalLvl.layerState[idx]) || null;
        const oldSize = layerState ? layerState._prevTileSize : newSize;
        if (Math.abs(newSize / oldSize - 1) < 1e-6) return;
        _lvlResizeTileDataForTileSize(idx, oldSize, newSize);
        if (layerState) layerState._prevTileSize = newSize;
      });
    }
  }
  // Generic field inputs (data-field on each input)
  card.querySelectorAll(".lvl-x-in").forEach(inp => {
    const field = inp.dataset.field;
    if (!field) return;
    const evt = (inp.tagName === "SELECT") ? "change" : "input";
    inp.addEventListener(evt, () => {
      let v = inp.value;
      // tileMap input holds a JSON object stringified; parse before
      // storing so the layer's tileMap stays an object (otherwise the
      // saved patch double-encodes it as a JSON-in-JSON string).
      if (inp.classList.contains("lvl-tilemap-in")) {
        try {
          const parsed = JSON.parse(v);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            v = parsed;
          } else {
            return;  // not an object, don't clobber the layer
          }
        } catch (_) {
          return;  // mid-edit JSON; wait for valid input
        }
      } else if (inp.type === "number") {
        const n = parseFloat(v);
        v = Number.isFinite(n) ? n : 0;
      } else if (v === "true")  v = true;
      else if (v === "false") v = false;
      _lvlSetField(idx, field, v);
      // Painter re-render hooks for tilemap fields that affect the
      // visual canvases. Cheap (~1-2ms each).
      let touchedTilemap = false;
      if (inp.classList.contains("lvl-tileset-in")) {
        _lvlHydrateTilemapPainter(idx);
        touchedTilemap = true;
      } else if (inp.classList.contains("lvl-tileset-shape-in")) {
        _lvlRenderTilesetPalette(idx);
        _lvlRenderTilemapPaint(idx);
        touchedTilemap = true;
      } else if (inp.classList.contains("lvl-tilemap-in")) {
        _lvlRenderTilesetPalette(idx);
        _lvlRenderTilemapPaint(idx);
        touchedTilemap = true;
      } else if (inp.classList.contains("lvl-tiledata-in")) {
        _lvlRenderTilemapPaint(idx);
        touchedTilemap = true;
      } else if (inp.classList.contains("lvl-scatter-tex-in")) {
        _lvlHydrateScatterCanvas(idx);
      } else if (inp.classList.contains("lvl-scatter-cfg-in")) {
        _lvlRenderScatterCanvas(idx);
      } else if (inp.classList.contains("lvl-scatter-positions-in")) {
        _lvlRenderScatterCanvas(idx);
      }
      // Phase 3.2: tilemap changes invalidate scatter backdrops in
      // the same Level2D. Refresh them so the user sees the latest
      // terrain while placing sprites.
      if (touchedTilemap && modalLvl && Array.isArray(modalLvl.layers)) {
        for (let li = 0; li < modalLvl.layers.length; li++) {
          if (modalLvl.layers[li] && modalLvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
        }
      }
    });
  });
}

function _lvlSave() {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const node = state.nodes.find(n => n && n.id === lvl.nodeId);
  if (!node) return;
  pushHistory("level-editor:save:" + lvl.nodeId);
  node.params = node.params || {};
  node.params.layers = JSON.stringify(lvl.layers, null, 2);
  console.log("[level-editor] saved " + lvl.layers.length + " layers to " + lvl.nodeId);
  // Bust Visual.meshBufferCache for any layer-synthetic ID derived
  // from this Level2D, so the next render rebuilds them all.
  if (typeof Visual !== "undefined" && Visual.meshBufferCache) {
    const prefix = lvl.nodeId + ":lyr";
    const toDelete = [];
    for (const key of Visual.meshBufferCache.keys()) {
      if (key.indexOf && key.indexOf(prefix) === 0) toDelete.push(key);
    }
    for (const k of toDelete) {
      try {
        const c = Visual.meshBufferCache.get(k);
        if (c) {
          try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
          try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
        }
      } catch (_) {}
      Visual.meshBufferCache.delete(k);
    }
    if (toDelete.length) console.log("[level-editor] cleared " + toDelete.length + " synthetic-layer mesh cache entries");
  }
  _lvlClose();
  if (typeof render      === "function") render();
  if (typeof renderProps === "function") renderProps();
}

/* ── Phase 2b: per-tilemap-layer visual painter ──────────────────
 *
 * Two canvases per tilemap layer card:
 *   lvl-pal-IDX   -- the tileset sprite-sheet drawn as a grid.
 *                    Click a tile to pick it as the active brush.
 *                    If the tile isn't yet in tileMap, a free char
 *                    (1..9, a..z, A..Z) is auto-allocated.
 *   lvl-paint-IDX -- the level cells, drawn with the bitmap for any
 *                    char that's in tileMap, vertex-color palette
 *                    for any char that isn't. Click+drag paints
 *                    with active brush; right-click drags erase to '.'.
 *
 * Both canvases live inline in the card (no second modal). The raw
 * tileData textarea + tileMap JSON input are still present in a
 * <details> disclosure for bulk edit / paste.
 *
 * Bitmap loading is async (createImageBitmap from the asset blob);
 * results are cached in _LVL_TILESET_BITMAP_CACHE so re-opening the
 * modal or hydrating multiple layers with the same tileset is fast.
 * ──────────────────────────────────────────────────────────────── */

const _LVL_TILESET_BITMAP_CACHE = new Map();  // url -> Promise<ImageBitmap|null>
const _LVL_TILESET_BITMAP_SYNC  = new Map();  // url -> ImageBitmap|null (after resolve, for sync render paths)

/* Chars to auto-allocate when the user clicks a palette tile that
 * isn't yet bound to any char in tileMap. Skips '.' and ' ' (used
 * as "empty"), and starts at '1' so the default {"1":0,...} pattern
 * stays natural. */
const _LVL_BRUSH_ALLOC_CHARS = "123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function _lvlLoadTilesetBitmap(url) {
  if (!url) return Promise.resolve(null);
  if (_LVL_TILESET_BITMAP_CACHE.has(url)) return _LVL_TILESET_BITMAP_CACHE.get(url);
  const p = (async () => {
    try {
      let bmp = null;
      if (url.indexOf("asset:") === 0) {
        const name = url.substring("asset:".length);
        const rec = (typeof Assets !== "undefined" && Assets.findSpriteByName)
          ? Assets.findSpriteByName(name) : null;
        if (!rec || !rec.blob) {
          _LVL_TILESET_BITMAP_SYNC.set(url, null);
          return null;
        }
        bmp = await createImageBitmap(rec.blob);
      } else {
        const res = await fetch(url);
        if (!res.ok) { _LVL_TILESET_BITMAP_SYNC.set(url, null); return null; }
        const blob = await res.blob();
        bmp = await createImageBitmap(blob);
      }
      _LVL_TILESET_BITMAP_SYNC.set(url, bmp);
      return bmp;
    } catch (e) {
      console.warn("[level-editor] tileset bitmap load failed for " + url + ": " + e.message);
      _LVL_TILESET_BITMAP_SYNC.set(url, null);
      return null;
    }
  })();
  _LVL_TILESET_BITMAP_CACHE.set(url, p);
  return p;
}

/* Sync accessor for render paths that can't await. Returns the
 * ImageBitmap once the loader's Promise has resolved, null before. */
function _lvlGetTilesetBitmapSync(url) {
  if (!url) return null;
  return _LVL_TILESET_BITMAP_SYNC.get(url) || null;
}

/* Phase 3.1 -- nearest-neighbor rescale of a tilemap layer's tileData
 * when its tileSize changes, preserving world extent (cols*ts × rows*ts).
 * Skips the resize if the result would exceed 1024 in either dimension
 * (a hard cap so a typo like ts=0.001 doesn't churn a million cells). */
function _lvlResizeTileDataForTileSize(idx, oldSize, newSize) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer) return;
  if (!Number.isFinite(oldSize) || oldSize <= 0) return;
  if (!Number.isFinite(newSize) || newSize <= 0) return;
  const factor = oldSize / newSize;
  if (Math.abs(factor - 1) < 1e-6) return;
  const lines = (layer.tileData || "").split("\n");
  const oldRows = Math.max(1, lines.length);
  const oldCols = Math.max(1, lines.reduce((m, r) => Math.max(m, r.length), 1));
  const newRows = Math.max(1, Math.round(oldRows * factor));
  const newCols = Math.max(1, Math.round(oldCols * factor));
  const MAX_DIM = 1024;
  if (newRows > MAX_DIM || newCols > MAX_DIM) {
    console.warn("[level-editor] tileSize " + oldSize + " -> " + newSize +
      " would resize " + oldCols + "x" + oldRows + " -> " + newCols + "x" + newRows +
      " (exceeds " + MAX_DIM + " cap); accepting size change without grid resize");
    _lvlRenderTilemapPaint(idx);
    return;
  }
  const newLines = new Array(newRows);
  for (let r = 0; r < newRows; r++) {
    const srcR = Math.min(oldRows - 1, Math.floor(r / factor));
    const srcLine = lines[srcR] || "";
    let outLine = "";
    for (let c = 0; c < newCols; c++) {
      const srcC = Math.min(oldCols - 1, Math.floor(c / factor));
      outLine += srcLine[srcC] || ".";
    }
    newLines[r] = outLine;
  }
  layer.tileData = newLines.join("\n");
  // Reflect into the RAW textarea (if mounted).
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  _lvlRenderTilemapPaint(idx);
  // Phase 3.2 -- if there's a scatter layer in this Level2D the
  // backdrop just got bigger/smaller; re-render those canvases too.
  for (let li = 0; li < lvl.layers.length; li++) {
    if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
  }
  console.log("[level-editor] tileSize " + oldSize + " -> " + newSize +
    ": resized " + oldCols + "x" + oldRows + " -> " + newCols + "x" + newRows +
    " (factor " + factor.toFixed(3) + ")");
}

function _lvlGetLayerPaintState(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return null;
  lvl.paintState = lvl.paintState || {};
  if (!lvl.paintState[idx]) {
    lvl.paintState[idx] = {
      activeTileIdx: 0,
      activeBrush: null,
      bitmap: null,
      tilesetURL: "",
      painting: false,
      eraseMode: false,
      paintCellPx: 14,
      paletteCellPx: 32,
      // Phase 5b -- undo/redo stacks of pre-stroke tileData snapshots.
      // Per-modal-session only; cleared when modal closes.
      undoStack: [],
      redoStack: [],
      // Phase 5b -- Shift+drag rectangle-fill state. While rectMode is
      // true, pointermove updates the rect preview overlay instead of
      // painting; pointerup commits all cells in the rect.
      rectMode: false,
      rectStartCol: 0, rectStartRow: 0,
      rectCurCol: 0,   rectCurRow: 0,
      rectEraseMode: false
    };
  }
  return lvl.paintState[idx];
}

/* Phase 5b -- snapshot the layer's tileData onto the undo stack
 * before mutating. Called once per stroke (pointerdown). The redo
 * stack is cleared because new edits invalidate any pending redo.
 * Cap at 64 snapshots so a long session doesn't grow unbounded. */
function _lvlBeginPaintStroke(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer || layer.type !== "tilemap") return;
  const ps = _lvlGetLayerPaintState(idx);
  ps.undoStack.push(layer.tileData || "");
  if (ps.undoStack.length > 64) ps.undoStack.shift();
  ps.redoStack.length = 0;
  lvl.lastPaintedLayerIdx = idx;
}

function _lvlUndoLastStroke() {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return false;
  const idx = (typeof lvl.lastPaintedLayerIdx === "number") ? lvl.lastPaintedLayerIdx : -1;
  if (idx < 0) return false;
  const layer = lvl.layers[idx];
  const ps = lvl.paintState && lvl.paintState[idx];
  if (!layer || !ps || !ps.undoStack || ps.undoStack.length === 0) return false;
  const prev = ps.undoStack.pop();
  ps.redoStack.push(layer.tileData || "");
  layer.tileData = prev;
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  _lvlRenderTilemapPaint(idx);
  // Repaint any scatter backdrops (terrain changed).
  if (Array.isArray(lvl.layers)) {
    for (let li = 0; li < lvl.layers.length; li++) {
      if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
    }
  }
  return true;
}

function _lvlRedoLastStroke() {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return false;
  const idx = (typeof lvl.lastPaintedLayerIdx === "number") ? lvl.lastPaintedLayerIdx : -1;
  if (idx < 0) return false;
  const layer = lvl.layers[idx];
  const ps = lvl.paintState && lvl.paintState[idx];
  if (!layer || !ps || !ps.redoStack || ps.redoStack.length === 0) return false;
  const next = ps.redoStack.pop();
  ps.undoStack.push(layer.tileData || "");
  if (ps.undoStack.length > 64) ps.undoStack.shift();
  layer.tileData = next;
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  _lvlRenderTilemapPaint(idx);
  if (Array.isArray(lvl.layers)) {
    for (let li = 0; li < lvl.layers.length; li++) {
      if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
    }
  }
  return true;
}

/* Phase 5b -- commit a rect-fill / rect-erase from rectStart to rectCur.
 * Single undo entry (push once before the bulk write, not per-cell). */
function _lvlCommitRectFill(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  if (!layer || !ps || !ps.rectMode) return;
  const c0 = Math.min(ps.rectStartCol, ps.rectCurCol);
  const c1 = Math.max(ps.rectStartCol, ps.rectCurCol);
  const r0 = Math.min(ps.rectStartRow, ps.rectCurRow);
  const r1 = Math.max(ps.rectStartRow, ps.rectCurRow);
  const newCh = ps.rectEraseMode ? "." : (ps.activeBrush || ".");
  const lines = (layer.tileData || "").split("\n");
  // Pre-stroke snapshot (already pushed by pointerdown via
  // _lvlBeginPaintStroke); just mutate.
  let touched = 0;
  for (let r = r0; r <= r1; r++) {
    if (r < 0) continue;
    while (r >= lines.length) lines.push("");
    let line = lines[r] || "";
    if (c1 >= line.length) line = line.padEnd(c1 + 1, ".");
    let mutated = "";
    let prev = 0;
    for (let c = Math.max(0, c0); c <= c1; c++) {
      if (line[c] !== newCh) {
        mutated += line.substring(prev, c) + newCh;
        prev = c + 1;
        touched++;
      }
    }
    mutated += line.substring(prev);
    lines[r] = mutated;
  }
  if (touched === 0) {
    // No-op: revert the snapshot we pushed in pointerdown so undo
    // doesn't accumulate empty entries.
    ps.undoStack.pop();
    return;
  }
  layer.tileData = lines.join("\n");
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  _lvlRenderTilemapPaint(idx);
  for (let li = 0; li < lvl.layers.length; li++) {
    if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
  }
}

function _lvlFreeBrushChar(tileMap) {
  const used = new Set(Object.keys(tileMap || {}));
  for (const c of _LVL_BRUSH_ALLOC_CHARS) {
    if (!used.has(c)) return c;
  }
  return null;
}

async function _lvlHydrateTilemapPainter(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer || layer.type !== "tilemap") return;
  const palCanvas   = document.getElementById("lvl-pal-"   + idx);
  const paintCanvas = document.getElementById("lvl-paint-" + idx);
  if (!palCanvas || !paintCanvas) return;
  const ps = _lvlGetLayerPaintState(idx);
  // No tileset -> draw a placeholder, render paint canvas using the
  // vertex-color fallback only.
  if (!layer.tileset || !layer.tileset.length) {
    ps.bitmap = null;
    ps.tilesetURL = "";
    palCanvas.width = 160;
    palCanvas.height = 40;
    const pctx = palCanvas.getContext("2d");
    pctx.fillStyle = "#1a1f28";
    pctx.fillRect(0, 0, palCanvas.width, palCanvas.height);
    pctx.fillStyle = "#888";
    pctx.font = "10px ui-monospace, monospace";
    pctx.fillText("(no tileset)", 10, 24);
    _lvlRenderTilemapPaint(idx);
    _lvlUpdateBrushReadout(idx);
    return;
  }
  const bmp = await _lvlLoadTilesetBitmap(layer.tileset);
  // Modal may have closed during the await; bail if so.
  if (!document.getElementById("lvl-pal-" + idx)) return;
  if (!bmp) {
    palCanvas.width = 200;
    palCanvas.height = 40;
    const pctx = palCanvas.getContext("2d");
    pctx.fillStyle = "#3a2424";
    pctx.fillRect(0, 0, palCanvas.width, palCanvas.height);
    pctx.fillStyle = "#ff8060";
    pctx.font = "11px ui-monospace, monospace";
    pctx.fillText("tileset load failed", 6, 24);
    return;
  }
  ps.bitmap = bmp;
  ps.tilesetURL = layer.tileset;
  _lvlRenderTilesetPalette(idx);
  _lvlRenderTilemapPaint(idx);
  _lvlUpdateBrushReadout(idx);
}

function _lvlRenderTilesetPalette(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  const canvas = document.getElementById("lvl-pal-" + idx);
  if (!canvas || !ps || !ps.bitmap || !layer) return;
  const framesX = Math.max(1, (layer.tilesetFramesX | 0) || 4);
  const framesY = Math.max(1, (layer.tilesetFramesY | 0) || 2);
  const cell = ps.paletteCellPx;
  const W = framesX * cell;
  const H = framesY * cell;
  if (canvas.width  !== W) canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#0e1218";
  ctx.fillRect(0, 0, W, H);
  const tileW = ps.bitmap.width  / framesX;
  const tileH = ps.bitmap.height / framesY;
  const tileMap = (layer.tileMap && typeof layer.tileMap === "object") ? layer.tileMap : {};
  for (let row = 0; row < framesY; row++) {
    for (let col = 0; col < framesX; col++) {
      const tileIdx = row * framesX + col;
      ctx.drawImage(ps.bitmap,
        col * tileW, row * tileH, tileW, tileH,
        col * cell,  row * cell,  cell,  cell);
      // Label with the char(s) currently mapped to this index.
      const mapped = [];
      for (const k of Object.keys(tileMap)) if ((tileMap[k] | 0) === tileIdx) mapped.push(k);
      if (mapped.length) {
        const text = mapped.join("");
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(col * cell, row * cell + cell - 12, cell, 12);
        ctx.fillStyle = "#cfe9ff";
        ctx.font = "9px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, col * cell + cell / 2, row * cell + cell - 6);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.strokeRect(col * cell + 0.5, row * cell + 0.5, cell - 1, cell - 1);
    }
  }
  // Highlight active tile.
  if (ps.activeTileIdx != null && ps.activeTileIdx >= 0 && ps.activeTileIdx < framesX * framesY) {
    const ar = Math.floor(ps.activeTileIdx / framesX);
    const ac = ps.activeTileIdx % framesX;
    ctx.strokeStyle = "#67ff80";
    ctx.lineWidth = 2;
    ctx.strokeRect(ac * cell + 1, ar * cell + 1, cell - 2, cell - 2);
  }
}

function _lvlRenderTilemapPaint(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  const canvas = document.getElementById("lvl-paint-" + idx);
  if (!canvas || !ps || !layer) return;
  const lines = (layer.tileData || "").split("\n");
  const nRows = Math.max(1, lines.length);
  const nCols = Math.max(1, lines.reduce((m, r) => Math.max(m, r.length), 1));
  const cell = ps.paintCellPx;
  const W = nCols * cell;
  const H = nRows * cell;
  if (canvas.width  !== W) canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#1a2840";
  ctx.fillRect(0, 0, W, H);
  const tileMap = (layer.tileMap && typeof layer.tileMap === "object") ? layer.tileMap : {};
  const framesX = Math.max(1, (layer.tilesetFramesX | 0) || 4);
  const framesY = Math.max(1, (layer.tilesetFramesY | 0) || 2);
  const bmp = ps.bitmap;
  const tileW = bmp ? bmp.width  / framesX : 0;
  const tileH = bmp ? bmp.height / framesY : 0;
  // Color palette for vertex-color fallback (chars not in tileMap).
  const p = {
    color1R: layer.color1R, color1G: layer.color1G, color1B: layer.color1B,
    color2R: layer.color2R, color2G: layer.color2G, color2B: layer.color2B,
    color3R: layer.color3R, color3G: layer.color3G, color3B: layer.color3B,
    color4R: layer.color4R, color4G: layer.color4G, color4B: layer.color4B,
    color5R: layer.color5R, color5G: layer.color5G, color5B: layer.color5B
  };
  for (let r = 0; r < nRows; r++) {
    const line = lines[r] || "";
    for (let c = 0; c < nCols; c++) {
      const ch = line[c] || ".";
      if (ch === "." || ch === " ") continue;
      if (bmp && Object.prototype.hasOwnProperty.call(tileMap, ch)) {
        const tIdx = tileMap[ch] | 0;
        if (tIdx >= 0 && tIdx < framesX * framesY) {
          const trow = Math.floor(tIdx / framesX);
          const tcol = tIdx % framesX;
          ctx.drawImage(bmp,
            tcol * tileW, trow * tileH, tileW, tileH,
            c * cell, r * cell, cell, cell);
          continue;
        }
      }
      ctx.fillStyle = _tmeColorForChar(ch, p);
      ctx.fillRect(c * cell, r * cell, cell, cell);
    }
  }
  // Gridlines.
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = 0; r <= nRows; r++) { ctx.moveTo(0, r * cell + 0.5); ctx.lineTo(W, r * cell + 0.5); }
  for (let c = 0; c <= nCols; c++) { ctx.moveTo(c * cell + 0.5, 0); ctx.lineTo(c * cell + 0.5, H); }
  ctx.stroke();
  // Stronger every-5th for orientation.
  ctx.strokeStyle = "rgba(150,180,210,0.18)";
  ctx.beginPath();
  for (let r = 0; r <= nRows; r += 5) { ctx.moveTo(0, r * cell + 0.5); ctx.lineTo(W, r * cell + 0.5); }
  for (let c = 0; c <= nCols; c += 5) { ctx.moveTo(c * cell + 0.5, 0); ctx.lineTo(c * cell + 0.5, H); }
  ctx.stroke();
  // Phase 5b -- rect-fill preview overlay (active during Shift+drag).
  if (ps.rectMode) {
    const rc0 = Math.min(ps.rectStartCol, ps.rectCurCol);
    const rc1 = Math.max(ps.rectStartCol, ps.rectCurCol);
    const rr0 = Math.min(ps.rectStartRow, ps.rectCurRow);
    const rr1 = Math.max(ps.rectStartRow, ps.rectCurRow);
    ctx.save();
    ctx.fillStyle = ps.rectEraseMode ? "rgba(255,140,80,0.22)" : "rgba(100,255,140,0.22)";
    ctx.fillRect(rc0 * cell, rr0 * cell, (rc1 - rc0 + 1) * cell, (rr1 - rr0 + 1) * cell);
    ctx.strokeStyle = ps.rectEraseMode ? "#ff8c50" : "#67ff80";
    ctx.lineWidth = 2;
    ctx.strokeRect(rc0 * cell + 1, rr0 * cell + 1, (rc1 - rc0 + 1) * cell - 2, (rr1 - rr0 + 1) * cell - 2);
    ctx.restore();
  }
}

/* Phase 3.2 -- draw a tilemap layer into the scatter canvas using
 * the scatter's world->screen projection. Used as a faded backdrop
 * so the user can place scatter sprites onto the visible terrain.
 * Mirrors _buildTilemap2D's world-position math: row 0 at +Y, cells
 * centered on (c-cx)*ts + ox, (cy-r)*ts + oy with ts=tileSize. */
function _lvlDrawTilemapBackdrop(ctx, layer, proj) {
  const lines = (layer.tileData || "").split("\n");
  const rows = lines.length;
  if (rows === 0) return;
  const cols = lines.reduce((m, r) => Math.max(m, r.length), 0);
  if (cols === 0) return;
  const ts = (typeof layer.tileSize === "number" && layer.tileSize > 0) ? layer.tileSize : 1;
  const ox = (typeof layer.originX === "number") ? layer.originX : 0;
  const oy = (typeof layer.originY === "number") ? layer.originY : 0;
  const cx = (cols - 1) * 0.5;
  const cy = (rows - 1) * 0.5;
  let bmp = null, framesX = 1, framesY = 1, tileMap = null;
  if (layer.tileset && layer.tileset.length) {
    bmp = _lvlGetTilesetBitmapSync(layer.tileset);
    framesX = Math.max(1, (layer.tilesetFramesX | 0) || 4);
    framesY = Math.max(1, (layer.tilesetFramesY | 0) || 2);
    if (layer.tileMap && typeof layer.tileMap === "object" && !Array.isArray(layer.tileMap)) {
      tileMap = layer.tileMap;
    } else if (typeof layer.tileMap === "string" && layer.tileMap.length) {
      try { tileMap = JSON.parse(layer.tileMap); } catch (_) { tileMap = null; }
    }
  }
  const palette = {
    color1R: layer.color1R, color1G: layer.color1G, color1B: layer.color1B,
    color2R: layer.color2R, color2G: layer.color2G, color2B: layer.color2B,
    color3R: layer.color3R, color3G: layer.color3G, color3B: layer.color3B,
    color4R: layer.color4R, color4G: layer.color4G, color4B: layer.color4B,
    color5R: layer.color5R, color5G: layer.color5G, color5B: layer.color5B
  };
  const tileW = bmp ? bmp.width  / framesX : 0;
  const tileH = bmp ? bmp.height / framesY : 0;
  for (let r = 0; r < rows; r++) {
    const line = lines[r] || "";
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "." || ch === " ") continue;
      const wx = (c  - cx) * ts + ox;
      const wy = (cy - r ) * ts + oy;
      const wx0 = wx - ts * 0.5, wx1 = wx + ts * 0.5;
      const wy0 = wy - ts * 0.5, wy1 = wy + ts * 0.5;
      const a = proj.wToS(wx0, wy1);
      const b = proj.wToS(wx1, wy0);
      const sx0 = Math.min(a.sx, b.sx);
      const sy0 = Math.min(a.sy, b.sy);
      const ww  = Math.abs(b.sx - a.sx);
      const hh  = Math.abs(b.sy - a.sy);
      // Cull cells fully outside the canvas (cheap; matters when
      // tileSize is tiny and the grid is huge).
      if (sx0 + ww < 0 || sy0 + hh < 0 || sx0 > proj.W || sy0 > proj.H) continue;
      if (bmp && tileMap && Object.prototype.hasOwnProperty.call(tileMap, ch)) {
        const tIdx = tileMap[ch] | 0;
        if (tIdx >= 0 && tIdx < framesX * framesY) {
          const trow = Math.floor(tIdx / framesX);
          const tcol = tIdx % framesX;
          ctx.drawImage(bmp, tcol * tileW, trow * tileH, tileW, tileH, sx0, sy0, ww, hh);
          continue;
        }
      }
      ctx.fillStyle = _tmeColorForChar(ch, palette);
      ctx.fillRect(sx0, sy0, ww, hh);
    }
  }
}

function _lvlUpdateBrushReadout(idx) {
  const ps = _lvlGetLayerPaintState(idx);
  const el = document.getElementById("lvl-brush-" + idx);
  if (!ps || !el) return;
  if (ps.activeBrush) {
    el.textContent = "brush: '" + ps.activeBrush + "' → tile " + ps.activeTileIdx;
    el.style.color = "#67ff80";
  } else {
    el.textContent = "brush: — (click a palette tile)";
    el.style.color = "var(--text-3)";
  }
}

function _lvlPickPaletteTile(idx, tileIdx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  if (!layer || !ps) return;
  ps.activeTileIdx = tileIdx;
  if (!layer.tileMap || typeof layer.tileMap !== "object" || Array.isArray(layer.tileMap)) {
    layer.tileMap = {};
  }
  // Find existing char mapped to this tile, else allocate one.
  let brush = null;
  for (const k of Object.keys(layer.tileMap)) {
    if ((layer.tileMap[k] | 0) === tileIdx) { brush = k; break; }
  }
  if (!brush) {
    brush = _lvlFreeBrushChar(layer.tileMap);
    if (brush) {
      layer.tileMap[brush] = tileIdx;
      // Reflect into the raw tileMap JSON input (if mounted).
      const inp = document.querySelector('.lvl-tilemap-in[data-idx="' + idx + '"]');
      if (inp) inp.value = JSON.stringify(layer.tileMap);
    }
  }
  ps.activeBrush = brush;
  _lvlRenderTilesetPalette(idx);
  _lvlUpdateBrushReadout(idx);
}

function _lvlPaintCell(idx, col, row, eraseMode) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  if (!layer || !ps) return;
  if (col < 0 || row < 0) return;
  const lines = (layer.tileData || "").split("\n");
  if (row >= lines.length) return;
  let line = lines[row];
  if (col >= line.length) line = line.padEnd(col + 1, ".");
  const newCh = eraseMode ? "." : (ps.activeBrush || ".");
  if (line[col] === newCh) return;
  lines[row] = line.substring(0, col) + newCh + line.substring(col + 1);
  layer.tileData = lines.join("\n");
  // Reflect into raw textarea (if mounted in the <details> disclosure).
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  // Re-render the paint canvas. ~1-2ms for typical sizes; cheap.
  _lvlRenderTilemapPaint(idx);
}

function _lvlWireTilemapPainter(idx) {
  const palCanvas   = document.getElementById("lvl-pal-"   + idx);
  const paintCanvas = document.getElementById("lvl-paint-" + idx);
  if (palCanvas && !palCanvas._lvlWired) {
    palCanvas._lvlWired = true;
    palCanvas.addEventListener("click", (e) => {
      const modal = document.getElementById("level2d-editor-modal");
      const lvl = modal && modal._lvl;
      if (!lvl) return;
      const layer = lvl.layers[idx];
      const ps = _lvlGetLayerPaintState(idx);
      if (!layer || !ps || !ps.bitmap) return;
      const framesX = Math.max(1, (layer.tilesetFramesX | 0) || 4);
      const framesY = Math.max(1, (layer.tilesetFramesY | 0) || 2);
      const cell = ps.paletteCellPx;
      const rect = palCanvas.getBoundingClientRect();
      const c = Math.floor((e.clientX - rect.left) * (palCanvas.width  / rect.width)  / cell);
      const r = Math.floor((e.clientY - rect.top)  * (palCanvas.height / rect.height) / cell);
      if (c < 0 || c >= framesX || r < 0 || r >= framesY) return;
      _lvlPickPaletteTile(idx, r * framesX + c);
    });
  }
  if (paintCanvas && !paintCanvas._lvlWired) {
    paintCanvas._lvlWired = true;
    paintCanvas.addEventListener("contextmenu", e => e.preventDefault());
    const _coords = (e) => {
      const rect = paintCanvas.getBoundingClientRect();
      const ps = _lvlGetLayerPaintState(idx);
      return {
        col: Math.floor((e.clientX - rect.left) * (paintCanvas.width  / rect.width)  / ps.paintCellPx),
        row: Math.floor((e.clientY - rect.top)  * (paintCanvas.height / rect.height) / ps.paintCellPx)
      };
    };
    paintCanvas.addEventListener("pointerdown", e => {
      const ps = _lvlGetLayerPaintState(idx); if (!ps) return;
      e.preventDefault();
      try { paintCanvas.setPointerCapture(e.pointerId); } catch (_) {}
      const { col, row } = _coords(e);
      const erase = (e.button === 2);
      _lvlBeginPaintStroke(idx);
      if (e.shiftKey) {
        // Phase 5b -- start rect-fill / rect-erase. pointermove
        // updates the preview; pointerup commits the bulk write.
        ps.rectMode      = true;
        ps.rectStartCol  = col;   ps.rectStartRow = row;
        ps.rectCurCol    = col;   ps.rectCurRow   = row;
        ps.rectEraseMode = erase;
        ps.painting      = false;
        _lvlRenderTilemapPaint(idx);
      } else {
        ps.rectMode  = false;
        ps.painting  = true;
        ps.eraseMode = erase;
        _lvlPaintCell(idx, col, row, ps.eraseMode);
      }
    });
    paintCanvas.addEventListener("pointermove", e => {
      const ps = _lvlGetLayerPaintState(idx); if (!ps) return;
      const { col, row } = _coords(e);
      if (ps.rectMode) {
        if (col === ps.rectCurCol && row === ps.rectCurRow) return;
        ps.rectCurCol = col;
        ps.rectCurRow = row;
        _lvlRenderTilemapPaint(idx);
        return;
      }
      if (!ps.painting) return;
      _lvlPaintCell(idx, col, row, ps.eraseMode);
    });
    const _endPaint = (e) => {
      const ps = _lvlGetLayerPaintState(idx); if (!ps) return;
      const wasPainting = ps.painting || ps.rectMode;
      if (ps.rectMode) {
        _lvlCommitRectFill(idx);
        ps.rectMode = false;
        ps.rectEraseMode = false;
        _lvlRenderTilemapPaint(idx);
      }
      ps.painting  = false;
      ps.eraseMode = false;
      try { paintCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
      // Phase 5b -- refresh sibling scatter backdrops once at end of
      // stroke (cheap; avoids per-cell re-render during drag).
      const modal = document.getElementById("level2d-editor-modal");
      const lvl = modal && modal._lvl;
      if (wasPainting && lvl && Array.isArray(lvl.layers)) {
        for (let li = 0; li < lvl.layers.length; li++) {
          if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
        }
      }
    };
    paintCanvas.addEventListener("pointerup", _endPaint);
    paintCanvas.addEventListener("pointercancel", _endPaint);
  }
}

/* ── Phase 3: per-scatter-layer placement canvas ─────────────────
 *
 * World-space canvas inline in each scatter card. The layer's
 * `positions` string is parsed into an array of {x,y,scale?,frame?,
 * flipX?} instances; each instance is drawn at its world position
 * using the layer's texture (or a placeholder if the asset bitmap
 * hasn't loaded).
 *
 * Interactions:
 *   Click empty space (left)        -> add new instance at world pos
 *   Drag instance (left)            -> move; pos snaps to 0.25-unit grid
 *   Click instance (right)          -> delete that instance
 *
 * Bounds auto-fit to existing instances + 4-unit padding, with a
 * minimum extent of 40x18 world units. pxPerWorld scales to fit
 * the fixed 480x260 canvas. No pan/zoom yet -- if levels need
 * coordinates far outside the auto-fit bounds, edit via the RAW
 * disclosure for now.
 * ──────────────────────────────────────────────────────────────── */

function _lvlGetLayerScatterState(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return null;
  lvl.scatterState = lvl.scatterState || {};
  if (!lvl.scatterState[idx]) {
    lvl.scatterState[idx] = {
      bitmap: null,
      bitmapURL: "",
      drag: null,                // single-inst drag (legacy) or selection drag
      hoverIdx: -1,
      // Phase 5b -- marquee selection state.
      selected: new Set(),       // instance indices currently selected
      marquee: null              // {sx0, sy0, sx1, sy1} while shift-drag in flight
    };
  }
  return lvl.scatterState[idx];
}

function _lvlParseScatterInstances(layer) {
  const posStr = (typeof layer.positions === "string") ? layer.positions : "";
  const out = [];
  for (const seg of posStr.split(";")) {
    const parts = seg.split(",").map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length < 2) continue;
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const inst = { x, y };
    if (parts.length >= 3 && Number.isFinite(parseFloat(parts[2]))) inst.scale = parseFloat(parts[2]);
    if (parts.length >= 4 && Number.isFinite(parseFloat(parts[3]))) inst.frame = parseInt(parts[3], 10);
    if (parts.length >= 5 && Number.isFinite(parseFloat(parts[4]))) inst.flipX = (parseFloat(parts[4]) >= 0.5);
    out.push(inst);
  }
  return out;
}

function _lvlSerializeScatterInstances(insts) {
  return insts.map(i => {
    let s = (Math.round(i.x * 1000) / 1000) + "," + (Math.round(i.y * 1000) / 1000);
    if (i.scale != null) s += "," + i.scale;
    if (i.frame != null) s += "," + i.frame;
    if (i.flipX) s += ",1";
    return s;
  }).join(";");
}

/* Compute world->canvas projection. Auto-fits to existing instances
 * + padding; canvas size is fixed at 480x260 css px (= native px,
 * since we don't apply DPR scaling for the editor canvases). */
function _lvlScatterProjection(layer, insts, canvas) {
  const W = canvas.width, H = canvas.height;
  // Phase 3.2 -- also fold tilemap-layer extents into the auto-fit
  // bounds so the canvas frames the actual world even when this
  // scatter layer has zero instances yet. Looks at sibling layers
  // on the same Level2D via the open modal's working copy.
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  const sibTilemaps = (lvl && Array.isArray(lvl.layers))
    ? lvl.layers.filter(l => l && l.type === "tilemap" && (l.tileData || "").length > 0)
    : [];
  const haveAnchors = insts.length > 0 || sibTilemaps.length > 0;
  let minX = -20, maxX = 20, minY = -4, maxY = 6;
  if (haveAnchors) {
    minX =  Infinity; maxX = -Infinity;
    minY =  Infinity; maxY = -Infinity;
    const defScale = (typeof layer.scale === "number" && layer.scale > 0) ? layer.scale : 1;
    for (const i of insts) {
      const s = (i.scale != null) ? i.scale : defScale;
      minX = Math.min(minX, i.x - s); maxX = Math.max(maxX, i.x + s);
      minY = Math.min(minY, i.y);     maxY = Math.max(maxY, i.y + s);
    }
    for (const tm of sibTilemaps) {
      const lines = (tm.tileData || "").split("\n");
      const tRows = lines.length;
      const tCols = lines.reduce((m, r) => Math.max(m, r.length), 0);
      const ts = (typeof tm.tileSize === "number" && tm.tileSize > 0) ? tm.tileSize : 1;
      const ox = (typeof tm.originX === "number") ? tm.originX : 0;
      const oy = (typeof tm.originY === "number") ? tm.originY : 0;
      const halfW = tCols * ts * 0.5;
      const halfH = tRows * ts * 0.5;
      minX = Math.min(minX, ox - halfW); maxX = Math.max(maxX, ox + halfW);
      minY = Math.min(minY, oy - halfH); maxY = Math.max(maxY, oy + halfH);
    }
    const pad = 4;
    minX -= pad; maxX += pad;
    minY -= pad; maxY += pad;
  }
  // Enforce minimum extent so a single instance doesn't render
  // huge / a sparse map keeps the world axes visible.
  const minWorldW = 40, minWorldH = 18;
  const cw = maxX - minX, ch = maxY - minY;
  if (cw < minWorldW) {
    const c = (minX + maxX) * 0.5;
    minX = c - minWorldW / 2; maxX = c + minWorldW / 2;
  }
  if (ch < minWorldH) {
    const c = (minY + maxY) * 0.5;
    minY = c - minWorldH / 2; maxY = c + minWorldH / 2;
  }
  // Fit isotropic pxPerWorld so circles stay circles.
  const pxPerWorld = Math.min(W / (maxX - minX), H / (maxY - minY));
  // Center within canvas with leftover margin.
  const usedW = (maxX - minX) * pxPerWorld;
  const usedH = (maxY - minY) * pxPerWorld;
  const offsetX = (W - usedW) * 0.5;
  const offsetY = (H - usedH) * 0.5;
  return {
    minX, maxX, minY, maxY, pxPerWorld, offsetX, offsetY, W, H,
    wToS: (wx, wy) => ({
      sx: offsetX + (wx - minX) * pxPerWorld,
      sy: offsetY + (maxY - wy) * pxPerWorld  // flip Y so +y is up
    }),
    sToW: (sx, sy) => ({
      wx: minX + (sx - offsetX) / pxPerWorld,
      wy: maxY - (sy - offsetY) / pxPerWorld
    })
  };
}

async function _lvlHydrateScatterCanvas(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer || layer.type !== "scatter") return;
  const canvas = document.getElementById("lvl-scatter-" + idx);
  if (!canvas) return;
  const ss = _lvlGetLayerScatterState(idx);
  // Load scatter texture + all tilemap backdrop tilesets in parallel.
  // The sync bitmap cache is populated as each promise resolves, so
  // the next _lvlRenderScatterCanvas pass can drawImage them.
  const loads = [];
  if (layer.texture && layer.texture.length) {
    loads.push(_lvlLoadTilesetBitmap(layer.texture).then(bmp => { ss.bitmap = bmp; ss.bitmapURL = layer.texture; }));
  } else {
    ss.bitmap = null;
    ss.bitmapURL = "";
  }
  for (const other of lvl.layers) {
    if (other && other.type === "tilemap" && other.tileset && other.tileset.length) {
      loads.push(_lvlLoadTilesetBitmap(other.tileset));
    }
  }
  await Promise.all(loads);
  if (!document.getElementById("lvl-scatter-" + idx)) return;
  _lvlRenderScatterCanvas(idx);
}

function _lvlRenderScatterCanvas(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const canvas = document.getElementById("lvl-scatter-" + idx);
  const statusEl = document.getElementById("lvl-scatter-status-" + idx);
  if (!canvas || !layer) return;
  const ss = _lvlGetLayerScatterState(idx);
  const insts = _lvlParseScatterInstances(layer);
  if (statusEl) statusEl.textContent = insts.length + " instance(s)";
  const proj = _lvlScatterProjection(layer, insts, canvas);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  // Sky-ish background.
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, "#0e1828"); grad.addColorStop(1, "#1b2a40");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Integer-unit grid.
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const ix0 = Math.ceil(proj.minX), ix1 = Math.floor(proj.maxX);
  const iy0 = Math.ceil(proj.minY), iy1 = Math.floor(proj.maxY);
  for (let i = ix0; i <= ix1; i++) {
    const { sx } = proj.wToS(i, 0);
    ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, canvas.height);
  }
  for (let j = iy0; j <= iy1; j++) {
    const { sy } = proj.wToS(0, j);
    ctx.moveTo(0, sy + 0.5); ctx.lineTo(canvas.width, sy + 0.5);
  }
  ctx.stroke();
  // 5-unit emphasis.
  ctx.strokeStyle = "rgba(150,180,210,0.13)";
  ctx.beginPath();
  for (let i = Math.ceil(proj.minX / 5) * 5; i <= proj.maxX; i += 5) {
    const { sx } = proj.wToS(i, 0);
    ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, canvas.height);
  }
  for (let j = Math.ceil(proj.minY / 5) * 5; j <= proj.maxY; j += 5) {
    const { sy } = proj.wToS(0, j);
    ctx.moveTo(0, sy + 0.5); ctx.lineTo(canvas.width, sy + 0.5);
  }
  ctx.stroke();
  // World axes (x=0 / y=0) strongly.
  ctx.strokeStyle = "rgba(180,210,240,0.32)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (proj.minX <= 0 && proj.maxX >= 0) {
    const { sx } = proj.wToS(0, 0);
    ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, canvas.height);
  }
  if (proj.minY <= 0 && proj.maxY >= 0) {
    const { sy } = proj.wToS(0, 0);
    ctx.moveTo(0, sy + 0.5); ctx.lineTo(canvas.width, sy + 0.5);
  }
  ctx.stroke();
  // Phase 3.2 -- tilemap backdrop. Faded so scatter sprites read
  // clearly on top. Drawn in layer order (matches in-game depth
  // sort, roughly) so parallax-style stacks make sense visually.
  ctx.save();
  ctx.globalAlpha = 0.55;
  for (let li = 0; li < lvl.layers.length; li++) {
    const other = lvl.layers[li];
    if (other && other.type === "tilemap") {
      _lvlDrawTilemapBackdrop(ctx, other, proj);
    }
  }
  ctx.restore();
  // Each instance.
  const defScale = (typeof layer.scale === "number" && layer.scale > 0) ? layer.scale : 1;
  const defAx    = (typeof layer.anchorX === "number") ? layer.anchorX : 0.5;
  const defAy    = (typeof layer.anchorY === "number") ? layer.anchorY : 0;
  const defFrame = (typeof layer.frame === "number") ? Math.floor(layer.frame) : 0;
  const framesX  = Math.max(1, (typeof layer.framesX === "number") ? Math.floor(layer.framesX) : 1);
  const framesY  = Math.max(1, (typeof layer.framesY === "number") ? Math.floor(layer.framesY) : 1);
  const bmp = ss.bitmap;
  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i];
    const scale = (inst.scale != null) ? inst.scale : defScale;
    const frame = (inst.frame != null) ? inst.frame : defFrame;
    const flipX = !!inst.flipX;
    // World-space quad rect.
    const wx0 = inst.x - scale * defAx;
    const wx1 = wx0 + scale;
    const wy0 = inst.y - scale * defAy;  // anchorY=0 -> wy0 = inst.y (bottom)
    const wy1 = wy0 + scale;
    const a = proj.wToS(wx0, wy1);
    const b = proj.wToS(wx1, wy0);
    const sx0 = Math.min(a.sx, b.sx);
    const sy0 = Math.min(a.sy, b.sy);
    const ww  = Math.abs(b.sx - a.sx);
    const hh  = Math.abs(b.sy - a.sy);
    if (bmp) {
      // Pick frame sub-rect.
      const fcol = frame % framesX;
      const frow = Math.floor(frame / framesX) % framesY;
      const tileW = bmp.width  / framesX;
      const tileH = bmp.height / framesY;
      if (flipX) {
        ctx.save();
        ctx.translate(sx0 + ww, sy0);
        ctx.scale(-1, 1);
        ctx.drawImage(bmp, fcol * tileW, frow * tileH, tileW, tileH, 0, 0, ww, hh);
        ctx.restore();
      } else {
        ctx.drawImage(bmp, fcol * tileW, frow * tileH, tileW, tileH, sx0, sy0, ww, hh);
      }
    } else {
      // Placeholder when bitmap not loaded.
      ctx.fillStyle = "rgba(180,140,90,0.55)";
      ctx.fillRect(sx0, sy0, ww, hh);
      ctx.strokeStyle = "rgba(220,180,120,0.9)";
      ctx.strokeRect(sx0 + 0.5, sy0 + 0.5, ww - 1, hh - 1);
    }
    // Phase 5b -- selection / hover / drag ring. Selected = blue
    // (persistent), hover/drag = green.
    const isSelected = ss.selected && ss.selected.has(i);
    const isHoverOrDrag = (ss.hoverIdx === i) || (ss.drag && ss.drag.instIdx === i);
    if (isSelected) {
      ctx.strokeStyle = "#67c8ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx0 - 0.5, sy0 - 0.5, ww + 1, hh + 1);
    }
    if (isHoverOrDrag) {
      ctx.strokeStyle = "#67ff80";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx0 - 0.5, sy0 - 0.5, ww + 1, hh + 1);
      const label = "(" + (Math.round(inst.x * 100) / 100) + ", " + (Math.round(inst.y * 100) / 100) + ")";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textBaseline = "bottom";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(sx0, sy0 - 12, tw + 6, 12);
      ctx.fillStyle = "#67ff80";
      ctx.fillText(label, sx0 + 3, sy0 - 2);
      ctx.textBaseline = "alphabetic";
    }
  }
  // Phase 5b -- marquee selection overlay.
  if (ss.marquee) {
    const m = ss.marquee;
    const mx0 = Math.min(m.sx0, m.sx1), mx1 = Math.max(m.sx0, m.sx1);
    const my0 = Math.min(m.sy0, m.sy1), my1 = Math.max(m.sy0, m.sy1);
    ctx.save();
    ctx.fillStyle = "rgba(100,200,255,0.13)";
    ctx.fillRect(mx0, my0, mx1 - mx0, my1 - my0);
    ctx.strokeStyle = "#67c8ff";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(mx0 + 0.5, my0 + 0.5, mx1 - mx0 - 1, my1 - my0 - 1);
    ctx.setLineDash([]);
    ctx.restore();
  }
  // Status: instance count + selection count.
  if (statusEl && ss.selected && ss.selected.size > 0) {
    statusEl.textContent = insts.length + " instance(s)  ·  " + ss.selected.size + " selected (Delete to remove)";
  }
}

function _lvlScatterHitTest(idx, sx, sy) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return -1;
  const layer = lvl.layers[idx];
  const canvas = document.getElementById("lvl-scatter-" + idx);
  if (!layer || !canvas) return -1;
  const insts = _lvlParseScatterInstances(layer);
  const proj = _lvlScatterProjection(layer, insts, canvas);
  const defScale = (typeof layer.scale === "number" && layer.scale > 0) ? layer.scale : 1;
  const defAx    = (typeof layer.anchorX === "number") ? layer.anchorX : 0.5;
  const defAy    = (typeof layer.anchorY === "number") ? layer.anchorY : 0;
  // Top-down hit-test (later instances visually overlap earlier ones).
  for (let i = insts.length - 1; i >= 0; i--) {
    const inst = insts[i];
    const scale = (inst.scale != null) ? inst.scale : defScale;
    const wx0 = inst.x - scale * defAx;
    const wx1 = wx0 + scale;
    const wy0 = inst.y - scale * defAy;
    const wy1 = wy0 + scale;
    const a = proj.wToS(wx0, wy1);
    const b = proj.wToS(wx1, wy0);
    const sx0 = Math.min(a.sx, b.sx), sy0 = Math.min(a.sy, b.sy);
    const sx1 = Math.max(a.sx, b.sx), sy1 = Math.max(a.sy, b.sy);
    if (sx >= sx0 && sx <= sx1 && sy >= sy0 && sy <= sy1) return i;
  }
  return -1;
}

function _lvlScatterCommit(idx, insts) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer) return;
  layer.positions = _lvlSerializeScatterInstances(insts);
  // Reflect into RAW textarea (if mounted).
  const ta = document.querySelector('textarea.lvl-scatter-positions-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.positions;
  _lvlRenderScatterCanvas(idx);
}

function _lvlScatterCanvasCoords(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  return {
    sx: (evt.clientX - rect.left) * (canvas.width  / rect.width),
    sy: (evt.clientY - rect.top)  * (canvas.height / rect.height)
  };
}

function _lvlScatterSnap(v) {
  // 0.25-unit grid -- fine enough to place sprites tightly but
  // coarse enough that "the same y" reads as obviously aligned.
  return Math.round(v * 4) / 4;
}

/* Phase 5b -- delete every currently-selected scatter instance.
 * Called from the modal-scoped Delete keydown handler. */
function _lvlScatterDeleteSelection(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ss = lvl.scatterState && lvl.scatterState[idx];
  if (!layer || !ss || !ss.selected || ss.selected.size === 0) return;
  const insts = _lvlParseScatterInstances(layer);
  const remaining = insts.filter((_, i) => !ss.selected.has(i));
  ss.selected.clear();
  _lvlScatterCommit(idx, remaining);
}

/* Phase 5b -- pick all instances whose visible quad intersects a
 * screen-space rect. Used by the marquee on pointerup. */
function _lvlScatterPickInRect(idx, sx0, sy0, sx1, sy1) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return new Set();
  const layer = lvl.layers[idx];
  const canvas = document.getElementById("lvl-scatter-" + idx);
  if (!layer || !canvas) return new Set();
  const insts = _lvlParseScatterInstances(layer);
  const proj = _lvlScatterProjection(layer, insts, canvas);
  const defScale = (typeof layer.scale === "number" && layer.scale > 0) ? layer.scale : 1;
  const defAx    = (typeof layer.anchorX === "number") ? layer.anchorX : 0.5;
  const defAy    = (typeof layer.anchorY === "number") ? layer.anchorY : 0;
  const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
  const mx0 = lo(sx0, sx1), mx1 = hi(sx0, sx1);
  const my0 = lo(sy0, sy1), my1 = hi(sy0, sy1);
  const out = new Set();
  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i];
    const scale = (inst.scale != null) ? inst.scale : defScale;
    const wx0 = inst.x - scale * defAx;
    const wx1 = wx0 + scale;
    const wy0 = inst.y - scale * defAy;
    const wy1 = wy0 + scale;
    const a = proj.wToS(wx0, wy1);
    const b = proj.wToS(wx1, wy0);
    const ix0 = lo(a.sx, b.sx), iy0 = lo(a.sy, b.sy);
    const ix1 = hi(a.sx, b.sx), iy1 = hi(a.sy, b.sy);
    // AABB overlap test.
    if (ix1 < mx0 || ix0 > mx1 || iy1 < my0 || iy0 > my1) continue;
    out.add(i);
  }
  return out;
}

function _lvlWireScatterCanvas(idx) {
  const canvas = document.getElementById("lvl-scatter-" + idx);
  if (!canvas || canvas._lvlWired) return;
  canvas._lvlWired = true;
  canvas.addEventListener("contextmenu", e => e.preventDefault());
  canvas.addEventListener("pointerdown", e => {
    const modal = document.getElementById("level2d-editor-modal");
    const lvl = modal && modal._lvl;
    if (!lvl) return;
    const layer = lvl.layers[idx];
    if (!layer) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const { sx, sy } = _lvlScatterCanvasCoords(canvas, e);
    const hit = _lvlScatterHitTest(idx, sx, sy);
    const insts = _lvlParseScatterInstances(layer);
    const ss = _lvlGetLayerScatterState(idx);

    // Right-click: delete the hit instance (selection too if hit is selected).
    if (e.button === 2) {
      if (hit >= 0) {
        if (ss.selected.has(hit) && ss.selected.size > 0) {
          _lvlScatterDeleteSelection(idx);
        } else {
          insts.splice(hit, 1);
          ss.selected.clear();
          _lvlScatterCommit(idx, insts);
        }
      }
      return;
    }

    // Shift+drag on empty (or on instance) -> start marquee selection.
    // Shift+click on an instance toggles its selected state.
    if (e.shiftKey) {
      if (hit >= 0) {
        if (ss.selected.has(hit)) ss.selected.delete(hit);
        else                       ss.selected.add(hit);
        _lvlRenderScatterCanvas(idx);
        return;
      }
      ss.marquee = { sx0: sx, sy0: sy, sx1: sx, sy1: sy, pointerId: e.pointerId };
      _lvlRenderScatterCanvas(idx);
      return;
    }

    if (hit >= 0) {
      // If hit is part of the existing selection, drag the WHOLE
      // selection. Otherwise clear the selection and drag just this.
      const proj = _lvlScatterProjection(layer, insts, canvas);
      const handlePt = proj.wToS(insts[hit].x, insts[hit].y);
      const groupDrag = ss.selected.has(hit) && ss.selected.size > 1;
      if (!ss.selected.has(hit)) ss.selected.clear();
      ss.drag = {
        instIdx: hit,
        pointerId: e.pointerId,
        offsetSX: sx - handlePt.sx,
        offsetSY: sy - handlePt.sy,
        groupDrag,
        // Snapshot original positions for the group so relative
        // offsets stay intact as the cursor moves.
        anchorX: insts[hit].x,
        anchorY: insts[hit].y,
        groupOrigPos: groupDrag
          ? Array.from(ss.selected).map(i => ({ i, x: insts[i].x, y: insts[i].y }))
          : null
      };
      ss.hoverIdx = hit;
      _lvlRenderScatterCanvas(idx);
    } else {
      // Click empty space (no Shift): clear selection + add new instance.
      ss.selected.clear();
      const proj = _lvlScatterProjection(layer, insts, canvas);
      const w = proj.sToW(sx, sy);
      insts.push({ x: _lvlScatterSnap(w.wx), y: _lvlScatterSnap(w.wy) });
      _lvlScatterCommit(idx, insts);
    }
  });
  canvas.addEventListener("pointermove", e => {
    const modal = document.getElementById("level2d-editor-modal");
    const lvl = modal && modal._lvl;
    if (!lvl) return;
    const layer = lvl.layers[idx];
    if (!layer) return;
    const ss = _lvlGetLayerScatterState(idx);
    const { sx, sy } = _lvlScatterCanvasCoords(canvas, e);
    // Marquee in flight: just update the rect; pick on pointerup.
    if (ss.marquee && ss.marquee.pointerId === e.pointerId) {
      ss.marquee.sx1 = sx;
      ss.marquee.sy1 = sy;
      _lvlRenderScatterCanvas(idx);
      return;
    }
    if (ss.drag && ss.drag.pointerId === e.pointerId) {
      const insts = _lvlParseScatterInstances(layer);
      if (ss.drag.instIdx < 0 || ss.drag.instIdx >= insts.length) {
        ss.drag = null;
        return;
      }
      const proj = _lvlScatterProjection(layer, insts, canvas);
      const w = proj.sToW(sx - ss.drag.offsetSX, sy - ss.drag.offsetSY);
      const newX = _lvlScatterSnap(w.wx);
      const newY = _lvlScatterSnap(w.wy);
      if (ss.drag.groupDrag && ss.drag.groupOrigPos) {
        const dx = newX - ss.drag.anchorX;
        const dy = newY - ss.drag.anchorY;
        for (const o of ss.drag.groupOrigPos) {
          if (o.i >= 0 && o.i < insts.length) {
            insts[o.i].x = _lvlScatterSnap(o.x + dx);
            insts[o.i].y = _lvlScatterSnap(o.y + dy);
          }
        }
      } else {
        insts[ss.drag.instIdx].x = newX;
        insts[ss.drag.instIdx].y = newY;
      }
      _lvlScatterCommit(idx, insts);
    } else {
      const hit = _lvlScatterHitTest(idx, sx, sy);
      if (hit !== ss.hoverIdx) {
        ss.hoverIdx = hit;
        _lvlRenderScatterCanvas(idx);
      }
      canvas.style.cursor = (hit >= 0) ? "grab" : "crosshair";
    }
  });
  const endDrag = e => {
    const modal = document.getElementById("level2d-editor-modal");
    const lvl = modal && modal._lvl;
    if (!lvl) return;
    const ss = _lvlGetLayerScatterState(idx);
    // Marquee finished -> pick instances inside it.
    if (ss.marquee && ss.marquee.pointerId === e.pointerId) {
      const m = ss.marquee;
      // Tiny marquees (single-pixel) -> treat as click, clear selection.
      const minDim = Math.min(Math.abs(m.sx1 - m.sx0), Math.abs(m.sy1 - m.sy0));
      if (minDim >= 3) {
        const picked = _lvlScatterPickInRect(idx, m.sx0, m.sy0, m.sx1, m.sy1);
        // Shift+marquee adds to selection (toggle would be confusing
        // for groups); plain marquee is implied by Shift being held
        // throughout the drag, so always add.
        for (const i of picked) ss.selected.add(i);
      }
      ss.marquee = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      _lvlRenderScatterCanvas(idx);
      return;
    }
    if (ss.drag && ss.drag.pointerId === e.pointerId) {
      ss.drag = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      _lvlRenderScatterCanvas(idx);
    }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    const ss = _lvlGetLayerScatterState(idx);
    if (!ss.drag && !ss.marquee && ss.hoverIdx !== -1) {
      ss.hoverIdx = -1;
      _lvlRenderScatterCanvas(idx);
    }
  });
}

function _lvlInstall() {
  const modal = document.getElementById("level2d-editor-modal");
  if (!modal || modal._lvlWired) return;
  modal._lvlWired = true;
  // Inject a tiny stylesheet for the field labels + inputs so the
  // modal looks consistent without bloating every input's inline style.
  const style = document.createElement("style");
  style.textContent =
    ".lvl-label { font-family:var(--font-mono); font-size:9px; color:var(--text-3); letter-spacing:0.05em; margin-bottom:2px; }" +
    ".lvl-card input[type='text'], .lvl-card input[type='number'], .lvl-card select { width:100%; padding:3px 5px; background:var(--bg-2); color:var(--text-1); border:1px solid var(--instr-rule); border-radius:2px; font-family:var(--font-mono); font-size:10px; }";
  document.head.appendChild(style);
  document.getElementById("lvl-close").addEventListener("click",  _lvlClose);
  document.getElementById("lvl-cancel").addEventListener("click", _lvlClose);
  document.getElementById("lvl-save").addEventListener("click",   _lvlSave);
  document.getElementById("lvl-add-parallax").addEventListener("click", () => _lvlAddLayer("parallax"));
  document.getElementById("lvl-add-tilemap").addEventListener("click",  () => _lvlAddLayer("tilemap"));
  document.getElementById("lvl-add-scatter").addEventListener("click",  () => _lvlAddLayer("scatter"));
  // ESC closes, Ctrl+Z / Ctrl+Shift+Z undo/redo the last paint stroke
  // (only when typing focus is outside a text input -- otherwise the
  // browser's textfield undo wins, which is what users expect).
  document.addEventListener("keydown", (e) => {
    if (modal.style.display === "none") return;
    if (e.key === "Escape") { _lvlClose(); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const ae = document.activeElement;
    const inTextField = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT");
    if (inTextField) return;
    if (e.key === "z" || e.key === "Z") {
      const handled = e.shiftKey ? _lvlRedoLastStroke() : _lvlUndoLastStroke();
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    } else if (e.key === "y" || e.key === "Y") {
      if (_lvlRedoLastStroke()) { e.preventDefault(); e.stopPropagation(); }
    }
    // Delete / Backspace -- remove selected scatter instances.
    if (e.key === "Delete" || e.key === "Backspace") {
      // Phase 5b -- scatter rect-select deletion lives on the canvas;
      // dispatch here so any scatter layer with a non-empty selection
      // gets cleared.
      const lvl = modal._lvl;
      if (lvl && Array.isArray(lvl.layers) && lvl.scatterState) {
        for (let li = 0; li < lvl.layers.length; li++) {
          const ss = lvl.scatterState[li];
          if (ss && ss.selected && ss.selected.size > 0) {
            _lvlScatterDeleteSelection(li);
            e.preventDefault(); e.stopPropagation();
            return;
          }
        }
      }
    }
  });
  // Backdrop click closes (only when click was on the backdrop itself)
  modal.addEventListener("click", (e) => {
    if (e.target === modal) _lvlClose();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", _lvlInstall);
}

/* Draw the result blob into the preview canvas, sized to the chosen
 * width/height. Empty placeholder hidden when bitmap is present. */
async function _ssRedrawPreview(blob) {
  const canvas = document.getElementById("ss-canvas");
  const empty = document.getElementById("ss-empty");
  if (!canvas) return;
  const w = parseInt(document.getElementById("ss-width").value, 10) || 32;
  const h = parseInt(document.getElementById("ss-height").value, 10) || 32;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  if (!blob) {
    if (empty) empty.style.display = "block";
    document.getElementById("ss-save").disabled = true;
    return;
  }
  if (empty) empty.style.display = "none";
  try {
    const bmp = await createImageBitmap(blob);
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) try { bmp.close(); } catch (_) {}
    document.getElementById("ss-save").disabled = false;
    // Stash the blob on the canvas DOM node so Save can read it.
    canvas._ssBlob = blob;
  } catch (e) {
    _ssStatus("Preview failed: " + (e.message || e), "err");
  }
}

function _ssStatus(msg, kind) {
  const el = document.getElementById("ss-status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === "err" ? "#ff8060"
                 : kind === "ok"  ? "#80ff80"
                 : kind === "thinking" ? "var(--phosphor)"
                 : "var(--text-3)";
}

/* Generation progress poll. Drives the thin bar under the modal head
 * and updates the status line with step / elapsed / ETA while the
 * compile-server worker is running a diffusion. Returns a cancel fn
 * the caller invokes on success/failure to tear it down.
 *
 * Poll cadence: Chrome's Local Network Access (LNA) gate flags every
 * file:// → 127.0.0.1 request as a CSRF concern; a tight poll racks
 * up hundreds of DevTools issues per minute. We poll at 1.2 s, skip
 * when the tab is hidden, and delay the first poll 1.2 s to skip
 * the warm-up window when nothing has been emitted yet. (Switching
 * to SSE / WebSocket would drop this to 1 connection per gen but is
 * a bigger change -- file an issue if the slow poll feels laggy.) */
const _SS_POLL_INTERVAL_MS = 1200;
const _SS_POLL_FIRST_DELAY_MS = 1200;
function _ssStartProgressPoll(serverBase, label) {
  const wrap = document.getElementById("ss-progress-wrap");
  const bar  = document.getElementById("ss-progress-bar");
  if (!wrap || !bar) return () => {};
  wrap.style.display = "block";
  bar.style.width = "0%";
  bar.style.background = "var(--phosphor)";
  const t0 = performance.now();
  const url = serverBase.replace(/\/+$/, "") + "/sprite-gen/progress";
  let cancelled = false;
  let lastStep = 0;
  let stalledSince = t0;
  async function poll() {
    if (cancelled) return;
    // Skip the fetch when the tab is hidden -- the user can't see the
    // bar anyway, and these add up to ~1 LNA flag per second otherwise.
    if (document.hidden) {
      setTimeout(poll, _SS_POLL_INTERVAL_MS);
      return;
    }
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        const browserElapsed = Math.round(performance.now() - t0);
        const total = Math.max(1, j.total | 0);
        const step  = Math.max(0, Math.min(total, j.step | 0));
        // Bar fills proportional to steps. Before the first callback
        // (warm-up / LoRA swap) we creep to 8% so the user sees motion.
        let pct;
        if (step === 0) {
          pct = Math.min(8, browserElapsed / 200);
        } else {
          pct = 8 + (92 * step) / total;
        }
        bar.style.width = pct.toFixed(1) + "%";
        // ETA: extrapolate from elapsed-per-step. Reasonable once step ≥ 2.
        let etaTxt = "";
        if (step >= 2 && j.elapsedMs > 0) {
          const perStep = j.elapsedMs / step;
          const remainMs = perStep * (total - step);
          etaTxt = " · ~" + (remainMs / 1000).toFixed(1) + "s left";
        }
        // Detect stalls -- if step doesn't move for >12s after step 1,
        // turn the bar amber so the user knows something's off (model
        // loading / OS swapping / etc).
        if (step !== lastStep) {
          stalledSince = performance.now();
          lastStep = step;
        }
        if (step >= 1 && performance.now() - stalledSince > 12000) {
          bar.style.background = "#e0b060";
        }
        const elapsedSec = (browserElapsed / 1000).toFixed(1);
        _ssStatus(
          (label || "rendering") +
          " · step " + step + "/" + total +
          " · " + elapsedSec + "s" + etaTxt,
          "thinking"
        );
      }
    } catch (_) {
      // Polling failures are non-fatal -- the bar just freezes briefly.
    }
    if (!cancelled) setTimeout(poll, _SS_POLL_INTERVAL_MS);
  }
  // Defer the first poll past the worker's typical "no-op warm-up"
  // window so the very first frame doesn't show an empty `step 0/M`.
  setTimeout(poll, _SS_POLL_FIRST_DELAY_MS);
  return () => {
    cancelled = true;
    wrap.style.display = "none";
    bar.style.width = "0%";
    bar.style.background = "var(--phosphor)";
  };
}

/* Wire the Sprite Studio: modal close, generate, save. Entry point is
 * the SpriteCreator node's ⚙ gear handle, which calls _ssOpen(nodeId)
 * directly from the node render code in render(). */
function _ssInstall() {
  const closeBtn = document.getElementById("ss-close");
  if (closeBtn && !closeBtn._ssWired) {
    closeBtn._ssWired = true;
    closeBtn.addEventListener("click", _ssClose);
  }
  const modal = document.getElementById("spritestudio-modal");
  if (modal && !modal._ssWired) {
    modal._ssWired = true;
    modal.addEventListener("click", e => { if (e.target === modal) _ssClose(); });
  }
  const genBtn = document.getElementById("ss-generate");
  if (genBtn && !genBtn._ssWired) {
    genBtn._ssWired = true;
    genBtn.addEventListener("click", async () => {
      const description = document.getElementById("ss-prompt").value.trim();
      if (!description) { _ssStatus("Enter a description first.", "err"); return; }
      const stylePreset = document.getElementById("ss-preset").value;
      const backend     = document.getElementById("ss-backend").value;
      const w = parseInt(document.getElementById("ss-width").value, 10) || 32;
      const h = parseInt(document.getElementById("ss-height").value, 10) || 32;
      const fx = parseInt(document.getElementById("ss-framesX").value, 10) || 1;
      const fy = parseInt(document.getElementById("ss-framesY").value, 10) || 1;
      // Persist the backend choice across opens.
      aiSettings.spriteBackend = backend;
      saveAiSettings();
      genBtn.disabled = true;
      try {
        let blob = null;
        if (backend === "compile-server-sd") {
          // Bundled SD via compile-server (the default for users who
          // ran scripts/install-sd.sh). Uses model defaults set
          // server-side; here we just send prompt + dims + steps.
          const serverBase = (typeof localServerEndpoint === "string" && localServerEndpoint)
            ? localServerEndpoint
            : "http://127.0.0.1:8765";
          const sheetW = w, sheetH = h;
          // Native gen resolution from the QUALITY dropdown. Default
          // 512 (was 1024) since 1024 takes 4-5 min per frame on M4
          // and routinely times out. 512 is "Standard" quality and
          // still downsamples cleanly to any sprite size. User can
          // bump to High / Max if they want sharper detail and have
          // time to wait.
          const qualityEl = document.getElementById("ss-sd-quality");
          const nativeSize = parseInt((qualityEl && qualityEl.value) || aiSettings.sdQuality || "512", 10) || 512;
          aiSettings.sdQuality = String(nativeSize);
          const model = (document.getElementById("ss-sd-model").value)
            || aiSettings.sdModel || "z-image-turbo";
          aiSettings.sdModel = model;
          saveAiSettings();
          const steps = parseInt(document.getElementById("ss-sd-steps").value, 10) || 9;
          const totalFrames = fx * fy;
          // Lock one seed across the whole batch so every frame looks
          // like the same character. Without this, each gen returns a
          // different fox / robot / whatever -- useless for animation.
          const sharedSeed = Math.floor(Math.random() * 1e9);
          if (totalFrames <= 1) {
            // Single-pose, fast path.
            _ssStatus("compile-server SD (" + model + ") rendering " + nativeSize + "×" + nativeSize + "…", "thinking");
            const stopPoll = _ssStartProgressPoll(
              serverBase,
              "SD (" + model + ") " + nativeSize + "×" + nativeSize
            );
            let raw;
            try {
              raw = await _ssCallCompileServerSD(serverBase, model, description, stylePreset, nativeSize, steps, sharedSeed);
            } finally {
              stopPoll();
            }
            _ssStatus("Downsampling to " + sheetW + "×" + sheetH + "…", "thinking");
            blob = await _ssDownsampleBlob(raw, sheetW, sheetH);
            document.getElementById("ss-code").value = "// compile-server SD\n// model: " + model + "\n// prompt: " + description + "\n// seed: " + sharedSeed + "\n// native " + nativeSize + " → sprite " + sheetW + "×" + sheetH;
          } else {
            // Multi-pose batch: N gens with auto pose variants, stitched.
            const poses = _ssBuildPosePrompts(totalFrames);
            const frameBlobs = [];
            const batchT0 = performance.now();
            for (let i = 0; i < totalFrames; i++) {
              const framePrompt = description + (poses[i] ? ", " + poses[i] : "");
              const framelabel = "Frame " + (i + 1) + "/" + totalFrames;
              _ssStatus(framelabel + " (" + (poses[i] || "default") + ")…", "thinking");
              const stopPoll = _ssStartProgressPoll(
                serverBase,
                framelabel + " — SD " + nativeSize + "×" + nativeSize
              );
              let raw;
              try {
                raw = await _ssCallCompileServerSD(serverBase, model, framePrompt, stylePreset, nativeSize, steps, sharedSeed);
              } finally {
                stopPoll();
              }
              const frameBlob = await _ssDownsampleBlob(raw, sheetW, sheetH);
              frameBlobs.push(frameBlob);
            }
            _ssStatus("Stitching " + totalFrames + " frames into " + fx + "×" + fy + " sheet…", "thinking");
            blob = await _ssStitchSheet(frameBlobs, sheetW, sheetH, fx, fy);
            const batchSec = ((performance.now() - batchT0) / 1000).toFixed(1);
            document.getElementById("ss-code").value =
              "// compile-server SD multi-pose batch\n"
              + "// model: " + model + "\n"
              + "// prompt: " + description + "\n"
              + "// seed: " + sharedSeed + " (locked across all frames)\n"
              + "// grid: " + fx + "×" + fy + " = " + totalFrames + " frames\n"
              + "// frame: " + sheetW + "×" + sheetH + "  sheet: " + (sheetW * fx) + "×" + (sheetH * fy) + "\n"
              + "// total time: " + batchSec + "s\n"
              + "// poses:\n//   " + poses.map((p, i) => "[" + i + "] " + (p || "(none)")).join("\n//   ");
          }
        } else if (backend === "local-sd-a1111") {
          // Persist endpoint + sampler settings.
          const endpoint = document.getElementById("ss-sd-endpoint").value.trim() || "http://localhost:7860";
          const steps = parseInt(document.getElementById("ss-sd-steps").value, 10) || 20;
          const sampler = document.getElementById("ss-sd-sampler").value.trim() || "DPM++ 2M Karras";
          aiSettings.sdEndpoint = endpoint;
          aiSettings.sdSteps = steps;
          aiSettings.sdSampler = sampler;
          saveAiSettings();
          // SD native size: power-of-two ≥ max(w*fx, h*fy), capped at 768
          // for M4 perf. Final downsample maps to user's sprite dims.
          const sheetW = w; // for now: single-frame; spritesheets need
          const sheetH = h; // a per-frame loop, deferred to sd-2.
          const nativeSize = Math.min(768, Math.max(256, _ssNextPow2(Math.max(sheetW, sheetH) * 4)));
          _ssStatus("SD rendering at " + nativeSize + "×" + nativeSize + " (steps=" + steps + ")…", "thinking");
          const raw = await _ssCallA1111(endpoint, description, stylePreset, nativeSize, steps, sampler);
          _ssStatus("Downsampling to " + sheetW + "×" + sheetH + "…", "thinking");
          blob = await _ssDownsampleBlob(raw, sheetW, sheetH);
          document.getElementById("ss-code").value = "// SD output from " + endpoint + "\n// prompt: " + description + "\n// style: " + stylePreset + "\n// native " + nativeSize + " → sprite " + sheetW + "×" + sheetH;
        } else {
          // Default: LLM → JS canvas code path (the v1 cheap+free option).
          const provider = PROVIDERS[aiSettings.provider];
          if (!provider) { throw new Error("No LLM provider configured (User DSP → ⚙)."); }
          let key = "";
          if (provider.requiresKey) {
            key = aiSettings.anthropicKey;
            if (!key) { throw new Error("API key required — set in User DSP → ⚙."); }
          }
          _ssStatus("Asking " + aiSettings.provider + "…", "thinking");
          const system = _ssBuildSystemPrompt();
          const user = _ssBuildUserPrompt(description, stylePreset, w, h, fx, fy);
          const reply = await provider.call({
            system, user, key, model: aiSettings.model,
            temperature: 0.4, maxTokens: 4096
          });
          const code = _ssExtractJsFromResponse(reply);
          document.getElementById("ss-code").value = code;
          _ssStatus("Painting…", "thinking");
          blob = await _ssExecutePaintCode(code, w, h, fx, fy);
        }
        await _ssRedrawPreview(blob);
        _ssStatus("Generated (" + Math.round(blob.size / 1024) + " KB). Click Save.", "ok");
      } catch (e) {
        console.error("[sprite-studio] generate failed:", e);
        _ssStatus("Generate failed: " + (e.message || e), "err");
        document.getElementById("ss-save").disabled = true;
      } finally {
        genBtn.disabled = false;
      }
    });
  }
  // Toggle SD config row based on backend selector + persist choice.
  const backendEl = document.getElementById("ss-backend");
  if (backendEl && !backendEl._ssWired) {
    backendEl._ssWired = true;
    const sdConfig = document.getElementById("ss-sd-config");
    const helpEl = document.getElementById("ss-help");
    const updateBackendUI = () => {
      const b = backendEl.value;
      const isA1111 = b === "local-sd-a1111";
      const isCSSD  = b === "compile-server-sd";
      if (sdConfig) sdConfig.style.display = isA1111 ? "block" : "none";
      if (helpEl) {
        if (isCSSD) {
          helpEl.innerHTML = "Calls the local <strong>gamma-compile-server</strong>'s <code>/sprite-gen</code> route. Uses bundled <strong>Z-Image-Turbo</strong> + Pixel Art LoRA. Make sure you ran <code>scripts/install-sd.sh</code> in the compile-server checkout. First gen pays the model-load cost (~30–60s on Apple Silicon); subsequent ones are fast.";
        } else if (isA1111) {
          helpEl.innerHTML = "Calls AUTOMATIC1111 webui at the endpoint above. Make sure it's running with <code>--api</code> (and <code>--cors-allow-origins=*</code> if browser blocks it). Output renders at native size then downsamples to the sprite dims using nearest-neighbor.";
        } else {
          helpEl.innerHTML = "Uses the LLM provider set in <em>User DSP → ⚙</em>. Default: Claude API. Output runs as JS canvas paint code in this page. No corporate-IP references in the prompt.";
        }
      }
    };
    backendEl.addEventListener("change", updateBackendUI);
    backendEl._ssUpdateUI = updateBackendUI;
  }
  const saveBtn = document.getElementById("ss-save");
  if (saveBtn && !saveBtn._ssWired) {
    saveBtn._ssWired = true;
    saveBtn.addEventListener("click", async () => {
      const canvas = document.getElementById("ss-canvas");
      const blob = canvas && canvas._ssBlob;
      if (!blob) { _ssStatus("Nothing to save yet.", "err"); return; }
      const nameRaw = (document.getElementById("ss-name").value || "").trim();
      const name = nameRaw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || ("sprite-" + Date.now().toString(36).slice(-5));
      const w = parseInt(document.getElementById("ss-width").value, 10) || 32;
      const h = parseInt(document.getElementById("ss-height").value, 10) || 32;
      const fx = parseInt(document.getElementById("ss-framesX").value, 10) || 1;
      const fy = parseInt(document.getElementById("ss-framesY").value, 10) || 1;
      const fps = parseFloat(document.getElementById("ss-fps").value) || 8;
      const scale = parseFloat(document.getElementById("ss-scale").value) || 32;
      saveBtn.disabled = true;
      _ssStatus("Saving to asset library…", "thinking");
      try {
        // Wrap the blob in a fake File-like so loadImageFileToSpriteAsset
        // can compute width/height + create the asset record via the
        // existing path. We pre-set framesX/Y/fps/scale via opts so the
        // record carries the user's chosen metadata immediately.
        const fakeFile = new File([blob], name + ".png", { type: "image/png" });
        const rec = await loadImageFileToSpriteAsset(fakeFile, {
          name, framesX: fx, framesY: fy, fps, scale,
          source: "creator"
        });
        if (!rec) throw new Error("asset create returned null");
        // Write back to the source SpriteCreator node (if opened from one)
        // so its defaults reflect the latest generation and downstream
        // nodes wired to `lastAsset` see the new name.
        const modal = document.getElementById("spritestudio-modal");
        const sourceNodeId = modal && modal._ssSourceNodeId;
        if (sourceNodeId) {
          const node = (typeof nodeById === "function") ? nodeById(sourceNodeId) : null;
          if (node && node.params) {
            node.params.prompt   = document.getElementById("ss-prompt").value.trim();
            node.params.style    = document.getElementById("ss-preset").value;
            node.params.width    = w;
            node.params.height   = h;
            node.params.framesX  = fx;
            node.params.framesY  = fy;
            node.params.fps      = fps;
            node.params.scale    = scale;
            node.params.lastAssetName = rec.name;
            if (typeof render === "function") {
              try { render(); } catch (_) {}
            }
          }
        }
        _ssStatus("Saved as '" + rec.name + "'.", "ok");
        // Refresh Assets tab so the new sprite shows up immediately.
        if (typeof brRenderAssets === "function") brRenderAssets();
        // Auto-close after a short delay so the user sees the success msg.
        setTimeout(_ssClose, 700);
      } catch (e) {
        console.error("[sprite-studio] save failed:", e);
        _ssStatus("Save failed: " + (e.message || e), "err");
        saveBtn.disabled = false;
      }
    });
  }
  // Live-update preview canvas size when width/height inputs change
  // (so the user can see the empty canvas at the right aspect before
  // clicking Generate).
  ["ss-width", "ss-height"].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el._ssWired) {
      el._ssWired = true;
      el.addEventListener("change", () => _ssRedrawPreview(null));
    }
  });
  // §sd-polish -- model dropdown persists to aiSettings + re-probes the
  // server so the installed marker stays accurate after a fresh install.
  const sdModelEl = document.getElementById("ss-sd-model");
  if (sdModelEl && !sdModelEl._ssWired) {
    sdModelEl._ssWired = true;
    sdModelEl.addEventListener("change", () => {
      aiSettings.sdModel = sdModelEl.value;
      saveAiSettings();
      _ssRefreshModelStatus();
    });
  }
}
// Install on next tick (DOM is ready by the time this script tag runs).
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _ssInstall);
  } else {
    _ssInstall();
  }
}

/* ── Asset folder creation (asset-folders sprint) ───────────────── */
/* Create a folder asset. function must be one of _ASSET_FUNCTIONS;
 * defaults to 'decoration' (single-slot, lowest friction). Slots are
 * pre-populated empty (each slot value = null) so the editor can
 * render placeholders without checking for missing keys.
 *
 * `slots` arg lets the caller pre-fill assignments (LLM auto-sort uses
 * this). Format: {slotName: spriteAssetId}. Anything not in the
 * function's slot list is dropped (with a warning) so a relabel later
 * doesn't leave orphan keys behind. */
async function createFolderAsset(name, functionKey, opts) {
  opts = opts || {};
  const fdef = _ASSET_FUNCTIONS[functionKey] || _ASSET_FUNCTIONS["decoration"];
  const slotMap = {};
  for (const s of fdef.slots) slotMap[s.name] = null;
  if (opts.slots) {
    for (const k of Object.keys(opts.slots)) {
      if (k in slotMap) slotMap[k] = opts.slots[k];
      else console.warn("[folder] dropping unknown slot '" + k + "' for function " + functionKey);
    }
  }
  const baseName = (typeof name === "string" && name.length)
    ? name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
    : "folder-" + Date.now().toString(36).slice(-5);
  const rec = {
    id: "fold_" + Date.now() + "_" + Math.floor(Math.random() * 1e6),
    assetType: "folder",
    name: baseName,
    functionKey: functionKey || "decoration",
    slots: slotMap,            // slotName → spriteAssetId | null
    notes: opts.notes || "",
    source: opts.source || "manual"
  };
  await Assets.put(rec);
  console.log("[assets] created folder '" + rec.name + "' (" + rec.functionKey + ") id=" + rec.id);
  return rec;
}

/* ── Folder editor modal (asset-folders sprint) ─────────────────── */
/* Edits a single AssetFolder record. Opens via _folderOpen(id);
 * everything writes back to the in-memory map immediately and Persists
 * via Assets.put on field changes. No explicit Save button — every
 * input edit is autosaved. */

function _folderOpen(folderId) {
  const modal = document.getElementById("folder-modal");
  if (!modal) return;
  modal._folderId = folderId;
  modal.style.display = "flex";
  _folderRender();
}
function _folderClose() {
  const modal = document.getElementById("folder-modal");
  if (!modal) return;
  modal.style.display = "none";
  modal._folderId = null;
  // Re-render the Assets tab so the card sub-line (filled/total slots)
  // reflects the latest assignments.
  if (typeof brRenderAssets === "function") brRenderAssets();
}
function _folderStatus(msg, kind) {
  const el = document.getElementById("folder-status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = kind === "err" ? "#ff8060"
                 : kind === "ok"  ? "#80ff80"
                 : kind === "thinking" ? "var(--phosphor)"
                 : "var(--text-3)";
}
function _folderAutoStatus(msg, kind) {
  const el = document.getElementById("folder-autosort-status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = kind === "err" ? "#ff8060"
                 : kind === "ok"  ? "#80ff80"
                 : kind === "thinking" ? "var(--phosphor)"
                 : "var(--text-3)";
}

function _folderRender() {
  const modal = document.getElementById("folder-modal");
  if (!modal || !modal._folderId) return;
  const rec = Assets.get(modal._folderId);
  if (!rec) { _folderStatus("folder not found", "err"); return; }
  const fdef = _ASSET_FUNCTIONS[rec.functionKey] || _ASSET_FUNCTIONS["decoration"];

  // Name
  const nameEl = document.getElementById("folder-name");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = rec.name;

  // Function dropdown (populate options once; preserve selection across renders).
  const funcEl = document.getElementById("folder-function");
  if (funcEl && funcEl.options.length === 0) {
    funcEl.innerHTML = Object.keys(_ASSET_FUNCTIONS).map(k =>
      `<option value="${escapeAttr(k)}">${escapeText(_ASSET_FUNCTIONS[k].label)}</option>`
    ).join("");
  }
  if (funcEl) funcEl.value = rec.functionKey;
  const descEl = document.getElementById("folder-func-desc");
  if (descEl) descEl.textContent = fdef.description;

  // Slot rows
  const slotsEl = document.getElementById("folder-slots");
  if (!slotsEl) return;
  slotsEl.innerHTML = fdef.slots.map(slot => {
    const sid = (rec.slots || {})[slot.name];
    const srec = sid ? _spriteAssets.get(sid) : null;
    let preview;
    if (srec && srec.blob) {
      let url = srec._thumbUrl;
      if (!url) { try { url = URL.createObjectURL(srec.blob); srec._thumbUrl = url; } catch (_) {} }
      preview = `<img src="${escapeAttr(url)}" style="max-width:42px; max-height:42px; image-rendering:pixelated; image-rendering:crisp-edges;"/>`;
    } else if (sid && !srec) {
      preview = `<span style="color:#ff8060; font-size:9.5px;">(deleted)</span>`;
    } else {
      preview = `<span style="color:var(--text-3); font-size:18px; opacity:0.4;">+</span>`;
    }
    return `
      <div class="folder-slot-row" data-slot="${escapeAttr(slot.name)}" style="display:flex; gap:10px; align-items:center; padding:6px 8px; background:var(--bg-1); border:1px solid var(--instr-rule); border-radius:3px;">
        <div class="folder-slot-drop" style="width:50px; height:50px; flex-shrink:0; background:#0a0c10; border:1px dashed rgba(255,255,255,0.15); border-radius:2px; display:flex; align-items:center; justify-content:center;">${preview}</div>
        <div style="flex:1; min-width:0;">
          <div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-1); font-weight:600; display:flex; align-items:center; gap:6px;">
            ${escapeText(slot.name)}
            ${slot.optional ? '<span style="font-weight:400; font-size:8.5px; color:var(--text-3); letter-spacing:0.05em;">OPTIONAL</span>' : ""}
          </div>
          <div style="font-family:var(--font-mono); font-size:9.5px; color:var(--text-3); line-height:1.4; margin-top:1px;">${escapeText(slot.desc)}</div>
          ${srec ? `<div style="font-family:var(--font-mono); font-size:9px; color:#80ff80; margin-top:2px;">→ ${escapeText(srec.name)}</div>` : ""}
        </div>
        ${sid ? `<button class="folder-slot-clear" data-slot="${escapeAttr(slot.name)}" title="Unassign this slot" style="padding:2px 6px; background:var(--bg-1); color:var(--text-3); border:1px solid var(--text-3); border-radius:2px; cursor:pointer; font-family:var(--font-mono); font-size:9.5px;">clear</button>` : ""}
      </div>
    `;
  }).join("");

  // Wire drop targets on slot rows. Accept text/x-gamma-asset-id with
  // type=sprite; refuse anything else.
  slotsEl.querySelectorAll(".folder-slot-row").forEach(row => {
    const slotName = row.dataset.slot;
    row.addEventListener("dragover", e => {
      const types = e.dataTransfer && e.dataTransfer.types;
      if (!types || !types.indexOf) return;
      if (types.indexOf("text/x-gamma-asset-id") < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      row.style.borderColor = "var(--phosphor)";
    });
    row.addEventListener("dragleave", () => { row.style.borderColor = "var(--instr-rule)"; });
    row.addEventListener("drop", async e => {
      row.style.borderColor = "var(--instr-rule)";
      const id = e.dataTransfer.getData("text/x-gamma-asset-id");
      const type = e.dataTransfer.getData("text/x-gamma-asset-type");
      if (!id || (type && type !== "sprite")) return;
      e.preventDefault();
      const fid = modal._folderId;
      const folder = Assets.get(fid);
      if (!folder) return;
      folder.slots[slotName] = id;
      await Assets.put(folder);
      _folderRender();
    });
  });
  slotsEl.querySelectorAll(".folder-slot-clear").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const fid = modal._folderId;
      const folder = Assets.get(fid);
      if (!folder) return;
      folder.slots[btn.dataset.slot] = null;
      await Assets.put(folder);
      _folderRender();
    });
  });
}

/* LLM-driven slot assignment. Sends sprite names + slot descriptions
 * to the configured provider; parses JSON response of the form
 *   {slotName: spriteName, ...}
 * and applies. Only assigns slots that are currently empty (preserves
 * the user's manual picks); set the FOLDER_AUTOSORT_OVERWRITE flag
 * if/when we want a "Re-sort everything" affordance. */
async function _folderAutoSort() {
  const modal = document.getElementById("folder-modal");
  if (!modal || !modal._folderId) return;
  const rec = Assets.get(modal._folderId);
  if (!rec) return;
  const fdef = _ASSET_FUNCTIONS[rec.functionKey] || _ASSET_FUNCTIONS["decoration"];
  const sprites = Assets.list({ type: "sprite" });
  if (sprites.length === 0) {
    _folderAutoStatus("no sprites in the library to sort", "err");
    return;
  }
  const provider = PROVIDERS[aiSettings.provider];
  if (!provider) { _folderAutoStatus("no LLM provider (User DSP → ⚙)", "err"); return; }
  let key = "";
  if (provider.requiresKey) {
    key = aiSettings.anthropicKey;
    if (!key) { _folderAutoStatus("API key required (User DSP → ⚙)", "err"); return; }
  }

  const slotLines = fdef.slots.map(s =>
    "  " + s.name + (s.optional ? " (optional)" : "") + " — " + s.desc
  ).join("\n");
  const spriteNames = sprites.map(s => "  " + s.name).join("\n");

  const system = [
    "You are organizing pixel-art sprite assets for a 2D game.",
    "Given a function and its slots, plus a list of available sprite names,",
    "match each sprite to the slot it best fits. Slot names are fixed;",
    "sprite names are user-provided. Match by name semantics (e.g. a sprite",
    "called 'fox-idle' fits the 'idle' slot).",
    "",
    "OUTPUT RULES:",
    "- Output ONLY a JSON object, no markdown fences, no comments.",
    "- Keys are slot names from the provided list.",
    "- Values are sprite names from the provided list.",
    "- Omit slots that don't have a clear match. Don't invent slot names.",
    "- Don't reuse the same sprite for multiple slots unless it genuinely fits both.",
    "- Sprites that don't fit any slot are ignored."
  ].join("\n");

  const user = [
    "Folder function: " + fdef.label,
    "Function description: " + fdef.description,
    "",
    "Slots:",
    slotLines,
    "",
    "Available sprites (by name):",
    spriteNames,
    "",
    "Return the JSON object now:"
  ].join("\n");

  _folderAutoStatus("asking " + aiSettings.provider + "…", "thinking");
  let reply;
  try {
    reply = await provider.call({ system, user, key, model: aiSettings.model,
      temperature: 0.2, maxTokens: 1024 });
  } catch (e) {
    _folderAutoStatus("LLM call failed: " + (e.message || e), "err");
    return;
  }
  // Extract JSON (strip markdown fences if Claude wrapped it).
  let raw = reply.trim();
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  let map;
  try {
    map = JSON.parse(raw);
  } catch (e) {
    _folderAutoStatus("LLM returned invalid JSON: " + e.message, "err");
    console.warn("[folder-autosort] reply was:", reply);
    return;
  }
  // Apply: for each entry, find a sprite by name (case-insensitive) and
  // assign IF the slot is currently empty. Tracks how many were assigned.
  let n = 0;
  for (const [slotName, spriteName] of Object.entries(map)) {
    if (!(slotName in rec.slots)) continue;            // unknown slot
    if (rec.slots[slotName]) continue;                 // already filled (preserve manual)
    const srec = Assets.findSpriteByName(spriteName);
    if (!srec) continue;
    rec.slots[slotName] = srec.id;
    n++;
  }
  await Assets.put(rec);
  _folderAutoStatus("assigned " + n + " slot" + (n === 1 ? "" : "s"), n > 0 ? "ok" : "err");
  _folderRender();
}

function _folderInstallHandlers() {
  const closeBtn = document.getElementById("folder-close");
  if (closeBtn && !closeBtn._folderWired) {
    closeBtn._folderWired = true;
    closeBtn.addEventListener("click", _folderClose);
  }
  const modal = document.getElementById("folder-modal");
  if (modal && !modal._folderWired) {
    modal._folderWired = true;
    modal.addEventListener("click", e => { if (e.target === modal) _folderClose(); });
  }
  const nameEl = document.getElementById("folder-name");
  if (nameEl && !nameEl._folderWired) {
    nameEl._folderWired = true;
    let commitTimer = null;
    nameEl.addEventListener("input", () => {
      // Debounced commit so we're not writing IDB on every keystroke.
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(async () => {
        const fid = document.getElementById("folder-modal")._folderId;
        const rec = Assets.get(fid);
        if (!rec) return;
        const raw = nameEl.value.trim();
        const clean = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
        if (clean && clean !== rec.name) {
          rec.name = clean;
          await Assets.put(rec);
        }
      }, 250);
    });
  }
  const funcEl = document.getElementById("folder-function");
  if (funcEl && !funcEl._folderWired) {
    funcEl._folderWired = true;
    funcEl.addEventListener("change", async () => {
      const fid = document.getElementById("folder-modal")._folderId;
      const rec = Assets.get(fid);
      if (!rec) return;
      const newFunc = funcEl.value;
      if (newFunc === rec.functionKey) return;
      // Keep slot assignments that exist in BOTH old and new function;
      // drop anything else. Preserves user effort when relabeling
      // between similar functions (e.g. character ↔ enemy share 'idle').
      const newDef = _ASSET_FUNCTIONS[newFunc] || _ASSET_FUNCTIONS["decoration"];
      const newSlots = {};
      for (const s of newDef.slots) {
        newSlots[s.name] = (rec.slots && rec.slots[s.name]) || null;
      }
      rec.functionKey = newFunc;
      rec.slots = newSlots;
      await Assets.put(rec);
      _folderRender();
    });
  }
  const autoBtn = document.getElementById("folder-autosort");
  if (autoBtn && !autoBtn._folderWired) {
    autoBtn._folderWired = true;
    autoBtn.addEventListener("click", _folderAutoSort);
  }
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _folderInstallHandlers);
  } else {
    _folderInstallHandlers();
  }
}

/* ── Audio file decode + asset creation ─────────────────────────── */
async function loadAudioFileToAsset(file) {
  const buf = await file.arrayBuffer();
  // Use the page's existing AudioContext (first one created on Play
  // start) when available — otherwise spawn a transient one. Either
  // way it's only used to decode; we take a copy of the channel data.
  let ctx = (previewState && previewState.audioCtx) || null;
  let ctxIsTransient = false;
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxIsTransient = true;
  }
  const decoded = await ctx.decodeAudioData(buf.slice(0));
  let data;
  if (decoded.numberOfChannels >= 2) {
    data = [decoded.getChannelData(0).slice(), decoded.getChannelData(1).slice()];
  } else {
    data = decoded.getChannelData(0).slice();
  }
  if (ctxIsTransient) try { ctx.close(); } catch (e) {}
  const id = _newAssetId();
  const record = {
    id,
    name: file.name,
    sampleRate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
    durationSec: decoded.duration,
    data
  };
  _assets.set(id, record);
  // Persist async — don't block the UI on slow disks.
  _idbPut(record).catch(e => console.warn("[assets] IDB put failed:", e));
  return record;
}

function getAsset(id) { return id ? _assets.get(id) : null; }

async function deleteAsset(id) {
  if (!id) return;
  _assets.delete(id);
  try { await _idbDelete(id); } catch (e) {}
}

/* Codegen helper — emit a setSampleRate + load(...) call for a node
 * with an assetId. For mono nodes pass channelIndex (default 0); for
 * stereo nodes call twice (channels 0 and 1) into setLoadL/setLoadR.
 * Samples larger than ASSET_EMBED_LIMIT emit a TODO comment with the
 * asset's metadata so the user can hook runtime loading externally
 * (full musical stems use this path). */
function emitAssetLoadCpp(node, channel, methodLoad, methodSetSr) {
  const id = node.params && node.params.assetId;
  const a = getAsset(id);
  if (!a) {
    return `        // ${node.id}: no sample loaded`;
  }
  const arr = (a.channels >= 2 && Array.isArray(a.data)) ? a.data[channel | 0] : a.data;
  if (!arr || !arr.length) return `        // ${node.id}: empty sample`;
  const N = arr.length;
  if (N > ASSET_EMBED_LIMIT) {
    // Stem-sized samples — too big to embed as constexpr without
    // bloating the source. Skip the embed and leave a TODO; live
    // preview's AudioWorklet path will load via postMessage in v2.
    return [
      `        // ${node.id}: sample too large to embed (${N} samples,`,
      `        //   ${a.durationSec.toFixed(2)}s @ ${a.sampleRate}Hz, file=${JSON.stringify(a.name)})`,
      `        //   wire runtime sample loading manually if exporting; live preview`,
      `        //   loads via AudioWorklet postMessage [v2 — not yet implemented]`,
      `        ${node.id}.${methodSetSr}(${a.sampleRate.toFixed(1)}f);`
    ].join("\n");
  }
  // Embed up to ASSET_EMBED_LIMIT samples as a static constexpr float[].
  // Per-sample lit takes ~9 chars × N — ~2.3MB worst case at the limit;
  // reasonable for an exported header. Wrap in a brace-block scope so
  // multiple instances don't collide on the array name.
  const chunks = [];
  for (let i = 0; i < N; i += 8) {
    const slice = [];
    for (let j = 0; j < 8 && i + j < N; j++) {
      const v = arr[i + j];
      slice.push((isFinite(v) ? v : 0).toFixed(5) + "f");
    }
    chunks.push(slice.join(", "));
  }
  const arrName = `${node.id}_${channel === 1 ? "R" : "L"}`;
  const loadMeth = methodLoad;
  return [
    `        {`,
    `            static constexpr float ${arrName}[] = {`,
    `                ${chunks.join(",\n                ")}`,
    `            };`,
    `            ${node.id}.${methodSetSr}(${a.sampleRate.toFixed(1)}f);`,
    `            ${node.id}.${loadMeth}(${arrName}, ${N});`,
    `        }`
  ].join("\n");
}

/* Sidecar manifest — emitted alongside the .gpatch on save. JSON
 * listing the asset metadata for any sample-based node in the patch.
 * Audio data is NOT included (would inflate the file beyond reason);
 * the .wav files stay on the user's disk in their original location. */
function buildAssetManifest() {
  const used = new Set();
  state.nodes.forEach(n => {
    const id = n.params && n.params.assetId;
    if (id) used.add(id);
  });
  const out = { version: 1, assets: {} };
  used.forEach(id => {
    const a = _assets.get(id);
    if (!a) return;
    out.assets[id] = {
      name: a.name,
      sampleRate: a.sampleRate,
      channels: a.channels,
      durationSec: a.durationSec,
      lengthSamples: Array.isArray(a.data) ? a.data[0].length : a.data.length
    };
  });
  return out;
}

/* Hook into the existing btn-save click. We can't replace the listener
 * cleanly (it's attached above), so instead extend the save flow by
 * adding a second listener that also drops a sidecar. The original
 * downloads .gpatch as well — both files arrive in the user's
 * Downloads folder back-to-back. */
(function installSidecarSave() {
  const saveBtn = document.getElementById("btn-save");
  if (!saveBtn) return;
  saveBtn.addEventListener("click", () => {
    const manifest = buildAssetManifest();
    if (!Object.keys(manifest.assets).length) return;  // no samples → no sidecar
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (state.filename || "patch.gpatch").replace(/\.gpatch$/, "") + ".assets.json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
})();

// Hook into render() so adding/removing Button or Slider nodes refreshes
// the controls panel.
const _render_for_controls = render;
render = function () {
  _render_for_controls.apply(this, arguments);
  renderMonitorControls();
};

// Reveal piano (status flag) whenever a setPreviewStatus("playing") fires.
const _setPreviewStatus = setPreviewStatus;
setPreviewStatus = function(state, label) {
  _setPreviewStatus(state, label);
  if (state === "playing") showPiano();
  else if (state === "idle" || state === "error") resetPiano();
};

/* ------------- Smoke test ----------------------------------------------
 * Compiles a trivial 4-line C++ source (no Gamma) to verify the toolchain
 * works end-to-end. Useful when a real patch fails — tells you whether
 * the issue is with Gamma specifically or the entire SDK / clang path.
 * Output isn't loaded into the AudioWorklet; just shows wasm size +
 * timing in the status pill on success, or the actual error on failure. */
const SMOKE_TEST_SRC = `
__attribute__((export_name("smoke")))
extern "C" int smoke() { return 42; }
`;

const previewBtnSmoke = document.getElementById("btn-preview-smoke");
if (previewBtnSmoke) previewBtnSmoke.addEventListener("click", async () => {
  if (previewState.state === "compiling") return;
  setPreviewStatus("compiling", "smoke test compiling…");
  previewProgressStart();
  previewProgressStage("prepare");
  // Local-server fast path for smoke too.
  if (await probeLocalServer()) {
    const t0 = Date.now();
    try {
      previewProgressStage("compile");
      const { wasmBytes, stderr } = await compileViaLocalServer(SMOKE_TEST_SRC, true);
      const ms = Date.now() - t0;
      previewProgressFinish();
      setPreviewStatus("idle", "smoke ✓ via local-cli — " + wasmBytes.byteLength + " byte wasm in " + fmtDuration(ms));
      showCompileStderr(stderr || "", null);
    } catch (e) {
      previewProgressEnd(false);
      setPreviewStatus("error", "smoke (local-cli): " + e.message);
      showCompileStderr(e.stderr || "", e.message);
    }
    return;
  }
  try {
    await ensureCompileWorker();
  } catch (e) {
    previewProgressEnd(false);
    setPreviewStatus("error", "smoke worker init: " + e.message);
    return;
  }
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const onReply = (ev) => {
      const m = ev.data;
      if (m.type === "progress" && m.stage) {
        if (typeof m.subProgress === "number" && m.subProgress > 0) {
          const idx = PREVIEW_STAGES.findIndex(s => s.id === m.stage);
          if (idx === previewProgress.stageIdx) previewProgressSub(m.subProgress);
          else previewProgressStage(m.stage, m.subProgress);
        } else {
          previewProgressStage(m.stage);
        }
        const stage = PREVIEW_STAGES.find(s => s.id === m.stage);
        if (stage) setPreviewStatus("compiling", "smoke: " + stage.label);
      } else if (m.type === "compiled") {
        previewState.worker.removeEventListener("message", onReply);
        const ms = Date.now() - t0;
        const bytes = m.wasmBytes instanceof ArrayBuffer ? m.wasmBytes : m.wasmBytes.buffer;
        previewProgressFinish();
        setPreviewStatus("idle", `smoke ✓ — ${bytes.byteLength} byte wasm in ${fmtDuration(ms)}`);
        showCompileStderr(m.stderr || "", null);
        resolve();
      } else if (m.type === "compile-error") {
        previewState.worker.removeEventListener("message", onReply);
        previewProgressEnd(false);
        setPreviewStatus("error", "smoke: " + m.error);
        showCompileStderr(m.stderr || "", m.error);
        reject(new Error(m.error));
      }
    };
    previewState.worker.addEventListener("message", onReply);
    previewState.worker.postMessage({
      type: "compile",
      smokeTest: true,
      wrappedSrc: SMOKE_TEST_SRC,
      archiveUrl: new URL(PREVIEW.gammaArchiveUrl, location.href).toString(),
      sdkUrl: PREVIEW.wasmerSdkUrl
    });
  }).catch(() => { /* status already set */ });
});

/* ------------- Hot-reload trigger ------------- */
/* Hook into render() so any graph mutation kicks a debounced recompile
 * when preview is currently playing. */
const originalRender = render;
render = function() {
  originalRender.apply(this, arguments);
  if (previewState.state === "playing" || previewState.state === "compiling") {
    if (previewState.pendingCompile) clearTimeout(previewState.pendingCompile);
    previewState.pendingCompile = setTimeout(() => {
      previewState.pendingCompile = null;
      // Only recompile if the wrapped C++ actually changed.
      try {
        const cpp = generateCode();
        if (cpp.startsWith("// ❌")) return;
        const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
        const wrapped = wrapForPreview(cpp, className);
        if (wrapped === previewState.lastWrapped) return;
        previewCompileAndPlay();
      } catch (e) { /* swallow — codegen errors shown in main path */ }
    }, PREVIEW.hotReloadDebounceMs);
  }
  // Also refresh the Build pane if visible.
  const buildPane = document.getElementById("pane-build");
  if (buildPane && buildPane.style.display !== "none") renderBuildPane();
};

setPreviewStatus("idle", "idle");

/* (Community library tab removed; meter + keyboard now live in the
 * Monitor tab and use the existing app palette.) */

/* ------------- Panel sizing / collapse / maximize ------------- */
/* Side palette + bottom footer can be resized by dragging splitters,
 * collapsed (▾/›), maximized (footer only — fills viewport), or
 * popped out into a separate window (snapshot of active pane). All
 * preferences persist to localStorage so the layout survives reloads. */
const PANEL_PREFS_KEY = "gamma-editor-panel-prefs-v1";
const panelPrefs = (() => {
  try { return JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || "{}") || {}; }
  catch (_) { return {}; }
})();
function savePanelPrefs() {
  try { localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(panelPrefs)); } catch (_) {}
}

// Restore saved sizes / collapse state.
const paletteAside = document.getElementById("palette-aside");
const bottomFooter = document.getElementById("bottom-footer");
/* Restore the palette width from prefs. If the stored value is
 * below the drag minimum (180px) we ignore it and fall through to
 * the CSS default (248px) — that's the self-heal for users who
 * persisted a too-narrow value before the min was raised. The
 * dedicated collapsed state (32px + `.collapsed` class) is set
 * further down via the paletteCollapsed flag, not here. */
if (typeof panelPrefs.paletteW === "number" && panelPrefs.paletteW >= 180) {
  document.documentElement.style.setProperty("--palette-w", panelPrefs.paletteW + "px");
} else if (typeof panelPrefs.paletteW === "number" && panelPrefs.paletteW < 180) {
  // Auto-correct the stored value so future saves don't drift back
  panelPrefs.paletteW = 248;
  savePanelPrefs();
}
if (typeof panelPrefs.footerH === "number" && panelPrefs.footerH >= 38) {
  document.documentElement.style.setProperty("--footer-h", panelPrefs.footerH + "px");
}
if (panelPrefs.paletteCollapsed) {
  paletteAside.classList.add("collapsed");
  document.documentElement.style.setProperty("--palette-w", "32px");
}
if (panelPrefs.footerCollapsed) bottomFooter.classList.add("collapsed");

/* Drag to resize. Each splitter installs a pointerdown handler that
 * captures the pointer + tracks delta until pointerup. We update the
 * CSS variable live so the grid reflows in real time. */
function installResize(handle, opts) {
  let startVal = 0, startCoord = 0;
  const onMove = (ev) => {
    const delta = (ev[opts.coord] - startCoord) * (opts.invert ? -1 : 1);
    let next = startVal + delta;
    next = Math.max(opts.min, Math.min(opts.max(), next));
    document.documentElement.style.setProperty(opts.cssVar, next + "px");
    opts.last = next;
  };
  const onUp = (ev) => {
    handle.classList.remove("dragging");
    handle.releasePointerCapture(ev.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    if (typeof opts.last === "number") {
      panelPrefs[opts.prefKey] = opts.last;
      savePanelPrefs();
    }
  };
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    handle.classList.add("dragging");
    startCoord = ev[opts.coord];
    startVal = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(opts.cssVar)) || opts.fallback;
    handle.setPointerCapture(ev.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    ev.preventDefault();
  });
}
installResize(document.getElementById("palette-resize"), {
  coord: "clientX",
  cssVar: "--palette-w",
  fallback: 248,
  // Don't let the drag shrink the panel below where the content is
  // still useful. The dedicated collapsed state (32px) is reached
  // by clicking the ‹ button, not by dragging — a separate gesture
  // with its own CSS that hides the search/list/foot in favour of
  // the vertical "PALETTE ›" expand strip. Dragging to ~32px without
  // the .collapsed class left the panel in a half-broken in-between
  // where the scrollbar took most of the width and the resize
  // column itself became unfindable.
  min: 180,
  max: () => Math.min(window.innerWidth - 200, 600),
  prefKey: "paletteW"
});
installResize(document.getElementById("footer-resize"), {
  coord: "clientY",
  cssVar: "--footer-h",
  fallback: 240,
  min: 38,
  max: () => window.innerHeight - 80,
  prefKey: "footerH",
  invert: true       // dragging UP increases footer height
});

// Side-panel collapse toggle.
const btnPaletteMin = document.getElementById("btn-palette-min");
const paletteCollapseStrip = document.getElementById("palette-collapse-strip");
function setPaletteCollapsed(collapsed) {
  panelPrefs.paletteCollapsed = collapsed;
  if (collapsed) {
    paletteAside.classList.add("collapsed");
    panelPrefs.paletteWBeforeCollapse = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--palette-w")) || 248;
    document.documentElement.style.setProperty("--palette-w", "32px");
  } else {
    paletteAside.classList.remove("collapsed");
    const restoreW = panelPrefs.paletteWBeforeCollapse || 248;
    document.documentElement.style.setProperty("--palette-w", restoreW + "px");
    panelPrefs.paletteW = restoreW;
  }
  savePanelPrefs();
}
btnPaletteMin.addEventListener("click", () => setPaletteCollapsed(true));
paletteCollapseStrip.addEventListener("click", () => setPaletteCollapsed(false));

// Footer collapse / maximize / exit.
const btnFooterMin = document.getElementById("btn-footer-min");
const btnFooterMax = document.getElementById("btn-footer-max");
const btnFooterExit = document.getElementById("btn-footer-exit");

btnFooterMin.addEventListener("click", () => {
  const collapsed = bottomFooter.classList.toggle("collapsed");
  panelPrefs.footerCollapsed = collapsed;
  savePanelPrefs();
});
btnFooterMax.addEventListener("click", () => {
  bottomFooter.classList.add("maximized");
  bottomFooter.classList.remove("collapsed");
});
btnFooterExit.addEventListener("click", () => {
  bottomFooter.classList.remove("maximized");
});

// Esc exits maximize.
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && bottomFooter.classList.contains("maximized")) {
    bottomFooter.classList.remove("maximized");
  }
});

/* v0.2.23 — Standalone HTML loader. The Export → Standalone HTML
 * flow bakes the current patch into a fresh copy of this file as a
 * `<script type="application/json" id="gamma-embedded-patch">` tag.
 * On reopen, that tag's presence is the cue to replace the default
 * freshState() patch with the embedded one BEFORE the first render.
 * If the tag is absent (normal editor load) this is a no-op.
 *
 * Auto Live-Mode: an optional sidecar tag `gamma-embedded-config`
 * carries the export-time preferences. Today supports
 * { autoLiveMode: true } so the standalone opens fullscreen visuals
 * by default. Press L to toggle back to the editor either way. */
(function _maybeLoadEmbeddedPatch() {
  const tag = document.getElementById("gamma-embedded-patch");
  if (!tag) return;
  try {
    const loaded = JSON.parse(tag.textContent);
    if (!loaded || !loaded.nodes || !loaded.edges) {
      console.warn("[standalone] embedded patch missing nodes/edges; falling back to default");
      return;
    }
    const fname = loaded.filename ||
      ((loaded.patchName ? String(loaded.patchName) : "embedded") + ".gpatch");
    _applyLoadedPatch(loaded, fname);
    console.log("[standalone] embedded patch loaded: " + (loaded.patchName || "(unnamed)"));
  } catch (e) {
    console.warn("[standalone] embedded patch parse failed; using default:", e);
    return;
  }

  // v0.2.24 — decode embedded wasm. The Export → Standalone viewer
  // path bakes the compiled patch wasm as a base64 <script> block
  // so the page can run audio without a compile-server / Wasmer SDK.
  // Decoded once at boot, stashed both on previewState.lastWasm (so
  // the Audio render path can reuse it) and on window._gammaViewerWasm
  // (so the play button has a fresh untransferred copy to send).
  const wasmTag = document.getElementById("gamma-embedded-wasm");
  if (wasmTag) {
    try {
      const b64 = (wasmTag.textContent || "").trim();
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      previewState.lastWasm = arr.buffer;
      window._gammaViewerWasm = arr.buffer;
      console.log("[viewer] embedded wasm loaded (" + bin.length + " bytes)");
    } catch (e) {
      console.warn("[viewer] embedded wasm decode failed:", e);
    }
  }

  // Optional auto-Live-Mode + viewer mode after WebGPU has settled.
  const cfgTag = document.getElementById("gamma-embedded-config");
  if (cfgTag) {
    try {
      const cfg = JSON.parse(cfgTag.textContent);
      if (cfg && cfg.viewerMode) {
        document.body.classList.add("viewer-mode");
      }
      if (cfg && cfg.autoLiveMode) {
        // Delay so WebGPU + audio context init can settle.
        setTimeout(() => {
          if (typeof setLiveMode === "function") setLiveMode(true);
        }, 600);
      }
    } catch (e) {
      console.warn("[standalone] embedded config parse failed:", e);
    }
  }
})();

/* v0.2.24 — Standalone viewer: play the bundled wasm.
 *
 * Bypasses generateCode + Wasmer/local-server compile entirely.
 * Just creates / reuses the audio worklet and sends it a fresh
 * clone of window._gammaViewerWasm. Used by:
 *   - The big "▶ Play" disc in #live-mode-overlay (viewer mode)
 *   - Future "auto-play after user gesture" experiments
 *
 * Status flips body.viewer-playing so the play disc fades out via
 * the CSS rule body.viewer-mode.viewer-playing #btn-viewer-play
 * { display:none }. */
async function playEmbeddedWasm() {
  if (!window._gammaViewerWasm) {
    alert("No embedded wasm in this file. Save a standalone viewer from the Export menu first.");
    return;
  }
  try {
    const node = await ensureAudioWorklet();
    if (previewState.audioCtx && previewState.audioCtx.state === "suspended") {
      await previewState.audioCtx.resume();
    }
    // Clone before postMessage transfer (detaches the source buffer).
    const bytes = window._gammaViewerWasm.slice(0);
    previewState.lastWasm = bytes.slice(0);
    node.port.postMessage({ type: "load", wasmBytes: bytes }, [bytes]);
    document.body.classList.add("viewer-playing");
    setPreviewStatus("playing", "playing (viewer)");
  } catch (e) {
    console.warn("[viewer] play failed:", e);
    alert("Could not start playback: " + (e && e.message || e));
  }
}

/* Wire the viewer play button. Outside viewer mode the button is
 * display:none via CSS and click never fires. */
(function _wireViewerPlay() {
  const btn = document.getElementById("btn-viewer-play");
  if (btn) btn.addEventListener("click", () => playEmbeddedWasm());
})();

// _applyLoadedPatch already calls render() when it succeeds. Calling
// render() unconditionally below would be redundant in the embedded
// case but is needed for the default (no-embedded-patch) load. The
// extra call is cheap (DOM diff already done) so we keep it for the
// simpler control flow.
render();

/* Phase 6.1.2 — kick off WebGPU device acquisition. Lazy enough that
 * it doesn't block first paint (the editor is fully usable for audio
 * before this resolves), but eager enough that the GPU pill in the
 * header settles to its final state (ready / unavailable / error)
 * within ~50 ms of page load on a typical machine. WebGPU is
 * permissionless — no consent dialog, no risk of surprising the user
 * mid-session — so calling it at startup is safe. */
ensureGPUDevice();

/* Live Mode wiring — toolbar button, in-mode exit button, and the L
 * hotkey. The hotkey runs on the existing window keydown handler
 * registered higher up; we add a second listener here that's gated on
 * !isTextInput so typing 'l' in a CodeMirror or properties field
 * doesn't trip live-mode. Escape inside live-mode also exits (safety
 * fallback; doesn't conflict with modal-close because no modal can be
 * open while #app is display:none). */
{
  const liveBtn  = document.getElementById("btn-live-mode");
  const liveExit = document.getElementById("btn-live-exit");
  if (liveBtn)  liveBtn.addEventListener("click",  () => toggleLiveMode());
  if (liveExit) liveExit.addEventListener("click", () => setLiveMode(false));
  window.addEventListener("keydown", (e) => {
    // Live-mode hotkey: Ctrl+L (or Cmd+L on Mac). Bare L is reserved
    // for FPCamera look-right + the QWERTY musical keyboard (D5),
    // so the toggle moved to the modifier form in v0.3.135 -- avoids
    // accidental live-mode flips while walking the Walkable Terrain
    // demo. Alt left untouched (it's a modifier for other shortcuts).
    if (e.altKey) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) {
      if (!isLiveMode() && isTextInput(document.activeElement)) return;
      // Browser may also map Ctrl+L to address-bar focus; preventDefault
      // claims the chord for the editor.
      e.preventDefault();
      toggleLiveMode();
      return;
    }
    if (e.key === "Escape" && isLiveMode()) {
      e.preventDefault();
      setLiveMode(false);
    }
  });
}

/* Phase 6.7.1 + 6.7.2 + 6.7.3 — wire the three visual-HUD pills:
 *   ⊟ / ▣  → hide-graph toggle (also bare H hotkey)
 *   📷    → capture frame to PNG
 *   ●     → start/stop video capture (.webm)
 * Hotkey guards mirror the Live-Mode L pattern: skip modifier-chord,
 * skip text-input typing, skip when audio preview is playing (H is
 * MIDI A4 on the QWERTY keymap). */
{
  const hidePill   = document.getElementById("graph-hide-pill");
  const snapBtn    = document.getElementById("snap-btn");
  const recPill    = document.getElementById("video-rec-pill");
  if (hidePill) hidePill.addEventListener("click", () => toggleGraphHidden());
  if (snapBtn)  snapBtn.addEventListener("click",  () => captureVisualFrame());
  if (recPill)  recPill.addEventListener("click",  () => captureVideoToggle());
  // Phase 6.7.4 -- perf overlay pill + Shift+P hotkey.
  const perfPill = document.getElementById("perf-pill");
  if (perfPill) perfPill.addEventListener("click", () => togglePerfOverlay());
  // Initialize the rec pill title (the "stop" state) so screen readers
  // pick it up before the first click.
  _updateVideoUi(false);
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTextInput(document.activeElement)) return;
    // Phase 6.7.4 -- Shift+P toggles perf overlay. (Bare P is QWERTY
    // MIDI G#4 -- audio runtime wins like the H rule below.)
    if (e.shiftKey && (e.key === "P" || e.key === "p")) {
      e.preventDefault();
      togglePerfOverlay();
      return;
    }
    if (e.shiftKey) return;          // any other shift-chord is not ours
    if (e.key !== "h" && e.key !== "H") return;
    // Audio runtime wins: H plays MIDI A4 when the preview is running.
    if (typeof previewState !== "undefined" && previewState && previewState.state === "playing") return;
    e.preventDefault();
    toggleGraphHidden();
  });
}

/* v0.2.19 — Export center wiring. Toolbar Export button opens the
 * modal; each action proxies to the right capture/export function.
 * Patch / MPCDI / auto-capture actions defer to the EXISTING button
 * handlers (click on the hidden buttons) so the underlying behavior
 * stays in one place even though the surface UI now lives in two
 * places (Export menu + rig editor panel). */
{
  const openBtn  = document.getElementById("btn-export-open");
  const closeBtn = document.getElementById("btn-export-close");
  const modal    = document.getElementById("export-modal");
  if (openBtn)  openBtn.addEventListener("click",  _openExportModal);
  if (closeBtn) closeBtn.addEventListener("click", _closeExportModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) _closeExportModal();
    });
  }
  // Escape closes when modal is open + no other modal is intercepting.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modal && modal.style.display !== "none" && modal.style.display !== "") {
      _closeExportModal();
    }
  });

  // -- Patch --
  const savePatchBtn = document.getElementById("exp-save-gpatch");
  if (savePatchBtn) {
    savePatchBtn.addEventListener("click", () => {
      const realBtn = document.getElementById("btn-save");
      if (realBtn) realBtn.click();
      _setExportStatus("Saved .gpatch", "success");
    });
  }
  const standaloneBtn = document.getElementById("exp-standalone-html");
  if (standaloneBtn) {
    standaloneBtn.addEventListener("click", async () => {
      standaloneBtn.disabled = true;
      const nameEl = standaloneBtn.querySelector(".export-action-name");
      const orig = nameEl ? nameEl.textContent : null;
      try {
        if (nameEl) nameEl.textContent = "Building standalone HTML…";
        _setExportStatus("Fetching editor HTML + bundling patch…");
        const liveBox   = document.getElementById("exp-standalone-livemode");
        const viewerBox = document.getElementById("exp-standalone-viewer");
        const autoLiveMode = !!(liveBox && liveBox.checked);
        const viewerMode   = !!(viewerBox && viewerBox.checked);
        // Forward compile-progress to the modal status line so the
        // user sees what's happening during the (potentially long)
        // first-time compile from a freshly-loaded patch.
        const progress = (msg) => _setExportStatus(msg);
        const out = await exportStandaloneHtml({ autoLiveMode, viewerMode, progress });
        _downloadBlob(new Blob([out.html], { type: "text/html" }), out.filename);
        const mb = (out.size / (1024 * 1024)).toFixed(2);
        const wasmLine = out.viewerMode && out.wasmKb
          ? " · " + out.wasmKb.toFixed(0) + " KB wasm bundled"
          : "";
        _setExportStatus("Saved " + out.filename + " (" + mb + " MB" + wasmLine + ")", "success");
      } catch (e) {
        console.warn("[export] standalone HTML failed:", e);
        _setExportStatus("Standalone export failed: " + (e && e.message || e), "error");
      } finally {
        standaloneBtn.disabled = false;
        if (nameEl && orig) nameEl.textContent = orig;
      }
    });
  }
  const saveHeaderBtn = document.getElementById("exp-save-header");
  if (saveHeaderBtn) {
    saveHeaderBtn.addEventListener("click", () => {
      try {
        const cpp = generateCode();
        const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
        const filename  = className + ".h";
        const blob = new Blob([cpp], { type: "text/x-c++hdr" });
        _downloadBlob(blob, filename);
        if (cpp.startsWith("// ❌")) {
          _setExportStatus("Saved " + filename + " — but contains a codegen error (see top comment)", "error");
        } else {
          _setExportStatus("Saved " + filename + " (" + cpp.length + " chars)", "success");
        }
      } catch (e) {
        console.warn("[export] header save failed:", e);
        _setExportStatus("Header save failed: " + (e && e.message || e), "error");
      }
    });
  }

  // -- Visual: composite PNG (mirrors HUD 📷 pill) --
  const compSnapBtn = document.getElementById("exp-snap-composite");
  if (compSnapBtn) {
    compSnapBtn.addEventListener("click", async () => {
      _setExportStatus("Capturing composite…");
      try {
        await captureVisualFrame();
        _setExportStatus("Composite preview saved", "success");
      } catch (e) {
        _setExportStatus("Composite capture failed: " + (e && e.message || e), "error");
      }
    });
  }

  // -- Visual: single display PNG at target resolution --
  const dispSnapBtn = document.getElementById("exp-snap-display");
  const dispSel     = document.getElementById("exp-display-pick");
  if (dispSnapBtn && dispSel) {
    dispSnapBtn.addEventListener("click", async () => {
      const idx = parseInt(dispSel.value, 10);
      if (!Number.isInteger(idx) || idx < 0) {
        _setExportStatus("Pick a display first", "error");
        return;
      }
      dispSnapBtn.disabled = true;
      const orig = dispSnapBtn.textContent;
      dispSnapBtn.textContent = "…";
      _setExportStatus("Reading display " + idx + " at " + Visual.fbWidth + "×" + Visual.fbHeight + "…");
      try {
        const blob = await capturePerDisplayPng(idx);
        const disp = state && state.rig && state.rig.displays && state.rig.displays[idx];
        const idStr = disp && disp.id ? String(disp.id) : ("d" + idx);
        const safeId = idStr.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        _downloadBlob(blob, "gamma-display-" + String(idx).padStart(2, "0") + "-" + safeId + "-" + stamp + ".png");
        _setExportStatus("Display " + idx + " saved (" + Visual.fbWidth + "×" + Visual.fbHeight + ")", "success");
      } catch (e) {
        console.warn("[export] per-display capture failed:", e);
        _setExportStatus("Per-display capture failed: " + (e && e.message || e), "error");
      } finally {
        dispSnapBtn.disabled = false;
        dispSnapBtn.textContent = orig;
      }
    });
  }

  // -- Visual: all displays ZIP --
  const allDispBtn = document.getElementById("exp-snap-all-displays");
  if (allDispBtn) {
    allDispBtn.addEventListener("click", async () => {
      allDispBtn.disabled = true;
      const orig = allDispBtn.querySelector(".export-action-name").textContent;
      try {
        const N = (Visual.framebufferLayerViews && Visual.framebufferLayerViews.length) || 0;
        if (N === 0) { _setExportStatus("No rig displays to capture", "error"); return; }
        _setExportStatus("Capturing display 0/" + N + "…");
        const blob = await captureAllDisplaysZip((cur, total) => {
          _setExportStatus("Capturing display " + cur + "/" + total + "…");
          const nameEl = allDispBtn.querySelector(".export-action-name");
          if (nameEl) nameEl.textContent = "Capturing… " + cur + "/" + total;
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        _downloadBlob(blob, "gamma-displays-" + stamp + ".zip");
        _setExportStatus(N + " displays saved as ZIP (each at " + Visual.fbWidth + "×" + Visual.fbHeight + ")", "success");
      } catch (e) {
        console.warn("[export] all-displays ZIP failed:", e);
        _setExportStatus("All-displays ZIP failed: " + (e && e.message || e), "error");
      } finally {
        allDispBtn.disabled = false;
        const nameEl = allDispBtn.querySelector(".export-action-name");
        if (nameEl) nameEl.textContent = orig;
      }
    });
  }

  // -- Visual: composite video (mirrors HUD ● pill) --
  const recBtn = document.getElementById("exp-rec-composite");
  if (recBtn) {
    recBtn.addEventListener("click", () => {
      captureVideoToggle();
      const tag = document.getElementById("exp-rec-state-tag");
      if (tag) tag.style.display = _videoRecorder ? "inline-block" : "none";
      _setExportStatus(_videoRecorder ? "Recording started — click again to stop" : "Recording stopped + downloaded", "success");
    });
  }



  // -- Visual: per-display recording (toggle, bundles into ZIP) --
  const pdRecBtn = document.getElementById("exp-rec-perdisplay");
  if (pdRecBtn) {
    pdRecBtn.addEventListener("click", async () => {
      pdRecBtn.disabled = true;
      try {
        if (perDisplayRecordingActive()) {
          _setExportStatus("Stopping per-display recording + bundling…");
          await _stopPerDisplayRecordingAndDownload();
          _setExportStatus("Per-display ZIP downloaded", "success");
        } else {
          const N = (Visual.framebufferLayerViews && Visual.framebufferLayerViews.length) || 0;
          if (N === 0) { _setExportStatus("No rig displays to record", "error"); return; }
          _setExportStatus("Starting " + N + " parallel MediaRecorders at " + Visual.fbWidth + "×" + Visual.fbHeight + "…");
          await _startPerDisplayRecording();
          _setExportStatus("Recording " + N + " displays — click again to stop", "success");
        }
      } catch (e) {
        console.warn("[export] per-display recording toggle failed:", e);
        _setExportStatus("Per-display recording failed: " + (e && e.message || e), "error");
      } finally {
        pdRecBtn.disabled = false;
      }
    });
  }

  // -- Audio render → WAV/MP3 (offline) — format selected via dropdown --
  const audioBtn  = document.getElementById("exp-audio-render");
  const audioFmt  = document.getElementById("exp-audio-format");
  if (audioBtn) {
    audioBtn.addEventListener("click", async () => {
      const fmt = (audioFmt && audioFmt.value) || "wav16";
      const fmtLabels = {
        wav16:  { ext: "wav", label: "WAV 16-bit PCM",   bitDepth: 16 },
        wav24:  { ext: "wav", label: "WAV 24-bit PCM",   bitDepth: 24 },
        wav32f: { ext: "wav", label: "WAV 32-bit float", bitDepth: 32 },
        mp3:    { ext: "mp3", label: "MP3 320 kbps",     bitrate: 320 }
      };
      const info = fmtLabels[fmt] || fmtLabels.wav16;
      const defaultDuration = 30;
      const answer = window.prompt("Render duration in seconds (1–3600):", String(defaultDuration));
      if (answer == null) return;   // user cancelled
      const duration = Math.max(1, Math.min(3600, parseFloat(answer) || defaultDuration));
      audioBtn.disabled = true;
      const orig = audioBtn.textContent;
      audioBtn.textContent = "…";
      try {
        _setExportStatus("Rendering " + duration + " s through OfflineAudioContext…");
        const audioBuf = await renderOfflineAudio(duration);
        let blob;
        if (fmt === "mp3") {
          _setExportStatus("Loading lamejs + encoding MP3…");
          blob = await audioBufferToMp3Blob(audioBuf, info.bitrate);
        } else {
          _setExportStatus("Encoding " + info.label + "…");
          blob = audioBufferToWavBlob(audioBuf, info.bitDepth);
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const className = ((state && state.patchName) || "MyPatch").replace(/[^A-Za-z0-9_]/g, "") || "MyPatch";
        const tag = fmt === "wav16"  ? "16bit"
                  : fmt === "wav24"  ? "24bit"
                  : fmt === "wav32f" ? "32bitf"
                  : "320k";
        _downloadBlob(blob, "gamma-render-" + className + "-" + tag + "-" + stamp + "." + info.ext);
        _setExportStatus("Saved " + info.label + " (" + duration + " s × " +
          audioBuf.numberOfChannels + "ch × " + audioBuf.sampleRate + " Hz, " +
          (blob.size / (1024 * 1024)).toFixed(1) + " MB)", "success");
      } catch (e) {
        console.warn("[export] audio render failed:", e);
        _setExportStatus(info.label + " render failed: " + (e && e.message || e), "error");
      } finally {
        audioBtn.disabled = false;
        audioBtn.textContent = orig;
      }
    });
  }

  // -- Timed composite A/V recording (auto-stops after N seconds) --
  const timedRecBtn = document.getElementById("exp-rec-composite-timed");
  if (timedRecBtn) {
    timedRecBtn.addEventListener("click", async () => {
      if (_videoRecorder) {
        _setExportStatus("Composite recording already running — stop it first", "error");
        return;
      }
      const answer = window.prompt("Duration in seconds (1–3600):", "30");
      if (answer == null) return;
      const duration = Math.max(1, Math.min(3600, parseFloat(answer) || 30));
      try {
        await startTimedAVRecording(duration);
        _setExportStatus("Recording " + duration + " s — will auto-stop + download", "success");
      } catch (e) {
        console.warn("[export] timed A/V record failed:", e);
        _setExportStatus("Timed recording failed: " + (e && e.message || e), "error");
      }
    });
  }

  // -- Rig: MPCDI + auto-capture (defer to the underlying buttons) --
  const mpcdiBtn = document.getElementById("exp-mpcdi");
  if (mpcdiBtn) {
    mpcdiBtn.addEventListener("click", () => {
      const realBtn = document.getElementById("btn-rig-mpcdi-export");
      if (realBtn) {
        realBtn.click();
        _setExportStatus("MPCDI bundle exported", "success");
      } else {
        _setExportStatus("MPCDI export action not available — open the Rig editor first", "error");
      }
    });
  }
  const autoCapBtn = document.getElementById("exp-auto-cap");
  if (autoCapBtn) {
    autoCapBtn.addEventListener("click", () => {
      const realBtn = document.getElementById("btn-rig-auto-capture");
      if (realBtn) {
        _closeExportModal();   // walk is long-running + uses theater preview; menu would obscure it
        realBtn.click();
      } else {
        _setExportStatus("Auto-capture action not available — open the Rig editor first", "error");
      }
    });
  }
}

/* Phase 6.1.5 — Visual HUD wiring. Resolution pill cycles on click,
 * freeze button toggles. fps readout is driven from the future rAF
 * loop (6.1.7+); for now it stays at "— fps" placeholder. Initial
 * pill text reflects the default resolution captured at Visual init. */
{
  const resPill   = document.getElementById("res-pill");
  const projPill  = document.getElementById("proj-pill");
  const freezeBtn = document.getElementById("freeze-btn");
  if (resPill) {
    _updateResolutionPill();
    resPill.addEventListener("click", _cycleRenderResolution);
  }
  // Sprint 7.5.3a -- MSAA pill cycles 1x -> 4x -> 8x.
  const msaaPill = document.getElementById("msaa-pill");
  if (msaaPill) {
    _updateMsaaPill();
    msaaPill.addEventListener("click", cycleMsaa);
  }
  if (projPill) {
    _updateProjectionPill();
    projPill.addEventListener("click", _cycleProjectionMode);
  }
  if (freezeBtn) {
    freezeBtn.addEventListener("click", toggleVisualFreeze);
  }
  // Phase 6.5.16 — gizmo toggle pill. Wires the canvas's orbit/zoom
  // handlers on first open. The gizmo is just an inset canvas now —
  // there's no separate close button (toggle the pill to dismiss).
  const gizmoPill = document.getElementById("gizmo-pill");
  if (gizmoPill) {
    gizmoPill.addEventListener("click", () => {
      toggleRigGizmo();
      if (_gizmoOpen) _wireGizmoCanvas();
    });
  }
}

// §planet-spec Phase 7.f-ai -- offline prompt-tester export hook.
// tools/pmap-prompt-tester.html loads this file in a hidden iframe
// and pulls these handles to drive the planet-map AI pipeline
// without spinning up the full painter. Exposes the building blocks:
//   .buildCells(N, noiseDef, jitter) -> cells
//   .buildHash(cells), .buildNeighbors(cells, hash, K) -> neighbors
//   .parsePlan(rawText) -> { caps: [...] }
//   .applyPlan(plan, cells, neighbors, K, seaLevel, lockedCenter)
//   .measureLandmass(cells, seaLevel) -> { landCells, totalCells, landFraction }
//   .loadReference(refKey) -> Promise<base64 png>
//   .colorForHeight(h, seaLevel) -> [r,g,b] (0..1)
//   .references, .presets, .keywords -> data tables
//   .systemPrompt, .auditPrompt -> string defaults
//   .providers -> the PROVIDERS map (call providers.anthropic.call(...))
//   .getAiSettings() -> live { provider, model, anthropicKey } from editor
// All references are LIVE handles -- editing the editor reflects here
// on next call. The tester treats prompts as DRAFT TEXT (editable in
// the UI) starting from the systemPrompt / auditPrompt defaults.
window.__PMAP = {
  buildCells: _buildFibonacciCells,
  buildHash: _buildCellSpatialHash,
  buildNeighbors: _buildCellNeighbors,
  applyPlan: _applyAIPlan,
  stampGeoJSON: _planetStampGeoJSON,
  stampAzgaarJSON: _planetStampAzgaarJSON,
  stampLandmass: _planetStampLandmass,
  measureLandmass: _planetMeasureLandmass,
  colorForHeight: _planetColorForHeight,
};

// Sprint 8.0.3-a -- TerrainCollider scripting / harness surface.
// heightAt(wx, wz)        -- world Y at flat-XZ point; auto-source
// radialAt(dx, dy, dz)    -- planet surface radius along direction
//                            (planet sources only)
// Foliage / character controllers / future Rapier physics bridge
// consume these; 10-5d ground scatter is the first user.
window.__COLLIDER = {
  heightAt: function (wx, wz) { return _terrainColliderHeightAt(wx, wz); },
  radialAt: function (dx, dy, dz) { return _terrainColliderRadialAt(dx, dy, dz); }
};

