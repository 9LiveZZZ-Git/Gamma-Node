/* =========================================================================
 * State
 * ======================================================================== */
let state = freshState();
let selected = null;
let drag = null;
let wire = null;
let nextId = 1;
let collapsedCats = {};

// Multi-select. `selected` is the primary id (drives the props pane);
// `selectedSet` is the visual + group-operation set. Single-click puts
// only the clicked id in both. Shift-click adds.
let selectedSet = new Set();
// `selectedGroupId` flags that the GROUP entity is the current
// selection (clicked the group header, not an inner node). When set,
// the props pane shows group-specific UI (rename / collapse / save-
// as-gpatch) rather than node UI. Mutually exclusive with selectedSet
// in the sense that a header click clears selectedSet.
let selectedGroupId = null;

// Pan + zoom view transform. Transient, not persisted to .gpatch.
const view = { panX: 0, panY: 0, zoom: 1 };

// Pan + marquee transient state, set on mousedown, cleared on mouseup.
let panning = null;     // { startX, startY, startPanX, startPanY }
let marquee = null;     // { startWX, startWY, x, y, w, h }
let groupDrag = null;   // { dx, dy, originals: Map<id, {x,y}> }
let spaceHeld = false;

// Undo/redo: each entry is a JSON snapshot of nodes/edges/exposed.
// Coalescing: consecutive moves on the same node within 250ms collapse
// into one undo step; consecutive param edits on the same key within
// 500ms do too.
let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 200;
let lastPushReason = null;
let lastPushTime = 0;

function snapshotState() {
  // Strip transient underscored fields before snapshotting. Groups
  // included so undo/redo restores group structure too.
  return JSON.stringify({
    version:   state.version,
    patchName: state.patchName,
    filename:  state.filename,
    nodes:     state.nodes,
    edges:     state.edges,
    exposed:   state.exposed,
    groups:    state.groups || []
  }, (key, val) => (key.length > 0 && key[0] === "_") ? undefined : val);
}
function restoreSnapshot(snap) {
  const o = JSON.parse(snap);
  state.version   = o.version;
  state.patchName = o.patchName;
  state.filename  = o.filename;
  state.nodes     = o.nodes;
  state.edges     = o.edges;
  state.exposed   = o.exposed;
  state.groups    = Array.isArray(o.groups) ? o.groups : [];
  // Selection refers to ids that may no longer exist after undo/redo.
  selectedSet = new Set([...selectedSet].filter(id => state.nodes.some(n => n.id === id)));
  selected = selectedSet.size ? [...selectedSet][selectedSet.size - 1] : null;
  if (selectedGroupId && !groupById(selectedGroupId)) selectedGroupId = null;
}
function pushHistory(reason) {
  const now = Date.now();
  const coalesceWindow = (reason && reason.startsWith("move:")) ? 250
                        : (reason && reason.startsWith("param:")) ? 500
                        : 0;
  if (coalesceWindow > 0 && reason === lastPushReason && (now - lastPushTime) < coalesceWindow) {
    lastPushTime = now;
    return;
  }
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  lastPushReason = reason;
  lastPushTime = now;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotState());
  restoreSnapshot(undoStack.pop());
  lastPushReason = null;
  render();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotState());
  restoreSnapshot(redoStack.pop());
  lastPushReason = null;
  render();
}

function selectOne(id) {
  selectedSet.clear();
  if (id) selectedSet.add(id);
  selected = id;
}
function addToSelection(id) {
  if (selectedSet.has(id)) {
    selectedSet.delete(id);
    selected = selectedSet.size ? [...selectedSet][selectedSet.size - 1] : null;
  } else {
    selectedSet.add(id);
    selected = id;
  }
}
function selectAll() {
  selectedSet = new Set(state.nodes.map(n => n.id));
  selected = state.nodes.length ? state.nodes[state.nodes.length - 1].id : null;
  render();
}
function clearSelection() {
  selectedSet.clear();
  selected = null;
  selectedGroupId = null;
}

/* ─── Group operations ─────────────────────────────────────────── */
/* Wrap the current selection into a new group. Requires ≥1 node;
 * any node already in another group is kept in its existing group
 * (a node can belong to at most one group). */
function groupSelection() {
  const ids = [...selectedSet].filter(id => !groupOfNode(id));
  if (!ids.length) return;
  pushHistory("group");
  if (!Array.isArray(state.groups)) state.groups = [];
  const groupId = "g" + (nextId++);
  const name = "Group " + (state.groups.length + 1);
  state.groups.push({ id: groupId, name, collapsed: false, members: ids });
  selectedSet.clear();
  selected = null;
  selectedGroupId = groupId;
  render();
  renderProps && renderProps();
}
/* Remove the currently-selected group (the group entity, not its
 * members). The members revert to free top-level nodes. Keyboard
 * convention: Ctrl/Cmd+Shift+G. */
function ungroupSelection() {
  if (!selectedGroupId) return;
  pushHistory("ungroup");
  const g = groupById(selectedGroupId);
  state.groups = state.groups.filter(x => x.id !== selectedGroupId);
  // Re-select the (now ungrouped) member nodes for continuity.
  if (g && g.members) {
    selectedSet = new Set(g.members);
    selected = g.members[g.members.length - 1];
  }
  selectedGroupId = null;
  render();
  renderProps && renderProps();
}
/* Delete a group AND every node it contains, plus any edges touching
 * those nodes and any exposed-setter entries pointing into them. The
 * group entity itself goes too. Distinct from `ungroupSelection`,
 * which keeps the members and only removes the group wrapper. */
function deleteGroup(groupId) {
  const g = groupById(groupId);
  if (!g) return;
  pushHistory("delete-group:" + groupId);
  const memberSet = new Set(g.members || []);
  state.nodes = state.nodes.filter(n => !memberSet.has(n.id));
  state.edges = state.edges.filter(ed =>
    !memberSet.has(ed.from.node) && !memberSet.has(ed.to.node)
  );
  Object.keys(state.exposed).forEach(k => {
    const dot = k.indexOf(".");
    const idPart = dot >= 0 ? k.slice(0, dot) : k;
    if (memberSet.has(idPart)) delete state.exposed[k];
  });
  state.groups = state.groups.filter(x => x.id !== groupId);
  selectedGroupId = null;
  selectedSet.clear();
  selected = null;
  render();
  renderProps && renderProps();
}

/* Clone a group: duplicates every member node, every edge whose BOTH
 * endpoints are inside the group (internal wiring), every exposed-
 * setter that points at a member, and creates a fresh group entity
 * pointing at the new IDs. External wires aren't carried — same
 * convention as `serializeSelection` for plain copy/paste. The new
 * group is offset by (24, 24) so it lands visibly next to the
 * original; the new group entity inherits the source's collapsed
 * state and gets " copy" appended to its name. */
function duplicateGroup(groupId) {
  const g = groupById(groupId);
  if (!g || !Array.isArray(g.members)) return;
  pushHistory("duplicate-group:" + groupId);
  const dx = 24, dy = 24;
  const idMap = {};
  g.members.forEach(mid => {
    const orig = nodeById(mid);
    if (!orig) return;
    const newId = uid();
    idMap[mid] = newId;
    state.nodes.push({
      id: newId,
      type: orig.type,
      x: orig.x + dx,
      y: orig.y + dy,
      params: { ...orig.params }
    });
  });
  const memberSet = new Set(g.members);
  state.edges.slice().forEach(ed => {
    if (memberSet.has(ed.from.node) && memberSet.has(ed.to.node)) {
      const fn = idMap[ed.from.node];
      const tn = idMap[ed.to.node];
      if (fn && tn) {
        state.edges.push({
          from: { node: fn, port: ed.from.port },
          to:   { node: tn, port: ed.to.port }
        });
      }
    }
  });
  Object.keys(state.exposed).forEach(k => {
    const dot = k.indexOf(".");
    const oldId = dot >= 0 ? k.slice(0, dot) : k;
    const rest  = dot >= 0 ? k.slice(dot)    : "";
    if (idMap[oldId]) {
      state.exposed[idMap[oldId] + rest] = state.exposed[k];
    }
  });
  if (!Array.isArray(state.groups)) state.groups = [];
  const newGroupId = "g" + (nextId++);
  state.groups.push({
    id: newGroupId,
    name: (g.name || "Group") + " copy",
    collapsed: !!g.collapsed,
    members: Object.values(idMap)
  });
  selectedSet.clear();
  selected = null;
  selectedGroupId = newGroupId;
  render();
  renderProps && renderProps();
}

/* Toggle expand/collapse on a group. Pure UI flag; the underlying
 * node + edge graph is unchanged. Wires re-route on next renderWires
 * (collapsed-group endpoints redirect to the group's port stubs). */
function toggleGroupCollapse(groupId) {
  const g = groupById(groupId);
  if (!g) return;
  pushHistory("group-collapse:" + groupId);
  g.collapsed = !g.collapsed;
  render();
  renderWires && renderWires();
}
/* Update the human-readable name on a group. */
function renameGroup(groupId, newName) {
  const g = groupById(groupId);
  if (!g) return;
  pushHistory("group-rename:" + groupId);
  g.name = String(newName || "").trim() || g.name;
  render();
  renderProps && renderProps();
}

function applyView() {
  const cw = document.getElementById("canvas-world");
  if (cw) cw.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  const hud = document.getElementById("view-hud");
  if (hud) hud.textContent = Math.round(view.zoom * 100) + "%";
}
function resetView() {
  view.panX = 0; view.panY = 0; view.zoom = 1;
  applyView();
}
function screenToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - view.panX) / view.zoom,
    y: (clientY - rect.top - view.panY) / view.zoom
  };
}

function uid() { return "n" + (nextId++); }
function nodeById(id) { return state.nodes.find(n => n.id === id); }
/* Returns the effective definition for a node -- the base TYPES
 * entry merged with any per-node override (node.override). Used by
 * codegen + rendering everywhere, so editing node.override is the
 * single hook for the per-node code editor (E key / bottom-edge ✎
 * button) to change C++ source, port lists, and setter wiring.
 *
 * Override shape (all fields optional):
 *   { cppType, helperClass, header, ins, outs, methods, gateMethods,
 *     template, noSigArg }
 *
 * Field merge uses an "in ov" check rather than null-coalescing so
 * an override can explicitly set a field to null (or false, or "")
 * to DROP an inherited base value. Concrete use: when a template-
 * only node (Mul, Add, ...) is converted to a real helperClass,
 * we set override.template = null so codegen takes the cppType
 * path instead of inlining the template. */
function defOf(node) {
  const base = TYPES[node.type];
  if (!node || !node.override || !base) return base;
  const ov = node.override;
  const merged = { ...base };
  if ("cppType"     in ov) merged.cppType     = ov.cppType;
  if ("helperClass" in ov) merged.helperClass = ov.helperClass;
  if ("header"      in ov) merged.header      = ov.header;
  if ("ins"         in ov) merged.ins         = ov.ins;
  if ("outs"        in ov) merged.outs        = ov.outs;
  if ("methods"     in ov) merged.methods     = ov.methods;
  if ("gateMethods" in ov) merged.gateMethods = ov.gateMethods;
  if ("template"    in ov) merged.template    = ov.template;
  if ("noSigArg"    in ov) merged.noSigArg    = ov.noSigArg;
  if ("extraCtor"   in ov) merged.extraCtor   = ov.extraCtor;
  return merged;
}

function freshState() {
  return {
    version: 2,
    patchName: "MyPatch",
    nodes: [], edges: [], exposed: {},
    /* Groups: visual organization layer over the flat node graph.
     * Each entry is { id, name, collapsed, members: [nodeIds] }.
     * Members are by ID; a node belongs to at most one group. The
     * codegen path is unaware of groups — they're purely a UI
     * abstraction. When collapsed, member nodes hide and the group
     * renders as a single block with port stubs derived from
     * cross-boundary edges. */
    groups: [],
    /* Phase 6.5 — distributed display rig. The rig is a list of N
     * virtual displays + a global preview-projection mode + a master
     * resolution shared by all displays in 6.5 (per-display res
     * comes in 6.6). Each VisualOutput.display param indexes into
     * rig.displays.
     *
     * worldUv on each display defines that display's slice of the
     * rig's master canvas. When one shader feeds N displays, each
     * display's render pass receives world-UV uniforms that map its
     * local screen [0,1] into the slice — so a Pinwheel wired into
     * two side-by-side displays renders ONCE conceptually, with the
     * two passes drawing left and right halves of a single shared
     * image. Existing single-display patches default to a 1-display
     * rig with worldUv = [0,0]→[1,1], so old shaders see no change. */
    rig: defaultRig(),
    filename: "untitled.gpatch"
  };
}

/* ---------- Phase 6.5 — rig data layer + templates ---------- */

/* The default rig: one flat display covering the full master canvas.
 * Existing patches that don't carry a rig get this on load — combined
 * with VisualOutput's display param defaulting to 0, the editor's
 * pre-Phase-6.5 single-display behavior is preserved exactly. */
function defaultRig() {
  const surface = { type: "plane", normal: [0, 0, 1], offset: 5 };
  return {
    templateKey: "single",
    masterRes:   [1920, 1080],
    previewMode: "tile",          // tile | cylinder | equirect | fisheye
    // Phase 6.5.15+ — global "where the shader's center lands" offset
    // in degrees of world yaw/pitch. Default 0 means no shift; positive
    // yaw rotates content right (pinwheel center appears further right
    // in the rig's view). Conversion to per-VO world_uv shift is
    // computed in _renderWorldUvForVO and depends on whether the
    // shader is solo (denominated by display fov) or shared
    // (denominated by consumer set's azim range).
    shaderCenterYaw:   0,
    shaderCenterPitch: 0,
    // Phase 6.6.14 — physical screen geometry. Closes the gap with
    // Raskar et al.'s quadric-transfer math: knowing the screen as a
    // parametric surface (sphere/cylinder/plane/free) unlocks
    // analytic auto-warp (#3, next ticket) + screen-overlap-based
    // edge-blend (#4) without needing camera-feedback calibration.
    // Each template provides its own surface; the default rig is a
    // single flat display, which corresponds to a plane at z=offset.
    surface:    surface,
    // Phase 6.6.14 — sweet-spot, the audience-position the rig is
    // calibrated for. Theater-mode camera spawns there on rig
    // template apply / patch load. Per Raskar §4.1, sphere → center,
    // cylinder → midpoint of axis, plane → offset away from screen.
    // Helper _deriveSweetSpot builds defaults; user can override.
    sweetSpot:  _deriveSweetSpot(surface),
    // Phase 6.6.15 — when true, the screen surface is treated as a
    // physical curved screen for auto-warp + gizmo visualization.
    // When false, the rig is treated as flat monitors arranged at
    // the display poses (common for VJ wraparound LED-wall installs).
    // Default ON because most projection rigs do have a real screen;
    // toggle off if you're driving an array of monitors.
    surfaceVisible: true,
    displays:    [_makeDisplay("d0", "Display 1", {
      pose: { yaw: 0, pitch: 0, roll: 0 },
      fov:  { h: 90, v: 60 },
      worldUv: { minU: 0, minV: 0, maxU: 1, maxV: 1 }
    })]
  };
}

/* Derive a default sweet-spot from a screen-surface descriptor.
 * Follows Raskar §4.1 conventions:
 *   sphere   → sphere center (origin or surface.center)
 *   cylinder → midpoint of axis
 *   plane    → on the audience side at distance = surface.offset
 *              (negative along the normal so audience sits where the
 *              screen normal points TOWARD them)
 *   free     → origin (no analytic answer; user sets manually)
 *
 * Always returns a fresh array so callers can mutate without aliasing. */
function _deriveSweetSpot(surface) {
  if (!surface || !surface.type) return [0, 0, 0];
  if (surface.type === "sphere") {
    const c = surface.center || [0, 0, 0];
    return [c[0], c[1], c[2]];
  }
  if (surface.type === "cylinder") {
    const c = surface.center || [0, 0, 0];
    return [c[0], c[1], c[2]];
  }
  if (surface.type === "plane") {
    const n = surface.normal || [0, 0, 1];
    const d = surface.offset || 5;
    // Sweet-spot on the OPPOSITE side of the plane from where the
    // surface "extends" — for a screen at z=+d facing the viewer,
    // audience sits at z=0 looking toward +z. So sweet-spot is at
    // origin (the plane's normal points back toward the audience).
    return [0, 0, 0];
  }
  if (surface.type === "swept") {
    // 6.6.20 — for a surface of revolution about +Y, the natural
    // sweet-spot is on the axis at the height of the bounds centroid.
    // (For a partial-yaw sweep, the *visual* sweet-spot might be
    // offset toward the open side; user can refine manually.)
    const b = _sweptSurfaceBounds(surface);
    const cy = 0.5 * (b.minY + b.maxY);
    return [0, cy, 0];
  }
  return [0, 0, 0];
}

/* Validate a screen-surface object loaded from .gpatch / templates.
 * Returns a sanitized copy (with defaults filled in for missing
 * fields). Garbage input falls back to "free" surface so the rig
 * stays renderable even with corrupted data. */
function _migrateRigSurface(s) {
  if (!s || typeof s !== "object" || !s.type) {
    return { type: "free" };
  }
  if (s.type === "sphere") {
    return {
      type: "sphere",
      radius: Number.isFinite(s.radius) ? s.radius : 5,
      center: Array.isArray(s.center) && s.center.length === 3 ? s.center.slice() : [0, 0, 0]
    };
  }
  if (s.type === "cylinder") {
    return {
      type: "cylinder",
      radius: Number.isFinite(s.radius) ? s.radius : 5,
      axis:   Array.isArray(s.axis)   && s.axis.length   === 3 ? s.axis.slice()   : [0, 1, 0],
      length: Number.isFinite(s.length) ? s.length : 5,
      center: Array.isArray(s.center) && s.center.length === 3 ? s.center.slice() : [0, 0, 0]
    };
  }
  if (s.type === "plane") {
    return {
      type: "plane",
      normal: Array.isArray(s.normal) && s.normal.length === 3 ? s.normal.slice() : [0, 0, 1],
      offset: Number.isFinite(s.offset) ? s.offset : 5
    };
  }
  if (s.type === "swept") {
    // Phase 6.6.20 — swept surface (Sajadi & Majumder TVCG 2012).
    // V1: surfaces of revolution only. Profile is either an arc
    // (sphere segment, optionally truncated at the poles) or a
    // vertical line (cylinder segment). Path is a yaw range about
    // the +Y axis. Together these describe AlloSphere, dome, bowl,
    // truncated-dome, partial cylinder, etc. as a single surface.
    const p = s.profile || {};
    const q = s.path || {};
    const profile = (p.kind === "vertical")
      ? {
          kind:   "vertical",
          radius: Number.isFinite(p.radius) ? p.radius : 5,
          yMin:   Number.isFinite(p.yMin)   ? p.yMin   : -2.5,
          yMax:   Number.isFinite(p.yMax)   ? p.yMax   : 2.5
        }
      : {
          kind:       "arc",
          radius:     Number.isFinite(p.radius)     ? p.radius     : 5,
          pitchStart: Number.isFinite(p.pitchStart) ? p.pitchStart : -90,
          pitchEnd:   Number.isFinite(p.pitchEnd)   ? p.pitchEnd   :  90
        };
    const path = {
      kind:     "revolution",
      yawStart: Number.isFinite(q.yawStart) ? q.yawStart : -180,
      yawEnd:   Number.isFinite(q.yawEnd)   ? q.yawEnd   :  180
    };
    return { type: "swept", profile, path };
  }
  return { type: "free" };
}

/* ------------ Phase 6.6.20 — swept-surface math --------------------- *
 *
 * Sajadi & Majumder (TVCG 2012, doc 6060818) generalize tiled-projector
 * screen geometries to "swept surfaces": any shape generated by moving
 * a profile curve along a path curve. This covers the space between
 * flat planes / cylinders (vertically extruded only) and full spheres,
 * including truncated domes, bowls, AlloSphere-class curved walls,
 * half-cylinders, and most CAVE walls without sharp corners.
 *
 * V1 supports surfaces of revolution only — path is a yaw range
 * around the +Y axis, profile is either a circular arc or a vertical
 * line. This already covers AlloSphere (partial sphere, partial yaw)
 * and partial cylinders. Arbitrary path curves and Bezier-controlled
 * profiles are queued for V2.
 *
 * Profile is in the (r, y) half-plane where r = √(x² + z²) ≥ 0. The
 * profile is sampled into a polyline once on each access (cached for
 * the lifetime of the surface object) — that polyline is the source
 * of truth for ray intersection and gizmo rendering.
 */

/* Sample a swept profile into a flat polyline of [r0, y0, r1, y1, ...]
 * pairs. Returns Float32Array of length 2*(samples+1). Caller decides
 * the sample density; default ~33 = enough for visual smoothness on
 * a 1080p gizmo and good enough for ray intersection precision. */
function _sweptProfilePolyline(profile, samples) {
  samples = Math.max(2, samples | 0);
  const out = new Float32Array((samples + 1) * 2);
  if (profile.kind === "vertical") {
    const r = profile.radius || 5;
    const y0 = profile.yMin || -2.5, y1 = profile.yMax || 2.5;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      out[i * 2 + 0] = r;
      out[i * 2 + 1] = y0 + (y1 - y0) * t;
    }
    return out;
  }
  // Arc profile: a circular arc on a sphere of given radius. Pitch
  // ∈ [-90, +90] degrees. r = R cos(pitch), y = R sin(pitch).
  const R = profile.radius || 5;
  const p0 = (profile.pitchStart || 0) * Math.PI / 180;
  const p1 = (profile.pitchEnd   || 0) * Math.PI / 180;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const a = p0 + (p1 - p0) * t;
    out[i * 2 + 0] = R * Math.cos(a);
    out[i * 2 + 1] = R * Math.sin(a);
  }
  return out;
}

/* Generate a 3D triangle-mesh point grid for a swept surface. Returns
 * { positions, profileSamples, pathSamples } where positions is a
 * Float32Array of (profileSamples+1)*(pathSamples+1)*3 floats laid
 * out [x0, y0, z0, x1, ...] in row-major order (path first, then
 * profile). Used by the gizmo wireframe and (eventually) the auto-
 * warp ray-mesh intersection. */
function _sweptSurfacePointGrid(surface, profileSamples, pathSamples) {
  profileSamples = Math.max(2, profileSamples | 0);
  pathSamples    = Math.max(2, pathSamples    | 0);
  const profPoly = _sweptProfilePolyline(surface.profile || {}, profileSamples);
  const path = surface.path || { yawStart: -180, yawEnd: 180 };
  const yaw0 = (path.yawStart || -180) * Math.PI / 180;
  const yaw1 = (path.yawEnd   ||  180) * Math.PI / 180;
  const W = pathSamples + 1, H = profileSamples + 1;
  const out = new Float32Array(W * H * 3);
  for (let r = 0; r < H; r++) {
    const pr = profPoly[r * 2 + 0];
    const py = profPoly[r * 2 + 1];
    for (let c = 0; c < W; c++) {
      const t = c / pathSamples;
      const yaw = yaw0 + (yaw1 - yaw0) * t;
      const idx = (r * W + c) * 3;
      out[idx + 0] = pr * Math.sin(yaw);
      out[idx + 1] = py;
      out[idx + 2] = pr * Math.cos(yaw);
    }
  }
  return { positions: out, profileSamples, pathSamples };
}

/* Ray-vs-swept-surface intersection. Exploits the surface-of-
 * revolution structure: we don't ray-trace the whole 3D mesh, we
 * project the ray to (r, y) coordinates in the yaw=θ slice and
 * intersect against the profile polyline (a 2D segment list).
 *
 * Returns positive t along (O, D) if the ray hits, -1 otherwise.
 * Origin is assumed near (0, 0, 0); for non-origin sweet-spots the
 * caller pre-translates.
 *
 * Algorithm:
 *   1. Compute yaw = atan2(Dx, Dz). Reject if outside [yawStart, yawEnd].
 *   2. Within the yaw slice, the 3D ray flattens to a 2D ray in the
 *      (r, y) half-plane: r-direction = √(Dx² + Dz²), y-direction = Dy.
 *      Origin r-component = √(Ox² + Oz²) projected onto the slice
 *      direction. (For O at origin this is 0.)
 *   3. Walk the profile polyline; for each segment, compute 2D ray-
 *      vs-segment intersection. Take the smallest positive t.
 *   4. Return t (which is the 3D distance along (O, D), since the
 *      yaw rotation preserves length).
 *
 * NOTE: The profile is in the upper half-plane (r ≥ 0). Rays going
 * "backward through the axis" (yaw flipped 180°) are not currently
 * tested — they would require checking the mirror profile too. For
 * partial-yaw screens this is correct; for full sweeps the user's
 * pose should never be aimed through the axis, so OK in practice. */
function _raySweptSurfaceDistance(O, D, surface) {
  const ox = O[0], oy = O[1], oz = O[2];
  const dx = D[0], dy = D[1], dz = D[2];
  if (Math.hypot(dx, dy, dz) < 1e-9) return -1;

  const path = surface.path || { yawStart: -180, yawEnd: 180 };
  const yawStart = path.yawStart || -180;
  const yawEnd   = path.yawEnd   ||  180;
  const profile = surface.profile || {};

  // Yaw range check — the hit point's yaw determines whether the ray
  // strikes the swept portion of the surface or misses through the
  // open side. For O at origin, hit-yaw == direction-yaw (the ray
  // stays in one yaw slice). For off-origin O, this is approximate
  // but typically good enough — the sweet-spot offset is small
  // compared to the surface radius.
  const dirYawDeg = Math.atan2(dx, dz) * 180 / Math.PI;
  let inRange = false;
  for (let k = -1; k <= 1; k++) {
    const yaw = dirYawDeg + k * 360;
    if (yaw >= yawStart - 0.001 && yaw <= yawEnd + 0.001) { inRange = true; break; }
  }
  if (!inRange) return -1;

  // 6.6.20 — for "arc" profiles we use analytical ray-sphere
  // intersection (exact, robust at poles where polyline sampling
  // degenerates). The arc just constrains which portion of the
  // sphere counts as a hit.
  if (profile.kind === "arc") {
    const R = profile.radius || 5;
    const t = _raySphereDistance(O, D, [0, 0, 0], R);
    if (t <= 0) return -1;
    // Pitch of the hit point on the sphere.
    const Px = ox + dx * t, Py = oy + dy * t, Pz = oz + dz * t;
    const Pr = Math.hypot(Px, Pz);
    const hitPitch = Math.atan2(Py, Pr) * 180 / Math.PI;
    const pStart = profile.pitchStart || 0;
    const pEnd   = profile.pitchEnd   || 0;
    const pLo = Math.min(pStart, pEnd) - 0.001;
    const pHi = Math.max(pStart, pEnd) + 0.001;
    if (hitPitch < pLo || hitPitch > pHi) return -1;
    return t;
  }

  // "vertical" profile — ray-vs-cylinder analytic, then check Y range.
  if (profile.kind === "vertical") {
    const R = profile.radius || 5;
    const yMin = profile.yMin || -2.5;
    const yMax = profile.yMax || 2.5;
    // 2D ray-circle in XZ plane.
    const a = dx*dx + dz*dz;
    if (a < 1e-12) return -1;
    const b = 2 * (ox*dx + oz*dz);
    const c = ox*ox + oz*oz - R*R;
    const disc = b*b - 4*a*c;
    if (disc < 0) return -1;
    const sd = Math.sqrt(disc);
    const t1 = (-b - sd) / (2*a);
    const t2 = (-b + sd) / (2*a);
    for (const t of [t1, t2]) {
      if (t > 0.001) {
        const py = oy + dy * t;
        if (py >= yMin - 0.001 && py <= yMax + 0.001) return t;
      }
    }
    return -1;
  }

  // Generic fallback (V2 — Bezier-controlled custom profiles): walk
  // the profile polyline in the yaw slice. Slower + degenerate at
  // poles, but works for arbitrary curves.
  const yawRad = dirYawDeg * Math.PI / 180;
  const sx = Math.sin(yawRad), sz = Math.cos(yawRad);
  const oR = ox * sx + oz * sz;
  const oY = oy;
  const dR = dx * sx + dz * sz;
  const dY = dy;
  if (Math.abs(dR) < 1e-9 && Math.abs(dY) < 1e-9) return -1;
  const polyN = 64;
  const profPoly = _sweptProfilePolyline(profile, polyN);
  let bestT = Infinity;
  for (let i = 0; i < polyN; i++) {
    const r0 = profPoly[i * 2 + 0];
    const y0 = profPoly[i * 2 + 1];
    const r1 = profPoly[(i + 1) * 2 + 0];
    const y1 = profPoly[(i + 1) * 2 + 1];
    const er = r1 - r0;
    const ey = y1 - y0;
    const det = (-er) * dY - (-ey) * dR;
    if (Math.abs(det) < 1e-12) continue;
    const t =  ((-er) * (y0 - oY) - (-ey) * (r0 - oR)) / det;
    const s =  (dR    * (y0 - oY) - dY    * (r0 - oR)) / det;
    if (t > 0.001 && s >= -0.001 && s <= 1.001) {
      if (t < bestT) bestT = t;
    }
  }
  return Number.isFinite(bestT) ? bestT : -1;
}

/* Compute the bounds of a swept surface (axis-aligned 3D box). Used
 * by sweet-spot derivation (centroid) and by the gizmo render to
 * scale the wireframe consistently. */
function _sweptSurfaceBounds(surface) {
  const grid = _sweptSurfacePointGrid(surface, 16, 32);
  const p = grid.positions;
  let minX = +Infinity, minY = +Infinity, minZ = +Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 0] < minX) minX = p[i + 0];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2];
    if (p[i + 0] > maxX) maxX = p[i + 0];
    if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/* 6.6.20+ — unified ray-vs-screen-surface intersection. Used by
 * theater + gizmo to wrap display vertices onto the actual screen
 * surface ("real curved projection") instead of drawing flat quads.
 * Returns the 3D world point where the ray (from origin through D)
 * hits the surface, or null if the ray misses with no fallback set.
 *
 * fallbackR: if > 0 and the ray misses, return D normalized to that
 * radius (visually "the beam continues to where the unit sphere
 * would be"). Use this for visualization to avoid holes; pass 0
 * when you want strict miss reporting. */
function _screenProjectionPoint(D, surface, fallbackR) {
  if (!surface) return null;
  let t = -1;
  if (surface.type === "sphere") {
    t = _raySphereDistance([0,0,0], D, surface.center || [0,0,0], surface.radius || 5);
  } else if (surface.type === "cylinder") {
    t = _rayCylinderDistanceY([0,0,0], D, surface.center || [0,0,0],
                               surface.radius || 5, surface.length || 5);
  } else if (surface.type === "swept") {
    t = _raySweptSurfaceDistance([0,0,0], D, surface);
  } else {
    return null;
  }
  if (t > 0) return [D[0] * t, D[1] * t, D[2] * t];
  if (fallbackR && fallbackR > 0) {
    const len = Math.hypot(D[0], D[1], D[2]);
    if (len < 1e-9) return null;
    const k = fallbackR / len;
    return [D[0] * k, D[1] * k, D[2] * k];
  }
  return null;
}

/* Build a "normalized" copy of the screen surface where the
 * characteristic dimension (radius) = 1. Used by the gizmo so the
 * surface fits the frustum-corner unit sphere regardless of real
 * radius (which can be 5m for an AlloSphere or 30m for a planetarium).
 * Returns null for non-curved surfaces (plane / free / null). */
function _normalizeSurfaceForGizmo(surface) {
  if (!surface) return null;
  if (surface.type === "sphere") {
    return { type: "sphere", radius: 1, center: [0, 0, 0] };
  }
  if (surface.type === "cylinder") {
    const R = surface.radius || 5;
    return {
      type: "cylinder",
      radius: 1,
      length: (surface.length || 5) / R,
      center: [0, 0, 0],
      axis: [0, 1, 0]
    };
  }
  if (surface.type === "swept") {
    const p = surface.profile || {};
    const R = p.radius || 5;
    const profile = (p.kind === "vertical")
      ? { kind: "vertical", radius: 1, yMin: (p.yMin || -2.5) / R, yMax: (p.yMax || 2.5) / R }
      : { kind: "arc",      radius: 1, pitchStart: p.pitchStart || -90, pitchEnd: p.pitchEnd || 90 };
    return { type: "swept", profile, path: { ...(surface.path || { yawStart: -180, yawEnd: 180 }) } };
  }
  return null;
}

/* Built-in swept-surface presets. Mirrors the named shapes Sajadi &
 * Majumder use in their evaluations: truncated dome (AlloSphere),
 * bowl, dome, cylinder arc. The names are used in the rig template
 * dropdown and as buttons in the surface UI for one-click application. */
function _sweptSurfacePreset(name, scale) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 5;
  switch (name) {
    case "alloSphere":
      // UCSB AlloSphere — full 360° yaw, ±~85° pitch (the 4-projector-
      // ring layout in the allosphere-real rig template covers
      // pitches of ±60° centered, with ~50° vertical FOV per
      // projector → effective coverage ±85°, with a small floor cut
      // and zenith pole left uncovered). yaw is full revolution
      // because the real rig wraps around. Aligns with the
      // allosphere-real rig template so coverage-aware capture
      // filters keep front/back/left/right cardinals.
      return {
        type: "swept",
        profile: { kind: "arc", radius: s, pitchStart: -85, pitchEnd: 85 },
        path:    { kind: "revolution", yawStart: -180, yawEnd: 180 }
      };
    case "truncatedDome160":
      // Sajadi-Majumder TVCG 2012 §6 truncated dome — 30ft radius,
      // 26ft height, 160° horizontal. Different physical installation
      // than UCSB AlloSphere; this is the paper's calibration test
      // case. Symmetric ±80° yaw, pitch -30° (floor) to +90° (zenith).
      return {
        type: "swept",
        profile: { kind: "arc", radius: s, pitchStart: -30, pitchEnd: 90 },
        path:    { kind: "revolution", yawStart: -80, yawEnd: 80 }
      };
    case "fullSphere":
      return {
        type: "swept",
        profile: { kind: "arc", radius: s, pitchStart: -90, pitchEnd: 90 },
        path:    { kind: "revolution", yawStart: -180, yawEnd: 180 }
      };
    case "dome":
      // Top half of a sphere — pitch 0 to +90, full yaw.
      return {
        type: "swept",
        profile: { kind: "arc", radius: s, pitchStart: 0, pitchEnd: 90 },
        path:    { kind: "revolution", yawStart: -180, yawEnd: 180 }
      };
    case "bowl":
      // Bottom half of a sphere — pitch -90 to 0, full yaw.
      return {
        type: "swept",
        profile: { kind: "arc", radius: s, pitchStart: -90, pitchEnd: 0 },
        path:    { kind: "revolution", yawStart: -180, yawEnd: 180 }
      };
    case "truncatedDome":
      // Dome with the polar cap cut — the practical case for an
      // installation where the very top isn't projected onto.
      return {
        type: "swept",
        profile: { kind: "arc", radius: s, pitchStart: -15, pitchEnd: 75 },
        path:    { kind: "revolution", yawStart: -180, yawEnd: 180 }
      };
    case "cylinderArc":
      // Default 180° arc of a cylinder (front-facing curved wall).
      return {
        type: "swept",
        profile: { kind: "vertical", radius: s, yMin: -s * 0.5, yMax: s * 0.5 },
        path:    { kind: "revolution", yawStart: -90, yawEnd: 90 }
      };
    default:
      return _sweptSurfacePreset("alloSphere", s);
  }
}

