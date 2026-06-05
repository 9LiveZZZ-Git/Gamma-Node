/* =========================================================================
 * Tektite MD -- Bases (typed-frontmatter tabular views)
 *
 * Phase C sprint tektite-8. Lets the user create database-like views
 * of their vault, filtering by tag/property + sorting/grouping by any
 * frontmatter field. Three view layouts in v1 (Table / List / Cards);
 * Map view + formulas land in tektite-8b.
 *
 * A Base is just a vault note with `tektite-base: true` in
 * frontmatter + a configuration in its frontmatter / body. Storage
 * piggy-backs on the existing IDB vault; no separate `.base` files.
 * Format:
 *
 *   ---
 *   tektite-base: true
 *   base-title: "My audio research"
 *   base-filter: "tag:audio prop:status=draft"
 *   base-sort: "modifiedAt desc"
 *   base-groupBy: ""
 *   base-view: "table"
 *   base-columns: [title, status, modifiedAt]
 *   ---
 *   # My audio research
 *
 *   Notes explaining the base ...
 *
 * The body is regular markdown (can include other content), the
 * frontmatter carries the typed configuration parsed by
 * tektiteParseFrontmatter (sprint tektite-3).
 *
 * Public surface:
 *   tektiteBaseListAll()
 *     -> [{ id, title, config }] -- every vault note with
 *        tektite-base: true.
 *   tektiteBaseLoad(id)
 *     -> { config, body, raw } -- parsed config + the human-readable
 *        body of the base note.
 *   tektiteBaseCreate(title)
 *     -> id -- creates a new base note with default config + opens it.
 *   tektiteBaseSave(id, config, body)
 *     -> Promise<void> -- re-serializes the frontmatter + body into
 *        the vault note. Body preserved if not supplied.
 *   tektiteBaseExecute(config)
 *     -> Promise< [{ note, frontmatter, value(col) }] > -- runs the
 *        base's filter + sort + group against the vault. value(col)
 *        returns the property value for that column (handles built-
 *        in cols: title, modifiedAt, createdAt, id).
 *
 * Notes:
 *   - The filter string runs through tektiteRunQuery (sprint
 *     tektite-3). Pass an empty filter to match every note.
 *   - Sort is "by dir" -- e.g. "modifiedAt desc", "title asc",
 *     "wordcount desc".  Multiple sort levels deferred to 8b.
 *   - Sort always takes precedence over the score-based ordering
 *     tektiteRunQuery normally returns.
 *   - Group key is just a property name; the executor returns the
 *     row list as-is + the UI does the bucketing.
 * ======================================================================== */

const TEKTITE_BASE_DEFAULTS = {
  "base-title":   "Untitled base",
  "base-filter":  "",
  "base-sort":    "modifiedAt desc",
  "base-groupBy": "",
  "base-view":    "table",
  "base-columns": ["title", "modifiedAt"]
};

function _tektiteBaseIsBase(note) {
  if (!note || !note.content) return false;
  // Cheap detection without re-parsing frontmatter -- look for the
  // marker line.  Real load goes through tektiteParseFrontmatter.
  return /^---[\s\S]*?\btektite-base:\s*(true|True|TRUE)\b/.test(note.content);
}

async function tektiteBaseListAll() {
  const all = await tektiteListNotes();
  const out = [];
  for (const n of all) {
    if (!_tektiteBaseIsBase(n)) continue;
    const parsed = (typeof tektiteParseFrontmatter === "function")
      ? tektiteParseFrontmatter(n.content)
      : { frontmatter: {}, body: n.content };
    out.push({
      id:    n.id,
      title: parsed.frontmatter["base-title"] || n.title || n.id,
      config: _tektiteBaseConfigFromFrontmatter(parsed.frontmatter)
    });
  }
  out.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  return out;
}

async function tektiteBaseLoad(id) {
  const note = await tektiteGetNote(id);
  if (!note) throw new Error("Base note not found: " + id);
  const parsed = tektiteParseFrontmatter(note.content);
  return {
    note,
    config: _tektiteBaseConfigFromFrontmatter(parsed.frontmatter),
    body:   parsed.body
  };
}

function _tektiteBaseConfigFromFrontmatter(fm) {
  const out = Object.assign({}, TEKTITE_BASE_DEFAULTS);
  for (const k of Object.keys(TEKTITE_BASE_DEFAULTS)) {
    if (fm && fm[k] !== undefined && fm[k] !== null) out[k] = fm[k];
  }
  // Normalize columns -- accept string or array.
  if (typeof out["base-columns"] === "string") {
    out["base-columns"] = out["base-columns"].split(",").map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(out["base-columns"])) out["base-columns"] = ["title"];
  return out;
}

async function tektiteBaseCreate(title) {
  title = String(title || "Untitled base").trim() || "Untitled base";
  const base = "base-" + (typeof tektiteSlugify === "function" ? tektiteSlugify(title) : title.toLowerCase());
  const id = await tektiteNextAvailableSlug(base);
  const fm = Object.assign({}, TEKTITE_BASE_DEFAULTS, {
    "tektite-base": true,
    "base-title":   title
  });
  const content = tektiteSerializeFrontmatter(fm) +
    "# " + title + "\n\n" +
    "Describe this base in plain markdown here.\n";
  await tektitePutNote({ id, title, content });
  return id;
}

async function tektiteBaseSave(id, config, body) {
  const existing = await tektiteGetNote(id);
  if (!existing) throw new Error("Base note not found: " + id);
  const parsed = tektiteParseFrontmatter(existing.content);
  // Merge new config over the existing frontmatter; preserve
  // unrelated frontmatter keys (e.g. tags).
  const fm = Object.assign({}, parsed.frontmatter || {}, {
    "tektite-base": true
  });
  for (const k of Object.keys(TEKTITE_BASE_DEFAULTS)) {
    if (config && config[k] !== undefined) fm[k] = config[k];
  }
  const newBody = (typeof body === "string") ? body : parsed.body;
  const content = tektiteSerializeFrontmatter(fm) + (newBody || "");
  await tektitePutNote({
    id,
    title: fm["base-title"] || existing.title || id,
    content,
    createdAt: existing.createdAt
  });
}

/* The exec output is a flat array of row objects:
 *   { id, note, frontmatter, body, title, modifiedAt, createdAt }
 * Use tektiteBaseRowValue(row, col) to pull the value for any
 * property column (handles built-ins). The UI does its own grouping
 * + rendering. */
async function tektiteBaseExecute(config) {
  const filter = String((config && config["base-filter"]) || "").trim();
  const sortSpec = String((config && config["base-sort"]) || "modifiedAt desc").trim();
  const all = await tektiteListNotes();

  // Filter pass.
  let candidates;
  if (filter) {
    // Reuse the query DSL. We re-execute (tektiteRunQuery returns
    // search-result objects with snippet etc); for bases we want the
    // full note record + frontmatter, so we walk all notes through
    // the parsed query manually instead.
    const q = tektiteParseQuery(filter);
    candidates = [];
    for (const n of all) {
      const parsed = tektiteParseFrontmatter(n.content || "");
      const tags = (typeof tektiteExtractTags === "function")
        ? tektiteExtractTags(n.content || "", parsed.frontmatter)
        : new Set();
      if (!_tektiteBaseMatchesQuery(n, parsed, tags, q)) continue;
      candidates.push({
        id:         n.id,
        note:       n,
        frontmatter: parsed.frontmatter,
        body:       parsed.body,
        title:      n.title || n.id,
        modifiedAt: n.modifiedAt || 0,
        createdAt:  n.createdAt  || 0,
        tags:       Array.from(tags)
      });
    }
  } else {
    candidates = [];
    for (const n of all) {
      const parsed = tektiteParseFrontmatter(n.content || "");
      candidates.push({
        id:         n.id,
        note:       n,
        frontmatter: parsed.frontmatter,
        body:       parsed.body,
        title:      n.title || n.id,
        modifiedAt: n.modifiedAt || 0,
        createdAt:  n.createdAt  || 0,
        tags:       (typeof tektiteExtractTags === "function")
                    ? Array.from(tektiteExtractTags(n.content || "", parsed.frontmatter))
                    : []
      });
    }
  }

  // Sort pass.
  const [sortKey, sortDir = "asc"] = sortSpec.split(/\s+/);
  const dirMul = (String(sortDir).toLowerCase() === "desc") ? -1 : 1;
  candidates.sort((a, b) => {
    const va = tektiteBaseRowValue(a, sortKey);
    const vb = tektiteBaseRowValue(b, sortKey);
    // Date / number comparisons first.
    if (va instanceof Date && vb instanceof Date) return (va - vb) * dirMul;
    const na = (va instanceof Date) ? va.getTime() : Number(va);
    const nb = (vb instanceof Date) ? vb.getTime() : Number(vb);
    if (Number.isFinite(na) && Number.isFinite(nb) && (na !== 0 || vb !== "0") && (nb !== 0 || vb !== "0")) {
      return (na - nb) * dirMul;
    }
    return String(va || "").localeCompare(String(vb || "")) * dirMul;
  });

  return candidates;
}

function tektiteBaseRowValue(row, col) {
  if (!row || !col) return "";
  // Built-in columns.
  if (col === "title")      return row.title;
  if (col === "id")         return row.id;
  if (col === "modifiedAt") return row.modifiedAt ? new Date(row.modifiedAt) : "";
  if (col === "createdAt")  return row.createdAt  ? new Date(row.createdAt)  : "";
  if (col === "tags")       return Array.isArray(row.tags) ? row.tags.join(", ") : "";
  // Body preview -- first 80 chars of the body.
  if (col === "preview")    return String(row.body || "").replace(/\s+/g, " ").slice(0, 80);
  // Otherwise, frontmatter property.
  if (row.frontmatter && Object.prototype.hasOwnProperty.call(row.frontmatter, col)) {
    return row.frontmatter[col];
  }
  return "";
}

/* Run the parsed query AGAINST one note. Mirrors tektiteRunQuery's
 * inner logic but skips scoring + snippet generation.  Lets bases
 * return full note records without re-querying IDB. */
function _tektiteBaseMatchesQuery(note, parsed, tags, q) {
  if (!q) return true;
  for (const f of q.tags) {
    let has = false;
    for (const t of tags) {
      if (t === f.name || t.startsWith(f.name + "/")) { has = true; break; }
    }
    if (f.negate && has) return false;
    if (!f.negate && !has) return false;
  }
  for (const f of q.props) {
    if (!_tektiteBaseMatchProp(parsed.frontmatter[f.key], f.op, f.value)) return false;
  }
  for (const p of q.paths) {
    if (!String(note.id).toLowerCase().includes(p)) return false;
  }
  for (const t of q.textTerms) {
    const term = String(t.text).toLowerCase();
    if (!String(note.title || "").toLowerCase().includes(term) &&
        !String(parsed.body || "").toLowerCase().includes(term)) return false;
  }
  return true;
}

function _tektiteBaseMatchProp(value, op, target) {
  // Same logic as search.js's _tektiteMatchProp; duplicated locally
  // to keep bases.js standalone.  Type-coerce as needed.
  if (op === "isset") return value !== undefined && value !== null && value !== "";
  if (value === undefined || value === null) return op === "!=";
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
  if (Array.isArray(value)) {
    const lcVals = value.map(x => String(x).toLowerCase());
    const lcT = target.toLowerCase();
    if (op === "=")  return lcVals.includes(lcT);
    if (op === "!=") return !lcVals.includes(lcT);
  }
  if (typeof value === "boolean") {
    const tBool = (target === "true" || target === "1");
    if (op === "=")  return value === tBool;
    if (op === "!=") return value !== tBool;
  }
  const vStr = String(value).toLowerCase();
  const tStr = target.toLowerCase();
  switch (op) {
    case "=":  return vStr === tStr;
    case "!=": return vStr !== tStr;
  }
  return false;
}

/* Discover every distinct frontmatter property used across notes
 * (excluding tektite-base/base-* config) so the UI can suggest
 * column candidates. Cheap O(N) walk; cache externally if needed. */
async function tektiteBaseDiscoverProperties() {
  const all = await tektiteListNotes();
  const props = new Set([
    // Built-ins always available.
    "title", "modifiedAt", "createdAt", "tags", "preview", "id"
  ]);
  for (const n of all) {
    const parsed = tektiteParseFrontmatter(n.content || "");
    for (const k of Object.keys(parsed.frontmatter || {})) {
      if (k.startsWith("base-") || k === "tektite-base") continue;
      props.add(k);
    }
  }
  return Array.from(props).sort();
}
