/* =========================================================================
 * Browser — node + asset library
 *
 * Replaces the original simple palette with a tabbed browser:
 *   • Nodes  — registry entries with auto-derived tag chips, vertical
 *              category rail, operator-syntax search (cat:/tag:/port:),
 *              detail drawer with description + ports + related links.
 *   • Assets — IDB-backed sample store + connection rail for cloud
 *              sources (Local FS, Google Drive, GitHub). For now the
 *              IDB-stored audio assets always show; the cloud sources
 *              ship as a UI shell, with Local FS using the File System
 *              Access API and Drive/GitHub stubbed out for v0.1.
 *
 * The legacy renderPalette(filterText) export is kept for back-compat
 * (it's called from a handful of places after addFromPalette + after
 * gdsp registers a new user node). It now delegates to the new render
 * pipeline.
 * ======================================================================== */

/* Tag derivation. Pulled from the def shape so we don't have to add
 * tag annotations to every TYPES entry manually:
 *   • gamma     — wraps a stock gam:: class OR a pure template
 *   • composite — uses a custom helper class (cppType set, not gam::)
 *   • multi-out — outs.length > 1
 *   • host      — kind === "micInput" / "host" / "keyboard" or uses
 *                 the editor's drawable-curve param (Ramp / Slider /
 *                 Button) or has zero audio inputs (live source nodes)
 *   • user-dsp  — registered through the .gdsp parser
 *   • draw      — has a drawable curve / pattern editor modal */
const _BR_HOST_NODES = new Set([
  "KeyboardIn","Button","Slider","Ramp","MicInput","PianoRoll","MultiPianoRoll",
]);
const _BR_DRAW_NODES = new Set([
  "Ramp","Slider","Button","WavetableScan","WavetableOsc","PianoRoll","MultiPianoRoll",
]);
function brDeriveTags(name, def) {
  const tags = [];
  if (def.isUserDsp) tags.push("user-dsp");
  else if ((def.cppType || "").startsWith("gam::") || (def.cppType === "" && def.template)) tags.push("gamma");
  else if (def.cppType) tags.push("composite");
  if (def.outs && def.outs.length > 1) tags.push("multi-out");
  if (_BR_HOST_NODES.has(name) || def.kind === "micInput" || def.kind === "host") tags.push("host");
  if (_BR_DRAW_NODES.has(name)) tags.push("draw");
  if (def.category === "Sink") tags.push("sink");
  return tags;
}

/* Per-category metadata for the rail. Reference numbers + tag lines
 * are display-only; the node category strings come straight from the
 * registry data. Categories not listed here still render — they just
 * get a generic "ext" tag and a placeholder reference. */
const _BR_CAT_META = {
  Oscillator: { ref: "01", tag: "wave generators" },
  Sample:     { ref: "02", tag: "playback · mic · asset" },
  Noise:      { ref: "03", tag: "stochastic" },
  Envelope:   { ref: "04", tag: "shaping · gates" },
  Filter:     { ref: "05", tag: "spectral" },
  Delay:      { ref: "06", tag: "temporal" },
  Effect:     { ref: "07", tag: "non-linear" },
  Analysis:   { ref: "08", tag: "feature extraction" },
  Convert:    { ref: "09", tag: "scale · clock · seq · input" },
  Math:       { ref: "10", tag: "arithmetic · logic · mix" },
  // 3D scene + render
  Scene:      { ref: "20", tag: "cameras · lights · sky · output" },
  Geometry:   { ref: "21", tag: "mesh primitives" },
  Material:   { ref: "22", tag: "surfaces · shading" },
  Transform:  { ref: "23", tag: "translate · rotate · scale" },
  Terrain:    { ref: "24", tag: "terrain · planet · water" },
  // Game systems
  Physics:    { ref: "30", tag: "bodies · colliders · joints · queries" },
  Game:       { ref: "31", tag: "lifecycle · FSM · stage · gameplay" },
  UI:         { ref: "32", tag: "widgets · HUD" },
  Sprite:     { ref: "33", tag: "2D · tilemap · level" },
  // Visual FX / compositing
  Source:     { ref: "40", tag: "video · image · text" },
  Generator:  { ref: "41", tag: "procedural shaders" },
  Composite:  { ref: "42", tag: "fx · masks · keying · color" },
  // Misc
  AI:         { ref: "50", tag: "vision · ML · landmarks" },
  // Phase A.2 -- LLM + knowledge subcategories (docs/LLM-KNOWLEDGE-PHASE.md §3.A.2)
  "AI/LLM":   { ref: "51", tag: "chat · generate · model" },
  "AI/Embed": { ref: "52", tag: "vector · similarity" },
  "AI/Viz":   { ref: "53", tag: "ai overlays · maps" },
  "LLM/Build":{ ref: "60", tag: "tokenizer · embedding · attention" },
  "LLM/Train":{ ref: "61", tag: "loss · optimizer · dataset" },
  "LLM/Viz":  { ref: "62", tag: "attention 3d · loss · grad flow" },
  Notes:      { ref: "70", tag: "tektite md · corpus · query" },
  "User DSP": { ref: "98", tag: ".gdsp · community" },
  Sink:       { ref: "99", tag: "output" },
};
function _brCatMeta(cat) {
  return _BR_CAT_META[cat] || { ref: "··", tag: "ext" };
}

/* The "Visual" registry category grew to ~170 nodes — unusable as one
 * list. Rather than re-tag every TYPES entry, we route Visual nodes
 * into finer display categories by name. Non-Visual categories pass
 * through unchanged. Unmatched Visual nodes fall to "Composite"
 * (the video-FX catch-all). */
const _VISUAL_SUBCAT = {
  Scene: ["Camera","FPCamera","OrthoCamera2D","OrthoCamera25D","ThirdPersonCamera","Scene","Scene3D","Scene2D","Scene25D","RayTracedScene","VisualOutput","DirectionalLight","PointLight","SpotLight","AreaLight","Sun","DayNightCycle","ProceduralSky","HDRI","Skybox","GradientSky","RigGizmo"],
  Geometry: ["Box","Sphere","Capsule","Plane","Torus","Cylinder","Cone","DebugTriangle","MeshTest","PlanetMesh","LoadGLB"],
  Material: ["UnlitMat","PhongMat","PhysicalMat","MirrorMat","GlassMat","ShaderMat","TerrainMaterial"],
  Transform: ["Translate","Rotate","Scale","MeshWorldPosition"],
  Physics: ["PhysicsWorld2D","RigidBody2D","BoxCollider2D","CircleCollider2D","CapsuleCollider2D","Raycast2D","OverlapCircle2D","OverlapBox2D","RevoluteJoint2D","DistanceJoint2D","PrismaticJoint2D","WeldJoint2D","ContactEvent2D","TilemapCollider2D","PhysicsWorld3D","RigidBody3D","BoxCollider3D","SphereCollider3D","CapsuleCollider3D","Raycast3D","OverlapSphere3D","HingeJoint3D","BallJoint3D","FixedJoint3D","DestructibleBody3D","FractureMesh","ContactForce3D","TerrainCollider","WaterCollider","Spherecast2D","Spherecast3D","ForceField3D","Wind3D","RopeJoint3D","Rope3D","Cloth3D","ClothPin3D","SoftBody3D","PhysicsRecord","PhysicsReplay"],
  Game: ["KeyAxis2D","PlatformerBody2D","BlobController3D","PickupCollector","LevelGoal2D","AnimationState2D","OnAwake","OnStart","OnUpdate","OnDestroy","EdgeCount","StageManager","StateMachine","Pool","PrefabInstance"],
  UI: ["UIButton","UIText","UIPanel","UISlider","Leaderboard","HUDText","Minimap","Altimeter"],
  Sprite: ["TileSpriteOverlay","ParallaxLayer2D","SpriteScatter2D","Tilemap2D","Level2D","ImageURL","SpriteCreator","Sprite"],
  Terrain: ["Planet","PlanetMap","Terrain","TiledTerrain","TerrainHorizon","Water","Clouds3D","ProceduralTerrain","TerrainErosion"],
  Source: ["Text","SolidColor","Webcam","VideoFile","ScreenShare","Gradient","Checkerboard"],
  Generator: ["Plasma","Voronoi","StarNest","Butterflies","NoiseShader","MatrixRain","ShapeTunnel","GammaScreensaver","WireframeCalibration"],
};
const _VISUAL_ROUTE = (() => {
  const m = {};
  for (const sub of Object.keys(_VISUAL_SUBCAT)) {
    for (const n of _VISUAL_SUBCAT[sub]) m[n] = sub;
  }
  return m;
})();
function _deriveNodeCategory(name, def) {
  if (!def) return "Visual";
  if (def.category !== "Visual") return def.category;
  return _VISUAL_ROUTE[name] || "Composite";
}

/* View state. The browser is a thin state machine on top of the
 * existing palette DOM — when state changes we re-render. */
const brState = {
  tab: "nodes",            // nodes | assets | patches
  mode: "list",            // list | grid
  search: "",
  catFilter: null,         // null = all categories
  selected: null,          // node name or null
  assetType: null,         // null | audio | midi | video | gpatch | gdsp
  assetSource: null,       // null | source-id
};

/* Parse the search box into structured filters. Supports:
 *   plain words (any combination — must all match name+desc+cat)
 *   cat:filter — restrict to a category (substring match)
 *   tag:multi  — restrict to a tag (substring match against the tag set)
 *   port:audio — at least one port name+type contains the string
 *   new        — recent additions only (whitelist below)
 */
const _BR_NEW_NODES = new Set([
  "MasterClock","LFOClock","EuclideanRhythm","StepSeq16","StepSeq32","Arp",
  "PianoRoll","MultiPianoRoll","WavetableScan","SamplePlayer","StereoSamplePlayer",
  "GranularPlayer","PulsarSynth","LiveLooper","MicInput","VoiceTrigger",
  "Ramp","VCA","AudioBus","MasterMix","PatchMatrix","Const",
  "StateVariableFilter","MoogLadder","FMOp","KSString","WavetableOsc",
]);
function brParseSearch(text) {
  const tokens = (text || "").trim().split(/\s+/).filter(Boolean);
  const ops = { cat: [], tag: [], port: [], onlyNew: false, free: [] };
  for (const t of tokens) {
    const tl = t.toLowerCase();
    if (tl.startsWith("cat:"))       ops.cat.push(tl.slice(4));
    else if (tl.startsWith("tag:"))  ops.tag.push(tl.slice(4));
    else if (tl.startsWith("port:")) ops.port.push(tl.slice(5));
    else if (tl === "new")           ops.onlyNew = true;
    else                             ops.free.push(tl);
  }
  return ops;
}
function brNodeMatches(name, def, tags, ops) {
  if (ops.onlyNew && !_BR_NEW_NODES.has(name)) return false;
  const derivedCat = _deriveNodeCategory(name, def);
  for (const c of ops.cat)  if (!derivedCat.toLowerCase().includes(c) && !String(def.category || "").toLowerCase().includes(c)) return false;
  for (const t of ops.tag)  if (!tags.some(x => x.includes(t))) return false;
  for (const p of ops.port) {
    const hay = [...(def.ins||[]), ...(def.outs||[])].map(x => `${x.n} ${x.t}`).join(" ").toLowerCase();
    if (!hay.includes(p)) return false;
  }
  if (ops.free.length) {
    const hay = (name + " " + (def.description||"") + " " + derivedCat + " " + (def.category||"")).toLowerCase();
    for (const f of ops.free) if (!hay.includes(f)) return false;
  }
  return true;
}

function brHighlight(text, ops) {
  const primary = ops.free[0];
  if (!primary) return escapeText(text);
  const i = text.toLowerCase().indexOf(primary);
  if (i < 0) return escapeText(text);
  return escapeText(text.slice(0, i))
    + "<mark>" + escapeText(text.slice(i, i + primary.length)) + "</mark>"
    + escapeText(text.slice(i + primary.length));
}

/* ─── Vertical category rail ────────────────────────────────────── */
function brRenderRail(catsPresent) {
  const rail = document.getElementById("br-cat-rail");
  if (!rail) return;
  // Order: CATEGORY_ORDER first, then any extras present in the data.
  const seen = new Set();
  const ordered = [];
  CATEGORY_ORDER.forEach(c => { if (catsPresent.has(c)) { ordered.push(c); seen.add(c); } });
  catsPresent.forEach(c => { if (!seen.has(c)) ordered.push(c); });

  let html = `
    <div class="rail-marker">ALL</div>
    <div class="rail-item ${brState.catFilter === null ? "active" : ""}" data-cat="" title="All categories">
      <span class="rail-dot" style="color: var(--phosphor)"></span>
      <span class="rail-tip">all categories</span>
    </div>
    <div class="rail-divider"></div>
    <div class="rail-marker">CAT</div>
  `;
  ordered.forEach(cat => {
    // Pull the color from the first node in this (derived) category.
    let color = "var(--text-3)";
    for (const [nm, n] of Object.entries(TYPES)) { if (_deriveNodeCategory(nm, n) === cat) { color = n.color; break; } }
    const active = brState.catFilter === cat ? "active" : "";
    html += `
      <div class="rail-item ${active}" data-cat="${escapeAttr(cat)}">
        <span class="rail-dot" style="color: ${color}"></span>
        <span class="rail-tip">${escapeText(cat.toLowerCase())}</span>
      </div>
    `;
  });
  rail.innerHTML = html;
  rail.querySelectorAll(".rail-item").forEach(it => {
    it.addEventListener("click", () => {
      brState.catFilter = it.dataset.cat || null;
      brRenderNodes();
    });
  });
}

/* ─── Nodes list (replaces old palette body) ────────────────────── */
function brRenderNodes() {
  const ops = brParseSearch(brState.search);
  const catsPresent = new Set();
  const cats = {};
  let totalShown = 0;
  Object.entries(TYPES).forEach(([name, def]) => {
    const cat = _deriveNodeCategory(name, def);
    catsPresent.add(cat);
    if (brState.catFilter && cat !== brState.catFilter) return;
    const tags = brDeriveTags(name, def);
    if (!brNodeMatches(name, def, tags, ops)) return;
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ name, def, tags });
    totalShown++;
  });

  brRenderRail(catsPresent);

  const totalAll = Object.keys(TYPES).length;
  const filtering = !!(brState.search || brState.catFilter);

  let html = "";
  let any = false;
  // Order: CATEGORY_ORDER first, then any extras present in the data.
  const seen = new Set();
  const ordered = [];
  CATEGORY_ORDER.forEach(c => { if (cats[c]) { ordered.push(c); seen.add(c); } });
  Object.keys(cats).forEach(c => { if (!seen.has(c)) ordered.push(c); });

  ordered.forEach(cat => {
    const items = cats[cat];
    if (!items || !items.length) return;
    any = true;
    const collapsedClass = collapsedCats[cat] && !filtering ? " collapsed" : "";
    const meta = _brCatMeta(cat);
    const catColor = items[0].def.color || "var(--text-3)";
    html += `<div class="cat${collapsedClass}" data-cat="${escapeAttr(cat)}">`;
    html += `<div class="cat-header" data-toggle="${escapeAttr(cat)}">`;
    html += `<span class="cat-ref">${meta.ref}<br>·${items.length}</span>`;
    html += `<span class="cat-name-block">`;
    html +=   `<span class="cat-name" style="color: ${catColor}; text-shadow: 0 0 8px ${catColor}40;">${escapeText(cat.toLowerCase())}</span>`;
    html +=   `<span class="cat-tag">${escapeText(meta.tag)}</span>`;
    html += `</span>`;
    html += `<span class="cat-meta"><span class="cat-count">${items.length}</span><span class="cat-toggle">▼</span></span>`;
    html += `</div>`;
    html += `<div class="cat-items list">`;
    items.forEach(({ name, def, tags }) => {
      const sel = brState.selected === name ? "selected" : "";
      const desc = def.description || "";
      const nameHtml = brHighlight(name, ops);
      const tagHtml = tags.map(t => `<span class="br-tag ${t}">${t.replace("user-dsp", ".gdsp")}</span>`).join("");
      html += `<div class="pal-item ${sel}" data-add="${escapeAttr(name)}"`;
      if (desc) html += ` title="${escapeAttr(desc)}"`;
      html += `>`;
      html += `<span class="pal-dot" style="background:${def.color}; color:${def.color}"></span>`;
      html += `<span class="pal-name">${nameHtml}</span>`;
      html += `<span class="item-tags">${tagHtml}</span>`;
      html += `</div>`;
    });
    html += `</div></div>`;
  });
  if (!any) {
    html = `<div class="pal-empty">No nodes match the current filter.<br><br>
      <span style="color:var(--text-3); font-size:9.5px; letter-spacing:0.10em;">
        TRY: clearing the search · clicking ALL on the rail · cat:filter · tag:multi-out
      </span></div>`;
  }
  palette.innerHTML = html;

  // Footer + tab status
  const footCount = document.getElementById("pal-foot-count");
  if (footCount) footCount.textContent = filtering ? `${totalShown}` : String(totalAll);
  const footReg = document.getElementById("br-foot-reg"); if (footReg) footReg.textContent = String(totalAll);
  const footCat = document.getElementById("br-foot-cat"); if (footCat) footCat.textContent = String(catsPresent.size);
  const footVer = document.getElementById("br-foot-version"); if (footVer && typeof APP_VERSION !== "undefined") footVer.textContent = `GAMMA · v${APP_VERSION}`;
  const tabStatus = document.getElementById("br-tab-status"); if (tabStatus) tabStatus.textContent = `REG · ${totalAll}`;

  // Re-bind interaction. Category headers toggle collapsed state;
  // pal-items single-click selects (highlights + shows in the
  // drawer) and double-click adds to the canvas. Keep single-click-
  // adds-to-canvas for the historical UX so power users aren't
  // surprised — they can still drop a node by single click.
  palette.querySelectorAll(".cat-header").forEach(h => {
    h.addEventListener("click", () => {
      const cat = h.dataset.toggle;
      collapsedCats[cat] = !collapsedCats[cat];
      brRenderNodes();
    });
  });
  palette.querySelectorAll(".pal-item").forEach(item => {
    item.addEventListener("click", () => {
      const name = item.dataset.add;
      brState.selected = name;
      brRenderDrawer();
      // Visual selection highlight
      palette.querySelectorAll(".pal-item.selected").forEach(s => s.classList.remove("selected"));
      item.classList.add("selected");
      // Open drawer if collapsed (first interaction)
      const drw = document.getElementById("br-drawer");
      if (drw && drw.classList.contains("collapsed")) drw.classList.remove("collapsed");
      // Keep the historical "click adds the node" affordance.
      addFromPalette(name);
    });
  });
}

/* ─── Detail drawer ─────────────────────────────────────────────── */
function brRenderDrawer() {
  const name = brState.selected;
  const titleEl = document.getElementById("br-drawer-title");
  const bodyEl = document.getElementById("br-drawer-body");
  if (!titleEl || !bodyEl) return;
  if (!name || !TYPES[name]) {
    titleEl.innerHTML = `nothing selected <span class="ref">REG · —</span>`;
    bodyEl.innerHTML = "";
    return;
  }
  const def = TYPES[name];
  const tags = brDeriveTags(name, def);
  const meta = _brCatMeta(def.category);
  const idx = Object.keys(TYPES).indexOf(name);
  titleEl.innerHTML = `${escapeText(name.toLowerCase())} <span class="ref">${meta.ref}.${String(idx).padStart(3,"0")} · ${escapeText((def.category||"").toUpperCase())}</span>`;

  const portRow = (p, dir) => {
    const t = (p.t || "audio").toLowerCase();
    return `
      <div class="drawer-port ${t}">
        <span class="port-glyph"></span>
        <span class="port-name">${escapeText(p.n)}</span>
        <span class="port-type">${dir==="in"?"→":"←"} ${escapeText(t)}</span>
      </div>`;
  };

  const ins = (def.ins || []).map(p => portRow(p, "in")).join("");
  const outs = (def.outs || []).map(p => portRow(p, "out")).join("");

  // Related nodes — same category, up to 5, excluding the selection.
  const related = Object.entries(TYPES)
    .filter(([n, d]) => n !== name && d.category === def.category)
    .slice(0, 5)
    .map(([n]) => `<span class="related-chip" data-jump="${escapeAttr(n)}">${escapeText(n)}</span>`)
    .join("");

  const tagHtml = tags.map(t => `<span class="br-tag ${t}" style="font-size:9px; padding:2px 6px;">${t.replace("user-dsp",".gdsp")}</span>`).join("");

  bodyEl.innerHTML = `
    <div class="drawer-section">
      <div class="drawer-section-label">function</div>
      <div class="drawer-text">${escapeText(def.description || "(no description provided)")}</div>
    </div>
    ${ (ins || outs) ? `
      <div class="drawer-section">
        <div class="drawer-section-label">ports · ${(def.ins||[]).length} in / ${(def.outs||[]).length} out</div>
        <div class="drawer-ports">${ins}${outs}</div>
      </div>
    ` : "" }
    <div class="drawer-section">
      <div class="drawer-section-label">tags</div>
      <div class="drawer-related">${tagHtml || "<span style='color:var(--text-3); font-size:10px;'>(no tags derived)</span>"}</div>
    </div>
    ${ related ? `
      <div class="drawer-section">
        <div class="drawer-section-label">related — same category</div>
        <div class="drawer-related">${related}</div>
      </div>
    ` : "" }
  `;
  bodyEl.querySelectorAll(".related-chip").forEach(c => {
    c.addEventListener("click", () => {
      const target = c.dataset.jump;
      if (TYPES[target]) {
        brState.selected = target;
        brRenderNodes();
        brRenderDrawer();
      }
    });
  });
}

/* ─── Tab switching ─────────────────────────────────────────────── */
function brSwitchTab(name) {
  brState.tab = name;
  document.querySelectorAll(".br-tab").forEach(t => t.classList.toggle("active", t.dataset.brTab === name));
  const vN = document.getElementById("br-view-nodes");
  const vA = document.getElementById("br-view-assets");
  const vD = document.getElementById("br-view-demos");
  const vP = document.getElementById("br-view-prefabs");
  const vT = document.getElementById("br-view-tektite");
  if (vN) vN.hidden = name !== "nodes";
  if (vA) vA.hidden = name !== "assets";
  if (vD) vD.hidden = name !== "demos";
  if (vP) vP.hidden = name !== "prefabs";
  if (vT) vT.hidden = name !== "tektite";
  // Status text updates per-tab
  const status = document.getElementById("br-tab-status");
  if (status) {
    if (name === "nodes")   status.textContent = `REG · ${Object.keys(TYPES).length}`;
    if (name === "assets")  status.textContent = `ASSETS · ${(_assets ? _assets.size : 0)}`;
    if (name === "demos")   status.textContent = `DEMOS · ${_demos.length}`;
    if (name === "prefabs") status.textContent = `PREFABS · ${_prefabBrowserCount()}`;
    if (name === "tektite") status.textContent = `TEKTITE`;
  }
  if (name === "assets")  brRenderAssets();
  if (name === "demos")   brRenderDemos();
  if (name === "prefabs") brRenderPrefabs();
  if (name === "tektite") tektiteTabAttach();  // idempotent
}

/* ─── Demos tab ─────────────────────────────────────────────────── */
/* Curated example patches. Each entry's build() function runs against
 * a freshly-cleared `state` (via loadDemo()) using the same makeNode +
 * state.edges.push pattern reset() uses, so the demos read like
 * normal patch construction. The thumbnails are inline SVG glyphs
 * sized to match the asset-card .asset-thumb dimensions. Add more
 * demos here as Phase 6.5.5+ ships canonical examples. */

/* Programmatic sprite-sheet generator for the animated platformer
 * demo. 6 frames at 32×32, laid out horizontally (sheet 192×32):
 *   [0] idle    [1] walk-A    [2] walk-mid    [3] walk-B    [4] jump    [5] fall
 * Matches the AnimationState2D node's default frame specs
 *   idleFrames:"0", walkFrames:"1,2,1,3", jumpFrames:"4", fallFrames:"5"
 * so a fresh AnimationState2D wires up against this sheet with no
 * tweaking. Cheap-and-cheerful "orange blob with eyes" -- a stand-in
 * for whatever character the user generates via SpriteCreator later.
 */
async function _makePlaceholderHeroSheet() {
  const FW = 32, FH = 32, NF = 6;
  const W = FW * NF, H = FH;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  // Palette -- low-saturation pixel-art friendly.
  const C_BODY    = "#e85a3a";
  const C_DARK    = "#a83a20";
  const C_OUT     = "#3a1a10";
  const C_EYE     = "#ffffff";
  const C_PUPIL   = "#101010";
  const C_FOOT    = "#5a2a1a";
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  function drawHero(ox, p) {
    const bx = ox + 8;
    const by = 8 + (p.bobY || 0);
    const bw = 16, bh = 16;
    // Body fill
    px(bx + 1, by + 1, bw - 2, bh - 2, C_BODY);
    // Outline
    px(bx, by + 1, 1, bh - 2, C_OUT);
    px(bx + bw - 1, by + 1, 1, bh - 2, C_OUT);
    px(bx + 1, by, bw - 2, 1, C_OUT);
    px(bx + 1, by + bh - 1, bw - 2, 1, C_OUT);
    // Shading (lower-right)
    px(bx + bw - 3, by + 3, 1, bh - 5, C_DARK);
    px(bx + 3, by + bh - 3, bw - 5, 1, C_DARK);
    // Eyes
    const eyeY = by + 4;
    const eyeL = bx + 3, eyeR = bx + 10;
    px(eyeL, eyeY, 3, 3, C_EYE);
    px(eyeR, eyeY, 3, 3, C_EYE);
    const pdx = (p.lookRight ? 2 : (p.lookLeft ? 0 : 1));
    const pdy = (p.lookUp ? 0 : (p.lookDown ? 2 : 1));
    px(eyeL + pdx, eyeY + pdy, 1, 1, C_PUPIL);
    px(eyeR + pdx, eyeY + pdy, 1, 1, C_PUPIL);
    // Mouth (subtle dark notch)
    px(bx + 7, by + 10, 2, 1, C_OUT);
    // Feet -- two small rects below body
    const fyBase = by + bh;
    const lf = p.leftFoot  || { dx: -2, dy: 0 };
    const rf = p.rightFoot || { dx: 1,  dy: 0 };
    px(bx + 2 + lf.dx, fyBase + lf.dy, 4, 2, C_FOOT);
    px(bx + bw - 6 + rf.dx, fyBase + rf.dy, 4, 2, C_FOOT);
  }
  // Frame 0 -- idle (neutral stance, looking forward)
  drawHero(0 * FW, { leftFoot: { dx: -2, dy: 0 }, rightFoot: { dx: 1, dy: 0 } });
  // Frame 1 -- walk pose A (right foot forward, lifted)
  drawHero(1 * FW, { leftFoot: { dx: -3, dy: 0 }, rightFoot: { dx: 2, dy: -1 }, lookRight: true });
  // Frame 2 -- walk pose mid (both feet close, body up a hair)
  drawHero(2 * FW, { bobY: -1, leftFoot: { dx: -1, dy: 0 }, rightFoot: { dx: 0, dy: 0 } });
  // Frame 3 -- walk pose B (left foot forward, lifted)
  drawHero(3 * FW, { leftFoot: { dx: -1, dy: -1 }, rightFoot: { dx: 0, dy: 0 }, lookRight: true });
  // Frame 4 -- jump (body raised, feet tucked, eyes up)
  drawHero(4 * FW, { bobY: -3, leftFoot: { dx: -1, dy: -2 }, rightFoot: { dx: 0, dy: -2 }, lookUp: true });
  // Frame 5 -- fall (body lowered, feet down, eyes down)
  drawHero(5 * FW, { bobY: 1,  leftFoot: { dx: -2, dy: 1 },  rightFoot: { dx: 1, dy: 1 },  lookDown: true });
  return await c.convertToBlob({ type: "image/png" });
}

/* Idempotent. If a sprite named 'hero-placeholder' already exists in
 * the asset library, this is a no-op. Otherwise it generates the
 * placeholder sheet, registers it as a 6-frame sprite, and creates
 * a 'hero-placeholder-folder' (playable-character function) with the
 * sprite assigned to the idle / walk / jump-up / fall slots so the
 * user can drag the folder onto a Scene2D to spawn a wired character. */
/* Programmatic egg pickup sprite. 16×16, single frame. Egg-shell
 * cream body with a soft top-left highlight + bottom-right shadow
 * for that "I am an egg, not a circle" read. Pixel-art ovular
 * silhouette so it stays legible at 1:1 in a 32×32 sprite world. */
async function _makeEggPickupSprite() {
  const W = 16, H = 16;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  const SHELL     = "#fdf3e0";
  const HIGHLIGHT = "#ffffff";
  const SHADOW    = "#dbc89c";
  const OUTLINE   = "#7a5a30";
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  // Egg silhouette as horizontal scanlines (cols start_x → start_x+width).
  // Roughly 10×12 ovular, narrower at top, slightly fatter near bottom.
  const shape = [
    { y:  2, x: 6, w: 4 },
    { y:  3, x: 5, w: 6 },
    { y:  4, x: 4, w: 8 },
    { y:  5, x: 4, w: 8 },
    { y:  6, x: 3, w: 10 },
    { y:  7, x: 3, w: 10 },
    { y:  8, x: 3, w: 10 },
    { y:  9, x: 3, w: 10 },
    { y: 10, x: 3, w: 10 },
    { y: 11, x: 4, w: 8 },
    { y: 12, x: 4, w: 8 },
    { y: 13, x: 5, w: 6 }
  ];
  for (const s of shape) px(s.x, s.y, s.w, 1, SHELL);
  // Outline pass
  for (const s of shape) {
    px(s.x,          s.y, 1, 1, OUTLINE);
    px(s.x + s.w - 1, s.y, 1, 1, OUTLINE);
  }
  px(6, 1, 4, 1, OUTLINE); // top cap
  px(5, 14, 6, 1, OUTLINE); // bottom cap
  // Highlight (top-left)
  px(5, 4, 2, 1, HIGHLIGHT);
  px(4, 5, 1, 2, HIGHLIGHT);
  px(5, 5, 1, 1, HIGHLIGHT);
  // Shadow (bottom-right curve)
  px(10, 10, 1, 2, SHADOW);
  px(9, 12, 2, 1, SHADOW);
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic goal-flag sprite. 16×24, single frame. A wooden pole
 * on the left third + a red triangular pennant pointing right --
 * unambiguous "you've reached the end" visual that reads cleanly
 * even when rendered at 1 world unit tall. */
async function _makeGoalFlagSprite() {
  const W = 16, H = 24;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  const POLE_LIGHT = "#8c6a3e";
  const POLE_DARK  = "#5a3e1e";
  const FLAG       = "#e83a3a";
  const FLAG_LITE  = "#ff6060";
  const FLAG_DARK  = "#a02020";
  const OUTLINE    = "#3a1010";
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  // Pole: 2px wide centered around x=3, full height minus base.
  px(3, 1, 2, 22, POLE_LIGHT);
  px(3, 1, 1, 22, POLE_DARK);   // left edge darker
  px(2, 22, 4, 1, POLE_DARK);   // small foot
  px(1, 23, 6, 1, OUTLINE);     // ground line
  // Flag: triangle, peak at top of pole, hangs down to mid-height.
  // Rows from y=2 to y=10. Each row: starts at x=5 (right of pole),
  // extends by a width that narrows toward the bottom.
  const flag = [
    { y:  2, w: 10 },
    { y:  3, w: 10 },
    { y:  4, w: 10 },
    { y:  5, w: 9  },
    { y:  6, w: 8  },
    { y:  7, w: 7  },
    { y:  8, w: 5  },
    { y:  9, w: 3  }
  ];
  for (const f of flag) px(5, f.y, f.w, 1, FLAG);
  // Highlight top
  px(5, 2, 8, 1, FLAG_LITE);
  // Shadow bottom edges of each row (gives flag depth)
  for (const f of flag) px(5 + f.w - 1, f.y, 1, 1, FLAG_DARK);
  // Pennant point outline (right edge)
  px(5 + flag[0].w, 2, 1, 1, OUTLINE);
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic parallax background -- sky layer. 256×128 PNG with
 * a soft vertical gradient (deep blue top → light haze bottom) plus
 * scattered subtle clouds. Width chosen to tile horizontally
 * seamlessly when the sampler is set to repeat-x. parallaxX=0 means
 * the sky doesn't actually scroll, but we still want it to look
 * "right" if someone wires it with parallaxX>0. */
async function _makeParallaxSkySprite() {
  const W = 256, H = 128;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  // Vertical gradient: top deeper blue → bottom haze.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0,   "#4a7dc0");
  grad.addColorStop(0.6, "#82b6d8");
  grad.addColorStop(1,   "#c9dceb");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Distant clouds -- soft ellipses, transparent. Deterministic
  // placement via seeded random so the look is stable across loads.
  let seed = 0x4c1d;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  for (let i = 0; i < 6; i++) {
    const x = rand() * W;
    const y = 12 + rand() * 36;
    const rx = 18 + rand() * 26;
    const ry = 5  + rand() * 4;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tile-safe: if cloud crosses right edge, redraw at x-W so the
    // texture loops cleanly.
    if (x + rx > W)  { ctx.beginPath(); ctx.ellipse(x - W, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
    if (x - rx < 0)  { ctx.beginPath(); ctx.ellipse(x + W, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic parallax background -- distant mountains. 512×128.
 * Two overlapping silhouette ranges in muted purple-gray; tile-safe
 * horizontally. Transparent above the ridges so the sky shows
 * through. parallaxX ~0.10-0.15 for "far distance" feel. */
async function _makeParallaxMountainsSprite() {
  const W = 512, H = 128;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, W, H);
  // Ridge generator: triangular peaks at quasi-random columns. Use
  // a closed path that wraps to tile cleanly: ensure the last point's
  // y matches the first point's y, and the path stays inside [0, W].
  function drawRidge(color, peakColor, baseY, peakHeight, peakCount, seed) {
    let s = seed >>> 0;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
    const peaks = [];
    // Force matching endpoints so the texture seams cleanly.
    peaks.push({ x: 0,   y: baseY });
    for (let i = 0; i < peakCount; i++) {
      const px = ((i + 0.5) / peakCount) * W + (rand() - 0.5) * (W / peakCount) * 0.6;
      const ph = peakHeight * (0.6 + rand() * 0.4);
      peaks.push({ x: px, y: baseY - ph });
      // Add a saddle between peaks for variation
      if (i < peakCount - 1) {
        const sx = ((i + 1) / peakCount) * W;
        const sh = peakHeight * (0.2 + rand() * 0.3);
        peaks.push({ x: sx, y: baseY - sh });
      }
    }
    peaks.push({ x: W,   y: baseY });
    // Body fill
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (const p of peaks) ctx.lineTo(p.x, p.y);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // Ridge highlight (thin lighter line along the top edge)
    ctx.beginPath();
    ctx.moveTo(peaks[0].x, peaks[0].y);
    for (let i = 1; i < peaks.length; i++) ctx.lineTo(peaks[i].x, peaks[i].y);
    ctx.strokeStyle = peakColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // Far ridge (lighter, higher up the image)
  drawRidge("#7a8aa8", "#a4b3cd", 78, 48, 7, 0x8a14);
  // Near ridge (darker, lower down + taller peaks)
  drawRidge("#54678a", "#7d92b3", 96, 60, 5, 0x3221);
  return await c.convertToBlob({ type: "image/png" });
}

/* Programmatic parallax background -- midground forest. 512×128.
 * Row of conifer-tree silhouettes with snow caps + subtle variation
 * in height. Tile-safe. Sits in front of the mountains, behind the
 * level. parallaxX ~0.30-0.45 for "midground" feel. */
async function _makeParallaxForestSprite() {
  const W = 512, H = 128;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  let s = 0x9911;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  // Sparser horizon-strip treeline. ONLY 6 short trees across 512px
  // (was 18 ~tall ones), confined to the BOTTOM 30% of the texture
  // so a thin layer (scaleY ~0.25) places them as a peek-above-the-
  // horizon silhouette band rather than a wall of foliage that
  // covers half the screen.
  const baselineY = H - 4;          // trunk floor near bottom of texture
  const treeCount = 6;
  const slot = W / treeCount;
  function drawTreeAt(cx, baseY, height, width) {
    // Trunk
    ctx.fillStyle = "#3a2210";
    ctx.fillRect(cx - 1.5, baseY, 3, 3);
    // Triangle body
    ctx.fillStyle = "#2c5436";
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.5, baseY);
    ctx.lineTo(cx + width * 0.5, baseY);
    ctx.lineTo(cx,                baseY - height);
    ctx.closePath();
    ctx.fill();
    // Subtle inner highlight
    ctx.fillStyle = "#3a6845";
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.30, baseY - 2);
    ctx.lineTo(cx + width * 0.12, baseY - 2);
    ctx.lineTo(cx - width * 0.05, baseY - height + 4);
    ctx.closePath();
    ctx.fill();
  }
  for (let i = 0; i < treeCount; i++) {
    const cx = (i + 0.5) * slot + (rand() - 0.5) * slot * 0.3;
    const baseY = baselineY - rand() * 2;
    const height = 18 + rand() * 8;   // 18-26 (was 32-54)
    const width  = 12 + rand() * 4;   // 12-16 (was 14-22)
    drawTreeAt(cx, baseY, height, width);
    // Tile-wrap for seamless horizontal cycling.
    if (cx + width * 0.5 > W) drawTreeAt(cx - W, baseY, height, width);
    if (cx - width * 0.5 < 0) drawTreeAt(cx + W, baseY, height, width);
  }
  return await c.convertToBlob({ type: "image/png" });
}

/* Default-ship bootstrap: parallax bg layers (sky + mountains +
 * forest) all in one 'parallax-background' folder so they ship as
 * a related set. Functions identically to the hero / egg / flag
 * bootstraps: idempotent, runs on DOMContentLoaded. */
// Bump on any meaningful parallax-bg art change so users on the
// previous version get the new sprites instead of stale IDB blobs.
