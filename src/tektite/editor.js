/* =========================================================================
 * Tektite MD -- editor (CodeMirror 6 + textarea fallback)
 *
 * Phase C sprint tektite-1 (textarea) + tektite-1.5b (source-aware) +
 * tektite-2 (CodeMirror swap-in + wikilink decoration).
 *
 * CodeMirror is loaded lazily by src/tektite/markdown.js on the first
 * tektiteEditorAttach call. If the CDN fetch fails (offline / blocked),
 * the editor stays on the textarea fallback so basic editing still
 * works.
 *
 * Save dispatches based on the loaded note's source:
 *   - vault    -> tektitePutNote (IDB)
 *   - local-fs -> File System Access API write (lazily requests rw perm)
 *   - github   -> Contents API PUT (uses cached sha; refreshes on conflict)
 *   - gdrive   -> throws (stub; secrets-manager sprint will land it)
 *
 * Public surface:
 *   tektiteEditorAttach(rootEl)
 *   tektiteEditorLoad(noteId)
 *           -- legacy vault-only loader
 *   tektiteEditorLoadFromSource(sourceId, fileId)
 *           -- source-aware loader
 *   tektiteEditorCurrentNoteId()    / tektiteEditorCurrentSourceId()
 *   tektiteEditorMarkDirty() / tektiteEditorFlush()
 *   tektiteEditorOnSave(fn)
 *   tektiteEditorNavigateToWikilink(target)
 *           -- sprint 2 hook called by the wikilink ctrl-click handler
 *
 * Save events carry { sourceId, fileId, title, content, modifiedAt }.
 * ======================================================================== */

const _tektiteEditorState = {
  rootEl:         null,
  titleInput:     null,
  textarea:       null,       // fallback textarea reference
  cmContainer:    null,       // CodeMirror host div
  cm:             null,       // CodeMirror handle (from markdown.js); null if fallback
  cmLoading:      null,       // in-flight attach promise
  currentId:      null,
  currentSource:  null,
  saveTimer:      null,
  saveDelayMs:    400,
  saving:         false,
  pendingSave:    false,
  statusEl:       null,
  navigateFn:     null,       // tab.js sets this so wikilink ctrl-click can open notes
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

/* Wikilink ctrl-click navigation. The tab module is responsible for
 * resolving the target id to a (sourceId, fileId) pair and loading it;
 * we just forward the click. */
function tektiteEditorSetWikilinkNavigator(fn) {
  _tektiteEditorState.navigateFn = (typeof fn === "function") ? fn : null;
}

function tektiteEditorNavigateToWikilink(target) {
  const s = _tektiteEditorState;
  if (s.navigateFn) s.navigateFn(target);
}

/* Read + write helpers that hide whether we're using CM or textarea. */
function _tektiteEditorGetText() {
  const s = _tektiteEditorState;
  if (s.cm) return s.cm.getDoc();
  if (s.textarea) return s.textarea.value || "";
  return "";
}

function _tektiteEditorSetText(text) {
  const s = _tektiteEditorState;
  if (s.cm) { s.cm.setDoc(text || ""); return; }
  if (s.textarea) s.textarea.value = text || "";
}

function _tektiteEditorSetReadOnly(ro) {
  const s = _tektiteEditorState;
  if (s.cm) {
    try { s.cm.setReadOnly(!!ro); } catch (e) {
      console.warn("[tektite] CM setReadOnly failed:", e);
    }
    return;
  }
  if (s.textarea) s.textarea.disabled = !!ro;
}

async function _tektiteEditorEnsureCodeMirror() {
  const s = _tektiteEditorState;
  if (s.cm || s.cmLoading) return s.cmLoading;
  if (!s.cmContainer) return null;
  s.cmLoading = (async () => {
    const handle = await tektiteMarkdownAttach(s.cmContainer, _tektiteEditorGetText(), {
      onChange: () => {
        if (!s.currentId) return;
        tektiteEditorMarkDirty();
      },
      onWikilinkClick: (target) => tektiteEditorNavigateToWikilink(target),
      readOnly: s.textarea ? !!s.textarea.disabled : false
    });
    if (handle) {
      s.cm = handle;
      // Hide the textarea fallback; CM owns the surface now.
      if (s.textarea) s.textarea.style.display = "none";
    }
    return handle;
  })();
  return s.cmLoading;
}

function tektiteEditorAttach(rootEl) {
  if (!rootEl) return;
  const s = _tektiteEditorState;
  if (s.rootEl === rootEl) return;   // idempotent
  s.rootEl      = rootEl;
  s.titleInput  = rootEl.querySelector("#tektite-title");
  s.textarea    = rootEl.querySelector("#tektite-editor");
  s.cmContainer = rootEl.querySelector("#tektite-cm");
  s.statusEl    = document.getElementById("tektite-editor-status");
  if (!s.textarea && !s.cmContainer) {
    console.warn("[tektite] editor host element missing");
    return;
  }

  // Fallback wiring: textarea input fires mark-dirty.
  if (s.textarea) {
    s.textarea.addEventListener("input", () => {
      if (!s.currentId) return;
      // If CM has taken over the surface, the textarea is hidden +
      // doesn't receive input events. Only the fallback hits this.
      if (s.cm) return;
      tektiteEditorMarkDirty();
    });
  }

  if (s.titleInput) {
    s.titleInput.addEventListener("input", () => {
      if (!s.currentId) return;
      if (s.currentSource === "vault") tektiteEditorMarkDirty();
    });
    s.titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (s.cm) s.cm.focus();
        else if (s.textarea) s.textarea.focus();
      }
    });
  }

  // Flush on hide/unload so reload-in-flight + tab-switch don't lose
  // the last few seconds of typing.
  window.addEventListener("beforeunload", () => { tektiteEditorFlush(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") tektiteEditorFlush();
  });

  // Lazy-init CodeMirror on first attach. The promise resolves silently
  // when CM is ready; if it fails the textarea fallback stays visible.
  _tektiteEditorEnsureCodeMirror();
}

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
  _tektiteEditorSetText("");
  _tektiteEditorSetReadOnly(true);
  _tektiteSetStatus("");
}

async function tektiteEditorLoadFromSource(sourceId, fileId) {
  const s = _tektiteEditorState;
  if (!sourceId || !fileId) { await _tektiteEditorClear(); return; }
  if (s.currentId && (s.currentId !== fileId || s.currentSource !== sourceId)) {
    await tektiteEditorFlush();
  }
  _tektiteSetStatus("Loading…");
  try {
    const content = await tektiteSourceGetContent(sourceId, fileId);
    s.currentId     = fileId;
    s.currentSource = sourceId;
    let title = fileId;
    try {
      const listing = await tektiteSourceListNotes(sourceId);
      const hit = listing.find(n => n.id === fileId);
      if (hit) title = hit.title || fileId;
    } catch (_) {}
    if (s.titleInput) {
      s.titleInput.value = title;
      s.titleInput.disabled = (sourceId !== "vault");
    }
    _tektiteEditorSetText(content || "");
    const writable = (typeof tektiteSourceIsWritable === "function")
      ? tektiteSourceIsWritable(sourceId)
      : (sourceId === "vault" ? "vault" : null);
    _tektiteEditorSetReadOnly(!writable);
    _tektiteSetStatus("");
  } catch (e) {
    s.currentId     = null;
    s.currentSource = null;
    if (s.titleInput) s.titleInput.value = "";
    _tektiteEditorSetText("Failed to load: " + (e.message || e));
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
  if (!s.currentId) return;
  if (s.saving) { s.pendingSave = true; return; }
  s.saving = true;
  const sourceId = s.currentSource || "vault";
  const fileId   = s.currentId;
  const title    = (s.titleInput && s.titleInput.value || fileId).trim();
  const content  = _tektiteEditorGetText();
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
      setTimeout(() => tektiteEditorFlush(), 80);
    }
  }
}
