/* =========================================================================
 * Per-node code editor — Sprint 5.node-edit
 *
 * Each node can carry a `.override` object that replaces fields on the
 * base TYPES entry (see defOf merge). This modal lets the user edit:
 *   - cppType (member declaration type)
 *   - helperClass (C++ source for the class)
 *   - ins / outs (port lists, including types + setter method names)
 *
 * Trigger paths:
 *   - "E" key with a single node selected (and no group selected)
 *   - "✎" button rendered on the bottom edge of the selected node
 *
 * All main hotkeys (V/D/W/Z/X/E/1..5/Space/Delete) are suppressed
 * while the modal is open via a capture-phase keydown listener.
 * ======================================================================= */

let _nodeEditTargetId = null;          // id of the node being edited
let _nodeEditorOpen   = false;         // gates main hotkeys
let _nodeEditSeed     = null;          // result of _seedNodeEditCode for the current open --
                                       // carries the synth's noSigArg hint + class name so
                                       // save can wire the override correctly.

/* CodeMirror instances for the two code panes, created lazily on
 * first modal open. Same options the User DSP editor uses so the
 * per-node editor has identical syntax colouring, line numbers,
 * bracket matching, and font / theme. */
let _nodeEditCmRaw  = null;
let _nodeEditCmGdsp = null;
function _initNodeEditCm() {
  if (typeof CodeMirror === "undefined") return;
  const cmOpts = {
    mode: "text/x-c++src",
    theme: "material-darker",
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    smartIndent: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    lineWrapping: false,
    extraKeys: {
      Tab:         cm => cm.execCommand("indentMore"),
      "Shift-Tab": cm => cm.execCommand("indentLess"),
      "Cmd-/":     "toggleComment",
      "Ctrl-/":    "toggleComment"
    }
  };
  if (!_nodeEditCmRaw) {
    const ta = document.getElementById("node-edit-code");
    if (ta) {
      _nodeEditCmRaw = CodeMirror.fromTextArea(ta, cmOpts);
      // Mirror to the underlying textarea so anything legacy that reads
      // .value still sees the current text.
      _nodeEditCmRaw.on("change", () => { ta.value = _nodeEditCmRaw.getValue(); });
    }
  }
  if (!_nodeEditCmGdsp) {
    const ta = document.getElementById("node-edit-gdsp");
    if (ta) {
      _nodeEditCmGdsp = CodeMirror.fromTextArea(ta, cmOpts);
      _nodeEditCmGdsp.on("change", () => { ta.value = _nodeEditCmGdsp.getValue(); });
    }
  }
}

// Get / set wrappers that prefer the CodeMirror instance when up,
// fall back to the raw textarea (e.g. CodeMirror failed to load).
function _getRawCode()    { return _nodeEditCmRaw  ? _nodeEditCmRaw.getValue()  : document.getElementById("node-edit-code").value; }
function _setRawCode(s)   { if (_nodeEditCmRaw)  _nodeEditCmRaw.setValue(s);   else document.getElementById("node-edit-code").value = s; }
function _getGdspCode()   { return _nodeEditCmGdsp ? _nodeEditCmGdsp.getValue() : document.getElementById("node-edit-gdsp").value; }
function _setGdspCode(s)  { if (_nodeEditCmGdsp) _nodeEditCmGdsp.setValue(s); else document.getElementById("node-edit-gdsp").value = s; }

const PORT_TYPE_OPTS_IN  = ["audio", "param", "gate", "clock", "texture", "transform", "mesh", "camera", "light", "environment"];
const PORT_TYPE_OPTS_OUT = ["audio", "param", "gate", "clock", "texture", "transform", "mesh", "camera", "light", "environment"];

/* Phase 7 §5.5.e -- TiledTerrain config popup. Mounts a modal
 * dynamically (no pre-defined HTML) so the feature stays contained
 * to TiledTerrain. Live-edits node.params + re-renders the editor
 * on every change so the user sees the mesh rebuild in the visual
 * preview as they dial knobs. Closing the modal pushes one history
 * entry covering the whole edit session (debounced rebuild not
 * needed at this scale -- the mesh cache key gates on params). */
/* §planet-spec Phase 7.d -- PlanetMap equirect painter popup. Modal
 * with a 720×360 equirect canvas + raise/lower brush controls. On
 * pointerdown/move the brush modifies cells.elevations within a
 * geodesic radius of the cursor's lat/lon; the canvas re-renders
 * from the modified cells; on modal close (or every stroke end) we
 * bump node._cellsVersion which invalidates the cubemap cache and
 * triggers a re-bake next time Planet reads heights.
 *
 * Equirect mapping: pixel (px, py) ∈ [0, W) × [0, H) →
 *   lon = (px + 0.5) / W * 2π - π        (left edge = -π, right = +π)
 *   lat = π/2 - (py + 0.5) / H * π       (top = +π/2, bottom = -π/2)
 *   unit_vec = (cos(lat)*sin(lon), sin(lat), cos(lat)*cos(lon))
 *
 * Pole-pinching: a constant-pixel brush radius covers a tiny patch
 * at the equator and a huge patch at the poles. We brush in
 * GEODESIC distance (angle from the cursor's unit_vec) so the
 * affected area on the sphere is uniform regardless of latitude. */
// §planet-spec Phase 7.f-ai -- preset and keyword tables hoisted to
// module scope so the offline prompt-tester (tools/pmap-prompt-tester.html)
// PMAP_AI_PRESETS / PMAP_AI_KEYWORDS removed 2026-05-21 -- the AI
// pipeline for planet maps was retired entirely. Landmass comes from
// brush + GeoJSON / Azgaar full-JSON import; features come from the
// brush mode picker (mountain / plain / valley / ridge / smooth).


/* §planet-spec Phase 7.e-climate -- Configure World modal. Mirrors
 * Azgaar's Configure World panel functionally: equator / north pole
 * / south pole temps, precipitation %, per-band wind direction.
 * Styled with the editor's CRT/phosphor aesthetic. */
function openClimateConfigModal(node, onApply) {
  if (!node) return;
  // Pull current config (merged with defaults). Sliders edit a
  // local copy; commit on Apply.
  const baseline = _resolveClimateConfig(node.params && node.params.climate);
  const draft = JSON.parse(JSON.stringify(baseline));

  // Remove any previous instance.
  let prev = document.getElementById("climate-config-modal");
  if (prev) prev.remove();
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id = "climate-config-modal";
  back.style.display = "flex";
  back.style.zIndex = 80;
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.width = "520px";
  modal.style.maxHeight = "90vh";
  modal.style.overflowY = "auto";

  // Wind band labels (top to bottom).
  const BAND_LABELS = ["60-90°N (polar)", "30-60°N (temperate)", "0-30°N (tropical)",
                       "0-30°S (tropical)", "30-60°S (temperate)", "60-90°S (polar)"];
  // Cardinal directions: degrees (0=N, 90=E, 180=S, 270=W).
  const WIND_DIRS = [
    { deg: 0,   name: "N",  arrow: "↑" },
    { deg: 45,  name: "NE", arrow: "↗" },
    { deg: 90,  name: "E",  arrow: "→" },
    { deg: 135, name: "SE", arrow: "↘" },
    { deg: 180, name: "S",  arrow: "↓" },
    { deg: 225, name: "SW", arrow: "↙" },
    { deg: 270, name: "W",  arrow: "←" },
    { deg: 315, name: "NW", arrow: "↖" }
  ];

  // Build a slider row: <label> [slider] [value-input] [unit]
  function sliderRowHTML(id, label, val, min, max, step, unit, tooltip) {
    return ''
      + '<div class="climate-row" title="' + (tooltip || "") + '">'
      + '  <label for="' + id + '">' + label + '</label>'
      + '  <input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">'
      + '  <input type="number" id="' + id + '-v" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">'
      + '  <span class="climate-unit">' + unit + '</span>'
      + '</div>';
  }

  let windRowsHTML = "";
  for (let i = 0; i < 6; i++) {
    windRowsHTML += '<div class="climate-wind-row">'
      + '<span class="climate-band">' + BAND_LABELS[i] + '</span>'
      + '<div class="climate-wind-buttons" data-band="' + i + '">';
    for (const d of WIND_DIRS) {
      windRowsHTML += '<button type="button" class="climate-wind-btn'
        + (d.deg === draft.winds[i] ? " active" : "")
        + '" data-band="' + i + '" data-deg="' + d.deg + '" title="' + d.name + '">' + d.arrow + '</button>';
    }
    windRowsHTML += '</div></div>';
  }

  modal.innerHTML = ''
    + '<style>'
    + '#climate-config-modal .modal-head { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid var(--border); }'
    + '#climate-config-modal .modal-title { font-family:var(--font-instr); letter-spacing:0.18em; color:var(--phosphor); text-transform:lowercase; font-size:13px; }'
    + '#climate-config-modal .climate-body { padding:14px 18px; font-family:var(--font-mono); font-size:11px; color:var(--text-2); }'
    + '#climate-config-modal .climate-section { font-family:var(--font-mono); color:var(--phosphor); font-size:10px; text-transform:uppercase; letter-spacing:0.1em; margin:14px 0 6px; padding-bottom:3px; border-bottom:1px dashed var(--border); }'
    + '#climate-config-modal .climate-section:first-child { margin-top:0; }'
    + '#climate-config-modal .climate-row { display:grid; grid-template-columns:130px 1fr 64px 30px; align-items:center; gap:8px; margin:5px 0; }'
    + '#climate-config-modal .climate-row label { color:var(--text-2); }'
    + '#climate-config-modal .climate-row input[type=range] { width:100%; }'
    + '#climate-config-modal .climate-row input[type=number] { width:60px; background:var(--surface); color:var(--text); border:1px solid var(--border); padding:3px 5px; font-family:var(--font-mono); font-size:11px; border-radius:3px; }'
    + '#climate-config-modal .climate-unit { color:var(--text-3); font-size:10px; text-align:left; }'
    + '#climate-config-modal .climate-wind-row { display:grid; grid-template-columns:160px 1fr; align-items:center; gap:8px; margin:4px 0; }'
    + '#climate-config-modal .climate-band { color:var(--text-2); font-size:11px; }'
    + '#climate-config-modal .climate-wind-buttons { display:flex; gap:2px; }'
    + '#climate-config-modal .climate-wind-btn { width:24px; height:24px; padding:0; background:var(--surface); color:var(--text-3); border:1px solid var(--border); border-radius:2px; font-family:var(--font-mono); font-size:14px; cursor:pointer; transition:all 0.1s; }'
    + '#climate-config-modal .climate-wind-btn:hover { color:var(--text); border-color:var(--phosphor); }'
    + '#climate-config-modal .climate-wind-btn.active { background:var(--phosphor); color:#000; border-color:var(--phosphor); }'
    + '#climate-config-modal .climate-footer { display:flex; gap:8px; justify-content:space-between; padding:10px 14px; border-top:1px solid var(--border); }'
    + '</style>'
    + '<div class="modal-head">'
    + '  <span class="modal-title">configure world / climate</span>'
    + '  <button class="btn modal-x" id="climate-x" type="button">×</button>'
    + '</div>'
    + '<div class="climate-body">'
    + '  <div class="climate-section">temperature</div>'
    + sliderRowHTML("clim-eq",  "Equator",        draft.equatorC,    -10, 50, 1, "°C", "Sea-level temperature at the equator")
    + sliderRowHTML("clim-np",  "North Pole",     draft.northPoleC,  -60, 30, 1, "°C", "Sea-level temperature at the north pole")
    + sliderRowHTML("clim-sp",  "South Pole",     draft.southPoleC,  -60, 30, 1, "°C", "Sea-level temperature at the south pole")
    + sliderRowHTML("clim-tn",  "Tropic N edge",  draft.tropicNorth,   0, 30, 1, "°lat", "Where the equatorial heat-belt ends going north (Earth ≈ 23°N)")
    + sliderRowHTML("clim-ts",  "Tropic S edge",  draft.tropicSouth, -30,  0, 1, "°lat", "Where the equatorial heat-belt ends going south (Earth ≈ -23°S)")
    + sliderRowHTML("clim-lapse", "Lapse rate",   draft.lapseRateC,    0, 12, 0.1, "°C/km", "How fast temperature drops with altitude (Earth ≈ 6.5°C/km)")
    + sliderRowHTML("clim-peak",  "Peak altitude",draft.peakAltM,   1000, 20000, 100, "m",  "Altitude where the lapse rate saturates -- decouples climate from heightScale exaggeration")
    + '  <div class="climate-section">precipitation</div>'
    + sliderRowHTML("clim-prec", "Precipitation", draft.precipPct,  10, 300, 1, "%", "Global humidity multiplier on the wind-sim base budget")
    + '  <div class="climate-section">winds (where wind is blowing TOWARD per band)</div>'
    + windRowsHTML
    + '</div>'
    + '<div class="climate-footer">'
    + '  <button class="btn" id="clim-defaults" type="button">restore defaults</button>'
    + '  <div style="display:flex;gap:8px;">'
    + '    <button class="btn" id="clim-cancel" type="button">cancel</button>'
    + '    <button class="btn" id="clim-apply" type="button" style="background:var(--phosphor);color:#000;border-color:var(--phosphor);">apply</button>'
    + '  </div>'
    + '</div>';
  back.appendChild(modal);
  document.body.appendChild(back);

  // Helper: wire a slider + number input pair to update draft[key].
  function wireSliderPair(rangeId, key, parser) {
    const r = modal.querySelector("#" + rangeId);
    const n = modal.querySelector("#" + rangeId + "-v");
    const p = parser || ((v) => +v);
    r.addEventListener("input", () => { draft[key] = p(r.value); n.value = r.value; });
    n.addEventListener("input", () => {
      let v = p(n.value);
      const min = parseFloat(r.min), max = parseFloat(r.max);
      if (v < min) v = min; else if (v > max) v = max;
      draft[key] = v;
      r.value = v;
    });
  }
  wireSliderPair("clim-eq",    "equatorC");
  wireSliderPair("clim-np",    "northPoleC");
  wireSliderPair("clim-sp",    "southPoleC");
  wireSliderPair("clim-tn",    "tropicNorth");
  wireSliderPair("clim-ts",    "tropicSouth");
  wireSliderPair("clim-lapse", "lapseRateC", v => parseFloat(v));
  wireSliderPair("clim-peak",  "peakAltM");
  wireSliderPair("clim-prec",  "precipPct");

  // Wire wind direction buttons -- one selected per band.
  modal.querySelectorAll(".climate-wind-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const band = +btn.dataset.band;
      const deg = +btn.dataset.deg;
      draft.winds[band] = deg;
      // Update active state for this band.
      modal.querySelectorAll('.climate-wind-btn[data-band="' + band + '"]').forEach(b => {
        if (+b.dataset.deg === deg) b.classList.add("active");
        else                        b.classList.remove("active");
      });
    });
  });

  // Restore defaults: copy from _PLANET_CLIMATE_DEFAULTS into draft + UI.
  modal.querySelector("#clim-defaults").addEventListener("click", () => {
    const D = _PLANET_CLIMATE_DEFAULTS;
    draft.equatorC = D.equatorC;        modal.querySelector("#clim-eq").value    = D.equatorC;    modal.querySelector("#clim-eq-v").value    = D.equatorC;
    draft.northPoleC = D.northPoleC;    modal.querySelector("#clim-np").value    = D.northPoleC;  modal.querySelector("#clim-np-v").value    = D.northPoleC;
    draft.southPoleC = D.southPoleC;    modal.querySelector("#clim-sp").value    = D.southPoleC;  modal.querySelector("#clim-sp-v").value    = D.southPoleC;
    draft.tropicNorth = D.tropicNorth;  modal.querySelector("#clim-tn").value    = D.tropicNorth; modal.querySelector("#clim-tn-v").value    = D.tropicNorth;
    draft.tropicSouth = D.tropicSouth;  modal.querySelector("#clim-ts").value    = D.tropicSouth; modal.querySelector("#clim-ts-v").value    = D.tropicSouth;
    draft.lapseRateC = D.lapseRateC;    modal.querySelector("#clim-lapse").value = D.lapseRateC;  modal.querySelector("#clim-lapse-v").value = D.lapseRateC;
    draft.peakAltM = D.peakAltM;        modal.querySelector("#clim-peak").value  = D.peakAltM;    modal.querySelector("#clim-peak-v").value  = D.peakAltM;
    draft.precipPct = D.precipPct;      modal.querySelector("#clim-prec").value  = D.precipPct;   modal.querySelector("#clim-prec-v").value  = D.precipPct;
    draft.winds = D.winds.slice();
    modal.querySelectorAll(".climate-wind-btn").forEach(b => {
      const band = +b.dataset.band;
      const deg  = +b.dataset.deg;
      if (deg === draft.winds[band]) b.classList.add("active");
      else                           b.classList.remove("active");
    });
  });

  function close() { back.remove(); }
  modal.querySelector("#climate-x").addEventListener("click", close);
  modal.querySelector("#clim-cancel").addEventListener("click", close);
  modal.querySelector("#clim-apply").addEventListener("click", () => {
    if (!node.params) node.params = {};
    node.params.climate = draft;
    if (typeof onApply === "function") onApply(draft);
    close();
  });
  back.addEventListener("click", (ev) => { if (ev.target === back) close(); });
}


function openPlanetMapEditor(nodeId) {
  const node = state && state.nodes && state.nodes.find(n => n && n.id === nodeId);
  if (!node || node.type !== "PlanetMap") return;
  const cells = _ensurePlanetMapCells(node);
  if (!cells) return;
  const hash = node._cellsHash;
  pushHistory("planet-map-edit:open");

  let prev = document.getElementById("planet-map-modal");
  if (prev) prev.remove();
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id        = "planet-map-modal";
  back.style.display = "flex";
  back.style.zIndex = 60;
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.width = "780px";
  modal.style.maxHeight = "90vh";
  modal.style.overflowY = "auto";
  modal.innerHTML =
    '<div class="modal-head">' +
      '<span class="modal-title" style="font-family: var(--font-instr); letter-spacing: 0.18em; color: var(--phosphor); text-transform: lowercase;">planet map · ' + node.type + '#' + node.id + ' · ' + cells.count + ' cells</span>' +
      '<button class="btn modal-x" id="pmap-close" type="button">×</button>' +
    '</div>' +
    '<div id="pmap-body" style="padding: 12px 16px 16px;"></div>';
  back.appendChild(modal);
  document.body.appendChild(back);
  const body = modal.querySelector("#pmap-body");

  // Sprint 10-1d: tab system removed. Sprint 8-4's biomes-tab
  // exposed the per-biome detail-noise editor (amp / freq / shape
  // / texture style), but Phase 10 retires per-vertex detail noise
  // entirely -- terrain comes from the cubemap-baked tectonic
  // heightmap + hydraulic erosion + climate-derived biome color,
  // not from per-biome procedural noise. The biome editor served
  // an architecture we're moving past, so the whole tab is gone.
  // The painter (canvas + brush + help) is now the modal's only
  // content, appended directly to body.
  const painterPanel = document.createElement("div");
  painterPanel.id = "pmap-tab-painter";
  body.appendChild(painterPanel);

  // Canvas (equirect view of the planet's elevation, cells flat-shaded).
  // Wrapped in a scroll container so it can be zoomed via CSS transform.
  const W = 720, H = 360;
  const canvasWrap = document.createElement("div");
  canvasWrap.style.cssText =
    "width:720px;height:360px;overflow:auto;background:rgba(8,12,20,0.85);" +
    "border:1px solid var(--border);border-radius:3px;display:block;margin-bottom:10px;" +
    "scrollbar-width:thin;";
  const canvasInner = document.createElement("div");
  canvasInner.style.cssText = "width:720px;height:360px;transform-origin:0 0;";
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  canvas.style.cssText =
    "width:720px;height:360px;cursor:crosshair;image-rendering:pixelated;display:block;";
  canvasInner.appendChild(canvas);
  canvasWrap.appendChild(canvasInner);
  painterPanel.appendChild(canvasWrap);
  const ctx = canvas.getContext("2d");

  // Controls.
  const ctrls = document.createElement("div");
  ctrls.style.cssText =
    "display:flex;align-items:center;gap:14px;flex-wrap:wrap;" +
    "font-family:var(--font-mono);font-size:11px;color:var(--text-2);" +
    "padding:6px 0;";
  ctrls.innerHTML =
    '<label>brush&nbsp;<input type="range" id="pmap-size" min="2" max="40" value="8" step="1" style="vertical-align:middle"><span id="pmap-size-v" style="display:inline-block;min-width:26px;text-align:right">8°</span></label>' +
    '<label>strength&nbsp;<input type="range" id="pmap-str" min="1" max="100" value="25" step="1" style="vertical-align:middle"><span id="pmap-str-v" style="display:inline-block;min-width:30px;text-align:right">0.025</span></label>' +
    '<label><input type="radio" name="pmap-mode" value="raise" checked> raise</label>' +
    '<label><input type="radio" name="pmap-mode" value="lower"> lower</label>' +
    '<label title="pull cells toward local average"><input type="radio" name="pmap-mode" value="smooth"> smooth</label>' +
    '<label title="raise toward mountain height (0.85)"><input type="radio" name="pmap-mode" value="mountain"> mountain</label>' +
    '<label title="raise to plain height (0.30) -- flattens mountains, lifts coast"><input type="radio" name="pmap-mode" value="plain"> plain</label>' +
    '<label title="carve into mountains toward valley height (0.22) without flipping to ocean"><input type="radio" name="pmap-mode" value="valley"> valley</label>' +
    '<label title="like mountain but center spikes higher than edges"><input type="radio" name="pmap-mode" value="ridge"> ridge</label>' +
    '<span style="border-left:1px solid var(--border);height:18px;margin:0 2px;"></span>' +
    '<button class="btn" id="pmap-undo" type="button" style="padding:3px 8px;" title="Undo last stroke (Ctrl+Z)">↶ undo</button>' +
    '<button class="btn" id="pmap-redo" type="button" style="padding:3px 8px;" title="Redo (Ctrl+Y)">↷ redo</button>' +
    '<span style="border-left:1px solid var(--border);height:18px;margin:0 2px;"></span>' +
    '<button class="btn" id="pmap-zoom-out" type="button" style="padding:3px 8px;" title="Zoom out">−</button>' +
    '<span id="pmap-zoom-v" style="display:inline-block;min-width:34px;text-align:center;">100%</span>' +
    '<button class="btn" id="pmap-zoom-in" type="button" style="padding:3px 8px;" title="Zoom in">+</button>' +
    '<button class="btn" id="pmap-zoom-fit" type="button" style="padding:3px 8px;" title="Fit (1:1)">fit</button>' +
    '<span style="border-left:1px solid var(--border);height:18px;margin:0 2px;"></span>' +
    '<button class="btn" id="pmap-revert" type="button" style="padding:3px 10px;">revert</button>' +
    '<button class="btn" id="pmap-climate" type="button" style="padding:3px 10px;">show climate</button>' +
    '<button class="btn" id="pmap-climate-config" type="button" style="padding:3px 10px;" title="Configure climate (equator/pole temperatures, precipitation, winds)">⚙ world</button>' +
    '<button class="btn" id="pmap-geojson" type="button" style="padding:3px 10px;" title="Import an Azgaar FMG file (.geojson Cells export or full .json) to stamp its exact landmass + heights onto this planet">import azgaar</button>' +
    '<input type="file" id="pmap-geojson-file" accept=".geojson,.json,application/geo+json,application/json" style="display:none">';
  painterPanel.appendChild(ctrls);

  // AI panel removed 2026-05-21 -- AI keyword features retired.
  const helpRow = document.createElement("div");
  helpRow.style.cssText =
    "font-family:var(--font-mono);font-size:10px;color:var(--text-3);margin-top:6px;line-height:1.5;";
  helpRow.innerHTML =
    "drag on the canvas to paint. brush radius is in degrees of arc on the sphere " +
    "(equator: 1° ≈ 111km on earth). closing the modal bakes the modified cells " +
    "into the cubemap; the planet picks up the change on the next chunk rebuild.";
  painterPanel.appendChild(helpRow);

  // Sprint 10-1d: Biomes tab content (per-biome detail noise editor
  // + texture browser) removed. Phase 10 doesn't run per-vertex
  // detail noise -- terrain comes from cubemap + hydraulic erosion
  // (10-2) + continuous climate (10-3), and biome color is derived
  // per-fragment from temperature+moisture+slope (10-4). The per-
  // biome amp/freq/shape sliders + texture-style picker were
  // editing parameters that the renderer no longer consumes.

  // Locked continent target (shift-click on the map). When set, the
  // next re-roll places the template's first cap here.
  let lockedCenter = null;  // { lat, lon } in degrees

  // Snapshot for revert.
  const elevSnapshot = new Float32Array(cells.elevations);

  // Pre-compute pixel → nearest-cell mapping. ~260k queries × ~50
  // dot products via the spatial hash = ~13M ops, runs in 50-150ms on
  // a desktop. Done once on open; reads from it per-render are O(1).
  const pixelToCell = new Int32Array(W * H);
  const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
  for (let py = 0; py < H; py++) {
    const lat = Math.PI * 0.5 - ((py + 0.5) / H) * Math.PI;
    const clat = Math.cos(lat), slat = Math.sin(lat);
    for (let px = 0; px < W; px++) {
      const lon = ((px + 0.5) / W) * (Math.PI * 2) - Math.PI;
      const ux = clat * Math.sin(lon);
      const uy = slat;
      const uz = clat * Math.cos(lon);
      pixelToCell[py * W + px] = _findNearestCell(cells, hash, ux, uy, uz);
    }
  }
  const dtMs = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;
  console.log("[planet-map] painter pixelToCell map built in " + dtMs.toFixed(0) + "ms");

  // §planet-spec Phase 7.e -- sync painter seaLevel with the wired
  // PlanetMesh's seaLevel so rivers / biomes / coastlines match what
  // the 3D view shows. Falls back to 0.55 (matches the Foot-to-Orbit
  // demo's default) when no PlanetMesh consumes this PlanetMap.
  let seaLevel = 0.55;
  if (state && Array.isArray(state.edges)) {
    for (let i = 0; i < state.edges.length; i++) {
      const e = state.edges[i];
      if (!e || !e.from || !e.to) continue;
      if (e.from.node !== node.id || e.from.port !== "heightmap") continue;
      const consumer = state.nodes.find(n => n && n.id === e.to.node);
      if (consumer && consumer.type === "PlanetMesh" && typeof consumer.params.seaLevel === "number") {
        seaLevel = consumer.params.seaLevel;
        break;
      }
    }
  }

  // Render: walk pixels, look up cell elevation, write RGB color.
  // "show climate" toggle (button below) switches between the
  // elevation-gradient view (default) and the biome + river overlay
  // -- same colors PlanetMesh renders in 3D (Azgaar's biome palette
  // + flux-modulated river blue).
  let showClimate = false;
  const imageData = ctx.createImageData(W, H);
  const RIVER_BLUE = [0.20, 0.45, 0.75];
  const RIVER_BIG  = [0.15, 0.32, 0.62];
  function render() {
    const data = imageData.data;
    const haveBiome = showClimate && cells.biome;
    const haveLakes = showClimate && cells.lake;
    // Rivers are NO LONGER drawn cell-by-cell -- we paint them
    // afterward as proper splines (see below). Lakes and biomes
    // still render per-pixel.
    for (let i = 0; i < W * H; i++) {
      const cellIdx = pixelToCell[i];
      const elev = cells.elevations[cellIdx];
      let c;
      if (haveLakes && cells.lake[cellIdx]) {
        c = PLANET_BIOMES_COLORS[0];          // closed-basin lake = marine blue
      } else if (haveBiome) {
        c = PLANET_BIOMES_COLORS[cells.biome[cellIdx]];
      } else {
        c = _planetColorForHeight(elev, seaLevel);
      }
      const k = i * 4;
      data[k    ] = Math.max(0, Math.min(255, Math.round(c[0] * 255)));
      data[k + 1] = Math.max(0, Math.min(255, Math.round(c[1] * 255)));
      data[k + 2] = Math.max(0, Math.min(255, Math.round(c[2] * 255)));
      data[k + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    // §planet-spec Phase 7.e-rivers -- spline river overlay. Each
    // river in cells.riverPaths is a chain of cell indices. We
    // project each cell's center to canvas (px, py) via its 3D
    // unit-sphere position, then stroke a smoothed polyline using
    // quadraticCurveTo (Bezier midpoint smoothing). Stroke width
    // scales with the mouthFlux, so a small tributary draws thin
    // and a major river draws thicker. Date-line crossings break
    // the path (otherwise we'd stroke across the whole canvas).
    if (showClimate && cells.riverPaths && cells.riverPaths.length > 0) {
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(35, 80, 140, 0.92)";
      for (const river of cells.riverPaths) {
        const path = river.cells;
        if (!path || path.length < 2) continue;
        const w = Math.max(0.6, Math.min(4.0, Math.sqrt((river.mouthFlux || 30) / 30)));
        ctx.lineWidth = w;
        const pts = new Array(path.length);
        for (let i = 0; i < path.length; i++) {
          const ci = path[i];
          const cx = cells.positions[ci*3];
          const cy = cells.positions[ci*3+1];
          const cz = cells.positions[ci*3+2];
          const lat = Math.asin(Math.max(-1, Math.min(1, cy))) * 180 / Math.PI;
          const lon = Math.atan2(cz, cx) * 180 / Math.PI;
          pts[i] = [(lon + 180) / 360 * W, (90 - lat) / 180 * H];
        }
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          const cur = pts[i], nxt = pts[i + 1];
          // Date-line crossing: stroke + start a new sub-path.
          if (Math.abs(cur[0] - nxt[0]) > W * 0.5 || Math.abs(cur[0] - pts[i-1][0]) > W * 0.5) {
            ctx.stroke(); ctx.beginPath(); ctx.moveTo(cur[0], cur[1]);
            continue;
          }
          const mx = (cur[0] + nxt[0]) * 0.5;
          const my = (cur[1] + nxt[1]) * 0.5;
          ctx.quadraticCurveTo(cur[0], cur[1], mx, my);
        }
        // Final segment
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        if (Math.abs(prev[0] - last[0]) <= W * 0.5) ctx.lineTo(last[0], last[1]);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Draw the locked continent-target as a crosshair on top so the
    // user sees where re-roll will place the first cap.
    if (lockedCenter) {
      const py = Math.floor(((90 - lockedCenter.lat) / 180) * H);
      const px = Math.floor(((lockedCenter.lon + 180) / 360) * W);
      ctx.save();
      ctx.strokeStyle = "rgba(255, 220, 90, 0.95)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px - 8, py); ctx.lineTo(px + 8, py);
      ctx.moveTo(px, py - 8); ctx.lineTo(px, py + 8); ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
  render();

  // Brush controls state.
  let brushRadiusDeg = 8;
  let brushStrength = 0.025;
  let mode = "raise";
  let painting = false;
  let dirty = false;
  const sizeIn = modal.querySelector("#pmap-size");
  const sizeV  = modal.querySelector("#pmap-size-v");
  const strIn  = modal.querySelector("#pmap-str");
  const strV   = modal.querySelector("#pmap-str-v");
  sizeIn.addEventListener("input", () => {
    brushRadiusDeg = +sizeIn.value;
    sizeV.textContent = brushRadiusDeg + "°";
  });
  strIn.addEventListener("input", () => {
    brushStrength = (+strIn.value) / 1000;
    strV.textContent = brushStrength.toFixed(3);
  });
  modal.querySelectorAll('input[name="pmap-mode"]').forEach(r => {
    r.addEventListener("change", () => { if (r.checked) mode = r.value; });
  });

  // Undo / redo stacks of Float32Array snapshots. Each "stroke"
  // (pointerdown -> pointerup) or whole-canvas operation (revert,
  // import) pushes ONE snapshot of cells.elevations to undoStack.
  // Cap depth so memory doesn't blow up at large N.
  const UNDO_MAX = 30;
  const undoStack = [];
  const redoStack = [];
  function pushUndo() {
    undoStack.push(new Float32Array(cells.elevations));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;  // any new edit clears the redo history
    updateUndoUI();
  }
  function applySnapshot(snap) {
    for (let i = 0; i < cells.elevations.length; i++) cells.elevations[i] = snap[i];
    node._cellsVersion = ((typeof node._cellsVersion === "number") ? node._cellsVersion : 0) + 1;
    dirty = true;
    render();
  }
  function doUndo() {
    if (undoStack.length === 0) return;
    redoStack.push(new Float32Array(cells.elevations));
    if (redoStack.length > UNDO_MAX) redoStack.shift();
    applySnapshot(undoStack.pop());
    updateUndoUI();
  }
  function doRedo() {
    if (redoStack.length === 0) return;
    undoStack.push(new Float32Array(cells.elevations));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    applySnapshot(redoStack.pop());
    updateUndoUI();
  }
  const undoBtn = modal.querySelector("#pmap-undo");
  const redoBtn = modal.querySelector("#pmap-redo");
  function updateUndoUI() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
    undoBtn.title = "Undo last stroke (Ctrl+Z) [" + undoStack.length + "]";
    redoBtn.title = "Redo (Ctrl+Y) [" + redoStack.length + "]";
  }
  undoBtn.addEventListener("click", doUndo);
  redoBtn.addEventListener("click", doRedo);
  updateUndoUI();
  // Keyboard shortcuts -- scoped to the modal so they don't interfere
  // with other editor inputs. We attach to the modal-backdrop which
  // has focus while the modal is open.
  const kbHandler = (ev) => {
    if (!document.body.contains(back)) return;
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === "z" && !ev.shiftKey) {
      ev.preventDefault(); doUndo();
    } else if ((ev.ctrlKey || ev.metaKey) && (k === "y" || (k === "z" && ev.shiftKey))) {
      ev.preventDefault(); doRedo();
    }
  };
  window.addEventListener("keydown", kbHandler);

  // Zoom controls. The canvas lives inside canvasInner which we
  // CSS-transform; canvasWrap is the scroll container. Pointer
  // coordinate math uses getBoundingClientRect() which already
  // accounts for the CSS scale.
  const ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8];
  let zoomIdx = 0;
  const zoomVSpan = modal.querySelector("#pmap-zoom-v");
  function applyZoom() {
    const z = ZOOM_LEVELS[zoomIdx];
    canvasInner.style.transform = "scale(" + z + ")";
    canvasInner.style.width  = (W * z) + "px";
    canvasInner.style.height = (H * z) + "px";
    zoomVSpan.textContent = Math.round(z * 100) + "%";
  }
  modal.querySelector("#pmap-zoom-in").addEventListener("click", () => {
    if (zoomIdx < ZOOM_LEVELS.length - 1) { zoomIdx++; applyZoom(); }
  });
  modal.querySelector("#pmap-zoom-out").addEventListener("click", () => {
    if (zoomIdx > 0) { zoomIdx--; applyZoom(); }
  });
  modal.querySelector("#pmap-zoom-fit").addEventListener("click", () => {
    zoomIdx = 0; applyZoom();
    canvasWrap.scrollLeft = 0; canvasWrap.scrollTop = 0;
  });
  // Wheel zoom on canvas: shift+wheel zooms; wheel alone scrolls.
  canvasWrap.addEventListener("wheel", (ev) => {
    if (!ev.shiftKey) return;
    ev.preventDefault();
    if (ev.deltaY < 0 && zoomIdx < ZOOM_LEVELS.length - 1) { zoomIdx++; applyZoom(); }
    else if (ev.deltaY > 0 && zoomIdx > 0)                  { zoomIdx--; applyZoom(); }
  }, { passive: false });

  modal.querySelector("#pmap-revert").addEventListener("click", () => {
    pushUndo();
    for (let i = 0; i < cells.elevations.length; i++) cells.elevations[i] = elevSnapshot[i];
    dirty = true;
    node._cellsVersion = ((typeof node._cellsVersion === "number") ? node._cellsVersion : 0) + 1;
    render();
  });

  // Climate toggle. First click computes climate + rivers (~50-200ms,
  // cached on the node), turns on biome+river overlay; subsequent
  // clicks just toggle visibility. Painting / template re-rolls
  // invalidate the cache via _cellsVersion so the next "show climate"
  // recomputes.
  const climateBtn = modal.querySelector("#pmap-climate");
  climateBtn.addEventListener("click", () => {
    if (!showClimate) {
      _ensurePlanetClimate(node, seaLevel);
      _ensurePlanetRivers(node, seaLevel);
      showClimate = true;
      climateBtn.textContent = "hide climate";
    } else {
      showClimate = false;
      climateBtn.textContent = "show climate";
    }
    render();
  });

  // Configure World -- climate settings modal (Azgaar parity).
  modal.querySelector("#pmap-climate-config").addEventListener("click", () => {
    openClimateConfigModal(node, () => {
      // Climate config changed; cache key now mismatches. Force a
      // recompute + redraw + invalidate the cubemap so PlanetMesh
      // picks up the new biomes on the next chunk rebuild.
      node._climateKey = null;
      if (showClimate) {
        _ensurePlanetClimate(node, seaLevel);
        _ensurePlanetRivers(node, seaLevel);
        render();
      }
      dirty = true;
      pushHistory("planet-map-edit:climate");
    });
  });

  // Import GeoJSON: stamps an Azgaar FMG Cells GeoJSON's landmass
  // onto this planet's cell graph. Deterministic alternative to AI
  // generation -- the dropped file's land polygons become this
  // planet's landmass shape exactly.
  const geoBtn = modal.querySelector("#pmap-geojson");
  const geoFileIn = modal.querySelector("#pmap-geojson-file");
  geoBtn.addEventListener("click", () => geoFileIn.click());
  geoFileIn.addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    geoBtn.disabled = true;
    const origLabel = geoBtn.textContent;
    geoBtn.textContent = "...";
    try {
      const text = await file.text();
      const geojson = JSON.parse(text);
      pushUndo();  // snapshot pre-import so Ctrl+Z reverts
      const stats = await _planetStampLandmass(
        geojson, cells, node._cellNeighbors, node._cellNeighborsK, seaLevel,
        (msg) => { geoBtn.textContent = msg.length > 22 ? msg.slice(0, 20) + "…" : msg; }
      );
      dirty = true;
      // Invalidate climate / rivers cache, then redraw.
      node._cellsVersion = ((typeof node._cellsVersion === "number") ? node._cellsVersion : 0) + 1;
      render();
      console.log("[planet-map] stamped GeoJSON: "
        + stats.landFeatures + "/" + stats.featuresProcessed + " land features, "
        + (stats.landFraction * 100).toFixed(1) + "% land, "
        + "raster=" + stats.rasterMs + "ms stamp=" + stats.stampMs + "ms");
      geoBtn.textContent = "stamped " + (stats.landFraction * 100).toFixed(0) + "% land";
      setTimeout(() => { geoBtn.textContent = origLabel; }, 3000);
    } catch (e) {
      console.error("[planet-map] geojson import failed:", e);
      geoBtn.textContent = "error";
      alert("GeoJSON import failed: " + e.message);
      setTimeout(() => { geoBtn.textContent = origLabel; }, 3000);
    } finally {
      geoBtn.disabled = false;
      // Reset the input so the same file can be picked again.
      geoFileIn.value = "";
    }
  });

  // Apply one brush stamp at pixel (px, py).
  // Brush modes -- each mode is its own elevation transform applied
  // to cells under the brush (with smoothstep falloff from center).
  // The seaLevel constant here matches Azgaar's 0..1 logical scale
  // (sea level at 0.20) which the postDSL piecewise remap converts
  // to the user's final seaLevel. Target heights are in the same
  // scale so brushes work consistently across cell counts.
  function stamp(px, py) {
    const lat = Math.PI * 0.5 - ((py + 0.5) / H) * Math.PI;
    const lon = ((px + 0.5) / W) * (Math.PI * 2) - Math.PI;
    const clat = Math.cos(lat), slat = Math.sin(lat);
    const cx = clat * Math.sin(lon);
    const cy = slat;
    const cz = clat * Math.cos(lon);
    const radRad = brushRadiusDeg * Math.PI / 180;
    const cosThresh = Math.cos(radRad);

    // Pass 1: collect cells inside the brush with their falloff weights.
    // For modes that average or pull toward a target (smooth, mountain,
    // plain, valley, ridge) we need to look at the full population
    // before writing -- so a 2-pass approach (gather then apply).
    const hits = []; // [{ i, weight }]
    for (let i = 0; i < cells.count; i++) {
      const ix = i * 3;
      const dot = cx * cells.positions[ix] + cy * cells.positions[ix + 1] + cz * cells.positions[ix + 2];
      if (dot < cosThresh) continue;
      const t = (dot - cosThresh) / Math.max(1e-6, 1 - cosThresh);
      const fall = t * t * (3 - 2 * t);  // smoothstep
      hits.push({ i, w: fall });
    }
    if (hits.length === 0) { dirty = true; render(); return; }

    // Per-mode application.
    if (mode === "raise" || mode === "lower") {
      const sign = (mode === "raise") ? 1 : -1;
      for (const h of hits) {
        cells.elevations[h.i] = Math.max(0, Math.min(1, cells.elevations[h.i] + sign * brushStrength * h.w));
      }
    } else if (mode === "smooth") {
      // Pull each hit toward the local average. Falloff scales the pull.
      let sum = 0;
      for (const h of hits) sum += cells.elevations[h.i];
      const avg = sum / hits.length;
      for (const h of hits) {
        const cur = cells.elevations[h.i];
        cells.elevations[h.i] = cur + (avg - cur) * brushStrength * 10 * h.w;
      }
    } else if (mode === "mountain") {
      // Raise toward height 0.85 (mountain) with center bias.
      const TARGET = 0.85;
      for (const h of hits) {
        const cur = cells.elevations[h.i];
        if (cur >= TARGET) continue;
        const pull = (TARGET - cur) * brushStrength * 4 * h.w;
        cells.elevations[h.i] = Math.min(1, cur + pull);
      }
    } else if (mode === "plain") {
      // Pull toward height 0.30 (slightly above sealevel). Lowers
      // mountains, raises ocean cells just barely above water.
      const TARGET = 0.30;
      for (const h of hits) {
        const cur = cells.elevations[h.i];
        const pull = (TARGET - cur) * brushStrength * 4 * h.w;
        cells.elevations[h.i] = Math.max(0, Math.min(1, cur + pull));
      }
    } else if (mode === "valley") {
      // Pull toward height 0.22 (just barely above sealevel). Carves
      // valleys into mountains without flipping land to ocean.
      const TARGET = 0.22;
      for (const h of hits) {
        const cur = cells.elevations[h.i];
        if (cur <= TARGET) continue;
        const pull = (cur - TARGET) * brushStrength * 4 * h.w;
        cells.elevations[h.i] = Math.max(0, cur - pull);
      }
    } else if (mode === "ridge") {
      // Like mountain but more aggressive in the center, no effect at edges.
      // Concentric falloff: cells nearer center get pulled to higher targets.
      for (const h of hits) {
        const target = 0.30 + 0.55 * h.w;  // 0.30 at edge, 0.85 at center
        const cur = cells.elevations[h.i];
        if (cur >= target) continue;
        const pull = (target - cur) * brushStrength * 4;
        cells.elevations[h.i] = Math.min(1, cur + pull);
      }
    }
    dirty = true;
    render();
  }

  // Pointer events. Shift-click sets the continent-target lock for
  // re-roll instead of painting -- so the next template apply places
  // its first cap where you clicked. Subsequent re-rolls keep using
  // the locked point until "clear target" or another shift-click.
  canvas.addEventListener("pointerdown", (ev) => {
    const r = canvas.getBoundingClientRect();
    const px = Math.floor((ev.clientX - r.left) / r.width * W);
    const py = Math.floor((ev.clientY - r.top) / r.height * H);
    canvas.setPointerCapture(ev.pointerId);
    // Snapshot BEFORE this stroke so Ctrl+Z restores the pre-stroke state.
    pushUndo();
    painting = true;
    stamp(px, py);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!painting) return;
    const r = canvas.getBoundingClientRect();
    const px = Math.floor((ev.clientX - r.left) / r.width * W);
    const py = Math.floor((ev.clientY - r.top) / r.height * H);
    stamp(px, py);
  });
  function endPaint(ev) {
    if (painting) {
      painting = false;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
    }
  }
  canvas.addEventListener("pointerup", endPaint);
  canvas.addEventListener("pointercancel", endPaint);
  canvas.addEventListener("pointerleave", endPaint);

  // Close handler: bump cellsVersion so the cubemap re-bakes from
  // the painted cells. We do NOT immediately re-bake here (potentially
  // 100-500ms hang); the next _ensurePlanetMapCubemap call (triggered
  // by Planet's next chunk build) does it under whatever stream
  // budget exists.
  function closeModal() {
    if (dirty) {
      node._cellsVersion = ((typeof node._cellsVersion === "number") ? node._cellsVersion : 0) + 1;
      // Clear cached cubemap so the next access re-bakes from cells.
      // Also clear params.cubemapData so the stale .gpatch-serialized
      // version doesn't get used on next load.
      node._cubemap = null;
      node._cubemapKey = null;
      if (node.params) {
        delete node.params.cubemapData;
        delete node.params.cubemapDataRes;
        delete node.params.cubemapKey;
      }
      pushHistory("planet-map-edit:apply");
    }
    window.removeEventListener("keydown", kbHandler);
    back.remove();
  }
  modal.querySelector("#pmap-close").addEventListener("click", closeModal);
  back.addEventListener("click", (ev) => { if (ev.target === back) closeModal(); });
}

function openTilingConfigPopup(nodeId) {
  const node = state && state.nodes && state.nodes.find(n => n && n.id === nodeId);
  if (!node || node.type !== "TiledTerrain") return;
  // Snapshot original params for an undo on cancel.
  const original = JSON.parse(JSON.stringify(node.params || {}));
  pushHistory("tiling-config:open");

  // Build modal. Reuse the existing .modal-backdrop / .modal CSS.
  // Tear down any prior tiling-config modal first (single instance).
  let prev = document.getElementById("tiling-config-modal");
  if (prev) prev.remove();
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id        = "tiling-config-modal";
  back.style.display = "flex";
  back.style.zIndex = 60;
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.width = "440px";
  modal.style.maxHeight = "85vh";
  modal.style.overflowY = "auto";
  modal.innerHTML = `
    <div class="modal-head">
      <span class="modal-title" style="font-family: var(--font-instr); letter-spacing: 0.18em; color: var(--phosphor); text-transform: lowercase;">tiling config · ${node.type}#${node.id}</span>
      <button class="btn modal-x" id="tiling-close" type="button">×</button>
    </div>
    <div id="tiling-body" style="padding: 14px 18px 18px;"></div>
  `;
  back.appendChild(modal);
  document.body.appendChild(back);

  const body = modal.querySelector("#tiling-body");

  // §5.5.e-3 -- 2D chunk-grid preview at the top of the popup. Live
  // canvas showing all chunks colored by LOD ring, plus the wired
  // camera position + heading. Click a chunk in MANUAL anchor mode
  // to set centerX/centerZ to that chunk's center.
  const previewWrap = document.createElement("div");
  previewWrap.style.cssText =
    "margin-bottom:12px;display:flex;flex-direction:column;align-items:center;gap:6px;";
  const preview = document.createElement("canvas");
  preview.width  = 360;
  preview.height = 360;
  preview.style.cssText =
    "width:360px;height:360px;background:rgba(8,12,20,0.85);" +
    "border:1px solid var(--border);border-radius:3px;cursor:crosshair;";
  previewWrap.appendChild(preview);
  const previewLegend = document.createElement("div");
  previewLegend.style.cssText =
    "font-family:var(--font-mono);font-size:10px;color:var(--text-3);" +
    "display:flex;gap:14px;align-items:center;";
  previewLegend.innerHTML =
    `<span><span style="color:rgba(110,220,180,0.9);">█</span> inner LOD</span>` +
    `<span><span style="color:rgba(160,200,140,0.85);">█</span> mid LOD</span>` +
    `<span><span style="color:rgba(180,170,120,0.7);">█</span> outer LOD</span>` +
    `<span><span style="color:rgba(180,240,255,1);">●</span> camera</span>`;
  previewWrap.appendChild(previewLegend);
  body.appendChild(previewWrap);

  // Live-stats line. Recomputed on every input change.
  const stats = document.createElement("div");
  stats.id = "tiling-stats";
  stats.style.cssText =
    "margin-bottom:14px;padding:8px 10px;background:var(--surface-2);" +
    "border:1px solid var(--border);border-radius:3px;" +
    "font-family:var(--font-mono);font-size:11px;line-height:1.55;" +
    "color:var(--text-2);";
  body.appendChild(stats);

  const makeRow = (label, key, kind, opts) => {
    const row = document.createElement("div");
    row.className = "modal-field";
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin:7px 0;";
    const lbl = document.createElement("div");
    lbl.className = "modal-field-label";
    lbl.textContent = label;
    lbl.style.cssText = "flex:0 0 130px;font-size:12px;color:var(--text-2);";
    row.appendChild(lbl);
    let input;
    if (kind === "select") {
      input = document.createElement("select");
      input.style.cssText = "flex:1;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:var(--font-mono);font-size:12px;";
      (opts.options || []).forEach(o => {
        const op = document.createElement("option");
        op.value = o; op.textContent = o;
        if (o === (node.params || {})[key]) op.selected = true;
        input.appendChild(op);
      });
    } else if (kind === "checkbox") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!(node.params || {})[key];
    } else {
      input = document.createElement("input");
      input.type = "number";
      if (opts && typeof opts.step === "number") input.step = opts.step;
      if (opts && typeof opts.min  === "number") input.min  = opts.min;
      if (opts && typeof opts.max  === "number") input.max  = opts.max;
      input.value = (node.params || {})[key];
      input.style.cssText = "flex:1;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:var(--font-mono);font-size:12px;text-align:right;";
    }
    input.addEventListener("input", () => {
      node.params = node.params || {};
      if (kind === "checkbox") {
        node.params[key] = input.checked ? 1 : 0;
      } else if (kind === "select") {
        node.params[key] = input.value;
        refreshAnchorVisibility();
      } else {
        const v = parseFloat(input.value);
        if (!Number.isNaN(v)) node.params[key] = v;
      }
      refreshStats();
      // Re-render the editor canvas so the node label updates if
      // any port-derived UI changes. The visual preview will pick
      // up the new mesh on its next frame (cache key changes).
      render();
      refreshPreview();
    });
    row.appendChild(input);
    return { row, input };
  };

  // 2D chunk-grid preview drawer. Draws every chunk colored by its
  // LOD ring + camera dot/heading on top. Click in MANUAL mode to
  // set centerX/centerZ to the clicked chunk's center.
  const refreshPreview = () => {
    const ctx = preview.getContext("2d");
    const W = preview.width, H = preview.height;
    ctx.clearRect(0, 0, W, H);
    const p = node.params || {};
    const r  = Math.max(0, Math.floor(p.chunkRadius || 0));
    const s  = Math.max(2, Math.floor(p.segments    || 2));
    const cs = Math.max(1, p.chunkSize || 64);
    const diameter = (2 * r + 1) * cs;
    const scale    = Math.min(W, H) / (diameter * 1.05);
    // Anchor center in world space.
    const anchorWX = (p.anchorMode === "manual")
      ? (p.centerX || 0)
      : (() => {
          const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
          return (cam && cam.params && typeof cam.params.posX === "number") ? cam.params.posX : 0;
        })();
    const anchorWZ = (p.anchorMode === "manual")
      ? (p.centerZ || 0)
      : (() => {
          const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
          return (cam && cam.params && typeof cam.params.posZ === "number") ? cam.params.posZ : 0;
        })();
    const centerTileX = Math.round(anchorWX / cs);
    const centerTileZ = Math.round(anchorWZ / cs);
    // World -> canvas helpers.
    const wx0 = centerTileX * cs;
    const wz0 = centerTileZ * cs;
    const toMx = (wx) => W * 0.5 + (wx - wx0) * scale;
    const toMz = (wz) => H * 0.5 + (wz - wz0) * scale;

    const lodFor = (ring) => {
      if (r <= 0) return s;
      const t = ring / r;
      if (t <= 0.40) return s;
      if (t <= 0.70) return Math.max(2, s >> 1);
      return Math.max(2, s >> 2);
    };
    const colorFor = (seg) => {
      if (seg === s)                          return "rgba(110, 220, 180, 0.55)";
      else if (seg === Math.max(2, s >> 1))   return "rgba(160, 200, 140, 0.45)";
      else                                    return "rgba(180, 170, 120, 0.30)";
    };

    // Fill chunks by LOD color.
    for (let cz = -r; cz <= r; cz++) {
      for (let cx = -r; cx <= r; cx++) {
        const tileX = centerTileX + cx;
        const tileZ = centerTileZ + cz;
        const x0 = toMx(tileX * cs - cs * 0.5);
        const z0 = toMz(tileZ * cs - cs * 0.5);
        const x1 = toMx(tileX * cs + cs * 0.5);
        const z1 = toMz(tileZ * cs + cs * 0.5);
        const ring = Math.max(Math.abs(cx), Math.abs(cz));
        ctx.fillStyle = colorFor(lodFor(ring));
        ctx.fillRect(x0, z0, x1 - x0, z1 - z0);
      }
    }
    // Grid lines.
    ctx.strokeStyle = "rgba(110, 220, 180, 0.18)";
    ctx.lineWidth = 0.5;
    for (let i = -r; i <= r + 1; i++) {
      const px = toMx((centerTileX + i - 0.5) * cs);
      const pyA = toMz((centerTileZ - r - 0.5) * cs);
      const pyB = toMz((centerTileZ + r + 0.5) * cs);
      ctx.beginPath(); ctx.moveTo(px, pyA); ctx.lineTo(px, pyB); ctx.stroke();
      const py = toMz((centerTileZ + i - 0.5) * cs);
      const pxA = toMx((centerTileX - r - 0.5) * cs);
      const pxB = toMx((centerTileX + r + 0.5) * cs);
      ctx.beginPath(); ctx.moveTo(pxA, py); ctx.lineTo(pxB, py); ctx.stroke();
    }
    // Highlight center tile.
    ctx.strokeStyle = "rgba(180, 240, 255, 0.85)";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(
      toMx(centerTileX * cs - cs * 0.5),
      toMz(centerTileZ * cs - cs * 0.5),
      cs * scale, cs * scale
    );
    // Camera dot + heading line. Uses live posX/posZ + yaw from the
    // wired camera so the preview reflects exactly where the player is.
    const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
    if (cam && cam.params) {
      const cpx = (typeof cam.params.posX === "number") ? cam.params.posX : 0;
      const cpz = (typeof cam.params.posZ === "number") ? cam.params.posZ : 0;
      const cyw = (typeof cam.params.yaw === "number") ? cam.params.yaw : 0;
      const mx = toMx(cpx);
      const my = toMz(cpz);
      const len = 22;
      ctx.strokeStyle = "rgba(140, 220, 255, 0.95)";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + Math.sin(cyw) * len, my + Math.cos(cyw) * len);
      ctx.stroke();
      ctx.fillStyle = "rgba(180, 240, 255, 1)";
      ctx.beginPath();
      ctx.arc(mx, my, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Scale label.
    ctx.fillStyle = "rgba(110, 220, 180, 0.85)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(`${Math.round(diameter).toLocaleString()}u square`, 8, 14);
    ctx.fillText(`tile ${centerTileX},${centerTileZ}`, 8, H - 8);
  };

  // Click-to-set anchor: in manual mode, clicking a chunk sets
  // centerX/centerZ to that chunk's center. In auto mode, clicks
  // are ignored (camera drives anchor).
  preview.addEventListener("click", (ev) => {
    const p = node.params || {};
    if (p.anchorMode !== "manual") return;
    const r  = Math.max(0, Math.floor(p.chunkRadius || 0));
    const cs = Math.max(1, p.chunkSize || 64);
    const diameter = (2 * r + 1) * cs;
    const W = preview.width, H = preview.height;
    const scale    = Math.min(W, H) / (diameter * 1.05);
    const rect = preview.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * (W / rect.width);
    const my = (ev.clientY - rect.top)  * (H / rect.height);
    // Convert canvas xy back to world coords. centerTileX/Z = 0 at
    // canvas center (manual mode, no camera offset baked in).
    const wx = (mx - W * 0.5) / scale + (p.centerX || 0);
    const wz = (my - H * 0.5) / scale + (p.centerZ || 0);
    const tileX = Math.round(wx / cs);
    const tileZ = Math.round(wz / cs);
    node.params.centerX = tileX * cs;
    node.params.centerZ = tileZ * cs;
    render();
    refreshStats();
    refreshPreview();
  });

  const refreshStats = () => {
    const p = node.params || {};
    const r = Math.max(0, Math.floor(p.chunkRadius || 0));
    const s = Math.max(2, Math.floor(p.segments    || 2));
    // Walk the chunk grid the same way _buildTiledTerrain does so
    // the LOD distribution is reflected in vert / index totals. Each
    // chunk's vert count = (segs+1)² grid + 4*(segs+1) skirt-bottom
    // verts; index count = segs²*6 grid + 4*segs*6 skirt quads.
    let chunks = 0, verts = 0, inds = 0;
    const lodFor = (ring) => {
      if (r <= 0) return s;
      const t = ring / r;
      if (t <= 0.20) return s;
      if (t <= 0.40) return Math.max(2, s >> 1);
      if (t <= 0.60) return Math.max(2, s >> 2);
      if (t <= 0.80) return Math.max(2, s >> 3);
      return 2;
    };
    let lod0 = 0, lod1 = 0, lod2 = 0, lod3 = 0, lod4 = 0;
    for (let cz = -r; cz <= r; cz++) {
      for (let cx = -r; cx <= r; cx++) {
        const ring = Math.max(Math.abs(cx), Math.abs(cz));
        const seg = lodFor(ring);
        const N = seg + 1;
        verts += N * N + 4 * N;
        inds  += seg * seg * 6 + 4 * seg * 6;
        chunks++;
        if (seg === s)                              lod0++;
        else if (seg === Math.max(2, s >> 1))       lod1++;
        else if (seg === Math.max(2, s >> 2))       lod2++;
        else if (seg === Math.max(2, s >> 3))       lod3++;
        else                                        lod4++;
      }
    }
    const bytes = verts * 44 + inds * 4;
    const fmtMem = (b) => (b < 1024)
      ? b + " B"
      : (b < 1024 * 1024)
        ? (b / 1024).toFixed(1) + " kB"
        : (b / (1024 * 1024)).toFixed(2) + " MB";
    const worldExtent = (2 * r + 1) * (p.chunkSize || 64);
    stats.innerHTML =
      `<div>chunks    : <span style="color:var(--phosphor);">${chunks}</span> (${2*r+1}×${2*r+1})</div>` +
      `<div>LOD split : <span style="color:var(--phosphor);">${lod0}/${lod1}/${lod2}/${lod3}/${lod4}</span> (LOD 0..4)</div>` +
      `<div>verts     : <span style="color:var(--phosphor);">${verts.toLocaleString()}</span> (incl. skirts)</div>` +
      `<div>triangles : <span style="color:var(--phosphor);">${(inds/3).toLocaleString()}</span></div>` +
      `<div>memory    : <span style="color:var(--phosphor);">${fmtMem(bytes)}</span></div>` +
      `<div>world     : <span style="color:var(--phosphor);">${worldExtent.toLocaleString()}u</span> square</div>`;
  };

  // Section: chunking
  const secChunk = document.createElement("div");
  secChunk.style.cssText = "margin-top:6px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secChunk.textContent = "chunking";
  body.appendChild(secChunk);
  body.appendChild(makeRow("chunk size (units)", "chunkSize",   "number", { step: 1, min: 1 }).row);
  body.appendChild(makeRow("chunk radius",       "chunkRadius", "number", { step: 1, min: 0, max: 16 }).row);
  body.appendChild(makeRow("segments / chunk",   "segments",    "number", { step: 1, min: 1, max: 64 }).row);

  // Section: anchor
  const secAnchor = document.createElement("div");
  secAnchor.style.cssText = "margin-top:14px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secAnchor.textContent = "anchor";
  body.appendChild(secAnchor);
  body.appendChild(makeRow("anchor mode", "anchorMode", "select", { options: ["auto", "manual"] }).row);
  const centerXEntry = makeRow("center X (manual)", "centerX", "number", { step: 1 });
  const centerZEntry = makeRow("center Z (manual)", "centerZ", "number", { step: 1 });
  body.appendChild(centerXEntry.row);
  body.appendChild(centerZEntry.row);
  const refreshAnchorVisibility = () => {
    const manual = (node.params || {}).anchorMode === "manual";
    centerXEntry.row.style.display = manual ? "" : "none";
    centerZEntry.row.style.display = manual ? "" : "none";
  };

  // Section: noise
  const secNoise = document.createElement("div");
  secNoise.style.cssText = "margin-top:14px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secNoise.textContent = "heightmap noise";
  body.appendChild(secNoise);
  body.appendChild(makeRow("height scale",  "heightScale", "number", { step: 1 }).row);
  body.appendChild(makeRow("y offset",      "yOffset",     "number", { step: 1 }).row);
  body.appendChild(makeRow("seed",          "seed",        "number", { step: 0.1 }).row);
  body.appendChild(makeRow("frequency",     "frequency",   "number", { step: 0.005 }).row);
  body.appendChild(makeRow("octaves",       "octaves",     "number", { step: 1, min: 1, max: 8 }).row);
  body.appendChild(makeRow("lacunarity",    "lacunarity",  "number", { step: 0.05 }).row);
  body.appendChild(makeRow("gain",          "gain",        "number", { step: 0.05 }).row);
  body.appendChild(makeRow("ridges (0..1)", "ridges",      "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("plateau (0..1)", "plateau",    "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("forward bias",   "forwardBias","number", { step: 0.05, min: 0, max: 1 }).row);

  // Section: island mode.
  const secIsland = document.createElement("div");
  secIsland.style.cssText = "margin-top:14px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secIsland.textContent = "island mode";
  body.appendChild(secIsland);
  body.appendChild(makeRow("mode",              "islandMode",          "select", { options: ["off", "single", "archipelago"] }).row);
  body.appendChild(makeRow("sink depth (m)",    "islandSinkDepth",     "number", { step: 100, min: 0 }).row);
  // single-mode rows
  body.appendChild(makeRow("[single] center X", "islandCenterX",       "number", { step: 50 }).row);
  body.appendChild(makeRow("[single] center Z", "islandCenterZ",       "number", { step: 50 }).row);
  body.appendChild(makeRow("[single] radius",   "islandRadius",        "number", { step: 50, min: 1 }).row);
  body.appendChild(makeRow("[single] falloff",  "islandFalloff",       "number", { step: 0.1, min: 0.5 }).row);
  // archipelago-mode rows
  body.appendChild(makeRow("[archipelago] mask freq",      "islandMaskFreq",      "number", { step: 0.00002, min: 0.00001 }).row);
  body.appendChild(makeRow("[archipelago] mask seed",      "islandMaskSeed",      "number", { step: 0.1 }).row);
  body.appendChild(makeRow("[archipelago] threshold",      "islandMaskThreshold", "number", { step: 0.02, min: 0.0, max: 1.0 }).row);
  body.appendChild(makeRow("[archipelago] softness",       "islandMaskSoftness",  "number", { step: 0.01, min: 0.01, max: 0.5 }).row);

  // Section: erosion (baked into chunks at build time).
  const secErosion = document.createElement("div");
  secErosion.style.cssText = "margin-top:14px;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.15em;";
  secErosion.textContent = "erosion (baked at build)";
  body.appendChild(secErosion);
  body.appendChild(makeRow("strength (0=off)",      "erosionStrength",   "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("thermal",               "erosionThermal",    "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("hydraulic",             "erosionHydraulic",  "number", { step: 0.05, min: 0, max: 1 }).row);
  body.appendChild(makeRow("talus angle",           "erosionTalus",      "number", { step: 0.005 }).row);
  body.appendChild(makeRow("iterations",            "erosionIterations", "number", { step: 1, min: 1, max: 12 }).row);
  body.appendChild(makeRow("radius (world units)",  "erosionRadius",     "number", { step: 5, min: 1 }).row);

  // Footer with revert + done buttons.
  const foot = document.createElement("div");
  foot.style.cssText = "margin-top:18px;display:flex;justify-content:space-between;gap:10px;";
  const revert = document.createElement("button");
  revert.className = "btn";
  revert.textContent = "revert";
  revert.addEventListener("click", () => {
    node.params = original;
    back.remove();
    render();
  });
  const done = document.createElement("button");
  done.className = "btn";
  done.textContent = "done";
  done.addEventListener("click", () => { back.remove(); });
  foot.appendChild(revert);
  foot.appendChild(done);
  body.appendChild(foot);

  modal.querySelector("#tiling-close").addEventListener("click", () => back.remove());
  back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });

  refreshAnchorVisibility();
  refreshStats();
  refreshPreview();
}

// Phase 8.D.1 -- UI/HUD nodes are non-C++; the per-node edit modal
// switches into a "render-code" mode that hides the cppType + ports
// sections and just shows a JS code editor for the customRender
// param. Save writes back to node.params.customRender instead of
// node.override.
const _NODE_EDIT_UI_TYPES = new Set(["UIButton", "UIText", "UIPanel", "UISlider", "HUDText"]);
let _nodeEditUiMode = false;

function openNodeCodeEditor(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const def = defOf(node);
  if (!def) return;
  _nodeEditTargetId = nodeId;
  _nodeEditorOpen   = true;
  _nodeEditUiMode   = _NODE_EDIT_UI_TYPES.has(node.type);

  // 8.D.1 -- show/hide sections based on UI vs C++ mode.
  const rawView = document.getElementById("node-edit-raw-view");
  const sections = rawView ? rawView.querySelectorAll(":scope > .node-edit-section") : [];
  const modeBtn = document.getElementById("btn-node-edit-mode");
  const noteEl  = rawView ? rawView.parentNode.querySelector(".modal-note") : null;
  const validateBtn = document.getElementById("btn-node-edit-validate");
  const exportBtn   = document.getElementById("btn-node-edit-export");
  const revertBtn   = document.getElementById("btn-node-edit-revert");
  if (_nodeEditUiMode) {
    // Hide cppType + inputs + outputs sections (indices 0,1,2);
    // keep the code section (index 3) but relabel it.
    for (let i = 0; i < sections.length; i++) {
      sections[i].style.display = (i === sections.length - 1) ? "" : "none";
    }
    const codeHead = sections.length
      ? sections[sections.length - 1].querySelector(".node-edit-section-head") : null;
    if (codeHead) codeHead.textContent = "custom render code (JS body) — free vars: ctx, p, input";
    if (modeBtn) modeBtn.style.display = "none";
    if (validateBtn) validateBtn.style.display = "none";
    if (exportBtn)   exportBtn.style.display   = "none";
    if (revertBtn)   revertBtn.style.display   = "none";
    if (noteEl) {
      noteEl.innerHTML =
        "Edit the JS body that renders this node's canvas. " +
        "Free variables: <code>ctx</code> (2D context), <code>p</code> (params), <code>input</code> ({ node, width, height, hovered, pressed }). " +
        "Leave empty to use the default render.";
    }
  } else {
    // C++ mode -- show everything, restore default labels/note.
    for (let i = 0; i < sections.length; i++) sections[i].style.display = "";
    const codeHead = sections.length >= 4
      ? sections[3].querySelector(".node-edit-section-head") : null;
    if (codeHead) codeHead.textContent = "helper class (C++ source)";
    if (modeBtn) modeBtn.style.display = "";
    if (validateBtn) validateBtn.style.display = "";
    if (exportBtn)   exportBtn.style.display   = "";
    if (revertBtn)   revertBtn.style.display   = "";
    if (noteEl) {
      noteEl.innerHTML =
        "Per-node override of helperClass code and ports. Changes apply to <em>this instance only</em>; " +
        "other nodes of the same type stay on the registry default. Recompile (▶) after saving to see the new C++ in action.";
    }
  }

  document.getElementById("node-edit-title").textContent =
    (_nodeEditUiMode ? "Edit render code · " : "Edit ") + node.type + " · " + node.id;
  // UI-mode short-circuits the rest of openNodeCodeEditor's C++
  // setup -- we don't need cppType/ports/seeds. Just seed the
  // code editor with params.customRender and show the modal.
  if (_nodeEditUiMode) {
    const initial = (node.params && typeof node.params.customRender === "string")
      ? node.params.customRender : "";
    const placeholder = initial.trim() ? initial :
      "// Replace the default render with custom canvas drawing.\n" +
      "// ctx    -- canvas 2d context\n" +
      "// p      -- node params (read-write)\n" +
      "// input  -- { node, width, height, hovered, pressed }\n" +
      "//\n" +
      "// Example:\n" +
      "//   ctx.clearRect(0, 0, input.width, input.height);\n" +
      "//   ctx.fillStyle = input.hovered ? '#9be0ff' : '#3a4a60';\n" +
      "//   ctx.fillRect(0, 0, input.width, input.height);\n" +
      "//   ctx.fillStyle = '#ffffff';\n" +
      "//   ctx.font = '16px sans-serif';\n" +
      "//   ctx.textAlign = 'center';\n" +
      "//   ctx.textBaseline = 'middle';\n" +
      "//   ctx.fillText(p.label || '', input.width/2, input.height/2);\n";
    document.getElementById("node-edit-code").value = placeholder;
    document.getElementById("node-edit-gdsp").value = "";
    _nodeEditMode = "raw";
    document.getElementById("node-edit-raw-view").style.display  = "";
    document.getElementById("node-edit-gdsp-view").style.display = "none";
    const warn = document.getElementById("node-edit-warn");
    if (warn) { warn.textContent = ""; warn.classList.remove("visible", "ok"); }
    document.getElementById("node-edit-modal").style.display = "flex";
    _initNodeEditCm();
    _setRawCode(placeholder);
    _setGdspCode("");
    setTimeout(() => {
      if (_nodeEditCmRaw) { _nodeEditCmRaw.refresh(); _nodeEditCmRaw.focus(); }
    }, 0);
    return;
  }

  // Pick the right pre-fill: helper-class nodes show their existing
  // source; template / wrapper nodes show a synthesized class so
  // EVERY node has editable C++ in the modal. Save will detect what
  // shape the user authored and write the override accordingly.
  const seed = _seedNodeEditCode(def, node);
  _nodeEditSeed = seed;        // stashed for save -- carries synth's
                               // noSigArg + className hints

  const cppTypeEl = document.getElementById("node-edit-cppType");
  // For synthesized cases the cppType field should default to the
  // synth's class name (so save's override includes a matching
  // cppType) rather than the original library type or empty string.
  cppTypeEl.value = seed.synthClassName || def.cppType || "";

  // Seed the ports tables. Deep-copy so live edits don't mutate the
  // registry until "save" is clicked.
  const insArr  = (def.ins  || []).map(p => ({ n: p.n, t: p.t }));
  const outsArr = (def.outs || []).map(p => ({ n: p.n, t: p.t }));
  // Methods + gateMethods come from the synth when we synthesized,
  // otherwise from the registry def. The synth's methods ensure that
  // every audio-input setter we emitted in the class is reflected in
  // the registry's port-name -> setter map (codegen uses methods to
  // decide which setters to call per sample).
  const methods = Object.assign({}, def.methods || {});
  const gateM   = Object.assign({}, def.gateMethods || {});
  // Synthesized classes augment with their own setter map.
  if (seed.synthClassName) {
    const synth = (def.template
      ? _classFromTemplate(def, node)
      : (def.cppType ? _classFromWrapper(def, node) : null));
    if (synth) {
      if (synth.methods)     Object.assign(methods, synth.methods);
      if (synth.gateMethods) Object.assign(gateM,   synth.gateMethods);
    }
  }
  _renderPortRows("in",  insArr,  methods, gateM);
  _renderPortRows("out", outsArr, methods, gateM);

  // Update the section header so the user knows whether they're
  // editing the original source vs a synthesized class.
  const sectionHead = document.querySelector("#node-edit-raw-view .node-edit-section:last-of-type .node-edit-section-head");
  if (sectionHead) sectionHead.textContent = seed.sectionLabel;

  const codeSrc = (seed.hint ? seed.hint + "\n" : "") + seed.source;

  // Seed the raw textarea BEFORE initializing CodeMirror so that
  // fromTextArea() reads the right initial content.
  document.getElementById("node-edit-code").value = codeSrc;
  document.getElementById("node-edit-gdsp").value = "";

  // (revertBtn was already grabbed + style.display toggled above
  // for UI vs C++ mode.) Disable when no override is recorded.
  revertBtn.disabled = !node.override;

  const warn = document.getElementById("node-edit-warn");
  warn.textContent = ""; warn.classList.remove("visible", "ok");

  // Always open in "raw" (fields) view so the structure is visible.
  _nodeEditMode = "raw";
  document.getElementById("node-edit-raw-view").style.display  = "";
  document.getElementById("node-edit-gdsp-view").style.display = "none";
  // modeBtn already grabbed at function top for the UI/C++ mode toggle.
  modeBtn.textContent = ".gdsp →";
  modeBtn.title = "Toggle between fields view and a single .gdsp source (User DSP format)";

  document.getElementById("node-edit-modal").style.display = "flex";

  // Lazy init / sync CodeMirror. fromTextArea() can only run after
  // the textarea is in the DOM AND visible; the modal must be on
  // first. Refresh after layout so CodeMirror reads the correct
  // container dimensions.
  _initNodeEditCm();
  _setRawCode(codeSrc);
  _setGdspCode("");
  setTimeout(() => {
    if (_nodeEditCmRaw)  _nodeEditCmRaw.refresh();
    if (_nodeEditCmGdsp) _nodeEditCmGdsp.refresh();
    if (_nodeEditCmRaw)  _nodeEditCmRaw.focus();
  }, 0);
}

function closeNodeCodeEditor() {
  document.getElementById("node-edit-modal").style.display = "none";
  _nodeEditorOpen   = false;
  _nodeEditTargetId = null;
}

/* Renders one ports table ("in" or "out"). Each row has:
 *   - name input (free text)
 *   - type select (audio/param/gate/clock/texture/...)
 *   - setter input (only for "in" rows of type param/gate; hidden for
 *     audio inputs since they're wired by edge, not setter)
 *   - × remove button
 *
 * The arrays + methods objects passed in are mutated as the user
 * edits, so when "save" reads them they reflect the current UI. */
function _renderPortRows(dir, arr, methods, gateM) {
  const host = document.getElementById(dir === "in" ? "node-edit-ins" : "node-edit-outs");
  host.innerHTML = "";
  arr.forEach((port, idx) => {
    const row = document.createElement("div");
    row.className = "node-port-row" + (dir === "out" ? " no-setter" : "");

    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.value = port.n;
    nameIn.placeholder = "port name";
    nameIn.addEventListener("input", () => { port.n = nameIn.value.trim(); });

    const typeSel = document.createElement("select");
    (dir === "in" ? PORT_TYPE_OPTS_IN : PORT_TYPE_OPTS_OUT).forEach(t => {
      const opt = document.createElement("option");
      opt.value = t; opt.textContent = t;
      if (t === port.t) opt.selected = true;
      typeSel.appendChild(opt);
    });
    typeSel.addEventListener("change", () => {
      port.t = typeSel.value;
      // Show/hide the setter field if the type changed in/out of
      // setter-eligible territory.
      _refreshSetterCell(row, dir, port, methods, gateM);
    });

    row.appendChild(nameIn);
    row.appendChild(typeSel);

    // Setter / method-name column (in-direction only). For audio
    // inputs we still show the column to keep the grid aligned, but
    // the input is hidden -- audio inputs don't have a setter; they're
    // wired by edge into the operator() expression.
    const methCell = document.createElement("input");
    methCell.type = "text";
    methCell.placeholder = dir === "in" ? "setter / method (e.g. setFreq)" : "";
    methCell.dataset.role = "method";
    if (dir === "in") {
      const initial = port.t === "gate"
        ? (gateM[port.n] || "")
        : (methods[port.n] || "");
      methCell.value = initial;
      methCell.addEventListener("input", () => {
        if (port.t === "gate") gateM[port.n] = methCell.value.trim();
        else methods[port.n] = methCell.value.trim();
      });
    } else {
      methCell.disabled = true;
    }
    row.appendChild(methCell);
    _refreshSetterCell(row, dir, port, methods, gateM);

    const rm = document.createElement("button");
    rm.className = "node-port-rm";
    rm.title = "Remove this port";
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      arr.splice(idx, 1);
      _renderPortRows(dir, arr, methods, gateM);
    });
    row.appendChild(rm);

    host.appendChild(row);
  });
  // Re-bind the add button so its closure has the latest array ref.
  const addBtn = document.getElementById(dir === "in" ? "btn-node-add-in" : "btn-node-add-out");
  addBtn.onclick = () => {
    arr.push({ n: dir === "in" ? "input" + (arr.length + 1) : "out" + (arr.length + 1), t: "audio" });
    _renderPortRows(dir, arr, methods, gateM);
  };
  // Stash refs so save can read the final state.
  host._portsArr = arr;
  host._methods  = methods;
  host._gateM    = gateM;
}

/* Audio inputs don't have setters (they're consumed by operator()
 * directly), so we hide the setter cell for type=audio. Param/gate/
 * clock inputs DO need a setter / method name to wire JS-driven
 * values into the worklet. */
function _refreshSetterCell(row, dir, port, methods, gateM) {
  const methCell = row.querySelector('[data-role="method"]');
  if (!methCell) return;
  if (dir === "out" || port.t === "audio") {
    methCell.classList.add("port-method-empty");
    methCell.value = "";
  } else {
    methCell.classList.remove("port-method-empty");
    if (port.t === "gate") methCell.value = gateM[port.n] || "";
    else methCell.value = methods[port.n] || "";
  }
}

/* Read the current modal state, validate, write to node.override.
 * In ".gdsp" mode, parse the source first and treat the resulting
 * fields as authoritative; in "raw" mode read the form fields. */
function _saveNodeOverride() {
  if (_nodeEditTargetId == null) return;
  const node = state.nodes.find(n => n.id === _nodeEditTargetId);
  if (!node) return;
  const base = TYPES[node.type];
  if (!base) return;

  // Phase 8.D.1 -- UI/HUD nodes commit to params.customRender,
  // skipping the C++ override path.
  if (_nodeEditUiMode) {
    const code = _getRawCode();
    // Strip leading "// example" comments that came from the
    // placeholder seed (keep the user's actual edits). If the
    // entire buffer matches the placeholder pattern, treat as empty.
    const trimmed = (typeof code === "string") ? code.trim() : "";
    pushHistory("ui-customRender:" + node.id);
    node.params = node.params || {};
    // Clear any cached compiled fn so the new code re-parses.
    node._uiCustomFnCode = "";
    node._uiCustomFn = null;
    node._uiCustomErrLogged = false;
    node._uiCustomRunErrLogged = false;
    node.params.customRender = trimmed;
    console.log("[ui-edit " + node.id + "] saved customRender (" + trimmed.length + " chars)");
    closeNodeCodeEditor();
    if (typeof renderProps === "function") renderProps();
    return;
  }

  const warn = document.getElementById("node-edit-warn");
  function fail(msg) {
    warn.textContent = msg;
    warn.classList.add("visible");
  }

  let cppType, helperClass, ins, outs, methodsRaw, gateMRaw;
  if (_nodeEditMode === "gdsp") {
    const src = _getGdspCode();
    let raw;
    try { raw = _parseGdspToState(src); }
    catch (err) { return fail(".gdsp: " + (err && err.message ? err.message : String(err))); }
    cppType     = raw.cppType;
    helperClass = raw.helperClass;
    ins         = raw.ins;
    outs        = raw.outs;
    methodsRaw  = raw.methods;
    gateMRaw    = raw.gateMethods;
  } else {
    cppType     = document.getElementById("node-edit-cppType").value.trim();
    helperClass = _getRawCode();
    const insHost  = document.getElementById("node-edit-ins");
    const outsHost = document.getElementById("node-edit-outs");
    ins  = (insHost._portsArr  || []).filter(p => p.n).map(p => ({ n: p.n, t: p.t }));
    outs = (outsHost._portsArr || []).filter(p => p.n).map(p => ({ n: p.n, t: p.t }));
    methodsRaw = insHost._methods  || {};
    gateMRaw   = insHost._gateM    || {};
  }

  // Basic validation -- catches the common footguns. Codegen will
  // surface anything subtler (compile errors land in the build log).
  const seenIn = new Set();
  for (const p of ins) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.n)) return fail("Input name '" + p.n + "' isn't a valid identifier.");
    if (seenIn.has(p.n)) return fail("Duplicate input name '" + p.n + "'.");
    seenIn.add(p.n);
  }
  const seenOut = new Set();
  for (const p of outs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.n)) return fail("Output name '" + p.n + "' isn't a valid identifier.");
    if (seenOut.has(p.n)) return fail("Duplicate output name '" + p.n + "'.");
    seenOut.add(p.n);
  }

  // Build methods + gateMethods objects restricted to current input
  // port names. Gate ports go into gateMethods; everything else
  // (including audio) goes into methods. Audio inputs DO need methods
  // entries for noSigArg-style classes: prepareSample's audio-input
  // setter loop fires `n.a(...)` only when def.methods[p.n] exists.
  // Without those entries, synthesized multi-audio classes (Mul, Add,
  // Mix, ...) would output 0 because the setters never fire.
  const methods = {};
  const gateMethods = {};
  ins.forEach(p => {
    if (p.t === "gate") {
      if (gateMRaw[p.n]) gateMethods[p.n] = gateMRaw[p.n];
    } else {
      if (methodsRaw[p.n]) methods[p.n] = methodsRaw[p.n];
    }
  });

  pushHistory("edit node code");

  // Drop any edges that reference a port we just removed or renamed
  // on this node -- otherwise they'd dangle into nonexistent ports.
  const validIns  = new Set(ins.map(p => p.n));
  const validOuts = new Set(outs.map(p => p.n));
  state.edges = state.edges.filter(e => {
    if (e.from.node === node.id && !validOuts.has(e.from.port)) return false;
    if (e.to.node   === node.id && !validIns.has(e.to.port))    return false;
    return true;
  });

  // Build the override -- only store fields that ACTUALLY differ from
  // the base, so a future registry update flows through automatically
  // for fields the user didn't touch.
  const ov = {};
  if (cppType !== (base.cppType || "")) ov.cppType = cppType;
  if (helperClass !== (base.helperClass || "")) ov.helperClass = helperClass;
  if (JSON.stringify(ins)  !== JSON.stringify(base.ins  || [])) ov.ins  = ins;
  if (JSON.stringify(outs) !== JSON.stringify(base.outs || [])) ov.outs = outs;
  if (JSON.stringify(methods)     !== JSON.stringify(base.methods     || {})) ov.methods     = methods;
  if (JSON.stringify(gateMethods) !== JSON.stringify(base.gateMethods || {})) ov.gateMethods = gateMethods;

  // Codegen routing decisions: if the user is saving a real class
  // (cppType + helperClass present) and the base was a template-only
  // entry, force template = null so computeBase takes the cppType
  // path instead of inlining the template. Also derive noSigArg
  // from the audio-input count + the seed's hint: multi-audio
  // classes use the "setter for every audio input + operator()()"
  // shape that prepareSample's existing setter loop already handles.
  const hasRealClass = !!cppType && !!helperClass && /\bclass\s+\w+/.test(helperClass);
  if (hasRealClass && base.template) ov.template = null;
  // When the cppType has changed (wrapper synth, template->class
  // synth), the base extraCtor lines target the OLD class type and
  // call methods our new class likely doesn't expose. The wrapper
  // synth already inlined those calls into the wrapper's ctor; the
  // template synth doesn't need them at all. Null out so codegen's
  // patch-class ctor doesn't re-fire them.
  if (hasRealClass && cppType !== (base.cppType || "") && Array.isArray(base.extraCtor) && base.extraCtor.length) {
    ov.extraCtor = null;
  }
  if (hasRealClass) {
    const audioInCount = ins.filter(p => p.t === "audio").length;
    const clockInCount = ins.filter(p => p.t === "clock").length;
    const hasArgOp    = /operator\s*\(\s*\)\s*\(\s*float\b/.test(helperClass);
    const hasNoArgOp  = /operator\s*\(\s*\)\s*\(\s*\)/.test(helperClass);
    let noSig;
    // Prefer the explicit shape detected in the source; fall back to
    // the seed's hint (set during synthesis) when the regex doesn't
    // match cleanly (e.g. operator() split across lines).
    if (hasArgOp) noSig = false;
    else if (hasNoArgOp) noSig = true;
    else noSig = !!(_nodeEditSeed && _nodeEditSeed.noSigArg);
    // Multi-audio always needs noSigArg = true regardless of detection
    // since the single signal-arg path can only feed one of the audio
    // inputs.
    if (audioInCount + clockInCount > 1) noSig = true;
    if (noSig !== !!base.noSigArg) ov.noSigArg = noSig;
  }

  if (Object.keys(ov).length === 0) {
    delete node.override;
  } else {
    node.override = ov;
  }

  closeNodeCodeEditor();
  render();
  if (typeof renderMonitorControls === "function") renderMonitorControls();
}

function _revertNodeOverride() {
  if (_nodeEditTargetId == null) return;
  const node = state.nodes.find(n => n.id === _nodeEditTargetId);
  if (!node || !node.override) return;
  pushHistory("revert node override");
  delete node.override;
  closeNodeCodeEditor();
  render();
}

/* =========================================================================
 * .gdsp mode toggle -- alternate view of the same per-node override
 * data, using the User DSP file format (single textarea, // @gdsp-*
 * metadata + class body). Lets the user edit a built-in node's code
 * in the same format they'd use for a from-scratch User DSP class.
 *
 * Mode is a UI state ("raw" vs "gdsp"); the underlying model is the
 * same set of fields (cppType, ins, outs, methods, gateMethods,
 * helperClass). Toggling synthesizes/parses between the two views;
 * save reads whichever view is currently active. */
let _nodeEditMode = "raw"; // "raw" | "gdsp"

/* Classify a node's code form so the editor can pre-fill the modal
 * with something editable for every node, not just helperClass ones.
 *
 *   "helper"   - has a real helperClass (KeyboardIn, Slider, Button,
 *                PatchMatrix, etc.) -- show it as-is.
 *   "template" - has an inline template (Mul, Add, Mix, Abs, ...) --
 *                synthesize a class so it shows up as editable C++.
 *   "wrapper"  - has cppType pointing to a library class but no
 *                helperClass (Sine, Saw, Square, ...) -- synthesize
 *                a wrapper class delegating to the library type.
 *   "kind"     - special codegen kind (delay1, shader-frag) -- the
 *                editor surfaces what's there with a note since
 *                these paths can't currently be replaced via override.
 *   "empty"    - none of the above; show a stub. */
function _nodeCodeCategory(def) {
  if (!def) return "empty";
  if (def.kind) return "kind";
  if (def.helperClass) return "helper";
  if (def.template) return "template";
  if (def.cppType)   return "wrapper";
  return "empty";
}

/* Build a real C++ class from a template-only node's `template`
 * string + port list. Two shapes:
 *
 *   * Single audio input (Neg, Abs, AmpToDb, ...):
 *       operator()(float in) takes the audio in as arg; params
 *       become setters + state members.
 *
 *   * Multi-audio input (Mul, Add, Sub, Mix, ...):
 *       operator()() returns based on member state; both audio
 *       inputs become setters (mirrors the existing PatchMatrix /
 *       MasterMix codegen). noSigArg flag returned so the save path
 *       can set it on the override -- the prepareSample audio-input
 *       setter loop already handles this shape.
 *
 * Returns { source, className, noSigArg, methods } -- methods is the
 * port-name -> setter-name map matching the synthesized setters. */
function _classFromTemplate(def, node) {
  const className = node.type;
  const audioIns = (def.ins || []).filter(p => p.t === "audio");
  const paramIns = (def.ins || []).filter(p => p.t === "param");
  const clockIns = (def.ins || []).filter(p => p.t === "clock");
  const oneAudio = audioIns.length === 1 && clockIns.length === 0;

  // Some templates reference param keys that aren't in def.ins --
  // they live in node.params and get substituted at codegen time via
  // computeBase's `Object.keys(node.params).forEach` fallback. Const
  // (template "{value}", params.value), Clip (template references
  // {min} {max}), and Scale ({inMin}/{inMax}/{outMin}/{outMax}) all
  // need this. Collect every {key} referenced and emit a member +
  // setter for any that aren't covered by an input port.
  const templateKeys = new Set();
  const tplStr = def.template || "";
  let kmatch;
  const keyRe = /\{(\w+)\}/g;
  while ((kmatch = keyRe.exec(tplStr))) templateKeys.add(kmatch[1]);
  const knownInputs = new Set([
    ...audioIns.map(p => p.n),
    ...clockIns.map(p => p.n),
    ...paramIns.map(p => p.n)
  ]);
  const paramOnly = [];
  templateKeys.forEach(k => { if (!knownInputs.has(k)) paramOnly.push(k); });

  let s = "";
  s += "class " + className + " {\n";
  if (!oneAudio) {
    audioIns.forEach(p => { s += "    float " + p.n + "_ = 0.f;\n"; });
    clockIns.forEach(p => { s += "    float " + p.n + "_ = 0.f;\n"; });
  }
  // Members for every wired param + every template-referenced
  // params-only key. Defaults come from node.params (or def.params
  // for keys not on this instance) so the synth seeds the same
  // values the original template would have inlined.
  const allParamKeys = [...paramIns.map(p => p.n), ...paramOnly];
  allParamKeys.forEach(key => {
    let dv = (node && node.params && node.params[key] !== undefined) ? node.params[key]
           : (def.params && def.params[key] !== undefined) ? def.params[key]
           : 0;
    dv = Number(dv);
    const lit = isFinite(dv) ? dv.toFixed(4).replace(/0+$/, "0") + "f" : "0.f";
    s += "    float " + key + "_ = " + lit + ";\n";
  });
  s += "public:\n";

  // Setters: every non-signal input + every params-only template key
  // gets a name(float) setter. Codegen's existing audio-input setter
  // loop fires `n.a(...)` for noSigArg multi-audio classes; the ctor
  // body fires `n.value(<dv>)` from def.methods for params-only keys.
  const methods = {};
  if (!oneAudio) {
    audioIns.forEach(p => {
      s += "    void " + p.n + "(float v) { " + p.n + "_ = v; }\n";
      methods[p.n] = p.n;
    });
    clockIns.forEach(p => {
      s += "    void " + p.n + "(float v) { " + p.n + "_ = v; }\n";
      methods[p.n] = p.n;
    });
  }
  allParamKeys.forEach(key => {
    s += "    void " + key + "(float v) { " + key + "_ = v; }\n";
    methods[key] = key;
  });

  // Substitute {key} -> key (single-audio arg) or key_ (member).
  let expr = def.template || "";
  if (oneAudio) {
    const argName = audioIns[0].n;
    allParamKeys.forEach(key => {
      expr = expr.replace(new RegExp("\\{" + key + "\\}", "g"), key + "_");
    });
    expr = expr.replace(new RegExp("\\{" + argName + "\\}", "g"), argName);
    s += "    float operator()(float " + argName + ") {\n";
    s += "        return " + expr + ";\n";
    s += "    }\n";
  } else {
    [...audioIns, ...clockIns].forEach(p => {
      expr = expr.replace(new RegExp("\\{" + p.n + "\\}", "g"), p.n + "_");
    });
    allParamKeys.forEach(key => {
      expr = expr.replace(new RegExp("\\{" + key + "\\}", "g"), key + "_");
    });
    s += "    float operator()() {\n";
    s += "        return " + expr + ";\n";
    s += "    }\n";
  }
  s += "};\n";
  return { source: s, className, noSigArg: !oneAudio, methods };
}

/* Synthesize a thin wrapper class around a library cppType
 * (gam::Sine<>, gam::Biquad<>, ...). The wrapper holds the inner
 * instance, exposes a setter per method/gate the registry declares,
 * and delegates operator() to the inner type.
 *
 * The class name is "Custom" + the stripped library tail -- new
 * enough that it won't collide with the registry's class name in
 * the emitted header. Override.cppType is set to this new name so
 * the patch-class member declaration matches. */
function _classFromWrapper(def, node) {
  const inner = def.cppType || "";
  const baseTail = inner.replace(/<.*$/, "").split("::").pop() || (node ? node.type : "Inner");
  const className = "Custom" + baseTail;
  const audioIns = (def.ins || []).filter(p => p.t === "audio");
  const oneAudio = audioIns.length === 1;
  const noAudio  = audioIns.length === 0;

  // If the base node has extraCtor (e.g. BiquadLP's
  // "{id}.type(gam::LOW_PASS);", Reverb's resize calls), inline it
  // into the wrapper's constructor so the init still runs against
  // inner_. We rewrite {id}. -> inner_. so the call lands on the
  // library instance. The save path nulls out base.extraCtor when
  // the cppType changes -- otherwise it'd run again on the patch
  // class and call .type() on our wrapper, which doesn't expose it.
  let ctorLines = [];
  (def.extraCtor || []).forEach(t => {
    let raw = "";
    if (typeof t === "function") {
      try { raw = t(node) || ""; } catch (_) { raw = ""; }
    } else {
      raw = String(t || "");
    }
    if (!raw) return;
    // raw may contain "{id}.method(...)" or "{id}." prefixes.
    const rewritten = raw.replace(/\{id\}\./g, "inner_.").replace(/\{id\}/g, "inner_");
    rewritten.split("\n").forEach(line => {
      const trimmed = line.replace(/^\s*/, "");
      if (trimmed) ctorLines.push(trimmed);
    });
  });

  let s = "";
  s += "class " + className + " {\n";
  s += "    " + inner + " inner_;\n";
  s += "public:\n";
  if (ctorLines.length) {
    s += "    " + className + "() {\n";
    ctorLines.forEach(l => { s += "        " + l + "\n"; });
    s += "    }\n";
  }

  // For each param input that has a setter, emit a delegating setter
  // named after the setter (or after the port name if no method
  // override). Uses a Set to dedup if multiple ports share a setter.
  const emittedSetters = new Set();
  const paramMethodsOut = {};
  (def.ins || []).forEach(p => {
    if (p.t !== "param") return;
    const meth = (def.methods && def.methods[p.n]) || p.n;
    // Strip "(...)" so methods like "phase(0.f)" reduce to "phase".
    const setterName = String(meth).replace(/\(.*$/, "");
    if (emittedSetters.has(setterName)) return;
    emittedSetters.add(setterName);
    s += "    void " + setterName + "(float v) { inner_." + setterName + "(v); }\n";
    paramMethodsOut[p.n] = setterName;
  });

  // Gate inputs: emit a delegating method per gate. The gate method
  // ON THE WRAPPER takes float v so codegen's audio-input setter
  // path can call it uniformly; for the gate fire path
  // (`if ((u) > 0.5f) wrapper.method;`) we rely on the literal
  // method-with-args form ("phase(0.f)") which is left in the
  // override.gateMethods unchanged from the base.
  const gateMethodsOut = {};
  (def.ins || []).forEach(p => {
    if (p.t !== "gate") return;
    const meth = (def.gateMethods && def.gateMethods[p.n]) || "reset";
    const isLiteralCall = meth.indexOf("(") >= 0;
    const fnName = String(meth).replace(/\(.*$/, "");
    // Avoid double-emitting if the same method name was already done
    // above as a setter (rare; happens when a port's setter shares
    // the gate's method name).
    if (!emittedSetters.has(fnName)) {
      emittedSetters.add(fnName);
      if (isLiteralCall) {
        // "phase(0.f)" -> emit `void phase(float v)` that delegates so the
        // codegen call `wrap.phase(0.f)` resolves via this setter.
        s += "    void " + fnName + "(float v) { inner_." + fnName + "(v); }\n";
      } else {
        s += "    void " + fnName + "() { inner_." + fnName + "(); }\n";
      }
    }
    // gateMethods stays the same literal so codegen emits the
    // existing `wrap.<literal>` call.
    gateMethodsOut[p.n] = meth;
  });

  if (oneAudio) {
    const a = audioIns[0].n;
    s += "    float operator()(float " + a + ") { return inner_(" + a + "); }\n";
  } else if (noAudio) {
    s += "    float operator()() { return inner_(); }\n";
  } else {
    // Multi-audio wrapper -- rare; emit a noSigArg placeholder.
    audioIns.forEach(p => { s += "    float " + p.n + "_ = 0.f;\n"; });
    audioIns.forEach(p => { s += "    void "  + p.n + "(float v) { " + p.n + "_ = v; }\n"; });
    s += "    float operator()() {\n";
    s += "        // TODO: route audio inputs to the inner type as your library expects.\n";
    s += "        return inner_();\n";
    s += "    }\n";
  }
  s += "};\n";

  // Wire the existing method names (gateMethods stay literal because
  // codegen treats parenthesized methods as call expressions). The
  // additional audio-input setters when multi-audio go in methods.
  const methods = { ...(def.methods || {}), ...paramMethodsOut };
  if (!oneAudio && !noAudio) {
    audioIns.forEach(p => { methods[p.n] = p.n; });
  }
  return { source: s, className, noSigArg: !oneAudio && !noAudio, methods, gateMethods: gateMethodsOut };
}

/* Pick the right pre-fill content for the modal based on the node's
 * code category. Returns { source, sectionLabel, hint, synthClassName,
 * noSigArg } -- the modal uses these to populate the code area and
 * the section-header text. */
function _seedNodeEditCode(def, node) {
  const cat = _nodeCodeCategory(def);
  if (cat === "helper") {
    return {
      source: def.helperClass,
      sectionLabel: "helper class (C++ source)",
      hint: "",
      synthClassName: null,
      noSigArg: !!def.noSigArg
    };
  }
  if (cat === "template") {
    const { source, className, noSigArg } = _classFromTemplate(def, node);
    return {
      source,
      sectionLabel: "synthesized class (was: inline template '" + (def.template || "") + "')",
      hint: "// Original inline template: " + (def.template || "") + "\n// Editing + saving will route this node through a real class instead of the inline template.\n",
      synthClassName: className,
      noSigArg
    };
  }
  if (cat === "wrapper") {
    const { source, className, noSigArg } = _classFromWrapper(def, node);
    return {
      source,
      sectionLabel: "synthesized wrapper class (was: " + (def.cppType || "?") + ")",
      hint: "// Wraps " + (def.cppType || "?") + " from the Gamma library.\n// Edit to customize -- or replace the class entirely with your own.\n",
      synthClassName: className,
      noSigArg
    };
  }
  if (cat === "kind") {
    return {
      source: def.helperClass || ("// This node has special codegen kind '" + def.kind + "'.\n// The current code editor doesn't support overriding the codegen path itself yet.\n// You can still edit ports / cppType, but the kind-specific behavior remains."),
      sectionLabel: "node kind: " + def.kind + " (special codegen path)",
      hint: "",
      synthClassName: null,
      noSigArg: !!def.noSigArg
    };
  }
  return {
    source: "// (no source registered for this node type)\n// Add a class declaration here + a cppType above to provide one.",
    sectionLabel: "helper class (C++ source)",
    hint: "",
    synthClassName: null,
    noSigArg: false
  };
}

/* Pull the current "raw view" fields into a plain state object. */
function _captureRawState() {
  const insHost  = document.getElementById("node-edit-ins");
  const outsHost = document.getElementById("node-edit-outs");
  return {
    cppType:    document.getElementById("node-edit-cppType").value.trim(),
    helperClass: _getRawCode(),
    ins:  (insHost._portsArr  || []).filter(p => p.n).map(p => ({ n: p.n, t: p.t })),
    outs: (outsHost._portsArr || []).filter(p => p.n).map(p => ({ n: p.n, t: p.t })),
    methods:     insHost._methods  || {},
    gateMethods: insHost._gateM    || {}
  };
}

/* Synthesize a .gdsp source from a raw-state object. Used when the
 * user clicks "convert to .gdsp" so the editable text is pre-filled
 * with the equivalent .gdsp format.
 *
 * @gdsp-method is only emitted when the setter name differs from
 * the port name; @gdsp-gate only when it differs from "reset" --
 * matches the convention parseGdsp uses on the way back. */
function _synthGdspSource(raw, baseNode) {
  let s = "";
  // Class name: prefer one extracted from the helperClass body so
  // the @gdsp-name line matches the actual class declaration (which
  // parseGdsp validates). Fall back to cppType, then node type.
  let className = raw.cppType || (baseNode ? baseNode.type : "MyNode");
  const cm = (raw.helperClass || "").match(/class\s+(\w+)/);
  if (cm) className = cm[1];

  const baseDef = baseNode ? TYPES[baseNode.type] : null;
  const category = (baseDef && baseDef.category) || "UserDSP";

  s += "// @gdsp-name        " + className + "\n";
  s += "// @gdsp-category    " + category + "\n";
  if (baseDef && baseDef.description) {
    s += "// @gdsp-description " + String(baseDef.description).split("\n")[0] + "\n";
  }
  (raw.ins || []).forEach(p => {
    // @gdsp-input only supports audio/param/gate per parseGdsp's
    // type check. Visual ports (mesh/camera/texture/etc.) get
    // skipped with a TODO comment so the user notices.
    if (!["audio", "param", "gate"].includes(p.t)) {
      s += "// TODO: input '" + p.n + "' has type '" + p.t + "' which @gdsp-input doesn't accept (audio/param/gate only)\n";
      return;
    }
    let line = "// @gdsp-input       " + p.n + " " + p.t;
    // Include a default for params if the base node carries one.
    if (p.t === "param" && baseNode && baseNode.params && baseNode.params[p.n] !== undefined) {
      line += " " + baseNode.params[p.n];
    }
    s += line + "\n";
  });
  (raw.outs || []).forEach(p => {
    if (!["audio", "param", "gate"].includes(p.t)) {
      s += "// TODO: output '" + p.n + "' has type '" + p.t + "' which @gdsp-output doesn't accept (audio/param/gate only)\n";
      return;
    }
    s += "// @gdsp-output      " + p.n + " " + p.t + "\n";
  });
  Object.keys(raw.methods || {}).forEach(n => {
    const m = raw.methods[n];
    if (m && m !== n) s += "// @gdsp-method      " + n + " " + m + "\n";
  });
  Object.keys(raw.gateMethods || {}).forEach(n => {
    const m = raw.gateMethods[n];
    if (m && m !== "reset") s += "// @gdsp-gate        " + n + " " + m + "\n";
  });
  s += "\n";
  // Body: helperClass if we have one, else a stub the user can fill.
  if (raw.helperClass && raw.helperClass.trim() && !/no helper class/i.test(raw.helperClass)) {
    s += raw.helperClass;
  } else {
    s += "class " + className + " {\npublic:\n    float operator()(float in) { return in; }\n};\n";
  }
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

/* Parse a .gdsp source via the existing buildUserDspDef and map the
 * resulting def into the raw-state shape. Throws on parse / shape
 * errors -- caller surfaces those in the modal's warn area. */
function _parseGdspToState(source) {
  // buildUserDspDef enforces @gdsp-name + at least one @gdsp-input +
  // @gdsp-output and validates the class declaration matches. Throws
  // on mismatch.
  const { def, name } = buildUserDspDef(source);
  return {
    cppType:     def.cppType || name,
    helperClass: stripGdspHeader(source),
    ins:         (def.ins  || []).map(p => ({ n: p.n, t: p.t })),
    outs:        (def.outs || []).map(p => ({ n: p.n, t: p.t })),
    methods:     def.methods     || {},
    gateMethods: def.gateMethods || {}
  };
}

/* Apply a raw-state object back to the "raw view" form fields. */
function _applyRawStateToForm(rawState) {
  document.getElementById("node-edit-cppType").value = rawState.cppType || "";
  _setRawCode(rawState.helperClass || "");
  const insArr  = rawState.ins.map(p => ({ n: p.n, t: p.t }));
  const outsArr = rawState.outs.map(p => ({ n: p.n, t: p.t }));
  const methods = Object.assign({}, rawState.methods || {});
  const gateM   = Object.assign({}, rawState.gateMethods || {});
  _renderPortRows("in",  insArr,  methods, gateM);
  _renderPortRows("out", outsArr, methods, gateM);
}

/* Switch the modal between "raw" (fields) and "gdsp" (single
 * textarea) views. Converts data in the current view's shape into
 * the other shape so edits aren't lost. Surfaces parse errors in
 * the warn area when going gdsp -> raw. */
function _setNodeEditMode(mode) {
  const warnEl = document.getElementById("node-edit-warn");
  warnEl.textContent = ""; warnEl.classList.remove("visible");
  const rawView  = document.getElementById("node-edit-raw-view");
  const gdspView = document.getElementById("node-edit-gdsp-view");
  const toggle   = document.getElementById("btn-node-edit-mode");
  const node = (_nodeEditTargetId != null) ? state.nodes.find(n => n.id === _nodeEditTargetId) : null;

  if (mode === "gdsp") {
    // Pull current raw state, synthesize the .gdsp text, swap views.
    const raw = _captureRawState();
    const src = _synthGdspSource(raw, node);
    _setGdspCode(src);
    rawView.style.display  = "none";
    gdspView.style.display = "";
    toggle.textContent = "← fields";
    toggle.title = "Switch back to the fields view";
    _nodeEditMode = "gdsp";
    // CodeMirror needs a refresh whenever its container goes from
    // display:none to visible -- otherwise it measures 0px high.
    setTimeout(() => { if (_nodeEditCmGdsp) { _nodeEditCmGdsp.refresh(); _nodeEditCmGdsp.focus(); } }, 0);
  } else {
    // Going gdsp -> raw: parse the current .gdsp source and populate
    // the raw form fields. If parse fails, stay in gdsp mode and
    // surface the error so the user can fix it.
    const src = _getGdspCode();
    try {
      const raw = _parseGdspToState(src);
      _applyRawStateToForm(raw);
    } catch (err) {
      warnEl.textContent = ".gdsp parse: " + (err && err.message ? err.message : String(err));
      warnEl.classList.remove("ok");
      warnEl.classList.add("visible");
      return;       // refuse the switch; user fixes the source
    }
    rawView.style.display  = "";
    gdspView.style.display = "none";
    toggle.textContent = ".gdsp →";
    toggle.title = "Toggle between fields view and a single .gdsp source (User DSP format)";
    _nodeEditMode = "raw";
    setTimeout(() => { if (_nodeEditCmRaw) { _nodeEditCmRaw.refresh(); _nodeEditCmRaw.focus(); } }, 0);
  }
}

/* "Validate" -- runs the same checks save runs, surfaces the result
 * in the warn area, but doesn't commit anything. In .gdsp mode this
 * uses buildUserDspDef (the canonical .gdsp parser) and reports the
 * resolved ports / params count; in raw mode it checks class-name
 * match + port-name identifier validity. */
function _validateNodeOverride() {
  const warn = document.getElementById("node-edit-warn");
  function ok(msg)  { warn.textContent = msg; warn.classList.add("visible", "ok"); }
  function bad(msg) { warn.textContent = msg; warn.classList.add("visible"); warn.classList.remove("ok"); }
  if (_nodeEditMode === "gdsp") {
    try {
      const { def, name } = buildUserDspDef(_getGdspCode());
      const np = Object.keys(def.params || {}).length;
      ok("✓ " + name + "  ·  " + def.ins.length + " in, " + def.outs.length + " out, " + np + " param" + (np === 1 ? "" : "s"));
    } catch (err) {
      bad("✗ " + (err && err.message ? err.message : String(err)));
    }
    return;
  }
  // Raw mode -- mirror save's identifier checks + a class-name
  // sanity check between cppType and the source.
  const raw = _captureRawState();
  const cm = (raw.helperClass || "").match(/class\s+(\w+)/);
  // Strip template angle-brackets from cppType for the comparison
  // (e.g. "gam::Sine<>" vs "Sine" in the source -- we compare the
  // tail symbol).
  const cppTail = (raw.cppType || "").replace(/<[^>]*>/g, "").split("::").pop();
  if (cppTail && cm && cm[1] !== cppTail) {
    return bad("✗ cppType '" + raw.cppType + "' doesn't match class name '" + cm[1] + "' in source");
  }
  const seenIn = new Set();
  for (const p of raw.ins) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.n)) return bad("✗ input name '" + p.n + "' isn't a valid identifier");
    if (seenIn.has(p.n)) return bad("✗ duplicate input name '" + p.n + "'");
    seenIn.add(p.n);
  }
  const seenOut = new Set();
  for (const p of raw.outs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.n)) return bad("✗ output name '" + p.n + "' isn't a valid identifier");
    if (seenOut.has(p.n)) return bad("✗ duplicate output name '" + p.n + "'");
    seenOut.add(p.n);
  }
  ok("✓ " + raw.ins.length + " in, " + raw.outs.length + " out  ·  ready to save");
}

/* "Export .gdsp" -- writes the (synthesized or current) .gdsp source
 * to a file the user can save. Reuses exportGdsp's logic via Blob +
 * download anchor. Filename comes from the @gdsp-name when set,
 * otherwise falls back to {nodeType}_{nodeId}.gdsp. */
function _exportNodeAsGdsp() {
  let src;
  if (_nodeEditMode === "gdsp") {
    src = _getGdspCode();
  } else {
    const node = state.nodes.find(n => n && n.id === _nodeEditTargetId);
    src = _synthGdspSource(_captureRawState(), node);
  }
  let fname;
  try {
    const dirs = parseGdsp(src).directives;
    fname = (dirs.name || "").trim();
  } catch (_) {}
  if (!fname) {
    const node = state.nodes.find(n => n && n.id === _nodeEditTargetId);
    fname = node ? (node.type + "_" + node.id) : "node-override";
  }
  const blob = new Blob([src], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fname + ".gdsp";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const warn = document.getElementById("node-edit-warn");
  warn.textContent = "↓ exported " + fname + ".gdsp";
  warn.classList.add("visible", "ok");
}

// Wire the modal's buttons + esc/cmd-enter shortcuts.
document.getElementById("btn-node-edit-close").addEventListener("click", closeNodeCodeEditor);
document.getElementById("btn-node-edit-cancel").addEventListener("click", closeNodeCodeEditor);
document.getElementById("btn-node-edit-save").addEventListener("click", _saveNodeOverride);
document.getElementById("btn-node-edit-revert").addEventListener("click", _revertNodeOverride);
document.getElementById("btn-node-edit-validate").addEventListener("click", _validateNodeOverride);
document.getElementById("btn-node-edit-export").addEventListener("click", _exportNodeAsGdsp);
document.getElementById("btn-node-edit-mode").addEventListener("click", () => {
  _setNodeEditMode(_nodeEditMode === "raw" ? "gdsp" : "raw");
});
// Backdrop click closes (matches other modals).
document.getElementById("node-edit-modal").addEventListener("click", (e) => {
  if (e.target.id === "node-edit-modal") closeNodeCodeEditor();
});

/* Capture-phase keydown gate. Stops main hotkeys from firing while
 * the node editor is open: V/D/W/Z/X/1..5/etc. won't reach their
 * bubble-phase handlers. Allows Esc (close) and Ctrl/Cmd+Enter
 * (save) to pass through to the modal's own handler. */
document.addEventListener("keydown", (e) => {
  if (!_nodeEditorOpen) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeNodeCodeEditor();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    _saveNodeOverride();
    return;
  }
  // Block bubble-phase main hotkeys. Don't block keys inside the
  // modal's inputs / textareas -- the activeElement check + capture
  // semantics let typing pass through naturally; we only need to
  // prevent the keys from triggering CANVAS hotkeys.
  e.stopPropagation();
}, true);

function openNodeEditorForSelection() {
  // Trigger from E key. Only fires when EXACTLY one node is selected
  // AND no group is selected (group-collapse path wins otherwise).
  if (selectedGroupId) return false;
  if (!selectedSet || selectedSet.size !== 1) return false;
  const id = [...selectedSet][0];
  const node = state.nodes.find(n => n && n.id === id);
  if (!node) return false;
  openNodeCodeEditor(id);
  return true;
}

function openRampModal(kind, nodeId) {
  const cfg = RAMP_CONFIG[kind];
  if (!cfg) return;
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const titleEl = document.getElementById("ramp-modal-title");
  const noteEl  = document.getElementById("ramp-modal-note");
  const grid    = document.getElementById("ramp-grid");
  const modal   = document.getElementById("ramp-modal");
  const body    = modal && modal.querySelector(".modal-body");
  if (!titleEl || !grid || !modal || !body) return;
  titleEl.textContent = cfg.title + " · " + node.id;
  noteEl.textContent  = cfg.note;
  const current = (node.params && node.params[cfg.paramKey]) || cfg.defaultKey;
  // Tear down any previously-injected drawing pane before rebuilding.
  const oldPane = body.querySelector(".curve-draw-pane");
  if (oldPane) oldPane.remove();
  grid.innerHTML = "";
  const svgW = 220, svgH = 56;
  cfg.options.forEach(opt => {
    const card = document.createElement("div");
    card.className = "ramp-card" + (opt.key === current ? " active" : "");
    card.dataset.key = opt.key;
    const path = rampSvgPath(opt, kind, svgW, svgH, node);
    card.innerHTML =
      '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" preserveAspectRatio="none">' +
        '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="1.5" />' +
      '</svg>' +
      '<div class="ramp-card-label">' + opt.label + '</div>';
    card.addEventListener("click", () => {
      pushHistory("ramp:" + nodeId);
      node.params[cfg.paramKey] = opt.key;
      // Initialize the LUT lazily on first switch to "custom" so the
      // user has something to draw on.
      if (opt.key === "custom" && (!Array.isArray(node.params.curveTable) || !node.params.curveTable.length)) {
        node.params.curveTable = defaultCurveTable();
      }
      grid.querySelectorAll(".ramp-card").forEach(c => c.classList.remove("active"));
      card.classList.add("active");
      renderMonitorControls();
      renderCode(); renderJson();
      // Show / hide the drawing pane based on selection. All three
      // kinds (ramp / slider / button) share the canvas — semantics
      // differ only in how the LUT is consumed downstream (JS for
      // slider, C++ helperClass for ramp + button).
      const existingPane = body.querySelector(".curve-draw-pane");
      if (opt.key === "custom") {
        if (!existingPane) body.appendChild(buildCurveDrawPane(node));
      } else if (existingPane) {
        existingPane.remove();
      }
    });
    grid.appendChild(card);
  });
  // If we opened straight into "custom" mode, inject the drawing pane up front.
  if (current === "custom") {
    body.appendChild(buildCurveDrawPane(node));
  }
  modal.style.display = "flex";
}
function closeRampModal() {
  const modal = document.getElementById("ramp-modal");
  if (modal) modal.style.display = "none";
}

