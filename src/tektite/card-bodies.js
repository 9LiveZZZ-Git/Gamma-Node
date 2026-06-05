/* =========================================================================
 * Tektite card body renderer
 *
 * Phase C sprint tektite-10b+ -- attaches a rich body to each
 * TextCard / NoteCard / LinkCard / BaseCard so the content shows
 * inline on the main canvas, mirroring how LLM nodes mount their
 * streaming text body. Per-frame walker (_tickTektiteCards) called
 * from src/visual/render-loop.js alongside _tickLLMRuntime.
 *
 * Per-kind behavior:
 *
 *   TextCard
 *     Renders params.text as markdown into the body via
 *     tektiteMarkdownRenderInto so the full sprint-2c pipeline
 *     (KaTeX / Mermaid / footnotes / transclusion / wikilinks) just
 *     works. Cache on params.text so a static card doesn't re-render.
 *
 *   NoteCard
 *     params.file resolves to a vault note (by id first, then
 *     case-insensitive title). On resolve: stores content + title on
 *     params.text and params.title so downstream wires read them
 *     naturally. Body shows the rendered markdown preview.
 *
 *   LinkCard
 *     Static -- params.url drives an anchor + small preview block.
 *
 *   BaseCard
 *     params.baseId resolves to a Base note (tektite-base:true). On
 *     resolve: runs tektiteBaseExecute, serializes the row set into
 *     params.rows + sets params.count. Body shows a mini table /
 *     list / cards view honoring params.view.
 *
 * The body element is .tektite-card-body, appended INSIDE the node's
 * `.node[data-id="..."]` element. CSS handles the layout (min-height,
 * max-height, scroll, padding, color from params.color JSON-Canvas
 * slot).
 *
 * Cards reuse the same per-card state Map keyed on node.id; entries
 * carry resolved content, last-rendered hash, in-flight promise so
 * async resolves don't double-fire.  Cleared lazily on first access.
 * ======================================================================== */

const _tektiteCardStates = new Map();   // nodeId -> per-card state

function _tektiteCardGetState(node) {
  let st = _tektiteCardStates.get(node.id);
  if (!st) {
    st = {
      lastHash:    "",       // skip identical re-renders
      body:        null,     // cached DOM ref
      bodyNodeEl:  null,
      resolving:   false,
      lastResolveKey: ""     // params.file or params.baseId at last resolve
    };
    _tektiteCardStates.set(node.id, st);
  }
  return st;
}

function _tektiteCardEnsureBody(node, st) {
  const nodeEl = document.querySelector('.node[data-id="' + node.id + '"]');
  if (!nodeEl) return null;
  // Sprint tektite-10c -- mark the node so CSS can override .node's
  // fixed 140 px width and let the card grow with params.width.
  nodeEl.classList.add("tektite-card-node");
  let slot = nodeEl.querySelector(".tektite-card-body");
  const fresh = !slot;
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "tektite-card-body";
    nodeEl.appendChild(slot);
  }
  // Sprint tektite-10c -- card sizing from width/height params +
  // bottom-right grip. The CSS `max-height: 280px` constraint we
  // shipped in 10b is dropped here in favor of params.height so a
  // dragged-bigger card honors the user's choice.
  if (node.params) {
    if (Number.isFinite(node.params.width)) {
      slot.style.minWidth = node.params.width + "px";
      slot.style.maxWidth = "none";
    }
    if (Number.isFinite(node.params.height)) {
      slot.style.minHeight = node.params.height + "px";
      slot.style.maxHeight = "none";
    }
  }
  // Resize grip. Idempotent attach via dataset flag so we don't
  // accumulate listeners on each frame.
  let grip = nodeEl.querySelector(".tektite-card-grip");
  if (!grip) {
    grip = document.createElement("div");
    grip.className = "tektite-card-grip";
    nodeEl.appendChild(grip);
  }
  if (!grip.dataset.wired) {
    grip.dataset.wired = "1";
    _tektiteCardWireGrip(node, grip, slot);
  }
  st.body = slot;
  st.bodyNodeEl = nodeEl;
  if (fresh) st.lastHash = "";  // freshly-mounted body needs an initial render
  return slot;
}

/* Sprint tektite-10c -- corner-grip resize. Updates params.width
 * and params.height in world-space pixels (divided by view.zoom so
 * a 100 px screen drag at zoom=2 records as 50 world px). Listener
 * stops bubbling so the canvas's pan handler doesn't pick the
 * pointerdown up as a board pan. */
function _tektiteCardWireGrip(node, grip, slot) {
  let dragging = false;
  let startX = 0, startY = 0, startW = 0, startH = 0;
  grip.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startW = Number.isFinite(node.params.width)  ? node.params.width  : slot.offsetWidth;
    startH = Number.isFinite(node.params.height) ? node.params.height : slot.offsetHeight;
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
  });
  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const zoom = (typeof view === "object" && view && Number.isFinite(view.zoom)) ? view.zoom : 1;
    const dx = (e.clientX - startX) / Math.max(0.01, zoom);
    const dy = (e.clientY - startY) / Math.max(0.01, zoom);
    node.params = node.params || {};
    node.params.width  = Math.max(120, Math.round(startW + dx));
    node.params.height = Math.max(60,  Math.round(startH + dy));
    slot.style.minWidth  = node.params.width  + "px";
    slot.style.minHeight = node.params.height + "px";
  });
  grip.addEventListener("pointerup", (e) => {
    dragging = false;
    try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
  });
}

/* Per-card color treatment via the JSON Canvas palette slot. Same
 * mapping the Tektite Canvas modal uses. */
function _tektiteCardApplyAccent(slot, node) {
  if (!slot || !node.params) return;
  const c = (typeof tektiteCanvasColor === "function")
    ? tektiteCanvasColor(node.params.color)
    : null;
  if (c) slot.style.borderLeft = "3px solid " + c;
  else   slot.style.borderLeft = "";
}

/* ----- Per-kind body renderers ----------------------------------- */

async function _renderTextCardBody(node, slot, st) {
  const text = String((node.params && node.params.text) || "");
  const hash = "T:" + text;
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  if (!text) {
    slot.innerHTML = '<div class="tektite-card-empty">(empty text card)</div>';
    return;
  }
  if (typeof tektiteMarkdownRenderInto === "function") {
    try { await tektiteMarkdownRenderInto(slot, text); }
    catch (e) { slot.textContent = text; }
  } else {
    slot.textContent = text;
  }
}

async function _renderLinkCardBody(node, slot, st) {
  const url = String((node.params && node.params.url) || "");
  const hash = "L:" + url;
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  if (!url) {
    slot.innerHTML = '<div class="tektite-card-empty">(no url set)</div>';
    return;
  }
  let host = url;
  try { host = new URL(url).hostname || url; } catch (_) {}
  slot.innerHTML =
    '<div class="tektite-card-link-host">🔗 ' + _tektiteCardEsc(host) + '</div>' +
    '<a class="tektite-card-link-url" href="' + _tektiteCardEsc(url) +
      '" target="_blank" rel="noopener">' + _tektiteCardEsc(url) + '</a>';
}

async function _renderNoteCardBody(node, slot, st) {
  const fileKey = String((node.params && node.params.file) || "");
  if (!fileKey) {
    if (st.lastHash !== "N:") {
      st.lastHash = "N:";
      slot.innerHTML = '<div class="tektite-card-empty">Set `file` to a vault note id or title.</div>';
    }
    return;
  }
  // Re-resolve when the file key changes; otherwise reuse the cached
  // text + title written to params.
  if (fileKey !== st.lastResolveKey && !st.resolving) {
    st.resolving = true;
    try {
      let note = await tektiteGetNote(fileKey);
      if (!note) {
        const all = await tektiteListNotes();
        const lc = fileKey.toLowerCase();
        note = all.find(n => (n.title || "").toLowerCase() === lc);
      }
      if (!note) {
        node.params.text = "";
        node.params.title = "";
        slot.innerHTML = '<div class="tektite-card-empty">⚠ Note not found: ' +
          _tektiteCardEsc(fileKey) + '</div>';
        st.lastResolveKey = fileKey;
        st.lastHash = "N:NOTFOUND:" + fileKey;
        return;
      }
      node.params.text  = note.content || "";
      node.params.title = note.title   || note.id;
      st.lastResolveKey = fileKey;
      st.lastHash = "";    // force the body render path below
    } catch (e) {
      slot.innerHTML = '<div class="tektite-card-empty">⚠ Load failed: ' +
        _tektiteCardEsc((e && e.message) || String(e)) + '</div>';
      st.lastHash = "N:ERR:" + fileKey;
    } finally {
      st.resolving = false;
    }
  }
  // Render the markdown body. Hash on the content so a slider tweak
  // doesn't cause a redraw.
  const body = (node.params && node.params.text) || "";
  const title = (node.params && node.params.title) || fileKey;
  const hash = "N:" + fileKey + ":" + body.length + ":" + title;
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  slot.innerHTML = '<div class="tektite-card-note-title">📄 ' +
    _tektiteCardEsc(title) + '</div>' +
    '<div class="tektite-card-note-body"></div>';
  const bodyEl = slot.querySelector(".tektite-card-note-body");
  if (typeof tektiteMarkdownRenderInto === "function" && bodyEl) {
    try { await tektiteMarkdownRenderInto(bodyEl, body); }
    catch (_) { if (bodyEl) bodyEl.textContent = body; }
  } else if (bodyEl) {
    bodyEl.textContent = body;
  }
}

async function _renderBaseCardBody(node, slot, st) {
  const baseId = String((node.params && node.params.baseId) || "");
  const view   = String((node.params && node.params.view)   || "table");
  if (!baseId) {
    if (st.lastHash !== "B:") {
      st.lastHash = "B:";
      slot.innerHTML = '<div class="tektite-card-empty">Set `baseId` to a base note id (a note with <code>tektite-base: true</code>).</div>';
    }
    return;
  }
  // Resolve when baseId changes.
  if (baseId !== st.lastResolveKey && !st.resolving) {
    st.resolving = true;
    try {
      const loaded = await tektiteBaseLoad(baseId);
      const rows = await tektiteBaseExecute(loaded.config);
      st.cachedRows = rows;
      st.cachedTitle = loaded.config["base-title"] || baseId;
      st.cachedColumns = loaded.config["base-columns"] || ["title", "modifiedAt"];
      // Publish to params so downstream wires read naturally.
      node.params.count = rows.length;
      node.params.rows  = JSON.stringify(rows.slice(0, 50).map(r => ({
        id: r.id, title: r.title, modifiedAt: r.modifiedAt,
        ...r.frontmatter
      })));
      st.lastResolveKey = baseId;
      st.lastHash = "";
    } catch (e) {
      slot.innerHTML = '<div class="tektite-card-empty">⚠ Base load failed: ' +
        _tektiteCardEsc((e && e.message) || String(e)) + '</div>';
      st.lastHash = "B:ERR:" + baseId;
      st.resolving = false;
      return;
    }
    st.resolving = false;
  }

  const rows = st.cachedRows || [];
  const cols = st.cachedColumns || ["title"];
  const hash = "B:" + baseId + ":" + view + ":" + rows.length + ":" + cols.join(",");
  if (hash === st.lastHash) return;
  st.lastHash = hash;

  const title = '<div class="tektite-card-base-title">🗃 ' + _tektiteCardEsc(st.cachedTitle || baseId) +
    ' <span class="tektite-card-base-count">' + rows.length + ' row' + (rows.length === 1 ? "" : "s") + '</span></div>';
  if (!rows.length) {
    slot.innerHTML = title + '<div class="tektite-card-empty">(no rows match)</div>';
    return;
  }
  if (view === "table") {
    const header = "<tr>" + cols.map(c => "<th>" + _tektiteCardEsc(c) + "</th>").join("") + "</tr>";
    const body = rows.slice(0, 20).map(r => {
      const cells = cols.map(c => {
        const v = tektiteBaseRowValue(r, c);
        let s = "";
        if (v instanceof Date) s = _tektiteFormatRelativeTime(v.getTime());
        else if (Array.isArray(v)) s = v.join(", ");
        else s = String(v == null ? "" : v);
        return "<td>" + _tektiteCardEsc(s) + "</td>";
      }).join("");
      return "<tr>" + cells + "</tr>";
    }).join("");
    slot.innerHTML = title +
      '<table class="tektite-card-base-table"><thead>' + header + '</thead><tbody>' + body + '</tbody></table>';
  } else if (view === "list") {
    const items = rows.slice(0, 30).map(r =>
      '<li><span>' + _tektiteCardEsc(r.title) + '</span>' +
      (r.modifiedAt ? '<span class="tektite-card-base-ts">' + _tektiteCardEsc(_tektiteFormatRelativeTime(r.modifiedAt)) + '</span>' : '') +
      '</li>').join("");
    slot.innerHTML = title + '<ul class="tektite-card-base-list">' + items + '</ul>';
  } else {
    const items = rows.slice(0, 12).map(r =>
      '<div class="tektite-card-base-card"><div class="tektite-card-base-card-title">' +
      _tektiteCardEsc(r.title) + '</div><div class="tektite-card-base-card-preview">' +
      _tektiteCardEsc(String(r.body || "").replace(/\s+/g, " ").slice(0, 80)) +
      '</div></div>').join("");
    slot.innerHTML = title + '<div class="tektite-card-base-cards">' + items + '</div>';
  }
}

/* Per-frame tick. Idempotent + cheap when no card nodes exist
 * (early-out on the first iter). */
function _tickTektiteCards(dtSec) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  for (let i = 0; i < state.nodes.length; i++) {
    const n = state.nodes[i];
    if (!n || !n.type) continue;
    const def = (typeof TYPES === "object") ? TYPES[n.type] : null;
    if (!def) continue;
    const k = def.kind;
    if (k !== "tektite-card-text"  && k !== "tektite-card-note" &&
        k !== "tektite-card-link"  && k !== "tektite-card-base") continue;
    const st = _tektiteCardGetState(n);
    const slot = _tektiteCardEnsureBody(n, st);
    if (!slot) continue;
    _tektiteCardApplyAccent(slot, n);
    if      (k === "tektite-card-text") _renderTextCardBody(n, slot, st);
    else if (k === "tektite-card-link") _renderLinkCardBody(n, slot, st);
    else if (k === "tektite-card-note") _renderNoteCardBody(n, slot, st);
    else if (k === "tektite-card-base") _renderBaseCardBody(n, slot, st);
  }
}

function _tektiteCardEsc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
