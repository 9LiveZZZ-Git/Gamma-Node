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
  // Sprint tektite-5a -- opts.importToVault recursively pulls every
  // `.md` under the picked folder into the vault, preserving the
  // directory structure as nested slug paths. Returns { src, imported }
  // so the UI can announce "Imported N notes".
  if (opts.importToVault) {
    const files = await _tektiteWalkLocalDir(handle);
    let imported = 0;
    let skippedBinary = 0;
    for (const f of files) {
      // Since sprint 10u the walker returns attachments (png/wav/pdf/...)
      // alongside notes; reading those as UTF-8 text would corrupt them.
      // Only markdown becomes a vault note.
      if (f.kind && f.kind !== "note") { skippedBinary++; continue; }
      try {
        const content = await _tektiteReadLocalFile(handle, f.path);
        const slugPath = (typeof tektiteSlugifyPath === "function")
          ? tektiteSlugifyPath(f.path.replace(/\.md$/i, ""))
          : f.path.replace(/\.md$/i, "");
        let dstId = slugPath, n = 2;
        while (await tektiteGetNote(dstId)) {
          dstId = slugPath + "-" + n; n++;
          if (n > 9999) break;
        }
        await tektitePutNote({ id: dstId, title: f.name, content });
        imported++;
      } catch (e) {
        console.warn("[tektite] import skipped", f.path, ":", e);
      }
    }
    if (skippedBinary) {
      console.warn("[tektite] import: skipped " + skippedBinary + " non-markdown file(s); attachments are not imported to the vault.");
    }
    return { src, imported };
  }
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
    let merged = notes.map(n => ({
      id: n.id, title: n.title || n.id, path: n.id,
      modifiedAt: n.modifiedAt, sourceId: "vault", kind: "note"
    }));
    // Sprint 10t -- merge attachments into the vault listing so binary
    // files show up next to markdown notes.  The viewer dispatches by
    // kind on click.
    if (typeof tektiteListAttachments === "function") {
      try {
        const atts = await tektiteListAttachments();
        for (const a of atts) {
          merged.push({
            id: a.id, title: a.id, path: a.id,
            modifiedAt: a.modifiedAt, sourceId: "vault",
            kind: a.kind || "attachment", ext: a.ext, size: a.size, mime: a.mime
          });
        }
        merged.sort((x, y) => (y.modifiedAt || 0) - (x.modifiedAt || 0));
      } catch (_) {}
    }
    return merged;
  }
  if (src.type === "local-fs") {
    if (!src.handle) throw new Error("Source disconnected. Remove and re-add to reconnect.");
    if (!src.fileCache) src.fileCache = await _tektiteWalkLocalDir(src.handle);
    return src.fileCache.map(f => ({
      id: f.path, title: f.name, path: f.path, modifiedAt: f.modifiedAt,
      sourceId: src.id,
      // Sprint 10u -- attachments now flow through; viewer dispatches on kind.
      kind: f.kind || "note", ext: f.ext, size: f.size
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
    const cached = (src.fileCache || []).find(f => f.path === fileId);
    const content = await _tektiteFetchGithubFile(src.repo, fileId, src.token);
    // Cache sha alongside the listing entry so a later write can pass
    // the latest known sha (GitHub's PUT requires it on existing files
    // to avoid blind overwrites). Refreshed on every read so that
    // reloading a note after a write conflict picks up the new sha.
    if (cached) {
      try {
        const meta = await _tektiteFetchGithubMeta(src.repo, fileId, src.token);
        if (meta && meta.sha) cached.sha = meta.sha;
      } catch (_) {}
    }
    return content;
  }
  throw new Error("Unsupported source type: " + src.type);
}

/* Sprint tektite-1.5b -- write back to the source. Vault writes hit
 * tektitePutNote directly; local-fs uses the FS Access API (which
 * needs explicit readwrite permission, granted lazily on first save);
 * GitHub PUTs to the Contents API (creates a new file if `fileId`
 * doesn't exist yet, updates with sha if it does). Returns
 * { ok, id, message? } -- id is the (possibly new) file path so the
 * UI can update its currentId after a rename.
 *
 * For GitHub: requires a PAT with `contents:write` scope. The PAT
 * is stored in localStorage; the deferred secrets-manager sprint
 * (docs/LLM-KNOWLEDGE-PHASE.md §12) will harden this. */
async function tektiteSourceWriteContent(sourceId, fileId, content, opts) {
  opts = opts || {};
  const src = tektiteSourcesGet(sourceId);
  if (!src) throw new Error("Source not found: " + sourceId);

  if (src.type === "vault") {
    const existing = await tektiteGetNote(fileId);
    const rec = await tektitePutNote({
      id: fileId,
      title: opts.title || (existing && existing.title) || fileId,
      content,
      createdAt: existing && existing.createdAt
    });
    return { ok: true, id: rec.id };
  }

  if (src.type === "local-fs") {
    if (!src.handle) throw new Error("Source disconnected. Remove and re-add to reconnect.");
    // Ensure readwrite permission. First save in a session prompts the user.
    const perm = await _tektiteEnsureFsReadWrite(src.handle);
    if (perm !== "granted") throw new Error("Write permission denied for this folder.");
    await _tektiteWriteLocalFile(src.handle, fileId, content);
    // Bust the file cache so the next list reflects the new modifiedAt.
    src.fileCache = null;
    return { ok: true, id: fileId };
  }

  if (src.type === "github") {
    if (!src.token) throw new Error("This GitHub source has no PAT. Disconnect and re-add with a token that has contents:write scope.");
    // Pass the last-observed sha (cached at read/write time) so GitHub's
    // optimistic-concurrency check rejects a stale buffer with a 409
    // instead of the write-time pre-fetch blindly overwriting a newer
    // remote version. Fall back to the pre-fetch only when no sha was
    // ever observed.
    const cached = (src.fileCache || []).find(f => f.path === fileId);
    const result = await _tektiteWriteGithubFile(src.repo, fileId, content, src.token, {
      message: opts.message || ("Update " + fileId.split("/").pop() + " via Gamma Node editor"),
      sha: opts.sha !== undefined ? opts.sha : ((cached && cached.sha) || undefined)
    });
    // Refresh the cached entry's sha so the next write doesn't need a pre-GET.
    if (cached && result && result.content && result.content.sha) {
      cached.sha = result.content.sha;
    }
    return { ok: true, id: fileId };
  }

  throw new Error("Unsupported source type for write: " + src.type);
}

/* Sprint tektite-1.5b -- create a brand-new file in a writable
 * source.  For vault, just slugs the title.  For local-fs, writes a
 * fresh .md file.  For GitHub, PUT-creates a file (no sha required
 * since it's new).  Returns the new fileId so the UI can navigate. */
async function tektiteSourceCreateNote(sourceId, title, content) {
  const src = tektiteSourcesGet(sourceId);
  if (!src) throw new Error("Source not found: " + sourceId);
  const base = String(title || "Untitled note").trim() || "Untitled note";

  if (src.type === "vault") {
    const id = await tektiteNextAvailableSlug(base);
    await tektitePutNote({ id, title: base, content: content || "# " + base + "\n\n" });
    return id;
  }
  if (src.type === "local-fs") {
    if (!src.handle) throw new Error("Source disconnected.");
    const perm = await _tektiteEnsureFsReadWrite(src.handle);
    if (perm !== "granted") throw new Error("Write permission denied.");
    const fname = tektiteSlugify(base) + ".md";
    // Avoid clobbering -- if it exists, append a numeric suffix.
    let candidate = fname;
    let n = 2;
    while (await _tektiteLocalFileExists(src.handle, candidate)) {
      candidate = fname.replace(/\.md$/, "") + "-" + n + ".md";
      n++;
      if (n > 9999) throw new Error("Couldn't allocate a fresh filename.");
    }
    await _tektiteWriteLocalFile(src.handle, candidate, content || "# " + base + "\n\n");
    src.fileCache = null;
    return candidate;
  }
  if (src.type === "github") {
    if (!src.token) throw new Error("GitHub source needs a write-scoped PAT.");
    const dir = (src.repoPath || "").replace(/^\/|\/$/g, "");
    const fname = tektiteSlugify(base) + ".md";
    const filePath = dir ? (dir + "/" + fname) : fname;
    await _tektiteWriteGithubFile(src.repo, filePath, content || "# " + base + "\n\n", src.token, {
      message: "Create " + fname + " via Gamma Node editor",
      // sha: null = create-only. Without it the sha pre-fetch would turn
      // a title collision into a silent overwrite of the existing file.
      sha: null
    });
    src.fileCache = null;
    return filePath;
  }
  throw new Error("Unsupported source type for create: " + src.type);
}

/* Returns "vault" | "local-fs" | "github" if writable, else null. The
 * UI uses this to enable/disable the New-note button per source. */
function tektiteSourceIsWritable(sourceId) {
  const src = tektiteSourcesGet(sourceId);
  if (!src) return null;
  if (src.type === "vault") return "vault";
  if (src.type === "local-fs" && src.handle) return "local-fs";
  if (src.type === "github" && src.token) return "github";
  return null;
}

async function tektiteSourceImportToVault(sourceId, fileId) {
  if (sourceId === "vault") return fileId;  // already there
  const sourceListing = await tektiteSourceListNotes(sourceId);
  const entry = sourceListing.find(e => e.id === fileId);
  // Reading a binary attachment as UTF-8 text would store irreversible
  // mojibake as a note -- only markdown entries can be vault notes.
  if (entry && entry.kind && entry.kind !== "note") {
    throw new Error("Only markdown notes can be saved to the vault; \"" + fileId + "\" is a " + entry.kind + " file.");
  }
  const content = await tektiteSourceGetContent(sourceId, fileId);
  const baseTitle = entry ? entry.title : "imported";
  // Sprint tektite-5a -- preserve the source's folder structure in
  // the vault slug so a forked `journal/2026/06-05.md` lands at
  // `journal/2026/06-05` rather than collapsing into a flat
  // `06-05` slug.
  const pathSlug = (typeof tektiteSlugifyPath === "function")
    ? tektiteSlugifyPath(String(fileId).replace(/\.md$/i, ""))
    : await tektiteNextAvailableSlug(baseTitle);
  let id = pathSlug;
  let n = 2;
  while (await tektiteGetNote(id)) {
    id = pathSlug + "-" + n;
    n++;
    if (n > 9999) throw new Error("could not allocate a fresh slug");
  }
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
  // Sprint tektite-5a -- depth raised from 2 to 8 so real vaults like
  // Obsidian's typical journal/2026/06/05.md don't get truncated.
  // Skip dotfiles + .obsidian / .git / node_modules to avoid
  // ingesting tooling overhead.
  const SKIP_DIRS = new Set([".obsidian", ".git", "node_modules", ".idea", ".vscode"]);
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file") {
      // Sprint 10u -- accept ANY recognized extension, not just .md.
      // Notes (markdown) stay first-class; attachments come along so
      // local-fs sources mirror full vaults instead of markdown-only.
      const lower = name.toLowerCase();
      const isMd  = /\.(md|markdown)$/i.test(name);
      const cls   = (typeof tektiteClassifyAttachment === "function")
                  ? tektiteClassifyAttachment(name) : { kind: "other", ext: "" };
      const isRecognized = isMd || cls.kind !== "other";
      if (!isRecognized) continue;
      try {
        const file = await handle.getFile();
        out.push({
          path:       prefix + name,
          name:       isMd ? name.replace(/\.(md|markdown)$/i, "") : name,
          modifiedAt: file.lastModified || 0,
          kind:       isMd ? "note" : cls.kind,
          ext:        cls.ext,
          size:       file.size || 0
        });
      } catch (_) {}
    } else if (handle.kind === "directory" &&
               depth < 8 &&
               !name.startsWith(".") &&
               !SKIP_DIRS.has(name)) {
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
async function _tektiteFetchGithubListing(repo, repoPath, token, depth) {
  // Sprint tektite-5a -- recursive walk. The Contents API returns
  // entries with type: "file" or "dir"; we recurse into dirs up to
  // depth 5 (deep enough for typical wiki structures, shallow enough
  // to avoid hitting the API rate limit). Each .md found along the
  // way is added to the listing with its full path so the tree
  // builder can reconstruct the folder structure.
  depth = Number.isFinite(depth) ? depth : 0;
  const slug = repoPath ? (repoPath.startsWith("/") ? repoPath : ("/" + repoPath)) : "";
  const url = "https://api.github.com/repos/" + repo + "/contents" + slug;
  const headers = { "Accept": "application/vnd.github+json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error("GitHub Contents API: HTTP " + r.status);
  const list = await r.json();
  if (!Array.isArray(list)) throw new Error("Path is not a directory or repo has no contents at that path.");

  const out = [];
  for (const entry of list) {
    if (entry.type === "file" && /\.md$/i.test(entry.name)) {
      out.push({
        path: entry.path,
        name: entry.name,
        downloadUrl: entry.download_url,
        sha: entry.sha,
        size: entry.size
      });
    } else if (entry.type === "dir" && depth < 5 && !entry.name.startsWith(".")) {
      try {
        const sub = await _tektiteFetchGithubListing(repo, entry.path, token, depth + 1);
        out.push.apply(out, sub);
      } catch (e) {
        console.warn("[tektite] github subdir walk failed for", entry.path, ":", e);
      }
    }
  }
  return out;
}

/* Percent-encode a repo-relative path per segment (keeping the `/`
 * separators) so filenames containing `#`, `?`, `%`, etc. don't get
 * truncated or reinterpreted by the URL parser. */
function _tektiteGithubEncodePath(filePath) {
  return String(filePath || "").split("/").map(encodeURIComponent).join("/");
}

async function _tektiteFetchGithubFile(repo, filePath, token) {
  const url = "https://api.github.com/repos/" + repo + "/contents/" + _tektiteGithubEncodePath(filePath);
  const headers = { "Accept": "application/vnd.github.raw" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error("GitHub file fetch: HTTP " + r.status);
  return await r.text();
}

/* GET the file metadata (incl. sha) -- needed before PUT-update. The
 * raw content endpoint doesn't return the sha; we need the JSON
 * variant. Returns the parsed response or throws on 404. */
async function _tektiteFetchGithubMeta(repo, filePath, token) {
  const url = "https://api.github.com/repos/" + repo + "/contents/" + _tektiteGithubEncodePath(filePath);
  const headers = { "Accept": "application/vnd.github+json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(url, { headers });
  if (r.status === 404) return null;  // "file doesn't exist" is a valid state
  if (!r.ok) throw new Error("GitHub meta: HTTP " + r.status);
  return await r.json();
}

/* Sprint tektite-1.5b -- PUT a file via the GitHub Contents API. If a
 * `sha` is provided this updates the existing file; without `sha`
 * GitHub will create the file (or 422 if it already exists). For
 * editor flows we ALWAYS pre-fetch the sha to avoid the 422 surprise
 * when the user edits an existing remote note that wasn't pre-cached.
 * `opts.sha === null` is a create-only sentinel: the caller asserts the
 * file is new, so an existing file aborts with an error instead of
 * being silently replaced. */
async function _tektiteWriteGithubFile(repo, filePath, content, token, opts) {
  opts = opts || {};
  const url = "https://api.github.com/repos/" + repo + "/contents/" + _tektiteGithubEncodePath(filePath);
  const headers = {
    "Accept":        "application/vnd.github+json",
    "Content-Type":  "application/json",
    "Authorization": "Bearer " + token
  };
  // Encode the content as base64 (the API requires this).
  const b64 = _tektiteBase64UnicodeEncode(content);

  let sha = opts.sha;
  if (sha === null) {
    // Create-only: abort if the path is already taken rather than
    // attaching its sha and gutting the existing file.
    const meta = await _tektiteFetchGithubMeta(repo, filePath, token);
    if (meta && meta.sha) {
      throw new Error("GitHub write: \"" + filePath + "\" already exists in the repo. Pick a different title.");
    }
    sha = undefined;
  } else if (sha === undefined) {
    // Pre-fetch to find the latest sha; if 404 it's a fresh file.
    const meta = await _tektiteFetchGithubMeta(repo, filePath, token);
    sha = (meta && meta.sha) || undefined;
  }

  const body = { message: opts.message || "Update via Gamma Node editor", content: b64 };
  if (sha) body.sha = sha;

  const r = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.text()).slice(0, 200); } catch (_) {}
    // 409 = sha mismatch: the file changed on the remote since we last
    // read it. Make the conflict explicit instead of a bare HTTP code.
    if (r.status === 409) {
      throw new Error("GitHub write conflict: \"" + filePath + "\" changed on the remote since it was last loaded. Reload the note and re-apply your edit." + (detail ? (" -- " + detail) : ""));
    }
    throw new Error("GitHub write: HTTP " + r.status + (detail ? (" -- " + detail) : ""));
  }
  return await r.json();
}

/* Base64-encode a UTF-16 string into a UTF-8 base64 payload. btoa()
 * fails on non-Latin1 chars; the TextEncoder dance handles emoji,
 * non-Latin scripts, and the byte-order-marky madness GitHub returns
 * on round-trip. */
function _tektiteBase64UnicodeEncode(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* Sprint tektite-1.5b -- local FS write. Resolves a nested path
 * relative to the connected directory handle, creating intermediate
 * directories if needed, then writes content via createWritable. */
async function _tektiteWriteLocalFile(dirHandle, path, content) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (!parts.length) throw new Error("Empty file path.");
  let h = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    h = await h.getDirectoryHandle(parts[i], { create: true });
  }
  const fh = await h.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

/* Check whether a top-level file exists in the source. Used by the
 * create-note flow to allocate a non-clashing filename. */
async function _tektiteLocalFileExists(dirHandle, filename) {
  try {
    await dirHandle.getFileHandle(filename, { create: false });
    return true;
  } catch (_) {
    return false;
  }
}

/* Permission gate. queryPermission returns "granted" | "denied" |
 * "prompt"; we escalate from prompt to a user-facing requestPermission
 * which shows the browser's read-write confirmation. Returns the
 * final permission state. */
async function _tektiteEnsureFsReadWrite(handle) {
  if (!handle) return "denied";
  const opts = { mode: "readwrite" };
  if (typeof handle.queryPermission === "function") {
    const q = await handle.queryPermission(opts);
    if (q === "granted") return "granted";
  }
  if (typeof handle.requestPermission === "function") {
    return await handle.requestPermission(opts);
  }
  return "denied";
}
