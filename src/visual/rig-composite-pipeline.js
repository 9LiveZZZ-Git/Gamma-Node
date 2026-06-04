/* ----- Phase 6.5.9 / 6.5.10 — rig composite pipeline ------------------ */

/* Build the rig composite pipeline once at device init. Reads the
 * framebuffer texture array + a small uniform (layer count, cols,
 * rows, mode) and assembles the layers onto the visible canvas via
 * a fullscreen-triangle WGSL shader.
 *
 * Currently implements MODE = 0 (tile-flat) only. Modes 1/2/3
 * (cylinder / equirect / fisheye) are sketched in the WGSL switch
 * but fall back to tile until 6.5.11–6.5.13 ship the full
 * projection math. */
function _createRigCompositePipeline() {
  if (!Visual.device || !Visual.presentationFormat) return;
  const wgsl = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
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

const PI: f32 = 3.14159265359;

struct RigU {
  layer_count: u32,
  cols:        u32,
  rows:        u32,
  mode:        u32,    // 0 = tile-flat, 1 = cylinder, 2 = equirect, 3 = fisheye
  azim_range:  vec2f,  // (min, max) yaw degrees — cylinder mode bounds
  pitch_range: vec2f,  // (min, max) pitch degrees — cylinder mode bounds
};

// Per-display orientation for spherical-projection modes. Each entry:
//   .x = yaw degrees (azimuth)
//   .y = pitch degrees (elevation)
//   .z = horizontal FOV degrees
//   .w = vertical FOV degrees
// Capacity = RIG_MAX_DISPLAYS (interpolated from JS); layer_count
// limits the loop in pickDisplay so unused slots stay untouched.
struct RigDisplays {
  d: array<vec4f, ${RIG_MAX_DISPLAYS}>,
};

@group(0) @binding(0) var fbTex:    texture_2d_array<f32>;
@group(0) @binding(1) var fbSampler: sampler;
@group(0) @binding(2) var<uniform> rigU: RigU;
@group(0) @binding(3) var<uniform> rigDisplays: RigDisplays;

// Find which display covers a (yaw, pitch) direction. Returns
// vec3(local_u, local_v, layer_index_as_f32), or layer < 0 when
// no display covers this direction. First-match-wins iteration
// order — overlapping displays in the rig get resolved by the
// earlier-indexed one taking the pixel. Phase 6.6 will revisit
// this with edge-blend alpha + warp meshes.
fn pickDisplay(yaw_deg: f32, pitch_deg: f32) -> vec3f {
  for (var i: u32 = 0u; i < rigU.layer_count; i = i + 1u) {
    let info = rigDisplays.d[i];
    let d_yaw   = info.x;
    let d_pitch = info.y;
    let d_fovH  = info.z;
    let d_fovV  = info.w;
    // Wrap yaw delta into [-180, +180] so wrap-around at the dateline
    // doesn't cause a false miss for displays straddling ±180°.
    var dy = yaw_deg - d_yaw;
    dy = dy - 360.0 * floor((dy + 180.0) / 360.0);
    let dp = pitch_deg - d_pitch;
    if (abs(dy) <= d_fovH * 0.5 && abs(dp) <= d_fovV * 0.5) {
      let u = dy / d_fovH + 0.5;
      let v = -dp / d_fovV + 0.5;   // flip v: pitch-up = canvas-up
      return vec3f(u, v, f32(i));
    }
  }
  return vec3f(0.0, 0.0, -1.0);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Mode 0 = tile-flat. Pure 2D layout, ignores pose/fov; uses cell
  // index → array layer. Useful for QC during patching.
  if (rigU.mode == 0u) {
    let cx = floor(in.uv.x * f32(rigU.cols));
    let ry = floor(in.uv.y * f32(rigU.rows));
    let idx = u32(ry) * rigU.cols + u32(cx);
    if (idx >= rigU.layer_count) {
      return vec4f(0.0, 0.0, 0.0, 1.0);
    }
    let local_uv = vec2f(
      fract(in.uv.x * f32(rigU.cols)),
      fract(in.uv.y * f32(rigU.rows))
    );
    return textureSampleLevel(fbTex, fbSampler, local_uv, idx, 0.0);
  }

  // Modes 1/2/3 — angular projection. Each translates a canvas pixel
  // to a (yaw, pitch) direction; pickDisplay finds the covering
  // display and returns local UV + layer for sampling. Pixels not
  // covered by any display render solid black ("no signal").
  var yaw_deg: f32 = 0.0;
  var pitch_deg: f32 = 0.0;
  var valid: bool = true;

  if (rigU.mode == 1u) {
    // Cylindrical unwrap — canvas u → yaw across rig's azimuth
    // bounding range; canvas v → pitch across rig's pitch range
    // (top of canvas = highest pitch). Best for ≤180° wraparound
    // rigs where vertical coverage is narrow.
    yaw_deg   = mix(rigU.azim_range.x,  rigU.azim_range.y,  in.uv.x);
    pitch_deg = mix(rigU.pitch_range.y, rigU.pitch_range.x, in.uv.y);
  } else if (rigU.mode == 2u) {
    // Equirectangular — full 360° H × 180° V. The "AlloSphere
    // panoramic" view: projects the entire sphere into a 2:1
    // image. Top of canvas = +90° pitch (zenith), bottom = -90°.
    // Use this with rig templates that fill ≥180° H or full 360°.
    yaw_deg   = (in.uv.x - 0.5) * 360.0;
    pitch_deg = (0.5 - in.uv.y) * 180.0;
  } else if (rigU.mode == 3u) {
    // Stereographic / fisheye — equiangular dome projection from
    // sphere center looking up. Canvas center = zenith (+Y up,
    // pitch +90°); canvas edge = horizon (pitch 0°). Beyond the
    // unit circle is unreachable on the dome and renders black.
    let centered = (in.uv - vec2f(0.5)) * 2.0;
    let r = length(centered);
    if (r > 1.0) {
      valid = false;
    } else {
      // theta=0 at canvas-up, increasing clockwise from above
      let theta = atan2(centered.x, -centered.y);
      let phi_deg = r * 90.0;   // zenith angle from +Y
      yaw_deg = degrees(theta);
      pitch_deg = 90.0 - phi_deg;
    }
  }

  if (!valid) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let pick = pickDisplay(yaw_deg, pitch_deg);
  if (pick.z < 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return textureSampleLevel(fbTex, fbSampler, pick.xy, u32(pick.z), 0.0);
}
`;
  const module = Visual.device.createShaderModule({ label: "rig-composite-shader", code: wgsl });

  Visual.rigCompositeBindGroupLayout = Visual.device.createBindGroupLayout({
    label: "rig-composite-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ]
  });

  Visual.rigCompositePipeline = Visual.device.createRenderPipeline({
    label: "rig-composite-pipeline",
    layout: Visual.device.createPipelineLayout({
      bindGroupLayouts: [Visual.rigCompositeBindGroupLayout]
    }),
    vertex:   { module, entryPoint: "vs_main" },
    fragment: {
      module, entryPoint: "fs_main",
      targets: [{ format: Visual.presentationFormat }]
    },
    primitive: { topology: "triangle-list" }
  });

  // 32 B uniform: layer_count, cols, rows, mode (16 B) + azim_range
  // + pitch_range (16 B). Updated each frame in _encodeRigComposite.
  Visual.rigCompositeUniformBuffer = Visual.device.createBuffer({
    label: "rig-composite-uniform",
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  // RIG_MAX_DISPLAYS × 16 B uniform array of display-info vec4fs
  // (yaw, pitch, fov_h, fov_v in degrees). Used by spherical-projection
  // modes (cylinder/equirect/fisheye) to find which display covers a
  // given direction. Tile mode ignores it. Allocated once at device init.
  Visual.rigDisplaysBuffer = Visual.device.createBuffer({
    label: "rig-displays-uniform",
    size: RIG_MAX_DISPLAYS * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  // Phase 6.5.2 + 6.5.3 + 6.5.4 — global audio uniform buffer.
  // 16 scalar slots + 256 FFT bins, bound at @binding(3) in every
  // shader-frag bind layout (standard / feedback / composition).
  // Shader-frags declare the struct with the fields they want:
  //   struct AudioU {
  //     values: array<vec4<f32>, 4>,    // 16 scalars (slots 0-15)
  //     fft:    array<vec4<f32>, 64>,   // 256 log-spaced FFT bins
  //   };
  //   @group(0) @binding(3) var<uniform> u_audio: AudioU;
  // Slot assignments:
  //   values[0].x   = master output peak this quantum (worklet, 6.5.2)
  //   values[2].w   = MasterClock bpm                              (6.5.4)
  //   values[3].xyz = MasterClock bar / beat / sixteenth envelopes (6.5.4)
  //   values[3].w   = MasterClock 0..1 phase ramp                  (6.5.4)
  //   fft[0..63]    = 256 log-spaced FFT magnitude bins (6.5.3)
  // 1088 B total = 64 B scalars + 1024 B FFT. Per-frame copy from
  // SAB happens in renderVisualFrame() before any shader pass
  // encodes (see _writeAudioUniform + _writeClockUniformSlots).
  Visual.audioUniformBuffer = Visual.device.createBuffer({
    label: "audio-uniform",
    size: 1088,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  // Reusable scratch for the per-frame copy. 272 f32 = 16 scalars +
  // 256 FFT bins. Avoids a Float32Array alloc each frame.
  Visual.audioUniformScratch = new Float32Array(272);
}

