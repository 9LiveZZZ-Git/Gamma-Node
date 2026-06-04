/* =========================================================================
 * Geometry
 * ======================================================================== */
const NODE_W = 140;

function portPos(nodeId, portName, isOut) {
  // If this node is inside a collapsed group, the wire endpoint
  // redirects to the matching stub on the group's collapsed block
  // (rather than the now-hidden inner node). Returns null if the
  // edge is fully internal to a collapsed group (renderWires uses
  // null on either end as the "skip this wire" signal).
  const g = groupOfNode(nodeId);
  if (g && g.collapsed) {
    const ports = computeGroupPorts(g);
    const list = isOut ? ports.outputs : ports.inputs;
    const idx = list.findIndex(p => p.innerNode === nodeId && p.innerPort === portName);
    if (idx === -1) return null;
    const b = groupBounds(g);
    if (!b) return null;
    const x = isOut ? b.x + NODE_W : b.x;
    const y = b.y + 33 + idx * 20 + 10;
    return { x, y };
  }
  const n = nodeById(nodeId);
  if (!n) return null;
  const d = defOf(n);
  if (!d) return null;
  const list = isOut ? d.outs : d.ins;
  const idx = list.findIndex(p => p.n === portName);
  if (idx === -1) return null;
  const x = isOut ? n.x + NODE_W : n.x;
  const y = n.y + 33 + idx * 20 + 10;
  return { x, y };
}

function isConnected(nodeId, portName, isOut) {
  return state.edges.some(e =>
    isOut ? (e.from.node === nodeId && e.from.port === portName)
          : (e.to.node === nodeId && e.to.port === portName)
  );
}

/* =========================================================================
 * Render
 * ======================================================================== */
function render() {
  canvasWorld.querySelectorAll(".node").forEach(n => n.remove());
  canvasWorld.querySelectorAll(".group-backdrop").forEach(g => g.remove());

  // Recompute validation state once per render so node CSS classes
  // (cycle-error overlay, etc.) are up to date with the graph.
  state._cycleErrors = findInvalidCycles();

  // Groups — render expanded-group backdrops BEFORE nodes (lower
  // z-index so they sit visually behind their members). Collapsed
  // groups skip the backdrop and instead render as a single .node
  // block in the main loop below.
  (state.groups || []).forEach(g => {
    if (g.collapsed) return;
    const b = groupBounds(g);
    if (!b) return;
    const PAD = 18, HEAD = 26;
    const bd = document.createElement("div");
    bd.className = "group-backdrop" + (selectedGroupId === g.id ? " selected" : "");
    bd.dataset.groupId = g.id;
    bd.style.left = (b.x - PAD) + "px";
    bd.style.top  = (b.y - PAD - HEAD) + "px";
    bd.style.width  = (b.w + PAD * 2) + "px";
    bd.style.height = (b.h + PAD * 2 + HEAD) + "px";
    bd.innerHTML =
      `<div class="group-head">` +
        `<span class="group-mark">▾</span>` +
        `<span class="group-name">${escapeText(g.name)}</span>` +
        `<span class="group-meta">${g.members.length} nodes</span>` +
        `<button class="group-toggle-btn" data-group-toggle="${g.id}" title="Collapse this group (E)" aria-label="collapse">⊟</button>` +
      `</div>`;
    canvasWorld.appendChild(bd);
  });

  // Disconnected-output warning: if the patch has an Output / OutputStereo
  // node but it isn't fed by any edge, mark it amber so the user notices
  // before they wonder why the generated C++ returns 0.f.
  const outNode = state.nodes.find(n => n.type === "Output" || n.type === "OutputStereo");
  const outDisconnected = outNode && !state.edges.some(e => e.to.node === outNode.id);

  state.nodes.forEach(node => {
    const def = defOf(node);
    const isSel = selectedSet.has(node.id);

    // Skip nodes inside a collapsed group — the group renders its
    // own block via the loop further down. Wires that cross the
    // boundary get redirected to the group's port stubs in
    // renderWires.
    if (isInCollapsedGroup(node.id)) return;
    // Phase 8.A.3 -- skip children of PrefabInstances. They live in
    // state.nodes (so the existing tick + mesh resolver paths still
    // operate on them) but are visually hidden behind their parent
    // instance node, which IS rendered on the canvas.
    if (node.prefabParentId) return;
    // Phase 8.A.5 -- same treatment for Pool voice children.
    if (node.poolParentId) return;

    // Unknown node types: render a red placeholder so the user can see
    // and delete the orphan rather than the editor silently dropping it
    // (which previously also crashed on `def.color` access elsewhere).
    if (!def) {
      const el = document.createElement("div");
      el.className = "node unknown" + (isSel ? " selected" : "");
      el.style.left = node.x + "px";
      el.style.top  = node.y + "px";
      el.dataset.id = node.id;
      el.innerHTML =
        `<div class="node-strip" style="background:var(--danger)"></div>` +
        `<div class="node-head">` +
          `<span class="name" title="Unknown node type — likely a removed registry entry or a missing User DSP class">⚠ ${escapeText(node.type || "?")}</span>` +
          `<span class="node-id">${node.id}</span>` +
        `</div>` +
        `<div class="node-rows" style="padding:6px 12px 8px;font-size:10px;color:var(--text-3);font-style:italic;">unknown type</div>`;
      canvasWorld.appendChild(el);
      return;
    }

    const el = document.createElement("div");
    const cycleErr = state._cycleErrors && state._cycleErrors.has(node.id);
    const noOutWarn = outDisconnected && node === outNode;
    el.className = "node"
      + (isSel ? " selected" : "")
      + (cycleErr ? " cycle-error" : "")
      + (noOutWarn ? " no-output-warn" : "");
    el.style.left = node.x + "px";
    el.style.top  = node.y + "px";
    el.dataset.id = node.id;

    const strip = document.createElement("div");
    strip.className = "node-strip";
    strip.style.background = def.color;
    el.appendChild(strip);

    const head = document.createElement("div");
    head.className = "node-head";
    head.innerHTML = `<span class="name">${node.type}</span><span class="node-id">${node.id}</span>`;
    el.appendChild(head);

    const rows = document.createElement("div");
    rows.className = "node-rows";
    const rowCount = Math.max(def.ins.length, def.outs.length);
    for (let i = 0; i < rowCount; i++) {
      const inP  = def.ins[i];
      const outP = def.outs[i];
      const row = document.createElement("div");
      row.className = "row";

      const left = document.createElement("span");
      left.className = "label-l";
      left.textContent = inP ? inP.n : "";
      if (inP) row.appendChild(makePort(node.id, inP, "in"));
      row.appendChild(left);

      const right = document.createElement("span");
      right.className = "label-r";
      right.textContent = outP ? outP.n : "";
      if (outP) row.appendChild(makePort(node.id, outP, "out"));
      row.appendChild(right);

      rows.appendChild(row);
    }
    el.appendChild(rows);

    // Per-node code-editor handle. Only rendered for the currently-
    // selected node (and only when exactly one is selected) so we
    // don't clutter every node with a button. Sprint 5.node-edit.
    if (isSel && selectedSet.size === 1) {
      const handle = document.createElement("button");
      handle.className = "node-edit-handle";
      handle.title = "Edit this node's code + ports (E)";
      handle.textContent = "✎";
      handle.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      });
      handle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openNodeCodeEditor(node.id);
      });
      el.appendChild(handle);

      // §5.5.e -- TiledTerrain gets a second handle (⚙) that opens
      // the Tiling Config popup. Sits LEFT of the ✎ handle so both
      // are reachable. Only renders for TiledTerrain to avoid
      // cluttering other nodes.
      if (node.type === "TiledTerrain") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Tiling Config";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          openTilingConfigPopup(node.id);
        });
        el.appendChild(gear);
        // Shift the ✎ handle to the right so they don't overlap.
        handle.style.left = "calc(50% + 16px)";
      }
      // §planet-spec Phase 7.d -- PlanetMap gets a gear that opens the
      // equirect painter popup (raise/lower brush on the cell graph).
      if (node.type === "PlanetMap") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Planet Map Editor";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          openPlanetMapEditor(node.id);
        });
        el.appendChild(gear);
      }
      // SpriteCreator-1 -- gear opens the Sprite Studio modal preloaded
      // with this node's params (prompt / style / width / height /
      // framesX/Y / fps / scale). On save, modal writes back the new
      // asset name + the final values.
      if (node.type === "SpriteCreator") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Sprite Studio (generate sprite from this node's defaults)";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (typeof _ssOpen === "function") _ssOpen(node.id);
        });
        el.appendChild(gear);
        // Shift the ✎ handle right when both are present.
        handle.style.left = "calc(50% + 16px)";
      }
      // Sprint tilemap-painter -- gear handle opens the visual click-
      // paint editor for the wired Tilemap2D's tileData. Stops the
      // ASCII-counting madness.
      if (node.type === "Tilemap2D") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Tilemap Painter (click-paint cells with a brush)";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (typeof _tmeOpen === "function") _tmeOpen(node.id);
        });
        el.appendChild(gear);
        handle.style.left = "calc(50% + 16px)";
      }
      // Sprint Level2D Phase 1b -- gear handle opens the layer-list
      // modal so the user can add/remove/reorder layers + tweak
      // per-layer fields without hand-editing the layers JSON.
      if (node.type === "Level2D") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Level Editor (add / reorder / tweak layers)";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (typeof _lvlOpen === "function") _lvlOpen(node.id);
        });
        el.appendChild(gear);
        handle.style.left = "calc(50% + 16px)";
      }
    }

    canvasWorld.appendChild(el);
  });

  // Render each collapsed group as a single node-like block. The
  // block's position is recomputed every render from the member-
  // node bounds — so when the user drags the block, the underlying
  // member positions update and the next render reflects them
  // automatically. No bounds caching needed.
  (state.groups || []).forEach(g => {
    if (!g.collapsed) return;
    const b = groupBounds(g);
    if (!b) return;
    const x = b.x;
    const y = b.y;
    const ports = computeGroupPorts(g);
    const isSel = selectedGroupId === g.id;
    const el = document.createElement("div");
    el.className = "node group-node" + (isSel ? " selected" : "");
    el.style.left = x + "px";
    el.style.top  = y + "px";
    el.dataset.groupId = g.id;
    const inputCount = ports.inputs.length, outputCount = ports.outputs.length;
    const rowN = Math.max(inputCount, outputCount, 1);
    el.innerHTML =
      `<div class="node-strip" style="background: var(--accent)"></div>` +
      `<div class="node-head group-head-collapsed">` +
        `<span class="name" title="Click to select this group; double-click or use ⊞ to expand">${escapeText(g.name)}</span>` +
        `<button class="group-toggle-btn collapsed" data-group-toggle="${g.id}" title="Expand this group (E)" aria-label="expand">⊞</button>` +
        `<span class="node-id">${g.members.length}n</span>` +
      `</div>`;
    const rows = document.createElement("div");
    rows.className = "node-rows";
    for (let i = 0; i < rowN; i++) {
      const inP = ports.inputs[i];
      const outP = ports.outputs[i];
      const row = document.createElement("div");
      row.className = "row";
      const left = document.createElement("span");
      left.className = "label-l";
      left.textContent = inP ? inP.innerPort : "";
      if (inP) {
        const port = document.createElement("div");
        port.className = "port in " + inP.t;
        port.dataset.node = inP.innerNode;
        port.dataset.port = inP.innerPort;
        port.dataset.groupStub = "in";
        port.dataset.groupId = g.id;
        row.appendChild(port);
      }
      row.appendChild(left);
      const right = document.createElement("span");
      right.className = "label-r";
      right.textContent = outP ? outP.innerPort : "";
      if (outP) {
        const port = document.createElement("div");
        port.className = "port out " + outP.t;
        port.dataset.node = outP.innerNode;
        port.dataset.port = outP.innerPort;
        port.dataset.groupStub = "out";
        port.dataset.groupId = g.id;
        row.appendChild(port);
      }
      row.appendChild(right);
      rows.appendChild(row);
    }
    el.appendChild(rows);
    canvasWorld.appendChild(el);
  });
  renderWires();
  stats.textContent = state.nodes.length + " nodes · " + state.edges.length + " connections";
  filenameEl.textContent = state.filename;
  deleteBtn.disabled = selectedSet.size === 0;
  // Phase 8.A.3.2 -- enable Save Prefab only with a selection.
  const _btnPfs = document.getElementById("btn-save-prefab");
  if (_btnPfs) _btnPfs.disabled = selectedSet.size === 0;
  renderProps();
  renderCode();
  renderJson();
  applyView();
}

function makePort(nodeId, p, dir) {
  const port = document.createElement("div");
  const conn = isConnected(nodeId, p.n, dir === "out");
  port.className = "port " + dir + " " + p.t + (conn ? " connected" : "");
  port.dataset.node = nodeId;
  port.dataset.port = p.n;
  port.dataset.dir  = dir;
  port.dataset.type = p.t;
  return port;
}

/* Connection-legality matrix. Predicate is consulted at wire completion
 * (pointerup over an input port) — incompatible drops are rejected and
 * the destination port flashes red.
 *
 * Current rule set:
 *   - audio / param / gate / clock are all "signal" types — sample-rate
 *     or control-rate floats, structurally interchangeable. The codegen
 *     handles whatever lands where (Schmitt-trigger codegen for *->gate,
 *     raw 0/1 float for clock, etc.). Same-type and cross-signal pairs
 *     all allowed.
 *   - Visual port types (texture / transform / mesh — Phase 6.1.6)
 *     are NOT signal types. They live in VISUAL_PORT_TYPES and only
 *     accept SAME-TYPE connections (texture→texture, mesh→mesh, etc.)
 *     because there's no general way to coerce a 4×4 transform into a
 *     GPU texture or a per-sample float. Bridge nodes will be the
 *     conversion path:
 *       EnvFollow → Uniform   (audio   → texture-sample-able uniform)
 *       FFTBins   → Uniform[N]
 *       Clock     → Uniform   (clock   → uniform)
 *     Those bridge nodes ship in 6.5 (audio reactivity bridge).
 *
 * Today the predicate is permissive within signal types and strict
 * within visual types — it's the single place that says "yes" or
 * "no" for connection legality. */
const SIGNAL_PORT_TYPES = new Set(["audio", "param", "gate", "clock"]);
// Sprint 7.5.3a -- camera is a new visual-side port type alongside
// mesh + texture. Same strict-same-type rule applies. Cameras carry
// view + projection matrices to a Scene sink.
//
// Phase A.1 -- two LLM-side port types added:
//   "vector"   = { data: Float32Array, shape, dtype, gpu?, meta? }
//                Carries embeddings (Ollama /api/embed output, dim ~768),
//                model activations ([B,T,D]), gradient buffers, etc.
//                See docs/LLM-KNOWLEDGE-PHASE.md §9.
//   "llm-attn" = vector + { tokens: string[], dims: {B,H,T} }
//                Specialization for attention weights of shape [B,H,T,T]
//                with token labels for the AttentionGraph3D viz node.
// Both are strict same-type like every other visual port (no implicit
// coercion to audio / param / texture).
const VISUAL_PORT_TYPES = new Set([
  "texture", "transform", "mesh", "camera", "light", "environment",
  "vector", "llm-attn"
]);
function portsCompatible(srcType, dstType) {
  if (srcType === dstType) return true;
  if (SIGNAL_PORT_TYPES.has(srcType) && SIGNAL_PORT_TYPES.has(dstType)) return true;
  // Visual types are STRICTLY same-type; the early-return above
  // already handled that case. No cross-domain audio↔texture etc.
  return false;
}

/* Wire-drop snap targeting. Ports are 11 px circles; a finger covers
 * ~40-50 px, so the hit-test on e.target.closest(".port") routinely
 * misses on touch even when the user "feels" like they're over the
 * port. This finds the nearest type-compatible input port within a
 * screen-pixel radius — used both for live visual feedback during
 * the drag (.wire-snap-target glow) and as a fallback drop target
 * when pointerup's e.target lands just off-port.
 *
 * Radius defaults: mouse 16 px (gentle assist, no surprise snap),
 * pen 24 px, ANYTHING ELSE 36 px (touch, plus unknown — some
 * Chromebooks and hybrid devices don't reliably report
 * pointerType === "touch" for touchscreen contacts; the safe default
 * is to assume finger-like imprecision so those devices still get
 * usable snap behavior). Mouse is the only pointer type all browsers
 * report reliably as "mouse", so it's the right one to special-case.
 *
 * Hysteresis: once a snap is acquired, we keep it as long as the
 * finger stays within radius + 14 px of the SAME port (sticky exit).
 * Without this, the inevitable few-pixel finger drift in the last
 * pointermove before release routinely cleared a successful snap
 * just before pointerup, dropping the wire on empty canvas. */
const SNAP_HYST_PX = 14;
function _snapRadiusFor(pointerType) {
  if (pointerType === "mouse") return 16;
  if (pointerType === "pen")   return 24;
  return 36;
}
function findSnapPort(screenX, screenY, fromType, fromNode, radius) {
  const ports = document.querySelectorAll('.port[data-dir="in"]');
  let best = null, bestDist = radius;
  for (const p of ports) {
    if (p.dataset.node === fromNode) continue;
    if (!portsCompatible(fromType, p.dataset.type)) continue;
    const r = p.getBoundingClientRect();
    if (r.width === 0) continue;   // hidden / inside collapsed group
    const cx = r.left + r.width  / 2;
    const cy = r.top  + r.height / 2;
    const d = Math.hypot(cx - screenX, cy - screenY);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}
/* Decide the snap target for this pointermove. If a snap is currently
 * held, prefer keeping it as long as the finger is within the sticky
 * exit radius (radius + SNAP_HYST_PX) of THAT port — even if some
 * other port is now nearer. Only when the held snap is out of range
 * do we run a fresh search. Returns null when nothing qualifies. */
function _pickSnap(screenX, screenY, fromType, fromNode, radius) {
  if (wire && wire._snapPort) {
    const p  = wire._snapPort;
    const r  = p.getBoundingClientRect();
    if (r.width > 0 && portsCompatible(fromType, p.dataset.type) && p.dataset.node !== fromNode) {
      const cx = r.left + r.width  / 2;
      const cy = r.top  + r.height / 2;
      const d  = Math.hypot(cx - screenX, cy - screenY);
      if (d < radius + SNAP_HYST_PX) return p;
    }
  }
  return findSnapPort(screenX, screenY, fromType, fromNode, radius);
}
function _setWireSnap(snapPort) {
  if (!wire) return;
  if (wire._snapPort === snapPort) return;
  if (wire._snapPort) wire._snapPort.classList.remove("wire-snap-target");
  if (snapPort)       snapPort.classList.add("wire-snap-target");
  wire._snapPort = snapPort || null;
}
function _clearWireSnap() {
  if (wire && wire._snapPort) wire._snapPort.classList.remove("wire-snap-target");
  if (wire) wire._snapPort = null;
}

/* Briefly flash a port red to signal a rejected connection. The CSS
 * keyframe handles the visuals; we just toggle the class and clean it
 * up after the animation so a subsequent reject re-fires it. */
function flashRejectPort(portEl) {
  if (!portEl) return;
  portEl.classList.remove("reject-flash");
  // Force reflow so re-adding the class restarts the animation even if
  // the same port is rejected twice in a row.
  void portEl.offsetWidth;
  portEl.classList.add("reject-flash");
  const onEnd = () => {
    portEl.classList.remove("reject-flash");
    portEl.removeEventListener("animationend", onEnd);
  };
  portEl.addEventListener("animationend", onEnd);
}

function wirePath(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1) * 0.5 + 24;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/* Phase 6.6.20.11 — multi-target wire fan-out.
 *
 * If the user has multiple nodes selected and drops a wire onto one
 * of them, fan the connection out to every selected node that has
 * a matching input port. "Matching" = same port name + compatible
 * type. Lets the user wire 26 VisualOutputs in one drag (select all
 * 26, drop the wire on any one's input → all 26 connect).
 *
 * Returns an array of {node, port} targets. Always includes the
 * dropped port; adds extras only when the dropped port's node is
 * itself part of a multi-node selection AND the other selected
 * nodes have a same-named, type-compatible input.
 *
 * If the dropped port's node isn't in the selection, behaves
 * exactly as the legacy 1-target connect — selection is irrelevant. */
function _expandConnectionToSelection(targetNodeId, targetPortName, sourcePortType) {
  const fallback = [{ node: targetNodeId, port: targetPortName }];
  if (!selectedSet || selectedSet.size <= 1) return fallback;
  if (!selectedSet.has(targetNodeId)) return fallback;
  const out = [];
  for (const id of selectedSet) {
    const node = state.nodes.find(n => n.id === id);
    if (!node) continue;
    const def = TYPES[node.type];
    if (!def || !Array.isArray(def.ins)) continue;
    const port = def.ins.find(p => p.n === targetPortName && portsCompatible(sourcePortType, p.t));
    if (port) out.push({ node: id, port: port.n });
  }
  return out.length > 0 ? out : fallback;
}

/* Single entry point for committing a wire to one or more inputs.
 * Used by both pointerup and pointercancel handlers — there's no
 * difference between the two paths once the destination port has
 * been resolved. */
function _commitWireConnection(wire, port) {
  if (!wire || !port) return false;
  if (port.dataset.dir !== "in" || port.dataset.node === wire.fromNode) return false;
  if (!portsCompatible(wire.fromType, port.dataset.type)) {
    flashRejectPort(port);
    return false;
  }
  pushHistory("connect");
  const targets = _expandConnectionToSelection(port.dataset.node, port.dataset.port, wire.fromType);
  let added = 0;
  for (const t of targets) {
    if (t.node === wire.fromNode) continue;       // safety: don't loop back
    state.edges = state.edges.filter(ed => !(ed.to.node === t.node && ed.to.port === t.port));
    state.edges.push({
      from: { node: wire.fromNode, port: wire.fromPort },
      to:   { node: t.node, port: t.port }
    });
    added++;
  }
  if (added > 1) {
    console.log("[wire] fan-out:", added, "connections from", wire.fromNode + "." + wire.fromPort,
                "to", targets.map(t => t.node + "." + t.port).join(", "));
  }
  // Sprint 5.slider-aware -- if the source is a Slider sitting at
  // spawn defaults, snap its range/curve to a sensible preset for
  // the destination param. First target wins (deterministic) so
  // fan-out doesn't bounce between rules.
  _maybeAutoRangeSlider(wire.fromNode, targets);
  return true;
}

/* When a Slider's output gets connected, look up the destination
 * port name's heuristic and apply it IF the slider is still at
 * defaults. Skips silently otherwise -- never clobbers a user's
 * manual tuning. Run after edges are pushed so renderMonitorControls
 * picks up the new range on the next render. */
function _maybeAutoRangeSlider(srcNodeId, targets) {
  const src = state.nodes.find(n => n && n.id === srcNodeId);
  if (!src || src.type !== "Slider") return;
  if (!_sliderAtDefaults(src)) return;
  if (!Array.isArray(targets) || targets.length === 0) return;
  // Use the first target's port name (deterministic; fan-out is rare
  // and the rule's the same for all targets anyway).
  const h = paramHeuristicFor(targets[0].port);
  if (!h) return;
  if (!src.params) src.params = {};
  src.params.min   = h.min;
  src.params.max   = h.max;
  src.params.curve = h.curve;
  // Pin value into the new range -- mid-point of the curved 0..1
  // mapping so a freq slider lands on ~632 Hz, not 0 or 20000.
  const mid = sliderValueFromT(0.5, h.min, h.max, h.curve, null);
  src.params.value = mid;
  if (typeof renderMonitorControls === "function") renderMonitorControls();
}

function renderWires(temp) {
  let html = "";
  state.edges.forEach(e => {
    // Skip edges that are fully internal to a collapsed group —
    // both endpoints sit inside the same collapsed block, so the
    // wire would be a zero-length self-loop on the group's block.
    const fromG = groupOfNode(e.from.node);
    const toG   = groupOfNode(e.to.node);
    if (fromG && fromG.collapsed && toG && toG.collapsed && fromG.id === toG.id) return;
    // Phase 8.A.3 -- skip edges where EITHER endpoint sits inside
    // a PrefabInstance. Internal wires stay invisible (children
    // are hidden too). External wires that target an instance's
    // exposed port store the from/to against the INSTANCE node, not
    // the child, so they render normally.
    // Phase 8.A.5 -- same treatment for Pool voice children.
    const fromN = nodeById(e.from.node);
    const toN   = nodeById(e.to.node);
    if ((fromN && (fromN.prefabParentId || fromN.poolParentId)) ||
        (toN   && (toN.prefabParentId   || toN.poolParentId)))   return;
    const a = portPos(e.from.node, e.from.port, true);
    const b = portPos(e.to.node, e.to.port, false);
    if (!a || !b) return;
    const fromNode = nodeById(e.from.node);
    const def = defOf(fromNode);
    if (!def) return;
    const portDef = def.outs.find(p => p.n === e.from.port);
    const t = portDef ? portDef.t : "audio";
    const path = wirePath(a.x, a.y, b.x, b.y);
    if (t === "clock") {
      // Double-line look — render the same path twice, once thicker
      // in clock color and once thinner in the canvas bg, leaving two
      // parallel cyan stripes with a hairline gap. Distinct from the
      // dashed-param and solid-audio wires.
      html += `<path d="${path}" fill="none" stroke="var(--clock)" stroke-width="4" stroke-linecap="round" />`;
      html += `<path d="${path}" fill="none" stroke="var(--bg)"    stroke-width="1.5" stroke-linecap="round" />`;
    } else if (t === "mesh") {
      // Thick amber wire — visually heavy because mesh data is
      // structurally "more" than audio per sample.
      html += `<path d="${path}" fill="none" stroke="var(--mesh)" stroke-width="3" stroke-linecap="round" />`;
    } else if (t === "camera") {
      // Sprint 7.5.3a -- Camera wire. Double-stripe in butter-yellow,
      // matches the camera-port styling. Reads distinctly from the
      // amber mesh wires + violet transform wires.
      html += `<path d="${path}" fill="none" stroke="var(--camera)" stroke-width="4" stroke-linecap="round" />`;
      html += `<path d="${path}" fill="none" stroke="var(--bg)"     stroke-width="1.5" stroke-linecap="round" />`;
    } else if (t === "light") {
      // Sprint 7.5.3c -- Light wire. Same double-stripe shape as
      // camera but in cream, signaling "scene-global uniform data".
      html += `<path d="${path}" fill="none" stroke="var(--light)" stroke-width="4" stroke-linecap="round" />`;
      html += `<path d="${path}" fill="none" stroke="var(--bg)"    stroke-width="1.5" stroke-linecap="round" />`;
    } else if (t === "environment") {
      // Sprint 7.5.4 -- Environment wire. Dashed teal, signals "sky /
      // IBL context for the scene." Visually distinct from light's
      // double-stripe and texture's short-dotted pattern.
      html += `<path d="${path}" fill="none" stroke="var(--environment)" stroke-width="3" stroke-linecap="round" stroke-dasharray="6,5" />`;
    } else if (t === "hud") {
      // §5.5.g -- HUD wire. Long-dashed hot pink, signals "overlay
      // layer that draws on top of this Scene's output."
      html += `<path d="${path}" fill="none" stroke="var(--hud)" stroke-width="3" stroke-linecap="round" stroke-dasharray="8,4" />`;
    } else if (t === "heightmap") {
      // §5.5.h -- heightmap-ref wire (TiledTerrain -> Water). Earth-tone dashed.
      html += `<path d="${path}" fill="none" stroke="var(--heightmap)" stroke-width="3" stroke-linecap="round" stroke-dasharray="6,4" />`;
    } else if (t === "transform") {
      // Double-stripe like clock but in transform-violet to keep the
      // 4×4 mat semantics visually distinct from rhythmic data.
      html += `<path d="${path}" fill="none" stroke="var(--transform)" stroke-width="4" stroke-linecap="round" />`;
      html += `<path d="${path}" fill="none" stroke="var(--bg)"        stroke-width="1.5" stroke-linecap="round" />`;
    } else if (t === "texture") {
      // Dotted cyan — short dashes in the texture color. Reads
      // distinctly from param's longer-dash pattern.
      html += `<path d="${path}" fill="none" stroke="var(--texture)" stroke-width="2" stroke-linecap="round" stroke-dasharray="2,4" />`;
    } else {
      // audio / gate / param fall here. param gets dashes; others solid.
      const color = t === "audio" ? "var(--audio)" : (t === "gate" ? "var(--gate)" : "var(--param)");
      const da = t === "param" ? ' stroke-dasharray="4,4"' : "";
      html += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"${da} />`;
    }
  });
  if (temp) {
    html += `<path d="${wirePath(temp.x1, temp.y1, temp.x2, temp.y2)}" fill="none" stroke="#888" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3,4" opacity="0.7" />`;
  }
  wireSvg.innerHTML = html;
}

