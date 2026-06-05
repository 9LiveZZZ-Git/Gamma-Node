/* Phase 6.6.30 + v0.2.16 — render one plan entry. Handles BOTH the
 * scratch case (writes to scratchLayerViewsA/B[layerIdx] -- relative
 * index 0..SCRATCH_BUDGET-1, used by composition reads in the same
 * frame) AND the direct VO case (writes to
 * Visual.framebufferLayerViews[layerIdx] -- absolute display layer).
 *
 * v0.2.16 ping-pong: writeKey picks the scratch texture this pass
 * writes to; readKey picks the scratch texture the bind group reads
 * from. Always opposite parities so WebGPU never sees the same
 * texture in both bindings within one pass. Instance key includes
 * readKey so composition instances are cached per scratch-view they
 * bind (instead of one shared bind group that could be stale).
 *
 * Per-consumer instance key prevents collision between the same
 * source feeding multiple consumer VOs (each has its own uniform
 * buffer + pose). The writeUniforms-resolved scratch indices are
 * RELATIVE so the WGSL sample with those indices reads the right
 * scratch layer in the bound parity. */
function _encodeShaderFragPassForPlan(enc, entry, dtSec) {
  const { node, def, layerIdx, consumerVO, isScratch, readKey, writeKey } = entry;
  let layerView;
  if (isScratch) {
    const views = (writeKey === "a") ? Visual.scratchLayerViewsA : Visual.scratchLayerViewsB;
    layerView = views[layerIdx];
  } else {
    layerView = Visual.framebufferLayerViews[layerIdx];
  }
  if (!layerView) return false;

  // Sprint 7.5.3a -- Scene render path. Beats the rest of the function
  // by handing off to _encodeScenePass which has its own pipeline,
  // depth attachment, and per-mesh draw loop.
  if (def.kind === "scene") {
    return _encodeScenePass(enc, entry);
  }
  // Sprint 7.5.6.a part 2d -- RayTracedScene render path. The actual
  // rendering happens in the native gamma-rt-engine; the editor just
  // receives H.264 / RGBA frames over WebSocket + blits the latest
  // one to the assigned framebuffer/scratch layer.
  if (def.kind === "scene-rt") {
    return _encodeRtScenePass(enc, entry);
  }

  // Phase C sprint tektite-5c1 -- tektite-graph branch: copy the
  // node's per-frame 2D canvas (drawn by tickTektiteGraphTextures in
  // src/tektite/graph-texture.js) directly into the assigned
  // framebuffer / scratch layer. Same model as ai-vision-canvas --
  // bypass the shader pipeline and queue a copyExternalImageToTexture.
  // The canvas dimensions are sized to match Visual.fbWidth/fbHeight
  // by the tick so the copy lands cleanly.
  if (def.kind === "tektite-graph") {
    if (typeof _tektiteGraphTexState === "undefined") return false;
    const st = _tektiteGraphTexState.get(node.id);
    if (!st || !st.canvas) return false;
    const targetTex = entry.isScratch
      ? (entry.writeKey === "a" ? Visual.scratchTextureA : Visual.scratchTextureB)
      : Visual.framebuffer;
    if (!targetTex) return false;
    try {
      Visual.device.queue.copyExternalImageToTexture(
        { source: st.canvas, flipY: false },
        { texture: targetTex, origin: { x: 0, y: 0, z: entry.layerIdx } },
        [st.texW, st.texH, 1]
      );
    } catch (e) {
      // Fallback for browsers where the OffscreenCanvas direct upload
      // chokes -- transfer to an ImageBitmap then copy.
      try {
        const bm = st.canvas.transferToImageBitmap
          ? st.canvas.transferToImageBitmap()
          : null;
        if (bm) {
          Visual.device.queue.copyExternalImageToTexture(
            { source: bm },
            { texture: targetTex, origin: { x: 0, y: 0, z: entry.layerIdx } },
            [st.texW, st.texH, 1]
          );
        }
      } catch (e2) { return false; }
    }
    return true;
  }

  // v0.3.3 — ai-vision-canvas branch: bypass the shader pipeline
  // entirely. The MediaPipe detection loop drew video + landmark
  // overlay into entry.drawCanvas; queue a direct
  // copyExternalImageToTexture into the assigned framebuffer / scratch
  // layer. queue.copy* runs in submission order alongside encoder
  // commands, so downstream composition passes in the same submit see
  // the freshly-copied pixels.
  if (def.kind === "ai-vision-canvas") {
    const e = _mediapipeNodes.get(node.id);
    if (!e) {
      // Dispatch by node type to the right init helper.
      if (node.type === "PoseLandmarker")      _ensurePoseLandmarker(node.id, node.params || {});
      else if (node.type === "FaceLandmarker") _ensureFaceLandmarker(node.id, node.params || {});
      else if (node.type === "HandKeyboard")   _ensureHandKeyboard(node.id, node.params || {});
      else if (node.type === "BlobTracker")    _ensureBlobTracker(node.id, node.params || {});
      else                                     _ensureHandLandmarker(node.id, node.params || {});
      return false;
    }
    if (!e.ready || !e.drawCanvas) return false;

    // v0.3.12 — texture-source path. If the landmark's "video" input
    // is wired to a non-video shader-frag (Plasma / Butterflies /
    // BlendShader / Gradient), the upstream node renders to a GPU
    // layer (assigned by the plan walker). Blit that layer into
    // entry.gpuInputCanvas so both MediaPipe + the bgMode=1 drawCanvas
    // composite can read its content. The blit lands in the same
    // command encoder as the rest of the visual frame, so timing is
    // implicit (upstream's render pass appears earlier in the
    // schedule and finishes before this blit runs).
    if (e.useTextureSource && e.upstreamNodeId && e.gpuInputCtx) {
      const planMap = Visual._currentRenderPlan;
      const srcEntry = planMap && planMap.get(e.upstreamNodeId + "@" + consumerVO.id);
      if (srcEntry) {
        let srcView = null;
        if (srcEntry.isScratch) {
          const views = srcEntry.writeKey === "a"
            ? Visual.scratchLayerViewsA : Visual.scratchLayerViewsB;
          srcView = views[srcEntry.layerIdx];
        } else {
          srcView = Visual.framebufferLayerViews[srcEntry.layerIdx];
        }
        if (srcView) {
          // (Re)build the bind group when the source view changes
          // (e.g. resolution change reallocated the framebuffer, or
          // the plan ping-pong'd the source to a different scratch
          // parity).
          if (!e.gpuInputBindGroup || e._gpuInputSrcView !== srcView) {
            try {
              e.gpuInputBindGroup = Visual.device.createBindGroup({
                label: "ai-vision-input-bg-" + node.id,
                layout: Visual.blitBindGroupLayout,
                entries: [
                  { binding: 0, resource: srcView },
                  { binding: 1, resource: Visual.blitSampler }
                ]
              });
              e._gpuInputSrcView = srcView;
            } catch (err) {
              e.gpuInputBindGroup = null;
            }
          }
          if (e.gpuInputBindGroup) {
            let canvasView = null;
            try { canvasView = e.gpuInputCtx.getCurrentTexture().createView(); }
            catch (_) { canvasView = null; }
            if (canvasView) {
              const pass = enc.beginRenderPass({
                label: "ai-vision-input-blit-" + node.id,
                colorAttachments: [{
                  view: canvasView,
                  clearValue: { r: 0, g: 0, b: 0, a: 1 },
                  loadOp: "clear",
                  storeOp: "store"
                }]
              });
              pass.setPipeline(Visual.blitPipeline);
              pass.setBindGroup(0, e.gpuInputBindGroup);
              pass.draw(3);
              pass.end();
            }
          }
        }
      }
    }

    const destTexture = isScratch
      ? (writeKey === "a" ? Visual.scratchTextureA : Visual.scratchTextureB)
      : Visual.framebuffer;
    const cw = Math.min(e.drawCanvas.width  || 0, Visual.fbWidth);
    const ch = Math.min(e.drawCanvas.height || 0, Visual.fbHeight);
    if (cw === 0 || ch === 0) return false;
    try {
      Visual.device.queue.copyExternalImageToTexture(
        { source: e.drawCanvas, flipY: false },
        { texture: destTexture, origin: { x: 0, y: 0, z: layerIdx } },
        [cw, ch, 1]
      );
    } catch (err) {
      // Canvas not yet drawable (first frame race, etc). Silent skip.
      return false;
    }
    return true;
  }

  // Instance key — direct entries use the consumer VO id (one
  // shader instance per VO target, matching the pre-6.6.30 form).
  // Scratch entries use a "scratch:" prefix so a node that's BOTH
  // direct-wired AND used as a composition input has two separate
  // instances (different bind layouts, different uniforms).
  //
  // v0.2.16 — composition bind layout needs distinct instances per
  // readKey parity so each instance's bind group references the
  // matching scratchArrayView. Append :rk-<a|b> when this node is a
  // composition shader (its bind group binds a scratch texture).
  const isComp = def.bindLayout === "composition";
  let instKey = isScratch
    ? "scratch:" + node.id + ":" + consumerVO.id
    : consumerVO.id;
  if (isComp) instKey += ":rk-" + readKey;
  // Phase 6.6.28 — wire-resolved params for the dynamic WGSL fn too.
  const nodeResolvedForInst = _nodeWithResolvedParams(node);
  const inst = _ensureShaderInstance(instKey, def, nodeResolvedForInst, readKey);
  if (!inst) return false;
  const pipeEntry = inst.pipelineEntry;
  if (!pipeEntry || !pipeEntry.pipeline) return false;

  // Pose: consumer VO's display drives u_view for BOTH scratch and
  // direct passes. Scratch passes render the source FROM the
  // consumer's perspective; direct passes write the consumer's
  // display layer with the consumer's pose.
  const consumerDisp = (consumerVO.params && typeof consumerVO.params.display === "number")
    ? (consumerVO.params.display | 0) : 0;
  const display = state.rig && state.rig.displays && state.rig.displays[consumerDisp];
  const renderWuv = _renderWorldUvForVO(consumerVO, node.id);

  // u_layer in the uniform = consumer's display layer (used by
  // FeedbackShader to know which feedback layer to sample as
  // "previous frame of THIS display"). Scratch entries also use the
  // consumer's display layer here, not the scratch slot.
  _writeShaderPreamble(inst.scratch, dtSec, display, renderWuv, consumerDisp);
  if (typeof def.writeUniforms === "function") {
    def.writeUniforms(nodeResolvedForInst, inst.scratch);
  }
  const slotMap = def.textureInputSlots;
  if (slotMap && Array.isArray(def.ins)) {
    for (const port of def.ins) {
      if (!port || port.t !== "texture") continue;
      const slot = slotMap[port.n];
      if (typeof slot !== "number") continue;
      const resolved = _resolveTextureInputLayer(node, port.n, consumerVO.id);
      if (resolved >= 0) inst.scratch[slot] = resolved;
    }
  }
  Visual.device.queue.writeBuffer(inst.uniformBuffer, 0, inst.scratch.buffer, inst.scratch.byteOffset, inst.scratch.byteLength);

  // Phase 7.1 — video-source bind group is rebuilt per frame because
  // GPUExternalTexture is single-task-scoped. The source's <video>
  // element must already have a frame ready (readyState >= 2); if
  // not, kick off the getUserMedia request (idempotent) and skip the
  // frame -- framebuffer layer keeps its prior content, recipient
  // composition shaders see the previous frame.
  //
  // Multi-display distribution (v0.3.1): this function runs once per
  // (source × consumerVO) pair (e.g. 26x for a Webcam wired to an
  // AlloSphere rig). Each VO gets its own instance + uniform buffer +
  // bind group, so the per-display pose / world_uv preamble lands
  // correctly. But device.importExternalTexture would also fire 26x
  // per frame for the SAME source video frame -- redundant. We cache
  // the imported handle in Visual._frameVideoTextures (cleared each
  // renderVisualFrame) so the first pass imports + populates the
  // cache, and the other N-1 passes reuse the same handle. The bind
  // group itself still has to be per-VO (different uniform buffer
  // per VO instance) but the external texture handle is shared.
  let bindGroupForPass = inst.bindGroup;
  if (def.bindLayout === "video-source") {
    const src = _videoSources.get(node.id);
    if (!src) {
      // v0.3.11 — dispatch by node type: VideoFile loads from a URL,
      // Webcam (default) opens getUserMedia.
      // v0.3.22 — ScreenShare is gesture-gated; we DON'T auto-init
      // it here (browsers reject getDisplayMedia() outside a user
      // gesture frame). The node renders nothing until the user
      // clicks "Pick screen / window / tab…" in the props pane.
      if (node.type === "VideoFile")       _ensureVideoFile(node.id, node.params || {});
      else if (node.type === "ScreenShare") { /* deferred to user gesture */ }
      else                                  _ensureWebcamStream(node.id);
      return false;
    }
    // v0.3.11 — if the source's params changed (e.g. VideoFile fileUrl
    // edited), re-init so the new URL takes effect.
    if (node.type === "VideoFile" && src.fileUrl !== (node.params && node.params.fileUrl)) {
      _ensureVideoFile(node.id, node.params || {});
      return false;
    }
    if (!src.ready || !src.videoEl || src.videoEl.readyState < 2) return false;
    if (!Visual._frameVideoTextures) Visual._frameVideoTextures = new Map();
    let extTex = Visual._frameVideoTextures.get(node.id);
    if (!extTex) {
      try {
        extTex = Visual.device.importExternalTexture({ source: src.videoEl });
      } catch (e) {
        // importExternalTexture can throw if the video frame isn't
        // ready yet despite readyState >= 2 (race during the very
        // first few frames). Skip silently, retry next tick.
        return false;
      }
      Visual._frameVideoTextures.set(node.id, extTex);
    }
    const audioBuf = Visual.audioUniformBuffer
      ? { binding: 3, resource: { buffer: Visual.audioUniformBuffer } }
      : null;
    bindGroupForPass = Visual.device.createBindGroup({
      label: "shader-frag-videosource-bg-" + node.id + "-vo-" + consumerVO.id,
      layout: Visual.videoSourceShaderBgl,
      entries: [
        { binding: 0, resource: { buffer: inst.uniformBuffer } },
        { binding: 1, resource: extTex },
        { binding: 2, resource: Visual.blitSampler },
        audioBuf
      ].filter(Boolean)
    });
  }
  if (!bindGroupForPass) return false;

  const label = (isScratch ? "shader-frag-scratch-" : "shader-frag-") +
    node.type + "-" + node.id + "-vo-" + consumerVO.id + "-" +
    (isScratch ? "scratch" + layerIdx : "layer" + layerIdx);
  const pass = enc.beginRenderPass({
    label: label,
    colorAttachments: [{
      view: layerView,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  pass.setPipeline(pipeEntry.pipeline);
  pass.setBindGroup(0, bindGroupForPass);
  pass.draw(3);
  pass.end();
  return true;
}

