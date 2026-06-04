

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

