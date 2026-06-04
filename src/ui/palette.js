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

