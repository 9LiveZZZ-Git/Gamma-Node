/* ====================================================================
 * Drawable ADSR (EnvDraw node) modal
 *
 * Single SVG canvas: 64-sample LUT painted with click+drag, plus a
 * draggable vertical sustain marker that splits the curve into the
 * attack half (left, plays start→sustain) and release half (right,
 * plays sustain→end). Saves directly into node.params.curveTable
 * and node.params.sustainIdx; codegen reads both via extraCtor.
 * ================================================================== */

/* ====================================================================
 * Automation lane modal (single + multi)
 *
 * Single-lane: node.params.curveTable holds the drawn shape (256 floats).
 * Multi-lane:  node.params.lanes is an array of 4 entries, each with
 *              { name, min, max, curveTable }.
 *
 * The modal canvas is shared — lane tabs at the top swap which slot
 * the painting writes into. The grid draws beat lines at 1/4 of the
 * curve length (assumes 4 beats / bar) plus heavier bar lines.
 * ================================================================== */

const AUTO_LANE_RES = 256;

function defaultAutoLaneTable() {
  // Default to a flat 0.5 line — neither extreme; user paints from there.
  const t = new Array(AUTO_LANE_RES);
  for (let i = 0; i < AUTO_LANE_RES; i++) t[i] = 0.5;
  return t;
}
function ensureAutoLaneState(node, isMulti) {
  if (!node.params) node.params = {};
  if (isMulti) {
    if (!Array.isArray(node.params.lanes) || node.params.lanes.length !== 4) {
      const tints = ["accent", "info", "param", "gate"];
      node.params.lanes = [0,1,2,3].map(i => ({
        name: "Lane " + (i+1),
        min: 0, max: 1,
        curveTable: defaultAutoLaneTable(),
        tint: tints[i]
      }));
    }
    // Each lane needs a curveTable
    node.params.lanes.forEach(l => {
      if (!Array.isArray(l.curveTable) || !l.curveTable.length) {
        l.curveTable = defaultAutoLaneTable();
      }
    });
  } else {
    if (!Array.isArray(node.params.curveTable) || !node.params.curveTable.length) {
      node.params.curveTable = defaultAutoLaneTable();
    }
  }
}

let _autoLaneActiveTab = 0;   // multi-lane only — which tab is selected

function openAutoLaneModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const isMulti = node.type === "MultiAutomationLane";
  ensureAutoLaneState(node, isMulti);
  _autoLaneActiveTab = 0;
  const titleEl = document.getElementById("auto-lane-modal-title");
  if (titleEl) titleEl.textContent = (isMulti ? "Edit multi-lane automation · " : "Edit automation lane · ") + nodeId;
  const tabsEl = document.getElementById("auto-lane-tabs");
  const paneEl = document.getElementById("auto-lane-pane");
  if (tabsEl) tabsEl.innerHTML = isMulti ? buildAutoLaneTabsHtml(node) : "";
  if (tabsEl && isMulti) {
    tabsEl.querySelectorAll(".al-tab").forEach(b => {
      b.addEventListener("click", () => {
        _autoLaneActiveTab = parseInt(b.dataset.tab, 10) || 0;
        // Re-render tabs (active state) + pane
        tabsEl.innerHTML = buildAutoLaneTabsHtml(node);
        paneEl.innerHTML = "";
        paneEl.appendChild(buildAutoLanePane(node, isMulti));
        // Re-bind tab handlers on the new DOM
        tabsEl.querySelectorAll(".al-tab").forEach(bb => {
          bb.addEventListener("click", arguments.callee);
        });
      });
    });
  }
  if (paneEl) {
    paneEl.innerHTML = "";
    paneEl.appendChild(buildAutoLanePane(node, isMulti));
  }
  const modal = document.getElementById("auto-lane-modal");
  if (modal) modal.style.display = "flex";
}
function closeAutoLaneModal() {
  const modal = document.getElementById("auto-lane-modal");
  if (modal) modal.style.display = "none";
}
(function setupAutoLaneModal() {
  const close = document.getElementById("btn-auto-lane-close");
  const modal = document.getElementById("auto-lane-modal");
  if (close) close.addEventListener("click", closeAutoLaneModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeAutoLaneModal(); });
})();

function buildAutoLaneTabsHtml(node) {
  const lanes = node.params.lanes || [];
  return `<div style="display:flex; gap:6px; margin-bottom: 8px; align-items: center;">
    <span style="font-family: var(--font-mono); font-size: 9.5px; color: var(--text-3); letter-spacing: 0.10em; text-transform: uppercase; padding-right:6px;">Lane</span>
    ${lanes.map((l, i) => {
      const active = (i === _autoLaneActiveTab) ? " active" : "";
      return `<button class="al-tab${active}" data-tab="${i}" style="padding: 4px 10px; background: ${i === _autoLaneActiveTab ? 'var(--accent)' : 'var(--surface-2)'}; color: ${i === _autoLaneActiveTab ? 'var(--accent-ink)' : 'var(--text)'}; border: 1px solid ${i === _autoLaneActiveTab ? 'var(--accent)' : 'var(--border)'}; border-radius: 3px; font-family: var(--font-mono); font-size: 10px; cursor: pointer; font-weight: ${i === _autoLaneActiveTab ? '600' : '400'};">${i+1} · ${escapeText(l.name || ('Lane ' + (i+1)))}</button>`;
    }).join("")}
  </div>`;
}

/* Builds the drawable canvas for a single curve. For multi-lane,
 * `node.params.lanes[_autoLaneActiveTab].curveTable` is the live
 * table; for single, `node.params.curveTable` is. The grid shows
 * vertical beat lines + bar lines + horizontal mid line. */
function buildAutoLanePane(node, isMulti) {
  const W = 680, H = 240;
  const pad = 10;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;

  const slot = isMulti ? node.params.lanes[_autoLaneActiveTab] : node.params;
  const tbl = slot.curveTable;
  const N = tbl.length;
  const bars = (typeof node.params.bars === "number" && node.params.bars > 0) ? node.params.bars : 4;
  // Beats per bar = 4 (assumes 4/4). Vertical lines at every beat;
  // heavier strokes at every bar boundary.
  const totalBeats = Math.max(1, Math.round(bars * 4));

  let gridLines = "";
  for (let i = 0; i <= totalBeats; i++) {
    const x = pad + (i / totalBeats) * plotW;
    const isBar = (i % 4) === 0;
    const stroke = isBar ? "rgba(200,232,90,0.35)" : "rgba(200,232,90,0.10)";
    const w = isBar ? 1 : 0.5;
    gridLines += `<line x1="${x.toFixed(1)}" y1="${pad}" x2="${x.toFixed(1)}" y2="${H - pad}" stroke="${stroke}" stroke-width="${w}" />`;
  }
  // Horizontal mid line
  gridLines += `<line x1="${pad}" y1="${pad + plotH * 0.5}" x2="${W - pad}" y2="${pad + plotH * 0.5}" stroke="rgba(200,232,90,0.10)" stroke-width="0.5" />`;

  const pane = document.createElement("div");
  pane.className = "curve-draw-pane";

  // Lane-specific color tint for multi-lane visualization
  const tintMap = { accent: "var(--accent)", info: "var(--info)", param: "var(--param)", gate: "var(--gate)" };
  const tint = (isMulti && slot.tint && tintMap[slot.tint]) ? tintMap[slot.tint] : "var(--accent)";

  pane.innerHTML =
    '<svg class="curve-draw-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:240px;">' +
      gridLines +
      `<text class="curve-axis-label" x="${pad+2}" y="${pad+10}">${(slot.max != null ? slot.max : 1).toFixed(2)}</text>` +
      `<text class="curve-axis-label" x="${pad+2}" y="${H-pad-2}">${(slot.min != null ? slot.min : 0).toFixed(2)}</text>` +
      `<text class="curve-axis-label" x="${W-pad-30}" y="${H-pad-2}">${bars} bars</text>` +
      `<path class="curve-fill" d="" style="fill: ${tint}; opacity: 0.10;"/>` +
      `<path class="curve-line" d="" style="stroke: ${tint};"/>` +
    '</svg>' +
    '<div class="envdraw-fields">' +
      '<label>Bars</label>' +
      '<input type="number" id="auto-lane-bars" min="0.25" max="64" step="0.25" />' +
      '<label>Min</label>' +
      '<input type="number" id="auto-lane-min" step="any" />' +
      '<span class="envdraw-readout" id="auto-lane-readout">— · —</span>' +
    '</div>' +
    '<div class="envdraw-fields" style="margin-top: 4px;">' +
      '<label>BPM</label>' +
      '<input type="number" id="auto-lane-bpm" min="20" max="999" step="1" />' +
      '<label>Max</label>' +
      '<input type="number" id="auto-lane-max" step="any" />' +
      '<span class="envdraw-readout" id="auto-lane-readout-2">loop · —</span>' +
    '</div>' +
    '<div class="curve-draw-actions">' +
      '<label style="display:flex; align-items:center; gap:6px; font-family: var(--font-mono); font-size: 10px; color: var(--text-2); margin-right: auto;">' +
        '<input type="checkbox" id="auto-lane-loop" />' +
        '<span>Loop</span>' +
      '</label>' +
      '<button class="btn" id="btn-auto-lane-reset">Reset (flat)</button>' +
      '<button class="btn" id="btn-auto-lane-smooth">Smooth</button>' +
      '<button class="btn primary" id="btn-auto-lane-done">Done</button>' +
    '</div>';

  const svg = pane.querySelector(".curve-draw-svg");
  const fillPath = pane.querySelector(".curve-fill");
  const linePath = pane.querySelector(".curve-line");
  const barsInp = pane.querySelector("#auto-lane-bars");
  const bpmInp = pane.querySelector("#auto-lane-bpm");
  const minInp = pane.querySelector("#auto-lane-min");
  const maxInp = pane.querySelector("#auto-lane-max");
  const loopChk = pane.querySelector("#auto-lane-loop");
  const readout = pane.querySelector("#auto-lane-readout");
  const readout2 = pane.querySelector("#auto-lane-readout-2");

  barsInp.value = bars;
  bpmInp.value = (typeof node.params.bpm === "number") ? node.params.bpm : 120;
  // Per-lane min/max in multi mode; top-level in single mode.
  const minRef = isMulti ? slot : node.params;
  minInp.value = (typeof minRef.min === "number") ? minRef.min : 0;
  maxInp.value = (typeof minRef.max === "number") ? minRef.max : 1;
  loopChk.checked = !!node.params.loop;

  function tableToPathData() {
    const pts = [];
    for (let i = 0; i < N; i++) {
      const x = pad + (i / (N - 1)) * plotW;
      const y = pad + (1 - tbl[i]) * plotH;
      pts.push((i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1));
    }
    return pts.join(" ");
  }
  function refreshPaths() {
    const d = tableToPathData();
    linePath.setAttribute("d", d);
    fillPath.setAttribute("d", d + ` L ${pad + plotW},${pad + plotH} L ${pad},${pad + plotH} Z`);
    const lo = parseFloat(minInp.value) || 0;
    const hi = parseFloat(maxInp.value) || 1;
    const bpm = parseFloat(bpmInp.value) || 120;
    const lengthSec = bars * 4 * (60 / bpm);
    readout.textContent = `range ${lo.toFixed(2)} → ${hi.toFixed(2)}`;
    readout2.textContent = `${loopChk.checked ? "loop" : "one-shot"} · ${lengthSec.toFixed(2)} s @ ${bpm} BPM`;
  }
  function paintFromPointer(ev, prev) {
    const r = svg.getBoundingClientRect();
    const sx = W / r.width;
    const sy = H / r.height;
    const px = ((ev.clientX - r.left) * sx - pad) / plotW;
    const py = 1 - ((ev.clientY - r.top) * sy - pad) / plotH;
    const i = Math.round(Math.max(0, Math.min(1, px)) * (N - 1));
    const v = Math.max(0, Math.min(1, py));
    if (prev && prev.i !== undefined) {
      const lo = Math.min(prev.i, i), hi = Math.max(prev.i, i);
      if (hi > lo) {
        const a = (lo === prev.i) ? prev.v : v;
        const b = (lo === prev.i) ? v : prev.v;
        for (let k = lo; k <= hi; k++) {
          const t = (k - lo) / (hi - lo);
          tbl[k] = a * (1 - t) + b * t;
        }
      } else {
        tbl[i] = v;
      }
    } else {
      tbl[i] = v;
    }
    refreshPaths();
    return { i, v };
  }
  let last = null;
  svg.addEventListener("pointerdown", ev => {
    ev.preventDefault();
    svg.setPointerCapture(ev.pointerId);
    pushHistory("auto-lane:" + node.id);
    last = paintFromPointer(ev, null);
  });
  svg.addEventListener("pointermove", ev => {
    if (!last) return;
    last = paintFromPointer(ev, last);
  });
  function endStroke() {
    if (!last) return;
    last = null;
    renderCode(); renderJson();
  }
  svg.addEventListener("pointerup",     endStroke);
  svg.addEventListener("pointercancel", endStroke);
  svg.addEventListener("pointerleave",  () => { if (last) endStroke(); });

  // Field commits — update on change.
  barsInp.addEventListener("change", () => {
    const v = parseFloat(barsInp.value);
    if (isFinite(v) && v > 0) {
      pushHistory("auto-lane:bars:" + node.id);
      node.params.bars = v;
      // Re-render the pane so the grid reflects the new bar count.
      const paneEl = document.getElementById("auto-lane-pane");
      paneEl.innerHTML = "";
      paneEl.appendChild(buildAutoLanePane(node, isMulti));
      renderCode(); renderJson();
    }
  });
  bpmInp.addEventListener("change", () => {
    const v = parseFloat(bpmInp.value);
    if (isFinite(v) && v > 0) {
      pushHistory("auto-lane:bpm:" + node.id);
      node.params.bpm = v;
      refreshPaths();
      renderCode(); renderJson();
    }
  });
  minInp.addEventListener("change", () => {
    const v = parseFloat(minInp.value);
    if (isFinite(v)) {
      pushHistory("auto-lane:min:" + node.id);
      if (isMulti) slot.min = v;
      else         node.params.min = v;
      refreshPaths();
      renderCode(); renderJson();
    }
  });
  maxInp.addEventListener("change", () => {
    const v = parseFloat(maxInp.value);
    if (isFinite(v)) {
      pushHistory("auto-lane:max:" + node.id);
      if (isMulti) slot.max = v;
      else         node.params.max = v;
      refreshPaths();
      renderCode(); renderJson();
    }
  });
  loopChk.addEventListener("change", () => {
    pushHistory("auto-lane:loop:" + node.id);
    node.params.loop = loopChk.checked ? 1 : 0;
    refreshPaths();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-auto-lane-reset").addEventListener("click", () => {
    pushHistory("auto-lane:reset:" + node.id);
    for (let i = 0; i < N; i++) tbl[i] = 0.5;
    refreshPaths();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-auto-lane-smooth").addEventListener("click", () => {
    pushHistory("auto-lane:smooth:" + node.id);
    const nxt = tbl.slice();
    for (let i = 1; i < N - 1; i++) nxt[i] = (tbl[i - 1] + tbl[i] + tbl[i + 1]) / 3;
    for (let i = 0; i < N; i++) tbl[i] = nxt[i];
    refreshPaths();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-auto-lane-done").addEventListener("click", closeAutoLaneModal);

  refreshPaths();
  return pane;
}

function defaultEnvDrawTable() {
  // Triangular peak at index 32 — ramp up, ramp down. Mirrors the
  // helper class's default constructor so the JS preview matches
  // the C++ side before the user paints anything.
  const N = CURVE_TABLE_SIZE;
  const sIdx = Math.floor(N / 2);
  const t = new Array(N);
  for (let i = 0; i <= sIdx; i++)     t[i] = i / sIdx;
  for (let i = sIdx + 1; i < N; i++)  t[i] = (N - 1 - i) / (N - 1 - sIdx);
  return t;
}

function openEnvDrawModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node || !node.params) return;
  if (!Array.isArray(node.params.curveTable) || !node.params.curveTable.length) {
    node.params.curveTable = defaultEnvDrawTable();
  }
  if (typeof node.params.sustainIdx !== "number") {
    node.params.sustainIdx = Math.floor(node.params.curveTable.length / 2);
  }
  const titleEl = document.getElementById("envdraw-modal-title");
  if (titleEl) titleEl.textContent = "Edit envelope · " + nodeId;
  const pane = document.getElementById("envdraw-pane");
  if (pane) {
    pane.innerHTML = "";
    pane.appendChild(buildEnvDrawPane(node));
  }
  const modal = document.getElementById("envdraw-modal");
  if (modal) modal.style.display = "flex";
}
function closeEnvDrawModal() {
  const modal = document.getElementById("envdraw-modal");
  if (modal) modal.style.display = "none";
}
(function setupEnvDrawModal() {
  const close = document.getElementById("btn-envdraw-close");
  const modal = document.getElementById("envdraw-modal");
  if (close) close.addEventListener("click", closeEnvDrawModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeEnvDrawModal(); });
})();

/* =========================================================================
 * v0.3.28 — Color curves modal. Per-channel 16-point LUT editor for
 * the ColorCurves shader-frag node.
 *
 * Modal structure:
 *   - 4 channel tabs (Master / R / G / B). Click switches the active
 *     curve being edited.
 *   - SVG plot with a grid background, the identity diagonal as a
 *     faint guide, all 4 curves overlaid (inactive ones faint), then
 *     16 draggable control points on the active curve.
 *   - Reset / Reset All / Done actions.
 *
 * Identity ramp = [0/15, 1/15, ..., 15/15]. Drag a point up/down to
 * push that input value to a different output value; the in-shader
 * sample_lut function does linear interp between adjacent points.
 *
 * Persistence: writes back to node.params.curveMaster / curveR /
 * curveG / curveB which writeUniforms packs into vec4f slots.
 * ======================================================================== */

const CURVES_N = 64;   // points per curve, bumped from 16 in v0.3.29 for paint-quality fidelity

function defaultCurveN() {
  const a = new Array(CURVES_N);
  for (let i = 0; i < CURVES_N; i++) a[i] = i / (CURVES_N - 1);
  return a;
}

// Channel descriptors. Color values are tuned so the inactive
// overlays read cleanly without distracting from the active curve.
const COLOR_CURVES_CHANNELS = [
  { key: "curveMaster", label: "Master", color: "rgba(220, 220, 220, 0.95)", faint: "rgba(220, 220, 220, 0.22)" },
  { key: "curveR",      label: "R",      color: "rgba(255,  90,  90, 0.95)", faint: "rgba(255,  90,  90, 0.22)" },
  { key: "curveG",      label: "G",      color: "rgba(110, 220,  90, 0.95)", faint: "rgba(110, 220,  90, 0.22)" },
  { key: "curveB",      label: "B",      color: "rgba( 90, 160, 255, 0.95)", faint: "rgba( 90, 160, 255, 0.22)" }
];

function openColorCurvesModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node || !node.params) return;
  // Ensure all four curves exist + are well-formed; default any
  // missing or mis-shaped slot (incl. legacy 16-point arrays from
  // v0.3.28 patches) to a fresh 64-point identity.
  for (const ch of COLOR_CURVES_CHANNELS) {
    if (!Array.isArray(node.params[ch.key]) || node.params[ch.key].length !== CURVES_N) {
      node.params[ch.key] = defaultCurveN();
    }
  }
  const titleEl = document.getElementById("colorcurves-modal-title");
  if (titleEl) titleEl.textContent = "Edit color curves · " + nodeId;
  const pane = document.getElementById("colorcurves-pane");
  if (pane) {
    pane.innerHTML = "";
    pane.appendChild(buildColorCurvesPane(node));
  }
  const modal = document.getElementById("colorcurves-modal");
  if (modal) modal.style.display = "flex";
}
function closeColorCurvesModal() {
  const modal = document.getElementById("colorcurves-modal");
  if (modal) modal.style.display = "none";
}
(function setupColorCurvesModal() {
  const close = document.getElementById("btn-colorcurves-close");
  const modal = document.getElementById("colorcurves-modal");
  if (close) close.addEventListener("click", closeColorCurvesModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeColorCurvesModal(); });
})();

function buildColorCurvesPane(node) {
  const W = 600, H = 320;
  const pad = 18;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  // Paint-mode state. activeIdx is which channel is being edited.
  // painting=true between pointerdown and pointerup. lastIdx/lastVal
  // hold the previous pointer-frame's (LUT index, value) so we can
  // linearly fill the gap on fast drags (no skipped points).
  let activeIdx = 0;
  let painting  = false;
  let lastIdx   = -1;
  let lastVal   = 0;

  const xForI = (i)  => pad + (i / (CURVES_N - 1)) * plotW;
  const yForV = (v)  => pad + (1 - v) * plotH;
  const vForY = (cy) => 1 - (cy - pad) / plotH;
  const iForX = (cx) => Math.round(((cx - pad) / plotW) * (CURVES_N - 1));

  const pane = document.createElement("div");
  pane.className = "curve-draw-pane";

  // Tab strip
  let tabsHtml = '<div class="curve-tabs" style="display:flex;gap:6px;margin-bottom:8px;">';
  COLOR_CURVES_CHANNELS.forEach((ch, idx) => {
    tabsHtml += `<button class="btn curve-tab" data-cc-tab="${idx}" style="flex:1;color:${ch.color};font-weight:${idx === 0 ? 'bold' : 'normal'};">${ch.label}</button>`;
  });
  tabsHtml += '</div>';

  // 8x8 grid + identity diagonal as a faint guide.
  let gridHtml = '';
  for (let g = 1; g < 8; g++) {
    const gx = pad + (g / 8) * plotW;
    const gy = pad + (g / 8) * plotH;
    gridHtml += `<line class="curve-grid" x1="${gx}" y1="${pad}" x2="${gx}" y2="${H - pad}" />`;
    gridHtml += `<line class="curve-grid" x1="${pad}" y1="${gy}" x2="${W - pad}" y2="${gy}" />`;
  }
  const identityDiag = `<line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${pad}" stroke="rgba(255,255,255,0.12)" stroke-dasharray="3,3" />`;

  pane.innerHTML = tabsHtml +
    '<svg class="curve-draw-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="user-select:none;cursor:crosshair;touch-action:none;">' +
      gridHtml +
      identityDiag +
      // 4 channel curves overlaid (inactive faint, active bold) +
      // 8 anchor markers along the active curve as visual reference
      // (no longer draggable -- they just hint at where the eighths
      // are along the input range).
      '<g class="cc-curves"></g>' +
      '<g class="cc-anchors"></g>' +
    '</svg>' +
    '<div class="curve-draw-actions">' +
      '<button class="btn" id="btn-cc-smooth">Smooth</button>' +
      '<button class="btn" id="btn-cc-reset">Reset channel</button>' +
      '<button class="btn" id="btn-cc-reset-all">Reset all</button>' +
      '<span style="flex:1;"></span>' +
      '<button class="btn primary" id="btn-cc-done">Done</button>' +
    '</div>';

  const svg      = pane.querySelector(".curve-draw-svg");
  const curvesG  = pane.querySelector(".cc-curves");
  const anchorsG = pane.querySelector(".cc-anchors");
  const tabBtns  = pane.querySelectorAll("[data-cc-tab]");

  function repaint() {
    // All 4 curves drawn through every point (the 64-point line is
    // already smooth at this resolution -- no need for spline math).
    // Inactive curves render faint, active bold.
    let curvesSvg = '';
    COLOR_CURVES_CHANNELS.forEach((ch, idx) => {
      const arr = node.params[ch.key];
      const stroke = (idx === activeIdx) ? ch.color : ch.faint;
      const width  = (idx === activeIdx) ? 2.0 : 1.0;
      let d = '';
      for (let i = 0; i < CURVES_N; i++) {
        const x = xForI(i).toFixed(1);
        const y = yForV(arr[i]).toFixed(1);
        d += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
      }
      curvesSvg += `<path d="${d}" stroke="${stroke}" stroke-width="${width}" fill="none" stroke-linejoin="round" />`;
    });
    curvesG.innerHTML = curvesSvg;

    // Anchor markers: 8 dots along the active curve at i = 0, 9, 18,
    // 27, 36, 45, 54, 63 (every ~9th point). Purely visual -- they
    // hint at where the 1/8 input divisions are. NOT draggable in
    // paint mode -- drag the line directly.
    const active = COLOR_CURVES_CHANNELS[activeIdx];
    const arr = node.params[active.key];
    let anchorsSvg = '';
    for (let k = 0; k < 8; k++) {
      const i = Math.round(k * (CURVES_N - 1) / 7);
      const x = xForI(i).toFixed(1);
      const y = yForV(arr[i]).toFixed(1);
      anchorsSvg += `<circle cx="${x}" cy="${y}" r="2.5" fill="${active.color}" stroke="rgba(0,0,0,0.4)" stroke-width="0.6" pointer-events="none" />`;
    }
    anchorsG.innerHTML = anchorsSvg;
  }

  function setActive(idx) {
    activeIdx = idx;
    tabBtns.forEach((b, j) => {
      b.style.fontWeight = (j === idx) ? "bold" : "normal";
      b.style.borderColor = (j === idx) ? COLOR_CURVES_CHANNELS[idx].color : "";
    });
    repaint();
  }

  // Paint mode: pointerdown / move / up. The pointerdown sets the
  // first point; each subsequent pointermove paints from the
  // previous (lastIdx, lastVal) to the current (i, v), filling in
  // every LUT index between them with a linearly-interpolated value
  // so fast drags don't leave the curve gappy.
  function paintAt(cx, cy) {
    if (!painting) return;
    const i = Math.max(0, Math.min(CURVES_N - 1, iForX(cx)));
    const v = Math.max(0, Math.min(1, vForY(cy)));
    const arr = node.params[COLOR_CURVES_CHANNELS[activeIdx].key];
    if (lastIdx < 0 || lastIdx === i) {
      arr[i] = v;
    } else {
      // Walk from lastIdx + step toward i, inclusive of i.
      const step = i > lastIdx ? 1 : -1;
      const dist = Math.abs(i - lastIdx);
      for (let k = 1; k <= dist; k++) {
        const j = lastIdx + k * step;
        const t = k / dist;
        arr[j] = lastVal + (v - lastVal) * t;
      }
    }
    lastIdx = i;
    lastVal = v;
    repaint();
  }

  svg.addEventListener("pointerdown", (e) => {
    const rect = svg.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width)  * W;
    const cy = ((e.clientY - rect.top)  / rect.height) * H;
    painting = true;
    lastIdx  = -1;   // first frame uses just the down position
    svg.setPointerCapture(e.pointerId);
    paintAt(cx, cy);
    e.preventDefault();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!painting) return;
    const rect = svg.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width)  * W;
    const cy = ((e.clientY - rect.top)  / rect.height) * H;
    paintAt(cx, cy);
  });
  function endPaint() {
    if (painting) {
      pushHistory("colorcurves:paint:" + node.id + ":" + COLOR_CURVES_CHANNELS[activeIdx].key);
    }
    painting = false;
    lastIdx  = -1;
  }
  svg.addEventListener("pointerup", endPaint);
  svg.addEventListener("pointercancel", endPaint);
  svg.addEventListener("pointerleave", endPaint);

  // Tab clicks.
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-cc-tab"), 10);
      if (!isNaN(idx)) setActive(idx);
    });
  });

  // Smooth: 3-tap moving average pass over the active curve. Useful
  // after a shaky paint stroke -- runs once per click; click again
  // for more smoothing. Endpoints are anchored (i=0, i=63) so the
  // curve doesn't drift away from clean 0..1 range.
  pane.querySelector("#btn-cc-smooth").addEventListener("click", () => {
    const arr = node.params[COLOR_CURVES_CHANNELS[activeIdx].key];
    const next = arr.slice();
    for (let i = 1; i < CURVES_N - 1; i++) {
      next[i] = (arr[i - 1] + arr[i] + arr[i + 1]) / 3;
    }
    node.params[COLOR_CURVES_CHANNELS[activeIdx].key] = next;
    pushHistory("colorcurves:smooth:" + node.id + ":" + COLOR_CURVES_CHANNELS[activeIdx].key);
    repaint();
  });

  // Reset buttons.
  pane.querySelector("#btn-cc-reset").addEventListener("click", () => {
    node.params[COLOR_CURVES_CHANNELS[activeIdx].key] = defaultCurveN();
    pushHistory("colorcurves:reset:" + node.id + ":" + COLOR_CURVES_CHANNELS[activeIdx].key);
    repaint();
  });
  pane.querySelector("#btn-cc-reset-all").addEventListener("click", () => {
    for (const ch of COLOR_CURVES_CHANNELS) node.params[ch.key] = defaultCurveN();
    pushHistory("colorcurves:reset-all:" + node.id);
    repaint();
  });
  pane.querySelector("#btn-cc-done").addEventListener("click", () => {
    closeColorCurvesModal();
  });

  setActive(0);
  return pane;
}

/* Builds the draw pane for an EnvDraw node. Mirrors buildCurveDrawPane
 * but adds a draggable sustain marker (amber dashed vertical line)
 * and tinted regions on either side of it. Painting and sustain-drag
 * use the same pointer-capture pattern; the pointerdown decides which
 * mode (paint vs sustain-drag) based on hit-test against the marker
 * grip. */
function buildEnvDrawPane(node) {
  const W = 520, H = 200;
  const pad = 8;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  const tbl = node.params.curveTable;
  const N = tbl.length;
  const HANDLE_HIT = 12;     // px hit-zone around the sustain line

  const xForIdx = (i) => pad + (i / (N - 1)) * plotW;
  const idxForX = (cx) => Math.round(((cx - pad) / plotW) * (N - 1));

  const pane = document.createElement("div");
  pane.className = "curve-draw-pane";

  const sIdx = node.params.sustainIdx;
  const sx = xForIdx(sIdx).toFixed(1);

  pane.innerHTML =
    '<svg class="curve-draw-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      // Background regions — attack (left) and release (right) tints.
      '<rect class="envdraw-region-attack"  x="' + pad + '" y="' + pad + '" width="' + (sx - pad) + '" height="' + plotH + '" />' +
      '<rect class="envdraw-region-release" x="' + sx  + '" y="' + pad + '" width="' + (W - pad - sx) + '" height="' + plotH + '" />' +
      // Grid + axis labels.
      '<line class="curve-grid" x1="' + pad + '" y1="' + (pad + plotH * 0.5) + '" x2="' + (W - pad) + '" y2="' + (pad + plotH * 0.5) + '" />' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + pad + '" x2="' + (W - pad) + '" y2="' + pad + '" />' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '" />' +
      '<text class="curve-axis-label" x="' + (pad + 2) + '" y="' + (pad + 10) + '">1.0</text>' +
      '<text class="curve-axis-label" x="' + (pad + 2) + '" y="' + (H - pad - 2) + '">0.0</text>' +
      // Curve fill + stroke.
      '<path class="curve-fill" d="" />' +
      '<path class="curve-line" d="" />' +
      // Sustain marker — dashed line plus a fat grip box at the top
      // for easy grabbing. Rendered last so it sits above the curve.
      '<line class="envdraw-sustain-line" x1="' + sx + '" y1="' + pad + '" x2="' + sx + '" y2="' + (H - pad) + '" />' +
      '<rect class="envdraw-sustain-grip" x="' + (sx - 5) + '" y="' + pad + '" width="10" height="10" />' +
      '<text class="envdraw-sustain-label" x="' + (sx - 24) + '" y="' + (pad + 22) + '">SUST</text>' +
    '</svg>' +
    '<div class="envdraw-fields">' +
      '<label>Attack</label>' +
      '<input type="number" id="envdraw-attack" min="0.001" max="10" step="0.01" />' +
      '<label>Release</label>' +
      '<input type="number" id="envdraw-release" min="0.001" max="10" step="0.01" />' +
      '<span class="envdraw-readout" id="envdraw-readout">sustain @ index — / — · 0.0 v</span>' +
    '</div>' +
    '<div class="curve-draw-actions">' +
      '<button class="btn" id="btn-envdraw-reset">Reset shape</button>' +
      '<button class="btn" id="btn-envdraw-smooth">Smooth</button>' +
      '<button class="btn primary" id="btn-envdraw-done">Done</button>' +
    '</div>';

  const svg = pane.querySelector(".curve-draw-svg");
  const fillPath = pane.querySelector(".curve-fill");
  const linePath = pane.querySelector(".curve-line");
  const regAtk = pane.querySelector(".envdraw-region-attack");
  const regRel = pane.querySelector(".envdraw-region-release");
  const sLine  = pane.querySelector(".envdraw-sustain-line");
  const sGrip  = pane.querySelector(".envdraw-sustain-grip");
  const sLabel = pane.querySelector(".envdraw-sustain-label");
  const atkInp = pane.querySelector("#envdraw-attack");
  const relInp = pane.querySelector("#envdraw-release");
  const readout = pane.querySelector("#envdraw-readout");

  atkInp.value = (typeof node.params.attack === "number") ? node.params.attack.toFixed(2) : "0.50";
  relInp.value = (typeof node.params.release === "number") ? node.params.release.toFixed(2) : "0.50";

  function tableToPathData() {
    const pts = [];
    for (let i = 0; i < N; i++) {
      const x = xForIdx(i);
      const y = pad + (1 - tbl[i]) * plotH;
      pts.push((i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1));
    }
    return pts.join(" ");
  }
  function refreshAll() {
    const d = tableToPathData();
    linePath.setAttribute("d", d);
    fillPath.setAttribute("d", d + ` L ${pad + plotW},${pad + plotH} L ${pad},${pad + plotH} Z`);
    const sIdxNow = node.params.sustainIdx;
    const sxNow = xForIdx(sIdxNow);
    regAtk.setAttribute("width", (sxNow - pad).toFixed(1));
    regRel.setAttribute("x", sxNow.toFixed(1));
    regRel.setAttribute("width", (W - pad - sxNow).toFixed(1));
    sLine.setAttribute("x1", sxNow.toFixed(1));
    sLine.setAttribute("x2", sxNow.toFixed(1));
    sGrip.setAttribute("x", (sxNow - 5).toFixed(1));
    sLabel.setAttribute("x", (sxNow - 24).toFixed(1));
    const v = (typeof tbl[sIdxNow] === "number") ? tbl[sIdxNow] : 0;
    readout.textContent = `sustain @ index ${sIdxNow} / ${N - 1} · ${v.toFixed(2)} v`;
  }

  // Mode determined on pointerdown: "paint" (free-draw curve) vs
  // "sustain" (drag the marker). Hit-test the sustain grip first
  // so the marker is always grabbable from anywhere along its
  // vertical extent (within ±HANDLE_HIT pixels).
  let mode = null;
  let last = null;

  function svgCoords(ev) {
    const r = svg.getBoundingClientRect();
    const sx = W / r.width;
    const sy = H / r.height;
    return {
      x: (ev.clientX - r.left) * sx,
      y: (ev.clientY - r.top)  * sy
    };
  }
  function paintAt(c, prev) {
    const px = (c.x - pad) / plotW;
    const py = 1 - (c.y - pad) / plotH;
    const i = Math.round(Math.max(0, Math.min(1, px)) * (N - 1));
    const v = Math.max(0, Math.min(1, py));
    if (prev && prev.i !== undefined) {
      const lo = Math.min(prev.i, i), hi = Math.max(prev.i, i);
      if (hi > lo) {
        const a = (lo === prev.i) ? prev.v : v;
        const b = (lo === prev.i) ? v : prev.v;
        for (let k = lo; k <= hi; k++) {
          const t = (k - lo) / (hi - lo);
          tbl[k] = a * (1 - t) + b * t;
        }
      } else {
        tbl[i] = v;
      }
    } else {
      tbl[i] = v;
    }
    return { i, v };
  }

  svg.addEventListener("pointerdown", ev => {
    ev.preventDefault();
    svg.setPointerCapture(ev.pointerId);
    const c = svgCoords(ev);
    const sxNow = xForIdx(node.params.sustainIdx);
    if (Math.abs(c.x - sxNow) <= HANDLE_HIT) {
      mode = "sustain";
      pushHistory("envdraw:sustain:" + node.id);
    } else {
      mode = "paint";
      pushHistory("envdraw:curve:" + node.id);
      last = paintAt(c, null);
    }
  });
  svg.addEventListener("pointermove", ev => {
    if (!mode) return;
    const c = svgCoords(ev);
    if (mode === "sustain") {
      let i = idxForX(c.x);
      if (i < 1) i = 1;
      if (i > N - 2) i = N - 2;
      node.params.sustainIdx = i;
    } else {
      last = paintAt(c, last);
    }
    refreshAll();
  });
  function endStroke() {
    if (!mode) return;
    mode = null;
    last = null;
    renderCode(); renderJson();
  }
  svg.addEventListener("pointerup",     endStroke);
  svg.addEventListener("pointercancel", endStroke);
  svg.addEventListener("pointerleave", endStroke);

  // Numeric inputs for attack / release time.
  atkInp.addEventListener("change", () => {
    const v = parseFloat(atkInp.value);
    if (isFinite(v) && v > 0) {
      pushHistory("envdraw:attack:" + node.id);
      node.params.attack = v;
      renderCode(); renderJson();
    }
  });
  relInp.addEventListener("change", () => {
    const v = parseFloat(relInp.value);
    if (isFinite(v) && v > 0) {
      pushHistory("envdraw:release:" + node.id);
      node.params.release = v;
      renderCode(); renderJson();
    }
  });

  pane.querySelector("#btn-envdraw-reset").addEventListener("click", () => {
    pushHistory("envdraw:reset:" + node.id);
    const def = defaultEnvDrawTable();
    for (let i = 0; i < N; i++) tbl[i] = def[i];
    node.params.sustainIdx = Math.floor(N / 2);
    refreshAll();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-envdraw-smooth").addEventListener("click", () => {
    pushHistory("envdraw:smooth:" + node.id);
    const nxt = tbl.slice();
    for (let i = 1; i < N - 1; i++) nxt[i] = (tbl[i - 1] + tbl[i] + tbl[i + 1]) / 3;
    for (let i = 0; i < N; i++) tbl[i] = nxt[i];
    refreshAll();
    renderCode(); renderJson();
  });
  pane.querySelector("#btn-envdraw-done").addEventListener("click", closeEnvDrawModal);

  refreshAll();
  return pane;
}
(function setupRampModal() {
  const close = document.getElementById("btn-ramp-close");
  const modal = document.getElementById("ramp-modal");
  if (close) close.addEventListener("click", closeRampModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeRampModal(); });
})();

/* ====================================================================
 * PIANO-ROLL EDITOR
 *
 * Pro-grade time × pitch sequencer modeled after Ableton Live, rendered
 * through the lab-instrument lens (CRT phosphor on near-black). Layout
 * is a 2×3 CSS grid:
 *
 *     ┌──────┬───────────────┐
 *     │ corn │ ruler         │   ← 28px ruler (bar.beat numbers)
 *     ├──────┼───────────────┤
 *     │ keys │ NOTE GRID     │   ← scroll origin (X + Y)
 *     │      │ ── scrolls ── │
 *     ├──────┼───────────────┤
 *     │ vC   │ velocity lane │   ← scrolls X with grid
 *     └──────┴───────────────┘
 *
 * Sub-divs around the grid (`overflow: hidden`) get their scrollLeft /
 * scrollTop driven by JS so everything stays aligned.
 *
 * Tools:   draw / select / erase
 * Snap:    1/16, 1/8, 1/4, 1/2, 1/1 (snap is delta-quantized for moves
 *          so off-grid notes preserve their off-grid offsets)
 * Zoom:    H × V independent presets
 * Selection: stable runtime ids on each note so re-renders don't lose
 *          the selection set.
 *
 * Storage: node.params.notes = [{ start, dur, midi, vel }, ...]. The
 * runtime adds an `_id` to each note for selection tracking; the
 * codegen + serializer ignore it (see extraCtor in the registry —
 * iterates explicit fields only).
 * ================================================================== */

const PR_PITCH_LO = 36;                       // MIDI C2 (lowest visible)
const PR_PITCH_HI = 96;                       // MIDI C7 (exclusive upper)
const PR_KEYS_W   = 64;
const PR_RULER_H  = 28;
const PR_VEL_H    = 110;
const PR_HANDLE_W = 6;                        // resize-handle width (px, screen)

const PR_ZOOM_X = [12, 18, 28, 42, 64, 96];   // px per step
const PR_ZOOM_Y = [10, 14, 18, 24, 32];       // px per pitch row
const PR_SNAP_VALUES = [1, 2, 4, 8, 16];      // steps per snap
const PR_SNAP_LABELS = ["1/16", "1/8", "1/4", "1/2", "1/1"];

const NOTE_NAMES_PR = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function prMidiName(m) {
  const idx = ((m % 12) + 12) % 12;
  return NOTE_NAMES_PR[idx] + Math.floor(m / 12 - 1);
}
function prPitchClass(m) { return ((m % 12) + 12) % 12; }
function prIsBlackKey(m) {
  const c = prPitchClass(m);
  return c === 1 || c === 3 || c === 6 || c === 8 || c === 10;
}
function prIsCKey(m) { return prPitchClass(m) === 0; }

/* Stable runtime ids on notes — selection set is keyed by these so
 * full re-renders don't blow away the selection. Stripped implicitly
 * on serialize because extraCtor iterates only the canonical fields. */
let _prNoteIdCounter = 1;
function prEnsureIds(notes) {
  notes.forEach(n => { if (n && n._id == null) n._id = "n" + (_prNoteIdCounter++); });
}

/* Editor state. Tool / snap / zoom persist across opens — once you set
 * them the first time you don't have to set them every time.
 *
 * Multi-track fields (multi / activeTrack) are populated when the
 * modal opens on a MultiPianoRoll node; for the single-track
 * PianoRoll they stay at default and the codepaths below silently
 * collapse to the single-track behavior. */
const _prEd = {
  nodeId:   null,
  multi:    false,                // true when editing a MultiPianoRoll
  activeTrack: 0,                 // 0..3 (multi mode)
  tool:     "draw",
  snapIx:   0,                    // index into PR_SNAP_VALUES
  zoomX:    2,                    // index into PR_ZOOM_X
  zoomY:    1,                    // index into PR_ZOOM_Y
  defaultVel: 1.0,
  selected: new Set(),            // runtime _ids
  drag:     null,                 // { kind, ... } during pointerdown..up
  hoverCell:null,                 // { step, midi } | null
};

/* Track of a note (defaulting to 0 for legacy single-track patches). */
function prTrackOf(n) { return (n && typeof n.track === "number") ? n.track : 0; }
function prIsActiveTrack(n) { return !_prEd.multi || prTrackOf(n) === _prEd.activeTrack; }

/* Backwards-compat alias — older code in this file references
 * _pianoRollNodeId / _pianoRollVel directly. Keep the names live. */
let _pianoRollNodeId = null;
let _pianoRollVel    = 1.0;

function prCellW() { return PR_ZOOM_X[_prEd.zoomX]; }
function prCellH() { return PR_ZOOM_Y[_prEd.zoomY]; }
function prSnapSteps() { return PR_SNAP_VALUES[_prEd.snapIx] || 1; }
function prRoundSnap(steps) {
  const s = prSnapSteps();
  return Math.round(steps / s) * s;
}

function prGetNode() {
  return state.nodes.find(n => n.id === _prEd.nodeId);
}
function prGetLen() {
  const n = prGetNode();
  if (!n) return 16;
  if (_prEd.multi) return prGetLenForTrack(_prEd.activeTrack);
  return Math.max(1, Math.min(64, parseInt(n.params.patternLen, 10) || 16));
}
/* Per-track pattern length lookup. Used by note-draw bounds checks
 * (inactive tracks may have a different length than the active one
 * — we want their notes to still render, clamped to their own
 * track's length, not the active track's). */
function prGetLenForTrack(track) {
  const n = prGetNode();
  if (!n) return 16;
  if (_prEd.multi) {
    const lens = Array.isArray(n.params.patternLens) ? n.params.patternLens : [16, 16, 16, 16];
    const v = parseInt(lens[track], 10);
    return Math.max(1, Math.min(64, isFinite(v) ? v : 16));
  }
  return Math.max(1, Math.min(64, parseInt(n.params.patternLen, 10) || 16));
}
/* Sets the active track's pattern length in either single- or multi-track
 * mode and trims notes that fall outside the new range. */
function prSetLen(v) {
  const node = prGetNode();
  if (!node) return;
  v = Math.max(1, Math.min(64, parseInt(v, 10) || 16));
  pushHistory("pr:len:" + node.id);
  if (_prEd.multi) {
    if (!Array.isArray(node.params.patternLens)) node.params.patternLens = [16, 16, 16, 16];
    node.params.patternLens[_prEd.activeTrack] = v;
    if (Array.isArray(node.params.notes)) {
      // Only trim notes belonging to the active track; other tracks'
      // patterns are independent.
      node.params.notes = node.params.notes.filter(n => {
        if (!n) return false;
        if (prTrackOf(n) !== _prEd.activeTrack) return true;
        return n.start < v;
      });
    }
  } else {
    node.params.patternLen = v;
    if (Array.isArray(node.params.notes)) {
      node.params.notes = node.params.notes.filter(n => n && n.start < v);
    }
  }
}

/* ── Rendering ──────────────────────────────────────────────────── */

function renderPianoRollGrid() {
  // Public name kept for the rest of the codebase that calls it.
  renderPianoRoll();
}

function renderPianoRoll() {
  const node = prGetNode();
  if (!node) return;
  if (!Array.isArray(node.params.notes)) node.params.notes = [];
  prEnsureIds(node.params.notes);

  const len   = prGetLen();
  const cellW = prCellW();
  const cellH = prCellH();
  const pitchCount = PR_PITCH_HI - PR_PITCH_LO;
  const gridW = len * cellW;
  const gridH = pitchCount * cellH;

  const wrap = document.getElementById("pr-grid-wrap");
  // Snapshot scroll before re-render so we can restore it.
  const sX = wrap ? wrap.scrollLeft : 0;
  const sY = wrap ? wrap.scrollTop  : 0;

  prRenderRuler(len, cellW);
  prRenderKeys(pitchCount, cellH);
  prRenderGrid(node, len, cellW, cellH, pitchCount, gridW, gridH);
  prRenderVel(node, len, cellW, gridW);

  if (wrap) {
    wrap.scrollLeft = sX;
    wrap.scrollTop  = sY;
  }
  prSyncScroll();

  prRenderStatus(node);
  prRenderReadout();
  prSyncToolbar();
}

function prRenderRuler(len, cellW) {
  const svg = document.getElementById("pr-ruler");
  if (!svg) return;
  const W = len * cellW;
  const H = PR_RULER_H;
  svg.setAttribute("width",  W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  let html = "";
  for (let s = 0; s <= len; s++) {
    const x = s * cellW;
    if (s % 16 === 0) {
      html += `<line class="pr-bar-line" x1="${x}" y1="0" x2="${x}" y2="${H}" />`;
      if (s < len) {
        const bar = (s / 16) + 1;
        html += `<text class="pr-bar-num" x="${x + 5}" y="${H - 9}">${bar}</text>`;
      }
    } else if (s % 4 === 0) {
      html += `<line class="pr-beat-line" x1="${x}" y1="${H * 0.4}" x2="${x}" y2="${H}" />`;
      if (s < len && cellW >= 22) {
        const beat = ((s % 16) / 4) + 1;
        const bar  = Math.floor(s / 16) + 1;
        html += `<text class="pr-step-num" x="${x + 3}" y="${H - 9}">${bar}.${beat}</text>`;
      }
    } else {
      html += `<line class="pr-step-line" x1="${x}" y1="${H * 0.7}" x2="${x}" y2="${H}" />`;
    }
  }
  // Pattern-end barrier
  html += `<line class="pr-end-line" x1="${len * cellW - 0.5}" y1="0" x2="${len * cellW - 0.5}" y2="${H}" />`;
  svg.innerHTML = html;
}

function prRenderKeys(pitchCount, cellH) {
  const svg = document.getElementById("pr-keys");
  if (!svg) return;
  const W = PR_KEYS_W;
  const H = pitchCount * cellH;
  svg.setAttribute("width",  W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  let html = "";
  for (let r = 0; r < pitchCount; r++) {
    const midi = PR_PITCH_HI - 1 - r;
    const y = r * cellH;
    const isC = prIsCKey(midi);
    const isB = prIsBlackKey(midi);
    const cls = isC ? "pr-key-c" : (isB ? "pr-key-black" : "pr-key-white");
    html += `<rect class="${cls}" x="0" y="${y}" width="${W}" height="${cellH}" data-midi="${midi}" />`;
    if (isB) {
      // Inset darker cap on the right, mimicking a real piano keyboard.
      html += `<rect class="pr-key-cap" x="${W * 0.50}" y="${y + 1}" width="${W * 0.50}" height="${cellH - 2}" />`;
    }
    // Label every C, plus boundary rows for orientation when zoomed in.
    if (isC) {
      const labelCls = "pr-key-label pr-key-label-c";
      const fz = Math.max(8, Math.min(11, cellH * 0.7));
      html += `<text class="${labelCls}" x="6" y="${y + cellH * 0.7}" font-size="${fz}">${prMidiName(midi)}</text>`;
    } else if (cellH >= 18) {
      // At higher zoom, label every white key for finer orientation.
      if (!isB) {
        html += `<text class="pr-key-label" x="6" y="${y + cellH * 0.7}">${prMidiName(midi)}</text>`;
      }
    }
  }
  svg.innerHTML = html;
}

function prRenderGrid(node, len, cellW, cellH, pitchCount, gridW, gridH) {
  const svg = document.getElementById("pr-grid");
  if (!svg) return;
  svg.setAttribute("width",  gridW);
  svg.setAttribute("height", gridH);
  svg.setAttribute("viewBox", `0 0 ${gridW} ${gridH}`);

  let html = "";
  // Row backgrounds — black-key rows recede, C rows get a faint phosphor
  // wash so the user can find octaves at a glance.
  for (let r = 0; r < pitchCount; r++) {
    const midi = PR_PITCH_HI - 1 - r;
    const y = r * cellH;
    const isC = prIsCKey(midi);
    const isB = prIsBlackKey(midi);
    const cls = isC ? "pr-row-c" : (isB ? "pr-row-black" : "pr-row-white");
    html += `<rect class="${cls}" x="0" y="${y}" width="${gridW}" height="${cellH}" />`;
  }
  // Horizontal pitch lines — emphasize each octave (B→C boundary).
  for (let r = 0; r <= pitchCount; r++) {
    const y = r * cellH;
    const midi = r < pitchCount ? PR_PITCH_HI - 1 - r : PR_PITCH_LO;
    const cls = prIsCKey(midi) ? "pr-step-line" : "pr-grid-line";
    html += `<line class="${cls}" x1="0" y1="${y}" x2="${gridW}" y2="${y}" />`;
  }
  // Vertical step lines — bars > beats > steps, intensity stepped down.
  for (let s = 0; s <= len; s++) {
    const x = s * cellW;
    const cls = (s % 16 === 0) ? "pr-bar-line"
              : (s % 4  === 0) ? "pr-beat-line"
              :                  "pr-step-line";
    html += `<line class="${cls}" x1="${x}" y1="0" x2="${x}" y2="${gridH}" />`;
  }
  // Notes with resize handles. In multi-track mode each note is
  // colored by its `track` field; inactive-track notes get a dim
  // class and don't render handles (and pointer-events go to their
  // siblings). The active-track set wraps single-track behavior.
  const notes = node.params.notes;
  // Render inactive-track notes first so active-track ones stack on top.
  const drawNote = (nt, drawHandles) => {
    if (!nt || nt.midi == null) return "";
    if (nt.midi < PR_PITCH_LO || nt.midi >= PR_PITCH_HI) return "";
    const ntLen = _prEd.multi ? prGetLenForTrack(prTrackOf(nt)) : len;
    if (nt.start < 0 || nt.start >= ntLen) return "";
    const dur = Math.max(1, Math.min(ntLen - nt.start, nt.dur || 1));
    const x = nt.start * cellW + 1;
    const y = (PR_PITCH_HI - 1 - nt.midi) * cellH + 1;
    const w = dur * cellW - 2;
    const h = cellH - 2;
    const sel = _prEd.selected.has(nt._id) ? " selected" : "";
    const tr  = prTrackOf(nt);
    const trCls   = _prEd.multi ? ` track-${tr + 1}` : "";
    const inactCls = (_prEd.multi && tr !== _prEd.activeTrack) ? " inactive-track" : "";
    const v = nt.vel != null ? nt.vel : 1;
    const op = Math.max(0.55, Math.min(1, 0.55 + 0.45 * v));
    let s = `<rect class="pr-note${sel}${trCls}${inactCls}" data-nid="${nt._id}" x="${x}" y="${y}" width="${w}" height="${h}" rx="2" opacity="${op}" />`;
    if (drawHandles && !inactCls && w > PR_HANDLE_W * 1.6) {
      s += `<rect class="pr-note-handle" data-nid="${nt._id}" data-handle="1" x="${x + w - PR_HANDLE_W}" y="${y}" width="${PR_HANDLE_W}" height="${h}" rx="1" />`;
    }
    return s;
  };
  // Pass 1 — inactive tracks (drawn behind)
  if (_prEd.multi) {
    notes.forEach(nt => { if (prTrackOf(nt) !== _prEd.activeTrack) html += drawNote(nt, false); });
    notes.forEach(nt => { if (prTrackOf(nt) === _prEd.activeTrack) html += drawNote(nt, true);  });
  } else {
    notes.forEach(nt => { html += drawNote(nt, true); });
  }
  // Transient overlays (preview / marquee / crosshair) — JS toggles them
  // via attribute instead of re-rendering the whole grid.
  html += `<rect class="pr-preview" x="0" y="0" width="0" height="0" style="display:none" />`;
  html += `<rect class="pr-marquee" x="0" y="0" width="0" height="0" style="display:none" />`;
  html += `<line class="pr-cross-v" x1="0" y1="0" x2="0" y2="${gridH}" style="display:none" />`;
  html += `<line class="pr-cross-h" x1="0" y1="0" x2="${gridW}" y2="0" style="display:none" />`;
  svg.innerHTML = html;
}

function prRenderVel(node, len, cellW, gridW) {
  const svg = document.getElementById("pr-vel");
  if (!svg) return;
  const H = PR_VEL_H;
  svg.setAttribute("width",  gridW);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${gridW} ${H}`);
  let html = "";
  // Background bar/beat ticks
  for (let s = 0; s <= len; s++) {
    const x = s * cellW;
    const cls = (s % 16 === 0) ? "pr-bar-line"
              : (s % 4  === 0) ? "pr-beat-line"
              :                  "pr-step-line";
    html += `<line class="${cls}" x1="${x}" y1="0" x2="${x}" y2="${H}" />`;
  }
  [0.25, 0.5, 0.75].forEach(v => {
    const y = H - v * H;
    html += `<line class="pr-vel-grid" x1="0" y1="${y}" x2="${gridW}" y2="${y}" />`;
  });
  html += `<line class="pr-vel-baseline" x1="0" y1="${H - 0.5}" x2="${gridW}" y2="${H - 0.5}" />`;

  const notes = node.params.notes;
  // Same track-stacking pattern as the grid: inactive tracks behind,
  // active in front. Inactive bars are unselectable + faded.
  const drawVelBar = (nt) => {
    if (!nt || nt.midi == null) return "";
    const ntLen = _prEd.multi ? prGetLenForTrack(prTrackOf(nt)) : len;
    if (nt.start < 0 || nt.start >= ntLen) return "";
    const x = nt.start * cellW + 2;
    const w = Math.max(2, cellW - 4);
    const v = nt.vel != null ? nt.vel : 1;
    const barH = Math.max(2, v * (H - 4));
    const y = H - barH - 1;
    const sel = _prEd.selected.has(nt._id) ? " selected" : "";
    const tr  = prTrackOf(nt);
    const trCls    = _prEd.multi ? ` track-${tr + 1}` : "";
    const inactCls = (_prEd.multi && tr !== _prEd.activeTrack) ? " inactive-track" : "";
    let s = `<rect class="pr-vel-bar${sel}${trCls}${inactCls}" data-nid="${nt._id}" x="${x}" y="${y}" width="${w}" height="${barH}" rx="1" />`;
    if (!inactCls) {
      s += `<rect class="pr-vel-handle" data-nid="${nt._id}" x="${x - 1}" y="${y - 3}" width="${w + 2}" height="6" rx="1" />`;
    }
    return s;
  };
  if (_prEd.multi) {
    notes.forEach(nt => { if (prTrackOf(nt) !== _prEd.activeTrack) html += drawVelBar(nt); });
    notes.forEach(nt => { if (prTrackOf(nt) === _prEd.activeTrack) html += drawVelBar(nt); });
  } else {
    notes.forEach(nt => { html += drawVelBar(nt); });
  }
  svg.innerHTML = html;
}

function prRenderStatus(node) {
  const cnt = document.getElementById("pr-stat-count");
  const sel = document.getElementById("pr-stat-selected");
  const snp = document.getElementById("pr-stat-snap");
  if (cnt) cnt.textContent = String((node.params.notes || []).length);
  if (sel) sel.textContent = String(_prEd.selected.size);
  if (snp) snp.textContent = PR_SNAP_LABELS[_prEd.snapIx] || "1/16";
}

function prRenderReadout() {
  const r = document.getElementById("pianoroll-readout");
  if (!r) return;
  const c = _prEd.hoverCell;
  if (!c) { r.textContent = "PITCH —    POS —.—.—"; return; }
  const bar  = Math.floor(c.step / 16) + 1;
  const beat = Math.floor((c.step % 16) / 4) + 1;
  const six  = (c.step % 4) + 1;
  const name = prMidiName(c.midi);
  r.textContent = `PITCH ${name.padEnd(4)}  POS ${bar}.${beat}.${six}`;
}

function prSyncToolbar() {
  document.querySelectorAll(".pr-tool").forEach(b => {
    b.classList.toggle("active", b.dataset.tool === _prEd.tool);
  });
  document.querySelectorAll(".pr-track").forEach(b => {
    b.classList.toggle("active", parseInt(b.dataset.track, 10) === _prEd.activeTrack);
  });
  const wrap = document.getElementById("pr-grid-wrap");
  if (wrap) wrap.dataset.tool = _prEd.tool;
  const snapEl = document.getElementById("pr-snap");
  if (snapEl) snapEl.value = String(_prEd.snapIx);
  // Sync the length + default-velocity inputs to the active track's
  // values when in multi-track mode (so switching tabs updates them).
  if (_prEd.multi) {
    const node = prGetNode();
    if (node) {
      const lenEl = document.getElementById("pianoroll-len");
      const velEl = document.getElementById("pianoroll-vel");
      if (lenEl && document.activeElement !== lenEl) lenEl.value = prGetLen();
      if (velEl && document.activeElement !== velEl) {
        const dv = (Array.isArray(node.params.defaultVels) ? Number(node.params.defaultVels[_prEd.activeTrack]) : 1) || 1;
        _prEd.defaultVel = dv;
        velEl.value = dv.toFixed(2);
      }
    }
  }
}

/* Switch which track is active in multi-track mode. Clears the
 * selection (selection from track A doesn't carry to track B), syncs
 * the toolbar, and re-renders so coloring reflects the new active. */
function prSetActiveTrack(track) {
  if (!_prEd.multi) return;
  track = Math.max(0, Math.min(3, track));
  if (track === _prEd.activeTrack) return;
  _prEd.activeTrack = track;
  _prEd.selected.clear();
  const node = prGetNode();
  if (node) node.params.activeTrack = track;
  renderPianoRoll();
}

function prSyncScroll() {
  const wrap  = document.getElementById("pr-grid-wrap");
  const ruler = document.querySelector(".pr-ruler-wrap");
  const keys  = document.querySelector(".pr-keys-wrap");
  const vel   = document.querySelector(".pr-vel-wrap");
  if (!wrap || !ruler || !keys || !vel) return;
  ruler.scrollLeft = wrap.scrollLeft;
  keys.scrollTop   = wrap.scrollTop;
  vel.scrollLeft   = wrap.scrollLeft;
}

/* ── Hit testing & cell math ────────────────────────────────────── */

function prCellAt(ev) {
  const svg = document.getElementById("pr-grid");
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  const cellW = prCellW(), cellH = prCellH();
  const cx = ev.clientX - r.left;
  const cy = ev.clientY - r.top;
  if (cx < 0 || cy < 0 || cx > r.width || cy > r.height) return null;
  const step = Math.floor(cx / cellW);
  const row  = Math.floor(cy / cellH);
  const len  = prGetLen();
  const pitchCount = PR_PITCH_HI - PR_PITCH_LO;
  if (step < 0 || step >= len) return null;
  if (row  < 0 || row  >= pitchCount) return null;
  return { step, midi: PR_PITCH_HI - 1 - row, x: cx, y: cy };
}

function prFindNote(nid) {
  const node = prGetNode();
  if (!node) return null;
  return (node.params.notes || []).find(n => n._id === nid) || null;
}

/* ── Interaction: pointer on the grid ───────────────────────────── */

function prInstallGridHandlers() {
  const svg = document.getElementById("pr-grid");
  const wrap = document.getElementById("pr-grid-wrap");
  if (!svg || !wrap) return;

  svg.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const node = prGetNode();
    if (!node) return;
    const target = ev.target;
    const isHandle = target && target.classList.contains("pr-note-handle");
    const isNote   = target && target.classList.contains("pr-note");
    const cell = prCellAt(ev);

    // Erase tool — click any note (or its handle) deletes it.
    if (_prEd.tool === "erase") {
      if (isNote || isHandle) {
        const nid = target.dataset.nid;
        prDeleteNotes([nid]);
      }
      return;
    }

    // Resize handle (any tool except erase): drag right edge to lengthen.
    if (isHandle) {
      const nid = target.dataset.nid;
      // If clicking handle of a non-selected note, replace selection.
      if (!_prEd.selected.has(nid)) {
        _prEd.selected = new Set([nid]);
      }
      const orig = {};
      _prEd.selected.forEach(id => {
        const nt = prFindNote(id);
        if (nt) orig[id] = { start: nt.start, dur: nt.dur };
      });
      _prEd.drag = { kind: "resize", anchor: cell, orig };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      pushHistory("pr:resize:" + node.id);
      return;
    }

    // Note body click — depends on tool.
    if (isNote) {
      const nid = target.dataset.nid;
      if (_prEd.tool === "draw") {
        // In pencil mode, clicking a note picks it up to move.
        if (!_prEd.selected.has(nid)) _prEd.selected = new Set([nid]);
      } else { // select
        if (ev.shiftKey) {
          if (_prEd.selected.has(nid)) _prEd.selected.delete(nid);
          else _prEd.selected.add(nid);
        } else if (!_prEd.selected.has(nid)) {
          _prEd.selected = new Set([nid]);
        }
      }
      const orig = {};
      _prEd.selected.forEach(id => {
        const nt = prFindNote(id);
        if (nt) orig[id] = { start: nt.start, midi: nt.midi };
      });
      _prEd.drag = { kind: "move", anchor: cell, orig, moved: false };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      // Snapshot history at drag start so undo reverts to the pre-drag
      // layout. If the user clicks without dragging the snapshot is a
      // duplicate of the current state — harmless (one extra no-op undo).
      pushHistory("pr:move:" + node.id);
      renderPianoRoll();
      return;
    }

    // Empty grid — depends on tool.
    if (!cell) return;
    if (_prEd.tool === "draw") {
      if (!ev.shiftKey) _prEd.selected.clear();
      _prEd.drag = { kind: "draw", anchor: cell };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      prShowPreview(cell.step, cell.midi, 1);
    } else if (_prEd.tool === "select") {
      if (!ev.shiftKey) _prEd.selected.clear();
      _prEd.drag = { kind: "marquee", origin: cell, startMembers: new Set(_prEd.selected) };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    }
    renderPianoRoll();
  });

  svg.addEventListener("pointermove", ev => {
    const cell = prCellAt(ev);
    _prEd.hoverCell = cell;
    prRenderReadout();
    prShowCrosshair(ev);
    const drag = _prEd.drag;
    if (!drag) return;
    if (drag.kind === "draw") {
      if (!cell) return;
      const lo = Math.min(drag.anchor.step, cell.step);
      const hi = Math.max(drag.anchor.step, cell.step);
      prShowPreview(lo, drag.anchor.midi, hi - lo + 1);
    } else if (drag.kind === "move") {
      if (!cell) return;
      const dStep = prRoundSnap(cell.step - drag.anchor.step);
      const dMidi = cell.midi - drag.anchor.midi;
      if (dStep !== 0 || dMidi !== 0) drag.moved = true;
      prApplyMovePreview(drag, dStep, dMidi);
    } else if (drag.kind === "resize") {
      if (!cell) return;
      const dStep = prRoundSnap(cell.step - drag.anchor.step);
      prApplyResizePreview(drag, dStep);
    } else if (drag.kind === "marquee") {
      if (!cell) return;
      prUpdateMarquee(drag.origin, cell);
      prMarqueeSelect(drag.origin, cell, drag.startMembers);
    }
  });

  function endDrag(ev) {
    const drag = _prEd.drag;
    if (!drag) return;
    if (drag.kind === "draw") {
      const cell = prCellAt(ev) || drag.anchor;
      const node = prGetNode();
      if (node) {
        const lo = Math.min(drag.anchor.step, cell.step);
        const hi = Math.max(drag.anchor.step, cell.step);
        const dur = Math.max(1, hi - lo + 1);
        pushHistory("pr:add:" + node.id);
        const newNote = { start: lo, dur, midi: drag.anchor.midi, vel: _prEd.defaultVel, _id: "n" + (_prNoteIdCounter++) };
        // Multi-track: the new note is born on the active track. The
        // codegen + .gpatch round-trip preserve the field; legacy
        // single-track patches simply omit it.
        if (_prEd.multi) newNote.track = _prEd.activeTrack;
        node.params.notes.push(newNote);
        // Auto-select the just-drawn note for chained operations.
        _prEd.selected = new Set([newNote._id]);
      }
    }
    // Move / resize already mutated state in the live preview; commit
    // means clear the drag state and renormalize.
    _prEd.drag = null;
    prHidePreview();
    prHideMarquee();
    renderPianoRoll();
    renderCode(); renderJson(); renderProps();
  }
  svg.addEventListener("pointerup",     endDrag);
  svg.addEventListener("pointercancel", () => {
    _prEd.drag = null; prHidePreview(); prHideMarquee(); renderPianoRoll();
  });
  svg.addEventListener("pointerleave", () => {
    _prEd.hoverCell = null;
    prRenderReadout();
    prHideCrosshair();
  });
}

function prShowPreview(step, midi, dur) {
  const el = document.querySelector("#pr-grid .pr-preview");
  if (!el) return;
  if (midi < PR_PITCH_LO || midi >= PR_PITCH_HI) {
    el.setAttribute("style", "display:none"); return;
  }
  const cellW = prCellW(), cellH = prCellH();
  const x = step * cellW + 1;
  const y = (PR_PITCH_HI - 1 - midi) * cellH + 1;
  const w = dur * cellW - 2;
  const h = cellH - 2;
  el.setAttribute("x", x);
  el.setAttribute("y", y);
  el.setAttribute("width", Math.max(2, w));
  el.setAttribute("height", Math.max(2, h));
  el.setAttribute("rx", "2");
  el.setAttribute("style", "");
}
function prHidePreview() {
  const el = document.querySelector("#pr-grid .pr-preview");
  if (el) el.setAttribute("style", "display:none");
}

function prUpdateMarquee(origin, cell) {
  const el = document.querySelector("#pr-grid .pr-marquee");
  if (!el) return;
  const cellW = prCellW(), cellH = prCellH();
  const x1 = Math.min(origin.x, cell.x);
  const y1 = Math.min(origin.y, cell.y);
  const w  = Math.abs(cell.x - origin.x);
  const h  = Math.abs(cell.y - origin.y);
  el.setAttribute("x", x1);
  el.setAttribute("y", y1);
  el.setAttribute("width", w);
  el.setAttribute("height", h);
  el.setAttribute("style", "");
}
function prHideMarquee() {
  const el = document.querySelector("#pr-grid .pr-marquee");
  if (el) el.setAttribute("style", "display:none");
}

function prMarqueeSelect(origin, cell, startMembers) {
  const node = prGetNode();
  if (!node) return;
  const cellW = prCellW(), cellH = prCellH();
  const xMin = Math.min(origin.x, cell.x);
  const xMax = Math.max(origin.x, cell.x);
  const yMin = Math.min(origin.y, cell.y);
  const yMax = Math.max(origin.y, cell.y);
  const next = new Set(startMembers);
  (node.params.notes || []).forEach(nt => {
    // Multi-track: marquee only catches active-track notes (Ableton
    // behavior). Other tracks are visible-but-untouchable context.
    if (_prEd.multi && prTrackOf(nt) !== _prEd.activeTrack) return;
    const dur = Math.max(1, nt.dur || 1);
    const nx1 = nt.start * cellW;
    const nx2 = (nt.start + dur) * cellW;
    const ny1 = (PR_PITCH_HI - 1 - nt.midi) * cellH;
    const ny2 = ny1 + cellH;
    if (nx2 < xMin || nx1 > xMax || ny2 < yMin || ny1 > yMax) return;
    next.add(nt._id);
  });
  _prEd.selected = next;
  // Just patch class on the existing note rects to avoid re-render churn.
  document.querySelectorAll("#pr-grid .pr-note").forEach(el => {
    el.classList.toggle("selected", next.has(el.dataset.nid));
  });
  document.querySelectorAll("#pr-vel .pr-vel-bar").forEach(el => {
    el.classList.toggle("selected", next.has(el.dataset.nid));
  });
  prRenderStatus(node);
}

function prShowCrosshair(ev) {
  const cell = _prEd.hoverCell;
  if (!cell) { prHideCrosshair(); return; }
  if (_prEd.tool !== "draw") { prHideCrosshair(); return; }
  const v = document.querySelector("#pr-grid .pr-cross-v");
  const h = document.querySelector("#pr-grid .pr-cross-h");
  if (!v || !h) return;
  const cellW = prCellW(), cellH = prCellH();
  const x = cell.step * cellW;
  const y = (PR_PITCH_HI - 1 - cell.midi) * cellH;
  v.setAttribute("x1", x); v.setAttribute("x2", x);
  v.setAttribute("style", "");
  h.setAttribute("y1", y + cellH / 2); h.setAttribute("y2", y + cellH / 2);
  h.setAttribute("style", "");
}
function prHideCrosshair() {
  const v = document.querySelector("#pr-grid .pr-cross-v");
  const h = document.querySelector("#pr-grid .pr-cross-h");
  if (v) v.setAttribute("style", "display:none");
  if (h) h.setAttribute("style", "display:none");
}

/* Live note mutation during move/resize — operate on node.params.notes
 * directly so the preview is just the next render. The drag's `orig`
 * map holds each note's pre-drag state so deltas don't accumulate. */
function prApplyMovePreview(drag, dStep, dMidi) {
  const node = prGetNode();
  if (!node) return;
  const len = prGetLen();
  Object.keys(drag.orig).forEach(id => {
    const nt = prFindNote(id);
    if (!nt) return;
    const o  = drag.orig[id];
    const dur = Math.max(1, nt.dur || 1);
    let s = o.start + dStep;
    let m = o.midi  + dMidi;
    s = Math.max(0, Math.min(len - dur, s));
    m = Math.max(PR_PITCH_LO, Math.min(PR_PITCH_HI - 1, m));
    nt.start = s; nt.midi = m;
  });
  renderPianoRoll();
}

function prApplyResizePreview(drag, dStep) {
  const node = prGetNode();
  if (!node) return;
  const len = prGetLen();
  Object.keys(drag.orig).forEach(id => {
    const nt = prFindNote(id);
    if (!nt) return;
    const o = drag.orig[id];
    let dur = o.dur + dStep;
    if (dur < 1) dur = 1;
    if (nt.start + dur > len) dur = len - nt.start;
    if (dur < 1) dur = 1;
    nt.dur = dur;
  });
  renderPianoRoll();
}

/* ── Velocity-lane drag ────────────────────────────────────────── */

function prInstallVelHandlers() {
  const svg = document.getElementById("pr-vel");
  if (!svg) return;
  let drag = null;

  function velAt(ev) {
    const r = svg.getBoundingClientRect();
    const cy = ev.clientY - r.top;
    const v = 1 - cy / r.height;
    return Math.max(0, Math.min(1, v));
  }

  svg.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    const target = ev.target;
    const isHandle = target && target.classList.contains("pr-vel-handle");
    const isBar    = target && target.classList.contains("pr-vel-bar");
    if (!isHandle && !isBar) return;
    ev.preventDefault();
    const nid = target.dataset.nid;
    const node = prGetNode();
    if (!node) return;
    const ids = _prEd.selected.has(nid) && _prEd.selected.size > 1
      ? Array.from(_prEd.selected)
      : [nid];
    const orig = {};
    ids.forEach(id => {
      const nt = prFindNote(id);
      if (nt) orig[id] = nt.vel != null ? nt.vel : 1;
    });
    drag = { ids, orig, anchorV: velAt(ev) };
    try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    pushHistory("pr:vel:" + node.id);
  });
  svg.addEventListener("pointermove", ev => {
    if (!drag) return;
    const v = velAt(ev);
    const dv = v - drag.anchorV;
    drag.ids.forEach(id => {
      const nt = prFindNote(id);
      if (!nt) return;
      nt.vel = Math.max(0, Math.min(1, drag.orig[id] + dv));
    });
    renderPianoRoll();
  });
  function endVelDrag() {
    if (!drag) return;
    drag = null;
    renderPianoRoll();
    renderCode(); renderJson();
  }
  svg.addEventListener("pointerup", endVelDrag);
  svg.addEventListener("pointercancel", endVelDrag);
}

/* ── Keyboard sidebar audition (visual only) ───────────────────── */

function prInstallKeysHandlers() {
  const svg = document.getElementById("pr-keys");
  if (!svg) return;
  // Hover highlight on a key row — light visual feedback only; no
  // auditory preview because the audio runtime is independent.
  svg.addEventListener("pointermove", ev => {
    const t = ev.target;
    svg.querySelectorAll(".pr-key-row-hover").forEach(el => el.classList.remove("pr-key-row-hover"));
    if (t && t.tagName === "rect" && t.dataset.midi != null) {
      t.classList.add("pr-key-row-hover");
    }
  });
  svg.addEventListener("pointerleave", () => {
    svg.querySelectorAll(".pr-key-row-hover").forEach(el => el.classList.remove("pr-key-row-hover"));
  });
}

/* ── Bulk operations ───────────────────────────────────────────── */

function prDeleteNotes(ids) {
  const node = prGetNode();
  if (!node) return;
  const set = new Set(ids);
  pushHistory("pr:delete:" + node.id);
  node.params.notes = (node.params.notes || []).filter(n => !set.has(n._id));
  ids.forEach(id => _prEd.selected.delete(id));
  renderPianoRoll();
  renderCode(); renderJson(); renderProps();
}

function prDeleteSelection() {
  if (!_prEd.selected.size) return;
  prDeleteNotes(Array.from(_prEd.selected));
}

function prTransposeSelection(semitones) {
  const node = prGetNode();
  if (!node || !_prEd.selected.size) return;
  pushHistory("pr:transpose:" + node.id);
  (node.params.notes || []).forEach(n => {
    if (!_prEd.selected.has(n._id)) return;
    let m = n.midi + semitones;
    m = Math.max(PR_PITCH_LO, Math.min(PR_PITCH_HI - 1, m));
    n.midi = m;
  });
  renderPianoRoll();
  renderCode(); renderJson();
}

function prDuplicateSelection() {
  const node = prGetNode();
  if (!node || !_prEd.selected.size) return;
  const len = prGetLen();
  // Duplicate offset: longest selected duration, so the copy starts
  // immediately after the last edge of the selection.
  const sel = (node.params.notes || []).filter(n => _prEd.selected.has(n._id));
  if (!sel.length) return;
  const lastEnd = sel.reduce((m, n) => Math.max(m, n.start + (n.dur || 1)), 0);
  const firstStart = sel.reduce((m, n) => Math.min(m, n.start), Infinity);
  const offset = Math.max(1, lastEnd - firstStart);
  pushHistory("pr:duplicate:" + node.id);
  const newIds = new Set();
  sel.forEach(n => {
    const tr = prTrackOf(n);
    const trLen = _prEd.multi ? prGetLenForTrack(tr) : len;
    const ns = n.start + offset;
    if (ns >= trLen) return;
    const nd = Math.min(n.dur || 1, trLen - ns);
    const copy = { start: ns, dur: nd, midi: n.midi, vel: n.vel, _id: "n" + (_prNoteIdCounter++) };
    if (_prEd.multi) copy.track = tr;
    node.params.notes.push(copy);
    newIds.add(copy._id);
  });
  _prEd.selected = newIds;
  renderPianoRoll();
  renderCode(); renderJson(); renderProps();
}

function prSelectAll() {
  const node = prGetNode();
  if (!node) return;
  const all = node.params.notes || [];
  // In multi-track mode, ⌘A selects only the active track. Cmd+Shift+A
  // (handled by the keydown listener) selects across all tracks.
  const list = _prEd.multi
    ? all.filter(n => prTrackOf(n) === _prEd.activeTrack)
    : all;
  _prEd.selected = new Set(list.map(n => n._id));
  renderPianoRoll();
}
function prSelectAllTracks() {
  const node = prGetNode();
  if (!node) return;
  _prEd.selected = new Set((node.params.notes || []).map(n => n._id));
  renderPianoRoll();
}

/* ── Modal lifecycle ───────────────────────────────────────────── */

function openPianoRollModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const def  = defOf(node);
  _prEd.nodeId = nodeId;
  _pianoRollNodeId = nodeId;     // legacy alias kept live
  _prEd.multi = def && def.kind === "multiPianoRoll";
  if (!Array.isArray(node.params.notes)) node.params.notes = [];
  if (_prEd.multi) {
    if (!Array.isArray(node.params.patternLens) || node.params.patternLens.length !== 4) {
      node.params.patternLens = [16, 16, 16, 16];
    }
    if (!Array.isArray(node.params.defaultVels) || node.params.defaultVels.length !== 4) {
      node.params.defaultVels = [1, 1, 1, 1];
    }
    _prEd.activeTrack = Math.max(0, Math.min(3, parseInt(node.params.activeTrack, 10) || 0));
  } else {
    if (typeof node.params.patternLen !== "number") node.params.patternLen = 16;
    _prEd.activeTrack = 0;
  }
  prEnsureIds(node.params.notes);
  _prEd.selected.clear();
  _prEd.drag = null;
  _prEd.hoverCell = null;

  // Toolbar — toggle the multi-track class so the track-tabs group
  // reveals (CSS gates `.pr-track-group` visibility on this).
  const toolbar = document.getElementById("pr-toolbar");
  if (toolbar) toolbar.classList.toggle("multi-track", !!_prEd.multi);

  const titleEl = document.getElementById("pianoroll-modal-title");
  if (titleEl) titleEl.textContent = "[" + node.id + "]" + (_prEd.multi ? " · 4-TRACK" : "");
  const lenInput = document.getElementById("pianoroll-len");
  const velInput = document.getElementById("pianoroll-vel");
  if (lenInput) lenInput.value = prGetLen();
  if (velInput) {
    const dv = _prEd.multi
      ? (Number(node.params.defaultVels[_prEd.activeTrack]) || 1.0)
      : _prEd.defaultVel;
    _prEd.defaultVel = dv;
    velInput.value = dv.toFixed(2);
  }

  document.getElementById("pianoroll-modal").style.display = "flex";
  // Render once visible so layout calculations have real dimensions.
  requestAnimationFrame(() => {
    renderPianoRoll();
    // Center the keyboard view on C4 (MIDI 60) the first time this
    // modal opens — easier to find your bearings than starting at the
    // top of the range.
    const wrap = document.getElementById("pr-grid-wrap");
    if (wrap) {
      const targetRow = PR_PITCH_HI - 1 - 60;
      const cellH = prCellH();
      const wantTop = targetRow * cellH - wrap.clientHeight / 2 + cellH / 2;
      wrap.scrollTop = Math.max(0, wantTop);
      prSyncScroll();
    }
  });
}

function closePianoRollModal() {
  const m = document.getElementById("pianoroll-modal");
  if (m) m.style.display = "none";
  _prEd.nodeId = null;
  _pianoRollNodeId = null;
  _prEd.multi = false;
  _prEd.activeTrack = 0;
  _prEd.selected.clear();
  _prEd.drag = null;
  // Reset toolbar's multi-track flag so next single-track open is clean.
  const toolbar = document.getElementById("pr-toolbar");
  if (toolbar) toolbar.classList.remove("multi-track");
}

(function setupPianoRollModal() {
  const close   = document.getElementById("btn-pianoroll-close");
  const done    = document.getElementById("btn-pianoroll-done");
  const clr     = document.getElementById("btn-pianoroll-clear");
  const dup     = document.getElementById("btn-pianoroll-duplicate");
  const modal   = document.getElementById("pianoroll-modal");
  const lenIn   = document.getElementById("pianoroll-len");
  const velIn   = document.getElementById("pianoroll-vel");
  const snapEl  = document.getElementById("pr-snap");

  if (close) close.addEventListener("click", closePianoRollModal);
  if (done)  done.addEventListener("click", closePianoRollModal);
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closePianoRollModal(); });

  if (clr) clr.addEventListener("click", () => {
    const node = prGetNode();
    if (!node) return;
    pushHistory("pr:clear:" + node.id);
    node.params.notes = [];
    _prEd.selected.clear();
    renderPianoRoll();
    renderCode(); renderJson(); renderProps();
  });

  if (dup) dup.addEventListener("click", prDuplicateSelection);

  if (lenIn) lenIn.addEventListener("input", () => {
    // prSetLen handles single + multi-track + per-track trim.
    prSetLen(lenIn.value);
    renderPianoRoll();
    renderCode(); renderJson(); renderProps();
  });

  if (velIn) velIn.addEventListener("input", () => {
    const v = parseFloat(velIn.value);
    if (!isFinite(v)) return;
    const clamped = Math.max(0, Math.min(1, v));
    _prEd.defaultVel = clamped;
    _pianoRollVel = clamped;
    if (_prEd.multi) {
      const node = prGetNode();
      if (node && Array.isArray(node.params.defaultVels)) {
        node.params.defaultVels[_prEd.activeTrack] = clamped;
      }
    }
  });

  if (snapEl) snapEl.addEventListener("change", () => {
    _prEd.snapIx = Math.max(0, Math.min(PR_SNAP_VALUES.length - 1, parseInt(snapEl.value, 10) || 0));
    prRenderStatus(prGetNode() || { params: { notes: [] } });
  });

  // Tool buttons
  document.querySelectorAll(".pr-tool").forEach(b => {
    b.addEventListener("click", () => {
      _prEd.tool = b.dataset.tool || "draw";
      prSyncToolbar();
    });
  });

  // Track tabs (multi-track only — group is hidden via CSS otherwise)
  document.querySelectorAll(".pr-track").forEach(b => {
    b.addEventListener("click", () => {
      const t = parseInt(b.dataset.track, 10);
      if (!isFinite(t)) return;
      prSetActiveTrack(t);
    });
  });

  // Zoom buttons
  document.querySelectorAll(".pr-zoom-btn[data-zoom]").forEach(b => {
    b.addEventListener("click", () => {
      const k = b.dataset.zoom;
      if (k === "hin")  _prEd.zoomX = Math.min(PR_ZOOM_X.length - 1, _prEd.zoomX + 1);
      if (k === "hout") _prEd.zoomX = Math.max(0, _prEd.zoomX - 1);
      if (k === "vin")  _prEd.zoomY = Math.min(PR_ZOOM_Y.length - 1, _prEd.zoomY + 1);
      if (k === "vout") _prEd.zoomY = Math.max(0, _prEd.zoomY - 1);
      renderPianoRoll();
    });
  });

  // Octave-jump buttons (vertical scroll by one octave's worth of rows)
  document.querySelectorAll(".pr-zoom-btn[data-oct]").forEach(b => {
    b.addEventListener("click", () => {
      const dir = parseInt(b.dataset.oct, 10) || 0;
      const wrap = document.getElementById("pr-grid-wrap");
      if (!wrap) return;
      // dir = +1 means scroll UP an octave (toward higher pitches at top).
      wrap.scrollTop -= dir * 12 * prCellH();
      prSyncScroll();
    });
  });

  // Scroll mirroring
  const wrap = document.getElementById("pr-grid-wrap");
  if (wrap) wrap.addEventListener("scroll", prSyncScroll, { passive: true });

  // Wheel: ctrl/cmd = zoom; shift = horizontal pan; default = vertical scroll
  if (wrap) {
    wrap.addEventListener("wheel", e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Cmd+wheel zooms horizontally (most musical context wants
        // narrower / wider, not taller / shorter rows). Hold shift to
        // zoom vertically instead.
        const upd = (e.shiftKey ? "zoomY" : "zoomX");
        const arr = (e.shiftKey ? PR_ZOOM_Y : PR_ZOOM_X);
        if (e.deltaY < 0) _prEd[upd] = Math.min(arr.length - 1, _prEd[upd] + 1);
        else              _prEd[upd] = Math.max(0, _prEd[upd] - 1);
        renderPianoRoll();
      }
    }, { passive: false });
  }

  // Keyboard shortcuts — only when the modal is open. Handled keys
  // call stopImmediatePropagation so global shortcuts (tab-switch,
  // save, select-all, etc.) don't also fire while the modal owns the
  // keyboard.
  document.addEventListener("keydown", e => {
    if (_prEd.nodeId == null) return;
    if (isTextInput(e.target)) return;
    const k = e.key;
    const handled = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (k === "Escape")      { handled(); closePianoRollModal(); return; }
    if (k === "b" || k === "B") { handled(); _prEd.tool = "draw";   prSyncToolbar(); return; }
    if (k === "v" || k === "V") { handled(); _prEd.tool = "select"; prSyncToolbar(); return; }
    if (k === "e" || k === "E") { handled(); _prEd.tool = "erase";  prSyncToolbar(); return; }
    if (k === "Delete" || k === "Backspace") { handled(); prDeleteSelection(); return; }
    if (k === "ArrowUp")   { handled(); prTransposeSelection(e.shiftKey ? 12 : 1);   return; }
    if (k === "ArrowDown") { handled(); prTransposeSelection(e.shiftKey ? -12 : -1); return; }
    if ((e.metaKey || e.ctrlKey) && (k === "a" || k === "A")) {
      handled();
      if (e.shiftKey) prSelectAllTracks(); else prSelectAll();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (k === "d" || k === "D")) { handled(); prDuplicateSelection(); return; }
    // Multi-track: 1/2/3/4 jump to that track. Without stopImmediate
    // the global tab-switcher would also fire and yank the right pane.
    if (_prEd.multi && (k === "1" || k === "2" || k === "3" || k === "4")) {
      handled(); prSetActiveTrack(parseInt(k, 10) - 1); return;
    }
  }, true);  // capture phase — fire before global document handlers

  prInstallGridHandlers();
  prInstallVelHandlers();
  prInstallKeysHandlers();
})();

/* ====================================================================
 * WAVETABLE EDITOR — single-cycle drawable waveform.
 *
 * One modal serves two callers:
 *   - WavetableOsc (mode="single") → edits node.params.table
 *   - WavetableScan (mode="frame") → edits node.params.customFrames[idx]
 *
 * The drawing surface is a single SVG with -1/0/+1 graticule lines
 * and a phosphor-glow trace for the current waveform. Click + drag
 * paints sample values; shift-drag draws a straight line from anchor.
 * Save-on-modify: every drag commit writes back to params + triggers
 * renderCode/renderJson, so the codegen + monitor reflect changes
 * without a separate Save button (DONE just closes the modal).
 *
 * When returnTo is set, closing returns control to the wavescan modal
 * (which is hidden but not destroyed) and re-renders its stacked view.
 * ================================================================= */

const WT_TABLE_LEN = 256;

const _wtEd = {
  nodeId:   null,
  mode:     "single",          // "single" | "frame"
  frameIdx: 0,
  table:    null,              // live ref into node.params (NOT a copy)
  initial:  null,              // snapshot for REVERT
  drag:     null,              // { last: { i, v }, anchor: { i, v } } during pointerdown..up
  returnTo: null,              // "wavescan" if drilled in from there
};

function wtDefaultTable() {
  // Sine cycle as the default. Gives "something to work with" rather
  // than a flat zero line on first open.
  const t = new Array(WT_TABLE_LEN);
  for (let i = 0; i < WT_TABLE_LEN; i++) {
    t[i] = Math.sin(2 * Math.PI * i / WT_TABLE_LEN);
  }
  return t;
}
function wtPresetTable(name) {
  const t = new Array(WT_TABLE_LEN);
  for (let i = 0; i < WT_TABLE_LEN; i++) {
    const p = i / WT_TABLE_LEN;
    switch (name) {
      case "sine":     t[i] = Math.sin(2 * Math.PI * p); break;
      case "saw":      t[i] = 2 * p - 1; break;
      case "square":   t[i] = p < 0.5 ? 1 : -1; break;
      case "triangle": t[i] = p < 0.5 ? (4 * p - 1) : (3 - 4 * p); break;
      case "halfSine": t[i] = p < 0.5 ? Math.sin(2 * Math.PI * p) : 0; break;
      case "hollow":   t[i] = Math.sin(2 * Math.PI * p) - 0.5 * Math.sin(4 * Math.PI * p); break;
      case "random":   t[i] = Math.random() * 2 - 1; break;
      default:         t[i] = 0;
    }
  }
  return t;
}

function wtCommitToNode() {
  const node = state.nodes.find(n => n.id === _wtEd.nodeId);
  if (!node || !_wtEd.table) return;
  if (_wtEd.mode === "single") {
    node.params.table = _wtEd.table.slice();
  } else if (_wtEd.mode === "frame") {
    if (!node.params.customFrames || typeof node.params.customFrames !== "object") {
      node.params.customFrames = {};
    }
    node.params.customFrames[_wtEd.frameIdx] = _wtEd.table.slice();
  }
  renderCode(); renderJson(); renderProps();
}

function openWavetableEditModal(opts) {
  const node = state.nodes.find(n => n.id === opts.nodeId);
  if (!node) return;
  _wtEd.nodeId   = opts.nodeId;
  _wtEd.mode     = opts.mode || "single";
  _wtEd.frameIdx = opts.frameIdx || 0;
  _wtEd.returnTo = opts.returnTo || null;
  _wtEd.drag     = null;

  // Resolve / seed the table that we'll edit. For single mode, prefer
  // an existing params.table. For frame mode, use the existing custom
  // frame override if there is one; otherwise seed from the algorithmic
  // bank (we duplicate the WavetableScan helper's bank algorithms in
  // JS so the user starts from "what the audio is currently playing").
  let initialTable;
  if (_wtEd.mode === "single") {
    initialTable = (Array.isArray(node.params.table) && node.params.table.length > 0)
      ? node.params.table.slice()
      : wtDefaultTable();
  } else {
    const cf = (node.params && node.params.customFrames) || {};
    if (Array.isArray(cf[_wtEd.frameIdx]) && cf[_wtEd.frameIdx].length > 0) {
      initialTable = cf[_wtEd.frameIdx].slice();
    } else {
      initialTable = wsBankFrameJS(node.params.bank || "sineToSaw", _wtEd.frameIdx);
    }
  }
  // Pad / truncate to WT_TABLE_LEN
  if (initialTable.length < WT_TABLE_LEN) {
    const padded = new Array(WT_TABLE_LEN);
    for (let i = 0; i < WT_TABLE_LEN; i++) {
      const t = i / WT_TABLE_LEN * (initialTable.length - 1);
      const i0 = Math.floor(t);
      const i1 = Math.min(initialTable.length - 1, i0 + 1);
      const f = t - i0;
      padded[i] = initialTable[i0] * (1 - f) + initialTable[i1] * f;
    }
    initialTable = padded;
  } else if (initialTable.length > WT_TABLE_LEN) {
    initialTable = initialTable.slice(0, WT_TABLE_LEN);
  }
  _wtEd.table = initialTable;
  _wtEd.initial = initialTable.slice();

  const titleEl = document.getElementById("wavetable-modal-title");
  if (titleEl) {
    titleEl.textContent = _wtEd.mode === "frame"
      ? `[${node.id}]  FRAME ${_wtEd.frameIdx} / 511`
      : `[${node.id}]`;
  }

  document.getElementById("wavetable-modal").style.display = "flex";
  requestAnimationFrame(() => renderWavetableCanvas());
}

function closeWavetableEditModal(commit) {
  if (commit !== false) wtCommitToNode();
  document.getElementById("wavetable-modal").style.display = "none";
  const returnTo = _wtEd.returnTo;
  _wtEd.nodeId = null;
  _wtEd.table  = null;
  _wtEd.initial = null;
  _wtEd.returnTo = null;
  _wtEd.drag = null;
  if (returnTo === "wavescan" && _wsEd.nodeId) {
    document.getElementById("wavescan-modal").style.display = "flex";
    requestAnimationFrame(() => renderWavescanCanvas());
  }
}

function renderWavetableCanvas() {
  const svg = document.getElementById("wt-canvas");
  if (!svg || !_wtEd.table) return;
  const W = svg.clientWidth || 1000;
  const H = svg.clientHeight || 480;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const PAD_X = 32;
  const PAD_Y = 24;
  const PLOT_W = W - PAD_X * 2;
  const PLOT_H = H - PAD_Y * 2;

  let html = "";
  // Vertical sample-grid lines every 16 samples; brighter every 64.
  for (let s = 0; s <= WT_TABLE_LEN; s += 16) {
    const x = PAD_X + (s / WT_TABLE_LEN) * PLOT_W;
    const cls = (s % 64 === 0) ? "wt-bound-line" : "wt-grid-line";
    html += `<line class="${cls}" x1="${x}" y1="${PAD_Y}" x2="${x}" y2="${H - PAD_Y}" />`;
  }
  // Horizontal amplitude grid: -1, -0.5, 0, +0.5, +1
  [-1, -0.5, 0, 0.5, 1].forEach(v => {
    const y = PAD_Y + PLOT_H * 0.5 * (1 - v);
    const cls = v === 0 ? "wt-zero-line" : (Math.abs(v) === 1 ? "wt-bound-line" : "wt-axis-line");
    html += `<line class="${cls}" x1="${PAD_X}" y1="${y}" x2="${W - PAD_X}" y2="${y}" />`;
    const lbl = v === 0 ? "0" : (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
    const cl2 = (Math.abs(v) === 1 || v === 0) ? "wt-axis-label wt-axis-label-bright" : "wt-axis-label";
    html += `<text class="${cl2}" x="6" y="${y + 3}">${lbl}</text>`;
  });
  // Sample-axis ticks at left edge (start / end)
  html += `<text class="wt-axis-label" x="${PAD_X}" y="${H - 6}">0</text>`;
  html += `<text class="wt-axis-label" x="${W - PAD_X - 24}" y="${H - 6}">${WT_TABLE_LEN}</text>`;

  // Filled area under the curve for visual mass + the trace itself.
  // Both use the table[i] values mapped: x = PAD_X + (i / N) * PLOT_W,
  // y = PAD_Y + 0.5 * PLOT_H * (1 - clamp(v, -1, 1)).
  let pts = "";
  for (let i = 0; i < WT_TABLE_LEN; i++) {
    const v = Math.max(-1, Math.min(1, _wtEd.table[i]));
    const x = PAD_X + (i / WT_TABLE_LEN) * PLOT_W;
    const y = PAD_Y + 0.5 * PLOT_H * (1 - v);
    pts += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " ";
  }
  // Fill polygon: trace + bottom corners
  const fillPts = pts + `L ${W - PAD_X} ${PAD_Y + 0.5 * PLOT_H} L ${PAD_X} ${PAD_Y + 0.5 * PLOT_H} Z`;
  html += `<path class="wt-trace-fill" d="${fillPts}" />`;
  html += `<path class="wt-trace" d="${pts}" />`;

  svg.innerHTML = html;

  // Update RMS / peak readouts
  let rms = 0, peak = 0;
  for (let i = 0; i < WT_TABLE_LEN; i++) {
    const v = _wtEd.table[i];
    rms += v * v;
    const av = Math.abs(v);
    if (av > peak) peak = av;
  }
  rms = Math.sqrt(rms / WT_TABLE_LEN);
  const rmsEl  = document.getElementById("wt-stat-rms");
  const peakEl = document.getElementById("wt-stat-peak");
  if (rmsEl)  rmsEl.textContent  = rms.toFixed(3);
  if (peakEl) peakEl.textContent = peak.toFixed(3);
}

function wtSampleAt(ev) {
  const svg = document.getElementById("wt-canvas");
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  const W = r.width, H = r.height;
  const PAD_X = 32, PAD_Y = 24;
  const PLOT_W = W - PAD_X * 2;
  const PLOT_H = H - PAD_Y * 2;
  const cx = ev.clientX - r.left;
  const cy = ev.clientY - r.top;
  const i = Math.max(0, Math.min(WT_TABLE_LEN - 1, Math.round((cx - PAD_X) / PLOT_W * WT_TABLE_LEN)));
  const v = Math.max(-1, Math.min(1, 1 - 2 * (cy - PAD_Y) / PLOT_H));
  return { i, v };
}

function wtPaintLine(from, to) {
  // Linear interpolation between two sample positions — fills any
  // gaps that fast cursor motion would skip over. `from` and `to` are
  // both { i, v }.
  const lo = Math.min(from.i, to.i);
  const hi = Math.max(from.i, to.i);
  if (lo === hi) {
    _wtEd.table[lo] = to.v;
    return;
  }
  const v0 = (from.i <= to.i) ? from.v : to.v;
  const v1 = (from.i <= to.i) ? to.v   : from.v;
  for (let i = lo; i <= hi; i++) {
    const t = (i - lo) / (hi - lo);
    _wtEd.table[i] = v0 * (1 - t) + v1 * t;
  }
}

function wtApplyOp(op) {
  if (!_wtEd.table) return;
  const N = WT_TABLE_LEN;
  const t = _wtEd.table;
  switch (op) {
    case "smooth": {
      const out = new Array(N);
      for (let i = 0; i < N; i++) {
        const a = t[(i - 1 + N) % N], b = t[i], c = t[(i + 1) % N];
        out[i] = (a + 2 * b + c) / 4;
      }
      _wtEd.table = out;
      break;
    }
    case "normalize": {
      let pk = 0;
      for (let i = 0; i < N; i++) { const a = Math.abs(t[i]); if (a > pk) pk = a; }
      if (pk > 0.0001) {
        const k = 1 / pk;
        for (let i = 0; i < N; i++) t[i] = t[i] * k;
      }
      break;
    }
    case "invert":  for (let i = 0; i < N; i++) t[i] = -t[i]; break;
    case "reverse": _wtEd.table = t.slice().reverse(); break;
    case "symmetrize": {
      // Mirror left half over the right half so the wave has even symmetry
      // around N/2. Useful for forcing a "pure" odd or even harmonic content.
      const half = N / 2;
      for (let i = 0; i < half; i++) {
        t[N - 1 - i] = t[i];
      }
      break;
    }
    case "zero": for (let i = 0; i < N; i++) t[i] = 0; break;
  }
  renderWavetableCanvas();
  wtCommitToNode();
}

function setupWavetableModal() {
  const modal = document.getElementById("wavetable-modal");
  const svg   = document.getElementById("wt-canvas");
  const close = document.getElementById("btn-wavetable-close");
  const done  = document.getElementById("btn-wavetable-done");
  const revert = document.getElementById("btn-wavetable-revert");
  if (!modal || !svg) return;

  if (close) close.addEventListener("click", () => closeWavetableEditModal(true));
  if (done)  done.addEventListener("click",  () => closeWavetableEditModal(true));
  if (revert) revert.addEventListener("click", () => {
    if (!_wtEd.initial) return;
    _wtEd.table = _wtEd.initial.slice();
    renderWavetableCanvas();
    wtCommitToNode();
  });
  modal.addEventListener("click", e => {
    if (e.target === modal) closeWavetableEditModal(true);
  });

  // Preset buttons — replace table with the named preset.
  document.querySelectorAll(".wt-preset-btn").forEach(b => {
    b.addEventListener("click", () => {
      _wtEd.table = wtPresetTable(b.dataset.preset);
      renderWavetableCanvas();
      wtCommitToNode();
    });
  });
  // Shape ops
  document.querySelectorAll(".wt-tool-btn[data-op]").forEach(b => {
    b.addEventListener("click", () => wtApplyOp(b.dataset.op));
  });

  // Drawing — pointer interaction on the canvas
  svg.addEventListener("pointerdown", ev => {
    if (ev.button !== 0 || !_wtEd.table) return;
    ev.preventDefault();
    const cell = wtSampleAt(ev);
    if (!cell) return;
    _wtEd.drag = {
      last: cell,
      anchor: cell,
      shift: ev.shiftKey
    };
    try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    if (ev.shiftKey) {
      // Shift-click anchors; release commits a line.
      renderWavetableCanvas();
    } else {
      _wtEd.table[cell.i] = cell.v;
      renderWavetableCanvas();
    }
  });
  svg.addEventListener("pointermove", ev => {
    const cell = wtSampleAt(ev);
    if (cell) {
      const r = document.getElementById("wavetable-readout");
      if (r) r.textContent = `SAMPLE ${String(cell.i).padStart(3)}    AMP ${cell.v.toFixed(3)}`;
    }
    if (!_wtEd.drag) return;
    if (!cell) return;
    if (_wtEd.drag.shift) {
      // Shift-drag: from anchor to current, drawing a single straight
      // line. Re-renders from a fresh _wtEd.initial copy each move so
      // we don't accumulate.
      _wtEd.table = _wtEd.initial.slice();
      wtPaintLine(_wtEd.drag.anchor, cell);
    } else {
      wtPaintLine(_wtEd.drag.last, cell);
    }
    _wtEd.drag.last = cell;
    renderWavetableCanvas();
  });
  function endWtDrag() {
    if (_wtEd.drag) {
      _wtEd.drag = null;
      wtCommitToNode();
    }
  }
  svg.addEventListener("pointerup",     endWtDrag);
  svg.addEventListener("pointercancel", endWtDrag);

  // Esc to close (only when this modal is open and we're not in the
  // wavescan modal's editor flow). Capture phase + stopImmediate so
  // global Escape handlers don't double-fire.
  document.addEventListener("keydown", e => {
    if (modal.style.display === "none") return;
    if (isTextInput(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      closeWavetableEditModal(true);
    }
  }, true);
}
setupWavetableModal();

/* ====================================================================
 * WAVESCAN MODAL — 3D-stacked view of all 512 wavetable frames.
 *
 * Renders every Nth frame as a polyline (drawing all 512 would be
 * 131K SVG points and slow to render on every scrub tick). Layout:
 * frames stack along Z with progressively smaller scale + Y offset
 * to fake perspective; the "active position" frame is rendered in
 * bright phosphor over the rest. Click any frame to drill into the
 * single-cycle wavetable editor pre-loaded with that frame's data.
 *
 * The position slider is the source of truth for both modal-local
 * scrubbing AND the live audio param (node.params.position is
 * autoExposed → the runtime AudioWorklet picks it up via setter
 * dispatch, same as Slider).
 *
 * Uses the same bank algorithms as the C++ helper so the JS preview
 * matches what compile + Play actually produces.
 * ================================================================= */

const WS_FRAMES   = 512;
const WS_SAMPLES  = 256;
const WS_VISIBLE  = 64;        // every WS_FRAMES/WS_VISIBLE-th frame drawn

const _wsEd = {
  nodeId: null,
  view:   "3d",
  scrubbing: false,
};

const WS_BANK_NAMES = ["sineToSaw", "harmonicWalk", "formantScan", "sineFold", "sineToTri", "morphPair"];
const WS_BANK_LABELS = ["SINE → SAW", "HARMONIC WALK", "FORMANT SCAN", "SINE FOLD", "SINE → TRIANGLE", "MORPH PAIR"];

/* JS port of the C++ WavetableScan bank algorithms. Returns one
 * 256-sample frame at the given fractional position (0..1). Kept
 * identical to GammaWavetableScan::setBank so the modal preview
 * matches the audio output. */
function wsBankFrameJS(bank, frameIdx) {
  const t = frameIdx / (WS_FRAMES - 1);
  const out = new Array(WS_SAMPLES);
  const TWO_PI = 2 * Math.PI;
  for (let i = 0; i < WS_SAMPLES; i++) {
    const p = i / WS_SAMPLES;
    let v = 0;
    switch (bank) {
      case "sineToSaw": case 0: {
        const s = Math.sin(TWO_PI * p);
        const saw = 2 * p - 1;
        v = s * (1 - t) + saw * t;
        break;
      }
      case "harmonicWalk": case 1: {
        const maxH = 1 + Math.floor(t * 16);
        for (let h = 1; h <= maxH; h++) v += Math.sin(TWO_PI * p * h) / h;
        v *= 0.6;
        break;
      }
      case "formantScan": case 2: {
        const shift = t * 0.5;
        let p2 = p + shift; if (p2 >= 1) p2 -= 1;
        v = Math.sin(TWO_PI * p2) * (1 - 0.5 * Math.cos(TWO_PI * p));
        break;
      }
      case "sineFold": case 3: {
        const s = Math.sin(TWO_PI * p);
        const clipped = s * (1 + t * 4);
        v = clipped > 1 ? 1 : (clipped < -1 ? -1 : clipped);
        break;
      }
      case "sineToTri": case 4: {
        const s = Math.sin(TWO_PI * p);
        const tri = (p < 0.5) ? (4 * p - 1) : (3 - 4 * p);
        v = s * (1 - t) + tri * t;
        break;
      }
      case "morphPair": case 5: {
        const a = Math.sin(TWO_PI * p);
        const ph = TWO_PI * t;
        const bb = Math.sin(TWO_PI * 3 * p + ph) * 0.5;
        v = a * (1 - t * 0.7) + bb * t * 0.7;
        break;
      }
    }
    out[i] = v;
  }
  return out;
}

function wsResolvedFrame(node, idx) {
  // Custom override beats the algorithmic frame.
  const cf = (node.params && node.params.customFrames) || {};
  if (Array.isArray(cf[idx]) && cf[idx].length > 0) return cf[idx];
  return wsBankFrameJS(node.params.bank || "sineToSaw", idx);
}

function openWavescanModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  _wsEd.nodeId = nodeId;
  _wsEd.view = "3d";
  // Initialize defaults if missing
  if (typeof node.params.position !== "number") node.params.position = 0;
  if (typeof node.params.bank !== "string")     node.params.bank = "sineToSaw";
  if (!node.params.customFrames || typeof node.params.customFrames !== "object") {
    node.params.customFrames = {};
  }

  const titleEl = document.getElementById("wavescan-modal-title");
  if (titleEl) titleEl.textContent = `[${node.id}]`;
  const bankEl = document.getElementById("ws-bank");
  if (bankEl) {
    const ix = WS_BANK_NAMES.indexOf(node.params.bank);
    bankEl.value = String(ix >= 0 ? ix : 0);
  }
  const posEl = document.getElementById("ws-position");
  if (posEl) posEl.value = String(node.params.position);
  document.querySelectorAll(".wt-tool-btn[data-view]").forEach(b => {
    b.classList.toggle("active", b.dataset.view === _wsEd.view);
  });

  document.getElementById("wavescan-modal").style.display = "flex";
  requestAnimationFrame(() => renderWavescanCanvas());
}

function closeWavescanModal() {
  document.getElementById("wavescan-modal").style.display = "none";
  _wsEd.nodeId = null;
  _wsEd.scrubbing = false;
}

function renderWavescanCanvas() {
  const node = state.nodes.find(n => n.id === _wsEd.nodeId);
  const svg = document.getElementById("ws-canvas");
  if (!node || !svg) return;
  const stage = document.getElementById("ws-stage");
  const W = (stage ? stage.clientWidth : 1200) || 1200;
  const H = (stage ? stage.clientHeight : 600) || 600;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  // Sync readouts
  const pos = Math.max(0, Math.min(1, Number(node.params.position) || 0));
  const activeFrame = Math.round(pos * (WS_FRAMES - 1));
  const r = document.getElementById("wavescan-readout");
  if (r) r.textContent = `FRAME ${String(activeFrame).padStart(3)}/${WS_FRAMES}    POS ${pos.toFixed(3)}`;
  const posR = document.getElementById("ws-pos-readout");
  if (posR) posR.textContent = pos.toFixed(3);
  const ovrEl = document.getElementById("ws-stat-overrides");
  if (ovrEl) ovrEl.textContent = String(Object.keys(node.params.customFrames || {}).length);
  const bankEl = document.getElementById("ws-stat-bank");
  if (bankEl) {
    const ix = WS_BANK_NAMES.indexOf(node.params.bank);
    bankEl.textContent = WS_BANK_LABELS[ix >= 0 ? ix : 0];
  }

  if (_wsEd.view === "grid") {
    renderWavescanGrid(node, svg, W, H);
  } else {
    renderWavescan3D(node, svg, W, H, pos);
  }
}

function renderWavescan3D(node, svg, W, H, pos) {
  // Project N visible frames into a perspective stack. Each frame i
  // (0..N-1) gets:
  //   - normalized depth z = i / (N-1)
  //   - x-offset: skew_x * (1 - z)
  //   - y-offset: top_pad + (1 - z) * span
  //   - scale  : 0.55 + 0.45 * (1 - z)
  // The visible-frame slice samples every WS_FRAMES / WS_VISIBLE-th
  // frame (so 8 of every 8 are drawn at WS_VISIBLE=64). Custom-edited
  // frames are colored with .custom; the active position highlights
  // its enclosing visible frame in bright phosphor.
  const cf = node.params.customFrames || {};
  const customSet = new Set(Object.keys(cf).map(k => parseInt(k, 10)).filter(k => isFinite(k)));
  const PAD_TOP = 40, PAD_BOT = 30;
  const SKEW = 60;                       // horizontal skew in px from front to back
  const PLOT_W = W * 0.78;
  const PLOT_X = (W - PLOT_W) * 0.5;
  const TOTAL_H = H - PAD_TOP - PAD_BOT;
  const FRAME_AMP = TOTAL_H * 0.45;      // per-frame waveform amplitude
  const SPAN = TOTAL_H - FRAME_AMP * 0.5; // vertical extent of the stack

  // Background grid — vertical guidelines at quarters of position
  let html = "";
  for (let q = 0; q <= 4; q++) {
    const xq = PLOT_X + (q / 4) * PLOT_W;
    html += `<line class="ws-grid" x1="${xq}" y1="${PAD_TOP - 10}" x2="${xq}" y2="${H - PAD_BOT + 10}" />`;
  }

  // Render frames back-to-front so closer frames overlap further ones.
  // i = WS_FRAMES - 1 is "back" (smallest, dimmest); i = 0 is "front".
  const step = Math.max(1, Math.floor(WS_FRAMES / WS_VISIBLE));
  // Always include the active frame in the visible list so the
  // highlight has something to draw onto.
  const visible = [];
  for (let i = 0; i < WS_FRAMES; i += step) visible.push(i);
  const activeFrame = Math.round(pos * (WS_FRAMES - 1));
  const nearestVisible = visible.reduce((best, v) => Math.abs(v - activeFrame) < Math.abs(best - activeFrame) ? v : best, visible[0]);
  if (!visible.includes(activeFrame)) visible.push(activeFrame);
  // Draw back-to-front
  visible.sort((a, b) => b - a);

  const projectFrame = (i) => {
    const z = i / (WS_FRAMES - 1);
    const yBase = PAD_TOP + FRAME_AMP * 0.5 + (1 - z) * SPAN * 0.85;
    const xOff  = SKEW * z;
    const scale = 0.6 + 0.4 * (1 - z);
    return { yBase, xOff, scale };
  };

  visible.forEach(i => {
    const { yBase, xOff, scale } = projectFrame(i);
    const isActive = i === activeFrame;
    const isCustom = customSet.has(i);
    const frameData = wsResolvedFrame(node, i);
    let pts = "";
    for (let s = 0; s < WS_SAMPLES; s++) {
      const v = Math.max(-1, Math.min(1, frameData[s]));
      const xs = PLOT_X + xOff + (s / WS_SAMPLES) * PLOT_W * scale;
      const ys = yBase - v * FRAME_AMP * 0.5 * scale;
      pts += (s === 0 ? "M" : "L") + xs.toFixed(2) + " " + ys.toFixed(2) + " ";
    }
    const cls = "ws-frame" + (isCustom ? " custom" : "") + (isActive ? " active" : "");
    html += `<path class="${cls}" data-frame="${i}" d="${pts}" />`;
  });

  // Position cursor — vertical bar through the stack at the projected
  // x of the active frame's start. Also draw the frame-number label.
  {
    const proj = projectFrame(activeFrame);
    const cx = PLOT_X + proj.xOff;
    html += `<line class="ws-pos-cursor" x1="${cx}" y1="${PAD_TOP - 6}" x2="${cx}" y2="${H - PAD_BOT}" />`;
    html += `<text class="ws-frame-label" x="${cx + 6}" y="${PAD_TOP + 4}">FRAME ${activeFrame}</text>`;
  }
  // Front/back depth labels
  html += `<text class="ws-frame-label" x="${PLOT_X}" y="${H - PAD_BOT + 18}">FRONT · 0</text>`;
  html += `<text class="ws-frame-label" x="${PLOT_X + PLOT_W * 0.7 + SKEW}" y="${PAD_TOP - 12}">BACK · ${WS_FRAMES - 1}</text>`;

  svg.innerHTML = html;
  wsAttachFrameClicks(svg);
}

function renderWavescanGrid(node, svg, W, H) {
  // Contact-sheet view — sample of N frames as a grid of mini
  // oscilloscope tiles. Each tile is clickable; the active tile is
  // outlined in phosphor. Useful for spotting outliers or finding a
  // specific custom frame in the bank.
  const cf = node.params.customFrames || {};
  const customSet = new Set(Object.keys(cf).map(k => parseInt(k, 10)).filter(k => isFinite(k)));
  const pos = Math.max(0, Math.min(1, Number(node.params.position) || 0));
  const activeFrame = Math.round(pos * (WS_FRAMES - 1));
  const COLS = 32;
  const ROWS = 16;          // 32 × 16 = 512 ✓
  const PAD = 12;
  const cellW = (W - PAD * 2) / COLS;
  const cellH = (H - PAD * 2) / ROWS;
  let html = "";
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      if (idx >= WS_FRAMES) continue;
      const x = PAD + c * cellW;
      const y = PAD + r * cellH;
      const isCustom = customSet.has(idx);
      const isActive = idx === activeFrame;
      const cls = "ws-grid-cell-bg" + (isCustom ? " custom" : "") + (isActive ? " active" : "");
      html += `<g class="ws-grid-cell" data-frame="${idx}">`;
      html += `<rect class="${cls}" x="${x}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" rx="1" />`;
      // Mini waveform — 32 sample points (downsampled)
      const frameData = wsResolvedFrame(node, idx);
      const innerPad = 2;
      const ix = x + innerPad;
      const iy = y + innerPad;
      const iw = cellW - innerPad * 2 - 1;
      const ih = cellH - innerPad * 2 - 1;
      const N = 32;
      let pts = "";
      for (let s = 0; s < N; s++) {
        const sIdx = Math.floor(s / N * WS_SAMPLES);
        const v = Math.max(-1, Math.min(1, frameData[sIdx]));
        const xs = ix + (s / N) * iw;
        const ys = iy + ih * 0.5 - v * ih * 0.45;
        pts += (s === 0 ? "M" : "L") + xs.toFixed(1) + " " + ys.toFixed(1) + " ";
      }
      const traceColor = isActive ? "var(--phosphor)" : (isCustom ? "var(--info)" : "rgba(200,232,90,0.4)");
      html += `<path d="${pts}" fill="none" stroke="${traceColor}" stroke-width="1" stroke-linejoin="round" />`;
      html += `</g>`;
    }
  }
  svg.innerHTML = html;
  wsAttachFrameClicks(svg);
}

function wsAttachFrameClicks(svg) {
  // Both views render with `data-frame` on clickable elements. Clicking
  // a frame opens the per-frame wavetable editor; the modal closes
  // the wavescan modal temporarily and restores it on done.
  svg.querySelectorAll("[data-frame]").forEach(el => {
    el.addEventListener("click", ev => {
      ev.preventDefault();
      const idx = parseInt(el.getAttribute("data-frame"), 10);
      if (!isFinite(idx)) return;
      // Hide wavescan modal but DON'T destroy state — _wtEd.returnTo
      // tells closeWavetableEditModal to bring us back.
      document.getElementById("wavescan-modal").style.display = "none";
      openWavetableEditModal({
        nodeId: _wsEd.nodeId,
        mode: "frame",
        frameIdx: idx,
        returnTo: "wavescan"
      });
    });
  });
}

function setupWavescanModal() {
  const modal = document.getElementById("wavescan-modal");
  const close = document.getElementById("btn-wavescan-close");
  const done  = document.getElementById("btn-wavescan-done");
  const clear = document.getElementById("btn-wavescan-clear-overrides");
  const bank  = document.getElementById("ws-bank");
  const posEl = document.getElementById("ws-position");
  if (!modal) return;

  if (close) close.addEventListener("click", closeWavescanModal);
  if (done)  done.addEventListener("click",  closeWavescanModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeWavescanModal(); });

  if (bank) bank.addEventListener("change", () => {
    const node = state.nodes.find(n => n.id === _wsEd.nodeId);
    if (!node) return;
    pushHistory("ws:bank:" + node.id);
    const ix = parseInt(bank.value, 10) || 0;
    node.params.bank = WS_BANK_NAMES[ix];
    renderWavescanCanvas();
    renderCode(); renderJson(); renderProps();
  });

  if (posEl) {
    const onPos = () => {
      const node = state.nodes.find(n => n.id === _wsEd.nodeId);
      if (!node) return;
      const v = Math.max(0, Math.min(1, parseFloat(posEl.value) || 0));
      node.params.position = v;
      renderWavescanCanvas();
      // Don't push history on every microscopic scrub event — the
      // position is a continuous knob, not a discrete commit. Final
      // value persists via the natural state mutation.
      renderCode(); renderJson();
      renderMonitorControls();
    };
    posEl.addEventListener("input", onPos);
  }

  if (clear) clear.addEventListener("click", () => {
    const node = state.nodes.find(n => n.id === _wsEd.nodeId);
    if (!node) return;
    if (!Object.keys(node.params.customFrames || {}).length) return;
    pushHistory("ws:clear-overrides:" + node.id);
    node.params.customFrames = {};
    renderWavescanCanvas();
    renderCode(); renderJson(); renderProps();
  });

  // View toggle (3D / grid)
  document.querySelectorAll(".wt-tool-btn[data-view]").forEach(b => {
    b.addEventListener("click", () => {
      _wsEd.view = b.dataset.view || "3d";
      document.querySelectorAll(".wt-tool-btn[data-view]").forEach(x => {
        x.classList.toggle("active", x.dataset.view === _wsEd.view);
      });
      renderWavescanCanvas();
    });
  });

  // Keyboard scrub: ← → moves position by 1/512; shift = 1/64.
  document.addEventListener("keydown", e => {
    if (modal.style.display === "none") return;
    if (isTextInput(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      closeWavescanModal();
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault(); e.stopImmediatePropagation();
    const node = state.nodes.find(n => n.id === _wsEd.nodeId);
    if (!node) return;
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const step = e.shiftKey ? (1 / 64) : (1 / WS_FRAMES);
    node.params.position = Math.max(0, Math.min(1, (Number(node.params.position) || 0) + dir * step));
    if (posEl) posEl.value = String(node.params.position);
    renderWavescanCanvas();
    renderCode(); renderJson();
    renderMonitorControls();
  }, true);
}
setupWavescanModal();

/* ====================================================================
 * SAMPLE WAVEFORM EDITOR — modal for SamplePlayer / StereoSamplePlayer
 * / GranularPlayer. Displays the loaded asset's waveform (downsampled
 * min/max envelope, cached on the asset record so re-opens are
 * instant), with click-drag handles for the relevant parameters:
 *   - SamplePlayer / StereoSamplePlayer: start + end time markers
 *   - GranularPlayer: position cursor
 * Drop a file onto the canvas to replace the current asset; the
 * modal stays open with the new waveform.
 * ================================================================= */

const _smEd = {
  nodeId: null,
  drag: null,        // { kind: "start" | "end" | "position" }
};

/* Precomputed min/max envelope for a sample. Cached on the asset
 * record so opening the same sample twice doesn't re-scan the
 * (potentially multi-million-sample) buffer. SM_ENVELOPE_RES is the
 * fixed bucket count — 2048 is enough resolution for any reasonable
 * display width without making the cache itself huge. */
const SM_ENVELOPE_RES = 2048;
function smEnvelopeFor(asset, channel) {
  if (!asset) return null;
  const arr = (asset.channels >= 2 && Array.isArray(asset.data)) ? asset.data[channel | 0] : asset.data;
  if (!arr || !arr.length) return null;
  // Cache slot per channel: _envCache = [chan0, chan1]
  if (!asset._envCache) asset._envCache = [];
  if (asset._envCache[channel]) return asset._envCache[channel];
  const N = arr.length;
  const buckets = Math.min(SM_ENVELOPE_RES, N);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * N / buckets);
    const hi = Math.min(N, Math.floor((b + 1) * N / buckets));
    let mn = 1e9, mx = -1e9;
    for (let i = lo; i < hi; i++) {
      const v = arr[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn > mx) { mn = 0; mx = 0; }
    min[b] = mn;
    max[b] = mx;
  }
  const env = { min, max, N };
  asset._envCache[channel] = env;
  return env;
}

function smGetNode() {
  return state.nodes.find(n => n.id === _smEd.nodeId);
}
function smGetAsset() {
  const node = smGetNode();
  if (!node) return null;
  return getAsset(node.params && node.params.assetId);
}
function smIsGranular() {
  const node = smGetNode();
  return node && node.type === "GranularPlayer";
}
function smIsStereoNode() {
  const node = smGetNode();
  return node && node.type === "StereoSamplePlayer";
}

function openSampleModal(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  _smEd.nodeId = nodeId;
  _smEd.drag = null;
  const titleEl = document.getElementById("sample-modal-title");
  if (titleEl) titleEl.textContent = `[${node.id}]  ${node.type}`;
  const markerLbl = document.getElementById("sample-marker-label");
  if (markerLbl) markerLbl.textContent = smIsGranular() ? "POSITION" : "MARKERS";
  document.getElementById("sample-modal").style.display = "flex";
  requestAnimationFrame(() => renderSampleCanvas());
}

function closeSampleModal() {
  document.getElementById("sample-modal").style.display = "none";
  _smEd.nodeId = null;
  _smEd.drag = null;
}

function renderSampleCanvas() {
  const node = smGetNode();
  const svg = document.getElementById("sm-canvas");
  const stage = document.getElementById("sm-stage");
  if (!node || !svg || !stage) return;
  const W = stage.clientWidth || 1100;
  const H = stage.clientHeight || 460;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const asset = smGetAsset();
  // Update header readout + status cells
  const readoutEl = document.getElementById("sample-readout");
  const fileEl = document.getElementById("sm-stat-file");
  const durEl  = document.getElementById("sm-stat-dur");
  const srEl   = document.getElementById("sm-stat-sr");
  const lenEl  = document.getElementById("sm-stat-len");
  if (asset) {
    const samp = Array.isArray(asset.data) ? asset.data[0].length : asset.data.length;
    if (readoutEl) readoutEl.textContent = `${asset.name}  ·  ${asset.durationSec.toFixed(2)}s  ·  ${asset.sampleRate}Hz`;
    if (fileEl) fileEl.textContent = asset.name;
    if (durEl)  durEl.textContent  = asset.durationSec.toFixed(2) + " s";
    if (srEl)   srEl.textContent   = asset.sampleRate + " Hz";
    if (lenEl)  lenEl.textContent  = samp.toLocaleString() + (asset.channels >= 2 ? " × 2" : "");
  } else {
    if (readoutEl) readoutEl.textContent = "no file loaded";
    if (fileEl) fileEl.textContent = "—";
    if (durEl)  durEl.textContent  = "—";
    if (srEl)   srEl.textContent   = "—";
    if (lenEl)  lenEl.textContent  = "—";
  }

  let html = "";

  if (!asset) {
    // Empty-state hint + drop target. Visual cue that the user can
    // drag a file onto the canvas to load.
    html += `<text class="sm-no-asset" x="${W / 2}" y="${H / 2 - 10}">DRAG AN AUDIO FILE HERE</text>`;
    html += `<text class="sm-no-asset" x="${W / 2}" y="${H / 2 + 16}" style="font-size:10px; letter-spacing:0.10em;">OR CLICK REPLACE… ABOVE</text>`;
    svg.innerHTML = html;
    smUpdateMarkerReadout();
    return;
  }

  const isStereo = asset.channels >= 2;
  const lanes = isStereo ? 2 : 1;
  const laneH = H / lanes;
  const PAD_Y = 16;

  for (let lane = 0; lane < lanes; lane++) {
    const env = smEnvelopeFor(asset, isStereo ? lane : 0);
    if (!env) continue;
    const y0 = lane * laneH + PAD_Y;
    const yC = lane * laneH + laneH / 2;
    const y1 = (lane + 1) * laneH - PAD_Y;
    const ampH = (laneH - PAD_Y * 2) * 0.5;
    // Center reference line
    html += `<line class="sm-wave-center" x1="0" y1="${yC}" x2="${W}" y2="${yC}" />`;
    // Top of trace — max values
    let topPath = "M 0 " + yC.toFixed(1);
    let botPath = "M 0 " + yC.toFixed(1);
    for (let p = 0; p < W; p++) {
      const b = Math.floor(p * env.min.length / W);
      const mn = Math.max(-1, Math.min(1, env.min[b]));
      const mx = Math.max(-1, Math.min(1, env.max[b]));
      const yMin = yC - mn * ampH;   // negative samples → BELOW center → larger Y
      const yMax = yC - mx * ampH;
      topPath += " L " + p + " " + yMax.toFixed(1);
      botPath += " L " + p + " " + yMin.toFixed(1);
    }
    botPath += " L " + W + " " + yC.toFixed(1) + " L 0 " + yC.toFixed(1) + " Z";
    topPath += " L " + W + " " + yC.toFixed(1) + " L 0 " + yC.toFixed(1) + " Z";
    // Filled envelope (fills both top + bottom)
    html += `<path class="sm-wave-fill" d="${topPath}" />`;
    html += `<path class="sm-wave-fill" d="${botPath}" />`;
    // Edge stroke — a single polyline tracing max+min for visual punch
    let edgePath = "M 0 " + yC.toFixed(1);
    for (let p = 0; p < W; p++) {
      const b = Math.floor(p * env.min.length / W);
      const mx = Math.max(-1, Math.min(1, env.max[b]));
      const yMax = yC - mx * ampH;
      edgePath += " L " + p + " " + yMax.toFixed(1);
    }
    for (let p = W - 1; p >= 0; p--) {
      const b = Math.floor(p * env.min.length / W);
      const mn = Math.max(-1, Math.min(1, env.min[b]));
      const yMin = yC - mn * ampH;
      edgePath += " L " + p + " " + yMin.toFixed(1);
    }
    edgePath += " Z";
    html += `<path class="sm-wave-edge" d="${edgePath}" />`;
  }
  if (isStereo) {
    html += `<line class="sm-channel-divider" x1="0" y1="${laneH}" x2="${W}" y2="${laneH}" />`;
  }

  // Marker overlays — phosphor for granular position, info-cyan for
  // sample player start/end. Coordinates derived from the params.
  const totalSec = asset.durationSec;
  const secToX = (s) => Math.max(0, Math.min(W, (s / totalSec) * W));
  if (smIsGranular()) {
    const pos = Number(node.params.position) || 0;
    const x = pos * W;
    html += `<line class="sm-handle-line position" data-handle="position" x1="${x}" y1="0" x2="${x}" y2="${H}" />`;
    html += `<rect class="sm-handle-grip position" data-handle="position" x="${x - 6}" y="${H / 2 - 8}" width="12" height="16" rx="1" />`;
    html += `<text class="sm-handle-label position" x="${x + 8}" y="14">POS ${(pos * 100).toFixed(1)}%</text>`;
  } else {
    const startSec = Number(node.params.start) || 0;
    let endSec = Number(node.params.end);
    if (!isFinite(endSec) || endSec < 0) endSec = totalSec;
    const xs = secToX(startSec);
    const xe = secToX(endSec);
    // Region between start and end — slight cyan tint for the active span
    html += `<rect class="sm-handle-zone" x="${xs}" y="0" width="${Math.max(0, xe - xs)}" height="${H}" />`;
    html += `<line class="sm-handle-line" data-handle="start" x1="${xs}" y1="0" x2="${xs}" y2="${H}" />`;
    html += `<rect class="sm-handle-grip" data-handle="start" x="${xs - 6}" y="${H / 2 - 8}" width="12" height="16" rx="1" />`;
    html += `<text class="sm-handle-label" x="${xs + 8}" y="14">START ${startSec.toFixed(2)}s</text>`;
    html += `<line class="sm-handle-line" data-handle="end" x1="${xe}" y1="0" x2="${xe}" y2="${H}" />`;
    html += `<rect class="sm-handle-grip" data-handle="end" x="${xe - 6}" y="${H / 2 - 8}" width="12" height="16" rx="1" />`;
    html += `<text class="sm-handle-label" x="${Math.max(8, xe - 80)}" y="${H - 8}">END ${endSec.toFixed(2)}s</text>`;
  }

  svg.innerHTML = html;
  smUpdateMarkerReadout();
}

function smUpdateMarkerReadout() {
  const el = document.getElementById("sm-marker-readout");
  if (!el) return;
  const node = smGetNode();
  const asset = smGetAsset();
  if (!node || !asset) { el.textContent = "—"; return; }
  if (smIsGranular()) {
    const pos = Number(node.params.position) || 0;
    const sec = pos * asset.durationSec;
    el.textContent = `pos ${(pos * 100).toFixed(1)}%  ·  ${sec.toFixed(3)}s`;
  } else {
    const s = Number(node.params.start) || 0;
    let e = Number(node.params.end);
    if (!isFinite(e) || e < 0) e = asset.durationSec;
    const span = Math.max(0, e - s);
    el.textContent = `start ${s.toFixed(2)}s  end ${e.toFixed(2)}s  span ${span.toFixed(2)}s`;
  }
}

function smXToTime(clientX) {
  const svg = document.getElementById("sm-canvas");
  const asset = smGetAsset();
  if (!svg || !asset) return 0;
  const r = svg.getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width, clientX - r.left));
  return (x / r.width) * asset.durationSec;
}
function smXToFraction(clientX) {
  const svg = document.getElementById("sm-canvas");
  if (!svg) return 0;
  const r = svg.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
}

function smInstallCanvasHandlers() {
  const svg = document.getElementById("sm-canvas");
  if (!svg) return;

  svg.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    const node = smGetNode();
    const asset = smGetAsset();
    if (!node || !asset) return;
    ev.preventDefault();
    const target = ev.target;
    let kind = null;
    if (target && target.dataset && target.dataset.handle) {
      kind = target.dataset.handle;
    } else if (smIsGranular()) {
      // Granular: clicking anywhere sets the position cursor.
      kind = "position";
      node.params.position = smXToFraction(ev.clientX);
    } else {
      // SamplePlayer: clicking near the closest marker drags that one.
      const tSec = smXToTime(ev.clientX);
      const startSec = Number(node.params.start) || 0;
      let endSec = Number(node.params.end);
      if (!isFinite(endSec) || endSec < 0) endSec = asset.durationSec;
      const distStart = Math.abs(tSec - startSec);
      const distEnd   = Math.abs(tSec - endSec);
      kind = distStart < distEnd ? "start" : "end";
    }
    _smEd.drag = { kind };
    try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    pushHistory("sample:" + kind + ":" + node.id);
    smApplyDrag(ev);
    renderSampleCanvas();
    renderCode(); renderJson();
    renderMonitorControls();
  });
  svg.addEventListener("pointermove", ev => {
    if (!_smEd.drag) return;
    smApplyDrag(ev);
    renderSampleCanvas();
    renderCode(); renderJson();
    renderMonitorControls();
  });
  function endDrag() {
    if (_smEd.drag) {
      _smEd.drag = null;
      // Final commit re-renders props pane so e.g. the start/end
      // number inputs reflect the dragged value.
      renderProps();
    }
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
}

function smApplyDrag(ev) {
  const node = smGetNode();
  const asset = smGetAsset();
  if (!node || !asset || !_smEd.drag) return;
  const kind = _smEd.drag.kind;
  if (kind === "position") {
    node.params.position = smXToFraction(ev.clientX);
  } else if (kind === "start") {
    let endSec = Number(node.params.end);
    if (!isFinite(endSec) || endSec < 0) endSec = asset.durationSec;
    const t = Math.min(endSec - 0.001, smXToTime(ev.clientX));
    node.params.start = Math.max(0, t);
  } else if (kind === "end") {
    const startSec = Number(node.params.start) || 0;
    const t = Math.max(startSec + 0.001, smXToTime(ev.clientX));
    node.params.end = Math.min(asset.durationSec, t);
  }
}

/* Drop-zone wiring — full-stage drag-and-drop. preventDefault on
 * dragover is required for the drop event to fire. The visual
 * indicator is the .sm-stage.dragover class which reveals the
 * .sm-drop-overlay. Drops anywhere on the stage replace the asset. */
function smInstallDropZone() {
  const stage = document.getElementById("sm-stage");
  if (!stage) return;
  stage.addEventListener("dragover", ev => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    stage.classList.add("dragover");
  });
  stage.addEventListener("dragleave", ev => {
    // Only drop the dragover class when leaving the stage itself
    // (not when crossing into a child element). relatedTarget is null
    // when leaving the document entirely.
    if (!stage.contains(ev.relatedTarget)) stage.classList.remove("dragover");
  });
  stage.addEventListener("drop", async ev => {
    ev.preventDefault();
    stage.classList.remove("dragover");
    const node = smGetNode();
    if (!node) return;
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f) return;
    try {
      const rec = await loadAudioFileToAsset(f);
      pushHistory("asset:drop:" + node.id);
      node.params.assetId = rec.id;
      // Reset start/end to span the full new file (so clicking trig
      // plays it from the top by default — saves a rewire step).
      if (node.type !== "GranularPlayer") {
        node.params.start = 0;
        node.params.end   = rec.durationSec;
      }
      renderSampleCanvas();
      renderProps();
      renderCode(); renderJson();
    } catch (e) {
      alert("Audio decode failed: " + (e && e.message || e));
    }
  });
}

(function setupSampleModal() {
  const modal = document.getElementById("sample-modal");
  const close = document.getElementById("btn-sample-close");
  const done  = document.getElementById("btn-sample-done");
  const repl  = document.getElementById("btn-sample-replace");
  const clr   = document.getElementById("btn-sample-clear");
  if (!modal) return;
  if (close) close.addEventListener("click", closeSampleModal);
  if (done)  done.addEventListener("click",  closeSampleModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeSampleModal(); });
  if (repl) repl.addEventListener("click", () => {
    const node = smGetNode();
    if (!node) return;
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a";
    inp.addEventListener("change", async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const rec = await loadAudioFileToAsset(f);
        pushHistory("asset:replace:" + node.id);
        node.params.assetId = rec.id;
        if (node.type !== "GranularPlayer") {
          node.params.start = 0;
          node.params.end   = rec.durationSec;
        }
        renderSampleCanvas();
        renderProps(); renderCode(); renderJson();
      } catch (e) {
        alert("Audio decode failed: " + (e && e.message || e));
      }
    });
    inp.click();
  });
  if (clr) clr.addEventListener("click", () => {
    const node = smGetNode();
    if (!node) return;
    pushHistory("asset:clear:" + node.id);
    node.params.assetId = "";
    renderSampleCanvas();
    renderProps(); renderCode(); renderJson();
  });
  // Esc to close
  document.addEventListener("keydown", e => {
    if (modal.style.display === "none") return;
    if (isTextInput(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      closeSampleModal();
    }
  }, true);
  smInstallCanvasHandlers();
  smInstallDropZone();
})();

