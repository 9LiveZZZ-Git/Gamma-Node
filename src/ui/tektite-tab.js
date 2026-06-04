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
  attached:        false,
  notes:           [],     // current source's listing
  activeSource:    "vault",
  filterText:      "",
  listEl:          null,
  countEl:         null,
  filterInput:     null,
  sourceRailEl:    null,
  saveToVaultBtnEl: null,
  fullscreen:      false,
  backlinksEl:     null
};

/* Sprint tektite-2 -- wikilink navigation. Resolves a [[target]] in
 * priority order: vault notes by id → vault notes by case-insensitive
 * title → other writable sources by filename. If nothing matches,
 * offers to create a new vault note under that name. */
async function _tektiteNavigateWikilink(target) {
  if (!target) return;
  const s = _tektiteTabState;
  const targetLc = target.toLowerCase();

  // 1. Try as a vault id (slug match).
  const vaultHit = await tektiteGetNote(target);
  if (vaultHit) {
    s.activeSource = "vault";
    await _tektiteTabRefresh();
    await tektiteEditorLoadFromSource("vault", vaultHit.id);
    _tektiteTabRender();
    return;
  }
  // 2. Try as a vault title (case-insensitive).
  const vaultList = await tektiteListNotes();
  const titleHit = vaultList.find(n => (n.title || n.id).toLowerCase() === targetLc);
  if (titleHit) {
    s.activeSource = "vault";
    await _tektiteTabRefresh();
    await tektiteEditorLoadFromSource("vault", titleHit.id);
    _tektiteTabRender();
    return;
  }
  // 3. Walk other sources (local-fs / github) for filename matches.
  const sources = tektiteSourcesList();
  for (const src of sources) {
    if (src.id === "vault") continue;
    try {
      const listing = await tektiteSourceListNotes(src.id);
      const fileHit = listing.find(n =>
        (n.title || "").toLowerCase() === targetLc ||
        (n.path  || "").toLowerCase() === targetLc ||
        (n.path  || "").toLowerCase().endsWith("/" + targetLc + ".md"));
      if (fileHit) {
        s.activeSource = src.id;
        await _tektiteTabRefresh();
        await tektiteEditorLoadFromSource(src.id, fileHit.id);
        _tektiteTabRender();
        return;
      }
    } catch (_) {}
  }
  // 4. Nothing matched -- offer to create. Only when vault is writable.
  if (tektiteSourceIsWritable("vault") &&
      window.confirm("No note named \"" + target + "\" found. Create one in the Vault?")) {
    try {
      const newId = await tektiteSourceCreateNote("vault", target);
      s.activeSource = "vault";
      await _tektiteTabRefresh();
      await tektiteEditorLoadFromSource("vault", newId);
      _tektiteTabRender();
    } catch (e) {
      window.alert("Create failed: " + (e.message || e));
    }
  }
}

/* Render the backlinks panel for the currently-loaded note. Vault-only
 * for sprint 2 -- remote-source backlinks need an async cross-source
 * walk that lands in sprint tektite-3. */
async function _tektiteRenderBacklinks() {
  const s = _tektiteTabState;
  if (!s.backlinksEl) return;
  const noteId = tektiteEditorCurrentNoteId();
  const sourceId = tektiteEditorCurrentSourceId();
  if (!noteId || sourceId !== "vault") {
    s.backlinksEl.innerHTML = `
      <div class="tektite-backlinks-header">Backlinks</div>
      <div class="tektite-backlinks-empty">${noteId ? "Backlinks are vault-only for now." : "Select a note to see incoming links."}</div>`;
    return;
  }
  await tektiteBacklinksEnsureReady();
  // Look up incoming for both the slug id AND the displayed title --
  // users may [[link]] by either.
  const note = await tektiteGetNote(noteId);
  const incomingById    = tektiteBacklinksGetIncoming(noteId);
  const incomingByTitle = (note && note.title && note.title !== noteId)
    ? tektiteBacklinksGetIncoming(note.title)
    : [];
  // Merge dedup by sourceId.
  const seen = new Set();
  const incoming = [];
  for (const e of incomingById.concat(incomingByTitle)) {
    if (seen.has(e.noteId) || e.noteId === noteId) continue;
    seen.add(e.noteId);
    incoming.push(e);
  }

  const header = `<div class="tektite-backlinks-header">Backlinks <span class="tektite-backlinks-count">${incoming.length}</span></div>`;
  if (!incoming.length) {
    s.backlinksEl.innerHTML = header +
      `<div class="tektite-backlinks-empty">No notes link here yet. Add <code>[[${_tektiteEscapeHtml(note ? note.title : noteId)}]]</code> elsewhere in the vault.</div>`;
    return;
  }
  const html = incoming.map(e => {
    return `<div class="tektite-backlink-item" data-id="${_tektiteEscapeAttr(e.noteId)}">
      <div class="tektite-backlink-title">${_tektiteEscapeHtml(e.title)}</div>
      <div class="tektite-backlink-ts">${e.modifiedAt ? _tektiteFormatRelativeTime(e.modifiedAt) : ""}</div>
    </div>`;
  }).join("");
  s.backlinksEl.innerHTML = header + html;
  s.backlinksEl.querySelectorAll(".tektite-backlink-item").forEach(el => {
    const id = el.getAttribute("data-id");
    el.addEventListener("click", async () => {
      s.activeSource = "vault";
      await _tektiteTabRefresh();
      await tektiteEditorLoadFromSource("vault", id);
      _tektiteTabRender();
    });
  });
}

/* Phase C sprint tektite-1.5b -- fullscreen toggle. Adds a body
 * class that the CSS uses to pin #br-view-tektite over the canvas
 * area. Bigger editor + the note list moves to a left rail. */
function _tektiteTabSetFullscreen(on) {
  const s = _tektiteTabState;
  s.fullscreen = !!on;
  document.body.classList.toggle("tektite-fullscreen", s.fullscreen);
  const btn = document.getElementById("btn-tektite-fullscreen");
  if (btn) {
    btn.textContent = s.fullscreen ? "⤡ Collapse" : "⤢ Expand";
    btn.title = s.fullscreen
      ? "Return Tektite to the sidebar"
      : "Expand Tektite to fill the editor area";
  }
}

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

  // Toggle the "+ New note" button -- vault always works; remote sources
  // only when they're writable (FS handle present / GH token present).
  const newBtn = document.getElementById("btn-tektite-new");
  if (newBtn) {
    const writable = tektiteSourceIsWritable(s.activeSource);
    newBtn.disabled = !writable;
    newBtn.title = writable
      ? ("Create a new note in this source (" + writable + ")")
      : "This source isn't writable. Switch to a writable source or reconnect.";
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

  const currentId     = tektiteEditorCurrentNoteId();
  const currentSource = tektiteEditorCurrentSourceId();
  const html = filtered.map(n => {
    const isActive = (n.id === currentId && currentSource === s.activeSource);
    const title    = _tektiteEscapeHtml(n.title || n.id);
    const ts       = n.modifiedAt ? _tektiteFormatRelativeTime(n.modifiedAt) : "";
    const path     = (s.activeSource === "vault") ? "" : `<span class="tektite-note-path">${_tektiteEscapeHtml(n.path || "")}</span>`;
    return `<div class="tektite-note-item${isActive ? " active" : ""}" data-id="${_tektiteEscapeAttr(n.id)}">
      <div class="tektite-note-title">${title}</div>
      <div class="tektite-note-meta">${ts ? `<span class="tektite-note-ts">${ts}</span>` : ""}${path}</div>
    </div>`;
  }).join("");
  s.listEl.innerHTML = html;

  // Sprint tektite-2 -- refresh backlinks after every list render
  // (loads happen via list clicks + a re-render is triggered).
  _tektiteRenderBacklinks();

  // Source-aware click + contextmenu wiring.
  s.listEl.querySelectorAll(".tektite-note-item").forEach(el => {
    const id = el.getAttribute("data-id");
    el.addEventListener("click", async () => {
      await tektiteEditorLoadFromSource(s.activeSource, id);
      // Show/hide the "Save to vault" button -- only meaningful when
      // the user wants a local copy of a remote note. With write back
      // working now, this is a "fork to vault" affordance rather than
      // a way to enable editing.
      if (s.saveToVaultBtnEl) {
        const showFork = (s.activeSource !== "vault");
        s.saveToVaultBtnEl.style.display = showFork ? "inline-block" : "none";
        if (showFork) {
          s.saveToVaultBtnEl._sourceId = s.activeSource;
          s.saveToVaultBtnEl._fileId   = id;
        }
      }
      _tektiteTabRender();
    });
    // Right-click delete -- only for the vault for now. Local-fs and
    // GitHub deletion via the API is a sprint tektite-2 follow-up.
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
  if (!tektiteSourceIsWritable(s.activeSource)) {
    window.alert("This source isn't writable. Switch to a writable source first.");
    return;
  }
  try {
    const newId = await tektiteSourceCreateNote(s.activeSource, "Untitled note");
    await _tektiteTabRefresh();
    await tektiteEditorLoadFromSource(s.activeSource, newId);
    _tektiteTabRender();
    const titleInput = document.getElementById("tektite-title");
    if (titleInput && s.activeSource === "vault") { titleInput.focus(); titleInput.select(); }
  } catch (e) {
    window.alert("Create failed: " + (e.message || String(e)));
  }
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

  // Editor wiring -- now source-aware (vault + local-fs + github writes).
  const editorRoot = document.getElementById("tektite-editor-pane");
  if (editorRoot) tektiteEditorAttach(editorRoot);

  // Sprint tektite-2 -- wire the wikilink ctrl-click handler so
  // CodeMirror clicks resolve through _tektiteNavigateWikilink.
  if (typeof tektiteEditorSetWikilinkNavigator === "function") {
    tektiteEditorSetWikilinkNavigator(_tektiteNavigateWikilink);
  }

  // Sprint tektite-2 -- backlinks panel lives in #tektite-backlinks.
  s.backlinksEl = document.getElementById("tektite-backlinks");

  // On save: update the listing if same source AND update the
  // backlinks index (vault only). Re-render backlinks if the saved
  // note is the one currently open, since the user might have added /
  // removed a [[link]] that changes its incoming list.
  tektiteEditorOnSave((record) => {
    if (!record) return;
    // Backlinks: incremental ingest (vault only -- remote saves don't
    // participate in the vault-only index yet).
    if (record.sourceId === "vault" && typeof tektiteBacklinksOnNoteSaved === "function") {
      tektiteBacklinksOnNoteSaved({
        id:         record.fileId,
        title:      record.title,
        content:    record.content,
        modifiedAt: record.modifiedAt
      });
      _tektiteRenderBacklinks();
    }
    // List re-order (active source only).
    if (record.sourceId === s.activeSource) {
      const idx = s.notes.findIndex(n => n.id === record.fileId);
      const listingEntry = {
        id:         record.fileId,
        title:      record.title,
        path:       record.fileId,
        modifiedAt: record.modifiedAt,
        sourceId:   record.sourceId
      };
      if (idx >= 0) s.notes.splice(idx, 1);
      s.notes.unshift(listingEntry);
      _tektiteTabRender();
    }
  });

  // Fullscreen toggle.
  const fsBtn = document.getElementById("btn-tektite-fullscreen");
  if (fsBtn) {
    fsBtn.addEventListener("click", () => _tektiteTabSetFullscreen(!s.fullscreen));
  }
  // Esc collapses fullscreen.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && s.fullscreen) _tektiteTabSetFullscreen(false);
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
