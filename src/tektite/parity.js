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
