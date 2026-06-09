/* ============================================================================
 * Phase C §7.1 -- Tektite corpus stream (the NotesCorpus bridge)
 *
 * Walks the Tektite vault and yields note text + metadata, filtered by
 * include/exclude rules. Feeds the NotesCorpus node's `corpus` text output,
 * which is consumable TODAY by the Phase B LLM nodes (wire it into
 * LLMEmbed / LLMChat to embed or chat over your own notes) and by Phase D's
 * DatasetLoader later (train a from-scratch model on your knowledge base).
 *
 * include / exclude syntax -- comma- or space-separated terms:
 *   #tag      note carries the tag (matches nested #tag/child too)
 *   folder/   note id lives under that folder prefix
 *   text      substring of the title, body, or id
 * Empty `include` = every note. `exclude` always wins over `include`.
 * `include` terms are OR-combined (match any); `exclude` excludes on any.
 * ==========================================================================*/

function _tektiteCorpusTerms(s) {
  return String(s || "").split(/[,\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
}

/* All #tags mentioned in a note (deduped), for stream metadata. */
function _tektiteCorpusTags(note) {
  const out = new Set();
  const re = /#([a-z0-9_][a-z0-9_\/-]*)/gi;
  const hay = String((note && note.content) || "") + " " + String((note && note.title) || "");
  let m;
  while ((m = re.exec(hay))) out.add(m[1].toLowerCase());
  return Array.from(out);
}

function _tektiteCorpusMatchTerm(note, term) {
  const id    = String(note.id      || "").toLowerCase();
  const title = String(note.title   || "").toLowerCase();
  const body  = String(note.content || "").toLowerCase();
  if (term[0] === "#") {
    const tag = term.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("#" + tag + "(?:\\/|\\b)");
    return re.test(body) || re.test(title);
  }
  if (term.charAt(term.length - 1) === "/") {
    return id.indexOf(term) === 0 || id.indexOf("/" + term) >= 0;
  }
  return title.indexOf(term) >= 0 || body.indexOf(term) >= 0 || id.indexOf(term) >= 0;
}

/* Pure, testable filter: matching subset of note records for the opts.
 * (The IDB walk lives in tektiteCorpusCollect / tektiteCorpusStream.) */
function _tektiteCorpusFilter(notes, opts) {
  const inc = _tektiteCorpusTerms(opts && opts.include);
  const exc = _tektiteCorpusTerms(opts && opts.exclude);
  return (Array.isArray(notes) ? notes : []).filter(note => {
    if (!note) return false;
    for (const t of exc) if (_tektiteCorpusMatchTerm(note, t)) return false;
    if (!inc.length) return true;
    for (const t of inc) if (_tektiteCorpusMatchTerm(note, t)) return true;
    return false;
  });
}

/* Collect the filtered vault into a single corpus string + chunks + stats.
 * opts: { include, exclude, format: "concat"|"chunks", maxChars } */
async function tektiteCorpusCollect(opts) {
  opts = opts || {};
  let notes = [];
  try { notes = await tektiteListNotes(); } catch (_) { notes = []; }
  const matched = _tektiteCorpusFilter(notes, opts);
  const chunks = matched.map(n => ({
    id: n.id,
    title: n.title || n.id,
    text: String(n.content || ""),
    meta: { tags: _tektiteCorpusTags(n), chars: String(n.content || "").length }
  }));
  let text;
  if ((opts.format || "concat") === "chunks") {
    text = chunks.map(c => c.text).join("\n\n");
  } else {
    // concat: a small per-note header keeps provenance legible downstream.
    text = chunks.map(c => "## " + c.title + "\n\n" + c.text).join("\n\n---\n\n");
  }
  const maxChars = (typeof opts.maxChars === "number" && opts.maxChars > 0) ? opts.maxChars : 0;
  if (maxChars && text.length > maxChars) text = text.slice(0, maxChars);
  return { text, chunks, noteCount: matched.length, totalChars: text.length };
}

/* Async generator over the filtered notes -- the shape Phase D's
 * DatasetLoader will consume. tektite.corpus.stream({include,exclude}). */
async function* tektiteCorpusStream(opts) {
  opts = opts || {};
  let notes = [];
  try { notes = await tektiteListNotes(); } catch (_) { notes = []; }
  for (const n of _tektiteCorpusFilter(notes, opts)) {
    yield {
      id: n.id,
      title: n.title || n.id,
      text: String(n.content || ""),
      meta: { tags: _tektiteCorpusTags(n), chars: String(n.content || "").length }
    };
  }
}

/* Per-frame runtime tick for a NotesCorpus node (kind "notes-source").
 * Recomputes the corpus when the filter signature changes, a `refresh`
 * gate pulses, or no corpus has been computed yet -- then publishes the
 * text on params.corpus so _readTextWire can hand it to LLM nodes. */
function _tickNotesCorpus(node) {
  if (!node) return;
  const p  = node.params || (node.params = {});
  const rt = (typeof _llmGetState === "function") ? _llmGetState(node.id) : (node._corpusRt || (node._corpusRt = {}));
  const sig = [p.include || "", p.exclude || "", p.format || "concat", p.maxChars || 0].join("");
  const refreshFired = (typeof _llmDetectGate === "function") && _llmDetectGate(node, rt, "refresh", "lastCorpusRefresh");
  const need = !rt._corpusBusy && (refreshFired || rt._corpusSig !== sig || typeof p.corpus !== "string");
  if (!need) return;
  rt._corpusBusy = true;
  rt._corpusSig  = sig;
  tektiteCorpusCollect({ include: p.include, exclude: p.exclude, format: p.format, maxChars: p.maxChars })
    .then(res => {
      node.params.corpus      = res.text;
      node.params.corpusNotes = res.noteCount;
      node.params.corpusChars = res.totalChars;
    })
    .catch(() => { if (typeof node.params.corpus !== "string") node.params.corpus = ""; })
    .finally(() => { rt._corpusBusy = false; });
}
