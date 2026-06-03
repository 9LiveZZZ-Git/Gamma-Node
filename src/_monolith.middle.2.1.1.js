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

/* ---------- Phase 6.6 — calibration & warp data layer ---------- */

/* A "Bourke mesh" is the calibration warp format introduced by Paul
 * Bourke for dome / panoramic projection rigs. Each vertex carries 5
 * floats:
 *
 *     (x, y,   u, v,   intensity)
 *      └────┘  └────┘  └───────┘
 *      output  source  edge-blend
 *      NDC     UV      multiplier
 *
 * The mesh is a regular (cols+1) × (rows+1) grid of vertices, forming
 * cols × rows quads. The render path (Phase 6.6.4) uploads the verts
 * as a vertex buffer and draws the grid as triangle strips, sampling
 * the display's source layer at (u, v) and writing to (x, y) on the
 * projector's framebuffer. The intensity is multiplied into the
 * fragment color so overlap regions can fade between projectors.
 *
 *   x, y       — output position in normalized device coords [-1, 1].
 *                Default identity grid: x = u*2 - 1, y = v*2 - 1.
 *                Calibration shifts these to compensate for screen
 *                curvature, projector keystoning, and lens distortion.
 *
 *   u, v       — source texture coords in [0, 1]. Default identity:
 *                u = c / cols, v = r / rows. Adjusting these is rare
 *                — calibration usually moves x/y, not u/v — but the
 *                format supports it so one display can preview a
 *                sub-region of its source layer if useful.
 *
 *   intensity  — edge-blend multiplier in [0, 1]. Default 1 (no blend).
 *                Auto-blend (Phase 6.6.11) generates ramps so adjacent
 *                projectors' intensities sum to ~1 in the overlap.
 *
 * In-memory representation: plain Array of length (cols+1)*(rows+1)*5
 * so it round-trips through JSON.stringify in .gpatch saves without
 * loss. Float32Array conversion happens at GPU upload time, not before.
 *
 * A warpMesh of `null` means "no warp" — the render path falls back to
 * the fullscreen-triangle pipeline, which is what every patch saved
 * before Phase 6.6 has. Identity warp meshes (built via
 * _makeIdentityWarpMesh) are functionally equivalent to null but allow
 * subsequent calibration edits without re-allocating the mesh. */
function _makeIdentityWarpMesh(cols, rows) {
  cols = Math.max(1, cols | 0); rows = Math.max(1, rows | 0);
  const W = cols + 1, H = rows + 1;
  const verts = new Array(W * H * 5);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      const i = (r * W + c) * 5;
      verts[i + 0] = u * 2 - 1;     // x in NDC
      verts[i + 1] = v * 2 - 1;     // y in NDC
      verts[i + 2] = u;              // u in source UV
      verts[i + 3] = v;              // v in source UV
      verts[i + 4] = 1;              // intensity (no blend)
    }
  }
  return { cols, rows, verts };
}

/* Triangular variant of the identity mesh — alternate rows are
 * offset by half a cell width so the (cols)×(rows) quads triangulate
 * into diamonds instead of axis-aligned rectangles. Useful when the
 * physical screen has curvature that doesn't align with the grid
 * axes; the diagonal edges give the warp more freedom in the
 * direction the rectangular grid wouldn't.
 *
 * The offset is applied to mesh NDC x only (preserves V mapping +
 * intensity = 1 everywhere). UVs follow the offset so source
 * sampling stays correct after warp edits. Edge columns stay pinned
 * at x = ±1 so the boundary doesn't poke outside the quad. */
function _makeTriangularWarpMesh(cols, rows) {
  const m = _makeIdentityWarpMesh(cols, rows);
  const W = cols + 1, H = rows + 1;
  const halfCell = 0.5 / cols;
  for (let r = 0; r < H; r++) {
    if ((r & 1) === 0) continue;     // even rows untouched
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 5;
      // Pinned edges so the quad's outer boundary stays a clean rectangle.
      if (c === 0 || c === cols) continue;
      // Shift x by half-cell-NDC; matching shift in u so the
      // sampled source content stays aligned to the new vertex.
      m.verts[i + 0] += halfCell * 2;
      m.verts[i + 2] += halfCell;
    }
  }
  return m;
}

/* Build a test-warp mesh: identity grid with sinusoidal bow on x +
 * a horizontal intensity ramp on the left/right edges. Used by the
 * rig pane's per-display "warp: test" toggle to verify the full
 * Phase 6.6 pipeline (warp geometry + edge-blend intensity + gamma
 * + power + black-lift) end-to-end without committing to a full
 * editor UX.
 *
 * Effects baked in:
 *   - Geometric bow: middle of each row pinches inward by 12%, top
 *     + bottom rows untouched. Demonstrates the warp vertex pipeline.
 *   - Edge intensity ramp: leftmost + rightmost ~20% of the mesh
 *     fade from intensity 0.25 at the edge to 1.0 at the inner
 *     bound. Demonstrates the intensity multiply, gamma correction,
 *     power curve, and black-lift math from 6.6.5–6.6.8. With
 *     blackLift > 0 you'll see the edges raise to a non-black floor
 *     instead of fading to black. */
function _makeTestWarpMesh(cols, rows) {
  const m = _makeIdentityWarpMesh(cols, rows);
  const W = cols + 1, H = rows + 1;
  // Width of the intensity ramp: 20% of the mesh on each side.
  const rampWidth = 0.2;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 5;
      const u = c / cols;
      const v = r / rows;
      // Geometric: pinch x toward center on the equator row.
      const k = 1.0 - 0.12 * Math.sin(Math.PI * v);
      m.verts[i + 0] *= k;
      // Intensity ramp: left edge rises from 0.25 → 1.0 across the
      // first 20% of u; right edge mirrors. Smooth (Hermite) easing
      // so the ramp reads as a soft fade, not a hard step.
      let leftRamp  = 1.0;
      let rightRamp = 1.0;
      if (u < rampWidth) {
        const t = u / rampWidth;
        const smooth = t * t * (3 - 2 * t);
        leftRamp = 0.25 + smooth * 0.75;
      }
      if (u > 1 - rampWidth) {
        const t = (1 - u) / rampWidth;
        const smooth = t * t * (3 - 2 * t);
        rightRamp = 0.25 + smooth * 0.75;
      }
      m.verts[i + 4] = Math.min(leftRamp, rightRamp);
    }
  }
  m._isTest = true;
  return m;
}

/* ------------ Phase 6.6.19 — Bezier-patch warp authoring -------------- *
 *
 * Inspired by Sajadi & Majumder, "Autocalibration of Multiprojector
 * CAVE-Like Immersive Environments" (IEEE TVCG 2012, doc 6060818).
 *
 * The paper represents a projector→display warp as a single rational
 * Bezier patch BX,BY (and BZ for full 3D, but our 2D pipeline only
 * needs BX,BY). For our authoring use case we use a *non*-rational
 * Bezier (all weights 1) since the perspective-invariance argument
 * doesn't apply when the user is hand-editing — they want shape,
 * not a fitted-to-physics representation.
 *
 * Tradeoff vs the existing 33×33-vertex mesh authoring:
 *   Mesh:   N² draggable points, exact local control, but tedious
 *           for smooth curved warps and visible faceting at low N.
 *   Bezier: ~25 draggable points (default 5×5 = degree 4), smooth
 *           C^∞ everywhere, much faster to author for sphere/dome
 *           warps. Not all warps are reachable (Bezier of finite
 *           degree can't have arbitrary local detail), but a 5×5
 *           patch is enough for AlloSphere-class smooth surfaces.
 *
 * Storage: a Bezier patch lives as `m._bezier = { cols, rows, ctrl }`
 * piggy-backing on the existing warpMesh object. ctrl is a flat
 * (cols+1)*(rows+1)*2 array of (x, y) NDC positions in row-major
 * order. The mesh's `verts` field stays the source of truth for the
 * GPU pipeline — when the user drags a control point we re-tessellate
 * verts from ctrl. This means zero shader changes; the runtime
 * doesn't even know it's looking at a Bezier output.
 *
 * Round-trip: JSON.stringify preserves the `_bezier` field through
 * .gpatch saves. On load, _validateWarpMesh ignores extra fields so
 * the bezier rides along with the mesh.
 */

/* Bernstein basis B_i^n(t) = C(n,i) t^i (1-t)^(n-i), for i = 0..n.
 * Returned as a flat array of length n+1. We compute binomial coeffs
 * incrementally to avoid factorial blowup. */
function _bernsteinBasis(n, t) {
  const out = new Array(n + 1);
  const u = 1 - t;
  // B_0^n(t) = (1-t)^n.
  out[0] = Math.pow(u, n);
  // B_i^n(t) = C(n,i) t^i (1-t)^(n-i). Incremental binomial: C(n,i)
  // = C(n,i-1) * (n-i+1) / i.
  let coef = 1;
  for (let i = 1; i <= n; i++) {
    coef = coef * (n - i + 1) / i;
    out[i] = coef * Math.pow(t, i) * Math.pow(u, n - i);
  }
  return out;
}

/* Tensor-product Bezier surface evaluation at (u, v) ∈ [0,1]².
 * ctrl is a flat row-major (cols+1)*(rows+1)*2 array of (x, y).
 * Returns {x, y} of the surface at (u, v). */
function _bezierEval(ctrl, cols, rows, u, v) {
  const Bu = _bernsteinBasis(cols, u);
  const Bv = _bernsteinBasis(rows, v);
  const W = cols + 1;
  let x = 0, y = 0;
  for (let j = 0; j <= rows; j++) {
    const bvj = Bv[j];
    for (let i = 0; i <= cols; i++) {
      const w = Bu[i] * bvj;
      const k = (j * W + i) * 2;
      x += w * ctrl[k];
      y += w * ctrl[k + 1];
    }
  }
  return { x, y };
}

/* Build an identity Bezier control-point grid: a uniform (cols+1)×
 * (rows+1) grid of NDC positions spanning [-1, +1]² with no warp.
 * The Bezier surface of a regular control grid reproduces the affine
 * map exactly (linear-precision property), so identity in → identity
 * out. */
function _makeIdentityBezier(cols, rows) {
  cols = Math.max(1, cols | 0); rows = Math.max(1, rows | 0);
  const W = cols + 1, H = rows + 1;
  const ctrl = new Array(W * H * 2);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 2;
      ctrl[i + 0] = (c / cols) * 2 - 1;
      ctrl[i + 1] = (r / rows) * 2 - 1;
    }
  }
  return { cols, rows, ctrl };
}

/* Tessellate a Bezier patch into a fine warp mesh suitable for the
 * existing GPU pipeline. UVs + intensity stay regular (uniform source
 * sampling, no edge-blend); only NDC (x, y) are overridden by Bezier
 * eval. The resulting mesh carries `m._bezier = bezier` so the editor
 * can recognize bezier-authored meshes on reopen. */
function _bezierToWarpMesh(bezier, meshCols, meshRows) {
  meshCols = Math.max(2, meshCols | 0);
  meshRows = Math.max(2, meshRows | 0);
  const m = _makeIdentityWarpMesh(meshCols, meshRows);
  const W = meshCols + 1, H = meshRows + 1;
  for (let r = 0; r < H; r++) {
    const v = r / meshRows;
    for (let c = 0; c < W; c++) {
      const u = c / meshCols;
      const p = _bezierEval(bezier.ctrl, bezier.cols, bezier.rows, u, v);
      const idx = (r * W + c) * 5;
      m.verts[idx + 0] = p.x;
      m.verts[idx + 1] = p.y;
    }
  }
  // Carry the bezier control grid on the mesh as the source of truth.
  // Slice ctrl so future drags don't share the input array.
  m._bezier = { cols: bezier.cols, rows: bezier.rows, ctrl: bezier.ctrl.slice() };
  return m;
}

/* Re-tessellate the mesh's vert positions from its current `_bezier`
 * control grid. Called after every Bezier control-point drag. UVs +
 * intensity are preserved (only NDC x, y change). meshCols/meshRows
 * are pulled from the existing mesh so we don't change tessellation
 * density mid-edit. */
function _rebuildMeshFromBezier(m) {
  if (!m || !m._bezier) return;
  const cols = m.cols, rows = m.rows, W = cols + 1, H = rows + 1;
  for (let r = 0; r < H; r++) {
    const v = r / rows;
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const p = _bezierEval(m._bezier.ctrl, m._bezier.cols, m._bezier.rows, u, v);
      const idx = (r * W + c) * 5;
      m.verts[idx + 0] = p.x;
      m.verts[idx + 1] = p.y;
    }
  }
}

/* Default tessellation density for the GPU mesh derived from a
 * Bezier patch. 32×32 quads = 33² = 1089 vertices — fine enough that
 * the smooth Bezier surface doesn't show faceting on a 1080p output,
 * cheap enough to re-tessellate on every drag at 60fps. */
const BEZIER_MESH_TESS = 32;

/* ------------ Phase 6.6.3 — CSV / MPCDI exporters ---------------------- */

/* CRC-32 (IEEE 802.3 polynomial 0xEDB88320). Required by the ZIP
 * spec for every file entry's checksum. Pre-built table is built
 * once on first use and cached. ~3 KB lookup table; trivial. */
let _crc32Table = null;
function _crc32(buf) {
  if (!_crc32Table) {
    _crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crc32Table[n] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* Pure-JS ZIP encoder. Takes { filename: Uint8Array, ... } and
 * returns a Uint8Array containing a valid ZIP archive. No external
 * deps — uses the well-defined ZIP format directly. STORED method
 * only (no DEFLATE) — keeps the encoder simple and the resulting
 * file is just as readable by any unzip tool. MPCDI bundles are
 * small (XML + a few CSV files) so the ~zero compression penalty is
 * fine. ZIP64 not used (4 GB / 64K caps still well above any
 * realistic MPCDI payload). */
function _writeZipArchive(files) {
  const enc = new TextEncoder();
  const entries = [];
  let offset = 0;
  // Per-entry: build local header, write data, record central-dir info.
  const chunks = [];
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const crc = _crc32(data);
    const localHeader = new ArrayBuffer(30);
    const lhView = new DataView(localHeader);
    lhView.setUint32(0,  0x04034b50, true);    // signature
    lhView.setUint16(4,  20,         true);    // version needed
    lhView.setUint16(6,  0,          true);    // flags
    lhView.setUint16(8,  0,          true);    // method (0 = STORED)
    lhView.setUint16(10, 0,          true);    // mod time
    lhView.setUint16(12, 0,          true);    // mod date
    lhView.setUint32(14, crc,        true);    // CRC-32
    lhView.setUint32(18, data.length, true);   // compressed size (== uncompressed for STORED)
    lhView.setUint32(22, data.length, true);   // uncompressed size
    lhView.setUint16(26, nameBytes.length, true);
    lhView.setUint16(28, 0, true);             // extra field length
    chunks.push(new Uint8Array(localHeader), nameBytes, data);
    entries.push({ name: nameBytes, crc, size: data.length, offset });
    offset += 30 + nameBytes.length + data.length;
  }
  // Central directory.
  const cdStart = offset;
  for (const e of entries) {
    const cdHeader = new ArrayBuffer(46);
    const cdView = new DataView(cdHeader);
    cdView.setUint32(0,  0x02014b50, true);
    cdView.setUint16(4,  20, true);            // version made by
    cdView.setUint16(6,  20, true);            // version needed
    cdView.setUint16(8,  0,  true);            // flags
    cdView.setUint16(10, 0,  true);            // method
    cdView.setUint16(12, 0,  true);            // mod time
    cdView.setUint16(14, 0,  true);            // mod date
    cdView.setUint32(16, e.crc, true);
    cdView.setUint32(20, e.size, true);
    cdView.setUint32(24, e.size, true);
    cdView.setUint16(28, e.name.length, true);
    cdView.setUint16(30, 0,  true);            // extra
    cdView.setUint16(32, 0,  true);            // comment
    cdView.setUint16(34, 0,  true);            // disk
    cdView.setUint16(36, 0,  true);            // internal attrs
    cdView.setUint32(38, 0,  true);            // external attrs
    cdView.setUint32(42, e.offset, true);
    chunks.push(new Uint8Array(cdHeader), e.name);
    offset += 46 + e.name.length;
  }
  const cdEnd = offset;
  // EOCD.
  const eocd = new ArrayBuffer(22);
  const eView = new DataView(eocd);
  eView.setUint32(0,  0x06054b50, true);
  eView.setUint16(4,  0, true);
  eView.setUint16(6,  0, true);
  eView.setUint16(8,  entries.length, true);
  eView.setUint16(10, entries.length, true);
  eView.setUint32(12, cdEnd - cdStart, true);
  eView.setUint32(16, cdStart, true);
  eView.setUint16(20, 0, true);
  chunks.push(new Uint8Array(eocd));
  // Concat.
  let total = 0; for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/* Serialize a Bourke warp mesh to text. Format:
 *     2
 *     N M
 *     x y u v intensity            (per vertex, row-major)
 *
 * Six decimals on the floats — finer than any visible difference at
 * 1080p, smaller than 16-byte floats but accurate enough to round-
 * trip the editor's drag precision. */
function _serializeBourkeMesh(mesh) {
  if (!_validateWarpMesh(mesh)) throw new Error("invalid warp mesh");
  const W = mesh.cols + 1, H = mesh.rows + 1;
  const lines = ["2", W + " " + H];
  for (let i = 0; i < W * H; i++) {
    const o = i * 5;
    lines.push(
      mesh.verts[o + 0].toFixed(6) + " " +
      mesh.verts[o + 1].toFixed(6) + " " +
      mesh.verts[o + 2].toFixed(6) + " " +
      mesh.verts[o + 3].toFixed(6) + " " +
      mesh.verts[o + 4].toFixed(6)
    );
  }
  return lines.join("\n") + "\n";
}

/* Generate a minimal MPCDI XML manifest describing the rig. Per-
 * region warp/alpha file references are written as Bourke CSV
 * filenames (our exporter writes CSVs into the bundle, not PFM).
 * External tools that strictly expect PFM may reject these; that's
 * a follow-on (6.6.3b). For round-trip with our own importer the
 * output is correct. */
function _serializeMpcdiXml(rig, opts) {
  const displays = rig && Array.isArray(rig.displays) ? rig.displays : [];
  const warpExt = (opts && opts.warpExt) || "pfm";
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<MPCDI version="2.0" profile="3d" geometric_unit="mm" date="' + new Date().toISOString().slice(0,10) + '" exporter="Gamma-Node-' + APP_VERSION + '">');
  parts.push('  <display id="display1">');
  parts.push('    <buffer id="buffer1" Xresolution="' + (rig.masterRes ? rig.masterRes[0] : 1920) + '" Yresolution="' + (rig.masterRes ? rig.masterRes[1] : 1080) + '">');
  for (let i = 0; i < displays.length; i++) {
    const d = displays[i];
    if (!d) continue;
    const pose = d.pose || { yaw: 0, pitch: 0, roll: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    const id   = d.id   || ("region" + i);
    const fname = id + "_warp." + warpExt;
    parts.push('      <region id="' + id + '" x="0" y="0" xsize="1" ysize="1">');
    parts.push('        <frustum>');
    parts.push('          <yaw>'   + pose.yaw   + '</yaw>');
    parts.push('          <pitch>' + pose.pitch + '</pitch>');
    parts.push('          <roll>'  + (pose.roll || 0) + '</roll>');
    parts.push('          <rightAngle>' + ( fov.h * 0.5) + '</rightAngle>');
    parts.push('          <leftAngle>'  + (-fov.h * 0.5) + '</leftAngle>');
    parts.push('          <upAngle>'    + ( fov.v * 0.5) + '</upAngle>');
    parts.push('          <downAngle>'  + (-fov.v * 0.5) + '</downAngle>');
    parts.push('        </frustum>');
    if (d.warpMesh) {
      parts.push('        <files>');
      parts.push('          <fileSet region="' + id + '">');
      parts.push('            <geometryWarpFile>' + fname + '</geometryWarpFile>');
      parts.push('          </fileSet>');
      parts.push('        </files>');
    }
    parts.push('      </region>');
  }
  parts.push('    </buffer>');
  parts.push('  </display>');
  parts.push('</MPCDI>');
  return parts.join("\n") + "\n";
}

/* Trigger a browser download of a Blob with the given filename. */
function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

/* User-facing: download a single display's warp mesh as a Bourke
 * CSV file. Filename derives from the display's id + name. */
function exportBourkeMeshForDisplay(displayIdx) {
  const d = state.rig && state.rig.displays && state.rig.displays[displayIdx];
  if (!d) return;
  if (!_validateWarpMesh(d.warpMesh)) {
    alert("Display " + displayIdx + " has no warp mesh to export.\n\nClick ✎ edit + drag a point to create one, or use Auto-blend rig.");
    return;
  }
  try {
    const text = _serializeBourkeMesh(d.warpMesh);
    const safe = String(d.name || d.id || ("display" + displayIdx)).replace(/[^A-Za-z0-9_-]/g, "_");
    _downloadBlob(new Blob([text], { type: "text/plain" }), safe + "_warp.csv");
  } catch (e) {
    alert("Could not export warp mesh:\n\n" + (e && e.message ? e.message : String(e)));
  }
}

/* User-facing: download the whole rig as an MPCDI ZIP bundle.
 *
 * Phase 6.6.3b — bundles include BOTH a Bourke .csv AND a 1024×1024
 * PFM rasterization of each warp mesh. CSV is what our own importer
 * round-trips through; PFM is what VESA-spec MPCDI consumers (VIOSO,
 * dome-projection.com tools, Resolume strict mode) expect. The XML
 * references the PFM so external tools find their format; the CSV
 * is alongside as a fallback that's also more diff-friendly. */
function exportMpcdiBundle() {
  if (!state.rig || !Array.isArray(state.rig.displays)) {
    alert("No rig to export.");
    return;
  }
  try {
    const enc = new TextEncoder();
    const files = {};
    let warpedCount = 0;
    const includePfm = state.rig.displays.some(d => d && _validateWarpMesh(d.warpMesh));
    state.rig.displays.forEach((d, i) => {
      if (!d || !_validateWarpMesh(d.warpMesh)) return;
      const id = d.id || ("region" + i);
      files[id + "_warp.csv"] = enc.encode(_serializeBourkeMesh(d.warpMesh));
      // PFM rasterization is heavier (~1024×1024×3×4 = 12 MB per mesh)
      // — only generate when there's actually a mesh to write.
      files[id + "_warp.pfm"] = _serializePfm(d.warpMesh, 1024, 1024);
      warpedCount++;
    });
    files["mpcdi.xml"] = enc.encode(_serializeMpcdiXml(state.rig, { warpExt: includePfm ? "pfm" : "csv" }));
    const zip = _writeZipArchive(files);
    const fname = (state.patchName || "rig") + ".mpcdi";
    _downloadBlob(new Blob([zip], { type: "application/octet-stream" }), fname);
    console.log("[mpcdi-export]", fname, "(" + state.rig.displays.length + " displays, " + warpedCount + " with warps × PFM+CSV each)");
  } catch (e) {
    alert("Could not export MPCDI bundle:\n\n" + (e && e.message ? e.message : String(e)));
  }
}

