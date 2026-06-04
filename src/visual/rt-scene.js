/* =========================================================================
 * Sprint 7.5.6.a part 2d -- RayTracedScene encoder + WebSocket client
 *
 * Per-RayTracedScene-node state:
 *   { ws, status, width, height, texture, textureView, bindGroup,
 *     pendingFrame (Uint8Array | null), frameCount, lastFrameAt,
 *     error (string | null) }
 *
 * Lifecycle:
 *   1. First _ensureRtSceneInstance call allocates the state +
 *      opens a WebSocket to ${localServerEndpoint}/rt.
 *   2. On WS open, sends {hello} + {render-start} (with the
 *      compile-server probing the engine in the middle).
 *   3. Engine replies with frame-config message; editor allocates
 *      a GPUTexture at the matching dims + a bind group.
 *   4. Binary messages arrive at ~30 fps with raw RGBA8 pixel data;
 *      we stash the latest as `pendingFrame` (overwriting any older
 *      one -- we only ever display the freshest).
 *   5. _encodeRtScenePass on each render frame: if pendingFrame,
 *      queue.writeTexture into the GPUTexture; then blit the
 *      texture to the assigned framebuffer/scratch layer via a
 *      dedicated fullscreen-triangle pipeline.
 *
 * Cleanup happens in _disposeShaderInstance when a RayTracedScene
 * node is removed from the patch -- closes the WS + destroys the
 * texture. */

const _RT_BLIT_WGSL = `
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  return textureSampleLevel(srcTex, srcSampler, in.uv, 0.0);
}
`;

function _ensureRtBlitPipeline() {
  if (Visual._rtBlitPipeline) return Visual._rtBlitPipeline;
  if (!Visual.device) return null;
  Visual._rtBlitBgl = Visual.device.createBindGroupLayout({
    label: "rt-blit-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" } }
    ]
  });
  const layout = Visual.device.createPipelineLayout({
    label: "rt-blit-pl",
    bindGroupLayouts: [Visual._rtBlitBgl]
  });
  const module = Visual.device.createShaderModule({
    label: "rt-blit-shader",
    code: _RT_BLIT_WGSL
  });
  Visual._rtBlitPipeline = Visual.device.createRenderPipeline({
    label: "rt-blit-pipeline",
    layout,
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module, entryPoint: "fs_main",
      targets: [{ format: Visual.fbFormat }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" }
  });
  Visual._rtBlitSampler = Visual.device.createSampler({
    label: "rt-blit-sampler",
    magFilter: "linear", minFilter: "linear",
    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge"
  });
  console.log("[rt-scene] blit pipeline built");
  return Visual._rtBlitPipeline;
}

function _ensureRtSceneInstance(node) {
  if (!Visual.rtSceneInstances) Visual.rtSceneInstances = new Map();
  let inst = Visual.rtSceneInstances.get(node.id);
  if (inst) return inst;
  if (!Visual.device) return null;
  inst = {
    status: "idle",
    ws: null,
    width: 0, height: 0,
    texture: null, textureView: null, bindGroup: null,
    pendingFrame: null,
    frameCount: 0,
    lastFrameAt: 0,
    error: null,
    reconnectTimer: null,
    // Sprint 7.5.6.a part 2e-2 + 7.5.6.c-1 -- three-tier live
    // update tracking. Each render tick re-derives these from the
    // current graph state:
    //   * lastSceneSig       -- structural (mesh wiring + material
    //                           wiring + light wiring + mesh geometry
    //                           params). Change triggers full Scene
    //                           replace + AS rebuild on the engine.
    //   * lastMaterialsJson  -- packed materials array. Change ->
    //                           Params(materials); engine patches
    //                           material_buffer in place. Catches
    //                           live PhongMat / PhysicalMat slider
    //                           drags without churning the BVH.
    //   * lastLightsJson     -- packed lights array. Change ->
    //                           Params(lights); engine patches
    //                           lights_buffer in place.
    //   * lastCameraJson     -- packed camera. Change -> Params(camera);
    //                           engine patches camera_buffer.
    lastCameraJson: null,
    lastLightsJson: null,
    lastMaterialsJson: null,
    lastSceneSig: null,
    lastClearSig: null
  };
  Visual.rtSceneInstances.set(node.id, inst);
  _rtSceneConnect(node.id, inst);
  return inst;
}

/* Sprint 7.5.6.a part 2e-1 -- serialize the editor's RayTracedScene
 * node state into the JSON shape the engine's `scene` IPC message
 * expects (mirrors scene.rs in the gamma-compile-server repo).
 *
 * Option (a) materials: per-mesh flat RGB color, derived as the
 * average of the upstream mesh's per-vertex colors. No PBR fields,
 * no lights, no environment. Transforms identity for 2e-1 -- wire-
 * based Translate/Rotate/Scale composition lands in 2e-2.
 *
 * Returns a Scene-shaped object ready for JSON.stringify. Always
 * succeeds (returns an empty meshes[] if nothing wired). */
function _rtBuildSceneJson(rtNode) {
  const meshes = [];
  // Walk mesh1..mesh4 inputs; collect each mesh node plus any
  // material node wired between mesh and RayTracedScene (so a chain
  // like Sphere → PhysicalMat → RT.mesh1 sends PBR params to the
  // engine instead of an Unlit fallback).
  for (let i = 1; i <= 4; i++) {
    const portName = "mesh" + i;
    const found = _rtFindUpstreamMeshAndMaterial(rtNode.id, portName);
    if (!found) continue;
    const { mesh: meshNode, material: matNode, transform } = found;
    const data = _buildMeshData(meshNode);
    if (!data) continue;
    const stride = 11;
    const verts = Array.from(data.verts);
    const indices = data.indices ? Array.from(data.indices) : null;
    // Material wiring + fallback (c-2): real material params if a
    // material node is in the chain, else Phong with the mesh's
    // average per-vertex color so unmaterialed meshes stay shaded.
    let material = matNode ? _rtExtractMaterial(matNode) : null;
    if (!material) {
      material = {
        type: "phong",
        color: _rtMeshAverageColor(data.verts, stride),
        shininess: 32,
        ambient: 0.15
      };
    }
    meshes.push({
      geometry: {
        kind: "inline",
        vertices: verts,
        indices: indices,
        stride: stride
      },
      // Sprint 7.5.6.a part 2e-2 -- composed Translate/Rotate/Scale
      // matrix from the wire chain. Engine applies this CPU-side
      // to vertex positions during AS build (and to normals via
      // the upper-3×3 path, sufficient for rotation/uniform-scale).
      transform: Array.from(transform),
      material
    });
  }

  // Camera input -- if a Camera node is wired, pull its pose. Else
  // default to the same eye/target as the engine's --render-test path.
  const camNode = _rtFindUpstreamByPort(rtNode.id, "camera");
  const camera = camNode ? _rtExtractCamera(camNode) : {
    mode: "perspective",
    pos: [0, 0, 2],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fov_deg: 60,
    near: 0.1,
    far: 100
  };

  // Sprint 7.5.6.c-1: light1..light4 inputs. Walk each, pack into
  // the scene's lights[] array if the upstream node is a light type
  // we recognize. Engine ignores types it can't render in c-1
  // (point / spot / area). Empty lights array → engine synthesizes
  // a default sunlit angle so shaded materials still look right.
  const lights = [];
  for (let i = 1; i <= 4; i++) {
    const ln = _rtFindUpstreamByPort(rtNode.id, "light" + i);
    if (!ln) continue;
    const packed = _rtExtractLight(ln);
    if (packed) lights.push(packed);
  }

  const p = rtNode.params || {};
  const num = (v, d) => (typeof v === "number" ? v : d);
  return {
    camera,
    meshes,
    lights,
    clear_color: [num(p.clearR, 0.05), num(p.clearG, 0.06), num(p.clearB, 0.10)]
  };
}

/* Sprint 7.5.6.c-1 -- pack one light node into the wire format the
 * engine's scene.rs Light enum expects. Returns null for unknown
 * node types (caller skips them). c-1 only renders Directional;
 * Point / Spot / Area get parsed into the JSON but the engine
 * silently skips them. c-2 wires up real point/spot evaluation. */
function _rtExtractLight(lightNode) {
  const p = _resolveNodeParams(lightNode);
  const num = (v, d) => (typeof v === "number" ? v : d);
  switch (lightNode.type) {
    case "DirectionalLight":
      // Editor's DirectionalLight registry: dirX/Y/Z is direction TO
      // the light (NOT direction the light shines). Defaults match
      // the registry params block so an un-touched DirectionalLight
      // gives the same lighting as the engine's no-light default.
      return {
        type: "directional",
        direction: [num(p.dirX, 0.3), num(p.dirY, 1.0), num(p.dirZ, 0.4)],
        color:     [num(p.colorR, 1.0), num(p.colorG, 0.98), num(p.colorB, 0.92)],
        intensity: num(p.intensity, 1.0)
      };
    case "PointLight":
      return {
        type: "point",
        position:  [num(p.posX, 0), num(p.posY, 2), num(p.posZ, 2)],
        color:     [num(p.colorR, 1.0), num(p.colorG, 0.95), num(p.colorB, 0.85)],
        intensity: num(p.intensity, 1.5),
        range:     num(p.range, 8.0)
      };
    case "SpotLight":
      return {
        type: "spot",
        position:  [num(p.posX, 0), num(p.posY, 3), num(p.posZ, 0)],
        direction: [num(p.dirX, 0), num(p.dirY, -1), num(p.dirZ, 0)],
        color:     [num(p.colorR, 1.0), num(p.colorG, 0.95), num(p.colorB, 0.85)],
        intensity: num(p.intensity, 2.0),
        range:     num(p.range, 8.0),
        inner_angle_deg: num(p.innerAngle, 15),
        outer_angle_deg: num(p.outerAngle, 25)
      };
    case "AreaLight":
      // 7.5.6.h -- rectangular emitter, RT-only. Engine kernel
      // samples one point on the rect per shadow ray; TDS averages
      // across primaries -> real soft shadows.
      return {
        type: "area",
        position:  [num(p.posX, 0), num(p.posY, 3), num(p.posZ, 0)],
        normal:    [num(p.dirX, 0), num(p.dirY, -1), num(p.dirZ, 0)],
        width:     num(p.width, 2.0),
        height:    num(p.height, 2.0),
        color:     [num(p.colorR, 1.0), num(p.colorG, 0.97), num(p.colorB, 0.92)],
        intensity: num(p.intensity, 4.0)
      };
    case "Sun": {
      // 7.5.4.c-polish -- emits sunlight by day, moonlight by night
      // (with direction flipped to come FROM the moon's position so
      // the scene gets cool-blue fill at night). Engine receives it
      // as a regular Light::Directional regardless of which mode.
      const t = num(p.timeOfDay, 0.5);
      const sunDir = _sunDirFromTime(t);
      const sc = _sunColorFromElevation(sunDir[1]);
      const tintR = num(p.tintR, 1.0);
      const tintG = num(p.tintG, 1.0);
      const tintB = num(p.tintB, 1.0);
      const scale = num(p.intensityScale, 1.0);
      const lightDir = sc.isNight
        ? [-sunDir[0], -sunDir[1], -sunDir[2]]
        : sunDir;
      return {
        type: "directional",
        direction: lightDir,
        color:     [sc.r * tintR, sc.g * tintG, sc.b * tintB],
        intensity: sc.intensity * scale
      };
    }
    default:
      return null;
  }
}

/* Sprint 7.5.6.a part 2e-2 -- walk the wire chain from RT.meshN
 * back to a mesh-gen node, accumulating Translate/Rotate/Scale
 * matrices AND capturing the first material in the chain. Returns
 *   { mesh, material, transform }   (transform is Float32Array[16])
 * or null if the chain doesn't resolve to a mesh-gen node.
 *
 * Chain semantics (same as the raster Scene's _walkMeshChain):
 *   leaf-gen → T_inner → T_middle → T_outer → RT
 * yields transform = T_outer · T_middle · T_inner, so inner-most
 * transforms hit vertices first. e.g.
 *   Sphere → Rotate(45y) → Translate(2,0,0) → RT
 * rotates the sphere around its own origin, THEN translates it out.
 * Reverse for "swing around the world origin":
 *   Sphere → Translate(2,0,0) → Rotate(45y) → RT
 *
 * Material: the FIRST material encountered going RT → leaf wins
 * (outermost wrapper). Same convention as the raster path. */
function _rtFindUpstreamMeshAndMaterial(rtNodeId, portName) {
  const edge = state.edges && state.edges.find(e =>
    e && e.to && e.to.node === rtNodeId && e.to.port === portName
  );
  if (!edge || !edge.from) return null;
  return _rtWalkChainUpstream(edge.from.node, _mat4Identity(), null, 0);
}

function _rtWalkChainUpstream(nodeId, accMat, accMaterial, depth) {
  if (depth > 16) return null;            // cycle guard
  const node = state.nodes.find(n => n && n.id === nodeId);
  if (!node) return null;
  const def = TYPES[node.type];
  if (!def) return null;
  if (def.kind === "mesh-gen") {
    return { mesh: node, material: accMaterial, transform: accMat };
  }
  if (def.kind === "mesh-transform") {
    const local = _buildTransformMatrix(node);
    // accMat is the RT-side accumulator; multiply local in on the
    // RIGHT so leaf-side transforms end up rightmost in the product
    // (= applied first to vertices). Matches raster _walkMeshChain.
    const next = new Float32Array(16);
    _mat4Multiply(next, accMat, local);
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "mesh"
    );
    if (!wire || !wire.from) return null;
    return _rtWalkChainUpstream(wire.from.node, next, accMaterial, depth + 1);
  }
  if (def.kind === "material") {
    // First material wins -- outermost wrapper (closest to RT).
    const myMaterial = accMaterial || node;
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "mesh"
    );
    if (!wire || !wire.from) return null;
    return _rtWalkChainUpstream(wire.from.node, accMat, myMaterial, depth + 1);
  }
  return null;
}

// Legacy wrapper -- a few call sites only need the mesh.
function _rtFindUpstreamMesh(rtNodeId, portName) {
  const r = _rtFindUpstreamMeshAndMaterial(rtNodeId, portName);
  return r ? r.mesh : null;
}

/* Sprint 7.5.6.c-2 -- pack a material node into the scene.rs
 * Material enum's JSON shape. The engine's c-2 kernel honors
 * Unlit / Phong / Pbr; ShaderMat collapses to Unlit for now
 * (matching the engine's material_to_uniform fallback). */
function _rtExtractMaterial(matNode) {
  const p = _resolveNodeParams(matNode);
  const num = (v, d) => (typeof v === "number" ? v : d);
  switch (matNode.type) {
    case "UnlitMat":
      return {
        type: "unlit",
        color: [num(p.r, 1), num(p.g, 1), num(p.b, 1)],
        vertex_mix: num(p.vertexMix, 0)
      };
    case "PhongMat":
      return {
        type: "phong",
        color: [num(p.r, 0.85), num(p.g, 0.85), num(p.b, 0.92)],
        shininess: num(p.shininess, 32),
        ambient: num(p.ambient, 0.15)
      };
    case "PhysicalMat":
      return {
        type: "pbr",
        color: [num(p.r, 0.85), num(p.g, 0.85), num(p.b, 0.85)],
        metallic: num(p.metallic, 0),
        roughness: num(p.roughness, 0.5)
      };
    case "MirrorMat":
      // scene.rs Material::Mirror uses .tint instead of .color.
      return {
        type: "mirror",
        tint: [num(p.r, 1), num(p.g, 1), num(p.b, 1)]
      };
    case "GlassMat":
      // scene.rs Material::Glass: color (= absorption tint), ior,
      // optional absorption (here we use color directly; absorption
      // could be a separate per-component density param in c-d.2).
      return {
        type: "glass",
        color: [num(p.r, 0.95), num(p.g, 0.97), num(p.b, 1.0)],
        ior: num(p.ior, 1.5),
        absorption: [0.0, 0.0, 0.0]
      };
    case "ShaderMat":
      // c-2 fallback: Slang transpile not implemented yet, so a
      // ShaderMat-wrapped mesh just renders as Unlit with whatever
      // tint params the user set.
      return {
        type: "unlit",
        color: [num(p.r, 1), num(p.g, 1), num(p.b, 1)],
        vertex_mix: 0
      };
    default:
      return null;
  }
}

/* Find a node wired into rtNode.portName regardless of type. Used
 * for the camera input. */
function _rtFindUpstreamByPort(rtNodeId, portName) {
  const edge = state.edges.find(e => e.to.node === rtNodeId && e.to.port === portName);
  if (!edge) return null;
  return state.nodes.find(n => n.id === edge.from.node) || null;
}

function _rtMeshAverageColor(verts, stride) {
  const n = verts.length / stride;
  if (n === 0) return [1, 1, 1];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) {
    r += verts[i * stride + 3];
    g += verts[i * stride + 4];
    b += verts[i * stride + 5];
  }
  return [r / n, g / n, b / n];
}

function _rtExtractCamera(camNode) {
  // Sprint 7.5.6.a part 2h -- read wired-param-resolved values, not
  // static .params. Without this, a `MasterClock → ... → Camera.posX`
  // orbit chain wouldn't update the engine (we'd see the static
  // posX=0 every frame). _resolveNodeParams is the same resolver
  // the raster Scene's _evaluateCamera uses; single source of truth.
  const p = _resolveNodeParams(camNode);
  const num = (v, d) => (typeof v === "number" ? v : d);
  return {
    mode: "perspective",
    pos: [num(p.posX, 0), num(p.posY, 0), num(p.posZ, 5)],
    target: [num(p.targetX, 0), num(p.targetY, 0), num(p.targetZ, 0)],
    up: [num(p.upX, 0), num(p.upY, 1), num(p.upZ, 0)],
    fov_deg: num(p.fov, 60),
    near: num(p.near, 0.1),
    far: num(p.far, 100)
  };
}

const _RT_DEFAULT_CAMERA = Object.freeze({
  mode: "perspective",
  pos: [0, 0, 2],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fov_deg: 60,
  near: 0.1,
  far: 100
});

// 7.5.6.h-warmup -- when the engine resets TDS history (preset
// change, scale change, reconnect) the first ~30 frames are
// intrinsically less converged than steady-state. Holding the
// previous frame for this many incoming frames hides the visual
// "noise pop" without complicating the engine. ~1s at 30fps;
// long enough for TDS to populate temporal history, short enough
// that camera/scene drift over the hold isn't visible.
const _RT_WARMUP_FRAMES = 30;

/* Sprint 7.5.6.a part 2e-2 -- structural signature for the scene.
 * Stringifies the things that, if changed, require a full Scene
 * replace + AS rebuild on the engine side: which mesh-builder node
 * is wired to each port, its geometry-affecting params (radius,
 * slices, etc -- already captured by _meshCacheKey from the raster
 * path), and which camera node is wired. Cheap to compute (one wire
 * walk per port) so per-frame polling is fine. */
function _rtComputeSceneSignature(rtNode) {
  const parts = [];
  for (let i = 1; i <= 4; i++) {
    const portName = "mesh" + i;
    const found = _rtFindUpstreamMeshAndMaterial(rtNode.id, portName);
    if (!found) {
      parts.push("-");
      continue;
    }
    const { mesh: meshNode, transform } = found;
    // Hash the transform values too -- 2e-2 transforms are baked
    // into vertex positions on the engine side, so a Translate
    // slider drag DOES need a full Scene replace + AS rebuild.
    // Rounded to 4 decimals to keep the sig string short and to
    // throttle ultra-fine slider jitter at sub-pixel scales.
    const tHash = Array.from(transform).map(v => v.toFixed(4)).join(",");
    parts.push(meshNode.id + ":" + meshNode.type +
               ":" + _meshCacheKey(meshNode) +
               ":t=" + tHash);
  }
  // Light wiring (not light params -- those flow through the
  // tier-3 Params(lights) path for cheap live updates).
  for (let i = 1; i <= 4; i++) {
    const ln = _rtFindUpstreamByPort(rtNode.id, "light" + i);
    parts.push(ln ? "l" + i + ":" + ln.id + ":" + ln.type : "l" + i + ":-");
  }
  return parts.join("|");
}

/* Sprint 7.5.6.a part 2e-2 -- per-frame poll. Called from
 * _encodeRtScenePass on every render tick the RayTracedScene is
 * actually visible. Compares the camera + scene signature against
 * what we last shipped and sends the minimal patch (Params for
 * camera-only, full Scene for structural changes). No-op when the
 * WS isn't open. */
function _rtScenePollAndSend(node, inst) {
  if (!inst.ws || inst.ws.readyState !== 1) return;

  const p = node.params || {};
  const num = (v, d) => (typeof v === "number" ? v : d);

  // Tier 0 -- displaySize / renderScale changes (f.3.g). These can't
  // be patched live; the engine has to allocate new textures + a new
  // TDS scaler at the right input/output dims. Cleanest path is to
  // close the current WS so the next render tick reconnects + ships
  // a fresh `configure` with the new values. `inst.lastConfigKey` is
  // primed in _rtSceneConnect's onopen handler after the configure
  // send, so the first poll never trips this branch.
  const dsNow = String(p.displaySize != null ? p.displaySize : "720p");
  const rsNow = String(p.renderScale != null ? p.renderScale : "native");
  const cfgKey = dsNow + "|" + rsNow;
  if (inst.lastConfigKey != null && inst.lastConfigKey !== cfgKey) {
    console.log("[rt-scene] config change " + inst.lastConfigKey +
                " -> " + cfgKey + "; reconnecting");
    try { inst.ws.close(); } catch (_) {}
    inst.lastConfigKey = cfgKey;
    return;
  }

  const clearSig = num(p.clearR, 0.05) + "," + num(p.clearG, 0.06) + "," + num(p.clearB, 0.10);

  const sceneSig = _rtComputeSceneSignature(node) + "|clr=" + clearSig;
  if (sceneSig !== inst.lastSceneSig) {
    // Structural change -- rebuild scene fully. This also resends the
    // camera + lights (they're part of the Scene payload), so prime
    // the tier-2 / tier-3 hashes to match so we don't immediately
    // re-send a redundant Params next frame.
    const sceneJson = _rtBuildSceneJson(node);
    const camJson = JSON.stringify(sceneJson.camera);
    const lightsJson = JSON.stringify(sceneJson.lights);
    const matsJson = JSON.stringify(sceneJson.meshes.map(m => m.material));
    try {
      inst.ws.send(JSON.stringify({ type: "scene", patch: sceneJson }));
      inst.lastSceneSig = sceneSig;
      inst.lastCameraJson = camJson;
      inst.lastLightsJson = lightsJson;
      inst.lastMaterialsJson = matsJson;
      console.log("[rt-scene] scene replace (sig change) — " +
                  sceneJson.meshes.length + " mesh(es), " +
                  sceneJson.lights.length + " light(s)");
    } catch (e) {
      console.warn("[rt-scene] scene send failed:", e);
    }
    return;
  }

  // Tier 2 -- materials. Same wiring, possibly drifted params
  // (PhongMat.shininess drag, PhysicalMat.metallic drag, etc).
  // Engine's update_materials patches the per-mesh material buffer
  // in place; no AS rebuild.
  const matsArr = [];
  for (let i = 1; i <= 4; i++) {
    const portName = "mesh" + i;
    const found = _rtFindUpstreamMeshAndMaterial(node.id, portName);
    if (!found) continue;
    const { mesh: meshNode, material: matNode } = found;
    const data = _buildMeshData(meshNode);
    if (!data) continue;
    let m = matNode ? _rtExtractMaterial(matNode) : null;
    if (!m) {
      // Matches the _rtBuildSceneJson default -- Phong with average
      // per-vertex color so unmaterialed meshes stay shaded.
      m = {
        type: "phong",
        color: _rtMeshAverageColor(data.verts, 11),
        shininess: 32,
        ambient: 0.15
      };
    }
    matsArr.push(m);
  }
  const matsJson = JSON.stringify(matsArr);
  if (matsJson !== inst.lastMaterialsJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { materials: matsArr } }));
      inst.lastMaterialsJson = matsJson;
    } catch (e) {
      console.warn("[rt-scene] materials params send failed:", e);
    }
  }

  // Tier 3 -- lights. Same wiring as last send, but the light
  // node's params may have moved (slider drag on intensity/hue).
  // Catches that without rebuilding the AS.
  const lightsArr = [];
  for (let i = 1; i <= 4; i++) {
    const ln = _rtFindUpstreamByPort(node.id, "light" + i);
    if (!ln) continue;
    const packed = _rtExtractLight(ln);
    if (packed) lightsArr.push(packed);
  }
  const lightsJson = JSON.stringify(lightsArr);
  if (lightsJson !== inst.lastLightsJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { lights: lightsArr } }));
      inst.lastLightsJson = lightsJson;
    } catch (e) {
      console.warn("[rt-scene] lights params send failed:", e);
    }
  }

  // Tier 4 -- camera. Cheap stringify-compare on the camera node's
  // resolved params. Fires on every slider drag / clock-driven orbit
  // tick that moves the camera.
  const camNode = _rtFindUpstreamByPort(node.id, "camera");
  const camObj = camNode ? _rtExtractCamera(camNode) : _RT_DEFAULT_CAMERA;
  const camJson = JSON.stringify(camObj);
  if (camJson !== inst.lastCameraJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { camera: camObj } }));
      inst.lastCameraJson = camJson;
    } catch (e) {
      console.warn("[rt-scene] camera params send failed:", e);
    }
  }

  // Tier 5 -- quality. Sprint 7.5.6.f.3.d. The `quality` preset is
  // the user's primary noise/detail dial; presets match the spec
  // in docs/RAYTRACING.md §5.6.g:
  //   draft    1 spp, 2 bounces   (cheapest, intentionally grainy)
  //   preview  4 spp, 4 bounces   (denoised, "looks ok in motion")
  //   final   16 spp, 8 bounces   (multi-bounce, denoised, render-grade)
  // Extra spp at higher presets targets edge / disocclusion noise
  // that MetalFX TDS history validation can't clear on its own (see
  // docs/RAYTRACING.md §5.6.f for the TDS aux-texture requirements).
  //
  // `samples` / `bounces` params act as explicit overrides: 0 = follow
  // preset, non-zero = pin. spp clamped to [1, 16], bounces to [1, 8].
  // Changing either resets path-tracing accumulation engine-side.
  const QUALITY_PRESETS = [
    { spp:  1, bounces: 2 }, // 0 draft
    { spp:  4, bounces: 4 }, // 1 preview (default)
    { spp: 16, bounces: 8 }, // 2 final
  ];
  // f.3.d-fix7 -- accept `quality` as either a string ("draft" /
  // "preview" / "final") or a number (0 / 1 / 2). The registry's
  // paramOptions dropdown writes the STRING form on user change
  // (matches every other paramOptions node in the codebase); loaded
  // .gpatch files + demo initializers may use the numeric form.
  // Both must resolve to the same preset index, or toggling the
  // dropdown silently no-ops (which is exactly what fix6 shipped --
  // num(string, 1) falls back to 1, preview pinned forever).
  const QUALITY_KEYS = ["draft", "preview", "final"];
  let qIdx;
  if (typeof p.quality === "string") {
    qIdx = QUALITY_KEYS.indexOf(p.quality);
    if (qIdx < 0) qIdx = 1; // unknown string -> preview
  } else {
    qIdx = Math.max(0, Math.min(2, Math.round(num(p.quality, 1))));
  }
  const preset = QUALITY_PRESETS[qIdx];
  const sppOverride = Math.round(num(p.samples, 0));
  const bouncesOverride = Math.round(num(p.bounces, 0));
  const qSpp = Math.max(1, Math.min(16, sppOverride || preset.spp));
  const qBounces = Math.max(1, Math.min(8, bouncesOverride || preset.bounces));
  const qObj = { spp: qSpp, bounces: qBounces };
  const qJson = JSON.stringify(qObj);
  if (qJson !== inst.lastQualityJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { quality: qObj } }));
      // 7.5.6.h-warmup -- a real preset/spp/bounces change resets
      // accumulation engine-side (set_spp / set_bounces both call
      // reset_accumulation, plus TDS gets set_reset on frame_count
      // == 0). Hide the warmup pop by holding the previous frame
      // until TDS history rebuilds. Only fires when there's a
      // PREVIOUS quality value (lastQualityJson != null), so the
      // very first send after connect doesn't trigger this.
      if (inst.lastQualityJson !== null && inst.heldFrame) {
        inst.warmupFramesRemaining = _RT_WARMUP_FRAMES;
      }
      inst.lastQualityJson = qJson;
    } catch (e) {
      console.warn("[rt-scene] quality params send failed:", e);
    }
  }

  // Tier 6 -- environment (5.4-rt). Mirror the raster Scene's env
  // uniform (8 vec4s: mode/intensity/turbidity/mieG + sky/horizon/
  // ground + sun + cloud/fog) to the engine so RayTracedScene shows
  // ProceduralSky / GradientSky / clouds / fog identical to what the
  // raster Scene does. Engine kernel reads these from PathState
  // and dispatches sample_env_smooth/full + apply_fog accordingly.
  // HDRI (mode 3) intentionally not supported in this first pass --
  // engine doesn't yet have an env texture binding.
  // Also pulls Scene fog params (fogDensity etc.) since fog lives
  // on the Scene node, not the env source.
  const envRT = _rtBuildEnvWire(node);
  const envJson = JSON.stringify(envRT);
  if (envJson !== inst.lastEnvJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { env: envRT } }));
      inst.lastEnvJson = envJson;
    } catch (e) {
      console.warn("[rt-scene] env params send failed:", e);
    }
  }
}

/* Sprint 5.4-rt -- build the 8-vec4 wire env payload from the
 * RayTracedScene node's wired environment + Scene-level fog params.
 * Engine's set_env() reads these by key (params/sky/horizon/ground/
 * sun/cloudParams/fogParams/fogColor). Missing keys keep the engine
 * defaults (mode 0 = hemisphere fallback). */
function _rtBuildEnvWire(rtNode) {
  // Find the wired environment source via the RayTracedScene's
  // `environment` input port. Resolve into the same descriptor
  // shape the raster Scene uses, so the same math lands engine-side.
  const sceneLike = { id: rtNode.id };
  // Reuse the raster Scene's env resolver. It looks at
  // state.edges where to.node = rtNode.id + to.port = "environment".
  // RayTracedScene has the same port name + type, so this works.
  const env = _resolveSceneEnvironment(rtNode);
  // Pull RayTracedScene's own fog params (Scene + RayTracedScene
  // both expose fogDensity/Start/Height/Auto + fogR/G/B as params).
  const p = _resolveNodeParams(rtNode);
  const num = (v, d) => (typeof v === "number" ? v : d);

  if (!env) {
    return {
      params:      [0, 1, 1, 0.76],
      sky:         [0, 0, 0, 0],
      horizon:     [0, 0, 0, 0],
      ground:      [0, 0, 0, 0],
      sun:         [0, 1, 0, 0],
      cloudParams: [0, 0, 0, 0],
      fogParams:   [num(p.fogDensity, 0), num(p.fogStart, 5),
                    num(p.fogHeight, 0),  num(p.fogAuto, 1)],
      fogColor:    [num(p.fogR, 0.65), num(p.fogG, 0.70), num(p.fogB, 0.78), 0]
    };
  }
  const sky     = env.sky     || [0, 0, 0, 0];
  const horizon = env.horizon || [0, 0, 0, 0];
  const ground  = env.ground  || [0, 0, 0, 0];
  const sun     = env.sun     || [0, 1, 0, 0];
  const cloud   = env.cloud   || [0, 0, 0, 0];
  return {
    params: [
      (typeof env.mode === "number") ? env.mode : 0,
      (typeof env.intensity === "number") ? env.intensity : 1,
      (typeof env.turbidity === "number") ? env.turbidity : 1,
      (typeof env.mieG === "number") ? env.mieG : 0.76
    ],
    sky:     [sky[0]||0, sky[1]||0, sky[2]||0, sky[3]||0],
    horizon: [horizon[0]||0, horizon[1]||0, horizon[2]||0, horizon[3]||0],
    ground:  [ground[0]||0, ground[1]||0, ground[2]||0, ground[3]||0],
    sun:     [sun[0]||0, sun[1]||0, sun[2]||0, sun[3]||0],
    cloudParams: [cloud[0]||0, cloud[1]||0, cloud[2]||0, cloud[3]||0],
    fogParams:   [num(p.fogDensity, 0), num(p.fogStart, 5),
                  num(p.fogHeight, 0),  num(p.fogAuto, 1)],
    fogColor:    [num(p.fogR, 0.65), num(p.fogG, 0.70), num(p.fogB, 0.78), 0]
  };
}

async function _rtSceneConnect(nodeId, inst) {
  if (inst.ws && inst.ws.readyState <= 1) return;
  inst.status = "connecting";
  await probeLocalServer();
  if (!localServerEndpoint) {
    inst.status = "no-server";
    inst.error = "compile-server not detected; start gamma-compile-server locally";
    console.warn("[rt-scene] no compile-server at first probe -- will retry on next render");
    return;
  }
  // Sprint 7.5.6.a part 2d-direct: bypass the /rt proxy on the
  // compile-server and connect straight to the engine. After four
  // proxy iterations Chrome reproducibly closes the browser-side
  // socket 1-2ms after onopen with "Invalid frame header" -- the
  // exact same symptom appeared with ws.WebSocketServer-based
  // proxy AND raw TCP forward AND manual split-handshake. Meanwhile
  // direct connections to ws://127.0.0.1:9100/ work end-to-end (
  // verified via scripts/test-engine-ws.mjs in the compile-server
  // repo).
  //
  // Chrome's mixed-content policy explicitly allows ws:// to
  // loopback addresses from https origins (the same exception that
  // makes localhost dev viable from gh-pages). So we read the
  // engine port from /health (already cached in _rtEngineState)
  // and connect there directly. The compile-server proxy is left
  // in place for a future production path where the engine isn't
  // on the same machine -- can be re-enabled by setting
  // localStorage["gamma-rt-via-proxy"] = "1".
  const engineInfo = _rtEngineState && _rtEngineState.serverInfo;
  const enginePort = engineInfo && engineInfo.enginePort;
  const useProxy = (typeof localStorage !== "undefined") &&
                   localStorage.getItem("gamma-rt-via-proxy") === "1";
  let wsUrl;
  if (!useProxy && enginePort) {
    wsUrl = "ws://127.0.0.1:" + enginePort + "/";
  } else {
    wsUrl = localServerEndpoint.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/rt";
  }
  console.log("[rt-scene] connecting to " + wsUrl + " (useProxy=" + useProxy + ")");
  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch (e) {
    inst.status = "error";
    inst.error = "WebSocket ctor: " + e.message;
    return;
  }
  ws.binaryType = "arraybuffer";
  inst.ws = ws;
  ws.onopen = () => {
    inst.status = "connected";
    inst.error = null;
    console.log("[rt-scene] connected for node " + nodeId);
    // Reset send-tracking so the next poll fires a fresh scene
    // (the lastSceneSig=null branch ships scene + camera + lights
    // + materials in one Scene message and primes all four trackers).
    inst.lastSceneSig = null;
    inst.lastCameraJson = null;
    inst.lastLightsJson = null;
    inst.lastMaterialsJson = null;
    inst.lastQualityJson = null;
    inst.lastEnvJson = null;
    try {
      ws.send(JSON.stringify({ type: "hello" }));

      // f.3.f-prep -- read display dims + render scale from the
      // RayTracedScene node's params so the engine allocates at the
      // requested output resolution. renderScale is the fraction of
      // displaySize the kernel will shade (next-sprint TDS upscale
      // path); the engine logs it but doesn't honor it yet. Applies
      // at WS-connect time only -- live re-configure on param
      // change lands with the upscale wiring.
      const node = state.nodes.find(n => n.id === nodeId);
      const DISPLAY_SIZES = {
        "480p":  [854,  480],
        "600p":  [800,  600],
        "720p":  [1280, 720],
        "900p":  [1600, 900],
        "1080p": [1920, 1080]
      };
      const RENDER_SCALES = {
        "native":      1.0,
        "quality":     0.75,
        "balanced":    0.66,
        "performance": 0.5,
        // f.3.g-fix1 -- Apple's MetalFX TDS caps the upscale ratio
        // at 3x per axis. 0.33 (= 3.03x) put TDS just over the limit,
        // causing it to refuse the descriptor; the engine then fell
        // back to the spatial denoiser (visibly noisier; plus a pre-
        // fix1 rebuild-loop dropped scene state -> black screen).
        // 0.35 = ~2.86x stays safely inside the cap at every
        // displaySize the dropdown offers.
        "ultra":       0.35
      };
      const ds = (node && node.params && node.params.displaySize) || "720p";
      const rs = (node && node.params && node.params.renderScale) || "native";
      const [dispW, dispH] = DISPLAY_SIZES[ds] || DISPLAY_SIZES["720p"];
      const rsFloat = RENDER_SCALES[rs] != null ? RENDER_SCALES[rs] : 1.0;
      ws.send(JSON.stringify({
        type: "configure",
        width: dispW,
        height: dispH,
        renderScale: rsFloat
      }));
      console.log("[rt-scene] configure: " + ds + " (" + dispW + "x" + dispH +
                  ")  renderScale=" + rs + " (" + rsFloat + ")");
      // f.3.g -- prime the Tier-0 reconnect-on-change tracker.
      // Subsequent polls compare current ds/rs against this key and
      // close the WS when it drifts (triggers reconnect with the new
      // configure values).
      inst.lastConfigKey = ds + "|" + rs;

      // 7.5.6.h-warmup -- if we had a previous session whose last
      // frame is still in memory, hide TDS warmup by displaying the
      // held frame for the first WARMUP_FRAMES we receive on this
      // new connection. _rtSceneAllocateTexture clears heldFrame
      // when dims change, so a displaySize change correctly falls
      // through to "no held -> show new frames immediately."
      if (inst.heldFrame) {
        inst.warmupFramesRemaining = _RT_WARMUP_FRAMES;
        console.log("[rt-scene] warmup-hide: holding previous frame for " +
                    _RT_WARMUP_FRAMES + " frames after reconnect");
      }

      // Sprint 7.5.6.a part 2e-2: route the initial scene send
      // through the poll function so the diff-tracking state stays
      // consistent. Sends a Scene message (the lastSceneSig=null
      // forces the "structural change" branch).
      if (node) {
        _rtScenePollAndSend(node, inst);
      } else {
        console.warn("[rt-scene] node " + nodeId + " gone before scene send; sending empty");
        ws.send(JSON.stringify({ type: "scene", patch: {
          camera: { mode: "perspective", pos:[0,0,2], target:[0,0,0], up:[0,1,0],
                    fov_deg: 60, near: 0.1, far: 100 },
          meshes: [], lights: [], clear_color: [0.05, 0.06, 0.10]
        }}));
      }
      ws.send(JSON.stringify({ type: "render-start" }));
    } catch (e) {
      console.warn("[rt-scene] onopen send threw:", e);
    }
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === "hello") {
        console.log("[rt-scene] engine hello:",
          "backend=" + msg.backend,
          "gpu=" + (msg.capabilities && msg.capabilities.gpu_name));
      } else if (msg.type === "frame-config") {
        _rtSceneAllocateTexture(inst, msg.width | 0, msg.height | 0);
        console.log("[rt-scene] frame-config " + msg.width + "x" + msg.height +
                    " format=" + msg.format);
      } else if (msg.type === "error") {
        console.warn("[rt-scene] engine error:", msg.where, msg.message);
        inst.error = (msg.where || "engine") + ": " + msg.message;
        // 7.5.6.h-status -- promote engine-side errors to inst.status
        // so the node's fallback clear color reflects them. WS is
        // still alive; future frames will replace the red clear if
        // the engine recovers.
        inst.status = "error";
      }
    } else {
      // Binary frame -- raw RGBA8 pixel data. Stash for the next
      // render tick's queue.writeTexture; overwrite any older
      // pending frame (we only display the freshest).
      const incoming = new Uint8Array(ev.data);
      if (inst.warmupFramesRemaining > 0 && inst.heldFrame &&
          inst.heldFrame.byteLength === incoming.byteLength) {
        // 7.5.6.h-warmup -- during TDS warmup, show the previous
        // frame instead of the noisy incoming one. heldFrame stays
        // unchanged so every warmup-hide tick displays the same
        // pre-reset content. The byteLength guard catches a stale
        // heldFrame whose dims don't match the current texture
        // (defense; _rtSceneAllocateTexture should already null
        // heldFrame on dim change).
        inst.pendingFrame = inst.heldFrame;
        inst.warmupFramesRemaining--;
      } else {
        inst.pendingFrame = incoming;
        inst.heldFrame = incoming;
      }
      inst.frameCount++;
      inst.lastFrameAt = performance.now();
      if (inst.frameCount === 1) {
        console.log("[rt-scene] first frame received (" + ev.data.byteLength + " bytes)");
      }
    }
  };
  ws.onerror = (e) => {
    console.warn("[rt-scene] ws error for node " + nodeId, e);
    inst.status = "error";
  };
  ws.onclose = () => {
    console.log("[rt-scene] ws closed for node " + nodeId);
    inst.ws = null;
    if (inst.status !== "error") inst.status = "closed";
    // Try reconnecting after 2s -- handles engine restarts gracefully.
    if (!inst.reconnectTimer) {
      inst.reconnectTimer = setTimeout(() => {
        inst.reconnectTimer = null;
        if (Visual.rtSceneInstances && Visual.rtSceneInstances.get(nodeId) === inst) {
          _rtSceneConnect(nodeId, inst);
        }
      }, 2000);
    }
  };
}

function _rtSceneAllocateTexture(inst, width, height) {
  if (inst.width === width && inst.height === height && inst.texture) return;
  if (inst.texture) try { inst.texture.destroy(); } catch (_) {}
  // 7.5.6.h-warmup -- a dim change invalidates any held frame
  // (different byteLength = can't blit into the new texture). Clear
  // it so the new connection falls through to "no held -> show new
  // frames immediately."
  inst.heldFrame = null;
  inst.warmupFramesRemaining = 0;
  inst.width = width;
  inst.height = height;
  inst.texture = Visual.device.createTexture({
    label: "rt-scene-tex-" + width + "x" + height,
    size: [width, height, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  inst.textureView = inst.texture.createView();
  _ensureRtBlitPipeline();
  inst.bindGroup = Visual.device.createBindGroup({
    label: "rt-scene-bg-" + width + "x" + height,
    layout: Visual._rtBlitBgl,
    entries: [
      { binding: 0, resource: inst.textureView },
      { binding: 1, resource: Visual._rtBlitSampler }
    ]
  });
}

function _encodeRtScenePass(enc, entry) {
  const { node, layerIdx, isScratch, writeKey } = entry;
  let layerView;
  if (isScratch) {
    const views = (writeKey === "a") ? Visual.scratchLayerViewsA : Visual.scratchLayerViewsB;
    layerView = views[layerIdx];
  } else {
    layerView = Visual.framebufferLayerViews[layerIdx];
  }
  if (!layerView) return false;

  const inst = _ensureRtSceneInstance(node);
  if (!inst) return false;

  // Sprint 7.5.6.a part 2e-2 -- live update diff-send. Runs every
  // frame the RT scene is visible; sends a Params or full Scene
  // message ONLY when the wired state has changed since last send.
  // No-op when the WS isn't open yet (initial scene goes via onopen).
  _rtScenePollAndSend(node, inst);

  // Upload pending frame, if any, into the GPU texture.
  if (inst.pendingFrame && inst.texture &&
      inst.pendingFrame.byteLength === inst.width * inst.height * 4) {
    Visual.device.queue.writeTexture(
      { texture: inst.texture },
      inst.pendingFrame,
      { bytesPerRow: inst.width * 4, rowsPerImage: inst.height },
      { width: inst.width, height: inst.height, depthOrArrayLayers: 1 }
    );
    inst.pendingFrame = null;
  }

  // If we don't have a texture yet (still connecting / no frame-
  // config received), clear the layer to a status-coded color +
  // return. Downstream consumers see a flat color; no crash. The
  // color tells the user at a glance which failure mode they're in
  // without having to open dev tools (the actual error message is
  // still in inst.error / the browser console).
  //
  //   navy   = waiting / connecting (normal startup)
  //   red    = engine reported an error (look at inst.error)
  //   crimson= compile-server not detected (start gamma-compile-server)
  //   amber  = WS closed (auto-reconnecting; usually transient)
  // 7.5.6.h-status -- pre-fix, the fallback was always navy regardless
  // of why we had no texture, which meant "engine crashed" looked
  // identical to "I just opened the editor."
  if (!inst.bindGroup || !inst.texture) {
    let clearValue;
    switch (inst.status) {
      case "error":     clearValue = { r: 0.50, g: 0.06, b: 0.06, a: 1.0 }; break;
      case "no-server": clearValue = { r: 0.25, g: 0.05, b: 0.05, a: 1.0 }; break;
      case "closed":    clearValue = { r: 0.20, g: 0.10, b: 0.03, a: 1.0 }; break;
      default:          clearValue = { r: 0.02, g: 0.03, b: 0.05, a: 1.0 }; break;
    }
    enc.beginRenderPass({
      label: "rt-scene-clear-" + node.id + "-" + (inst.status || "init"),
      colorAttachments: [{
        view: layerView,
        clearValue: clearValue,
        loadOp: "clear",
        storeOp: "store"
      }]
    }).end();
    return true;
  }

  // Blit the RT texture onto the framebuffer / scratch layer.
  const pass = enc.beginRenderPass({
    label: "rt-scene-blit-" + node.id,
    colorAttachments: [{
      view: layerView,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  pass.setPipeline(Visual._rtBlitPipeline);
  pass.setBindGroup(0, inst.bindGroup);
  pass.draw(3);
  pass.end();
  return true;
}

