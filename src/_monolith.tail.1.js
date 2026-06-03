

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
/* ---------- Phase 6.5 — rig props pane ---------- */
/* Shown when nothing is selected (the old "empty" placeholder slot).
 * Two sections: template picker + display list. The display list is
 * read-only in 6.5 MVP — each row shows the display's name + key
 * pose/FOV values. Per-display editing (drag yaw/pitch sliders, edit
 * FOV) lands in 6.5.15 (week 3 of the phase).
 *
 * Template change rebuilds rig.displays from RIG_TEMPLATES[key].
 * Existing VisualOutput nodes get their display index clamped to the
 * new display count if the new template has fewer displays. */
function renderRigPane() {
  const rig = state.rig || defaultRig();
  // Add a "Custom" option that's only selectable implicitly when the
  // user edits a display pose (the dropdown displays it but picking
  // it deliberately is a no-op — switching back to a real template
  // rebuilds the display list).
  const tplKeys = Object.keys(RIG_TEMPLATES);
  const isCustom = !tplKeys.includes(rig.templateKey);
  const tplOptions = tplKeys.map(k =>
    `<option value="${k}"${k === rig.templateKey ? " selected" : ""}>${escapeText(RIG_TEMPLATES[k].label)}</option>`
  ).join("") + (isCustom ? `<option value="custom" selected>Custom (edited)</option>` : "");

  const displayRows = rig.displays.map((d, i) => {
    const pose = d.pose || { yaw: 0, pitch: 0, roll: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    const eb   = d.edgeBlend || _defaultEdgeBlend();
    // Phase 6.6.4 — warp state pill. Three states cycle on click:
    //   off (no warp) → identity (mesh exists but no distortion) →
    //   test (sinusoidal bow distortion, used to verify the warp pass
    //   ships pixels). Real per-vertex editing comes in 6.6.9.
    const warpState = !d.warpMesh ? "off"
                     : (d.warpMesh._isTest      ? "test"
                     : (d.warpMesh._isAutoBlend ? "auto"
                     : (d.warpMesh._bezier && d.warpMesh._isCustom ? "bezier"
                     : (d.warpMesh._isCustom    ? "custom"
                     : (d.warpMesh._bezier      ? "bezier-id"
                     : "identity")))));
    const warpLabel = ({
      off:        "warp: off",
      identity:   "warp: identity",
      test:       "warp: test",
      auto:       "warp: auto-blend",
      custom:     "warp: custom",
      bezier:     "warp: bezier",
      "bezier-id":"warp: bezier (identity)"
    })[warpState];
    // Phase 6.6.10 — per-display edge-blend inputs. γ / lift / pow
    // sit on a sub-row below the pose/fov line, kept visually
    // distinct from the geometric controls so the calibration
    // domains don't blur together. Reset button drops back to
    // defaults (gamma 2.2, blackLift 0, power 2.0).
    const defaultEB = _defaultEdgeBlend();
    const isCustomBlend = eb.gamma     !== defaultEB.gamma     ||
                          eb.blackLift !== defaultEB.blackLift ||
                          eb.power     !== defaultEB.power;
    return `<div class="rig-display-row rig-display-row-edit" data-display-index="${i}">
      <span class="rig-display-idx">${i}</span>
      <span class="rig-display-name">${escapeText(d.name || ("Display " + (i + 1)))}</span>
      <span class="rig-edit-cluster">
        <label>yaw</label>
        <input type="number" class="rig-edit-input" data-field="pose.yaw"   value="${(+pose.yaw).toFixed(0)}" step="1" />
        <label>pitch</label>
        <input type="number" class="rig-edit-input" data-field="pose.pitch" value="${(+pose.pitch).toFixed(0)}" step="1" />
        <label>fovH</label>
        <input type="number" class="rig-edit-input" data-field="fov.h"      value="${(+fov.h).toFixed(0)}" step="1" min="1" max="360" />
        <label>fovV</label>
        <input type="number" class="rig-edit-input" data-field="fov.v"      value="${(+fov.v).toFixed(0)}" step="1" min="1" max="180" />
        <button class="rig-warp-btn rig-warp-${warpState}"
                data-display-warp-toggle="${i}"
                title="Cycle warp state (off → identity → test). Phase 6.6.4 placeholder for the warp editor.">${warpLabel}</button>
        <button class="rig-warp-edit-btn"
                data-display-warp-edit="${i}"
                title="Open the mesh warp editor — drag control points to deform the calibration.">✎ edit</button>
        <button class="rig-warp-edit-btn"
                data-display-warp-import="${i}"
                title="Import a Bourke-style warp mesh CSV (.csv) for this display. File format: header line, 'N M' grid dimensions, then N×M rows of 'x y u v intensity'.">⇪ import</button>
        <button class="rig-warp-edit-btn"
                data-display-warp-export="${i}"
                title="Export this display's warp mesh as a Bourke .csv file. Round-trips with our importer; readable by VIOSO, Resolume, blendmesher, and any tool that consumes Bourke mesh files.">⇩ export</button>
      </span>
      <span class="rig-edit-cluster rig-edit-cluster-blend${isCustomBlend ? " rig-edit-cluster-custom" : ""}" title="Edge-blend params. γ = gamma compensation; lift = black-floor lift; pow = power-curve steepness on the intensity ramp.">
        <label>γ</label>
        <input type="number" class="rig-edit-input"
               data-field="edgeBlend.gamma"
               value="${(+eb.gamma).toFixed(2)}" step="0.1" min="0.1" max="5" />
        <label>lift</label>
        <input type="number" class="rig-edit-input"
               data-field="edgeBlend.blackLift"
               value="${(+eb.blackLift).toFixed(2)}" step="0.05" min="0" max="1" />
        <label>pow</label>
        <input type="number" class="rig-edit-input"
               data-field="edgeBlend.power"
               value="${(+eb.power).toFixed(2)}" step="0.1" min="0.1" max="10" />
        <button class="rig-warp-btn rig-blend-reset-btn ${isCustomBlend ? "rig-blend-custom" : ""}"
                data-display-blend-reset="${i}"
                title="Reset blend (γ 2.2 / lift 0 / pow 2.0)"${isCustomBlend ? "" : " disabled"}>blend: ${isCustomBlend ? "custom ↺" : "default"}</button>
      </span>
    </div>`;
  }).join("");
  return `
    <div class="rig-pane">
      <div class="rig-pane-head">
        <span class="rig-pane-title">Display rig</span>
        <span class="rig-pane-sub">${rig.displays.length} display${rig.displays.length === 1 ? "" : "s"}</span>
      </div>
      <div class="rig-grid">
        <label for="rig-template-select">Template</label>
        <select id="rig-template-select">${tplOptions}</select>
        <label for="rig-preview-select">Preview</label>
        <select id="rig-preview-select">
          <option value="tile"${rig.previewMode === "tile" ? " selected" : ""}>Tiled flat</option>
          <option value="cylinder"${rig.previewMode === "cylinder" ? " selected" : ""}>Cylindrical unwrap</option>
          <option value="equirect"${rig.previewMode === "equirect" ? " selected" : ""}>Equirectangular</option>
          <option value="fisheye"${rig.previewMode === "fisheye" ? " selected" : ""}>Stereographic / fisheye</option>
          <option value="theater"${rig.previewMode === "theater" ? " selected" : ""}>Theater (3D explorable)</option>
        </select>
        <label for="rig-shader-yaw" title="Where the shader's content center lands in world yaw degrees. 0 = no shift.">Center yaw</label>
        <input type="number" id="rig-shader-yaw" class="rig-grid-input" value="${(+(rig.shaderCenterYaw || 0)).toFixed(0)}" step="1" />
        <label for="rig-shader-pitch" title="Where the shader's content center lands in world pitch degrees. 0 = no shift.">Center pitch</label>
        <input type="number" id="rig-shader-pitch" class="rig-grid-input" value="${(+(rig.shaderCenterPitch || 0)).toFixed(0)}" step="1" />
      </div>
      ${(() => {
        // Phase 6.6.14 — screen surface + sweet-spot UI. Type dropdown
        // changes which params show below; sweet-spot is always 3 inputs
        // with a "from surface" reset button.
        const surf = rig.surface || { type: "free" };
        const ss   = Array.isArray(rig.sweetSpot) ? rig.sweetSpot : [0, 0, 0];
        const surfTypeOpts = [
          ["sphere",   "Sphere"],
          ["cylinder", "Cylinder"],
          ["plane",    "Plane"],
          ["swept",    "Swept (truncated dome / partial cylinder)"],
          ["free",     "Free / Custom"]
        ].map(([k, l]) => `<option value="${k}"${surf.type === k ? " selected" : ""}>${l}</option>`).join("");
        let surfParamsHtml = "";
        if (surf.type === "sphere") {
          surfParamsHtml = `
            <label title="Sphere radius — the audience sits inside; theater camera spawns at the center.">Radius</label>
            <input type="number" id="rig-surf-radius" class="rig-grid-input" value="${(+surf.radius).toFixed(2)}" step="0.5" min="0.5" />
          `;
        } else if (surf.type === "cylinder") {
          surfParamsHtml = `
            <label title="Cylinder radius (horizontal extent of curve).">Radius</label>
            <input type="number" id="rig-surf-radius" class="rig-grid-input" value="${(+surf.radius).toFixed(2)}" step="0.5" min="0.5" />
            <label title="Cylinder length along its axis.">Length</label>
            <input type="number" id="rig-surf-length" class="rig-grid-input" value="${(+surf.length).toFixed(2)}" step="0.5" min="0.5" />
          `;
        } else if (surf.type === "plane") {
          surfParamsHtml = `
            <label title="Distance from the audience to the screen along the plane normal.">Offset</label>
            <input type="number" id="rig-surf-offset" class="rig-grid-input" value="${(+surf.offset).toFixed(2)}" step="0.5" min="0.5" />
          `;
        } else if (surf.type === "swept") {
          // Phase 6.6.20 — swept surface (Sajadi & Majumder 2012).
          // Profile is either a circular arc (pitch range) or a
          // vertical line (yMin/yMax). Path is a yaw range. Preset
          // buttons fill in sensible defaults for common shapes.
          const prof = surf.profile || { kind: "arc", radius: 5, pitchStart: -90, pitchEnd: 90 };
          const path = surf.path    || { kind: "revolution", yawStart: -180, yawEnd: 180 };
          const presetButtons = `
            <span class="rig-swept-presets">
              <button class="btn rig-swept-preset" data-swept-preset="alloSphere"    title="UCSB AlloSphere — full 360° yaw, pitch ±85°. Aligns with the 'AlloSphere (real 26-projector layout)' rig template so coverage-aware capture filters keep front/back/left/right cardinals.">AlloSphere</button>
              <button class="btn rig-swept-preset" data-swept-preset="truncatedDome160" title="Sajadi-Majumder TVCG 2012 §6 truncated dome — 30ft radius, 26ft height, 160° horizontal. Different from UCSB AlloSphere; this is the paper's test installation.">Truncated dome 160°</button>
              <button class="btn rig-swept-preset" data-swept-preset="fullSphere"    title="Full sphere of revolution: pitch -90°→90°, yaw ±180°.">Full sphere</button>
              <button class="btn rig-swept-preset" data-swept-preset="dome"          title="Top hemisphere: pitch 0°→90°, full yaw.">Dome</button>
              <button class="btn rig-swept-preset" data-swept-preset="bowl"          title="Bottom hemisphere: pitch -90°→0°, full yaw.">Bowl</button>
              <button class="btn rig-swept-preset" data-swept-preset="truncatedDome" title="Sphere with polar caps cut: pitch -15°→75°, full yaw.">Truncated dome</button>
              <button class="btn rig-swept-preset" data-swept-preset="cylinderArc"   title="180° front-facing arc of a cylinder: vertical profile, yaw ±90°.">Cylinder arc</button>
            </span>
          `;
          const profileKindOpts = [
            ["arc",      "Arc (sphere segment)"],
            ["vertical", "Vertical (cylinder segment)"]
          ].map(([k, l]) => `<option value="${k}"${prof.kind === k ? " selected" : ""}>${l}</option>`).join("");
          const profileParams = (prof.kind === "vertical")
            ? `
              <label title="Cylinder radius — distance from the +Y axis to the surface.">Radius</label>
              <input type="number" id="rig-swept-radius" class="rig-grid-input" value="${(+prof.radius).toFixed(2)}" step="0.5" min="0.5" />
              <label title="Bottom of the cylinder (Y world coordinate).">Y min</label>
              <input type="number" id="rig-swept-ymin" class="rig-grid-input" value="${(+prof.yMin).toFixed(2)}" step="0.5" />
              <label title="Top of the cylinder (Y world coordinate).">Y max</label>
              <input type="number" id="rig-swept-ymax" class="rig-grid-input" value="${(+prof.yMax).toFixed(2)}" step="0.5" />
            `
            : `
              <label title="Sphere radius (also = radius at the equator).">Radius</label>
              <input type="number" id="rig-swept-radius" class="rig-grid-input" value="${(+prof.radius).toFixed(2)}" step="0.5" min="0.5" />
              <label title="Lower pitch boundary in degrees. -90 = south pole, 0 = equator, +90 = north pole.">Pitch min</label>
              <input type="number" id="rig-swept-pitch-start" class="rig-grid-input" value="${(+prof.pitchStart).toFixed(0)}" step="5" min="-90" max="90" />
              <label title="Upper pitch boundary in degrees.">Pitch max</label>
              <input type="number" id="rig-swept-pitch-end" class="rig-grid-input" value="${(+prof.pitchEnd).toFixed(0)}" step="5" min="-90" max="90" />
            `;
          surfParamsHtml = `
            <label title="Quick presets for common swept-surface shapes. Each fills in the parameters below — refine afterward.">Preset</label>
            ${presetButtons}
            <label title="Profile shape that is swept around the +Y axis. Arc = sphere segment, Vertical = cylinder segment.">Profile</label>
            <select id="rig-swept-profile-kind">${profileKindOpts}</select>
            ${profileParams}
            <label title="Yaw start in degrees. -180 = back, 0 = front, +180 = back. Full revolution: -180 to +180.">Yaw start</label>
            <input type="number" id="rig-swept-yaw-start" class="rig-grid-input" value="${(+path.yawStart).toFixed(0)}" step="10" min="-360" max="360" />
            <label title="Yaw end in degrees. yawEnd > yawStart.">Yaw end</label>
            <input type="number" id="rig-swept-yaw-end"   class="rig-grid-input" value="${(+path.yawEnd).toFixed(0)}"   step="10" min="-360" max="360" />
          `;
        }
        const surfVisible = rig.surfaceVisible !== false;
        return `
          <div class="rig-grid rig-grid-surface">
            <label for="rig-surface-type" title="Physical screen geometry. Used by theater preview for sweet-spot, and by 6.6.14+ auto-warp for analytic geometry correction.">Screen</label>
            <select id="rig-surface-type">${surfTypeOpts}</select>
            ${surfParamsHtml}
            <label title="When ON, the rig is treated as a curved screen (auto-warp + gizmo viz active). When OFF, the rig is treated as flat monitors at the display poses (auto-warp falls through to identity, gizmo skips screen drawing). Default ON; toggle off for VJ wraparound LED-wall installs where each panel is its own monitor.">Screen on</label>
            <span class="rig-surf-toggle">
              <label class="rig-surf-toggle-label">
                <input type="checkbox" id="rig-surface-visible"${surfVisible ? " checked" : ""}>
                <span>${surfVisible ? "treating as physical screen" : "treating as monitors"}</span>
              </label>
            </span>
          </div>
          <div class="rig-grid rig-grid-sweet-spot">
            <label title="The audience-position the rig is calibrated for. Theater camera spawns here on rig change / patch load.">Sweet spot</label>
            <span class="rig-sweet-spot-inputs">
              <input type="number" id="rig-sweet-spot-x" class="rig-grid-input" value="${(+ss[0]).toFixed(2)}" step="0.1" title="X" />
              <input type="number" id="rig-sweet-spot-y" class="rig-grid-input" value="${(+ss[1]).toFixed(2)}" step="0.1" title="Y" />
              <input type="number" id="rig-sweet-spot-z" class="rig-grid-input" value="${(+ss[2]).toFixed(2)}" step="0.1" title="Z" />
              <button class="rig-sweet-spot-btn" id="btn-rig-sweet-from-surface" title="Re-derive the sweet-spot from the current screen surface (sphere center / cylinder midpoint / plane offset).">↻ from surface</button>
              <button class="rig-sweet-spot-btn" id="btn-rig-camera-reset" title="Reset the theater-mode camera to the current sweet-spot position.">⟲ camera</button>
            </span>
          </div>
        `;
      })()}
      <div class="rig-display-list">
        <div class="rig-display-list-head">
          <span>Displays (yaw / pitch / fov in degrees)</span>
          <span class="rig-display-list-actions">
            <button class="rig-auto-blend-btn" id="btn-rig-mpcdi-import"
                    title="Import an MPCDI bundle (.mpcdi or .zip) — replaces the rig with the displays defined in the manifest. Geometry (pose/fov) imports now; per-display warp PFM + alpha-map PNG import ships in 6.6.2b.">Import MPCDI…</button>
            <button class="rig-auto-blend-btn" id="btn-rig-mpcdi-export"
                    title="Export the whole rig as an MPCDI ZIP bundle — mpcdi.xml + per-display Bourke warp CSVs. Round-trips with our importer; for full external compatibility (PFM warp output) wait for 6.6.3b.">Export MPCDI…</button>
            <button class="rig-auto-blend-btn" id="btn-rig-auto-warp"
                    title="Per Raskar §3.3 — analytically derive a per-display warp mesh from the rig's screen surface + sweet-spot. ⚠ ONLY USE FOR FLAT-UV CONTENT (photographs, video, custom .gdsp shaders that don't use angular math). The built-in Checkerboard / Voronoi / NoiseShader / Plasma all already render in angular (yaw, pitch) space — they're correctly sphere-projected without warp, and adding auto-warp produces double-correction artifacts. Phase 7's video / texture nodes are the canonical use case.">Auto-warp screen</button>
            <button class="rig-auto-blend-btn" id="btn-rig-warp-reset"
                    title="Clear all displays' warp meshes in one click — useful for recovering from an accidental Auto-warp on angular shaders. Custom (hand-edited) meshes are preserved.">Reset warps</button>
            <button class="rig-auto-blend-btn" id="btn-rig-auto-blend"
                    title="Auto-generate intensity ramps so adjacent projectors blend seamlessly. Two algorithms used depending on rig: angular bands (when surface is plane / free / off — fast, works for flat tile rigs) and Raskar §4.4 screen-space alpha-blend (when surface is sphere / cylinder + visible ON — α sums to 1.0 across overlapping projectors at every screen point, correct for curved screens).">Auto-blend rig</button>
            <button class="rig-auto-blend-btn" id="btn-rig-auto-blend-hardcuts"
                    title="Hard-cut blend (no smooth ramps): each screen pixel comes from EXACTLY ONE projector — the one whose framebuffer puts that pixel furthest from its frame edge. Voronoi-style assignment in screen space. Useful for calibration debugging (you can see which projector covers what), and for installations where smooth blending isn't possible (sharp masks, hard-edge LED panels). Requires curved screen surface (sphere/cylinder/swept) with surfaceVisible ON.">Auto-blend (hard cuts)</button>
            <button class="rig-auto-blend-btn" id="btn-rig-auto-capture"
                    title="Auto-capture calibration: switch to theater preview, position camera at sweet spot, take screenshots looking in 6 cardinal directions (front / back / left / right / up / down). If a Checkerboard node is wired, cycles its mode 0..4 between snapshots (HEALPix / Lambert / Cube / Octahedral / Cosine lat-long). Downloads a ZIP bundle with the PNGs + a JSON metadata file describing the rig. Use with WireframeCalibration + Auto-blend (hard cuts) to verify projector calibration visually.">Auto-capture calibration</button>
            <button class="rig-auto-blend-btn" id="btn-rig-ai-reset"
                    title="Reset all AI calibration corrections to a clean baseline. Zeros keystoneCorners + drops bezierCorrections on every display, then re-runs Auto-warp + Auto-blend so the visible mesh matches the clean state. Pose/FOV not reverted (re-pick the rig template for that). Custom hand-edited warps preserved.">Reset AI corrections</button>
            <button class="rig-auto-blend-btn" id="btn-rig-ai-calibrate"
                    title="AI calibration v2 (iterative converge): runs up to 5 passes, capping per-pass deltas at ±0.5° per axis. Each pass captures, sends to Anthropic/Gemma vision, applies clamped corrections, recaptures. Stops when mean delta drops below 0.15° OR after 5 passes. Final modal lets you review the CUMULATIVE baseline-to-current diff and uncheck any projector you want reverted. Wire WireframeCalibration to your VisualOutputs first; AI key set in the User DSP tab → ⚙ Settings.">AI calibrate rig…</button>
          </span>
        </div>
        ${displayRows}
      </div>
      <p class="modal-note" style="margin-top: 14px;">
        Wire a shader's texture output into a VisualOutput node and pick its display index in that node's properties. Multiple VisualOutput nodes wired to the same shader render the same image SHARED across their displays. <strong>Center yaw / pitch</strong> rotate the shader's content within the rig — useful for placing a focal point (e.g. the pinwheel's center) anywhere along a 360° wraparound.
      </p>
    </div>
  `;
}

function wireRigPaneHandlers() {
  const tpl = document.getElementById("rig-template-select");
  if (tpl) {
    tpl.addEventListener("change", () => {
      applyRigTemplate(tpl.value);
    });
  }
  const pv = document.getElementById("rig-preview-select");
  if (pv) {
    pv.addEventListener("change", () => {
      pushHistory("rig-preview:" + pv.value);
      if (!state.rig) state.rig = defaultRig();
      state.rig.previewMode = pv.value;
      // Keep the visual HUD's projection pill in sync with this
      // dropdown — the two control the same state.
      if (typeof _updateProjectionPill === "function") _updateProjectionPill();
      render();
    });
  }

  // Phase 6.5.15+ — global shader-center yaw/pitch.
  const sy = document.getElementById("rig-shader-yaw");
  if (sy) {
    sy.addEventListener("input", () => {
      const v = parseFloat(sy.value);
      if (!isFinite(v)) return;
      pushHistory("rig-shader-yaw");
      if (!state.rig) state.rig = defaultRig();
      state.rig.shaderCenterYaw = v;
      render();
    });
  }
  const sp = document.getElementById("rig-shader-pitch");
  if (sp) {
    sp.addEventListener("input", () => {
      const v = parseFloat(sp.value);
      if (!isFinite(v)) return;
      pushHistory("rig-shader-pitch");
      if (!state.rig) state.rig = defaultRig();
      state.rig.shaderCenterPitch = v;
      render();
    });
  }

  // Phase 6.6.14 — screen surface type dropdown + per-type params.
  // Type change rebuilds the surface object with sensible defaults
  // for that type (and re-renders the pane so the param inputs
  // match). Param changes mutate in place + render().
  const surfType = document.getElementById("rig-surface-type");
  if (surfType) {
    surfType.addEventListener("change", () => {
      pushHistory("rig-surface-type:" + surfType.value);
      if (!state.rig) state.rig = defaultRig();
      const t = surfType.value;
      if (t === "sphere")        state.rig.surface = { type: "sphere",   radius: 5,    center: [0, 0, 0] };
      else if (t === "cylinder") state.rig.surface = { type: "cylinder", radius: 5,    axis: [0, 1, 0], length: 5, center: [0, 0, 0] };
      else if (t === "plane")    state.rig.surface = { type: "plane",    normal: [0, 0, 1], offset: 5 };
      else if (t === "swept")    state.rig.surface = _sweptSurfacePreset("alloSphere", 5);
      else                       state.rig.surface = { type: "free" };
      state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface);
      renderProps && renderProps();
      render();
    });
  }
  const surfRadius = document.getElementById("rig-surf-radius");
  if (surfRadius) {
    surfRadius.addEventListener("input", () => {
      const v = parseFloat(surfRadius.value);
      if (!isFinite(v) || v <= 0) return;
      pushHistory("rig-surface-radius");
      if (state.rig && state.rig.surface) state.rig.surface.radius = v;
      render();
    });
  }
  const surfLength = document.getElementById("rig-surf-length");
  if (surfLength) {
    surfLength.addEventListener("input", () => {
      const v = parseFloat(surfLength.value);
      if (!isFinite(v) || v <= 0) return;
      pushHistory("rig-surface-length");
      if (state.rig && state.rig.surface) state.rig.surface.length = v;
      render();
    });
  }
  const surfOffset = document.getElementById("rig-surf-offset");
  if (surfOffset) {
    surfOffset.addEventListener("input", () => {
      const v = parseFloat(surfOffset.value);
      if (!isFinite(v) || v <= 0) return;
      pushHistory("rig-surface-offset");
      if (state.rig && state.rig.surface) state.rig.surface.offset = v;
      render();
    });
  }

  // Phase 6.6.20 — swept-surface controls. Preset buttons fully
  // replace the surface object (and re-render the pane to match);
  // numeric inputs mutate in place + re-render() the visualization.
  document.querySelectorAll(".rig-swept-preset").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const name = btn.dataset.sweptPreset;
      if (!name) return;
      pushHistory("rig-swept-preset:" + name);
      if (!state.rig) state.rig = defaultRig();
      // Preserve scale across presets if the user has already set
      // a non-default radius (5).
      const curR = (state.rig.surface && state.rig.surface.profile && state.rig.surface.profile.radius) || 5;
      state.rig.surface = _sweptSurfacePreset(name, curR);
      state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface);
      renderProps && renderProps();
      render();
    });
  });
  const sweptKind = document.getElementById("rig-swept-profile-kind");
  if (sweptKind) {
    sweptKind.addEventListener("change", () => {
      pushHistory("rig-swept-profile-kind:" + sweptKind.value);
      if (!state.rig || !state.rig.surface || state.rig.surface.type !== "swept") return;
      const surf = state.rig.surface;
      const curR = (surf.profile && surf.profile.radius) || 5;
      surf.profile = (sweptKind.value === "vertical")
        ? { kind: "vertical", radius: curR, yMin: -curR * 0.5, yMax: curR * 0.5 }
        : { kind: "arc",      radius: curR, pitchStart: -90, pitchEnd: 90 };
      renderProps && renderProps();
      render();
    });
  }
  // Numeric input wiring — generic (id → mutator) table avoids 7
  // near-identical handlers.
  const sweptInputs = [
    ["rig-swept-radius",      "profile", "radius",     v => v > 0],
    ["rig-swept-ymin",        "profile", "yMin",       () => true],
    ["rig-swept-ymax",        "profile", "yMax",       () => true],
    ["rig-swept-pitch-start", "profile", "pitchStart", v => v >= -90 && v <= 90],
    ["rig-swept-pitch-end",   "profile", "pitchEnd",   v => v >= -90 && v <= 90],
    ["rig-swept-yaw-start",   "path",    "yawStart",   v => v >= -360 && v <= 360],
    ["rig-swept-yaw-end",     "path",    "yawEnd",     v => v >= -360 && v <= 360]
  ];
  for (const [id, branch, key, accept] of sweptInputs) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      if (!isFinite(v) || !accept(v)) return;
      pushHistory("rig-swept-" + key);
      if (!state.rig || !state.rig.surface || state.rig.surface.type !== "swept") return;
      if (!state.rig.surface[branch]) state.rig.surface[branch] = {};
      state.rig.surface[branch][key] = v;
      render();
    });
  }

  // Phase 6.6.14 — sweet-spot manual edit (X/Y/Z) + the two action
  // pills (re-derive from surface, reset theater camera).
  ["x", "y", "z"].forEach((axis, i) => {
    const inp = document.getElementById("rig-sweet-spot-" + axis);
    if (!inp) return;
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (!isFinite(v)) return;
      pushHistory("rig-sweet-spot");
      if (!state.rig) state.rig = defaultRig();
      if (!Array.isArray(state.rig.sweetSpot)) state.rig.sweetSpot = [0, 0, 0];
      state.rig.sweetSpot[i] = v;
      render();
    });
  });
  const fromSurfBtn = document.getElementById("btn-rig-sweet-from-surface");
  if (fromSurfBtn) {
    fromSurfBtn.addEventListener("click", () => {
      pushHistory("rig-sweet-from-surface");
      if (!state.rig) state.rig = defaultRig();
      state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface || { type: "free" });
      renderProps && renderProps();
      render();
    });
  }
  const camResetBtn = document.getElementById("btn-rig-camera-reset");
  if (camResetBtn) {
    camResetBtn.addEventListener("click", () => {
      if (Visual && Visual.theaterCam && state.rig && Array.isArray(state.rig.sweetSpot)) {
        Visual.theaterCam.pos[0] = state.rig.sweetSpot[0];
        Visual.theaterCam.pos[1] = state.rig.sweetSpot[1];
        Visual.theaterCam.pos[2] = state.rig.sweetSpot[2];
        Visual.theaterCam.yaw   = 0;
        Visual.theaterCam.pitch = 0;
      }
    });
  }

  // Phase 6.6.15 — screen-visible toggle. When ON the rig is a
  // curved screen (auto-warp + gizmo viz active). When OFF treat
  // as flat monitors (auto-warp falls through, gizmo skips surface).
  const surfVisCb = document.getElementById("rig-surface-visible");
  if (surfVisCb) {
    surfVisCb.addEventListener("change", () => {
      pushHistory("rig-surface-visible:" + surfVisCb.checked);
      if (!state.rig) state.rig = defaultRig();
      state.rig.surfaceVisible = surfVisCb.checked;
      renderProps && renderProps();
      render();
    });
  }

  // Phase 6.6.15 — Auto-warp screen button. Fires only when surface
  // is sphere/cylinder + surfaceVisible is on. Custom meshes are
  // preserved (same idiom as Auto-blend).
  //
  // Confirms before applying: auto-warp produces visible distortion
  // when applied to angular-aware shaders (Checkerboard / Voronoi /
  // NoiseShader / Plasma — anything in 6.4 polish onward) because
  // those shaders already render correctly for the sphere geometry.
  // Auto-warp is meaningful for flat-UV content — coming with the
  // Phase 7 VideoFile / Webcam / Texture nodes.
  const autoWarpBtn = document.getElementById("btn-rig-auto-warp");
  if (autoWarpBtn) {
    autoWarpBtn.addEventListener("click", () => {
      const ok = (typeof confirm === "function")
        ? confirm("Auto-warp is for FLAT-UV content (photos, video, custom shaders).\n\n" +
                  "The built-in Checkerboard, Voronoi, NoiseShader, and Plasma already render in angular space — adding auto-warp produces visible double-correction distortion.\n\n" +
                  "Apply anyway?")
        : true;
      if (!ok) return;
      const results = _applyAutoWarpToRig();
      if (results.length) {
        const applied = results.filter(r => r.applied).length;
        const skipped = results.length - applied;
        autoWarpBtn.textContent = applied + " warped";
        autoWarpBtn.disabled = true;
        setTimeout(() => {
          autoWarpBtn.textContent = "Auto-warp screen";
          autoWarpBtn.disabled = false;
        }, 900);
        console.log("[auto-warp] applied to", applied, "displays;", skipped, "skipped (custom)");
        renderProps && renderProps();
        render();
      }
    });
  }

  // Phase 6.6.15 — Reset warps button. Clears every display's
  // auto-warp / identity / test mesh in one click while preserving
  // user-edited (custom) meshes. Recovery path for accidental
  // auto-warp on angular shaders.
  const resetWarpsBtn = document.getElementById("btn-rig-warp-reset");
  if (resetWarpsBtn) {
    resetWarpsBtn.addEventListener("click", () => {
      if (!state.rig || !Array.isArray(state.rig.displays)) return;
      let cleared = 0, kept = 0;
      pushHistory("rig-warp-reset");
      state.rig.displays.forEach(d => {
        if (!d) return;
        if (d.warpMesh && d.warpMesh._isCustom) { kept++; return; }
        if (d.warpMesh) {
          d.warpMesh = null;
          if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
          cleared++;
        }
      });
      console.log("[warp-reset] cleared", cleared, "displays;", kept, "custom meshes preserved");
      renderProps && renderProps();
      render();
    });
  }

  // Phase 6.5.15 — per-display pose / fov editing. Each input has
  // data-field=pose.yaw / pose.pitch / fov.h / fov.v; the parent
  // .rig-display-row carries data-display-index. On any change,
  // patch state.rig.displays[i] and switch templateKey to a custom
  // marker so the dropdown shows we've diverged from the preset.
  // No re-render of the rig pane on every keystroke (would steal
  // focus from the input mid-edit) — just call render() to repaint
  // the visual canvas. The pane re-renders on next deselection.
  // Phase 6.6.4 — warp-state toggle on each display row.
  // Cycle: off (null) → identity → test (sin-bow) → off …
  document.querySelectorAll('[data-display-warp-toggle]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayWarpToggle, 10);
      const display = state.rig && state.rig.displays && state.rig.displays[i];
      if (!display) return;
      const cur = !display.warpMesh ? "off"
                : (display.warpMesh._isTest      ? "test"
                : (display.warpMesh._isAutoBlend ? "auto"
                : (display.warpMesh._isCustom    ? "custom"
                : "identity")));
      // Custom meshes hold the user's hand-editing work — we don't
      // want a casual pill click to silently clobber them with a test
      // bow. Confirm before discarding. User can also use the editor's
      // Reset button (less ambiguous path).
      if (cur === "custom") {
        const ok = (typeof confirm === "function")
          ? confirm("Discard your custom warp on display " + i + "?\n\nClick the ✎ edit pill instead if you want to keep editing.")
          : true;
        if (!ok) return;
      }
      pushHistory("rig-warp-toggle:" + i);
      // Cycle: off → identity → test → off. Auto-blend / custom both
      // live outside this cycle (set by other paths); clicking the pill
      // on either drops back to off cleanly.
      const next = cur === "off"      ? "identity"
                 : cur === "identity" ? "test"
                 : cur === "test"     ? "off"
                 : "off";   // auto / custom both clear to off
      if (next === "off")           display.warpMesh = null;
      else if (next === "identity") display.warpMesh = _makeIdentityWarpMesh(8, 8);
      else                          display.warpMesh = _makeTestWarpMesh(8, 8);
      // Drop the cached GPU buffers so the next frame rebuilds with
      // the new mesh dimensions / contents.
      if (Visual && Visual._warpCache) Visual._warpCache.delete(display.id);
      // Mark as customized so the template dropdown doesn't pretend
      // we're still on the preset.
      if (state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
        state.rig.templateKey = "custom";
      }
      renderProps && renderProps();
      render();
    });
  });

  document.querySelectorAll('.rig-edit-input').forEach(input => {
    input.addEventListener("input", () => {
      const row = input.closest(".rig-display-row");
      if (!row) return;
      const i = parseInt(row.dataset.displayIndex, 10);
      if (!isFinite(i)) return;
      const display = state.rig && state.rig.displays && state.rig.displays[i];
      if (!display) return;
      const v = parseFloat(input.value);
      if (!isFinite(v)) return;
      const field = input.dataset.field;
      pushHistory("rig-display-edit:" + i + ":" + field);
      if (field === "pose.yaw")   { display.pose = display.pose || {}; display.pose.yaw   = v; }
      else if (field === "pose.pitch") { display.pose = display.pose || {}; display.pose.pitch = v; }
      else if (field === "fov.h")  { display.fov  = display.fov  || {}; display.fov.h  = v; }
      else if (field === "fov.v")  { display.fov  = display.fov  || {}; display.fov.v  = v; }
      // Phase 6.6.10 — edge-blend params. Each is range-clamped:
      // gamma must be > 0 (avoid divide-by-zero in 1/g); blackLift
      // is in [0, 1] (above 1 saturates the whole image); power is
      // > 0 (controls the steepness of the symmetric ramp).
      else if (field === "edgeBlend.gamma") {
        display.edgeBlend = display.edgeBlend || _defaultEdgeBlend();
        display.edgeBlend.gamma = Math.max(0.1, Math.min(5, v));
      }
      else if (field === "edgeBlend.blackLift") {
        display.edgeBlend = display.edgeBlend || _defaultEdgeBlend();
        display.edgeBlend.blackLift = Math.max(0, Math.min(1, v));
      }
      else if (field === "edgeBlend.power") {
        display.edgeBlend = display.edgeBlend || _defaultEdgeBlend();
        display.edgeBlend.power = Math.max(0.1, Math.min(10, v));
      }
      // Mark rig as customized so the template dropdown reflects the
      // edit instead of pretending we're still on the preset.
      if (Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
        state.rig.templateKey = "custom";
      }
      render();
    });
  });

  // Phase 6.6.9 — open the mesh warp editor for a specific display.
  // Wires the editor's controls/canvas once on first call (idempotent).
  document.querySelectorAll('[data-display-warp-edit]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayWarpEdit, 10);
      if (!Number.isFinite(i)) return;
      _wireWarpEditor();
      openWarpEditor(i);
    });
  });

  // Phase 6.6.2 — per-display Bourke-CSV warp-mesh import.
  document.querySelectorAll('[data-display-warp-import]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayWarpImport, 10);
      if (!Number.isFinite(i)) return;
      importBourkeMeshForDisplay(i);
    });
  });

  // Phase 6.6.3 — per-display Bourke-CSV warp-mesh export.
  document.querySelectorAll('[data-display-warp-export]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayWarpExport, 10);
      if (!Number.isFinite(i)) return;
      exportBourkeMeshForDisplay(i);
    });
  });

  // Phase 6.6.2 — whole-rig MPCDI bundle import.
  const mpcdiBtn = document.getElementById("btn-rig-mpcdi-import");
  if (mpcdiBtn) {
    mpcdiBtn.addEventListener("click", () => {
      importMpcdiBundle();
    });
  }

  // Phase 6.6.3 — whole-rig MPCDI bundle export.
  const mpcdiExpBtn = document.getElementById("btn-rig-mpcdi-export");
  if (mpcdiExpBtn) {
    mpcdiExpBtn.addEventListener("click", () => {
      exportMpcdiBundle();
    });
  }

  // Phase 6.6.11 — global "Auto-blend rig" button. Runs overlap
  // detection across all displays + sets warpMesh to per-display
  // auto-generated intensity ramps. Re-renders so the warp pills
  // flip to "warp: auto-blend" on every affected display.
  const autoBtn = document.getElementById("btn-rig-auto-blend");
  if (autoBtn) {
    autoBtn.addEventListener("click", () => {
      const results = _applyAutoBlendToRig();
      const applied = results.filter(r => r.applied).length;
      const skipped = results.length - applied;
      autoBtn.textContent = applied + " blended";
      autoBtn.disabled = true;
      setTimeout(() => {
        autoBtn.textContent = "Auto-blend rig";
        autoBtn.disabled = false;
      }, 900);
      console.log("[auto-blend] applied to", applied, "displays;", skipped, "left as-is (no overlap)");
      renderProps && renderProps();
      render();
    });
  }

  // Phase 6.6.20.21 — Reset AI corrections button. Zeros all
  // keystoneCorners + bezierCorrections, re-bakes clean meshes.
  const aiResetBtn = document.getElementById("btn-rig-ai-reset");
  if (aiResetBtn) {
    aiResetBtn.addEventListener("click", () => {
      const cleaned = resetAICalibration();
      if (cleaned >= 0) {
        const orig = aiResetBtn.textContent;
        aiResetBtn.textContent = "Cleaned " + cleaned + " display(s)";
        aiResetBtn.disabled = true;
        setTimeout(() => {
          aiResetBtn.textContent = orig;
          aiResetBtn.disabled = false;
        }, 1500);
      }
    });
  }

  // Phase 6.6.20.10 — AI calibration button. Captures per-display +
  // sends to AI provider + diff modal + apply.
  const aiCalibBtn = document.getElementById("btn-rig-ai-calibrate");
  if (aiCalibBtn) {
    aiCalibBtn.addEventListener("click", async () => {
      if (aiCalibBtn.disabled) return;
      const orig = aiCalibBtn.textContent;
      aiCalibBtn.disabled = true;
      try {
        const result = await runAICalibrationFlow({
          onStatus: (msg) => { aiCalibBtn.textContent = msg; }
        });
        aiCalibBtn.textContent = "Applied " + result.applied + " corrections";
      } catch (e) {
        console.error("[ai-calibrate] failed:", e);
        aiCalibBtn.textContent = "Failed";
        alert("AI calibration failed:\n\n" + (e && e.message ? e.message : String(e)));
      } finally {
        setTimeout(() => {
          aiCalibBtn.textContent = orig;
          aiCalibBtn.disabled = false;
        }, 2200);
      }
    });
  }

  // Phase 6.6.20.8 — auto-capture calibration button. Walks 6
  // cardinal directions in theater mode, optionally cycles
  // Checkerboard.mode, downloads ZIP bundle of PNGs + metadata.
  const captureBtn = document.getElementById("btn-rig-auto-capture");
  if (captureBtn) {
    captureBtn.addEventListener("click", async () => {
      if (captureBtn.disabled) return;
      const origLabel = captureBtn.textContent;
      captureBtn.disabled = true;
      captureBtn.textContent = "Capturing 0/?...";
      try {
        const result = await autoCaptureCalibration({
          onProgress: (cur, total) => {
            captureBtn.textContent = "Capturing " + cur + "/" + total + "...";
          }
        });
        captureBtn.textContent = "Saved (" + result.captured + ")";
      } catch (e) {
        console.error("[auto-capture] failed:", e);
        captureBtn.textContent = "Failed";
        alert("Auto-capture failed:\n\n" + (e && e.message ? e.message : String(e)));
      } finally {
        setTimeout(() => {
          captureBtn.textContent = origLabel;
          captureBtn.disabled = false;
        }, 1800);
      }
    });
  }

  // Phase 6.6.20.6 — hard-cuts variant. Each screen pixel goes to
  // exactly one projector. Same dispatch as smooth blend but flags
  // the path with hardCuts:true.
  const autoHardBtn = document.getElementById("btn-rig-auto-blend-hardcuts");
  if (autoHardBtn) {
    autoHardBtn.addEventListener("click", () => {
      const results = _applyAutoBlendToRig({ hardCuts: true });
      const applied = results.filter(r => r.applied).length;
      const skipped = results.length - applied;
      autoHardBtn.textContent = applied + " hard-cut";
      autoHardBtn.disabled = true;
      setTimeout(() => {
        autoHardBtn.textContent = "Auto-blend (hard cuts)";
        autoHardBtn.disabled = false;
      }, 900);
      console.log("[auto-blend hardcuts] applied to", applied, "displays;", skipped, "skipped");
      renderProps && renderProps();
      render();
    });
  }

  // Phase 6.6.10 — edge-blend reset button. Drops the display's
  // edgeBlend back to defaults (gamma 2.2, blackLift 0, power 2.0)
  // and re-renders the row so the disabled state on the button
  // reflects the now-pristine values.
  document.querySelectorAll('[data-display-blend-reset]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayBlendReset, 10);
      const display = state.rig && state.rig.displays && state.rig.displays[i];
      if (!display) return;
      pushHistory("rig-blend-reset:" + i);
      display.edgeBlend = _defaultEdgeBlend();
      if (Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
        state.rig.templateKey = "custom";
      }
      renderProps && renderProps();
      render();
    });
  });
}

function renderGroupProps(g) {
  const dot = `background: var(--accent); --prop-dot: var(--accent);`;
  const memberRows = (g.members || []).map(id => {
    const n = nodeById(id);
    if (!n) return "";
    const def = defOf(n);
    const colour = def ? def.color : "var(--text-3)";
    return `<div class="group-member-row">
      <span class="group-member-dot" style="background:${colour}"></span>
      <span class="group-member-type">${escapeText(n.type)}</span>
      <span class="group-member-id">${n.id}</span>
    </div>`;
  }).join("");
  const ports = computeGroupPorts(g);
  const portsHtml = (ports.inputs.length || ports.outputs.length)
    ? `<div class="prop-section">Cross-boundary ports</div>
       <div class="prop-inline" style="opacity:0.75;">
         ${ports.inputs.length} in / ${ports.outputs.length} out — these stub up on the collapsed block so you can wire to/from the group as a whole.
       </div>`
    : "";
  return `
    <div class="prop-head">
      <span class="dot" style="${dot}"></span>
      <span style="font-family: var(--font-instr); letter-spacing: 0.12em;">${g.collapsed ? "⊟" : "▾"} GROUP</span>
      <span class="id">${g.id}</span>
      <span class="desc">${g.collapsed ? "collapsed — double-click block or press E to expand" : "expanded — drag header to move all members"}</span>
    </div>
    <div class="prop-section">Name</div>
    <div class="prop-grid" style="grid-template-columns: 1fr;">
      <input type="text" id="group-name-input" value="${escapeAttr(g.name)}" style="background: var(--surface-2); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 3px; font-family: var(--font-mono); font-size: 12px;" />
    </div>
    <div class="prop-section">View</div>
    <div class="prop-grid" style="grid-template-columns: 1fr 1fr;">
      <button class="btn" id="group-collapse-btn">${g.collapsed ? "Expand (E)" : "Collapse (E)"}</button>
      <button class="btn" id="group-ungroup-btn">Ungroup (Ctrl+Shift+G)</button>
    </div>
    <div class="prop-section">Members · ${(g.members||[]).length} nodes</div>
    <div class="group-member-list">${memberRows}</div>
    ${portsHtml}
    <div class="prop-section">Export</div>
    <div class="prop-grid" style="grid-template-columns: 1fr;">
      <button class="btn primary" id="group-save-gpatch-btn">Save group as .gpatch</button>
      <p class="prop-inline" style="opacity:0.55; font-size:10px;">Writes a standalone .gpatch containing only this group's member nodes + their internal edges. Cross-boundary edges become exposed setters / unconnected ports on the saved patch.</p>
    </div>
  `;
}
function wireGroupPropsHandlers(g) {
  const nameInp = document.getElementById("group-name-input");
  if (nameInp) {
    nameInp.addEventListener("change", () => renameGroup(g.id, nameInp.value));
    nameInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { renameGroup(g.id, nameInp.value); nameInp.blur(); }
    });
  }
  const cbtn = document.getElementById("group-collapse-btn");
  if (cbtn) cbtn.addEventListener("click", () => toggleGroupCollapse(g.id));
  const ubtn = document.getElementById("group-ungroup-btn");
  if (ubtn) ubtn.addEventListener("click", () => ungroupSelection());
  const sbtn = document.getElementById("group-save-gpatch-btn");
  if (sbtn) sbtn.addEventListener("click", () => saveGroupAsGpatch(g));
}

/* Export a group as a standalone .gpatch file. The output contains:
 *   • Only the group's member nodes (positions translated to start
 *     near the origin so the loaded patch isn't off-screen).
 *   • Only the edges that are fully internal to the group (cross-
 *     boundary edges become dangling endpoints — the user wires
 *     them up after importing into another patch).
 *   • A patchName derived from the group name (sanitized to be a
 *     valid C++ identifier so codegen produces a clean class).
 *   • Exposed-setter entries that survive the cut (only those that
 *     reference member nodes). */
function saveGroupAsGpatch(g) {
  if (!g) return;
  const memberSet = new Set(g.members);
  const memberNodes = (g.members || []).map(id => nodeById(id)).filter(Boolean);
  if (!memberNodes.length) { alert("Group has no members — nothing to save."); return; }
  // Translate to origin so the saved patch loads at a sane location.
  let minX = Infinity, minY = Infinity;
  memberNodes.forEach(n => { if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y; });
  const dx = isFinite(minX) ? Math.max(0, minX - 60) : 0;
  const dy = isFinite(minY) ? Math.max(0, minY - 60) : 0;
  const nodes = memberNodes.map(n => ({
    ...JSON.parse(JSON.stringify(n)),  // deep copy so we don't mutate live state
    x: n.x - dx,
    y: n.y - dy
  }));
  // Internal edges only — drop cross-boundary connections.
  const edges = state.edges
    .filter(e => memberSet.has(e.from.node) && memberSet.has(e.to.node))
    .map(e => JSON.parse(JSON.stringify(e)));
  // Restrict exposed-setter map to entries that reference member nodes.
  const exposed = {};
  Object.keys(state.exposed || {}).forEach(k => {
    const id = k.split(".")[0];
    if (memberSet.has(id)) exposed[k] = state.exposed[k];
  });
  const className = (g.name || "Group").replace(/[^A-Za-z0-9_]/g, "_");
  const filename = (g.name || "group").replace(/[^A-Za-z0-9_-]/g, "_") + ".gpatch";
  const out = {
    version: 2,
    patchName: className || "Group",
    nodes, edges, exposed,
    groups: [],   // empty — the group itself becomes the new patch
    filename
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderProps() {
  // Group selection takes precedence — when the user has a group
  // entity selected (clicked the header / collapsed block), the
  // props pane shows group-specific UI: rename, expand/collapse,
  // member list, save-as-.gpatch.
  if (selectedGroupId) {
    const g = groupById(selectedGroupId);
    if (g) {
      empty.style.display = "none";
      propsEl.innerHTML = renderGroupProps(g);
      wireGroupPropsHandlers(g);
      return;
    }
    selectedGroupId = null;  // stale id — fall through to node path
  }
  if (!selected) {
    // Phase 6.5 — when nothing is selected, the props pane shows the
    // RIG editor instead of being empty. Lets users tune their
    // distributed-display layout without first having to create a
    // dummy node to select.
    empty.style.display = "none";
    propsEl.innerHTML = renderRigPane();
    wireRigPaneHandlers();
    return;
  }
  const node = nodeById(selected);
  if (!node) { empty.style.display = "block"; propsEl.innerHTML = ""; return; }
  empty.style.display = "none";
  const def = defOf(node);
  if (!def) {
    propsEl.innerHTML =
      `<div class="prop-head"><span class="dot" style="background:var(--danger);--prop-dot:var(--danger)"></span>` +
      `⚠ ${escapeText(node.type)}<span class="id">${node.id}</span></div>` +
      `<div class="prop-inline">Unknown node type. This usually means a User DSP class was deleted, or the patch was authored against a registry that this build doesn't have. Delete this node or re-register the type.</div>`;
    return;
  }
  const dotStyle = `background:${def.color};--prop-dot:${def.color}`;
  // Phase 8.D.1 -- if a UI/HUD node has customRender code defined,
  // show a small badge in the header so users see it without opening
  // the modal.
  let customBadge = "";
  if (node.params && typeof node.params.customRender === "string" && node.params.customRender.trim()) {
    customBadge = `<span class="prop-render-badge" title="customRender JS code is set -- press E or click the ✎ handle to edit">render code &middot; <code>E</code></span>`;
  }
  let html = `<div class="prop-head"><span class="dot" style="${dotStyle}"></span>${node.type}<span class="id">${node.id}</span>${customBadge}<span class="desc">${escapeText(def.description || "")}</span></div>`;
  // Phase 8.A.2-ui -- Stage assignment. Every node can be tagged
  // into a named stage; nodes without a tag are "_global" (always
  // active). Datalist autocompletes from any StageManager's stages
  // list so users don't have to remember exact names.
  {
    const knownStages = new Set();
    for (const n of state.nodes) {
      if (n && n.type === "StageManager" && n.params && typeof n.params.stages === "string") {
        for (const s of n.params.stages.split(",")) {
          const t = s.trim();
          if (t) knownStages.add(t);
        }
      }
    }
    const stageVal = (typeof node.stage === "string") ? node.stage : "";
    // Compute active status for the dot color.
    let dotColor, dotTitle;
    if (!stageVal) {
      dotColor = "#67c8ff";
      dotTitle = "Untagged -- always active (persists across stage changes)";
    } else {
      const phase = (Visual && Visual.lifecyclePhases) ? Visual.lifecyclePhases[stageVal] : null;
      if (phase === "running" || phase === "awoken") {
        dotColor = "#67ff80";
        dotTitle = "Stage '" + stageVal + "' is ACTIVE (phase=" + phase + ")";
      } else if (phase === "dormant" || phase === "destroying" || phase === "uninitialized") {
        dotColor = "#ff8c50";
        dotTitle = "Stage '" + stageVal + "' is INACTIVE (phase=" + phase + ") -- this node won't tick or render";
      } else {
        dotColor = "#888";
        dotTitle = "Stage '" + stageVal + "' is unknown (no StageManager references it). Treated as INACTIVE.";
      }
    }
    const datalistId = "prop-stages-" + node.id;
    const datalistOpts = Array.from(knownStages).map(s =>
      `<option value="${escapeAttr(s)}"></option>`).join("");
    html += `<div class="prop-stage-row">` +
      `<span class="stage-dot" style="background:${dotColor};" title="${escapeAttr(dotTitle)}"></span>` +
      `<label class="k">stage</label>` +
      `<input type="text" id="prop-stage-input" value="${escapeAttr(stageVal)}" placeholder="(blank = global)" list="${datalistId}" autocomplete="off" />` +
      `<datalist id="${datalistId}">${datalistOpts}</datalist>` +
      `</div>`;
  }
  const keys = Object.keys(node.params);
  const gateIns = def.ins.filter(p => p.t === "gate");

  if (!keys.length && !gateIns.length) {
    html += `<div class="prop-inline">This node has no parameters or triggers — it just passes signal through.</div>`;
  } else {
    if (keys.length) {
      html += `<div class="prop-section">Parameters</div>`;
      html += `<div class="prop-grid">`;
      const uiOnly = def.uiOnlyParams || [];
      keys.forEach(k => {
        // Phase 8.D.1 -- customRender is edited exclusively via the
        // node-edit modal (E key or ✎ handle), so we skip it in the
        // props grid. A badge in the prop-head signals when it's set.
        if (k === "customRender") return;
        const ex = !!state.exposed[node.id + "." + k];
        const enumOpts = def.paramOptions && def.paramOptions[k];
        const isUiOnly = uiOnly.includes(k);
        const isString = typeof node.params[k] === "string";
        // Enum params can't be exposed as runtime float setters — they
        // take a distinct C++ symbol type and are construction-only.
        // ui-only params (Slider min/max, Button label) are not C++ at all.
        const exposable = !!def.cppType && !enumOpts && !isUiOnly && !isString;
        let inputHtml;
        // Phase 6.5 — VisualOutput.display: dynamic dropdown sourced
        // from the live rig.displays list. Updates whenever the user
        // swaps templates or edits the display list. Treated like an
        // enum but the option list is fetched from state.rig instead
        // of the static def.paramOptions.
        const isRigDisplayDropdown = node.type === "VisualOutput" && k === "display";
        if (isRigDisplayDropdown) {
          const displays = (state.rig && state.rig.displays) || [];
          const opts = displays.map((d, i) => {
            const sel = (node.params[k] | 0) === i ? " selected" : "";
            return `<option value="${i}"${sel}>${i}: ${escapeText(d.name || ("Display " + (i + 1)))}</option>`;
          }).join("");
          const placeholder = displays.length === 0
            ? `<option value="0" selected>(no displays — pick a template in rig pane)</option>`
            : "";
          inputHtml = `<select class="enum-select" data-key="${escapeAttr(k)}" data-rig-display="1">${placeholder}${opts}</select>`;
        } else if (enumOpts) {
          const opts = enumOpts.map(o => {
            const sel = node.params[k] === o ? " selected" : "";
            return `<option value="${escapeAttr(o)}"${sel}>${escapeText(o)}</option>`;
          }).join("");
          // For nodes with a "custom" curve / shape option, attach a
          // small ≈ button that opens the ramp/curve modal directly
          // (so the user doesn't have to first pick "custom" + then
          // hunt for the editor — one click and they're drawing).
          const hasCustom = enumOpts.indexOf("custom") >= 0;
          const editBtn = hasCustom
            ? `<button class="ramp-edit-btn" data-ramp-edit="${escapeAttr(k)}" title="Open curve editor">≈</button>`
            : "";
          inputHtml = `<span class="enum-select-wrap"><select class="enum-select" data-key="${escapeAttr(k)}">${opts}</select>${editBtn}</span>`;
        } else if (isString) {
          inputHtml = `<input type="text" value="${escapeAttr(String(node.params[k]))}" data-key="${escapeAttr(k)}" data-string="1" />`;
        } else {
          // HUDText.value et al use NaN as a "use static text" sentinel.
          // type="number" can't bind to NaN -- it logs a "specified value
          // 'NaN' cannot be parsed" warning. Render NaN as empty + a
          // NaN placeholder so the input still communicates the state.
          const vRaw = node.params[k];
          const vAttr = Number.isFinite(vRaw) ? vRaw : "";
          const phAttr = Number.isFinite(vRaw) ? "" : ` placeholder="NaN"`;
          inputHtml = `<input type="number" step="any" value="${vAttr}"${phAttr} data-key="${escapeAttr(k)}" />`;
        }
        const trailing = isRigDisplayDropdown
          ? `<span class="prop-inline">rig display index</span>`
          : exposable
            ? `<label class="expose" title="When checked, the generated class exposes a ${k}(float) setter."><input type="checkbox" data-expose="${escapeAttr(k)}" ${ex?"checked":""} /> expose</label>`
            : enumOpts
              ? `<span class="prop-inline">construction-time</span>`
              : isUiOnly
                ? `<span class="prop-inline">UI only</span>`
                : `<span class="prop-inline">inlined at compile</span>`;
        html += `
          <label class="k">${escapeText(k)}</label>
          ${inputHtml}
          ${trailing}
        `;
      });
      html += `</div>`;
    }
    if (gateIns.length) {
      html += `<div class="prop-section">Triggers</div>`;
      html += `<div class="prop-grid">`;
      gateIns.forEach(p => {
        const ex = !!state.exposed[node.id + "." + p.n];
        const meth = (def.gateMethods && def.gateMethods[p.n]) || "reset";
        const setterName = p.n === "trig" ? "trigger()" : p.n + "()";
        html += `
          <label class="k">${escapeText(p.n)}</label>
          <span class="gate-tag">${escapeText(meth)}()</span>
          <label class="expose" title="When checked, the generated class exposes ${setterName}."><input type="checkbox" data-expose="${escapeAttr(p.n)}" ${ex?"checked":""} /> expose ${escapeText(setterName)}</label>
        `;
      });
      html += `</div>`;
    }
    // Piano-roll: a single button that opens the editor modal.
    // Notes live in node.params.notes; the modal handles all the
    // drawing / saving.
    if (def.kind === "pianoRoll") {
      const noteCount = (Array.isArray(node.params.notes) ? node.params.notes.length : 0);
      const len = (typeof node.params.patternLen === "number") ? node.params.patternLen : 16;
      html += `<div class="prop-section">Pattern</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-pianoroll" style="width: 100%;">Edit piano roll · ${noteCount} note${noteCount===1?"":"s"} · ${len} steps</button>
      </div>`;
    }
    // Multi-track piano roll uses the same modal with track tabs in
    // the toolbar (gated on def.kind === "multiPianoRoll" inside the
    // modal). Notes carry an extra `track` field.
    if (def.kind === "multiPianoRoll") {
      const notes = Array.isArray(node.params.notes) ? node.params.notes : [];
      const counts = [0, 0, 0, 0];
      notes.forEach(n => { if (n && n.track >= 0 && n.track < 4) counts[n.track]++; });
      html += `<div class="prop-section">Pattern · 4 tracks</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-pianoroll" style="width: 100%;">Edit multi-track · ${counts[0]}·${counts[1]}·${counts[2]}·${counts[3]} notes</button>
      </div>`;
    }
    // Matrix-mixer: 8×8 grid of clickable cells. Each cell holds a
    // gain value 0..1 (drag vertically for finer; click toggles). The
    // value also drives the cell's fill intensity for at-a-glance
    // routing legibility.
    // WavetableOsc with shape="custom" gets an "Edit waveform" button
    // that opens the drawable single-cycle editor. Other shape values
    // are algorithmic so they don't need a UI.
    if (def.kind === "wavetable" && node.params && node.params.shape === "custom") {
      const tbl = Array.isArray(node.params.table) ? node.params.table : null;
      const len = tbl ? tbl.length : 0;
      html += `<div class="prop-section">Custom waveform</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-wavetable" style="width: 100%;">Edit waveform${len ? ` · ${len} samples` : ""}</button>
      </div>`;
    }
    // AutomationLane / MultiAutomationLane: open the drawable
    // automation modal. Single-lane has one curveTable; multi-lane
    // has node.params.lanes[] (4 entries). Button label shows a
    // quick stat line so the user sees what they've configured.
    if (def.kind === "autoLane") {
      const tbl = Array.isArray(node.params && node.params.curveTable) ? node.params.curveTable : null;
      const len = tbl ? tbl.length : 0;
      const bars = (typeof node.params.bars === "number") ? node.params.bars : 4;
      const bpm = (typeof node.params.bpm === "number") ? node.params.bpm : 120;
      const looping = node.params && node.params.loop ? "loop" : "one-shot";
      html += `<div class="prop-section">Automation curve</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-autolane" style="width: 100%;">Edit lane${len ? ` · ${bars} bars · ${bpm} BPM · ${looping}` : ""}</button>
      </div>`;
    }
    if (def.kind === "multiAutoLane") {
      const lanes = Array.isArray(node.params && node.params.lanes) ? node.params.lanes : [];
      const bars = (typeof node.params.bars === "number") ? node.params.bars : 4;
      const bpm = (typeof node.params.bpm === "number") ? node.params.bpm : 120;
      const looping = node.params && node.params.loop ? "loop" : "one-shot";
      const filledLanes = lanes.filter(l => l && Array.isArray(l.curveTable) && l.curveTable.length).length;
      html += `<div class="prop-section">Automation lanes · 4 tracks</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-autolane" style="width: 100%;">Edit lanes${filledLanes ? ` · ${filledLanes}/4 drawn · ${bars} bars · ${bpm} BPM · ${looping}` : ""}</button>
      </div>`;
    }
    // EnvDraw: drawable ADSR with movable sustain marker. The button
    // shows a quick stat (current sustain index + attack/release
    // times) so the user knows what they've set without opening it.
    if (def.kind === "envDraw") {
      const tbl = Array.isArray(node.params && node.params.curveTable) ? node.params.curveTable : null;
      const sIdx = (node.params && typeof node.params.sustainIdx === "number") ? node.params.sustainIdx : 32;
      const len = tbl ? tbl.length : 0;
      const aT = (node.params && typeof node.params.attack === "number") ? node.params.attack.toFixed(2) : "0.50";
      const rT = (node.params && typeof node.params.release === "number") ? node.params.release.toFixed(2) : "0.50";
      html += `<div class="prop-section">Envelope shape</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-envdraw" style="width: 100%;">Edit envelope${len ? ` · sustain ${sIdx}/${len-1} · A ${aT}s · R ${rT}s` : ""}</button>
      </div>`;
    }
    // v0.3.29 — ColorCurves: 4-channel paint-drawable LUT editor.
    // Summary line shows which channels have been touched (not identity).
    if (node.type === "ColorCurves") {
      const N = 64;
      const isIdentity = (arr) => {
        if (!Array.isArray(arr) || arr.length !== N) return true;
        for (let i = 0; i < N; i++) {
          if (Math.abs(arr[i] - i / (N - 1)) > 0.002) return false;
        }
        return true;
      };
      const labels = ["M", "R", "G", "B"];
      const keys   = ["curveMaster", "curveR", "curveG", "curveB"];
      const touched = keys.map((k, i) => isIdentity(node.params && node.params[k]) ? null : labels[i]).filter(Boolean);
      const summary = touched.length ? "edited: " + touched.join(" · ") : "identity (no grade)";
      html += `<div class="prop-section">Color curves</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-colorcurves" style="width: 100%;">Edit curves… · ${summary}</button>
      </div>`;
    }
    // WavetableScan: button opens the 3D stacked-frames modal. Custom-
    // frame count is shown so the user knows whether they've overridden
    // any of the algorithmic bank's defaults.
    if (def.kind === "wavetableScan") {
      const cf = (node.params && node.params.customFrames && typeof node.params.customFrames === "object") ? node.params.customFrames : {};
      const overrides = Object.keys(cf).length;
      html += `<div class="prop-section">Wavetable bank · 512 frames</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-wavescan" style="width: 100%;">Edit wavetable bank${overrides ? ` · ${overrides} custom frame${overrides === 1 ? "" : "s"}` : ""}</button>
      </div>`;
    }
    // Sample-host nodes (SamplePlayer / StereoSamplePlayer / Granular):
    // file-drop button, current-asset readout, "Load" + "Clear" buttons.
    // Files are decoded via decodeAudioData and stored in editor.assets;
    // node.params.assetId references the loaded record.
    if (def.kind === "sampleHost") {
      const a = getAsset(node.params && node.params.assetId);
      html += `<div class="prop-section">Sample asset</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">`;
      if (a) {
        const ch = a.channels >= 2 ? "stereo" : "mono";
        const samp = Array.isArray(a.data) ? a.data[0].length : a.data.length;
        const tooBig = samp > ASSET_EMBED_LIMIT;
        const sizeNote = tooBig
          ? `<span class="asset-warn" title="Too large to embed in codegen — fine for live preview but exporting will need runtime sample loading">stem-sized · v2 export</span>`
          : ``;
        html += `<div class="asset-card">
          <div class="asset-card-head">
            <span class="asset-card-name" title="${escapeAttr(a.name)}">${escapeText(a.name)}</span>
            ${sizeNote}
          </div>
          <div class="asset-card-meta">${a.durationSec.toFixed(2)} s · ${a.sampleRate} Hz · ${ch} · ${samp.toLocaleString()} samples</div>
          <div class="asset-card-row">
            <button class="btn pr-btn pr-btn-primary" data-asset-action="open">EDIT WAVEFORM</button>
            <button class="btn pr-btn" data-asset-action="load">REPLACE…</button>
            <button class="btn pr-btn" data-asset-action="clear">CLEAR</button>
          </div>
        </div>`;
      } else {
        html += `<button class="btn primary" data-asset-action="open" style="width: 100%;">Open sample editor</button>`;
        html += `<p class="prop-inline">Drag a .wav / .mp3 / .ogg / .flac into the editor — or click the button above and drop in there. Files persist to IndexedDB. Up to ~5s embeds in codegen; longer stems need runtime loading on export.</p>`;
      }
      html += `</div>`;
    }
    // MicInput: permission button + status line. Live preview wires
    // the MediaStream into the AudioWorklet automatically when Play
    // is clicked on a patch containing MicInput; clicking Enable here
    // pre-grants the permission so there's no first-tick delay.
    if (def.kind === "micInput") {
      const granted = !!_micStream;
      const statusLine = granted
        ? `Granted ✓ · ${escapeText(_micDeviceLabel || "default device")}`
        : `Not yet enabled — click ▶ Play to auto-prompt, or grant ahead of time below.`;
      const selectedDevice = (node.params && node.params.inputSourceId) || "";
      // Build a device dropdown from the previously-enumerated list.
      // The list itself is populated lazily on first mic grant (see
      // ensureMicConnected); until then we just show "default device".
      let deviceOptions = `<option value="">default device</option>`;
      if (Array.isArray(_micDeviceList) && _micDeviceList.length) {
        _micDeviceList.forEach(d => {
          const sel = (d.deviceId === selectedDevice) ? " selected" : "";
          deviceOptions += `<option value="${escapeAttr(d.deviceId)}"${sel}>${escapeText(d.label || ("device " + d.deviceId.slice(0, 8)))}</option>`;
        });
      }
      html += `<div class="prop-section">Microphone</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-enable-mic" style="width: 100%;">${granted ? "Re-check device" : "Enable microphone"}</button>
        <p class="prop-inline" id="mic-status-${node.id}">${statusLine}</p>
        <label class="prop-inline" style="display:flex; gap:8px; align-items:center;">
          <span style="opacity:0.7; min-width: 80px;">Input source</span>
          <select id="mic-source-${node.id}" style="flex:1; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); padding: 4px 6px; border-radius: 3px;">${deviceOptions}</select>
        </label>
        <p class="prop-inline" style="opacity: 0.55; font-size: 10px;">Picks a specific input device on multi-mic systems. Takes effect on next ▶ Play. The device list populates after the first permission grant — click "Enable microphone" once to populate.</p>
      </div>`;
    }
    // VoiceTrigger / KeywordSpotter: trigger-word recording UI.
    // Captures 1.5-second mic snippets into node.params.triggerSamples.
    // Storage is in-memory + serialized into the .gpatch JSON.
    // VoiceTrigger uses energy gate at runtime; KeywordSpotter
    // additionally runs JS-side amplitude-envelope template
    // matching against the recordings (computed at preview start).
    if (def.kind === "voiceTrigger" || def.kind === "keywordSpotter") {
      const isSpotter = def.kind === "keywordSpotter";
      const recs = Array.isArray(node.params && node.params.triggerSamples) ? node.params.triggerSamples : [];
      html += `<div class="prop-section">Trigger word recordings</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">`;
      if (recs.length) {
        html += `<div class="vt-rec-list" style="display:flex; flex-direction:column; gap:4px;">`;
        recs.forEach((r, i) => {
          html += `<div class="vt-rec-row" style="display:grid; grid-template-columns: 22px 1fr auto auto; gap:8px; align-items:center; padding:4px 8px; background:var(--surface-2); border:1px solid var(--border); border-radius:3px;">
            <span style="text-align:center; color:var(--text-3); font-family:var(--font-mono); font-size:10px;">${i + 1}</span>
            <span style="font-family:var(--font-mono); font-size:11px; color:var(--text);">${escapeText(r.name || "rec_" + (i+1))}</span>
            <span style="font-family:var(--font-mono); font-size:9.5px; color:var(--text-3);">${(r.durationSec || 0).toFixed(2)} s</span>
            <button class="btn" data-vt-del="${i}" title="Delete this recording" style="padding: 2px 8px; font-size: 10px;">×</button>
          </div>`;
        });
        html += `</div>`;
      } else {
        html += `<p class="prop-inline" style="opacity: 0.6; font-style: italic;">No recordings yet. Record 3–5 takes of the trigger word for best detection.</p>`;
      }
      html += `<button class="btn primary" id="btn-vt-record" style="width:100%;">⏺ Record trigger word (1.5 s)</button>`;
      // KeywordSpotter-only: detect-mode dropdown + match-threshold
      // slider + live status pill.
      if (isSpotter) {
        const mt = (typeof node.params.matchThreshold === "number") ? node.params.matchThreshold : 0.85;
        const mode = (typeof node.params.detectMode === "string") ? node.params.detectMode : "envelope";
        html += `<label class="prop-inline" style="display:flex; gap:8px; align-items:center; margin-top: 4px;">
          <span style="opacity:0.7; min-width: 110px;">Detect mode</span>
          <select id="ks-mode-${node.id}" style="flex:1; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); padding: 4px 6px; border-radius: 3px; font-family: var(--font-mono); font-size: 11px;">
            <option value="envelope"${mode === "envelope" ? " selected" : ""}>envelope · fast, no model</option>
            <option value="whisper"${mode === "whisper" ? " selected" : ""}>whisper · phoneme-aware (~75 MB)</option>
            <option value="hybrid"${mode === "hybrid" ? " selected" : ""}>hybrid · envelope + whisper confirm</option>
          </select>
        </label>`;
        html += `<label class="prop-inline" style="display:flex; gap:8px; align-items:center; margin-top: 4px;">
          <span style="opacity:0.7; min-width: 110px;">Match threshold</span>
          <input type="range" id="ks-thresh-${node.id}" min="0.5" max="0.99" step="0.01" value="${mt}" style="flex:1;" />
          <span id="ks-thresh-val-${node.id}" style="font-family:var(--font-mono); font-size:11px; color:var(--phosphor); width:42px; text-align:right;">${mt.toFixed(2)}</span>
        </label>`;
        html += `<p class="prop-inline" style="opacity: 0.55; font-size: 10px; margin-top: 2px;">In <strong>envelope</strong> mode: cosine similarity of 16-point amplitude-envelope fingerprints (loudness-invariant; can't distinguish phonemes). In <strong>whisper</strong> mode: Whisper-tiny transcribes the live audio and the threshold becomes a fuzzy-string match score (1.0 = template fully contained in transcript). <strong>Hybrid</strong> uses envelope for the fast path and whisper as a confirm/cancel filter — best of both at the cost of model download.</p>`;
        const liveStatusId = `ks-status-${node.id}`;
        html += `<p class="prop-inline" id="${liveStatusId}" style="font-family:var(--font-mono); font-size:10px; color:var(--text-3); margin-top: 4px;">Detector: ${recs.length ? `${recs.length} template${recs.length===1?"":"s"} loaded · ` : ""}${(typeof previewState !== "undefined" && previewState.state === "playing") ? "running" : "idle (start preview to enable)"}</p>`;
      } else {
        html += `<p class="prop-inline" style="opacity: 0.55; font-size: 10px;">Recordings are stored per-node and saved with the .gpatch. Today's runtime fires .trig from the energy gate above. For ML keyword detection, swap this node for a <strong>KeywordSpotter</strong> — same recording UI plus live envelope-matching against the templates while preview is playing.</p>`;
      }
      html += `</div>`;
    }
    if (def.kind === "patchMatrix") {
      if (!Array.isArray(node.params.matrix) || node.params.matrix.length !== 8) {
        node.params.matrix = Array.from({ length: 8 }, () => new Array(8).fill(0));
      }
      const m = node.params.matrix;
      // Count active routes for the section label
      let active = 0;
      m.forEach(row => row.forEach(v => { if (v > 0) active++; }));
      html += `<div class="prop-section">Matrix · ${active} active route${active === 1 ? "" : "s"}</div>`;
      html += `<div class="patch-matrix-wrap">`;
      // Header row: in1..in8 across the top
      html += `<div class="pm-corner">in ↓ / out →</div>`;
      for (let j = 0; j < 8; j++) {
        html += `<div class="pm-col-head">o${j + 1}</div>`;
      }
      for (let i = 0; i < 8; i++) {
        html += `<div class="pm-row-head">i${i + 1}</div>`;
        for (let j = 0; j < 8; j++) {
          const g = Number(m[i][j]) || 0;
          const lvl = Math.max(0, Math.min(1, Math.abs(g)));
          const cls = "pm-cell" + (g > 0 ? " on" : (g < 0 ? " inv" : ""));
          html += `<div class="${cls}" data-i="${i}" data-j="${j}" style="--lvl: ${lvl.toFixed(3)}" title="i${i+1} → o${j+1} · gain ${g.toFixed(2)}"></div>`;
        }
      }
      html += `</div>`;
      html += `<p class="prop-inline">Click toggles 0 ↔ 1. Vertical drag adjusts gain (0..1). Shift-click inverts (-1).</p>`;
    }
    // Step-grid UI for sequencer nodes — N small clickable cells
    // mirroring node.params.steps (boolean array). Click to toggle.
    if (def.kind === "stepSeq") {
      const N = def.stepCount || 16;
      if (!Array.isArray(node.params.steps) || node.params.steps.length !== N) {
        node.params.steps = new Array(N).fill(false);
      }
      const steps = node.params.steps;
      html += `<div class="prop-section">Pattern · ${N} steps</div>`;
      html += `<div class="step-grid step-grid-${N}">`;
      for (let i = 0; i < N; i++) {
        const on = !!steps[i];
        html += `<button class="step-cell${on ? ' on' : ''}" data-step="${i}" title="step ${i+1}">${i+1}</button>`;
      }
      html += `</div>`;
    }
  }
  // v0.3.11 — VideoFile pick-file button. Renders inline in the
  // props panel; clicking opens an OS file picker; selection makes
  // a blob URL + assigns to params.fileUrl. The text input above
  // (the standard string-param renderer) still works for pasting
  // http(s) URLs directly.
  if (node.type === "VideoFile") {
    const curUrl = (node.params && node.params.fileUrl) || "";
    const summary = curUrl
      ? (curUrl.startsWith("blob:")
          ? "Local file loaded (blob URL — session-only)"
          : "URL: " + escapeText(curUrl.length > 60 ? curUrl.slice(0, 57) + "…" : curUrl))
      : "No file picked yet. Click below to browse or paste a URL above.";
    const paused = !!(node.params && node.params.paused);
    const rate = (node.params && typeof node.params.playbackRate === "number")
      ? node.params.playbackRate : 1.0;
    html += `<div class="prop-section">Video source</div>
             <div class="prop-inline" style="margin-bottom:8px;color:var(--text-2);font-size:11px;">${summary}</div>
             <button class="btn primary" id="btn-videofile-pick" style="width:100%;">📁 Pick video file…</button>`;
    // v0.3.15 — transport controls. Direct buttons that manipulate
    // the underlying HTMLVideoElement via _videoSources.get(node.id).
    // params.paused + params.playbackRate persist with the patch so
    // a saved-then-reopened patch resumes in the user's chosen state.
    html += `<div class="prop-section" style="margin-top:14px;">Transport</div>
             <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:6px;">
               <button class="btn" id="btn-videofile-stop"    title="Stop &amp; rewind to 0">⏮</button>
               <button class="btn" id="btn-videofile-back"    title="Skip back 5 s">⏪</button>
               <button class="btn primary" id="btn-videofile-playpause" title="Play / Pause (space)">${paused ? "▶" : "⏸"}</button>
               <button class="btn" id="btn-videofile-forward" title="Skip forward 5 s">⏩</button>
               <button class="btn" id="btn-videofile-end"     title="Jump to end">⏭</button>
             </div>
             <div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-family:var(--font-mono);font-size:11px;color:var(--text-2);">
               <span style="min-width:48px;">rate ${rate.toFixed(2)}×</span>
               <input id="videofile-rate" type="range" min="0.10" max="4.00" step="0.05" value="${rate}" style="flex:1;" />
             </div>
             <div style="display:flex;gap:4px;margin-top:6px;">
               <button class="btn" data-vf-rate="0.25" title="0.25×" style="flex:1;font-size:10px;">¼×</button>
               <button class="btn" data-vf-rate="0.5"  title="0.5×"  style="flex:1;font-size:10px;">½×</button>
               <button class="btn" data-vf-rate="1.0"  title="1×"    style="flex:1;font-size:10px;">1×</button>
               <button class="btn" data-vf-rate="2.0"  title="2×"    style="flex:1;font-size:10px;">2×</button>
               <button class="btn" data-vf-rate="4.0"  title="4×"    style="flex:1;font-size:10px;">4×</button>
             </div>`;
    // v0.3.19 — audio section. Two paths:
    //   1. No audio wires from this node → direct playback (MES →
    //      GainNode → ctx.destination). audioEnabled gates, volume
    //      scales. Until the user hits ▶ Play, audio plays via the
    //      videoEl directly (no Web Audio context yet).
    //   2. Audio wires exist → patch is the audio path. Direct
    //      playback muted; outL/outR feed the wire-routed processing.
    //      audioEnabled/volume become moot for direct, but volume is
    //      preserved for when the user removes the wire.
    const audioOn = !node.params || node.params.audioEnabled !== 0;
    const vol = (node.params && typeof node.params.volume === "number")
      ? node.params.volume : 1.0;
    const hasAudioWire = (typeof state !== "undefined" && state &&
      Array.isArray(state.edges) && state.edges.some(e =>
        e && e.from && e.from.node === node.id &&
        (e.from.port === "outL" || e.from.port === "outR")));
    const statusHint = hasAudioWire
      ? `<span style="font-weight:normal;font-size:10px;color:var(--accent-2,#a07cff);opacity:0.95;">(patch-routed via outL/outR — direct playback muted)</span>`
      : `<span style="font-weight:normal;font-size:10px;color:var(--text-2);opacity:0.7;">(direct to speakers — wire outL/outR to route through patch)</span>`;
    html += `<div class="prop-section" style="margin-top:14px;">Audio ${statusHint}
             </div>
             <div style="display:flex;align-items:center;gap:8px;">
               <button class="btn ${audioOn ? "primary" : ""}" id="btn-videofile-mute"
                       title="Toggle direct audio playback (ignored when patch-routed)" style="min-width:48px;"
                       ${hasAudioWire ? "disabled" : ""}>${audioOn ? "🔊 on" : "🔇 off"}</button>
               <input id="videofile-volume" type="range" min="0" max="1" step="0.01" value="${vol}"
                      style="flex:1;" ${(audioOn && !hasAudioWire) ? "" : "disabled"} />
               <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-2);min-width:32px;text-align:right;">${Math.round(vol * 100)}%</span>
             </div>
             <div style="margin-top:6px;font-size:10px;color:var(--text-2);opacity:0.6;line-height:1.4;">
               Wire MasterClock.bar/.beat → <code>trig</code> to retrigger the clip from 0 on every pulse.
               outL/outR carry the file's stereo audio (sample-accurate, ~3 ms quantum) — pipe through any Gamma audio node.
             </div>`;
  }
  // v0.3.22 — ScreenShare props panel. Mirrors the VideoFile pattern
  // (pick button + status line + audio toggle) but with a "Stop"
  // button replacing transport controls (live stream -- no scrubbing).
  // The pick button is the user gesture that lets getDisplayMedia()
  // open the source picker; we can't auto-init from the render loop.
  if (node.type === "ScreenShare") {
    const entry = _videoSources.get(node.id);
    const isActive = !!(entry && entry.videoEl && entry.ready);
    const audioTracks = isActive && entry.stream ? entry.stream.getAudioTracks().length : 0;
    const summary = isActive
      ? `Sharing ${entry.videoEl.videoWidth || "?"}×${entry.videoEl.videoHeight || "?"}` +
        (audioTracks ? " (with system audio)" : " (video only — re-pick + check 'Share audio' in the dialog for sound)")
      : "Not sharing. Click below to pick a screen / window / browser tab.";
    const audioOn = !node.params || node.params.audioEnabled !== 0;
    const hasAudioWire = (typeof state !== "undefined" && state &&
      Array.isArray(state.edges) && state.edges.some(e =>
        e && e.from && e.from.node === node.id &&
        (e.from.port === "outL" || e.from.port === "outR")));
    html += `<div class="prop-section">Screen source</div>
             <div class="prop-inline" style="margin-bottom:8px;color:var(--text-2);font-size:11px;">${escapeText(summary)}</div>
             <button class="btn primary" id="btn-screenshare-pick" style="width:100%;">${isActive ? "🔄 Re-pick source…" : "📺 Pick screen / window / tab…"}</button>`;
    if (isActive) {
      html += `<button class="btn" id="btn-screenshare-stop" style="width:100%;margin-top:6px;">⏹ Stop sharing</button>`;
    }
    html += `<div class="prop-section" style="margin-top:14px;">Audio
               ${hasAudioWire
                 ? `<span style="font-weight:normal;font-size:10px;color:var(--accent-2,#a07cff);opacity:0.95;">(patch-routed via outL/outR)</span>`
                 : `<span style="font-weight:normal;font-size:10px;color:var(--text-2);opacity:0.7;">(request system audio; wire outL/outR to route through patch)</span>`}
             </div>
             <div style="display:flex;align-items:center;gap:8px;">
               <button class="btn ${audioOn ? "primary" : ""}" id="btn-screenshare-audio"
                       title="Request system audio on the next 'Pick source' (browser may still refuse for full-screen shares)" style="min-width:48px;">${audioOn ? "🔊 request" : "🔇 video only"}</button>
               <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-2);flex:1;line-height:1.3;">
                 ${audioTracks > 0 ? "✓ audio track live" : (isActive ? "no audio in current share" : "next pick will request system audio")}
               </span>
             </div>
             <div style="margin-top:6px;font-size:10px;color:var(--text-2);opacity:0.6;line-height:1.4;">
               Chrome / Edge on Windows show a "Share audio" checkbox when sharing a <em>tab</em> or <em>window</em>. Full-screen shares typically can't capture audio. Toggling the request flag mid-share has no effect — re-pick to apply.
             </div>`;
  }
  propsEl.innerHTML = html;

  // Phase 8.A.2-ui -- stage input. Blur or Enter commits; trims
  // whitespace; empty value clears the tag (back to _global).
  const stageInput = propsEl.querySelector("#prop-stage-input");
  if (stageInput) {
    const commitStage = () => {
      const raw = stageInput.value;
      const trimmed = (typeof raw === "string") ? raw.trim() : "";
      const current = (typeof node.stage === "string") ? node.stage : "";
      if (trimmed === current) return;
      pushHistory("stage:" + node.id + "->" + (trimmed || "_global"));
      if (trimmed) node.stage = trimmed;
      else delete node.stage;
      // Re-render the canvas (mesh filtering may have shifted) +
      // re-render props so the active-status dot updates.
      if (typeof render === "function") render();
      renderProps();
    };
    stageInput.addEventListener("blur", commitStage);
    stageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); stageInput.blur(); }
      else if (e.key === "Escape") { stageInput.value = (typeof node.stage === "string") ? node.stage : ""; stageInput.blur(); }
    });
  }

  // v0.3.15 — VideoFile transport-button wiring. Direct manipulation
  // of the underlying HTMLVideoElement (via _videoSources lookup).
  // params.paused / params.playbackRate persist in the patch; the
  // currentTime nudges are transient (browser tracks them).
  if (node.type === "VideoFile") {
    const getVideoEl = () => {
      const src = _videoSources.get(node.id);
      return src && src.videoEl;
    };
    const applyPaused = (paused) => {
      if (!node.params) node.params = {};
      node.params.paused = paused ? 1 : 0;
      const v = getVideoEl();
      if (v) { if (paused) { try { v.pause(); } catch (_) {} } else { try { v.play(); } catch (_) {} } }
      // Re-render to flip the ▶/⏸ button glyph + persist.
      renderProps();
    };
    const applyRate = (rate) => {
      rate = Math.max(0.10, Math.min(4.0, Number(rate) || 1.0));
      if (!node.params) node.params = {};
      node.params.playbackRate = rate;
      const v = getVideoEl();
      if (v) { try { v.playbackRate = rate; } catch (_) {} }
      renderProps();
    };
    const ppBtn   = propsEl.querySelector('#btn-videofile-playpause');
    const stopBtn = propsEl.querySelector('#btn-videofile-stop');
    const backBtn = propsEl.querySelector('#btn-videofile-back');
    const fwdBtn  = propsEl.querySelector('#btn-videofile-forward');
    const endBtn  = propsEl.querySelector('#btn-videofile-end');
    const rateSlider = propsEl.querySelector('#videofile-rate');
    if (ppBtn) ppBtn.addEventListener('click', () => {
      applyPaused(!(node.params && node.params.paused));
    });
    if (stopBtn) stopBtn.addEventListener('click', () => {
      const v = getVideoEl();
      if (v) { try { v.currentTime = 0; } catch (_) {} }
      applyPaused(true);
    });
    if (backBtn) backBtn.addEventListener('click', () => {
      const v = getVideoEl();
      if (v) { try { v.currentTime = Math.max(0, (v.currentTime || 0) - 5); } catch (_) {} }
    });
    if (fwdBtn) fwdBtn.addEventListener('click', () => {
      const v = getVideoEl();
      if (v) {
        try { v.currentTime = Math.min(v.duration || Infinity, (v.currentTime || 0) + 5); } catch (_) {}
      }
    });
    if (endBtn) endBtn.addEventListener('click', () => {
      const v = getVideoEl();
      if (v && Number.isFinite(v.duration)) {
        // Subtract a tiny epsilon so loop kicks in cleanly instead of
        // sticking at exactly duration.
        try { v.currentTime = Math.max(0, v.duration - 0.05); } catch (_) {}
      }
    });
    if (rateSlider) rateSlider.addEventListener('input', () => {
      applyRate(rateSlider.value);
    });
    propsEl.querySelectorAll('[data-vf-rate]').forEach(b => {
      b.addEventListener('click', () => {
        applyRate(b.getAttribute('data-vf-rate'));
      });
    });
    // v0.3.16 — audio toggle + volume slider wiring.
    // v0.3.19 — when the patch is playing AND a MediaElementSource
    // has been created (via ensureVideoAudioConnected), audio plays
    // through Web Audio (MES → GainNode → ctx.destination). We
    // update the GainNode via _updateVideoAudioGains. Fall back to
    // direct videoEl.muted/volume when MES doesn't exist yet (no
    // audioCtx — patch hasn't been played).
    const applyMute = (audioOn) => {
      if (!node.params) node.params = {};
      node.params.audioEnabled = audioOn ? 1 : 0;
      const src = _videoSources.get(node.id);
      if (src && src._mediaSource && typeof _updateVideoAudioGains === "function") {
        _updateVideoAudioGains();
      } else {
        const v = getVideoEl();
        if (v) { try { v.muted = !audioOn; } catch (_) {} }
      }
      renderProps();
    };
    const applyVolume = (vol) => {
      vol = Math.max(0, Math.min(1, Number(vol) || 0));
      if (!node.params) node.params = {};
      node.params.volume = vol;
      const src = _videoSources.get(node.id);
      if (src && src._mediaSource && typeof _updateVideoAudioGains === "function") {
        _updateVideoAudioGains();
      } else {
        const v = getVideoEl();
        if (v) { try { v.volume = vol; } catch (_) {} }
      }
      // No renderProps() here -- the slider drag would lose focus on
      // every input event. The displayed % only refreshes when the
      // user releases the slider (via 'change' event below).
    };
    const muteBtn = propsEl.querySelector('#btn-videofile-mute');
    const volSlider = propsEl.querySelector('#videofile-volume');
    if (muteBtn) muteBtn.addEventListener('click', () => {
      const audioOn = !(node.params && node.params.audioEnabled !== 0);
      applyMute(audioOn);
    });
    if (volSlider) {
      volSlider.addEventListener('input', () => applyVolume(volSlider.value));
      volSlider.addEventListener('change', () => renderProps());
    }
  }

  // VideoFile pick-button wiring.
  const pickBtn = propsEl.querySelector('#btn-videofile-pick');
  if (pickBtn && node.type === "VideoFile") {
    pickBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        // Revoke any previous blob URL so we don't leak.
        const oldUrl = node.params && node.params.fileUrl;
        if (oldUrl && oldUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(oldUrl); } catch (_) {}
        }
        const url = URL.createObjectURL(file);
        if (!node.params) node.params = {};
        node.params.fileUrl = url;
        // Re-render props to reflect the new URL summary + nudge the
        // render loop to re-init the VideoFile node with the new src.
        pushHistory("videofile-pick:" + node.id);
        _disposeVideoSource(node.id);
        renderProps();
        render();
      });
      input.click();
    });
  }

  // v0.3.22 — ScreenShare button wiring. The pick handler is the
  // user-gesture frame that getDisplayMedia() requires; the stop
  // handler tears down the stream without rebuilding. Audio-request
  // toggle just flips the param for the NEXT pick (you can't change
  // the audio constraint on an active stream).
  if (node.type === "ScreenShare") {
    const ssPick = propsEl.querySelector('#btn-screenshare-pick');
    if (ssPick) ssPick.addEventListener('click', async () => {
      _disposeVideoSource(node.id);
      try {
        await _ensureScreenShareStream(node.id);
      } catch (e) {
        console.warn("[screenshare] pick failed:", e);
      }
      pushHistory("screenshare-pick:" + node.id);
      renderProps();
      render();
    });
    const ssStop = propsEl.querySelector('#btn-screenshare-stop');
    if (ssStop) ssStop.addEventListener('click', () => {
      _disposeVideoSource(node.id);
      pushHistory("screenshare-stop:" + node.id);
      renderProps();
      render();
    });
    const ssAudio = propsEl.querySelector('#btn-screenshare-audio');
    if (ssAudio) ssAudio.addEventListener('click', () => {
      if (!node.params) node.params = {};
      node.params.audioEnabled = (node.params.audioEnabled === 0) ? 1 : 0;
      renderProps();
    });
  }

  // Wire the "Edit piano roll" button (PianoRoll AND MultiPianoRoll
  // both use #btn-open-pianoroll → the modal detects which one via
  // the node's def.kind and shows track tabs accordingly).
  const openPianoRollBtn = propsEl.querySelector('#btn-open-pianoroll');
  if (openPianoRollBtn) openPianoRollBtn.addEventListener('click', () => openPianoRollModal(node.id));

  // Wavetable editors — `Edit waveform` opens the single-cycle drawing
  // modal; `Edit wavetable bank` opens the 3D 512-frame view (which
  // can in turn drill into the same single-cycle modal for per-frame
  // editing).
  const openWtBtn = propsEl.querySelector('#btn-open-wavetable');
  if (openWtBtn) openWtBtn.addEventListener('click', () => openWavetableEditModal({ nodeId: node.id, mode: "single" }));
  const openWsBtn = propsEl.querySelector('#btn-open-wavescan');
  if (openWsBtn) openWsBtn.addEventListener('click', () => openWavescanModal(node.id));
  // EnvDraw — drawable ADSR modal.
  const openEnvBtn = propsEl.querySelector('#btn-open-envdraw');
  if (openEnvBtn) openEnvBtn.addEventListener('click', () => openEnvDrawModal(node.id));
  // AutomationLane / MultiAutomationLane — drawable automation modal.
  const openAutoLaneBtn = propsEl.querySelector('#btn-open-autolane');
  if (openAutoLaneBtn) openAutoLaneBtn.addEventListener('click', () => openAutoLaneModal(node.id));
  // v0.3.28 — ColorCurves: per-channel 16-point LUT editor.
  const openCcBtn = propsEl.querySelector('#btn-open-colorcurves');
  if (openCcBtn) openCcBtn.addEventListener('click', () => openColorCurvesModal(node.id));

  // Sample-host action buttons — load opens a file picker, open
  // launches the waveform editor modal, clear detaches the asset
  // (does NOT delete the asset record from IDB so other nodes
  // referencing it still work).
  propsEl.querySelectorAll('[data-asset-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.assetAction;
      if (action === "open") {
        openSampleModal(node.id);
        return;
      }
      if (action === "clear") {
        pushHistory("asset:clear:" + node.id);
        node.params.assetId = "";
        renderProps(); renderCode(); renderJson();
        return;
      }
      // "load" — file picker → decode → store → attach
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a";
      inp.addEventListener("change", async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        btn.textContent = "DECODING…";
        try {
          const rec = await loadAudioFileToAsset(f);
          pushHistory("asset:load:" + node.id);
          node.params.assetId = rec.id;
          renderProps(); renderCode(); renderJson();
        } catch (e) {
          alert("Audio decode failed: " + (e && e.message || e));
          renderProps();
        }
      });
      inp.click();
    });
  });

  // Mic enable — request permission + hold the MediaStream so the
  // worklet (when v2 lands) can pick it up. Stream is reused across
  // multiple MicInput nodes — only one grant per session.
  const enableMicBtn = propsEl.querySelector('#btn-enable-mic');
  if (enableMicBtn) enableMicBtn.addEventListener('click', async () => {
    if (_micStream) {
      // Already granted — re-enumerate the device list (browsers
      // only return labels once the user has granted permission).
      await refreshMicDeviceList();
      renderProps();
      return;
    }
    try {
      enableMicBtn.textContent = "REQUESTING…";
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _micStream = stream;
      const tracks = stream.getAudioTracks();
      _micDeviceLabel = tracks.length ? tracks[0].label : "default";
      await refreshMicDeviceList();
      renderProps();
    } catch (err) {
      enableMicBtn.textContent = "Enable microphone";
      alert("Microphone access denied: " + (err && err.message || err));
    }
  });
  // Per-node device-source dropdown (MicInput). Stores deviceId on
  // the node; takes effect on next ▶ Play (we don't hot-swap the
  // active stream — that'd require re-creating the worklet source).
  const micSrcSel = propsEl.querySelector('#mic-source-' + node.id);
  if (micSrcSel) micSrcSel.addEventListener('change', () => {
    pushHistory("mic-source:" + node.id);
    if (!node.params) node.params = {};
    node.params.inputSourceId = micSrcSel.value || "";
  });
  // VoiceTrigger / KeywordSpotter record button + delete buttons.
  const vtRecBtn = propsEl.querySelector('#btn-vt-record');
  if (vtRecBtn) vtRecBtn.addEventListener('click', () => recordVoiceTriggerSample(node));
  propsEl.querySelectorAll('[data-vt-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.vtDel, 10);
      if (!Array.isArray(node.params.triggerSamples)) return;
      pushHistory("vt-del:" + node.id);
      node.params.triggerSamples.splice(idx, 1);
      // If the spotter is currently running, refresh its templates
      // so the deleted recording stops being a match candidate.
      if (typeof refreshKeywordSpotterTemplates === "function") refreshKeywordSpotterTemplates(node.id);
      renderProps(); renderJson();
    });
  });
  // KeywordSpotter match-threshold slider — live update.
  const ksThresh = propsEl.querySelector('#ks-thresh-' + node.id);
  const ksThreshVal = propsEl.querySelector('#ks-thresh-val-' + node.id);
  if (ksThresh) {
    ksThresh.addEventListener('input', () => {
      const v = parseFloat(ksThresh.value);
      if (!isFinite(v)) return;
      node.params.matchThreshold = v;
      if (ksThreshVal) ksThreshVal.textContent = v.toFixed(2);
      // Live update — no pushHistory on input (would spam the
      // undo stack on every drag tick); commit on change instead.
      if (typeof refreshKeywordSpotterTemplates === "function") refreshKeywordSpotterTemplates(node.id);
    });
    ksThresh.addEventListener('change', () => {
      pushHistory("ks-thresh:" + node.id);
    });
  }
  // KeywordSpotter detect-mode dropdown — switching modes tears
  // down the running detector and re-sets up so whisper templates
  // get transcribed on the way in (or skipped on the way out).
  const ksMode = propsEl.querySelector('#ks-mode-' + node.id);
  if (ksMode) {
    ksMode.addEventListener('change', () => {
      pushHistory("ks-mode:" + node.id);
      node.params.detectMode = ksMode.value;
      // Restart the detector if it was running so the mode change
      // takes effect immediately (without a full preview-stop/start).
      if (typeof teardownKeywordSpotter === "function") teardownKeywordSpotter(node.id);
      if (typeof setupKeywordSpotter === "function" &&
          typeof previewState !== "undefined" && previewState.state === "playing") {
        setupKeywordSpotter(node);
      }
      renderJson();
    });
  }

  // PatchMatrix cell interaction. Click toggles 0↔1; shift-click sets
  // -1 (inversion); vertical drag inside the cell adjusts gain
  // continuously. State lives in node.params.matrix[i][j].
  propsEl.querySelectorAll('.pm-cell').forEach(cell => {
    const i = parseInt(cell.dataset.i, 10);
    const j = parseInt(cell.dataset.j, 10);
    const startDrag = (ev) => {
      ev.preventDefault();
      if (!Array.isArray(node.params.matrix)) {
        node.params.matrix = Array.from({ length: 8 }, () => new Array(8).fill(0));
      }
      const startY = ev.clientY;
      const startG = Number(node.params.matrix[i][j]) || 0;
      let dragged = false;
      pushHistory("pm:" + node.id + ":" + i + ":" + j);
      const onMove = (mev) => {
        const dy = startY - mev.clientY;
        if (Math.abs(dy) < 3 && !dragged) return;
        dragged = true;
        // 80px = full 0..1 range. Past 80px keeps growing up to ~1.5
        // so users can boost; clamp at +/- 2 for safety.
        const span = 80;
        const sign = ev.shiftKey ? -1 : 1;
        const v = Math.max(-2, Math.min(2, startG + sign * dy / span));
        node.params.matrix[i][j] = v;
        cell.style.setProperty("--lvl", Math.max(0, Math.min(1, Math.abs(v))).toFixed(3));
        cell.classList.toggle("on",  v > 0);
        cell.classList.toggle("inv", v < 0);
        cell.title = `i${i+1} → o${j+1} · gain ${v.toFixed(2)}`;
      };
      const onUp = (uev) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        if (!dragged) {
          // Plain click — toggle 0 ↔ 1, or shift-click for inverted -1.
          const cur = Number(node.params.matrix[i][j]) || 0;
          const sign = ev.shiftKey ? -1 : 1;
          node.params.matrix[i][j] = cur === 0 ? sign : 0;
        }
        const v = Number(node.params.matrix[i][j]) || 0;
        cell.style.setProperty("--lvl", Math.max(0, Math.min(1, Math.abs(v))).toFixed(3));
        cell.classList.toggle("on",  v > 0);
        cell.classList.toggle("inv", v < 0);
        cell.title = `i${i+1} → o${j+1} · gain ${v.toFixed(2)}`;
        renderCode(); renderJson();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    };
    cell.addEventListener("pointerdown", startDrag);
  });
  // Wire step-grid clicks (after innerHTML so the buttons exist).
  propsEl.querySelectorAll('.step-cell').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.step, 10);
      if (!Array.isArray(node.params.steps)) {
        node.params.steps = new Array(def.stepCount || 16).fill(false);
      }
      pushHistory("step:" + node.id + ":" + i);
      node.params.steps[i] = !node.params.steps[i];
      btn.classList.toggle('on', node.params.steps[i]);
      renderCode(); renderJson();
    });
  });

  propsEl.querySelectorAll('input[type="number"]').forEach(inp => {
    inp.addEventListener("input", () => {
      pushHistory("param:" + node.id + ":" + inp.dataset.key);
      const v = parseFloat(inp.value);
      node.params[inp.dataset.key] = isNaN(v) ? 0 : v;
      renderCode(); renderJson();
      if (typeof renderMonitorControls === "function") renderMonitorControls();
    });
  });
  propsEl.querySelectorAll('input[type="text"][data-string="1"]').forEach(inp => {
    inp.addEventListener("input", () => {
      pushHistory("param:" + node.id + ":" + inp.dataset.key);
      node.params[inp.dataset.key] = inp.value;
      if (typeof renderMonitorControls === "function") renderMonitorControls();
    });
  });
  propsEl.querySelectorAll('select.enum-select').forEach(sel => {
    sel.addEventListener("change", () => {
      pushHistory("param:" + node.id + ":" + sel.dataset.key);
      // Phase 6.5 — rig-display selects are numeric indices, not enum
      // strings. Convert before assigning so downstream code (validation,
      // render path) gets a number consistently.
      if (sel.dataset.rigDisplay) {
        node.params[sel.dataset.key] = parseInt(sel.value, 10) | 0;
      } else {
        node.params[sel.dataset.key] = sel.value;   // string, not number
      }
      renderCode(); renderJson();
      // If the user picked "custom" on a ramp-editable enum dropdown
      // (Ramp shape, Button shape), jump straight into the drawing
      // modal — saves an extra click.
      if (sel.value === "custom") {
        if (node.type === "Ramp"   && sel.dataset.key === "shape") openRampModal("ramp",   node.id);
        if (node.type === "Button" && sel.dataset.key === "shape") openRampModal("button", node.id);
      }
    });
  });
  // Inline ≈ button next to enum dropdowns that carry a "custom" option.
  propsEl.querySelectorAll('button.ramp-edit-btn').forEach(btn => {
    btn.addEventListener("click", () => {
      const kind = node.type === "Ramp" ? "ramp"
                : node.type === "Slider" ? "slider"
                : node.type === "Button" ? "button"
                : "ramp";
      openRampModal(kind, node.id);
    });
  });
  propsEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", () => {
      pushHistory("expose:" + node.id + ":" + cb.dataset.expose);
      state.exposed[node.id + "." + cb.dataset.expose] = cb.checked;
      renderCode(); renderJson();
    });
  });
}

