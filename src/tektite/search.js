/* =========================================================================
 * Tektite MD -- search + query DSL
 *
 * Phase C sprint tektite-3. Backs the filter input on the Tektite tab.
 * Supports both plain substring filtering AND a structured query DSL:
 *
 *   tag:audio              -- has tag (case-insensitive, nested allowed)
 *   tag:!draft             -- does NOT have tag
 *   prop:status=draft      -- frontmatter property equals (string)
 *   prop:count>5           -- numeric comparison (=, !=, >, <, >=, <=)
 *   prop:status            -- property is set (any non-null value)
 *   path:notes/            -- note path contains substring
 *   "exact phrase"         -- quoted: exact substring in title+body
 *   bareword               -- substring in title+body (case-insensitive)
 *
 * Multiple terms are AND-joined. To OR, run two queries (saved-query
 * compositions ship in tektite-4).  Examples:
 *
 *   tag:audio tag:!draft "FM synthesis"
 *   prop:status=published prop:wordcount>500
 *   path:journal/ 2026
 *
 * Results carry a relevance score:
 *   tag match:    +10  (cheap + specific)
 *   prop match:   +8   (cheap + specific)
 *   path match:   +5
 *   title text:   +3 per hit
 *   body  text:   +1 per hit
 *
 * Ties broken by modifiedAt descending. Empty queries return [].
 *
 * Vault-only for now. Remote-source search needs an async cross-
 * source crawl that lands in tektite-4 alongside saved queries.
 *
 * Public surface:
 *   tektiteParseQuery(queryStr)
 *     -> { tags:[{name,negate}], props:[{key,op,value}],
 *          paths:[string], textTerms:[{text,quoted}], isStructured }
 *   tektiteRunQuery(queryStr, opts)
 *     -> Promise< [{ noteId, title, modifiedAt, score, snippet }] >
 *        opts.maxResults  default 100
 *        opts.snippetSize default 80
 * ======================================================================== */

const _TEKTITE_QUERY_TOKEN_RE = /(?:"([^"]+)"|(\S+))/g;
const _TEKTITE_PROP_OP_RE     = /^([A-Za-z_][A-Za-z0-9_-]*)(>=|<=|!=|=|>|<)(.+)$/;

function tektiteParseQuery(queryStr) {
  const out = {
    tags:      [],
    props:     [],
    paths:     [],
    textTerms: [],
    isStructured: false
  };
  const s = String(queryStr || "").trim();
  if (!s) return out;

  _TEKTITE_QUERY_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = _TEKTITE_QUERY_TOKEN_RE.exec(s))) {
    const quoted = m[1] !== undefined;
    const tok = quoted ? m[1] : m[2];
    if (!tok) continue;

    if (!quoted && tok.startsWith("tag:")) {
      let name = tok.slice(4).toLowerCase();
      const negate = name.startsWith("!");
      if (negate) name = name.slice(1);
      if (name) { out.tags.push({ name, negate }); out.isStructured = true; }
    } else if (!quoted && tok.startsWith("prop:")) {
      const rest = tok.slice(5);
      const pm = rest.match(_TEKTITE_PROP_OP_RE);
      if (pm) {
        out.props.push({ key: pm[1], op: pm[2], value: pm[3] });
      } else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(rest)) {
        // "prop:status" with no operator = "is set"
        out.props.push({ key: rest, op: "isset", value: null });
      }
      out.isStructured = true;
    } else if (!quoted && tok.startsWith("path:")) {
      const v = tok.slice(5);
      if (v) { out.paths.push(v.toLowerCase()); out.isStructured = true; }
    } else {
      out.textTerms.push({ text: tok, quoted });
    }
  }
  return out;
}

function _tektiteMatchProp(value, op, target) {
  if (op === "isset") {
    return value !== undefined && value !== null && value !== "";
  }
  if (value === undefined || value === null) return op === "!=";
  // Numeric path first.
  const vNum = (typeof value === "number") ? value : parseFloat(value);
  const tNum = parseFloat(target);
  if (Number.isFinite(vNum) && Number.isFinite(tNum) && String(vNum) === String(value).trim()) {
    switch (op) {
      case "=":  return vNum === tNum;
      case "!=": return vNum !== tNum;
      case ">":  return vNum >  tNum;
      case "<":  return vNum <  tNum;
      case ">=": return vNum >= tNum;
      case "<=": return vNum <= tNum;
    }
  }
  // Date path. Treat target as ISO if it parses.
  if (value instanceof Date) {
    const tDate = new Date(target);
    if (!Number.isNaN(tDate.getTime())) {
      const v = value.getTime();
      const t = tDate.getTime();
      switch (op) {
        case "=":  return v === t;
        case "!=": return v !== t;
        case ">":  return v >  t;
        case "<":  return v <  t;
        case ">=": return v >= t;
        case "<=": return v <= t;
      }
    }
  }
  // Boolean.
  if (typeof value === "boolean") {
    const tBool = (target === "true" || target === "1");
    switch (op) {
      case "=":  return value === tBool;
      case "!=": return value !== tBool;
    }
  }
  // Array contains (e.g. prop:tags=audio when tags is a list).
  if (Array.isArray(value)) {
    const lcVals = value.map(x => String(x).toLowerCase());
    const lcT = target.toLowerCase();
    switch (op) {
      case "=":  return lcVals.includes(lcT);
      case "!=": return !lcVals.includes(lcT);
    }
  }
  // String fallback (case-insensitive equality / substring).
  const vStr = String(value).toLowerCase();
  const tStr = target.toLowerCase();
  switch (op) {
    case "=":  return vStr === tStr;
    case "!=": return vStr !== tStr;
    case ">":  return vStr >  tStr;
    case "<":  return vStr <  tStr;
    case ">=": return vStr >= tStr;
    case "<=": return vStr <= tStr;
  }
  return false;
}

/* Generate a 60–80 char snippet centered on the first match of `term`
 * in `text`. Falls back to the first non-empty paragraph when `term`
 * isn't found (used for tag-only queries with no text component). */
function _tektiteMakeSnippet(text, term, snippetSize) {
  const t = String(text || "").replace(/\s+/g, " ");
  if (!t) return "";
  const size = snippetSize || 80;
  if (!term) {
    return t.slice(0, size) + (t.length > size ? "…" : "");
  }
  const lc  = t.toLowerCase();
  const idx = lc.indexOf(String(term).toLowerCase());
  if (idx < 0) return t.slice(0, size) + (t.length > size ? "…" : "");
  const half = Math.floor(size / 2);
  const from = Math.max(0, idx - half);
  const to   = Math.min(t.length, idx + term.length + half);
  return (from > 0 ? "…" : "") + t.slice(from, to) + (to < t.length ? "…" : "");
}

async function tektiteRunQuery(queryStr, opts) {
  opts = opts || {};
  const maxResults  = Number.isFinite(opts.maxResults)  ? opts.maxResults  : 100;
  const snippetSize = Number.isFinite(opts.snippetSize) ? opts.snippetSize : 80;
  const q = tektiteParseQuery(queryStr);
  if (!q.isStructured && !q.textTerms.length) return [];

  const notes = await tektiteListNotes();
  const results = [];

  for (const note of notes) {
    const content = note.content || "";
    const { frontmatter, body } = (typeof tektiteParseFrontmatter === "function")
      ? tektiteParseFrontmatter(content)
      : { frontmatter: {}, body: content };
    const noteTags = (typeof tektiteExtractTags === "function")
      ? tektiteExtractTags(content, frontmatter)
      : new Set();

    // Tag predicates.
    let pass = true;
    for (const f of q.tags) {
      const has = _tektiteTagMatches(noteTags, f.name);
      if (f.negate && has)  { pass = false; break; }
      if (!f.negate && !has){ pass = false; break; }
    }
    if (!pass) continue;

    // Property predicates.
    for (const f of q.props) {
      if (!_tektiteMatchProp(frontmatter[f.key], f.op, f.value)) { pass = false; break; }
    }
    if (!pass) continue;

    // Path predicates.
    for (const p of q.paths) {
      if (!String(note.id).toLowerCase().includes(p)) { pass = false; break; }
    }
    if (!pass) continue;

    // Score + text predicates.
    let score = q.tags.length * 10 + q.props.length * 8 + q.paths.length * 5;
    const titleLc = String(note.title || note.id).toLowerCase();
    const bodyLc  = String(body).toLowerCase();
    let firstTextMatch = null;
    for (const t of q.textTerms) {
      const term = String(t.text).toLowerCase();
      const titleHits = _tektiteCountOccurrences(titleLc, term);
      const bodyHits  = _tektiteCountOccurrences(bodyLc,  term);
      if (titleHits + bodyHits === 0) { pass = false; break; }
      score += titleHits * 3 + bodyHits;
      if (!firstTextMatch) firstTextMatch = t.text;
    }
    if (!pass) continue;

    results.push({
      noteId:     note.id,
      title:      note.title || note.id,
      modifiedAt: note.modifiedAt || 0,
      score,
      snippet:    _tektiteMakeSnippet(body, firstTextMatch, snippetSize),
      matchedTags: Array.from(noteTags).filter(t => q.tags.some(f => !f.negate && _tektiteSingleTagMatches(t, f.name)))
    });
  }

  results.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt);
  return results.slice(0, maxResults);
}

/* Tag match: query "audio" matches notes tagged exactly `audio` OR any
 * `audio/...` nested child. So `tag:audio` finds `#audio/fm`, but
 * `tag:audio/fm` finds only `#audio/fm`. */
function _tektiteSingleTagMatches(noteTag, queryTag) {
  if (noteTag === queryTag) return true;
  return noteTag.startsWith(queryTag + "/");
}
function _tektiteTagMatches(tagSet, queryTag) {
  for (const t of tagSet) {
    if (_tektiteSingleTagMatches(t, queryTag)) return true;
  }
  return false;
}

function _tektiteCountOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) >= 0) {
    n++;
    idx += needle.length;
  }
  return n;
}
