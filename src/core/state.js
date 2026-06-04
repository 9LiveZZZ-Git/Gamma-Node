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
