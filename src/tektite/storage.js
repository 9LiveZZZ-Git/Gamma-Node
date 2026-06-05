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
const TEKTITE_VAULT_VERSION = 1;
const TEKTITE_NOTES_STORE   = "notes";

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
