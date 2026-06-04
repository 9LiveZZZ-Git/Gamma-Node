/* ----- Phase 6.6.13 — theater (3D explorable) preview pipeline -------- */

/* The theater pipeline renders each display as a quad in 3D space.
 * The user is at the rig center and looks outward with a perspective
 * camera; WASD + mouse-look drive position and orientation. Quads
 * face inward toward the rig center so the displays read like a
 * planetarium of monitors hanging in space.
 *
 * Geometry: per display, 4 verts at the corners of the quad in world
 * coords (computed in JS each frame from pose + fov + sphere radius).
 * Each vert carries: vec3 position, vec2 uv, u32 layer. One indexed
 * draw covers all displays.
 *
 * Background stays solid black — no skybox geometry, no environment
 * math. "Compute friendly" the user asked for: ~52 triangles per
 * frame for a 26-display AlloSphere, GPU does the rest.
 *
 * Distance smoothing comes from anisotropic sampling on the texture
 * array (the only smooth-falloff option available without generating
 * mipmaps; mipgen would touch the per-frame FBO write path which the
 * user explicitly didn't want). At grazing angles + far quads the
 * GPU's anisotropic filter takes more samples per pixel and stays
 * sharp where mip-bias would alias.
 *
 * IMPORTANT FOLLOW-UP TICKET (carry into 6.6.9 work):
 * Once shader-frag nodes can render their own 3D environment within
 * a display's source layer, this theater camera's WASD + mouse-look
 * will fight with the shader's controls. The fix is a per-display
 * "controls owner" flag — if any active shader has its own camera,
 * theater drops its WASD/mouse capture. Same applies to the planned
 * shader-frag Text overlay (6.6.12 follow-on): when the text node
 * lives in the GPU graph, the theater pipeline will sample its layer
 * naturally. */
function _createTheaterPipeline() {
  if (!Visual.device || !Visual.presentationFormat) return;
  // Phase 6.6.20.14 — bumped from 32 to 128 for scientific-grade
  // projector calibration accuracy. Worst case at 32 displays
  // ×128² mesh:
  //   vertex buf: 32 × 129² × 28 B ≈ 14.9 MB
  //   index buf:  32 × 128² × 6 × 4 B ≈ 12.6 MB
  //   total ≈ 27 MB GPU — fine on any modern WebGPU adapter.
  // Auto-warp / auto-blend currently uses 64 by default (4225
  // verts / display) which gives ~5x more accuracy than the
  // previous 32×32 with proportional compute cost. Users who
  // need 128² scientific accuracy can edit BLEND_MESH_DENSITY in
  // _applyAutoBlendToRig. 512×512 / 1080×1080 require the
  // distributed-rig pipeline (one machine per display) since
  // single-machine compute scales O(N² × num_displays).
  const MESH_CAP = 128;
  const vertsPerDisplayCap   = (MESH_CAP + 1) * (MESH_CAP + 1);
  const indicesPerDisplayCap = MESH_CAP * MESH_CAP * 6;
  Visual._theaterMeshCap         = MESH_CAP;
  Visual._theaterVertsPerDispCap = vertsPerDisplayCap;
  Visual._theaterIdxPerDispCap   = indicesPerDisplayCap;

  const wgsl = /* wgsl */ `
struct U {
  viewProj: mat4x4<f32>,
};

// Per-display blend params packed as vec4: (gamma, blackLift, power, _).
// Indexed by layer (= the display's array-layer index).
struct DispParams {
  d: array<vec4<f32>, ${RIG_MAX_DISPLAYS}>,
};

struct VsIn {
  @location(0) pos:       vec3<f32>,
  @location(1) uv:        vec2<f32>,
  @location(2) intensity: f32,
  @location(3) layer:     u32,
};

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) intensity: f32,
  @location(2) @interpolate(flat) layer: u32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbTex:    texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;
@group(0) @binding(3) var<uniform> dp: DispParams;

@vertex
fn vs_main(in: VsIn) -> VsOut {
  var o: VsOut;
  o.pos       = u.viewProj * vec4<f32>(in.pos, 1.0);
  o.uv        = in.uv;
  o.intensity = in.intensity;
  o.layer     = in.layer;
  return o;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  // Per-display blend params.
  let p     = dp.d[in.layer];
  let g     = max(p.x, 0.0001);
  let bl    = p.y;
  let pw    = max(p.z, 0.0001);
  let inv_g = 1.0 / g;

  // Same edge-blend math as the 2D warp pipeline (Phase 6.6.5–6.6.8)
  // so what you see in theater matches what each projector physically
  // outputs in the real install. Additive blend on the color target
  // handles light-addition across overlapping projector quads.
  let i = clamp(in.intensity, 0.0, 1.0);
  let smoothI = select(
    1.0 - 0.5 * pow(2.0 * (1.0 - i), pw),
    0.5 * pow(2.0 * i, pw),
    i <= 0.5
  );

  // Bourke-mesh UV uses +y up (v=0 at the bottom of source content);
  // WebGPU texture sampling has v=0 at the top of the image. Invert
  // V here so the conversion lives in one place — matches the same
  // flip done in the 2D warp pipeline below.
  let sampleUv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let c       = textureSampleLevel(fbTex, fbSampler, sampleUv, in.layer, 0.0).rgb;
  let cLin    = pow(c, vec3<f32>(g));
  let cBlend  = cLin * smoothI;
  let cLifted = cBlend + vec3<f32>(bl) * (1.0 - smoothI);
  let cOut    = pow(max(cLifted, vec3<f32>(0.0)), vec3<f32>(inv_g));
  return vec4<f32>(cOut, 1.0);
}
`;
  const module = Visual.device.createShaderModule({ label: "theater-shader", code: wgsl });

  Visual.theaterBindGroupLayout = Visual.device.createBindGroupLayout({
    label: "theater-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ]
  });

  Visual.theaterPipeline = Visual.device.createRenderPipeline({
    label: "theater-pipeline",
    layout: Visual.device.createPipelineLayout({
      bindGroupLayouts: [Visual.theaterBindGroupLayout]
    }),
    vertex: {
      module, entryPoint: "vs_main",
      buffers: [{
        arrayStride: 28,                            // vec3 (12) + vec2 (8) + f32 (4) + u32 (4)
        attributes: [
          { shaderLocation: 0, offset: 0,  format: "float32x3" }, // pos
          { shaderLocation: 1, offset: 12, format: "float32x2" }, // uv
          { shaderLocation: 2, offset: 20, format: "float32"   }, // intensity
          { shaderLocation: 3, offset: 24, format: "uint32"    }  // layer
        ]
      }]
    },
    fragment: {
      module, entryPoint: "fs_main",
      // Additive blending so adjacent display quads' contributions
      // SUM across overlap zones. Two adjacent projectors with
      // mirrored intensity ramps (auto-blend) reconstruct full
      // brightness in the overlap exactly like the physical install.
      targets: [{
        format: Visual.presentationFormat,
        blend: {
          color: { srcFactor: "one", dstFactor: "one", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one", operation: "add" }
        }
      }]
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none"   // displays are inward-facing — render both sides
    }
    // No depthStencil — additive blending makes order independent so
    // depth testing only hurts (it would suppress overlap contributions
    // from the farther quad). Trade-off: walking through a quad to its
    // back side still shows it (mirrored). For our use case (looking
    // at a sphere of monitors from the inside) this is the right call.
  });

  // Uniform buffer: 16 floats (mat4x4) = 64 bytes.
  Visual.theaterUniformBuffer = Visual.device.createBuffer({
    label: "theater-uniform",
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  // Per-display blend params: RIG_MAX_DISPLAYS × vec4f. Repacked each
  // frame with current display.edgeBlend values.
  Visual.theaterDispParamsBuffer = Visual.device.createBuffer({
    label: "theater-disp-params",
    size: RIG_MAX_DISPLAYS * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  // Vertex / index buffers sized for the worst case (every display
  // running a 16×16 mesh).
  Visual.theaterVertexBuffer = Visual.device.createBuffer({
    label: "theater-verts",
    size: RIG_MAX_DISPLAYS * vertsPerDisplayCap * 28,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  Visual.theaterIndexBuffer = Visual.device.createBuffer({
    label: "theater-indices",
    size: Math.ceil(RIG_MAX_DISPLAYS * indicesPerDisplayCap * 4 / 4) * 4, // u32 indices for safety
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
  });

  // Anisotropic-filtered sampler for distance smoothing. maxAnisotropy
  // is clamped to 16 by the WebGPU spec; 16 is plenty for the typical
  // theater use case (looking around inside a sphere of monitors).
  Visual.theaterSampler = Visual.device.createSampler({
    label: "theater-sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    maxAnisotropy: 16
  });
}

/* Rebuild the theater bind group when the framebuffer texture array
 * changes (display count or resolution). Same idiom as the rig
 * composite bind group rebuild path. */
function _rebuildTheaterBindGroup() {
  if (!Visual.device || !Visual.framebufferArrayView ||
      !Visual.theaterBindGroupLayout || !Visual.theaterSampler ||
      !Visual.theaterUniformBuffer || !Visual.theaterDispParamsBuffer) return;
  Visual.theaterBindGroup = Visual.device.createBindGroup({
    label: "theater-bg",
    layout: Visual.theaterBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: Visual.theaterUniformBuffer } },
      { binding: 1, resource: Visual.framebufferArrayView },
      { binding: 2, resource: Visual.theaterSampler },
      { binding: 3, resource: { buffer: Visual.theaterDispParamsBuffer } }
    ]
  });
}

/* Allocate (or reallocate) the theater depth texture sized to the
 * current canvas. Called lazily on first theater render and again
 * whenever the canvas size changes. */
function _ensureTheaterDepthTexture() {
  if (!Visual.device || !Visual.canvas) return false;
  const w = Visual.canvas.width, h = Visual.canvas.height;
  if (w <= 0 || h <= 0) return false;
  if (Visual.theaterDepthTexture && Visual.theaterDepthW === w && Visual.theaterDepthH === h) return true;
  if (Visual.theaterDepthTexture) {
    try { Visual.theaterDepthTexture.destroy(); } catch (_) {}
  }
  Visual.theaterDepthTexture = Visual.device.createTexture({
    label: "theater-depth",
    size: [w, h, 1],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT
  });
  Visual.theaterDepthView = Visual.theaterDepthTexture.createView();
  Visual.theaterDepthW = w;
  Visual.theaterDepthH = h;
  return true;
}

/* Build per-display geometry. Each display becomes its warp mesh
 * placed in 3D space — vertex (mx, my) NDC maps to position on the
 * display's quad surface using its right/up basis; (mu, mv) is the
 * source UV; mi is the intensity ramp from auto-blend / hand-edit.
 *
 * For displays without warpMesh: synthesizes a 1×1 identity mesh
 * (4 verts) in-place so the same vertex layout works whether or
 * not the display has been calibrated.
 *
 * Returns:
 *   vertBuf   — Float32Array view of the packed vertex data
 *   idxBuf    — Uint32Array of indices (absolute, into vertBuf)
 *   vertBytes — number of bytes used in vertBuf (for writeBuffer)
 *   idxBytes  — same for idxBuf
 *   indexCount — total indices to draw
 *
 * Sphere radius R = 5 units — gives the user room to walk around
 * inside the rig without quads being awkwardly close. */
function _buildTheaterMeshGeometry(displays) {
  const R = 5.0;
  const stride = 7;     // floats per vert: vec3 pos + vec2 uv + f32 intensity + u32 layer
  const cap = Visual._theaterVertsPerDispCap || 289;
  const idxCap = Visual._theaterIdxPerDispCap || 1536;
  const layerCount = Math.min(displays.length, RIG_MAX_DISPLAYS);
  // 6.6.20+ — when the rig has a curved screen surface (sphere /
  // cylinder / swept) and surfaceVisible is on, project each display
  // vertex onto the actual surface instead of drawing flat quads.
  // This is the real curved-screen projection: a beam from the
  // projector through framebuffer-NDC (mx, my) lands wherever it
  // intersects the screen, NOT on a flat tangent plane.
  const surface = (state && state.rig && state.rig.surface) || null;
  const surfaceVisible = !!(state && state.rig && state.rig.surfaceVisible !== false);
  const useCurvedScreen = !!(surface && surfaceVisible &&
    (surface.type === "sphere" || surface.type === "cylinder" || surface.type === "swept"));

  // Worst-case sized buffers; we track the actual byte usage and
  // pass that to writeBuffer. Avoids per-frame ArrayBuffer alloc
  // by reusing scratch typed arrays attached to Visual.
  if (!Visual._theaterScratch || Visual._theaterScratch.cap !== cap) {
    Visual._theaterScratch = {
      cap,
      verts:   new Float32Array(RIG_MAX_DISPLAYS * cap * stride),
      vertsU32: null,
      idx:     new Uint32Array(RIG_MAX_DISPLAYS * idxCap)
    };
    // Aliased u32 view over the same vert buffer for the layer field.
    Visual._theaterScratch.vertsU32 = new Uint32Array(Visual._theaterScratch.verts.buffer);
  }
  const f32 = Visual._theaterScratch.verts;
  const u32 = Visual._theaterScratch.vertsU32;
  const idx = Visual._theaterScratch.idx;
  let vertHead = 0;     // next vertex index in f32 (in units of "vertex")
  let idxHead  = 0;     // next index slot

  for (let i = 0; i < layerCount; i++) {
    const d = displays[i] || {};
    const pose = d.pose || { yaw: 0, pitch: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    const yr = pose.yaw   * Math.PI / 180;
    const pr = pose.pitch * Math.PI / 180;
    const fx = Math.sin(yr) * Math.cos(pr);
    const fy = Math.sin(pr);
    const fz = Math.cos(yr) * Math.cos(pr);
    // Build the display-local right/up basis. Convention:
    //   forward × right = up     (right-handed orthonormal)
    //   right  = normalize(altUp × forward)   ← "user's right" when
    //                                           looking at the display
    //   up     = forward × right              ← world-up at level pitch
    //
    // EARLIER BUG (visible on the user's pinwheel patch):
    // I had right = forward × altUp, which is the negative — making
    // each display's left/right basis flipped. Visible only on
    // horizontally-asymmetric content (pinwheels, text); horizontally-
    // symmetric content (solid blue, V-symmetric bow + edge fades)
    // looked the same flipped. The fix makes adjacent displays' inner
    // edges actually meet in 3D so a SHARED-consumer shader spans the
    // whole rig continuously.
    let altUpX = 0, altUpY = 1, altUpZ = 0;
    if (Math.abs(fy) > 0.95) { altUpX = 0; altUpY = 0; altUpZ = 1; }
    let rx = altUpY * fz - altUpZ * fy;
    let ry = altUpZ * fx - altUpX * fz;
    let rz = altUpX * fy - altUpY * fx;
    let rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;
    const tanH = Math.tan(fov.h * Math.PI / 360);
    const tanV = Math.tan(fov.v * Math.PI / 360);
    const halfW = R * tanH;
    const halfH = R * tanV;
    const cx = R * fx, cy = R * fy, cz = R * fz;

    // Determine mesh shape. Bourke mesh format from Phase 6.6.1:
    //   verts is a flat array of (mx, my, mu, mv, mi) per vertex
    //   on a (cols+1) × (rows+1) grid.
    let meshCols, meshRows, meshVerts;
    const wm = d.warpMesh;
    const useMesh = wm && _validateWarpMesh(wm) &&
                    wm.cols <= Visual._theaterMeshCap &&
                    wm.rows <= Visual._theaterMeshCap;
    if (useMesh) {
      meshCols  = wm.cols;
      meshRows  = wm.rows;
      meshVerts = wm.verts;
    } else {
      // 6.6.20+ — when projecting onto a curved screen with no warp
      // mesh, use an 8×8 identity grid (81 verts) so each display's
      // patch curves visibly. Flat-screen rigs still use 1×1 (4 verts)
      // since flat quads need no subdivision.
      const idDensity = useCurvedScreen ? 8 : 1;
      const idMesh = _makeIdentityWarpMesh(idDensity, idDensity);
      meshCols  = idMesh.cols;
      meshRows  = idMesh.rows;
      meshVerts = idMesh.verts;
    }

    const W = meshCols + 1, H = meshRows + 1;
    const dispBaseVert = vertHead;

    // Emit vertices for this display's mesh.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const mi5 = (r * W + c) * 5;
        const mx = meshVerts[mi5 + 0];
        const my = meshVerts[mi5 + 1];
        const mu = meshVerts[mi5 + 2];
        const mv = meshVerts[mi5 + 3];
        const mInt = meshVerts[mi5 + 4];
        // 3D position. 6.6.20+: when a curved screen is active, cast
        // a beam from the projector (origin) through framebuffer-NDC
        // (mx, my) and intersect with the screen surface — the
        // physical reality of a projector hitting a curved screen.
        // When the beam misses the screen (e.g. yaw outside the
        // partial-revolution span of a swept surface) we fall back
        // to the flat-quad position so the display doesn't disappear
        // as a visual debugging aid.
        let px, py, pz;
        if (useCurvedScreen) {
          const dx = fx + rx * (mx * tanH) + ux * (my * tanV);
          const dy = fy + ry * (mx * tanH) + uy * (my * tanV);
          const dz = fz + rz * (mx * tanH) + uz * (my * tanV);
          const hit = _screenProjectionPoint([dx, dy, dz], surface, R);
          if (hit) {
            px = hit[0]; py = hit[1]; pz = hit[2];
          } else {
            px = cx + rx * (mx * halfW) + ux * (my * halfH);
            py = cy + ry * (mx * halfW) + uy * (my * halfH);
            pz = cz + rz * (mx * halfW) + uz * (my * halfH);
          }
        } else {
          // Flat-quad behavior (legacy): mx/my in [-1,1] NDC of the
          // projector framebuffer maps to right/up offsets of halfW
          // / halfH from the display's center direction at distance R.
          px = cx + rx * (mx * halfW) + ux * (my * halfH);
          py = cy + ry * (mx * halfW) + uy * (my * halfH);
          pz = cz + rz * (mx * halfW) + uz * (my * halfH);
        }
        const off = vertHead * stride;
        f32[off + 0] = px;
        f32[off + 1] = py;
        f32[off + 2] = pz;
        f32[off + 3] = mu;
        f32[off + 4] = mv;
        f32[off + 5] = mInt;
        u32[off + 6] = i;
        vertHead++;
      }
    }

    // Indices for this display's quads.
    for (let r = 0; r < meshRows; r++) {
      for (let c = 0; c < meshCols; c++) {
        const tl = dispBaseVert + r * W + c;
        const tr = tl + 1;
        const bl = dispBaseVert + (r + 1) * W + c;
        const br = bl + 1;
        idx[idxHead++] = tl;
        idx[idxHead++] = bl;
        idx[idxHead++] = tr;
        idx[idxHead++] = tr;
        idx[idxHead++] = bl;
        idx[idxHead++] = br;
      }
    }
  }

  return {
    vertBytes:  vertHead * stride * 4,
    idxBytes:   idxHead  * 4,
    indexCount: idxHead
  };
}

/* Compute the view-projection matrix from the camera state. Returns
 * a 16-float column-major mat4 ready to writeBuffer. WebGPU clip-
 * space Z is [0, 1], so the projection matrix uses that convention.
 *
 * Camera basis matches the rig's display-pose convention so yaw=0
 * looks toward +Z (where display 0 sits at default pose). yaw +90°
 * looks toward +X; pitch +90° looks toward +Y zenith. This way the
 * user spawns inside the rig facing display 0 — natural starting
 * orientation for "explore the rig". */
function _theaterViewProjMatrix(cam, aspect) {
  const cy = Math.cos(cam.yaw),   sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);

  // forward = ( sin(yaw)*cos(pitch),  sin(pitch),  cos(yaw)*cos(pitch))
  // right   = ( cos(yaw),             0,          -sin(yaw))
  // up      = forward × right (so neutral pitch gives world-up +Y)
  const fx = sy * cp, fy = sp, fz = cy * cp;
  const rx = cy,      ry = 0,  rz = -sy;
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  const px = cam.pos[0], py = cam.pos[1], pz = cam.pos[2];

  // View matrix (col-major), inverse of camera transform:
  //   col 0: right
  //   col 1: up
  //   col 2: -forward  (so view-space -Z is forward)
  //   col 3: -dot(basis, eye)
  const view = new Float32Array(16);
  view[0]  = rx;  view[1]  = ux;  view[2]  = -fx; view[3]  = 0;
  view[4]  = ry;  view[5]  = uy;  view[6]  = -fy; view[7]  = 0;
  view[8]  = rz;  view[9]  = uz;  view[10] = -fz; view[11] = 0;
  view[12] = -(rx*px + ry*py + rz*pz);
  view[13] = -(ux*px + uy*py + uz*pz);
  view[14] =  (fx*px + fy*py + fz*pz);
  view[15] = 1;

  // Perspective projection (col-major), WebGPU [0,1] clip Z.
  const fovY = cam.fov * Math.PI / 180;
  const f    = 1 / Math.tan(fovY * 0.5);
  const near = 0.01, far = 100.0;
  const nf   = 1 / (near - far);
  const proj = new Float32Array(16);
  proj[0]  = f / aspect;
  proj[5]  = f;
  proj[10] = far * nf;
  proj[11] = -1;
  proj[14] = near * far * nf;

  // viewProj = proj * view (col-major: result[col][row] = sum proj[k][row]*view[col][k])
  const vp = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k];
      vp[c * 4 + r] = s;
    }
  }
  return vp;
}

/* Update camera position from currently-held keys. Called once per
 * frame from the render tick. dt is in seconds. Movement is in
 * camera-relative space (W = forward, A = left, S = back, D = right,
 * Q = down, E = up, Shift = sprint). */
function _theaterStepCamera(dt) {
  const cam = Visual.theaterCam;
  // Apply touch-stick look first (keyboard look comes from mouse-
  // pointerlock movement events directly into yaw/pitch). Touch
  // delivers a continuous "rate" while the finger is held, scaled
  // by dt here so the same gesture distance gives consistent
  // angular speed regardless of frame rate.
  if (cam.touchLook) {
    cam.yaw   -= cam.touchLook.dx * dt;
    cam.pitch -= cam.touchLook.dy * dt;
    const lim = Math.PI * 0.49;
    if (cam.pitch >  lim) cam.pitch =  lim;
    if (cam.pitch < -lim) cam.pitch = -lim;
  }
  if (cam.keys.size === 0 && !cam.touchMove) return;
  const speed = cam.speed * (cam.keys.has("Shift") ? 4 : 1) * dt;
  const cy = Math.cos(cam.yaw),   sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  // World-space forward / right vectors at current orientation. Same
  // convention as _theaterViewProjMatrix (yaw=0 looks toward +Z).
  const fx = sy * cp, fy = sp, fz = cy * cp;
  const rx = cy,      ry = 0,  rz = -sy;
  let dx = 0, dy = 0, dz = 0;
  // Keyboard: arrow keys + PageUp/PageDown. Names match KeyboardEvent.key
  // exactly so the lookups stay simple. Touch-stick deltas (set in
  // _touchPad below) are added separately and don't go through this
  // key set — they bypass the held-key logic since touch is already
  // analog.
  if (cam.keys.has("ArrowUp"))    { dx += fx; dy += fy; dz += fz; }
  if (cam.keys.has("ArrowDown"))  { dx -= fx; dy -= fy; dz -= fz; }
  if (cam.keys.has("ArrowRight")) { dx += rx; dy += ry; dz += rz; }
  if (cam.keys.has("ArrowLeft"))  { dx -= rx; dy -= ry; dz -= rz; }
  if (cam.keys.has("PageUp"))     { dy += 1; }   // world-up regardless of pitch
  if (cam.keys.has("PageDown"))   { dy -= 1; }
  // Touch-stick movement (analog from the on-screen pad).
  if (cam.touchMove) {
    dx += fx * cam.touchMove.fwd  + rx * cam.touchMove.strafe;
    dy += fy * cam.touchMove.fwd  + ry * cam.touchMove.strafe;
    dz += fz * cam.touchMove.fwd  + rz * cam.touchMove.strafe;
  }
  // Normalize so diagonals don't move faster than axes.
  const l = Math.hypot(dx, dy, dz);
  if (l > 0.0001) {
    cam.pos[0] += (dx / l) * speed;
    cam.pos[1] += (dy / l) * speed;
    cam.pos[2] += (dz / l) * speed;
  }
}

/* One-time event wiring for theater mode. Mouse-look uses pointer
 * lock — click on the visual canvas to engage, ESC to release.
 * Keyboard listeners live on document so they fire regardless of
 * focus while in theater mode. All listeners gate on previewMode
 * being "theater" so theater controls don't fire when the rig is
 * showing a different preview.
 *
 * Critical follow-up for shader-frag environments (carry into 6.6.9):
 * when shader nodes have their own 3D camera (e.g. raymarching
 * scenes), they'll fight with theater's WASD/mouse capture. The
 * intended fix is a "controls owner" registry — if any active shader
 * has registered camera ownership, theater drops its capture in that
 * frame. Stubs are flagged with TODO comments so the future ticket
 * has clear edit points. */
function _wireTheaterInput() {
  if (Visual.theaterInputWired) return;
  Visual.theaterInputWired = true;

  const canvas = Visual.canvas;
  if (canvas) {
    canvas.addEventListener("click", () => {
      if (state && state.rig && state.rig.previewMode === "theater") {
        // TODO (6.6.9): defer to active shader-frag camera owner if any.
        try { canvas.requestPointerLock(); } catch (_) {}
      }
    });
  }
  document.addEventListener("pointerlockchange", () => {
    Visual.theaterCam.pointerLocked = (document.pointerLockElement === canvas);
    document.body.classList.toggle("theater-locked", Visual.theaterCam.pointerLocked);
  });
  document.addEventListener("mousemove", (e) => {
    if (!Visual.theaterCam.pointerLocked) return;
    if (!state || !state.rig || state.rig.previewMode !== "theater") return;
    // TODO (6.6.9): defer to active shader-frag camera owner if any.
    Visual.theaterCam.yaw   -= e.movementX * Visual.theaterCam.sensitivity;
    Visual.theaterCam.pitch -= e.movementY * Visual.theaterCam.sensitivity;
    const lim = Math.PI * 0.49;     // ~88° to avoid singular vertical
    if (Visual.theaterCam.pitch >  lim) Visual.theaterCam.pitch =  lim;
    if (Visual.theaterCam.pitch < -lim) Visual.theaterCam.pitch = -lim;
  });
  // Theater movement keys deliberately AVOID the QWERTY musical
  // keyboard map (W A S D E L… are mapped to MIDI notes) — using
  // arrow keys + PageUp/PageDown means audio runtime can keep
  // playing notes while the user moves around in theater mode.
  // Shift is kept as the sprint modifier — Shift is harmless
  // alongside note-playing (the keyboard reads bare keys).
  document.addEventListener("keydown", (e) => {
    if (!state || !state.rig || state.rig.previewMode !== "theater") return;
    if (!Visual.theaterCam.pointerLocked) return;
    // TODO (6.6.9): defer to active shader-frag camera owner if any.
    const k = e.key;
    const handled = ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","PageUp","PageDown","Shift"];
    if (handled.includes(k)) {
      Visual.theaterCam.keys.add(k);
      e.preventDefault();
    }
  });
  document.addEventListener("keyup", (e) => {
    Visual.theaterCam.keys.delete(e.key);
  });
  // Drop all held keys when pointer lock releases — otherwise a user
  // who holds an arrow key and presses Esc has the camera drift forever.
  document.addEventListener("pointerlockchange", () => {
    if (!Visual.theaterCam.pointerLocked) Visual.theaterCam.keys.clear();
  });

  // Touch-screen pads. Visible only when navigator.maxTouchPoints > 0
  // AND the rig is in theater mode (gated by body.theater-touch +
  // body.theater-mode classes set in _updateProjectionPill +
  // _wireTouchPads).
  if (navigator.maxTouchPoints > 0 || ("ontouchstart" in window)) {
    document.body.classList.add("theater-touch-capable");
    _wireTouchPads();
  }
}

/* Phase 7 §5.5.f -- FPCamera input wiring. Keyboard (WASD move,
 * IJKL look, Space / C / Ctrl up-down, Shift sprint) works WITHOUT
 * pointer-lock so theater-mode users can navigate without claiming
 * the mouse. Pointer-lock is optional (canvas-click outside theater)
 * and adds mouse-look on top -- preserves the FPS feel for users
 * who want it. KeyboardEvent.code is layout-stable across QWERTY /
 * AZERTY / DVORAK. Conflicts with the QWERTY musical keyboard are
 * gated by previewState (audio-not-playing -> FPCamera consumes
 * letters; audio playing -> synth wins via its earlier gate). */
function _wireFPCameraInput() {
  if (Visual.fpcInputWired) return;
  Visual.fpcInputWired = true;

  const canvas = Visual.canvas;
  const hasFPCamera = () => Array.isArray(state && state.nodes) &&
                            state.nodes.some(n => n && n.type === "FPCamera");
  const inTheater = () => state && state.rig && state.rig.previewMode === "theater";
  const isTypingInForm = () => {
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = ae.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable;
  };
  const fpcActive = () => hasFPCamera() && !isTypingInForm();

  if (canvas) {
    canvas.addEventListener("click", () => {
      if (!hasFPCamera() || inTheater()) return;
      try { canvas.requestPointerLock(); } catch (_) {}
    });
  }
  document.addEventListener("pointerlockchange", () => {
    const locked = (document.pointerLockElement === canvas) && hasFPCamera() && !inTheater();
    Visual.fpcInput.pointerLocked = locked;
    document.body.classList.toggle("fpc-locked", locked);
    if (!locked) {
      Visual.fpcInput.mouseDx = 0;
      Visual.fpcInput.mouseDy = 0;
    }
  });
  document.addEventListener("mousemove", (e) => {
    if (!Visual.fpcInput.pointerLocked) return;
    Visual.fpcInput.mouseDx += e.movementX || 0;
    Visual.fpcInput.mouseDy += e.movementY || 0;
  });
  // Movement (WASD) + Look (IJKL) + Roll (U/O, flight mode) +
  // vertical (Space / C / Ctrl) + sprint (Shift). All gated on
  // fpcActive() so they don't fire while editing text inputs.
  //
  // KeyU and KeyO are ALSO in QWERTY_TO_MIDI (the piano keyboard);
  // we register this keydown handler in the CAPTURE phase + call
  // stopPropagation so the piano listener (which runs in bubble
  // phase, line ~68083) never sees U/O while an FPCamera is active.
  // The audio-gate in tool-shortcuts (line ~44773) already releases
  // these letters back to the piano when audio is playing -- we
  // mirror that behavior: if previewState is playing, don't claim
  // U/O for FPCamera either, so the user can play notes.
  const FPC_KEYS = new Set([
    "KeyW", "KeyA", "KeyS", "KeyD",
    "KeyI", "KeyJ", "KeyK", "KeyL",
    "KeyU", "KeyO",
    "KeyC", "Space",
    "ShiftLeft", "ShiftRight",
    "ControlLeft", "ControlRight",
    "KeyX", "KeyZ"
  ]);
  const PIANO_LETTER_KEYS = new Set(["KeyU", "KeyO"]);
  const audioPlaying = () =>
    (typeof previewState !== "undefined") && previewState && previewState.state === "playing";
  document.addEventListener("keydown", (e) => {
    if (!fpcActive()) return;
    if (!FPC_KEYS.has(e.code)) return;
    // Yield U/O back to the piano when audio is live -- otherwise
    // FPCamera roll would steal the A#4 / C#5 keys mid-performance.
    if (audioPlaying() && PIANO_LETTER_KEYS.has(e.code)) return;
    Visual.fpcInput.keys.add(e.code);
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.addEventListener("keyup", (e) => {
    if (FPC_KEYS.has(e.code)) Visual.fpcInput.keys.delete(e.code);
  }, true);
}

/* §5.5.f-2 -- sample the terrain ground height at (wx, wz) for
 * walk-mode FPCamera Y locking. Finds the first TiledTerrain in
 * the patch and runs its noise formula (same _tiledTerrainHeightAt
 * used by the mesh builder, so player and visible terrain match
 * exactly). Returns the Y in world units, or null when no
 * sampleable terrain is in the patch (the camera then keeps its
 * literal posY -- behaves like fly mode). */
/* §planet-spec Phase 6 -- world-Y of the Planet's surface at flat-XZ
 * world position (wx, wz). Used by FPCamera walk-mode when no
 * TiledTerrain exists in the patch: the player walks on Planet's
 * heightfield directly. Same projection as _projectFlatToPlanet (spawn
 * is the pole), same noise sampling as _buildPlanet. effectiveOctavesF
 * uses the node's full octaves count so the camera matches the visible
 * terrain in the deepest-LOD chunks right under the player (where they
 * actually walk). Coarse outer-LOD chunks may show a few cm mismatch;
 * that's invisible in walk mode. */
function _planetSurfaceYAt(wx, wz, planet, planetParams) {
  const d = Math.sqrt(wx * wx + wz * wz);
  let ux, uy, uz;
  if (d < 1e-6) {
    ux = 0; uy = 1; uz = 0;
  } else {
    const theta = d / planet.r;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    ux = st * wx / d;
    uy = ct;
    uz = st * wz / d;
  }
  const hs       = (typeof planetParams.heightScale === "number") ? planetParams.heightScale : 0;
  const seaLevel = Math.max(0, Math.min(1, (typeof planetParams.seaLevel === "number") ? planetParams.seaLevel : 0.5));
  const noiseOcts = Math.max(1, Math.min(20, Math.floor((typeof planetParams.octaves === "number") ? planetParams.octaves : 6)));
  const noiseDef = {
    seed:       (typeof planetParams.seed       === "number") ? planetParams.seed       : 7.3,
    frequency:  (typeof planetParams.frequency  === "number") ? planetParams.frequency  : 1.0,
    octaves:    noiseOcts,
    effectiveOctavesF: noiseOcts,
    lacunarity: (typeof planetParams.lacunarity === "number") ? planetParams.lacunarity : 2.0,
    gain:       (typeof planetParams.gain       === "number") ? planetParams.gain       : 0.5,
    ridges:     (typeof planetParams.ridges     === "number") ? planetParams.ridges     : 0
  };
  let altitude = 0;
  if (hs !== 0) {
    const h = _terrainFBM3D(ux, uy, uz, noiseDef);
    if (h > seaLevel) {
      const above = (h - seaLevel) / Math.max(1e-6, 1 - seaLevel);
      altitude = hs * above;
    }
  }
  // Ellipsoid surface Y + altitude along radial unit_vec Y component.
  return planet.cy + planet.r * uy * planet.polRatio + altitude * uy;
}

function _fpcSampleGroundY(wx, wz, wy) {
  if (!state || !Array.isArray(state.nodes)) return null;
  const tt = state.nodes.find(n => n && n.type === "TiledTerrain");
  if (!tt || !tt.params) {
    // Sprint 8-8: prefer PlanetMesh (new pipeline) over legacy Planet.
    // For a sphere planet, "ground Y" depends on the camera's full
    // (X, Y, Z) -- the same XZ can map to either pole, so we need wy
    // (caller passes posY).
    const pmesh = state.nodes.find(n => n && n.type === "PlanetMesh");
    if (pmesh) {
      const pl = _findPlanetInfo();
      if (pl && typeof wy === "number") {
        const surf = _planetMeshSurfacePos(wx, wy, wz, pl);
        if (surf) return surf.y;
      }
    }
    // §planet-spec Phase 6 -- legacy Planet fallback.
    const pl = state.nodes.find(n => n && n.type === "Planet");
    if (pl && pl.params) {
      const planet = _findPlanetForProjection();
      if (planet) return _planetSurfaceYAt(wx, wz, planet, pl.params);
    }
    return null;
  }
  const p = tt.params;
  const noise = {
    seed:       (typeof p.seed       === "number") ? p.seed       : 7.42,
    frequency:  (typeof p.frequency  === "number") ? p.frequency  : 0.008,
    octaves:    (typeof p.octaves    === "number") ? p.octaves    : 6,
    lacunarity: (typeof p.lacunarity === "number") ? p.lacunarity : 2.05,
    gain:       (typeof p.gain       === "number") ? p.gain       : 0.5,
    ridges:     (typeof p.ridges     === "number") ? p.ridges     : 0.0,
    plateau:    (typeof p.plateau    === "number") ? p.plateau    : 0.0,
    erosionParams: _findTiledErosionParams(tt),
    islandParams:  _findTiledIslandParams(tt)
  };
  const hs   = (typeof p.heightScale === "number") ? p.heightScale : 80;
  const yOff = (typeof p.yOffset === "number")     ? p.yOffset     : 0;

  // §5.5.e-8 -- match the rendered mesh exactly under the player's
  // feet. Sample at the same vertex spacing the local chunk's LOD
  // uses + bilinear-interp the 4 corner heights. Without this the
  // camera (exact fBm) and mesh (LOD-discretized linear interp)
  // disagree by tens of meters in low-LOD outer chunks -- the
  // camera dips under the visible surface.
  const cs       = Math.max(1, (typeof p.chunkSize   === "number") ? p.chunkSize   : 64);
  const baseSegs = Math.max(2, Math.min(64, Math.floor((typeof p.segments === "number") ? p.segments : 24)));
  const radius   = Math.max(0, Math.min(32, Math.floor((typeof p.chunkRadius === "number") ? p.chunkRadius : 8)));
  const center   = _tiledTerrainCenterTile(tt);
  const ptx = Math.floor(wx / cs);
  const ptz = Math.floor(wz / cs);
  const segsHere = _tiledTerrainLodSegments(
    Math.abs(ptx - center.tx), Math.abs(ptz - center.tz), radius, baseSegs);
  const dStep = cs / segsHere;
  // Snap to LOD grid + bilinear corners.
  const gx = Math.floor(wx / dStep) * dStep;
  const gz = Math.floor(wz / dStep) * dStep;
  const fx = Math.max(0, Math.min(1, (wx - gx) / dStep));
  const fz = Math.max(0, Math.min(1, (wz - gz) / dStep));
  const sampleAt = (x, z) => _tiledFinalY(x, z, noise, hs, yOff);
  const y00 = sampleAt(gx,         gz        );
  const y10 = sampleAt(gx + dStep, gz        );
  const y01 = sampleAt(gx,         gz + dStep);
  const y11 = sampleAt(gx + dStep, gz + dStep);
  return y00 * (1 - fx) * (1 - fz)
       + y10 * fx       * (1 - fz)
       + y01 * (1 - fx) * fz
       + y11 * fx       * fz;
}

/* Sprint 8.0.3-a -- TerrainCollider runtime.
 *
 * Unified, source-agnostic height-query API for foliage placement /
 * simple character controllers / future Rapier physics bridge /
 * AI ground-snap / prop pivot alignment. Sources resolved at query
 * time, in priority order: TiledTerrain → PlanetMesh → legacy
 * Planet. Same JS noise functions the renderer + FPCamera walk-
 * mode use, so query points and visible terrain stay in lockstep.
 *
 * Three layers:
 *   1. _terrainColliderHeightAt(wx, wz, opts?) -- raw helper
 *   2. TerrainCollider node -> emits .height resolved via the
 *      `_readWireJsSideValue` dispatcher (see below)
 *   3. window.__COLLIDER for scripting + harness access
 *
 * `opts.preferredSourceId` (optional) -- if the TerrainCollider has
 * a `terrain` input wired, the source's node.id is passed here and
 * we honor the explicit choice; otherwise we auto-pick. */
function _terrainColliderHeightAt(wx, wz, opts) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) {
    return null;
  }
  const preferredId = opts && opts.preferredSourceId;
  const matchType = (n, type) => n && n.type === type;
  const matchPreferred = (n) =>
    preferredId !== undefined && preferredId !== null
      ? (n && n.id === preferredId)
      : false;

  // Explicit source wins regardless of type ordering.
  const explicit = preferredId
    ? state.nodes.find(n => n && n.id === preferredId)
    : null;

  // Resolve in priority order. Each branch reuses the exact same
  // helper the renderer / walk-mode use, so 1-to-1 lockstep is free.
  const tryTiled = (n) => {
    if (!n || !n.params) return null;
    const p = n.params;
    const noise = {
      seed:       (typeof p.seed       === "number") ? p.seed       : 7.42,
      frequency:  (typeof p.frequency  === "number") ? p.frequency  : 0.008,
      octaves:    (typeof p.octaves    === "number") ? p.octaves    : 6,
      lacunarity: (typeof p.lacunarity === "number") ? p.lacunarity : 2.05,
      gain:       (typeof p.gain       === "number") ? p.gain       : 0.5,
      ridges:     (typeof p.ridges     === "number") ? p.ridges     : 0.0,
      plateau:    (typeof p.plateau    === "number") ? p.plateau    : 0.0,
      erosionParams: _findTiledErosionParams(n),
      islandParams:  _findTiledIslandParams(n)
    };
    const hs   = (typeof p.heightScale === "number") ? p.heightScale : 80;
    const yOff = (typeof p.yOffset     === "number") ? p.yOffset     : 0;
    return _tiledFinalY(wx, wz, noise, hs, yOff);
  };

  /* §bonus-parity (2026-05-25) -- Terrain query. Maps world (wx, wz)
   * back into Terrain's (u, v) noise coords. Works only when no
   * heightmap is wired (CPU-noise path); when wired, the GPU shader
   * does displacement and CPU has no cheap query against the texture.
   * Out-of-extent points (|wx| > w/2 or |wz| > w/2) return null. */
  const tryTerrain = (n) => {
    if (!n || !n.params) return null;
    const p = n.params;
    const hmWired = state.edges && state.edges.some(e =>
      e && e.to && e.to.node === n.id && e.to.port === "heightmap"
    );
    if (hmWired) return null;
    const sizePresets = { small: 20, medium: 100, large: 1000, infinite: 10000 };
    const mode = (typeof p.sizeMode === "string") ? p.sizeMode : "medium";
    const customSize = (typeof p.worldSize === "number") ? p.worldSize : 100;
    const w = (mode === "custom") ? customSize : (sizePresets[mode] || customSize);
    const hw = w * 0.5;
    if (wx < -hw || wx > hw || wz < -hw || wz > hw) return null;
    const u = (wx + hw) / w;
    const v = (wz + hw) / w;
    const noise = {
      seed:       (typeof p.seed       === "number") ? p.seed       : 1.234,
      frequency:  (typeof p.frequency  === "number") ? p.frequency  : 2.0,
      octaves:    (typeof p.octaves    === "number") ? p.octaves    : 5,
      lacunarity: (typeof p.lacunarity === "number") ? p.lacunarity : 2.0,
      gain:       (typeof p.gain       === "number") ? p.gain       : 0.5,
      ridges:     (typeof p.ridges     === "number") ? p.ridges     : 0.0
    };
    let h01 = _terrainFBM(u, v, noise);
    const plateau = Math.max(0, Math.min(1, (typeof p.plateau === "number") ? p.plateau : 0));
    if (plateau > 0) {
      const k = 1 + plateau * 4;
      h01 = Math.pow(Math.max(0, Math.min(1, h01)), k);
    }
    const hsRaw = (typeof p.heightScale === "number") ? p.heightScale : 12;
    const hs = hsRaw * (w / 100);
    const yOff = (typeof p.yOffset === "number") ? p.yOffset : 0;
    return (h01 - 1) * hs + yOff;
  };

  const tryPlanetMesh = (n) => {
    const pl = _findPlanetInfo();
    if (!pl) return null;
    // Caller didn't pass wy -- approximate by querying with the
    // surface-Y at this XZ (one extra eval; matches walk-mode's
    // first-step behavior).
    const surf = _planetMeshSurfacePos(wx, 0, wz, pl);
    return surf ? surf.y : null;
  };

  const tryPlanet = (n) => {
    if (!n || !n.params) return null;
    const planet = _findPlanetForProjection();
    if (!planet) return null;
    return _planetSurfaceYAt(wx, wz, planet, n.params);
  };

  if (explicit) {
    if (matchType(explicit, "TiledTerrain"))                  return tryTiled(explicit);
    if (matchType(explicit, "Terrain"))                       return tryTerrain(explicit);
    if (matchType(explicit, "PlanetMesh"))                    return tryPlanetMesh(explicit);
    if (matchType(explicit, "Planet"))                        return tryPlanet(explicit);
    // Unknown explicit source -- fall through to auto.
  }

  // Auto-resolve: TiledTerrain → Terrain → PlanetMesh → Planet. Tiled
  // takes priority since it's the "infinite-world" path; Terrain is
  // the finite single-mesh, queried in second place.
  const tt = state.nodes.find(n => matchType(n, "TiledTerrain"));
  if (tt) {
    const y = tryTiled(tt);
    if (y !== null && Number.isFinite(y)) return y;
  }
  const ter = state.nodes.find(n => matchType(n, "Terrain"));
  if (ter) {
    const y = tryTerrain(ter);
    if (y !== null && Number.isFinite(y)) return y;
  }
  const pmesh = state.nodes.find(n => matchType(n, "PlanetMesh"));
  if (pmesh) {
    const y = tryPlanetMesh(pmesh);
    if (y !== null && Number.isFinite(y)) return y;
  }
  const pl = state.nodes.find(n => matchType(n, "Planet"));
  if (pl) {
    const y = tryPlanet(pl);
    if (y !== null && Number.isFinite(y)) return y;
  }
  return null;
}

/* Sprint 8.0.3-a -- planet ray-from-center query. For PlanetMesh,
 * returns the surface RADIUS along the normalized direction (dx,
 * dy, dz). Used by foliage on the planet surface that wants
 * radial alignment, and by future RT engine integration that
 * shoots rays from the planet center for sun/sky illumination. */
function _terrainColliderRadialAt(dx, dy, dz) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return null;
  const pl = _findPlanetInfo();
  if (!pl) return null;
  // Project the input direction to a unit vector + sample via the
  // surface-pos helper using a far point along the ray as the
  // "world position" (matches _planetMeshSurfacePos's projection).
  const ln = Math.hypot(dx, dy, dz);
  if (ln < 1e-12) return null;
  const inv = 1 / ln;
  const ux = dx * inv, uy = dy * inv, uz = dz * inv;
  const probeR = (pl.r || 1) * 4.0;
  const surf = _planetMeshSurfacePos(
    pl.cx + ux * probeR,
    pl.cy + uy * probeR,
    pl.cz + uz * probeR,
    pl
  );
  if (!surf) return null;
  const sx = surf.x - pl.cx;
  const sy = surf.y - pl.cy;
  const sz = surf.z - pl.cz;
  return Math.hypot(sx, sy, sz);
}

/* Resolve the explicit source of a TerrainCollider node by walking
 * its `terrain` input wire upstream past any transform nodes to the
 * leaf mesh-gen node. Returns the source node or null. */
function _terrainColliderExplicitSource(colliderNode) {
  if (!colliderNode || !state || !Array.isArray(state.edges)) return null;
  const wire = state.edges.find(e =>
    e && e.to && e.to.node === colliderNode.id && e.to.port === "terrain"
  );
  if (!wire || !wire.from) return null;
  let cur = state.nodes.find(n => n && n.id === wire.from.node);
  let guard = 0;
  while (cur && guard++ < 32) {
    const def = TYPES[cur.type];
    if (!def) return null;
    if (def.kind === "mesh-gen")       return cur;
    if (def.kind === "mesh-transform" || def.kind === "material") {
      const next = state.edges.find(e =>
        e && e.to && e.to.node === cur.id && e.to.port === "mesh"
      );
      if (!next || !next.from) return null;
      cur = state.nodes.find(n => n && n.id === next.from.node);
      continue;
    }
    return null;
  }
  return null;
}

/* Helper: find the first planet-like node in the patch + return its
 * center / radius so flight-mode Space/C can move radially and the
 * altimeter / minimap can do globe math. Returns null if no planet
 * present (terrain-only patches). */
function _findPlanetInfo() {
  if (!state || !Array.isArray(state.nodes)) return null;
  let pNode = null;
  let pMap = null;
  for (const n of state.nodes) {
    if (!n) continue;
    if (n.type === "PlanetMesh" || n.type === "Planet") { if (!pNode) pNode = n; }
    else if (n.type === "PlanetMap") { if (!pMap) pMap = n; }
  }
  const src = pNode || pMap;
  if (!src) return null;
  const pr = src.params || {};
  const r = (typeof pr.radius === "number") ? pr.radius : 0;
  if (r <= 0) return null;
  return {
    centerX:     (typeof pr.centerX === "number") ? pr.centerX : 0,
    centerY:     (typeof pr.centerY === "number") ? pr.centerY : 0,
    centerZ:     (typeof pr.centerZ === "number") ? pr.centerZ : 0,
    radius:      r,
    polRatio:    (typeof pr.polarRadiusRatio === "number") ? pr.polarRadiusRatio : 1,
    heightScale: (typeof pr.heightScale === "number") ? pr.heightScale : 0,
    seaLevel:    (typeof pr.seaLevel === "number") ? pr.seaLevel : 0,
    // Sprint 8-8c: vs_main multiplies the detail-noise displacement
    // by this. _planetMeshSurfacePos uses it to mirror the shader.
    dispScale:   (typeof pr.displacementScale === "number") ? pr.displacementScale : 0,
    // PlanetMap-bearing node for heightmap sampling. May not have
    // built its cells yet -- callers check pMap._cells before using.
    mapNode:     pMap
  };
}

/* Helper: radial-up unit vector at world position p, relative to the
 * patch's planet. Used by flight-mode Space/C ("up" = away from
 * planet) and by initial-orientation math. Returns null if no
 * planet in the patch. */
function _planetRadialUp(px, py, pz) {
  const pl = _findPlanetInfo();
  if (!pl) return null;
  const dx = px - pl.centerX, dy = py - pl.centerY, dz = pz - pl.centerZ;
  const r = Math.hypot(dx, dy, dz);
  if (r < 1e-6) return null;
  return [dx / r, dy / r, dz / r];
}

/* Sprint 8-8c -- JS port of the WGSL _value_noise_3d / detail_noise_
 * height pair. Used by _planetMeshSurfacePos to model the per-vertex
 * displacement vs_main applies to PlanetMesh draws, so collision and
 * walk-mode see the rendered (displaced) surface, not the smooth
 * cell-elevation surface. Without this the camera floats / sinks by
 * up to (biome amp * displacementScale) meters relative to the mesh. */
function _planetHash13(x, y, z) {
  const k = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return k - Math.floor(k);
}
function _planetValueNoise3D(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const c000 = _planetHash13(ix,     iy,     iz    );
  const c100 = _planetHash13(ix + 1, iy,     iz    );
  const c010 = _planetHash13(ix,     iy + 1, iz    );
  const c110 = _planetHash13(ix + 1, iy + 1, iz    );
  const c001 = _planetHash13(ix,     iy,     iz + 1);
  const c101 = _planetHash13(ix + 1, iy,     iz + 1);
  const c011 = _planetHash13(ix,     iy + 1, iz + 1);
  const c111 = _planetHash13(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

/* Sprint 9-5 -- value noise with analytic gradient (Iñigo Quilez's
 * `noised` recipe). Returns [value, ∂/∂x, ∂/∂y, ∂/∂z] for the same
 * cubic-smoothstepped 3D value noise. Used by Swiss and Jordan
 * turbulence (shapes 5 and 6 below) -- Carpentier's gradient-feed-
 * back trick makes mountains read as eroded instead of fractal-
 * fuzz, at ~5x the cost of plain value noise per octave. */
function _planetValueNoise3DDeriv(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const dux = 6 * fx * (1 - fx);
  const duy = 6 * fy * (1 - fy);
  const duz = 6 * fz * (1 - fz);
  const a = _planetHash13(ix,     iy,     iz    );
  const b = _planetHash13(ix + 1, iy,     iz    );
  const c = _planetHash13(ix,     iy + 1, iz    );
  const d = _planetHash13(ix + 1, iy + 1, iz    );
  const e = _planetHash13(ix,     iy,     iz + 1);
  const f = _planetHash13(ix + 1, iy,     iz + 1);
  const g = _planetHash13(ix,     iy + 1, iz + 1);
  const h = _planetHash13(ix + 1, iy + 1, iz + 1);
  const k1 = b - a;
  const k2 = c - a;
  const k3 = e - a;
  const k4 = a - b - c + d;
  const k5 = a - c - e + g;
  const k6 = a - b - e + f;
  const k7 = -a + b + c - d + e - f - g + h;
  const val = a + k1*ux + k2*uy + k3*uz
            + k4*ux*uy + k5*uy*uz + k6*uz*ux + k7*ux*uy*uz;
  const gx = dux * (k1 + k4*uy + k6*uz + k7*uy*uz);
  const gy = duy * (k2 + k5*uz + k4*ux + k7*uz*ux);
  const gz = duz * (k3 + k6*ux + k5*uy + k7*ux*uy);
  return [val, gx, gy, gz];
}

/* Sprint 9-5 -- Swiss turbulence (Carpentier 2010, "Scape" engine).
 * Ridged value noise where each next-octave amplitude is modulated
 * by the cumulative noise sum and each next-octave input position
 * is warped by the cumulative gradient. The output reads as
 * eroded alpine terrain: sharp ridges, smooth valleys, no fractal-
 * fuzz on flats. ~5x cost of plain fbm at the same octave count. */
function _planetSwissTurbulence(wx, wy, wz, baseFreq, lacunarity, roughness, warpStrength, octF) {
  const fullOct = Math.floor(octF);
  const fade = octF - fullOct;
  const totalOct = Math.min(12, fullOct + (fade > 0.001 ? 1 : 0));
  const warpK = warpStrength > 0 ? warpStrength : 0.15;
  let sum = 0, ampSum = 0;
  let freq = baseFreq, amp = 1;
  let dsumX = 0, dsumY = 0, dsumZ = 0;
  for (let k = 0; k < totalOct; k++) {
    const ox = k * 13.37, oy = k * 7.91, oz = k * 23.45;
    const px = (wx + warpK * dsumX) * freq + ox;
    const py = (wy + warpK * dsumY) * freq + oy;
    const pz = (wz + warpK * dsumZ) * freq + oz;
    const nd = _planetValueNoise3DDeriv(px, py, pz);
    const sn = nd[0] * 2 - 1;
    const ridgeV = 1 - Math.abs(sn);
    const sgn = sn >= 0 ? 1 : -1;
    const gradX = -2 * sgn * nd[1] * freq;
    const gradY = -2 * sgn * nd[2] * freq;
    const gradZ = -2 * sgn * nd[3] * freq;
    const w = (k === fullOct && fade > 0.001 && fade < 0.999) ? fade : 1;
    sum    += amp * ridgeV * w;
    ampSum += amp * w;
    dsumX  += amp * gradX * w;
    dsumY  += amp * gradY * w;
    dsumZ  += amp * gradZ * w;
    freq *= lacunarity;
    // Amplitude shrinks where the cumulative noise sum is high
    // (steep terrain dampens finer octaves -- Carpentier's
    // alpine-erosion signature).
    amp *= roughness * Math.max(0, Math.min(1, sum));
  }
  return (ampSum > 1e-6) ? (sum / ampSum) : 0;
}

/* Sprint 9-5 -- Jordan turbulence (Carpentier 2010, "Scape").
 * Squared value noise (so all positive, slight billow), with
 * separate "warp" and "damp" gradient accumulators that bend
 * finer octaves downhill (fluvial-erosion gulleys) and attenuate
 * amplitude in flats (thermal-erosion plateaus). Most heavily-
 * eroded look in Scape; produces rounded, river-carved
 * mountains. */
function _planetJordanTurbulence(wx, wy, wz, baseFreq, lacunarity, roughness, warpStrength, octF) {
  const fullOct = Math.floor(octF);
  const fade = octF - fullOct;
  const totalOct = Math.min(12, fullOct + (fade > 0.001 ? 1 : 0));
  const gain1 = 0.8;
  const warp0 = 0.4;
  const warpK = warpStrength > 0 ? warpStrength : 0.35;
  const damp0 = 1.0;
  const dampK = 0.8;
  const dampScale = 1.0;
  // Octave 0: seed both accumulators.
  const nd0 = _planetValueNoise3DDeriv(wx * baseFreq, wy * baseFreq, wz * baseFreq);
  const sn0 = nd0[0] * 2 - 1;
  let sum = sn0 * sn0;
  let ampSum = 1;
  let warpDX = warp0 * 2 * sn0 * nd0[1] * baseFreq;
  let warpDY = warp0 * 2 * sn0 * nd0[2] * baseFreq;
  let warpDZ = warp0 * 2 * sn0 * nd0[3] * baseFreq;
  let dampDX = damp0 * 2 * sn0 * nd0[1] * baseFreq;
  let dampDY = damp0 * 2 * sn0 * nd0[2] * baseFreq;
  let dampDZ = damp0 * 2 * sn0 * nd0[3] * baseFreq;
  let freq = baseFreq * lacunarity;
  let amp = gain1;
  let damped = amp * dampScale;
  for (let k = 1; k < totalOct; k++) {
    const ox = k * 13.37, oy = k * 7.91, oz = k * 23.45;
    const px = (wx * freq) + warpDX + ox;
    const py = (wy * freq) + warpDY + oy;
    const pz = (wz * freq) + warpDZ + oz;
    const nd = _planetValueNoise3DDeriv(px, py, pz);
    const sn = nd[0] * 2 - 1;
    const sq = sn * sn;
    const gx = 2 * sn * nd[1] * freq;
    const gy = 2 * sn * nd[2] * freq;
    const gz = 2 * sn * nd[3] * freq;
    const w = (k === fullOct && fade > 0.001 && fade < 0.999) ? fade : 1;
    sum    += damped * sq * w;
    ampSum += damped * w;
    warpDX += warpK * amp * gx * w;
    warpDY += warpK * amp * gy * w;
    warpDZ += warpK * amp * gz * w;
    dampDX += dampK * amp * gx * w;
    dampDY += dampK * amp * gy * w;
    dampDZ += dampK * amp * gz * w;
    freq *= lacunarity;
    amp  *= roughness;
    const dampLen = Math.sqrt(dampDX*dampDX + dampDY*dampDY + dampDZ*dampDZ);
    damped = amp * Math.max(0, 1 - Math.min(1, dampLen));
  }
  // Squared noise lives in [0, 1]; recenter to [-1, 1] so the
  // output is zero-mean displacement like other shapes.
  return (ampSum > 1e-6) ? ((sum / ampSum) * 2 - 1) : 0;
}

/* Sprint 9-6 -- anti-tiling infrastructure. Pre-baked 3D rotation
 * matrices (one per octave) that the noise loops apply per-octave
 * to break the lattice-alignment "stamp" pattern. Plus per-octave
 * lacunarity jitter (Geiss, GPU Gems 3 Ch.1): "It's important not
 * to make the frequency exactly double... the interference of two
 * overlapping, repeating signals at slightly different frequencies
 * is beneficial... it helps break up repetition." */
const _PLANET_OCTAVE_LAC_JITTER = [
  1.00, 1.04, 0.97, 1.03, 0.99, 1.05, 0.96, 1.02, 0.98, 1.04, 0.95, 1.03
];
function _planetOctaveRotMat(k) {
  // Deterministic seed per octave -> 3D rotation matrix. Picks
  // three orthogonal-ish axes and an angle from the hash; the
  // exact orientation doesn't matter so long as adjacent octaves
  // are decorrelated.
  const s = Math.sin(k * 2.71828 + 0.31) * 0.5 + 0.5;
  const t = Math.sin(k * 3.14159 + 1.57) * 0.5 + 0.5;
  const u = Math.sin(k * 1.61803 + 2.45) * 0.5 + 0.5;
  const ang = s * 6.28318;
  const ax = t * 2 - 1;
  const ay = u * 2 - 1;
  const az = Math.sqrt(Math.max(0, 1 - ax * ax - ay * ay)) * (s > 0.5 ? 1 : -1);
  const c = Math.cos(ang), si = Math.sin(ang), omc = 1 - c;
  return [
    c + ax*ax*omc,    ax*ay*omc - az*si, ax*az*omc + ay*si,
    ay*ax*omc + az*si, c + ay*ay*omc,    ay*az*omc - ax*si,
    az*ax*omc - ay*si, az*ay*omc + ax*si, c + az*az*omc
  ];
}
const _PLANET_OCTAVE_ROTS = [];
for (let k = 0; k < 12; k++) _PLANET_OCTAVE_ROTS.push(_planetOctaveRotMat(k));

/* Sprint 9-6 -- per-chunk hash offset. Translates the noise field
 * by (hash * 4096 m) per chunk so the same biome's noise pattern
 * doesn't recur identically on the other side of the planet.
 * Cheap (one hash3 call per chunk, applied as a constant offset to
 * the entire chunk's noise sampling). */
function _planetChunkNoiseOffset(face, depth, ix, iy) {
  const s = Math.sin(face * 12.9898 + depth * 78.233 + ix * 37.719 + iy * 27.181) * 43758.5453;
  const t = Math.sin(face * 4.1414 + depth * 28.331 + ix * 7.319 + iy * 17.811) * 23421.6310;
  const u = Math.sin(face * 23.231 + depth * 9.114 + ix * 47.213 + iy * 31.421) * 19073.4111;
  return [
    (s - Math.floor(s)) * 4096,
    (t - Math.floor(t)) * 4096,
    (u - Math.floor(u)) * 4096
  ];
}

function _planetDetailNoiseHeight(wx, wy, wz, biomeId, biomeOverride, maxOctaveF, chunkOffset) {
  if (biomeId < 0 || biomeId > 12) return 0;
  if (typeof PLANET_BIOME_DETAIL_DEFAULTS === "undefined") return 0;
  const def = (biomeOverride && biomeOverride[biomeId]) || PLANET_BIOME_DETAIL_DEFAULTS[biomeId];
  if (!def) return 0;
  const amplitude = def[0], baseFreq = def[1], roughness = def[2];
  const lacunarity = def[3], shape = def[4] | 0;
  if (amplitude <= 0) return 0;
  // Sprint 9-6: per-chunk hash offset (kills planet-wide
  // recurrence of the same noise pattern at the same world point).
  const ox0 = chunkOffset ? chunkOffset[0] : 0;
  const oy0 = chunkOffset ? chunkOffset[1] : 0;
  const oz0 = chunkOffset ? chunkOffset[2] : 0;
  const px = wx + ox0, py = wy + oy0, pz = wz + oz0;
  const octF = (typeof maxOctaveF === "number" && maxOctaveF > 0) ? maxOctaveF : 6;
  // Sprint 9-5: shape 5 = Swiss, shape 6 = Jordan.
  if (shape === 5) {
    return _planetSwissTurbulence(px, py, pz, baseFreq, lacunarity, roughness, def[5], octF) * amplitude;
  }
  if (shape === 6) {
    return _planetJordanTurbulence(px, py, pz, baseFreq, lacunarity, roughness, def[5], octF) * amplitude;
  }
  // Sprint 9-6 (rolled back): the Quilez double-warp wrapper here
  // used `warp1 = 4 / baseFreq` ≈ 4 km in world units. At foot-
  // level chunks with ~10 m vertex spacing, adjacent vertices
  // ended up sampling noise positions 4 km apart -- uncorrelated
  // output, terrain reads as high-frequency speckle. Quilez's
  // recipe is meant for noise-SPACE coordinates (where wavelength
  // = 1); my translation to world meters was wrong. Dropped here
  // pending the Phase 10 redesign, which puts noise on top of a
  // tectonics+erosion base and warps differently. Per-octave
  // rotation + lacunarity jitter (below) and per-chunk hash
  // offset (above) stay -- they work correctly.
  const fullOctaves = Math.floor(octF);
  const fade = octF - fullOctaves;
  const totalOct = Math.min(12, fullOctaves + (fade > 0.001 ? 1 : 0));
  let sum = 0, ampSum = 0, freq = baseFreq, amp = 1;
  for (let kk = 0; kk < totalOct; kk++) {
    // Sprint 9-6: per-octave rotation + lacunarity jitter to
    // decorrelate the octave lattice peaks (Geiss GPU Gems 3 +
    // Quilez fbm article).
    const R = _PLANET_OCTAVE_ROTS[kk];
    const rrx = R[0]*px + R[1]*py + R[2]*pz;
    const rry = R[3]*px + R[4]*py + R[5]*pz;
    const rrz = R[6]*px + R[7]*py + R[8]*pz;
    const oxk = kk * 13.37, oyk = kk * 7.91, ozk = kk * 23.45;
    let n = _planetValueNoise3D(rrx * freq + oxk, rry * freq + oyk, rrz * freq + ozk) * 2 - 1;
    if (shape === 1 || shape === 3) { const r = 1 - Math.abs(n); n = r * r; }
    else if (shape === 2) { n = Math.abs(n); }
    else if (shape === 4) { const r = 1 - Math.abs(n); n = -r * r; }
    const w = (kk === fullOctaves && fade > 0.001 && fade < 0.999) ? fade : 1;
    sum    += amp * n * w;
    ampSum += amp * w;
    freq   *= lacunarity * _PLANET_OCTAVE_LAC_JITTER[kk];
    amp    *= roughness;
  }
  if (ampSum < 1e-6) return 0;
  return (sum / ampSum) * amplitude;
}

/* Sprint 8-8 -- given a world-space position (wx, wy, wz), find the
 * planet-surface point directly beneath it (along the planet-radial)
 * with full PlanetMesh fidelity: polRatio-corrected unit-sphere
 * direction, PlanetMap cell lookup for elevation, the same
 * (R + alt, R*pr + alt, R + alt) vertex formula _buildPlanetMesh
 * uses, AND the per-vertex detail-noise displacement vs_main applies
 * along world radial (sprint 8-8c -- without this the rendered mesh
 * sat up to amp*displacementScale meters above the cell-level surface
 * and the camera ended up under the terrain on landing).
 * Returns { x, y, z, altitude, biomeId, cellIdx } or null when no
 * planet is wired or its PlanetMap hasn't built cells yet.
 *
 * AGL = |cam - planet_center| - |surfacePos - planet_center|. */
function _planetMeshSurfacePos(wx, wy, wz, pl) {
  if (!pl) return null;
  const cx = pl.centerX, cy = pl.centerY, cz = pl.centerZ;
  const R = pl.radius, pr = pl.polRatio || 1;
  const dx = wx - cx, dy = wy - cy, dz = wz - cz;
  const dyU = (pr > 0) ? (dy / pr) : dy;
  const len = Math.hypot(dx, dyU, dz);
  if (len < 1e-9) return null;
  const ux = dx / len, uy = dyU / len, uz = dz / len;
  let alt = 0, biomeId = -1, cellIdx = -1;
  const pmap = pl.mapNode;
  if (pmap) {
    // Sprint 10-1d: sample the SAME cubemap the chunk builder
    // samples (instead of nearest-cell raw elevation). Now the
    // collision surface tracks the rendered macro elevation
    // exactly -- no more "camera walks on a smoother floor than
    // the visible mesh" or vice-versa. Biome ID still comes from
    // nearest-cell (categorical, no point blending).
    // Sprint 10-5b-fix v3: outer guard relaxed from `_cells &&
    // _cellsHash` to just `pmap`. Earth mode skips cells entirely
    // (10-5a-fix v4), so the old guard short-circuited and left
    // alt=0 -- collision saw a sea-level sphere everywhere, camera
    // flew through mountains, walk-mode never auto-engaged on
    // surface contact, AGL went to -6 km on Himalayan peaks.
    // Cells-dependent biome lookup is now individually guarded.
    if (pmap._cells && pmap._cellsHash) {
      cellIdx = _findNearestCell(pmap._cells, pmap._cellsHash, ux, uy, uz);
      if (cellIdx >= 0 && pmap._cells.biome) biomeId = pmap._cells.biome[cellIdx];
    }
    const cubemap = (typeof _ensurePlanetMapCubemap === "function") ? _ensurePlanetMapCubemap(pmap) : null;
    // Sprint 10-6: collision uses best-cached high-res tile so walking
    // and flying-near-surface track the actual rendered geometry
    // (which uses the same sampler in the chunk builder). Falls back
    // to macro cubemap when no high-res tile is loaded for this dir.
    const e = cubemap
      ? _planetSampleElevationCached(cubemap, ux, uy, uz)
      : ((cellIdx >= 0) ? pmap._cells.elevations[cellIdx] : 0);
    if (e > pl.seaLevel && pl.heightScale > 0) {
      alt = pl.heightScale * (e - pl.seaLevel) / Math.max(1e-6, 1 - pl.seaLevel);
    }
  }
  // Cell-base vertex position (matches _buildPlanetMesh).
  const baseX = cx + ux * (R + alt);
  const baseY = cy + uy * (R * pr + alt);
  const baseZ = cz + uz * (R + alt);
  // Sprint 10-1d: per-vertex detail-noise displacement removed
  // along with the rendering-path noise. Collision now tracks the
  // cubemap-baked macro elevation exactly. When 10-4 brings noise
  // back as gated amplification, this helper will need a matching
  // amplification path so collision and rendering stay in sync.
  return {
    x: baseX,
    y: baseY,
    z: baseZ,
    altitude: alt,
    biomeId: biomeId,
    cellIdx: cellIdx
  };
}

/* Sprint 8-8 -- Above Ground Level for the given world position.
 * Negative = below surface (inside planet mesh -- never expected for
 * the camera once collision is active). Returns null if no planet. */
function _planetMeshAGL(wx, wy, wz, pl) {
  pl = pl || _findPlanetInfo();
  if (!pl) return null;
  const surf = _planetMeshSurfacePos(wx, wy, wz, pl);
  if (!surf) return null;
  const cdx = wx - pl.centerX, cdy = wy - pl.centerY, cdz = wz - pl.centerZ;
  const sdx = surf.x - pl.centerX, sdy = surf.y - pl.centerY, sdz = surf.z - pl.centerZ;
  return Math.hypot(cdx, cdy, cdz) - Math.hypot(sdx, sdy, sdz);
}

/* Per-frame tick for FPCamera nodes. Walk mode keeps the older
 * yaw+pitch Euler controls and locks posY to terrain + eyeHeight.
 * Flight mode uses true 6DoF: forward + up basis vectors stored
 * on the node (upX/Y/Z) + derived right, rotated incrementally
 * by I/K (pitch), J/L (yaw), U/O (roll). Space/C move along the
 * planet-radial direction when a planet is in the patch, falling
 * back to world Y otherwise. */
/* Sprint platformer-1 -- lazy game-input keyboard wiring. Separate
 * from FPCamera input (which is gated on an FPCamera being in the
 * patch) so 2D platformer-style patches don't require an FPCamera
 * to sample keys. Listens at document level + capture phase, but
 * declines to claim keys while the user is typing in a form input
 * so the keyboard piano + text fields keep working. */
function _wireGameInput() {
  if (!Visual.gameInput) {
    Visual.gameInput = {
      keys: new Set(),       // currently-held key codes (KeyboardEvent.code)
      pressed: new Set(),    // codes pressed THIS frame (cleared each tick)
      released: new Set()    // codes released THIS frame (cleared each tick)
    };
  }
  if (Visual.gameInputWired) return;
  Visual.gameInputWired = true;
  const isTypingInForm = () => {
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = ae.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable;
  };
  // Known game keys that should NOT trigger browser default behavior
  // (Space = page scroll, Arrow keys = scroll, etc.) when game input
  // nodes are active. WASD doesn't have browser default behavior so
  // no need to list it, but listing for completeness.
  const GAME_KEYS = new Set([
    "Space",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "KeyW", "KeyA", "KeyS", "KeyD",
    "KeyZ", "KeyX", "KeyC",
    "KeyJ", "KeyK", "KeyL"
  ]);
  document.addEventListener("keydown", (e) => {
    if (isTypingInForm()) return;
    if (e.repeat) return; // suppress auto-repeat -- only the first press counts as "pressed"
    if (!Visual.gameInput.keys.has(e.code)) {
      Visual.gameInput.pressed.add(e.code);
    }
    Visual.gameInput.keys.add(e.code);
    if (GAME_KEYS.has(e.code)) e.preventDefault();
  }, true);
  document.addEventListener("keyup", (e) => {
    if (Visual.gameInput.keys.has(e.code)) {
      Visual.gameInput.released.add(e.code);
    }
    Visual.gameInput.keys.delete(e.code);
    if (GAME_KEYS.has(e.code) && !isTypingInForm()) e.preventDefault();
  }, true);
}

/* Sprint platformer-1 -- per-frame tick for KeyAxis2D + PlatformerBody2D.
 * Runs alongside _tickFPCameras in the visual frame loop. Pressed /
 * released sets get cleared at the END of each tick so multiple
 * downstream nodes in the same frame can read the same edge events. */
/* ── Phase 8.A.1 + 8.A.2: lifecycle + stage scheduler ─────────────
 *
 * Drives the OnAwake / OnStart / OnUpdate / OnDestroy nodes, with
 * per-stage phase tracking from 8.A.2.
 *
 * Visual.lifecyclePhases is a map: stageName -> phase. The reserved
 * stage "_global" is the catch-all for lifecycle nodes that don't
 * have a stage tag (node.stage === null) -- they fire on patch load
 * and persist across stage transitions.
 *
 * Per-stage state transitions:
 *   "uninitialized" -> "awoken"   (OnAwake fires this tick)
 *   "awoken"        -> "running"  (OnStart  fires this tick)
 *   "running"       -> "running"  (OnUpdate fires every tick)
 *   "destroying"    -> "dormant"  (OnDestroy fires this tick; the
 *                                   stage sleeps until a StageManager
 *                                   switches BACK to it, at which
 *                                   point _tickStageManager flips it
 *                                   to "uninitialized" again)
 *   "dormant"       -> "dormant"  (no events; stage is loaded but
 *                                   inactive)
 *
 * _global stage uses uninitialized -> awoken -> running -> running
 * forever (no dormant). resetStage("_global") sets it to destroying,
 * which auto-cycles back to uninitialized for full restart.
 *
 * For stage-tagged nodes the cycle is driven by StageManager.active
 * changes; transitions are detected in _tickStageManager which runs
 * BEFORE _tickLifecycleNodes each frame.
 *
 * Trigger values are written into node.params[port] so
 * _readWireJsSideValue can substitute them into any downstream
 * param input. Outs are typed t:"param" specifically to ride the
 * existing wire-resolution path. */

/* _tickStageManager: detect active-stage changes on every
 * StageManager node, set up the phase transitions. Runs FIRST in
 * the visual tick (before _tickLifecycleNodes) so the lifecycle
 * scheduler sees the new phases this same frame. */
function _tickStageManager() {
  if (!state || !Array.isArray(state.nodes)) return;
  Visual.lifecyclePhases = Visual.lifecyclePhases || {};
  let firstMgr = true;
  for (const mgr of state.nodes) {
    if (!mgr || mgr.type !== "StageManager") continue;
    const p = mgr.params = mgr.params || {};
    const stagesStr = (typeof p.stages === "string") ? p.stages : "";
    const stages = stagesStr.split(",").map(s => s.trim()).filter(s => s);
    if (stages.length === 0) {
      p.current = 0; p.transitioning = 0;
      continue;
    }
    const resolved = _resolveNodeParams(mgr);
    let req = Math.floor((typeof resolved.active === "number") ? resolved.active : 0);
    if (!Number.isFinite(req)) req = 0;
    req = Math.max(0, Math.min(stages.length - 1, req));
    const nextStage = stages[req];
    const prevStage = p._prevActive;
    if (prevStage !== undefined && prevStage !== nextStage) {
      // Transition: old stage destroyed, new stage uninitialized.
      Visual.lifecyclePhases[prevStage] = "destroying";
      Visual.lifecyclePhases[nextStage] = "uninitialized";
      p.transitioning = 1;
      p.transitionCount = (p.transitionCount || 0) + 1;
      if (firstMgr) {
        console.log("[stage] transition: " + prevStage + " -> " + nextStage);
      }
    } else {
      p.transitioning = 0;
      // First-time setup OR stuck-on-same-stage: make sure the
      // stage has a phase entry (uninitialized so it'll Awake).
      if (!(nextStage in Visual.lifecyclePhases)) {
        Visual.lifecyclePhases[nextStage] = "uninitialized";
      }
    }
    p._prevActive = nextStage;
    p.current = req;
    // R.3: per-stage active outputs (active0..active3)
    for (let si = 0; si < 4; si++) p["active" + si] = (si === req) ? 1 : 0;
    // Pre-register all defined stages as dormant so transitions
    // can target them later without losing state.
    for (const s of stages) {
      if (!(s in Visual.lifecyclePhases)) Visual.lifecyclePhases[s] = "dormant";
    }
    firstMgr = false;
  }
  // Ensure _global is tracked (for untagged lifecycle nodes).
  if (!("_global" in Visual.lifecyclePhases)) {
    Visual.lifecyclePhases._global = "uninitialized";
  }
}

function _tickLifecycleNodes(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  // 8.A.2 fix: this function has TWO jobs -- advance phase state
  // (running once StageManager has registered any phases) AND write
  // trigger params to lifecycle nodes (only if any exist). The
  // earlier "no lifecycle nodes -> bail" check skipped phase
  // advancement, so a Stage Cycle demo with NO On{Awake,...} nodes
  // would never tick title from "uninitialized" -> "awoken" and
  // every stage stayed inactive forever.
  //
  // Now: run if either (a) there are lifecycle nodes, OR (b) any
  // stage phase has been registered (which happens as soon as a
  // StageManager ticks). Pre-8.A patches with neither still skip
  // the whole function for the zero-cost fast path.
  let hasLifecycleNodes = false;
  for (const n of state.nodes) {
    if (n && (n.type === "OnAwake" || n.type === "OnStart" ||
              n.type === "OnUpdate" || n.type === "OnDestroy")) {
      hasLifecycleNodes = true; break;
    }
  }
  const hasPhases = Visual.lifecyclePhases &&
    Object.keys(Visual.lifecyclePhases).length > 0;
  if (!hasLifecycleNodes && !hasPhases) return;
  Visual.lifecyclePhases = Visual.lifecyclePhases || {};
  Visual.lifecycleElapsedMap = Visual.lifecycleElapsedMap || {};
  if (!("_global" in Visual.lifecyclePhases)) Visual.lifecyclePhases._global = "uninitialized";
  // Clamp dt the same way _tickGameInputs does.
  const dt = (!(dtSec > 0) || dtSec > 0.034) ? 0.034 : dtSec;
  // Advance each known stage's phase.
  const phaseUpdates = {};
  for (const stageName of Object.keys(Visual.lifecyclePhases)) {
    let phase = Visual.lifecyclePhases[stageName];
    const triggers = { OnAwake: 0, OnStart: 0, OnUpdate: 0, OnDestroy: 0 };
    let logEvent = null;
    if (phase === "uninitialized") {
      triggers.OnAwake = 1; phase = "awoken"; logEvent = "OnAwake";
    } else if (phase === "awoken") {
      triggers.OnStart = 1; phase = "running"; logEvent = "OnStart";
    } else if (phase === "running") {
      triggers.OnUpdate = 1;
    } else if (phase === "destroying") {
      triggers.OnDestroy = 1;
      // _global cycles back to uninitialized for full restart.
      // Named stages go dormant; they wait for a StageManager to
      // flip them back to uninitialized on a future activation.
      phase = (stageName === "_global") ? "uninitialized" : "dormant";
      logEvent = "OnDestroy";
    }
    // "dormant" stays dormant -- no events.
    Visual.lifecyclePhases[stageName] = phase;
    phaseUpdates[stageName] = triggers;
    if (logEvent) console.log("[lifecycle:" + stageName + "] " + logEvent + " fired (phase -> " + phase + ")");
    // Accumulate per-stage elapsed time.
    if (triggers.OnAwake) Visual.lifecycleElapsedMap[stageName] = 0;
    if (triggers.OnUpdate) {
      Visual.lifecycleElapsedMap[stageName] = (Visual.lifecycleElapsedMap[stageName] || 0) + dt;
    }
  }
  // Write triggers into lifecycle nodes by their stage tag.
  for (const node of state.nodes) {
    if (!node) continue;
    if (node.type !== "OnAwake" && node.type !== "OnStart" &&
        node.type !== "OnUpdate" && node.type !== "OnDestroy") continue;
    const stageName = (typeof node.stage === "string" && node.stage) ? node.stage : "_global";
    const triggers = phaseUpdates[stageName];
    if (!triggers) {
      // Lifecycle node tagged to a stage that no StageManager knows
      // about. Treat as dormant -- write 0 to trigger so HUDs read
      // sensibly, but don't increment counters.
      node.params = node.params || {};
      node.params.trigger = 0;
      continue;
    }
    node.params = node.params || {};
    const newTrig = triggers[node.type];
    const prevTrig = node.params.trigger || 0;
    node.params.trigger = newTrig;
    if (node.type === "OnUpdate") {
      if (newTrig) {
        node.params.fireCount = (node.params.fireCount || 0) + 1;
        node.params.dt = dt;
        node.params.elapsed = Visual.lifecycleElapsedMap[stageName] || 0;
      }
    } else {
      if (newTrig && !prevTrig) {
        node.params.fireCount = (node.params.fireCount || 0) + 1;
      }
    }
    // Reset OnUpdate's per-life counters on each Awake of its stage.
    if (triggers.OnAwake && node.type === "OnUpdate") {
      node.params.fireCount = 0;
      node.params.elapsed = 0;
    }
  }
}

/* ── Phase 8.A.2-filtering: per-stage active check ────────────────
 *
 * A stage is "active" iff its lifecycle phase is "running" or
 * "awoken" (the two states where OnUpdate fires or OnStart is about
 * to fire). Anything else (dormant, destroying, uninitialized) is
 * inactive -- gameplay ticks + mesh emission skip nodes tagged to
 * an inactive stage.
 *
 * Untagged nodes (node.stage == null) follow the _global stage,
 * which auto-cycles uninitialized -> awoken -> running and stays
 * running unless resetScene() is called. So untagged nodes are
 * "active" within a frame or two of patch load and stay active
 * forever -- the persistent / always-on bucket.
 *
 * Permissive fallback: if Visual.lifecyclePhases isn't yet
 * initialized (very early-frame call), treat every node as active
 * so the editor doesn't ghost-render before the first tick. */
function _isStageActive(stageName) {
  if (!stageName) return true;
  const phases = (typeof Visual !== "undefined") ? Visual.lifecyclePhases : null;
  if (!phases) return true;
  const phase = phases[stageName];
  return phase === "running" || phase === "awoken";
}

function _isNodeActive(node) {
  if (!node) return false;
  return _isStageActive(node.stage);
}

/* Request a stage reset on the NEXT tick. Lifecycle scheduler fires
 * OnDestroy that tick, then (for _global) OnAwake the tick after,
 * then OnStart, then OnUpdate cycle resumes. Named stages go
 * dormant after OnDestroy and wait for a StageManager to reactivate
 * them.
 *
 * Public alias on `window` so UIButton.onclick handlers + keyboard
 * shortcuts can call this without needing a Reset node wired up. */
function _resetStage(stageName) {
  Visual.lifecyclePhases = Visual.lifecyclePhases || {};
  const target = (typeof stageName === "string" && stageName) ? stageName : "_global";
  if (!(target in Visual.lifecyclePhases)) {
    console.warn("[stage] reset: unknown stage '" + target + "' (known: " +
      Object.keys(Visual.lifecyclePhases).join(", ") + ")");
    return;
  }
  Visual.lifecyclePhases[target] = "destroying";
  console.log("[lifecycle:" + target + "] reset requested -- OnDestroy fires next tick");
}
if (typeof window !== "undefined") {
  window.resetStage = _resetStage;
  // Back-compat with 8.A.1's resetScene() entry point.
  window.resetScene = () => _resetStage("_global");
}

/* ── Phase 8.A.3 -- prefab expansion + override sync ──────────────
 *
 * A PrefabInstance carries its template as JSON in
 * params.templateInline. On first call to _expandPrefabInstance we
 * spawn each template node + edge into state.nodes / state.edges
 * with rewritten IDs (prefixed by the instance.id) and a
 * prefabParentId tag linking back. Children render + tick normally;
 * the canvas just hides them via a render() filter. Exposed params
 * + ports are resolved against the template's prefabMeta and stored
 * on the instance for tick/wire-resolver use.
 *
 * Idempotent on patch reload: if children already exist in
 * state.nodes (from a previous save), expansion skips creation and
 * just rebuilds the transient _exposedParams / _exposedPorts caches
 * from the saved children + the template's prefabMeta. */
function _expandPrefabInstance(instanceNode) {
  if (!instanceNode || instanceNode.type !== "PrefabInstance") return;
  if (instanceNode._expanded) return;
  let template = null;
  // §8.A.6 -- prefer IDB asset reference over inline JSON. When the
  // user sets templateAssetId, we read the latest version from IDB
  // every (re-)expansion -- so edits to the prefab asset propagate
  // to live instances automatically on the next tick.
  const assetId = (typeof instanceNode.params.templateAssetId === "string" && instanceNode.params.templateAssetId.length)
    ? instanceNode.params.templateAssetId : "";
  if (assetId && typeof Assets !== "undefined" && Assets.get) {
    const asset = Assets.get(assetId);
    if (asset && asset.assetType === "prefab") {
      template = {
        nodes: Array.isArray(asset.nodes) ? asset.nodes : [],
        edges: Array.isArray(asset.edges) ? asset.edges : [],
        prefabMeta: asset.prefabMeta || {}
      };
      // Update templateName for display if the asset's name moved.
      if (typeof asset.name === "string") instanceNode.params.templateName = asset.name;
    } else if (!instanceNode._assetMissLogged) {
      instanceNode._assetMissLogged = true;
      console.warn("[prefab " + instanceNode.id + "] templateAssetId='" + assetId + "' not found in Assets; falling back to templateInline");
    }
  }
  if (!template) {
    try {
      template = JSON.parse(instanceNode.params.templateInline || "null");
    } catch (e) {
      if (!instanceNode._tplParseLogged) {
        instanceNode._tplParseLogged = true;
        console.warn("[prefab " + instanceNode.id + "] templateInline parse failed: " + e.message);
      }
      return;
    }
  }
  if (!template || !Array.isArray(template.nodes) || !Array.isArray(template.edges)) {
    return;
  }
  const meta = (template.prefabMeta && typeof template.prefabMeta === "object") ? template.prefabMeta : {};
  const exposedParamsSpec = Array.isArray(meta.exposedParams) ? meta.exposedParams : [];
  const exposedPortsSpec  = Array.isArray(meta.exposedPorts)  ? meta.exposedPorts  : [];

  // Are children already in state.nodes (post-load case)?
  const existingChildren = state.nodes.filter(n => n && n.prefabParentId === instanceNode.id);
  const idMap = {};
  if (existingChildren.length > 0) {
    // Re-build idMap from existing children. Suffix convention:
    // child.id == instance.id + ":" + tn.id
    for (const tn of template.nodes) {
      const expectedId = instanceNode.id + ":" + tn.id;
      if (existingChildren.find(c => c.id === expectedId)) idMap[tn.id] = expectedId;
    }
  } else {
    // Fresh expansion: spawn nodes + edges.
    for (const tn of template.nodes) {
      const newId = instanceNode.id + ":" + tn.id;
      idMap[tn.id] = newId;
      const child = {
        id: newId,
        type: tn.type,
        params: Object.assign({}, tn.params || {}),
        x: instanceNode.x + 60,
        y: instanceNode.y + 60,
        prefabParentId: instanceNode.id
      };
      // Preserve any tags from the template (e.g. stage tag).
      if (typeof tn.stage === "string" && tn.stage) child.stage = tn.stage;
      state.nodes.push(child);
    }
    for (const te of template.edges) {
      if (!te || !te.from || !te.to) continue;
      const f = idMap[te.from.node];
      const t = idMap[te.to.node];
      if (!f || !t) continue;
      state.edges.push({
        from: { node: f, port: te.from.port },
        to:   { node: t, port: te.to.port   },
        prefabParentId: instanceNode.id
      });
    }
  }

  // Build transient lookup tables.
  instanceNode._exposedParams = exposedParamsSpec.map(p => {
    const childId = idMap[p.nodeId];
    if (!childId) return null;
    const tn = template.nodes.find(n => n.id === p.nodeId);
    const defaultValue = (tn && tn.params) ? tn.params[p.paramName] : undefined;
    return { label: p.label, childId, paramName: p.paramName, defaultValue };
  }).filter(Boolean);
  instanceNode._exposedPorts = exposedPortsSpec.map(p => {
    const childId = idMap[p.nodeId];
    if (!childId) return null;
    return {
      label: p.label, childId,
      portName: p.portName,
      direction: (p.direction === "in") ? "in" : "out"
    };
  }).filter(Boolean);

  // Seed instance.params with each exposed param's default if not
  // already overridden (so first-render shows template defaults +
  // the props panel has fields to edit).
  for (const ep of instanceNode._exposedParams) {
    if (!(ep.label in instanceNode.params)) {
      instanceNode.params[ep.label] = ep.defaultValue;
    }
  }

  instanceNode._expanded = true;
  instanceNode._childIds = Object.values(idMap);
}

/* Sync exposed-param overrides from instance to children every
 * frame. Runs before gameplay ticks so the children see the
 * overridden values when they tick. Also auto-expands any
 * PrefabInstance that hasn't been expanded yet (covers fresh
 * makeNode() calls + .gpatch load with new instances). */
function _tickPrefabInstances() {
  if (!state || !Array.isArray(state.nodes)) return;
  for (const node of state.nodes) {
    if (!node || node.type !== "PrefabInstance") continue;
    if (!node._expanded) _expandPrefabInstance(node);
    if (!node._exposedParams) continue;
    for (const ep of node._exposedParams) {
      if (!(ep.label in node.params)) continue;
      const v = node.params[ep.label];
      const child = state.nodes.find(n => n && n.id === ep.childId);
      if (!child) continue;
      child.params = child.params || {};
      if (child.params[ep.paramName] !== v) child.params[ep.paramName] = v;
    }
  }
}

/* Given a wire's from-endpoint, return the ACTUAL (childNodeId,
 * portName) it should resolve to -- redirecting through any
 * PrefabInstance exposed-port mapping. Mesh / wire resolvers call
 * this to transparently pierce the instance abstraction.
 *
 * Returns null if the wire's from-node isn't a PrefabInstance or
 * the port doesn't match any exposed-out -- caller falls back to
 * the standard from-endpoint resolution. */
function _prefabResolveFromEndpoint(wire) {
  if (!wire || !wire.from) return null;
  const fromN = state.nodes.find(n => n && n.id === wire.from.node);
  if (!fromN || fromN.type !== "PrefabInstance") return null;
  const exposed = (fromN._exposedPorts || []).find(p =>
    p.label === wire.from.port && p.direction === "out");
  if (!exposed) return null;
  return { node: exposed.childId, port: exposed.portName };
}

/* §8.A.6 -- when a prefab asset is updated in IDB (Assets.put),
 * invalidate every PrefabInstance + Pool that references it. They
 * drop their existing children + flip _expanded to false; the next
 * tick re-expands from the freshly-loaded template. Any override
 * values still sit in instance.params so the new children get them
 * seeded automatically -- so a "tweak template + save" workflow
 * propagates live to all instances without losing per-instance
 * tweaks. */
function _invalidatePrefabRefs(assetId) {
  if (!state || !Array.isArray(state.nodes)) return;
  let refCount = 0;
  // Mark targets first (don't mutate state.nodes while iterating).
  const targets = [];
  for (const n of state.nodes) {
    if (!n) continue;
    if (n.type === "PrefabInstance" && n.params && n.params.templateAssetId === assetId) {
      targets.push(n);
    }
    // Pool template references: 8.A.6 future extension stores
    // templateAssetId on Pool too. Same invalidation path.
    if (n.type === "Pool" && n.params && n.params.templateAssetId === assetId) {
      targets.push(n);
    }
  }
  for (const inst of targets) {
    // Remove children + child-internal edges.
    const childIds = new Set(state.nodes
      .filter(n => n && (n.prefabParentId === inst.id || n.poolParentId === inst.id))
      .map(n => n.id));
    if (childIds.size > 0) {
      state.nodes = state.nodes.filter(n => !n || !childIds.has(n.id));
      state.edges = state.edges.filter(e => !e || (!childIds.has(e.from && e.from.node) && !childIds.has(e.to && e.to.node)));
    }
    // Reset expansion flags so _tickPrefabInstances / _tickPools
    // re-expand from the new template.
    inst._expanded = false;
    inst._voicesExpanded = false;
    inst._voices = null;
    inst._exposedParams = null;
    inst._exposedPorts = null;
    inst._childIds = null;
    refCount++;
  }
  if (refCount > 0) {
    console.log("[prefab-asset] '" + assetId + "' updated -> re-expanding " + refCount + " live instance(s)");
    if (typeof render === "function") render();
  }
}

/* ── Phase 8.A.5 -- Pool runtime (Wwise-style voice pool) ─────────
 *
 * On first tick, _expandPool spawns maxVoices copies of the prefab's
 * template into state.nodes. Each voice carries a stable poolParentId
 * + voiceIdx tag and starts inactive (no mesh emitted, no audio).
 *
 * _tickPools watches each Pool's `spawn` input for rising edges; on
 * each 0->1 transition, it picks the next available voice (first
 * inactive, else steal oldest active), sets active=true, spawnTime=0,
 * and writes spawn-time x/y/z values into the voice's exposed-params
 * matching those labels.
 *
 * Per-frame: tick each active voice's lifetime, deactivate when
 * elapsed >= voiceLifetime.
 *
 * Mesh emission: _resolveSceneMeshes detects Pool wires and calls
 * _expandPoolVoices, which produces one mesh entry per ACTIVE voice
 * by walking from the voice's exposed-mesh child node. */
/* ── Phase 8.I.1 -- StateMachine runtime ──────────────────────────
 *
 * Per-frame scheduler that watches each StateMachine's transition
 * gate inputs for rising edges. Each transition entry { from, to }
 * binds to the same-indexed transN input. On rising edge of transN
 * AND current === transitions[N].from, the FSM advances to .to,
 * fires `enter` + `transitioning` gates for one tick, and updates
 * previousState + transitionCount.
 *
 * Order: runs FIRST in the visual tick chain (before _tickStageManager
 * and _tickLifecycleNodes) so a wire from StateMachine.current to
 * StageManager.active propagates within the same frame -- a single
 * Space press can advance state + trigger the stage swap + fire
 * OnDestroy on the old stage all in one tick. */
function _tickStateMachines(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  let anySm = false;
  for (const n of state.nodes) {
    if (n && n.type === "StateMachine") { anySm = true; break; }
  }
  if (!anySm) return;
  for (const node of state.nodes) {
    if (!node || node.type !== "StateMachine") continue;
    const p = node.params = node.params || {};
    // Cache parsed transitions list keyed by raw string.
    const rawTrans = (typeof p.transitions === "string") ? p.transitions : "[]";
    if (node._sm_transRaw !== rawTrans) {
      try {
        const parsed = JSON.parse(rawTrans);
        node._sm_trans = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        if (!node._sm_parseLogged) {
          node._sm_parseLogged = true;
          console.warn("[fsm " + node.id + "] transitions JSON parse failed: " + e.message);
        }
        node._sm_trans = [];
      }
      node._sm_transRaw = rawTrans;
    }
    // First-tick init.
    if (typeof p.current !== "number" || !Number.isFinite(p.current)) {
      p.current = (typeof p.initialState === "number") ? p.initialState : 0;
    }
    if (typeof p.previousState !== "number") p.previousState = p.current;
    const resolved = _resolveNodeParams(node);
    if (!node._sm_transPrev) node._sm_transPrev = new Array(8).fill(false);
    // Reset overrides everything else.
    const resetNow = (resolved.reset || 0) >= 0.5;
    let fired = false;
    if (resetNow && !node._sm_resetPrev) {
      const init = (typeof p.initialState === "number") ? p.initialState : 0;
      if (init !== p.current) {
        _smCommitTransition(node, init);
        fired = true;
      }
    }
    node._sm_resetPrev = resetNow;
    // Check transition inputs.
    for (let i = 0; i < 8; i++) {
      const cur = (resolved["trans" + i] || 0) >= 0.5;
      const prev = node._sm_transPrev[i];
      if (cur && !prev && !fired) {
        const t = node._sm_trans[i];
        if (t && typeof t.from === "number" && typeof t.to === "number" && t.from === p.current) {
          _smCommitTransition(node, t.to);
          fired = true;
        }
      }
      node._sm_transPrev[i] = cur;
    }
    if (!fired) {
      // Clear single-frame pulses if no transition this tick.
      p.enter = 0;
      p.transitioning = 0;
    }
  }
}

function _smCommitTransition(node, newState) {
  const p = node.params;
  p.previousState = p.current;
  p.current = newState;
  p.enter = 1;
  p.transitioning = 1;
  p.transitionCount = (p.transitionCount || 0) + 1;
  console.log("[fsm " + node.id + "] state " + p.previousState + " -> " + newState +
    " (#" + p.transitionCount + ")");
}

function _expandPool(poolNode) {
  if (!poolNode || poolNode.type !== "Pool") return;
  if (poolNode._voicesExpanded) return;
  let template = null;
  try {
    template = JSON.parse(poolNode.params.templateInline || "null");
  } catch (e) {
    if (!poolNode._tplParseLogged) {
      poolNode._tplParseLogged = true;
      console.warn("[pool " + poolNode.id + "] templateInline parse failed: " + e.message);
    }
    return;
  }
  if (!template || !Array.isArray(template.nodes) || !Array.isArray(template.edges)) return;
  const maxVoices = Math.max(1, Math.min(64,
    (typeof poolNode.params.maxVoices === "number") ? Math.floor(poolNode.params.maxVoices) : 8));
  const meta = (template.prefabMeta && typeof template.prefabMeta === "object") ? template.prefabMeta : {};
  const exposedParamsSpec = Array.isArray(meta.exposedParams) ? meta.exposedParams : [];
  const exposedPortsSpec  = Array.isArray(meta.exposedPorts)  ? meta.exposedPorts  : [];
  const meshOutSpec = exposedPortsSpec.find(p => p.direction === "out" && p.label === "mesh");

  // Check if voices already exist in state.nodes (post-load case).
  // We identify them by poolParentId === poolNode.id + a stable id
  // convention: <pool.id>:v<voiceIdx>:<templateNodeId>.
  const existingChildren = state.nodes.filter(n => n && n.poolParentId === poolNode.id);
  const voices = [];
  for (let v = 0; v < maxVoices; v++) {
    const voice = {
      idx: v,
      active: false,
      spawnTime: 0,
      exposedParams: [],
      exposedMeshChildId: null
    };
    const idMap = {};
    let anyExisting = false;
    if (existingChildren.length > 0) {
      for (const tn of template.nodes) {
        const expectedId = poolNode.id + ":v" + v + ":" + tn.id;
        if (existingChildren.find(c => c.id === expectedId)) {
          idMap[tn.id] = expectedId;
          anyExisting = true;
        }
      }
    }
    if (!anyExisting) {
      for (const tn of template.nodes) {
        const newId = poolNode.id + ":v" + v + ":" + tn.id;
        idMap[tn.id] = newId;
        const child = {
          id: newId,
          type: tn.type,
          params: Object.assign({}, tn.params || {}),
          x: poolNode.x + 60,
          y: poolNode.y + 60,
          poolParentId: poolNode.id,
          voiceIdx: v
        };
        if (typeof tn.stage === "string" && tn.stage) child.stage = tn.stage;
        state.nodes.push(child);
      }
      for (const te of template.edges) {
        if (!te || !te.from || !te.to) continue;
        const f = idMap[te.from.node];
        const t = idMap[te.to.node];
        if (!f || !t) continue;
        state.edges.push({
          from: { node: f, port: te.from.port },
          to:   { node: t, port: te.to.port   },
          poolParentId: poolNode.id
        });
      }
    }
    voice.exposedParams = exposedParamsSpec.map(p => {
      const childId = idMap[p.nodeId];
      if (!childId) return null;
      return { label: p.label, childId, paramName: p.paramName };
    }).filter(Boolean);
    if (meshOutSpec) voice.exposedMeshChildId = idMap[meshOutSpec.nodeId];
    voices.push(voice);
  }
  poolNode._voices = voices;
  poolNode._voicesExpanded = true;
  console.log("[pool " + poolNode.id + "] expanded " + voices.length + " voices from '" +
    (template.patchName || "?") + "' template (" + (template.nodes.length) + " nodes × " + voices.length + ")");
}

function _poolSpawnNext(poolNode, params) {
  if (!poolNode._voices || poolNode._voices.length === 0) return;
  // Allocation: prefer inactive; else steal the longest-running active.
  let target = null;
  for (const v of poolNode._voices) {
    if (!v.active) { target = v; break; }
  }
  if (!target) {
    let oldestAge = -1;
    for (const v of poolNode._voices) {
      if (v.spawnTime > oldestAge) { oldestAge = v.spawnTime; target = v; }
    }
    // Phase 8.A.5.2 -- on steal, stop the doomed voice's WebAudio
    // sound immediately so it doesn't keep ringing past its
    // replacement.
    if (target) _poolStopWebAudioVoice(target);
  }
  if (!target) return;
  target.active = true;
  target.spawnTime = 0;
  // Phase 8.A.5.1 -- write spawn-time x/y/z into matching exposed
  // params on the voice's children. Phase 8.A.5.2 extends to freq/amp
  // for audio voices that expose those param labels.
  const spawnMap = {
    x:    (typeof params.x    === "number") ? params.x    : 0,
    y:    (typeof params.y    === "number") ? params.y    : 0,
    z:    (typeof params.z    === "number") ? params.z    : 0,
    freq: (typeof params.freq === "number") ? params.freq : null,
    amp:  (typeof params.amp  === "number") ? params.amp  : null
  };
  for (const ep of target.exposedParams) {
    if (!(ep.label in spawnMap)) continue;
    if (spawnMap[ep.label] === null) continue;
    const child = state.nodes.find(n => n && n.id === ep.childId);
    if (!child) continue;
    child.params = child.params || {};
    child.params[ep.paramName] = spawnMap[ep.label];
  }
  // Phase 8.A.5.2 -- Web Audio built-in synth voice.
  if ((typeof poolNode.params.audioEnabled === "number") &&
      poolNode.params.audioEnabled >= 0.5) {
    _poolStartWebAudioVoice(poolNode, target, spawnMap);
  }
}

/* Phase 8.A.5.2 -- Web Audio integration. Each pool maintains its
 * own AudioContext (shared across all pools to avoid context-create
 * cost). On voice spawn, we build a real OscillatorNode + GainNode
 * (envelope) chain and route to the destination, scheduling stop()
 * after the configured lifetime. Voice stealing stops the doomed
 * voice's oscillator immediately so it doesn't ring through the
 * replacement.
 *
 * Independent of the prefab template's audio nodes -- this is the
 * "always-works" sound path that doesn't require codegen integration.
 * For template-driven audio (Sine + ADSR + Filter chains feeding
 * Pool.audio), see 8.A.5.3 / WASM codegen integration future work. */
function _poolGetAudioContext() {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!Visual._poolAudioCtx) Visual._poolAudioCtx = new AC();
  return Visual._poolAudioCtx;
}

function _poolStopWebAudioVoice(voice) {
  if (!voice) return;
  if (voice._waOsc) {
    try { voice._waOsc.stop(); } catch (_) {}
    try { voice._waOsc.disconnect(); } catch (_) {}
    voice._waOsc = null;
  }
  if (voice._waGain) {
    try { voice._waGain.disconnect(); } catch (_) {}
    voice._waGain = null;
  }
}

function _poolStartWebAudioVoice(poolNode, voice, spawnParams) {
  const ctx = _poolGetAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    try { ctx.resume(); } catch (_) {}
  }
  // Clean up any prior osc still attached (stealing case).
  _poolStopWebAudioVoice(voice);
  const p = poolNode.params || {};
  const baseFreq = (typeof p.audioBaseFreq === "number" && p.audioBaseFreq > 0) ? p.audioBaseFreq : 220;
  const freq = (typeof spawnParams.freq === "number" &&
                Number.isFinite(spawnParams.freq) &&
                spawnParams.freq > 0) ? spawnParams.freq : baseFreq;
  const amp  = (typeof spawnParams.amp === "number" && Number.isFinite(spawnParams.amp))
    ? Math.max(0, Math.min(1, spawnParams.amp)) : 1.0;
  const gainMaster = (typeof p.audioGain === "number") ? p.audioGain : 0.15;
  const atk = (typeof p.audioAttack  === "number") ? Math.max(0.001, p.audioAttack)  : 0.01;
  const rel = (typeof p.audioRelease === "number") ? Math.max(0.001, p.audioRelease) : 0.30;
  const lifetime = (typeof p.voiceLifetime === "number" && p.voiceLifetime > 0) ? p.voiceLifetime : 1.5;
  const waveform = (typeof p.audioWaveform === "string") ? p.audioWaveform : "sine";
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  try { osc.type = waveform; } catch (_) { osc.type = "sine"; }
  osc.frequency.setValueAtTime(freq, now);
  const g = ctx.createGain();
  const peak = gainMaster * amp;
  // Linear AR envelope: 0 -> peak over atk, hold until lifetime-rel,
  // then peak -> 0 over rel.
  const releaseStart = now + Math.max(atk, lifetime - rel);
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(peak, now + atk);
  g.gain.setValueAtTime(peak, releaseStart);
  g.gain.linearRampToValueAtTime(0, releaseStart + rel);
  osc.connect(g);
  g.connect(ctx.destination);
  const stopTime = releaseStart + rel + 0.05;
  osc.start(now);
  try { osc.stop(stopTime); } catch (_) {}
  voice._waOsc = osc;
  voice._waGain = g;
}

/* Phase 8.A.5.2 -- JS-rate "audio" output. Sum each active voice's
 * approximate envelope amplitude (linear AR shape against spawnTime
 * vs voiceLifetime). Use this for VISUALIZATION (oscilloscope HUDs,
 * audio-reactive shaders, OscOut at frame rate). Not sample-accurate;
 * actual audio playback comes from the Web Audio integration above
 * (when audioEnabled) or from future codegen integration. */
function _poolAudioMirrorValue(poolNode) {
  if (!poolNode || !poolNode._voices) return 0;
  const p = poolNode.params || {};
  const lifetime = (typeof p.voiceLifetime === "number" && p.voiceLifetime > 0) ? p.voiceLifetime : 1.5;
  const atk = (typeof p.audioAttack  === "number") ? Math.max(0.001, p.audioAttack)  : 0.01;
  const rel = (typeof p.audioRelease === "number") ? Math.max(0.001, p.audioRelease) : 0.30;
  const gainMaster = (typeof p.audioGain === "number") ? p.audioGain : 0.15;
  let sum = 0;
  for (const v of poolNode._voices) {
    if (!v.active) continue;
    const t = v.spawnTime;
    let amp;
    if (t < atk) amp = t / atk;
    else if (t < lifetime - rel) amp = 1;
    else if (t < lifetime) amp = 1 - (t - (lifetime - rel)) / rel;
    else amp = 0;
    sum += amp;
  }
  return sum * gainMaster;
}

function _tickPools(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  const dt = (!(dtSec > 0) || dtSec > 0.034) ? 0.034 : dtSec;
  for (const node of state.nodes) {
    if (!node || node.type !== "Pool") continue;
    if (!node._voicesExpanded) _expandPool(node);
    if (!node._voices) continue;
    const resolved = _resolveNodeParams(node);
    const spawnNow = (resolved.spawn || 0) >= 0.5;
    if (spawnNow && !node._spawnPrev) {
      _poolSpawnNext(node, resolved);
    }
    node._spawnPrev = spawnNow;
    const lifetime = (typeof node.params.voiceLifetime === "number") ? node.params.voiceLifetime : 1.5;
    let activeCount = 0;
    for (const v of node._voices) {
      if (!v.active) continue;
      v.spawnTime += dt;
      if (lifetime > 0 && v.spawnTime >= lifetime) {
        v.active = false;
        // 8.A.5.2: Web Audio voice stops via its scheduled stop()
        // time on the OscillatorNode; explicit cleanup not required
        // here (the osc and gain are already in the GC pool once
        // their stop() fires). But null-out the handles so a
        // subsequent spawn doesn't try to re-disconnect a dead node.
        v._waOsc = null;
        v._waGain = null;
        continue;
      }
      activeCount++;
    }
    node.params.activeCount = activeCount;
  }
}

/* For Scene.meshN wires that come from a Pool's mesh output, emit
 * one mesh entry per ACTIVE voice by walking the chain from each
 * voice's exposed-mesh child. Inactive voices contribute nothing. */
function _expandPoolVoices(poolNode, baseTransform, baseMaterial) {
  if (!poolNode || poolNode.type !== "Pool") return [];
  if (!poolNode._voicesExpanded) _expandPool(poolNode);
  const out = [];
  for (const v of (poolNode._voices || [])) {
    if (!v.active || !v.exposedMeshChildId) continue;
    const startTransform = baseTransform || _mat4Identity();
    const resolved = _walkMeshChain(v.exposedMeshChildId, startTransform, baseMaterial, 0);
    if (resolved) out.push(resolved);
  }
  return out;
}

