/* =========================================================================
 * Tektite MD -- sidebar tab
 *
 * Phase C sprint tektite-1. Renders inside #br-view-tektite:
 *   ┌────────────────────────────────────────────────┐
 *   │ [+ New note]  [filter…]               5 notes  │  ← toolbar
 *   ├────────────┬───────────────────────────────────┤
 *   │ note list  │  [title-input         ]           │
 *   │ (scrolls)  │  ┌──────────────────────────────┐ │
 *   │            │  │ markdown textarea           │ │
 *   │            │  └──────────────────────────────┘ │
 *   └────────────┴───────────────────────────────────┘
 *
 * Tab switching is hooked into the existing brSwitchTab() in
 * src/ui/node-browser.js by adding a "tektite" branch. The actual
 * tab-button + view-container HTML lives in src/shell.html.
 *
 * Click a note in the list → editor.js loads it into the textarea.
 * Type → debounced save via editor.js. List re-orders on save (most
 * recently modified bubbles to the top) without a full IDB re-query.
 *
 * Right-click a note → delete confirm (browser-native confirm()
 * dialog; a custom modal can replace it in a later sprint).
 *
 * Verification path: see storage.js. End-to-end -- create, type,
 * reload, the note persists with its content.
 * ======================================================================== */

const _tektiteTabState = {
  attached:    false,
  notes:       [],     // local cache, kept in sync with editor.onSave
  filterText:  "",
  listEl:      null,
  countEl:     null,
  filterInput: null
};

async function _tektiteTabRefresh() {
  const s = _tektiteTabState;
  s.notes = await tektiteListNotes();
  _tektiteTabRender();
}

function _tektiteTabRender() {
  const s = _tektiteTabState;
  if (!s.listEl) return;
  const filter = (s.filterText || "").toLowerCase().trim();
  const filtered = filter
    ? s.notes.filter(n => (n.title || n.id).toLowerCase().includes(filter) ||
                          (n.content || "").toLowerCase().includes(filter))
    : s.notes;

  // Count badge.
  if (s.countEl) {
    s.countEl.textContent = filtered.length === s.notes.length
      ? filtered.length + " note" + (filtered.length === 1 ? "" : "s")
      : filtered.length + " / " + s.notes.length + " notes";
  }

  if (!filtered.length) {
    s.listEl.innerHTML = `
      <div class="tektite-empty">
        ${s.notes.length === 0
          ? "No notes yet. Click <strong>+ New note</strong> to start your vault."
          : "No notes match the filter."}
      </div>`;
    return;
  }

  const currentId = tektiteEditorCurrentNoteId();
  const html = filtered.map(n => {
    const isActive = (n.id === currentId);
    const title    = _tektiteEscapeHtml(n.title || n.id);
    const snippet  = _tektiteEscapeHtml((n.content || "").slice(0, 80).replace(/\s+/g, " "));
    const ts       = _tektiteFormatRelativeTime(n.modifiedAt);
    return `<div class="tektite-note-item${isActive ? " active" : ""}" data-id="${_tektiteEscapeAttr(n.id)}">
      <div class="tektite-note-title">${title}</div>
      <div class="tektite-note-meta"><span class="tektite-note-ts">${ts}</span></div>
      ${snippet ? `<div class="tektite-note-snippet">${snippet}</div>` : ""}
    </div>`;
  }).join("");
  s.listEl.innerHTML = html;

  // Bind click handlers.
  s.listEl.querySelectorAll(".tektite-note-item").forEach(el => {
    const id = el.getAttribute("data-id");
    el.addEventListener("click", () => {
      tektiteEditorLoad(id).then(() => _tektiteTabRender());
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (window.confirm("Delete note \"" + (el.querySelector(".tektite-note-title")?.textContent || id) + "\"? This cannot be undone.")) {
        _tektiteTabDelete(id);
      }
    });
  });
}

function _tektiteEscapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function _tektiteEscapeAttr(s) {
  return _tektiteEscapeHtml(s);
}
function _tektiteFormatRelativeTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const dt = Date.now() - ms;
  if (dt < 60_000)        return "just now";
  if (dt < 3600_000)      return Math.floor(dt / 60_000) + "m ago";
  if (dt < 86400_000)     return Math.floor(dt / 3600_000) + "h ago";
  if (dt < 7 * 86400_000) return Math.floor(dt / 86400_000) + "d ago";
  const d = new Date(ms);
  return d.toLocaleDateString();
}

async function _tektiteTabCreate() {
  const base = "Untitled note";
  const id = await tektiteNextAvailableSlug(base);
  await tektitePutNote({
    id,
    title: base,
    content: "# " + base + "\n\n"
  });
  await _tektiteTabRefresh();
  await tektiteEditorLoad(id);
  _tektiteTabRender();
  // Focus the title for immediate rename.
  const titleInput = document.getElementById("tektite-title");
  if (titleInput) { titleInput.focus(); titleInput.select(); }
}

async function _tektiteTabDelete(id) {
  await tektiteDeleteNote(id);
  if (tektiteEditorCurrentNoteId() === id) {
    await tektiteEditorLoad(null);
  }
  await _tektiteTabRefresh();
}

/* Wire up button + filter handlers + editor save listener. Idempotent
 * -- safe to call multiple times; bails after first attach. */
function tektiteTabAttach() {
  const s = _tektiteTabState;
  if (s.attached) return;
  s.listEl      = document.getElementById("tektite-notes-list");
  s.countEl     = document.getElementById("tektite-notes-count");
  s.filterInput = document.getElementById("tektite-filter");
  if (!s.listEl) return;

  const newBtn = document.getElementById("btn-tektite-new");
  if (newBtn) newBtn.addEventListener("click", () => { _tektiteTabCreate(); });

  if (s.filterInput) {
    s.filterInput.addEventListener("input", () => {
      s.filterText = s.filterInput.value || "";
      _tektiteTabRender();
    });
  }

  // Editor wiring.
  const editorRoot = document.getElementById("tektite-editor-pane");
  if (editorRoot) tektiteEditorAttach(editorRoot);

  // When a save happens, update the local cache + re-render the list
  // (so the saved note bubbles to the top with fresh "just now" tag).
  tektiteEditorOnSave((record) => {
    const idx = s.notes.findIndex(n => n.id === record.id);
    if (idx >= 0) s.notes.splice(idx, 1);
    s.notes.unshift(record);
    _tektiteTabRender();
  });

  s.attached = true;
  _tektiteTabRefresh();
}
