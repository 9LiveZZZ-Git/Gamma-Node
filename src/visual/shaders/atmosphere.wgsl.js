/* ========================================================================
 * Sprint 7.6.b-atm Tier C -- atmosphere precomputation LUTs (Hillaire 2020).
 * ========================================================================
 *
 * Two small textures regenerated each frame and sampled by fs_sky /
 * _atm_integrate for fast lookup instead of re-integrating per-pixel:
 *
 *   transmittance LUT  (256 x 64,  rgba16float)
 *     Per (altitude, viewZenith) pair, the Beer-Lambert sun extinction
 *     exp(-Σβ τ) for a ray that exits the atmosphere shell. Replaces
 *     the inner sun-ray loop in _atm_integrate's per-sample work.
 *
 *   multi-scattering LUT (32 x 32, rgba16float)
 *     Per (altitude, sunZenithCos) pair, the isotropic second-bounce
 *     contribution averaged over sphere directions. THIS is the term
 *     that lights the shadowed side of the atmosphere (single-scatter
 *     only lights the sun-facing side). User-visible: limb glow no
 *     longer biased toward the sun in orbital screenshots.
 *
 * Both LUTs are computed via fullscreen render-to-texture passes (a
 * choice over compute pipelines for parity with the rest of the
 * editor's WebGPU surface area; the LUTs are tiny and a render pass
 * was already a well-trodden path). One uniform buffer feeds the
 * planet/atmosphere params -- the same shape as PerScene's
 * envPlanet / envPlanetAtm / envPlanetGeom slots so the math lines up
 * with what _atm_integrate already computes.
 *
 * Layout:
 *   _ATM_LUT_WGSL                  -- the two LUT fragment shaders
 *   _ensureAtmosphereLUTs()        -- texture + pipeline + sampler init
 *   _renderAtmosphereLUTs(enc, …)  -- per-frame dispatch
 *   Visual.atmLutUniformBuffer     -- 64-byte UBO (4 vec4s)
 *   Visual.atmTransmittanceLUT/View
 *   Visual.atmMultiScatterLUT/View
 *   Visual.atmLutSampler           -- linear, clamp-to-edge
 *   Visual.atmLut1x1Default/View   -- 1x1 black default bound when no
 *                                     planet is wired (mesh BGL parity)
 * ====================================================================== */

const _ATM_LUT_WGSL = `
// ATM_PARAMS layout matches the JS-side _atmLutScratch pack:
//   planet.xyz        = planet center (unused inside LUTs; shells are
//                        computed in planet-local space).
//   planet.w          = planet surface radius (world units).
//   atm.x             = atmosphere top radius.
//   atm.y             = Rayleigh scale height.
//   atm.z             = Mie scale height.
//   atm.w             = sun irradiance multiplier.
//   sun.xyz           = world-space direction TO sun (unused in
//                        transmittance LUT; multi-scatter LUT
//                        synthesizes its own sun dir from sunZenith).
//   sun.w             = mieG (forward-scatter anisotropy).
//   misc.x            = turbidity (Mie multiplier).
//   misc.y            = polRatio (unused in LUTs -- atmosphere shell
//                        is treated as a sphere for LUT purposes; the
//                        oblateness is < 0.4% and the LUT axes don't
//                        depend on planet orientation).
//   misc.z            = LUT_WIDTH (transmittance LUT only; informational).
//   misc.w            = LUT_HEIGHT.
struct AtmParams {
  planet: vec4<f32>,
  atm:    vec4<f32>,
  sun:    vec4<f32>,
  misc:   vec4<f32>,
  // C.4 -- camera info for sky-view LUT. .xyz = world-space camera
  // position; .w reserved (precomputed altitude if useful later).
  // Transmittance + multi-scatter LUTs ignore this slot.
  camera: vec4<f32>,
  // C.7 cleanup -- camera basis (camRight/Up/Forward) was packed
  // here for the now-removed aerial-perspective LUT. Sky-view LUT
  // computes its own local frame from camera + planet center, so no
  // basis is needed any more.
};
@group(0) @binding(0) var<uniform> uA: AtmParams;

// C.7 cleanup -- AerialSlice / uASlice / fs_lut_aerial all removed
// after the structural fix; only the in-scatter (transmittance,
// multi-scatter, sky-view) LUTs remain.

const ATM_EARTH_R: f32 = 6371000.0;

// Beer-Lambert per-channel extinction from a planet-local origin in
// the indicated direction, integrating until the atmosphere shell
// exit (or planet ground, whichever comes first). Returns
// exp(-(βR * τR + βM * 1.1 * τM)) so the consumer multiplies it
// straight into sun irradiance.
fn atm_transmittance_local(
  origin: vec3<f32>,
  dir:    vec3<f32>,
  planetR: f32,
  atmR:    f32,
  scaleHR: f32,
  scaleHM: f32,
  turbidity: f32,
  unitScale: f32,
) -> vec3<f32> {
  let b = dot(origin, dir);
  let cAtm = dot(origin, origin) - atmR * atmR;
  let hAtm = b * b - cAtm;
  if (hAtm < 0.0) { return vec3<f32>(1.0); }
  let sAtm = sqrt(hAtm);
  let tExit = max(-b + sAtm, 0.0);
  // If origin is inside atmosphere & ray escapes, tExit is the path
  // length to the far shell. Clip to ground if needed.
  var tEnd = tExit;
  let cGnd = dot(origin, origin) - planetR * planetR;
  let hGnd = b * b - cGnd;
  if (hGnd > 0.0) {
    let sGnd = sqrt(hGnd);
    let tG = -b - sGnd;
    if (tG > 0.0 && tG < tEnd) { tEnd = tG; }
  }
  if (tEnd <= 0.0) { return vec3<f32>(1.0); }
  let SAMPLES: i32 = 32;
  let dt = tEnd / f32(SAMPLES);
  var opticalR: f32 = 0.0;
  var opticalM: f32 = 0.0;
  for (var i: i32 = 0; i < SAMPLES; i = i + 1) {
    let t = (f32(i) + 0.5) * dt;
    let p = origin + dir * t;
    let h = max(0.0, length(p) - planetR);
    opticalR = opticalR + exp(-h / scaleHR) * dt;
    opticalM = opticalM + exp(-h / scaleHM) * dt;
  }
  let betaR = vec3<f32>(5.8e-6, 13.5e-6, 33.1e-6) * unitScale;
  let betaM = vec3<f32>(21.0e-6) * unitScale * turbidity;
  return exp(-(betaR * opticalR + betaM * 1.1 * opticalM));
}

struct VsLutOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_lut(@builtin(vertex_index) vid: u32) -> VsLutOut {
  // Oversized fullscreen triangle; uv covers [0,1]^2 over the
  // visible viewport quadrant.
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>( 3.0,  1.0),
    vec2<f32>(-1.0,  1.0)
  );
  let p = positions[vid];
  var out: VsLutOut;
  out.pos = vec4<f32>(p.x, p.y, 0.5, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
  return out;
}

// Transmittance LUT pixel. Maps screen-space uv to (viewZenithCos,
// altitude) with sqrt non-linearity (more samples near horizon and
// near ground where atmospheric detail is highest).
@fragment
fn fs_lut_transmittance(in: VsLutOut) -> @location(0) vec4<f32> {
  let planetR = uA.planet.w;
  let atmR    = uA.atm.x;
  let scaleHR = uA.atm.y;
  let scaleHM = uA.atm.z;
  let turbidity = max(uA.misc.x, 0.5);

  if (planetR <= 0.0 || atmR <= planetR) {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
  }

  // Axes: u in [0,1] -> cosVZ in [-1, 1] with sqrt remapping.
  //       v in [0,1] -> alt in [0, atmThickness] with sqrt remapping.
  let u = clamp(in.uv.x, 0.0, 1.0);
  let v = clamp(in.uv.y, 0.0, 1.0);
  let cosVZ  = 2.0 * (u * u) - 1.0;
  let sinVZ  = sqrt(max(0.0, 1.0 - cosVZ * cosVZ));
  let atmThk = atmR - planetR;
  let alt    = (v * v) * atmThk;

  // Planet-local frame: ground "up" = +Y, view direction in YZ plane.
  let origin = vec3<f32>(0.0, planetR + alt, 0.0);
  let dir    = vec3<f32>(0.0, cosVZ, sinVZ);

  let unitScale = ATM_EARTH_R / planetR;
  let T = atm_transmittance_local(origin, dir, planetR, atmR,
                                   scaleHR, scaleHM, turbidity, unitScale);
  return vec4<f32>(T, 1.0);
}

@group(0) @binding(1) var ttex: texture_2d<f32>;
@group(0) @binding(2) var mtex: texture_2d<f32>;
@group(0) @binding(3) var tsamp: sampler;

// Sample the transmittance LUT for an arbitrary (altitude,
// viewZenithCos) pair. Matches the axis mapping used by
// fs_lut_transmittance so the round-trip is exact (modulo bilinear
// filtering). The LUT is sampled with clamp-to-edge so out-of-range
// queries fall back to the nearest valid value.
//
// 2026-05-22 fix: WebGPU NDC.y=+1 maps to framebuffer pixel.y=0 (top),
// but sampler UV.v=0 ALSO maps to pixel.y=0. So NDC.y and UV.v are
// INVERSE-related. The LUT is written with high-altitude / zenith at
// the top row (UV.v=0); to read it back we must invert v.
fn sample_transmittance_lut(
  T: texture_2d<f32>, S: sampler,
  cosVZ: f32, alt: f32, atmThickness: f32,
) -> vec3<f32> {
  let u = sqrt(clamp(cosVZ * 0.5 + 0.5, 0.0, 1.0));
  let v = sqrt(clamp(alt / max(atmThickness, 1.0), 0.0, 1.0));
  return textureSampleLevel(T, S, vec2<f32>(u, 1.0 - v), 0.0).rgb;
}

// C.4 -- helpers using the module-scope bindings (cleaner sample sites
// in fs_lut_skyview where we sample both LUTs per ray sample).
fn _lut_T(cosVZ: f32, alt: f32, atmThk: f32) -> vec3<f32> {
  return sample_transmittance_lut(ttex, tsamp, cosVZ, alt, atmThk);
}
fn _lut_MS(cosSZ: f32, alt: f32, atmThk: f32) -> vec3<f32> {
  let u = clamp(cosSZ * 0.5 + 0.5, 0.0, 1.0);
  let v = sqrt(clamp(alt / max(atmThk, 1.0), 0.0, 1.0));
  return textureSampleLevel(mtex, tsamp, vec2<f32>(u, 1.0 - v), 0.0).rgb;
}

// Multi-scattering LUT pixel. Computes the isotropic-bounce
// contribution to in-scatter for a point at the given altitude with
// the sun at the given zenith. Uses the transmittance LUT for fast
// per-direction attenuation. The integral averages over sphere
// directions (Fibonacci-ish), accumulating direct single-scatter
// for the second bounce; the result is what the view-ray integrator
// adds at each sample point to account for multi-bounce light.
//
// Reference: Hillaire 2020 §5 "Multiple Scattering".
@fragment
fn fs_lut_multiscatter(in: VsLutOut) -> @location(0) vec4<f32> {
  let planetR = uA.planet.w;
  let atmR    = uA.atm.x;
  let scaleHR = uA.atm.y;
  let scaleHM = uA.atm.z;
  let turbidity = max(uA.misc.x, 0.5);

  if (planetR <= 0.0 || atmR <= planetR) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // Axes: u -> cosSZ in [-1, 1] (linear). v -> alt with sqrt.
  let u = clamp(in.uv.x, 0.0, 1.0);
  let v = clamp(in.uv.y, 0.0, 1.0);
  let cosSZ  = 2.0 * u - 1.0;
  let sinSZ  = sqrt(max(0.0, 1.0 - cosSZ * cosSZ));
  let atmThk = atmR - planetR;
  let alt    = (v * v) * atmThk;

  let origin = vec3<f32>(0.0, planetR + alt, 0.0);
  let sunDir = vec3<f32>(0.0, cosSZ, sinSZ);

  let unitScale = ATM_EARTH_R / planetR;
  let betaR = vec3<f32>(5.8e-6, 13.5e-6, 33.1e-6) * unitScale;
  let betaM = vec3<f32>(21.0e-6) * unitScale * turbidity;

  // Sphere-direction averaging. SQRT_N x SQRT_N samples over the
  // sphere using equal-area mapping (lat in [-1,1], lon in [0, 2π)).
  // 8x8 = 64 directions per pixel is the Hillaire-paper default;
  // multi-scattering is smooth so this is plenty.
  let SQRT_N: i32 = 8;
  let TOTAL = f32(SQRT_N * SQRT_N);
  var L = vec3<f32>(0.0);
  var FMS = vec3<f32>(0.0);
  for (var i: i32 = 0; i < SQRT_N; i = i + 1) {
    for (var j: i32 = 0; j < SQRT_N; j = j + 1) {
      let randU = (f32(i) + 0.5) / f32(SQRT_N);
      let randV = (f32(j) + 0.5) / f32(SQRT_N);
      let phi = 2.0 * 3.14159265 * randU;
      let cosT = 1.0 - 2.0 * randV;
      let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
      let rayDir = vec3<f32>(sinT * cos(phi), cosT, sinT * sin(phi));

      // March along this direction. Capture single-scatter sum plus
      // an "amount of light that escapes back to space" factor (FMS)
      // that the consumer multiplies for the geometric series sum.
      let b = dot(origin, rayDir);
      let cAtm = dot(origin, origin) - atmR * atmR;
      let hAtm = b * b - cAtm;
      if (hAtm < 0.0) { continue; }
      let sAtm = sqrt(hAtm);
      var tEnd = max(-b + sAtm, 0.0);
      let cGnd = dot(origin, origin) - planetR * planetR;
      let hGnd = b * b - cGnd;
      var hitGround = false;
      if (hGnd > 0.0) {
        let tG = -b - sqrt(hGnd);
        if (tG > 0.0 && tG < tEnd) { tEnd = tG; hitGround = true; }
      }
      if (tEnd <= 0.0) { continue; }
      let M: i32 = 20;
      let dt = tEnd / f32(M);
      var tau = vec3<f32>(0.0);
      var L_dir = vec3<f32>(0.0);
      var Fms_dir = vec3<f32>(0.0);
      for (var k: i32 = 0; k < M; k = k + 1) {
        let t = (f32(k) + 0.5) * dt;
        let p = origin + rayDir * t;
        let h = max(0.0, length(p) - planetR);
        let densR = exp(-h / scaleHR);
        let densM = exp(-h / scaleHM);
        let dTau  = (betaR * densR + betaM * 1.1 * densM) * dt;
        let tauMid = tau + dTau * 0.5;
        let T_view = exp(-tauMid);
        // Sun transmittance from p along sun direction, via the LUT.
        let upDir   = normalize(p);
        let cosVZsun = dot(upDir, sunDir);
        let T_sun = sample_transmittance_lut(ttex, tsamp,
                      cosVZsun, h, atmThk);
        // Sun visible only if no planet shadow along sun ray.
        let bp = dot(p, sunDir);
        let cgp = dot(p, p) - planetR * planetR;
        let hg = bp * bp - cgp;
        var sunVis = 1.0;
        if (hg > 0.0) {
          let tg = -bp - sqrt(hg);
          if (tg > 0.0) { sunVis = 0.0; }
        }
        let scatter = (betaR * densR + betaM * densM);
        // Single-bounce contribution at this sample (isotropic phase
        // 1/4π absorbed into the LUT, since we're averaging over
        // sphere directions anyway).
        L_dir = L_dir + T_view * scatter * T_sun * sunVis * dt;
        // Multi-scatter "feedback" coefficient: how much energy stays
        // in atmosphere (Hillaire eq. 7).
        Fms_dir = Fms_dir + T_view * scatter * dt;
        tau = tau + dTau;
      }
      L  = L  + L_dir;
      FMS = FMS + Fms_dir;
    }
  }
  L  = L  / TOTAL;
  FMS = FMS / TOTAL;
  // Closed-form geometric series for infinite-bounce multi-scattering:
  //   Lmulti = L / (1 - FMS)
  // FMS is clamped < 1 to keep the series convergent.
  let one = vec3<f32>(1.0);
  let denom = max(one - FMS, vec3<f32>(0.001));
  let Lmulti = L / denom;
  return vec4<f32>(Lmulti, 1.0);
}

// C.4 -- Sky-view LUT pixel. The LUT encodes the integrated sky color
// as seen from the CURRENT camera position, indexed by (azimuth,
// elevation) in the camera's LOCAL frame (zenith-aligned with the
// planet-radial direction; north reference = world +Y projected to
// the horizon plane, falling back to +X near the poles).
//
// Per-pixel work:
//   1. Decode uv -> (azimuth, elevation), with horizon-weighted v.
//   2. Build the world-space ray direction.
//   3. Ray-march atmosphere from the camera, sampling the precomputed
//      transmittance + multi-scatter LUTs per step.
//
// 30 view samples + 2 LUT lookups each = much cheaper than the 16x8
// double integral in the legacy per-pixel sky shader; fs_sky in the
// mesh module then becomes one texture lookup.
@fragment
fn fs_lut_skyview(in: VsLutOut) -> @location(0) vec4<f32> {
  let planetC = uA.planet.xyz;
  let planetR = uA.planet.w;
  let atmR    = uA.atm.x;
  let scaleHR = uA.atm.y;
  let scaleHM = uA.atm.z;
  let sunI    = uA.atm.w;
  let sunDir  = uA.sun.xyz;
  let mieG    = uA.sun.w;
  let turbidity = max(uA.misc.x, 0.5);
  let eye     = uA.camera.xyz;

  if (planetR <= 0.0 || atmR <= planetR) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // Local frame.
  let radial = eye - planetC;
  let radialLen = length(radial);
  if (radialLen < 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let localUp = radial / radialLen;
  var northRef = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(dot(localUp, northRef)) > 0.99) {
    northRef = vec3<f32>(1.0, 0.0, 0.0);
  }
  let localNorth = normalize(northRef - dot(northRef, localUp) * localUp);
  let localEast  = cross(localUp, localNorth);

  // C.6 -- limb-aware v-axis. The "limb" is the angle (below horizon)
  // where the planet's silhouette sits from the camera; for a surface
  // observer it coincides with the horizon (limb=0), for orbit it
  // approaches -π/2 (nadir). Putting v=0.5 at the limb keeps maximum
  // resolution at the visible planet edge at every altitude, which
  // fixes the every-50km pulsing the prior horizon-anchored mapping
  // showed. Above the limb is sky, below is planet body.
  let sinBeta  = clamp(planetR / max(radialLen, planetR + 1.0), 0.0, 1.0);
  let limbElev = asin(sinBeta) - 1.5707963;  // in [-π/2, 0]

  let azimuth = in.uv.x * 6.28318530718 - 3.14159265359;
  var elevation: f32;
  if (in.uv.y >= 0.5) {
    let t = (in.uv.y - 0.5) * 2.0;
    elevation = limbElev + (1.5707963 - limbElev) * t * t;
  } else {
    let t = (0.5 - in.uv.y) * 2.0;
    elevation = limbElev - (limbElev + 1.5707963) * t * t;
  }
  let cosEl = cos(elevation);
  let sinEl = sin(elevation);
  let sinAz = sin(azimuth);
  let cosAz = cos(azimuth);
  let dir = localEast * (sinAz * cosEl)
          + localUp   *  sinEl
          + localNorth * (cosAz * cosEl);

  let atmThk = atmR - planetR;
  let unitScale = ATM_EARTH_R / planetR;
  let betaR = vec3<f32>(5.8e-6, 13.5e-6, 33.1e-6) * unitScale;
  let betaM = vec3<f32>(21.0e-6) * unitScale * turbidity;

  // Ray-atmosphere intersect (sphere; oblateness is < 0.4% and the LUT
  // doesn't carry polRatio).
  let oc = eye - planetC;
  let b  = dot(oc, dir);
  let cAtm = dot(oc, oc) - atmR * atmR;
  let hAtm = b * b - cAtm;
  if (hAtm < 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let sAtm = sqrt(hAtm);
  var t0 = max(-b - sAtm, 0.0);
  var t1 = -b + sAtm;
  let cGnd = dot(oc, oc) - planetR * planetR;
  let hGnd = b * b - cGnd;
  if (hGnd > 0.0) {
    let tg = -b - sqrt(hGnd);
    if (tg > 0.0 && tg < t1) { t1 = tg; }
  }
  let segLen = t1 - t0;
  if (segLen <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }

  // Phase functions.
  let cosTheta = dot(dir, sunDir);
  let cos2 = cosTheta * cosTheta;
  let phaseR = 0.0596831 * (1.0 + cos2);
  let g = clamp(mieG, 0.0, 0.95);
  let g2 = g * g;
  let mDenom = pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
  let phaseM = 0.1193662 * (1.0 - g2) * (1.0 + cos2) / ((2.0 + g2) * mDenom);

  // C.7 -- importance sampling. Match the aerial-perspective LUT's
  // approach: concentrate samples near the end of the segment closest
  // to the planet ground (densest atmosphere). Bump 48 -> 64 samples
  // alongside the remap.
  let h_at_t0 = max(0.0, length(eye + dir * t0 - planetC) - planetR);
  let h_at_t1 = max(0.0, length(eye + dir * t1 - planetC) - planetR);
  let concAtEnd: f32 = select(0.0, 1.0, h_at_t0 > h_at_t1);

  let SAMPLES: i32 = 64;
  let invN = 1.0 / f32(SAMPLES);
  var inScatter   = vec3<f32>(0.0);
  var transmittance = vec3<f32>(1.0);

  for (var i: i32 = 0; i < SAMPLES; i = i + 1) {
    let u = (f32(i) + 0.5) * invN;
    let gLow  = u * u;
    let gHigh = 1.0 - (1.0 - u) * (1.0 - u);
    let dgLow  = 2.0 * u;
    let dgHigh = 2.0 * (1.0 - u);
    let uMapped = mix(gLow,  gHigh,  concAtEnd);
    let dgScale = mix(dgLow, dgHigh, concAtEnd);
    let t  = t0 + segLen * uMapped;
    let dt = segLen * dgScale * invN;
    let p = eye + dir * t;
    let pRadial = p - planetC;
    let h = max(0.0, length(pRadial) - planetR);
    let densR = exp(-h / scaleHR);
    let densM = exp(-h / scaleHM);
    let dTau  = (betaR * densR + betaM * 1.1 * densM) * dt;
    let segT  = exp(-dTau);

    // Sun ray from p.
    let pUp = pRadial / max(length(pRadial), 1.0);
    let cosVZsun = dot(pUp, sunDir);
    let sunT = _lut_T(cosVZsun, h, atmThk);

    // Sun shadowed by planet?
    let bp = dot(pRadial, sunDir);
    let cgp = dot(pRadial, pRadial) - planetR * planetR;
    let hg = bp * bp - cgp;
    var sunVis = 1.0;
    if (hg > 0.0) {
      let tg = -bp - sqrt(hg);
      if (tg > 0.0) { sunVis = 0.0; }
    }

    // Single scatter from this sample.
    let singleR = betaR * phaseR * densR;
    let singleM = betaM * phaseM * densM;
    let single = (singleR + singleM) * sunT * sunVis;

    // Multi-scatter from this sample (scaled to match the consumer-side
    // weighting we use in _atm_integrate's planet-aware path).
    let ms = _lut_MS(cosVZsun, h, atmThk);
    let scatter = betaR * densR + betaM * densM;
    let MS_SCALE: f32 = 0.15;
    let multi = ms * scatter * MS_SCALE;

    let contrib = (single + multi) * transmittance * dt;
    inScatter = inScatter + contrib;
    transmittance = transmittance * segT;
  }

  // sunI absorbed into the returned in-scatter so fs_sky's sample is
  // ready-to-use without further scaling.
  return vec4<f32>(inScatter * sunI, 1.0);
}

// C.7 cleanup -- fs_lut_aerial + AerialOut + AerialSlice / uASlice
// were here. ~180 LOC of per-voxel ray-marching against the
// exponential atmospheric density curve, removed after the
// structural fix moved aerial perspective onto the existing
// sky-view + transmittance LUTs (no depth axis = no ring aliasing).
`;

