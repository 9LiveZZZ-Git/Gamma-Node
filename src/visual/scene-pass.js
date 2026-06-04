/* Encode a single Scene render pass. Color attachment is the
 * Scene's assigned framebuffer / scratch layer; depth attachment
 * is the shared Visual.depthTextureView. Iterates each wired mesh
 * input, writes the viewProj + model uniform, and issues one draw
 * per mesh. */
function _encodeScenePass(enc, entry) {
  const { node, layerIdx, isScratch, writeKey } = entry;
  let layerView;
  if (isScratch) {
    const views = (writeKey === "a") ? Visual.scratchLayerViewsA : Visual.scratchLayerViewsB;
    layerView = views[layerIdx];
  } else {
    layerView = Visual.framebufferLayerViews[layerIdx];
  }
  if (!layerView) {
    if (!_SCENE_DIAG.bail_layer) {
      _SCENE_DIAG.bail_layer = true;
      console.warn("[scene] bail: no layerView for layerIdx=" + layerIdx + " isScratch=" + isScratch);
    }
    return false;
  }
  const sampleCount = Visual.msaaSampleCount || 1;
  const inst = _ensureSceneInstance(node);
  if (!inst) {
    if (!_SCENE_DIAG.bail_inst) {
      _SCENE_DIAG.bail_inst = true;
      console.warn("[scene] bail: _ensureSceneInstance returned null; Visual.device=" + !!Visual.device +
                   " bgl=" + !!Visual.meshBindGroupLayout);
    }
    return false;
  }
  if (!Visual.depthTextureView) {
    if (!_SCENE_DIAG.bail_depth) {
      _SCENE_DIAG.bail_depth = true;
      console.warn("[scene] bail: no depthTextureView; fbW=" + Visual.fbWidth + " fbH=" + Visual.fbHeight);
    }
    return false;
  }
  if (sampleCount > 1 && !Visual.msaaColorTextureView) {
    if (!_SCENE_DIAG.bail_msaa) {
      _SCENE_DIAG.bail_msaa = true;
      console.warn("[scene] bail: msaa sampleCount=" + sampleCount + " but no msaaColorTextureView");
    }
    return false;
  }

  const p = node.params || {};
  const clearR = (typeof p.clearR === "number") ? p.clearR : 0.04;
  const clearG = (typeof p.clearG === "number") ? p.clearG : 0.05;
  const clearB = (typeof p.clearB === "number") ? p.clearB : 0.09;

  const camera = _resolveSceneCamera(node, Visual.fbWidth, Visual.fbHeight);
  const meshes = _resolveSceneMeshes(node);
  const lights = _resolveSceneLights(node);
  if (!_SCENE_DIAG.encode) {
    _SCENE_DIAG.encode = true;
    console.log("[scene] first encode: node=" + node.id +
                " layer=" + layerIdx + (isScratch ? " (scratch)" : " (display)") +
                " sampleCount=" + sampleCount + "x" +
                " meshes=" + meshes.length +
                " eye=(" + camera.eye.map(v => v.toFixed(2)).join(",") + ")");
    if (meshes.length === 0) {
      console.warn("[scene] node " + node.id + " has no wired mesh inputs -- " +
                   "the Scene will only show the clear color. Wire a DebugTriangle " +
                   "(or any mesh-gen node) into mesh1/mesh2/mesh3/mesh4.");
    }
  }

  // MSAA path: render into the MSAA color texture + use the
  // framebuffer layer as resolveTarget so WebGPU does the down-
  // sample at end-of-pass. storeOp "discard" because we only need
  // the resolved output -- saves bandwidth.
  // Single-sample path: render directly into the framebuffer layer.
  const colorAttachment = (sampleCount > 1)
    ? {
        view: Visual.msaaColorTextureView,
        resolveTarget: layerView,
        clearValue: { r: clearR, g: clearG, b: clearB, a: 1.0 },
        loadOp: "clear",
        storeOp: "discard"
      }
    : {
        view: layerView,
        clearValue: { r: clearR, g: clearG, b: clearB, a: 1.0 },
        loadOp: "clear",
        storeOp: "store"
      };
  const pass = enc.beginRenderPass({
    label: "scene-pass-" + node.id + "-" + sampleCount + "x",
    colorAttachments: [colorAttachment],
    depthStencilAttachment: {
      view: Visual.depthTextureView,
      depthLoadOp: "clear",
      // §planet-spec Phase 1 -- reverse-Z. Clear to 0.0 (far plane);
      // mesh fragments at ndc_z>0 then pass depthCompare:"greater".
      depthClearValue: 0.0,
      depthStoreOp: (sampleCount > 1) ? "discard" : "store"
    }
  });
  // Per-Scene uniform layout (sprint 7.5.4.c-sky, 120 floats / 480 bytes):
  //   [ 0..15]   viewProj (mat4)
  //   [16..19]   eye         (vec4: xyz = camera world pos, w = unused)
  //   [20..23]   lightCount  (vec4: x = N in [1..4])
  //   [24..39]   light 0 (4 vec4: pos / color / params / spotDir)
  //   [40..55]   light 1
  //   [56..71]   light 2
  //   [72..87]   light 3
  //   [88..91]   envParams   (vec4: x = mode 0/1/2, y = intensity,
  //                          z = turbidity, w = mieG)
  //   [92..95]   envSky      (vec4: rgb = sky/top color)
  //   [96..99]   envHorizon  (vec4: rgb = horizon color)
  //   [100..103] envGround   (vec4: rgb = ground/bottom color)
  //   [104..107] envSun      (vec4: xyz = dir TO sun, w = visibility)
  //   [108..111] camRight    (vec4: xyz = world right, w = tanHFov*aspect)
  //   [112..115] camUp       (vec4: xyz = world up,    w = tanHFov)
  //   [116..119] camForward  (vec4: xyz = world fwd,   w = 0persp/1ortho)
  //   [120..123] envCloudParams (vec4: x=coverage, y=density, z/w=wind)
  //   [124..127] envFogParams   (vec4: x=density, y=start, z=hFalloff, w=autoEnv)
  //   [128..131] envFogColor    (vec4: rgb=color)
  inst.sceneScratch.set(camera.viewProj, 0);
  inst.sceneScratch[16] = camera.eye[0];
  inst.sceneScratch[17] = camera.eye[1];
  inst.sceneScratch[18] = camera.eye[2];
  inst.sceneScratch[19] = 0;
  const usedLights = Math.min(4, lights.length || 1);
  inst.sceneScratch[20] = usedLights;
  inst.sceneScratch[21] = 0; inst.sceneScratch[22] = 0; inst.sceneScratch[23] = 0;
  for (let i = 0; i < 4; i++) {
    const L = (i < usedLights && lights[i]) ? lights[i] : null;
    const base = 24 + i * 16;
    if (L) {
      inst.sceneScratch[base + 0]  = L.pos[0];
      inst.sceneScratch[base + 1]  = L.pos[1];
      inst.sceneScratch[base + 2]  = L.pos[2];
      inst.sceneScratch[base + 3]  = L.type;            // 0=dir, 1=point, 2=spot
      inst.sceneScratch[base + 4]  = L.color[0];
      inst.sceneScratch[base + 5]  = L.color[1];
      inst.sceneScratch[base + 6]  = L.color[2];
      inst.sceneScratch[base + 7]  = L.intensity;
      inst.sceneScratch[base + 8]  = L.range || 0;      // params.x
      inst.sceneScratch[base + 9]  = L.cosInner || 1;   // params.y
      inst.sceneScratch[base + 10] = L.cosOuter || 1;   // params.z
      inst.sceneScratch[base + 11] = 0;                 // params.w reserved
      inst.sceneScratch[base + 12] = L.spotDir[0];
      inst.sceneScratch[base + 13] = L.spotDir[1];
      inst.sceneScratch[base + 14] = L.spotDir[2];
      inst.sceneScratch[base + 15] = 0;
    } else {
      // Zero out unused light slots so old data doesn't bleed in.
      for (let k = 0; k < 16; k++) inst.sceneScratch[base + k] = 0;
    }
  }
  // Sprint 7.5.4 -- environment. Pull from the wired environment
  // input (if any) and pack into the env vec4s. mode=0 means
  // unwired -> shader falls back to the hardcoded hemisphere-IBL.
  // Sprint 7.5.4.c -- mode 2 (ProceduralSky) also writes envSun.
  const env = _resolveSceneEnvironment(node);
  if (env) {
    inst.sceneScratch[88]  = env.mode;
    inst.sceneScratch[89]  = (typeof env.intensity === "number") ? env.intensity : 1.0;
    inst.sceneScratch[90]  = (typeof env.turbidity === "number") ? env.turbidity : 1.0;
    inst.sceneScratch[91]  = (typeof env.mieG      === "number") ? env.mieG      : 0.76;
    const sky     = env.sky     || [0, 0, 0];
    const horizon = env.horizon || [0, 0, 0];
    const ground  = env.ground  || [0, 0, 0];
    const sun     = env.sun     || [0, 1, 0, 0];
    // 7.5.4.c-polish -- sky.w carries moonPhase for ProceduralSky.
    // GradientSky doesn't use it; falls through to 0.
    inst.sceneScratch[92]  = sky[0];     inst.sceneScratch[93]  = sky[1];     inst.sceneScratch[94]  = sky[2];     inst.sceneScratch[95]  = (typeof sky[3] === "number") ? sky[3] : 0;
    inst.sceneScratch[96]  = horizon[0]; inst.sceneScratch[97]  = horizon[1]; inst.sceneScratch[98]  = horizon[2]; inst.sceneScratch[99]  = 0;
    inst.sceneScratch[100] = ground[0];  inst.sceneScratch[101] = ground[1];  inst.sceneScratch[102] = ground[2];  inst.sceneScratch[103] = 0;
    inst.sceneScratch[104] = sun[0];     inst.sceneScratch[105] = sun[1];     inst.sceneScratch[106] = sun[2];     inst.sceneScratch[107] = sun[3];
  } else {
    // Zero out env slots when nothing is wired (mode=0 = fallback).
    for (let k = 88; k < 108; k++) inst.sceneScratch[k] = 0;
  }
  // Sprint 7.5.4.c-sky -- camera basis vectors for the background
  // sky pass. Always written (even when no env wired) so the data
  // is fresh; the sky pass is only dispatched conditionally below.
  const cR = camera.camRight   || [1, 0, 0, 1];
  const cU = camera.camUp      || [0, 1, 0, 1];
  const cF = camera.camForward || [0, 0, -1, 0];
  inst.sceneScratch[108] = cR[0]; inst.sceneScratch[109] = cR[1]; inst.sceneScratch[110] = cR[2]; inst.sceneScratch[111] = cR[3];
  inst.sceneScratch[112] = cU[0]; inst.sceneScratch[113] = cU[1]; inst.sceneScratch[114] = cU[2]; inst.sceneScratch[115] = cU[3];
  inst.sceneScratch[116] = cF[0]; inst.sceneScratch[117] = cF[1]; inst.sceneScratch[118] = cF[2]; inst.sceneScratch[119] = cF[3];
  // Sprint 7.5.4.d -- cloud params (from env source, typically ProceduralSky).
  // §5.5.h-11 -- subtract camera.xz from the wind offset so the cloud
  // noise sample stays world-anchored as the camera moves. Without
  // this, the cloud shader's `pos = dir * t` puts every cloud at a
  // fixed direction from the camera, making them drag along with
  // motion. The shader does `pos.xz - wind`, so pre-subtracting
  // camera position from wind effectively adds camera position to pos.
  const cl = (env && env.cloud) || [0, 0, 0, 0];
  const camX = (camera && camera.eye) ? camera.eye[0] : 0;
  const camZ = (camera && camera.eye) ? camera.eye[2] : 0;
  inst.sceneScratch[120] = cl[0]; inst.sceneScratch[121] = cl[1];
  inst.sceneScratch[122] = cl[2] - camX;
  inst.sceneScratch[123] = cl[3] - camZ;
  // Sprint 7.5.4.e -- fog params (from Scene node's fog* params).
  const sp = _resolveNodeParams(node);
  const fogDensity = (typeof sp.fogDensity === "number") ? sp.fogDensity : 0;
  const fogStart   = (typeof sp.fogStart   === "number") ? sp.fogStart   : 5;
  const fogHeight  = (typeof sp.fogHeight  === "number") ? sp.fogHeight  : 0;
  const fogAuto    = (typeof sp.fogAuto    === "number") ? sp.fogAuto    : 1;
  const fogR       = (typeof sp.fogR       === "number") ? sp.fogR       : 0.65;
  const fogG       = (typeof sp.fogG       === "number") ? sp.fogG       : 0.70;
  const fogB       = (typeof sp.fogB       === "number") ? sp.fogB       : 0.78;
  inst.sceneScratch[124] = fogDensity;
  inst.sceneScratch[125] = fogStart;
  inst.sceneScratch[126] = fogHeight;
  inst.sceneScratch[127] = fogAuto;
  inst.sceneScratch[128] = fogR; inst.sceneScratch[129] = fogG; inst.sceneScratch[130] = fogB; inst.sceneScratch[131] = 0;

  // Sprint 7.6.a-atm -- envPlanet + envPlanetAtm. Re-uses the same
  // _findPlanetInfo() helper that powers the HUD altimeter, so the
  // shader's idea of the planet's location matches the altimeter's
  // and the actual rendered mesh exactly. Foot-to-Orbit positions
  // the planet so its north pole sits at world Y=0 -- center is at
  // (0, -PLANET_R * polRatio, 0) -- and _findPlanetInfo picks up
  // those node-params (centerX/Y/Z) correctly.
  //
  // 2026-05-21 history:
  //   * Pass 1 hardcoded center to (0,0,0); 200km-altitude testing
  //     in Foot-to-Orbit produced wrong atmosphere because the
  //     shader was using a phantom planet 6371km off from the real.
  //   * Pass 2 read centerX/Y/Z from `meshes`, but `meshes` is the
  //     render-pipeline mesh list (vertex+index buffer pairs), and
  //     PlanetMesh's procedural-surface entry may not be in that
  //     list at all render passes. Result: stars still didn't show
  //     because envPlanet.w stayed 0 -> shader fell back to flat-
  //     ground path -> features used eye.y altitude (-6,376,329 in
  //     Foot-to-Orbit) -> altFade = 0 -> no stars.
  //   * Pass 3 (now): use _findPlanetInfo which walks state.nodes
  //     directly and finds the planet node by .type regardless of
  //     render-pipeline state.
  //
  // Atmosphere parameters are Earth-relative so the sky reads
  // physically-right at any world-unit scale.
  const planetInfo = (typeof _findPlanetInfo === "function") ? _findPlanetInfo() : null;
  if (planetInfo && planetInfo.radius > 0) {
    const planetR = planetInfo.radius;
    const atmTop  = planetR * 1.0157;             // 100km on Earth-scale (Karman line)
    const scaleHR = planetR * 0.001334;           // 8500m on Earth-scale
    const scaleHM = planetR * 0.000188;           // 1200m on Earth-scale
    const sunI    = 22.0;
    const polRatio = (typeof planetInfo.polRatio === "number" && planetInfo.polRatio > 0)
      ? planetInfo.polRatio : 1.0;
    // 2026-05-21 diagnostic: log ONCE so we can confirm the center the
    // atmosphere shader is given matches the actual rendered planet
    // mesh's vertex-space center. If they disagree, atmosphere appears
    // offset from planet silhouette (the symptom in 21-16/17 screenshots).
    if (!Visual._planetCenterDiagnosticLogged) {
      Visual._planetCenterDiagnosticLogged = true;
      const planetNodes = (state && state.nodes || []).filter(n =>
        n && (n.type === "PlanetMesh" || n.type === "Planet")
      );
      console.log("[atm-diagnostic] _findPlanetInfo returned center=("
        + planetInfo.centerX + ", " + planetInfo.centerY + ", " + planetInfo.centerZ
        + ") radius=" + planetR + " polRatio=" + polRatio
        + " sceneNodeCount=" + planetNodes.length);
      for (const n of planetNodes) {
        const np = n.params || {};
        console.log("[atm-diagnostic]   node id=" + n.id + " type=" + n.type
          + " center=(" + (np.centerX||0) + ", " + (np.centerY||0) + ", " + (np.centerZ||0) + ")"
          + " radius=" + (np.radius||0)
          + " polarRadiusRatio=" + (np.polarRadiusRatio||1));
      }
      console.log("[atm-diagnostic] camera eye=("
        + camera.eye[0] + ", " + camera.eye[1] + ", " + camera.eye[2] + ")"
        + " camForward=(" + camera.camForward[0].toFixed(4) + ", "
        + camera.camForward[1].toFixed(4) + ", " + camera.camForward[2].toFixed(4) + ")"
        + " camRight.w=" + camera.camRight[3].toFixed(4)
        + " camUp.w=" + camera.camUp[3].toFixed(4));
      // Project planet center through viewProj to see its expected
      // screen position. If this lands in the planet body's pixels,
      // envPlanet IS at the right place and the bug is shader-side.
      const cx = planetInfo.centerX, cy = planetInfo.centerY, cz = planetInfo.centerZ;
      const vp = camera.viewProj;
      const clipX = vp[0]*cx + vp[4]*cy + vp[8]*cz  + vp[12];
      const clipY = vp[1]*cx + vp[5]*cy + vp[9]*cz  + vp[13];
      const clipZ = vp[2]*cx + vp[6]*cy + vp[10]*cz + vp[14];
      const clipW = vp[3]*cx + vp[7]*cy + vp[11]*cz + vp[15];
      console.log("[atm-diagnostic] planet center projected: clip=("
        + clipX.toFixed(2) + "," + clipY.toFixed(2) + "," + clipZ.toFixed(2) + "," + clipW.toFixed(2)
        + ") ndc=(" + (clipX/clipW).toFixed(3) + "," + (clipY/clipW).toFixed(3) + "," + (clipZ/clipW).toFixed(3) + ")");
    }
    inst.sceneScratch[132] = planetInfo.centerX;
    inst.sceneScratch[133] = planetInfo.centerY;
    inst.sceneScratch[134] = planetInfo.centerZ;
    inst.sceneScratch[135] = planetR;
    inst.sceneScratch[136] = atmTop;
    inst.sceneScratch[137] = scaleHR;
    inst.sceneScratch[138] = scaleHM;
    inst.sceneScratch[139] = sunI;
    inst.sceneScratch[140] = polRatio;
    // Sprint 10-6 v7: terrain height at the camera's lat/lon (meters
    // above planet radius). Sent every frame so the aerial-perspective
    // shader can convert MSL → AGL when looking up the LUT. The LUT
    // is MSL-referenced (densest at sea level), so when camera is over
    // ocean (terrain=0) it works correctly; but over a 5km mountain
    // it treats the camera as if it were in a thick column of 5km
    // of sea-level air, washing out nearby terrain. AGL shifts the
    // reference to local ground so the atmosphere "sits on" the
    // terrain instead of bleeding through it.
    let _terrainAtCamM = 0;
    if (typeof _planetMeshSurfacePos === "function") {
      const _surf = _planetMeshSurfacePos(camera.eye[0], camera.eye[1], camera.eye[2], planetInfo);
      if (_surf) {
        const _sdx = _surf.x - planetInfo.centerX;
        const _sdy = _surf.y - planetInfo.centerY;
        const _sdz = _surf.z - planetInfo.centerZ;
        _terrainAtCamM = Math.max(0, Math.hypot(_sdx, _sdy, _sdz) - planetR);
      }
    }
    inst.sceneScratch[141] = _terrainAtCamM;
    inst.sceneScratch[142] = 0;
    inst.sceneScratch[143] = 0;
  } else {
    inst.sceneScratch[132] = 0; inst.sceneScratch[133] = 0;
    inst.sceneScratch[134] = 0; inst.sceneScratch[135] = 0;
    inst.sceneScratch[136] = 0; inst.sceneScratch[137] = 0;
    inst.sceneScratch[138] = 0; inst.sceneScratch[139] = 0;
    inst.sceneScratch[140] = 1.0;  // polRatio default = 1 (sphere)
    inst.sceneScratch[141] = 0; inst.sceneScratch[142] = 0; inst.sceneScratch[143] = 0;
  }

  // Sprint 8-4 -- biome detail-noise params at scratch slots [144..247]
  // (= bytes 576..991 = uS.biomeParams[26]). 13 biomes x 8 floats each:
  //   [amp, freq, roughness, lacunarity, shape, warpStrength, warpFreq, textureStyleId]
  // Defaults mirror what the previous WGSL const held; PlanetMap's
  // node.params.biomes overrides each row when the user edits.
  const biomeParamsBase = 144;
  for (let bk = 0; bk < 13; bk++) {
    const def = PLANET_BIOME_DETAIL_DEFAULTS[bk];
    const ov  = (planetInfo && planetInfo.mapNode && planetInfo.mapNode.params &&
                 Array.isArray(planetInfo.mapNode.params.biomes) &&
                 planetInfo.mapNode.params.biomes[bk]) || null;
    const off = biomeParamsBase + bk * 8;
    inst.sceneScratch[off + 0] = (ov && typeof ov.amp === "number") ? ov.amp : def[0];
    inst.sceneScratch[off + 1] = (ov && typeof ov.freq === "number") ? ov.freq : def[1];
    inst.sceneScratch[off + 2] = (ov && typeof ov.roughness === "number") ? ov.roughness : def[2];
    inst.sceneScratch[off + 3] = (ov && typeof ov.lacunarity === "number") ? ov.lacunarity : def[3];
    inst.sceneScratch[off + 4] = (ov && typeof ov.shape === "number") ? ov.shape : def[4];
    inst.sceneScratch[off + 5] = (ov && typeof ov.warpStrength === "number") ? ov.warpStrength : def[5];
    inst.sceneScratch[off + 6] = (ov && typeof ov.warpFreq === "number") ? ov.warpFreq : def[6];
    inst.sceneScratch[off + 7] = (ov && typeof ov.textureStyleId === "number") ? ov.textureStyleId : def[7];
  }

  // Sprint 9-3: write proj at the trailing slot (float index 248,
  // byte offset 992). Read by vs_planet_cdlod; other shaders ignore.
  inst.sceneScratch.set(camera.proj, 248);
  Visual.device.queue.writeBuffer(inst.perSceneBuffer, 0, inst.sceneScratch.buffer, 0, 1056);

  // Per-draw loop. Each mesh writes to its OWN per-slot buffer +
  // binds its OWN bind group, so multi-mesh draws work correctly
  // (queue.writeBuffer ordering doesn't interleave with draws).
  //
  // Sprint 5.10 -- frustum culling. Scene.cullEnable (default 1)
  // gates the test. Per mesh: transform local AABB through model
  // matrix, run 6-plane SAT against camera.frustumPlanes. Outside
  // the frustum -> skip draw entirely.
  const sParams = _resolveNodeParams(node);
  const cullEnable = (typeof sParams.cullEnable === "number")
    ? sParams.cullEnable >= 0.5 : true;
  let culledCount = 0;
  const _aabbMinScratch = new Float32Array(3);
  const _aabbMaxScratch = new Float32Array(3);
  let curMaterialType = null;
  // Phase 4b -- grow per-draw slots if the mesh list exceeds the
  // initial 4-slot allocation. Each Level2D tilemap chunk needs its
  // own slot; without growth the encoder would silently drop chunks
  // past slot[3], leaving a 4-chunk visible square in a larger map.
  if (meshes.length > inst.slots.length && typeof inst._allocSlot === "function") {
    const oldCount = inst.slots.length;
    while (inst.slots.length < meshes.length) {
      inst.slots.push(inst._allocSlot(inst.slots.length));
    }
    if (!Visual._slotGrowLogged || Visual._slotGrowLogged < inst.slots.length) {
      Visual._slotGrowLogged = inst.slots.length;
      console.log("[scene] grew per-draw slots: " + node.id + " " + oldCount + " -> " + inst.slots.length +
        " (meshes=" + meshes.length + ")");
    }
  }
  for (let i = 0; i < meshes.length && i < inst.slots.length; i++) {
    const m = meshes[i];
    const slot = inst.slots[i];
    // Sprint 8-7c -- LOD gate for the synthesized planet detail
    // patch. Skip the draw entirely when the camera is above the
    // patch's maxAltitude; the patch's altitude-fade in the vertex
    // shader was previously rendering it as a gray scaled square
    // instead of becoming invisible.
    if (m.isPlanetDetailPatch) {
      const pp = (m.node && m.node.params) || {};
      const maxAlt = (typeof pp.detailPatchMaxAlt === "number") ? pp.detailPatchMaxAlt : 5000;
      const cx = inst.sceneScratch[132];
      const cy = inst.sceneScratch[133];
      const cz = inst.sceneScratch[134];
      const pR = inst.sceneScratch[135];
      if (pR > 0) {
        const dx = camera.eye[0] - cx;
        const dy = camera.eye[1] - cy;
        const dz = camera.eye[2] - cz;
        const camDist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        const camAlt  = Math.max(0, camDist - pR);
        if (camAlt > maxAlt) continue;
      }
    }
    const buf = _ensureMeshBuffers(m);
    // §5.5.e-6 -- TiledTerrain returns buf.tiledChunks (per-chunk
    // VBOs) instead of a single buf.vertexBuffer. Both shapes are
    // valid; skip only if neither is present.
    if (!buf) {
      if (m.node && m.node.type === "Water" && !Visual._waterSkipBufLogged) {
        Visual._waterSkipBufLogged = true;
        console.error("[water] SKIPPED: _ensureMeshBuffers returned null. Mesh build failed?");
      }
      continue;
    }
    if (!buf.vertexBuffer && !(buf.tiledChunks && buf.tiledChunks.length)) {
      if (m.node && m.node.type === "Water" && !Visual._waterSkipVbLogged) {
        Visual._waterSkipVbLogged = true;
        console.error("[water] SKIPPED: no vertexBuffer + no tiledChunks. buf=", buf);
      }
      continue;
    }
    // 5.10 -- frustum cull. Skip mesh draws entirely outside the
    // camera frustum. Tested in world space via 8-corner-transform
    // of the cached local AABB. Diagnostic count logged once per
    // frame so users can see culling actually firing.
    if (cullEnable && camera.frustumPlanes && buf.aabbMin && buf.aabbMax) {
      _transformAABB(buf.aabbMin, buf.aabbMax, m.transform,
                     _aabbMinScratch, _aabbMaxScratch);
      if (!_aabbInsideFrustum(camera.frustumPlanes, _aabbMinScratch, _aabbMaxScratch)) {
        culledCount++;
        continue;
      }
    }
    // Sprint plat-2a-render -- textured-sprite dispatch. Sprites with
    // a wired (and loaded) ImageURL on their `texture` input render
    // through the dedicated sprite pipeline (3-binding BGL: drawU,
    // texture, sampler). After the draw, curMaterialType is cleared
    // so the next mesh in the loop re-sets its own pipeline state.
    // Sprint Level2D Phase 2 -- Tilemap2D enters the sprite-pipeline
    // branch when it has a textured tileset (params.tileset). Without
    // a tileset it falls through to the unlit-vc mesh pipeline below.
    if (m.node && (
        m.node.type === "Sprite"
        || m.node.type === "TileSpriteOverlay"
        || m.node.type === "ParallaxLayer2D"
        || m.node.type === "SpriteScatter2D"
        || (m.node.type === "Tilemap2D" && _tilemap2dUsesTileset(m.node))
      ) && buf && buf.vertexBuffer) {
      const texEntry = (typeof _resolveSpriteTextureEntry === "function")
        ? _resolveSpriteTextureEntry(m.node) : null;
      if (texEntry && texEntry.state === "ready" && texEntry.view) {
        const spritePipeline = _ensureSpritePipeline(sampleCount);
        if (spritePipeline) {
          const sp = _resolveNodeParams(m.node);
          // Sampler filter follows the upstream ImageURL's filterMode
          // (default nearest = pixel-art crisp).
          let filterMode = "nearest";
          let wrapMode   = "clamp";
          // Level2D Phase 1a: synthetic layer nodes carry filter/wrap
          // inline in their _levelLayer config; everything else walks
          // the texture wire to the upstream ImageURL.
          if (m.node._levelLayer) {
            if (typeof m.node._levelLayer.filterMode === "string") filterMode = m.node._levelLayer.filterMode;
            if (typeof m.node._levelLayer.wrapMode   === "string") wrapMode   = m.node._levelLayer.wrapMode;
          } else {
            const texWire = state && Array.isArray(state.edges) && state.edges.find(e =>
              e && e.to && e.to.node === m.node.id && e.to.port === "texture"
            );
            if (texWire && texWire.from) {
              const imgNode = state.nodes.find(n => n && n.id === texWire.from.node);
              if (imgNode && imgNode.params) {
                if (typeof imgNode.params.filterMode === "string") filterMode = imgNode.params.filterMode;
                if (typeof imgNode.params.wrapMode   === "string") wrapMode   = imgNode.params.wrapMode;
              }
            }
          }
          const sampler = _ensureSpriteSampler(filterMode, wrapMode);
          const inst = _ensureSpriteInstance(m.node, texEntry.view, sampler);
          if (inst) {
            // Pack uniform: modelViewProj (16) + tint (4) + frameMeta (4) = 24 floats.
            const mvp = inst.scratch;
            // viewProj * model -- model is m.transform (Translate-chain composed).
            const tmp = new Float32Array(16);
            _mat4Multiply(tmp, camera.viewProj, m.transform || _mat4Identity());
            for (let k = 0; k < 16; k++) mvp[k] = tmp[k];
            mvp[16] = (typeof sp.tintR === "number") ? sp.tintR : 1.0;
            mvp[17] = (typeof sp.tintG === "number") ? sp.tintG : 1.0;
            mvp[18] = (typeof sp.tintB === "number") ? sp.tintB : 1.0;
            mvp[19] = (typeof sp.tintA === "number") ? sp.tintA : 1.0;
            mvp[20] = (typeof sp.frame   === "number") ? Math.floor(sp.frame)   : 0;
            mvp[21] = (typeof sp.framesX === "number") ? Math.max(1, Math.floor(sp.framesX)) : 1;
            mvp[22] = (typeof sp.framesY === "number") ? Math.max(1, Math.floor(sp.framesY)) : 1;
            mvp[23] = (typeof sp.flipX   === "number" && sp.flipX >= 0.5) ? 1.0 : 0.0;
            Visual.device.queue.writeBuffer(inst.uniformBuffer, 0, mvp.buffer, 0, 24 * 4);
            pass.setPipeline(spritePipeline);
            pass.setBindGroup(0, inst.bindGroup);
            pass.setVertexBuffer(0, buf.vertexBuffer);
            if (buf.indexBuffer) {
              pass.setIndexBuffer(buf.indexBuffer, "uint32");
              pass.drawIndexed(buf.indexCount);
            } else {
              pass.draw(buf.vertexCount);
            }
            curMaterialType = null;  // next mesh must re-set the mesh pipeline + bind group
            if (!Visual._spriteFirstDrawLogged) {
              Visual._spriteFirstDrawLogged = true;
              console.log("[sprite] first textured draw: node=" + m.node.id
                + " tex=" + texEntry.width + "×" + texEntry.height
                + " filter=" + filterMode
                + " frame=" + mvp[20] + "/" + (mvp[21] * mvp[22]));
            }
            continue;
          }
        }
      }
      // Sprite without a loaded texture falls through to the standard
      // unlit-vc path (solid-color from vertex tint). Same behavior as
      // before platformer-2a so unwired sprites keep working.
    }
    // §5.5.h -- Water node bakes its own material; override matType
    // so fs_water fires regardless of any wired Material.
    // §5.5.h-14 -- same pattern for Clouds3D -> fs_clouds.
    let matType = (m.material && m.material.type) || "unlit-vc";
    if (m.node && m.node.type === "Clouds3D") {
      matType = "clouds";
    }
    // §5.5.h-24 -- TerrainHorizon gets its own pipeline with a
    // camera-distance discard so it doesn't draw over the chunked
    // TiledTerrain inside the visible disc.
    if (m.node && m.node.type === "TerrainHorizon") {
      matType = "horizon";
    }
    if (m.node && m.node.type === "Water") {
      matType = "water";
      if (!Visual._waterDrawLogged) {
        Visual._waterDrawLogged = true;
        const tt = state && state.nodes && state.nodes.find(n => n && n.type === "TiledTerrain");
        const ttp = tt && tt.params;
        console.log("[water] reached encoder: slot=" + i +
                    " verts=" + buf.vertexCount +
                    " indices=" + buf.indexCount +
                    " aabb=[" + (buf.aabbMin ? buf.aabbMin.join(",") : "?") +
                    "..." + (buf.aabbMax ? buf.aabbMax.join(",") : "?") + "]");
        if (ttp) {
          console.log("[water] terrain noise params from TiledTerrain: " +
                      "seed=" + ttp.seed +
                      " freq=" + ttp.frequency +
                      " octs=" + ttp.octaves +
                      " hs=" + ttp.heightScale +
                      " yOff=" + ttp.yOffset +
                      " plateau=" + ttp.plateau +
                      " islandMode=" + ttp.islandMode);
        } else {
          console.log("[water] no TiledTerrain found -- shore detect will use fallback (open ocean everywhere).");
        }
      }
    }
    // v0.3.126 §5.5.c-3 -- detect Terrain w/ heightmap wired ->
    // pick the `displaced` pipeline variant so vs_terrain runs in
    // place of vs_main. Plan walker schedules the heightmap source
    // (ProceduralTerrain or whatever) into a scratch slot before
    // Scene's pass; we resolve the layer index below for vsParams.
    const isTerrainGen = m.node && m.node.type === "Terrain";
    let hmWire = null;
    if (isTerrainGen) {
      hmWire = state.edges.find(e =>
        e && e.to && e.to.node === m.node.id && e.to.port === "heightmap"
      );
    }
    const useDisplaced = !!(isTerrainGen && hmWire && hmWire.from);
    // Phase 8 sprint 8-7b: synthesized detail-patch entries use
    // vs_planet_detail. Flag set by _resolveSceneMeshes alongside
    // PlanetMesh; the node still points to the PlanetMesh for
    // param access.
    //
    // Sprint 9-2c: PlanetMesh chunks (resolved through
    // _ensurePlanetMeshChunks, kind=mesh-gen) use the CDLOD vertex
    // shader. The 14-float per-vertex layout requires the matching
    // pipeline variant -- routing it via vsVariant keeps the
    // pipeline-cache key correct and the input attribute layout in
    // sync with the VBO.
    const vsVariant = m.isPlanetDetailPatch        ? "planet_detail"
                    : (m.node && m.node.type === "PlanetMesh") ? "planet_cdlod"
                    : null;
    const pipelineKeyStr = matType + (useDisplaced ? "+d" : "") + (vsVariant ? ("+" + vsVariant) : "");
    if (pipelineKeyStr !== curMaterialType) {
      const pipeline = _ensureMeshPipeline(matType, sampleCount, useDisplaced, vsVariant);
      if (!pipeline) continue;
      pass.setPipeline(pipeline);
      curMaterialType = pipelineKeyStr;
    }
    // Write model + material into THIS slot's per-draw buffer.
    // Sprint 9-3: PlanetMesh chunks use mv_rtc (view * translate(anchor)
    // composed JS-side in f64) instead of m.transform. The chunk's
    // anchorF64 lives on each tiledChunks entry; for now all chunks
    // of a PlanetMesh share the planet-center anchor so we read the
    // first chunk's anchor and compose mv_rtc once per mesh. Per-chunk
    // dynamic-offset upload (true foot-level f32 precision) is 9-3b.
    if (vsVariant === "planet_cdlod" && buf && buf.tiledChunks && buf.tiledChunks.length > 0 && camera.viewF64) {
      const anchor = buf.tiledChunks[0].anchorF64 || { x: 0, y: 0, z: 0 };
      const mvRtc = _composeRtcModelView(camera.viewF64, anchor, m.transform || _mat4Identity());
      inst.drawScratch.set(mvRtc, 0);
    } else {
      inst.drawScratch.set(m.transform, 0);
    }
    let mp = (m.material && m.material.params) || {};
    // §5.5.h -- Water packs its own params from m.node (mesh-gen
    // doubles as material since Water bakes the shader in).
    // §5.5.h-14 -- same pattern for Clouds3D.
    if (matType === "water" && m.node && m.node.params) mp = m.node.params;
    if (matType === "clouds" && m.node && m.node.params) mp = m.node.params;
    inst.drawScratch[16] = (typeof mp.r === "number") ? mp.r : ((typeof mp.colorR === "number") ? mp.colorR : 1.0);
    inst.drawScratch[17] = (typeof mp.g === "number") ? mp.g : ((typeof mp.colorG === "number") ? mp.colorG : 1.0);
    inst.drawScratch[18] = (typeof mp.b === "number") ? mp.b : ((typeof mp.colorB === "number") ? mp.colorB : 1.0);
    inst.drawScratch[19] = (typeof mp.vertexMix === "number") ? mp.vertexMix : (matType === "unlit-vc" ? 1.0 : 0.0);
    inst.drawScratch[20] = (typeof mp.shininess === "number") ? mp.shininess : 32.0;
    inst.drawScratch[21] = (typeof mp.ambient   === "number") ? mp.ambient   : 0.15;
    inst.drawScratch[22] = (typeof mp.metallic  === "number") ? mp.metallic  : 0.0;
    inst.drawScratch[23] = (typeof mp.roughness === "number") ? mp.roughness : 0.5;
    // A.4 -- pbr reads matParams.x as a UV tile factor (fs_pbr ignores
    // .x/.y otherwise). Default 1 = no tiling. Lets seamless textures
    // repeat across large faces without a per-mesh UV-gen change.
    if (matType === "pbr") {
      inst.drawScratch[20] = (typeof mp.uvScale === "number" && mp.uvScale > 0) ? mp.uvScale : 1.0;
    }
    // §5.5.h -- Water remap. See fs_water for the per-slot legend.
    if (matType === "water") {
      inst.drawScratch[19] = (typeof mp.fresnelStrength === "number") ? mp.fresnelStrength : 1.0;
      inst.drawScratch[20] = (typeof mp.seaLevel  === "number") ? mp.seaLevel  : 0;
      inst.drawScratch[21] = (typeof mp.waveFreq  === "number") ? mp.waveFreq  : 0.012;
      inst.drawScratch[22] = (typeof mp.waveSpeed === "number") ? mp.waveSpeed : 0.6;
      inst.drawScratch[23] = (typeof mp.waveAmp   === "number") ? mp.waveAmp   : 1.0;
      inst.drawScratch[24] = (typeof mp.skyR === "number") ? mp.skyR : 0.62;
      inst.drawScratch[25] = (typeof mp.skyG === "number") ? mp.skyG : 0.78;
      inst.drawScratch[26] = (typeof mp.skyB === "number") ? mp.skyB : 0.92;
      if (!Visual._waterStartT) Visual._waterStartT = performance.now();
      inst.drawScratch[27] = (performance.now() - Visual._waterStartT) * 0.001;
      // §5.5.h-5 -- shore detection. The Water node's `heightmap`
      // input takes a wire from a TiledTerrain's `heightmap` output;
      // we walk state.edges to find that wire's source. If unwired,
      // shore detect is disabled (depth defaults to "open ocean
      // everywhere" in fs_water).
      let tt = null;
      if (state && Array.isArray(state.edges)) {
        const hmWire = state.edges.find(e =>
          e && e.to && e.to.node === m.node.id && e.to.port === "heightmap"
        );
        if (hmWire && hmWire.from) {
          const src = state.nodes.find(n => n && n.id === hmWire.from.node);
          if (src && src.type === "TiledTerrain") tt = src;
        }
      }
      if (tt && tt.params) {
        const tp2 = tt.params;
        inst.drawScratch[28] = (typeof tp2.seed       === "number") ? tp2.seed       : 7.42;
        inst.drawScratch[29] = (typeof tp2.frequency  === "number") ? tp2.frequency  : 0.008;
        inst.drawScratch[30] = (typeof tp2.octaves    === "number") ? tp2.octaves    : 6;
        inst.drawScratch[31] = (typeof tp2.plateau    === "number") ? tp2.plateau    : 0;
        inst.drawScratch[32] = (typeof tp2.lacunarity === "number") ? tp2.lacunarity : 2.0;
        inst.drawScratch[33] = (typeof tp2.gain       === "number") ? tp2.gain       : 0.5;
        inst.drawScratch[34] = (typeof tp2.ridges     === "number") ? tp2.ridges     : 0;
        inst.drawScratch[35] = (typeof tp2.heightScale=== "number") ? tp2.heightScale: 80;
        inst.drawScratch[36] = (typeof tp2.yOffset    === "number") ? tp2.yOffset    : 0;
        inst.drawScratch[37] = (typeof tp2.islandSinkDepth === "number") ? tp2.islandSinkDepth : 0;
        inst.drawScratch[38] = (tp2.islandMode === "archipelago") ? 1 : 0;
        inst.drawScratch[39] = (typeof tp2.islandMaskFreq      === "number") ? tp2.islandMaskFreq      : 0.0001;
        inst.drawScratch[40] = (typeof tp2.islandMaskSeed      === "number") ? tp2.islandMaskSeed      : 0;
        inst.drawScratch[41] = (typeof tp2.islandMaskThreshold === "number") ? tp2.islandMaskThreshold : 0.5;
        inst.drawScratch[42] = (typeof tp2.islandMaskSoftness  === "number") ? tp2.islandMaskSoftness  : 0.08;
      } else {
        for (let s = 28; s <= 42; s++) inst.drawScratch[s] = 0;
      }
      inst.drawScratch[43] = (typeof mp.foamWidth      === "number") ? mp.foamWidth      : 6;
      inst.drawScratch[44] = (typeof mp.shallowDepth   === "number") ? mp.shallowDepth   : 40;
      inst.drawScratch[45] = (typeof mp.waveShoreFreq  === "number") ? mp.waveShoreFreq  : 0.018;
      inst.drawScratch[46] = (typeof mp.foamR === "number") ? mp.foamR : 0.96;
      inst.drawScratch[47] = (typeof mp.foamG === "number") ? mp.foamG : 0.97;
      inst.drawScratch[48] = (typeof mp.foamB === "number") ? mp.foamB : 1.00;
      // §5.5.h-4 -- pack the TiledTerrain LOD geometry into
      // bumpParams.yzw so fs_water can sample at the same grid
      // density the mesh uses. Without these the shader samples
      // exact noise and the foam line drifts off the discretized
      // mesh edge at distant LOD rings.
      if (tt && tt.params) {
        inst.drawScratch[49] = (typeof tt.params.chunkSize   === "number") ? tt.params.chunkSize   : 64;
        inst.drawScratch[50] = (typeof tt.params.segments    === "number") ? tt.params.segments    : 24;
        inst.drawScratch[51] = (typeof tt.params.chunkRadius === "number") ? tt.params.chunkRadius : 8;
        // §5.5.h-5 -- actual disc center tile (with forwardBias).
        // Using camera tile as fallback caused east/west water to
        // disappear because the LOD ring calc was off by the bias
        // shift. _tiledTerrainCenterTile applies the bias internally.
        const dc = (typeof _tiledTerrainCenterTile === "function")
          ? _tiledTerrainCenterTile(tt) : { tx: 0, tz: 0 };
        inst.drawScratch[52] = dc.tx;
        inst.drawScratch[53] = dc.tz;
        // §5.5.h-9 -- beach band params from upstream TiledTerrain.
        // Drives fs_water's beach blend so shore detect lines up with
        // the mesh's flattened beach zones.
        inst.drawScratch[54] = (typeof tt.params.islandBeachStrength === "number") ? tt.params.islandBeachStrength : 0;
        inst.drawScratch[55] = (typeof tt.params.islandBeachFreq     === "number") ? tt.params.islandBeachFreq     : 0.0008;
      } else {
        inst.drawScratch[49] = 0; inst.drawScratch[50] = 0; inst.drawScratch[51] = 0;
        inst.drawScratch[52] = 0; inst.drawScratch[53] = 0;
      }
      // §5.5.h-21 -- cloud-shadow params from any Clouds3D node in
      // the patch. Slots 56..59 map to PerDraw.cloudExtra.xyzw =
      // (altitude, coverage, scale, seed). coverage=0 disables the
      // shadow path in fs_water.
      let cl = null;
      if (state && Array.isArray(state.nodes)) {
        cl = state.nodes.find(n => n && n.type === "Clouds3D");
      }
      if (cl && cl.params) {
        inst.drawScratch[56] = (typeof cl.params.altitude === "number") ? cl.params.altitude : 2500;
        inst.drawScratch[57] = (typeof cl.params.coverage === "number") ? cl.params.coverage : 0;
        inst.drawScratch[58] = (typeof cl.params.scale    === "number") ? cl.params.scale    : 0.0008;
        inst.drawScratch[59] = (typeof cl.params.seed     === "number") ? cl.params.seed     : 11.3;
      } else {
        inst.drawScratch[56] = 0; inst.drawScratch[57] = 0;
        inst.drawScratch[58] = 0; inst.drawScratch[59] = 0;
      }
    }
    // §5.5.h-17 -- Clouds3D remap. fs_clouds is now a Phong-style
    // shader over a CPU-built displaced mesh. Reads:
    //   baseColor.rgb = cloud color, baseColor.a = density (alpha mult)
    //   matParams.x = ambient fill light strength
    //   matParams.y = sun-dot contribution strength
    //   matParams.zw = unused
    if (matType === "clouds") {
      inst.drawScratch[16] = (typeof mp.colorR === "number") ? mp.colorR : 1.0;
      inst.drawScratch[17] = (typeof mp.colorG === "number") ? mp.colorG : 1.0;
      inst.drawScratch[18] = (typeof mp.colorB === "number") ? mp.colorB : 1.0;
      inst.drawScratch[19] = (typeof mp.density === "number") ? mp.density : 1.0;
      inst.drawScratch[20] = (typeof mp.ambient     === "number") ? mp.ambient     : 0.55;
      inst.drawScratch[21] = (typeof mp.sunStrength === "number") ? mp.sunStrength : 0.65;
      inst.drawScratch[22] = 0;
      inst.drawScratch[23] = 0;
      // Clear remaining slots so stale water/terrain data doesn't bleed.
      for (let s = 24; s < 56; s++) inst.drawScratch[s] = 0;
    }
    // §5.5.h-24 -- TerrainHorizon remap. fs_horizon reads:
    //   matParams.x = innerRadius (camera-XZ discard radius)
    //   matParams.y = fadeWidth   (smoothstep band beyond innerRadius)
    //   matParams.z = ambient
    //   matParams.w = sunStrength
    // innerRadius pulls from the patch's TiledTerrain (chunkRadius *
    // chunkSize, scaled by 0.9 so the impostor fades in just before
    // the chunked disc's outer edge instead of leaving a visible gap).
    if (matType === "horizon") {
      let innerR = 4000;
      const ttx = state && Array.isArray(state.nodes) && state.nodes.find(n => n && n.type === "TiledTerrain");
      if (ttx && ttx.params) {
        const cs = (typeof ttx.params.chunkSize   === "number") ? ttx.params.chunkSize   : 256;
        const cr = (typeof ttx.params.chunkRadius === "number") ? ttx.params.chunkRadius : 8;
        innerR = Math.max(1000, cs * cr * 0.9);
      }
      inst.drawScratch[16] = 1; inst.drawScratch[17] = 1; inst.drawScratch[18] = 1;
      inst.drawScratch[19] = 1;
      inst.drawScratch[20] = innerR;
      inst.drawScratch[21] = Math.max(200, innerR * 0.15);     // fadeWidth ~ 15% of innerR
      inst.drawScratch[22] = 0.55;                              // ambient
      inst.drawScratch[23] = 0.65;                              // sunStrength
      for (let s = 24; s < 56; s++) inst.drawScratch[s] = 0;
      // §5.5.h-25 -- planet curvature params for vs_horizon. Read
      // from the TerrainHorizon node's own params with sensible
      // defaults; band1.xyz = (altLow, altHigh, planetRadius).
      // §planet-spec Phase 1.5 -- band1.w = visAltLow, band2.x =
      // visAltHigh. fs_horizon discards fragments at camera Y below
      // visAltLow and fades in over [visAltLow, visAltHigh].
      const hp = (m.node && m.node.params) || {};
      inst.drawScratch[24] = (typeof hp.curveAltLow  === "number") ? hp.curveAltLow  : 2000;
      inst.drawScratch[25] = (typeof hp.curveAltHigh === "number") ? hp.curveAltHigh : 8000;
      inst.drawScratch[26] = (typeof hp.planetRadius === "number") ? hp.planetRadius : 200000;
      inst.drawScratch[27] = (typeof hp.visAltLow    === "number") ? hp.visAltLow    : 60000;
      inst.drawScratch[28] = (typeof hp.visAltHigh   === "number") ? hp.visAltHigh   : 100000;
      inst.drawScratch[29] = 0; inst.drawScratch[30] = 0; inst.drawScratch[31] = 0;
    }
    // Phase 7 §5.5.c -- TerrainMaterial uses the extended band
    // slots [24..39] and reinterprets matParams as
    // (shininess, ambient, slopeRockiness, vertexMix). Other
    // materials don't touch [24..39] -- the GPU just reads from
    // its own slots and ignores the rest of the uniform.
    if (matType === "terrain") {
      // Auto-scale Y-dependent material params by the upstream
      // Terrain's effective heightScale, so altitude bands stay
      // proportional when the user changes sizeMode (small / medium
      // / large / infinite / custom). Default heightScale = 12 at
      // worldSize = 100 (medium) matches the alt defaults (-8/-4/-1).
      // For any other (heightScale × worldSize/100) pair, scale alts,
      // edgeJitter, and softness by the ratio so a "large" landscape
      // sees the snow line at Y=-10 instead of where the whole
      // terrain sits. Inverse-scale detail / micro noise frequencies
      // so a person walking the larger world sees roughly the same
      // visual texture density per step. If the mesh source isn't
      // a Terrain node (rare -- material on a Sphere, etc.), bandScale
      // stays at 1 and behavior matches v0.3.131.
      let bandScale = 1;
      let xzScale   = 1;
      if (m.node && m.node.type === "Terrain") {
        const ttp = m.node.params || {};
        const sizePresetsM = { small: 20, medium: 100, large: 1000, infinite: 10000 };
        const tMode = (typeof ttp.sizeMode === "string") ? ttp.sizeMode : "medium";
        const tCustomSize = (typeof ttp.worldSize === "number") ? ttp.worldSize : 100;
        const tWS = (tMode === "custom") ? tCustomSize : (sizePresetsM[tMode] || tCustomSize);
        const tHsRaw = (typeof ttp.heightScale === "number") ? ttp.heightScale : 12;
        const tEffectiveHs = tHsRaw * (tWS / 100);
        bandScale = tEffectiveHs / 12;        // default 1
        xzScale   = 100 / Math.max(1, tWS);   // default 1 at medium; <1 at larger
      } else if (m.node && m.node.type === "TiledTerrain") {
        // §5.5.e -- TiledTerrain's heightScale IS the world Y range
        // directly (no worldSize ratio). xzScale derived from the
        // visible-disc diameter so detail noise stays at the same
        // visual density per step as the user walks.
        const ttp = m.node.params || {};
        const tHs = (typeof ttp.heightScale === "number") ? ttp.heightScale : 20;
        const tCS = (typeof ttp.chunkSize   === "number") ? ttp.chunkSize   : 32;
        const tR  = (typeof ttp.chunkRadius === "number") ? ttp.chunkRadius : 4;
        const tDiameter = (2 * tR + 1) * tCS;
        bandScale = tHs / 12;
        xzScale   = 100 / Math.max(1, tDiameter);
      }
      inst.drawScratch[20] = mp.shininess;
      inst.drawScratch[21] = mp.ambient;
      inst.drawScratch[22] = mp.slopeRockiness;
      inst.drawScratch[23] = mp.vertexMix;
      // band1 = sand
      inst.drawScratch[24] = mp.color1R; inst.drawScratch[25] = mp.color1G; inst.drawScratch[26] = mp.color1B; inst.drawScratch[27] = mp.alt1 * bandScale;
      // band2 = grass
      inst.drawScratch[28] = mp.color2R; inst.drawScratch[29] = mp.color2G; inst.drawScratch[30] = mp.color2B; inst.drawScratch[31] = mp.alt2 * bandScale;
      // band3 = rock
      inst.drawScratch[32] = mp.color3R; inst.drawScratch[33] = mp.color3G; inst.drawScratch[34] = mp.color3B; inst.drawScratch[35] = mp.alt3 * bandScale;
      // band4 = snow + softness (smoothstep width in Y units -> scales).
      inst.drawScratch[36] = mp.color4R; inst.drawScratch[37] = mp.color4G; inst.drawScratch[38] = mp.color4B; inst.drawScratch[39] = mp.softness * bandScale;
      // detailParams (vec4) at [44..47]; bumpParams (vec4) at [48..51].
      // Noise frequencies (detailScale / microScale) are cycles per
      // world unit -- inverse-scale so larger worlds get coarser
      // noise per step. Strengths + bump are dimensionless, pass-through.
      // edgeJitter is in Y world units, so it scales like alt.
      inst.drawScratch[44] = mp.detailScale * xzScale;
      inst.drawScratch[45] = mp.detailStrength;
      inst.drawScratch[46] = mp.microScale * xzScale;
      inst.drawScratch[47] = mp.microStrength;
      inst.drawScratch[48] = mp.edgeJitter * bandScale;
      inst.drawScratch[49] = mp.bumpStrength;
      inst.drawScratch[50] = mp.snowMaskAmount;
      inst.drawScratch[51] = 0;
    }
    // Sprint 7.5.3c push 5 -- for ShaderMat with a wired texture
    // input, look up the upstream's scratch layer + override
    // matParams.w (roughness slot) with the layer index. The
    // "texture" preset reads this to know which scratch layer to
    // sample. Other presets ignore matParams.w (it was reserved
    // before this push).
    if (matType.indexOf("shadermat-") === 0 && m.material && m.material.node) {
      const texWire = state.edges.find(e =>
        e && e.to && e.to.node === m.material.node.id && e.to.port === "texture"
      );
      if (texWire && texWire.from) {
        const planMap = Visual._currentRenderPlan;
        const upstreamEntry = planMap && planMap.get(texWire.from.node + "@" + entry.consumerVO.id);
        if (upstreamEntry && upstreamEntry.isScratch) {
          inst.drawScratch[23] = upstreamEntry.layerIdx;
        }
      }
    }
    // v0.3.126 §5.5.c-3 -- when this Terrain draw uses the
    // displaced vertex shader, pack vsParams: heightScale,
    // worldSize, _, heightmap-layer-index. Pulls the layer from
    // the render plan (same lookup ShaderMat.texture uses).
    if (useDisplaced) {
      const tp = m.node.params || {};
      const sizePresets = { small: 20, medium: 100, large: 1000, infinite: 10000 };
      const mode = (typeof tp.sizeMode === "string") ? tp.sizeMode : "medium";
      const customSize = (typeof tp.worldSize === "number") ? tp.worldSize : 100;
      const ws = (mode === "custom") ? customSize : (sizePresets[mode] || customSize);
      // Match _buildTerrain: scale vertical gain by world size so
      // the GPU-displaced path stays in sync with the CPU path
      // (always-on ratio, including custom mode).
      const hsRawT = (typeof tp.heightScale === "number") ? tp.heightScale : 12;
      const hsScaleT = ws / 100;
      const hsT = hsRawT * hsScaleT;
      let hmLayer = 0;
      const planMap = Visual._currentRenderPlan;
      const upstreamEntry = planMap && planMap.get(hmWire.from.node + "@" + entry.consumerVO.id);
      if (upstreamEntry) hmLayer = upstreamEntry.layerIdx;
      // vsParams lives at slots [40..43]. vs_terrain reads .x/.y/.w.
      inst.drawScratch[40] = hsT;
      inst.drawScratch[41] = ws;
      inst.drawScratch[42] = 0;
      inst.drawScratch[43] = hmLayer;
    } else if (matType !== "water") {
      // Clear vsParams when not displaced (avoids stale layer values
      // from a previous draw on the same slot in the same frame).
      // SKIP for water: the water block above packs its own
      // vsParams (mask seed / threshold / softness / foamWidth) and
      // clearing here would overwrite them with zeros -- which
      // collapses the shore-detect smoothstep to land=1 everywhere
      // and renders the entire water plane as solid foam-white.
      inst.drawScratch[40] = 0;
      inst.drawScratch[41] = 0;
      inst.drawScratch[42] = 0;
      inst.drawScratch[43] = 0;
    }
    // Sprint 9-3 / 9-4-fix: for PlanetMesh draws, vsParams now
    // carries the f32 approximation of the chunk's anchorF64 so
    // vs_planet_cdlod can reconstruct world position by adding it
    // to the anchor-relative vertex. (sprint 9-3 had repurposed
    // uD.model for mv_rtc = view * translate(anchor), which lands
    // pos in VIEW space; the fragment-side worldPos consumers --
    // biome textures, atmosphere, lighting -- need true world
    // space.) The old displacementScale-flag use of vsParams in
    // vs_main is retired (displacementScale default 0 after 9-1).
    if (m.node && m.node.type === "PlanetMesh" && !m.isPlanetDetailPatch
        && buf && buf.tiledChunks && buf.tiledChunks.length > 0) {
      const anchor = buf.tiledChunks[0].anchorF64 || { x: 0, y: 0, z: 0 };
      inst.drawScratch[40] = anchor.x;   // vsParams.x = anchorF32.x
      inst.drawScratch[41] = anchor.y;   // vsParams.y = anchorF32.y
      inst.drawScratch[42] = anchor.z;   // vsParams.z = anchorF32.z
      inst.drawScratch[43] = 0;
    }
    // Phase 8 sprint 8-7b -- synthesized planet detail-patch
    // per-draw uniforms. Reads detailPatch* params from the
    // PlanetMesh node that the patch is attached to.
    if (m.isPlanetDetailPatch) {
      const dpp = (m.node && m.node.params) || {};
      inst.drawScratch[40] = (typeof dpp.detailPatchSize     === "number") ? dpp.detailPatchSize     : 3000.0;
      let patchBiomeId      = (typeof dpp.detailPatchBiomeId  === "number") ? dpp.detailPatchBiomeId  : 4.0;
      inst.drawScratch[42] = (typeof dpp.detailPatchDispScale === "number") ? dpp.detailPatchDispScale : 1.0;
      inst.drawScratch[43] = (typeof dpp.detailPatchMaxAlt   === "number") ? dpp.detailPatchMaxAlt   : 5000.0;

      // Sprint 8-7d -- per-frame macro-elevation + biome lookup for
      // the camera's location. Sprint 8-8 routes this through the
      // shared _planetMeshSurfacePos helper so the patch, altimeter,
      // walk-mode lock, and flight collision all read the SAME cell.
      // Previously this used an inline cell lookup that, while
      // matching the formula, made it easy to drift apart on later
      // edits.
      let macroElev = 0.0;
      const _patchPL = _findPlanetInfo();
      if (_patchPL && _patchPL.mapNode && _patchPL.mapNode._cells) {
        const surf = _planetMeshSurfacePos(camera.eye[0], camera.eye[1], camera.eye[2], _patchPL);
        if (surf) {
          macroElev = surf.altitude;
          if (surf.biomeId >= 0) patchBiomeId = surf.biomeId;
        }
      }
      inst.drawScratch[41] = patchBiomeId;
      // baseColor.w (slot 19) repurposed as macro elevation for the
      // patch draw. The vertex shader adds this to the surface radial
      // position so the patch lines up with the PlanetMesh's macro
      // terrain instead of sitting at bare sea level under the camera.
      inst.drawScratch[19] = macroElev;
    }
    // Phase 8 sprint 8-3b -- PlanetMesh texture layer resolution.
    // Slots [60..63] map to PerDraw.planetExtra.xyzw = (landLayer,
    // waterLayer, textureScale, textureMix). Default to "no
    // texture" (-1) so unwired planet draws keep the existing biome
    // / water shading. When the PlanetMesh node has landTexture or
    // waterTexture wires, the upstream's scratch slot is resolved
    // via the same render-plan lookup ShaderMat uses.
    inst.drawScratch[60] = -1;
    inst.drawScratch[61] = -1;
    inst.drawScratch[62] = 0.001;
    inst.drawScratch[63] = 0.0;
    if (m.node && m.node.type === "PlanetMesh") {
      const ptp = m.node.params || {};
      const planMap = Visual._currentRenderPlan;
      const landWire = state && Array.isArray(state.edges) && state.edges.find(e =>
        e && e.to && e.to.node === m.node.id && e.to.port === "landTexture"
      );
      if (landWire && landWire.from) {
        const upstreamEntry = planMap && planMap.get(landWire.from.node + "@" + entry.consumerVO.id);
        if (upstreamEntry && upstreamEntry.isScratch) {
          inst.drawScratch[60] = upstreamEntry.layerIdx;
        }
      }
      const waterWire = state && Array.isArray(state.edges) && state.edges.find(e =>
        e && e.to && e.to.node === m.node.id && e.to.port === "waterTexture"
      );
      if (waterWire && waterWire.from) {
        const upstreamEntry = planMap && planMap.get(waterWire.from.node + "@" + entry.consumerVO.id);
        if (upstreamEntry && upstreamEntry.isScratch) {
          inst.drawScratch[61] = upstreamEntry.layerIdx;
        }
      }
      inst.drawScratch[62] = (typeof ptp.textureScale === "number") ? ptp.textureScale : 0.001;
      inst.drawScratch[63] = (typeof ptp.textureMix   === "number") ? ptp.textureMix   : 1.0;
    }
    Visual.device.queue.writeBuffer(slot.perDrawBuffer, 0, inst.drawScratch.buffer, 0, 256);
    // A.4 -- per-material PBR maps. If this slot's mesh has a
    // PhysicalMat with map params, stream them + rebind the slot's
    // bind groups with the resolved views (keyed so we only rebuild
    // when the loaded set changes). Untextured slots keep the 1×1
    // defaults (no-op).
    if (slot.setMaterialTextures && m.material && m.material.node &&
        m.material.node.type === "PhysicalMat") {
      const mn = m.material.node, mpp = mn.params || {};
      if (mpp.albedoMap || mpp.normalMap || mpp.roughMap || mpp.metalMap) {
        _ensureMatTextures(mn);
        const key = (mn._mapAlbedo ? "a" : "") + (mn._mapNormal ? "n" : "") +
                    (mn._mapRough ? "r" : "") + (mn._mapMetal ? "m" : "");
        if (slot._matKey !== key) {
          slot.setMaterialTextures({ albedo: mn._mapAlbedo, normal: mn._mapNormal, rough: mn._mapRough, metal: mn._mapMetal });
          slot._matKey = key;
        }
      } else if (slot._matKey !== "") {
        slot.setMaterialTextures(null);
        slot._matKey = "";
      }
    }
    // v0.3.120 -- pick the bind group whose binding 2 is OPPOSITE
    // parity to the scratch layer we're writing to. Prevents the
    // texture-as-binding-and-attachment aliasing that silently broke
    // Scene → composition chains (Scene → CRT, Scene → Blur, etc.).
    const bg = (entry.readKey === "b") ? slot.bindGroupB : slot.bindGroupA;
    pass.setBindGroup(0, bg);
    // §5.5.e-6 -- per-chunk VBO/IBO draw for TiledTerrain streaming.
    // Each chunk has its OWN vertex + index buffer (so chunks can
    // be destroyed independently when they leave the visible disc).
    // Frustum-cull per chunk, then bind chunk's buffers + draw.
    if (buf.tiledChunks) {
      let chunkCulled = 0;
      for (let ck = 0; ck < buf.tiledChunks.length; ck++) {
        const c = buf.tiledChunks[ck];
        if (cullEnable && camera.frustumPlanes) {
          _transformAABB(c.aabbMin, c.aabbMax, m.transform,
                         _aabbMinScratch, _aabbMaxScratch);
          if (!_aabbInsideFrustum(camera.frustumPlanes, _aabbMinScratch, _aabbMaxScratch)) {
            chunkCulled++;
            continue;
          }
        }
        pass.setVertexBuffer(0, c.vertexBuffer);
        pass.setIndexBuffer(c.indexBuffer, "uint32");
        pass.drawIndexed(c.indexCount);
      }
      culledCount += chunkCulled;
    } else {
      pass.setVertexBuffer(0, buf.vertexBuffer);
      if (buf.indexBuffer) {
        pass.setIndexBuffer(buf.indexBuffer, "uint32");
        pass.drawIndexed(buf.indexCount);
      } else {
        pass.draw(buf.vertexCount);
      }
    }
    if (!_SCENE_DIAG.draw) {
      _SCENE_DIAG.draw = true;
      console.log("[scene] first mesh draw: slot=" + i + " src=" + m.node.type + "#" + m.node.id +
                  " material=" + matType +
                  " verts=" + buf.vertexCount + (buf.indexCount ? " indices=" + buf.indexCount : ""));
    }
  }

  // Sprint 5.10 -- one-shot diagnostic on first frustum cull so the
  // user can confirm culling is working without needing a gizmo.
  if (culledCount > 0 && !_SCENE_DIAG.cull) {
    _SCENE_DIAG.cull = true;
    console.log("[scene] frustum culling active (" + culledCount +
                " mesh(es) culled this frame). Disable via Scene.cullEnable=0.");
  }

  // Sprint 7.5.4.c-sky -- background sky pass. Fills the
  // not-covered-by-mesh pixels with sample_env(rayDir) so the wired
  // environment becomes the actual visible sky behind the scene,
  // not just IBL ambient on surfaces. Only fires when an env is
  // wired (env != null); otherwise the Scene's clearR/G/B persists
  // as the background and existing patches don't shift visually.
  // Runs LAST in the render pass: meshes have already written
  // depth < 1 wherever they cover, so depth-test less-equal +
  // sky-vertex-z=1 paints only the uncovered pixels.
  if (env && inst.slots[0] && inst.slots[0].bindGroup) {
    const skyPipeline = _ensureSkyPipeline(sampleCount);
    if (skyPipeline) {
      pass.setPipeline(skyPipeline);
      // v0.3.120 -- same parity selection as the mesh draws above.
      const skyBg = (entry.readKey === "b") ? inst.slots[0].bindGroupB : inst.slots[0].bindGroupA;
      pass.setBindGroup(0, skyBg);
      pass.draw(3);
      if (!_SCENE_DIAG.sky) {
        _SCENE_DIAG.sky = true;
        console.log("[scene] first sky pass (env mode=" + env.mode + ")");
      }
    }
  }

  pass.end();
  return true;
}

/* Resolve a single light node's params into the unified Light
 * descriptor shape used by the per-Scene uniform writer. Returns
 * null if the node isn't a recognized light type. */
function _resolveLightNode(lightNode) {
  if (!lightNode) return null;
  const p = _resolveNodeParams(lightNode);
  if (lightNode.type === "DirectionalLight") {
    const dx = (typeof p.dirX === "number") ? p.dirX : 0.3;
    const dy = (typeof p.dirY === "number") ? p.dirY : 1.0;
    const dz = (typeof p.dirZ === "number") ? p.dirZ : 0.4;
    const len = Math.hypot(dx, dy, dz) || 1.0;
    return {
      type:  0,
      pos:   [dx / len, dy / len, dz / len],
      color: [
        (typeof p.colorR === "number") ? p.colorR : 1.0,
        (typeof p.colorG === "number") ? p.colorG : 1.0,
        (typeof p.colorB === "number") ? p.colorB : 1.0
      ],
      intensity: (typeof p.intensity === "number") ? p.intensity : 1.0,
      range:     0,
      cosInner:  1.0,
      cosOuter:  1.0,
      spotDir:   [0, -1, 0]
    };
  }
  if (lightNode.type === "PointLight") {
    return {
      type:  1,
      pos:   [
        (typeof p.posX === "number") ? p.posX : 0,
        (typeof p.posY === "number") ? p.posY : 2,
        (typeof p.posZ === "number") ? p.posZ : 2
      ],
      color: [
        (typeof p.colorR === "number") ? p.colorR : 1.0,
        (typeof p.colorG === "number") ? p.colorG : 1.0,
        (typeof p.colorB === "number") ? p.colorB : 1.0
      ],
      intensity: (typeof p.intensity === "number") ? p.intensity : 1.5,
      range:     (typeof p.range === "number") ? p.range : 8.0,
      cosInner:  1.0,
      cosOuter:  1.0,
      spotDir:   [0, -1, 0]
    };
  }
  if (lightNode.type === "SpotLight") {
    const inDeg  = (typeof p.innerAngle === "number") ? p.innerAngle : 15;
    const outDeg = (typeof p.outerAngle === "number") ? p.outerAngle : Math.max(20, inDeg + 5);
    return {
      type:  2,
      pos:   [
        (typeof p.posX === "number") ? p.posX : 0,
        (typeof p.posY === "number") ? p.posY : 3,
        (typeof p.posZ === "number") ? p.posZ : 0
      ],
      color: [
        (typeof p.colorR === "number") ? p.colorR : 1.0,
        (typeof p.colorG === "number") ? p.colorG : 1.0,
        (typeof p.colorB === "number") ? p.colorB : 0.95
      ],
      intensity: (typeof p.intensity === "number") ? p.intensity : 2.0,
      range:     (typeof p.range === "number") ? p.range : 12.0,
      // Pre-compute cos(half-angle) here so the WGSL doesn't have to.
      // Half-angles convert deg -> rad first.
      cosInner: Math.cos(inDeg  * Math.PI / 180.0),
      cosOuter: Math.cos(outDeg * Math.PI / 180.0),
      spotDir: [
        (typeof p.dirX === "number") ? p.dirX : 0,
        (typeof p.dirY === "number") ? p.dirY : -1,
        (typeof p.dirZ === "number") ? p.dirZ : 0
      ]
    };
  }
  if (lightNode.type === "Sun") {
    // 7.5.4.c-polish -- Sun emits SUNLIGHT by day, MOONLIGHT by
    // night. _sunColorFromElevation returns isNight=true when sun
    // is below horizon (cool-blue, low intensity); the moon is
    // opposite the sun, so we flip the direction so the light
    // comes FROM the moon's position. This way the scene never
    // goes pitch dark just because the sun set.
    const t = (typeof p.timeOfDay === "number") ? p.timeOfDay : 0.5;
    const sunDir = _sunDirFromTime(t);
    const sc = _sunColorFromElevation(sunDir[1]);
    const tint = {
      r: (typeof p.tintR === "number") ? p.tintR : 1.0,
      g: (typeof p.tintG === "number") ? p.tintG : 1.0,
      b: (typeof p.tintB === "number") ? p.tintB : 1.0
    };
    const lightDir = sc.isNight
      ? [-sunDir[0], -sunDir[1], -sunDir[2]]
      : sunDir;
    return {
      type:  0,
      pos:   lightDir,
      color: [sc.r * tint.r, sc.g * tint.g, sc.b * tint.b],
      intensity: sc.intensity * ((typeof p.intensityScale === "number") ? p.intensityScale : 1.0),
      range:    0,
      cosInner: 1.0,
      cosOuter: 1.0,
      spotDir:  [0, -1, 0]
    };
  }
  if (lightNode.type === "AreaLight") {
    // 7.5.6.h -- raster Scene has no shadow-ray equivalent, so we
    // degrade the area light to a single PointLight at the panel
    // center. Same color + intensity. Cos_light and 1/r^2 area-MC
    // weight aren't expressible here, but the visual result (a soft
    // fill from that direction) is close enough that swapping between
    // Scene and RayTracedScene doesn't black out.
    return {
      type:  1,  // point
      pos:   [
        (typeof p.posX === "number") ? p.posX : 0,
        (typeof p.posY === "number") ? p.posY : 3,
        (typeof p.posZ === "number") ? p.posZ : 0
      ],
      color: [
        (typeof p.colorR === "number") ? p.colorR : 1.0,
        (typeof p.colorG === "number") ? p.colorG : 0.97,
        (typeof p.colorB === "number") ? p.colorB : 0.92
      ],
      intensity: (typeof p.intensity === "number") ? p.intensity : 4.0,
      range:     20.0,
      cosInner:  1.0,
      cosOuter:  1.0,
      spotDir:   [0, -1, 0]
    };
  }
  return null;
}

/* Resolve all of a Scene's light* inputs (light1..light4). Returns
 * an array of light descriptors. Falls back to a single default
 * directional light when nothing is wired so meshes don't render
 * pitch-black. Per-frame cache via Visual._frameLightCache. */
/* Sprint 7.5.4.c -- shared math for sun direction + sun light
 * color. Used by Sun (the light node), ProceduralSky (the env
 * source), and DayNightCycle's diagnostic output. Keeping it here
 * means the Sun's DirectionalLight color matches the sun-disk
 * color rendered into the env exactly. timeOfDay convention:
 *   0.00 = midnight (sun straight down, well below horizon)
 *   0.25 = sunrise   (sun at the +X horizon)
 *   0.50 = noon      (sun overhead, slightly +Z tilt)
 *   0.75 = sunset    (sun at the -X horizon)
 * The +Z tilt is cosmetic -- a perfectly polar arc looks flat. */
function _sunDirFromTime(t) {
  const wrapped = ((t % 1) + 1) % 1;        // wrap to [0, 1)
  // On the spherical planet, world +Y is the NORTH POLE; the local up
  // at the equator (where the demo camera lands) is radial-outward,
  // NOT +Y. So the sun must arc in the EQUATORIAL plane (XZ), with
  // a small +Y tilt for axial-tilt cosmetics. The old XY-plane sweep
  // made the sun visibly traverse north-to-south because +Y is the
  // polar axis on a sphere.
  const planetMode = !!(typeof state !== "undefined"
    && state && Array.isArray(state.nodes)
    && state.nodes.some(n => n && (n.type === "Planet" || n.type === "PlanetMesh")));
  if (planetMode) {
    // t=0.5 (noon)    → +X    (up for the demo cam)
    // t=0.25 (sunrise)→ +Z    (east tangent)
    // t=0.75 (sunset) → -Z    (west tangent)
    // t=0 / t=1       → -X    (below horizon — night)
    const theta = (0.5 - wrapped) * Math.PI * 2;
    const sx = Math.cos(theta);
    const sz = Math.sin(theta);
    const sy = 0.30;                  // ~17° axial-tilt cosmetic
    const len = Math.hypot(sx, sy, sz) || 1.0;
    return [sx / len, sy / len, sz / len];
  }
  // Legacy flat-terrain mode kept verbatim: scene up = +Y, so a sun
  // arc in the XY plane gives the expected zenith pass.
  const theta = (wrapped - 0.25) * Math.PI * 2;
  const sx = Math.cos(theta);
  const sy = Math.sin(theta);
  const sz = 0.3;
  const len = Math.hypot(sx, sy, sz) || 1.0;
  return [sx / len, sy / len, sz / len];
}

/* Sprint 7.5.4.c -- celestial light: sun color + intensity from
 * elevation, with moonlight at night. elev is the Y of normalized
 * sunDir (= sin of altitude angle); +1 = zenith, 0 = horizon,
 * -1 = nadir.
 *
 * Above horizon (sun visible): color reddens at horizon (Beer-
 * Lambert through more atmosphere), intensity ramps with elevation.
 * Below horizon (sun set): emit MOONLIGHT instead -- soft cool-blue
 * from the opposite direction (caller flips dir). This way Sun.light
 * still illuminates the scene at night, just dimmer + cooler.
 *
 * MATCHES the sun-disk color the WGSL sample_procedural_sky_features
 * generates, so the Sun DirectionalLight visually agrees with the
 * disk that shows in the sky. */
function _sunColorFromElevation(elev) {
  if (elev <= 0) {
    // Night: moonlight. The caller (_resolveLightNode / _rtExtract-
    // Light for Sun) will INVERT the direction so the moonlight
    // comes from the moon's position (opposite the sun). Soft cool-
    // blue, ~5-8% of daylight intensity (real moonlight is ~0.1%,
    // but at that brightness PBR scenes go pitch dark; tuned up).
    const moonRamp = Math.min(1, -elev / 0.4);
    return {
      r: 0.55,
      g: 0.65,
      b: 0.95,
      intensity: 0.03 + 0.05 * moonRamp,
      visibility: 0,
      isNight: true
    };
  }
  // Day: sunlight. Sunset (low elev) -> warm red. Noon -> neutral.
  const s = Math.min(1, elev / 0.35);
  return {
    r: 1.0,
    g: 0.55 + 0.40 * s,
    b: 0.25 + 0.65 * s,
    intensity: 0.50 + 0.75 * s,
    visibility: Math.min(1, elev / 0.18),
    isNight: false
  };
}

/* Sprint 7.5.4 -- resolve the Scene's wired environment input.
 * Returns the descriptor the per-Scene uniform writer packs into
 * the env vec4s, or null when nothing is wired (= shader falls
 * back to hardcoded hemisphere-IBL). The structure mirrors what
 * sample_env() in WGSL expects:
 *   { mode, intensity, turbidity, mieG, sky, horizon, ground, sun }
 * sun = [x, y, z, visibility]; only used by mode 2 (ProceduralSky).
 * Future modes (Skybox, HDRI) will return higher mode numbers
 * + possibly resolved-texture handles. */
function _resolveSceneEnvironment(sceneNode) {
  const wire = state.edges && state.edges.find(e =>
    e && e.to && e.to.node === sceneNode.id && e.to.port === "environment"
  );
  if (!wire || !wire.from) return null;
  const src = state.nodes.find(n => n && n.id === wire.from.node);
  if (!src) return null;
  const p = _resolveNodeParams(src);
  const num = (v, d) => (typeof v === "number" ? v : d);
  if (src.type === "GradientSky") {
    return {
      mode: 1,
      intensity: num(p.intensity, 1.0),
      sky:     [num(p.skyR, 0.55),     num(p.skyG, 0.65),     num(p.skyB, 0.85)],
      horizon: [num(p.horizonR, 0.78), num(p.horizonG, 0.80), num(p.horizonB, 0.85)],
      ground:  [num(p.groundR, 0.18),  num(p.groundG, 0.16),  num(p.groundB, 0.14)]
    };
  }
  if (src.type === "ProceduralSky") {
    const t = num(p.timeOfDay, 0.5);
    const sunDir = _sunDirFromTime(t);
    const sunColor = _sunColorFromElevation(sunDir[1]);
    // 7.5.4.c-polish -- pack moonPhase into envSky.w (unused slot
    // when mode=2 since GradientSky's sky colors are ignored for
    // ProceduralSky). Shader reads uS.envSky.w as moon lit-fraction.
    // 7.5.4.d -- cloud params + wind offsets (= speed × elapsed s).
    const elapsed = (typeof performance !== "undefined")
      ? performance.now() * 0.001 : 0;
    const windX = num(p.windSpeedX, 0.0) * elapsed;
    const windZ = num(p.windSpeedZ, 0.0) * elapsed;
    return {
      mode: 2,
      intensity: num(p.intensity, 1.0),
      turbidity: num(p.turbidity, 1.0),
      mieG:      num(p.mieG, 0.76),
      sky: [0, 0, 0, Math.max(0, Math.min(1, num(p.moonPhase, 0.5)))],
      sun: [sunDir[0], sunDir[1], sunDir[2], sunColor.visibility],
      cloud: [
        Math.max(0, Math.min(1, num(p.cloudCoverage, 0.0))),
        Math.max(0, num(p.cloudDensity, 1.0)),
        windX,
        windZ
      ]
    };
  }
  if (src.type === "HDRI" || src.type === "Skybox") {
    // 7.5.4.b -- equirectangular HDR/LDR. The preset string maps
    // to a URL in assets/hdri/. Loading is async + cached; first
    // resolution kicks off the fetch and falls back to mode 0
    // (hardcoded hemisphere) until the texture is uploaded. Next
    // frame after upload picks up mode 3.
    // A.5 -- an explicit `url` (server:/asset:/http) wins over the
    // bundled preset. _resolveGLBUrl handles the server-asset scheme.
    let url = null;
    const rawUrl = (typeof p.url === "string") ? p.url.trim() : "";
    if (rawUrl) {
      url = (typeof _resolveGLBUrl === "function") ? _resolveGLBUrl(rawUrl) : (/^https?:/.test(rawUrl) ? rawUrl : null);
    } else {
      const preset = (typeof p.preset === "string") ? p.preset : "table-mountain";
      url = _hdriPresetUrl(preset);
    }
    if (!url) return null;
    const cached = Visual._hdriCache && Visual._hdriCache.get(url);
    if (cached && cached.__loaded) {
      // Make sure the global env texture matches this preset.
      _applyHdriToEnvTexture(cached.__data, url);
      return {
        mode: 3,
        intensity: num(p.intensity, 1.0)
      };
    }
    // Kick off the load (idempotent via the cache promise) and
    // mark loaded when it resolves.
    _loadHdri(url).then(data => {
      const promiseEntry = Visual._hdriCache.get(url);
      // Promote the cache entry from "promise" to "loaded data" so
      // the next resolve hits the fast path. Attach the data onto
      // the promise to survive any external consumers still
      // awaiting it.
      promiseEntry.__loaded = true;
      promiseEntry.__data = data;
    }).catch(e => {
      console.warn("[hdri] failed to load " + url + ":", e);
    });
    // Not yet ready -- render with hemisphere fallback. Next frame
    // (after the async load resolves) will switch to mode 3.
    return null;
  }
  return null;
}

/* Sprint 7.5.4.b -- map an HDRI preset name to a URL relative to
 * the editor's hosting origin. Edit here + the HDRI node's
 * paramOptions entries to add presets. */
function _hdriPresetUrl(presetName) {
  const map = {
    "table-mountain": "./assets/hdri/table_mountain_1_puresky_4k.hdr"
  };
  return map[presetName] || null;
}

function _resolveSceneLights(sceneNode) {
  if (!Visual._frameLightCache) Visual._frameLightCache = new Map();
  const lights = [];
  const portNames = ["light1", "light2", "light3", "light4"];
  for (const portName of portNames) {
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === sceneNode.id && e.to.port === portName
    );
    if (!wire || !wire.from) continue;
    let resolved = Visual._frameLightCache.get(wire.from.node);
    if (!resolved) {
      const src = state.nodes.find(n => n && n.id === wire.from.node);
      resolved = _resolveLightNode(src);
      if (resolved) Visual._frameLightCache.set(wire.from.node, resolved);
    }
    if (resolved) lights.push(resolved);
  }
  if (lights.length === 0) {
    // Default warm-white directional from above-front so PhongMat /
    // PBR scenes with no light wired don't go pitch-black.
    lights.push({
      type:  0,
      pos:   [0.3 / 1.118, 1.0 / 1.118, 0.4 / 1.118],
      color: [1.0, 0.98, 0.92],
      intensity: 1.0,
      range:     0,
      cosInner:  1.0,
      cosOuter:  1.0,
      spotDir:   [0, -1, 0]
    });
  }
  return lights;
}

