/* =========================================================================
 * Node type registry — covers ~55 Gamma DSP classes
 *
 * Per-entry fields:
 *   category   - palette grouping
 *   color      - strip + palette dot
 *   header     - Gamma/<header>.h to include if this node is used
 *   cppType    - full type for member declaration; "" for inline/math/sink
 *   ins, outs  - port lists ({n, t}) where t is "audio" | "param" | "gate"
 *   params     - default values for non-edge inputs and tunable settings
 *   methods    - param-name → Gamma setter method (defaults to identity)
 *   gateMethods- gate-port → method called on trigger (default "reset")
 *   extraCtor  - raw lines emitted in ctor; "{id}" interpolated to node id
 *   template   - inline C++ expression for non-member nodes; {portName} and
 *                {paramName} substituted with their respective expressions
 *   description- short tooltip text (also shown in properties pane header)
 * ======================================================================== */

const COLOR = {
  oscillator: "#7f77dd",
  noise:      "#afa9ec",
  envelope:   "#d8a030",
  filter:     "#1d9e75",
  delay:      "#e0793f",
  effect:     "#d85a30",
  analysis:   "#97c459",
  sample:     "#4a8fdc",
  convert:    "#6dc5b5",
  math:       "#888780",
  sink:       "#3a3d44",
  visual:     "#1f3a4a",    /* Phase 6 — visual nodes (sinks today,
                               shader-frag/vert/compute starting 6.4.x) */
  ai:         "#b264c8",    /* Phase 7.1 — AI/vision nodes
                               (MediaPipe HandLandmarker etc).
                               Distinct magenta so the gesture-/face-/
                               pose-tracking sources stand apart from
                               the audio-side Analysis family. */
  tektite:    "#5fb8d4"     /* Phase C sprint tektite-10b -- spatial
                               card kinds (TextCard / NoteCard /
                               LinkCard / BaseCard / GraphCard).
                               Cyan tracks the Tektite palette in
                               the rest of the UI (popouts, wikilinks,
                               graph edges). */
};

