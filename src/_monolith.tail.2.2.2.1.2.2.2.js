function _ensureSpriteBindGroupLayout() {
  if (Visual.spriteBindGroupLayout) return Visual.spriteBindGroupLayout;
  if (!Visual.device) return null;
  Visual.spriteBindGroupLayout = Visual.device.createBindGroupLayout({
    label: "sprite-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
    ]
  });
  Visual.spritePipelineLayout = Visual.device.createPipelineLayout({
    label: "sprite-pl",
    bindGroupLayouts: [Visual.spriteBindGroupLayout]
  });
  return Visual.spriteBindGroupLayout;
}

function _ensureSpriteShaderModule() {
  if (Visual.spriteShaderModule) return Visual.spriteShaderModule;
  if (!Visual.device) return null;
  let mod;
  try {
    mod = Visual.device.createShaderModule({ label: "sprite-shader", code: _SPRITE_WGSL });
  } catch (e) {
    console.warn("[sprite] shader compile failed:", e);
    return null;
  }
  Visual.spriteShaderModule = mod;
  mod.getCompilationInfo().then(info => {
    const errs = info.messages.filter(m => m.type === "error");
    if (errs.length) {
      console.error("[sprite] shader WGSL errors:");
      for (const m of errs) {
        console.error("  line " + m.lineNum + " col " + m.linePos + ": " + m.message);
      }
    }
  });
  return mod;
}

function _ensureSpritePipeline(sampleCount) {
  const key = sampleCount;
  if (Visual.spritePipelineCache.has(key)) {
    return Visual.spritePipelineCache.get(key);
  }
  if (!Visual.device) return null;
  if (!_ensureSpriteBindGroupLayout()) return null;
  const module = _ensureSpriteShaderModule();
  if (!module) return null;
  let pipeline;
  try {
    pipeline = Visual.device.createRenderPipeline({
      label: "sprite-pipeline-" + sampleCount + "x",
      layout: Visual.spritePipelineLayout,
      vertex: {
        module,
        entryPoint: "vs_sprite",
        buffers: [{
          arrayStride: 11 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0,     format: "float32x3" },  // position
            { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },  // color
            { shaderLocation: 2, offset: 6 * 4, format: "float32x3" },  // normal (unused)
            { shaderLocation: 3, offset: 9 * 4, format: "float32x2" }   // uv
          ]
        }]
      },
      fragment: {
        module,
        entryPoint: "fs_sprite",
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
        // Reverse-Z compare matches the mesh pipeline so sprites
        // composite correctly with 3D meshes in the same scene.
        depthCompare: "greater",
        depthWriteEnabled: true
      },
      multisample: { count: sampleCount }
    });
  } catch (e) {
    console.warn("[sprite] pipeline " + sampleCount + "x failed:", e);
    return null;
  }
  Visual.spritePipelineCache.set(key, pipeline);
  if (!Visual._spriteFirstPipelineLogged) {
    Visual._spriteFirstPipelineLogged = true;
    console.log("[sprite] first pipeline built (sampleCount=" + sampleCount + "x, fbFormat=" + Visual.fbFormat + ")");
  }
  return pipeline;
}

/* Return (or create) a cached GPUSampler for the given filter mode.
 * Sprites with `filterMode: "nearest"` get crisp pixel-art edges;
 * "linear" gets bilinear-filtered smooth sampling. Both clamp at
 * the texture edge (sprite UV is always 0..cellW × 0..cellH, never
 * sampled outside its frame's sub-rect). */
function _ensureSpriteSampler(filterMode, wrapMode) {
  const fk = (filterMode === "linear") ? "linear" : "nearest";
  // Sprint platformer-parallax -- per-axis wrap mode. Parallax layers
  // need repeat-U so the bg can cycle indefinitely as the camera moves
  // through the level without UV running off the texture edge. Default
  // stays clamp so existing Sprite / TileSpriteOverlay behavior doesn't
  // change. wrapMode = "clamp" | "repeat" | "repeat-x" | "repeat-y".
  let wU = "clamp-to-edge", wV = "clamp-to-edge";
  if (wrapMode === "repeat") { wU = "repeat"; wV = "repeat"; }
  else if (wrapMode === "repeat-x") { wU = "repeat"; }
  else if (wrapMode === "repeat-y") { wV = "repeat"; }
  const key = fk + ":" + wU + ":" + wV;
  if (Visual.spriteSamplers.has(key)) return Visual.spriteSamplers.get(key);
  if (!Visual.device) return null;
  const sampler = Visual.device.createSampler({
    label: "sprite-sampler-" + key,
    magFilter: fk,
    minFilter: fk,
    mipmapFilter: fk,
    addressModeU: wU,
    addressModeV: wV
  });
  Visual.spriteSamplers.set(key, sampler);
  return sampler;
}

/* Per-sprite-node draw-state allocator. Creates the uniform buffer +
 * bind group ONCE per sprite node, then updates the bind group only
 * when the bound texture view (or sampler filter mode) changes. The
 * uniform is rewritten every frame from `scratch` via writeBuffer. */
function _ensureSpriteInstance(spriteNode, textureView, sampler) {
  if (!Visual.device) return null;
  let inst = Visual.spriteInstances.get(spriteNode.id);
  if (!inst) {
    const uniformBuffer = Visual.device.createBuffer({
      label: "sprite-draw-uniform-" + spriteNode.id,
      // 24 floats × 4 bytes = 96 bytes; round up to 256 for safety
      // (some implementations want larger min uniform size).
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    inst = {
      uniformBuffer,
      bindGroup: null,
      boundTextureView: null,
      boundSampler: null,
      scratch: new Float32Array(24)
    };
    Visual.spriteInstances.set(spriteNode.id, inst);
  }
  // Rebuild bind group when texture view or sampler swaps (e.g., the
  // ImageURL finishes loading, or the user changes filterMode).
  if (inst.boundTextureView !== textureView || inst.boundSampler !== sampler) {
    inst.bindGroup = Visual.device.createBindGroup({
      label: "sprite-bg-" + spriteNode.id,
      layout: Visual.spriteBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: inst.uniformBuffer } },
        { binding: 1, resource: textureView },
        { binding: 2, resource: sampler }
      ]
    });
    inst.boundTextureView = textureView;
    inst.boundSampler = sampler;
  }
  return inst;
}

/* Sprint 7.5.4.c-sky -- background sky pipeline. Shares the same
 * pipeline layout as mesh pipelines (binding 0 = perScene) but
 * uses a different vertex / fragment entry pair (vs_sky / fs_sky)
 * and depth-state: less-equal compare + no depth write. Drawn AT
 * the end of the Scene mesh draws so the depth buffer is already
 * populated; sky fragments only land on pixels with depth == 1
 * (i.e. nothing covered them). No vertex buffer -- the shader
 * builds its own positions from @builtin(vertex_index). Cached
 * per sample count because pipelines are MSAA-keyed in WebGPU. */
function _ensureSkyPipeline(sampleCount) {
  if (!Number.isFinite(sampleCount) || sampleCount < 1) sampleCount = 1;
  if (!Visual._skyPipelineCache) Visual._skyPipelineCache = new Map();
  const key = "sky-" + sampleCount + "x";
  if (Visual._skyPipelineCache.has(key)) {
    return Visual._skyPipelineCache.get(key);
  }
  if (!Visual.device) return null;
  if (!_ensureMeshBindGroupLayout()) return null;
  // Reuse Visual.meshShaderModule; vs_sky / fs_sky live in the same
  // shared mesh shader source as fs_pbr.
  if (!Visual.meshShaderModule) {
    try {
      Visual.meshShaderModule = Visual.device.createShaderModule({
        label: "mesh-shader", code: _MESH_WGSL
      });
    } catch (e) {
      console.warn("[scene] mesh shader compile failed (sky):", e);
      return null;
    }
  }
  let pipeline;
  try {
    pipeline = Visual.device.createRenderPipeline({
      label: "sky-pipeline-" + sampleCount + "x",
      layout: Visual.meshPipelineLayout,
      vertex: { module: Visual.meshShaderModule, entryPoint: "vs_sky" },
      fragment: {
        module: Visual.meshShaderModule,
        entryPoint: "fs_sky",
        targets: [{ format: Visual.fbFormat }]
      },
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
      depthStencil: {
        format: "depth32float",
        // §planet-spec Phase 1 -- reverse-Z. Sky vertex writes ndc_z=0
        // (the new "far plane"); pass where depth still == 0 (no mesh
        // has drawn anything closer to ndc_z=1).
        depthCompare: "greater-equal",
        depthWriteEnabled: false
      },
      multisample: { count: sampleCount }
    });
  } catch (e) {
    console.warn("[scene] sky pipeline " + sampleCount + "x failed:", e);
    return null;
  }
  Visual._skyPipelineCache.set(key, pipeline);
  return pipeline;
}

