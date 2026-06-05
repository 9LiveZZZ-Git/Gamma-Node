/* ----- Phase 6.1.4 — render-target framebuffer + blit pipeline -------- */

/* Allocate (or reallocate) the offscreen framebuffer as a 2d-array
 * texture with one layer per display in the current rig. Shader-frag
 * nodes render into specific layers via the per-layer views; the rig
 * composite pipeline samples the full array to assemble the operator
 * preview. Format is rgba8unorm (matches preferred canvas format —
 * no conversion at composite time) with RENDER_ATTACHMENT +
 * TEXTURE_BINDING. Old texture destroyed eagerly to release GPU
 * memory before the new one allocates (matters for 8K → 1080p where
 * ~125 MB is at stake).
 *
/* Sprint platformer-2a -- ImageURL texture loading. Async fetches an
 * image (URL / data URL / preset:NAME) into a GPU texture, caches
 * indefinitely. Subsequent calls with the same URL return the cached
 * entry. The first call kicks off the load; the texture becomes
 * available 1-2 frames later when the fetch + decode finishes.
 *
 * Returns the cache entry. Callers should check `state === "ready"`
 * before using `texture` / `view`.
 *
 * Built-in presets render into an OffscreenCanvas at first call.
 *   preset:test4x4   -- 2×2 colorful blocks (debug UV orientation).
 *                       Top-left = red, top-right = green,
 *                       bottom-left = blue, bottom-right = yellow.
 *                       64×64 px so it's clearly visible.
 *   preset:testgrid  -- 64×64 black-on-white 8×8 grid lines. */
function _ensureImageURLTexture(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  if (!Visual.device) return null;
  const cached = Visual.imageTextures.get(url);
  if (cached) return cached;
  const entry = { state: "loading", texture: null, view: null, width: 0, height: 0 };
  Visual.imageTextures.set(url, entry);
  // Preset URLs: render the bitmap synchronously via OffscreenCanvas,
  // then upload. Still async overall to keep the API uniform.
  if (url.indexOf("preset:") === 0) {
    const preset = url.substring("preset:".length);
    let bitmap;
    try {
      bitmap = _renderPresetBitmap(preset);
    } catch (e) {
      console.warn("[image-url] preset render failed:", preset, e);
      entry.state = "error";
      entry.error = String(e);
      return entry;
    }
    if (!bitmap) {
      entry.state = "error";
      entry.error = "unknown preset: " + preset;
      console.warn("[image-url] " + entry.error);
      return entry;
    }
    _uploadImageBitmapToTexture(entry, bitmap, url);
    return entry;
  }
  // §8.A.2 -- asset:NAME scheme. Resolves through the Assets store
  // (case-insensitive sprite name match), reads the stored blob, decodes
  // to ImageBitmap, uploads. Lets patches reference user-imported / LLM-
  // generated sprites without hard-coding paths.
  if (url.indexOf("asset:") === 0) {
    const name = url.substring("asset:".length);
    const rec = (typeof Assets !== "undefined") ? Assets.findSpriteByName(name) : null;
    if (!rec || !rec.blob) {
      entry.state = "error";
      entry.error = "asset not found: " + name;
      console.warn("[image-url] " + entry.error + " (asset library has "
        + (typeof Assets !== "undefined" ? Assets.list({type:"sprite"}).length : 0)
        + " sprites)");
      return entry;
    }
    createImageBitmap(rec.blob).then(bitmap => {
      _uploadImageBitmapToTexture(entry, bitmap, url);
    }).catch(err => {
      entry.state = "error";
      entry.error = String(err);
      console.warn("[image-url] asset decode failed " + name + ":", err);
    });
    return entry;
  }
  // Real URL (http/https/data). Async fetch via createImageBitmap.
  const isDataURL = url.indexOf("data:") === 0;
  const promise = isDataURL
    ? fetch(url).then(r => r.blob()).then(b => createImageBitmap(b))
    : fetch(url, { mode: "cors" }).then(r => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      }).then(b => createImageBitmap(b));
  promise.then(bitmap => {
    _uploadImageBitmapToTexture(entry, bitmap, url);
  }).catch(err => {
    entry.state = "error";
    entry.error = String(err);
    console.warn("[image-url] load failed " + url + ":", err);
  });
  return entry;
}

function _uploadImageBitmapToTexture(entry, bitmap, url) {
  if (!Visual.device) return;
  const w = bitmap.width, h = bitmap.height;
  const tex = Visual.device.createTexture({
    label: "imageurl-" + url.substring(0, 32),
    size: [w, h, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING
         | GPUTextureUsage.COPY_DST
         | GPUTextureUsage.RENDER_ATTACHMENT
  });
  Visual.device.queue.copyExternalImageToTexture(
    { source: bitmap, flipY: false },
    { texture: tex },
    [w, h, 1]
  );
  entry.texture = tex;
  entry.view = tex.createView();
  entry.width = w;
  entry.height = h;
  entry.state = "ready";
  console.log("[image-url] loaded " + url + " (" + w + "×" + h + ")");
  // bitmap.close() is supported on most browsers; gracefully no-op if not.
  if (bitmap && typeof bitmap.close === "function") {
    try { bitmap.close(); } catch (_) {}
  }
}

/* Paint a small built-in test pattern to an OffscreenCanvas and return
 * an ImageBitmap. Used by ImageURL presets so the editor ships with
 * known-good debug textures (UV orientation, sampler behavior). */
function _renderPresetBitmap(preset) {
  let canvas, ctx;
  if (preset === "test4x4") {
    canvas = new OffscreenCanvas(64, 64);
    ctx = canvas.getContext("2d");
    // Four colored 32×32 quadrants. UV (0,0) is top-left of the
    // texture; standard 2D image coords. After WebGPU's UV-flip on
    // sample (top-left origin), the bottom-left of the screen-aligned
    // sprite should show RED (this verifies UV / flip orientation).
    ctx.fillStyle = "#ff3030"; ctx.fillRect(0,   0,  32, 32);   // TL
    ctx.fillStyle = "#30ff30"; ctx.fillRect(32,  0,  32, 32);   // TR
    ctx.fillStyle = "#3060ff"; ctx.fillRect(0,  32,  32, 32);   // BL
    ctx.fillStyle = "#ffff30"; ctx.fillRect(32, 32,  32, 32);   // BR
    return canvas.transferToImageBitmap();
  }
  if (preset === "testgrid") {
    canvas = new OffscreenCanvas(64, 64);
    ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = "#000000"; ctx.lineWidth = 1;
    for (let i = 0; i <= 64; i += 8) {
      ctx.beginPath(); ctx.moveTo(i + 0.5, 0); ctx.lineTo(i + 0.5, 64); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i + 0.5); ctx.lineTo(64, i + 0.5); ctx.stroke();
    }
    return canvas.transferToImageBitmap();
  }
  return null;
}

/* Walk a Sprite node's `texture` wire to its source ImageURL, then
 * ensure the texture is loaded. Returns the cache entry (state may be
 * "loading"/"ready"/"error") or null if no wire or non-ImageURL
 * source. Called by the sprite encoder dispatch in plat-2a-render.
 *
 * Sprint Level2D Phase 1a: synthetic Level2D layer nodes don't have
 * a `texture` wire -- the URL lives inline in the layer config.
 * Detect via _levelLayer and resolve the URL directly. */
function _resolveSpriteTextureEntry(spriteNode) {
  if (!spriteNode) return null;
  // Sprint Level2D Phase 1a: synthetic-layer nodes carry URL inline.
  if (spriteNode._levelLayer) {
    // Level2D synthetic layers stash the URL inline. Parallax /
    // scatter layers use the `texture` field; tilemap layers use
    // `tileset` (since they may also reference vertex-color tiles
    // alongside textured ones). Try both.
    const url = (typeof spriteNode._levelLayer.texture === "string" && spriteNode._levelLayer.texture)
             || (typeof spriteNode._levelLayer.tileset === "string" && spriteNode._levelLayer.tileset)
             || "";
    if (url) return _ensureImageURLTexture(url);
    // Fall through if neither set (e.g. a vertex-color-only tilemap layer).
  }
  // Sprint Level2D Phase 2: Tilemap2D with `tileset` param is its own
  // texture source (no upstream ImageURL wire). Honor that before the
  // wire walk.
  if (spriteNode.type === "Tilemap2D" && spriteNode.params && typeof spriteNode.params.tileset === "string" && spriteNode.params.tileset.length) {
    return _ensureImageURLTexture(spriteNode.params.tileset);
  }
  if (!state || !Array.isArray(state.edges)) return null;
  const wire = state.edges.find(e =>
    e && e.to && e.to.node === spriteNode.id && e.to.port === "texture"
  );
  if (!wire || !wire.from) return null;
  const src = state.nodes.find(n => n && n.id === wire.from.node);
  if (!src) return null;
  // Phase C sprint tektite-5c -- TektiteGraph is a live texture
  // emitter; its per-frame tick stashes _textureEntry directly on the
  // node so we can short-circuit the ImageURL URL path entirely.
  if (typeof _tektiteResolveTextureEntry === "function") {
    const tk = _tektiteResolveTextureEntry(src);
    if (tk) return tk;
  }
  if (src.type !== "ImageURL") return null;
  const sp = _resolveNodeParams(src);
  const url = (typeof sp.url === "string") ? sp.url : "";
  if (!url) return null;
  return _ensureImageURLTexture(url);
}

 /* Phase 6.5.5: layer count tracks state.rig.displays.length, so a
  * template swap reallocates here. Per-layer views are created up
  * front so render passes can target them by index without
  * recreating the view object every frame. */
function _allocateFramebuffer() {
  if (!Visual.device) return;
  // v0.2.21 — abort an in-flight per-display recording before
  // destroying the framebuffer. The recording holds per-layer bind
  // groups that reference Visual.framebufferLayerViews[i]; without
  // this stop the next render pass would attach a destroyed texture
  // view + crash WebGPU. _stopPerDisplayRecordingAndDownload() flushes
  // the recorders + builds the ZIP, so the user gets whatever was
  // recorded so far instead of losing the take.
  if (typeof perDisplayRecordingActive === "function" && perDisplayRecordingActive()) {
    console.log("[per-display] framebuffer reallocating — flushing recording");
    // Fire-and-forget; the modal status line shows progress, the
    // ZIP downloads when ready.
    _stopPerDisplayRecordingAndDownload().catch(e =>
      console.warn("[per-display] flush-on-realloc failed:", e));
  }
  if (Visual.framebuffer) {
    try { Visual.framebuffer.destroy(); } catch (_) {}
  }
  if (Visual.feedbackArray) {
    try { Visual.feedbackArray.destroy(); } catch (_) {}
  }
  if (Visual.scratchTextureA) {
    try { Visual.scratchTextureA.destroy(); } catch (_) {}
  }
  if (Visual.scratchTextureB) {
    try { Visual.scratchTextureB.destroy(); } catch (_) {}
  }
  // Sprint 7.5.3a -- depth texture is a single-layer 2D texture
  // matching the framebuffer dimensions. Cleared per Scene render
  // pass + re-used across passes in the same frame. MSAA: depth
  // texture's sampleCount must match the color attachment, so we
  // reallocate whenever Visual.msaaSampleCount changes (via
  // _ensureMsaa3DTextures).
  if (Visual.depthTexture) {
    try { Visual.depthTexture.destroy(); } catch (_) {}
    Visual.depthTexture     = null;
    Visual.depthTextureView = null;
  }
  if (Visual.msaaColorTexture) {
    try { Visual.msaaColorTexture.destroy(); } catch (_) {}
    Visual.msaaColorTexture     = null;
    Visual.msaaColorTextureView = null;
  }
  // Phase 6.6.30 — framebuffer + feedbackArray sized to rig display
  // count only (reverted v0.2.4's over-allocation). Scratch lives in
  // TWO SEPARATE textures (A + B, allocated below); deep composition
  // chains ping-pong between them so each pass reads from one and
  // writes to the other -- preserves the same-frame read invariant
  // without violating WebGPU's same-pass texture-binding-vs-
  // render-attachment rule that an in-place scratch chain would hit.
  const SCRATCH_BUDGET = 8;
  const displayCount = Math.max(1, (state && state.rig && Array.isArray(state.rig.displays) && state.rig.displays.length) || 1);
  Visual.rigDisplayCount = displayCount;
  Visual.scratchBudget   = SCRATCH_BUDGET;
  const layerCount = displayCount;
  Visual.framebuffer = Visual.device.createTexture({
    label: "visual-framebuffer-array-" + layerCount + "x-" + Visual.resolutionKey,
    size: [Visual.fbWidth, Visual.fbHeight, layerCount],
    dimension: "2d",            // 2d arrays are still dimension "2d" with depth >1
    format: Visual.fbFormat,
    // RENDER_ATTACHMENT = shader-frag passes write to a layer.
    // TEXTURE_BINDING   = composite / theater / warp passes sample
    //                     the array.
    // COPY_SRC          = end-of-frame copy to feedbackArray for the
    //                     FeedbackShader history.
    // COPY_DST (v0.3.4) = ai-vision-canvas nodes (HandLandmarker,
    //                     PoseLandmarker, FaceLandmarker) queue a
    //                     copyExternalImageToTexture from a 2D canvas
    //                     directly into a layer; the destination
    //                     texture must carry CopyDst.
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
           GPUTextureUsage.COPY_SRC          | GPUTextureUsage.COPY_DST
  });
  Visual.framebufferLayerViews = [];
  for (let i = 0; i < layerCount; i++) {
    Visual.framebufferLayerViews.push(Visual.framebuffer.createView({
      label: "fb-layer-" + i,
      dimension: "2d",
      baseArrayLayer: i,
      arrayLayerCount: 1
    }));
  }
  Visual.framebufferArrayView = Visual.framebuffer.createView({
    label: "fb-array",
    dimension: "2d-array"
  });
  Visual.framebufferView = Visual.framebufferLayerViews[0];

  // Phase 6.3.2 — feedback / "previous frame" texture array. Same
  // dimensions as the framebuffer, COPY_DST so we can blit into it
  // each frame's end + TEXTURE_BINDING so feedback shaders can sample
  // it. Initial content is undefined; first frame's FeedbackShader
  // sees zero (the implicit clear via copyTextureToTexture from a
  // freshly-cleared framebuffer).
  Visual.feedbackArray = Visual.device.createTexture({
    label: "visual-feedback-array-" + layerCount + "x-" + Visual.resolutionKey,
    size: [Visual.fbWidth, Visual.fbHeight, layerCount],
    dimension: "2d",
    format: Visual.fbFormat,
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
  });
  Visual.feedbackArrayView = Visual.feedbackArray.createView({
    label: "feedback-array",
    dimension: "2d-array"
  });

  // Sprint 7.5.3a -- depth + MSAA-color textures for 3D Scene render
  // passes. Allocated at the CURRENT Visual.msaaSampleCount; updated
  // by _ensureMsaa3DTextures when the user cycles the MSAA HUD pill.
  // depth32float gives a 24-bit-mantissa float depth with the full
  // [0,1] range and adequate near/far precision for the patches we
  // expect. STENCIL omitted -- no stencil-test workflow yet.
  _ensureMsaa3DTextures();
  // Phase 6.6.30 + v0.2.16 — two scratch render-target textures (A + B)
  // for composition node inputs. SCRATCH_BUDGET layers each, isolated
  // from the framebuffer. Deep composition chains ping-pong between
  // A and B per chain-depth: each composition pass binds ONE for read
  // and attaches the OTHER for write, so WebGPU never sees the same
  // texture as both TextureBinding and RenderAttachment in one pass.
  // Per-VO render loop overwrites these slots before each consumer's
  // composition pass, so the same slot can be reused across N consumer
  // VOs -- SCRATCH_BUDGET only needs to cover ONE consumer's chain
  // width per texture, not N consumers × width.
  function allocScratch(key) {
    const tex = Visual.device.createTexture({
      label: "visual-scratch-" + key + "-array-" + SCRATCH_BUDGET + "x-" + Visual.resolutionKey,
      size: [Visual.fbWidth, Visual.fbHeight, SCRATCH_BUDGET],
      dimension: "2d",
      format: Visual.fbFormat,
      // v0.3.4 — added COPY_DST so ai-vision-canvas nodes (HandLandmarker
      // et al) can queue copyExternalImageToTexture into a scratch
      // layer when composing through a BlendShader / MaskShader chain.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_DST
    });
    const arrayView = tex.createView({
      label: "scratch-" + key + "-array",
      dimension: "2d-array"
    });
    const layerViews = [];
    for (let i = 0; i < SCRATCH_BUDGET; i++) {
      layerViews.push(tex.createView({
        label: "scratch-" + key + "-layer-" + i,
        dimension: "2d",
        baseArrayLayer: i,
        arrayLayerCount: 1
      }));
    }
    return { tex, arrayView, layerViews };
  }
  const scA = allocScratch("a");
  const scB = allocScratch("b");
  Visual.scratchTextureA    = scA.tex;
  Visual.scratchArrayViewA  = scA.arrayView;
  Visual.scratchLayerViewsA = scA.layerViews;
  Visual.scratchTextureB    = scB.tex;
  Visual.scratchArrayViewB  = scB.arrayView;
  Visual.scratchLayerViewsB = scB.layerViews;
  // Drop any cached shader instances since their feedback / composition
  // bind groups reference the now-destroyed views; they'll rebuild on
  // next render.
  Visual.shaderInstances.clear();
  // Sprint 7.5.3c push 5 -- scene instances reference the scratch
  // texture views via their bind groups too. Same rebuild rule.
  if (Visual.sceneInstances) Visual.sceneInstances.clear();
}

/* Build the fullscreen-triangle blit pipeline once at device init.
 * The pipeline samples the framebuffer texture and writes to the
 * visible canvas. Topology is a single triangle that overshoots the
 * viewport on two sides — saves one vertex vs the two-triangle quad
 * approach with no other downside (the rasterizer clips the overshoot).
 * Layout is bind-group 0 = (texture, sampler). */
function _createBlitPipeline() {
  if (!Visual.device || !Visual.presentationFormat) return;
  const wgsl = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  // Fullscreen triangle covering [-1,-1] to [1,1] with UVs that put
  // (0,0) at the top-left of the texture (V is flipped vs clip-Y).
  var p = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@group(0) @binding(0) var fbTex: texture_2d<f32>;
@group(0) @binding(1) var fbSampler: sampler;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  return textureSample(fbTex, fbSampler, in.uv);
}
`;
  const module = Visual.device.createShaderModule({ label: "blit-shader", code: wgsl });

  Visual.blitBindGroupLayout = Visual.device.createBindGroupLayout({
    label: "blit-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
    ]
  });

  Visual.blitPipeline = Visual.device.createRenderPipeline({
    label: "blit-pipeline",
    layout: Visual.device.createPipelineLayout({
      bindGroupLayouts: [Visual.blitBindGroupLayout]
    }),
    vertex:   { module, entryPoint: "vs_main" },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format: Visual.presentationFormat }]
    },
    primitive: { topology: "triangle-list" }
  });

  Visual.blitSampler = Visual.device.createSampler({
    label: "blit-sampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge"
  });
}

/* Rebuild the blit bind group whenever the framebuffer is reallocated
 * (resolution change, or first allocation). Cheap — just one
 * createBindGroup call referencing the existing layout + sampler +
 * the fresh framebuffer view. */
function _rebuildBlitBindGroup() {
  if (!Visual.device || !Visual.framebufferView ||
      !Visual.blitBindGroupLayout || !Visual.blitSampler) return;
  Visual.blitBindGroup = Visual.device.createBindGroup({
    label: "blit-bg",
    layout: Visual.blitBindGroupLayout,
    entries: [
      { binding: 0, resource: Visual.framebufferView },
      { binding: 1, resource: Visual.blitSampler }
    ]
  });
}

