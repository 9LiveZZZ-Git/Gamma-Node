/* =========================================================================
 * Spatial board primitives
 *
 * Phase C sprint tektite-10a -- foundation for the upcoming Path A
 * unification. Extracted from the main canvas (view.panX/panY/zoom)
 * + Tektite Canvas pan/zoom + Tektite Graph viewport so the eventual
 * TextCard / NoteCard / LinkCard / BaseCard / GraphCard node kinds
 * can sit on a single board abstraction.
 *
 * The factory returns a board controller with:
 *   - pan/zoom state with clamping
 *   - screen <-> world coord transforms
 *   - cursor-anchored zoom (mouse wheel UX)
 *   - fit-to-bounds (used by ⊕ Fit + the Canvas modal's same-named button)
 *   - reset
 *   - CSS-transform applier for DOM-backed boards (Tektite Canvas);
 *     numeric-state-only boards (main canvas, which has its own
 *     SVG + DOM rendering) can read the numbers and apply themselves.
 *
 * The intent is callsite-flexibility: hand the controller a viewport
 * rect (from getBoundingClientRect) at each operation rather than
 * stash a DOM reference inside.  Lets the same primitive serve both
 * the main canvas (uses `canvas` element) and the Tektite Canvas
 * (uses `.tektite-canvas-board`) without binding to either.
 *
 * Sprint 10b: TextCard / NoteCard / LinkCard node kinds reuse this.
 * Sprint 10c: BaseView + GraphView node kinds reuse this.
 *
 * Existing code that uses `view.panX / view.panY / view.zoom`
 * directly (src/core/state-decl.js + handlers throughout) stays as
 * the read-write source of truth for the main canvas in this sprint;
 * it can be refactored to construct one of these controllers in 10b
 * if we want, but that's not blocking.
 * ======================================================================== */

function createSpatialBoard(opts) {
  opts = opts || {};
  const state = {
    panX:    Number.isFinite(opts.initialPanX) ? opts.initialPanX : 0,
    panY:    Number.isFinite(opts.initialPanY) ? opts.initialPanY : 0,
    zoom:    Number.isFinite(opts.initialZoom) ? opts.initialZoom : 1,
    minZoom: Number.isFinite(opts.minZoom)     ? opts.minZoom     : 0.1,
    maxZoom: Number.isFinite(opts.maxZoom)     ? opts.maxZoom     : 8,
    // Whether worldOriginAtCenter is true: world (0,0) maps to the
    // viewport center when pan=0.  When false, world (0,0) maps to
    // the viewport top-left.  Main canvas uses top-left; Tektite
    // Canvas + graph view use center origin.
    originAtCenter: opts.originAtCenter !== false
  };

  function _clampZoom(z) {
    return Math.max(state.minZoom, Math.min(state.maxZoom, z));
  }

  return {
    getPanX:  () => state.panX,
    getPanY:  () => state.panY,
    getZoom:  () => state.zoom,
    setPan:   (x, y) => { state.panX = x; state.panY = y; },
    setZoom:  (z) => { state.zoom = _clampZoom(z); },
    setMinMax:(min, max) => { state.minZoom = min; state.maxZoom = max; },

    /* Screen -> world. `rect` is a DOMRect-shape ({ left, top, width,
     * height }) from getBoundingClientRect on the board element. */
    screenToWorld(sx, sy, rect) {
      const cx = sx - rect.left;
      const cy = sy - rect.top;
      const ox = state.originAtCenter ? rect.width  / 2 : 0;
      const oy = state.originAtCenter ? rect.height / 2 : 0;
      return {
        x: (cx - ox - state.panX) / state.zoom,
        y: (cy - oy - state.panY) / state.zoom
      };
    },
    /* World -> screen. */
    worldToScreen(wx, wy, rect) {
      const ox = state.originAtCenter ? rect.width  / 2 : 0;
      const oy = state.originAtCenter ? rect.height / 2 : 0;
      return {
        x: rect.left + ox + state.panX + wx * state.zoom,
        y: rect.top  + oy + state.panY + wy * state.zoom
      };
    },

    /* Incremental pan -- accumulate dx/dy in screen pixels. */
    panBy(dx, dy) { state.panX += dx; state.panY += dy; },

    /* Cursor-anchored zoom -- the world point under (sx, sy) stays
     * pinned across the zoom step. `factor` > 1 zooms in. */
    zoomAt(sx, sy, rect, factor) {
      const ox = state.originAtCenter ? rect.width  / 2 : 0;
      const oy = state.originAtCenter ? rect.height / 2 : 0;
      const cx = sx - rect.left - ox;
      const cy = sy - rect.top  - oy;
      const wx = (cx - state.panX) / state.zoom;
      const wy = (cy - state.panY) / state.zoom;
      state.zoom = _clampZoom(state.zoom * factor);
      state.panX = cx - wx * state.zoom;
      state.panY = cy - wy * state.zoom;
    },

    /* Standard mouse-wheel handler.  Translates delta to a zoom
     * factor + applies cursor-anchored zoom.  Pass it the event +
     * viewport rect at call time.  Returns nothing -- caller
     * triggers their own re-render. */
    wheelZoom(e, rect, sensitivity) {
      const sens = (typeof sensitivity === "number") ? sensitivity : 0.0015;
      const factor = Math.exp(-e.deltaY * sens);
      this.zoomAt(e.clientX, e.clientY, rect, factor);
    },

    /* Fit a world-space bounding box ({minX, maxX, minY, maxY}) into
     * the viewport with `margin` pixels of padding.  Centers the bbox.
     * Returns nothing; caller re-renders. */
    fitToBounds(bounds, viewportW, viewportH, margin) {
      if (!bounds || !Number.isFinite(bounds.minX)) { this.reset(); return; }
      const m = Number.isFinite(margin) ? margin : 60;
      const w = Math.max(1, bounds.maxX - bounds.minX);
      const h = Math.max(1, bounds.maxY - bounds.minY);
      const sx = (viewportW - m * 2) / w;
      const sy = (viewportH - m * 2) / h;
      state.zoom = _clampZoom(Math.min(sx, sy));
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      if (state.originAtCenter) {
        state.panX = -cx * state.zoom;
        state.panY = -cy * state.zoom;
      } else {
        state.panX = viewportW / 2 - cx * state.zoom;
        state.panY = viewportH / 2 - cy * state.zoom;
      }
    },

    /* Pan + zoom to identity. */
    reset() { state.panX = 0; state.panY = 0; state.zoom = 1; },

    /* CSS-transform applier for DOM-backed boards. */
    applyCssTransform(el) {
      if (!el) return;
      el.style.transform =
        "translate(" + state.panX + "px, " + state.panY + "px) scale(" + state.zoom + ")";
    },

    /* Read the current state as a plain object -- useful for
     * persistence / debugging. */
    snapshot() { return { panX: state.panX, panY: state.panY, zoom: state.zoom }; },
    restore(snap) {
      if (snap && Number.isFinite(snap.panX)) state.panX = snap.panX;
      if (snap && Number.isFinite(snap.panY)) state.panY = snap.panY;
      if (snap && Number.isFinite(snap.zoom)) state.zoom = _clampZoom(snap.zoom);
    }
  };
}

/* Helper: compute the world-space bounding box of an array of node
 * objects with { x, y, width?, height? } fields.  Used by fit-to-view
 * across the main canvas, Tektite Canvas, and (after sprint 10c) the
 * unified spatial node kinds. */
function spatialBoundsForNodes(nodes, defaultW, defaultH) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const dw = Number.isFinite(defaultW) ? defaultW : 200;
  const dh = Number.isFinite(defaultH) ? defaultH : 140;
  let minX =  Infinity, maxX = -Infinity;
  let minY =  Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const x = +n.x || 0, y = +n.y || 0;
    const w = +n.width  || dw;
    const h = +n.height || dh;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}
