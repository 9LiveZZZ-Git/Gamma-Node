/* =========================================================================
 * Tektite MD -- minimal editor
 *
 * Phase C sprint tektite-1. Plain <textarea> bound to the currently
 * selected note. Saves on every keystroke via a 400 ms debounce so
 * the IDB write rate stays sane while still capturing every change
 * within half a second of the user pausing.
 *
 * CodeMirror swap-in is planned for tektite-2 along with the
 * wikilink autocomplete + live-preview pane. The textarea is
 * intentionally minimal here so sprint-1 ships with no CDN
 * dependency + zero load-time cost; users still get the
 * verification path (create / type / reload / persists) on the
 * smallest possible surface.
 *
 * Public surface:
 *   tektiteEditorAttach(rootEl)        -- wires DOM listeners on `rootEl`
 *                                          (must contain #tektite-editor + #tektite-title)
 *   tektiteEditorLoad(noteId)          -- loads a note into the editor (or "" to clear)
 *   tektiteEditorCurrentNoteId()       -- returns the id of the loaded note (or null)
 *   tektiteEditorMarkDirty()           -- schedules a debounced save
 *   tektiteEditorFlush()               -- forces an immediate save (called on close/reload)
 *
 * Listener: tektiteEditorOnSave(fn). Subscribers get { id, title, content }
 * after each persisted save -- used by the tab to refresh the note list
 * ordering without re-querying IDB.
 * ======================================================================== */

const _tektiteEditorState = {
  rootEl:       null,
  titleInput:   null,
  textarea:     null,
  currentId:    null,
  saveTimer:    null,
  saveDelayMs:  400,
  listeners:    new Set()
};

function tektiteEditorOnSave(fn) {
  if (typeof fn === "function") _tektiteEditorState.listeners.add(fn);
  return () => _tektiteEditorState.listeners.delete(fn);
}

function _tektiteEditorEmit(record) {
  for (const fn of _tektiteEditorState.listeners) {
    try { fn(record); } catch (e) { console.warn("[tektite] save listener threw:", e); }
  }
}

function tektiteEditorAttach(rootEl) {
  if (!rootEl) return;
  const s = _tektiteEditorState;
  s.rootEl     = rootEl;
  s.titleInput = rootEl.querySelector("#tektite-title");
  s.textarea   = rootEl.querySelector("#tektite-editor");
  if (!s.textarea) {
    console.warn("[tektite] editor textarea missing inside rootEl");
    return;
  }
  // Both title + body changes mark dirty + debounce-save.
  s.textarea.addEventListener("input", () => {
    if (!s.currentId) return;
    tektiteEditorMarkDirty();
  });
  if (s.titleInput) {
    s.titleInput.addEventListener("input", () => {
      if (!s.currentId) return;
      tektiteEditorMarkDirty();
    });
    // Pressing Enter in the title field jumps to the body.
    s.titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        s.textarea.focus();
      }
    });
  }
  // Flush pending save on page hide so reload-in-flight doesn't lose
  // the last few seconds of typing.
  window.addEventListener("beforeunload", () => { tektiteEditorFlush(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") tektiteEditorFlush();
  });
}

async function tektiteEditorLoad(noteId) {
  const s = _tektiteEditorState;
  // Flush any pending changes on the previously-loaded note before swapping.
  if (s.currentId && s.currentId !== noteId) await tektiteEditorFlush();
  if (!noteId) {
    s.currentId = null;
    if (s.titleInput) { s.titleInput.value = ""; s.titleInput.disabled = true; }
    if (s.textarea)   { s.textarea.value   = ""; s.textarea.disabled   = true; }
    return;
  }
  const note = await tektiteGetNote(noteId);
  if (!note) {
    s.currentId = null;
    if (s.titleInput) s.titleInput.value = "";
    if (s.textarea)   s.textarea.value   = "(note not found)";
    return;
  }
  s.currentId = note.id;
  if (s.titleInput) { s.titleInput.value = note.title || note.id; s.titleInput.disabled = false; }
  if (s.textarea)   { s.textarea.value   = note.content || "";    s.textarea.disabled   = false; }
}

function tektiteEditorCurrentNoteId() {
  return _tektiteEditorState.currentId;
}

function tektiteEditorMarkDirty() {
  const s = _tektiteEditorState;
  if (!s.currentId) return;
  if (s.saveTimer) clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => { tektiteEditorFlush(); }, s.saveDelayMs);
}

async function tektiteEditorFlush() {
  const s = _tektiteEditorState;
  if (s.saveTimer) { clearTimeout(s.saveTimer); s.saveTimer = null; }
  if (!s.currentId || !s.textarea) return;
  const title   = (s.titleInput && s.titleInput.value || s.currentId).trim();
  const content = s.textarea.value || "";
  const existing = await tektiteGetNote(s.currentId);
  const record = await tektitePutNote({
    id:        s.currentId,
    title:     title || s.currentId,
    content,
    createdAt: existing && existing.createdAt
  });
  _tektiteEditorEmit(record);
}
