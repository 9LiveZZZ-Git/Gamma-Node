/* =========================================================================
 * LLM runtime dispatcher
 *
 * Phase B sprint 4 of docs/LLM-KNOWLEDGE-PHASE.md §4. Drives the five
 * MVP LLM nodes added in this sprint:
 *
 *   llm-op  nodes (zero-runtime, just a string source):
 *     SystemPrompt     -- outputs `params.text` on its `text` port
 *     LLMModelPicker   -- outputs `params.model` on its `model` port
 *
 *   llm-sink nodes (gate-triggered async fetch):
 *     LLMChat          -- /api/chat,     streams to node body, writes `text`
 *     LLMGenerate      -- /api/generate, same shape as Chat
 *     LLMEmbed         -- /api/embed,    writes the embedding to `vector`
 *
 * For llm-op nodes there's nothing to tick -- consumers read their
 * outputs via _readTextWire() which just returns the source node's
 * `params[outputPortName]`. They appear in the graph + flow strings
 * downstream without any per-frame work.
 *
 * For llm-sink nodes, _tickLLMRuntime() is invoked once per visual
 * frame from src/visual/render-loop.js. The tick:
 *   1. Detects rising edges on each sink's `trigger` gate.
 *   2. On rise, reads the text inputs from wires (or local params),
 *      resolves the model name (wire / param / aiSettings.model
 *      fallback), and launches the async fetch via ollamaChat /
 *      ollamaGenerate / ollamaEmbed.
 *   3. While streaming: tokens flow into the node's `.llm-stream-body`
 *      element via createTokenStreamBody (Phase A.2 primitive).
 *   4. On completion: writes the accumulated text to params.text (Chat
 *      / Generate) or the embedding to params._vec (Embed), fires the
 *      `done` gate by setting params.done = 1 for one tick.
 *   5. The node DOM may be rebuilt mid-stream (graph re-render); the
 *      runtime detects a stale `body.el` and re-creates the stream
 *      body on the new DOM node.
 *
 * Cancellation: not implemented in this sprint. A second trigger
 * while a stream is in flight is ignored. Sprint B.6 will add an
 * AbortController per node.
 * ======================================================================== */

/* Per-node runtime state. Keyed by node id. Stored here rather than on
 * the node object so a node restart (delete + re-add with same id) gets
 * a clean slate. */
const _llmRuntimeStates = new Map();

function _llmGetState(nodeId) {
  let s = _llmRuntimeStates.get(nodeId);
  if (!s) {
    s = {
      lastTrigger: 0,
      streaming:   false,
      body:        null,    // { el, append, finalize, clear, isStreaming }
      bodyNodeEl:  null,    // the .node DOM element that body was attached to
      generation:  0        // bumped each fetch; lets late onTokens drop if a new run started
    };
    _llmRuntimeStates.set(nodeId, s);
  }
  return s;
}

/* Read a `text`-typed input on `node`. If the port is wired, walk the
 * wire to the source and return `srcNode.params[srcOutputPortName]` as
 * a string. If not wired, fall back to `node.params[portName]`. Empty
 * string for missing / non-string values rather than null so consumers
 * don't have to null-check before passing into a fetch body.
 *
 * Mirrors the existing _readWireJsSideValue pattern for numeric wires
 * (src/core/wire-eval.js) but specialized for text. The LLM runtime
 * keeps its own walker rather than extending wire-eval so the text-
 * port semantics stay local to this subsystem. */
function _readTextWire(node, portName) {
  if (!node || typeof portName !== "string") return "";
  if (state && Array.isArray(state.edges)) {
    for (const e of state.edges) {
      if (e && e.to && e.to.node === node.id && e.to.port === portName) {
        const src = state.nodes.find(n => n && n.id === e.from.node);
        if (src && src.params) {
          const v = src.params[e.from.port];
          if (typeof v === "string") return v;
          // Allow numeric upstream values to coerce to string for
          // convenience (e.g. wire a Slider into LLMChat.system to test
          // a parameter sweep). Only on direct mismatch, not when the
          // upstream is text but empty.
          if (typeof v === "number" && Number.isFinite(v)) return String(v);
        }
      }
    }
  }
  const local = node.params && node.params[portName];
  return (typeof local === "string") ? local : "";
}

/* Detect a rising edge on the `trigger` gate input. Returns true exactly
 * once per 0->1 transition. The trigger value comes from either a
 * connected gate wire (read via _readWireJsSideValue) or the local
 * params.trigger (so a Button auto-wired to params.trigger by the
 * monitor controls works without the user wiring a gate). */
function _llmDetectTrigger(node, rt) {
  let v = 0;
  // `state` here is the global editor state, not the rt parameter.
  if (typeof _readWireJsSideValue === "function" && state && Array.isArray(state.edges)) {
    for (const e of state.edges) {
      if (e && e.to && e.to.node === node.id && e.to.port === "trigger") {
        const r = _readWireJsSideValue(e);
        if (typeof r === "number") { v = r; break; }
      }
    }
  }
  if (!v) {
    const local = node.params && node.params.trigger;
    if (typeof local === "number") v = local;
  }
  const wasLow  = (rt.lastTrigger || 0) < 0.5;
  const isHigh  = v >= 0.5;
  rt.lastTrigger = v;
  return wasLow && isHigh;
}

/* Resolve (or re-create) the streaming body element inside a sink node's
 * DOM. The .node element gets rebuilt on every render() pass, so a body
 * cached against the previous .node element is stale and dropped. */
function _llmEnsureBody(node, runtimeState) {
  const nodeEl = document.querySelector('.node[data-id="' + node.id + '"]');
  if (!nodeEl) return null;
  if (runtimeState.body && runtimeState.bodyNodeEl === nodeEl && runtimeState.body.el.isConnected) {
    return runtimeState.body;
  }
  // Replace any existing slot or create a fresh one inside this node.
  let slot = nodeEl.querySelector(".llm-stream-body");
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "llm-stream-body";
    nodeEl.appendChild(slot);
  } else {
    slot.classList.remove("error");
    slot.innerHTML = "";
  }
  runtimeState.body       = createTokenStreamBody(slot);
  runtimeState.bodyNodeEl = nodeEl;
  return runtimeState.body;
}

function _llmMarkError(node, runtimeState, msg) {
  const nodeEl = document.querySelector('.node[data-id="' + node.id + '"]');
  if (!nodeEl) return;
  let slot = nodeEl.querySelector(".llm-stream-body");
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "llm-stream-body";
    nodeEl.appendChild(slot);
  }
  slot.classList.add("error");
  slot.textContent = String(msg || "error");
  runtimeState.body = null;
  runtimeState.bodyNodeEl = null;
}

/* The four async kicks. Each takes (node, runtimeState) and runs an
 * Ollama call until completion, then publishes the output. */

async function _llmKickChat(node, rt) {
  rt.streaming = true;
  rt.generation++;
  const myGen = rt.generation;
  const body  = _llmEnsureBody(node, rt);
  if (body) body.clear();

  const system = _readTextWire(node, "system");
  const user   = _readTextWire(node, "prompt") || _readTextWire(node, "user");
  let   model  = _readTextWire(node, "model");
  if (!model && typeof aiSettings === "object") model = aiSettings.model || "llama3.2";

  const onToken = (tok) => {
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.append(tok);
  };

  try {
    const acc = await ollamaChat({
      baseUrl: aiSettings && aiSettings.ollamaUrl,
      model, system, user, onToken
    });
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.finalize();
    node.params = node.params || {};
    node.params.text = acc || "";
    node.params.done = 1;
  } catch (err) {
    if (myGen === rt.generation) _llmMarkError(node, rt, (err && err.message) || String(err));
  } finally {
    if (myGen === rt.generation) rt.streaming = false;
  }
}

async function _llmKickGenerate(node, rt) {
  rt.streaming = true;
  rt.generation++;
  const myGen = rt.generation;
  const body  = _llmEnsureBody(node, rt);
  if (body) body.clear();

  const prompt = _readTextWire(node, "prompt");
  const system = _readTextWire(node, "system");
  let   model  = _readTextWire(node, "model");
  if (!model && typeof aiSettings === "object") model = aiSettings.model || "llama3.2";

  const onToken = (tok) => {
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.append(tok);
  };

  try {
    const acc = await ollamaGenerate({
      baseUrl: aiSettings && aiSettings.ollamaUrl,
      model, prompt, system, onToken
    });
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.finalize();
    node.params = node.params || {};
    node.params.text = acc || "";
    node.params.done = 1;
  } catch (err) {
    if (myGen === rt.generation) _llmMarkError(node, rt, (err && err.message) || String(err));
  } finally {
    if (myGen === rt.generation) rt.streaming = false;
  }
}

async function _llmKickEmbed(node, rt) {
  rt.streaming = true;
  rt.generation++;
  const myGen = rt.generation;
  const body  = _llmEnsureBody(node, rt);
  if (body) body.clear();

  const text  = _readTextWire(node, "text") || _readTextWire(node, "input");
  let   model = _readTextWire(node, "model");
  if (!model) model = (node.params && node.params.model) || "nomic-embed-text";

  try {
    const res = await ollamaEmbed({
      baseUrl: aiSettings && aiSettings.ollamaUrl,
      model, input: text
    });
    if (myGen !== rt.generation) return;
    const first = (res && Array.isArray(res.embeddings) && res.embeddings[0]) || null;
    if (first) {
      // Stash the vector on params._vec; the output port reads from
      // there. We keep the shape metadata + a meta blob so downstream
      // consumers (Tektite MD / LLM-from-scratch) can identify the
      // provenance.
      node.params = node.params || {};
      node.params._vec = {
        data:  new Float32Array(first),
        shape: [first.length],
        dtype: "f32",
        meta:  { source: "ollama-embed", model }
      };
      node.params.dim = first.length;
      node.params.done = 1;
    }
    if (rt.body) {
      rt.body.append("embedded " + text.length + " chars → " +
        (first ? first.length : 0) + "-dim vector");
      rt.body.finalize();
    }
  } catch (err) {
    if (myGen === rt.generation) _llmMarkError(node, rt, (err && err.message) || String(err));
  } finally {
    if (myGen === rt.generation) rt.streaming = false;
  }
}

/* Per-frame tick. Walks every llm-sink node, detects trigger rising
 * edges, kicks off the appropriate Ollama call. Also clears the
 * `done` gate after a one-tick pulse so downstream `done` consumers
 * see the rising edge but not a stuck-high gate.
 *
 * Called from src/visual/render-loop.js's _visualRenderTick(). */
function _tickLLMRuntime(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  for (const n of state.nodes) {
    if (!n || !n.type) continue;
    const def = (typeof TYPES === "object") ? TYPES[n.type] : null;
    if (!def) continue;
    if (def.kind !== "llm-sink") continue;
    n.params = n.params || {};
    const rt = _llmGetState(n.id);

    // Detect rising edge -> kick fetch (only if not already streaming).
    if (_llmDetectTrigger(n, rt) && !rt.streaming) {
      // One-tick `done` pulses get cleared here so a re-trigger starts
      // clean. (Stale done from a prior run wouldn't actually break
      // anything, but it's tidier.)
      n.params.done = 0;
      if (n.type === "LLMChat")     _llmKickChat(n, rt);
      else if (n.type === "LLMGenerate") _llmKickGenerate(n, rt);
      else if (n.type === "LLMEmbed")    _llmKickEmbed(n, rt);
    } else if (n.params.done === 1) {
      // Clear the done pulse one tick after it was set, so a downstream
      // gate sees the rising edge exactly once.
      n.params.done = 0;
    }
  }
}
