/* =========================================================================
 * Tektite MD -- minimal editor
 *
 * Phase C sprint tektite-1 (initial) + tektite-1.5b (source-aware).
 *
 * Plain <textarea> bound to the currently selected note. Saves on
 * every keystroke via a 400 ms debounce. The save dispatches based
 * on the loaded note's source:
 *   - vault    -> tektitePutNote (IDB)
 *   - local-fs -> File System Access API write (lazily requests rw perm)
 *   - github   -> Contents API PUT (uses cached sha; refreshes on conflict)
 *   - gdrive   -> throws (stub; secrets-manager sprint will land it)
 *
 * Title-rename for local-fs / github writes goes to the same path
 * (the file's path on disk / repo doesn't change just because the
 * Markdown's first heading does). The title field is therefore a
 * display hint for vault notes only; for remote sources, it's
 * effectively read-only and shown for context.
 *
 * Public surface:
 *   tektiteEditorAttach(rootEl)
 *   tektiteEditorLoad(noteId)
 *           -- legacy vault-only loader (kept for back-compat)
 *   tektiteEditorLoadFromSource(sourceId, fileId)
 *           -- the new source-aware loader; both vault + remote
 *   tektiteEditorCurrentNoteId()    -- the loaded fileId (any source)
 *   tektiteEditorCurrentSourceId()  -- the source the loaded note came from
 *   tektiteEditorMarkDirty()
 *   tektiteEditorFlush()
 *   tektiteEditorOnSave(fn)         -- subscribes to save events
 *
 * Save events carry { sourceId, fileId, title, content, modifiedAt }.
 * ======================================================================== */

const _tektiteEditorState = {
  rootEl:         null,
  titleInput:     null,
  textarea:       null,
  currentId:      null,
  currentSource:  null,
  saveTimer:      null,
  saveDelayMs:    400,
  saving:         false,
  pendingSave:    false,
  statusEl:       null,
  listeners:      new Set()
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

function _tektiteSetStatus(text, kind) {
  const s = _tektiteEditorState;
  if (!s.statusEl) return;
  s.statusEl.textContent = text || "";
  s.statusEl.className = "tektite-editor-status" + (kind ? (" " + kind) : "");
}

function tektiteEditorAttach(rootEl) {
  if (!rootEl) return;
  const s = _tektiteEditorState;
  s.rootEl     = rootEl;
  s.titleInput = rootEl.querySelector("#tektite-title");
  s.textarea   = rootEl.querySelector("#tektite-editor");
  s.statusEl   = document.getElementById("tektite-editor-status");
  if (!s.textarea) {
    console.warn("[tektite] editor textarea missing inside rootEl");
    return;
  }
  s.textarea.addEventListener("input", () => {
    if (!s.currentId) return;
    tektiteEditorMarkDirty();
  });
  if (s.titleInput) {
    s.titleInput.addEventListener("input", () => {
      if (!s.currentId) return;
      // Title is only meaningful for vault saves; remote sources
      // ignore it on flush.
      if (s.currentSource === "vault") tektiteEditorMarkDirty();
    });
    s.titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); s.textarea.focus(); }
    });
  }
  // Flush on hide/unload so reload-in-flight + tab-switch don't lose
  // the last few seconds of typing. fire-and-forget (async).
  window.addEventListener("beforeunload", () => { tektiteEditorFlush(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") tektiteEditorFlush();
  });
}

/* Back-compat: load a vault note by its IDB id. New code should
 * prefer tektiteEditorLoadFromSource("vault", id). */
async function tektiteEditorLoad(noteId) {
  if (!noteId) return _tektiteEditorClear();
  return await tektiteEditorLoadFromSource("vault", noteId);
}

async function _tektiteEditorClear() {
  const s = _tektiteEditorState;
  await tektiteEditorFlush();
  s.currentId     = null;
  s.currentSource = null;
  if (s.titleInput) { s.titleInput.value = ""; s.titleInput.disabled = true; }
  if (s.textarea)   { s.textarea.value   = ""; s.textarea.disabled   = true; }
  _tektiteSetStatus("");
}

async function tektiteEditorLoadFromSource(sourceId, fileId) {
  const s = _tektiteEditorState;
  if (!sourceId || !fileId) { await _tektiteEditorClear(); return; }
  // Flush the previous note (if any) before swapping.
  if (s.currentId && (s.currentId !== fileId || s.currentSource !== sourceId)) {
    await tektiteEditorFlush();
  }
  _tektiteSetStatus("Loading…");
  try {
    const content = await tektiteSourceGetContent(sourceId, fileId);
    s.currentId     = fileId;
    s.currentSource = sourceId;
    // Pull title from the listing if available (vault has rich titles;
    // local-fs uses filename; github uses filename minus .md).
    let title = fileId;
    try {
      const listing = await tektiteSourceListNotes(sourceId);
      const hit = listing.find(n => n.id === fileId);
      if (hit) title = hit.title || fileId;
    } catch (_) {}
    if (s.titleInput) {
      s.titleInput.value = title;
      // Title editing only matters for vault; remote sources have
      // their filename pinned. Disable rather than ignore so users
      // see why.
      s.titleInput.disabled = (sourceId !== "vault");
    }
    if (s.textarea) {
      s.textarea.value = content || "";
      const writable = (typeof tektiteSourceIsWritable === "function")
        ? tektiteSourceIsWritable(sourceId)
        : (sourceId === "vault" ? "vault" : null);
      s.textarea.disabled = !writable;
    }
    _tektiteSetStatus("");
  } catch (e) {
    s.currentId     = null;
    s.currentSource = null;
    if (s.titleInput) s.titleInput.value = "";
    if (s.textarea)   s.textarea.value   = "Failed to load: " + (e.message || e);
    _tektiteSetStatus("error", "err");
  }
}

function tektiteEditorCurrentNoteId()   { return _tektiteEditorState.currentId; }
function tektiteEditorCurrentSourceId() { return _tektiteEditorState.currentSource; }

function tektiteEditorMarkDirty() {
  const s = _tektiteEditorState;
  if (!s.currentId) return;
  if (s.saveTimer) clearTimeout(s.saveTimer);
  _tektiteSetStatus("Editing…", "dirty");
  s.saveTimer = setTimeout(() => { tektiteEditorFlush(); }, s.saveDelayMs);
}

async function tektiteEditorFlush() {
  const s = _tektiteEditorState;
  if (s.saveTimer) { clearTimeout(s.saveTimer); s.saveTimer = null; }
  if (!s.currentId || !s.textarea) return;
  // If a save is already in flight, queue exactly one follow-up so
  // we capture the latest content without piling up a queue of
  // identical writes.
  if (s.saving) { s.pendingSave = true; return; }
  s.saving = true;
  const sourceId = s.currentSource || "vault";
  const fileId   = s.currentId;
  const title    = (s.titleInput && s.titleInput.value || fileId).trim();
  const content  = s.textarea.value || "";
  _tektiteSetStatus("Saving…", "saving");
  try {
    const result = await tektiteSourceWriteContent(sourceId, fileId, content, { title });
    const recordedId = (result && result.id) || fileId;
    s.currentId = recordedId;
    _tektiteEditorEmit({
      sourceId, fileId: recordedId, title, content,
      modifiedAt: Date.now()
    });
    _tektiteSetStatus("Saved", "ok");
    // Briefly clear the "Saved" badge so it's not a permanent fixture.
    setTimeout(() => {
      if (_tektiteEditorState.statusEl &&
          _tektiteEditorState.statusEl.textContent === "Saved") {
        _tektiteSetStatus("");
      }
    }, 1500);
  } catch (e) {
    _tektiteSetStatus("✗ " + (e.message || String(e)), "err");
    console.warn("[tektite] save failed:", e);
  } finally {
    s.saving = false;
    if (s.pendingSave) {
      s.pendingSave = false;
      // Run the queued save with a tiny delay so a typing burst
      // doesn't spin three+ writes back to back.
      setTimeout(() => tektiteEditorFlush(), 80);
    }
  }
}
