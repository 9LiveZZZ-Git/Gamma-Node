/* Phase 6.6.20.3 — pack the rig's screen-surface descriptor into a
 * shader's uniform scratch buffer at the given Float32 base index.
 * Layout (8 floats, 2 vec4s):
 *
 *   [base+0..3] u_surface = (type, radius, param_a, param_b)
 *   [base+4..7] u_surface_path = (yawStart, yawEnd, _, _)
 *
 * type codes:
 *   0 = none / free / plane    → defaults to unit sphere full range
 *   1 = sphere                 → param_a = -90, param_b = 90 (full)
 *   2 = cylinder               → param_a = -length/2, param_b = +length/2
 *   3 = swept (arc profile)    → param_a = pitchStart, param_b = pitchEnd
 *   4 = swept (vertical profile) → param_a = yMin, param_b = yMax
 *
 * This lets surface-aware shaders (Checkerboard, Voronoi as of 6.6.20.3)
 * read `u.u_surface.x` to dispatch to the right parameterization, and
 * use param_a / param_b / yawStart / yawEnd to compute equal-area
 * normalized UV for cell math.
 *
 * No-curved-surface fallback (stype=0): emits "fake unit sphere" so
 * shaders in tile/equirect/fisheye preview modes still render uniform
 * cells. The shader treats stype=0 the same as a full sphere of radius 1. */
function _packSurfaceUniforms(scratch, base) {
  const surface = (state && state.rig && state.rig.surface) || null;
  const surfaceVisible = !!(state && state.rig && state.rig.surfaceVisible !== false);
  const isCurved = !!(surface && surfaceVisible &&
    (surface.type === "sphere" || surface.type === "cylinder" || surface.type === "swept"));
  if (!isCurved) {
    scratch[base + 0] = 0;        // type: none
    scratch[base + 1] = 1;        // radius (unit fallback)
    scratch[base + 2] = -90;      // pitchStart fallback
    scratch[base + 3] = 90;       // pitchEnd fallback
    scratch[base + 4] = -180;     // yawStart fallback
    scratch[base + 5] = 180;      // yawEnd fallback
    scratch[base + 6] = 0;
    scratch[base + 7] = 0;
    return;
  }
  if (surface.type === "sphere") {
    scratch[base + 0] = 1;
    scratch[base + 1] = surface.radius || 5;
    scratch[base + 2] = -90;
    scratch[base + 3] = 90;
    scratch[base + 4] = -180;
    scratch[base + 5] = 180;
    scratch[base + 6] = 0;
    scratch[base + 7] = 0;
    return;
  }
  if (surface.type === "cylinder") {
    const L = surface.length || 5;
    scratch[base + 0] = 2;
    scratch[base + 1] = surface.radius || 5;
    scratch[base + 2] = -L * 0.5;
    scratch[base + 3] =  L * 0.5;
    scratch[base + 4] = -180;
    scratch[base + 5] = 180;
    scratch[base + 6] = 0;
    scratch[base + 7] = 0;
    return;
  }
  // type === "swept"
  const profile = surface.profile || {};
  const path = surface.path || { yawStart: -180, yawEnd: 180 };
  if (profile.kind === "vertical") {
    scratch[base + 0] = 4;
    scratch[base + 1] = profile.radius || 5;
    scratch[base + 2] = profile.yMin != null ? profile.yMin : -2.5;
    scratch[base + 3] = profile.yMax != null ? profile.yMax :  2.5;
  } else {
    scratch[base + 0] = 3;
    scratch[base + 1] = profile.radius || 5;
    scratch[base + 2] = profile.pitchStart != null ? profile.pitchStart : -90;
    scratch[base + 3] = profile.pitchEnd   != null ? profile.pitchEnd   :  90;
  }
  scratch[base + 4] = path.yawStart != null ? path.yawStart : -180;
  scratch[base + 5] = path.yawEnd   != null ? path.yawEnd   :  180;
  scratch[base + 6] = 0;
  scratch[base + 7] = 0;
}

/* Phase 6.6.25 — Text node mesh-text WGSL generator. The Text
 * node's `wgsl` field is a function (node) => string that bakes
 * the user's text param into the shader as a const glyph-index
 * array, alongside the static 5x7 bitmap font for A-Z + 0-9 +
 * space + dash + period + bang (40 glyphs total, 280 rows). The
 * function form uses the v0.1.98 dynamic-WGSL infra: each text
 * value compiles to its own pipeline (cached by hash), the old
 * pipeline keeps rendering until the new one is ready (no
 * flicker), unsupported chars become spaces.
 *
 * Why dynamic WGSL instead of uniform-passed glyphs: simpler.
 * No vec4u packing, no Uint32Array view of a Float32Array, no
 * shader-side glyph-from-uniform helper. Cost is one pipeline
 * compile per unique text value (~10-50 ms, async, cached). For
 * a Text node that rarely changes after authoring, that's
 * imperceptible. */
const _TEXT_FONT_ROWS = [
  // A-Z (indices 0-25); each entry = 7 row bitmasks (5 bits, MSB=col 0).
  [14, 17, 17, 31, 17, 17, 17], // A
  [30, 17, 17, 30, 17, 17, 30], // B
  [14, 17, 16, 16, 16, 17, 14], // C
  [30, 17, 17, 17, 17, 17, 30], // D
  [31, 16, 16, 30, 16, 16, 31], // E
  [31, 16, 16, 30, 16, 16, 16], // F
  [14, 17, 16, 23, 17, 17, 14], // G
  [17, 17, 17, 31, 17, 17, 17], // H
  [31,  4,  4,  4,  4,  4, 31], // I
  [ 7,  2,  2,  2,  2, 18, 12], // J
  [17, 18, 20, 24, 20, 18, 17], // K
  [16, 16, 16, 16, 16, 16, 31], // L
  [17, 27, 21, 17, 17, 17, 17], // M
  [17, 25, 21, 19, 17, 17, 17], // N
  [14, 17, 17, 17, 17, 17, 14], // O
  [30, 17, 17, 30, 16, 16, 16], // P
  [14, 17, 17, 17, 21, 18, 13], // Q
  [30, 17, 17, 30, 20, 18, 17], // R
  [15, 16, 16, 14,  1,  1, 30], // S
  [31,  4,  4,  4,  4,  4,  4], // T
  [17, 17, 17, 17, 17, 17, 14], // U
  [17, 17, 17, 17, 17, 10,  4], // V
  [17, 17, 17, 17, 21, 21, 10], // W
  [17, 17, 10,  4, 10, 17, 17], // X
  [17, 17, 10,  4,  4,  4,  4], // Y
  [31,  2,  4,  8, 16, 16, 31], // Z
  // 0-9 (indices 26-35)
  [14, 17, 19, 21, 25, 17, 14], // 0
  [ 4, 12,  4,  4,  4,  4, 14], // 1
  [14, 17,  1,  2,  4,  8, 31], // 2
  [30,  1,  1, 14,  1,  1, 30], // 3
  [ 2,  6, 10, 18, 31,  2,  2], // 4
  [31, 16, 16, 30,  1,  1, 30], // 5
  [14, 17, 16, 30, 17, 17, 14], // 6
  [31,  1,  2,  4,  8,  8,  8], // 7
  [14, 17, 17, 14, 17, 17, 14], // 8
  [14, 17, 17, 15,  1, 17, 14], // 9
  // space (36)
  [ 0,  0,  0,  0,  0,  0,  0],
  // dash (37)
  [ 0,  0,  0, 14,  0,  0,  0],
  // period (38)
  [ 0,  0,  0,  0,  0, 12, 12],
  // ! (39)
  [ 4,  4,  4,  4,  4,  0,  4]
];

function _textCharToGlyphIdx(ch) {
  if (!ch) return 36;             // space
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 90)  return c - 65;        // A-Z
  if (c >= 97 && c <= 122) return c - 97;        // a-z lowercased
  if (c >= 48 && c <= 57)  return c - 48 + 26;   // 0-9
  if (ch === '-') return 37;
  if (ch === '.') return 38;
  if (ch === '!') return 39;
  return 36;                                     // unknown -> space
}

function _buildTextShaderWGSL(node) {
  const rawText = (node && node.params && typeof node.params.text === "string")
    ? node.params.text
    : "GAMMA NODE";
  const MAX = 32;
  const trimmed = rawText.slice(0, MAX);
  const glyphIdx = [];
  for (let i = 0; i < MAX; i++) {
    glyphIdx.push(_textCharToGlyphIdx(trimmed[i] || ""));
  }
  const textLen = trimmed.length;

  // Flatten the font rows into a 280-element array of u32 row
  // bitmasks; baked into the shader as a const at module scope.
  const fontFlat = [];
  for (const glyph of _TEXT_FONT_ROWS) {
    for (const row of glyph) fontFlat.push(row);
  }
  const fontStr = fontFlat.map(v => v + "u").join(", ");
  const glyphsStr = glyphIdx.map(g => g + "u").join(", ");

  return `struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  u_layer:      f32,
  u_fov_v_deg:  f32,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,    // x=yawDeg, y=pitchDeg, z=sizeDeg, w=plateOpacity
  color:        vec4f,    // x=r, y=g, z=b, w=_
  bgColor:      vec4f,    // x=bgR, y=bgG, z=bgB, w=_
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn frag_to_global_angles(uv: vec2f) -> vec2f {
  // Standard basis-rotation gnomonic (see WireframeCalibration shader).
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  let fwd = vec3f(sy * cp, sp, cy * cp);
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  let dir = normalize(local_x * right + local_y * up + fwd);
  let pitch_out = asin(clamp(dir.y, -1.0, 1.0));
  let yaw_out   = atan2(dir.x, dir.z);
  return vec2f(yaw_out * 57.29577951, pitch_out * 57.29577951);
}

const TEXT_LEN: u32 = ${textLen}u;
const TEXT_GLYPHS: array<u32, ${MAX}> = array<u32, ${MAX}>(${glyphsStr});
const FONT: array<u32, 280> = array<u32, 280>(${fontStr});

fn glyph_pixel(g: u32, x: i32, y: i32) -> bool {
  if (g >= 40u) { return false; }
  if (x < 0 || x > 4 || y < 0 || y > 6) { return false; }
  let row = FONT[g * 7u + u32(y)];
  let bit = (row >> u32(4 - x)) & 1u;
  return bit == 1u;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let ang = frag_to_global_angles(in.uv);
  let yaw   = ang.x;
  let pitch = ang.y;

  let yaw_c   = u.params.x;
  let pitch_c = u.params.y;
  let size    = max(2.0, u.params.z);
  let plateA  = clamp(u.params.w, 0.0, 1.0);

  // Each char is 5 cells wide, 7 cells tall + 1 cell spacing.
  // Cell size derived so total height = sizeDeg.
  let cell    = size / 7.0;
  let nchars  = max(1.0, f32(TEXT_LEN));
  let text_w  = (nchars * 6.0 - 1.0) * cell;
  let text_h  = size;

  // Yaw delta with proper plus/minus 180 wrap.
  var dy = yaw - yaw_c;
  if (dy >  180.0) { dy = dy - 360.0; }
  if (dy < -180.0) { dy = dy + 360.0; }
  let dp = pitch - pitch_c;

  let pad      = cell * 0.5;
  let in_plate = abs(dy) <= text_w * 0.5 + pad && abs(dp) <= text_h * 0.5 + pad;
  let in_text  = abs(dy) <= text_w * 0.5      && abs(dp) <= text_h * 0.5;

  var col = vec3<f32>(0.0);

  if (in_plate) {
    col = mix(vec3<f32>(0.0), u.bgColor.rgb, plateA);
  }

  if (in_text) {
    let x_norm = (dy + text_w * 0.5) / text_w;       // 0..1 left-to-right
    let y_norm = (dp + text_h * 0.5) / text_h;       // 0..1 bottom-to-top
    let cci = i32(floor(x_norm * nchars * 6.0));
    let row = i32(floor((1.0 - y_norm) * 7.0));
    let char_idx = cci / 6;
    let local_col = cci - char_idx * 6;
    if (local_col >= 0 && local_col < 5 && row >= 0 && row <= 6 && u32(char_idx) < TEXT_LEN) {
      let g = TEXT_GLYPHS[char_idx];
      if (glyph_pixel(g, local_col, row)) {
        col = u.color.rgb;
      }
    }
  }

  return vec4<f32>(col, 1.0);
}`;
}

function _writeShaderPreamble(scratch, dtSec, display, worldUvOverride, layerIdx) {
  const t = (performance.now() - Visual.startTime) * 0.001;
  scratch[0]  = Visual.fbWidth;
  scratch[1]  = Visual.fbHeight;
  scratch[2]  = 1.0 / Visual.fbWidth;
  scratch[3]  = 1.0 / Visual.fbHeight;
  scratch[4]  = t;
  scratch[5]  = dtSec;
  scratch[6]  = (typeof layerIdx === "number" && Number.isFinite(layerIdx)) ? layerIdx : 0;
  // Phase 6.4 polish — u_fov_v_deg companion to u_view.w (fov_h).
  // Lets shaders compute global angular position for uniform-on-sphere
  // cell math (Checkerboard / Voronoi / NoiseShader). Defaults to 60°
  // when no display info is available — matches the most common preset.
  scratch[7]  = (display && display.fov && display.fov.v) || 60;
  // Defensive: missing display falls back to a single-display default
  // so the preamble is always well-formed. Same defaults make a new
  // editor with no rig (shouldn't happen, freshState provides one)
  // still produce sensible u_world_uv = (0,0,1,1).
  const pose = (display && display.pose) || { yaw: 0, pitch: 0, roll: 0 };
  const fov  = (display && display.fov)  || { h: 90, v: 60 };
  // worldUvOverride is the per-VO normalized slice computed from the
  // shader's actual consumer set (see _renderWorldUvForVO). Falls back
  // to the rig display's slice when no override given (which happens
  // for non-shader-frag callers — there are none today, but safe).
  const wuv = worldUvOverride || (display && display.worldUv) || { minU: 0, minV: 0, maxU: 1, maxV: 1 };
  scratch[8]  = pose.yaw   || 0;
  scratch[9]  = pose.pitch || 0;
  scratch[10] = pose.roll  || 0;
  scratch[11] = fov.h      || 90;
  scratch[12] = wuv.minU != null ? wuv.minU : 0;
  scratch[13] = wuv.minV != null ? wuv.minV : 0;
  scratch[14] = wuv.maxU != null ? wuv.maxU : 1;
  scratch[15] = wuv.maxV != null ? wuv.maxV : 1;
}

/* Find every VisualOutput in the patch that consumes the same shader
 * source as `vo`. Returns the array including `vo` itself. Used by
 * _renderWorldUvForVO to decide whether the shader is solo-consumed
 * (full coverage) or shared across multiple displays (slice the
 * shared canvas).
 *
 * Trade-off: O(N×E) per render frame for N nodes × E edges. Trivial
 * for typical patches; could be cached on graph mutation if profiling
 * ever shows it matters. */
function _coConsumerVOs(currentVO, srcId) {
  if (!state || !Array.isArray(state.nodes) || !Array.isArray(state.edges)) return [currentVO];
  const out = [];
  for (const candidate of state.nodes) {
    if (candidate.type !== "VisualOutput") continue;
    const incomingEdge = state.edges.find(e =>
      e.to.node === candidate.id && e.to.port === "in"
    );
    if (!incomingEdge || incomingEdge.from.node !== srcId) continue;
    out.push(candidate);
  }
  return out.length ? out : [currentVO];
}

/* Compute the per-VO render-time u_world_uv. Two regimes:
 *
 *   Solo consumer (this is the only VO wired to this shader source):
 *     return (0, 0, 1, 1) — shader renders FULL coverage on this
 *     display. A pinwheel sees a complete pinwheel; a gradient runs
 *     edge-to-edge.
 *
 *   Shared consumer (≥ 2 VOs wired to the same shader source):
 *     compute the bounding rect of all consumer displays' rig
 *     worldUvs, then return THIS VO's display slice normalized to
 *     that bbox so the union spans 0..1 across the consumers.
 *     A pinwheel wired to both displays of side-by-side renders
 *     once-per-display with its center exactly at the seam.
 *
 * The normalization step matters when consumers don't cover the
 * full rig: e.g. on AlloSphere-like (16 displays), wiring a shader
 * into VO0 + VO15 produces a "shared canvas" that's just those two
 * displays' worldUv union; the in-between displays just don't
 * receive the shader's output. */
function _renderWorldUvForVO(currentVO, srcId) {
  const displays = (state && state.rig && state.rig.displays) || [];
  if (displays.length === 0) return { minU: 0, minV: 0, maxU: 1, maxV: 1 };

  // Phase 6.5.15+ — global shader-center offset (degrees of yaw/pitch).
  // Solo and multi paths convert this to a normalized u/v shift via
  // different denominators (see below). Subtracting the shift from
  // the slice min/max effectively rotates the shader's content within
  // the rig — positive yaw shift pulls the pinwheel center toward
  // the right of the rig's view.
  const sCYaw   = (state.rig && typeof state.rig.shaderCenterYaw   === "number") ? state.rig.shaderCenterYaw   : 0;
  const sCPitch = (state.rig && typeof state.rig.shaderCenterPitch === "number") ? state.rig.shaderCenterPitch : 0;

  const consumers = _coConsumerVOs(currentVO, srcId);
  const myIdx  = (currentVO.params && typeof currentVO.params.display === "number") ? (currentVO.params.display | 0) : 0;
  const myDisp = displays[Math.max(0, Math.min(myIdx, displays.length - 1))];

  // Solo consumer → full coverage on its display. ShaderCenter shift
  // denominator is the display's own FOV so 1 fov_h of yaw shift
  // moves the content one full screen. (Doesn't crop content; the
  // shader sees u_world_uv outside [0,1] and renders accordingly.)
  if (consumers.length <= 1) {
    const fovH = (myDisp && myDisp.fov && myDisp.fov.h) || 90;
    const fovV = (myDisp && myDisp.fov && myDisp.fov.v) || 60;
    const u_shift = sCYaw   / fovH;
    const v_shift = sCPitch / fovV;
    return {
      minU: 0 - u_shift, minV: 0 - v_shift,
      maxU: 1 - u_shift, maxV: 1 - v_shift
    };
  }

  // Shared shader → compute bbox of consumer-display slices in raw
  // worldUv space, normalize this VO's slice to that bbox. Then
  // apply shaderCenter shift, denominated by the consumer set's
  // total azimuth/pitch coverage in degrees.
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  let azMinDeg = Infinity, azMaxDeg = -Infinity;
  let pitchMinDeg = Infinity, pitchMaxDeg = -Infinity;
  for (const otherVO of consumers) {
    const idx = (otherVO.params && typeof otherVO.params.display === "number") ? (otherVO.params.display | 0) : 0;
    const d = displays[Math.max(0, Math.min(idx, displays.length - 1))];
    if (!d) continue;
    // worldUv bbox for normalization
    if (d.worldUv) {
      if (d.worldUv.minU < minU) minU = d.worldUv.minU;
      if (d.worldUv.minV < minV) minV = d.worldUv.minV;
      if (d.worldUv.maxU > maxU) maxU = d.worldUv.maxU;
      if (d.worldUv.maxV > maxV) maxV = d.worldUv.maxV;
    }
    // Degree bbox for shaderCenter denominator
    const pose = d.pose || { yaw: 0, pitch: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    const azL = pose.yaw   - fov.h * 0.5;
    const azR = pose.yaw   + fov.h * 0.5;
    const pT  = pose.pitch - fov.v * 0.5;
    const pB  = pose.pitch + fov.v * 0.5;
    if (azL < azMinDeg)   azMinDeg = azL;
    if (azR > azMaxDeg)   azMaxDeg = azR;
    if (pT  < pitchMinDeg) pitchMinDeg = pT;
    if (pB  > pitchMaxDeg) pitchMaxDeg = pB;
  }
  if (!isFinite(minU)) return { minU: 0, minV: 0, maxU: 1, maxV: 1 };

  const w = (maxU - minU) || 1;
  const h = (maxV - minV) || 1;
  const wuv = (myDisp && myDisp.worldUv) || { minU: 0, minV: 0, maxU: 1, maxV: 1 };

  // Convert shaderCenter degrees → normalized worldUv shift.
  // Consumer set's azim range covers (azMaxDeg - azMinDeg) degrees;
  // in normalized worldUv space (after bbox div) that's [0, 1].
  // So 1 normalized u unit = (azMaxDeg - azMinDeg) degrees.
  const azRange = isFinite(azMinDeg) ? Math.max(0.001, azMaxDeg - azMinDeg) : 360;
  const piRange = isFinite(pitchMinDeg) ? Math.max(0.001, pitchMaxDeg - pitchMinDeg) : 180;
  const u_shift = sCYaw   / azRange;
  const v_shift = sCPitch / piRange;

  return {
    minU: (wuv.minU - minU) / w - u_shift,
    minV: (wuv.minV - minV) / h - v_shift,
    maxU: (wuv.maxU - minU) / w - u_shift,
    maxV: (wuv.maxV - minV) / h - v_shift
  };
}

/* Encode a shader-frag pass for one VisualOutput → its display layer.
 * The instance is keyed by VO node id (not source shader) because
 * different VOs targeting the same shader still need their OWN
 * uniform buffer to hold their display-specific u_view + u_world_uv.
 * The pipeline cache key is the WGSL hash, so all instances of the
 * same shader share one compiled pipeline regardless of how many
 * VOs they feed.
 *
 * Returns true if a pass was actually encoded (pipeline ready,
 * instance built, layer view exists); false if any prerequisite
 * is missing — caller falls back gracefully. */
/* Phase 6.6.24 — resolve a shader-frag node's texture-typed input
 * port to the display layer of its upstream source's VisualOutput.
 *
 * Walk: edge ending at (node.id, portName) -> source node id ->
 * any VisualOutput in the patch whose `in` port is wired to that
 * source -> that VO's params.display. Returns -1 when:
 *   • No edge wired to that port.
 *   • Source has no downstream VisualOutput.
 *   • No state / no displays.
 *
 * Composition shader-frags use this in writeUniforms to fill the
 * per-input layer-index uniform slots: when a texture port is
 * wired, the framework's resolved layer wins; when unwired,
 * the manual layer-index param (the legacy Phase 6.6.22 form)
 * stays in place. WGSL treats a value < 0 as "ignore / black"
 * so unwired ports render neutrally instead of garbage. */
/* Phase 6.6.28 — runtime param-wire resolver. For a shader-frag
 * node, build a shallow copy of node.params where each `t: "param"`
 * input port that has a wire connected has its value replaced by
 * the live source value (Slider's current params.value for now;
 * future: LFO / Ramp / etc. via a shared signal-rate sampler).
 * The returned object is passed in lieu of node.params to the
 * registry's writeUniforms — existing code that does
 * `node.params.mix` automatically picks up the wired Slider value.
 *
 * Limited to Slider sources in this MVP. Audio-rate nodes (LFO,
 * envelope, etc.) would need to hand off their current sample
 * value from the AudioWorklet to the main thread each frame; that
 * SAB-based audio bridge is Phase 6.5. */
function _resolveNodeParams(node) {
  const out = Object.assign({}, node && node.params);
  if (typeof state === "undefined" || !state ||
      !Array.isArray(state.edges) || !Array.isArray(state.nodes)) return out;
  const def = TYPES[node && node.type];
  if (!def || !Array.isArray(def.ins)) return out;
  for (const port of def.ins) {
    // Phase 6.5.4 — substitute for any SIGNAL-typed input that
    // reduces to a per-frame scalar. param + audio + clock all
    // surface as one float to the shader; gate is a trigger
    // (different semantics) so it stays out of substitution.
    if (!port) continue;
    if (port.t !== "param" && port.t !== "audio" && port.t !== "clock") continue;
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === port.n
    );
    if (!wire || !wire.from) continue;
    // Sprint 7.5.3a -- unified with the OscOut path. _readWireJsSideValue
    // dispatches on source type (Slider, MasterClock, HandLandmarker,
    // PoseLandmarker, FaceLandmarker, HandKeyboard, BlobTracker, OscIn,
    // Sine/Saw/Square/Phasor audio mirrors, AD/AR/ADSR envelope mirrors,
    // AND the full cmath / arithmetic math-template family via
    // _evalMathTemplateJsSide recursion). Single source of truth for
    // "what does this wire produce, JS-side?". Returns null when the
    // source has no JS mirror -- in that case we keep the node's static
    // param value (the existing fallback).
    const v = _readWireJsSideValue(wire);
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      out[port.n] = v;
    }
  }
  return out;
}

/* =========================================================================
 * Sprint 7.5.3a -- 3D scene math helpers
 *
 * Column-major 4x4 matrix utilities matching the WebGPU + GLSL
 * convention (vec4 = mat * vec). All matrices are Float32Array(16)
 * laid out in column-major order:
 *
 *   m[ 0..3 ]  =  column 0 (m00 m10 m20 m30)
 *   m[ 4..7 ]  =  column 1
 *   m[ 8..11]  =  column 2
 *   m[12..15]  =  column 3 (translation)
 *
 * Helpers here are intentionally minimal -- just lookAt + perspective
 * + ortho + multiply + identity + per-element transform builders.
 * Sprint 7.5.3b adds rotation chains via the Translate/Rotate/Scale
 * transform nodes; for now Scene only consumes the camera matrices. */
function _mat4Identity() {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

function _mat4Multiply(out, a, b) {
  // out = a * b. Aliasing safe (uses temporaries).
  const a00=a[0],a01=a[4],a02=a[8],a03=a[12];
  const a10=a[1],a11=a[5],a12=a[9],a13=a[13];
  const a20=a[2],a21=a[6],a22=a[10],a23=a[14];
  const a30=a[3],a31=a[7],a32=a[11],a33=a[15];
  const b00=b[0],b01=b[4],b02=b[8],b03=b[12];
  const b10=b[1],b11=b[5],b12=b[9],b13=b[13];
  const b20=b[2],b21=b[6],b22=b[10],b23=b[14];
  const b30=b[3],b31=b[7],b32=b[11],b33=b[15];
  out[0]  = a00*b00 + a01*b10 + a02*b20 + a03*b30;
  out[1]  = a10*b00 + a11*b10 + a12*b20 + a13*b30;
  out[2]  = a20*b00 + a21*b10 + a22*b20 + a23*b30;
  out[3]  = a30*b00 + a31*b10 + a32*b20 + a33*b30;
  out[4]  = a00*b01 + a01*b11 + a02*b21 + a03*b31;
  out[5]  = a10*b01 + a11*b11 + a12*b21 + a13*b31;
  out[6]  = a20*b01 + a21*b11 + a22*b21 + a23*b31;
  out[7]  = a30*b01 + a31*b11 + a32*b21 + a33*b31;
  out[8]  = a00*b02 + a01*b12 + a02*b22 + a03*b32;
  out[9]  = a10*b02 + a11*b12 + a12*b22 + a13*b32;
  out[10] = a20*b02 + a21*b12 + a22*b22 + a23*b32;
  out[11] = a30*b02 + a31*b12 + a32*b22 + a33*b32;
  out[12] = a00*b03 + a01*b13 + a02*b23 + a03*b33;
  out[13] = a10*b03 + a11*b13 + a12*b23 + a13*b33;
  out[14] = a20*b03 + a21*b13 + a22*b23 + a23*b33;
  out[15] = a30*b03 + a31*b13 + a32*b23 + a33*b33;
  return out;
}

function _mat4LookAt(eye, target, up) {
  // Right-handed lookAt -- standard graphics convention. View matrix
  // maps from world space to camera space (camera at origin, looking
  // down -Z, +Y up).
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-6) { zx = 0; zy = 0; zz = 1; }
  else            { zx /= len; zy /= len; zz /= len; }
  // x = up × z (normalized). If up is parallel to z we fall back to
  // the world X axis to avoid a zero-length cross.
  let xx = up[1]*zz - up[2]*zy;
  let xy = up[2]*zx - up[0]*zz;
  let xz = up[0]*zy - up[1]*zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) { xx = 1; xy = 0; xz = 0; }
  else            { xx /= len; xy /= len; xz /= len; }
  // y = z × x (already orthogonal so no renormalize needed)
  const yx = zy*xz - zz*xy;
  const yy = zz*xx - zx*xz;
  const yz = zx*xy - zy*xx;
  const m = new Float32Array(16);
  m[0]=xx; m[1]=yx; m[2]=zx;  m[3]=0;
  m[4]=xy; m[5]=yy; m[6]=zy;  m[7]=0;
  m[8]=xz; m[9]=yz; m[10]=zz; m[11]=0;
  m[12] = -(xx*eye[0] + xy*eye[1] + xz*eye[2]);
  m[13] = -(yx*eye[0] + yy*eye[1] + yz*eye[2]);
  m[14] = -(zx*eye[0] + zy*eye[1] + zz*eye[2]);
  m[15] = 1;
  return m;
}

/* §planet-spec Phase 2 -- f64 lookAt + RTC compose helpers.
 *
 * f32 mantissa is 24 bits, so the representable step size at planet
 * scale (camera near 6.378 Mm from world origin) is ~0.76 m. That's
 * fatal for ground-level vertex detail. The fix is RTC (Relative-To-
 * Center): every mesh declares an optional f64 `anchorF64`; the
 * per-frame ModelView is composed as
 *
 *     mv_rtc = view * translate(anchorF64) * model_local
 *
 * in f64 (JS Number precision, 16 digits) and downcast to f32 only
 * at the GPU upload boundary. The catastrophic subtraction
 * (anchor - eye, both at Earth-radius magnitudes) happens in f64 so
 * the result is a small camera-relative offset; vertex coords stay
 * local (small) too, and f32 GPU math operates only on small numbers.
 *
 * THIS COMMIT IS SCAFFOLDING ONLY -- adds the helpers + returns
 * `eyeF64` / `viewF64` from _evaluateCamera. No existing mesh uses
 * anchorF64 yet; behavior is bit-identical until Phase 3 begins
 * refactoring meshes to local coords + per-chunk anchors.
 *
 * Mesh convention (when Phase 3 lands):
 *   mesh.anchorF64 = { x, y, z }       -- f64 world position of the
 *                                         mesh's local origin.
 *   mesh.transform = Float32Array(16)  -- model_local. Vertices in
 *                                         the VBO are coords
 *                                         RELATIVE to the anchor.
 *   anchorF64 omitted / null           -- legacy absolute-world-coord
 *                                         path (current behavior).
 */
function _mat4LookAtF64(eye, target, up) {
  // Same math as _mat4LookAt but returns a plain JS Array(16) so the
  // entries retain f64 precision -- Float32Array would downcast.
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-6) { zx = 0; zy = 0; zz = 1; }
  else            { zx /= len; zy /= len; zz /= len; }
  let xx = up[1]*zz - up[2]*zy;
  let xy = up[2]*zx - up[0]*zz;
  let xz = up[0]*zy - up[1]*zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) { xx = 1; xy = 0; xz = 0; }
  else            { xx /= len; xy /= len; xz /= len; }
  const yx = zy*xz - zz*xy;
  const yy = zz*xx - zx*xz;
  const yz = zx*xy - zy*xx;
  const m = new Array(16);
  m[0]=xx; m[1]=yx; m[2]=zx;  m[3]=0;
  m[4]=xy; m[5]=yy; m[6]=zy;  m[7]=0;
  m[8]=xz; m[9]=yz; m[10]=zz; m[11]=0;
  m[12] = -(xx*eye[0] + xy*eye[1] + xz*eye[2]);
  m[13] = -(yx*eye[0] + yy*eye[1] + yz*eye[2]);
  m[14] = -(zx*eye[0] + zy*eye[1] + zz*eye[2]);
  m[15] = 1;
  return m;
}

function _composeRtcModelView(viewF64, anchorF64, modelLocal) {
  // §planet-spec Phase 2 -- compose mv_rtc = view * translate(anchor)
  // * model_local in f64, downcast to Float32Array for upload.
  //
  //   viewF64   = plain JS Array(16) from _mat4LookAtF64
  //   anchorF64 = { x, y, z }    OR null (treated as origin)
  //   modelLocal = Float32Array(16) (the mesh's local transform; can
  //                                  be reused legacy m.transform when
  //                                  anchorF64 represents the world
  //                                  origin and vertices are already
  //                                  in world coords).
  //
  // view * translate(anchor): only the translation column changes.
  // Columns 0..2 = view columns 0..2 (the rotation block is preserved).
  // Column 3 = view * vec4(anchor.x, anchor.y, anchor.z, 1).
  const ax = anchorF64 ? anchorF64.x : 0;
  const ay = anchorF64 ? anchorF64.y : 0;
  const az = anchorF64 ? anchorF64.z : 0;
  const vt = new Array(16);
  vt[0]  = viewF64[0];  vt[1]  = viewF64[1];  vt[2]  = viewF64[2];  vt[3]  = viewF64[3];
  vt[4]  = viewF64[4];  vt[5]  = viewF64[5];  vt[6]  = viewF64[6];  vt[7]  = viewF64[7];
  vt[8]  = viewF64[8];  vt[9]  = viewF64[9];  vt[10] = viewF64[10]; vt[11] = viewF64[11];
  vt[12] = viewF64[0]*ax + viewF64[4]*ay + viewF64[8] *az + viewF64[12];
  vt[13] = viewF64[1]*ax + viewF64[5]*ay + viewF64[9] *az + viewF64[13];
  vt[14] = viewF64[2]*ax + viewF64[6]*ay + viewF64[10]*az + viewF64[14];
  vt[15] = viewF64[3]*ax + viewF64[7]*ay + viewF64[11]*az + viewF64[15];
  // vt * modelLocal -- final 4x4 multiply, still in f64.
  const mv = new Array(16);
  _mat4Multiply(mv, vt, modelLocal);
  // Downcast to Float32Array at the very last moment.
  return Float32Array.from(mv);
}

function _mat4Perspective(fovYRad, aspect, near, far) {
  // WebGPU clip space: z in [0,1].
  // §planet-spec Phase 1 -- reverse-Z. The near plane now maps to
  // ndc_z = 1, far plane to ndc_z = 0. f32 depth precision is
  // distributed near-uniformly across the range instead of being
  // 99% bunched up at the near plane like the standard mapping; with
  // depth32float + reverse-Z, near=0.1 / far=1e8 z-fights becomes
  // a non-issue. Paired with depthCompare: "greater" and
  // depthClearValue: 0.0 in the pipeline + pass setup.
  const f = 1.0 / Math.tan(fovYRad * 0.5);
  const m = new Float32Array(16);
  const nf = 1.0 / (near - far);
  m[0]  = f / aspect;
  m[5]  = f;
  m[10] = -near * nf;          // (near)/(far - near)
  m[11] = -1;
  m[14] = -near * far * nf;    // (near*far)/(far - near)
  return m;
}

/* Sprint 7.5.3b -- elementary affine transforms. Each returns a fresh
 * Float32Array(16) in column-major order. Compose via _mat4Multiply
 * to build chained model matrices. Standard right-handed coordinate
 * system; rotation angles in RADIANS (degrees converted at the node
 * boundary via DEG_TO_RAD). */
function _mat4Translate(x, y, z) {
  const m = _mat4Identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

function _mat4Scale(sx, sy, sz) {
  const m = new Float32Array(16);
  m[0] = sx; m[5] = sy; m[10] = sz; m[15] = 1;
  return m;
}

function _mat4RotateX(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = c;  m[6] = s;
  m[9] = -s; m[10] = c;
  m[15] = 1;
  return m;
}

function _mat4RotateY(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = new Float32Array(16);
  m[0] = c;  m[2] = -s;
  m[5] = 1;
  m[8] = s;  m[10] = c;
  m[15] = 1;
  return m;
}

function _mat4RotateZ(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = new Float32Array(16);
  m[0] = c;  m[1] = s;
  m[4] = -s; m[5] = c;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function _mat4Ortho(left, right, bottom, top, near, far) {
  const m = new Float32Array(16);
  const lr = 1.0 / (left - right);
  const bt = 1.0 / (bottom - top);
  const nf = 1.0 / (near - far);
  m[0]  = -2 * lr;
  m[5]  = -2 * bt;
  m[10] = nf;                  // z maps to [0, 1] in WebGPU clip space
  m[12] = (left + right) * lr;
  m[13] = (top + bottom) * bt;
  m[14] = near * nf;
  m[15] = 1;
  return m;
}

/* Resolve a Camera node's params + return a small {viewMat, projMat,
 * viewProj} object. Called by Scene's encode pass; cached by frame
 * via Visual._frameCameraCache so multiple Scenes wired to the same
 * Camera don't recompute the matrices. The cache is cleared at the
 * top of each frame in renderVisualFrame. */
function _evaluateCamera(cameraNode, fbW, fbH) {
  // Sprint 7.5.3a -- resolve wired param inputs first so external
  // sources (Slider, MasterClock, Sin/Cos chains, OscIn, etc) can
  // drive camera position / orientation / fov in real time. Falls
  // back to the node's static params for unwired inputs.
  const p = cameraNode ? _resolveNodeParams(cameraNode) : {};
  const px = (typeof p.posX === "number") ? p.posX : 0;
  const py = (typeof p.posY === "number") ? p.posY : 0;
  const pz = (typeof p.posZ === "number") ? p.posZ : 5;
  const tx = (typeof p.targetX === "number") ? p.targetX : 0;
  const ty = (typeof p.targetY === "number") ? p.targetY : 0;
  const tz = (typeof p.targetZ === "number") ? p.targetZ : 0;
  const ux = (typeof p.upX === "number") ? p.upX : 0;
  const uy = (typeof p.upY === "number") ? p.upY : 1;
  const uz = (typeof p.upZ === "number") ? p.upZ : 0;
  const fov = (typeof p.fov === "number") ? p.fov : 60;
  const near = (typeof p.near === "number") ? p.near : 0.1;
  const far  = (typeof p.far  === "number") ? p.far  : 100;
  const mode = (typeof p.mode === "number") ? p.mode : 0;   // 0 = perspective, 1 = ortho
  const aspect = Math.max(0.01, fbW / Math.max(1, fbH));
  const view = _mat4LookAt([px, py, pz], [tx, ty, tz], [ux, uy, uz]);
  // §planet-spec Phase 2 -- also retain the view matrix as plain
  // JS Numbers (f64) so RTC-aware draws can compose ModelView in
  // f64 before downcasting. Cheap (16 multiplies); same math as
  // the f32 view, just no Float32Array downcast.
  const viewF64 = _mat4LookAtF64([px, py, pz], [tx, ty, tz], [ux, uy, uz]);
  let proj;
  if (mode === 1) {
    // Ortho: scale fov-equivalent vertical half-height by 1 unit at
    // distance 1, so an 'orthoSize' param of N means the view is N
    // world-units tall.
    const size = (typeof p.orthoSize === "number") ? p.orthoSize : 4;
    proj = _mat4Ortho(-size * aspect, size * aspect, -size, size, near, far);
  } else {
    proj = _mat4Perspective(fov * 0.01745329251994, aspect, near, far);
  }
  const viewProj = new Float32Array(16);
  _mat4Multiply(viewProj, proj, view);
  // Sprint 7.5.4.c-sky -- camera basis vectors + tan(fov/2) for the
  // background sky pass to reconstruct world-space rays from screen
  // coords. Derived from the same eye/target/up the view matrix is
  // built from so they match exactly.
  let fx = tx - px, fy = ty - py, fz = tz - pz;
  let flen = Math.hypot(fx, fy, fz) || 1.0;
  fx /= flen; fy /= flen; fz /= flen;
  let rx = fy * uz - fz * uy;
  let ry = fz * ux - fx * uz;
  let rz = fx * uy - fy * ux;
  let rlen = Math.hypot(rx, ry, rz) || 1.0;
  rx /= rlen; ry /= rlen; rz /= rlen;
  const uxC = ry * fz - rz * fy;
  const uyC = rz * fx - rx * fz;
  const uzC = rx * fy - ry * fx;
  const tanHalfFov = (mode === 1) ? 1.0 : Math.tan(fov * 0.01745329251994 * 0.5);
  // Sprint 5.10 -- 6-plane frustum extracted from the view-projection
  // matrix. Each plane is (a, b, c, d) with normal (a, b, c) pointing
  // INSIDE the frustum; a point is inside iff a*x + b*y + c*z + d >= 0
  // for ALL planes. Standard derivation: combine rows of viewProj.
  //   left   = row3 + row0
  //   right  = row3 - row0
  //   bottom = row3 + row1
  //   top    = row3 - row1
  //   near   = row2          (WebGPU clip z in [0, 1])
  //   far    = row3 - row2
  // viewProj is stored column-major (mat[col][row]) -- "row k" is
  // viewProj[k], viewProj[k+4], viewProj[k+8], viewProj[k+12].
  const vp = viewProj;
  const r0x = vp[0], r0y = vp[4], r0z = vp[8],  r0w = vp[12];
  const r1x = vp[1], r1y = vp[5], r1z = vp[9],  r1w = vp[13];
  const r2x = vp[2], r2y = vp[6], r2z = vp[10], r2w = vp[14];
  const r3x = vp[3], r3y = vp[7], r3z = vp[11], r3w = vp[15];
  const planes = new Float32Array(24);
  // left
  planes[0]  = r3x + r0x; planes[1]  = r3y + r0y; planes[2]  = r3z + r0z; planes[3]  = r3w + r0w;
  // right
  planes[4]  = r3x - r0x; planes[5]  = r3y - r0y; planes[6]  = r3z - r0z; planes[7]  = r3w - r0w;
  // bottom
  planes[8]  = r3x + r1x; planes[9]  = r3y + r1y; planes[10] = r3z + r1z; planes[11] = r3w + r1w;
  // top
  planes[12] = r3x - r1x; planes[13] = r3y - r1y; planes[14] = r3z - r1z; planes[15] = r3w - r1w;
  // near
  planes[16] = r2x;       planes[17] = r2y;       planes[18] = r2z;       planes[19] = r2w;
  // far
  planes[20] = r3x - r2x; planes[21] = r3y - r2y; planes[22] = r3z - r2z; planes[23] = r3w - r2w;
  return {
    view, proj, viewProj, eye: [px, py, pz],
    // §planet-spec Phase 2 -- f64-precision sibling fields for RTC.
    // `eye` (f32 array) stays for back-compat; `eyeF64` is the
    // canonical world-space camera position consumers should pair
    // with mesh.anchorF64 in _composeRtcModelView. `viewF64` is the
    // matching view matrix in f64.
    eyeF64: { x: px, y: py, z: pz },
    viewF64,
    camRight:   [rx,  ry,  rz,  tanHalfFov * aspect],
    camUp:      [uxC, uyC, uzC, tanHalfFov],
    camForward: [fx,  fy,  fz,  (mode === 1) ? 1 : 0],
    // 5.10 -- 6 frustum planes for cull testing. Float32Array(24)
    // packed as 6 × vec4(a,b,c,d). Order: L/R/B/T/N/F.
    frustumPlanes: planes
  };
}

/* Sprint 8.0.2-e -- OrthoCamera2D pre-pass. Translates the 2D node's
 * high-level params (posX, posY, orthoSize, pixelSnap) into the
 * Camera-shape fields _evaluateCamera reads (target, up, mode=1,
 * orthoSize). pixelSnap quantizes the posX/posY to the nearest
 * 1/pixelsPerUnit to eliminate sub-pixel shimmer for retro art.
 *
 * Sets posZ=0, target = (posX, posY, posZ-1) so forward is -Z and
 * up is +Y -- standard 2D screen convention (X right, Y up, Z out
 * of screen). orthoSize feeds the ortho half-height directly. */
function _syncOrthoCamera2D(node, fbW, fbH) {
  const p = _resolveNodeParams(node);
  const np = node.params || (node.params = {});
  const snap = (typeof p.pixelSnap === "number") ? p.pixelSnap : 1;
  const ppu  = (typeof p.pixelsPerUnit === "number" && p.pixelsPerUnit > 0) ? p.pixelsPerUnit : 32;
  let px = (typeof p.posX === "number") ? p.posX : 0;
  let py = (typeof p.posY === "number") ? p.posY : 0;
  if (snap >= 0.5) {
    px = Math.round(px * ppu) / ppu;
    py = Math.round(py * ppu) / ppu;
  }
  np.posX    = px;
  np.posY    = py;
  np.posZ    = 0;
  np.targetX = px;
  np.targetY = py;
  np.targetZ = -1;
  np.upX     = 0; np.upY = 1; np.upZ = 0;
  np.mode    = 1;
  np.fov     = 60;
  // orthoSize already lives in params; _evaluateCamera reads it.
}

/* Sprint 8.0.2-e -- OrthoCamera25D pre-pass. Translates the angle
 * preset (or custom yaw/pitch) + focus point (posX/Y/Z) + distance
 * into a full Camera-shape (posX/Y/Z = camera position, targetX/Y/Z =
 * focus point, upX/Y/Z, mode=1, orthoSize).
 *
 * forward = (cos(pitch)*sin(yaw), -sin(pitch), -cos(pitch)*cos(yaw))
 *   ... yaw rotates around +Y, pitch tilts down toward target.
 * camera = focus - forward * distance.
 *
 * The convention is: yaw=0 + pitch=0 looks toward -Z; yaw=+90° rotates
 * the camera right (looks toward +X); pitch=+90° looks straight down. */
function _syncOrthoCamera25D(node) {
  const p = _resolveNodeParams(node);
  const np = node.params || (node.params = {});
  const angle = (typeof p.angle === "string") ? p.angle : "iso";
  let yawDeg, pitchDeg;
  if (angle === "iso")             { yawDeg = 45; pitchDeg = 30; }
  else if (angle === "iso-narrow") { yawDeg = 30; pitchDeg = 45; }
  else if (angle === "top-down")   { yawDeg =  0; pitchDeg = 90; }
  else if (angle === "side")       { yawDeg =  0; pitchDeg =  0; }
  else                              { // "custom"
    yawDeg   = (typeof p.yaw   === "number") ? p.yaw   : 45;
    pitchDeg = (typeof p.pitch === "number") ? p.pitch : 30;
  }
  const yawR   = yawDeg   * 0.01745329251994;
  const pitchR = pitchDeg * 0.01745329251994;
  const cy = Math.cos(yawR),   sy = Math.sin(yawR);
  const cp = Math.cos(pitchR), sp = Math.sin(pitchR);
  // forward (unit, from camera toward focus)
  const fx =  cp * sy;
  const fy = -sp;
  const fz = -cp * cy;
  const fx0 = (typeof p.posX === "number") ? p.posX : 0;
  const fy0 = (typeof p.posY === "number") ? p.posY : 0;
  const fz0 = (typeof p.posZ === "number") ? p.posZ : 0;
  const dist = (typeof p.distance === "number" && p.distance > 0) ? p.distance : 20;
  np.targetX = fx0;
  np.targetY = fy0;
  np.targetZ = fz0;
  np.posX    = fx0 - fx * dist;
  np.posY    = fy0 - fy * dist;
  np.posZ    = fz0 - fz * dist;
  np.upX     = 0; np.upY = 1; np.upZ = 0;
  np.mode    = 1;
  np.fov     = 60;
  // orthoSize already in params; _evaluateCamera reads it.
}

/* Resolve the camera wired into a Scene node's "camera" input. Falls
 * back to a default-pose camera object when nothing is wired so the
 * Scene still renders something instead of black. */
function _resolveSceneCamera(sceneNode, fbW, fbH) {
  if (!Visual._frameCameraCache) Visual._frameCameraCache = new Map();
  const wire = state.edges && state.edges.find(e =>
    e && e.to && e.to.node === sceneNode.id && e.to.port === "camera"
  );
  if (wire && wire.from) {
    const cached = Visual._frameCameraCache.get(wire.from.node);
    if (cached) return cached;
    const src = state.nodes.find(n => n && n.id === wire.from.node);
    if (src && (
      src.type === "Camera" || src.type === "FPCamera" ||
      src.type === "OrthoCamera2D" || src.type === "OrthoCamera25D" ||
      src.type === "ThirdPersonCamera"
    )) {
      // §8.0.2-e -- OrthoCamera2D/25D synthesize the Camera-shape
      // fields (target, up, mode, fov, etc) from their high-level
      // params (anchor + angle preset / pixel snap) before
      // _evaluateCamera runs its standard matrix math.
      if (src.type === "OrthoCamera2D")  _syncOrthoCamera2D(src, fbW, fbH);
      if (src.type === "OrthoCamera25D") _syncOrthoCamera25D(src);
      const c = _evaluateCamera(src, fbW, fbH);
      Visual._frameCameraCache.set(wire.from.node, c);
      return c;
    }
  }
  // No camera wired -- synthesize a sensible default so 3D content
  // still appears for users who haven't wired a Camera yet.
  return _evaluateCamera({ params: {} }, fbW, fbH);
}

/* Sprint 7.5.3b -- build the local mat4 for a mesh-transform node.
 * Reads the node's params (or wired-in scalar inputs via
 * _resolveNodeParams) and returns the appropriate affine. Identity
 * for unknown node types. */
const _DEG_TO_RAD = Math.PI / 180.0;

function _buildTransformMatrix(node) {
  const p = _resolveNodeParams(node);
  if (node.type === "Translate") {
    const x = (typeof p.x === "number") ? p.x : 0;
    const y = (typeof p.y === "number") ? p.y : 0;
    const z = (typeof p.z === "number") ? p.z : 0;
    return _mat4Translate(x, y, z);
  }
  if (node.type === "Scale") {
    const u = (typeof p.uniform === "number") ? p.uniform : 0;
    if (u !== 0) return _mat4Scale(u, u, u);     // uniform != 0 overrides
    const x = (typeof p.x === "number") ? p.x : 1;
    const y = (typeof p.y === "number") ? p.y : 1;
    const z = (typeof p.z === "number") ? p.z : 1;
    return _mat4Scale(x, y, z);
  }
  if (node.type === "Rotate") {
    const ax = ((typeof p.angleX === "number") ? p.angleX : 0) * _DEG_TO_RAD;
    const ay = ((typeof p.angleY === "number") ? p.angleY : 0) * _DEG_TO_RAD;
    const az = ((typeof p.angleZ === "number") ? p.angleZ : 0) * _DEG_TO_RAD;
    // Compose Rx then Ry then Rz so the user's intuition "first
    // angleX, then angleY, then angleZ" matches the result (vertex
    // sees Rz * Ry * Rx * v = inner-most rotation first).
    const mx = _mat4RotateX(ax);
    const my = _mat4RotateY(ay);
    const mz = _mat4RotateZ(az);
    const tmp = new Float32Array(16);
    const out = new Float32Array(16);
    _mat4Multiply(tmp, my, mx);
    _mat4Multiply(out, mz, tmp);
    return out;
  }
  return _mat4Identity();
}

/* Walk a Scene node's mesh* inputs + return an array of {node, def,
 * transform} entries for each wired mesh source. transform is the
 * accumulated model matrix from the chain of mesh-transform nodes
 * between the Scene and the leaf mesh-gen.
 *
 * Chain semantics (matching the standard scene-graph convention):
 *   leaf-gen → T_inner → T_middle → T_outer → Scene
 * yields a model matrix of M = T_outer · T_middle · T_inner, so the
 * inner-most transform is applied to vertices FIRST. e.g.
 *   Box → Rotate(45deg Y) → Translate(2, 0, 0) → Scene
 * rotates the box around its own origin, THEN translates it out --
 * a satellite-style orbit rather than a swing-around-a-point.
 *
 * To get the "swing around the world origin" behavior, flip the chain:
 *   Box → Translate(2, 0, 0) → Rotate(45deg Y) → Scene
 *
 * Cycle guard at depth 16 -- meshes never chain that deep in practice
 * but a malformed save (self-referential transform) would loop forever
 * without it. */
const _MESH_CHAIN_DEPTH_LIMIT = 16;

function _walkMeshChain(nodeId, accMat, accMaterial, depth) {
  if (depth > _MESH_CHAIN_DEPTH_LIMIT) {
    console.warn("[scene] mesh chain depth limit hit at node " + nodeId + " -- cycle?");
    return null;
  }
  const node = state.nodes.find(n => n && n.id === nodeId);
  if (!node) return null;
  const def = TYPES[node.type];
  if (!def) return null;
  if (def.kind === "mesh-gen") {
    return { node, def, transform: accMat, material: accMaterial };
  }
  if (def.kind === "mesh-transform") {
    const local = _buildTransformMatrix(node);
    // accMat is the world-side accumulator (closer to Scene); we
    // multiply local into the RIGHT side so leaf-side transforms
    // end up rightmost in the product (applied first to vertices).
    const next = new Float32Array(16);
    _mat4Multiply(next, accMat, local);
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "mesh"
    );
    if (!wire || !wire.from) return null;
    return _walkMeshChain(wire.from.node, next, accMaterial, depth + 1);
  }
  if (def.kind === "material") {
    // Sprint 7.5.3c -- material wrapper. The inner mesh is rendered
    // with this material's surface shader. Outer material wins if
    // multiple are stacked (closest to Scene -- the outermost
    // wrapper -- is the one that applies). accMaterial is set on
    // first encounter walking root-to-leaf; subsequent (inner)
    // material wrappers are ignored.
    const myMaterial = accMaterial || _buildMaterialDescriptor(node);
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "mesh"
    );
    if (!wire || !wire.from) return null;
    return _walkMeshChain(wire.from.node, accMat, myMaterial, depth + 1);
  }
  return null;
}

/* Resolve the params of a material node into a flat descriptor used
 * by _encodeScenePass. Material types: "unlit", "phong". */
function _buildMaterialDescriptor(matNode) {
  const p = _resolveNodeParams(matNode);
  if (matNode.type === "UnlitMat") {
    return {
      type: "unlit",
      params: {
        r: (typeof p.r === "number") ? p.r : 1.0,
        g: (typeof p.g === "number") ? p.g : 1.0,
        b: (typeof p.b === "number") ? p.b : 1.0,
        vertexMix: (typeof p.vertexMix === "number") ? p.vertexMix : 0.0
      }
    };
  }
  if (matNode.type === "PhongMat") {
    return {
      type: "phong",
      params: {
        r: (typeof p.r === "number") ? p.r : 0.85,
        g: (typeof p.g === "number") ? p.g : 0.85,
        b: (typeof p.b === "number") ? p.b : 0.92,
        vertexMix: (typeof p.vertexMix === "number") ? p.vertexMix : 0.0,
        shininess: (typeof p.shininess === "number") ? Math.max(1.0, p.shininess) : 32.0,
        ambient:   (typeof p.ambient   === "number") ? p.ambient   : 0.15
      }
    };
  }
  if (matNode.type === "PhysicalMat") {
    return {
      type: "pbr",
      node: matNode,            // A.4 -- needed so the draw loop can read map params + cache loaded views
      params: {
        r: (typeof p.r === "number") ? p.r : 0.85,
        g: (typeof p.g === "number") ? p.g : 0.85,
        b: (typeof p.b === "number") ? p.b : 0.85,
        vertexMix: (typeof p.vertexMix === "number") ? p.vertexMix : 0.0,
        metallic:  (typeof p.metallic  === "number") ? Math.max(0, Math.min(1, p.metallic))  : 0.0,
        roughness: (typeof p.roughness === "number") ? Math.max(0.04, Math.min(1, p.roughness)) : 0.5,
        uvScale:   (typeof p.uvScale   === "number" && p.uvScale > 0) ? p.uvScale : 1.0
      }
    };
  }
  if (matNode.type === "TerrainMaterial") {
    return {
      type: "terrain",
      params: {
        // Slot map: read by the writer in _encodeScenePass. Default
        // values match the Terrain node's default -hs..0 Y range
        // with peaks at 0 (heightScale=12, yOffset=0).
        color1R: (typeof p.color1R === "number") ? p.color1R : 0.85,
        color1G: (typeof p.color1G === "number") ? p.color1G : 0.78,
        color1B: (typeof p.color1B === "number") ? p.color1B : 0.55,
        alt1:    (typeof p.alt1    === "number") ? p.alt1    : -8,
        color2R: (typeof p.color2R === "number") ? p.color2R : 0.40,
        color2G: (typeof p.color2G === "number") ? p.color2G : 0.55,
        color2B: (typeof p.color2B === "number") ? p.color2B : 0.30,
        alt2:    (typeof p.alt2    === "number") ? p.alt2    : -4,
        color3R: (typeof p.color3R === "number") ? p.color3R : 0.45,
        color3G: (typeof p.color3G === "number") ? p.color3G : 0.40,
        color3B: (typeof p.color3B === "number") ? p.color3B : 0.35,
        alt3:    (typeof p.alt3    === "number") ? p.alt3    : -1,
        color4R: (typeof p.color4R === "number") ? p.color4R : 0.92,
        color4G: (typeof p.color4G === "number") ? p.color4G : 0.94,
        color4B: (typeof p.color4B === "number") ? p.color4B : 0.98,
        softness:       (typeof p.softness       === "number") ? p.softness       : 1.0,
        slopeRockiness: (typeof p.slopeRockiness === "number") ? p.slopeRockiness : 1.5,
        shininess:      (typeof p.shininess      === "number") ? Math.max(1, p.shininess) : 8.0,
        ambient:        (typeof p.ambient        === "number") ? p.ambient        : 0.22,
        vertexMix:      (typeof p.vertexMix      === "number") ? p.vertexMix      : 0.0,
        // v0.3.129 v2 detail + bump + snow-mask knobs.
        detailScale:    (typeof p.detailScale    === "number") ? p.detailScale    : 0.5,
        detailStrength: (typeof p.detailStrength === "number") ? p.detailStrength : 0.35,
        microScale:     (typeof p.microScale     === "number") ? p.microScale     : 3.0,
        microStrength:  (typeof p.microStrength  === "number") ? p.microStrength  : 0.20,
        edgeJitter:     (typeof p.edgeJitter     === "number") ? p.edgeJitter     : 1.5,
        bumpStrength:   (typeof p.bumpStrength   === "number") ? p.bumpStrength   : 0.4,
        snowMaskAmount: (typeof p.snowMaskAmount === "number") ? p.snowMaskAmount : 0.8
      }
    };
  }
  if (matNode.type === "ShaderMat") {
    // Sprint 7.5.3c -- preset name from the enum index. The
    // matParams slots get reinterpreted here: shininess=time,
    // ambient=freq, metallic=intensity, roughness=texLayer (for
    // the "texture" preset; unused otherwise). The descriptor
    // stores them under their legacy names so the _encodeScenePass
    // writer works unchanged.
    const presetIdx = (typeof p.preset === "number") ? Math.floor(p.preset) : 0;
    const presetName = _SHADERMAT_PRESET_NAMES[presetIdx] || _SHADERMAT_PRESET_NAMES[0];
    return {
      type: "shadermat-" + presetName,
      node: matNode,            // sprint 7.5.3c push 5 -- needed for texture-input lookup at encode time
      params: {
        r: (typeof p.r === "number") ? p.r : 0.7,
        g: (typeof p.g === "number") ? p.g : 0.85,
        b: (typeof p.b === "number") ? p.b : 1.0,
        vertexMix: 0,
        shininess: (typeof p.time      === "number") ? p.time      : 0,
        ambient:   (typeof p.freq      === "number") ? p.freq      : 1.0,
        metallic:  (typeof p.intensity === "number") ? p.intensity : 1.0,
        roughness: 0
      }
    };
  }
  return null;
}

/* Sprint Level2D Phase 1a -- expand a Level2D into per-layer
 * synthetic mesh entries. Each entry looks (to the rest of the
 * encoder) like a regular Tilemap2D / ParallaxLayer2D / SpriteScatter2D
 * node, so all existing mesh + sprite pipeline paths work unchanged.
 * Synthetic node IDs are stable per (parentId, layerIdx) so
 * Visual.meshBufferCache keys stay stable across renders.
 *
 * Returns an array of mesh entries (same shape as `resolved` in
 * _resolveSceneMeshes). Empty array if the layers JSON is empty
 * or malformed (logs the parse error once per node). */
function _expandLevel2DLayers(levelNode, baseTransform, baseMaterial) {
  if (!levelNode) return [];
  const def = TYPES[levelNode.type];
  if (!def) return [];
  // Phase 5a -- use the cached parsed layers so gameplay-tick
  // mutations (PickupCollector clearing '4' cells, etc) persist
  // across frames instead of being overwritten by a fresh parse.
  const layers = _level2dParsedLayers(levelNode);
  if (!Array.isArray(layers) || layers.length === 0) return [];
  // Camera resolution: if Level2D.camera is wired, use it; else
  // fall back to the first OrthoCamera2D / Camera in the patch.
  // (Same fallback logic ParallaxLayer2D used standalone.)
  let camNodeId = null;
  if (Array.isArray(state.edges)) {
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === levelNode.id && e.to.port === "camera"
    );
    if (wire && wire.from) {
      const src = state.nodes.find(n => n && n.id === wire.from.node);
      if (src) camNodeId = src.id;
    }
  }
  if (!camNodeId) {
    const cam = state.nodes.find(n => n && (n.type === "OrthoCamera2D" || n.type === "Camera" || n.type === "FPCamera"));
    if (cam) camNodeId = cam.id;
  }
  const out = [];
  const TYPE_MAP = {
    tilemap:  "Tilemap2D",
    parallax: "ParallaxLayer2D",
    scatter:  "SpriteScatter2D"
  };
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer || typeof layer !== "object") continue;
    const synthType = TYPE_MAP[layer.type];
    if (!synthType) {
      console.warn("[Level2D " + levelNode.id + "] layer " + i + " unknown type: " + layer.type);
      continue;
    }
    // Phase 4a -- chunk tilemap layers above the threshold. Each
    // chunk becomes its own synthetic Tilemap2D node with its own
    // mesh cache entry, so a 1000-col level only rebuilds the
    // chunks the user actually edits, and empty chunks (all '.')
    // emit no mesh at all -- the cheap part of sparse maps.
    if (layer.type === "tilemap") {
      const chunked = _expandTilemapLayerChunks(levelNode, layer, i, camNodeId, baseTransform, baseMaterial);
      if (chunked) {
        for (const e of chunked) out.push(e);
        continue;
      }
    }
    // Default path: emit a single synthetic node for the whole layer.
    const synthId = levelNode.id + ":lyr" + i + ":" + synthType;
    const synthParams = Object.assign({}, layer);
    delete synthParams.type;
    delete synthParams.name;
    delete synthParams.collides;
    const synthNode = {
      id: synthId,
      type: synthType,
      params: synthParams,
      _isSynthetic: true,
      _levelLayer: layer,
      _levelParentId: levelNode.id,
      _levelCameraNodeId: camNodeId
    };
    out.push({
      node: synthNode,
      def: TYPES[synthType],
      transform: baseTransform,
      material: baseMaterial,
      _level2DLayer: true,
      _level2DLayerName: layer.name || ("layer" + i)
    });
  }
  return out;
}

/* Phase 4a -- split a tilemap layer's tileData into fixed-size
 * cell chunks, each emitted as its own synthetic Tilemap2D node.
 *
 * Returns:
 *   null               -- layer is small enough to stay single-mesh
 *   [synthEntries...]  -- one entry per non-empty chunk
 *
 * Chunk size is 64x64 cells (~4 KB of verts in the worst case);
 * threshold to chunk at all is 4096 cells total (so a typical
 * 17x8 demo map stays single-mesh, but a 170x80 or 1000x80 map
 * splits into manageable buffers).
 *
 * Empty chunks (every cell is '.' or ' ') emit nothing -- crucial
 * for sparse maps where most of the world is sky. */
const _LVL_TILEMAP_CHUNK_THRESHOLD = 4096;   // total cells; below this stay single-mesh
const _LVL_TILEMAP_CHUNK_W = 64;
const _LVL_TILEMAP_CHUNK_H = 64;

function _expandTilemapLayerChunks(levelNode, layer, layerIdx, camNodeId, baseTransform, baseMaterial) {
  const tileData = (typeof layer.tileData === "string") ? layer.tileData : "";
  if (!tileData.length) return null;
  const rowsArr = tileData.split("\n");
  const parentRows = rowsArr.length;
  const parentCols = rowsArr.reduce((m, r) => Math.max(m, r.length), 0);
  if (parentCols === 0) return null;
  if (parentRows * parentCols <= _LVL_TILEMAP_CHUNK_THRESHOLD) return null;
  const ts = (typeof layer.tileSize === "number" && layer.tileSize > 0) ? layer.tileSize : 1;
  const ox = (typeof layer.originX === "number") ? layer.originX : 0;
  const oy = (typeof layer.originY === "number") ? layer.originY : 0;
  const cxParent = (parentCols - 1) * 0.5;
  const cyParent = (parentRows - 1) * 0.5;
  const chunkW = _LVL_TILEMAP_CHUNK_W;
  const chunkH = _LVL_TILEMAP_CHUNK_H;
  const nChunkX = Math.ceil(parentCols / chunkW);
  const nChunkY = Math.ceil(parentRows / chunkH);
  const out = [];
  let emitted = 0, skipped = 0;
  for (let cr = 0; cr < nChunkY; cr++) {
    const r0 = cr * chunkH;
    const r1 = Math.min(parentRows, r0 + chunkH);
    const thisChunkH = r1 - r0;
    for (let cc = 0; cc < nChunkX; cc++) {
      const c0 = cc * chunkW;
      const c1 = Math.min(parentCols, c0 + chunkW);
      const thisChunkW = c1 - c0;
      // Slice tileData for this chunk + check for empty.
      let chunkNonEmpty = false;
      const chunkLines = new Array(thisChunkH);
      for (let rr = 0; rr < thisChunkH; rr++) {
        const srcLine = rowsArr[r0 + rr] || "";
        const sub = srcLine.substring(c0, c1).padEnd(thisChunkW, ".");
        chunkLines[rr] = sub;
        if (!chunkNonEmpty) {
          for (let k = 0; k < sub.length; k++) {
            const ch = sub[k];
            if (ch !== "." && ch !== " ") { chunkNonEmpty = true; break; }
          }
        }
      }
      if (!chunkNonEmpty) { skipped++; continue; }
      // World origin for this chunk: position its center cell so that
      // the chunk's cells land at the SAME world positions as the
      // un-chunked parent would. Derivation in CLAUDE.md / Phase 4
      // commit: chunkOX = (cc*chunkW - cxParent + cxChunk) * ts + ox.
      const cxChunk = (thisChunkW - 1) * 0.5;
      const cyChunk = (thisChunkH - 1) * 0.5;
      const chunkOX = (c0 - cxParent + cxChunk) * ts + ox;
      const chunkOY = (cyParent - r0 - cyChunk) * ts + oy;
      const synthParams = Object.assign({}, layer);
      delete synthParams.type;
      delete synthParams.name;
      delete synthParams.collides;
      synthParams.tileData = chunkLines.join("\n");
      synthParams.originX  = chunkOX;
      synthParams.originY  = chunkOY;
      const synthId = levelNode.id + ":lyr" + layerIdx + ":c" + cr + "_" + cc + ":Tilemap2D";
      const synthNode = {
        id: synthId,
        type: "Tilemap2D",
        params: synthParams,
        _isSynthetic: true,
        _levelLayer: layer,
        _levelParentId: levelNode.id,
        _levelCameraNodeId: camNodeId,
        // Hooks for the upcoming Phase 4b frustum culling: precomputed
        // world AABB for this chunk so the dispatch can early-out
        // without re-parsing tileData. minY/maxY computed assuming
        // row 0 is at +Y (matches _buildTilemap2D's convention).
        _levelChunkBounds: {
          minX: chunkOX - thisChunkW * 0.5 * ts,
          maxX: chunkOX + thisChunkW * 0.5 * ts,
          minY: chunkOY - thisChunkH * 0.5 * ts,
          maxY: chunkOY + thisChunkH * 0.5 * ts
        }
      };
      out.push({
        node: synthNode,
        def: TYPES["Tilemap2D"],
        transform: baseTransform,
        material: baseMaterial,
        _level2DLayer: true,
        _level2DLayerName: (layer.name || ("layer" + layerIdx)) + ":c" + cr + "_" + cc
      });
      emitted++;
    }
  }
  if (!levelNode._lvlChunkLogged || levelNode._lvlChunkLogged !== parentRows + "x" + parentCols) {
    levelNode._lvlChunkLogged = parentRows + "x" + parentCols;
    console.log("[Level2D " + levelNode.id + "] lyr" + layerIdx + " chunked " +
      parentCols + "x" + parentRows + " into " + emitted + " non-empty + " + skipped + " empty (" +
      chunkW + "x" + chunkH + " cells per chunk)");
  }
  return out;
}

function _resolveSceneMeshes(sceneNode) {
  const meshes = [];
  const def = TYPES[sceneNode.type];
  if (!def || !Array.isArray(def.ins)) return meshes;
  for (const port of def.ins) {
    if (!port || port.t !== "mesh") continue;
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === sceneNode.id && e.to.port === port.n
    );
    if (!wire || !wire.from) continue;
    // Phase 8.A.5 -- Pool wires fan out into one mesh entry per
    // active voice. Pre-emptive check before the PrefabInstance
    // intercept since Pool is its own type.
    const poolSrc = state.nodes.find(n => n && n.id === wire.from.node);
    if (poolSrc && poolSrc.type === "Pool" && wire.from.port === "mesh") {
      const voiceEntries = _expandPoolVoices(poolSrc, _mat4Identity(), null);
      for (const e of voiceEntries) {
        if (e.node && !_isNodeActive(e.node)) continue;
        meshes.push(e);
      }
      continue;
    }
    // Phase 8.A.3 -- PrefabInstance wires pierce the abstraction:
    // a wire from instance.mesh redirects to the exposed child's
    // actual mesh port before _walkMeshChain runs.
    const prefabResolved = _prefabResolveFromEndpoint(wire);
    const startNodeId = prefabResolved ? prefabResolved.node : wire.from.node;
    const resolved = _walkMeshChain(startNodeId, _mat4Identity(), null, 0);
    if (!resolved) continue;
    // Phase 8.A.2-filtering: drop mesh chains rooted at a node in an
    // inactive stage. The leaf is the actual mesh source (Tilemap2D,
    // Sprite, Level2D, Box, etc); intermediate transforms don't have
    // stage tags. So gating on the leaf is enough.
    if (resolved.node && !_isNodeActive(resolved.node)) continue;
    // Level2D Phase 1a: expand into per-layer synthetic entries.
    // The Level2D node itself emits nothing; its layers become
    // independent mesh entries that the existing sprite + mesh
    // pipelines handle as if they were wired one-per-slot.
    if (resolved.node && resolved.node.type === "Level2D") {
      const layerEntries = _expandLevel2DLayers(resolved.node, resolved.transform, resolved.material);
      for (const e of layerEntries) meshes.push(e);
      continue;
    }
    meshes.push(resolved);

    // Phase 8 sprint 8-7b: when the resolved leaf is a PlanetMesh,
    // also synthesize a "detail patch" mesh entry beside it. The
    // patch entry borrows the PlanetMesh node's params (now hosting
    // the detail-patch knobs directly) so the user doesn't need to
    // wire a separate node.
    if (resolved.node && resolved.node.type === "PlanetMesh") {
      const pp = resolved.node.params || {};
      // Sprint 9-1: detail patch retired in favor of cube-sphere
      // quadtree (Phase 9). Default off when param is missing; old
      // saves with explicit detailPatchEnabled=1 still synthesize.
      const enabled = (typeof pp.detailPatchEnabled === "number")
        ? pp.detailPatchEnabled >= 0.5
        : false;
      if (enabled) {
        meshes.push({
          node: resolved.node,
          def: resolved.def,
          transform: resolved.transform,
          material: resolved.material,
          isPlanetDetailPatch: true
        });
      }
    }
  }
  return meshes;
}

/* Phase 6.5.4 — JS-side MasterClock value computation. Mirrors the
 * C++ GammaMasterClock helper class (registry line ~9405) but uses
 * performance.now() as the time source instead of audio sample
 * counts. Returns a different shape per output port:
 *
 *   bpm                          → the static bpm param (constant)
 *   phase                        → 0..1 ramp within current beat
 *                                  (linear, matches C++ behavior)
 *   bar / beat / quarter /       → cubic-decay envelope per subdivision
 *   eighth / sixteenth             (1.0 at the rising edge, ~0 just
 *                                  before next edge). Different from
 *                                  the C++ form (which emits a
 *                                  one-sample 1.0 pulse) -- the
 *                                  envelope shape is more useful for
 *                                  shader uniforms than a sparse gate.
 *
 * Periods:
 *   bar       = 4 beats
 *   beat      = 1 beat
 *   quarter   = 1 beat  (quarter-note = beat; matches C++ naming)
 *   eighth    = 0.5 beat
 *   sixteenth = 0.25 beat
 *
 * Drift vs the audio-side C++ MasterClock: both sides use BPM-based
 * time math; the C++ side uses sample-accurate sampleCount/sampleRate,
 * we use wall-clock performance.now(). At 48 kHz typical clock-drift
 * is sub-ms per minute -- imperceptible for visuals. Sample-accurate
 * audio-driven sync (worklet writes ticks to SAB) is a follow-on
 * ticket once we have wasm-export plumbing. */
function _masterClockOutputValue(node, portName) {
  const bpm = Math.max(1, (node && node.params && typeof node.params.bpm === "number") ? node.params.bpm : 120);
  const startT = (typeof Visual !== "undefined" && Visual && Visual.startTime) ? Visual.startTime : 0;
  const tSec = (performance.now() - startT) * 0.001;
  const totalBeats = tSec * (bpm / 60.0);
  if (portName === "bpm")   return bpm;
  if (portName === "phase") return totalBeats - Math.floor(totalBeats);
  const fracOf = (period) => {
    const x = totalBeats / period;
    return x - Math.floor(x);
  };
  if (portName === "bar")       { const f = fracOf(4.0);   const m = 1.0 - f; return m * m * m; }
  if (portName === "beat")      { const f = fracOf(1.0);   const m = 1.0 - f; return m * m * m; }
  if (portName === "quarter")   { const f = fracOf(1.0);   const m = 1.0 - f; return m * m * m; }
  if (portName === "eighth")    { const f = fracOf(0.5);   const m = 1.0 - f; return m * m * m; }
  if (portName === "sixteenth") { const f = fracOf(0.25);  const m = 1.0 - f; return m * m * m; }
  return 0;
}

/* Phase 6.6.28 — wrap a node so its .params reads return the wire-
 * resolved values. Used to pass into def.writeUniforms + dynamic
 * wgsl functions without changing their (node, scratch) signature. */
function _nodeWithResolvedParams(node) {
  if (!node) return node;
  const resolved = _resolveNodeParams(node);
  // Object.assign here intentionally clones the node shallowly so we
  // don't mutate the user's patch state with a swapped .params.
  return Object.assign({}, node, { params: resolved });
}

function _resolveTextureInputLayer(node, portName, consumerVOId) {
  if (typeof state === "undefined" || !state ||
      !Array.isArray(state.edges) || !Array.isArray(state.nodes)) return -1;
  const incoming = state.edges.find(e =>
    e && e.to && e.to.node === node.id && e.to.port === portName
  );
  if (!incoming) return -1;
  const sourceNodeId = incoming.from && incoming.from.node;
  if (!sourceNodeId) return -1;
  // Phase 6.6.26 — first try the current frame's render plan
  // (scratch-layer assignments + direct-VO assignments). The plan
  // key is `${sourceNodeId}@${consumerVOId}` so we get the
  // pose-correct render of the source for this specific consumer.
  if (Visual._currentRenderPlan && consumerVOId) {
    const planEntry = Visual._currentRenderPlan.get(sourceNodeId + "@" + consumerVOId);
    if (planEntry && planEntry.layerIdx >= 0) return planEntry.layerIdx;
  }
  // Legacy fallback (pre-6.6.26): direct downstream VisualOutput on
  // the source itself. Only matters if the plan didn't capture it
  // for some reason (e.g. called without consumerVOId).
  const vo = state.nodes.find(n =>
    n && n.type === "VisualOutput" &&
    state.edges.some(e =>
      e && e.from && e.from.node === sourceNodeId &&
      e.to && e.to.node === n.id && e.to.port === "in"
    )
  );
  if (!vo) return -1;
  let layerIdx = (vo.params && typeof vo.params.display === "number")
    ? (vo.params.display | 0) : 0;
  if (layerIdx < 0) layerIdx = 0;
  const layerCount = (Visual.framebufferLayerViews &&
                      Visual.framebufferLayerViews.length) || 1;
  if (layerIdx >= layerCount) layerIdx = layerCount - 1;
  return layerIdx;
}

function _encodeShaderFragPassForVO(enc, vo, src, def, dtSec, layerIdx) {
  const layerView = Visual.framebufferLayerViews[layerIdx];
  if (!layerView) return false;
  // Phase 6.6.23 — pass the source node so def.wgsl can be a
  // (srcNode) => string function. Null inst means the dynamic
  // WGSL function threw or returned non-string; skip frame.
  // Phase 6.6.28 — substitute wire-resolved param values so the
  // dynamic WGSL function (e.g. Text's text param) sees live
  // Slider values, not just the manual fallback.
  const srcResolvedForInst = _nodeWithResolvedParams(src);
  const inst = _ensureShaderInstance(vo.id, def, srcResolvedForInst);
  if (!inst) return false;
  const entry = inst.pipelineEntry;
  if (!entry || !entry.pipeline) return false;

  // Pack uniforms — preamble (with this VO's display pose + a
  // per-consumer-set worldUv) first, then the registry-declared
  // writer for per-shader params. Note: writeUniforms receives the
  // SOURCE node (the shader producer) since that's where the
  // shader's params live; the VO is just the display routing target.
  //
  // u_world_uv is computed from the SHADER'S CONSUMER SET, not the
  // raw rig display slice. Solo consumer → (0,0,1,1) so the shader
  // renders full coverage on its display (one pinwheel = one full
  // pinwheel). Shared shader (multiple VOs wired to same source) →
  // each VO gets its slice within the consumer-set bbox so the
  // shader spans the connected displays correctly.
  const display = state.rig && state.rig.displays && state.rig.displays[layerIdx];
  const renderWuv = _renderWorldUvForVO(vo, src.id);
  _writeShaderPreamble(inst.scratch, dtSec, display, renderWuv, layerIdx);
  // Phase 6.6.28 — pass the wire-resolved src (computed above for
  // the dynamic WGSL function) to writeUniforms too. writeUniforms
  // sees node.params as the merged view (manual params + wired
  // Slider values), existing registry code is unchanged.
  if (typeof def.writeUniforms === "function") {
    def.writeUniforms(srcResolvedForInst, inst.scratch);
  }
  // Phase 6.6.24 — for each composition shader-frag with declared
  // texture input ports + a textureInputSlots map (port -> scratch
  // slot), resolve the wired source -> downstream-VO display layer
  // and OVERRIDE the slot writeUniforms just filled with its manual
  // default. Unwired ports leave the manual default in place so the
  // user can still type a layer index when no VO is downstream of
  // their source. textureInputSlots is opt-in per-def -- nodes that
  // don't declare it (most shader-frags) skip this entirely.
  const slotMap = def.textureInputSlots;
  if (slotMap && Array.isArray(def.ins)) {
    for (const port of def.ins) {
      if (!port || port.t !== "texture") continue;
      const slot = slotMap[port.n];
      if (typeof slot !== "number") continue;
      const resolved = _resolveTextureInputLayer(src, port.n, vo.id);
      if (resolved >= 0) inst.scratch[slot] = resolved;
    }
  }
  Visual.device.queue.writeBuffer(inst.uniformBuffer, 0, inst.scratch.buffer, inst.scratch.byteOffset, inst.scratch.byteLength);

  const pass = enc.beginRenderPass({
    label: "shader-frag-" + def.kind + "-" + src.type + "-vo-" + vo.id + "-layer-" + layerIdx,
    colorAttachments: [{
      view: layerView,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  pass.setPipeline(entry.pipeline);
  pass.setBindGroup(0, inst.bindGroup);
  pass.draw(3);
  pass.end();
  return true;
}

/* Encode a bare render pass that clears one framebuffer layer to
 * solid black. Used for layers that don't get a shader pass this
 * frame — either no VisualOutput targets them (orphan layers in a
 * multi-display rig with fewer VOs than displays) or the targeting
 * VO has no valid source (just disconnected, or source isn't a
 * shader-frag, or the pipeline is still compiling). Without this,
 * GPU texture memory persists across frames and the compositor
 * samples stale content — visible as "frozen on last input" after
 * disconnect. */
function _encodeLayerClear(enc, layerIdx) {
  const layerView = Visual.framebufferLayerViews[layerIdx];
  if (!layerView) return;
  enc.beginRenderPass({
    label: "fbo-layer-clear-" + layerIdx,
    colorAttachments: [{
      view: layerView,
      clearValue: { r: 0, g: 0, b: 0, a: 1.0 },
      loadOp: "clear",
      storeOp: "store"
    }]
  }).end();
}

/* Walk every VisualOutput in the patch and encode a render pass for
 * each that has a wired shader-frag source. ALSO clears any layer
 * that didn't receive a shader pass this frame (orphan layers OR
 * unsourced VOs) so disconnect-then-reconnect doesn't leak stale
 * content. Returns true whenever there's ≥ 1 VisualOutput in the
 * patch — composite runs in that case to show the rig grid with
 * black cells where appropriate. Returns false only when the patch
 * has zero VOs, in which case the legacy smoke-clear fallback path
 * takes over.
 *
 * Phase 6.5.6: same shader feeding multiple VOs runs N times, each
 * with display-specific uniforms. Pipeline cache hashes by WGSL so
 * all N share one compiled pipeline; only the bind groups + uniform
 * buffers differ. The user-confirmed "pinwheel spans two displays"
 * behavior comes from each shader pass reading its display's
 * u_world_uv slice and outputting the corresponding portion of the
 * shared world.
 *
 * Multi-stage chains (Gradient → Blur → VisualOutput) still need
 * intermediate textures + ping-pong FBO management — that's 6.3.2.
 * Today: VisualOutput.in must come directly from a shader-frag
 * source. */
function _encodeVisualGraph(enc, dtSec) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return false;
  const visualOutputs = state.nodes.filter(n => n.type === "VisualOutput");
  if (visualOutputs.length === 0) return false;
  const layerCount = Visual.framebufferLayerViews.length || 1;
  const renderedLayers = new Set();

  // Phase 6.6.30 — build the per-VO render plan + render schedules.
  // Each VO has its own ordered sequence of passes: scratch passes
  // (upstream composition inputs, rendered with THIS VO's pose) then
  // the VO's direct shader-frag pass. Scratch slots are RELATIVE
  // indices into Visual.scratchTexture (0..SCRATCH_BUDGET-1) and
  // get REUSED across consumer VOs -- consumer A's scratch passes
  // write the slots, A's composition reads them, then B's scratch
  // passes overwrite the same slots before B's composition reads.
  // Same-frame reads via the composition bind layout, so no 1-frame
  // lag and per-VO pose correctness even when one composition node
  // distributes to 26 displays.
  const planResult = _buildRenderPlan(visualOutputs);
  Visual._currentRenderPlan = planResult.plan;

  for (const vo of visualOutputs) {
    const schedule = planResult.schedules.get(vo.id) || [];
    for (const entry of schedule) {
      const ok = _encodeShaderFragPassForPlan(enc, entry, dtSec);
      if (ok && !entry.isScratch) renderedLayers.add(entry.layerIdx);
    }
  }

  // Clear every framebuffer layer that didn't get a shader pass this
  // frame — covers unwired VOs, orphan layers, pipeline-still-
  // compiling new shader-frags. Scratch slots don't need clearing
  // (next frame's per-VO render overwrites them, and unused ones
  // sample to whatever was there last — but no composition node
  // reads them unless wired, and unwired texture ports return the
  // manual layer-index fallback instead).
  for (let i = 0; i < layerCount; i++) {
    if (!renderedLayers.has(i)) _encodeLayerClear(enc, i);
  }
  return true;
}

