/* =========================================================================
 * v0.2.21 — Offline audio render to WAV (high-quality)
 *
 * Runs the cached patch wasm through an OfflineAudioContext (no audio
 * device, no real-time deadline) for the requested duration. Output:
 * stereo 16-bit PCM WAV at the sample rate of the realtime preview
 * context (typically 48 kHz). Higher than real-time playback in
 * practice because the worklet's audio quantum is the same but the
 * host can run it as fast as the CPU allows.
 *
 * Requires the wasm bytes from the most recent successful compile --
 * previewState.lastWasm is populated in previewCompileAndPlay before
 * the transfer to the realtime worklet (see the two
 * `previewState.lastWasm = wasmBytes.slice(0)` lines).
 *
 * The OfflineAudioContext is a fresh BaseAudioContext: addModule the
 * processor source, instantiate a new AudioWorkletNode, send it the
 * cached wasm via postMessage. No realtime SAB bridge in offline mode
 * (audio uniform path is a visual concern; render-to-file doesn't
 * need it). MIDI / mic / clock-driven setters all run from the
 * worklet's auto-fire body the same way they do realtime. */
async function renderOfflineAudio(durationSec) {
  if (!previewState || !previewState.lastWasm) {
    throw new Error("No compiled wasm cached. Click ▶ once to compile the patch, then try again.");
  }
  durationSec = Math.max(0.1, Math.min(3600, Number(durationSec) || 30));
  const sampleRate = (previewState.audioCtx && previewState.audioCtx.sampleRate) || 48000;
  const numChannels = 2;
  const lengthSamples = Math.max(1, Math.floor(durationSec * sampleRate));
  const offCtx = new OfflineAudioContext({
    numberOfChannels: numChannels,
    length: lengthSamples,
    sampleRate: sampleRate
  });
  const blob = new Blob([PREVIEW_PROCESSOR_SRC], { type: "application/javascript" });
  const url  = URL.createObjectURL(blob);
  try {
    await offCtx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(offCtx, "gamma-preview-processor", {
    outputChannelCount: [numChannels],
    // v0.3.19 — second input slot reserved for VideoSrc aggregate (see
    // live-preview path). For offline render there are no Web Audio
    // sources to feed it so it stays silent + the worklet's vid-buf
    // writes turn into zero samples; harmless.
    numberOfInputs: 2,
    numberOfOutputs: 1
  });
  node.connect(offCtx.destination);
  // Clone the cached wasm so we don't detach the master copy when we
  // transfer it to the offline worklet.
  const wasmClone = previewState.lastWasm.slice(0);
  // Wait for the worklet to confirm "loaded" before starting the render.
  // The worklet posts "loaded" once instantiation completes; without
  // this we'd start with an empty processor that emits silence.
  const loaded = new Promise((resolve, reject) => {
    let timer = null;
    const onmsg = (ev) => {
      if (!ev || !ev.data) return;
      if (ev.data.type === "loaded") {
        node.port.removeEventListener("message", onmsg);
        if (timer) clearTimeout(timer);
        resolve();
      } else if (ev.data.type === "error") {
        node.port.removeEventListener("message", onmsg);
        if (timer) clearTimeout(timer);
        reject(new Error(ev.data.error || "worklet load error"));
      }
    };
    node.port.addEventListener("message", onmsg);
    node.port.start();
    // Safety timeout: if no "loaded" arrives in 8 s, abort. WASM instantiation
    // for typical patches completes well under 1 s.
    timer = setTimeout(() => {
      node.port.removeEventListener("message", onmsg);
      reject(new Error("worklet load timeout"));
    }, 8000);
  });
  node.port.postMessage({ type: "load", wasmBytes: wasmClone }, [wasmClone]);
  await loaded;
  const audioBuffer = await offCtx.startRendering();
  return audioBuffer;
}

/* Encode an AudioBuffer to a WAV Blob. v0.2.22 — supports three
 * common bit depths:
 *   16    → signed PCM, 2 B/sample        (default, CD-quality, ~10 MB/min stereo @ 48kHz)
 *   24    → signed PCM, 3 B/sample        (DAW-friendly, ~15 MB/min)
 *   32    → IEEE float, 4 B/sample        (archival, lossless headroom, ~20 MB/min)
 * Format code in the fmt chunk: 1 for PCM (16/24), 3 for IEEE float (32).
 * Clamps to [-1, 1] before quantization; for 32-bit float the samples
 * are written verbatim (no clamping; signals above 0 dBFS preserved
 * for downstream processing). */
function audioBufferToWavBlob(audioBuffer, bitDepth) {
  bitDepth = (bitDepth === 24 || bitDepth === 32) ? bitDepth : 16;
  const isFloat       = (bitDepth === 32);
  const bytesPerSamp  = bitDepth / 8;
  const numChannels   = audioBuffer.numberOfChannels;
  const sampleRate    = audioBuffer.sampleRate;
  const length        = audioBuffer.length;
  const channelData   = [];
  for (let ch = 0; ch < numChannels; ch++) channelData.push(audioBuffer.getChannelData(ch));
  const dataBytes = length * numChannels * bytesPerSamp;
  const buf  = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  let p = 0;
  const wstr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };
  wstr("RIFF");
  view.setUint32(p, 36 + dataBytes, true);                    p += 4;
  wstr("WAVE");
  wstr("fmt ");
  view.setUint32(p, 16, true);                                p += 4;  // fmt chunk size (16 = canonical PCM/float)
  view.setUint16(p, isFloat ? 3 : 1, true);                   p += 2;  // 1=PCM, 3=IEEE float
  view.setUint16(p, numChannels, true);                       p += 2;
  view.setUint32(p, sampleRate, true);                        p += 4;
  view.setUint32(p, sampleRate * numChannels * bytesPerSamp, true); p += 4;  // byte rate
  view.setUint16(p, numChannels * bytesPerSamp, true);        p += 2;  // block align
  view.setUint16(p, bitDepth, true);                          p += 2;  // bits per sample
  wstr("data");
  view.setUint32(p, dataBytes, true);                         p += 4;

  // Write payload — bit-depth-specific.
  let off = 44;
  if (isFloat) {
    // 32-bit IEEE float. No clamping -- pass-through; signal headroom
    // above 0 dBFS preserved for archival / pre-mastering use.
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        view.setFloat32(off, channelData[ch][i], true);
        off += 4;
      }
    }
  } else if (bitDepth === 24) {
    // 24-bit signed PCM, little-endian three-byte words. Range
    // [-8388608, 8388607]. JS doesn't have setInt24; pack manually.
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let s = channelData[ch][i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        const v = (s < 0) ? Math.round(s * 0x800000) : Math.round(s * 0x7FFFFF);
        view.setUint8(off,     v        & 0xFF);
        view.setUint8(off + 1, (v >> 8)  & 0xFF);
        view.setUint8(off + 2, (v >> 16) & 0xFF);
        off += 3;
      }
    }
  } else {
    // 16-bit signed PCM (default). Range [-32768, 32767].
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let s = channelData[ch][i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        const v = (s < 0) ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
        view.setInt16(off, v, true);
        off += 2;
      }
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

/* v0.2.22 — MP3 export via lamejs (loaded from CDN on first use).
 *
 * Dynamic-import pattern mirrors the AI panel: don't load the library
 * unless the user asks for MP3. ~270 KB total (lame.min.js), cached
 * by the browser after first fetch.
 *
 * Encoding: float32 -> int16 -> Mp3Encoder.encodeBuffer in 1152-sample
 * (MP3 frame-size) chunks. Mono and stereo both supported; lamejs's
 * encoder takes (left, right) for stereo or just (mono) for mono. */
let _lamejsLoadPromise = null;
function _loadLamejs() {
  if (typeof globalThis.lamejs !== "undefined") return Promise.resolve(globalThis.lamejs);
  if (_lamejsLoadPromise) return _lamejsLoadPromise;
  // Pinned UMD bundle; the JsDelivr mirror is heavily cached. Falls
  // back to unpkg if the first host fails.
  const urls = [
    "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js",
    "https://unpkg.com/lamejs@1.2.1/lame.min.js"
  ];
  _lamejsLoadPromise = (async () => {
    for (const url of urls) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = url;
          s.async = true;
          s.onload  = () => resolve();
          s.onerror = () => reject(new Error("script load failed: " + url));
          document.head.appendChild(s);
        });
        if (typeof globalThis.lamejs !== "undefined") return globalThis.lamejs;
      } catch (e) {
        console.warn("[mp3] lamejs CDN attempt failed:", e);
      }
    }
    throw new Error("Could not load lamejs from any CDN (jsdelivr / unpkg)");
  })();
  return _lamejsLoadPromise;
}

async function audioBufferToMp3Blob(audioBuffer, bitrateKbps) {
  const lib = await _loadLamejs();
  bitrateKbps = Math.max(64, Math.min(320, bitrateKbps || 320));
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate  = audioBuffer.sampleRate;
  const length      = audioBuffer.length;
  const Mp3Encoder  = lib.Mp3Encoder;
  if (!Mp3Encoder) throw new Error("lamejs.Mp3Encoder missing — wrong build");
  const enc = new Mp3Encoder(numChannels, sampleRate, bitrateKbps);
  const dataL = audioBuffer.getChannelData(0);
  const dataR = numChannels > 1 ? audioBuffer.getChannelData(1) : null;
  // MP3 frame size is 1152 samples. Encode in chunks of that to keep
  // the encoder's internal buffers small + flush smoothly at the end.
  const CHUNK = 1152;
  const chunks = [];
  const toI16 = (buf, start, end) => {
    const out = new Int16Array(end - start);
    for (let i = start; i < end; i++) {
      let s = buf[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i - start] = (s < 0) ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
    }
    return out;
  };
  for (let i = 0; i < length; i += CHUNK) {
    const end = Math.min(i + CHUNK, length);
    const L = toI16(dataL, i, end);
    let mp3buf;
    if (dataR) {
      const R = toI16(dataR, i, end);
      mp3buf = enc.encodeBuffer(L, R);
    } else {
      mp3buf = enc.encodeBuffer(L);
    }
    if (mp3buf && mp3buf.length > 0) chunks.push(new Uint8Array(mp3buf));
  }
  const tail = enc.flush();
  if (tail && tail.length > 0) chunks.push(new Uint8Array(tail));
  return new Blob(chunks, { type: "audio/mpeg" });
}

/* =========================================================================
 * v0.2.23 — Standalone HTML export
 *
 * Bakes the current patch into a self-contained copy of the editor
 * HTML. Fetches our own HTML via fetch(location.href), injects a
 * `<script type="application/json" id="gamma-embedded-patch">` block
 * carrying state JSON, and downloads the result. The loader at the
 * very bottom of the script body (search for "Standalone HTML loader")
 * picks up the embed and calls _applyLoadedPatch before the first
 * render — so opening the exported file replaces the demo patch with
 * the embedded one.
 *
 * Browser autoplay restrictions still apply: audio won't start until
 * the user clicks ▶ in the exported file (same as the editor). The
 * autoLiveMode option auto-enters Live Mode after device acquisition
 * so the visual layer fills the screen on open without a manual
 * toggle. Press L to flip back to the editor.
 *
 * Caveats vs. the roadmap §9 "pre-warmed WGSL pipeline cache" spec:
 * the cache is per-device, can't be serialized portably. WGSL hashes
 * (the cache keys) are the same regardless, so first-frame compile
 * latency on the exported file is identical to the editor's. */
async function exportStandaloneHtml(options) {
  options = options || {};
  const autoLiveMode = options.autoLiveMode !== false;       // default true
  const viewerMode   = options.viewerMode   !== false;       // default true — "stripped viewer"
  const bundleWasm   = options.bundleWasm   !== false;       // default true when viewerMode

  // Viewer mode requires a compiled patch wasm so the page can run
  // self-contained (no daemon, no Wasmer SDK fetch). The wasm bytes
  // are cached in previewState.lastWasm by the realtime / offline
  // render paths (cloned via slice() BEFORE the postMessage transfer
  // -- see the two "previewState.lastWasm = wasmBytes.slice(0)" lines
  // in previewCompileAndPlay).
  //
  // v0.2.25 — if no cached wasm, auto-compile now. Saves the user
  // a manual "click ▶, then click Export" two-step. Uses the same
  // local-cli / Wasmer SDK pipeline as the realtime play path. We
  // report progress through the standalone-button's nameEl + the
  // modal status line via the caller's progress callback below.
  if (viewerMode && bundleWasm) {
    const cached = previewState && previewState.lastWasm && previewState.lastWasm.byteLength;
    if (!cached) {
      try {
        const progress = typeof options.progress === "function" ? options.progress : null;
        if (progress) progress("No cached wasm — compiling patch first…");
        const bytes = await compilePatchForExport(progress);
        if (!bytes || bytes.byteLength === 0) {
          throw new Error("Compile returned empty wasm");
        }
        // Cache for future exports + any subsequent ▶ click.
        previewState.lastWasm = bytes.slice(0);
      } catch (e) {
        throw new Error("Auto-compile for viewer failed: " + (e && e.message || e) +
          ". Start gamma-compile-server or click ▶ first to compile, then retry Export.");
      }
    }
  }

  // 1. Fetch our own HTML. fetch on a file:// URL is blocked by
  //    browsers -- the export must be triggered from an http(s)-
  //    served editor. The standalone OUTPUT, on the other hand,
  //    works from file:// because the wasm + patch are embedded.
  let html;
  try {
    const res = await fetch(location.href, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    html = await res.text();
  } catch (e) {
    throw new Error("Could not fetch editor HTML (" + e.message +
      "). The Export action must be triggered from the editor served via http(s); " +
      "the EXPORTED file then works anywhere (file:// included).");
  }
  if (!/<\/body>/i.test(html)) {
    throw new Error("Self HTML missing </body> -- unexpected file shape");
  }

  // 2. Build the embed blocks. A literal close-script tag inside
  //    embedded JSON would close the parent script prematurely;
  //    escape it to "<\/script>" so the HTML parser sees text but
  //    the JSON round-trip preserves the bytes. (Same reason this
  //    source file writes its own close tags via the CLOSE
  //    constant; otherwise the editor's <script> block closes
  //    mid-function.)
  const patchJson = JSON.stringify(state, _omitRuntimeKeys, 2);
  const safeJson  = patchJson.replace(/<\/script/gi, "<\\/script");
  const cfgJson   = JSON.stringify({
    autoLiveMode,
    viewerMode,
    exportedAt: new Date().toISOString(),
    fromVersion: (typeof APP_VERSION !== "undefined" ? APP_VERSION : "?")
  });
  const CLOSE = "<\/script>";   // see comment above

  let embed =
    '<script type="application/json" id="gamma-embedded-patch">\n' + safeJson + '\n' + CLOSE + '\n' +
    '<script type="application/json" id="gamma-embedded-config">\n' + cfgJson  + '\n' + CLOSE + '\n';

  // 3. Bundle the patch wasm as base64 if viewer mode requested it.
  //    Use chunked btoa to avoid String.fromCharCode.apply argument-
  //    length limits on large buffers (some browsers cap at ~125k
  //    arguments). 32 KB chunks are safe.
  let wasmKb = 0;
  if (viewerMode && bundleWasm && previewState.lastWasm) {
    const u8 = new Uint8Array(previewState.lastWasm);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
    }
    const b64 = btoa(bin);
    wasmKb = u8.length / 1024;
    embed +=
      '<script type="application/octet-stream" id="gamma-embedded-wasm">' + b64 + CLOSE + '\n';
  }

  // 4. Strip any embed left over from a previous export so a re-
  //    export cycle doesn't compound the embed blocks.
  html = html.replace(
    /<script[^>]+id\s*=\s*["']gamma-embedded-(?:patch|config|wasm)["'][^>]*>[\s\S]*?<\/script>\s*/gi,
    ""
  );

  // 5. Insert the fresh embeds BEFORE the main inline editor <script>
  //    (the only <script> tag with no attributes — all the others
  //    have src= or defer). v0.2.24 used </body> here, but that
  //    trailing position meant the main script's boot IIFE ran BEFORE
  //    the parser reached the embed tags + getElementById returned
  //    null -- the exported file opened a blank editor with no patch
  //    loaded. Pre-script injection guarantees the data tags are in
  //    the DOM by the time the IIFE looks them up.
  const scriptInjected = html.replace(/<script>/, embed + "<script>");
  if (scriptInjected === html) {
    throw new Error("Could not locate inline <script> tag in editor HTML — exported file would not auto-load. (Editor source may have changed; please file a bug.)");
  }
  html = scriptInjected;

  // 6. Viewer mode: strip external script/link tags that don't work
  //    from file:// and produce noisy console errors. The viewer
  //    doesn't need any of them:
  //      - coi-serviceworker.min.js relies on serviceworker registration
  //        which file:// disallows; without it crossOriginIsolated is
  //        false + SAB is unavailable, so audio-reactive shaders go
  //        silent. The audio still PLAYS -- visuals just don't react.
  //      - CodeMirror CDN scripts + stylesheets only feed the User DSP
  //        editor which viewer mode hides anyway. The udspEditor init
  //        already guards `typeof CodeMirror === "undefined"`.
  if (viewerMode) {
    html = html.replace(/<script[^>]+src=["']coi-serviceworker[^"']*["'][^>]*>\s*<\/script>\s*/gi, "");
    html = html.replace(/<script[^>]+src=["']https:\/\/cdn\.jsdelivr\.net\/npm\/codemirror[^"']*["'][^>]*>\s*<\/script>\s*/gi, "");
    html = html.replace(/<link[^>]+href=["']https:\/\/cdn\.jsdelivr\.net\/npm\/codemirror[^"']*["'][^>]*\/?>\s*/gi, "");
    // Google Fonts preconnects + stylesheet — emit cross-origin
    // warnings on file:// and aren't structurally required (CSS
    // falls back to system fonts gracefully). Strip in viewer mode
    // for a quieter console; the editor keeps them because the
    // typography matters for the authoring UI.
    html = html.replace(/<link[^>]+rel=["']preconnect["'][^>]*href=["']https:\/\/fonts\.[^"']*["'][^>]*\/?>\s*/gi, "");
    html = html.replace(/<link[^>]+href=["']https:\/\/fonts\.googleapis\.com\/[^"']*["'][^>]*\/?>\s*/gi, "");
  }

  // 7. Update <title> for browser-history/tab-strip identification.
  const className = ((state && state.patchName) || "MyPatch")
    .replace(/[^A-Za-z0-9_-]/g, "");
  const titleTag = viewerMode ? " — Gamma Node viewer" : " — Gamma Node patch";
  html = html.replace(
    /<title>[^<]*<\/title>/i,
    "<title>" + className + titleTag + "</title>"
  );

  return {
    html,
    filename: (viewerMode ? "gamma-viewer-" : "gamma-standalone-") + className + ".html",
    size: html.length,
    wasmKb,
    viewerMode
  };
}

/* =========================================================================
 * v0.2.19 — Export center modal control
 * ======================================================================== */

function _openExportModal() {
  const modal = document.getElementById("export-modal");
  if (!modal) return;
  // Refresh dynamic bits before the user sees the modal:
  //   - preview mode name in the composite-preview sub-line
  //   - target resolution in the per-display action sub-line
  //   - display selector (populated from current state.rig)
  //   - recording-state tag mirrors the HUD pill
  const modeEl = document.getElementById("exp-preview-mode");
  if (modeEl) {
    const pm = (state && state.rig && state.rig.previewMode) || "tile";
    modeEl.textContent = pm === "theater" ? "theater (3D explorable camera)" : pm;
  }
  const dimsEl = document.getElementById("exp-fb-dims");
  if (dimsEl) dimsEl.textContent = (Visual.fbWidth || "?") + "×" + (Visual.fbHeight || "?");
  // Resolved .h filename = patchName sanitized (matches what
  // wrapForPreview + the gen-C++ tab use). Falls back to MyPatch.h.
  const hdrNameEl = document.getElementById("exp-header-name");
  if (hdrNameEl) {
    const className = ((state && state.patchName) || "MyPatch").replace(/[^A-Za-z0-9_]/g, "") || "MyPatch";
    hdrNameEl.textContent = className + ".h";
  }
  const sel = document.getElementById("exp-display-pick");
  if (sel) {
    sel.innerHTML = "";
    const displays = (state && state.rig && state.rig.displays) || [];
    if (displays.length === 0) {
      const opt = document.createElement("option");
      opt.value = "-1";
      opt.textContent = "(no rig displays)";
      opt.disabled = true;
      sel.appendChild(opt);
    } else {
      for (let i = 0; i < displays.length; i++) {
        const d = displays[i];
        const name = d && (d.name || d.id) ? (d.name || d.id) : "display " + i;
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = "Display " + String(i).padStart(2, "0") + " — " + name +
          "   " + (Visual.fbWidth || "?") + "×" + (Visual.fbHeight || "?");
        sel.appendChild(opt);
      }
    }
  }
  const tag = document.getElementById("exp-rec-state-tag");
  if (tag) tag.style.display = _videoRecorder ? "inline-block" : "none";
  // v0.2.21 — per-display rec state + dims, audio render context info.
  const pdDimsEl = document.getElementById("exp-rec-pd-dims");
  if (pdDimsEl) pdDimsEl.textContent = (Visual.fbWidth || "?") + "×" + (Visual.fbHeight || "?");
  _updatePerDisplayRecUi(perDisplayRecordingActive());
  const srEl = document.getElementById("exp-audio-sr");
  if (srEl) {
    const sr = (previewState && previewState.audioCtx && previewState.audioCtx.sampleRate) || 48000;
    srEl.textContent = String(sr);
  }
  const status = document.getElementById("exp-status");
  if (status) { status.textContent = ""; status.className = "export-status"; }
  modal.style.display = "flex";
}

function _closeExportModal() {
  const modal = document.getElementById("export-modal");
  if (modal) modal.style.display = "none";
}

function _setExportStatus(msg, kind) {
  const el = document.getElementById("exp-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "export-status" + (kind ? " " + kind : "");
}

const PREVIEW = {
  // URL of the pre-built Gamma static-library tarball. Produce locally
  // via wasm-build/build-gamma-wasm.sh and host it under /assets/ on the
  // same origin as the editor. See wasm-build/README.md.
  gammaArchiveUrl: "assets/gamma-wasm-v3.tar.gz",
  gammaArchiveCacheKey: "gamma-wasm-archive-v3",
  // Wasmer SDK — pinned via unpkg (NOT esm.run; the latter rebundles
  // and breaks the SDK's relative-URL lookup of its sibling WASM blob,
  // which surfaces as "WebAssembly: HTTP status code is not ok" on
  // init()). Matches the canonical example in
  // https://wasmer.io/posts/clang-in-browser
  wasmerSdkUrl: "https://unpkg.com/@wasmer/sdk@0.10.0/dist/index.mjs",
  // Local compile-server (the gamma-compile-server npm package, runs
  // as a daemon on the user's machine). When detected via the health
  // probe at first Play click, compile requests route there instead
  // of the in-browser Wasmer path — full Emscripten, ~5–15 s per
  // compile, sidesteps the in-browser OOM. See the package README:
  //   github.com/9LiveZZZ-Git/gamma-compile-server
  localServerUrl: "http://localhost:8765",
  localServerProbeTimeoutMs: 250,
  // Compile debounce after a graph mutation.
  hotReloadDebounceMs: 250,
  // Audio quantum (Web Audio standard).
  quantumFrames: 128
};

const previewState = {
  state: "idle",          // idle | compiling | playing | paused | error
  audioCtx: null,
  workletNode: null,
  worker: null,
  workerReady: null,      // Promise that resolves when worker is ready
  pendingCompile: null,   // debounce timer
  lastWrapped: null,      // last wrapped C++ string we sent to compile
  archiveBuffer: null     // ArrayBuffer of the Gamma tarball (cached after first fetch)
};

