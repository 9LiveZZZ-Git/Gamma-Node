/* Phase 6.6.30 + v0.2.16 — walk the patch graph from each VisualOutput
 * and build a per-VO render schedule plus a flat key->entry map for
 * texture-input resolution. Three properties to maintain:
 *
 *   1. Scratch slots are RELATIVE indices (0..SCRATCH_BUDGET-1) into
 *      the per-parity scratch texture. Per-VO counters reset to 0,
 *      with separate counters for "a" and "b" textures.
 *
 *   2. Per-VO schedule is post-order DFS (leaves first, target last)
 *      so by the time a composition pass runs, all its upstream
 *      scratch slots have been written this frame.
 *
 *   3. v0.2.16 — chain depth tracked recursively. depth=0 = direct
 *      VO consumer (writes framebuffer). depth=N = N levels above
 *      the VO in the chain (writes scratch). Each entry carries:
 *        readKey  = (depth     % 2 === 0) ? "a" : "b"
 *        writeKey = ((depth-1) % 2 === 0) ? "a" : "b"   (depth >= 1)
 *      Composition shaders bind READ key for their texture and
 *      attach a layer of the WRITE key's scratch texture. They are
 *      always different parities, so WebGPU never sees the same
 *      texture in both TextureBinding and RenderAttachment in one pass.
 *
 * planKey:    `${sourceNodeId}@${consumerVOId}` -- unique per
 *             (source × consumer VO) pair. Lookup target for
 *             _resolveTextureInputLayer.
 * planEntry:  { node, def, layerIdx, consumerVO, isScratch,
 *               depth, readKey, writeKey }. layerIdx is RELATIVE to
 *             whichever scratch texture writeKey selects (for
 *             isScratch) or the framebuffer display layer (direct). */
function _buildRenderPlan(visualOutputs) {
  const plan = new Map();
  const schedules = new Map();
  if (!Array.isArray(state.edges) || !Array.isArray(state.nodes)) {
    return { plan, schedules };
  }

  const rigDisplayCount = (state.rig && state.rig.displays) ? state.rig.displays.length : 1;
  const SCRATCH_BUDGET = (typeof Visual.scratchBudget === "number") ? Visual.scratchBudget : 8;

  for (const vo of visualOutputs) {
    const sched = [];
    schedules.set(vo.id, sched);
    // Per-parity scratch counters (v0.2.16). Each parity has up to
    // SCRATCH_BUDGET slots; the per-VO walk uses one slot from the
    // matching counter per scratch entry.
    let counterA = 0;
    let counterB = 0;

    function walk(nodeId, isViaCompPort, depth) {
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;
      const def = TYPES[node.type];
      // v0.3.3 — "ai-vision-canvas" is the second kind that participates
      // in the visual render plan. Doesn't have a WGSL shader; instead
      // the framework queues a copyExternalImageToTexture from a 2D
      // canvas (where the detection loop drew video + landmark overlay)
      // straight into the assigned framebuffer/scratch layer. The plan
      // walker treats it like a shader-frag for layer assignment +
      // post-order DFS scheduling, then _encodeShaderFragPassForPlan
      // dispatches by kind at encode time.
      if (!def) return;
      // R.2: StageManager is a texture router — trace through
      // only the active stage's input, skip inactive scenes.
      if (def.kind === "stage-manager") {
        const activeIdx = Math.floor(node.params && typeof node.params.current === "number" ? node.params.current : 0);
        const portName = "in" + Math.max(0, Math.min(3, activeIdx));
        const wire = state.edges.find(e =>
          e && e.to && e.to.node === nodeId && e.to.port === portName
        );
        if (wire && wire.from) walk(wire.from.node, isViaCompPort, depth);
        return;
      }
      const isShaderFrag = def.kind === "shader-frag" &&
                           (typeof def.wgsl === "string" || typeof def.wgsl === "function");
      const isAiCanvas   = def.kind === "ai-vision-canvas";
      // Sprint 7.5.3a -- Scene nodes also produce a layer (their
      // 3D render lands in a framebuffer / scratch layer like a
      // shader-frag's output), so they participate in the plan
      // walk. Mesh + Camera inputs aren't layer-producers and
      // get resolved at encode time, not via the plan.
      const isScene      = def.kind === "scene";
      // Sprint 7.5.6.a part 2d -- RayTracedScene is the RT
      // equivalent of Scene; same plan-walker treatment. Its
      // output is a blit of the streamed RT texture onto the
      // assigned framebuffer/scratch layer.
      const isSceneRt    = def.kind === "scene-rt";
      // Phase C sprint tektite-5c1 -- TektiteGraph emits a 2D canvas
      // that gets copyExternalImageToTexture'd into the assigned
      // framebuffer / scratch layer, the same model as
      // ai-vision-canvas. Plan walker treats it as a layer producer;
      // dispatch in shader-frag-pass.js's "tektite-graph" branch.
      const isTektiteGraph = def.kind === "tektite-graph";
      if (!isShaderFrag && !isAiCanvas && !isScene && !isSceneRt && !isTektiteGraph) return;

      const planKey = node.id + "@" + vo.id;
      if (plan.has(planKey)) return;

      // readKey: which scratch texture THIS node reads from when it
      //   binds the composition layout (= parity of depth).
      // writeKey: which scratch texture THIS scratch entry writes to.
      //   Always opposite parity of readKey so a single pass never
      //   binds + attaches the same texture.
      const readKey  = (depth      % 2 === 0) ? "a" : "b";
      const writeKey = isViaCompPort
        ? (((depth - 1) % 2 === 0) ? "a" : "b")
        : null;

      let layerIdx;
      let isScratch;
      if (isViaCompPort) {
        if (writeKey === "a") {
          if (counterA >= SCRATCH_BUDGET) return;
          layerIdx = counterA++;
        } else {
          if (counterB >= SCRATCH_BUDGET) return;
          layerIdx = counterB++;
        }
        isScratch = true;
      } else {
        layerIdx = (vo.params && typeof vo.params.display === "number")
          ? (vo.params.display | 0) : 0;
        if (layerIdx < 0) layerIdx = 0;
        if (layerIdx >= rigDisplayCount) layerIdx = rigDisplayCount - 1;
        isScratch = false;
      }

      const entry = { node, def, layerIdx, consumerVO: vo, isScratch, depth, readKey, writeKey };
      plan.set(planKey, entry);

      // Recurse FIRST (post-order DFS) so leaves render before
      // their downstream consumers within the schedule.
      if (Array.isArray(def.ins)) {
        for (const port of def.ins) {
          if (!port || port.t !== "texture") continue;
          const wire = state.edges.find(e =>
            e && e.to && e.to.node === nodeId && e.to.port === port.n
          );
          if (!wire || !wire.from) continue;
          walk(wire.from.node, true, depth + 1);
        }
      }
      // Sprint 7.5.3c push 5 -- Scene nodes also need to schedule
      // upstream visuals wired into any ShaderMat's `texture` input
      // somewhere down the mesh chain. Walk through mesh-typed
      // inputs (mesh1..mesh4) through transforms + materials until
      // we hit a mesh-gen leaf, calling `walk` on any texture input
      // encountered on a ShaderMat node. The upstream gets
      // scheduled into a scratch slot before this Scene renders.
      if (isScene && Array.isArray(def.ins)) {
        const visited = new Set();
        const walkMeshChainForTextures = (chainNodeId, chainDepth) => {
          if (chainDepth > 16 || visited.has(chainNodeId)) return;
          visited.add(chainNodeId);
          const chainNode = state.nodes.find(n => n && n.id === chainNodeId);
          if (!chainNode) return;
          const chainDef = TYPES[chainNode.type];
          if (!chainDef) return;
          // Any texture-typed input on this chain node gets walked
          // (covers ShaderMat.texture). Schedule the upstream into
          // a scratch slot at depth+1 from THIS Scene.
          if (Array.isArray(chainDef.ins)) {
            for (const port of chainDef.ins) {
              if (!port || port.t !== "texture") continue;
              const w = state.edges.find(e =>
                e && e.to && e.to.node === chainNodeId && e.to.port === port.n
              );
              if (w && w.from) walk(w.from.node, true, depth + 1);
            }
          }
          // Recurse upstream through the chain. mesh-gen is a leaf.
          if (chainDef.kind === "material" || chainDef.kind === "mesh-transform") {
            const meshWire = state.edges.find(e =>
              e && e.to && e.to.node === chainNodeId && e.to.port === "mesh"
            );
            if (meshWire && meshWire.from) {
              walkMeshChainForTextures(meshWire.from.node, chainDepth + 1);
            }
          }
        };
        for (const port of def.ins) {
          if (!port || port.t !== "mesh") continue;
          const meshWire = state.edges.find(e =>
            e && e.to && e.to.node === nodeId && e.to.port === port.n
          );
          if (!meshWire || !meshWire.from) continue;
          walkMeshChainForTextures(meshWire.from.node, 0);
        }
      }
      sched.push(entry);
    }

    const incoming = state.edges.find(e =>
      e && e.to && e.to.node === vo.id && e.to.port === "in"
    );
    if (incoming && incoming.from) walk(incoming.from.node, false, 0);
  }
  return { plan, schedules };
}

