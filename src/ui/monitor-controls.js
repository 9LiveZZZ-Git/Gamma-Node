/* ------------- Monitor controls (Button + Slider host nodes) ------------- */
/* Renders one row per Button / Slider node in the patch. Buttons fire
 * the host-gate setter on click (one-sample pulse); sliders write the
 * value setter on input. Setter indices are looked up via
 * collectExposedSetters by nodeId. Re-rendered on render() since the
 * node set can change at any time. */
/* Curve helpers — drag position t in [0..1] → output in [min..max].
 * Used by sliders to remap the linear range input into perceptually
 * useful curves (frequency / amplitude / decay / etc.). The inverse
 * is needed to compute the slider's drag position from a stored
 * value — analytic for linear/log/exp; sCurve uses a binary search
 * since 3t² - 2t³ has no clean inverse. */

/* Sprint 5.slider-aware — heuristic ranges by destination port name.
 * When a Slider's output gets wired into a param input, we check
 * this map (lowercase port name) and if the Slider is still at its
 * spawn-time defaults (min:0/max:1/curve:linear) we snap it to a
 * sensible range so the user doesn't have to manually configure a
 * 0..20000 freq slider every time.
 *
 * Match is exact-name first, then substring. Keep entries lowercase. */
const PARAM_HEURISTICS = {
  // Pitch / frequency
  "freq":      { min: 20,    max: 20000, curve: "log" },
  "frequency": { min: 20,    max: 20000, curve: "log" },
  "cutoff":    { min: 20,    max: 20000, curve: "log" },
  "hz":        { min: 20,    max: 20000, curve: "log" },
  // Resonance
  "q":         { min: 0.5,   max: 20,    curve: "log" },
  "res":       { min: 0,     max: 1,     curve: "linear" },
  "resonance": { min: 0,     max: 1,     curve: "linear" },
  // Levels / gain
  "gain":      { min: 0,     max: 2,     curve: "exp" },
  "amp":       { min: 0,     max: 1,     curve: "exp" },
  "level":     { min: 0,     max: 1,     curve: "exp" },
  "volume":    { min: 0,     max: 1,     curve: "exp" },
  // 0..1 dials (default-ish for mix-style controls)
  "amount":    { min: 0,     max: 1,     curve: "linear" },
  "mix":       { min: 0,     max: 1,     curve: "linear" },
  "depth":     { min: 0,     max: 1,     curve: "linear" },
  "wet":       { min: 0,     max: 1,     curve: "linear" },
  "dry":       { min: 0,     max: 1,     curve: "linear" },
  "feedback":  { min: 0,     max: 0.95,  curve: "linear" },
  "damping":   { min: 0,     max: 1,     curve: "linear" },
  "width":     { min: 0,     max: 1,     curve: "linear" },
  // Time / rate
  "delay":     { min: 0,     max: 2000,  curve: "log" },
  "time":      { min: 0,     max: 2000,  curve: "log" },
  "atk":       { min: 0,     max: 5000,  curve: "log" },
  "attack":    { min: 0,     max: 5000,  curve: "log" },
  "dec":       { min: 0,     max: 5000,  curve: "log" },
  "decay":     { min: 0,     max: 5000,  curve: "log" },
  "sus":       { min: 0,     max: 1,     curve: "linear" },
  "sustain":   { min: 0,     max: 1,     curve: "linear" },
  "rel":       { min: 0,     max: 5000,  curve: "log" },
  "release":   { min: 0,     max: 5000,  curve: "log" },
  "rate":      { min: 0.01,  max: 100,   curve: "log" },
  "speed":     { min: 0.01,  max: 100,   curve: "log" },
  // Modulation
  "ratio":     { min: 0.25,  max: 16,    curve: "log" },
  "index":     { min: 0,     max: 10,    curve: "linear" },
  "modindex":  { min: 0,     max: 10,    curve: "linear" },
  "modidx":    { min: 0,     max: 10,    curve: "linear" },
  // Stereo / pan / pitch offsets
  "pan":       { min: -1,    max: 1,     curve: "linear" },
  "detune":    { min: -1200, max: 1200,  curve: "linear" },
  "semi":      { min: -24,   max: 24,    curve: "linear" },
  "semitone":  { min: -24,   max: 24,    curve: "linear" },
  "phase":     { min: 0,     max: 1,     curve: "linear" },
  "offset":    { min: 0,     max: 1,     curve: "linear" }
};

/* Look up a heuristic by destination port name. Tries exact match
 * first, then case-insensitive substring (so "filterCutoff" matches
 * "cutoff"). Returns null when no rule applies. */
function paramHeuristicFor(portName) {
  if (!portName) return null;
  const lc = portName.toLowerCase();
  if (PARAM_HEURISTICS[lc]) return PARAM_HEURISTICS[lc];
  // Substring scan -- longest key wins so "cutoff" wins over "off".
  const keys = Object.keys(PARAM_HEURISTICS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (lc.includes(k)) return PARAM_HEURISTICS[k];
  }
  return null;
}

/* "Is this slider at its spawn-time defaults?" Used to gate the
 * auto-range apply -- we don't want to clobber a user's manual
 * tuning. Defaults match the Slider registry params: value=0.5,
 * min=0, max=1, curve=linear. */
function _sliderAtDefaults(node) {
  if (!node || node.type !== "Slider") return false;
  const p = node.params || {};
  return (p.min === 0 || p.min === undefined)
      && (p.max === 1 || p.max === undefined)
      && (p.curve === "linear" || p.curve === undefined);
}

const SLIDER_CURVES = {
  linear: { fwd: t => t,                                inv: y => y },
  log:    { fwd: t => Math.log10(1 + 9 * t),            inv: y => (Math.pow(10, y) - 1) / 9 },
  exp:    { fwd: t => t * t,                            inv: y => Math.sqrt(Math.max(0, y)) },
  sCurve: { fwd: t => t * t * (3 - 2 * t),              inv: y => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (mid * mid * (3 - 2 * mid) < y) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }}
};
// LUT-driven curve mapping (drag pos t ∈ [0,1] → output 0..1).
// Inverse uses bisection — needed when the table is non-monotonic
// (free-drawn curves) so we just find the closest x for a given y.
function lutForward(t, tbl) {
  const N = tbl.length;
  if (N === 0) return t;
  const fi = Math.max(0, Math.min(1, t)) * (N - 1);
  const i0 = Math.floor(fi), i1 = Math.min(N - 1, i0 + 1);
  return tbl[i0] * (1 - (fi - i0)) + tbl[i1] * (fi - i0);
}
function lutInverse(y, tbl) {
  const N = tbl.length;
  if (N === 0) return y;
  // Linear scan for the closest table entry — fine at N=64.
  let bestT = 0, bestDist = Infinity;
  for (let i = 0; i < N; i++) {
    const d = Math.abs(tbl[i] - y);
    if (d < bestDist) { bestDist = d; bestT = i / (N - 1); }
  }
  return bestT;
}
function sliderValueFromT(t, min, max, curve, tbl) {
  let mapped;
  if (curve === "custom" && Array.isArray(tbl) && tbl.length) {
    mapped = lutForward(t, tbl);
  } else {
    const fn = (SLIDER_CURVES[curve] || SLIDER_CURVES.linear).fwd;
    mapped = fn(Math.max(0, Math.min(1, t)));
  }
  return min + (max - min) * mapped;
}
function sliderTFromValue(v, min, max, curve, tbl) {
  if (max === min) return 0;
  const yNorm = Math.max(0, Math.min(1, (v - min) / (max - min)));
  if (curve === "custom" && Array.isArray(tbl) && tbl.length) {
    return lutInverse(yNorm, tbl);
  }
  const inv = (SLIDER_CURVES[curve] || SLIDER_CURVES.linear).inv;
  return Math.max(0, Math.min(1, inv(yNorm)));
}

function renderMonitorControls() {
  const wrap = document.getElementById("monitor-controls");
  if (!wrap) return;
  const buttons = state.nodes.filter(n => n.type === "Button");
  const sliders = state.nodes.filter(n => n.type === "Slider");
  if (!buttons.length && !sliders.length) {
    wrap.innerHTML = "";
    return;
  }
  const setters = collectExposedSetters();
  const findIdx = (nodeId, key, isGate) => {
    for (let i = 0; i < setters.length; i++) {
      const s = setters[i];
      if (s.nodeId === nodeId && s.key === key && !!s.isGate === !!isGate) return i;
    }
    return -1;
  };
  wrap.innerHTML = "";
  buttons.forEach(b => {
    const idx = findIdx(b.id, "trig", true);
    const label = (b.params && typeof b.params.label === "string" && b.params.label) ? b.params.label : "press";
    const row = document.createElement("div");
    row.className = "monitor-control monitor-control-grid-button";
    row.innerHTML =
      '<span class="monitor-control-id">btn <b>' + b.id + '</b></span>' +
      '<button class="monitor-control-button"></button>' +
      '<button class="monitor-control-curve" title="Edit gate-output shape">≈</button>' +
      '<span></span>';
    const btn = row.querySelector(".monitor-control-button");
    const editBtn = row.querySelector(".monitor-control-curve");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (idx < 0 || !previewState.workletNode || previewState.state !== "playing") return;
      previewState.workletNode.port.postMessage({ type: "set", index: idx, value: 0 });
      btn.classList.add("firing");
      setTimeout(() => btn.classList.remove("firing"), 80);
    });
    editBtn.addEventListener("click", () => openRampModal("button", b.id));
    wrap.appendChild(row);
  });
  sliders.forEach(s => {
    const idx = findIdx(s.id, "value", false);
    const min = (s.params && typeof s.params.min === "number") ? s.params.min : 0;
    const max = (s.params && typeof s.params.max === "number" && s.params.max > min) ? s.params.max : (min + 1);
    // curve can be "linear" / "log" / "exp" / "sCurve" (analytic) or
    // "custom" (uses params.curveTable). Fall back to linear if unknown.
    const rawCurve = s.params && typeof s.params.curve === "string" ? s.params.curve : "linear";
    const curve = (SLIDER_CURVES[rawCurve] || rawCurve === "custom") ? rawCurve : "linear";
    const tbl = (s.params && Array.isArray(s.params.curveTable)) ? s.params.curveTable : null;
    let cur = (s.params && typeof s.params.value === "number") ? s.params.value : (min + max) / 2;
    if (cur < min) cur = min; if (cur > max) cur = max;
    if (s.params && s.params.value !== cur) s.params.value = cur;
    // Range input always uses LINEAR t in 0..1; we map to the curved
    // value on every change. Inverse-mapping the stored value seeds
    // the thumb to the right position on first render.
    const initT = sliderTFromValue(cur, min, max, curve, tbl);
    const stepT = 0.001;
    const digits = Math.max(0, Math.ceil(-Math.log10((max - min) / 1000 || 1e-4)));
    const fmtVal = v => v.toFixed(digits);
    // Sprint 5.slider-aware -- list every input port this slider's
    // out is wired to, so the user sees what the knob actually
    // drives without having to follow wires on the canvas. Format:
    //   "→ Sine#n4.freq"  (one target)
    //   "→ Sine#n4.freq, BiquadLP#n7.cutoff"  (fan-out)
    const targets = state.edges
      .filter(e => e && e.from && e.from.node === s.id)
      .map(e => {
        const dn = state.nodes.find(n => n.id === e.to.node);
        return dn ? (dn.type + "#" + dn.id + "." + e.to.port) : null;
      })
      .filter(Boolean);
    const targetTxt = targets.length
      ? ' <span class="monitor-control-conn" title="' + escapeText(targets.join(", ")) + '">→ ' + escapeText(targets.slice(0, 2).join(", ") + (targets.length > 2 ? ", +" + (targets.length - 2) : "")) + '</span>'
      : "";
    const row = document.createElement("div");
    row.className = "monitor-control monitor-control-grid-with-edit";
    row.innerHTML =
      '<span class="monitor-control-id">sld <b>' + s.id + '</b>' + targetTxt + '</span>' +
      '<input class="monitor-control-slider" type="range"' +
        ' min="0" max="1" step="' + stepT + '" value="' + initT + '" />' +
      '<button class="monitor-control-curve" title="Edit slider response curve">≈</button>' +
      '<span class="monitor-control-value">' + fmtVal(cur) + '</span>';
    const slider = row.querySelector(".monitor-control-slider");
    const editBtn = row.querySelector(".monitor-control-curve");
    const val = row.querySelector(".monitor-control-value");
    slider.addEventListener("input", () => {
      const t = Number(slider.value);
      const v = sliderValueFromT(t, min, max, curve, tbl);
      val.textContent = fmtVal(v);
      const node = state.nodes.find(n => n.id === s.id);
      if (node) node.params.value = v;
      if (idx < 0 || !previewState.workletNode || previewState.state !== "playing") return;
      previewState.workletNode.port.postMessage({ type: "set", index: idx, value: v });
      // Mirror the new value to the touchscreen popup so its slider
      // tracks main-editor drags. No-op when no popup is connected.
      if (typeof _pushTouchControlsSnapshot === "function") _pushTouchControlsSnapshot();
    });
    editBtn.addEventListener("click", () => openRampModal("slider", s.id));
    wrap.appendChild(row);
  });
  // Push a fresh controls snapshot whenever the patch's controllable
  // nodes change (renderMonitorControls runs on add/delete/edit of
  // Slider+Button nodes). KeyboardIn add/remove doesn't go through
  // here but is uncommon enough that the popup tab-switch re-request
  // covers it.
  if (typeof _pushTouchControlsSnapshot === "function") _pushTouchControlsSnapshot();
}

/* Ramp editor — modal that picks a curve / shape for a Slider or
 * Button. Same modal, two option sets: sliders pick from
 * SLIDER_CURVES; buttons pick from a small list of envelope shapes
 * that the helperClass C++ already knows how to render. */
const CURVE_TABLE_SIZE = 64;
function defaultCurveTable() {
  const t = new Array(CURVE_TABLE_SIZE);
  for (let i = 0; i < CURVE_TABLE_SIZE; i++) t[i] = i / (CURVE_TABLE_SIZE - 1);
  return t;
}
const RAMP_CONFIG = {
  slider: {
    title: "Edit slider curve",
    note:  "Pick how the slider's drag position maps to its output. Linear is 1:1; log gives finer control at the bottom (good for frequency / amplitude); exp gives finer control at the top (good for time / decay); s-curve eases in and out; custom lets you draw the response.",
    paramKey: "curve",
    defaultKey: "linear",
    options: [
      { key: "linear", label: "linear" },
      { key: "log",    label: "log" },
      { key: "exp",    label: "exp" },
      { key: "sCurve", label: "s-curve" },
      { key: "custom", label: "custom ✎" }
    ]
  },
  button: {
    title: "Edit button gate shape",
    note:  "How the button's gate output looks when pressed. pulse is a single 1.f sample (default — drives gates via Schmitt threshold). linRamp + expDecay output a 1→0 envelope over the button's duration param (ms); custom lets you draw the envelope. Wire the gate into a Mul to gate audio amplitude with the envelope.",
    paramKey: "shape",
    defaultKey: "pulse",
    options: [
      { key: "pulse",    label: "pulse" },
      { key: "linRamp",  label: "linear" },
      { key: "expDecay", label: "exp decay" },
      { key: "custom",   label: "custom ✎" }
    ]
  },
  ramp: {
    title: "Edit ramp curve",
    note:  "Pick a preset or 'custom' to draw your own response. Linear is 1:1; log gives finer control at the bottom; exp gives finer control at the top; s-curve eases in and out; expSteep is a sharper exp. Custom samples 64 points across the input — the editor saves the table directly into the patch.",
    paramKey: "shape",
    defaultKey: "linear",
    options: [
      { key: "linear",    label: "linear" },
      { key: "log",       label: "log" },
      { key: "exp",       label: "exp" },
      { key: "sCurve",    label: "s-curve" },
      { key: "expSteep",  label: "exp steep" },
      { key: "custom",    label: "custom ✎" }
    ]
  }
};
// SVG path for a curve — t in 0..1 → y in 0..1 (1 at top of card,
// 0 at bottom). Returns an "M x,y L ..." path string scaled to the
// preview viewport. For Ramp's "custom" option, samples the saved
// curveTable; for the analytic presets, evaluates the matching fn.
function rampSvgPath(option, kind, w, h, node) {
  const samples = 32;
  const pts = [];
  // Helper closures pick the y value for a given t depending on kind+option.
  // "custom" reads the saved curveTable; everything else uses an analytic fn.
  const tblOrDefault = () =>
    (node && Array.isArray(node.params && node.params.curveTable) && node.params.curveTable.length)
      ? node.params.curveTable
      : defaultCurveTable();
  let yAt;
  if (option.key === "custom") {
    const tbl = tblOrDefault();
    const N = tbl.length;
    if (kind === "button") {
      // Buttons: x axis is "time since trigger" (0=trigger, 1=end).
      // The C++ helper indexes by (1 - t) so the LUT runs from
      // trigger->silence; mirror that here for an honest preview.
      yAt = t => {
        const fi = t * (N - 1);
        const i0 = Math.floor(fi), i1 = Math.min(N - 1, i0 + 1);
        return tbl[i0] * (1 - (fi - i0)) + tbl[i1] * (fi - i0);
      };
    } else {
      yAt = t => {
        const fi = t * (N - 1);
        const i0 = Math.floor(fi), i1 = Math.min(N - 1, i0 + 1);
        return tbl[i0] * (1 - (fi - i0)) + tbl[i1] * (fi - i0);
      };
    }
  } else if (kind === "slider") {
    const fn = (SLIDER_CURVES[option.key] || SLIDER_CURVES.linear).fwd;
    yAt = fn;
  } else if (kind === "button") {
    if (option.key === "pulse")        yAt = (t, i) => i === 0 ? 1 : 0;
    else if (option.key === "linRamp") yAt = t => 1 - t;
    else /* expDecay */                yAt = t => (1 - t) * (1 - t);
  } else /* ramp */ {
    if (option.key === "log")               yAt = t => Math.log10(1 + 9 * t);
    else if (option.key === "exp")          yAt = t => t * t;
    else if (option.key === "sCurve")       yAt = t => t * t * (3 - 2 * t);
    else if (option.key === "expSteep")     yAt = t => t * t * t * t;
    else /* linear */                       yAt = t => t;
  }
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = Math.max(0, Math.min(1, yAt(t, i)));
    const x = (t * w).toFixed(1);
    const py = ((1 - y) * h).toFixed(1);
    pts.push((i === 0 ? "M" : "L") + x + "," + py);
  }
  return pts.join(" ");
}

/* Drawable curve canvas. Rendered into the modal body when the user
 * picks "custom" on a ramp-editable node. Free-draw: click+drag sets
 * the y value at each sampled x position; gaps between consecutive
 * pointer samples are linearly interpolated so a fast drag still
 * fills the table cleanly. Reset restores identity. */
function buildCurveDrawPane(node) {
  const W = 480, H = 180;
  const pad = 8;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  const tbl = (node.params && Array.isArray(node.params.curveTable) && node.params.curveTable.length)
    ? node.params.curveTable.slice()
    : defaultCurveTable();
  if (!node.params) node.params = {};
  node.params.curveTable = tbl;
  const N = tbl.length;

  const pane = document.createElement("div");
  pane.className = "curve-draw-pane";
  pane.innerHTML =
    '<svg class="curve-draw-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + (pad + plotH * 0.5) + '" x2="' + (W - pad) + '" y2="' + (pad + plotH * 0.5) + '" />' +
      '<line class="curve-grid" x1="' + (pad + plotW * 0.5) + '" y1="' + pad + '" x2="' + (pad + plotW * 0.5) + '" y2="' + (H - pad) + '" />' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + pad + '" x2="' + (W - pad) + '" y2="' + pad + '" />' +
      '<line class="curve-grid" x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '" />' +
      '<path class="curve-fill"  d="" />' +
      '<path class="curve-line"  d="" />' +
      '<text class="curve-axis-label" x="' + (pad + 2) + '" y="' + (pad + 10) + '">1.0</text>' +
      '<text class="curve-axis-label" x="' + (pad + 2) + '" y="' + (H - pad - 2) + '">0.0</text>' +
      '<text class="curve-axis-label" x="' + (W - pad - 22) + '" y="' + (H - pad - 2) + '">1.0</text>' +
    '</svg>' +
    '<div class="curve-draw-actions">' +
      '<button class="btn" id="btn-curve-reset">Reset to linear</button>' +
      '<button class="btn" id="btn-curve-smooth">Smooth</button>' +
      '<button class="btn primary" id="btn-curve-done">Done</button>' +
    '</div>';

  const svg = pane.querySelector(".curve-draw-svg");
  const fillPath = pane.querySelector(".curve-fill");
  const linePath = pane.querySelector(".curve-line");

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
  }
  function paintFromPointer(ev, prev) {
    const r = svg.getBoundingClientRect();
    const cx = ev.clientX - r.left;
    const cy = ev.clientY - r.top;
    // Map to plot coords (pad-aware, scaled to viewBox).
    const sx = W / r.width;
    const sy = H / r.height;
    const px = (cx * sx - pad) / plotW;       // 0..1 normalized x
    const py = 1 - (cy * sy - pad) / plotH;   // 0..1 normalized y, inverted
    const i = Math.round(Math.max(0, Math.min(1, px)) * (N - 1));
    const v = Math.max(0, Math.min(1, py));
    if (prev && prev.i !== undefined) {
      // Linear-interp fill between consecutive pointer samples so a
      // fast drag still writes every bin in between.
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
    last = paintFromPointer(ev, null);
    pushHistory("curve:" + node.id);
  });
  svg.addEventListener("pointermove", ev => {
    if (!last) return;
    last = paintFromPointer(ev, last);
  });
  function endStroke() {
    last = null;
    // Re-render the patch + monitor + active card preview so the
    // changes ripple through to codegen and the slider/button widget.
    renderCode(); renderJson();
    if (typeof renderMonitorControls === "function") renderMonitorControls();
    refreshActiveCardPreview();
  }
  svg.addEventListener("pointerup",     endStroke);
  svg.addEventListener("pointercancel", endStroke);
  svg.addEventListener("pointerleave", () => { if (last) endStroke(); });

  pane.querySelector("#btn-curve-reset").addEventListener("click", () => {
    pushHistory("curve:" + node.id);
    for (let i = 0; i < N; i++) tbl[i] = i / (N - 1);
    refreshPaths();
    renderCode(); renderJson();
    if (typeof renderMonitorControls === "function") renderMonitorControls();
    refreshActiveCardPreview();
  });
  pane.querySelector("#btn-curve-smooth").addEventListener("click", () => {
    pushHistory("curve:" + node.id);
    const nxt = tbl.slice();
    for (let i = 1; i < N - 1; i++) nxt[i] = (tbl[i - 1] + tbl[i] + tbl[i + 1]) / 3;
    for (let i = 0; i < N; i++) tbl[i] = nxt[i];
    refreshPaths();
    renderCode(); renderJson();
    if (typeof renderMonitorControls === "function") renderMonitorControls();
    refreshActiveCardPreview();
  });
  pane.querySelector("#btn-curve-done").addEventListener("click", closeRampModal);

  function refreshActiveCardPreview() {
    // Update the preview SVG inside the "custom" card so it mirrors
    // the drawing as the user paints.
    const grid = document.getElementById("ramp-grid");
    if (!grid) return;
    const customCard = grid.querySelector('.ramp-card[data-key="custom"]');
    if (!customCard) return;
    const path = customCard.querySelector("path");
    if (!path) return;
    const d = rampSvgPath({ key: "custom" }, "ramp", 220, 56, node);
    path.setAttribute("d", d);
  }

  refreshPaths();
  return pane;
}
