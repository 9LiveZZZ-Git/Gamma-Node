/* =========================================================================
 * v0.3.47 -- OSC client glue
 *
 * Connects to the gamma-compile-server's /osc WebSocket endpoint as
 * soon as the server is detected (same probeLocalServer() path the
 * compile flow uses). Receives inbound OSC messages + dispatches
 * them to matching OscIn nodes; reads outbound values from OscOut
 * nodes each rAF tick + forwards via WS. Reconnects on close.
 *
 * The status pill in the visual HUD (📡) goes from grey (idle) to
 * phosphor (connected) to red (error). Click for a small modal
 * with the daemon's reported config (inbound UDP port, default
 * outbound target).
 *
 * Address-pattern matching: identical semantics to the codec on the
 * server side -- exact match, '*' = any chars within one path part,
 * '?' = one char. Cross-segment wildcards left for a follow-up. */

/* Sprint 7.5.6.a part 1 -- RT engine state. Populated by the
 * compile-server /health probe; the editor uses this to know whether
 * to enable the RayTracedScene node or grey it out with "engine
 * not installed". serverInfo shape: { available, capabilities,
 * wsPath, proxyReady } from the Node side. */
const _rtEngineState = {
  serverInfo: null
};

const _oscState = {
  ws: null,
  status: "idle",          // idle | connecting | connected | error | disabled
  helloInfo: null,         // hello payload {oscInPort, defaultOut, version}
  endpoint: null,          // ws://... URL
  reconnectTimer: null,
  // Cache of last-sent values per OscOut node to suppress unchanged
  // messages. Map<node.id, number[]>.
  outLast: new Map(),
  // v0.3.48 -- "Learn" mode. When learnArmed is true, the next
  // inbound OSC message creates an OscIn node at the canvas center
  // with its address pre-filled. Lets the user discover incoming
  // addresses without typing them by hand. Set via Shift+click on
  // the 📡 HUD pill; cancelled by Escape or a successful capture.
  learnArmed: false,
  learnArmedAtMs: 0
};

function _oscWsUrl(httpEndpoint) {
  if (!httpEndpoint) return null;
  return httpEndpoint.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/osc";
}

async function _ensureOscConnection() {
  // Already connected?
  if (_oscState.ws && _oscState.ws.readyState === 1) return;
  if (_oscState.ws && _oscState.ws.readyState === 0) return;  // connecting
  // Need a compile-server endpoint. probeLocalServer is idempotent
  // (returns cached status after first call) so calling here is cheap.
  await probeLocalServer();
  if (!localServerEndpoint) {
    _oscState.status = "idle";
    _updateOscPill();
    return;
  }
  // /health tells us if the bridge is enabled on this daemon. Older
  // daemons (pre v0.3.0) won't have the osc key -- treat as disabled.
  // Sprint 7.5.6.a part 1 -- also capture rtEngine.* here so the
  // editor knows whether the RayTracedScene node has a backend.
  let oscEnabled = false;
  try {
    const h = await fetch(localServerEndpoint + "/health", { signal: AbortSignal.timeout(2000) }).then(r => r.json());
    oscEnabled = !!(h && h.osc && h.osc.enabled);
    if (h && h.rtEngine) _rtEngineState.serverInfo = h.rtEngine;
  } catch (_) { /* leave disabled */ }
  if (!oscEnabled) {
    _oscState.status = "disabled";
    _updateOscPill();
    return;
  }

  const wsUrl = _oscWsUrl(localServerEndpoint);
  _oscState.endpoint = wsUrl;
  _oscState.status = "connecting";
  _updateOscPill();
  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch (e) { _oscState.status = "error"; _updateOscPill(); console.warn("[osc] ws ctor failed:", e); return; }
  _oscState.ws = ws;
  ws.onopen = () => {
    _oscState.status = "connected";
    _updateOscPill();
    _rebuildOscSubscriptions();
  };
  ws.onclose = () => {
    _oscState.ws = null;
    _oscState.helloInfo = null;
    // Don't drop to "idle" if we got an error first -- preserve the
    // last error indicator for a beat so the user sees it.
    if (_oscState.status !== "error") _oscState.status = "idle";
    _updateOscPill();
    if (!_oscState.reconnectTimer) {
      _oscState.reconnectTimer = setTimeout(() => {
        _oscState.reconnectTimer = null;
        _ensureOscConnection();
      }, 2000);
    }
  };
  ws.onerror = () => {
    _oscState.status = "error";
    _updateOscPill();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch (_) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") {
      _oscState.helloInfo = msg;
      _updateOscPill();
    } else if (msg.type === "in") {
      _dispatchOscIn(msg.address, msg.args || []);
    } else if (msg.type === "in-bundle") {
      const msgs = msg.messages || [];
      for (const m of msgs) _dispatchOscIn(m.address, m.args || []);
    } else if (msg.type === "error") {
      console.warn("[osc] bridge error (" + (msg.where || "?") + "):", msg.message);
    }
  };
}

/* Full OSC 1.0 address-pattern matcher, identical semantics to the
 * server-side codec. Supports:
 *   ?           single char (not '/')
 *   *           zero or more chars (not '/')
 *   [abc]       character class, [a-z] ranges, [!abc] negation
 *   {alt,erna,tives}   literal alternation
 * Cached so repeated dispatch (every OSC message walks every OscIn)
 * doesn't recompile the regex each time. */
const _OSC_PATTERN_CACHE = new Map();
const _OSC_PATTERN_CACHE_LIMIT = 256;
function _patternToRegex(pattern) {
  const cached = _OSC_PATTERN_CACHE.get(pattern);
  if (cached) return cached;
  let re = "^", i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") { re += "[^/]*"; i++; }
    else if (c === "?") { re += "[^/]"; i++; }
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) { re += "\\["; i++; }
      else {
        let body = pattern.slice(i + 1, end);
        if (body.length === 0) re += "[^\\s\\S]";
        else {
          if (body[0] === "!") body = "^" + body.slice(1);
          re += "[" + body.replace(/\\/g, "\\\\") + "]";
        }
        i = end + 1;
      }
    } else if (c === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end < 0) { re += "\\{"; i++; }
      else {
        const alts = pattern.slice(i + 1, end).split(",")
          .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        re += "(?:" + alts.join("|") + ")";
        i = end + 1;
      }
    } else if ("/^$.|+()\\".includes(c)) {
      re += "\\" + c; i++;
    } else { re += c; i++; }
  }
  re += "$";
  let compiled;
  try { compiled = new RegExp(re); }
  catch (_) { compiled = /^.\B/; }   // matches nothing
  if (_OSC_PATTERN_CACHE.size >= _OSC_PATTERN_CACHE_LIMIT) {
    _OSC_PATTERN_CACHE.delete(_OSC_PATTERN_CACHE.keys().next().value);
  }
  _OSC_PATTERN_CACHE.set(pattern, compiled);
  return compiled;
}
function _matchesOscPattern(pattern, address) {
  if (!pattern || !address) return false;
  if (pattern === address) return true;
  return _patternToRegex(pattern).test(address);
}

function _dispatchOscIn(address, args) {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  // v0.3.48 -- Learn mode. The first inbound message after arming
  // creates a new OscIn node at the canvas center with the captured
  // address. Pre-fills v1..v4 from the message args so the user sees
  // them populated immediately.
  if (_oscState.learnArmed) {
    _captureOscToNewNode(address, args);
    _oscState.learnArmed = false;
    _updateOscPill();
  }
  for (const node of state.nodes) {
    if (!node || node.type !== "OscIn") continue;
    const pattern = (node.params && node.params.address) || "";
    if (!_matchesOscPattern(pattern, address)) continue;
    if (!node.params) node.params = {};
    // Coerce up to 4 numeric args; non-numeric / missing → 0.
    for (let k = 0; k < 4; k++) {
      const portName = "v" + (k + 1);
      const raw = (k < args.length) ? args[k] : 0;
      const num = (typeof raw === "number") ? raw : (typeof raw === "boolean" ? (raw ? 1 : 0) : 0);
      node.params[portName] = num;
    }
  }
  // The standard rAF push (_pushLiveControlsToWorklet) will pick up
  // the new values + forward them to the audio worklet on the next
  // frame. Visual side reads node.params directly via the resolver,
  // so it's already current.
}

function _captureOscToNewNode(address, args) {
  if (typeof makeNode !== "function" || typeof state === "undefined") return;
  // Place new node near the center of the visible canvas so the
  // user sees it immediately. Falls back to (40, 40) if no view
  // transform is available.
  let x = 80, y = 80;
  try {
    const c = document.getElementById("canvas-world");
    if (c) {
      const r = c.getBoundingClientRect();
      x = Math.max(40, Math.round(r.width  * 0.4));
      y = Math.max(40, Math.round(r.height * 0.4));
    }
  } catch (_) {}
  // Pre-populate v1..v4 from the captured args so the new node's
  // properties pane shows the actual current values rather than
  // four zeros.
  const params = { address };
  for (let k = 0; k < 4; k++) {
    const raw = k < args.length ? args[k] : 0;
    params["v" + (k + 1)] = (typeof raw === "number") ? raw : (typeof raw === "boolean" ? (raw ? 1 : 0) : 0);
  }
  try {
    const id = makeNode("OscIn", x, y, params);
    console.log("[osc] learn captured " + address + " -> new OscIn " + id);
    // Force a redraw so the new node shows up before the next user
    // interaction. The exact function name varies by editor era;
    // try a couple of common ones.
    if (typeof render === "function") render();
    if (typeof renderProps === "function") renderProps();
  } catch (e) {
    console.warn("[osc] learn capture failed:", e);
  }
  _rebuildOscSubscriptions();
}

function _toggleOscLearn() {
  // Need an open WS to learn. If not connected, kick a connect attempt
  // + tell the user via the pill tooltip; arming without a stream is
  // pointless.
  if (!_oscState.ws || _oscState.ws.readyState !== 1) {
    _ensureOscConnection();
    return;
  }
  _oscState.learnArmed = !_oscState.learnArmed;
  _oscState.learnArmedAtMs = performance.now();
  _updateOscPill();
}

function _rebuildOscSubscriptions() {
  if (!_oscState.ws || _oscState.ws.readyState !== 1) return;
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  const patterns = new Set();
  for (const n of state.nodes) {
    if (n && n.type === "OscIn" && n.params && typeof n.params.address === "string") {
      if (n.params.address.startsWith("/")) patterns.add(n.params.address);
    }
  }
  // Always sent (even if empty) so the bridge knows our intent. The
  // bridge currently fans-out unconditionally; this is for diagnostic
  // purposes + a future filter-on-server optimization.
  try {
    _oscState.ws.send(JSON.stringify({ type: "subscribe", patterns: [...patterns] }));
  } catch (_) {}
}

/* v0.3.48 -- JS-side mirrors for common audio-rate sources, used to
 * give OscOut a way to forward Sine / Saw / Square / Phasor / AD
 * values without forcing the user to wire through an intermediate
 * Slider.
 *
 * Drift vs the actual audio-side compiled C++ class: the JS-side
 * mirror runs at rAF cadence using performance.now() as the time
 * source, so phase drifts vs the sample-accurate worklet path by
 * sub-millisecond per minute -- imperceptible at OSC rates (~60 Hz).
 * Anything more precise needs a SAB-based probe (logged as future
 * ticket; see comment at the end of this section).
 *
 * State per node: { phase, lastT }. Phase is in [0,1) (revolutions,
 * NOT radians) so the same value drives Sine via sin(2π·phase),
 * Phasor as-is, Saw as 2·phase-1, Square as sign(phase-0.5).
 *
 * AD-class envelopes (AD, AR, ADSR) need gate-event tracking:
 * we observe the upstream `trig` wire each frame, detect rising
 * edges, then re-evaluate the envelope shape against time since
 * trigger. The C++-side class is sample-accurate; we approximate
 * with a piecewise math expression matching its public shape. */
const _audioMirrorState = new Map();      // node.id -> { phase, lastT }
const _envMirrorState   = new Map();      // node.id -> { trigT, lastGate }

function _audioMirrorOscValue(node, port) {
  // The oscillators all emit on a single port called "out". Bail
  // for unexpected ports rather than returning a misleading value.
  if (port !== "out") return null;
  let st = _audioMirrorState.get(node.id);
  const nowSec = performance.now() * 0.001;
  if (!st) { st = { phase: 0, lastT: nowSec }; _audioMirrorState.set(node.id, st); }
  const dtSec = Math.max(0, Math.min(0.25, nowSec - st.lastT));   // clamp to 250 ms in case of tab-freeze gap
  st.lastT = nowSec;
  // Resolve freq -- may itself be wired (through Slider etc), in
  // which case follow it. Falls back to the node's static freq param.
  let freq = 1.0;
  const freqWire = state.edges && state.edges.find(e =>
    e && e.to && e.to.node === node.id && e.to.port === "freq"
  );
  if (freqWire) {
    const fv = _readWireJsSideValue(freqWire);
    if (typeof fv === "number" && isFinite(fv)) freq = fv;
  } else if (node.params && typeof node.params.freq === "number") {
    freq = node.params.freq;
  }
  st.phase = (st.phase + freq * dtSec) % 1.0;
  if (st.phase < 0) st.phase += 1.0;
  if (node.type === "Sine")   return Math.sin(st.phase * 2 * Math.PI);
  if (node.type === "Phasor") return st.phase;
  if (node.type === "Saw")    return 2 * st.phase - 1;
  if (node.type === "Square") return st.phase < 0.5 ? 1 : -1;
  return null;
}

function _envMirrorValue(node, port) {
  if (port !== "out") return null;
  let st = _envMirrorState.get(node.id);
  if (!st) { st = { trigT: -1e9, lastGate: 0 }; _envMirrorState.set(node.id, st); }
  // Check the trig input -- if a wire is feeding it + the upstream
  // value went 0 -> >0.5 between this frame and last, that's a
  // rising-edge trigger.
  const wire = state.edges && state.edges.find(e =>
    e && e.to && e.to.node === node.id && e.to.port === "trig"
  );
  let curGate = 0;
  if (wire) {
    const gv = _readWireJsSideValue(wire);
    curGate = (typeof gv === "number" && gv > 0.5) ? 1 : 0;
  }
  if (curGate && !st.lastGate) {
    st.trigT = performance.now() * 0.001;
  }
  st.lastGate = curGate;
  const dt = performance.now() * 0.001 - st.trigT;
  if (dt < 0 || !isFinite(dt)) return 0;
  const p = node.params || {};
  // Times are seconds in the registry. AD: attack -> decay -> 0.
  // AR: attack -> sustain (gate held) -> release. ADSR similar.
  // We approximate AR/ADSR as AD when the gate is no longer high
  // (the AD shape is the simplest right-after-trigger envelope).
  const atk = Math.max(0.001, +p.attack || 0.01);
  const dec = Math.max(0.001, +p.decay  || 0.1);
  if (node.type === "AD") {
    if (dt < atk) return dt / atk;
    if (dt < atk + dec) return 1.0 - (dt - atk) / dec;
    return 0;
  }
  if (node.type === "AR") {
    const rel = Math.max(0.001, +p.release || dec);
    if (dt < atk) return dt / atk;
    return Math.exp(-(dt - atk) / rel);
  }
  if (node.type === "ADSR") {
    const sus = Math.max(0, Math.min(1, +p.sustain || 0.6));
    const rel = Math.max(0.001, +p.release || dec);
    if (dt < atk) return dt / atk;
    if (dt < atk + dec) {
      // Decay phase: 1 -> sustain
      const k = (dt - atk) / dec;
      return 1 - k * (1 - sus);
    }
    if (curGate) return sus;
    // Release once gate drops
    return sus * Math.exp(-(dt - atk - dec) / rel);
  }
  return 0;
}

