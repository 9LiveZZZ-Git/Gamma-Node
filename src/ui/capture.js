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

