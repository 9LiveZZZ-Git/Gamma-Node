/* =========================================================================
 * Tektite MD -- transclusion (`![[…]]` embeds)
 *
 * Phase C sprint tektite-4. Pre-processes `![[target]]`, `![[target#H1]]`,
 * and `![[target#^block-id]]` patterns BEFORE the markdown is handed to
 * marked + the wikilink rewriter. The embedded content is inlined as
 * Markdown (so headings, code blocks, math etc. all render through the
 * normal pipeline) inside a `<div class="tektite-embed">` wrapper so
 * the preview can style it distinctly + offer a "jump to source" link.
 *
 * Resolution priority mirrors the wikilink navigator:
 *   1. Vault note by id (slug match)
 *   2. Vault note by case-insensitive title match
 *   3. Bare miss -> renders an "unresolved" placeholder so the user
 *      can spot broken embeds at a glance.
 *
 * Section selectors:
 *   ![[note]]              entire body
 *   ![[note#Heading]]      section starting at `## Heading` (any level),
 *                          ending at the next heading of same-or-higher level
 *   ![[note#^block-id]]    block reference (paragraph carrying `^block-id`)
 *
 * Recursion guard: an embedded note that itself transcludes another
 * note is expanded too, BUT a transitive cycle (A -> B -> A) is
 * detected via a visited-set and broken with a `(recursion)` placeholder.
 *
 * Public surface:
 *   tektiteExpandTransclusions(text, opts)
 *     -> Promise<string>. opts:
 *          { maxDepth: 4, visited: Set<string> }
 *        Returns the input with every `![[…]]` replaced. Async because
 *        each lookup hits IDB (cheap, but not sync).
 *
 * Vault-only. Cross-source transclusion (embedding a remote GitHub
 * note inside a vault note) is a tektite-5 follow-up.
 * ======================================================================== */

const _TEKTITE_TRANSCLUSION_RE = /!\[\[([^\[\]\n]+?)\]\]/g;

/* Split a target into { name, anchor }:
 *   "note"             -> { name: "note", anchor: null }
 *   "note#Heading"     -> { name: "note", anchor: { type: "heading", value: "Heading" } }
 *   "note#^block-id"   -> { name: "note", anchor: { type: "block",   value: "block-id" } } */
function _tektiteSplitEmbedTarget(target) {
  const s = String(target).trim();
  const hash = s.indexOf("#");
  if (hash < 0) return { name: s, anchor: null };
  const name = s.slice(0, hash);
  const rest = s.slice(hash + 1);
  if (rest.startsWith("^")) return { name, anchor: { type: "block", value: rest.slice(1) } };
  return { name, anchor: { type: "heading", value: rest } };
}

/* Find a note by id-or-title. Returns the note record or null. */
async function _tektiteResolveEmbedNote(name) {
  if (!name) return null;
  const byId = await tektiteGetNote(name);
  if (byId) return byId;
  // Title fallback (case-insensitive).
  const all = await tektiteListNotes();
  const lc = name.toLowerCase();
  return all.find(n => (n.title || "").toLowerCase() === lc) || null;
}

/* Extract a heading section: starts at the line matching the requested
 * heading, ends at the next heading of same or higher level. Heading
 * text comparison is case-insensitive + ignores trailing whitespace. */
function _tektiteExtractHeading(body, headingText) {
  const lines = String(body || "").split("\n");
  const target = headingText.toLowerCase().trim();
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m && m[2].toLowerCase().trim() === target) {
      startIdx = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= startLevel) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n").replace(/\s+$/, "");
}

/* Block reference: find a paragraph carrying `^block-id` at the end of
 * a line. Returns just that paragraph (back-walked + forward-walked
 * across blank lines). */
function _tektiteExtractBlock(body, blockId) {
  const lines = String(body || "").split("\n");
  const re = new RegExp("\\^" + blockId.replace(/[\\.*+?^${}()|[\]]/g, "\\$&") + "\\b");
  let hitIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { hitIdx = i; break; }
  }
  if (hitIdx < 0) return null;
  let start = hitIdx, end = hitIdx;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  while (end < lines.length - 1 && lines[end + 1].trim() !== "") end++;
  // Strip the `^block-id` marker from the returned text.
  return lines.slice(start, end + 1).join("\n").replace(re, "").trim();
}

async function tektiteExpandTransclusions(text, opts) {
  opts = opts || {};
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 4;
  const visited  = opts.visited instanceof Set ? opts.visited : new Set();
  const source   = String(text || "");

  // Collect every match (sync regex scan), resolve each (async), then
  // splice replacements back in.  Avoids weird interleaving with
  // String.replace + async resolvers.
  const matches = [];
  _TEKTITE_TRANSCLUSION_RE.lastIndex = 0;
  let m;
  while ((m = _TEKTITE_TRANSCLUSION_RE.exec(source))) {
    matches.push({ from: m.index, to: m.index + m[0].length, target: m[1] });
  }
  if (!matches.length) return source;

  const replacements = await Promise.all(matches.map(async (mt) => {
    const { name, anchor } = _tektiteSplitEmbedTarget(mt.target);
    const note = await _tektiteResolveEmbedNote(name);
    if (!note) {
      return _tektiteEmbedWrap(mt.target, _tektiteEmbedMissingHtml(mt.target));
    }
    const key = (note.id || name) + (anchor ? ("#" + anchor.type + ":" + anchor.value) : "");
    if (visited.has(key)) {
      return _tektiteEmbedWrap(mt.target,
        '<div class="tektite-embed-cycle">(recursion: ' + _tektiteEscapeForEmbed(mt.target) + ')</div>');
    }
    let body = note.content || "";
    // Strip the embedded note's frontmatter so it doesn't reappear as
    // a literal `---` block in the host preview.
    if (typeof tektiteParseFrontmatter === "function") {
      const parsed = tektiteParseFrontmatter(body);
      body = parsed.body;
    }
    let section = body;
    if (anchor && anchor.type === "heading") {
      section = _tektiteExtractHeading(body, anchor.value) || ("(heading not found: " + anchor.value + ")");
    } else if (anchor && anchor.type === "block") {
      section = _tektiteExtractBlock(body, anchor.value) || ("(block not found: ^" + anchor.value + ")");
    }
    // Recurse, deeper visited set, decremented depth.
    if (maxDepth > 0) {
      const inner = new Set(visited);
      inner.add(key);
      section = await tektiteExpandTransclusions(section, { maxDepth: maxDepth - 1, visited: inner });
    }
    return _tektiteEmbedWrap(mt.target, section);
  }));

  // Splice from the end so earlier indices stay valid.
  let out = source;
  for (let i = matches.length - 1; i >= 0; i--) {
    const mt = matches[i];
    out = out.slice(0, mt.from) + replacements[i] + out.slice(mt.to);
  }
  return out;
}

function _tektiteEmbedWrap(target, innerMarkdown) {
  // The marker `<div class="tektite-embed">` survives marked rendering
  // because marked treats raw HTML block-level elements as opaque
  // pass-throughs. The inner content is markdown, indented by a blank
  // line above/below so marked treats the wrapped section as a fresh
  // block context.
  return "\n<div class=\"tektite-embed\" data-tektite-embed-target=\"" + _tektiteEscapeForEmbed(target) + "\">\n\n" +
    innerMarkdown +
    "\n\n</div>\n";
}

function _tektiteEmbedMissingHtml(target) {
  return '<div class="tektite-embed-missing">⚠ Embed target not found: <code>' +
    _tektiteEscapeForEmbed(target) + '</code></div>';
}

function _tektiteEscapeForEmbed(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
