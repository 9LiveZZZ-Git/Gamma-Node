/* =========================================================================
 * Live Mode — Phase 6.7.5 (shipped early, ahead of full visual layer)
 *
 * One-toggle full-screen visual mode. Hides the entire editor UI via
 * a body class, leaving only the visual canvas. Designed for live-
 * performance use: the moment you go on stage, you don't want palette /
 * properties / code / preview chrome competing with the projected
 * visuals.
 *
 * Three ways in/out:
 *   • Toolbar "◐" button (#btn-live-mode)
 *   • Hotkey `L` (context-aware: skipped when typing in any text input)
 *   • Hotkey `Escape` from inside live mode (safety exit; never
 *     ambiguous since modals close before this fires)
 *
 * Idle-fade: after 2.5 s of pointer stillness in live mode, the floating
 * "Exit Live" affordance fades to opacity 0 and the cursor hides. Any
 * pointermove restores both. Keeps the visual frame clean during long
 * sustained passages.
 * ======================================================================== */

let liveMode = false;
let _liveIdleTimer = null;
const LIVE_IDLE_MS = 2500;

function isLiveMode() { return liveMode; }

function setLiveMode(on) {
  on = !!on;
  if (on === liveMode) return;
  liveMode = on;
  document.body.classList.toggle("live-mode", liveMode);
  const btn = document.getElementById("btn-live-mode");
  if (btn) btn.classList.toggle("active", liveMode);
  if (liveMode) {
    // Drop focus from any text input so the L-key exit doesn't get
    // swallowed by an open Code / JSON tab textarea.
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }
    document.body.classList.remove("live-idle");
    document.body.classList.add("cursor-revealed");
    _scheduleLiveIdleFade();
  } else {
    document.body.classList.remove("live-idle", "cursor-revealed");
    if (_liveIdleTimer) { clearTimeout(_liveIdleTimer); _liveIdleTimer = null; }
    // v0.2.24 — exiting Live Mode also exits Viewer Mode so the
    // editor chrome is fully visible. Viewer-mode CSS hides toolbar
    // / palette / footer; without dropping the class, an L-press
    // from a standalone viewer would just show a blank page.
    // (Reload to re-enter viewer mode.)
    document.body.classList.remove("viewer-mode");
    // Hide all UI/HUD overlays now — they're a live-mode-only affordance.
    // Done explicitly (not via the render tick) so they vanish even if
    // the visual loop is frozen / paused in edit mode.
    if (typeof _hideAllOverlays === "function") _hideAllOverlays(false);
  }
}

function toggleLiveMode() { setLiveMode(!liveMode); }

function _scheduleLiveIdleFade() {
  if (_liveIdleTimer) clearTimeout(_liveIdleTimer);
  _liveIdleTimer = setTimeout(() => {
    if (!liveMode) return;
    document.body.classList.add("live-idle");
    document.body.classList.remove("cursor-revealed");
  }, LIVE_IDLE_MS);
}

// Reveal exit affordance + cursor on any movement / interaction in live
// mode. Pointermove on document fires for both mouse and touch.
window.addEventListener("pointermove", () => {
  if (!liveMode) return;
  if (document.body.classList.contains("live-idle") ||
      !document.body.classList.contains("cursor-revealed")) {
    document.body.classList.remove("live-idle");
    document.body.classList.add("cursor-revealed");
  }
  _scheduleLiveIdleFade();
}, { passive: true });

// Wire button + hotkeys at end of init (after the existing keydown
// handlers register so we can early-return cleanly without fighting
// them). Done at the bottom of this script block.

/* =========================================================================
 * Phase 6.7.1 — Hide-graph toggle (H key)
 *
 * Body class `graph-hidden` drops #canvas-world (the node-graph surface
 * with nodes + wires SVG). Header, palette, properties pane, bottom
 * tabs, and the visual HUD all stay visible -- the WebGPU canvas
 * underneath is now unobstructed, perfect for showing visuals without
 * fully committing to Live Mode (which collapses the entire editor).
 *
 * Same input-guard pattern as Live Mode (L key):
 *   - Skip when typing in a text input
 *   - Skip when audio preview is playing (H is also mapped to MIDI A4
 *     in QWERTY_TO_MIDI, line ~36883 -- a ringing-out note wins)
 * ======================================================================== */

let graphHidden = false;
function isGraphHidden() { return graphHidden; }
function setGraphHidden(on) {
  on = !!on;
  if (on === graphHidden) return;
  graphHidden = on;
  document.body.classList.toggle("graph-hidden", graphHidden);
  const pill = document.getElementById("graph-hide-pill");
  if (pill) {
    pill.classList.toggle("active", graphHidden);
    pill.textContent = graphHidden ? "▣" : "⊟";
  }
}
function toggleGraphHidden() { setGraphHidden(!graphHidden); }

