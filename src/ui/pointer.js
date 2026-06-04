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

