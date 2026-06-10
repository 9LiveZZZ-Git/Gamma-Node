/* =========================================================================
 * Tektite MD -- Canvas (infinite spatial board, JSON Canvas format)
 *
 * Phase C sprint tektite-9. Obsidian-parity Canvas: drag cards onto
 * an infinite 2D board, wire them together with arrows. Compatible
 * with the open JSON Canvas spec (jsoncanvas.org) so docs round-trip
 * with Obsidian.
 *
 * Storage: Canvas docs are vault markdown notes with
 *   tektite-canvas: true
 * in YAML frontmatter, and the JSON Canvas payload in the body
 * directly (no markdown wrapper). The frontmatter marker keeps them
 * discoverable in the list pane + filterable via the search DSL;
 * the body stays as raw JSON so the Obsidian round-trip works
 * untouched.
 *
 * JSON Canvas shape (subset supported in v1):
 *
 *   {
 *     "nodes": [
 *       { "id": "...", "type": "text", "text": "Hello", "x": 0, "y": 0,
 *         "width": 250, "height": 60, "color": "1" },
 *       { "id": "...", "type": "file", "file": "notes/foo.md", ... },
 *       { "id": "...", "type": "link", "url": "https://...", ... }
 *     ],
 *     "edges": [
 *       { "id": "...", "fromNode": "...", "fromSide": "right",
 *         "toNode":   "...", "toSide":   "left",
 *         "label": "is related to", "color": "4" }
 *     ]
 *   }
 *
 * Color palette mirrors Obsidian's preset slots:
 *   "1" = red    "2" = orange  "3" = yellow
 *   "4" = green  "5" = cyan    "6" = purple
 *
 * In v1 we support text + file node types. Image/PDF/audio/link/
 * group nodes are deferred to tektite-9b along with edge labels +
 * multi-select.
 *
 * Public surface:
 *   tektiteCanvasListAll()     -- vault notes with tektite-canvas:true
 *   tektiteCanvasLoad(id)      -- { config, doc, frontmatter, body }
 *   tektiteCanvasCreate(title) -- writes a minimal new canvas
 *   tektiteCanvasSave(id, doc) -- re-serialize + write
 *   tektiteCanvasNewDoc()      -- empty JSON Canvas doc
 *   tektiteCanvasUid()         -- 8-char random id for new nodes/edges
 * ======================================================================== */

function _tektiteCanvasIsCanvas(note) {
  if (!note || !note.content) return false;
  // Match only within the YAML frontmatter block (between the two --- fences).
  // A plain note that merely *mentions* tektite-canvas in its body must not match.
  const m = note.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  return /\btektite-canvas:\s*(true|True|TRUE)\b/.test(m[1]);
}

async function tektiteCanvasListAll() {
  const all = await tektiteListNotes();
  const out = [];
  for (const n of all) {
    if (!_tektiteCanvasIsCanvas(n)) continue;
    const parsed = (typeof tektiteParseFrontmatter === "function")
      ? tektiteParseFrontmatter(n.content)
      : { frontmatter: {}, body: n.content };
    out.push({
      id:    n.id,
      title: parsed.frontmatter["canvas-title"] || n.title || n.id,
      modifiedAt: n.modifiedAt || 0
    });
  }
  out.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  return out;
}

async function tektiteCanvasLoad(id) {
  const note = await tektiteGetNote(id);
  if (!note) throw new Error("Canvas note not found: " + id);
  const parsed = tektiteParseFrontmatter(note.content);
  let doc;
  try {
    doc = JSON.parse(parsed.body.trim() || "{}");
  } catch (e) {
    console.warn("[tektite-canvas] JSON parse failed – opening read-only to protect original body:", e);
    // Do NOT fall back to an empty doc: autosave would then permanently destroy
    // the original content. Instead return a corrupt-flagged doc so the caller
    // can show a warning and tektiteCanvasSave will refuse to overwrite.
    doc = tektiteCanvasNewDoc();
    doc._corrupt      = true;
    doc._corruptBody  = parsed.body;  // stash for possible manual recovery
  }
  if (!Array.isArray(doc.nodes)) doc.nodes = [];
  if (!Array.isArray(doc.edges)) doc.edges = [];
  return {
    note,
    frontmatter: parsed.frontmatter,
    body:        parsed.body,
    doc
  };
}

async function tektiteCanvasCreate(title) {
  title = String(title || "Untitled canvas").trim() || "Untitled canvas";
  const base = "canvas-" + (typeof tektiteSlugify === "function" ? tektiteSlugify(title) : title.toLowerCase());
  const id = await tektiteNextAvailableSlug(base);
  const fm = {
    "tektite-canvas": true,
    "canvas-title":   title
  };
  // Empty doc; the renderer auto-adds a welcome text card on first
  // open so the user sees something other than blank space.
  const content = tektiteSerializeFrontmatter(fm) + JSON.stringify(tektiteCanvasNewDoc(), null, 2) + "\n";
  await tektitePutNote({ id, title, content });
  return id;
}

async function tektiteCanvasSave(id, doc) {
  // Refuse to overwrite a note whose body failed to parse – the corrupt flag
  // is set by tektiteCanvasLoad when JSON.parse throws, so we have no valid
  // nodes/edges to persist and must not destroy the original body.
  if (doc && doc._corrupt) {
    console.warn("[tektite-canvas] save blocked: doc is flagged corrupt, original body preserved");
    return;
  }
  const existing = await tektiteGetNote(id);
  if (!existing) throw new Error("Canvas note not found: " + id);
  const parsed = tektiteParseFrontmatter(existing.content);
  const fm = Object.assign({}, parsed.frontmatter || {}, {
    "tektite-canvas": true
  });
  // Title sync -- if doc has a "canvas-title" we update it.
  if (doc && doc._title) fm["canvas-title"] = doc._title;
  const payload = {
    nodes: Array.isArray(doc.nodes) ? doc.nodes : [],
    edges: Array.isArray(doc.edges) ? doc.edges : []
  };
  const content = tektiteSerializeFrontmatter(fm) + JSON.stringify(payload, null, 2) + "\n";
  await tektitePutNote({
    id,
    title: fm["canvas-title"] || existing.title || id,
    content,
    createdAt: existing.createdAt
  });
}

function tektiteCanvasNewDoc() {
  return { nodes: [], edges: [] };
}

/* 8-char hex id, matches Obsidian's canvas node id format. */
function tektiteCanvasUid() {
  let s = "";
  const cs = "0123456789abcdef";
  for (let i = 0; i < 8; i++) s += cs[Math.floor(Math.random() * 16)];
  return s;
}

/* Default size for a new node type. */
function tektiteCanvasDefaultSize(type) {
  if (type === "file") return { width: 320, height: 400 };
  if (type === "link") return { width: 320, height: 300 };
  return { width: 260, height: 80 };
}

/* Map a JSON Canvas color slot ("1"-"6") or a `#hex` literal to a
 * CSS color used by the renderer. Returns null when unset so the
 * default theme applies. */
function tektiteCanvasColor(slot) {
  if (!slot) return null;
  const s = String(slot);
  if (s.startsWith("#")) return s;
  const palette = {
    "1": "#e24b4a",   // red
    "2": "#e88d3c",   // orange
    "3": "#f5c878",   // yellow
    "4": "#7ec74a",   // green
    "5": "#5fb8d4",   // cyan
    "6": "#b264c8"    // purple
  };
  return palette[s] || null;
}
