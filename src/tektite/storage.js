/* =========================================================================
 * Tektite MD -- storage layer
 *
 * Phase C sprint tektite-1 of docs/LLM-KNOWLEDGE-PHASE.md §5. IndexedDB
 * persistence for the markdown vault. Per-origin singleton database
 * `gamma-editor-tektite-v1`; one object store `notes` keyed by note id
 * (kebab-case slug). The schema is intentionally minimal for sprint 1
 * (id + title + content + timestamps); frontmatter / tags / backlinks
 * indices come in tektite-3.
 *
 * Note shape:
 *   {
 *     id:          string,    -- kebab-case unique slug ("daily-2026-06-04")
 *     title:       string,    -- display title (first heading or filename)
 *     content:     string,    -- raw markdown source
 *     createdAt:   number,    -- ms epoch
 *     modifiedAt:  number     -- ms epoch
 *   }
 *
 * No background sync, no compression -- markdown notes are tiny (a few
 * KB each) and IDB happily holds thousands.  Plugins / Tektite-cloud
 * integration are post-Phase-C.
 *
 * Public surface (all async, return Promises):
 *   tektiteVaultOpen()                       -- returns IDBDatabase
 *   tektiteListNotes()                       -- returns [Note] sorted by modifiedAt desc
 *   tektiteGetNote(id)                       -- returns Note | null
 *   tektitePutNote(note)                     -- upsert; bumps modifiedAt
 *   tektiteDeleteNote(id)                    -- removes from store
 *   tektiteRenameNote(oldId, newTitle)       -- changes title (and id if requested)
 *
 * Verification path (sprint tektite-1):
 *   1. Open Tektite tab, click "+ New note".
 *   2. Type some markdown in the editor.
 *   3. Reload the page.
 *   4. Note still appears in the list with its content.
 * ======================================================================== */

const TEKTITE_VAULT_DB      = "gamma-editor-tektite-v1";
// Sprint 10t -- attachments store bumps the version to 2 so a fresh
// upgrade hook creates it on existing vaults.
const TEKTITE_VAULT_VERSION = 2;
const TEKTITE_NOTES_STORE       = "notes";
const TEKTITE_ATTACHMENTS_STORE = "attachments";

let _tektiteVaultDbP = null;

function tektiteVaultOpen() {
  if (_tektiteVaultDbP) return _tektiteVaultDbP;
  _tektiteVaultDbP = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable in this environment"));
      return;
    }
    const req = indexedDB.open(TEKTITE_VAULT_DB, TEKTITE_VAULT_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TEKTITE_NOTES_STORE)) {
        const store = db.createObjectStore(TEKTITE_NOTES_STORE, { keyPath: "id" });
        // Secondary index for "recent notes" listing without a full scan.
        store.createIndex("modifiedAt", "modifiedAt", { unique: false });
      }
      // Sprint 10t -- attachments store: Blob payload keyed by note id
      // (filename-based).  Used for image/audio/video/pdf/.gpatch/etc.
      if (!db.objectStoreNames.contains(TEKTITE_ATTACHMENTS_STORE)) {
        const att = db.createObjectStore(TEKTITE_ATTACHMENTS_STORE, { keyPath: "id" });
        att.createIndex("kind",       "kind",       { unique: false });
        att.createIndex("modifiedAt", "modifiedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error || new Error("IDB open failed"));
  });
  return _tektiteVaultDbP;
}

/* Promisify an IDBRequest. Used internally; not exported. */
function _tektitePromisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function tektiteListNotes() {
  const db = await tektiteVaultOpen();
  const tx = db.transaction(TEKTITE_NOTES_STORE, "readonly");
  const store = tx.objectStore(TEKTITE_NOTES_STORE);
  // Iterate the modifiedAt index in reverse so most-recent shows first.
  const idx = store.index("modifiedAt");
  const raw = await new Promise((resolve, reject) => {
    const results = [];
    const cursorReq = idx.openCursor(null, "prev");
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c) { resolve(results); return; }
      results.push(c.value);
      c.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  // Sprint 10x -- inflate compressed content so callers that read
  // `.content` (graph build / wikilink scan / embeddings) get a
  // string regardless of how it landed on disk.
  for (const r of raw) await _tektiteInflateNote(r);
  return raw;
}

/* Sprint 10x -- on-disk compression for note content via the native
 * CompressionStream API.  Notes longer than the threshold get gzipped
 * to a Uint8Array before put(); reads transparently inflate.  No new
 * deps -- CompressionStream / DecompressionStream are baseline in
 * every Chromium / Safari / Firefox version Gamma supports.
 *
 * Existing uncompressed notes (string `content`) still load fine --
 * decompress dispatches on the type. */
const TEKTITE_COMPRESS_THRESHOLD = 4096;  // bytes; below this, gzip cost > win

async function _tektiteCompressString(s) {
  if (typeof CompressionStream === "undefined") return null;
  const enc  = new TextEncoder().encode(s);
  const cs   = new CompressionStream("gzip");
  const out  = new Response(new Blob([enc]).stream().pipeThrough(cs));
  const buf  = await out.arrayBuffer();
  return new Uint8Array(buf);
}

async function _tektiteDecompressU8(u8) {
  if (typeof DecompressionStream === "undefined") {
    // Stored as raw bytes, no decompress available -- best effort UTF-8.
    return new TextDecoder().decode(u8);
  }
  const ds  = new DecompressionStream("gzip");
  const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
  return await out.text();
}

async function _tektiteInflateNote(rec) {
  if (!rec) return rec;
  if (rec._compressed && rec.content && rec.content.byteLength !== undefined) {
    rec.content    = await _tektiteDecompressU8(rec.content);
    rec._compressed = false;
  }
  return rec;
}

async function tektiteGetNote(id) {
  if (!id) return null;
  const db = await tektiteVaultOpen();
  const tx = db.transaction(TEKTITE_NOTES_STORE, "readonly");
  const store = tx.objectStore(TEKTITE_NOTES_STORE);
  const res = await _tektitePromisifyRequest(store.get(String(id)));
  if (!res) return null;
  return await _tektiteInflateNote(res);
}

async function tektitePutNote(note) {
  if (!note || !note.id) throw new Error("note.id required");
  const now = Date.now();
  const contentStr = String(note.content || "");
  let storedContent = contentStr;
  let compressed = false;
  if (contentStr.length > TEKTITE_COMPRESS_THRESHOLD) {
    const u8 = await _tektiteCompressString(contentStr);
    if (u8 && u8.byteLength < contentStr.length) {
      storedContent = u8;
      compressed = true;
    }
  }
  const record = {
    id:         String(note.id),
    title:      String(note.title || note.id),
    content:    storedContent,
    _compressed: compressed,
    createdAt:  Number.isFinite(note.createdAt)  ? note.createdAt  : now,
    modifiedAt: now
  };
  const db = await tektiteVaultOpen();
  const tx = db.transaction(TEKTITE_NOTES_STORE, "readwrite");
  const store = tx.objectStore(TEKTITE_NOTES_STORE);
  await _tektitePromisifyRequest(store.put(record));
  // Hand back a record with the original string so callers don't have
  // to inflate themselves.
  return { ...record, content: contentStr, _compressed: false };
}

async function tektiteDeleteNote(id) {
  if (!id) return;
  const db = await tektiteVaultOpen();
  const tx = db.transaction(TEKTITE_NOTES_STORE, "readwrite");
  const store = tx.objectStore(TEKTITE_NOTES_STORE);
  await _tektitePromisifyRequest(store.delete(String(id)));
}

/* Rename = update title in place. Id stays the same so backlinks
 * (sprint tektite-2) don't break. A separate "change slug" operation
 * would need to walk every other note's content + rewrite [[oldId]]
 * mentions; defer that to tektite-2's wikilink subsystem. */
async function tektiteRenameNote(id, newTitle) {
  const existing = await tektiteGetNote(id);
  if (!existing) throw new Error("note not found: " + id);
  existing.title = String(newTitle || existing.title);
  return await tektitePutNote(existing);
}

/* Slug helper -- turn a title into a stable kebab-case id. Used when
 * creating fresh notes ("Untitled note" → "untitled-note", with a
 * numeric suffix if a collision exists). Mirrors the asset-slug rules
 * elsewhere in the editor so id formats stay consistent across the
 * vault + assets + .gpatch references. */
function tektiteSlugify(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")    // strip punctuation
    .replace(/\s+/g, "-")        // spaces → dashes
    .replace(/-+/g, "-")         // collapse runs
    .replace(/^-|-$/g, "") || "untitled";
}

/* Sprint tektite-5a -- folder-aware slug. Same rules as tektiteSlugify
 * but preserves `/` between path segments + sanitizes each segment
 * independently. Used by the local-fs / github importers + by future
 * "+ New note in this folder" actions. Returns a path like
 * `journal/2026/june-5`. */
function tektiteSlugifyPath(path) {
  return String(path || "")
    .split("/")
    .map(seg => tektiteSlugify(seg))
    .join("/") || "untitled";
}

async function tektiteNextAvailableSlug(baseTitle) {
  const base = tektiteSlugify(baseTitle);
  let candidate = base;
  let n = 2;
  while (await tektiteGetNote(candidate)) {
    candidate = base + "-" + n;
    n++;
    if (n > 9999) throw new Error("could not allocate a fresh slug");
  }
  return candidate;
}

/* =========================================================================
 * Sprint 10t -- file type registry + attachment storage.
 *
 * Supported categories:
 *   image  -- .png .jpg .jpeg .gif .svg .bmp .webp .avif
 *   audio  -- .mp3 .wav .m4a .ogg .flac .webm .3gp
 *   video  -- .mp4 .webm .mov .mkv .ogv
 *   pdf    -- .pdf
 *   doc    -- .doc .docx .rtf .odt
 *   data   -- .csv .json .jsonl .parquet .tsv .yaml .yml .xml
 *   text   -- .txt .log
 *   archive -- .zip .tar .gz .7z .tgz
 *   patch  -- .gpatch (Gamma patches; open via main canvas)
 *   dsp    -- .gdsp   (Gamma DSP source; open via User DSP tab)
 *   other  -- anything else (download link / external program)
 *
 * Attachments are Blobs keyed by id (sanitized filename), kept in
 * the same IDB as notes for backup/restore convenience. `notes`
 * remain markdown-only; attachments are a separate store so a
 * 50 MB video doesn't bloat the note's serialized record.
 * ======================================================================== */

const TEKTITE_FILE_KINDS = {
  image:   [".png", ".jpg", ".jpeg", ".gif", ".svg", ".bmp", ".webp", ".avif"],
  audio:   [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".3gp"],
  video:   [".mp4", ".webm", ".mov", ".mkv", ".ogv"],
  pdf:     [".pdf"],
  doc:     [".doc", ".docx", ".rtf", ".odt"],
  data:    [".csv", ".tsv", ".json", ".jsonl", ".parquet", ".yaml", ".yml", ".xml"],
  // Sprint 10w -- HTML kind opens in a sandboxed iframe + "Open in
  // new tab" button.  Editable via the Monaco code editor.
  html:    [".html", ".htm"],
  // Sprint 10w -- code files get Monaco for editing.  Adding any
  // language here implicitly enables Monaco for that extension.
  code:    [".py", ".c", ".cpp", ".cxx", ".cc", ".h", ".hpp", ".rs", ".jsx", ".tsx",
            ".ts", ".js", ".mjs", ".cjs", ".raku", ".rakumod", ".rakudoc",
            ".go", ".java", ".kt", ".swift", ".rb", ".php", ".lua", ".sh", ".bash", ".zsh",
            ".pl", ".pm", ".sql", ".r", ".jl", ".scala", ".clj", ".cljs", ".ex", ".exs",
            ".css", ".scss", ".less", ".vue", ".svelte", ".astro", ".wat", ".wgsl", ".glsl"],
  text:    [".txt", ".log", ".md", ".markdown"],
  archive: [".zip", ".tar", ".gz", ".7z", ".tgz"],
  patch:   [".gpatch"],
  dsp:     [".gdsp"]
};

/* "video/webm" overlaps "audio/webm"; the audio entry is intentionally
 * not in audio's list above so .webm always classifies as video.  Real
 * detection should peek mime/sniff bytes, but extension is good enough
 * for vault-list filtering. */

function tektiteClassifyAttachment(filename) {
  const lower = String(filename || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return { kind: "other", ext: "" };
  const ext = lower.slice(dot);
  for (const kind of Object.keys(TEKTITE_FILE_KINDS)) {
    if (TEKTITE_FILE_KINDS[kind].indexOf(ext) >= 0) return { kind, ext };
  }
  return { kind: "other", ext };
}

function tektiteAttachmentMime(ext) {
  // Conservative -- the browser usually guesses fine when we leave it
  // blank, but viewers want the right MIME for <embed>/<img>/etc.
  const map = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp",
    ".webp": "image/webp", ".avif": "image/avif",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",  ".flac": "audio/flac", ".3gp": "audio/3gpp",
    ".mp4": "video/mp4",  ".webm": "video/webm", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".ogv": "video/ogg",
    ".pdf": "application/pdf",
    ".csv": "text/csv",   ".tsv": "text/tab-separated-values",
    ".json": "application/json", ".jsonl": "application/x-ndjson",
    ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
    ".txt": "text/plain", ".log": "text/plain",
    ".md":  "text/markdown", ".markdown": "text/markdown",
    ".gpatch": "application/json", ".gdsp": "text/x-c++src"
  };
  return map[String(ext || "").toLowerCase()] || "application/octet-stream";
}

async function tektitePutAttachment(record) {
  if (!record || !record.id || !record.blob) throw new Error("tektitePutAttachment: id+blob required");
  const db = await tektiteVaultOpen();
  const now = Date.now();
  const cls = tektiteClassifyAttachment(record.id);
  const rec = {
    id:         record.id,
    blob:       record.blob,
    kind:       record.kind || cls.kind,
    ext:        cls.ext,
    mime:       record.mime || record.blob.type || tektiteAttachmentMime(cls.ext),
    size:       record.size || record.blob.size || 0,
    createdAt:  record.createdAt || now,
    modifiedAt: now
  };
  const tx = db.transaction(TEKTITE_ATTACHMENTS_STORE, "readwrite");
  tx.objectStore(TEKTITE_ATTACHMENTS_STORE).put(rec);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(rec);
    tx.onerror    = () => reject(tx.error);
  });
}

async function tektiteGetAttachment(id) {
  const db = await tektiteVaultOpen();
  const rec = await new Promise((resolve, reject) => {
    const tx = db.transaction(TEKTITE_ATTACHMENTS_STORE, "readonly");
    const req = tx.objectStore(TEKTITE_ATTACHMENTS_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
  if (!rec) return null;
  // Sprint 10y -- server-backed records carry no blob; fetch on demand.
  if (!rec.blob && rec.serverUrl) {
    try {
      rec.blob = await tektiteVaultServerFetch(rec.serverUrl);
    } catch (e) {
      console.warn("[tektite-vault] server fetch failed for", id, e);
      // Return the record without the blob; callers handle the empty-blob case.
    }
  }
  return rec;
}

async function tektiteListAttachments() {
  const db = await tektiteVaultOpen();
  const tx = db.transaction(TEKTITE_ATTACHMENTS_STORE, "readonly");
  const idx = tx.objectStore(TEKTITE_ATTACHMENTS_STORE).index("modifiedAt");
  return new Promise((resolve, reject) => {
    const out = [];
    const cur = idx.openCursor(null, "prev");
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) { resolve(out); return; }
      // Skip the blob payload when listing; viewers fetch individually.
      const { id, kind, ext, mime, size, createdAt, modifiedAt } = c.value;
      out.push({ id, kind, ext, mime, size, createdAt, modifiedAt });
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

async function tektiteDeleteAttachment(id) {
  // Sprint 10z -- if the record is server-backed, also DELETE on the
  // server so we don't strand orphaned files there.  Best-effort:
  // server failure shouldn't block the local IDB cleanup.
  let rec = null;
  try { rec = await tektiteGetAttachment(id); } catch (_) {}
  if (rec && rec.backing === "server") {
    try { await tektiteVaultServerDelete(id); }
    catch (e) { console.warn("[tektite-vault] server delete failed for", id, e.message); }
  }
  const db = await tektiteVaultOpen();
  const tx = db.transaction(TEKTITE_ATTACHMENTS_STORE, "readwrite");
  tx.objectStore(TEKTITE_ATTACHMENTS_STORE).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/* Import a File / Blob (e.g. from a drag-drop or file picker) into
 * the vault as an attachment.  Returns the resolved id.  Sprint 10x:
 * confirms before storing files past TEKTITE_BIG_FILE_WARN so a single
 * stray drop doesn't blow past the browser's IDB quota and leave the
 * vault in a stuck state.
 *
 * Sprint 10y -- large files can opt into compile-server-backed
 * storage instead of going into IDB.  When server is configured and
 * reachable, the import dialog offers "upload to server" as the
 * default for >TEKTITE_SERVER_HINT files.  Records carry serverUrl
 * + serverSize; tektiteGetAttachment dereferences serverUrl into a
 * Blob on demand. */
const TEKTITE_BIG_FILE_WARN  =  50 * 1024 * 1024;   // 50 MB
const TEKTITE_BIG_FILE_HARD  = 250 * 1024 * 1024;   // 250 MB
const TEKTITE_SERVER_HINT    =  25 * 1024 * 1024;   // 25 MB -- offer server
const TEKTITE_VAULT_REMOTE_FOLDER = "vault/";       // path prefix on the server

/* Read the compile-server URL the user configured for AI settings;
 * reused as the vault-backing server here.  Empty string -> "no
 * server configured" -> import falls back to IDB-only behavior. */
function _tektiteVaultServerUrl() {
  try {
    if (typeof aiSettings === "object" && aiSettings && aiSettings.compileServerUrl) {
      return String(aiSettings.compileServerUrl).replace(/\/+$/, "");
    }
  } catch (_) {}
  return "";
}

/* PUT a Blob to the compile server's vault endpoint.  Server side
 * documented in gamma-compile-server/src/vault-route.js.  PUT raw-
 * body is simpler than multipart (no extra Node deps) and matches the
 * existing /assets/import pattern. */
async function tektiteVaultServerUpload(id, blob) {
  const base = _tektiteVaultServerUrl();
  if (!base) throw new Error("No compile server URL configured in AI settings.");
  const path = String(id).replace(/^\/+/, "");
  const r = await fetch(base + "/vault/file/" + encodeURI(path), {
    method:  "PUT",
    body:    blob,
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    mode:    "cors"
  });
  if (!r.ok) throw new Error("Server upload failed: HTTP " + r.status);
  const j = await r.json();
  if (!j || !j.url) throw new Error("Server upload returned no url");
  return { url: j.url, size: j.size || blob.size || 0 };
}

/* Fetch a previously-uploaded blob from the server. */
async function tektiteVaultServerFetch(url) {
  if (!url) throw new Error("no server url");
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error("Server fetch failed: HTTP " + r.status);
  return await r.blob();
}

/* List server-side vault files (metadata only).  Used by the
 * DevTools menu to compare local IDB usage vs server usage. */
async function tektiteVaultServerList(prefix) {
  const base = _tektiteVaultServerUrl();
  if (!base) return [];
  const r = await fetch(base + "/vault/list" + (prefix ? "?prefix=" + encodeURIComponent(prefix) : ""), {
    mode: "cors"
  });
  if (!r.ok) throw new Error("Server list failed: HTTP " + r.status);
  const j = await r.json();
  return (j && j.files) || [];
}

async function tektiteVaultServerDelete(id) {
  const base = _tektiteVaultServerUrl();
  if (!base) throw new Error("No compile server URL configured.");
  const path = String(id).replace(/^\/+/, "");
  const r = await fetch(base + "/vault/file/" + encodeURI(path), {
    method: "DELETE",
    mode:   "cors"
  });
  if (!r.ok && r.status !== 404) throw new Error("Server delete failed: HTTP " + r.status);
}

async function tektiteImportFile(file) {
  if (!file || !file.name) throw new Error("tektiteImportFile: File required");
  const sz = file.size || 0;
  const haveServer = !!_tektiteVaultServerUrl();
  if (sz > TEKTITE_BIG_FILE_HARD && !haveServer) {
    throw new Error("Refusing to import " + (sz / (1024*1024)).toFixed(1) +
      " MB > " + (TEKTITE_BIG_FILE_HARD / (1024*1024)) +
      " MB hard cap.  Configure a compile-server URL in AI settings to host " +
      "large files instead, or split the file.");
  }
  let storeOnServer = false;
  if (sz > TEKTITE_SERVER_HINT && haveServer) {
    const sizeMb = (sz / (1024*1024)).toFixed(1);
    storeOnServer = window.confirm(
      "This file is " + sizeMb + " MB.\n\n" +
      "Upload to the compile server (" + _tektiteVaultServerUrl() + ") instead of " +
      "storing locally in IndexedDB?\n\n" +
      "OK = upload to server (recommended for big files)\n" +
      "Cancel = keep in browser IDB");
  } else if (sz > TEKTITE_BIG_FILE_WARN && !haveServer) {
    const ok = window.confirm("This file is " + (sz / (1024*1024)).toFixed(1) +
      " MB. Storing very large blobs in IndexedDB can hit browser quota " +
      "limits and put the vault in a stuck state.  Continue?");
    if (!ok) throw new Error("import cancelled by user");
  }
  const rawId = file.name.replace(/\\/g, "/").split("/").pop();
  // Allow multiple imports of the same name by appending -n.
  let id = rawId;
  if (await tektiteGetAttachment(id)) {
    const dot = rawId.lastIndexOf(".");
    const base = dot >= 0 ? rawId.slice(0, dot) : rawId;
    const ext  = dot >= 0 ? rawId.slice(dot)  : "";
    let n = 2;
    while (await tektiteGetAttachment(base + "-" + n + ext)) {
      n++;
      if (n > 9999) throw new Error("too many duplicates");
    }
    id = base + "-" + n + ext;
  }
  if (storeOnServer) {
    let up;
    try { up = await tektiteVaultServerUpload(TEKTITE_VAULT_REMOTE_FOLDER + id, file); }
    catch (e) {
      const fallback = window.confirm(
        "Server upload failed: " + e.message + "\n\nStore locally in IDB instead?");
      if (!fallback) throw e;
      storeOnServer = false;
    }
    if (storeOnServer) {
      const cls = tektiteClassifyAttachment(id);
      // Server-backed record: NO blob payload; viewer derefs serverUrl.
      const rec = {
        id,
        kind:       cls.kind,
        ext:        cls.ext,
        mime:       file.type || tektiteAttachmentMime(cls.ext),
        size:       up.size,
        serverUrl:  up.url,
        createdAt:  Date.now(),
        modifiedAt: Date.now(),
        backing:    "server"
      };
      const db = await tektiteVaultOpen();
      const tx = db.transaction(TEKTITE_ATTACHMENTS_STORE, "readwrite");
      tx.objectStore(TEKTITE_ATTACHMENTS_STORE).put(rec);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      return id;
    }
  }
  await tektitePutAttachment({ id, blob: file, mime: file.type });
  return id;
}

/* =========================================================================
 * Sprint 10x -- Tektite devtools.
 *
 * Console-callable + UI-button-callable commands for emergency vault
 * management.  Use these when the vault hits a quota error, a blob
 * is corrupted, or you just want a fresh start.
 *
 * From the console:
 *   await tektiteDevtoolUnload({ confirmed: true })
 *      -> clears EVERY note + attachment
 *   await tektiteDevtoolUnload({ confirmed: true, scope: "attachments" })
 *      -> attachments only
 *   await tektiteDevtoolUnload({ confirmed: true, scope: "notes" })
 *      -> notes only
 *   await tektiteVaultStats()
 *      -> { noteCount, attachmentCount, notesBytes, attachmentsBytes,
 *           quota, quotaUsed }  bytes are post-compression on disk
 * ======================================================================== */
async function tektiteDevtoolUnload(opts) {
  opts = opts || {};
  if (!opts.confirmed) {
    return "Pass { confirmed: true, scope: 'all' | 'notes' | 'attachments' } to actually drop data.";
  }
  const scope = opts.scope || "all";
  const db = await tektiteVaultOpen();
  const stores = [];
  if (scope === "all" || scope === "notes")       stores.push(TEKTITE_NOTES_STORE);
  if (scope === "all" || scope === "attachments") stores.push(TEKTITE_ATTACHMENTS_STORE);
  for (const sName of stores) {
    const tx = db.transaction(sName, "readwrite");
    tx.objectStore(sName).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }
  console.log("[tektite-devtool] vault cleared:", scope);
  return scope + " cleared";
}

async function tektiteVaultStats() {
  const db = await tektiteVaultOpen();
  function countAndSize(storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      let count = 0, bytes = 0;
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve({ count, bytes }); return; }
        count++;
        const v = c.value;
        if (storeName === TEKTITE_NOTES_STORE) {
          // After compression `content` is either a Uint8Array or string.
          if (v && v.content) {
            bytes += (v.content.byteLength !== undefined)
                   ? v.content.byteLength
                   : v.content.length;
          }
        } else {
          if (v && v.size) bytes += v.size;
          else if (v && v.blob && v.blob.size) bytes += v.blob.size;
        }
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
  }
  const notes       = await countAndSize(TEKTITE_NOTES_STORE);
  const attachments = await countAndSize(TEKTITE_ATTACHMENTS_STORE);
  let quota = null, quotaUsed = null;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      quota     = est.quota;
      quotaUsed = est.usage;
    }
  } catch (_) {}
  return {
    noteCount:         notes.count,
    notesBytes:        notes.bytes,
    attachmentCount:   attachments.count,
    attachmentsBytes:  attachments.bytes,
    quota,             quotaUsed
  };
}

/* Pretty-print version of the stats for the console + the UI button. */
function _tektiteFmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024)         return n + " B";
  if (n < 1024*1024)    return (n / 1024).toFixed(1) + " KB";
  if (n < 1024*1024*1024) return (n / (1024*1024)).toFixed(1) + " MB";
  return (n / (1024*1024*1024)).toFixed(2) + " GB";
}
async function tektiteVaultStatsText() {
  const s = await tektiteVaultStats();
  const lines = [
    "Tektite vault stats:",
    "  notes:       " + s.noteCount + " entries · " + _tektiteFmtBytes(s.notesBytes),
    "  attachments: " + s.attachmentCount + " entries · " + _tektiteFmtBytes(s.attachmentsBytes)
  ];
  if (s.quota != null && s.quotaUsed != null) {
    lines.push("  browser quota: " + _tektiteFmtBytes(s.quotaUsed) +
               " used of " + _tektiteFmtBytes(s.quota) +
               " (" + ((s.quotaUsed / s.quota) * 100).toFixed(1) + "%)");
  }
  return lines.join("\n");
}
