/* Sprint hud-text -- per-node canvas factory for HUDText. Each node
 * gets its own canvas keyed by node id so multiple HUDText nodes
 * coexist without trampling each other. position:fixed lets us pin
 * to a screen corner regardless of viewport scroll / layout. */
function _ensureHudTextCanvas(nodeId) {
  const id = "hud-text-" + nodeId;
  let c = document.getElementById(id);
  if (c) return c;
  c = document.createElement("canvas");
  c.id = id;
  c.style.cssText =
    "position:fixed;z-index:84;border:1px solid rgba(120,140,170,0.35);" +
    "border-radius:6px;background:rgba(8,11,16,0.55);" +
    "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "box-shadow:0 4px 18px rgba(0,0,0,0.45);pointer-events:none;display:none;";
  document.body.appendChild(c);
  return c;
}

/* ── Phase 8.D.1 -- UI node rendering + pointer events ────────────
 *
 * UIButton / UIText / UIPanel each get their own absolute-positioned
 * canvas overlay. UIButton's canvas has pointer-events: auto + click
 * listeners; the others are passive (pointer-events: none).
 *
 * customRender param: when set, runs as a JS function body with
 * (ctx, p, input) in scope, replacing the default render. Lets users
 * draw fully custom widgets without leaving the node graph. */
function _ensureUiCanvas(node) {
  const id = "ui-canvas-" + node.id;
  let c = document.getElementById(id);
  if (c) return c;
  c = document.createElement("canvas");
  c.id = id;
  // UIButton is always interactive; UIText/UIPanel honor their
  // node.params.interactive flag (toggleable each tick, see
  // _tickUiNodes which updates pointer-events live).
  const startInteractive = _uiNodeIsInteractive(node);
  c.style.cssText =
    "position:fixed;z-index:85;pointer-events:" + (startInteractive ? "auto" : "none") +
    ";display:none;cursor:" + (startInteractive ? "pointer" : "default") + ";";
  document.body.appendChild(c);
  // Wire events on EVERY UI canvas; the pointer-events: none style
  // makes them no-ops when the node isn't interactive. Avoids
  // having to bind/unbind listeners when interactive toggles.
  _wireUiButtonEvents(node, c);
  return c;
}

function _uiNodeIsInteractive(node) {
  if (!node) return false;
  if (node.type === "UIButton" || node.type === "UISlider") return true;
  const v = node.params && node.params.interactive;
  return (typeof v === "number") && v >= 0.5;
}

function _wireUiButtonEvents(node, canvas) {
  canvas.addEventListener("pointerenter", () => { node._uiHover = true; });
  canvas.addEventListener("pointerleave", () => { node._uiHover = false; node._uiPressed = false; });
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    node._uiPressed = true;
    if (node.type === "UISlider") {
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      node._uiDragX = e.clientX - rect.left;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (node._uiPressed && node.type === "UISlider") {
      const rect = canvas.getBoundingClientRect();
      node._uiDragX = e.clientX - rect.left;
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    if (node._uiPressed) {
      e.preventDefault();
      node._uiPendingClick = true;
      node._uiPressed = false;
      if (node.type === "UISlider") node._uiDragX = undefined;
    }
  });
}

function _resolveUiAnchorPos(node, w, h) {
  const p = node.params || {};
  const corner = (typeof p.corner === "string") ? p.corner : "center";
  const x = (typeof p.x === "number") ? p.x : 0;
  const y = (typeof p.y === "number") ? p.y : 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left, top;
  if      (corner === "top-left")     { left = x;             top = y; }
  else if (corner === "top-right")    { left = vw - w - x;    top = y; }
  else if (corner === "bottom-left")  { left = x;             top = vh - h - y; }
  else if (corner === "bottom-right") { left = vw - w - x;    top = vh - h - y; }
  else /* center */                   { left = vw * 0.5 - w * 0.5 + x; top = vh * 0.5 - h * 0.5 + y; }
  return { left, top };
}

/* Compile + cache a customRender function per (node, code) pair so we
 * don't re-parse the JS every tick. Cleared when the code string
 * changes. Errors fall back to the default renderer + log once. */
function _runCustomRender(node, ctx, code, input) {
  if (typeof code !== "string" || !code.trim()) return false;
  if (node._uiCustomFnCode !== code) {
    try {
      node._uiCustomFn = new Function("ctx", "p", "input", code);
    } catch (e) {
      if (!node._uiCustomErrLogged) {
        node._uiCustomErrLogged = true;
        console.warn("[ui " + node.id + "] customRender parse error: " + e.message);
      }
      node._uiCustomFn = null;
    }
    node._uiCustomFnCode = code;
  }
  if (!node._uiCustomFn) return false;
  try {
    node._uiCustomFn(ctx, node.params || {}, input || {});
    return true;
  } catch (e) {
    if (!node._uiCustomRunErrLogged) {
      node._uiCustomRunErrLogged = true;
      console.warn("[ui " + node.id + "] customRender runtime error: " + e.message);
    }
    return false;
  }
}

function _drawUiButtonDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const hovered = !!input.hovered;
  const bg = hovered ? (p.hoverColor || "#5f7a98") : (p.color || "#3a4a60");
  const fg = p.textColor || "#ffffff";
  const border = p.borderColor || "#9bd0ff";
  const bw = (typeof p.borderWidth === "number") ? p.borderWidth : 1.5;
  const radius = Math.max(0, (typeof p.borderRadius === "number") ? p.borderRadius : 6);
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.95;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(bw, bw, w - 2*bw, h - 2*bw, radius);
  else ctx.rect(bw, bw, w - 2*bw, h - 2*bw);
  ctx.fillStyle = bg;   ctx.fill();
  ctx.lineWidth = bw;   ctx.strokeStyle = border; ctx.stroke();
  ctx.fillStyle = fg;
  ctx.font = (p.fontSize || 16) + "px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(p.label || ""), w * 0.5, h * 0.5);
  ctx.globalAlpha = 1;
}

function _drawUiTextDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const resolved = _resolveNodeParams ? _resolveNodeParams(input.node) : (input.node ? input.node.params : p);
  const text = (typeof resolved.text === "string") ? resolved.text :
               (Number.isFinite(resolved.text) ? String(resolved.text) : String(p.text || ""));
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.95;
  ctx.fillStyle = p.color || "#ffffff";
  ctx.font = (p.fontSize || 24) + "px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const align = p.align || "center";
  ctx.textAlign = align;
  const x = (align === "left") ? 0 : (align === "right") ? w : w * 0.5;
  ctx.fillText(text, x, h * 0.5);
  ctx.globalAlpha = 1;
}

function _drawUiPanelDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const radius = Math.max(0, (typeof p.borderRadius === "number") ? p.borderRadius : 8);
  const bw = (typeof p.borderWidth === "number") ? p.borderWidth : 1;
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.85;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(bw, bw, w - 2*bw, h - 2*bw, radius);
  else ctx.rect(bw, bw, w - 2*bw, h - 2*bw);
  ctx.fillStyle = p.color || "#0a0e16"; ctx.fill();
  if (bw > 0) { ctx.lineWidth = bw; ctx.strokeStyle = p.borderColor || "#5a7090"; ctx.stroke(); }
  ctx.globalAlpha = 1;
}

function _drawUiSliderDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const bw = (typeof p.borderWidth === "number") ? p.borderWidth : 1;
  const radius = Math.max(0, (typeof p.borderRadius === "number") ? p.borderRadius : 4);
  const min = typeof p.min === "number" ? p.min : 0;
  const max = typeof p.max === "number" ? p.max : 1;
  const range = max - min || 1;
  const val = typeof p.value === "number" ? p.value : min;
  const t = Math.max(0, Math.min(1, (val - min) / range));

  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.95;

  // Track background
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(bw, bw, w - 2 * bw, h - 2 * bw, radius);
  else ctx.rect(bw, bw, w - 2 * bw, h - 2 * bw);
  ctx.fillStyle = p.trackColor || "#2a3a50"; ctx.fill();
  if (bw > 0) { ctx.lineWidth = bw; ctx.strokeStyle = p.borderColor || "#5a7090"; ctx.stroke(); }

  // Fill bar
  const pad = bw + 2;
  const fillW = Math.max(0, (w - 2 * pad) * t);
  if (fillW > 0) {
    ctx.beginPath();
    const fr = Math.min(radius - 1, fillW * 0.5);
    if (typeof ctx.roundRect === "function") ctx.roundRect(pad, pad, fillW, h - 2 * pad, [fr, 0, 0, fr]);
    else ctx.rect(pad, pad, fillW, h - 2 * pad);
    ctx.fillStyle = p.fillColor || "#5a8ab0"; ctx.fill();
  }

  // Handle
  const handleX = pad + (w - 2 * pad) * t;
  const handleR = (h - 2 * pad) * 0.5;
  ctx.beginPath();
  ctx.arc(handleX, h * 0.5, Math.max(4, handleR), 0, Math.PI * 2);
  ctx.fillStyle = input.pressed ? "#ffffff" : (p.handleColor || "#cfe9ff");
  ctx.fill();

  // Label + value text
  const fs = typeof p.fontSize === "number" ? p.fontSize : 11;
  ctx.font = fs + "px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = p.textColor || "#cfe9ff";
  ctx.textBaseline = "middle";
  const label = (typeof p.label === "string" && p.label) ? p.label : "";
  if (label) {
    ctx.textAlign = "left";
    ctx.fillText(label, pad + 4, h * 0.5);
  }
  if ((typeof p.showValue === "number" ? p.showValue : 1) >= 0.5) {
    const step = typeof p.step === "number" ? p.step : 0;
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 2;
    ctx.textAlign = "right";
    ctx.fillText(val.toFixed(decimals), w - pad - 4, h * 0.5);
  }
  ctx.globalAlpha = 1;
}

function _leaderboardLoad(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(e => e && typeof e.score === "number" && isFinite(e.score));
  } catch (_) { return []; }
}
function _leaderboardSave(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (_) {}
}

function _drawLeaderboardDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const radius = Math.max(0, (typeof p.borderRadius === "number") ? p.borderRadius : 8);
  const bw = (typeof p.borderWidth === "number") ? p.borderWidth : 2;
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.94;
  // Panel background
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(bw, bw, w - 2*bw, h - 2*bw, radius);
  else ctx.rect(bw, bw, w - 2*bw, h - 2*bw);
  ctx.fillStyle = p.color || "#0a1018"; ctx.fill();
  if (bw > 0) { ctx.lineWidth = bw; ctx.strokeStyle = p.borderColor || "#ff8844"; ctx.stroke(); }

  const padX = 18, padY = 14;
  const titleFs = typeof p.titleFontSize === "number" ? p.titleFontSize : 18;
  const rowFs   = typeof p.fontSize       === "number" ? p.fontSize       : 14;

  // Title
  ctx.font = "600 " + titleFs + "px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = p.titleColor || "#ff8844";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  const title = (typeof p.title === "string") ? p.title : "TOP SCORES";
  ctx.fillText(title, w * 0.5, padY);

  // Entries
  const list = _leaderboardLoad(p.lsKey || "gamma-leaderboard-v1");
  list.sort((a, b) => b.score - a.score);
  const max = Math.max(1, Math.min(20, Math.round(p.maxEntries || 5)));
  const top = list.slice(0, max);
  const rowH = rowFs * 1.6;
  const topRowY = padY + titleFs * 1.5 + 6;
  ctx.font = rowFs + "px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = p.textColor || "#ffcc88";
  ctx.textBaseline = "middle";

  if (top.length === 0) {
    ctx.textAlign = "center";
    ctx.fillStyle = (p.textColor || "#ffcc88") + (p.opacity < 1 ? "" : "");
    ctx.globalAlpha *= 0.6;
    ctx.fillText("(no scores yet — fire the cannon!)", w * 0.5, topRowY + rowH * 0.5);
    ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.94;
  } else {
    for (let i = 0; i < top.length; i++) {
      const y = topRowY + rowH * (i + 0.5);
      // Rank
      ctx.textAlign = "left";
      ctx.fillText((i + 1) + ".", padX, y);
      // Score (right-aligned)
      ctx.textAlign = "right";
      ctx.fillText(String(top[i].score), w - padX, y);
      // Date in the middle (subtle)
      if (top[i].date) {
        ctx.textAlign = "center";
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * 0.55;
        ctx.fillText(top[i].date, w * 0.5, y);
        ctx.globalAlpha = prevAlpha;
      }
    }
  }
  ctx.globalAlpha = 1;
}

function _tickLeaderboards() {
  if (!state || !Array.isArray(state.nodes)) return;
  for (const node of state.nodes) {
    if (!node || node.type !== "Leaderboard") continue;
    if (!_isNodeActive(node)) continue;
    const p = node.params = node.params || {};
    const r = (typeof _resolveNodeParams === "function") ? _resolveNodeParams(node) : p;
    const key = p.lsKey || "gamma-leaderboard-v1";

    // Reset (rising edge): clear stored list
    const resetNow = (typeof r.reset === "number") ? r.reset : 0;
    if (resetNow >= 0.5 && (node._lbPrevReset || 0) < 0.5) {
      _leaderboardSave(key, []);
      p.topScore = 0;
      p.rank = 0;
    }
    node._lbPrevReset = resetNow;

    // Submit (rising edge): insert current score
    const submitNow = (typeof r.submit === "number") ? r.submit : 0;
    if (submitNow >= 0.5 && (node._lbPrevSubmit || 0) < 0.5) {
      const sc = Math.round(typeof r.score === "number" ? r.score : 0);
      if (sc > 0) {
        const list = _leaderboardLoad(key);
        const d = new Date();
        const date = d.getFullYear() + "-" +
          String(d.getMonth() + 1).padStart(2, "0") + "-" +
          String(d.getDate()).padStart(2, "0");
        list.push({ score: sc, date });
        list.sort((a, b) => b.score - a.score);
        const max = Math.max(1, Math.min(50, Math.round(p.maxEntries || 5)));
        const trimmed = list.slice(0, Math.max(max, 10));
        _leaderboardSave(key, trimmed);
        // Rank of just-inserted (highest-index match for ties)
        p.rank = trimmed.findIndex(e => e.score === sc && e.date === date) + 1;
      }
    }
    node._lbPrevSubmit = submitNow;

    // Always refresh topScore output
    const list = _leaderboardLoad(key);
    list.sort((a, b) => b.score - a.score);
    p.topScore = list.length ? list[0].score : 0;
  }
}

function _tickUiNodes() {
  if (!state || !Array.isArray(state.nodes)) return;
  _tickLeaderboards();
  const live = (typeof isLiveMode === "function") ? isLiveMode() : true;
  // Track which ui-canvas-* ids belong to the current patch so we can
  // hide orphans left over from a previous patch (mirrors the HUDText
  // GC). Without this, a UI canvas from a swapped-out demo stays
  // visible until something removes it.
  const touchedUi = new Set();
  for (const node of state.nodes) {
    if (!node) continue;
    if (node.type !== "UIButton" && node.type !== "UIText" && node.type !== "UIPanel" && node.type !== "UISlider" && node.type !== "Leaderboard") continue;
    touchedUi.add("ui-canvas-" + node.id);
    const canvas = _ensureUiCanvas(node);
    if (!live) { canvas.style.display = "none"; continue; }
    // R.3: if a `show` wire exists, use it for visibility; otherwise fall back to stage tag
    const showResolved = _resolveNodeParams(node);
    const hasShowWire = Array.isArray(state.edges) && state.edges.some(e =>
      e && e.to && e.to.node === node.id && e.to.port === "show");
    if (hasShowWire) {
      if ((typeof showResolved.show === "number" ? showResolved.show : 0) < 0.5) { canvas.style.display = "none"; continue; }
    } else {
      if (!_isNodeActive(node)) { canvas.style.display = "none"; continue; }
    }
    const p = node.params || {};
    let w, h;
    if (node.type === "UIText") {
      // UIText auto-sizes width to the rendered text + some padding.
      // For simplicity, use fontSize-based default.
      const fs = (typeof p.fontSize === "number") ? p.fontSize : 24;
      w = Math.max(40, (typeof p.width  === "number") ? p.width  : Math.max(120, String(p.text || "").length * fs * 0.55));
      h = Math.max(fs * 1.3, (typeof p.height === "number") ? p.height : fs * 1.6);
    } else {
      w = Math.max(8, (typeof p.width  === "number") ? p.width  : 180);
      h = Math.max(8, (typeof p.height === "number") ? p.height : 48);
    }
    if (canvas.width  !== Math.round(w)) canvas.width  = Math.round(w);
    if (canvas.height !== Math.round(h)) canvas.height = Math.round(h);
    const { left, top } = _resolveUiAnchorPos(node, w, h);
    canvas.style.left = left + "px";
    canvas.style.top  = top  + "px";
    canvas.style.width  = w + "px";
    canvas.style.height = h + "px";
    canvas.style.display = "block";
    // 8.D.1 v2 -- live-update pointer-events from the interactive
    // flag. Switching `interactive` 0->1 on a UIPanel/UIText in the
    // props panel takes effect on the next tick.
    const interactive = _uiNodeIsInteractive(node);
    const wantPe = interactive ? "auto" : "none";
    if (canvas.style.pointerEvents !== wantPe) {
      canvas.style.pointerEvents = wantPe;
      canvas.style.cursor = interactive ? "pointer" : "default";
      // Drop any captured hover state when going passive; clicks
      // already fall through, but the visual hover ring would stick.
      if (!interactive) {
        node._uiHover = false;
        node._uiPressed = false;
        node._uiPendingClick = false;
      }
    }
    const ctx = canvas.getContext("2d");
    const input = {
      node,
      width:   w,
      height:  h,
      hovered: !!node._uiHover,
      pressed: !!node._uiPressed
    };
    // Custom render takes precedence if defined.
    const customCode = (typeof p.customRender === "string") ? p.customRender : "";
    let usedCustom = false;
    if (customCode.trim()) {
      usedCustom = _runCustomRender(node, ctx, customCode, input);
    }
    if (!usedCustom) {
      if      (node.type === "UIButton")    _drawUiButtonDefault(ctx, p, input);
      else if (node.type === "UIText")      _drawUiTextDefault(ctx,   p, input);
      else if (node.type === "UIPanel")     _drawUiPanelDefault(ctx,  p, input);
      else if (node.type === "UISlider")    _drawUiSliderDefault(ctx,  p, input);
      else if (node.type === "Leaderboard") _drawLeaderboardDefault(ctx, p, input);
    }
    // UISlider drag logic: while pressed, map pointer X to value
    if (node.type === "UISlider" && node._uiPressed && node._uiDragX !== undefined) {
      const pad = ((typeof p.borderWidth === "number") ? p.borderWidth : 1) + 2;
      const trackW = w - 2 * pad;
      const localX = node._uiDragX;
      const t = Math.max(0, Math.min(1, (localX - pad) / (trackW || 1)));
      const min = typeof p.min === "number" ? p.min : 0;
      const max = typeof p.max === "number" ? p.max : 1;
      let val = min + t * (max - min);
      const step = typeof p.step === "number" ? p.step : 0;
      if (step > 0) val = Math.round(val / step) * step;
      val = Math.max(min, Math.min(max, val));
      p.value = val;
    }
    // 8.D.1 v2 -- interactivity readback. Every interactive UI node
    // (UIButton always, UIText/UIPanel when interactive=1, UISlider always) exposes
    // clicked + hovered. clicked pulses HIGH for one tick on each
    // pointer-up within bounds; hovered is 1 while the cursor sits
    // inside the rect.
    if (interactive) {
      if (node.type !== "UISlider") {
        p.clicked = node._uiPendingClick ? 1 : 0;
        node._uiPendingClick = false;
        p.hovered = node._uiHover ? 1 : 0;
      }
    } else {
      p.clicked = 0;
      p.hovered = 0;
    }
  }
  // Hide UI canvases that no longer correspond to a node in the
  // current patch (e.g. left over from a swapped-out demo).
  document.querySelectorAll('canvas[id^="ui-canvas-"]').forEach(c => {
    if (!touchedUi.has(c.id)) c.style.display = "none";
  });
}

function _tickHudTextNodes() {
  if (!state || !Array.isArray(state.nodes)) return;
  const live = (typeof isLiveMode === "function") ? isLiveMode() : true;
  // Track stacking offsets per-corner so multiple HUDText nodes in
  // the same corner don't overlap. Reset every tick.
  const cornerStack = { "top-left": 0, "top-right": 0, "bottom-left": 0, "bottom-right": 0 };
  const STACK_GAP = 4;
  // Also: collect ids we touched so we can hide canvases for deleted
  // HUDText nodes from a previous patch state.
  const touchedIds = new Set();
  for (const node of state.nodes) {
    if (!node || node.type !== "HUDText") continue;
    const canvas = _ensureHudTextCanvas(node.id);
    touchedIds.add("hud-text-" + node.id);
    if (!live) { canvas.style.display = "none"; continue; }
    // R.3: if a `show` wire exists, use it; otherwise fall back to stage tag
    const hudShowResolved = _resolveNodeParams(node);
    const hudHasShowWire = Array.isArray(state.edges) && state.edges.some(e =>
      e && e.to && e.to.node === node.id && e.to.port === "show");
    if (hudHasShowWire) {
      if ((typeof hudShowResolved.show === "number" ? hudShowResolved.show : 0) < 0.5) { canvas.style.display = "none"; continue; }
    } else {
      if (!_isNodeActive(node)) { canvas.style.display = "none"; continue; }
    }
    // Require a wire from this node's `hud` output -- matches the
    // Minimap/Altimeter convention so unwired HUDs stay invisible
    // and unobtrusive in the patch editor view.
    const hudWire = state.edges && state.edges.find(e =>
      e && e.from && e.from.node === node.id && e.from.port === "hud"
    );
    if (!hudWire || !hudWire.to) { canvas.style.display = "none"; continue; }
    const p = node.params || {};
    // Phase 8.D.1 -- if customRender is set, run it instead of the
    // default HUDText layout. ctx + p + input are in scope.
    if (typeof p.customRender === "string" && p.customRender.trim()) {
      // Auto-size canvas for custom render. Use width/height params
      // if present, else fall back to fontSize-based default.
      const fs = (typeof p.fontSize === "number") ? p.fontSize : 16;
      const w = Math.max(40, (typeof p.width  === "number") ? p.width  : 200);
      const h = Math.max(fs * 1.3, (typeof p.height === "number") ? p.height : fs * 1.8);
      if (canvas.width  !== Math.round(w)) canvas.width  = Math.round(w);
      if (canvas.height !== Math.round(h)) canvas.height = Math.round(h);
      const corner = (typeof p.corner === "string") ? p.corner : "top-left";
      const margin = Math.max(0, (typeof p.margin === "number") ? p.margin : 18);
      const vw = window.innerWidth, vh = window.innerHeight;
      let left, top;
      if      (corner === "top-left")     { left = margin;             top = margin; }
      else if (corner === "top-right")    { left = vw - w - margin;    top = margin; }
      else if (corner === "bottom-left")  { left = margin;             top = vh - h - margin; }
      else                                { left = vw - w - margin;    top = vh - h - margin; }
      canvas.style.left = left + "px";
      canvas.style.top  = top  + "px";
      canvas.style.width  = w + "px";
      canvas.style.height = h + "px";
      canvas.style.display = "block";
      const ctx = canvas.getContext("2d");
      _runCustomRender(node, ctx, p.customRender, { node, width: w, height: h });
      continue;
    }
    // Resolve text. If value is a finite number, format it with
    // prefix/suffix/decimals; otherwise use the static text param.
    const value = _resolveHudTextValue(node, "value");
    const prefix = (typeof p.prefix === "string") ? p.prefix : "";
    const suffix = (typeof p.suffix === "string") ? p.suffix : "";
    let body;
    if (Number.isFinite(value)) {
      const decimals = Math.max(0, Math.min(6, (typeof p.decimals === "number") ? p.decimals : 0));
      body = value.toFixed(decimals);
    } else {
      body = (typeof p.text === "string") ? p.text : "";
    }
    const display = prefix + body + suffix;
    const fontSize = Math.max(8, Math.min(96, (typeof p.fontSize === "number") ? p.fontSize : 16));
    const color    = (typeof p.color === "string" && p.color) ? p.color : "#ffffff";
    const opacity  = Math.max(0.05, Math.min(1.0, (typeof p.opacity === "number") ? p.opacity : 0.95));
    const margin   = Math.max(0, (typeof p.margin === "number") ? p.margin : 18);
    const corner   = (typeof p.corner === "string" && cornerStack[p.corner] !== undefined) ? p.corner : "top-left";
    // Measure with a temp ctx so the canvas can be sized to the text.
    // dpr-aware so the text stays crisp on retina displays.
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const pad = Math.round(fontSize * 0.5);
    // Temp canvas for measurement -- reuse the node's canvas at a
    // dummy size first, then resize.
    const tctx = canvas.getContext("2d");
    tctx.font = fontSize + "px ui-monospace, 'SF Mono', Menlo, monospace";
    const metrics = tctx.measureText(display);
    const textW = Math.ceil(metrics.width);
    const cssW = textW + pad * 2;
    const cssH = Math.ceil(fontSize * 1.4) + Math.round(pad * 0.5);
    // Set both the backing-store size (dpr-scaled) and the CSS size.
    if (canvas.width  !== Math.round(cssW * dpr)) canvas.width  = Math.round(cssW * dpr);
    if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    // Redraw -- transform to dpr-scaled space so text crisps.
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, cssW, cssH);
    tctx.fillStyle = color;
    tctx.font = fontSize + "px ui-monospace, 'SF Mono', Menlo, monospace";
    tctx.textBaseline = "middle";
    tctx.fillText(display, pad, cssH * 0.5);
    // Stack at the chosen corner -- offset by sum of previously
    // placed HUDText canvases in this corner.
    const stackOffset = cornerStack[corner];
    canvas.style.top = canvas.style.bottom = canvas.style.left = canvas.style.right = "";
    if (corner === "top-left")     { canvas.style.top    = (margin + stackOffset) + "px"; canvas.style.left  = margin + "px"; }
    else if (corner === "top-right")    { canvas.style.top    = (margin + stackOffset) + "px"; canvas.style.right = margin + "px"; }
    else if (corner === "bottom-left")  { canvas.style.bottom = (margin + stackOffset) + "px"; canvas.style.left  = margin + "px"; }
    else                                 { canvas.style.bottom = (margin + stackOffset) + "px"; canvas.style.right = margin + "px"; }
    cornerStack[corner] += cssH + STACK_GAP;
    canvas.style.opacity = String(opacity);
    canvas.style.display = "block";
  }
  // Clean up canvases for deleted nodes
  document.querySelectorAll('canvas[id^="hud-text-"]').forEach(c => {
    if (!touchedIds.has(c.id)) {
      c.style.display = "none";
    }
  });
}

/* Resolve a HUDText input -- walks the wire (if any) to find the
 * upstream numeric value. Returns the upstream value or the param's
 * static value if no wire is present. Returns NaN to signal
 * "use static text instead". */
function _resolveHudTextValue(node, port) {
  if (Array.isArray(state.edges)) {
    const edge = state.edges.find(e => e && e.to && e.to.node === node.id && e.to.port === port);
    if (edge && edge.from) {
      const src = state.nodes.find(n => n && n.id === edge.from.node);
      if (src && src.params && typeof src.params[edge.from.port] === "number") {
        return src.params[edge.from.port];
      }
    }
  }
  const v = node.params ? node.params[port] : undefined;
  return (typeof v === "number") ? v : NaN;
}

/* Phase 6.6.13 — virtual on-screen sticks for touch navigation.
 * Each pad is a 130 px circle; touching + dragging moves the inner
 * "knob" toward the touch point. The pad center represents zero
 * deflection; the pad radius (knob can travel half-radius from
 * center for clarity) maps to ±1 stick deflection.
 *
 * The knob position drives:
 *   move pad → cam.touchMove = { fwd: -dy/maxR, strafe: dx/maxR }
 *   look pad → cam.touchLook = { dx: dx/maxR * lookGain,
 *                                 dy: dy/maxR * lookGain }
 *
 * touchLook is a RATE (radians/sec), so holding the look pad to one
 * side keeps rotating; touchMove is a NORMAL (analog deflection), so
 * holding the move pad to one side moves at constant speed. Same
 * idiom as console game first-person controls. */
function _wireTouchPads() {
  const pads = document.querySelectorAll(".theater-pad");
  pads.forEach(pad => {
    const knob = pad.querySelector(".theater-pad-knob");
    let active = null;   // pointerId currently controlling this pad
    const updateKnob = (dx, dy, maxR) => {
      const cl = Math.max(0, Math.min(1, Math.hypot(dx, dy) / maxR));
      if (cl > 1) { dx = dx / cl; dy = dy / cl; }
      const visualX = Math.max(-maxR/2, Math.min(maxR/2, dx));
      const visualY = Math.max(-maxR/2, Math.min(maxR/2, dy));
      knob.style.transform = "translate(" + visualX + "px, " + visualY + "px)";
    };
    const reset = () => {
      knob.style.transform = "";
      pad.classList.remove("theater-pad-active");
      if (pad.dataset.pad === "move") Visual.theaterCam.touchMove = null;
      else                             Visual.theaterCam.touchLook = null;
    };
    pad.addEventListener("pointerdown", (e) => {
      if (active !== null) return;        // one finger per pad
      active = e.pointerId;
      try { pad.setPointerCapture(e.pointerId); } catch (_) {}
      pad.classList.add("theater-pad-active");
      e.preventDefault();
    });
    pad.addEventListener("pointermove", (e) => {
      if (e.pointerId !== active) return;
      const r = pad.getBoundingClientRect();
      const cx = r.left + r.width  * 0.5;
      const cy = r.top  + r.height * 0.5;
      const maxR = r.width * 0.5;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      // Clamp deflection magnitude to maxR so analog signal saturates
      // at ±1; the knob still moves to the edge but doesn't overshoot
      // the visual ring.
      const len = Math.hypot(dx, dy);
      if (len > maxR) { dx = dx * maxR / len; dy = dy * maxR / len; }
      updateKnob(dx, dy, maxR);
      const nx = dx / maxR;       // normalized -1..1
      const ny = dy / maxR;
      // Apply a small dead zone to prevent drift from a slightly-off-
      // center resting touch.
      const dead = 0.08;
      const m = Math.hypot(nx, ny);
      const scale = m > dead ? (m - dead) / (1 - dead) / m : 0;
      const sx = nx * scale, sy = ny * scale;
      if (pad.dataset.pad === "move") {
        // Up on the pad = forward (positive forward axis).
        Visual.theaterCam.touchMove = { fwd: -sy, strafe: sx };
      } else {
        // Look pad delivers a RATE: stick deflection × lookGain rad/s.
        // 2 rad/s at full stick gives ~115°/s — comfortable for
        // looking around without dizzy.
        const lookGain = 2.0;
        Visual.theaterCam.touchLook = { dx: sx * lookGain, dy: sy * lookGain };
      }
    });
    const end = (e) => {
      if (e.pointerId !== active) return;
      try { pad.releasePointerCapture(e.pointerId); } catch (_) {}
      active = null;
      reset();
    };
    pad.addEventListener("pointerup",     end);
    pad.addEventListener("pointercancel", end);
  });
}

