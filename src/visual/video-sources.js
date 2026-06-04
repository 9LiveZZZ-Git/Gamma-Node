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
