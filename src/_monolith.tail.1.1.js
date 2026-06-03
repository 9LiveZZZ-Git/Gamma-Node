

/* Derive a list of tags for a demo from its id + name + sub + type.
 * Used by the filter rail (multi-select chips) and the search index.
 * Tag inventory: audio, visual, shader, 3d, 2d, physics, destruction,
 * game, ui, ai, sprite, terrain, planet, water, particles, fsm,
 * lifecycle, capstone. */
function _deriveDemoTags(d) {
  const hay = ((d.id || "") + " " + (d.name || "") + " " + (d.sub || "") + " " + (d.type || "")).toLowerCase();
  const tags = new Set();
  if (d.type === "audio")                     tags.add("audio");
  if (/audio|synth|biquad|filter|reverb|delay|fft|oscill/.test(hay)) tags.add("audio");
  if (/\b3d|three[- ]?d|cube|sphere|cannon|destruction|fracture|rapier 3/.test(hay)) tags.add("3d");
  if (/\b2d\b|platform|tilemap|level2d|sprite|rapier 2/.test(hay))   tags.add("2d");
  if (/physic|rigid|collid|joint|raycast|spherecast|sweep|pendulum|gravity|impact|forc/.test(hay)) tags.add("physics");
  if (/destruct|fracture|voronoi|shatter|cannon vs/.test(hay))       tags.add("destruction");
  if (/state ?machine|stage|game|menu|won|intro|capstone|platformer/.test(hay)) tags.add("game");
  if (/capstone|sandbox/.test(hay))                                  tags.add("capstone");
  if (/ui|button|slider|panel|hud|leaderboard|widget/.test(hay))     tags.add("ui");
  if (/shader|wgsl|frag/.test(hay))                                  tags.add("shader");
  if (/ai|gemma|claude|llm|hand|pose|face|gesture/.test(hay))        tags.add("ai");
  if (/sprite|animat|spritesheet/.test(hay))                         tags.add("sprite");
  if (/terrain|height|heightmap|archipelago/.test(hay))              tags.add("terrain");
  if (/planet|globe|orbit/.test(hay))                                tags.add("planet");
  if (/water|ocean|wave|fluid|splash/.test(hay))                     tags.add("water");
  if (/particl/.test(hay))                                           tags.add("particles");
  if (/awake|destroy|update|lifecycle|onstart|reset/.test(hay))      tags.add("lifecycle");
  if (/^visual$|shader|gradient|noise demo/.test(hay))               tags.add("visual");
  return [...tags];
}

const _demoTagPool = ["all", "audio", "visual", "shader", "3d", "2d", "physics", "destruction", "game", "capstone", "ui", "ai", "sprite", "terrain", "planet", "water", "particles", "lifecycle"];
let _demoTagFilter = "all";
let _demoSearch    = "";
let _demoSort      = "default";

function brRenderDemos() {
  brRenderDemoTypeRail();
  brRenderDemoGrid();
}

function brRenderDemoTypeRail() {
  const rail = document.getElementById("br-demo-type-rail");
  if (!rail) return;
  // Count per tag across all demos (cached lazily on each render —
  // small N, cheap). "all" is the global count.
  const counts = new Map();
  for (const d of _demos) {
    const tags = _deriveDemoTags(d);
    if (!d._tagsCache) d._tagsCache = tags;
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  counts.set("all", _demos.length);
  rail.innerHTML = _demoTagPool
    .filter(t => t === "all" || (counts.get(t) || 0) > 0)
    .map(t => {
      const n = counts.get(t) || 0;
      return `
        <span class="type-chip ${_demoTagFilter === t ? "active" : ""}" data-type="${escapeAttr(t)}">
          ${escapeText(t.toUpperCase())}<span class="count">${n}</span>
        </span>`;
    }).join("");
  rail.querySelectorAll(".type-chip").forEach(c => {
    c.addEventListener("click", () => {
      _demoTagFilter = c.dataset.type;
      brRenderDemos();
    });
  });
}

function brRenderDemoGrid() {
  const grid = document.getElementById("br-demos-grid");
  if (!grid) return;
  let list = _demos.slice();

  // Tag filter
  if (_demoTagFilter && _demoTagFilter !== "all") {
    list = list.filter(d => {
      const tags = d._tagsCache || _deriveDemoTags(d);
      return tags.includes(_demoTagFilter);
    });
  }

  // Text search across name + sub + id + tags
  const q = (_demoSearch || "").trim().toLowerCase();
  if (q) {
    list = list.filter(d => {
      const tags = d._tagsCache || _deriveDemoTags(d);
      const hay = (d.name + " " + (d.sub || "") + " " + d.id + " " + tags.join(" ")).toLowerCase();
      return hay.includes(q);
    });
  }

  // Sort
  if (_demoSort === "az") list.sort((a, b) => a.name.localeCompare(b.name));
  if (_demoSort === "za") list.sort((a, b) => b.name.localeCompare(a.name));

  if (!list.length) {
    grid.innerHTML = `<div style="grid-column:1/-1; padding:30px 16px; text-align:center; color:var(--text-3); font-family:var(--font-body-m); font-size:11px;">
      No demos match.
    </div>`;
    return;
  }

  // Highlight matches in name/sub
  const hl = (text) => {
    if (!q) return escapeText(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return escapeText(text);
    return escapeText(text.slice(0, i)) +
      "<mark>" + escapeText(text.slice(i, i + q.length)) + "</mark>" +
      escapeText(text.slice(i + q.length));
  };

  grid.innerHTML = list.map(d => {
    const tags = d._tagsCache || _deriveDemoTags(d);
    const primaryTag = tags[0] || d.type;
    const tagChips = tags.slice(0, 3).map(t => `<span class="asset-badge ${escapeAttr(t)}" style="position:static;top:auto;right:auto;font-size:8px;padding:1px 4px;">${escapeText(t)}</span>`).join(" ");
    return `
      <div class="asset-card" data-demo-id="${escapeAttr(d.id)}" title="${escapeAttr(d.name + ' — click to load')}">
        <div class="asset-thumb">${d.thumb || ""}</div>
        <div class="asset-meta">
          <span class="asset-name">${hl(d.name)}</span>
          <span class="asset-sub">${hl(d.sub || "")}</span>
        </div>
        <div class="asset-badge-row" style="position:absolute;top:4px;right:4px;display:flex;gap:2px;flex-direction:column;align-items:flex-end;">
          ${tagChips}
        </div>
      </div>
    `;
  }).join("");
  grid.querySelectorAll(".asset-card").forEach(card => {
    card.addEventListener("click", () => loadDemo(card.dataset.demoId));
  });
}

/* ─── Prefabs tab ───────────────────────────────────────────────────
 * Browsable prefab palette. Two sources merge into one grid:
 *   - _stockPrefabs: built-in, self-contained templates (inline JSON).
 *     This is where curated stock prefabs live + grow over time.
 *   - IDB prefab assets: anything the user saved via Save Prefab ->
 *     Save to IDB (Assets.list({type:"prefab"})).
 * Clicking a card drops a PrefabInstance into the canvas. Stock cards
 * embed the template inline; IDB cards reference the asset by id. */

const _stockPrefabs = [
  {
    id: "stock-pbr-box",
    name: "PBR Box",
    sub: "Box + PhysicalMat + Translate · mesh out",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g fill="rgba(150,170,200,0.9)" stroke="rgba(200,220,255,1)" stroke-width="0.8">
        <rect x="38" y="14" width="24" height="20"/>
        <polygon points="38,14 46,8 70,8 62,14"/>
        <polygon points="62,14 70,8 70,28 62,34"/>
      </g>
    </svg>`,
    template: {
      patchName: "PBR Box", version: 2,
      nodes: [
        { id: "t_box",   type: "Box",         params: { width: 1, height: 1, depth: 1 } },
        { id: "t_mat",   type: "PhysicalMat", params: { r: 0.7, g: 0.72, b: 0.78, metallic: 0.1, roughness: 0.6 } },
        { id: "t_trans", type: "Translate",   params: { x: 0, y: 0, z: 0 } }
      ],
      edges: [
        { from: { node: "t_box", port: "mesh" }, to: { node: "t_mat",   port: "mesh" } },
        { from: { node: "t_mat", port: "mesh" }, to: { node: "t_trans", port: "mesh" } }
      ],
      prefabMeta: {
        exposedParams: [
          { label: "x",         nodeId: "t_trans", paramName: "x" },
          { label: "y",         nodeId: "t_trans", paramName: "y" },
          { label: "z",         nodeId: "t_trans", paramName: "z" },
          { label: "metallic",  nodeId: "t_mat",   paramName: "metallic" },
          { label: "roughness", nodeId: "t_mat",   paramName: "roughness" }
        ],
        exposedPorts: [
          { label: "mesh", nodeId: "t_trans", portName: "mesh", direction: "out" }
        ]
      }
    }
  },
  {
    id: "stock-pbr-sphere",
    name: "PBR Sphere",
    sub: "Sphere + PhysicalMat + Translate · mesh out",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <circle cx="50" cy="22" r="13" fill="rgba(160,150,200,0.9)" stroke="rgba(210,200,255,1)" stroke-width="0.8"/>
      <circle cx="45" cy="17" r="3.5" fill="rgba(255,255,255,0.45)"/>
    </svg>`,
    template: {
      patchName: "PBR Sphere", version: 2,
      nodes: [
        { id: "t_sph",   type: "Sphere",      params: { radius: 0.5, stacks: 16, slices: 24 } },
        { id: "t_mat",   type: "PhysicalMat", params: { r: 0.6, g: 0.55, b: 0.8, metallic: 0.2, roughness: 0.4 } },
        { id: "t_trans", type: "Translate",   params: { x: 0, y: 0, z: 0 } }
      ],
      edges: [
        { from: { node: "t_sph", port: "mesh" }, to: { node: "t_mat",   port: "mesh" } },
        { from: { node: "t_mat", port: "mesh" }, to: { node: "t_trans", port: "mesh" } }
      ],
      prefabMeta: {
        exposedParams: [
          { label: "x",         nodeId: "t_trans", paramName: "x" },
          { label: "y",         nodeId: "t_trans", paramName: "y" },
          { label: "z",         nodeId: "t_trans", paramName: "z" },
          { label: "radius",    nodeId: "t_sph",   paramName: "radius" },
          { label: "roughness", nodeId: "t_mat",   paramName: "roughness" }
        ],
        exposedPorts: [
          { label: "mesh", nodeId: "t_trans", portName: "mesh", direction: "out" }
        ]
      }
    }
  },
  {
    id: "stock-ground-plane",
    name: "Ground Plane",
    sub: "Plane + PhysicalMat + Translate · mesh out",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <polygon points="20,30 80,30 92,38 8,38" fill="rgba(90,110,90,0.9)" stroke="rgba(140,170,140,1)" stroke-width="0.8"/>
    </svg>`,
    template: {
      patchName: "Ground Plane", version: 2,
      nodes: [
        { id: "t_pl",    type: "Plane",       params: { width: 20, depth: 20 } },
        { id: "t_mat",   type: "PhysicalMat", params: { r: 0.34, g: 0.36, b: 0.32, metallic: 0, roughness: 0.9 } },
        { id: "t_trans", type: "Translate",   params: { x: 0, y: 0, z: 0 } }
      ],
      edges: [
        { from: { node: "t_pl",  port: "mesh" }, to: { node: "t_mat",   port: "mesh" } },
        { from: { node: "t_mat", port: "mesh" }, to: { node: "t_trans", port: "mesh" } }
      ],
      prefabMeta: {
        exposedParams: [
          { label: "x", nodeId: "t_trans", paramName: "x" },
          { label: "y", nodeId: "t_trans", paramName: "y" },
          { label: "z", nodeId: "t_trans", paramName: "z" }
        ],
        exposedPorts: [
          { label: "mesh", nodeId: "t_trans", portName: "mesh", direction: "out" }
        ]
      }
    }
  },
  {
    id: "stock-label-panel",
    name: "Label Panel",
    sub: "UIPanel + UIText · centered HUD card",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="24" y="12" width="52" height="20" rx="3" fill="rgba(10,16,24,0.9)" stroke="rgba(155,208,255,1)" stroke-width="0.8"/>
      <rect x="34" y="20" width="32" height="3" rx="1" fill="rgba(207,233,255,0.9)"/>
    </svg>`,
    template: {
      patchName: "Label Panel", version: 2,
      nodes: [
        { id: "t_panel", type: "UIPanel", params: { x: 0, y: 0, width: 280, height: 90, color: "#0a1018", borderColor: "#9bd0ff", borderWidth: 2, borderRadius: 8, opacity: 0.92, corner: "center" } },
        { id: "t_text",  type: "UIText",  params: { text: "LABEL", x: 0, y: 0, fontSize: 22, width: 260, color: "#cfe9ff", align: "center", opacity: 0.95, corner: "center" } }
      ],
      edges: [],
      prefabMeta: {
        exposedParams: [
          { label: "text", nodeId: "t_text",  paramName: "text" },
          { label: "x",    nodeId: "t_panel", paramName: "x" },
          { label: "y",    nodeId: "t_panel", paramName: "y" }
        ],
        exposedPorts: []
      }
    }
  }
];

let _prefabSearch = "";

function _prefabBrowserCount() {
  let idb = 0;
  try { idb = (typeof Assets !== "undefined") ? Assets.list({ type: "prefab" }).length : 0; } catch (_) {}
  return _stockPrefabs.length + idb;
}

function brRenderPrefabs() {
  brRenderPrefabTypeRail();
  brRenderPrefabGrid();
}

const _prefabTagPool = ["all", "stock", "saved"];
let _prefabTagFilter = "all";

function brRenderPrefabTypeRail() {
  const rail = document.getElementById("br-prefab-type-rail");
  if (!rail) return;
  let idbCount = 0;
  try { idbCount = (typeof Assets !== "undefined") ? Assets.list({ type: "prefab" }).length : 0; } catch (_) {}
  const counts = { all: _stockPrefabs.length + idbCount, stock: _stockPrefabs.length, saved: idbCount };
  rail.innerHTML = _prefabTagPool.map(t => `
    <span class="type-chip ${_prefabTagFilter === t ? "active" : ""}" data-type="${escapeAttr(t)}">
      ${escapeText(t.toUpperCase())}<span class="count">${counts[t] || 0}</span>
    </span>`).join("");
  rail.querySelectorAll(".type-chip").forEach(c => {
    c.addEventListener("click", () => {
      _prefabTagFilter = c.dataset.type;
      brRenderPrefabs();
    });
  });
}

function brRenderPrefabGrid() {
  const grid = document.getElementById("br-prefabs-grid");
  if (!grid) return;

  // Build the unified list: stock entries + IDB asset entries.
  let idbList = [];
  try { idbList = (typeof Assets !== "undefined") ? Assets.list({ type: "prefab" }) : []; } catch (_) {}

  let items = [];
  if (_prefabTagFilter !== "saved") {
    items = items.concat(_stockPrefabs.map(p => ({
      kind: "stock",
      id: p.id,
      name: p.name,
      sub: p.sub,
      thumb: p.thumb,
      template: p.template,
      meta: p.template.prefabMeta || {},
      nodeCount: (p.template.nodes || []).length,
      edgeCount: (p.template.edges || []).length
    })));
  }
  if (_prefabTagFilter !== "stock") {
    items = items.concat(idbList.map(p => ({
      kind: "saved",
      id: p.id,
      name: p.name || p.id,
      sub: ((p.nodes || []).length + " nodes · " + (p.edges || []).length + " edges"),
      thumb: "",
      meta: p.prefabMeta || {},
      nodeCount: (p.nodes || []).length,
      edgeCount: (p.edges || []).length
    })));
  }

  // Search filter
  const q = (_prefabSearch || "").trim().toLowerCase();
  if (q) {
    items = items.filter(it =>
      (it.name + " " + (it.sub || "") + " " + it.id).toLowerCase().includes(q));
  }

  if (!items.length) {
    grid.innerHTML = `<div style="grid-column:1/-1; padding:30px 16px; text-align:center; color:var(--text-3); font-family:var(--font-body-m); font-size:11px;">
      ${q ? "No prefabs match." : "No prefabs yet.<br><br><span style='font-size:10px; color:var(--text-3);'>Select nodes on the canvas, then click <b>＋ Save Selection</b> above to add one — or drop a stock prefab.</span>"}
    </div>`;
    return;
  }

  const hl = (text) => {
    if (!q) return escapeText(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return escapeText(text);
    return escapeText(text.slice(0, i)) +
      "<mark>" + escapeText(text.slice(i, i + q.length)) + "</mark>" +
      escapeText(text.slice(i + q.length));
  };

  const fallbackThumb = `<svg viewBox="0 0 100 44">
    <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
    <g fill="none" stroke="rgba(180,140,90,0.9)" stroke-width="1">
      <rect x="30" y="12" width="18" height="18" rx="1"/>
      <rect x="52" y="16" width="18" height="18" rx="1"/>
    </g>
  </svg>`;

  grid.innerHTML = items.map(it => {
    const nP = (it.meta.exposedParams || []).length;
    const badge = it.kind === "stock"
      ? `<span class="asset-badge" style="position:static;top:auto;right:auto;font-size:8px;padding:1px 4px;background:rgba(80,120,180,0.5);">stock</span>`
      : `<span class="asset-badge" style="position:static;top:auto;right:auto;font-size:8px;padding:1px 4px;background:rgba(120,160,90,0.5);">saved</span>`;
    const delBtn = it.kind === "saved"
      ? `<button class="pf-del" data-pf-id="${escapeAttr(it.id)}" title="Delete from IDB" style="position:absolute;bottom:4px;right:4px;font:9px var(--font-mono);color:#e88;background:rgba(0,0,0,0.5);border:1px solid rgba(200,80,80,0.5);border-radius:2px;cursor:pointer;padding:1px 5px;">×</button>`
      : "";
    return `
      <div class="asset-card" data-pf-kind="${escapeAttr(it.kind)}" data-pf-id="${escapeAttr(it.id)}" title="${escapeAttr(it.name + ' — click to drop into the canvas')}">
        <div class="asset-thumb">${it.thumb || fallbackThumb}</div>
        <div class="asset-meta">
          <span class="asset-name">${hl(it.name)}</span>
          <span class="asset-sub">${hl(it.sub || "")}${nP ? " · " + nP + " params" : ""}</span>
        </div>
        <div class="asset-badge-row" style="position:absolute;top:4px;right:4px;display:flex;gap:2px;flex-direction:column;align-items:flex-end;">${badge}</div>
        ${delBtn}
      </div>`;
  }).join("");

  grid.querySelectorAll(".asset-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("pf-del")) return;
      const kind = card.dataset.pfKind;
      const id = card.dataset.pfId;
      if (kind === "stock") _dropStockPrefab(id);
      else _dropPrefabFromAsset(id);
    });
  });
  grid.querySelectorAll(".pf-del").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.pfId;
      let rec = null;
      try { rec = Assets.get(id); } catch (_) {}
      if (!rec) return;
      if (!confirm("Delete prefab '" + (rec.name || id) + "' from IDB?\n\nLive PrefabInstance nodes referencing it keep their last expansion but won't refresh.")) return;
      try { await Assets.delete(id); } catch (_) {}
      brRenderPrefabs();
    });
  });
}

/* World-space point at the center of the canvas viewport, offset so a
 * dropped node's top-left lands roughly centered. The `view` transform
 * is { panX, panY, zoom } — there is no view.x / view.scale, so the
 * old (vw*0.5 - view.x)/view.scale math produced NaN, which spawned
 * nodes at an unpositionable NaN coordinate. */
function _canvasDropPoint() {
  try {
    const rect = canvas.getBoundingClientRect();
    const w = screenToWorld(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5);
    return { x: Math.max(0, w.x - 70), y: Math.max(0, w.y - 40) };
  } catch (_) {
    return { x: 60, y: 60 };
  }
}

/* Phase 8.B.15 -- drop the loader node for a compile-server asset.
 * mesh → LoadGLB, hdri → HDRISky, texture → a textured PhysicalMat.
 * The node references the asset by `server:<id>`; the loader streams
 * it from the compile-server on first evaluation. */
function _dropServerAsset(serverId, type) {
  const dp = _canvasDropPoint();
  let nodeType = null, params = {};
  if (type === "mesh")        { nodeType = "LoadGLB";     params = { url: "server:" + serverId }; }
  else if (type === "hdri")   { nodeType = "HDRI";        params = { url: "server:" + serverId }; }
  else if (type === "texture"){ nodeType = "PhysicalMat"; params = { albedo: "server:" + serverId }; }
  if (!nodeType || !TYPES[nodeType]) {
    console.warn("[assets] no loader node for '" + type + "' yet (server:" + serverId + ")");
    return;
  }
  pushHistory("asset-drop:" + serverId);
  const id = makeNode(nodeType, dp.x, dp.y, params);
  console.log("[assets] dropped " + nodeType + " for server:" + serverId + " (node " + id + ")");
  if (typeof render === "function") render();
  if (typeof renderProps === "function") renderProps();
}

/* Drop a stock prefab: spawn a PrefabInstance with the template
 * embedded inline + the exposed params seeded to the template's
 * child defaults so the instance shows sensible starting values. */
function _dropStockPrefab(stockId) {
  const sp = _stockPrefabs.find(p => p.id === stockId);
  if (!sp) return;
  const _dp = _canvasDropPoint();
  const dropX = _dp.x, dropY = _dp.y;
  // Seed exposed params from their child-node defaults.
  const seed = { templateName: sp.name, templateInline: JSON.stringify(sp.template), templateAssetId: "" };
  for (const ep of (sp.template.prefabMeta.exposedParams || [])) {
    const child = sp.template.nodes.find(n => n.id === ep.nodeId);
    if (child && child.params && typeof child.params[ep.paramName] !== "undefined") {
      seed[ep.label] = child.params[ep.paramName];
    }
  }
  pushHistory("prefab-drop-stock:" + sp.name);
  const instId = makeNode("PrefabInstance", dropX, dropY, seed);
  console.log("[prefab] dropped stock '" + sp.name + "' as instance " + instId);
  if (typeof render === "function") render();
  if (typeof renderProps === "function") renderProps();
}

/* Hide (or fully remove) every on-screen overlay canvas: UI widgets
 * (ui-canvas-*), HUDText (hud-text-*), and the singleton HUDs
 * (minimap / altimeter / fly-to). Used in two places:
 *   - remove=true  on patch switch (loadDemo / load .gpatch) so the old
 *                  patch's overlays are gone before the new one builds.
 *   - remove=false on exiting live mode, so they vanish immediately
 *     regardless of whether the visual render loop is still ticking.
 * Without this, an overlay shown during live mode could linger because
 * the tick that would hide it (_tickUiNodes / _tickHudTextNodes) only
 * runs inside renderVisualFrame, which may be frozen / not running. */
function _hideAllOverlays(remove) {
  const sel = 'canvas[id^="ui-canvas-"], canvas[id^="hud-text-"], #hud-minimap, #hud-altimeter, #hud-flyto';
  document.querySelectorAll(sel).forEach(c => {
    if (remove) c.remove();
    else c.style.display = "none";
  });
}

function _cleanupBeforePatchSwitch() {
  _hideAllOverlays(true);
  if (state && Array.isArray(state.nodes)) {
    for (const n of state.nodes) {
      if (n && n._rapierWorld) { try { n._rapierWorld.free(); } catch(_) {} n._rapierWorld = null; n._bodyMap = null; }
    }
  }
  try { if (Visual) { Visual.lifecyclePhases = {}; Visual.lifecycleElapsedMap = {}; } } catch (_) {}
}

function loadDemo(id) {
  const demo = _demos.find(d => d.id === id);
  if (!demo) return;
  if (state.nodes && state.nodes.length &&
      !confirm("Load demo '" + demo.name + "'? Current patch will be replaced.")) return;
  pushHistory("load-demo:" + id);
  _cleanupBeforePatchSwitch();
  state = freshState();
  clearSelection();
  nextId = 1;
  try { demo.build(); } catch (e) { console.warn("[demos] build failed:", e); }
  render();
  renderProps && renderProps();
}

/* ───────────────────────────────────────────────────────────────
 * Sprint platformer-debug -- console-callable diagnostics.
 * Drop "gammaDebug.all()" into the browser console to dump every
 * angle of the current patch state in one shot:
 *   - body position vs tilemap collision tiles around it
 *   - camera position + visible world rect
 *   - each Scene2D's mesh inputs with their type, vert count,
 *     bounding box (so you can see if they're off-screen), depthZ
 *     baked into verts, and texture-load state
 *   - asset library snapshot (which asset:NAME urls are resolved)
 *
 * Individual functions also available:
 *   gammaDebug.body(), gammaDebug.camera(), gammaDebug.scene(),
 *   gammaDebug.assets(), gammaDebug.meshes()
 * ─────────────────────────────────────────────────────────────── */
const gammaDebug = (function() {
  function _findNodes(type) {
    if (!state || !Array.isArray(state.nodes)) return [];
    return state.nodes.filter(n => n && n.type === type);
  }
  function fmt(n) { return (typeof n === "number") ? n.toFixed(3) : String(n); }

  function body() {
    const bodies = _findNodes("PlatformerBody2D");
    if (bodies.length === 0) { console.log("[debug.body] no PlatformerBody2D in patch"); return null; }
    const out = [];
    for (const b of bodies) {
      const p = b.params || {};
      out.push({
        id:       b.id,
        x:        p.x, y: p.y,
        vx:       p.vx, vy: p.vy,
        grounded: p.grounded,
        facing:   p.facing,
        width:    p.width, height: p.height,
        groundY:  p.groundY,
        initX:    p.initX, initY: p.initY,
        inited:   p._inited
      });
      console.log("[debug.body] " + b.id + ": pos=(" + fmt(p.x) + "," + fmt(p.y) +
        ")  vel=(" + fmt(p.vx) + "," + fmt(p.vy) + ")  grounded=" + p.grounded +
        "  facing=" + p.facing + "  groundY=" + p.groundY);
      if (typeof p.y === "number" && typeof p.groundY === "number" && p.y < p.groundY + 0.5) {
        console.warn("  !! body is AT or BELOW groundY -- it may have fallen through");
      }
    }
    return out;
  }

  function camera() {
    const cams = (state.nodes || []).filter(n => n && (n.type === "OrthoCamera2D" || n.type === "Camera" || n.type === "FPCamera"));
    if (!cams.length) { console.log("[debug.camera] no camera in patch"); return null; }
    const out = [];
    for (const c of cams) {
      const p = c.params || {};
      const halfH = (typeof p.orthoSize === "number") ? p.orthoSize : 5;
      const aspect = (typeof Visual !== "undefined" && Visual.canvas) ? Visual.canvas.width / Math.max(1, Visual.canvas.height) : 16/9;
      const halfW = halfH * aspect;
      const info = {
        id: c.id, type: c.type,
        posX: p.posX, posY: p.posY, posZ: p.posZ,
        orthoSize: p.orthoSize, near: p.near, far: p.far,
        worldRect: {
          xMin: (p.posX || 0) - halfW, xMax: (p.posX || 0) + halfW,
          yMin: (p.posY || 0) - halfH, yMax: (p.posY || 0) + halfH
        }
      };
      console.log("[debug.camera] " + c.id + " " + c.type +
        ": pos=(" + fmt(p.posX) + "," + fmt(p.posY) + ")  orthoSize=" + fmt(p.orthoSize) +
        "  visible x=[" + fmt(info.worldRect.xMin) + "," + fmt(info.worldRect.xMax) + "]" +
        " y=[" + fmt(info.worldRect.yMin) + "," + fmt(info.worldRect.yMax) + "]");
      out.push(info);
    }
    return out;
  }

  function meshes() {
    // Walk every Scene2D's mesh inputs + dump what's wired in.
    const scenes = _findNodes("Scene2D");
    if (!scenes.length) { console.log("[debug.meshes] no Scene2D"); return null; }
    const out = [];
    for (const scn of scenes) {
      console.log("[debug.meshes] Scene2D " + scn.id + ":");
      const def = TYPES[scn.type];
      const meshPorts = def.ins.filter(p => p.t === "mesh").map(p => p.n);
      for (const port of meshPorts) {
        const wire = state.edges.find(e => e && e.to && e.to.node === scn.id && e.to.port === port);
        if (!wire) { console.log("  " + port + ": (unwired)"); continue; }
        const resolved = _walkMeshChain(wire.from.node, _mat4Identity(), null, 0);
        if (!resolved) { console.log("  " + port + ": (resolution failed)"); continue; }
        const leaf = resolved.node;
        const lp = leaf.params || {};
        // Build the mesh to inspect vert data (cheap, cached).
        let buf = null;
        try { buf = (typeof _buildMeshData === "function") ? _buildMeshData(leaf) : null; } catch (_) {}
        let vc = 0, zMin = NaN, zMax = NaN, xMin = NaN, xMax = NaN, yMin = NaN, yMax = NaN;
        if (buf && buf.verts) {
          vc = buf.verts.length / 11;
          for (let i = 0; i < buf.verts.length; i += 11) {
            const x = buf.verts[i], y = buf.verts[i + 1], z = buf.verts[i + 2];
            if (i === 0) { xMin = xMax = x; yMin = yMax = y; zMin = zMax = z; }
            else {
              if (x < xMin) xMin = x; if (x > xMax) xMax = x;
              if (y < yMin) yMin = y; if (y > yMax) yMax = y;
              if (z < zMin) zMin = z; if (z > zMax) zMax = z;
            }
          }
        }
        // Translate-from-transform: read xyz components of the
        // 4x4 (column-major) transform matrix.
        const tx = resolved.transform ? resolved.transform[12] : 0;
        const ty = resolved.transform ? resolved.transform[13] : 0;
        const tz = resolved.transform ? resolved.transform[14] : 0;
        const finalZ = (zMin + zMax) * 0.5 + tz;
        // Texture state for sprite-pipeline mesh types.
        let texInfo = "—";
        if (leaf.type === "Sprite" || leaf.type === "TileSpriteOverlay" ||
            leaf.type === "ParallaxLayer2D" || leaf.type === "SpriteScatter2D") {
          const e = (typeof _resolveSpriteTextureEntry === "function") ? _resolveSpriteTextureEntry(leaf) : null;
          if (!e) texInfo = "(no wire)";
          else texInfo = e.state + (e.view ? " " + e.width + "×" + e.height : "");
        }
        console.log("  " + port + ": " + leaf.type + "#" + leaf.id +
          "  verts=" + vc +
          "  vertZ=[" + fmt(zMin) + "," + fmt(zMax) + "]" +
          (tz !== 0 ? "  +tz=" + fmt(tz) : "") +
          " => final≈" + fmt(finalZ) +
          "  x=[" + fmt(xMin + tx) + "," + fmt(xMax + tx) + "]" +
          "  y=[" + fmt(yMin + ty) + "," + fmt(yMax + ty) + "]" +
          "  tex=" + texInfo);
        out.push({
          port, leafType: leaf.type, leafId: leaf.id, vertCount: vc,
          zMin, zMax, tx, ty, tz, finalZ,
          worldRect: { xMin: xMin + tx, xMax: xMax + tx, yMin: yMin + ty, yMax: yMax + ty },
          texture: texInfo
        });
      }
    }
    return out;
  }

  function assets() {
    if (typeof Assets === "undefined") { console.log("[debug.assets] Assets not initialized"); return null; }
    const sprites = Assets.list({ type: "sprite" }) || [];
    const folders = Assets.list({ type: "folder" }) || [];
    console.log("[debug.assets] " + sprites.length + " sprites, " + folders.length + " folders");
    for (const s of sprites) {
      console.log("  sprite '" + s.name + "' " + s.width + "×" + s.height +
        "  framesX=" + s.framesX + " framesY=" + s.framesY +
        "  blob=" + (s.blob ? s.blob.size + "B" : "missing") +
        "  source=" + (s.source || "?"));
    }
    return { sprites: sprites.length, folders: folders.length };
  }

  function scene() {
    body();
    camera();
    assets();
    meshes();
  }

  function all() {
    console.group("gammaDebug.all()");
    scene();
    console.groupEnd();
  }

  return { body, camera, meshes, assets, scene, all };
})();
if (typeof window !== "undefined") window.gammaDebug = gammaDebug;

/* ─── Assets tab ────────────────────────────────────────────────── */
/* Connection registry. "local-idb" is always-on — represents the
 * IDB-stored audio assets the rest of the editor already manages.
 * Real cloud connections (Drive / GitHub / disk folder) get pushed
 * onto this list when the user wires them up via the modal. */
const _brSources = [
  { id: "local-idb", name: "Local · IDB",      path: "browser indexedDB",   status: "connected", builtin: true },
  // Phase 8.B.15 / §8.F -- compile-server asset host (GLB meshes, PBR
  // textures, HDRIs). Status updates from brRefreshServerAssets.
  { id: "server",    name: "Server · assets",  path: "gamma-compile-server", status: "idle",      builtin: true },
];

// Cached compile-server asset manifest (Phase 8.B.15 / §8.F). Each
// entry: { id, type:"mesh"|"texture"|"hdri"|"audio", name, file, size,
// source, url }. Streamed lazily by LoadGLB / texture / HDRISky nodes.
let _serverAssets = [];
let _serverAssetsBase = null;

async function brRefreshServerAssets() {
  const src = _brSources.find(s => s.id === "server");
  try {
    // Reuse the editor's compile-server probe; localServerEndpoint is
    // set once detected.
    let base = (typeof localServerEndpoint === "string" && localServerEndpoint) ? localServerEndpoint : null;
    if (!base && typeof probeLocalServer === "function") {
      const ok = await probeLocalServer();
      base = ok ? localServerEndpoint : null;
    }
    if (!base) { if (src) { src.status = "offline"; src.path = "server not detected"; } _serverAssets = []; return; }
    _serverAssetsBase = base;
    const res = await fetch(base + "/assets", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    _serverAssets = Array.isArray(j.assets) ? j.assets : [];
    if (src) {
      src.status = j.fetching ? "fetching…" : "connected";
      src.path = _serverAssets.length + " asset" + (_serverAssets.length === 1 ? "" : "s") +
        (j.fetching ? " (downloading)" : "");
    }
  } catch (e) {
    if (src) { src.status = "offline"; src.path = "server not detected"; }
    _serverAssets = [];
  }
}

function brRenderAssets() {
  brRenderSourceList();
  brRenderTypeRail();
  brRenderAssetGrid();
  // Phase 8.B.15 -- refresh the compile-server manifest in the
  // background; re-render when it lands (kept out of the sync path so
  // the tab opens instantly even if the server is slow / absent).
  if (!brRenderAssets._refreshing) {
    brRenderAssets._refreshing = true;
    brRefreshServerAssets().finally(() => {
      brRenderAssets._refreshing = false;
      // Only re-render if the user is still on the Assets tab.
      if (brState.tab === "assets") {
        brRenderSourceList(); brRenderTypeRail(); brRenderAssetGrid();
      }
    });
  }
}

function brRenderSourceList() {
  const wrap = document.getElementById("br-src-list");
  if (!wrap) return;
  wrap.innerHTML = _brSources.map(s => `
    <div class="src-chip ${s.status} ${brState.assetSource === s.id ? "active" : ""}" data-id="${escapeAttr(s.id)}">
      <span class="src-led"></span>
      <span style="display:flex; flex-direction:column; gap:1px; min-width:0;">
        <span class="src-name">${escapeText(s.name)}</span>
        <span class="src-path">${escapeText(s.path)}</span>
      </span>
      <span class="src-status">${escapeText(s.status)}</span>
    </div>
  `).join("");
  wrap.querySelectorAll(".src-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      brState.assetSource = (brState.assetSource === chip.dataset.id) ? null : chip.dataset.id;
      brRenderAssets();
    });
  });
}

function brRenderTypeRail() {
  const wrap = document.getElementById("br-type-rail");
  if (!wrap) return;
  const all = brCollectAssets();
  const counts = { audio: 0, midi: 0, video: 0, gpatch: 0, gdsp: 0, sprite: 0, folder: 0, mesh: 0, texture: 0, hdri: 0 };
  all.forEach(a => { if (counts[a.type] != null) counts[a.type]++; });
  const types = [
    { k: null,     label: "ALL",     count: all.length },
    { k: "audio",  label: ".WAV",    count: counts.audio  },
    { k: "midi",   label: ".MID",    count: counts.midi   },
    { k: "video",  label: ".MP4",    count: counts.video  },
    { k: "gpatch", label: ".GPATCH", count: counts.gpatch },
    { k: "gdsp",   label: ".GDSP",   count: counts.gdsp   },
    { k: "sprite", label: ".SPRITE", count: counts.sprite },
    { k: "folder", label: ".FOLDER", count: counts.folder },
    { k: "mesh",   label: ".GLB",    count: counts.mesh    },
    { k: "texture",label: ".TEX",    count: counts.texture },
    { k: "hdri",   label: ".HDRI",   count: counts.hdri    },
  ];
  wrap.innerHTML = types.map(t => `
    <span class="type-chip ${brState.assetType === t.k ? "active" : ""}" data-type="${t.k || ""}">
      ${escapeText(t.label)}<span class="count">${t.count}</span>
    </span>
  `).join("")
  // asset-folders -- + Folder shortcut next to the type chips. Opens
  // the folder editor on a freshly-created blank folder.
  + `<span class="type-chip" id="br-new-folder-btn" data-action="new-folder" title="Create a new asset folder (group related sprites by function: character / enemy / item / etc.)" style="cursor:pointer; background:rgba(255,200,100,0.15); color:#ffd080;">+ FOLDER</span>`;
  wrap.querySelectorAll(".type-chip").forEach(c => {
    if (c.dataset.action === "new-folder") {
      c.addEventListener("click", async () => {
        const rec = await createFolderAsset("", "decoration", { source: "manual" });
        brRenderAssets();
        if (typeof _folderOpen === "function") _folderOpen(rec.id);
      });
    } else {
      c.addEventListener("click", () => {
        brState.assetType = c.dataset.type || null;
        brRenderAssets();
      });
    }
  });
}

/* Pull assets from every connected source. For now only local-idb
 * is real (the existing _assets map populated from IDB on startup);
 * cloud sources will append into this list once their connect
 * handlers populate the per-source asset cache. */
function brCollectAssets() {
  const out = [];
  if (_assets) {
    _assets.forEach((a, id) => {
      out.push({
        id, name: a.name, type: "audio",
        sub: `${a.durationSec.toFixed(2)} s · ${a.sampleRate} Hz · ${a.channels >= 2 ? "stereo" : "mono"}`,
        source: "local-idb", asset: a,
      });
    });
  }
  // §8.A.1 -- include sprite assets. Sub line shows pixel dims +
  // frames metadata; defaults frame count to 1×1 when unset.
  if (_spriteAssets) {
    _spriteAssets.forEach((a, id) => {
      const fx = a.framesX || 1;
      const fy = a.framesY || 1;
      const nFrames = fx * fy;
      const sub = (nFrames > 1)
        ? `${a.width}×${a.height} · ${fx}×${fy} frames · ${a.fps || 1} fps`
        : `${a.width}×${a.height}`;
      out.push({
        id, name: a.name, type: "sprite",
        sub, source: "local-idb", asset: a,
      });
    });
  }
  // asset-folders -- include folder assets. Sub line shows function +
  // filled / total slots so the user can see how complete a folder is.
  if (_folderAssets) {
    _folderAssets.forEach((a, id) => {
      const fdef = _ASSET_FUNCTIONS[a.functionKey] || _ASSET_FUNCTIONS["decoration"];
      const totalSlots = fdef.slots.length;
      const filled = Object.values(a.slots || {}).filter(v => v).length;
      const sub = `${fdef.label} · ${filled}/${totalSlots} slots`;
      out.push({
        id, name: a.name, type: "folder",
        sub, source: "local-idb", asset: a,
      });
    });
  }
  // Phase 8.B.15 -- compile-server assets (mesh / texture / hdri).
  for (const sa of _serverAssets) {
    if (!sa || !sa.id) continue;
    const kb = sa.size ? Math.round(sa.size / 1024) : 0;
    const sizeStr = kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB";
    out.push({
      id: "server:" + sa.id, name: sa.name || sa.id, type: sa.type || "file",
      sub: (sa.source || "server") + " · " + sizeStr,
      source: "server", asset: sa, serverId: sa.id
    });
  }
  return out;
}

function brRenderAssetGrid() {
  const grid = document.getElementById("br-assets-grid");
  if (!grid) return;
  let list = brCollectAssets();
  if (brState.assetType)   list = list.filter(a => a.type === brState.assetType);
  if (brState.assetSource) list = list.filter(a => a.source === brState.assetSource);

  if (!list.length) {
    grid.innerHTML = `<div style="grid-column:1/-1; padding:30px 16px; text-align:center; color:var(--text-3); font-family:var(--font-body-m); font-size:11px; line-height:1.6;">
      No assets match.<br><br>
      <span style="font-family:var(--font-mono); font-size:9.5px; letter-spacing:0.10em;">DROP A FILE HERE TO IMPORT — or load from a sample-host node's properties pane.</span>
    </div>`;
    return;
  }

  grid.innerHTML = list.map(a => {
    const dragTitle = (a.type === "sprite")
      ? a.name + ' — drag onto the patch canvas to drop in an ImageURL + Sprite pair (double-click name to rename)'
      : a.name + ' — drag onto a SamplePlayer / GranularPlayer node (double-click name to rename)';
    // §8.A.2 / §8.A.3 -- sprite metadata inline editor: cols / rows /
    // fps / px-u (pixels per world unit). All persist via Assets.put.
    const meta = (a.type === "sprite" && a.asset) ? `
      <div class="asset-spr-meta" style="display:flex; flex-wrap:wrap; gap:4px 6px; margin-top:4px; font-size:9.5px; font-family:var(--font-mono); color:var(--text-3);">
        <label style="display:flex; align-items:center; gap:2px;">cols
          <input type="number" min="1" max="64" value="${a.asset.framesX || 1}" data-spr-field="framesX" data-asset-id="${escapeAttr(a.id)}" style="width:34px; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--text-3); border-radius:2px; font-family:inherit; font-size:9.5px;"/>
        </label>
        <label style="display:flex; align-items:center; gap:2px;">rows
          <input type="number" min="1" max="64" value="${a.asset.framesY || 1}" data-spr-field="framesY" data-asset-id="${escapeAttr(a.id)}" style="width:34px; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--text-3); border-radius:2px; font-family:inherit; font-size:9.5px;"/>
        </label>
        <label style="display:flex; align-items:center; gap:2px;">fps
          <input type="number" min="0.5" max="60" step="0.5" value="${a.asset.fps || 1}" data-spr-field="fps" data-asset-id="${escapeAttr(a.id)}" style="width:38px; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--text-3); border-radius:2px; font-family:inherit; font-size:9.5px;"/>
        </label>
        <label style="display:flex; align-items:center; gap:2px;" title="pixels per world unit: drop-time Sprite size = textureDims / framesXY / scale">scale
          <input type="number" min="1" max="2048" step="1" value="${a.asset.scale || 32}" data-spr-field="scale" data-asset-id="${escapeAttr(a.id)}" style="width:46px; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--text-3); border-radius:2px; font-family:inherit; font-size:9.5px;"/>
        </label>
      </div>` : "";
    const _isServer = a.source === "server";
    const _serverId = _isServer ? (a.serverId || a.id.replace(/^server:/, "")) : "";
    return `
    <div class="asset-card" draggable="true" data-asset-id="${escapeAttr(a.id)}" data-asset-type="${escapeAttr(a.type)}"${_isServer ? ` data-server-id="${escapeAttr(_serverId)}"` : ""} title="${escapeAttr(dragTitle)}">
      ${_isServer ? "" : `<button class="asset-del" data-del-id="${escapeAttr(a.id)}" title="Delete this asset (irreversible)" style="position:absolute; top:3px; right:3px; width:18px; height:18px; padding:0; line-height:16px; border-radius:50%; background:rgba(40,12,12,0.85); color:#ffb0a0; border:1px solid rgba(200,80,80,0.4); cursor:pointer; font-size:12px; font-weight:600; z-index:2;">×</button>`}
      <div class="asset-thumb">${brAssetThumb(a)}</div>
      <div class="asset-meta">
        <span class="asset-name" data-asset-id="${escapeAttr(a.id)}" title="Double-click to rename" style="cursor:text;">${escapeText(a.name)}</span>
        <span class="asset-sub">${escapeText(a.sub)}</span>
        ${meta}
      </div>
      <span class="asset-badge ${a.type}">${escapeText(a.type)}</span>
    </div>
  `;
  }).join("");

  // Wire dragstart so the card can carry the asset id onto a node.
  // For sprite assets the patch canvas accepts the drop and creates
  // an ImageURL + Sprite pair (see _wirePatchCanvasAssetDrop).
  grid.querySelectorAll(".asset-card").forEach(card => {
    card.style.position = "relative";  // anchor for the delete button
    card.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/x-gamma-asset-id", card.dataset.assetId);
      // Drops also carry a type tag so the patch handler knows whether
      // to spawn ImageURL+Sprite (sprite), a SpriteFolder node (folder),
      // or something else.
      if (card.dataset.assetType) {
        e.dataTransfer.setData("text/x-gamma-asset-type", card.dataset.assetType);
      }
      e.dataTransfer.effectAllowed = "copy";
    });
    // asset-folders -- folder cards open the editor on click.
    if (card.dataset.assetType === "folder") {
      card.addEventListener("click", e => {
        // Don't trigger when the click was on the × delete button or an
        // input. Both stop propagation in their own handlers, but
        // guard defensively in case markup changes.
        if (e.target.closest("button.asset-del")) return;
        if (e.target.tagName === "INPUT") return;
        if (typeof _folderOpen === "function") _folderOpen(card.dataset.assetId);
      });
      card.style.cursor = "pointer";
    }
    // Phase 8.B.15 -- server assets: click drops the matching loader
    // node into the canvas (mesh → LoadGLB, hdri → HDRISky, texture →
    // a textured PhysicalMat). dragstart already carries the id.
    if (card.dataset.serverId) {
      card.style.cursor = "pointer";
      card.addEventListener("click", e => {
        if (e.target.tagName === "INPUT") return;
        _dropServerAsset(card.dataset.serverId, card.dataset.assetType);
      });
    }
  });
  // §8.A.1 / §8.A.2 -- delete buttons.
  grid.querySelectorAll(".asset-del").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delId;
      const rec = Assets.get(id);
      const label = rec ? rec.name : id;
      if (!confirm("Delete asset '" + label + "'? This can't be undone.")) return;
      // Revoke any cached object URL on the thumbnail to free the blob.
      if (rec && rec._thumbUrl) {
        try { URL.revokeObjectURL(rec._thumbUrl); } catch (_) {}
      }
      await Assets.delete(id);
      console.log("[assets] deleted '" + label + "' id=" + id);
      brRenderAssets();
    });
  });
  // §8.A.2 -- sprite metadata inputs. Edit framesX/framesY/fps/scale in
  // place; changes persist via Assets.put. Refresh the card sub-line + any
  // already-wired Sprite nodes via render().
  grid.querySelectorAll("input[data-spr-field]").forEach(inp => {
    inp.addEventListener("change", async (e) => {
      e.stopPropagation();
      const id = inp.dataset.assetId;
      const field = inp.dataset.sprField;
      const rec = Assets.get(id);
      if (!rec) return;
      let val = parseFloat(inp.value);
      if (!Number.isFinite(val) || val <= 0) val = (field === "fps" ? 1 : (field === "scale" ? 32 : 1));
      rec[field] = val;
      await Assets.put(rec);
      brRenderAssets();
      // Live-refresh any patches consuming this asset (so framesX/Y
      // changes are immediately reflected without a reload).
      if (typeof render === "function") {
        try { render(); } catch (_) {}
      }
    });
    // Don't let typing in the input start a drag-card behavior.
    inp.addEventListener("mousedown", e => e.stopPropagation());
    inp.addEventListener("dragstart", e => e.preventDefault());
  });
  // §8.A.3 -- rename. Double-click the asset name to edit in place.
  // Enter commits, Escape cancels, blur commits. All asset types support
  // rename (audio + sprite). Stops propagation so card drag doesn't fire.
  grid.querySelectorAll(".asset-name").forEach(nameEl => {
    nameEl.addEventListener("mousedown", e => e.stopPropagation());
    nameEl.addEventListener("dragstart", e => e.preventDefault());
    nameEl.addEventListener("dblclick", e => {
      e.stopPropagation();
      const id = nameEl.dataset.assetId;
      if (!id) return;
      const rec = Assets.get(id);
      if (!rec) return;
      const original = rec.name;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = original;
      inp.style.cssText = "width:100%; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--phosphor); border-radius:2px; font-family:var(--font-mono); font-size:9.5px;";
      nameEl.replaceWith(inp);
      inp.focus();
      inp.select();
      let committed = false;
      const commit = async () => {
        if (committed) return;
        committed = true;
        const raw = inp.value.trim();
        const newName = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || original;
        if (newName !== original) {
          rec.name = newName;
          await Assets.put(rec);
          console.log("[assets] renamed '" + original + "' → '" + newName + "' (id=" + rec.id + ")");
        }
        brRenderAssets();
        if (typeof render === "function") {
          // Live-update any wired ImageURL nodes that reference the old
          // name via 'asset:OLD' so the resolver finds the new name.
          if (newName !== original && Array.isArray(state.edges)) {
            for (const n of state.nodes || []) {
              if (n && n.type === "ImageURL" && n.params &&
                  n.params.url === "asset:" + original) {
                n.params.url = "asset:" + newName;
              }
            }
          }
          try { render(); } catch (_) {}
        }
      };
      inp.addEventListener("keydown", ev => {
        if (ev.key === "Enter")  { ev.preventDefault(); commit(); }
        if (ev.key === "Escape") { ev.preventDefault(); committed = true; brRenderAssets(); }
      });
      inp.addEventListener("blur", commit);
    });
  });
}

/* Generate a tiny SVG thumbnail per asset type. Audio uses the cached
 * data when available (real waveform); MIDI/video/gpatch/gdsp get
 * stylized glyphs since there's no representational data yet. */
function brAssetThumb(a) {
  if (a.type === "audio" && a.asset && a.asset.data) {
    // Quick downsampled min/max — 64 buckets across the asset.
    const data = Array.isArray(a.asset.data) ? a.asset.data[0] : a.asset.data;
    const W = 100, H = 44, BUCKETS = 50;
    const step = Math.max(1, Math.floor(data.length / BUCKETS));
    let path = "";
    for (let i = 0; i < BUCKETS; i++) {
      let mn = 1, mx = -1;
      for (let j = 0; j < step; j++) {
        const v = data[i * step + j] || 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const x = (i / BUCKETS) * W;
      const yMx = H/2 - mx * (H/2 - 2);
      const yMn = H/2 - mn * (H/2 - 2);
      path += `M ${x.toFixed(1)} ${yMx.toFixed(1)} L ${x.toFixed(1)} ${yMn.toFixed(1)} `;
    }
    return `<svg viewBox="0 0 100 44" preserveAspectRatio="none">
      <line x1="0" y1="22" x2="100" y2="22" stroke="rgba(200,232,90,0.10)" stroke-width="0.5"/>
      <path d="${path}" stroke="var(--phosphor)" stroke-width="0.7" fill="none" opacity="0.85"/>
    </svg>`;
  }
  // Phase 8.B.15 -- server asset glyphs (mesh / texture / hdri).
  if (a.type === "mesh") {
    return `<svg viewBox="0 0 100 44">
      <g fill="none" stroke="rgba(150,200,255,0.9)" stroke-width="1">
        <polygon points="50,8 78,22 50,36 22,22"/>
        <line x1="50" y1="8" x2="50" y2="36"/>
        <line x1="22" y1="22" x2="78" y2="22"/>
      </g>
    </svg>`;
  }
  if (a.type === "texture") {
    return `<svg viewBox="0 0 100 44">
      <rect x="24" y="6" width="52" height="32" rx="2" fill="none" stroke="rgba(160,220,160,0.9)" stroke-width="1"/>
      <path d="M 24 28 L 38 16 L 50 26 L 62 12 L 76 24" fill="none" stroke="rgba(160,220,160,0.7)" stroke-width="1"/>
      <circle cx="40" cy="14" r="3" fill="rgba(255,240,160,0.8)"/>
    </svg>`;
  }
  if (a.type === "hdri") {
    return `<svg viewBox="0 0 100 44">
      <rect x="14" y="8" width="72" height="28" rx="3" fill="url(#hdg)"/>
      <defs><linearGradient id="hdg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(120,170,255,0.9)"/>
        <stop offset="0.6" stop-color="rgba(255,210,140,0.8)"/>
        <stop offset="1" stop-color="rgba(120,90,60,0.8)"/>
      </linearGradient></defs>
      <circle cx="68" cy="16" r="4" fill="rgba(255,250,210,0.95)"/>
    </svg>`;
  }
  // Type-specific glyphs (stubs for non-audio sources)
  if (a.type === "midi") {
    return `<svg viewBox="0 0 100 44">
      <g fill="var(--gate)" opacity="0.85">
        <rect x="6"  y="22" width="6" height="3"/>
        <rect x="16" y="14" width="6" height="3"/>
        <rect x="26" y="26" width="6" height="3"/>
        <rect x="36" y="10" width="6" height="3"/>
        <rect x="46" y="18" width="6" height="3"/>
        <rect x="56" y="22" width="6" height="3"/>
        <rect x="66" y="14" width="6" height="3"/>
        <rect x="76" y="26" width="6" height="3"/>
      </g>
    </svg>`;
  }
  if (a.type === "video") {
    return `<svg viewBox="0 0 100 44">
      <rect x="0" y="0" width="100" height="44" fill="#0a0c10"/>
      <polygon points="42,14 42,30 58,22" fill="var(--info)" opacity="0.9"/>
      <line x1="0" y1="40" x2="40" y2="40" stroke="var(--info)" stroke-width="2"/>
    </svg>`;
  }
  if (a.type === "gpatch") {
    return `<svg viewBox="0 0 100 44">
      <line x1="14" y1="14" x2="42" y2="12" stroke="var(--warn)" stroke-width="0.7" opacity="0.6"/>
      <line x1="42" y1="12" x2="68" y2="22" stroke="var(--warn)" stroke-width="0.7" opacity="0.6"/>
      <line x1="68" y1="22" x2="42" y2="32" stroke="var(--warn)" stroke-width="0.7" opacity="0.6"/>
      <circle cx="14" cy="14" r="2" fill="var(--warn)"/>
      <circle cx="42" cy="12" r="2" fill="var(--warn)"/>
      <circle cx="68" cy="22" r="2" fill="var(--warn)"/>
      <circle cx="42" cy="32" r="2" fill="var(--warn)"/>
    </svg>`;
  }
  if (a.type === "gdsp") {
    return `<svg viewBox="0 0 100 44">
      <text x="50" y="18" text-anchor="middle" font-family="JetBrains Mono" font-size="6" fill="#a89cff" opacity="0.85">class</text>
      <text x="50" y="28" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#a89cff" font-weight="600">{ }</text>
      <text x="50" y="38" text-anchor="middle" font-family="JetBrains Mono" font-size="5" fill="#a89cff" opacity="0.6">.gdsp</text>
    </svg>`;
  }
  // asset-folders -- folder thumbnail. Shows a 2×2 mini-grid of the
  // folder's first 4 filled slots so the user can scan the contents at
  // a glance. Empty slots get a "+" placeholder.
  if (a.type === "folder" && a.asset) {
    const slots = a.asset.slots || {};
    const filled = Object.entries(slots).filter(([k, v]) => v).slice(0, 4);
    const cells = [0, 1, 2, 3].map(i => {
      const entry = filled[i];
      if (!entry) {
        return `<div style="background:#0a0c10; border:1px dashed rgba(255,255,255,0.08); display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,0.18); font-size:14px;">+</div>`;
      }
      const sid = entry[1];
      const srec = _spriteAssets.get(sid);
      if (!srec || !srec.blob) {
        return `<div style="background:#0a0c10; border:1px solid rgba(255,80,80,0.4); color:#ff8060; font-size:8px; padding:1px;" title="sprite deleted">${escapeText(entry[0])}</div>`;
      }
      let url = srec._thumbUrl;
      if (!url) {
        try { url = URL.createObjectURL(srec.blob); srec._thumbUrl = url; } catch (_) { url = ""; }
      }
      return `<div style="background:#0a0c10; overflow:hidden; display:flex; align-items:center; justify-content:center;"><img src="${escapeAttr(url)}" style="max-width:100%; max-height:100%; image-rendering:pixelated; image-rendering:crisp-edges;"/></div>`;
    }).join("");
    return `<div style="width:100%; height:100%; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:1px; background:rgba(255,200,100,0.10);">${cells}</div>`;
  }
  // §8.A.1 -- sprite thumbnail. Lazy-build an object URL from the blob
  // (cached on the record so we don't leak one per re-render). pixelated
  // image-rendering keeps SNES-style art crisp at thumbnail scale.
  if (a.type === "sprite" && a.asset && a.asset.blob) {
    let url = a.asset._thumbUrl;
    if (!url) {
      try {
        url = URL.createObjectURL(a.asset.blob);
        a.asset._thumbUrl = url;
      } catch (_) { url = ""; }
    }
    return `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:#0a0c10;">
      <img src="${escapeAttr(url)}" style="max-width:100%; max-height:100%; image-rendering:pixelated; image-rendering:crisp-edges;" alt="${escapeAttr(a.name)}"/>
    </div>`;
  }
  return "";
}

/* ─── Connect modal handlers ────────────────────────────────────── */
function brOpenConnectModal() {
  const m = document.getElementById("connect-modal");
  if (m) m.style.display = "flex";
}
function brCloseConnectModal() {
  const m = document.getElementById("connect-modal");
  if (m) m.style.display = "none";
}

/* Local-folder connect uses the File System Access API where
 * available. On non-Chromium browsers we fall back to letting the
 * user click a hidden <input type="file"> — that's slimmer than
 * the directory picker but at least imports do work. */
async function brConnectLocalFolder() {
  const labelEl = document.getElementById("connect-local-name");
  const label = (labelEl && labelEl.value.trim()) || "Local Folder";
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const dir = await window.showDirectoryPicker({ id: "gamma-asset-source" });
      _brSources.push({
        id: "local-fs-" + Date.now(),
        name: label, path: dir.name + "/",
        status: "connected", handle: dir,
      });
      brRenderAssets();
      brCloseConnectModal();
      // Future: walk the directory and populate per-source assets.
      console.info("[browser] Connected local folder:", dir.name);
    } catch (e) {
      // User cancelled the picker — silent.
    }
  } else {
    alert("Local folder picker needs the File System Access API (Chromium-based browsers). Drop files into the Assets list to import them instead.");
  }
}

/* GitHub repo connect: list files via the public Contents API. The
 * modal field captures owner/repo + path + optional PAT. The
 * fetched listing is held in-memory under a new source entry. */
async function brConnectGitHub() {
  const repo  = (document.getElementById("connect-gh-repo")  || {}).value || "";
  const path  = (document.getElementById("connect-gh-path")  || {}).value || "";
  const token = (document.getElementById("connect-gh-token") || {}).value || "";
  if (!repo || !repo.includes("/")) { alert("Repository must be owner/name"); return; }
  const url = `https://api.github.com/repos/${repo}/contents${path.startsWith("/") ? path : "/" + path}`;
  const headers = { "Accept": "application/vnd.github+json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const list = await r.json();
    const files = (Array.isArray(list) ? list : []).filter(x => x.type === "file");
    _brSources.push({
      id: "github-" + Date.now(),
      name: "GitHub · " + repo,
      path: (path || "/") + ` · ${files.length} files`,
      status: "connected",
      githubFiles: files,
    });
    brRenderAssets();
    brCloseConnectModal();
    console.info("[browser] Connected GitHub:", repo, path, files.length, "files");
  } catch (e) {
    alert("GitHub fetch failed: " + e.message);
  }
}

/* ─── Drop-zone wiring on the assets list ───────────────────────── */
function brWireAssetDropZone() {
  const list = document.getElementById("br-assets-list");
  if (!list || list._brWired) return;
  list._brWired = true;
  list.addEventListener("dragover", e => { e.preventDefault(); list.classList.add("dragover"); });
  list.addEventListener("dragleave", e => { if (e.target === list) list.classList.remove("dragover"); });
  list.addEventListener("drop", async e => {
    e.preventDefault();
    list.classList.remove("dragover");
    const files = Array.from(e.dataTransfer.files || []);
    for (const f of files) {
      // Audio files → reuse the existing IDB-backed loader.
      if (typeof loadAudioFileToAsset === "function" && /\.(wav|mp3|ogg|flac|m4a|webm)$/i.test(f.name)) {
        try { await loadAudioFileToAsset(f); } catch (err) { console.warn("[browser] decode failed:", f.name, err); }
      }
      // §8.A.1 -- image files → sprite assets (default 1×1 frames; the
      // user can edit framesX/Y after upload via the sprite props panel
      // shipping in §8.A.2). MIME-type sniff is lenient because Drag-Drop
      // sometimes drops files with no type set.
      else if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name) ||
               (f.type && f.type.indexOf("image/") === 0)) {
        try { await loadImageFileToSpriteAsset(f); }
        catch (err) { console.warn("[browser] sprite import failed:", f.name, err); }
      }
      // Other types — log a TODO; storage shape for them lands later.
      else { console.info("[browser] skipping unsupported file (storage TBD):", f.name); }
    }
    brRenderAssets();
  });
}

/* ─── Public-facing entry points ────────────────────────────────── */
/* Back-compat shim. Existing call sites (after addFromPalette, after
 * gdsp registration) still call renderPalette(filterText) directly. */
function renderPalette(filterText) {
  if (typeof filterText === "string") brState.search = filterText;
  brRenderNodes();
}
function highlightMatch(text, needle) {
  // Kept for back-compat with anything that still imports it.
  return brHighlight(text, brParseSearch(needle || ""));
}

function escapeText(s) { return String(s).replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c])); }
function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }

/* Wire the rest of the browser UI (toolbar, drawer, tabs, modal) and
 * kick off the first render. */
(function brBootstrap() {
  // Search input
  if (search) {
    search.addEventListener("input", () => {
      brState.search = search.value;
      brRenderNodes();
    });
  }
  // Op chips → insert into the search
  const ops = document.getElementById("br-search-ops");
  if (ops) {
    ops.querySelectorAll(".br-op").forEach(chip => {
      chip.addEventListener("click", () => {
        const op = chip.dataset.op;
        const v = (search.value || "").trim();
        search.value = (v ? v + " " : "") + op;
        search.focus();
        // place cursor at end so the user types the operand directly
        const i = search.value.length;
        try { search.setSelectionRange(i, i); } catch (e) {}
        brState.search = search.value;
        brRenderNodes();
      });
    });
  }
  // Mode toggles. Grid mode is reserved (uses the same DOM but with
  // a different layout class on .cat-items). For v1 only the LIST
  // mode is wired; clicking GRID for now is a placeholder until the
  // grid renderer ships in the next pass.
  document.querySelectorAll(".br-mode").forEach(btn => {
    btn.addEventListener("click", () => {
      brState.mode = btn.dataset.brMode;
      document.querySelectorAll(".br-mode").forEach(b => b.classList.toggle("active", b.dataset.brMode === brState.mode));
      // Toggle a class on the palette so future grid styling can hook
      // in without changing the rendered HTML structure.
      palette.classList.toggle("br-mode-grid", brState.mode === "grid");
    });
  });
  // Tab switching
  document.querySelectorAll(".br-tab").forEach(t => {
    if (t.classList.contains("disabled")) return;
    t.addEventListener("click", () => brSwitchTab(t.dataset.brTab));
  });
  // Demos search + sort
  const demoSearch = document.getElementById("br-demo-search");
  if (demoSearch) demoSearch.addEventListener("input", () => {
    _demoSearch = demoSearch.value;
    brRenderDemoGrid();
  });
  const demoSort = document.getElementById("br-demo-sort");
  if (demoSort) demoSort.addEventListener("change", () => {
    _demoSort = demoSort.value;
    brRenderDemoGrid();
  });
  // Prefabs search + save-selection
  const prefabSearch = document.getElementById("br-prefab-search");
  if (prefabSearch) prefabSearch.addEventListener("input", () => {
    _prefabSearch = prefabSearch.value;
    brRenderPrefabGrid();
  });
  const prefabSaveSel = document.getElementById("br-prefab-save-sel");
  if (prefabSaveSel) prefabSaveSel.addEventListener("click", () => {
    if (typeof _openPrefabSaveModal === "function") _openPrefabSaveModal();
  });
  // Drawer toggle
  const drwHead = document.getElementById("br-drawer-head");
  const drwAdd  = document.getElementById("br-drawer-add");
  if (drwHead) drwHead.addEventListener("click", e => {
    if (drwAdd && drwAdd.contains(e.target)) return;
    document.getElementById("br-drawer").classList.toggle("collapsed");
  });
  if (drwAdd) drwAdd.addEventListener("click", () => {
    if (brState.selected) addFromPalette(brState.selected);
  });
  // Connect modal wiring
  const srcAdd = document.getElementById("br-src-add");
  if (srcAdd) srcAdd.addEventListener("click", brOpenConnectModal);
  const ccls = document.getElementById("connect-close");
  const ccnl = document.getElementById("connect-cancel");
  if (ccls) ccls.addEventListener("click", brCloseConnectModal);
  if (ccnl) ccnl.addEventListener("click", brCloseConnectModal);
  document.querySelectorAll(".provider").forEach(p => {
    p.addEventListener("click", () => {
      document.querySelectorAll(".provider").forEach(x => x.classList.remove("selected"));
      p.classList.add("selected");
      ["local","gdrive","github"].forEach(k => {
        const f = document.getElementById("connect-form-" + k);
        if (f) f.style.display = k === p.dataset.provider ? "" : "none";
      });
    });
  });
  const cgo = document.getElementById("connect-go");
  if (cgo) cgo.addEventListener("click", () => {
    const sel = document.querySelector(".provider.selected");
    const which = sel ? sel.dataset.provider : "local";
    if (which === "local")  brConnectLocalFolder();
    if (which === "github") brConnectGitHub();
    if (which === "gdrive") alert("Google Drive integration ships in v0.1 — see the modal note.");
  });
  // Drop-zone (Assets tab)
  brWireAssetDropZone();
  // First paint
  brRenderNodes();
  brRenderDrawer();
})();

function addFromPalette(type) {
  pushHistory("add:" + type);
  const offset = state.nodes.length * 20;
  const x = 60 + (offset % 380);
  const y = 60 + ((offset * 0.7) % 280);
  const id = makeNode(type, x, y);
  if (id) selectOne(id);
  render();
}

/* Sprint §8.A.2 -- patch-canvas drop zone for asset-typed drags from
 * the Assets tab. Sprite asset drops create an ImageURL + Sprite +
 * Translate trio, wired and positioned at the drop point, so the user
 * gets a usable sprite chain with one drag gesture. Other asset types
 * (audio, future) are no-ops here -- their hosts have their own drop
 * paths (SamplePlayer's modal stage, etc.).
 *
 * dataTransfer carries text/x-gamma-asset-id and text/x-gamma-asset-type
 * (set by brRenderAssetGrid). dragover must preventDefault to allow drop. */
function _wirePatchCanvasAssetDrop() {
  if (!canvas || canvas._assetDropWired) return;
  canvas._assetDropWired = true;
  canvas.addEventListener("dragover", e => {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types || !types.indexOf) return;
    // Only accept asset-typed drags; let other drag interactions through.
    if (types.indexOf("text/x-gamma-asset-id") < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  canvas.addEventListener("drop", e => {
    const id = e.dataTransfer && e.dataTransfer.getData("text/x-gamma-asset-id");
    if (!id) return;
    const assetType = e.dataTransfer.getData("text/x-gamma-asset-type");
    if (assetType !== "sprite" && assetType !== "folder") return;  // audio etc handled elsewhere
    e.preventDefault();
    let rec = Assets.get(id);
    if (!rec) {
      console.warn("[asset-drop] " + assetType + " id not found: " + id);
      return;
    }
    // asset-folders / scene-bulk -- folder drops resolve to the folder's
    // PRIMARY sprite (first filled slot in the function's slot order),
    // then optionally spawn an animation/behavior chain wrapping it
    // based on the folder's functionKey:
    //   playable-character / enemy → AnimationState2D wrapper,
    //     auto-wired to any existing PlatformerBody2D in the patch
    //   decoration / item / npc / door / interactive / effect → plain
    //     sprite chain (single-frame display, no state machine)
    let folderFunction = null;
    if (assetType === "folder") {
      folderFunction = rec.functionKey || "decoration";
      const fdef = _ASSET_FUNCTIONS[folderFunction] || _ASSET_FUNCTIONS["decoration"];
      let primarySprite = null;
      for (const s of fdef.slots) {
        const sid = (rec.slots || {})[s.name];
        if (sid) {
          const srec = Assets.get(sid);
          if (srec && srec.assetType === "sprite") { primarySprite = srec; break; }
        }
      }
      if (!primarySprite) {
        console.warn("[asset-drop] folder '" + rec.name + "' has no filled slots");
        alert("Folder '" + rec.name + "' has no filled slots yet. Open it (click the card in Assets) and assign sprites first.");
        return;
      }
      console.log("[asset-drop] folder '" + rec.name + "' (" + folderFunction + ") → primary slot sprite '" + primarySprite.name + "'");
      rec = primarySprite;   // fall through to the sprite-drop path below
    }
    const w = screenToWorld(e.clientX, e.clientY);
    pushHistory("asset-drop:" + rec.name);
    // §8.A.3 -- Sprite size from texture pixel dimensions / frame count /
    // pixels-per-world-unit. A 64x64 sheet with framesX=2 framesY=1 scale=32
    // becomes a 1x2 unit sprite per frame. Default scale=32 so a 32x32
    // sheet becomes 1x1 world units (typical retro platformer cell).
    const scale = (typeof rec.scale === "number" && rec.scale > 0) ? rec.scale : 32;
    const framesX = rec.framesX || 1;
    const framesY = rec.framesY || 1;
    const sprW = (rec.width  / framesX) / scale;
    const sprH = (rec.height / framesY) / scale;
    // ImageURL → Sprite → Translate. Position the chain so the Translate
    // sits near the drop point and the source nodes line up to its left.
    const imgX = Math.max(0, w.x - 360);
    const sprX = Math.max(0, w.x - 180);
    const trX  = Math.max(0, w.x);
    const y    = Math.max(0, w.y);
    const imgId = makeNode("ImageURL", imgX, y, {
      url: "asset:" + rec.name,
      filterMode: "nearest",
      scale: scale
    });
    // Anchor: playable-character / enemy folder-drops use bottom-center
    // (anchorY=0) so the sprite's feet sit on the body's y position --
    // matches PlatformerBody2D's convention. Other drops default to
    // sprite-center per asset metadata.
    const wantsAnim = (folderFunction === "playable-character" || folderFunction === "enemy");
    const sprId = makeNode("Sprite", sprX, y, {
      width: sprW, height: sprH,
      anchorX: (rec.anchor && typeof rec.anchor.x === "number") ? rec.anchor.x : 0.5,
      anchorY: wantsAnim ? 0 : ((rec.anchor && typeof rec.anchor.y === "number") ? rec.anchor.y : 0.5),
      framesX: framesX,
      framesY: framesY,
      frame: 0,
      tintR: 1, tintG: 1, tintB: 1, tintA: 1
    });
    const trId = makeNode("Translate", trX, y, { x: 0, y: 0, z: -1 });
    if (state && Array.isArray(state.edges)) {
      state.edges.push({ from: { node: imgId, port: "texture" }, to: { node: sprId, port: "texture" } });
      state.edges.push({ from: { node: sprId, port: "mesh"    }, to: { node: trId,  port: "mesh"    } });
    }
    // Animation chain for character / enemy folders. Slots the
    // AnimationState2D between the (would-be) PlatformerBody2D and
    // the Sprite. Frame defaults assume a 6-frame sheet layout
    // (idle / walk-A / walk-mid / walk-B / jump / fall) -- matches
    // the default placeholder. User retunes per-sheet via the node UI.
    let animId = null;
    if (wantsAnim) {
      animId = makeNode("AnimationState2D", sprX, y + 200, {
        fps: 10,
        walkThreshold: 0.2,
        idleFrames: "0",
        walkFrames: "1,2,3,2",
        jumpFrames: "4",
        fallFrames: "5"
      });
      if (state && Array.isArray(state.edges)) {
        state.edges.push({ from: { node: animId, port: "frame" }, to: { node: sprId, port: "frame" } });
        state.edges.push({ from: { node: animId, port: "flipX" }, to: { node: sprId, port: "flipX" } });
      }
      // Auto-wire to an existing PlatformerBody2D if the patch has
      // one. This is the "drag the folder into your already-built
      // scene and it joins the rig" case. Picks the FIRST body in
      // the patch -- if there are multiple, user re-wires manually.
      const body = state && Array.isArray(state.nodes)
        ? state.nodes.find(n => n && n.type === "PlatformerBody2D")
        : null;
      if (body && state && Array.isArray(state.edges)) {
        state.edges.push({ from: { node: body.id, port: "vx"       }, to: { node: animId, port: "vx"       } });
        state.edges.push({ from: { node: body.id, port: "vy"       }, to: { node: animId, port: "vy"       } });
        state.edges.push({ from: { node: body.id, port: "grounded" }, to: { node: animId, port: "grounded" } });
        state.edges.push({ from: { node: body.id, port: "facing"   }, to: { node: animId, port: "facing"   } });
        state.edges.push({ from: { node: body.id, port: "x"        }, to: { node: trId,   port: "x"        } });
        state.edges.push({ from: { node: body.id, port: "y"        }, to: { node: trId,   port: "y"        } });
        console.log("[asset-drop] auto-wired AnimationState2D + Translate to existing PlatformerBody2D node=" + body.id);
      } else {
        console.log("[asset-drop] AnimationState2D spawned but no PlatformerBody2D in patch yet -- wire vx/vy/grounded/facing manually, or drop a Platformer 2D · Animated demo first");
      }
    }
    selectOne(animId || trId);
    render();
    console.log("[asset-drop] " + (folderFunction || "sprite") + " '" + rec.name + "' → "
      + (animId ? "ImageURL + AnimationState2D + Sprite + Translate" : "ImageURL + Sprite + Translate")
      + " at world (" + Math.round(w.x) + ", " + Math.round(w.y) + ")");
  });
}
// Install on startup (canvas exists by the time this file finishes
// executing; if not, the next addFromPalette call would also fire).
if (typeof canvas !== "undefined" && canvas) {
  _wirePatchCanvasAssetDrop();
}

/* =========================================================================
 * Geometry
 * ======================================================================== */
const NODE_W = 140;

function portPos(nodeId, portName, isOut) {
  // If this node is inside a collapsed group, the wire endpoint
  // redirects to the matching stub on the group's collapsed block
  // (rather than the now-hidden inner node). Returns null if the
  // edge is fully internal to a collapsed group (renderWires uses
  // null on either end as the "skip this wire" signal).
  const g = groupOfNode(nodeId);
  if (g && g.collapsed) {
    const ports = computeGroupPorts(g);
    const list = isOut ? ports.outputs : ports.inputs;
    const idx = list.findIndex(p => p.innerNode === nodeId && p.innerPort === portName);
    if (idx === -1) return null;
    const b = groupBounds(g);
    if (!b) return null;
    const x = isOut ? b.x + NODE_W : b.x;
    const y = b.y + 33 + idx * 20 + 10;
    return { x, y };
  }
  const n = nodeById(nodeId);
  if (!n) return null;
  const d = defOf(n);
  if (!d) return null;
  const list = isOut ? d.outs : d.ins;
  const idx = list.findIndex(p => p.n === portName);
  if (idx === -1) return null;
  const x = isOut ? n.x + NODE_W : n.x;
  const y = n.y + 33 + idx * 20 + 10;
  return { x, y };
}

function isConnected(nodeId, portName, isOut) {
  return state.edges.some(e =>
    isOut ? (e.from.node === nodeId && e.from.port === portName)
          : (e.to.node === nodeId && e.to.port === portName)
  );
}

/* =========================================================================
 * Render
 * ======================================================================== */
function render() {
  canvasWorld.querySelectorAll(".node").forEach(n => n.remove());
  canvasWorld.querySelectorAll(".group-backdrop").forEach(g => g.remove());

  // Recompute validation state once per render so node CSS classes
  // (cycle-error overlay, etc.) are up to date with the graph.
  state._cycleErrors = findInvalidCycles();

  // Groups — render expanded-group backdrops BEFORE nodes (lower
  // z-index so they sit visually behind their members). Collapsed
  // groups skip the backdrop and instead render as a single .node
  // block in the main loop below.
  (state.groups || []).forEach(g => {
    if (g.collapsed) return;
    const b = groupBounds(g);
    if (!b) return;
    const PAD = 18, HEAD = 26;
    const bd = document.createElement("div");
    bd.className = "group-backdrop" + (selectedGroupId === g.id ? " selected" : "");
    bd.dataset.groupId = g.id;
    bd.style.left = (b.x - PAD) + "px";
    bd.style.top  = (b.y - PAD - HEAD) + "px";
    bd.style.width  = (b.w + PAD * 2) + "px";
    bd.style.height = (b.h + PAD * 2 + HEAD) + "px";
    bd.innerHTML =
      `<div class="group-head">` +
        `<span class="group-mark">▾</span>` +
        `<span class="group-name">${escapeText(g.name)}</span>` +
        `<span class="group-meta">${g.members.length} nodes</span>` +
        `<button class="group-toggle-btn" data-group-toggle="${g.id}" title="Collapse this group (E)" aria-label="collapse">⊟</button>` +
      `</div>`;
    canvasWorld.appendChild(bd);
  });

  // Disconnected-output warning: if the patch has an Output / OutputStereo
  // node but it isn't fed by any edge, mark it amber so the user notices
  // before they wonder why the generated C++ returns 0.f.
  const outNode = state.nodes.find(n => n.type === "Output" || n.type === "OutputStereo");
  const outDisconnected = outNode && !state.edges.some(e => e.to.node === outNode.id);

  state.nodes.forEach(node => {
    const def = defOf(node);
    const isSel = selectedSet.has(node.id);

    // Skip nodes inside a collapsed group — the group renders its
    // own block via the loop further down. Wires that cross the
    // boundary get redirected to the group's port stubs in
    // renderWires.
    if (isInCollapsedGroup(node.id)) return;
    // Phase 8.A.3 -- skip children of PrefabInstances. They live in
    // state.nodes (so the existing tick + mesh resolver paths still
    // operate on them) but are visually hidden behind their parent
    // instance node, which IS rendered on the canvas.
    if (node.prefabParentId) return;
    // Phase 8.A.5 -- same treatment for Pool voice children.
    if (node.poolParentId) return;

    // Unknown node types: render a red placeholder so the user can see
    // and delete the orphan rather than the editor silently dropping it
    // (which previously also crashed on `def.color` access elsewhere).
    if (!def) {
      const el = document.createElement("div");
      el.className = "node unknown" + (isSel ? " selected" : "");
      el.style.left = node.x + "px";
      el.style.top  = node.y + "px";
      el.dataset.id = node.id;
      el.innerHTML =
        `<div class="node-strip" style="background:var(--danger)"></div>` +
        `<div class="node-head">` +
          `<span class="name" title="Unknown node type — likely a removed registry entry or a missing User DSP class">⚠ ${escapeText(node.type || "?")}</span>` +
          `<span class="node-id">${node.id}</span>` +
        `</div>` +
        `<div class="node-rows" style="padding:6px 12px 8px;font-size:10px;color:var(--text-3);font-style:italic;">unknown type</div>`;
      canvasWorld.appendChild(el);
      return;
    }

    const el = document.createElement("div");
    const cycleErr = state._cycleErrors && state._cycleErrors.has(node.id);
    const noOutWarn = outDisconnected && node === outNode;
    el.className = "node"
      + (isSel ? " selected" : "")
      + (cycleErr ? " cycle-error" : "")
      + (noOutWarn ? " no-output-warn" : "");
    el.style.left = node.x + "px";
    el.style.top  = node.y + "px";
    el.dataset.id = node.id;

    const strip = document.createElement("div");
    strip.className = "node-strip";
    strip.style.background = def.color;
    el.appendChild(strip);

    const head = document.createElement("div");
    head.className = "node-head";
    head.innerHTML = `<span class="name">${node.type}</span><span class="node-id">${node.id}</span>`;
    el.appendChild(head);

    const rows = document.createElement("div");
    rows.className = "node-rows";
    const rowCount = Math.max(def.ins.length, def.outs.length);
    for (let i = 0; i < rowCount; i++) {
      const inP  = def.ins[i];
      const outP = def.outs[i];
      const row = document.createElement("div");
      row.className = "row";

      const left = document.createElement("span");
      left.className = "label-l";
      left.textContent = inP ? inP.n : "";
      if (inP) row.appendChild(makePort(node.id, inP, "in"));
      row.appendChild(left);

      const right = document.createElement("span");
      right.className = "label-r";
      right.textContent = outP ? outP.n : "";
      if (outP) row.appendChild(makePort(node.id, outP, "out"));
      row.appendChild(right);

      rows.appendChild(row);
    }
    el.appendChild(rows);

    // Per-node code-editor handle. Only rendered for the currently-
    // selected node (and only when exactly one is selected) so we
    // don't clutter every node with a button. Sprint 5.node-edit.
    if (isSel && selectedSet.size === 1) {
      const handle = document.createElement("button");
      handle.className = "node-edit-handle";
      handle.title = "Edit this node's code + ports (E)";
      handle.textContent = "✎";
      handle.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      });
      handle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openNodeCodeEditor(node.id);
      });
      el.appendChild(handle);

      // §5.5.e -- TiledTerrain gets a second handle (⚙) that opens
      // the Tiling Config popup. Sits LEFT of the ✎ handle so both
      // are reachable. Only renders for TiledTerrain to avoid
      // cluttering other nodes.
      if (node.type === "TiledTerrain") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Tiling Config";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          openTilingConfigPopup(node.id);
        });
        el.appendChild(gear);
        // Shift the ✎ handle to the right so they don't overlap.
        handle.style.left = "calc(50% + 16px)";
      }
      // §planet-spec Phase 7.d -- PlanetMap gets a gear that opens the
      // equirect painter popup (raise/lower brush on the cell graph).
      if (node.type === "PlanetMap") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Planet Map Editor";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          openPlanetMapEditor(node.id);
        });
        el.appendChild(gear);
      }
      // SpriteCreator-1 -- gear opens the Sprite Studio modal preloaded
      // with this node's params (prompt / style / width / height /
      // framesX/Y / fps / scale). On save, modal writes back the new
      // asset name + the final values.
      if (node.type === "SpriteCreator") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Sprite Studio (generate sprite from this node's defaults)";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (typeof _ssOpen === "function") _ssOpen(node.id);
        });
        el.appendChild(gear);
        // Shift the ✎ handle right when both are present.
        handle.style.left = "calc(50% + 16px)";
      }
      // Sprint tilemap-painter -- gear handle opens the visual click-
      // paint editor for the wired Tilemap2D's tileData. Stops the
      // ASCII-counting madness.
      if (node.type === "Tilemap2D") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Tilemap Painter (click-paint cells with a brush)";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (typeof _tmeOpen === "function") _tmeOpen(node.id);
        });
        el.appendChild(gear);
        handle.style.left = "calc(50% + 16px)";
      }
      // Sprint Level2D Phase 1b -- gear handle opens the layer-list
      // modal so the user can add/remove/reorder layers + tweak
      // per-layer fields without hand-editing the layers JSON.
      if (node.type === "Level2D") {
        const gear = document.createElement("button");
        gear.className = "node-edit-handle node-tiling-handle";
        gear.title = "Open Level Editor (add / reorder / tweak layers)";
        gear.textContent = "⚙";
        gear.style.left = "calc(50% - 16px)";
        gear.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        });
        gear.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (typeof _lvlOpen === "function") _lvlOpen(node.id);
        });
        el.appendChild(gear);
        handle.style.left = "calc(50% + 16px)";
      }
    }

    canvasWorld.appendChild(el);
  });

  // Render each collapsed group as a single node-like block. The
  // block's position is recomputed every render from the member-
  // node bounds — so when the user drags the block, the underlying
  // member positions update and the next render reflects them
  // automatically. No bounds caching needed.
  (state.groups || []).forEach(g => {
    if (!g.collapsed) return;
    const b = groupBounds(g);
    if (!b) return;
    const x = b.x;
    const y = b.y;
    const ports = computeGroupPorts(g);
    const isSel = selectedGroupId === g.id;
    const el = document.createElement("div");
    el.className = "node group-node" + (isSel ? " selected" : "");
    el.style.left = x + "px";
    el.style.top  = y + "px";
    el.dataset.groupId = g.id;
    const inputCount = ports.inputs.length, outputCount = ports.outputs.length;
    const rowN = Math.max(inputCount, outputCount, 1);
    el.innerHTML =
      `<div class="node-strip" style="background: var(--accent)"></div>` +
      `<div class="node-head group-head-collapsed">` +
        `<span class="name" title="Click to select this group; double-click or use ⊞ to expand">${escapeText(g.name)}</span>` +
        `<button class="group-toggle-btn collapsed" data-group-toggle="${g.id}" title="Expand this group (E)" aria-label="expand">⊞</button>` +
        `<span class="node-id">${g.members.length}n</span>` +
      `</div>`;
    const rows = document.createElement("div");
    rows.className = "node-rows";
    for (let i = 0; i < rowN; i++) {
      const inP = ports.inputs[i];
      const outP = ports.outputs[i];
      const row = document.createElement("div");
      row.className = "row";
      const left = document.createElement("span");
      left.className = "label-l";
      left.textContent = inP ? inP.innerPort : "";
      if (inP) {
        const port = document.createElement("div");
        port.className = "port in " + inP.t;
        port.dataset.node = inP.innerNode;
        port.dataset.port = inP.innerPort;
        port.dataset.groupStub = "in";
        port.dataset.groupId = g.id;
        row.appendChild(port);
      }
      row.appendChild(left);
      const right = document.createElement("span");
      right.className = "label-r";
      right.textContent = outP ? outP.innerPort : "";
      if (outP) {
        const port = document.createElement("div");
        port.className = "port out " + outP.t;
        port.dataset.node = outP.innerNode;
        port.dataset.port = outP.innerPort;
        port.dataset.groupStub = "out";
        port.dataset.groupId = g.id;
        row.appendChild(port);
      }
      row.appendChild(right);
      rows.appendChild(row);
    }
    el.appendChild(rows);
    canvasWorld.appendChild(el);
  });
  renderWires();
  stats.textContent = state.nodes.length + " nodes · " + state.edges.length + " connections";
  filenameEl.textContent = state.filename;
  deleteBtn.disabled = selectedSet.size === 0;
  // Phase 8.A.3.2 -- enable Save Prefab only with a selection.
  const _btnPfs = document.getElementById("btn-save-prefab");
  if (_btnPfs) _btnPfs.disabled = selectedSet.size === 0;
  renderProps();
  renderCode();
  renderJson();
  applyView();
}

function makePort(nodeId, p, dir) {
  const port = document.createElement("div");
  const conn = isConnected(nodeId, p.n, dir === "out");
  port.className = "port " + dir + " " + p.t + (conn ? " connected" : "");
  port.dataset.node = nodeId;
  port.dataset.port = p.n;
  port.dataset.dir  = dir;
  port.dataset.type = p.t;
  return port;
}

/* Connection-legality matrix. Predicate is consulted at wire completion
 * (pointerup over an input port) — incompatible drops are rejected and
 * the destination port flashes red.
 *
 * Current rule set:
 *   - audio / param / gate / clock are all "signal" types — sample-rate
 *     or control-rate floats, structurally interchangeable. The codegen
 *     handles whatever lands where (Schmitt-trigger codegen for *->gate,
 *     raw 0/1 float for clock, etc.). Same-type and cross-signal pairs
 *     all allowed.
 *   - Visual port types (texture / transform / mesh — Phase 6.1.6)
 *     are NOT signal types. They live in VISUAL_PORT_TYPES and only
 *     accept SAME-TYPE connections (texture→texture, mesh→mesh, etc.)
 *     because there's no general way to coerce a 4×4 transform into a
 *     GPU texture or a per-sample float. Bridge nodes will be the
 *     conversion path:
 *       EnvFollow → Uniform   (audio   → texture-sample-able uniform)
 *       FFTBins   → Uniform[N]
 *       Clock     → Uniform   (clock   → uniform)
 *     Those bridge nodes ship in 6.5 (audio reactivity bridge).
 *
 * Today the predicate is permissive within signal types and strict
 * within visual types — it's the single place that says "yes" or
 * "no" for connection legality. */
const SIGNAL_PORT_TYPES = new Set(["audio", "param", "gate", "clock"]);
// Sprint 7.5.3a -- camera is a new visual-side port type alongside
// mesh + texture. Same strict-same-type rule applies. Cameras carry
// view + projection matrices to a Scene sink.
const VISUAL_PORT_TYPES = new Set(["texture", "transform", "mesh", "camera", "light", "environment"]);
function portsCompatible(srcType, dstType) {
  if (srcType === dstType) return true;
  if (SIGNAL_PORT_TYPES.has(srcType) && SIGNAL_PORT_TYPES.has(dstType)) return true;
  // Visual types are STRICTLY same-type; the early-return above
  // already handled that case. No cross-domain audio↔texture etc.
  return false;
}

/* Wire-drop snap targeting. Ports are 11 px circles; a finger covers
 * ~40-50 px, so the hit-test on e.target.closest(".port") routinely
 * misses on touch even when the user "feels" like they're over the
 * port. This finds the nearest type-compatible input port within a
 * screen-pixel radius — used both for live visual feedback during
 * the drag (.wire-snap-target glow) and as a fallback drop target
 * when pointerup's e.target lands just off-port.
 *
 * Radius defaults: mouse 16 px (gentle assist, no surprise snap),
 * pen 24 px, ANYTHING ELSE 36 px (touch, plus unknown — some
 * Chromebooks and hybrid devices don't reliably report
 * pointerType === "touch" for touchscreen contacts; the safe default
 * is to assume finger-like imprecision so those devices still get
 * usable snap behavior). Mouse is the only pointer type all browsers
 * report reliably as "mouse", so it's the right one to special-case.
 *
 * Hysteresis: once a snap is acquired, we keep it as long as the
 * finger stays within radius + 14 px of the SAME port (sticky exit).
 * Without this, the inevitable few-pixel finger drift in the last
 * pointermove before release routinely cleared a successful snap
 * just before pointerup, dropping the wire on empty canvas. */
const SNAP_HYST_PX = 14;
function _snapRadiusFor(pointerType) {
  if (pointerType === "mouse") return 16;
  if (pointerType === "pen")   return 24;
  return 36;
}
function findSnapPort(screenX, screenY, fromType, fromNode, radius) {
  const ports = document.querySelectorAll('.port[data-dir="in"]');
  let best = null, bestDist = radius;
  for (const p of ports) {
    if (p.dataset.node === fromNode) continue;
    if (!portsCompatible(fromType, p.dataset.type)) continue;
    const r = p.getBoundingClientRect();
    if (r.width === 0) continue;   // hidden / inside collapsed group
    const cx = r.left + r.width  / 2;
    const cy = r.top  + r.height / 2;
    const d = Math.hypot(cx - screenX, cy - screenY);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}
/* Decide the snap target for this pointermove. If a snap is currently
 * held, prefer keeping it as long as the finger is within the sticky
 * exit radius (radius + SNAP_HYST_PX) of THAT port — even if some
 * other port is now nearer. Only when the held snap is out of range
 * do we run a fresh search. Returns null when nothing qualifies. */
function _pickSnap(screenX, screenY, fromType, fromNode, radius) {
  if (wire && wire._snapPort) {
    const p  = wire._snapPort;
    const r  = p.getBoundingClientRect();
    if (r.width > 0 && portsCompatible(fromType, p.dataset.type) && p.dataset.node !== fromNode) {
      const cx = r.left + r.width  / 2;
      const cy = r.top  + r.height / 2;
      const d  = Math.hypot(cx - screenX, cy - screenY);
      if (d < radius + SNAP_HYST_PX) return p;
    }
  }
  return findSnapPort(screenX, screenY, fromType, fromNode, radius);
}
function _setWireSnap(snapPort) {
  if (!wire) return;
  if (wire._snapPort === snapPort) return;
  if (wire._snapPort) wire._snapPort.classList.remove("wire-snap-target");
  if (snapPort)       snapPort.classList.add("wire-snap-target");
  wire._snapPort = snapPort || null;
}
function _clearWireSnap() {
  if (wire && wire._snapPort) wire._snapPort.classList.remove("wire-snap-target");
  if (wire) wire._snapPort = null;
}

/* Briefly flash a port red to signal a rejected connection. The CSS
 * keyframe handles the visuals; we just toggle the class and clean it
 * up after the animation so a subsequent reject re-fires it. */
function flashRejectPort(portEl) {
  if (!portEl) return;
  portEl.classList.remove("reject-flash");
  // Force reflow so re-adding the class restarts the animation even if
  // the same port is rejected twice in a row.
  void portEl.offsetWidth;
  portEl.classList.add("reject-flash");
  const onEnd = () => {
    portEl.classList.remove("reject-flash");
    portEl.removeEventListener("animationend", onEnd);
  };
  portEl.addEventListener("animationend", onEnd);
}

function wirePath(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1) * 0.5 + 24;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/* Phase 6.6.20.11 — multi-target wire fan-out.
 *
 * If the user has multiple nodes selected and drops a wire onto one
 * of them, fan the connection out to every selected node that has
 * a matching input port. "Matching" = same port name + compatible
 * type. Lets the user wire 26 VisualOutputs in one drag (select all
 * 26, drop the wire on any one's input → all 26 connect).
 *
 * Returns an array of {node, port} targets. Always includes the
 * dropped port; adds extras only when the dropped port's node is
 * itself part of a multi-node selection AND the other selected
 * nodes have a same-named, type-compatible input.
 *
 * If the dropped port's node isn't in the selection, behaves
 * exactly as the legacy 1-target connect — selection is irrelevant. */
function _expandConnectionToSelection(targetNodeId, targetPortName, sourcePortType) {
  const fallback = [{ node: targetNodeId, port: targetPortName }];
  if (!selectedSet || selectedSet.size <= 1) return fallback;
  if (!selectedSet.has(targetNodeId)) return fallback;
  const out = [];
  for (const id of selectedSet) {
    const node = state.nodes.find(n => n.id === id);
    if (!node) continue;
    const def = TYPES[node.type];
    if (!def || !Array.isArray(def.ins)) continue;
    const port = def.ins.find(p => p.n === targetPortName && portsCompatible(sourcePortType, p.t));
    if (port) out.push({ node: id, port: port.n });
  }
  return out.length > 0 ? out : fallback;
}

/* Single entry point for committing a wire to one or more inputs.
 * Used by both pointerup and pointercancel handlers — there's no
 * difference between the two paths once the destination port has
 * been resolved. */
function _commitWireConnection(wire, port) {
  if (!wire || !port) return false;
  if (port.dataset.dir !== "in" || port.dataset.node === wire.fromNode) return false;
  if (!portsCompatible(wire.fromType, port.dataset.type)) {
    flashRejectPort(port);
    return false;
  }
  pushHistory("connect");
  const targets = _expandConnectionToSelection(port.dataset.node, port.dataset.port, wire.fromType);
  let added = 0;
  for (const t of targets) {
    if (t.node === wire.fromNode) continue;       // safety: don't loop back
    state.edges = state.edges.filter(ed => !(ed.to.node === t.node && ed.to.port === t.port));
    state.edges.push({
      from: { node: wire.fromNode, port: wire.fromPort },
      to:   { node: t.node, port: t.port }
    });
    added++;
  }
  if (added > 1) {
    console.log("[wire] fan-out:", added, "connections from", wire.fromNode + "." + wire.fromPort,
                "to", targets.map(t => t.node + "." + t.port).join(", "));
  }
  // Sprint 5.slider-aware -- if the source is a Slider sitting at
  // spawn defaults, snap its range/curve to a sensible preset for
  // the destination param. First target wins (deterministic) so
  // fan-out doesn't bounce between rules.
  _maybeAutoRangeSlider(wire.fromNode, targets);
  return true;
}

/* When a Slider's output gets connected, look up the destination
 * port name's heuristic and apply it IF the slider is still at
 * defaults. Skips silently otherwise -- never clobbers a user's
 * manual tuning. Run after edges are pushed so renderMonitorControls
 * picks up the new range on the next render. */
function _maybeAutoRangeSlider(srcNodeId, targets) {
  const src = state.nodes.find(n => n && n.id === srcNodeId);
  if (!src || src.type !== "Slider") return;
  if (!_sliderAtDefaults(src)) return;
  if (!Array.isArray(targets) || targets.length === 0) return;
  // Use the first target's port name (deterministic; fan-out is rare
  // and the rule's the same for all targets anyway).
  const h = paramHeuristicFor(targets[0].port);
  if (!h) return;
  if (!src.params) src.params = {};
  src.params.min   = h.min;
  src.params.max   = h.max;
  src.params.curve = h.curve;
  // Pin value into the new range -- mid-point of the curved 0..1
  // mapping so a freq slider lands on ~632 Hz, not 0 or 20000.
  const mid = sliderValueFromT(0.5, h.min, h.max, h.curve, null);
  src.params.value = mid;
  if (typeof renderMonitorControls === "function") renderMonitorControls();
}

function renderWires(temp) {
  let html = "";
  state.edges.forEach(e => {
    // Skip edges that are fully internal to a collapsed group —
    // both endpoints sit inside the same collapsed block, so the
    // wire would be a zero-length self-loop on the group's block.
    const fromG = groupOfNode(e.from.node);
    const toG   = groupOfNode(e.to.node);
    if (fromG && fromG.collapsed && toG && toG.collapsed && fromG.id === toG.id) return;
    // Phase 8.A.3 -- skip edges where EITHER endpoint sits inside
    // a PrefabInstance. Internal wires stay invisible (children
    // are hidden too). External wires that target an instance's
    // exposed port store the from/to against the INSTANCE node, not
    // the child, so they render normally.
    // Phase 8.A.5 -- same treatment for Pool voice children.
    const fromN = nodeById(e.from.node);
    const toN   = nodeById(e.to.node);
    if ((fromN && (fromN.prefabParentId || fromN.poolParentId)) ||
        (toN   && (toN.prefabParentId   || toN.poolParentId)))   return;
    const a = portPos(e.from.node, e.from.port, true);
    const b = portPos(e.to.node, e.to.port, false);
    if (!a || !b) return;
    const fromNode = nodeById(e.from.node);
    const def = defOf(fromNode);
    if (!def) return;
    const portDef = def.outs.find(p => p.n === e.from.port);
    const t = portDef ? portDef.t : "audio";
    const path = wirePath(a.x, a.y, b.x, b.y);
    if (t === "clock") {
      // Double-line look — render the same path twice, once thicker
      // in clock color and once thinner in the canvas bg, leaving two
      // parallel cyan stripes with a hairline gap. Distinct from the
      // dashed-param and solid-audio wires.
      html += `<path d="${path}" fill="none" stroke="var(--clock)" stroke-width="4" stroke-linecap="round" />`;
      html += `<path d="${path}" fill="none" stroke="var(--bg)"    stroke-width="1.5" stroke-linecap="round" />`;
    } else if (t === "mesh") {
      // Thick amber wire — visually heavy because mesh data is
      // structurally "more" than audio per sample.
      html += `<path d="${path}" fill="none" stroke="var(--mesh)" stroke-width="3" stroke-linecap="round" />`;
    } else if (t === "camera") {
      // Sprint 7.5.3a -- Camera wire. Double-stripe in butter-yellow,
      // matches the camera-port styling. Reads distinctly from the
      // amber mesh wires + violet transform wires.
      html += `<path d="${path}" fill="none" stroke="var(--camera)" stroke-width="4" stroke-linecap="round" />`;
      html += `<path d="${path}" fill="none" stroke="var(--bg)"     stroke-width="1.5" stroke-linecap="round" />`;
    } else if (t === "light") {
      // Sprint 7.5.3c -- Light wire. Same double-stripe shape as
      // camera but in cream, signaling "scene-global uniform data".
      html += `<path d="${path}" fill="none" stroke="var(--light)" stroke-width="4" stroke-linecap="round" />`;
      html += `<path d="${path}" fill="none" stroke="var(--bg)"    stroke-width="1.5" stroke-linecap="round" />`;
    } else if (t === "environment") {
      // Sprint 7.5.4 -- Environment wire. Dashed teal, signals "sky /
      // IBL context for the scene." Visually distinct from light's
      // double-stripe and texture's short-dotted pattern.
      html += `<path d="${path}" fill="none" stroke="var(--environment)" stroke-width="3" stroke-linecap="round" stroke-dasharray="6,5" />`;
    } else if (t === "hud") {
      // §5.5.g -- HUD wire. Long-dashed hot pink, signals "overlay
      // layer that draws on top of this Scene's output."
      html += `<path d="${path}" fill="none" stroke="var(--hud)" stroke-width="3" stroke-linecap="round" stroke-dasharray="8,4" />`;
    } else if (t === "heightmap") {
      // §5.5.h -- heightmap-ref wire (TiledTerrain -> Water). Earth-tone dashed.
      html += `<path d="${path}" fill="none" stroke="var(--heightmap)" stroke-width="3" stroke-linecap="round" stroke-dasharray="6,4" />`;
    } else if (t === "transform") {
      // Double-stripe like clock but in transform-violet to keep the
      // 4×4 mat semantics visually distinct from rhythmic data.
      html += `<path d="${path}" fill="none" stroke="var(--transform)" stroke-width="4" stroke-linecap="round" />`;
      html += `<path d="${path}" fill="none" stroke="var(--bg)"        stroke-width="1.5" stroke-linecap="round" />`;
    } else if (t === "texture") {
      // Dotted cyan — short dashes in the texture color. Reads
      // distinctly from param's longer-dash pattern.
      html += `<path d="${path}" fill="none" stroke="var(--texture)" stroke-width="2" stroke-linecap="round" stroke-dasharray="2,4" />`;
    } else {
      // audio / gate / param fall here. param gets dashes; others solid.
      const color = t === "audio" ? "var(--audio)" : (t === "gate" ? "var(--gate)" : "var(--param)");
      const da = t === "param" ? ' stroke-dasharray="4,4"' : "";
      html += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"${da} />`;
    }
  });
  if (temp) {
    html += `<path d="${wirePath(temp.x1, temp.y1, temp.x2, temp.y2)}" fill="none" stroke="#888" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3,4" opacity="0.7" />`;
  }
  wireSvg.innerHTML = html;
}

/* =========================================================================
 * Properties pane
 * ======================================================================== */

/* Group props — shown when selectedGroupId is set. Layout mirrors
 * the regular node-prop pane: a head row + sections for the editable
 * fields (name, collapse), a quick member list, and an actions
 * footer (ungroup + save-as-gpatch). */
