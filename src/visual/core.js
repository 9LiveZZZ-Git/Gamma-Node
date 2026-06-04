/* =========================================================================
 * Phase 4 — Real-time audio preview via in-browser wasm-clang
 *
 * Pipeline:
 *   1. generateCode() emits patch C++ (existing).
 *   2. wrapForPreview() wraps it with a small adapter that exports
 *      WASM-callable init / tick / setter functions plus a getSetterId
 *      table for fast dispatch from the worklet.
 *   3. ensureCompileWorker() loads @wasmer/sdk lazily and stages
 *      the pre-built libgamma.a + headers in the in-memory FS.
 *   4. compilePatch() posts {wrappedSrc} to the worker; gets back
 *      {wasmBytes, setterTable} or {error, stderr}.
 *   5. ensureAudioWorklet() registers the inline processor module
 *      (Blob URL) and instantiates a single PreviewProcessor node
 *      connected to AudioContext.destination.
 *   6. The processor receives wasmBytes via postMessage, instantiates
 *      WebAssembly, and calls tick() per render quantum (128 frames).
 *   7. Hot-reload: graph mutations re-trigger compile (debounced 250 ms),
 *      and the worker's reply triggers an atomic module swap inside
 *      the processor.
 *
 * Runs end-to-end the moment libgamma.a exists at the configured URL.
 * Without it, the Build pane still shows the wrapped C++ and the Play
 * button reports a clear "Gamma archive not found" error.
 * ======================================================================== */

/* =========================================================================
 * Visual subsystem — Phase 6.1
 *
 * WebGPU-native rendering pipeline. This file currently scaffolds:
 *   • Device + adapter acquisition (lazy singleton, auto-fired at end
 *     of init since WebGPU is permissionless — no consent dialog risk).
 *   • Canvas context configuration (alphaMode: premultiplied so future
 *     shader output composes cleanly with the editor backdrop).
 *   • DPR-aware sizing + window-resize re-sizing.
 *   • Status pill in the header so the user can see at a glance whether
 *     the device acquired (cyan dot), is missing (yellow), errored
 *     (red), or got lost mid-session (red).
 *   • A "smoke clear" render pass — fills the canvas with the editor
 *     bg color so we can confirm end-to-end the device → command
 *     encoder → context.getCurrentTexture() → present pipeline works.
 *
 * Future tickets layer on:
 *   6.1.4 — Render-target framebuffer at user-selectable resolution
 *   6.1.5 — Resolution HUD
 *   6.1.6 — texture / transform / mesh port types in the legality matrix
 *   6.1.7 — VisualOutput sink node
 *   6.2.x — Pipeline cache + WGSL hot reload
 *   6.3.x — Texture port machinery + ping-pong FBO ring
 *   6.4.x — First built-in shader nodes (Gradient / Noise / Plasma / ...)
 *   6.5.x — Audio reactivity bridge via SharedArrayBuffer
 *   6.6.x — Polymorphic .gdsp shader-frag/vert/compute kinds
 *   6.7.x — Editor controls (capture, perf overlay, Live Mode)
 * ======================================================================== */

/* Phase 6.6 — maximum supported displays in a single rig. The WGSL
 * composite shader's RigDisplays array, the rig-displays uniform
 * buffer, the warp uniform buffer's slot count, and every JS loop
 * bound that touches "all displays" use this constant.
 *
 * Sized at 32 to fit the real AlloSphere (26 projectors) with
 * headroom for the next-gen install + experimental rigs. WebGPU's
 * texture_2d_array max layer count is typically 256, and a uniform
 * buffer of 32 × vec4f = 512 B is well under the 64 KB binding
 * limit, so 32 is comfortable. Bumping further would require
 * checking adapter limits (maxStorageBufferBindingSize for the
 * uniform array if we ever switch to storage buffers). */
const RIG_MAX_DISPLAYS = 32;

const Visual = {
  // null = unprobed; true = device acquired; false = unavailable / errored
  available: null,
  adapter: null,
  device: null,
  canvas: null,
  context: null,
  presentationFormat: null,
  features: new Set(),    // active features the device opted into

  // Phase 6.1.4 — render-target framebuffer + blit pipeline.
  // Shader nodes (6.4.x) render INTO the framebuffer at the user-
  // selected resolution; a single fullscreen-triangle blit samples
  // it onto the visible canvas with letterbox / pillarbox bars to
  // preserve aspect ratio (object-fit: contain semantics).
  framebuffer: null,            // GPUTexture
  framebufferView: null,        // GPUTextureView (rebuilt with FBO)
  fbWidth:  1920,
  fbHeight: 1080,
  fbFormat: "rgba8unorm",
  resolutionKey: "1080p",
  RESOLUTIONS: [
    { key: "1080p", w: 1920, h: 1080 },
    { key: "1440p", w: 2560, h: 1440 },
    { key: "4K",    w: 3840, h: 2160 },
    { key: "8K",    w: 7680, h: 4320 }
  ],
  blitPipeline: null,           // GPURenderPipeline — fullscreen triangle (1-display fallback)
  blitBindGroupLayout: null,    // GPUBindGroupLayout — texture + sampler
  blitBindGroup: null,          // GPUBindGroup (rebuilt when FBO changes)
  blitSampler: null,            // GPUSampler — linear / clamp-to-edge

  // Phase 6.5.5–6.5.10 — multi-display texture array + rig composite
  // pipeline. The framebuffer is now a 2d-array texture with one
  // layer per display. Each VisualOutput renders into its display's
  // layer; the rig composite pipeline reads the array and tiles the
  // layers onto the visible canvas using the rig's previewMode.
  framebufferLayerViews:  [],   // GPUTextureView per layer (for render pass attachment)
  framebufferArrayView:   null, // 2d-array view (for compositor binding)
  rigCompositePipeline:   null, // pipeline for the tile-flat / equirect / etc. composite
  rigCompositeBindGroupLayout: null,
  rigCompositeBindGroup:  null, // rebuilt when framebuffer / layer count changes
  rigCompositeUniformBuffer: null, // 32 B uniform: layer_count, cols, rows, mode + azim/pitch ranges
  rigDisplaysBuffer:      null, // RIG_MAX_DISPLAYS × 16 B uniform array of (yaw, pitch, fov_h, fov_v) — one vec4 per display

  // Phase 6.6.4 — calibration warp pass. Runs after the rig composite
  // in tile mode for displays with a non-null warpMesh. Overdraws each
  // warped display's tile with a Bourke-mesh-warped sample of its
  // source layer; non-warped displays show the un-warped composite
  // result through. One shared pipeline + dynamic-offset uniform
  // buffer (RIG_MAX_DISPLAYS slots × 256 B) so per-display draws
  // don't need their own bind groups.
  warpPipeline:           null,
  warpBindGroupLayout:    null,
  warpBindGroup:          null,   // rebuilt when framebuffer changes; uses dynamic offset
  warpUniformBuffer:      null,   // RIG_MAX_DISPLAYS × 256 B; per-display layer + edge-blend params
  warpUniformStride:      256,    // min uniform-buffer-binding alignment
  _warpCache:             new Map(),  // displayId → { vBuffer, iBuffer, indexCount, vCapacity, iCapacity, sig }

  // Phase 6.6.13 — theater mode. 3D explorable view where each
  // display is a quad in space and the user moves around with WASD
  // + mouse-look. Used for VR-style rig auditing — see what the
  // installation will physically look like before deploying.
  theaterPipeline:        null,
  theaterBindGroupLayout: null,
  theaterBindGroup:       null,
  theaterUniformBuffer:   null,   // 64 B viewProj matrix (mat4x4)
  theaterVertexBuffer:    null,   // RIG_MAX_DISPLAYS × 4 verts × (vec3 pos + vec2 uv + u32 layer)
  theaterIndexBuffer:     null,   // RIG_MAX_DISPLAYS × 6 indices (2 triangles per quad)
  theaterDepthTexture:    null,   // depth buffer sized to canvas; reallocated on resize
  theaterDepthView:       null,
  theaterDepthW:          0,
  theaterDepthH:          0,
  theaterSampler:         null,   // anisotropic-filtered sampler for distance smoothing
  theaterCam: {
    pos:   [0, 0, 0],     // eye position in rig space (origin = rig center)
    yaw:   0,             // radians; 0 looks toward +Z (default display 0 direction)
    pitch: 0,             // radians; clamped ±88°
    fov:   60,            // degrees, vertical
    speed: 2.0,           // units / second; Shift = 4× sprint
    sensitivity: 0.0025,  // radians per pixel of mouse movement
    pointerLocked: false,
    keys: new Set(),      // currently-held keys (KeyboardEvent.key — case-sensitive)
    // Touch-stick analog state. Set by the on-screen pads in
    // _wireTouchPads; consumed in _theaterStepCamera. Each axis
    // is in [-1, 1] (normalized stick deflection). Null when no
    // touch is active so the keyboard path stays untouched on
    // mouse-only setups.
    touchMove: null,      // { fwd: -1..1, strafe: -1..1 }
    touchLook: null       // { dx: rad/sec, dy: rad/sec }
  },
  theaterInputWired: false, // set once the document-level listeners are attached

  // §5.5.f FPCamera input state. One pointer-lock + key set is
  // shared across all FPCamera nodes (only the first FPCamera in
  // state.nodes gets ticked by _tickFPCameras -- typical setups
  // have one). Mouse deltas are accumulated between frames and
  // zeroed inside the tick.
  fpcInput: {
    pointerLocked: false,
    keys:    new Set(),   // KeyboardEvent.code strings (layout-stable)
    mouseDx: 0,
    mouseDy: 0
  },
  fpcInputWired: false,

  // Phase 6.1.5 — HUD state. `frozen` pauses the future rAF render
  // loop without touching audio. `fps` is updated each frame by
  // _tickFpsReadout (called from the rAF loop in 6.1.7+); for now
  // it stays 0 since no animation is running.
  frozen: false,
  fps: 0,

  // Phase 6.7.4 -- performance overlay. Per-frame counters reset by
  // renderVisualFrame() at the top + incremented by the encoder
  // monkey-patch installed in ensureGPUDevice (so call sites stay
  // untouched). EMA-smoothed values feed the DOM updater at ~5 Hz.
  // visible toggles the overlay (body.perf-open class).
  perf: {
    drawCalls: 0,
    passes: 0,
    frameTimeMs: 0,
    emaFrameTimeMs: 0,
    emaDrawCalls: 0,
    emaPasses: 0,
    visible: false,
    lastDomUpdateT: 0,
    encoderWrapped: false
  },

  // Phase 6.1.7 / 6.2.1 — time tracking for shader uniforms. startTime
  // is set once when the device acquires; u_time = (now - startTime)
  // in seconds, u_dt = since-last-frame in seconds.
  startTime: 0,
  lastFrameT: 0,

  // Phase 6.2.1 — WGSL pipeline cache. Keyed by FNV hash of the WGSL
  // body so identical shader source shares one compile, even across
  // multiple node instances of the same registry entry. Map stores
  // { promise, pipeline, error } — promise is the in-flight async
  // compile (callers await or skip), pipeline goes non-null once
  // ready. Single shared layout for now (1 uniform buffer at @group 0
  // @binding 0); composition shaders with texture inputs will get
  // their own cache key in 6.4.x.
  shaderPipelineCache: new Map(),
  standardShaderBgl: null,
  standardShaderPipelineLayout: null,
  // Phase 6.3.2 — feedback shader-frag layout (uniform + texture +
  // sampler). Used by FeedbackShader and any future composition
  // node that needs sampled-texture access without the full per-
  // node intermediate machinery (which lands when chains ship).
  feedbackShaderBgl: null,
  feedbackShaderPipelineLayout: null,
  // Global "previous frame" history texture. Same shape as the
  // framebuffer texture array; populated by an end-of-frame
  // copyTextureToTexture so the next frame's feedback shaders read
  // last frame's composite output.
  feedbackArray:     null,
  feedbackArrayView: null,
  // Phase 6.6.30 — composition shader-frag bind layout. Same shape
  // as feedback (uniform + texture_2d_array + sampler) but binds
  // the SCRATCH texture (not feedbackArray) so composition reads
  // SAME-FRAME upstream content instead of 1-frame-lagged content.
  // Lets a single composition node distribute correctly to N VOs:
  // the per-VO render loop overwrites each scratch slot with the
  // current consumer's pose-correct upstream render before that
  // consumer's composition pass reads it.
  compositionShaderBgl: null,
  compositionShaderPipelineLayout: null,
  // v0.3.34 -- composition + feedback hybrid bind layout. Binds BOTH
  // the scratch texture (binding 1, same-frame upstream content like
  // composition) AND the feedback array (binding 4, last-frame
  // composite like feedback). The CRT shader uses this to read its
  // upstream input for the live signal AND its own last-frame output
  // for phosphor persistence trails in a single pass. Pipeline cache
  // disambiguates via the layout tag in the hash key.
  compositionFeedbackShaderBgl: null,
  compositionFeedbackShaderPipelineLayout: null,
  // Scratch render-target textures (Phase 6.6.30 + v0.2.16 ping-pong).
  // Two scratch textures (A and B) so a deep composition chain doesn't
  // hit the WebGPU same-pass texture-binding-vs-render-attachment rule:
  // a composition node at chain-depth d WRITES to one scratch texture
  // and READS the other within its single render pass, never the same.
  // Parity rule (see _buildRenderPlan):
  //   readKey  = (depth     % 2 === 0) ? "a" : "b"
  //   writeKey = ((depth-1) % 2 === 0) ? "a" : "b"   (only for scratch)
  // So depth 0 reads A; depth 1 writes A and reads B; depth 2 writes B
  // and reads A; etc. WebGPU sees distinct textures per pass.
  // SCRATCH_BUDGET layers per texture; both allocated in _allocateFramebuffer.
  scratchTextureA:        null,
  scratchArrayViewA:      null,
  scratchLayerViewsA:     [],
  scratchTextureB:        null,
  scratchArrayViewB:      null,
  scratchLayerViewsB:     [],

  // Per-node-instance render state. Map<nodeId, { uniformBuffer,
  // bindGroup, scratch }>. uniformBuffer is the GPU-side state that
  // backs the shader's WGSL uniform struct; scratch is a Float32Array
  // we pack into each frame and queue.writeBuffer to the uniform.
  shaderInstances: new Map(),

  // Sprint platformer-2a -- image texture cache. Key = url string
  // (http/data/preset:). Value = { state: "loading"|"ready"|"error",
  // texture: GPUTexture | null, view: GPUTextureView | null,
  // width, height, error?: string }. Shared across ImageURL nodes so
  // multiple nodes with the same URL upload only once.
  imageTextures: new Map(),

  // Sprint plat-2a-render -- sprite pipeline infrastructure. Separate
  // from the mesh path (mesh BGL has 16 bindings; sprite uses 3) so
  // textured 2D sprites don't drag along all the planet / IBL / SVT
  // bindings they don't need.
  spriteBindGroupLayout: null,    // 3 entries: drawU, texture, sampler
  spritePipelineLayout:  null,
  spriteShaderModule:    null,
  spritePipelineCache:   new Map(),  // key = sampleCount; value = GPURenderPipeline
  spriteSamplers:        new Map(),  // key = filterMode ("nearest"/"linear")
  // Per-sprite-node draw state. Map<nodeId, {uniformBuffer, bindGroup,
  // boundTextureView, boundSampler, scratch: Float32Array(24)}>.
  spriteInstances: new Map(),

  // Sprint 7.5.3a -- 3D rendering state.
  // depthTexture covers (fbWidth, fbHeight) at depth32float; shared
  // across every Scene render in a single frame (each pass clears it
  // first, so re-use is safe). Allocated alongside the framebuffer +
  // re-allocated on resolution change.
  depthTexture: null,
  depthTextureView: null,
  // MSAA state. msaaSampleCount is 1 (off), 4, or 8. The mesh
  // pipeline + depth + color attachments must all match. The
  // resolution HUD cycles this; renderpass picks attachments per
  // pass. Setting to >1 allocates Visual.msaaColorTexture (MSAA
  // intermediate) and rebuilds the depth texture at the matching
  // sampleCount. Render pass attaches the MSAA color as `view` +
  // the framebuffer layer as `resolveTarget` for hardware resolve.
  msaaSampleCount:    1,
  msaaColorTexture:   null,
  msaaColorTextureView: null,
  // Lazily-built mesh render pipeline. Cache key is the sample
  // count -- pipelines need their multisample.count to match the
  // attachments. Sprint 7.5.3a only emits the unlit-vertex-color
  // variant; sprint 7.5.3c adds material variants per cache key.
  meshPipelineCache: new Map(),
  meshBindGroupLayout:    null,
  meshPipelineLayout:     null,
  // Sprint 7.5.3c -- shared shader module (one WGSL compile per
  // session; multiple fragment entry points dispatch by material).
  meshShaderModule:       null,
  // Per-Scene-node uniform buffer holding camera viewProj + per-draw
  // model matrix. Allocated lazily per Scene node id. Map<nodeId, {
  //   uniformBuffer, scratch (Float32Array(32)) }>.
  sceneInstances: new Map(),
  // Per-mesh-source GPU buffer cache. Map<nodeId, { vertexBuffer,
  // indexBuffer, indexCount, mode }>. Built lazily on first render.
  meshBufferCache: new Map(),

  // Future-ticket holders.
  bindLayoutCache: null   // 6.3.4
};

function webgpuAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

function setGpuStatusPill(state, msg) {
  const pill = document.getElementById("gpu-status");
  if (!pill) return;
  pill.dataset.state = state;
  if (msg) pill.title = msg;
  // Tighter label per state — keeps the pill width compact.
  const label = ({
    probing:     "GPU…",
    ready:       "GPU",
    unavailable: "no GPU",
    error:       "GPU err",
    lost:        "GPU lost"
  })[state] || "GPU";
  pill.textContent = label;
  // Body class gates the .visual-hud display. Only "ready" shows it;
  // any other state (probing / unavailable / error / lost) hides the
  // resolution + fps + freeze controls since they'd be inert.
  document.body.classList.toggle("gpu-ready", state === "ready");
}

async function ensureGPUDevice() {
  if (Visual.device) return Visual.device;
  if (Visual.available === false) return null;   // already determined unavailable; don't retry on every call
  if (!webgpuAvailable()) {
    Visual.available = false;
    setGpuStatusPill("unavailable",
      "WebGPU not supported in this browser. Phase 6+ visuals require Chrome / Edge / Safari 18+. " +
      "Audio side keeps working.");
    console.log("[visual] WebGPU not available — navigator.gpu missing");
    return null;
  }
  try {
    Visual.adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!Visual.adapter) throw new Error("requestAdapter returned null (no compatible adapter)");

    // Capability detection — opt into features that are useful for
    // shader nodes + future compute work, but only if the adapter
    // actually exposes them. Missing features are silent (fall back
    // to base spec); only log what we got.
    const wantedFeatures = ["shader-f16", "timestamp-query", "float32-filterable"];
    const requiredFeatures = wantedFeatures.filter(f => Visual.adapter.features.has(f));

    Visual.device = await Visual.adapter.requestDevice({ requiredFeatures });
    Visual.features = new Set(Array.from(Visual.device.features));

    // Phase 6.7.4 -- install the perf-counter encoder wrap. Single
    // monkey-patch at device-creation time: createCommandEncoder
    // returns wrapped encoders whose beginRenderPass returns wrapped
    // passes whose draw() / drawIndexed() bumps a counter. Call sites
    // stay untouched; cost is ~2 function-call hops per pass-begin /
    // per draw which is in the noise vs. the actual GPU work.
    _installPerfEncoderWrap(Visual.device);

    // Sprint 10-5c-a: SVT atlas + page table allocation. Lazy --
    // _ensureSVT is idempotent so calling it once at device creation
    // is the cheapest way to log the initial allocation. Failure here
    // is non-fatal: the SVT path falls back to per-fragment procedural
    // when atlasTexture is null.
    try {
      if (typeof _ensureSVT === "function") _ensureSVT();
    } catch (_) {}

    // Device-loss handler — surfaces in the pill so the user sees
    // why visuals stopped. Most often happens on system sleep / GPU
    // driver crash; a page reload re-acquires.
    Visual.device.lost.then(info => {
      console.warn("[visual] device lost:",
                   info && info.reason || "?",
                   info && info.message || "");
      Visual.available = false;
      Visual.device = null;
      Visual.context = null;
      setGpuStatusPill("lost", "GPU device lost — reload page to reacquire (info: " +
        (info && info.message || "no detail") + ")");
    });

    Visual.canvas = document.getElementById("visual-bg");
    if (Visual.canvas) {
      Visual.context = Visual.canvas.getContext("webgpu");
      Visual.presentationFormat = navigator.gpu.getPreferredCanvasFormat();
      Visual.context.configure({
        device: Visual.device,
        format: Visual.presentationFormat,
        alphaMode: "premultiplied"
      });
      sizeVisualCanvas();
      // Phase 6.1.4 — allocate the FBO at the default resolution and
      // build the blit pipeline before the first smoke render. Order
      // matters: pipeline needs presentationFormat, FBO needs device,
      // bind group needs both. allocateFramebuffer also creates the
      // bind group; createBlitPipeline creates the layout that bind
      // group references.
      _createBlitPipeline();
      _createRigCompositePipeline();
      _createWarpPipeline();
      _createTheaterPipeline();
      _allocateFramebuffer();
      _rebuildBlitBindGroup();
      _rebuildRigCompositeBindGroup();
      _rebuildWarpBindGroup();
      _rebuildTheaterBindGroup();
      _wireTheaterInput();
      Visual.startTime  = performance.now();
      Visual.lastFrameT = 0;
      smokeClearVisual();
      // Phase 6.1.7 — kick off the rAF render loop. From this point
      // on the visual canvas refreshes every frame; the fps pill in
      // the visual HUD goes from "— fps" to a live readout.
      startVisualRenderLoop();
    }

    Visual.available = true;
    const info = Visual.adapter.info || {};
    console.log(
      "[visual] WebGPU device acquired:" +
      " vendor=" + (info.vendor || "?") +
      " arch=" + (info.architecture || "?") +
      " device=" + (info.device || "?") +
      " features=[" + Array.from(Visual.features).join(", ") + "]" +
      " format=" + Visual.presentationFormat
    );
    setGpuStatusPill("ready",
      "WebGPU ready — " + (info.architecture || "device") +
      ", format " + Visual.presentationFormat +
      (Visual.features.size ? ", features: " + Array.from(Visual.features).join(", ") : ""));
    return Visual.device;
  } catch (e) {
    console.warn("[visual] WebGPU init failed:", e);
    Visual.available = false;
    Visual.device = null;
    Visual.context = null;
    setGpuStatusPill("error", "WebGPU init failed: " + (e && e.message || e));
    return null;
  }
}

/* DPR-aware canvas sizing. The visual canvas's CSS size stays at
 * 100vw x 100vh, but its drawing-buffer size scales with
 * devicePixelRatio so we render at native pixel density on Retina
 * displays. WebGPU is happy with any size; future framebuffer
 * targets in 6.1.4 will be sized to the user's render-resolution
 * choice (1080p / 1440p / 4K / 8K) independently of this. */
function sizeVisualCanvas() {
  if (!Visual.canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(window.innerWidth  * dpr));
  const h = Math.max(1, Math.floor(window.innerHeight * dpr));
  if (Visual.canvas.width !== w || Visual.canvas.height !== h) {
    Visual.canvas.width  = w;
    Visual.canvas.height = h;
  }
  // Keep the 2D overlay canvas in lockstep with the WebGPU one.
  const ov = document.getElementById("visual-overlay");
  if (ov && (ov.width !== w || ov.height !== h)) {
    ov.width  = w;
    ov.height = h;
  }
}
window.addEventListener("resize", () => {
  sizeVisualCanvas();
  if (Visual.device && Visual.context) smokeClearVisual();
});

