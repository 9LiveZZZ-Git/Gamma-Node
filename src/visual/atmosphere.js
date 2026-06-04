function _ensureAtmosphereLUTs() {
  if (!Visual.device) return null;
  if (Visual._atmLutsReady) return Visual._atmLutsReady;

  const dev = Visual.device;

  // Default 1x1 textures for "no planet wired" -- BGL needs a binding
  // even when LUTs aren't meaningful. Black RGBA so any accidental
  // sample returns zero contribution.
  if (!Visual.atmLut1x1Default) {
    Visual.atmLut1x1Default = dev.createTexture({
      label: "atm-lut-default-1x1",
      size: [1, 1, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const zero = new Uint16Array([0, 0, 0, 0]);
    dev.queue.writeTexture(
      { texture: Visual.atmLut1x1Default },
      zero,
      { bytesPerRow: 8 },
      { width: 1, height: 1, depthOrArrayLayers: 1 }
    );
    Visual.atmLut1x1DefaultView = Visual.atmLut1x1Default.createView({
      label: "atm-lut-default-1x1-view"
    });
  }

  if (!Visual.atmTransmittanceLUT) {
    Visual.atmTransmittanceLUT = dev.createTexture({
      label: "atm-transmittance-lut-256x64",
      size: [256, 64, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    Visual.atmTransmittanceLUTView = Visual.atmTransmittanceLUT.createView({
      label: "atm-transmittance-lut-view"
    });
  }
  if (!Visual.atmMultiScatterLUT) {
    Visual.atmMultiScatterLUT = dev.createTexture({
      label: "atm-multiscatter-lut-32x32",
      size: [32, 32, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    Visual.atmMultiScatterLUTView = Visual.atmMultiScatterLUT.createView({
      label: "atm-multiscatter-lut-view"
    });
  }
  // C.4 -- Sky-view LUT. 384 x 216 covers the full sphere in
  // (azimuth, elevation) with horizon-weighted v for finer sampling
  // near the horizon where atmospheric detail is highest. Regenerated
  // every frame in lock-step with the camera position.
  //
  // 2026-05-22 bump 192x108 -> 384x216: at orbital altitudes the
  // limb angle from nadir is acos(planetR/(planetR+h)) which shifts
  // about 0.7 LUT rows per 50km of altitude on the previous
  // resolution; the row boundary moving across the limb produced a
  // visible brightness "pulse" as the user climbed. 4x pixels at
  // 256-byte cost per pixel is still tiny; LUT generation stays
  // sub-millisecond on modern GPUs.
  if (!Visual.atmSkyViewLUT) {
    Visual.atmSkyViewLUT = dev.createTexture({
      label: "atm-skyview-lut-384x216",
      size: [384, 216, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    Visual.atmSkyViewLUTView = Visual.atmSkyViewLUT.createView({
      label: "atm-skyview-lut-view"
    });
  }
  // C.7 cleanup -- the aerial-perspective LUT pair (3D-style 2D-array
  // textures + per-layer views + their pipeline + slice buffer +
  // slice BGL) used to live here. Removed after the structural fix
  // (sample_aerial_perspective_lut now reads sky-view + transmittance
  // LUTs directly with no depth axis = no ring banding). Frees ~128 MB
  // of GPU memory and ~128 render passes / frame.

  if (!Visual.atmLutSampler) {
    Visual.atmLutSampler = dev.createSampler({
      label: "atm-lut-sampler",
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge"
    });
  }

  if (!Visual.atmLutUniformBuffer) {
    Visual.atmLutUniformBuffer = dev.createBuffer({
      label: "atm-lut-uniforms",
      // 5 * vec4<f32> = 80 bytes (planet, atm, sun, misc, camera). The
      // camera basis slots that C.5 added were dropped in C.7 cleanup
      // alongside the aerial-perspective LUT removal.
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    Visual.atmLutScratch = new Float32Array(20);
  }
  // C.7 cleanup -- slice buffer / scratch removed alongside the
  // aerial-perspective LUT pipeline.

  if (!Visual.atmLutShaderModule) {
    try {
      Visual.atmLutShaderModule = dev.createShaderModule({
        label: "atm-lut-shader", code: _ATM_LUT_WGSL
      });
    } catch (e) {
      console.warn("[atm-lut] shader module compile failed:", e);
      return null;
    }
  }

  // All three LUT pipelines share a single BGL:
  //   0 = uniform buffer (planet + atm + sun + misc + camera)
  //   1 = transmittance LUT texture (sampled by multi-scatter + sky-view)
  //   2 = multi-scatter LUT texture (sampled by sky-view)
  //   3 = linear/clamp sampler
  // Bindings the entry-point doesn't reach (e.g. ttex/mtex in
  // fs_lut_transmittance) are still required to be present in the
  // bind group; we point them at the 1x1 default.
  if (!Visual.atmLutBGL) {
    Visual.atmLutBGL = dev.createBindGroupLayout({
      label: "atm-lut-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
      ]
    });
  }

  if (!Visual.atmTransmittancePipeline) {
    try {
      Visual.atmTransmittancePipeline = dev.createRenderPipeline({
        label: "atm-transmittance-pipeline",
        layout: dev.createPipelineLayout({
          label: "atm-lut-pl",
          bindGroupLayouts: [Visual.atmLutBGL]
        }),
        vertex:   { module: Visual.atmLutShaderModule, entryPoint: "vs_lut" },
        fragment: {
          module: Visual.atmLutShaderModule,
          entryPoint: "fs_lut_transmittance",
          targets: [{ format: "rgba16float" }]
        },
        primitive: { topology: "triangle-list", cullMode: "none" }
      });
    } catch (e) {
      console.warn("[atm-lut] transmittance pipeline failed:", e);
      return null;
    }
  }
  if (!Visual.atmMultiScatterPipeline) {
    try {
      Visual.atmMultiScatterPipeline = dev.createRenderPipeline({
        label: "atm-multiscatter-pipeline",
        layout: dev.createPipelineLayout({
          label: "atm-lut-pl-ms",
          bindGroupLayouts: [Visual.atmLutBGL]
        }),
        vertex:   { module: Visual.atmLutShaderModule, entryPoint: "vs_lut" },
        fragment: {
          module: Visual.atmLutShaderModule,
          entryPoint: "fs_lut_multiscatter",
          targets: [{ format: "rgba16float" }]
        },
        primitive: { topology: "triangle-list", cullMode: "none" }
      });
    } catch (e) {
      console.warn("[atm-lut] multi-scatter pipeline failed:", e);
      return null;
    }
  }
  if (!Visual.atmSkyViewPipeline) {
    try {
      Visual.atmSkyViewPipeline = dev.createRenderPipeline({
        label: "atm-skyview-pipeline",
        layout: dev.createPipelineLayout({
          label: "atm-lut-pl-sv",
          bindGroupLayouts: [Visual.atmLutBGL]
        }),
        vertex:   { module: Visual.atmLutShaderModule, entryPoint: "vs_lut" },
        fragment: {
          module: Visual.atmLutShaderModule,
          entryPoint: "fs_lut_skyview",
          targets: [{ format: "rgba16float" }]
        },
        primitive: { topology: "triangle-list", cullMode: "none" }
      });
    } catch (e) {
      console.warn("[atm-lut] sky-view pipeline failed:", e);
      return null;
    }
  }

  // Bind groups: each LUT pipeline reads only the LUTs that came before
  // it. The 1x1 default fills slots the entry point never reaches.
  if (!Visual.atmTransmittanceBindGroup) {
    Visual.atmTransmittanceBindGroup = dev.createBindGroup({
      label: "atm-transmittance-bg",
      layout: Visual.atmLutBGL,
      entries: [
        { binding: 0, resource: { buffer: Visual.atmLutUniformBuffer } },
        { binding: 1, resource: Visual.atmLut1x1DefaultView },
        { binding: 2, resource: Visual.atmLut1x1DefaultView },
        { binding: 3, resource: Visual.atmLutSampler }
      ]
    });
  }
  if (!Visual.atmMultiScatterBindGroup) {
    Visual.atmMultiScatterBindGroup = dev.createBindGroup({
      label: "atm-multiscatter-bg",
      layout: Visual.atmLutBGL,
      entries: [
        { binding: 0, resource: { buffer: Visual.atmLutUniformBuffer } },
        { binding: 1, resource: Visual.atmTransmittanceLUTView },
        { binding: 2, resource: Visual.atmLut1x1DefaultView },
        { binding: 3, resource: Visual.atmLutSampler }
      ]
    });
  }
  if (!Visual.atmSkyViewBindGroup) {
    Visual.atmSkyViewBindGroup = dev.createBindGroup({
      label: "atm-skyview-bg",
      layout: Visual.atmLutBGL,
      entries: [
        { binding: 0, resource: { buffer: Visual.atmLutUniformBuffer } },
        { binding: 1, resource: Visual.atmTransmittanceLUTView },
        { binding: 2, resource: Visual.atmMultiScatterLUTView },
        { binding: 3, resource: Visual.atmLutSampler }
      ]
    });
  }

  // C.7 cleanup -- aerial-perspective slice BGL, slice bind group,
  // and pipeline removed.

  Visual._atmLutsReady = true;
  return true;
}

/* Per-frame dispatch: writes both LUTs assuming the caller has a
 * GPUCommandEncoder open. Called by the visual frame loop ONCE per
 * frame BEFORE any scene pass that might sample the LUTs. The same
 * LUTs are shared across all scenes in a frame -- the planet params
 * shouldn't change mid-frame, and the LUTs are camera-independent. */
function _renderAtmosphereLUTs(enc, planetInfo, camera, sunDirOverride) {
  if (!_ensureAtmosphereLUTs()) return false;
  // Skip LUT regeneration when no planet is wired -- the BGL has the
  // 1x1 default bound at the mesh-pass binding and _atm_integrate
  // guards on uS.envPlanet.w > 0 anyway.
  if (!planetInfo || !(planetInfo.radius > 0)) {
    Visual._atmLutsHavePlanetData = false;
    return false;
  }

  const dev = Visual.device;
  const planetR = planetInfo.radius;
  const atmTop  = planetR * 1.0157;
  const scaleHR = planetR * 0.001334;
  const scaleHM = planetR * 0.000188;
  const sunI    = 22.0;
  const turbidity = (typeof planetInfo.turbidity === "number") ? planetInfo.turbidity : 1.3;
  const polRatio  = (typeof planetInfo.polRatio  === "number" && planetInfo.polRatio > 0)
    ? planetInfo.polRatio : 1.0;
  const sunDir = (sunDirOverride && sunDirOverride.length >= 3)
    ? sunDirOverride
    : ((planetInfo.sunDir && planetInfo.sunDir.length >= 3)
        ? planetInfo.sunDir
        : [0, 1, 0]);
  // Sky-view LUT only needs the camera position (the local frame is
  // derived in-shader from eye - planetCenter).
  const eye = (camera && camera.eye) ? camera.eye : [0, 0, 0];

  const u = Visual.atmLutScratch;
  u[0] = planetInfo.centerX || 0;
  u[1] = planetInfo.centerY || 0;
  u[2] = planetInfo.centerZ || 0;
  u[3] = planetR;
  u[4] = atmTop;
  u[5] = scaleHR;
  u[6] = scaleHM;
  u[7] = sunI;
  u[8]  = sunDir[0]; u[9] = sunDir[1]; u[10] = sunDir[2];
  u[11] = (typeof planetInfo.mieG === "number") ? planetInfo.mieG : 0.76;
  u[12] = turbidity;
  u[13] = polRatio;
  u[14] = 256;
  u[15] = 64;
  // C.4 camera slot. (C.5's camera-basis vec4s were here too; removed
  // in C.7 cleanup alongside the aerial-perspective LUT.)
  u[16] = eye[0]; u[17] = eye[1]; u[18] = eye[2]; u[19] = 0;

  dev.queue.writeBuffer(Visual.atmLutUniformBuffer, 0, u.buffer, 0, 80);

  // Transmittance LUT.
  {
    const pass = enc.beginRenderPass({
      label: "atm-transmittance-lut-pass",
      colorAttachments: [{
        view: Visual.atmTransmittanceLUTView,
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(Visual.atmTransmittancePipeline);
    pass.setBindGroup(0, Visual.atmTransmittanceBindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }
  // Multi-scattering LUT (samples transmittance LUT just written).
  {
    const pass = enc.beginRenderPass({
      label: "atm-multiscatter-lut-pass",
      colorAttachments: [{
        view: Visual.atmMultiScatterLUTView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(Visual.atmMultiScatterPipeline);
    pass.setBindGroup(0, Visual.atmMultiScatterBindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }
  // Sky-view LUT (samples transmittance + multi-scatter LUTs).
  if (Visual.atmSkyViewPipeline && Visual.atmSkyViewBindGroup) {
    const pass = enc.beginRenderPass({
      label: "atm-skyview-lut-pass",
      colorAttachments: [{
        view: Visual.atmSkyViewLUTView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(Visual.atmSkyViewPipeline);
    pass.setBindGroup(0, Visual.atmSkyViewBindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  Visual._atmLutsHavePlanetData = true;
  return true;
}

