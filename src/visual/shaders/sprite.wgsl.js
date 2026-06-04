/* Sprint plat-2a-render -- sprite WGSL. Reuses the standard 11-float
 * vertex layout (pos3 + color3 + normal3 + uv2) so existing Sprite
 * meshes work unchanged; only the shader and bind-group layout change.
 *
 * The vertex shader composes modelViewProj from the per-draw uniform
 * and remaps the quad's [0,1] UV into the sub-rect for the current
 * frame in a spritesheet. flipX mirrors U for left-facing animations.
 *
 * The fragment shader samples the bound sprite texture, multiplies by
 * the per-draw tint, and outputs premultiplied alpha to match Scene's
 * blend state (srcFactor=ONE, dstFactor=ONE_MINUS_SRC_ALPHA).
 *
 * UV convention: the Sprite mesh builder emits UVs with (0,0) at the
 * BOTTOM-LEFT corner (consistent with the vertex order). Textures
 * have (0,0) at the TOP-LEFT (standard image convention). The shader
 * flips V (v_tex = 1 - v_mesh) so the visible sprite shows the image
 * right-side-up in screen space. */
const _SPRITE_WGSL = `
struct DrawU {
  modelViewProj: mat4x4<f32>,
  tint:          vec4<f32>,        // multiply through after texture sample
  frameMeta:     vec4<f32>,        // .x = frame, .y = framesX, .z = framesY, .w = flipX
};

@group(0) @binding(0) var<uniform> draw: DrawU;
@group(0) @binding(1) var spriteTex: texture_2d<f32>;
@group(0) @binding(2) var spriteSampler: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) tint: vec4<f32>,
};

@vertex
fn vs_sprite(
  @location(0) inPos: vec3<f32>,
  @location(1) inColor: vec3<f32>,
  @location(2) inNormal: vec3<f32>,
  @location(3) inUV: vec2<f32>,
) -> VsOut {
  var out: VsOut;
  out.pos = draw.modelViewProj * vec4<f32>(inPos, 1.0);

  let fx = max(draw.frameMeta.y, 1.0);
  let fy = max(draw.frameMeta.z, 1.0);
  let totalFrames = fx * fy;
  let frame = clamp(draw.frameMeta.x, 0.0, totalFrames - 1.0);
  let frameCol = floor(frame - floor(frame / fx) * fx);  // = frame % fx
  let frameRow = floor(frame / fx);
  let cellW = 1.0 / fx;
  let cellH = 1.0 / fy;

  // Sprite mesh UV: (0,0) bottom-left, (1,1) top-right.
  // Texture UV: (0,0) top-left. Flip V here so the bottom-left of the
  // SPRITE shows the bottom-left of the IMAGE (intuitive for level art).
  var u = inUV.x;
  let v = 1.0 - inUV.y;
  if (draw.frameMeta.w >= 0.5) { u = 1.0 - u; }
  out.uv = vec2<f32>(
    (frameCol + u) * cellW,
    (frameRow + v) * cellH
  );
  // Per-vertex color (from Sprite's tintR/G/B at build time) AND the
  // per-draw tint compose together. Both default to white so the
  // user can choose either path (build-time or animated).
  out.tint = vec4<f32>(inColor, 1.0) * draw.tint;
  return out;
}

@fragment
fn fs_sprite(in: VsOut) -> @location(0) vec4<f32> {
  let texColor = textureSample(spriteTex, spriteSampler, in.uv);
  let result = texColor * in.tint;
  // Premultiplied alpha output (matches mesh-pipeline blend state).
  return vec4<f32>(result.rgb * result.a, result.a);
}
`;

