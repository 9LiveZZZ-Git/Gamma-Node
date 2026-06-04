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

