/* =========================================================================
 * Tektite MD -- tag index
 *
 * Phase C sprint tektite-3. Extracts `#tags` from note content + the
 * frontmatter `tags:` array, builds an inverted index, and exposes
 * lookups used by search.js's query DSL + a future Tag-cloud
 * visualization mode.
 *
 * Tag syntax matches Obsidian's convention:
 *   #audio          -- simple
 *   #audio/fm       -- nested (slash-separated levels)
 *   #project-2026   -- hyphens allowed
 *   #docs_v2        -- underscores allowed
 * Tags MUST start with a letter (not digit) so anchor URLs like
 *   https://example.com#anchor / https://example.com/#section
 * don't accidentally register as tags.  Inside `code` and code
 * blocks, # is treated as literal text.
 *
 * The index lives in memory (rebuilt on demand by tektiteTagsRebuild
 * or incrementally via tektiteTagsOnNoteSaved). Mirrors the
 * backlinks-index lifecycle so the two stay in lockstep when the
 * vault is bulk-imported or cleared.
 *
 * Public surface:
 *   tektiteExtractTags(content, frontmatter?)
 *     -> Set<string>   (lowercased tag ids, never carrying the `#`)
 *   tektiteTagsRebuild()        -- walk vault + populate
 *   tektiteTagsEnsureReady()    -- lazy-build on first read
 *   tektiteTagsListAll()        -- [{ tag, count }] sorted by count desc
 *   tektiteTagsGetNotesByTag(tag) -> [{ noteId, title, modifiedAt }]
 *   tektiteTagsOnNoteSaved(record)  / tektiteTagsOnNoteDeleted(id)
 * ======================================================================== */

const _tektiteTagsState = {
  ready:   false,
  // tag -> Set<noteId>
  inverse: new Map(),
  // noteId -> Set<tag> (used so re-ingest can diff + drop stale tags)
  forward: new Map(),
  // noteId -> title cache (mirrors backlinks.js for cheap UI rendering)
  titles:  new Map(),
  modAt:   new Map()
};

/* Regex notes:
 *   (^|[^\w/])          left boundary -- start-of-string or non-word /
 *                       non-slash so we don't catch URL #anchors
 *   #([A-Za-z][\w/-]*)  the tag itself -- must begin with a letter,
 *                       allow word chars, slash, hyphen
 *
 * The negative left boundary specifically excludes `/` to skip
 * `https://example.com/#section`, `\w` to skip cases like `foo#bar`, and
 * `(` to skip markdown internal anchor links like `[text](#anchor)`. */
const _TEKTITE_TAG_RE = /(^|[^\w/(])#([A-Za-z][\w/-]*)/g;

/* Strip code fences + inline code so we don't extract tags from
 * literal source like ```bash\necho #comment\n```. The replacement
 * keeps newlines + length-ish parity so line numbers stay roughly
 * stable (not critical for tag extraction, but helpful for the
 * future "show tag context" snippet generator). */
function _tektiteStripCodeForTags(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, m => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g,      m => " ".repeat(m.length));
}

function tektiteExtractTags(content, frontmatter) {
  const tags = new Set();
  // Frontmatter tags array -- can be strings or YAML-list entries.
  // Accept also a single comma-separated string for legacy notes.
  if (frontmatter) {
    let fmTags = frontmatter.tags;
    if (typeof fmTags === "string") fmTags = fmTags.split(",").map(s => s.trim());
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        const cleaned = String(t || "").replace(/^#/, "").trim();
        if (cleaned) tags.add(cleaned.toLowerCase());
      }
    }
  }
  // Body tags.
  const clean = _tektiteStripCodeForTags(content);
  _TEKTITE_TAG_RE.lastIndex = 0;
  let m;
  while ((m = _TEKTITE_TAG_RE.exec(clean))) {
    tags.add(m[2].toLowerCase());
  }
  return tags;
}

function _tektiteTagsDropNote(noteId) {
  const prior = _tektiteTagsState.forward.get(noteId);
  if (prior) {
    for (const tag of prior) {
      const set = _tektiteTagsState.inverse.get(tag);
      if (set) {
        set.delete(noteId);
        if (set.size === 0) _tektiteTagsState.inverse.delete(tag);
      }
    }
    _tektiteTagsState.forward.delete(noteId);
  }
  _tektiteTagsState.titles.delete(noteId);
  _tektiteTagsState.modAt.delete(noteId);
}

function _tektiteTagsIngestNote(noteId, title, content, modifiedAt) {
  _tektiteTagsDropNote(noteId);
  const parsed = (typeof tektiteParseFrontmatter === "function")
    ? tektiteParseFrontmatter(content)
    : { frontmatter: {}, body: content };
  const fm   = parsed.frontmatter || {};
  const body = parsed.body != null ? parsed.body : content;
  const tags = tektiteExtractTags(body, fm);
  _tektiteTagsState.forward.set(noteId, tags);
  for (const t of tags) {
    if (!_tektiteTagsState.inverse.has(t)) {
      _tektiteTagsState.inverse.set(t, new Set());
    }
    _tektiteTagsState.inverse.get(t).add(noteId);
  }
  _tektiteTagsState.titles.set(noteId, title || noteId);
  _tektiteTagsState.modAt.set(noteId,  modifiedAt || 0);
}

async function tektiteTagsRebuild() {
  _tektiteTagsState.inverse.clear();
  _tektiteTagsState.forward.clear();
  _tektiteTagsState.titles.clear();
  _tektiteTagsState.modAt.clear();
  const notes = await tektiteListNotes();
  for (const n of notes) {
    _tektiteTagsIngestNote(n.id, n.title || n.id, n.content || "", n.modifiedAt || 0);
  }
  _tektiteTagsState.ready = true;
  return notes.length;
}

async function tektiteTagsEnsureReady() {
  if (!_tektiteTagsState.ready) await tektiteTagsRebuild();
}

/* Returns [{ tag, count }] sorted by descending count, ties broken
 * alphabetically. Used by both the search results header + the
 * future tag-cloud viz mode. */
function tektiteTagsListAll() {
  const out = [];
  for (const [tag, set] of _tektiteTagsState.inverse) {
    out.push({ tag, count: set.size });
  }
  out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return out;
}

function tektiteTagsGetNotesByTag(tag) {
  if (!tag) return [];
  const set = _tektiteTagsState.inverse.get(String(tag).toLowerCase());
  if (!set) return [];
  const out = [];
  for (const id of set) {
    out.push({
      noteId: id,
      title: _tektiteTagsState.titles.get(id) || id,
      modifiedAt: _tektiteTagsState.modAt.get(id) || 0
    });
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

function tektiteTagsOnNoteSaved(record) {
  if (!record || !record.id) return;
  if (!_tektiteTagsState.ready) return;
  _tektiteTagsIngestNote(
    record.id,
    record.title || record.id,
    record.content || "",
    record.modifiedAt || Date.now()
  );
}

function tektiteTagsOnNoteDeleted(id) {
  if (!_tektiteTagsState.ready) return;
  _tektiteTagsDropNote(id);
}
