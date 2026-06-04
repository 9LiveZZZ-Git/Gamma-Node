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

