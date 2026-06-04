/* =========================================================================
 * LLM runtime dispatcher
 *
 * Phase B sprints 4 + 6 of docs/LLM-KNOWLEDGE-PHASE.md §4. Drives all
 * LLM-side nodes that don't participate in C++ codegen:
 *
 *   llm-op nodes (cheap per-tick or pure passthrough):
 *     SystemPrompt        -- outputs `params.text` on its `text` port
 *     LLMModelPicker      -- outputs `params.model` on its `model` port
 *     ConversationMemory  -- rolling N-turn buffer, gate-driven appends
 *     EmbedSimilarity     -- cosine similarity of two vector wires
 *
 *   llm-sink nodes (gate-triggered async work + AbortController):
 *     LLMChat       -- /api/chat, streams to node body, writes `text`
 *     LLMGenerate   -- /api/generate, same shape as Chat
 *     LLMEmbed      -- /api/embed, writes embedding to `vec`
 *     LLMClassifier -- constrained one-of-N label pick
 *     JSONFormat    -- /api/chat with `format: "json"` + field extract
 *     VoiceToLLM    -- Web Speech API STT -> LLMChat
 *     LLMToTTS      -- SpeechSynthesis sink
 *
 * For llm-op nodes the dispatcher runs every frame -- ConversationMemory
 * watches its append/clear gates, EmbedSimilarity recomputes its scalar
 * from the two vector wires, the two pure-passthroughs are no-ops.
 *
 * For llm-sink nodes, _tickLLMRuntime() detects rising edges on each
 * sink's `trigger` / `speak` / `record` gate. On rise:
 *   1. Cancels any in-flight request via rt.aborter.abort()
 *   2. Creates a new AbortController -> rt.aborter, signal passed
 *      through to ollamaChat/Generate/Embed.
 *   3. Launches the async fetch; tokens stream into the node body via
 *      createTokenStreamBody (Phase A.2 primitive).
 *   4. On completion: writes the accumulated text/vector/label/value
 *      to the appropriate output param, pulses `done` for one tick.
 *   5. The node DOM may be rebuilt mid-stream (graph re-render); the
 *      runtime detects a stale `body.el` and re-creates the stream
 *      body on the new DOM node.
 *
 * Cancellation semantics (sprint B.6): a second rising edge while a
 * stream is in flight cancels the old request (rt.aborter.abort()) and
 * starts a new one. The old fetch's onToken callbacks drop because the
 * generation guard (myGen !== rt.generation) sees the bump. The same
 * applies to TTS -- a second `speak` while speaking cancels the
 * current utterance via speechSynthesis.cancel().
 * ======================================================================== */

/* Per-node runtime state. Keyed by node id. Stored here rather than on
 * the node object so a node restart (delete + re-add with same id) gets
 * a clean slate. */
const _llmRuntimeStates = new Map();

function _llmGetState(nodeId) {
  let s = _llmRuntimeStates.get(nodeId);
  if (!s) {
    s = {
      lastTrigger:    0,
      lastAppendUser: 0,
      lastAppendAsst: 0,
      lastClear:      0,
      lastSpeak:      0,
      lastRecord:     0,
      streaming:      false,
      aborter:        null,  // AbortController for the in-flight fetch
      body:           null,  // { el, append, finalize, clear, isStreaming }
      bodyNodeEl:     null,  // the .node DOM element that body was attached to
      generation:     0,     // bumped each kick; lets late onTokens drop
      recognizer:     null,  // SpeechRecognition instance (VoiceToLLM)
      utterance:      null   // SpeechSynthesisUtterance (LLMToTTS)
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

/* Read a `vector`-typed input on `node`. Vector data is stashed by
 * source nodes on `params._vec` (LLMEmbed publishes a Float32Array
 * there; other vector producers follow the same convention). Returns
 * the raw { data, shape, dtype } object, or null if not wired / no
 * vector available. */
function _readVectorWire(node, portName) {
  if (!node || typeof portName !== "string") return null;
  if (!state || !Array.isArray(state.edges)) return null;
  for (const e of state.edges) {
    if (e && e.to && e.to.node === node.id && e.to.port === portName) {
      const src = state.nodes.find(n => n && n.id === e.from.node);
      if (src && src.params && src.params._vec && src.params._vec.data) {
        return src.params._vec;
      }
    }
  }
  return null;
}

/* Detect a rising edge on a named gate input. Generalized from the
 * old _llmDetectTrigger so the new ConversationMemory + VoiceToLLM +
 * LLMToTTS nodes can reuse it. `lastKey` is the field on the rt state
 * object that stores the previous value (e.g. "lastTrigger",
 * "lastSpeak"). */
function _llmDetectGate(node, rt, portName, lastKey) {
  let v = 0;
  if (typeof _readWireJsSideValue === "function" && state && Array.isArray(state.edges)) {
    for (const e of state.edges) {
      if (e && e.to && e.to.node === node.id && e.to.port === portName) {
        const r = _readWireJsSideValue(e);
        if (typeof r === "number") { v = r; break; }
      }
    }
  }
  if (!v) {
    const local = node.params && node.params[portName];
    if (typeof local === "number") v = local;
  }
  const wasLow = (rt[lastKey] || 0) < 0.5;
  const isHigh = v >= 0.5;
  rt[lastKey] = v;
  return wasLow && isHigh;
}

/* Falling-edge detector. Same plumbing as rising, opposite direction.
 * Used by VoiceToLLM: a `record` falling edge ends the recognition
 * session and fires the LLM with the accumulated transcript. */
function _llmDetectFallingGate(node, rt, portName, lastKey) {
  let v = 0;
  if (typeof _readWireJsSideValue === "function" && state && Array.isArray(state.edges)) {
    for (const e of state.edges) {
      if (e && e.to && e.to.node === node.id && e.to.port === portName) {
        const r = _readWireJsSideValue(e);
        if (typeof r === "number") { v = r; break; }
      }
    }
  }
  if (!v) {
    const local = node.params && node.params[portName];
    if (typeof local === "number") v = local;
  }
  const wasHigh = (rt[lastKey] || 0) >= 0.5;
  const isLow   = v < 0.5;
  rt[lastKey] = v;
  return wasHigh && isLow;
}

/* Back-compat shim -- the sprint B.4 dispatcher called
 * _llmDetectTrigger(node, rt) for the trigger gate specifically. Keep
 * the old name for the existing LLMChat/Generate/Embed call sites. */
function _llmDetectTrigger(node, rt) {
  return _llmDetectGate(node, rt, "trigger", "lastTrigger");
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

/* Cancel any in-flight fetch on this node. Used both before starting a
 * new request (cancellation semantics) and when the node is removed.
 * AbortError surfaces through the catch in the kick functions and is
 * silently swallowed so the user doesn't see a red error flash for
 * an intentional cancel. */
function _llmAbortInFlight(rt) {
  if (rt && rt.aborter) {
    try { rt.aborter.abort(); } catch (_) {}
    rt.aborter = null;
  }
}

/* The async kicks. Each takes (node, runtimeState) and runs an Ollama
 * call until completion, then publishes the output. */

async function _llmKickChat(node, rt) {
  _llmAbortInFlight(rt);
  rt.aborter   = new AbortController();
  rt.streaming = true;
  rt.generation++;
  const myGen = rt.generation;
  const signal = rt.aborter.signal;
  const body   = _llmEnsureBody(node, rt);
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
      model, system, user, onToken, signal
    });
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.finalize();
    node.params = node.params || {};
    node.params.text = acc || "";
    node.params.done = 1;
  } catch (err) {
    if (myGen !== rt.generation) return;
    if (err && err.name === "AbortError") return;  // silent cancel
    _llmMarkError(node, rt, (err && err.message) || String(err));
  } finally {
    if (myGen === rt.generation) { rt.streaming = false; rt.aborter = null; }
  }
}

async function _llmKickGenerate(node, rt) {
  _llmAbortInFlight(rt);
  rt.aborter   = new AbortController();
  rt.streaming = true;
  rt.generation++;
  const myGen = rt.generation;
  const signal = rt.aborter.signal;
  const body   = _llmEnsureBody(node, rt);
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
      model, prompt, system, onToken, signal
    });
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.finalize();
    node.params = node.params || {};
    node.params.text = acc || "";
    node.params.done = 1;
  } catch (err) {
    if (myGen !== rt.generation) return;
    if (err && err.name === "AbortError") return;
    _llmMarkError(node, rt, (err && err.message) || String(err));
  } finally {
    if (myGen === rt.generation) { rt.streaming = false; rt.aborter = null; }
  }
}

async function _llmKickEmbed(node, rt) {
  _llmAbortInFlight(rt);
  rt.aborter   = new AbortController();
  rt.streaming = true;
  rt.generation++;
  const myGen = rt.generation;
  const signal = rt.aborter.signal;
  const body   = _llmEnsureBody(node, rt);
  if (body) body.clear();

  const text  = _readTextWire(node, "text") || _readTextWire(node, "input");
  let   model = _readTextWire(node, "model");
  if (!model) model = (node.params && node.params.model) || "nomic-embed-text";

  try {
    const res = await ollamaEmbed({
      baseUrl: aiSettings && aiSettings.ollamaUrl,
      model, input: text, signal
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
    if (myGen !== rt.generation) return;
    if (err && err.name === "AbortError") return;
    _llmMarkError(node, rt, (err && err.message) || String(err));
  } finally {
    if (myGen === rt.generation) { rt.streaming = false; rt.aborter = null; }
  }
}

/* Sprint B.6 -- constrained classifier. Builds a tight system prompt
 * that names the label set + forbids any other output. Capped at
 * num_predict=16 to avoid the model rambling. After the call, snaps
 * the response to the closest label by case-insensitive substring
 * match -- "Positive!" -> "positive", "neg" -> "negative". If nothing
 * matches, the raw model output goes through verbatim so the user can
 * see what went wrong. */
async function _llmKickClassifier(node, rt) {
  _llmAbortInFlight(rt);
  rt.aborter   = new AbortController();
  rt.streaming = true;
  rt.generation++;
  const myGen = rt.generation;
  const signal = rt.aborter.signal;
  const body   = _llmEnsureBody(node, rt);
  if (body) body.clear();

  const input  = _readTextWire(node, "input");
  const labels = _readTextWire(node, "labels") || "";
  const labelList = labels.split(",").map(s => s.trim()).filter(Boolean);
  let model  = _readTextWire(node, "model");
  if (!model && typeof aiSettings === "object") model = aiSettings.model || "llama3.2";

  if (!labelList.length) {
    _llmMarkError(node, rt, "no labels (set the labels input to a comma-separated list)");
    rt.streaming = false;
    rt.aborter   = null;
    return;
  }

  const system = "You are a classifier. Read the user message and reply with EXACTLY one of these labels and nothing else: " +
    labelList.join(" | ") + ". Use lowercase. No punctuation. No explanation.";
  const onToken = (tok) => {
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.append(tok);
  };

  try {
    const acc = await ollamaChat({
      baseUrl: aiSettings && aiSettings.ollamaUrl,
      model, system, user: input, onToken, signal,
      maxTokens: 16, temperature: 0.0
    });
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.finalize();
    // Snap to closest label (case-insensitive substring; pick the
    // first label that appears in the response).
    const lower = (acc || "").toLowerCase();
    let chosen = "";
    for (const lab of labelList) {
      if (lower.includes(lab.toLowerCase())) { chosen = lab; break; }
    }
    node.params = node.params || {};
    node.params.label = chosen || (acc || "").trim();
    node.params.done  = 1;
  } catch (err) {
    if (myGen !== rt.generation) return;
    if (err && err.name === "AbortError") return;
    _llmMarkError(node, rt, (err && err.message) || String(err));
  } finally {
    if (myGen === rt.generation) { rt.streaming = false; rt.aborter = null; }
  }
}

/* Sprint B.6 -- JSON-mode chat. Passes format: "json" to Ollama which
 * forces the model to emit syntactically-valid JSON. The schema input
 * goes into the system prompt as a hint (Ollama's JSON mode doesn't
 * enforce a schema -- it just guarantees valid JSON syntax -- so the
 * model still needs the schema to know what fields to produce). After
 * the response: tries to parse it, extracts the named field as text.
 * Both `value` and `raw` go on outputs so a downstream JSON tool can
 * grab additional fields without re-running the model. */
async function _llmKickJSONFormat(node, rt) {
  _llmAbortInFlight(rt);
  rt.aborter   = new AbortController();
  rt.streaming = true;
  rt.generation++;
  const myGen = rt.generation;
  const signal = rt.aborter.signal;
  const body   = _llmEnsureBody(node, rt);
  if (body) body.clear();

  const prompt = _readTextWire(node, "prompt");
  const schema = _readTextWire(node, "schema");
  const field  = _readTextWire(node, "field");
  let   model  = _readTextWire(node, "model");
  if (!model && typeof aiSettings === "object") model = aiSettings.model || "llama3.2";

  const system = "Respond with a single JSON object. " +
    (schema ? ("Schema: " + schema + ". ") : "") +
    "No prose, no markdown fences, just JSON.";

  const onToken = (tok) => {
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.append(tok);
  };

  try {
    const acc = await ollamaChat({
      baseUrl: aiSettings && aiSettings.ollamaUrl,
      model, system, user: prompt, onToken, signal,
      format: "json", temperature: 0.2
    });
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.finalize();
    node.params = node.params || {};
    node.params.raw = acc || "";
    let value = "";
    try {
      const obj = JSON.parse(acc || "{}");
      if (field && obj && Object.prototype.hasOwnProperty.call(obj, field)) {
        const v = obj[field];
        value = (typeof v === "string") ? v : JSON.stringify(v);
      } else {
        value = JSON.stringify(obj);
      }
    } catch (_) {
      // Model produced non-JSON despite format: "json". Surface raw
      // text so the user can see what it actually said.
      value = acc || "";
    }
    node.params.value = value;
    node.params.done  = 1;
  } catch (err) {
    if (myGen !== rt.generation) return;
    if (err && err.name === "AbortError") return;
    _llmMarkError(node, rt, (err && err.message) || String(err));
  } finally {
    if (myGen === rt.generation) { rt.streaming = false; rt.aborter = null; }
  }
}

/* Sprint B.6 -- LLMToTTS sink. Uses window.speechSynthesis. The
 * `voice` param does a case-insensitive substring match against
 * navigator's voice list (e.g. "Daniel", "Samantha"); empty falls
 * back to the system default. Pulses `done` when the utterance ends.
 *
 * Cancellation: a second `speak` rising edge cancels the previous
 * utterance via speechSynthesis.cancel() before starting fresh. */
function _llmKickTTS(node, rt) {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    _llmMarkError(node, rt, "SpeechSynthesis unavailable in this browser");
    return;
  }
  // Cancel any in-flight utterance from this node (or any node, really
  // -- speechSynthesis is a singleton).
  try { window.speechSynthesis.cancel(); } catch (_) {}
  rt.utterance = null;

  const text  = _readTextWire(node, "text");
  if (!text) {
    if (node.params) node.params.done = 1;
    return;
  }
  const rate  = _readNumOrParam(node, "rate", 1);
  const pitch = _readNumOrParam(node, "pitch", 1);
  const voiceHint = ((node.params && node.params.voice) || "").trim().toLowerCase();

  const utter = new SpeechSynthesisUtterance(text);
  utter.rate  = Math.max(0.1, Math.min(10, rate));
  utter.pitch = Math.max(0,   Math.min(2,  pitch));
  if (voiceHint) {
    const voices = window.speechSynthesis.getVoices();
    const match  = voices.find(v => v && v.name && v.name.toLowerCase().includes(voiceHint));
    if (match) utter.voice = match;
  }
  utter.onend = () => {
    if (node.params) node.params.done = 1;
    rt.utterance = null;
  };
  utter.onerror = () => {
    if (node.params) node.params.done = 1;
    rt.utterance = null;
  };

  const body = _llmEnsureBody(node, rt);
  if (body) { body.clear(); body.append("🔊 " + text.slice(0, 80)); body.finalize(); }

  rt.utterance = utter;
  window.speechSynthesis.speak(utter);
}

/* Sprint B.6 -- VoiceToLLM. Web Speech API recognition on rising
 * edge of `record`; final transcript fires an LLMChat on falling
 * edge (or on recognition.onend if the user stops speaking). The
 * userText output updates live as interim results arrive so the user
 * sees feedback while talking. */
function _llmStartVoice(node, rt) {
  const SR = (typeof window !== "undefined") &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) {
    _llmMarkError(node, rt, "SpeechRecognition unavailable (use Chrome or Edge)");
    return;
  }
  if (rt.recognizer) {
    try { rt.recognizer.abort(); } catch (_) {}
    rt.recognizer = null;
  }
  const rec = new SR();
  rec.continuous     = true;
  rec.interimResults = true;
  rec.lang           = "en-US";

  let finalTxt = "";
  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalTxt += r[0].transcript + " ";
      else           interim  += r[0].transcript;
    }
    node.params = node.params || {};
    node.params.userText = (finalTxt + interim).trim();
  };
  rec.onerror = (ev) => {
    _llmMarkError(node, rt, "speech: " + ((ev && ev.error) || "unknown"));
  };
  rec.onend = () => {
    rt.recognizer = null;
    const transcript = (node.params && node.params.userText || finalTxt || "").trim();
    if (transcript) _llmVoiceFireChat(node, rt, transcript);
  };

  const body = _llmEnsureBody(node, rt);
  if (body) { body.clear(); body.append("🎙 listening…"); }

  try { rec.start(); } catch (e) {
    _llmMarkError(node, rt, "recognizer.start: " + (e && e.message || e));
    return;
  }
  rt.recognizer = rec;
}

function _llmStopVoice(node, rt) {
  if (rt.recognizer) {
    try { rt.recognizer.stop(); } catch (_) {}
    // onend will fire and dispatch the chat
  }
}

async function _llmVoiceFireChat(node, rt, userText) {
  _llmAbortInFlight(rt);
  rt.aborter   = new AbortController();
  rt.streaming = true;
  rt.generation++;
  const myGen = rt.generation;
  const signal = rt.aborter.signal;
  const body   = _llmEnsureBody(node, rt);
  if (body) { body.clear(); body.append("→ " + userText + "\n\n"); }

  const system = _readTextWire(node, "system");
  let model    = _readTextWire(node, "model");
  if (!model && typeof aiSettings === "object") model = aiSettings.model || "llama3.2";

  const onToken = (tok) => {
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.append(tok);
  };

  try {
    const acc = await ollamaChat({
      baseUrl: aiSettings && aiSettings.ollamaUrl,
      model, system, user: userText, onToken, signal
    });
    if (myGen !== rt.generation) return;
    if (rt.body) rt.body.finalize();
    node.params = node.params || {};
    node.params.assistantText = acc || "";
    node.params.done = 1;
  } catch (err) {
    if (myGen !== rt.generation) return;
    if (err && err.name === "AbortError") return;
    _llmMarkError(node, rt, (err && err.message) || String(err));
  } finally {
    if (myGen === rt.generation) { rt.streaming = false; rt.aborter = null; }
  }
}

/* ---------- llm-op tickers (cheap, run every frame) ----------------- */

/* Reads a numeric input -- wired param wire OR local params value.
 * Mirrors the trigger pattern but returns a number instead of a bool.
 * Falls back to `def` on missing / non-numeric input. */
function _readNumOrParam(node, portName, def) {
  if (typeof _readWireJsSideValue === "function" && state && Array.isArray(state.edges)) {
    for (const e of state.edges) {
      if (e && e.to && e.to.node === node.id && e.to.port === portName) {
        const r = _readWireJsSideValue(e);
        if (typeof r === "number" && Number.isFinite(r)) return r;
      }
    }
  }
  const local = node.params && node.params[portName];
  return (typeof local === "number" && Number.isFinite(local)) ? local : def;
}

/* ConversationMemory tick. Watches three gates (appendUser,
 * appendAssistant, clear). On rising edges, mutates the persisted
 * history array. Then re-syncs the messages JSON + count outputs so
 * downstream LLMChat / .gpatch consumers see the new state. */
function _tickConversationMemory(node, rt) {
  node.params = node.params || {};
  if (!Array.isArray(node.params.history)) node.params.history = [];
  const maxTurns = Math.max(1, Math.floor(_readNumOrParam(node, "maxTurns", 10)));
  let mutated = false;

  if (_llmDetectGate(node, rt, "appendUser", "lastAppendUser")) {
    const msg = _readTextWire(node, "userMsg");
    if (msg) { node.params.history.push({ role: "user", content: msg }); mutated = true; }
  }
  if (_llmDetectGate(node, rt, "appendAssistant", "lastAppendAsst")) {
    const msg = _readTextWire(node, "assistantMsg");
    if (msg) { node.params.history.push({ role: "assistant", content: msg }); mutated = true; }
  }
  if (_llmDetectGate(node, rt, "clear", "lastClear")) {
    node.params.history = []; mutated = true;
  }
  // Trim oldest pairs (each turn = user + assistant = 2 messages).
  while (node.params.history.length > maxTurns * 2) {
    node.params.history.shift(); mutated = true;
  }
  if (mutated || node.params.messages === undefined) {
    node.params.messages = JSON.stringify(node.params.history);
    node.params.count    = node.params.history.length;
  }
}

/* EmbedSimilarity tick. Cosine similarity of two vector wires. Returns
 * 0 on mismatched lengths / missing inputs (rather than throwing) so
 * an unwired patch just shows 0 and the user can see why. */
function _tickEmbedSimilarity(node) {
  node.params = node.params || {};
  const a = _readVectorWire(node, "a");
  const b = _readVectorWire(node, "b");
  if (!a || !b || !a.data || !b.data || a.data.length !== b.data.length || a.data.length === 0) {
    node.params.similarity = 0;
    return;
  }
  let dot = 0, na = 0, nb = 0;
  const len = a.data.length;
  for (let i = 0; i < len; i++) {
    const x = a.data[i], y = b.data[i];
    dot += x * y;
    na  += x * x;
    nb  += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  node.params.similarity = (denom > 1e-12) ? (dot / denom) : 0;
}

/* Per-frame tick. Walks every LLM-runtime node, dispatches per kind.
 * Called from src/visual/render-loop.js's _visualRenderTick(). */
function _tickLLMRuntime(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  for (const n of state.nodes) {
    if (!n || !n.type) continue;
    const def = (typeof TYPES === "object") ? TYPES[n.type] : null;
    if (!def) continue;
    n.params = n.params || {};

    if (def.kind === "llm-op") {
      // Sprint B.6 -- ConversationMemory + EmbedSimilarity run per
      // tick. SystemPrompt + LLMModelPicker are pure passthroughs --
      // their output ports read params.text / params.model directly so
      // no per-frame work is needed.
      const rt = _llmGetState(n.id);
      if      (n.type === "ConversationMemory") _tickConversationMemory(n, rt);
      else if (n.type === "EmbedSimilarity")    _tickEmbedSimilarity(n);
      continue;
    }
    if (def.kind !== "llm-sink") continue;

    const rt = _llmGetState(n.id);

    // VoiceToLLM has its own start/stop on rising/falling edge of
    // `record` and dispatches the chat from inside the recognizer's
    // onend callback rather than here.
    if (n.type === "VoiceToLLM") {
      if (_llmDetectGate(n, rt, "record", "lastRecord")) _llmStartVoice(n, rt);
      if (_llmDetectFallingGate(n, rt, "record", "lastRecord_fall")) _llmStopVoice(n, rt);
      if (n.params.done === 1) n.params.done = 0;
      continue;
    }
    // LLMToTTS triggers on the `speak` gate, not `trigger`.
    if (n.type === "LLMToTTS") {
      if (_llmDetectGate(n, rt, "speak", "lastSpeak")) {
        n.params.done = 0;
        _llmKickTTS(n, rt);
      } else if (n.params.done === 1) {
        n.params.done = 0;
      }
      continue;
    }

    // Default sink path: trigger -> async fetch.
    if (_llmDetectTrigger(n, rt) && !rt.streaming) {
      n.params.done = 0;
      if      (n.type === "LLMChat")       _llmKickChat(n, rt);
      else if (n.type === "LLMGenerate")   _llmKickGenerate(n, rt);
      else if (n.type === "LLMEmbed")      _llmKickEmbed(n, rt);
      else if (n.type === "LLMClassifier") _llmKickClassifier(n, rt);
      else if (n.type === "JSONFormat")    _llmKickJSONFormat(n, rt);
    } else if (n.params.done === 1) {
      // Clear the done pulse one tick after it was set, so a downstream
      // gate sees the rising edge exactly once.
      n.params.done = 0;
    }
  }
}
