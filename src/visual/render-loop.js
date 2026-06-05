/* ----- Phase 6.1.7 — render loop (rAF) -------------------------------- */

/* The visual render loop. Starts when the WebGPU device is ready and
 * runs continuously at the browser's rAF cadence (60 fps on most
 * displays, 120 on ProMotion / 144Hz panels). Each tick:
 *   1. Update the fps EMA + readout pill (6.1.5 plumbed this — the
 *      "— fps" placeholder finally goes live).
 *   2. If Visual.frozen is true (freeze button toggled), skip the
 *      render but keep ticking fps so the user can see the loop is
 *      still alive.
 *   3. Otherwise call renderVisualFrame() — currently smokeClearVisual,
 *      which clears FBO + blits to canvas. Will evolve in 6.4.x to
 *      walk the graph from VisualOutput backward, chaining shader
 *      passes into the FBO before the final blit.
 *
 * The loop runs unconditionally once the device is ready, regardless
 * of whether VisualOutput exists in the patch. Reasons:
 *   - The fps readout stays informative (you can see the GPU is alive
 *     even with no visual content yet).
 *   - Window-resize / DPR-change re-renders happen automatically on
 *     the next frame.
 *   - The cost is one render-pass-clear + one fullscreen-triangle
 *     blit per frame ≈ ~0.1ms on integrated GPUs; well under budget.
 *   - Future tickets that animate even without VisualOutput (test
 *     pattern, idle backdrop) get the loop for free.
 *
 * Stops on device loss; ensureGPUDevice's lost-handler nulls
 * Visual.device, the next tick sees it and bails out without
 * re-arming rAF — loop terminates cleanly. */
let _visualRafHandle = null;

/* Per-frame render entry point.
 *
 * Phase 6.5 architecture:
 *   1. Walk every VisualOutput in the patch + encode shader-frag
 *      passes targeting their respective display layers.
 *   2. If at least one pass was encoded → run the rig composite
 *      pass, which samples the texture array + lays the layers onto
 *      the visible canvas using the rig's previewMode (tile / etc).
 *   3. If nothing was renderable → fall back to the legacy single-
 *      layer smoke clear + blit so the canvas isn't undefined garbage.
 *
 * All passes share one command encoder + one queue.submit so the GPU
 * sees them as one coherent frame.  */
function renderVisualFrame() {
  if (!Visual.device || !Visual.context) return;

  const now = performance.now();
  const dtSec = Visual.lastFrameT > 0 ? (now - Visual.lastFrameT) * 0.001 : 0;
  // §bonus-perf-diag (2026-05-25) -- per-frame counter reset + last-
  // frame ms capture for the perf overlay / __PERFSTATS snapshot.
  if (typeof _perfFrameReset === "function") _perfFrameReset();
  if (typeof _PERFSTATS !== "undefined") {
    if (Visual.lastFrameT > 0) {
      _PERFSTATS.frameMs = now - Visual.lastFrameT;
      _PERFSTATS.frameMsWindow.push(_PERFSTATS.frameMs);
      if (_PERFSTATS.frameMsWindow.length > 60) _PERFSTATS.frameMsWindow.shift();
    }
  }
  Visual.lastFrameT = now;

  // v0.3.1 — clear the per-frame external-texture cache. Video-source
  // shader-frags import once per node here, then reuse the handle
  // across every consumer VO's pass (N×fan-out collapses to 1×import).
  if (Visual._frameVideoTextures) Visual._frameVideoTextures.clear();
  // Sprint 7.5.3a -- clear the per-frame camera-evaluation cache so
  // Camera param changes propagate to every Scene that references it.
  // Re-populated on first Scene render this frame.
  if (Visual._frameCameraCache) Visual._frameCameraCache.clear();
  // Sprint 7.5.3c -- ditto for the light cache.
  if (Visual._frameLightCache) Visual._frameLightCache.clear();

  // Phase 6.5.3 + 6.5.4 — refresh FFT bins in the SAB from the
  // main-thread analyser, then write the SAB audio + JS-side
  // MasterClock state into the GPU audio uniform. Clock state lives
  // in u_audio.values[2].w (bpm) + values[3] (bar/beat/sixteenth/phase)
  // -- see _writeClockUniformSlots for the layout. The wired-param
  // path (Plasma.clockReact <- MasterClock.beat) keeps working
  // unchanged via _resolveNodeParams; this is a parallel path that
  // lets unwired shaders also tempo-sync.
  _updateAudioFft();
  _writeAudioUniform();

  // §5.5.f -- FPCamera tick (mouse + keys -> per-frame pos / yaw / pitch).
  // Lazy-wires the document-level input listeners on first call so the
  // setup cost is paid once when the user is actually using an FPCamera.
  _wireFPCameraInput();
  _tickFPCameras(dtSec);
  // Phase 8.I.1 -- StateMachine ticks first so its current/enter/
  // transitioning gates are fresh when downstream consumers
  // (StageManager.active wires) read them this same frame.
  _tickStateMachines(dtSec);
  // Phase 8.A.3 -- expand any unrendered PrefabInstances + sync
  // override values to their child nodes. Runs FIRST so the rest
  // of the tick + render path sees the propagated overrides.
  _tickPrefabInstances();
  // Phase 8.A.5 -- expand + tick Pool voices. Same first-position
  // ordering: pool voice lifetimes + spawns settle before stages,
  // gameplay, and rendering see them.
  _tickPools(dtSec);
  // Phase 8.A.2 -- StageManager runs after StateMachine + prefab
  // expansion so it sees the freshly-transitioned state and any
  // stage tags on instance children.
  _tickStageManager();
  // Phase 8.A.1 -- lifecycle event nodes (OnAwake / OnStart /
  // OnUpdate / OnDestroy). Runs BEFORE _tickGameInputs so any
  // lifecycle-triggered Reset action (8.A-reset) has a chance to
  // restore state before this frame's physics tick reads it.
  _tickLifecycleNodes(dtSec);
  // Phase 8.B.1 -- Rapier 2D physics. Runs after lifecycle (so
  // OnAwake-triggered resets have fired) and before _tickGameInputs
  // (so PlatformerBody2D's legacy path + any physics-dependent game
  // logic sees fresh physics state this frame).
  _tickPhysics(dtSec);
  // Phase 8.0.3-b / 8.B.6 -- Rapier 3D physics (same slot as 2D).
  _tickPhysics3D(dtSec);
  _tickFractureMeshes();
  _tickDestructibles3D(dtSec);
  _tickRopes(dtSec);
  _tickCloths(dtSec);
  _tickSoftBodies(dtSec);
  // Phase 8.B.15: third-person camera follows AFTER physics so it
  // tracks the post-step character position.
  _tickThirdPersonCameras(dtSec);
  // Sprint platformer-1 -- game-input nodes (KeyAxis2D / PlatformerBody2D).
  // Lazy-wires its own keyboard listener on first use; no-op when no
  // game-input nodes are in the patch.
  _tickGameInputs(dtSec);
  // Phase B sprint 4 -- LLM sink nodes (LLMChat / LLMGenerate / LLMEmbed).
  // Detects rising edges on their `trigger` gates and kicks the async
  // Ollama fetch. Streams tokens into the node body. No-op when no
  // llm-sink nodes are in the patch.
  _tickLLMRuntime(dtSec);
  // Phase C sprint tektite-5c -- TektiteGraph nodes (knowledge graph
  // as a texture). Walks vault, runs force-directed sim, renders to
  // an offscreen canvas, uploads to a GPUTexture each frame. No-op
  // when no TektiteGraph nodes are in the patch.
  if (typeof tickTektiteGraphTextures === "function") tickTektiteGraphTextures(dtSec);
  // Phase C sprint tektite-10b+ -- Tektite card kinds (TextCard /
  // NoteCard / LinkCard / BaseCard) get their content rendered into
  // an inline body element on the main canvas, similar to the LLM
  // streaming bodies. Cheap per-frame walk; no-op when no card nodes
  // are in the patch.
  if (typeof _tickTektiteCards === "function") _tickTektiteCards(dtSec);
  // §5.5.g -- HUD overlays. Minimap is the first; future Compass /
  // HealthBar / Inventory will plug in here as separate functions.
  // Each renders only when its driving node exists in the patch.
  _tickMinimapNodes();
  _tickAltimeterNodes();
  _tickHudTextNodes();
  // Phase 8.D.1 -- core UI widgets (buttons / text / panels) live on
  // the same overlay layer as HUDs. UIButton's clicked + hovered
  // pulses are set here; StateMachine's transN inputs read them on
  // the NEXT tick (UI ticks AFTER state machine this frame, so the
  // click registers next-frame -- one tick of latency, fine for UI).
  _tickUiNodes();
  // Sprint hud-text -- composite Visual.canvas + visible HUDs into
  // the video compositor IF a recording is active. No-op otherwise.
  _tickCaptureCompositor();

  const enc = Visual.device.createCommandEncoder({ label: "visual-frame" });

  // Sprint 7.6.b-atm Tier-C.1+C.4 -- regenerate the atmosphere LUTs
  // once per frame, before any scene pass. Transmittance + multi-
  // scatter LUTs are camera-independent (planet-relative geometry);
  // sky-view LUT IS camera-dependent (integrates atmosphere FROM the
  // camera) so we need the camera position + sun direction.
  //
  // We pick the FIRST FPCamera/Camera in state.nodes and the FIRST
  // Sun node for sun direction. Multi-camera setups would need a LUT
  // per camera, but that's deferred (C.6); for now Foot-to-Orbit and
  // most patches have a single camera.
  {
    const planetInfo = (typeof _findPlanetInfo === "function") ? _findPlanetInfo() : null;
    if (planetInfo && planetInfo.radius > 0) {
      // Find the first camera node and call _evaluateCamera to get the
      // full basis the aerial-perspective LUT needs (camRight/Up/Forward
      // with tanHFov*aspect in .w, matching vs_sky's convention).
      let camera = null;
      let sunDir = null;
      if (state && Array.isArray(state.nodes)) {
        for (const n of state.nodes) {
          if (!n) continue;
          if (!camera && (n.type === "FPCamera" || n.type === "Camera")) {
            if (typeof _evaluateCamera === "function") {
              try { camera = _evaluateCamera(n, Visual.fbWidth, Visual.fbHeight); }
              catch (e) { camera = null; }
            }
          }
        }
      }
      if (typeof _planetSunDir === "function") {
        const sd = _planetSunDir();
        if (sd && sd.length >= 3) sunDir = [sd[0], sd[1], sd[2]];
      }
      _renderAtmosphereLUTs(enc, planetInfo, camera, sunDir);
    }
  }

  const rendered = _encodeVisualGraph(enc, dtSec);

  const previewMode = (state && state.rig && state.rig.previewMode) || "tile";
  if (rendered && previewMode === "theater" && Visual.theaterPipeline && Visual.theaterBindGroup) {
    // Phase 6.6.13 — theater preview. Renders display quads in 3D
    // space; bypasses rig composite + warp (those are tile/cylinder/
    // equirect/fisheye-mode concepts).
    _encodeTheaterPass(enc, dtSec);
  } else if (rendered && Visual.rigCompositePipeline && Visual.rigCompositeBindGroup) {
    _encodeRigComposite(enc);
    // Phase 6.6.4 — overdraw warped tiles on top of the un-warped
    // composite. No-op when no display has a warpMesh or when the
    // preview is in a non-tile mode.
    _encodeWarpPasses(enc);
  } else {
    // No VisualOutputs / nothing renderable → smoke-clear path. Clears
    // layer 0 + blits via the original single-texture pipeline so the
    // canvas falls back to the dark backdrop instead of stale frames.
    if (Visual.framebufferLayerViews[0]) {
      enc.beginRenderPass({
        label: "fbo-smoke-clear",
        colorAttachments: [{
          view: Visual.framebufferLayerViews[0],
          clearValue: { r: 10/255, g: 14/255, b: 22/255, a: 1.0 },
          loadOp: "clear",
          storeOp: "store"
        }]
      }).end();
    }
    if (Visual.blitPipeline && Visual.blitBindGroup) {
      let canvasView;
      try { canvasView = Visual.context.getCurrentTexture().createView(); }
      catch (e) { console.warn("[visual] canvas getCurrentTexture failed:", e); Visual.device.queue.submit([enc.finish()]); return; }
      const vp = _blitViewport();
      const blit = enc.beginRenderPass({
        label: "fbo-blit-fallback",
        colorAttachments: [{
          view: canvasView,
          clearValue: { r: 0, g: 0, b: 0, a: 1.0 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      blit.setPipeline(Visual.blitPipeline);
      blit.setBindGroup(0, Visual.blitBindGroup);
      blit.setViewport(vp.x, vp.y, vp.w, vp.h, 0, 1);
      blit.draw(3);
      blit.end();
    }
  }

  // v0.2.21 — per-display recording blit hook. When the user starts
  // a per-display recording, this encodes one fullscreen-triangle
  // blit pass per recorder canvas, sampling Visual.framebufferLayerViews[i]
  // through the existing blit pipeline. Same command encoder as the
  // main frame so all the blits commit in one queue.submit. Skips
  // silently when no recording is active.
  _encodePerDisplayBlitsIntoEncoder(enc);

  // Phase 6.3.2 — capture this frame's framebuffer into the feedback
  // array so next frame's FeedbackShader sees it as "previous." The
  // copy queues after every render pass that writes the framebuffer
  // (shader-frag passes only — the composite/theater write to the
  // canvas, not to the framebuffer). Cheap GPU copy: ~8 MB at 1080p
  // × 32 layers, single submit-side cost.
  if (Visual.feedbackArray && Visual.framebuffer && Visual.framebufferLayerViews.length > 0) {
    const layerCount = Visual.framebufferLayerViews.length;
    enc.copyTextureToTexture(
      { texture: Visual.framebuffer,   origin: { x: 0, y: 0, z: 0 } },
      { texture: Visual.feedbackArray, origin: { x: 0, y: 0, z: 0 } },
      [Visual.fbWidth, Visual.fbHeight, layerCount]
    );
  }

  Visual.device.queue.submit([enc.finish()]);

  // §bonus-perf-diag (2026-05-25) -- dump the per-frame counters.
  // Sparse (every 60 frames) and only when something changed, so
  // the console doesn't spam when idle.
  if (typeof _perfFrameDump === "function") _perfFrameDump();
}

function _visualRenderTick(t) {
  // Bail if the device went away (loss handler in ensureGPUDevice
  // sets Visual.device = null). Don't re-arm rAF in that case —
  // a fresh ensureGPUDevice() call will restart the loop.
  if (!Visual.device) {
    _visualRafHandle = null;
    return;
  }
  _tickFpsReadout(t);
  // Phase 6.7.4 -- bracket the encode pass with a perf.now() pair
  // for frame-time. Counters were reset by renderVisualFrame()
  // itself; we read them back out after submit returns. (GPU work
  // is fire-and-forget from queue.submit; this captures CPU encode
  // + queue-submit wall-clock, NOT GPU shading time. Tooltip on the
  // overlay row makes this distinction explicit.)
  let frameTimeMs = 0;
  if (!Visual.frozen) {
    const t0 = performance.now();
    _resetPerfFrameCounters();
    renderVisualFrame();
    frameTimeMs = performance.now() - t0;
  }
  _tickPerfOverlay(t, frameTimeMs);
  // Phase 6.5.16 — gizmo redraw. Cheap (single 280×280 canvas2d
  // pass, ~200 line segments) and only runs when the gizmo is open.
  if (_gizmoOpen) _drawGizmoFrame();
  // Phase 6.6.4b — RigGizmo overlay on the visual canvas. The
  // function early-outs when no RigGizmo node exists in the patch
  // so this is effectively free for patches that don't use it.
  _drawVisualOverlay();
  // v0.3.6 — Path A live-control bridge. Push the latest MediaPipe
  // (and future LFO / EnvFollow / etc) values into the audio worklet
  // via setter postMessages. No-op when audio preview isn't playing
  // OR when no live-control nodes have wires to audio-rate consumers.
  _pushLiveControlsToWorklet();
  // v0.3.47 -- OSC outbound. Reads JS-side values of OscOut nodes'
  // wired inputs + sends via WS to the compile-server bridge. Cheap:
  // change-detection skips identical messages so an idle OscOut is
  // silent. Bails immediately if no OscOut nodes are in the patch.
  _tickOscOut();
  // v0.3.16 — VideoFile retrigger from gate input. Cheap (one wire
  // lookup per VideoFile node, typically zero); runs every frame.
  _tickVideoFileTrigs();
  _visualRafHandle = requestAnimationFrame(_visualRenderTick);
}

/* v0.3.6 — Path A live-control bridge (rAF cadence).
 *
 * For every node in the patch that's a "live JS-driven control
 * source" (HandLandmarker so far; PoseLandmarker / FaceLandmarker /
 * future audio-rate LFOs slot in next), find its setter indices in
 * the worklet's dispatch table + post each updated value via the
 * standard {type:"set", index, value} message that Slider already
 * uses.
 *
 * Cost: 13 postMessages per HandLandmarker per frame (~780/sec at
 * 60fps for one detector). Web Audio handles thousands easily; the
 * actual latency from gesture → audio is one quantum (~2.7 ms at
 * 48 kHz × 128-sample quantum).
 *
 * Only fires when:
 *   - The preview is playing (workletNode + state === "playing")
 *   - The patch contains a live-control source
 *   - The source has at least one wire to a downstream audio-side
 *     node (skipped if the source's outputs only feed shader params)
 *
 * The "wired to audio" filter avoids spamming postMessage for nodes
 * whose outputs only drive shader uniforms (no setter exists in the
 * worklet for those -- the wire resolves entirely in JS via the
 * shader-side wired-param resolver). */
let _liveControlSettersCache = { generation: -1, indices: null };
function _refreshLiveControlSetters() {
  // Recompute when the patch shape changes (we increment a generation
  // counter; lightweight check below). For now we just rebuild every
  // call -- collectExposedSetters is O(nodes * params), small for
  // typical patches.
  const setters = collectExposedSetters();
  const map = new Map();          // nodeId -> { key -> setterIndex }
  for (let i = 0; i < setters.length; i++) {
    const s = setters[i];
    if (!s.nodeId) continue;
    let inner = map.get(s.nodeId);
    if (!inner) { inner = {}; map.set(s.nodeId, inner); }
    inner[s.key] = i;
  }
  return map;
}

const _HAND_LIVE_PORTS = [
  "present", "numHands",
  "h1_x", "h1_y", "h1_z", "h1_pinch", "h1_open", "h1_rot",
  "h2_x", "h2_y", "h2_z", "h2_pinch", "h2_open", "h2_rot"
];
const _POSE_LIVE_PORTS = [
  "present", "numPoses",
  "nose_x", "nose_y",
  "lshoulder_x", "lshoulder_y", "rshoulder_x", "rshoulder_y",
  "lelbow_x", "lelbow_y", "relbow_x", "relbow_y",
  "lwrist_x", "lwrist_y", "rwrist_x", "rwrist_y",
  "lhip_x", "lhip_y", "rhip_x", "rhip_y",
  "lknee_x", "lknee_y", "rknee_x", "rknee_y"
];
const _FACE_LIVE_PORTS = [
  "present", "numFaces",
  "face_x", "face_y",
  "jawOpen",
  "mouthSmileLeft", "mouthSmileRight",
  "mouthFrownLeft", "mouthFrownRight",
  "mouthPucker",
  "eyeBlinkLeft", "eyeBlinkRight",
  "eyeWideLeft",  "eyeWideRight",
  "browDownLeft", "browDownRight",
  "browInnerUp",
  "cheekPuff"
];
const _HANDKB_LIVE_PORTS = [
  "present", "gate", "freq", "midi", "note_idx"
];
const _BLOB_LIVE_PORTS = [
  "present", "numBlobs",
  "b1_x", "b1_y", "b1_size",
  "b2_x", "b2_y", "b2_size",
  "b3_x", "b3_y", "b3_size",
  "b4_x", "b4_y", "b4_size"
];

function _pushLiveControlsToWorklet() {
  if (!previewState || previewState.state !== "playing" || !previewState.workletNode) return;
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  const hands  = state.nodes.filter(n => n && n.type === "HandLandmarker");
  const poses  = state.nodes.filter(n => n && n.type === "PoseLandmarker");
  const faces  = state.nodes.filter(n => n && n.type === "FaceLandmarker");
  const handkb = state.nodes.filter(n => n && n.type === "HandKeyboard");
  const blobs  = state.nodes.filter(n => n && n.type === "BlobTracker");
  if (hands.length === 0 && poses.length === 0 && faces.length === 0 && handkb.length === 0 && blobs.length === 0) return;
  const setterIndex = _refreshLiveControlSetters();
  // v0.3.8 — push EVERY live port that has a setter index in the
  // worklet's dispatch table, regardless of whether the wire goes
  // through template nodes (Mul / Add / Tanh — cppType "" — inlined
  // at codegen time). The earlier "wired to audio" filter broke on
  // those hops + left gates stuck at 0. Unused setter writes are
  // harmless: the C++ class member just stores the value.
  const push = (node, ports, valueFn) => {
    const innerMap = setterIndex.get(node.id);
    if (!innerMap) return;
    for (const port of ports) {
      const idx = innerMap[port];
      if (typeof idx !== "number") continue;
      previewState.workletNode.port.postMessage({
        type: "set", index: idx, value: valueFn(node, port)
      });
    }
  };
  for (const node of hands)  push(node, _HAND_LIVE_PORTS,    _handLandmarkerValue);
  for (const node of poses)  push(node, _POSE_LIVE_PORTS,    _poseLandmarkerValue);
  for (const node of faces)  push(node, _FACE_LIVE_PORTS,    _faceLandmarkerValue);
  for (const node of handkb) push(node, _HANDKB_LIVE_PORTS,  _handKeyboardValue);
  for (const node of blobs)  push(node, _BLOB_LIVE_PORTS,    _blobTrackerValue);

  // v0.3.47 -- OscIn live-control. The values v1..v4 are already in
  // node.params (set by _dispatchOscIn when WS messages arrive); the
  // push here simply forwards them to the worklet so the C++ class's
  // member values stay in sync. Same shape as Slider's "drag updates
  // the value, push setter" path, just driven by network instead of
  // mouse.
  const oscIns = state.nodes.filter(n => n && n.type === "OscIn");
  for (const node of oscIns) {
    push(node, _OSC_IN_LIVE_PORTS, (n, port) => {
      const v = n && n.params && n.params[port];
      return typeof v === "number" ? v : 0;
    });
  }
}
const _OSC_IN_LIVE_PORTS = ["v1", "v2", "v3", "v4"];

