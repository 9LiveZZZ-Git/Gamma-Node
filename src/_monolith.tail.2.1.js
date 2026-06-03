

function highlightCpp(code) {
  return code
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/(#\w+(?:\s+&lt;[^&]+&gt;)?)/g, '<span class="pp">$1</span>')
    .replace(/\b(class|public|private|void|float|return|new|auto|template)\b/g, '<span class="kw">$1</span>')
    .replace(/(gam::[A-Za-z0-9_]+(?:&lt;[^&]*&gt;)?)/g, '<span class="ty">$1</span>')
    .replace(/(std::[A-Za-z0-9_]+(?:&lt;[^&]*&gt;)?)/g, '<span class="ty">$1</span>')
    .replace(/\b(\d+\.?\d*f?)\b/g, '<span class="nu">$1</span>');
}

function renderCode() {
  codeOut.innerHTML = highlightCpp(generateCode());
}

/* JSON.stringify replacer that strips runtime-only fields (any key
 * prefixed with `_`) from serialization. Currently in use:
 *   - state._cycleErrors  — cycle-detector cache rebuilt on each render
 *   - notes[i]._id        — piano-roll selection key, regenerated on
 *                           open from the (start, dur, midi, vel) tuple
 * Both .gpatch save and the JSON preview tab use this so transient
 * editor bookkeeping never lands in source files or pasted snippets. */
function _omitRuntimeKeys(key, val) {
  if (typeof key === "string" && key.length > 0 && key.charCodeAt(0) === 95) return undefined;
  return val;
}

function renderJson() {
  jsonOut.textContent = JSON.stringify(state, _omitRuntimeKeys, 2);
}

/* =========================================================================
 * Pointer interactions
 *
 * All mouse coords get converted to "world" coordinates via screenToWorld
 * before they're used to position nodes or hit-test wires, so pan + zoom
 * stay transparent to the rest of the editor. Pan engages on middle-click
 * or Space+drag. Wire-drag and node-drag use world coords directly.
 * Marquee drag (on empty canvas, no Space) selects multiple nodes.
 *
 * Touch (iPad / phone) story:
 *   • CSS `touch-action: none` on the canvas blocks the browser's own
 *     pinch-zoom and scroll, so we own all gestures.
 *   • Single touch behaves identically to a mouse left-click: drag a
 *     node, draw a wire, marquee on empty canvas, etc.
 *   • Two-finger gesture below pinch-zooms toward the midpoint AND pans
 *     by midpoint movement at the same time (Maps-style — natural and
 *     replaces the wheel-zoom that doesn't exist on touch). Engaging
 *     pinch cancels any single-touch wire/marquee/drag in flight.
 *   • Apple Pencil (`pointerType === "pen"`) is routed to the ink layer
 *     for handwriting recognition and never to the canvas hit-tests.
 * ======================================================================== */

/* Multi-touch pinch + pan. activePointers tracks every down pointer
 * (touch only — pen and mouse skip it). When 2 are active we enter
 * pinchState and the existing single-pointer move/up handlers no-op
 * (they check pinchState first). Dropping back to 1 or 0 pointers
 * exits the gesture cleanly without resuming any cancelled drag. */
const activePointers = new Map();
let pinchState = null;
function _midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function _ptDist(a, b)   { return Math.hypot(a.x - b.x, a.y - b.y); }
canvas.addEventListener("pointerdown", e => {
  if (e.pointerType !== "touch") return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) {
    // Cancel any single-touch state that the first finger started so
    // the user doesn't accidentally drop a wire or shrink a marquee
    // while pinching.
    if (wire)        { _clearWireSnap(); wire = null; renderWires(); }
    if (marquee)     { marquee = null; if (marqueeEl) marqueeEl.style.display = "none"; }
    if (groupDrag)   { groupDrag = null; }
    if (panning)     { panning = null; canvas.classList.remove("panning"); }
    const pts = [...activePointers.values()];
    const rect = canvas.getBoundingClientRect();
    const mid = _midpoint(pts[0], pts[1]);
    pinchState = {
      startDist: _ptDist(pts[0], pts[1]) || 1,
      startZoom: view.zoom,
      // Lock the WORLD coordinate that lives under the gesture's start
      // midpoint. Then on every move we just place that world point
      // back under the current screen midpoint at the new zoom — same
      // anchor math as wheel-zoom-toward-cursor.
      anchorWorldX: ((mid.x - rect.left) - view.panX) / view.zoom,
      anchorWorldY: ((mid.y - rect.top)  - view.panY) / view.zoom
    };
    e.preventDefault();
  }
}, true);
canvas.addEventListener("pointermove", e => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinchState || activePointers.size < 2) return;
  e.preventDefault();
  const pts = [...activePointers.values()];
  const rect = canvas.getBoundingClientRect();
  const newDist = _ptDist(pts[0], pts[1]);
  const newMid  = _midpoint(pts[0], pts[1]);
  const ratio = newDist / pinchState.startDist;
  view.zoom = Math.max(0.25, Math.min(2.0, pinchState.startZoom * ratio));
  view.panX = (newMid.x - rect.left) - pinchState.anchorWorldX * view.zoom;
  view.panY = (newMid.y - rect.top)  - pinchState.anchorWorldY * view.zoom;
  applyView();
}, true);
function _endTouchPointer(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.delete(e.pointerId);
  if (pinchState && activePointers.size < 2) pinchState = null;
}
canvas.addEventListener("pointerup",     _endTouchPointer, true);
canvas.addEventListener("pointercancel", _endTouchPointer, true);

/* ----- Touch hold-and-swipe context menu --------------------------------
 * Long-press a node OR a collapsed group on touch (~500 ms, < 10 px
 * movement) → small floating menu pops above the held entity. Two
 * action sets, switched by `touchHold.kind`:
 *
 *   NODE  (held a regular node):
 *     ⎘ Duplicate │ ⊞ Group (if ≥2 selected) │ ⌫ Delete
 *   GROUP (held a collapsed group block):
 *     ⎘ Duplicate │ ⊟ Ungroup │ ⌫ Delete
 *     "Duplicate" clones the group + members + internal edges;
 *     "Ungroup" dissolves the group wrapper but keeps members;
 *     "Delete" wipes the group AND every member node.
 *
 * Two release modes either way:
 *   • SWIPE-AND-RELEASE — slide the held finger up onto a chip
 *     (it glows .thm-active to confirm), lift to commit. Single
 *     gesture, never breaks contact with the screen.
 *   • TAP — release first; the menu stays visible and any chip
 *     becomes a normal tap target. Tap outside to dismiss.
 *
 * Mouse and pen skip this — keyboard shortcuts + the existing
 * delete button still cover those flows. */
let touchHold = null;        // { pointerId, kind, entityId, startScreen, timer, menuOpen }
const TOUCH_HOLD_MS       = 500;
const TOUCH_HOLD_MOVE_PX  = 10;

function _ensureTouchMenu() {
  let m = document.getElementById("touch-hold-menu");
  if (m) return m;
  m = document.createElement("div");
  m.id = "touch-hold-menu";
  m.className = "touch-hold-menu";
  // All possible chips live in the DOM; visibility is toggled per
  // gesture in _showTouchMenu based on touchHold.kind. Order chosen
  // for thumb reach (Delete furthest right since it's destructive).
  // Node-mode and group-mode actions share data-action codes that
  // _commitTouchAction routes to the right operation.
  m.innerHTML =
    '<button class="thm-chip thm-node-only"  data-action="duplicate">⎘ Duplicate</button>' +
    '<button class="thm-chip thm-node-only  thm-group" data-action="group">⊞ Group</button>' +
    '<button class="thm-chip thm-group-only" data-action="duplicate-group">⎘ Duplicate</button>' +
    '<button class="thm-chip thm-group-only" data-action="ungroup">⊟ Ungroup</button>' +
    '<button class="thm-chip thm-node-only  thm-danger" data-action="delete">⌫ Delete</button>' +
    '<button class="thm-chip thm-group-only thm-danger" data-action="delete-group">⌫ Delete</button>';
  document.body.appendChild(m);
  m.querySelectorAll(".thm-chip").forEach(b => {
    b.addEventListener("click", () => _commitTouchAction(b.dataset.action));
  });
  // Tap outside the menu closes it without action. Wired once on
  // first construction; the handler is a no-op when the menu is
  // already hidden.
  document.addEventListener("pointerdown", (ev) => {
    const menu = document.getElementById("touch-hold-menu");
    if (!menu || menu.style.display !== "flex") return;
    if (ev.target.closest && ev.target.closest("#touch-hold-menu")) return;
    if (touchHold) return;   // active gesture owns the menu
    _hideTouchMenu();
  }, true);
  return m;
}

function _showTouchMenu(screenX, screenY) {
  const menu = _ensureTouchMenu();
  // Switch chip set based on what was long-pressed. Node-only chips
  // hide on group gestures and vice versa. Group chip (between
  // Duplicate and Delete in node mode) only shows when ≥2 nodes
  // are already selected — single-node menus drop it.
  const kind = touchHold && touchHold.kind || "node";
  const isGroup = kind === "group";
  menu.querySelectorAll(".thm-node-only").forEach(el => {
    el.style.display = isGroup ? "none" : "";
  });
  menu.querySelectorAll(".thm-group-only").forEach(el => {
    el.style.display = isGroup ? "" : "none";
  });
  if (!isGroup) {
    const groupChip = menu.querySelector(".thm-group");
    if (groupChip) groupChip.style.display = (selectedSet.size >= 2) ? "" : "none";
  }
  menu.style.display = "flex";
  // Reset positioning so getBoundingClientRect measures real dimensions.
  menu.style.left = "0px";
  menu.style.top  = "0px";
  const r = menu.getBoundingClientRect();
  let left = screenX - r.width / 2;
  let top  = screenY - r.height - 18;   // 18 = arrow + breathing room
  // Clamp to viewport so the menu never appears off-screen if the user
  // long-pressed near an edge.
  const margin = 8;
  left = Math.max(margin, Math.min(window.innerWidth  - r.width  - margin, left));
  top  = Math.max(margin, Math.min(window.innerHeight - r.height - margin, top));
  menu.style.left = left + "px";
  menu.style.top  = top  + "px";
  // Haptic feedback on devices that support it (Android Chrome). iOS
  // ignores navigator.vibrate silently, so this is harmless there.
  try { if (navigator.vibrate) navigator.vibrate(35); } catch (_) {}
}
function _hideTouchMenu() {
  const m = document.getElementById("touch-hold-menu");
  if (m) {
    m.style.display = "none";
    m.querySelectorAll(".thm-active").forEach(el => el.classList.remove("thm-active"));
  }
}
function _highlightChipAt(x, y) {
  const menu = document.getElementById("touch-hold-menu");
  if (!menu) return;
  const target = document.elementFromPoint(x, y);
  const chip = target && target.closest && target.closest(".thm-chip");
  menu.querySelectorAll(".thm-chip").forEach(el => {
    el.classList.toggle("thm-active", el === chip);
  });
}
function _chipActionAt(x, y) {
  const target = document.elementFromPoint(x, y);
  const chip = target && target.closest && target.closest(".thm-chip");
  return chip ? chip.dataset.action : null;
}
function _startTouchHold(pointerId, entityId, screenX, screenY, kind) {
  if (touchHold && touchHold.timer) clearTimeout(touchHold.timer);
  touchHold = {
    pointerId, entityId,
    kind: kind || "node",   // "node" | "group"
    startScreen: { x: screenX, y: screenY },
    menuOpen: false,
    timer: setTimeout(() => _fireTouchHold(), TOUCH_HOLD_MS)
  };
}
function _cancelTouchHold() {
  if (touchHold && touchHold.timer) clearTimeout(touchHold.timer);
  touchHold = null;
}
function _fireTouchHold() {
  if (!touchHold) return;
  // Snap any held nodes back to their original positions before
  // cancelling the drag — sub-threshold finger tremor (< 10 px) can
  // shift things by a pixel or two during the hold, which feels
  // wrong when the menu pops. The pushHistory("drag-start:") /
  // pushHistory("group-drag-start:") entries logged at touch-down
  // become exact no-ops against current state — harmless.
  if (groupDrag && groupDrag.originals) {
    groupDrag.originals.forEach((orig, id) => {
      const n = nodeById(id);
      if (n) { n.x = orig.x; n.y = orig.y; }
    });
  }
  if (groupDrag) groupDrag = null;
  if (wire)      { _clearWireSnap(); wire = null; renderWires(); }
  // Make sure the held entity is the active selection target so
  // operations have something to act on. Node mode → ensure the node
  // is in selectedSet (lets us cover both single-node and pre-existing
  // multi-select). Group mode → set selectedGroupId; ungroupSelection
  // and the group-specific helpers read from there.
  if (touchHold.kind === "group") {
    selectedSet.clear();
    selected = null;
    selectedGroupId = touchHold.entityId;
  } else {
    if (!selectedSet.has(touchHold.entityId)) selectOne(touchHold.entityId);
  }
  touchHold.menuOpen = true;
  _showTouchMenu(touchHold.startScreen.x, touchHold.startScreen.y);
  render();
}
function _commitTouchAction(action) {
  // Group-mode action ids carry a "-group" suffix where they conflict
  // with node-mode (duplicate / delete). Ungroup is group-only so its
  // id stays bare. The kind switch happens here, not via separate
  // chip click handlers, so the menu DOM stays a single static
  // declaration.
  if      (action === "duplicate")        duplicateSelection();
  else if (action === "delete")           deleteSelection();
  else if (action === "group")            groupSelection();
  else if (action === "duplicate-group") {
    if (touchHold && touchHold.entityId) duplicateGroup(touchHold.entityId);
  }
  else if (action === "delete-group") {
    if (touchHold && touchHold.entityId) deleteGroup(touchHold.entityId);
  }
  else if (action === "ungroup")          ungroupSelection();
  _hideTouchMenu();
  touchHold = null;
}

canvas.addEventListener("pointerdown", e => {
  // Touch + pen come through the same event — only react to primary
  // pointer, and ignore pen entirely (the ink layer handles that).
  if (e.pointerType === "pen") return;
  // Multi-touch in progress (or about to be) — let the pinch handler own it.
  if (pinchState || activePointers.size >= 2) return;
  // Pan: middle-click anywhere, or Space + left-click.
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    e.preventDefault();
    panning = { startX: e.clientX, startY: e.clientY, startPanX: view.panX, startPanY: view.panY };
    canvas.classList.add("panning");
    return;
  }

  const w = screenToWorld(e.clientX, e.clientY);
  const port = e.target.closest && e.target.closest(".port");

  if (port && port.dataset.dir === "out") {
    e.preventDefault();
    const start = portPos(port.dataset.node, port.dataset.port, true);
    wire = {
      fromNode: port.dataset.node, fromPort: port.dataset.port, fromType: port.dataset.type,
      x1: start.x, y1: start.y,
      x2: w.x, y2: w.y
    };
    // One-line diagnostic so users on flaky touch devices can paste
    // the console output if snap isn't behaving. Tells us what
    // pointerType the device reports + which radius they're getting.
    console.log("[wire] start type=" + JSON.stringify(e.pointerType) +
                " radius=" + _snapRadiusFor(e.pointerType) +
                " from=" + port.dataset.node + "." + port.dataset.port);
    renderWires(wire);
    return;
  }
  if (port && port.dataset.dir === "in") {
    const idx = state.edges.findIndex(ed => ed.to.node === port.dataset.node && ed.to.port === port.dataset.port);
    if (idx >= 0) {
      e.preventDefault();
      pushHistory("disconnect");
      const removed = state.edges.splice(idx, 1)[0];
      const fromNode = nodeById(removed.from.node);
      const portDef  = defOf(fromNode).outs.find(p => p.n === removed.from.port);
      const start    = portPos(removed.from.node, removed.from.port, true);
      wire = {
        fromNode: removed.from.node, fromPort: removed.from.port, fromType: portDef.t,
        x1: start.x, y1: start.y,
        x2: w.x, y2: w.y
      };
      render(); renderWires(wire);
      return;
    }
  }

  // Toggle button on a group's head — works on both the expanded
  // backdrop's collapse button (⊟) and the collapsed block's expand
  // button (⊞). Same data-group-toggle attribute on both. Has to
  // run BEFORE the generic node-element / group-header click logic
  // since the button sits inside both containers.
  const toggleBtn = e.target.closest && e.target.closest("[data-group-toggle]");
  if (toggleBtn) {
    e.stopPropagation();
    toggleGroupCollapse(toggleBtn.dataset.groupToggle);
    return;
  }

  // Group-backdrop header — click selects the group entity; drag
  // the header to translate all members together. Double-click to
  // collapse (handled separately on dblclick).
  const groupHeadEl = e.target.closest && e.target.closest(".group-backdrop");
  if (groupHeadEl && e.target.closest(".group-head")) {
    const gid = groupHeadEl.dataset.groupId;
    selectedSet.clear();
    selected = null;
    selectedGroupId = gid;
    pushHistory("group-drag-start:" + gid);
    const g = groupById(gid);
    const originals = new Map();
    if (g && g.members) g.members.forEach(mid => {
      const sn = nodeById(mid);
      if (sn) originals.set(mid, { x: sn.x, y: sn.y });
    });
    groupDrag = { id: gid, dx: 0, dy: 0, startX: w.x, startY: w.y, originals, kind: "group" };
    // Touch-only: arm the long-press timer on the expanded group
    // header too — same gesture, same chip set as the collapsed
    // block. The user may want to Duplicate / Ungroup / Delete a
    // group whether it's currently expanded or condensed.
    if (e.pointerType === "touch") {
      _startTouchHold(e.pointerId, gid, e.clientX, e.clientY, "group");
    }
    render();
    return;
  }

  const nodeEl = e.target.closest && e.target.closest(".node");
  if (nodeEl) {
    // Collapsed group block (data-group-id, no data-id) — clicking
    // the header selects the group entity and starts a drag that
    // moves all members in unison (preserving their relative
    // layout for when the group is re-expanded).
    if (nodeEl.dataset.groupId && !nodeEl.dataset.id) {
      const gid = nodeEl.dataset.groupId;
      const onHead = !!(e.target.closest(".node-head") || e.target.closest(".node-strip"));
      const onPort = e.target.classList && e.target.classList.contains("port");
      if (onPort) {
        // Fall through to the port-drag path below — port handling
        // below treats data-node + data-port as the source, which
        // we set to the inner node + inner port on stub render.
      } else {
        selectedSet.clear();
        selected = null;
        selectedGroupId = gid;
        if (onHead) {
          pushHistory("group-drag-start:" + gid);
          const g = groupById(gid);
          const originals = new Map();
          if (g && g.members) g.members.forEach(mid => {
            const sn = nodeById(mid);
            if (sn) originals.set(mid, { x: sn.x, y: sn.y });
          });
          groupDrag = { id: gid, dx: 0, dy: 0, startX: w.x, startY: w.y, originals, kind: "group" };
          // Touch-only: arm the long-press timer on the collapsed group
          // head. Same gesture as a node hold but the menu chips swap
          // to Duplicate / Ungroup / Delete via touchHold.kind = "group".
          if (e.pointerType === "touch") {
            _startTouchHold(e.pointerId, gid, e.clientX, e.clientY, "group");
          }
        }
        render();
        return;
      }
    }
    const id = nodeEl.dataset.id;
    if (!id) { /* fall through if not a regular node — port handling below */ }
    else {
    if (e.shiftKey) {
      addToSelection(id);
    } else if (!selectedSet.has(id)) {
      selectOne(id);
    } else {
      // Already in selection — clicking re-anchors primary without
      // collapsing the set (so a group drag still moves all selected).
      selected = id;
    }
    selectedGroupId = null;
    const onHead = !!(e.target.closest(".node-head") || e.target.closest(".node-strip"));
    if (onHead) {
      const node = nodeById(id);
      // Snapshot once at drag start so undo restores the pre-drag layout
      // (rather than some mid-drag state). Coalescing is then unnecessary
      // for moves.
      pushHistory("drag-start:" + id);
      // Group drag: capture starting positions for every selected node so
      // they all translate by the same delta as the primary moves.
      const originals = new Map();
      selectedSet.forEach(sid => {
        const sn = nodeById(sid);
        if (sn) originals.set(sid, { x: sn.x, y: sn.y });
      });
      groupDrag = {
        id, dx: w.x - node.x, dy: w.y - node.y,
        startX: w.x, startY: w.y,
        originals
      };
      // Touch-only: arm a long-press timer. If the user holds without
      // moving for ~500 ms, the gesture flips into "menu mode" and the
      // drag we just set up gets cancelled before any movement happens
      // (so the node doesn't jump). Mouse and pen skip this — pen
      // never reaches here anyway, and mouse users have keyboard
      // shortcuts + the keyboard delete key.
      if (e.pointerType === "touch") {
        _startTouchHold(e.pointerId, id, e.clientX, e.clientY);
      }
    }
    render();
    return;
    }
  }

  // Empty canvas: shift extends current selection via marquee, plain
  // click clears (and starts a new marquee).
  if (!e.shiftKey) clearSelection();
  marquee = { startWX: w.x, startWY: w.y, x: w.x, y: w.y, w: 0, h: 0 };
  marqueeEl.style.display = "block";
  paintMarquee();
  render();
});

document.addEventListener("pointermove", e => {
  // Multi-touch pinch in progress — ignore single-pointer logic so it
  // doesn't drag a wire or update a marquee from one of the pinch fingers.
  if (pinchState) return;
  // Touch-hold tracking. Two phases:
  //   1. Pre-fire: timer hasn't fired yet. If the user moves more than
  //      a few pixels we cancel the timer and let the normal drag run.
  //   2. Menu open: route moves to chip highlighting and absorb them
  //      so the underlying drag/marquee logic stays frozen.
  if (touchHold && e.pointerId === touchHold.pointerId) {
    if (touchHold.menuOpen) {
      _highlightChipAt(e.clientX, e.clientY);
      e.preventDefault && e.preventDefault();
      return;
    }
    const dx = e.clientX - touchHold.startScreen.x;
    const dy = e.clientY - touchHold.startScreen.y;
    if (Math.hypot(dx, dy) > TOUCH_HOLD_MOVE_PX) _cancelTouchHold();
  }
  if (panning) {
    view.panX = panning.startPanX + (e.clientX - panning.startX);
    view.panY = panning.startPanY + (e.clientY - panning.startY);
    applyView();
    return;
  }
  const w = screenToWorld(e.clientX, e.clientY);
  if (groupDrag) {
    const dx = w.x - groupDrag.startX;
    const dy = w.y - groupDrag.startY;
    groupDrag.originals.forEach((orig, id) => {
      const n = nodeById(id);
      if (!n) return;
      n.x = Math.max(0, orig.x + dx);
      n.y = Math.max(0, orig.y + dy);
    });
    render();
    return;
  }
  if (marquee) {
    marquee.x = Math.min(marquee.startWX, w.x);
    marquee.y = Math.min(marquee.startWY, w.y);
    marquee.w = Math.abs(w.x - marquee.startWX);
    marquee.h = Math.abs(w.y - marquee.startWY);
    paintMarquee();
    return;
  }
  if (wire) {
    wire.x2 = w.x; wire.y2 = w.y;
    // Snap-to-nearest-compatible-port. _pickSnap honors hysteresis —
    // once a port is acquired we hold it until the finger leaves the
    // sticky exit radius, so a few-pixel drift on the last move
    // before release doesn't drop the snap. Endpoint is in world
    // coords, port rect is in screen coords — convert through the
    // current view transform.
    const radius = _snapRadiusFor(e.pointerType);
    const snap = _pickSnap(e.clientX, e.clientY, wire.fromType, wire.fromNode, radius);
    // Diagnostic: log first move (so we know moves are firing) and
    // every snap-state change. Quiet on subsequent moves with same
    // snap target to avoid spam.
    if (wire._moveCount === undefined) {
      wire._moveCount = 0;
      console.log("[wire] first move type=" + JSON.stringify(e.pointerType) +
                  " at=" + e.clientX + "," + e.clientY +
                  " snap=" + (snap ? snap.dataset.node + "." + snap.dataset.port : "none"));
    }
    wire._moveCount++;
    if (snap !== wire._lastLoggedSnap) {
      console.log("[wire] snap " + (snap ? "→ " + snap.dataset.node + "." + snap.dataset.port : "cleared"));
      wire._lastLoggedSnap = snap || null;
    }
    _setWireSnap(snap);
    if (snap) {
      const r = snap.getBoundingClientRect();
      const cx = r.left + r.width  / 2;
      const cy = r.top  + r.height / 2;
      const canvasRect = canvas.getBoundingClientRect();
      wire.x2 = ((cx - canvasRect.left) - view.panX) / view.zoom;
      wire.y2 = ((cy - canvasRect.top)  - view.panY) / view.zoom;
    }
    renderWires(wire);
  }
});

document.addEventListener("pointerup", e => {
  // Skip when pinch is in progress — _endTouchPointer handles its own bookkeeping.
  if (pinchState) return;
  // Touch-hold dispatch. If menu is open and the user releases over a
  // chip → commit that action. If they release elsewhere → leave the
  // menu open (they may tap a chip with a separate touch). If the
  // timer never fired → just clean up.
  if (touchHold && e.pointerId === touchHold.pointerId) {
    if (touchHold.menuOpen) {
      const action = _chipActionAt(e.clientX, e.clientY);
      if (action) _commitTouchAction(action);
      else        touchHold = null;   // menu stays visible; tap-outside watcher closes it
      return;
    }
    _cancelTouchHold();
  }
  if (panning) {
    panning = null;
    canvas.classList.remove("panning");
    return;
  }
  if (groupDrag) { groupDrag = null; }
  if (marquee) {
    // Select all nodes whose origin falls inside the marquee. Any node
    // already in selectedSet (because shift was held at marquee start)
    // stays selected.
    state.nodes.forEach(n => {
      if (n.x >= marquee.x && n.x <= marquee.x + marquee.w &&
          n.y >= marquee.y && n.y <= marquee.y + marquee.h) {
        selectedSet.add(n.id);
        selected = n.id;
      }
    });
    marquee = null;
    marqueeEl.style.display = "none";
    render();
    return;
  }
  if (wire) {
    // FOUR-layer hit-test, evaluated in order. First non-null wins.
    //   (a) e.target.closest(".port")      — normal path. Filtered:
    //                                        on touch, implicit pointer-
    //                                        event capture pins e.target
    //                                        to the SOURCE port for the
    //                                        whole gesture, so without
    //                                        the okPort filter the chain
    //                                        latched onto the out-port
    //                                        the wire started from and
    //                                        the dir==="in" check below
    //                                        silently rejected it. This
    //                                        was THE Chromebook bug.
    //   (b) elementFromPoint(release)      — bypasses e.target's stale
    //                                        capture by querying the
    //                                        actual pixel under release.
    //   (c) wire._snapPort                 — hysteretic snap from move
    //   (d) findSnapPort at release coords — last-chance fresh search;
    //                                        covers the case where the
    //                                        device fired pointerdown →
    //                                        pointerup with zero moves
    //                                        between (so wire._snapPort
    //                                        was never set).
    //
    // okPort filters each layer's RAW vote to "valid IN port that
    // isn't on the source node". Layers that fail the filter become
    // null so subsequent layers get to vote.
    const okPort = p => p && p.dataset.dir === "in" && p.dataset.node !== wire.fromNode;
    const rawA = e.target.closest && e.target.closest(".port");
    const elPt = document.elementFromPoint(e.clientX, e.clientY);
    const rawB = elPt && elPt.closest && elPt.closest(".port");
    const rawC = wire._snapPort;
    const targetA = okPort(rawA) ? rawA : null;
    const targetB = okPort(rawB) ? rawB : null;
    const targetC = okPort(rawC) ? rawC : null;
    const radius  = _snapRadiusFor(e.pointerType);
    const targetD = (targetA || targetB || targetC) ? null
                  : findSnapPort(e.clientX, e.clientY, wire.fromType, wire.fromNode, radius);
    let port = targetA || targetB || targetC || targetD;
    // Diagnostic — show every layer's RAW vote (filter dim-shows what
    // got rejected). Format compresses to one line per release.
    const fmt = p => p ? (p.dataset.node + "." + p.dataset.port + "/" + p.dataset.dir) : "null";
    const rej = (raw, ok) => raw && !ok ? " (rej)" : "";
    console.log("[wire] up at=" + e.clientX + "," + e.clientY +
                " moves=" + (wire._moveCount || 0) +
                " A=" + fmt(rawA) + rej(rawA, targetA) +
                " B=" + fmt(rawB) + rej(rawB, targetB) +
                " C=" + fmt(rawC) + rej(rawC, targetC) +
                " D=" + fmt(targetD) +
                " → " + fmt(port));
    _clearWireSnap();
    _commitWireConnection(wire, port);
    wire = null;
    render();
  }
});

/* Some touch drivers (we've seen this on Chromebook + a few hybrid
 * Surface devices) fire pointercancel instead of pointerup when a
 * touch gesture is "absorbed" by the system — e.g. a swipe touches
 * an edge zone, or implicit capture on the start element ends. If
 * a wire is in flight when that happens, pointerup never runs and
 * the wire silently dangles forever. Treat pointercancel as a
 * commit attempt: same four-layer hit-test as pointerup, just
 * tagged so the diagnostic distinguishes the two paths.
 *
 * Marquee / drag / pan don't need this — they're stateless on
 * cancel and the existing pinch handler already does the cleanup
 * for two-finger gestures. Wire is the one that holds state across
 * pointerdown→pointerup AND has a target-acquisition step that
 * needs to fire on the way out. */
document.addEventListener("pointercancel", e => {
  if (pinchState) return;
  if (touchHold && touchHold.menuOpen) {
    _hideTouchMenu();
    touchHold = null;
    return;
  }
  if (!wire) return;
  // Same okPort filter as the pointerup handler — see the comment
  // there for why source-port-via-implicit-capture has to be filtered.
  const okPort = p => p && p.dataset.dir === "in" && p.dataset.node !== wire.fromNode;
  const rawA = e.target.closest && e.target.closest(".port");
  const elPt = document.elementFromPoint(e.clientX, e.clientY);
  const rawB = elPt && elPt.closest && elPt.closest(".port");
  const rawC = wire._snapPort;
  const targetA = okPort(rawA) ? rawA : null;
  const targetB = okPort(rawB) ? rawB : null;
  const targetC = okPort(rawC) ? rawC : null;
  const radius  = _snapRadiusFor(e.pointerType);
  const targetD = (targetA || targetB || targetC) ? null
                : findSnapPort(e.clientX, e.clientY, wire.fromType, wire.fromNode, radius);
  let port = targetA || targetB || targetC || targetD;
  const fmt = p => p ? (p.dataset.node + "." + p.dataset.port + "/" + p.dataset.dir) : "null";
  const rej = (raw, ok) => raw && !ok ? " (rej)" : "";
  console.log("[wire] CANCEL at=" + e.clientX + "," + e.clientY +
              " moves=" + (wire._moveCount || 0) +
              " A=" + fmt(rawA) + rej(rawA, targetA) +
              " B=" + fmt(rawB) + rej(rawB, targetB) +
              " C=" + fmt(rawC) + rej(rawC, targetC) +
              " D=" + fmt(targetD) +
              " → " + fmt(port));
  _clearWireSnap();
  _commitWireConnection(wire, port);
  wire = null;
  render();
});

function paintMarquee() {
  if (!marquee || !marqueeEl) return;
  // Project world rect back to screen for the overlay.
  const sx = marquee.x * view.zoom + view.panX;
  const sy = marquee.y * view.zoom + view.panY;
  marqueeEl.style.left   = sx + "px";
  marqueeEl.style.top    = sy + "px";
  marqueeEl.style.width  = (marquee.w * view.zoom) + "px";
  marqueeEl.style.height = (marquee.h * view.zoom) + "px";
}

// Wheel zoom: zoom-toward-cursor, clamped [0.25, 2.0]. Shift = finer step.
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const wx = (mx - view.panX) / view.zoom;
  const wy = (my - view.panY) / view.zoom;
  const factor = e.shiftKey ? 1.05 : 1.18;
  const next = e.deltaY < 0 ? view.zoom * factor : view.zoom / factor;
  view.zoom = Math.max(0.25, Math.min(2.0, next));
  view.panX = mx - wx * view.zoom;
  view.panY = my - wy * view.zoom;
  applyView();
}, { passive: false });

if (viewHud) viewHud.addEventListener("click", () => { resetView(); });

function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function deleteSelection() {
  if (selectedSet.size === 0) return;
  pushHistory("delete");
  const ids = new Set(selectedSet);
  state.nodes = state.nodes.filter(n => !ids.has(n.id));
  state.edges = state.edges.filter(ed => !ids.has(ed.from.node) && !ids.has(ed.to.node));
  Object.keys(state.exposed).forEach(k => {
    const dot = k.indexOf(".");
    const idPart = dot >= 0 ? k.slice(0, dot) : k;
    if (ids.has(idPart)) delete state.exposed[k];
  });
  // Phase 6.2.1 — release any shader-instance GPU state held by
  // deleted nodes. Free the uniform buffer + drop the bind-group
  // reference so the GPU memory is reclaimed immediately.
  if (typeof _disposeShaderInstance === "function") {
    ids.forEach(id => _disposeShaderInstance(id));
  }
  clearSelection();
  render();
}

/* ---------- Copy / paste / duplicate ----------
 * Serializes the selected nodes plus any edges that connect TWO selected
 * nodes (so external wires don't dangle). Exposed-setter entries for
 * selected nodes are included. Pasting regenerates IDs and offsets
 * positions so the paste lands visibly next to the original. */
const CLIPBOARD_MIME = "application/x-gamma-patch-fragment";
let inMemoryClipboard = null;

function serializeSelection() {
  if (selectedSet.size === 0) return null;
  const ids = new Set(selectedSet);
  const nodes = state.nodes
    .filter(n => ids.has(n.id))
    .map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, params: { ...n.params } }));
  const edges = state.edges
    .filter(ed => ids.has(ed.from.node) && ids.has(ed.to.node))
    .map(ed => ({ from: { ...ed.from }, to: { ...ed.to } }));
  const exposed = {};
  Object.keys(state.exposed).forEach(k => {
    const dot = k.indexOf(".");
    const idPart = dot >= 0 ? k.slice(0, dot) : k;
    if (ids.has(idPart)) exposed[k] = state.exposed[k];
  });
  return JSON.stringify({ kind: CLIPBOARD_MIME, nodes, edges, exposed }, _omitRuntimeKeys);
}

function pasteFragment(json, offset) {
  let frag;
  try { frag = JSON.parse(json); } catch (e) { return false; }
  if (!frag || frag.kind !== CLIPBOARD_MIME || !Array.isArray(frag.nodes)) return false;
  pushHistory("paste");
  const idMap = {};       // old id → new id
  const dx = offset && offset.x || 24;
  const dy = offset && offset.y || 24;
  frag.nodes.forEach(n => {
    const newId = uid();
    idMap[n.id] = newId;
    state.nodes.push({
      id: newId,
      type: n.type,
      x: n.x + dx,
      y: n.y + dy,
      params: { ...n.params }
    });
  });
  (frag.edges || []).forEach(ed => {
    const fn = idMap[ed.from.node];
    const tn = idMap[ed.to.node];
    if (!fn || !tn) return;
    state.edges.push({
      from: { node: fn, port: ed.from.port },
      to:   { node: tn, port: ed.to.port }
    });
  });
  Object.keys(frag.exposed || {}).forEach(k => {
    const dot = k.indexOf(".");
    const oldId = dot >= 0 ? k.slice(0, dot) : k;
    const rest = dot >= 0 ? k.slice(dot) : "";
    const newId = idMap[oldId];
    if (newId) state.exposed[newId + rest] = frag.exposed[k];
  });
  // Select the newly pasted nodes so subsequent moves operate on them.
  selectedSet.clear();
  Object.values(idMap).forEach(id => selectedSet.add(id));
  selected = Object.values(idMap).pop() || null;
  render();
  return true;
}

function copySelectionToClipboard() {
  const json = serializeSelection();
  if (!json) return;
  inMemoryClipboard = json;
  // Best-effort write to the system clipboard so paste survives a tab
  // refresh (the in-memory copy doesn't). Fails silently when the page
  // isn't focused or the user hasn't granted permission.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(json).catch(() => {});
  }
}

function pasteFromClipboard() {
  // Try the system clipboard first; fall back to the in-memory copy.
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(text => {
      if (!pasteFragment(text) && inMemoryClipboard) pasteFragment(inMemoryClipboard);
    }).catch(() => {
      if (inMemoryClipboard) pasteFragment(inMemoryClipboard);
    });
  } else if (inMemoryClipboard) {
    pasteFragment(inMemoryClipboard);
  }
}

function duplicateSelection() {
  const json = serializeSelection();
  if (json) pasteFragment(json, { x: 24, y: 24 });
}

document.addEventListener("keydown", e => {
  // Space: hold to pan. Suppress in text inputs so typing a space still
  // works in fields (palette filter, AI prompt, .gdsp source, etc.).
  if (e.code === "Space" && !spaceHeld && !isTextInput(document.activeElement)) {
    e.preventDefault();
    spaceHeld = true;
    canvas.classList.add("pan-ready");
  }

  // Delete: works on the entire selection.
  if ((e.key === "Delete" || e.key === "Backspace") && selectedSet.size && !isTextInput(e.target)) {
    e.preventDefault();
    deleteSelection();
    return;
  }

  // / focuses palette search. Vim/GitHub convention.
  if (e.key === "/" && document.activeElement !== search && !isTextInput(document.activeElement)) {
    e.preventDefault();
    search.focus();
    search.select();
    return;
  }

  // Escape: dismiss modals; clear selection.
  if (e.key === "Escape") {
    const helpModal = document.getElementById("help-modal");
    if (helpModal && helpModal.style.display !== "none") {
      helpModal.style.display = "none";
      return;
    }
    if (selectedSet.size) {
      clearSelection();
      render();
    }
    return;
  }

  // Cmd/Ctrl-modified shortcuts.
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !isTextInput(e.target)) {
    // Undo / Redo
    if (e.key === "z" || e.key === "Z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (e.key === "y" || e.key === "Y") {
      e.preventDefault();
      redo();
      return;
    }
    // Save .gpatch
    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      const saveBtn = document.getElementById("btn-save");
      if (saveBtn) saveBtn.click();
      return;
    }
    // Select all nodes
    if (e.key === "a" || e.key === "A") {
      e.preventDefault();
      selectAll();
      return;
    }
    // Copy / paste / duplicate selected subgraph
    if (e.key === "c" || e.key === "C") {
      if (selectedSet.size === 0) return;
      e.preventDefault();
      copySelectionToClipboard();
      return;
    }
    if (e.key === "v" || e.key === "V") {
      e.preventDefault();
      pasteFromClipboard();
      return;
    }
    if (e.key === "d" || e.key === "D") {
      if (selectedSet.size === 0) return;
      e.preventDefault();
      duplicateSelection();
      return;
    }
    // Group / ungroup. Ctrl+G groups the current selection (1+
    // free nodes); Ctrl+Shift+G removes the currently-selected
    // group entity (members revert to free top-level nodes).
    if ((e.key === "g" || e.key === "G") && !e.shiftKey) {
      if (selectedSet.size === 0) return;
      e.preventDefault();
      groupSelection();
      return;
    }
    if ((e.key === "g" || e.key === "G") && e.shiftKey) {
      if (!selectedGroupId) return;
      e.preventDefault();
      ungroupSelection();
      return;
    }
    // Reset view (Cmd+0 is OS-reserved on some browsers; we also bind
    // bare "0" below for the same effect)
    if (e.key === "0") {
      e.preventDefault();
      resetView();
      return;
    }
  }
  // Bare 'e' (no modifier) -- two meanings depending on selection:
  //   * group selected -> toggle expand/collapse
  //   * exactly one node selected (no group) -> open per-node code editor
  // Skipped if the user is typing in a field.
  if (!mod && (e.key === "e" || e.key === "E") && !isTextInput(document.activeElement)) {
    if (selectedGroupId) {
      e.preventDefault();
      toggleGroupCollapse(selectedGroupId);
      return;
    }
    if (selectedSet && selectedSet.size === 1) {
      e.preventDefault();
      openNodeEditorForSelection();
      return;
    }
  }

  // Bare keys (no modifier): tab switching + view reset, but NOT when
  // typing in a field.
  if (!mod && !e.shiftKey && !isTextInput(document.activeElement)) {
    if (e.key === "1") { switchTab("props"); return; }
    if (e.key === "2") { switchTab("codepreview"); switchCodePreviewSub("code");  return; }
    if (e.key === "3") { switchTab("codepreview"); switchCodePreviewSub("json");  return; }
    if (e.key === "4") { switchTab("udsp"); return; }
    if (e.key === "5") { switchTab("monitor"); return; }
    if (e.key === "0") { e.preventDefault(); resetView(); return; }
  }
});

/* Double-click a collapsed-group block (or its expanded backdrop
 * header) to flip the collapse state. Quick gesture for users who
 * don't want to learn the keyboard shortcut. */
canvas.addEventListener("dblclick", (e) => {
  const collapsed = e.target.closest && e.target.closest(".node.group-node");
  if (collapsed && collapsed.dataset.groupId) {
    toggleGroupCollapse(collapsed.dataset.groupId);
    return;
  }
  const expanded = e.target.closest && e.target.closest(".group-backdrop");
  if (expanded && expanded.dataset.groupId &&
      (e.target.closest(".group-head") || e.target === expanded)) {
    toggleGroupCollapse(expanded.dataset.groupId);
    return;
  }
});

document.addEventListener("keyup", e => {
  if (e.code === "Space") {
    spaceHeld = false;
    canvas.classList.remove("pan-ready");
  }
});

function switchTab(name) {
  const tab = document.querySelector('.tab[data-tab="' + name + '"]');
  if (tab) tab.click();
}

(function setupHelpModal() {
  const modal = document.getElementById("help-modal");
  const openBtn = document.getElementById("btn-help");
  const closeBtn = document.getElementById("btn-help-close");
  if (!modal || !openBtn || !closeBtn) return;
  openBtn.addEventListener("click", () => { modal.style.display = "flex"; });
  closeBtn.addEventListener("click", () => { modal.style.display = "none"; });
  modal.addEventListener("click", e => { if (e.target === modal) modal.style.display = "none"; });
})();

(function paintAppVersion() {
  const el = document.getElementById("app-version");
  if (!el) return;
  if (APP_VERSION === "0.0.0") {
    el.textContent = "dev";
    el.classList.add("dev");
    el.title = "Local pre-release build — version will bump on first push.";
  } else {
    el.textContent = "v" + APP_VERSION;
  }
})();

/* ---------- Editable patch filename ----------
 * Click the filename in the header to rename. Updates state.filename
 * (the .gpatch save name) and state.patchName (the C++ class name —
 * sanitized to a valid C++ identifier). Pushes one undo entry per edit. */
(function setupFilenameEdit() {
  const el = document.getElementById("filename");
  if (!el) return;
  let originalText = "";

  function startEdit() {
    if (el.classList.contains("editing")) return;
    el.classList.add("editing");
    el.contentEditable = "true";
    originalText = state.filename || "untitled.gpatch";
    el.textContent = originalText;
    // Select the stem (without .gpatch) so retyping is fast.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    const dotIdx = originalText.lastIndexOf(".");
    if (dotIdx > 0) {
      const tn = el.firstChild;
      if (tn && tn.nodeType === 3) {
        range.setStart(tn, 0);
        range.setEnd(tn, dotIdx);
      }
    }
    sel.removeAllRanges();
    sel.addRange(range);
    el.focus();
  }

  function commitEdit(save) {
    if (!el.classList.contains("editing")) return;
    el.classList.remove("editing");
    el.contentEditable = "false";
    if (!save) {
      el.textContent = originalText;
      return;
    }
    let raw = (el.textContent || "").trim();
    if (!raw) raw = "untitled";
    // Filename: keep only safe filesystem chars, ensure .gpatch suffix.
    let filename = raw.replace(/[^A-Za-z0-9_\-.]/g, "_");
    if (!/\.gpatch$/i.test(filename)) filename = filename.replace(/\.[^.]+$/, "") + ".gpatch";
    // Class name: stem stripped to valid C++ identifier.
    const stem = filename.replace(/\.gpatch$/i, "");
    let className = stem.replace(/[^A-Za-z0-9_]/g, "_");
    if (/^\d/.test(className)) className = "_" + className;
    if (!className) className = "MyPatch";

    if (filename !== originalText || className !== state.patchName) {
      pushHistory("rename");
      state.filename = filename;
      state.patchName = className;
    }
    el.textContent = filename;
    render();
  }

  el.addEventListener("click", startEdit);
  el.addEventListener("focus", e => { if (!el.classList.contains("editing")) startEdit(); });
  el.addEventListener("blur", () => commitEdit(true));
  el.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); el.blur(); }
    if (e.key === "Escape") { e.preventDefault(); commitEdit(false); el.blur(); }
  });
})();

/* =========================================================================
 * Toolbar
 * ======================================================================== */
document.getElementById("btn-reset").addEventListener("click", () => {
  if (state.nodes.length && !confirm("Reset to demo patch?")) return;
  reset(); render();
});

// Phase 6.6.31 — Clear button. Like Reset but leaves the canvas
// empty instead of repopulating with the demo patch. Useful when
// you want to start from scratch without first deleting every
// node by hand. Confirms when nodes/edges exist (so an accidental
// click doesn't nuke an in-progress patch).
document.getElementById("btn-clear").addEventListener("click", () => {
  const hasContent = (state.nodes && state.nodes.length) || (state.edges && state.edges.length);
  if (hasContent && !confirm("Clear the graph? All nodes + edges will be removed.")) return;
  pushHistory("clear");
  _cleanupBeforePatchSwitch();
  state = freshState();
  clearSelection();
  nextId = 1;
  // Don't wipe the undo/redo stacks — Clear is undo-able, same as
  // any other edit. pushHistory above captured the pre-clear state.
  render();
  renderProps && renderProps();
});

document.getElementById("btn-delete").addEventListener("click", () => {
  deleteSelection();
});

document.getElementById("btn-gen").addEventListener("click", () => {
  document.querySelector('.tab[data-tab="codepreview"]').click();
  switchCodePreviewSub("code");
});

document.getElementById("btn-save").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, _omitRuntimeKeys, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = state.filename || "patch.gpatch";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById("btn-load").addEventListener("click", () => {
  document.getElementById("file-input").click();
});

/* v0.2.23 — extracted from the file-input handler's onload body so
 * the same migration + state-setup path runs whether the patch comes
 * from a user-selected .gpatch file OR from a `<script id="gamma-
 * embedded-patch">` tag baked into a standalone HTML export. The
 * `filename` arg labels the source in state.filename + drives the
 * patchName fallback when the loaded JSON didn't carry one. */
function _applyLoadedPatch(loaded, filename) {
  if (!loaded || !loaded.nodes || !loaded.edges) throw new Error("missing nodes/edges");
  state = Object.assign({ version: 2, patchName: "MyPatch", exposed: {}, groups: [] }, loaded);
  if (!Array.isArray(state.groups)) state.groups = [];
  if (!state.rig || !Array.isArray(state.rig.displays)) state.rig = defaultRig();
  if (typeof state.rig.shaderCenterYaw   !== "number") state.rig.shaderCenterYaw   = 0;
  if (typeof state.rig.shaderCenterPitch !== "number") state.rig.shaderCenterPitch = 0;
  state.rig.surface = _migrateRigSurface(state.rig.surface
    || (RIG_TEMPLATES[state.rig.templateKey] && RIG_TEMPLATES[state.rig.templateKey].surface)
    || null);
  if (!Array.isArray(state.rig.sweetSpot) || state.rig.sweetSpot.length !== 3) {
    state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface);
  }
  if (typeof state.rig.surfaceVisible !== "boolean") state.rig.surfaceVisible = true;
  state.rig.displays.forEach(d => {
    if (!("warpMesh" in d) || (d.warpMesh !== null && !_validateWarpMesh(d.warpMesh))) {
      d.warpMesh = null;
    }
    d.edgeBlend = _migrateEdgeBlend(d.edgeBlend);
    if (!d.keystoneCorners || typeof d.keystoneCorners !== "object") {
      d.keystoneCorners = { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 };
    } else {
      d.keystoneCorners.tlx  = +(d.keystoneCorners.tlx)  || 0;
      d.keystoneCorners.tly  = +(d.keystoneCorners.tly)  || 0;
      d.keystoneCorners.trx  = +(d.keystoneCorners.trx)  || 0;
      d.keystoneCorners.try_ = +(d.keystoneCorners.try_) || 0;
      d.keystoneCorners.blx  = +(d.keystoneCorners.blx)  || 0;
      d.keystoneCorners.bly  = +(d.keystoneCorners.bly)  || 0;
      d.keystoneCorners.brx  = +(d.keystoneCorners.brx)  || 0;
      d.keystoneCorners.bry  = +(d.keystoneCorners.bry)  || 0;
    }
    if (!('bezierCorrections' in d)) d.bezierCorrections = null;
    if (d.bezierCorrections && (!Array.isArray(d.bezierCorrections.ctrl) ||
        !Number.isInteger(d.bezierCorrections.cols) ||
        !Number.isInteger(d.bezierCorrections.rows))) {
      d.bezierCorrections = null;
    }
  });
  state.nodes.forEach(n => {
    if (n.type === "VisualOutput") {
      if (!n.params) n.params = {};
      if (typeof n.params.display !== "number") n.params.display = 0;
    }
  });
  const fname = filename || "embedded.gpatch";
  state.filename = fname;
  const stem = fname.replace(/\.[^.]+$/, "");
  if (!loaded.patchName) state.patchName = stem.replace(/[^A-Za-z0-9_]/g, "_");
  let maxId = 0;
  state.nodes.forEach(n => {
    const m = parseInt(String(n.id).replace(/\D/g, ""), 10);
    if (m > maxId) maxId = m;
  });
  nextId = maxId + 1;
  clearSelection();
  undoStack.length = 0;
  redoStack.length = 0;
  resetView();
  if (typeof _updateProjectionPill === "function") _updateProjectionPill();
  if (Visual && Visual.theaterCam && state.rig && Array.isArray(state.rig.sweetSpot)) {
    Visual.theaterCam.pos[0] = state.rig.sweetSpot[0];
    Visual.theaterCam.pos[1] = state.rig.sweetSpot[1];
    Visual.theaterCam.pos[2] = state.rig.sweetSpot[2];
  }
  render();
}

document.getElementById("file-input").addEventListener("change", ev => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      // Phase 8.A.3.2 -- prefab detection. If the loaded .gpatch has
      // a prefabMeta field, the user probably wants to DROP it as a
      // PrefabInstance into the current patch, not replace the whole
      // editor session with it. Ask -- "Drop" inserts an instance,
      // "Load full" runs the legacy patch-replace path.
      if (parsed && parsed.prefabMeta && typeof parsed.prefabMeta === "object") {
        const drop = confirm(
          "'" + file.name + "' is a prefab template.\n\n" +
          "OK = drop a PrefabInstance into the current patch\n" +
          "Cancel = load it as a full .gpatch (replaces current)"
        );
        if (drop) {
          _dropPrefabInstance(parsed, file.name);
          ev.target.value = "";
          return;
        }
      }
      _applyLoadedPatch(parsed, file.name);
    } catch (err) {
      alert("Could not load file: " + err.message);
    }
  };
  reader.readAsText(file);
  ev.target.value = "";
});

/* Phase 8.A.3.2 -- drop a loaded prefab template into the current
 * patch as a PrefabInstance node. Embeds the template JSON in the
 * instance's templateInline param; subsequent _tickPrefabInstances
 * passes auto-expand it on the next visual frame. */
function _dropPrefabInstance(template, sourceName) {
  if (!state || !Array.isArray(state.nodes)) return;
  const name = (typeof template.patchName === "string" && template.patchName)
    ? template.patchName : (sourceName || "Prefab").replace(/\.gpatch$/i, "");
  // Strip top-level non-graph fields from the embedded JSON so the
  // instance only carries what _expandPrefabInstance needs.
  const embed = {
    nodes: Array.isArray(template.nodes) ? template.nodes : [],
    edges: Array.isArray(template.edges) ? template.edges : [],
    prefabMeta: template.prefabMeta || {}
  };
  // Drop at a clear spot on the canvas (~viewport center).
  const _dp = _canvasDropPoint();
  const dropX = _dp.x, dropY = _dp.y;
  pushHistory("prefab-drop:" + name);
  const instId = makeNode("PrefabInstance", dropX, dropY, {
    templateName: name,
    templateInline: JSON.stringify(embed)
  });
  console.log("[prefab] dropped instance " + instId + " from '" + name + "' (" + embed.nodes.length + " template nodes)");
  if (typeof render === "function") render();
  if (typeof renderProps === "function") renderProps();
}

/* Phase 8.A.3.2 -- Save Selection as Prefab modal. */
function _openPrefabSaveModal() {
  const modal = document.getElementById("prefab-save-modal");
  if (!modal) return;
  const selected = Array.from(selectedSet).map(id => state.nodes.find(n => n && n.id === id)).filter(Boolean);
  if (selected.length === 0) {
    alert("Select one or more nodes before saving as prefab.");
    return;
  }
  // Default name = current patch name + "-prefab" if reasonable.
  document.getElementById("pfs-name").value =
    (state.patchName && state.patchName.length) ? (state.patchName + "Prefab") : "MyPrefab";
  document.getElementById("pfs-status").textContent =
    selected.length + " node(s) selected";

  // Build the parameter list. Iterate each selected node's numeric
  // params (skip strings + uiOnlyParams + already-internal `_`-fields).
  const paramsEl = document.getElementById("pfs-params");
  let paramRows = "";
  let paramRowCount = 0;
  for (const node of selected) {
    const def = TYPES[node.type];
    if (!def || !node.params) continue;
    const uiOnly = def.uiOnlyParams || [];
    for (const k of Object.keys(node.params)) {
      if (k.charCodeAt(0) === 95) continue;   // skip _-prefixed
      if (uiOnly.includes(k)) continue;
      if (typeof node.params[k] !== "number") continue;
      const labelDefault = (selected.length > 1) ? (node.type.toLowerCase() + "_" + k) : k;
      const rowId = "pfs-row-" + paramRowCount++;
      paramRows +=
        `<label style="display:flex; align-items:center; gap:8px; font-family:var(--font-mono); font-size:10.5px;">` +
          `<input type="checkbox" data-pfs-node="${escapeAttr(node.id)}" data-pfs-param="${escapeAttr(k)}" checked />` +
          `<span style="flex:0 0 220px; color:var(--text-3);">${escapeText(node.type + "#" + node.id + "." + k)}</span>` +
          `<input type="text" data-pfs-label-for="${rowId}" data-pfs-node-l="${escapeAttr(node.id)}" data-pfs-param-l="${escapeAttr(k)}" value="${escapeAttr(labelDefault)}" style="flex:1; padding:2px 4px; background:var(--bg-2); color:var(--text-1); border:1px solid var(--instr-rule); border-radius:2px; font-family:var(--font-mono); font-size:10px;" />` +
        `</label>`;
    }
  }
  paramsEl.innerHTML = paramRows || `<div style="font-family:var(--font-mono); font-size:10px; color:var(--text-3); padding:4px;">(no numeric params on selected nodes)</div>`;

  // Build the port list. Iterate each selected node's mesh-out ports.
  const portsEl = document.getElementById("pfs-ports");
  let portRows = "";
  let portRowCount = 0;
  let portFirst = null;
  for (const node of selected) {
    const def = TYPES[node.type];
    if (!def || !Array.isArray(def.outs)) continue;
    for (const p of def.outs) {
      if (p.t !== "mesh") continue;
      const rowId = "pfs-port-" + portRowCount++;
      if (!portFirst) portFirst = rowId;
      portRows +=
        `<label style="display:flex; align-items:center; gap:8px; font-family:var(--font-mono); font-size:10.5px;">` +
          `<input type="radio" name="pfs-port" id="${rowId}" data-pfs-port-node="${escapeAttr(node.id)}" data-pfs-port-name="${escapeAttr(p.n)}" ${portFirst === rowId ? "checked" : ""} />` +
          `<span style="color:var(--text-1);">${escapeText(node.type + "#" + node.id + "." + p.n)}</span>` +
          `<span style="color:var(--text-3); font-size:9.5px;">(${escapeText(p.t)})</span>` +
        `</label>`;
    }
  }
  portRows += `<label style="display:flex; align-items:center; gap:8px; font-family:var(--font-mono); font-size:10.5px; margin-top:4px; padding-top:4px; border-top:1px dashed var(--instr-rule); color:var(--text-3);">` +
    `<input type="radio" name="pfs-port" id="pfs-port-none" />` +
    `<span>(none — prefab has no exposed mesh output)</span>` +
    `</label>`;
  portsEl.innerHTML = portRows;

  modal.style.display = "flex";
}

function _closePrefabSaveModal() {
  const modal = document.getElementById("prefab-save-modal");
  if (modal) modal.style.display = "none";
}

function _commitPrefabSave() {
  const selected = Array.from(selectedSet).map(id => state.nodes.find(n => n && n.id === id)).filter(Boolean);
  if (selected.length === 0) { _closePrefabSaveModal(); return; }
  const name = (document.getElementById("pfs-name").value || "Prefab").trim().replace(/[^A-Za-z0-9_-]/g, "_") || "Prefab";

  // Build the exposedParams list from checked rows.
  const exposedParams = [];
  document.querySelectorAll("#pfs-params input[type='checkbox']").forEach(cb => {
    if (!cb.checked) return;
    const nodeId    = cb.dataset.pfsNode;
    const paramName = cb.dataset.pfsParam;
    const labelInp  = document.querySelector(`#pfs-params input[data-pfs-node-l="${nodeId}"][data-pfs-param-l="${paramName}"]`);
    const label     = (labelInp && labelInp.value && labelInp.value.trim()) || paramName;
    exposedParams.push({ label, nodeId, paramName });
  });

  // Selected exposed mesh-out port (radio button "pfs-port").
  const exposedPorts = [];
  const portRadio = document.querySelector("#pfs-ports input[name='pfs-port']:checked");
  if (portRadio && portRadio.id !== "pfs-port-none") {
    exposedPorts.push({
      label: "mesh",
      nodeId: portRadio.dataset.pfsPortNode,
      portName: portRadio.dataset.pfsPortName,
      direction: "out"
    });
  }

  // Snapshot selected nodes + their edges as the template.
  const selectedIds = new Set(selected.map(n => n.id));
  const nodes = selected.map(n => {
    // Strip _-prefixed runtime keys (already-handled by _omitRuntimeKeys
    // on the global save, but doing it inline for the prefab snapshot
    // keeps the inline JSON tidy).
    const clean = {};
    for (const k of Object.keys(n)) {
      if (k.charCodeAt(0) === 95) continue;
      clean[k] = n[k];
    }
    return JSON.parse(JSON.stringify(clean));
  });
  const edges = state.edges
    .filter(e => e && e.from && e.to && selectedIds.has(e.from.node) && selectedIds.has(e.to.node))
    .map(e => ({
      from: { node: e.from.node, port: e.from.port },
      to:   { node: e.to.node,   port: e.to.port   }
    }));

  const payload = {
    version: 2,
    patchName: name,
    nodes,
    edges,
    prefabMeta: { exposedParams, exposedPorts }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".gpatch";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log("[prefab] saved '" + name + ".gpatch' (" + nodes.length + " nodes, " + edges.length + " edges, " +
    exposedParams.length + " exposed params, " + exposedPorts.length + " exposed ports)");
  _closePrefabSaveModal();
}

/* §8.A.6 -- build the same prefab payload as _commitPrefabSave but
 * persist into the IDB Assets store instead of downloading. Re-uses
 * the modal's UI state (name + checkboxes + radio). Triggers
 * _invalidatePrefabRefs via Assets.put -> any live PrefabInstance
 * already pointing at this assetId re-expands from the new template. */
async function _commitPrefabSaveToIdb() {
  const selected = Array.from(selectedSet).map(id => state.nodes.find(n => n && n.id === id)).filter(Boolean);
  if (selected.length === 0) { _closePrefabSaveModal(); return; }
  const rawName = (document.getElementById("pfs-name").value || "Prefab").trim();
  const name = rawName || "Prefab";

  const exposedParams = [];
  document.querySelectorAll("#pfs-params input[type='checkbox']").forEach(cb => {
    if (!cb.checked) return;
    const nodeId    = cb.dataset.pfsNode;
    const paramName = cb.dataset.pfsParam;
    const labelInp  = document.querySelector(`#pfs-params input[data-pfs-node-l="${nodeId}"][data-pfs-param-l="${paramName}"]`);
    const label     = (labelInp && labelInp.value && labelInp.value.trim()) || paramName;
    exposedParams.push({ label, nodeId, paramName });
  });
  const exposedPorts = [];
  const portRadio = document.querySelector("#pfs-ports input[name='pfs-port']:checked");
  if (portRadio && portRadio.id !== "pfs-port-none") {
    exposedPorts.push({
      label: "mesh",
      nodeId: portRadio.dataset.pfsPortNode,
      portName: portRadio.dataset.pfsPortName,
      direction: "out"
    });
  }
  const selectedIds = new Set(selected.map(n => n.id));
  const nodes = selected.map(n => {
    const clean = {};
    for (const k of Object.keys(n)) {
      if (k.charCodeAt(0) === 95) continue;
      clean[k] = n[k];
    }
    return JSON.parse(JSON.stringify(clean));
  });
  const edges = state.edges
    .filter(e => e && e.from && e.to && selectedIds.has(e.from.node) && selectedIds.has(e.to.node))
    .map(e => ({
      from: { node: e.from.node, port: e.from.port },
      to:   { node: e.to.node,   port: e.to.port   }
    }));

  // Try to find an existing prefab asset with the same name --
  // updating it propagates to live instances via Assets.put hook.
  let existing = (typeof Assets !== "undefined" && Assets.findPrefabByName)
    ? Assets.findPrefabByName(name) : null;
  const id = existing ? existing.id : ("p_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1296).toString(36));
  const record = {
    id,
    assetType: "prefab",
    name,
    patchName: name,
    version: 2,
    nodes,
    edges,
    prefabMeta: { exposedParams, exposedPorts },
    createdAt: existing ? existing.createdAt : Date.now()
  };
  try {
    await Assets.put(record);
    const verb = existing ? "updated" : "saved";
    console.log("[prefab] " + verb + " '" + name + "' to IDB (id=" + id + ", " +
      nodes.length + " nodes, " + edges.length + " edges, " +
      exposedParams.length + " exposed params, " + exposedPorts.length + " exposed ports)");
    _closePrefabSaveModal();
    // Refresh assets + prefabs tabs if their render fns exist.
    if (typeof brRenderAssets === "function") {
      try { brRenderAssets(); } catch (_) {}
    }
    if (typeof brRenderPrefabs === "function") {
      try { brRenderPrefabs(); } catch (_) {}
    }
  } catch (e) {
    console.error("[prefab] IDB save failed:", e);
    alert("Failed to save prefab to IDB: " + e.message);
  }
}

/* §8.A.6 -- Drop Prefab from IDB picker. */
function _openPrefabPickModal() {
  const modal = document.getElementById("prefab-pick-modal");
  if (!modal) return;
  const list = (typeof Assets !== "undefined") ? Assets.list({ type: "prefab" }) : [];
  const statusEl = document.getElementById("pfp-status");
  if (statusEl) statusEl.textContent = list.length + " prefab asset(s) in IDB";
  const listEl = document.getElementById("pfp-list");
  if (list.length === 0) {
    listEl.innerHTML = `<div style="padding:16px; font-family:var(--font-mono); font-size:10.5px; color:var(--text-3); text-align:center;">
      No prefab assets in IDB yet.<br><br>
      Select some nodes -> click <b>Save Prefab</b> -> use the <b>Save to IDB</b> button to add one.
    </div>`;
  } else {
    listEl.innerHTML = list.map(p => {
      const meta = (p.prefabMeta || {});
      const nP = (meta.exposedParams || []).length;
      const nN = (p.nodes || []).length;
      const nE = (p.edges || []).length;
      const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "unknown";
      return `<div class="pfp-row" data-asset-id="${escapeAttr(p.id)}" style="display:flex; align-items:center; gap:10px; padding:8px 10px; background:var(--bg-1); border:1px solid var(--instr-rule); border-radius:3px; cursor:pointer;">
        <div style="flex:1; min-width:0;">
          <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-1);">${escapeText(p.name || p.id)}</div>
          <div style="font-family:var(--font-mono); font-size:9.5px; color:var(--text-3); margin-top:2px;">
            ${nN} nodes · ${nE} edges · ${nP} exposed params · updated ${escapeText(updated)}
          </div>
        </div>
        <button class="btn pfp-drop" data-asset-id="${escapeAttr(p.id)}" type="button" title="Insert PrefabInstance referencing this asset">Drop</button>
        <button class="btn danger pfp-del" data-asset-id="${escapeAttr(p.id)}" type="button" title="Delete this asset from IDB (live instances become unresolvable)">×</button>
      </div>`;
    }).join("");
    listEl.querySelectorAll(".pfp-drop").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        _dropPrefabFromAsset(btn.dataset.assetId);
        _closePrefabPickModal();
      });
    });
    listEl.querySelectorAll(".pfp-del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.assetId;
        const rec = Assets.get(id);
        if (!rec) return;
        if (!confirm("Delete prefab '" + (rec.name || id) + "' from IDB?\n\nLive PrefabInstance nodes referencing this asset will keep their last expansion but won't refresh.")) return;
        await Assets.delete(id);
        _openPrefabPickModal();   // refresh list
      });
    });
    listEl.querySelectorAll(".pfp-row").forEach(row => {
      row.addEventListener("click", () => {
        _dropPrefabFromAsset(row.dataset.assetId);
        _closePrefabPickModal();
      });
    });
  }
  modal.style.display = "flex";
}

function _closePrefabPickModal() {
  const m = document.getElementById("prefab-pick-modal");
  if (m) m.style.display = "none";
}

function _dropPrefabFromAsset(assetId) {
  const asset = (typeof Assets !== "undefined") ? Assets.get(assetId) : null;
  if (!asset || asset.assetType !== "prefab") {
    alert("Prefab asset not found: " + assetId);
    return;
  }
  const _dp = _canvasDropPoint();
  const dropX = _dp.x, dropY = _dp.y;
  pushHistory("prefab-drop-idb:" + (asset.name || assetId));
  const instId = makeNode("PrefabInstance", dropX, dropY, {
    templateName:    asset.name || "Prefab",
    templateAssetId: assetId,
    templateInline:  ""   // explicit empty -- the assetId path wins
  });
  console.log("[prefab] dropped instance " + instId + " referencing asset '" + (asset.name || assetId) + "'");
  if (typeof render === "function") render();
  if (typeof renderProps === "function") renderProps();
}

document.getElementById("btn-save-prefab").addEventListener("click", _openPrefabSaveModal);
document.getElementById("pfs-close").addEventListener("click", _closePrefabSaveModal);
document.getElementById("pfs-cancel").addEventListener("click", _closePrefabSaveModal);
document.getElementById("pfs-save").addEventListener("click", _commitPrefabSave);
document.getElementById("pfs-save-idb").addEventListener("click", _commitPrefabSaveToIdb);
document.getElementById("prefab-save-modal").addEventListener("click", (e) => {
  if (e.target.id === "prefab-save-modal") _closePrefabSaveModal();
});
document.getElementById("btn-drop-prefab").addEventListener("click", _openPrefabPickModal);
document.getElementById("pfp-close").addEventListener("click", _closePrefabPickModal);
document.getElementById("pfp-cancel").addEventListener("click", _closePrefabPickModal);
document.getElementById("prefab-pick-modal").addEventListener("click", (e) => {
  if (e.target.id === "prefab-pick-modal") _closePrefabPickModal();
});
document.addEventListener("keydown", (e) => {
  const m = document.getElementById("prefab-save-modal");
  if (m && m.style.display !== "none" && e.key === "Escape") _closePrefabSaveModal();
  const m2 = document.getElementById("prefab-pick-modal");
  if (m2 && m2.style.display !== "none" && e.key === "Escape") _closePrefabPickModal();
});


copyBtn.addEventListener("click", () => {
  const which = document.querySelector(".tab.active").dataset.tab;
  const text = which === "code" ? codeOut.innerText : jsonOut.innerText;
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = "Copied";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
  });
});

tabs.forEach(t => {
  t.addEventListener("click", () => {
    tabs.forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    paneProps.style.display = t.dataset.tab === "props" ? "block" : "none";
    paneUdsp.style.display  = t.dataset.tab === "udsp"  ? "grid"  : "none";
    const paneCpEl = document.getElementById("pane-codepreview");
    if (paneCpEl) paneCpEl.style.display = t.dataset.tab === "codepreview" ? "flex" : "none";
    const paneMonEl = document.getElementById("pane-monitor");
    if (paneMonEl) paneMonEl.style.display = t.dataset.tab === "monitor" ? "block" : "none";
    // Copy button only meaningful for the code-preview sub-tabs that
    // show plain text (Generated C++ and JSON). Build pane has its
    // own per-section copy button.
    const cpActive = t.dataset.tab === "codepreview";
    const sub = cpActive ? (document.querySelector(".subtab.active") || {}).dataset?.subtab : null;
    copyBtn.style.display = (cpActive && (sub === "code" || sub === "json")) ? "inline-block" : "none";
    if (cpActive && sub === "build" && typeof renderBuildPane === "function") renderBuildPane();
    // Lazy-fetch the community library on first User DSP tab activation.
    if (t.dataset.tab === "udsp" && !communityCache && !communityLoading) {
      loadCommunityList(false);
    }
    // CodeMirror needs a refresh when its container becomes visible —
    // otherwise gutters/cursor render misaligned until the user clicks.
    if (t.dataset.tab === "udsp" && udspEditor) {
      setTimeout(() => udspEditor.refresh(), 0);
    }
  });
});

/* Sub-tab switching inside the Code preview pane. The three inner panes
 * keep their original IDs (pane-code / pane-json / pane-build), so the
 * existing render functions just keep working. */
function switchCodePreviewSub(sub) {
  document.querySelectorAll("#codepreview-subtabs .subtab").forEach(b => {
    b.classList.toggle("active", b.dataset.subtab === sub);
  });
  const codeEl  = document.getElementById("pane-code");
  const jsonEl  = document.getElementById("pane-json");
  const buildEl = document.getElementById("pane-build");
  if (codeEl)  codeEl.style.display  = sub === "code"  ? "block" : "none";
  if (jsonEl)  jsonEl.style.display  = sub === "json"  ? "block" : "none";
  if (buildEl) buildEl.style.display = sub === "build" ? "block" : "none";
  copyBtn.style.display = (sub === "code" || sub === "json") ? "inline-block" : "none";
  if (sub === "build" && typeof renderBuildPane === "function") renderBuildPane();
}
document.querySelectorAll("#codepreview-subtabs .subtab").forEach(b => {
  b.addEventListener("click", () => switchCodePreviewSub(b.dataset.subtab));
});

/* =========================================================================
 * User DSP UI — left list of registered .gdsp types, right code editor
 * ======================================================================== */
const GDSP_TEMPLATE = `// @gdsp-name        BitCrush
// @gdsp-category    UserDSP
// @gdsp-description Sample-rate and bit-depth reducer
// @gdsp-color       #c8e85a
// @gdsp-input       in    audio
// @gdsp-input       bits  param  8
// @gdsp-input       rate  param  0.5
// @gdsp-output      out   audio
// @gdsp-method      bits  setBits

#include <cmath>

class BitCrush {
    float held = 0.f;
    float phase = 0.f;
    float rate_ = 0.5f;
    int   bits_ = 8;
public:
    void rate(float v)    { rate_ = v; }
    void setBits(float v) { bits_ = (int)v; }

    float operator()(float in) {
        phase += rate_;
        if (phase >= 1.f) {
            phase -= 1.f;
            float step = float(1 << bits_);
            held = std::floor(in * step) / step;
        }
        return held;
    }
};
`;

let editingUdsp = null;  // null = new file; otherwise the type name being edited

/* ---------- Community library cache ----------
 * Fetched on first User DSP tab activation, then cached in localStorage
 * for one hour so we don't burn rate-limit budget on every page load.
 * The list shows above the user's local saves; clicking an entry pulls
 * the source into the editor as a fresh draft (Save & Add to keep). */
const COMMUNITY_CACHE_KEY = "gamma-editor-community-cache-v1";
const COMMUNITY_TTL_MS = 60 * 60 * 1000;
let communityCache = null;     // { fetchedAt, items: [{name, sha, html_url, source?, directives?}] }
let communityLoading = false;
let communityError = null;

async function loadCommunityList(force) {
  if (communityLoading) return;
  if (!force) {
    try {
      const raw = localStorage.getItem(COMMUNITY_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Date.now() - parsed.fetchedAt < COMMUNITY_TTL_MS) {
          communityCache = parsed;
          renderUdspList();
          return;
        }
      }
    } catch (_) {}
  }
  communityLoading = true;
  communityError = null;
  renderUdspList();
  try {
    const url = `https://api.github.com/repos/${COMMUNITY_REPO}/contents/gdsp`;
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const items = data
      .filter(f => f.type === "file" && f.name.endsWith(".gdsp"))
      .map(f => ({
        name: f.name.replace(/\.gdsp$/, ""),
        sha: f.sha,
        html_url: f.html_url,
        download_url: f.download_url
      }));
    communityCache = { fetchedAt: Date.now(), items };
    try { localStorage.setItem(COMMUNITY_CACHE_KEY, JSON.stringify(communityCache)); } catch (_) {}
  } catch (e) {
    communityError = e.message;
  } finally {
    communityLoading = false;
    renderUdspList();
  }
}

async function loadCommunityItem(item) {
  setUdspStatus(`Loading ${item.name}.gdsp…`, "");
  try {
    const res = await fetch(item.download_url);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const text = await res.text();
    editingUdsp = null;     // treat as a fresh draft, not editing the community file
    setUdspText(text);
    setUdspStatus(`Loaded ${item.name} from community — Save & Add to keep, or edit and Submit a PR.`, "ok");
    renderUdspList();
  } catch (e) {
    setUdspStatus("Could not load community item: " + e.message, "err");
  }
}

function renderUdspList() {
  let html = "";

  // ---- Community section ----
  html += `<div class="udsp-section-head">Community
    <span class="reload" id="udsp-comm-reload" title="Refresh from github.com">↻</span>
  </div>`;
  if (communityLoading) {
    html += `<div class="udsp-comm-status">Fetching community library…</div>`;
  } else if (communityError) {
    html += `<div class="udsp-comm-status err">Couldn't reach github.com — ${escapeText(communityError)}</div>`;
  } else if (!communityCache || !communityCache.items.length) {
    html += `<div class="udsp-comm-status">No community library yet.</div>`;
  } else {
    html += `<div class="udsp-comm-list">`;
    communityCache.items.forEach(it => {
      html += `<div class="udsp-list-item" data-comm="${escapeAttr(it.name)}">
        <span class="dot" style="background:#7f77dd"></span>
        <span class="name">${escapeText(it.name)}</span>
      </div>`;
    });
    html += `</div>`;
  }

  // ---- Local section ----
  html += `<div class="udsp-section-head">Your library</div>`;
  const names = Object.keys(USER_DSP_SOURCES).sort();
  html += `<div class="udsp-new" id="udsp-new">New .gdsp</div>`;
  if (!names.length) {
    html += `<div class="udsp-list-empty">No user DSP yet — click "New .gdsp" to start</div>`;
  } else {
    names.forEach(name => {
      const meta = USER_DSP_META[name] || {};
      const active = name === editingUdsp ? " active" : "";
      html += `<div class="udsp-list-item${active}" data-name="${name}">
        <span class="dot" style="background:${meta.color || "#c8e85a"}"></span>
        <span class="name">${name}</span>
        <span class="x" data-del="${name}" title="Delete">×</span>
      </div>`;
    });
  }

  udspList.innerHTML = html;

  const reloadEl = document.getElementById("udsp-comm-reload");
  if (reloadEl) reloadEl.addEventListener("click", e => {
    e.stopPropagation();
    loadCommunityList(true);
  });
  udspList.querySelectorAll("[data-comm]").forEach(item => {
    item.addEventListener("click", () => {
      const name = item.dataset.comm;
      const cached = communityCache && communityCache.items.find(x => x.name === name);
      if (cached) loadCommunityItem(cached);
    });
  });

  document.getElementById("udsp-new").addEventListener("click", () => {
    editingUdsp = null;
    setUdspText(GDSP_TEMPLATE);
    udspStatus.textContent = "New .gdsp — edit and click Save & Add";
    udspStatus.className = "udsp-status";
    renderUdspList();
  });
  udspList.querySelectorAll(".udsp-list-item[data-name]").forEach(item => {
    item.addEventListener("click", e => {
      if (e.target.dataset.del) return;
      const name = item.dataset.name;
      editingUdsp = name;
      setUdspText(USER_DSP_SOURCES[name] || "");
      udspStatus.textContent = `Editing ${name}`;
      udspStatus.className = "udsp-status";
      renderUdspList();
    });
  });
  udspList.querySelectorAll(".x").forEach(x => {
    x.addEventListener("click", e => {
      e.stopPropagation();
      const name = x.dataset.del;
      if (!confirm(`Delete user DSP "${name}"? Any nodes using it will be removed from the patch.`)) return;
      unregisterUserDsp(name);
      if (editingUdsp === name) {
        editingUdsp = null;
        setUdspText(GDSP_TEMPLATE);
      }
      renderUdspList();
      renderPalette(search.value);
      render();
      saveUserDspToStorage();
    });
  });
}

function setUdspStatus(msg, kind) {
  udspStatus.textContent = msg;
  udspStatus.className = "udsp-status" + (kind ? " " + kind : "");
}

document.getElementById("btn-udsp-validate").addEventListener("click", () => {
  try {
    const { name, def } = buildUserDspDef(getUdspText());
    setUdspStatus(`OK — ${name}: ${def.ins.length} in, ${def.outs.length} out, ${Object.keys(def.params).length} params`, "ok");
  } catch (err) {
    setUdspStatus("Error — " + err.message, "err");
  }
});

document.getElementById("btn-udsp-save").addEventListener("click", () => {
  try {
    // If renaming, drop the old entry first
    const probe = parseGdsp(getUdspText()).directives;
    const newName = probe.name;
    if (editingUdsp && editingUdsp !== newName) {
      unregisterUserDsp(editingUdsp);
    }
    const name = registerUserDsp(getUdspText());
    editingUdsp = name;
    setUdspStatus(`Saved ${name} — added to palette`, "ok");
    renderUdspList();
    renderPalette(search.value);
    render();
    saveUserDspToStorage();
  } catch (err) {
    setUdspStatus("Error — " + err.message, "err");
  }
});

/* ---------- Submit to community library ----------
 * Opens a GitHub PR-creation page pre-filled with the current .gdsp
 * source. The user authenticates on github.com, sees the diff, and
 * clicks "Create pull request". The community repo's CI then validates.
 *
 * GitHub limits the URL ?value= length around ~10–14 KB depending on
 * browser. For oversized files we fall back to copying source to the
 * clipboard and just opening the empty new-file page. */
const COMMUNITY_REPO = "9LiveZZZ-Git/gamma-community-gdsp";
const COMMUNITY_BRANCH = "main";

document.getElementById("btn-udsp-submit").addEventListener("click", async () => {
  const src = getUdspText();
  let directives;
  try {
    directives = parseGdsp(src).directives;
  } catch (e) {
    setUdspStatus("Submit needs a parseable .gdsp — fix errors first.", "err");
    return;
  }
  if (!directives.name) {
    setUdspStatus("Submit needs @gdsp-name.", "err");
    return;
  }
  const filename = `gdsp/${directives.name}.gdsp`;
  const baseUrl = `https://github.com/${COMMUNITY_REPO}/new/${COMMUNITY_BRANCH}`;
  const params = new URLSearchParams({
    filename,
    value: src,
    message: `Add ${directives.name}`,
    description: directives.description || ""
  });
  const fullUrl = baseUrl + "?" + params.toString();

  // Some browsers cap URL length around 8K. If we'd exceed that, copy
  // the source to clipboard and open the empty new-file page so the
  // user can paste it themselves.
  if (fullUrl.length > 7800) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(src); } catch (_) {}
      setUdspStatus("File too large to prefill — source copied to clipboard. Paste in the new file.", "ok");
    } else {
      setUdspStatus("File too large to prefill the URL — copy the source manually after the page opens.", "err");
    }
    window.open(`${baseUrl}?filename=${encodeURIComponent(filename)}`, "_blank", "noopener");
    return;
  }
  window.open(fullUrl, "_blank", "noopener");
  setUdspStatus(`Opened submit page for ${directives.name}.gdsp on github.com`, "ok");
});

document.getElementById("btn-udsp-export").addEventListener("click", () => {
  if (!editingUdsp) {
    setUdspStatus("Save first, then export", "err");
    return;
  }
  exportGdsp(editingUdsp);
  setUdspStatus(`Exported ${editingUdsp}.gdsp`, "ok");
});

// localStorage persistence — survives page reload
const LS_KEY = "gamma-editor-userdsp-v1";

function saveUserDspToStorage() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(USER_DSP_SOURCES));
  } catch (e) { /* ignore quota / private mode */ }
}

function loadUserDspFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const map = JSON.parse(raw);
    Object.values(map).forEach(src => {
      try { registerUserDsp(src); } catch (e) { console.warn("Bad stored gdsp:", e.message); }
    });
  } catch (e) { /* ignore */ }
}

loadUserDspFromStorage();
setUdspText(GDSP_TEMPLATE);
renderUdspList();
renderPalette();

/* =========================================================================
 * AI assistant for .gdsp authoring
 *
 * Architecture:
 *   - User stores their own API key in localStorage. The editor calls the
 *     provider's API directly from the browser. No server in the middle.
 *     This keeps the standalone HTML genuinely standalone.
 *   - Provider is pluggable via the PROVIDERS map. Adding a new provider is
 *     one entry: { fetch, parseResponse, defaultModel, headers }.
 *   - When this gets integrated into AlloLib Studio Online, swap in a
 *     server-proxy provider that the IDE controls — same call signature,
 *     no other code changes.
 *
 * The system prompt teaches the model the .gdsp format because that's not
 * in any training data. The format spec is built fresh from the actual
 * directives the editor parses, so it can't drift.
 * ======================================================================== */

const AI_LS_KEY = "gamma-editor-ai-settings-v1";
let aiSettings = loadAiSettings();
let aiPending = null;   // last suggestion awaiting Apply/Discard

function loadAiSettings() {
  try {
    const raw = localStorage.getItem(AI_LS_KEY);
    if (raw) return Object.assign(defaultAiSettings(), JSON.parse(raw));
  } catch (e) {}
  return defaultAiSettings();
}
function defaultAiSettings() {
  // compileServerUrl: empty → use the default 127.0.0.1/localhost probe.
  // Set to a full URL (e.g. "http://192.168.1.42:8765") to point at a
  // daemon on another machine — useful for patching on an iPad against
  // a Mac on the same LAN. The settings-modal field both reads and
  // writes this value; probeLocalServer honors it when present.
  return {
    provider: "gemma",
    model: "onnx-community/gemma-4-E2B-it-ONNX",
    anthropicKey: "",
    compileServerUrl: "",
    // Sprite Studio settings (SpriteCreator-1 / sd-1 / sd-2).
    // Default = compile-server-sd because it's the bundled path; users
    // who installed via scripts/install-sd.sh get one-click generation.
    // A1111 / LLM remain as fallbacks if the compile-server doesn't have
    // the SD worker installed yet.
    spriteBackend: "compile-server-sd",           // 'compile-server-sd' | 'local-sd-a1111' | 'llm-canvas'
    sdModel:       "z-image-turbo",               // compile-server model name (z-image-turbo | sdxl | flux2-klein)
    sdEndpoint:    "http://localhost:7860",       // A1111 webui base URL (a1111 backend only)
    sdSteps:       20,                             // sampling steps (quality vs speed)
    sdSampler:     "DPM++ 2M Karras"              // A1111 sampler name
  };
}
function saveAiSettings() {
  try { localStorage.setItem(AI_LS_KEY, JSON.stringify(aiSettings)); } catch (e) {}
}

/* ---------------- Prompt construction ---------------- */

function gdspFormatSpec() {
  return `The .gdsp format is a single C++ class preceded by metadata in // @gdsp-* comments.

Required directives:
  // @gdsp-name        ClassName              (must match the class declaration below)
  // @gdsp-category    PaletteCategoryName
  // @gdsp-input       portName  TYPE  [default]
  // @gdsp-output      portName  TYPE

Optional:
  // @gdsp-description One-line description
  // @gdsp-color       #rrggbb
  // @gdsp-method      paramName methodName    (override default param→setter)
  // @gdsp-gate        gateName  methodName    (override "reset" for non-trigger gates)
  // @gdsp-header      <some/header.h>         (extra include)

TYPE is one of: audio, param, gate.

The class itself must:
  - Be named exactly the @gdsp-name value.
  - Define float operator()(float in) for one-audio-input nodes,
    or float operator()() for sources (no audio input).
  - Define void <paramName>(float v) for each "param" input
    (or void <method>(float v) when @gdsp-method redirects).
  - Define void <gateName>() for each "gate" input
    (or void <method>() when @gdsp-gate redirects).

A complete example:

// @gdsp-name        BitCrush
// @gdsp-category    UserDSP
// @gdsp-description Sample-rate and bit-depth reducer
// @gdsp-color       #c8e85a
// @gdsp-input       in    audio
// @gdsp-input       bits  param  8
// @gdsp-input       rate  param  0.5
// @gdsp-output      out   audio
// @gdsp-method      bits  setBits

#include <cmath>

class BitCrush {
    float held = 0.f;
    float phase = 0.f;
    float rate_ = 0.5f;
    int   bits_ = 8;
public:
    void rate(float v)    { rate_ = v; }
    void setBits(float v) { bits_ = (int)v; }

    float operator()(float in) {
        phase += rate_;
        if (phase >= 1.f) {
            phase -= 1.f;
            float step = float(1 << bits_);
            held = std::floor(in * step) / step;
        }
        return held;
    }
};

The output of your generation is the entire file — directives + class — and nothing else. No prose, no markdown fences.

ALTERNATE KIND: shader-frag (Phase 6 visual layer)

Set "// @gdsp-kind shader-frag" on the first metadata line to author a
WGSL fragment shader instead of a C++ DSP class. The body is WGSL, not
C++; the rest of the metadata + class checks above are bypassed.

Required directives for shader-frag:
  // @gdsp-kind        shader-frag
  // @gdsp-name        ShaderName
  // @gdsp-output      out  texture          (must be texture, exactly one)

Optional:
  // @gdsp-category    Visual                (default: Visual)
  // @gdsp-input       paramName  param  default   (zero or more)
  // @gdsp-description One-line description
  // @gdsp-color       #rrggbb

WGSL conventions:
  - Define BOTH @vertex fn vs_main(...) -> VsOut and
    @fragment fn fs_main(in: VsOut) -> @location(0) vec4f.
  - Use a fullscreen triangle in vs_main (see SolidColor / Gradient for
    the canonical pattern — three positions, derive uv from clip pos
    with v flipped).
  - Bind your uniform struct at @group(0) @binding(0). The struct must
    start with the standard 64-byte preamble:
        u_resolution: vec4f,   // (w, h, 1/w, 1/h) of THIS display
        u_time:       f32,     // seconds since the GPU device acquired
        u_dt:         f32,     // seconds since the previous frame
        _pad0:        vec2f,   // 8 B (always zero)
        u_view:       vec4f,   // (yaw, pitch, roll, fov_h_deg) of this display
        u_world_uv:   vec4f,   // (minU, minV, maxU, maxV) on rig's master canvas
    Then your @gdsp-input params follow as f32 fields IN DECLARATION
    ORDER (each param = 4 B). For non-trivial layouts (vec3, vec4)
    interleave manual padding so 16-byte-aligned types start on
    16-byte offsets — same rules as WGSL struct alignment in general.

  - Display awareness — when one shader is wired into multiple
    VisualOutput nodes (e.g. for a multi-projector dome), each
    display's render pass receives a different u_world_uv slice. Map
    your local uv [0,1] into the rig's shared master canvas with:
        let world_uv = mix(u.u_world_uv.xy, u.u_world_uv.zw, in.uv);
    For single-display rigs world_uv == in.uv (the slice is the full
    [0,0]→[1,1]), so shaders that don't bother with world_uv still
    work — they just tile their output independently per display
    rather than spanning across them.

A complete shader-frag example (display-aware Pinwheel — center
sits at the rig's master center, so a 2-display side-by-side rig
shows the pinwheel split across them with the center on the seam):

// @gdsp-kind        shader-frag
// @gdsp-name        Pinwheel
// @gdsp-category    Visual
// @gdsp-description Rotating radial sweep, spans the rig's master canvas
// @gdsp-input       speed  param  1.0
// @gdsp-input       arms   param  6.0
// @gdsp-output      out    texture

struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  speed:        f32,
  arms:         f32,
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let world_uv = mix(u.u_world_uv.xy, u.u_world_uv.zw, in.uv);
  let p = world_uv - vec2f(0.5);
  let a = atan2(p.y, p.x) + u.u_time * u.speed;
  let s = 0.5 + 0.5 * sin(a * u.arms);
  return vec4f(s, s, s, 1.0);
}

Audio + clock uniform (always bound at @group(0) @binding(3)):
A second uniform carries global audio + tempo signals. Declare it
optionally — shaders that don't need it can skip the struct entirely.

    struct AudioU {
      values: array<vec4<f32>, 4>,   // 16 scalar slots
      fft:    array<vec4<f32>, 64>,  // 256 log-spaced FFT bins
    };
    @group(0) @binding(3) var<uniform> u_audio: AudioU;

Slot assignments (read AS-IS, no further mapping needed):
    values[0].x   = master output peak this quantum    (0..1)
    values[2].w   = MasterClock bpm                    (raw, e.g. 120.0)
    values[3].x   = MasterClock bar       envelope     (1 at downbeat -> ~0)
    values[3].y   = MasterClock beat      envelope     (pulses each beat)
    values[3].z   = MasterClock sixteenth envelope     (pulses every 1/16)
    values[3].w   = MasterClock phase                  (continuous 0..1 ramp / beat)
    fft[k/4u][k%4u] for k in 0..255                    = log-spaced 20Hz..Nyquist (0..1)

The clock slots are populated by the first MasterClock node in the
patch (no MasterClock -> zero). This means you can write audio-reactive
or tempo-synced shaders WITHOUT exposing a clockReact param + asking
the user to wire it — just read u_audio.values[3].y directly. A common
pattern: amplify the cubic-decay envelope into a flash that pulses on
each beat:
    let beat_pulse = u_audio.values[3].y;       // 1.0 at the beat, ~0 between
    let beat_flash = beat_pulse * beat_pulse;   // sharpen the decay
    color = color + vec3f(beat_flash * 0.3);    // additive flash

To read an FFT bin as a plain scalar:
    fn fft_bin(k: u32) -> f32 {
      let v = u_audio.fft[k / 4u];
      let lane = k & 3u;
      if (lane == 0u) { return v.x; }
      if (lane == 1u) { return v.y; }
      if (lane == 2u) { return v.z; }
      return v.w;
    }

Hot reload is automatic: any edit to the WGSL body re-hashes into a
fresh pipeline-cache entry, async-compiles, and swaps onto live
shader-frag nodes on the next frame — the old pipeline keeps rendering
during compile so there's no flicker.`;
}

function buildPrompt(mode, userText, currentSource) {
  const spec = gdspFormatSpec();
  let task;
  switch (mode) {
    case "generate":
      task = `Generate a complete .gdsp file for: ${userText}\n\nReturn ONLY the .gdsp source, starting with the // @gdsp- directives.`;
      break;
    case "modify":
      task = `Here is the current .gdsp source:\n\n${currentSource}\n\nModify it as follows: ${userText}\n\nReturn ONLY the new .gdsp source, starting with the // @gdsp- directives. Preserve everything that doesn't need to change.`;
      break;
    case "fix":
      task = `Here is .gdsp source that fails validation:\n\n${currentSource}\n\nThe error message is: ${userText}\n\nFix the source. Return ONLY the corrected .gdsp source, starting with the // @gdsp- directives.`;
      break;
    case "explain":
      task = `Here is .gdsp source:\n\n${currentSource}\n\nExplain what it does in plain prose. Cover: the DSP algorithm, what each parameter controls, and any caveats. Do NOT return code; this is a read-only explanation.`;
      break;
  }
  return { system: `You are a DSP programmer helping author nodes for the Gamma node editor. ${spec}`, user: task };
}

/* ---------------- Provider adapters ----------------
 *
 * Each provider exposes async call({ system, user, model, key, onToken }).
 * If onToken is provided, the response is streamed and onToken is called
 * with each incremental text chunk. The final return value is always the
 * complete accumulated text. If onToken is omitted, the provider may use
 * a simpler non-streaming code path.
 * --------------------------------------------------------------------- */

async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by \n\n. Each event has one or more lines
    // prefixed with "data: " (we ignore "event:" and "id:" for simplicity).
    let nl;
    while ((nl = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      block.split("\n").forEach(line => {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;
          try { onEvent(JSON.parse(data)); }
          catch (e) { /* skip malformed event */ }
        }
      });
    }
  }
}

const PROVIDERS = {
  anthropic: {
    defaultModel: "claude-sonnet-4-5",
    requiresKey: true,
    supportsImage: true,
    supportsAudio: false,   // Whisper isn't routed through this path
    goodClassifier: true,   // HW.3 -- strong enough for constrained node-name classification
    async call({ system, user, model, key, onToken, image, audio, temperature, maxTokens }) {
      if (audio) throw new Error("Anthropic provider does not handle audio input. Use Gemma for voice.");

      // image can be a single base64 string OR an array of base64
      // strings for multi-image input (e.g., reference + current view).
      const imageList = Array.isArray(image) ? image.filter(s => s) : (image ? [image] : []);
      const userContent = (imageList.length > 0)
        ? imageList.map(b => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b } }))
            .concat([{ type: "text", text: user }])
        : user;

      const body = {
        model: model || "claude-sonnet-4-5",
        max_tokens: (typeof maxTokens === "number" && maxTokens > 0) ? maxTokens : 2048,
        system,
        messages: [{ role: "user", content: userContent }],
        stream: !!onToken
      };
      if (typeof temperature === "number") body.temperature = temperature;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = (data.error && data.error.message) || res.statusText;
        throw new Error(`API ${res.status}: ${msg}`);
      }
      if (!onToken) {
        const data = await res.json();
        return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      }
      let acc = "";
      await readSSE(res, ev => {
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          acc += ev.delta.text;
          onToken(ev.delta.text);
        }
      });
      return acc;
    }
  },

  /* Gemma 4 via @huggingface/transformers + WebGPU.
   *
   * One model, three jobs:
   *   - Text generation (.gdsp authoring, voice → prompt)
   *   - Vision (handwriting recognition for pen-tablet draw-to-create)
   *   - Audio (speech-to-text for voice input)
   *
   * E4B is the default. E2B is a settings option for lower-VRAM machines.
   * Both use q4f16 quantization and load via the any-to-any pipeline.
   *
   * The transformers.js library is the same one we already load for
   * Whisper-tiny (legacy voice fallback). Gemma 4 supersedes both
   * WebLLM (text) and Whisper-tiny (audio) for users who pick it.
   */
  gemma: {
    defaultModel: "onnx-community/gemma-4-E2B-it-ONNX",
    requiresKey: false,
    supportsImage: true,
    supportsAudio: true,
    async call({ system, user, model, onToken, image, audio, temperature, maxTokens }) {
      const pipe = await ensureGemmaPipeline(model);

      // Build the messages array. Multimodal content (image / audio) goes
      // BEFORE the text per Google's recommendation for best results.
      const userContent = [];
      if (image) {
        userContent.push({ type: "image", image: "data:image/png;base64," + image });
      }
      if (audio) {
        userContent.push({ type: "audio", audio });
      }
      userContent.push({ type: "text", text: user });

      const messages = [
        { role: "system", content: system },
        { role: "user",   content: userContent }
      ];

      const tx = await getTransformersJs();
      const inputs = await pipe.processor.apply_chat_template(messages, {
        add_generation_prompt: true,
        tokenize: true,
        return_dict: true
      });

      // Deterministic decode (HWR / classification) when caller passes
      // temperature: 0; sample for free-form text generation otherwise.
      // maxTokens lets callers override the per-task budget — HWR needs
      // ~48 (room for "The word is X." style preamble before our parser
      // strips it), generation needs ~2048.
      const det = (typeof temperature === "number" && temperature <= 0);
      const detTokens = (typeof maxTokens === "number" && maxTokens > 0) ? maxTokens : 16;
      const genTokens = (typeof maxTokens === "number" && maxTokens > 0) ? maxTokens : 2048;
      const generateOpts = {
        ...inputs,
        max_new_tokens: det ? detTokens : genTokens,
        do_sample: !det,
        temperature: det ? 1.0 : (typeof temperature === "number" ? temperature : 0.4)
      };
      if (onToken) {
        generateOpts.streamer = new tx.TextStreamer(pipe.tokenizer, {
          skip_prompt: true,
          callback_function: (text) => onToken(text)
        });
      }

      const output = await pipe.model.generate(generateOpts);

      // Slice off the prompt tokens — output includes them verbatim.
      const promptLen = inputs.input_ids.dims[inputs.input_ids.dims.length - 1];
      const newTokens = output.slice(null, [promptLen, null]);
      const decoded = pipe.processor.batch_decode(newTokens, { skip_special_tokens: true });
      return Array.isArray(decoded) ? decoded[0] : String(decoded);
    }
  }
};

function extractGemmaText(out) {
  // pipeline returns either a string, an array of generation objects,
  // or a chat-style structure depending on the task.
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    const last = out[out.length - 1];
    if (typeof last === "string") return last;
    if (last && typeof last.generated_text === "string") return last.generated_text;
    if (last && Array.isArray(last.generated_text)) {
      const tail = last.generated_text[last.generated_text.length - 1];
      if (tail && typeof tail.content === "string") return tail.content;
      return JSON.stringify(tail);
    }
  }
  return JSON.stringify(out);
}

/* Gemma 4 pipeline — singleton, loaded on demand via dynamic import.
 * Users who don't select Gemma never trigger the import, so cloud-only
 * users pay zero bytes for the local-model path. */
let gemmaPipeline = null;
let gemmaCurrentModel = null;
let gemmaLoadPromise = null;
let transformersJsCache = null;
let gemmaProgressHook = null;

function setGemmaProgressHook(fn) { gemmaProgressHook = fn; }

function setupGemmaAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

async function getTransformersJs() {
  if (transformersJsCache) return transformersJsCache;
  // Use jsdelivr's +esm endpoint (NOT esm.run; the latter rebundles
  // and breaks the package's relative-URL lookup of its sibling WASM
  // blobs, which surfaces as "Failed to fetch dynamically imported
  // module"). Same root cause as the Wasmer SDK loader fix above.
  // @latest gets us whatever transformers.js has shipped recently —
  // gemma4 model support landed in 3.5+ (the @3 pin we used before
  // resolved to an older 3.x without it). Bumping to @latest until we
  // hit a regression worth pinning around.
  transformersJsCache = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@latest/+esm");
  return transformersJsCache;
}

async function ensureGemmaPipeline(model) {
  if (!setupGemmaAvailable()) {
    throw new Error("WebGPU not available — Gemma 4 needs Chrome/Edge or recent Safari with WebGPU.");
  }
  if (gemmaPipeline && gemmaCurrentModel === model) return gemmaPipeline;
  if (gemmaLoadPromise && gemmaCurrentModel === model) return gemmaLoadPromise;

  gemmaCurrentModel = model;
  gemmaLoadPromise = (async () => {
    const tx = await getTransformersJs();
    // Use the lower-level AutoProcessor + AutoModelForImageTextToText
    // pair instead of pipeline(). The pipeline() shorthand in
    // transformers.js v3 doesn't expose multimodal tasks
    // (image-text-to-text / any-to-any are rejected), but the
    // AutoModelForImageTextToText class loads gemma-4 multimodal
    // correctly and accepts {role: "user", content: [{type:"image",
    // image: dataUrl}, {type:"text", text:"..."}]} message blocks.
    // Same model weights as text-generation pipeline; this just
    // exposes the vision input path that HWR needs.
    const cb = (p) => { if (gemmaProgressHook) gemmaProgressHook(p); };
    const opts = { device: "webgpu", dtype: "q4f16", progress_callback: cb };
    const processor = await tx.AutoProcessor.from_pretrained(model, { progress_callback: cb });
    const m = await tx.AutoModelForImageTextToText.from_pretrained(model, opts);
    // Wrap into a "pipeline-like" object so the rest of the editor
    // doesn't have to care which loader was used. .processor + .model
    // are exposed for the lower-level call paths (HWR via images);
    // .tokenizer matches what TextStreamer expects for streaming.
    gemmaPipeline = {
      processor, model: m,
      tokenizer: processor.tokenizer || processor
    };
    return gemmaPipeline;
  })();

  try {
    return await gemmaLoadPromise;
  } catch (err) {
    gemmaLoadPromise = null;
    gemmaCurrentModel = null;
    throw err;
  }
}

/* Audio decoding helper — converts a MediaRecorder webm blob into the
 * Float32Array @ 16kHz mono that Gemma's audio encoder expects. Reused
 * by the legacy Whisper path too since it has the same input shape. */
async function blobToAudioFloat32(blob, targetSampleRate) {
  const targetRate = targetSampleRate || 16000;
  const arrayBuffer = await blob.arrayBuffer();
  // Some browsers don't accept sampleRate in AudioContext constructor for
  // arbitrary values; create at default and resample manually if needed.
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
    1, 1, targetRate
  );
  const decoded = await new AudioContext().decodeAudioData(arrayBuffer);
  // Resample by mixing into a single-channel offline context at target rate.
  const offline = new OfflineAudioContext(
    1, Math.ceil(decoded.duration * targetRate), targetRate
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/* ---------------- Response cleanup ---------------- */

// Strip markdown code fences if the model wrapped its output in ```cpp ... ```
function cleanGdspResponse(text) {
  text = text.trim();
  const fence = text.match(/^```(?:cpp|c\+\+)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) return fence[1].trim();
  return text;
}

/* ---------------- AI panel UI ---------------- */

const aiPanel    = document.getElementById("ai-panel");
const aiPromptEl = document.getElementById("ai-prompt");
const aiModeEl   = document.getElementById("ai-mode");
const aiStatus   = document.getElementById("ai-status");
const aiResult   = document.getElementById("ai-result");
const aiResultBody = document.getElementById("ai-result-body");
const aiResultLabel = document.getElementById("ai-result-label");

function setAiStatus(msg, kind) {
  aiStatus.textContent = msg;
  aiStatus.className = "ai-status" + (kind ? " " + kind : "");
}

function openAiPanel() {
  aiPanel.style.display = "flex";
  aiPromptEl.focus();
  // Autofill prompt for "fix" mode if there's a current error
  const status = udspStatus.textContent || "";
  if (status.startsWith("Error —")) {
    aiModeEl.value = "fix";
    aiPromptEl.value = status.replace(/^Error\s*—\s*/, "");
  }
}
function closeAiPanel() {
  aiPanel.style.display = "none";
  aiResult.style.display = "none";
  aiPending = null;
}

document.getElementById("btn-udsp-ai").addEventListener("click", openAiPanel);

/* ---------- Model badge + provider switcher ----------
 * The badge in the User DSP toolbar shows which provider/model is
 * currently active. Click it to switch between configured providers
 * without opening the full settings modal. */
const MODEL_OPTIONS = [
  {
    provider: "gemma",
    model: "onnx-community/gemma-4-E2B-it-ONNX",
    name: "Gemma 4 E2B",
    meta: "~500 MB · WebGPU · text + image",
    tag: "local"
  },
  {
    provider: "gemma",
    model: "onnx-community/gemma-4-E4B-it-ONNX",
    name: "Gemma 4 E4B",
    meta: "~1.5 GB · WebGPU · higher quality",
    tag: "local"
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    meta: "Anthropic API · text + image · per-call cost",
    tag: "cloud"
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    meta: "Anthropic API · top quality · higher cost",
    tag: "cloud"
  }
];

function shortModelName(provider, model) {
  if (provider === "gemma") {
    if (/E2B/i.test(model)) return "Gemma 4 E2B";
    if (/E4B/i.test(model)) return "Gemma 4 E4B";
    return model.split("/").pop();
  }
  if (provider === "anthropic") {
    if (/opus/i.test(model)) return "Claude Opus";
    if (/sonnet/i.test(model)) return "Claude Sonnet";
    if (/haiku/i.test(model)) return "Claude Haiku";
    return model;
  }
  return model;
}

function refreshModelBadge() {
  const tag = document.getElementById("model-badge-tag");
  const name = document.getElementById("model-badge-name");
  const btn = document.getElementById("btn-model-badge");
  if (!tag || !name || !btn) return;
  const p = aiSettings.provider;
  const isLocal = p === "gemma";
  const hasKey = p === "gemma" || (p === "anthropic" && !!aiSettings.anthropicKey);
  tag.textContent = isLocal ? "local" : "cloud";
  tag.className = "model-badge-tag " + (isLocal ? "local" : (hasKey ? "cloud" : "unset"));
  name.textContent = shortModelName(p, aiSettings.model);
  btn.title = "Active model: " + shortModelName(p, aiSettings.model) +
    " (" + (isLocal ? "local Gemma" : "Anthropic API") + ")" +
    (!hasKey ? " — needs API key" : "") +
    " — click to switch";
}

function renderModelPopover() {
  const pop = document.getElementById("model-popover");
  if (!pop) return;
  const hasAnthKey = !!aiSettings.anthropicKey;
  let html = `<div class="model-popover-head">Active AI model</div>`;
  MODEL_OPTIONS.forEach((opt, i) => {
    const isActive = aiSettings.provider === opt.provider && aiSettings.model === opt.model;
    const needsKey = opt.tag === "cloud" && !hasAnthKey;
    const cls = "model-popover-item " + opt.tag + (isActive ? " active" : "") + (needsKey ? " disabled" : "");
    html += `<div class="${cls}" data-idx="${i}" role="menuitem"${needsKey ? ' aria-disabled="true"' : ""}>
      <span class="check" aria-hidden="true"></span>
      <span class="info">
        <span class="name">${escapeText(opt.name)}</span>
        <span class="meta">${escapeText(opt.meta)}${needsKey ? " · API key not set" : ""}</span>
      </span>
      <span class="badge-tag">${opt.tag}</span>
    </div>`;
  });
  html += `<div class="model-popover-foot">
    <span>${hasAnthKey ? "API key set" : "No Anthropic key configured"}</span>
    <a id="model-popover-settings">Settings →</a>
  </div>`;
  pop.innerHTML = html;

  pop.querySelectorAll(".model-popover-item").forEach(el => {
    el.addEventListener("click", () => {
      if (el.classList.contains("disabled")) return;
      const opt = MODEL_OPTIONS[+el.dataset.idx];
      aiSettings.provider = opt.provider;
      aiSettings.model = opt.model;
      try { localStorage.setItem(AI_LS_KEY, JSON.stringify(aiSettings)); } catch (_) {}
      // If switching providers, drop the cached Gemma pipeline so it
      // reloads with the new model on next Run.
      if (opt.provider === "gemma") {
        gemmaPipeline = null;
        gemmaCurrentModel = null;
        gemmaLoadPromise = null;
      }
      refreshModelBadge();
      closeModelPopover();
      setUdspStatus("Switched to " + opt.name + " (" + opt.tag + ")", "ok");
    });
  });
  const settingsLink = pop.querySelector("#model-popover-settings");
  if (settingsLink) settingsLink.addEventListener("click", () => {
    closeModelPopover();
    openSettings();
  });
}

function openModelPopover() {
  const pop = document.getElementById("model-popover");
  const btn = document.getElementById("btn-model-badge");
  if (!pop || !btn) return;
  renderModelPopover();
  pop.style.display = "block";
  btn.setAttribute("aria-expanded", "true");
  setTimeout(() => document.addEventListener("click", outsideClickClose, { capture: true }), 0);
}
function closeModelPopover() {
  const pop = document.getElementById("model-popover");
  const btn = document.getElementById("btn-model-badge");
  if (pop) pop.style.display = "none";
  if (btn) btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", outsideClickClose, { capture: true });
}
function outsideClickClose(e) {
  const pop = document.getElementById("model-popover");
  const btn = document.getElementById("btn-model-badge");
  if (!pop) return;
  if (pop.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeModelPopover();
}

document.getElementById("btn-model-badge").addEventListener("click", () => {
  const pop = document.getElementById("model-popover");
  if (pop && pop.style.display === "block") closeModelPopover();
  else openModelPopover();
});
document.getElementById("btn-ai-close").addEventListener("click", closeAiPanel);

document.getElementById("btn-ai-go").addEventListener("click", async () => {
  const mode = aiModeEl.value;
  const userText = aiPromptEl.value.trim();
  if (!userText && mode !== "explain") {
    setAiStatus("Enter a description above.", "err");
    return;
  }

  const provider = PROVIDERS[aiSettings.provider];
  let key = "";
  if (provider.requiresKey) {
    key = aiSettings.anthropicKey;  // Only Anthropic needs a key now
    if (!key) {
      setAiStatus("No API key set — click ⚙ to configure.", "err");
      return;
    }
  }

  // Hook Gemma init progress into the status line on first use
  if (aiSettings.provider === "gemma") {
    setGemmaProgressHook((p) => {
      // p has { status, file, progress (0..1), loaded, total }
      const pct = p.progress != null ? Math.round(p.progress * 100) : 0;
      const label = p.file || p.status || "loading model…";
      setAiStatus(`${label} (${pct}%)`, "thinking");
    });
  } else {
    setGemmaProgressHook(null);
  }

  const { system, user } = buildPrompt(mode, userText, getUdspText());
  setAiStatus("Thinking… (" + shortModelName(aiSettings.provider, aiSettings.model) + ", " +
    (aiSettings.provider === "gemma" ? "local" : "cloud") + ")", "thinking");

  // Show the result panel immediately and stream tokens into it.
  // Apply button stays hidden until streaming finishes (and isn't shown
  // for explain mode at all).
  const isExplain = (mode === "explain");
  aiResultLabel.textContent = isExplain
    ? "Explanation (streaming…)"
    : mode.charAt(0).toUpperCase() + mode.slice(1) + " — streaming…";
  aiResultBody.textContent = "";
  aiResult.style.display = "flex";
  document.getElementById("btn-ai-apply").style.display = "none";
  document.getElementById("btn-ai-discard").style.display = "";

  let streamed = "";
  const onToken = (chunk) => {
    streamed += chunk;
    aiResultBody.textContent = streamed;
    aiResultBody.scrollTop = aiResultBody.scrollHeight;
  };

  try {
    const text = await provider.call({
      system, user,
      model: aiSettings.model,
      key,
      onToken
    });
    if (isExplain) {
      aiResultLabel.textContent = "Explanation";
      aiResultBody.textContent = text;
      aiPending = null;
    } else {
      const cleaned = cleanGdspResponse(text);
      aiResultLabel.textContent = mode.charAt(0).toUpperCase() + mode.slice(1) + " — review and Apply to overwrite the editor";
      aiResultBody.textContent = cleaned;
      aiPending = cleaned;
      document.getElementById("btn-ai-apply").style.display = "";
    }
    setAiStatus("Done.", "ok");
  } catch (err) {
    setAiStatus(err.message, "err");
    if (!streamed) aiResult.style.display = "none";
  } finally {
    setGemmaProgressHook(null);
  }
});

document.getElementById("btn-ai-apply").addEventListener("click", () => {
  if (aiPending == null) return;
  setUdspText(aiPending);
  setAiStatus("Applied to editor — click Validate or Save & Add to register.", "ok");
  aiPending = null;
  aiResult.style.display = "none";
});
document.getElementById("btn-ai-discard").addEventListener("click", () => {
  aiPending = null;
  aiResult.style.display = "none";
  setAiStatus("Discarded.", "");
});

/* ---------------- Settings modal ---------------- */

const settingsModal = document.getElementById("settings-modal");
const sProvider     = document.getElementById("settings-provider");
const sModel        = document.getElementById("settings-model");
const sModelLocal   = document.getElementById("settings-model-local");
const sKey          = document.getElementById("settings-key");
const sKeyLabel     = document.getElementById("settings-key-label");
const sNoteApi      = document.getElementById("settings-note-api");
const sNoteLocal    = document.getElementById("settings-note-local");
const sCompileUrl   = document.getElementById("settings-compile-url");
const sServerResult = document.getElementById("settings-server-result");

function applyProviderUi(p) {
  const isLocal = p === "gemma";
  // Toggle WebGPU note vs API-key note
  sNoteApi.style.display   = isLocal ? "none" : "block";
  sNoteLocal.style.display = isLocal ? "block" : "none";
  // Toggle model-id input vs model dropdown
  sModel.style.display      = isLocal ? "none" : "block";
  sModelLocal.style.display = isLocal ? "block" : "none";
  // Hide key field for Gemma (no key needed)
  sKey.style.display      = isLocal ? "none" : "block";
  sKeyLabel.style.display = isLocal ? "none" : "block";
  // Show / refresh the local-model status panel
  const panel = document.getElementById("gemma-status-panel");
  if (panel) panel.style.display = isLocal ? "block" : "none";
  if (isLocal) refreshGemmaStatus();
  // Warn if WebGPU isn't available
  if (isLocal && !setupGemmaAvailable()) {
    sNoteLocal.style.color = "var(--danger)";
    sNoteLocal.textContent = "WebGPU is not available in this browser. Gemma 4 requires Chrome, Edge, or recent Safari with WebGPU enabled. Try chrome://flags/#enable-unsafe-webgpu if needed, or switch to the Anthropic provider.";
  } else {
    sNoteLocal.style.color = "";
    sNoteLocal.textContent = "Local models run entirely in your browser via WebGPU. No data leaves your machine. The first time you Run, the model weights download (~1.5 GB for E4B, ~500 MB for E2B) and are cached in the browser; subsequent runs are offline. Requires a WebGPU-capable browser (Chrome, Edge, recent Safari) and a discrete GPU or unified-memory machine with at least 4 GB free.";
  }
}

/* Gemma status panel — shows WebGPU availability and current model load
 * state in the settings modal. The "Preload model" button triggers
 * ensureGemmaPipeline without running inference, so users can warm the
 * model at their leisure rather than waiting at the first prompt. */
function refreshGemmaStatus() {
  const gpu = document.getElementById("gemma-webgpu-state");
  const mod = document.getElementById("gemma-model-state");
  if (!gpu || !mod) return;
  if (setupGemmaAvailable()) {
    gpu.textContent = "available";
    gpu.style.color = "var(--audio)";
  } else {
    gpu.textContent = "not available";
    gpu.style.color = "var(--danger)";
  }
  if (gemmaPipeline) {
    mod.textContent = "loaded — " + (gemmaCurrentModel || "");
    mod.style.color = "var(--audio)";
  } else if (gemmaLoadPromise) {
    mod.textContent = "loading…";
    mod.style.color = "var(--accent)";
  } else {
    mod.textContent = "not loaded — first Run will download";
    mod.style.color = "var(--text-3)";
  }
}

document.getElementById("btn-gemma-preload").addEventListener("click", async () => {
  const note = document.getElementById("gemma-preload-note");
  if (!setupGemmaAvailable()) {
    note.textContent = "WebGPU isn't available — preload would fail.";
    note.style.color = "var(--danger)";
    return;
  }
  const model = sModelLocal.value || PROVIDERS.gemma.defaultModel;
  note.textContent = "Loading model… first run downloads ~1.5 GB. Watch the network tab if curious.";
  note.style.color = "var(--text-2)";
  setGemmaProgressHook((p) => {
    if (!p) return;
    // transformers.js's progress_callback gives `progress` already in
    // 0–100 range (NOT 0–1). Clamp + display directly. Each file in
    // the download emits its own stream; `status` distinguishes
    // initiate / download / progress / done / ready.
    if (p.status === "progress" && typeof p.progress === "number") {
      const pct = Math.max(0, Math.min(100, p.progress));
      const sizeMB = p.total ? ` of ${(p.total / 1048576).toFixed(0)} MB` : "";
      note.textContent = `Loading ${p.file || ""}: ${pct.toFixed(0)}%${sizeMB}`;
    } else if (p.status === "done") {
      note.textContent = `Downloaded ${p.file || ""}`;
    } else if (p.status === "ready") {
      note.textContent = "Model ready";
    } else if (p.status) {
      note.textContent = `${p.status}: ${p.file || ""}`;
    }
    refreshGemmaStatus();
  });
  try {
    await ensureGemmaPipeline(model);
    note.textContent = "Loaded. Future Runs are instant until the page reloads.";
    note.style.color = "var(--audio)";
    refreshGemmaStatus();
  } catch (e) {
    note.textContent = "Preload failed: " + e.message;
    note.style.color = "var(--danger)";
  } finally {
    setGemmaProgressHook(null);
  }
});

function openSettings() {
  sProvider.value = aiSettings.provider;
  if (aiSettings.provider === "gemma") {
    const opts = Array.from(sModelLocal.options).map(o => o.value);
    sModelLocal.value = opts.includes(aiSettings.model) ? aiSettings.model : PROVIDERS.gemma.defaultModel;
  } else {
    sModel.value = aiSettings.model;
    sKey.value   = aiSettings.anthropicKey;
  }
  if (sCompileUrl) sCompileUrl.value = aiSettings.compileServerUrl || "";
  if (sServerResult) { sServerResult.textContent = ""; sServerResult.style.color = ""; }
  applyProviderUi(aiSettings.provider);
  settingsModal.style.display = "flex";
}
function closeSettings() { settingsModal.style.display = "none"; }

document.getElementById("btn-udsp-settings").addEventListener("click", openSettings);
document.getElementById("btn-settings-close").addEventListener("click", closeSettings);

sProvider.addEventListener("change", () => {
  const p = sProvider.value;
  applyProviderUi(p);
  if (p === "gemma") {
    const opts = Array.from(sModelLocal.options).map(o => o.value);
    sModelLocal.value = opts.includes(aiSettings.model) ? aiSettings.model : PROVIDERS.gemma.defaultModel;
  } else {
    sKey.value = aiSettings.anthropicKey;
    // Anthropic — pre-fill with default model if user hasn't already typed one
    if (!sModel.value || sModel.value.startsWith("onnx-community/")) {
      sModel.value = PROVIDERS.anthropic.defaultModel;
    }
  }
});

document.getElementById("btn-settings-save").addEventListener("click", () => {
  aiSettings.provider = sProvider.value;
  if (aiSettings.provider === "gemma") {
    const newModel = sModelLocal.value;
    // If switching to a different model, drop the cached engine so next Run reloads
    if (aiSettings.model !== newModel) {
      gemmaPipeline = null;
      gemmaCurrentModel = null;
      gemmaLoadPromise = null;
    }
    aiSettings.model = newModel;
  } else {
    aiSettings.model = sModel.value.trim() || PROVIDERS.anthropic.defaultModel;
    aiSettings.anthropicKey = sKey.value.trim();
  }
  // Compile-server URL: trim, strip trailing slash, accept blank to mean
  // "use the default 127.0.0.1/localhost probe". Force a fresh probe on
  // next Play so the new URL takes effect immediately.
  if (sCompileUrl) {
    let url = sCompileUrl.value.trim().replace(/\/+$/, "");
    aiSettings.compileServerUrl = url;
  }
  localServerStatus = null;
  localServerEndpoint = null;
  saveAiSettings();
  closeSettings();
  setAiStatus("Settings saved.", "ok");
  refreshModelBadge();
});

/* Test the user-entered (or default) compile server URL inline so they
 * can confirm it's reachable before saving. Runs the same /health
 * handshake as probeLocalServer, with a longer timeout (3 s) since LAN
 * round-trips can be a touch slower than localhost. */
document.getElementById("btn-settings-test-server").addEventListener("click", async () => {
  if (!sServerResult) return;
  const raw = (sCompileUrl ? sCompileUrl.value : "").trim().replace(/\/+$/, "");
  const url = raw || "http://127.0.0.1:8765";
  sServerResult.textContent = "probing " + url + "…";
  sServerResult.style.color = "var(--text-3)";
  try {
    const res = await fetch(url + "/health", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (!j || j.service !== "gamma-compile-server") throw new Error("not gamma-compile-server (got " + JSON.stringify(j).slice(0, 80) + ")");
    const ver = j.version ? " v" + j.version : "";
    sServerResult.textContent = "✓ reachable" + ver;
    sServerResult.style.color = "var(--audio)";
  } catch (e) {
    // Mixed-content failures show as TypeError "Failed to fetch" with no
    // useful detail in DevTools — surface a clearer hint inline.
    const msg = (e && e.message) || String(e);
    let hint = msg;
    if (/Failed to fetch|NetworkError/i.test(msg) && /^https?:/i.test(location.protocol) && location.protocol === "https:" && url.startsWith("http://") && !/\/\/(127\.0\.0\.1|localhost)/.test(url)) {
      hint = "blocked — editor is on https://, daemon is on http:// LAN. Serve the editor over http:// (e.g. python -m http.server) or run the daemon behind https.";
    } else if (/abort|timeout/i.test(msg)) {
      hint = "timeout — daemon not running or unreachable from this device";
    }
    sServerResult.textContent = "✗ " + hint;
    sServerResult.style.color = "var(--danger)";
  }
});
document.getElementById("btn-settings-clear").addEventListener("click", () => {
  if (!confirm("Clear stored Anthropic API key from this browser?")) return;
  aiSettings.anthropicKey = "";
  saveAiSettings();
  sKey.value = "";
  refreshModelBadge();
});

// Initial paint of the badge after AI settings are wired up.
refreshModelBadge();

// Cmd/Ctrl-Enter in prompt = run
aiPromptEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    document.getElementById("btn-ai-go").click();
  }
});

/* =========================================================================
 * Canvas tools: Select / Draw  + ink-layer capture
 *
 * Tool modes:
 *   "select" — default; existing drag/connect/disconnect interactions
 *   "draw"   — pointerdown on empty canvas starts a rectangle; subsequent
 *              strokes inside the rectangle are captured as ink. On "✓
 *              Recognize" the strokes are rasterized and sent to the
 *              cloud LLM (vision-capable) which replies with the node
 *              type to instantiate at the rectangle's position.
 *
 * Pen detection: PointerEvent.pointerType === "pen" auto-engages draw
 * mode for the duration of the stylus interaction, regardless of the
 * current tool. This matches drawing-app conventions.
 * ======================================================================== */

const ink         = document.getElementById("ink");
const inkFinalize = document.getElementById("ink-finalize");
const toolBtns    = document.querySelectorAll(".tool-btn[data-tool]");
const canvasWrap  = document.querySelector(".canvas-wrap");
let currentTool   = "select";
let inkBox        = null;   // { x, y, w, h }   the drawn rectangle in canvas coords
let inkStrokes    = [];     // array of arrays of {x, y}; currently captured strokes
let inkCurrent    = null;   // active stroke being drawn
let drawingBox    = false;  // true between pointerdown-on-empty and pointerup
let boxStart      = null;   // { x, y } of pointerdown when drawing a new box

function setTool(name) {
  currentTool = name;
  toolBtns.forEach(b => b.classList.toggle("active", b.dataset.tool === name));
  canvas.classList.toggle("draw-mode", name === "draw");
  ink.classList.toggle("draw-mode", name === "draw");
  if (name !== "draw") clearInk();
}

toolBtns.forEach(b => {
  b.addEventListener("click", () => setTool(b.dataset.tool));
});

