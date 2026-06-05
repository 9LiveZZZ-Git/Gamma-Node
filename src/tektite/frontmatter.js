/* =========================================================================
 * Tektite MD -- YAML frontmatter parser
 *
 * Phase C sprint tektite-3. Recognizes the leading
 *
 *   ---
 *   key: value
 *   tags: [a, b]
 *   ---
 *
 * block at the top of a note. Extracts a typed property map + returns
 * the body markdown separately.  Used by tags.js + search.js as the
 * source of truth for queryable note properties.
 *
 * The parser is a minimal subset of YAML 1.2 -- enough to cover the
 * spec §5.1 property-types list (string / number / date / list /
 * link) without pulling in js-yaml as a CDN dep:
 *
 *   string:   key: hello             -> "hello"
 *             key: "hello: world"    -> "hello: world"
 *             key: 'hello'           -> "hello"
 *   number:   key: 42                -> 42
 *             key: 3.14              -> 3.14
 *   boolean:  key: true              -> true
 *             key: false             -> false
 *   null:     key: null              -> null
 *             key: ~                 -> null
 *   date:     key: 2026-06-04        -> Date object
 *             key: 2026-06-04T12:00  -> Date object
 *   inline list:  key: [a, b, "c"]   -> ["a", "b", "c"]
 *   block list:   key:
 *                   - a
 *                   - b              -> ["a", "b"]
 *   link:     key: "[[Other Note]]"  -> stays as string; consumers walk
 *                                       wikilinks via the existing extractor.
 *
 * Nested maps + multi-line scalars (`|`, `>`) are NOT supported in
 * sprint 3.  If a note needs richer YAML the user can edit it
 * manually and the typed-property index falls back to string.
 *
 * Public surface:
 *   tektiteParseFrontmatter(content)
 *       -> { frontmatter: {...}, body: "...", bodyStart: <int> }
 *       bodyStart is the character offset where the body begins
 *       (after the closing `---\n`); used by the search snippet
 *       generator so offsets line up with the original document.
 *   tektiteSerializeFrontmatter(fm)
 *       -> string. Round-trip writer; used by future template / tag-
 *       rename refactors. Booleans, numbers, dates, lists serialize
 *       to canonical YAML; strings get quoted when they contain
 *       reserved chars.
 * ======================================================================== */

function tektiteParseFrontmatter(content) {
  const text = String(content || "");
  // Must start exactly with `---` followed by EOL.
  if (!/^---[ \t]*\r?\n/.test(text)) {
    return { frontmatter: {}, body: text, bodyStart: 0 };
  }
  // Find the closing fence -- `---` at the start of a line, not
  // immediately after the opener.
  const closeRe = /\n---[ \t]*\r?\n/;
  const closeMatch = text.slice(4).match(closeRe);
  if (!closeMatch) {
    return { frontmatter: {}, body: text, bodyStart: 0 };
  }
  const fmEnd  = 4 + closeMatch.index;             // last char of the YAML block
  const bodyStart = fmEnd + closeMatch[0].length;  // first char of body
  const fmText = text.slice(4, fmEnd);
  const body   = text.slice(bodyStart);
  return {
    frontmatter: _tektiteYamlParse(fmText),
    body,
    bodyStart
  };
}

function _tektiteYamlParse(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let pendingKey = null;
  let pendingList = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) { pendingKey = null; pendingList = null; continue; }
    // `- item` continuation for the block-list form.
    const listM = raw.match(/^\s*-\s+(.+?)\s*$/);
    if (listM && pendingList) {
      pendingList.push(_tektiteYamlValue(listM[1]));
      continue;
    }
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) { pendingKey = null; pendingList = null; continue; }
    const key  = m[1];
    const rest = m[2];
    if (rest === "" || rest === undefined) {
      // Could be a block list or an empty value. Peek at next line:
      // if it's `- foo`, it's a list.
      const nextNonEmpty = lines.slice(i + 1).find(l => l.trim() !== "");
      if (nextNonEmpty && /^\s*-\s+/.test(nextNonEmpty)) {
        pendingKey = key;
        pendingList = [];
        out[key] = pendingList;
      } else {
        out[key] = null;
        pendingKey = null;
        pendingList = null;
      }
      continue;
    }
    if (/^\[.*\]$/.test(rest)) {
      const inner = rest.slice(1, -1).trim();
      out[key] = inner === "" ? [] :
        _tektiteSplitTopLevel(inner).map(s => _tektiteYamlValue(s.trim()));
    } else {
      out[key] = _tektiteYamlValue(rest);
    }
    pendingKey = null;
    pendingList = null;
  }
  return out;
}

/* Split a top-level CSV honoring quoted strings: `a, "b, c", d` -> [a, "b, c", d]. */
function _tektiteSplitTopLevel(s) {
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (ch === q && s[i - 1] !== "\\") q = null;
    } else if (ch === '"' || ch === "'") {
      cur += ch; q = ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function _tektiteYamlValue(raw) {
  const s = String(raw).trim();
  if (!s) return "";
  // Quoted string.
  if ((s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'")) {
    return s.slice(1, -1);
  }
  // Booleans / null.
  if (s === "true"  || s === "True"  || s === "TRUE")  return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (s === "null"  || s === "Null"  || s === "~")     return null;
  // Number.
  if (/^-?\d+$/.test(s))            return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s))       return parseFloat(s);
  // ISO date (YYYY-MM-DD with optional time).
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?)?$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return s;
}

function tektiteSerializeFrontmatter(fm) {
  if (!fm || typeof fm !== "object") return "";
  const keys = Object.keys(fm);
  if (!keys.length) return "";
  const lines = ["---"];
  for (const k of keys) {
    lines.push(k + ": " + _tektiteYamlWriteValue(fm[k]));
  }
  lines.push("---", "");
  return lines.join("\n");
}

function _tektiteYamlWriteValue(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number")  return String(v);
  if (v instanceof Date)      return v.toISOString();
  if (Array.isArray(v)) {
    return "[" + v.map(x => _tektiteYamlWriteValue(x)).join(", ") + "]";
  }
  // String. Quote if it contains a reserved-ish char.
  const s = String(v);
  if (/[:#&*!|>'"%@`,\[\]{}]/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '\\"') + '"';
  }
  return s;
}
