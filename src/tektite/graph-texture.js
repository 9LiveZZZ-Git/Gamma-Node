/* =========================================================================
 * Tektite MD -- TektiteGraph visual node (GPUTexture emitter)
 *
 * Phase C sprint tektite-5c. The Tektite-unique upgrade vs Obsidian:
 * the knowledge graph isn't a sandboxed pane but a first-class TEXTURE
 * SOURCE in the visual node pipeline.  Wire `tex` into Sprite,
 * ShaderFrag, Scene2D, Materials, etc. and the live force-directed
 * layout becomes a sampleable texture.
 *
 * Per-frame loop (tickTektiteGraphTextures, called from
 * src/visual/render-loop.js):
 *
 *   for each TektiteGraph node n:
 *     1. Lazy-build graph data (tektiteGraphBuild) on first tick OR
 *        when mode/depth/centerId params change.  Stamps a "rebuild"
 *        signature so config tweaks reset the cache cleanly.
 *     2. Ensure an OffscreenCanvas at (width x height) + a GPUTexture
 *        of the same size; reallocate on dimension change.
 *     3. Step the Verlet sim 2x per frame (matches graph.js's modal
 *        renderer pacing) until the layout settles.
 *     4. Draw nodes + edges to the OffscreenCanvas.
 *     5. Upload via device.queue.copyExternalImageToTexture.
 *     6. Stash _textureEntry = { texture, view, width, height,
 *        state: "ready" } on the node so the existing
 *        _resolveSpriteTextureEntry walk in src/visual/framebuffer.js
 *        can pick it up as a Sprite/Tilemap texture input.
 *
 * Stop conditions: pause the sim when the layout settles (KE below
 * threshold), pause the upload too (no point re-uploading identical
 * pixels). Resume on user interaction in the modal (shared `wakeup`
 * counter) or on graph-data rebuild.
 *
 * Public surface:
 *   tickTektiteGraphTextures(dtSec)
 *       Invoked from the per-frame render loop. Walks every
 *       TektiteGraph node, advances its sim + texture upload.
 *
 *   _tektiteResolveTextureEntry(srcNode)
 *       Used by the modified _resolveSpriteTextureEntry in
 *       src/visual/framebuffer.js. Returns the entry stash or null.
 * ======================================================================== */

const _tektiteGraphTexState = new Map();   // nodeId -> per-node state

function _tektiteGraphTexNodeState(node) {
  let st = _tektiteGraphTexState.get(node.id);
  if (!st) {
    st = {
      graph:         null,
      graphBuilding: false,
      configSig:     "",     // detects mode/depth/centerId/minDeg changes
      canvas:        null,
      ctx:           null,
      texture:       null,
      view:          null,
      texW:          0,
      texH:          0,
      iterations:    0,
      kineticEnergy: 0,
      lastUploadAt:  0
    };
    _tektiteGraphTexState.set(node.id, st);
  }
  return st;
}

function _tektiteConfigSig(node) {
  const p = node.params || {};
  return [p.mode || "global", p.depth | 0, p.centerId || "", p.minDegree | 0].join("|");
}

async function _tektiteBuildGraphForNode(node, st) {
  if (st.graphBuilding) return;
  st.graphBuilding = true;
  const p = node.params || {};
  try {
    st.graph = await tektiteGraphBuild({
      mode:      p.mode || "global",
      centerId:  p.centerId || (typeof tektiteEditorCurrentNoteId === "function"
                                ? tektiteEditorCurrentNoteId() : null),
      depth:     p.depth | 0 || 2,
      minDegree: p.minDegree | 0
    });
    st.configSig   = _tektiteConfigSig(node);
    st.iterations  = 0;
    st.kineticEnergy = 999;  // wake the sim on the first tick
  } catch (e) {
    console.warn("[tektite-graph-tex] build failed:", e);
  } finally {
    st.graphBuilding = false;
  }
}

/* Detect if this TektiteGraph node is wired (directly or via Sprite)
 * into a VisualOutput. When yes, the framework's tektite-graph
 * branch in shader-frag-pass.js needs the canvas sized to
 * Visual.fbWidth x Visual.fbHeight so copyExternalImageToTexture
 * lands in the framebuffer layer.  When no, the user's width/height
 * params win (the texture is consumed via Sprite sampling, which is
 * size-agnostic). */
function _tektiteHasVoDownstream(node) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.edges)) return false;
  // Cheap one-hop check: edges from this node to a VisualOutput.
  for (const e of state.edges) {
    if (!e || !e.from || !e.to) continue;
    if (e.from.node !== node.id) continue;
    const dst = state.nodes.find(n => n && n.id === e.to.node);
    if (dst && dst.type === "VisualOutput") return true;
  }
  return false;
}

function _tektiteEnsureTexture(node, st) {
  const p = node.params || {};
  let w, h;
  if (_tektiteHasVoDownstream(node) &&
      typeof Visual !== "undefined" && Visual.fbWidth && Visual.fbHeight) {
    // Sprint tektite-5c1 -- wire to VisualOutput: match framebuffer
    // dims so the layer-copy in shader-frag-pass.js works.
    w = Visual.fbWidth;
    h = Visual.fbHeight;
  } else {
    w = Math.max(64, Math.min(2048, (p.width  | 0) || 512));
    h = Math.max(64, Math.min(2048, (p.height | 0) || 512));
  }
  if (st.canvas && st.texW === w && st.texH === h && st.texture) return;
  // Reallocate.
  if (st.texture) { try { st.texture.destroy(); } catch (_) {} }
  if (typeof OffscreenCanvas !== "undefined") {
    st.canvas = new OffscreenCanvas(w, h);
  } else {
    st.canvas = document.createElement("canvas");
    st.canvas.width = w; st.canvas.height = h;
  }
  st.ctx = st.canvas.getContext("2d");
  if (typeof Visual !== "undefined" && Visual.device) {
    st.texture = Visual.device.createTexture({
      label: "tektite-graph-" + node.id,
      size:  [w, h, 1],
      format: "rgba8unorm",
      usage:  GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.RENDER_ATTACHMENT
    });
    st.view = st.texture.createView();
  }
  st.texW = w; st.texH = h;
}

function _tektiteDrawGraphFrame(st, node) {
  const ctx = st.ctx;
  const g   = st.graph;
  if (!ctx || !g) return;
  const p = node.params || {};
  const w = st.texW, h = st.texH;

  // Compute graph bounds + a transform that centers + scales the
  // layout to fit the texture with a 30 px margin.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of g.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  if (!Number.isFinite(minX) || g.nodes.length === 0) {
    minX = -100; maxX = 100; minY = -100; maxY = 100;
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const margin = 30;
  const scale = Math.min((w - margin * 2) / spanX, (h - margin * 2) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const tx = (gx) => w / 2 + (gx - cx) * scale;
  const ty = (gy) => h / 2 + (gy - cy) * scale;

  // Background.
  const bgR = typeof p.bgR === "number" ? p.bgR : 0.04;
  const bgG = typeof p.bgG === "number" ? p.bgG : 0.05;
  const bgB = typeof p.bgB === "number" ? p.bgB : 0.09;
  ctx.fillStyle = "rgba(" + Math.round(bgR * 255) + "," +
                            Math.round(bgG * 255) + "," +
                            Math.round(bgB * 255) + ",1)";
  ctx.fillRect(0, 0, w, h);

  // Edges (single-pass).
  const edgeR = typeof p.edgeR === "number" ? p.edgeR : 0.61;
  const edgeG = typeof p.edgeG === "number" ? p.edgeG : 0.81;
  const edgeB = typeof p.edgeB === "number" ? p.edgeB : 1.0;
  const edgeA = typeof p.edgeA === "number" ? p.edgeA : 0.30;
  ctx.strokeStyle = "rgba(" + Math.round(edgeR * 255) + "," +
                              Math.round(edgeG * 255) + "," +
                              Math.round(edgeB * 255) + "," + edgeA + ")";
  ctx.lineWidth = Math.max(0.5, scale * 0.6);
  ctx.beginPath();
  for (const e of g.edges) {
    const a = g.nodes[e.source], b = g.nodes[e.target];
    ctx.moveTo(tx(a.x), ty(a.y));
    ctx.lineTo(tx(b.x), ty(b.y));
  }
  ctx.stroke();

  // Nodes.
  const nodeR = typeof p.nodeR === "number" ? p.nodeR : 0.78;
  const nodeG = typeof p.nodeG === "number" ? p.nodeG : 0.91;
  const nodeB = typeof p.nodeB === "number" ? p.nodeB : 0.35;
  ctx.fillStyle = "rgba(" + Math.round(nodeR * 255) + "," +
                            Math.round(nodeG * 255) + "," +
                            Math.round(nodeB * 255) + ",1)";
  for (const n of g.nodes) {
    const r = Math.max(2, Math.min(12, scale * (1.5 + Math.log2(1 + n.degree) * 0.8)));
    ctx.beginPath();
    ctx.arc(tx(n.x), ty(n.y), r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function _tektiteUploadToTexture(st) {
  if (!st.texture || !st.canvas) return;
  if (typeof Visual === "undefined" || !Visual.device) return;
  try {
    Visual.device.queue.copyExternalImageToTexture(
      { source: st.canvas, flipY: false },
      { texture: st.texture },
      [st.texW, st.texH, 1]
    );
  } catch (e) {
    // OffscreenCanvas on stale browsers may need an explicit
    // transferToImageBitmap step; fall back if the direct upload
    // chokes.
    try {
      const bm = st.canvas.transferToImageBitmap
        ? st.canvas.transferToImageBitmap()
        : null;
      if (bm) {
        Visual.device.queue.copyExternalImageToTexture(
          { source: bm }, { texture: st.texture }, [st.texW, st.texH, 1]
        );
      }
    } catch (e2) {
      console.warn("[tektite-graph-tex] upload failed:", e, e2);
    }
  }
}

/* Per-frame tick. Called from the visual render loop alongside the
 * other runtime-only kinds. Cheap when there are no TektiteGraph
 * nodes (early-out on the first iter). */
function tickTektiteGraphTextures(dtSec) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  if (typeof Visual === "undefined" || !Visual.device) return;
  for (let i = 0; i < state.nodes.length; i++) {
    const n = state.nodes[i];
    if (!n || n.type !== "TektiteGraph") continue;
    _tickTektiteGraphNode(n, dtSec);
  }
}

function _tickTektiteGraphNode(node, dtSec) {
  const st = _tektiteGraphTexNodeState(node);

  // Rebuild if config changed or first time.
  const sig = _tektiteConfigSig(node);
  if (!st.graph && !st.graphBuilding) {
    _tektiteBuildGraphForNode(node, st);
    return;
  }
  if (sig !== st.configSig && !st.graphBuilding) {
    _tektiteBuildGraphForNode(node, st);
    return;
  }
  if (st.graphBuilding) return;

  _tektiteEnsureTexture(node, st);
  if (!st.texture || !st.ctx) return;

  // Sim cap -- after 500 iters the layout force-settles. Same logic
  // as the modal renderer in graph.js so the texture matches what
  // the user sees in the graph view.
  const MAX_ITERATIONS = 500;
  if (st.iterations < MAX_ITERATIONS && st.kineticEnergy > 0.05) {
    // 2 steps per frame for crisper settling.
    st.kineticEnergy = tektiteGraphSimulateStep(st.graph.nodes, st.graph.edges, {});
    st.kineticEnergy = tektiteGraphSimulateStep(st.graph.nodes, st.graph.edges, {});
    st.iterations += 2;
    _tektiteDrawGraphFrame(st, node);
    _tektiteUploadToTexture(st);
    st.lastUploadAt = performance.now();
  } else if (st.lastUploadAt === 0) {
    // First-time settle path -- draw + upload once even if KE was
    // tiny from the build.
    _tektiteDrawGraphFrame(st, node);
    _tektiteUploadToTexture(st);
    st.lastUploadAt = performance.now();
  }

  // Stash the texture entry so the existing visual pipeline's
  // _resolveSpriteTextureEntry walker can pick it up. The entry shape
  // mirrors what _ensureImageURLTexture returns.
  node._textureEntry = {
    texture: st.texture,
    view:    st.view,
    width:   st.texW,
    height:  st.texH,
    state:   "ready"
  };
}

/* Pluggable resolver hook for src/visual/framebuffer.js.  Returns the
 * texture entry stash, or null if the node isn't a TektiteGraph
 * (or hasn't been ticked yet). */
function _tektiteResolveTextureEntry(srcNode) {
  if (!srcNode || srcNode.type !== "TektiteGraph") return null;
  return srcNode._textureEntry || null;
}
