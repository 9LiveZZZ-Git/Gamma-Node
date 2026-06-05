/* =========================================================================
 * Tektite card body renderer  (sprints tektite-10b -> 10d)
 *
 * Mounts a rich, editable body inside each TextCard / NoteCard /
 * LinkCard / BaseCard node on the main canvas.  Per-frame walker
 * _tickTektiteCards (called from src/visual/render-loop.js) handles:
 *
 *   - body mount / re-mount on node re-render
 *   - corner resize grip (10c)
 *   - vault link picker bar (10d)
 *   - inline edit mode toggle (10d): click body -> raw textarea,
 *     blur -> rendered markdown / link / etc.
 *   - two-way vault sync (10d): linked cards write back to their
 *     vault note on edit, and refresh from the vault note when its
 *     content changes externally
 *
 * Edit mode lives on the BODY element via two child layers:
 *
 *   .tektite-card-render  -- rendered markdown / link / base view
 *   .tektite-card-edit    -- textarea / input for raw editing
 *
 * Both are present in the DOM; CSS toggles which is visible based on
 * the .editing class on the body.  Click on .render flips to .edit
 * mode + focuses the input.  Blur on .edit flips back to .render.
 *
 * Vault link bar lives at the TOP of the body:
 *
 *   📎 [filename or "Link to vault…"]   [×]
 *
 * Click the chip to open a prompt for the note id/title.  Click ×
 * to unlink (TextCard / LinkCard only; NoteCard.file is the primary
 * source).
 *
 * Sync semantics for a LINKED card:
 *   - Vault note is canonical source of truth.
 *   - Card edits debounce-save to the vault (400 ms).
 *   - Per-tick poll: if vault note's modifiedAt > st.lastSyncedAt,
 *     refresh card body from the new content.
 *
 * For an UNLINKED card:
 *   - params.text / params.url is the source.
 *   - Edits update params directly.
 *
 * BaseCard is read-only (it's a query view).  Its row set still
 * updates on baseId change + base note edits.
 * ======================================================================== */

const _tektiteCardStates = new Map();   // nodeId -> per-card state

function _tektiteCardGetState(node) {
  let st = _tektiteCardStates.get(node.id);
  if (!st) {
    st = {
      lastHash:       "",
      body:           null,
      bodyNodeEl:     null,
      renderEl:       null,
      editEl:         null,
      linkBar:        null,
      resolving:      false,
      lastResolveKey: "",
      lastSyncedAt:   0,
      editing:        false,
      saveTimer:      null
    };
    _tektiteCardStates.set(node.id, st);
  }
  return st;
}

/* Returns the file id this card is currently linked to (vault), or
 * the empty string if not linked. NoteCard uses `file`; TextCard +
 * LinkCard use `linkedFile`. */
function _tektiteCardLinkedFile(node) {
  if (!node || !node.params) return "";
  if (node.type === "NoteCard") return String(node.params.file || "");
  return String(node.params.linkedFile || "");
}

function _tektiteCardSetLinkedFile(node, val) {
  if (!node) return;
  node.params = node.params || {};
  if (node.type === "NoteCard") node.params.file = val || "";
  else                          node.params.linkedFile = val || "";
}

function _tektiteCardEditable(node) {
  const t = node && node.type;
  return t === "TextCard" || t === "NoteCard" || t === "LinkCard";
}

function _tektiteCardEnsureBody(node, st) {
  const nodeEl = document.querySelector('.node[data-id="' + node.id + '"]');
  if (!nodeEl) return null;
  nodeEl.classList.add("tektite-card-node");

  let body = nodeEl.querySelector(".tektite-card-body");
  const fresh = !body;
  if (!body) {
    body = document.createElement("div");
    body.className = "tektite-card-body";
    body.innerHTML =
      '<div class="tektite-card-linkbar"></div>' +
      '<div class="tektite-card-render"></div>' +
      '<textarea class="tektite-card-edit" spellcheck="false" style="display:none;"></textarea>';
    nodeEl.appendChild(body);
    _tektiteCardWireBody(node, body);
  }
  // Sizing from params.
  if (node.params) {
    if (Number.isFinite(node.params.width)) {
      body.style.minWidth = node.params.width + "px";
      body.style.maxWidth = "none";
    }
    if (Number.isFinite(node.params.height)) {
      body.style.minHeight = node.params.height + "px";
      body.style.maxHeight = "none";
    }
  }
  // Resize grip.
  let grip = nodeEl.querySelector(".tektite-card-grip");
  if (!grip) {
    grip = document.createElement("div");
    grip.className = "tektite-card-grip";
    nodeEl.appendChild(grip);
    _tektiteCardWireGrip(node, grip, body);
  }
  st.body       = body;
  st.bodyNodeEl = nodeEl;
  st.renderEl   = body.querySelector(".tektite-card-render");
  st.editEl     = body.querySelector(".tektite-card-edit");
  st.linkBar    = body.querySelector(".tektite-card-linkbar");
  if (fresh) st.lastHash = "";
  return body;
}

/* Wire body click -> enter edit mode; textarea blur -> exit. Inputs
 * inside the body shouldn't trigger node drag. */
function _tektiteCardWireBody(node, body) {
  const renderEl = body.querySelector(".tektite-card-render");
  const editEl   = body.querySelector(".tektite-card-edit");
  // Edit mode is keyed on the body element; we look up the state map
  // by node id at call time to avoid stale closure references after
  // re-renders.
  function enterEdit(e) {
    if (!_tektiteCardEditable(node)) return;
    if (e && e.target && e.target.closest(".tektite-card-linkbar")) return;
    const st = _tektiteCardGetState(node);
    if (st.editing) return;
    st.editing = true;
    // Initialize textarea from the current source.
    editEl.value = _tektiteCardSourceText(node, st);
    body.classList.add("editing");
    renderEl.style.display = "none";
    editEl.style.display = "block";
    // Auto-focus + select-none so cursor lands at end.
    setTimeout(() => { editEl.focus(); }, 0);
    if (e) e.stopPropagation();
  }
  renderEl.addEventListener("dblclick", enterEdit);
  // Single-click also enters edit mode for low-friction editing, but
  // we ignore clicks on anchors / form controls so they keep working.
  renderEl.addEventListener("click", (e) => {
    if (e.target && (e.target.closest("a") || e.target.tagName === "INPUT")) return;
    enterEdit(e);
  });

  editEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  editEl.addEventListener("input", () => {
    const st = _tektiteCardGetState(node);
    if (st.saveTimer) clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(() => _tektiteCardCommitEdit(node, st), 400);
  });
  editEl.addEventListener("blur", () => {
    const st = _tektiteCardGetState(node);
    // Flush on blur so a quick-edit-and-click-away saves.
    _tektiteCardCommitEdit(node, st);
    st.editing = false;
    body.classList.remove("editing");
    renderEl.style.display = "";
    editEl.style.display = "none";
    // Force re-render of the rendered view.
    st.lastHash = "";
  });
  editEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Revert: refill from source, drop edit mode.
      const st = _tektiteCardGetState(node);
      editEl.value = _tektiteCardSourceText(node, st);
      editEl.blur();
    }
  });
}

/* What text the textarea + render-from-source should use. For linked
 * cards it's the vault note's content (cached in params.text); for
 * unlinked cards it's params.text / params.url. */
function _tektiteCardSourceText(node, st) {
  if (!node || !node.params) return "";
  if (node.type === "LinkCard") return String(node.params.url || "");
  return String(node.params.text || "");
}

/* Persist whatever's in the textarea back to params + (if linked) the
 * vault note. Lightweight + idempotent. */
async function _tektiteCardCommitEdit(node, st) {
  if (!node || !st || !st.editEl) return;
  const raw = st.editEl.value || "";
  node.params = node.params || {};
  if (node.type === "LinkCard") {
    node.params.url = raw.trim();
  } else {
    node.params.text = raw;
  }
  const linkedFile = _tektiteCardLinkedFile(node);
  if (linkedFile) {
    try {
      const existing = await tektiteGetNote(linkedFile);
      if (existing) {
        const newContent = (node.type === "LinkCard")
          ? _tektiteCardMergeLinkIntoFrontmatter(existing.content, raw.trim(), node.params.label || "")
          : raw;
        await tektitePutNote({
          id: existing.id,
          title: existing.title,
          content: newContent,
          createdAt: existing.createdAt
        });
        st.lastSyncedAt = Date.now();
        if (typeof tektiteBacklinksOnNoteSaved === "function") {
          tektiteBacklinksOnNoteSaved({
            id: existing.id, title: existing.title, content: newContent,
            modifiedAt: st.lastSyncedAt
          });
        }
        if (typeof tektiteTagsOnNoteSaved === "function") {
          tektiteTagsOnNoteSaved({
            id: existing.id, title: existing.title, content: newContent,
            modifiedAt: st.lastSyncedAt
          });
        }
      }
    } catch (e) {
      console.warn("[tektite-card] vault save failed:", e);
    }
  }
  st.lastHash = "";  // force re-render
}

/* LinkCard's two-way sync writes the URL into the linked note's
 * frontmatter. Replace existing url:/label: lines or append into the
 * frontmatter block; preserve the rest of the note. */
function _tektiteCardMergeLinkIntoFrontmatter(content, url, label) {
  const fmMatch = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let fmText = fmMatch ? fmMatch[1] : "";
  function upsert(line, key, val) {
    const re = new RegExp("^" + key + ":\\s*.*$", "m");
    const next = val === "" ? "" : (key + ": " + JSON.stringify(val));
    if (re.test(line)) return next ? line.replace(re, next) : line.replace(re, "").replace(/^\n/, "");
    return next ? (line ? line + "\n" + next : next) : line;
  }
  fmText = upsert(fmText, "url",   url);
  fmText = upsert(fmText, "label", label || "");
  if (fmMatch) {
    return content.replace(fmMatch[0], "---\n" + fmText + "\n---\n");
  }
  return "---\n" + fmText + "\n---\n" + content;
}

function _tektiteCardWireGrip(node, grip, body) {
  let dragging = false;
  let startX = 0, startY = 0, startW = 0, startH = 0;
  grip.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startW = Number.isFinite(node.params.width)  ? node.params.width  : body.offsetWidth;
    startH = Number.isFinite(node.params.height) ? node.params.height : body.offsetHeight;
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
    body.style.minWidth  = node.params.width  + "px";
    body.style.minHeight = node.params.height + "px";
  });
  grip.addEventListener("pointerup", (e) => {
    dragging = false;
    try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
  });
}

/* Vault link bar -- shown at the top of every editable card. Renders
 * the current link state + a prompt-driven picker (10d minimum; a
 * proper dropdown picker can replace prompt() in a future sprint). */
function _renderLinkBar(node, st) {
  if (!st.linkBar) return;
  const linkedFile = _tektiteCardLinkedFile(node);
  const editable = _tektiteCardEditable(node);
  if (!editable) {
    st.linkBar.style.display = "none";
    return;
  }
  st.linkBar.style.display = "";
  if (linkedFile) {
    st.linkBar.innerHTML =
      '<button class="tektite-card-link-chip linked" data-act="rename" type="button" title="Change linked vault note">' +
        '🔗 ' + _tektiteCardEsc(linkedFile) +
      '</button>' +
      '<button class="tektite-card-link-x" data-act="unlink" type="button" title="Unlink from vault">×</button>';
  } else {
    st.linkBar.innerHTML =
      '<button class="tektite-card-link-chip" data-act="link" type="button" title="Link this card to a vault note">' +
        '🔗 Link to vault…' +
      '</button>';
  }
  // Wire button handlers (idempotent reset via cloneNode trick).
  st.linkBar.querySelectorAll("button[data-act]").forEach(btn => {
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const act = btn.getAttribute("data-act");
      if (act === "link" || act === "rename") {
        const cur = _tektiteCardLinkedFile(node);
        const target = window.prompt("Vault note id or title to link this card to:", cur);
        if (target == null) return;
        const trimmed = target.trim();
        if (!trimmed) return;
        // Resolve target so we can store the canonical id.
        let note = await tektiteGetNote(trimmed);
        if (!note) {
          const all = await tektiteListNotes();
          note = all.find(n => (n.title || "").toLowerCase() === trimmed.toLowerCase());
        }
        if (!note) {
          if (window.confirm("No note matched. Create a new vault note \"" + trimmed + "\"?")) {
            const id = await tektiteNextAvailableSlug(trimmed);
            const content = (node.type === "LinkCard")
              ? '---\nurl: "' + (node.params.url || "") + '"\n---\n# ' + trimmed + '\n'
              : '# ' + trimmed + '\n\n' + (node.params.text || "");
            await tektitePutNote({ id, title: trimmed, content });
            _tektiteCardSetLinkedFile(node, id);
            st.lastResolveKey = "";  // force re-resolve
            st.lastHash = "";
          }
        } else {
          _tektiteCardSetLinkedFile(node, note.id);
          st.lastResolveKey = "";
          st.lastHash = "";
        }
      } else if (act === "unlink") {
        if (!window.confirm("Unlink this card from " + _tektiteCardLinkedFile(node) +
            "? The card keeps its current content; future edits stop syncing.")) return;
        _tektiteCardSetLinkedFile(node, "");
        st.lastHash = "";
      }
    });
  });
}

/* ----- Per-kind render passes -------------------------------------- */

async function _renderTextCardBody(node, st) {
  const linkedFile = _tektiteCardLinkedFile(node);
  // For a linked card, ensure params.text mirrors the vault note's
  // content + re-poll modifiedAt to catch external edits.
  if (linkedFile && !st.editing) {
    await _tektiteCardPollLinked(node, st);
  }
  const text = String((node.params && node.params.text) || "");
  const hash = "T:" + (linkedFile || "") + ":" + text + ":" + (st.editing ? "E" : "R");
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  if (st.editing) {
    if (st.editEl) st.editEl.value = text;
  } else if (st.renderEl) {
    if (!text) {
      st.renderEl.innerHTML = '<div class="tektite-card-empty">(empty — click to edit)</div>';
    } else if (typeof tektiteMarkdownRenderInto === "function") {
      try { await tektiteMarkdownRenderInto(st.renderEl, text); }
      catch (_) { st.renderEl.textContent = text; }
    } else {
      st.renderEl.textContent = text;
    }
  }
}

async function _renderLinkCardBody(node, st) {
  const linkedFile = _tektiteCardLinkedFile(node);
  if (linkedFile && !st.editing) {
    await _tektiteCardPollLinkedLink(node, st);
  }
  const url   = String((node.params && node.params.url)   || "");
  const label = String((node.params && node.params.label) || "");
  const hash = "L:" + (linkedFile || "") + ":" + url + ":" + label + ":" + (st.editing ? "E" : "R");
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  if (st.editing) {
    if (st.editEl) st.editEl.value = url;
  } else if (st.renderEl) {
    if (!url) {
      st.renderEl.innerHTML = '<div class="tektite-card-empty">(no url — click to edit)</div>';
    } else {
      let host = url;
      try { host = new URL(url).hostname || url; } catch (_) {}
      st.renderEl.innerHTML =
        '<div class="tektite-card-link-host">🔗 ' + _tektiteCardEsc(host) + '</div>' +
        '<a class="tektite-card-link-url" href="' + _tektiteCardEsc(url) +
          '" target="_blank" rel="noopener">' +
            _tektiteCardEsc(label || url) +
          '</a>';
    }
  }
}

async function _renderNoteCardBody(node, st) {
  const fileKey = _tektiteCardLinkedFile(node);
  if (!fileKey) {
    if (st.lastHash !== "N:") {
      st.lastHash = "N:";
      if (st.renderEl) {
        st.renderEl.innerHTML = '<div class="tektite-card-empty">Click 🔗 Link to vault… above to embed a note.</div>';
      }
    }
    return;
  }
  // Async resolve if file changed.
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
        if (st.renderEl) {
          st.renderEl.innerHTML = '<div class="tektite-card-empty">⚠ Note not found: ' +
            _tektiteCardEsc(fileKey) + '</div>';
        }
        st.lastResolveKey = fileKey;
        st.lastHash = "N:NOTFOUND:" + fileKey;
        st.resolving = false;
        return;
      }
      node.params.text  = note.content || "";
      node.params.title = note.title   || note.id;
      st.lastResolveKey = fileKey;
      st.lastSyncedAt   = note.modifiedAt || Date.now();
      st.lastHash       = "";
    } catch (e) {
      if (st.renderEl) {
        st.renderEl.innerHTML = '<div class="tektite-card-empty">⚠ Load failed: ' +
          _tektiteCardEsc((e && e.message) || String(e)) + '</div>';
      }
      st.lastHash = "N:ERR:" + fileKey;
    } finally {
      st.resolving = false;
    }
    return;
  }
  // Polling for external changes.
  if (!st.editing) await _tektiteCardPollLinked(node, st);
  const body  = (node.params && node.params.text)  || "";
  const title = (node.params && node.params.title) || fileKey;
  const hash = "N:" + fileKey + ":" + body.length + ":" + title + ":" + (st.editing ? "E" : "R");
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  if (st.editing) {
    if (st.editEl) st.editEl.value = body;
  } else if (st.renderEl) {
    st.renderEl.innerHTML =
      '<div class="tektite-card-note-title">📄 ' + _tektiteCardEsc(title) + '</div>' +
      '<div class="tektite-card-note-body"></div>';
    const bodyEl = st.renderEl.querySelector(".tektite-card-note-body");
    if (typeof tektiteMarkdownRenderInto === "function" && bodyEl) {
      try { await tektiteMarkdownRenderInto(bodyEl, body); }
      catch (_) { if (bodyEl) bodyEl.textContent = body; }
    } else if (bodyEl) {
      bodyEl.textContent = body;
    }
  }
}

/* Poll the linked vault note. If its modifiedAt jumped (an external
 * edit -- popout / Tektite tab / another card), pull the new content
 * into params.text + invalidate the body hash. Cheap: one IDB read. */
async function _tektiteCardPollLinked(node, st) {
  const linkedFile = _tektiteCardLinkedFile(node);
  if (!linkedFile) return;
  try {
    const note = await tektiteGetNote(linkedFile);
    if (!note) return;
    const m = note.modifiedAt || 0;
    if (m > st.lastSyncedAt + 100) {   // 100 ms cushion vs our own save
      node.params = node.params || {};
      node.params.text  = note.content || "";
      node.params.title = note.title || note.id;
      st.lastSyncedAt   = m;
      st.lastHash       = "";
    }
  } catch (_) {}
}

/* LinkCard variant: pull url + label out of the linked note's
 * frontmatter on external changes. */
async function _tektiteCardPollLinkedLink(node, st) {
  const linkedFile = _tektiteCardLinkedFile(node);
  if (!linkedFile) return;
  try {
    const note = await tektiteGetNote(linkedFile);
    if (!note) return;
    const m = note.modifiedAt || 0;
    if (m > st.lastSyncedAt + 100) {
      const parsed = (typeof tektiteParseFrontmatter === "function")
        ? tektiteParseFrontmatter(note.content || "")
        : { frontmatter: {}, body: note.content };
      node.params = node.params || {};
      if (typeof parsed.frontmatter.url === "string")   node.params.url   = parsed.frontmatter.url;
      if (typeof parsed.frontmatter.label === "string") node.params.label = parsed.frontmatter.label;
      st.lastSyncedAt = m;
      st.lastHash = "";
    }
  } catch (_) {}
}

async function _renderBaseCardBody(node, st) {
  const baseId = String((node.params && node.params.baseId) || "");
  const view   = String((node.params && node.params.view)   || "table");
  if (!baseId) {
    if (st.lastHash !== "B:") {
      st.lastHash = "B:";
      if (st.renderEl) {
        st.renderEl.innerHTML = '<div class="tektite-card-empty">Set <code>baseId</code> to a base note id (a note with <code>tektite-base: true</code>).</div>';
      }
    }
    return;
  }
  if (baseId !== st.lastResolveKey && !st.resolving) {
    st.resolving = true;
    try {
      const loaded = await tektiteBaseLoad(baseId);
      const rows = await tektiteBaseExecute(loaded.config);
      st.cachedRows    = rows;
      st.cachedTitle   = loaded.config["base-title"] || baseId;
      st.cachedColumns = loaded.config["base-columns"] || ["title", "modifiedAt"];
      node.params.count = rows.length;
      node.params.rows  = JSON.stringify(rows.slice(0, 50).map(r => ({
        id: r.id, title: r.title, modifiedAt: r.modifiedAt, ...r.frontmatter
      })));
      st.lastResolveKey = baseId;
      st.lastHash = "";
    } catch (e) {
      if (st.renderEl) {
        st.renderEl.innerHTML = '<div class="tektite-card-empty">⚠ Base load failed: ' +
          _tektiteCardEsc((e && e.message) || String(e)) + '</div>';
      }
      st.lastHash = "B:ERR:" + baseId;
      st.resolving = false;
      return;
    }
    st.resolving = false;
  }
  const rows = st.cachedRows || [];
  const cols = st.cachedColumns || ["title"];
  const hash = "B:" + baseId + ":" + view + ":" + rows.length + ":" + cols.join(",");
  if (hash === st.lastHash || !st.renderEl) return;
  st.lastHash = hash;
  const title = '<div class="tektite-card-base-title">🗃 ' + _tektiteCardEsc(st.cachedTitle || baseId) +
    ' <span class="tektite-card-base-count">' + rows.length + ' row' + (rows.length === 1 ? "" : "s") + '</span></div>';
  if (!rows.length) {
    st.renderEl.innerHTML = title + '<div class="tektite-card-empty">(no rows match)</div>';
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
    st.renderEl.innerHTML = title +
      '<table class="tektite-card-base-table"><thead>' + header + '</thead><tbody>' + body + '</tbody></table>';
  } else if (view === "list") {
    const items = rows.slice(0, 30).map(r =>
      '<li><span>' + _tektiteCardEsc(r.title) + '</span>' +
      (r.modifiedAt ? '<span class="tektite-card-base-ts">' + _tektiteCardEsc(_tektiteFormatRelativeTime(r.modifiedAt)) + '</span>' : '') +
      '</li>').join("");
    st.renderEl.innerHTML = title + '<ul class="tektite-card-base-list">' + items + '</ul>';
  } else {
    const items = rows.slice(0, 12).map(r =>
      '<div class="tektite-card-base-card"><div class="tektite-card-base-card-title">' +
      _tektiteCardEsc(r.title) + '</div><div class="tektite-card-base-card-preview">' +
      _tektiteCardEsc(String(r.body || "").replace(/\s+/g, " ").slice(0, 80)) +
      '</div></div>').join("");
    st.renderEl.innerHTML = title + '<div class="tektite-card-base-cards">' + items + '</div>';
  }
}

/* Per-card color treatment. */
function _tektiteCardApplyAccent(node, st) {
  if (!st.body || !node.params) return;
  const c = (typeof tektiteCanvasColor === "function")
    ? tektiteCanvasColor(node.params.color)
    : null;
  if (c) st.body.style.borderLeft = "3px solid " + c;
  else   st.body.style.borderLeft = "";
}

/* Per-frame tick. */
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
    if (!_tektiteCardEnsureBody(n, st)) continue;
    _tektiteCardApplyAccent(n, st);
    _renderLinkBar(n, st);
    if      (k === "tektite-card-text") _renderTextCardBody(n, st);
    else if (k === "tektite-card-link") _renderLinkCardBody(n, st);
    else if (k === "tektite-card-note") _renderNoteCardBody(n, st);
    else if (k === "tektite-card-base") _renderBaseCardBody(n, st);
  }
}

function _tektiteCardEsc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
