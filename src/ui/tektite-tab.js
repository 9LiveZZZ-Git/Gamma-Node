/* =========================================================================
 * Tektite MD -- sidebar tab
 *
 * Phase C sprints tektite-1 + tektite-1.5. Renders inside #br-view-tektite:
 *   ┌────────────────────────────────────────────────┐
 *   │ Sources: [Vault] [Local A] [GH foo/bar] [+]    │  ← sprint 1.5
 *   ├────────────────────────────────────────────────┤
 *   │ [+ New note]  [filter…]               5 notes  │  ← toolbar
 *   ├────────────┬───────────────────────────────────┤
 *   │ note list  │  [title-input         ]           │
 *   │ (scrolls)  │  ┌──────────────────────────────┐ │
 *   │            │  │ markdown textarea           │ │
 *   │            │  └──────────────────────────────┘ │
 *   └────────────┴───────────────────────────────────┘
 *
 * Sprint tektite-1.5 -- source rail:
 *   The vault chip is always present; the user adds Local-FS / GitHub
 *   sources via a connect modal (#tektite-connect-modal). Switching to
 *   a remote source loads its file listing in place of the vault's IDB
 *   notes; clicking a note loads the content read-only into the editor.
 *   A "Save to vault" button copies the remote content into IDB so the
 *   user can edit normally.
 *
 * Tab switching is hooked into the existing brSwitchTab() in
 * src/ui/node-browser.js by adding a "tektite" branch.  Click a note
 * in the list → editor.js loads it.  Type → debounced save via
 * editor.js (vault source only; remote sources are read-only).
 * ======================================================================== */

const _tektiteTabState = {
  attached:     false,
  notes:        [],     // current source's listing
  activeSource: "vault",
  filterText:   "",
  listEl:       null,
  countEl:      null,
  filterInput:  null,
  sourceRailEl: null,
  saveToVaultBtnEl: null
};

async function _tektiteTabRefresh() {
  const s = _tektiteTabState;
  try {
    s.notes = await tektiteSourceListNotes(s.activeSource);
  } catch (e) {
    s.notes = [];
    console.warn("[tektite] source list failed:", e);
    if (s.listEl) {
      s.listEl.innerHTML = `<div class="tektite-empty">⚠ ${_tektiteEscapeHtml(e.message || String(e))}</div>`;
    }
  }
  _tektiteTabRenderSources();
  _tektiteTabRender();
}

function _tektiteTabRenderSources() {
  const s = _tektiteTabState;
  if (!s.sourceRailEl) return;
  const sources = tektiteSourcesList();
  const chips = sources.map(src => {
    const isActive = (src.id === s.activeSource);
    const icon = src.type === "vault"    ? "■"
              : src.type === "local-fs"  ? "⌂"
              : src.type === "github"    ? "⬡"
              : src.type === "gdrive"    ? "◐" : "?";
    const removable = !src.permanent;
    return `<div class="tektite-source-chip ${isActive ? "active" : ""}" data-id="${_tektiteEscapeAttr(src.id)}" title="${_tektiteEscapeAttr(src.path || "")}">
      <span class="tektite-source-icon">${icon}</span>
      <span class="tektite-source-name">${_tektiteEscapeHtml(src.name)}</span>
      ${removable ? `<button class="tektite-source-x" data-remove="${_tektiteEscapeAttr(src.id)}" title="Disconnect this source">×</button>` : ""}
    </div>`;
  }).join("");
  s.sourceRailEl.innerHTML = chips + `
    <button class="btn tektite-source-add" id="btn-tektite-connect-source" type="button" title="Connect a Local folder, GitHub repo, or Google Drive">+ Connect</button>`;
  s.sourceRailEl.querySelectorAll(".tektite-source-chip").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target && e.target.classList.contains("tektite-source-x")) return;
      const id = el.getAttribute("data-id");
      if (id && id !== s.activeSource) {
        s.activeSource = id;
        // Switching source -- drop the currently-loaded note since its
        // id won't be valid in the new source's listing.
        tektiteEditorLoad(null);
        _tektiteTabRefresh();
      }
    });
  });
  s.sourceRailEl.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-remove");
      if (window.confirm("Disconnect this source? Files stay on disk / GitHub; you can re-connect any time.")) {
        tektiteSourcesRemove(id);
        if (s.activeSource === id) s.activeSource = "vault";
        tektiteEditorLoad(null);
        _tektiteTabRefresh();
      }
    });
  });
  const connectBtn = document.getElementById("btn-tektite-connect-source");
  if (connectBtn) connectBtn.addEventListener("click", _tektiteOpenConnectModal);
}

function _tektiteTabRender() {
  const s = _tektiteTabState;
  if (!s.listEl) return;
  const filter = (s.filterText || "").toLowerCase().trim();
  const filtered = filter
    ? s.notes.filter(n => (n.title || n.id).toLowerCase().includes(filter))
    : s.notes;

  // Count badge.
  if (s.countEl) {
    s.countEl.textContent = filtered.length === s.notes.length
      ? filtered.length + " note" + (filtered.length === 1 ? "" : "s")
      : filtered.length + " / " + s.notes.length + " notes";
  }

  // Toggle the "+ New note" button -- only vault is writable.
  const newBtn = document.getElementById("btn-tektite-new");
  if (newBtn) {
    newBtn.disabled = (s.activeSource !== "vault");
    newBtn.title = newBtn.disabled
      ? "New notes can only be created in the Vault. Switch to Vault, or import a remote note via 'Save to vault'."
      : "Create a new note in the Vault";
  }

  if (!filtered.length) {
    s.listEl.innerHTML = `
      <div class="tektite-empty">
        ${s.notes.length === 0
          ? (s.activeSource === "vault"
              ? "No notes yet. Click <strong>+ New note</strong> to start your vault."
              : "No markdown files found in this source.")
          : "No notes match the filter."}
      </div>`;
    return;
  }

  const currentId = tektiteEditorCurrentNoteId();
  const html = filtered.map(n => {
    const isActive = (n.id === currentId);
    const title    = _tektiteEscapeHtml(n.title || n.id);
    const ts       = n.modifiedAt ? _tektiteFormatRelativeTime(n.modifiedAt) : "";
    const path     = (s.activeSource === "vault") ? "" : `<span class="tektite-note-path">${_tektiteEscapeHtml(n.path || "")}</span>`;
    return `<div class="tektite-note-item${isActive ? " active" : ""}" data-id="${_tektiteEscapeAttr(n.id)}">
      <div class="tektite-note-title">${title}</div>
      <div class="tektite-note-meta">${ts ? `<span class="tektite-note-ts">${ts}</span>` : ""}${path}</div>
    </div>`;
  }).join("");
  s.listEl.innerHTML = html;

  // Bind click handlers -- different for vault vs. remote sources.
  s.listEl.querySelectorAll(".tektite-note-item").forEach(el => {
    const id = el.getAttribute("data-id");
    el.addEventListener("click", async () => {
      if (s.activeSource === "vault") {
        await tektiteEditorLoad(id);
        _tektiteTabRender();
      } else {
        await _tektiteTabLoadRemote(id);
      }
    });
    if (s.activeSource === "vault") {
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (window.confirm("Delete note \"" + (el.querySelector(".tektite-note-title")?.textContent || id) + "\"? This cannot be undone.")) {
          _tektiteTabDelete(id);
        }
      });
    }
  });
}

/* Load a remote note into the editor in read-only mode + reveal the
 * "Save to vault" button. Reading from a freshly-connected GitHub
 * source warms the file cache lazily; subsequent loads are fast. */
async function _tektiteTabLoadRemote(fileId) {
  const s = _tektiteTabState;
  const titleInput = document.getElementById("tektite-title");
  const textarea   = document.getElementById("tektite-editor");
  const note = s.notes.find(n => n.id === fileId);
  if (titleInput) {
    titleInput.value = note ? (note.title || fileId) : fileId;
    titleInput.disabled = true;  // read-only
  }
  if (textarea) {
    textarea.value = "Loading…";
    textarea.disabled = true;
  }
  try {
    const content = await tektiteSourceGetContent(s.activeSource, fileId);
    if (textarea) textarea.value = content || "";
  } catch (e) {
    if (textarea) textarea.value = "⚠ Failed to load: " + (e.message || e);
  }
  // Wire the "Save to vault" affordance.
  if (s.saveToVaultBtnEl) {
    s.saveToVaultBtnEl.style.display = "inline-block";
    s.saveToVaultBtnEl.disabled = false;
    s.saveToVaultBtnEl._sourceId = s.activeSource;
    s.saveToVaultBtnEl._fileId   = fileId;
  }
  // Highlight in list -- we don't use editor's currentId for remote
  // notes (the editor stays in "not loaded" state) so highlight by
  // tagging the list manually.
  s.listEl.querySelectorAll(".tektite-note-item").forEach(el => {
    el.classList.toggle("active", el.getAttribute("data-id") === fileId);
  });
}

function _tektiteEscapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function _tektiteEscapeAttr(s) { return _tektiteEscapeHtml(s); }
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
  const s = _tektiteTabState;
  if (s.activeSource !== "vault") {
    window.alert("New notes can only be created in the Vault. Switch to the Vault chip first.");
    return;
  }
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

/* Connect-modal handling. Tektite has its own modal (separate from
 * the assets browser's #connect-modal) because the field semantics
 * differ slightly: we filter for `.md` files, label sources for vault
 * pull, and the GitHub PAT note explicitly references the deferred
 * secrets-manager phase. */
function _tektiteOpenConnectModal() {
  const m = document.getElementById("tektite-connect-modal");
  if (!m) return;
  m.style.display = "flex";
  _tektiteConnectSelectProvider("local");
}
function _tektiteCloseConnectModal() {
  const m = document.getElementById("tektite-connect-modal");
  if (m) m.style.display = "none";
}
function _tektiteConnectSelectProvider(provider) {
  document.querySelectorAll("#tektite-connect-providers .provider").forEach(el => {
    el.classList.toggle("selected", el.getAttribute("data-provider") === provider);
  });
  document.getElementById("tektite-connect-form-local").style.display = provider === "local" ? "" : "none";
  document.getElementById("tektite-connect-form-github").style.display = provider === "github" ? "" : "none";
  document.getElementById("tektite-connect-form-gdrive").style.display = provider === "gdrive" ? "" : "none";
  _tektiteTabState._connectProvider = provider;
}
async function _tektiteConnectGo() {
  const provider = _tektiteTabState._connectProvider || "local";
  try {
    if (provider === "local") {
      const label = (document.getElementById("tektite-connect-local-name") || {}).value || "";
      const src = await tektiteSourcesAddLocal({ label });
      _tektiteTabState.activeSource = src.id;
    } else if (provider === "github") {
      const repo  = (document.getElementById("tektite-connect-gh-repo")  || {}).value || "";
      const path  = (document.getElementById("tektite-connect-gh-path")  || {}).value || "";
      const token = (document.getElementById("tektite-connect-gh-token") || {}).value || "";
      const label = (document.getElementById("tektite-connect-gh-label") || {}).value || "";
      const src = await tektiteSourcesAddGithub({ repo, path, token, label });
      _tektiteTabState.activeSource = src.id;
    } else if (provider === "gdrive") {
      tektiteSourcesAddDrive();  // throws
    }
    _tektiteCloseConnectModal();
    tektiteEditorLoad(null);
    _tektiteTabRefresh();
  } catch (e) {
    window.alert("Connect failed: " + (e.message || String(e)));
  }
}

async function _tektiteSaveToVault() {
  const s = _tektiteTabState;
  const btn = s.saveToVaultBtnEl;
  if (!btn || !btn._sourceId || !btn._fileId) return;
  btn.disabled = true;
  try {
    const newId = await tektiteSourceImportToVault(btn._sourceId, btn._fileId);
    s.activeSource = "vault";
    await _tektiteTabRefresh();
    await tektiteEditorLoad(newId);
    if (btn) btn.style.display = "none";
    _tektiteTabRender();
  } catch (e) {
    window.alert("Save to vault failed: " + (e.message || String(e)));
  } finally {
    btn.disabled = false;
  }
}

/* Wire up button + filter handlers + editor save listener. Idempotent
 * -- safe to call multiple times; bails after first attach. */
function tektiteTabAttach() {
  const s = _tektiteTabState;
  if (s.attached) return;
  s.listEl       = document.getElementById("tektite-notes-list");
  s.countEl      = document.getElementById("tektite-notes-count");
  s.filterInput  = document.getElementById("tektite-filter");
  s.sourceRailEl = document.getElementById("tektite-source-rail");
  s.saveToVaultBtnEl = document.getElementById("btn-tektite-save-to-vault");
  if (!s.listEl) return;

  const newBtn = document.getElementById("btn-tektite-new");
  if (newBtn) newBtn.addEventListener("click", () => { _tektiteTabCreate(); });

  if (s.filterInput) {
    s.filterInput.addEventListener("input", () => {
      s.filterText = s.filterInput.value || "";
      _tektiteTabRender();
    });
  }

  // Editor wiring (vault writes only).
  const editorRoot = document.getElementById("tektite-editor-pane");
  if (editorRoot) tektiteEditorAttach(editorRoot);

  // When a vault save happens, refresh the listing IF we're on vault.
  tektiteEditorOnSave((record) => {
    if (s.activeSource !== "vault") return;
    const idx = s.notes.findIndex(n => n.id === record.id);
    const listingEntry = {
      id: record.id, title: record.title, path: record.id,
      modifiedAt: record.modifiedAt, sourceId: "vault"
    };
    if (idx >= 0) s.notes.splice(idx, 1);
    s.notes.unshift(listingEntry);
    _tektiteTabRender();
  });

  // Connect-modal wiring.
  document.querySelectorAll("#tektite-connect-providers .provider").forEach(el => {
    el.addEventListener("click", () => _tektiteConnectSelectProvider(el.getAttribute("data-provider")));
  });
  const closeBtn = document.getElementById("tektite-connect-close");
  if (closeBtn) closeBtn.addEventListener("click", _tektiteCloseConnectModal);
  const cancelBtn = document.getElementById("tektite-connect-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", _tektiteCloseConnectModal);
  const goBtn = document.getElementById("tektite-connect-go");
  if (goBtn) goBtn.addEventListener("click", _tektiteConnectGo);

  if (s.saveToVaultBtnEl) {
    s.saveToVaultBtnEl.addEventListener("click", _tektiteSaveToVault);
    s.saveToVaultBtnEl.style.display = "none";
  }

  s.attached = true;
  _tektiteTabRefresh();
}
