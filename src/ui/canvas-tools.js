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

/* Quick-wins sprint (2026-06-05) -- Fit-to-view button.
 *
 * Computes the bounding box of the current selection (or all nodes
 * when nothing is selected) + adjusts view.panX / view.panY / view.zoom
 * so the box fills the canvas with a 60 px margin. Empty scenes
 * recenter at (0, 0) with zoom=1.
 *
 * Node sizes aren't perfectly known here (some nodes auto-grow with
 * port count); we approximate each node as 200x140 which is a
 * reasonable footprint for the bulk of the registry. Sloppy bbox is
 * fine -- the fit clamps zoom to [0.2, 4] so an undersized estimate
 * just leans toward over-margin rather than clipping. */
function _gnFitCanvasToView() {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  const c = document.getElementById("canvas");
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const subset = (typeof selectedSet !== "undefined" && selectedSet && selectedSet.size > 0)
    ? state.nodes.filter(n => selectedSet.has(n.id))
    : state.nodes;
  if (!subset.length) {
    view.panX = 0; view.panY = 0; view.zoom = 1;
    if (typeof render === "function") render();
    return;
  }
  let minX =  Infinity, maxX = -Infinity;
  let minY =  Infinity, maxY = -Infinity;
  const APPROX_W = 200, APPROX_H = 140;
  for (const n of subset) {
    const x = +n.x || 0, y = +n.y || 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + APPROX_W > maxX) maxX = x + APPROX_W;
    if (y + APPROX_H > maxY) maxY = y + APPROX_H;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const margin = 60;
  const sx = (rect.width  - margin * 2) / w;
  const sy = (rect.height - margin * 2) / h;
  const z = Math.max(0.2, Math.min(2, Math.min(sx, sy)));
  view.zoom = z;
  // Pan so the bbox center lands at the canvas center.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  view.panX = rect.width  / 2 - cx * z;
  view.panY = rect.height / 2 - cy * z;
  if (typeof render === "function") render();
}

const fitBtn = document.getElementById("tool-fit");
if (fitBtn) fitBtn.addEventListener("click", _gnFitCanvasToView);

// Keyboard shortcut: "F" when no text input is focused. Skips when
// the user is editing a node param / search / etc.
document.addEventListener("keydown", (e) => {
  if (e.key !== "f" && e.key !== "F") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
      (e.target && e.target.isContentEditable)) return;
  e.preventDefault();
  _gnFitCanvasToView();
});

