/* ------------ Phase 6.6.11 — auto-blend overlap detection -------------- */

/* For display index i, compute how many degrees of pose-space it
 * overlaps with each of its neighbors on the four sides. Returns
 * { left, right, top, bottom } in degrees of yaw / pitch.
 *
 * Algorithm: each display has a footprint rectangle in (yaw, pitch)
 * space:
 *     yaw  ∈ [pose.yaw  - fov.h/2, pose.yaw  + fov.h/2]
 *     pitch ∈ [pose.pitch - fov.v/2, pose.pitch + fov.v/2]
 *
 * For each OTHER display j whose pitch range overlaps this display's
 * pitch range:
 *   - if j sits to the left (j.yaw_max > my.yaw_min, j.yaw < my.yaw)
 *     → left overlap = j.yaw_max - my.yaw_min, take max
 *   - if j sits to the right → mirror
 *
 * Vertical overlaps (top / bottom) gated on yaw-range overlap.
 *
 * Yaw wrap-around (a 360° rig where the last display loops back to
 * the first) is handled by trying both raw and ±360° offsets and
 * picking the one with smallest absolute pose difference.
 *
 * Returns 0 on a side that has no neighbor overlapping it — used to
 * decide which sides get an intensity ramp. */
function _computeOverlapBands(i, displays) {
  if (!displays || !displays[i]) return { left: 0, right: 0, top: 0, bottom: 0 };
  const me = displays[i];
  const myPose = me.pose || { yaw: 0, pitch: 0 };
  const myFov  = me.fov  || { h: 90, v: 60 };
  const myYawMin   = myPose.yaw   - myFov.h * 0.5;
  const myYawMax   = myPose.yaw   + myFov.h * 0.5;
  const myPitchMin = myPose.pitch - myFov.v * 0.5;
  const myPitchMax = myPose.pitch + myFov.v * 0.5;

  let left = 0, right = 0, top = 0, bottom = 0;

  for (let j = 0; j < displays.length; j++) {
    if (j === i) continue;
    const o = displays[j];
    if (!o) continue;
    const oPose = o.pose || { yaw: 0, pitch: 0 };
    const oFov  = o.fov  || { h: 90, v: 60 };

    // Try yaw offsets of {-360, 0, +360} so 360° wraparound rigs detect
    // the wrap-around neighbor. Pick the offset with the smallest yaw
    // distance — that's the actual "nearest" instance of the neighbor.
    let bestOPose = oPose;
    let bestDist  = Math.abs(oPose.yaw - myPose.yaw);
    for (const off of [-360, 360]) {
      const d = Math.abs(oPose.yaw + off - myPose.yaw);
      if (d < bestDist) { bestDist = d; bestOPose = { yaw: oPose.yaw + off, pitch: oPose.pitch }; }
    }
    const oYawMin   = bestOPose.yaw   - oFov.h * 0.5;
    const oYawMax   = bestOPose.yaw   + oFov.h * 0.5;
    const oPitchMin = bestOPose.pitch - oFov.v * 0.5;
    const oPitchMax = bestOPose.pitch + oFov.v * 0.5;

    // Pitch overlap is required to count as a horizontal neighbor.
    const pitchOverlap = !(oPitchMax <= myPitchMin || oPitchMin >= myPitchMax);
    const yawOverlap   = !(oYawMax   <= myYawMin   || oYawMin   >= myYawMax);

    if (pitchOverlap) {
      // j to the left of me, and j extends INTO my left edge?
      if (bestOPose.yaw < myPose.yaw && oYawMax > myYawMin) {
        const overlap = oYawMax - myYawMin;
        if (overlap > left) left = overlap;
      }
      // j to the right of me?
      if (bestOPose.yaw > myPose.yaw && oYawMin < myYawMax) {
        const overlap = myYawMax - oYawMin;
        if (overlap > right) right = overlap;
      }
    }
    if (yawOverlap) {
      // j above me?
      if (bestOPose.pitch > myPose.pitch && oPitchMin < myPitchMax) {
        const overlap = myPitchMax - oPitchMin;
        if (overlap > top) top = overlap;
      }
      // j below me?
      if (bestOPose.pitch < myPose.pitch && oPitchMax > myPitchMin) {
        const overlap = oPitchMax - myPitchMin;
        if (overlap > bottom) bottom = overlap;
      }
    }
  }
  return { left, right, top, bottom };
}

/* Build an identity warp mesh whose intensity values ramp at the
 * overlapping edges. Non-overlapping vertices stay at intensity 1
 * (full brightness, no blend); overlap regions ramp linearly from 0
 * at the outer edge to 1 at the inner overlap boundary.
 *
 * The cooperating display's mirror ramp (computed by the same
 * algorithm) crosses the same overlap zone in the opposite direction,
 * so the sum of the two intensities at any point in the overlap is
 * 1 (linearly). Combined with the WGSL power curve (default 2) the
 * intensities sum to ≈1 in the overlap when both projectors fire,
 * which is what edge-blend depends on.
 *
 * Geometry stays identity (no warp) — auto-blend only generates
 * intensity ramps; geometric warp comes from MPCDI / hand-edited
 * meshes (6.6.2 / 6.6.9). _isAutoBlend tags the mesh so the rig
 * pane's pill cycle can recognize it. */
/* Phase 6.6.16 (Raskar #4) — project a 3D world point P back to a
 * specific display's framebuffer UV via gnomonic projection. Returns
 * { u, v, inFrame } where (u, v) ∈ [0, 1]² covers the display's full
 * framebuffer; inFrame is false when P is behind the projector or
 * outside its fov.
 *
 * Projector at rig origin facing pose direction. P transforms into
 * the display's local right/up/forward frame; localZ < 0 means
 * behind the projector (skip); the perspective divide gives NDC
 * within ±tan(fov/2). */
function _projectorFramebufferUV(P, display) {
  const pose = display.pose || { yaw: 0, pitch: 0 };
  const fov  = display.fov  || { h: 90, v: 60 };
  const yr = pose.yaw   * _DEG2RAD;
  const pr = pose.pitch * _DEG2RAD;
  const fx = Math.sin(yr) * Math.cos(pr);
  const fy = Math.sin(pr);
  const fz = Math.cos(yr) * Math.cos(pr);
  let altUpX = 0, altUpY = 1, altUpZ = 0;
  if (Math.abs(fy) > 0.95) { altUpX = 0; altUpY = 0; altUpZ = 1; }
  let rx = altUpY * fz - altUpZ * fy;
  let ry = altUpZ * fx - altUpX * fz;
  let rz = altUpX * fy - altUpY * fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  const localX = P[0] * rx + P[1] * ry + P[2] * rz;
  const localY = P[0] * ux + P[1] * uy + P[2] * uz;
  const localZ = P[0] * fx + P[1] * fy + P[2] * fz;
  if (localZ < 0.001) return { u: 0, v: 0, inFrame: false };

  const tanH = Math.tan(fov.h * 0.5 * _DEG2RAD);
  const tanV = Math.tan(fov.v * 0.5 * _DEG2RAD);
  const ndcX = localX / (localZ * tanH);
  const ndcY = localY / (localZ * tanV);
  const u = (ndcX + 1) * 0.5;
  const v = (ndcY + 1) * 0.5;
  return {
    u, v,
    inFrame: u >= 0 && u <= 1 && v >= 0 && v <= 1
  };
}

/* Phase 6.6.16 (Raskar §4.4) — screen-space alpha-blend mesh.
 * For each mesh vertex:
 *   1. Cast ray from origin through this display's framebuffer NDC.
 *   2. Hit the screen surface (sphere / cylinder) → 3D point P.
 *   3. For each display j (incl. self), project P back to j's
 *      framebuffer; compute d_j = min(u, v, 1-u, 1-v) — distance
 *      from the projector frame's edge — when P falls in j's frame.
 *   4. This vertex's intensity α = d_self / Σ_j d_j.
 *
 * Properties:
 *   • α sums to 1.0 across overlapping projectors at every screen
 *     point (Raskar §4.4 fundamental).
 *   • α → 0 at frame boundaries (smooth fade-out).
 *   • α = 1 in regions where only one projector covers (no overlap).
 *
 * vs. the angular-band approximation (_makeAutoBlendMesh): correct
 * for curved screens where neighbors don't share simple yaw/pitch
 * extents. Identical in the simple flat-tangent-plane case. */
function _makeScreenSpaceBlendMesh(cols, rows, display, displays, displayIdx, surface, hardCuts, existingMesh) {
  // 6.6.20.15 — preserve auto-warp NDC positions if an existing
  // warp mesh is passed in (and matches dimensions). Without this,
  // _applyAutoBlendToRig overwrote auto-warp's positions with
  // identity and the chain "auto-warp → auto-blend" effectively
  // discarded the warp step. Now both stack: positions from
  // auto-warp, alphas from auto-blend.
  let m;
  if (existingMesh && _validateWarpMesh(existingMesh) &&
      existingMesh.cols === cols && existingMesh.rows === rows) {
    m = _cloneWarpMesh(existingMesh);
    // Reset alphas to 1 — we'll recompute below.
    const W0 = cols + 1, H0 = rows + 1;
    for (let i = 0; i < W0 * H0; i++) m.verts[i * 5 + 4] = 1;
  } else {
    m = _makeIdentityWarpMesh(cols, rows);
  }
  if (!surface || surface.type === "free") return m;

  const W = cols + 1, H = rows + 1;
  const pose = display.pose || { yaw: 0, pitch: 0 };
  const fov  = display.fov  || { h: 90, v: 60 };

  const yr = pose.yaw   * _DEG2RAD;
  const pr = pose.pitch * _DEG2RAD;
  const fx = Math.sin(yr) * Math.cos(pr);
  const fy = Math.sin(pr);
  const fz = Math.cos(yr) * Math.cos(pr);
  let altUpX = 0, altUpY = 1, altUpZ = 0;
  if (Math.abs(fy) > 0.95) { altUpX = 0; altUpY = 0; altUpZ = 1; }
  let rx = altUpY * fz - altUpZ * fy;
  let ry = altUpZ * fx - altUpX * fz;
  let rz = altUpX * fy - altUpY * fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;
  const tanH = Math.tan(fov.h * 0.5 * _DEG2RAD);
  const tanV = Math.tan(fov.v * 0.5 * _DEG2RAD);

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      // 6.6.20.15 — use the vertex's CURRENT NDC (which may already
      // be auto-warped) instead of identity grid. Beam direction
      // and screen point P are then correct for whatever warp the
      // mesh already has applied.
      const off = (r * W + c) * 5;
      const ndcX = m.verts[off + 0];
      const ndcY = m.verts[off + 1];
      const lx = ndcX * tanH, ly = ndcY * tanV, lz = 1;
      const wx = rx*lx + ux*ly + fx*lz;
      const wy = ry*lx + uy*ly + fy*lz;
      const wz = rz*lx + uz*ly + fz*lz;

      let t = -1;
      if (surface.type === "sphere") {
        t = _raySphereDistance([0,0,0], [wx,wy,wz], surface.center || [0,0,0], surface.radius || 5);
      } else if (surface.type === "cylinder") {
        t = _rayCylinderDistanceY([0,0,0], [wx,wy,wz], surface.center || [0,0,0],
                                   surface.radius || 5, surface.length || 5);
      } else if (surface.type === "swept") {
        // 6.6.20 — generic surface of revolution. Profile-polyline
        // intersection in the yaw slice; t is the 3D distance.
        t = _raySweptSurfaceDistance([0,0,0], [wx,wy,wz], surface);
      } else {
        // Plane / free: treat as if only this projector covers
        // → identity intensity. Skip.
        continue;
      }
      if (t <= 0) continue;
      const Px = wx * t, Py = wy * t, Pz = wz * t;

      // Self-distance: derived from the vertex's own framebuffer UV
      // (the ray from origin we just cast came FROM this UV, so the
      // re-projection of P back to self is bit-exact this UV).
      const selfU = c / cols, selfV = r / rows;
      const dSelf = Math.max(0, Math.min(selfU, selfV, 1 - selfU, 1 - selfV));

      // 6.6.20.10 — hard-cuts mode now uses POWER-WEIGHTED soft-max
      // (k=8) instead of strict argmax. With k=8, alpha ≈ 1.0 inside
      // a projector's "won" region and ≈ 0.0 outside, but the
      // transition is smoothed across ~1 pixel of width. This
      // eliminates the X-shape Voronoi-edge artifacts that argmax
      // produced at corners where 4 projectors meet equidistant from
      // their frame edges (rasterizer aliasing of the diagonal
      // tiebreaker line was the visible cause).
      //
      // For k → ∞ this approaches argmax; k=8 is the sweet spot
      // empirically — clean cuts visually with no jaggies.
      const HARDCUT_POWER = 8;
      let dSum = dSelf;
      let powTotal = hardCuts ? Math.pow(Math.max(0.001, dSelf), HARDCUT_POWER) : 0;
      for (let j = 0; j < displays.length; j++) {
        if (j === displayIdx) continue;
        const dj = displays[j];
        if (!dj) continue;
        const proj = _projectorFramebufferUV([Px, Py, Pz], dj);
        if (!proj.inFrame) continue;
        const d = Math.max(0, Math.min(proj.u, proj.v, 1 - proj.u, 1 - proj.v));
        dSum += d;
        if (hardCuts) powTotal += Math.pow(Math.max(0.001, d), HARDCUT_POWER);
      }
      let alpha;
      if (hardCuts) {
        alpha = powTotal > 1e-9 ? Math.pow(Math.max(0.001, dSelf), HARDCUT_POWER) / powTotal : 1.0;
      } else {
        alpha = dSum > 0.0001 ? (dSelf / dSum) : 1.0;
      }
      m.verts[(r * W + c) * 5 + 4] = alpha;
    }
  }
  m._isAutoBlend = true;
  m._isScreenSpace = true;
  if (hardCuts) m._isHardCuts = true;
  return m;
}

function _makeAutoBlendMesh(cols, rows, display, displays, displayIdx) {
  const m = _makeIdentityWarpMesh(cols, rows);
  const fov = display.fov || { h: 90, v: 60 };
  const bands = _computeOverlapBands(displayIdx, displays);

  // Convert overlap band degrees → fractional U / V (normalized 0..1).
  const leftU   = bands.left   > 0 ? Math.min(0.5, bands.left   / fov.h) : 0;
  const rightU  = bands.right  > 0 ? Math.min(0.5, bands.right  / fov.h) : 0;
  const topV    = bands.top    > 0 ? Math.min(0.5, bands.top    / fov.v) : 0;
  const bottomV = bands.bottom > 0 ? Math.min(0.5, bands.bottom / fov.v) : 0;

  const W = cols + 1, H = rows + 1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      let intensity = 1;
      // Each ramp is linear from 0 at the outer edge to 1 at the inner
      // overlap boundary; outside the overlap region intensity stays at 1.
      // The min across all four sides handles corner overlaps gracefully
      // (a corner that overlaps both its left and top neighbor takes the
      // smaller intensity, which is correct for the symmetric blend).
      if (leftU   > 0 && u < leftU)        intensity = Math.min(intensity, u / leftU);
      if (rightU  > 0 && u > 1 - rightU)   intensity = Math.min(intensity, (1 - u) / rightU);
      if (topV    > 0 && v > 1 - topV)     intensity = Math.min(intensity, (1 - v) / topV);
      if (bottomV > 0 && v < bottomV)      intensity = Math.min(intensity, v / bottomV);
      m.verts[(r * W + c) * 5 + 4] = intensity;
    }
  }
  m._isAutoBlend = true;
  m._overlapBands = bands;     // surfaced in tooltips / diagnostics
  return m;
}

/* Apply auto-blend to every display in the rig that has at least
 * one overlapping neighbor. Displays in isolation (no overlap on
 * any side) get cleared — there's no neighbor for them to blend
 * with. Returns an array of { displayIdx, bands, applied } for the
 * caller's status reporting. */
/* ------------ Phase 6.6.15 — auto-warp from screen geometry ------------ */

/* Following Raskar et al. §3.3 (Camera-to-Projector Transfer): given a
 * known parametric screen surface + each projector's pose, compute
 * a per-vertex warp mesh that pre-distorts source content so the
 * audience at the sweet-spot sees a geometrically correct image.
 *
 * Math:
 *   For each mesh vertex (i, j):
 *     1. Compute projector ray from origin through framebuffer NDC,
 *        oriented by display.pose.
 *     2. Intersect with the screen surface → 3D point P.
 *     3. From sweet-spot S, compute audience direction = P - S.
 *     4. Convert audience direction to (yaw, pitch) angles → audience
 *        UV via equirect projection.
 *     5. Normalize into display.worldUv slice → mesh vertex's (mu, mv).
 *
 * For sphere-at-origin + sweet-spot-at-origin, this collapses to
 * identity (projector ray and audience ray coincide). Non-trivial
 * warp emerges when sweet-spot is offset from the projector position.
 *
 * Surface support:
 *   sphere   — full math (audience equirect from sweet-spot)
 *   cylinder — full math (cylindrical unwrap from axis)
 *   plane    — falls through to identity (perspective-from-origin
 *              already produces correct content for a flat screen
 *              when projector + sweet-spot are co-located, and the
 *              user can adjust if needed)
 *   free     — identity (no analytic geometry to invert)
 */
const _DEG2RAD = Math.PI / 180;
const _RAD2DEG = 180 / Math.PI;

function _raySphereDistance(O, D, center, radius) {
  const ox = O[0] - center[0], oy = O[1] - center[1], oz = O[2] - center[2];
  const a = D[0]*D[0] + D[1]*D[1] + D[2]*D[2];
  const b = 2 * (ox*D[0] + oy*D[1] + oz*D[2]);
  const c = ox*ox + oy*oy + oz*oz - radius*radius;
  const disc = b*b - 4*a*c;
  if (disc < 0) return -1;
  const sd = Math.sqrt(disc);
  const t1 = (-b - sd) / (2*a);
  const t2 = (-b + sd) / (2*a);
  // Want positive distance — for camera/projector inside the sphere
  // both roots are valid; outside, take the smaller positive.
  if (t1 > 0.001) return t1;
  if (t2 > 0.001) return t2;
  return -1;
}

function _rayCylinderDistanceY(O, D, center, radius, length) {
  // Cylinder axis assumed +Y for v1. Project ray onto XZ plane,
  // intersect with circle of radius `radius` centered at (center.x,
  // center.z). Then check that the hit's Y is within ±length/2 of
  // center.y.
  const ox = O[0] - center[0], oz = O[2] - center[2];
  const a = D[0]*D[0] + D[2]*D[2];
  if (a < 1e-9) return -1;        // ray parallel to axis — no XZ intersection
  const b = 2 * (ox*D[0] + oz*D[2]);
  const c = ox*ox + oz*oz - radius*radius;
  const disc = b*b - 4*a*c;
  if (disc < 0) return -1;
  const sd = Math.sqrt(disc);
  const t1 = (-b - sd) / (2*a);
  const t2 = (-b + sd) / (2*a);
  for (const t of [t1, t2]) {
    if (t > 0.001) {
      const py = O[1] + D[1] * t;
      if (Math.abs(py - center[1]) <= length * 0.5 + 0.001) return t;
    }
  }
  return -1;
}

/* Build a warp mesh for one display by ray-tracing each grid vertex
 * onto the screen surface, then projecting back from the sweet-spot
 * to find the audience-view UV. Returns identity mesh for free /
 * plane surfaces (no analytic inversion implemented). */
function _autoWarpMeshForDisplay(display, surface, sweetSpot, cols, rows) {
  cols = cols || 8;
  rows = rows || 8;
  const mesh = _makeIdentityWarpMesh(cols, rows);
  if (!surface || surface.type === "free" || surface.type === "plane") {
    // Plane case: when the screen is flat AND projector/sweet-spot
    // are co-located, perspective rendering is already correct.
    // Off-axis sweet-spots on a plane could be auto-warped but it's
    // rarely useful; user can hand-edit. Free has no analytic geometry.
    return mesh;
  }
  // sphere / cylinder / swept: full math below.

  const W = cols + 1, H = rows + 1;
  const pose = display.pose || { yaw: 0, pitch: 0, roll: 0 };
  const fov  = display.fov  || { h: 90, v: 60 };

  // Display's local-to-world basis (yaw + pitch only; roll skipped
  // for v1 — most templates leave it 0).
  const yr = pose.yaw   * _DEG2RAD;
  const pr = pose.pitch * _DEG2RAD;
  const fx = Math.sin(yr) * Math.cos(pr);
  const fy = Math.sin(pr);
  const fz = Math.cos(yr) * Math.cos(pr);
  // right = altUp × forward (matches the same convention used by
  // _theaterViewProjMatrix + _buildTheaterMeshGeometry, so the warp's
  // ray geometry stays consistent with what the gizmo + theater show).
  let altUpX = 0, altUpY = 1, altUpZ = 0;
  if (Math.abs(fy) > 0.95) { altUpX = 0; altUpY = 0; altUpZ = 1; }
  let rx = altUpY * fz - altUpZ * fy;
  let ry = altUpZ * fx - altUpX * fz;
  let rz = altUpX * fy - altUpY * fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  const tanH = Math.tan(fov.h * 0.5 * _DEG2RAD);
  const tanV = Math.tan(fov.v * 0.5 * _DEG2RAD);

  const slice = display.worldUv || { minU: 0, minV: 0, maxU: 1, maxV: 1 };
  const sliceW = Math.max(0.0001, slice.maxU - slice.minU);
  const sliceH = Math.max(0.0001, slice.maxV - slice.minV);

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      const ndcX = u * 2 - 1;
      const ndcY = v * 2 - 1;     // bottom-up per the Bourke convention

      // Local ray direction in display frame.
      const lx = ndcX * tanH;
      const ly = ndcY * tanV;
      const lz = 1;

      // Rotate to world frame.
      const wx = rx*lx + ux*ly + fx*lz;
      const wy = ry*lx + uy*ly + fy*lz;
      const wz = rz*lx + uz*ly + fz*lz;

      // Ray from rig origin through (wx, wy, wz). Intersect surface.
      let t = -1;
      if (surface.type === "sphere") {
        t = _raySphereDistance([0,0,0], [wx,wy,wz], surface.center || [0,0,0], surface.radius || 5);
      } else if (surface.type === "cylinder") {
        t = _rayCylinderDistanceY([0,0,0], [wx,wy,wz], surface.center || [0,0,0],
                                   surface.radius || 5, surface.length || 5);
      } else if (surface.type === "swept") {
        t = _raySweptSurfaceDistance([0,0,0], [wx,wy,wz], surface);
      }
      if (t <= 0) {
        // Ray missed the screen — keep identity mapping for this
        // vertex. Only happens at the edges of cylinder/cube cases.
        continue;
      }

      // Screen point P.
      const Px = wx * t, Py = wy * t, Pz = wz * t;
      // Audience direction from sweet-spot to P.
      const adx = Px - sweetSpot[0];
      const ady = Py - sweetSpot[1];
      const adz = Pz - sweetSpot[2];
      const adLen = Math.hypot(adx, ady, adz);
      if (adLen < 0.001) continue;
      const ax = adx / adLen, ay = ady / adLen, az = adz / adLen;

      // Audience yaw/pitch in degrees. Yaw=0 looks +Z; +X is yaw=+90.
      const audYawDeg   = Math.atan2(ax, az) * _RAD2DEG;
      const audPitchDeg = Math.asin(Math.max(-1, Math.min(1, ay))) * _RAD2DEG;

      // Equirect audience UV in rig master coords. yaw range
      // [-180, +180] → u [0, 1]. pitch [-90, +90] → v: mapping with
      // top-of-image = high pitch = audV near 0, so audV = (90 - pitch) / 180.
      const audU = (audYawDeg + 180) / 360;
      const audV = (90 - audPitchDeg) / 180;

      // Normalize into the display's worldUv slice.
      let mu = (audU - slice.minU) / sliceW;
      let mv = (audV - slice.minV) / sliceH;
      // Clamp tightly enough to remain inside [0, 1] so the warp
      // pipeline samples valid texels; with proper rig calibration
      // these should already be in range.
      if (mu < 0) mu = 0; else if (mu > 1) mu = 1;
      if (mv < 0) mv = 0; else if (mv > 1) mv = 1;

      const off = (r * W + c) * 5;
      mesh.verts[off + 0] = ndcX;
      mesh.verts[off + 1] = ndcY;
      mesh.verts[off + 2] = mu;
      mesh.verts[off + 3] = mv;
      mesh.verts[off + 4] = 1;
    }
  }
  mesh._isAutoWarp = true;
  return mesh;
}

/* Phase 6.6.20.16 — apply per-display keystone corner deltas to a
 * mesh, BILINEARLY blended across all vertices. Each corner shift
 * propagates through the mesh interior with weight (1-u)(1-v),
 * u(1-v), (1-u)v, uv per corner. The 4 corner verts get exactly
 * their proposed deltas; the center vert gets the average; mesh
 * stays smooth, no discontinuities.
 *
 * Called by _applyAutoWarpToRig + _applyAutoBlendToRig after they
 * generate a fresh mesh. Allows AI v3 to propose corner-level
 * keystone corrections that persist across iterations even though
 * the underlying mesh gets regenerated each auto-prep pass.
 *
 * NDC delta units: ±0.02 is typical (1% of framebuffer ≈ 5 px at
 * 1080p). Larger deltas warp aggressively. Per-pass clamp in the
 * iterative AI loop is ±0.02. */
/* Phase 6.6.20.17 — apply Bezier interior corrections (AI v4) on
 * top of the keystone layer. The bezierCorrections.ctrl array is
 * a (cols+1)×(rows+1)×2 grid of NDC offsets stored as deltas
 * (identity = all zeros). For each mesh vertex (u, v), evaluate
 * the tensor-product Bezier surface using these offsets as
 * control points, and shift the vertex by the result.
 *
 * Idempotent via mesh._hasBezierCorrections flag (preserved
 * through _cloneWarpMesh). Applied after keystone in both
 * auto-warp + auto-blend dispatchers so the chain is consistent.
 *
 * For sparse adjustments (most ctrl values 0, just a few non-zero),
 * the Bezier eval gracefully reduces to local bumps centered on
 * the non-zero control points, with smooth falloff to neighbors. */
function _applyBezierCorrectionsToMesh(mesh, bc) {
  if (!mesh || !_validateWarpMesh(mesh) || !bc) return;
  if (mesh._hasBezierCorrections) return;
  if (!Array.isArray(bc.ctrl) || !Number.isInteger(bc.cols) || !Number.isInteger(bc.rows)) return;
  // Skip cheap if all zeros.
  let sum = 0;
  for (let i = 0; i < bc.ctrl.length; i++) sum += Math.abs(bc.ctrl[i]);
  if (sum < 1e-6) return;
  const W = mesh.cols + 1, H = mesh.rows + 1;
  for (let r = 0; r < H; r++) {
    const v = r / mesh.rows;
    for (let c = 0; c < W; c++) {
      const u = c / mesh.cols;
      // _bezierEval interprets ctrl as positions; for delta ctrl
      // (identity = zero) it returns the bilinear-Bezier offset.
      const offset = _bezierEval(bc.ctrl, bc.cols, bc.rows, u, v);
      const i = (r * W + c) * 5;
      mesh.verts[i + 0] += offset.x;
      mesh.verts[i + 1] += offset.y;
    }
  }
}

function _applyKeystoneCornersToMesh(mesh, kc) {
  if (!mesh || !_validateWarpMesh(mesh) || !kc) return;
  if (mesh._hasKeystone) return;     // idempotent — already applied
  // Skip cheap if all zeros — most displays have no keystone applied.
  const sum = Math.abs(kc.tlx) + Math.abs(kc.tly) +
              Math.abs(kc.trx) + Math.abs(kc.try_) +
              Math.abs(kc.blx) + Math.abs(kc.bly) +
              Math.abs(kc.brx) + Math.abs(kc.bry);
  if (sum < 1e-6) return;
  const cols = mesh.cols, rows = mesh.rows;
  const W = cols + 1, H = rows + 1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      const wTL = (1 - u) * (1 - v);
      const wTR = u       * (1 - v);
      const wBL = (1 - u) * v;
      const wBR = u       * v;
      const dx = wTL * kc.tlx + wTR * kc.trx + wBL * kc.blx + wBR * kc.brx;
      const dy = wTL * kc.tly + wTR * kc.try_ + wBL * kc.bly + wBR * kc.bry;
      const i = (r * W + c) * 5;
      mesh.verts[i + 0] += dx;
      mesh.verts[i + 1] += dy;
    }
  }
}

/* Apply auto-warp across the rig. Skipped for "free"/"plane" surfaces
 * + when surfaceVisible is OFF (user told us this is a monitor rig,
 * not a curved screen). Custom (user-edited) meshes are preserved. */
function _applyAutoWarpToRig(opts) {
  if (!state.rig || !Array.isArray(state.rig.displays)) return [];
  const surface = state.rig.surface;
  if (!surface || !state.rig.surfaceVisible) {
    if (!opts || !opts.silent) {
      alert("Auto-warp needs a screen surface (Sphere or Cylinder) and Screen visibility ON in the rig pane.");
    }
    return [];
  }
  if (surface.type === "free" || surface.type === "plane") {
    if (!opts || !opts.silent) {
      alert("Auto-warp on " + surface.type + " surfaces collapses to identity (projector and sweet-spot are co-located on a flat / free-form screen). Use Sphere or Cylinder for analytic warp.");
    }
    return [];
  }
  const ss = state.rig.sweetSpot || [0, 0, 0];
  const out = [];
  if (!opts || !opts.skipHistory) pushHistory("rig-auto-warp");
  state.rig.displays.forEach((d, i) => {
    if (!d) return;
    if (d.warpMesh && d.warpMesh._isCustom) {
      out.push({ displayIdx: i, applied: false, skipped: "custom" });
      return;
    }
    // 6.6.20.15 — auto-warp default density is 128 (MESH_CAP) for
    // scientific-grade pixel-accuracy. Auto-blend below uses the
    // same density so the chain stays consistent. ~10s build time
    // for 26 displays at 128² — slow but worth it for the
    // pixel-accurate boundary alignment scientific work needs.
    const WARP_MESH_DENSITY = 128;
    const mesh = _autoWarpMeshForDisplay(d, surface, ss, WARP_MESH_DENSITY, WARP_MESH_DENSITY);
    // Phase 6.6.20.16 — apply keystone corner deltas (AI v3) so they
    // persist through this regeneration. Idempotent: marks the mesh
    // _hasKeystone after applying so downstream auto-blend doesn't
    // double-apply.
    _applyKeystoneCornersToMesh(mesh, d.keystoneCorners);
    mesh._hasKeystone = true;
    // 6.6.20.17 — Bezier interior corrections (AI v4) layer on top.
    _applyBezierCorrectionsToMesh(mesh, d.bezierCorrections);
    mesh._hasBezierCorrections = true;
    d.warpMesh = mesh;
    if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
    out.push({ displayIdx: i, applied: true });
  });
  if (state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
    state.rig.templateKey = "custom";
  }
  return out;
}

function _applyAutoBlendToRig(opts) {
  if (!state.rig || !Array.isArray(state.rig.displays)) return [];
  const out = [];
  // Optional: skipHistory (called from applyRigTemplate which already
  // pushed its own history entry); keepTemplate (don't flip to
  // "custom" — the template ITSELF is what triggered this, so the
  // dropdown should still show it).
  const skipHistory  = !!(opts && opts.skipHistory);
  const keepTemplate = !!(opts && opts.keepTemplate);
  const hardCuts     = !!(opts && opts.hardCuts);
  if (!skipHistory) pushHistory(hardCuts ? "rig-auto-blend-hardcuts" : "rig-auto-blend");
  // Phase 6.6.16 (Raskar #4) — choose between angular auto-blend
  // (the original, fast, works without surface info) and screen-
  // space alpha-blend (the Raskar-paper-correct version that uses
  // the actual screen surface). Screen-space wins when:
  //   • The rig has a parametric surface (sphere or cylinder)
  //   • surfaceVisible is ON (user hasn't told us this is monitors)
  // Otherwise fall back to angular bands.
  const surface = state.rig.surface;
  const useScreenSpace = !!(surface && state.rig.surfaceVisible &&
                            (surface.type === "sphere" || surface.type === "cylinder" || surface.type === "swept"));

  state.rig.displays.forEach((d, i) => {
    if (!d) return;
    // Phase 6.6.9 — custom (user-edited) meshes are sacred; auto-
    // blend leaves them alone. Otherwise a re-run after editing
    // would silently undo the user's hand-tuning.
    if (d.warpMesh && d.warpMesh._isCustom) {
      out.push({ displayIdx: i, applied: false, skipped: "custom" });
      return;
    }
    if (useScreenSpace) {
      // 6.6.20.15 — default density is 128 (the MESH_CAP) for
      // scientific-grade pixel-accurate boundaries. Compute scales
      // O(N² × num_displays_for_blend_check); at 128² × 26 displays
      // a single click takes ~5-10s. For faster interactive use,
      // drop this to 64 (5x faster, ~3x more accurate than the
      // pre-6.6.20.14 default of 32).
      //
      // 6.6.20.15 — also preserves existing auto-warp positions
      // when chaining (auto-prep does auto-warp → auto-blend, and
      // we want to keep the warp positions from step 1).
      const BLEND_MESH_DENSITY = 128;
      const existingWarp = (d.warpMesh && d.warpMesh._isAutoWarp &&
                            d.warpMesh.cols === BLEND_MESH_DENSITY &&
                            d.warpMesh.rows === BLEND_MESH_DENSITY) ? d.warpMesh : null;
      const mesh = _makeScreenSpaceBlendMesh(BLEND_MESH_DENSITY, BLEND_MESH_DENSITY,
        d, state.rig.displays, i, surface, hardCuts, existingWarp);
      // Phase 6.6.20.16 — keystone corners. _applyKeystoneCornersToMesh
      // is no-op when mesh._hasKeystone is true (auto-warp already
      // applied), so chained warp→blend doesn't double-apply.
      _applyKeystoneCornersToMesh(mesh, d.keystoneCorners);
      mesh._hasKeystone = true;
      // 6.6.20.17 — Bezier interior corrections (AI v4) on top.
      _applyBezierCorrectionsToMesh(mesh, d.bezierCorrections);
      mesh._hasBezierCorrections = true;
      d.warpMesh = mesh;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      out.push({ displayIdx: i, applied: true, mode: hardCuts ? "screen-space-hardcuts" : "screen-space" });
      return;
    }
    const bands = _computeOverlapBands(i, state.rig.displays);
    const overlapping = bands.left + bands.right + bands.top + bands.bottom;
    if (overlapping > 0.001) {
      d.warpMesh = _makeAutoBlendMesh(8, 8, d, state.rig.displays, i);
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      out.push({ displayIdx: i, bands, applied: true, mode: "angular" });
    } else {
      // No overlap → no blend ramp needed. Leave any existing mesh
      // alone (user might have a hand-edited geometric warp on this
      // display); only clear if it was previously auto-blend.
      if (d.warpMesh && d.warpMesh._isAutoBlend) {
        d.warpMesh = null;
        if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      }
      out.push({ displayIdx: i, bands, applied: false });
    }
  });
  if (!keepTemplate && state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
    state.rig.templateKey = "custom";
  }
  return out;
}

/* Quick validation for warpMesh objects loaded from .gpatch. Returns
 * true if the mesh has the expected shape and a vert array of the
 * correct length. Used in migrateDisplayShape to drop garbage meshes
 * silently — better to fall back to no-warp than render glitched
 * output from a malformed mesh. */
function _validateWarpMesh(m) {
  if (!m || typeof m !== "object") return false;
  if (!Number.isInteger(m.cols) || m.cols < 1) return false;
  if (!Number.isInteger(m.rows) || m.rows < 1) return false;
  if (!Array.isArray(m.verts))                 return false;
  const expected = (m.cols + 1) * (m.rows + 1) * 5;
  if (m.verts.length !== expected) return false;
  for (let i = 0; i < m.verts.length; i++) {
    if (!Number.isFinite(m.verts[i])) return false;
  }
  return true;
}

/* Edge-blend parameter defaults. These are the values applied by the
 * blend WGSL pass (Phase 6.6.5–6.6.8). Gamma 2.2 matches the standard
 * sRGB → linear gamma — applying it before blending and reversing
 * after gives perceptually-uniform brightness across the overlap.
 * blackLift and power start at "no perceptual effect" so a default-
 * configured rig that hasn't been hand-tuned simply renders the
 * identity blend. */
function _defaultEdgeBlend() {
  return { gamma: 2.2, blackLift: 0, power: 2.0 };
}

/* Validate edge-blend params loaded from .gpatch. Numbers must be
 * finite; gamma > 0 (avoid divide-by-zero); blackLift in [0, 1];
 * power > 0. Returns a clean object with any invalid fields replaced
 * by defaults. */
function _migrateEdgeBlend(eb) {
  const def = _defaultEdgeBlend();
  if (!eb || typeof eb !== "object") return def;
  const out = {
    gamma:     Number.isFinite(eb.gamma)     && eb.gamma     > 0 ? eb.gamma     : def.gamma,
    blackLift: Number.isFinite(eb.blackLift) && eb.blackLift >= 0 && eb.blackLift <= 1 ? eb.blackLift : def.blackLift,
    power:     Number.isFinite(eb.power)     && eb.power     > 0 ? eb.power     : def.power
  };
  return out;
}

function _makeDisplay(id, name, overrides) {
  return Object.assign({
    id,
    name,
    pose:      { yaw: 0, pitch: 0, roll: 0 },
    fov:       { h: 90, v: 60 },
    aspect:    16 / 9,
    curvature: 0,
    // Phase 6.6 — calibration warp + edge blend. null = no warp,
    // fullscreen-triangle pipeline. Becomes a Bourke mesh once the
    // user runs the warp editor (6.6.9) or imports MPCDI (6.6.2).
    warpMesh:  null,
    edgeBlend: _defaultEdgeBlend(),
    // Phase 6.6.20.16 — AI v3 keystone corner offsets. 8 floats in
    // NDC space (~ ±2 unit framebuffer). Applied AFTER auto-warp +
    // auto-blend as a bilinear shift across the mesh, so they
    // persist across auto-prep regenerations. Default 0; AI v3
    // proposes deltas during iterative calibration.
    keystoneCorners: { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 },
    // Phase 6.6.20.17 — AI v4 Bezier interior corrections. 5×5
    // grid of NDC offsets (50 floats) — mostly 0, populated
    // sparsely by Bezier fine-tune. Applied AFTER keystone via
    // tensor-product Bezier eval — each control point's offset
    // smoothly blends into the mesh interior. Default null; lazy-
    // inits when first non-zero adjustment applied.
    bezierCorrections: null,
    worldUv:   { minU: 0, minV: 0, maxU: 1, maxV: 1 }
  }, overrides);
}

/* Catalog of rig templates. Each builds a display list from a single
 * key. The math for cylindrical / spherical layouts:
 *   - Cylindrical: yaws spaced evenly around the azimuth covered by
 *     the rig (90° for quarter, 180° for half, 360° for full). Each
 *     display's worldUv.u range is its azimuth slice / total
 *     azimuth. v range is full [0,1].
 *   - Cube: 6 displays each looking down a cardinal axis (front /
 *     back / left / right / up / down). worldUv slices a cubemap
 *     unfold into 6 rectangles.
 *   - AlloSphere-like: 16 displays in a partial sphere matching the
 *     practical AlloSphere coverage (~360° H × ~150° V on a bisected
 *     sphere). worldUv slices an equirect master into 16 rects in a
 *     4-cols × 4-rows arrangement that approximates the dome's
 *     projector layout. Real AlloSphere has 26 projectors; 16 is
 *     the "consumer-class" approximation per docs/DISTRIBUTED-RIG.md
 *     §9.3. */
const RIG_TEMPLATES = {
  single: {
    label: "Single (1 display)",
    surface: { type: "plane", normal: [0, 0, 1], offset: 5 },
    build: () => [_makeDisplay("d0", "Display 1", {
      pose: { yaw: 0, pitch: 0, roll: 0 },
      fov:  { h: 90, v: 60 },
      worldUv: { minU: 0, minV: 0, maxU: 1, maxV: 1 }
    })]
  },
  "side-by-side": {
    label: "Side-by-side (2 flat)",
    surface: { type: "plane", normal: [0, 0, 1], offset: 5 },
    build: () => [
      _makeDisplay("d0", "Left", {
        pose: { yaw: -45, pitch: 0, roll: 0 },
        fov:  { h: 90, v: 60 },
        worldUv: { minU: 0,   minV: 0, maxU: 0.5, maxV: 1 }
      }),
      _makeDisplay("d1", "Right", {
        pose: { yaw:  45, pitch: 0, roll: 0 },
        fov:  { h: 90, v: 60 },
        worldUv: { minU: 0.5, minV: 0, maxU: 1,   maxV: 1 }
      })
    ]
  },
  "quarter-wrap": {
    label: "Quarter-wrap (4 flat, 90°)",
    surface: { type: "cylinder", radius: 5, axis: [0, 1, 0], length: 5, center: [0, 0, 0] },
    build: () => _evenAzimuthRing(4, 90, "Q")
  },
  "half-wrap": {
    label: "Half-wrap (8 flat, 180°)",
    surface: { type: "cylinder", radius: 5, axis: [0, 1, 0], length: 5, center: [0, 0, 0] },
    build: () => _evenAzimuthRing(8, 180, "H")
  },
  "full-wrap-16": {
    label: "Full-wrap (16 flat, 360°)",
    surface: { type: "cylinder", radius: 5, axis: [0, 1, 0], length: 5, center: [0, 0, 0] },
    build: () => _evenAzimuthRing(16, 360, "F")
  },
  cube: {
    label: "Cube (6 faces)",
    // Cube isn't a quadric — surface is a 6-faced polyhedron, marked
    // "free" so auto-warp falls back to identity. Sweet-spot defaults
    // to origin (cube center).
    surface: { type: "free" },
    build: () => {
      const pose = (yaw, pitch) => ({ yaw, pitch, roll: 0 });
      // Standard cubemap unfold: 4 sides + top + bottom in a 4×3 layout
      // but compressed into a 1×6 row in the master canvas for
      // simplicity. Each face is 1/6th of the master width.
      const f = 1 / 6;
      const fov = { h: 90, v: 90 };
      return [
        _makeDisplay("front",  "+Z front",  { pose: pose(0,    0),  fov, worldUv: { minU: 0*f, minV: 0, maxU: 1*f, maxV: 1 } }),
        _makeDisplay("right",  "+X right",  { pose: pose(90,   0),  fov, worldUv: { minU: 1*f, minV: 0, maxU: 2*f, maxV: 1 } }),
        _makeDisplay("back",   "-Z back",   { pose: pose(180,  0),  fov, worldUv: { minU: 2*f, minV: 0, maxU: 3*f, maxV: 1 } }),
        _makeDisplay("left",   "-X left",   { pose: pose(-90,  0),  fov, worldUv: { minU: 3*f, minV: 0, maxU: 4*f, maxV: 1 } }),
        _makeDisplay("top",    "+Y top",    { pose: pose(0,   90),  fov, worldUv: { minU: 4*f, minV: 0, maxU: 5*f, maxV: 1 } }),
        _makeDisplay("bottom", "-Y bottom", { pose: pose(0,  -90),  fov, worldUv: { minU: 5*f, minV: 0, maxU: 6*f, maxV: 1 } })
      ];
    }
  },
  "allosphere-like": {
    label: "AlloSphere-like (16 partial sphere)",
    surface: { type: "sphere", radius: 5, center: [0, 0, 0] },
    build: () => {
      // 4 columns × 4 rows on a partial sphere. Vertical FOV ≈ 150°
      // (bisected sphere), horizontal 360°. Each cell is one display.
      // worldUv tiles the equirect master into a 4×4 grid.
      const cols = 4, rows = 4;
      const out = [];
      const cellW = 1 / cols;
      const cellH = 1 / rows;
      const azimuthStep   = 360 / cols;
      const elevationStep = 150 / rows;   // partial sphere: 150° vertical
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const yaw   = -180 + (c + 0.5) * azimuthStep;        // span -180..180
          const pitch =  -75 + (r + 0.5) * elevationStep;      // span -75..75
          out.push(_makeDisplay("a" + idx, "Allo-" + (idx + 1), {
            pose: { yaw, pitch, roll: 0 },
            fov:  { h: azimuthStep, v: elevationStep },
            curvature: 22,   // soft curve, ≈ projector throw aperture
            worldUv: {
              minU: c * cellW, minV: r * cellH,
              maxU: (c + 1) * cellW, maxV: (r + 1) * cellH
            }
          }));
        }
      }
      return out;
    }
  },
  "allosphere-real": {
    label: "AlloSphere (real 26-projector layout)",
    surface: { type: "sphere", radius: 5, center: [0, 0, 0] },
    build: () => {
      // The real UCSB AlloSphere has 26 projectors arranged
      // asymmetrically across two listening hemispheres separated by
      // a catwalk seam at the equator. Ring counts approximate the
      // published "14 upper / 12 lower" channel split: more density
      // near the catwalk (where projector mounts have line-of-sight)
      // and sparser near the poles (which need wider-FOV optics).
      //
      // Rings (top → bottom):
      //   +60°: 5 projectors  ┐
      //   +20°: 9 projectors  ┘ 14 upper hemisphere
      //   ---  catwalk gap (no projectors near 0°)  ---
      //   -20°: 8 projectors  ┐
      //   -60°: 4 projectors  ┘ 12 lower hemisphere
      //
      // FOVs are sized to overlap slightly within each ring (azimuth
      // step + ~10% bleed) and to bridge between rings (~50° vertical
      // FOV per projector). worldUv tiles the equirect master in a
      // ring-by-ring band layout: top band 0..1/4 V, mid-top 1/4..2/4,
      // mid-bot 2/4..3/4, bottom 3/4..1.
      const rings = [
        { pitch:  60, count: 5, vBand: [0,    0.22] },
        { pitch:  20, count: 9, vBand: [0.22, 0.50] },
        { pitch: -20, count: 8, vBand: [0.50, 0.78] },
        { pitch: -60, count: 4, vBand: [0.78, 1.00] }
      ];
      const out = [];
      let idx = 0;
      for (const ring of rings) {
        const fovH = (360 / ring.count) * 1.10;     // 10% azimuth bleed
        const fovV = 50;
        const cellU = 1 / ring.count;
        for (let i = 0; i < ring.count; i++) {
          const yaw = -180 + (i + 0.5) * (360 / ring.count);
          out.push(_makeDisplay("ar" + idx, "Allo-" + (idx + 1), {
            pose: { yaw, pitch: ring.pitch, roll: 0 },
            fov:  { h: fovH, v: fovV },
            curvature: 30,   // sphere screen curve, dome-projection style
            worldUv: {
              minU:  i      * cellU, minV: ring.vBand[0],
              maxU: (i + 1) * cellU, maxV: ring.vBand[1]
            }
          }));
          idx++;
        }
      }
      return out;
    }
  }
};

/* Helper for cylindrical-wrap templates: N displays evenly spaced
 * across a horizontal arc of `azimuthDeg` total. Each display gets an
 * equal slice of worldUv along U. */
function _evenAzimuthRing(n, azimuthDeg, prefix) {
  const out = [];
  const fovH = azimuthDeg / n;
  const start = -azimuthDeg / 2;
  for (let i = 0; i < n; i++) {
    const yaw = start + (i + 0.5) * fovH;
    out.push(_makeDisplay(prefix + i, prefix + (i + 1), {
      pose: { yaw, pitch: 0, roll: 0 },
      fov:  { h: fovH, v: 60 },
      worldUv: {
        minU: i / n,       minV: 0,
        maxU: (i + 1) / n, maxV: 1
      }
    }));
  }
  return out;
}

/* Replace the rig's display list with the catalog template's output.
 * Preserves rig-level settings (masterRes, previewMode) so the user's
 * choice of resolution + projection survives a template swap. */
function applyRigTemplate(key) {
  const t = RIG_TEMPLATES[key];
  if (!t) return;
  pushHistory("rig-template:" + key);
  if (!state.rig) state.rig = defaultRig();
  state.rig.templateKey = key;
  state.rig.displays    = t.build();
  // Phase 6.6.14 — propagate the template's screen-surface descriptor
  // and re-derive the sweet-spot. Templates without an explicit surface
  // get a "free" default so auto-warp falls through to identity. The
  // sweet-spot is freshly derived because the user picking a new
  // template implies they want the canonical viewing position for
  // that geometry; if they tweak it after, their override persists
  // until the next template change.
  state.rig.surface   = _migrateRigSurface(t.surface || { type: "free" });
  state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface);
  // Reset the theater camera to the new sweet-spot so the next
  // entry to theater preview spawns the user at the canonical
  // viewing position. Yaw/pitch keep their last orientation —
  // changing positions but staying "facing" the same way is less
  // disorienting than a full reset.
  if (Visual && Visual.theaterCam) {
    Visual.theaterCam.pos[0] = state.rig.sweetSpot[0];
    Visual.theaterCam.pos[1] = state.rig.sweetSpot[1];
    Visual.theaterCam.pos[2] = state.rig.sweetSpot[2];
  }
  // Validate that any VisualOutput nodes still point at a valid
  // display index. Anything pointing past the new display count gets
  // clamped to the last available display.
  const max = state.rig.displays.length - 1;
  state.nodes.forEach(n => {
    if (n.type === "VisualOutput" && n.params && typeof n.params.display === "number") {
      if (n.params.display > max) n.params.display = max;
    }
  });
  // Phase 6.6.11 — auto-apply blend on template change. Templates
  // with overlapping pose footprints (allosphere-real with its 10%
  // azimuth bleed) get intensity ramps for free; templates without
  // overlap (single, side-by-side, quarter-wrap, etc.) skip silently
  // since _applyAutoBlendToRig no-ops on isolated displays. Saves a
  // click in the AlloSphere case, never penalizes the others.
  // skipHistory: outer pushHistory is the single undo entry for the
  // whole template+blend bundle.
  // keepTemplate: this IS the template apply path — don't flip to
  // "custom" since the dropdown still reflects the picked template.
  _applyAutoBlendToRig({ skipHistory: true, keepTemplate: true });
  // Phase 6.5.5 — display count changed → reallocate the texture array
  // + rebuild bind groups so subsequent renders target the new layer
  // count. Skips silently if the GPU device hasn't acquired yet
  // (ensureGPUDevice will run the alloc when it does).
  if (Visual.device) {
    _allocateFramebuffer();
    _rebuildBlitBindGroup();
    _rebuildRigCompositeBindGroup();
    _rebuildWarpBindGroup();
    _rebuildTheaterBindGroup();
  }
  render();
  renderProps && renderProps();
}

/* Group helpers — kept tiny and pure so the rest of the editor
 * doesn't need to learn about groups except where it matters
 * (render, wire routing, selection, save). */
function groupOfNode(nodeId) {
  if (!state.groups) return null;
  return state.groups.find(g => g.members && g.members.includes(nodeId)) || null;
}
function groupById(groupId) {
  return state.groups && state.groups.find(g => g.id === groupId) || null;
}
function isInCollapsedGroup(nodeId) {
  const g = groupOfNode(nodeId);
  return !!(g && g.collapsed);
}
/* Bounding rect of a group's member nodes in world coords. Returns
 * null if the group has no members. NODE_W is fixed; for height we
 * over-estimate from row count since exact height depends on DOM
 * measurement that isn't available pre-render. */
function groupBounds(group) {
  if (!group || !group.members || !group.members.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  group.members.forEach(id => {
    const n = nodeById(id);
    if (!n) return;
    const def = defOf(n);
    const rows = def ? Math.max(def.ins.length, def.outs.length, 1) : 2;
    const h = 28 + 6 + rows * 22 + 6;   // head + padding + rows
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + h);
  });
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
/* Group stubs: every port on a member node that ISN'T fully wired
 * inside the group becomes a stub on the collapsed block. Two cases
 * collapse to the same rule:
 *   • Cross-boundary edge — the port already has an external
 *     connection; the stub mirrors that wire so it stays visible
 *     when the group is collapsed.
 *   • Unconnected source / sink — the port has zero connections,
 *     i.e. it's at the "beginning of a chain" (input on a node no
 *     internal node feeds) or "end of a chain" (output on a node
 *     no internal node consumes). Surfacing these lets the user
 *     wire to/from the group post-hoc — drop the group, then wire
 *     its dangling endpoints to the rest of the patch.
 * Equivalent rule: a port is "internal-only" (HIDDEN on the
 * collapsed block) only when every one of its edges goes to other
 * members. Anything else exposes. */
function computeGroupPorts(group) {
  const set = new Set(group.members);
  const inputs = [], outputs = [];
  (group.members || []).forEach(memberId => {
    const node = nodeById(memberId);
    if (!node) return;
    const def = defOf(node);
    if (!def) return;
    // Input ports — expose if no incoming edge OR at least one
    // incoming edge originates outside the group.
    (def.ins || []).forEach(p => {
      const incoming = state.edges.filter(e => e.to.node === memberId && e.to.port === p.n);
      const exposed = incoming.length === 0 || incoming.some(e => !set.has(e.from.node));
      if (exposed) inputs.push({ innerNode: memberId, innerPort: p.n, t: p.t || "audio" });
    });
    // Output ports — same rule, mirrored.
    (def.outs || []).forEach(p => {
      const outgoing = state.edges.filter(e => e.from.node === memberId && e.from.port === p.n);
      const exposed = outgoing.length === 0 || outgoing.some(e => !set.has(e.to.node));
      if (exposed) outputs.push({ innerNode: memberId, innerPort: p.n, t: p.t || "audio" });
    });
  });
  return { inputs, outputs };
}

function reset() {
  _cleanupBeforePatchSwitch();
  state = freshState();
  clearSelection();
  nextId = 1;
  undoStack.length = 0;
  redoStack.length = 0;
  // Demo: KeyboardIn drives BOTH freq AND gate. Pressing any key
  // sends a one-sample pulse on KeyboardIn.gate which fires AD.reset
  // via the Schmitt-trigger codegen (see prepareSample, gate-input
  // branch). Two on-screen Sliders in the Monitor tab drive the
  // BiquadLP cutoff + Q in real time so users can dial the filter
  // while playing notes. No need to expose AD.trig — the wire
  // drives it.
  const k  = makeNode("KeyboardIn", 40,  60);
  const a  = makeNode("Sine",      220,  60, { freq: 220 });
  const b  = makeNode("AD",        220, 230, { attack: 0.01, decay: 0.6 });
  const sc = makeNode("Slider",     40, 380, { value: 1200, min: 80, max: 12000 });
  const sq = makeNode("Slider",    220, 380, { value: 1.4,  min: 0.5, max: 10 });
  const c  = makeNode("Mul",       400, 130);
  const d  = makeNode("BiquadLP",  580, 110, { cutoff: 1200, q: 1.4 });
  const e  = makeNode("Output",    760, 130);
  state.edges.push({ from: { node: k,  port: "freq" }, to: { node: a, port: "freq" } });
  state.edges.push({ from: { node: k,  port: "gate" }, to: { node: b, port: "trig" } });
  state.edges.push({ from: { node: a,  port: "out"  }, to: { node: c, port: "a" } });
  state.edges.push({ from: { node: b,  port: "out"  }, to: { node: c, port: "b" } });
  state.edges.push({ from: { node: c,  port: "out"  }, to: { node: d, port: "in" } });
  state.edges.push({ from: { node: sc, port: "out"  }, to: { node: d, port: "cutoff" } });
  state.edges.push({ from: { node: sq, port: "out"  }, to: { node: d, port: "q" } });
  state.edges.push({ from: { node: d,  port: "out"  }, to: { node: e, port: "L" } });
}

function makeNode(type, x, y, params) {
  const def = TYPES[type];
  if (!def) { console.warn("unknown type", type); return null; }
  const id = uid();
  const p = Object.assign({}, def.params || {}, params || {});
  // Phase 6.5 — auto-assign display index for new VisualOutput nodes.
  // Walk the rig's display list and pick the LOWEST unused index. Lets
  // a user drop a 2nd VisualOutput on a "Side-by-side" rig and have it
  // automatically land on the right display, no manual dropdown step.
  // Caller can override by passing params.display explicitly. If all
  // displays are already taken, fall back to 0 (duplicate); user gets
  // a chance to fix via the props-pane dropdown.
  if (type === "VisualOutput" && (!params || params.display === undefined)) {
    const displays = (state.rig && state.rig.displays) || [];
    if (displays.length > 0) {
      const used = new Set(state.nodes
        .filter(n => n.type === "VisualOutput" && n.params && typeof n.params.display === "number")
        .map(n => n.params.display | 0));
      let pick = -1;
      for (let i = 0; i < displays.length; i++) {
        if (!used.has(i)) { pick = i; break; }
      }
      p.display = pick >= 0 ? pick : 0;   // fallback when all are taken
    }
  }
  state.nodes.push({ id, type, x, y, params: p });
  // For nodes that declare autoExpose (e.g. KeyboardIn), seed
  // state.exposed so the props-panel checkbox shows the truth and
  // saved .gpatch files round-trip correctly.
  if (def.autoExpose) {
    def.autoExpose.forEach(k => { state.exposed[id + "." + k] = true; });
  }
  return id;
}

reset();

/* =========================================================================
 * DOM refs
 * ======================================================================== */
const palette  = document.getElementById("palette");
const search   = document.getElementById("search");
const canvas   = document.getElementById("canvas");
const wireSvg  = document.getElementById("wires");
const stats    = document.getElementById("stats");
const filenameEl = document.getElementById("filename");
const deleteBtn = document.getElementById("btn-delete");
const codeOut  = document.getElementById("code-out");
const jsonOut  = document.getElementById("json-out");
const propsEl  = document.getElementById("props");
const empty    = document.getElementById("empty");
const paneProps = document.getElementById("pane-props");
const paneCode  = document.getElementById("pane-code");
const paneJson  = document.getElementById("pane-json");
const paneUdsp  = document.getElementById("pane-udsp");
const udspList  = document.getElementById("udsp-list");
const udspSource = document.getElementById("udsp-source");
const udspStatus = document.getElementById("udsp-status");
const tabs     = document.querySelectorAll(".tab");
const copyBtn  = document.getElementById("btn-copy");
const canvasWorld = document.getElementById("canvas-world");
const marqueeEl = document.getElementById("marquee");
const viewHud  = document.getElementById("view-hud");

// CodeMirror-backed User DSP editor. Initialized after the deferred
// CM scripts load (DOMContentLoaded). Falls back to the bare textarea
// if CodeMirror fails to load (offline, CDN blocked, etc.). All
// reads/writes of the DSP source MUST go through getUdspText /
// setUdspText so both backends stay in sync.
let udspEditor = null;
function getUdspText() {
  return udspEditor ? udspEditor.getValue() : udspSource.value;
}
function setUdspText(s) {
  if (udspEditor) udspEditor.setValue(s);
  else udspSource.value = s;
}
document.addEventListener("DOMContentLoaded", () => {
  if (typeof CodeMirror === "undefined" || !udspSource) return;
  try {
    udspEditor = CodeMirror.fromTextArea(udspSource, {
      mode: "text/x-c++src",
      theme: "material-darker",
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 2,
      smartIndent: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      lineWrapping: false,
      extraKeys: {
        Tab:           cm => cm.execCommand("indentMore"),
        "Shift-Tab":   cm => cm.execCommand("indentLess"),
        "Cmd-/":       "toggleComment",
        "Ctrl-/":      "toggleComment"
      }
    });
    udspEditor.setSize("100%", "100%");
    // Keep the underlying <textarea> in sync so anything still reading
    // .value (legacy code paths, AI provider, etc.) sees current text.
    udspEditor.on("change", () => { udspSource.value = udspEditor.getValue(); });
  } catch (e) {
    console.warn("CodeMirror init failed; using textarea fallback.", e);
  }
});

applyView();

/* =========================================================================
 * Palette: search-filterable, collapsible categories
 * ======================================================================== */
/* =========================================================================
 * Browser — node + asset library
 *
 * Replaces the original simple palette with a tabbed browser:
 *   • Nodes  — registry entries with auto-derived tag chips, vertical
 *              category rail, operator-syntax search (cat:/tag:/port:),
 *              detail drawer with description + ports + related links.
 *   • Assets — IDB-backed sample store + connection rail for cloud
 *              sources (Local FS, Google Drive, GitHub). For now the
 *              IDB-stored audio assets always show; the cloud sources
 *              ship as a UI shell, with Local FS using the File System
 *              Access API and Drive/GitHub stubbed out for v0.1.
 *
 * The legacy renderPalette(filterText) export is kept for back-compat
 * (it's called from a handful of places after addFromPalette + after
 * gdsp registers a new user node). It now delegates to the new render
 * pipeline.
 * ======================================================================== */

/* Tag derivation. Pulled from the def shape so we don't have to add
 * tag annotations to every TYPES entry manually:
 *   • gamma     — wraps a stock gam:: class OR a pure template
 *   • composite — uses a custom helper class (cppType set, not gam::)
 *   • multi-out — outs.length > 1
 *   • host      — kind === "micInput" / "host" / "keyboard" or uses
 *                 the editor's drawable-curve param (Ramp / Slider /
 *                 Button) or has zero audio inputs (live source nodes)
 *   • user-dsp  — registered through the .gdsp parser
 *   • draw      — has a drawable curve / pattern editor modal */
const _BR_HOST_NODES = new Set([
  "KeyboardIn","Button","Slider","Ramp","MicInput","PianoRoll","MultiPianoRoll",
]);
const _BR_DRAW_NODES = new Set([
  "Ramp","Slider","Button","WavetableScan","WavetableOsc","PianoRoll","MultiPianoRoll",
]);
function brDeriveTags(name, def) {
  const tags = [];
  if (def.isUserDsp) tags.push("user-dsp");
  else if ((def.cppType || "").startsWith("gam::") || (def.cppType === "" && def.template)) tags.push("gamma");
  else if (def.cppType) tags.push("composite");
  if (def.outs && def.outs.length > 1) tags.push("multi-out");
  if (_BR_HOST_NODES.has(name) || def.kind === "micInput" || def.kind === "host") tags.push("host");
  if (_BR_DRAW_NODES.has(name)) tags.push("draw");
  if (def.category === "Sink") tags.push("sink");
  return tags;
}

/* Per-category metadata for the rail. Reference numbers + tag lines
 * are display-only; the node category strings come straight from the
 * registry data. Categories not listed here still render — they just
 * get a generic "ext" tag and a placeholder reference. */
const _BR_CAT_META = {
  Oscillator: { ref: "01", tag: "wave generators" },
  Sample:     { ref: "02", tag: "playback · mic · asset" },
  Noise:      { ref: "03", tag: "stochastic" },
  Envelope:   { ref: "04", tag: "shaping · gates" },
  Filter:     { ref: "05", tag: "spectral" },
  Delay:      { ref: "06", tag: "temporal" },
  Effect:     { ref: "07", tag: "non-linear" },
  Analysis:   { ref: "08", tag: "feature extraction" },
  Convert:    { ref: "09", tag: "scale · clock · seq · input" },
  Math:       { ref: "10", tag: "arithmetic · logic · mix" },
  // 3D scene + render
  Scene:      { ref: "20", tag: "cameras · lights · sky · output" },
  Geometry:   { ref: "21", tag: "mesh primitives" },
  Material:   { ref: "22", tag: "surfaces · shading" },
  Transform:  { ref: "23", tag: "translate · rotate · scale" },
  Terrain:    { ref: "24", tag: "terrain · planet · water" },
  // Game systems
  Physics:    { ref: "30", tag: "bodies · colliders · joints · queries" },
  Game:       { ref: "31", tag: "lifecycle · FSM · stage · gameplay" },
  UI:         { ref: "32", tag: "widgets · HUD" },
  Sprite:     { ref: "33", tag: "2D · tilemap · level" },
  // Visual FX / compositing
  Source:     { ref: "40", tag: "video · image · text" },
  Generator:  { ref: "41", tag: "procedural shaders" },
  Composite:  { ref: "42", tag: "fx · masks · keying · color" },
  // Misc
  AI:         { ref: "50", tag: "vision · ML · landmarks" },
  "User DSP": { ref: "98", tag: ".gdsp · community" },
  Sink:       { ref: "99", tag: "output" },
};
function _brCatMeta(cat) {
  return _BR_CAT_META[cat] || { ref: "··", tag: "ext" };
}

/* The "Visual" registry category grew to ~170 nodes — unusable as one
 * list. Rather than re-tag every TYPES entry, we route Visual nodes
 * into finer display categories by name. Non-Visual categories pass
 * through unchanged. Unmatched Visual nodes fall to "Composite"
 * (the video-FX catch-all). */
const _VISUAL_SUBCAT = {
  Scene: ["Camera","FPCamera","OrthoCamera2D","OrthoCamera25D","ThirdPersonCamera","Scene","Scene3D","Scene2D","Scene25D","RayTracedScene","VisualOutput","DirectionalLight","PointLight","SpotLight","AreaLight","Sun","DayNightCycle","ProceduralSky","HDRI","Skybox","GradientSky","RigGizmo"],
  Geometry: ["Box","Sphere","Capsule","Plane","Torus","Cylinder","Cone","DebugTriangle","MeshTest","PlanetMesh","LoadGLB"],
  Material: ["UnlitMat","PhongMat","PhysicalMat","MirrorMat","GlassMat","ShaderMat","TerrainMaterial"],
  Transform: ["Translate","Rotate","Scale","MeshWorldPosition"],
  Physics: ["PhysicsWorld2D","RigidBody2D","BoxCollider2D","CircleCollider2D","CapsuleCollider2D","Raycast2D","OverlapCircle2D","OverlapBox2D","RevoluteJoint2D","DistanceJoint2D","PrismaticJoint2D","WeldJoint2D","ContactEvent2D","TilemapCollider2D","PhysicsWorld3D","RigidBody3D","BoxCollider3D","SphereCollider3D","CapsuleCollider3D","Raycast3D","OverlapSphere3D","HingeJoint3D","BallJoint3D","FixedJoint3D","DestructibleBody3D","FractureMesh","ContactForce3D","TerrainCollider","WaterCollider","Spherecast2D","Spherecast3D","ForceField3D","Wind3D","RopeJoint3D","Rope3D","Cloth3D","ClothPin3D","SoftBody3D","PhysicsRecord","PhysicsReplay"],
  Game: ["KeyAxis2D","PlatformerBody2D","BlobController3D","PickupCollector","LevelGoal2D","AnimationState2D","OnAwake","OnStart","OnUpdate","OnDestroy","EdgeCount","StageManager","StateMachine","Pool","PrefabInstance"],
  UI: ["UIButton","UIText","UIPanel","UISlider","Leaderboard","HUDText","Minimap","Altimeter"],
  Sprite: ["TileSpriteOverlay","ParallaxLayer2D","SpriteScatter2D","Tilemap2D","Level2D","ImageURL","SpriteCreator","Sprite"],
  Terrain: ["Planet","PlanetMap","Terrain","TiledTerrain","TerrainHorizon","Water","Clouds3D","ProceduralTerrain","TerrainErosion"],
  Source: ["Text","SolidColor","Webcam","VideoFile","ScreenShare","Gradient","Checkerboard"],
  Generator: ["Plasma","Voronoi","StarNest","Butterflies","NoiseShader","MatrixRain","ShapeTunnel","GammaScreensaver","WireframeCalibration"],
};
const _VISUAL_ROUTE = (() => {
  const m = {};
  for (const sub of Object.keys(_VISUAL_SUBCAT)) {
    for (const n of _VISUAL_SUBCAT[sub]) m[n] = sub;
  }
  return m;
})();
function _deriveNodeCategory(name, def) {
  if (!def) return "Visual";
  if (def.category !== "Visual") return def.category;
  return _VISUAL_ROUTE[name] || "Composite";
}

/* View state. The browser is a thin state machine on top of the
 * existing palette DOM — when state changes we re-render. */
const brState = {
  tab: "nodes",            // nodes | assets | patches
  mode: "list",            // list | grid
  search: "",
  catFilter: null,         // null = all categories
  selected: null,          // node name or null
  assetType: null,         // null | audio | midi | video | gpatch | gdsp
  assetSource: null,       // null | source-id
};

/* Parse the search box into structured filters. Supports:
 *   plain words (any combination — must all match name+desc+cat)
 *   cat:filter — restrict to a category (substring match)
 *   tag:multi  — restrict to a tag (substring match against the tag set)
 *   port:audio — at least one port name+type contains the string
 *   new        — recent additions only (whitelist below)
 */
const _BR_NEW_NODES = new Set([
  "MasterClock","LFOClock","EuclideanRhythm","StepSeq16","StepSeq32","Arp",
  "PianoRoll","MultiPianoRoll","WavetableScan","SamplePlayer","StereoSamplePlayer",
  "GranularPlayer","PulsarSynth","LiveLooper","MicInput","VoiceTrigger",
  "Ramp","VCA","AudioBus","MasterMix","PatchMatrix","Const",
  "StateVariableFilter","MoogLadder","FMOp","KSString","WavetableOsc",
]);
function brParseSearch(text) {
  const tokens = (text || "").trim().split(/\s+/).filter(Boolean);
  const ops = { cat: [], tag: [], port: [], onlyNew: false, free: [] };
  for (const t of tokens) {
    const tl = t.toLowerCase();
    if (tl.startsWith("cat:"))       ops.cat.push(tl.slice(4));
    else if (tl.startsWith("tag:"))  ops.tag.push(tl.slice(4));
    else if (tl.startsWith("port:")) ops.port.push(tl.slice(5));
    else if (tl === "new")           ops.onlyNew = true;
    else                             ops.free.push(tl);
  }
  return ops;
}
function brNodeMatches(name, def, tags, ops) {
  if (ops.onlyNew && !_BR_NEW_NODES.has(name)) return false;
  const derivedCat = _deriveNodeCategory(name, def);
  for (const c of ops.cat)  if (!derivedCat.toLowerCase().includes(c) && !String(def.category || "").toLowerCase().includes(c)) return false;
  for (const t of ops.tag)  if (!tags.some(x => x.includes(t))) return false;
  for (const p of ops.port) {
    const hay = [...(def.ins||[]), ...(def.outs||[])].map(x => `${x.n} ${x.t}`).join(" ").toLowerCase();
    if (!hay.includes(p)) return false;
  }
  if (ops.free.length) {
    const hay = (name + " " + (def.description||"") + " " + derivedCat + " " + (def.category||"")).toLowerCase();
    for (const f of ops.free) if (!hay.includes(f)) return false;
  }
  return true;
}

function brHighlight(text, ops) {
  const primary = ops.free[0];
  if (!primary) return escapeText(text);
  const i = text.toLowerCase().indexOf(primary);
  if (i < 0) return escapeText(text);
  return escapeText(text.slice(0, i))
    + "<mark>" + escapeText(text.slice(i, i + primary.length)) + "</mark>"
    + escapeText(text.slice(i + primary.length));
}

/* ─── Vertical category rail ────────────────────────────────────── */
function brRenderRail(catsPresent) {
  const rail = document.getElementById("br-cat-rail");
  if (!rail) return;
  // Order: CATEGORY_ORDER first, then any extras present in the data.
  const seen = new Set();
  const ordered = [];
  CATEGORY_ORDER.forEach(c => { if (catsPresent.has(c)) { ordered.push(c); seen.add(c); } });
  catsPresent.forEach(c => { if (!seen.has(c)) ordered.push(c); });

  let html = `
    <div class="rail-marker">ALL</div>
    <div class="rail-item ${brState.catFilter === null ? "active" : ""}" data-cat="" title="All categories">
      <span class="rail-dot" style="color: var(--phosphor)"></span>
      <span class="rail-tip">all categories</span>
    </div>
    <div class="rail-divider"></div>
    <div class="rail-marker">CAT</div>
  `;
  ordered.forEach(cat => {
    // Pull the color from the first node in this (derived) category.
    let color = "var(--text-3)";
    for (const [nm, n] of Object.entries(TYPES)) { if (_deriveNodeCategory(nm, n) === cat) { color = n.color; break; } }
    const active = brState.catFilter === cat ? "active" : "";
    html += `
      <div class="rail-item ${active}" data-cat="${escapeAttr(cat)}">
        <span class="rail-dot" style="color: ${color}"></span>
        <span class="rail-tip">${escapeText(cat.toLowerCase())}</span>
      </div>
    `;
  });
  rail.innerHTML = html;
  rail.querySelectorAll(".rail-item").forEach(it => {
    it.addEventListener("click", () => {
      brState.catFilter = it.dataset.cat || null;
      brRenderNodes();
    });
  });
}

/* ─── Nodes list (replaces old palette body) ────────────────────── */
function brRenderNodes() {
  const ops = brParseSearch(brState.search);
  const catsPresent = new Set();
  const cats = {};
  let totalShown = 0;
  Object.entries(TYPES).forEach(([name, def]) => {
    const cat = _deriveNodeCategory(name, def);
    catsPresent.add(cat);
    if (brState.catFilter && cat !== brState.catFilter) return;
    const tags = brDeriveTags(name, def);
    if (!brNodeMatches(name, def, tags, ops)) return;
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ name, def, tags });
    totalShown++;
  });

  brRenderRail(catsPresent);

  const totalAll = Object.keys(TYPES).length;
  const filtering = !!(brState.search || brState.catFilter);

  let html = "";
  let any = false;
  // Order: CATEGORY_ORDER first, then any extras present in the data.
  const seen = new Set();
  const ordered = [];
  CATEGORY_ORDER.forEach(c => { if (cats[c]) { ordered.push(c); seen.add(c); } });
  Object.keys(cats).forEach(c => { if (!seen.has(c)) ordered.push(c); });

  ordered.forEach(cat => {
    const items = cats[cat];
    if (!items || !items.length) return;
    any = true;
    const collapsedClass = collapsedCats[cat] && !filtering ? " collapsed" : "";
    const meta = _brCatMeta(cat);
    const catColor = items[0].def.color || "var(--text-3)";
    html += `<div class="cat${collapsedClass}" data-cat="${escapeAttr(cat)}">`;
    html += `<div class="cat-header" data-toggle="${escapeAttr(cat)}">`;
    html += `<span class="cat-ref">${meta.ref}<br>·${items.length}</span>`;
    html += `<span class="cat-name-block">`;
    html +=   `<span class="cat-name" style="color: ${catColor}; text-shadow: 0 0 8px ${catColor}40;">${escapeText(cat.toLowerCase())}</span>`;
    html +=   `<span class="cat-tag">${escapeText(meta.tag)}</span>`;
    html += `</span>`;
    html += `<span class="cat-meta"><span class="cat-count">${items.length}</span><span class="cat-toggle">▼</span></span>`;
    html += `</div>`;
    html += `<div class="cat-items list">`;
    items.forEach(({ name, def, tags }) => {
      const sel = brState.selected === name ? "selected" : "";
      const desc = def.description || "";
      const nameHtml = brHighlight(name, ops);
      const tagHtml = tags.map(t => `<span class="br-tag ${t}">${t.replace("user-dsp", ".gdsp")}</span>`).join("");
      html += `<div class="pal-item ${sel}" data-add="${escapeAttr(name)}"`;
      if (desc) html += ` title="${escapeAttr(desc)}"`;
      html += `>`;
      html += `<span class="pal-dot" style="background:${def.color}; color:${def.color}"></span>`;
      html += `<span class="pal-name">${nameHtml}</span>`;
      html += `<span class="item-tags">${tagHtml}</span>`;
      html += `</div>`;
    });
    html += `</div></div>`;
  });
  if (!any) {
    html = `<div class="pal-empty">No nodes match the current filter.<br><br>
      <span style="color:var(--text-3); font-size:9.5px; letter-spacing:0.10em;">
        TRY: clearing the search · clicking ALL on the rail · cat:filter · tag:multi-out
      </span></div>`;
  }
  palette.innerHTML = html;

  // Footer + tab status
  const footCount = document.getElementById("pal-foot-count");
  if (footCount) footCount.textContent = filtering ? `${totalShown}` : String(totalAll);
  const footReg = document.getElementById("br-foot-reg"); if (footReg) footReg.textContent = String(totalAll);
  const footCat = document.getElementById("br-foot-cat"); if (footCat) footCat.textContent = String(catsPresent.size);
  const footVer = document.getElementById("br-foot-version"); if (footVer && typeof APP_VERSION !== "undefined") footVer.textContent = `GAMMA · v${APP_VERSION}`;
  const tabStatus = document.getElementById("br-tab-status"); if (tabStatus) tabStatus.textContent = `REG · ${totalAll}`;

  // Re-bind interaction. Category headers toggle collapsed state;
  // pal-items single-click selects (highlights + shows in the
  // drawer) and double-click adds to the canvas. Keep single-click-
  // adds-to-canvas for the historical UX so power users aren't
  // surprised — they can still drop a node by single click.
  palette.querySelectorAll(".cat-header").forEach(h => {
    h.addEventListener("click", () => {
      const cat = h.dataset.toggle;
      collapsedCats[cat] = !collapsedCats[cat];
      brRenderNodes();
    });
  });
  palette.querySelectorAll(".pal-item").forEach(item => {
    item.addEventListener("click", () => {
      const name = item.dataset.add;
      brState.selected = name;
      brRenderDrawer();
      // Visual selection highlight
      palette.querySelectorAll(".pal-item.selected").forEach(s => s.classList.remove("selected"));
      item.classList.add("selected");
      // Open drawer if collapsed (first interaction)
      const drw = document.getElementById("br-drawer");
      if (drw && drw.classList.contains("collapsed")) drw.classList.remove("collapsed");
      // Keep the historical "click adds the node" affordance.
      addFromPalette(name);
    });
  });
}

/* ─── Detail drawer ─────────────────────────────────────────────── */
function brRenderDrawer() {
  const name = brState.selected;
  const titleEl = document.getElementById("br-drawer-title");
  const bodyEl = document.getElementById("br-drawer-body");
  if (!titleEl || !bodyEl) return;
  if (!name || !TYPES[name]) {
    titleEl.innerHTML = `nothing selected <span class="ref">REG · —</span>`;
    bodyEl.innerHTML = "";
    return;
  }
  const def = TYPES[name];
  const tags = brDeriveTags(name, def);
  const meta = _brCatMeta(def.category);
  const idx = Object.keys(TYPES).indexOf(name);
  titleEl.innerHTML = `${escapeText(name.toLowerCase())} <span class="ref">${meta.ref}.${String(idx).padStart(3,"0")} · ${escapeText((def.category||"").toUpperCase())}</span>`;

  const portRow = (p, dir) => {
    const t = (p.t || "audio").toLowerCase();
    return `
      <div class="drawer-port ${t}">
        <span class="port-glyph"></span>
        <span class="port-name">${escapeText(p.n)}</span>
        <span class="port-type">${dir==="in"?"→":"←"} ${escapeText(t)}</span>
      </div>`;
  };

  const ins = (def.ins || []).map(p => portRow(p, "in")).join("");
  const outs = (def.outs || []).map(p => portRow(p, "out")).join("");

  // Related nodes — same category, up to 5, excluding the selection.
  const related = Object.entries(TYPES)
    .filter(([n, d]) => n !== name && d.category === def.category)
    .slice(0, 5)
    .map(([n]) => `<span class="related-chip" data-jump="${escapeAttr(n)}">${escapeText(n)}</span>`)
    .join("");

  const tagHtml = tags.map(t => `<span class="br-tag ${t}" style="font-size:9px; padding:2px 6px;">${t.replace("user-dsp",".gdsp")}</span>`).join("");

  bodyEl.innerHTML = `
    <div class="drawer-section">
      <div class="drawer-section-label">function</div>
      <div class="drawer-text">${escapeText(def.description || "(no description provided)")}</div>
    </div>
    ${ (ins || outs) ? `
      <div class="drawer-section">
        <div class="drawer-section-label">ports · ${(def.ins||[]).length} in / ${(def.outs||[]).length} out</div>
        <div class="drawer-ports">${ins}${outs}</div>
      </div>
    ` : "" }
    <div class="drawer-section">
      <div class="drawer-section-label">tags</div>
      <div class="drawer-related">${tagHtml || "<span style='color:var(--text-3); font-size:10px;'>(no tags derived)</span>"}</div>
    </div>
    ${ related ? `
      <div class="drawer-section">
        <div class="drawer-section-label">related — same category</div>
        <div class="drawer-related">${related}</div>
      </div>
    ` : "" }
  `;
  bodyEl.querySelectorAll(".related-chip").forEach(c => {
    c.addEventListener("click", () => {
      const target = c.dataset.jump;
      if (TYPES[target]) {
        brState.selected = target;
        brRenderNodes();
        brRenderDrawer();
      }
    });
  });
}

/* ─── Tab switching ─────────────────────────────────────────────── */
function brSwitchTab(name) {
  brState.tab = name;
  document.querySelectorAll(".br-tab").forEach(t => t.classList.toggle("active", t.dataset.brTab === name));
  const vN = document.getElementById("br-view-nodes");
  const vA = document.getElementById("br-view-assets");
  const vD = document.getElementById("br-view-demos");
  const vP = document.getElementById("br-view-prefabs");
  if (vN) vN.hidden = name !== "nodes";
  if (vA) vA.hidden = name !== "assets";
  if (vD) vD.hidden = name !== "demos";
  if (vP) vP.hidden = name !== "prefabs";
  // Status text updates per-tab
  const status = document.getElementById("br-tab-status");
  if (status) {
    if (name === "nodes")   status.textContent = `REG · ${Object.keys(TYPES).length}`;
    if (name === "assets")  status.textContent = `ASSETS · ${(_assets ? _assets.size : 0)}`;
    if (name === "demos")   status.textContent = `DEMOS · ${_demos.length}`;
    if (name === "prefabs") status.textContent = `PREFABS · ${_prefabBrowserCount()}`;
  }
  if (name === "assets")  brRenderAssets();
  if (name === "demos")   brRenderDemos();
  if (name === "prefabs") brRenderPrefabs();
}

/* ─── Demos tab ─────────────────────────────────────────────────── */
/* Curated example patches. Each entry's build() function runs against
 * a freshly-cleared `state` (via loadDemo()) using the same makeNode +
 * state.edges.push pattern reset() uses, so the demos read like
 * normal patch construction. The thumbnails are inline SVG glyphs
 * sized to match the asset-card .asset-thumb dimensions. Add more
 * demos here as Phase 6.5.5+ ships canonical examples. */

/* Programmatic sprite-sheet generator for the animated platformer
 * demo. 6 frames at 32×32, laid out horizontally (sheet 192×32):
 *   [0] idle    [1] walk-A    [2] walk-mid    [3] walk-B    [4] jump    [5] fall
 * Matches the AnimationState2D node's default frame specs
 *   idleFrames:"0", walkFrames:"1,2,1,3", jumpFrames:"4", fallFrames:"5"
 * so a fresh AnimationState2D wires up against this sheet with no
 * tweaking. Cheap-and-cheerful "orange blob with eyes" -- a stand-in
 * for whatever character the user generates via SpriteCreator later.
 */
async function _makePlaceholderHeroSheet() {
  const FW = 32, FH = 32, NF = 6;
  const W = FW * NF, H = FH;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  // Palette -- low-saturation pixel-art friendly.
  const C_BODY    = "#e85a3a";
  const C_DARK    = "#a83a20";
  const C_OUT     = "#3a1a10";
  const C_EYE     = "#ffffff";
  const C_PUPIL   = "#101010";
  const C_FOOT    = "#5a2a1a";
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  function drawHero(ox, p) {
    const bx = ox + 8;
    const by = 8 + (p.bobY || 0);
    const bw = 16, bh = 16;
    // Body fill
    px(bx + 1, by + 1, bw - 2, bh - 2, C_BODY);
    // Outline
    px(bx, by + 1, 1, bh - 2, C_OUT);
    px(bx + bw - 1, by + 1, 1, bh - 2, C_OUT);
    px(bx + 1, by, bw - 2, 1, C_OUT);
    px(bx + 1, by + bh - 1, bw - 2, 1, C_OUT);
    // Shading (lower-right)
    px(bx + bw - 3, by + 3, 1, bh - 5, C_DARK);
    px(bx + 3, by + bh - 3, bw - 5, 1, C_DARK);
    // Eyes
    const eyeY = by + 4;
    const eyeL = bx + 3, eyeR = bx + 10;
    px(eyeL, eyeY, 3, 3, C_EYE);
    px(eyeR, eyeY, 3, 3, C_EYE);
    const pdx = (p.lookRight ? 2 : (p.lookLeft ? 0 : 1));
    const pdy = (p.lookUp ? 0 : (p.lookDown ? 2 : 1));
    px(eyeL + pdx, eyeY + pdy, 1, 1, C_PUPIL);
    px(eyeR + pdx, eyeY + pdy, 1, 1, C_PUPIL);
    // Mouth (subtle dark notch)
    px(bx + 7, by + 10, 2, 1, C_OUT);
    // Feet -- two small rects below body
    const fyBase = by + bh;
    const lf = p.leftFoot  || { dx: -2, dy: 0 };
    const rf = p.rightFoot || { dx: 1,  dy: 0 };
    px(bx + 2 + lf.dx, fyBase + lf.dy, 4, 2, C_FOOT);
    px(bx + bw - 6 + rf.dx, fyBase + rf.dy, 4, 2, C_FOOT);
  }
  // Frame 0 -- idle (neutral stance, looking forward)
  drawHero(0 * FW, { leftFoot: { dx: -2, dy: 0 }, rightFoot: { dx: 1, dy: 0 } });
  // Frame 1 -- walk pose A (right foot forward, lifted)
  drawHero(1 * FW, { leftFoot: { dx: -3, dy: 0 }, rightFoot: { dx: 2, dy: -1 }, lookRight: true });
  // Frame 2 -- walk pose mid (both feet close, body up a hair)
  drawHero(2 * FW, { bobY: -1, leftFoot: { dx: -1, dy: 0 }, rightFoot: { dx: 0, dy: 0 } });
  // Frame 3 -- walk pose B (left foot forward, lifted)
  drawHero(3 * FW, { leftFoot: { dx: -1, dy: -1 }, rightFoot: { dx: 0, dy: 0 }, lookRight: true });
  // Frame 4 -- jump (body raised, feet tucked, eyes up)
  drawHero(4 * FW, { bobY: -3, leftFoot: { dx: -1, dy: -2 }, rightFoot: { dx: 0, dy: -2 }, lookUp: true });
  // Frame 5 -- fall (body lowered, feet down, eyes down)
  drawHero(5 * FW, { bobY: 1,  leftFoot: { dx: -2, dy: 1 },  rightFoot: { dx: 1, dy: 1 },  lookDown: true });
  return await c.convertToBlob({ type: "image/png" });
}

/* Idempotent. If a sprite named 'hero-placeholder' already exists in
 * the asset library, this is a no-op. Otherwise it generates the
 * placeholder sheet, registers it as a 6-frame sprite, and creates
 * a 'hero-placeholder-folder' (playable-character function) with the
 * sprite assigned to the idle / walk / jump-up / fall slots so the
 * user can drag the folder onto a Scene2D to spawn a wired character. */
/* Programmatic egg pickup sprite. 16×16, single frame. Egg-shell
 * cream body with a soft top-left highlight + bottom-right shadow
 * for that "I am an egg, not a circle" read. Pixel-art ovular
 * silhouette so it stays legible at 1:1 in a 32×32 sprite world. */
async function _makeEggPickupSprite() {
  const W = 16, H = 16;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  const SHELL     = "#fdf3e0";
  const HIGHLIGHT = "#ffffff";
  const SHADOW    = "#dbc89c";
  const OUTLINE   = "#7a5a30";
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  // Egg silhouette as horizontal scanlines (cols start_x → start_x+width).
  // Roughly 10×12 ovular, narrower at top, slightly fatter near bottom.
  const shape = [
    { y:  2, x: 6, w: 4 },
    { y:  3, x: 5, w: 6 },
    { y:  4, x: 4, w: 8 },
    { y:  5, x: 4, w: 8 },
    { y:  6, x: 3, w: 10 },
    { y:  7, x: 3, w: 10 },
    { y:  8, x: 3, w: 10 },
    { y:  9, x: 3, w: 10 },
    { y: 10, x: 3, w: 10 },
    { y: 11, x: 4, w: 8 },
    { y: 12, x: 4, w: 8 },
    { y: 13, x: 5, w: 6 }
  ];
  for (const s of shape) px(s.x, s.y, s.w, 1, SHELL);
  // Outline pass
  for (const s of shape) {
    px(s.x,          s.y, 1, 1, OUTLINE);
    px(s.x + s.w - 1, s.y, 1, 1, OUTLINE);
  }
  px(6, 1, 4, 1, OUTLINE); // top cap
  px(5, 14, 6, 1, OUTLINE); // bottom cap
  // Highlight (top-left)
  px(5, 4, 2, 1, HIGHLIGHT);
  px(4, 5, 1, 2, HIGHLIGHT);
  px(5, 5, 1, 1, HIGHLIGHT);
  // Shadow (bottom-right curve)
  px(10, 10, 1, 2, SHADOW);
  px(9, 12, 2, 1, SHADOW);
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic goal-flag sprite. 16×24, single frame. A wooden pole
 * on the left third + a red triangular pennant pointing right --
 * unambiguous "you've reached the end" visual that reads cleanly
 * even when rendered at 1 world unit tall. */
async function _makeGoalFlagSprite() {
  const W = 16, H = 24;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  const POLE_LIGHT = "#8c6a3e";
  const POLE_DARK  = "#5a3e1e";
  const FLAG       = "#e83a3a";
  const FLAG_LITE  = "#ff6060";
  const FLAG_DARK  = "#a02020";
  const OUTLINE    = "#3a1010";
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  // Pole: 2px wide centered around x=3, full height minus base.
  px(3, 1, 2, 22, POLE_LIGHT);
  px(3, 1, 1, 22, POLE_DARK);   // left edge darker
  px(2, 22, 4, 1, POLE_DARK);   // small foot
  px(1, 23, 6, 1, OUTLINE);     // ground line
  // Flag: triangle, peak at top of pole, hangs down to mid-height.
  // Rows from y=2 to y=10. Each row: starts at x=5 (right of pole),
  // extends by a width that narrows toward the bottom.
  const flag = [
    { y:  2, w: 10 },
    { y:  3, w: 10 },
    { y:  4, w: 10 },
    { y:  5, w: 9  },
    { y:  6, w: 8  },
    { y:  7, w: 7  },
    { y:  8, w: 5  },
    { y:  9, w: 3  }
  ];
  for (const f of flag) px(5, f.y, f.w, 1, FLAG);
  // Highlight top
  px(5, 2, 8, 1, FLAG_LITE);
  // Shadow bottom edges of each row (gives flag depth)
  for (const f of flag) px(5 + f.w - 1, f.y, 1, 1, FLAG_DARK);
  // Pennant point outline (right edge)
  px(5 + flag[0].w, 2, 1, 1, OUTLINE);
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic parallax background -- sky layer. 256×128 PNG with
 * a soft vertical gradient (deep blue top → light haze bottom) plus
 * scattered subtle clouds. Width chosen to tile horizontally
 * seamlessly when the sampler is set to repeat-x. parallaxX=0 means
 * the sky doesn't actually scroll, but we still want it to look
 * "right" if someone wires it with parallaxX>0. */
async function _makeParallaxSkySprite() {
  const W = 256, H = 128;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  // Vertical gradient: top deeper blue → bottom haze.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0,   "#4a7dc0");
  grad.addColorStop(0.6, "#82b6d8");
  grad.addColorStop(1,   "#c9dceb");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Distant clouds -- soft ellipses, transparent. Deterministic
  // placement via seeded random so the look is stable across loads.
  let seed = 0x4c1d;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  for (let i = 0; i < 6; i++) {
    const x = rand() * W;
    const y = 12 + rand() * 36;
    const rx = 18 + rand() * 26;
    const ry = 5  + rand() * 4;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tile-safe: if cloud crosses right edge, redraw at x-W so the
    // texture loops cleanly.
    if (x + rx > W)  { ctx.beginPath(); ctx.ellipse(x - W, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
    if (x - rx < 0)  { ctx.beginPath(); ctx.ellipse(x + W, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic parallax background -- distant mountains. 512×128.
 * Two overlapping silhouette ranges in muted purple-gray; tile-safe
 * horizontally. Transparent above the ridges so the sky shows
 * through. parallaxX ~0.10-0.15 for "far distance" feel. */
async function _makeParallaxMountainsSprite() {
  const W = 512, H = 128;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, W, H);
  // Ridge generator: triangular peaks at quasi-random columns. Use
  // a closed path that wraps to tile cleanly: ensure the last point's
  // y matches the first point's y, and the path stays inside [0, W].
  function drawRidge(color, peakColor, baseY, peakHeight, peakCount, seed) {
    let s = seed >>> 0;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
    const peaks = [];
    // Force matching endpoints so the texture seams cleanly.
    peaks.push({ x: 0,   y: baseY });
    for (let i = 0; i < peakCount; i++) {
      const px = ((i + 0.5) / peakCount) * W + (rand() - 0.5) * (W / peakCount) * 0.6;
      const ph = peakHeight * (0.6 + rand() * 0.4);
      peaks.push({ x: px, y: baseY - ph });
      // Add a saddle between peaks for variation
      if (i < peakCount - 1) {
        const sx = ((i + 1) / peakCount) * W;
        const sh = peakHeight * (0.2 + rand() * 0.3);
        peaks.push({ x: sx, y: baseY - sh });
      }
    }
    peaks.push({ x: W,   y: baseY });
    // Body fill
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (const p of peaks) ctx.lineTo(p.x, p.y);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // Ridge highlight (thin lighter line along the top edge)
    ctx.beginPath();
    ctx.moveTo(peaks[0].x, peaks[0].y);
    for (let i = 1; i < peaks.length; i++) ctx.lineTo(peaks[i].x, peaks[i].y);
    ctx.strokeStyle = peakColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // Far ridge (lighter, higher up the image)
  drawRidge("#7a8aa8", "#a4b3cd", 78, 48, 7, 0x8a14);
  // Near ridge (darker, lower down + taller peaks)
  drawRidge("#54678a", "#7d92b3", 96, 60, 5, 0x3221);
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic parallax background -- midground forest. 512×128.
 * Row of conifer-tree silhouettes with snow caps + subtle variation
 * in height. Tile-safe. Sits in front of the mountains, behind the
 * level. parallaxX ~0.30-0.45 for "midground" feel. */
async function _makeParallaxForestSprite() {
  const W = 512, H = 128;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  let s = 0x9911;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  // Sparser horizon-strip treeline. ONLY 6 short trees across 512px
  // (was 18 ~tall ones), confined to the BOTTOM 30% of the texture
  // so a thin layer (scaleY ~0.25) places them as a peek-above-the-
  // horizon silhouette band rather than a wall of foliage that
  // covers half the screen.
  const baselineY = H - 4;          // trunk floor near bottom of texture
  const treeCount = 6;
  const slot = W / treeCount;
  function drawTreeAt(cx, baseY, height, width) {
    // Trunk
    ctx.fillStyle = "#3a2210";
    ctx.fillRect(cx - 1.5, baseY, 3, 3);
    // Triangle body
    ctx.fillStyle = "#2c5436";
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.5, baseY);
    ctx.lineTo(cx + width * 0.5, baseY);
    ctx.lineTo(cx,                baseY - height);
    ctx.closePath();
    ctx.fill();
    // Subtle inner highlight
    ctx.fillStyle = "#3a6845";
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.30, baseY - 2);
    ctx.lineTo(cx + width * 0.12, baseY - 2);
    ctx.lineTo(cx - width * 0.05, baseY - height + 4);
    ctx.closePath();
    ctx.fill();
  }
  for (let i = 0; i < treeCount; i++) {
    const cx = (i + 0.5) * slot + (rand() - 0.5) * slot * 0.3;
    const baseY = baselineY - rand() * 2;
    const height = 18 + rand() * 8;   // 18-26 (was 32-54)
    const width  = 12 + rand() * 4;   // 12-16 (was 14-22)
    drawTreeAt(cx, baseY, height, width);
    // Tile-wrap for seamless horizontal cycling.
    if (cx + width * 0.5 > W) drawTreeAt(cx - W, baseY, height, width);
    if (cx - width * 0.5 < 0) drawTreeAt(cx + W, baseY, height, width);
  }
  return await c.convertToBlob({ type: "image/png" });
}

/* Default-ship bootstrap: parallax bg layers (sky + mountains +
 * forest) all in one 'parallax-background' folder so they ship as
 * a related set. Functions identically to the hero / egg / flag
 * bootstraps: idempotent, runs on DOMContentLoaded. */
// Bump on any meaningful parallax-bg art change so users on the
// previous version get the new sprites instead of stale IDB blobs.
const PARALLAX_BG_VERSION = 2;
async function _ensureParallaxBgAssets() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    const layers = [
      { name: "parallax-sky",       generator: _makeParallaxSkySprite,       slot: "sky" },
      { name: "parallax-mountains", generator: _makeParallaxMountainsSprite, slot: "far" },
      { name: "parallax-forest",    generator: _makeParallaxForestSprite,    slot: "mid" }
    ];
    const slots = {};
    let createdAny = false;
    for (const layer of layers) {
      let sprite = Assets.findSpriteByName(layer.name);
      // Stale-art replacement: if the existing record was created by
      // an older version of this bootstrap, delete it so the new
      // generator output gets saved this run.
      if (sprite && (sprite.parallaxBgVersion || 0) < PARALLAX_BG_VERSION) {
        console.log("[default-assets] replacing stale " + layer.name +
          " (v" + (sprite.parallaxBgVersion || 0) + " -> v" + PARALLAX_BG_VERSION + ")");
        try { await Assets.delete(sprite.id); } catch (e) {
          console.warn("[default-assets] delete failed:", e);
        }
        sprite = null;
      }
      if (!sprite) {
        const blob = await layer.generator();
        const file = new File([blob], layer.name + ".png", { type: "image/png" });
        sprite = await loadImageFileToSpriteAsset(file, {
          name: layer.name,
          framesX: 1, framesY: 1,
          fps: 1, scale: 32,
          source: "default:parallax-bg"
        });
        if (sprite) {
          sprite.parallaxBgVersion = PARALLAX_BG_VERSION;
          try { await Assets.put(sprite); } catch (e) { console.warn("[default-assets] version-tag put failed:", e); }
          if (sprite.blob) {
            console.log("[default-assets] " + layer.name + " v" + PARALLAX_BG_VERSION +
              " sprite saved (" + sprite.blob.size + " bytes)");
          }
        }
        createdAny = true;
      }
      if (sprite) slots[layer.slot] = sprite.id;
    }
    let folder = Assets.findFolderByName("parallax-bg-folder");
    if (!folder) {
      folder = await createFolderAsset("parallax-bg-folder", "decoration", {
        slots: { main: slots.sky || null },   // decoration has 'main' slot
        notes: "Default parallax background set bundled with the editor. Three layers (sky / mountains / forest) for Snow-White-style multi-plane scrolling in Scene2D demos. Wire each into a ParallaxLayer2D with an ImageURL(wrapMode='repeat-x'), then into Scene2D.mesh1..mesh3 (back-to-front). See the Platformer 2D · Animated demo for the canonical layout.",
        source: "default:parallax-bg"
      });
    }
    if (createdAny) {
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return slots;
  } catch (e) {
    console.warn("[default-assets] parallax bg bootstrap failed:", e);
    return null;
  }
}

/* Default ship-with-app tileset for Level2D textured tilemap layers.
 * 4×2 grid of 16px tiles -> 64×32 PNG. Each tile is hand-drawn
 * procedurally; user can replace via SpriteCreator once Phase 2c
 * adds a real tileset asset type.
 *
 * Tile index layout:
 *   0 grass-top  1 dirt       2 stone     3 sand
 *   4 water      5 wood-plank 6 brick     7 door
 *
 * Level2D tilemap layer uses tileMap = { "1": 0, "2": 1, ... } to
 * map cell chars to tile indices into this sheet.
 */
async function _makeDemoTilesetSprite() {
  const TW = 16, TH = 16, COLS = 4, ROWS = 2;
  const W = TW * COLS, H = TH * ROWS;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  function tileAt(col, row) { return { ox: col * TW, oy: row * TH }; }
  // Tile 0: grass-top (green w/ darker grass blades on top)
  {
    const { ox, oy } = tileAt(0, 0);
    px(ox, oy + 2, 16, 14, "#3a8a3e");      // body
    px(ox, oy + 2, 16, 1,  "#5fa860");      // top highlight
    px(ox, oy + 15, 16, 1, "#1f5024");      // bottom shadow
    // grass blades on top edge
    for (let i = 0; i < 8; i++) px(ox + i * 2 + (i % 2), oy + (i % 2 ? 0 : 1), 1, (i % 2 ? 2 : 1), "#7ec48a");
  }
  // Tile 1: dirt
  {
    const { ox, oy } = tileAt(1, 0);
    px(ox, oy, 16, 16, "#6a4520");
    // pebbles
    px(ox + 3,  oy + 3,  2, 2, "#52341c");
    px(ox + 10, oy + 7,  2, 2, "#7a5230");
    px(ox + 5,  oy + 11, 2, 2, "#4a2e18");
    px(ox + 12, oy + 12, 1, 1, "#52341c");
  }
  // Tile 2: stone
  {
    const { ox, oy } = tileAt(2, 0);
    px(ox, oy, 16, 16, "#6e7280");
    // cracks
    px(ox + 1, oy + 4, 5, 1, "#52555f");
    px(ox + 9, oy + 9, 5, 1, "#52555f");
    px(ox + 4, oy + 12, 1, 3, "#52555f");
    // highlights
    px(ox + 2, oy + 1, 3, 1, "#8b8f9c");
    px(ox + 11, oy + 5, 3, 1, "#8b8f9c");
  }
  // Tile 3: sand
  {
    const { ox, oy } = tileAt(3, 0);
    px(ox, oy, 16, 16, "#e2c887");
    // texture dots
    px(ox + 3,  oy + 4,  1, 1, "#c8ad6b");
    px(ox + 9,  oy + 6,  1, 1, "#c8ad6b");
    px(ox + 5,  oy + 11, 1, 1, "#c8ad6b");
    px(ox + 12, oy + 13, 1, 1, "#c8ad6b");
    px(ox + 7,  oy + 2,  1, 1, "#f0d59a");
    px(ox + 11, oy + 9,  1, 1, "#f0d59a");
  }
  // Tile 4: water
  {
    const { ox, oy } = tileAt(0, 1);
    px(ox, oy, 16, 16, "#3a6eb4");
    // wave highlights
    px(ox + 1, oy + 2,  6, 1, "#5a8cd4");
    px(ox + 9, oy + 5,  5, 1, "#5a8cd4");
    px(ox + 3, oy + 9,  7, 1, "#5a8cd4");
    px(ox + 10, oy + 12, 4, 1, "#5a8cd4");
    px(ox + 2, oy + 13, 3, 1, "#7daad8");
  }
  // Tile 5: wood plank
  {
    const { ox, oy } = tileAt(1, 1);
    px(ox, oy, 16, 16, "#9c6a3a");
    // horizontal plank lines
    px(ox, oy + 5,  16, 1, "#6e4828");
    px(ox, oy + 10, 16, 1, "#6e4828");
    px(ox, oy + 15, 16, 1, "#5a3a20");
    // grain
    px(ox + 3,  oy + 2, 4, 1, "#b08858");
    px(ox + 9,  oy + 7, 5, 1, "#b08858");
    px(ox + 2,  oy + 12, 6, 1, "#b08858");
  }
  // Tile 6: brick wall
  {
    const { ox, oy } = tileAt(2, 1);
    px(ox, oy, 16, 16, "#7a4030");           // mortar
    const BRICK = "#b85a3a";
    // top row (offset 0)
    px(ox + 1, oy + 1, 6, 5, BRICK);
    px(ox + 8, oy + 1, 7, 5, BRICK);
    // middle row (offset 4)
    px(ox + 0, oy + 7, 3, 5, BRICK);
    px(ox + 4, oy + 7, 7, 5, BRICK);
    px(ox + 12, oy + 7, 4, 5, BRICK);
    // bottom row (offset 0)
    px(ox + 1, oy + 13, 6, 3, BRICK);
    px(ox + 8, oy + 13, 7, 3, BRICK);
  }
  // Tile 7: door
  {
    const { ox, oy } = tileAt(3, 1);
    px(ox, oy, 16, 16, "#5a3a1c");           // frame
    px(ox + 1, oy + 1, 14, 14, "#8a5a2a");   // door body
    // panels
    px(ox + 3, oy + 3, 4, 4, "#6e4520");
    px(ox + 9, oy + 3, 4, 4, "#6e4520");
    px(ox + 3, oy + 9, 4, 4, "#6e4520");
    px(ox + 9, oy + 9, 4, 4, "#6e4520");
    // knob
    px(ox + 12, oy + 8, 1, 1, "#fcd34d");
  }
  return await c.convertToBlob({ type: "image/png" });
}

async function _ensureDemoTilesetAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("demo-tileset");
    if (!sprite) {
      const blob = await _makeDemoTilesetSprite();
      const file = new File([blob], "demo-tileset.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "demo-tileset",
        framesX: 4, framesY: 2,
        fps: 1, scale: 16,
        source: "default:level2d-tileset"
      });
      if (sprite && sprite.blob) {
        console.log("[default-assets] demo-tileset sprite saved (" + sprite.blob.size + " bytes, 4×2 = 8 tiles)");
      }
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] demo-tileset bootstrap failed:", e);
    return null;
  }
}

/* Programmatic grass-tuft sprite. 16×12, single frame. Tiny green
 * silhouette with three blades + a hint of shadow at the base. Used
 * by the demo's SpriteScatter2D to lay decorative tufts along the
 * ground line. */
async function _makeGrassTuftSprite() {
  const W = 16, H = 12;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  // Three blades of grass + a small shadow.
  const BLADE  = "#4a8e4a";
  const BLADE2 = "#5fa05f";
  const BLADE3 = "#2c5e2c";
  const SHADOW = "#2a3a20";
  // Shadow at base
  px(3, 10, 10, 1, SHADOW);
  // Blade A (left, leans left)
  px(3, 3, 1, 8, BLADE3);
  px(4, 4, 1, 6, BLADE);
  px(4, 3, 1, 1, BLADE2);
  // Blade B (center, tallest)
  px(7, 1, 1, 10, BLADE);
  px(8, 1, 1, 10, BLADE3);
  px(8, 0, 1, 1, BLADE2);
  // Blade C (right, leans right)
  px(11, 4, 1, 6, BLADE);
  px(12, 3, 1, 8, BLADE3);
  px(11, 3, 1, 1, BLADE2);
  return await c.convertToBlob({ type: "image/png" });
}

/* Default-ship bootstrap for the grass tuft. */
async function _ensureGrassTuftAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("grass-tuft");
    if (!sprite) {
      const blob = await _makeGrassTuftSprite();
      const file = new File([blob], "grass-tuft.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "grass-tuft",
        framesX: 1, framesY: 1,
        fps: 1, scale: 16,
        source: "default:platformer-scatter"
      });
      if (sprite && sprite.blob) {
        console.log("[default-assets] grass-tuft sprite saved (" + sprite.blob.size + " bytes)");
      }
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] grass-tuft bootstrap failed:", e);
    return null;
  }
}

/* Default-ship bootstrap for the egg pickup. Same idempotency
 * contract as the hero. Saved as a 1-frame sprite in the asset
 * library + wrapped in a single-slot 'item' folder. */
async function _ensureEggPickupAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("egg-pickup");
    let created = false;
    if (!sprite) {
      const blob = await _makeEggPickupSprite();
      const file = new File([blob], "egg-pickup.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "egg-pickup",
        framesX: 1, framesY: 1,
        fps: 1, scale: 16,
        source: "default:platformer-items"
      });
      created = true;
      if (sprite && sprite.blob) {
        console.log("[default-assets] egg-pickup sprite saved (" + sprite.blob.size + " bytes)");
      }
    }
    if (!sprite) return null;
    let folder = Assets.findFolderByName("egg-pickup-folder");
    if (!folder) {
      folder = await createFolderAsset("egg-pickup-folder", "item", {
        slots: { idle: sprite.id },
        notes: "Default platformer pickup. Cream egg-shell sprite shipped with the editor; the Platformer 2D · Animated demo uses tilemap-based detection for now (a future push will swap in this sprite for the visual).",
        source: "default:platformer-items"
      });
    }
    if (created || folder) {
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] egg-pickup bootstrap failed:", e);
    return null;
  }
}

/* Default-ship bootstrap for the goal flag. Wrapped in a
 * 'decoration' folder since the flag is more "scenery you can
 * stand next to" than a state-machine-driven interactive. */
async function _ensureGoalFlagAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("goal-flag");
    let created = false;
    if (!sprite) {
      const blob = await _makeGoalFlagSprite();
      const file = new File([blob], "goal-flag.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "goal-flag",
        framesX: 1, framesY: 1,
        fps: 1, scale: 16,
        source: "default:platformer-items"
      });
      created = true;
      if (sprite && sprite.blob) {
        console.log("[default-assets] goal-flag sprite saved (" + sprite.blob.size + " bytes)");
      }
    }
    if (!sprite) return null;
    let folder = Assets.findFolderByName("goal-flag-folder");
    if (!folder) {
      folder = await createFolderAsset("goal-flag-folder", "decoration", {
        slots: { main: sprite.id },
        notes: "Default platformer goal marker. Red triangular flag on a wooden pole; drop next to a LevelGoal2D in your patch.",
        source: "default:platformer-items"
      });
    }
    if (created || folder) {
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] goal-flag bootstrap failed:", e);
    return null;
  }
}

async function _ensureHeroPlaceholderAsset() {
  // Skip if Assets isn't ready yet (very early bootstrap).
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("hero-placeholder");
    let createdSprite = false;
    if (!sprite) {
      const blob = await _makePlaceholderHeroSheet();
      const file = new File([blob], "hero-placeholder.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "hero-placeholder",
        framesX: 6, framesY: 1,
        fps: 8, scale: 32,
        source: "default:platformer"
      });
      createdSprite = true;
      if (sprite && sprite.blob) {
        console.log("[default-assets] hero-placeholder sprite saved ("
          + sprite.blob.size + " bytes PNG, 6 frames @ 32×32)");
      }
    }
    if (!sprite) return null;
    // Folder is keyed by name independently of the sprite -- if the
    // user nuked the folder but kept the sprite, recreate the folder.
    let folder = Assets.findFolderByName("hero-placeholder-folder");
    if (!folder) {
      folder = await createFolderAsset("hero-placeholder-folder", "playable-character", {
        slots: {
          idle:        sprite.id,
          walk:        sprite.id,
          "jump-up":   sprite.id,
          fall:        sprite.id
        },
        notes: "Default placeholder bundled with the editor. 6-frame sprite-sheet (idle / walk-A / walk-mid / walk-B / jump / fall) auto-generated on first launch. Replace via SpriteCreator when you've generated a real character — the demo will pick up the new sprite as long as you rename it 'hero-placeholder' or wire ImageURL to your asset name.",
        source: "default:platformer"
      });
    }
    if (createdSprite || folder) {
      // Refresh the Assets tab if it's currently rendered so the new
      // entries show up without requiring a tab-switch.
      if (typeof brRenderAssets === "function") {
        try { brRenderAssets(); } catch (_) {}
      }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] hero placeholder bootstrap failed:", e);
    return null;
  }
}

