/* =========================================================================
 * Tektite MD -- markdown editor (CodeMirror 6) + wikilink decoration
 *
 * Phase C sprint tektite-2. Replaces the plain <textarea> from sprint
 * tektite-1 with a real CodeMirror 6 instance:
 *   - Markdown syntax highlighting (headings, code fences, lists,
 *     emphasis, etc.)
 *   - `[[wikilink]]` decoration -- syntax-colored, Cmd/Ctrl-click to
 *     navigate (delegated up to the tab via onWikilinkClick)
 *   - Line wrapping, default theme (dark)
 *   - History + standard editing keybindings via basicSetup
 *
 * CodeMirror 6 is loaded lazily via jsdelivr's `+esm` bundle on first
 * attach. Mirrors the lazy-import pattern in src/ai/settings.js for
 * @huggingface/transformers. Total bundle is ~250 KB gzipped --
 * downloaded only when the user opens the Tektite tab.
 *
 * If the load fails (offline / blocked CDN), the editor falls back to
 * the plain textarea from sprint tektite-1 so basic editing still works.
 *
 * Public surface:
 *   tektiteMarkdownAttach(container, initialDoc, opts)
 *       -- Replaces `container`'s contents with a CodeMirror instance.
 *          opts = { onChange, onWikilinkClick, readOnly }
 *          Returns { setDoc, getDoc, setReadOnly, destroy } handle.
 *   tektiteMarkdownExtractWikilinks(text)
 *       -- Returns [{ target, displayText, range:[from,to] }] from a
 *          markdown string. Used by the backlinks index + the
 *          autocomplete in a later sprint.
 * ======================================================================== */

const TEKTITE_WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;
const TEKTITE_PIPE_SPLIT  = /^([^|]+)\|(.+)$/;

let _tektiteCmModules = null;  // resolved import bundle (or null on failure)

async function _tektiteLoadCodeMirror() {
  if (_tektiteCmModules) return _tektiteCmModules;
  try {
    // Sprint tektite-2c fix -- switched from jsdelivr `+esm` URLs to
    // esm.sh. jsdelivr loads each @codemirror/* package as a separate
    // copy with its OWN @codemirror/state, which breaks instanceof
    // checks ("Unrecognized extension value... multiple instances of
    // @codemirror/state are loaded"). esm.sh has built-in dedup --
    // it serves one shared copy of @codemirror/state to every
    // dependent package.
    const [cm, lang, viewMod, stateMod, langData] = await Promise.all([
      import("https://esm.sh/codemirror@6"),
      import("https://esm.sh/@codemirror/lang-markdown@6"),
      import("https://esm.sh/@codemirror/view@6"),
      import("https://esm.sh/@codemirror/state@6"),
      import("https://esm.sh/@codemirror/language-data@6").catch(() => null)
    ]);
    _tektiteCmModules = {
      EditorView:   cm.EditorView   || viewMod.EditorView,
      basicSetup:   cm.basicSetup,
      EditorState:  stateMod.EditorState,
      Decoration:   viewMod.Decoration,
      ViewPlugin:   viewMod.ViewPlugin,
      WidgetType:   viewMod.WidgetType,
      keymap:       viewMod.keymap,
      RangeSetBuilder: stateMod.RangeSetBuilder,
      markdown:     lang.markdown,
      markdownLanguage: lang.markdownLanguage,
      languages:    langData ? (langData.languages || []) : []
    };
    return _tektiteCmModules;
  } catch (e) {
    console.warn("[tektite] CodeMirror load failed; falling back to textarea:", e);
    return null;
  }
}

/* Sprint tektite-2b -- markdown-to-HTML renderer for the preview pane.
 * Loads `marked` lazily on first use (~50KB ESM bundle). Falls back to
 * a plain <pre> formatter if the CDN fetch fails. */
let _tektiteMarkedCache = null;
async function _tektiteLoadMarked() {
  if (_tektiteMarkedCache) return _tektiteMarkedCache;
  try {
    const m = await import("https://esm.sh/marked@latest");
    const fn = (typeof m.marked === "function") ? m.marked
             : (typeof m.default === "function") ? m.default
             : null;
    if (!fn) throw new Error("marked module did not expose a callable entry");
    // GFM + line breaks; headerIds disabled to avoid collisions when
    // the same note renders multiple times in transclusion.
    if (typeof fn.setOptions === "function") {
      fn.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
    }
    // Sprint tektite-2c -- footnotes via marked-footnote extension.
    // Optional; if the load fails footnotes degrade to literal text.
    try {
      const fnExt = await import("https://esm.sh/marked-footnote@latest");
      const ext = (fnExt.default || fnExt.markedFootnote);
      if (ext && typeof fn.use === "function") fn.use(ext());
    } catch (e) {
      console.warn("[tektite] marked-footnote unavailable:", e);
    }
    _tektiteMarkedCache = fn;
    return fn;
  } catch (e) {
    console.warn("[tektite] marked load failed; using plain preview:", e);
    _tektiteMarkedCache = (text) =>
      "<pre style=\"white-space:pre-wrap;font-family:ui-monospace,monospace;\">" +
      String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
      "</pre>";
    return _tektiteMarkedCache;
  }
}

/* Sprint tektite-2c -- KaTeX loader. Renders both inline ($...$) and
 * block ($$...$$) LaTeX math. Loaded lazily on first preview render
 * that contains a $; downloads the JS + CSS together. */
let _tektiteKatexCache = null;
async function _tektiteLoadKatex() {
  if (_tektiteKatexCache !== null) return _tektiteKatexCache;
  try {
    // Inject the KaTeX stylesheet once -- the auto-render CSS classes
    // need it for proper typographic spacing.
    if (!document.querySelector('link[data-tektite-katex]')) {
      const link = document.createElement("link");
      link.rel  = "stylesheet";
      link.href = "https://esm.sh/katex@latest/dist/katex.min.css";
      link.setAttribute("data-tektite-katex", "1");
      document.head.appendChild(link);
    }
    const k = await import("https://esm.sh/katex@latest");
    _tektiteKatexCache = k.default || k;
    return _tektiteKatexCache;
  } catch (e) {
    console.warn("[tektite] KaTeX load failed; math will render as literal text:", e);
    _tektiteKatexCache = false;
    return false;
  }
}

/* Sprint tektite-2c -- Mermaid diagram loader. Initialized once on
 * first use with a dark theme matching the editor palette. */
let _tektiteMermaidCache = null;
let _tektiteMermaidIdCtr = 0;
async function _tektiteLoadMermaid() {
  if (_tektiteMermaidCache !== null) return _tektiteMermaidCache;
  try {
    const m = await import("https://esm.sh/mermaid@latest");
    const mermaid = m.default || m;
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      themeVariables: {
        background:       "#0a0e16",
        primaryColor:     "#1a2030",
        primaryTextColor: "#e8f0ff",
        primaryBorderColor: "#83e8ff",
        lineColor:        "#9bd0ff",
        secondaryColor:   "#2a1a08",
        tertiaryColor:    "#181028"
      }
    });
    _tektiteMermaidCache = mermaid;
    return mermaid;
  } catch (e) {
    console.warn("[tektite] Mermaid load failed; diagram blocks stay as code:", e);
    _tektiteMermaidCache = false;
    return false;
  }
}

/* Pre-process markdown -- replace $...$ and $$...$$ with placeholder
 * spans BEFORE marked sees them so the dollar signs don't get mangled
 * by GFM (which can treat $ as part of strikethrough scanning).  The
 * placeholders survive into the rendered HTML where they get swapped
 * for KaTeX output in _tektiteTransformMath. */
function _tektitePreprocessMath(text) {
  // Block math first ($$...$$, multi-line). The DOTALL-ish [\s\S]*?
  // makes the inner match nongreedy so $$a$$ b $$c$$ stays as two
  // blocks.
  let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (whole, expr) => {
    return '<span data-tektite-math="block">' + _tektiteMdEscapeAttr(expr) + '</span>';
  });
  // Inline math -- single $ on each side, no leading/trailing whitespace
  // inside (so `cost is $5` doesn't trigger). Allows newlines inside
  // since some folks write inline math across linebreaks.
  processed = processed.replace(/(?<![\\$])\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\$)/g, (whole, expr) => {
    return '<span data-tektite-math="inline">' + _tektiteMdEscapeAttr(expr) + '</span>';
  });
  return processed;
}

function _tektiteMdEscapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function _tektiteTransformMath(rootEl) {
  const nodes = rootEl.querySelectorAll("span[data-tektite-math]");
  if (!nodes.length) return;
  const katex = await _tektiteLoadKatex();
  if (!katex) return;
  nodes.forEach(node => {
    const isBlock = node.getAttribute("data-tektite-math") === "block";
    const expr = node.textContent;
    try {
      const html = katex.renderToString(expr, {
        throwOnError: false,
        displayMode:  isBlock,
        output:       "html"
      });
      const replacement = document.createElement(isBlock ? "div" : "span");
      replacement.className = "tektite-math" + (isBlock ? " tektite-math-block" : "");
      replacement.innerHTML = html;
      node.replaceWith(replacement);
    } catch (e) {
      node.textContent = "[math error: " + (e.message || String(e)) + "]";
    }
  });
}

async function _tektiteTransformMermaid(rootEl) {
  // marked renders fenced ```mermaid blocks as <pre><code class="language-mermaid">.
  const nodes = rootEl.querySelectorAll("pre > code.language-mermaid");
  if (!nodes.length) return;
  const mermaid = await _tektiteLoadMermaid();
  if (!mermaid) return;
  for (const code of nodes) {
    const src = code.textContent || "";
    const id  = "tektite-mmd-" + (_tektiteMermaidIdCtr++);
    try {
      const { svg } = await mermaid.render(id, src);
      const wrap = document.createElement("div");
      wrap.className = "tektite-mermaid";
      wrap.innerHTML = svg;
      // Replace the parent <pre> so the inline ``` framing disappears.
      code.parentElement.replaceWith(wrap);
    } catch (e) {
      const err = document.createElement("div");
      err.className = "tektite-mermaid-err";
      err.textContent = "Mermaid error: " + (e.message || String(e));
      code.parentElement.replaceWith(err);
    }
  }
}

/* Public: render markdown text to HTML element. Caller appends the
 * returned element to a container; we own the DOM transform so KaTeX
 * + Mermaid post-processing can mutate live nodes. */
async function tektiteMarkdownRender(text) {
  const marked = await _tektiteLoadMarked();
  // Process [[wikilinks]] into anchors before marked sees them.
  const withLinks = String(text || "").replace(
    TEKTITE_WIKILINK_RE,
    (whole, inner) => {
      const pipe = inner.match(TEKTITE_PIPE_SPLIT);
      const target = pipe ? pipe[1].trim() : inner.trim();
      const display = pipe ? pipe[2].trim() : target;
      const safeT = target.replace(/"/g, "&quot;");
      const safeD = display.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      return '<a href="#" class="tektite-link" data-tektite-link="' + safeT + '">' + safeD + '</a>';
    }
  );
  // Math placeholders survive marked's HTML escape.
  const withMath = _tektitePreprocessMath(withLinks);
  const rawHtml = marked(withMath);
  // Mount into a detached container so the transform passes can
  // mutate nodes before they're attached to the visible DOM.
  const wrap = document.createElement("div");
  wrap.innerHTML = rawHtml;
  await _tektiteTransformMath(wrap);
  await _tektiteTransformMermaid(wrap);
  return wrap.innerHTML;
}

/* Inline wikilink decoration. Walks the visible doc on every viewport
 * change + doc change, building Decoration.mark() ranges for each
 * `[[...]]` span. CSS class `.cm-wikilink` styles them in app.css. */
function _tektiteMakeWikilinkPlugin(cm) {
  const { Decoration, ViewPlugin, RangeSetBuilder } = cm;
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }
    build(view) {
      const builder = new RangeSetBuilder();
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let m;
        TEKTITE_WIKILINK_RE.lastIndex = 0;
        while ((m = TEKTITE_WIKILINK_RE.exec(text))) {
          const start = from + m.index;
          const end   = start + m[0].length;
          builder.add(start, end, Decoration.mark({
            class: "cm-wikilink",
            attributes: { "data-tektite-link": m[1] }
          }));
        }
      }
      return builder.finish();
    }
  }, { decorations: v => v.decorations });
}

/* Cmd/Ctrl-click handler. Walks up from the click event's target to
 * find a `.cm-wikilink` span and delegates to opts.onWikilinkClick.
 * The CodeMirror DOM is a flat structure of span elements so the
 * lookup is a single closest() call. */
function _tektiteWireWikilinkClicks(view, onClick) {
  view.dom.addEventListener("click", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const el = e.target && e.target.closest && e.target.closest(".cm-wikilink");
    if (!el) return;
    const target = el.getAttribute("data-tektite-link");
    if (target) {
      e.preventDefault();
      onClick(target.trim());
    }
  });
}

async function tektiteMarkdownAttach(container, initialDoc, opts) {
  opts = opts || {};
  const cm = await _tektiteLoadCodeMirror();
  if (!cm) return null;  // caller falls back to textarea

  // Note: read-only toggling rebuilds the state via view.setState() in
  // the setReadOnly handle below, so no Compartment is needed.

  // Sprint tektite-2b -- pass GFM + codeLanguages to the markdown
  // extension so fenced code blocks (```js, ```python, etc.) get
  // syntax highlighting via @codemirror/language-data's lazy-loaded
  // grammar registry.
  const mdOpts = { base: cm.markdownLanguage };
  if (cm.languages && cm.languages.length) mdOpts.codeLanguages = cm.languages;

  const extensions = [
    cm.basicSetup,
    cm.markdown(mdOpts),
    _tektiteMakeWikilinkPlugin(cm),
    cm.EditorView.lineWrapping,
    cm.EditorView.theme({
      "&": {
        height: "100%",
        backgroundColor: "transparent",
        color: "var(--text, #e8f0ff)",
        fontSize: "12.5px"
      },
      ".cm-content": {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        padding: "12px 14px"
      },
      ".cm-scroller": { overflow: "auto" },
      ".cm-gutters": {
        backgroundColor: "rgba(0,0,0,0.2)",
        color: "var(--text-3, #4a5868)",
        border: "none"
      },
      ".cm-activeLine":       { backgroundColor: "rgba(255,255,255,0.03)" },
      ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.04)" },
      ".cm-cursor":           { borderLeftColor: "var(--accent, #c8e85a)" },
      ".cm-selectionBackground, ::selection": {
        backgroundColor: "rgba(155,208,255,0.20) !important"
      },
      ".cm-wikilink": {
        color:           "var(--text-wire, #83e8ff)",
        backgroundColor: "rgba(131,232,255,0.10)",
        borderRadius:    "3px",
        padding:         "0 2px",
        cursor:          "pointer"
      },
      ".tok-heading": { color: "var(--accent, #c8e85a)", fontWeight: "600" }
    }, { dark: true })
  ];

  // Read-only is plumbed via EditorView.editable.of(false) -- when the
  // caller wants to toggle later, we destroy + re-create the state.
  let isReadOnly = !!opts.readOnly;
  if (isReadOnly) extensions.push(cm.EditorView.editable.of(false));

  // Notify on doc changes (debounced upstream by editor.js).
  if (typeof opts.onChange === "function") {
    extensions.push(cm.EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state.doc.toString());
    }));
  }

  // Clear container + create the view.
  container.innerHTML = "";
  const view = new cm.EditorView({
    state: cm.EditorState.create({ doc: String(initialDoc || ""), extensions }),
    parent: container
  });

  if (typeof opts.onWikilinkClick === "function") {
    _tektiteWireWikilinkClicks(view, opts.onWikilinkClick);
  }

  return {
    setDoc(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: String(text || "") }
      });
    },
    getDoc() { return view.state.doc.toString(); },
    setReadOnly(ro) {
      // Cheap path: recreate the state with the new editable flag.
      // For sprint 2's UX this is fine -- read-only flips happen on
      // source switch, not while typing.
      isReadOnly = !!ro;
      const newExt = extensions.slice();
      // Strip any prior editable.of, then add the current one.
      const filtered = newExt.filter(e => e !== undefined);
      filtered.push(cm.EditorView.editable.of(!isReadOnly));
      view.setState(cm.EditorState.create({ doc: view.state.doc, extensions: filtered }));
    },
    focus() { view.focus(); },
    destroy() { view.destroy(); }
  };
}

/* Extract wikilinks from a markdown string. Used by the backlinks
 * index + the future autocomplete UI. Each entry has the raw
 * [[target]] text plus the byte range so a caller can highlight or
 * navigate to the source position.
 *
 * Pipe form `[[target|display]]` is recognized; `target` is the
 * canonical reference, `displayText` is what the renderer shows. */
function tektiteMarkdownExtractWikilinks(text) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  TEKTITE_WIKILINK_RE.lastIndex = 0;
  let m;
  while ((m = TEKTITE_WIKILINK_RE.exec(text))) {
    const inner = m[1];
    let target = inner.trim();
    let displayText = target;
    const pipe = inner.match(TEKTITE_PIPE_SPLIT);
    if (pipe) {
      target      = pipe[1].trim();
      displayText = pipe[2].trim();
    }
    out.push({
      target,
      displayText,
      range: [m.index, m.index + m[0].length]
    });
  }
  return out;
}
