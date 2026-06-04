/* =========================================================================
 * Phase 6.5.1 — Audio bridge (SharedArrayBuffer between worklet + main)
 *
 * Layout (4 KB total, indexed as Int32 + Float32 views over the same SAB):
 *   Header (8 × i32 = 32 bytes):
 *     [0] magic 'GAMA' (0x474D4143)
 *     [1] version (1)
 *     [2] frame counter (Atomics-incremented per audio quantum)
 *     [3] sample rate reinterpret as i32 (read via Float32 view)
 *     [4..7] reserved
 *   Scalars (16 × f32 at indices 8..23):
 *     16 scalar bridge slots. 6.5.2 EnvFollow / 6.5.4 Clock / future
 *     audio-rate-to-uniform nodes register their slot here.
 *   FFT bins (256 × f32 at indices 24..279):
 *     6.5.3 FFTBins writes magnitude bins per quantum.
 *   Remaining bytes 1120..4095 reserved for future expansion (waveform
 *     buffer, gate triggers, etc.).
 *
 * Concurrency model: the worklet is the SOLE writer for slots; the main
 * thread READS only. Atomics.add on the frame counter (index 2) signals
 * "new quantum is in", but each f32 slot read is naturally tear-free at
 * 32-bit alignment so we don't need locks for scalar values. The main
 * thread reads once per requestAnimationFrame and writes to GPU uniform
 * buffers; the worklet runs at audio-quantum rate (~2.7 ms at 48k/128).
 *
 * Slot allocation strategy (deferred to 6.5.2+): each bridge node
 * registers a slot via audioBridge.allocScalar() which returns a stable
 * index. The slot index is baked into the codegen so the wasm-side
 * tick function writes to bridgeFloats[8 + slotIdx]. For 6.5.1 (this
 * commit) the worklet writes ONE smoke-test value (master peak from
 * the audio output buffer) to slot 0 so we can verify the plumbing
 * round-trips before wiring it to shader-frag uniforms. */
const AUDIO_BRIDGE_SAB_BYTES   = 4096;
const AUDIO_BRIDGE_SCALAR_BASE = 8;       // f32 index of slot 0
const AUDIO_BRIDGE_SCALAR_COUNT = 16;
const AUDIO_BRIDGE_FFT_BASE    = 24;      // f32 index of FFT bin 0
const AUDIO_BRIDGE_FFT_COUNT   = 256;
const AUDIO_BRIDGE_MAGIC       = 0x474D4143;  // 'GAMA' little-endian

const audioBridge = {
  sab:        null,
  floats:     null,   // Float32Array view over the whole SAB
  ints:       null,   // Int32Array view over the whole SAB
  available:  false,
  // 6.5.1 — fixed slot assignment so the main thread can read a known
  // value without waiting for a registration handshake. 6.5.2+ will
  // formalize allocation via the EnvFollow/Clock/FFT bridge nodes.
  TEST_MASTER_PEAK_SLOT: 0,

  init() {
    if (this.sab) return true;
    // SharedArrayBuffer needs cross-origin isolation (COOP/COEP). The
    // editor's coi-serviceworker turns this on in production; if it
    // isn't active the bridge stays disabled and readScalar() returns
    // 0. Bridge nodes that depend on it can still ship; they just
    // produce zero until the user gets COOP/COEP right.
    if (typeof SharedArrayBuffer === "undefined" ||
        typeof self !== "undefined" && !self.crossOriginIsolated) {
      this.available = false;
      console.warn("[audio-bridge] SharedArrayBuffer unavailable -- " +
                   "crossOriginIsolated=" + (typeof self !== "undefined" ? self.crossOriginIsolated : "n/a") +
                   "; bridge stays disabled");
      return false;
    }
    try {
      this.sab    = new SharedArrayBuffer(AUDIO_BRIDGE_SAB_BYTES);
      this.floats = new Float32Array(this.sab);
      this.ints   = new Int32Array(this.sab);
      this.ints[0] = AUDIO_BRIDGE_MAGIC;
      this.ints[1] = 1;
      this.ints[2] = 0;
      this.available = true;
      console.log("[audio-bridge] SAB allocated, " + AUDIO_BRIDGE_SAB_BYTES + " B, " +
                  AUDIO_BRIDGE_SCALAR_COUNT + " scalar slots + " +
                  AUDIO_BRIDGE_FFT_COUNT + " FFT bins");
      return true;
    } catch (e) {
      this.available = false;
      console.warn("[audio-bridge] SAB allocation failed:", e);
      return false;
    }
  },

  /* Read a scalar bridge slot. Returns 0 when the bridge isn't
   * available or idx is out of range. Tear-free at 32-bit alignment;
   * stale data is acceptable -- the worklet always writes the latest
   * value, so a read just gets whatever the most recent quantum saw. */
  readScalar(idx) {
    if (!this.available || idx < 0 || idx >= AUDIO_BRIDGE_SCALAR_COUNT) return 0;
    return this.floats[AUDIO_BRIDGE_SCALAR_BASE + idx];
  },

  /* Read one FFT magnitude bin. Same tear-free + stale-OK contract. */
  readFftBin(idx) {
    if (!this.available || idx < 0 || idx >= AUDIO_BRIDGE_FFT_COUNT) return 0;
    return this.floats[AUDIO_BRIDGE_FFT_BASE + idx];
  },

  /* Atomically read the per-quantum frame counter. Diagnostic /
   * health-check: if this doesn't tick over multiple rAF frames, the
   * worklet isn't writing (audio is dead or the worklet hasn't
   * received the bridge-init message yet). */
  frameCounter() {
    if (!this.available) return 0;
    return Atomics.load(this.ints, 2);
  }
};

const previewBtnPlay = document.getElementById("btn-preview-play");
const previewBtnStop = document.getElementById("btn-preview-stop");
const previewStatusEl = document.getElementById("preview-status");
const previewGroupEl = previewBtnPlay && previewBtnPlay.closest(".preview-group");

/* ------------- Compile progress tracker ------------- */
/* Stage list ordered by execution. `baseline` is the first-run estimate
 * in milliseconds; after a successful compile the actual measured time
 * is cached to localStorage and overrides the baseline next session,
 * so ETAs become honest (cached clang load is ~5 s, not 3 min). */
const PREVIEW_STAGES = [
  { id: "prepare",     label: "preparing",                    baseline: 200    },
  { id: "import-sdk",  label: "loading Wasmer SDK",           baseline: 1500   },
  { id: "init-sdk",    label: "initializing runtime",         baseline: 800    },
  { id: "load-clang",  label: "loading clang/clang package",  baseline: 180000 },
  { id: "fetch-gamma", label: "fetching Gamma archive",       baseline: 800    },
  { id: "extract",     label: "extracting + staging",         baseline: 300    },
  { id: "write-patch", label: "writing patch source",         baseline: 50     },
  { id: "compile",     label: "invoking clang + linking",     baseline: 12000  },
  { id: "load-wasm",   label: "loading audio worklet",        baseline: 200    }
];
const PREVIEW_BASELINE_KEY = "gamma-preview-stage-times-v1";

(function loadCachedBaselines() {
  try {
    const raw = localStorage.getItem(PREVIEW_BASELINE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw);
    PREVIEW_STAGES.forEach(s => {
      if (typeof cached[s.id] === "number" && cached[s.id] > 0) {
        s.baseline = cached[s.id];
      }
    });
  } catch (_) {}
})();

const previewProgress = {
  startTime: 0,
  stageIdx: -1,
  stageStart: 0,
  subProgress: 0,    // 0..1, or 0 for "unknown / indeterminate"
  tickerId: null
};

function fmtDuration(ms) {
  if (ms < 950) return Math.max(0, Math.round(ms)) + "ms";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const sr = s % 60;
  return m + "m " + (sr < 10 ? "0" : "") + sr + "s";
}

function previewProgressShow() {
  const el = document.getElementById("preview-progress");
  if (el) el.style.display = "inline-flex";
}
function previewProgressHide() {
  const el = document.getElementById("preview-progress");
  if (el) el.style.display = "none";
}

function previewProgressStart() {
  previewProgress.startTime = Date.now();
  previewProgress.stageIdx = -1;
  previewProgress.subProgress = 0;
  previewProgressShow();
  if (previewProgress.tickerId) clearInterval(previewProgress.tickerId);
  previewProgress.tickerId = setInterval(previewProgressTick, 250);
  previewProgressTick();
}

function previewProgressEnd(saveBaselines) {
  if (previewProgress.tickerId) clearInterval(previewProgress.tickerId);
  previewProgress.tickerId = null;
  if (saveBaselines) {
    // Mark the in-flight stage as completed too.
    if (previewProgress.stageIdx >= 0) {
      const cur = PREVIEW_STAGES[previewProgress.stageIdx];
      cur.lastMeasured = Date.now() - previewProgress.stageStart;
    }
    try {
      const out = {};
      PREVIEW_STAGES.forEach(s => {
        if (s.lastMeasured > 0) out[s.id] = s.lastMeasured;
      });
      localStorage.setItem(PREVIEW_BASELINE_KEY, JSON.stringify(out));
    } catch (_) {}
  }
  previewProgressHide();
}

function previewProgressStage(stageId, sub) {
  // Record actual time for the previously active stage.
  if (previewProgress.stageIdx >= 0) {
    const prev = PREVIEW_STAGES[previewProgress.stageIdx];
    prev.lastMeasured = Date.now() - previewProgress.stageStart;
  }
  const idx = PREVIEW_STAGES.findIndex(s => s.id === stageId);
  if (idx < 0) return;   // unknown stage id — ignore
  previewProgress.stageIdx = idx;
  previewProgress.stageStart = Date.now();
  previewProgress.subProgress = (typeof sub === "number" && sub > 0) ? Math.min(1, sub) : 0;
  previewProgressTick();
}

function previewProgressSub(sub) {
  if (typeof sub !== "number") return;
  previewProgress.subProgress = Math.max(0, Math.min(1, sub));
  previewProgressTick();
}

function previewProgressTick() {
  if (previewProgress.stageIdx < 0) return;
  const fill = document.getElementById("preview-progress-fill");
  const meta = document.getElementById("preview-progress-meta");
  if (!fill || !meta) return;

  const totalBaseline = PREVIEW_STAGES.reduce((s, x) => s + x.baseline, 0);
  const completedBaseline = PREVIEW_STAGES
    .slice(0, previewProgress.stageIdx)
    .reduce((s, x) => s + x.baseline, 0);
  const stage = PREVIEW_STAGES[previewProgress.stageIdx];
  const stageElapsed = Date.now() - previewProgress.stageStart;

  // Stage contribution: real fraction if known, else time-based estimate
  // capped at 90% so an over-running stage doesn't wedge the bar at 100%.
  let stageContribution;
  let indeterminate = false;
  if (previewProgress.subProgress > 0) {
    stageContribution = stage.baseline * previewProgress.subProgress;
  } else {
    indeterminate = true;
    stageContribution = Math.min(stage.baseline * 0.9, stageElapsed);
  }
  const totalContribution = completedBaseline + stageContribution;
  const fraction = Math.min(0.99, totalContribution / totalBaseline);

  fill.classList.toggle("indeterminate", indeterminate);
  if (!indeterminate) {
    fill.style.width = (fraction * 100).toFixed(1) + "%";
  }

  const elapsed = Date.now() - previewProgress.startTime;
  const remaining = Math.max(0, totalBaseline - totalContribution);
  meta.innerHTML =
    `<span class="stage-name">${stage.label}</span> · ` +
    `${previewProgress.stageIdx + 1}/${PREVIEW_STAGES.length} · ` +
    `${fmtDuration(elapsed)} elapsed · ` +
    `<span class="eta">~${fmtDuration(remaining)} left</span>`;
}

function previewProgressFinish() {
  // Snap bar to 100% briefly before hiding.
  const fill = document.getElementById("preview-progress-fill");
  if (fill) {
    fill.classList.remove("indeterminate");
    fill.style.width = "100%";
  }
  setTimeout(() => previewProgressEnd(true), 450);
}

function setPreviewStatus(state, msg) {
  const prev = previewState.state;
  previewState.state = state;
  previewState.lastStatusMsg = msg || state;
  if (state === "error") previewState.lastErrorMsg = msg || state;
  // Touchscreen-popup status pip mirrors playing<->stopped.
  if (prev !== state && typeof _pushTouchControlsSnapshot === "function") {
    _pushTouchControlsSnapshot();
  }
  // Console timeline so the pipeline is visible in DevTools too —
  // useful when the pill text is truncated or moves too fast.
  console.log("[preview] " + state + (msg ? " — " + msg : ""));
  if (!previewStatusEl) return;
  previewStatusEl.className = "preview-status " + state;
  previewStatusEl.textContent = msg || state;
  if (previewGroupEl) {
    previewGroupEl.classList.remove("compiling", "playing", "paused", "error");
    if (state !== "idle") previewGroupEl.classList.add(state);
  }
  if (previewBtnStop) {
    previewBtnStop.disabled = !(state === "playing" || state === "paused" || state === "compiling");
  }
  if (previewBtnPlay) {
    previewBtnPlay.textContent = state === "playing" ? "❚❚" : "▶";
    previewBtnPlay.title = state === "playing"
      ? "Pause playback"
      : state === "paused"
        ? "Resume playback"
        : "Compile patch and start playback";
  }
  const copyBtn = document.getElementById("btn-copy-status");
  if (copyBtn) {
    // Show whenever there's anything worth sharing — useful during
    // long compiles so you can paste the current step without waiting
    // for it to error out.
    copyBtn.style.display = state === "idle" ? "none" : "inline-flex";
    copyBtn.title = state === "error"
      ? "Copy error message + last patch C++"
      : "Copy current preview state";
  }
}

/* Copy-error helpers — flash button green for 1s on success. */
function flashCopied(btn, oldLabel) {
  btn.classList.add("copied");
  const prevText = btn.textContent;
  if (oldLabel !== undefined) btn.textContent = oldLabel;
  setTimeout(() => {
    btn.classList.remove("copied");
    if (oldLabel !== undefined) btn.textContent = prevText;
  }, 1200);
}

(function setupCopyButtons() {
  const copyStatusBtn = document.getElementById("btn-copy-status");
  if (copyStatusBtn) copyStatusBtn.addEventListener("click", async () => {
    // Bundle the current state with patch info + diagnostic context so
    // a single paste is enough to debug from. Works equally well during
    // a long compile (shows what step we're on) or after an error.
    const lines = [];
    const headerLabel = previewState.state === "error" ? "preview error" : "preview state";
    lines.push("Gamma Node Editor v" + APP_VERSION + " — " + headerLabel);
    lines.push("UA: " + navigator.userAgent);
    lines.push("crossOriginIsolated: " + (typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : "(undefined)"));
    lines.push("SharedArrayBuffer: " + (typeof SharedArrayBuffer !== "undefined" ? "available" : "missing"));
    lines.push("State: " + previewState.state);
    lines.push("Pill: " + (previewState.lastStatusMsg || "(none)"));
    if (previewState.lastErrorMsg) {
      lines.push("Last error: " + previewState.lastErrorMsg);
    }
    // Pull whatever the Build pane's compile-output section is showing.
    // That's where compile-error / warnings stderr is rendered, so the
    // header copy now includes it without making the user switch tabs.
    const stderrEl = document.getElementById("build-stderr");
    const stderrText = stderrEl ? (stderrEl.textContent || "").trim() : "";
    if (stderrText) {
      lines.push("");
      lines.push("--- compile output (clang stderr) ---");
      lines.push(stderrText);
    }
    if (previewState.lastWrapped) {
      lines.push("");
      lines.push("--- last wrapped patch C++ ---");
      lines.push(previewState.lastWrapped);
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(copyStatusBtn, "✓");
    } catch (e) {
      copyStatusBtn.title = "Copy failed: " + e.message;
    }
  });

  const copyStderrBtn = document.getElementById("btn-copy-stderr");
  if (copyStderrBtn) copyStderrBtn.addEventListener("click", async () => {
    const out = document.getElementById("build-stderr");
    if (!out) return;
    const lines = [];
    lines.push("Gamma Node Editor v" + APP_VERSION + " — build output");
    lines.push("UA: " + navigator.userAgent);
    lines.push("");
    lines.push(out.textContent);
    if (previewState.lastWrapped) {
      lines.push("");
      lines.push("--- last wrapped patch C++ ---");
      lines.push(previewState.lastWrapped);
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      flashCopied(copyStderrBtn, "✓ Copied");
    } catch (e) {
      copyStderrBtn.textContent = "✗ " + e.message;
    }
  });
})();

/* ------------- Adapter wrapper ------------- */
/* Wraps the editor's emitted patch class in a C-linkage shim that the
 * worklet can call. The setter table maps exposed-setter index → name,
 * so the main thread can post {setterIndex, value} without re-stringifying
 * setter names on every parameter change. */
function collectExposedSetters() {
  // Mirrors generateCode's setter-emission loop. Returns
  // [{name, isGate, nodeId, key, nodeType}] in the SAME order
  // generateCode emits — so index N here corresponds to the index
  // the wasm switch dispatches on. The keyboard handler uses nodeId
  // + key to find the freq setter for a KeyboardIn node.
  const setters = [];
  const used = new Set();
  state.nodes.forEach(n => {
    const def = defOf(n);
    if (!def || !def.cppType) return;
    const auto = def.autoExpose || [];
    const uiOnly = def.uiOnlyParams || [];
    Object.keys(n.params).forEach(k => {
      if (uiOnly.includes(k)) return;
      if (!state.exposed[n.id + "." + k] && !auto.includes(k)) return;
      if (def.paramOptions && def.paramOptions[k]) return;
      let name = k;
      if (used.has(name)) name = n.id + "_" + k;
      used.add(name);
      setters.push({ name, isGate: false, nodeId: n.id, key: k, nodeType: n.type });
    });
    def.ins.forEach(p => {
      if (p.t !== "gate") return;
      if (!state.exposed[n.id + "." + p.n] && !auto.includes(p.n)) return;
      let name = p.n === "trig" ? "trigger" : p.n;
      if (used.has(name)) name = name + "_" + n.id;
      used.add(name);
      setters.push({ name, isGate: true, nodeId: n.id, key: p.n, nodeType: n.type });
    });
    (def.hostGates || []).forEach(gn => {
      let name = gn === "trig" ? "trigger" : gn;
      if (used.has(name)) name = name + "_" + n.id;
      used.add(name);
      setters.push({ name, isGate: true, nodeId: n.id, key: gn, nodeType: n.type });
    });
  });
  return setters;
}

function wrapForPreview(patchSource, className) {
  className = className || "MyPatch";
  const setters = collectExposedSetters();
  // Detect stereo vs mono by scanning the return type the patch class
  // declared. Supports the existing OutputStereo / Output sinks.
  const isStereo = /std::pair<float,float>\s+operator/.test(patchSource);

  let setterDispatch = "";
  let gateAutoFireBody = "";
  setters.forEach((s, i) => {
    if (s.isGate) {
      setterDispatch += `        case ${i}: gPatch->${s.name}(); break;\n`;
      // Fire each gate once at init so envelopes etc. are audible
      // by default. Without this, the demo patch (Sine × AD →
      // BiquadLP → Output) is silent because the AD never resets.
      // Re-trigger via preview_set(<gate index>, 0) from the worklet
      // (e.g. driven by a future MasterClock node).
      gateAutoFireBody += `    gPatch->${s.name}();\n`;
    } else {
      setterDispatch += `        case ${i}: gPatch->${s.name}(v); break;\n`;
    }
  });

  // Mic-input wiring — if the patch has at least one MicInput node,
  // generateCode added a setMicInput() method to the patch class.
  // The wrapper allocates a fixed mic buffer + exports a getter so
  // the worklet can write per-block input audio into it; the tick
  // body then calls gPatch->setMicInput(...) per sample before the
  // operator() call. Without MicInput we skip all of this so patches
  // with no live input still compile to the lean fixed shape.
  const hasMicInput = state.nodes.some(n => n.type === "MicInput");
  const micPrefix = hasMicInput
    ? `        if (i < gMicLen) gPatch->setMicInput(gMicBuf[i]);
`
    : "";
  // v0.3.19 — VideoSrc per-sample dispatch. One pair of setVidL_N /
  // setVidR_N calls per audio-wired VideoFile / Webcam node. The
  // worklet's process() writes inputs[1][2N..2N+1] into the matching
  // wasm buffer pair (gVidBufNL / gVidBufNR) at the top of each
  // quantum; here we drain them per sample BEFORE gPatch's operator()
  // runs so any downstream member node binds against the latest
  // sample. gVidLen mirrors the actual worklet quantum size for
  // safety against future quantum-length changes.
  const vidWrapSrc = (typeof _videoAudioSrcNodes === "function") ? _videoAudioSrcNodes() : [];
  const vidPrefix = vidWrapSrc.length
    ? `        if (i < gVidLen) {
${vidWrapSrc.map((n, idx) =>
    `            gPatch->setVidL_${idx}(gVidBuf${idx}L[i]);
            gPatch->setVidR_${idx}(gVidBuf${idx}R[i]);`
  ).join('\n')}
        }
`
    : "";
  const tickBody = isStereo
    ? `${micPrefix}${vidPrefix}        auto p = (*gPatch)();
        outL[i] = p.first;
        outR[i] = p.second;`
    : `${micPrefix}${vidPrefix}        float s = (*gPatch)();
        outL[i] = s;
        outR[i] = s;`;

  // Mic-buffer module-scope storage + exports. Buffer is sized at
  // 2048 (well above any reasonable AudioWorklet block size — 128
  // is typical, max 1024 in current Chromium). Worklet writes via
  // direct heap access (Float32Array view over wasm memory) for
  // zero-copy performance; preview_set_mic_len tells the wasm side
  // how many samples are actually valid this tick.
  const micGlobals = hasMicInput
    ? `static float gMicBuf[2048];
static int   gMicLen = 0;

PREVIEW_EXPORT(preview_get_mic_buf) const float* preview_get_mic_buf() { return gMicBuf; }
PREVIEW_EXPORT(preview_set_mic_len) void preview_set_mic_len(int n) {
    if (n < 0) n = 0;
    if (n > 2048) n = 2048;
    gMicLen = n;
}
`
    : "";

  // v0.3.19 — VideoSrc per-source ring buffers. One stereo pair per
  // audio-wired VideoFile / Webcam node. preview_get_vid_buf_N_l/r
  // returns the buffer pointer (queried by the worklet after load);
  // preview_set_vid_len mirrors the quantum size. Buffers sized 2048
  // matching the mic-buf safety margin.
  const vidGlobals = vidWrapSrc.length
    ? vidWrapSrc.map((_, idx) =>
        `static float gVidBuf${idx}L[2048];
static float gVidBuf${idx}R[2048];
PREVIEW_EXPORT(preview_get_vid_buf_${idx}_l) const float* preview_get_vid_buf_${idx}_l() { return gVidBuf${idx}L; }
PREVIEW_EXPORT(preview_get_vid_buf_${idx}_r) const float* preview_get_vid_buf_${idx}_r() { return gVidBuf${idx}R; }`
      ).join('\n') +
      `\nstatic int gVidLen = 0;
PREVIEW_EXPORT(preview_set_vid_len) void preview_set_vid_len(int n) {
    if (n < 0) n = 0;
    if (n > 2048) n = 2048;
    gVidLen = n;
}
`
    : "";

  return `${patchSource}

// ---- Preview adapter (auto-generated, do not edit) ----
// Uses Clang's export_name attribute so the resulting WASM module
// exports the right symbols for any wasm32 target (WASI / Emscripten /
// freestanding) without depending on emscripten.h.
#define PREVIEW_EXPORT(name) __attribute__((export_name(#name)))

// Override new/delete to call malloc/free directly. Without this
// libc++'s operator-new templates get instantiated and pull in a huge
// amount of header parsing (typeinfo, exception machinery, the lot).
// Patches don't need any of it; one MyPatch alloc + free at init.
extern "C" void* malloc(unsigned long);
extern "C" void  free(void*);
inline void* operator new(unsigned long n) { return malloc(n); }
inline void  operator delete(void* p) noexcept { free(p); }
inline void  operator delete(void* p, unsigned long) noexcept { free(p); }

static ${className}* gPatch = nullptr;

extern "C" {

${micGlobals}${vidGlobals}// Gamma's units cache per-sample increments at construction time from
// the global Domain. Without an explicit sample-rate set the Domain
// defaults to 1.0, which makes Sine play at the wrong pitch and AD
// complete its envelope in a single sample (audibly silent). The
// worklet calls preview_set_sr with the AudioContext's real rate
// BEFORE preview_init; preview_init also falls back to 48 kHz on
// its own as a safety net.
PREVIEW_EXPORT(preview_set_sr) void preview_set_sr(float sr) {
    if (sr > 0.f) gam::sampleRate(sr);
}

PREVIEW_EXPORT(preview_init) void preview_init() {
    if (gam::sampleRate() <= 1.0) gam::sampleRate(48000.0);
    if (gPatch) delete gPatch;
    gPatch = new ${className}();
${gateAutoFireBody}}

PREVIEW_EXPORT(preview_tick) void preview_tick(float* outL, float* outR, int n) {
    if (!gPatch) return;
    for (int i = 0; i < n; ++i) {
${tickBody}
    }
}

PREVIEW_EXPORT(preview_set) void preview_set(int setterIndex, float v) {
    if (!gPatch) return;
    switch (setterIndex) {
${setterDispatch}        default: break;
    }
}

PREVIEW_EXPORT(preview_setter_count) int preview_setter_count() { return ${setters.length}; }

}  // extern "C"
`;
}

/* ------------- Build pane renderer ------------- */
function renderBuildPane() {
  const wrapOut = document.getElementById("build-wrap-out");
  const wrapInfo = document.getElementById("build-wrap-info");
  if (!wrapOut) return;
  let patchCpp;
  try {
    patchCpp = generateCode();
  } catch (e) {
    wrapOut.textContent = "// generateCode failed: " + e.message;
    return;
  }
  // If generateCode returned a build-error comment block (cycle without
  // Delay1), surface it as-is.
  if (patchCpp.startsWith("// ❌")) {
    wrapOut.textContent = patchCpp;
    if (wrapInfo) wrapInfo.textContent = "";
    return;
  }
  const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
  const wrapped = wrapForPreview(patchCpp, className);
  wrapOut.innerHTML = highlightCpp(wrapped);
  if (wrapInfo) {
    const setters = collectExposedSetters();
    wrapInfo.textContent = `· ${wrapped.length} chars · ${setters.length} setter${setters.length===1?"":"s"}`;
  }
}

/* ------------- Compile Worker ------------- */
/* The worker is created from a Blob URL containing the compile-pipeline
 * code. This keeps the editor a single self-contained HTML file.
 *
 * Pipeline inside the worker:
 *   1. Dynamic-import @wasmer/sdk from esm.run (~few MB, cached by browser).
 *   2. wasmer.init() initializes the WebAssembly runtime.
 *   3. Wasmer.fromRegistry("clang/clang") downloads the clang/clang
 *      package on first use (~100 MB, cached in IndexedDB).
 *   4. Fetch the libgamma.a tarball, decompress (DecompressionStream),
 *      parse the tar to a flat file map, write each entry into a
 *      Wasmer Directory at /project/...
 *   5. Write the wrapped patch C++ to /project/patch.cpp.
 *   6. clang.entrypoint.run({ args: [...], mount: { "/project": dir } });
 *      args invoke clang against patch.cpp + libgamma.a → patch.wasm.
 *   7. dir.readFile("patch.wasm") → return bytes to main thread. */
const COMPILE_WORKER_SRC = String.raw`
let wasmerMod = null;
let clangPkg = null;
let projectDir = null;
let archiveStagedFor = null;   // archive URL we last staged from

function progress(stage, sub) {
  self.postMessage({ type: "progress", stage, subProgress: sub });
}

async function ensureWasmer(sdkUrl) {
  if (wasmerMod) return wasmerMod;
  if (typeof SharedArrayBuffer === "undefined" || !self.crossOriginIsolated) {
    throw new Error(
      "Cross-origin isolation is not active. The page needs to be served " +
      "with COOP=same-origin and COEP=require-corp headers. The included " +
      "coi-serviceworker should install + reload the page on first visit; " +
      "if you see this error, try reloading once more, or open the page " +
      "in a fresh tab. crossOriginIsolated=" + self.crossOriginIsolated
    );
  }
  progress("import-sdk");
  wasmerMod = await import(sdkUrl);
  progress("init-sdk");
  await wasmerMod.init();
  return wasmerMod;
}

async function ensureClang() {
  if (clangPkg) return clangPkg;
  progress("load-clang");
  clangPkg = await wasmerMod.Wasmer.fromRegistry("clang/clang");
  return clangPkg;
}

/* Minimal tar parser for the gamma-wasm archive — handles the small set
 * of header types our build script actually emits (regular files +
 * directories). Each tar header is a 512-byte block; file content
 * follows, padded up to the next 512-byte boundary. */
function parseTar(buf) {
  const out = [];
  const view = new Uint8Array(buf);
  const td = new TextDecoder();
  let off = 0;
  while (off + 512 <= view.length) {
    const header = view.subarray(off, off + 512);
    // Empty block = end of archive (tar marks end with two zero blocks).
    if (header.every(b => b === 0)) break;
    const name = td.decode(header.subarray(0, 100)).replace(/\0+$/, "");
    if (!name) { off += 512; continue; }
    const sizeStr = td.decode(header.subarray(124, 136)).replace(/[\s\0]+$/, "");
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    off += 512;
    if (typeflag === "0" || typeflag === "" || typeflag === "\0") {
      out.push({ name, content: view.slice(off, off + size) });
    }
    off += size;
    if (size % 512 !== 0) off += 512 - (size % 512);
  }
  return out;
}

async function fetchAndExtract(archiveUrl) {
  progress("fetch-gamma");
  const res = await fetch(archiveUrl);
  if (!res.ok) throw new Error("Gamma archive fetch failed: " + res.status + " from " + archiveUrl);
  // Read the body manually so we can emit byte-level progress. The
  // Content-Length header is the compressed size from GitHub Pages.
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) progress("fetch-gamma", received / total);
  }
  // Reassemble into a single Uint8Array, then decompress.
  const compressed = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { compressed.set(c, off); off += c.length; }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tarBuf = await new Response(stream).arrayBuffer();
  progress("extract");
  return parseTar(tarBuf);
}

async function stageArchive(archiveUrl) {
  if (archiveStagedFor === archiveUrl && projectDir) return projectDir;
  const entries = await fetchAndExtract(archiveUrl);
  projectDir = new wasmerMod.Directory();
  // Wasmer's Directory expects forward-slash paths. createDir is safe
  // to call repeatedly; many implementations no-op on existing dirs.
  for (const entry of entries) {
    const dirParts = entry.name.split("/").slice(0, -1);
    let cur = "";
    for (const p of dirParts) {
      cur = cur ? cur + "/" + p : p;
      try { await projectDir.createDir(cur); } catch (_) { /* already exists */ }
    }
    await projectDir.writeFile(entry.name, entry.content);
  }
  archiveStagedFor = archiveUrl;
  return projectDir;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === "warmup") {
    try {
      await ensureWasmer(msg.sdkUrl);
      // clang loads lazily on first compile (it's the biggest download,
      // so only pay the cost when the user actually clicks Play).
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "error", error: String(e && e.message || e) });
    }
    return;
  }
  if (msg.type === "compile") {
    try {
      await ensureWasmer(msg.sdkUrl);
      await ensureClang();
      const dir = await stageArchive(msg.archiveUrl);

      progress("write-patch");
      // Wipe stale outputs from prior runs so a failing compile can't
      // accidentally hand the AudioWorklet a leftover wasm from an
      // earlier successful run (e.g. smoke output sticking around when
      // a real patch compile fails). Best-effort; missing files OK.
      try { await dir.removeFile("patch.wasm"); } catch (_) {}
      try { await dir.removeFile("patch.json"); } catch (_) {}
      try { await dir.removeFile("patch.o"); }    catch (_) {}
      await dir.writeFile("patch.cpp", new TextEncoder().encode(msg.wrappedSrc));

      progress("compile");
      // Build clang argv. Two pieces are non-obvious for Wasmer's WASI
      // clang and worth flagging for the next time someone reads this:
      //
      //   -mexec-model=reactor:  tells WASI clang we're producing a
      //     library, not an executable. Without it, libc.a's
      //     __main_void.o is pulled in and asks for a main() that
      //     doesn't exist. -Wl,--no-entry alone isn't enough.
      //
      //   -Wl,--export-memory:   the WASM memory object needs its own
      //     dedicated export flag. Trying -Wl,--export=memory does
      //     NOT work — wasm-ld looks for a function symbol named
      //     'memory' and errors out (no such function).
      //
      // Per-function exports (preview_*, smoke) are handled by
      // __attribute__((export_name(...))) in the wrapped source, so
      // we don't need explicit -Wl,--export flags for them. malloc/
      // free are pulled from libc and exported explicitly so the
      // worklet can allocate output buffers.
      //
      // Link against the precompiled libgamma.a (v3 — built offline
      // with WASI-SDK clang at -O2, ABI-matched to Wasmer's WASI
      // clang). Per-patch compile is just patch.cpp + link, so
      // wall-clock is seconds instead of minutes. Currently includes
      // Domain, FFT_fftpack, fftpack++1/2, Timer; the rest of Gamma's
      // .cpp files (Conversion, DFT, Print, arr, scl, Scheduler) hit
      // signal.h / pthread issues building under WASI and need
      // build-time flags (TODO). Patches relying on header-only
      // template classes are unaffected.
      // Single-pass compile+link — two-pass attempt produced
      // "error: unknown integrated tool '-cc1'", meaning Wasmer's
      // clang/clang package can't spawn the cc1 subprocess inside its
      // WASIX sandbox. The package is wired only for one-shot
      // compile+link. So we're back to relying on the pool fitting
      // both phases at once.
      const args = [
        "-std=c++17",
        "-Wno-deprecated-declarations",
        "-Wno-pragma-once-outside-header",
        "-fno-exceptions",
        "-fno-rtti",
        "-fno-stack-protector",
        "-fno-unwind-tables",
        "-fno-asynchronous-unwind-tables",
        "-ftime-trace=/project/patch.json",
        "-mexec-model=reactor",
        "-I", "/project/include",
        "-Wl,--no-entry",
        "-Wl,--export-memory",
        ...(msg.smokeTest ? [] : [
          "-Wl,--export=malloc",
          "-Wl,--export=free"
        ]),
        "/project/patch.cpp",
        ...(msg.smokeTest ? [] : ["/project/lib/libgamma.a"]),
        "-o", "/project/patch.wasm"
      ];

      const instance = await clangPkg.entrypoint.run({
        args,
        mount: { "/project": dir }
      });
      const result = await Promise.race([
        instance.wait(),
        new Promise((_, reject) => setTimeout(() =>
          reject(new Error(
            "clang timed out after 30 minutes. Click ■ to cancel, then try " +
            "the smoke-test (★) to verify the toolchain works on a trivial " +
            "program."
          )), 1800000
        ))
      ]);

      let stderr = "";
      try { stderr = result.stderr || ""; } catch (_) {}
      let stdout = "";
      try { stdout = result.stdout || ""; } catch (_) {}

      // Pull the time-trace JSON if clang wrote one (it does even on
      // non-zero exit when -ftime-trace is set). Boil it down to a
      // few "biggest costs" lines so the user can see exactly which
      // template instantiations dominated the compile time.
      let traceSummary = "";
      try {
        const traceBytes = await dir.readFile("patch.json");
        const traceText = new TextDecoder().decode(traceBytes);
        const trace = JSON.parse(traceText);
        const events = (trace.traceEvents || []).filter(e => e.name && e.dur);
        const byName = new Map();
        for (const ev of events) {
          const key = ev.name + (ev.args && ev.args.detail ? " " + ev.args.detail : "");
          byName.set(key, (byName.get(key) || 0) + ev.dur);
        }
        const sorted = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
        // Plain string concat — backticks here would close the outer
        // String.raw worker template (recurring footgun, see header
        // comment near COMPILE_WORKER_SRC).
        traceSummary = "TOP COMPILE COSTS (microseconds):\n" +
          sorted.map(function(entry) {
            const ms = (entry[1] / 1000).toFixed(0);
            const padded = ms.length < 8 ? " ".repeat(8 - ms.length) + ms : ms;
            return "  " + padded + " ms  " + entry[0];
          }).join("\n");
      } catch (_) { /* trace file not present, fine */ }

      // Try to read the output even if exit != 0; some warnings still
      // produce a usable wasm.
      let wasmBytes = null;
      try {
        wasmBytes = await dir.readFile("patch.wasm");
      } catch (e) {
        throw Object.assign(
          new Error("clang produced no output. exit=" + (result.code !== undefined ? result.code : "?")),
          { stderr: stderr + (stdout ? "\n--- stdout ---\n" + stdout : "") + (traceSummary ? "\n\n" + traceSummary : "") }
        );
      }
      if (result.code !== undefined && result.code !== 0) {
        // Non-zero exit but file exists — probably warnings. Surface stderr
        // but still return the wasm.
        self.postMessage({ type: "warnings", stderr });
      }
      const stderrWithTrace = stderr + (traceSummary ? (stderr ? "\n\n" : "") + traceSummary : "");
      self.postMessage(
        { type: "compiled", wasmBytes: wasmBytes.buffer || wasmBytes, stderr: stderrWithTrace },
        [wasmBytes.buffer || wasmBytes]
      );
    } catch (e) {
      self.postMessage({
        type: "compile-error",
        error: String(e && e.message || e),
        stderr: String(e && e.stderr || "")
      });
    }
  }
};
`;

function ensureCompileWorker() {
  if (previewState.worker) return previewState.workerReady;
  const blob = new Blob([COMPILE_WORKER_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  previewState.worker = new Worker(url, { type: "module" });
  previewState.workerReady = new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      if (ev.data.type === "ready") {
        previewState.worker.removeEventListener("message", onMsg);
        resolve();
      } else if (ev.data.type === "error") {
        previewState.worker.removeEventListener("message", onMsg);
        reject(new Error(ev.data.error));
      }
    };
    previewState.worker.addEventListener("message", onMsg);
  });
  // Kick off warmup with the Wasmer SDK URL + cached archive if we have it.
  previewState.worker.postMessage({
    type: "warmup",
    sdkUrl: PREVIEW.wasmerSdkUrl,
    archive: previewState.archiveBuffer
  });
  return previewState.workerReady;
}

async function fetchGammaArchive() {
  if (previewState.archiveBuffer) return previewState.archiveBuffer;
  const res = await fetch(PREVIEW.gammaArchiveUrl);
  if (!res.ok) {
    throw new Error(
      `Gamma archive not found at ${PREVIEW.gammaArchiveUrl} (${res.status}). ` +
      `Build it locally with wasm-build/build-gamma-wasm.sh and host the ` +
      `output at this URL — see wasm-build/README.md.`
    );
  }
  previewState.archiveBuffer = await res.arrayBuffer();
  return previewState.archiveBuffer;
}

/* ------------- AudioWorklet processor ------------- */
const PREVIEW_PROCESSOR_SRC = String.raw`
class PreviewProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.instance = null;
    this.memory = null;
    this.outLPtr = 0;
    this.outRPtr = 0;
    this.tickFn = null;
    this.setFn = null;
    // Mic input plumbing — populated in loadModule if the wasm exports
    // the preview_get_mic_buf / preview_set_mic_len pair (i.e. patch
    // contains at least one MicInput node). Otherwise stays null and
    // process() skips the mic path entirely.
    this.micBufPtr = 0;
    this.micSetLen = null;
    this.micEnabled = false;
    // v0.3.19 — VideoSrc plumbing. After load, we scan wasm exports
    // for preview_get_vid_buf_N_l / _r pairs and stash the pointers;
    // process() then writes inputs[1] channels into them per quantum.
    // vidBufPtrs is an array of { l: <ptr>, r: <ptr> } indexed by
    // source N. vidSetLen mirrors the quantum length to gVidLen.
    this.vidBufPtrs = [];
    this.vidSetLen = null;
    this.vidEnabled = false;
    // Phase 6.5.1 — audio bridge. The main thread allocates a SAB
    // and posts it once; the worklet keeps the views alive and
    // writes scalar values + (future) FFT bins per quantum. Null
    // until bridge-init arrives; process() guards on it.
    this.bridgeFloats = null;
    this.bridgeInts   = null;
    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "load") this.loadModule(m.wasmBytes).catch(e => {
        this.port.postMessage({ type: "error", error: String(e && e.message || e) });
      });
      else if (m.type === "set" && this.setFn) this.setFn(m.index, m.value);
      else if (m.type === "stop") this.instance = null;
      else if (m.type === "bridge-init" && m.sab) {
        // Stash worklet-side views over the shared buffer. The same
        // bytes the main thread sees; tear-free for 32-bit reads.
        this.bridgeFloats = new Float32Array(m.sab);
        this.bridgeInts   = new Int32Array(m.sab);
      }
    };
  }
  async loadModule(bytes) {
    const wasmModule = await WebAssembly.compile(bytes);
    // Build a permissive imports object accepting any wasm output we
    // might produce: WASI / WASIX (Wasmer clang) / Emscripten. The
    // per-sample audio path shouldn't actually call any of these, so
    // they all stub to no-ops. WebAssembly.instantiate demands every
    // declared import resolve, so we use a Proxy per requested module
    // to synthesize a no-op for any requested name.
    const noop = () => 0;
    const wasmImports = WebAssembly.Module.imports(wasmModule);
    const imports = {};
    for (const im of wasmImports) {
      if (!imports[im.module]) {
        imports[im.module] = new Proxy({}, { get: () => noop });
      }
    }
    const instance = await WebAssembly.instantiate(wasmModule, imports);
    const exp = instance.exports;
    this.memory = exp.memory;
    if (exp._start) try { exp._start(); } catch(e) {}
    // Tell Gamma's master Domain about the actual sample rate BEFORE
    // constructing the patch — every gam::Sine / gam::AD / gam::Biquad
    // caches its per-sample increment from this. Without it the Domain
    // defaults to 1.0 which makes envelopes finish in one sample
    // (audibly silent) and oscillators play at the wrong pitch.
    if (exp.preview_set_sr) try { exp.preview_set_sr(sampleRate); } catch(e) {}
    if (exp.preview_init) exp.preview_init();
    this.tickFn = exp.preview_tick;
    this.setFn  = exp.preview_set;
    if (exp.malloc) {
      this.outLPtr = exp.malloc(128 * 4);
      this.outRPtr = exp.malloc(128 * 4);
    } else {
      this.outLPtr = 1024;
      this.outRPtr = 1024 + 128 * 4;
    }
    // Mic-input wiring — only present when the patch contains a
    // MicInput node (codegen conditionally emits these exports).
    if (exp.preview_get_mic_buf && exp.preview_set_mic_len) {
      this.micBufPtr = exp.preview_get_mic_buf();
      this.micSetLen = exp.preview_set_mic_len;
      this.micEnabled = true;
    } else {
      this.micEnabled = false;
    }
    // v0.3.19 — VideoSrc wiring. Enumerate exports for preview_get_vid_buf_N_l/r
    // pairs (N = 0, 1, ...) until the chain breaks. preview_set_vid_len
    // is shared across all sources. String concat (no template literals)
    // because this code lives inside a String.raw template -- backticks
    // would close the outer literal early.
    this.vidBufPtrs = [];
    let vIdx = 0;
    while (exp["preview_get_vid_buf_" + vIdx + "_l"] && exp["preview_get_vid_buf_" + vIdx + "_r"]) {
      this.vidBufPtrs.push({
        l: exp["preview_get_vid_buf_" + vIdx + "_l"](),
        r: exp["preview_get_vid_buf_" + vIdx + "_r"]()
      });
      vIdx++;
    }
    this.vidSetLen = exp.preview_set_vid_len || null;
    this.vidEnabled = this.vidBufPtrs.length > 0 && !!this.vidSetLen;
    this.instance = instance;
    this.processCount = 0;
    this.diagSent = false;
    const exportNames = Object.keys(exp);
    this.port.postMessage({ type: "loaded", exports: exportNames, micEnabled: this.micEnabled, vidEnabled: this.vidEnabled, vidCount: this.vidBufPtrs.length });
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.instance || !this.tickFn) {
      for (let ch = 0; ch < out.length; ch++) out[ch].fill(0);
      return true;
    }
    // Mic input — write inputs[0][0] into the wasm-side buffer before
    // running the tick. inputs[0] may be empty if no source is
    // connected; in that case set length to 0 so the tick skips the
    // setMicInput call entirely (outputs the patch with zero mic).
    if (this.micEnabled && this.micBufPtr) {
      const inMic = inputs[0] && inputs[0][0];
      const len = inMic ? Math.min(inMic.length, 2048) : 0;
      if (len > 0) {
        const heap = new Float32Array(this.memory.buffer);
        const off = this.micBufPtr >> 2;
        // .set is faster than a per-sample loop — single SIMD-style
        // memcpy under the hood. Both buffers are the same dtype so
        // no conversion happens.
        heap.set(inMic.subarray(0, len), off);
      }
      if (this.micSetLen) this.micSetLen(len);
    }
    // v0.3.19 — VideoSrc input. inputs[1] is the ChannelMerger output
    // from ensureVideoAudioConnected; each source occupies a stereo
    // pair (channels 2N, 2N+1). Write each pair into per-source wasm
    // buffers; the C++ tick wrapper drains them via setVidL_N / _R.
    if (this.vidEnabled) {
      const vidIn = inputs[1];
      let writeLen = 0;
      if (vidIn && vidIn.length > 0) {
        const heap = new Float32Array(this.memory.buffer);
        for (let s = 0; s < this.vidBufPtrs.length; s++) {
          const lCh = vidIn[s * 2];
          const rCh = vidIn[s * 2 + 1];
          // Empty channels (no source connected at that pair) are still
          // declared by the merger; they read as zero-filled or
          // undefined-length depending on Web Audio impl. Guard both.
          if (lCh && lCh.length > 0) {
            const len = Math.min(lCh.length, 2048);
            heap.set(lCh.subarray(0, len), this.vidBufPtrs[s].l >> 2);
            if (len > writeLen) writeLen = len;
          }
          if (rCh && rCh.length > 0) {
            const len = Math.min(rCh.length, 2048);
            heap.set(rCh.subarray(0, len), this.vidBufPtrs[s].r >> 2);
            if (len > writeLen) writeLen = len;
          }
        }
      }
      // Pass actual write length, NOT a fallback to quantum size --
      // if no source connected this quantum, we want the wasm tick
      // to skip the setVidL/setVidR calls entirely (vs reading stale
      // bytes from a previously-populated buffer, which would tick
      // a one-quantum click).
      if (this.vidSetLen) this.vidSetLen(writeLen);
    }
    this.tickFn(this.outLPtr, this.outRPtr, out[0].length);
    const heap = new Float32Array(this.memory.buffer);
    const lOff = this.outLPtr >> 2;
    const rOff = this.outRPtr >> 2;
    out[0].set(heap.subarray(lOff, lOff + out[0].length));
    if (out.length > 1) out[1].set(heap.subarray(rOff, rOff + out[1].length));
    // Phase 6.5.1 — audio bridge smoke test. While Phase 6.5.2+ ships
    // proper EnvFollow / FFT / Clock bridge nodes, this writes the
    // master-output peak (max |L|, |R| over the quantum) to scalar
    // slot 0 so the main thread can verify the SAB plumbing
    // round-trips even before any bridge node is in the patch. Cheap
    // -- one pass over 128 samples per quantum.
    if (this.bridgeFloats) {
      let peak = 0;
      const lBuf = out[0];
      const rBuf = out.length > 1 ? out[1] : null;
      for (let i = 0; i < lBuf.length; i++) {
        const a = lBuf[i] >= 0 ? lBuf[i] : -lBuf[i];
        if (a > peak) peak = a;
        if (rBuf) {
          const b = rBuf[i] >= 0 ? rBuf[i] : -rBuf[i];
          if (b > peak) peak = b;
        }
      }
      this.bridgeFloats[8] = peak;       // scalar slot 0 (AUDIO_BRIDGE_SCALAR_BASE)
      Atomics.add(this.bridgeInts, 2, 1); // bump quantum frame counter
    }
    // After ~50 process calls (~150ms @48k/128) report what the worklet
    // is actually emitting. Lets us tell apart "wasm produces zero" vs
    // "audio path is broken downstream of the worklet".
    if (!this.diagSent && ++this.processCount > 50) {
      this.diagSent = true;
      let peak = 0;
      const slice = heap.subarray(lOff, lOff + out[0].length);
      for (let i = 0; i < slice.length; i++) {
        const a = slice[i] >= 0 ? slice[i] : -slice[i];
        if (a > peak) peak = a;
      }
      this.port.postMessage({
        type: "diag",
        msg: "first-block peak=" + peak.toFixed(6) +
             " s[0..3]=" + slice[0].toFixed(4) + "," + slice[1].toFixed(4) + "," + slice[2].toFixed(4) + "," + slice[3].toFixed(4)
      });
    }
    return true;
  }
}
registerProcessor("gamma-preview-processor", PreviewProcessor);
`;

async function ensureAudioWorklet() {
  if (previewState.workletNode) return previewState.workletNode;
  if (!previewState.audioCtx) previewState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const blob = new Blob([PREVIEW_PROCESSOR_SRC], { type: "application/javascript" });
  const url  = URL.createObjectURL(blob);
  await previewState.audioCtx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(previewState.audioCtx, "gamma-preview-processor", {
    outputChannelCount: [2],
    // 1 input == mic (inputs[0]).
    // v0.3.19 — second input slot is the VideoSrc aggregate (inputs[1]).
    // A ChannelMerger combines all wire-routed VideoFile / Webcam audio
    // sources here (up to MAX_VIDEO_AUDIO_SRC stereo pairs = 8 channels);
    // see ensureVideoAudioConnected. Worklet's process() reads inputs[1]
    // every quantum and writes into per-source wasm buffers.
    numberOfInputs: 2,
    numberOfOutputs: 1
  });

  // Audio routing — worklet → splitter (for L/R metering) → destination.
  // The splitter feeds two analysers (one per channel). The worklet
  // ALSO connects directly to destination so audio reaches the speakers
  // without going through analysers (analysers don't pass audio through
  // to their own output, but they read from input). Actually: the
  // splitter IS in the audio path and downstream nodes hear nothing
  // unless we merge back. Use a separate fan-out: worklet → destination
  // (audio) AND worklet → splitter → analyserL / analyserR (taps only).
  const splitter = previewState.audioCtx.createChannelSplitter(2);
  const analyserL = previewState.audioCtx.createAnalyser();
  const analyserR = previewState.audioCtx.createAnalyser();
  // 16384-point FFT → 8192 bins, ~2.93 Hz/bin at 48 kHz. Maximum
  // useful resolution for steady tones — peaks read as needle-thin
  // single-bin spikes. Window length is 16384/sr ≈ 340 ms, so
  // transients shorter than that smear; this favours sustained
  // sounds over percussive analysis. smoothingTimeConstant left at
  // 0 — we do attack/release in the render loop.
  analyserL.fftSize = 16384; analyserL.smoothingTimeConstant = 0;
  analyserR.fftSize = 16384; analyserR.smoothingTimeConstant = 0;
  // Phase 6.5.3 — separate analyser pair for visual FFT reactivity.
  // 2048 fftSize = 1024 bins, ~23 Hz/bin at 48 kHz, ~43 ms window.
  // Snappy for transient response (kicks register on the frame they
  // hit, instead of smearing across 340 ms like the meter analyser).
  // smoothingTimeConstant = 0.4 gives some inter-frame smoothing so
  // visualizers don't flicker on every sample-level glitch.
  const fftAnalyserL = previewState.audioCtx.createAnalyser();
  const fftAnalyserR = previewState.audioCtx.createAnalyser();
  fftAnalyserL.fftSize = 2048; fftAnalyserL.smoothingTimeConstant = 0.4;
  fftAnalyserR.fftSize = 2048; fftAnalyserR.smoothingTimeConstant = 0.4;
  node.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);
  splitter.connect(fftAnalyserL, 0);
  splitter.connect(fftAnalyserR, 1);
  node.connect(previewState.audioCtx.destination);
  previewState.analyserL = analyserL;
  previewState.analyserR = analyserR;
  previewState.fftAnalyserL = fftAnalyserL;
  previewState.fftAnalyserR = fftAnalyserR;
  startMeterLoop();

  // Phase 6.5.1 — hand the shared bridge SAB to the worklet. Safe to
  // call on every worklet creation; audioBridge.init() is idempotent.
  // If SAB isn't available (no COOP/COEP), init returns false and the
  // worklet's process() guards on this.bridgeFloats being null.
  if (audioBridge.init()) {
    node.port.postMessage({ type: "bridge-init", sab: audioBridge.sab });
  }

  node.port.onmessage = (ev) => {
    if (ev.data.type === "loaded") {
      previewProgressFinish();
      setPreviewStatus("playing", "playing");
      console.log("[preview] worklet exports:", ev.data.exports || "(unknown)");
      console.log("[preview] audio context state:", previewState.audioCtx.state,
                  "sampleRate:", previewState.audioCtx.sampleRate,
                  "destination channelCount:", previewState.audioCtx.destination.channelCount);
    } else if (ev.data.type === "error") {
      previewProgressEnd(false);
      setPreviewStatus("error", "worklet: " + ev.data.error);
    } else if (ev.data.type === "diag") {
      console.log("[preview-diag]", ev.data.msg);
    }
  };
  previewState.workletNode = node;
  return node;
}

/* ------------- Output meter — multi-mode lab instrument ------------- */
/* Reads from the L/R AnalyserNode taps every animation frame and
 * renders one of three views to a single canvas:
 *
 *   vu     — peak + RMS horizontal bars with peak-hold tick, dB readout
 *   scope  — time-domain trace, ~5ms window, phosphor-green line
 *   fft    — log-frequency spectrum, 32 bands, dBFS
 *
 * All modes share the same AnalyserNode infrastructure so switching
 * is instantaneous. dB readouts under the canvas reflect peak.l /
 * peak.r regardless of mode — the canvas is what changes.
 *
 * Doubles as audio-path verification. If the canvas is flat and the
 * dB readouts show −∞ while preview is "playing", the wasm is not
 * producing samples. */
const METER = {
  rafId: null,
  mode: "vu",                  // vu | scope | fft
  peakHoldL: 0, peakHoldR: 0,
  peakDecayPerFrame: 0.985,
  fillDecayPerFrame: 0.92,
  smoothL: 0, smoothR: 0,
  // Per-bin smoothed dB values (sized to analyser.frequencyBinCount when
  // the loop starts). Initialised to FFT_DB_FLOOR so first frames don't
  // draw a misleading transient. Attack rises fast, release falls slow —
  // standard pro-analyzer ballistics.
  fftSmooth: null,
  fftCursor: null,             // { x, y, freq, db } — mouse hover, null when off
  fftLayout: null              // cached pixel→bin map; invalidated on resize
};
// FFT view configuration — pulled out so the render path isn't full of magic numbers.
const FFT_DB_FLOOR  = -90;
const FFT_DB_TOP    = 0;
const FFT_F_MIN     = 30;       // Hz — bottom of log range
const FFT_F_MAX     = 20000;    // Hz — top of log range (clamped to Nyquist)
const FFT_ATTACK    = 0.50;     // 0=instant, 1=never; smaller = snappier rise
const FFT_RELEASE   = 0.93;     // larger = slower fall
const FFT_HZ_GRID   = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FFT_DB_GRID   = [-80, -60, -40, -20, 0];
function dbFromAmp(amp) { if (amp < 1e-5) return -Infinity; return 20 * Math.log10(amp); }
function fmtDb(db) { if (!isFinite(db)) return "−∞"; return (db >= 0 ? "+" : "") + db.toFixed(1); }

function setMeterMode(mode) {
  METER.mode = mode;
  document.querySelectorAll(".monitor-mode-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
}
document.addEventListener("click", (ev) => {
  const t = ev.target.closest(".monitor-mode-tab");
  if (t && t.dataset.mode) setMeterMode(t.dataset.mode);
});

function startMeterLoop() {
  if (METER.rafId) return;
  const meterEl = document.getElementById("monitor-display");
  const canvas  = document.getElementById("meter-canvas");
  const cornerEl = document.getElementById("meter-overlay-corner");
  const dbL     = document.getElementById("meter-db-l");
  const dbR     = document.getElementById("meter-db-r");
  if (!meterEl || !canvas) return;
  meterEl.classList.add("active");
  meterEl.setAttribute("aria-hidden", "false");

  // Internal buffer is 2x the displayed width for crispness on HiDPI.
  // CSS sets the visual size via stretching to the container.
  const ctx = canvas.getContext("2d", { alpha: false });
  const W = canvas.width, H = canvas.height;
  const bufL = new Float32Array(previewState.analyserL.fftSize);
  const bufR = new Float32Array(previewState.analyserR.fftSize);
  const fftL = new Float32Array(previewState.analyserL.frequencyBinCount);

  // Canvas colors — phosphor lab instrument.
  const COL_PH  = "#c8e85a";                  // primary trace
  const COL_PHA = "rgba(200,232,90,0.55)";    // bar frame
  const COL_PHB = "rgba(200,232,90,0.18)";    // tick lines / grid
  const COL_BG  = "#050608";                  // panel bg
  const COL_TX  = "rgba(200,232,90,0.30)";    // tick labels
  const COL_HI  = "rgba(230,227,220,0.95)";   // peak-hold tick (warm white)
  const COL_AMB = "rgba(255,179,71,0.95)";    // warning band
  const COL_RED = "rgba(226,75,74,0.95)";     // clip band

  // FFT spectrum analyzer — pro-tool style.
  //
  // Rendering strategy: for each x-pixel inside the plot area, find the
  // bin range that maps to the log-frequency span [f, f_next]. Take the
  // max-magnitude bin in that range so spectral peaks survive the
  // downsampling (sum/avg would smear them). Convert to dB, smooth with
  // attack/release ballistics, plot the resulting curve.
  //
  // Layout: dB scale runs FFT_DB_FLOOR..FFT_DB_TOP top-to-bottom on the
  // right (labels inside the plot). Hz axis runs FFT_F_MIN..FFT_F_MAX
  // log-spaced left-to-right (labels at the bottom). Filled curve has a
  // vertical gradient from amber-at-top to phosphor-at-floor for
  // magnitude-at-a-glance reading; outline trace on top has subtle
  // phosphor glow for crisp peak resolution.
  const N_BINS = previewState.analyserL.frequencyBinCount;
  if (!METER.fftSmooth || METER.fftSmooth.length !== N_BINS) {
    METER.fftSmooth = new Float32Array(N_BINS).fill(FFT_DB_FLOOR);
  }

  // Cache per-pixel bin ranges + grid positions whenever the canvas
  // dimensions change. Cleared on canvas resize via stopMeterLoop.
  function ensureFftLayout() {
    if (METER.fftLayout && METER.fftLayout.W === W && METER.fftLayout.H === H) return METER.fftLayout;
    const sr = previewState.audioCtx ? previewState.audioCtx.sampleRate : 48000;
    const fmin = FFT_F_MIN;
    const fmax = Math.min(FFT_F_MAX, sr / 2);
    const ML = 0, MR = 38, MT = 6, MB = 18;
    const plotX = ML, plotY = MT;
    const plotW = W - ML - MR, plotH = H - MT - MB;
    const logFmin = Math.log(fmin), logFspan = Math.log(fmax) - logFmin;
    // Pixel → bin range (inclusive) + fractional bin position at the
    // pixel's CENTER. The integer range drives max-search when a pixel
    // spans multiple bins; the fractional position drives linear
    // interpolation when a pixel falls inside a single bin (the
    // common case at low frequencies on a log axis, where adjacent
    // pixels often map to fractional offsets within the same bin).
    const binLo = new Int32Array(plotW + 1);
    const binHi = new Int32Array(plotW + 1);
    const binF  = new Float32Array(plotW + 1);
    for (let px = 0; px <= plotW; px++) {
      const f0 = Math.exp(logFmin + (px       / plotW) * logFspan);
      const f1 = Math.exp(logFmin + ((px + 1) / plotW) * logFspan);
      const fc = Math.exp(logFmin + ((px + 0.5) / plotW) * logFspan);
      let lo = Math.floor(f0 * 2 * N_BINS / sr);
      let hi = Math.ceil (f1 * 2 * N_BINS / sr);
      if (lo < 0) lo = 0; if (hi >= N_BINS) hi = N_BINS - 1;
      if (hi < lo) hi = lo;
      binLo[px] = lo; binHi[px] = hi;
      binF [px] = fc * 2 * N_BINS / sr;
    }
    METER.fftLayout = {
      W, H, fmin, fmax, ML, MR, MT, MB, plotX, plotY, plotW, plotH,
      logFmin, logFspan, binLo, binHi, binF
    };
    return METER.fftLayout;
  }
  // Mouse readout — when the cursor hovers the plot, store {x, y, freq, db}
  // for the renderer to draw a crosshair + tooltip.
  function fftHandlePointer(ev) {
    const r = canvas.getBoundingClientRect();
    const cx = (ev.clientX - r.left) * (W / r.width);
    const cy = (ev.clientY - r.top)  * (H / r.height);
    const lo = METER.fftLayout;
    if (!lo || cx < lo.plotX || cx > lo.plotX + lo.plotW || cy < lo.plotY || cy > lo.plotY + lo.plotH) {
      METER.fftCursor = null;
      return;
    }
    const tF = (cx - lo.plotX) / lo.plotW;
    const freq = Math.exp(lo.logFmin + tF * lo.logFspan);
    const tD = (cy - lo.plotY) / lo.plotH;
    const db  = FFT_DB_TOP - tD * (FFT_DB_TOP - FFT_DB_FLOOR);
    METER.fftCursor = { x: cx, y: cy, freq, db };
  }
  if (!canvas.dataset.fftWired) {
    canvas.dataset.fftWired = "1";
    // Pointer events instead of mouse events so the FFT cursor readout
    // works on iPad / phone too. mouseleave maps to pointerleave.
    canvas.addEventListener("pointermove",  fftHandlePointer);
    canvas.addEventListener("pointerleave", () => { METER.fftCursor = null; });
  }

  function drawVU(pL, pR) {
    // Two horizontal bars stacked, with peak-hold tick + ladder ticks
    // at -60, -40, -20, -10, -6, -3, 0 dB.
    ctx.fillStyle = COL_BG; ctx.fillRect(0, 0, W, H);
    const ticks = [-60, -40, -20, -10, -6, -3, 0];
    const dbToX = db => {
      const pct = (db + 60) / 60;
      return Math.max(0, Math.min(1, pct)) * (W - 6) + 3;
    };
    ctx.strokeStyle = COL_PHB; ctx.lineWidth = 1; ctx.beginPath();
    ticks.forEach(d => {
      const x = dbToX(d);
      ctx.moveTo(x + 0.5, 8); ctx.lineTo(x + 0.5, H - 8);
    });
    ctx.stroke();
    // Tick labels — small, dim, Fragment Mono for instrument feel.
    ctx.fillStyle = COL_TX;
    ctx.font = "9px 'Fragment Mono', 'JetBrains Mono', monospace";
    ctx.textBaseline = "bottom"; ctx.textAlign = "center";
    ticks.forEach(d => {
      ctx.fillText((d === 0 ? "0" : d.toString()), dbToX(d), H - 1);
    });
    // Bar geometry.
    const barH = 22;
    const barY1 = 14, barY2 = barY1 + barH + 6;
    function drawBar(y, val, hold) {
      const dbV = dbFromAmp(val);
      const x   = dbToX(dbV);
      const x0  = dbToX(-60);
      // Frame
      ctx.strokeStyle = COL_PHA; ctx.strokeRect(x0 - 0.5, y - 0.5, (W - 6) - (x0 - 3) + 0.5, barH + 1);
      // Filled section. Gradient stays phosphor across most of the
      // range, warms to amber past -6 dB, red past -1 dB.
      const grad = ctx.createLinearGradient(x0, 0, W - 3, 0);
      grad.addColorStop(0, "rgba(200,232,90,0.85)");
      grad.addColorStop(0.85, "rgba(200,232,90,0.95)");
      grad.addColorStop(0.93, COL_AMB);
      grad.addColorStop(1.0,  COL_RED);
      ctx.fillStyle = grad;
      ctx.fillRect(x0, y, x - x0, barH);
      // Peak-hold tick — warm-white so it pops over both phosphor + amber.
      const xH = dbToX(dbFromAmp(hold));
      ctx.strokeStyle = COL_HI;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xH + 0.5, y - 1);
      ctx.lineTo(xH + 0.5, y + barH + 1);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    drawBar(barY1, METER.smoothL, METER.peakHoldL);
    drawBar(barY2, METER.smoothR, METER.peakHoldR);
    // L/R glyphs — Major Mono Display, lowercase, phosphor.
    ctx.fillStyle = COL_PH;
    ctx.font = "11px 'Major Mono Display', 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText("l", 7, barY1 + barH / 2);
    ctx.fillText("r", 7, barY2 + barH / 2);
  }

  function drawScope(buf) {
    ctx.fillStyle = COL_BG; ctx.fillRect(0, 0, W, H);
    // Center reference line + thirds.
    ctx.strokeStyle = COL_PHB; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2 + 0.5); ctx.lineTo(W, H / 2 + 0.5);
    ctx.moveTo(0, H / 4 + 0.5); ctx.lineTo(W, H / 4 + 0.5);
    ctx.moveTo(0, 3 * H / 4 + 0.5); ctx.lineTo(W, 3 * H / 4 + 0.5);
    ctx.stroke();
    // Trace.
    ctx.strokeStyle = COL_PH;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = COL_PH;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    const N = buf.length;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * W;
      const y = H / 2 - buf[i] * (H / 2 - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawFFT() {
    previewState.analyserL.getFloatFrequencyData(fftL);
    const lo = ensureFftLayout();
    const sm = METER.fftSmooth;
    // Per-bin attack/release smoothing. fftL[i] is in dB (-Infinity..0).
    // Floor the input to FFT_DB_FLOOR so the smoother is well-defined.
    for (let i = 0; i < N_BINS; i++) {
      let v = fftL[i];
      if (!isFinite(v) || v < FFT_DB_FLOOR) v = FFT_DB_FLOOR;
      const prev = sm[i];
      const k = (v > prev) ? FFT_ATTACK : FFT_RELEASE;
      sm[i] = prev * k + v * (1 - k);
    }

    // Background.
    ctx.fillStyle = COL_BG; ctx.fillRect(0, 0, W, H);

    // dB ↔ y, helper closures (cheap; called O(grid) times not O(W)).
    const dbSpan = FFT_DB_TOP - FFT_DB_FLOOR;
    const dbToY = db => lo.plotY + (1 - (db - FFT_DB_FLOOR) / dbSpan) * lo.plotH;
    const fToX  = f  => lo.plotX + (Math.log(f) - lo.logFmin) / lo.logFspan * lo.plotW;

    // dB grid (horizontal). Slightly brighter at 0 dB to anchor the eye.
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(200,232,90,0.10)";
    ctx.beginPath();
    FFT_DB_GRID.forEach(db => {
      const y = Math.round(dbToY(db)) + 0.5;
      ctx.moveTo(lo.plotX, y); ctx.lineTo(lo.plotX + lo.plotW, y);
    });
    ctx.stroke();
    // 0 dB highlight line.
    ctx.strokeStyle = "rgba(255,179,71,0.30)";
    ctx.beginPath();
    const y0 = Math.round(dbToY(0)) + 0.5;
    ctx.moveTo(lo.plotX, y0); ctx.lineTo(lo.plotX + lo.plotW, y0);
    ctx.stroke();

    // Hz grid (vertical) — only label the decades + 1/2/5 to avoid clutter.
    ctx.strokeStyle = "rgba(200,232,90,0.10)";
    ctx.beginPath();
    FFT_HZ_GRID.forEach(f => {
      if (f > lo.fmax) return;
      const x = Math.round(fToX(f)) + 0.5;
      ctx.moveTo(x, lo.plotY); ctx.lineTo(x, lo.plotY + lo.plotH);
    });
    ctx.stroke();

    // Compute spectrum y-values for each pixel column ONCE; reuse for
    // both the filled curve and the outline trace.
    //
    // Two strategies:
    //   - Pixel spans MULTIPLE bins (high frequencies, where the log
    //     axis compresses): take max so peaks survive.
    //   - Pixel falls INSIDE a single bin (low frequencies, where log
    //     stretches one bin across many pixels): linear-interpolate
    //     between this bin and the next using the pixel's fractional
    //     bin position. Removes the staircase look at low freqs and
    //     makes a clean sine read as a single sharp spike.
    const ys = new Float32Array(lo.plotW + 1);
    const lastBin = N_BINS - 1;
    for (let px = 0; px <= lo.plotW; px++) {
      const a = lo.binLo[px], b = lo.binHi[px];
      let v;
      if (b > a) {
        v = sm[a];
        for (let i = a + 1; i <= b; i++) if (sm[i] > v) v = sm[i];
      } else {
        const f = lo.binF[px];
        const i0 = Math.floor(f);
        const i1 = i0 < lastBin ? i0 + 1 : i0;
        const t = f - i0;
        v = sm[i0] * (1 - t) + sm[i1] * t;
      }
      ys[px] = dbToY(v);
    }

    // Filled curve — vertical gradient (warmer near 0 dB, dim near floor).
    ctx.beginPath();
    ctx.moveTo(lo.plotX, lo.plotY + lo.plotH);
    for (let px = 0; px <= lo.plotW; px++) {
      ctx.lineTo(lo.plotX + px, ys[px]);
    }
    ctx.lineTo(lo.plotX + lo.plotW, lo.plotY + lo.plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, lo.plotY, 0, lo.plotY + lo.plotH);
    grad.addColorStop(0,    "rgba(255,179,71,0.45)");      // amber at 0 dB
    grad.addColorStop(0.20, "rgba(200,232,90,0.42)");
    grad.addColorStop(0.55, "rgba(200,232,90,0.20)");
    grad.addColorStop(1,    "rgba(200,232,90,0.04)");
    ctx.fillStyle = grad;
    ctx.fill();

    // Outline trace — phosphor with subtle glow.
    ctx.beginPath();
    ctx.moveTo(lo.plotX, ys[0]);
    for (let px = 1; px <= lo.plotW; px++) ctx.lineTo(lo.plotX + px, ys[px]);
    ctx.strokeStyle = COL_PH;
    ctx.lineWidth = 1.25;
    ctx.shadowColor = COL_PH;
    ctx.shadowBlur = 3;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Axis labels — dB on the right inside the plot, Hz on the bottom.
    ctx.fillStyle = COL_TX;
    ctx.font = "9px 'Fragment Mono', 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    FFT_DB_GRID.forEach(db => {
      const y = dbToY(db);
      const label = db === 0 ? "0 dB" : (db + "");
      ctx.fillText(label, lo.plotX + lo.plotW + 4, y);
    });
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    FFT_HZ_GRID.forEach(f => {
      if (f > lo.fmax) return;
      const x = fToX(f);
      const label = f >= 1000 ? (f / 1000) + "k" : (f + "");
      ctx.fillText(label, x, lo.plotY + lo.plotH + 4);
    });

    // Mouse-hover crosshair + readout. Only drawn when fftCursor is set.
    if (METER.fftCursor) {
      const cur = METER.fftCursor;
      // Snap y to the actual spectrum height at the hovered pixel so the
      // tooltip dB matches what the user "sees" (peak at that x).
      const px = Math.max(0, Math.min(lo.plotW, Math.round(cur.x - lo.plotX)));
      const ySpec = ys[px];
      // Convert ySpec back to dB for the tooltip.
      const dbAt = FFT_DB_TOP - (ySpec - lo.plotY) / lo.plotH * dbSpan;
      ctx.strokeStyle = "rgba(230,227,220,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cur.x + 0.5, lo.plotY); ctx.lineTo(cur.x + 0.5, lo.plotY + lo.plotH);
      ctx.moveTo(lo.plotX, ySpec + 0.5); ctx.lineTo(lo.plotX + lo.plotW, ySpec + 0.5);
      ctx.stroke();
      // Marker dot at the spectrum peak under the cursor.
      ctx.fillStyle = COL_HI;
      ctx.beginPath(); ctx.arc(cur.x, ySpec, 2.5, 0, Math.PI * 2); ctx.fill();
      // Tooltip — freq + dB at cursor's spectrum point.
      const fLabel = cur.freq >= 1000 ? (cur.freq / 1000).toFixed(2) + "k Hz" : cur.freq.toFixed(0) + " Hz";
      const dLabel = (dbAt >= 0 ? "+" : "") + dbAt.toFixed(1) + " dB";
      const tip = fLabel + "  " + dLabel;
      ctx.font = "10px 'Fragment Mono', 'JetBrains Mono', monospace";
      const tw = ctx.measureText(tip).width;
      const tx = Math.min(lo.plotX + lo.plotW - tw - 6, cur.x + 8);
      const ty = Math.max(lo.plotY + 4, ySpec - 18);
      ctx.fillStyle = "rgba(5,6,8,0.85)";
      ctx.fillRect(tx - 4, ty - 2, tw + 8, 14);
      ctx.strokeStyle = "rgba(200,232,90,0.30)";
      ctx.strokeRect(tx - 4 + 0.5, ty - 2 + 0.5, tw + 8, 14);
      ctx.fillStyle = COL_PH;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(tip, tx, ty);
    }
  }

  let frame = 0;
  function tick() {
    if (!previewState.analyserL || !previewState.analyserR) {
      METER.rafId = null;
      meterEl.classList.remove("active");
      return;
    }
    previewState.analyserL.getFloatTimeDomainData(bufL);
    previewState.analyserR.getFloatTimeDomainData(bufR);
    let pL = 0, pR = 0;
    for (let i = 0; i < bufL.length; i++) {
      const aL = bufL[i] >= 0 ? bufL[i] : -bufL[i]; if (aL > pL) pL = aL;
      const aR = bufR[i] >= 0 ? bufR[i] : -bufR[i]; if (aR > pR) pR = aR;
    }
    METER.smoothL   = Math.max(pL, METER.smoothL  * METER.fillDecayPerFrame);
    METER.smoothR   = Math.max(pR, METER.smoothR  * METER.fillDecayPerFrame);
    METER.peakHoldL = Math.max(pL, METER.peakHoldL * METER.peakDecayPerFrame);
    METER.peakHoldR = Math.max(pR, METER.peakHoldR * METER.peakDecayPerFrame);
    const dbValL = dbFromAmp(METER.smoothL);
    const dbValR = dbFromAmp(METER.smoothR);
    dbL.textContent = fmtDb(dbValL);
    dbR.textContent = fmtDb(dbValR);

    if (METER.mode === "vu")    drawVU(pL, pR);
    else if (METER.mode === "scope") drawScope(bufL);
    else if (METER.mode === "fft")   drawFFT();

    // Corner readout shows the most-relevant number for the current mode.
    if (cornerEl) {
      if (METER.mode === "vu")    cornerEl.textContent = "max " + fmtDb(Math.max(dbValL, dbValR));
      else if (METER.mode === "scope") cornerEl.textContent = "± " + (Math.max(pL, pR)).toFixed(3);
      else if (METER.mode === "fft")   cornerEl.textContent = "fft 16384 · log hz";
    }

    if (METER.smoothL < 1e-4 && METER.smoothR < 1e-4) meterEl.classList.add("silent");
    else meterEl.classList.remove("silent");

    if ((++frame % 120) === 0) {
      console.log("[meter] L=" + fmtDb(dbValL) + " R=" + fmtDb(dbValR) +
                  " ctx=" + (previewState.audioCtx && previewState.audioCtx.state) +
                  " mode=" + METER.mode);
    }
    METER.rafId = requestAnimationFrame(tick);
  }
  METER.rafId = requestAnimationFrame(tick);
}
function stopMeterLoop() {
  if (METER.rafId) cancelAnimationFrame(METER.rafId);
  METER.rafId = null;
  const meterEl = document.getElementById("monitor-display");
  if (meterEl) {
    meterEl.classList.remove("active");
    meterEl.classList.add("silent");
    meterEl.setAttribute("aria-hidden", "true");
  }
  ["meter-db-l","meter-db-r"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = "−∞";
  });
  // Clear the canvas to a flat phosphor-trace baseline.
  const c = document.getElementById("meter-canvas");
  if (c) {
    const cx = c.getContext("2d");
    cx.fillStyle = "#050608"; cx.fillRect(0, 0, c.width, c.height);
    cx.strokeStyle = "rgba(200,232,90,0.18)";
    cx.beginPath(); cx.moveTo(0, c.height / 2); cx.lineTo(c.width, c.height / 2); cx.stroke();
  }
  // Drop FFT state — analyser is being recreated next time, bin count
  // and smoothed values would be stale.
  METER.fftSmooth = null;
  METER.fftLayout = null;
  METER.fftCursor = null;
  // Reset piano too.
  resetPiano();
}

/* ------------- Local compile-server detection ------------- */
/* Probe localhost:8765/health on first Play click. If the daemon is
 * up, all compile requests route there (full Emscripten, ~5–15 s).
 * If not, fall back to the in-browser Wasmer path (~OOM-prone).
 *
 * If the user has set aiSettings.compileServerUrl (e.g. for a LAN
 * daemon they're hitting from an iPad), that URL is the SOLE candidate
 * — we don't also probe localhost, since on a remote device localhost
 * just refers to the device itself and would dilute the timeout budget.
 * The probe timeout is also bumped (3 s) since LAN round-trips can be
 * slightly slower than the loopback adapter. */
let localServerStatus = null;       // null = unprobed, true = available, false = not running
let localServerEndpoint = null;     // base URL of whichever candidate responded
async function probeLocalServer() {
  if (localServerStatus !== null) return localServerStatus;
  const customUrl = (aiSettings && aiSettings.compileServerUrl || "").trim().replace(/\/+$/, "");
  // Custom URL wins; otherwise try BOTH 127.0.0.1 and localhost in
  // parallel — on some Windows setups `localhost` resolves to IPv6 ::1
  // first, which adds a slow fallback to IPv4 and trips our short
  // timeout. 127.0.0.1 is direct.
  const candidates = customUrl
    ? [customUrl]
    : ["http://127.0.0.1:8765", "http://localhost:8765"];
  const timeoutMs = customUrl
    ? Math.max(3000, PREVIEW.localServerProbeTimeoutMs)
    : Math.max(1500, PREVIEW.localServerProbeTimeoutMs);
  const results = await Promise.allSettled(candidates.map(async base => {
    const res = await fetch(base + "/health", {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (!j || j.service !== "gamma-compile-server") throw new Error("not gamma-compile-server");
    return base;
  }));
  const ok = results.find(r => r.status === "fulfilled");
  if (ok) {
    localServerEndpoint = ok.value;
    localServerStatus = true;
    console.log("[preview] local compile-server: detected at " + localServerEndpoint);
  } else {
    localServerStatus = false;
    // Log every candidate's failure reason so we can see WHY.
    const reasons = results.map((r, i) =>
      "  " + candidates[i] + " — " +
      (r.status === "rejected"
        ? (r.reason && (r.reason.name + ": " + r.reason.message) || String(r.reason))
        : "ok-but-bad-payload")
    );
    console.log("[preview] local compile-server: not detected\n" + reasons.join("\n"));
  }
  return localServerStatus;
}

async function compileViaLocalServer(wrapped, smokeTest) {
  const base = localServerEndpoint || PREVIEW.localServerUrl;
  const res = await fetch(base + "/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wrappedSrc: wrapped, optLevel: smokeTest ? "O0" : "O1" })
  });
  if (res.status === 200) {
    const stderr = decodeURIComponent(res.headers.get("X-Compile-Stderr") || "");
    const elapsed = res.headers.get("X-Compile-Elapsed-Ms") || "?";
    const wasmBytes = await res.arrayBuffer();
    return { wasmBytes, stderr: stderr + (stderr ? "\n\n" : "") + "[local-cli compile in " + elapsed + " ms]" };
  }
  // Error path: server returns JSON with { error, stderr }.
  const body = await res.json().catch(() => ({}));
  throw Object.assign(new Error(body.error || ("local-cli HTTP " + res.status)), { stderr: body.stderr || "" });
}

/* v0.2.25 — compile-only path for export.
 *
 * The standalone-viewer export needs the patch's compiled wasm but
 * shouldn't have a side effect of starting playback. previewCompileAndPlay()
 * does both; this entry point runs just the compile half and returns
 * the wasm ArrayBuffer. Uses the same local-server-first / Wasmer-SDK-
 * fallback pipeline. Throws on codegen errors (cycle without Delay1)
 * or compile failures (clang stderr surfaced through the error message).
 *
 * progressFn optional: (msg, kind) => void for status updates so the
 * Export modal can show "compiling via local-cli…" / "compiling via
 * Wasmer…" etc. without cross-wiring into the toolbar pill. */
async function compilePatchForExport(progressFn) {
  const note = (msg) => { if (typeof progressFn === "function") try { progressFn(msg); } catch (_) {} };
  note("Codegen…");
  let patchCpp;
  try {
    patchCpp = generateCode();
  } catch (e) {
    throw new Error("Codegen failed: " + e.message);
  }
  if (patchCpp.startsWith("// ❌")) {
    throw new Error("Patch has a cycle without Delay1 — fix the canvas warning before exporting");
  }
  const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
  const wrapped = wrapForPreview(patchCpp, className);
  previewState.lastWrapped = wrapped;

  // 1. Try the local compile-server first (fast, full-fidelity).
  const useLocal = await probeLocalServer();
  if (useLocal) {
    note("Compiling via local-cli…");
    const { wasmBytes } = await compileViaLocalServer(wrapped, false);
    return wasmBytes;
  }

  // 2. Fall back to the Wasmer SDK worker. Slower; may OOM on large
  //    patches per the README. Worker lives on previewState.worker.
  note("Initializing Wasmer compile worker…");
  try {
    await ensureCompileWorker();
  } catch (e) {
    throw new Error("Compile worker init failed: " + e.message + ". Start the gamma-compile-server daemon or check internet for the Wasmer SDK CDN.");
  }
  note("Compiling via Wasmer (browser)…");
  return new Promise((resolve, reject) => {
    const onReply = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === "progress" && m.stage) {
        note("Compiling… " + m.stage);
      } else if (m.type === "compiled") {
        previewState.worker.removeEventListener("message", onReply);
        const bytes = m.wasmBytes instanceof ArrayBuffer ? m.wasmBytes : m.wasmBytes.buffer;
        resolve(bytes);
      } else if (m.type === "compile-error") {
        previewState.worker.removeEventListener("message", onReply);
        reject(Object.assign(new Error(m.error || "compile failed"),
                             { stderr: m.stderr || "" }));
      }
    };
    previewState.worker.addEventListener("message", onReply);
    previewState.worker.postMessage({
      type: "compile",
      wrappedSrc: wrapped,
      archiveUrl: new URL(PREVIEW.gammaArchiveUrl, location.href).toString(),
      sdkUrl: PREVIEW.wasmerSdkUrl
    });
  });
}

/* ------------- Compile + load + play orchestration ------------- */
async function previewCompileAndPlay() {
  setPreviewStatus("compiling", "compiling…");
  previewProgressStart();
  previewProgressStage("prepare");

  let patchCpp;
  try {
    patchCpp = generateCode();
  } catch (e) {
    previewProgressEnd(false);
    setPreviewStatus("error", "codegen: " + e.message);
    return;
  }
  if (patchCpp.startsWith("// ❌")) {
    previewProgressEnd(false);
    setPreviewStatus("error", "patch has cycle without Delay1 — see canvas");
    return;
  }
  const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
  const wrapped = wrapForPreview(patchCpp, className);
  previewState.lastWrapped = wrapped;
  // Diagnostic — print the full wrapped C++ to the console so the user
  // can paste it back when debugging silent / broken patches.
  console.log("[preview] wrapped C++ (" + wrapped.length + " chars) ↓\n" + wrapped);

  // Try the local compile-server FIRST. Fast, full-fidelity, no OOM.
  // Falls through to the in-browser Wasmer path if the daemon isn't
  // running.
  const useLocal = await probeLocalServer();
  if (useLocal) {
    setPreviewStatus("compiling", "compiling via local-cli…");
    previewProgressStage("compile");
    let wasmBytes, stderr;
    try {
      ({ wasmBytes, stderr } = await compileViaLocalServer(wrapped, false));
    } catch (e) {
      previewProgressEnd(false);
      setPreviewStatus("error", "local-cli: " + e.message);
      showCompileStderr(e.stderr || "", e.message);
      return;
    }
    showCompileStderr(stderr || "", null);
    try {
      previewProgressStage("load-wasm");
      const node = await ensureAudioWorklet();
      if (previewState.audioCtx.state === "suspended") await previewState.audioCtx.resume();
      // v0.2.21 — retain a clone for offline audio render before
      // transferring the original to the worklet (postMessage with a
      // transfer list detaches the source buffer on the main thread).
      try { previewState.lastWasm = wasmBytes.slice(0); } catch (_) { previewState.lastWasm = null; }
      node.port.postMessage({ type: "load", wasmBytes }, [wasmBytes]);
    } catch (e) {
      previewProgressEnd(false);
      setPreviewStatus("error", "audio: " + e.message);
    }
    return;
  }

  try {
    await ensureCompileWorker();
  } catch (e) {
    previewProgressEnd(false);
    setPreviewStatus("error", "worker init: " + e.message);
    return;
  }

  // Send compile request. Worker streams `progress` updates with
  // stage IDs (and optional subProgress for byte-level fetch tracking)
  // while it works, then sends `compiled` or `compile-error` as the
  // terminal message.
  const wasmBytes = await new Promise((resolve, reject) => {
    const onReply = (ev) => {
      const m = ev.data;
      if (m.type === "progress") {
        if (m.stage) {
          if (typeof m.subProgress === "number" && m.subProgress > 0) {
            // Same stage as before but with an updated sub-progress.
            const stageIdx = PREVIEW_STAGES.findIndex(s => s.id === m.stage);
            if (stageIdx === previewProgress.stageIdx) {
              previewProgressSub(m.subProgress);
            } else {
              previewProgressStage(m.stage, m.subProgress);
            }
          } else {
            previewProgressStage(m.stage);
          }
          // Keep the pill text aligned for the copyable "current state".
          const stage = PREVIEW_STAGES.find(s => s.id === m.stage);
          if (stage) setPreviewStatus("compiling", "compiling… " + stage.label);
        } else if (m.step) {
          // Backwards-compat with old freeform step messages.
          setPreviewStatus("compiling", "compiling… " + m.step);
        }
      } else if (m.type === "warnings") {
        showCompileStderr(m.stderr || "", null);
      } else if (m.type === "compiled") {
        previewState.worker.removeEventListener("message", onReply);
        if (m.stderr) showCompileStderr(m.stderr, null);
        else showCompileStderr("", null);
        const bytes = m.wasmBytes instanceof ArrayBuffer ? m.wasmBytes : m.wasmBytes.buffer;
        resolve(bytes);
      } else if (m.type === "compile-error") {
        previewState.worker.removeEventListener("message", onReply);
        reject(Object.assign(new Error(m.error), { stderr: m.stderr || "" }));
      }
    };
    previewState.worker.addEventListener("message", onReply);
    previewState.worker.postMessage({
      type: "compile",
      wrappedSrc: wrapped,
      archiveUrl: new URL(PREVIEW.gammaArchiveUrl, location.href).toString(),
      sdkUrl: PREVIEW.wasmerSdkUrl
    });
  }).catch(e => {
    previewProgressEnd(false);
    setPreviewStatus("error", "compile: " + e.message);
    showCompileStderr(e.stderr || "", e.message);
    return null;
  });

  if (!wasmBytes) return;

  try {
    previewProgressStage("load-wasm");
    const node = await ensureAudioWorklet();
    if (previewState.audioCtx.state === "suspended") await previewState.audioCtx.resume();
    // Mic auto-connect — if the patch contains a MicInput node OR
    // a KeywordSpotter (which taps the mic for live detection), get
    // the stream up. Permission is requested asynchronously; if not
    // yet granted we proceed and the worklet ticks with zero mic
    // input until the user grants.
    const wantsMic = state.nodes.some(n =>
      n.type === "MicInput" || n.type === "KeywordSpotter");
    if (wantsMic) {
      try { await ensureMicConnected(); }
      catch (e) { console.warn("[preview] mic auto-connect failed:", e); }
      // Stand up the keyword-detection pipeline after the mic is
      // connected. setupAllKeywordSpotters is a no-op if the
      // patch has no KeywordSpotter nodes or none have recordings.
      setupAllKeywordSpotters();
    } else {
      // No MicInput / KeywordSpotter — make sure any prior session's
      // mic source is disconnected so we don't leak the stream or
      // feed it into a patch that doesn't want it.
      disconnectMic();
    }
    // v0.3.19 — Web Audio routing for VideoFile / Webcam audio outlets.
    // The codegen produced setVidL_N / setVidR_N setters in the wasm
    // for each audio-wired source; here we connect the matching
    // MediaElementSource / MediaStreamSource through a ChannelMerger
    // into the worklet's input 1. The worklet's load handler scans
    // the wasm for preview_get_vid_buf_N_l/_r exports and starts
    // writing inputs[1] into them per quantum.
    try { await ensureVideoAudioConnected(); }
    catch (e) { console.warn("[preview] videosrc routing failed:", e); }
    // v0.2.21 — clone for offline audio render before transfer.
    try { previewState.lastWasm = wasmBytes.slice(0); } catch (_) { previewState.lastWasm = null; }
    node.port.postMessage({ type: "load", wasmBytes }, [wasmBytes]);
    // setPreviewStatus("playing") fires when worklet posts back "loaded";
    // we finish the progress bar there too via the existing handler.
  } catch (e) {
    previewProgressEnd(false);
    setPreviewStatus("error", "audio: " + e.message);
  }
}

/* Mic stream → worklet wiring. Called from the play flow when the
 * patch has at least one MicInput node. Idempotent — multiple
 * MicInput nodes share one MediaStreamSource. If the user hasn't
 * granted mic permission yet, this prompts via getUserMedia and
 * caches the stream globally (_micStream); the props pane's
 * "Enable microphone" button uses the same path.
 *
 * Disconnect happens on previewStop() and whenever a patch without
 * MicInput plays — we don't want to leak the mic into a synth patch
 * that just happens to follow a mic patch in the editing session. */
async function ensureMicConnected() {
  if (!previewState.workletNode || !previewState.audioCtx) return;
  if (previewState.micConnected) return;
  // Pick a deviceId from the FIRST MicInput node that has one set.
  // (If multiple nodes specify different devices, only the first
  // wins for the shared stream — multi-stream support would need
  // a per-node MediaStreamSource, kept off scope for now.)
  let deviceId = "";
  state.nodes.forEach(n => {
    if (deviceId) return;
    if (n.type !== "MicInput") return;
    const id = n.params && n.params.inputSourceId;
    if (id) deviceId = id;
  });
  if (!_micStream || (deviceId && _micStream._gammaDeviceId !== deviceId)) {
    // Stop previous stream if device changed (otherwise the OS
    // mic indicator stays on for the wrong device).
    if (_micStream) {
      try { _micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      _micStream = null;
    }
    try {
      const constraints = deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream._gammaDeviceId = deviceId;
      _micStream = stream;
      const tracks = stream.getAudioTracks();
      _micDeviceLabel = tracks.length ? tracks[0].label : "default";
      await refreshMicDeviceList();
      if (typeof renderProps === "function") renderProps();
    } catch (err) {
      throw new Error("mic permission denied: " + (err && err.message || err));
    }
  }
  const src = previewState.audioCtx.createMediaStreamSource(_micStream);
  src.connect(previewState.workletNode);
  previewState.micSource = src;
  previewState.micConnected = true;
  console.log("[preview] mic connected to worklet · device:", _micDeviceLabel);
}

/* v0.3.19 — VideoSrc routing. Wires each audio-wired VideoFile / Webcam
 * node's MediaElementSource / MediaStreamSource through a ChannelMerger
 * into the worklet's input 1. Each source occupies a stereo channel
 * pair; channel index N matches the codegen setVidL_N / setVidR_N
 * dispatch.
 *
 * Direct-playback path is also wired for VideoFile (MES → GainNode →
 * ctx.destination) so the user can hear unprocessed audio when there
 * are no audio wires. When wires exist, the GainNode is muted -- the
 * patch is the audio path. Webcam skips direct playback entirely
 * (would create echo with the user's own mic).
 *
 * Called from previewPlay after the worklet is ready, and whenever
 * the patch shape changes (wire add/remove, fileUrl change). The
 * function is idempotent + handles reroute / disconnect cases. */
async function ensureVideoAudioConnected() {
  if (!previewState || !previewState.workletNode || !previewState.audioCtx) return;
  const vidNodes = (typeof _videoAudioSrcNodes === "function") ? _videoAudioSrcNodes() : [];

  // No audio-wired video sources: tear down any prior merger so the
  // worklet's input 1 stays silent.
  if (vidNodes.length === 0) {
    if (previewState.videoMerger) {
      try { previewState.videoMerger.disconnect(); } catch (_) {}
      previewState.videoMerger = null;
    }
    if (previewState.videoRoutings) {
      previewState.videoRoutings.forEach(r => {
        try { r.splitter.disconnect(); } catch (_) {}
      });
      previewState.videoRoutings.clear();
    }
    _updateVideoAudioGains();
    return;
  }

  // Allocate or reuse the global merger feeding worklet input 1.
  const numCh = MAX_VIDEO_AUDIO_SRC * 2;
  if (!previewState.videoMerger) {
    const merger = previewState.audioCtx.createChannelMerger(numCh);
    merger.connect(previewState.workletNode, 0, 1);
    previewState.videoMerger = merger;
  }
  if (!previewState.videoRoutings) previewState.videoRoutings = new Map();
  if (!previewState.videoElSources) previewState.videoElSources = new Map();

  // For each source, ensure routing at the correct channel pair.
  for (let idx = 0; idx < vidNodes.length; idx++) {
    const node = vidNodes[idx];
    const existing = previewState.videoRoutings.get(node.id);
    if (existing && existing.channelIdx === idx) continue;
    if (existing) {
      try { existing.splitter.disconnect(); } catch (_) {}
      previewState.videoRoutings.delete(node.id);
    }
    // Get / lazy-init the MediaElementSource (VideoFile) or
    // MediaStreamSource (Webcam). MES is one-shot per element so we
    // cache it on _videoSources entry.
    const srcEntry = _videoSources.get(node.id);
    if (!srcEntry) continue;
    let mes = srcEntry._mediaSource;
    if (!mes) {
      try {
        if (node.type === "VideoFile") {
          if (!srcEntry.videoEl) continue;
          mes = previewState.audioCtx.createMediaElementSource(srcEntry.videoEl);
          // Direct-playback path. GainNode value managed by
          // _updateVideoAudioGains based on audioEnabled / volume /
          // hasWire.
          const gain = previewState.audioCtx.createGain();
          gain.gain.value = 0;
          mes.connect(gain);
          gain.connect(previewState.audioCtx.destination);
          srcEntry._directGain = gain;
          // Suppress the videoEl's default audio output (now playing
          // through Web Audio instead). For Safari the MES creation
          // already does this; setting muted=true is belt-and-braces.
          try { srcEntry.videoEl.muted = true; } catch (_) {}
        } else if (node.type === "Webcam") {
          if (!srcEntry.stream || srcEntry.stream.getAudioTracks().length === 0) {
            console.log("[videosrc] Webcam node " + node.id + " has no audio track; skip routing");
            continue;
          }
          mes = previewState.audioCtx.createMediaStreamSource(srcEntry.stream);
          // No direct-playback path for Webcam — would create echo.
        } else if (node.type === "ScreenShare") {
          if (!srcEntry.stream || srcEntry.stream.getAudioTracks().length === 0) {
            console.log("[videosrc] ScreenShare node " + node.id + " has no audio track (the user didn't check 'Share audio' or the browser refused it); skip routing");
            continue;
          }
          mes = previewState.audioCtx.createMediaStreamSource(srcEntry.stream);
          // v0.3.22 — ScreenShare also skips direct-playback. With
          // most "share audio" use cases the user is recording, so
          // they want patch processing only -- direct playback of
          // system audio plus the worklet's output would double up.
        } else {
          continue;
        }
        srcEntry._mediaSource = mes;
      } catch (e) {
        console.warn("[videosrc] media-source create failed for " + node.type + " " + node.id + ":", e);
        continue;
      }
    }
    // Routing: MES → ChannelSplitter (2) → ChannelMerger pair.
    const splitter = previewState.audioCtx.createChannelSplitter(2);
    try {
      mes.connect(splitter);
      splitter.connect(previewState.videoMerger, 0, idx * 2);
      splitter.connect(previewState.videoMerger, 1, idx * 2 + 1);
    } catch (e) {
      console.warn("[videosrc] splitter wire failed:", e);
      continue;
    }
    previewState.videoRoutings.set(node.id, { channelIdx: idx, splitter });
    console.log("[videosrc] " + node.type + " " + node.id + " → worklet input 1 channels " + (idx*2) + "/" + (idx*2+1));
  }

  _updateVideoAudioGains();
}

/* v0.3.19 — refresh direct-playback gains from current node params.
 * Called whenever audioEnabled / volume changes or the wire set
 * changes. Wire-routed sources get gain=0 (the patch is the audio
 * path); unrouted ones get audioEnabled ? volume : 0. */
function _updateVideoAudioGains() {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  const wiredIds = new Set((typeof _videoAudioSrcNodes === "function" ? _videoAudioSrcNodes() : []).map(n => n.id));
  for (const node of state.nodes) {
    if (!node || (node.type !== "VideoFile" && node.type !== "Webcam")) continue;
    const srcEntry = _videoSources.get(node.id);
    if (!srcEntry || !srcEntry._directGain) continue;
    const audioOn = !(node.params && node.params.audioEnabled === 0);
    const vol = (node.params && typeof node.params.volume === "number") ? node.params.volume : 1.0;
    const hasWire = wiredIds.has(node.id);
    // Webcam never plays directly (would echo). VideoFile plays
    // directly only when there's no wire to the patch.
    let v = 0;
    if (node.type === "VideoFile" && !hasWire) v = audioOn ? vol : 0;
    srcEntry._directGain.gain.value = v;
  }
}

/* Cached audio-input device list, populated after first permission
 * grant (browsers only expose device labels once the user has
 * approved at least one mic). The MicInput props pane reads this
 * to populate the source dropdown. */
let _micDeviceList = [];
async function refreshMicDeviceList() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    _micDeviceList = all.filter(d => d.kind === "audioinput")
      .map(d => ({ deviceId: d.deviceId, label: d.label || "" }));
  } catch (e) {
    console.warn("[mic] enumerateDevices failed:", e);
  }
}

/* Record a 1.5-second snippet from the user's microphone and store
 * it as a triggerSamples entry on the given VoiceTrigger node. We
 * use the existing _micStream when available (no re-prompt) and
 * decode via an OfflineAudioContext-style capture: hook a
 * MediaStreamAudioSource into a ScriptProcessor (legacy but cheap
 * + universally available for short clips), buffer the samples,
 * stop. */
async function recordVoiceTriggerSample(node) {
  if (!node || !node.params) return;
  if (!Array.isArray(node.params.triggerSamples)) node.params.triggerSamples = [];
  // Make sure we have a stream.
  if (!_micStream) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _micStream = stream;
      const tracks = stream.getAudioTracks();
      _micDeviceLabel = tracks.length ? tracks[0].label : "default";
      await refreshMicDeviceList();
    } catch (err) {
      alert("Microphone access denied — can't record: " + (err && err.message || err));
      return;
    }
  }
  const DURATION_S = 1.5;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(_micStream);
  // ScriptProcessorNode is deprecated but still works in every
  // browser the editor targets. AudioWorklet would be cleaner but
  // requires registering a module — overkill for a 1.5 s capture.
  const PROC_BUF = 1024;
  const proc = ctx.createScriptProcessor(PROC_BUF, 1, 1);
  const target = Math.ceil(DURATION_S * ctx.sampleRate);
  const data = new Float32Array(target);
  let written = 0;
  const btn = document.getElementById("btn-vt-record");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏺ RECORDING…";
    btn.classList.add("danger");
  }
  proc.onaudioprocess = (ev) => {
    if (written >= target) return;
    const inBuf = ev.inputBuffer.getChannelData(0);
    const room = Math.min(inBuf.length, target - written);
    data.set(inBuf.subarray(0, room), written);
    written += room;
    if (written >= target) finish();
  };
  src.connect(proc);
  proc.connect(ctx.destination);   // Required to make it tick — but we'll mute via gain.
  // Wait — connecting to destination would echo the mic. Detour:
  // route through a zero-gain node so the processor still ticks.
  proc.disconnect(ctx.destination);
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;
  proc.connect(muteGain);
  muteGain.connect(ctx.destination);
  let done = false;
  function finish() {
    if (done) return;
    done = true;
    try { src.disconnect(); proc.disconnect(); muteGain.disconnect(); } catch (e) {}
    try { ctx.close(); } catch (e) {}
    pushHistory("vt-rec:" + node.id);
    const idx = node.params.triggerSamples.length + 1;
    node.params.triggerSamples.push({
      name: "rec_" + idx,
      durationSec: DURATION_S,
      sampleRate: ctx.sampleRate,
      // Store as a regular Array so it serializes cleanly into JSON
      // (Float32Array doesn't survive JSON.stringify intact).
      data: Array.from(data)
    });
    if (btn) {
      btn.disabled = false;
      btn.textContent = "⏺ Record trigger word (1.5 s)";
      btn.classList.remove("danger");
    }
    renderProps(); renderJson();
  }
  // Safety timer in case onaudioprocess starves.
  setTimeout(finish, (DURATION_S + 0.5) * 1000);
}

function disconnectMic() {
  if (previewState.micSource) {
    try { previewState.micSource.disconnect(); } catch (e) {}
    previewState.micSource = null;
  }
  previewState.micConnected = false;
  // Tear down any running KeywordSpotter detectors too — they tap
  // the same mic stream and would dangle otherwise.
  teardownAllKeywordSpotters();
}

