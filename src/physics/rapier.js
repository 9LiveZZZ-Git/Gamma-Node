/* ── Phase 8.B.1 -- Rapier 2D physics tick ────────────────────────
 * Lazy-loads @dimforge/rapier2d-compat WASM on first PhysicsWorld2D
 * tick (CDN import, ~1.2 MB, cached by browser). Steps every
 * PhysicsWorld2D each frame; bodies + colliders register on first
 * tick. Outputs (x/y/rotation/vx/vy/angularVel) written back each
 * frame so downstream Translate/Rotate consumers read via wires.
 *
 * Runs AFTER _tickLifecycleNodes (so OnAwake-triggered resets
 * have fired) and BEFORE _tickGameInputs. */
let _rapierModule = null;
let _rapierLoadPromise = null;

async function _ensureRapier() {
  if (_rapierModule) return _rapierModule;
  if (_rapierLoadPromise) return _rapierLoadPromise;
  console.log("[physics] loading Rapier 2D WASM...");
  _rapierLoadPromise = (async () => {
    try {
      const RAPIER = await import(
        "https://cdn.jsdelivr.net/npm/@dimforge/rapier2d-compat@0.14.0/+esm"
      );
      await RAPIER.init();
      _rapierModule = RAPIER;
      console.log("[physics] Rapier 2D WASM loaded");
      return RAPIER;
    } catch (e) {
      console.error("[physics] Rapier load failed:", e);
      _rapierLoadPromise = null;
      return null;
    }
  })();
  return _rapierLoadPromise;
}

function _findWiredBodyNode(colliderNode) {
  return _findWiredBodyNodePort(colliderNode, "body");
}

function _findWiredBodyNodePort(node, portName) {
  if (!state || !Array.isArray(state.edges)) return null;
  for (const e of state.edges) {
    if (!e || !e.to || e.to.node !== node.id || e.to.port !== portName) continue;
    if (!e.from) continue;
    const src = state.nodes.find(n => n && n.id === e.from.node);
    if (src && src.type === "RigidBody2D") return src;
  }
  return null;
}

function _tickPhysics(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  let hasWorld = false;
  for (const n of state.nodes) {
    if (n && n.type === "PhysicsWorld2D") { hasWorld = true; break; }
  }
  if (!hasWorld) return;
  if (!(dtSec > 0) || dtSec > 0.034) dtSec = 0.034;

  if (!_rapierModule) {
    _ensureRapier();
    return;
  }
  const RAPIER = _rapierModule;

  for (const worldNode of state.nodes) {
    if (!worldNode || worldNode.type !== "PhysicsWorld2D") continue;
    if (!_isNodeActive(worldNode)) {
      if (worldNode._rapierWorld) {
        worldNode._rapierWorld.free();
        worldNode._rapierWorld = null;
        worldNode._bodyMap = null;
      }
      continue;
    }
    const wp = worldNode.params = worldNode.params || {};
    const resolved = _resolveNodeParams(worldNode);
    if ((typeof resolved.enabled === "number" ? resolved.enabled : 1) < 0.5) continue;

    const gx = typeof resolved.gravityX === "number" ? resolved.gravityX : 0;
    const gy = typeof resolved.gravityY === "number" ? resolved.gravityY : -9.8;

    if (!worldNode._rapierWorld) {
      worldNode._rapierWorld = new RAPIER.World({ x: gx, y: gy });
      worldNode._bodyMap = new Map();
      wp.ready = 1;
      console.log("[physics] PhysicsWorld2D created, gravity=(" + gx + "," + gy + ")");
    }
    const world = worldNode._rapierWorld;
    const bodyMap = worldNode._bodyMap;
    world.gravity = { x: gx, y: gy };

    // Find bodies wired to this world (R.1: explicit world wiring)
    const wiredBodies = new Set();
    for (const e of state.edges) {
      if (!e || !e.from || e.from.node !== worldNode.id || e.from.port !== "world") continue;
      if (!e.to) continue;
      const target = state.nodes.find(n => n && n.id === e.to.node);
      if (target && target.type === "RigidBody2D") wiredBodies.add(target.id);
    }

    // Cleanup: remove bodies no longer wired to this world
    for (const [nodeId, entry] of bodyMap) {
      if (!wiredBodies.has(nodeId)) {
        world.removeRigidBody(entry.handle);
        bodyMap.delete(nodeId);
      }
    }

    // Pass 1: register / update / reset wired RigidBody2D nodes
    for (const bodyNode of state.nodes) {
      if (!bodyNode || bodyNode.type !== "RigidBody2D") continue;
      if (!wiredBodies.has(bodyNode.id)) continue;
      if (!_isNodeActive(bodyNode)) {
        if (bodyMap.has(bodyNode.id)) {
          const entry = bodyMap.get(bodyNode.id);
          world.removeRigidBody(entry.handle);
          bodyMap.delete(bodyNode.id);
        }
        continue;
      }
      const bp = bodyNode.params = bodyNode.params || {};
      const br = _resolveNodeParams(bodyNode);
      const bodyTypeStr = (typeof br.type === "string") ? br.type : "dynamic";

      const resetNow = typeof br.reset === "number" ? br.reset : 0;
      const resetEdge = resetNow >= 0.5 && (bp._prevReset || 0) < 0.5;

      if (!bp._inited || resetEdge) {
        bp.x = typeof br.initX === "number" ? br.initX : 0;
        bp.y = typeof br.initY === "number" ? br.initY : 0;
        bp.rotation = typeof br.initRotation === "number" ? br.initRotation : 0;
        const ivx = typeof br.initVx === "number" ? br.initVx : 0;
        const ivy = typeof br.initVy === "number" ? br.initVy : 0;
        bp.vx = ivx; bp.vy = ivy; bp.angularVel = 0;
        bp._inited = 1;

        if (bodyMap.has(bodyNode.id)) {
          const entry = bodyMap.get(bodyNode.id);
          entry.handle.setTranslation({ x: bp.x, y: bp.y }, true);
          entry.handle.setRotation(bp.rotation * Math.PI / 180, true);
          entry.handle.setLinvel({ x: ivx, y: ivy }, true);
          entry.handle.setAngvel(0, true);
        }
      }
      bp._prevReset = resetNow;

      if (!bodyMap.has(bodyNode.id)) {
        let rbType;
        if (bodyTypeStr === "static") rbType = RAPIER.RigidBodyType.Fixed;
        else if (bodyTypeStr === "kinematic") rbType = RAPIER.RigidBodyType.KinematicPositionBased;
        else rbType = RAPIER.RigidBodyType.Dynamic;

        const desc = new RAPIER.RigidBodyDesc(rbType)
          .setTranslation(bp.x, bp.y)
          .setRotation(bp.rotation * Math.PI / 180)
          .setLinearDamping(typeof br.linearDamping === "number" ? br.linearDamping : 0)
          .setAngularDamping(typeof br.angularDamping === "number" ? br.angularDamping : 0)
          .setGravityScale(typeof br.gravityScale === "number" ? br.gravityScale : 1);
        if ((typeof br.fixedRotation === "number" ? br.fixedRotation : 0) >= 0.5) {
          desc.lockRotations();
        }
        if ((typeof br.ccd === "number" ? br.ccd : 0) >= 0.5) desc.setCcdEnabled(true);
        const handle = world.createRigidBody(desc);
        bodyMap.set(bodyNode.id, { handle, colliderIds: [] });
      }

      const entry = bodyMap.get(bodyNode.id);
      entry.handle.setLinearDamping(typeof br.linearDamping === "number" ? br.linearDamping : 0);
      entry.handle.setAngularDamping(typeof br.angularDamping === "number" ? br.angularDamping : 0);
      entry.handle.setGravityScale(typeof br.gravityScale === "number" ? br.gravityScale : 1);
      try { entry.handle.enableCcd((typeof br.ccd === "number" ? br.ccd : 0) >= 0.5); } catch (_) {}

      // Clear accumulated forces then apply this tick's forces.
      // Rapier's addForce accumulates; without reset the body
      // accelerates without bound.
      try { entry.handle.resetForces(false); } catch (_) {}
      const fScale = typeof br.forceScale === "number" ? br.forceScale : 1;
      const fx = (typeof br.forceX === "number" ? br.forceX : 0) * fScale;
      const fy = (typeof br.forceY === "number" ? br.forceY : 0) * fScale;
      if (fx !== 0 || fy !== 0) entry.handle.addForce({ x: fx, y: fy }, true);
      const iScale = typeof br.impulseScale === "number" ? br.impulseScale : 1;
      const ix = (typeof br.impulseX === "number" ? br.impulseX : 0) * iScale;
      const iy = (typeof br.impulseY === "number" ? br.impulseY : 0) * iScale;
      if (ix !== 0 || iy !== 0) entry.handle.applyImpulse({ x: ix, y: iy }, true);
    }

    // Pass 2: register colliders (Box, Circle, Capsule)
    const _colliderTypes = ["BoxCollider2D", "CircleCollider2D", "CapsuleCollider2D"];
    for (const collNode of state.nodes) {
      if (!collNode) continue;
      if (_colliderTypes.indexOf(collNode.type) < 0) continue;
      if (!_isNodeActive(collNode)) continue;
      if (collNode._rapierColliderAttached) continue;

      const bodyRef = _findWiredBodyNode(collNode);
      if (!bodyRef || !bodyMap.has(bodyRef.id)) continue;
      const bodyEntry = bodyMap.get(bodyRef.id);

      const cp = _resolveNodeParams(collNode);
      let colliderDesc;
      if (collNode.type === "BoxCollider2D") {
        const hw = (typeof cp.width === "number" ? cp.width : 1) * 0.5;
        const hh = (typeof cp.height === "number" ? cp.height : 1) * 0.5;
        colliderDesc = RAPIER.ColliderDesc.cuboid(Math.max(0.01, hw), Math.max(0.01, hh));
      } else if (collNode.type === "CapsuleCollider2D") {
        const r = Math.max(0.01, typeof cp.radius === "number" ? cp.radius : 0.25);
        const hh = Math.max(0.01, typeof cp.halfHeight === "number" ? cp.halfHeight : 0.5);
        colliderDesc = RAPIER.ColliderDesc.capsule(hh, r);
      } else {
        const r = typeof cp.radius === "number" ? cp.radius : 0.5;
        colliderDesc = RAPIER.ColliderDesc.ball(Math.max(0.01, r));
      }
      colliderDesc
        .setTranslation(
          typeof cp.offsetX === "number" ? cp.offsetX : 0,
          typeof cp.offsetY === "number" ? cp.offsetY : 0)
        .setDensity(typeof cp.density === "number" ? cp.density : 1)
        .setFriction(typeof cp.friction === "number" ? cp.friction : 0.5)
        .setRestitution(typeof cp.restitution === "number" ? cp.restitution : 0.3)
        .setSensor((typeof cp.isSensor === "number" ? cp.isSensor : 0) >= 0.5)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

      world.createCollider(colliderDesc, bodyEntry.handle);
      collNode._rapierColliderAttached = true;
      bodyEntry.colliderIds.push(collNode.id);
    }

    // Pass 2.4 (8.B.4): TilemapCollider2D — auto-build box colliders
    // from solid tilemap cells, greedy-merged into rectangles.
    for (const tcNode of state.nodes) {
      if (!tcNode || tcNode.type !== "TilemapCollider2D") continue;
      if (!_isNodeActive(tcNode)) continue;
      // Check world wire
      let wiredToThisWorld = false;
      for (const e of state.edges) {
        if (e && e.to && e.to.node === tcNode.id && e.to.port === "world" &&
            e.from && e.from.node === worldNode.id) { wiredToThisWorld = true; break; }
      }
      if (!wiredToThisWorld) continue;

      // Find the tilemap source (Level2D or Tilemap2D via "tilemap" wire)
      let tnode = null;
      for (const e of state.edges) {
        if (!e || !e.to || e.to.node !== tcNode.id || e.to.port !== "tilemap") continue;
        if (!e.from) continue;
        const src = state.nodes.find(n => n && n.id === e.from.node);
        if (!src) continue;
        if (src.type === "Tilemap2D") { tnode = src; break; }
        if (src.type === "Level2D") { tnode = _level2dCollidableTilemap(src); break; }
      }
      if (!tnode) continue;

      // Parse tileData + build a cache key to detect changes
      const tp = tnode.params || {};
      const data = (typeof tp.tileData === "string") ? tp.tileData : "";
      const ts = (typeof tp.tileSize === "number" && tp.tileSize > 0) ? tp.tileSize : 1;
      const ox = (typeof tp.originX === "number") ? tp.originX : 0;
      const oy = (typeof tp.originY === "number") ? tp.originY : 0;
      const cacheKey = data + "|" + ts + "|" + ox + "|" + oy;
      if (tcNode._tmColliderCacheKey === cacheKey) continue;

      // Tear down previous colliders
      if (tcNode._tmRapierBody) {
        try { world.removeRigidBody(tcNode._tmRapierBody); } catch (_) {}
        tcNode._tmRapierBody = null;
      }

      // Parse tile grid
      const rowsArr = data.split(/\r?\n/);
      const rows = rowsArr.length;
      const cols = rowsArr.reduce((m, r) => Math.max(m, r.length), 0);
      if (rows === 0 || cols === 0) { tcNode._tmColliderCacheKey = cacheKey; continue; }

      // Build solid bitmap
      const solid = new Uint8Array(rows * cols);
      for (let r = 0; r < rows; r++) {
        const line = rowsArr[r];
        for (let c = 0; c < line.length; c++) {
          const ch = line[c];
          if (ch !== "." && ch !== " " && ch !== "" && ch !== "4" && ch !== "5") {
            solid[r * cols + c] = 1;
          }
        }
      }

      // Greedy merge: scan left-to-right, top-to-bottom, merge
      // horizontally first then extend vertically.
      const used = new Uint8Array(rows * cols);
      const rects = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!solid[r * cols + c] || used[r * cols + c]) continue;
          // Extend right
          let w = 1;
          while (c + w < cols && solid[r * cols + c + w] && !used[r * cols + c + w]) w++;
          // Extend down
          let h = 1;
          outer: while (r + h < rows) {
            for (let ci = c; ci < c + w; ci++) {
              if (!solid[(r + h) * cols + ci] || used[(r + h) * cols + ci]) break outer;
            }
            h++;
          }
          // Mark used
          for (let ri = r; ri < r + h; ri++)
            for (let ci = c; ci < c + w; ci++) used[ri * cols + ci] = 1;
          rects.push({ col: c, row: r, w, h });
        }
      }

      // Create a single static body + one box collider per merged rect
      const cx = (cols - 1) * 0.5;
      const cy = (rows - 1) * 0.5;
      const bodyDesc = new RAPIER.RigidBodyDesc(RAPIER.RigidBodyType.Fixed)
        .setTranslation(0, 0);
      const tmBody = world.createRigidBody(bodyDesc);
      const tcp = _resolveNodeParams(tcNode);
      const fric = typeof tcp.friction === "number" ? tcp.friction : 0.6;
      const rest = typeof tcp.restitution === "number" ? tcp.restitution : 0.1;

      for (const rect of rects) {
        const halfW = rect.w * ts * 0.5;
        const halfH = rect.h * ts * 0.5;
        const worldX = (rect.col + rect.w * 0.5 - 0.5 - cx) * ts + ox;
        const worldY = (cy - (rect.row + rect.h * 0.5 - 0.5)) * ts + oy;
        const cd = RAPIER.ColliderDesc.cuboid(halfW, halfH)
          .setTranslation(worldX, worldY)
          .setFriction(fric)
          .setRestitution(rest)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        world.createCollider(cd, tmBody);
      }

      tcNode._tmRapierBody = tmBody;
      tcNode._tmColliderCacheKey = cacheKey;
      const tcp2 = tcNode.params = tcNode.params || {};
      tcp2.colliderCount = rects.length;
      console.log("[physics] TilemapCollider2D: " + rects.length + " colliders from " +
        rows + "×" + cols + " grid (" + solid.reduce((a, v) => a + v, 0) + " solid cells)");
    }

    // Pass 2.5 (8.B.3): create joints
    const _jointTypes = ["RevoluteJoint2D", "DistanceJoint2D", "PrismaticJoint2D", "WeldJoint2D"];
    for (const jNode of state.nodes) {
      if (!jNode || _jointTypes.indexOf(jNode.type) < 0) continue;
      if (!_isNodeActive(jNode)) continue;
      if (jNode._rapierJointAttached) continue;

      const bodyARef = _findWiredBodyNodePort(jNode, "bodyA");
      const bodyBRef = _findWiredBodyNodePort(jNode, "bodyB");
      if (!bodyARef || !bodyBRef) {
        if (!jNode._jointWarnLogged) { console.warn("[physics] " + jNode.type + " " + jNode.id + ": missing bodyA or bodyB wire"); jNode._jointWarnLogged = true; }
        continue;
      }
      if (!bodyMap.has(bodyARef.id) || !bodyMap.has(bodyBRef.id)) {
        if (!jNode._jointWarnLogged) { console.warn("[physics] " + jNode.type + " " + jNode.id + ": bodies not in world yet"); jNode._jointWarnLogged = true; }
        continue;
      }
      const hA = bodyMap.get(bodyARef.id).handle;
      const hB = bodyMap.get(bodyBRef.id).handle;
      const jp = _resolveNodeParams(jNode);
      const aAx = typeof jp.anchorAx === "number" ? jp.anchorAx : 0;
      const aAy = typeof jp.anchorAy === "number" ? jp.anchorAy : 0;
      const aBx = typeof jp.anchorBx === "number" ? jp.anchorBx : 0;
      const aBy = typeof jp.anchorBy === "number" ? jp.anchorBy : 0;

      try {
        let jd;
        if (jNode.type === "RevoluteJoint2D") {
          jd = RAPIER.JointData.revolute({ x: aAx, y: aAy }, { x: aBx, y: aBy });
          if ((typeof jp.enableLimit === "number" ? jp.enableLimit : 0) >= 0.5) {
            jd.limitsEnabled = true;
            jd.limits = [
              (typeof jp.lowerAngle === "number" ? jp.lowerAngle : -180) * Math.PI / 180,
              (typeof jp.upperAngle === "number" ? jp.upperAngle : 180) * Math.PI / 180
            ];
          }
        } else if (jNode.type === "DistanceJoint2D") {
          jd = RAPIER.JointData.spring(
            typeof jp.restLength === "number" ? jp.restLength : 2,
            typeof jp.stiffness === "number" ? jp.stiffness : 1,
            typeof jp.damping === "number" ? jp.damping : 0.1,
            { x: aAx, y: aAy }, { x: aBx, y: aBy }
          );
        } else if (jNode.type === "PrismaticJoint2D") {
          const ax = typeof jp.axisX === "number" ? jp.axisX : 1;
          const ay = typeof jp.axisY === "number" ? jp.axisY : 0;
          jd = RAPIER.JointData.prismatic({ x: aAx, y: aAy }, { x: aBx, y: aBy }, { x: ax, y: ay });
          if ((typeof jp.enableLimit === "number" ? jp.enableLimit : 0) >= 0.5) {
            jd.limitsEnabled = true;
            jd.limits = [
              typeof jp.lowerLimit === "number" ? jp.lowerLimit : -1,
              typeof jp.upperLimit === "number" ? jp.upperLimit : 1
            ];
          }
        } else {
          jd = RAPIER.JointData.fixed(
            { x: aAx, y: aAy }, 0,
            { x: aBx, y: aBy }, 0
          );
        }
        const joint = world.createImpulseJoint(jd, hA, hB, true);
        if (jNode.type === "RevoluteJoint2D" && (typeof jp.enableMotor === "number" ? jp.enableMotor : 0) >= 0.5) {
          joint.configureMotorVelocity(
            (typeof jp.motorSpeed === "number" ? jp.motorSpeed : 0) * Math.PI / 180,
            typeof jp.motorMaxTorque === "number" ? jp.motorMaxTorque : 10
          );
        }
        jNode._rapierJointHandle = joint;
        jNode._rapierJointAttached = true;
        console.log("[physics] " + jNode.type + " created between " + bodyARef.id + " and " + bodyBRef.id);
      } catch (e) {
        console.error("[physics] joint creation failed:", e);
        jNode._rapierJointAttached = true;
      }
    }

    // Step the world with event queue
    if (!worldNode._eventQueue) worldNode._eventQueue = new RAPIER.EventQueue(true);
    const eventQueue = worldNode._eventQueue;
    const timeScale = typeof resolved.timeScale === "number" ? resolved.timeScale : 1;
    const subSteps = Math.max(1, Math.min(16,
      Math.round(typeof resolved.subSteps === "number" ? resolved.subSteps : 4)));
    world.timestep = (dtSec * timeScale) / subSteps;
    for (let s = 0; s < subSteps; s++) world.step(eventQueue);

    // Pass 3: read back body state
    let bodyCount = 0;
    for (const bodyNode of state.nodes) {
      if (!bodyNode || bodyNode.type !== "RigidBody2D") continue;
      if (!bodyMap.has(bodyNode.id)) continue;
      bodyCount++;
      const entry = bodyMap.get(bodyNode.id);
      const pos = entry.handle.translation();
      const vel = entry.handle.linvel();
      const bp = bodyNode.params;
      bp.x = pos.x;
      bp.y = pos.y;
      bp.rotation = entry.handle.rotation() * 180 / Math.PI;
      bp.vx = vel.x;
      bp.vy = vel.y;
      bp.angularVel = entry.handle.angvel();
    }
    wp.bodyCount = bodyCount;

    // Pass 3.5 (8.B.3): read joint angles
    for (const jNode of state.nodes) {
      if (!jNode || jNode.type !== "RevoluteJoint2D") continue;
      if (!jNode._rapierJointHandle) continue;
      const jp = jNode.params = jNode.params || {};
      try {
        if (typeof jNode._rapierJointHandle.angle === "function") {
          jp.angle = jNode._rapierJointHandle.angle() * 180 / Math.PI;
        } else {
          const bA = _findWiredBodyNodePort(jNode, "bodyA");
          const bB = _findWiredBodyNodePort(jNode, "bodyB");
          if (bA && bB && bA.params && bB.params) {
            jp.angle = (bB.params.rotation || 0) - (bA.params.rotation || 0);
          }
        }
      } catch (_) {}
    }

    // Pass 3.6 (8.B.3): process contact events
    // Drain collision events (sensor intersections + contact start/end)
    const prevTouching = worldNode._contactingPairs || new Set();
    const currentTouching = new Set();
    eventQueue.drainCollisionEvents((h1, h2, started) => {
      const key = h1 < h2 ? h1 + ":" + h2 : h2 + ":" + h1;
      if (started) currentTouching.add(key);
    });
    // Carry forward pairs that didn't get an "ended" event this tick
    for (const k of prevTouching) {
      if (currentTouching.has(k)) continue;
      // Check: did we get an explicit "ended" for this key? If not,
      // it's still touching (Rapier only fires on transitions).
      currentTouching.add(k);
    }
    // Re-drain to catch "ended" events and remove them
    // (already drained above, so use a flag-based approach instead)
    // Actually: Rapier fires started=false for ended. We need to
    // capture those. Let's redo with a simpler approach:
    // We already drained — started=true events are in currentTouching.
    // For started=false, they were NOT added. But we also carried
    // forward all prevTouching. We need to remove ended pairs.
    // The issue: drainCollisionEvents already consumed the events.
    // Fix: capture both started and ended in one pass.
    // Let's redo properly.
    worldNode._contactingPairs = new Set();
    // Re-step approach won't work since events are drained.
    // Instead: track via the intersection test API directly.

    // Build collider-handle → bodyNodeId map
    const colliderToBody = new Map();
    world.forEachCollider(c => {
      const rb = c.parent();
      if (!rb) return;
      for (const [nodeId, entry] of bodyMap) {
        if (entry.handle === rb) { colliderToBody.set(c.handle, nodeId); break; }
      }
    });

    // For each ContactEvent2D, directly test intersection between
    // the two bodies' colliders using Rapier's intersection test.
    let contactCount = 0;
    for (const evNode of state.nodes) {
      if (!evNode || evNode.type !== "ContactEvent2D") continue;
      if (!_isNodeActive(evNode)) continue;
      const ep = evNode.params = evNode.params || {};
      const refA = _findWiredBodyNodePort(evNode, "bodyA");
      const refB = _findWiredBodyNodePort(evNode, "bodyB");
      if (!refA || !refB) { ep.touching = 0; ep.enterTrigger = 0; ep.exitTrigger = 0; continue; }

      // Use body positions + collider shapes to test overlap.
      // Rapier's intersectionsWithShape is reliable across compat
      // versions; intersectionPair has API variance.
      let touching = false;
      const entryA = bodyMap.get(refA.id);
      const entryB = bodyMap.get(refB.id);
      if (entryA && entryB) {
        const posA = entryA.handle.translation();
        const posB = entryB.handle.translation();
        // For each collider on bodyB, test if it overlaps bodyA's colliders
        world.forEachCollider(cb => {
          if (touching) return;
          const rbB = cb.parent();
          if (!rbB || rbB !== entryB.handle) return;
          world.forEachCollider(ca => {
            if (touching) return;
            const rbA = ca.parent();
            if (!rbA || rbA !== entryA.handle) return;
            // Use narrow-phase intersection test
            try {
              if (typeof world.intersectionPair === "function" && world.intersectionPair(ca, cb)) { touching = true; return; }
            } catch (_) {}
            // Fallback: AABB overlap from collider shapes
            try {
              const aabbA = ca.aabb ? ca.aabb() : null;
              const aabbB = cb.aabb ? cb.aabb() : null;
              if (aabbA && aabbB) {
                if (aabbA.mins.x <= aabbB.maxs.x && aabbA.maxs.x >= aabbB.mins.x &&
                    aabbA.mins.y <= aabbB.maxs.y && aabbA.maxs.y >= aabbB.mins.y) {
                  touching = true;
                }
              }
            } catch (_) {}
          });
        });
      }

      const wasTouching = !!(evNode._wasTouching);
      ep.touching = touching ? 1 : 0;
      ep.enterTrigger = (touching && !wasTouching) ? 1 : 0;
      ep.exitTrigger = (!touching && wasTouching) ? 1 : 0;
      if (ep.enterTrigger) ep.enterCount = (ep.enterCount || 0) + 1;
      evNode._wasTouching = touching;
      if (touching) contactCount++;
    }
    wp.contactCount = contactCount;

    // Pass 4 (8.B.2 + 8.B.9 Spherecast2D): run queries wired to THIS world
    for (const qNode of state.nodes) {
      if (!qNode) continue;
      if (qNode.type !== "Raycast2D" && qNode.type !== "OverlapCircle2D" && qNode.type !== "OverlapBox2D" && qNode.type !== "Spherecast2D") continue;
      if (!_isNodeActive(qNode)) continue;
      // Check world wire: query must be wired to this PhysicsWorld2D
      let wiredToThisWorld = false;
      for (const e of state.edges) {
        if (e && e.to && e.to.node === qNode.id && e.to.port === "world" &&
            e.from && e.from.node === worldNode.id) { wiredToThisWorld = true; break; }
      }
      if (!wiredToThisWorld) continue;
      const qp = qNode.params = qNode.params || {};
      const qr = _resolveNodeParams(qNode);
      if ((typeof qr.enabled === "number" ? qr.enabled : 1) < 0.5) {
        if (qNode.type === "Raycast2D") { qp.hit = 0; qp.hitX = 0; qp.hitY = 0; qp.normalX = 0; qp.normalY = 0; qp.distance = 0; }
        else if (qNode.type === "Spherecast2D") { qp.hit = 0; qp.distance = 0; }
        else { qp.count = 0; qp.hit = 0; }
        continue;
      }

      if (qNode.type === "Raycast2D") {
        const ox = typeof qr.originX === "number" ? qr.originX : 0;
        const oy = typeof qr.originY === "number" ? qr.originY : 0;
        const dx = typeof qr.dirX === "number" ? qr.dirX : 1;
        const dy = typeof qr.dirY === "number" ? qr.dirY : 0;
        const maxDist = typeof qr.maxDistance === "number" ? qr.maxDistance : 100;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ray = new RAPIER.Ray({ x: ox, y: oy }, { x: dx / len, y: dy / len });
        const result = world.castRay(ray, maxDist, true);
        if (result) {
          const hitPt = ray.pointAt(result.timeOfImpact);
          const collider = world.getCollider(result.colliderHandle);
          const normal = collider ? collider.castRayAndGetNormal(ray, maxDist, true) : null;
          qp.hit = 1;
          qp.hitX = hitPt.x;
          qp.hitY = hitPt.y;
          qp.distance = result.timeOfImpact;
          qp.normalX = normal ? normal.normal.x : 0;
          qp.normalY = normal ? normal.normal.y : 0;
        } else {
          qp.hit = 0; qp.hitX = 0; qp.hitY = 0; qp.normalX = 0; qp.normalY = 0; qp.distance = 0;
        }
      } else if (qNode.type === "OverlapCircle2D") {
        const cx = typeof qr.centerX === "number" ? qr.centerX : 0;
        const cy = typeof qr.centerY === "number" ? qr.centerY : 0;
        const r = Math.max(0.01, typeof qr.radius === "number" ? qr.radius : 1);
        const shape = new RAPIER.Ball(r);
        let count = 0;
        world.intersectionsWithShape(
          { x: cx, y: cy }, 0, shape,
          () => { count++; return true; }
        );
        qp.count = count; qp.hit = count > 0 ? 1 : 0;
      } else if (qNode.type === "OverlapBox2D") {
        const cx = typeof qr.centerX === "number" ? qr.centerX : 0;
        const cy = typeof qr.centerY === "number" ? qr.centerY : 0;
        const hw = Math.max(0.01, typeof qr.halfW === "number" ? qr.halfW : 0.5);
        const hh = Math.max(0.01, typeof qr.halfH === "number" ? qr.halfH : 0.5);
        const rot = (typeof qr.rotation === "number" ? qr.rotation : 0) * Math.PI / 180;
        const shape = new RAPIER.Cuboid(hw, hh);
        let count = 0;
        world.intersectionsWithShape(
          { x: cx, y: cy }, rot, shape,
          () => { count++; return true; }
        );
        qp.count = count; qp.hit = count > 0 ? 1 : 0;
      } else if (qNode.type === "Spherecast2D") {
        const ox = typeof qr.originX === "number" ? qr.originX : 0;
        const oy = typeof qr.originY === "number" ? qr.originY : 0;
        const dx = typeof qr.dirX === "number" ? qr.dirX : 1;
        const dy = typeof qr.dirY === "number" ? qr.dirY : 0;
        const rad = Math.max(0.01, typeof qr.radius === "number" ? qr.radius : 0.5);
        const maxDist = typeof qr.maxDistance === "number" ? qr.maxDistance : 100;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const dnx = dx / len, dny = dy / len;
        let toi = null, n2 = null, w2 = null;
        try {
          const shape = new RAPIER.Ball(rad);
          // 0.14: castShape(pos, rot, vel, shape, targetDist, maxToi, stopAtPenetration, ...)
          const hitc = world.castShape(
            { x: ox, y: oy }, 0, { x: dnx, y: dny },
            shape, 0, maxDist, true
          );
          if (hitc) {
            toi = (typeof hitc.time_of_impact === "number") ? hitc.time_of_impact
                : (typeof hitc.timeOfImpact === "number") ? hitc.timeOfImpact : null;
            n2 = hitc.normal2 || hitc.normal1 || null;
            w2 = hitc.witness2 || hitc.witness1 || null;
          }
        } catch (_) { toi = null; }
        if (toi !== null && isFinite(toi)) {
          qp.hit = 1; qp.distance = toi;
          qp.hitX = ox + dnx * toi; qp.hitY = oy + dny * toi;
          qp.contactX = w2 ? w2.x : qp.hitX; qp.contactY = w2 ? w2.y : qp.hitY;
          qp.normalX = n2 ? n2.x : 0; qp.normalY = n2 ? n2.y : 0;
        } else {
          qp.hit = 0; qp.distance = maxDist;
          qp.hitX = ox + dnx * maxDist; qp.hitY = oy + dny * maxDist;
          qp.contactX = 0; qp.contactY = 0; qp.normalX = 0; qp.normalY = 0;
        }
      }
    }
  }
}

/* ── Phase 8.0.3-b / 8.B.6 -- Rapier 3D physics tick ──────────────
 * Same architecture as 2D but uses @dimforge/rapier3d-compat. */
let _rapier3dModule = null;
let _rapier3dLoadPromise = null;

async function _ensureRapier3D() {
  if (_rapier3dModule) return _rapier3dModule;
  if (_rapier3dLoadPromise) return _rapier3dLoadPromise;
  console.log("[physics3d] loading Rapier 3D WASM...");
  _rapier3dLoadPromise = (async () => {
    try {
      const R = await import(
        "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/+esm"
      );
      await R.init();
      _rapier3dModule = R;
      console.log("[physics3d] Rapier 3D WASM loaded");
      return R;
    } catch (e) {
      console.error("[physics3d] Rapier 3D load failed:", e);
      _rapier3dLoadPromise = null;
      return null;
    }
  })();
  return _rapier3dLoadPromise;
}

function _tickPhysics3D(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  let hasWorld = false;
  for (const n of state.nodes) {
    if (n && n.type === "PhysicsWorld3D") { hasWorld = true; break; }
  }
  if (!hasWorld) return;
  if (!(dtSec > 0) || dtSec > 0.034) dtSec = 0.034;

  if (!_rapier3dModule) { _ensureRapier3D(); return; }
  const RAPIER = _rapier3dModule;

  for (const worldNode of state.nodes) {
    if (!worldNode || worldNode.type !== "PhysicsWorld3D") continue;
    if (!_isNodeActive(worldNode)) {
      if (worldNode._rapierWorld) { try { worldNode._rapierWorld.free(); } catch(_) {} worldNode._rapierWorld = null; worldNode._bodyMap = null; worldNode._stepDied = false; worldNode._stepErrorLogged = false; }
      continue;
    }
    // If a prior step threw a WASM "unreachable", Rapier's heap is
    // corrupt — every subsequent call (drainContactForceEvents,
    // translation, etc.) will throw "recursive use" cascades.
    // Free the dead world and skip this tick. Next OnAwake (e.g. on
    // MENU return) will rebuild it cleanly.
    if (worldNode._stepDied) {
      try { worldNode._rapierWorld && worldNode._rapierWorld.free(); } catch(_) {}
      worldNode._rapierWorld = null;
      worldNode._bodyMap = null;
      worldNode._stepDied = false;
      worldNode._stepErrorLogged = false;
      for (const dn of state.nodes) {
        if (dn && dn.type === "DestructibleBody3D") {
          dn._fragmentBodies = null;
          if (dn.params) { dn.params.destroyed = 0; dn.params.fragmentCount = 0; }
        }
      }
      continue;
    }
    const wp = worldNode.params = worldNode.params || {};
    const resolved = _resolveNodeParams(worldNode);
    if ((typeof resolved.enabled === "number" ? resolved.enabled : 1) < 0.5) continue;

    const gx = typeof resolved.gravityX === "number" ? resolved.gravityX : 0;
    const gy = typeof resolved.gravityY === "number" ? resolved.gravityY : -9.8;
    const gz = typeof resolved.gravityZ === "number" ? resolved.gravityZ : 0;

    if (!worldNode._rapierWorld) {
      worldNode._rapierWorld = new RAPIER.World({ x: gx, y: gy, z: gz });
      worldNode._bodyMap = new Map();
      wp.ready = 1;
      console.log("[physics3d] PhysicsWorld3D created, gravity=(" + gx + "," + gy + "," + gz + ")");
    }
    const world = worldNode._rapierWorld;
    const bodyMap = worldNode._bodyMap;
    world.gravity = { x: gx, y: gy, z: gz };

    // Find bodies wired to this world
    const wiredBodies = new Set();
    for (const e of state.edges) {
      if (!e || !e.from || e.from.node !== worldNode.id || e.from.port !== "world") continue;
      if (!e.to) continue;
      const target = state.nodes.find(n => n && n.id === e.to.node);
      if (target && target.type === "RigidBody3D") wiredBodies.add(target.id);
    }

    // Cleanup
    for (const [nodeId] of bodyMap) {
      if (!wiredBodies.has(nodeId)) { world.removeRigidBody(bodyMap.get(nodeId).handle); bodyMap.delete(nodeId); }
    }

    // Register / update bodies
    for (const bodyNode of state.nodes) {
      if (!bodyNode || bodyNode.type !== "RigidBody3D") continue;
      if (!wiredBodies.has(bodyNode.id)) continue;
      if (!_isNodeActive(bodyNode)) {
        if (bodyMap.has(bodyNode.id)) { world.removeRigidBody(bodyMap.get(bodyNode.id).handle); bodyMap.delete(bodyNode.id); }
        continue;
      }
      const bp = bodyNode.params = bodyNode.params || {};
      const br = _resolveNodeParams(bodyNode);
      const resetNow = typeof br.reset === "number" ? br.reset : 0;
      const resetEdge = resetNow >= 0.5 && (bp._prevReset || 0) < 0.5;

      if (!bp._inited || resetEdge) {
        bp.x = typeof br.initX === "number" ? br.initX : 0;
        bp.y = typeof br.initY === "number" ? br.initY : 0;
        bp.z = typeof br.initZ === "number" ? br.initZ : 0;
        const ivx = typeof br.initVx === "number" ? br.initVx : 0;
        const ivy = typeof br.initVy === "number" ? br.initVy : 0;
        const ivz = typeof br.initVz === "number" ? br.initVz : 0;
        bp.vx = ivx; bp.vy = ivy; bp.vz = ivz;
        bp._inited = 1;
        if (bodyMap.has(bodyNode.id)) {
          const entry = bodyMap.get(bodyNode.id);
          entry.handle.setTranslation({ x: bp.x, y: bp.y, z: bp.z }, true);
          entry.handle.setLinvel({ x: ivx, y: ivy, z: ivz }, true);
          entry.handle.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      }
      bp._prevReset = resetNow;

      if (!bodyMap.has(bodyNode.id)) {
        const typeStr = (typeof br.type === "string") ? br.type : "dynamic";
        let rbType;
        if (typeStr === "static") rbType = RAPIER.RigidBodyType.Fixed;
        else if (typeStr === "kinematic") rbType = RAPIER.RigidBodyType.KinematicPositionBased;
        else rbType = RAPIER.RigidBodyType.Dynamic;
        const desc = new RAPIER.RigidBodyDesc(rbType)
          .setTranslation(bp.x, bp.y, bp.z)
          .setLinearDamping(typeof br.linearDamping === "number" ? br.linearDamping : 0)
          .setAngularDamping(typeof br.angularDamping === "number" ? br.angularDamping : 0)
          .setGravityScale(typeof br.gravityScale === "number" ? br.gravityScale : 1);
        if ((typeof br.ccd === "number" ? br.ccd : 0) >= 0.5) desc.setCcdEnabled(true);
        const handle = world.createRigidBody(desc);
        bodyMap.set(bodyNode.id, { handle, colliderIds: [] });
      }

      const entry = bodyMap.get(bodyNode.id);
      entry.handle.setLinearDamping(typeof br.linearDamping === "number" ? br.linearDamping : 0);
      entry.handle.setAngularDamping(typeof br.angularDamping === "number" ? br.angularDamping : 0);
      entry.handle.setGravityScale(typeof br.gravityScale === "number" ? br.gravityScale : 1);
      try { entry.handle.resetForces(false); } catch (_) {}
      const fScale = typeof br.forceScale === "number" ? br.forceScale : 1;
      const fx = (typeof br.forceX === "number" ? br.forceX : 0) * fScale;
      const fy = (typeof br.forceY === "number" ? br.forceY : 0) * fScale;
      const fz = (typeof br.forceZ === "number" ? br.forceZ : 0) * fScale;
      if (fx !== 0 || fy !== 0 || fz !== 0) entry.handle.addForce({ x: fx, y: fy, z: fz }, true);
      const iScale = typeof br.impulseScale === "number" ? br.impulseScale : 1;
      const ix = (typeof br.impulseX === "number" ? br.impulseX : 0) * iScale;
      const iy = (typeof br.impulseY === "number" ? br.impulseY : 0) * iScale;
      const iz = (typeof br.impulseZ === "number" ? br.impulseZ : 0) * iScale;
      if (ix !== 0 || iy !== 0 || iz !== 0) entry.handle.applyImpulse({ x: ix, y: iy, z: iz }, true);
    }

    // Register 3D colliders
    const _coll3Types = ["BoxCollider3D", "SphereCollider3D", "CapsuleCollider3D"];
    for (const cn of state.nodes) {
      if (!cn || _coll3Types.indexOf(cn.type) < 0) continue;
      if (!_isNodeActive(cn) || cn._rapierColliderAttached) continue;
      const bodyRef = _findWiredBodyNodePort3D(cn, "body");
      if (!bodyRef) { if (!cn._c3dWarnLogged) { console.warn("[physics3d] " + cn.type + " " + cn.id + ": no body wire"); cn._c3dWarnLogged = true; } continue; }
      if (!bodyMap.has(bodyRef.id)) { if (!cn._c3dWarnLogged) { console.warn("[physics3d] " + cn.type + " " + cn.id + ": body " + bodyRef.id + " not in world"); cn._c3dWarnLogged = true; } continue; }
      const cp = _resolveNodeParams(cn);
      try {
        let cd;
        if (cn.type === "BoxCollider3D") {
          cd = RAPIER.ColliderDesc.cuboid(
            Math.max(0.01, typeof cp.halfX === "number" ? cp.halfX : 0.5),
            Math.max(0.01, typeof cp.halfY === "number" ? cp.halfY : 0.5),
            Math.max(0.01, typeof cp.halfZ === "number" ? cp.halfZ : 0.5));
        } else if (cn.type === "CapsuleCollider3D") {
          cd = RAPIER.ColliderDesc.capsule(
            Math.max(0.01, typeof cp.halfHeight === "number" ? cp.halfHeight : 0.5),
            Math.max(0.01, typeof cp.radius === "number" ? cp.radius : 0.25));
        } else {
          cd = RAPIER.ColliderDesc.ball(Math.max(0.01, typeof cp.radius === "number" ? cp.radius : 0.5));
        }
        cd.setDensity(typeof cp.density === "number" ? cp.density : 1)
          .setFriction(typeof cp.friction === "number" ? cp.friction : 0.5)
          .setRestitution(typeof cp.restitution === "number" ? cp.restitution : 0.3)
          .setSensor((typeof cp.isSensor === "number" ? cp.isSensor : 0) >= 0.5);
        try {
          const evFlags = (RAPIER.ActiveEvents.COLLISION_EVENTS | 0) |
                          (RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS | 0);
          cd.setActiveEvents(evFlags);
        } catch (_) {}
        world.createCollider(cd, bodyMap.get(bodyRef.id).handle);
        cn._rapierColliderAttached = true;
        console.log("[physics3d] " + cn.type + " attached to " + bodyRef.id);
      } catch (e) {
        console.error("[physics3d] collider attach failed:", e);
        cn._rapierColliderAttached = true;
      }
    }

    // TerrainCollider trimesh (8.0.3-b)
    for (const tcn of state.nodes) {
      if (!tcn || tcn.type !== "TerrainCollider") continue;
      if (!_isNodeActive(tcn)) continue;
      const tcp = tcn.params = tcn.params || {};
      if ((typeof tcp.useTrimesh === "number" ? tcp.useTrimesh : 0) < 0.5) continue;
      let wiredTo3D = false;
      for (const e of state.edges) {
        if (e && e.to && e.to.node === tcn.id && e.to.port === "world3d" &&
            e.from && e.from.node === worldNode.id) { wiredTo3D = true; break; }
      }
      if (!wiredTo3D) continue;
      if (tcn._trimeshBuilt) continue;

      const res = Math.max(4, Math.min(128, Math.round(typeof tcp.trimeshRes === "number" ? tcp.trimeshRes : 32)));
      const size = typeof tcp.trimeshSize === "number" ? tcp.trimeshSize : 20;
      const half = size * 0.5;

      // Find the wired terrain source for height sampling
      const explicitSrc = _terrainColliderExplicitSource(tcn);
      const srcOpts = explicitSrc ? { preferredSourceId: explicitSrc.id } : {};

      // Sample heightmap into a grid
      const heights = new Float32Array(res * res);
      let hMin = Infinity, hMax = -Infinity;
      for (let zi = 0; zi < res; zi++) {
        for (let xi = 0; xi < res; xi++) {
          const wx = (xi / (res - 1) - 0.5) * size;
          const wz = (zi / (res - 1) - 0.5) * size;
          const h = _terrainColliderHeightAt(wx, wz, srcOpts);
          const hv = (h !== null && Number.isFinite(h)) ? h : 0;
          heights[zi * res + xi] = hv;
          if (hv < hMin) hMin = hv;
          if (hv > hMax) hMax = hv;
        }
      }
      console.log("[physics3d] heightfield sample range: " + hMin.toFixed(2) + " .. " + hMax.toFixed(2));

      // Build trimesh from height samples (more reliable than heightfield API)
      try {
        const verts = new Float32Array(res * res * 3);
        for (let zi = 0; zi < res; zi++) {
          for (let xi = 0; xi < res; xi++) {
            const idx = (zi * res + xi) * 3;
            verts[idx]     = (xi / (res - 1) - 0.5) * size;
            verts[idx + 1] = heights[zi * res + xi];
            verts[idx + 2] = (zi / (res - 1) - 0.5) * size;
          }
        }
        const triCount = (res - 1) * (res - 1) * 2;
        const indices = new Uint32Array(triCount * 3);
        let ti = 0;
        for (let zi = 0; zi < res - 1; zi++) {
          for (let xi = 0; xi < res - 1; xi++) {
            const a = zi * res + xi;
            const b = a + 1;
            const c = a + res;
            const d = c + 1;
            indices[ti++] = a; indices[ti++] = c; indices[ti++] = b;
            indices[ti++] = b; indices[ti++] = c; indices[ti++] = d;
          }
        }
        const tmDesc = RAPIER.ColliderDesc.trimesh(verts, indices);
        tmDesc.setFriction(0.6).setRestitution(0.3);
        const tmBody = world.createRigidBody(
          new RAPIER.RigidBodyDesc(RAPIER.RigidBodyType.Fixed)
        );
        world.createCollider(tmDesc, tmBody);
        tcn._trimeshBuilt = true;
        tcp.trimeshReady = 1;
        console.log("[physics3d] TerrainCollider trimesh: " + res + "×" + res +
          " (" + triCount + " tris, " + size + " units)");
      } catch (e) {
        console.error("[physics3d] TerrainCollider trimesh failed:", e);
        tcn._trimeshBuilt = true;
      }
    }

    // WaterCollider sensor (8.0.3-c)
    for (const wcn of state.nodes) {
      if (!wcn || wcn.type !== "WaterCollider") continue;
      if (!_isNodeActive(wcn) || wcn._rapierColliderAttached) continue;
      let wiredTo3D = false;
      for (const e of state.edges) {
        if (e && e.to && e.to.node === wcn.id && e.to.port === "world3d" &&
            e.from && e.from.node === worldNode.id) { wiredTo3D = true; break; }
      }
      if (!wiredTo3D) continue;
      const wcp = _resolveNodeParams(wcn);
      const yLvl = typeof wcp.yLevel === "number" ? wcp.yLevel : 0;
      const sx = Math.max(0.1, typeof wcp.sizeX === "number" ? wcp.sizeX : 20);
      const sz = Math.max(0.1, typeof wcp.sizeZ === "number" ? wcp.sizeZ : 20);
      try {
        const wBody = world.createRigidBody(
          new RAPIER.RigidBodyDesc(RAPIER.RigidBodyType.Fixed).setTranslation(0, yLvl, 0)
        );
        const wcd = RAPIER.ColliderDesc.cuboid(sx * 0.5, 0.05, sz * 0.5)
          .setSensor(true)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        world.createCollider(wcd, wBody);
        wcn._rapierColliderAttached = true;
        console.log("[physics3d] WaterCollider sensor at y=" + yLvl + " (" + sx + "×" + sz + ")");
      } catch (e) {
        console.error("[physics3d] WaterCollider failed:", e);
        wcn._rapierColliderAttached = true;
      }
    }

    // 3D joints (8.B.7 + 8.B.11 RopeJoint3D)
    const _joint3Types = ["HingeJoint3D", "BallJoint3D", "FixedJoint3D", "RopeJoint3D"];
    for (const jn of state.nodes) {
      if (!jn || _joint3Types.indexOf(jn.type) < 0) continue;
      if (!_isNodeActive(jn) || jn._rapierJointAttached) continue;
      const bA = _findWiredBodyNodePort3D(jn, "bodyA");
      const bB = _findWiredBodyNodePort3D(jn, "bodyB");
      if (!bA || !bB || !bodyMap.has(bA.id) || !bodyMap.has(bB.id)) continue;
      const hA = bodyMap.get(bA.id).handle, hB = bodyMap.get(bB.id).handle;
      const jp = _resolveNodeParams(jn);
      const aA = { x: jp.anchorAx || 0, y: jp.anchorAy || 0, z: jp.anchorAz || 0 };
      const aB = { x: jp.anchorBx || 0, y: jp.anchorBy || 0, z: jp.anchorBz || 0 };
      try {
        let jd;
        if (jn.type === "BallJoint3D") {
          jd = RAPIER.JointData.spherical(aA, aB);
        } else if (jn.type === "HingeJoint3D") {
          const ax = { x: jp.axisX || 0, y: jp.axisY || 0, z: jp.axisZ || 1 };
          jd = RAPIER.JointData.revolute(aA, aB, ax);
        } else if (jn.type === "RopeJoint3D") {
          const L = Math.max(0.1, typeof jp.length === "number" ? jp.length : 5);
          if (typeof RAPIER.JointData.rope === "function") {
            jd = RAPIER.JointData.rope(L, aA, aB);
          } else {
            // Fallback: rigid-rod pendulum via a spherical joint. The
            // length offset goes on bodyB (the hanging body), so bodyB's
            // attach point coincides with bodyA's anchor and bodyB hangs
            // L below it — a proper swinging pendulum. (Offsetting bodyA
            // instead would pin bodyB's CENTER to a fixed low point ⇒
            // no swing.) Reads identically to a rope while taut.
            jd = RAPIER.JointData.spherical(aA, { x: aB.x, y: aB.y + L, z: aB.z });
          }
        } else {
          jd = RAPIER.JointData.fixed(aA, { x: 0, y: 0, z: 0, w: 1 }, aB, { x: 0, y: 0, z: 0, w: 1 });
        }
        const joint3d = world.createImpulseJoint(jd, hA, hB, true);
        try { joint3d.setContactsEnabled(true); } catch (_) {}
        jn._rapierJointAttached = true;
        console.log("[physics3d] " + jn.type + " created between " + bA.id + " and " + bB.id);
      } catch (e) {
        console.error("[physics3d] 3D joint failed:", e);
        jn._rapierJointAttached = true;
      }
    }

    // 3D queries (8.B.7 + 8.B.9 Spherecast3D)
    for (const qn of state.nodes) {
      if (!qn) continue;
      if (qn.type !== "Raycast3D" && qn.type !== "OverlapSphere3D" && qn.type !== "Spherecast3D") continue;
      if (!_isNodeActive(qn)) continue;
      let wiredHere = false;
      for (const e of state.edges) {
        if (e && e.to && e.to.node === qn.id && e.to.port === "world" &&
            e.from && e.from.node === worldNode.id) { wiredHere = true; break; }
      }
      if (!wiredHere) continue;
      const qp = qn.params = qn.params || {};
      const qr = _resolveNodeParams(qn);
      if ((typeof qr.enabled === "number" ? qr.enabled : 1) < 0.5) continue;

      if (qn.type === "Raycast3D") {
        const ox = qr.originX || 0, oy = qr.originY || 0, oz = qr.originZ || 0;
        const dx = qr.dirX || 0, dy = typeof qr.dirY === "number" ? qr.dirY : -1, dz = qr.dirZ || 0;
        const maxD = typeof qr.maxDistance === "number" ? qr.maxDistance : 100;
        const len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
        const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx/len, y: dy/len, z: dz/len });
        const result = world.castRay(ray, maxD, true);
        if (result) {
          const hp = ray.pointAt(result.timeOfImpact);
          qp.hit = 1; qp.hitX = hp.x; qp.hitY = hp.y; qp.hitZ = hp.z;
          qp.distance = result.timeOfImpact;
        } else {
          qp.hit = 0; qp.hitX = 0; qp.hitY = 0; qp.hitZ = 0; qp.distance = 0;
        }
      } else if (qn.type === "Spherecast3D") {
        const ox = qr.originX || 0, oy = qr.originY || 0, oz = qr.originZ || 0;
        const dx = qr.dirX || 0, dy = typeof qr.dirY === "number" ? qr.dirY : -1, dz = qr.dirZ || 0;
        const rad = Math.max(0.01, typeof qr.radius === "number" ? qr.radius : 0.5);
        const maxD = typeof qr.maxDistance === "number" ? qr.maxDistance : 100;
        const len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
        const dn3 = { x: dx/len, y: dy/len, z: dz/len };
        let toi = null, n2 = null, w2 = null;
        try {
          const shape = new RAPIER.Ball(rad);
          // 0.14: castShape(pos, rot, vel, shape, targetDist, maxToi, stopAtPenetration, ...)
          const hitc = world.castShape(
            { x: ox, y: oy, z: oz }, { x: 0, y: 0, z: 0, w: 1 }, dn3,
            shape, 0, maxD, true
          );
          if (hitc) {
            toi = (typeof hitc.time_of_impact === "number") ? hitc.time_of_impact
                : (typeof hitc.timeOfImpact === "number") ? hitc.timeOfImpact : null;
            n2 = hitc.normal2 || hitc.normal1 || null;
            w2 = hitc.witness2 || hitc.witness1 || null;
          }
        } catch (_) { toi = null; }
        if (toi !== null && isFinite(toi)) {
          qp.hit = 1; qp.distance = toi;
          qp.hitX = ox + dn3.x * toi; qp.hitY = oy + dn3.y * toi; qp.hitZ = oz + dn3.z * toi;
          qp.contactX = w2 ? w2.x : qp.hitX; qp.contactY = w2 ? w2.y : qp.hitY; qp.contactZ = w2 ? w2.z : qp.hitZ;
          qp.normalX = n2 ? n2.x : 0; qp.normalY = n2 ? n2.y : 0; qp.normalZ = n2 ? n2.z : 0;
        } else {
          qp.hit = 0; qp.distance = maxD;
          qp.hitX = ox + dn3.x * maxD; qp.hitY = oy + dn3.y * maxD; qp.hitZ = oz + dn3.z * maxD;
          qp.contactX = 0; qp.contactY = 0; qp.contactZ = 0;
          qp.normalX = 0; qp.normalY = 0; qp.normalZ = 0;
        }
      } else {
        const shape = new RAPIER.Ball(Math.max(0.01, qr.radius || 1));
        let count = 0;
        world.intersectionsWithShape(
          { x: qr.centerX || 0, y: qr.centerY || 0, z: qr.centerZ || 0 },
          { x: 0, y: 0, z: 0, w: 1 }, shape,
          () => { count++; return true; }
        );
        qp.count = count; qp.hit = count > 0 ? 1 : 0;
      }
    }

    // Water buoyancy: apply drag + upward force to bodies below water
    for (const wcn of state.nodes) {
      if (!wcn || wcn.type !== "WaterCollider" || !wcn._rapierColliderAttached) continue;
      const wcp = wcn.params || {};
      const waterY = typeof wcp.yLevel === "number" ? wcp.yLevel : 0;
      for (const [, entry] of bodyMap) {
        const pos = entry.handle.translation();
        if (pos.y < waterY) {
          const depth = waterY - pos.y;
          const buoyancy = Math.min(depth * 6, 30);
          entry.handle.addForce({ x: 0, y: buoyancy, z: 0 }, true);
          const vel = entry.handle.linvel();
          entry.handle.setLinvel({
            x: vel.x * 0.96,
            y: vel.y * 0.96,
            z: vel.z * 0.96
          }, true);
        }
      }
    }

    // Phase 8.B.10: ForceField3D + Wind3D. Applied AFTER the per-body
    // resetForces+addForce loop (so they aren't wiped) and BEFORE the
    // step (so they take effect this frame). Each is wired to a world.
    for (const fn of state.nodes) {
      if (!fn || (fn.type !== "ForceField3D" && fn.type !== "Wind3D")) continue;
      if (!_isNodeActive(fn)) continue;
      let wiredHere = false;
      for (const e of state.edges) {
        if (e && e.to && e.to.node === fn.id && e.to.port === "world" &&
            e.from && e.from.node === worldNode.id) { wiredHere = true; break; }
      }
      if (!wiredHere) continue;
      const fp = fn.params = fn.params || {};
      const fr = _resolveNodeParams(fn);
      if ((typeof fr.enabled === "number" ? fr.enabled : 1) < 0.5) { if (fn.type === "ForceField3D") fp.affected = 0; continue; }

      if (fn.type === "ForceField3D") {
        const cx = fr.x || 0, cy = fr.y || 0, cz = fr.z || 0;
        const strength = typeof fr.strength === "number" ? fr.strength : 20;
        const radius = Math.max(0.01, typeof fr.radius === "number" ? fr.radius : 12);
        const falloff = Math.round(typeof fr.falloff === "number" ? fr.falloff : 1);
        const mode = (typeof fp.mode === "string") ? fp.mode : "attract";
        const r2 = radius * radius;
        let affected = 0;
        for (const [, entry] of bodyMap) {
          const h = entry.handle;
          try { if (h.isFixed && h.isFixed()) continue; } catch (_) {}
          const p = h.translation();
          const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
          const d2 = dx*dx + dy*dy + dz*dz;
          if (d2 > r2) continue;
          const dist = Math.sqrt(d2) || 0.0001;
          if (dist < 0.05) continue;            // avoid singularity at center
          let ff;
          if (falloff === 0)      ff = 1;
          else if (falloff === 2) ff = Math.min(1, (radius * 0.25) / d2);   // ~1/dist², clamped
          else                    ff = 1 - dist / radius;                    // linear
          let mass = 1; try { mass = h.mass() || 1; } catch (_) {}
          const mag = strength * ff * mass;
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          let Fx, Fy, Fz;
          if (mode === "repel") {
            Fx = nx * mag; Fy = ny * mag; Fz = nz * mag;
          } else if (mode === "vortex") {
            // Tangential swirl about the world Y axis: up×radial with
            // up=(0,1,0) gives (nz, 0, -nx). Add a slight inward pull
            // (-n * 0.2) so bodies orbit instead of flying outward.
            Fx = nz * mag - nx * mag * 0.2;
            Fy = -ny * mag * 0.05;
            Fz = -nx * mag - nz * mag * 0.2;
          } else { // attract
            Fx = -nx * mag; Fy = -ny * mag; Fz = -nz * mag;
          }
          h.addForce({ x: Fx, y: Fy, z: Fz }, true);
          affected++;
        }
        fp.affected = affected;
      } else { // Wind3D
        const dx = fr.dirX || 0, dy = fr.dirY || 0, dz = fr.dirZ || 0;
        const strength = typeof fr.strength === "number" ? fr.strength : 5;
        const turb = typeof fr.turbulence === "number" ? fr.turbulence : 0.3;
        const scale = typeof fr.scale === "number" ? fr.scale : 0.4;
        const len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
        const bx = dx / len * strength, by = dy / len * strength, bz = dz / len * strength;
        const t = (performance.now() / 1000);
        // Cheap value-noise turbulence (sin/cos combo) sampled at origin
        // for the output sample; per-body it samples at the body pos.
        const turbAt = (px, py, pz) => ({
          x: Math.sin(t * 1.3 + px * scale + py * 0.7) * turb * strength,
          y: Math.sin(t * 0.9 + py * scale + pz * 1.1) * turb * strength * 0.5,
          z: Math.cos(t * 1.1 + pz * scale + px * 0.5) * turb * strength
        });
        for (const [, entry] of bodyMap) {
          const h = entry.handle;
          try { if (h.isFixed && h.isFixed()) continue; } catch (_) {}
          const p = h.translation();
          const tb = turbAt(p.x, p.y, p.z);
          let mass = 1; try { mass = h.mass() || 1; } catch (_) {}
          h.addForce({ x: (bx + tb.x) * mass, y: (by + tb.y) * mass, z: (bz + tb.z) * mass }, true);
        }
        const o = turbAt(0, 0, 0);
        fp.sampleX = bx + o.x; fp.sampleY = by + o.y; fp.sampleZ = bz + o.z;
      }
    }

    // ── Phase 8.B.14: replay scrub ────────────────────────────
    // If a PhysicsReplay wired to this world is scrubbing (frame <
    // ~0.99), snap every body to the recorded snapshot + skip the
    // step. Otherwise the world steps live (and records below).
    let replayActive = false, replayFrameData = null;
    for (const rpN of state.nodes) {
      if (!rpN || rpN.type !== "PhysicsReplay") continue;
      if (!_isNodeActive(rpN)) continue;
      let wired = false;
      for (const e of state.edges) {
        if (e && e.to && e.to.node === rpN.id && e.to.port === "world" && e.from && e.from.node === worldNode.id) { wired = true; break; }
      }
      if (!wired) continue;
      const rr = _resolveNodeParams(rpN);
      const rpp = rpN.params = rpN.params || {};
      if ((typeof rr.enabled === "number" ? rr.enabled : 1) < 0.5) { rpp.active = 0; continue; }
      const fnorm = typeof rr.frame === "number" ? rr.frame : 1;
      let recNode = null;
      for (const e of state.edges) {
        if (e && e.to && e.to.node === rpN.id && e.to.port === "recording" && e.from) {
          const src = state.nodes.find(n => n && n.id === e.from.node && n.type === "PhysicsRecord");
          if (src) { recNode = src; break; }
        }
      }
      const frames = recNode && recNode._frames;
      if (!frames || frames.length === 0) { rpp.active = 0; continue; }
      if (fnorm >= 0.99) { rpp.active = 0; rpp.atEnd = 0; continue; }   // live
      const fi = Math.max(0, Math.min(frames.length - 1, Math.round(fnorm * (frames.length - 1))));
      rpp.active = 1; rpp.frameIndex = fi; rpp.atEnd = (fi >= frames.length - 1) ? 1 : 0;
      replayActive = true; replayFrameData = frames[fi];
      break;
    }
    worldNode._replayActive = replayActive;
    if (replayActive && replayFrameData) {
      for (const [nid, entry] of bodyMap) {
        const rec = replayFrameData[nid];
        if (!rec) continue;
        try {
          entry.handle.setTranslation({ x: rec[0], y: rec[1], z: rec[2] }, true);
          entry.handle.setRotation({ x: rec[3], y: rec[4], z: rec[5], w: rec[6] }, true);
          entry.handle.setLinvel({ x: 0, y: 0, z: 0 }, true);
          entry.handle.setAngvel({ x: 0, y: 0, z: 0 }, true);
        } catch (_) {}
      }
    }

    // Phase 8.B.15: BlobController3D — set the character's velocity
    // pre-step (skipped while replaying so it doesn't fight the scrub).
    if (!replayActive) _tickBlobControllers3D(worldNode, world, bodyMap, RAPIER, dtSec);

    // Step (skipped while a replay is scrubbing this world)
    const timeScale = typeof resolved.timeScale === "number" ? resolved.timeScale : 1;
    const subSteps = Math.max(1, Math.min(16, Math.round(typeof resolved.subSteps === "number" ? resolved.subSteps : 4)));
    world.timestep = (dtSec * timeScale) / subSteps;
    if (!worldNode._eventQueue3d) {
      try { worldNode._eventQueue3d = new RAPIER.EventQueue(true); } catch (_) {}
    }
    const eq3d = worldNode._eventQueue3d;
    let stepFailed = false;
    if (!replayActive) {
      for (let s = 0; s < subSteps; s++) {
        try {
          if (eq3d) world.step(eq3d); else world.step();
        } catch (err) {
          if (!worldNode._stepErrorLogged) {
            console.warn("[physics3d] world.step threw — marking world dead, will rebuild next frame", err);
            worldNode._stepErrorLogged = true;
          }
          worldNode._stepDied = true;
          stepFailed = true;
          break;
        }
      }
    }
    if (stepFailed) continue;

    // D.1: drain contact force events → build per-pair force map
    const contactForces3d = new Map();
    if (eq3d) {
      try {
        eq3d.drainContactForceEvents(ev => {
          let mag = 0;
          try { mag = typeof ev.totalForceMagnitude === "function" ? ev.totalForceMagnitude() : (ev.totalForceMagnitude || 0); } catch (_) {}
          if (!mag) try { mag = typeof ev.maxForceMagnitude === "function" ? ev.maxForceMagnitude() : (ev.maxForceMagnitude || 0); } catch (_) {}
          let h1 = 0, h2 = 0;
          try { h1 = typeof ev.collider1 === "function" ? ev.collider1() : (ev.collider1 || 0); } catch (_) {}
          try { h2 = typeof ev.collider2 === "function" ? ev.collider2() : (ev.collider2 || 0); } catch (_) {}
          const key = Math.min(h1, h2) + ":" + Math.max(h1, h2);
          contactForces3d.set(key, Math.max(contactForces3d.get(key) || 0, mag));
          if (!worldNode._cfLoggedOnce) {
            console.log("[physics3d] contact force event: mag=" + mag.toFixed(2) + " h1=" + h1 + " h2=" + h2);
            worldNode._cfLoggedOnce = true;
          }
        });
      } catch (e) {
        if (!worldNode._cfErrLogged) { console.error("[physics3d] drainContactForceEvents error:", e); worldNode._cfErrLogged = true; }
      }
      try { eq3d.drainCollisionEvents(() => {}); } catch (_) {}
    }

    // Read back body state
    let bodyCount = 0;
    for (const bodyNode of state.nodes) {
      if (!bodyNode || bodyNode.type !== "RigidBody3D") continue;
      if (!bodyMap.has(bodyNode.id)) continue;
      bodyCount++;
      const entry = bodyMap.get(bodyNode.id);
      const pos = entry.handle.translation();
      const rot = entry.handle.rotation();
      const vel = entry.handle.linvel();
      const bp = bodyNode.params;
      bp.x = pos.x; bp.y = pos.y; bp.z = pos.z;
      // Quaternion → Euler (ZYX convention, degrees)
      const qx = rot.x, qy = rot.y, qz = rot.z, qw = rot.w;
      const sinP = 2 * (qw * qx - qy * qz);
      bp.rotX = Math.asin(Math.max(-1, Math.min(1, sinP))) * 180 / Math.PI;
      bp.rotY = Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qx * qx + qy * qy)) * 180 / Math.PI;
      bp.rotZ = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qx * qx + qz * qz)) * 180 / Math.PI;
      bp.vx = vel.x; bp.vy = vel.y; bp.vz = vel.z;
    }
    wp.bodyCount = bodyCount;

    // ── Phase 8.B.14: record pass ─────────────────────────────
    // Capture every dynamic body's transform this frame (skipped
    // while replaying — the readback above already reflects the
    // replayed snapshot, so re-recording it would be a no-op loop).
    if (!replayActive) {
      for (const recN of state.nodes) {
        if (!recN || recN.type !== "PhysicsRecord") continue;
        if (!_isNodeActive(recN)) continue;
        let wired = false;
        for (const e of state.edges) {
          if (e && e.to && e.to.node === recN.id && e.to.port === "world" && e.from && e.from.node === worldNode.id) { wired = true; break; }
        }
        if (!wired) continue;
        const rcp = recN.params = recN.params || {};
        const rcr = _resolveNodeParams(recN);
        const maxF = Math.max(1, Math.round(typeof rcr.maxFrames === "number" ? rcr.maxFrames : 300));
        // reset (rising edge) clears the buffer.
        const resetNow = typeof rcr.reset === "number" ? rcr.reset : 0;
        if (resetNow >= 0.5 && (recN._recPrevReset || 0) < 0.5) { recN._frames = []; }
        recN._recPrevReset = resetNow;
        if (!recN._frames) recN._frames = [];
        const recording = (typeof rcr.record === "number" ? rcr.record : 1) >= 0.5 && recN._frames.length < maxF;
        if (recording) {
          const snap = {};
          for (const [nid, entry] of bodyMap) {
            const t = entry.handle.translation();
            const q = entry.handle.rotation();
            snap[nid] = [t.x, t.y, t.z, q.x, q.y, q.z, q.w];
          }
          recN._frames.push(snap);
        }
        rcp.frameCount = recN._frames.length;
        rcp.recording = recording ? 1 : 0;
      }
    }

    // D.1: ContactForce3D — impact force from velocity change.
    // force ≈ mass × |Δv| / dt. Reliable across Rapier compat versions.
    for (const cfn of state.nodes) {
      if (!cfn || cfn.type !== "ContactForce3D") continue;
      if (!_isNodeActive(cfn)) continue;
      const cp = cfn.params = cfn.params || {};
      const bA = _findWiredBodyNodePort3D(cfn, "bodyA");
      if (!bA || !bodyMap.has(bA.id)) { cp.forceMagnitude = 0; continue; }
      const entry = bodyMap.get(bA.id);
      const vel = entry.handle.linvel();
      const pv = entry._prevVel || { x: vel.x, y: vel.y, z: vel.z };
      const dvx = vel.x - pv.x, dvy = vel.y - pv.y, dvz = vel.z - pv.z;
      const dvMag = Math.sqrt(dvx*dvx + dvy*dvy + dvz*dvz);
      let mass = 1;
      try { mass = entry.handle.mass(); } catch (_) {}
      const force = dvMag * mass / Math.max(0.001, dtSec);
      entry._prevVel = { x: vel.x, y: vel.y, z: vel.z };
      cp.forceMagnitude = Math.round(force * 10) / 10;
      if (force > (cp.maxForce || 0)) cp.maxForce = Math.round(force * 10) / 10;
    }
  }
}

function _findWiredBodyNodePort3D(node, portName) {
  if (!state || !Array.isArray(state.edges)) return null;
  for (const e of state.edges) {
    if (!e || !e.to || e.to.node !== node.id || e.to.port !== portName) continue;
    if (!e.from) continue;
    const src = state.nodes.find(n => n && n.id === e.from.node);
    if (src && src.type === "RigidBody3D") return src;
  }
  return null;
}