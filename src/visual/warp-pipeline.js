/* ----- Phase 6.6.4 — calibration warp pipeline ------------------------ */

/* The warp pipeline draws one Bourke mesh per display as triangle
 * strips, sampling the display's source array layer at each vertex's
 * (u, v) and positioning the output at the vertex's (x, y) NDC. Edge-
 * blend intensity is multiplied into the fragment color so overlap
 * regions can fade between projectors.
 *
 * Architecture:
 *   - Vertex layout matches the Bourke 5-float-per-vertex format:
 *     stride 20 B; @location(0) = pos.xy, @location(1) = uv.xy,
 *     @location(2) = intensity. No conversion needed at upload — the
 *     in-memory plain Array maps 1:1 to a Float32Array view.
 *   - One shared bind group + uniform buffer, with dynamic offset
 *     selecting a per-display slot (16 × 256 B = 4096 B). Each slot
 *     packs (layer u32, gamma f32, blackLift f32, power f32) — the
 *     edge-blend params get consumed in 6.6.5+; layer is the array
 *     index of the display's framebuffer layer.
 *   - Per-display vertex/index buffers cached in Visual._warpCache.
 *     Re-allocated only when mesh dimensions change; otherwise the
 *     existing buffer is overwritten in place. Mesh signatures are
 *     just "cols×rows" — sufficient because the mesh editor (6.6.9)
 *     will swap reference on dimension change but mutate-in-place
 *     for vertex-position edits, and we want the in-place edits to
 *     pick up automatically.
 *
 * Render rules:
 *   - Only runs in tile preview mode. Non-tile modes (cylinder/
 *     equirect/fisheye) show the audience-perspective unwrap, where
 *     per-projector warp doesn't apply — the warp pass is silently
 *     skipped.
 *   - Pass is loaded (not cleared) so non-warped displays' un-warped
 *     composite output remains visible.
 *   - One render pass per warped display so the viewport can be set
 *     to that display's tile. Cheap — at 16 displays × 8×8 mesh =
 *     ~1300 verts and 16 draw calls per frame, well below GPU budget.
 */
function _createWarpPipeline() {
  if (!Visual.device || !Visual.presentationFormat) return;
  const wgsl = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) intensity: f32,
};

@vertex
fn vs_main(
  @location(0) inPos:       vec2f,
  @location(1) inUv:        vec2f,
  @location(2) inIntensity: f32
) -> VsOut {
  var o: VsOut;
  o.pos       = vec4f(inPos, 0.0, 1.0);
  o.uv        = inUv;
  o.intensity = inIntensity;
  return o;
}

struct WarpU {
  layer:      u32,
  gamma:      f32,
  blackLift:  f32,
  power:      f32,
};

@group(0) @binding(0) var fbTex:    texture_2d_array<f32>;
@group(0) @binding(1) var fbSampler: sampler;
@group(0) @binding(2) var<uniform> u: WarpU;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Phase 6.6.5–6.6.8 — full edge-blend math.
  //
  //   smoothI    : symmetric power-curve ramp [0,1].  At p=2 this is
  //                a quadratic ease-in/out; at p=1 it's linear; higher
  //                p gives a sharper crossover. Standard formula from
  //                Resolume / domeprojection.com / Bourke notes:
  //                  i ≤ 0.5 → 0.5 · (2i)^p
  //                  i > 0.5 → 1 − 0.5 · (2(1−i))^p
  //                Continuous, equals i at p=1, equals 0 at i=0 and 1
  //                at i=1 for any p > 0. Sum across two complementary
  //                ramps stays ≈ 1 in the overlap zone.
  //
  //   gamma      : converts to linear before the intensity multiply,
  //                back to sRGB after.  At gamma=1.0 this is a no-op,
  //                which means the blend happens in display space —
  //                fine for purely synthetic content but slightly
  //                wrong for photographic source. Default 2.2 matches
  //                the standard sRGB → linear curve.
  //
  //   blackLift  : raises the black floor in non-overlap regions to
  //                match the elevated black of overlap zones (where
  //                two projectors' minimum-output black sums up). Lift
  //                amount = blackLift · (1 − smoothI), so it's zero
  //                at overlap centers (smoothI = 0.5 ish) and full at
  //                full-intensity non-overlap (smoothI = 1).  Default
  //                0 = no lift.
  //
  // Defaults (gamma=2.2, blackLift=0, power=2.0, intensity=1) yield
  // bit-exact output equal to the source — the blend math is a no-op
  // for a calibration that hasn't been hand-tuned.
  // Bourke mesh UV uses +y up (v=0 at bottom); WebGPU samples with
  // v=0 at top. Invert V here so the convention lives in one place
  // and asymmetric source content (text, images) renders right-side-
  // up. Symmetric test patterns are unchanged by this.
  let sampleUv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let c = textureSampleLevel(fbTex, fbSampler, sampleUv, u.layer, 0.0).rgb;
  let i = clamp(in.intensity, 0.0, 1.0);
  let p = max(u.power, 0.0001);
  let g = max(u.gamma, 0.0001);
  let inv_g = 1.0 / g;

  let smoothI = select(
    1.0 - 0.5 * pow(2.0 * (1.0 - i), p),
    0.5 * pow(2.0 * i, p),
    i <= 0.5
  );

  let cLin    = pow(c, vec3<f32>(g));
  let cBlend  = cLin * smoothI;
  let cLifted = cBlend + vec3<f32>(u.blackLift) * (1.0 - smoothI);
  let cOut    = pow(max(cLifted, vec3<f32>(0.0)), vec3<f32>(inv_g));

  return vec4f(cOut, 1.0);
}
`;
  const module = Visual.device.createShaderModule({ label: "warp-shader", code: wgsl });

  Visual.warpBindGroupLayout = Visual.device.createBindGroupLayout({
    label: "warp-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 } }
    ]
  });

  Visual.warpPipeline = Visual.device.createRenderPipeline({
    label: "warp-pipeline",
    layout: Visual.device.createPipelineLayout({
      bindGroupLayouts: [Visual.warpBindGroupLayout]
    }),
    vertex: {
      module, entryPoint: "vs_main",
      buffers: [{
        arrayStride: 20,                      // 5 floats × 4 bytes
        attributes: [
          { shaderLocation: 0, offset: 0,  format: "float32x2" }, // x, y
          { shaderLocation: 1, offset: 8,  format: "float32x2" }, // u, v
          { shaderLocation: 2, offset: 16, format: "float32"   }  // intensity
        ]
      }]
    },
    fragment: {
      module, entryPoint: "fs_main",
      targets: [{ format: Visual.presentationFormat }]
    },
    primitive: { topology: "triangle-list" }
  });

  // RIG_MAX_DISPLAYS slots × 256 B alignment. Each slot = 16 B used:
  //   offset 0:  layer u32
  //   offset 4:  gamma f32
  //   offset 8:  blackLift f32
  //   offset 12: power f32
  Visual.warpUniformBuffer = Visual.device.createBuffer({
    label: "warp-uniform",
    size: RIG_MAX_DISPLAYS * Visual.warpUniformStride,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
}

/* Rebuild the warp bind group when the framebuffer texture array
 * changes (display count or resolution change re-allocates the FBO).
 * Same shape as the rig composite bind group rebuild — fixed layout,
 * texture array view + sampler + uniform get re-bound. The uniform
 * binding sets size to 16 (one slot) so dynamic offsets address one
 * slot at a time. */
function _rebuildWarpBindGroup() {
  if (!Visual.device || !Visual.framebufferArrayView ||
      !Visual.warpBindGroupLayout || !Visual.blitSampler ||
      !Visual.warpUniformBuffer) return;
  Visual.warpBindGroup = Visual.device.createBindGroup({
    label: "warp-bg",
    layout: Visual.warpBindGroupLayout,
    entries: [
      { binding: 0, resource: Visual.framebufferArrayView },
      { binding: 1, resource: Visual.blitSampler },
      { binding: 2, resource: { buffer: Visual.warpUniformBuffer, offset: 0, size: 16 } }
    ]
  });
}

/* Build (or update in place) the per-display vertex + index buffers
 * for a display's warpMesh. Returns the cache entry on success or
 * null on failure (invalid mesh, no device). Buffers are allocated
 * lazily — first frame after a mesh appears is the only frame that
 * pays the GPUBuffer-create cost; subsequent frames reuse the buffer
 * and just writeBuffer the new vert data.
 *
 * Cache key is the display.id string. Re-allocates the GPU buffer
 * only when the mesh's vertex / index count changes (the cached
 * "sig" is "cols×rows"); position-only edits of the same-size mesh
 * are an in-place writeBuffer. */
function _buildOrUpdateWarpMeshBuffers(display) {
  if (!Visual.device || !display || !_validateWarpMesh(display.warpMesh)) return null;
  const mesh = display.warpMesh;
  const W = mesh.cols + 1, H = mesh.rows + 1;
  const vertCount = W * H;
  const idxCount  = mesh.cols * mesh.rows * 6;
  const sig = mesh.cols + "x" + mesh.rows;

  let entry = Visual._warpCache.get(display.id);
  if (!entry) {
    entry = { vBuffer: null, iBuffer: null, indexCount: 0, vCapacity: 0, iCapacity: 0, sig: "" };
    Visual._warpCache.set(display.id, entry);
  }

  // Re-allocate GPU buffers if mesh dimensions changed.
  if (entry.sig !== sig) {
    if (entry.vBuffer) entry.vBuffer.destroy();
    if (entry.iBuffer) entry.iBuffer.destroy();
    // Round size up to multiple of 4 (WebGPU buffer requirement).
    const vBytes = Math.ceil(vertCount * 5 * 4 / 4) * 4;
    const iBytes = Math.ceil(idxCount  * 2     / 4) * 4;
    entry.vBuffer = Visual.device.createBuffer({
      label: "warp-verts:" + display.id,
      size: vBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    entry.iBuffer = Visual.device.createBuffer({
      label: "warp-indices:" + display.id,
      size: iBytes,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    entry.vCapacity = vertCount;
    entry.iCapacity = idxCount;
    entry.sig = sig;
    // Index buffer: build once, write once. Order is consistent
    // across same-dim meshes so subsequent updates skip this.
    const indices = new Uint16Array(idxCount);
    let k = 0;
    for (let r = 0; r < mesh.rows; r++) {
      for (let c = 0; c < mesh.cols; c++) {
        const tl =  r      * W + c;
        const tr = tl + 1;
        const bl = (r + 1) * W + c;
        const br = bl + 1;
        // Triangle 1: tl, bl, tr; Triangle 2: tr, bl, br.
        // Counter-clockwise winding when y is up; primitive face
        // culling is off in our pipeline so winding is moot anyway.
        indices[k++] = tl; indices[k++] = bl; indices[k++] = tr;
        indices[k++] = tr; indices[k++] = bl; indices[k++] = br;
      }
    }
    Visual.device.queue.writeBuffer(entry.iBuffer, 0, indices.buffer, indices.byteOffset, indices.byteLength);
  }

  // Always write fresh vertex data — handles in-place position edits
  // from the warp editor without needing change-detection plumbing.
  // For the typical 8×8 mesh that's 1620 B/frame at most — negligible.
  const verts = new Float32Array(mesh.verts);
  Visual.device.queue.writeBuffer(entry.vBuffer, 0, verts.buffer, verts.byteOffset, verts.byteLength);
  entry.indexCount = idxCount;
  return entry;
}

/* Encode the warp passes — one render pass per warped display, each
 * setting a viewport on its tile and drawing the cached mesh. Loaded
 * (not cleared) so the un-warped composite remains visible behind /
 * around the warped tiles. Returns the number of warped displays
 * drawn. Skips entirely in non-tile preview modes. */
function _encodeWarpPasses(enc) {
  if (!Visual.device || !Visual.context || !Visual.warpPipeline ||
      !Visual.warpBindGroup || !Visual.warpUniformBuffer) return 0;
  const mode = (state && state.rig && state.rig.previewMode) || "tile";
  if (mode !== "tile") return 0;
  const displays = (state && state.rig && state.rig.displays) || [];
  const layerCount = Math.min(Visual.framebufferLayerViews.length || 0, displays.length, RIG_MAX_DISPLAYS);
  if (layerCount === 0) return 0;

  // Viewport math — same tile layout as the composite.
  const { cols, rows } = _rigTileLayout(layerCount);
  const masterAspect = _projectionMasterAspect();
  const vp = _projectionViewportRect(masterAspect);
  const tileW = vp.w / cols;
  const tileH = vp.h / rows;

  // Pre-pack the per-display uniform slots and write the whole buffer
  // once. Each slot = (layer u32, gamma f32, blackLift f32, power f32);
  // remaining bytes per 256 B slot stay zero.
  const slotF = Visual.warpUniformStride / 4;        // floats per slot
  const ubuf  = new ArrayBuffer(layerCount * Visual.warpUniformStride);
  const ubF32 = new Float32Array(ubuf);
  const ubU32 = new Uint32Array(ubuf);
  for (let i = 0; i < layerCount; i++) {
    const d = displays[i] || {};
    const eb = d.edgeBlend || _defaultEdgeBlend();
    ubU32[i * slotF + 0] = i;
    ubF32[i * slotF + 1] = eb.gamma;
    ubF32[i * slotF + 2] = eb.blackLift;
    ubF32[i * slotF + 3] = eb.power;
  }
  Visual.device.queue.writeBuffer(Visual.warpUniformBuffer, 0, ubuf);

  let canvasView;
  try { canvasView = Visual.context.getCurrentTexture().createView(); }
  catch (e) { return 0; }

  let drawn = 0;
  for (let i = 0; i < layerCount; i++) {
    const d = displays[i];
    if (!d || !d.warpMesh) continue;            // un-warped: skip
    const entry = _buildOrUpdateWarpMeshBuffers(d);
    if (!entry) continue;

    const col = i % cols;
    const row = Math.floor(i / cols);
    const tx  = vp.x + col * tileW;
    const ty  = vp.y + row * tileH;

    const pass = enc.beginRenderPass({
      label: "warp:" + d.id,
      colorAttachments: [{
        view: canvasView,
        loadOp: "load",
        storeOp: "store"
      }]
    });
    pass.setPipeline(Visual.warpPipeline);
    pass.setBindGroup(0, Visual.warpBindGroup, [i * Visual.warpUniformStride]);
    pass.setVertexBuffer(0, entry.vBuffer);
    pass.setIndexBuffer(entry.iBuffer, "uint16");
    pass.setViewport(tx, ty, tileW, tileH, 0, 1);
    pass.drawIndexed(entry.indexCount);
    pass.end();
    drawn++;
  }
  return drawn;
}

