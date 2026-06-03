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

/* ------------ Phase 6.6.20.8 — Auto-capture calibration ---------------- *
 *
 * Walks through the theater preview from the rig's sweet-spot in 6
 * cardinal directions (front/back/left/right/up/down), optionally
 * cycling Checkerboard.mode 0..4 between snapshots, and packages the
 * resulting PNGs into a downloadable ZIP bundle along with a JSON
 * metadata file describing the rig + capture parameters.
 *
 * Use case: visually verify projector calibration. Pair with the
 * WireframeCalibration shader-frag (6.6.20.7) — wireframe lines
 * should connect smoothly across projector boundaries; any
 * shift/break diagnoses bad calibration. The capture ZIP also
 * documents the rig state at calibration time, ready to feed to
 * Claude API / Gemma 4 vision in a future phase for automatic
 * misalignment scoring + auto-correction of pose/FOV/warp params. */

/* Helper — wait for N rAF ticks. Lets us settle WebGPU pipeline
 * before reading back the canvas via toBlob (which the browser
 * gates on GPU work completion, but we still need at least one
 * frame to commit the new uniforms). */
function _waitForFrames(n) {
  return new Promise(resolve => {
    let count = 0;
    const tick = () => {
      count++;
      if (count >= n) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* 6.6.20.9 — coverage check. Returns true if a viewing direction
 * (yawDeg, pitchDeg) from the rig origin would actually hit the
 * screen surface. Used to prune capture directions for partial
 * surfaces (e.g. AlloSphere yaw [-80, 80] doesn't cover yaw=180°
 * "back" — capturing back yields useless garbage from off-axis
 * projectors). */
function _directionInCoverage(yawDeg, pitchDeg, surface) {
  if (!surface || surface.type === "free")  return true;
  if (surface.type === "plane")             return true;
  if (surface.type === "sphere")            return true;
  if (surface.type === "cylinder") {
    const halfL = (surface.length || 5) * 0.5;
    const R = surface.radius || 5;
    const maxPitchDeg = Math.atan(halfL / R) * 180 / Math.PI;
    return Math.abs(pitchDeg) <= maxPitchDeg + 5;
  }
  if (surface.type === "swept") {
    const path = surface.path || { yawStart: -180, yawEnd: 180 };
    const profile = surface.profile || { kind: "arc", pitchStart: -90, pitchEnd: 90 };
    const yawStart = path.yawStart != null ? path.yawStart : -180;
    const yawEnd   = path.yawEnd   != null ? path.yawEnd   :  180;
    // Wrap yaw into the path range
    let yaw = yawDeg;
    while (yaw > yawEnd + 180) yaw -= 360;
    while (yaw < yawStart - 180) yaw += 360;
    if (yaw < yawStart - 1 || yaw > yawEnd + 1) return false;
    if (profile.kind === "arc") {
      const pStart = profile.pitchStart != null ? profile.pitchStart : -90;
      const pEnd   = profile.pitchEnd   != null ? profile.pitchEnd   :  90;
      return pitchDeg >= pStart - 1 && pitchDeg <= pEnd + 1;
    }
    if (profile.kind === "vertical") {
      const R = profile.radius || 5;
      const yMin = profile.yMin != null ? profile.yMin : -2.5;
      const yMax = profile.yMax != null ? profile.yMax :  2.5;
      // y on the cylinder at this pitch from origin
      const cosP = Math.cos(pitchDeg * Math.PI / 180);
      if (Math.abs(cosP) < 1e-6) {
        // Looking straight up/down — nominally outside vertical-profile range
        return false;
      }
      const y = R * Math.tan(pitchDeg * Math.PI / 180);
      return y >= yMin - 0.1 && y <= yMax + 0.1;
    }
  }
  return true;
}

async function autoCaptureCalibration(opts) {
  if (!Visual || !Visual.canvas) {
    throw new Error("Visual canvas not initialized");
  }
  if (!Visual.theaterCam) {
    throw new Error("Theater camera not initialized");
  }
  if (!state.rig || !Array.isArray(state.rig.displays)) {
    throw new Error("Rig not configured");
  }
  const onProgress    = (opts && opts.onProgress) || null;
  // 6.6.20.9 defaults — all three improvements ON unless explicitly
  // disabled via opts. User can override per-call from a future UI.
  const autoPrep      = !(opts && opts.autoPrep      === false);  // apply Auto-warp + hard-cut blend before capture
  const coverageAware = !(opts && opts.coverageAware === false);  // skip directions outside surface coverage
  const perDisplay    = !(opts && opts.perDisplay    === false);  // also capture aimed at each display's pose
  // 6.6.20.20 — also capture BOUNDARY views between adjacent
  // projector pairs. Each pair's mid-direction shows the seam
  // mid-frame so the AI can verify whether wireframe lines
  // connect cleanly across the boundary. Default ON.
  const boundaryPairs = !(opts && opts.boundaryPairs === false);
  // 6.6.20.20 — also capture POLE shots (forced inside surface
  // coverage at ±80° pitch). Reveals polar projector convergence
  // issues that the cardinal up/down (89.4°) miss because they're
  // outside coverage. Default ON.
  const polarShots    = !(opts && opts.polarShots    === false);

  // Snapshot state so finally{} can put everything back exactly.
  const prevPreviewMode = state.rig.previewMode;
  const prevCam = {
    pos:   Visual.theaterCam.pos.slice(),
    yaw:   Visual.theaterCam.yaw,
    pitch: Visual.theaterCam.pitch,
    fov:   Visual.theaterCam.fov   // 6.6.20.19 — also save FOV for wider AI captures
  };
  // 6.6.20.20 — detect what shaders are in the patch. AI calibration
  // expects WireframeCalibration to be wired to the VOs (it's the
  // shader whose output the AI prompts describe — red equator,
  // RGB great circles, beacon circles etc.). When called from the
  // AI flow (opts.aiMode), we SKIP Checkerboard mode-cycling
  // entirely; cycling 5 modes mid-loop confuses the AI's frame-to-
  // frame comparison and the captures become inconsistent.
  const aiMode = !!(opts && opts.aiMode);
  const wireframeNodes = (state.nodes || []).filter(n => n.type === "WireframeCalibration");
  const checkerNodes   = (state.nodes || []).filter(n => n.type === "Checkerboard");
  const prevCheckerModes = checkerNodes.map(n => (n.params && n.params.mode));
  // If autoPrep mutates warp meshes, save them too so capture is
  // side-effect-free. (User runs Auto-warp / Auto-blend manually if
  // they want to keep the prep result.)
  let prevWarpMeshes = null;
  if (autoPrep) {
    prevWarpMeshes = state.rig.displays.map(d =>
      (d && d.warpMesh) ? _cloneWarpMesh(d.warpMesh) : null
    );
  }

  const restoreState = () => {
    state.rig.previewMode = prevPreviewMode;
    Visual.theaterCam.pos[0] = prevCam.pos[0];
    Visual.theaterCam.pos[1] = prevCam.pos[1];
    Visual.theaterCam.pos[2] = prevCam.pos[2];
    Visual.theaterCam.yaw   = prevCam.yaw;
    Visual.theaterCam.pitch = prevCam.pitch;
    Visual.theaterCam.fov   = prevCam.fov;       // 6.6.20.19 — restore FOV
    checkerNodes.forEach((n, i) => {
      if (n.params && prevCheckerModes[i] !== undefined) {
        n.params.mode = prevCheckerModes[i];
      }
    });
    if (prevWarpMeshes) {
      state.rig.displays.forEach((d, i) => {
        if (!d) return;
        d.warpMesh = prevWarpMeshes[i];
        if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      });
    }
    if (typeof _updateProjectionPill === "function") _updateProjectionPill();
    render();
  };

  // Track which prep operations actually ran (for the meta JSON).
  const prepApplied = { autoWarp: false, autoBlend: false };

  try {
    // PHASE 1 — Auto-prep. Phase 6.6.20.22: SKIP auto-warp here.
    // Auto-warp was originally designed for the OLD flat-quad
    // theater rendering — it pre-distorts source UVs so flat
    // projector tiles look audience-correct on a curved screen.
    // But theater since 6.6.20.1 places mesh vertices on the
    // actual sphere via raycasting, which already handles
    // audience-correctness. Running auto-warp on top creates a
    // DOUBLE WARP (UV remapping + raycast displacement) that
    // shifts adjacent projectors' content out of alignment at
    // boundaries, producing the visible "thick stacked line"
    // artifacts the user reported.
    //
    // Auto-blend stays (its hard-cut alpha doesn't remap UVs,
    // just sets per-vertex intensity for projector overlap
    // assignment). Custom hand-edited warps still survive via
    // _isCustom skip.
    if (autoPrep) {
      try {
        const blendResults = _applyAutoBlendToRig({ skipHistory: true, hardCuts: true });
        prepApplied.autoBlend = !!(blendResults && blendResults.length > 0);
      } catch (_) { /* skip */ }
      // autoWarp deliberately omitted — see comment above.
      await _waitForFrames(3);
    }

    // PHASE 2 — switch to theater + sweet-spot.
    state.rig.previewMode = "theater";
    if (typeof _updateProjectionPill === "function") _updateProjectionPill();
    const ss = Array.isArray(state.rig.sweetSpot) ? state.rig.sweetSpot : [0, 0, 0];
    Visual.theaterCam.pos[0] = ss[0];
    Visual.theaterCam.pos[1] = ss[1];
    Visual.theaterCam.pos[2] = ss[2];
    // 6.6.20.19 — wider capture FOV (90° vertical, was 60°) so each
    // per-display photo shows the target projector + ~50% of the
    // adjacent neighbors' coverage at the frame edges. Without this,
    // the AI was only seeing one projector centered and couldn't
    // verify boundary alignment — Phase 2 reasoning was generic
    // ("slight edge bulge") because the boundary literally wasn't
    // in the frame. Wide FOV puts the boundary mid-frame where AI
    // can see both sides. Restored in finally{}.
    Visual.theaterCam.fov = 90;

    // PHASE 3 — build the direction list.
    //
    // Cardinal directions: 6 axis-aligned views from the sweet-spot.
    // Up/down stop just shy of the zenith / nadir (89.4°) to avoid
    // the theater view matrix's gimbal-lock numerical degeneracy.
    let directions = [
      { name: "front", yawDeg: 0,    pitchDeg:  0,    kind: "cardinal" },
      { name: "right", yawDeg: 90,   pitchDeg:  0,    kind: "cardinal" },
      { name: "back",  yawDeg: 180,  pitchDeg:  0,    kind: "cardinal" },
      { name: "left",  yawDeg: -90,  pitchDeg:  0,    kind: "cardinal" },
      { name: "up",    yawDeg: 0,    pitchDeg:  89.4, kind: "cardinal" },
      { name: "down",  yawDeg: 0,    pitchDeg: -89.4, kind: "cardinal" }
    ];

    // Coverage-aware filter — for partial surfaces (AlloSphere yaw
    // [-80,80] etc.) drop the cardinals that aim at empty space.
    if (coverageAware) {
      directions = directions.filter(d =>
        _directionInCoverage(d.yawDeg, d.pitchDeg, state.rig.surface)
      );
    }

    // Per-display centers — one capture per projector aimed at its
    // pose direction. Most diagnostic for finding which projector
    // is misaligned (the wireframe pattern in that capture should
    // be centered + the surrounding projectors' edges should
    // connect smoothly to the central one's edges).
    if (perDisplay && Array.isArray(state.rig.displays)) {
      const seenNames = new Set(directions.map(d => d.name));
      state.rig.displays.forEach((display, idx) => {
        if (!display) return;
        const pose = display.pose || { yaw: 0, pitch: 0 };
        const yawDeg   = pose.yaw   || 0;
        // Clamp pitch so we don't gimbal-lock at ±90.
        const pitchDeg = Math.max(-89.4, Math.min(89.4, pose.pitch || 0));
        if (coverageAware && !_directionInCoverage(yawDeg, pitchDeg, state.rig.surface)) return;
        const safeId   = String(display.id   || ("d" + idx)).replace(/[^a-zA-Z0-9_-]/g, "");
        const safeName = String(display.name || "").replace(/[^a-zA-Z0-9_-]/g, "");
        const idxStr   = String(idx).padStart(2, "0");
        const name = "display-" + idxStr + (safeId ? "-" + safeId : "") + (safeName ? "-" + safeName : "");
        if (seenNames.has(name)) return;
        seenNames.add(name);
        directions.push({ name, yawDeg, pitchDeg, kind: "per-display", displayIdx: idx });
      });
    }

    // 6.6.20.20 — BOUNDARY-PAIR captures. For each pair of
    // projectors whose coverage overlaps, aim camera at the midpoint
    // between their pose directions. This puts the SEAM between
    // them dead-center in the frame, so the AI can verify whether
    // wireframe lines actually connect across the boundary (which
    // it cannot do from a single-projector-centered capture).
    if (boundaryPairs && Array.isArray(state.rig.displays)) {
      const seenNames = new Set(directions.map(d => d.name));
      const displays = state.rig.displays;
      // Two projectors share a boundary if their pose-to-pose
      // angular distance is less than the sum of their half-FOVs.
      // Compute half-fov as max(fov.h, fov.v)/2 for a conservative
      // overlap test.
      const angDist = (poseA, poseB) => {
        // Unit vectors for each pose; angular distance = arccos(dot).
        const ya = (poseA.yaw || 0) * Math.PI / 180, pa = (poseA.pitch || 0) * Math.PI / 180;
        const yb = (poseB.yaw || 0) * Math.PI / 180, pb = (poseB.pitch || 0) * Math.PI / 180;
        const ax = Math.sin(ya) * Math.cos(pa), ay = Math.sin(pa), az = Math.cos(ya) * Math.cos(pa);
        const bx = Math.sin(yb) * Math.cos(pb), by = Math.sin(pb), bz = Math.cos(yb) * Math.cos(pb);
        const dot = Math.max(-1, Math.min(1, ax*bx + ay*by + az*bz));
        return Math.acos(dot) * 180 / Math.PI;
      };
      const midDirection = (poseA, poseB) => {
        // Slerp midpoint (unit-vector average + renormalize works
        // for non-antipodal pairs, which all rig pairs are).
        const ya = (poseA.yaw || 0) * Math.PI / 180, pa = (poseA.pitch || 0) * Math.PI / 180;
        const yb = (poseB.yaw || 0) * Math.PI / 180, pb = (poseB.pitch || 0) * Math.PI / 180;
        const ax = Math.sin(ya) * Math.cos(pa), ay = Math.sin(pa), az = Math.cos(ya) * Math.cos(pa);
        const bx = Math.sin(yb) * Math.cos(pb), by = Math.sin(pb), bz = Math.cos(yb) * Math.cos(pb);
        const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
        const len = Math.hypot(mx, my, mz);
        if (len < 1e-6) return null;     // antipodal, can't midpoint
        const nx = mx / len, ny = my / len, nz = mz / len;
        return {
          yawDeg:   Math.atan2(nx, nz) * 180 / Math.PI,
          pitchDeg: Math.asin(Math.max(-1, Math.min(1, ny))) * 180 / Math.PI
        };
      };
      let added = 0;
      const MAX_BOUNDARY_PAIRS = 60;       // cap so 26-display rigs don't explode
      for (let i = 0; i < displays.length && added < MAX_BOUNDARY_PAIRS; i++) {
        const dA = displays[i];
        if (!dA || !dA.pose || !dA.fov) continue;
        const halfA = Math.max(dA.fov.h || 90, dA.fov.v || 60) * 0.5;
        for (let j = i + 1; j < displays.length && added < MAX_BOUNDARY_PAIRS; j++) {
          const dB = displays[j];
          if (!dB || !dB.pose || !dB.fov) continue;
          const halfB = Math.max(dB.fov.h || 90, dB.fov.v || 60) * 0.5;
          const dist = angDist(dA.pose, dB.pose);
          // Adjacent if angular distance < sum of half-FOVs (overlap)
          // AND > some minimum (not the same projector twice).
          if (dist > halfA + halfB || dist < 5) continue;
          const mid = midDirection(dA.pose, dB.pose);
          if (!mid) continue;
          // Clamp pitch to avoid gimbal-lock.
          const pitchDeg = Math.max(-89.4, Math.min(89.4, mid.pitchDeg));
          if (coverageAware && !_directionInCoverage(mid.yawDeg, pitchDeg, state.rig.surface)) continue;
          const idxA = String(i).padStart(2, "0");
          const idxB = String(j).padStart(2, "0");
          const name = "boundary-" + idxA + "-" + idxB;
          if (seenNames.has(name)) continue;
          seenNames.add(name);
          directions.push({
            name,
            yawDeg: mid.yawDeg,
            pitchDeg,
            kind: "boundary",
            displayPair: [i, j]
          });
          added++;
        }
      }
    }

    // 6.6.20.20 — POLE shots forced (within coverage). Cardinals
    // up/down (±89.4°) get filtered out for partial-pitch surfaces,
    // but projector convergence near the poles is exactly where
    // calibration usually fails. Capture at ±80° pitch which sits
    // INSIDE the AlloSphere preset's ±85° range — same direction
    // intent (looking near a pole) but inside coverage.
    if (polarShots) {
      const seenNames = new Set(directions.map(d => d.name));
      const polePitches = [80, -80];
      for (const pitchDeg of polePitches) {
        if (coverageAware && !_directionInCoverage(0, pitchDeg, state.rig.surface)) continue;
        const name = pitchDeg > 0 ? "near-zenith" : "near-nadir";
        if (seenNames.has(name)) continue;
        directions.push({ name, yawDeg: 0, pitchDeg, kind: "pole" });
      }
    }

    // PHASE 4 — build configs (Checkerboard mode cycle if wired).
    // 6.6.20.20 — in AI mode, suppress mode cycling. The AI flow
    // wants stable WireframeCalibration captures; cycling
    // Checkerboard modes mid-loop produces 5× as many captures
    // and the AI compares mode-0 vs mode-1 vs ... visuals as if
    // they were calibration changes. Stability beats variety here.
    const configs = [];
    if (!aiMode && checkerNodes.length > 0) {
      const modeLabels = ["healpix", "lambert", "cube", "octahedral", "lat-long"];
      for (let mode = 0; mode <= 4; mode++) {
        configs.push({
          label: "checker-" + modeLabels[mode] + "-m" + mode,
          apply: () => checkerNodes.forEach(n => {
            if (n.params) n.params.mode = mode;
          })
        });
      }
    } else {
      configs.push({ label: "current", apply: () => {} });
    }

    const total = directions.length * configs.length;
    let captured = 0;
    const captures = [];

    // PHASE 5 — capture loop.
    for (const cfg of configs) {
      cfg.apply();
      for (const dir of directions) {
        Visual.theaterCam.yaw   = dir.yawDeg   * Math.PI / 180;
        Visual.theaterCam.pitch = dir.pitchDeg * Math.PI / 180;
        // 6.6.20.20 — render twice (once to update the visual
        // pipeline's theater camera matrix from the new yaw/pitch,
        // once to actually draw with the new matrix in place) and
        // wait 6 frames so WebGPU's command queue + canvas
        // composition settles. The previous 3-frame wait was
        // enough for static rigs but missed transient rendering
        // states when the camera angle changed mid-loop.
        render();
        await _waitForFrames(2);
        render();
        await _waitForFrames(6);
        const blob = await new Promise((resolve, reject) => {
          Visual.canvas.toBlob((b) => {
            if (b) resolve(b);
            else  reject(new Error("canvas.toBlob returned null"));
          }, "image/png");
        });
        captures.push({ filename: cfg.label + "_" + dir.name + ".png", blob });
        captured++;
        if (onProgress) onProgress(captured, total);
      }
    }

    // Build ZIP via the existing pure-JS ZIP encoder (also used by
    // MPCDI export). Each entry is a Uint8Array.
    const files = {};
    for (const c of captures) {
      const buf = await c.blob.arrayBuffer();
      files[c.filename] = new Uint8Array(buf);
    }

    // Metadata JSON. Useful for documentation and for a future
    // Claude/Gemma vision pipeline that scores misalignment.
    const meta = {
      app: "Gamma Node",
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      captureOptions: {
        autoPrep,
        coverageAware,
        perDisplay,
        prepApplied
      },
      rig: {
        templateKey: state.rig.templateKey,
        surface:     state.rig.surface,
        surfaceVisible: state.rig.surfaceVisible !== false,
        sweetSpot:   ss.slice(),
        displayCount: state.rig.displays.length,
        previewMode: prevPreviewMode,
        shaderCenterYaw:   state.rig.shaderCenterYaw   || 0,
        shaderCenterPitch: state.rig.shaderCenterPitch || 0
      },
      directions: directions.map(d => ({
        name:     d.name,
        kind:     d.kind || "cardinal",
        yawDeg:   d.yawDeg,
        pitchDeg: d.pitchDeg,
        displayIdx: d.displayIdx
      })),
      captureConfigs: configs.map(c => c.label),
      checkerNodeCount: checkerNodes.length,
      // Per-display poses + FOVs so a future analyzer can correlate
      // visible misalignments with the rig's parameters.
      displays: state.rig.displays.map((d, i) => d ? {
        idx: i,
        id:  d.id,
        name: d.name,
        pose: d.pose || { yaw: 0, pitch: 0, roll: 0 },
        fov:  d.fov  || { h: 90, v: 60 },
        worldUv: d.worldUv,
        edgeBlend: d.edgeBlend,
        warpKind: !d.warpMesh ? "none"
                  : d.warpMesh._isTest      ? "test"
                  : d.warpMesh._isHardCuts  ? "auto-blend-hardcuts"
                  : d.warpMesh._isAutoBlend ? "auto-blend"
                  : d.warpMesh._isCustom    ? "custom"
                  : d.warpMesh._bezier      ? "bezier"
                  : "identity"
      } : null)
    };
    files["calibration-meta.json"] = new TextEncoder().encode(
      JSON.stringify(meta, null, 2)
    );
    // README so users know what they're looking at.
    const cardinalDirs   = meta.directions.filter(d => d.kind === "cardinal");
    const perDisplayDirs = meta.directions.filter(d => d.kind === "per-display");
    files["README.md"] = new TextEncoder().encode(
`# Gamma Node — auto-capture calibration bundle

Generated ${meta.timestamp} by Gamma Node v${APP_VERSION}.

## Capture options

- **Auto-prep:** ${autoPrep ? "ON" : "OFF"} — ${autoPrep ? "Auto-warp + hard-cut Auto-blend applied before capture (warp:" + (prepApplied.autoWarp ? " applied" : " skipped") + ", blend:" + (prepApplied.autoBlend ? " applied" : " skipped") + "). Restored to user's previous warp meshes after capture." : "Skipped — capture used whatever warp/blend state was already in place."}
- **Coverage-aware:** ${coverageAware ? "ON" : "OFF"} — ${coverageAware ? "Cardinal directions outside the surface's coverage range were skipped." : "All 6 cardinal directions captured regardless of coverage."}
- **Per-display:** ${perDisplay ? "ON" : "OFF"} — ${perDisplay ? "Captured one frame per projector aimed at that projector's pose direction (most diagnostic for finding which projector is misaligned)." : "Skipped per-display captures."}

## Files

- \`*_<direction>.png\` — theater-view screenshots. Two kinds:
  - \`*_front\` / \`*_right\` / \`*_back\` / \`*_left\` / \`*_up\` / \`*_down\` — cardinal axes
  - \`*_display-NN-<id>-<name>\` — one per projector, aimed at that projector's pose
- \`calibration-meta.json\` — full rig configuration at capture
  time (surface, displays, poses, warp kinds, capture options).

## Directions captured (${meta.directions.length})

### Cardinal (${cardinalDirs.length}/6)
${cardinalDirs.length ? cardinalDirs.map(d => "- **" + d.name + "** — yaw " + d.yawDeg.toFixed(1) + "°, pitch " + d.pitchDeg.toFixed(1) + "°").join("\n") : "_(none — coverage-aware filter excluded all cardinals)_"}

### Per-display (${perDisplayDirs.length})
${perDisplayDirs.length ? perDisplayDirs.map(d => "- **" + d.name + "** — yaw " + d.yawDeg.toFixed(1) + "°, pitch " + d.pitchDeg.toFixed(1) + "°").join("\n") : "_(per-display disabled or no displays in coverage)_"}

## Capture configurations (${configs.length})

${configs.map(c => "- " + c.label).join("\n")}

## How to read

For each capture, calibration verification guidelines:

- **Lines should connect across projector boundaries.** A clean
  edge means good calibration; shift/break means a projector's
  pose, FOV, or warp is off.
- **Beacon circles should center on cardinal axes** (red on +X,
  green on +Y, blue on +Z if WireframeCalibration is the source).
- **In per-display captures**, the targeted projector's coverage
  should be centered in the frame. Mismatches: rotation = pose
  yaw/pitch off; size = FOV off; barrel/pincushion = warp off.
- **Cell parity should alternate evenly** if Checkerboard is the
  source.

## Auto-analysis

A future Gamma Node release will feed this bundle (PNGs + meta JSON)
to a Claude API or Gemma 4 vision endpoint for automatic misalignment
scoring + per-display correction proposals (Δyaw, Δpitch, Δfov, warp
adjustments). The bundle format is designed to be self-contained for
this.
`
    );

    let filename = null;
    if (!(opts && opts.skipDownload)) {
      const zip = _writeZipArchive(files);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      filename = "gamma-calibration-" + ts + ".zip";
      _downloadBlob(new Blob([zip], { type: "application/zip" }), filename);
      console.log("[auto-capture] saved", filename, "(" + captures.length + " PNGs)");
    }
    return { captured, total, filename, captures, meta, files };
  } finally {
    restoreState();
  }
}

/* ------------ Phase 6.6.20.10 — AI calibration analysis -------------- *
 *
 * Closes the calibration loop: captures the rig (using
 * autoCaptureCalibration above with skipDownload), sends each
 * per-display PNG to the active AI provider (Claude API or Gemma 4
 * via transformers.js) along with the projector's expected pose +
 * FOV, parses the response into proposed corrections, and shows
 * a diff modal where the user picks which corrections to apply.
 *
 * Reuses the existing PROVIDERS infrastructure (binding 0 in the
 * existing AI panel for User DSP). API keys + model selection live
 * in the same gamma-editor-ai-settings-v1 localStorage slot.
 *
 * For 26-projector AlloSphere, this is 26 sequential vision API
 * calls — slow (~1-2 min total) but cheap and reliable. Batching
 * 26 images in one call hits message-size limits.
 */

function _arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  // Chunked to avoid stack overflow on large buffers.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

const _AI_CALIBRATION_SYSTEM_PROMPT =
`You are a multi-projector dome calibration expert. You analyze screenshots from a virtual multi-projector rig with a 3D wireframe calibration pattern (lat/long sphere grid + 3 axis-colored great circles + 3 cardinal-axis beacon circles).

Each capture is a WIDE-FOV (90° vertical) view from the rig's audience sweet-spot, AIMED at one projector's pose direction. The TARGET projector fills the central ~50% of the frame; ADJACENT projectors' coverage is visible at the EDGES of the frame. This lets you compare boundaries — your job is largely to check that the wireframe lines on this projector's edges connect cleanly to the neighbor projectors' edges visible alongside.

The wireframe pattern is rendered globally in world space; if pose / FOV / warp are perfectly calibrated, the lat/long lines should connect with no shift, the great circles should be unbroken curves, and the beacons should appear at consistent angles. Visible disconnects at projector boundaries are exactly what calibration is meant to fix.

Calibration cues:
- The CENTER of the frame should be where the projector aims. If the visible pattern's "center of mass" is offset from the screen center, that suggests a yaw / pitch error in the projector's pose.
- The 3 colored great circles (red=XZ/equator, green=XY, blue=YZ) should be straight curved lines, not broken or doubled. Breaks reveal pose mismatches with neighbors.
- The 3 beacons (red=+X, green=+Y, blue=+Z) appear in only one direction; their angular position relative to the frame center can be cross-checked against the projector's expected pose.
- Lat/long grid line spacing should look uniform; sudden jumps reveal warp mesh or FOV errors.

For each capture, output JSON ONLY (no prose, no code fences) with these fields:
{
  "deltaYawDeg":   <degrees, + = projector should rotate to its right>,
  "deltaPitchDeg": <degrees, + = projector should tilt up>,
  "deltaFovHDeg":  <degrees, + = wider horizontal FOV>,
  "deltaFovVDeg":  <degrees, + = wider vertical FOV>,
  "keystone": {
    "tlx": <NDC dx for top-left corner>,
    "tly": <NDC dy>,
    "trx": <NDC dx for top-right>,
    "try":  <NDC dy>,
    "blx": <NDC dx for bottom-left>,
    "bly": <NDC dy>,
    "brx": <NDC dx for bottom-right>,
    "bry": <NDC dy>
  },
  "confidence":    <0..1, your certainty in these corrections>,
  "reasoning":     "<one short sentence explaining what you saw>"
}

KEYSTONE CORNERS (AI v3): each corner of THIS projector's warp mesh
can shift by a small NDC offset (range ±2.0 covers the whole
framebuffer; ±0.02 is typical = ~1% of framebuffer = ~5 px at
1080p). Use keystone deltas to FIX MESH-LEVEL ALIGNMENT that pose
+ FOV alone can't:

  - If the wireframe lines on this projector's edge don't meet the
    next projector's edge cleanly (e.g., top edge lines are shifted
    right relative to the projector above), propose a small dx/dy
    shift for the top-left + top-right corners to align them.

  - If the projector's quad looks rotated relative to its
    neighbors (parallelogram / trapezoid), opposite corners need
    opposite shifts — e.g. tlx +0.005 and brx -0.005 rotates the
    quad slightly clockwise.

  - If pose+FOV deltas are 0 but you still see boundary artifacts,
    those are usually mesh-level — propose small keystone deltas.
    Don't propose pose to mask mesh issues.

Per-pass clamp: each keystone delta is clamped to ±0.02 NDC by the
iterative loop. So output realistic values in [-0.02, 0.02].

Use 0 for any axis you can't determine from this single view. Keep |delta| values SMALL and CONSERVATIVE — this calibration runs ITERATIVELY (multiple passes converging on the right answer), so single-pass deltas above ±0.5° will be clamped anyway. Better to suggest a small confident correction (±0.2°) and let the next pass refine, than overshoot in one pass and break neighbor agreement.

This is one projector in a 26-projector RING-based dome. Adjacent projectors in the SAME ring share the same nominal pitch. If you're tempted to suggest a big pitch correction (>1°), pause and ask "does this projector look more wrong than its neighbors would, or am I seeing the natural curvature of the wireframe pattern?" Default to small deltas.

SCOPE: this version of the calibration AI only proposes pose+FOV corrections — it does NOT edit warp meshes or Bezier patches. If you see visible artifacts that are NOT pose/FOV related (ghost-doubled great circles from warp-mesh interpolation drift, X-shapes at projector corners from quad-fragment aliasing, blurry boundaries from low-density warp meshes), output 0 deltas and explain in the reasoning field that "this artifact is mesh-related, not pose-related — user should bump WARP_MESH_DENSITY or hand-edit the warp mesh." Don't propose pose corrections to mask non-pose artifacts; that breaks neighbor agreement.

Even when proposing 0 deltas, the reasoning field should describe any visible artifacts you saw and explain why no pose correction is needed (calibration looks fine vs. artifacts are out of scope).`;

/* Phase 6.6.20.17 — AI v4 Bezier fine-tune system prompt.
 * Used for Phase 2 of the calibration flow, AFTER main pose/FOV/
 * keystone has converged. Asks the AI to identify residual mesh-
 * level alignment issues and propose specific Bezier control
 * point shifts to fix them. Sparse adjustments (max 6 per
 * display per pass) keep parameter space tractable. */
const _AI_BEZIER_FINETUNE_PROMPT =
`You are a multi-projector dome calibration expert. The rig has
already been globally aligned via pose + FOV + keystone-corner
adjustments. You are now doing FINE MESH-LEVEL TUNING of one
projector at a time, using Bezier control point shifts.

The wireframe pattern (grid + 3 colored great circles + 3 beacons)
is rendered in world space. The capture is a WIDE-FOV (90°
vertical) view aimed at this projector's pose direction. The
TARGET projector fills the central ~50% of the frame; ADJACENT
projectors' coverage is visible at the EDGES of the frame.

CRITICAL: be very conservative. Earlier passes of this calibration
flow turned out to propose hallucinated corrections that DEGRADED
the rig. Symptoms of hallucination: identical adjustments across
multiple displays, vague "slight edge bulges" reasoning, no
specific named feature in the image. Avoid these failure modes.

YOU MAY ONLY PROPOSE A NON-EMPTY bezierAdjustments LIST IF:

  1. You can describe in your reasoning a SPECIFIC boundary
     discontinuity by reference to a NAMED FEATURE in the image
     (e.g., "the red equator line breaks 4 px to the right at the
     boundary between this projector and its left neighbor").
  2. You see the SAME line on both projectors at the boundary,
     and they fail to meet.
  3. Your confidence is 0.7 or higher.

If any of those isn't true, output bezierAdjustments: [] and
confidence ≤ 0.6. The default rig is already well-calibrated;
"no changes needed" is the correct answer most of the time.

Indexing: 5 cols × 5 rows. col 0..4 = left → right.
row 0..4 = top → bottom. (0,0) = top-left, (4,4) = bottom-right.
Mid-edge points (col=2 row=0 = top-edge midpoint, col=4 row=2 =
right-edge midpoint, etc.) are the most useful for fixing edge
mismatches that corner adjustments alone can't reach. Interior
points (col 1..3, row 1..3) handle bulges in the middle of the
projected quad.

For each capture, output JSON ONLY:
{
  "bezierAdjustments": [
    {"col": 2, "row": 0, "dx": 0.005, "dy": 0},
    {"col": 0, "row": 2, "dx": 0,     "dy": 0.003},
    ... up to 6 adjustments total ...
  ],
  "confidence": <0..1>,
  "reasoning": "<one sentence>"
}

Each dx/dy is in NDC units. Per-pass clamp is ±0.015 NDC (~3-4 px
at 1080p). Output [] if you don't see any mesh-level issues to
fix. Don't propose corner adjustments here — those went through
the keystone phase already and should already be good.

Look for:
- Top edge of THIS projector's wireframe doesn't quite meet the
  bottom of the projector above → adjust top-row points (row=0).
- Mid-edge bulge: a horizontal grid line that bows inward/outward
  near one side → adjust the mid-edge control point.
- Interior wave: the wireframe within the projector is bowed in
  one place but flat elsewhere → propose a small interior point
  shift to compensate.

If everything looks aligned, output bezierAdjustments: [] and
confidence ≥ 0.7 with reasoning describing how good it looks.`;

async function analyzeCalibrationWithAI(opts) {
  const onProgress = (opts && opts.onProgress) || null;
  const onCapture  = (opts && opts.onCapture)  || null;
  // 6.6.20.17 — mode "main" (pose+FOV+keystone) or "bezier" (interior
  // control-point fine-tune). Different system prompt + different
  // parsing per mode; same per-display capture loop.
  const mode = (opts && opts.mode === "bezier") ? "bezier" : "main";
  const systemPrompt = mode === "bezier"
    ? _AI_BEZIER_FINETUNE_PROMPT
    : _AI_CALIBRATION_SYSTEM_PROMPT;

  // 6.6.20.20 — pre-flight: warn if no WireframeCalibration is
  // wired to a VisualOutput. The AI prompts describe a specific
  // wireframe pattern (red equator, RGB great circles, beacon
  // circles) — if the user has Checkerboard or some other shader
  // wired instead, captures show that content and the AI's
  // analysis is meaningless.
  const hasWireframe = (state.nodes || []).some(n => n.type === "WireframeCalibration");
  const wireframeWiredToVO = hasWireframe && (state.edges || []).some(e => {
    const from = (state.nodes || []).find(n => n.id === e.from.node);
    return from && from.type === "WireframeCalibration" && (state.edges || []).some(e2 =>
      e2.from.node === from.id && e2.to.port === "in" &&
      (state.nodes || []).find(n => n.id === e2.to.node && n.type === "VisualOutput")
    );
  });
  if (!hasWireframe || !wireframeWiredToVO) {
    const proceed = (typeof confirm === "function")
      ? confirm("AI calibration expects a WireframeCalibration node wired to your VisualOutputs (it's the visual target the AI prompts describe — red equator + RGB great circles + beacon circles).\n\nNone detected wired. The AI will still run, but the captures will show whatever you have wired to the VOs and the corrections may not match what the AI thinks it's seeing.\n\nProceed anyway?")
      : true;
    if (!proceed) throw new Error("AI calibration cancelled — wire a WireframeCalibration node to your VOs first.");
  }

  // Stage 1 — capture (in memory, no ZIP). aiMode=true so
  // autoCaptureCalibration suppresses Checkerboard mode-cycling
  // and uses the wider 90° capture FOV.
  if (onProgress) onProgress({ stage: "capture", current: 0, total: 1 });
  const cap = await autoCaptureCalibration({
    skipDownload: true,
    autoPrep:      true,
    coverageAware: true,
    perDisplay:    true,
    aiMode:        true,
    onProgress: (cur, total) => {
      if (onCapture) onCapture(cur, total);
    }
  });
  if (!cap || !cap.captures || !cap.meta) {
    throw new Error("Capture failed — no captures returned");
  }

  // Stage 2 — filter to per-display captures (the AI's primary input).
  // Cardinals are useful for human review but each shows the WHOLE
  // rig, which is hard for the AI to fault-localize per-projector.
  const perDisplayDirs = cap.meta.directions.filter(d => d.kind === "per-display");
  const perDisplayCaps = [];
  for (const dir of perDisplayDirs) {
    const f = cap.captures.find(c => c.filename.includes("_" + dir.name + ".png"));
    if (f) perDisplayCaps.push({ blob: f.blob, dir, display: cap.meta.displays[dir.displayIdx] });
  }
  if (perDisplayCaps.length === 0) {
    throw new Error("No per-display captures to analyze");
  }

  // Stage 3 — provider check.
  const provider = PROVIDERS[aiSettings.provider];
  if (!provider) throw new Error("No AI provider selected. Open the AI Settings panel and pick one.");
  if (provider.requiresKey && !aiSettings.anthropicKey) {
    throw new Error("API key required for " + aiSettings.provider + ". Set it in the AI Settings panel.");
  }
  if (!provider.supportsImage) {
    throw new Error("Selected provider doesn't support image input.");
  }

  // Stage 4 — iterate per-display, sending each capture to the AI.
  const corrections = [];
  const total = perDisplayCaps.length;
  for (let i = 0; i < total; i++) {
    const item = perDisplayCaps[i];
    const display = item.display;
    if (onProgress) onProgress({
      stage: "analyze", current: i + 1, total,
      displayIdx: display.idx,
      displayName: display.name
    });

    let resultEntry = {
      idx:         display.idx,
      displayId:   display.id,
      displayName: display.name,
      pose:        display.pose,
      fov:         display.fov,
      deltaYaw:   0, deltaPitch: 0, deltaFovH: 0, deltaFovV: 0,
      // Phase 6.6.20.16 — AI v3 keystone corner deltas (NDC).
      keystone:   { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 },
      // Phase 6.6.20.17 — AI v4 sparse Bezier control-point shifts.
      bezierAdjustments: [],
      confidence: 0, reasoning: "", error: null
    };

    try {
      const buf = await item.blob.arrayBuffer();
      const base64 = _arrayBufferToBase64(buf);

      const userText =
`Display ${display.idx} ("${display.name}", id=${display.id}).
Expected pose: yaw=${display.pose.yaw.toFixed(2)}°, pitch=${display.pose.pitch.toFixed(2)}°.
Expected FOV: ${display.fov.h.toFixed(1)}°(h) × ${display.fov.v.toFixed(1)}°(v).
The capture below shows what this projector's coverage region looks like when viewed from the rig sweet-spot, aimed at the projector's expected pose direction. Output JSON only.`;

      const response = await provider.call({
        system:      systemPrompt,
        user:        userText,
        model:       aiSettings.model,
        key:         aiSettings.anthropicKey,
        image:       base64,
        temperature: 0.1
      });

      // Extract first {...} JSON blob from the response — providers
      // sometimes wrap with prose despite "JSON ONLY" in the prompt.
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in response: " + response.slice(0, 100));
      const parsed = JSON.parse(jsonMatch[0]);
      resultEntry.deltaYaw   = Number.isFinite(parsed.deltaYawDeg)   ? parsed.deltaYawDeg   : 0;
      resultEntry.deltaPitch = Number.isFinite(parsed.deltaPitchDeg) ? parsed.deltaPitchDeg : 0;
      resultEntry.deltaFovH  = Number.isFinite(parsed.deltaFovHDeg)  ? parsed.deltaFovHDeg  : 0;
      resultEntry.deltaFovV  = Number.isFinite(parsed.deltaFovVDeg)  ? parsed.deltaFovVDeg  : 0;
      // Phase 6.6.20.16 — extract keystone corner deltas (AI v3).
      // Note: AI uses "try" but JS uses "try_" because try is a
      // reserved word — translate either spelling on parse.
      const ks = parsed.keystone || {};
      resultEntry.keystone.tlx  = Number.isFinite(ks.tlx)  ? ks.tlx  : 0;
      resultEntry.keystone.tly  = Number.isFinite(ks.tly)  ? ks.tly  : 0;
      resultEntry.keystone.trx  = Number.isFinite(ks.trx)  ? ks.trx  : 0;
      resultEntry.keystone.try_ = Number.isFinite(ks.try_) ? ks.try_
                               : Number.isFinite(ks.try)  ? ks.try   : 0;
      resultEntry.keystone.blx  = Number.isFinite(ks.blx)  ? ks.blx  : 0;
      resultEntry.keystone.bly  = Number.isFinite(ks.bly)  ? ks.bly  : 0;
      resultEntry.keystone.brx  = Number.isFinite(ks.brx)  ? ks.brx  : 0;
      resultEntry.keystone.bry  = Number.isFinite(ks.bry)  ? ks.bry  : 0;
      // Phase 6.6.20.17 — sparse Bezier control-point adjustments.
      if (Array.isArray(parsed.bezierAdjustments)) {
        for (const adj of parsed.bezierAdjustments) {
          if (!adj || typeof adj !== "object") continue;
          const col = Math.max(0, Math.min(4, Math.round(+adj.col || 0)));
          const row = Math.max(0, Math.min(4, Math.round(+adj.row || 0)));
          const dx = Number.isFinite(adj.dx) ? adj.dx : 0;
          const dy = Number.isFinite(adj.dy) ? adj.dy : 0;
          if (Math.abs(dx) < 1e-7 && Math.abs(dy) < 1e-7) continue;
          resultEntry.bezierAdjustments.push({ col, row, dx, dy });
          // Cap at 6 per display per pass.
          if (resultEntry.bezierAdjustments.length >= 6) break;
        }
      }
      resultEntry.confidence = Number.isFinite(parsed.confidence)    ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
      resultEntry.reasoning  = (typeof parsed.reasoning === "string") ? parsed.reasoning : "";
    } catch (e) {
      console.warn("[ai-calibration] display " + display.idx + " analysis failed:", e);
      resultEntry.error = e && e.message ? e.message : String(e);
    }
    corrections.push(resultEntry);
  }

  if (onProgress) onProgress({ stage: "done", current: total, total });
  return { corrections, meta: cap.meta };
}

/* Apply a list of corrections (yaw / pitch / FOV deltas per display)
 * to state.rig.displays. Pushes one history entry. Caller is
 * responsible for filtering corrections by the user's modal choices
 * before calling. */
function applyCalibrationCorrections(corrections) {
  if (!Array.isArray(corrections) || corrections.length === 0) return 0;
  if (!state.rig || !Array.isArray(state.rig.displays)) return 0;
  pushHistory("ai-calibration");
  let applied = 0;
  for (const c of corrections) {
    const display = state.rig.displays[c.idx];
    if (!display) continue;
    if (display.pose) {
      display.pose.yaw   = (display.pose.yaw   || 0) + (c.deltaYaw   || 0);
      display.pose.pitch = (display.pose.pitch || 0) + (c.deltaPitch || 0);
    }
    if (display.fov) {
      display.fov.h = Math.max(5, (display.fov.h || 90) + (c.deltaFovH || 0));
      display.fov.v = Math.max(5, (display.fov.v || 60) + (c.deltaFovV || 0));
    }
    // Phase 6.6.20.16 — keystone corner deltas accumulate into the
    // display's persistent keystoneCorners field. Auto-prep on the
    // next iteration applies them after auto-warp + auto-blend so
    // they survive the regenerate.
    if (c.keystone) {
      if (!display.keystoneCorners) {
        display.keystoneCorners = { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 };
      }
      const k = display.keystoneCorners;
      k.tlx  = (k.tlx  || 0) + (c.keystone.tlx  || 0);
      k.tly  = (k.tly  || 0) + (c.keystone.tly  || 0);
      k.trx  = (k.trx  || 0) + (c.keystone.trx  || 0);
      k.try_ = (k.try_ || 0) + (c.keystone.try_ || 0);
      k.blx  = (k.blx  || 0) + (c.keystone.blx  || 0);
      k.bly  = (k.bly  || 0) + (c.keystone.bly  || 0);
      k.brx  = (k.brx  || 0) + (c.keystone.brx  || 0);
      k.bry  = (k.bry  || 0) + (c.keystone.bry  || 0);
    }
    // Phase 6.6.20.17 — Bezier interior corrections. Each entry is
    // {col, row, dx, dy}; we lazy-init the 5×5 ctrl grid on first
    // adjustment, then accumulate into specific control points.
    // The grid is stored as deltas (identity = all zeros), so the
    // accumulated deltas survive auto-prep regenerations and apply
    // after keystone in the mesh pipeline.
    if (Array.isArray(c.bezierAdjustments) && c.bezierAdjustments.length > 0) {
      if (!display.bezierCorrections ||
          !Number.isInteger(display.bezierCorrections.cols) ||
          !Number.isInteger(display.bezierCorrections.rows) ||
          !Array.isArray(display.bezierCorrections.ctrl)) {
        // Lazy-init: 5×5 grid of zeros (cols=4, rows=4 → 25 control points)
        display.bezierCorrections = { cols: 4, rows: 4, ctrl: new Array(50).fill(0) };
      }
      const bc = display.bezierCorrections;
      const W = bc.cols + 1;
      for (const adj of c.bezierAdjustments) {
        const col = Math.max(0, Math.min(bc.cols, adj.col | 0));
        const row = Math.max(0, Math.min(bc.rows, adj.row | 0));
        const k = (row * W + col) * 2;
        bc.ctrl[k + 0] = (bc.ctrl[k + 0] || 0) + (adj.dx || 0);
        bc.ctrl[k + 1] = (bc.ctrl[k + 1] || 0) + (adj.dy || 0);
      }
    }
    if (Visual && Visual._warpCache) Visual._warpCache.delete(display.id);
    applied++;
  }
  if (state.rig.templateKey && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
    state.rig.templateKey = "custom";
  }
  renderProps && renderProps();
  render();
  return applied;
}

/* Phase 6.6.20.18 — build a diagnostic + fixes report for an
 * AI calibration run. Inputs:
 *   analysisResult.finalDiff — cumulative per-display deltas
 *   analysisResult.phase1    — phase 1 result (if present)
 *   analysisResult.phase2    — phase 2 result (if present)
 *
 * Output: { md: <string>, json: <object> } where md is human-
 * readable Markdown and json is the full structured data
 * (suitable for downstream analyzers / spreadsheet imports). */
function _buildAICalibrationReport(analysisResult) {
  const finalDiff = (analysisResult && analysisResult.finalDiff) || [];
  const phase1    = analysisResult && analysisResult.phase1;
  const phase2    = analysisResult && analysisResult.phase2;
  const ts = new Date().toISOString();

  // Helper: extract last-iteration AI reasoning per display.
  const reasoningFromPhase = (phase) => {
    const m = {};
    if (!phase || !phase.lastResult || !Array.isArray(phase.lastResult.corrections)) return m;
    for (const c of phase.lastResult.corrections) {
      m[c.idx] = {
        reasoning: c.reasoning || "",
        confidence: c.confidence || 0,
        error: c.error || null
      };
    }
    return m;
  };
  const phase1Reason = reasoningFromPhase(phase1);
  const phase2Reason = reasoningFromPhase(phase2);

  // Per-display rows for the JSON payload + Markdown table.
  const rows = finalDiff.map(c => {
    const k = c.keystone || {};
    const ksAbs = Math.abs(k.tlx || 0) + Math.abs(k.tly || 0) +
                  Math.abs(k.trx || 0) + Math.abs(k.try_ || 0) +
                  Math.abs(k.blx || 0) + Math.abs(k.bly || 0) +
                  Math.abs(k.brx || 0) + Math.abs(k.bry || 0);
    const bdCount = (c.bezierDiff && c.bezierDiff.count) || 0;
    const bdAbs   = (c.bezierDiff && c.bezierDiff.totalAbs) || 0;
    const changedPose = Math.abs(c.deltaYaw)   > 0.005 ||
                        Math.abs(c.deltaPitch) > 0.005 ||
                        Math.abs(c.deltaFovH)  > 0.005 ||
                        Math.abs(c.deltaFovV)  > 0.005;
    const changed = changedPose || ksAbs > 5e-4 || bdCount > 0;
    return {
      idx: c.idx,
      displayId:   c.displayId,
      displayName: c.displayName,
      pose: c.pose,                // baseline pose
      fov:  c.fov,
      poseFinal: {
        yaw:   (c.pose ? c.pose.yaw   : 0) + (c.deltaYaw   || 0),
        pitch: (c.pose ? c.pose.pitch : 0) + (c.deltaPitch || 0)
      },
      fovFinal: {
        h: (c.fov ? c.fov.h : 0) + (c.deltaFovH || 0),
        v: (c.fov ? c.fov.v : 0) + (c.deltaFovV || 0)
      },
      deltas: {
        yaw:   c.deltaYaw   || 0,
        pitch: c.deltaPitch || 0,
        fovH:  c.deltaFovH  || 0,
        fovV:  c.deltaFovV  || 0
      },
      keystone: {
        tlx: k.tlx || 0, tly: k.tly || 0,
        trx: k.trx || 0, try_: k.try_ || 0,
        blx: k.blx || 0, bly: k.bly || 0,
        brx: k.brx || 0, bry: k.bry || 0,
        absSum: ksAbs
      },
      bezier: c.bezierDiff || { count: 0, totalAbs: 0, perPoint: [] },
      reasoning: {
        phase1: phase1Reason[c.idx] || null,
        phase2: phase2Reason[c.idx] || null
      },
      changed
    };
  });

  // Aggregate counts.
  const changedCount = rows.filter(r => r.changed).length;
  const erroredCount = rows.filter(r => (r.reasoning.phase1 && r.reasoning.phase1.error) ||
                                         (r.reasoning.phase2 && r.reasoning.phase2.error)).length;

  const json = {
    app: "Gamma Node",
    version: APP_VERSION,
    timestamp: ts,
    summary: {
      iterations: {
        phase1: phase1 ? phase1.iterations : 0,
        phase2: phase2 ? phase2.iterations : 0,
        total:  (phase1 ? phase1.iterations : 0) + (phase2 ? phase2.iterations : 0)
      },
      totalCorrectionsApplied: analysisResult.totalCorrections || 0,
      displaysChanged: changedCount,
      displaysErrored: erroredCount,
      totalDisplays: rows.length
    },
    rig: state.rig ? {
      templateKey: state.rig.templateKey,
      surface:     state.rig.surface,
      sweetSpot:   state.rig.sweetSpot,
      shaderCenterYaw:   state.rig.shaderCenterYaw   || 0,
      shaderCenterPitch: state.rig.shaderCenterPitch || 0
    } : null,
    displays: rows
  };

  // Build the Markdown report.
  const md = (() => {
    const lines = [];
    lines.push("# AI Calibration Report");
    lines.push("");
    lines.push("Generated " + ts + " by Gamma Node v" + APP_VERSION + ".");
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push("- **Phase 1** (pose+FOV+keystone): " + (phase1 ? phase1.iterations : 0) + " iteration(s)");
    lines.push("- **Phase 2** (Bezier interior): " + (phase2 ? phase2.iterations : 0) + " iteration(s)");
    lines.push("- **Displays changed:** " + changedCount + " / " + rows.length);
    lines.push("- **Errors:** " + erroredCount);
    lines.push("- **Total corrections applied:** " + (analysisResult.totalCorrections || 0));
    lines.push("");
    if (state.rig && state.rig.surface) {
      lines.push("## Rig configuration");
      lines.push("");
      lines.push("- Surface type: `" + state.rig.surface.type + "`");
      if (state.rig.surface.type === "swept") {
        const p = state.rig.surface.profile || {};
        const path = state.rig.surface.path || {};
        lines.push("  - Profile: " + p.kind + " radius=" + p.radius +
                   (p.kind === "arc" ? ", pitch [" + p.pitchStart + "°, " + p.pitchEnd + "°]"
                                     : ", y [" + p.yMin + ", " + p.yMax + "]"));
        lines.push("  - Path: yaw [" + path.yawStart + "°, " + path.yawEnd + "°]");
      }
      lines.push("- Sweet spot: " + JSON.stringify(state.rig.sweetSpot));
      lines.push("");
    }
    lines.push("## Per-display details");
    lines.push("");
    for (const r of rows) {
      lines.push("### Display " + r.idx + " — `" + (r.displayId || "") + "`" +
                 (r.displayName ? ' "' + r.displayName + '"' : "") +
                 (r.changed ? "" : "  *(no changes)*"));
      lines.push("");
      lines.push("**Pose**: yaw " + r.pose.yaw.toFixed(2) + "° → " + r.poseFinal.yaw.toFixed(2) +
                 "° (Δ " + (r.deltas.yaw >= 0 ? "+" : "") + r.deltas.yaw.toFixed(3) + "°), " +
                 "pitch " + r.pose.pitch.toFixed(2) + "° → " + r.poseFinal.pitch.toFixed(2) +
                 "° (Δ " + (r.deltas.pitch >= 0 ? "+" : "") + r.deltas.pitch.toFixed(3) + "°)");
      lines.push("");
      if (Math.abs(r.deltas.fovH) > 0.005 || Math.abs(r.deltas.fovV) > 0.005) {
        lines.push("**FOV**: " + r.fov.h.toFixed(2) + "° × " + r.fov.v.toFixed(2) +
                   "° → " + r.fovFinal.h.toFixed(2) + "° × " + r.fovFinal.v.toFixed(2) + "°");
        lines.push("");
      }
      if (r.keystone.absSum > 5e-4) {
        const k = r.keystone;
        const fmt = v => (v >= 0 ? "+" : "") + v.toFixed(4);
        lines.push("**Keystone corners** (NDC):");
        lines.push("  - TL = (" + fmt(k.tlx) + ", " + fmt(k.tly) + ")");
        lines.push("  - TR = (" + fmt(k.trx) + ", " + fmt(k.try_) + ")");
        lines.push("  - BL = (" + fmt(k.blx) + ", " + fmt(k.bly) + ")");
        lines.push("  - BR = (" + fmt(k.brx) + ", " + fmt(k.bry) + ")");
        lines.push("");
      }
      if (r.bezier && r.bezier.count > 0 && Array.isArray(r.bezier.perPoint)) {
        lines.push("**Bezier control points** (5×5 grid, " + r.bezier.count + " adjusted, Σ|Δ|=" +
                   r.bezier.totalAbs.toFixed(4) + " NDC):");
        for (const pt of r.bezier.perPoint) {
          const fmt = v => (v >= 0 ? "+" : "") + v.toFixed(5);
          lines.push("  - (col=" + pt.col + ", row=" + pt.row + ") = (" + fmt(pt.dx) + ", " + fmt(pt.dy) + ")");
        }
        lines.push("");
      }
      if (r.reasoning.phase1) {
        const p1 = r.reasoning.phase1;
        if (p1.error) {
          lines.push("> **Phase 1 ERROR**: " + p1.error);
        } else if (p1.reasoning) {
          lines.push("> **Phase 1 AI** (conf " + (p1.confidence * 100).toFixed(0) + "%): " + p1.reasoning);
        }
        lines.push("");
      }
      if (r.reasoning.phase2) {
        const p2 = r.reasoning.phase2;
        if (p2.error) {
          lines.push("> **Phase 2 ERROR**: " + p2.error);
        } else if (p2.reasoning) {
          lines.push("> **Phase 2 AI** (conf " + (p2.confidence * 100).toFixed(0) + "%): " + p2.reasoning);
        }
        lines.push("");
      }
    }
    if (erroredCount > 0) {
      lines.push("## Errors");
      lines.push("");
      lines.push(erroredCount + " display(s) had at least one phase with an API error. Review the per-display sections above for the specific error messages, then check AI Settings (User DSP tab → ⚙) for provider/key issues.");
      lines.push("");
    }
    return lines.join("\n");
  })();

  return { md, json };
}

/* Phase 6.6.20.18 — package the report into a ZIP and download. */
function exportAICalibrationReport(analysisResult) {
  const report = _buildAICalibrationReport(analysisResult);
  const files = {
    "report.md":         new TextEncoder().encode(report.md),
    "corrections.json":  new TextEncoder().encode(JSON.stringify(report.json, null, 2))
  };
  const zip = _writeZipArchive(files);
  const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fname = "ai-calibration-report-" + ts + ".zip";
  _downloadBlob(new Blob([zip], { type: "application/zip" }), fname);
  console.log("[ai-calibration-report] saved " + fname);
  return fname;
}

/* Show the AI corrections diff modal. Promise resolves with the
 * filtered list of corrections the user approved (or [] on cancel). */
function showAICalibrationModal(analysisResult) {
  return new Promise((resolve) => {
    const corrections = (analysisResult && analysisResult.corrections) || [];
    const overlay = document.getElementById("ai-calibration-modal");
    const list    = document.getElementById("ai-calibration-list");
    if (!overlay || !list) {
      resolve([]);
      return;
    }
    list.innerHTML = "";
    // Sort by confidence descending so the high-confidence
    // corrections (the ones the user is most likely to apply) sit
    // at the top of the modal.
    const sorted = corrections.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    sorted.forEach((c, listIdx) => {
      const row = document.createElement("div");
      row.className = "ai-calib-row";
      const hasError = !!c.error;
      const conf = c.confidence || 0;
      const confColor = hasError ? "rgba(220, 100, 100, 1)"
                      : conf > 0.8 ? "rgba(100, 220, 130, 1)"
                      : conf > 0.5 ? "rgba(220, 200, 100, 1)"
                      :              "rgba(220, 130, 100, 1)";
      // 6.6.20.16 — keystone deltas (NDC) also count toward
      // "significant" for pre-checking the row.
      const k = c.keystone || {};
      const ksSum = Math.abs(k.tlx || 0) + Math.abs(k.tly || 0) +
                    Math.abs(k.trx || 0) + Math.abs(k.try_ || 0) +
                    Math.abs(k.blx || 0) + Math.abs(k.bly || 0) +
                    Math.abs(k.brx || 0) + Math.abs(k.bry || 0);
      const bdSum = (c.bezierDiff && c.bezierDiff.totalAbs) || 0;
      const significant = !hasError &&
        (Math.abs(c.deltaYaw)   > 0.05 || Math.abs(c.deltaPitch) > 0.05 ||
         Math.abs(c.deltaFovH)  > 0.05 || Math.abs(c.deltaFovV)  > 0.05 ||
         ksSum > 0.001 || bdSum > 0.001);
      const checked = significant && conf >= 0.5 ? " checked" : "";
      const fmtDelta = (x, label) => {
        const v = (x || 0);
        if (Math.abs(v) < 0.005) return "";
        const sign = v > 0 ? "+" : "";
        return ' <span class="ai-calib-delta" data-label="' + label + '">' +
               sign + v.toFixed(2) + "° " + label + "</span>";
      };
      const fmtKs = (x, label) => {
        const v = (x || 0);
        if (Math.abs(v) < 0.0005) return "";
        const sign = v > 0 ? "+" : "";
        return ' <span class="ai-calib-delta" data-label="' + label + '">' +
               sign + v.toFixed(4) + " " + label + "</span>";
      };
      const ksLine = ksSum > 0.0005
        ? '<div class="ai-calib-deltas" style="opacity:0.85">keystone:' +
            fmtKs(k.tlx, "TLx") + fmtKs(k.tly, "TLy") +
            fmtKs(k.trx, "TRx") + fmtKs(k.try_, "TRy") +
            fmtKs(k.blx, "BLx") + fmtKs(k.bly, "BLy") +
            fmtKs(k.brx, "BRx") + fmtKs(k.bry, "BRy") +
          '</div>'
        : "";
      // 6.6.20.17 — Bezier diff summary. Don't enumerate every
      // changed control point (could be 25 entries); just show the
      // count + max delta so the user knows fine-tune touched this
      // display.
      const bd = c.bezierDiff;
      const bdLine = (bd && bd.count > 0)
        ? '<div class="ai-calib-deltas" style="opacity:0.85">bezier: ' +
            bd.count + ' control point' + (bd.count === 1 ? '' : 's') +
            ' adjusted (Σ|Δ| = ' + bd.totalAbs.toFixed(4) + ' NDC)</div>'
        : "";
      const beforeAfterPose = "yaw " + (c.pose ? c.pose.yaw.toFixed(2) : "?") +
                              "° → " + ((c.pose ? c.pose.yaw : 0) + (c.deltaYaw || 0)).toFixed(2) +
                              "°&nbsp;&nbsp;|&nbsp;&nbsp;pitch " +
                              (c.pose ? c.pose.pitch.toFixed(2) : "?") + "° → " +
                              ((c.pose ? c.pose.pitch : 0) + (c.deltaPitch || 0)).toFixed(2) + "°";
      const beforeAfterFov  = "FOV " + (c.fov ? c.fov.h.toFixed(1) : "?") + "° → " +
                              ((c.fov ? c.fov.h : 0) + (c.deltaFovH || 0)).toFixed(1) + "°&nbsp;×&nbsp;" +
                              (c.fov ? c.fov.v.toFixed(1) : "?") + "° → " +
                              ((c.fov ? c.fov.v : 0) + (c.deltaFovV || 0)).toFixed(1) + "°";
      row.innerHTML =
`<label class="ai-calib-check">
  <input type="checkbox" data-correction-idx="${c.idx}"${checked}${hasError ? " disabled" : ""}>
  <span class="ai-calib-display-name">Display ${c.idx} (${escapeText(c.displayName || "")})</span>
</label>
<div class="ai-calib-deltas">${fmtDelta(c.deltaYaw, "yaw")}${fmtDelta(c.deltaPitch, "pitch")}${fmtDelta(c.deltaFovH, "fovH")}${fmtDelta(c.deltaFovV, "fovV")}${significant ? "" : ' <span class="ai-calib-delta">(no change proposed)</span>'}</div>
${ksLine}
${bdLine}
<div class="ai-calib-detail">${beforeAfterPose}<br>${beforeAfterFov}</div>
<div class="ai-calib-confidence" style="color: ${confColor}">${hasError ? "ERROR: " + escapeText(c.error) : ("Confidence " + (conf * 100).toFixed(0) + "% — " + escapeText(c.reasoning || "(no reasoning)"))}</div>`;
      list.appendChild(row);
    });
    overlay.style.display = "flex";

    const close = (apply) => {
      overlay.style.display = "none";
      if (!apply) { resolve([]); return; }
      const checks = list.querySelectorAll('input[type="checkbox"][data-correction-idx]:checked');
      const selectedIdxs = new Set();
      checks.forEach(c => selectedIdxs.add(parseInt(c.dataset.correctionIdx, 10)));
      resolve(corrections.filter(c => selectedIdxs.has(c.idx) && !c.error));
    };

    const applyBtn  = document.getElementById("ai-calibration-apply");
    const cancelBtn = document.getElementById("ai-calibration-cancel");
    const closeBtn  = document.getElementById("ai-calibration-close");
    const selectAll = document.getElementById("ai-calibration-select-all");
    const selectNone = document.getElementById("ai-calibration-select-none");
    const exportBtn = document.getElementById("ai-calibration-export");
    const onApply  = () => close(true);
    const onCancel = () => close(false);
    const onAll    = () => list.querySelectorAll('input[type="checkbox"][data-correction-idx]:not(:disabled)').forEach(c => c.checked = true);
    const onNone   = () => list.querySelectorAll('input[type="checkbox"][data-correction-idx]').forEach(c => c.checked = false);
    // Phase 6.6.20.18 — export diagnostic + fixes report. Generates
    // a ZIP with report.md + corrections.json. Doesn't dismiss the
    // modal — user can still apply / cancel after exporting.
    const onExport = () => {
      try {
        const fname = exportAICalibrationReport(analysisResult);
        const orig = exportBtn.textContent;
        exportBtn.textContent = "Saved " + fname.split("-").slice(-2).join("-").replace(".zip", "");
        exportBtn.disabled = true;
        setTimeout(() => {
          exportBtn.textContent = orig;
          exportBtn.disabled = false;
        }, 1800);
      } catch (e) {
        console.error("[ai-calibration-report] export failed:", e);
        alert("Could not export report:\n\n" + (e && e.message ? e.message : String(e)));
      }
    };
    if (applyBtn)  applyBtn.onclick  = onApply;
    if (cancelBtn) cancelBtn.onclick = onCancel;
    if (closeBtn)  closeBtn.onclick  = onCancel;
    if (selectAll) selectAll.onclick = onAll;
    if (selectNone) selectNone.onclick = onNone;
    if (exportBtn) exportBtn.onclick = onExport;
  });
}

/* Phase 6.6.20.13 — AI calibration v2 (iterative converge).
 *
 * Single-pass calibration breaks ring symmetry: the AI sees each
 * projector independently, suggests a unique correction per
 * projector, and adjacent projectors that previously shared exact
 * ring poses now diverge. The user reported this exact failure
 * mode ("the lat/long grid is now severely fragmented").
 *
 * Iterative fix: cap per-pass deltas tightly (default ±0.5°), then
 * recapture and re-analyze. Each pass tightens. Adjacent-projector
 * mismatches don't compound across passes because each step is
 * smaller than the projector overlap region. Converges to typically
 * <0.2° error in 3-5 passes.
 *
 * Returns { iterations, totalCorrections, finalDiff }, where
 * finalDiff is the cumulative baseline → current change (so the
 * user can review + revert any drift they don't like).
 */
async function runAICalibrationIterative(opts) {
  const maxIters = (opts && Number.isFinite(opts.maxIterations)) ? opts.maxIterations : 5;
  const maxDelta = (opts && Number.isFinite(opts.maxDeltaPerPass)) ? opts.maxDeltaPerPass : 0.5;
  const stopThreshold = (opts && Number.isFinite(opts.stopThreshold)) ? opts.stopThreshold : 0.15;
  const onStatus = (opts && opts.onStatus) || null;
  // 6.6.20.17 — mode: "main" (pose+FOV+keystone) or "bezier" (sparse
  // interior adjustments). Bezier mode runs as Phase 2 after main
  // converges, with a different prompt + tighter clamp.
  const mode = (opts && opts.mode === "bezier") ? "bezier" : "main";
  const isBezier = mode === "bezier";
  const bezierMaxDelta = (opts && Number.isFinite(opts.bezierMaxDeltaPerPass)) ? opts.bezierMaxDeltaPerPass : 0.015;

  // Snapshot baseline poses + keystone so the final diff modal
  // shows cumulative changes from the user's pre-AI rig state.
  const cloneKC = (k) => (k ? {
    tlx: k.tlx || 0, tly: k.tly || 0,
    trx: k.trx || 0, try_: k.try_ || 0,
    blx: k.blx || 0, bly: k.bly || 0,
    brx: k.brx || 0, bry: k.bry || 0
  } : { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 });
  const baseline = (state.rig.displays || []).map((d, idx) => d ? {
    idx,
    id:   d.id,
    name: d.name,
    yaw:   d.pose ? (d.pose.yaw   || 0) : 0,
    pitch: d.pose ? (d.pose.pitch || 0) : 0,
    fovH:  d.fov  ? (d.fov.h      || 90) : 90,
    fovV:  d.fov  ? (d.fov.v      || 60) : 60,
    keystoneCorners: cloneKC(d.keystoneCorners),
    // 6.6.20.17 — snapshot Bezier corrections grid (deep copy of
    // ctrl float array) so cumulative diff captures fine-tune
    // changes too. null if no Bezier corrections set.
    bezierCorrections: d.bezierCorrections
      ? { cols: d.bezierCorrections.cols, rows: d.bezierCorrections.rows,
          ctrl: Array.isArray(d.bezierCorrections.ctrl) ? d.bezierCorrections.ctrl.slice() : [] }
      : null
  } : null);

  let iterCount = 0;
  let totalCorrections = 0;
  let lastResult = null;

  for (let iter = 0; iter < maxIters; iter++) {
    iterCount = iter + 1;
    if (onStatus) onStatus("Iteration " + iterCount + "/" + maxIters + " — capturing...");
    const result = await analyzeCalibrationWithAI({
      mode,
      onProgress: (p) => {
        if (!onStatus) return;
        const phase = isBezier ? "Phase 2 (Bezier)" : "Phase 1 (pose+FOV+keystone)";
        if (p.stage === "capture") onStatus(phase + " — iter " + iterCount + " — capturing");
        else if (p.stage === "analyze") onStatus(phase + " — iter " + iterCount + " — AI analyzing " + p.current + "/" + p.total);
      }
    });
    lastResult = result;

    // Clamp + filter to "significant" corrections.
    // Pose/FOV deltas: ±maxDelta degrees (default 0.5°).
    // Keystone deltas: ±keystoneMaxDelta NDC (default 0.02 = ~5 px @ 1080p).
    // Bezier deltas: ±bezierMaxDelta NDC (default 0.015 = ~3-4 px).
    const keystoneMaxDelta = 0.02;
    let totalDeltaSum = 0;
    let significantCount = 0;
    const clamp = (v, m) => Math.max(-m, Math.min(m, v || 0));
    const clamped = (result.corrections || [])
      .filter(c => !c.error)
      .map(c => {
        // In bezier mode we ignore pose/FOV/keystone (the AI doesn't
        // propose those in this phase); leave them at 0 so apply
        // skips them.
        const cy = isBezier ? 0 : clamp(c.deltaYaw,   maxDelta);
        const cp = isBezier ? 0 : clamp(c.deltaPitch, maxDelta);
        const ch = isBezier ? 0 : clamp(c.deltaFovH,  maxDelta);
        const cv = isBezier ? 0 : clamp(c.deltaFovV,  maxDelta);
        const ks = c.keystone || {};
        const k = isBezier
          ? { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 }
          : {
              tlx:  clamp(ks.tlx,  keystoneMaxDelta),
              tly:  clamp(ks.tly,  keystoneMaxDelta),
              trx:  clamp(ks.trx,  keystoneMaxDelta),
              try_: clamp(ks.try_, keystoneMaxDelta),
              blx:  clamp(ks.blx,  keystoneMaxDelta),
              bly:  clamp(ks.bly,  keystoneMaxDelta),
              brx:  clamp(ks.brx,  keystoneMaxDelta),
              bry:  clamp(ks.bry,  keystoneMaxDelta)
            };
        // Bezier adjustments: clamped per-entry, dropped if below
        // 5e-4 NDC (~0.25 px). Phase 6.6.20.21: also require AI
        // confidence ≥ 0.7 to apply ANY bezier adjustments — the
        // hallucination failure mode (uniform "slight edge bulge"
        // across all displays at confidence 0.75) was tipped over
        // by the threshold being too lenient. Bumped to 0.7 so
        // generic boilerplate at 0.5-0.65 confidence gets dropped.
        const conf = Number.isFinite(c.confidence) ? c.confidence : 0.5;
        const ba = isBezier && Array.isArray(c.bezierAdjustments) && conf >= 0.7
          ? c.bezierAdjustments.map(adj => ({
              col:  Math.max(0, Math.min(4, adj.col | 0)),
              row:  Math.max(0, Math.min(4, adj.row | 0)),
              dx:   clamp(adj.dx, bezierMaxDelta),
              dy:   clamp(adj.dy, bezierMaxDelta)
            })).filter(adj => Math.abs(adj.dx) > 5e-4 || Math.abs(adj.dy) > 5e-4)
          : [];
        const poseMag = Math.abs(cy) + Math.abs(cp) + Math.abs(ch) + Math.abs(cv);
        const ksMag = (Math.abs(k.tlx) + Math.abs(k.tly) + Math.abs(k.trx) + Math.abs(k.try_) +
                       Math.abs(k.blx) + Math.abs(k.bly) + Math.abs(k.brx) + Math.abs(k.bry)) * 100;
        const baMag = ba.reduce((s, adj) => s + (Math.abs(adj.dx) + Math.abs(adj.dy)) * 100, 0);
        const m = poseMag + ksMag + baMag;
        if (m > 0.08) significantCount++;
        totalDeltaSum += m;
        return Object.assign({}, c, {
          deltaYaw: cy, deltaPitch: cp, deltaFovH: ch, deltaFovV: cv,
          keystone: k,
          bezierAdjustments: ba
        });
      });

    const meanDelta = clamped.length > 0 ? totalDeltaSum / clamped.length / 4 : 0;
    if (onStatus) onStatus("Iter " + iterCount + " — applying " + significantCount + " corrections (mean Δ=" + meanDelta.toFixed(3) + "°)");

    if (significantCount === 0) {
      console.log("[ai-iterative] no significant corrections at iter " + iterCount + " — converged");
      break;
    }

    // Apply the clamped corrections (only significant ones).
    // Pose threshold: 0.02°. Keystone/Bezier threshold: 5e-4 NDC.
    const significant = clamped.filter(c => {
      if (Math.abs(c.deltaYaw)   > 0.02) return true;
      if (Math.abs(c.deltaPitch) > 0.02) return true;
      if (Math.abs(c.deltaFovH)  > 0.02) return true;
      if (Math.abs(c.deltaFovV)  > 0.02) return true;
      const k = c.keystone;
      if (k && (Math.abs(k.tlx)  > 5e-4 || Math.abs(k.tly)  > 5e-4 ||
                Math.abs(k.trx)  > 5e-4 || Math.abs(k.try_) > 5e-4 ||
                Math.abs(k.blx)  > 5e-4 || Math.abs(k.bly)  > 5e-4 ||
                Math.abs(k.brx)  > 5e-4 || Math.abs(k.bry)  > 5e-4)) return true;
      // Bezier adjustments are already filtered to >5e-4 in the
      // clamp step, so any non-empty list means significant.
      return Array.isArray(c.bezierAdjustments) && c.bezierAdjustments.length > 0;
    });
    const applied = applyCalibrationCorrections(significant);
    totalCorrections += applied;

    // Convergence check: average per-axis delta below threshold.
    if (meanDelta < stopThreshold) {
      console.log("[ai-iterative] converged at iter " + iterCount + " (mean Δ=" + meanDelta.toFixed(3) + "°)");
      break;
    }
  }

  // Build cumulative diff: baseline → current.
  const finalDiff = baseline.filter(b => b).map(b => {
    const display = state.rig.displays[b.idx];
    if (!display) return null;
    const curYaw   = display.pose ? (display.pose.yaw   || 0) : 0;
    const curPitch = display.pose ? (display.pose.pitch || 0) : 0;
    const curFovH  = display.fov  ? (display.fov.h      || 90) : 90;
    const curFovV  = display.fov  ? (display.fov.v      || 60) : 60;
    const curKC = display.keystoneCorners || {};
    const baseKC = b.keystoneCorners || {};
    return {
      idx:         b.idx,
      displayId:   b.id,
      displayName: b.name,
      pose:        { yaw: b.yaw, pitch: b.pitch },
      fov:         { h: b.fovH, v: b.fovV },
      deltaYaw:    curYaw   - b.yaw,
      deltaPitch:  curPitch - b.pitch,
      deltaFovH:   curFovH  - b.fovH,
      deltaFovV:   curFovV  - b.fovV,
      keystone: {
        tlx:  (curKC.tlx  || 0) - (baseKC.tlx  || 0),
        tly:  (curKC.tly  || 0) - (baseKC.tly  || 0),
        trx:  (curKC.trx  || 0) - (baseKC.trx  || 0),
        try_: (curKC.try_ || 0) - (baseKC.try_ || 0),
        blx:  (curKC.blx  || 0) - (baseKC.blx  || 0),
        bly:  (curKC.bly  || 0) - (baseKC.bly  || 0),
        brx:  (curKC.brx  || 0) - (baseKC.brx  || 0),
        bry:  (curKC.bry  || 0) - (baseKC.bry  || 0)
      },
      // 6.6.20.17 — Bezier diff: count of control points changed
      // and total absolute delta (NDC). Per-point detail kept for
      // revert.
      bezierDiff: (() => {
        const baseBC = b.bezierCorrections;
        const curBC  = display.bezierCorrections;
        if (!baseBC && !curBC) return { count: 0, totalAbs: 0, perPoint: null };
        const cols = (curBC && curBC.cols) || (baseBC && baseBC.cols) || 4;
        const rows = (curBC && curBC.rows) || (baseBC && baseBC.rows) || 4;
        const N = (cols + 1) * (rows + 1) * 2;
        const baseCtrl = (baseBC && Array.isArray(baseBC.ctrl)) ? baseBC.ctrl : new Array(N).fill(0);
        const curCtrl  = (curBC  && Array.isArray(curBC.ctrl))  ? curBC.ctrl  : new Array(N).fill(0);
        let count = 0, totalAbs = 0;
        const perPoint = [];
        for (let pi = 0; pi < (cols + 1) * (rows + 1); pi++) {
          const dx = (curCtrl[pi*2 + 0] || 0) - (baseCtrl[pi*2 + 0] || 0);
          const dy = (curCtrl[pi*2 + 1] || 0) - (baseCtrl[pi*2 + 1] || 0);
          if (Math.abs(dx) > 1e-5 || Math.abs(dy) > 1e-5) {
            count++;
            totalAbs += Math.abs(dx) + Math.abs(dy);
            perPoint.push({ idx: pi, col: pi % (cols+1), row: (pi / (cols+1)) | 0, dx, dy });
          }
        }
        return { count, totalAbs, perPoint, cols, rows };
      })(),
      confidence:  1.0,
      reasoning:   "Cumulative iterative correction over " + iterCount + " pass(es)",
      error:       null
    };
  }).filter(Boolean);

  return {
    iterations: iterCount,
    totalCorrections,
    finalDiff,
    lastResult,                              // last analyzeCalibrationWithAI return — has per-display errors
    lastMeta: lastResult ? lastResult.meta : null
  };
}

/* Phase 6.6.20.21 — wipe all AI calibration state from the rig.
 * Returns each display to baseline pose+FOV (per current rig
 * template), zeros keystoneCorners, drops bezierCorrections, and
 * re-runs auto-warp + auto-blend so the visible mesh state matches.
 *
 * Used when AI calibration produced a worse result and the user
 * wants to start over from a clean rig. Doesn't touch custom
 * (hand-edited) warp meshes — those are sacred per the existing
 * _isCustom check.
 *
 * Confirmation dialog by default; pass {silent: true} to skip. */
function resetAICalibration(opts) {
  if (!state.rig || !Array.isArray(state.rig.displays)) return 0;
  const silent = !!(opts && opts.silent);
  if (!silent) {
    const ok = (typeof confirm === "function")
      ? confirm("Reset all AI calibration corrections?\n\n" +
                "This will:\n" +
                "  • Zero every display's keystoneCorners (8 NDC offsets per display)\n" +
                "  • Drop every display's bezierCorrections (5×5 Bezier control grid)\n" +
                "  • Replace every display's warp mesh with a fresh Auto-blend\n" +
                "    (hard-cuts) mesh — identity NDC positions + projector-overlap\n" +
                "    alpha assignment, so every world point is rendered by exactly\n" +
                "    one projector and adjacent displays don't double up at the\n" +
                "    boundaries\n\n" +
                "Pose / FOV are NOT reverted (re-pick the rig template for that).\n" +
                "Custom hand-edited warp meshes are preserved.\n\n" +
                "Continue?")
      : true;
    if (!ok) return 0;
  }
  pushHistory("ai-calibration-reset");
  let cleaned = 0;
  // 6.6.20.23 — verbose logging so user can verify in devtools that
  // the right code path is running (vs. an old cached version of
  // the page). If they see "v0.1.90 reset starting" in console, the
  // fix is live; if they see no log line, hard-refresh (Ctrl+Shift+R).
  console.log("[ai-calibration-reset] v0.1.90 reset starting — " +
              state.rig.displays.length + " display(s)");
  for (const d of state.rig.displays) {
    if (!d) continue;
    // Custom (hand-edited) meshes are sacred — leave them.
    const isCustom = d.warpMesh && d.warpMesh._isCustom;
    let hadAny = false;
    if (d.keystoneCorners) {
      const k = d.keystoneCorners;
      if (Math.abs(k.tlx || 0) > 1e-6 || Math.abs(k.tly || 0) > 1e-6 ||
          Math.abs(k.trx || 0) > 1e-6 || Math.abs(k.try_ || 0) > 1e-6 ||
          Math.abs(k.blx || 0) > 1e-6 || Math.abs(k.bly || 0) > 1e-6 ||
          Math.abs(k.brx || 0) > 1e-6 || Math.abs(k.bry || 0) > 1e-6) {
        hadAny = true;
      }
      d.keystoneCorners = { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 };
    }
    if (d.bezierCorrections) {
      hadAny = true;
      d.bezierCorrections = null;
    }
    // 6.6.20.22 — KEY FIX: actually null out the warp mesh too. The
    // previous reset re-ran Auto-warp + Auto-blend, which generated
    // a fresh 128×128 mesh — but auto-warp combined with the
    // curved-screen-projection added in 6.6.20.1 produces a DOUBLE
    // WARP (theater raycasts vertex positions onto the sphere AND
    // auto-warp remaps source UVs for audience-correctness, which
    // was designed for the OLD flat-quad theater). The double-warp
    // is what causes adjacent projectors' content to disagree at
    // boundaries — the visible "thick green line stacking" the
    // user observed.
    //
    // True clean state = warpMesh: null. Theater then renders via
    // the curved-screen-projection alone (8×8 identity mesh per
    // display, vertices on the sphere, source UV = identity grid).
    // The wireframe shader is rendered correctly per display and
    // the lines actually meet at projector boundaries because
    // there's no UV remapping to misalign them.
    if (!isCustom && d.warpMesh) {
      hadAny = true;
      d.warpMesh = null;
    }
    if (hadAny) cleaned++;
    if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
  }
  // 6.6.20.23 — RE-RUN Auto-blend (hard cuts) after the wipe.
  // We DO NOT re-run Auto-warp (that was the audience-equirect UV
  // remapping that double-warped against curved-screen projection).
  // But Auto-blend is structurally different: _makeScreenSpaceBlendMesh
  // only writes per-vertex ALPHA values; the NDC positions stay on
  // the identity grid. No UV remapping, no double-warp.
  //
  // Without auto-blend, every projector renders its full framebuffer
  // at intensity 1.0. In overlap regions (any rig with adjacent
  // projectors covering the same world point — cylinders, dome,
  // AlloSphere) you get N copies of every wireframe line stacked on
  // top of each other, visibly fattening every great circle and
  // grid line. That's what produced the v0.1.90 "bigger fat blue
  // line" report on the 8-cylinder.
  //
  // Hard-cuts mode: alpha is binary per pixel — exactly one
  // projector wins each world point, so adjacent projectors never
  // double-up at overlap. Lines render once at their true thickness.
  try {
    _applyAutoBlendToRig({ skipHistory: true, hardCuts: true });
  } catch (_) { /* skip on errors (e.g. surface=free) */ }
  if (Visual && Visual._warpCache && typeof Visual._warpCache.clear === "function") {
    Visual._warpCache.clear();
  }
  // 6.6.20.23 — also log post-reset warpMesh state per display so we
  // can see whether the null actually stuck.
  let nonNullAfter = 0;
  for (const d of state.rig.displays) {
    if (d && d.warpMesh) {
      nonNullAfter++;
      console.log("  [post-reset] display " + d.id + " STILL has warpMesh:",
                  { _isCustom: d.warpMesh._isCustom,
                    _isAutoBlend: d.warpMesh._isAutoBlend,
                    _isAutoWarp: d.warpMesh._isAutoWarp,
                    cols: d.warpMesh.cols, rows: d.warpMesh.rows });
    }
  }
  renderProps && renderProps();
  render();
  console.log("[ai-calibration-reset] cleaned " + cleaned + " display(s) — back to no-warp baseline (" +
              nonNullAfter + " survivors w/ _isCustom=true)");
  return cleaned;
}

/* User-facing entry point — wraps iterative AI calibration into one
 * flow. Calls runAICalibrationIterative (Phase 6.6.20.13 v2) which
 * runs N=5 passes capped at ±0.5°/pass each, then shows a diff
 * modal of the cumulative baseline → current changes so the user
 * can review + revert any drift they don't like. */
async function runAICalibrationFlow(opts) {
  const statusCb = opts && opts.onStatus;
  const skipBezier = !!(opts && opts.skipBezier);
  try {
    if (statusCb) statusCb("Phase 1 — pose+FOV+keystone calibration starting...");
    // PHASE 1 — main pose+FOV+keystone iterative.
    const phase1 = await runAICalibrationIterative({
      mode:             "main",
      maxIterations:    5,
      maxDeltaPerPass:  0.5,
      stopThreshold:    0.15,
      onStatus: (msg) => { if (statusCb) statusCb(msg); }
    });

    // PHASE 2 — Bezier interior fine-tune (AI v4). Runs after main
    // phase converges, on the now-refined rig. Smaller iteration
    // budget (3 passes) since Bezier adjustments converge faster
    // — typically 1-2 passes catch most residual mesh issues.
    let phase2 = null;
    if (!skipBezier) {
      if (statusCb) statusCb("Phase 2 — Bezier interior fine-tune starting...");
      phase2 = await runAICalibrationIterative({
        mode:             "bezier",
        maxIterations:    3,
        bezierMaxDeltaPerPass: 0.015,
        stopThreshold:    0.001,
        onStatus: (msg) => { if (statusCb) statusCb(msg); }
      });
    }

    // Combine phase 1 + phase 2 cumulative diffs. Both phases'
    // baselines were captured at THEIR start; phase 2's baseline
    // is the post-phase-1 state, so its diff represents only the
    // Bezier work. Total diff = phase1.finalDiff + phase2.bezierDiff.
    const result = {
      iterations: phase1.iterations + (phase2 ? phase2.iterations : 0),
      totalCorrections: phase1.totalCorrections + (phase2 ? phase2.totalCorrections : 0),
      finalDiff: phase1.finalDiff.map(d1 => {
        // Find the matching phase2 entry for this display.
        const d2 = phase2 ? phase2.finalDiff.find(x => x.idx === d1.idx) : null;
        if (!d2) return d1;
        return Object.assign({}, d1, {
          // Carry phase 2's bezierDiff onto the merged record.
          bezierDiff: d2.bezierDiff,
          reasoning: "Phase 1: pose+FOV+keystone over " + phase1.iterations + " pass(es). Phase 2: Bezier over " + phase2.iterations + " pass(es)."
        });
      }),
      lastResult: (phase2 && phase2.lastResult) || phase1.lastResult,
      lastMeta:   (phase2 && phase2.lastMeta)   || phase1.lastMeta,
      phase1, phase2
    };

    // 6.6.20.14 — better UX for the three "nothing happened" cases.
    // 6.6.20.16 — also count keystone corner deltas (NDC) toward
    // hasChanges, since AI v3 may propose only keystone with no pose.
    const cumDelta = result.finalDiff.reduce((s, c) => {
      let m = Math.abs(c.deltaYaw) + Math.abs(c.deltaPitch) +
              Math.abs(c.deltaFovH) + Math.abs(c.deltaFovV);
      if (c.keystone) {
        const k = c.keystone;
        m += (Math.abs(k.tlx) + Math.abs(k.tly) + Math.abs(k.trx) + Math.abs(k.try_) +
              Math.abs(k.blx) + Math.abs(k.bly) + Math.abs(k.brx) + Math.abs(k.bry)) * 100;
      }
      if (c.bezierDiff && c.bezierDiff.totalAbs > 0) {
        m += c.bezierDiff.totalAbs * 100;
      }
      return s + m;
    }, 0);
    const hasChanges = cumDelta > 0.005;

    // Pull last iteration's per-display errors for diagnostics.
    const lastCorrections = (result.lastResult && Array.isArray(result.lastResult.corrections))
      ? result.lastResult.corrections : [];
    const errored = lastCorrections.filter(c => c.error);
    const allErrored = lastCorrections.length > 0 &&
                       errored.length === lastCorrections.length;

    if (allErrored) {
      const sample = errored.slice(0, 3)
        .map(e => "  • Display " + e.idx + " (" + (e.displayName || e.displayId) + "): " + e.error)
        .join("\n");
      const more = errored.length > 3 ? "\n  ... and " + (errored.length - 3) + " more" : "";
      const msg = "AI calibration: every API call failed (" + errored.length + " of " +
                  lastCorrections.length + ").\n\nFirst few errors:\n" + sample + more +
                  "\n\nLikely fix: open the User DSP tab, click the ⚙ button next to the model badge, " +
                  "and check your provider + API key. For Anthropic the key starts with sk-ant-.";
      if (statusCb) statusCb("All " + errored.length + " AI calls failed");
      alert(msg);
      return { applied: 0, skipped: 0, iterations: result.iterations, errors: errored.length };
    }

    if (!hasChanges) {
      // 6.6.20.15 — be honest about scope. AI v2 only does pose+FOV;
      // it doesn't edit warp meshes or Bezier patches. Most visible
      // boundary artifacts (ghosting, X-shapes, blurring) are mesh-
      // related, not pose-related, so the AI returning "0 deltas"
      // doesn't mean the rig looks perfect — it means there's
      // nothing AI v2 can fix. Surface the AI's REASONING per
      // display so user sees what the model actually saw.
      const erroredCount = errored.length;
      const reasoningSamples = lastCorrections
        .filter(c => !c.error && c.reasoning)
        .slice(0, 3)
        .map(c => "  • Display " + c.idx + " (" + (c.displayName || c.displayId) + "): " + c.reasoning);
      const reasonBlock = reasoningSamples.length
        ? "\n\nWhat the AI reported seeing (sample):\n" + reasoningSamples.join("\n")
        : "";
      const errorBlock = erroredCount > 0
        ? "\n\n" + erroredCount + " API call(s) errored:\n  " +
          errored.slice(0, 2).map(e => "Display " + e.idx + ": " + e.error).join("\n  ")
        : "";
      const msg =
        "AI v2 (pose+FOV only) proposed no significant pose/FOV changes after " +
        result.iterations + " iteration" + (result.iterations === 1 ? "" : "s") + ".\n\n" +
        "What this means:\n" +
        "  1. Projector POSES are likely already correctly placed.\n" +
        "  2. Visible artifacts you still see (ghosting on great circles, X-shapes at corners, " +
        "blurry projector boundaries) are MESH-related, not pose-related — beyond AI v2's scope.\n\n" +
        "Three things to try if artifacts remain:\n" +
        "  a) Re-run Auto-warp + Auto-blend (hard cuts). Defaults bumped to 128×128 mesh in " +
        "v0.1.83 (was 8×8 before v0.1.81), which is the proper fix for sub-pixel boundary " +
        "disagreement. The auto-prep step does this for you each AI pass.\n" +
        "  b) Hand-edit the warp on a problem display: open the warp editor, switch to Bezier " +
        "mode, adjust corner control points. AI v2 does NOT edit warp meshes — that's manual.\n" +
        "  c) If you've stacked multiple AI calibration runs, undo (Ctrl+Z) the older ones — " +
        "accumulated per-projector drift from previous passes can outlast convergence." +
        reasonBlock + errorBlock;
      if (statusCb) statusCb("AI v2 done — see dialog for next steps");
      alert(msg);
      return { applied: 0, skipped: 0, iterations: result.iterations, errors: erroredCount };
    }

    if (statusCb) statusCb("Showing cumulative diff (" + result.iterations + " iterations)...");

    // Has changes — show diff modal. Unchecked rows get reverted.
    const beforeRevert = result.finalDiff.slice();
    // 6.6.20.18 — pass the full result so the modal can build a
    // diagnostic report (phase1/phase2 reasoning + cumulative
    // diffs) on demand. The modal still uses .corrections for the
    // diff rows; the rest is for the Export button.
    const approved = await showAICalibrationModal({
      corrections:      result.finalDiff,
      finalDiff:        result.finalDiff,
      phase1:           result.phase1,
      phase2:           result.phase2,
      iterations:       result.iterations,
      totalCorrections: result.totalCorrections
    });
    const keepIds = new Set(approved.map(c => c.idx));
    let reverted = 0;
    for (const c of beforeRevert) {
      if (keepIds.has(c.idx)) continue;
      const display = state.rig.displays[c.idx];
      if (!display) continue;
      if (display.pose) {
        display.pose.yaw   = (display.pose.yaw   || 0) - (c.deltaYaw   || 0);
        display.pose.pitch = (display.pose.pitch || 0) - (c.deltaPitch || 0);
      }
      if (display.fov) {
        display.fov.h = Math.max(5, (display.fov.h || 90) - (c.deltaFovH || 0));
        display.fov.v = Math.max(5, (display.fov.v || 60) - (c.deltaFovV || 0));
      }
      // 6.6.20.16 — revert keystone deltas if present.
      if (c.keystone) {
        if (!display.keystoneCorners) {
          display.keystoneCorners = { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 };
        }
        const k = display.keystoneCorners;
        k.tlx  -= (c.keystone.tlx  || 0);
        k.tly  -= (c.keystone.tly  || 0);
        k.trx  -= (c.keystone.trx  || 0);
        k.try_ -= (c.keystone.try_ || 0);
        k.blx  -= (c.keystone.blx  || 0);
        k.bly  -= (c.keystone.bly  || 0);
        k.brx  -= (c.keystone.brx  || 0);
        k.bry  -= (c.keystone.bry  || 0);
      }
      // 6.6.20.17 — revert Bezier per-point deltas. bezierDiff.perPoint
      // has each {idx, dx, dy} that changed; subtract them from the
      // display's bezierCorrections.ctrl array.
      if (c.bezierDiff && Array.isArray(c.bezierDiff.perPoint) &&
          c.bezierDiff.perPoint.length > 0 && display.bezierCorrections &&
          Array.isArray(display.bezierCorrections.ctrl)) {
        for (const pt of c.bezierDiff.perPoint) {
          const k = pt.idx * 2;
          display.bezierCorrections.ctrl[k + 0] = (display.bezierCorrections.ctrl[k + 0] || 0) - pt.dx;
          display.bezierCorrections.ctrl[k + 1] = (display.bezierCorrections.ctrl[k + 1] || 0) - pt.dy;
        }
      }
      if (Visual && Visual._warpCache) Visual._warpCache.delete(display.id);
      reverted++;
    }
    if (reverted > 0) {
      pushHistory("ai-calibration-revert");
      renderProps && renderProps();
      render();
    }
    const kept = beforeRevert.length - reverted;
    // 6.6.20.19 — bake AI corrections into the visible warp meshes
    // so the user sees the result when they open the warp editor on
    // any display. The AI corrections live in display.keystoneCorners
    // + display.bezierCorrections (separate fields), and only get
    // applied when auto-warp / auto-blend regenerates the mesh. This
    // forces that regeneration NOW so the on-screen state matches
    // what the AI corrected. Custom (hand-edited) meshes are still
    // skipped per the existing _isCustom check.
    if (kept > 0 && state.rig && state.rig.surfaceVisible) {
      // 6.6.20.22 — bake corrections by re-running Auto-blend ONLY
      // (NOT Auto-warp; see autoPrep comment). Auto-blend at this
      // density preserves keystone+Bezier corrections via the
      // _applyKeystoneCornersToMesh + _applyBezierCorrectionsToMesh
      // helpers it calls internally. Auto-warp would double-warp.
      try {
        _applyAutoBlendToRig({ skipHistory: true, hardCuts: true });
      } catch (_) {}
      if (Visual && Visual._warpCache) {
        // Force every display's warp cache to rebuild on next frame.
        if (typeof Visual._warpCache.clear === "function") Visual._warpCache.clear();
      }
      render();
    }
    if (statusCb) statusCb("Done — " + kept + " kept, " + reverted + " reverted (" + result.iterations + " iter)");
    return { applied: kept, skipped: reverted, iterations: result.iterations };
  } catch (e) {
    if (statusCb) statusCb("Error: " + (e && e.message ? e.message : String(e)));
    throw e;
  }
}

/* ------------ Phase 6.6.2 — MPCDI / Bourke CSV importers --------------- */

/* Minimal in-browser ZIP reader. Uses the well-defined ZIP central
 * directory format + browser's DecompressionStream("deflate-raw")
 * for DEFLATE-compressed entries. No external dependencies — saves
 * the single-HTML-file invariant.
 *
 * Returns { "filename.ext": Uint8Array, ... } for every entry in
 * the archive. STORED (uncompressed) and DEFLATE methods are
 * supported; everything else throws. ZIP64 is not supported (4 GB
 * cap on individual files, 64K cap on entry count) — fine for any
 * realistic MPCDI bundle.
 *
 * The EOCD scan walks backward up to 65535 bytes from end of file
 * (max comment length per the spec). Most ZIPs have EOCD in the
 * last 22 bytes so the loop is fast in practice. */
async function _readZipArchive(buffer) {
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const len = view.byteLength;
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65535 - 22); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP: EOCD signature not found — file may not be a valid ZIP");

  const numEntries = view.getUint16(eocd + 10, true);
  const cdOffset   = view.getUint32(eocd + 16, true);

  const files = {};
  let p = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) {
      throw new Error("ZIP: bad central directory entry at offset " + p);
    }
    const method     = view.getUint16(p + 10, true);
    const compSize   = view.getUint32(p + 20, true);
    const nameLen    = view.getUint16(p + 28, true);
    const extraLen   = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff   = view.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // Read local file header to skip to actual data.
    if (view.getUint32(localOff, true) !== 0x04034b50) {
      throw new Error("ZIP: bad local header for " + name);
    }
    const lfhNameLen  = view.getUint16(localOff + 26, true);
    const lfhExtraLen = view.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lfhNameLen + lfhExtraLen;
    const compData = u8.subarray(dataOff, dataOff + compSize);

    if (method === 0) {
      // Stored — copy out so caller can keep the slice past archive lifetime.
      files[name] = new Uint8Array(compData);
    } else if (method === 8) {
      // DEFLATE — pipe through the browser's decompressor.
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([compData]).stream().pipeThrough(ds);
      const chunks = [];
      const reader = stream.getReader();
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      files[name] = out;
    } else {
      throw new Error("ZIP: unsupported compression method " + method + " for " + name + " (only STORED + DEFLATE)");
    }
  }
  return files;
}

/* Parse a Paul-Bourke-style warp mesh CSV.
 *
 * Format (Bourke "MeshFile2"):
 *   line 1: format version — usually "2" for the standard format,
 *           sometimes "MESH" or omitted; we just consume it.
 *   line 2: N M — grid dimensions (number of vertices wide × tall)
 *   lines 3..N*M+2: x y u v intensity   (whitespace-separated floats)
 *
 * Tolerates: leading/trailing whitespace, comment lines (#…),
 * multiple whitespace types between tokens, optional "MESH" or
 * "v2" magic on line 1.
 *
 * Note on dimensions: Bourke's "N nodes" = our (cols + 1). Output
 * mesh has cols = N - 1, rows = M - 1. */
function _parseBourkeMeshCsv(text) {
  const stripped = text.replace(/\r/g, "").split("\n")
    .map(l => l.replace(/#.*$/, "").trim())
    .filter(l => l.length > 0);
  if (stripped.length < 2) throw new Error("Bourke mesh: too few lines");
  // Magic: "2" or "MESH" or "v2" or just version
  let cursor = 0;
  if (/^[a-zA-Z]/.test(stripped[0]) || stripped[0].length <= 3) cursor = 1;
  // Grid dimensions
  const dimTokens = stripped[cursor].split(/\s+/);
  if (dimTokens.length < 2) throw new Error("Bourke mesh: missing N M dimensions");
  const N = parseInt(dimTokens[0], 10);
  const M = parseInt(dimTokens[1], 10);
  if (!Number.isFinite(N) || !Number.isFinite(M) || N < 2 || M < 2) {
    throw new Error("Bourke mesh: invalid dimensions " + N + "×" + M);
  }
  cursor++;
  const expected = N * M;
  const verts = new Array(expected * 5);
  let written = 0;
  for (let i = cursor; i < stripped.length && written < expected; i++) {
    const tokens = stripped[i].split(/\s+/);
    if (tokens.length < 5) continue;       // tolerate stray non-vertex lines
    const x = parseFloat(tokens[0]);
    const y = parseFloat(tokens[1]);
    const u = parseFloat(tokens[2]);
    const v = parseFloat(tokens[3]);
    const int = parseFloat(tokens[4]);
    if (![x,y,u,v,int].every(Number.isFinite)) continue;
    const off = written * 5;
    verts[off + 0] = x;
    verts[off + 1] = y;
    verts[off + 2] = u;
    verts[off + 3] = v;
    verts[off + 4] = int;
    written++;
  }
  if (written !== expected) {
    throw new Error("Bourke mesh: expected " + expected + " vertices, got " + written);
  }
  return { cols: N - 1, rows: M - 1, verts };
}

/* Parse an MPCDI XML manifest for rig geometry.
 *
 * VESA MPCDI 2.0 schema is large; we only consume the geometry-
 * essential subset:
 *   <MPCDI><display><buffer><region><frustum>
 *      <yaw>, <pitch>, <roll>
 *      <rightAngle>, <leftAngle>, <upAngle>, <downAngle>
 *
 * fov.h = rightAngle - leftAngle (typically ~symmetric)
 * fov.v = upAngle    - downAngle
 * pose  = (yaw, pitch, roll)
 *
 * Returns an array of partial Display objects ready for
 * _makeDisplay overrides. Warp / alpha file references are captured
 * but the binary parsers (PFM, PNG) ship in 6.6.2b — for now we
 * surface them as warpFileRef / alphaFileRef on the display so a
 * future ticket can wire them up. */
function _parseMpcdiXml(xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  const parseErr = dom.querySelector("parsererror");
  if (parseErr) throw new Error("MPCDI XML: " + (parseErr.textContent || "parse failed"));
  const root = dom.documentElement;
  if (!root || root.nodeName.toUpperCase() !== "MPCDI") {
    throw new Error("MPCDI XML: root element should be <MPCDI>, got <" + (root && root.nodeName) + ">");
  }

  const displays = [];
  let idx = 0;
  for (const buffer of root.querySelectorAll("display buffer")) {
    for (const region of buffer.querySelectorAll("region")) {
      const frustum = region.querySelector("frustum");
      const f = (sel) => {
        const el = frustum && frustum.querySelector(sel);
        const v = el ? parseFloat(el.textContent) : 0;
        return Number.isFinite(v) ? v : 0;
      };
      const yaw   = f("yaw");
      const pitch = f("pitch");
      const roll  = f("roll");
      const rA = f("rightAngle"), lA = f("leftAngle");
      const uA = f("upAngle"),    dA = f("downAngle");
      const fovH = Math.max(1, Math.abs(rA - lA));
      const fovV = Math.max(1, Math.abs(uA - dA));
      const id = region.getAttribute("id") || ("region" + idx);

      const fileSet = region.querySelector("fileSet");
      const warpFile  = fileSet && fileSet.querySelector("geometryWarpFile");
      const alphaFile = fileSet && fileSet.querySelector("alphaMap");

      displays.push({
        id: id,
        name: id,
        pose: { yaw, pitch, roll },
        fov:  { h: fovH, v: fovV },
        worldUv: { minU: idx / 4, minV: 0, maxU: (idx + 1) / 4, maxV: 1 }, // placeholder; replaced after we know count
        warpFileRef:  warpFile  ? warpFile.textContent.trim()  : null,
        alphaFileRef: alphaFile ? alphaFile.textContent.trim() : null
      });
      idx++;
    }
  }

  if (displays.length === 0) {
    throw new Error("MPCDI XML: no <region> elements found inside <buffer>s");
  }
  // Re-stripe worldUv evenly across the imported displays. Users can
  // tweak per-display worldUv after import; this gives a reasonable
  // default that matches what the rig templates produce.
  const n = displays.length;
  for (let i = 0; i < n; i++) {
    displays[i].worldUv = { minU: i / n, minV: 0, maxU: (i + 1) / n, maxV: 1 };
  }
  return displays;
}

/* User-facing: pop a file picker for a Bourke CSV warp file, parse,
 * apply to the given display. Surfaces parse errors via alert so
 * the user knows what went wrong with a mis-formatted file. Drops
 * GPU cache so the next frame rebuilds with the new mesh. */
function importBourkeMeshForDisplay(displayIdx) {
  const d = state.rig && state.rig.displays && state.rig.displays[displayIdx];
  if (!d) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,.txt,.data";
  input.onchange = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const mesh = _parseBourkeMeshCsv(text);
      if (!_validateWarpMesh(mesh)) throw new Error("Parsed mesh failed validation");
      pushHistory("warp-import:" + d.id);
      d.warpMesh = mesh;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      if (state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
        state.rig.templateKey = "custom";
      }
      renderProps && renderProps();
      render();
      console.log("[warp-import]", file.name, "→ display", displayIdx, ":", mesh.cols + "×" + mesh.rows);
    } catch (e) {
      alert("Could not import warp mesh:\n\n" + (e && e.message ? e.message : String(e)));
    }
  };
  input.click();
}

/* User-facing: pop a file picker for an MPCDI bundle (.mpcdi or
 * .zip). Reads the ZIP, parses mpcdi.xml, replaces the rig with
 * the imported display set. Warp + blend file references are
 * captured but their binary parsers (PFM, PNG) ship in 6.6.2b —
 * the rig geometry alone is meaningful (correct poses + FOVs +
 * display count) and the user can always run "Auto-blend rig"
 * afterward to populate intensity ramps. */
function importMpcdiBundle() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".mpcdi,.zip";
  input.onchange = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const archive = await _readZipArchive(buf);
      // Find mpcdi.xml — case-insensitive, in archive root or any
      // subdirectory. Fall back to any .xml file if the canonical
      // name isn't present (some bundles rename it).
      const xmlName = Object.keys(archive).find(n => /(^|\/)mpcdi\.xml$/i.test(n))
                    || Object.keys(archive).find(n => /\.xml$/i.test(n));
      if (!xmlName) throw new Error("No mpcdi.xml (or any .xml) found in archive");
      const xmlText = new TextDecoder("utf-8").decode(archive[xmlName]);
      const imported = _parseMpcdiXml(xmlText);
      if (!state.rig) state.rig = defaultRig();
      pushHistory("mpcdi-import:" + file.name);
      state.rig.templateKey = "custom";
      state.rig.displays    = imported.map((d, i) => _makeDisplay(d.id, d.name, {
        pose: d.pose,
        fov:  d.fov,
        worldUv: d.worldUv
      }));
      // Validate VisualOutput display-index pointers against new count.
      const max = state.rig.displays.length - 1;
      state.nodes.forEach(n => {
        if (n.type === "VisualOutput" && n.params && typeof n.params.display === "number") {
          if (n.params.display > max) n.params.display = max;
        }
      });
      // Reallocate FBO + rebuild bind groups since display count changed.
      if (Visual.device) {
        _allocateFramebuffer();
        _rebuildBlitBindGroup();
        _rebuildRigCompositeBindGroup();
        _rebuildWarpBindGroup();
        _rebuildTheaterBindGroup();
      }

      // Phase 6.6.2b — load referenced warp + blend files from the
      // archive. Each imported display may have warpFileRef + alphaFileRef
      // pointing at PFM / PNG / CSV files inside the bundle. Resolve
      // the references, parse based on extension, apply to display.
      let warpsApplied = 0, blendsApplied = 0;
      const warnings = [];
      for (let i = 0; i < imported.length; i++) {
        const meta = imported[i];
        const display = state.rig.displays[i];
        if (!meta || !display) continue;
        // Warp file → display.warpMesh
        if (meta.warpFileRef) {
          const data = _archiveLookup(archive, meta.warpFileRef);
          if (!data) {
            warnings.push("Display " + i + ": warp file '" + meta.warpFileRef + "' not in archive");
          } else {
            try {
              const ext = (meta.warpFileRef.match(/\.([a-z0-9]+)$/i) || ["",""])[1].toLowerCase();
              if (ext === "pfm") {
                const pfm = _parsePfm(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
                display.warpMesh = _pfmToBourkeMesh(pfm, 16, 16);
                warpsApplied++;
              } else if (ext === "csv" || ext === "txt" || ext === "data") {
                const text = new TextDecoder("utf-8").decode(data);
                display.warpMesh = _parseBourkeMeshCsv(text);
                display.warpMesh._isCustom = true;
                warpsApplied++;
              } else {
                warnings.push("Display " + i + ": unsupported warp format '" + ext + "'");
              }
            } catch (we) {
              warnings.push("Display " + i + " warp parse: " + we.message);
            }
          }
        }
        // Alpha PNG → display.warpMesh.intensity (paint over whatever
        // warp mesh exists; if no warp mesh, create an identity first
        // so blend ramps have somewhere to live).
        if (meta.alphaFileRef) {
          const data = _archiveLookup(archive, meta.alphaFileRef);
          if (!data) {
            warnings.push("Display " + i + ": alpha file '" + meta.alphaFileRef + "' not in archive");
          } else {
            if (!display.warpMesh) display.warpMesh = _makeIdentityWarpMesh(16, 16);
            try {
              await _applyPngBlendMap(data, display.warpMesh);
              display.warpMesh._isCustom = true;
              blendsApplied++;
            } catch (be) {
              warnings.push("Display " + i + " alpha apply: " + be.message);
            }
          }
        }
        if (display.warpMesh && Visual && Visual._warpCache) {
          Visual._warpCache.delete(display.id);
        }
      }

      // Auto-blend ONLY for displays that didn't get explicit alpha
      // maps from the bundle — preserve hand-painted blend ramps.
      _applyAutoBlendToRig({ skipHistory: true, keepTemplate: true });
      const msgLines = [
        "Imported " + imported.length + " displays from " + file.name,
        warpsApplied  + " warp file(s) applied",
        blendsApplied + " alpha map(s) applied"
      ];
      if (warnings.length) {
        msgLines.push("");
        msgLines.push("Warnings:");
        for (const w of warnings.slice(0, 8)) msgLines.push("  " + w);
        if (warnings.length > 8) msgLines.push("  ... and " + (warnings.length - 8) + " more");
      }
      const msg = msgLines.join("\n");
      console.log("[mpcdi-import]", msg);
      renderProps && renderProps();
      render();
      alert(msg);
    } catch (e) {
      alert("Could not import MPCDI bundle:\n\n" + (e && e.message ? e.message : String(e)));
    }
  };
  input.click();
}

/* ------------ Phase 6.6.2b — PFM + PNG binary parsers ------------------ */

/* Parse a Portable Float Map (PFM). Header is plain ASCII followed
 * by raw float32 data:
 *
 *     PF                        # 3-channel (RGB) — MPCDI warp uses this
 *     [or Pf]                   # 1-channel (grayscale)
 *     WIDTH HEIGHT
 *     ±SCALE                    # negative = little-endian, positive = big-endian
 *     <binary float32 data, width × height × channels>
 *
 * Returns { width, height, channels, data } with pixel data flipped
 * to top-to-bottom row order (PFM stores rows bottom-up by spec, so
 * we invert at parse time so callers can index naturally with
 * row 0 = top of image). */
function _parsePfm(buffer) {
  const u8 = new Uint8Array(buffer);
  let p = 0;
  const readLine = () => {
    let start = p;
    while (p < u8.length && u8[p] !== 0x0A && u8[p] !== 0x0D) p++;
    const line = new TextDecoder("ascii").decode(u8.subarray(start, p));
    while (p < u8.length && (u8[p] === 0x0A || u8[p] === 0x0D)) p++;
    return line.trim();
  };
  const magic = readLine();
  let channels;
  if (magic === "PF")      channels = 3;
  else if (magic === "Pf") channels = 1;
  else throw new Error("PFM: unexpected magic '" + magic + "' (expected 'PF' or 'Pf')");

  // Some tools emit a comment before the dims line.
  let dimsLine;
  while (true) {
    dimsLine = readLine();
    if (!dimsLine.startsWith("#")) break;
  }
  const dimMatch = dimsLine.match(/^(\d+)\s+(\d+)/);
  if (!dimMatch) throw new Error("PFM: bad dimensions line '" + dimsLine + "'");
  const width  = parseInt(dimMatch[1], 10);
  const height = parseInt(dimMatch[2], 10);

  const scaleLine = readLine();
  const scale = parseFloat(scaleLine);
  if (!Number.isFinite(scale)) throw new Error("PFM: bad scale '" + scaleLine + "'");
  const littleEndian = scale < 0;

  const numFloats = width * height * channels;
  const expectedBytes = numFloats * 4;
  const remainingBytes = u8.length - p;
  if (remainingBytes < expectedBytes) {
    throw new Error("PFM: truncated data (need " + expectedBytes + " B, got " + remainingBytes + ")");
  }
  // Build a fresh Float32Array, flipping rows top-to-bottom on the way.
  const data = new Float32Array(numFloats);
  const dv = new DataView(buffer, p);
  for (let r = 0; r < height; r++) {
    const srcRow = height - 1 - r;          // PFM rows are bottom-up
    for (let c = 0; c < width; c++) {
      for (let k = 0; k < channels; k++) {
        const srcIdx = (srcRow * width + c) * channels + k;
        const dstIdx = (r * width + c) * channels + k;
        data[dstIdx] = dv.getFloat32(srcIdx * 4, littleEndian);
      }
    }
  }
  return { width, height, channels, data };
}

/* Convert a PFM warp file to our Bourke mesh format. PFM stores
 * per-pixel source UV (channel 0 = u, channel 1 = v); we subsample
 * at a grid of (cols+1) × (rows+1) vertices. Default resolution
 * 16×16 — fine enough for any visible warp at 1080p, light enough
 * that the editor's modal stays responsive when the user opens
 * one for tweaking.
 *
 * The PFM is already top-to-bottom (we flipped at parse time), and
 * our mesh's r=0 maps to NDC bottom — which is image-bottom in
 * our convention. So mesh row r samples PFM row (rows - r) to keep
 * the orientation correct. */
function _pfmToBourkeMesh(pfm, cols, rows) {
  cols = cols || 16;
  rows = rows || 16;
  const W = cols + 1, H = rows + 1;
  const mesh = _makeIdentityWarpMesh(cols, rows);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      // PFM is top-to-bottom; mesh r=0 is NDC-bottom = image-bottom.
      // Sample at (1 - v) of PFM height to get image-bottom for r=0.
      const px = Math.max(0, Math.min(pfm.width  - 1, Math.round(u * (pfm.width  - 1))));
      const py = Math.max(0, Math.min(pfm.height - 1, Math.round((1 - v) * (pfm.height - 1))));
      const idx = (py * pfm.width + px) * pfm.channels;
      const sourceU = pfm.data[idx];
      const sourceV = pfm.channels > 1 ? pfm.data[idx + 1] : 0;
      const off = (r * W + c) * 5;
      mesh.verts[off + 0] = u * 2 - 1;        // identity NDC for projector pixel
      mesh.verts[off + 1] = v * 2 - 1;
      mesh.verts[off + 2] = sourceU;          // source UV from PFM
      mesh.verts[off + 3] = sourceV;
      mesh.verts[off + 4] = 1;                // intensity from alpha PNG (separate)
    }
  }
  mesh._isCustom = true;                       // imported = treat as user data
  return mesh;
}

/* Sample a PNG blend-map at every mesh vertex position and write
 * the values into the mesh's intensity field. Uses createImageBitmap
 * + an OffscreenCanvas-like draw to read pixel data without dragging
 * any 3rd-party PNG decoder. The R channel is used for grayscale
 * (every channel is identical for true grayscale bitmaps; for RGB
 * blend maps the standard is to use the red component). */
async function _applyPngBlendMap(pngBytes, mesh) {
  if (!_validateWarpMesh(mesh)) throw new Error("invalid mesh for blend-map application");
  const blob = new Blob([pngBytes], { type: "image/png" });
  const bmp  = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width  = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;

  const W = mesh.cols + 1, H = mesh.rows + 1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      // Sample at the mesh vertex's projector-NDC position (mx, my).
      // Image coord: (mx*0.5 + 0.5) × (W-1), (1 - (my*0.5 + 0.5)) × (H-1)
      const off = (r * W + c) * 5;
      const mx = mesh.verts[off + 0];
      const my = mesh.verts[off + 1];
      const ix = Math.max(0, Math.min(bmp.width  - 1, Math.round((mx * 0.5 + 0.5)       * (bmp.width  - 1))));
      const iy = Math.max(0, Math.min(bmp.height - 1, Math.round((1 - (my * 0.5 + 0.5)) * (bmp.height - 1))));
      const pi = (iy * bmp.width + ix) * 4;
      mesh.verts[off + 4] = px[pi] / 255;     // red channel as intensity
    }
  }
  return mesh;
}

/* Resolve a relative file reference inside the MPCDI archive against
 * the archive's file map. MPCDI references can be naked filenames
 * ("region1_warp.pfm") or paths ("pfm/region1_warp.pfm"); look up
 * canonical name first, then any case-insensitive suffix match. */
function _archiveLookup(archive, ref) {
  if (!ref) return null;
  if (archive[ref]) return archive[ref];
  const refLower = ref.toLowerCase();
  for (const k of Object.keys(archive)) {
    if (k.toLowerCase() === refLower) return archive[k];
    if (k.toLowerCase().endsWith("/" + refLower)) return archive[k];
  }
  return null;
}

/* ------------ Phase 6.6.3b — PFM warp export --------------------------- */

/* Rasterize a Bourke warp mesh to a PFM file. For each pixel in the
 * output PFM we find which mesh quad covers that NDC position (after
 * deformation) and bilinear-interpolate the source UV stored in the
 * mesh. Pixels not covered get (0, 0, 0).
 *
 * Algorithm: walk each mesh quad, split into 2 triangles, scanline
 * each triangle with barycentric interpolation. ~O(width × height)
 * total work — fast enough for 1024×1024 in <1s on a typical CPU.
 *
 * Output PFM convention: we write row-0-at-bottom (per PFM spec),
 * which matches our mesh's NDC convention (r=0 at bottom). */
function _serializePfm(mesh, outW, outH) {
  outW = outW || 1024;
  outH = outH || 1024;
  if (!_validateWarpMesh(mesh)) throw new Error("invalid mesh for PFM export");

  // RGB float buffer, top-to-bottom rows internally; we'll flip on
  // write so the file matches PFM's bottom-up convention.
  const pixels = new Float32Array(outW * outH * 3);
  const W = mesh.cols + 1;

  // Helper: rasterize one triangle. Each vertex carries (mx, my) in
  // NDC + (mu, mv) source UV. Pixel (px, py) maps to NDC
  // ((px+0.5)/outW * 2 - 1, (py+0.5)/outH * 2 - 1).
  const drawTri = (a, b, c) => {
    const minMx = Math.min(a.mx, b.mx, c.mx);
    const maxMx = Math.max(a.mx, b.mx, c.mx);
    const minMy = Math.min(a.my, b.my, c.my);
    const maxMy = Math.max(a.my, b.my, c.my);
    const minPx = Math.max(0,        Math.floor((minMx * 0.5 + 0.5) * outW));
    const maxPx = Math.min(outW - 1, Math.ceil ((maxMx * 0.5 + 0.5) * outW));
    const minPy = Math.max(0,        Math.floor((minMy * 0.5 + 0.5) * outH));
    const maxPy = Math.min(outH - 1, Math.ceil ((maxMy * 0.5 + 0.5) * outH));
    const denom = (b.my - c.my) * (a.mx - c.mx) + (c.mx - b.mx) * (a.my - c.my);
    if (Math.abs(denom) < 1e-12) return;
    const invDenom = 1 / denom;
    for (let py = minPy; py <= maxPy; py++) {
      for (let px = minPx; px <= maxPx; px++) {
        const mx = (px + 0.5) / outW * 2 - 1;
        const my = (py + 0.5) / outH * 2 - 1;
        const w0 = ((b.my - c.my) * (mx - c.mx) + (c.mx - b.mx) * (my - c.my)) * invDenom;
        const w1 = ((c.my - a.my) * (mx - c.mx) + (a.mx - c.mx) * (my - c.my)) * invDenom;
        const w2 = 1 - w0 - w1;
        // Inside-triangle test (small epsilon to cover edge pixels).
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const u = a.mu * w0 + b.mu * w1 + c.mu * w2;
        const v = a.mv * w0 + b.mv * w1 + c.mv * w2;
        const idx = (py * outW + px) * 3;
        pixels[idx + 0] = u;
        pixels[idx + 1] = v;
        pixels[idx + 2] = 0;
      }
    }
  };

  for (let r = 0; r < mesh.rows; r++) {
    for (let c = 0; c < mesh.cols; c++) {
      const v00 = (r       * W + c    ) * 5;
      const v10 = (r       * W + c + 1) * 5;
      const v01 = ((r + 1) * W + c    ) * 5;
      const v11 = ((r + 1) * W + c + 1) * 5;
      const verts = [v00, v10, v01, v11].map(off => ({
        mx: mesh.verts[off + 0],
        my: mesh.verts[off + 1],
        mu: mesh.verts[off + 2],
        mv: mesh.verts[off + 3]
      }));
      drawTri(verts[0], verts[1], verts[2]);
      drawTri(verts[2], verts[1], verts[3]);
    }
  }

  // Header — text — followed by binary float data, rows bottom-up.
  const header = new TextEncoder().encode("PF\n" + outW + " " + outH + "\n-1.0\n");
  const out = new Uint8Array(header.length + outW * outH * 3 * 4);
  out.set(header, 0);
  const dv = new DataView(out.buffer, out.byteOffset + header.length);
  for (let r = 0; r < outH; r++) {
    const srcRow = outH - 1 - r;            // flip to bottom-up
    for (let c = 0; c < outW; c++) {
      const dstIdx = (r * outW + c) * 3;
      const srcIdx = (srcRow * outW + c) * 3;
      dv.setFloat32(dstIdx * 4 + 0, pixels[srcIdx + 0], true);
      dv.setFloat32(dstIdx * 4 + 4, pixels[srcIdx + 1], true);
      dv.setFloat32(dstIdx * 4 + 8, pixels[srcIdx + 2], true);
    }
  }
  return out;
}

/* ------------ Phase 6.6.9 — mesh warp editor state + helpers ----------- */

/* Editor state. Mesh edits mutate display.warpMesh.verts in place
 * so the live preview picks up changes on the next frame; the
 * GPU-cache invalidation hook (Visual._warpCache.delete) fires
 * after each drag so the warp pipeline rebuilds its vertex buffer
 * with the new positions. originalMesh is a deep clone snapshot
 * for Cancel — restores the pre-edit state if the user backs out. */
const _warpEditor = {
  open: false,
  displayIdx: -1,
  originalMesh: null,
  // Per-frame interaction state.
  draggedVertex: -1,    // index into mesh.verts; -1 = none
  hoverVertex:   -1
};

/* Resample a Bourke mesh to a different resolution while preserving
 * its current deformation. Each new vertex (r', c') in [0,1]² takes
 * its (mx, my) NDC position by bilinear interpolation of the four
 * surrounding old vertices. UV stays uniform (u' = c'/cols', v' =
 * r'/rows') since UV is the source-content mapping, not the warp.
 * Intensity carries over by bilinear interpolation too — handy when
 * a user has hand-painted blend ramps and wants finer control points
 * without losing the gradient. */
function _resampleWarpMesh(oldMesh, newCols, newRows) {
  const fresh = _makeIdentityWarpMesh(newCols, newRows);
  if (!_validateWarpMesh(oldMesh)) return fresh;
  const oW = oldMesh.cols + 1, oH = oldMesh.rows + 1;
  const nW = newCols + 1, nH = newRows + 1;
  for (let nr = 0; nr < nH; nr++) {
    for (let nc = 0; nc < nW; nc++) {
      const u = nc / newCols;
      const v = nr / newRows;
      // Find old-mesh fractional coords.
      const fc = u * oldMesh.cols;
      const fr = v * oldMesh.rows;
      const c0 = Math.max(0, Math.min(oldMesh.cols, Math.floor(fc)));
      const r0 = Math.max(0, Math.min(oldMesh.rows, Math.floor(fr)));
      const c1 = Math.min(oldMesh.cols, c0 + 1);
      const r1 = Math.min(oldMesh.rows, r0 + 1);
      const tx = fc - c0;
      const ty = fr - r0;
      // Bilinear weights.
      const w00 = (1 - tx) * (1 - ty);
      const w10 =      tx  * (1 - ty);
      const w01 = (1 - tx) *      ty;
      const w11 =      tx  *      ty;
      const i00 = (r0 * oW + c0) * 5;
      const i10 = (r0 * oW + c1) * 5;
      const i01 = (r1 * oW + c0) * 5;
      const i11 = (r1 * oW + c1) * 5;
      const mx = oldMesh.verts[i00+0]*w00 + oldMesh.verts[i10+0]*w10 +
                 oldMesh.verts[i01+0]*w01 + oldMesh.verts[i11+0]*w11;
      const my = oldMesh.verts[i00+1]*w00 + oldMesh.verts[i10+1]*w10 +
                 oldMesh.verts[i01+1]*w01 + oldMesh.verts[i11+1]*w11;
      const mi = oldMesh.verts[i00+4]*w00 + oldMesh.verts[i10+4]*w10 +
                 oldMesh.verts[i01+4]*w01 + oldMesh.verts[i11+4]*w11;
      const off = (nr * nW + nc) * 5;
      fresh.verts[off + 0] = mx;
      fresh.verts[off + 1] = my;
      fresh.verts[off + 2] = u;
      fresh.verts[off + 3] = v;
      fresh.verts[off + 4] = mi;
    }
  }
  return fresh;
}

/* Deep-clone a warp mesh so editor Cancel can restore the pre-edit
 * state without retaining a reference to the live mesh that gets
 * mutated during dragging. */
function _cloneWarpMesh(m) {
  if (!m) return null;
  const clone = {
    cols: m.cols,
    rows: m.rows,
    verts: m.verts.slice(),
    _isAutoBlend: m._isAutoBlend,
    _isTest: m._isTest,
    _isCustom: m._isCustom,
    _hasKeystone: m._hasKeystone,                 // 6.6.20.16 — idempotency flag
    _hasBezierCorrections: m._hasBezierCorrections // 6.6.20.17 — idempotency flag
  };
  // 6.6.19: preserve Bezier control grid through the editor's
  // Cancel-restore snapshot so undo doesn't silently downgrade
  // bezier authoring back to mesh authoring.
  if (m._bezier) {
    clone._bezier = {
      cols: m._bezier.cols,
      rows: m._bezier.rows,
      ctrl: m._bezier.ctrl.slice()
    };
  }
  return clone;
}

/* Open the modal for one display. If the display has no warp mesh,
 * a fresh identity mesh is created; if it has one, the user edits
 * a copy in place and originalMesh holds the snapshot for Cancel. */
function openWarpEditor(displayIdx) {
  const d = state.rig && state.rig.displays && state.rig.displays[displayIdx];
  if (!d) return;
  if (!d.warpMesh) d.warpMesh = _makeIdentityWarpMesh(8, 8);
  _warpEditor.open = true;
  _warpEditor.displayIdx = displayIdx;
  _warpEditor.originalMesh = _cloneWarpMesh(d.warpMesh);
  _warpEditor.draggedVertex = -1;
  _warpEditor.hoverVertex = -1;
  const overlay = document.getElementById("warp-editor");
  if (overlay) overlay.style.display = "flex";
  const title = document.getElementById("warp-editor-title");
  if (title) title.textContent = "Warp editor — Display " + displayIdx + " (" + (d.name || "") + ")";
  // 6.6.19: detect bezier-authored meshes on reopen and switch the
  // Mode dropdown accordingly. The mesh carries _bezier as the
  // source of truth in bezier mode; verts are derived.
  const isBezier = !!(d.warpMesh._bezier);
  const modeSel = document.getElementById("warp-editor-mode");
  if (modeSel) modeSel.value = isBezier ? "bezier" : "mesh";
  _updateWarpEditorModeUI(isBezier ? "bezier" : "mesh");

  const resSel = document.getElementById("warp-editor-res");
  if (resSel && !isBezier) {
    // Match the dropdown to the mesh's current cols. Non-square or
    // out-of-preset sizes show as "Custom…".
    const presetCols = ["4", "8", "12", "16", "24", "32"];
    const colsStr = String(d.warpMesh.cols);
    if (d.warpMesh.cols === d.warpMesh.rows && presetCols.includes(colsStr)) {
      resSel.value = colsStr;
    } else {
      resSel.value = "custom";
    }
  }
  // Bezier degree dropdown — match to current control-grid size.
  const degSel = document.getElementById("warp-editor-degree");
  if (degSel && isBezier) {
    const presetDegs = ["3", "4", "6", "8"];
    const degStr = String(d.warpMesh._bezier.cols);
    if (d.warpMesh._bezier.cols === d.warpMesh._bezier.rows && presetDegs.includes(degStr)) {
      degSel.value = degStr;
    } else {
      degSel.value = "4";    // fall back to default
    }
  }
  // Triangular checkbox starts unchecked since we can't reliably
  // detect a triangular mesh after load (the offset is baked in).
  const triCheck = document.getElementById("warp-editor-triangular");
  if (triCheck) triCheck.checked = false;
  // Drop GPU cache so the next frame rebuilds with the live edits.
  if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
  _drawWarpEditor();
}

/* Close the modal. save=true commits the in-place edits; save=false
 * restores the snapshot. Either way, GPU cache is dropped so the
 * next frame reflects the final state. */
function closeWarpEditor(save) {
  if (!_warpEditor.open) return;
  const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
  if (!save && d && _warpEditor.originalMesh) {
    d.warpMesh = _warpEditor.originalMesh;
  }
  if (save && state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
    state.rig.templateKey = "custom";
  }
  _warpEditor.open = false;
  _warpEditor.displayIdx = -1;
  _warpEditor.originalMesh = null;
  _warpEditor.draggedVertex = -1;
  _warpEditor.hoverVertex = -1;
  const overlay = document.getElementById("warp-editor");
  if (overlay) overlay.style.display = "none";
  if (Visual && Visual._warpCache && d) Visual._warpCache.delete(d.id);
  if (save) pushHistory("warp-edit:" + (d ? d.id : "?"));
  renderProps && renderProps();
  render();
}

/* 6.6.19: show/hide tools based on whether we're in mesh or bezier
 * authoring mode. In mesh mode: Resolution + Triangular visible. In
 * bezier mode: Degree visible, Triangular hidden (doesn't apply to
 * a single Bezier patch). Resolution stays visible in mesh mode only
 * so users don't accidentally bump the mesh tessellation density
 * while editing a bezier. */
function _updateWarpEditorModeUI(mode) {
  const resLabel  = document.getElementById("warp-editor-res-label");
  const degLabel  = document.getElementById("warp-editor-degree-label");
  const triLabel  = document.getElementById("warp-editor-tri-label");
  const hint      = document.getElementById("warp-editor-hint");
  if (resLabel) resLabel.style.display = (mode === "bezier") ? "none" : "";
  if (triLabel) triLabel.style.display = (mode === "bezier") ? "none" : "";
  if (degLabel) degLabel.style.display = (mode === "bezier") ? "" : "none";
  if (hint) {
    hint.textContent = (mode === "bezier")
      ? "Drag a control point to bend the warp · Right-click resets one point · × or Save commits · Esc / Cancel discards"
      : "Drag a point to warp · Right-click resets one point · × or Save commits · Esc / Cancel discards · Live preview visible behind";
  }
}

/* Render the editor canvas. Draws a calibration checkerboard +
 * overlays the warp mesh as a draggable point grid. The mesh's
 * (mx, my) NDC positions are mapped to canvas space [-1,+1] →
 * [pad, W-pad] / [pad, H-pad] (Y inverted: canvas y down vs NDC
 * y up). Selected / hovered points are drawn larger and accent-
 * colored so the user always knows which point they're moving.
 *
 * 6.6.19: in bezier mode, the dense mesh is drawn faintly and the
 * Bezier control polygon (dashed lines + control points) is the
 * draggable layer. */
function _drawWarpEditor() {
  const canvas = document.getElementById("warp-editor-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
  if (!d || !_validateWarpMesh(d.warpMesh)) return;
  const m = d.warpMesh;

  // Calibration checkerboard — 8×8 in canvas space, alternating dark
  // grey + lighter grey. Distinct from the warp mesh's grid lines.
  const cells = 8;
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      ctx.fillStyle = ((r + c) & 1) ? "rgba(80, 90, 105, 0.35)" : "rgba(40, 48, 60, 0.5)";
      ctx.fillRect(c * W / cells, r * H / cells, W / cells, H / cells);
    }
  }
  // Crosshair at canvas center for symmetry reference.
  ctx.strokeStyle = "rgba(200, 232, 90, 0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W * 0.5, 0); ctx.lineTo(W * 0.5, H);
  ctx.moveTo(0, H * 0.5); ctx.lineTo(W, H * 0.5);
  ctx.stroke();

  // Map mesh NDC (mx, my) ∈ [-1, 1]² to canvas pixels with a small
  // padding so the boundary points sit just inside the canvas edge.
  const pad = Math.min(W, H) * 0.06;
  const Wf = W - pad * 2, Hf = H - pad * 2;
  const meshToCanvas = (mx, my) => ({
    x: pad + (mx + 1) * 0.5 * Wf,
    y: pad + (1 - (my + 1) * 0.5) * Hf
  });

  const cols1 = m.cols + 1, rows1 = m.rows + 1;
  const inBezier = !!(m._bezier);

  // Mesh quad outlines + diagonals show how the warp is deforming
  // a uniform grid. Draw before the points so points sit on top.
  // In bezier mode, draw the dense mesh faintly so the user can
  // see the smooth Bezier surface, then draw the control polygon
  // on top of it.
  ctx.strokeStyle = inBezier ? "rgba(180, 190, 210, 0.18)" : "rgba(180, 190, 210, 0.45)";
  ctx.lineWidth = 1;
  // Horizontal lines (per row).
  for (let r = 0; r < rows1; r++) {
    ctx.beginPath();
    for (let c = 0; c < cols1; c++) {
      const v = m.verts.subarray ? m.verts.subarray((r*cols1+c)*5, (r*cols1+c)*5+5) : m.verts.slice((r*cols1+c)*5, (r*cols1+c)*5+5);
      const p = meshToCanvas(v[0], v[1]);
      if (c === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  // Vertical lines (per col).
  for (let c = 0; c < cols1; c++) {
    ctx.beginPath();
    for (let r = 0; r < rows1; r++) {
      const idx = (r * cols1 + c) * 5;
      const p = meshToCanvas(m.verts[idx], m.verts[idx + 1]);
      if (r === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  if (inBezier) {
    // Bezier mode: control polygon (dashed) + control points.
    const b = m._bezier;
    const bcols1 = b.cols + 1, brows1 = b.rows + 1;
    const cpToCanvas = (i) => meshToCanvas(b.ctrl[i * 2], b.ctrl[i * 2 + 1]);

    // Dashed control polygon — visually distinguishes "this is the
    // control net, not the actual surface" from the dense mesh below.
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(170, 162, 240, 0.55)";
    ctx.lineWidth = 1.25;
    // Horizontal control-net lines.
    for (let r = 0; r < brows1; r++) {
      ctx.beginPath();
      for (let c = 0; c < bcols1; c++) {
        const p = cpToCanvas(r * bcols1 + c);
        if (c === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    // Vertical control-net lines.
    for (let c = 0; c < bcols1; c++) {
      ctx.beginPath();
      for (let r = 0; r < brows1; r++) {
        const p = cpToCanvas(r * bcols1 + c);
        if (r === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Control points. The four corners are pinned visually (Bezier
    // interpolates corners) — render them slightly smaller and a
    // dimmer hue to suggest "anchor" rather than "free."
    for (let r = 0; r < brows1; r++) {
      for (let c = 0; c < bcols1; c++) {
        const flat = r * bcols1 + c;
        const p = cpToCanvas(flat);
        const isDragged = (_warpEditor.draggedVertex === flat);
        const isHover   = (_warpEditor.hoverVertex   === flat);
        const isCorner  = (r === 0 || r === b.rows) && (c === 0 || c === b.cols);
        const radius = isDragged ? 10 : (isHover ? 8 : 6);
        ctx.fillStyle = isDragged
          ? "rgba(200, 232, 90, 0.95)"
          : (isHover ? "rgba(170, 162, 240, 0.95)"
            : (isCorner ? "rgba(140, 132, 200, 0.85)" : "rgba(190, 180, 255, 0.85)"));
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(8, 11, 16, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  } else {
    // Mesh mode: every mesh vertex is draggable (legacy 6.6.2 UI).
    for (let r = 0; r < rows1; r++) {
      for (let c = 0; c < cols1; c++) {
        const idx = (r * cols1 + c) * 5;
        const p = meshToCanvas(m.verts[idx], m.verts[idx + 1]);
        const flat = r * cols1 + c;
        const isDragged = (_warpEditor.draggedVertex === flat);
        const isHover   = (_warpEditor.hoverVertex   === flat);
        const radius = isDragged ? 9 : (isHover ? 7 : 5);
        ctx.fillStyle = isDragged
          ? "rgba(200, 232, 90, 0.95)"
          : (isHover ? "rgba(170, 162, 240, 0.95)" : "rgba(170, 162, 240, 0.7)");
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(8, 11, 16, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}

/* Convert a canvas-space click to the closest mesh-vertex index, or
 * -1 if no vertex is within hitRadius pixels. Walks every vertex
 * (default 8×8 mesh = 81 points = trivial). */
function _warpEditorHitTest(canvas, clientX, clientY, hitRadius) {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width  / r.width;
  const sy = canvas.height / r.height;
  const cx = (clientX - r.left) * sx;
  const cy = (clientY - r.top)  * sy;
  const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
  if (!d || !_validateWarpMesh(d.warpMesh)) return { idx: -1, cx, cy };
  const m = d.warpMesh;
  const W = canvas.width, H = canvas.height;
  const pad = Math.min(W, H) * 0.06;
  const Wf = W - pad * 2, Hf = H - pad * 2;
  let bestIdx = -1, bestDist = hitRadius;
  // 6.6.19: in bezier mode, hit-test against control points instead
  // of mesh vertices. The flat-index space is the bezier control
  // grid (small) rather than the dense mesh (~1000 verts).
  if (m._bezier) {
    const b = m._bezier;
    const bcols1 = b.cols + 1, brows1 = b.rows + 1;
    for (let r2 = 0; r2 < brows1; r2++) {
      for (let c = 0; c < bcols1; c++) {
        const i = (r2 * bcols1 + c) * 2;
        const px = pad + (b.ctrl[i] + 1) * 0.5 * Wf;
        const py = pad + (1 - (b.ctrl[i+1] + 1) * 0.5) * Hf;
        const dist = Math.hypot(cx - px, cy - py);
        if (dist < bestDist) { bestDist = dist; bestIdx = r2 * bcols1 + c; }
      }
    }
    return { idx: bestIdx, cx, cy };
  }
  // Mesh mode (legacy).
  const cols1 = m.cols + 1, rows1 = m.rows + 1;
  for (let r2 = 0; r2 < rows1; r2++) {
    for (let c = 0; c < cols1; c++) {
      const i = (r2 * cols1 + c) * 5;
      const px = pad + (m.verts[i] + 1) * 0.5 * Wf;
      const py = pad + (1 - (m.verts[i+1] + 1) * 0.5) * Hf;
      const dist = Math.hypot(cx - px, cy - py);
      if (dist < bestDist) { bestDist = dist; bestIdx = r2 * cols1 + c; }
    }
  }
  return { idx: bestIdx, cx, cy };
}

/* Convert canvas pixel position to mesh NDC (mx, my). Inverse of the
 * meshToCanvas mapping in _drawWarpEditor. Clamped to the editable
 * range so the user can't drag a point all the way off the canvas. */
function _warpEditorCanvasToNdc(canvas, cx, cy) {
  const W = canvas.width, H = canvas.height;
  const pad = Math.min(W, H) * 0.06;
  const Wf = W - pad * 2, Hf = H - pad * 2;
  const u = (cx - pad) / Wf;
  const v = (cy - pad) / Hf;
  const mx = Math.max(-1.5, Math.min(1.5, u * 2 - 1));
  const my = Math.max(-1.5, Math.min(1.5, (1 - v) * 2 - 1));
  return { mx, my };
}

/* One-time wiring of editor controls + canvas pointer events. */
let _warpEditorWired = false;
function _wireWarpEditor() {
  if (_warpEditorWired) return;
  _warpEditorWired = true;
  const canvas = document.getElementById("warp-editor-canvas");
  const closeBtn  = document.getElementById("warp-editor-close");
  const cancelBtn = document.getElementById("warp-editor-cancel");
  const saveBtn   = document.getElementById("warp-editor-save");
  const resSel    = document.getElementById("warp-editor-res");
  const resetBtn  = document.getElementById("warp-editor-reset");

  // × button at the top-right is "save & close" — matches the
  // universal modern-web-app convention (Notion, Google Docs, etc.)
  // where clicking the corner X commits the work. Cancel button in
  // the footer is the explicit discard path; Esc also cancels for
  // keyboard fluency.
  if (closeBtn)  closeBtn.addEventListener("click",  () => closeWarpEditor(true));
  if (cancelBtn) cancelBtn.addEventListener("click", () => closeWarpEditor(false));
  if (saveBtn)   saveBtn.addEventListener("click",   () => closeWarpEditor(true));

  // 6.6.19: mode toggle (Mesh ↔ Bezier).
  const modeSel = document.getElementById("warp-editor-mode");
  if (modeSel) {
    modeSel.addEventListener("change", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      const target = modeSel.value;
      const isCurrentlyBezier = !!(d.warpMesh._bezier);
      if (target === "bezier" && !isCurrentlyBezier) {
        // Mesh → Bezier. If the current mesh has user edits, warn —
        // a fresh identity Bezier overwrites them. (Future work: a
        // least-squares fit of the existing mesh to a Bezier patch.)
        const hasEdits = !!d.warpMesh._isCustom || !!d.warpMesh._isAutoBlend || !!d.warpMesh._isTest;
        if (hasEdits) {
          const ok = (typeof confirm === "function")
            ? confirm("Switch to Bezier mode? The current mesh edits will be replaced with an identity Bezier patch (no warp). The corner X / Save still preserves whichever shape is on screen at the time.")
            : true;
          if (!ok) {
            modeSel.value = "mesh";
            return;
          }
        }
        // Default Bezier: 5×5 control points (degree 4) — enough for
        // AlloSphere-class smooth curvature.
        const degSel = document.getElementById("warp-editor-degree");
        const deg = degSel ? Math.max(2, parseInt(degSel.value, 10) || 4) : 4;
        const bez = _makeIdentityBezier(deg, deg);
        d.warpMesh = _bezierToWarpMesh(bez, BEZIER_MESH_TESS, BEZIER_MESH_TESS);
        d.warpMesh._isCustom = !!hasEdits;   // preserve edited-flag if user already had edits
      } else if (target === "mesh" && isCurrentlyBezier) {
        // Bezier → Mesh. Keep the dense tessellated mesh (the user
        // sees the same warp) and drop the bezier control grid. They
        // can now hand-edit individual mesh verts.
        delete d.warpMesh._bezier;
      }
      _updateWarpEditorModeUI(target);
      // Reset drag state and force a redraw with the new representation.
      _warpEditor.draggedVertex = -1;
      _warpEditor.hoverVertex = -1;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }

  // 6.6.19: bezier degree change. Rebuilds the control grid at the
  // new size; existing edits are not preserved (no fitter yet).
  const degSel = document.getElementById("warp-editor-degree");
  if (degSel) {
    degSel.addEventListener("change", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh || !d.warpMesh._bezier) return;
      const deg = Math.max(2, parseInt(degSel.value, 10) || 4);
      const hasEdits = !!d.warpMesh._isCustom;
      if (hasEdits) {
        const ok = (typeof confirm === "function")
          ? confirm("Change Bezier degree? Existing control-point edits will be reset.")
          : true;
        if (!ok) {
          // Restore dropdown to current degree.
          degSel.value = String(d.warpMesh._bezier.cols);
          return;
        }
      }
      const bez = _makeIdentityBezier(deg, deg);
      d.warpMesh = _bezierToWarpMesh(bez, BEZIER_MESH_TESS, BEZIER_MESH_TESS);
      _warpEditor.draggedVertex = -1;
      _warpEditor.hoverVertex = -1;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }

  if (resSel) {
    resSel.addEventListener("change", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d) return;
      let newCols, newRows;
      if (resSel.value === "custom") {
        // Prompt for "cols × rows" — accepts "16x12", "16 12", "16",
        // "16, 12". Any non-numeric falls back to the previous mesh
        // dimensions. Capped at 64 to protect the GPU buffers.
        const cur = d.warpMesh ? (d.warpMesh.cols + " × " + d.warpMesh.rows) : "8 × 8";
        const ans = (typeof prompt === "function")
          ? prompt("Mesh resolution (cols × rows, max 64):", cur)
          : null;
        if (!ans) {
          // User canceled — restore the dropdown to the current mesh's
          // dimensions so the UI stays consistent.
          if (d.warpMesh) resSel.value = String(d.warpMesh.cols);
          return;
        }
        const nums = ans.match(/\d+/g);
        if (!nums || !nums.length) {
          if (d.warpMesh) resSel.value = String(d.warpMesh.cols);
          return;
        }
        newCols = Math.max(1, Math.min(64, parseInt(nums[0], 10)));
        newRows = nums.length > 1
          ? Math.max(1, Math.min(64, parseInt(nums[1], 10)))
          : newCols;
      } else {
        const v = parseInt(resSel.value, 10);
        if (!Number.isFinite(v) || v < 2) return;
        newCols = newRows = v;
      }
      // Resample into the new dim. If triangular is on, regenerate
      // from scratch (offset rows) — there's no useful interpretation
      // of "preserve the warp + add row offset," so the toggle wins.
      const triCheck = document.getElementById("warp-editor-triangular");
      const triangular = !!(triCheck && triCheck.checked);
      d.warpMesh = triangular
        ? _makeTriangularWarpMesh(newCols, newRows)
        : _resampleWarpMesh(d.warpMesh, newCols, newRows);
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }
  const triCheckbox = document.getElementById("warp-editor-triangular");
  if (triCheckbox) {
    triCheckbox.addEventListener("change", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      // Regenerate at the current dim — toggling triangular discards
      // any in-progress hand-edits (sensible: the offset is a
      // generation-time choice, not a per-vertex edit). The existing
      // Bourke mesh format stores the offset baked into vert positions
      // so once saved, it's just a normal mesh.
      d.warpMesh = triCheckbox.checked
        ? _makeTriangularWarpMesh(d.warpMesh.cols, d.warpMesh.rows)
        : _makeIdentityWarpMesh(d.warpMesh.cols, d.warpMesh.rows);
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      // 6.6.19: in bezier mode reset rebuilds an identity bezier at
      // the current degree; the dense mesh follows from tessellation.
      if (d.warpMesh._bezier) {
        const deg = d.warpMesh._bezier.cols;
        const bez = _makeIdentityBezier(deg, deg);
        d.warpMesh = _bezierToWarpMesh(bez, BEZIER_MESH_TESS, BEZIER_MESH_TESS);
      } else {
        const triangular = !!(triCheckbox && triCheckbox.checked);
        d.warpMesh = triangular
          ? _makeTriangularWarpMesh(d.warpMesh.cols, d.warpMesh.rows)
          : _makeIdentityWarpMesh(d.warpMesh.cols, d.warpMesh.rows);
      }
      _warpEditor.draggedVertex = -1;
      _warpEditor.hoverVertex = -1;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }

  if (canvas) {
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2) return;            // right-click handled by contextmenu
      const hit = _warpEditorHitTest(canvas, e.clientX, e.clientY, 18);
      if (hit.idx >= 0) {
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        _warpEditor.draggedVertex = hit.idx;
        _drawWarpEditor();
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      if (_warpEditor.draggedVertex >= 0) {
        // Drag the active vertex.
        const r = canvas.getBoundingClientRect();
        const sx = canvas.width  / r.width;
        const sy = canvas.height / r.height;
        const cx = (e.clientX - r.left) * sx;
        const cy = (e.clientY - r.top)  * sy;
        const ndc = _warpEditorCanvasToNdc(canvas, cx, cy);
        // 6.6.19: in bezier mode the dragged index is into the
        // control grid (cols+1 stride per row), not the dense mesh.
        // After updating the ctrl point we re-tessellate the mesh
        // verts so the GPU pipeline sees the new surface immediately.
        if (d.warpMesh._bezier) {
          const offset = _warpEditor.draggedVertex * 2;
          d.warpMesh._bezier.ctrl[offset + 0] = ndc.mx;
          d.warpMesh._bezier.ctrl[offset + 1] = ndc.my;
          _rebuildMeshFromBezier(d.warpMesh);
        } else {
          const offset = _warpEditor.draggedVertex * 5;
          d.warpMesh.verts[offset + 0] = ndc.mx;
          d.warpMesh.verts[offset + 1] = ndc.my;
        }
        // Editing makes the mesh "custom" — user-authored. Drop the
        // auto-/test- flags so the rig pane's warp pill flips to
        // "warp: custom" (red rim, doesn't get clobbered by pill
        // cycle without confirm) and a re-run of Auto-blend leaves
        // it alone.
        d.warpMesh._isAutoBlend = false;
        d.warpMesh._isTest      = false;
        d.warpMesh._isCustom    = true;
        if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
        _drawWarpEditor();
      } else {
        // Hover preview.
        const hit = _warpEditorHitTest(canvas, e.clientX, e.clientY, 14);
        if (hit.idx !== _warpEditor.hoverVertex) {
          _warpEditor.hoverVertex = hit.idx;
          _drawWarpEditor();
        }
      }
    });
    const endDrag = (e) => {
      if (_warpEditor.draggedVertex < 0) return;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      _warpEditor.draggedVertex = -1;
      _drawWarpEditor();
    };
    canvas.addEventListener("pointerup",     endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    // Right-click → reset that vertex / control point to its identity
    // NDC position. In bezier mode we also re-tessellate the mesh
    // from the (now-reset) control grid.
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      const hit = _warpEditorHitTest(canvas, e.clientX, e.clientY, 18);
      if (hit.idx < 0) return;
      if (d.warpMesh._bezier) {
        const b = d.warpMesh._bezier;
        const bcols1 = b.cols + 1;
        const r = Math.floor(hit.idx / bcols1);
        const c = hit.idx % bcols1;
        const off = hit.idx * 2;
        b.ctrl[off + 0] = (c / b.cols) * 2 - 1;
        b.ctrl[off + 1] = (r / b.rows) * 2 - 1;
        _rebuildMeshFromBezier(d.warpMesh);
      } else {
        const cols1 = d.warpMesh.cols + 1;
        const r = Math.floor(hit.idx / cols1);
        const c = hit.idx % cols1;
        const off = hit.idx * 5;
        d.warpMesh.verts[off + 0] = (c / d.warpMesh.cols) * 2 - 1;
        d.warpMesh.verts[off + 1] = (r / d.warpMesh.rows) * 2 - 1;
      }
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }

  // Esc cancels the editor.
  document.addEventListener("keydown", (e) => {
    if (!_warpEditor.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeWarpEditor(false);
    }
  });
}

/* ------------ Phase 6.6.11 — auto-blend overlap detection -------------- */

/* For display index i, compute how many degrees of pose-space it
 * overlaps with each of its neighbors on the four sides. Returns
 * { left, right, top, bottom } in degrees of yaw / pitch.
 *
 * Algorithm: each display has a footprint rectangle in (yaw, pitch)
 * space:
 *     yaw  ∈ [pose.yaw  - fov.h/2, pose.yaw  + fov.h/2]
 *     pitch ∈ [pose.pitch - fov.v/2, pose.pitch + fov.v/2]
 *
 * For each OTHER display j whose pitch range overlaps this display's
 * pitch range:
 *   - if j sits to the left (j.yaw_max > my.yaw_min, j.yaw < my.yaw)
 *     → left overlap = j.yaw_max - my.yaw_min, take max
 *   - if j sits to the right → mirror
 *
 * Vertical overlaps (top / bottom) gated on yaw-range overlap.
 *
 * Yaw wrap-around (a 360° rig where the last display loops back to
 * the first) is handled by trying both raw and ±360° offsets and
 * picking the one with smallest absolute pose difference.
 *
 * Returns 0 on a side that has no neighbor overlapping it — used to
 * decide which sides get an intensity ramp. */
function _computeOverlapBands(i, displays) {
  if (!displays || !displays[i]) return { left: 0, right: 0, top: 0, bottom: 0 };
  const me = displays[i];
  const myPose = me.pose || { yaw: 0, pitch: 0 };
  const myFov  = me.fov  || { h: 90, v: 60 };
  const myYawMin   = myPose.yaw   - myFov.h * 0.5;
  const myYawMax   = myPose.yaw   + myFov.h * 0.5;
  const myPitchMin = myPose.pitch - myFov.v * 0.5;
  const myPitchMax = myPose.pitch + myFov.v * 0.5;

  let left = 0, right = 0, top = 0, bottom = 0;

  for (let j = 0; j < displays.length; j++) {
    if (j === i) continue;
    const o = displays[j];
    if (!o) continue;
    const oPose = o.pose || { yaw: 0, pitch: 0 };
    const oFov  = o.fov  || { h: 90, v: 60 };

    // Try yaw offsets of {-360, 0, +360} so 360° wraparound rigs detect
    // the wrap-around neighbor. Pick the offset with the smallest yaw
    // distance — that's the actual "nearest" instance of the neighbor.
    let bestOPose = oPose;
    let bestDist  = Math.abs(oPose.yaw - myPose.yaw);
    for (const off of [-360, 360]) {
      const d = Math.abs(oPose.yaw + off - myPose.yaw);
      if (d < bestDist) { bestDist = d; bestOPose = { yaw: oPose.yaw + off, pitch: oPose.pitch }; }
    }
    const oYawMin   = bestOPose.yaw   - oFov.h * 0.5;
    const oYawMax   = bestOPose.yaw   + oFov.h * 0.5;
    const oPitchMin = bestOPose.pitch - oFov.v * 0.5;
    const oPitchMax = bestOPose.pitch + oFov.v * 0.5;

    // Pitch overlap is required to count as a horizontal neighbor.
    const pitchOverlap = !(oPitchMax <= myPitchMin || oPitchMin >= myPitchMax);
    const yawOverlap   = !(oYawMax   <= myYawMin   || oYawMin   >= myYawMax);

    if (pitchOverlap) {
      // j to the left of me, and j extends INTO my left edge?
      if (bestOPose.yaw < myPose.yaw && oYawMax > myYawMin) {
        const overlap = oYawMax - myYawMin;
        if (overlap > left) left = overlap;
      }
      // j to the right of me?
      if (bestOPose.yaw > myPose.yaw && oYawMin < myYawMax) {
        const overlap = myYawMax - oYawMin;
        if (overlap > right) right = overlap;
      }
    }
    if (yawOverlap) {
      // j above me?
      if (bestOPose.pitch > myPose.pitch && oPitchMin < myPitchMax) {
        const overlap = myPitchMax - oPitchMin;
        if (overlap > top) top = overlap;
      }
      // j below me?
      if (bestOPose.pitch < myPose.pitch && oPitchMax > myPitchMin) {
        const overlap = oPitchMax - myPitchMin;
        if (overlap > bottom) bottom = overlap;
      }
    }
  }
  return { left, right, top, bottom };
}

/* Build an identity warp mesh whose intensity values ramp at the
 * overlapping edges. Non-overlapping vertices stay at intensity 1
 * (full brightness, no blend); overlap regions ramp linearly from 0
 * at the outer edge to 1 at the inner overlap boundary.
 *
 * The cooperating display's mirror ramp (computed by the same
 * algorithm) crosses the same overlap zone in the opposite direction,
 * so the sum of the two intensities at any point in the overlap is
 * 1 (linearly). Combined with the WGSL power curve (default 2) the
 * intensities sum to ≈1 in the overlap when both projectors fire,
 * which is what edge-blend depends on.
 *
 * Geometry stays identity (no warp) — auto-blend only generates
 * intensity ramps; geometric warp comes from MPCDI / hand-edited
 * meshes (6.6.2 / 6.6.9). _isAutoBlend tags the mesh so the rig
 * pane's pill cycle can recognize it. */
/* Phase 6.6.16 (Raskar #4) — project a 3D world point P back to a
 * specific display's framebuffer UV via gnomonic projection. Returns
 * { u, v, inFrame } where (u, v) ∈ [0, 1]² covers the display's full
 * framebuffer; inFrame is false when P is behind the projector or
 * outside its fov.
 *
 * Projector at rig origin facing pose direction. P transforms into
 * the display's local right/up/forward frame; localZ < 0 means
 * behind the projector (skip); the perspective divide gives NDC
 * within ±tan(fov/2). */
function _projectorFramebufferUV(P, display) {
  const pose = display.pose || { yaw: 0, pitch: 0 };
  const fov  = display.fov  || { h: 90, v: 60 };
  const yr = pose.yaw   * _DEG2RAD;
  const pr = pose.pitch * _DEG2RAD;
  const fx = Math.sin(yr) * Math.cos(pr);
  const fy = Math.sin(pr);
  const fz = Math.cos(yr) * Math.cos(pr);
  let altUpX = 0, altUpY = 1, altUpZ = 0;
  if (Math.abs(fy) > 0.95) { altUpX = 0; altUpY = 0; altUpZ = 1; }
  let rx = altUpY * fz - altUpZ * fy;
  let ry = altUpZ * fx - altUpX * fz;
  let rz = altUpX * fy - altUpY * fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  const localX = P[0] * rx + P[1] * ry + P[2] * rz;
  const localY = P[0] * ux + P[1] * uy + P[2] * uz;
  const localZ = P[0] * fx + P[1] * fy + P[2] * fz;
  if (localZ < 0.001) return { u: 0, v: 0, inFrame: false };

  const tanH = Math.tan(fov.h * 0.5 * _DEG2RAD);
  const tanV = Math.tan(fov.v * 0.5 * _DEG2RAD);
  const ndcX = localX / (localZ * tanH);
  const ndcY = localY / (localZ * tanV);
  const u = (ndcX + 1) * 0.5;
  const v = (ndcY + 1) * 0.5;
  return {
    u, v,
    inFrame: u >= 0 && u <= 1 && v >= 0 && v <= 1
  };
}

/* Phase 6.6.16 (Raskar §4.4) — screen-space alpha-blend mesh.
 * For each mesh vertex:
 *   1. Cast ray from origin through this display's framebuffer NDC.
 *   2. Hit the screen surface (sphere / cylinder) → 3D point P.
 *   3. For each display j (incl. self), project P back to j's
 *      framebuffer; compute d_j = min(u, v, 1-u, 1-v) — distance
 *      from the projector frame's edge — when P falls in j's frame.
 *   4. This vertex's intensity α = d_self / Σ_j d_j.
 *
 * Properties:
 *   • α sums to 1.0 across overlapping projectors at every screen
 *     point (Raskar §4.4 fundamental).
 *   • α → 0 at frame boundaries (smooth fade-out).
 *   • α = 1 in regions where only one projector covers (no overlap).
 *
 * vs. the angular-band approximation (_makeAutoBlendMesh): correct
 * for curved screens where neighbors don't share simple yaw/pitch
 * extents. Identical in the simple flat-tangent-plane case. */
function _makeScreenSpaceBlendMesh(cols, rows, display, displays, displayIdx, surface, hardCuts, existingMesh) {
  // 6.6.20.15 — preserve auto-warp NDC positions if an existing
  // warp mesh is passed in (and matches dimensions). Without this,
  // _applyAutoBlendToRig overwrote auto-warp's positions with
  // identity and the chain "auto-warp → auto-blend" effectively
  // discarded the warp step. Now both stack: positions from
  // auto-warp, alphas from auto-blend.
  let m;
  if (existingMesh && _validateWarpMesh(existingMesh) &&
      existingMesh.cols === cols && existingMesh.rows === rows) {
    m = _cloneWarpMesh(existingMesh);
    // Reset alphas to 1 — we'll recompute below.
    const W0 = cols + 1, H0 = rows + 1;
    for (let i = 0; i < W0 * H0; i++) m.verts[i * 5 + 4] = 1;
  } else {
    m = _makeIdentityWarpMesh(cols, rows);
  }
  if (!surface || surface.type === "free") return m;

  const W = cols + 1, H = rows + 1;
  const pose = display.pose || { yaw: 0, pitch: 0 };
  const fov  = display.fov  || { h: 90, v: 60 };

  const yr = pose.yaw   * _DEG2RAD;
  const pr = pose.pitch * _DEG2RAD;
  const fx = Math.sin(yr) * Math.cos(pr);
  const fy = Math.sin(pr);
  const fz = Math.cos(yr) * Math.cos(pr);
  let altUpX = 0, altUpY = 1, altUpZ = 0;
  if (Math.abs(fy) > 0.95) { altUpX = 0; altUpY = 0; altUpZ = 1; }
  let rx = altUpY * fz - altUpZ * fy;
  let ry = altUpZ * fx - altUpX * fz;
  let rz = altUpX * fy - altUpY * fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;
  const tanH = Math.tan(fov.h * 0.5 * _DEG2RAD);
  const tanV = Math.tan(fov.v * 0.5 * _DEG2RAD);

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      // 6.6.20.15 — use the vertex's CURRENT NDC (which may already
      // be auto-warped) instead of identity grid. Beam direction
      // and screen point P are then correct for whatever warp the
      // mesh already has applied.
      const off = (r * W + c) * 5;
      const ndcX = m.verts[off + 0];
      const ndcY = m.verts[off + 1];
      const lx = ndcX * tanH, ly = ndcY * tanV, lz = 1;
      const wx = rx*lx + ux*ly + fx*lz;
      const wy = ry*lx + uy*ly + fy*lz;
      const wz = rz*lx + uz*ly + fz*lz;

      let t = -1;
      if (surface.type === "sphere") {
        t = _raySphereDistance([0,0,0], [wx,wy,wz], surface.center || [0,0,0], surface.radius || 5);
      } else if (surface.type === "cylinder") {
        t = _rayCylinderDistanceY([0,0,0], [wx,wy,wz], surface.center || [0,0,0],
                                   surface.radius || 5, surface.length || 5);
      } else if (surface.type === "swept") {
        // 6.6.20 — generic surface of revolution. Profile-polyline
        // intersection in the yaw slice; t is the 3D distance.
        t = _raySweptSurfaceDistance([0,0,0], [wx,wy,wz], surface);
      } else {
        // Plane / free: treat as if only this projector covers
        // → identity intensity. Skip.
        continue;
      }
      if (t <= 0) continue;
      const Px = wx * t, Py = wy * t, Pz = wz * t;

      // Self-distance: derived from the vertex's own framebuffer UV
      // (the ray from origin we just cast came FROM this UV, so the
      // re-projection of P back to self is bit-exact this UV).
      const selfU = c / cols, selfV = r / rows;
      const dSelf = Math.max(0, Math.min(selfU, selfV, 1 - selfU, 1 - selfV));

      // 6.6.20.10 — hard-cuts mode now uses POWER-WEIGHTED soft-max
      // (k=8) instead of strict argmax. With k=8, alpha ≈ 1.0 inside
      // a projector's "won" region and ≈ 0.0 outside, but the
      // transition is smoothed across ~1 pixel of width. This
      // eliminates the X-shape Voronoi-edge artifacts that argmax
      // produced at corners where 4 projectors meet equidistant from
      // their frame edges (rasterizer aliasing of the diagonal
      // tiebreaker line was the visible cause).
      //
      // For k → ∞ this approaches argmax; k=8 is the sweet spot
      // empirically — clean cuts visually with no jaggies.
      const HARDCUT_POWER = 8;
      let dSum = dSelf;
      let powTotal = hardCuts ? Math.pow(Math.max(0.001, dSelf), HARDCUT_POWER) : 0;
      for (let j = 0; j < displays.length; j++) {
        if (j === displayIdx) continue;
        const dj = displays[j];
        if (!dj) continue;
        const proj = _projectorFramebufferUV([Px, Py, Pz], dj);
        if (!proj.inFrame) continue;
        const d = Math.max(0, Math.min(proj.u, proj.v, 1 - proj.u, 1 - proj.v));
        dSum += d;
        if (hardCuts) powTotal += Math.pow(Math.max(0.001, d), HARDCUT_POWER);
      }
      let alpha;
      if (hardCuts) {
        alpha = powTotal > 1e-9 ? Math.pow(Math.max(0.001, dSelf), HARDCUT_POWER) / powTotal : 1.0;
      } else {
        alpha = dSum > 0.0001 ? (dSelf / dSum) : 1.0;
      }
      m.verts[(r * W + c) * 5 + 4] = alpha;
    }
  }
  m._isAutoBlend = true;
  m._isScreenSpace = true;
  if (hardCuts) m._isHardCuts = true;
  return m;
}

function _makeAutoBlendMesh(cols, rows, display, displays, displayIdx) {
  const m = _makeIdentityWarpMesh(cols, rows);
  const fov = display.fov || { h: 90, v: 60 };
  const bands = _computeOverlapBands(displayIdx, displays);

  // Convert overlap band degrees → fractional U / V (normalized 0..1).
  const leftU   = bands.left   > 0 ? Math.min(0.5, bands.left   / fov.h) : 0;
  const rightU  = bands.right  > 0 ? Math.min(0.5, bands.right  / fov.h) : 0;
  const topV    = bands.top    > 0 ? Math.min(0.5, bands.top    / fov.v) : 0;
  const bottomV = bands.bottom > 0 ? Math.min(0.5, bands.bottom / fov.v) : 0;

  const W = cols + 1, H = rows + 1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      let intensity = 1;
      // Each ramp is linear from 0 at the outer edge to 1 at the inner
      // overlap boundary; outside the overlap region intensity stays at 1.
      // The min across all four sides handles corner overlaps gracefully
      // (a corner that overlaps both its left and top neighbor takes the
      // smaller intensity, which is correct for the symmetric blend).
      if (leftU   > 0 && u < leftU)        intensity = Math.min(intensity, u / leftU);
      if (rightU  > 0 && u > 1 - rightU)   intensity = Math.min(intensity, (1 - u) / rightU);
      if (topV    > 0 && v > 1 - topV)     intensity = Math.min(intensity, (1 - v) / topV);
      if (bottomV > 0 && v < bottomV)      intensity = Math.min(intensity, v / bottomV);
      m.verts[(r * W + c) * 5 + 4] = intensity;
    }
  }
  m._isAutoBlend = true;
  m._overlapBands = bands;     // surfaced in tooltips / diagnostics
  return m;
}

/* Apply auto-blend to every display in the rig that has at least
 * one overlapping neighbor. Displays in isolation (no overlap on
 * any side) get cleared — there's no neighbor for them to blend
 * with. Returns an array of { displayIdx, bands, applied } for the
 * caller's status reporting. */
/* ------------ Phase 6.6.15 — auto-warp from screen geometry ------------ */

/* Following Raskar et al. §3.3 (Camera-to-Projector Transfer): given a
 * known parametric screen surface + each projector's pose, compute
 * a per-vertex warp mesh that pre-distorts source content so the
 * audience at the sweet-spot sees a geometrically correct image.
 *
 * Math:
 *   For each mesh vertex (i, j):
 *     1. Compute projector ray from origin through framebuffer NDC,
 *        oriented by display.pose.
 *     2. Intersect with the screen surface → 3D point P.
 *     3. From sweet-spot S, compute audience direction = P - S.
 *     4. Convert audience direction to (yaw, pitch) angles → audience
 *        UV via equirect projection.
 *     5. Normalize into display.worldUv slice → mesh vertex's (mu, mv).
 *
 * For sphere-at-origin + sweet-spot-at-origin, this collapses to
 * identity (projector ray and audience ray coincide). Non-trivial
 * warp emerges when sweet-spot is offset from the projector position.
 *
 * Surface support:
 *   sphere   — full math (audience equirect from sweet-spot)
 *   cylinder — full math (cylindrical unwrap from axis)
 *   plane    — falls through to identity (perspective-from-origin
 *              already produces correct content for a flat screen
 *              when projector + sweet-spot are co-located, and the
 *              user can adjust if needed)
 *   free     — identity (no analytic geometry to invert)
 */
const _DEG2RAD = Math.PI / 180;
const _RAD2DEG = 180 / Math.PI;

function _raySphereDistance(O, D, center, radius) {
  const ox = O[0] - center[0], oy = O[1] - center[1], oz = O[2] - center[2];
  const a = D[0]*D[0] + D[1]*D[1] + D[2]*D[2];
  const b = 2 * (ox*D[0] + oy*D[1] + oz*D[2]);
  const c = ox*ox + oy*oy + oz*oz - radius*radius;
  const disc = b*b - 4*a*c;
  if (disc < 0) return -1;
  const sd = Math.sqrt(disc);
  const t1 = (-b - sd) / (2*a);
  const t2 = (-b + sd) / (2*a);
  // Want positive distance — for camera/projector inside the sphere
  // both roots are valid; outside, take the smaller positive.
  if (t1 > 0.001) return t1;
  if (t2 > 0.001) return t2;
  return -1;
}

function _rayCylinderDistanceY(O, D, center, radius, length) {
  // Cylinder axis assumed +Y for v1. Project ray onto XZ plane,
  // intersect with circle of radius `radius` centered at (center.x,
  // center.z). Then check that the hit's Y is within ±length/2 of
  // center.y.
  const ox = O[0] - center[0], oz = O[2] - center[2];
  const a = D[0]*D[0] + D[2]*D[2];
  if (a < 1e-9) return -1;        // ray parallel to axis — no XZ intersection
  const b = 2 * (ox*D[0] + oz*D[2]);
  const c = ox*ox + oz*oz - radius*radius;
  const disc = b*b - 4*a*c;
  if (disc < 0) return -1;
  const sd = Math.sqrt(disc);
  const t1 = (-b - sd) / (2*a);
  const t2 = (-b + sd) / (2*a);
  for (const t of [t1, t2]) {
    if (t > 0.001) {
      const py = O[1] + D[1] * t;
      if (Math.abs(py - center[1]) <= length * 0.5 + 0.001) return t;
    }
  }
  return -1;
}

/* Build a warp mesh for one display by ray-tracing each grid vertex
 * onto the screen surface, then projecting back from the sweet-spot
 * to find the audience-view UV. Returns identity mesh for free /
 * plane surfaces (no analytic inversion implemented). */
function _autoWarpMeshForDisplay(display, surface, sweetSpot, cols, rows) {
  cols = cols || 8;
  rows = rows || 8;
  const mesh = _makeIdentityWarpMesh(cols, rows);
  if (!surface || surface.type === "free" || surface.type === "plane") {
    // Plane case: when the screen is flat AND projector/sweet-spot
    // are co-located, perspective rendering is already correct.
    // Off-axis sweet-spots on a plane could be auto-warped but it's
    // rarely useful; user can hand-edit. Free has no analytic geometry.
    return mesh;
  }
  // sphere / cylinder / swept: full math below.

  const W = cols + 1, H = rows + 1;
  const pose = display.pose || { yaw: 0, pitch: 0, roll: 0 };
  const fov  = display.fov  || { h: 90, v: 60 };

  // Display's local-to-world basis (yaw + pitch only; roll skipped
  // for v1 — most templates leave it 0).
  const yr = pose.yaw   * _DEG2RAD;
  const pr = pose.pitch * _DEG2RAD;
  const fx = Math.sin(yr) * Math.cos(pr);
  const fy = Math.sin(pr);
  const fz = Math.cos(yr) * Math.cos(pr);
  // right = altUp × forward (matches the same convention used by
  // _theaterViewProjMatrix + _buildTheaterMeshGeometry, so the warp's
  // ray geometry stays consistent with what the gizmo + theater show).
  let altUpX = 0, altUpY = 1, altUpZ = 0;
  if (Math.abs(fy) > 0.95) { altUpX = 0; altUpY = 0; altUpZ = 1; }
  let rx = altUpY * fz - altUpZ * fy;
  let ry = altUpZ * fx - altUpX * fz;
  let rz = altUpX * fy - altUpY * fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  const tanH = Math.tan(fov.h * 0.5 * _DEG2RAD);
  const tanV = Math.tan(fov.v * 0.5 * _DEG2RAD);

  const slice = display.worldUv || { minU: 0, minV: 0, maxU: 1, maxV: 1 };
  const sliceW = Math.max(0.0001, slice.maxU - slice.minU);
  const sliceH = Math.max(0.0001, slice.maxV - slice.minV);

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      const ndcX = u * 2 - 1;
      const ndcY = v * 2 - 1;     // bottom-up per the Bourke convention

      // Local ray direction in display frame.
      const lx = ndcX * tanH;
      const ly = ndcY * tanV;
      const lz = 1;

      // Rotate to world frame.
      const wx = rx*lx + ux*ly + fx*lz;
      const wy = ry*lx + uy*ly + fy*lz;
      const wz = rz*lx + uz*ly + fz*lz;

      // Ray from rig origin through (wx, wy, wz). Intersect surface.
      let t = -1;
      if (surface.type === "sphere") {
        t = _raySphereDistance([0,0,0], [wx,wy,wz], surface.center || [0,0,0], surface.radius || 5);
      } else if (surface.type === "cylinder") {
        t = _rayCylinderDistanceY([0,0,0], [wx,wy,wz], surface.center || [0,0,0],
                                   surface.radius || 5, surface.length || 5);
      } else if (surface.type === "swept") {
        t = _raySweptSurfaceDistance([0,0,0], [wx,wy,wz], surface);
      }
      if (t <= 0) {
        // Ray missed the screen — keep identity mapping for this
        // vertex. Only happens at the edges of cylinder/cube cases.
        continue;
      }

      // Screen point P.
      const Px = wx * t, Py = wy * t, Pz = wz * t;
      // Audience direction from sweet-spot to P.
      const adx = Px - sweetSpot[0];
      const ady = Py - sweetSpot[1];
      const adz = Pz - sweetSpot[2];
      const adLen = Math.hypot(adx, ady, adz);
      if (adLen < 0.001) continue;
      const ax = adx / adLen, ay = ady / adLen, az = adz / adLen;

      // Audience yaw/pitch in degrees. Yaw=0 looks +Z; +X is yaw=+90.
      const audYawDeg   = Math.atan2(ax, az) * _RAD2DEG;
      const audPitchDeg = Math.asin(Math.max(-1, Math.min(1, ay))) * _RAD2DEG;

      // Equirect audience UV in rig master coords. yaw range
      // [-180, +180] → u [0, 1]. pitch [-90, +90] → v: mapping with
      // top-of-image = high pitch = audV near 0, so audV = (90 - pitch) / 180.
      const audU = (audYawDeg + 180) / 360;
      const audV = (90 - audPitchDeg) / 180;

      // Normalize into the display's worldUv slice.
      let mu = (audU - slice.minU) / sliceW;
      let mv = (audV - slice.minV) / sliceH;
      // Clamp tightly enough to remain inside [0, 1] so the warp
      // pipeline samples valid texels; with proper rig calibration
      // these should already be in range.
      if (mu < 0) mu = 0; else if (mu > 1) mu = 1;
      if (mv < 0) mv = 0; else if (mv > 1) mv = 1;

      const off = (r * W + c) * 5;
      mesh.verts[off + 0] = ndcX;
      mesh.verts[off + 1] = ndcY;
      mesh.verts[off + 2] = mu;
      mesh.verts[off + 3] = mv;
      mesh.verts[off + 4] = 1;
    }
  }
  mesh._isAutoWarp = true;
  return mesh;
}

/* Phase 6.6.20.16 — apply per-display keystone corner deltas to a
 * mesh, BILINEARLY blended across all vertices. Each corner shift
 * propagates through the mesh interior with weight (1-u)(1-v),
 * u(1-v), (1-u)v, uv per corner. The 4 corner verts get exactly
 * their proposed deltas; the center vert gets the average; mesh
 * stays smooth, no discontinuities.
 *
 * Called by _applyAutoWarpToRig + _applyAutoBlendToRig after they
 * generate a fresh mesh. Allows AI v3 to propose corner-level
 * keystone corrections that persist across iterations even though
 * the underlying mesh gets regenerated each auto-prep pass.
 *
 * NDC delta units: ±0.02 is typical (1% of framebuffer ≈ 5 px at
 * 1080p). Larger deltas warp aggressively. Per-pass clamp in the
 * iterative AI loop is ±0.02. */
/* Phase 6.6.20.17 — apply Bezier interior corrections (AI v4) on
 * top of the keystone layer. The bezierCorrections.ctrl array is
 * a (cols+1)×(rows+1)×2 grid of NDC offsets stored as deltas
 * (identity = all zeros). For each mesh vertex (u, v), evaluate
 * the tensor-product Bezier surface using these offsets as
 * control points, and shift the vertex by the result.
 *
 * Idempotent via mesh._hasBezierCorrections flag (preserved
 * through _cloneWarpMesh). Applied after keystone in both
 * auto-warp + auto-blend dispatchers so the chain is consistent.
 *
 * For sparse adjustments (most ctrl values 0, just a few non-zero),
 * the Bezier eval gracefully reduces to local bumps centered on
 * the non-zero control points, with smooth falloff to neighbors. */
function _applyBezierCorrectionsToMesh(mesh, bc) {
  if (!mesh || !_validateWarpMesh(mesh) || !bc) return;
  if (mesh._hasBezierCorrections) return;
  if (!Array.isArray(bc.ctrl) || !Number.isInteger(bc.cols) || !Number.isInteger(bc.rows)) return;
  // Skip cheap if all zeros.
  let sum = 0;
  for (let i = 0; i < bc.ctrl.length; i++) sum += Math.abs(bc.ctrl[i]);
  if (sum < 1e-6) return;
  const W = mesh.cols + 1, H = mesh.rows + 1;
  for (let r = 0; r < H; r++) {
    const v = r / mesh.rows;
    for (let c = 0; c < W; c++) {
      const u = c / mesh.cols;
      // _bezierEval interprets ctrl as positions; for delta ctrl
      // (identity = zero) it returns the bilinear-Bezier offset.
      const offset = _bezierEval(bc.ctrl, bc.cols, bc.rows, u, v);
      const i = (r * W + c) * 5;
      mesh.verts[i + 0] += offset.x;
      mesh.verts[i + 1] += offset.y;
    }
  }
}

function _applyKeystoneCornersToMesh(mesh, kc) {
  if (!mesh || !_validateWarpMesh(mesh) || !kc) return;
  if (mesh._hasKeystone) return;     // idempotent — already applied
  // Skip cheap if all zeros — most displays have no keystone applied.
  const sum = Math.abs(kc.tlx) + Math.abs(kc.tly) +
              Math.abs(kc.trx) + Math.abs(kc.try_) +
              Math.abs(kc.blx) + Math.abs(kc.bly) +
              Math.abs(kc.brx) + Math.abs(kc.bry);
  if (sum < 1e-6) return;
  const cols = mesh.cols, rows = mesh.rows;
  const W = cols + 1, H = rows + 1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = c / cols;
      const v = r / rows;
      const wTL = (1 - u) * (1 - v);
      const wTR = u       * (1 - v);
      const wBL = (1 - u) * v;
      const wBR = u       * v;
      const dx = wTL * kc.tlx + wTR * kc.trx + wBL * kc.blx + wBR * kc.brx;
      const dy = wTL * kc.tly + wTR * kc.try_ + wBL * kc.bly + wBR * kc.bry;
      const i = (r * W + c) * 5;
      mesh.verts[i + 0] += dx;
      mesh.verts[i + 1] += dy;
    }
  }
}

/* Apply auto-warp across the rig. Skipped for "free"/"plane" surfaces
 * + when surfaceVisible is OFF (user told us this is a monitor rig,
 * not a curved screen). Custom (user-edited) meshes are preserved. */
function _applyAutoWarpToRig(opts) {
  if (!state.rig || !Array.isArray(state.rig.displays)) return [];
  const surface = state.rig.surface;
  if (!surface || !state.rig.surfaceVisible) {
    if (!opts || !opts.silent) {
      alert("Auto-warp needs a screen surface (Sphere or Cylinder) and Screen visibility ON in the rig pane.");
    }
    return [];
  }
  if (surface.type === "free" || surface.type === "plane") {
    if (!opts || !opts.silent) {
      alert("Auto-warp on " + surface.type + " surfaces collapses to identity (projector and sweet-spot are co-located on a flat / free-form screen). Use Sphere or Cylinder for analytic warp.");
    }
    return [];
  }
  const ss = state.rig.sweetSpot || [0, 0, 0];
  const out = [];
  if (!opts || !opts.skipHistory) pushHistory("rig-auto-warp");
  state.rig.displays.forEach((d, i) => {
    if (!d) return;
    if (d.warpMesh && d.warpMesh._isCustom) {
      out.push({ displayIdx: i, applied: false, skipped: "custom" });
      return;
    }
    // 6.6.20.15 — auto-warp default density is 128 (MESH_CAP) for
    // scientific-grade pixel-accuracy. Auto-blend below uses the
    // same density so the chain stays consistent. ~10s build time
    // for 26 displays at 128² — slow but worth it for the
    // pixel-accurate boundary alignment scientific work needs.
    const WARP_MESH_DENSITY = 128;
    const mesh = _autoWarpMeshForDisplay(d, surface, ss, WARP_MESH_DENSITY, WARP_MESH_DENSITY);
    // Phase 6.6.20.16 — apply keystone corner deltas (AI v3) so they
    // persist through this regeneration. Idempotent: marks the mesh
    // _hasKeystone after applying so downstream auto-blend doesn't
    // double-apply.
    _applyKeystoneCornersToMesh(mesh, d.keystoneCorners);
    mesh._hasKeystone = true;
    // 6.6.20.17 — Bezier interior corrections (AI v4) layer on top.
    _applyBezierCorrectionsToMesh(mesh, d.bezierCorrections);
    mesh._hasBezierCorrections = true;
    d.warpMesh = mesh;
    if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
    out.push({ displayIdx: i, applied: true });
  });
  if (state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
    state.rig.templateKey = "custom";
  }
  return out;
}

function _applyAutoBlendToRig(opts) {
  if (!state.rig || !Array.isArray(state.rig.displays)) return [];
  const out = [];
  // Optional: skipHistory (called from applyRigTemplate which already
  // pushed its own history entry); keepTemplate (don't flip to
  // "custom" — the template ITSELF is what triggered this, so the
  // dropdown should still show it).
  const skipHistory  = !!(opts && opts.skipHistory);
  const keepTemplate = !!(opts && opts.keepTemplate);
  const hardCuts     = !!(opts && opts.hardCuts);
  if (!skipHistory) pushHistory(hardCuts ? "rig-auto-blend-hardcuts" : "rig-auto-blend");
  // Phase 6.6.16 (Raskar #4) — choose between angular auto-blend
  // (the original, fast, works without surface info) and screen-
  // space alpha-blend (the Raskar-paper-correct version that uses
  // the actual screen surface). Screen-space wins when:
  //   • The rig has a parametric surface (sphere or cylinder)
  //   • surfaceVisible is ON (user hasn't told us this is monitors)
  // Otherwise fall back to angular bands.
  const surface = state.rig.surface;
  const useScreenSpace = !!(surface && state.rig.surfaceVisible &&
                            (surface.type === "sphere" || surface.type === "cylinder" || surface.type === "swept"));

  state.rig.displays.forEach((d, i) => {
    if (!d) return;
    // Phase 6.6.9 — custom (user-edited) meshes are sacred; auto-
    // blend leaves them alone. Otherwise a re-run after editing
    // would silently undo the user's hand-tuning.
    if (d.warpMesh && d.warpMesh._isCustom) {
      out.push({ displayIdx: i, applied: false, skipped: "custom" });
      return;
    }
    if (useScreenSpace) {
      // 6.6.20.15 — default density is 128 (the MESH_CAP) for
      // scientific-grade pixel-accurate boundaries. Compute scales
      // O(N² × num_displays_for_blend_check); at 128² × 26 displays
      // a single click takes ~5-10s. For faster interactive use,
      // drop this to 64 (5x faster, ~3x more accurate than the
      // pre-6.6.20.14 default of 32).
      //
      // 6.6.20.15 — also preserves existing auto-warp positions
      // when chaining (auto-prep does auto-warp → auto-blend, and
      // we want to keep the warp positions from step 1).
      const BLEND_MESH_DENSITY = 128;
      const existingWarp = (d.warpMesh && d.warpMesh._isAutoWarp &&
                            d.warpMesh.cols === BLEND_MESH_DENSITY &&
                            d.warpMesh.rows === BLEND_MESH_DENSITY) ? d.warpMesh : null;
      const mesh = _makeScreenSpaceBlendMesh(BLEND_MESH_DENSITY, BLEND_MESH_DENSITY,
        d, state.rig.displays, i, surface, hardCuts, existingWarp);
      // Phase 6.6.20.16 — keystone corners. _applyKeystoneCornersToMesh
      // is no-op when mesh._hasKeystone is true (auto-warp already
      // applied), so chained warp→blend doesn't double-apply.
      _applyKeystoneCornersToMesh(mesh, d.keystoneCorners);
      mesh._hasKeystone = true;
      // 6.6.20.17 — Bezier interior corrections (AI v4) on top.
      _applyBezierCorrectionsToMesh(mesh, d.bezierCorrections);
      mesh._hasBezierCorrections = true;
      d.warpMesh = mesh;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      out.push({ displayIdx: i, applied: true, mode: hardCuts ? "screen-space-hardcuts" : "screen-space" });
      return;
    }
    const bands = _computeOverlapBands(i, state.rig.displays);
    const overlapping = bands.left + bands.right + bands.top + bands.bottom;
    if (overlapping > 0.001) {
      d.warpMesh = _makeAutoBlendMesh(8, 8, d, state.rig.displays, i);
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      out.push({ displayIdx: i, bands, applied: true, mode: "angular" });
    } else {
      // No overlap → no blend ramp needed. Leave any existing mesh
      // alone (user might have a hand-edited geometric warp on this
      // display); only clear if it was previously auto-blend.
      if (d.warpMesh && d.warpMesh._isAutoBlend) {
        d.warpMesh = null;
        if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      }
      out.push({ displayIdx: i, bands, applied: false });
    }
  });
  if (!keepTemplate && state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
    state.rig.templateKey = "custom";
  }
  return out;
}

/* Quick validation for warpMesh objects loaded from .gpatch. Returns
 * true if the mesh has the expected shape and a vert array of the
 * correct length. Used in migrateDisplayShape to drop garbage meshes
 * silently — better to fall back to no-warp than render glitched
 * output from a malformed mesh. */
function _validateWarpMesh(m) {
  if (!m || typeof m !== "object") return false;
  if (!Number.isInteger(m.cols) || m.cols < 1) return false;
  if (!Number.isInteger(m.rows) || m.rows < 1) return false;
  if (!Array.isArray(m.verts))                 return false;
  const expected = (m.cols + 1) * (m.rows + 1) * 5;
  if (m.verts.length !== expected) return false;
  for (let i = 0; i < m.verts.length; i++) {
    if (!Number.isFinite(m.verts[i])) return false;
  }
  return true;
}

/* Edge-blend parameter defaults. These are the values applied by the
 * blend WGSL pass (Phase 6.6.5–6.6.8). Gamma 2.2 matches the standard
 * sRGB → linear gamma — applying it before blending and reversing
 * after gives perceptually-uniform brightness across the overlap.
 * blackLift and power start at "no perceptual effect" so a default-
 * configured rig that hasn't been hand-tuned simply renders the
 * identity blend. */
function _defaultEdgeBlend() {
  return { gamma: 2.2, blackLift: 0, power: 2.0 };
}

/* Validate edge-blend params loaded from .gpatch. Numbers must be
 * finite; gamma > 0 (avoid divide-by-zero); blackLift in [0, 1];
 * power > 0. Returns a clean object with any invalid fields replaced
 * by defaults. */
function _migrateEdgeBlend(eb) {
  const def = _defaultEdgeBlend();
  if (!eb || typeof eb !== "object") return def;
  const out = {
    gamma:     Number.isFinite(eb.gamma)     && eb.gamma     > 0 ? eb.gamma     : def.gamma,
    blackLift: Number.isFinite(eb.blackLift) && eb.blackLift >= 0 && eb.blackLift <= 1 ? eb.blackLift : def.blackLift,
    power:     Number.isFinite(eb.power)     && eb.power     > 0 ? eb.power     : def.power
  };
  return out;
}

function _makeDisplay(id, name, overrides) {
  return Object.assign({
    id,
    name,
    pose:      { yaw: 0, pitch: 0, roll: 0 },
    fov:       { h: 90, v: 60 },
    aspect:    16 / 9,
    curvature: 0,
    // Phase 6.6 — calibration warp + edge blend. null = no warp,
    // fullscreen-triangle pipeline. Becomes a Bourke mesh once the
    // user runs the warp editor (6.6.9) or imports MPCDI (6.6.2).
    warpMesh:  null,
    edgeBlend: _defaultEdgeBlend(),
    // Phase 6.6.20.16 — AI v3 keystone corner offsets. 8 floats in
    // NDC space (~ ±2 unit framebuffer). Applied AFTER auto-warp +
    // auto-blend as a bilinear shift across the mesh, so they
    // persist across auto-prep regenerations. Default 0; AI v3
    // proposes deltas during iterative calibration.
    keystoneCorners: { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 },
    // Phase 6.6.20.17 — AI v4 Bezier interior corrections. 5×5
    // grid of NDC offsets (50 floats) — mostly 0, populated
    // sparsely by Bezier fine-tune. Applied AFTER keystone via
    // tensor-product Bezier eval — each control point's offset
    // smoothly blends into the mesh interior. Default null; lazy-
    // inits when first non-zero adjustment applied.
    bezierCorrections: null,
    worldUv:   { minU: 0, minV: 0, maxU: 1, maxV: 1 }
  }, overrides);
}

/* Catalog of rig templates. Each builds a display list from a single
 * key. The math for cylindrical / spherical layouts:
 *   - Cylindrical: yaws spaced evenly around the azimuth covered by
 *     the rig (90° for quarter, 180° for half, 360° for full). Each
 *     display's worldUv.u range is its azimuth slice / total
 *     azimuth. v range is full [0,1].
 *   - Cube: 6 displays each looking down a cardinal axis (front /
 *     back / left / right / up / down). worldUv slices a cubemap
 *     unfold into 6 rectangles.
 *   - AlloSphere-like: 16 displays in a partial sphere matching the
 *     practical AlloSphere coverage (~360° H × ~150° V on a bisected
 *     sphere). worldUv slices an equirect master into 16 rects in a
 *     4-cols × 4-rows arrangement that approximates the dome's
 *     projector layout. Real AlloSphere has 26 projectors; 16 is
 *     the "consumer-class" approximation per docs/DISTRIBUTED-RIG.md
 *     §9.3. */
const RIG_TEMPLATES = {
  single: {
    label: "Single (1 display)",
    surface: { type: "plane", normal: [0, 0, 1], offset: 5 },
    build: () => [_makeDisplay("d0", "Display 1", {
      pose: { yaw: 0, pitch: 0, roll: 0 },
      fov:  { h: 90, v: 60 },
      worldUv: { minU: 0, minV: 0, maxU: 1, maxV: 1 }
    })]
  },
  "side-by-side": {
    label: "Side-by-side (2 flat)",
    surface: { type: "plane", normal: [0, 0, 1], offset: 5 },
    build: () => [
      _makeDisplay("d0", "Left", {
        pose: { yaw: -45, pitch: 0, roll: 0 },
        fov:  { h: 90, v: 60 },
        worldUv: { minU: 0,   minV: 0, maxU: 0.5, maxV: 1 }
      }),
      _makeDisplay("d1", "Right", {
        pose: { yaw:  45, pitch: 0, roll: 0 },
        fov:  { h: 90, v: 60 },
        worldUv: { minU: 0.5, minV: 0, maxU: 1,   maxV: 1 }
      })
    ]
  },
  "quarter-wrap": {
    label: "Quarter-wrap (4 flat, 90°)",
    surface: { type: "cylinder", radius: 5, axis: [0, 1, 0], length: 5, center: [0, 0, 0] },
    build: () => _evenAzimuthRing(4, 90, "Q")
  },
  "half-wrap": {
    label: "Half-wrap (8 flat, 180°)",
    surface: { type: "cylinder", radius: 5, axis: [0, 1, 0], length: 5, center: [0, 0, 0] },
    build: () => _evenAzimuthRing(8, 180, "H")
  },
  "full-wrap-16": {
    label: "Full-wrap (16 flat, 360°)",
    surface: { type: "cylinder", radius: 5, axis: [0, 1, 0], length: 5, center: [0, 0, 0] },
    build: () => _evenAzimuthRing(16, 360, "F")
  },
  cube: {
    label: "Cube (6 faces)",
    // Cube isn't a quadric — surface is a 6-faced polyhedron, marked
    // "free" so auto-warp falls back to identity. Sweet-spot defaults
    // to origin (cube center).
    surface: { type: "free" },
    build: () => {
      const pose = (yaw, pitch) => ({ yaw, pitch, roll: 0 });
      // Standard cubemap unfold: 4 sides + top + bottom in a 4×3 layout
      // but compressed into a 1×6 row in the master canvas for
      // simplicity. Each face is 1/6th of the master width.
      const f = 1 / 6;
      const fov = { h: 90, v: 90 };
      return [
        _makeDisplay("front",  "+Z front",  { pose: pose(0,    0),  fov, worldUv: { minU: 0*f, minV: 0, maxU: 1*f, maxV: 1 } }),
        _makeDisplay("right",  "+X right",  { pose: pose(90,   0),  fov, worldUv: { minU: 1*f, minV: 0, maxU: 2*f, maxV: 1 } }),
        _makeDisplay("back",   "-Z back",   { pose: pose(180,  0),  fov, worldUv: { minU: 2*f, minV: 0, maxU: 3*f, maxV: 1 } }),
        _makeDisplay("left",   "-X left",   { pose: pose(-90,  0),  fov, worldUv: { minU: 3*f, minV: 0, maxU: 4*f, maxV: 1 } }),
        _makeDisplay("top",    "+Y top",    { pose: pose(0,   90),  fov, worldUv: { minU: 4*f, minV: 0, maxU: 5*f, maxV: 1 } }),
        _makeDisplay("bottom", "-Y bottom", { pose: pose(0,  -90),  fov, worldUv: { minU: 5*f, minV: 0, maxU: 6*f, maxV: 1 } })
      ];
    }
  },
  "allosphere-like": {
    label: "AlloSphere-like (16 partial sphere)",
    surface: { type: "sphere", radius: 5, center: [0, 0, 0] },
    build: () => {
      // 4 columns × 4 rows on a partial sphere. Vertical FOV ≈ 150°
      // (bisected sphere), horizontal 360°. Each cell is one display.
      // worldUv tiles the equirect master into a 4×4 grid.
      const cols = 4, rows = 4;
      const out = [];
      const cellW = 1 / cols;
      const cellH = 1 / rows;
      const azimuthStep   = 360 / cols;
      const elevationStep = 150 / rows;   // partial sphere: 150° vertical
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const yaw   = -180 + (c + 0.5) * azimuthStep;        // span -180..180
          const pitch =  -75 + (r + 0.5) * elevationStep;      // span -75..75
          out.push(_makeDisplay("a" + idx, "Allo-" + (idx + 1), {
            pose: { yaw, pitch, roll: 0 },
            fov:  { h: azimuthStep, v: elevationStep },
            curvature: 22,   // soft curve, ≈ projector throw aperture
            worldUv: {
              minU: c * cellW, minV: r * cellH,
              maxU: (c + 1) * cellW, maxV: (r + 1) * cellH
            }
          }));
        }
      }
      return out;
    }
  },
  "allosphere-real": {
    label: "AlloSphere (real 26-projector layout)",
    surface: { type: "sphere", radius: 5, center: [0, 0, 0] },
    build: () => {
      // The real UCSB AlloSphere has 26 projectors arranged
      // asymmetrically across two listening hemispheres separated by
      // a catwalk seam at the equator. Ring counts approximate the
      // published "14 upper / 12 lower" channel split: more density
      // near the catwalk (where projector mounts have line-of-sight)
      // and sparser near the poles (which need wider-FOV optics).
      //
      // Rings (top → bottom):
      //   +60°: 5 projectors  ┐
      //   +20°: 9 projectors  ┘ 14 upper hemisphere
      //   ---  catwalk gap (no projectors near 0°)  ---
      //   -20°: 8 projectors  ┐
      //   -60°: 4 projectors  ┘ 12 lower hemisphere
      //
      // FOVs are sized to overlap slightly within each ring (azimuth
      // step + ~10% bleed) and to bridge between rings (~50° vertical
      // FOV per projector). worldUv tiles the equirect master in a
      // ring-by-ring band layout: top band 0..1/4 V, mid-top 1/4..2/4,
      // mid-bot 2/4..3/4, bottom 3/4..1.
      const rings = [
        { pitch:  60, count: 5, vBand: [0,    0.22] },
        { pitch:  20, count: 9, vBand: [0.22, 0.50] },
        { pitch: -20, count: 8, vBand: [0.50, 0.78] },
        { pitch: -60, count: 4, vBand: [0.78, 1.00] }
      ];
      const out = [];
      let idx = 0;
      for (const ring of rings) {
        const fovH = (360 / ring.count) * 1.10;     // 10% azimuth bleed
        const fovV = 50;
        const cellU = 1 / ring.count;
        for (let i = 0; i < ring.count; i++) {
          const yaw = -180 + (i + 0.5) * (360 / ring.count);
          out.push(_makeDisplay("ar" + idx, "Allo-" + (idx + 1), {
            pose: { yaw, pitch: ring.pitch, roll: 0 },
            fov:  { h: fovH, v: fovV },
            curvature: 30,   // sphere screen curve, dome-projection style
            worldUv: {
              minU:  i      * cellU, minV: ring.vBand[0],
              maxU: (i + 1) * cellU, maxV: ring.vBand[1]
            }
          }));
          idx++;
        }
      }
      return out;
    }
  }
};

/* Helper for cylindrical-wrap templates: N displays evenly spaced
 * across a horizontal arc of `azimuthDeg` total. Each display gets an
 * equal slice of worldUv along U. */
function _evenAzimuthRing(n, azimuthDeg, prefix) {
  const out = [];
  const fovH = azimuthDeg / n;
  const start = -azimuthDeg / 2;
  for (let i = 0; i < n; i++) {
    const yaw = start + (i + 0.5) * fovH;
    out.push(_makeDisplay(prefix + i, prefix + (i + 1), {
      pose: { yaw, pitch: 0, roll: 0 },
      fov:  { h: fovH, v: 60 },
      worldUv: {
        minU: i / n,       minV: 0,
        maxU: (i + 1) / n, maxV: 1
      }
    }));
  }
  return out;
}

/* Replace the rig's display list with the catalog template's output.
 * Preserves rig-level settings (masterRes, previewMode) so the user's
 * choice of resolution + projection survives a template swap. */
function applyRigTemplate(key) {
  const t = RIG_TEMPLATES[key];
  if (!t) return;
  pushHistory("rig-template:" + key);
  if (!state.rig) state.rig = defaultRig();
  state.rig.templateKey = key;
  state.rig.displays    = t.build();
  // Phase 6.6.14 — propagate the template's screen-surface descriptor
  // and re-derive the sweet-spot. Templates without an explicit surface
  // get a "free" default so auto-warp falls through to identity. The
  // sweet-spot is freshly derived because the user picking a new
  // template implies they want the canonical viewing position for
  // that geometry; if they tweak it after, their override persists
  // until the next template change.
  state.rig.surface   = _migrateRigSurface(t.surface || { type: "free" });
  state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface);
  // Reset the theater camera to the new sweet-spot so the next
  // entry to theater preview spawns the user at the canonical
  // viewing position. Yaw/pitch keep their last orientation —
  // changing positions but staying "facing" the same way is less
  // disorienting than a full reset.
  if (Visual && Visual.theaterCam) {
    Visual.theaterCam.pos[0] = state.rig.sweetSpot[0];
    Visual.theaterCam.pos[1] = state.rig.sweetSpot[1];
    Visual.theaterCam.pos[2] = state.rig.sweetSpot[2];
  }
  // Validate that any VisualOutput nodes still point at a valid
  // display index. Anything pointing past the new display count gets
  // clamped to the last available display.
  const max = state.rig.displays.length - 1;
  state.nodes.forEach(n => {
    if (n.type === "VisualOutput" && n.params && typeof n.params.display === "number") {
      if (n.params.display > max) n.params.display = max;
    }
  });
  // Phase 6.6.11 — auto-apply blend on template change. Templates
  // with overlapping pose footprints (allosphere-real with its 10%
  // azimuth bleed) get intensity ramps for free; templates without
  // overlap (single, side-by-side, quarter-wrap, etc.) skip silently
  // since _applyAutoBlendToRig no-ops on isolated displays. Saves a
  // click in the AlloSphere case, never penalizes the others.
  // skipHistory: outer pushHistory is the single undo entry for the
  // whole template+blend bundle.
  // keepTemplate: this IS the template apply path — don't flip to
  // "custom" since the dropdown still reflects the picked template.
  _applyAutoBlendToRig({ skipHistory: true, keepTemplate: true });
  // Phase 6.5.5 — display count changed → reallocate the texture array
  // + rebuild bind groups so subsequent renders target the new layer
  // count. Skips silently if the GPU device hasn't acquired yet
  // (ensureGPUDevice will run the alloc when it does).
  if (Visual.device) {
    _allocateFramebuffer();
    _rebuildBlitBindGroup();
    _rebuildRigCompositeBindGroup();
    _rebuildWarpBindGroup();
    _rebuildTheaterBindGroup();
  }
  render();
  renderProps && renderProps();
}

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
/* =========================================================================
 * Browser — node + asset library
 *
 * Replaces the original simple palette with a tabbed browser:
 *   • Nodes  — registry entries with auto-derived tag chips, vertical
 *              category rail, operator-syntax search (cat:/tag:/port:),
 *              detail drawer with description + ports + related links.
 *   • Assets — IDB-backed sample store + connection rail for cloud
 *              sources (Local FS, Google Drive, GitHub). For now the
 *              IDB-stored audio assets always show; the cloud sources
 *              ship as a UI shell, with Local FS using the File System
 *              Access API and Drive/GitHub stubbed out for v0.1.
 *
 * The legacy renderPalette(filterText) export is kept for back-compat
 * (it's called from a handful of places after addFromPalette + after
 * gdsp registers a new user node). It now delegates to the new render
 * pipeline.
 * ======================================================================== */

/* Tag derivation. Pulled from the def shape so we don't have to add
 * tag annotations to every TYPES entry manually:
 *   • gamma     — wraps a stock gam:: class OR a pure template
 *   • composite — uses a custom helper class (cppType set, not gam::)
 *   • multi-out — outs.length > 1
 *   • host      — kind === "micInput" / "host" / "keyboard" or uses
 *                 the editor's drawable-curve param (Ramp / Slider /
 *                 Button) or has zero audio inputs (live source nodes)
 *   • user-dsp  — registered through the .gdsp parser
 *   • draw      — has a drawable curve / pattern editor modal */
const _BR_HOST_NODES = new Set([
  "KeyboardIn","Button","Slider","Ramp","MicInput","PianoRoll","MultiPianoRoll",
]);
const _BR_DRAW_NODES = new Set([
  "Ramp","Slider","Button","WavetableScan","WavetableOsc","PianoRoll","MultiPianoRoll",
]);
function brDeriveTags(name, def) {
  const tags = [];
  if (def.isUserDsp) tags.push("user-dsp");
  else if ((def.cppType || "").startsWith("gam::") || (def.cppType === "" && def.template)) tags.push("gamma");
  else if (def.cppType) tags.push("composite");
  if (def.outs && def.outs.length > 1) tags.push("multi-out");
  if (_BR_HOST_NODES.has(name) || def.kind === "micInput" || def.kind === "host") tags.push("host");
  if (_BR_DRAW_NODES.has(name)) tags.push("draw");
  if (def.category === "Sink") tags.push("sink");
  return tags;
}

/* Per-category metadata for the rail. Reference numbers + tag lines
 * are display-only; the node category strings come straight from the
 * registry data. Categories not listed here still render — they just
 * get a generic "ext" tag and a placeholder reference. */
const _BR_CAT_META = {
  Oscillator: { ref: "01", tag: "wave generators" },
  Sample:     { ref: "02", tag: "playback · mic · asset" },
  Noise:      { ref: "03", tag: "stochastic" },
  Envelope:   { ref: "04", tag: "shaping · gates" },
  Filter:     { ref: "05", tag: "spectral" },
  Delay:      { ref: "06", tag: "temporal" },
  Effect:     { ref: "07", tag: "non-linear" },
  Analysis:   { ref: "08", tag: "feature extraction" },
  Convert:    { ref: "09", tag: "scale · clock · seq · input" },
  Math:       { ref: "10", tag: "arithmetic · logic · mix" },
  // 3D scene + render
  Scene:      { ref: "20", tag: "cameras · lights · sky · output" },
  Geometry:   { ref: "21", tag: "mesh primitives" },
  Material:   { ref: "22", tag: "surfaces · shading" },
  Transform:  { ref: "23", tag: "translate · rotate · scale" },
  Terrain:    { ref: "24", tag: "terrain · planet · water" },
  // Game systems
  Physics:    { ref: "30", tag: "bodies · colliders · joints · queries" },
  Game:       { ref: "31", tag: "lifecycle · FSM · stage · gameplay" },
  UI:         { ref: "32", tag: "widgets · HUD" },
  Sprite:     { ref: "33", tag: "2D · tilemap · level" },
  // Visual FX / compositing
  Source:     { ref: "40", tag: "video · image · text" },
  Generator:  { ref: "41", tag: "procedural shaders" },
  Composite:  { ref: "42", tag: "fx · masks · keying · color" },
  // Misc
  AI:         { ref: "50", tag: "vision · ML · landmarks" },
  "User DSP": { ref: "98", tag: ".gdsp · community" },
  Sink:       { ref: "99", tag: "output" },
};
function _brCatMeta(cat) {
  return _BR_CAT_META[cat] || { ref: "··", tag: "ext" };
}

/* The "Visual" registry category grew to ~170 nodes — unusable as one
 * list. Rather than re-tag every TYPES entry, we route Visual nodes
 * into finer display categories by name. Non-Visual categories pass
 * through unchanged. Unmatched Visual nodes fall to "Composite"
 * (the video-FX catch-all). */
const _VISUAL_SUBCAT = {
  Scene: ["Camera","FPCamera","OrthoCamera2D","OrthoCamera25D","ThirdPersonCamera","Scene","Scene3D","Scene2D","Scene25D","RayTracedScene","VisualOutput","DirectionalLight","PointLight","SpotLight","AreaLight","Sun","DayNightCycle","ProceduralSky","HDRI","Skybox","GradientSky","RigGizmo"],
  Geometry: ["Box","Sphere","Capsule","Plane","Torus","Cylinder","Cone","DebugTriangle","MeshTest","PlanetMesh","LoadGLB"],
  Material: ["UnlitMat","PhongMat","PhysicalMat","MirrorMat","GlassMat","ShaderMat","TerrainMaterial"],
  Transform: ["Translate","Rotate","Scale","MeshWorldPosition"],
  Physics: ["PhysicsWorld2D","RigidBody2D","BoxCollider2D","CircleCollider2D","CapsuleCollider2D","Raycast2D","OverlapCircle2D","OverlapBox2D","RevoluteJoint2D","DistanceJoint2D","PrismaticJoint2D","WeldJoint2D","ContactEvent2D","TilemapCollider2D","PhysicsWorld3D","RigidBody3D","BoxCollider3D","SphereCollider3D","CapsuleCollider3D","Raycast3D","OverlapSphere3D","HingeJoint3D","BallJoint3D","FixedJoint3D","DestructibleBody3D","FractureMesh","ContactForce3D","TerrainCollider","WaterCollider","Spherecast2D","Spherecast3D","ForceField3D","Wind3D","RopeJoint3D","Rope3D","Cloth3D","ClothPin3D","SoftBody3D","PhysicsRecord","PhysicsReplay"],
  Game: ["KeyAxis2D","PlatformerBody2D","BlobController3D","PickupCollector","LevelGoal2D","AnimationState2D","OnAwake","OnStart","OnUpdate","OnDestroy","EdgeCount","StageManager","StateMachine","Pool","PrefabInstance"],
  UI: ["UIButton","UIText","UIPanel","UISlider","Leaderboard","HUDText","Minimap","Altimeter"],
  Sprite: ["TileSpriteOverlay","ParallaxLayer2D","SpriteScatter2D","Tilemap2D","Level2D","ImageURL","SpriteCreator","Sprite"],
  Terrain: ["Planet","PlanetMap","Terrain","TiledTerrain","TerrainHorizon","Water","Clouds3D","ProceduralTerrain","TerrainErosion"],
  Source: ["Text","SolidColor","Webcam","VideoFile","ScreenShare","Gradient","Checkerboard"],
  Generator: ["Plasma","Voronoi","StarNest","Butterflies","NoiseShader","MatrixRain","ShapeTunnel","GammaScreensaver","WireframeCalibration"],
};
const _VISUAL_ROUTE = (() => {
  const m = {};
  for (const sub of Object.keys(_VISUAL_SUBCAT)) {
    for (const n of _VISUAL_SUBCAT[sub]) m[n] = sub;
  }
  return m;
})();
function _deriveNodeCategory(name, def) {
  if (!def) return "Visual";
  if (def.category !== "Visual") return def.category;
  return _VISUAL_ROUTE[name] || "Composite";
}

/* View state. The browser is a thin state machine on top of the
 * existing palette DOM — when state changes we re-render. */
const brState = {
  tab: "nodes",            // nodes | assets | patches
  mode: "list",            // list | grid
  search: "",
  catFilter: null,         // null = all categories
  selected: null,          // node name or null
  assetType: null,         // null | audio | midi | video | gpatch | gdsp
  assetSource: null,       // null | source-id
};

/* Parse the search box into structured filters. Supports:
 *   plain words (any combination — must all match name+desc+cat)
 *   cat:filter — restrict to a category (substring match)
 *   tag:multi  — restrict to a tag (substring match against the tag set)
 *   port:audio — at least one port name+type contains the string
 *   new        — recent additions only (whitelist below)
 */
const _BR_NEW_NODES = new Set([
  "MasterClock","LFOClock","EuclideanRhythm","StepSeq16","StepSeq32","Arp",
  "PianoRoll","MultiPianoRoll","WavetableScan","SamplePlayer","StereoSamplePlayer",
  "GranularPlayer","PulsarSynth","LiveLooper","MicInput","VoiceTrigger",
  "Ramp","VCA","AudioBus","MasterMix","PatchMatrix","Const",
  "StateVariableFilter","MoogLadder","FMOp","KSString","WavetableOsc",
]);
function brParseSearch(text) {
  const tokens = (text || "").trim().split(/\s+/).filter(Boolean);
  const ops = { cat: [], tag: [], port: [], onlyNew: false, free: [] };
  for (const t of tokens) {
    const tl = t.toLowerCase();
    if (tl.startsWith("cat:"))       ops.cat.push(tl.slice(4));
    else if (tl.startsWith("tag:"))  ops.tag.push(tl.slice(4));
    else if (tl.startsWith("port:")) ops.port.push(tl.slice(5));
    else if (tl === "new")           ops.onlyNew = true;
    else                             ops.free.push(tl);
  }
  return ops;
}
function brNodeMatches(name, def, tags, ops) {
  if (ops.onlyNew && !_BR_NEW_NODES.has(name)) return false;
  const derivedCat = _deriveNodeCategory(name, def);
  for (const c of ops.cat)  if (!derivedCat.toLowerCase().includes(c) && !String(def.category || "").toLowerCase().includes(c)) return false;
  for (const t of ops.tag)  if (!tags.some(x => x.includes(t))) return false;
  for (const p of ops.port) {
    const hay = [...(def.ins||[]), ...(def.outs||[])].map(x => `${x.n} ${x.t}`).join(" ").toLowerCase();
    if (!hay.includes(p)) return false;
  }
  if (ops.free.length) {
    const hay = (name + " " + (def.description||"") + " " + derivedCat + " " + (def.category||"")).toLowerCase();
    for (const f of ops.free) if (!hay.includes(f)) return false;
  }
  return true;
}

function brHighlight(text, ops) {
  const primary = ops.free[0];
  if (!primary) return escapeText(text);
  const i = text.toLowerCase().indexOf(primary);
  if (i < 0) return escapeText(text);
  return escapeText(text.slice(0, i))
    + "<mark>" + escapeText(text.slice(i, i + primary.length)) + "</mark>"
    + escapeText(text.slice(i + primary.length));
}

/* ─── Vertical category rail ────────────────────────────────────── */
function brRenderRail(catsPresent) {
  const rail = document.getElementById("br-cat-rail");
  if (!rail) return;
  // Order: CATEGORY_ORDER first, then any extras present in the data.
  const seen = new Set();
  const ordered = [];
  CATEGORY_ORDER.forEach(c => { if (catsPresent.has(c)) { ordered.push(c); seen.add(c); } });
  catsPresent.forEach(c => { if (!seen.has(c)) ordered.push(c); });

  let html = `
    <div class="rail-marker">ALL</div>
    <div class="rail-item ${brState.catFilter === null ? "active" : ""}" data-cat="" title="All categories">
      <span class="rail-dot" style="color: var(--phosphor)"></span>
      <span class="rail-tip">all categories</span>
    </div>
    <div class="rail-divider"></div>
    <div class="rail-marker">CAT</div>
  `;
  ordered.forEach(cat => {
    // Pull the color from the first node in this (derived) category.
    let color = "var(--text-3)";
    for (const [nm, n] of Object.entries(TYPES)) { if (_deriveNodeCategory(nm, n) === cat) { color = n.color; break; } }
    const active = brState.catFilter === cat ? "active" : "";
    html += `
      <div class="rail-item ${active}" data-cat="${escapeAttr(cat)}">
        <span class="rail-dot" style="color: ${color}"></span>
        <span class="rail-tip">${escapeText(cat.toLowerCase())}</span>
      </div>
    `;
  });
  rail.innerHTML = html;
  rail.querySelectorAll(".rail-item").forEach(it => {
    it.addEventListener("click", () => {
      brState.catFilter = it.dataset.cat || null;
      brRenderNodes();
    });
  });
}

/* ─── Nodes list (replaces old palette body) ────────────────────── */
function brRenderNodes() {
  const ops = brParseSearch(brState.search);
  const catsPresent = new Set();
  const cats = {};
  let totalShown = 0;
  Object.entries(TYPES).forEach(([name, def]) => {
    const cat = _deriveNodeCategory(name, def);
    catsPresent.add(cat);
    if (brState.catFilter && cat !== brState.catFilter) return;
    const tags = brDeriveTags(name, def);
    if (!brNodeMatches(name, def, tags, ops)) return;
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ name, def, tags });
    totalShown++;
  });

  brRenderRail(catsPresent);

  const totalAll = Object.keys(TYPES).length;
  const filtering = !!(brState.search || brState.catFilter);

  let html = "";
  let any = false;
  // Order: CATEGORY_ORDER first, then any extras present in the data.
  const seen = new Set();
  const ordered = [];
  CATEGORY_ORDER.forEach(c => { if (cats[c]) { ordered.push(c); seen.add(c); } });
  Object.keys(cats).forEach(c => { if (!seen.has(c)) ordered.push(c); });

  ordered.forEach(cat => {
    const items = cats[cat];
    if (!items || !items.length) return;
    any = true;
    const collapsedClass = collapsedCats[cat] && !filtering ? " collapsed" : "";
    const meta = _brCatMeta(cat);
    const catColor = items[0].def.color || "var(--text-3)";
    html += `<div class="cat${collapsedClass}" data-cat="${escapeAttr(cat)}">`;
    html += `<div class="cat-header" data-toggle="${escapeAttr(cat)}">`;
    html += `<span class="cat-ref">${meta.ref}<br>·${items.length}</span>`;
    html += `<span class="cat-name-block">`;
    html +=   `<span class="cat-name" style="color: ${catColor}; text-shadow: 0 0 8px ${catColor}40;">${escapeText(cat.toLowerCase())}</span>`;
    html +=   `<span class="cat-tag">${escapeText(meta.tag)}</span>`;
    html += `</span>`;
    html += `<span class="cat-meta"><span class="cat-count">${items.length}</span><span class="cat-toggle">▼</span></span>`;
    html += `</div>`;
    html += `<div class="cat-items list">`;
    items.forEach(({ name, def, tags }) => {
      const sel = brState.selected === name ? "selected" : "";
      const desc = def.description || "";
      const nameHtml = brHighlight(name, ops);
      const tagHtml = tags.map(t => `<span class="br-tag ${t}">${t.replace("user-dsp", ".gdsp")}</span>`).join("");
      html += `<div class="pal-item ${sel}" data-add="${escapeAttr(name)}"`;
      if (desc) html += ` title="${escapeAttr(desc)}"`;
      html += `>`;
      html += `<span class="pal-dot" style="background:${def.color}; color:${def.color}"></span>`;
      html += `<span class="pal-name">${nameHtml}</span>`;
      html += `<span class="item-tags">${tagHtml}</span>`;
      html += `</div>`;
    });
    html += `</div></div>`;
  });
  if (!any) {
    html = `<div class="pal-empty">No nodes match the current filter.<br><br>
      <span style="color:var(--text-3); font-size:9.5px; letter-spacing:0.10em;">
        TRY: clearing the search · clicking ALL on the rail · cat:filter · tag:multi-out
      </span></div>`;
  }
  palette.innerHTML = html;

  // Footer + tab status
  const footCount = document.getElementById("pal-foot-count");
  if (footCount) footCount.textContent = filtering ? `${totalShown}` : String(totalAll);
  const footReg = document.getElementById("br-foot-reg"); if (footReg) footReg.textContent = String(totalAll);
  const footCat = document.getElementById("br-foot-cat"); if (footCat) footCat.textContent = String(catsPresent.size);
  const footVer = document.getElementById("br-foot-version"); if (footVer && typeof APP_VERSION !== "undefined") footVer.textContent = `GAMMA · v${APP_VERSION}`;
  const tabStatus = document.getElementById("br-tab-status"); if (tabStatus) tabStatus.textContent = `REG · ${totalAll}`;

  // Re-bind interaction. Category headers toggle collapsed state;
  // pal-items single-click selects (highlights + shows in the
  // drawer) and double-click adds to the canvas. Keep single-click-
  // adds-to-canvas for the historical UX so power users aren't
  // surprised — they can still drop a node by single click.
  palette.querySelectorAll(".cat-header").forEach(h => {
    h.addEventListener("click", () => {
      const cat = h.dataset.toggle;
      collapsedCats[cat] = !collapsedCats[cat];
      brRenderNodes();
    });
  });
  palette.querySelectorAll(".pal-item").forEach(item => {
    item.addEventListener("click", () => {
      const name = item.dataset.add;
      brState.selected = name;
      brRenderDrawer();
      // Visual selection highlight
      palette.querySelectorAll(".pal-item.selected").forEach(s => s.classList.remove("selected"));
      item.classList.add("selected");
      // Open drawer if collapsed (first interaction)
      const drw = document.getElementById("br-drawer");
      if (drw && drw.classList.contains("collapsed")) drw.classList.remove("collapsed");
      // Keep the historical "click adds the node" affordance.
      addFromPalette(name);
    });
  });
}

/* ─── Detail drawer ─────────────────────────────────────────────── */
function brRenderDrawer() {
  const name = brState.selected;
  const titleEl = document.getElementById("br-drawer-title");
  const bodyEl = document.getElementById("br-drawer-body");
  if (!titleEl || !bodyEl) return;
  if (!name || !TYPES[name]) {
    titleEl.innerHTML = `nothing selected <span class="ref">REG · —</span>`;
    bodyEl.innerHTML = "";
    return;
  }
  const def = TYPES[name];
  const tags = brDeriveTags(name, def);
  const meta = _brCatMeta(def.category);
  const idx = Object.keys(TYPES).indexOf(name);
  titleEl.innerHTML = `${escapeText(name.toLowerCase())} <span class="ref">${meta.ref}.${String(idx).padStart(3,"0")} · ${escapeText((def.category||"").toUpperCase())}</span>`;

  const portRow = (p, dir) => {
    const t = (p.t || "audio").toLowerCase();
    return `
      <div class="drawer-port ${t}">
        <span class="port-glyph"></span>
        <span class="port-name">${escapeText(p.n)}</span>
        <span class="port-type">${dir==="in"?"→":"←"} ${escapeText(t)}</span>
      </div>`;
  };

  const ins = (def.ins || []).map(p => portRow(p, "in")).join("");
  const outs = (def.outs || []).map(p => portRow(p, "out")).join("");

  // Related nodes — same category, up to 5, excluding the selection.
  const related = Object.entries(TYPES)
    .filter(([n, d]) => n !== name && d.category === def.category)
    .slice(0, 5)
    .map(([n]) => `<span class="related-chip" data-jump="${escapeAttr(n)}">${escapeText(n)}</span>`)
    .join("");

  const tagHtml = tags.map(t => `<span class="br-tag ${t}" style="font-size:9px; padding:2px 6px;">${t.replace("user-dsp",".gdsp")}</span>`).join("");

  bodyEl.innerHTML = `
    <div class="drawer-section">
      <div class="drawer-section-label">function</div>
      <div class="drawer-text">${escapeText(def.description || "(no description provided)")}</div>
    </div>
    ${ (ins || outs) ? `
      <div class="drawer-section">
        <div class="drawer-section-label">ports · ${(def.ins||[]).length} in / ${(def.outs||[]).length} out</div>
        <div class="drawer-ports">${ins}${outs}</div>
      </div>
    ` : "" }
    <div class="drawer-section">
      <div class="drawer-section-label">tags</div>
      <div class="drawer-related">${tagHtml || "<span style='color:var(--text-3); font-size:10px;'>(no tags derived)</span>"}</div>
    </div>
    ${ related ? `
      <div class="drawer-section">
        <div class="drawer-section-label">related — same category</div>
        <div class="drawer-related">${related}</div>
      </div>
    ` : "" }
  `;
  bodyEl.querySelectorAll(".related-chip").forEach(c => {
    c.addEventListener("click", () => {
      const target = c.dataset.jump;
      if (TYPES[target]) {
        brState.selected = target;
        brRenderNodes();
        brRenderDrawer();
      }
    });
  });
}

/* ─── Tab switching ─────────────────────────────────────────────── */
function brSwitchTab(name) {
  brState.tab = name;
  document.querySelectorAll(".br-tab").forEach(t => t.classList.toggle("active", t.dataset.brTab === name));
  const vN = document.getElementById("br-view-nodes");
  const vA = document.getElementById("br-view-assets");
  const vD = document.getElementById("br-view-demos");
  const vP = document.getElementById("br-view-prefabs");
  if (vN) vN.hidden = name !== "nodes";
  if (vA) vA.hidden = name !== "assets";
  if (vD) vD.hidden = name !== "demos";
  if (vP) vP.hidden = name !== "prefabs";
  // Status text updates per-tab
  const status = document.getElementById("br-tab-status");
  if (status) {
    if (name === "nodes")   status.textContent = `REG · ${Object.keys(TYPES).length}`;
    if (name === "assets")  status.textContent = `ASSETS · ${(_assets ? _assets.size : 0)}`;
    if (name === "demos")   status.textContent = `DEMOS · ${_demos.length}`;
    if (name === "prefabs") status.textContent = `PREFABS · ${_prefabBrowserCount()}`;
  }
  if (name === "assets")  brRenderAssets();
  if (name === "demos")   brRenderDemos();
  if (name === "prefabs") brRenderPrefabs();
}

/* ─── Demos tab ─────────────────────────────────────────────────── */
/* Curated example patches. Each entry's build() function runs against
 * a freshly-cleared `state` (via loadDemo()) using the same makeNode +
 * state.edges.push pattern reset() uses, so the demos read like
 * normal patch construction. The thumbnails are inline SVG glyphs
 * sized to match the asset-card .asset-thumb dimensions. Add more
 * demos here as Phase 6.5.5+ ships canonical examples. */

/* Programmatic sprite-sheet generator for the animated platformer
 * demo. 6 frames at 32×32, laid out horizontally (sheet 192×32):
 *   [0] idle    [1] walk-A    [2] walk-mid    [3] walk-B    [4] jump    [5] fall
 * Matches the AnimationState2D node's default frame specs
 *   idleFrames:"0", walkFrames:"1,2,1,3", jumpFrames:"4", fallFrames:"5"
 * so a fresh AnimationState2D wires up against this sheet with no
 * tweaking. Cheap-and-cheerful "orange blob with eyes" -- a stand-in
 * for whatever character the user generates via SpriteCreator later.
 */
async function _makePlaceholderHeroSheet() {
  const FW = 32, FH = 32, NF = 6;
  const W = FW * NF, H = FH;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  // Palette -- low-saturation pixel-art friendly.
  const C_BODY    = "#e85a3a";
  const C_DARK    = "#a83a20";
  const C_OUT     = "#3a1a10";
  const C_EYE     = "#ffffff";
  const C_PUPIL   = "#101010";
  const C_FOOT    = "#5a2a1a";
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  function drawHero(ox, p) {
    const bx = ox + 8;
    const by = 8 + (p.bobY || 0);
    const bw = 16, bh = 16;
    // Body fill
    px(bx + 1, by + 1, bw - 2, bh - 2, C_BODY);
    // Outline
    px(bx, by + 1, 1, bh - 2, C_OUT);
    px(bx + bw - 1, by + 1, 1, bh - 2, C_OUT);
    px(bx + 1, by, bw - 2, 1, C_OUT);
    px(bx + 1, by + bh - 1, bw - 2, 1, C_OUT);
    // Shading (lower-right)
    px(bx + bw - 3, by + 3, 1, bh - 5, C_DARK);
    px(bx + 3, by + bh - 3, bw - 5, 1, C_DARK);
    // Eyes
    const eyeY = by + 4;
    const eyeL = bx + 3, eyeR = bx + 10;
    px(eyeL, eyeY, 3, 3, C_EYE);
    px(eyeR, eyeY, 3, 3, C_EYE);
    const pdx = (p.lookRight ? 2 : (p.lookLeft ? 0 : 1));
    const pdy = (p.lookUp ? 0 : (p.lookDown ? 2 : 1));
    px(eyeL + pdx, eyeY + pdy, 1, 1, C_PUPIL);
    px(eyeR + pdx, eyeY + pdy, 1, 1, C_PUPIL);
    // Mouth (subtle dark notch)
    px(bx + 7, by + 10, 2, 1, C_OUT);
    // Feet -- two small rects below body
    const fyBase = by + bh;
    const lf = p.leftFoot  || { dx: -2, dy: 0 };
    const rf = p.rightFoot || { dx: 1,  dy: 0 };
    px(bx + 2 + lf.dx, fyBase + lf.dy, 4, 2, C_FOOT);
    px(bx + bw - 6 + rf.dx, fyBase + rf.dy, 4, 2, C_FOOT);
  }
  // Frame 0 -- idle (neutral stance, looking forward)
  drawHero(0 * FW, { leftFoot: { dx: -2, dy: 0 }, rightFoot: { dx: 1, dy: 0 } });
  // Frame 1 -- walk pose A (right foot forward, lifted)
  drawHero(1 * FW, { leftFoot: { dx: -3, dy: 0 }, rightFoot: { dx: 2, dy: -1 }, lookRight: true });
  // Frame 2 -- walk pose mid (both feet close, body up a hair)
  drawHero(2 * FW, { bobY: -1, leftFoot: { dx: -1, dy: 0 }, rightFoot: { dx: 0, dy: 0 } });
  // Frame 3 -- walk pose B (left foot forward, lifted)
  drawHero(3 * FW, { leftFoot: { dx: -1, dy: -1 }, rightFoot: { dx: 0, dy: 0 }, lookRight: true });
  // Frame 4 -- jump (body raised, feet tucked, eyes up)
  drawHero(4 * FW, { bobY: -3, leftFoot: { dx: -1, dy: -2 }, rightFoot: { dx: 0, dy: -2 }, lookUp: true });
  // Frame 5 -- fall (body lowered, feet down, eyes down)
  drawHero(5 * FW, { bobY: 1,  leftFoot: { dx: -2, dy: 1 },  rightFoot: { dx: 1, dy: 1 },  lookDown: true });
  return await c.convertToBlob({ type: "image/png" });
}

/* Idempotent. If a sprite named 'hero-placeholder' already exists in
 * the asset library, this is a no-op. Otherwise it generates the
 * placeholder sheet, registers it as a 6-frame sprite, and creates
 * a 'hero-placeholder-folder' (playable-character function) with the
 * sprite assigned to the idle / walk / jump-up / fall slots so the
 * user can drag the folder onto a Scene2D to spawn a wired character. */
/* Programmatic egg pickup sprite. 16×16, single frame. Egg-shell
 * cream body with a soft top-left highlight + bottom-right shadow
 * for that "I am an egg, not a circle" read. Pixel-art ovular
 * silhouette so it stays legible at 1:1 in a 32×32 sprite world. */
async function _makeEggPickupSprite() {
  const W = 16, H = 16;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  const SHELL     = "#fdf3e0";
  const HIGHLIGHT = "#ffffff";
  const SHADOW    = "#dbc89c";
  const OUTLINE   = "#7a5a30";
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  // Egg silhouette as horizontal scanlines (cols start_x → start_x+width).
  // Roughly 10×12 ovular, narrower at top, slightly fatter near bottom.
  const shape = [
    { y:  2, x: 6, w: 4 },
    { y:  3, x: 5, w: 6 },
    { y:  4, x: 4, w: 8 },
    { y:  5, x: 4, w: 8 },
    { y:  6, x: 3, w: 10 },
    { y:  7, x: 3, w: 10 },
    { y:  8, x: 3, w: 10 },
    { y:  9, x: 3, w: 10 },
    { y: 10, x: 3, w: 10 },
    { y: 11, x: 4, w: 8 },
    { y: 12, x: 4, w: 8 },
    { y: 13, x: 5, w: 6 }
  ];
  for (const s of shape) px(s.x, s.y, s.w, 1, SHELL);
  // Outline pass
  for (const s of shape) {
    px(s.x,          s.y, 1, 1, OUTLINE);
    px(s.x + s.w - 1, s.y, 1, 1, OUTLINE);
  }
  px(6, 1, 4, 1, OUTLINE); // top cap
  px(5, 14, 6, 1, OUTLINE); // bottom cap
  // Highlight (top-left)
  px(5, 4, 2, 1, HIGHLIGHT);
  px(4, 5, 1, 2, HIGHLIGHT);
  px(5, 5, 1, 1, HIGHLIGHT);
  // Shadow (bottom-right curve)
  px(10, 10, 1, 2, SHADOW);
  px(9, 12, 2, 1, SHADOW);
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic goal-flag sprite. 16×24, single frame. A wooden pole
 * on the left third + a red triangular pennant pointing right --
 * unambiguous "you've reached the end" visual that reads cleanly
 * even when rendered at 1 world unit tall. */
async function _makeGoalFlagSprite() {
  const W = 16, H = 24;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  const POLE_LIGHT = "#8c6a3e";
  const POLE_DARK  = "#5a3e1e";
  const FLAG       = "#e83a3a";
  const FLAG_LITE  = "#ff6060";
  const FLAG_DARK  = "#a02020";
  const OUTLINE    = "#3a1010";
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  // Pole: 2px wide centered around x=3, full height minus base.
  px(3, 1, 2, 22, POLE_LIGHT);
  px(3, 1, 1, 22, POLE_DARK);   // left edge darker
  px(2, 22, 4, 1, POLE_DARK);   // small foot
  px(1, 23, 6, 1, OUTLINE);     // ground line
  // Flag: triangle, peak at top of pole, hangs down to mid-height.
  // Rows from y=2 to y=10. Each row: starts at x=5 (right of pole),
  // extends by a width that narrows toward the bottom.
  const flag = [
    { y:  2, w: 10 },
    { y:  3, w: 10 },
    { y:  4, w: 10 },
    { y:  5, w: 9  },
    { y:  6, w: 8  },
    { y:  7, w: 7  },
    { y:  8, w: 5  },
    { y:  9, w: 3  }
  ];
  for (const f of flag) px(5, f.y, f.w, 1, FLAG);
  // Highlight top
  px(5, 2, 8, 1, FLAG_LITE);
  // Shadow bottom edges of each row (gives flag depth)
  for (const f of flag) px(5 + f.w - 1, f.y, 1, 1, FLAG_DARK);
  // Pennant point outline (right edge)
  px(5 + flag[0].w, 2, 1, 1, OUTLINE);
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic parallax background -- sky layer. 256×128 PNG with
 * a soft vertical gradient (deep blue top → light haze bottom) plus
 * scattered subtle clouds. Width chosen to tile horizontally
 * seamlessly when the sampler is set to repeat-x. parallaxX=0 means
 * the sky doesn't actually scroll, but we still want it to look
 * "right" if someone wires it with parallaxX>0. */
async function _makeParallaxSkySprite() {
  const W = 256, H = 128;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  // Vertical gradient: top deeper blue → bottom haze.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0,   "#4a7dc0");
  grad.addColorStop(0.6, "#82b6d8");
  grad.addColorStop(1,   "#c9dceb");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Distant clouds -- soft ellipses, transparent. Deterministic
  // placement via seeded random so the look is stable across loads.
  let seed = 0x4c1d;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  for (let i = 0; i < 6; i++) {
    const x = rand() * W;
    const y = 12 + rand() * 36;
    const rx = 18 + rand() * 26;
    const ry = 5  + rand() * 4;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tile-safe: if cloud crosses right edge, redraw at x-W so the
    // texture loops cleanly.
    if (x + rx > W)  { ctx.beginPath(); ctx.ellipse(x - W, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
    if (x - rx < 0)  { ctx.beginPath(); ctx.ellipse(x + W, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic parallax background -- distant mountains. 512×128.
 * Two overlapping silhouette ranges in muted purple-gray; tile-safe
 * horizontally. Transparent above the ridges so the sky shows
 * through. parallaxX ~0.10-0.15 for "far distance" feel. */
async function _makeParallaxMountainsSprite() {
  const W = 512, H = 128;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, W, H);
  // Ridge generator: triangular peaks at quasi-random columns. Use
  // a closed path that wraps to tile cleanly: ensure the last point's
  // y matches the first point's y, and the path stays inside [0, W].
  function drawRidge(color, peakColor, baseY, peakHeight, peakCount, seed) {
    let s = seed >>> 0;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
    const peaks = [];
    // Force matching endpoints so the texture seams cleanly.
    peaks.push({ x: 0,   y: baseY });
    for (let i = 0; i < peakCount; i++) {
      const px = ((i + 0.5) / peakCount) * W + (rand() - 0.5) * (W / peakCount) * 0.6;
      const ph = peakHeight * (0.6 + rand() * 0.4);
      peaks.push({ x: px, y: baseY - ph });
      // Add a saddle between peaks for variation
      if (i < peakCount - 1) {
        const sx = ((i + 1) / peakCount) * W;
        const sh = peakHeight * (0.2 + rand() * 0.3);
        peaks.push({ x: sx, y: baseY - sh });
      }
    }
    peaks.push({ x: W,   y: baseY });
    // Body fill
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (const p of peaks) ctx.lineTo(p.x, p.y);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // Ridge highlight (thin lighter line along the top edge)
    ctx.beginPath();
    ctx.moveTo(peaks[0].x, peaks[0].y);
    for (let i = 1; i < peaks.length; i++) ctx.lineTo(peaks[i].x, peaks[i].y);
    ctx.strokeStyle = peakColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // Far ridge (lighter, higher up the image)
  drawRidge("#7a8aa8", "#a4b3cd", 78, 48, 7, 0x8a14);
  // Near ridge (darker, lower down + taller peaks)
  drawRidge("#54678a", "#7d92b3", 96, 60, 5, 0x3221);
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic parallax background -- midground forest. 512×128.
 * Row of conifer-tree silhouettes with snow caps + subtle variation
 * in height. Tile-safe. Sits in front of the mountains, behind the
 * level. parallaxX ~0.30-0.45 for "midground" feel. */
async function _makeParallaxForestSprite() {
  const W = 512, H = 128;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  let s = 0x9911;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  // Sparser horizon-strip treeline. ONLY 6 short trees across 512px
  // (was 18 ~tall ones), confined to the BOTTOM 30% of the texture
  // so a thin layer (scaleY ~0.25) places them as a peek-above-the-
  // horizon silhouette band rather than a wall of foliage that
  // covers half the screen.
  const baselineY = H - 4;          // trunk floor near bottom of texture
  const treeCount = 6;
  const slot = W / treeCount;
  function drawTreeAt(cx, baseY, height, width) {
    // Trunk
    ctx.fillStyle = "#3a2210";
    ctx.fillRect(cx - 1.5, baseY, 3, 3);
    // Triangle body
    ctx.fillStyle = "#2c5436";
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.5, baseY);
    ctx.lineTo(cx + width * 0.5, baseY);
    ctx.lineTo(cx,                baseY - height);
    ctx.closePath();
    ctx.fill();
    // Subtle inner highlight
    ctx.fillStyle = "#3a6845";
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.30, baseY - 2);
    ctx.lineTo(cx + width * 0.12, baseY - 2);
    ctx.lineTo(cx - width * 0.05, baseY - height + 4);
    ctx.closePath();
    ctx.fill();
  }
  for (let i = 0; i < treeCount; i++) {
    const cx = (i + 0.5) * slot + (rand() - 0.5) * slot * 0.3;
    const baseY = baselineY - rand() * 2;
    const height = 18 + rand() * 8;   // 18-26 (was 32-54)
    const width  = 12 + rand() * 4;   // 12-16 (was 14-22)
    drawTreeAt(cx, baseY, height, width);
    // Tile-wrap for seamless horizontal cycling.
    if (cx + width * 0.5 > W) drawTreeAt(cx - W, baseY, height, width);
    if (cx - width * 0.5 < 0) drawTreeAt(cx + W, baseY, height, width);
  }
  return await c.convertToBlob({ type: "image/png" });
}

/* Default-ship bootstrap: parallax bg layers (sky + mountains +
 * forest) all in one 'parallax-background' folder so they ship as
 * a related set. Functions identically to the hero / egg / flag
 * bootstraps: idempotent, runs on DOMContentLoaded. */
// Bump on any meaningful parallax-bg art change so users on the
// previous version get the new sprites instead of stale IDB blobs.
const PARALLAX_BG_VERSION = 2;
async function _ensureParallaxBgAssets() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    const layers = [
      { name: "parallax-sky",       generator: _makeParallaxSkySprite,       slot: "sky" },
      { name: "parallax-mountains", generator: _makeParallaxMountainsSprite, slot: "far" },
      { name: "parallax-forest",    generator: _makeParallaxForestSprite,    slot: "mid" }
    ];
    const slots = {};
    let createdAny = false;
    for (const layer of layers) {
      let sprite = Assets.findSpriteByName(layer.name);
      // Stale-art replacement: if the existing record was created by
      // an older version of this bootstrap, delete it so the new
      // generator output gets saved this run.
      if (sprite && (sprite.parallaxBgVersion || 0) < PARALLAX_BG_VERSION) {
        console.log("[default-assets] replacing stale " + layer.name +
          " (v" + (sprite.parallaxBgVersion || 0) + " -> v" + PARALLAX_BG_VERSION + ")");
        try { await Assets.delete(sprite.id); } catch (e) {
          console.warn("[default-assets] delete failed:", e);
        }
        sprite = null;
      }
      if (!sprite) {
        const blob = await layer.generator();
        const file = new File([blob], layer.name + ".png", { type: "image/png" });
        sprite = await loadImageFileToSpriteAsset(file, {
          name: layer.name,
          framesX: 1, framesY: 1,
          fps: 1, scale: 32,
          source: "default:parallax-bg"
        });
        if (sprite) {
          sprite.parallaxBgVersion = PARALLAX_BG_VERSION;
          try { await Assets.put(sprite); } catch (e) { console.warn("[default-assets] version-tag put failed:", e); }
          if (sprite.blob) {
            console.log("[default-assets] " + layer.name + " v" + PARALLAX_BG_VERSION +
              " sprite saved (" + sprite.blob.size + " bytes)");
          }
        }
        createdAny = true;
      }
      if (sprite) slots[layer.slot] = sprite.id;
    }
    let folder = Assets.findFolderByName("parallax-bg-folder");
    if (!folder) {
      folder = await createFolderAsset("parallax-bg-folder", "decoration", {
        slots: { main: slots.sky || null },   // decoration has 'main' slot
        notes: "Default parallax background set bundled with the editor. Three layers (sky / mountains / forest) for Snow-White-style multi-plane scrolling in Scene2D demos. Wire each into a ParallaxLayer2D with an ImageURL(wrapMode='repeat-x'), then into Scene2D.mesh1..mesh3 (back-to-front). See the Platformer 2D · Animated demo for the canonical layout.",
        source: "default:parallax-bg"
      });
    }
    if (createdAny) {
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return slots;
  } catch (e) {
    console.warn("[default-assets] parallax bg bootstrap failed:", e);
    return null;
  }
}

/* Default ship-with-app tileset for Level2D textured tilemap layers.
 * 4×2 grid of 16px tiles -> 64×32 PNG. Each tile is hand-drawn
 * procedurally; user can replace via SpriteCreator once Phase 2c
 * adds a real tileset asset type.
 *
 * Tile index layout:
 *   0 grass-top  1 dirt       2 stone     3 sand
 *   4 water      5 wood-plank 6 brick     7 door
 *
 * Level2D tilemap layer uses tileMap = { "1": 0, "2": 1, ... } to
 * map cell chars to tile indices into this sheet.
 */
async function _makeDemoTilesetSprite() {
  const TW = 16, TH = 16, COLS = 4, ROWS = 2;
  const W = TW * COLS, H = TH * ROWS;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  function tileAt(col, row) { return { ox: col * TW, oy: row * TH }; }
  // Tile 0: grass-top (green w/ darker grass blades on top)
  {
    const { ox, oy } = tileAt(0, 0);
    px(ox, oy + 2, 16, 14, "#3a8a3e");      // body
    px(ox, oy + 2, 16, 1,  "#5fa860");      // top highlight
    px(ox, oy + 15, 16, 1, "#1f5024");      // bottom shadow
    // grass blades on top edge
    for (let i = 0; i < 8; i++) px(ox + i * 2 + (i % 2), oy + (i % 2 ? 0 : 1), 1, (i % 2 ? 2 : 1), "#7ec48a");
  }
  // Tile 1: dirt
  {
    const { ox, oy } = tileAt(1, 0);
    px(ox, oy, 16, 16, "#6a4520");
    // pebbles
    px(ox + 3,  oy + 3,  2, 2, "#52341c");
    px(ox + 10, oy + 7,  2, 2, "#7a5230");
    px(ox + 5,  oy + 11, 2, 2, "#4a2e18");
    px(ox + 12, oy + 12, 1, 1, "#52341c");
  }
  // Tile 2: stone
  {
    const { ox, oy } = tileAt(2, 0);
    px(ox, oy, 16, 16, "#6e7280");
    // cracks
    px(ox + 1, oy + 4, 5, 1, "#52555f");
    px(ox + 9, oy + 9, 5, 1, "#52555f");
    px(ox + 4, oy + 12, 1, 3, "#52555f");
    // highlights
    px(ox + 2, oy + 1, 3, 1, "#8b8f9c");
    px(ox + 11, oy + 5, 3, 1, "#8b8f9c");
  }
  // Tile 3: sand
  {
    const { ox, oy } = tileAt(3, 0);
    px(ox, oy, 16, 16, "#e2c887");
    // texture dots
    px(ox + 3,  oy + 4,  1, 1, "#c8ad6b");
    px(ox + 9,  oy + 6,  1, 1, "#c8ad6b");
    px(ox + 5,  oy + 11, 1, 1, "#c8ad6b");
    px(ox + 12, oy + 13, 1, 1, "#c8ad6b");
    px(ox + 7,  oy + 2,  1, 1, "#f0d59a");
    px(ox + 11, oy + 9,  1, 1, "#f0d59a");
  }
  // Tile 4: water
  {
    const { ox, oy } = tileAt(0, 1);
    px(ox, oy, 16, 16, "#3a6eb4");
    // wave highlights
    px(ox + 1, oy + 2,  6, 1, "#5a8cd4");
    px(ox + 9, oy + 5,  5, 1, "#5a8cd4");
    px(ox + 3, oy + 9,  7, 1, "#5a8cd4");
    px(ox + 10, oy + 12, 4, 1, "#5a8cd4");
    px(ox + 2, oy + 13, 3, 1, "#7daad8");
  }
  // Tile 5: wood plank
  {
    const { ox, oy } = tileAt(1, 1);
    px(ox, oy, 16, 16, "#9c6a3a");
    // horizontal plank lines
    px(ox, oy + 5,  16, 1, "#6e4828");
    px(ox, oy + 10, 16, 1, "#6e4828");
    px(ox, oy + 15, 16, 1, "#5a3a20");
    // grain
    px(ox + 3,  oy + 2, 4, 1, "#b08858");
    px(ox + 9,  oy + 7, 5, 1, "#b08858");
    px(ox + 2,  oy + 12, 6, 1, "#b08858");
  }
  // Tile 6: brick wall
  {
    const { ox, oy } = tileAt(2, 1);
    px(ox, oy, 16, 16, "#7a4030");           // mortar
    const BRICK = "#b85a3a";
    // top row (offset 0)
    px(ox + 1, oy + 1, 6, 5, BRICK);
    px(ox + 8, oy + 1, 7, 5, BRICK);
    // middle row (offset 4)
    px(ox + 0, oy + 7, 3, 5, BRICK);
    px(ox + 4, oy + 7, 7, 5, BRICK);
    px(ox + 12, oy + 7, 4, 5, BRICK);
    // bottom row (offset 0)
    px(ox + 1, oy + 13, 6, 3, BRICK);
    px(ox + 8, oy + 13, 7, 3, BRICK);
  }
  // Tile 7: door
  {
    const { ox, oy } = tileAt(3, 1);
    px(ox, oy, 16, 16, "#5a3a1c");           // frame
    px(ox + 1, oy + 1, 14, 14, "#8a5a2a");   // door body
    // panels
    px(ox + 3, oy + 3, 4, 4, "#6e4520");
    px(ox + 9, oy + 3, 4, 4, "#6e4520");
    px(ox + 3, oy + 9, 4, 4, "#6e4520");
    px(ox + 9, oy + 9, 4, 4, "#6e4520");
    // knob
    px(ox + 12, oy + 8, 1, 1, "#fcd34d");
  }
  return await c.convertToBlob({ type: "image/png" });
}

async function _ensureDemoTilesetAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("demo-tileset");
    if (!sprite) {
      const blob = await _makeDemoTilesetSprite();
      const file = new File([blob], "demo-tileset.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "demo-tileset",
        framesX: 4, framesY: 2,
        fps: 1, scale: 16,
        source: "default:level2d-tileset"
      });
      if (sprite && sprite.blob) {
        console.log("[default-assets] demo-tileset sprite saved (" + sprite.blob.size + " bytes, 4×2 = 8 tiles)");
      }
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] demo-tileset bootstrap failed:", e);
    return null;
  }
}

/* Programmatic grass-tuft sprite. 16×12, single frame. Tiny green
 * silhouette with three blades + a hint of shadow at the base. Used
 * by the demo's SpriteScatter2D to lay decorative tufts along the
 * ground line. */
async function _makeGrassTuftSprite() {
  const W = 16, H = 12;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  // Three blades of grass + a small shadow.
  const BLADE  = "#4a8e4a";
  const BLADE2 = "#5fa05f";
  const BLADE3 = "#2c5e2c";
  const SHADOW = "#2a3a20";
  // Shadow at base
  px(3, 10, 10, 1, SHADOW);
  // Blade A (left, leans left)
  px(3, 3, 1, 8, BLADE3);
  px(4, 4, 1, 6, BLADE);
  px(4, 3, 1, 1, BLADE2);
  // Blade B (center, tallest)
  px(7, 1, 1, 10, BLADE);
  px(8, 1, 1, 10, BLADE3);
  px(8, 0, 1, 1, BLADE2);
  // Blade C (right, leans right)
  px(11, 4, 1, 6, BLADE);
  px(12, 3, 1, 8, BLADE3);
  px(11, 3, 1, 1, BLADE2);
  return await c.convertToBlob({ type: "image/png" });
}

/* Default-ship bootstrap for the grass tuft. */
async function _ensureGrassTuftAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("grass-tuft");
    if (!sprite) {
      const blob = await _makeGrassTuftSprite();
      const file = new File([blob], "grass-tuft.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "grass-tuft",
        framesX: 1, framesY: 1,
        fps: 1, scale: 16,
        source: "default:platformer-scatter"
      });
      if (sprite && sprite.blob) {
        console.log("[default-assets] grass-tuft sprite saved (" + sprite.blob.size + " bytes)");
      }
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] grass-tuft bootstrap failed:", e);
    return null;
  }
}

/* Default-ship bootstrap for the egg pickup. Same idempotency
 * contract as the hero. Saved as a 1-frame sprite in the asset
 * library + wrapped in a single-slot 'item' folder. */
async function _ensureEggPickupAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("egg-pickup");
    let created = false;
    if (!sprite) {
      const blob = await _makeEggPickupSprite();
      const file = new File([blob], "egg-pickup.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "egg-pickup",
        framesX: 1, framesY: 1,
        fps: 1, scale: 16,
        source: "default:platformer-items"
      });
      created = true;
      if (sprite && sprite.blob) {
        console.log("[default-assets] egg-pickup sprite saved (" + sprite.blob.size + " bytes)");
      }
    }
    if (!sprite) return null;
    let folder = Assets.findFolderByName("egg-pickup-folder");
    if (!folder) {
      folder = await createFolderAsset("egg-pickup-folder", "item", {
        slots: { idle: sprite.id },
        notes: "Default platformer pickup. Cream egg-shell sprite shipped with the editor; the Platformer 2D · Animated demo uses tilemap-based detection for now (a future push will swap in this sprite for the visual).",
        source: "default:platformer-items"
      });
    }
    if (created || folder) {
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] egg-pickup bootstrap failed:", e);
    return null;
  }
}

/* Default-ship bootstrap for the goal flag. Wrapped in a
 * 'decoration' folder since the flag is more "scenery you can
 * stand next to" than a state-machine-driven interactive. */
async function _ensureGoalFlagAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("goal-flag");
    let created = false;
    if (!sprite) {
      const blob = await _makeGoalFlagSprite();
      const file = new File([blob], "goal-flag.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "goal-flag",
        framesX: 1, framesY: 1,
        fps: 1, scale: 16,
        source: "default:platformer-items"
      });
      created = true;
      if (sprite && sprite.blob) {
        console.log("[default-assets] goal-flag sprite saved (" + sprite.blob.size + " bytes)");
      }
    }
    if (!sprite) return null;
    let folder = Assets.findFolderByName("goal-flag-folder");
    if (!folder) {
      folder = await createFolderAsset("goal-flag-folder", "decoration", {
        slots: { main: sprite.id },
        notes: "Default platformer goal marker. Red triangular flag on a wooden pole; drop next to a LevelGoal2D in your patch.",
        source: "default:platformer-items"
      });
    }
    if (created || folder) {
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] goal-flag bootstrap failed:", e);
    return null;
  }
}

async function _ensureHeroPlaceholderAsset() {
  // Skip if Assets isn't ready yet (very early bootstrap).
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("hero-placeholder");
    let createdSprite = false;
    if (!sprite) {
      const blob = await _makePlaceholderHeroSheet();
      const file = new File([blob], "hero-placeholder.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "hero-placeholder",
        framesX: 6, framesY: 1,
        fps: 8, scale: 32,
        source: "default:platformer"
      });
      createdSprite = true;
      if (sprite && sprite.blob) {
        console.log("[default-assets] hero-placeholder sprite saved ("
          + sprite.blob.size + " bytes PNG, 6 frames @ 32×32)");
      }
    }
    if (!sprite) return null;
    // Folder is keyed by name independently of the sprite -- if the
    // user nuked the folder but kept the sprite, recreate the folder.
    let folder = Assets.findFolderByName("hero-placeholder-folder");
    if (!folder) {
      folder = await createFolderAsset("hero-placeholder-folder", "playable-character", {
        slots: {
          idle:        sprite.id,
          walk:        sprite.id,
          "jump-up":   sprite.id,
          fall:        sprite.id
        },
        notes: "Default placeholder bundled with the editor. 6-frame sprite-sheet (idle / walk-A / walk-mid / walk-B / jump / fall) auto-generated on first launch. Replace via SpriteCreator when you've generated a real character — the demo will pick up the new sprite as long as you rename it 'hero-placeholder' or wire ImageURL to your asset name.",
        source: "default:platformer"
      });
    }
    if (createdSprite || folder) {
      // Refresh the Assets tab if it's currently rendered so the new
      // entries show up without requiring a tab-switch.
      if (typeof brRenderAssets === "function") {
        try { brRenderAssets(); } catch (_) {}
      }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] hero placeholder bootstrap failed:", e);
    return null;
  }
}

