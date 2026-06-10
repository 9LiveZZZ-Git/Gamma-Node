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

/* Sprint 10g -- ensure a minimize button + display title live in the
 * node head.  The head is rebuilt on every render() call, so this
 * runs each tick (idempotent: only mutates the head if the button is
 * missing).  Clicking the button toggles node._minimized + the CSS
 * class; subsequent ticks honor the flag.  Also overwrites the head's
 * .name span with the linked-vault title when a card is linked. */
function _tektiteCardEnsureHeadChrome(node, nodeEl, st) {
  const head = nodeEl.querySelector(".node-head");
  if (!head) return;
  // Resolve display title -- vault note title if linked, fallback to
  // node type.  Asynchronously fetched + cached on st.linkedTitle.
  const linkedFile = _tektiteCardLinkedFile(node);
  if (linkedFile && st.lastTitleFile !== linkedFile && !st.resolvingTitle) {
    st.resolvingTitle = true;
    (async () => {
      try {
        const note = await tektiteGetNote(linkedFile);
        st.linkedTitle  = note ? (note.title || note.id) : "";
        st.lastTitleFile = linkedFile;
      } catch (_) {
        st.linkedTitle  = "";
        st.lastTitleFile = linkedFile;
      } finally {
        st.resolvingTitle = false;
      }
    })();
  } else if (!linkedFile && st.lastTitleFile) {
    st.linkedTitle  = "";
    st.lastTitleFile = "";
  }
  const displayName = st.linkedTitle || node.type;
  const nameEl = head.querySelector(".name");
  if (nameEl && nameEl.textContent !== displayName) nameEl.textContent = displayName;

  // Minimize/expand button -- inserted once per head; clicking toggles
  // node._minimized.  pointerdown stopPropagation so the node doesn't
  // start a drag when the user reaches for the button.
  let minBtn = head.querySelector(".tektite-card-minimize");
  if (!minBtn) {
    minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.className = "tektite-card-minimize";
    minBtn.title = "Minimize card";
    minBtn.textContent = node._minimized ? "▢" : "—";
    minBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      node._minimized = !node._minimized;
      const ne = document.querySelector('.node[data-id="' + node.id + '"]');
      if (ne) ne.classList.toggle("minimized", !!node._minimized);
      minBtn.textContent = node._minimized ? "▢" : "—";
      minBtn.title = node._minimized ? "Restore card" : "Minimize card";
    });
    head.appendChild(minBtn);
  } else {
    minBtn.textContent = node._minimized ? "▢" : "—";
  }
  // Sync the class state on the node element each frame (render()
  // rebuilds .node without our class).
  nodeEl.classList.toggle("minimized", !!node._minimized);
}

function _tektiteCardEnsureBody(node, st) {
  const nodeEl = document.querySelector('.node[data-id="' + node.id + '"]');
  if (!nodeEl) return null;
  nodeEl.classList.add("tektite-card-node");
  _tektiteCardEnsureHeadChrome(node, nodeEl, st);

  // Sprint 10e-fix: detect a stale body. The main canvas's render()
  // tears down + rebuilds the node DOM on any drag / undo / select,
  // so the body we mounted last frame may be detached. Check
  // isConnected to catch that case and force a fresh mount + reset.
  let body = nodeEl.querySelector(".tektite-card-body");
  const stale = body && !body.isConnected;   // shouldn't happen since querySelector descends, but belt-and-suspenders
  const fresh = !body || stale || (st.bodyNodeEl && st.bodyNodeEl !== nodeEl);
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
  // Sizing from params.  Sprint 10g -- use explicit width/height
  // instead of min-width/min-height so the resize grip can SHRINK
  // the card, not just grow it.  Content overflows via the render
  // layer's internal scroll (flex: 1 1 auto).
  if (node.params) {
    if (Number.isFinite(node.params.width)) {
      body.style.width    = node.params.width + "px";
      body.style.minWidth = "";
      body.style.maxWidth = "none";
    }
    if (Number.isFinite(node.params.height)) {
      body.style.height    = node.params.height + "px";
      body.style.minHeight = "";
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
  // render() tears the node DOM down without firing blur on a focused
  // textarea (WHATWG focus-fixup), so a mid-edit re-render would leave
  // st.editing latched forever and the blur flush never runs. Flush
  // the OLD textarea's pending edit before st.editEl is repointed at
  // the new (empty) one, then drop edit mode.
  if (fresh && st.editing) {
    if (st.saveTimer) {
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
      if (st.editEl) _tektiteCardCommitEdit(node, st, st.editEl.value || "");
    }
    st.editing = false;
    body.classList.remove("editing");
  }
  st.body       = body;
  st.bodyNodeEl = nodeEl;
  st.renderEl   = body.querySelector(".tektite-card-render");
  st.editEl     = body.querySelector(".tektite-card-edit");
  st.linkBar    = body.querySelector(".tektite-card-linkbar");
  if (fresh) {
    // Reset every cached state that points at the old DOM so the
    // render passes rebuild from scratch in this body.
    st.lastHash       = "";
    st.linkBarHash    = "";
    st.lastResolveKey = "";
    // Graph card -- old canvas + renderer are dead, drop them so the
    // _renderGraphCardBody fresh-mount branch runs.
    if (st.graphRenderer && typeof st.graphRenderer.destroy === "function") {
      try { st.graphRenderer.destroy(); } catch (_) {}
    }
    if (st.graphResizeObs && typeof st.graphResizeObs.disconnect === "function") {
      try { st.graphResizeObs.disconnect(); } catch (_) {}
    }
    st.graphRenderer   = null;
    st.graphResizeObs  = null;
    st.graphCanvas     = null;
    st.graphModeEl     = null;
    st.graphModeSel    = null;
    st.graphLayoutSel  = null;
    st.graphStatsEl    = null;
    st.graphExpandBtn  = null;
    st.graphConfigHash = "";
    // Sprint 10m -- CanvasCard refs too.
    st.canvasCardEl  = null;
    st.canvasTitleEl = null;
    st.canvasStatsEl = null;
    st.canvasOpenBtn = null;
    st.canvasThumbEl = null;
    st.canvasEmptyEl = null;
    st.canvasLastId  = "";
  }
  return body;
}

/* Wire body click -> enter edit mode; textarea blur -> exit. Inputs
 * inside the body shouldn't trigger node drag. */
function _tektiteCardWireBody(node, body) {
  const renderEl = body.querySelector(".tektite-card-render");
  const editEl   = body.querySelector(".tektite-card-edit");

  // Sprint 10d-fix: stop pointerdown on the body from reaching the
  // canvas. Canvas pointerdown selects + drag-arms the node, then
  // calls render() which destroys the body DOM mid-gesture, so the
  // subsequent click event never fires (its pointerdown target is
  // gone). Catching it on the body lets click reach our listener.
  // Exceptions: the linkbar (its buttons handle their own events)
  // and anchor links inside rendered markdown.
  body.addEventListener("pointerdown", (e) => {
    if (e.target && e.target.closest(".tektite-card-linkbar")) return;
    if (e.target && e.target.closest("a")) return;
    if (e.target && e.target.closest(".tektite-card-grip")) return;
    e.stopPropagation();
    // Manually select the node so other selection-aware UI still
    // updates (props pane, etc.). selectOne does NOT re-render.
    if (typeof selectOne === "function") selectOne(node.id);
  });

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
    // Pre-edit snapshot for Escape-revert -- the debounced autosave
    // overwrites params (and the vault note) long before Escape, so
    // re-reading the "source" at Escape time would revert nothing.
    st.editOriginal = editEl.value;
    body.classList.add("editing");
    renderEl.style.display = "none";
    editEl.style.display = "block";
    // Auto-focus + caret-to-end so the user can immediately type.
    setTimeout(() => {
      editEl.focus();
      try { editEl.setSelectionRange(editEl.value.length, editEl.value.length); } catch (_) {}
    }, 0);
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
    // Capture the value NOW -- a canvas render() can detach this
    // textarea before the debounce fires, and st.editEl would then
    // point at a fresh EMPTY one (wiping the linked vault note).
    const val = editEl.value || "";
    if (st.saveTimer) clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(() => {
      st.saveTimer = null;
      _tektiteCardCommitEdit(node, st, val);
    }, 400);
  });
  editEl.addEventListener("blur", () => {
    const st = _tektiteCardGetState(node);
    // Drop the pending debounce so it can't re-commit edited text
    // after an Escape-revert; the flush below saves the final value.
    if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; }
    // Flush on blur so a quick-edit-and-click-away saves.
    _tektiteCardCommitEdit(node, st, editEl.value || "");
    st.editing = false;
    body.classList.remove("editing");
    renderEl.style.display = "";
    editEl.style.display = "none";
    // Force re-render of the rendered view.
    st.lastHash = "";
  });
  // Stop ALL keydown from bubbling to window/document while the user
  // is typing -- the global handlers all guard on isTextInput, but
  // belt-and-suspenders so any future global hotkey can't fire.
  editEl.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      // Revert: restore the pre-edit snapshot (params already hold
      // autosaved edits), drop edit mode. The blur flush re-commits
      // the snapshot to params + the linked vault note.
      const st = _tektiteCardGetState(node);
      editEl.value = (typeof st.editOriginal === "string")
        ? st.editOriginal
        : _tektiteCardSourceText(node, st);
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
async function _tektiteCardCommitEdit(node, st, rawOverride) {
  if (!node || !st) return;
  // Callers capture the textarea value at event time (rawOverride);
  // reading st.editEl at fire time can hit a detached or freshly
  // remounted (empty) textarea after a canvas re-render.
  const raw = (typeof rawOverride === "string")
    ? rawOverride
    : ((st.editEl && st.editEl.isConnected) ? (st.editEl.value || "") : null);
  if (raw === null) return;
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
    // Replacer FUNCTION keeps $-patterns in the URL literal ($& etc.
    // in a replacement STRING expand to the matched text).
    if (re.test(line)) return next ? line.replace(re, () => next) : line.replace(re, "").replace(/^\n/, "");
    return next ? (line ? line + "\n" + next : next) : line;
  }
  fmText = upsert(fmText, "url",   url);
  fmText = upsert(fmText, "label", label || "");
  if (fmMatch) {
    return content.replace(fmMatch[0], () => "---\n" + fmText + "\n---\n");
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
    // Sprint 10g -- explicit width/height so the body can shrink as
    // well as grow.  Min-width on the body was clamping us up only.
    body.style.width    = node.params.width  + "px";
    body.style.height   = node.params.height + "px";
    body.style.minWidth  = "";
    body.style.minHeight = "";
  });
  grip.addEventListener("pointerup", (e) => {
    dragging = false;
    try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
  });
}

/* Vault link bar -- shown at the top of every editable card. Renders
 * the current link state + a dropdown picker for vault notes.
 *
 * Sprint 10d-fix: idempotent rebuild. Was rewriting innerHTML every
 * frame which destroyed the button handlers (so clicks did nothing).
 * Hash check guards the rebuild + re-wire. */
function _renderLinkBar(node, st) {
  if (!st.linkBar) return;
  const linkedFile = _tektiteCardLinkedFile(node);
  const editable = _tektiteCardEditable(node);
  if (!editable) {
    if (st.linkBarHash !== "hide") {
      st.linkBarHash = "hide";
      st.linkBar.style.display = "none";
    }
    return;
  }
  const linkBarHash = "show:" + (linkedFile || "");
  if (st.linkBarHash === linkBarHash) return;
  st.linkBarHash = linkBarHash;
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
  // Wire button handlers fresh after rebuild.
  st.linkBar.querySelectorAll("button[data-act]").forEach(btn => {
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const act = btn.getAttribute("data-act");
      if (act === "link" || act === "rename") {
        _openVaultPicker(btn, _tektiteCardLinkedFile(node), async (pick) => {
          if (pick.id) {
            _tektiteCardSetLinkedFile(node, pick.id);
          } else if (pick.create) {
            const id = await tektiteNextAvailableSlug(pick.create);
            const content = (node.type === "LinkCard")
              ? '---\nurl: "' + (node.params.url || "") + '"\n---\n# ' + pick.create + '\n'
              : '# ' + pick.create + '\n\n' + (node.params.text || "");
            await tektitePutNote({ id, title: pick.create, content });
            _tektiteCardSetLinkedFile(node, id);
          } else {
            return;
          }
          st.lastResolveKey = "";   // force re-resolve
          st.lastHash       = "";
          st.linkBarHash    = "";   // force link-bar rebuild with new state
        });
      } else if (act === "unlink") {
        if (!window.confirm("Unlink this card from " + _tektiteCardLinkedFile(node) +
            "? The card keeps its current content; future edits stop syncing.")) return;
        _tektiteCardSetLinkedFile(node, "");
        st.lastHash    = "";
        st.linkBarHash = "";
      }
    });
  });
}

/* Vault dropdown picker (sprint 10d-fix). Singleton popover anchored
 * to a trigger button. Lists vault notes with type-ahead filter and
 * a "Create note" affordance if the typed text doesn't match. */
let _tektitePickerEl = null;
let _tektitePickerCleanup = null;

function _ensureVaultPicker() {
  if (_tektitePickerEl) return _tektitePickerEl;
  const el = document.createElement("div");
  el.className = "tektite-vault-picker";
  el.style.display = "none";
  el.innerHTML =
    '<input type="text" class="tvp-search" placeholder="Filter or create new…" spellcheck="false" autocomplete="off">' +
    '<div class="tvp-list"></div>';
  document.body.appendChild(el);
  _tektitePickerEl = el;
  return el;
}

async function _openVaultPicker(anchorBtn, initial, onPick) {
  // Close any open picker first.
  if (typeof _tektitePickerCleanup === "function") _tektitePickerCleanup();
  const el = _ensureVaultPicker();
  const searchEl = el.querySelector(".tvp-search");
  const listEl   = el.querySelector(".tvp-list");

  let notes = [];
  try { notes = await tektiteListNotes(); } catch (_) { notes = []; }

  // Anchor below the trigger button, clamped to the viewport.  When
  // anchorBtn is null or the literal string "center", the picker
  // floats near the top-center of the viewport instead (used by the
  // quick switcher in sprint 10h).
  el.style.display = "block";
  const pickerW = 280;
  if (anchorBtn && typeof anchorBtn.getBoundingClientRect === "function") {
    const rect = anchorBtn.getBoundingClientRect();
    let left = rect.left;
    if (left + pickerW > window.innerWidth - 8) left = window.innerWidth - pickerW - 8;
    el.style.left = Math.max(8, left) + "px";
    el.style.top  = Math.min(rect.bottom + 4, window.innerHeight - 240) + "px";
  } else {
    el.style.left = Math.max(8, (window.innerWidth - pickerW) / 2) + "px";
    el.style.top  = "80px";
  }

  searchEl.value = initial || "";

  function renderList() {
    const q = (searchEl.value || "").toLowerCase().trim();
    const matches = notes.filter(n => {
      if (!q) return true;
      return (n.id    || "").toLowerCase().includes(q) ||
             (n.title || "").toLowerCase().includes(q);
    });
    let html = matches.slice(0, 80).map(n =>
      '<div class="tvp-row" data-id="' + _tektiteCardEsc(n.id) + '">' +
        '<div class="tvp-title">' + _tektiteCardEsc(n.title || n.id) + '</div>' +
        '<div class="tvp-id">' + _tektiteCardEsc(n.id) + '</div>' +
      '</div>'
    ).join("");
    const exactMatch = !!matches.find(n =>
      (n.id || "").toLowerCase() === q || (n.title || "").toLowerCase() === q
    );
    if (q && !exactMatch) {
      html += '<div class="tvp-row tvp-create" data-create="' + _tektiteCardEsc(searchEl.value.trim()) + '">' +
        '<div class="tvp-title">+ Create note &quot;' + _tektiteCardEsc(searchEl.value.trim()) + '&quot;</div>' +
        '</div>';
    }
    if (!matches.length && !q) {
      html = '<div class="tvp-empty">(vault is empty — type a name and Enter to create)</div>';
    }
    listEl.innerHTML = html;
  }

  renderList();
  setTimeout(() => { searchEl.focus(); searchEl.select(); }, 0);

  function close() {
    el.style.display = "none";
    document.removeEventListener("pointerdown", outsideHandler, true);
    searchEl.removeEventListener("input",   renderList);
    searchEl.removeEventListener("keydown", keyHandler);
    listEl  .removeEventListener("click",   clickHandler);
    _tektitePickerCleanup = null;
  }
  _tektitePickerCleanup = close;

  function outsideHandler(e) {
    if (!el.contains(e.target)) close();
  }
  function keyHandler(e) {
    e.stopPropagation();
    if (e.key === "Escape") { close(); return; }
    if (e.key === "Enter") {
      const first = listEl.querySelector(".tvp-row");
      if (first) first.click();
    }
  }
  function clickHandler(e) {
    const row = e.target.closest(".tvp-row");
    if (!row) return;
    if (row.dataset.create) {
      const v = row.getAttribute("data-create") || "";
      close();
      onPick({ create: v });
    } else if (row.dataset.id) {
      close();
      onPick({ id: row.dataset.id });
    }
  }

  searchEl.addEventListener("input",   renderList);
  searchEl.addEventListener("keydown", keyHandler);
  listEl  .addEventListener("click",   clickHandler);
  // Defer outside-click capture so the click that opened us doesn't
  // also close us.
  setTimeout(() => document.addEventListener("pointerdown", outsideHandler, true), 0);
}

/* ----- Per-kind render passes -------------------------------------- */

async function _renderTextCardBody(node, st) {
  // Sprint 10d-fix: bail completely while editing. The textarea is
  // user-owned; touching its .value resets the caret to 0 and makes
  // typing feel broken.
  if (st.editing) return;
  const linkedFile = _tektiteCardLinkedFile(node);
  // For a linked card, ensure params.text mirrors the vault note's
  // content + re-poll modifiedAt to catch external edits.
  if (linkedFile) {
    await _tektiteCardPollLinked(node, st);
  }
  const text = String((node.params && node.params.text) || "");
  const hash = "T:" + (linkedFile || "") + ":" + text + ":R";
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  if (st.renderEl) {
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
  if (st.editing) return;   // user owns the textarea
  const linkedFile = _tektiteCardLinkedFile(node);
  if (linkedFile) {
    await _tektiteCardPollLinkedLink(node, st);
  }
  const url   = String((node.params && node.params.url)   || "");
  const label = String((node.params && node.params.label) || "");
  const hash = "L:" + (linkedFile || "") + ":" + url + ":" + label + ":R";
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  if (st.renderEl) {
    if (!url) {
      st.renderEl.innerHTML = '<div class="tektite-card-empty">(no url — click to edit)</div>';
    } else {
      let host = url;
      try { host = new URL(url).hostname || url; } catch (_) {}
      // The url can come from untrusted note frontmatter (imported /
      // shared vaults); only emit a live anchor for safe schemes --
      // a javascript: href would run in the editor's origin.
      const scheme = (/^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url) || [])[1] || "";
      const safeScheme = !scheme || /^(https?|mailto)$/i.test(scheme);
      st.renderEl.innerHTML =
        '<div class="tektite-card-link-host">🔗 ' + _tektiteCardEsc(host) + '</div>' +
        (safeScheme
          ? '<a class="tektite-card-link-url" href="' + _tektiteCardEsc(url) +
              '" target="_blank" rel="noopener">' +
                _tektiteCardEsc(label || url) +
              '</a>'
          : '<span class="tektite-card-link-url">' +
                _tektiteCardEsc(label || url) +
              '</span>');
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
        // Re-key params.file to the real note id -- commit + poll look
        // up by id, so a title-keyed card would silently drop edits.
        if (note) node.params.file = note.id;
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
      // Mark resolved so the next tick doesn't re-enter this branch
      // (IDB read + innerHTML rewrite) at frame rate.
      st.lastResolveKey = fileKey;
    } finally {
      st.resolving = false;
    }
    return;
  }
  if (st.editing) return;   // user owns the textarea
  // Polling for external changes.
  await _tektiteCardPollLinked(node, st);
  // Keep the load-failed view until fileKey changes or the poll above
  // pulls a fresh copy (which clears lastHash).
  if (st.lastHash === "N:ERR:" + fileKey) return;
  const body  = (node.params && node.params.text)  || "";
  const title = (node.params && node.params.title) || fileKey;
  const hash = "N:" + fileKey + ":" + body.length + ":" + title + ":R";
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  if (st.renderEl) {
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
      st.lastSyncedAt   = (loaded.note && loaded.note.modifiedAt) || Date.now();
      st.lastResolveKey = baseId;
      st.lastHash = "";
    } catch (e) {
      if (st.renderEl) {
        st.renderEl.innerHTML = '<div class="tektite-card-empty">⚠ Base load failed: ' +
          _tektiteCardEsc((e && e.message) || String(e)) + '</div>';
      }
      st.lastHash = "B:ERR:" + baseId;
      // Mark resolved (+ stamp lastSyncedAt) so the next tick doesn't
      // re-enter this branch at frame rate; the poll below retries
      // only once the base note is edited/created after the failure.
      st.lastResolveKey = baseId;
      st.lastSyncedAt   = Date.now();
      st.resolving = false;
      return;
    }
    st.resolving = false;
  } else if (!st.resolving) {
    // Header contract: row set updates on base note edits too. Poll
    // the base note's modifiedAt (one IDB read per tick, mirroring
    // _tektiteCardPollLinked) and force a re-load + re-execute.
    try {
      const bn = await tektiteGetNote(baseId);
      if (bn && (bn.modifiedAt || 0) > st.lastSyncedAt + 100) {
        st.lastResolveKey = "";
        return;
      }
    } catch (_) {}
  }
  // Keep the load-failed view (don't repaint with stale/empty rows)
  // until baseId changes or the poll above invalidates the resolve.
  if (st.lastHash === "B:ERR:" + baseId) return;
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

/* Sprint tektite-10e -- GraphCard.  Force-directed view of the
 * vault graph in a card-shaped canvas; click a graph node to open a
 * popout; the ⛶ button expands to the full 🕸 Graph modal.  Reuses
 * tektiteGraphBuild + tektiteGraphRenderer from src/tektite/graph.js
 * so the layout matches what the modal shows. */
async function _renderGraphCardBody(node, st) {
  if (!st.renderEl) return;
  // Build the canvas + expand button on first mount.
  if (!st.graphCanvas) {
    // Sprint 10e-fix: mark the render layer so CSS can flex-fill the
    // canvas (no fixed 220 px height anymore).
    st.renderEl.classList.add("tektite-card-graph-render");
    // Sprint 10s -- two native <select>s instead of a single chip,
    // matching the modal's mode + layout dropdowns.
    st.renderEl.innerHTML =
      '<div class="tektite-card-graph-bar">' +
        '<select class="tektite-card-graph-mode-sel" title="Scope">' +
          '<option value="global">Global</option>' +
          '<option value="local">Local</option>' +
        '</select>' +
        '<select class="tektite-card-graph-layout-sel" title="Layout">' +
          '<optgroup label="Structural">' +
            '<option value="force">⚛ Force</option>' +
            '<option value="tree">⊥ Tree</option>' +
            '<option value="radial">◎ Radial</option>' +
            '<option value="sunburst">☀ Sunburst</option>' +
          '</optgroup>' +
          '<optgroup label="Semantic + Time">' +
            '<option value="embedding-2d">✨ Embed 2D</option>' +
            '<option value="galaxy">🌌 Galaxy</option>' +
            '<option value="timeline">⏵ Timeline</option>' +
            '<option value="calendar">▦ Calendar</option>' +
          '</optgroup>' +
          '<optgroup label="Specialized">' +
            '<option value="matrix">▤ Matrix</option>' +
            '<option value="chord">⌬ Chord</option>' +
            '<option value="sankey">⇶ Sankey</option>' +
            '<option value="tagcloud">☁ Tags</option>' +
            '<option value="geo">🌍 Geo</option>' +
            '<option value="kanban">▥ Kanban</option>' +
          '</optgroup>' +
        '</select>' +
        '<span class="tektite-card-graph-stats">…</span>' +
        '<button class="tektite-card-graph-expand" data-act="expand" type="button" title="Open in full 🕸 Graph modal">⛶</button>' +
      '</div>' +
      '<canvas class="tektite-card-graph-canvas"></canvas>';
    st.graphCanvas    = st.renderEl.querySelector(".tektite-card-graph-canvas");
    st.graphModeSel   = st.renderEl.querySelector(".tektite-card-graph-mode-sel");
    st.graphLayoutSel = st.renderEl.querySelector(".tektite-card-graph-layout-sel");
    st.graphStatsEl   = st.renderEl.querySelector(".tektite-card-graph-stats");
    st.graphExpandBtn = st.renderEl.querySelector(".tektite-card-graph-expand");
    st.graphModeSel.value   = String(node.params.mode   || "global");
    st.graphLayoutSel.value = String(node.params.layout || "force");
    // Expand: open the full-screen modal anchored on this card's config.
    st.graphExpandBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    st.graphExpandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof _tektiteOpenGraphModal === "function") {
        if (typeof _tektiteGraphState !== "undefined" && _tektiteGraphState) {
          _tektiteGraphState.mode   = String(node.params.mode    || "global");
          _tektiteGraphState.layout = String(node.params.layout  || "force");
          _tektiteGraphState.depth  = Number(node.params.depth)  || 2;
          _tektiteGraphState.minDeg = Number(node.params.minDegree) || 0;
        }
        _tektiteOpenGraphModal();
      }
    });
    // Mode + layout selectors -> update params + force a rebuild.
    st.graphModeSel.addEventListener("pointerdown", (e) => e.stopPropagation());
    st.graphLayoutSel.addEventListener("pointerdown", (e) => e.stopPropagation());
    st.graphModeSel.addEventListener("change", () => {
      node.params = node.params || {};
      node.params.mode = st.graphModeSel.value || "global";
      st.graphConfigHash = "";
    });
    st.graphLayoutSel.addEventListener("change", () => {
      node.params = node.params || {};
      node.params.layout = st.graphLayoutSel.value || "force";
      // Apply layout WITHOUT a full rebuild -- cheap when the layout
      // changes while scope stays the same.
      if (st.graphRenderer && typeof st.graphRenderer.setLayout === "function") {
        st.graphRenderer.setLayout(node.params.layout);
      }
    });
    // Sprint 10e-fix: ResizeObserver re-fits the graph as the user
    // drags the card's resize grip. Cheap (one rAF per size change).
    if (typeof ResizeObserver !== "undefined") {
      st.graphResizeObs = new ResizeObserver(() => {
        if (st.graphRenderer && typeof st.graphRenderer.fit === "function") {
          st.graphRenderer.fit();
        }
      });
      st.graphResizeObs.observe(st.graphCanvas);
    }
  }
  // Detect param changes and rebuild the graph + renderer when needed.
  const mode      = String((node.params && node.params.mode)      || "global");
  const layout    = String((node.params && node.params.layout)    || "force");
  const depth     = Number((node.params && node.params.depth))     || 2;
  const minDegree = Number((node.params && node.params.minDegree)) || 0;
  const centerId  = String((node.params && node.params.centerId)  || "");
  // Sprint 10s -- keep the dropdowns synced when the props pane edits
  // params directly (avoids stale display vs actual layout).
  if (st.graphModeSel   && st.graphModeSel.value   !== mode)   st.graphModeSel.value   = mode;
  if (st.graphLayoutSel && st.graphLayoutSel.value !== layout) {
    st.graphLayoutSel.value = layout;
    if (st.graphRenderer && typeof st.graphRenderer.setLayout === "function") {
      st.graphRenderer.setLayout(layout);
    }
  }
  const cfgHash = "G:" + mode + ":" + depth + ":" + minDegree + ":" + centerId;
  if (cfgHash !== st.graphConfigHash && !st.graphBuilding) {
    st.graphBuilding = true;
    try {
      // Local mode picks the centerId param, falling back to the
      // currently-loaded note in the Tektite tab (mirrors the modal).
      const resolvedCenter = centerId ||
        ((typeof tektiteEditorCurrentNoteId === "function") ? tektiteEditorCurrentNoteId() : null);
      const graph = await tektiteGraphBuild({
        mode, depth, minDegree, centerId: resolvedCenter
      });
      // Drop the old renderer before installing a new one so its rAF
      // loop stops + canvas state resets.
      if (st.graphRenderer && typeof st.graphRenderer.destroy === "function") {
        st.graphRenderer.destroy();
      }
      st.graphRenderer = tektiteGraphRenderer(st.graphCanvas, graph, {
        selectedId: resolvedCenter,
        layout: String((node.params && node.params.layout) || "force"),
        onNodeClick: (id) => {
          // Click -> open popout (matches modal behavior).
          if (typeof _tektitePopoutOpen === "function") _tektitePopoutOpen(id);
          // Expose the click to the wire graph + stash for codegen-less
          // downstream reads. params.selectedId is what _readWireJsSideValue
          // returns for the GraphCard's out port.
          node.params = node.params || {};
          node.params.selectedId = id;
          if (st.graphRenderer) st.graphRenderer.setSelectedId(id);
        }
      });
      st.graphRenderer.start();
      node.params.count = graph.nodes.length;
      if (st.graphStatsEl) {
        st.graphStatsEl.textContent = graph.nodes.length + " · " + graph.edges.length;
      }
      st.graphConfigHash = cfgHash;
      // Sprint 10e-fix: schedule a fit() after the layout has had a
      // moment to spread out (sim does ~60 steps in 1 s). Each call
      // re-centers + re-scales to fit the current canvas size.
      setTimeout(() => { if (st.graphRenderer) st.graphRenderer.fit(); },  600);
      setTimeout(() => { if (st.graphRenderer) st.graphRenderer.fit(); }, 1800);
    } catch (e) {
      if (st.graphStatsEl) st.graphStatsEl.textContent = "build failed";
      console.warn("[graph-card] build failed:", e);
    } finally {
      st.graphBuilding = false;
    }
  }
}

/* Sprint tektite-10m -- CanvasCard.  Wraps a Tektite Canvas doc
 * (legacy JSON-Canvas, see src/tektite/canvas.js) inside a card on
 * the MAIN editor canvas.  Body shows a thumbnail preview of the
 * doc's cards + an "⛶ Open" button that hands off to the legacy
 * Canvas modal for actual editing. */
async function _renderCanvasCardBody(node, st) {
  if (!st.renderEl) return;
  // Build the structure once per fresh body.
  if (!st.canvasCardEl) {
    st.renderEl.classList.add("tektite-card-canvas-render");
    st.renderEl.innerHTML =
      '<div class="tektite-card-canvas-bar">' +
        '<span class="tektite-card-canvas-title">🗂 (unset)</span>' +
        '<span class="tektite-card-canvas-stats"></span>' +
        '<button class="tektite-card-canvas-open" type="button" title="Open in Canvas modal">⛶ Open</button>' +
      '</div>' +
      '<svg class="tektite-card-canvas-thumb" preserveAspectRatio="xMidYMid meet"></svg>' +
      '<div class="tektite-card-canvas-empty" style="display:none;">(no canvas linked — set <code>canvasId</code> or click 🔗 to pick one)</div>';
    st.canvasCardEl    = st.renderEl;
    st.canvasTitleEl   = st.renderEl.querySelector(".tektite-card-canvas-title");
    st.canvasStatsEl   = st.renderEl.querySelector(".tektite-card-canvas-stats");
    st.canvasOpenBtn   = st.renderEl.querySelector(".tektite-card-canvas-open");
    st.canvasThumbEl   = st.renderEl.querySelector(".tektite-card-canvas-thumb");
    st.canvasEmptyEl   = st.renderEl.querySelector(".tektite-card-canvas-empty");
    st.canvasOpenBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    st.canvasOpenBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cid = String((node.params && node.params.canvasId) || "");
      if (!cid) return;
      // Hand off to the legacy Canvas modal: show + attach it first
      // (_tektiteCanvasOpen), then load this card's doc into it.
      if (typeof _tektiteCanvasState !== "undefined" && _tektiteCanvasState) {
        _tektiteCanvasState.currentId = cid;
      }
      if (typeof _tektiteCanvasOpen === "function") {
        await _tektiteCanvasOpen();
      }
      if (typeof _tektiteCanvasOpenById === "function") {
        await _tektiteCanvasOpenById(cid);
      }
    });
  }
  const canvasId = String((node.params && node.params.canvasId) || "");
  if (!canvasId) {
    if (st.canvasLastId !== "") {
      st.canvasLastId = "";
      st.canvasTitleEl.textContent = "🗂 (unset)";
      st.canvasStatsEl.textContent = "";
      st.canvasThumbEl.style.display = "none";
      st.canvasEmptyEl.style.display = "block";
      st.canvasOpenBtn.disabled = true;
    }
    return;
  }
  // (Re)load when canvasId changes.
  if (canvasId !== st.canvasLastId && !st.canvasLoading) {
    st.canvasLoading = true;
    try {
      const loaded = await tektiteCanvasLoad(canvasId);
      const doc    = loaded.doc;
      const title  = (loaded.frontmatter && loaded.frontmatter["canvas-title"])
                   || (loaded.note && loaded.note.title) || canvasId;
      st.canvasTitleEl.textContent = "🗂 " + title;
      st.canvasStatsEl.textContent =
        (doc.nodes.length) + " card" + (doc.nodes.length === 1 ? "" : "s") +
        " · " + (doc.edges.length) + " edge" + (doc.edges.length === 1 ? "" : "s");
      st.canvasThumbEl.style.display = "block";
      st.canvasEmptyEl.style.display = "none";
      st.canvasOpenBtn.disabled = false;
      _tektiteCanvasCardRenderThumb(st.canvasThumbEl, doc);
      // Expose card/edge counts as wire-readable params for downstream
      // consumers (matches GraphCard's param-port pattern).
      node.params = node.params || {};
      node.params.cardCount = doc.nodes.length;
      node.params.edgeCount = doc.edges.length;
      st.canvasLastId = canvasId;
    } catch (e) {
      st.canvasTitleEl.textContent = "🗂 ⚠";
      st.canvasStatsEl.textContent = (e && e.message) || String(e);
      st.canvasThumbEl.style.display = "none";
      st.canvasEmptyEl.style.display = "block";
      st.canvasEmptyEl.textContent = "⚠ Load failed: " + ((e && e.message) || String(e));
      st.canvasLastId = canvasId;
    } finally {
      st.canvasLoading = false;
    }
  }
}

/* Draw an SVG thumbnail of the canvas doc: card rectangles in their
 * original positions + thin edge lines, fit to the SVG viewBox. */
function _tektiteCanvasCardRenderThumb(svg, doc) {
  const nodes = (doc && Array.isArray(doc.nodes)) ? doc.nodes : [];
  if (!nodes.length) { svg.innerHTML = ""; svg.removeAttribute("viewBox"); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const x = Number(n.x || 0), y = Number(n.y || 0);
    const w = Number(n.width)  || 200;
    const h = Number(n.height) || 80;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  const pad = 20;
  const vbX = minX - pad, vbY = minY - pad;
  const vbW = (maxX - minX) + pad * 2;
  const vbH = (maxY - minY) + pad * 2;
  svg.setAttribute("viewBox", vbX + " " + vbY + " " + vbW + " " + vbH);
  let html = "";
  const edges = (doc && Array.isArray(doc.edges)) ? doc.edges : [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const e of edges) {
    const a = byId.get(e.fromNode);
    const b = byId.get(e.toNode);
    if (!a || !b) continue;
    const ax = (Number(a.x) || 0) + (Number(a.width)  || 200) / 2;
    const ay = (Number(a.y) || 0) + (Number(a.height) || 80)  / 2;
    const bx = (Number(b.x) || 0) + (Number(b.width)  || 200) / 2;
    const by = (Number(b.y) || 0) + (Number(b.height) || 80)  / 2;
    html += '<line x1="' + ax + '" y1="' + ay + '" x2="' + bx + '" y2="' + by +
      '" stroke="rgba(95,184,212,0.45)" stroke-width="2" />';
  }
  for (const n of nodes) {
    const x = Number(n.x) || 0, y = Number(n.y) || 0;
    const w = Number(n.width)  || 200;
    const h = Number(n.height) || 80;
    let fill = "rgba(95,184,212,0.18)";
    if (n.type === "text") fill = "rgba(200,232,90,0.18)";
    else if (n.type === "file") fill = "rgba(95,184,212,0.25)";
    else if (n.type === "link") fill = "rgba(255,184,90,0.20)";
    html += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
      '" rx="6" ry="6" fill="' + fill + '" stroke="rgba(95,184,212,0.55)" stroke-width="2" />';
  }
  svg.innerHTML = html;
}

/* Per-frame tick. */
function _tickTektiteCards(dtSec) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  const liveIds = _tektiteCardStates.size ? new Set() : null;
  for (let i = 0; i < state.nodes.length; i++) {
    const n = state.nodes[i];
    if (!n || !n.type) continue;
    if (liveIds) liveIds.add(n.id);
    const def = (typeof TYPES === "object") ? TYPES[n.type] : null;
    if (!def) continue;
    const k = def.kind;
    if (k !== "tektite-card-text"  && k !== "tektite-card-note"   &&
        k !== "tektite-card-link"  && k !== "tektite-card-base"   &&
        k !== "tektite-card-graph" && k !== "tektite-card-canvas") continue;
    const st = _tektiteCardGetState(n);
    if (!_tektiteCardEnsureBody(n, st)) continue;
    _tektiteCardApplyAccent(n, st);
    // GraphCard + CanvasCard have no link bar (their own sources).
    if (k !== "tektite-card-graph" && k !== "tektite-card-canvas") _renderLinkBar(n, st);
    if      (k === "tektite-card-text")   _renderTextCardBody(n, st);
    else if (k === "tektite-card-link")   _renderLinkCardBody(n, st);
    else if (k === "tektite-card-note")   _renderNoteCardBody(n, st);
    else if (k === "tektite-card-base")   _renderBaseCardBody(n, st);
    else if (k === "tektite-card-graph")  _renderGraphCardBody(n, st);
    else if (k === "tektite-card-canvas") _renderCanvasCardBody(n, st);
  }
  // Sweep states whose node was deleted (or replaced wholesale by a
  // patch load) -- otherwise the Map pins detached body DOM, graph
  // renderers + ResizeObservers for the rest of the session.
  if (liveIds) {
    for (const [id, st] of _tektiteCardStates) {
      if (liveIds.has(id)) continue;
      if (st.saveTimer) clearTimeout(st.saveTimer);
      if (st.graphRenderer && typeof st.graphRenderer.destroy === "function") {
        try { st.graphRenderer.destroy(); } catch (_) {}
      }
      if (st.graphResizeObs && typeof st.graphResizeObs.disconnect === "function") {
        try { st.graphResizeObs.disconnect(); } catch (_) {}
      }
      _tektiteCardStates.delete(id);
    }
  }
}


function _tektiteCardEsc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
