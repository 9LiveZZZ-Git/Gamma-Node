/* Read the JS-side current value of a wire's source. Mirrors the
 * dispatch in _resolveNodeParams but for outbound use cases where
 * we want a single value (vs the full param-substitution). Returns
 * null when the source is audio-only with no JS mirror so the caller
 * can skip rather than send a stale value. */
function _readWireJsSideValue(wire) {
  if (!wire || !wire.from) return null;
  const src = state.nodes.find(n => n && n.id === wire.from.node);
  if (!src) return null;
  if (src.type === "Slider") {
    const v = src.params && src.params.value;
    return typeof v === "number" ? v : null;
  }
  if (src.type === "OscIn") {
    const v = src.params && src.params[wire.from.port];
    return typeof v === "number" ? v : null;
  }
  if (src.type === "MasterClock") {
    return _masterClockOutputValue(src, wire.from.port);
  }
  if (src.type === "DayNightCycle") {
    // 7.5.4.c -- timeOfDay output = phase (if wired and finite),
    // otherwise the stored `manual` param. _resolveNodeParams
    // handles the phase-input wire resolution + falls back to the
    // stored phase param if nothing's wired (Number.isFinite() then
    // catches the static-default case so we land on manual). Wrap
    // to [0, 1) so a continuously-incrementing source still maps to
    // a clean time-of-day phase.
    const p = _resolveNodeParams(src);
    const phaseRaw = (typeof p.phase === "number" && Number.isFinite(p.phase)) ? p.phase : null;
    if (phaseRaw !== null) {
      return ((phaseRaw % 1) + 1) % 1;
    }
    const manual = (typeof p.manual === "number") ? p.manual : 0.5;
    return ((manual % 1) + 1) % 1;
  }
  if (src.type === "HandLandmarker") return _handLandmarkerValue(src, wire.from.port);
  if (src.type === "PoseLandmarker") return _poseLandmarkerValue(src, wire.from.port);
  if (src.type === "FaceLandmarker") return _faceLandmarkerValue(src, wire.from.port);
  if (src.type === "HandKeyboard")   return _handKeyboardValue(src, wire.from.port);
  if (src.type === "BlobTracker")    return _blobTrackerValue(src, wire.from.port);
  // v0.3.48 -- audio-rate JS mirrors. Adequate for sending Sine /
  // Saw / Square / Phasor / AD-class envelopes through OscOut at
  // visual-rate cadence. NOT suitable for sample-accurate audio
  // analysis -- use a SAB-based probe path (future ticket) for that.
  if (src.type === "Sine" || src.type === "Saw" || src.type === "Square" || src.type === "Phasor") {
    return _audioMirrorOscValue(src, wire.from.port);
  }
  if (src.type === "AD" || src.type === "AR" || src.type === "ADSR") {
    return _envMirrorValue(src, wire.from.port);
  }
  // Sprint 8.0.3-a -- TerrainCollider. Resolves the source (auto
  // or explicit-via-`terrain`-wire), queries height at the node's
  // (queryX, queryZ) -- themselves wire-resolvable so e.g. a
  // (Camera.posX → TerrainCollider.queryX, Camera.posZ →
  // queryZ) wiring drives the height from where the camera is.
  if (src.type === "TerrainCollider") {
    if (wire.from.port !== "height") return null;
    const cp = _resolveNodeParams(src);
    const wx = (typeof cp.queryX === "number") ? cp.queryX : 0;
    const wz = (typeof cp.queryZ === "number") ? cp.queryZ : 0;
    const explicit = _terrainColliderExplicitSource(src);
    const y = _terrainColliderHeightAt(wx, wz, {
      preferredSourceId: explicit ? explicit.id : null
    });
    return (y !== null && Number.isFinite(y)) ? y : null;
  }
  // Math template nodes (Mul / Add / Sub / Sin / Cos / cmath family
  // / etc.) recurse into their own inputs. Common patterns like
  // "(Slider * 2 + 1) -> OscOut" or "(Phasor * 2pi -> Sin) -> Camera.posX"
  // work after this. Sprint 7.5.3a broadened from the v0.3.48 set
  // to the full cmath family via _isMathTemplateType.
  if (_isMathTemplateType(src.type)) {
    return _evalMathTemplateJsSide(src);
  }
  // Sprint platformer-1 -- game-input + game-body output ports live as
  // numeric params on the source node (written by _tickGameInputs each
  // frame). Read them directly so downstream Translate / OrthoCamera2D
  // / etc. can wire to KeyAxis2D.x, PlatformerBody2D.x, etc.
  // Sprint AnimationState2D extends the same pattern -- frame/flipX/
  // stateIdx are tick-written params that Sprite reads via wires.
  if (src.type === "KeyAxis2D" || src.type === "PlatformerBody2D" || src.type === "AnimationState2D"
      || src.type === "PickupCollector" || src.type === "LevelGoal2D") {
    const v = src.params && src.params[wire.from.port];
    return typeof v === "number" ? v : null;
  }
  // Phase 8.A.1 -- lifecycle event nodes. trigger / dt are written
  // into params by _tickLifecycleNodes each frame; read them through
  // for downstream consumers wired to OnAwake.trigger etc.
  if (src.type === "OnAwake" || src.type === "OnStart" ||
      src.type === "OnUpdate" || src.type === "OnDestroy" ||
      src.type === "EdgeCount") {
    const v = src.params && src.params[wire.from.port];
    return typeof v === "number" ? v : null;
  }
  // Phase 8.A.2 -- StageManager numeric outputs (current,
  // transitioning, transitionCount). Written by _tickStageManager.
  if (src.type === "StageManager") {
    const v = src.params && src.params[wire.from.port];
    return typeof v === "number" ? v : null;
  }
  // Phase 8.A.4 -- MeshWorldPosition readback. Walks the input
  // mesh chain on demand and returns the world position's x / y / z
  // for the requested port.
  if (src.type === "MeshWorldPosition") {
    return _meshWorldPositionAxis(src, wire.from.port);
  }
  // Phase 8.A.5 -- Pool's activeCount numeric output + Phase 8.A.5.2
  // audio summation (JS-rate, for visualization HUDs / OscOut / etc).
  if (src.type === "Pool") {
    if (wire.from.port === "audio") return _poolAudioMirrorValue(src);
    const v = src.params && src.params[wire.from.port];
    return typeof v === "number" ? v : null;
  }
  // Phase 8.I.1 -- StateMachine numeric outputs (current,
  // previousState, enter, transitioning, transitionCount).
  if (src.type === "StateMachine") {
    const v = src.params && src.params[wire.from.port];
    return typeof v === "number" ? v : null;
  }
  // Phase 8.D.1 -- UIButton / UIText / UIPanel interactivity readback
  // (clicked, hovered). UIButton is always interactive; UIText / UIPanel
  // require interactive=1. Written by _tickUiNodes from pointer events.
  if (src.type === "UIButton" || src.type === "UIText" || src.type === "UIPanel" || src.type === "UISlider" || src.type === "Leaderboard") {
    const v = src.params && src.params[wire.from.port];
    return typeof v === "number" ? v : null;
  }
  // Phase 8.B.1 -- physics body + world output ports. x/y/rotation/
  // vx/vy/angularVel written by _tickPhysics each frame; ready/
  // bodyCount/contactCount on the world node likewise.
  if (src.type === "RigidBody2D" || src.type === "PhysicsWorld2D"
      || src.type === "Raycast2D" || src.type === "OverlapCircle2D"
      || src.type === "OverlapBox2D" || src.type === "ContactEvent2D"
      || src.type === "RevoluteJoint2D" || src.type === "TilemapCollider2D"
      || src.type === "Spherecast2D"
      || src.type === "RigidBody3D" || src.type === "PhysicsWorld3D"
      || src.type === "TerrainCollider" || src.type === "WaterCollider"
      || src.type === "Raycast3D" || src.type === "OverlapSphere3D"
      || src.type === "Spherecast3D"
      || src.type === "ContactForce3D"
      || src.type === "ForceField3D" || src.type === "Wind3D"
      || src.type === "Rope3D" || src.type === "Cloth3D" || src.type === "SoftBody3D"
      || src.type === "PhysicsRecord" || src.type === "PhysicsReplay"
      || src.type === "BlobController3D" || src.type === "ThirdPersonCamera"
      || src.type === "LoadGLB"
      || src.type === "DestructibleBody3D") {
    const v = src.params && src.params[wire.from.port];
    return typeof v === "number" ? v : null;
  }
  return null;
}

/* Walk the mesh chain on a MeshWorldPosition node's `mesh` input
 * and return the world-space coordinate for the requested axis.
 * Returns null if no chain is wired or the chain can't be walked
 * (e.g. broken cycle, missing leaf). */
function _meshWorldPositionAxis(node, port) {
  if (port !== "worldX" && port !== "worldY" && port !== "worldZ") return null;
  if (typeof state === "undefined" || !state || !Array.isArray(state.edges)) return null;
  const wire = state.edges.find(e =>
    e && e.to && e.to.node === node.id && e.to.port === "mesh"
  );
  if (!wire || !wire.from) return null;
  const resolved = _walkMeshChain(wire.from.node, _mat4Identity(), null, 0);
  if (!resolved || !resolved.transform) return null;
  // Column-major mat4: translation column is at indices [12..14].
  if (port === "worldX") return resolved.transform[12];
  if (port === "worldY") return resolved.transform[13];
  if (port === "worldZ") return resolved.transform[14];
  return null;
}

/* JS-side evaluation table for single-input math template nodes
 * (cmath / arithmetic functions inlined at codegen time). Same set
 * the C++ side uses, mirrored here so visual-side wire resolution +
 * OscOut can follow modulation chains through math nodes without an
 * audio runtime. Sprint 7.5.3a expanded from the v0.3.48 set to
 * include the full cmath family so e.g. Camera.posX <- Mul(Sin(...))
 * works for the orbit demo without ad-hoc plumbing. */
const _MATH_UNARY_FNS = {
  Sin:     Math.sin,
  Cos:     Math.cos,
  Tan:     Math.tan,
  Asin:    Math.asin,
  Acos:    Math.acos,
  Atan:    Math.atan,
  Sinh:    Math.sinh,
  Cosh:    Math.cosh,
  Tanh:    Math.tanh,
  Exp:     Math.exp,
  Exp2:    (x) => Math.pow(2, x),
  Log:     Math.log,
  Log2:    Math.log2,
  Log10:   Math.log10,
  Sqrt:    (x) => x >= 0 ? Math.sqrt(x) : 0,
  Cbrt:    Math.cbrt,
  Squared: (x) => x * x,
  Cubed:   (x) => x * x * x,
  Abs:     Math.abs,
  Neg:     (x) => -x,
  Inv:     (x) => Math.abs(x) < 1e-9 ? 0 : 1.0 / x,
  Floor:   Math.floor,
  Ceil:    Math.ceil,
  Round:   Math.round,
  Sign:    Math.sign,
  Fract:   (x) => x - Math.floor(x)
};

/* Evaluate a math-template node on the JS side by recursively
 * reading its wired inputs. Returns null if any input dependency
 * can't be JS-resolved. Mirrors the codegen-time inlining:
 * Mul(a,b) emits "(a*b)", Sin(in) emits "sinf(in)", etc. */
function _evalMathTemplateJsSide(node) {
  if (!node) return null;
  const valOf = (portName) => {
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === portName
    );
    if (wire) {
      const v = _readWireJsSideValue(wire);
      if (v === null || v === undefined) return null;
      return v;
    }
    // Unwired: read static param value if present.
    const p = node.params && node.params[portName];
    return (typeof p === "number") ? p : null;
  };
  // Single-input math (cmath family). Table-driven.
  if (_MATH_UNARY_FNS[node.type]) {
    const inV = valOf("in");
    if (inV === null) return null;
    return _MATH_UNARY_FNS[node.type](inV);
  }
  // Two-input arithmetic (a, b).
  const a = valOf("a"), b = valOf("b");
  if (node.type === "Mul") {
    if (a === null || b === null) return null;
    return a * b;
  }
  if (node.type === "Add") {
    if (a === null || b === null) return null;
    return a + b;
  }
  if (node.type === "Sub") {
    if (a === null || b === null) return null;
    return a - b;
  }
  if (node.type === "Div") {
    if (a === null || b === null || Math.abs(b) < 1e-9) return null;
    return a / b;
  }
  if (node.type === "Pow") {
    if (a === null || b === null) return null;
    return Math.pow(a, b);
  }
  if (node.type === "Mod") {
    if (a === null || b === null || Math.abs(b) < 1e-9) return null;
    return a - Math.floor(a / b) * b;
  }
  if (node.type === "Min") {
    if (a === null || b === null) return null;
    return Math.min(a, b);
  }
  if (node.type === "Max") {
    if (a === null || b === null) return null;
    return Math.max(a, b);
  }
  return null;
}

/* Helper: is this node type a JS-mirrorable math template? Used by
 * _resolveNodeParams to dispatch into _evalMathTemplateJsSide for
 * wires that pass through arithmetic / cmath nodes. */
function _isMathTemplateType(t) {
  if (!t) return false;
  if (_MATH_UNARY_FNS[t]) return true;
  return t === "Mul" || t === "Add" || t === "Sub" || t === "Div" ||
         t === "Pow" || t === "Mod" || t === "Min" || t === "Max";
}

