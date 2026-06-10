/* =========================================================================
 * Codegen
 *
 * Two node shapes drive code emission:
 *
 *   1. Member nodes (def.cppType non-empty)
 *      - Declared as a class member.
 *      - Emit ctor calls that initialize each param via def.methods[k].
 *      - Per-sample: if a param input has an incoming edge, emit a
 *        setter call BEFORE the sample is computed; otherwise the param
 *        is held at its ctor value.
 *      - Read expression is `id(audio_in_expr)` or `id()`.
 *
 *   2. Template nodes (def.cppType empty, def.template provided)
 *      - No declaration; the template is substituted inline.
 *      - {portName} → upstream expression for that port.
 *      - {paramName} → either the upstream expression (if connected)
 *        or the literal param value.
 *
 * Output / OutputStereo are special-cased to determine the operator()
 * return type and final return expression.
 * ======================================================================== */

/* signalInput finds the input port that should feed a node's operator()
 * sample-rate argument (i.e. id(in_expr) in generated C++). Audio is the
 * canonical signal type, but clock-typed inputs count too — a clock signal
 * is just a 0/1 sample-rate float, structurally identical to audio. Used
 * by computeBase + prepareSample so re-typing a sequencer's clock input
 * from "audio" to "clock" doesn't strip its operator() argument.
 *
 * If a node has both audio and clock inputs, audio wins (declared order
 * is irrelevant — audio is always the conventional signal arg). */
function signalInput(def) {
  if (!def || !def.ins) return null;
  // Nodes with `noSigArg: true` declare operator()() with no argument
  // — every audio input goes through a setter instead. PatchMatrix and
  // multi-input mixers use this so their 4–8 audio ins all become per-
  // sample setter calls, not arguments to one operator().
  if (def.noSigArg) return null;
  return def.ins.find(p => p.t === "audio") || def.ins.find(p => p.t === "clock") || null;
}

/* exprFor builds the C++ expression for one of a node's output ports.
 * For single-output nodes the srcPortName is irrelevant (the node has
 * one output and that's what's returned). For multi-output nodes
 * (Pan2, Hilbert, StateVariableFilter, ...) each output port is read
 * from the same call expression by appending the port's `access`
 * string — `[0]`, `.first`, `.real()`, etc.
 *
 * Multi-output nodes are ALWAYS bound to a local by prepareSample, so
 * by the time consumers call exprFor for them the cache holds the
 * bound name. Each consumer then gets `_<id><port.access>`. This is
 * what makes one-call-per-sample correct even when a Pan2 feeds both
 * channels of OutputStereo.
 *
 * cgCtx fields:
 *   cache    — nodeId → base expression (or bound name like "_n3")
 *   visiting — nodeId → true while in-flight (cycle safety; real cycle
 *              detection runs separately and rejects upstream)
 *   fanout   — nodeId → outgoing edge count
 */
function portAccess(def, srcPortName) {
  if (!def || !def.outs || def.outs.length <= 1) return "";
  const port = def.outs.find(p => p.n === srcPortName);
  return (port && port.access) || "";
}

function exprFor(nodeId, srcPortName, cgCtx) {
  const { cache, visiting } = cgCtx;
  const node = nodeById(nodeId);
  if (!node) return "0.f /* missing node */";
  const def = defOf(node);
  if (!def) return `0.f /* unknown type: ${node.type} */`;

  // Delay1 short-circuit: output is the value cached at the top of
  // operator() from last sample's stored state. Don't recurse into the
  // input — write-back is emitted separately by generateCode.
  if (def.kind === "delay1") return `${nodeId}_out`;

  let base;
  if (cache[nodeId] !== undefined) {
    base = cache[nodeId];
  } else if (visiting[nodeId]) {
    return "0.f /* CYCLE without Delay1 */";
  } else {
    visiting[nodeId] = true;
    base = computeBase(node, def, cgCtx);
    cache[nodeId] = base;
    visiting[nodeId] = false;
  }
  return base + portAccess(def, srcPortName);
}

function computeBase(node, def, cgCtx) {
  if (def.template) {
    const ctx = {};
    def.ins.forEach(p => {
      const e = state.edges.find(ed => ed.to.node === node.id && ed.to.port === p.n);
      if (e) {
        ctx[p.n] = exprFor(e.from.node, e.from.port, cgCtx);
      } else if (node.params[p.n] !== undefined) {
        ctx[p.n] = fmt(node.params[p.n]);
      } else {
        ctx[p.n] = "0.f";
      }
    });
    Object.keys(node.params).forEach(k => {
      if (ctx[k] === undefined) ctx[k] = fmt(node.params[k]);
    });
    return def.template.replace(/\{(\w+)\}/g, (m, k) => {
      return ctx[k] !== undefined ? "(" + ctx[k] + ")" : m;
    });
  } else if (def.cppType) {
    const sigIn = signalInput(def);
    if (sigIn) {
      const e = state.edges.find(ed => ed.to.node === node.id && ed.to.port === sigIn.n);
      const inExpr = e ? exprFor(e.from.node, e.from.port, cgCtx) : "0.f";
      return `${node.id}(${inExpr})`;
    }
    return `${node.id}()`;
  } else {
    const sigIn = signalInput(def);
    if (sigIn) {
      const e = state.edges.find(ed => ed.to.node === node.id && ed.to.port === sigIn.n);
      return e ? exprFor(e.from.node, e.from.port, cgCtx) : "0.f";
    }
    return "0.f";
  }
}

/* Topological walker that emits per-sample setter calls (param hoists)
 * and fan-out binds in dependency order, with each member node's hoist
 * lines emitted BEFORE its own bind. Returns an array of statement
 * strings in the order they should appear inside operator().
 *
 * Why a separate walker: a node M whose fan-out is bound (auto _M = M(...))
 * must be called AFTER any per-sample setter that targets M (e.g.
 * M.freq(...)), or the setter applies one sample late. Doing this in
 * exprFor itself would interleave wrong because exprFor recursion
 * unwinds bottom-up but hoists for an upper node need to appear right
 * before that upper node's bind. */
function prepareSample(cgCtx) {
  const lines = [];
  const placed = new Set();

  function visit(nodeId) {
    if (placed.has(nodeId)) return;
    placed.add(nodeId);
    const node = nodeById(nodeId);
    if (!node) return;
    const def = defOf(node);
    if (!def) return;

    // Don't recurse through a Delay1 — its input is a feedback closure
    // emitted at the bottom of operator() by generateCode.
    if (def.kind === "delay1") return;

    // Phase A.1 — runtime-only LLM / notes nodes (kind: "llm-op",
    // "llm-sink", "llm-viz", "notes-source") don't participate in the
    // audio codegen path. Their port types live in VISUAL_PORT_TYPES
    // ("vector", "llm-attn", "texture"), so they shouldn't appear here
    // anyway — but skip defensively in case a future codegen change
    // wires them in. See docs/LLM-KNOWLEDGE-PHASE.md §3.A.1.
    if (isRuntimeOnlyKind(def.kind)) return;

    // Walk dependencies first so deeper binds (and their hoists) appear
    // earlier in the statement list.
    def.ins.forEach(p => {
      const e = state.edges.find(ed => ed.to.node === nodeId && ed.to.port === p.n);
      if (e) visit(e.from.node);
    });

    if (!def.cppType) return;  // template / pass-through nodes have no per-sample call

    // Param hoists for this node: emit any setter calls whose source is
    // an incoming edge. Use exprFor to substitute already-bound names.
    def.ins.forEach(p => {
      if (p.t !== "param") return;
      const e = state.edges.find(ed => ed.to.node === nodeId && ed.to.port === p.n);
      if (!e) return;
      const upstream = exprFor(e.from.node, e.from.port, cgCtx);
      const m = (def.methods && def.methods[p.n]) || p.n;
      lines.push(`        ${nodeId}.${m}(${upstream});`);
    });

    // Gate-input wires: when an upstream audio-rate signal reaches a
    // gate input, fire the gate method whenever the signal exceeds 0.5.
    // Lets KeyboardIn.gate (a one-sample pulse) wire into AD.trig
    // (Schmitt-trigger semantics, fires once per pulse).
    def.ins.forEach(p => {
      if (p.t !== "gate") return;
      const e = state.edges.find(ed => ed.to.node === nodeId && ed.to.port === p.n);
      if (!e) return;
      const upstream = exprFor(e.from.node, e.from.port, cgCtx);
      const meth = (def.gateMethods && def.gateMethods[p.n]) || "reset";
      // gateMethods value can be a bare method name ("reset") or a
      // method+args literal ("phase(0.f)"). The latter lets oscillators
      // declare e.g. trig: "phase(0.f)" without needing a wrapper class.
      const callExpr = meth.indexOf("(") >= 0 ? `${nodeId}.${meth}` : `${nodeId}.${meth}()`;
      lines.push(`        if ((${upstream}) > 0.5f) ${callExpr};`);
    });

    // Audio-input setter codegen — for nodes with MORE THAN ONE audio
    // input. The first audio (or clock) input is the operator() arg
    // via signalInput(); any additional audio inputs that have a
    // methods entry get a per-sample setter call instead. Backwards
    // compatible: every existing node has at most one audio in, so
    // this loop emits nothing for them. PatchMatrix / AudioBus /
    // MasterMix use this pattern (with noSigArg: true so EVERY audio
    // input becomes a setter — operator() takes no arg).
    const sigInForSetters = signalInput(def);
    def.ins.forEach(p => {
      if (p.t !== "audio") return;
      if (sigInForSetters && sigInForSetters.n === p.n) return;
      if (!def.methods || !def.methods[p.n]) return;
      const e = state.edges.find(ed => ed.to.node === nodeId && ed.to.port === p.n);
      if (!e) return;
      const upstream = exprFor(e.from.node, e.from.port, cgCtx);
      const m = def.methods[p.n];
      lines.push(`        ${nodeId}.${m}(${upstream});`);
    });

    // Bind to a local when:
    //   (a) the output fans out to >1 downstream port, OR
    //   (b) the node has multi-output (>1 outs entry) — every consumer
    //       indexes into the same call result, so we MUST evaluate it
    //       once and share the local.
    const multiOut = def.outs && def.outs.length > 1;
    if (cgCtx.fanout[nodeId] > 1 || multiOut) {
      const sigIn = signalInput(def);
      let inExpr = "0.f";
      if (sigIn) {
        const e = state.edges.find(ed => ed.to.node === nodeId && ed.to.port === sigIn.n);
        if (e) inExpr = exprFor(e.from.node, e.from.port, cgCtx);
      }
      const callExpr = sigIn ? `${nodeId}(${inExpr})` : `${nodeId}()`;
      cgCtx.cache[nodeId] = `_${nodeId}`;
      lines.push(`        auto _${nodeId} = ${callExpr};`);
    }
  }

  // Roots: the Output/OutputStereo sink, plus every Delay1 input (so its
  // upstream chain is fully prepared before the write-back is computed).
  const out = state.nodes.find(n => n.type === "Output" || n.type === "OutputStereo");
  if (out) {
    const def = defOf(out);
    if (def) def.ins.forEach(p => {
      const e = state.edges.find(ed => ed.to.node === out.id && ed.to.port === p.n);
      if (e) visit(e.from.node);
    });
  }
  state.nodes.forEach(n => {
    const def = defOf(n);
    if (!def || def.kind !== "delay1") return;
    const e = state.edges.find(ed => ed.to.node === n.id && ed.to.port === "in");
    if (e) visit(e.from.node);
  });

  return lines;
}

/* Pre-pass: count outgoing edges per node. Used by exprFor to decide
 * whether to bind a member node's output to a local. */
function computeFanout() {
  const counts = {};
  state.edges.forEach(e => {
    counts[e.from.node] = (counts[e.from.node] || 0) + 1;
  });
  return counts;
}

/* Tarjan SCC: returns the set of node IDs that participate in a cycle
 * which does NOT pass through any Delay1 node. These are invalid patches
 * (Gamma is sample-by-sample; feedback requires a one-sample delay to
 * break the loop). The validation overlay highlights these; codegen
 * refuses to emit a class for them. */
function findInvalidCycles() {
  const adj = {};
  state.nodes.forEach(n => { adj[n.id] = []; });
  state.edges.forEach(e => {
    // Skip edges to "show" ports — visibility gates don't propagate
    // data and shouldn't participate in cycle detection.
    if (e.to && e.to.port === "show") return;
    // Skip edges to "world" ports — physics membership wires.
    if (e.to && e.to.port === "world") return;
    if (adj[e.from.node]) adj[e.from.node].push(e.to.node);
  });

  const indices = {};
  const lowlinks = {};
  const onStack = {};
  const stack = [];
  let index = 0;
  const sccs = [];

  function strongconnect(v) {
    indices[v] = index;
    lowlinks[v] = index;
    index++;
    stack.push(v);
    onStack[v] = true;

    (adj[v] || []).forEach(w => {
      if (indices[w] === undefined) {
        strongconnect(w);
        lowlinks[v] = Math.min(lowlinks[v], lowlinks[w]);
      } else if (onStack[w]) {
        lowlinks[v] = Math.min(lowlinks[v], indices[w]);
      }
    });

    if (lowlinks[v] === indices[v]) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack[w] = false;
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  state.nodes.forEach(n => {
    if (indices[n.id] === undefined) strongconnect(n.id);
  });

  const invalid = new Set();
  sccs.forEach(scc => {
    const isCycle = scc.length > 1 || (adj[scc[0]] || []).includes(scc[0]);
    if (!isCycle) return;
    const hasDelay1 = scc.some(id => {
      const node = nodeById(id);
      const def = node && defOf(node);
      return def && def.kind === "delay1";
    });
    if (!hasDelay1) scc.forEach(id => invalid.add(id));
  });

  return invalid;
}

function fmt(v) {
  if (typeof v !== "number" || !isFinite(v)) {
    // Strings (enum values) and other non-numerics fall through to fmtParam;
    // bare fmt() should never receive them. If it does, emit 0.f as a safe
    // fallback so generated code at least compiles.
    if (typeof v === "string") return "0.f /* fmt got string '" + v + "' — missing fmtParam path? */";
    return "0.f";
  }
  const s = String(v);
  if (s.indexOf(".") >= 0 || s.indexOf("e") >= 0) return s + "f";
  return s + ".f";
}

/* fmtParam handles enum-typed params (Phase 3.6). When def.enumMap[k][v]
 * exists, emits the mapped C++ symbol (e.g. "gam::LOW_PASS") instead of
 * a numeric literal. Otherwise falls through to fmt() for normal floats. */
function fmtParam(def, k, v) {
  if (def && def.enumMap && def.enumMap[k] && def.enumMap[k][v] !== undefined) {
    return def.enumMap[k][v];
  }
  return fmt(v);
}

function inputExpr(nodeId, portName, cgCtx) {
  const e = state.edges.find(ed => ed.to.node === nodeId && ed.to.port === portName);
  if (!e) return "0.f";
  return exprFor(e.from.node, e.from.port, cgCtx);
}

function gatherHeaders() {
  const gammaHeaders = new Set();
  const stdHeaders = new Set();
  // Free-form #include lines from User DSP @gdsp-header directives.
  // Stored as the literal string that follows `#include `, including
  // the brackets or quotes — so we never duplicate them.
  const extraIncludes = new Set();
  let needsScl = false;
  const STDLIB = new Set(["cmath", "cstdint", "utility", "cstdlib", "algorithm", "cstring"]);
  state.nodes.forEach(n => {
    const def = defOf(n);
    if (!def) return;
    if (def.header) {
      if (STDLIB.has(def.header)) stdHeaders.add(def.header);
      else if (def.header === "scl") needsScl = true;
      else gammaHeaders.add(def.header);
    }
    if (def.template && def.template.indexOf("gam::scl::") >= 0) needsScl = true;
    // Detect stdlib usage in templates — both C++ std::xxx and C-style xxxf
    if (def.template) {
      if (/\b(sinf|cosf|tanf|asinf|acosf|atanf|sinhf|coshf|tanhf|expf|exp2f|logf|log2f|log10f|sqrtf|cbrtf|floorf|ceilf|roundf|truncf|fmodf|fabsf|fminf|fmaxf|hypotf|powf|atan2f)\b/.test(def.template)) {
        stdHeaders.add("cmath");
      }
      if (/std::(sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|exp|exp2|log|log2|log10|sqrt|cbrt|floor|ceil|round|trunc|fmod|fabs|fmin|fmax|hypot|pow|atan2)\b/.test(def.template)) {
        stdHeaders.add("cmath");
      }
    }
    // User DSP nodes may declare extra includes they need beyond what
    // the editor figures out from registry headers.
    if (def.extraHeaders && def.extraHeaders.length) {
      def.extraHeaders.forEach(h => {
        if (!h) return;
        let inc;
        if (h[0] === "<" || h[0] === '"') inc = h;
        else inc = "<" + h + ">";
        extraIncludes.add(inc);
      });
    }
  });
  if (needsScl) gammaHeaders.add("scl");
  // Domain is always needed — the preview wrapper calls
  // gam::sampleRate() in preview_init / preview_set_sr to keep all
  // Gamma units in sync with the AudioContext sample rate.
  gammaHeaders.add("Domain");
  return {
    gamma: Array.from(gammaHeaders).sort(),
    std:   Array.from(stdHeaders).sort(),
    extra: Array.from(extraIncludes).sort()
  };
}

/* Phase C §7.4 -- render a node's attached Tektite note (snapshotted into
 * node.params.tektiteNote* by the node-note-attach UI) as a Doxygen-style
 * doc comment, indented to sit directly above the node's member
 * declaration. Returns "" when nothing is attached. Any literal "*​/" in the
 * note is defanged so a stray sequence can't close the comment early, and
 * CRLF is normalized so the emitted .h stays clean. */
function _nodeNoteDocComment(node, indent) {
  if (!node || !node.params || !node.params.tektiteNoteId) return "";
  const pad = (typeof indent === "string") ? indent : "    ";
  const safe = (s) => String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/\*\//g, "* /");
  const title = safe(node.params.tektiteNoteTitle || node.params.tektiteNoteId).split("\n")[0];
  let bodyLines = safe(node.params.tektiteNoteBody).replace(/\n+$/, "").split("\n");
  // Drop a leading markdown H1 that just repeats the title (avoids dupes).
  if (bodyLines.length && /^#\s+/.test(bodyLines[0]) &&
      bodyLines[0].replace(/^#\s+/, "").trim() === title.trim()) {
    bodyLines = bodyLines.slice(1);
    while (bodyLines.length && bodyLines[0].trim() === "") bodyLines = bodyLines.slice(1);
  }
  // "".split("\n") produces [""] — treat a single empty/whitespace-only
  // element as no body so the separator pair isn't emitted for blank notes.
  if (bodyLines.length === 1 && bodyLines[0].trim() === "") bodyLines = [];
  const lines = [pad + "/**", pad + " * " + title];
  if (bodyLines.length) {
    lines.push(pad + " *");
    for (const ln of bodyLines) lines.push((pad + " * " + ln).replace(/\s+$/, ""));
  }
  lines.push(pad + " *");
  lines.push(pad + " * @note Documented in Tektite MD · note id: " +
    safe(node.params.tektiteNoteId).split("\n")[0]);
  lines.push(pad + " */");
  return lines.join("\n");
}

function generateCode() {
  // Validation: refuse to emit code for patches with cycles that don't
  // pass through a Delay1 — they can't be expressed in a per-sample
  // operator() and would silently produce garbage if we tried.
  const invalidCycleNodes = findInvalidCycles();
  if (invalidCycleNodes.size > 0) {
    const ids = Array.from(invalidCycleNodes).join(", ");
    return "// ❌ Build error: feedback cycle without a Delay1 node.\n"
         + "//    Affected nodes: " + ids + "\n"
         + "//\n"
         + "// Gamma is sample-by-sample DSP, so feedback loops must include\n"
         + "// at least one Delay1 (one-sample delay) to break the cycle.\n"
         + "// Add a Delay1 anywhere along the loop and re-wire through it.\n";
  }

  const decls = [];
  const ctorBody = [];
  const setters = [];
  const used = new Set();
  const warnings = [];

  // Delay1 nodes get an explicit float-state member rather than the
  // regular gam:: member-node treatment. Track them so the operator()
  // body can emit reads at the top and writes before the return.
  const delay1Nodes = [];

  state.nodes.forEach(n => {
    const def = defOf(n);
    if (!def) {
      warnings.push(`    // WARNING: unknown node type '${n.type}' (id ${n.id}) — emitted as 0.f`);
      return;
    }
    if (def.kind === "delay1") {
      decls.push(`    float ${n.id}_z = 0.f;  // Delay1 state`);
      delay1Nodes.push(n);
      return;
    }
    // Phase A.1 — runtime-only LLM / notes nodes don't emit any C++.
    // They persist in `.gpatch` as runtime state but contribute nothing
    // to the generated `.h`. See docs/LLM-KNOWLEDGE-PHASE.md §3.A.1.
    if (isRuntimeOnlyKind(def.kind)) return;
    if (def.cppType) {
      // Phase C §7.4 -- emit any attached Tektite note as a doc comment
      // above the member, so generated C++ carries the author's reasoning.
      const _doc = _nodeNoteDocComment(n, "    ");
      if (_doc) decls.push(_doc);
      decls.push(`    ${def.cppType} ${n.id};`);
    }
    if (def.extraCtor) {
      // extraCtor entries can be either:
      //  - a static template string with {id} substitution (existing
      //    pattern; pushed with 8-space indent)
      //  - a function (node) => string that returns its own already-
      //    indented C++ (used when the emitted code depends on the
      //    node's per-instance params, e.g. Ramp's custom curveTable)
      def.extraCtor.forEach(t => {
        if (typeof t === "function") {
          const line = t(n);
          if (line) ctorBody.push(line);
        } else {
          ctorBody.push(`        ${t.replace(/\{id\}/g, n.id)}`);
        }
      });
    }

    const uiOnly = def.uiOnlyParams || [];
    if (def.cppType && def.methods) {
      Object.keys(node_methods(def)).forEach(k => {
        if (uiOnly.includes(k)) return;     // ui-only params (Slider min/max, Button label) never reach the C++ side
        if (node_methods(def)[k] && n.params[k] !== undefined) {
          const m = node_methods(def)[k];
          ctorBody.push(`        ${n.id}.${m}(${fmtParam(def, k, n.params[k])});`);
        }
      });
    }

    const auto = def.autoExpose || [];
    Object.keys(n.params).forEach(k => {
      if (uiOnly.includes(k)) return;
      if (!state.exposed[n.id + "." + k] && !auto.includes(k)) return;
      if (!def.cppType) return;
      // Enum params can't be exposed as float setters — they take a
      // distinct C++ enum/symbol type at construction time only.
      if (def.paramOptions && def.paramOptions[k]) return;
      const m = (def.methods && def.methods[k]) || k;
      let name = k;
      if (used.has(name)) name = n.id + "_" + k;
      used.add(name);
      setters.push(`    void ${name}(float v) { ${n.id}.${m}(v); }`);
    });

    // Helper: gateMethods value can be "reset" or "phase(0.f)" — the
    // latter lets a node declare a method-with-args setter without
    // shipping a wrapper class.
    const gateCall = (id, meth) =>
      meth.indexOf("(") >= 0 ? `${id}.${meth}` : `${id}.${meth}()`;
    def.ins.forEach(p => {
      if (p.t !== "gate") return;
      if (!state.exposed[n.id + "." + p.n] && !auto.includes(p.n)) return;
      const meth = (def.gateMethods && def.gateMethods[p.n]) || "reset";
      let name = p.n === "trig" ? "trigger" : p.n;
      if (used.has(name)) name = name + "_" + n.id;
      used.add(name);
      setters.push(`    void ${name}() { ${gateCall(n.id, meth)}; }`);
    });

    // Host-fired gates (no visible input port). Always exposed —
    // they exist solely so the JS keydown handler can drive them.
    (def.hostGates || []).forEach(gn => {
      const meth = (def.gateMethods && def.gateMethods[gn]) || "reset";
      let name = gn === "trig" ? "trigger" : gn;
      if (used.has(name)) name = name + "_" + n.id;
      used.add(name);
      setters.push(`    void ${name}() { ${gateCall(n.id, meth)}; }`);
    });
  });

  // MicInput fan-out — if the patch has any MicInput nodes, emit a
  // single `setMicInput(float v)` method on the patch class that
  // forwards to every MicInput's setIn(). The wrapper's tick loop
  // calls this once per sample with the worklet's mic buffer value
  // before invoking operator(). Missing in offline export (it's a
  // preview-only path) but harmless — the method just sits unused.
  const micNodes = state.nodes.filter(n => n.type === "MicInput");
  if (micNodes.length) {
    const calls = micNodes.map(n => `${n.id}.setIn(v);`).join(" ");
    setters.push(`    void setMicInput(float v) { ${calls} }`);
  }

  // v0.3.19 — VideoSrc per-source setters. For each VideoFile / Webcam
  // node that has outgoing wires from outL or outR, emit one pair of
  // setter methods (setVidL_N, setVidR_N) that route the worklet's
  // input-1 channel data into the per-instance GammaVideoSrc member.
  // Index N agrees with the JS-side _videoAudioSrcNodes() ordering;
  // the wrapper's tick loop emits the matching per-sample dispatch.
  const vidSrcNodes = (typeof _videoAudioSrcNodes === "function") ? _videoAudioSrcNodes() : [];
  vidSrcNodes.forEach((n, idx) => {
    setters.push(`    void setVidL_${idx}(float v) { ${n.id}.setL(v); }`);
    setters.push(`    void setVidR_${idx}(float v) { ${n.id}.setR(v); }`);
  });

  // Codegen context shared by every exprFor call in this build pass.
  const cgCtx = {
    cache: {},
    visiting: {},
    fanout: computeFanout()
  };

  // Pre-seed cache: Delay1 outputs are already-named locals (id_out)
  // emitted at the top of operator(). Any consumer that recurses into a
  // Delay1 hits this cache hit and uses the local without recursing
  // through the Delay1's input (the cycle breaker).
  delay1Nodes.forEach(n => { cgCtx.cache[n.id] = `${n.id}_out`; });

  // Topological walk: emits param hoists and fan-out binds in correct
  // dependency order, with each member node's hoist before its bind.
  const sampleBody = prepareSample(cgCtx);

  // Final return expression. exprFor uses cache for already-bound nodes,
  // inlines for everything else.
  const out = state.nodes.find(n => n.type === "Output" || n.type === "OutputStereo");
  let outputExpr = "0.f";
  let returnType = "float";
  if (out && out.type === "Output") {
    outputExpr = inputExpr(out.id, "L", cgCtx);
  } else if (out && out.type === "OutputStereo") {
    const lExpr = inputExpr(out.id, "L", cgCtx);
    const rExpr = inputExpr(out.id, "R", cgCtx);
    outputExpr = `std::make_pair(${lExpr}, ${rExpr})`;
    returnType = "std::pair<float,float>";
  }

  // Delay1 write-backs: compute each Delay1's input expression after
  // everything else is in place, then assign to the stored state. The
  // write happens before the return so this sample's state reflects
  // the value flowing through the cycle.
  const delay1Writes = [];
  delay1Nodes.forEach(n => {
    const e = state.edges.find(ed => ed.to.node === n.id && ed.to.port === "in");
    const inExpr = e ? exprFor(e.from.node, e.from.port, cgCtx) : "0.f";
    delay1Writes.push(`        ${n.id}_z = ${inExpr};`);
  });

  // Delay1 reads at the very top of operator().
  const delay1Reads = delay1Nodes.map(n => `        float ${n.id}_out = ${n.id}_z;`);

  const headers = gatherHeaders();
  const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");

  // Find user DSP types referenced by this patch
  const userTypes = [];
  const seen = new Set();
  state.nodes.forEach(n => {
    const def = TYPES[n.type];
    if (def && def.isUserDsp && !seen.has(n.type)) {
      seen.add(n.type);
      userTypes.push(n.type);
    }
  });

  // Built-in helper classes from registry entries (Phase 3.5).
  // Multi-output filters like StateVariableFilter ship their full C++
  // class string in `def.helperClass`; codegen emits it once before
  // the patch class. Deduped by class-name extracted from the source.
  const helperClasses = [];
  const helperSeen = new Set();
  state.nodes.forEach(n => {
    const def = defOf(n);
    if (!def || !def.helperClass) return;
    const m = def.helperClass.match(/class\s+(\w+)/);
    if (!m || helperSeen.has(m[1])) return;
    helperSeen.add(m[1]);
    helperClasses.push(def.helperClass);
  });

  let code = "";
  code += "#pragma once\n";
  // Deliberately NOT emitting #include <Gamma/Gamma.h>. That umbrella
  // header transitively pulls every Gamma module (DFT, FFT, AudioIO,
  // all of them), which makes in-browser clang grind >5 min parsing
  // and instantiating templates the patch doesn't actually need. The
  // per-node-specific includes below cover what the patch references.
  headers.gamma.forEach(h => {
    if (h === "scl") code += "#include <Gamma/scl.h>\n";
    else code += `#include <Gamma/${h}.h>\n`;
  });
  headers.std.forEach(h => {
    code += `#include <${h}>\n`;
  });
  if (returnType === "std::pair<float,float>" && !headers.std.includes("utility")) {
    code += "#include <utility>\n";
  }
  if (headers.extra && headers.extra.length) {
    headers.extra.forEach(inc => { code += `#include ${inc}\n`; });
  }
  code += "\n";
  if (helperClasses.length) {
    code += "// ---- Built-in helper classes ----\n\n";
    helperClasses.forEach(c => { code += c + "\n\n"; });
  }
  if (userTypes.length) {
    code += "// ---- User DSP ----\n\n";
    userTypes.forEach(name => {
      code += stripGdspHeader(USER_DSP_SOURCES[name]) + "\n\n";
    });
  }
  if (helperClasses.length || userTypes.length) {
    code += "// ---- Patch ----\n";
  }
  if (warnings.length) {
    code += warnings.join("\n") + "\n";
  }
  code += `class ${className} {\n`;
  if (decls.length) code += decls.join("\n") + "\n";
  code += "public:\n";
  code += `    ${className}() {\n`;
  if (ctorBody.length) code += ctorBody.join("\n") + "\n";
  code += "    }\n";
  if (setters.length) code += "\n" + setters.join("\n") + "\n";
  code += `\n    ${returnType} operator()() {\n`;
  // Body order: Delay1 reads → topological hoists+binds → Delay1 writes → return
  if (delay1Reads.length) code += delay1Reads.join("\n") + "\n";
  if (sampleBody.length)  code += sampleBody.join("\n") + "\n";
  if (delay1Writes.length) code += delay1Writes.join("\n") + "\n";
  code += "        return " + outputExpr + ";\n";
  code += "    }\n";
  code += "};\n";
  return code;
}

function node_methods(def) {
  const m = Object.assign({}, def.methods || {});
  Object.keys(def.params || {}).forEach(k => { if (!(k in m)) m[k] = k; });
  return m;
}