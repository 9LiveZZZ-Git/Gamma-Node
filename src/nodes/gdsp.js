/* =========================================================================
 * User DSP — custom node types defined by .gdsp source
 *
 * USER_DSP_SOURCES[typeName] holds the verbatim class source. Codegen
 * emits each used user class above the patch class. Types registered here
 * are also installed into TYPES so they behave identically to built-ins
 * for palette, drag, connect, properties pane.
 * ======================================================================== */
const USER_DSP_SOURCES = {};
const USER_DSP_META = {};   // typeName -> { color, category, description, ... }

function parseGdsp(source) {
  const meta = { directives: {} };
  const lines = source.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*\/\/\s*@gdsp-(\S+)\s+(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === "input" || key === "output" || key === "method" || key === "gate" || key === "header") {
      if (!meta.directives[key]) meta.directives[key] = [];
      meta.directives[key].push(val);
    } else {
      meta.directives[key] = val;
    }
  }
  return meta;
}

function buildUserDspDef(source) {
  const { directives: d } = parseGdsp(source);
  if (!d.name) throw new Error("Missing @gdsp-name");
  if (!d.output) throw new Error("Missing @gdsp-output (need at least one)");

  // Phase 6.2.2 — shader-frag .gdsp kind. Branches BEFORE the C++ class
  // checks below since the body is WGSL, not C++. Hot-reload comes for
  // free: registerUserDsp updates TYPES[name].wgsl, the pipeline cache
  // hashes content (so editing the body is a cache miss), and the
  // per-instance pipelineEntry tracker keeps the old pipeline rendering
  // until the new one finishes async-compiling.
  if (d.kind === "shader-frag") {
    if (!Array.isArray(d.output) || d.output.length !== 1) {
      throw new Error("@gdsp-kind shader-frag requires exactly one @gdsp-output");
    }
    const outDecl = d.output[0].trim().split(/\s+/);
    if (outDecl[1] !== "texture") {
      throw new Error('@gdsp-kind shader-frag output must be type "texture" (got "' + outDecl[1] + '")');
    }
    // Light WGSL syntax check — the editor's standard pipeline expects
    // both vs_main and fs_main entry points. WebGPU validation will
    // catch deeper errors at compile time.
    if (!/@vertex/.test(source))         throw new Error("WGSL body missing @vertex entry point");
    if (!/@fragment/.test(source))       throw new Error("WGSL body missing @fragment entry point");
    if (!/fn\s+vs_main\s*\(/.test(source))  throw new Error('WGSL body must define "fn vs_main(...)"');
    if (!/fn\s+fs_main\s*\(/.test(source))  throw new Error('WGSL body must define "fn fs_main(...)"');

    const def = {
      category:    d.category || "Visual",
      color:       d.color || COLOR.visual,
      header:      null,
      description: d.description || "",
      cppType:     "",                  // no audio codegen
      kind:        "shader-frag",
      ins:         [],
      outs:        [{ n: outDecl[0], t: "texture" }],
      params:      {},
      methods:     {},
      isUserDsp:   true,
      wgsl:        source
    };

    // Collect params from @gdsp-input. Only "param" allowed today;
    // texture inputs (for composition shaders) ship in 6.4.x with their
    // own bind-group layout.
    const paramOrder = [];
    if (Array.isArray(d.input)) {
      for (const s of d.input) {
        const parts = s.trim().split(/\s+/);
        const [pname, ptype, pdefault] = parts;
        if (!pname || !ptype) throw new Error(`Bad @gdsp-input: ${s}`);
        if (ptype !== "param") {
          throw new Error(`shader-frag @gdsp-input ${pname}: only "param" supported (got "${ptype}")`);
        }
        def.ins.push({ n: pname, t: "param" });
        const dv = pdefault !== undefined ? parseFloat(pdefault) : 0;
        def.params[pname] = isFinite(dv) ? dv : 0;
        paramOrder.push(pname);
      }
    }

    // Uniform-buffer size: 64-byte standard preamble (resolution,
    // time, dt, _pad, u_view, u_world_uv) + N × 4 B for params,
    // rounded up to a 16-byte boundary so vec4 fields the user might
    // add later still align cleanly. Floor at 80 bytes (the
    // SolidColor case: 64 preamble + 16 vec4 color) so the smallest
    // shader still gets a comfortable buffer.
    const N = paramOrder.length;
    def.uniformBytes = Math.max(80, 64 + Math.ceil((N * 4) / 16) * 16);

    // writeUniforms — pack params as f32 in declaration order, starting
    // at scratch[16] (= byte offset 64, immediately after the
    // 64-byte standard preamble). The user's WGSL struct must declare
    // matching f32 fields in the same order; see gdspFormatSpec for
    // the convention + a worked example.
    def.writeUniforms = function (node, scratch) {
      const p = node.params || {};
      for (let i = 0; i < paramOrder.length; i++) {
        const name = paramOrder[i];
        const v = p[name];
        scratch[16 + i] = (typeof v === "number") ? v : 0;
      }
    };

    return { def, name: d.name };
  }

  // -- Audio (cpp) path below — unchanged from before --
  if (!d.input) throw new Error("Missing @gdsp-input (need at least one)");

  const def = {
    category:   d.category || "User DSP",
    color:      d.color || "#c8e85a",
    header:     null,
    description: d.description || "",
    cppType:    d.name,
    ins:        [],
    outs:       [],
    params:     {},
    methods:    {},
    isUserDsp:  true,
    // @gdsp-header directives become extra #include lines at codegen
    // time. Bare values get angle brackets; values starting with " are
    // emitted verbatim; values starting with < are stripped of brackets
    // so we don't double-wrap.
    extraHeaders: Array.isArray(d.header) ? d.header.map(h => h.trim()).filter(Boolean) : []
  };

  d.input.forEach(s => {
    const parts = s.trim().split(/\s+/);
    const [pname, ptype, pdefault] = parts;
    if (!pname || !ptype) throw new Error(`Bad @gdsp-input: ${s}`);
    if (!["audio", "param", "gate"].includes(ptype)) {
      throw new Error(`@gdsp-input ${pname}: type must be audio/param/gate`);
    }
    def.ins.push({ n: pname, t: ptype });
    if (ptype === "param") {
      const dv = pdefault !== undefined ? parseFloat(pdefault) : 0;
      def.params[pname] = isFinite(dv) ? dv : 0;
      def.methods[pname] = pname;
    }
  });
  d.output.forEach(s => {
    const parts = s.trim().split(/\s+/);
    const [pname, ptype] = parts;
    if (!pname || !ptype) throw new Error(`Bad @gdsp-output: ${s}`);
    def.outs.push({ n: pname, t: ptype });
  });
  if (d.method) {
    d.method.forEach(s => {
      const [param, method] = s.trim().split(/\s+/);
      if (param && method) def.methods[param] = method;
    });
  }
  if (d.gate) {
    def.gateMethods = {};
    d.gate.forEach(s => {
      const [name, method] = s.trim().split(/\s+/);
      if (name && method) def.gateMethods[name] = method;
    });
  }

  // Light syntax check: look for matching class declaration
  const classRe = new RegExp(`class\\s+${d.name}\\b`);
  if (!classRe.test(source)) {
    throw new Error(`Source does not contain "class ${d.name}"`);
  }
  const opRe = /\boperator\s*\(\s*\)\s*\(/;
  if (!opRe.test(source)) {
    throw new Error("Class must define operator()");
  }

  return { def, name: d.name };
}

function registerUserDsp(source) {
  const { def, name } = buildUserDspDef(source);
  TYPES[name] = def;
  USER_DSP_SOURCES[name] = source;
  USER_DSP_META[name] = { category: def.category, color: def.color };
  if (!CATEGORY_ORDER.includes(def.category)) CATEGORY_ORDER.push(def.category);
  return name;
}

function unregisterUserDsp(name) {
  delete TYPES[name];
  delete USER_DSP_SOURCES[name];
  delete USER_DSP_META[name];
  // Remove from any patch using it
  state.nodes = state.nodes.filter(n => n.type !== name);
  state.edges = state.edges.filter(e =>
    nodeById(e.from.node) && nodeById(e.to.node)
  );
}

function stripGdspHeader(source) {
  return source.split("\n").filter(l => !/^\s*\/\/\s*@gdsp-/.test(l)).join("\n").trim();
}

function exportGdsp(name) {
  const src = USER_DSP_SOURCES[name];
  if (!src) return;
  const blob = new Blob([src], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name + ".gdsp";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

