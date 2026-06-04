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

/* Build / fetch a mesh's GPU buffers. DebugTriangle is the only
 * mesh-gen kind in sprint 7.5.3a; future primitives will dispatch
 * here based on node.type with vertex data built procedurally
 * (Box: 36 verts + indices; Sphere: stacks*slices interpolated;
 * etc). Cache keyed by node.id; invalidated when params that change
 * geometry change (sprint 7.5.3b handles invalidation via a
 * version counter set when relevant params mutate). */
function _ensureMeshBuffers(meshEntry) {
  const node = meshEntry.node;
  // Phase 8 sprint 8-7b: synthesized detail-patch entries (added by
  // _resolveSceneMeshes when a PlanetMesh is in the scene) share the
  // PlanetMesh node but use a static (u, v) grid buffer cached
  // globally per gridDim.
  if (meshEntry.isPlanetDetailPatch) {
    const gridDim = Math.max(2, Math.min(256, Math.floor(
      (node.params && node.params.detailPatchGridDim) || 96
    )));
    return _ensurePlanetDetailPatchBuffer(gridDim);
  }
  // §5.5.e-6 -- TiledTerrain uses incremental per-chunk streaming
  // (own VBO+IBO per chunk, dropped/built individually as the camera
  // disc shifts). Route to the dedicated path so the monolithic
  // cache-or-rebuild logic below is bypassed entirely.
  if (node.type === "TiledTerrain") {
    return _ensureTiledTerrainChunks(node);
  }
  if (node.type === "Clouds3D") {
    return _ensureClouds3DChunks(node);
  }
  // §planet-spec Phase 6b -- Planet uses the same per-chunk streaming
  // pattern (per-chunk VBOs + two-phase placeholder/upgrade build under
  // a time budget) so deep maxDepth + flying close to the surface
  // doesn't stall the main thread on monolithic-mesh rebuilds.
  if (node.type === "Planet") {
    return _ensurePlanetChunks(node);
  }
  // Sprint 9-2: PlanetMesh routes through the cube-sphere quadtree
  // streaming path (same per-chunk pattern Planet uses, but reading
  // elevation from the wired PlanetMap's cell graph). Replaces the
  // sprint 9-1 static cube-sphere single-mesh builder, which is now
  // unreachable but kept in the file as a reference fallback.
  if (node.type === "PlanetMesh") {
    return _ensurePlanetMeshChunks(node);
  }
  const cached = Visual.meshBufferCache.get(node.id);
  if (cached && _meshCacheKey(node) === cached.cacheKey) return cached;
  // Params changed -- destroy + rebuild. Cheap (just a couple of
  // GPU buffers); avoids stale geometry when the user tweaks
  // dimensions in the props pane.
  if (cached) {
    try { cached.vertexBuffer && cached.vertexBuffer.destroy(); } catch (_) {}
    try { cached.indexBuffer  && cached.indexBuffer.destroy();  } catch (_) {}
    Visual.meshBufferCache.delete(node.id);
  }
  if (!Visual.device) return null;
  const built = _buildMeshData(node);
  if (!built) return null;
  const { verts, indices, chunks } = built;
  const vertexBuffer = Visual.device.createBuffer({
    label: "mesh-vb-" + node.id,
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(verts);
  vertexBuffer.unmap();
  let indexBuffer = null, indexCount = 0;
  if (indices) {
    indexBuffer = Visual.device.createBuffer({
      label: "mesh-ib-" + node.id,
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint32Array(indexBuffer.getMappedRange()).set(indices);
    indexBuffer.unmap();
    indexCount = indices.length;
  }
  // Sprint 5.10 -- compute the local-space AABB from vertex data so
  // the encoder can frustum-cull this mesh. Cheap (one pass over
  // verts) and cached alongside the GPU buffers; invalidated by the
  // same cacheKey check above when geometry params change.
  const aabb = _computeLocalAABB(verts);
  const out = {
    vertexBuffer,
    vertexCount: verts.length / 11,  // Sprint 7.5.3c push 6: 11 floats per vertex (pos + color + normal + uv)
    indexBuffer,
    indexCount,
    cacheKey: _meshCacheKey(node),
    aabbMin: aabb.min,
    aabbMax: aabb.max,
    // §5.5.e-2 -- per-chunk draw ranges + AABBs. Only set for
    // TiledTerrain (it's the only mesh-gen that emits chunks[]
    // from _buildMeshData). When present, the encoder issues one
    // drawIndexed per visible chunk + skips off-frustum chunks.
    chunks: chunks || null
  };
  Visual.meshBufferCache.set(node.id, out);
  return out;
}

/* Sprint 5.10 -- local-space AABB from interleaved vertex data.
 * Vertex stride is 11 floats: pos (3) + color (3) + normal (3) + uv
 * (2); position is at indices 0..2. Returns { min: [x,y,z], max:
 * [x,y,z] }. Empty verts -> degenerate zero-size AABB at origin
 * (caller's cull test treats this as outside the frustum). */
function _computeLocalAABB(verts) {
  if (!verts || verts.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const stride = 11;
  const n = verts.length / stride;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = i * stride;
    const px = verts[k], py = verts[k + 1], pz = verts[k + 2];
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/* Sprint 5.10 -- AABB-vs-frustum test. 6-plane SAT: for each plane
 * (a, b, c, d) with normal pointing inside the frustum, find the
 * AABB corner farthest along the normal (the "positive corner");
 * if even that corner is on the negative side of the plane, the
 * AABB is fully outside the frustum -> cull. Otherwise either
 * intersecting or inside -> draw.
 *
 * worldMin / worldMax are the WORLD-SPACE AABB after transforming
 * the local-space AABB through the mesh's model matrix. Cheap to
 * derive: pass the 8 local corners through the matrix + take new
 * min/max. */
function _aabbInsideFrustum(planes, worldMin, worldMax) {
  for (let p = 0; p < 6; p++) {
    const a = planes[p * 4 + 0];
    const b = planes[p * 4 + 1];
    const c = planes[p * 4 + 2];
    const d = planes[p * 4 + 3];
    const px = (a > 0) ? worldMax[0] : worldMin[0];
    const py = (b > 0) ? worldMax[1] : worldMin[1];
    const pz = (c > 0) ? worldMax[2] : worldMin[2];
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/* Sprint 5.10 -- transform a local AABB through a model matrix to
 * get the world-space AABB. Transforms all 8 corners then takes
 * min/max (vs the cheaper but less accurate "transform center +
 * extend by half-diagonal" — the 8-corner version is tight under
 * rotation, which matters when meshes are rotated 45° away from
 * axis-aligned). worldMin / worldMax are written into the supplied
 * Float32Array(3) outputs to avoid per-frame allocation. */
function _transformAABB(localMin, localMax, model, outMin, outMax) {
  let nx = Infinity, ny = Infinity, nz = Infinity;
  let xx = -Infinity, xy = -Infinity, xz = -Infinity;
  const m0 = model[0], m1 = model[1], m2 = model[2];
  const m4 = model[4], m5 = model[5], m6 = model[6];
  const m8 = model[8], m9 = model[9], m10 = model[10];
  const m12 = model[12], m13 = model[13], m14 = model[14];
  for (let i = 0; i < 8; i++) {
    const x = (i & 1) ? localMax[0] : localMin[0];
    const y = (i & 2) ? localMax[1] : localMin[1];
    const z = (i & 4) ? localMax[2] : localMin[2];
    const wx = m0 * x + m4 * y + m8  * z + m12;
    const wy = m1 * x + m5 * y + m9  * z + m13;
    const wz = m2 * x + m6 * y + m10 * z + m14;
    if (wx < nx) nx = wx; if (wx > xx) xx = wx;
    if (wy < ny) ny = wy; if (wy > xy) xy = wy;
    if (wz < nz) nz = wz; if (wz > xz) xz = wz;
  }
  outMin[0] = nx; outMin[1] = ny; outMin[2] = nz;
  outMax[0] = xx; outMax[1] = xy; outMax[2] = xz;
}

/* Param-fingerprint string used to invalidate the mesh cache when a
 * primitive's dimensions / segment counts change. Each primitive
 * type lists the params that actually affect geometry. */
function _meshCacheKey(node) {
  const p = node.params || {};
  switch (node.type) {
    case "DebugTriangle": return "tri:" + (p.scale || 1);
    case "Box":           return "box:" + [p.width, p.height, p.depth].join(",");
    case "Sphere":        return "sph:" + [p.radius, p.stacks, p.slices].join(",");
    case "Capsule":       return "cap:" + [p.radius, p.halfHeight, p.slices].join(",");
    case "DestructibleBody3D": return "destruct:" + node.id + ":" + (node.params && node.params.destroyed ? "d" + Math.floor(performance.now()) : "s");
    case "Rope3D":        return "rope:" + node.id + ":" + (node._ropeVer || 0);
    case "Cloth3D":       return "cloth:" + node.id + ":" + (node._clothVer || 0);
    case "SoftBody3D":    return "soft:" + node.id + ":" + (node._sbVer || 0);
    case "LoadGLB":       return "glb:" + node.id + ":" + (node.params && node.params.url) + ":" + (node.params && node.params.scale) + ":" + (node.params && node.params.autoFit) + ":" + (node._glbState || "") + ":" + (node._glbVer || 0);
    case "Planet":        {
      // §planet-spec Phase 4.c/e -- include a quantized PLANET-LOCAL
      // camera position so the quadtree rebuilds when the camera
      // crosses a finest-depth chunk boundary. Quantum = radius /
      // 2^maxDepth (≈ leaf-chunk edge near the camera). The center
      // params shift the cam-to-planet origin -- two Planet nodes at
      // different centers can share the same camera and still rebuild
      // independently.
      const r = (typeof p.radius === "number") ? p.radius : 1000;
      const md = Math.max(0, Math.min(14, Math.floor((typeof p.maxDepth === "number") ? p.maxDepth : 6)));
      const quantum = r / Math.pow(2, md);
      const cxC = (typeof p.centerX === "number") ? p.centerX : 0;
      const cyC = (typeof p.centerY === "number") ? p.centerY : 0;
      const czC = (typeof p.centerZ === "number") ? p.centerZ : 0;
      const c = _planetCameraPos(node);
      const qx = Math.round((c.x - cxC) / quantum);
      const qy = Math.round((c.y - cyC) / quantum);
      const qz = Math.round((c.z - czC) / quantum);
      return "plt:" + [
        p.radius, p.polarRadiusRatio,
        p.centerX, p.centerY, p.centerZ,
        p.segments, p.maxDepth, p.splitFactor,
        p.heightScale, p.seaLevel,
        p.seed, p.frequency, p.octaves, p.lacunarity, p.gain, p.ridges,
        qx, qy, qz
      ].join(",");
    }
    case "PlanetMesh":    {
      // §planet-spec Phase 7.d-azgaar -- cache key includes the wired
      // PlanetMap's cells key so editing PlanetMap (or its painter)
      // rebuilds the mesh from updated cell elevations.
      let pmKey = "no-map";
      if (state && Array.isArray(state.edges)) {
        const edge = state.edges.find(e =>
          e && e.to && e.to.node === node.id && e.to.port === "heightmap"
        );
        if (edge && edge.from) {
          const src = state.nodes.find(n => n && n.id === edge.from.node);
          if (src && src.type === "PlanetMap") {
            pmKey = _planetMapCacheKey(src);
          }
        }
      }
      return "pmesh:" + [
        p.radius, p.polarRadiusRatio,
        p.centerX, p.centerY, p.centerZ,
        p.heightScale, p.seaLevel,
        pmKey
      ].join(",");
    }
    case "Plane":         return "pln:" + [p.width, p.depth].join(",");
    case "Sprite":        return "spr:" + [p.width, p.height, p.anchorX, p.anchorY, p.tintR, p.tintG, p.tintB, p.tintA].join(",");
    case "Tilemap2D":     return "tmap:" + [p.tileData, p.tileSize, p.originX, p.originY,
                                            p.color1R, p.color1G, p.color1B,
                                            p.color2R, p.color2G, p.color2B,
                                            p.color3R, p.color3G, p.color3B,
                                            p.color4R, p.color4G, p.color4B,
                                            p.color5R, p.color5G, p.color5B,
                                            p.skipRenderChars,
                                            // Phase 2 tileset fields. tileMap object
                                            // stringified so JSON identity invalidates
                                            // when the user remaps chars.
                                            p.tileset || "",
                                            (typeof p.tileMap === "object" ? JSON.stringify(p.tileMap) : (p.tileMap || "")),
                                            p.tilesetFramesX || 0,
                                            p.tilesetFramesY || 0,
                                            p.depthZ || 0].join(",");
    case "TileSpriteOverlay": {
      // Cache key includes the wired tilemap's tileData + this node's
      // params so the overlay mesh rebuilds on tile-data mutation
      // (PickupCollector clearing collected eggs). Bob amplitude > 0
      // also bakes a time bucket into the key so the bob is visible.
      const tmap = (typeof _findWiredOrFirst === "function")
        ? _findWiredOrFirst(node, "tilemap", "Tilemap2D") : null;
      const tdata = tmap ? (tmap.params && tmap.params.tileData) || "" : "";
      const bobBucket = (p.bobAmplitude > 0)
        ? Math.floor(performance.now() / 60) : 0;
      return "tso:" + [
        tdata, p.tileChar, p.scale, p.anchorX, p.anchorY,
        p.frame, p.framesX, p.framesY,
        p.tintR, p.tintG, p.tintB, p.tintA,
        p.bobAmplitude, p.bobSpeed, bobBucket,
        p.depthZ
      ].join(",");
    }
    case "ParallaxLayer2D": {
      // Mesh follows the camera, so the cache key includes the
      // (quantized) camera position. 0.05 world-unit quantum is
      // small enough that scroll feels smooth + large enough that
      // we don't rebuild the mesh every render frame for static
      // cameras. Also include canvas dims so a resize rebuilds.
      let cposX = 0, cposY = 0;
      let camSrc = null;
      if (node._levelCameraNodeId) {
        camSrc = state.nodes.find(n => n && n.id === node._levelCameraNodeId);
      } else if (state && Array.isArray(state.edges)) {
        const wire = state.edges.find(e =>
          e && e.to && e.to.node === node.id && e.to.port === "camera"
        );
        if (wire && wire.from) {
          camSrc = state.nodes.find(n => n && n.id === wire.from.node);
        }
      }
      if (camSrc && camSrc.params) {
        cposX = camSrc.params.posX || 0;
        cposY = camSrc.params.posY || 0;
      }
      const qX = Math.round(cposX * 20) / 20;   // 0.05 unit quantum
      const qY = Math.round(cposY * 20) / 20;
      const cw = (typeof Visual !== "undefined" && Visual.canvas) ? (Visual.canvas.width  | 0) : 0;
      const ch = (typeof Visual !== "undefined" && Visual.canvas) ? (Visual.canvas.height | 0) : 0;
      return "plx:" + [
        qX, qY, cw, ch,
        p.parallaxX, p.texWorldWidth,
        p.screenScaleY, p.screenAnchorY, p.worldOffsetY,
        p.tintR, p.tintG, p.tintB, p.tintA,
        p.depthZ
      ].join(",");
    }
    case "SpriteScatter2D":
      return "ss2d:" + [
        p.positions, p.scale, p.anchorX, p.anchorY,
        p.frame, p.framesX, p.framesY,
        p.tintR, p.tintG, p.tintB, p.tintA,
        p.depthZ
      ].join(",");
    case "Torus":         return "tor:" + [p.majorRadius, p.minorRadius, p.majorSlices, p.minorSlices].join(",");
    case "Cylinder":      return "cyl:" + [p.radius, p.height, p.slices].join(",");
    case "Cone":          return "con:" + [p.radius, p.height, p.slices].join(",");
    case "Terrain":       {
      // v0.3.126 §5.5.c-3 -- include heightmap-wired state so the
      // mesh cache rebuilds when the user wires / unwires
      // ProceduralTerrain (flat-grid vs CPU-displaced).
      const wired = Array.isArray(state.edges) && state.edges.some(e =>
        e && e.to && e.to.node === node.id && e.to.port === "heightmap"
      );
      return "ter:" + [
        p.sizeMode, p.worldSize, p.heightScale, p.yOffset, p.segments,
        p.seed, p.frequency, p.octaves, p.lacunarity, p.gain, p.ridges,
        wired ? "g" : "c"
      ].join(",");
    }
    case "TerrainHorizon": {
      // §5.5.h-23 -- include the macro-tile in the key so crossing
      // tileSize triggers a rebuild centered on the new tile. Also
      // include the upstream TiledTerrain's noise params so the
      // horizon stays in sync with the chunked disc.
      const tile = _terrainHorizonMacroTile(node);
      const tt = (state && Array.isArray(state.nodes))
        ? state.nodes.find(n => n && n.type === "TiledTerrain") : null;
      const ttp = (tt && tt.params) || {};
      const ip  = tt ? _findTiledIslandParams(tt) : null;
      // §planet-spec Phase 1.5 -- visAltLow/visAltHigh DON'T need to
      // be in the cache key (the mesh geometry is identical at any
      // altitude; only the fragment shader's discard threshold
      // changes, and that's a per-frame uniform).
      // §planet-spec Phase 3 -- noiseFreqScale gone; octavesCap added.
      return "thr:" + [
        p.extent, p.subdivisions, p.tileSize, p.yBias, p.octavesCap,
        tile.tx, tile.tz,
        ttp.seed, ttp.frequency, ttp.octaves, ttp.lacunarity, ttp.gain,
        ttp.ridges, ttp.plateau, ttp.heightScale, ttp.yOffset,
        ip ? (ip.mode + ":" + ip.maskFreq + ":" + ip.maskSeed + ":" + ip.maskThreshold +
              ":" + ip.maskSoftness + ":" + ip.sinkDepth) : "i0"
      ].join(",");
    }
    // TiledTerrain doesn't use _meshCacheKey -- _ensureTiledTerrainChunks
    // manages its own per-chunk cache keyed by (tileX, tileZ, lod).
    case "Water":         {
      // §planet-spec Phase 6b -- with a Planet in the patch, Water is
      // a static 6-face cube-sphere shell wrapping the planet at sea
      // radius. Geometry depends only on Planet's center/radius/polRatio
      // and the seaLevel offset -- NOT on the camera (the sphere
      // wraps everything from any angle). No camera quantum needed.
      const planet = _findPlanetForProjection();
      if (planet) {
        return "water-sph:" + [
          p.seaLevel || 0,
          planet.cx, planet.cy, planet.cz, planet.r, planet.polRatio
        ].join(",");
      }
      return "water:" + (p.seaLevel || 0);
    }
    default:              return node.type;
  }
}

/* Build vertex + index arrays for a mesh-gen node. Returns {verts,
 * indices} or null on unknown type. Vertex layout is (pos.xyz,
 * color.rgb) interleaved float32 -- matches the pipeline's vertex
 * buffer layout exactly. Color is generated per-primitive: Box uses
 * distinct per-face colors; everything else uses normal-derived
 * shading (color = (normal + 1) * 0.5, so each direction maps to
 * a distinct hue) for an immediately-legible 3D shape. Materials
 * in sprint 7.5.3c replace this with proper lit shading. */
function _buildMeshData(node) {
  switch (node.type) {
    case "DebugTriangle": return _buildDebugTriangle(node);
    case "Box":           return _buildBox(node);
    case "Sphere":        return _buildSphere(node);
    case "Capsule":       return _buildCapsule(node);
    case "DestructibleBody3D": return _buildDestructibleMesh(node);
    case "Rope3D":        return _buildRopeMesh(node);
    case "Cloth3D":       return _buildClothMesh(node);
    case "SoftBody3D":    return _buildSoftBodyMesh(node);
    case "LoadGLB":       return _buildGLBMesh(node);
    case "Planet":        return _buildPlanet(node);
    case "PlanetMesh":    return _buildPlanetMesh(node);
    case "Plane":         return _buildPlane(node);
    case "Sprite":        return _buildSprite(node);
    case "Tilemap2D":         return _buildTilemap2D(node);
    case "TileSpriteOverlay": return _buildTileSpriteOverlay(node);
    case "ParallaxLayer2D":   return _buildParallaxLayer2D(node);
    case "SpriteScatter2D":   return _buildSpriteScatter2D(node);
    case "Torus":         return _buildTorus(node);
    case "Cylinder":      return _buildCylinder(node);
    case "Cone":          return _buildCone(node);
    case "Terrain":       return _buildTerrain(node);
    case "Water":            return _buildWater(node);
    case "TerrainHorizon":   return _buildTerrainHorizon(node);
    // Clouds3D handled by the chunked streaming path in
    // _ensureMeshBuffers; not reachable here.
    default: return null;
  }
}

function _buildDebugTriangle(node) {
  const s = (node.params && typeof node.params.scale === "number") ? node.params.scale : 1.0;
  // pos.xyz  color.rgb       normal.xyz  uv.xy  -- triangle faces +Z, normal = (0, 0, 1).
  const verts = new Float32Array([
    -0.866*s, -0.5*s, 0,     1, 0, 0,      0, 0, 1,   0,   0,
     0.866*s, -0.5*s, 0,     0, 1, 0,      0, 0, 1,   1,   0,
     0,        1.0*s, 0,     0.3, 0.5, 1,  0, 0, 1,   0.5, 1
  ]);
  return { verts, indices: null };
}

/* Rope3D -- tube mesh swept along the PBD particle polyline (set by
 * _tickRopes). K-sided ring per particle, oriented by a parallel-
 * transport-ish frame; rings connected by quads. 11-float vertex
 * format (pos3 + color3 + normal3 + uv2). Falls back to a straight
 * line between the attach points if the sim hasn't run yet. */
function _buildRopeMesh(node) {
  const p = node.params || {};
  const radius = Math.max(0.01, (typeof p.radius === "number") ? p.radius : 0.12);
  const col = [
    (typeof p.r === "number") ? p.r : 0.45,
    (typeof p.g === "number") ? p.g : 0.32,
    (typeof p.b === "number") ? p.b : 0.2
  ];
  // Particle centerline. If the sim hasn't populated _particles yet,
  // synthesize a straight segment from the static attach params.
  let pts = (node._particles && node._particles.length >= 2)
    ? node._particles.map(q => [q.x, q.y, q.z])
    : null;
  if (!pts) {
    const ax = p.ax || 0, ay = (typeof p.ay === "number") ? p.ay : 6, az = p.az || 0;
    const bx = p.bx || 0, by = p.by || 0, bz = p.bz || 0;
    const segs = Math.max(2, Math.min(64, Math.round((typeof p.segments === "number") ? p.segments : 16)));
    pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push([ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t]);
    }
  }
  const M = pts.length;          // rings
  const K = 6;                   // sides per ring
  const verts = new Float32Array(M * K * 11);
  const indices = new Uint32Array((M - 1) * K * 6);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1e-6; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
  let v = 0;
  for (let i = 0; i < M; i++) {
    // Tangent via central difference.
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(M - 1, i + 1)];
    let tan = norm(sub(next, prev));
    if (!isFinite(tan[0])) tan = [0, 1, 0];
    // Frame: pick an up not parallel to tangent.
    let up = (Math.abs(tan[1]) > 0.9) ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(tan, up));
    const w = norm(cross(tan, u));
    const c = pts[i];
    const tv = i / (M - 1);
    for (let k = 0; k < K; k++) {
      const ang = (k / K) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const nx = u[0] * ca + w[0] * sa, ny = u[1] * ca + w[1] * sa, nz = u[2] * ca + w[2] * sa;
      verts[v++] = c[0] + nx * radius; verts[v++] = c[1] + ny * radius; verts[v++] = c[2] + nz * radius;
      verts[v++] = col[0]; verts[v++] = col[1]; verts[v++] = col[2];
      verts[v++] = nx; verts[v++] = ny; verts[v++] = nz;
      verts[v++] = k / K; verts[v++] = tv;
    }
  }
  let ii = 0;
  for (let i = 0; i < M - 1; i++) {
    for (let k = 0; k < K; k++) {
      const a = i * K + k;
      const b = i * K + (k + 1) % K;
      const c = (i + 1) * K + k;
      const d = (i + 1) * K + (k + 1) % K;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }
  return { verts, indices };
}

/* Cloth3D -- triangulate the PBD particle grid (set by _tickCloths)
 * into a mesh. Per-vertex normals from the grid tangents. The scene
 * pipeline is cullMode:"none", so a single-sided grid shows both
 * faces. Falls back to a flat resting sheet from params if the sim
 * hasn't run yet. 11-float verts (pos3 + color3 + normal3 + uv2). */
function _buildClothMesh(node) {
  const p = node.params || {};
  const col = [
    (typeof p.r === "number") ? p.r : 0.7,
    (typeof p.g === "number") ? p.g : 0.2,
    (typeof p.b === "number") ? p.b : 0.25
  ];
  let P = node._cloth, dims = node._clothDims;
  if (!P || !dims) {
    // Flat fallback from params.
    const nx = Math.max(2, Math.min(40, Math.round((typeof p.resX === "number") ? p.resX : 16)));
    const ny = Math.max(2, Math.min(40, Math.round((typeof p.resY === "number") ? p.resY : 10)));
    const W = (typeof p.width === "number") ? p.width : 6;
    const H = (typeof p.height === "number") ? p.height : 4;
    const ox = p.originX || 0, oy = (typeof p.originY === "number") ? p.originY : 6, oz = p.originZ || 0;
    const cols = nx + 1, rows = ny + 1;
    P = new Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      P[j * cols + i] = { x: ox + (i / nx) * W, y: oy - (j / ny) * H, z: oz };
    }
    dims = { nx, ny, cols, rows };
  }
  const { cols, rows } = dims;
  const idx = (i, j) => j * cols + i;
  const verts = new Float32Array(cols * rows * 11);
  let v = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = P[idx(i, j)];
      // Tangents via neighbor differences (clamped at edges).
      const r0 = P[idx(Math.min(cols - 1, i + 1), j)], l0 = P[idx(Math.max(0, i - 1), j)];
      const d0 = P[idx(i, Math.min(rows - 1, j + 1))], u0 = P[idx(i, Math.max(0, j - 1))];
      const tx = r0.x - l0.x, ty = r0.y - l0.y, tz = r0.z - l0.z;
      const bx = d0.x - u0.x, by = d0.y - u0.y, bz = d0.z - u0.z;
      // normal = tangent × bitangent
      let nxN = ty * bz - tz * by, nyN = tz * bx - tx * bz, nzN = tx * by - ty * bx;
      const nl = Math.hypot(nxN, nyN, nzN) || 1e-6;
      nxN /= nl; nyN /= nl; nzN /= nl;
      verts[v++] = c.x; verts[v++] = c.y; verts[v++] = c.z;
      verts[v++] = col[0]; verts[v++] = col[1]; verts[v++] = col[2];
      verts[v++] = nxN; verts[v++] = nyN; verts[v++] = nzN;
      verts[v++] = i / (cols - 1); verts[v++] = j / (rows - 1);
    }
  }
  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let ii = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = idx(i, j), b = idx(i + 1, j), cc = idx(i, j + 1), d = idx(i + 1, j + 1);
      indices[ii++] = a; indices[ii++] = cc; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = cc; indices[ii++] = d;
    }
  }
  return { verts, indices };
}

/* SoftBody3D -- render the deforming shell of the res³ particle
 * lattice (set by _tickSoftBodies). INDEXED with shared surface
 * vertices + SMOOTH (area-weighted) normals accumulated across all
 * adjacent faces — so the cube edges round off and the jelly reads
 * smooth rather than faceted. Falls back to the rest cube. */
function _buildSoftBodyMesh(node) {
  const p = node.params || {};
  const col = [
    (typeof p.r === "number") ? p.r : 0.55,
    (typeof p.g === "number") ? p.g : 0.85,
    (typeof p.b === "number") ? p.b : 0.65
  ];
  let P = node._sb, R = node._sbR;
  if (!P || !R) {
    R = Math.max(2, Math.min(8, Math.round((typeof p.res === "number") ? p.res : 5)));
    const size = Math.max(0.2, (typeof p.size === "number") ? p.size : 2.5);
    const ox = p.originX || 0, oy = (typeof p.originY === "number") ? p.originY : 6, oz = p.originZ || 0;
    const step = size / (R - 1), base = { x: ox - size/2, y: oy - size/2, z: oz - size/2 };
    P = new Array(R*R*R);
    for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++)
      P[(k*R+j)*R+i] = { x: base.x+i*step, y: base.y+j*step, z: base.z+k*step };
  }
  const idx = (i, j, k) => (k * R + j) * R + i;
  // One shared vertex per SURFACE particle (so edge/corner verts are
  // shared between faces and their normals average → rounded edges).
  const vmap = new Map();
  const vparts = [];
  const isSurf = (i, j, k) => i === 0 || i === R-1 || j === 0 || j === R-1 || k === 0 || k === R-1;
  for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    if (isSurf(i, j, k)) { vmap.set(idx(i, j, k), vparts.length); vparts.push(idx(i, j, k)); }
  }
  const VN = vparts.length;
  const px = new Float32Array(VN), py = new Float32Array(VN), pz = new Float32Array(VN);
  const nx = new Float32Array(VN), ny = new Float32Array(VN), nz = new Float32Array(VN);
  for (let v = 0; v < VN; v++) { const q = P[vparts[v]]; px[v] = q.x; py[v] = q.y; pz[v] = q.z; }

  const tri = [];
  const quad = (a, b, c, d) => {
    const va = vmap.get(a), vb = vmap.get(b), vc = vmap.get(c), vd = vmap.get(d);
    tri.push(va, vb, vc, va, vc, vd);
  };
  for (let a = 0; a < R - 1; a++) {
    for (let b = 0; b < R - 1; b++) {
      quad(idx(0, a, b), idx(0, a, b+1), idx(0, a+1, b+1), idx(0, a+1, b));            // -X
      quad(idx(R-1, a, b), idx(R-1, a+1, b), idx(R-1, a+1, b+1), idx(R-1, a, b+1));    // +X
      quad(idx(a, 0, b), idx(a+1, 0, b), idx(a+1, 0, b+1), idx(a, 0, b+1));            // -Y
      quad(idx(a, R-1, b), idx(a, R-1, b+1), idx(a+1, R-1, b+1), idx(a+1, R-1, b));    // +Y
      quad(idx(a, b, 0), idx(a, b+1, 0), idx(a+1, b+1, 0), idx(a+1, b, 0));            // -Z
      quad(idx(a, b, R-1), idx(a+1, b, R-1), idx(a+1, b+1, R-1), idx(a, b+1, R-1));    // +Z
    }
  }
  // Accumulate face normals into shared verts (area-weighted = raw
  // cross product, not normalized per-face).
  for (let t = 0; t < tri.length; t += 3) {
    const i0 = tri[t], i1 = tri[t+1], i2 = tri[t+2];
    const e1x = px[i1]-px[i0], e1y = py[i1]-py[i0], e1z = pz[i1]-pz[i0];
    const e2x = px[i2]-px[i0], e2y = py[i2]-py[i0], e2z = pz[i2]-pz[i0];
    const fx = e1y*e2z - e1z*e2y, fy = e1z*e2x - e1x*e2z, fz = e1x*e2y - e1y*e2x;
    nx[i0]+=fx; ny[i0]+=fy; nz[i0]+=fz;
    nx[i1]+=fx; ny[i1]+=fy; nz[i1]+=fz;
    nx[i2]+=fx; ny[i2]+=fy; nz[i2]+=fz;
  }
  const verts = new Float32Array(VN * 11);
  for (let v = 0; v < VN; v++) {
    let a = nx[v], b = ny[v], c = nz[v];
    const l = Math.hypot(a, b, c) || 1e-6; a/=l; b/=l; c/=l;
    const o = v * 11;
    verts[o] = px[v]; verts[o+1] = py[v]; verts[o+2] = pz[v];
    verts[o+3] = col[0]; verts[o+4] = col[1]; verts[o+5] = col[2];
    verts[o+6] = a; verts[o+7] = b; verts[o+8] = c;
    verts[o+9] = 0; verts[o+10] = 0;
  }
  return { verts, indices: new Uint32Array(tri) };
}

/* ── Phase 8.B.15 / §8.F -- LoadGLB glTF import ───────────────────── */
let _threeModPromise = null;
/* Lazy-load three.js + GLTFLoader from a CDN that resolves the bare
 * "three" import inside the loader (esm.sh). Same dynamic-import
 * pattern as Rapier / transformers.js — no build step, no bundling. */
function _ensureThree() {
  if (_threeModPromise) return _threeModPromise;
  console.log("[glb] loading three.js + GLTFLoader…");
  _threeModPromise = (async () => {
    const THREE = await import("https://esm.sh/three@0.160.0");
    const mod = await import("https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js");
    console.log("[glb] three.js ready");
    return { THREE, GLTFLoader: mod.GLTFLoader };
  })();
  return _threeModPromise;
}

/* Resolve a LoadGLB url param to a fetchable URL. server:<id> streams
 * from the compile-server asset host; asset:<name> resolves through
 * the cached server manifest; http(s) is used directly. */
function _resolveGLBUrl(url) {
  if (typeof url !== "string" || !url) return null;
  const base = _serverAssetsBase || (typeof localServerEndpoint === "string" ? localServerEndpoint : null);
  if (url.startsWith("server:")) {
    const id = url.slice(7);
    return base ? base + "/assets/" + encodeURIComponent(id) : null;
  }
  if (url.startsWith("asset:")) {
    const name = url.slice(6).toLowerCase();
    const hit = (_serverAssets || []).find(a => a && (a.id === name || (a.name || "").toLowerCase() === name));
    if (hit && base) return base + "/assets/" + encodeURIComponent(hit.id);
    return null;
  }
  if (/^https?:\/\//.test(url)) return url;
  return null;
}

/* Merge every Mesh primitive in a parsed glTF into one editor-format
 * buffer (pos3 + color3 + normal3 + uv2), world-transformed, with the
 * material base color baked into the vertex color. */
function _gltfToEditorMesh(gltf, THREE, params) {
  const scale = (params && typeof params.scale === "number") ? params.scale : 1;
  const verts = [], indices = [];
  let vbase = 0;
  const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!root) return { verts: new Float32Array(0), indices: new Uint32Array(0) };
  root.updateMatrixWorld(true);
  const vtmp = new THREE.Vector3(), ntmp = new THREE.Vector3();
  const wm = new THREE.Matrix4(), im = new THREE.Matrix4();
  root.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    const g = obj.geometry;
    const pos = g.attributes && g.attributes.position;
    if (!pos) return;
    const nrm = g.attributes.normal, uv = g.attributes.uv, idx = g.index;
    let cr = 0.8, cg = 0.8, cb = 0.8;
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    if (mat && mat.color) { cr = mat.color.r; cg = mat.color.g; cb = mat.color.b; }
    const count = pos.count;
    // InstancedMesh (common in city kits for repeated windows / props):
    // emit the geometry once PER INSTANCE, composing each instance
    // matrix with the object's world matrix. Plain meshes = 1 pass.
    const instN = (obj.isInstancedMesh && obj.count) ? obj.count : 1;
    for (let inst = 0; inst < instN; inst++) {
      if (obj.isInstancedMesh) { obj.getMatrixAt(inst, im); wm.multiplyMatrices(obj.matrixWorld, im); }
      else { wm.copy(obj.matrixWorld); }
      const nm = new THREE.Matrix3().getNormalMatrix(wm);
      for (let i = 0; i < count; i++) {
        vtmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(wm);
        let nx = 0, ny = 1, nz = 0;
        if (nrm) { ntmp.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyMatrix3(nm).normalize(); nx = ntmp.x; ny = ntmp.y; nz = ntmp.z; }
        const u = uv ? uv.getX(i) : 0, v = uv ? uv.getY(i) : 0;
        verts.push(vtmp.x * scale, vtmp.y * scale, vtmp.z * scale, cr, cg, cb, nx, ny, nz, u, v);
      }
      if (idx) { for (let i = 0; i < idx.count; i++) indices.push(vbase + idx.getX(i)); }
      else { for (let i = 0; i < count; i++) indices.push(vbase + i); }
      vbase += count;
    }
  });
  // autoFit > 0: normalize to a consistent size regardless of the
  // source mesh's units. Centers on X/Z, rests the base at y=0, and
  // scales so the largest dimension = autoFit world units. Fixes the
  // "props come at wildly different scales / off-origin" problem.
  const autoFit = (params && typeof params.autoFit === "number") ? params.autoFit : 0;
  if (autoFit > 0 && verts.length) {
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < verts.length; i += 11) {
      const x = verts[i], y = verts[i+1], z = verts[i+2];
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
    const maxDim = Math.max(mxx - mnx, mxy - mny, mxz - mnz) || 1;
    const s = autoFit / maxDim;
    const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2;
    for (let i = 0; i < verts.length; i += 11) {
      verts[i]   = (verts[i]   - cx)  * s;
      verts[i+1] = (verts[i+1] - mny) * s;   // base sits on y = 0
      verts[i+2] = (verts[i+2] - cz)  * s;
    }
  }
  return { verts: new Float32Array(verts), indices: new Uint32Array(indices) };
}

async function _loadGLB(node) {
  node._glbState = "loading";
  node._glbUrl = node.params && node.params.url;
  try {
    const u0 = node.params && node.params.url;
    // server:/asset: urls need the compile-server base — probe it (and
    // the manifest for asset:<name>) if the Assets tab hasn't already.
    if (typeof u0 === "string" && (u0.startsWith("server:") || u0.startsWith("asset:"))) {
      if (!_serverAssetsBase && typeof probeLocalServer === "function") {
        try { await probeLocalServer(); } catch (_) {}
        if (!_serverAssetsBase && typeof localServerEndpoint === "string") _serverAssetsBase = localServerEndpoint;
      }
      if (u0.startsWith("asset:") && (!_serverAssets || !_serverAssets.length) &&
          typeof brRefreshServerAssets === "function") {
        try { await brRefreshServerAssets(); } catch (_) {}
      }
    }
    const url = _resolveGLBUrl(u0);
    if (!url) throw new Error("unresolved url: " + (node.params && node.params.url) + " (compile-server running?)");
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const { THREE, GLTFLoader } = await _ensureThree();
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      try { loader.parse(buf, "", resolve, reject); } catch (e) { reject(e); }
    });
    const mesh = _gltfToEditorMesh(gltf, THREE, node.params);
    if (!mesh.verts.length) throw new Error("no geometry in glTF");
    // Free three.js GPU/CPU resources — we only keep the extracted
    // vertex buffers, so the parsed scene + its (often large) embedded
    // textures shouldn't linger and balloon memory.
    try {
      const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      root && root.traverse(o => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const mm of mats) {
          if (!mm) continue;
          for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"]) {
            if (mm[k] && mm[k].dispose) mm[k].dispose();
          }
          if (mm.dispose) mm.dispose();
        }
      });
    } catch (_) {}
    node._glbMesh = mesh;
    node._glbState = "ready";
    node._glbVer = (node._glbVer || 0) + 1;
    if (node.params) node.params.ready = 1;
    console.log("[glb] " + node.id + " loaded: " + (mesh.verts.length / 11) + " verts");
  } catch (e) {
    console.warn("[glb] " + node.id + " load failed:", e && e.message);
    node._glbState = "error";
    if (node.params) node.params.ready = 0;
  }
}

/* Small placeholder cube shown while a GLB loads / on error. */
function _glbPlaceholder() {
  const h = 0.5, c = [0.45, 0.5, 0.6];
  const fb = _buildBox({ params: { width: 1, height: 1, depth: 1 } });
  // recolor to a neutral grey-blue
  for (let i = 0; i < fb.verts.length; i += 11) { fb.verts[i+3] = c[0]; fb.verts[i+4] = c[1]; fb.verts[i+5] = c[2]; }
  return fb;
}

function _buildGLBMesh(node) {
  // Kick a (re)load when first seen or when the url changed.
  if (!node._glbState || (node.params && node.params.url !== node._glbUrl)) {
    node._glbState = "queued";
    node._glbMesh = null;
    _loadGLB(node);
  }
  if (node._glbState === "ready" && node._glbMesh) return node._glbMesh;
  return _glbPlaceholder();
}

/* ── Phase 8.B.15 A.4 -- PhysicalMat PBR texture maps ────────────── */
/* Decode one map URL (server:/asset:/http) into a GPUTexture view.
 * jpg/png/webp via createImageBitmap; .exr via three.js EXRLoader
 * (FloatType → RGBA8). `fmt` = the WebGPU texture format. */
async function _loadMatTexture(rawUrl, fmt) {
  if (rawUrl.startsWith("server:") || rawUrl.startsWith("asset:")) {
    // Make sure the manifest is loaded — the EXR-vs-bitmap sniff below
    // needs the on-disk filename, and a demo may load before the user
    // ever opens the Assets tab.
    if ((!_serverAssets || !_serverAssets.length) && typeof brRefreshServerAssets === "function") {
      try { await brRefreshServerAssets(); } catch (_) {}
    }
    if (!_serverAssetsBase && typeof probeLocalServer === "function") {
      try { await probeLocalServer(); } catch (_) {}
      if (!_serverAssetsBase && typeof localServerEndpoint === "string") _serverAssetsBase = localServerEndpoint;
    }
  }
  const url = _resolveGLBUrl(rawUrl) || (/^https?:\/\//.test(rawUrl) ? rawUrl : null);
  if (!url) throw new Error("unresolved url: " + rawUrl);
  // Server/asset ids are slugged without an extension, so sniff the
  // real on-disk filename from the manifest to decide EXR-vs-bitmap
  // (Poly Haven ships normal/rough maps as .exr).
  let isExr = /\.exr(\?|$)/i.test(rawUrl) || /\.exr(\?|$)/i.test(url);
  if (!isExr && (rawUrl.startsWith("server:") || rawUrl.startsWith("asset:"))) {
    const ref = rawUrl.replace(/^(server|asset):/, "").toLowerCase();
    const hit = (_serverAssets || []).find(a => a && (a.id === ref || (a.name || "").toLowerCase() === ref));
    if (hit && /\.exr$/i.test(hit.file || hit.name || "")) isExr = true;
  }
  if (isExr) {
    const { THREE } = await _ensureThree();
    const mod = await import("https://esm.sh/three@0.160.0/examples/jsm/loaders/EXRLoader.js");
    const loader = new mod.EXRLoader();
    if (loader.setDataType) loader.setDataType(THREE.FloatType);
    const tex = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
    const w = tex.image.width, h = tex.image.height, src = tex.image.data;
    const ch = Math.max(1, Math.round(src.length / (w * h)));
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const r = src[i * ch] || 0, g = (ch > 1 ? src[i * ch + 1] : src[i * ch]) || 0, b = (ch > 2 ? src[i * ch + 2] : src[i * ch]) || 0;
      out[i*4]   = Math.max(0, Math.min(255, Math.round(r * 255)));
      out[i*4+1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      out[i*4+2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      out[i*4+3] = 255;
    }
    const gt = Visual.device.createTexture({
      label: "mat-exr", size: [w, h, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    Visual.device.queue.writeTexture({ texture: gt }, out, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
    if (tex.dispose) tex.dispose();
    return gt.createView({ label: "mat-exr-view" });
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const gt = Visual.device.createTexture({
    label: "mat-tex", size: [bmp.width, bmp.height, 1], format: fmt,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  });
  Visual.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: gt }, [bmp.width, bmp.height]);
  if (bmp.close) bmp.close();
  return gt.createView({ label: "mat-tex-view" });
}

/* Kick off (idempotent) loads for a PhysicalMat node's map params,
 * stashing the resolved views as node._mapAlbedo / _mapNormal /
 * _mapRough / _mapMetal. The draw loop reads those + rebinds the slot. */
function _ensureMatTextures(node) {
  if (!node || !node.params || !Visual.device) return;
  const p = node.params;
  const jobs = [
    ["albedoMap", "_mapAlbedo", "rgba8unorm"],
    ["normalMap", "_mapNormal", "rgba8unorm"],
    ["roughMap",  "_mapRough",  "rgba8unorm"],
    ["metalMap",  "_mapMetal",  "rgba8unorm"]
  ];
  for (const [param, key, fmt] of jobs) {
    const url = (typeof p[param] === "string") ? p[param].trim() : "";
    const sk = key + "Url";
    if (!url) { node[key] = null; node[sk] = ""; continue; }
    if (node[sk] === url) continue;       // already loading/loaded this url
    node[sk] = url;
    node[key] = null;
    _loadMatTexture(url, fmt)
      .then(view => { node[key] = view; })
      .catch(e => console.warn("[mat] " + param + " (" + url + ") failed: " + (e && e.message)));
  }
}

/* Box -- 24 verts (4 per face, NOT shared between faces) so each
 * face can have its own color/normal. 36 indices = 6 faces × 2
 * triangles × 3 verts. Standard cube oriented with +Y up.
 *
 * Face colors (Pantone-ish): +X red, -X cyan, +Y green, -Y magenta,
 * +Z blue, -Z yellow. Easy to identify which face you're looking at. */
function _buildBox(node) {
  const p = node.params || {};
  const hw = ((typeof p.width  === "number") ? p.width  : 1) * 0.5;
  const hh = ((typeof p.height === "number") ? p.height : 1) * 0.5;
  const hd = ((typeof p.depth  === "number") ? p.depth  : 1) * 0.5;
  // Face order: +X, -X, +Y, -Y, +Z, -Z. Each face: 4 verts in
  // CCW order viewed from outside, with explicit normal. Per-face
  // UVs cover the full 0..1 square so each face gets a complete
  // copy of the source texture.
  const faces = [
    { c: [1.00, 0.22, 0.22], n: [ 1, 0, 0], verts: [
      [ hw, -hh, -hd], [ hw,  hh, -hd], [ hw,  hh,  hd], [ hw, -hh,  hd] ]},  // +X
    { c: [0.22, 0.92, 0.95], n: [-1, 0, 0], verts: [
      [-hw, -hh,  hd], [-hw,  hh,  hd], [-hw,  hh, -hd], [-hw, -hh, -hd] ]},  // -X
    { c: [0.45, 0.96, 0.35], n: [ 0, 1, 0], verts: [
      [-hw,  hh,  hd], [ hw,  hh,  hd], [ hw,  hh, -hd], [-hw,  hh, -hd] ]},  // +Y
    { c: [0.96, 0.35, 0.92], n: [ 0,-1, 0], verts: [
      [-hw, -hh, -hd], [ hw, -hh, -hd], [ hw, -hh,  hd], [-hw, -hh,  hd] ]},  // -Y
    { c: [0.40, 0.55, 1.00], n: [ 0, 0, 1], verts: [
      [-hw, -hh,  hd], [ hw, -hh,  hd], [ hw,  hh,  hd], [-hw,  hh,  hd] ]},  // +Z
    { c: [0.98, 0.92, 0.30], n: [ 0, 0,-1], verts: [
      [ hw, -hh, -hd], [-hw, -hh, -hd], [-hw,  hh, -hd], [ hw,  hh, -hd] ]}   // -Z
  ];
  // Per-face UV order matches the vert order: BL, TL, TR, BR.
  // Triangulation (0,1,2 / 0,2,3) traces the full unit square.
  const faceUvs = [[0, 0], [0, 1], [1, 1], [1, 0]];
  const verts = new Float32Array(24 * 11);
  const indices = new Uint32Array(36);
  let v = 0, i = 0, base = 0;
  for (const f of faces) {
    for (let k = 0; k < 4; k++) {
      const pos = f.verts[k];
      const uv  = faceUvs[k];
      verts[v++] = pos[0]; verts[v++] = pos[1]; verts[v++] = pos[2];
      verts[v++] = f.c[0]; verts[v++] = f.c[1]; verts[v++] = f.c[2];
      verts[v++] = f.n[0]; verts[v++] = f.n[1]; verts[v++] = f.n[2];
      verts[v++] = uv[0];  verts[v++] = uv[1];
    }
    indices[i++] = base + 0; indices[i++] = base + 1; indices[i++] = base + 2;
    indices[i++] = base + 0; indices[i++] = base + 2; indices[i++] = base + 3;
    base += 4;
  }
  return { verts, indices };
}

/* Sphere -- UV sphere with `stacks` horizontal slices + `slices`
 * vertical meridians. (stacks+1)*(slices+1) verts, 2*stacks*slices*3
 * indices. Color from surface normal (= normalized position for a
 * unit sphere) mapped (n + 1) * 0.5 -- each direction is a distinct
 * pastel hue. */
function _buildSphere(node) {
  const p = node.params || {};
  const r = (typeof p.radius === "number") ? p.radius : 1;
  const stacks = Math.max(2, Math.min(64, Math.floor((typeof p.stacks === "number") ? p.stacks : 16)));
  const slices = Math.max(3, Math.min(128, Math.floor((typeof p.slices === "number") ? p.slices : 24)));
  // Equirectangular UV: u = slice (longitude), v = stack (latitude
  // from north pole). The seam at u=0/1 is automatically handled
  // by including sl=slices vertex (same position as sl=0, but with
  // u=1 instead of u=0).
  const verts = new Float32Array((stacks + 1) * (slices + 1) * 11);
  const indices = new Uint32Array(stacks * slices * 6);
  let v = 0, i = 0;
  for (let st = 0; st <= stacks; st++) {
    const phi = Math.PI * (st / stacks);                // 0..π (north pole to south)
    const sphi = Math.sin(phi), cphi = Math.cos(phi);
    const vv = st / stacks;
    for (let sl = 0; sl <= slices; sl++) {
      const theta = 2 * Math.PI * (sl / slices);        // 0..2π around Y
      const sth = Math.sin(theta), cth = Math.cos(theta);
      const nx = sphi * cth, ny = cphi, nz = sphi * sth;
      verts[v++] = r * nx; verts[v++] = r * ny; verts[v++] = r * nz;
      verts[v++] = nx * 0.5 + 0.5;
      verts[v++] = ny * 0.5 + 0.5;
      verts[v++] = nz * 0.5 + 0.5;
      verts[v++] = nx; verts[v++] = ny; verts[v++] = nz;
      verts[v++] = sl / slices; verts[v++] = vv;
    }
  }
  for (let st = 0; st < stacks; st++) {
    for (let sl = 0; sl < slices; sl++) {
      const a = st * (slices + 1) + sl;
      const b = a + slices + 1;
      indices[i++] = a;     indices[i++] = b;     indices[i++] = a + 1;
      indices[i++] = a + 1; indices[i++] = b;     indices[i++] = b + 1;
    }
  }
  return { verts, indices };
}

function _buildCapsule(node) {
  const p = node.params || {};
  const r = Math.max(0.01, (typeof p.radius === "number") ? p.radius : 0.25);
  const hh = Math.max(0, (typeof p.halfHeight === "number") ? p.halfHeight : 0.5);
  const sl = Math.max(4, Math.min(48, Math.floor((typeof p.slices === "number") ? p.slices : 12)));
  const capStacks = Math.max(2, Math.floor(sl / 2));
  const totalStacks = capStacks * 2 + 1;
  const vertCount = (totalStacks + 1) * (sl + 1);
  const verts = new Float32Array(vertCount * 11);
  const indices = new Uint32Array(totalStacks * sl * 6);
  let vi = 0, ii = 0;
  for (let st = 0; st <= totalStacks; st++) {
    let phi, yOff;
    if (st <= capStacks) {
      phi = Math.PI * 0.5 * (st / capStacks);
      yOff = hh;
    } else if (st <= capStacks * 2) {
      phi = Math.PI * 0.5;
      yOff = hh - (st - capStacks) / capStacks * 2 * hh;
    } else {
      phi = Math.PI * 0.5 + Math.PI * 0.5 * ((st - capStacks * 2) / capStacks);
      yOff = -hh;
    }
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let s = 0; s <= sl; s++) {
      const th = 2 * Math.PI * (s / sl);
      const nx = sp * Math.cos(th), nz = sp * Math.sin(th), ny = cp;
      const px = r * nx, py = r * ny + yOff, pz = r * nz;
      verts[vi++] = px; verts[vi++] = py; verts[vi++] = pz;
      verts[vi++] = nx * 0.5 + 0.5; verts[vi++] = ny * 0.5 + 0.5; verts[vi++] = nz * 0.5 + 0.5;
      verts[vi++] = nx; verts[vi++] = ny; verts[vi++] = nz;
      verts[vi++] = s / sl; verts[vi++] = st / totalStacks;
    }
  }
  for (let st = 0; st < totalStacks; st++) {
    for (let s = 0; s < sl; s++) {
      const a = st * (sl + 1) + s, b = a + sl + 1;
      indices[ii++] = a; indices[ii++] = b; indices[ii++] = a + 1;
      indices[ii++] = a + 1; indices[ii++] = b; indices[ii++] = b + 1;
    }
  }
  return { verts, indices };
}

