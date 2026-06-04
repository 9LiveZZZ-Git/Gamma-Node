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

