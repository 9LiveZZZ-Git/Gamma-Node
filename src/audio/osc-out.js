function _tickOscOut() {
  if (!_oscState.ws || _oscState.ws.readyState !== 1) return;
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  const nodes = state.nodes.filter(n => n && n.type === "OscOut");
  if (nodes.length === 0) return;

  // Group messages by destination (host:port) so we can pack them
  // into a single OSC bundle per destination. Bundles arrive atomically
  // at the receiver -- important when an animation wants several
  // params to move in lockstep (e.g. RGB color triplet).
  // Map<destKey, { host?, port?, messages: [{address, args}] }>
  const destBuckets = new Map();
  const destKey = (h, p) => (h || "") + ":" + (p || "");

  for (const node of nodes) {
    const address = node.params && node.params.address;
    if (typeof address !== "string" || !address.startsWith("/")) continue;
    // Read wired v1..v4 values. Drop the message if NONE are wired.
    const values = [];
    let anyWired = false;
    for (let k = 0; k < 4; k++) {
      const portName = "v" + (k + 1);
      const wire = state.edges.find(e =>
        e && e.to && e.to.node === node.id && e.to.port === portName
      );
      if (!wire) { values.push(null); continue; }
      anyWired = true;
      const v = _readWireJsSideValue(wire);
      values.push(typeof v === "number" && isFinite(v) ? v : null);
    }
    if (!anyWired) continue;
    // Trim trailing nulls. Mid-array nulls (wired source had no
    // JS mirror) become 0 so the arg count stays consistent.
    while (values.length > 0 && values[values.length - 1] === null) values.pop();
    const cleanArgs = values.map(v => v === null ? 0 : v);
    // Change-detect against last-sent values for this node.
    const last = _oscState.outLast.get(node.id);
    let changed = !last || last.length !== cleanArgs.length;
    if (!changed) {
      for (let i = 0; i < cleanArgs.length; i++) {
        if (Math.abs(last[i] - cleanArgs[i]) > 1e-6) { changed = true; break; }
      }
    }
    if (!changed) continue;
    _oscState.outLast.set(node.id, cleanArgs.slice());
    // Destination -- per-node overrides win; otherwise bridge default.
    const host = (node.params.host && typeof node.params.host === "string" && node.params.host.trim()) || "";
    const portRaw = Number(node.params.port);
    const port = (Number.isFinite(portRaw) && portRaw > 0) ? portRaw : 0;
    const key = destKey(host, port);
    let bucket = destBuckets.get(key);
    if (!bucket) {
      bucket = { messages: [] };
      if (host) bucket.host = host;
      if (port) bucket.port = port;
      destBuckets.set(key, bucket);
    }
    bucket.messages.push({ address, args: cleanArgs });
  }

  // Flush each destination. Single message -> {type:"send"}; multiple
  // messages -> {type:"send-bundle"} so the receiving app gets them
  // atomically. Either form goes out as one UDP datagram on the
  // bridge side.
  for (const bucket of destBuckets.values()) {
    if (bucket.messages.length === 0) continue;
    let payload;
    if (bucket.messages.length === 1) {
      payload = { type: "send", address: bucket.messages[0].address, args: bucket.messages[0].args };
    } else {
      payload = { type: "send-bundle", messages: bucket.messages };
    }
    if (bucket.host) payload.host = bucket.host;
    if (bucket.port) payload.port = bucket.port;
    try { _oscState.ws.send(JSON.stringify(payload)); }
    catch (_) {}
  }
}

function _updateOscPill() {
  const pill = document.getElementById("osc-pill");
  if (!pill) return;
  const s = _oscState.status;
  pill.classList.remove("connected", "connecting", "error", "disabled", "learn");
  if (s === "connected" || s === "connecting" || s === "error" || s === "disabled") {
    pill.classList.add(s);
  }
  // Learn mode overrides the connected visual so users can see at a
  // glance that the next message will be captured.
  if (_oscState.learnArmed) {
    pill.classList.add("learn");
    pill.title = "OSC Learn armed -- send a message from your controller now. The captured address will become a new OscIn node. (Shift+click to cancel, or press Escape.)";
    pill.textContent = "📡…";
    return;
  }
  pill.textContent = "📡";
  if (s === "connected" && _oscState.helloInfo) {
    const hi = _oscState.helloInfo;
    pill.title = "OSC bridge connected\n" +
                 "Inbound:  udp://<server>:" + hi.oscInPort + "\n" +
                 "Outbound: udp://" + (hi.defaultOut && hi.defaultOut.host) + ":" + (hi.defaultOut && hi.defaultOut.port) + " (default)\n" +
                 "Bridge version: " + (hi.version || "?") + "\n\n" +
                 "Click = create OscIn / OscOut nodes from the palette.\n" +
                 "Shift+click = Learn mode: next OSC message becomes a new OscIn node.";
  } else if (s === "connecting") {
    pill.title = "Connecting to OSC bridge...";
  } else if (s === "error") {
    pill.title = "OSC bridge error -- check that gamma-compile-server is running. The bridge attaches to the same daemon as /compile.";
  } else if (s === "disabled") {
    pill.title = "OSC bridge is disabled on the running daemon (--noOsc flag). Restart gamma-compile-server without --noOsc to enable.";
  } else {
    pill.title = "OSC bridge idle. Start gamma-compile-server (>=0.3.0) and the editor will auto-connect.";
  }
}

/* Re-probe on patch changes so adding an OscIn / OscOut node triggers
 * a connection attempt + re-subscribes. Hook from the editor's
 * existing patch-change notifier. */
function _onOscPatchChange() {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  const hasOscNode = state.nodes.some(n => n && (n.type === "OscIn" || n.type === "OscOut"));
  if (hasOscNode) {
    _ensureOscConnection();
    _rebuildOscSubscriptions();
  }
}

// Kick the connection on first load -- harmless if no server is up
// (probe just times out). Also trigger when probeLocalServer
// completes for the first time after a Play click. Wires the 📡
// pill: bare click is a hook for a future modal (open the OSC config
// panel); Shift+click toggles Learn mode for capturing addresses.
// Esc cancels Learn while it's armed.
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(_ensureOscConnection, 300);
    // Default ship-with-app assets. Idempotent -- skips immediately
    // if the user already has them. Delayed past app-init so Assets
    // namespace has finished hydrating from IDB before we check.
    // PNG output goes through Canvas convertToBlob (DEFLATE-compressed
    // by the browser); each programmatic sprite lands at a few hundred
    // bytes in IDB, no additional compression layer needed.
    setTimeout(_ensureHeroPlaceholderAsset, 600);
    setTimeout(_ensureEggPickupAsset, 650);
    setTimeout(_ensureGoalFlagAsset,  700);
    setTimeout(_ensureParallaxBgAssets, 750);
    setTimeout(_ensureGrassTuftAsset, 800);
    setTimeout(_ensureDemoTilesetAsset, 850);
    const pill = document.getElementById("osc-pill");
    if (pill) {
      pill.addEventListener("click", (e) => {
        if (e.shiftKey) {
          e.preventDefault();
          _toggleOscLearn();
        } else {
          // Bare click currently just triggers a re-connect attempt
          // (helpful when the daemon was started AFTER the editor
          // page loaded). A more elaborate config modal could land
          // here in a follow-up.
          _ensureOscConnection();
        }
      });
    }
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && _oscState.learnArmed) {
        _oscState.learnArmed = false;
        _updateOscPill();
      }
    });
  });
}

/* v0.3.16 — VideoFile retrigger from its gate input. Each frame we
 * look for a wire feeding the VideoFile's `trig` input, sample the
 * upstream value, + detect a rising edge across frames. On rising
 * edge we seek the video element back to currentTime = 0.
 *
 * Note: `_resolveNodeParams` deliberately skips gate-typed ports
 * (they have different semantics from param/audio/clock), so this
 * function reads the trig wire directly. Source kinds handled:
 *
 *   MasterClock.{bar,beat,quarter,eighth,sixteenth,phase}
 *     Cubic-decay envelope; peaks at 1.0 on rising edge + decays
 *     toward 0. We detect the > 0.5 threshold crossing.
 *
 *   Button.trig / generic param sources
 *     Same threshold semantics.
 *
 * Any other source type falls through to no-op. */
const _videoFileTrigState = new Map();   // nodeId -> last sampled trig value
