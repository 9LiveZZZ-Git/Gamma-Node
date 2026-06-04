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

