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

