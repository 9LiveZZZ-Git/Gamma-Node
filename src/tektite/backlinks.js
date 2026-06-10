/* =========================================================================
 * Tektite MD -- backlinks index
 *
 * Phase C sprint tektite-2. Maintains an inverse-lookup table:
 *   target id  ->  Set of note ids that contain a [[target]] wikilink
 *
 * The index is built lazily on first access by scanning every note
 * in the vault, then kept in sync incrementally on each editor save
 * (the editor.onSave listener calls tektiteBacklinksOnNoteSaved with
 * the new content; we re-extract that note's links + diff against
 * the prior set to update the inverse map).
 *
 * Vault-only for sprint 2. Cross-source backlinks (e.g. a vault note
 * linking to a GitHub-source note) are a tektite-3 follow-up since
 * they need an async listing crawl.
 *
 * Public surface:
 *   tektiteBacklinksRebuild()
 *       Walks every vault note + re-builds the index from scratch.
 *       Returns a promise that resolves to the entry count.
 *   tektiteBacklinksGetIncoming(targetId)
 *       Returns an array of { noteId, title } entries that link TO
 *       targetId. Empty array when nothing links yet. Sorted by
 *       most-recently-modified.
 *   tektiteBacklinksOnNoteSaved({ id, title, content })
 *       Incremental update; called from the editor onSave listener
 *       when a vault note has been written.
 *   tektiteBacklinksOnNoteDeleted(id)
 *       Removes id from both sides of the index.
 *
 * The index lives in memory only -- rebuilding on page load is cheap
 * (~1 ms per 100 notes since it's pure string scan). No persistence.
 * ======================================================================== */

const _tektiteBacklinks = {
  ready: false,
  // target -> Set of source noteIds that link to it
  inverse: new Map(),
  // noteId -> Set of target strings that this note links to. Used so
  // updates can diff (find removed links + drop them from the inverse).
  forward: new Map(),
  // noteId -> title cache so getIncoming() can return rich entries
  // without having to re-query IDB per backlinks-panel render.
  titles: new Map(),
  // noteId -> modifiedAt for "sort by recent" in getIncoming().
  modAt: new Map()
};

function _tektiteBacklinksDropNote(noteId) {
  const prior = _tektiteBacklinks.forward.get(noteId);
  if (prior) {
    for (const target of prior) {
      const set = _tektiteBacklinks.inverse.get(target);
      if (set) {
        set.delete(noteId);
        if (set.size === 0) _tektiteBacklinks.inverse.delete(target);
      }
    }
    _tektiteBacklinks.forward.delete(noteId);
  }
  _tektiteBacklinks.titles.delete(noteId);
  _tektiteBacklinks.modAt.delete(noteId);
}

function _tektiteBacklinksIngestNote(noteId, title, content, modifiedAt) {
  // Drop any prior entries for this note before re-ingesting.
  _tektiteBacklinksDropNote(noteId);
  // Strip code fences + inline code before scanning so that wikilinks
  // inside code blocks/spans don't produce false-positive backlinks
  // (mirrors _tektiteStripCodeForTags in tags.js).
  const cleaned = String(content || "")
    .replace(/```[\s\S]*?```/g, m => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g,      m => " ".repeat(m.length));
  const links = tektiteMarkdownExtractWikilinks(cleaned);
  const targets = new Set();
  for (const lnk of links) {
    // Strip #heading / #^block anchors so [[Note#Section]] indexes under
    // "Note" (the bare note target), matching how the backlinks panel looks
    // up by note id/title. |alias is already stripped by the extractor.
    const bare = lnk.target.replace(/#.*$/, "").trim();
    if (bare) targets.add(bare);
  }
  // Normalize targets to lowercase for case-insensitive matching;
  // store the original on the inverse-set side via a parallel index
  // so the backlinks panel can render the title casing the user typed.
  // For sprint 2 keep it simple -- compare via .toLowerCase() in the
  // resolver but store the raw target text.
  _tektiteBacklinks.forward.set(noteId, targets);
  for (const t of targets) {
    const key = t.toLowerCase();
    if (!_tektiteBacklinks.inverse.has(key)) {
      _tektiteBacklinks.inverse.set(key, new Set());
    }
    _tektiteBacklinks.inverse.get(key).add(noteId);
  }
  _tektiteBacklinks.titles.set(noteId, title || noteId);
  _tektiteBacklinks.modAt.set(noteId, modifiedAt || 0);
}

async function tektiteBacklinksRebuild() {
  _tektiteBacklinks.inverse.clear();
  _tektiteBacklinks.forward.clear();
  _tektiteBacklinks.titles.clear();
  _tektiteBacklinks.modAt.clear();
  const notes = await tektiteListNotes();
  for (const n of notes) {
    _tektiteBacklinksIngestNote(n.id, n.title || n.id, n.content || "", n.modifiedAt || 0);
  }
  _tektiteBacklinks.ready = true;
  return notes.length;
}

/* Look up everything that links TO the given target. The lookup tries
 * the target as-is first, then case-insensitively. Returns an array
 * sorted by modifiedAt desc. */
function tektiteBacklinksGetIncoming(targetId) {
  if (!targetId) return [];
  const key = String(targetId).toLowerCase();
  const set = _tektiteBacklinks.inverse.get(key);
  if (!set || set.size === 0) return [];
  const out = [];
  for (const sourceId of set) {
    out.push({
      noteId:     sourceId,
      title:      _tektiteBacklinks.titles.get(sourceId) || sourceId,
      modifiedAt: _tektiteBacklinks.modAt.get(sourceId)  || 0
    });
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

function tektiteBacklinksOnNoteSaved(record) {
  if (!record || !record.id) return;
  if (!_tektiteBacklinks.ready) return;  // first access will rebuild
  _tektiteBacklinksIngestNote(
    record.id,
    record.title || record.id,
    record.content || "",
    record.modifiedAt || Date.now()
  );
}

function tektiteBacklinksOnNoteDeleted(noteId) {
  if (!_tektiteBacklinks.ready) return;
  _tektiteBacklinksDropNote(noteId);
}

/* Ensures the index is built before a query. Cheap no-op once warm.
 * The backlinks panel calls this in its async-render path. */
async function tektiteBacklinksEnsureReady() {
  if (!_tektiteBacklinks.ready) await tektiteBacklinksRebuild();
}
