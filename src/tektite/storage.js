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
  return new Promise((resolve, reject) => {
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
}

async function tektiteGetNote(id) {
  if (!id) return null;
  const db = await tektiteVaultOpen();
  const tx = db.transaction(TEKTITE_NOTES_STORE, "readonly");
  const store = tx.objectStore(TEKTITE_NOTES_STORE);
  const res = await _tektitePromisifyRequest(store.get(String(id)));
  return res || null;
}

async function tektitePutNote(note) {
  if (!note || !note.id) throw new Error("note.id required");
  const now = Date.now();
  const record = {
    id:         String(note.id),
    title:      String(note.title || note.id),
    content:    String(note.content || ""),
    createdAt:  Number.isFinite(note.createdAt)  ? note.createdAt  : now,
    modifiedAt: now
  };
  const db = await tektiteVaultOpen();
  const tx = db.transaction(TEKTITE_NOTES_STORE, "readwrite");
  const store = tx.objectStore(TEKTITE_NOTES_STORE);
  await _tektitePromisifyRequest(store.put(record));
  return record;
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
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(TEKTITE_ATTACHMENTS_STORE, "readonly");
    const req = tx.objectStore(TEKTITE_ATTACHMENTS_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
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
  const db = await tektiteVaultOpen();
  const tx = db.transaction(TEKTITE_ATTACHMENTS_STORE, "readwrite");
  tx.objectStore(TEKTITE_ATTACHMENTS_STORE).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/* Import a File / Blob (e.g. from a drag-drop or file picker) into
 * the vault as an attachment.  Returns the resolved id. */
async function tektiteImportFile(file) {
  if (!file || !file.name) throw new Error("tektiteImportFile: File required");
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
  await tektitePutAttachment({ id, blob: file, mime: file.type });
  return id;
}
