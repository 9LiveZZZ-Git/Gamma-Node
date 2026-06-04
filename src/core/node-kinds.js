/* =========================================================================
 * Node kinds — runtime-only kind registry
 *
 * Phase A.1 of the LLM + knowledge-management roadmap branch
 * (docs/LLM-KNOWLEDGE-PHASE.md §3.A.1).
 *
 * `def.kind` is an existing field in the node-type registry; today the
 * codegen path reads it to special-case `"delay1"` feedback nodes
 * (src/codegen/index.js). RayTracedScene already uses `kind: "scene-rt"`
 * to dispatch a different visual encoder path.
 *
 * Phase A.1 reserves four NEW kind tags for nodes that are JS/WebGPU-
 * runtime-only and do NOT participate in the C++ Gamma DSP codegen
 * path (mirroring how `RayTracedScene` is treated — its outputs land
 * in the visual pipeline, not in the emitted `.h`):
 *
 *   "llm-op"        Pure tensor op. Has forward + backward exported
 *                   in the LLM autograd registry (Phase D / src/llm/).
 *                   Examples: MultiHeadAttention, LayerNorm, FFN.
 *
 *   "llm-sink"      Side-effecting LLM endpoint (training, inference).
 *                   Examples: TrainStep, Generate, Chat.
 *
 *   "llm-viz"       Renders LLM state to a `texture` port (consumable
 *                   by any downstream Material / Composite slot).
 *                   Examples: AttentionGraph3D, LossPlot,
 *                   EmbeddingProjection.
 *
 *   "notes-source"  Streams tokenized notes from the Tektite MD vault
 *                   (Phase C / src/tektite/) as a training corpus.
 *                   Example: NotesCorpus.
 *
 * Nodes with these kinds:
 *   - Skip C++ codegen entirely (no member declaration, no setter
 *     emission, no expression contribution). They naturally don't
 *     appear in audio codegen because their port types
 *     (`vector`, `llm-attn`, `texture`, ...) live in
 *     VISUAL_PORT_TYPES, not SIGNAL_PORT_TYPES, so they can't be
 *     wired into the audio signal tree. The skip is enforced
 *     defensively in src/codegen/index.js via isRuntimeOnlyKind().
 *   - Persist their params + wire connections in `.gpatch` save
 *     (no special treatment — just falls through the regular
 *     state-serialization path).
 *   - Are dispatched at runtime through subsystem-specific routers:
 *       llm-* → src/llm/dispatcher.js (Phase D)
 *       notes-source → src/tektite/corpus.js (Phase C)
 *     Until those subsystems ship, runtime-only nodes are inert
 *     (registered but produce no per-frame output).
 *
 * This file declares the set + an isRuntimeOnlyKind() helper that
 * codegen, wire-eval, and any future runtime dispatcher consult so
 * the canonical list lives in exactly one place. Adding a new
 * runtime-only kind tag means editing this file and nothing else.
 * ======================================================================== */

const RUNTIME_ONLY_KINDS = new Set([
  "llm-op",
  "llm-sink",
  "llm-viz",
  "notes-source"
]);

function isRuntimeOnlyKind(k) {
  return typeof k === "string" && RUNTIME_ONLY_KINDS.has(k);
}
