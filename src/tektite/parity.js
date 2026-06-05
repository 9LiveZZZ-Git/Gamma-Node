/* =========================================================================
 * Tektite MD -- parity sprints (10h+).  Quick switcher, outline /
 * backlinks / tags pane, tabs/split panes, etc.  All Obsidian-parity
 * features live here so the editor + tab code stays focused.
 * ======================================================================== */

/* ---- Sprint 10h: Quick switcher (Cmd/Ctrl-P) -----------------------
 * Reuses _openVaultPicker (card-bodies.js) with center-screen anchor.
 * Opening a note dispatches to _tektitePopoutOpen so the user gets the
 * standard floating popout editor without leaving the canvas. */
async function _tektiteQuickSwitcherOpen() {
  if (typeof _openVaultPicker !== "function") return;
  _openVaultPicker(null, "", async (pick) => {
    try {
      if (pick.id) {
        if (typeof _tektitePopoutOpen === "function") await _tektitePopoutOpen(pick.id);
      } else if (pick.create) {
        const id = await tektiteNextAvailableSlug(pick.create);
        const content = "# " + pick.create + "\n\n";
        await tektitePutNote({ id, title: pick.create, content });
        if (typeof _tektitePopoutOpen === "function") await _tektitePopoutOpen(id);
      }
    } catch (e) {
      console.warn("[quick-switcher] open failed:", e);
    }
  });
}

window.addEventListener("keydown", (e) => {
  // Cmd/Ctrl-P -- Obsidian convention.  Skip in text inputs so the
  // browser-native print shortcut still works when nothing else is
  // listening (and so the user can type "p" in fields).
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.shiftKey || e.altKey) return;          // Cmd+Shift+P = command palette (future)
  if (e.key !== "p" && e.key !== "P") return;
  if (typeof isTextInput === "function" && isTextInput(document.activeElement)) return;
  e.preventDefault();
  _tektiteQuickSwitcherOpen();
});

/* ---- Sprint 10i: Outline / backlinks / tags pane -----------------
 * Per-popout sidebar.  Toggle button on the popout title bar opens
 * a small overlay listing the current note's headings + outgoing
 * wikilinks + tags.  Click a heading to scroll the popout's CM6
 * editor to that line.  Click an outgoing link to open that note
 * in another popout. */
function _tektiteOutlineExtract(content) {
  const lines = String(content || "").split(/\r?\n/);
  const headings = [];
  const links = new Set();
  const tags = new Set();
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) headings.push({ level: h[1].length, text: h[2], line: i });
    const wl = line.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g);
    if (wl) for (const m of wl) {
      const inner = m.slice(2, -2).split("|")[0].trim();
      if (inner) links.add(inner);
    }
    const ts = line.match(/(?:^|\s)#([A-Za-z0-9][\w/-]*)/g);
    if (ts) for (const t of ts) tags.add(t.trim().replace(/^#/, ""));
  }
  return { headings, links: Array.from(links), tags: Array.from(tags) };
}

function _tektiteOutlineRender(container, info, popout) {
  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  let html = '<div class="tk-outline-section"><div class="tk-outline-h">Headings</div>';
  if (!info.headings.length) html += '<div class="tk-outline-empty">(none)</div>';
  else for (const h of info.headings) {
    html += '<div class="tk-outline-item" data-line="' + h.line +
      '" style="padding-left:' + ((h.level - 1) * 10 + 8) + 'px;">' +
      esc(h.text) + '</div>';
  }
  html += '</div><div class="tk-outline-section"><div class="tk-outline-h">Outgoing links</div>';
  if (!info.links.length) html += '<div class="tk-outline-empty">(none)</div>';
  else for (const l of info.links) {
    html += '<div class="tk-outline-item tk-link" data-link="' + esc(l) + '">' + esc(l) + '</div>';
  }
  html += '</div><div class="tk-outline-section"><div class="tk-outline-h">Tags</div>';
  if (!info.tags.length) html += '<div class="tk-outline-empty">(none)</div>';
  else html += info.tags.map(t => '<span class="tk-outline-tag">#' + esc(t) + '</span>').join(" ");
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll(".tk-outline-item[data-line]").forEach(el => {
    el.addEventListener("click", () => {
      const line = Number(el.getAttribute("data-line"));
      _tektitePopoutScrollToLine(popout, line);
    });
  });
  container.querySelectorAll(".tk-outline-item[data-link]").forEach(el => {
    el.addEventListener("click", async () => {
      const target = el.getAttribute("data-link") || "";
      // Resolve by id first; fall back to title match.
      let note = null;
      try { note = await tektiteGetNote(target); } catch (_) {}
      if (!note) {
        try {
          const all = await tektiteListNotes();
          const lc = target.toLowerCase();
          note = all.find(n => (n.title || "").toLowerCase() === lc);
        } catch (_) {}
      }
      if (note && typeof _tektitePopoutOpen === "function") {
        _tektitePopoutOpen(note.id);
      }
    });
  });
}

function _tektitePopoutScrollToLine(popout, line) {
  if (!popout) return;
  // tektiteMarkdownAttach's handle exposes scrollToLine (sprint 10i).
  if (popout.cm && typeof popout.cm.scrollToLine === "function") {
    popout.cm.scrollToLine(line);
    return;
  }
  // Fallback: position the textarea's caret to the start of the
  // requested line.  Rough but better than nothing for the no-CM path.
  const ta = popout.dom && popout.dom.querySelector(".tektite-graph-popout-editor");
  if (ta) {
    const text = ta.value || "";
    let pos = 0, cur = 0;
    while (cur < line && pos < text.length) {
      const i = text.indexOf("\n", pos);
      if (i < 0) break;
      pos = i + 1;
      cur++;
    }
    ta.focus();
    ta.setSelectionRange(pos, pos);
  }
}

/* Toggle the outline pane on a popout.  Pane is mounted lazily on
 * first toggle; subsequent toggles show/hide. */
function _tektitePopoutToggleOutline(popout) {
  if (!popout || !popout.dom) return;
  let pane = popout.dom.querySelector(".tk-outline-pane");
  if (!pane) {
    pane = document.createElement("div");
    pane.className = "tk-outline-pane";
    popout.dom.appendChild(pane);
  }
  const showing = pane.style.display !== "none" && pane.style.display !== "";
  if (showing) { pane.style.display = "none"; return; }
  pane.style.display = "block";
  // Pull the current note content from CM6 (canonical) or the textarea fallback.
  const content = (popout.cm && typeof popout.cm.getDoc === "function")
    ? popout.cm.getDoc()
    : ((popout.dom.querySelector(".tektite-graph-popout-editor") || {}).value || "");
  const info = _tektiteOutlineExtract(content);
  _tektiteOutlineRender(pane, info, popout);
}

/* ---- Sprint 10j: JSON Canvas .canvas import/export -----------------
 * Round-trips the JSON Canvas format (jsoncanvas.org) into the main
 * canvas's Tektite card subset.  Import: drag a .canvas file or call
 * tektiteImportJsonCanvas(jsonText).  Export: tektiteExportJsonCanvas()
 * returns a JSON string of all Tektite cards on the main canvas.
 *
 * Mapping:
 *   JSON Canvas node type "text"  <-> TextCard
 *   JSON Canvas node type "file"  <-> NoteCard  (file -> vault note id)
 *   JSON Canvas node type "link"  <-> LinkCard
 *   JSON Canvas node type "group" -> ignored (no group card kind yet)
 *   JSON Canvas edges             <-> state.edges between TextCard /
 *                                     NoteCard / LinkCard outputs +
 *                                     downstream inputs (best effort)
 */
function tektiteImportJsonCanvas(jsonText) {
  let doc;
  try { doc = JSON.parse(jsonText); }
  catch (e) { throw new Error("Invalid JSON: " + (e.message || e)); }
  if (!doc || !Array.isArray(doc.nodes)) {
    throw new Error("Not a JSON Canvas doc (expected { nodes, edges }).");
  }
  if (typeof pushHistory === "function") pushHistory("import-jsoncanvas");
  const idMap = {};
  for (const jn of doc.nodes) {
    let type = null, params = {};
    if (jn.type === "text") {
      type = "TextCard";
      params = {
        text:   String(jn.text || ""),
        width:  Number(jn.width)  || 260,
        height: Number(jn.height) || 80,
        color:  String(jn.color || ""),
        linkedFile: ""
      };
    } else if (jn.type === "file") {
      type = "NoteCard";
      params = {
        file:   String(jn.file || "").replace(/\.md$/i, ""),
        text:   "",
        title:  "",
        width:  Number(jn.width)  || 320,
        height: Number(jn.height) || 200,
        color:  String(jn.color || "")
      };
    } else if (jn.type === "link") {
      type = "LinkCard";
      params = {
        url:    String(jn.url || ""),
        label:  String(jn.label || ""),
        width:  Number(jn.width)  || 280,
        height: Number(jn.height) || 120,
        color:  String(jn.color || ""),
        linkedFile: ""
      };
    } else {
      continue;   // group + future kinds skipped
    }
    if (typeof makeNode !== "function") continue;
    const newId = makeNode(type, Number(jn.x) || 0, Number(jn.y) || 0, params);
    idMap[jn.id] = newId;
  }
  // Edges: JSON Canvas edges connect node id -> node id (no port
  // metadata).  We pick the first output of the source + first input
  // of the destination as a best-effort wire.
  if (Array.isArray(doc.edges)) {
    for (const ed of doc.edges) {
      const fromId = idMap[ed.fromNode];
      const toId   = idMap[ed.toNode];
      if (!fromId || !toId) continue;
      const fromNode = (typeof nodeById === "function") ? nodeById(fromId) : null;
      const toNode   = (typeof nodeById === "function") ? nodeById(toId)   : null;
      if (!fromNode || !toNode) continue;
      const fromDef = (typeof TYPES === "object") ? TYPES[fromNode.type] : null;
      const toDef   = (typeof TYPES === "object") ? TYPES[toNode.type]   : null;
      if (!fromDef || !toDef) continue;
      const fromPort = (fromDef.outs && fromDef.outs[0] && fromDef.outs[0].n) || null;
      const toPort   = (toDef.ins   && toDef.ins[0]   && toDef.ins[0].n)   || null;
      if (!fromPort || !toPort) continue;
      state.edges.push({
        from: { node: fromId, port: fromPort },
        to:   { node: toId,   port: toPort   },
        _label: ed.label || ""
      });
    }
  }
  if (typeof render === "function") render();
  return Object.keys(idMap).length;
}

function tektiteExportJsonCanvas() {
  const out = { nodes: [], edges: [] };
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return JSON.stringify(out);
  for (const n of state.nodes) {
    if (!n || !n.type) continue;
    let jn = null;
    if (n.type === "TextCard") {
      jn = {
        id: n.id, type: "text",
        x: Math.round(n.x || 0), y: Math.round(n.y || 0),
        width:  Math.round((n.params && n.params.width)  || 260),
        height: Math.round((n.params && n.params.height) || 80),
        text: String((n.params && n.params.text) || "")
      };
    } else if (n.type === "NoteCard") {
      const file = String((n.params && n.params.file) || "");
      if (!file) continue;
      jn = {
        id: n.id, type: "file",
        x: Math.round(n.x || 0), y: Math.round(n.y || 0),
        width:  Math.round((n.params && n.params.width)  || 320),
        height: Math.round((n.params && n.params.height) || 200),
        file: file + ".md"
      };
    } else if (n.type === "LinkCard") {
      jn = {
        id: n.id, type: "link",
        x: Math.round(n.x || 0), y: Math.round(n.y || 0),
        width:  Math.round((n.params && n.params.width)  || 280),
        height: Math.round((n.params && n.params.height) || 120),
        url:   String((n.params && n.params.url)   || ""),
        label: String((n.params && n.params.label) || "")
      };
    }
    if (jn) {
      const color = String((n.params && n.params.color) || "");
      if (color) jn.color = color;
      out.nodes.push(jn);
    }
  }
  const cardIds = new Set(out.nodes.map(n => n.id));
  for (const e of (state.edges || [])) {
    if (!e || !e.from || !e.to) continue;
    if (!cardIds.has(e.from.node) || !cardIds.has(e.to.node)) continue;
    const edge = { id: e.from.node + "-" + e.to.node, fromNode: e.from.node, toNode: e.to.node };
    if (e._label) edge.label = e._label;
    out.edges.push(edge);
  }
  return JSON.stringify(out, null, 2);
}

/* User-facing import/export triggers wired into the Tektite tab
 * toolbar (sprint 10j-wire).  Both are no-ops if the related buttons
 * aren't in the DOM yet -- the wiring is idempotent. */
function _tektiteWireJsonCanvasIO() {
  const importBtn = document.getElementById("btn-tektite-import-canvas");
  if (importBtn && !importBtn._wired) {
    importBtn._wired = true;
    importBtn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".canvas,.json";
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const n = tektiteImportJsonCanvas(String(reader.result || ""));
            window.alert("Imported " + n + " card" + (n === 1 ? "" : "s") + " from " + file.name + ".");
          } catch (e) {
            window.alert("Import failed: " + (e.message || e));
          }
        };
        reader.readAsText(file);
      });
      input.click();
    });
  }
  const exportBtn = document.getElementById("btn-tektite-export-canvas");
  if (exportBtn && !exportBtn._wired) {
    exportBtn._wired = true;
    exportBtn.addEventListener("click", () => {
      const json = tektiteExportJsonCanvas();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (state && state.patchName ? state.patchName : "tektite") + ".canvas";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }
}
// Run on every render so newly-mounted DOM gets wired.  Also runs on
// boot so the initial buttons get hooked.
(function _autoWire() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _tektiteWireJsonCanvasIO);
  } else {
    _tektiteWireJsonCanvasIO();
  }
})();

/* Sprint 10p -- Tektite toolbar dropdown menus (Views, .canvas I/O).
 * Idempotent: triggers get marked _tkMenuWired on first attach so a
 * later tab re-render doesn't pile up handlers.  Outside-click closes
 * any open menu. */
function _tektiteWireMenus() {
  document.querySelectorAll(".tektite-toolbar .tk-menu").forEach(menu => {
    const trigger = menu.querySelector(".tk-menu-trigger");
    if (!trigger || trigger._tkMenuWired) return;
    trigger._tkMenuWired = true;
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = menu.classList.contains("open");
      // Close any other open menus first.
      document.querySelectorAll(".tektite-toolbar .tk-menu.open").forEach(m =>
        m.classList.remove("open"));
      if (!wasOpen) menu.classList.add("open");
    });
    // Clicking an action inside the pop should close the menu.
    menu.querySelectorAll(".tk-menu-pop .btn").forEach(btn => {
      btn.addEventListener("click", () => menu.classList.remove("open"));
    });
  });
}

document.addEventListener("pointerdown", (e) => {
  // Outside click -> close every open menu.
  document.querySelectorAll(".tektite-toolbar .tk-menu.open").forEach(m => {
    if (!m.contains(e.target)) m.classList.remove("open");
  });
}, true);

(function _autoWireMenus() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _tektiteWireMenus);
  } else {
    _tektiteWireMenus();
  }
})();

/* =========================================================================
 * Sprint 10t -- attachment viewers in the popout + Tektite tab drop-zone.
 *
 * Lifecycle inside a popout: the attachment viewer mounts lazily as a
 * sibling of the CM editor; when a tab loads an attachment id, the
 * markdown editor + preview hide and the viewer takes over.  Tab
 * switching back to a markdown note re-shows the editor.
 * ======================================================================== */

function _tektiteAttachmentExtensions() {
  // Flat union of every recognized extension for drop-classify fast paths.
  const out = new Set();
  if (typeof TEKTITE_FILE_KINDS !== "object") return out;
  for (const kind of Object.keys(TEKTITE_FILE_KINDS)) {
    for (const ext of TEKTITE_FILE_KINDS[kind]) out.add(ext);
  }
  return out;
}

function _tektiteIsAttachmentId(id) {
  const lower = String(id || "").toLowerCase();
  for (const ext of _tektiteAttachmentExtensions()) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function _tektitePopoutEnsureViewerEl(inst) {
  if (!inst || !inst.dom) return null;
  const surface = inst.dom.querySelector(".tektite-popout-edit-surface");
  if (!surface) return null;
  let viewer = surface.querySelector(".tektite-popout-attachment-viewer");
  if (!viewer) {
    viewer = document.createElement("div");
    viewer.className = "tektite-popout-attachment-viewer";
    viewer.style.display = "none";
    surface.appendChild(viewer);
  }
  return viewer;
}

function _tektitePopoutShowMarkdownLayer(inst) {
  if (!inst || !inst.dom) return;
  const cm = inst.dom.querySelector(".tektite-popout-cm-host");
  const ta = inst.dom.querySelector(".tektite-graph-popout-editor");
  const pv = inst.dom.querySelector(".tektite-popout-preview");
  const viewer = inst.dom.querySelector(".tektite-popout-attachment-viewer");
  if (cm) cm.style.display     = "";
  if (ta && inst.cm) ta.style.display = "none";
  else if (ta) ta.style.display       = "";
  if (pv) pv.style.display     = "";
  if (viewer) {
    viewer.style.display = "none";
    if (inst._attachmentBlobUrl) {
      URL.revokeObjectURL(inst._attachmentBlobUrl);
      inst._attachmentBlobUrl = null;
    }
    viewer.innerHTML = "";
  }
}

function _tektitePopoutShowAttachmentLayer(inst) {
  if (!inst || !inst.dom) return;
  const cm = inst.dom.querySelector(".tektite-popout-cm-host");
  const ta = inst.dom.querySelector(".tektite-graph-popout-editor");
  const pv = inst.dom.querySelector(".tektite-popout-preview");
  if (cm) cm.style.display = "none";
  if (ta) ta.style.display = "none";
  if (pv) pv.style.display = "none";
}

async function _tektitePopoutLoadAttachment(inst, attId) {
  const viewer = _tektitePopoutEnsureViewerEl(inst);
  if (!viewer) return;
  _tektitePopoutShowAttachmentLayer(inst);
  viewer.style.display = "block";
  viewer.innerHTML = '<div class="tk-att-loading">Loading <code>' +
    String(attId || "").replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</code>…</div>';
  let rec = null;
  try { rec = await tektiteGetAttachment(attId); } catch (_) {}
  if (!rec || !rec.blob) {
    viewer.innerHTML = '<div class="tk-att-empty">⚠ Attachment not found.</div>';
    return;
  }
  if (inst._attachmentBlobUrl) URL.revokeObjectURL(inst._attachmentBlobUrl);
  const url = URL.createObjectURL(rec.blob);
  inst._attachmentBlobUrl = url;
  const kind = rec.kind || (typeof tektiteClassifyAttachment === "function"
    ? tektiteClassifyAttachment(attId).kind : "other");
  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  const sizeKb = ((rec.size || 0) / 1024).toFixed(1);
  // Sprint 10u -- "Edit in <tool>" launchers for the 4 editor links
  // the user requested.  Stirling-PDF is server-only (Spring Boot)
  // so it's a "Send to" link against the configured instance; the
  // other three load in an in-app iframe modal.
  // Sprint 10u -- editor launchers.  PDF.js is the realistic best
  // free/open inline-browser PDF editor (server-only Stirling-PDF
  // got dropped after the user asked for a better option).
  const editorMap = {
    image: { label: "Edit in miniPaint",     act: "minipaint"     },
    pdf:   { label: "Open in PDF.js",        act: "pdfjs"         },
    data:  { label: "Edit in Tablecruncher", act: "tablecruncher" },
    doc:   { label: "Edit in docx-editor",   act: "docxeditor"    }
  };
  const editor = editorMap[kind];
  // Only data kind's CSV/TSV actually go to Tablecruncher; JSON et al fall back.
  const editorEligible = editor && (
    kind !== "data" || (rec.ext === ".csv" || rec.ext === ".tsv")
  );
  const editBtn = editorEligible
    ? '<button class="tk-att-edit" data-act="' + esc(editor.act) +
        '" data-id="' + esc(attId) + '" type="button">✎ ' + esc(editor.label) + '</button>'
    : "";
  const meta = '<div class="tk-att-meta">' +
    '<span class="tk-att-kind">' + esc(kind) + '</span>' +
    '<span class="tk-att-mime">' + esc(rec.mime || "") + '</span>' +
    '<span class="tk-att-size">' + sizeKb + ' KB</span>' +
    editBtn +
    '<a class="tk-att-dl" href="' + url + '" download="' + esc(attId) + '">Download</a>' +
  '</div>';
  let body = "";
  if (kind === "image") {
    body = '<img class="tk-att-image" src="' + url + '" alt="' + esc(attId) + '">';
  } else if (kind === "audio") {
    body = '<audio class="tk-att-audio" controls src="' + url + '"></audio>';
  } else if (kind === "video") {
    body = '<video class="tk-att-video" controls src="' + url + '"></video>';
  } else if (kind === "pdf") {
    // Sprint 10u -- Chrome's built-in PDF viewer supports highlight /
    // signature / free-text annotation when the toolbar is visible.
    // toolbar=1 + navpanes=1 expose those affordances; the user can
    // also click "Open in PDF.js" for a richer cross-browser viewer.
    body = '<embed class="tk-att-pdf" type="application/pdf" src="' +
           url + '#toolbar=1&navpanes=1&scrollbar=1">';
  } else if (kind === "data" || kind === "text") {
    try {
      const text = await rec.blob.text();
      const ext = (rec.ext || "").toLowerCase();
      if (ext === ".json" || ext === ".jsonl" || ext === ".gpatch") {
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
        body = '<pre class="tk-att-pre">' + esc(pretty.slice(0, 200000)) + '</pre>';
      } else if (ext === ".csv" || ext === ".tsv") {
        body = _tektiteAttachmentCsvHtml(text, ext === ".tsv" ? "\t" : ",");
      } else {
        body = '<pre class="tk-att-pre">' + esc(text.slice(0, 200000)) + '</pre>';
      }
    } catch (e) {
      body = '<div class="tk-att-empty">⚠ Failed to read text: ' + esc(e.message || e) + '</div>';
    }
  } else {
    body = '<div class="tk-att-empty">No inline viewer for <code>' + esc(rec.ext || "?") +
      '</code>.<br><br><a class="tk-att-dl-big" href="' + url + '" download="' + esc(attId) +
      '">⬇ Download to open externally</a></div>';
  }
  viewer.innerHTML = meta + '<div class="tk-att-body">' + body + '</div>';
  // Wire the editor launch button (if present).
  const editBtnEl = viewer.querySelector(".tk-att-edit");
  if (editBtnEl) editBtnEl.addEventListener("click", () => {
    _tektiteOpenExternalEditor(editBtnEl.getAttribute("data-act"),
                               editBtnEl.getAttribute("data-id"));
  });
}

/* Sprint 10u -- external-editor launchers.
 *
 * Stirling-PDF (Spring Boot Java server) -- cannot run in-browser;
 * opens the user's configured instance URL in a new tab with the
 * blob URL appended as ?url=... (Stirling supports this with the
 * /api/v1/general/load-from-url endpoint when the proxy permits).
 *
 * miniPaint / Tablecruncher / docx-editor -- browser-based; load
 * via iframe modal from their public hosted instances or jsDelivr.
 * Round-trip-save needs a postMessage protocol the editors don't
 * support out-of-box yet, so this is "open + edit + manually
 * download" for the MVP.  See docs/LLM-KNOWLEDGE-PHASE.md for the
 * follow-up sprint that brings save-back. */
const TEKTITE_EXTERNAL_EDITOR_URLS = {
  // Hosted instances; users can override via localStorage.tektite-editor-urls.
  minipaint:     "https://viliusle.github.io/miniPaint/",
  // PDF.js mozilla-hosted viewer.  Best free option; supports
  // highlight + free-text + ink annotation editing in-browser.
  // Cross-origin blob-URL load doesn't pass to the viewer, so the
  // launcher also surfaces a Download link the user can re-import
  // via PDF.js's "Open File" button.
  pdfjs:         "https://mozilla.github.io/pdf.js/web/viewer.html",
  tablecruncher: "https://tablecruncher.com/online/",
  docxeditor:    "https://eigenpal.github.io/docx-editor/"
};

function _tektiteEditorUrlFor(act) {
  let urls = TEKTITE_EXTERNAL_EDITOR_URLS;
  try {
    const raw = window.localStorage.getItem("tektite-editor-urls");
    if (raw) urls = Object.assign({}, urls, JSON.parse(raw));
  } catch (_) {}
  return urls[act] || null;
}

async function _tektiteOpenExternalEditor(act, attId) {
  const baseUrl = _tektiteEditorUrlFor(act);
  if (!baseUrl) { window.alert("No editor URL configured for " + act); return; }
  // Fetch the blob so we can hand it to the editor (modal iframe path
  // is best-effort: most editors don't have a documented postMessage
  // import API; user typically uses the editor's own File -> Open + we
  // also offer a Download link in the modal so they can grab it).
  let blob = null;
  try {
    const rec = await tektiteGetAttachment(attId);
    if (rec && rec.blob) blob = rec.blob;
  } catch (_) {}

  // Iframe modal for miniPaint / Tablecruncher / docx-editor / PDF.js.
  let modal = document.getElementById("tk-external-editor-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "tk-external-editor-modal";
    modal.className = "tk-external-editor-modal";
    modal.innerHTML =
      '<div class="tk-eem-bar">' +
        '<span class="tk-eem-title">External editor</span>' +
        '<a class="tk-eem-dl" download>⬇ Download to import</a>' +
        '<button class="tk-eem-close" type="button">× Close</button>' +
      '</div>' +
      '<iframe class="tk-eem-iframe" frameborder="0"></iframe>';
    document.body.appendChild(modal);
    modal.querySelector(".tk-eem-close").addEventListener("click", () => {
      modal.style.display = "none";
      modal.querySelector(".tk-eem-iframe").src = "about:blank";
      const dl = modal.querySelector(".tk-eem-dl");
      if (dl._urlToRevoke) { URL.revokeObjectURL(dl._urlToRevoke); dl._urlToRevoke = null; }
    });
  }
  modal.querySelector(".tk-eem-title").textContent = "External editor: " + attId;
  modal.querySelector(".tk-eem-iframe").src = baseUrl;
  modal.style.display = "flex";
  const dl = modal.querySelector(".tk-eem-dl");
  if (blob) {
    if (dl._urlToRevoke) URL.revokeObjectURL(dl._urlToRevoke);
    const url = URL.createObjectURL(blob);
    dl._urlToRevoke = url;
    dl.href = url;
    dl.setAttribute("download", attId);
    dl.style.display = "";
  } else {
    dl.style.display = "none";
  }
}

function _tektiteAttachmentCsvHtml(text, sep) {
  const rows = String(text || "").split(/\r?\n/).filter(r => r.length).slice(0, 500);
  if (!rows.length) return '<div class="tk-att-empty">(empty)</div>';
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  const header = rows[0].split(sep);
  let html = '<table class="tk-att-csv"><thead><tr>';
  for (const h of header) html += "<th>" + esc(h) + "</th>";
  html += "</tr></thead><tbody>";
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].split(sep);
    html += "<tr>";
    for (let j = 0; j < header.length; j++) html += "<td>" + esc(cells[j] || "") + "</td>";
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

/* Sprint 10t/10u -- intercept BOTH the initial popout open AND tab
 * switches so attachment ids land in the viewer instead of the
 * markdown editor.  The first-open path historically inlined the
 * note load inside _tektitePopoutOpen, which never reached the
 * tab-load wrap.  Symptom (10u): clicking an attachment showed an
 * empty markdown editor. */
function _tektitePatchPopoutHooks() {
  // Wrap _tektitePopoutLoadTab (tab switching).
  if (typeof _tektitePopoutLoadTab === "function" && !_tektitePopoutLoadTab._tk10tWrapped) {
    const original = _tektitePopoutLoadTab;
    _tektitePopoutLoadTab = async function (inst, noteId) {
      if (!noteId) return;
      if (_tektiteIsAttachmentId(noteId)) {
        try {
          const rec = await tektiteGetAttachment(noteId);
          if (rec && rec.blob) {
            inst.noteId = noteId;
            const titleEl = inst.dom && inst.dom.querySelector(".tektite-graph-popout-title");
            if (titleEl) titleEl.textContent = noteId;
            await _tektitePopoutLoadAttachment(inst, noteId);
            if (typeof _tektitePopoutSetStatus === "function") _tektitePopoutSetStatus(inst, "");
            return;
          }
        } catch (_) {}
      }
      _tektitePopoutShowMarkdownLayer(inst);
      return original(inst, noteId);
    };
    _tektitePopoutLoadTab._tk10tWrapped = true;
  }
  // Wrap _tektitePopoutOpen (first-open path).
  if (typeof _tektitePopoutOpen === "function" && !_tektitePopoutOpen._tk10tWrapped) {
    const originalOpen = _tektitePopoutOpen;
    _tektitePopoutOpen = async function (noteId) {
      const result = await originalOpen(noteId);
      // After the original open returns, if the loaded id is an
      // attachment, swap the markdown layer out for the viewer.
      // (originalOpen has already set inst.noteId + loaded the empty
      //  markdown -- harmless; we paint over it.)
      const inst = _tektitePopouts && _tektitePopouts.instances && _tektitePopouts.instances.get(noteId);
      if (inst && _tektiteIsAttachmentId(noteId)) {
        try {
          const rec = await tektiteGetAttachment(noteId);
          if (rec && rec.blob) {
            const titleEl = inst.dom && inst.dom.querySelector(".tektite-graph-popout-title");
            if (titleEl) titleEl.textContent = noteId;
            await _tektitePopoutLoadAttachment(inst, noteId);
          }
        } catch (_) {}
      }
      return result;
    };
    _tektitePopoutOpen._tk10tWrapped = true;
  }
}

(function _autoPatchPopoutHooks() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _tektitePatchPopoutHooks);
  } else {
    _tektitePatchPopoutHooks();
  }
})();

/* Drop-zone on the Tektite tab.  Any file dropped on the notes list
 * is imported into the vault attachments store + the list refreshes. */
function _tektiteWireAttachmentDropzone() {
  const list = document.getElementById("tektite-notes-list");
  if (!list || list._tk10tDz) return;
  list._tk10tDz = true;
  list.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      list.classList.add("tk-dropzone-active");
    }
  });
  list.addEventListener("dragleave", () => list.classList.remove("tk-dropzone-active"));
  list.addEventListener("drop", async (e) => {
    e.preventDefault();
    list.classList.remove("tk-dropzone-active");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    for (const f of files) {
      try { await tektiteImportFile(f); }
      catch (err) { console.warn("[tektite-attach] import failed for", f.name, err); }
    }
    if (typeof _tektiteTabRefresh === "function") await _tektiteTabRefresh();
  });
}

(function _autoWireDropzone() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _tektiteWireAttachmentDropzone);
  } else {
    _tektiteWireAttachmentDropzone();
  }
  // Tektite tab may not have rendered yet on boot; re-check periodically
  // for the first 5 s so the dropzone wires once the list mounts.
  let tries = 0;
  const t = setInterval(() => {
    _tektiteWireAttachmentDropzone();
    tries++;
    if (tries > 25) clearInterval(t);
  }, 200);
})();
