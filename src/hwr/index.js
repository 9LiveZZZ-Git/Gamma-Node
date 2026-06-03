/* Sprint 5.handwriting-multimonitor -- popup-window controls.
 * The chevron button next to the draw tool opens a small menu;
 * the menu's "Open touchscreen window" item launches a separate
 * browser window with a touch-optimized handwriting canvas + a
 * placeholder Controls tab. Cross-window messaging via Broadcast-
 * Channel: the popup captures strokes locally and posts a PNG
 * data URL; the main window runs the existing tesseract /
 * AI-vision recognition pipeline and spawns the matched node at
 * the visible viewport's center. Drag the popup to a secondary
 * touchscreen monitor for the intended workflow.
 *
 * The popup HTML is generated as a Blob URL so the editor stays a
 * single self-contained file -- no separate assets / routes.
 * Channel name "gamma-touchscreen". Messages:
 *   popup -> main : { type: "ink-image", dataUrl }
 *   main -> popup : { type: "ink-ack", ok, note }
 *   main -> popup : { type: "ping" } / popup -> main : { type: "pong" } */
const _toolMenu       = document.getElementById("tool-draw-menu-popup");
const _toolMenuBtn    = document.getElementById("tool-draw-menu");
const _touchOpenBtn   = document.getElementById("tool-touchscreen-open");
let   _touchChannel   = null;   // BroadcastChannel, created lazily
let   _touchPopupURL  = null;   // blob: URL for the popup HTML
let   _touchPopupRef  = null;   // window handle returned by window.open

function _toggleToolMenu(show) {
  if (!_toolMenu) return;
  const willShow = (typeof show === "boolean") ? show : (_toolMenu.style.display === "none");
  _toolMenu.style.display = willShow ? "block" : "none";
}
if (_toolMenuBtn) {
  _toolMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _toggleToolMenu();
  });
}
document.addEventListener("click", (e) => {
  if (!_toolMenu || _toolMenu.style.display === "none") return;
  if (e.target === _toolMenuBtn || _toolMenu.contains(e.target)) return;
  _toggleToolMenu(false);
});

/* HW.1 -- recognizer-image debug preview. When on, every Recognize
 * (canvas or touchscreen) drops the exact PNG sent to the recognizer
 * into a corner overlay, so we can SEE whether the handwriting was
 * captured / cropped / sized correctly. Toggle persisted to localStorage. */
let _hwrShowImage = false;
try { _hwrShowImage = localStorage.getItem("gamma-hwr-debug-v1") === "1"; } catch (_) {}
function _showHwrDebugImage(dataUrl) {
  if (!_hwrShowImage || !dataUrl) return;
  let box = document.getElementById("hwr-debug-overlay");
  if (!box) {
    box = document.createElement("div");
    box.id = "hwr-debug-overlay";
    box.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:99999;background:rgba(10,12,16,0.92);" +
      "border:1px solid var(--accent,#c8e85a);border-radius:6px;padding:8px;box-shadow:0 4px 18px rgba(0,0,0,0.5);" +
      "font:11px/1.4 monospace;color:#cfe;cursor:pointer;";
    box.title = "Recognizer image — click to dismiss";
    box.addEventListener("click", () => { box.style.display = "none"; });
    document.body.appendChild(box);
  }
  box.style.display = "block";
  box.innerHTML = '<div style="opacity:0.7;margin-bottom:4px">recognizer image (click to hide)</div>';
  const img = document.createElement("img");
  img.src = dataUrl;
  img.style.cssText = "max-width:42vw;max-height:30vh;image-rendering:pixelated;background:#fff;display:block;border:1px solid #333;";
  box.appendChild(img);
}
const _hwrDebugBtn = document.getElementById("tool-hwr-debug");
if (_hwrDebugBtn) {
  const _syncHwrDebug = () => {
    const chk = _hwrDebugBtn.querySelector(".tool-menu-check");
    if (chk) chk.textContent = _hwrShowImage ? "☑" : "☐";
  };
  _syncHwrDebug();
  _hwrDebugBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _hwrShowImage = !_hwrShowImage;
    try { localStorage.setItem("gamma-hwr-debug-v1", _hwrShowImage ? "1" : "0"); } catch (_) {}
    _syncHwrDebug();
    if (!_hwrShowImage) {
      const o = document.getElementById("hwr-debug-overlay");
      if (o) o.style.display = "none";
    }
  });
}
/* HW.4 -- offline stroke-template matcher. Disabled by default: the
 * current chamfer-distance metric on resampled point clouds isn't
 * discriminating enough for word-shaped handwriting — once a single
 * template is stored, almost any new word lands within the threshold
 * and gets misclassified as that one. Until the matcher is redesigned
 * (trajectory features + DTW, aspect-ratio gating), users opt in
 * explicitly. Persisted to localStorage; when OFF, the recognize
 * cascade also skips the auto-learn step so the library stays clean. */
let _hwrStrokeMatchOn = false;
try { _hwrStrokeMatchOn = localStorage.getItem("gamma-hwr-stroke-match-v1") === "1"; } catch (_) {}
const _hwrStrokeBtn = document.getElementById("tool-hwr-stroke-match");
if (_hwrStrokeBtn) {
  const _syncHwrStroke = () => {
    const chk = _hwrStrokeBtn.querySelector(".tool-menu-check");
    if (chk) chk.textContent = _hwrStrokeMatchOn ? "☑" : "☐";
  };
  _syncHwrStroke();
  _hwrStrokeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _hwrStrokeMatchOn = !_hwrStrokeMatchOn;
    try { localStorage.setItem("gamma-hwr-stroke-match-v1", _hwrStrokeMatchOn ? "1" : "0"); } catch (_) {}
    _syncHwrStroke();
  });
}

const _hwrClearBtn = document.getElementById("tool-hwr-clear");
if (_hwrClearBtn) {
  _hwrClearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _toggleToolMenu(false);
    const n = (typeof _hwrTemplateCount === "function") ? _hwrTemplateCount() : 0;
    if (n === 0) { setVoiceStatus("No learned handwriting to clear.", ""); setTimeout(() => setVoiceStatus("", ""), 1800); return; }
    if (!confirm("Forget all " + n + " learned handwriting template(s)?")) return;
    _hwrTemplates = {};
    _hwrSaveTemplates();
    setVoiceStatus("Cleared learned handwriting (" + n + " template(s)).", "");
    setTimeout(() => setVoiceStatus("", ""), 2200);
  });
}

function _ensureTouchChannel() {
  if (_touchChannel || typeof BroadcastChannel === "undefined") return _touchChannel;
  _touchChannel = new BroadcastChannel("gamma-touchscreen");
  _touchChannel.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === "ink-strokes") {
      _handleTouchInkStrokes(msg);
    } else if (msg.type === "ink-image") {
      _handleTouchInkImage(msg);
    } else if (msg.type === "pong") {
      console.log("[touchscreen] popup is alive");
      // Pop the current box state to the popup so its banner doesn't
      // start in the wrong state (e.g. main has a box drawn already
      // when the user opens the popup mid-session). Same idea for
      // the controls panel -- send a snapshot in case the popup is
      // already on the Controls tab when it connects.
      try {
        if (inkBox && inkBox.w >= 30 && inkBox.h >= 24) {
          _touchChannel.postMessage({ type: "box-update", w: inkBox.w, h: inkBox.h });
        } else {
          _touchChannel.postMessage({ type: "box-clear" });
        }
      } catch (_) {}
      _pushTouchControlsSnapshot();
    } else if (msg.type === "controls-request") {
      _pushTouchControlsSnapshot();
    } else if (msg.type === "control-slider") {
      _handleTouchControlSlider(msg);
    } else if (msg.type === "control-button") {
      _handleTouchControlButton(msg);
    } else if (msg.type === "control-key-down") {
      // Touch keyboard sends MIDI directly so it can address any
      // octave; the legacy QWERTY-keyed shape (msg.key) still works
      // for back-compat in case an older popup is open.
      if (typeof msg.midi === "number" && typeof playKeyboardMidi === "function") {
        playKeyboardMidi(msg.midi);
      } else if (typeof msg.key === "string" && typeof playKeyboardNote === "function") {
        playKeyboardNote(msg.key);
      }
    } else if (msg.type === "control-key-up") {
      if (typeof msg.midi === "number" && typeof releaseKeyboardMidi === "function") {
        releaseKeyboardMidi(msg.midi);
      } else if (typeof msg.key === "string" && typeof releaseKeyboardNote === "function") {
        releaseKeyboardNote(msg.key);
      }
    } else if (msg.type === "control-octave") {
      if (typeof setKbOctaveShift === "function") {
        setKbOctaveShift(kbOctaveShift + (Number(msg.delta) || 0));
        _pushTouchControlsSnapshot();
      }
    }
  };
  return _touchChannel;
}

/* Sprint 5.handwriting-multimonitor (controls tab) -- compact
 * snapshot of every Slider / Button / KeyboardIn in the patch for
 * the touchscreen popup. Sent on connect, on request, after a
 * patch mutation that affects controls (renderMonitorControls),
 * after a play/stop transition, and after any control changes
 * (so the popup re-syncs with main-editor drags). */
function _pushTouchControlsSnapshot() {
  if (!_touchChannel) return;
  try {
    const sliders = state.nodes.filter(n => n.type === "Slider").map(n => {
      const min = (n.params && typeof n.params.min === "number") ? n.params.min : 0;
      const max = (n.params && typeof n.params.max === "number" && n.params.max > min) ? n.params.max : (min + 1);
      let value = (n.params && typeof n.params.value === "number") ? n.params.value : (min + max) / 2;
      if (value < min) value = min; if (value > max) value = max;
      const curve = (n.params && typeof n.params.curve === "string") ? n.params.curve : "linear";
      const curveTable = (n.params && Array.isArray(n.params.curveTable)) ? n.params.curveTable : null;
      return { id: n.id, min, max, value, curve, curveTable };
    });
    const buttons = state.nodes.filter(n => n.type === "Button").map(n => {
      const label = (n.params && typeof n.params.label === "string" && n.params.label) ? n.params.label : "press";
      return { id: n.id, label };
    });
    const hasKeyboard = state.nodes.some(n => n.type === "KeyboardIn");
    _touchChannel.postMessage({
      type: "controls-snapshot",
      sliders,
      buttons,
      keyboard: { present: hasKeyboard },
      octaveShift: (typeof kbOctaveShift === "number") ? kbOctaveShift : 0,
      playing: !!(typeof previewState !== "undefined" && previewState && previewState.state === "playing")
    });
  } catch (_) {}
}

/* Placement target for a touchscreen recognition: the box the user drew
 * on the main canvas if any, else a synthesized box at the viewport
 * centre (so a purely touchscreen-driven user still spawns SOMETHING). */
function _touchPlacementBox() {
  if (inkBox && inkBox.w >= 30 && inkBox.h >= 24) {
    return { x: inkBox.x, y: inkBox.y, w: inkBox.w, h: inkBox.h };
  }
  const cr = canvas.getBoundingClientRect();
  const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
  const w = 240, h = 140;
  let worldX = cx - w / 2, worldY = cy - h / 2;
  try {
    if (typeof screenToWorld === "function") {
      const wp = screenToWorld(cx, cy);
      worldX = wp.x - w / 2; worldY = wp.y - h / 2;
    }
  } catch (_) {}
  return { x: worldX, y: worldY, w, h };
}

/* HW.6 -- touchscreen recognition from raw STROKES (the popup now posts
 * vector strokes, not a pre-rendered PNG). Routes them through the SAME
 * shared core as the canvas pen, so the touchscreen gets shape detection,
 * the HW.4 online stroke matcher, the HW.1 rasterizer, Tesseract, the VLM,
 * and auto-learn — everything the main canvas has. */
async function _handleTouchInkStrokes(msg) {
  const ackTo = (ok, note) => { if (_touchChannel) _touchChannel.postMessage({ type: "ink-ack", ok, note }); };
  const raw = Array.isArray(msg && msg.strokes) ? msg.strokes : [];
  const strokes = raw
    .map(s => Array.isArray(s) ? s.map(p => ({ x: +p.x, y: +p.y })).filter(p => isFinite(p.x) && isFinite(p.y)) : [])
    .filter(s => s.length >= 1);
  if (!strokes.length) { setVoiceStatus("Touchscreen: nothing drawn.", "err"); ackTo(false, "empty"); return; }
  const provider = (typeof PROVIDERS === "object") ? PROVIDERS[aiSettings.provider] : null;
  if (!provider || !provider.supportsImage) {
    setVoiceStatus("Provider doesn't support images — switch provider in ⚙ AI settings.", "err");
    ackTo(false, "no-image-provider"); return;
  }
  let key = "";
  if (provider.requiresKey) {
    key = aiSettings.anthropicKey;
    if (!key) { setVoiceStatus("Touchscreen: no Anthropic key set (⚙ in User DSP)", "err"); ackTo(false, "missing-anthropic-key"); return; }
  }
  if (aiSettings.provider === "gemma" && typeof setupGemmaAvailable === "function" && !setupGemmaAvailable()) {
    setVoiceStatus("WebGPU not available for Gemma — set an Anthropic key.", "err"); ackTo(false, "no-webgpu"); return;
  }
  const box = _touchPlacementBox();
  setVoiceStatus("Recognizing (touchscreen)…", "thinking");
  try {
    const r = await _recognizeInkStrokes(strokes, box, key);
    if (r.matched) {
      setVoiceStatus("✓ touchscreen → " + r.matched, "");
      setTimeout(() => setVoiceStatus("", ""), 2000);
      ackTo(true, r.matched);
      if (inkBox) clearInk();
      render();
    } else {
      setVoiceStatus("No match: \"" + (r.lastReply || "").trim().slice(0, 30) + "\"", "err");
      ackTo(false, "no-match: " + (r.lastReply || ""));
    }
  } catch (err) {
    console.error("[touchscreen] recognize failed:", err);
    setVoiceStatus("Recognize failed (touchscreen): " + (err.message || err), "err");
    ackTo(false, String(err.message || err));
  }
}

/* Apply a slider drag that came in from the touchscreen popup. Mirror
 * of monitor-controls' slider input handler: write the curve-resolved
 * value into node.params.value, post the same { type:"set", index, value }
 * worklet message, and refresh main's monitor-controls UI so its
 * thumb tracks the touchscreen. The popup updates its display
 * optimistically; we re-broadcast the snapshot so other touchscreen
 * tabs / instances re-sync. */
function _handleTouchControlSlider(msg) {
  if (!msg || !msg.id) return;
  const n = state.nodes.find(x => x && x.id === msg.id);
  if (!n || n.type !== "Slider") return;
  const min = (n.params && typeof n.params.min === "number") ? n.params.min : 0;
  const max = (n.params && typeof n.params.max === "number" && n.params.max > min) ? n.params.max : (min + 1);
  const curve = (n.params && typeof n.params.curve === "string") ? n.params.curve : "linear";
  const tbl = (n.params && Array.isArray(n.params.curveTable)) ? n.params.curveTable : null;
  const t = Math.max(0, Math.min(1, Number(msg.t) || 0));
  const v = sliderValueFromT(t, min, max, curve, tbl);
  if (!n.params) n.params = {};
  n.params.value = v;
  // Worklet routing (no-op if preview isn't running).
  if (previewState && previewState.workletNode && previewState.state === "playing") {
    const setters = collectExposedSetters();
    for (let i = 0; i < setters.length; i++) {
      const s = setters[i];
      if (s.nodeId === n.id && s.key === "value" && !s.isGate) {
        previewState.workletNode.port.postMessage({ type: "set", index: i, value: v });
        break;
      }
    }
  }
  // Refresh main's monitor-controls so the thumb / value display
  // mirror the popup's drag.
  if (typeof renderMonitorControls === "function") renderMonitorControls();
}

/* Fire a button gate pulse from the touchscreen popup. Mirror of
 * the monitor-controls button click handler. */
function _handleTouchControlButton(msg) {
  if (!msg || !msg.id) return;
  const n = state.nodes.find(x => x && x.id === msg.id);
  if (!n || n.type !== "Button") return;
  if (!previewState || !previewState.workletNode || previewState.state !== "playing") return;
  const setters = collectExposedSetters();
  for (let i = 0; i < setters.length; i++) {
    const s = setters[i];
    if (s.nodeId === n.id && s.key === "trig" && s.isGate) {
      previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
      break;
    }
  }
}

/* Process a PNG dataUrl that came in from the popup window. Reuses
 * the existing tesseract + AI-vision recognition pipeline; on a
 * match, spawns the node at the viewport center. The 280x180
 * synthesized inkBox is the same size as the popup's drawing canvas
 * region; tryCreateFromLabel uses it for positional placement. */
async function _handleTouchInkImage(msg) {
  if (!msg || !msg.dataUrl) return;
  // Convert dataUrl to base64 (existing helpers expect both).
  const dataUrl = msg.dataUrl;
  const base64  = dataUrl.split(",")[1] || "";
  _showHwrDebugImage(dataUrl);
  // Placement target: prefer the box the user drew on the main
  // canvas (so the touchscreen is just an alternative INPUT surface
  // for the SAME box). If no box is drawn, fall back to a synthesized
  // viewport-center box so we still spawn SOMETHING -- useful when
  // the user is purely touchscreen-driven and never touched the main
  // canvas's ✎ tool.
  let box;
  if (inkBox && inkBox.w >= 30 && inkBox.h >= 24) {
    box = { x: inkBox.x, y: inkBox.y, w: inkBox.w, h: inkBox.h };
  } else {
    const cr  = canvas.getBoundingClientRect();
    const cx  = cr.left + cr.width  / 2;
    const cy  = cr.top  + cr.height / 2;
    const w   = 240, h = 140;
    let worldX = cx - w / 2, worldY = cy - h / 2;
    try {
      if (typeof screenToWorld === "function") {
        const wp = screenToWorld(cx, cy);
        worldX = wp.x - w / 2; worldY = wp.y - h / 2;
      }
    } catch (_) {}
    box = { x: worldX, y: worldY, w, h };
  }

  const ackTo = (ok, note) => {
    if (_touchChannel) _touchChannel.postMessage({ type: "ink-ack", ok, note });
  };
  setVoiceStatus("Recognizing (touchscreen)…", "thinking");
  let matched = null, lastReply = "";
  try {
    const { text, confidence } = await tesseractRecognize(dataUrl);
    lastReply = text || "";
    // HW.2 -- same arbitration as the canvas path: confident single
    // words use Tesseract; chains + low-confidence reads go to the VLM.
    if (text && !_looksLikeChain(text) && confidence >= HWR_OCR_CONF_FLOOR) {
      matched = tryCreateFromLabel(text, box, /*silent*/ true);
    }
  } catch (err) {
    console.warn("[touchscreen] tesseract failed:", err);
  }
  if (!matched) {
    // 5.handwriting-multimonitor-fix1 -- resolve the API key the
    // same way the in-canvas handwriting path does. Pre-fix used
    // aiSettings.key which doesn't exist; the actual field is
    // aiSettings.anthropicKey (Anthropic provider) or no key at
    // all for Gemma local. Without the right key the cloud
    // provider returns 401 Invalid x-api-key.
    const provider = (typeof PROVIDERS === "object") ? PROVIDERS[aiSettings.provider] : null;
    let visionKey = "";
    if (provider && provider.requiresKey) {
      visionKey = aiSettings.anthropicKey;
      if (!visionKey) {
        setVoiceStatus("Touchscreen: no Anthropic key set (⚙ in User DSP)", "err");
        ackTo(false, "missing-anthropic-key");
        return;
      }
    }
    try {
      setVoiceStatus("Reading with " + aiSettings.provider + "…", "thinking");
      const result = await callVision(base64, visionKey);
      lastReply = result.raw || result.text || "";
      matched = _applyVisionResult(result, box, /*silent*/ false);
    } catch (err) {
      console.error("[touchscreen] vision failed:", err);
      setVoiceStatus("Recognize failed (touchscreen): " + (err.message || err), "err");
      ackTo(false, String(err.message || err));
      return;
    }
  }
  if (matched) {
    setVoiceStatus("✓ touchscreen → " + matched, "");
    setTimeout(() => setVoiceStatus("", ""), 2000);
    ackTo(true, matched);
    // Successful spawn -- dismiss the box on the main canvas (also
    // broadcasts box-clear to the popup, which resets its status).
    if (inkBox) clearInk();
    render();
  } else {
    setVoiceStatus("No match: \"" + (lastReply || "").trim().slice(0, 30) + "\"", "err");
    ackTo(false, "no-match: " + lastReply);
  }
}

function _openTouchscreenWindow() {
  _ensureTouchChannel();
  // Re-open: if the previous popup is still alive, just focus it.
  if (_touchPopupRef && !_touchPopupRef.closed) {
    try { _touchPopupRef.focus(); } catch (_) {}
    _toggleToolMenu(false);
    return;
  }
  if (!_touchPopupURL) {
    const html = _buildTouchscreenHtml();
    const blob = new Blob([html], { type: "text/html" });
    _touchPopupURL = URL.createObjectURL(blob);
  }
  // popup=true asks for a tear-off chromeless window (Chrome / Edge);
  // some browsers still give a regular tab. Either way it works.
  _touchPopupRef = window.open(_touchPopupURL, "gamma-touchscreen",
    "popup=true,width=900,height=720");
  _toggleToolMenu(false);
}

if (_touchOpenBtn) _touchOpenBtn.addEventListener("click", _openTouchscreenWindow);

// Sprint 5.smart-link.multi-select -- menu-driven trigger for the
// same _autoConnectSelection the W keybind fires. Discoverable for
// users who don't know the keybind.
const _autoWireBtn = document.getElementById("tool-auto-wire");
if (_autoWireBtn) _autoWireBtn.addEventListener("click", () => {
  _toggleToolMenu(false);
  _autoConnectSelection();
});

// Sprint 5.smart-link.ai-patch-connect -- menu-driven trigger for
// the AI auto-wire (Shift+W). Same provider plumbing as the User
// DSP tab; status feedback shows on the canvas-side pill.
const _aiAutoWireBtn = document.getElementById("tool-ai-auto-wire");
if (_aiAutoWireBtn) _aiAutoWireBtn.addEventListener("click", () => {
  _toggleToolMenu(false);
  _aiAutoConnect();
});

/* HTML for the popup window. Self-contained -- styles + scripts +
 * pointer event handling all inline. Communicates with the main
 * window via BroadcastChannel("gamma-touchscreen"). */
function _buildTouchscreenHtml() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gamma · Touchscreen</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Inter:wght@400;500&family=Major+Mono+Display&family=Fragment+Mono&display=swap" rel="stylesheet" />
<style>
  /* Match the main editor's phosphor lab tokens so the popup feels
     like one app, not two. Same palette, same fonts, same sharp
     1px borders. See main editor :root for the canonical values. */
  :root {
    --bg:           #050608;
    --surface:      #0c0e12;
    --surface-2:    #11141a;
    --surface-3:    #171a20;
    --border:       rgba(200,232,90,0.16);
    --border-strong:rgba(200,232,90,0.34);
    --text:         #e6e3dc;
    --text-2:       #95928a;
    --text-3:       #5d5b54;
    --accent:       #c8e85a;
    --accent-ink:   #050608;
    --danger:       #e24b4a;
    --warn:         #ffb347;
    --phosphor:     #c8e85a;
    --phosphor-mid: rgba(200,232,90,0.45);
    --phosphor-dim: rgba(200,232,90,0.18);
    --phosphor-trc: rgba(200,232,90,0.06);
    --instr-bg:     #050608;
    --instr-bg-2:   #0a0c10;
    --instr-rule:   rgba(200,232,90,0.14);
    --font-sans:    "Inter", system-ui, -apple-system, sans-serif;
    --font-mono:    "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace;
    --font-instr:   "Major Mono Display", "JetBrains Mono", monospace;
    --font-body-m:  "Fragment Mono", "JetBrains Mono", monospace;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg); color: var(--text);
    font-family: var(--font-sans);
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
    user-select: none; -webkit-user-select: none;
  }
  body { display: flex; flex-direction: column; }
  /* Lab-style scrollbars match the main editor exactly. */
  * { scrollbar-color: var(--phosphor-dim) var(--instr-bg); scrollbar-width: thin; }
  ::-webkit-scrollbar          { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track    { background: var(--instr-bg); }
  ::-webkit-scrollbar-thumb    { background: var(--phosphor-dim); border: 2px solid var(--instr-bg); border-radius: 0; }
  ::-webkit-scrollbar-thumb:hover { background: var(--phosphor-mid); }

  /* Tabs ---------------------------------------------------- */
  .tabs {
    display: flex; gap: 0;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .tab {
    flex: 1; padding: 12px 16px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    color: var(--text-2);
    font-family: var(--font-instr);
    font-size: 12px;
    letter-spacing: 0.16em;
    text-transform: lowercase;
    cursor: pointer;
  }
  .tab:last-child { border-right: none; }
  .tab.active {
    background: var(--bg);
    color: var(--phosphor);
    border-bottom: 1px solid var(--phosphor);
    margin-bottom: -1px;
  }

  .panel { flex: 1; display: none; flex-direction: column; padding: 14px; gap: 12px; min-height: 0; }
  .panel.active { display: flex; }

  /* Handwriting tab ---------------------------------------- */
  .ink-wrap {
    flex: 1; position: relative;
    background: var(--instr-bg-2);
    border: 1px solid var(--instr-rule);
    overflow: hidden; min-height: 0;
  }
  #ink-canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: crosshair; }
  .baseline {
    position: absolute;
    left: 6%; right: 6%; top: 70%;
    height: 0;
    border-top: 1px dashed var(--phosphor-dim);
    pointer-events: none;
  }
  .baseline-cap {
    position: absolute;
    width: 6px; height: 6px;
    background: var(--phosphor-dim);
    top: -3.5px;
  }
  .baseline-cap.l { left: -3px; }
  .baseline-cap.r { right: -3px; }
  .box-banner {
    position: absolute;
    top: 10px; left: 50%; transform: translateX(-50%);
    padding: 6px 12px;
    background: var(--instr-bg);
    border: 1px solid var(--instr-rule);
    color: var(--text-2);
    font-family: var(--font-instr);
    font-size: 9px;
    letter-spacing: 0.16em;
    text-transform: lowercase;
    pointer-events: none;
    display: none;
  }
  .box-banner.has-box { border-color: var(--phosphor-dim); color: var(--phosphor); }

  .actions { display: flex; gap: 8px; align-items: center; }
  /* Primary touchscreen buttons -- larger than the main editor's
     monitor-control buttons because fingertips, but same phosphor
     palette + uppercase-tracking aesthetic. */
  .btn {
    padding: 12px 22px;
    background: var(--instr-bg);
    border: 1px solid var(--phosphor-dim);
    color: var(--phosphor);
    font-family: var(--font-instr);
    font-size: 12px;
    letter-spacing: 0.18em;
    text-transform: lowercase;
    cursor: pointer;
    transition: background 0.08s, color 0.08s;
  }
  .btn:hover  { background: var(--instr-bg-2); border-color: var(--phosphor-mid); }
  .btn:active { background: var(--phosphor); color: var(--instr-bg); }
  .btn.primary { background: var(--phosphor); color: var(--instr-bg); border-color: var(--phosphor); }
  .btn.primary:hover  { background: var(--phosphor); color: var(--instr-bg); }
  .btn.primary:active { background: var(--phosphor-mid); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .status {
    flex: 1; padding: 0 8px;
    min-height: 1.4em;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-2);
  }
  .status.ok  { color: var(--phosphor); }
  .status.err { color: var(--danger); }
  .placeholder {
    padding: 40px; text-align: center;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.6;
  }
  .placeholder strong { color: var(--text); }
  .placeholder code {
    background: var(--instr-bg-2);
    border: 1px solid var(--instr-rule);
    padding: 1px 6px;
    color: var(--phosphor);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .conn-pip {
    width: 8px; height: 8px;
    background: var(--danger);
    display: inline-block; vertical-align: middle;
    margin-right: 6px;
  }
  .conn-pip.ok { background: var(--phosphor); }

  /* Controls tab ------------------------------------------- */
  .ctrl-status-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    background: var(--instr-bg-2);
    border: 1px solid var(--instr-rule);
    font-family: var(--font-instr);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: lowercase;
    color: var(--text-2);
  }
  .ctrl-play-pip {
    width: 8px; height: 8px;
    background: var(--danger);
    flex: 0 0 8px;
  }
  .ctrl-play-pip.playing { background: var(--phosphor); }
  .ctrl-list {
    display: flex; flex-direction: column; gap: 8px;
    flex: 1;
    overflow-y: auto;
    padding-right: 4px;
  }
  .ctrl-group-label {
    font-family: var(--font-instr);
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: lowercase;
    color: var(--phosphor-mid);
    margin: 8px 0 -2px 2px;
  }
  .ctrl-group-label:first-child { margin-top: 2px; }
  /* Header row above the sliders section. Holds the section label
     on the left and the orientation toggle on the right. */
  .ctrl-sliders-header {
    display: flex; align-items: center; justify-content: space-between;
    margin: 8px 0 -2px 2px;
  }
  .ctrl-sliders-header .ctrl-group-label { margin: 0; }
  .ctrl-orient-btn {
    padding: 5px 10px;
    background: var(--instr-bg);
    border: 1px solid var(--phosphor-dim);
    color: var(--phosphor);
    font-family: var(--font-instr);
    font-size: 9px;
    letter-spacing: 0.16em;
    text-transform: lowercase;
    cursor: pointer;
  }
  .ctrl-orient-btn:hover  { background: var(--instr-bg-2); border-color: var(--phosphor-mid); }
  .ctrl-orient-btn:active { background: var(--phosphor); color: var(--instr-bg); }
  /* Row matches main editor's .monitor-control: dim panel bg,
     hairline phosphor rule, sharp corners. */
  .ctrl-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--instr-bg-2);
    border: 1px solid var(--instr-rule);
  }
  .ctrl-row.disabled { opacity: 0.55; }
  .ctrl-id {
    font-family: var(--font-instr);
    font-size: 10px;
    letter-spacing: 0.16em;
    color: var(--phosphor-mid);
    text-transform: lowercase;
    min-width: 72px;
  }
  .ctrl-id b { color: var(--phosphor); font-weight: 400; }
  /* Slider track: thin like main, but thumb beefed up to a
     finger-sized 26x26 with phosphor fill so it's tappable. */
  .ctrl-slider-input {
    -webkit-appearance: none; appearance: none;
    width: 100%;
    height: 4px;
    background: var(--instr-bg);
    border: 1px solid var(--instr-rule);
    outline: none;
    cursor: pointer;
  }
  .ctrl-slider-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 26px; height: 26px;
    background: var(--phosphor);
    border: 1px solid var(--instr-bg);
    cursor: grab;
  }
  .ctrl-slider-input::-moz-range-thumb {
    width: 26px; height: 26px;
    background: var(--phosphor);
    border: 1px solid var(--instr-bg);
    cursor: grab;
  }
  .ctrl-val {
    font-family: var(--font-body-m);
    font-size: 11px;
    color: var(--phosphor);
    font-variant-numeric: tabular-nums;
    min-width: 64px;
    text-align: right;
  }
  /* Vertical slider mode: horizontal flex strip of fader columns,
     mixer-board layout. The slider itself is a HORIZONTAL <input>
     rotated -90deg inside a fixed-size wrap, so all the thin-track
     + 26px-thumb styles from the horizontal mode carry over
     verbatim. writing-mode-based vertical sliders are hard to
     style cross-browser; rotation Just Works. */
  .ctrl-sliders-vert {
    display: flex; gap: 8px; flex-wrap: wrap;
    align-content: flex-start;
  }
  .ctrl-row-vert {
    display: flex; flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 12px 8px;
    background: var(--instr-bg-2);
    border: 1px solid var(--instr-rule);
    min-width: 56px;
  }
  .ctrl-row-vert.disabled { opacity: 0.55; }
  /* Reuse the same .ctrl-id / .ctrl-val classes the horizontal mode
     uses so the typography is identical. Just drop the min-widths
     and center-align so they sit nicely in a narrow column. */
  .ctrl-row-vert .ctrl-id  { min-width: 0; text-align: center; }
  .ctrl-row-vert .ctrl-val { min-width: 0; text-align: center; }

  /* Rotation wrap. The wrap takes up 28x220 in the flex layout;
     the rotated <input> is absolutely positioned and centered with
     translate+rotate so the rotation origin sits at the visual
     center. Without the wrap, rotation doesn't change layout bounds
     and the slider's 220px width would push the column to 220px
     wide instead of 28px. */
  .ctrl-slider-vert-wrap {
    position: relative;
    width: 28px;
    height: 220px;
    flex: 0 0 auto;
  }
  .ctrl-slider-vert {
    -webkit-appearance: none;
    appearance: none;
    position: absolute;
    top: 50%; left: 50%;
    width: 220px;
    height: 4px;
    margin: 0;
    background: var(--instr-bg);
    border: 1px solid var(--instr-rule);
    outline: none;
    cursor: pointer;
    touch-action: none;
    /* -90 puts min at the bottom + max at the top, matching mixer
       fader convention. */
    transform: translate(-50%, -50%) rotate(-90deg);
    transform-origin: center center;
  }
  .ctrl-slider-vert::-webkit-slider-runnable-track { height: 4px; background: var(--instr-bg); }
  .ctrl-slider-vert::-moz-range-track              { height: 4px; background: var(--instr-bg); }
  .ctrl-slider-vert::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 26px; height: 26px;
    background: var(--phosphor);
    border: 1px solid var(--instr-bg);
    cursor: grab;
  }
  .ctrl-slider-vert::-moz-range-thumb {
    width: 26px; height: 26px;
    background: var(--phosphor);
    border: 1px solid var(--instr-bg);
    cursor: grab;
  }
  /* Button widget styled exactly like main's .monitor-control-button
     but larger padding for touch. */
  .ctrl-button {
    width: 100%;
    padding: 16px 14px;
    background: var(--instr-bg);
    border: 1px solid var(--phosphor-dim);
    color: var(--phosphor);
    font-family: var(--font-instr);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: lowercase;
    cursor: pointer;
    transition: background 0.08s, color 0.08s;
  }
  .ctrl-button:hover { background: var(--instr-bg-2); border-color: var(--phosphor-mid); }
  .ctrl-button:active, .ctrl-button.firing {
    background: var(--phosphor);
    color: var(--instr-bg);
  }
  /* Keyboard widget ---------------------------------------- */
  .ctrl-kb-wrap {
    flex: 0 0 auto;
    display: flex; flex-direction: column;
    background: var(--instr-bg-2);
    border: 1px solid var(--instr-rule);
    padding: 10px;
    gap: 10px;
  }
  .ctrl-kb-wrap.disabled { opacity: 0.55; }
  /* When expanded, the wrap grows to fill remaining vertical space
     in the panel so the keys themselves get taller. */
  .ctrl-kb-wrap.expanded { flex: 1 1 auto; min-height: 0; }
  .ctrl-kb-toolbar {
    display: flex; gap: 8px; align-items: center;
    font-family: var(--font-instr);
    font-size: 9px;
    letter-spacing: 0.16em;
    text-transform: lowercase;
    color: var(--text-2);
  }
  .ctrl-kb-toolbar .label { color: var(--phosphor-mid); padding: 0 4px; }
  .ctrl-kb-toolbar .label b { color: var(--phosphor); font-weight: 400; }
  .ctrl-kb-toolbar .oct-btn {
    padding: 8px 14px;
    background: var(--instr-bg);
    border: 1px solid var(--phosphor-dim);
    color: var(--phosphor);
    font-family: var(--font-instr);
    font-size: 11px;
    letter-spacing: 0.16em;
    cursor: pointer;
    transition: background 0.08s, color 0.08s;
  }
  .ctrl-kb-toolbar .oct-btn:hover  { background: var(--instr-bg-2); border-color: var(--phosphor-mid); }
  .ctrl-kb-toolbar .oct-btn:active { background: var(--phosphor); color: var(--instr-bg); }
  .ctrl-kb-toolbar .spacer { flex: 1; }
  .ctrl-kb {
    position: relative;
    flex: 1 1 auto;
    min-height: 110px;
    background: var(--instr-bg);
    border: 1px solid var(--instr-rule);
    overflow: hidden;
    touch-action: none;
    user-select: none;
  }
  .ctrl-kb-whites { position: absolute; inset: 0; display: flex; }
  /* White keys -- phosphor lab style: dark instrument bg, phosphor
     hairline border, phosphor labels. Matches the .piano-key style
     in the main editor's Monitor pane. */
  .ctrl-kb-key {
    flex: 1;
    border: none;
    border-right: 1px solid var(--instr-rule);
    background: var(--instr-bg-2);
    color: var(--phosphor-mid);
    font-family: var(--font-instr);
    font-size: 9px;
    letter-spacing: 0.14em;
    padding: 0 0 8px 0;
    display: flex; align-items: flex-end; justify-content: center;
    cursor: pointer; user-select: none; touch-action: none;
  }
  .ctrl-kb-key:last-child { border-right: none; }
  .ctrl-kb-key.held {
    background: var(--phosphor);
    color: var(--instr-bg);
  }
  .ctrl-kb-key.c-marker { color: var(--phosphor); }
  .ctrl-kb-black {
    position: absolute; top: 0;
    width: 7%; height: 65%;
    background: var(--instr-bg);
    border: 1px solid var(--phosphor-dim);
    color: var(--phosphor-mid);
    font-family: var(--font-instr);
    font-size: 9px;
    letter-spacing: 0.14em;
    padding: 0 0 6px 0;
    display: flex; align-items: flex-end; justify-content: center;
    cursor: pointer; user-select: none; touch-action: none;
  }
  .ctrl-kb-black.held {
    background: var(--phosphor);
    color: var(--instr-bg);
    border-color: var(--phosphor);
  }
</style>
</head><body>
<div class="tabs">
  <button class="tab active" data-tab="hw">✎ handwriting</button>
  <button class="tab" data-tab="ctrl">⚙ controls</button>
</div>
<div class="panel active" data-panel="hw">
  <div class="ink-wrap">
    <canvas id="ink-canvas"></canvas>
    <div class="baseline"><span class="baseline-cap l"></span><span class="baseline-cap r"></span></div>
    <div class="box-banner" id="box-banner">no box drawn on main canvas yet</div>
  </div>
  <div class="actions">
    <div class="status" id="status"><span class="conn-pip" id="conn-pip"></span>connecting…</div>
    <button class="btn" id="btn-clear">↻ Clear</button>
    <button class="btn primary" id="btn-recog">✓ Recognize</button>
  </div>
</div>
<div class="panel" data-panel="ctrl">
  <div class="ctrl-status-bar">
    <span class="ctrl-play-pip" id="ctrl-play-pip"></span>
    <span id="ctrl-play-text">Audio: stopped — start playback (▶) in the main editor for live control</span>
  </div>
  <div id="ctrl-empty" class="placeholder" style="display:none;">
    <p><strong>No controllable nodes in the patch yet.</strong></p>
    <p>Add a <code>Slider</code>, <code>Button</code>, or <code>KeyboardIn</code> node in the main editor and it will appear here.</p>
  </div>
  <div id="ctrl-list" class="ctrl-list"></div>
</div>
<script>
(function() {
  const ch = new BroadcastChannel("gamma-touchscreen");
  const canvas = document.getElementById("ink-canvas");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const pip = document.getElementById("conn-pip");
  const btnRecog = document.getElementById("btn-recog");
  const btnClear = document.getElementById("btn-clear");
  let strokes = [];
  let current = null;
  let dpr = window.devicePixelRatio || 1;

  function setStatus(text, kind) {
    statusEl.innerHTML = '<span class="conn-pip ' + (kind === "err" ? "" : "ok") + '" id="conn-pip"></span>' + text;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function resizeCanvas() {
    const r = canvas.getBoundingClientRect();
    canvas.width  = Math.round(r.width  * dpr);
    canvas.height = Math.round(r.height * dpr);
    redraw();
  }
  window.addEventListener("resize", resizeCanvas);

  function redraw() {
    ctx.fillStyle = "#161b22";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#c8e85a";
    ctx.lineWidth = 3 * dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    strokes.forEach(s => {
      if (s.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(s[0].x * dpr, s[0].y * dpr);
      for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x * dpr, s[i].y * dpr);
      ctx.stroke();
    });
  }

  function pt(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  canvas.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    current = [pt(ev)];
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!current) return;
    current.push(pt(ev));
    redraw();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(ev => {
    canvas.addEventListener(ev, () => { current = null; });
  });

  btnClear.addEventListener("click", () => { strokes = []; current = null; redraw(); setStatus("Cleared", "ok"); });

  btnRecog.addEventListener("click", () => {
    if (strokes.length === 0) { setStatus("Nothing drawn yet", "err"); return; }
    // HW.6 -- post the raw VECTOR STROKES (not a pre-rendered PNG) so the
    // main window runs them through the same recognize core as the canvas
    // pen: shape detection, the HW.4 online stroke matcher, the HW.1
    // rasterizer, OCR, and the VLM. Coords are in this canvas's CSS px;
    // the main side bounds them itself, so the coordinate origin is
    // irrelevant — only the shape matters.
    const out = strokes
      .filter(s => s.length >= 1)
      .map(s => s.map(p => ({ x: p.x, y: p.y })));
    const r = canvas.getBoundingClientRect();
    ch.postMessage({ type: "ink-strokes", strokes: out, w: r.width, h: r.height });
    setStatus("Sent to main — recognizing…", "");
    btnRecog.disabled = true;
  });

  // Tab switching. Switching to Controls triggers a fresh snapshot
  // request so the panel populates immediately on first activation
  // and re-syncs if the patch changed while the tab was hidden.
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
      document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.dataset.panel === t.dataset.tab));
      if (t.dataset.tab === "ctrl") {
        ch.postMessage({ type: "controls-request" });
      }
    });
  });

  /* ------------- Controls tab ----------------------------------
     Sliders + Buttons + KeyboardIn live driving over BroadcastChannel.
     Snapshot from main describes the patch; popup mirrors and posts
     control-* messages back. Optimistic local value display so drag
     feels instant — main re-broadcasts on each change for sync. */

  // Inline copy of the editor's slider curve math so the popup can
  // display the curve-adjusted value as the user drags, without
  // round-tripping to main for every pixel.
  const _SLIDER_CURVES = {
    linear: t => t,
    log:    t => Math.log10(1 + 9 * t),
    exp:    t => t * t,
    sCurve: t => t * t * (3 - 2 * t)
  };
  function _lutForward(t, tbl) {
    const N = tbl.length;
    if (!N) return t;
    const fi = Math.max(0, Math.min(1, t)) * (N - 1);
    const i0 = Math.floor(fi), i1 = Math.min(N - 1, i0 + 1);
    return tbl[i0] * (1 - (fi - i0)) + tbl[i1] * (fi - i0);
  }
  function _sliderValueFromT(t, min, max, curve, tbl) {
    let mapped;
    if (curve === "custom" && Array.isArray(tbl) && tbl.length) {
      mapped = _lutForward(t, tbl);
    } else {
      const fn = _SLIDER_CURVES[curve] || _SLIDER_CURVES.linear;
      mapped = fn(Math.max(0, Math.min(1, t)));
    }
    return min + (max - min) * mapped;
  }
  function _sliderTFromValueLinearApprox(v, min, max) {
    if (max <= min) return 0;
    return Math.max(0, Math.min(1, (v - min) / (max - min)));
  }
  // Inverse-curve mapping for seeding the thumb position from a known
  // value. Bisection-based so it works for any monotonic curve incl.
  // custom LUTs (with the same closest-point approximation main uses).
  function _sliderTFromValue(v, min, max, curve, tbl) {
    const y = _sliderTFromValueLinearApprox(v, min, max);
    if (curve === "linear" || max <= min) return y;
    if (curve === "custom" && Array.isArray(tbl) && tbl.length) {
      let bestT = 0, bestDist = Infinity;
      for (let i = 0; i < tbl.length; i++) {
        const d = Math.abs(tbl[i] - y);
        if (d < bestDist) { bestDist = d; bestT = i / (tbl.length - 1); }
      }
      return bestT;
    }
    // Bisection on the forward curve.
    let lo = 0, hi = 1;
    const fwd = _SLIDER_CURVES[curve] || _SLIDER_CURVES.linear;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fwd(mid) < y) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Compact value formatter; mirrors main's monitor-controls behavior
  // (digits scale with range so a 0..1 slider shows 3 decimals and
  // a 80..12000 slider shows 0).
  function _fmtVal(v, min, max) {
    const span = Math.max(1e-9, max - min);
    const digits = Math.max(0, Math.ceil(-Math.log10(span / 1000)));
    return Number(v).toFixed(Math.min(6, digits));
  }

  const ctrlList    = document.getElementById("ctrl-list");
  const ctrlEmpty   = document.getElementById("ctrl-empty");
  const ctrlPlayPip = document.getElementById("ctrl-play-pip");
  const ctrlPlayTxt = document.getElementById("ctrl-play-text");

  // Most recent snapshot, kept so we can re-render on octave change
  // without round-tripping to main. Initialized empty so the keyboard
  // widget can compute its layout before the first snapshot arrives.
  let _lastSnap = { sliders: [], buttons: [], keyboard: { present: false }, octaveShift: 0, playing: false };

  // Per-octave white-key MIDI offsets (C major: 0,2,4,5,7,9,11). Black
  // keys (C#,D#,F#,G#,A#) sit between specific white pairs -- after
  // white index 0,1,3,4,5 within each octave.
  const _WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
  const _BLACK_PCS = [1, 3, 6, 8, 10];
  const _BLACK_AFTER_WHITE_IDX = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
  // QWERTY mirror so we can render the QWERTY letter on the matching
  // keys when the popup's octave aligns with main's kbOctaveShift.
  const _QWERTY_BY_MIDI_PC = {
    0: "a", 2: "s", 4: "d", 5: "f", 7: "g", 9: "h", 11: "j",
    1: "w", 3: "e", 6: "t", 8: "y", 10: "u"
  };
  const _QWERTY_BY_MIDI_PC_UPPER = {
    0: "k", 2: "l", 4: ";",
    1: "o", 3: "p"
  };

  function _midiName(midi) {
    const NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const oct = Math.floor(midi / 12) - 1;
    return NAMES[((midi % 12) + 12) % 12] + oct;
  }

  // Octave count persisted across popup reloads via localStorage.
  // Defaults to 2 octaves which fits comfortably on a typical
  // touchscreen secondary monitor (iPad mini class).
  function _loadKbOctaves() {
    try {
      const raw = parseInt(localStorage.getItem("gamma-touch-kb-octaves"), 10);
      if (raw >= 1 && raw <= 6) return raw;
    } catch (_) {}
    return 2;
  }
  let _kbOctaves = _loadKbOctaves();
  function _saveKbOctaves(n) {
    _kbOctaves = Math.max(1, Math.min(6, n | 0));
    try { localStorage.setItem("gamma-touch-kb-octaves", String(_kbOctaves)); } catch (_) {}
  }

  // Vertical height of the keyboard wrap (px). Persisted so the
  // user's preferred size survives reload. Clamped to a band that
  // keeps it usable on small touchscreens and avoids eating the
  // sliders/buttons list above on tall ones (ctrl-list scrolls).
  const _KB_HEIGHT_MIN = 140;
  const _KB_HEIGHT_MAX = 700;
  const _KB_HEIGHT_STEP = 60;
  function _loadKbHeight() {
    try {
      const raw = parseInt(localStorage.getItem("gamma-touch-kb-height"), 10);
      if (raw >= _KB_HEIGHT_MIN && raw <= _KB_HEIGHT_MAX) return raw;
    } catch (_) {}
    return 220;
  }
  let _kbHeight = _loadKbHeight();
  function _saveKbHeight(px) {
    _kbHeight = Math.max(_KB_HEIGHT_MIN, Math.min(_KB_HEIGHT_MAX, px | 0));
    try { localStorage.setItem("gamma-touch-kb-height", String(_kbHeight)); } catch (_) {}
  }

  // Slider orientation -- horizontal (default) or vertical mixer-fader
  // style. Persisted to localStorage.
  function _loadVertSliders() {
    try { return localStorage.getItem("gamma-touch-vert-sliders") === "1"; }
    catch (_) { return false; }
  }
  let _vertSliders = _loadVertSliders();
  function _saveVertSliders(v) {
    _vertSliders = !!v;
    try { localStorage.setItem("gamma-touch-vert-sliders", _vertSliders ? "1" : "0"); } catch (_) {}
  }

  // Cached refs for in-place updates. Set by _rebuildControls,
  // read by _updateControlsInPlace. Without this cache, every
  // snapshot from main blew away the slider DOM mid-drag and the
  // user's pointer capture broke.
  let _rowRefs = null;
  let _lastSig = "";

  // Per-slider drag state. The slider's pointerdown sets a flag the
  // snapshot-handler checks before overwriting the thumb position --
  // prevents the popup from fighting the user's own finger.
  const _sliderDragging = new Set();

  /* Top-level render: decide whether to do an in-place update or a
   * full rebuild based on structural signature. Same set of nodes +
   * same orientation -> in-place; anything else -> rebuild. */
  function renderControls(snap) {
    _lastSnap = snap;
    const playing = !!snap.playing;
    ctrlPlayPip.classList.toggle("playing", playing);
    ctrlPlayTxt.textContent = playing
      ? "audio: playing — controls are live"
      : "audio: stopped — start playback (▶) in the main editor for live control";

    const hasAny = (snap.sliders && snap.sliders.length)
                 || (snap.buttons && snap.buttons.length)
                 || (snap.keyboard && snap.keyboard.present);
    ctrlEmpty.style.display = hasAny ? "none" : "block";
    if (!hasAny) {
      ctrlList.innerHTML = "";
      _rowRefs = null; _lastSig = "";
      return;
    }
    const sig = _snapshotSignature(snap);
    if (sig === _lastSig && _rowRefs) {
      _updateControlsInPlace(snap, playing);
    } else {
      _rebuildControls(snap, playing);
      _lastSig = sig;
    }
  }

  // Structural fingerprint: which nodes are present, in what
  // categories, with which orientation. Excludes the live VALUE
  // of any slider so per-frame value drift doesn't bust the cache.
  function _snapshotSignature(snap) {
    const sl = (snap.sliders || []).map(s => s.id).join(",");
    const bt = (snap.buttons || []).map(b => b.id).join(",");
    const kb = snap.keyboard && snap.keyboard.present ? "kb" : "";
    const v  = _vertSliders ? "v" : "h";
    return sl + "|" + bt + "|" + kb + "|" + v;
  }

  function _rebuildControls(snap, playing) {
    ctrlList.innerHTML = "";
    _rowRefs = { sliders: new Map(), buttons: new Map(), keyboardWrap: null };

    // Order: keyboard first (most spatial / most-touched), then
    // buttons (transient triggers), then sliders (continuous params
    // that can sit at the bottom in vertical-mixer mode).
    if (snap.keyboard && snap.keyboard.present) {
      const label = document.createElement("div");
      label.className = "ctrl-group-label";
      label.textContent = "keyboard";
      ctrlList.appendChild(label);
      const kbWrap = _buildKeyboardWidget(snap.octaveShift || 0, playing);
      kbWrap.dataset.shift = String(snap.octaveShift || 0);
      ctrlList.appendChild(kbWrap);
      _rowRefs.keyboardWrap = kbWrap;
    }

    if (snap.buttons && snap.buttons.length) {
      const label = document.createElement("div");
      label.className = "ctrl-group-label";
      label.textContent = "buttons";
      ctrlList.appendChild(label);
      snap.buttons.forEach(b => {
        const row = _buildButtonRow(b, playing);
        ctrlList.appendChild(row);
        _rowRefs.buttons.set(b.id, { row });
      });
    }

    if (snap.sliders && snap.sliders.length) {
      // Section header has a toggle button to flip orientation.
      const header = document.createElement("div");
      header.className = "ctrl-sliders-header";
      const label = document.createElement("div");
      label.className = "ctrl-group-label";
      label.textContent = "sliders";
      const orientBtn = document.createElement("button");
      orientBtn.className = "ctrl-orient-btn";
      orientBtn.textContent = _vertSliders ? "═ horizontal" : "▮ vertical";
      orientBtn.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        _saveVertSliders(!_vertSliders);
        // Rebuild because the layout container differs.
        _lastSig = "";
        renderControls(_lastSnap);
      });
      header.appendChild(label);
      header.appendChild(orientBtn);
      ctrlList.appendChild(header);

      if (_vertSliders) {
        const grid = document.createElement("div");
        grid.className = "ctrl-sliders-vert";
        snap.sliders.forEach(s => {
          const row = _buildSliderRowVert(s, playing);
          grid.appendChild(row.el);
          _rowRefs.sliders.set(s.id, row);
        });
        ctrlList.appendChild(grid);
      } else {
        snap.sliders.forEach(s => {
          const row = _buildSliderRow(s, playing);
          ctrlList.appendChild(row.el);
          _rowRefs.sliders.set(s.id, row);
        });
      }
    }
  }

  /* In-place update path. Avoids rebuilding the DOM so the user's
   * active drag stays attached to its <input>. Skip any slider
   * currently being dragged (the user's finger is authoritative). */
  function _updateControlsInPlace(snap, playing) {
    // Slider values
    (snap.sliders || []).forEach(s => {
      const ref = _rowRefs.sliders.get(s.id);
      if (!ref) return;
      // Track range/curve in case main editor changed them.
      ref.s = s;
      ref.el.classList.toggle("disabled", !playing);
      if (_sliderDragging.has(s.id)) return;
      const t = _sliderTFromValue(s.value, s.min, s.max, s.curve, s.curveTable);
      ref.input.value = String(t);
      ref.val.textContent = _fmtVal(s.value, s.min, s.max);
    });
    // Buttons: just keep disabled state in sync.
    (snap.buttons || []).forEach(b => {
      const ref = _rowRefs.buttons.get(b.id);
      if (ref && ref.row) ref.row.classList.toggle("disabled", !playing);
    });
    // Keyboard: if octave shift changed, swap the whole widget --
    // cheap rebuild that doesn't touch the slider DOM.
    const kbWrap = _rowRefs.keyboardWrap;
    if (kbWrap && snap.keyboard && snap.keyboard.present) {
      const wantShift = String(snap.octaveShift || 0);
      if (kbWrap.dataset.shift !== wantShift) {
        const newKb = _buildKeyboardWidget(snap.octaveShift || 0, playing);
        newKb.dataset.shift = wantShift;
        kbWrap.replaceWith(newKb);
        _rowRefs.keyboardWrap = newKb;
      } else {
        kbWrap.classList.toggle("disabled", !playing);
      }
    }
  }

  /* Horizontal slider row (default). Returns { el, input, val, s }
   * so the in-place updater can mutate value/thumb without rebuild. */
  function _buildSliderRow(s, playing) {
    const el = document.createElement("div");
    el.className = "ctrl-row" + (playing ? "" : " disabled");
    const t = _sliderTFromValue(s.value, s.min, s.max, s.curve, s.curveTable);
    el.innerHTML =
      '<span class="ctrl-id">sld <b>' + s.id + '</b></span>' +
      '<input class="ctrl-slider-input" type="range" min="0" max="1" step="0.001" value="' + t + '" />' +
      '<span class="ctrl-val">' + _fmtVal(s.value, s.min, s.max) + '</span>';
    const input = el.querySelector(".ctrl-slider-input");
    const val   = el.querySelector(".ctrl-val");
    _wireSliderInput(input, val, s);
    return { el, input, val, s };
  }

  /* Vertical (mixer-fader) slider column. Same data, different
   * stacking: id on top, rotated horizontal slider in middle, value
   * at bottom. The rotation wrap pins the column width to 28px;
   * without it the 220px-wide pre-rotation input would push the
   * column out to 220px. */
  function _buildSliderRowVert(s, playing) {
    const el = document.createElement("div");
    el.className = "ctrl-row-vert" + (playing ? "" : " disabled");
    const t = _sliderTFromValue(s.value, s.min, s.max, s.curve, s.curveTable);
    el.innerHTML =
      '<span class="ctrl-id">sld <b>' + s.id + '</b></span>' +
      '<div class="ctrl-slider-vert-wrap">' +
        '<input class="ctrl-slider-vert" type="range" min="0" max="1" step="0.001" value="' + t + '" />' +
      '</div>' +
      '<span class="ctrl-val">' + _fmtVal(s.value, s.min, s.max) + '</span>';
    const input = el.querySelector(".ctrl-slider-vert");
    const val   = el.querySelector(".ctrl-val");
    _wireSliderInput(input, val, s);
    return { el, input, val, s };
  }

  /* Shared listener wiring -- same logic for horizontal + vertical.
   * pointerdown / pointerup track the drag state so snapshot updates
   * skip this slider while the user holds it. */
  function _wireSliderInput(input, val, s) {
    input.addEventListener("input", () => {
      const tt = Number(input.value);
      // Look up the LATEST range/curve from _rowRefs (main editor
      // might have changed min/max via the curve modal while popup
      // was open).
      const ref = _rowRefs && _rowRefs.sliders.get(s.id);
      const cur = ref && ref.s ? ref.s : s;
      const v = _sliderValueFromT(tt, cur.min, cur.max, cur.curve, cur.curveTable);
      val.textContent = _fmtVal(v, cur.min, cur.max);
      ch.postMessage({ type: "control-slider", id: s.id, t: tt });
    });
    // Drag-lock: prevents the in-place updater from stomping the
    // thumb mid-drag. Bound to pointer events (covers touch + mouse).
    input.addEventListener("pointerdown", () => { _sliderDragging.add(s.id); });
    // Use window for pointerup -- the pointer might leave the input
    // before being released, especially on vertical sliders where
    // the cursor can wander off the narrow column.
    const onUp = () => { _sliderDragging.delete(s.id); };
    input.addEventListener("pointerup",     onUp);
    input.addEventListener("pointercancel", onUp);
    input.addEventListener("lostpointercapture", onUp);
    // Final safety net: window pointerup catches the case where the
    // pointer was released way outside the input.
    window.addEventListener("pointerup", onUp);
  }

  function _buildButtonRow(b, playing) {
    const row = document.createElement("div");
    row.className = "ctrl-row" + (playing ? "" : " disabled");
    row.innerHTML =
      '<span class="ctrl-id">btn <b>' + b.id + '</b></span>' +
      '<button class="ctrl-button">' + (b.label || "press") + '</button>';
    const btn = row.querySelector(".ctrl-button");
    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ch.postMessage({ type: "control-button", id: b.id });
      btn.classList.add("firing");
      setTimeout(() => btn.classList.remove("firing"), 80);
    });
    return row;
  }

  /* Multi-octave touch keyboard. Layout:
   *   Base MIDI = 60 (C4) + octaveShift (12 * shift-octaves from main editor)
   *   Width = _kbOctaves * 7 white keys laid out across the full width.
   *   Black keys absolutely positioned over the white-key gaps.
   *
   * Each key carries a data-midi attribute; we send MIDI note numbers
   * over the channel so the popup can address ANY note on the keyboard,
   * not just the ones in QWERTY_TO_MIDI. The main editor has a
   * playKeyboardMidi() helper that mirrors playKeyboardNote but takes
   * MIDI directly. QWERTY-mapped notes additionally show their letter
   * on the key so the user can match what main's keyboard handles. */
  function _buildKeyboardWidget(octaveShift, playing) {
    const wrap = document.createElement("div");
    wrap.className = "ctrl-kb-wrap" + (playing ? "" : " disabled");
    // Explicit vertical size, user-adjustable via the +/- height
    // buttons. Drag-resize would be nicer but is finicky on touch.
    wrap.style.flex   = "0 0 auto";
    wrap.style.height = _kbHeight + "px";

    const toolbar = document.createElement("div");
    toolbar.className = "ctrl-kb-toolbar";
    // Octave-shift label + buttons -- mirror main editor's Z/X.
    const octLabel = document.createElement("span");
    octLabel.className = "label";
    const shiftOct = (octaveShift === 0 ? "0" : (octaveShift > 0 ? "+" : "") + (octaveShift / 12));
    octLabel.innerHTML = "octave <b>" + shiftOct + "</b>";
    const octDown = document.createElement("button");
    octDown.className = "oct-btn";
    octDown.textContent = "−12";
    octDown.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ch.postMessage({ type: "control-octave", delta: -12 });
    });
    const octUp = document.createElement("button");
    octUp.className = "oct-btn";
    octUp.textContent = "+12";
    octUp.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ch.postMessage({ type: "control-octave", delta: +12 });
    });

    const spacer = document.createElement("span");
    spacer.className = "spacer";

    // Octave-count label + shrink/grow buttons. Drives how many
    // octaves are visible; persisted to localStorage so the choice
    // survives popup reload.
    const octsLabel = document.createElement("span");
    octsLabel.className = "label";
    octsLabel.innerHTML = "range <b>" + _kbOctaves + "</b> oct";
    const shrinkBtn = document.createElement("button");
    shrinkBtn.className = "oct-btn";
    shrinkBtn.textContent = "−";
    shrinkBtn.disabled = (_kbOctaves <= 1);
    shrinkBtn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      if (_kbOctaves <= 1) return;
      _saveKbOctaves(_kbOctaves - 1);
      renderControls(_lastSnap);
    });
    const growBtn = document.createElement("button");
    growBtn.className = "oct-btn";
    growBtn.textContent = "+";
    growBtn.disabled = (_kbOctaves >= 6);
    growBtn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      if (_kbOctaves >= 6) return;
      _saveKbOctaves(_kbOctaves + 1);
      renderControls(_lastSnap);
    });

    // Height (vertical) shrink/grow. Uses the same pattern as the
    // octave-count buttons. Bumps in _KB_HEIGHT_STEP increments and
    // re-renders so the change applies immediately.
    const heightLabel = document.createElement("span");
    heightLabel.className = "label";
    heightLabel.innerHTML = "size <b>" + _kbHeight + "</b>px";
    const heightDown = document.createElement("button");
    heightDown.className = "oct-btn";
    heightDown.textContent = "▼";
    heightDown.title = "Shrink keyboard";
    heightDown.disabled = (_kbHeight <= _KB_HEIGHT_MIN);
    heightDown.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      if (_kbHeight <= _KB_HEIGHT_MIN) return;
      _saveKbHeight(_kbHeight - _KB_HEIGHT_STEP);
      renderControls(_lastSnap);
    });
    const heightUp = document.createElement("button");
    heightUp.className = "oct-btn";
    heightUp.textContent = "▲";
    heightUp.title = "Grow keyboard";
    heightUp.disabled = (_kbHeight >= _KB_HEIGHT_MAX);
    heightUp.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      if (_kbHeight >= _KB_HEIGHT_MAX) return;
      _saveKbHeight(_kbHeight + _KB_HEIGHT_STEP);
      renderControls(_lastSnap);
    });

    toolbar.appendChild(octLabel);
    toolbar.appendChild(octDown);
    toolbar.appendChild(octUp);
    toolbar.appendChild(spacer);
    toolbar.appendChild(octsLabel);
    toolbar.appendChild(shrinkBtn);
    toolbar.appendChild(growBtn);
    toolbar.appendChild(heightLabel);
    toolbar.appendChild(heightDown);
    toolbar.appendChild(heightUp);
    wrap.appendChild(toolbar);

    const board = document.createElement("div");
    board.className = "ctrl-kb";

    // Base MIDI -- where the leftmost C lands. main's kbOctaveShift
    // shifts in 12-semitone steps so this stays whole-octave aligned.
    const baseMidi = 60 + octaveShift;
    const whiteCount = _kbOctaves * 7;
    // QWERTY letters only apply to the kbOctaveShift octave's keys --
    // outside that we leave the QWERTY letter blank. The main editor
    // pins QWERTY to ONE octave (the kbOctaveShift one), so showing
    // QWERTY letters on every octave would be misleading.
    const qwertyOctaveIdx = 0; // base octave on the popup matches main's kbOctaveShift

    const whites = document.createElement("div");
    whites.className = "ctrl-kb-whites";
    for (let i = 0; i < whiteCount; i++) {
      const oct = (i / 7) | 0;
      const pc = _WHITE_PCS[i % 7];
      const midi = baseMidi + oct * 12 + pc;
      const key = document.createElement("button");
      key.className = "ctrl-kb-key" + (pc === 0 ? " c-marker" : "");
      key.dataset.midi = String(midi);
      // C keys show their note name (orientation cue). Others show
      // QWERTY letter if applicable, else nothing.
      let label = "";
      if (pc === 0) {
        label = _midiName(midi);
      } else if (oct === qwertyOctaveIdx && _QWERTY_BY_MIDI_PC[pc]) {
        label = _QWERTY_BY_MIDI_PC[pc].toUpperCase();
      } else if (oct === qwertyOctaveIdx + 1 && _QWERTY_BY_MIDI_PC_UPPER[pc]) {
        label = _QWERTY_BY_MIDI_PC_UPPER[pc].toUpperCase();
      }
      key.textContent = label;
      whites.appendChild(key);
    }
    board.appendChild(whites);

    // Black keys: position by relative offset into the strip.
    // Each white key is (100 / whiteCount)% wide; black key sits
    // centered on the gap between white index 'idx' and 'idx+1',
    // with width slightly less than one white.
    const blackWidthPct = (100 / whiteCount) * 0.65;
    for (let oct = 0; oct < _kbOctaves; oct++) {
      _BLACK_PCS.forEach(pc => {
        const afterIdx = _BLACK_AFTER_WHITE_IDX[pc] + oct * 7;
        const midi = baseMidi + oct * 12 + pc;
        const key = document.createElement("button");
        key.className = "ctrl-kb-black";
        key.dataset.midi = String(midi);
        // Center on white-key boundary.
        const centerPct = (afterIdx + 1) * (100 / whiteCount);
        key.style.left  = (centerPct - blackWidthPct / 2) + "%";
        key.style.width = blackWidthPct + "%";
        if (oct === qwertyOctaveIdx && _QWERTY_BY_MIDI_PC[pc]) {
          key.textContent = _QWERTY_BY_MIDI_PC[pc].toUpperCase();
        } else if (oct === qwertyOctaveIdx + 1 && _QWERTY_BY_MIDI_PC_UPPER[pc]) {
          key.textContent = _QWERTY_BY_MIDI_PC_UPPER[pc].toUpperCase();
        } else {
          key.textContent = "";
        }
        board.appendChild(key);
      });
    }

    // Pointer routing: per-pointer state so polyphony works (two
    // fingers = two simultaneous notes) AND the keyboard doesn't
    // interfere with concurrent slider drags (each pointerId is
    // captured separately by the element it landed on).
    // heldByPointer: pointerId -> midi note. Glissando: when a
    // finger slides to a new key, release the prior note for THAT
    // finger only and press the new one. Other fingers stay held.
    const heldByPointer = new Map();
    function _keyAt(ev) {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!el || !el.dataset || !el.dataset.midi) return null;
      if (!board.contains(el)) return null;
      return el;
    }
    function _midiHeldByOther(midi, ownPid) {
      for (const [pid, m] of heldByPointer) {
        if (pid !== ownPid && m === midi) return true;
      }
      return false;
    }
    function _press(pid, el) {
      if (!el) return;
      const midi = Number(el.dataset.midi);
      const prev = heldByPointer.get(pid);
      if (prev === midi) return;
      if (prev != null) {
        // Glissando: release the prior note for THIS finger only.
        // Keep the highlight if another finger is also on it.
        if (!_midiHeldByOther(prev, pid)) {
          const prevEl = board.querySelector('[data-midi="' + prev + '"]');
          if (prevEl) prevEl.classList.remove("held");
        }
        ch.postMessage({ type: "control-key-up", midi: prev });
      }
      heldByPointer.set(pid, midi);
      el.classList.add("held");
      ch.postMessage({ type: "control-key-down", midi });
    }
    function _release(pid) {
      const midi = heldByPointer.get(pid);
      if (midi == null) return;
      heldByPointer.delete(pid);
      if (!_midiHeldByOther(midi, pid)) {
        const el = board.querySelector('[data-midi="' + midi + '"]');
        if (el) el.classList.remove("held");
      }
      ch.postMessage({ type: "control-key-up", midi });
    }
    board.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      board.setPointerCapture(ev.pointerId);
      _press(ev.pointerId, _keyAt(ev));
    });
    board.addEventListener("pointermove", (ev) => {
      if (!heldByPointer.has(ev.pointerId)) return;
      const el = _keyAt(ev);
      if (el) _press(ev.pointerId, el);
    });
    board.addEventListener("pointerup",     (ev) => _release(ev.pointerId));
    board.addEventListener("pointercancel", (ev) => _release(ev.pointerId));
    board.addEventListener("lostpointercapture", (ev) => _release(ev.pointerId));

    wrap.appendChild(board);
    return wrap;
  }

  const banner = document.getElementById("box-banner");
  let hasBox = false;
  function setBoxState(boxMsg) {
    if (boxMsg && typeof boxMsg.w === "number" && typeof boxMsg.h === "number") {
      hasBox = true;
      banner.textContent = "box ready — " + Math.round(boxMsg.w) + "×" + Math.round(boxMsg.h) + " · write here";
      banner.classList.add("has-box");
      banner.style.display = "block";
    } else {
      hasBox = false;
      banner.textContent = "no box on main canvas — draw one with the ✎ tool (D)";
      banner.classList.remove("has-box");
      banner.style.display = "block";
    }
  }

  // Main -> popup messages.
  ch.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === "ink-ack") {
      btnRecog.disabled = false;
      if (msg.ok) {
        setStatus("✓ created node: " + msg.note, "ok");
        strokes = []; current = null; redraw();
      } else {
        setStatus("✗ " + (msg.note || "recognize failed"), "err");
      }
    } else if (msg.type === "box-update") {
      setBoxState(msg);
    } else if (msg.type === "box-clear") {
      setBoxState(null);
    } else if (msg.type === "controls-snapshot") {
      renderControls(msg);
    } else if (msg.type === "ping") {
      ch.postMessage({ type: "pong" });
    }
  };

  // Heartbeat to main so it knows we're alive. Also request an initial
  // controls snapshot so the panel populates even if the user opens
  // the Controls tab before the first patch mutation.
  ch.postMessage({ type: "pong" });
  ch.postMessage({ type: "controls-request" });
  setStatus("Connected — write a node name above the line, then ✓ Recognize", "ok");
  setBoxState(null);
  requestAnimationFrame(resizeCanvas);

  // HW.6 -- re-handshake whenever the popup regains focus (the user
  // switching back to it, e.g. after toggling tools in the main editor).
  // Re-pong so main re-broadcasts box state + the controls snapshot,
  // re-request controls, and un-stick the Recognize button — so the
  // popup never needs a close/reopen to re-sync.
  function _reHandshake() {
    try {
      ch.postMessage({ type: "pong" });
      ch.postMessage({ type: "controls-request" });
    } catch (_) {}
    if (btnRecog) btnRecog.disabled = false;
  }
  window.addEventListener("focus", _reHandshake);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) _reHandshake(); });
})();
<\/script>
</body></html>`;
}

function clearInk() {
  inkBox = null;
  inkStrokes = [];
  inkCurrent = null;
  drawingBox = false;
  boxStart = null;
  inkFinalize.style.display = "none";
  if (typeof _hwrClearChips === "function") _hwrClearChips();   // HW.5 -- drop any open correction chips
  renderInk();
  // Sprint 5.handwriting-multimonitor -- tell any open touchscreen
  // popup the box is gone, so it can show "draw a box first" status.
  if (_touchChannel) {
    try { _touchChannel.postMessage({ type: "box-clear" }); } catch (_) {}
  }
}

function renderInk() {
  let html = "";
  if (inkBox) {
    html += `<rect x="${inkBox.x}" y="${inkBox.y}" width="${inkBox.w}" height="${inkBox.h}"
      fill="rgba(200,232,90,0.04)" stroke="var(--accent)" stroke-width="1.5"
      stroke-dasharray="6,4" rx="3" />`;
  }
  inkStrokes.forEach(s => {
    if (s.length < 2) return;
    const d = "M " + s.map(p => `${p.x},${p.y}`).join(" L ");
    html += `<path d="${d}" fill="none" stroke="var(--text)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
  });
  if (inkCurrent && inkCurrent.length >= 2) {
    const d = "M " + inkCurrent.map(p => `${p.x},${p.y}`).join(" L ");
    html += `<path d="${d}" fill="none" stroke="var(--text)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
  }
  ink.innerHTML = html;

  if (inkBox) {
    inkFinalize.style.display = "flex";
    inkFinalize.style.left = (inkBox.x + inkBox.w + 6) + "px";
    inkFinalize.style.top  = inkBox.y + "px";
  } else {
    inkFinalize.style.display = "none";
  }
}

// Ink-layer pointer handling. The ink layer captures pointer events when
// in draw mode OR when a pen is in use, intercepting before the canvas
// nodes-and-wires logic runs.
function inkPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function isPenOrDrawMode(e) {
  return currentTool === "draw" || (e.pointerType === "pen");
}

ink.addEventListener("pointerdown", e => {
  if (!isPenOrDrawMode(e)) return;
  e.preventDefault();
  ink.setPointerCapture(e.pointerId);
  const p = inkPoint(e);
  if (!inkBox) {
    drawingBox = true;
    boxStart = p;
    inkBox = { x: p.x, y: p.y, w: 0, h: 0 };
  } else {
    // Inside an existing box: collect a stroke
    inkCurrent = [p];
    _hwrClearChips();   // HW.5 -- resuming drawing dismisses stale chips
  }
  renderInk();
});

ink.addEventListener("pointermove", e => {
  if (!isPenOrDrawMode(e)) return;
  const p = inkPoint(e);
  if (drawingBox && boxStart) {
    inkBox.x = Math.min(boxStart.x, p.x);
    inkBox.y = Math.min(boxStart.y, p.y);
    inkBox.w = Math.abs(p.x - boxStart.x);
    inkBox.h = Math.abs(p.y - boxStart.y);
    renderInk();
  } else if (inkCurrent) {
    inkCurrent.push(p);
    renderInk();
  }
});

ink.addEventListener("pointerup", e => {
  if (!isPenOrDrawMode(e)) return;
  if (drawingBox) {
    drawingBox = false;
    boxStart = null;
    // Reject tiny boxes (probably a misclick)
    if (inkBox.w < 30 || inkBox.h < 24) {
      clearInk();
    } else {
      renderInk();
      // Sprint 5.handwriting-multimonitor -- broadcast the drawn box
      // to any open touchscreen popup. The popup's status line
      // updates to "Box ready — write here" so the user knows the
      // touchscreen surface is now bound to a real placement target.
      if (_touchChannel) {
        try {
          _touchChannel.postMessage({
            type: "box-update",
            w: inkBox.w, h: inkBox.h
          });
        } catch (_) {}
      }
    }
  } else if (inkCurrent) {
    if (inkCurrent.length > 1) inkStrokes.push(inkCurrent);
    inkCurrent = null;
    renderInk();
  }
});

document.getElementById("btn-ink-cancel").addEventListener("click", clearInk);
document.getElementById("btn-ink-clear").addEventListener("click", () => {
  // Keep the box, drop the strokes — lets the user redo handwriting
  // without re-drawing the bounding rectangle.
  inkStrokes = [];
  _hwrClearChips();   // HW.5 -- drop stale correction chips on Redo
  renderInk();
});

/* HW.5 -- below this VLM-classify confidence we don't auto-spawn; we
 * offer the top candidates as chips instead. */
const HWR_CHIP_CONF = 0.7;

/* Top-N node types by edit distance to a (possibly messy) transcription.
 * Used to populate correction chips when there's no confident match. */
function _hwrCandidatesFromText(text, n) {
  const clean = String(text || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (clean.length < 2) return [];
  return Object.keys(TYPES)
    .map(t => ({ t, d: levenshtein(clean, t.toLowerCase()) }))
    .sort((a, b) => a.d - b.d || a.t.length - b.t.length)
    .slice(0, n).map(x => x.t);
}

/* Build the candidate list for a low-confidence classify result: the
 * model's best guess + alternates (each resolved to a real node type),
 * padded with fuzzy matches from the transcription. Deduped, max 4. */
function _hwrBuildCandidates(result, fallbackText) {
  const out = [];
  const add = (raw) => { const t = _matchTypeName(raw); if (t && !out.includes(t)) out.push(t); };
  if (result && result.name) add(result.name);
  for (const a of (result && result.alternates || [])) add(a);
  if (out.length < 3) {
    for (const c of _hwrCandidatesFromText((result && result.text) || fallbackText, 4)) {
      if (!out.includes(c)) out.push(c);
    }
  }
  return out.slice(0, 4);
}

function _hwrClearChips() { const el = document.getElementById("hwr-chips"); if (el) el.remove(); }

/* HW.5 -- render the top candidates as clickable chips near the ink box
 * when recognition is uncertain. Tapping one spawns that node at the box
 * AND learns the strokes as a template for it (the accepted correction
 * teaches the HW.4 recognizer the user's hand). Canvas-only; positioned
 * in the same canvas-pixel space the ink-finalize buttons use. */
function _showHwrChips(candidates, box, strokes) {
  _hwrClearChips();
  if (!candidates || !candidates.length) return;
  const wrap = document.createElement("div");
  wrap.id = "hwr-chips";
  wrap.style.cssText = "position:absolute; z-index:60; left:" + Math.round(box.x) + "px; top:" +
    Math.round(box.y + box.h + 8) + "px; display:flex; flex-wrap:wrap; gap:6px; max-width:340px;" +
    "background:rgba(12,14,18,0.96); border:1px solid var(--accent,#c8e85a); border-radius:6px; padding:8px;";
  const hint = document.createElement("div");
  hint.textContent = "Did you mean…";
  hint.style.cssText = "width:100%; font:10px/1.3 monospace; color:#9bd0ff; opacity:0.85; margin-bottom:2px;";
  wrap.appendChild(hint);
  for (const name of candidates) {
    const b = document.createElement("button");
    b.textContent = name;
    b.style.cssText = "font:12px monospace; color:#eafff0; background:#1a2230; border:1px solid #2c3a4a;" +
      "border-radius:4px; padding:4px 9px; cursor:pointer;";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      pushHistory("hwr:add");
      const id = makeNode(name, Math.round(box.x), Math.round(box.y));
      if (id) selectOne(id);
      _hwrLearnTemplate(name, strokes);   // HW.5 → HW.4: accepted correction becomes a template
      render();
      setVoiceStatus("✓ " + name, "");
      setTimeout(() => setVoiceStatus("", ""), 1800);
      clearInk();   // also clears chips (clearInk calls _hwrClearChips)
    });
    wrap.appendChild(b);
  }
  const x = document.createElement("button");
  x.textContent = "✕";
  x.title = "Dismiss — keep the box to Redo";
  x.style.cssText = "font:12px monospace; color:#bbb; background:transparent; border:1px solid #2c3a4a;" +
    "border-radius:4px; padding:4px 8px; cursor:pointer;";
  x.addEventListener("click", (e) => { e.stopPropagation(); _hwrClearChips(); });
  wrap.appendChild(x);
  (document.getElementById("canvas") || document.body).appendChild(wrap);
}

/* HW.6 -- shared recognize core for BOTH the canvas pen and the
 * touchscreen popup. Runs the full cascade on a set of vector strokes
 * placed at `box`: shape gesture → HW.4 online stroke-template match →
 * image OCR (Tesseract, HW.1/HW.2) → VLM (HW.3), with auto-learn from the
 * confident tiers. Spawns the matched node and returns
 * { matched, lastReply, learnedHand } — or, when uncertain and
 * opts.allowChips is set, defers with { deferred:true, candidates } so the
 * caller can show HW.5 correction chips. `key` is the resolved provider
 * key (the callers do the provider-availability checks). */
async function _recognizeInkStrokes(strokes, box, key, opts) {
  opts = opts || {};
  // Shape-first — clean circle → Button, line(+handle) → Slider.
  const shape = detectShape(strokes, box);
  if (shape) {
    console.log("[hwr] shape detected:", shape);
    pushHistory("hwr:add");
    const id = makeNode(shape, Math.round(box.x), Math.round(box.y));
    if (id) selectOne(id);
    render();
    return { matched: shape, lastReply: "" };
  }
  // HW.4 -- online stroke-template match. Disabled by default behind
  // _hwrStrokeMatchOn — see the menu toggle. The chamfer-distance metric
  // on resampled point clouds isn't discriminating enough for word-shaped
  // handwriting, so one bad template can match everything until the
  // matcher is redesigned.
  if (typeof _hwrStrokeMatchOn !== "undefined" && _hwrStrokeMatchOn) {
    const hit = _hwrStrokeRecognize(strokes);
    if (hit && hit.dist <= HWR_MATCH_THRESHOLD && TYPES[hit.name]) {
      console.log("[hwr] stroke match:", hit.name, "dist=" + hit.dist.toFixed(3));
      pushHistory("hwr:add");
      const id = makeNode(hit.name, Math.round(box.x), Math.round(box.y));
      if (id) selectOne(id);
      _hwrLearnTemplate(hit.name, strokes);
      render();
      return { matched: hit.name, lastReply: "", learnedHand: true };
    }
  }
  // Image cascade (HW.1 raster → Tesseract → VLM).
  const { dataUrl, base64 } = strokesToPng(box, strokes);
  _showHwrDebugImage(dataUrl);
  let matched = null, lastReply = "";
  try {
    const { text: ocrText, confidence: ocrConf } = await tesseractRecognize(dataUrl);
    lastReply = ocrText;
    console.log("[hwr] tesseract reply:", JSON.stringify(ocrText), "conf=" + Math.round(ocrConf));
    if (ocrText && !_looksLikeChain(ocrText) && ocrConf >= HWR_OCR_CONF_FLOOR) {
      matched = tryCreateFromLabel(ocrText, box, /*silent*/ true);
      // HW.4 auto-learn — only when the stroke matcher is opted in AND
      // the OCR confidence is very high (>=80), so a borderline read
      // can't seed a sticky template.
      if (typeof _hwrStrokeMatchOn !== "undefined" && _hwrStrokeMatchOn
          && matched && TYPES[matched] && ocrConf >= 80) {
        _hwrLearnTemplate(matched, strokes);
      }
    } else if (ocrText) {
      console.log("[hwr] routing to VLM (" + (_looksLikeChain(ocrText) ? "looks like a chain" : "low conf") + ")");
    }
  } catch (err) {
    console.warn("[hwr] tesseract failed, will try AI fallback:", err);
  }
  if (!matched) {
    if (aiSettings.provider === "gemma") {
      setGemmaProgressHook((p) => {
        const pct = p.progress != null ? Math.round(p.progress * 100) : 0;
        setVoiceStatus((p.file || p.status || "loading model…") + " (" + pct + "%)", "thinking");
      });
    }
    try {
      setVoiceStatus("Reading with " + aiSettings.provider + "…", "thinking");
      const result = await callVision(base64, key);
      lastReply = result.raw || result.text || "";
      console.log("[hwr] ai-vision result:", JSON.stringify(result));
      if (Array.isArray(result.chain) && result.chain.length >= 2) {
        // Chains always spawn directly — no chips.
        matched = tryCreateFromLabel(result.chain.join(" | "), box, /*silent*/ false);
      } else {
        const conf = (result.mode === "classify" && Number.isFinite(result.confidence)) ? result.confidence : 1.0;
        // HW.5 -- a low-confidence classify defers to correction chips
        // (the caller renders them) instead of spawning a shaky guess.
        if (opts.allowChips && conf < HWR_CHIP_CONF) {
          const cands = _hwrBuildCandidates(result, lastReply);
          if (cands.length) { setGemmaProgressHook(null); return { matched: null, lastReply, deferred: true, candidates: cands }; }
        }
        matched = _applyVisionResult(result, box, /*silent*/ false);
        // HW.4 auto-learn from a confident classify — only when the stroke
        // matcher is opted in AND Claude is very sure (>=0.85, was 0.7).
        if (typeof _hwrStrokeMatchOn !== "undefined" && _hwrStrokeMatchOn
            && matched && TYPES[matched]
            && _lastHwrCandidates && _lastHwrCandidates.confidence >= 0.85) {
          _hwrLearnTemplate(matched, strokes);
        }
      }
    } catch (err) {
      console.error("[hwr] ai-vision failed:", err);
      setVoiceStatus("Recognize failed: " + (err.message || err) + " · OCR returned “" + (lastReply || "").trim().slice(0, 30) + "”", "err");
    } finally {
      setGemmaProgressHook(null);
    }
  }
  // HW.5 -- nothing matched: offer fuzzy candidates as chips rather than a
  // bare error (canvas only). Skip when the reply was structured JSON.
  if (!matched && opts.allowChips && lastReply && !lastReply.includes("{")) {
    const cands = _hwrCandidatesFromText(lastReply, 4);
    if (cands.length) return { matched: null, lastReply, deferred: true, candidates: cands };
  }
  return { matched, lastReply };
}

document.getElementById("btn-ink-go").addEventListener("click", async () => {
  if (!inkBox) return;
  const provider = PROVIDERS[aiSettings.provider];

  if (!provider.supportsImage) {
    setVoiceStatus("Provider doesn't support images — switch to Gemma 4 or Anthropic in ⚙ AI settings.", "err");
    return;
  }
  let key = "";
  if (provider.requiresKey) {
    key = aiSettings.anthropicKey;
    if (!key) {
      setVoiceStatus("No Anthropic API key set — click ⚙ in the User DSP tab.", "err");
      return;
    }
  }
  if (aiSettings.provider === "gemma" && !setupGemmaAvailable()) {
    setVoiceStatus("WebGPU not available — Gemma 4 needs Chrome/Edge or recent Safari. Or set an Anthropic key.", "err");
    return;
  }

  // No strokes? Treat as a placeholder; just ask user for label inline.
  if (!inkStrokes.length) {
    const label = prompt("What node type should this box represent?");
    if (label) tryCreateFromLabel(label, inkBox);
    clearInk();
    return;
  }

  setVoiceStatus("Recognizing handwriting…", "thinking");
  console.log("[hwr] strokes=" + inkStrokes.length + " provider=" + aiSettings.provider + " model=" + (aiSettings.model || provider.defaultModel));
  const rr = await _recognizeInkStrokes(inkStrokes, inkBox, key, { allowChips: true });
  if (rr.deferred && rr.candidates && rr.candidates.length) {
    // HW.5 -- uncertain: keep the box + strokes and offer correction
    // chips. A chip tap spawns + learns + clears; ✕ / Redo dismisses.
    _showHwrChips(rr.candidates, inkBox, inkStrokes);
    setVoiceStatus("Not sure — pick the node below, or ↻ Redo.", "");
    return;
  }
  if (rr.matched) {
    setVoiceStatus(rr.learnedHand ? ("✓ " + rr.matched + " (learned hand)")
                                  : ("✓ matched “" + rr.matched + "”"), "");
    setTimeout(() => setVoiceStatus("", ""), 2400);
  }
  clearInk();
});

/* Tesseract.js OCR — primary handwriting / printed-text path. Loaded
 * lazily on first recognize click. ~5 MB total (lib + eng traineddata),
 * cached aggressively by the browser after the first call. Runs on the
 * CPU via WASM; no WebGPU, no API key, no AI provider required. */
let tesseractWorker = null;
let tesseractLoading = null;
async function getTesseract() {
  if (tesseractWorker) return tesseractWorker;
  if (tesseractLoading) return tesseractLoading;
  tesseractLoading = (async () => {
    const mod = await import("https://cdn.jsdelivr.net/npm/tesseract.js@5/+esm");
    const createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
    if (typeof createWorker !== "function") {
      throw new Error("tesseract.js loaded but createWorker not found");
    }
    const w = await createWorker("eng", 1, {
      logger: m => {
        if (m && m.status === "recognizing text") {
          setVoiceStatus(`OCR ${Math.round((m.progress || 0) * 100)}%`, "thinking");
        }
      }
    });
    // Restrict the recognized character set + treat the image as
    // a single text line. Whitelist nudges tesseract toward better
    // accuracy on short labels like "AD", "Sine", "LFO" by
    // disqualifying ambiguous glyph picks. The `|` + `>` are
    // included so chain-separator syntax like "sine | AD" gets
    // through OCR; the chain handler in tryCreateFromLabel splits
    // on them.
    //
    // 5.handwriting-chain -- PSM_SINGLE_LINE (7) instead of
    // PSM_SINGLE_WORD (8). Single-word mode treats the entire image
    // as one token + drops separator characters; single-line
    // preserves spaces + punctuation, which we need for the chain.
    // Short single-word labels still recognize fine (PSM 7 doesn't
    // require multi-word input).
    await w.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789|>",
      tessedit_pageseg_mode: "7"   // PSM_SINGLE_LINE
    });
    tesseractWorker = w;
    return w;
  })();
  try { return await tesseractLoading; }
  finally { tesseractLoading = null; }
}
async function tesseractRecognize(dataUrl) {
  const w = await getTesseract();
  const { data } = await w.recognize(dataUrl);
  return {
    text: (data && data.text || "").trim(),
    confidence: (data && typeof data.confidence === "number") ? data.confidence : 0
  };
}

// HW.2 -- below this Tesseract confidence (0-100) we don't trust an OCR
// read and route to the VLM instead of spawning a fuzzy guess.
const HWR_OCR_CONF_FLOOR = 65;

/* HW.1/HW.2 -- normalize every chain-separator variant to a canonical
 * " | ". Tesseract misreads the pipe as I/l/1//\ ; VLMs emit →, >, ->.
 * A lone I/l/1 wedged between two word chars (with spaces) is almost
 * always a misread pipe; slashes/backslashes never appear in node names
 * so they're always separators. Shared by the chain pre-check and the
 * matcher so both split identically. */
function _normalizeChainSeparators(s) {
  return String(s || "")
    .replace(/\s*(?:->|=>|→|>)\s*/g, " | ")
    .replace(/\s*[\/\\]\s*/g, " | ")
    .replace(/(?<=\w)\s+[Il1]\s+(?=\w)/g, " | ")
    .replace(/\s*\|\s*/g, " | ")
    .trim();
}
function _looksLikeChain(text) {
  return _normalizeChainSeparators(text)
    .split(" | ").map(s => s.trim()).filter(Boolean).length >= 2;
}

/* ===== HW.4 -- online (stroke-based) recognition ==========================
 * The pen strokes carry far more signal than a rasterized image. This is a
 * $P-style point-cloud matcher over a user-grown template library: it
 * resamples the live strokes into a normalized point cloud and compares it
 * (translation/scale invariant, stroke-order/direction invariant) against
 * templates the user has written before. Runs as an early tier in the
 * recognize cascade — on a confident match it spawns instantly, offline, no
 * model; otherwise it falls through to Tesseract / the VLM. Confident reads
 * from those slower tiers are fed back as templates (auto-learn), so the
 * recognizer personalizes to the user's hand the more it's used.
 * Canvas-only: the touchscreen popup posts an image, not strokes. */
const HWR_TPL_KEY = "gamma-hwr-templates-v1";
const HWR_PCLOUD_N = 48;            // point-cloud resample resolution
const HWR_MATCH_THRESHOLD = 0.06;   // normalized chamfer dist below which a template is trusted (tightened from 0.10 — chamfer over-matches on word-shaped clouds)
const HWR_TPL_PER_NAME = 6;         // keep the most recent N samples per node name
let _hwrTemplates = {};             // { name: [ { pts:[{x,y}...] }, ... ] }
try { _hwrTemplates = JSON.parse(localStorage.getItem(HWR_TPL_KEY) || "{}") || {}; } catch (_) { _hwrTemplates = {}; }
function _hwrSaveTemplates() { try { localStorage.setItem(HWR_TPL_KEY, JSON.stringify(_hwrTemplates)); } catch (_) {} }
function _hwrTemplateCount() { return Object.values(_hwrTemplates).reduce((a, arr) => a + arr.length, 0); }

// Canonical $1/$P single-stroke resample to n equidistant points.
function _resampleStroke(s, n) {
  if (s.length < 2 || n < 2) return s.map(p => ({ x: p.x, y: p.y }));
  const pts = s.map(p => ({ x: p.x, y: p.y }));
  let I = 0;
  for (let i = 1; i < pts.length; i++) I += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  I /= (n - 1);
  if (I <= 1e-9) return [{ x: pts[0].x, y: pts[0].y }];
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let D = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (D + d >= I) {
      const t = (I - D) / d;
      const q = { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y) };
      out.push(q);
      pts.splice(i, 0, q);   // continue resampling from the inserted point
      D = 0;
    } else { D += d; }
  }
  while (out.length < n) out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
  return out;
}
// Resample all strokes to ~N points total (per-stroke by length), kept as a
// cloud — strokes are NOT joined, so there are no phantom gap segments.
function _pResample(strokes, n) {
  const lens = strokes.map(s => { let L = 0; for (let i = 1; i < s.length; i++) L += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y); return L; });
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const pts = [];
  for (let si = 0; si < strokes.length; si++) {
    if (!strokes[si] || strokes[si].length === 0) continue;
    const want = Math.max(2, Math.round(n * lens[si] / total));
    for (const p of _resampleStroke(strokes[si], want)) pts.push(p);
  }
  return pts;
}
// Scale to a unit box (by the larger dimension, preserving aspect) + center
// the centroid at origin → translation- and scale-invariant.
function _pNormalize(pts) {
  if (!pts.length) return pts;
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const p of pts) { if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x; if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y; }
  const scale = 1 / Math.max(mxx - mnx, mxy - mny, 1e-6);
  const out = pts.map(p => ({ x: p.x * scale, y: p.y * scale }));
  let cx = 0, cy = 0;
  for (const p of out) { cx += p.x; cy += p.y; }
  cx /= out.length; cy /= out.length;
  for (const p of out) { p.x -= cx; p.y -= cy; }
  return out;
}
function _pCloudFromStrokes(strokes) { return _pNormalize(_pResample(strokes, HWR_PCLOUD_N)); }
// Symmetric average-nearest-neighbour (chamfer) distance between two clouds.
function _pCloudDistance(a, b) {
  const half = (X, Y) => {
    let sum = 0;
    for (const p of X) {
      let best = Infinity;
      for (const q of Y) { const dx = p.x - q.x, dy = p.y - q.y, d = dx * dx + dy * dy; if (d < best) best = d; }
      sum += Math.sqrt(best);
    }
    return sum / X.length;
  };
  return 0.5 * (half(a, b) + half(b, a));
}
// Best template match for the current strokes → { name, dist } or null.
function _hwrStrokeRecognize(strokes) {
  if (!strokes || strokes.length === 0) return null;
  const names = Object.keys(_hwrTemplates);
  if (!names.length) return null;
  const cloud = _pCloudFromStrokes(strokes);
  if (cloud.length < 4) return null;
  let bestName = null, bestDist = Infinity;
  for (const name of names) {
    for (const tpl of _hwrTemplates[name]) {
      const d = _pCloudDistance(cloud, tpl.pts);
      if (d < bestDist) { bestDist = d; bestName = name; }
    }
  }
  return bestName ? { name: bestName, dist: bestDist } : null;
}
// Store the current strokes as a template for `name` (auto-learn). Only
// learns valid node types (so a hallucinated / typo'd name can't pollute
// the library) and caps the per-name samples, keeping the most recent.
function _hwrLearnTemplate(name, strokes) {
  if (!name || !TYPES[name] || !strokes || strokes.length === 0) return;
  const cloud = _pCloudFromStrokes(strokes);
  if (cloud.length < 4) return;
  if (!_hwrTemplates[name]) _hwrTemplates[name] = [];
  _hwrTemplates[name].push({ pts: cloud });
  if (_hwrTemplates[name].length > HWR_TPL_PER_NAME) _hwrTemplates[name] = _hwrTemplates[name].slice(-HWR_TPL_PER_NAME);
  _hwrSaveTemplates();
}

/* HW.1 -- estimate the writing's slant (horizontal shift per unit of
 * vertical travel) from near-vertical stroke segments. dx·sign(dy) is
 * sign-consistent whether a stroke is traced up or down, so up/down
 * strokes of the same slanted letterform reinforce instead of cancel.
 * Returns a clamped slope, or 0 when the hand is near-upright. */
function _estimateInkSlant(strokes) {
  let num = 0, den = 0, n = 0;
  for (const s of strokes) {
    for (let i = 1; i < s.length; i++) {
      const dx = s[i].x - s[i - 1].x;
      const dy = s[i].y - s[i - 1].y;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 1) {
        num += dx * Math.sign(dy);
        den += Math.abs(dy);
        n++;
      }
    }
  }
  if (n < 6 || den < 1) return 0;
  const slope = num / den;
  if (Math.abs(slope) < 0.12) return 0;            // ignore negligible slant
  return Math.max(-0.5, Math.min(0.5, slope));     // clamp to avoid over-shear
}

function strokesToPng(box, strokes) {
  // HW.1 -- rasterize the ACTUAL ink, not the drawn box. The box is only
  // a placement target; writing routinely overshoots it, and the old
  // box-sized raster clipped those overshoots off-canvas (offsetting by
  // box.x/box.y with only 32px padding) — which made even strong VLMs
  // misread half-cropped words. We bound the union of every stroke
  // point, deslant italic hands upright, normalize to a fixed letter
  // height (so size is consistent no matter how big/small they wrote),
  // and centre it on a padded paper-white field.
  // Returns { dataUrl, base64 }.
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity, nPts = 0;
  for (const s of strokes) {
    for (const p of s) {
      if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
      if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
      nPts++;
    }
  }
  if (!nPts || !isFinite(mnx)) {        // degenerate -- fall back to the box
    mnx = box.x; mny = box.y; mxx = box.x + box.w; mxy = box.y + box.h;
  }
  const inkW = Math.max(1, mxx - mnx);
  const inkH = Math.max(1, mxy - mny);
  const slant = _estimateInkSlant(strokes);

  // Ink-local point map: lx = x-mnx, ly = y-mny; deslant shears x by
  // -slant·ly so a slanted line becomes vertical. Find the deslanted
  // x-extent over the four corners so we can offset it back to >= 0.
  const sxAt = (lx, ly) => lx - slant * ly;
  let sxMin = Infinity, sxMax = -Infinity;
  for (const c of [[0, 0], [0, inkH], [inkW, 0], [inkW, inkH]]) {
    const v = sxAt(c[0], c[1]);
    if (v < sxMin) sxMin = v; if (v > sxMax) sxMax = v;
  }
  const deskewW = Math.max(1, sxMax - sxMin);

  const TARGET_H = 256;       // fixed rendered letter height
  const pad = 40;
  const maxW = 2048;
  let scale = TARGET_H / inkH;
  // Keep the (uniform) scale from producing an over-wide image on long
  // words — shrink to fit maxW rather than clipping.
  if (deskewW * scale + pad * 2 > maxW) scale = (maxW - pad * 2) / deskewW;
  const W = Math.ceil(deskewW * scale) + pad * 2;
  const H = Math.ceil(inkH * scale) + pad * 2;

  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  // Slight off-white reads as "paper" to vision models; pure white can
  // trip false-blank UNKNOWNs on small models.
  ctx.fillStyle = "#fdfdfd";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#0a0a0a";
  // Stroke weight tracks the rendered letter height (not the raw box) so
  // ink always reads as bold pen — narrow enough to keep "L"/"I"
  // distinct, fat enough that loops in 'e'/'a'/'o' stay closed.
  ctx.lineWidth = Math.max(5, 0.045 * inkH * scale);   // ~4.5% of rendered letter height
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const mapX = (x, y) => (sxAt(x - mnx, y - mny) - sxMin) * scale + pad;
  const mapY = (y) => (y - mny) * scale + pad;
  for (const s of strokes) {
    if (s.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(mapX(s[0].x, s[0].y), mapY(s[0].y));
    for (let i = 1; i < s.length; i++) ctx.lineTo(mapX(s[i].x, s[i].y), mapY(s[i].y));
    ctx.stroke();
  }
  const dataUrl = cv.toDataURL("image/png");
  return { dataUrl, base64: dataUrl.split(",")[1] };
}

/* HW.3 -- unified vision call. Returns a NORMALIZED result object
 * (see _applyVisionResult) regardless of provider:
 *   { mode, name, confidence, alternates, chain, text, raw }
 *
 * Two strategies, picked by provider capability:
 *   - goodClassifier providers (Claude): CONSTRAINED CLASSIFICATION.
 *     The model reads the ink AND snaps it to the node vocabulary,
 *     returning the best match + a confidence + top alternates as JSON.
 *     A strong VLM is a far better constrained classifier than the
 *     downstream fuzzy matcher, and the alternates feed HW.5's
 *     correction chips.
 *   - everyone else (Gemma, small VLMs): plain chain-aware
 *     TRANSCRIPTION. Small VLMs are unreliable classifiers over a
 *     200-item list (they hallucinate near-matches / punt to UNKNOWN),
 *     so we let them read and offload categorization to the matcher. */
async function callVision(pngBase64, key) {
  const provider = PROVIDERS[aiSettings.provider];
  const nodeList = Object.keys(TYPES).sort().join(", ");

  if (provider.goodClassifier) {
    const sys =
`You read short handwriting on a small canvas (white background, black ink) and map it to an audio DSP node from a fixed list.

Return ONLY a JSON object — no prose, no markdown, no code fence. Use exactly one of these shapes:
- single node: {"text":"<exactly what is written>","name":"<exact node name from the list, or null>","confidence":<0..1>,"alternates":["<2nd plausible>","<3rd plausible>"]}
- a chain (several names written left-to-right separated by "|" or an arrow → / >): {"chain":["<name1>","<name2>", ...]}
- unreadable: {"text":"","name":null,"confidence":0,"alternates":[]}

IMPORTANT:
- Only set "name" when the handwriting CLEARLY reads as one of the listed node names. If you're not sure, return name:null with confidence 0 — the system has a UI to suggest alternates, so guessing is worse than admitting uncertainty.
- Calibrate "confidence" honestly: use >=0.9 only when you're nearly certain; 0.5–0.8 when the writing is partially legible; below 0.4 when it's a guess.
- Do NOT default to alphabetically-early names (e.g. "AutomationLane", "AD") when the writing is ambiguous — those become a sticky failure mode. Return null instead.

Node names — use this exact CamelCase spelling (e.g. "MultibandComp", "KeyboardIn", "Sine"):
${nodeList}`;
    const raw = await provider.call({
      system: sys, user: "Classify the handwriting as JSON:",
      model: aiSettings.model, key, image: pngBase64,
      temperature: 0, maxTokens: 256
    });
    return _parseVisionJson(raw);
  }

  // Transcription path (Gemma + any non-classifier provider).
  const sys =
`You read short handwriting on a small canvas (white background, black ink). It is EITHER one node name, OR several node names written left-to-right separated by a vertical bar "|" (or an arrow → / >).

Reply with ONLY the word(s). If there are multiple, output them in left-to-right order separated by " | " (e.g. "KeyboardIn | Sine | AD | Mul | Output"). No preamble, no explanation, no quotes, no punctuation other than the "|" separators.

If a word resembles one of these audio DSP node names, prefer that exact spelling (the names use CamelCase, e.g. "MultibandComp" not "multiband comp", "KeyboardIn" not "keyboardin"):
${nodeList}

If you genuinely can't read it, reply: UNKNOWN`;
  const raw = await provider.call({
    system: sys, user: "Transcribe the handwriting:",
    model: aiSettings.model, key, image: pngBase64,
    temperature: 0, maxTokens: 128
  });
  return { mode: "transcribe", text: String(raw || ""), raw: String(raw || ""), name: null, confidence: 0, alternates: [], chain: null };
}

/* Parse a classifier provider's JSON reply into the normalized result
 * shape. Tolerant of code fences + surrounding prose; on any parse
 * failure, falls back to treating the raw text as a transcription. */
function _parseVisionJson(raw) {
  const out = { mode: "classify", raw: String(raw || ""), name: null, confidence: 0, alternates: [], chain: null, text: "" };
  try {
    let s = String(raw || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "");
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) { out.text = s; return out; }
    const o = JSON.parse(m[0]);
    if (Array.isArray(o.chain)) out.chain = o.chain.map(x => String(x || "").trim()).filter(Boolean);
    if (typeof o.name === "string" && !/^null$/i.test(o.name)) out.name = o.name.trim();
    if (typeof o.text === "string") out.text = o.text.trim();
    if (Number.isFinite(o.confidence)) out.confidence = Math.max(0, Math.min(1, o.confidence));
    if (Array.isArray(o.alternates)) out.alternates = o.alternates.map(x => String(x || "").trim()).filter(Boolean);
  } catch (_) {
    out.text = String(raw || "").trim();
  }
  return out;
}

/* HW.3 -- act on a normalized vision result. Chain → spawn + auto-wire;
 * a classified name → spawn it (snapped to the vocabulary), stashing the
 * confidence + alternates for HW.5's correction chips; otherwise fall
 * back to fuzzy-matching the raw transcription. Returns the matched type
 * name or null. */
let _lastHwrCandidates = null;   // { name, alternates, confidence } -- consumed by HW.5
function _applyVisionResult(result, box, silent) {
  _lastHwrCandidates = null;
  if (!result) return null;
  if (Array.isArray(result.chain) && result.chain.length >= 2) {
    return tryCreateFromLabel(result.chain.join(" | "), box, silent);
  }
  if (result.name && /\S/.test(result.name)) {
    _lastHwrCandidates = { name: result.name, alternates: result.alternates || [], confidence: result.confidence || 0 };
    const m = tryCreateFromLabel(result.name, box, /*silent*/ true);
    if (m) {
      if (result.confidence && result.confidence < 0.55 && result.alternates.length) {
        console.log("[hwr] low-confidence classify (" + result.confidence.toFixed(2) + "); alternates:", result.alternates);
      }
      return m;
    }
  }
  return tryCreateFromLabel(result.text || result.raw || "", box, silent);
}

/* Shape-detection heuristics. Returns "Button" for a closed roundish
 * single stroke, "Slider" for a horizontal line + a small closed shape
 * (or just a long horizontal line). Returns null otherwise so the
 * recognize path falls through to OCR + AI vision.
 *
 * "Closed" = endpoint within 30% of bounding-box diagonal of the start.
 * "Line"   = aspect > 2.5 and width spans most of the ink box. */
function detectShape(strokes, box) {
  if (!strokes || !strokes.length) return null;
  function bbox(s) {
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    s.forEach(p => {
      if (p.x < mnx) mnx = p.x;
      if (p.x > mxx) mxx = p.x;
      if (p.y < mny) mny = p.y;
      if (p.y > mxy) mxy = p.y;
    });
    return { w: mxx - mnx, h: mxy - mny };
  }
  function isClosed(s) {
    if (s.length < 4) return false;
    const a = s[0], b = s[s.length - 1];
    const { w, h } = bbox(s);
    const diag = Math.hypot(w, h);
    if (diag < 8) return false;
    return Math.hypot(a.x - b.x, a.y - b.y) / diag < 0.30;
  }
  function isLine(s) {
    if (s.length < 2) return false;
    const { w, h } = bbox(s);
    return w > Math.max(h, 1) * 2.5 && w > box.w * 0.4;
  }

  if (strokes.length === 1) {
    const s = strokes[0];
    const { w, h } = bbox(s);
    const aspect = w / Math.max(h, 1);
    const closed = isClosed(s);
    // Circle / rounded loop → Button.
    if (closed && aspect > 0.55 && aspect < 1.8 && w > 12 && h > 12) return "Button";
    // Long horizontal line → Slider.
    if (!closed && isLine(s)) return "Slider";
    return null;
  }

  // Two or more strokes. Slider pattern: at least one line + at least
  // one small closed shape (the thumb / handle box).
  const lines  = strokes.filter(isLine);
  const closed = strokes.filter(isClosed);
  if (lines.length >= 1 && closed.length >= 1) return "Slider";
  // Two closed roundish strokes can also read as Button (e.g. user
  // double-traced a circle). Fall back to Button if the union bbox
  // is roughly square and every stroke is closed.
  if (closed.length === strokes.length && closed.length > 0) {
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    strokes.forEach(s => s.forEach(p => {
      if (p.x < mnx) mnx = p.x;
      if (p.x > mxx) mxx = p.x;
      if (p.y < mny) mny = p.y;
      if (p.y > mxy) mxy = p.y;
    }));
    const aspect = (mxx - mnx) / Math.max(mxy - mny, 1);
    if (aspect > 0.55 && aspect < 1.8) return "Button";
  }
  return null;
}

// Standard 2-row Levenshtein. O(n*m) time, O(min(n,m)) memory.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur  = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/* Sprint 5.handwriting-chain -- spawn one node per token from a
 * pipe-separated handwriting label (e.g. "sine | AD" -> two
 * nodes). Each token recurses through tryCreateFromLabel with
 * silent=true; if ALL tokens match a node type, they spawn side-
 * by-side AND auto-wire (output of N -> first compatible input
 * of N+1). If any token fails, nothing spawns -- partial chains
 * are confusing. */
function _tryCreateChain(parts, box, silent) {
  // Per-token horizontal offset between the spawned nodes. Larger
  // than the typical node width so they don't overlap; small
  // enough that 3-4 nodes fit in a normal viewport.
  const HORIZ_GAP = 200;
  const matches = [];
  const ids = [];
  // Test-spawn first to catch any unmatched token BEFORE we commit
  // to spawning anything. Per-token recursion happens twice (once
  // to validate, once to spawn) -- cheap, no GPU work, just TYPES
  // lookup + string matching.
  const dryRun = parts.map(part => _matchTypeName(part));
  if (dryRun.some(d => !d)) {
    const bad = parts[dryRun.findIndex(d => !d)];
    if (!silent) setVoiceStatus("Chain: \"" + bad + "\" didn't match any node type", "err");
    return null;
  }
  // All good -- spawn each at an offset and collect ids for wiring.
  pushHistory("hwr:add-chain");
  for (let i = 0; i < parts.length; i++) {
    const subBox = { x: box.x + i * HORIZ_GAP, y: box.y, w: box.w, h: box.h };
    const before = state.nodes.length;
    const m = tryCreateFromLabel(parts[i], subBox, /*silent*/ true);
    if (!m) {
      if (!silent) setVoiceStatus("Chain: \"" + parts[i] + "\" failed on second pass", "err");
      return null;
    }
    matches.push(m);
    // Capture every node just appended (usually one, but stay
    // defensive in case a token expands via some future path).
    for (let k = before; k < state.nodes.length; k++) {
      ids.push(state.nodes[k].id);
    }
  }
  // Auto-wire adjacent pairs.
  const wiredCount = _autoWireSequential(ids);
  if (ids.length) selectOne(ids[ids.length - 1]);
  render();
  const sep = (wiredCount > 0) ? " → " : " + ";
  return matches.join(sep);
}

/* Sprint 5.smart-link -- the first shared piece of smart-linking
 * infra. Given an array of node IDs in left-to-right order, walks
 * adjacent pairs and creates one edge per pair: from the first
 * unwired output of the left node to the first compatible unwired
 * input of the right node. Returns the count of edges actually
 * added so callers can adjust their status message.
 *
 * Match priority:
 *   1. Exact type match (audio -> audio, gate -> gate, mesh ->
 *      mesh, camera -> camera, etc.). Picks the "obvious"
 *      connection first -- a sine into a filter lands on the
 *      filter's audio input, NOT on its freq param.
 *   2. Cross-signal compatibility via portsCompatible. Catches
 *      audio -> param, audio -> gate, clock -> param, etc. when
 *      no exact-type pair is available.
 *
 * Skips inputs that are already wired so it doesn't stomp manual
 * edges. Visual-type ports (mesh / camera / light / texture /
 * environment / transform) are strict-same-type per the editor's
 * existing connection legality rules, so they fall through Pass 1
 * naturally without needing special-case logic.
 *
 * Reused by handwriting chains (this sprint), multi-select auto-
 * connect (next), and the AI patch-completion button (later). */
function _autoWireSequential(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length < 2) return 0;
  if (!Array.isArray(state.edges)) state.edges = [];
  let added = 0;
  const inputIsWired = (nodeId, portName) =>
    state.edges.some(e =>
      e && e.to && e.to.node === nodeId && e.to.port === portName);
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    const src = state.nodes.find(n => n && n.id === nodeIds[i]);
    const dst = state.nodes.find(n => n && n.id === nodeIds[i + 1]);
    if (!src || !dst) continue;
    const srcDef = TYPES[src.type];
    const dstDef = TYPES[dst.type];
    if (!srcDef || !dstDef) continue;
    const souts = Array.isArray(srcDef.outs) ? srcDef.outs : [];
    const dins  = Array.isArray(dstDef.ins)  ? dstDef.ins  : [];
    let edge = null;
    // Pass 1: exact-type match.
    for (const sout of souts) {
      for (const din of dins) {
        if (sout.t === din.t && !inputIsWired(dst.id, din.n)) {
          edge = { fromPort: sout.n, toPort: din.n };
          break;
        }
      }
      if (edge) break;
    }
    // Pass 2: cross-signal compatibility (audio -> param etc.).
    if (!edge) {
      for (const sout of souts) {
        for (const din of dins) {
          if (portsCompatible(sout.t, din.t) && !inputIsWired(dst.id, din.n)) {
            edge = { fromPort: sout.n, toPort: din.n };
            break;
          }
        }
        if (edge) break;
      }
    }
    if (edge) {
      state.edges.push({
        from: { node: src.id, port: edge.fromPort },
        to:   { node: dst.id, port: edge.toPort }
      });
      added++;
    }
  }
  return added;
}

/* Sprint 5.smart-link.multi-select -- W keybind / canvas-tools
 * menu item entry point.
 *
 * Uses _autoConnectMulti rather than _autoWireSequential because
 * jumbled selections (e.g. {Sine, Output, Box, Scene, VisualOutput}
 * dropped in random X order) don't form an adjacent-pair chain --
 * they're several typed chains sharing one selection. The multi-
 * variant walks ALL rightward pairs and prefers exact-type matches
 * anywhere in the rightward neighborhood, falling back to cross-
 * signal coercion only when no exact match exists. Strict-adjacent
 * with cross-signal fallback (the handwriting-chain behavior) lands
 * Sine.out -> Box.width because Box happens to sit next to Sine. */
function _autoConnectSelection() {
  if (!selectedSet || selectedSet.size < 2) {
    setVoiceStatus("Select 2+ nodes to auto-wire", "err");
    setTimeout(() => setVoiceStatus("", ""), 2000);
    return 0;
  }
  const nodes = [...selectedSet]
    .map(id => state.nodes.find(n => n && n.id === id))
    .filter(Boolean);
  if (nodes.length < 2) {
    setVoiceStatus("Selection has fewer than 2 valid nodes", "err");
    return 0;
  }
  nodes.sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const sortedIds = nodes.map(n => n.id);
  pushHistory("multi-select:auto-wire");
  const added = _autoConnectMulti(sortedIds);
  if (added > 0) {
    setVoiceStatus("Auto-wired " + added + " edge(s) across " + sortedIds.length + " nodes", "");
    setTimeout(() => setVoiceStatus("", ""), 2200);
  } else {
    setVoiceStatus("No compatible port pairs found in selection", "err");
    setTimeout(() => setVoiceStatus("", ""), 2200);
  }
  render();
  return added;
}

/* Sprint 5.smart-link.multi-select-fix1 -- type-driven, non-
 * adjacent auto-wire for jumbled selections.
 *
 * Why a separate function from _autoWireSequential:
 *   _autoWireSequential walks STRICT adjacent X-pairs with cross-
 *   signal fallback. That's correct for "sine | filter | AD" (the
 *   user gave us explicit order). For multi-select, the user
 *   shift-clicked a bunch of nodes; X-order is whatever happens to
 *   match their layout. Strict-adjacent + cross-signal lands
 *   Sine.out on Box.width because audio is signal-compatible with
 *   param and Box sits next to Sine. Wrong.
 *
 * Algorithm:
 *   Pass 1 -- exact-type matches.
 *     For each source node (in X order), for each output port,
 *     find the FIRST rightward node with an EXACT-type compatible
 *     input port not already wired. Wire it. One edge per output
 *     port. Skips over nodes that don't match -- so Sine's audio
 *     out jumps over Box to reach Output's audio in.
 *
 *   Pass 2 -- cross-signal fallback for ORPHAN outputs.
 *     Outputs that didn't connect in Pass 1 get a cross-signal
 *     attempt (audio -> param, clock -> param, etc.). Only fires
 *     when no exact match was available rightward, so it can't
 *     stomp the right answer.
 *
 * Returns count of edges added. */
function _autoConnectMulti(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length < 2) return 0;
  if (!Array.isArray(state.edges)) state.edges = [];
  const nodes = nodeIds
    .map(id => state.nodes.find(n => n && n.id === id))
    .filter(Boolean);
  if (nodes.length < 2) return 0;
  let added = 0;
  const inputIsWired = (nodeId, portName) =>
    state.edges.some(e =>
      e && e.to && e.to.node === nodeId && e.to.port === portName);
  // Track outputs connected in Pass 1; Pass 2 only attempts the
  // orphans (key = "<srcId>:<outPortName>").
  const wiredOutputs = new Set();

  // --- Pass 1: exact-type matches ---
  for (let i = 0; i < nodes.length; i++) {
    const src = nodes[i];
    const srcDef = TYPES[src.type];
    if (!srcDef || !Array.isArray(srcDef.outs)) continue;
    for (const sout of srcDef.outs) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dst = nodes[j];
        const dstDef = TYPES[dst.type];
        if (!dstDef || !Array.isArray(dstDef.ins)) continue;
        let matched = null;
        for (const din of dstDef.ins) {
          if (din.t === sout.t && !inputIsWired(dst.id, din.n)) {
            matched = din;
            break;
          }
        }
        if (matched) {
          state.edges.push({
            from: { node: src.id, port: sout.n },
            to:   { node: dst.id, port: matched.n }
          });
          wiredOutputs.add(src.id + ":" + sout.n);
          added++;
          break; // one wire per output; move to next output port
        }
      }
    }
  }

  // --- Pass 2: cross-signal coercion for outputs still orphaned ---
  for (let i = 0; i < nodes.length; i++) {
    const src = nodes[i];
    const srcDef = TYPES[src.type];
    if (!srcDef || !Array.isArray(srcDef.outs)) continue;
    for (const sout of srcDef.outs) {
      if (wiredOutputs.has(src.id + ":" + sout.n)) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        const dst = nodes[j];
        const dstDef = TYPES[dst.type];
        if (!dstDef || !Array.isArray(dstDef.ins)) continue;
        let matched = null;
        for (const din of dstDef.ins) {
          if (portsCompatible(sout.t, din.t) && !inputIsWired(dst.id, din.n)) {
            matched = din;
            break;
          }
        }
        if (matched) {
          state.edges.push({
            from: { node: src.id, port: sout.n },
            to:   { node: dst.id, port: matched.n }
          });
          added++;
          break;
        }
      }
    }
  }
  return added;
}

/* Sprint 5.smart-link.ai-patch-connect -- validate + apply a batch
 * of arbitrary proposed edges (not necessarily sequential). Used by
 * _aiAutoConnect; could be reused later by import-patch or paste
 * flows that hand us pre-baked edge sets.
 *
 * Validation per edge:
 *   - both endpoints reference real nodes in state.nodes
 *   - both port names exist on their respective TYPES def
 *   - portsCompatible(srcType, dstType) holds
 *   - destination input is not already wired
 *   - no self-loop (loops must go through Delay1 via the manual
 *     edge-tool path, not this batch applier)
 *
 * Returns the count of edges that passed validation and were
 * actually pushed. */
function _applyEdgeSet(edges) {
  if (!Array.isArray(edges) || !Array.isArray(state.nodes)) return 0;
  if (!Array.isArray(state.edges)) state.edges = [];
  let added = 0;
  const inputIsWired = (nodeId, portName) =>
    state.edges.some(e =>
      e && e.to && e.to.node === nodeId && e.to.port === portName);
  for (const proposed of edges) {
    if (!proposed || !proposed.from || !proposed.to) continue;
    const srcId = proposed.from.node, srcPort = proposed.from.port;
    const dstId = proposed.to.node,   dstPort = proposed.to.port;
    if (!srcId || !dstId || !srcPort || !dstPort) continue;
    if (srcId === dstId) continue;
    const src = state.nodes.find(n => n && n.id === srcId);
    const dst = state.nodes.find(n => n && n.id === dstId);
    if (!src || !dst) continue;
    const srcDef = TYPES[src.type], dstDef = TYPES[dst.type];
    if (!srcDef || !dstDef) continue;
    const sout = (srcDef.outs || []).find(p => p.n === srcPort);
    const din  = (dstDef.ins  || []).find(p => p.n === dstPort);
    if (!sout || !din) continue;
    if (!portsCompatible(sout.t, din.t)) continue;
    if (inputIsWired(dstId, dstPort)) continue;
    state.edges.push({
      from: { node: srcId, port: srcPort },
      to:   { node: dstId, port: dstPort }
    });
    added++;
  }
  return added;
}

/* Sprint 5.smart-link.ai-patch-connect -- third smart-link consumer.
 * Shift+W keybind / canvas-tools menu item. Sends the current graph
 * (nodes + their port shapes + existing edges) to the configured AI
 * provider and asks for proposed new edges following conventional
 * patching logic (audio toward Outputs; mesh into Scene; Scene
 * texture into VisualOutput; lights/cameras/env into Scene; etc.).
 *
 * Not prompt-based by default per the user's spec ("just a button
 * that does the most likely auto wire based on the nodes active on
 * the editor"). If the User DSP prompt input has text, it's passed
 * as optional guidance for custom requests ("only wire the audio
 * chain, leave visuals", "use Slider as a freq modulator", etc.).
 *
 * Edges come back as a JSON array; we strip any markdown fences,
 * validate each via _applyEdgeSet, and push history before applying
 * so undo rolls back the whole batch in one step.
 *
 * Status feedback uses setVoiceStatus (canvas-side pill) rather
 * than setAiStatus because the User DSP tab isn't necessarily
 * visible when triggered. */
async function _aiAutoConnect() {
  if (!Array.isArray(state.nodes) || state.nodes.length < 2) {
    setVoiceStatus("Need 2+ nodes on canvas for AI auto-wire", "err");
    setTimeout(() => setVoiceStatus("", ""), 2000);
    return 0;
  }
  const provider = PROVIDERS[aiSettings.provider];
  if (!provider) {
    setVoiceStatus("No AI provider configured (User DSP ⚙)", "err");
    setTimeout(() => setVoiceStatus("", ""), 2500);
    return 0;
  }
  let key = "";
  if (provider.requiresKey) {
    key = aiSettings.anthropicKey || "";
    if (!key) {
      setVoiceStatus("AI provider needs API key (User DSP ⚙)", "err");
      setTimeout(() => setVoiceStatus("", ""), 2500);
      return 0;
    }
  }

  // Compact graph payload -- keep tokens minimal for Gemma-local.
  // Only include ports actually defined in TYPES; omit per-node
  // params (those aren't routable in the same way as port edges).
  const compactNodes = state.nodes.map(n => {
    const def = TYPES[n.type];
    return {
      id: n.id,
      type: n.type,
      outs: (def && def.outs) ? def.outs.map(p => ({ n: p.n, t: p.t })) : [],
      ins:  (def && def.ins)  ? def.ins.map(p  => ({ n: p.n, t: p.t })) : []
    };
  });
  const compactEdges = (state.edges || []).map(e => ({
    from: { node: e.from.node, port: e.from.port },
    to:   { node: e.to.node,   port: e.to.port }
  }));

  const system =
    "You are a routing assistant for the Gamma Node Editor (visual DSP / audio / 3D patcher).\n" +
    "Given a graph of nodes (with port types) plus existing edges, propose NEW edges that connect the patch following conventional signal-flow logic.\n\n" +
    "Port type rules:\n" +
    "- Audio family (audio, param, gate, clock) is cross-compatible.\n" +
    "- Visual family (texture, transform, mesh, camera, light, environment) is STRICT same-type.\n\n" +
    "Patching conventions:\n" +
    "- Audio sources (Sine, Saw, Noise, filters) flow toward Output / OutputStereo sinks.\n" +
    "- Mesh-generating nodes feed Scene's mesh inputs. Scene's texture output feeds VisualOutput.\n" +
    "- Lights and Cameras feed Scene's light / camera inputs. Environments feed Scene's environment input.\n" +
    "- Modulation sources (LFO, EnvFollow, Slider) wire to param inputs of audio processors.\n" +
    "- NEVER re-wire an input that already has an edge.\n" +
    "- It's fine to leave a node unwired if no sensible target exists -- do not force junk connections.\n\n" +
    "Output: a JSON array of edges, NOTHING ELSE -- no prose, no markdown fences.\n" +
    "Edge shape: { \"from\": { \"node\": \"<id>\", \"port\": \"<outPortName>\" }, \"to\": { \"node\": \"<id>\", \"port\": \"<inPortName>\" } }\n" +
    "If no useful edges, return [].";

  const customGuidance = (aiPromptEl && aiPromptEl.value || "").trim();
  const guidanceBlock = customGuidance
    ? "\n\nUser guidance: " + JSON.stringify(customGuidance)
    : "";
  const userMsg =
    "Nodes:\n" + JSON.stringify(compactNodes) +
    "\n\nExisting edges:\n" + JSON.stringify(compactEdges) +
    guidanceBlock +
    "\n\nReturn only the JSON edge array.";

  setVoiceStatus("AI auto-wire — thinking (" +
    shortModelName(aiSettings.provider, aiSettings.model) + ")…", "thinking");

  let text = "";
  try {
    text = await provider.call({
      system,
      user: userMsg,
      model: aiSettings.model,
      key,
      temperature: 0,
      maxTokens: 1024
    });
  } catch (err) {
    setVoiceStatus("AI error: " + (err && err.message ? err.message : err), "err");
    setTimeout(() => setVoiceStatus("", ""), 4000);
    return 0;
  }

  // Strip code fences + isolate the first JSON array. Both Claude
  // and Gemma occasionally wrap the output in ```json ... ``` despite
  // the system prompt forbidding it.
  let parsed = null;
  try {
    let s = (text || "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const start = s.indexOf("[");
    const end   = s.lastIndexOf("]");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    parsed = JSON.parse(s);
  } catch (err) {
    setVoiceStatus("AI returned malformed JSON; nothing applied", "err");
    setTimeout(() => setVoiceStatus("", ""), 3000);
    return 0;
  }
  if (!Array.isArray(parsed)) {
    setVoiceStatus("AI response wasn't an edge array", "err");
    setTimeout(() => setVoiceStatus("", ""), 3000);
    return 0;
  }
  if (parsed.length === 0) {
    setVoiceStatus("AI: no new wires suggested", "");
    setTimeout(() => setVoiceStatus("", ""), 2500);
    return 0;
  }

  pushHistory("ai:auto-wire");
  const added = _applyEdgeSet(parsed);
  if (added > 0) {
    setVoiceStatus("AI auto-wired " + added + " edge(s)" +
      (added < parsed.length ? " (" + (parsed.length - added) + " rejected)" : ""), "");
    setTimeout(() => setVoiceStatus("", ""), 2500);
  } else {
    setVoiceStatus("AI proposed " + parsed.length + " edge(s) but none validated", "err");
    setTimeout(() => setVoiceStatus("", ""), 3000);
  }
  render();
  return added;
}

/* Sprint 5.handwriting-chain -- pre-flight TYPES match for the
 * chain handler. Mirrors the matching steps in tryCreateFromLabel
 * (exact -> case-insensitive -> prefix -> substring -> Levenshtein
 * fuzzy) but without the side effect of spawning a node. Used to
 * validate every token in a chain matches BEFORE committing to
 * spawn any of them. */
function _matchTypeName(rawToken) {
  const types = Object.keys(TYPES);
  const clean = String(rawToken || "")
    .replace(/[`*_~"'.,:;!?()\[\]\n]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .trim();
  if (!clean) return null;
  const lc = clean.toLowerCase();
  let match = types.find(t => t === clean)
           || types.find(t => t.toLowerCase() === lc)
           || types.find(t => t.toLowerCase().startsWith(lc) && lc.length >= 3)
           || types.find(t => t.toLowerCase().includes(lc) && lc.length >= 3);
  if (!match && clean.length >= 3) {
    const tol = Math.max(1, Math.ceil(clean.length / 3));
    let best = null, bestDist = tol + 1;
    for (const t of types) {
      if (Math.abs(t.length - clean.length) > tol) continue;
      const d = levenshtein(lc, t.toLowerCase());
      if (d < bestDist) { bestDist = d; best = t; }
    }
    if (best) match = best;
  }
  return match || null;
}

function tryCreateFromLabel(rawLabel, box, silent) {
  // The model may return more than one word, with whitespace, periods,
  // markdown bullets, "node:" prefixes, etc. Extract candidate tokens
  // and try each against TYPES with progressively looser matching.
  // When `silent` is true, no status pill update on failure — caller
  // is expected to fall back to another recognizer.
  const types = Object.keys(TYPES);
  if (!rawLabel) {
    if (!silent) setVoiceStatus("Recognizer returned nothing.", "err");
    return null;
  }
  // Strip common VLM preambles BEFORE punctuation cleaning so the
  // patterns can use word boundaries. Small VLMs love to wrap a
  // one-word answer in "The handwritten word is 'X'" / "It says X" /
  // "The image shows the word X" / "Looks like X". We've also seen
  // markdown like "**X**" and code-fence wraps. Strip aggressively.
  let preStripped = rawLabel
    .replace(/^[\s\-•*]*the (?:handwritten )?(?:word|text|writing|label|node)?\s*(?:is|reads|says)?:?\s*/i, "")
    .replace(/^[\s\-•*]*(?:it|this|that)\s+(?:is|says|reads|appears to (?:be|say)|looks like)\s*:?\s*/i, "")
    .replace(/^[\s\-•*]*(?:the\s+)?image (?:shows?|contains?|displays?|has)\s+(?:the\s+)?(?:word|text|letters?|handwriting)?\s*:?\s*/i, "")
    .replace(/^[\s\-•*]*(?:looks like|appears to be|reads as|i (?:see|read))\s*:?\s*/i, "")
    .replace(/^[\s\-•*]*(?:answer|word|text|node|label)\s*[:=]\s*/i, "")
    .replace(/^[\s\-•*]*```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // HW.2 -- canonicalize every separator variant to " | " (pipe, arrows,
  // ->/=>, slashes, and Tesseract's lone-I/l/1 pipe-misreads) via the
  // shared normalizer, then split. A two-or-more-part split dispatches to
  // the chain handler (spawn each + auto-wire); a single segment falls
  // through to the existing single-node path. Shared with _looksLikeChain
  // so the cascade's chain pre-check and this split agree.
  preStripped = _normalizeChainSeparators(preStripped);
  if (preStripped.includes("|")) {
    const parts = preStripped.split(" | ").map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return _tryCreateChain(parts, box, silent);
    }
  }

  const cleanedFull = preStripped.replace(/[`*_~"'.,:;!?()\[\]\n]/g, " ").trim();
  if (/^\s*UNKNOWN\s*$/i.test(cleanedFull) || !cleanedFull) {
    if (!silent) setVoiceStatus(`Recognizer didn't identify a node type — got “${rawLabel.trim().slice(0,40)}”. Try writing larger / more clearly.`, "err");
    return null;
  }
  // Drop obvious filler the model sometimes appends.
  const STOP = new Set(["node","wave","filter","oscillator","the","a","an","is","this","says","reads","appears","looks","like","seems","probably","maybe","might","could","be","i","it","that","handwritten","word","text","label","letter","letters","says","writing"]);
  const tokens = cleanedFull
    .split(/\s+/)
    .map(t => t.replace(/[^A-Za-z0-9]/g, ""))
    .filter(t => t.length > 0 && !STOP.has(t.toLowerCase()));
  // OCR commonly swaps look-alike glyphs in short uppercase words —
  // e.g. "LFO" → "LF0", "Impulse" → "1mpu1se", "Saw" → "5aw". Generate
  // an additional candidate for each token with digits replaced by their
  // letter twin. Done as extra candidates (not a replacement) so genuine
  // digit-bearing names like "Delay1" still match.
  const deconfuse = (s) => s
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/5/g, "S")
    .replace(/8/g, "B");
  // n-grams: try concatenations of 1..4 consecutive tokens. Catches
  // VLM responses like "Multi band Comp" (3 tokens) → "MultibandComp"
  // and "Auto Filter" (2 tokens) → "AutoFilter". We try longest n-grams
  // first since they're more specific.
  const ngrams = [];
  for (let n = Math.min(4, tokens.length); n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      ngrams.push(tokens.slice(i, i + n).join(""));
    }
  }
  const baseCandidates = [
    cleanedFull.replace(/[^A-Za-z0-9]/g, ""),
    ...ngrams,
    ...tokens
  ];
  const seen = new Set();
  const candidates = [];
  for (const c of baseCandidates) {
    if (!c) continue;
    if (!seen.has(c)) { seen.add(c); candidates.push(c); }
    const dc = deconfuse(c);
    if (dc !== c && !seen.has(dc)) { seen.add(dc); candidates.push(dc); }
  }
  const matchOne = (s) => {
    if (!s) return null;
    const lc = s.toLowerCase();
    return types.find(t => t === s)
        || types.find(t => t.toLowerCase() === lc)
        || types.find(t => t.toLowerCase().startsWith(lc) && lc.length >= 3)
        || types.find(t => t.toLowerCase().includes(lc) && lc.length >= 3);
  };
  let match = null;
  for (const c of candidates) {
    match = matchOne(c);
    if (match) break;
  }
  // Fuzzy fallback — Levenshtein distance ≤ ceil(len/3) handles OCR
  // character errors on names of any length. Threshold lowered from 4 to
  // 3 chars so short uppercase names ("LFO", "AHD", "FFT") still get a
  // fuzzy chance after deconfusing fails.
  if (!match) {
    const longest = candidates.filter(Boolean).sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 3) {
      const lc = longest.toLowerCase();
      // ceil(len/3) gives 1 for 3-char names (one OCR slip allowed),
      // 2 for 4–6 chars, 3 for 7–9, etc. Tighter than the old /4 ratio
      // for medium-length names without becoming permissive on shorts.
      const tol = Math.max(1, Math.ceil(lc.length / 3));
      let best = null, bestDist = tol + 1;
      for (const t of types) {
        const tl = t.toLowerCase();
        // Skip if length differs too much — saves work + avoids
        // false positives across very different names.
        if (Math.abs(tl.length - lc.length) > tol) continue;
        const d = levenshtein(lc, tl);
        if (d < bestDist) { bestDist = d; best = t; }
      }
      if (best) match = best;
    }
  }
  if (!match) {
    if (!silent) setVoiceStatus(`No node type matches “${rawLabel.trim().slice(0,40)}”.`, "err");
    return null;
  }
  pushHistory("hwr:add");
  const newId = makeNode(match, Math.round(box.x), Math.round(box.y));
  if (newId) selectOne(newId);
  render();
  return match;
}