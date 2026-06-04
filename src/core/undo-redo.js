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

