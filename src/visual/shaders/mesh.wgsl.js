/* =========================================================================
 * Sprint 7.5.3a -- 3D mesh pipeline + Scene render pass
 *
 * Unlit vertex-color pipeline for the smoke-test phase. The vertex
 * shader transforms (model * viewProj) and passes a vec3 color
 * attribute through to the fragment shader. Sprint 7.5.3c replaces
 * this with materials (UnlitMat / PhongMat / PhysicalMat / ShaderMat).
 *
 * Pipeline state:
 *   vertex buffer:   (pos.xyz, color.rgb) interleaved float32
 *   topology:        triangle-list (mesh nodes drive this in 7.5.3b
 *                    when they pick e.g. triangle-strip for cylinder
 *                    sides)
 *   cull:            none (mesh sources control winding directly)
 *   depth-test:      less, depth-write enabled, depth32float
 *   blend:           premultiplied alpha (standard for video layers)
 *
 * The bind group layout has a single uniform buffer at @binding(0)
 * holding viewProj (mat4) + model (mat4) = 128 bytes. Per-mesh draws
 * overwrite the model portion + queue.writeBuffer before each draw. */
/* Sprint 7.5.3c -- mesh shader module with one vertex shader + three
 * fragment entry points so the pipeline cache can serve every
 * material flavor from a single compiled module. Vertex layout
 * grew to (pos.xyz, color.rgb, normal.xyz) -- 9 floats per vertex,
 * stride 36 bytes -- so Phong has real surface normals to dot
 * against the light direction. Normal is transformed by the model
 * matrix here (works for rotation + uniform scale + translation;
 * non-uniform scale gives slight inaccuracy, acceptable for sprint
 * scope). Per-Scene + per-draw uniforms are split: viewProj +
 * camera eye + light data stays constant for every draw in a
 * Scene; model matrix + material params change per mesh. */
const _MESH_WGSL =
`// Sprint 7.5.3c push 3 -- multi-light. Up to 4 lights per Scene
// (MAX_LIGHTS); each fragment loops over lightCount and accumulates
// contributions from each enabled light. Three supported types
// dispatched via pos.w:
//   0 = directional: pos.xyz is unit direction TO the light
//   1 = point:       pos.xyz is world position; falloff via params.x range
//   2 = spot:        pos.xyz is world position; spotDir.xyz is the spot's
//                    pointing direction; params.y/z are cos(innerAngle/2)
//                    + cos(outerAngle/2) for the cone-edge smooth falloff
struct Light {
  pos:     vec4<f32>,
  color:   vec4<f32>,
  params:  vec4<f32>,
  spotDir: vec4<f32>,
};

struct PerScene {
  viewProj:   mat4x4<f32>,
  eye:        vec4<f32>,        // .xyz = camera world position
  lightCount: vec4<f32>,        // .x = active light count (1..4)
  lights:     array<Light, 4>,
  // Sprint 7.5.4 -- environment / IBL. envParams.x is the mode:
  //   0 = no environment wired -> hardcoded blue-gray hemisphere-IBL
  //       fallback (matches pre-7.5.4 look so existing patches don't
  //       shift colors when the buffer layout grows).
  //   1 = GradientSky: 3-stop gradient driven by direction.y, with
  //       envSky.rgb at +Y, envHorizon.rgb at the equator, and
  //       envGround.rgb at -Y. envParams.y is intensity multiplier.
  //   2 = ProceduralSky (7.5.4.c): hand-tuned Rayleigh+Mie style
  //       scattering. envSun.xyz = direction TO the sun (computed
  //       JS-side from time-of-day), envSun.w = visibility in [0,1]
  //       (0 below horizon, smoothly 1 above). envParams.z =
  //       turbidity (haze; pushes color toward horizon tones),
  //       envParams.w = mieG (forward-scatter anisotropy, ~0.76).
  //       envSky/envHorizon/envGround unused for this mode.
  // Future modes (Skybox = 3, HDRI = 4) re-use the same shape, bind
  // a cubemap/equirect texture, and dispatch in sample_env.
  envParams:  vec4<f32>,
  envSky:     vec4<f32>,
  envHorizon: vec4<f32>,
  envGround:  vec4<f32>,
  envSun:     vec4<f32>,
  // Sprint 7.5.4.c-sky -- camera basis for the sky background pass.
  // Pre-computed JS-side from the same eye/target/up the viewProj
  // matrix uses, so the sky's reconstructed world ray matches what
  // the meshes are projected against. .w slots:
  //   camRight.w   = tan(fov/2) * aspect
  //   camUp.w      = tan(fov/2)
  //   camForward.w = 0 for perspective, 1 for ortho (ortho sky uses
  //                  a flat color from camForward direction).
  camRight:   vec4<f32>,
  camUp:      vec4<f32>,
  camForward: vec4<f32>,
  // Sprint 7.5.4.d -- volumetric-ish clouds. 2D fbm on a cloud plane
  // sampled per view ray. ProceduralSky resolver packs these; other
  // env sources leave them zero (no clouds shown).
  //   envCloudParams.x = coverage [0,1]
  //   envCloudParams.y = density multiplier (0 = clear sky)
  //   envCloudParams.z = wind X offset (= windSpeedX * elapsed_s)
  //   envCloudParams.w = wind Z offset (= windSpeedZ * elapsed_s)
  envCloudParams: vec4<f32>,
  // Sprint 7.5.4.e -- distance fog (Scene-level, not env-side).
  //   envFogParams.x  = density (Beer-Lambert e^(-density * dist))
  //   envFogParams.y  = start distance (no fog inside this)
  //   envFogParams.z  = height falloff (0 = uniform; >0 = ground fog)
  //   envFogParams.w  = autoPullEnv (>0.5 = sample env in camera-fwd
  //                    for fog color; otherwise use envFogColor.rgb)
  //   envFogColor.rgb = manual fog color
  envFogParams: vec4<f32>,
  envFogColor:  vec4<f32>,
  // Sprint 7.6.a-atm -- planet-aware atmosphere (Tier B single-
  // scattering Rayleigh+Mie). When envPlanet.w > 0 a planet is wired
  // in the scene and fs_sky switches from flat-ground scattering to
  // proper spherical integration through the atmosphere shell.
  //   envPlanet.xyz   = planet center (world space)
  //   envPlanet.w     = planet surface radius (world units, 0 = no planet)
  //   envPlanetAtm.x  = atmosphere top radius (planetR * (1 + atmFrac))
  //   envPlanetAtm.y  = Rayleigh scale height (world units)
  //   envPlanetAtm.z  = Mie scale height (world units)
  //   envPlanetAtm.w  = sun radiance multiplier (calibrated ~22 for Earth)
  envPlanet:    vec4<f32>,
  envPlanetAtm: vec4<f32>,
  // Sprint 7.6.b-atm Tier-C.0+ -- planet geometry. The planet is
  // rendered as an oblate spheroid (Y axis scaled by polRatio),
  // so the atmosphere must intersect/sample against the SAME
  // ellipsoid shape rather than a sphere. envPlanetGeom.x carries
  // the polRatio; remaining slots reserved for future expansion
  // (e.g. axial-tilt quaternion when planets get rotation).
  //   envPlanetGeom.x = polRatio (1.0 = perfect sphere)
  //   envPlanetGeom.y = terrain height at camera's lat/lon, m above
  //                     planetR (0 = camera over ocean / sea level).
  //                     Sprint 10-6 v7: used to shift LUT lookup from
  //                     MSL to AGL so atmosphere references local
  //                     terrain rather than always sea level.
  //   envPlanetGeom.zw = reserved
  envPlanetGeom: vec4<f32>,
  // Sprint 8-4 -- per-biome detail-noise parameters editable via the
  // PlanetMap modal's Biomes tab. 13 biomes x 2 vec4 each:
  //   biomeParams[k*2 + 0] = (amplitude_m, baseFreq, roughness, lacunarity)
  //   biomeParams[k*2 + 1] = (shape, warpStrength, warpFreq, textureStyleId)
  // shape enum: 0 fbm, 1 ridged, 2 billowed, 3 dunes, 4 cracks.
  // textureStyleId enum:
  //   0 = none (biome color only),
  //   1 = rock (ridged gray overlay),
  //   2 = sand (dune-like warm overlay),
  //   3 = grass (fbm green overlay),
  //   4 = snow (fbm white sparkle),
  //   5 = ice (cracked cyan overlay),
  //   6 = dirt (brown patches).
  // JS packs from PlanetMap.node.params.biomes[] each frame; defaults
  // mirror what the previous WGSL const BIOME_DETAIL_PARAMS held.
  biomeParams: array<vec4<f32>, 26>,
  // Sprint 9-3 -- projection-only matrix (no view). Paired with a
  // per-draw mv_rtc (view * translate(anchorF64) composed in f64)
  // for vs_planet_cdlod, so the catastrophic (anchor - camera)
  // subtraction happens in f64 on CPU before the f32 GPU upload.
  // Other variants still use uS.viewProj + uD.model with absolute
  // world vertices -- behavior unchanged for them.
  proj: mat4x4<f32>,
};

// Sprint 7.5.4.e -- ACES filmic tonemap. Maps HDR (values > 1) into
// LDR [0,1] smoothly so bright highlights preserve detail instead
// of clipping at the framebuffer write. For values <= 1 the curve
// is nearly identity (slight contrast bump); HDR values get
// compressed nicely. Applied at the end of every lit fragment
// shader so HDRI / ProceduralSky output doesn't blow out.
fn tonemap_aces(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  let num = x * (a * x + b);
  let den = x * (c * x + d) + e;
  return clamp(num / max(den, vec3<f32>(1e-5)), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Sprint 7.5.4.d -- 2D value noise + fbm for clouds. Sampled on a
// virtual cloud plane (at world altitude h) via view ray intersect.
// Wind drifts the noise UV over time (offsets are pre-computed JS).
fn _hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn _noise2d(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = _hash21(i);
  let b = _hash21(i + vec2<f32>(1.0, 0.0));
  let c = _hash21(i + vec2<f32>(0.0, 1.0));
  let d = _hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn _fbm(p: vec2<f32>) -> f32 {
  var v: f32 = 0.0;
  var amp: f32 = 0.5;
  var freq: f32 = 1.0;
  for (var i = 0; i < 5; i = i + 1) {
    v = v + amp * _noise2d(p * freq);
    freq = freq * 2.07;
    amp  = amp  * 0.5;
  }
  return v;
}

// === Phase 8 sprint 8-1: deterministic detail-noise foundation ===
// (spec: docs/PLANET-SCALE-TERRAIN.md §8.2)
//
// 3D value noise + FBM with per-octave deterministic seeds. Same world
// coordinate always yields the same result for the same octave index,
// regardless of LOD level or camera distance, so flying down toward
// the surface is purely ADDITIVE -- low-LOD octaves stay identical
// when more octaves are layered on.
//
// The biomeId parameter on detail_noise is reserved (sprint 8-2 will
// route it through a per-biome parameter LUT). For sprint 8-1 every
// biome uses the same default amplitude / frequency / shape.
//
// LOC budget per the spec: ~200 WGSL for §8.2. This implementation
// is ~80 LOC -- compact because we ride on the existing _hash21
// infrastructure shape.
fn _hash13(p: vec3<f32>) -> f32 {
  // 3D position -> [0, 1] hash. Single-sine hash is fine for value
  // noise; lattice scale of (127.1, 311.7, 74.7) matches the planet-
  // map's existing convention so debugging across the codebase reads
  // consistently. Multiply by a large prime to spread the output.
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}

fn _value_noise_3d(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  // Smoothstep interpolation in each axis for C1 continuity.
  let u = f * f * (3.0 - 2.0 * f);
  let c000 = _hash13(i);
  let c100 = _hash13(i + vec3<f32>(1.0, 0.0, 0.0));
  let c010 = _hash13(i + vec3<f32>(0.0, 1.0, 0.0));
  let c110 = _hash13(i + vec3<f32>(1.0, 1.0, 0.0));
  let c001 = _hash13(i + vec3<f32>(0.0, 0.0, 1.0));
  let c101 = _hash13(i + vec3<f32>(1.0, 0.0, 1.0));
  let c011 = _hash13(i + vec3<f32>(0.0, 1.0, 1.0));
  let c111 = _hash13(i + vec3<f32>(1.0, 1.0, 1.0));
  let x00 = mix(c000, c100, u.x);
  let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x);
  let x11 = mix(c011, c111, u.x);
  let y0  = mix(x00, x10, u.y);
  let y1  = mix(x01, x11, u.y);
  return mix(y0, y1, u.z);  // [0, 1]
}

/* Sprint 10-4 v7: biome-aware procedural surface textures.
 *
 * Each function takes a world-space position and returns an RGB
 * MULTIPLIER (centered around 1.0) that modulates the per-vertex
 * biome color. Combined with the per-fragment 4-octave detail
 * brightness modulation, this gives terrain a distinct surface
 * character per biome -- sand looks like sand, rock looks rocky,
 * etc. -- without needing textured maps or virtual texturing.
 *
 * All four functions are cheap: 2-3 value_noise_3d samples each.
 * Output channels are loosely correlated for natural color
 * variation rather than independent RGB jitter. */
// Sprint 10-4 v9: per-channel modulation amplitudes halved across all
// four texture profiles. v7 was visibly noisy at high mesh density;
// v9 reads as 'surface character' instead of 'pattern'.
fn _surface_tex_grass(p: vec3<f32>) -> vec3<f32> {
  let n_patch  = _value_noise_3d(p * 0.7)  - 0.5;
  let n_blade  = _value_noise_3d(p * 8.0)  - 0.5;
  let mix1 = n_patch * 0.5 + n_blade * 0.4;
  return vec3<f32>(1.0 + mix1 * 0.06,
                   1.0 + mix1 * 0.04,
                   1.0 + mix1 * 0.03);
}

fn _surface_tex_sand(p: vec3<f32>) -> vec3<f32> {
  let stripe = sin(p.x * 1.2) * 0.5 + 0.5;
  let n_dune = _value_noise_3d(p * 0.3)  - 0.5;
  let n_fine = _value_noise_3d(p * 6.0)  - 0.5;
  let mix1 = n_dune * 0.3 + n_fine * 0.4 + (stripe - 0.5) * 0.2;
  return vec3<f32>(1.0 + mix1 * 0.05,
                   1.0 + mix1 * 0.05,
                   1.0 + mix1 * 0.06);
}

fn _surface_tex_rock(p: vec3<f32>) -> vec3<f32> {
  let n_macro = _value_noise_3d(p * 0.5)  - 0.5;
  let n_crack = _value_noise_3d(p * 3.0)  - 0.5;
  let cracks  = smoothstep(0.15, 0.20, abs(n_crack));
  let mix1 = n_macro * 0.4 - (1.0 - cracks) * 0.25;
  return vec3<f32>(1.0 + mix1 * 0.09,
                   1.0 + mix1 * 0.08,
                   1.0 + mix1 * 0.06);
}

fn _surface_tex_snow(p: vec3<f32>) -> vec3<f32> {
  let n_drift = _value_noise_3d(p * 0.4)  - 0.5;
  let n_crust = _value_noise_3d(p * 4.0)  - 0.5;
  let mix1 = n_drift * 0.5 + n_crust * 0.3;
  return vec3<f32>(1.0 + mix1 * 0.025,
                   1.0 + mix1 * 0.025,
                   1.0 + mix1 * 0.03);
}

// Map camera altitude to detail octave count. Spec values, §8.4:
//   > 100km  : 0  (orbital -- base cubemap only)
//    10-100km: 2  (1km features)
//     1-10km : 4  (100m features)
//   100m-1km : 6  (10m features)
//    10-100m: 8  (1m features)
//        <10m: 10 (0.1m pebbles)
// Sprint 8-6 follow-up (closes the 8.4 spec): smooth crossfade
// between bands in log2(altitude) space so descending through a
// boundary doesn't suddenly pop a new octave in. The fractional
// part of the return value is the in-progress next octave's
// amplitude (detail_noise consumes it as a per-octave amp scale).
fn _detail_octaves(altitude_m: f32) -> f32 {
  let logAlt = log2(max(altitude_m, 1.0));
  // §revert-suppression (2026-05-25) -- foot-2 capped this at 6
  // octaves based on a Nyquist argument that was moot for the
  // PlanetMesh path (vs_planet_cdlod doesn't call detail_noise).
  // Real foot-perf bug was horizon-cull (fixed foot-9/10/11/12).
  // Restored to the original §8.4 spec ramp so other shaders that
  // DO call detail_noise (vs_main, vs_planet_detail, etc.) get
  // full feature resolution at foot.
  //   > 100km  : 0  (orbital -- base cubemap only)
  //    10-100km: 2  (1km features)
  //     1-10km : 4  (100m features)
  //   100m-1km : 6  (10m features)
  //    10-100m: 8  (1m features)
  //        <10m: 10 (0.1m pebbles)
  if (logAlt <= 3.32)  { return 10.0; }
  if (logAlt <= 6.64)  { return 10.0 - (logAlt -  3.32) / 3.32 * 2.0; }
  if (logAlt <= 9.97)  { return  8.0 - (logAlt -  6.64) / 3.33 * 2.0; }
  if (logAlt <= 13.29) { return  6.0 - (logAlt -  9.97) / 3.32 * 2.0; }
  if (logAlt <= 16.61) { return  4.0 - (logAlt - 13.29) / 3.32 * 4.0; }
  return 0.0;
}

// === Phase 8 sprint 8-2: per-biome detail params + noise shapes ===
// (spec: docs/PLANET-SCALE-TERRAIN.md §8.3 + §8.6)
//
// 2026-05-22 sprint 8-4: BIOME_DETAIL_PARAMS moved from a WGSL const
// to a runtime uniform (uS.biomeParams[]) so the PlanetMap modal's
// Biomes tab can edit them without WGSL recompiles. Indexing is the
// same: biomeId * 2 + 0 = (amp, freq, roughness, lacunarity),
// biomeId * 2 + 1 = (shape, warpStrength, warpFreq, textureStyleId).

// === Sprint 8-4: built-in procedural biome texture styles ===
// Per-biome textureStyleId selects one of these built-in overlays;
// the overlay is multiplied into the biome's base color so the
// biome's hue still tints through the texture. Wired landTexture
// (PlanetMesh.landTexture) takes priority over the style if both
// are set.
fn _biome_texture_style(worldPos: vec3<f32>, styleId: u32) -> vec3<f32> {
  let scale = 0.001;
  let p = worldPos * scale;
  if (styleId == 1u) {
    // Rock: ridged value-noise gives broken-cliff look. Gray-ish.
    let n = _value_noise_3d(p);
    let r = 1.0 - abs(n * 2.0 - 1.0);
    let v = r * r * 0.7 + 0.3;
    return vec3<f32>(v, v * 0.95, v * 0.88);
  }
  if (styleId == 2u) {
    // Sand: low-freq fbm + warm-yellow tint, dune-direction biased.
    let n = _value_noise_3d(p * 0.5);
    let v = n * 0.5 + 0.6;
    return vec3<f32>(v * 1.08, v * 0.96, v * 0.72);
  }
  if (styleId == 3u) {
    // Grass: medium-freq fbm + green tint, slightly darker patches.
    let n = _value_noise_3d(p * 1.5);
    let v = 0.45 + n * 0.45;
    return vec3<f32>(v * 0.78, v * 1.04, v * 0.62);
  }
  if (styleId == 4u) {
    // Snow: white with high-freq sparkle.
    let n = _value_noise_3d(p * 3.0);
    let v = 0.85 + n * 0.15;
    return vec3<f32>(v, v, v * 1.02);
  }
  if (styleId == 5u) {
    // Ice: cracked (inverted ridged) cyan; the cracks read as
    // darker veins through a lighter base.
    let n = _value_noise_3d(p);
    let r = 1.0 - abs(n * 2.0 - 1.0);
    let v = 0.55 + (1.0 - r * r) * 0.4;
    return vec3<f32>(v * 0.92, v * 1.02, v * 1.08);
  }
  if (styleId == 6u) {
    // Dirt: low-freq blotches in brown.
    let n = _value_noise_3d(p * 0.8);
    let v = 0.45 + n * 0.4;
    return vec3<f32>(v * 0.95, v * 0.78, v * 0.58);
  }
  // 0 (or unknown): no overlay, identity multiplier.
  return vec3<f32>(1.0);
}

// Apply a per-octave noise shape to a signed [-1, 1] noise sample.
fn _noise_apply_shape(n: f32, shape: u32) -> f32 {
  if (shape == 1u) {
    // Ridged: (1 - |n|)^2. Sharp ridges, [0, 1] range.
    let r = 1.0 - abs(n);
    return r * r;
  }
  if (shape == 2u) {
    // Billowed: |n|. Round bumps, [0, 1] range.
    return abs(n);
  }
  if (shape == 3u) {
    // Dunes: same as ridged for now; the anisotropic domain warp
    // (sprint 8-3 polish) will operate on worldPos before fbm.
    let r = 1.0 - abs(n);
    return r * r;
  }
  if (shape == 4u) {
    // Cracks: inverted ridged for negative-going crevasses, [-1, 0].
    let r = 1.0 - abs(n);
    return -r * r;
  }
  // shape == 0 fbm (default) -- pass through.
  return n;
}

// detail_noise(worldPos, biomeId, maxOctaveF): deterministic biome-
// styled fBm. Reads per-biome amplitude / freq / shape from
// uS.biomeParams[] uniform (sprint 8-4) -- editable via the
// PlanetMap modal's Biomes tab.
//
// 8.4 crossfade: maxOctaveF is a FLOAT. The integer part is the
// number of fully-summed octaves; the fractional part scales the
// final partial octave. _detail_octaves returns this continuously
// so descending through an altitude band smoothly ramps in the
// new octave instead of popping it.
fn detail_noise(worldPos: vec3<f32>, biomeId: u32, maxOctaveF: f32) -> f32 {
  let bId = min(biomeId, 12u);
  let row0 = uS.biomeParams[bId * 2u + 0u];
  let row1 = uS.biomeParams[bId * 2u + 1u];
  let amplitude  = row0.x;
  let baseFreq   = row0.y;
  let roughness  = row0.z;
  let lacunarity = row0.w;
  let shape: u32 = u32(row1.x + 0.5);
  let warpStrength = row1.y;
  let warpFreq     = row1.z;

  if (amplitude <= 0.0 || maxOctaveF <= 0.0) { return 0.0; }

  // 8.6 follow-up: dunes shape gets an anisotropic domain warp so
  // crests align like real wind-built dunes. Other shapes pass
  // worldPos through unchanged.
  var samplePos = worldPos;
  if (shape == 3u && warpStrength > 0.0) {
    let radial = samplePos - uS.envPlanet.xyz;
    let radialLen = length(radial);
    let radialDir = select(vec3<f32>(0.0, 1.0, 0.0), radial / max(radialLen, 1.0), radialLen > 0.5);
    var crestRef = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(radialDir, crestRef)) > 0.99) {
      crestRef = vec3<f32>(1.0, 0.0, 0.0);
    }
    let crest = normalize(crestRef - radialDir * dot(crestRef, radialDir));
    let warpN = _value_noise_3d(samplePos * max(warpFreq, 1e-7)) * 2.0 - 1.0;
    // 50m of warp at warpStrength=1 is enough to give dunes a
    // smooth crest curve at orbital scale; scaled by per-biome
    // strength so the user can dial it.
    samplePos = samplePos + crest * (warpN * warpStrength * 50.0);
  }

  let maxFullOct = u32(floor(maxOctaveF));
  let lastFrac   = maxOctaveF - f32(maxFullOct);
  let totalOctaves = maxFullOct + select(0u, 1u, lastFrac > 0.001);

  var sum: f32  = 0.0;
  var freq: f32 = baseFreq;
  var amp: f32  = 1.0;
  var ampSum: f32 = 0.0;
  for (var k: u32 = 0u; k < totalOctaves; k = k + 1u) {
    // Per-octave offset = deterministic seed depending ONLY on k.
    // LOD-stable: octave k contributes the same value at the same
    // worldPos regardless of maxOctaveF.
    let offset = vec3<f32>(
      f32(k) * 13.37,
      f32(k) * 7.91,
      f32(k) * 23.45
    );
    let p = samplePos * freq + offset;
    let nRaw = _value_noise_3d(p) * 2.0 - 1.0;  // [-1, 1]
    let nShaped = _noise_apply_shape(nRaw, shape);
    // 8.4 crossfade: scale the last partial octave by lastFrac so
    // its contribution ramps 0->1 across the band boundary.
    var ampThis = amp;
    if (k == maxFullOct && lastFrac > 0.001 && lastFrac < 0.999) {
      ampThis = amp * lastFrac;
    }
    sum    = sum    + ampThis * nShaped;
    ampSum = ampSum + ampThis;
    freq = freq * lacunarity;
    amp  = amp  * roughness;
  }
  if (ampSum < 1e-6) { return 0.0; }
  // Final amplitude scaling via biome's amplitude. The /ampSum
  // normalizes the fbm sum to roughly the shape's natural range, then
  // amplitude * 0.01 converts meters-of-feature to the [0..1] color-
  // modulation scale used by the brightness visualization in
  // fs_unlit_vc. (Vertex displacement uses detail_noise_height which
  // strips the 0.01 to recover meters.)
  return (sum / ampSum) * amplitude * 0.01;
}

// Phase 8 sprint 8-6: meters-scaled detail noise for vertex displacement.
// Strips the 0.01 color-modulation scale to recover real meters.
fn detail_noise_height(worldPos: vec3<f32>, biomeId: u32, maxOctaveF: f32) -> f32 {
  return detail_noise(worldPos, biomeId, maxOctaveF) * 100.0;
}

// Sample clouds for a given world view direction. Returns vec4
// where rgb = lit cloud color and a = coverage alpha (0 = no
// cloud, 1 = fully opaque). Only meaningful for upward view dirs
// (dir.y > small threshold); below horizon -> 0.
fn sample_clouds(dir: vec3<f32>) -> vec4<f32> {
  let coverage = uS.envCloudParams.x;
  let density  = uS.envCloudParams.y;
  if (coverage <= 0.0 || density <= 0.0) {
    return vec4<f32>(0.0);
  }
  // Below horizon -> no clouds. Smooth fade-in near the horizon
  // band so clouds don't pop at the edge.
  let yMask = smoothstep(0.0, 0.12, dir.y);
  if (yMask <= 0.0) {
    return vec4<f32>(0.0);
  }
  // §5.5.h-13 -- fixed-distance cloud "shell" instead of an infinite
  // flat cloud plane. The flat plane had wildly non-uniform parallax
  // response to rotation: near-zenith clouds at t = H/dir.y were
  // close (a few km) while horizon clouds were at hundreds of km, so
  // panning the camera moved them at very different rates -- exactly
  // the symptom that read as a parallax issue when looking left or
  // right or up. A constant-distance shell (pos = dir * R) keeps
  // angular size and rotation response uniform across the dome.
  //
  // R = 8000m -- typical distant cloud feel. Clouds appear at the
  // same effective distance whether you look up or toward the
  // horizon. World-anchoring still works: the scene encoder pre-
  // subtracts camera.xz from the wind offset so noise tracks world
  // XZ as the camera translates.
  let R = 8000.0;
  let pos = dir * R;
  let wind = uS.envCloudParams.zw;
  let xz = (pos.xz - wind) * 0.0006;
  // Fractal density via 5-octave fbm; coverage threshold gates it
  // (real cloud fronts have sharp edges, fbm is too smooth alone).
  let raw = _fbm(xz);
  let alpha = smoothstep(coverage * 0.85, coverage * 0.85 + 0.22, raw) * density * yMask;
  // Cloud color: lit white-warm by sun (cos_theta with sunDir gives
  // a coarse forward-scatter brightening), darkened by self-shadow
  // approximation (1 - alpha gives a fake "thicker = darker bottom").
  let cos_theta = clamp(dot(normalize(dir), uS.envSun.xyz), -1.0, 1.0);
  let sunUp     = max(uS.envSun.y, 0.0);
  let scatter   = pow(max(cos_theta * 0.5 + 0.5, 0.0), 2.0);
  // Color picks a warm tint near sunset, cool at midday.
  let sun_elev = clamp(uS.envSun.y, -1.0, 1.0);
  let lit = mix(vec3<f32>(1.10, 0.85, 0.65),
                vec3<f32>(1.05, 1.02, 0.98),
                smoothstep(0.0, 0.35, sun_elev));
  let shadow = vec3<f32>(0.35, 0.40, 0.50);
  // Day intensity: clouds are dim at night, bright by day.
  let day = smoothstep(-0.10, 0.20, sun_elev);
  let cloudCol = mix(shadow, lit, scatter * uS.envSun.w) * day;
  return vec4<f32>(cloudCol, clamp(alpha, 0.0, 0.95));
}

// Sprint 7.5.4.c-sky -- background sky pass. Fullscreen triangle
// at clip-space z=1 (far plane); depth-test "less-equal" lets it
// pass only where no mesh has written a smaller depth. Result:
// the sky fills uncovered background pixels with sample_env(rayDir).
//
// Without this pass the Scene's clearR/G/B shows through behind
// meshes, even when an env is wired -- meaning glossy reflections
// of the sky showed up but the actual sky behind didn't. With it,
// the env source becomes a true skybox.

struct SkyVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldDir: vec3<f32>,
};

@vertex
fn vs_sky(@builtin(vertex_index) vid: u32) -> SkyVsOut {
  // Oversized fullscreen triangle: (-1,-3), (3,1), (-1,1) covers
  // the viewport with vertices outside the screen, avoiding the
  // hypotenuse-of-two-tris seam.
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>( 3.0,  1.0),
    vec2<f32>(-1.0,  1.0)
  );
  let p = positions[vid];
  var out: SkyVsOut;
  // §planet-spec Phase 1 -- reverse-Z. Far plane in WebGPU clip
  // space is now ndc_z=0 (was 1). With depth-test "greater-equal"
  // + depth-clear=0, this fragment passes wherever no mesh wrote
  // anything closer to the near plane (ndc_z=1).
  out.pos = vec4<f32>(p.x, p.y, 0.0, 1.0);
  // Reconstruct world-space ray dir from screen coords + camera
  // basis. Perspective: dir = forward + p.x * tanHFov*aspect * right
  //                                    + p.y * tanHFov        * up
  // Ortho: dir = forward (constant; sky becomes a flat color, fine
  // for the rare ortho-camera case).
  let isOrtho = uS.camForward.w > 0.5;
  let pdir = uS.camForward.xyz
           + p.x * uS.camRight.w * uS.camRight.xyz
           + p.y * uS.camUp.w    * uS.camUp.xyz;
  // 2026-05-21 -- DO NOT normalize here. The fragment shader normalizes.
  // Reason: linear interpolation of NORMALIZED vertex vectors is not the
  // same as normalize() of the linearly-interpolated UN-normalized
  // vectors. For this oversized fullscreen triangle (vertices at
  // (-1,-3), (3,1), (-1,1)), the un-normalized pdir at each vertex is
  //   v = camForward + p.x * tanHFovAspect * camRight + p.y * tanHFov * camUp
  // which IS linear in (p.x, p.y). Hardware interpolation reconstructs
  // the correct (un-normalized) ray at every screen pixel. If we
  // normalize first, the magnitudes diverge between vertices (the
  // off-screen vertex at (-1,-3) has much larger |v| than the on-screen
  // ones), and the interpolated unit vectors no longer point along the
  // true view ray. Symptoms: stars + Milky Way visibly stretched off-
  // axis; atmosphere shell intersections happen for the WRONG ray
  // direction, so the rendered halo appears as a separate sphere
  // offset from the planet body.
  out.worldDir = select(pdir, uS.camForward.xyz, isOrtho);
  return out;
}

// Sprint 7.5.4.e -- distance fog blend. Applied at end of lit
// fragment shaders. Beer-Lambert exp(-density * (dist - start))
// with optional height falloff so ground fog doesn't tint distant
// mountaintops. Defined here (after sample_env) so the
// autoPull-from-env path can call sample_env() in the camera-
// forward direction for a fog color that matches the sky horizon.
fn apply_fog(color: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  let density = uS.envFogParams.x;
  if (density <= 0.0) { return color; }
  let start = uS.envFogParams.y;
  let hf    = uS.envFogParams.z;
  let dist  = length(uS.eye.xyz - worldPos);
  let beyond = max(dist - start, 0.0);
  var heightFactor: f32 = 1.0;
  if (hf > 0.0) {
    heightFactor = smoothstep(hf * 2.0, 0.0, worldPos.y);
  }
  let factor = 1.0 - exp(-density * beyond * heightFactor);
  var fogCol: vec3<f32>;
  if (uS.envFogParams.w > 0.5) {
    // 7.5.4.e-fix2 -- project camera-forward to the horizon (y=0)
    // before sampling env. Pre-fix used raw camForward.xyz: when
    // the camera tilts down at all (any look-down framing) it
    // picked up the env's GROUND color (warm dim brown), which is
    // nearly identical to most floor materials -> fog tint read as
    // invisible against the floor. Real atmospheric perspective
    // tints distant geometry toward the HORIZON color regardless
    // of camera tilt; forcing y=0 + renormalize gives that
    // consistently. The +1e-4 nudges away from the degenerate
    // straight-up camera (cross-of-y-axis -> 0 vector).
    let camFwd = uS.camForward.xyz;
    let horizDir = normalize(vec3<f32>(camFwd.x, 0.0, camFwd.z) + vec3<f32>(1e-4, 0.0, 0.0));
    fogCol = sample_env(horizDir);
  } else {
    fogCol = uS.envFogColor.rgb;
  }
  return mix(color, fogCol, clamp(factor, 0.0, 1.0));
}

@fragment
fn fs_sky(in: SkyVsOut) -> @location(0) vec4<f32> {
  // Sprint 7.5.4.c-polish -- sky background pass includes the
  // features (disk / moon / stars / Milky Way) on top of the
  // smooth scattering. sample_env is smooth-only (for IBL safety);
  // this dispatch path is the only place features show up so that
  // a high-frequency star can't end up reflected through a smooth
  // surface normal and alias.
  let dir = normalize(in.worldDir);
  let mode = u32(uS.envParams.x);
  var col: vec3<f32>;
  if (mode == 2u) {
    // 2026-05-21 Sprint 7.6.a-atm v4 -- camera-altitude-gated
    // scattering. sample_planet_atmosphere now returns 0 when the
    // camera is above the atmosphere shell, so:
    //   * From the SURFACE: full atmospheric scattering -> blue sky.
    //   * From ORBIT: pure space -- limb glow visible only as
    //     aerial_perspective on the planet body itself, no
    //     disconnected halo around the silhouette.
    // The transition has a 10%-of-thickness fade band so crossing
    // the Karman line doesn't pop visually.
    if (uS.envPlanet.w > 0.0) {
      // C.4 -- sky-view LUT replaces per-pixel atmosphere integration.
      // One texture sample instead of 16x8 = 128 inner evaluations.
      // Features (sun disk / moon / stars / Milky Way) stay per-pixel
      // because they're point/line features that would alias through
      // the 192x108 LUT resolution.
      col = sample_skyview_lut(dir)
          + sample_procedural_sky_features(dir);
    } else {
      col = sample_procedural_sky(dir);
    }
  } else {
    col = sample_env(dir);
  }
  // Sprint 7.5.4.d -- composite clouds over the sky background.
  // ProceduralSky resolver packs cloud coverage/density/wind; for
  // other env sources cloud params stay 0 (sample_clouds returns
  // zero-alpha, no visible change).
  let cloud = sample_clouds(dir);
  col = mix(col, cloud.rgb, cloud.a);
  // 7.5.4.e -- ACES tonemap so HDR-range values (sun disk, bright
  // HDRI pixels) don't clip-blow-out at the framebuffer write.
  return vec4<f32>(tonemap_aces(col), 1.0);
}

// Sprint 7.5.4.c-physics -- atmospheric scattering with proper
// Rayleigh + Mie phase functions and Beer-Lambert extinction along
// the sun ray. NOT integrated multi-scattering (that needs precomp
// tables, e.g. Bruneton); single-scattering with the right shape:
//   * sun's color reddens through atmospheric path (extinction)
//   * sky's zenith blue comes from Rayleigh in-scatter
//   * Mie halo around sun + brownish horizon haze from aerosols
//
// Sub-divided into:
//   sample_procedural_sky_smooth(dir)   - smooth gradient + halo
//     only (no point-features). For IBL ambient on PBR surfaces;
//     the high-freq star/disk features alias badly through smooth
//     surface normals so they're factored out.
//   sample_procedural_sky_features(dir) - sun disk + moon + stars
//     + Milky Way. Background-only.
//   sample_procedural_sky(dir)          - = smooth + features.

// Wavelength-dependent Rayleigh extinction (~1/λ⁴; blue scatters
// most). Ratios tuned so one full atmospheric path produces an
// observed sunset-red residual on the sun. Mie is gray, scaled
// by turbidity (aerosol load).
const SKY_BETA_R = vec3<f32>(0.030, 0.070, 0.170);
const SKY_PATH_SCALE = 4.0;

fn _sky_optical_depth(cos_zenith: f32) -> f32 {
  // Chapman-style approximation: 1 at zenith, large at horizon.
  // +0.05 floor prevents the 1/cos singularity at horizon.
  return 1.0 / max(cos_zenith + 0.05, 0.08);
}

fn _sky_sun_extinction(sunCosZenith: f32, turbidity: f32) -> vec3<f32> {
  let depth = _sky_optical_depth(sunCosZenith);
  let betaM = vec3<f32>(0.030) * turbidity;
  return exp(-(SKY_BETA_R + betaM) * depth * SKY_PATH_SCALE);
}

fn sample_procedural_sky_smooth(dir: vec3<f32>) -> vec3<f32> {
  let sunDir    = uS.envSun.xyz;
  let sunVis    = uS.envSun.w;
  let turbidity = uS.envParams.z;
  let mieG      = uS.envParams.w;
  let intensity = uS.envParams.y;

  let view_y   = clamp(dir.y, -1.0, 1.0);
  let sun_elev = clamp(sunDir.y, -1.0, 1.0);
  let day      = smoothstep(-0.08, 0.18, sun_elev);

  // === DAY: Rayleigh + Mie single-scattering ===
  let betaR = SKY_BETA_R;
  let betaM = vec3<f32>(0.030) * turbidity;
  let cos_theta = clamp(dot(dir, sunDir), -1.0, 1.0);
  let cos2 = cos_theta * cos_theta;

  // Rayleigh phase: 3/(16π) × (1 + cos²θ). Symmetric, adds to both
  // forward and backward view directions.
  let phaseR = 0.0596 * (1.0 + cos2);
  // Mie phase: Cornette-Shanks improved HG. Strongly forward-
  // scattering -> bright halo around sun + brown horizon haze.
  let g  = clamp(mieG, 0.0, 0.95);
  let g2 = g * g;
  let phaseM_denom = pow(max(1.0 + g2 - 2.0 * g * cos_theta, 1e-4), 1.5);
  let phaseM = 0.119 * (1.0 - g2) * (1.0 + cos2) / ((2.0 + g2) * phaseM_denom);

  // Optical depths along view + sun rays.
  let sunCosZenith  = max(sun_elev, -0.05);
  let viewCosZenith = max(view_y, 0.0);
  let sunDepth  = _sky_optical_depth(sunCosZenith);
  let viewDepth = _sky_optical_depth(viewCosZenith);

  // Beer-Lambert sun extinction: ratio of sunlight surviving its
  // trip from atmosphere edge to the observer. At zenith ≈ neutral
  // white; at horizon, blue extinguishes first, leaving deep red.
  let extinction = exp(-(betaR + betaM) * sunDepth * SKY_PATH_SCALE);
  let sunRadiance = vec3<f32>(1.5, 1.4, 1.3) * extinction;

  // Single in-scattering integral approximation. Real integral is
  // ∫ phase × Lsun × T(view) dx along view ray; here we collapse
  // the integral to phase × sunRadiance × (1 - exp(-tau_view))
  // which preserves the day/dusk/zenith color shapes without the
  // precomp table cost.
  //
  // 7.5.4.c-polish3 -- bumped main multiplier 14 -> 80. The earlier
  // value was tuned against the rays-coefficients-in-isolation but
  // produced a sky that read as "nearly black at noon." 80 lands
  // noon-zenith roughly at vec3(0.33, 0.49, 0.74) -- close to the
  // pre-physics hand-tuned (0.28, 0.50, 0.92).
  let viewExt = exp(-(betaR + betaM) * viewDepth * SKY_PATH_SCALE * 0.6);
  let inScatterR = sunRadiance * betaR * phaseR;
  let inScatterM = sunRadiance * betaM * phaseM;
  var sky_day = (inScatterR + inScatterM) * (1.0 - viewExt) * 80.0;

  // 7.5.4.c-polish3 -- multi-scattering ambient. Single-scattering
  // gets the colors right but is too dim in directions away from
  // the sun (real atmospheres get filled in by light bouncing 2+
  // times among air molecules). Add a sun-elevation-gated blue
  // ambient that scales with viewExt -- more fill at horizon (more
  // air = more bounces), less at zenith. Without this the half of
  // the sky opposite the sun reads as nearly black.
  let multiScatter = vec3<f32>(0.18, 0.42, 0.92) *
                     smoothstep(-0.05, 0.35, sun_elev) *
                     (1.0 - viewExt);
  sky_day = sky_day + multiScatter * 1.4;

  // === NIGHT ===
  let zen_night = vec3<f32>(0.015, 0.022, 0.060);
  let hor_night = vec3<f32>(0.045, 0.050, 0.095);
  let sky_night = mix(hor_night, zen_night, smoothstep(0.0, 1.0, max(view_y, 0.0)));

  // §5.5.h-11 -- below-horizon "ground" used to be a hard-coded warm-
  // brown (vec3(0.18, 0.13, 0.10)) which read as a brown earth band at
  // the horizon when the sky was exposed past the edge of a finite
  // water/terrain plane. Continue the sky color instead, just darker.
  // Real terrain/water overdraws this where it covers; where it's
  // exposed (water plane edges, gaps), it now reads as a darker
  // continuation of the atmospheric horizon rather than fake earth.
  var col = mix(sky_night, sky_day, day);
  if (view_y < 0.0) {
    let fade = clamp(1.0 + view_y * 1.5, 0.4, 1.0);
    col = col * fade;
  }

  // Sun-halo Mie glow (smooth; the disk itself lives in _features).
  let halo = phaseM * sunVis * 1.0;
  col = col + halo * sunRadiance;

  // §5.5.h-26 -- atmospheric altitude fade. Real atmosphere is mostly
  // gone by ~80km. Below 20km camera Y we're in full sky; ramps to
  // 0 (space) over the 20-80km band. Applied to the smooth path only
  // so sun / stars / Milky Way (sample_procedural_sky_features) stay
  // visible from above the atmosphere. Used by fs_sky, fs_water,
  // fs_horizon, fs_clouds, and IBL sampling so everything that reads
  // the sky stays consistent as the camera climbs out of atmosphere.
  let camY = uS.eye.y;
  let atmFade = clamp(1.0 - (camY - 20000.0) / 60000.0, 0.0, 1.0);
  return col * intensity * atmFade;
}

// Sprint 7.6.a-atm -- TIER B planet-aware single-scattering
// atmosphere (Nishita 1993 / Hillaire 2020 simplified to single
// bounce). Replaces the flat-ground sample_procedural_sky_smooth
// whenever uS.envPlanet.w > 0 (a planet is wired in the scene).
//
// The shader integrates Rayleigh + Mie in-scattering along the
// view ray segment that lies INSIDE the atmosphere shell:
//   1. Compute ray ∩ atmosphere-top sphere (entry/exit).
//   2. If ray ∩ planet surface comes before exit, clip there
//      (cam->ground segment is what scatters).
//   3. Sample N points along the segment. At each, compute the
//      atmosphere density (exp altitude decay), accumulate view-
//      ray optical depth, then trace a sun ray from the sample
//      point and accumulate its optical depth. Combine to find
//      this sample's attenuated in-scatter contribution.
//   4. Apply Rayleigh + Mie phase functions, sum, return.
//
// This handles all camera positions:
//   - Surface: blue sky, sunset red, sun extinction
//   - Atmosphere flight: thinning blue, brighter at altitude
//   - Orbit: black space + bright limb glow around planet silhouette
//
// Coefficients are Earth-calibrated (5.8e-6 / 13.5e-6 / 33.1e-6
// per meter for RGB Rayleigh, 21e-6 for Mie) and rescaled by
// EARTH_R / planetR so the OPTICAL DEPTH per unit world distance
// looks Earth-like regardless of our world-unit scale.
const ATM_EARTH_R: f32 = 6371000.0;

// Sprint 7.6.b-atm Tier-C.0 -- atmosphere integral result. The
// previous return-just-the-in-scatter approach (vec3) lacked the
// view-path TRANSMITTANCE which is what makes the planet body fade
// into atmosphere color at the limb. With transmittance included
// the caller can do:
//   final_color = surface_color * transmittance + in_scatter
// at the silhouette this becomes ~0 * ~0 + bright_atm = bright_atm,
// matching the sky-pass scattering and closing the visible gap.
struct AtmResult {
  inScatter:    vec3<f32>,
  transmittance: vec3<f32>
};

// Ray-ELLIPSOID intersection (oblate spheroid with Y-axis scaled by
// polRatio). The planet renders with Y compressed by polRatio (the
// Earth's WGS84 ratio = 0.9966); to align the atmosphere shell with
// the actual rendered planet shape, intersect against the matching
// ellipsoid instead of a sphere.
//
// Trick: scale the ray's Y by 1/polRatio. In that scaled space the
// ellipsoid is a unit sphere of radius r, and t parameters transfer
// 1:1 with the unscaled ray (because we scale both origin and dir
// by the same factor, the t parameter still indexes the original
// world-space position along the ray). Standard quadratic from
// |O + t*D|² = r², but using the general form because the scaled
// direction is no longer unit-length.
fn _atm_ray_ellipsoid(origin: vec3<f32>, dir: vec3<f32>, center: vec3<f32>, r: f32, polRatio: f32) -> vec2<f32> {
  let invPol = 1.0 / max(polRatio, 1e-6);
  let scale  = vec3<f32>(1.0, invPol, 1.0);
  let oc = (origin - center) * scale;
  let dd = dir * scale;
  let A = dot(dd, dd);
  let B = dot(oc, dd);
  let C = dot(oc, oc) - r * r;
  let h = B * B - A * C;
  if (h < 0.0) { return vec2<f32>(0.0, -1.0); }
  let s = sqrt(h);
  let invA = 1.0 / max(A, 1e-12);
  return vec2<f32>((-B - s) * invA, (-B + s) * invA);
}

// Backward-compat sphere intersection. Equivalent to ellipsoid with
// polRatio=1 -- some non-atmospheric callers may still use this.
fn _atm_ray_sphere(origin: vec3<f32>, dir: vec3<f32>, center: vec3<f32>, r: f32) -> vec2<f32> {
  let oc = origin - center;
  let b = dot(oc, dir);
  let c = dot(oc, oc) - r * r;
  let h = b * b - c;
  if (h < 0.0) { return vec2<f32>(0.0, -1.0); }
  let s = sqrt(h);
  return vec2<f32>(-b - s, -b + s);
}

// Internal core: integrate Rayleigh+Mie in-scatter along [rayOrigin,
// rayOrigin + rayDir*t1] segment, where t1 is automatically computed
// as either atmosphere-shell exit OR ground intersection OR maxDist
// (whichever is closest). maxDist < 0 means "no fragment limit"
// (the sky-pass usage); maxDist >= 0 clips to that distance (the
// aerial-perspective usage, where the fragment's surface stops the
// view ray short of the planet's far atmosphere shell).
fn _atm_integrate(rayOrigin: vec3<f32>, rayDir: vec3<f32>, maxDist: f32) -> AtmResult {
  let sunDir   = uS.envSun.xyz;
  let sunVis   = uS.envSun.w;
  let planetC  = uS.envPlanet.xyz;
  let planetR  = uS.envPlanet.w;
  let atmR     = uS.envPlanetAtm.x;
  let scaleHR  = uS.envPlanetAtm.y;
  let scaleHM  = uS.envPlanetAtm.z;
  let sunI     = uS.envPlanetAtm.w;
  let turbidity = max(uS.envParams.z, 0.5);

  if (planetR <= 0.0 || atmR <= planetR) {
    return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0));
  }

  // Tier C.0+ -- pull polRatio so atmosphere and planet match shape.
  let polRatio = max(0.5, min(2.0, uS.envPlanetGeom.x));
  let invPol = 1.0 / polRatio;

  let unitScale = ATM_EARTH_R / planetR;
  let betaR = vec3<f32>(5.8e-6, 13.5e-6, 33.1e-6) * unitScale;
  let betaM = vec3<f32>(21.0e-6) * unitScale * turbidity;

  let atmHit = _atm_ray_ellipsoid(rayOrigin, rayDir, planetC, atmR, polRatio);
  if (atmHit.y < 0.0) { return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0)); }
  var t0 = max(atmHit.x, 0.0);
  var t1 = atmHit.y;

  // Clip to ground if the ray would otherwise pass through the planet.
  let groundHit = _atm_ray_ellipsoid(rayOrigin, rayDir, planetC, planetR, polRatio);
  if (groundHit.x > 0.0 && groundHit.x < t1) { t1 = groundHit.x; }
  // Clip to fragment (aerial-perspective mode): when a surface is in
  // front of the atmosphere far side, stop the integral at the surface.
  if (maxDist >= 0.0 && maxDist < t1) { t1 = maxDist; }

  let segLen = t1 - t0;
  if (segLen <= 0.0) { return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0)); }

  let NUM_SAMPLES = 16;
  let dt = segLen / 16.0;
  var inScatterR = vec3<f32>(0.0);
  var inScatterM = vec3<f32>(0.0);
  var opticalDepthR = 0.0;
  var opticalDepthM = 0.0;
  // Sprint 7.6.b-atm Tier-C.3 -- accumulator for multi-scattering
  // contribution. At each view-ray sample we add the LUT-precomputed
  // isotropic-bounce energy weighted by (a) local Rayleigh+Mie
  // density (so high altitudes contribute less) and (b) the camera-
  // to-sample transmittance (so multi-scattering on the far side of
  // a thick column gets attenuated correctly).
  var multiScatterAccum = vec3<f32>(0.0);
  // atmThickness needed by sample_multiscatter_lut for V-axis remap.
  let atmThickness = atmR - planetR;

  // Altitude above ellipsoid surface: scale Y by 1/polRatio to bring
  // the planet into a unit-sphere shape, compute (|p_scaled| - r), then
  // approximate altitude in world units. Exact altitude-above-ellipsoid
  // is more complex (closest-point calculation), but for atmospheric
  // density purposes this approximation is accurate enough -- the
  // density curve is exponential so small errors in altitude have
  // tiny effect.
  let scaleAxes = vec3<f32>(1.0, invPol, 1.0);

  for (var i: i32 = 0; i < NUM_SAMPLES; i = i + 1) {
    let t = t0 + (f32(i) + 0.5) * dt;
    let p = rayOrigin + rayDir * t;
    let h = max(0.0, length((p - planetC) * scaleAxes) - planetR);

    let densityR = exp(-h / scaleHR) * dt;
    let densityM = exp(-h / scaleHM) * dt;
    opticalDepthR = opticalDepthR + densityR;
    opticalDepthM = opticalDepthM + densityM;

    // Sprint 7.6.b-atm Tier-C.3 -- multi-scattering contribution at
    // this sample. The LUT was baked for a sphere-centered geometry,
    // so we compute the sample's "up" direction (radial) and the
    // sun's projection onto it. atmThickness here matches the LUT's
    // V-axis range. The result is energy/m of integrated multi-bounce
    // light that we weight by local density × view-path attenuation
    // to get a per-sample contribution to the eye's color.
    let upDir = normalize((p - planetC) * scaleAxes);
    let cosSZ = dot(upDir, sunDir);
    let msLut = sample_multiscatter_lut(cosSZ, h, atmThickness);
    // View-path transmittance from camera to THIS sample (Beer-Lambert
    // along the segment we've already integrated).
    let viewExtSoFar = betaR * opticalDepthR + betaM * 1.1 * opticalDepthM;
    let viewTransSoFar = exp(-viewExtSoFar);
    let scatterCoeff = betaR * densityR + betaM * densityM;
    multiScatterAccum = multiScatterAccum + msLut * scatterCoeff * viewTransSoFar;

    // Sun-ray segment from p outward (uS.envSun is direction TO sun).
    let sunHit = _atm_ray_ellipsoid(p, sunDir, planetC, atmR, polRatio);
    if (sunHit.y < 0.0) { continue; }
    // Skip samples where the sun is blocked by the planet itself.
    let sunGround = _atm_ray_ellipsoid(p, sunDir, planetC, planetR, polRatio);
    if (sunGround.x > 0.0 && sunGround.x < sunHit.y) { continue; }

    let sunSegLen = sunHit.y;
    let SUN_SAMPLES = 8;
    let dtSun = sunSegLen / 8.0;
    var sunDepthR = 0.0;
    var sunDepthM = 0.0;
    for (var j: i32 = 0; j < SUN_SAMPLES; j = j + 1) {
      let ts = (f32(j) + 0.5) * dtSun;
      let ps = p + sunDir * ts;
      let hs = max(0.0, length((ps - planetC) * scaleAxes) - planetR);
      sunDepthR = sunDepthR + exp(-hs / scaleHR) * dtSun;
      sunDepthM = sunDepthM + exp(-hs / scaleHM) * dtSun;
    }

    let totalExt = betaR * (opticalDepthR + sunDepthR)
                 + betaM * 1.1 * (opticalDepthM + sunDepthM);
    let attenuation = exp(-totalExt);

    inScatterR = inScatterR + densityR * attenuation;
    inScatterM = inScatterM + densityM * attenuation;
  }

  // Phase functions: Rayleigh (3/16π × (1+cos²)) + Mie (Cornette-Shanks).
  let cosTheta = dot(rayDir, sunDir);
  let cos2 = cosTheta * cosTheta;
  let phaseR = 0.0596831 * (1.0 + cos2);
  let g = clamp(uS.envParams.w, 0.0, 0.95);
  let g2 = g * g;
  let mDenom = pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
  let phaseM = 0.1193662 * (1.0 - g2) * (1.0 + cos2) / ((2.0 + g2) * mDenom);

  // Sprint 7.6.b-atm Tier-C.3 -- combine single + multi-scattering.
  // Single-scatter uses the proper phase functions. Multi-scatter is
  // already isotropic (1/4π absorbed into the LUT) so we add it as-is,
  // modulated by sunI * sunVis so a hidden sun produces no extra
  // multi-bounce light.
  //
  // 2026-05-21 follow-up: with multi-scatter at unit weight the
  // aerial-perspective contribution dominates the planet's surface
  // (terrain reads as a uniform blue haze, can't see the land).
  // Hillaire-typical multi-bounce contribution is 10-30% of single-
  // bounce; we scale by 0.15 to land squarely in that range. Can
  // tune up later once the unit-scaling pipeline is validated, but
  // this restores surface readability immediately.
  let MS_SCALE: f32 = 0.15;
  let result = sunI * sunVis * (betaR * phaseR * inScatterR
                              + betaM * phaseM * inScatterM
                              + multiScatterAccum * MS_SCALE);
  // Sprint 7.6.b-atm Tier-C.0 -- view-path transmittance (Beer-Lambert).
  // Per-channel since Rayleigh scattering is wavelength-dependent;
  // BLUE attenuates faster than RED so distant ground reads warm
  // through atmosphere (the "sunset-tint on the far hills" effect).
  let viewExt = betaR * opticalDepthR + betaM * 1.1 * opticalDepthM;
  let transmittance = exp(-viewExt);
  return AtmResult(max(result, vec3<f32>(0.0)), transmittance);
}

// PUBLIC: sky-pass usage. View ray runs to the atmosphere far side
// (or ground intersection). Returns the in-scatter integrated along
// the full view path -- this is the SKY COLOR for that direction.
//
// 2026-05-21 Sprint 7.6.b -- ungated. The earlier v4 altitude gate
// was a band-aid for the missing transmittance term on the planet
// body. Now that Tier C.0 applies transmittance correctly, the
// planet body's silhouette fades to atmospheric color naturally
// and the sky-pass scattering shows the atmosphere as a VISIBLE
// BAND ABOVE the planet body -- exactly what real orbital photos
// show (Earth's thin blue limb extending above the solid surface).
// The two compositions meet seamlessly at the silhouette because
// they integrate the same atmosphere along adjacent rays.
fn sample_planet_atmosphere(rayOrigin: vec3<f32>, rayDir: vec3<f32>) -> vec3<f32> {
  let planetR = uS.envPlanet.w;
  let atmR    = uS.envPlanetAtm.x;
  if (planetR <= 0.0 || atmR <= planetR) {
    return vec3<f32>(0.0);
  }
  let r = _atm_integrate(rayOrigin, rayDir, -1.0);
  return r.inScatter;
}

// PUBLIC: AERIAL PERSPECTIVE for a lit fragment. Returns BOTH the
// in-scatter (additive on top of surface) AND the view-path
// transmittance (multiplicative on the surface color), packed into
// AtmResult. Caller uses:
//   let ap = aerial_perspective(uS.eye.xyz, in.worldPos);
//   final = surface_color * ap.transmittance + ap.inScatter;
//
// At grazing angles (limb) the long atmospheric path drops
// transmittance toward zero so the surface color FADES OUT into
// pure atmospheric scattering, closing the visible gap between the
// planet body and the sky-pass scattering. This is the C.0 fix
// that ships ahead of the full Hillaire LUT pipeline.
fn aerial_perspective(camPos: vec3<f32>, fragPos: vec3<f32>) -> AtmResult {
  let v = fragPos - camPos;
  let dist = length(v);
  if (dist < 1.0) { return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0)); }
  let dir = v / dist;
  return _atm_integrate(camPos, dir, dist);
}

// C.5 -- Aerial-perspective LUT sample. Looks up the precomputed
// in-scatter + transmittance for a surface fragment at world position
// fragPos. Faster than the per-pixel aerial_perspective integrator
// (one trilinear lookup vs 16+16 ray samples).
//
// The LUT is a 2D-array (32 layers, each layer = one depth slice).
// We sample two adjacent layers and lerp manually because WGSL's
// 2D-array sampling doesn't interpolate across layers automatically.
//
// Distance-to-layer mapping is quadratic: layer_f = (N-1) *
// sqrt(distance / maxDist), inverting the LUT-generation formula.
// The clip-space coords come from projecting fragPos through the
// existing viewProj; v is flipped because of the same NDC<->UV
// convention noted in the LUT v-flip fix.
// 2026-05-22 STRUCTURAL FIX -- the depth-layer ring-banding the user
// reported was a fundamental consequence of the aerial-perspective
// LUT having a depth axis: per-LUT-voxel sample-vs-density aliasing
// is baked into the LUT contents, and no amount of inter-layer
// filtering can recover it.
//
// Replacement: use the existing sky-view LUT for in-scatter (it
// already integrates camera-in-direction to ground-or-atm-exit) and
// the transmittance LUT for the camera-to-surface transmittance
// (one analytic lookup, since for surface fragments the ray ENDS at
// the ground intersection -- exactly where T_LUT clips). Both LUTs
// have NO depth axis, so no depth-layer aliasing whatsoever.
//
// Caveats: assumes the surface fragment is approximately at the
// ground intersection distance (true for the planet mesh; not for
// arbitrary elevated geometry on top of the planet). Adequate for
// our use case; for full Bruneton-style analytic aerial perspective
// with arbitrary surface elevations, a 3D pre-baked single-scatter
// LUT would be needed.
fn sample_aerial_perspective_lut(camPos: vec3<f32>, fragPos: vec3<f32>) -> AtmResult {
  let v = fragPos - camPos;
  let dist = length(v);
  if (dist < 1.0) { return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0)); }
  let dir = v / dist;

  let planetC = uS.envPlanet.xyz;
  let planetR = uS.envPlanet.w;
  let atmR    = uS.envPlanetAtm.x;
  let atmThk  = atmR - planetR;

  if (planetR <= 0.0 || atmR <= planetR) {
    return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0));
  }

  // Atmosphere entry point. Camera may be outside the atm shell
  // (orbital view); cam-to-entry is vacuum (T=1, zero scatter) so
  // the meaningful aerial-perspective path is entry-to-fragment.
  let oc = camPos - planetC;
  let b  = dot(oc, dir);
  let cAtm = dot(oc, oc) - atmR * atmR;
  var entryPos = camPos;
  if (cAtm > 0.0) {
    let hAtm = b * b - cAtm;
    if (hAtm < 0.0) {
      // Ray doesn't intersect the atmosphere at all.
      return AtmResult(vec3<f32>(0.0), vec3<f32>(1.0));
    }
    let sAtm = sqrt(hAtm);
    let tEnter = -b - sAtm;
    if (tEnter > 0.0) { entryPos = camPos + dir * tEnter; }
  }

  // Per-channel transmittance via direct transmittance LUT lookup.
  // T_LUT(cosVZ, alt) returns the transmittance from a point at
  // altitude alt along direction cosVZ to atm edge OR ground
  // (whichever comes first). For a ray heading toward a surface
  // fragment the LUT clips at ground = the fragment, so this single
  // lookup is T(entry, frag) analytically. (T(cam, entry) = 1 when
  // camera is outside the atm, so T(cam, frag) = T_LUT.)
  //
  // Sprint 10-6 v7: shift LUT lookup from MSL to AGL by subtracting
  // the terrain height at the camera's lat/lon (envPlanetGeom.y).
  // The LUT is calibrated assuming density falls off from planetR
  // (sea level) -- but a camera on a 5 km mountain peak should see
  // through THIN air (it's above the densest atmosphere layer), not
  // through 5 km of sea-level dense air. Subtracting terrain shifts
  // the reference so vT=0 (densest LUT row) corresponds to the local
  // terrain rather than always to sea level.
  let entryRadial = entryPos - planetC;
  let entryRadialLen = length(entryRadial);
  let terrainAtCam = max(0.0, uS.envPlanetGeom.y);
  let entryAltMSL = max(0.0, entryRadialLen - planetR);
  let entryAlt = max(0.0, entryAltMSL - terrainAtCam);
  let entryUp  = entryRadial / max(entryRadialLen, 1.0);
  let cosVZ = dot(dir, entryUp);
  let uT = sqrt(clamp(cosVZ * 0.5 + 0.5, 0.0, 1.0));
  let vT = sqrt(clamp(entryAlt / max(atmThk, 1.0), 0.0, 1.0));
  let transmittance = textureSampleLevel(atmTransmittanceLUT, atmLutSampler,
                                          vec2<f32>(uT, 1.0 - vT), 0.0).rgb;

  // In-scatter via the existing sky-view LUT. For directions where
  // the ray hits the ground (true for every surface pixel by
  // definition), the sky-view LUT integrated FROM the camera in
  // that direction TO the ground hit -- exactly the aerial-
  // perspective in-scatter. No depth axis = no depth aliasing.
  let inScatterFull = sample_skyview_lut(dir);

  // Sprint 10-6 v6 -- distance-aware aerial perspective, retuned.
  // Previous 25 km scale height was still too aggressive at typical
  // surface viewing distances. The atmosphere LUT is MSL-referenced
  // (densest at sea level), so when standing on a mountain or flying
  // low over terrain, looking horizontally at terrain a few km away
  // gave heavy fog -- user reported "atmosphere peaks 1km above the
  // surface, surface is very foggy." 80 km scale height matches
  // typical clear-day terrestrial visibility (you can see mountains
  // 50+ km away clearly on a good day) while still fogging the
  // 100+ km horizon and orbital-to-ground transition.
  //
  //   dist 1 km   -> apScale 0.012 (basically clear)
  //   dist 5 km   -> apScale 0.06  (clear)
  //   dist 25 km  -> apScale 0.27  (light haze)
  //   dist 50 km  -> apScale 0.46  (moderate haze)
  //   dist 100 km -> apScale 0.71  (heavy haze)
  //   dist 200 km -> apScale 0.92  (mostly fog)
  //
  // Proper fix later: feed terrain altitude into the LUT so AP
  // density references AGL (height above terrain) instead of MSL
  // (height above sea level). For now, the wider scale just makes
  // the visible-vs-fogged transition match physical intuition.
  let apScale = 1.0 - exp(-dist / 80000.0);
  let inScatter = inScatterFull * apScale;
  let transmittanceScaled = mix(vec3<f32>(1.0), transmittance, apScale);

  return AtmResult(inScatter, transmittanceScaled);
}

/* ---- Sprint 7.6.a-night: photorealistic stars + Milky Way helpers.
 *
 * Three components combined per fragment:
 *  1) Multi-magnitude starfield  -- 3 grid scales = 3 magnitude bands,
 *     density boosted near the galactic plane (Hipparcos density rises
 *     ~5× inside |b|<10°).
 *  2) Galactic-frame Milky Way   -- band intensity from |sin(b)|,
 *     center-vs-anticenter asymmetry, 3-octave cloud fbm + threshold-
 *     cut dust lanes, warm bulge → cool disk color gradient.
 *  3) HII nebula highlights      -- rare reddish-pink blobs gated by a
 *     low-freq mask, only on the bright side of the band.
 *
 * All in pure WGSL; no textures, no CPU upload. Uses smooth value
 * noise instead of raw lattice hash because the Milky Way needs
 * cloud-like continuity across the visible band.
 */

fn _sky_hash3(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}

fn _sky_vnoise3(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // smootherstep
  let c000 = _sky_hash3(i + vec3<f32>(0.0, 0.0, 0.0));
  let c100 = _sky_hash3(i + vec3<f32>(1.0, 0.0, 0.0));
  let c010 = _sky_hash3(i + vec3<f32>(0.0, 1.0, 0.0));
  let c110 = _sky_hash3(i + vec3<f32>(1.0, 1.0, 0.0));
  let c001 = _sky_hash3(i + vec3<f32>(0.0, 0.0, 1.0));
  let c101 = _sky_hash3(i + vec3<f32>(1.0, 0.0, 1.0));
  let c011 = _sky_hash3(i + vec3<f32>(0.0, 1.0, 1.0));
  let c111 = _sky_hash3(i + vec3<f32>(1.0, 1.0, 1.0));
  let x00 = mix(c000, c100, u.x);
  let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x);
  let x11 = mix(c011, c111, u.x);
  let y0  = mix(x00, x10, u.y);
  let y1  = mix(x01, x11, u.y);
  return mix(y0, y1, u.z);
}

fn _sky_fbm3(p: vec3<f32>, octaves: i32) -> f32 {
  var amp:  f32 = 0.5;
  var freq: f32 = 1.0;
  var sum:  f32 = 0.0;
  var norm: f32 = 0.0;
  for (var i: i32 = 0; i < octaves; i = i + 1) {
    sum  = sum  + amp * _sky_vnoise3(p * freq);
    norm = norm + amp;
    amp  = amp  * 0.5;
    freq = freq * 2.03;      // jittered to break axis-aligned pulses
  }
  return sum / max(norm, 1e-6);
}

/* Star color from a temperature hash in [0,1]. Skewed toward cool
 * reds (real stellar IMF: most stars are M-class) with rare blue
 * giants -- pow(0.55) remaps a uniform hash so the bulk of stars
 * land in the warm half. */
fn _sky_star_color(tIn: f32) -> vec3<f32> {
  let t = pow(clamp(tIn, 0.0, 1.0), 0.55);
  if (t < 0.30) {
    return mix(vec3<f32>(1.00, 0.55, 0.32),     // M red
               vec3<f32>(1.00, 0.78, 0.55),     // K orange
               t / 0.30);
  } else if (t < 0.55) {
    return mix(vec3<f32>(1.00, 0.78, 0.55),
               vec3<f32>(1.00, 1.00, 0.96),     // G/F yellow-white
               (t - 0.30) / 0.25);
  } else if (t < 0.80) {
    return mix(vec3<f32>(1.00, 1.00, 0.96),
               vec3<f32>(0.86, 0.92, 1.00),     // A white-blue
               (t - 0.55) / 0.25);
  } else {
    return mix(vec3<f32>(0.86, 0.92, 1.00),
               vec3<f32>(0.62, 0.74, 1.00),     // B/O blue
               (t - 0.80) / 0.20);
  }
}

/* Galactic frame projection. Returns vec2(sin(galLat), cos(galLon))
 * where galLat = 0 on the plane, ±π/2 at the poles, and galLon = 0
 * pointing toward the galactic center. The Gram-Schmidt step keeps
 * the center direction perpendicular to the pole regardless of how
 * the pole guess is normalized. */
fn _sky_galactic(dir: vec3<f32>) -> vec2<f32> {
  let galPole = normalize(vec3<f32>(0.45, 0.75, -0.48));
  let guess   = vec3<f32>(0.80, 0.10, 0.59);
  let center  = normalize(guess - galPole * dot(guess, galPole));
  let sinLat  = dot(dir, galPole);
  let inPlane = normalize(dir - galPole * sinLat);
  let lonCos  = dot(inPlane, center);
  return vec2<f32>(sinLat, lonCos);
}

/* Standard HSV→RGB (Sam Hocevar's branchless form). Used by the
 * mantis-shrimp nebula pass to cycle through the full color wheel
 * instead of mixing two anchor colors. */
fn _sky_hsv_to_rgb(c: vec3<f32>) -> vec3<f32> {
  let K = vec4<f32>(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx,
                   clamp(p - K.xxx, vec3<f32>(0.0), vec3<f32>(1.0)),
                   c.y);
}

/* Volumetric Milky Way + unrealistic nebula raymarch.
 *
 * Earlier sprint baked the band analytically (single sample per
 * fragment of bandFalloff × cloudNoise × dustMask). That reads as
 * a flat painted streak -- no depth. This pass marches the view
 * ray through a 3D density field constrained near the galactic
 * plane, so overlapping cloud structures actually composite over
 * each other and the band gets the parallax-y feel of clouds at
 * different distances. Hue is sampled per-step from an independent
 * fbm and run through HSV with full-wheel cycling, giving the
 * mantis-shrimp palette (cyan / magenta / lime / hot pink / violet
 * / electric blue) rather than the realistic warm-bulge → cool-
 * disk gradient.
 *
 * Cost: ~16 steps × (3-oct density fbm + 2-oct hue fbm + 1 vnoise)
 * per ray that touches the band. Early-outs aggressively when far
 * from the plane (|sin b| > 0.42) and on alpha saturation. */
fn _sky_volumetric_band(dir: vec3<f32>,
                        sinLat: f32,
                        lonCos: f32,
                        starVis: f32) -> vec3<f32> {
  let absLat = abs(sinLat);
  if (absLat > 0.42) {
    return vec3<f32>(0.0);
  }
  let bandCore = exp(-absLat * absLat * 22.0);
  let centerW  = pow(clamp(0.5 + 0.5 * lonCos, 0.0, 1.0), 1.4);

  var accum    = vec3<f32>(0.0);
  var alpha:   f32 = 0.0;
  let STEPS:   i32 = 16;
  let TSTART:  f32 = 1.0;
  let TSTEP:   f32 = 0.14;

  for (var i: i32 = 0; i < STEPS; i = i + 1) {
    let t = TSTART + TSTEP * f32(i);
    let p = dir * t;

    // Density. Carved into band shape so wide cutoff doesn't paint
    // a uniform glow above the disk. (dN - 0.40) * 2.5 gives a
    // sharper edge than raw fbm.
    let dN = _sky_fbm3(p * 2.2 + vec3<f32>(7.3, 1.1, 4.9), 3);
    let density = clamp((dN - 0.40) * 2.5, 0.0, 1.0)
                * bandCore
                * (0.35 + 0.65 * centerW);
    if (density < 0.003) { continue; }

    // Hue: independent low-freq fbm + a high-freq detail term
    // + small per-step phase to give different depths different
    // hues (parallax-color illusion). lonCos pushes the hue across
    // the band so the center isn't the same shade as the wings.
    let hueN1 = _sky_fbm3(p * 1.3 + vec3<f32>(11.7, -3.4, 8.8), 2);
    let hueN2 = _sky_vnoise3(p * 5.1 + vec3<f32>(0.7, 4.2, -1.6));
    let hue   = fract(hueN1 * 1.9
                      + hueN2 * 0.40
                      + lonCos * 0.18
                      + f32(i) * 0.011);
    let sat   = mix(0.70, 1.00, smoothstep(0.0, 1.0, density));
    let val   = 1.0 + 0.7 * smoothstep(0.55, 0.95, density);
    let stepCol = _sky_hsv_to_rgb(vec3<f32>(hue, sat, val));

    accum = accum + stepCol * density * (1.0 - alpha);
    alpha = min(1.0, alpha + density * 0.45);
    if (alpha > 0.97) { break; }
  }

  return accum * starVis * 1.5;
}

fn sample_procedural_sky_features(dir: vec3<f32>) -> vec3<f32> {
  let sunDir    = uS.envSun.xyz;
  let sunVis    = uS.envSun.w;
  let turbidity = uS.envParams.z;
  let intensity = uS.envParams.y;
  let moonPhase = uS.envSky.w;   // packed by JS; 0/1=new, 0.5=full

  let view_y   = clamp(dir.y, -1.0, 1.0);
  let sun_elev = clamp(sunDir.y, -1.0, 1.0);
  let day      = smoothstep(-0.08, 0.18, sun_elev);
  let night    = 1.0 - day;
  // §planet-spec Phase 5+ -- stars also pop out at altitude even
  // during the day, because the atmosphere is thin enough that sun
  // glare doesn't drown them anywhere except near the sun direction.
  // star_vis is whichever is brighter (it's night, OR we're in space).
  //
  // Sprint 7.6.a-atm BUG-FIX 2026-05-21: previously altFade used
  // uS.eye.y (world Y altitude) which assumed Y-up flat ground.
  // On a PLANET the camera can be on any face -- a camera at 200km
  // altitude on the +X side of the planet has eye.y=0, so altFade
  // was permanently 0 and stars never appeared even when actually
  // in space. Use planet-aware altitude when a planet is wired:
  // distance-from-planet-center minus surface radius. Falls back to
  // eye.y for non-planet scenes.
  //
  // Transition band 50km -> 100km matches the Karman line (100km =
  // physical space-boundary by international convention; below that
  // is "atmosphere", above is "space"). Stars fade in across the
  // upper-atmosphere band so the transition is smooth instead of
  // a hard pop at the planet's atmosphere-top radius.
  var altitude_m: f32;
  if (uS.envPlanet.w > 0.0) {
    altitude_m = max(0.0, length(uS.eye.xyz - uS.envPlanet.xyz) - uS.envPlanet.w);
  } else {
    altitude_m = uS.eye.y;
  }
  let altFade  = clamp((altitude_m - 50000.0) / 50000.0, 0.0, 1.0);
  let star_vis = max(night, altFade);

  var col = vec3<f32>(0.0);

  // --- Sun. 0.53° angular diameter -- our actual sun's apparent
  //     size from Earth orbit (sun radius 696,000 km / 1 AU). The
  //     bright HDR disc gets clipped to pure white by the ACES
  //     tonemap, while the wide halo carries the glow into the
  //     surrounding sky so the eye reads "luminous body" rather
  //     than just "bright pixel."
  //
  //     Math:
  //       angle from sun center = acos(cos_theta)
  //       cos(0.265°) ≈ 0.999989  (full sun edge, radius 0.265°)
  //       cos(0.443°) ≈ 0.99997   (~0.18° anti-aliased rim)
  //       cos(5°)     ≈ 0.99619   (outer halo edge)
  //
  //     Brightness:
  //       disc peak = 220 × sunDiskColor (≈480 raw red) -- ACES clips
  //                   to white in the center, leaving the edge of the
  //                   disc to fade through the tone curve
  //       halo peak = 6 × sunDiskColor with a cubic falloff toward
  //                   the edge, simulating atmospheric forward scatter
  //                   + atmospheric+lens corona feel
  let cos_theta = clamp(dot(dir, sunDir), -1.0, 1.0);
  let sunExt = _sky_sun_extinction(max(sun_elev, -0.05), turbidity);
  let sunDiskColor = sunExt * vec3<f32>(2.2, 2.0, 1.8);

  let disk = smoothstep(0.99997, 0.999989, cos_theta) * sunVis;
  col = col + disk * sunDiskColor * 220.0;

  let halo_r = smoothstep(0.99619, 0.999989, cos_theta) * sunVis;
  let halo = halo_r * halo_r * halo_r;
  col = col + halo * sunDiskColor * 6.0;

  // --- Moon. Placed directly opposite the sun (full-moon position).
  //     Phase param modulates lit fraction via sin(phase·π) -- gives
  //     0 (new) at moonPhase=0/1 and 1 (full) at moonPhase=0.5. v1
  //     just brightness-modulates; a proper crescent shape would
  //     compute per-pixel lit hemisphere via sphere math.
  let moonDir    = -sunDir;
  let cos_moon   = clamp(dot(dir, moonDir), -1.0, 1.0);
  let moon_vis   = clamp(night, 0.0, 1.0);
  let phaseLit   = sin(clamp(moonPhase, 0.0, 1.0) * 3.14159265);
  let moon_disk  = smoothstep(0.99988, 0.99996, cos_moon) * moon_vis * 5.0 * phaseLit;
  let moon_halo  = smoothstep(0.985, 0.9999, cos_moon)   * moon_vis * 0.05 * phaseLit;
  let moon_color = vec3<f32>(0.92, 0.95, 1.00);
  col = col + (moon_disk + moon_halo) * moon_color;

  // --- Sprint 7.6.a-night: photoreal starfield + galactic Milky Way.
  //
  // Three components rolled into one if-block. Helpers are above the
  // function: _sky_hash3 (lattice hash), _sky_vnoise3 (smooth value
  // noise -- needed because raw lattice hash repeats visibly across
  // the Milky Way's wide band), _sky_fbm3 (3-octave fbm for cloud
  // structure), _sky_star_color (stellar-IMF biased temperature →
  // color), _sky_galactic (returns sin(b), cos(l) in galactic frame).
  //
  // §planet-spec Phase 5+: view_y > 0 gate removed -- in space the
  // user looks DOWN at the planet and stars are visible everywhere
  // not occluded by it; planet mesh depth-tests against the sky.
  if (star_vis > 0.001) {
    let gal     = _sky_galactic(dir);
    let sinLat  = gal.x;                         // sin(galactic lat)
    let lonCos  = gal.y;                         // cos(galactic lon)
    let absLat  = abs(sinLat);
    let bandFalloff = exp(-absLat * absLat * 28.0);   // ~10° band
    let densityBoost = 1.0 + 3.0 * bandFalloff;       // plane bias

    // --- 1) BRIGHT stars (rare, coarse grid). m≈1 magnitude class.
    let p1 = floor(dir * 80.0);
    let h1 = _sky_hash3(p1);
    let t1 = _sky_hash3(p1 + vec3<f32>(7.0, 13.0, 19.0));
    let tw1 = 0.65 + 0.35 * _sky_hash3(p1 + vec3<f32>(91.0, 53.0, 11.0));
    let amt1 = smoothstep(0.998, 1.0, h1) * star_vis * 3.5;
    col = col + _sky_star_color(t1) * amt1 * tw1;

    // --- 2) MID stars (medium grid). m≈3 magnitude class.
    let p2 = floor(dir * 220.0);
    let h2 = _sky_hash3(p2);
    let t2 = _sky_hash3(p2 + vec3<f32>(7.0, 13.0, 19.0));
    let tw2 = 0.60 + 0.40 * _sky_hash3(p2 + vec3<f32>(91.0, 53.0, 11.0));
    let thr2 = 0.995 - 0.005 * bandFalloff;          // looser near plane
    let amt2 = smoothstep(thr2, 1.0, h2) * star_vis * 1.5 * densityBoost;
    col = col + _sky_star_color(t2) * amt2 * tw2;

    // --- 3) DIM stars (fine grid). m≈5+ magnitude class. The bulk
    //     of visible stars on a dark site come from this layer.
    let p3 = floor(dir * 520.0);
    let h3 = _sky_hash3(p3);
    let t3 = _sky_hash3(p3 + vec3<f32>(7.0, 13.0, 19.0));
    let tw3 = 0.60 + 0.40 * _sky_hash3(p3 + vec3<f32>(91.0, 53.0, 11.0));
    let thr3 = 0.992 - 0.010 * bandFalloff;
    let amt3 = smoothstep(thr3, 1.0, h3) * star_vis * 0.7 * densityBoost;
    col = col + _sky_star_color(t3) * amt3 * tw3;

    // --- 4) Volumetric Milky Way + mantis-shrimp nebulas.
    //     Replaces the previous flat painted band + separate HII
    //     blob pass. Raymarches the view ray through a 3D density
    //     field constrained near the galactic plane and accumulates
    //     emissive color from independent hue fbm sampled per step.
    //     Full HSV-wheel cycling gives the saturated cyan / magenta
    //     / lime / hot-pink / violet palette instead of the realistic
    //     warm-brown / cool-blue duo.
    col = col + _sky_volumetric_band(dir, sinLat, lonCos, star_vis);
  }

  return col * intensity;
}

fn sample_procedural_sky(dir: vec3<f32>) -> vec3<f32> {
  return sample_procedural_sky_smooth(dir) + sample_procedural_sky_features(dir);
}

// Sprint 7.5.4 -- sample the wired environment by direction. Used
// for hemisphere IBL ambient on lit materials (Phong, PBR). dir
// should be a normalized world-space vector (e.g. the surface
// normal for diffuse ambient, the reflection vector for specular).
fn sample_env(dir: vec3<f32>) -> vec3<f32> {
  let mode = u32(uS.envParams.x);
  if (mode == 1u) {
    // GradientSky: 3-stop. Above horizon -> mix(horizon, sky); below
    // -> mix(horizon, ground). smoothstep softens the equator band
    // so a glossy reflection doesn't show a knife edge.
    let t = clamp(dir.y, -1.0, 1.0);
    let intensity = uS.envParams.y;
    if (t > 0.0) {
      return mix(uS.envHorizon.rgb, uS.envSky.rgb,    smoothstep(0.0, 1.0, t)) * intensity;
    } else {
      return mix(uS.envHorizon.rgb, uS.envGround.rgb, smoothstep(0.0, 1.0, -t)) * intensity;
    }
  }
  if (mode == 2u) {
    // 2026-05-21 Sprint 7.6.a-atm -- IBL ambient: if a planet is
    // wired use Tier B planet atmosphere (proper sky color from the
    // camera's altitude), else fall back to the legacy flat-ground
    // smooth sky. Features (disk/moon/stars) never go through IBL.
    // C.4 -- now backed by the sky-view LUT (same precomputed
    // atmosphere color as fs_sky), so IBL ambient on planet-aware
    // surfaces stays consistent with the visible sky.
    if (uS.envPlanet.w > 0.0) {
      return sample_skyview_lut(dir);
    }
    return sample_procedural_sky_smooth(dir);
  }
  if (mode == 3u) {
    // Sprint 7.5.4.b -- HDRI / Skybox. Equirectangular texture
    // sample. envParams.y is the intensity multiplier (lets users
    // dial exposure without re-loading the file). textureSampleLevel
    // at LOD 0 -- mipmap generation for the env texture is a future
    // polish; without it the diffuse IBL sample (which would
    // benefit from a low LOD for smoothing) can show high-freq
    // texels in matte reflections.
    let uv = dir_to_equirect_uv(dir);
    let hdr = textureSampleLevel(envTexture, envSampler, uv, 0.0);
    return hdr.rgb * uS.envParams.y;
  }
  // Default: pre-7.5.4 hardcoded hemisphere-IBL. Two-stop gradient
  // from cool sky to warm ground via the up-axis-aligned mix that
  // fs_pbr used inline pre-refactor.
  let envSkyD    = vec3<f32>(0.55, 0.62, 0.78);
  let envGroundD = vec3<f32>(0.18, 0.16, 0.14);
  return mix(envGroundD, envSkyD, dir.y * 0.5 + 0.5);
}
struct PerDraw {
  model:      mat4x4<f32>,
  baseColor:  vec4<f32>,   // .rgb = material color, .a = vertex-color mix amount (0 = pure material color, 1 = pure vertex color)
  matParams:  vec4<f32>,   // .x = shininess (Phong/Terrain), .y = ambient (Phong/Terrain), .z = metallic (PBR) / slopeRockiness (Terrain), .w = roughness (PBR) / vertexMix (Terrain)
  // v0.3.123 Phase 7 §5.5.c -- TerrainMaterial. Four band slots,
  // each holding an RGB color in .rgb and an altitude threshold
  // (or softness for band4) in .a. Ignored by every other material;
  // they read only model + baseColor + matParams. fs_terrain reads
  // these to do altitude+slope-blended shading.
  band1:      vec4<f32>,   // .rgb = sand color,   .a = alt1 (top of band1)
  band2:      vec4<f32>,   // .rgb = grass color,  .a = alt2
  band3:      vec4<f32>,   // .rgb = rock color,   .a = alt3
  band4:      vec4<f32>,   // .rgb = snow color,   .a = softness (smoothstep half-width)
  // v0.3.126 Phase 7 §5.5.c-3 -- vsParams for vertex-shader
  // heightmap displacement (ProceduralTerrain → Terrain.heightmap).
  //   x = heightScale   (multiplier applied to sampled height)
  //   y = worldSize     (full extent of the grid, used to compute
  //                      world-space derivatives for the normal)
  //   z = unused
  //   w = heightmap layer index in the scratch texture array
  // Read only by vs_terrain. vs_main ignores it.
  vsParams:   vec4<f32>,
  // v0.3.129 TerrainMaterial v2 -- detail + bump param blocks.
  //   detailParams.x = detailScale     (macro noise frequency)
  //   detailParams.y = detailStrength  (macro variation amount)
  //   detailParams.z = microScale      (micro noise frequency)
  //   detailParams.w = microStrength   (micro speckle amount)
  //   bumpParams.x   = edgeJitter      (noise on band boundaries)
  //   bumpParams.y   = bumpStrength    (procedural normal perturb)
  //   bumpParams.z   = snowMaskAmount  (snow only on flat tops)
  //   bumpParams.w   = unused
  // Read only by fs_terrain. Other fragment shaders ignore.
  detailParams: vec4<f32>,
  bumpParams:   vec4<f32>,
  // §5.5.h-5 -- Water-specific extra slot. waterExtra.xy = disc
  // center tile (X, Z) so the LOD-match shader uses the ACTUAL
  // disc center (with forwardBias applied) instead of the camera
  // tile -- otherwise water foam misaligns east/west of the
  // player when they look around. Other material shaders ignore.
  waterExtra:   vec4<f32>,
  // §5.5.h-21 -- cloud-shadow params (Clouds3D node, if wired).
  //   cloudExtra.x = cloud altitude (slab base Y)
  //   cloudExtra.y = cloud coverage (0..1; 0 = disabled)
  //   cloudExtra.z = cloud noise scale (world XZ frequency)
  //   cloudExtra.w = cloud seed
  // Read by fs_water to project the water pixel up along the sun
  // ray and sample cloud density; if a cloud is overhead the water
  // pixel is shadowed. Other material shaders ignore.
  cloudExtra:   vec4<f32>,
  // Phase 8 sprint 8-3b -- PlanetMesh texture inputs.
  //   planetExtra.x = land texture layer (-1 = no land texture wired)
  //   planetExtra.y = water texture layer (-1 = no water texture wired)
  //   planetExtra.z = textureScale (inverse world units per repeat)
  //   planetExtra.w = textureMix (0 = pure biome, 1 = pure texture)
  // Read only by fs_unlit_vc's planet-aware branch.
  planetExtra:  vec4<f32>,
};
@group(0) @binding(0) var<uniform> uS: PerScene;
@group(0) @binding(1) var<uniform> uD: PerDraw;

// Sprint 7.5.3c push 5 -- texture binding for ShaderMat. Bound to
// the scratch texture array (matched parity with Scene's readKey
// since Scene is depth=0 → readKey="a", upstreams of ShaderMat at
// depth=1 → writeKey="a"). Unused by non-ShaderMat materials, but
// always present in the BGL so the pipeline layout is uniform.
@group(0) @binding(2) var srcTexture: texture_2d_array<f32>;
@group(0) @binding(3) var srcSampler: sampler;

// Sprint 7.5.4.b -- env texture for HDRI / Skybox equirect sampling.
// Bound to a 1x1 mid-gray when no HDRI is loaded; sample_env mode 3
// is the only path that reads it. RGBA16Float so HDR values > 1
// pass through (clamp happens at framebuffer write).
@group(0) @binding(4) var envTexture: texture_2d<f32>;
@group(0) @binding(5) var envSampler: sampler;

// Sprint 7.6.b-atm Tier-C.1 -- atmosphere LUTs. Updated each frame
// before the scene pass by _renderAtmosphereLUTs. Sampled in
// _atm_integrate to add the multi-scattering term (the limb glow
// term that lights the side of the atmosphere opposite the sun).
//   binding 6 = transmittance LUT (256 x 64 RGBA16F)
//   binding 7 = multi-scattering LUT (32 x 32 RGBA16F)
//   binding 8 = LUT sampler (linear, clamp-to-edge)
// All three default to a 1x1 black texture / env sampler when no
// planet is wired; sample sites guard on uS.envPlanet.w > 0 anyway.
@group(0) @binding(6) var atmTransmittanceLUT: texture_2d<f32>;
@group(0) @binding(7) var atmMultiScatterLUT:  texture_2d<f32>;
@group(0) @binding(8) var atmLutSampler:       sampler;
// C.4 -- sky-view LUT: full-sphere precomputed atmospheric color for
// the current camera position, indexed by (azimuth, elevation) in the
// camera's planet-local frame. fs_sky samples this in one texture
// fetch instead of running its own per-pixel atmosphere integral.
@group(0) @binding(9) var atmSkyViewLUT:       texture_2d<f32>;
// Sprint 10-5c-c: Sparse Virtual Texture bindings. Atlas is a single
// 4096² RGBA8 texture holding 32×32 = 1024 page slots of 128² each.
// Page table is a 256² R32Uint × 6-layer array, one layer per cube
// face, encoding (slotY << 16) | slotX for resident pages or
// 0xFFFFFFFF for unresident.
@group(0) @binding(10) var svtAtlas:       texture_2d<f32>;
@group(0) @binding(11) var svtSampler:     sampler;
@group(0) @binding(12) var svtPageTable:   texture_2d_array<u32>;
// Sprint 10-5c-g: paired normal-map atlas, same 1024-slot layout as
// svtAtlas. RGB encodes tangent-space normal (XYZ in [-1, 1] via
// (raw - 0.5) * 2). Sampled with the same atlas UV.
@group(0) @binding(13) var svtNormalAtlas: texture_2d<f32>;
// Sprint 10-5c-h: PBR material atlas. R=rough, G=metal, B=AO, A=reserved.
@group(0) @binding(14) var svtMaterialAtlas: texture_2d<f32>;
// Sprint 10-5c-h2: fine-zoom page table (1024² pages per face, 6 layers).
// Sampled first; base table (binding 12) used as fallback when fine
// page is unresident.
@group(0) @binding(15) var svtPageTableFine: texture_2d_array<u32>;
// Phase 8.B.15 A.4 -- per-material PBR maps (PhysicalMat textures).
// Bound to 1x1 defaults when a material has no map so existing
// untextured meshes are byte-identical: albedo=white (x1 = no-op),
// normal=(0.5,0.5,1) (tangent +Z = no perturb), rough/metal=white
// (x1 = uses the material's scalar param unchanged). Sampled in
// fs_pbr with srcSampler (binding 3) at the mesh's uv.
@group(0) @binding(16) var matAlbedoTex:   texture_2d<f32>;
@group(0) @binding(17) var matNormalTex:   texture_2d<f32>;
@group(0) @binding(18) var matRoughTex:    texture_2d<f32>;
@group(0) @binding(19) var matMetalTex:    texture_2d<f32>;

/* SVT sampling helper. Given a unit-sphere world direction, returns
 * (rgb, pageResidentFlag). Flag = 1.0 if the page was resident in
 * the atlas and rgb is valid sampled detail; 0.0 if not resident,
 * caller should fall back to per-fragment procedural.
 *
 * Implementation:
 *   1. Pick cube face by max-axis test.
 *   2. Compute face-local (u, v) ∈ [0, 1] via spherify-inverse.
 *      (For now use simple atan2-style projection -- not the exact
 *      inverse of the bake's spherify warp. Close enough at 256²
 *      page resolution; refine to true inverse in 10-5c-f.)
 *   3. Compute (pageX, pageY) and local UV within page.
 *   4. textureLoad page-table → packed slot id.
 *   5. If unresident (= 0xFFFFFFFF), return flag=0.
 *   6. Else sample atlas at slot+local UV with linear filter. */
struct SvtSample {
  albedo:    vec3<f32>,
  normal:    vec3<f32>,   // tangent-space normal, normalized
  roughness: f32,         // 0 = mirror, 1 = matte
  metallic:  f32,         // 0 = dielectric, 1 = pure metal
  ao:        f32,         // 1 = no occlusion
  resident:  f32,         // 1.0 if page resident, 0.0 otherwise
};

/* Cube direction → (face, faceUV in [-1,1]). Shared by both base and
 * fine zoom samplers. */
fn _svt_face_uv(dir: vec3<f32>) -> vec3<f32> {
  let absX = abs(dir.x);
  let absY = abs(dir.y);
  let absZ = abs(dir.z);
  var face: f32 = 0.0;
  var u: f32 = 0.0;
  var v: f32 = 0.0;
  if (absX >= absY && absX >= absZ) {
    let inv = 1.0 / absX;
    if (dir.x > 0.0) { face = 0.0; u = -dir.z * inv; v = dir.y * inv; }
    else             { face = 1.0; u =  dir.z * inv; v = dir.y * inv; }
  } else if (absY >= absZ) {
    let inv = 1.0 / absY;
    if (dir.y > 0.0) { face = 2.0; u = dir.x * inv; v =  dir.z * inv; }
    else             { face = 3.0; u = dir.x * inv; v = -dir.z * inv; }
  } else {
    let inv = 1.0 / absZ;
    if (dir.z > 0.0) { face = 4.0; u =  dir.x * inv; v = dir.y * inv; }
    else             { face = 5.0; u = -dir.x * inv; v = dir.y * inv; }
  }
  return vec3<f32>(u, v, face);
}

/* Common atlas sample given a slot + within-page UV. */
fn _svt_read_atlas(slotX: u32, slotY: u32, inPageU: f32, inPageV: f32) -> SvtSample {
  var out: SvtSample;
  let slotsPerRow: f32 = 32.0;
  let atlasU = (f32(slotX) + inPageU) / slotsPerRow;
  let atlasV = (f32(slotY) + inPageV) / slotsPerRow;
  out.albedo = textureSampleLevel(svtAtlas, svtSampler, vec2<f32>(atlasU, atlasV), 0.0).rgb;
  let nRaw = textureSampleLevel(svtNormalAtlas, svtSampler, vec2<f32>(atlasU, atlasV), 0.0).rgb;
  out.normal = normalize((nRaw - vec3<f32>(0.5)) * 2.0);
  let mRaw = textureSampleLevel(svtMaterialAtlas, svtSampler, vec2<f32>(atlasU, atlasV), 0.0);
  out.roughness = mRaw.r;
  out.metallic  = mRaw.g;
  out.ao        = mRaw.b;
  out.resident  = 1.0;
  return out;
}

/* Try the fine page table first (1024² per face = ~78 m/texel); if
 * unresident, fall back to the base page table (256² per face =
 * ~300 m/texel). Caller checks .resident and falls back further
 * to per-fragment procedural if both miss. */
fn _svt_sample(dir: vec3<f32>) -> SvtSample {
  var out: SvtSample;
  out.albedo    = vec3<f32>(0.0);
  out.normal    = vec3<f32>(0.0, 0.0, 1.0);
  out.roughness = 0.78;
  out.metallic  = 0.0;
  out.ao        = 1.0;
  out.resident  = 0.0;

  let fuv = _svt_face_uv(dir);
  let u = fuv.x; let v = fuv.y; let face = i32(fuv.z);
  let uv01 = vec2<f32>(u * 0.5 + 0.5, v * 0.5 + 0.5);

  // FINE first: 1024 pages per face.
  let pagesFine: f32 = 1024.0;
  let pageFineFx = uv01.x * pagesFine;
  let pageFineFy = uv01.y * pagesFine;
  let pageFineX = i32(floor(pageFineFx));
  let pageFineY = i32(floor(pageFineFy));
  let inPageFineU = fract(pageFineFx);
  let inPageFineV = fract(pageFineFy);
  let fineEntry = textureLoad(svtPageTableFine,
                              vec2<i32>(pageFineX, pageFineY), face, 0).r;
  if (fineEntry != 0xFFFFFFFFu) {
    let slotX = fineEntry & 0xFFFFu;
    let slotY = (fineEntry >> 16u) & 0xFFFFu;
    return _svt_read_atlas(slotX, slotY, inPageFineU, inPageFineV);
  }

  // BASE fallback: 256 pages per face.
  let pagesBase: f32 = 256.0;
  let pageBaseFx = uv01.x * pagesBase;
  let pageBaseFy = uv01.y * pagesBase;
  let pageBaseX = i32(floor(pageBaseFx));
  let pageBaseY = i32(floor(pageBaseFy));
  let inPageBaseU = fract(pageBaseFx);
  let inPageBaseV = fract(pageBaseFy);
  let baseEntry = textureLoad(svtPageTable,
                              vec2<i32>(pageBaseX, pageBaseY), face, 0).r;
  if (baseEntry == 0xFFFFFFFFu) {
    return out;   // both unresident
  }
  let baseSlotX = baseEntry & 0xFFFFu;
  let baseSlotY = (baseEntry >> 16u) & 0xFFFFu;
  return _svt_read_atlas(baseSlotX, baseSlotY, inPageBaseU, inPageBaseV);
}

/* Sprint 10-5c-h: standard GGX/Smith/Schlick microfacet BRDF.
 * Used by fs_unlit_vc when SVT material data is resident, layered
 * over the existing baked-lambert vertex color. Adds proper
 * specular highlight that responds to view angle + sun direction
 * + material roughness. */
fn _pbr_specular(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>,
                 albedo: vec3<f32>, roughness: f32, metallic: f32) -> vec3<f32> {
  let H = normalize(V + L);
  let NoH = max(0.0, dot(N, H));
  let NoV = max(0.0, dot(N, V));
  let NoL = max(0.0, dot(N, L));
  let VoH = max(0.0, dot(V, H));
  // GGX / Trowbridge-Reitz normal distribution.
  let a  = max(0.01, roughness * roughness);
  let a2 = a * a;
  let NoH2 = NoH * NoH;
  let denom = NoH2 * (a2 - 1.0) + 1.0;
  let D = a2 / (3.14159265 * denom * denom);
  // Smith Schlick GGX geometric occlusion.
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let GV = NoV / (NoV * (1.0 - k) + k + 0.0001);
  let GL = NoL / (NoL * (1.0 - k) + k + 0.0001);
  let G  = GV * GL;
  // Schlick Fresnel. F0=0.04 for dielectric, albedo for metallic.
  let F0 = mix(vec3<f32>(0.04), albedo, metallic);
  let F  = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - VoH, 5.0);
  return (D * G * F) / max(4.0 * NoV * NoL, 0.001);
}

// Sample the multi-scattering LUT. Axes match fs_lut_multiscatter:
//   u = sunZenithCos in [-1, 1] mapped linearly to [0, 1]
//   v = sqrt(altitude / atmThickness) in [0, 1]
// 2026-05-22 fix: v inverted -- LUT is written with high-altitude
// at the top row (UV.v=0) because NDC.y=+1 maps to pixel.y=0 in
// WebGPU framebuffer convention.
fn sample_multiscatter_lut(cosSZ: f32, alt: f32, atmThickness: f32) -> vec3<f32> {
  let u = clamp(cosSZ * 0.5 + 0.5, 0.0, 1.0);
  let v = sqrt(clamp(alt / max(atmThickness, 1.0), 0.0, 1.0));
  return textureSampleLevel(atmMultiScatterLUT, atmLutSampler, vec2<f32>(u, 1.0 - v), 0.0).rgb;
}

// C.4 -- sample the sky-view LUT for a world-space view direction.
// Must match the (u, v) mapping used by fs_lut_skyview on the JS side.
// Local frame: zenith = (eye - planetCenter), north reference = world
// +Y projected to horizon plane (fallback +X near poles), east =
// up x north. Output is the pre-integrated atmospheric in-scatter
// for that direction including sun multiplier (in_scatter * sunI).
fn sample_skyview_lut(dir: vec3<f32>) -> vec3<f32> {
  let radial = uS.eye.xyz - uS.envPlanet.xyz;
  let radialLen = length(radial);
  if (radialLen < 1.0) { return vec3<f32>(0.0); }
  let localUp = radial / radialLen;
  var northRef = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(dot(localUp, northRef)) > 0.99) {
    northRef = vec3<f32>(1.0, 0.0, 0.0);
  }
  let localNorth = normalize(northRef - dot(northRef, localUp) * localUp);
  let localEast  = cross(localUp, localNorth);

  let dotUp = clamp(dot(dir, localUp), -1.0, 1.0);
  let elevation = asin(dotUp);
  let horizonProj = dir - dotUp * localUp;
  let horizonLen = max(length(horizonProj), 1e-6);
  let horizon = horizonProj / horizonLen;
  let cosAz = dot(horizon, localNorth);
  let sinAz = dot(horizon, localEast);
  let azimuth = atan2(sinAz, cosAz);

  // C.6 -- limb-aware v. v=0.5 is the planet's limb (matches the
  // LUT-generation re-parameterization), with sqrt remap putting the
  // bulk of the LUT v-resolution right at the limb regardless of
  // altitude.
  let planetR = uS.envPlanet.w;
  let sinBeta  = clamp(planetR / max(radialLen, planetR + 1.0), 0.0, 1.0);
  let limbElev = asin(sinBeta) - 1.5707963;

  let u = (azimuth + 3.14159265359) / 6.28318530718;
  var v: f32;
  if (elevation > limbElev) {
    let t = sqrt(clamp((elevation - limbElev) / max(1.5707963 - limbElev, 1e-4), 0.0, 1.0));
    v = 0.5 + t * 0.5;
  } else {
    let t = sqrt(clamp((limbElev - elevation) / max(limbElev + 1.5707963, 1e-4), 0.0, 1.0));
    v = 0.5 - t * 0.5;
  }
  // Flip v for NDC<->UV convention (LUT writes "v>=0.5 = above limb"
  // at NDC.y>=0 which lands at the TOP of the texture, UV.v=0).
  return textureSampleLevel(atmSkyViewLUT, atmLutSampler, vec2<f32>(u, 1.0 - v), 0.0).rgb;
}

// Sprint 7.5.4.b -- world ray direction -> equirect UV. Standard
// convention: U around the +Y axis (atan2(z, x)), V from zenith
// to nadir (asin(-y)). Polyhaven + most authoring tools use this
// orientation. If a particular HDRI looks rotated 180° on the X
// axis the caller can rotate dir before sampling.
fn dir_to_equirect_uv(dir: vec3<f32>) -> vec2<f32> {
  let inv_pi  = 0.31830988618;
  let inv_2pi = 0.15915494309;
  let u = atan2(dir.z, dir.x) * inv_2pi + 0.5;
  let v = asin(clamp(-dir.y, -1.0, 1.0)) * inv_pi + 0.5;
  return vec2<f32>(u, v);
}

// Phase 7 §5.5.c-2 -- triplanar projection helpers. The standard
// solve for texturing surfaces where regular UVs stretch (cliffs
// on a terrain heightmap, organic / sculpted meshes, etc.). The
// idea: sample the texture three times -- once for each world-
// axis projection (XY / XZ / ZY plane) -- and blend by the
// squared normal components. Faces aligned with each axis pick
// up that axis's sample.
//
//   triplanar_weights(n, k) -- pure weight computation. k=4 typical
//                              (sharper = each axis dominates more
//                              on faces aligned with it; k=2 is
//                              softer / more blended).
//   triplanar_sample_array  -- sample a texture_2d_array<f32>
//                              (the editor's scratch texture is
//                              one of these) at a specific layer.
//                              Use this from ShaderMat presets or
//                              future mesh materials that consume
//                              upstream visual outputs.
fn triplanar_weights(normal: vec3<f32>, sharpness: f32) -> vec3<f32> {
  let blend = pow(abs(normal), vec3<f32>(max(sharpness, 0.001)));
  let sum   = max(blend.x + blend.y + blend.z, 0.0001);
  return blend / sum;
}

fn triplanar_sample_array(tex: texture_2d_array<f32>, samp: sampler,
                          layer: u32, worldPos: vec3<f32>,
                          normal: vec3<f32>, scale: f32,
                          sharpness: f32) -> vec4<f32> {
  let w = triplanar_weights(normal, sharpness);
  // Per-axis plane projection: X-axis face samples ZY, Y-axis face
  // samples XZ (top-down), Z-axis face samples XY.
  let uvX = fract(worldPos.zy * scale);
  let uvY = fract(worldPos.xz * scale);
  let uvZ = fract(worldPos.xy * scale);
  let cX = textureSampleLevel(tex, samp, uvX, layer, 0.0);
  let cY = textureSampleLevel(tex, samp, uvY, layer, 0.0);
  let cZ = textureSampleLevel(tex, samp, uvZ, layer, 0.0);
  return cX * w.x + cY * w.y + cZ * w.z;
}

struct VsIn  {
  @location(0) pos:    vec3<f32>,
  @location(1) color:  vec3<f32>,
  @location(2) normal: vec3<f32>,
  @location(3) uv:     vec2<f32>
};
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) color:    vec3<f32>,
  @location(2) normal:   vec3<f32>,
  @location(3) uv:       vec2<f32>
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  var localPos = in.pos;

  // === Phase 8 sprint 8-6: planet-aware vertex displacement ===
  // (spec: docs/PLANET-SCALE-TERRAIN.md §8.5 part a)
  // The encoder sets uD.vsParams.z = 1.0 for PlanetMesh draws (and 0
  // elsewhere) so we can selectively displace planet vertices without
  // affecting other meshes in the same scene. Displacement is along
  // the radial direction (outward from planet center), magnitude
  // proportional to the biome's amplitude * detail_noise output.
  // Octaves auto-scale with camera altitude per _detail_octaves.
  //
  // For the planet mesh the model matrix is identity, so local-space
  // pos already equals world-space pos -- the displacement is
  // applied directly to in.pos before the model transform.
  if (uD.vsParams.z > 0.5 && uS.envPlanet.w > 0.0) {
    let radialVec = localPos - uS.envPlanet.xyz;
    let radialLen = length(radialVec);
    let radialDir = radialVec / max(radialLen, 1.0);
    let camAlt = max(0.0, length(uS.eye.xyz - uS.envPlanet.xyz) - uS.envPlanet.w);
    let octavesF = _detail_octaves(camAlt);
    if (octavesF > 0.0) {
      let bId = u32(clamp(round(in.uv.x), 0.0, 12.0));
      let dispH = detail_noise_height(localPos, bId, octavesF);
      // uD.vsParams.x carries an optional displacement-scale multiplier
      // (PlanetMesh.params.displacementScale, default 1.0). Lets the
      // user crank up vertex relief without changing biome amplitudes.
      let dispScale = max(0.0, uD.vsParams.x);
      localPos = localPos + radialDir * (dispH * dispScale);
    }
  }

  let world  = uD.model * vec4<f32>(localPos, 1.0);
  out.worldPos = world.xyz;
  out.pos    = uS.viewProj * world;
  out.color  = in.color;
  let n4     = uD.model * vec4<f32>(in.normal, 0.0);
  out.normal = normalize(n4.xyz);
  out.uv     = in.uv;
  return out;
}

// === Phase 8 sprint 8-7: vs_planet_detail (camera-anchored patch) ===
// (spec: docs/PLANET-SCALE-TERRAIN.md §8.7)
//
// Input vertex carries (u, v) grid coords in pos.xy (range [0, 1]).
// Vertex shader rebuilds world position every frame:
//   1. Compute the camera's local tangent frame on the planet
//      (radial up, projected-world-Y north, east = up × north).
//   2. Convert (u, v) -> tangent offsets in meters using patchSize.
//   3. Place the patch vertex on the planet surface at (camera under
//      point + tangent offsets), then radial-project onto the actual
//      OBLATE SPHEROID surface (sprint 8-7c -- the previous "project
//      onto sphere" version floated the patch above the planet at
//      non-equator latitudes because polRatio compresses the planet's
//      Y axis by ~0.34% / ~22km at the poles).
//   4. Apply detail_noise_height displacement along radial.
//
// Biome colors are baked in as a WGSL const array so the vertex
// shader can output the proper biome color directly (sprint 8-7c --
// the previous gray-with-alpha-fade hack made the patch read as a
// flat gray square instead of biome-tinted terrain).
//
// Per-draw uniforms (vsParams):
//   x = patchSize (meters)
//   y = biomeId (encoded as f32, rounded)
//   z = displacementScale
//   w = maxAltitude (meters; encoder skips the draw above this)
const _PLANET_BIOME_COLORS_VS: array<vec3<f32>, 13> = array<vec3<f32>, 13>(
  vec3<f32>(0.275, 0.431, 0.671),  // 0 Marine
  vec3<f32>(0.984, 0.906, 0.624),  // 1 Hot desert
  vec3<f32>(0.710, 0.722, 0.529),  // 2 Cold desert
  vec3<f32>(0.824, 0.816, 0.510),  // 3 Savanna
  vec3<f32>(0.784, 0.839, 0.561),  // 4 Grassland
  vec3<f32>(0.714, 0.851, 0.365),  // 5 Tropical seasonal forest
  vec3<f32>(0.161, 0.737, 0.337),  // 6 Temperate deciduous forest
  vec3<f32>(0.490, 0.796, 0.208),  // 7 Tropical rainforest
  vec3<f32>(0.251, 0.612, 0.263),  // 8 Temperate rainforest
  vec3<f32>(0.376, 0.529, 0.310),  // 9 Taiga
  vec3<f32>(0.561, 0.580, 0.486),  // 10 Tundra
  vec3<f32>(0.835, 0.906, 0.922),  // 11 Glacier
  vec3<f32>(0.227, 0.471, 0.337)   // 12 Wetland
);

@vertex
fn vs_planet_detail(in: VsIn) -> VsOut {
  var out: VsOut;
  let uv = in.pos.xy;  // grid coord [0, 1]
  let planetC = uS.envPlanet.xyz;
  let planetR = uS.envPlanet.w;
  let polRatio = max(0.5, min(2.0, uS.envPlanetGeom.x));

  // Camera radial / under-camera surface point.
  let radialFromCam = uS.eye.xyz - planetC;
  let radialLen = max(length(radialFromCam), planetR + 1.0);
  let camUp = radialFromCam / radialLen;
  let camAlt = max(0.0, radialLen - planetR);

  // Local tangent frame: north = world +Y projected to horizon plane;
  // fallback to +X near the planet poles. east = up x north.
  var northRef = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(dot(camUp, northRef)) > 0.99) {
    northRef = vec3<f32>(1.0, 0.0, 0.0);
  }
  let localNorth = normalize(northRef - camUp * dot(northRef, camUp));
  let localEast  = cross(camUp, localNorth);

  // Tangent-plane offset from camera-under point.
  let patchSize = max(uD.vsParams.x, 1.0);
  let offsetEast  = (uv.x - 0.5) * patchSize;
  let offsetNorth = (uv.y - 0.5) * patchSize;
  // The camera-under point on the OBLATE SPHEROID (not sphere) -- same
  // direction as camUp, but the spheroid radius depends on direction.
  let cuY2 = camUp.y * camUp.y;
  let invPr2 = 1.0 / (polRatio * polRatio);
  let camRadiusOnSpheroid = planetR / sqrt(1.0 - cuY2 + cuY2 * invPr2);
  let cameraUnder = planetC + camUp * camRadiusOnSpheroid;
  let tangentPos  = cameraUnder + localEast * offsetEast + localNorth * offsetNorth;

  // Project onto the OBLATE SPHEROID (sprint 8-7c fix). For a point
  // along direction d at distance t from planet center, the spheroid
  // intersection is t = planetR / sqrt(dx² + dy²/pr² + dz²).
  let projDir = normalize(tangentPos - planetC);
  let pdx2 = projDir.x * projDir.x;
  let pdy2 = projDir.y * projDir.y;
  let pdz2 = projDir.z * projDir.z;
  let surfaceR = planetR / sqrt(pdx2 + pdy2 * invPr2 + pdz2);
  var surfacePos = planetC + projDir * surfaceR;

  // Detail noise displacement.
  let biomeId = u32(clamp(uD.vsParams.y + 0.5, 0.0, 12.0));
  let octF = _detail_octaves(camAlt);
  var dispH = 0.0;
  if (octF > 0.0) {
    dispH = detail_noise_height(surfacePos, biomeId, octF);
  }
  let dispScale = uD.vsParams.z;
  // Sprint 8-7d:
  //  * uD.baseColor.w carries the macro-elevation under the camera
  //    (JS samples PlanetMap.cells at the camera's lat/lon each
  //    frame). Adding it to the radial offset places the patch at
  //    the same altitude as the surrounding PlanetMesh terrain
  //    instead of bare sea level -- fixes the "patch floats below
  //    me when I'm on a mountain" / "patch floats above me when I'm
  //    in a basin" complaint.
  //  * Displacement is clamped >= 0 (positive-only) so the patch
  //    never sinks below the radial baseline. Half-negative noise
  //    used to make the patch lose the depth-test against the
  //    coarse mesh at displaced-down vertices, producing a "polka
  //    dot" artifact.
  let macroElev = uD.baseColor.w;
  let positiveH = max(dispH, 0.0) * dispScale;
  // +2m floor: tiny constant bias to win the depth-test against the
  // coarse PlanetMesh in flat regions where macroElev and positiveH
  // are both zero.
  surfacePos = surfacePos + projDir * (macroElev + positiveH + 2.0);

  // Biome color + simple Lambert lighting against the sun direction.
  // Matches the JS-side baked lighting in _buildPlanetMesh so the
  // patch reads at the same illumination as the surrounding coarse
  // mesh.
  let biomeColor = _PLANET_BIOME_COLORS_VS[biomeId];
  let sunDir = uS.envSun.xyz;
  let ambient = 0.18;
  let lambert = max(ambient, dot(projDir, sunDir));

  out.worldPos = surfacePos;
  out.pos = uS.viewProj * vec4<f32>(surfacePos, 1.0);
  out.color = biomeColor * lambert;
  out.normal = projDir;
  out.uv = vec2<f32>(f32(biomeId), 0.0);
  return out;
}

// === Sprint 9-2c: vs_planet_cdlod (Strugar CDLOD vertex morphing) ===
// Per-vertex morph between this LOD's position (highPos) and the
// parent LOD's emulated position (lowPos, computed JS-side as the
// bilinear interp of even-grid neighbors). The morph factor goes
// 0→1 over the outer half of this chunk's LOD range so adjacent
// chunks at different LODs meet at identical positions on their
// shared edge -- no cracks, no skirts needed.
//
// Vertex layout (14 floats, stride 56):
//   loc 0: pos.xyz     -- highPos (this LOD's vertex world position)
//   loc 1: color.rgb   -- vertex-baked Lambert
//   loc 2: normal.xyz  -- oblate-spheroid surface normal
//   loc 3: uv.xy       -- x = biomeId (for fs biome routing),
//                         y = morphLow (this chunk's split distance)
//   loc 4: lowPos.xyz  -- parent-LOD-emulated vertex position
//
// Morph formula (Strugar 2010):
//   morph = clamp((dist - morphLow) / morphLow * 2 - 1, 0, 1)
// At dist = morphLow (close): morph = -1 → 0. No morph.
// At dist = 1.5 * morphLow:    morph = 0. Still no morph.
// At dist = 2 * morphLow:      morph = 1. Fully morphed → snap to parent.
// Parent's split distance is exactly 2*morphLow (chunkEdge doubles
// at every LOD step), so at the moment the parent takes over the
// child has finished morphing -- no pop.
struct VsInCDLOD {
  @location(0) pos:    vec3<f32>,
  @location(1) color:  vec3<f32>,
  @location(2) normal: vec3<f32>,
  @location(3) uv:     vec2<f32>,
  @location(4) lowPos: vec3<f32>
};
@vertex
fn vs_planet_cdlod(in: VsInCDLOD) -> VsOut {
  var out: VsOut;
  // Sprint 9-3: uD.model carries mv_rtc = view * translate(anchorF64),
  // composed JS-side in f64 so the catastrophic (anchor - camera)
  // subtraction happens before f32 downcast. in.pos is anchor-relative
  // (small magnitude) so uD.model * in.pos yields a VIEW-SPACE position
  // directly. Distance to camera = length(viewSpacePos) since rotation
  // preserves length. Output projection uses proj-only (uS.proj).
  //
  // Sprint 9-4-fix: out.worldPos must be in WORLD space (fragments
  // sample biome textures triplanar against it, run atmosphere height
  // math, etc.). Writing viewSpacePos to worldPos made the textures
  // slide with the camera (water-like effect) and the atmosphere
  // render as a translucent shell inside the planet. Recover world
  // coords by adding the f32 anchor approximation (uD.vsParams.xyz):
  // world = anchor + local. This loses sub-meter precision at Earth
  // radius, which is fine for the consumers; the precision-critical
  // path (clip-space output) still uses the f64-composed mv_rtc.
  let highView4 = uD.model * vec4<f32>(in.pos,    1.0);
  let lowView4  = uD.model * vec4<f32>(in.lowPos, 1.0);
  let highPos = highView4.xyz;
  let lowPos  = lowView4.xyz;

  let dist = length(highPos);  // world distance to camera (rotation-invariant)
  let morphLow = in.uv.y;
  var morph: f32 = 0.0;
  if (morphLow > 0.0) {
    morph = clamp((dist - morphLow) / morphLow * 2.0 - 1.0, 0.0, 1.0);
  }
  let morphedPos   = mix(highPos, lowPos, morph);
  let morphedLocal = mix(in.pos,  in.lowPos, morph);

  let anchorF32 = uD.vsParams.xyz;
  out.worldPos = anchorF32 + morphedLocal;
  out.pos = uS.proj * vec4<f32>(morphedPos, 1.0);
  out.color = in.color;
  // Normal: in.normal is already world-oriented (the oblate-spheroid
  // surface normal computed JS-side). Translation doesn't affect a
  // direction, so we just pass it through normalized. (Previously
  // ran in.normal through uD.model, which rotated it into view space
  // and gave fragments a wrong normal -- contributed to the broken
  // sun lighting on the surface.)
  out.normal = normalize(in.normal);
  out.uv = in.uv;
  return out;
}

// Phase 7 §5.5.h-25 -- vs_horizon. Same VsOut shape as vs_main, but
// applies a planet-curvature Y warp to each vertex based on the
// camera's altitude. At low altitude the warp factor is 0 (flat
// world); as the camera flies up past altLow, the factor ramps to
// 1 over [altLow, altHigh], at which point distant vertices drop
// by  d * d / (2R)  where d = horizontal distance from the camera
// and R is the planet radius. From up high the horizon impostor
// curves off into a sphere section, giving a planet look.
//   band1.x = altLow  (no curve below this camera Y)
//   band1.y = altHigh (full curve above this camera Y)
//   band1.z = planetRadius
//   band1.w = unused
@vertex
fn vs_horizon(in: VsIn) -> VsOut {
  var out: VsOut;
  let world4 = uD.model * vec4<f32>(in.pos, 1.0);
  let altLow  = uD.band1.x;
  let altHigh = max(altLow + 1.0, uD.band1.y);
  let R       = max(1000.0, uD.band1.z);
  let camY    = uS.eye.y;
  let t = clamp((camY - altLow) / (altHigh - altLow), 0.0, 1.0);
  let curvature = t * t * (3.0 - 2.0 * t);     // smoothstep
  let dxz = world4.xz - uS.eye.xz;
  let d2  = dot(dxz, dxz);
  let yDrop = (d2 / (2.0 * R)) * curvature;
  let warped = vec4<f32>(world4.x, world4.y - yDrop, world4.z, 1.0);
  out.worldPos = warped.xyz;
  out.pos    = uS.viewProj * warped;
  out.color  = in.color;
  let n4     = uD.model * vec4<f32>(in.normal, 0.0);
  out.normal = normalize(n4.xyz);
  out.uv     = in.uv;
  return out;
}

// Phase 7 §5.5.c-3 -- vs_terrain. Samples the heightmap texture
// (the bound scratch texture array at the layer vsParams.w
// occupies) for per-vertex Y displacement, and recomputes the
// surface normal via central-difference of texel neighbors. The
// fragment side sees this through the standard VsOut interface
// (worldPos / normal / uv) so any fragment shader (Phong, PBR,
// Unlit, Terrain) works on top -- the pipeline cache pairs
// vs_terrain with whichever fragment entry the material picks.
//
// textureLoad (not textureSample) since:
//   1. WebGPU restricts vertex shaders from using filtering
//      samplers (the binding 3 sampler is filterable).
//   2. We want exact texel reads for the finite-difference
//      normal computation anyway.
@vertex
fn vs_terrain(in: VsIn) -> VsOut {
  var out: VsOut;
  let layer     = i32(uD.vsParams.w);
  let hScale    = uD.vsParams.x;
  let worldSize = max(uD.vsParams.y, 0.0001);

  let dims  = vec2<i32>(textureDimensions(srcTexture));
  let dimsF = vec2<f32>(dims);

  // Clamp UV to [0, 1] then map to texel coords. Read center +
  // four cardinal neighbors with one-texel offset for the
  // finite-difference normal.
  let uvC = clamp(in.uv, vec2<f32>(0.0), vec2<f32>(1.0));
  let cC  = vec2<i32>(clamp(uvC * dimsF, vec2<f32>(0.0), dimsF - vec2<f32>(1.0)));
  let cL  = vec2<i32>(max(cC.x - 1, 0),         cC.y);
  let cR  = vec2<i32>(min(cC.x + 1, dims.x - 1), cC.y);
  let cD  = vec2<i32>(cC.x, max(cC.y - 1, 0));
  let cU  = vec2<i32>(cC.x, min(cC.y + 1, dims.y - 1));

  let hC = textureLoad(srcTexture, cC, layer, 0).r;
  let hL = textureLoad(srcTexture, cL, layer, 0).r;
  let hR = textureLoad(srcTexture, cR, layer, 0).r;
  let hD = textureLoad(srcTexture, cD, layer, 0).r;
  let hU = textureLoad(srcTexture, cU, layer, 0).r;

  // World units per texel = worldSize / textureDimension. Tangent
  // along X is (worldDx, dydx, 0); along Z is (0, dydz, worldDz);
  // cross(tangent_z, tangent_x) gives the up-pointing normal.
  let worldDx = worldSize / dimsF.x;
  let worldDz = worldSize / dimsF.y;
  let dydx = (hR - hL) * hScale * 0.5 / worldDx;
  let dydz = (hU - hD) * hScale * 0.5 / worldDz;
  let nLocal = normalize(vec3<f32>(-dydx, 1.0, -dydz));

  // Y-displace by sampled height. (hC - 1) keeps the same Y
  // convention as the CPU-build path: peaks (hC=1) land at the
  // mesh baseline (in.pos.y = yOffset), valleys (hC=0) descend
  // to in.pos.y - heightScale. Matches §5.5.a's "peaks at horizon"
  // default so the wired-up version looks the same as the
  // unwired CPU mode.
  let displaced = vec3<f32>(in.pos.x, in.pos.y + (hC - 1.0) * hScale, in.pos.z);
  let world     = uD.model * vec4<f32>(displaced, 1.0);
  let n4        = uD.model * vec4<f32>(nLocal, 0.0);

  out.worldPos = world.xyz;
  out.pos      = uS.viewProj * world;
  out.color    = in.color;
  out.normal   = normalize(n4.xyz);
  out.uv       = in.uv;
  return out;
}

// Legacy unlit-vertex-color fallback. Default fragment when no
// material is wired on a mesh-gen primitive -- preserves the
// "you get colors immediately" behavior from sprints a + b.
//
// 2026-05-21 Sprint 7.6.a-atm -- when a planet is wired
// (envPlanet.w > 0) the planet's lit surface gets AERIAL
// PERSPECTIVE applied: in-scatter from camera to fragment is
// added to the surface color. This is what makes the planet
// look like it has an ATMOSPHERE ON IT (blue haze near horizon,
// gentle blue tint on distant ground, integrated limb glow that
// flows from the planet body into the sky -- not a sharp
// silhouette with separate sky-glow).
@fragment
fn fs_unlit_vc(in: VsOut) -> @location(0) vec4<f32> {
  if (uS.envPlanet.w > 0.0) {
    // Sprint 7.6.b-atm Tier-C.0 -- correct aerial perspective:
    // surface_color * transmittance + in_scatter. The transmittance
    // term is what was missing in v2 -- without it the planet body's
    // base color sat on top of any scattering, creating the visible
    // gap at the silhouette the user reported. With per-channel
    // Beer-Lambert transmittance, grazing-angle fragments fade
    // through warm-tinted color and finally into pure atmospheric
    // scattering at the limb, matching the sky-pass color smoothly.
    // C.5 -- aerial-perspective LUT replaces the per-pixel integrator.
    // One trilinear lookup (two textureSampleLevel + manual lerp
    // across adjacent depth slices) instead of 16+16 samples per
    // pixel. The mono transmittance loses wavelength-dependent
    // wash-out (warm sunset hue on distant ground) until C.6 splits
    // the transmittance into a second LUT.
    let ap = sample_aerial_perspective_lut(uS.eye.xyz, in.worldPos);
    // === Phase 8 sprint 8-3 + extras ===
    // (spec: docs/PLANET-SCALE-TERRAIN.md §8.5 fragment-path)
    //
    // Per-biome rendering:
    //   * Marine (bId == 0) -- water shading via Fresnel-mixed sky
    //     reflection (sample_skyview_lut on the reflection vector)
    //     over a deep-blue base; sprint 8-3 polish replaces the flat
    //     biome-color blue that read as "painted on" with a real
    //     reflective surface.
    //   * Land biomes -- macro-scale color variation (~100km
    //     patches, visible from orbit) breaks up the flat biome
    //     palette; per-biome detail_noise brightness modulation as
    //     before; normal perturbation from the detail_noise gradient
    //     adds real-time bump lighting on top of the baked Lambert.
    let bId = u32(clamp(round(in.uv.x), 0.0, 12.0));
    let _altitude_m = max(0.0, length(uS.eye.xyz - uS.envPlanet.xyz) - uS.envPlanet.w);
    let _max_oct    = _detail_octaves(_altitude_m);
    var color = in.color;

    let texScale = uD.planetExtra.z;
    let texMix   = uD.planetExtra.w;
    if (bId == 0u) {
      // Marine cell -- water shading. Schlick Fresnel weighted mix
      // between deep-blue subsurface and the sky-view LUT reflected
      // through the surface normal. At normal incidence we read
      // ~2% reflectance (water IOR ~1.33); at grazing angles the
      // Fresnel term ramps to 1.0 and the surface acts like a mirror.
      let surfN = normalize(in.normal);
      let viewDir = normalize(uS.eye.xyz - in.worldPos);
      let cosVN = max(dot(viewDir, surfN), 0.0);
      let fresnel = pow(1.0 - cosVN, 5.0);
      let f0 = 0.02;
      let reflectance = f0 + (1.0 - f0) * fresnel;
      let reflectDir = reflect(-viewDir, surfN);
      let skyRefl = sample_skyview_lut(reflectDir);
      // Deep-blue base. Slightly darker than the flat biome blue so
      // the Fresnel-mixed reflection reads more strongly.
      var waterBase = vec3<f32>(0.04, 0.14, 0.24);
      // Phase 8 sprint 8-3b: if a waterTexture is wired, mix it into
      // the subsurface base before Fresnel. texMix controls strength;
      // texture is triplanar-sampled in world space.
      let waterTexLayer = i32(uD.planetExtra.y);
      if (waterTexLayer >= 0) {
        let tex = triplanar_sample_array(srcTexture, srcSampler,
                    u32(waterTexLayer), in.worldPos, surfN,
                    texScale, 4.0);
        waterBase = mix(waterBase, tex.rgb, texMix);
      }
      color = mix(waterBase, skyRefl, clamp(reflectance, 0.0, 1.0));
    } else {
      // Land biome. Sprint 10-1d / 10-2 RIP-OUT: per-pixel noise
      // color modulation + procedural texture styles + bump
      // perturbation REMOVED.
      let surfN = normalize(in.normal);
      // Sprint 10-5c-c/g: SVT sample. Tries to fetch a pre-baked
      // albedo + tangent-space normal from the atlas. If the page
      // is resident:
      //   - blend SVT albedo over vertex color
      //   - transform tangent-space normal to world space (via
      //     east/north tangent basis on the sphere)
      //   - re-light: divide out the baked vertex lambert, apply
      //     the perturbed-normal lambert. Result: visible bump
      //     shading without changing the rest of the lighting pipeline.
      let planetCenter2 = uS.envPlanet.xyz;
      let planetR2      = uS.envPlanet.w;
      let radial2       = in.worldPos - planetCenter2;
      let radLen2       = length(radial2);
      let svtDir        = radial2 / max(radLen2, 1.0);
      let svtSample     = _svt_sample(svtDir);
      if (svtSample.resident > 0.5) {
        // Albedo blend.
        color = mix(color, svtSample.albedo, 0.80);
        // Build tangent basis on the sphere surface. East = (-sinLon,
        // 0, cosLon) handling our east-west flip convention. Up =
        // radial (surfN). North = up × east.
        let latR  = asin(clamp(svtDir.y, -1.0, 1.0));
        let lonR  = -atan2(svtDir.z, svtDir.x);   // 10-6 east-west flip
        let east  = vec3<f32>(-sin(lonR), 0.0, cos(lonR));
        let upR   = svtDir;
        let north = normalize(cross(upR, east));
        let eastN = normalize(cross(north, upR));
        // Transform tangent-space normal (x=east, y=north, z=up).
        let tn = svtSample.normal;
        let worldN = normalize(eastN * tn.x + north * tn.y + upR * tn.z);
        // Recompute lambert with perturbed normal vs baked one.
        let sunDir = uS.envSun.xyz;
        let perturbLambert = max(0.18, dot(worldN, sunDir));
        let baseLambert    = max(0.18, dot(upR, sunDir));
        // Scale color by ratio. Clamped so dark areas don't blow out.
        color = color * clamp(perturbLambert / baseLambert, 0.6, 1.4);
        // Sprint 10-5c-h: PBR specular term layered on top. Uses the
        // SVT material atlas (roughness + metallic) and the perturbed
        // surface normal. Specular highlight reads as a glint where
        // the sun reflects toward the camera through the half-vector.
        // AO multiplied into the diffuse component (darkens corners).
        let viewDir = normalize(uS.eye.xyz - in.worldPos);
        let spec = _pbr_specular(worldN, viewDir, sunDir,
                                  svtSample.albedo,
                                  svtSample.roughness,
                                  svtSample.metallic);
        // Scaled down so spec stays subtle on natural terrain. PBR
        // peak can be very bright; clamp keeps it grounded.
        let specStrength = 0.6;
        color = color * svtSample.ao + spec * perturbLambert * specStrength;
      }
      let landTexLayer = i32(uD.planetExtra.x);
      if (landTexLayer >= 0) {
        let tex = triplanar_sample_array(srcTexture, srcSampler,
                    u32(landTexLayer), in.worldPos, surfN,
                    texScale, 4.0);
        let tinted = tex.rgb * color * 2.0;
        color = mix(color, tinted, texMix);
      }
      // §bonus-perf-foot (2026-05-25) -- the procedural detail-noise
      // + climate-blend texture blocks below are the FALLBACK for
      // pixels where SVT didn't catch up. When SVT IS resident, the
      // atlas already encodes biome color + per-texel bump detail +
      // PBR material, and re-running this work on top is the
      // foot-level perf bottleneck (~12 noise calls + ~10 exp/pow
      // per pixel). Gate on svtSample.resident so:
      //   resident=1 (steady state): skip both blocks entirely
      //   resident=0 (chunk just entered view, pages streaming):
      //                run the full procedural so the surface
      //                stays detailed during the brief load window.
      // §bonus-perf-foot-7 RESULT (2026-05-25): user data showed
      // fps unchanged at 9.2 with this block fully skipped. Per-
      // fragment procedural is NOT the bottleneck. Reverted to
      // original gate; cost is elsewhere (suspect: rasterizer
      // efficiency on the 1100+ tiny chunks at foot, see foot-8).
      if (svtSample.resident < 0.5) {
        // §revert-suppression (2026-05-25) -- multi-scale detail
        // restored to 4 octaves (was cut to 2 chasing the 9 fps
        // bug; foot-7 binary diag proved fragment cost wasn't it).
        let camDistL = length(uS.eye.xyz - in.worldPos);
        let macroFade = 1.0 - smoothstep(500.0,  2000.0, camDistL);
        let midFade   = 1.0 - smoothstep(150.0,   500.0, camDistL);
        let nearFade  = 1.0 - smoothstep(50.0,    200.0, camDistL);
        let microFade = 1.0 - smoothstep(15.0,     50.0, camDistL);
        if (macroFade > 0.001) {
          let n1 = _value_noise_3d(in.worldPos * 0.02)  - 0.5;
          let n2 = _value_noise_3d(in.worldPos * 0.125) - 0.5;
          let n3 = _value_noise_3d(in.worldPos * 0.66)  - 0.5;
          let n4 = _value_noise_3d(in.worldPos * 3.30)  - 0.5;
          let det =  n1 * 0.03 * macroFade
                   + n2 * 0.05 * midFade
                   + n3 * 0.06 * nearFade
                   + n4 * 0.07 * microFade;
          color = color * (1.0 + det);
        }
        if (midFade > 0.001) {
          let planetCenter = uS.envPlanet.xyz;
          let planetRrad   = uS.envPlanet.w;
          let radialVec = in.worldPos - planetCenter;
          let radLen    = length(radialVec);
          let radDir    = radialVec / max(radLen, 1.0);
          let _absLat = abs(degrees(asin(clamp(radDir.y, -1.0, 1.0))));
          let _elevMSL = max(0.0, radLen - planetRrad);
          let _Tbase = 30.0 * cos(radians(_absLat)) - 5.0;
          let _T     = _Tbase - 6.5 * (_elevMSL / 1000.0);
          var _P: f32 = 0.45;
          _P = _P + 0.45 * exp(-pow((_absLat -  0.0) / 12.0, 2.0));
          _P = _P - 0.35 * exp(-pow((_absLat - 25.0) / 10.0, 2.0));
          _P = _P + 0.25 * exp(-pow((_absLat - 55.0) / 12.0, 2.0));
          _P = _P - 0.30 * exp(-pow((_absLat - 80.0) / 12.0, 2.0));
          _P = clamp(_P, 0.0, 1.0);
          let snowLineAlt = select(select(1500.0, 3000.0, _T > 0.0), 4500.0, _T > 10.0);
          let snowW = clamp((-_T) / 10.0 + max(0.0, (_elevMSL - snowLineAlt) / 1500.0), 0.0, 1.0);
          let sandW = clamp((_T - 18.0) / 6.0, 0.0, 1.0) * clamp((0.30 - _P) / 0.10, 0.0, 1.0);
          let rockW = clamp((_elevMSL - 2000.0) / 1500.0, 0.0, 1.0);
          let grassW = max(0.0, 1.0 - snowW - sandW - rockW);
          // §revert-suppression -- 4-way weighted blend restored
          // (was dominant-only pick in foot-6). Smooth transitions
          // between biomes rather than crisp boundaries.
          let tg = _surface_tex_grass(in.worldPos);
          let tr = _surface_tex_rock(in.worldPos);
          let ts = _surface_tex_sand(in.worldPos);
          let tw = _surface_tex_snow(in.worldPos);
          let texW = tg * grassW + tr * rockW + ts * sandW + tw * snowW;
          color = color * mix(vec3<f32>(1.0), texW, midFade);
        }
      }
    }

    let col = color * ap.transmittance + ap.inScatter;
    return vec4<f32>(tonemap_aces(col), 1.0);
  }
  return vec4<f32>(in.color, 1.0);
}

// UnlitMat: solid material color, optionally mixed with vertex color
// via baseColor.a. Default state (a=0) is pure material color.
@fragment
fn fs_unlit(in: VsOut) -> @location(0) vec4<f32> {
  let c = mix(uD.baseColor.rgb, in.color, uD.baseColor.a);
  return vec4<f32>(c, 1.0);
}

// Evaluate light i at a world-space surface point. Returns
// (xyz = unit direction TOWARD the light, w = combined attenuation).
//
//   directional (type 0): w = 1 always, direction = pos.xyz
//   point       (type 1): quadratic distance falloff over params.x range
//   spot        (type 2): point + cone factor smoothstep'd between
//                         params.y (cos inner) and params.z (cos outer)
fn _eval_light_i(idx: u32, worldPos: vec3<f32>) -> vec4<f32> {
  let L = uS.lights[idx];
  let typ = L.pos.w;
  if (typ < 0.5) {
    return vec4<f32>(normalize(L.pos.xyz), 1.0);
  }
  // Point + spot share the world-position math.
  let toLight = L.pos.xyz - worldPos;
  let dist = length(toLight);
  let range = max(0.001, L.params.x);
  let distFalloff = clamp(1.0 - dist / range, 0.0, 1.0);
  let dir = toLight / max(dist, 0.001);
  if (typ < 1.5) {
    return vec4<f32>(dir, distFalloff * distFalloff);
  }
  // Spot light: additional cone-angle smoothstep. spotDir is the
  // direction the spot is POINTING (away from the source toward the
  // illuminated area); we need the angle between -dir and spotDir.
  let spotDir = normalize(L.spotDir.xyz);
  let cosAngle = dot(-dir, spotDir);
  let cosInner = L.params.y;
  let cosOuter = L.params.z;
  let coneFalloff = clamp((cosAngle - cosOuter) / max(0.0001, cosInner - cosOuter), 0.0, 1.0);
  return vec4<f32>(dir, distFalloff * distFalloff * coneFalloff);
}

// PhongMat fragment: loop over enabled lights + sum each light's
// (diffuse + specular) contribution scaled by attenuation. ambient
// applied once at the end so multi-light scenes don't blow out.
@fragment
fn fs_phong(in: VsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let v = normalize(uS.eye.xyz - in.worldPos);
  let shin   = max(1.0, uD.matParams.x);
  let amb    = clamp(uD.matParams.y, 0.0, 1.0);
  let albedo = mix(uD.baseColor.rgb, in.color, uD.baseColor.a);
  let nLights = u32(uS.lightCount.x);

  var lit: vec3<f32> = albedo * amb;     // ambient base
  for (var i: u32 = 0u; i < nLights; i = i + 1u) {
    let L     = uS.lights[i];
    let info  = _eval_light_i(i, in.worldPos);
    let l     = info.xyz;
    let atten = info.w;
    let h     = normalize(l + v);
    let nDotL = max(dot(n, l), 0.0);
    let spec  = pow(max(dot(n, h), 0.0), shin) * step(0.001, nDotL);
    let li    = L.color.rgb * L.color.w;
    lit = lit + albedo * nDotL * (1.0 - amb) * atten * li
              + vec3<f32>(spec) * atten * li * 0.6;
  }
  // 7.5.4.e -- fog + tonemap, matches fs_pbr.
  let fogged = apply_fog(lit, in.worldPos);
  // 2026-05-21 Sprint 7.6.b-atm Tier-C.0 -- correct aerial
  // perspective with transmittance. See fs_unlit_vc for the
  // motivation; the formula matches: surface * T + in_scatter.
  var withAtm = fogged;
  if (uS.envPlanet.w > 0.0) {
    // C.5 -- LUT lookup instead of per-pixel atmosphere integration.
    let ap = sample_aerial_perspective_lut(uS.eye.xyz, in.worldPos);
    withAtm = withAtm * ap.transmittance + ap.inScatter;
  }
  return vec4<f32>(tonemap_aces(withAtm), 1.0);
}

// Phase 7 §5.5.h-3 -- terrain noise helpers, JS-mirror in WGSL.
// Each function shadows its JS namesake exactly so shore foam
// lines up with the rendered terrain mesh edge. Explicit type
// literals throughout to avoid any abstract-int / abstract-float
// inference surprise.
// §5.5.h-7 -- bit-identical to JS _terrainHash. i32 multiply +
// XOR + shift, no sin(). Now the water shader's noise matches the
// mesh build's noise EXACTLY at any world coord.
fn _tw_hash(ix: i32, iy: i32, seed: f32) -> f32 {
  // Must mirror _terrainHash(...) in JS bit-for-bit. Use u32 shifts so the
  // right-shift is logical (zero-fill) -- WGSL right-shift on i32 is
  // arithmetic (sign-extending), which caps the output range at [0, 0.5).
  let ss: i32 = i32(floor(seed * 1000.0));
  var h: u32 = bitcast<u32>((ix * 374761393) ^ (iy * 668265263) ^ (ss * 2147483647));
  h = h ^ (h >> 13u);
  h = h * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}
fn _tw_valueNoise(p: vec2<f32>, seed: f32) -> f32 {
  let i = floor(p);
  let fr = p - i;
  let ix: i32 = i32(i.x);
  let iy: i32 = i32(i.y);
  let a = _tw_hash(ix,     iy,     seed);
  let b = _tw_hash(ix + 1, iy,     seed);
  let c = _tw_hash(ix,     iy + 1, seed);
  let d = _tw_hash(ix + 1, iy + 1, seed);
  // §planet-spec Phase 3 -- quintic interpolation matches the JS
  // _terrainValueNoise. C2 continuous; kills second-derivative seams
  // at lattice cell boundaries.
  let s = fr * fr * fr * (fr * (fr * vec2<f32>(6.0) - vec2<f32>(15.0)) + vec2<f32>(10.0));
  let ab = a + (b - a) * s.x;
  let cd = c + (d - c) * s.x;
  return ab + (cd - ab) * s.y;
}
// §planet-spec Phase 3 -- continuous octave count. Caller passes
// octavesF as f32 (not i32 like before); fractional values fade
// the last octave in by their fractional amount so LOD transitions
// stop popping. octavesF == 5.0 reproduces the legacy 5-octave fBm
// behavior exactly. Mirrors the JS _terrainFBM.
fn _tw_baseHeight(wx: f32, wz: f32, freq: f32, octavesF: f32, lac: f32, gain: f32, ridges: f32, seed: f32, plateau: f32) -> f32 {
  var p = vec2<f32>(wx, wz) * max(0.001, freq);
  var amp: f32 = 1.0;
  var sum: f32 = 0.0;
  var maxAmp: f32 = 0.0;
  let r = clamp(ridges, 0.0, 1.0);
  let totalOctF: f32 = clamp(octavesF, 0.0, 20.0);
  let fullOcts: i32 = i32(floor(totalOctF));
  let frac: f32   = totalOctF - f32(fullOcts);
  for (var ii: i32 = 0; ii < fullOcts; ii = ii + 1) {
    var s = _tw_valueNoise(p, seed);
    let ridge = 1.0 - abs(2.0 * s - 1.0);
    s = s * (1.0 - r) + ridge * ridge * r;
    sum = sum + s * amp;
    maxAmp = maxAmp + amp;
    p = p * lac;
    amp = amp * gain;
  }
  if (frac > 0.0) {
    var s = _tw_valueNoise(p, seed);
    let ridge = 1.0 - abs(2.0 * s - 1.0);
    s = s * (1.0 - r) + ridge * ridge * r;
    sum = sum + s * amp * frac;
    maxAmp = maxAmp + amp * frac;
  }
  var h = clamp(sum / max(1e-6, maxAmp), 0.0, 1.0);
  if (plateau > 0.001) {
    let k = 1.0 + clamp(plateau, 0.0, 1.0) * 4.0;
    h = pow(clamp(h, 0.0, 1.0), k);
  }
  return h;
}
// §5.5.h-21 -- 4-octave fbm matched bit-for-bit with the JS-side
// Clouds3D mesh build (_terrainValueNoise + the same 4-octave loop).
// Used by fs_water to project water pixels up along the sun ray
// and sample cloud density for shadow. Returns 0..1; threshold the
// result against (1 - coverage) to get a binary in-cloud mask.
fn _tw_cloudDensity(wx: f32, wz: f32, scale: f32, seed: f32) -> f32 {
  var n: f32 = 0.0;
  var amp: f32 = 0.5;
  var freq: f32 = 1.0;
  var maxAmp: f32 = 0.0;
  for (var oct: i32 = 0; oct < 4; oct = oct + 1) {
    n = n + amp * _tw_valueNoise(vec2<f32>(wx * scale * freq, wz * scale * freq), seed + f32(oct) * 3.7);
    maxAmp = maxAmp + amp;
    amp  = amp  * 0.55;
    freq = freq * 2.07;
  }
  return n / max(1e-6, maxAmp);
}

fn _tw_islandLand(wx: f32, wz: f32, maskFreq: f32, maskSeed: f32, threshold: f32, softness: f32) -> f32 {
  let m = _tw_valueNoise(vec2<f32>(wx, wz) * maskFreq, maskSeed);
  let lo = threshold - softness;
  let hi = threshold + softness;
  let u = clamp((m - lo) / max(1e-6, hi - lo), 0.0, 1.0);
  return u * u * (3.0 - 2.0 * u);
}

// Phase 7 §5.5.h-4 -- LOD-matched terrain sampling. The TiledTerrain
// mesh is discretized at chunkSize / lodSegs (e.g. 128m vertex
// spacing in the outer LOD ring). Sampling exact noise in the
// water shader gives a smooth curve that doesn't align with the
// visible mesh edge -- the foam line drifts away from the actual
// island shore. Fix: snap to the same grid the mesh uses and
// bilinear-interp the 4 corner heights. Now depth matches the
// rendered terrain pixel-for-pixel.
fn _tw_lodSegs(dxAbs: i32, dzAbs: i32, radius: i32, baseSegs: i32) -> i32 {
  let ring = max(dxAbs, dzAbs);
  if (radius <= 0) { return baseSegs; }
  let t = f32(ring) / f32(radius);
  if (t <= 0.20) { return baseSegs; }
  if (t <= 0.40) { return max(2, baseSegs / 2); }
  if (t <= 0.60) { return max(2, baseSegs / 4); }
  if (t <= 0.80) { return max(2, baseSegs / 8); }
  return 2;
}
fn _tw_finalY_at(wx: f32, wz: f32,
                 t_freq: f32, t_octsF: f32, t_lac: f32, t_gain: f32, t_ridges: f32,
                 t_seed: f32, t_plateau: f32, t_hs: f32, t_yOff: f32,
                 archipel: f32, t_sink: f32,
                 m_freq: f32, m_seed: f32, m_thresh: f32, m_soft: f32,
                 beachStr: f32, beachFreq: f32) -> f32 {
  let h = _tw_baseHeight(wx, wz, t_freq, t_octsF, t_lac, t_gain, t_ridges, t_seed, t_plateau);
  var ty = (h - 1.0) * t_hs + t_yOff;
  if (archipel > 0.5) {
    let landAmt = _tw_islandLand(wx, wz, m_freq, m_seed, m_thresh, m_soft);
    // §5.5.h-11 coastal peak squash. Mirror of JS _tiledFinalY: scale
    // above-sea-level elevation by landAmt^2 so peaks only emerge
    // well inland. Keeps the water shader's shore-detect aligned
    // with the rendered mesh.
    if (ty > t_yOff) {
      let peakAmt = landAmt * landAmt;
      ty = t_yOff + (ty - t_yOff) * peakAmt;
    }
    // §5.5.h-9 beach band -- mirror of the JS _tiledFinalY beach
    // blend so the water shader's shore detect samples the same
    // flattened beach elevation the rendered mesh shows.
    if (beachStr > 0.0 && landAmt > 0.0 && landAmt < 0.95) {
      let bn = _tw_valueNoise(vec2<f32>(wx, wz) * beachFreq, m_seed + 17.3);
      let coastal = min(1.0, landAmt / 0.5) * min(1.0, (0.95 - landAmt) / 0.4);
      let beachy = max(0.0, (bn - 0.45) / 0.25);
      let blend = min(1.0, coastal * beachy * beachStr);
      let beachY = t_yOff + 4.0;
      ty = ty * (1.0 - blend) + beachY * blend;
    }
    let seaFloor = t_yOff - t_sink;
    ty = ty * landAmt + seaFloor * (1.0 - landAmt);
  }
  return ty;
}

// Phase 7 §5.5.h -- fs_water. Animated wave normals + Fresnel sky
// mix + shore detect from terrain sampling. Per-draw layout:
//   baseColor.rgb = water color, baseColor.a = fresnelStrength
//   matParams    = (seaLevel, waveFreq, waveSpeed, waveAmp)
//   band1.rgba   = (skyR, skyG, skyB, time)
//   band2.rgba   = (noiseSeed, noiseFreq, noiseOctaves, plateau)
//   band3.rgba   = (lacunarity, gain, ridges, heightScale)
//   band4.rgba   = (yOffset, sinkDepth, archipelagoFlag, islandMaskFreq)
//   vsParams     = (islandMaskSeed, threshold, softness, foamWidth)
//   detailParams = (shallowDepth, waveShoreFreq, foamR, foamG)
//   bumpParams   = (foamB, _, _, _)
@fragment
fn fs_water(in: VsOut) -> @location(0) vec4<f32> {
  let waterColor = uD.baseColor.rgb;
  let fresnelStr = max(0.0, uD.baseColor.a);
  let seaLevel   = uD.matParams.x;
  let waveFreq   = max(0.00001, uD.matParams.y);
  let waveSpeed  = uD.matParams.z;
  let waveAmp    = max(0.0, uD.matParams.w);
  let skyColor   = uD.band1.rgb;
  let t          = uD.band1.w;
  // Terrain noise params (auto-pulled from patch's TiledTerrain by encoder).
  let t_seed     = uD.band2.x;
  let t_freq     = uD.band2.y;
  // §planet-spec Phase 3 -- continuous octave count (was i32 cast).
  let t_octsF    = uD.band2.z;
  let t_plateau  = uD.band2.w;
  let t_lac      = uD.band3.x;
  let t_gain     = uD.band3.y;
  let t_ridges   = uD.band3.z;
  let t_hs       = uD.band3.w;
  let t_yOff     = uD.band4.x;
  let t_sink     = uD.band4.y;
  let archipel   = uD.band4.z;        // 1.0 = archipelago, 0.0 = no island mask
  let m_freq     = uD.band4.w;
  let m_seed     = uD.vsParams.x;
  let m_thresh   = uD.vsParams.y;
  let m_soft     = uD.vsParams.z;
  let foamWidth  = max(0.001, uD.vsParams.w);
  let shallowDp  = max(0.001, uD.detailParams.x);
  let waveShoreF = uD.detailParams.y;
  let foamColor  = vec3<f32>(uD.detailParams.z, uD.detailParams.w, uD.bumpParams.x);

  let wp = in.worldPos;

  // ---- Terrain height under this water fragment ----
  // §5.5.h-4 -- LOD-matched bilinear sample. The water shader needs
  // to see the EXACT same height the rendered mesh shows or the
  // foam line drifts off the visible shore. Snap to the LOD grid
  // for this fragment's chunk (LOD picked by Chebyshev distance
  // from the camera tile, matching _tiledTerrainLodSegments
  // formula), then bilinear-interp the 4 corners.
  let chunkSize  = uD.bumpParams.y;
  let baseSegsP  = i32(uD.bumpParams.z);
  let chunkRadP  = i32(uD.bumpParams.w);
  var depth: f32 = 1000.0;   // open-ocean fallback when terrain unconfigured
  if (t_hs > 0.001 && t_freq > 0.0000001 && chunkSize > 0.001 && baseSegsP > 0) {
    // §5.5.h-5 -- use the ACTUAL disc center (with forwardBias),
    // not just the camera tile. Otherwise the LOD ring calculation
    // is off by the forwardBias shift and water foam misaligns
    // east/west of the player.
    let discTx = i32(uD.waterExtra.x);
    let discTz = i32(uD.waterExtra.y);
    // §5.5.h-9 -- beach band params from upstream TiledTerrain. Z=0
    // disables beaches; otherwise W is the beach noise freq.
    let beachStr  = uD.waterExtra.z;
    let beachFreq = uD.waterExtra.w;
    let myTx   = i32(floor(wp.x / chunkSize));
    let myTz   = i32(floor(wp.z / chunkSize));
    let segs   = _tw_lodSegs(abs(myTx - discTx), abs(myTz - discTz), max(0, chunkRadP), baseSegsP);
    let dStep = chunkSize / f32(segs);
    let gx = floor(wp.x / dStep) * dStep;
    let gz = floor(wp.z / dStep) * dStep;
    let fx = clamp((wp.x - gx) / dStep, 0.0, 1.0);
    let fz = clamp((wp.z - gz) / dStep, 0.0, 1.0);
    // §planet-spec Phase 3 -- LOD-aware octave count. Sample at the
    // SAME truncated octave count the chunked mesh used for this
    // chunk's LOD; otherwise water foam picks up high-freq detail
    // that the chunked mesh doesn't have and drifts off the shore.
    let octavesByLod = clamp(log2(1.0 / (2.0 * t_freq * dStep)), 0.0, 20.0);
    let t_octsF_lod  = min(t_octsF, octavesByLod);
    let y00 = _tw_finalY_at(gx,         gz,
                            t_freq, t_octsF_lod, t_lac, t_gain, t_ridges, t_seed, t_plateau,
                            t_hs, t_yOff, archipel, t_sink, m_freq, m_seed, m_thresh, m_soft,
                            beachStr, beachFreq);
    let y10 = _tw_finalY_at(gx + dStep, gz,
                            t_freq, t_octsF_lod, t_lac, t_gain, t_ridges, t_seed, t_plateau,
                            t_hs, t_yOff, archipel, t_sink, m_freq, m_seed, m_thresh, m_soft,
                            beachStr, beachFreq);
    let y01 = _tw_finalY_at(gx,         gz + dStep,
                            t_freq, t_octsF_lod, t_lac, t_gain, t_ridges, t_seed, t_plateau,
                            t_hs, t_yOff, archipel, t_sink, m_freq, m_seed, m_thresh, m_soft,
                            beachStr, beachFreq);
    let y11 = _tw_finalY_at(gx + dStep, gz + dStep,
                            t_freq, t_octsF_lod, t_lac, t_gain, t_ridges, t_seed, t_plateau,
                            t_hs, t_yOff, archipel, t_sink, m_freq, m_seed, m_thresh, m_soft,
                            beachStr, beachFreq);
    let terrainY = y00 * (1.0 - fx) * (1.0 - fz)
                 + y10 * fx        * (1.0 - fz)
                 + y01 * (1.0 - fx) * fz
                 + y11 * fx        * fz;
    depth = max(0.0, seaLevel - terrainY);
    // §5.5.h-7 -- distance fade removed. The new integer-bit hash
    // is bit-identical between JS and WGSL, so shader noise
    // matches mesh noise at every distance -- no more scattered
    // distant patches. Shore + shallow tint visible to the horizon.
  }

  // ---- Wave normals: multi-scale + landmass-aware drift ----
  // §5.5.h-20 -- three fBm layers (long swell, chop, fine ripple)
  // each drifting in a different direction so the surface reads as
  // a real hierarchy of motion instead of one big sloshing field.
  // Drift gets BIASED by the island mask gradient so when shore is
  // off to one side, the wave field bends TOWARD land -- waves
  // approach the beach perpendicular instead of flowing straight
  // past as if the island weren't there. Only sampled when the
  // archipelago mask is active; open-ocean patches pay nothing.
  var shoreBias = vec2<f32>(0.0);
  if (archipel > 0.5) {
    let dR = 90.0;
    let mE_ = _tw_islandLand(wp.x + dR, wp.z, m_freq, m_seed, m_thresh, m_soft);
    let mW_ = _tw_islandLand(wp.x - dR, wp.z, m_freq, m_seed, m_thresh, m_soft);
    let mN_ = _tw_islandLand(wp.x, wp.z - dR, m_freq, m_seed, m_thresh, m_soft);
    let mS_ = _tw_islandLand(wp.x, wp.z + dR, m_freq, m_seed, m_thresh, m_soft);
    let grad = vec2<f32>((mE_ - mW_) * 0.5, (mS_ - mN_) * 0.5);
    let gMag = length(grad);
    let biasAmt = clamp(gMag * 5.0, 0.0, 1.0);
    if (biasAmt > 0.0) {
      shoreBias = normalize(grad + vec2<f32>(1e-6)) * biasAmt * waveSpeed * 1.4;
    }
  }
  let driftA = vec2<f32>( t * waveSpeed * 0.6,  t * waveSpeed * 0.4) + t * shoreBias;
  let driftB = vec2<f32>(-t * waveSpeed * 0.3,  t * waveSpeed * 0.5) + t * shoreBias * 0.7;
  let driftC = vec2<f32>( t * waveSpeed * 0.9, -t * waveSpeed * 0.7) + t * shoreBias * 0.5;
  let uvA = wp.xz * waveFreq        + driftA;
  let uvB = wp.xz * waveFreq * 2.5  + driftB;
  let uvC = wp.xz * waveFreq * 6.2  + driftC;
  let eps = 0.025;
  let hC = _fbm(uvA)
         + _fbm(uvB) * 0.5
         + _fbm(uvC) * 0.28;
  let hX = _fbm(uvA + vec2<f32>(eps, 0.0))
         + _fbm(uvB + vec2<f32>(eps, 0.0)) * 0.5
         + _fbm(uvC + vec2<f32>(eps, 0.0)) * 0.28;
  let hZ = _fbm(uvA + vec2<f32>(0.0, eps))
         + _fbm(uvB + vec2<f32>(0.0, eps)) * 0.5
         + _fbm(uvC + vec2<f32>(0.0, eps)) * 0.28;
  // §5.5.h-20 -- shore amplitude fade. Wave chop tapers in shallow
  // water so the surface lies flatter near the beach (real wave
  // physics: friction with the seafloor damps amplitude before the
  // wave breaks; here we just attenuate the normal perturbation).
  let shoreAmpFade = clamp(depth / (shallowDp * 0.6), 0.25, 1.0);
  let waveAmpEff = waveAmp * shoreAmpFade;
  let dx = (hX - hC) / eps;
  let dz = (hZ - hC) / eps;
  let n = normalize(vec3<f32>(-dx * waveAmpEff, 1.0, -dz * waveAmpEff));

  let v = normalize(uS.eye.xyz - in.worldPos);

  // ---- Shore color: shallow water tints toward foam-light, depth
  // > shallowDp tints toward dark deep-blue. Smoothstep both for
  // soft gradients. ----
  let shallowAmt = 1.0 - smoothstep(0.0, shallowDp, depth);
  let deepAmt    = smoothstep(shallowDp, shallowDp * 8.0, depth);
  // Shallow shore color = water shifted toward sand-tinted teal.
  let shoreColor = vec3<f32>(0.55, 0.78, 0.74);
  let deepColor  = vec3<f32>(0.05, 0.10, 0.20);
  var bodyColor = mix(waterColor, shoreColor, shallowAmt);
  bodyColor = mix(bodyColor, deepColor, deepAmt);

  // ---- Fresnel mix with sky ----
  // §5.5.h-19 -- sample the upstream Environment (ProceduralSky /
  // HDRI / Gradient) along the reflected view ray so the water's
  // reflection actually matches what's in the sky. Falls back to
  // the static skyR/G/B params when no env is wired (mode=0).
  let cosTheta = max(0.0, dot(n, v));
  let f0 = 0.02;
  let fresnel = clamp(f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0), 0.0, 1.0);
  let depthFresnelFade = clamp(depth / (shallowDp * 0.5), 0.0, 1.0);
  let mixT = clamp(fresnel * fresnelStr * depthFresnelFade, 0.0, 1.0);
  let reflectedDir = reflect(-v, n);
  let envMode = u32(uS.envParams.x);
  var skySample: vec3<f32>;
  if (envMode == 2u) {
    // smooth-only so sun-disk doesn't double-up with the explicit
    // glint pass below; the disk lives in sample_procedural_sky.
    skySample = sample_procedural_sky_smooth(reflectedDir);
  } else if (envMode != 0u) {
    skySample = sample_env(reflectedDir);
  } else {
    skySample = skyColor;
  }
  var outRGB = mix(bodyColor, skySample, mixT);

  // §5.5.h-19 -- sun glint. Sharp Blinn-Phong highlight at the
  // half-vector. shininess=300 keeps the spot tight, sunCol is hot
  // (HDR > 1) so it survives tonemap as a bright sparkle. Modulated
  // by sun visibility (uS.envSun.w) so glint dies at night and at
  // the depth-fresnel fade so it doesn't appear on shallow shore
  // water where you can see straight to the bottom.
  let sunDir = uS.envSun.xyz;
  let sunVis = max(0.0, uS.envSun.w);
  let halfV  = normalize(sunDir + v);
  let specCos = max(0.0, dot(n, halfV));
  let specPow: f32 = 300.0;
  let spec = pow(specCos, specPow) * sunVis * 2.6 * depthFresnelFade;
  let sunCol = vec3<f32>(1.7, 1.55, 1.25);
  outRGB = outRGB + spec * sunCol;

  // ---- SHORE FOAM ----
  // Foam intensity peaks where depth < foamWidth and falls off
  // toward open water. Two layers:
  //   1. Static foam band at the shoreline (just depth-driven)
  //   2. Moving "wave crest" lines that sweep TOWARD shore as the
  //      sin wave's phase advances with t. Crests appear at integer
  //      values of (depth * waveShoreF - t * waveSpeed * 0.8).
  let depthN  = depth / foamWidth;                // 0 at shore, 1 at foamWidth deep
  let staticFoam = pow(clamp(1.0 - depthN, 0.0, 1.0), 1.5);
  let phase = depth * waveShoreF - t * waveSpeed * 1.2;
  let crest = 0.5 + 0.5 * sin(phase * 6.28318);
  // Wave-noise modulation so the crests aren't perfectly parallel.
  let crestNoise = _fbm(wp.xz * 0.04 + vec2<f32>(t * 0.3, 0.0));
  let movingFoam = pow(crest, 6.0) * (0.5 + 0.5 * crestNoise)
                   * clamp(1.0 - depthN * 1.5, 0.0, 1.0);   // only near shore
  let foamAmt = clamp(staticFoam + movingFoam, 0.0, 1.0);
  outRGB = mix(outRGB, foamColor, foamAmt);

  // §5.5.h-21 -- cloud shadows. Project this water pixel UP the sun
  // ray to the cloud altitude and sample cloud density there; if a
  // puff is overhead, darken the water + cut the sun glint. The
  // cloud params come from any Clouds3D node in the patch (packed
  // by the encoder into cloudExtra). coverage=0 disables. Skip
  // entirely when the sun is below the horizon -- nothing to cast.
  let cloudCov = uD.cloudExtra.y;
  let sunUp    = max(0.0, sunDir.y);
  if (cloudCov > 0.001 && sunUp > 0.05 && sunVis > 0.01) {
    let cloudAlt = uD.cloudExtra.x;
    let cScale   = uD.cloudExtra.z;
    let cSeed    = uD.cloudExtra.w;
    // Trace from water surface up to cloud altitude along the
    // sun direction. dx/dz are the XZ offset to the sample point.
    let tCloud = (cloudAlt - wp.y) / max(sunDir.y, 0.05);
    let cx = wp.x + sunDir.x * tCloud;
    let cz = wp.z + sunDir.z * tCloud;
    let cn = _tw_cloudDensity(cx, cz, cScale, cSeed);
    let lo = 1.0 - cloudCov;
    let shadowAmt = smoothstep(lo - 0.08, lo + 0.10, cn);
    // 0.50 max darkening keeps shadowed water still visible, just
    // overcast. Multiply on top of the existing color (shadow tints
    // toward a cooler dim variant of itself, not pure black).
    let shadowTint = vec3<f32>(0.55, 0.62, 0.74);
    let shadowMix  = mix(vec3<f32>(1.0), shadowTint, shadowAmt * 0.5);
    outRGB = outRGB * shadowMix;
  }

  let fogged = apply_fog(outRGB, in.worldPos);
  let mapped = tonemap_aces(fogged);
  // Alpha: deeper water more opaque, shallow + steep view = see-through
  let alphaBase = clamp(0.4 + 0.5 * depthFresnelFade + 0.3 * mixT, 0.3, 0.92);
  // Premultiply for the blend state (src=one, dst=one-minus-src-alpha)
  return vec4<f32>(mapped * alphaBase, alphaBase);
}

// Phase 7 §5.5.h-14 -- fs_clouds. Cloud-plane fragment shader.
// Reads world XZ from in.worldPos (the cloud plane is at a fixed
// world Y), samples two layers of fbm to give a puffy two-tone
// look, and blends against the existing framebuffer via the
// pipeline's premultiplied-alpha state. PerDraw legend:
//   baseColor.rgb = cloud color, baseColor.a = density multiplier
//   matParams     = (coverage, scale, time, _)
//   band1.xy      = (windX, windZ) -- already camera-XZ-anchored
//                   by the encoder so the noise sample tracks world
//                   coords; windX/Z continues to drift via the
//                   ProceduralSky-style wind params on the node.
// §5.5.h-17 -- fs_clouds. Reads from a CPU-built displaced cloud
// mesh (Clouds3D builder). All shape info is baked into vertex
// positions + normals; per-vertex alpha (color.r) was set by the
// builder via a smoothstep around the coverage threshold, so cloud
// edges fade softly into the sky. The shader does cheap Phong-style
// lighting + sky-color composite. No ray-marching.
//   baseColor.rgb = cloud color, baseColor.a = density multiplier
//   matParams.x   = ambient (overall fill light, 0..1)
//   matParams.y   = sunStrength (sun-dot contribution, 0..2)
@fragment
fn fs_clouds(in: VsOut) -> @location(0) vec4<f32> {
  let cloudColor  = uD.baseColor.rgb;
  let densityMult = max(0.0, uD.baseColor.a);
  let ambientK    = clamp(uD.matParams.x, 0.0, 1.0);
  let sunK        = max(0.0, uD.matParams.y);

  // Per-vertex soft-edge alpha was packed into color.r by the
  // mesh builder. Drop fragments where the cloud has fully faded
  // into a gap; gives clean sky breaks instead of polygon edges.
  let edgeAlpha = clamp(in.color.r, 0.0, 1.0);
  let alpha = clamp(edgeAlpha * densityMult, 0.0, 1.0);
  if (alpha <= 0.005) { discard; }

  // Phong-ish shading. Vertex normals were finite-differenced from
  // the displaced height field so the sides of puffs catch sun and
  // the flat tops + valleys read as different shades.
  let n = normalize(in.normal);
  let sunDir = uS.envSun.xyz;
  let sunDot = max(0.0, dot(n, sunDir)) * uS.envSun.w;
  let lit = cloudColor * (ambientK + sunDot * sunK);

  // Composite against the sky background sampled inline so the
  // shader can output opaque (alpha=1) with depth-write enabled.
  // The sky pass runs last and skips pixels with depth < 1, so
  // we'd otherwise see the Scene.clearR/G/B bleeding through any
  // translucent cloud fragments.
  let viewDir = normalize(in.worldPos - uS.eye.xyz);
  let mode = u32(uS.envParams.x);
  var bgCol: vec3<f32>;
  if (mode == 2u) {
    bgCol = sample_procedural_sky(viewDir);
  } else {
    bgCol = sample_env(viewDir);
  }
  let outRGB = mix(bgCol, lit, alpha);
  return vec4<f32>(tonemap_aces(outRGB), 1.0);
}

// Phase 7 §5.5.h-24 -- fs_horizon. Per-fragment cull of the
// TerrainHorizon impostor inside the chunked-disc radius, plus
// gentle Phong shading from the sun so lighting matches fs_terrain
// at the meeting line. The fragment shader is the cleanest fix for
// the impostor "swatching over" the chunked terrain: depth-test
// alone can't reliably keep the chunked detail in front because
// the impostor uses fewer noise octaves and isn't always slightly
// below the chunked surface.
//   baseColor.rgb = unused (vertex colors drive surface color)
//   matParams.x   = innerRadius (discard within this XZ distance)
//   matParams.y   = fadeWidth   (smoothstep band beyond innerRadius)
//   matParams.z   = ambient
//   matParams.w   = sunStrength
@fragment
fn fs_horizon(in: VsOut) -> @location(0) vec4<f32> {
  let innerR   = max(0.0, uD.matParams.x);
  let fadeW    = max(1.0, uD.matParams.y);
  let ambientK = clamp(uD.matParams.z, 0.0, 1.0);
  let sunK     = max(0.0, uD.matParams.w);

  let camPos = uS.eye.xyz;

  // §planet-spec Phase 1.5 -- altitude visibility gate. The
  // impostor is coarse / tiled-looking and only useful as a far-
  // distance backdrop. Hide it entirely below visAltLow; fade in
  // over [visAltLow, visAltHigh]. band1.w = visAltLow,
  // band2.x = visAltHigh.
  let visAltLow  = uD.band1.w;
  let visAltHigh = max(visAltLow + 1.0, uD.band2.x);
  let altVis = smoothstep(visAltLow, visAltHigh, camPos.y);
  if (altVis <= 0.001) { discard; }

  let dxz = in.worldPos.xz - camPos.xz;
  let r = length(dxz);
  if (r < innerR) { discard; }
  let fadeIn = clamp((r - innerR) / fadeW, 0.0, 1.0) * altVis;

  let n = normalize(in.normal);
  let sunDir = uS.envSun.xyz;
  let sunDot = max(0.0, dot(n, sunDir)) * uS.envSun.w;
  let baseCol = in.color;
  let lit = baseCol * (ambientK + sunDot * sunK);
  // Apply fog so the impostor blends to atmosphere color at the
  // outer edge, matching how the chunked terrain reads at distance.
  let fogged = apply_fog(lit, in.worldPos);
  // fadeIn ramps the impostor in over the band; the fade is done by
  // alpha-blending against the sky color sampled inline (so we can
  // output opaque + depth-write like the cloud shader).
  let viewDir = normalize(in.worldPos - camPos);
  let mode = u32(uS.envParams.x);
  var bgCol: vec3<f32>;
  if (mode == 2u) {
    bgCol = sample_procedural_sky_smooth(viewDir);
  } else if (mode != 0u) {
    bgCol = sample_env(viewDir);
  } else {
    bgCol = fogged;
  }
  let outRGB = mix(bgCol, fogged, fadeIn);
  return vec4<f32>(tonemap_aces(outRGB), 1.0);
}

// Phase 7 §5.5.c TerrainMaterial v2 (v0.3.129) -- AAA-style
// terrain shading. Altitude bands + slope rock + slope-masked
// snow + multi-scale detail noise (macro variation + micro
// speckle) sampled triplanar (so cliffs don't stretch) +
// procedural bump from micro-noise gradients + edge jitter on
// the band thresholds for organic-looking transitions instead
// of horizontal stripes.
//
// Cost: ~8 fbm evaluations per fragment (3 macro triplanar +
// 3 micro triplanar + 2 for bump finite-difference). Cheap by
// modern GPU standards but not free at 4K.
@fragment
fn fs_terrain(in: VsOut) -> @location(0) vec4<f32> {
  let n0 = normalize(in.normal);
  let v  = normalize(uS.eye.xyz - in.worldPos);
  let shin   = max(1.0, uD.matParams.x);
  let amb    = clamp(uD.matParams.y, 0.0, 1.0);
  let slopeK = uD.matParams.z;
  let vMix   = clamp(uD.matParams.w, 0.0, 1.0);

  // v2 detail + bump knobs.
  let detailScale    = max(0.0001, uD.detailParams.x);
  let detailStrength = clamp(uD.detailParams.y, 0.0, 1.0);
  let microScale     = max(0.0001, uD.detailParams.z);
  let microStrength  = clamp(uD.detailParams.w, 0.0, 1.0);
  let edgeJitter     = clamp(uD.bumpParams.x,  0.0, 1.0);
  let bumpStrength   = clamp(uD.bumpParams.y,  0.0, 1.0);
  let snowMaskAmt    = clamp(uD.bumpParams.z,  0.0, 1.0);

  // Triplanar weights -- used for both detail-noise blending and
  // any future texture sampling. Sharpness = 4 (standard).
  let triW = triplanar_weights(n0, 4.0);

  // Macro detail noise: low-frequency variation per band. Sample
  // on three world-axis planes + blend by triplanar weights so
  // the variation doesn't stretch on cliffs.
  let wmac = in.worldPos * detailScale;
  let macroX = _fbm(wmac.zy);
  let macroY = _fbm(wmac.xz);
  let macroZ = _fbm(wmac.xy);
  let macroN = macroX * triW.x + macroY * triW.y + macroZ * triW.z;

  // Micro detail noise: high-frequency speckle / surface texture.
  let wmic = in.worldPos * microScale;
  let microX = _fbm(wmic.zy);
  let microY = _fbm(wmic.xz);
  let microZ = _fbm(wmic.xy);
  let micro = microX * triW.x + microY * triW.y + microZ * triW.z;

  // Edge jitter: shift each band boundary by macro noise so the
  // transitions follow the terrain instead of running as
  // horizontal stripes. Range ±edgeJitter * 2 world units.
  let jitter = (macroN - 0.5) * edgeJitter * 2.0;
  let alt1 = uD.band1.w + jitter;
  let alt2 = uD.band2.w + jitter;
  let alt3 = uD.band3.w + jitter;
  let soft = max(0.001, uD.band4.w);

  let y   = in.worldPos.y;
  let w12 = smoothstep(alt1 - soft, alt1 + soft, y);
  let w23 = smoothstep(alt2 - soft, alt2 + soft, y);
  let w34 = smoothstep(alt3 - soft, alt3 + soft, y);

  let c12  = mix(uD.band1.rgb, uD.band2.rgb, w12);
  let c123 = mix(c12,          uD.band3.rgb, w23);

  // Slope-masked snow. Pure flat (n.y near 1) gets full snow;
  // steep faces (n.y near 0) skip it so cliffs above the snow
  // line still read as rock. snowMaskAmt=0 disables masking
  // (snow on every surface), 1 makes the mask strict.
  let flatness   = smoothstep(0.55, 0.92, n0.y);
  let snowFactor = w34 * mix(1.0, flatness, snowMaskAmt);
  let band       = mix(c123, uD.band4.rgb, snowFactor);

  // Slope-rockiness: blend rock-band color in on steep faces so
  // they read as stone regardless of altitude.
  let slope    = 1.0 - n0.y;
  let rockMask = clamp(slope * slopeK, 0.0, 1.0);
  var albedoBase = mix(band, uD.band3.rgb, rockMask);

  // Color variation: each band tinted by macro (±detailStrength)
  // and speckled by micro (±microStrength). Multiplicative so
  // tint stays in linear band rather than washing out.
  let macroTint = 1.0 + (macroN - 0.5) * detailStrength * 0.6;
  let microTint = 1.0 + (micro - 0.5) * microStrength * 0.4;
  albedoBase = albedoBase * macroTint * microTint;

  let albedo = mix(albedoBase, in.color, vMix);

  // Procedural bump: perturb the normal by the gradient of micro
  // noise. Cheap finite-difference -- one extra fbm sample per
  // axis (already have the center sample from earlier). Gives
  // surface micro-detail under lighting without normal maps.
  var n = n0;
  if (bumpStrength > 0.001) {
    let eps = 1.0 / max(microScale, 0.1) * 0.05;
    let dxPos = (in.worldPos + vec3<f32>(eps, 0.0, 0.0)) * microScale;
    let dzPos = (in.worldPos + vec3<f32>(0.0, 0.0, eps)) * microScale;
    // Sample the X-projection plane for dx, Z-projection for dz
    // (matches the dominant-axis approximation; for typical
    // upward-facing terrain triplanar weights are biased toward Y).
    let mxDx = _fbm(dxPos.zy);
    let mzDz = _fbm(dzPos.xy);
    let bumpX = (mxDx - microX) / max(eps, 0.0001);
    let bumpZ = (mzDz - microZ) / max(eps, 0.0001);
    let perturb = vec3<f32>(-bumpX, 0.0, -bumpZ) * bumpStrength * 0.04;
    n = normalize(n0 + perturb);
  }

  // Phong-style accumulation over enabled lights.
  let nLights = u32(uS.lightCount.x);
  var lit: vec3<f32> = albedo * amb;
  for (var i: u32 = 0u; i < nLights; i = i + 1u) {
    let L     = uS.lights[i];
    let info  = _eval_light_i(i, in.worldPos);
    let l     = info.xyz;
    let atten = info.w;
    let h     = normalize(l + v);
    let nDotL = max(dot(n, l), 0.0);
    let spec  = pow(max(dot(n, h), 0.0), shin) * step(0.001, nDotL);
    let li    = L.color.rgb * L.color.w;
    lit = lit + albedo * nDotL * (1.0 - amb) * atten * li
              + vec3<f32>(spec) * atten * li * 0.25;
  }
  let fogged = apply_fog(lit, in.worldPos);
  return vec4<f32>(tonemap_aces(fogged), 1.0);
}

// PhysicalMat fragment: Cook-Torrance microfacet BRDF (GGX D,
// Schlick-GGX G, Schlick F). Same metallic-roughness workflow as
// before, now summed over enabled lights.
@fragment
fn fs_pbr(in: VsOut) -> @location(0) vec4<f32> {
  var n = normalize(in.normal);
  // A.4 -- tangent-space normal map via screen-space derivatives (no
  // vertex tangents needed). Derivatives are taken at top level
  // (uniform control flow); the perturb is guarded so the default
  // map (0.5,0.5,1)->(0,0,1) and degenerate UVs leave n untouched.
  // A.4 -- matParams.x = UV tile factor (default 1). meshSampler is
  // repeat, so >1 tiles seamless maps across large faces. TBN uses
  // unscaled-uv derivatives -- the uniform scale cancels in the
  // normalize below, so the tangent frame is unaffected.
  let uvTile = max(uD.matParams.x, 0.0001);
  let uvT  = in.uv * uvTile;
  let dp1  = dpdx(in.worldPos);
  let dp2  = dpdy(in.worldPos);
  let duv1 = dpdx(in.uv);
  let duv2 = dpdy(in.uv);
  let nMap = textureSample(matNormalTex, srcSampler, uvT).xyz * 2.0 - 1.0;
  if (abs(nMap.x) + abs(nMap.y) > 0.01) {
    let dp2perp = cross(dp2, n);
    let dp1perp = cross(n, dp1);
    let Tt = dp2perp * duv1.x + dp1perp * duv2.x;
    let Bt = dp2perp * duv1.y + dp1perp * duv2.y;
    let denom = max(dot(Tt, Tt), dot(Bt, Bt));
    if (denom > 1e-12) {
      let invmax = inverseSqrt(denom);
      n = normalize(mat3x3<f32>(Tt * invmax, Bt * invmax, n) * nMap);
    }
  }
  let v = normalize(uS.eye.xyz - in.worldPos);
  let nDotV = max(dot(n, v), 0.0);
  // A.4 -- per-material maps. White/identity defaults make these a
  // no-op for untextured meshes (albedo x1, rough/metal x scalar param).
  let albTex = textureSample(matAlbedoTex, srcSampler, uvT).rgb;
  let albedo    = mix(uD.baseColor.rgb, in.color, uD.baseColor.a) * albTex;
  let metallic  = clamp(uD.matParams.z * textureSample(matMetalTex, srcSampler, uvT).r, 0.0, 1.0);
  let roughness = clamp(uD.matParams.w * textureSample(matRoughTex, srcSampler, uvT).r, 0.04, 1.0);
  let alpha  = roughness * roughness;
  let alpha2 = alpha * alpha;
  let F0 = mix(vec3<f32>(0.04), albedo, metallic);
  let kk = (roughness + 1.0) * (roughness + 1.0) / 8.0;

  var total: vec3<f32> = vec3<f32>(0.0);
  let nLights = u32(uS.lightCount.x);
  for (var i: u32 = 0u; i < nLights; i = i + 1u) {
    let L     = uS.lights[i];
    let info  = _eval_light_i(i, in.worldPos);
    let l     = info.xyz;
    let atten = info.w;
    let h     = normalize(l + v);
    let nDotL = max(dot(n, l), 0.0);
    let nDotH = max(dot(n, h), 0.0);
    let hDotV = max(dot(h, v), 0.0);

    let F = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - hDotV, 5.0);
    let denom_d = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
    let D = alpha2 / (3.14159265 * denom_d * denom_d);
    let g_v = nDotV / (nDotV * (1.0 - kk) + kk);
    let g_l = nDotL / (nDotL * (1.0 - kk) + kk);
    let G = g_v * g_l;
    let specular = (D * F * G) / max(4.0 * nDotL * nDotV, 0.001);

    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - metallic);
    let diffuse = kD * albedo / 3.14159265;

    let li = L.color.rgb * L.color.w;
    total = total + (diffuse + specular) * li * nDotL * atten;
  }

  // Sprint 7.5.4 -- IBL ambient via sample_env(). Mode 0 = pre-7.5.4
  // hardcoded hemisphere; mode 1+ = wired environment (e.g.
  // GradientSky). Diffuse uses the surface normal direction so the
  // top of the sphere reads the sky color; specular uses the
  // reflection vector so a low-roughness metal reflects whatever the
  // env shows in the direction the camera-bounce ray would go.
  let r = reflect(-v, n);
  let envDiffuse = sample_env(n);
  let envSpec    = sample_env(r);
  let kS_amb = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - nDotV, 5.0);
  let kD_amb = (vec3<f32>(1.0) - kS_amb) * (1.0 - metallic);
  // Roughness-aware IBL specular. There's no prefiltered env mip
  // chain, so approximate gloss falloff two ways: blend the sharp
  // mirror sample toward the soft diffuse-direction sample as
  // roughness rises (a fake blur), and fade specular strength by
  // (1-roughness)². Keeps a chrome surface (rough≈0) a crisp mirror
  // while brick / concrete / plaster (rough≈1) read matte instead of
  // wet-shiny. The +0.04 floor preserves a faint grazing rim.
  let invR    = 1.0 - roughness;
  let envR    = mix(envSpec, envDiffuse, roughness * roughness);
  let specAmt = invR * invR + 0.04;
  let ambient = kD_amb * albedo * envDiffuse * 0.5
              + kS_amb * envR * specAmt;
  // 7.5.4.e -- fog + tonemap. Fog mixes toward env-horizon color at
  // far distances; ACES compresses HDR ambient into [0,1] so HDRI /
  // ProceduralSky bright reflections don't blow out.
  let lit = total + ambient;
  let fogged = apply_fog(lit, in.worldPos);
  return vec4<f32>(tonemap_aces(fogged), 1.0);
}`;

