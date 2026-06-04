/* =========================================================================
 * Tektite MD -- source connectors
 *
 * Phase C sprint tektite-1.5. Lets the user connect external markdown
 * sources alongside the local IDB vault:
 *
 *   - vault          IDB-backed editable notes (sprint tektite-1, default)
 *   - local-fs       File System Access API directory handle (Chromium)
 *   - github         GitHub repo via the Contents API (public or PAT-gated)
 *   - gdrive         Google Drive (stub -- ships with the secrets-manager
 *                    phase post-Phase-D, see docs/LLM-KNOWLEDGE-PHASE.md §12)
 *
 * The vault source is always present; external sources are user-added
 * and persisted in localStorage under `gamma-editor-tektite-sources-v1`.
 * Per the deferred secrets sprint, GitHub PATs are stored in plain
 * localStorage for now -- noted explicitly in the connect modal so the
 * user knows what they're agreeing to.
 *
 * External sources are READ-ONLY in the editor. Clicking "Save to
 * vault" copies the current remote note into the IDB vault under a
 * fresh slug; the user can then edit normally. This mirrors how
 * Tektite-cloud / Tektite-pull works elsewhere in the spec.
 *
 * Public surface:
 *   tektiteSourcesList()                     -- array of sources (vault always first)
 *   tektiteSourcesAddLocal({ label })        -- prompts directory picker, adds source
 *   tektiteSourcesAddGithub({ repo, path, token, label })  -- fetches + adds
 *   tektiteSourcesAddDrive(_)                -- throws; stub for now
 *   tektiteSourcesRemove(id)                 -- removes (cannot remove vault)
 *   tektiteSourceListNotes(sourceId)         -- returns [{ id, title, path, modifiedAt }]
 *   tektiteSourceGetContent(sourceId, fileId) -- returns raw markdown string
 *   tektiteSourceImportToVault(sourceId, fileId) -- copies to IDB, returns vault id
 *
 * The vault source's "list notes" + "get content" both pass through to
 * tektiteListNotes / tektiteGetNote so the rest of the UI can stay
 * source-agnostic.
 * ======================================================================== */

const TEKTITE_SOURCES_KEY = "gamma-editor-tektite-sources-v1";

/* In-memory list. Includes a permanent vault entry + whatever the
 * user has added. Loaded from localStorage on first access. */
let _tektiteSources = null;

function _tektiteSourcesLoad() {
  if (_tektiteSources) return _tektiteSources;
  _tektiteSources = [
    {
      id: "vault",
      type: "vault",
      name: "Vault",
      path: "browser IDB",
      status: "ready",
      permanent: true
    }
  ];
  try {
    const raw = localStorage.getItem(TEKTITE_SOURCES_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const s of arr) {
          if (!s || s.type === "vault") continue;  // never restore another vault
          // FS handles can't survive serialization -- local-fs sources
          // load as "needs reconnect". GitHub sources retain their
          // repo/path/token and re-list on activation.
          if (s.type === "local-fs") {
            _tektiteSources.push({ ...s, status: "reconnect", handle: null, fileCache: null });
          } else {
            _tektiteSources.push({ ...s, status: s.status || "ready" });
          }
        }
      }
    }
  } catch (e) {
    console.warn("[tektite] failed to load sources from localStorage:", e);
  }
  return _tektiteSources;
}

function _tektiteSourcesPersist() {
  if (!_tektiteSources) return;
  // Strip non-serializable handles + caches before write.
  const sanitized = _tektiteSources
    .filter(s => s && !s.permanent)
    .map(s => {
      const { handle, fileCache, ...rest } = s;
      return rest;
    });
  try {
    localStorage.setItem(TEKTITE_SOURCES_KEY, JSON.stringify(sanitized));
  } catch (e) {
    console.warn("[tektite] failed to persist sources:", e);
  }
}

function tektiteSourcesList() {
  return _tektiteSourcesLoad().slice();
}

function tektiteSourcesGet(id) {
  const list = _tektiteSourcesLoad();
  return list.find(s => s && s.id === id) || null;
}

async function tektiteSourcesAddLocal(opts) {
  opts = opts || {};
  if (typeof window === "undefined" || typeof window.showDirectoryPicker !== "function") {
    throw new Error("File System Access API unavailable. Use Chrome or Edge.");
  }
  const handle = await window.showDirectoryPicker({ id: "gamma-tektite-source" });
  const label = (opts.label || handle.name || "Local folder").trim();
  const id = "local-" + Date.now();
  const src = {
    id, type: "local-fs",
    name: label,
    path: handle.name + "/",
    status: "connected",
    handle,
    fileCache: null
  };
  _tektiteSourcesLoad().push(src);
  _tektiteSourcesPersist();
  return src;
}

async function tektiteSourcesAddGithub(opts) {
  opts = opts || {};
  const repo  = String(opts.repo || "").trim();
  const path  = String(opts.path || "").trim();
  const token = String(opts.token || "").trim();
  const label = (opts.label || "").trim() || ("GitHub · " + repo);
  if (!repo || !repo.includes("/")) throw new Error("Repository must be owner/name");
  // Verify by listing.
  const files = await _tektiteFetchGithubListing(repo, path, token);
  const id = "github-" + Date.now();
  const src = {
    id, type: "github",
    name: label,
    path: repo + (path ? " · " + path : ""),
    repo, repoPath: path, token,
    status: "connected",
    fileCache: files
  };
  _tektiteSourcesLoad().push(src);
  _tektiteSourcesPersist();
  return src;
}

function tektiteSourcesAddDrive() {
  throw new Error("Google Drive support ships with the secrets-manager phase (post-Phase-D). See docs/LLM-KNOWLEDGE-PHASE.md §12.");
}

function tektiteSourcesRemove(id) {
  const list = _tektiteSourcesLoad();
  const idx = list.findIndex(s => s && s.id === id);
  if (idx < 0) return false;
  if (list[idx].permanent) return false;
  list.splice(idx, 1);
  _tektiteSourcesPersist();
  return true;
}

/* ------------------------------------------------------------------
 * Listing -- normalizes each source type to a common shape so the
 * sidebar list renderer doesn't care where the note came from.
 *
 * Shape: { id, title, path, modifiedAt, sourceId }
 *
 * - vault:    pulls from tektiteListNotes(); id is the slug
 * - local-fs: walks the directory handle for `.md` files (recursive
 *             to one level for sprint-1.5; can expand later)
 * - github:   uses the cached file list from connect; id is the path
 * - gdrive:   throws
 * ------------------------------------------------------------------ */
async function tektiteSourceListNotes(sourceId) {
  const src = tektiteSourcesGet(sourceId);
  if (!src) return [];
  if (src.type === "vault") {
    const notes = await tektiteListNotes();
    return notes.map(n => ({
      id: n.id, title: n.title || n.id, path: n.id, modifiedAt: n.modifiedAt, sourceId: "vault"
    }));
  }
  if (src.type === "local-fs") {
    if (!src.handle) throw new Error("Source disconnected. Remove and re-add to reconnect.");
    if (!src.fileCache) src.fileCache = await _tektiteWalkLocalDir(src.handle);
    return src.fileCache.map(f => ({
      id: f.path, title: f.name, path: f.path, modifiedAt: f.modifiedAt, sourceId: src.id
    }));
  }
  if (src.type === "github") {
    if (!src.fileCache) src.fileCache = await _tektiteFetchGithubListing(src.repo, src.repoPath, src.token);
    return src.fileCache.map(f => ({
      id: f.path, title: f.name.replace(/\.md$/i, ""), path: f.path, modifiedAt: 0, sourceId: src.id
    }));
  }
  return [];
}

async function tektiteSourceGetContent(sourceId, fileId) {
  const src = tektiteSourcesGet(sourceId);
  if (!src) throw new Error("Source not found: " + sourceId);
  if (src.type === "vault") {
    const note = await tektiteGetNote(fileId);
    return note ? (note.content || "") : "";
  }
  if (src.type === "local-fs") {
    if (!src.handle) throw new Error("Source disconnected.");
    return await _tektiteReadLocalFile(src.handle, fileId);
  }
  if (src.type === "github") {
    return await _tektiteFetchGithubFile(src.repo, fileId, src.token);
  }
  throw new Error("Unsupported source type: " + src.type);
}

async function tektiteSourceImportToVault(sourceId, fileId) {
  if (sourceId === "vault") return fileId;  // already there
  const content = await tektiteSourceGetContent(sourceId, fileId);
  const sourceListing = await tektiteSourceListNotes(sourceId);
  const entry = sourceListing.find(e => e.id === fileId);
  const baseTitle = entry ? entry.title : "imported";
  const id = await tektiteNextAvailableSlug(baseTitle);
  await tektitePutNote({ id, title: baseTitle, content });
  return id;
}

/* ------------------------------------------------------------------
 * Local-fs helpers. Walks the directory handle for `.md` files,
 * descending one level into subdirs. Two levels would suit a typical
 * Obsidian-style vault layout; deeper is sprint tektite-2 territory.
 * ------------------------------------------------------------------ */
async function _tektiteWalkLocalDir(dirHandle, prefix, depth) {
  prefix = prefix || "";
  depth  = depth  || 0;
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && /\.md$/i.test(name)) {
      try {
        const file = await handle.getFile();
        out.push({
          path: prefix + name,
          name: name.replace(/\.md$/i, ""),
          modifiedAt: file.lastModified || 0
        });
      } catch (_) {}
    } else if (handle.kind === "directory" && depth < 2 && !name.startsWith(".")) {
      const sub = await _tektiteWalkLocalDir(handle, prefix + name + "/", depth + 1);
      out.push.apply(out, sub);
    }
  }
  out.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  return out;
}

async function _tektiteReadLocalFile(dirHandle, path) {
  const parts = String(path || "").split("/");
  let h = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    h = await h.getDirectoryHandle(parts[i]);
  }
  const fh = await h.getFileHandle(parts[parts.length - 1]);
  const file = await fh.getFile();
  return await file.text();
}

/* ------------------------------------------------------------------
 * GitHub helpers. Uses the public Contents API with an optional PAT
 * for private repos. The PAT (when present) is stored in localStorage
 * via _tektiteSourcesPersist -- noted explicitly in the connect modal
 * since this contradicts the "Cannot-Be-Viewed" promise of the future
 * secrets manager. Replace with the secrets-manager bridge once
 * sprint secrets-1 lands.
 * ------------------------------------------------------------------ */
async function _tektiteFetchGithubListing(repo, repoPath, token) {
  const slug = repoPath.startsWith("/") ? repoPath : ("/" + repoPath);
  const url = "https://api.github.com/repos/" + repo + "/contents" + (repoPath ? slug : "");
  const headers = { "Accept": "application/vnd.github+json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error("GitHub Contents API: HTTP " + r.status);
  const list = await r.json();
  if (!Array.isArray(list)) throw new Error("Path is not a directory or repo has no contents at that path.");
  // Keep only .md files; strip subdirs (sprint tektite-2 walks them).
  return list
    .filter(x => x.type === "file" && /\.md$/i.test(x.name))
    .map(x => ({
      path: x.path,
      name: x.name,
      downloadUrl: x.download_url,
      sha: x.sha,
      size: x.size
    }));
}

async function _tektiteFetchGithubFile(repo, filePath, token) {
  const url = "https://api.github.com/repos/" + repo + "/contents/" + filePath;
  const headers = { "Accept": "application/vnd.github.raw" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error("GitHub file fetch: HTTP " + r.status);
  return await r.text();
}
