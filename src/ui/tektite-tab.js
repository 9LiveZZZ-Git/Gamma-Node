/* =========================================================================
 * Tektite MD -- sidebar tab
 *
 * Phase C sprints tektite-1 + tektite-1.5. Renders inside #br-view-tektite:
 *   ┌────────────────────────────────────────────────┐
 *   │ Sources: [Vault] [Local A] [GH foo/bar] [+]    │  ← sprint 1.5
 *   ├────────────────────────────────────────────────┤
 *   │ [+ New note]  [filter…]               5 notes  │  ← toolbar
 *   ├────────────┬───────────────────────────────────┤
 *   │ note list  │  [title-input         ]           │
 *   │ (scrolls)  │  ┌──────────────────────────────┐ │
 *   │            │  │ markdown textarea           │ │
 *   │            │  └──────────────────────────────┘ │
 *   └────────────┴───────────────────────────────────┘
 *
 * Sprint tektite-1.5 -- source rail:
 *   The vault chip is always present; the user adds Local-FS / GitHub
 *   sources via a connect modal (#tektite-connect-modal). Switching to
 *   a remote source loads its file listing in place of the vault's IDB
 *   notes; clicking a note loads the content read-only into the editor.
 *   A "Save to vault" button copies the remote content into IDB so the
 *   user can edit normally.
 *
 * Tab switching is hooked into the existing brSwitchTab() in
 * src/ui/node-browser.js by adding a "tektite" branch.  Click a note
 * in the list → editor.js loads it.  Type → debounced save via
 * editor.js (vault source only; remote sources are read-only).
 * ======================================================================== */

const _tektiteTabState = {
  attached:        false,
  notes:           [],     // current source's listing
  activeSource:    "vault",
  filterText:      "",
  searchResults:   null,    // sprint tektite-3 -- structured query results
  listEl:          null,
  countEl:         null,
  filterInput:     null,
  sourceRailEl:    null,
  saveToVaultBtnEl: null,
  fullscreen:      false,
  backlinksEl:     null,
  // Sprint tektite-5a2 -- closedFolders is the inverse: a Set of
  // paths the user has explicitly collapsed. Everything else stays
  // open by default (matches Obsidian's file explorer). Migrated
  // from openFolders since users expected expanded-by-default.
  closedFolders:   new Set(),
  treeViewForced:  null    // null = auto-detect; true/false = manual override
};

/* Sprint tektite-5b -- graph-modal state. The modal is fullscreen +
 * absolutely-positioned; we keep the renderer handle separately so
 * the close/reopen cycle can drop + recreate it cleanly. */
const _tektiteGraphState = {
  modal:    null,
  canvas:   null,
  renderer: null,
  graph:    null,
  mode:     "global",
  depth:    2,
  minDeg:   0
};

async function _tektiteOpenGraphModal() {
  const s = _tektiteGraphState;
  s.modal  = document.getElementById("tektite-graph-modal");
  s.canvas = document.getElementById("tektite-graph-canvas");
  if (!s.modal || !s.canvas) return;
  s.modal.style.display = "flex";

  // Wire mode buttons (idempotent re-wire is fine; addEventListener
  // dedups on reference equality after the first attach but we use
  // anonymous lambdas so they pile up. Track wiredOnce to bail.).
  if (!s.wiredOnce) {
    s.wiredOnce = true;
    document.querySelectorAll(".tektite-graph-mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        s.mode = btn.getAttribute("data-graph-mode") || "global";
        document.querySelectorAll(".tektite-graph-mode-btn").forEach(b =>
          b.classList.toggle("active", b === btn));
        _tektiteRebuildGraph();
      });
    });
    const depthEl   = document.getElementById("tektite-graph-depth");
    const depthVal  = document.getElementById("tektite-graph-depth-val");
    if (depthEl) depthEl.addEventListener("input", () => {
      s.depth = Number(depthEl.value);
      if (depthVal) depthVal.textContent = String(s.depth);
      if (s.mode === "local") _tektiteRebuildGraph();
    });
    const minEl    = document.getElementById("tektite-graph-mindeg");
    const minVal   = document.getElementById("tektite-graph-mindeg-val");
    if (minEl) minEl.addEventListener("input", () => {
      s.minDeg = Number(minEl.value);
      if (minVal) minVal.textContent = String(s.minDeg);
      _tektiteRebuildGraph();
    });
    const recenter = document.getElementById("btn-tektite-graph-recenter");
    if (recenter) recenter.addEventListener("click", () => {
      if (s.renderer) s.renderer.recenter();
    });
  }

  await _tektiteRebuildGraph();
}

function _tektiteCloseGraphModal() {
  const s = _tektiteGraphState;
  if (s.renderer) { s.renderer.destroy(); s.renderer = null; }
  if (s.modal) s.modal.style.display = "none";
}

async function _tektiteRebuildGraph() {
  const s = _tektiteGraphState;
  const stats = document.getElementById("tektite-graph-stats");
  if (stats) stats.textContent = "building…";
  const centerId = tektiteEditorCurrentNoteId();
  try {
    s.graph = await tektiteGraphBuild({
      mode:      s.mode,
      centerId,
      depth:     s.depth,
      minDegree: s.minDeg
    });
  } catch (e) {
    if (stats) stats.textContent = "build failed: " + (e.message || e);
    return;
  }
  if (s.renderer) s.renderer.destroy();
  s.renderer = tektiteGraphRenderer(s.canvas, s.graph, {
    selectedId:  centerId,
    onNodeClick: async (id) => {
      // Sprint tektite-5c1 -- open in floating popout INSTEAD of
      // closing the modal + switching the main editor. The user
      // explicitly preferred this UX so multiple nodes can be inspected
      // without leaving the graph.
      _tektitePopoutOpen(id);
      if (s.renderer) s.renderer.setSelectedId(id);
    }
  });
  s.renderer.start();
  // Sprint tektite-5c2 -- wire the connector overlay. Renderer fires
  // viewportListener after every draw (sim ticks, pans, zooms,
  // hovers); we recompute the line endpoints in lockstep.
  if (typeof s.renderer.onViewportChange === "function") {
    s.renderer.onViewportChange(_tektiteUpdateConnector);
  }
  if (stats) {
    stats.textContent = s.graph.nodes.length + " notes · " + s.graph.edges.length + " links";
  }
}

/* ------------------------------------------------------------------
 * Sprint tektite-5c1 -- floating popout editor inside the graph
 * modal. Single popout (reused across node clicks); drag the title
 * bar to move; — collapses to title-bar-only; ⤴ opens in the main
 * editor and closes the graph; × hides without saving (saves still
 * happen on input via debounce).
 * ------------------------------------------------------------------ */
const _tektitePopoutState = {
  attached:   false,
  noteId:     null,
  saveTimer:  null,
  drag:       false,
  dragOffsetX: 0,
  dragOffsetY: 0
};

function _tektitePopoutEnsureAttached() {
  const s = _tektitePopoutState;
  if (s.attached) return;
  const popout = document.getElementById("tektite-graph-popout");
  const bar    = document.getElementById("tektite-graph-popout-bar");
  const titleInput   = document.getElementById("tektite-graph-popout-titleinput");
  const editor       = document.getElementById("tektite-graph-popout-editor");
  const collapseBtn  = document.getElementById("tektite-graph-popout-collapse");
  const closeBtn     = document.getElementById("tektite-graph-popout-close");
  const openBtn      = document.getElementById("tektite-graph-popout-open");
  if (!popout || !bar || !titleInput || !editor) return;

  // Drag the title bar to reposition the popout. Buttons inside the
  // bar bail the drag start so clicks on collapse/close/open work.
  bar.addEventListener("pointerdown", (e) => {
    if (e.target && e.target.classList.contains("tektite-graph-popout-btn")) return;
    s.drag = true;
    const rect = popout.getBoundingClientRect();
    s.dragOffsetX = e.clientX - rect.left;
    s.dragOffsetY = e.clientY - rect.top;
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener("pointermove", (e) => {
    if (!s.drag) return;
    const host = document.querySelector("#tektite-graph-modal .tektite-graph-host");
    const hostRect = host ? host.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    let nx = e.clientX - hostRect.left - s.dragOffsetX;
    let ny = e.clientY - hostRect.top  - s.dragOffsetY;
    // Clamp to host bounds so the title bar always stays grabbable.
    nx = Math.max(0, Math.min(hostRect.width  - popout.offsetWidth,  nx));
    ny = Math.max(0, Math.min(hostRect.height - 36, ny));
    popout.style.left = nx + "px";
    popout.style.top  = ny + "px";
    // Sprint tektite-5c2 -- update connector in lockstep with drag.
    _tektiteUpdateConnector();
  });
  bar.addEventListener("pointerup", (e) => {
    s.drag = false;
    try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  // Debounced save (same 400 ms cadence as the main editor).
  function markDirty() {
    if (!s.noteId) return;
    if (s.saveTimer) clearTimeout(s.saveTimer);
    _tektitePopoutSetStatus("Editing…", "saving");
    s.saveTimer = setTimeout(_tektitePopoutFlush, 400);
  }
  editor.addEventListener("input",      markDirty);
  titleInput.addEventListener("input",  markDirty);

  collapseBtn.addEventListener("click", () => {
    popout.classList.toggle("collapsed");
    collapseBtn.textContent = popout.classList.contains("collapsed") ? "□" : "—";
  });
  closeBtn.addEventListener("click", () => {
    _tektitePopoutFlush();
    popout.style.display = "none";
    // Sprint tektite-5c2 -- hide connector when popout closes.
    const svg = document.getElementById("tektite-graph-connector");
    if (svg) svg.style.display = "none";
  });
  openBtn.addEventListener("click", async () => {
    await _tektitePopoutFlush();
    const id = s.noteId;
    popout.style.display = "none";
    _tektiteCloseGraphModal();
    if (id) {
      _tektiteTabState.activeSource = "vault";
      await _tektiteTabRefresh();
      await tektiteEditorLoadFromSource("vault", id);
      _tektiteTabRender();
    }
  });

  s.attached = true;
}

function _tektitePopoutSetStatus(text, kind) {
  const el = document.getElementById("tektite-graph-popout-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "tektite-graph-popout-status" + (kind ? (" " + kind) : "");
}

/* =========================================================================
 * Sprint tektite-9 -- Canvas UI
 *
 * Modal layout: left sidebar (canvases list) + main pane (toolbar +
 * infinite board). The board is a CSS-transformed container holding
 * absolutely-positioned cards + an SVG edges layer.
 *
 * Pan/zoom state is held on _tektiteCanvasState; the transform string
 * `translate(panX, panY) scale(zoom)` applied to #tektite-canvas-cards
 * AND the SVG's viewBox mapping keeps cards + edges co-registered.
 *
 * Cards are DOM elements with contenteditable bodies (text cards) or
 * markdown-rendered previews (file cards). Drag the card body to move
 * (records position on pointerup); resize via the bottom-right grip.
 *
 * Save: 600 ms debounced after any structural change (move, resize,
 * text edit, add, delete, edge change).
 * ======================================================================== */

const _tektiteCanvasState = {
  attached:    false,
  modal:       null,
  boardEl:     null,
  cardsEl:     null,
  edgesEl:     null,
  emptyEl:     null,
  listEl:      null,
  currentId:   null,
  doc:         null,
  selectedId:  null,
  panX:        0,
  panY:        0,
  zoom:        1,
  saveTimer:   null,
  pointerMode: null,  // null | "pan" | "drag-card" | "resize-card"
  dragId:      null,
  dragStartX:  0,
  dragStartY:  0,
  dragOrigX:   0,
  dragOrigY:   0,
  dragOrigW:   0,
  dragOrigH:   0
};

async function _tektiteCanvasOpen() {
  const s = _tektiteCanvasState;
  s.modal = document.getElementById("tektite-canvas-modal");
  if (!s.modal) return;
  s.modal.style.display = "flex";
  _tektiteCanvasAttach();
  await _tektiteCanvasRefreshList();
}

function _tektiteCanvasClose() {
  const s = _tektiteCanvasState;
  _tektiteCanvasFlush();
  if (s.modal) s.modal.style.display = "none";
}

function _tektiteCanvasAttach() {
  const s = _tektiteCanvasState;
  if (s.attached) return;
  s.attached = true;
  s.boardEl = document.getElementById("tektite-canvas-board");
  s.cardsEl = document.getElementById("tektite-canvas-cards");
  s.edgesEl = document.getElementById("tektite-canvas-edges");
  s.emptyEl = document.getElementById("tektite-canvas-empty");
  s.listEl  = document.getElementById("tektite-canvas-list");

  document.getElementById("btn-tektite-canvas-new").addEventListener("click", () => _tektiteCanvasCreate());
  document.getElementById("btn-tektite-canvas-close").addEventListener("click", () => _tektiteCanvasClose());
  document.getElementById("btn-tektite-canvas-add-text").addEventListener("click", () => _tektiteCanvasAddTextCard());
  document.getElementById("btn-tektite-canvas-add-file").addEventListener("click", () => _tektiteCanvasAddFileCard());
  document.getElementById("btn-tektite-canvas-fit").addEventListener("click", () => _tektiteCanvasFitToView());

  // Title input: rename canvas (debounced save).
  const titleInput = document.getElementById("tektite-canvas-title-input");
  if (titleInput) {
    titleInput.addEventListener("input", () => {
      if (!s.doc) return;
      s.doc._title = titleInput.value || "";
      _tektiteCanvasMarkDirty();
    });
  }

  // Pan + zoom + click-on-empty deselect.
  _tektiteCanvasWireBoardPointer();

  // Esc closes.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && s.modal && s.modal.style.display !== "none") {
      _tektiteCanvasClose();
    }
  });
}

function _tektiteCanvasWireBoardPointer() {
  const s = _tektiteCanvasState;
  s.boardEl.addEventListener("pointerdown", (e) => {
    // Cards have their own handlers; only react to clicks on the
    // board background.
    if (e.target !== s.boardEl) return;
    s.pointerMode = "pan";
    s.dragStartX = e.clientX;
    s.dragStartY = e.clientY;
    s.dragOrigX  = s.panX;
    s.dragOrigY  = s.panY;
    s.boardEl.setPointerCapture(e.pointerId);
    _tektiteCanvasSelectCard(null);
  });
  s.boardEl.addEventListener("pointermove", (e) => {
    if (s.pointerMode === "pan") {
      s.panX = s.dragOrigX + (e.clientX - s.dragStartX);
      s.panY = s.dragOrigY + (e.clientY - s.dragStartY);
      _tektiteCanvasApplyTransform();
    }
  });
  s.boardEl.addEventListener("pointerup", (e) => {
    if (s.pointerMode === "pan") {
      try { s.boardEl.releasePointerCapture(e.pointerId); } catch (_) {}
      s.pointerMode = null;
    }
  });
  s.boardEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = s.boardEl.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const newZoom = Math.max(0.2, Math.min(4, s.zoom * factor));
    // Zoom toward cursor: keep the world-space point under the
    // cursor fixed in screen space.
    const wx = (cx - rect.width  / 2 - s.panX) / s.zoom;
    const wy = (cy - rect.height / 2 - s.panY) / s.zoom;
    s.zoom = newZoom;
    s.panX = cx - rect.width  / 2 - wx * s.zoom;
    s.panY = cy - rect.height / 2 - wy * s.zoom;
    _tektiteCanvasApplyTransform();
  }, { passive: false });
}

function _tektiteCanvasApplyTransform() {
  const s = _tektiteCanvasState;
  if (!s.cardsEl) return;
  s.cardsEl.style.transform =
    "translate(" + s.panX + "px, " + s.panY + "px) scale(" + s.zoom + ")";
  _tektiteCanvasRenderEdges();
}

async function _tektiteCanvasRefreshList() {
  const s = _tektiteCanvasState;
  if (!s.listEl) return;
  let canvases;
  try { canvases = await tektiteCanvasListAll(); }
  catch (e) { console.warn("[tektite] canvas list failed:", e); canvases = []; }
  if (!canvases.length) {
    s.listEl.innerHTML = `<div class="tektite-canvas-list-empty">No canvases yet.  Click <strong>＋</strong> to create one.</div>`;
    return;
  }
  s.listEl.innerHTML = canvases.map(c => {
    const active = (c.id === s.currentId) ? " active" : "";
    return `<div class="tektite-canvas-list-item${active}" data-id="${_tektiteEscapeAttr(c.id)}">
      ${_tektiteEscapeHtml(c.title || c.id)}
    </div>`;
  }).join("");
  s.listEl.querySelectorAll(".tektite-canvas-list-item").forEach(el => {
    el.addEventListener("click", () => _tektiteCanvasOpenById(el.getAttribute("data-id")));
  });
}

async function _tektiteCanvasCreate() {
  try {
    const title = window.prompt("Name for the new canvas:", "Untitled canvas");
    if (!title) return;
    const id = await tektiteCanvasCreate(title);
    await _tektiteCanvasRefreshList();
    await _tektiteCanvasOpenById(id);
  } catch (e) {
    window.alert("Canvas creation failed: " + (e.message || e));
  }
}

async function _tektiteCanvasOpenById(id) {
  const s = _tektiteCanvasState;
  await _tektiteCanvasFlush();
  s.currentId = id;
  s.selectedId = null;
  try {
    const loaded = await tektiteCanvasLoad(id);
    s.doc = loaded.doc;
    s.doc._title = loaded.frontmatter["canvas-title"] || loaded.note.title || id;
  } catch (e) {
    s.doc = null;
    if (s.emptyEl) {
      s.emptyEl.style.display = "flex";
      s.emptyEl.textContent = "Failed to load: " + (e.message || e);
    }
    return;
  }
  // Title input.
  const titleInput = document.getElementById("tektite-canvas-title-input");
  if (titleInput) titleInput.value = s.doc._title || id;
  await _tektiteCanvasRefreshList();
  _tektiteCanvasRenderAll();
  _tektiteCanvasFitToView();
}

function _tektiteCanvasRenderAll() {
  const s = _tektiteCanvasState;
  if (!s.cardsEl || !s.doc) return;
  s.cardsEl.innerHTML = "";
  if (s.emptyEl) s.emptyEl.style.display = s.doc.nodes.length ? "none" : "flex";
  for (const node of s.doc.nodes) _tektiteCanvasRenderNode(node);
  _tektiteCanvasRenderEdges();
  _tektiteCanvasApplyTransform();
}

function _tektiteCanvasRenderNode(node) {
  const s = _tektiteCanvasState;
  if (!s.cardsEl) return;
  const el = document.createElement("div");
  el.className = "tektite-canvas-card";
  el.dataset.nodeId = node.id;
  el.style.left   = node.x      + "px";
  el.style.top    = node.y      + "px";
  el.style.width  = (node.width  | 0) + "px";
  el.style.height = (node.height | 0) + "px";
  const accent = tektiteCanvasColor(node.color);
  if (accent) el.style.borderColor = accent;

  // Title bar (type label + delete).
  const bar = document.createElement("div");
  bar.className = "tektite-canvas-card-bar";
  const titleSpan = document.createElement("span");
  titleSpan.className = "tektite-canvas-card-bar-title";
  if (node.type === "file")      titleSpan.textContent = "📄 " + (node.file || "");
  else if (node.type === "link") titleSpan.textContent = "🔗 " + (node.url  || "");
  else                            titleSpan.textContent = "📝 text";
  bar.appendChild(titleSpan);
  const delBtn = document.createElement("button");
  delBtn.className = "tektite-canvas-card-bar-btn";
  delBtn.textContent = "×";
  delBtn.title = "Delete card";
  delBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    _tektiteCanvasDeleteNode(node.id);
  });
  bar.appendChild(delBtn);
  el.appendChild(bar);

  // Body. Text cards have a contenteditable; file cards render
  // markdown preview lazily; link cards render an iframe (deferred
  // until tektite-9b -- for now show a plain anchor).
  const body = document.createElement("div");
  body.className = "tektite-canvas-card-body";
  if (node.type === "text") {
    body.contentEditable = "true";
    body.spellcheck = false;
    body.textContent = node.text || "";
    body.addEventListener("input", () => {
      node.text = body.innerText || "";
      _tektiteCanvasMarkDirty();
    });
    // Prevent the body's edit clicks from initiating a card drag.
    body.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  } else if (node.type === "file") {
    body.style.cursor = "pointer";
    body.title = "Click to open in the main editor";
    body.textContent = "(loading…)";
    (async () => {
      try {
        const target = await tektiteGetNote(node.file) ||
          (await tektiteListNotes()).find(n => (n.title || "").toLowerCase() === String(node.file).toLowerCase());
        if (!target) { body.textContent = "⚠ Note not found: " + node.file; return; }
        body.innerHTML = "";
        if (typeof tektiteMarkdownRenderInto === "function") {
          await tektiteMarkdownRenderInto(body, target.content || "");
        } else {
          body.textContent = target.content || "";
        }
      } catch (e) {
        body.textContent = "⚠ " + (e.message || e);
      }
    })();
    body.addEventListener("click", async (ev) => {
      if (ev.target.closest("a")) return;
      _tektiteCanvasClose();
      _tektiteTabState.activeSource = "vault";
      await _tektiteTabRefresh();
      await tektiteEditorLoadFromSource("vault", node.file);
      _tektiteTabRender();
    });
    body.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  } else if (node.type === "link") {
    body.innerHTML = '<a href="' + _tektiteEscapeAttr(node.url || "") + '" target="_blank" rel="noopener">' +
      _tektiteEscapeHtml(node.url || "(no url)") + '</a>';
    body.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }
  el.appendChild(body);

  // Resize grip.
  const grip = document.createElement("div");
  grip.className = "tektite-canvas-card-resize";
  grip.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    _tektiteCanvasStartResize(node.id, ev);
  });
  el.appendChild(grip);

  // Drag handle = card itself (bar + outer).
  el.addEventListener("pointerdown", (ev) => _tektiteCanvasStartDrag(node.id, ev));
  el.addEventListener("click", () => _tektiteCanvasSelectCard(node.id));

  s.cardsEl.appendChild(el);
}

function _tektiteCanvasStartDrag(nodeId, e) {
  const s = _tektiteCanvasState;
  const node = s.doc.nodes.find(n => n.id === nodeId);
  if (!node) return;
  s.pointerMode = "drag-card";
  s.dragId = nodeId;
  s.dragStartX = e.clientX;
  s.dragStartY = e.clientY;
  s.dragOrigX  = node.x;
  s.dragOrigY  = node.y;
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const onMove = (ev) => {
    if (s.pointerMode !== "drag-card") return;
    const dx = (ev.clientX - s.dragStartX) / s.zoom;
    const dy = (ev.clientY - s.dragStartY) / s.zoom;
    node.x = s.dragOrigX + dx;
    node.y = s.dragOrigY + dy;
    el.style.left = node.x + "px";
    el.style.top  = node.y + "px";
    _tektiteCanvasRenderEdges();
  };
  const onUp = (ev) => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
    s.pointerMode = null;
    s.dragId = null;
    _tektiteCanvasMarkDirty();
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup",   onUp);
  _tektiteCanvasSelectCard(nodeId);
}

function _tektiteCanvasStartResize(nodeId, e) {
  const s = _tektiteCanvasState;
  const node = s.doc.nodes.find(n => n.id === nodeId);
  if (!node) return;
  s.pointerMode = "resize-card";
  s.dragId = nodeId;
  s.dragStartX = e.clientX;
  s.dragStartY = e.clientY;
  s.dragOrigW = node.width  | 0;
  s.dragOrigH = node.height | 0;
  const grip = e.currentTarget;
  const el = grip.parentElement;
  grip.setPointerCapture(e.pointerId);
  const onMove = (ev) => {
    if (s.pointerMode !== "resize-card") return;
    const dx = (ev.clientX - s.dragStartX) / s.zoom;
    const dy = (ev.clientY - s.dragStartY) / s.zoom;
    node.width  = Math.max(120, s.dragOrigW + dx);
    node.height = Math.max(60,  s.dragOrigH + dy);
    el.style.width  = node.width  + "px";
    el.style.height = node.height + "px";
    _tektiteCanvasRenderEdges();
  };
  const onUp = (ev) => {
    grip.removeEventListener("pointermove", onMove);
    grip.removeEventListener("pointerup", onUp);
    try { grip.releasePointerCapture(ev.pointerId); } catch (_) {}
    s.pointerMode = null;
    s.dragId = null;
    _tektiteCanvasMarkDirty();
  };
  grip.addEventListener("pointermove", onMove);
  grip.addEventListener("pointerup",   onUp);
}

function _tektiteCanvasSelectCard(nodeId) {
  const s = _tektiteCanvasState;
  s.selectedId = nodeId;
  if (!s.cardsEl) return;
  s.cardsEl.querySelectorAll(".tektite-canvas-card").forEach(c =>
    c.classList.toggle("selected", c.dataset.nodeId === nodeId));
}

function _tektiteCanvasDeleteNode(nodeId) {
  const s = _tektiteCanvasState;
  if (!s.doc) return;
  s.doc.nodes = s.doc.nodes.filter(n => n.id !== nodeId);
  s.doc.edges = s.doc.edges.filter(e =>
    e.fromNode !== nodeId && e.toNode !== nodeId);
  if (s.selectedId === nodeId) s.selectedId = null;
  _tektiteCanvasRenderAll();
  _tektiteCanvasMarkDirty();
}

function _tektiteCanvasRenderEdges() {
  const s = _tektiteCanvasState;
  if (!s.edgesEl || !s.doc) return;
  // Map a node's anchor point in screen coords.
  const rect = s.boardEl.getBoundingClientRect();
  const cx0 = rect.width  / 2 + s.panX;
  const cy0 = rect.height / 2 + s.panY;
  function anchor(node, side) {
    const w = node.width  | 0;
    const h = node.height | 0;
    let lx = node.x, ly = node.y;
    if (side === "left")   { lx = node.x;     ly = node.y + h / 2; }
    if (side === "right")  { lx = node.x + w; ly = node.y + h / 2; }
    if (side === "top")    { lx = node.x + w / 2; ly = node.y; }
    if (side === "bottom") { lx = node.x + w / 2; ly = node.y + h; }
    return { x: cx0 + lx * s.zoom, y: cy0 + ly * s.zoom };
  }
  // Re-render the SVG. Simple lines for v1 (no labels).
  let svgInner = "";
  for (const e of s.doc.edges) {
    const a = s.doc.nodes.find(n => n.id === e.fromNode);
    const b = s.doc.nodes.find(n => n.id === e.toNode);
    if (!a || !b) continue;
    const pa = anchor(a, e.fromSide || "right");
    const pb = anchor(b, e.toSide   || "left");
    const stroke = tektiteCanvasColor(e.color) || "rgba(155, 208, 255, 0.55)";
    svgInner += `<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="${stroke}" stroke-width="1.5" marker-end="url(#tektite-canvas-arrow)"/>`;
  }
  s.edgesEl.innerHTML = `<defs>
      <marker id="tektite-canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 Z" fill="rgba(155, 208, 255, 0.65)" />
      </marker>
    </defs>` + svgInner;
}

function _tektiteCanvasAddTextCard() {
  const s = _tektiteCanvasState;
  if (!s.doc) return;
  const sz = tektiteCanvasDefaultSize("text");
  const node = {
    id: tektiteCanvasUid(),
    type: "text",
    text: "New card",
    x: -sz.width / 2 - s.panX / s.zoom,
    y: -sz.height / 2 - s.panY / s.zoom,
    width: sz.width,
    height: sz.height
  };
  s.doc.nodes.push(node);
  _tektiteCanvasRenderNode(node);
  if (s.emptyEl) s.emptyEl.style.display = "none";
  _tektiteCanvasSelectCard(node.id);
  _tektiteCanvasMarkDirty();
}

async function _tektiteCanvasAddFileCard() {
  const s = _tektiteCanvasState;
  if (!s.doc) return;
  const target = window.prompt("Vault note id or title to embed:");
  if (!target) return;
  let note = await tektiteGetNote(target);
  if (!note) {
    const all = await tektiteListNotes();
    note = all.find(n => (n.title || "").toLowerCase() === target.toLowerCase());
  }
  if (!note) { window.alert("Note not found: " + target); return; }
  const sz = tektiteCanvasDefaultSize("file");
  const node = {
    id: tektiteCanvasUid(),
    type: "file",
    file: note.id,
    x: -sz.width / 2 - s.panX / s.zoom,
    y: -sz.height / 2 - s.panY / s.zoom,
    width: sz.width,
    height: sz.height
  };
  s.doc.nodes.push(node);
  _tektiteCanvasRenderNode(node);
  if (s.emptyEl) s.emptyEl.style.display = "none";
  _tektiteCanvasSelectCard(node.id);
  _tektiteCanvasMarkDirty();
}

function _tektiteCanvasFitToView() {
  const s = _tektiteCanvasState;
  if (!s.doc || !s.doc.nodes.length || !s.boardEl) {
    s.panX = 0; s.panY = 0; s.zoom = 1;
    _tektiteCanvasApplyTransform();
    return;
  }
  // World-space bounding box of every node.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of s.doc.nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x + (n.width  | 0));
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y + (n.height | 0));
  }
  const w = maxX - minX, h = maxY - minY;
  const rect = s.boardEl.getBoundingClientRect();
  const margin = 80;
  const sx = (rect.width  - margin * 2) / Math.max(1, w);
  const sy = (rect.height - margin * 2) / Math.max(1, h);
  s.zoom = Math.max(0.2, Math.min(2, Math.min(sx, sy)));
  // Pan so the bbox center lands at viewport center.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  s.panX = -cx * s.zoom;
  s.panY = -cy * s.zoom;
  _tektiteCanvasApplyTransform();
}

function _tektiteCanvasMarkDirty() {
  const s = _tektiteCanvasState;
  if (!s.currentId) return;
  if (s.saveTimer) clearTimeout(s.saveTimer);
  _tektiteCanvasSetStatus("Editing…", "saving");
  s.saveTimer = setTimeout(_tektiteCanvasFlush, 600);
}

function _tektiteCanvasSetStatus(text, kind) {
  const el = document.getElementById("tektite-canvas-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "tektite-canvas-status" + (kind ? (" " + kind) : "");
}

async function _tektiteCanvasFlush() {
  const s = _tektiteCanvasState;
  if (s.saveTimer) { clearTimeout(s.saveTimer); s.saveTimer = null; }
  if (!s.currentId || !s.doc) return;
  _tektiteCanvasSetStatus("Saving…", "saving");
  try {
    await tektiteCanvasSave(s.currentId, s.doc);
    _tektiteCanvasSetStatus("Saved", "ok");
    setTimeout(() => {
      if ((document.getElementById("tektite-canvas-status") || {}).textContent === "Saved") {
        _tektiteCanvasSetStatus("");
      }
    }, 1500);
  } catch (e) {
    _tektiteCanvasSetStatus("✗ " + (e.message || e), "err");
  }
}

/* =========================================================================
 * Sprint tektite-8 -- Bases UI
 *
 * Modal with a left sidebar (list of bases) + main pane (editor
 * controls + rendered view). The config edits are debounced so a
 * filter-typing burst doesn't thrash IDB; the view re-runs on every
 * config change.
 * ======================================================================== */

const _tektiteBasesState = {
  attached:  false,
  modal:     null,
  listEl:    null,
  bodyEl:    null,
  currentId: null,
  config:    null,
  rows:      [],
  saveTimer: null,
  rerunTimer: null,
  propsCache: null
};

async function _tektiteBasesOpen() {
  const s = _tektiteBasesState;
  s.modal = document.getElementById("tektite-bases-modal");
  if (!s.modal) return;
  s.modal.style.display = "flex";
  _tektiteBasesAttach();
  await _tektiteBasesRefreshList();
}

function _tektiteBasesClose() {
  const s = _tektiteBasesState;
  _tektiteBasesFlush();
  if (s.modal) s.modal.style.display = "none";
}

function _tektiteBasesAttach() {
  const s = _tektiteBasesState;
  if (s.attached) return;
  s.attached = true;
  s.listEl = document.getElementById("tektite-bases-list");
  s.bodyEl = document.getElementById("tektite-bases-body");
  const newBtn  = document.getElementById("btn-tektite-bases-new");
  const closeBtn = document.getElementById("btn-tektite-bases-close");
  if (newBtn) newBtn.addEventListener("click", () => _tektiteBasesCreate());
  if (closeBtn) closeBtn.addEventListener("click", () => _tektiteBasesClose());

  // Editor controls: every input/change triggers a debounced config
  // save + view re-run.
  const titleInput = document.getElementById("tektite-base-title-input");
  const filterInput = document.getElementById("tektite-base-filter-input");
  const sortKey    = document.getElementById("tektite-base-sort-key");
  const sortDir    = document.getElementById("tektite-base-sort-dir");
  const colsInput  = document.getElementById("tektite-base-cols-input");
  [titleInput, filterInput, colsInput].forEach(el => {
    if (el) el.addEventListener("input", _tektiteBasesMarkDirty);
  });
  [sortKey, sortDir].forEach(el => {
    if (el) el.addEventListener("change", _tektiteBasesMarkDirty);
  });

  // View switcher.
  document.querySelectorAll(".tektite-base-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tektite-base-view-btn").forEach(b =>
        b.classList.toggle("active", b === btn));
      _tektiteBasesMarkDirty();
    });
  });

  // Esc closes.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _tektiteBasesState.modal &&
        _tektiteBasesState.modal.style.display !== "none") {
      _tektiteBasesClose();
    }
  });
}

async function _tektiteBasesRefreshList() {
  const s = _tektiteBasesState;
  if (!s.listEl) return;
  let bases;
  try { bases = await tektiteBaseListAll(); }
  catch (e) { console.warn("[tektite] base list failed:", e); bases = []; }
  if (!bases.length) {
    s.listEl.innerHTML = `<div class="tektite-bases-list-empty">No bases yet.  Click <strong>＋</strong> to create one.</div>`;
    return;
  }
  s.listEl.innerHTML = bases.map(b => {
    const active = (b.id === s.currentId) ? " active" : "";
    return `<div class="tektite-bases-list-item${active}" data-id="${_tektiteEscapeAttr(b.id)}">
      ${_tektiteEscapeHtml(b.title || b.id)}
    </div>`;
  }).join("");
  s.listEl.querySelectorAll(".tektite-bases-list-item").forEach(el => {
    el.addEventListener("click", () => _tektiteBasesOpenById(el.getAttribute("data-id")));
  });
}

async function _tektiteBasesCreate() {
  try {
    const title = window.prompt("Name for the new base:", "Untitled base");
    if (!title) return;
    const id = await tektiteBaseCreate(title);
    await _tektiteBasesRefreshList();
    await _tektiteBasesOpenById(id);
  } catch (e) {
    window.alert("Base creation failed: " + (e.message || String(e)));
  }
}

async function _tektiteBasesOpenById(id) {
  const s = _tektiteBasesState;
  await _tektiteBasesFlush();
  s.currentId = id;
  try {
    const loaded = await tektiteBaseLoad(id);
    s.config = loaded.config;
  } catch (e) {
    s.config = null;
    if (s.bodyEl) s.bodyEl.innerHTML = `<div class="tektite-bases-empty">Failed to load: ${_tektiteEscapeHtml(e.message || e)}</div>`;
    return;
  }
  await _tektiteBasesRefreshList();
  await _tektiteBasesPopulateControls();
  await _tektiteBasesRunAndRender();
}

async function _tektiteBasesPopulateControls() {
  const s = _tektiteBasesState;
  if (!s.config) return;
  const c = s.config;
  const titleInput = document.getElementById("tektite-base-title-input");
  const filterInput = document.getElementById("tektite-base-filter-input");
  const sortKey    = document.getElementById("tektite-base-sort-key");
  const sortDir    = document.getElementById("tektite-base-sort-dir");
  const colsInput  = document.getElementById("tektite-base-cols-input");
  if (titleInput) titleInput.value = c["base-title"] || "";
  if (filterInput) filterInput.value = c["base-filter"] || "";
  if (colsInput) colsInput.value = (c["base-columns"] || []).join(", ");
  // Populate sort-key dropdown from discovered properties.
  if (sortKey) {
    if (!s.propsCache) s.propsCache = await tektiteBaseDiscoverProperties();
    sortKey.innerHTML = s.propsCache.map(p =>
      `<option value="${_tektiteEscapeAttr(p)}">${_tektiteEscapeHtml(p)}</option>`
    ).join("");
    const [k, dir] = String(c["base-sort"] || "modifiedAt desc").split(/\s+/);
    sortKey.value = k || "modifiedAt";
    if (sortDir) sortDir.value = (dir === "asc") ? "asc" : "desc";
  }
  // View buttons.
  const view = c["base-view"] || "table";
  document.querySelectorAll(".tektite-base-view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === view);
  });
}

function _tektiteBasesGatherControls() {
  return {
    "base-title":   (document.getElementById("tektite-base-title-input") || {}).value || "",
    "base-filter":  (document.getElementById("tektite-base-filter-input") || {}).value || "",
    "base-sort":    ((document.getElementById("tektite-base-sort-key") || {}).value || "modifiedAt") +
                    " " + ((document.getElementById("tektite-base-sort-dir") || {}).value || "desc"),
    "base-columns": ((document.getElementById("tektite-base-cols-input") || {}).value || "title")
                      .split(",").map(s => s.trim()).filter(Boolean),
    "base-view":    (document.querySelector(".tektite-base-view-btn.active") || {}).getAttribute
                      ? document.querySelector(".tektite-base-view-btn.active").getAttribute("data-view")
                      : "table",
    "base-groupBy": ""
  };
}

function _tektiteBasesMarkDirty() {
  const s = _tektiteBasesState;
  if (s.saveTimer) clearTimeout(s.saveTimer);
  if (s.rerunTimer) clearTimeout(s.rerunTimer);
  _tektiteBasesSetStatus("Editing…", "saving");
  s.rerunTimer = setTimeout(_tektiteBasesRunAndRender, 200);
  s.saveTimer  = setTimeout(_tektiteBasesFlush, 500);
}

function _tektiteBasesSetStatus(text, kind) {
  const el = document.getElementById("tektite-base-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "tektite-base-status" + (kind ? (" " + kind) : "");
}

async function _tektiteBasesFlush() {
  const s = _tektiteBasesState;
  if (s.saveTimer) { clearTimeout(s.saveTimer); s.saveTimer = null; }
  if (!s.currentId) return;
  const config = _tektiteBasesGatherControls();
  s.config = config;
  _tektiteBasesSetStatus("Saving…", "saving");
  try {
    await tektiteBaseSave(s.currentId, config);
    _tektiteBasesSetStatus("Saved", "ok");
    setTimeout(() => {
      if ((document.getElementById("tektite-base-status") || {}).textContent === "Saved") {
        _tektiteBasesSetStatus("");
      }
    }, 1500);
  } catch (e) {
    _tektiteBasesSetStatus("✗ " + (e.message || e), "err");
  }
}

async function _tektiteBasesRunAndRender() {
  const s = _tektiteBasesState;
  if (!s.bodyEl) return;
  if (!s.currentId) {
    s.bodyEl.innerHTML = `<div class="tektite-bases-empty">Select or create a base.</div>`;
    return;
  }
  const config = _tektiteBasesGatherControls();
  let rows;
  try { rows = await tektiteBaseExecute(config); }
  catch (e) {
    s.bodyEl.innerHTML = `<div class="tektite-bases-empty">✗ ${_tektiteEscapeHtml(e.message || e)}</div>`;
    return;
  }
  s.rows = rows;
  const countEl = document.getElementById("tektite-base-rowcount");
  if (countEl) countEl.textContent = rows.length + " row" + (rows.length === 1 ? "" : "s");
  const view = config["base-view"];
  const columns = config["base-columns"];
  if (view === "table") _tektiteBasesRenderTable(rows, columns);
  else if (view === "list") _tektiteBasesRenderList(rows);
  else if (view === "cards") _tektiteBasesRenderCards(rows);
}

function _tektiteBasesRenderTable(rows, columns) {
  const s = _tektiteBasesState;
  if (!rows.length) {
    s.bodyEl.innerHTML = `<div class="tektite-bases-empty">No rows match this base's filter.</div>`;
    return;
  }
  const head = "<tr>" + columns.map(c => "<th>" + _tektiteEscapeHtml(c) + "</th>").join("") + "</tr>";
  const body = rows.map(row => {
    const cells = columns.map(col => {
      const v = tektiteBaseRowValue(row, col);
      let cellHtml = _tektiteBaseFormatValue(v);
      const cls = (col === "title") ? "col-title" : "";
      return `<td class="${cls}">${cellHtml}</td>`;
    }).join("");
    return `<tr data-id="${_tektiteEscapeAttr(row.id)}">${cells}</tr>`;
  }).join("");
  s.bodyEl.innerHTML = `<table class="tektite-base-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  s.bodyEl.querySelectorAll("tbody tr").forEach(tr => {
    tr.addEventListener("click", () => _tektiteBasesOpenRow(tr.getAttribute("data-id")));
  });
}

function _tektiteBasesRenderList(rows) {
  const s = _tektiteBasesState;
  if (!rows.length) {
    s.bodyEl.innerHTML = `<div class="tektite-bases-empty">No rows match this base's filter.</div>`;
    return;
  }
  const items = rows.map(row => {
    const dt = row.modifiedAt ? _tektiteFormatRelativeTime(row.modifiedAt) : "";
    return `<li data-id="${_tektiteEscapeAttr(row.id)}">
      <span class="tektite-base-list-title">${_tektiteEscapeHtml(row.title)}</span>
      ${dt ? `<span class="tektite-base-list-meta">${dt}</span>` : ""}
    </li>`;
  }).join("");
  s.bodyEl.innerHTML = `<ul class="tektite-base-list">${items}</ul>`;
  s.bodyEl.querySelectorAll("li").forEach(li => {
    li.addEventListener("click", () => _tektiteBasesOpenRow(li.getAttribute("data-id")));
  });
}

function _tektiteBasesRenderCards(rows) {
  const s = _tektiteBasesState;
  if (!rows.length) {
    s.bodyEl.innerHTML = `<div class="tektite-bases-empty">No rows match this base's filter.</div>`;
    return;
  }
  const cards = rows.map(row => {
    const dt = row.modifiedAt ? _tektiteFormatRelativeTime(row.modifiedAt) : "";
    const preview = String(row.body || "").replace(/\s+/g, " ").slice(0, 200);
    return `<div class="tektite-base-card" data-id="${_tektiteEscapeAttr(row.id)}">
      <div class="tektite-base-card-title">${_tektiteEscapeHtml(row.title)}</div>
      ${dt ? `<div class="tektite-base-card-meta">${dt}</div>` : ""}
      <div class="tektite-base-card-preview">${_tektiteEscapeHtml(preview)}</div>
    </div>`;
  }).join("");
  s.bodyEl.innerHTML = `<div class="tektite-base-cards">${cards}</div>`;
  s.bodyEl.querySelectorAll(".tektite-base-card").forEach(c => {
    c.addEventListener("click", () => _tektiteBasesOpenRow(c.getAttribute("data-id")));
  });
}

function _tektiteBaseFormatValue(v) {
  if (v === undefined || v === null || v === "") return "";
  if (v instanceof Date) return _tektiteEscapeHtml(_tektiteFormatRelativeTime(v.getTime()));
  if (Array.isArray(v)) return _tektiteEscapeHtml(v.join(", "));
  return _tektiteEscapeHtml(String(v));
}

async function _tektiteBasesOpenRow(id) {
  if (!id) return;
  _tektiteBasesClose();
  _tektiteTabState.activeSource = "vault";
  await _tektiteTabRefresh();
  await tektiteEditorLoadFromSource("vault", id);
  _tektiteTabRender();
}

/* Sprint tektite-5c2 -- connector line between the source graph node
 * and the popout editor.  Updates on every renderer draw (subscribed
 * via onViewportChange) AND on popout drags (manually invoked by the
 * drag-pointermove handler). */
function _tektiteUpdateConnector() {
  const s = _tektiteGraphState;
  const ps = _tektitePopoutState;
  const svg     = document.getElementById("tektite-graph-connector");
  const line    = document.getElementById("tektite-graph-connector-line");
  const dot     = document.getElementById("tektite-graph-connector-dot");
  const popout  = document.getElementById("tektite-graph-popout");
  if (!svg || !line || !dot || !popout) return;
  if (!ps.noteId || popout.style.display === "none" || !s.renderer ||
      typeof s.renderer.nodeScreenPos !== "function") {
    svg.style.display = "none";
    return;
  }
  const np = s.renderer.nodeScreenPos(ps.noteId);
  if (!np) { svg.style.display = "none"; return; }

  const host = svg.parentElement; // .tektite-graph-host
  const hostRect = host.getBoundingClientRect();
  // Map to SVG-local coords.
  const nx = np.x - hostRect.left;
  const ny = np.y - hostRect.top;

  // Pick the popout edge anchor closest to the source node.
  const pRect = popout.getBoundingClientRect();
  const pLeft   = pRect.left - hostRect.left;
  const pTop    = pRect.top  - hostRect.top;
  const pRight  = pLeft + pRect.width;
  const pBottom = pTop  + pRect.height;
  const pCx = (pLeft + pRight)  / 2;
  const pCy = (pTop  + pBottom) / 2;
  // Clamp anchor to nearest popout edge midpoint.
  let ax, ay;
  if (nx < pLeft)        { ax = pLeft;   ay = Math.max(pTop, Math.min(pBottom, ny)); }
  else if (nx > pRight)  { ax = pRight;  ay = Math.max(pTop, Math.min(pBottom, ny)); }
  else if (ny < pTop)    { ax = Math.max(pLeft, Math.min(pRight, nx)); ay = pTop;    }
  else if (ny > pBottom) { ax = Math.max(pLeft, Math.min(pRight, nx)); ay = pBottom; }
  else                   { ax = pCx; ay = pCy; }  // node is INSIDE popout -- line collapses

  svg.style.display = "block";
  line.setAttribute("x1", nx);
  line.setAttribute("y1", ny);
  line.setAttribute("x2", ax);
  line.setAttribute("y2", ay);
  dot.setAttribute("cx", nx);
  dot.setAttribute("cy", ny);
  dot.setAttribute("r", Math.max(4, np.nodeRadius * 0.6));
}

async function _tektitePopoutOpen(noteId) {
  _tektitePopoutEnsureAttached();
  const popout      = document.getElementById("tektite-graph-popout");
  const titleEl     = document.getElementById("tektite-graph-popout-title");
  const titleInput  = document.getElementById("tektite-graph-popout-titleinput");
  const editor      = document.getElementById("tektite-graph-popout-editor");
  if (!popout || !titleEl || !titleInput || !editor) return;
  // Flush whatever was being edited for the previous node before swapping.
  await _tektitePopoutFlush();
  const s = _tektitePopoutState;
  s.noteId = noteId;
  popout.style.display = "flex";
  popout.classList.remove("collapsed");
  const collapseBtn = document.getElementById("tektite-graph-popout-collapse");
  if (collapseBtn) collapseBtn.textContent = "—";
  try {
    const note = await tektiteGetNote(noteId);
    titleEl.textContent  = (note && note.title) || noteId;
    titleInput.value     = (note && note.title) || noteId;
    editor.value         = (note && note.content) || "";
    _tektitePopoutSetStatus("");
  } catch (e) {
    editor.value = "Failed to load: " + (e.message || e);
    _tektitePopoutSetStatus("error", "err");
  }
  // Sprint tektite-5c2 -- show the connector to the source node.
  _tektiteUpdateConnector();
}

async function _tektitePopoutFlush() {
  const s = _tektitePopoutState;
  if (s.saveTimer) { clearTimeout(s.saveTimer); s.saveTimer = null; }
  if (!s.noteId) return;
  const titleInput = document.getElementById("tektite-graph-popout-titleinput");
  const editor     = document.getElementById("tektite-graph-popout-editor");
  if (!titleInput || !editor) return;
  const title   = (titleInput.value || s.noteId).trim();
  const content = editor.value || "";
  _tektitePopoutSetStatus("Saving…", "saving");
  try {
    const existing = await tektiteGetNote(s.noteId);
    await tektitePutNote({
      id:        s.noteId,
      title:     title || s.noteId,
      content,
      createdAt: existing && existing.createdAt
    });
    const titleEl = document.getElementById("tektite-graph-popout-title");
    if (titleEl) titleEl.textContent = title || s.noteId;
    _tektitePopoutSetStatus("Saved", "ok");
    setTimeout(() => {
      const el = document.getElementById("tektite-graph-popout-status");
      if (el && el.textContent === "Saved") _tektitePopoutSetStatus("");
    }, 1500);
    // Also refresh the backlinks + tags indices for this note.
    if (typeof tektiteBacklinksOnNoteSaved === "function") {
      tektiteBacklinksOnNoteSaved({ id: s.noteId, title, content, modifiedAt: Date.now() });
    }
    if (typeof tektiteTagsOnNoteSaved === "function") {
      tektiteTagsOnNoteSaved({ id: s.noteId, title, content, modifiedAt: Date.now() });
    }
  } catch (e) {
    _tektitePopoutSetStatus("✗ " + (e.message || e), "err");
    console.warn("[tektite] popout save failed:", e);
  }
}

/* Sprint tektite-2 -- wikilink navigation. Resolves a [[target]] in
 * priority order: vault notes by id → vault notes by case-insensitive
 * title → other writable sources by filename. If nothing matches,
 * offers to create a new vault note under that name. */
async function _tektiteNavigateWikilink(target) {
  if (!target) return;
  const s = _tektiteTabState;
  const targetLc = target.toLowerCase();

  // 1. Try as a vault id (slug match).
  const vaultHit = await tektiteGetNote(target);
  if (vaultHit) {
    s.activeSource = "vault";
    await _tektiteTabRefresh();
    await tektiteEditorLoadFromSource("vault", vaultHit.id);
    _tektiteTabRender();
    return;
  }
  // 2. Try as a vault title (case-insensitive).
  const vaultList = await tektiteListNotes();
  const titleHit = vaultList.find(n => (n.title || n.id).toLowerCase() === targetLc);
  if (titleHit) {
    s.activeSource = "vault";
    await _tektiteTabRefresh();
    await tektiteEditorLoadFromSource("vault", titleHit.id);
    _tektiteTabRender();
    return;
  }
  // 3. Walk other sources (local-fs / github) for filename matches.
  const sources = tektiteSourcesList();
  for (const src of sources) {
    if (src.id === "vault") continue;
    try {
      const listing = await tektiteSourceListNotes(src.id);
      const fileHit = listing.find(n =>
        (n.title || "").toLowerCase() === targetLc ||
        (n.path  || "").toLowerCase() === targetLc ||
        (n.path  || "").toLowerCase().endsWith("/" + targetLc + ".md"));
      if (fileHit) {
        s.activeSource = src.id;
        await _tektiteTabRefresh();
        await tektiteEditorLoadFromSource(src.id, fileHit.id);
        _tektiteTabRender();
        return;
      }
    } catch (_) {}
  }
  // 4. Nothing matched -- offer to create. Only when vault is writable.
  if (tektiteSourceIsWritable("vault") &&
      window.confirm("No note named \"" + target + "\" found. Create one in the Vault?")) {
    try {
      const newId = await tektiteSourceCreateNote("vault", target);
      s.activeSource = "vault";
      await _tektiteTabRefresh();
      await tektiteEditorLoadFromSource("vault", newId);
      _tektiteTabRender();
    } catch (e) {
      window.alert("Create failed: " + (e.message || e));
    }
  }
}

/* Render the backlinks panel for the currently-loaded note. Vault-only
 * for sprint 2 -- remote-source backlinks need an async cross-source
 * walk that lands in sprint tektite-3. */
async function _tektiteRenderBacklinks() {
  const s = _tektiteTabState;
  if (!s.backlinksEl) return;
  const noteId = tektiteEditorCurrentNoteId();
  const sourceId = tektiteEditorCurrentSourceId();
  if (!noteId || sourceId !== "vault") {
    s.backlinksEl.innerHTML = `
      <div class="tektite-backlinks-header">Backlinks</div>
      <div class="tektite-backlinks-empty">${noteId ? "Backlinks are vault-only for now." : "Select a note to see incoming links."}</div>`;
    return;
  }
  await tektiteBacklinksEnsureReady();
  // Look up incoming for both the slug id AND the displayed title --
  // users may [[link]] by either.
  const note = await tektiteGetNote(noteId);
  const incomingById    = tektiteBacklinksGetIncoming(noteId);
  const incomingByTitle = (note && note.title && note.title !== noteId)
    ? tektiteBacklinksGetIncoming(note.title)
    : [];
  // Merge dedup by sourceId.
  const seen = new Set();
  const incoming = [];
  for (const e of incomingById.concat(incomingByTitle)) {
    if (seen.has(e.noteId) || e.noteId === noteId) continue;
    seen.add(e.noteId);
    incoming.push(e);
  }

  const header = `<div class="tektite-backlinks-header">Backlinks <span class="tektite-backlinks-count">${incoming.length}</span></div>`;
  if (!incoming.length) {
    s.backlinksEl.innerHTML = header +
      `<div class="tektite-backlinks-empty">No notes link here yet. Add <code>[[${_tektiteEscapeHtml(note ? note.title : noteId)}]]</code> elsewhere in the vault.</div>`;
    return;
  }
  const html = incoming.map(e => {
    return `<div class="tektite-backlink-item" data-id="${_tektiteEscapeAttr(e.noteId)}">
      <div class="tektite-backlink-title">${_tektiteEscapeHtml(e.title)}</div>
      <div class="tektite-backlink-ts">${e.modifiedAt ? _tektiteFormatRelativeTime(e.modifiedAt) : ""}</div>
    </div>`;
  }).join("");
  s.backlinksEl.innerHTML = header + html;
  s.backlinksEl.querySelectorAll(".tektite-backlink-item").forEach(el => {
    const id = el.getAttribute("data-id");
    el.addEventListener("click", async () => {
      s.activeSource = "vault";
      await _tektiteTabRefresh();
      await tektiteEditorLoadFromSource("vault", id);
      _tektiteTabRender();
    });
  });
}

/* Phase C sprint tektite-1.5b -- fullscreen toggle. Adds a body
 * class that the CSS uses to pin #br-view-tektite over the canvas
 * area. Bigger editor + the note list moves to a left rail. */
function _tektiteTabSetFullscreen(on) {
  const s = _tektiteTabState;
  s.fullscreen = !!on;
  document.body.classList.toggle("tektite-fullscreen", s.fullscreen);
  const btn = document.getElementById("btn-tektite-fullscreen");
  if (btn) {
    btn.textContent = s.fullscreen ? "⤡ Collapse" : "⤢ Expand";
    btn.title = s.fullscreen
      ? "Return Tektite to the sidebar"
      : "Expand Tektite to fill the editor area";
  }
}

async function _tektiteTabRefresh() {
  const s = _tektiteTabState;
  try {
    s.notes = await tektiteSourceListNotes(s.activeSource);
  } catch (e) {
    s.notes = [];
    console.warn("[tektite] source list failed:", e);
    if (s.listEl) {
      s.listEl.innerHTML = `<div class="tektite-empty">⚠ ${_tektiteEscapeHtml(e.message || String(e))}</div>`;
    }
  }
  _tektiteTabRenderSources();
  _tektiteTabRender();
}

function _tektiteTabRenderSources() {
  const s = _tektiteTabState;
  if (!s.sourceRailEl) return;
  const sources = tektiteSourcesList();
  const chips = sources.map(src => {
    const isActive = (src.id === s.activeSource);
    const icon = src.type === "vault"    ? "■"
              : src.type === "local-fs"  ? "⌂"
              : src.type === "github"    ? "⬡"
              : src.type === "gdrive"    ? "◐" : "?";
    const removable = !src.permanent;
    return `<div class="tektite-source-chip ${isActive ? "active" : ""}" data-id="${_tektiteEscapeAttr(src.id)}" title="${_tektiteEscapeAttr(src.path || "")}">
      <span class="tektite-source-icon">${icon}</span>
      <span class="tektite-source-name">${_tektiteEscapeHtml(src.name)}</span>
      ${removable ? `<button class="tektite-source-x" data-remove="${_tektiteEscapeAttr(src.id)}" title="Disconnect this source">×</button>` : ""}
    </div>`;
  }).join("");
  s.sourceRailEl.innerHTML = chips + `
    <button class="btn tektite-source-add" id="btn-tektite-connect-source" type="button" title="Connect a Local folder, GitHub repo, or Google Drive">+ Connect</button>`;
  s.sourceRailEl.querySelectorAll(".tektite-source-chip").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target && e.target.classList.contains("tektite-source-x")) return;
      const id = el.getAttribute("data-id");
      if (id && id !== s.activeSource) {
        s.activeSource = id;
        // Switching source -- drop the currently-loaded note since its
        // id won't be valid in the new source's listing.
        tektiteEditorLoad(null);
        _tektiteTabRefresh();
      }
    });
  });
  s.sourceRailEl.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-remove");
      if (window.confirm("Disconnect this source? Files stay on disk / GitHub; you can re-connect any time.")) {
        tektiteSourcesRemove(id);
        if (s.activeSource === id) s.activeSource = "vault";
        tektiteEditorLoad(null);
        _tektiteTabRefresh();
      }
    });
  });
  const connectBtn = document.getElementById("btn-tektite-connect-source");
  if (connectBtn) connectBtn.addEventListener("click", _tektiteOpenConnectModal);
}

function _tektiteTabRender() {
  const s = _tektiteTabState;
  if (!s.listEl) return;
  const filter = (s.filterText || "").toLowerCase().trim();
  // Sprint tektite-3 -- if we have structured search results (the user
  // typed a DSL query containing `:` operators), render those instead
  // of the plain substring-filtered list. Search is vault-only for
  // now; remote sources still fall back to substring.
  let filtered;
  let isSearchMode = false;
  if (s.searchResults && s.activeSource === "vault") {
    isSearchMode = true;
    filtered = s.searchResults;
  } else {
    filtered = filter
      ? s.notes.filter(n => (n.title || n.id).toLowerCase().includes(filter))
      : s.notes;
  }

  // Count badge.
  if (s.countEl) {
    s.countEl.textContent = filtered.length === s.notes.length
      ? filtered.length + " note" + (filtered.length === 1 ? "" : "s")
      : filtered.length + " / " + s.notes.length + " notes";
  }

  // Toggle the "+ New note" button -- vault always works; remote sources
  // only when they're writable (FS handle present / GH token present).
  const newBtn = document.getElementById("btn-tektite-new");
  if (newBtn) {
    const writable = tektiteSourceIsWritable(s.activeSource);
    newBtn.disabled = !writable;
    newBtn.title = writable
      ? ("Create a new note in this source (" + writable + ")")
      : "This source isn't writable. Switch to a writable source or reconnect.";
  }

  if (!filtered.length) {
    s.listEl.innerHTML = `
      <div class="tektite-empty">
        ${s.notes.length === 0
          ? (s.activeSource === "vault"
              ? "No notes yet. Click <strong>+ New note</strong> to start your vault."
              : "No markdown files found in this source.")
          : "No notes match the filter."}
      </div>`;
    return;
  }

  const currentId     = tektiteEditorCurrentNoteId();
  const currentSource = tektiteEditorCurrentSourceId();

  // Sprint tektite-5a -- if any note id contains `/`, render as a
  // folder tree instead of a flat list. Search-mode results stay flat
  // (the snippets + scoring matter more than the hierarchy). The user
  // can force list mode via the toolbar toggle (treeViewForced).
  const hasFolders = !isSearchMode &&
    filtered.some(n => String(n.id || n.path || "").includes("/"));
  const useTree = (s.treeViewForced === true) ||
                  (s.treeViewForced !== false && hasFolders);

  let html;
  if (useTree && typeof tektiteBuildTree === "function") {
    const tree = tektiteBuildTree(filtered);
    const flat = tektiteFlattenTree(tree, s.closedFolders);
    html = flat.map(item => {
      const indentPx = item.depth * 14;
      if (item.type === "folder") {
        return `<div class="tektite-folder-row" data-folder="${_tektiteEscapeAttr(item.path)}"
                     style="padding-left: ${8 + indentPx}px;">
          <span class="tektite-folder-arrow">${item.isOpen ? "▼" : "▶"}</span>
          <span class="tektite-folder-name">${_tektiteEscapeHtml(item.name)}</span>
          <span class="tektite-folder-count">${item.count}</span>
        </div>`;
      }
      const n = item.note;
      const id = n.noteId || n.id;
      const isActive = (id === currentId && currentSource === s.activeSource);
      return `<div class="tektite-note-item tektite-note-leaf${isActive ? " active" : ""}"
                   data-id="${_tektiteEscapeAttr(id)}"
                   style="padding-left: ${8 + indentPx}px;">
        <div class="tektite-note-title">${_tektiteEscapeHtml(item.name)}</div>
      </div>`;
    }).join("");
  } else {
    html = filtered.map(n => {
      const id      = n.noteId || n.id;
      const isActive = (id === currentId && currentSource === s.activeSource);
      const title    = _tektiteEscapeHtml(n.title || id);
      const ts       = n.modifiedAt ? _tektiteFormatRelativeTime(n.modifiedAt) : "";
      const path     = (s.activeSource === "vault") ? "" : `<span class="tektite-note-path">${_tektiteEscapeHtml(n.path || "")}</span>`;
      const snippet  = isSearchMode && n.snippet
        ? `<div class="tektite-note-snippet">${_tektiteEscapeHtml(n.snippet)}</div>` : "";
      const tagPills = isSearchMode && Array.isArray(n.matchedTags) && n.matchedTags.length
        ? '<div class="tektite-note-tags">' +
            n.matchedTags.slice(0, 4).map(t =>
              '<span class="tektite-tag-pill">#' + _tektiteEscapeHtml(t) + '</span>').join("") +
          '</div>'
        : "";
      return `<div class="tektite-note-item${isActive ? " active" : ""}" data-id="${_tektiteEscapeAttr(id)}">
        <div class="tektite-note-title">${title}</div>
        <div class="tektite-note-meta">${ts ? `<span class="tektite-note-ts">${ts}</span>` : ""}${path}</div>
        ${snippet}${tagPills}
      </div>`;
    }).join("");
  }
  s.listEl.innerHTML = html;

  // Sprint tektite-5a2 -- folder click toggles closed state (default open).
  s.listEl.querySelectorAll(".tektite-folder-row").forEach(row => {
    row.addEventListener("click", () => {
      const path = row.getAttribute("data-folder");
      if (!path) return;
      if (s.closedFolders.has(path)) s.closedFolders.delete(path);
      else s.closedFolders.add(path);
      _tektiteTabRender();
    });
  });

  // Sprint tektite-2 -- refresh backlinks after every list render
  // (loads happen via list clicks + a re-render is triggered).
  _tektiteRenderBacklinks();

  // Source-aware click + contextmenu wiring.
  s.listEl.querySelectorAll(".tektite-note-item").forEach(el => {
    const id = el.getAttribute("data-id");
    el.addEventListener("click", async () => {
      await tektiteEditorLoadFromSource(s.activeSource, id);
      // Show/hide the "Save to vault" button -- only meaningful when
      // the user wants a local copy of a remote note. With write back
      // working now, this is a "fork to vault" affordance rather than
      // a way to enable editing.
      if (s.saveToVaultBtnEl) {
        const showFork = (s.activeSource !== "vault");
        s.saveToVaultBtnEl.style.display = showFork ? "inline-block" : "none";
        if (showFork) {
          s.saveToVaultBtnEl._sourceId = s.activeSource;
          s.saveToVaultBtnEl._fileId   = id;
        }
      }
      _tektiteTabRender();
    });
    // Right-click delete -- only for the vault for now. Local-fs and
    // GitHub deletion via the API is a sprint tektite-2 follow-up.
    if (s.activeSource === "vault") {
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (window.confirm("Delete note \"" + (el.querySelector(".tektite-note-title")?.textContent || id) + "\"? This cannot be undone.")) {
          _tektiteTabDelete(id);
        }
      });
    }
  });
}

function _tektiteEscapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function _tektiteEscapeAttr(s) { return _tektiteEscapeHtml(s); }
function _tektiteFormatRelativeTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const dt = Date.now() - ms;
  if (dt < 60_000)        return "just now";
  if (dt < 3600_000)      return Math.floor(dt / 60_000) + "m ago";
  if (dt < 86400_000)     return Math.floor(dt / 3600_000) + "h ago";
  if (dt < 7 * 86400_000) return Math.floor(dt / 86400_000) + "d ago";
  const d = new Date(ms);
  return d.toLocaleDateString();
}

async function _tektiteTabCreate() {
  const s = _tektiteTabState;
  if (!tektiteSourceIsWritable(s.activeSource)) {
    window.alert("This source isn't writable. Switch to a writable source first.");
    return;
  }
  try {
    const newId = await tektiteSourceCreateNote(s.activeSource, "Untitled note");
    await _tektiteTabRefresh();
    await tektiteEditorLoadFromSource(s.activeSource, newId);
    _tektiteTabRender();
    const titleInput = document.getElementById("tektite-title");
    if (titleInput && s.activeSource === "vault") { titleInput.focus(); titleInput.select(); }
  } catch (e) {
    window.alert("Create failed: " + (e.message || String(e)));
  }
}

async function _tektiteTabDelete(id) {
  await tektiteDeleteNote(id);
  if (tektiteEditorCurrentNoteId() === id) {
    await tektiteEditorLoad(null);
  }
  await _tektiteTabRefresh();
}

/* Connect-modal handling. Tektite has its own modal (separate from
 * the assets browser's #connect-modal) because the field semantics
 * differ slightly: we filter for `.md` files, label sources for vault
 * pull, and the GitHub PAT note explicitly references the deferred
 * secrets-manager phase. */
function _tektiteOpenConnectModal() {
  const m = document.getElementById("tektite-connect-modal");
  if (!m) return;
  m.style.display = "flex";
  _tektiteConnectSelectProvider("local");
}
function _tektiteCloseConnectModal() {
  const m = document.getElementById("tektite-connect-modal");
  if (m) m.style.display = "none";
}
function _tektiteConnectSelectProvider(provider) {
  document.querySelectorAll("#tektite-connect-providers .provider").forEach(el => {
    el.classList.toggle("selected", el.getAttribute("data-provider") === provider);
  });
  document.getElementById("tektite-connect-form-local").style.display = provider === "local" ? "" : "none";
  document.getElementById("tektite-connect-form-github").style.display = provider === "github" ? "" : "none";
  document.getElementById("tektite-connect-form-gdrive").style.display = provider === "gdrive" ? "" : "none";
  _tektiteTabState._connectProvider = provider;
}
async function _tektiteConnectGo() {
  const provider = _tektiteTabState._connectProvider || "local";
  try {
    if (provider === "local") {
      const label = (document.getElementById("tektite-connect-local-name") || {}).value || "";
      const importToVault = !!(document.getElementById("tektite-connect-local-import") || {}).checked;
      const result = await tektiteSourcesAddLocal({ label, importToVault });
      const src = (result && result.src) || result;
      _tektiteTabState.activeSource = importToVault ? "vault" : src.id;
      if (importToVault && result && Number.isFinite(result.imported)) {
        window.alert("Imported " + result.imported + " notes into the vault.");
      }
    } else if (provider === "github") {
      const repo  = (document.getElementById("tektite-connect-gh-repo")  || {}).value || "";
      const path  = (document.getElementById("tektite-connect-gh-path")  || {}).value || "";
      const token = (document.getElementById("tektite-connect-gh-token") || {}).value || "";
      const label = (document.getElementById("tektite-connect-gh-label") || {}).value || "";
      const src = await tektiteSourcesAddGithub({ repo, path, token, label });
      _tektiteTabState.activeSource = src.id;
    } else if (provider === "gdrive") {
      tektiteSourcesAddDrive();  // throws
    }
    _tektiteCloseConnectModal();
    tektiteEditorLoad(null);
    _tektiteTabRefresh();
  } catch (e) {
    window.alert("Connect failed: " + (e.message || String(e)));
  }
}

async function _tektiteSaveToVault() {
  const s = _tektiteTabState;
  const btn = s.saveToVaultBtnEl;
  if (!btn || !btn._sourceId || !btn._fileId) return;
  btn.disabled = true;
  try {
    const newId = await tektiteSourceImportToVault(btn._sourceId, btn._fileId);
    s.activeSource = "vault";
    await _tektiteTabRefresh();
    await tektiteEditorLoad(newId);
    if (btn) btn.style.display = "none";
    _tektiteTabRender();
  } catch (e) {
    window.alert("Save to vault failed: " + (e.message || String(e)));
  } finally {
    btn.disabled = false;
  }
}

/* Wire up button + filter handlers + editor save listener. Idempotent
 * -- safe to call multiple times; bails after first attach. */
function tektiteTabAttach() {
  const s = _tektiteTabState;
  if (s.attached) return;
  s.listEl       = document.getElementById("tektite-notes-list");
  s.countEl      = document.getElementById("tektite-notes-count");
  s.filterInput  = document.getElementById("tektite-filter");
  s.sourceRailEl = document.getElementById("tektite-source-rail");
  s.saveToVaultBtnEl = document.getElementById("btn-tektite-save-to-vault");
  if (!s.listEl) return;

  const newBtn = document.getElementById("btn-tektite-new");
  if (newBtn) newBtn.addEventListener("click", () => { _tektiteTabCreate(); });

  // Sprint tektite-4 -- daily-note shortcut.
  const todayBtn = document.getElementById("btn-tektite-today");
  if (todayBtn) todayBtn.addEventListener("click", async () => {
    try {
      const id = await tektiteDailyNoteOpenOrCreate({});
      s.activeSource = "vault";
      await _tektiteTabRefresh();
      await tektiteEditorLoadFromSource("vault", id);
      _tektiteTabRender();
    } catch (e) {
      window.alert("Today note open/create failed: " + (e.message || e));
    }
  });

  // Sprint tektite-5b -- graph view modal.
  const graphBtn = document.getElementById("btn-tektite-graph");
  if (graphBtn) graphBtn.addEventListener("click", () => _tektiteOpenGraphModal());

  // Sprint tektite-8 -- Bases modal.
  const basesBtn = document.getElementById("btn-tektite-bases");
  if (basesBtn) basesBtn.addEventListener("click", () => _tektiteBasesOpen());

  // Sprint tektite-9 -- Canvas modal.
  const canvasBtn = document.getElementById("btn-tektite-canvas");
  if (canvasBtn) canvasBtn.addEventListener("click", () => _tektiteCanvasOpen());

  // Sprint tektite-5c2 -- main editor minimize. Toggles the
  // `editor-minimized` class on the editor pane; CSS handles the
  // collapse + restore. Button text flips between "— Hide" and
  // "▢ Show" so the user can tell what clicking will do next.
  const editorMinBtn = document.getElementById("btn-tektite-editor-min");
  if (editorMinBtn) editorMinBtn.addEventListener("click", () => {
    const pane = document.getElementById("tektite-editor-pane");
    if (!pane) return;
    pane.classList.toggle("editor-minimized");
    editorMinBtn.textContent = pane.classList.contains("editor-minimized")
      ? "▢ Show" : "— Hide";
  });
  const graphCloseBtn = document.getElementById("btn-tektite-graph-close");
  if (graphCloseBtn) graphCloseBtn.addEventListener("click", () => _tektiteCloseGraphModal());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _tektiteGraphState.modal &&
        _tektiteGraphState.modal.style.display !== "none") {
      _tektiteCloseGraphModal();
    }
  });

  if (s.filterInput) {
    // Sprint tektite-3 -- distinguish DSL queries (contain `:`,
    // quotes, or `tag:`/`prop:`/`path:` prefixes) from plain
    // substring filters. DSL runs through tektiteRunQuery; plain
    // filters do the old startsWith/includes path. Quick re-render
    // with a short 120ms debounce so a typing burst on a 1k-note
    // vault doesn't thrash.
    let searchTimer = null;
    s.filterInput.addEventListener("input", async () => {
      s.filterText = s.filterInput.value || "";
      if (searchTimer) clearTimeout(searchTimer);
      const isDsl = /(?:^|\s)(?:tag:|prop:|path:|".+?")/.test(s.filterText) &&
                    s.activeSource === "vault";
      if (!isDsl) {
        s.searchResults = null;
        _tektiteTabRender();
        return;
      }
      searchTimer = setTimeout(async () => {
        // Make sure the tags index is warm so tag-clause matching is fast.
        if (typeof tektiteTagsEnsureReady === "function") {
          await tektiteTagsEnsureReady();
        }
        try {
          s.searchResults = await tektiteRunQuery(s.filterText);
        } catch (e) {
          console.warn("[tektite] search failed:", e);
          s.searchResults = [];
        }
        _tektiteTabRender();
      }, 120);
    });
  }

  // Editor wiring -- now source-aware (vault + local-fs + github writes).
  const editorRoot = document.getElementById("tektite-editor-pane");
  if (editorRoot) tektiteEditorAttach(editorRoot);

  // Sprint tektite-2 -- wire the wikilink ctrl-click handler so
  // CodeMirror clicks resolve through _tektiteNavigateWikilink.
  if (typeof tektiteEditorSetWikilinkNavigator === "function") {
    tektiteEditorSetWikilinkNavigator(_tektiteNavigateWikilink);
  }

  // Sprint tektite-2 -- backlinks panel lives in #tektite-backlinks.
  s.backlinksEl = document.getElementById("tektite-backlinks");

  // On save: update the listing if same source AND update the
  // backlinks index (vault only). Re-render backlinks if the saved
  // note is the one currently open, since the user might have added /
  // removed a [[link]] that changes its incoming list.
  tektiteEditorOnSave((record) => {
    if (!record) return;
    // Sprint tektite-3a -- record.titleOnly comes from the title-input
    // immediate-feedback path. Skip the heavyweight backlinks + tags
    // re-ingest for those (the body content hasn't actually been
    // written yet), but DO update the list entry so the rename
    // reflects instantly. The next real save will refresh indices.
    if (!record.titleOnly && record.sourceId === "vault") {
      const ingestArg = {
        id:         record.fileId,
        title:      record.title,
        content:    record.content,
        modifiedAt: record.modifiedAt
      };
      if (typeof tektiteBacklinksOnNoteSaved === "function") {
        tektiteBacklinksOnNoteSaved(ingestArg);
      }
      if (typeof tektiteTagsOnNoteSaved === "function") {
        tektiteTagsOnNoteSaved(ingestArg);
      }
      _tektiteRenderBacklinks();
    }
    // List re-order (active source only).
    if (record.sourceId === s.activeSource) {
      const idx = s.notes.findIndex(n => n.id === record.fileId);
      const listingEntry = {
        id:         record.fileId,
        title:      record.title,
        path:       record.fileId,
        modifiedAt: record.modifiedAt,
        sourceId:   record.sourceId
      };
      if (idx >= 0) s.notes.splice(idx, 1);
      s.notes.unshift(listingEntry);
      _tektiteTabRender();
    }
  });

  // Fullscreen toggle.
  const fsBtn = document.getElementById("btn-tektite-fullscreen");
  if (fsBtn) {
    fsBtn.addEventListener("click", () => _tektiteTabSetFullscreen(!s.fullscreen));
  }
  // Esc collapses fullscreen.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && s.fullscreen) _tektiteTabSetFullscreen(false);
  });

  // Connect-modal wiring.
  document.querySelectorAll("#tektite-connect-providers .provider").forEach(el => {
    el.addEventListener("click", () => _tektiteConnectSelectProvider(el.getAttribute("data-provider")));
  });
  const closeBtn = document.getElementById("tektite-connect-close");
  if (closeBtn) closeBtn.addEventListener("click", _tektiteCloseConnectModal);
  const cancelBtn = document.getElementById("tektite-connect-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", _tektiteCloseConnectModal);
  const goBtn = document.getElementById("tektite-connect-go");
  if (goBtn) goBtn.addEventListener("click", _tektiteConnectGo);

  if (s.saveToVaultBtnEl) {
    s.saveToVaultBtnEl.addEventListener("click", _tektiteSaveToVault);
    s.saveToVaultBtnEl.style.display = "none";
  }

  s.attached = true;
  _tektiteTabRefresh();
}
