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
    // Each package ships its own ESM bundle from jsdelivr. We load
    // them in parallel; the EditorView in `codemirror` re-exports
    // basicSetup so callers don't need a separate import for it.
    const [cm, lang, viewMod, stateMod] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/codemirror@6/+esm"),
      import("https://cdn.jsdelivr.net/npm/@codemirror/lang-markdown@6/+esm"),
      import("https://cdn.jsdelivr.net/npm/@codemirror/view@6/+esm"),
      import("https://cdn.jsdelivr.net/npm/@codemirror/state@6/+esm")
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
      markdown:     lang.markdown
    };
    return _tektiteCmModules;
  } catch (e) {
    console.warn("[tektite] CodeMirror load failed; falling back to textarea:", e);
    return null;
  }
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

  const compartments = {
    readOnly: new cm.EditorState.compartment ? null : null  // CM compartments need an import; we re-create the state on r/o flip
  };

  const extensions = [
    cm.basicSetup,
    cm.markdown(),
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
