/* Parse a frame-range spec used by AnimationState2D.
 *   "5"            → [5]
 *   "0,1,2"        → [0, 1, 2]
 *   "0-3"          → [0, 1, 2, 3]      (range)
 *   "0,1,2,3,2,1"  → ping-pong sequence
 * Negative / NaN segments are skipped; empty input → [0]. */
function _parseFrameSpec(s) {
  if (!s || typeof s !== "string") return [0];
  const out = [];
  for (const part of s.split(",")) {
    const seg = part.trim();
    if (!seg) continue;
    const range = seg.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const step = a <= b ? 1 : -1;
        for (let i = a; step > 0 ? i <= b : i >= b; i += step) out.push(i);
      }
    } else {
      const n = parseInt(seg, 10);
      if (Number.isFinite(n) && n >= 0) out.push(n);
    }
  }
  return out.length ? out : [0];
}

function _tickFPCameras(dt) {
  if (!state || !Array.isArray(state.nodes)) return;
  const input = Visual.fpcInput;
  if (!input) return;
  const k = input.keys;

  // Sprint 8-8: F = toggle fly / walk (rising-edge latched so holding
  // doesn't oscillate). Auto-walk on surface contact handles the
  // "just landed" case; F is the manual override to take off again.
  const fNow = !!(k && k.has("KeyF"));
  const flyToggleEdge = fNow && !input._lastKeyF;
  input._lastKeyF = fNow;

  for (const node of state.nodes) {
    if (!node || node.type !== "FPCamera") continue;
    const p = node.params = node.params || {};
    if (flyToggleEdge) p.walkMode = ((typeof p.walkMode === "number") ? p.walkMode : 1) >= 0.5 ? 0 : 1;
    const walkMode = (typeof p.walkMode === "number") ? (p.walkMode >= 0.5) : true;
    if (walkMode) _tickFPCameraWalk(node, p, dt, input, k);
    else          _tickFPCameraFlight(node, p, dt, input, k);
  }
  input.mouseDx = 0;
  input.mouseDy = 0;
}

function _tickFPCameraWalk(node, p, dt, input, k) {
  const sens     = (typeof p.mouseSensitivity === "number") ? p.mouseSensitivity : 0.0025;
  if (k && (k.has("KeyX") || k.has("KeyZ"))) {
    const cur = (typeof p.walkSpeed === "number") ? p.walkSpeed : 12;
    const rate = Math.pow(4, dt);
    const factor = k.has("KeyX") ? rate : (1 / rate);
    p.walkSpeed = Math.max(1, Math.min(50000, cur * factor));
  }
  const speed    = (typeof p.walkSpeed        === "number") ? p.walkSpeed        : 12;
  const lookRate = (typeof p.lookSpeed        === "number") ? p.lookSpeed        : 2.0;
  const eyeH     = (typeof p.eyeHeight        === "number") ? p.eyeHeight        : 1.7;

  let px = (typeof p.posX === "number") ? p.posX : 0;
  let py = (typeof p.posY === "number") ? p.posY : 2;
  let pz = (typeof p.posZ === "number") ? p.posZ : 0;

  // === Sprint 8-8c: tangent-plane basis when on a planet ===
  // World yaw/pitch Euler angles don't work at non-pole latitudes --
  // the camera's "up" rotates with planet position, so mouse-look has
  // to be defined relative to the LOCAL up (radial). We store forward
  // as a 3D vector (re-derived from targetXYZ if it survives the
  // tick) and rotate it around the local up / right just like flight
  // mode does. Flat-terrain patches still use the Euler path so
  // legacy demos behave the same.
  const _walkPL = _findPlanetInfo();
  const _walkOnPlanet = _walkPL && state.nodes.some(n => n && n.type === "PlanetMesh");

  let upX, upY, upZ;
  if (_walkOnPlanet) {
    const rdx = px - _walkPL.centerX, rdy = py - _walkPL.centerY, rdz = pz - _walkPL.centerZ;
    const rLen = Math.hypot(rdx, rdy, rdz) || 1;
    upX = rdx / rLen; upY = rdy / rLen; upZ = rdz / rLen;
  } else {
    upX = 0; upY = 1; upZ = 0;
  }

  // Bring in the previous tick's forward (set via targetXYZ at the
  // end of last frame, by either walk OR flight). Fall back to a
  // yaw/pitch-derived forward if no target exists yet.
  let fx, fy, fz;
  const tdx = (typeof p.targetX === "number" ? p.targetX : 0) - px;
  const tdy = (typeof p.targetY === "number" ? p.targetY : 0) - py;
  const tdz = (typeof p.targetZ === "number" ? p.targetZ : 1) - pz;
  const tLen = Math.hypot(tdx, tdy, tdz);
  if (tLen > 1e-6) {
    fx = tdx / tLen; fy = tdy / tLen; fz = tdz / tLen;
  } else {
    const yaw0 = (typeof p.yaw === "number") ? p.yaw : 0;
    const pitch0 = (typeof p.pitch === "number") ? p.pitch : 0;
    const cy0 = Math.cos(yaw0), sy0 = Math.sin(yaw0);
    const cp0 = Math.cos(pitch0), sp0 = Math.sin(pitch0);
    fx = sy0 * cp0; fy = sp0; fz = cy0 * cp0;
  }

  // Mouse / key look deltas.
  let yawD = 0, pitchD = 0;
  if (input.pointerLocked) {
    yawD   -= input.mouseDx * sens;
    pitchD -= input.mouseDy * sens;
  }
  if (k.has("KeyJ")) yawD   -= lookRate * dt;
  if (k.has("KeyL")) yawD   += lookRate * dt;
  if (k.has("KeyI")) pitchD += lookRate * dt;
  if (k.has("KeyK")) pitchD -= lookRate * dt;

  // Build initial tangent-plane right vector: project forward onto
  // tangent plane and take its 90deg rotation around up.
  let fdu = fx*upX + fy*upY + fz*upZ;
  let fhX = fx - upX * fdu, fhY = fy - upY * fdu, fhZ = fz - upZ * fdu;
  let fhLen = Math.hypot(fhX, fhY, fhZ);
  if (fhLen < 1e-6) {
    // Forward is nearly parallel to up -- pick an arbitrary tangent.
    const refX = Math.abs(upX) < 0.9 ? 1 : 0;
    const refY = Math.abs(upX) < 0.9 ? 0 : 1;
    fhX = refX - upX * (refX*upX + refY*upY);
    fhY = refY - upY * (refX*upX + refY*upY);
    fhZ = 0    - upZ * (refX*upX + refY*upY);
    fhLen = Math.hypot(fhX, fhY, fhZ) || 1;
  }
  fhX /= fhLen; fhY /= fhLen; fhZ /= fhLen;
  // right = forward_h x up (matches flight-mode sign so D = right).
  let rX = fhY*upZ - fhZ*upY;
  let rY = fhZ*upX - fhX*upZ;
  let rZ = fhX*upY - fhY*upX;

  // Apply yaw around UP, then pitch around RIGHT.
  if (yawD !== 0) {
    const r1 = _rotAroundUnit(fx, fy, fz, upX, upY, upZ, yawD);
    fx = r1[0]; fy = r1[1]; fz = r1[2];
    fdu = fx*upX + fy*upY + fz*upZ;
    fhX = fx - upX * fdu; fhY = fy - upY * fdu; fhZ = fz - upZ * fdu;
    fhLen = Math.hypot(fhX, fhY, fhZ) || 1;
    fhX /= fhLen; fhY /= fhLen; fhZ /= fhLen;
    rX = fhY*upZ - fhZ*upY; rY = fhZ*upX - fhX*upZ; rZ = fhX*upY - fhY*upX;
  }
  if (pitchD !== 0) {
    const r2 = _rotAroundUnit(fx, fy, fz, rX, rY, rZ, pitchD);
    fx = r2[0]; fy = r2[1]; fz = r2[2];
  }
  // Pitch clamp: cap |sin(angle between forward and tangent)| at
  // sin(88deg) so the camera never goes fully vertical.
  const limSin = Math.sin(Math.PI * 0.49);
  const sinP = fx*upX + fy*upY + fz*upZ;
  if (Math.abs(sinP) > limSin) {
    const tgtSin = (sinP > 0) ? limSin : -limSin;
    const tgtCos = Math.sqrt(Math.max(0, 1 - tgtSin * tgtSin));
    fdu = fx*upX + fy*upY + fz*upZ;
    const hX = fx - upX * fdu, hY = fy - upY * fdu, hZ = fz - upZ * fdu;
    const hLen = Math.hypot(hX, hY, hZ) || 1;
    fx = hX / hLen * tgtCos + upX * tgtSin;
    fy = hY / hLen * tgtCos + upY * tgtSin;
    fz = hZ / hLen * tgtCos + upZ * tgtSin;
  }
  // Re-derive horiz + right after pitch clamp.
  fdu = fx*upX + fy*upY + fz*upZ;
  fhX = fx - upX * fdu; fhY = fy - upY * fdu; fhZ = fz - upZ * fdu;
  fhLen = Math.hypot(fhX, fhY, fhZ) || 1;
  fhX /= fhLen; fhY /= fhLen; fhZ /= fhLen;
  rX = fhY*upZ - fhZ*upY; rY = fhZ*upX - fhX*upZ; rZ = fhX*upY - fhY*upX;

  // Movement on the tangent plane.
  let dx = 0, dy = 0, dz = 0;
  if (k.has("KeyW")) { dx += fhX; dy += fhY; dz += fhZ; }
  if (k.has("KeyS")) { dx -= fhX; dy -= fhY; dz -= fhZ; }
  if (k.has("KeyD")) { dx += rX;  dy += rY;  dz += rZ;  }
  if (k.has("KeyA")) { dx -= rX;  dy -= rY;  dz -= rZ;  }
  const sprint = (k.has("ShiftLeft") || k.has("ShiftRight")) ? 4 : 1;
  const l = Math.hypot(dx, dy, dz);
  if (l > 0.0001) {
    const step = speed * sprint * dt;
    px += (dx / l) * step;
    py += (dy / l) * step;
    pz += (dz / l) * step;
  }

  // Sprint 10-6 v4: detect input-this-tick FIRST so the surf cache
  // below can decide whether to re-sample. Drift log uses this too.
  const _hasInputThisTick = (
    k.has("KeyW") || k.has("KeyA") || k.has("KeyS") || k.has("KeyD") ||
    k.has("KeyI") || k.has("KeyJ") || k.has("KeyK") || k.has("KeyL") ||
    k.has("KeyX") || k.has("KeyZ") || k.has("KeyR") || k.has("KeyF") ||
    k.has("Space") || k.has("ShiftLeft") || k.has("ShiftRight") ||
    Math.abs(input.mouseDx || 0) > 0.0001 ||
    Math.abs(input.mouseDy || 0) > 0.0001
  );

  // Snap to ground.
  const _preSnapPx = px, _preSnapPy = py, _preSnapPz = pz;
  if (_walkOnPlanet) {
    // Sprint 10-6 v5: surf cache with sanity checks. v4 froze surf
    // whenever no input was held -- but if camera was teleported or
    // the chunk rebuilt with very different alts, cached surf could
    // be hundreds of meters off, leaving the camera floating. v5
    // refreshes when:
    //   - Input is held (normal walking)
    //   - No cache yet
    //   - Cache > 2 seconds old (covers slow tile loads)
    //   - Cached surf is far (> 50 m) from current camera direction
    //     (covers teleport / large jumps)
    let surf;
    const now = (typeof performance !== "undefined") ? performance.now() : 0;
    let needsFresh = _hasInputThisTick || !input._cachedSurf;
    if (!needsFresh && input._cachedSurfTime
        && (now - input._cachedSurfTime) > 2000) {
      needsFresh = true;
    }
    if (!needsFresh && input._cachedSurf) {
      // Distance from cam to cached surf along the radial. If we've
      // moved far from the cached position (unexpected) recompute.
      const sdx = input._cachedSurf.x - px;
      const sdy = input._cachedSurf.y - py;
      const sdz = input._cachedSurf.z - pz;
      if ((sdx*sdx + sdy*sdy + sdz*sdz) > 50*50) needsFresh = true;
    }
    if (needsFresh) {
      surf = _planetMeshSurfacePos(px, py, pz, _walkPL);
      if (surf) {
        input._cachedSurf = surf;
        input._cachedSurfTime = now;
      }
    } else {
      surf = input._cachedSurf;
    }
    if (surf) {
      // Re-derive up at the new position (we moved along a flat
      // tangent plane but the planet is curved, so the radial just
      // rotated slightly).
      const rdx = px - _walkPL.centerX, rdy = py - _walkPL.centerY, rdz = pz - _walkPL.centerZ;
      const rLen = Math.hypot(rdx, rdy, rdz) || 1;
      upX = rdx / rLen; upY = rdy / rLen; upZ = rdz / rLen;
      px = surf.x + upX * eyeH;
      py = surf.y + upY * eyeH;
      pz = surf.z + upZ * eyeH;
    }
  } else {
    const groundY = _fpcSampleGroundY(px, pz, py);
    if (groundY !== null) py = groundY + eyeH;
  }
  if (!input._prevCamPos) input._prevCamPos = { x: null, y: null, z: null };
  const _prevPx = input._prevCamPos.x, _prevPy = input._prevCamPos.y, _prevPz = input._prevCamPos.z;
  if (_prevPx !== null && !_hasInputThisTick) {
    const drift = Math.hypot(px - _prevPx, py - _prevPy, pz - _prevPz);
    if (drift > 0.01) {
      const now = (typeof performance !== "undefined") ? performance.now() : 0;
      if (!input._lastDriftLog || (now - input._lastDriftLog) > 500) {
        input._lastDriftLog = now;
        const dPreX = _preSnapPx - _prevPx, dPreY = _preSnapPy - _prevPy, dPreZ = _preSnapPz - _prevPz;
        const dSnapX = px - _preSnapPx,    dSnapY = py - _preSnapPy,    dSnapZ = pz - _preSnapPz;
        const driftPre  = Math.hypot(dPreX, dPreY, dPreZ);
        const driftSnap = Math.hypot(dSnapX, dSnapY, dSnapZ);
        console.log("[cam-drift] no-input drift " + drift.toFixed(2) + "m total"
                  + " (pre-snap " + driftPre.toFixed(2) + "m, terrain-snap " + driftSnap.toFixed(2) + "m)"
                  + " | pos=(" + px.toFixed(0) + "," + py.toFixed(0) + "," + pz.toFixed(0) + ")");
      }
    }
  }
  input._prevCamPos.x = px; input._prevCamPos.y = py; input._prevCamPos.z = pz;

  p.posX = px; p.posY = py; p.posZ = pz;
  // Derive yaw/pitch from forward in the LOCAL frame so HUD and the
  // walk<->flight transition keep working. pitch = angle of forward
  // above tangent plane.
  p.pitch = Math.asin(Math.max(-1, Math.min(1, fx*upX + fy*upY + fz*upZ)));
  p.yaw   = Math.atan2(fx, fz);  // approximate; only used for HUD
  p.targetX = px + fx;
  p.targetY = py + fy;
  p.targetZ = pz + fz;
  p.upX = upX; p.upY = upY; p.upZ = upZ;
}

/* Rodrigues rotation of vector v around unit axis (ax, ay, az) by
 * angle a. Returns [vx', vy', vz'] in-place-safe (reads v first).
 * When axis is perpendicular to v (the common case for our basis
 * rotations) the formula simplifies, but we keep the general form. */
function _rotAroundUnit(vx, vy, vz, ax, ay, az, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const omc = 1 - c;
  const d = ax*vx + ay*vy + az*vz;
  const cx = ay*vz - az*vy;
  const cy = az*vx - ax*vz;
  const cz = ax*vy - ay*vx;
  return [
    vx*c + cx*s + ax*d*omc,
    vy*c + cy*s + ay*d*omc,
    vz*c + cz*s + az*d*omc
  ];
}

function _tickFPCameraFlight(node, p, dt, input, k) {
  const sens     = (typeof p.mouseSensitivity === "number") ? p.mouseSensitivity : 0.0025;
  if (k && (k.has("KeyX") || k.has("KeyZ"))) {
    const cur = (typeof p.walkSpeed === "number") ? p.walkSpeed : 12;
    const rate = Math.pow(4, dt);
    const factor = k.has("KeyX") ? rate : (1 / rate);
    p.walkSpeed = Math.max(1, Math.min(50000, cur * factor));
  }
  const speed    = (typeof p.walkSpeed        === "number") ? p.walkSpeed        : 12;
  const lookRate = (typeof p.lookSpeed        === "number") ? p.lookSpeed        : 2.0;

  let px = (typeof p.posX === "number") ? p.posX : 0;
  let py = (typeof p.posY === "number") ? p.posY : 2;
  let pz = (typeof p.posZ === "number") ? p.posZ : 0;

  // Build current basis (forward, up). If a meaningful target +
  // upX/Y/Z exist on the params (set by the demo OR carried from
  // the prior tick), use them directly -- they ARE the orientation.
  // Otherwise derive from yaw/pitch + world up (first tick after
  // entering flight mode from walk, or fresh node).
  let fx, fy, fz, ux, uy, uz;
  const tdx = (typeof p.targetX === "number" ? p.targetX : 0) - px;
  const tdy = (typeof p.targetY === "number" ? p.targetY : 0) - py;
  const tdz = (typeof p.targetZ === "number" ? p.targetZ : 1) - pz;
  const tLen = Math.hypot(tdx, tdy, tdz);
  const hasUp = (typeof p.upX === "number" && typeof p.upY === "number" && typeof p.upZ === "number")
                && (Math.abs(p.upX) + Math.abs(p.upY) + Math.abs(p.upZ) > 1e-6);
  if (tLen > 1e-6 && hasUp) {
    fx = tdx / tLen; fy = tdy / tLen; fz = tdz / tLen;
    const uLen = Math.hypot(p.upX, p.upY, p.upZ) || 1;
    ux = p.upX / uLen; uy = p.upY / uLen; uz = p.upZ / uLen;
  } else {
    const yaw   = (typeof p.yaw   === "number") ? p.yaw   : 0;
    const pitch = (typeof p.pitch === "number") ? p.pitch : 0;
    const cy = Math.cos(yaw),   sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    fx = sy * cp; fy = sp; fz = cy * cp;
    ux = 0; uy = 1; uz = 0;
  }
  // Gram-Schmidt to enforce orthogonality up front.
  {
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    const fu = fx*ux + fy*uy + fz*uz;
    ux -= fx * fu; uy -= fy * fu; uz -= fz * fu;
    const ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6) { ux = 0; uy = 1; uz = 0; }
    else { ux /= ul; uy /= ul; uz /= ul; }
  }
  // Right = up × forward (right-handed; at yaw=0 with up=+Y gives +X).
  let rx = uy*fz - uz*fy, ry = uz*fx - ux*fz, rz = ux*fy - uy*fx;

  // Rotation deltas
  let pitchD = 0, yawD = 0, rollD = 0;
  if (input.pointerLocked) {
    pitchD -= input.mouseDy * sens;
    yawD   -= input.mouseDx * sens;
  }
  if (k.has("KeyI")) pitchD += lookRate * dt;
  if (k.has("KeyK")) pitchD -= lookRate * dt;
  if (k.has("KeyJ")) yawD   -= lookRate * dt;
  if (k.has("KeyL")) yawD   += lookRate * dt;
  if (k.has("KeyU")) rollD  -= lookRate * dt;
  if (k.has("KeyO")) rollD  += lookRate * dt;

  // Pitch: rotate forward + up around right.
  if (pitchD !== 0) {
    const r1 = _rotAroundUnit(fx, fy, fz, rx, ry, rz, pitchD);
    fx = r1[0]; fy = r1[1]; fz = r1[2];
    const r2 = _rotAroundUnit(ux, uy, uz, rx, ry, rz, pitchD);
    ux = r2[0]; uy = r2[1]; uz = r2[2];
  }
  // Yaw: rotate forward + right around up.
  if (yawD !== 0) {
    const r1 = _rotAroundUnit(fx, fy, fz, ux, uy, uz, yawD);
    fx = r1[0]; fy = r1[1]; fz = r1[2];
    rx = uy*fz - uz*fy; ry = uz*fx - ux*fz; rz = ux*fy - uy*fx;
  }
  // Roll: rotate up + right around forward.
  if (rollD !== 0) {
    const r1 = _rotAroundUnit(ux, uy, uz, fx, fy, fz, rollD);
    ux = r1[0]; uy = r1[1]; uz = r1[2];
    rx = uy*fz - uz*fy; ry = uz*fx - ux*fz; rz = ux*fy - uy*fx;
  }
  // Re-normalize against drift.
  {
    const fl = Math.hypot(fx, fy, fz) || 1; fx/=fl; fy/=fl; fz/=fl;
    const fu = fx*ux + fy*uy + fz*uz;
    ux -= fx*fu; uy -= fy*fu; uz -= fz*fu;
    const ul = Math.hypot(ux, uy, uz) || 1; ux/=ul; uy/=ul; uz/=ul;
    rx = uy*fz - uz*fy; ry = uz*fx - ux*fz; rz = ux*fy - uy*fx;
  }

  // Movement: WASD along forward/right; Space/C along planet-radial.
  let dx = 0, dy = 0, dz = 0;
  if (k.has("KeyW")) { dx += fx; dy += fy; dz += fz; }
  if (k.has("KeyS")) { dx -= fx; dy -= fy; dz -= fz; }
  if (k.has("KeyD")) { dx += rx; dy += ry; dz += rz; }
  if (k.has("KeyA")) { dx -= rx; dy -= ry; dz -= rz; }
  const wantUp   = k.has("Space");
  const wantDown = k.has("KeyC") || k.has("ControlLeft") || k.has("ControlRight");
  if (wantUp || wantDown) {
    const sign = wantUp ? 1 : -1;
    const pUp = _planetRadialUp(px, py, pz);
    if (pUp) { dx += sign*pUp[0]; dy += sign*pUp[1]; dz += sign*pUp[2]; }
    else     { dy += sign; }
  }
  const sprint = (k.has("ShiftLeft") || k.has("ShiftRight")) ? 4 : 1;
  const l = Math.hypot(dx, dy, dz);
  if (l > 0.0001) {
    const step = speed * sprint * dt;
    px += (dx / l) * step;
    py += (dy / l) * step;
    pz += (dz / l) * step;
  }

  // Walk-dir tracking (used by TiledTerrain forwardBias; planet
  // ignores it but harmless to keep updated for mixed patches).
  const horizMoveLen = Math.hypot(dx, dz);
  if (horizMoveLen > 0.001) {
    const ndx = dx / horizMoveLen, ndz = dz / horizMoveLen;
    const tcFactor = Math.min(1, dt * 1.5);
    const wdx0 = (typeof p.walkDirX === "number") ? p.walkDirX : ndx;
    const wdz0 = (typeof p.walkDirZ === "number") ? p.walkDirZ : ndz;
    p.walkDirX = wdx0 + (ndx - wdx0) * tcFactor;
    p.walkDirZ = wdz0 + (ndz - wdz0) * tcFactor;
  }

  // Sprint 8-8: PlanetMesh ground collision + auto-switch to walk
  // mode when the camera touches down. Sliding rather than stopping
  // (we project to surface + eyeHeight along the radial) so flying
  // INTO terrain at speed doesn't lock the user up.
  const _flyPL = _findPlanetInfo();
  if (_flyPL && state.nodes.some(n => n && n.type === "PlanetMesh")) {
    const surf = _planetMeshSurfacePos(px, py, pz, _flyPL);
    if (surf) {
      const cdx = px - _flyPL.centerX, cdy = py - _flyPL.centerY, cdz = pz - _flyPL.centerZ;
      const sdx = surf.x - _flyPL.centerX, sdy = surf.y - _flyPL.centerY, sdz = surf.z - _flyPL.centerZ;
      const camR = Math.hypot(cdx, cdy, cdz);
      const surfR = Math.hypot(sdx, sdy, sdz);
      const agl = camR - surfR;
      const eyeH = (typeof p.eyeHeight === "number") ? p.eyeHeight : 1.7;
      // Land threshold: 1x eyeHeight. Below that we clamp + switch
      // to walk. Anything above is free flight.
      if (agl < eyeH) {
        const cLen = camR || 1;
        const upx = cdx / cLen, upy = cdy / cLen, upz = cdz / cLen;
        px = surf.x + upx * eyeH;
        py = surf.y + upy * eyeH;
        pz = surf.z + upz * eyeH;
        const autoWalk = (typeof p.autoWalkOnLand === "number") ? (p.autoWalkOnLand >= 0.5) : true;
        if (autoWalk) p.walkMode = 1;
      }
    }
  }

  p.posX = px; p.posY = py; p.posZ = pz;
  p.targetX = px + fx;
  p.targetY = py + fy;
  p.targetZ = pz + fz;
  p.upX = ux; p.upY = uy; p.upZ = uz;
  // Derive yaw/pitch from forward for display continuity. Roll is
  // implicit in the up vector and not extracted; switching back to
  // walk mode flattens up to world +Y.
  p.pitch = Math.asin(Math.max(-1, Math.min(1, fy)));
  p.yaw   = Math.atan2(fx, fz);
}

