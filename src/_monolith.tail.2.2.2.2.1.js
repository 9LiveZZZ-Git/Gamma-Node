

/* Phase 8.B.15 -- ThirdPersonCamera follow/orbit. Computes pos +
 * target into the node's params each frame so the existing
 * _evaluateCamera lookAt path renders it. Also outputs `yaw` for
 * camera-relative character movement. */
function _tickThirdPersonCameras(dt) {
  if (!state || !Array.isArray(state.nodes)) return;
  if (!(dt > 0) || dt > 0.1) dt = 1 / 60;
  for (const cn of state.nodes) {
    if (!cn || cn.type !== "ThirdPersonCamera") continue;
    if (!_isNodeActive(cn)) continue;
    const cp = cn.params = cn.params || {};
    const r = _resolveNodeParams(cn);
    const tx = r.targetX || 0, ty = (typeof r.targetY === "number" ? r.targetY : 1), tz = r.targetZ || 0;
    // mode: 0 follow · 1 over-shoulder · 2 top-down · 3 2.5d · 4 2d-side
    const mode = Math.round(typeof r.mode === "number" ? r.mode : 0);
    const dist = typeof r.distance === "number" ? r.distance : 6;
    const height = typeof r.height === "number" ? r.height : 2.4;
    const yawDeg = typeof r.orbitYaw === "number" ? r.orbitYaw : 0;
    const pitchDeg = typeof r.orbitPitch === "number" ? r.orbitPitch : -12;
    const shoulder = typeof r.shoulder === "number" ? r.shoulder : 0.9;
    const smooth = Math.max(0, Math.min(0.95, typeof r.smooth === "number" ? r.smooth : 0.18));
    // Smooth follow point (lazy lerp).
    if (!cn._fp) cn._fp = { x: tx, y: ty, z: tz };
    const a = 1 - smooth;
    cn._fp.x += (tx - cn._fp.x) * a;
    cn._fp.y += (ty - cn._fp.y) * a;
    cn._fp.z += (tz - cn._fp.z) * a;
    const fp = cn._fp;
    let px, py, pz, camYaw;
    let tgX = fp.x, tgY = fp.y, tgZ = fp.z;
    if (mode === 4) {
      // 2D side: orthographic, look along -Z.
      px = fp.x; py = fp.y; pz = fp.z + dist;
      cp.mode = 1;                                   // ortho in _evaluateCamera
      cp.orthoSize = typeof r.orthoSize === "number" ? r.orthoSize : 7;
      camYaw = 0;
    } else if (mode === 2) {
      // Top-down: high overhead with a slight back-tilt so the lookAt
      // up-vector stays well-defined; orbitYaw still sets the movement
      // "forward" reference for the controller.
      px = fp.x; py = fp.y + dist; pz = fp.z - dist * 0.2;
      tgY = fp.y;
      cp.mode = 0;
      camYaw = yawDeg;
    } else {
      // Perspective trailing rigs: follow(0), over-shoulder(1), 2.5d(3).
      // Same orbit math; over-shoulder shifts the rig + aim to one side
      // so the character frames off-centre (classic TPS), 2.5d locks a
      // fixed ¾ angle.
      let yw = yawDeg, pt = pitchDeg;
      if (mode === 3) { yw = 25; pt = -28; }
      const yr = yw * Math.PI / 180, pr = pt * Math.PI / 180;
      const horiz = Math.cos(pr) * dist;
      px = fp.x - Math.sin(yr) * horiz;
      pz = fp.z - Math.cos(yr) * horiz;
      py = fp.y + height - Math.sin(pr) * dist;
      tgY = fp.y + 0.6;                              // aim at the upper body, not the feet
      if (mode === 1) {
        const rX = Math.cos(yr), rZ = -Math.sin(yr); // camera-right in XZ
        px += rX * shoulder; pz += rZ * shoulder;
        tgX += rX * shoulder * 0.7; tgZ += rZ * shoulder * 0.7;
      }
      cp.mode = 0;                                   // perspective
      camYaw = yw;
    }
    cp.posX = px; cp.posY = py; cp.posZ = pz;
    cp.targetX = tgX; cp.targetY = tgY; cp.targetZ = tgZ;
    cp.upX = 0; cp.upY = 1; cp.upZ = 0;
    cp.fov = typeof r.fov === "number" ? r.fov : 60;
    cp.near = typeof r.near === "number" ? r.near : 0.1;
    cp.far = typeof r.far === "number" ? r.far : 400;
    cp.yaw = camYaw;
  }
}

/* Phase 8.B.15 -- BlobController3D. Camera-relative movement + jump
 * for a wired capsule RigidBody3D. Runs inside _tickPhysics3D's
 * pre-step pass (sets the body velocity; the step integrates it). */
function _tickBlobControllers3D(worldNode, world, bodyMap, RAPIER, dtSec) {
  for (const bc of state.nodes) {
    if (!bc || bc.type !== "BlobController3D") continue;
    if (!_isNodeActive(bc)) continue;
    let wired = false;
    for (const e of state.edges) {
      if (e && e.to && e.to.node === bc.id && e.to.port === "world" && e.from && e.from.node === worldNode.id) { wired = true; break; }
    }
    if (!wired) continue;
    const bp = bc.params = bc.params || {};
    const r = _resolveNodeParams(bc);
    if ((typeof r.enabled === "number" ? r.enabled : 1) < 0.5) continue;
    const bodyRef = _findWiredBodyNodePort3D(bc, "body");
    if (!bodyRef || !bodyMap.has(bodyRef.id)) continue;
    const handle = bodyMap.get(bodyRef.id).handle;
    const moveSpeed = typeof r.moveSpeed === "number" ? r.moveSpeed : 6;
    const jumpSpeed = typeof r.jumpSpeed === "number" ? r.jumpSpeed : 8;
    const camYaw = (typeof r.camYaw === "number" ? r.camYaw : 0) * Math.PI / 180;
    const airControl = Math.max(0, Math.min(1, typeof r.airControl === "number" ? r.airControl : 0.6));
    // inputX is negated so A/D strafe matches on-screen left/right —
    // the scene projection mirrors world X relative to the camera basis,
    // so the textbook camera-relative result comes out reversed.
    const ix = -(typeof r.inputX === "number" ? r.inputX : 0);
    const iz = typeof r.inputZ === "number" ? r.inputZ : 0;
    const s = Math.sin(camYaw), c = Math.cos(camYaw);
    const gvx = (iz * s + ix * c) * moveSpeed;
    const gvz = (iz * c - ix * s) * moveSpeed;
    const pos = handle.translation();
    // Ground test: short downward ray from the body centre, excluding
    // the blob's own body.
    let grounded = false;
    try {
      const ray = new RAPIER.Ray({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 1.25, true, undefined, undefined, undefined, handle);
      grounded = !!hit;
    } catch (_) {}
    const vel = handle.linvel();
    const blend = grounded ? 1 : airControl;
    let nvx = vel.x + (gvx - vel.x) * blend;
    let nvz = vel.z + (gvz - vel.z) * blend;
    let nvy = vel.y;
    const jnow = typeof r.jump === "number" ? r.jump : 0;
    let jumped = 0;
    if (jnow >= 0.5 && (bp._prevJump || 0) < 0.5 && grounded) { nvy = jumpSpeed; jumped = 1; }
    bp._prevJump = jnow;
    if ((typeof r.planeLock === "number" ? r.planeLock : 0) >= 0.5) {
      nvz = (0 - pos.z) * 6;   // pull + hold Blob on the z=0 plane (2D level)
    }
    try { handle.setLinvel({ x: nvx, y: nvy, z: nvz }, true); } catch (_) {}
    bp.grounded = grounded ? 1 : 0;
    bp.vx = nvx; bp.vz = nvz;
    bp.speed = Math.hypot(nvx, nvz);
    bp.jumped = jumped;
    if (bp.speed > 0.3) bp.facing = Math.atan2(nvx, nvz) * 180 / Math.PI;
    // Keep the pill upright + turned toward movement (a free capsule
    // tips over on contact; we control orientation directly instead of
    // adding a rotation-lock flag to RigidBody3D).
    try {
      handle.setAngvel({ x: 0, y: 0, z: 0 }, true);
      const half = (bp.facing || 0) * Math.PI / 360;
      handle.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    } catch (_) {}
  }
}

