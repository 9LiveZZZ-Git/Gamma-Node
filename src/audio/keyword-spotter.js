/* =========================================================================
 * KeywordSpotter detection pipeline
 *
 * For each KeywordSpotter node with at least one triggerSamples
 * recording, run a JS-side detector that:
 *   1. Computes a 16-point normalized amplitude envelope from each
 *      recording at preview-start time (the "templates").
 *   2. Taps the live mic stream via a ScriptProcessor and maintains
 *      a rolling buffer of the last 1.5 s of audio.
 *   3. Every ~80 ms, extracts the same 16-point envelope from the
 *      buffer and compares to each template via cosine similarity.
 *   4. When the best similarity exceeds matchThreshold AND a
 *      cooldown has elapsed (so a single utterance can't fire
 *      multiple times), dispatches a setter call to fire the
 *      C++ helper's triggerFromJS hostGate.
 *
 * The 16-point envelope is computed by:
 *   - Splitting the input into 16 equal chunks
 *   - Taking RMS of each chunk
 *   - Subtracting the mean and dividing by std-dev (zero-mean unit-
 *     variance), so cosine similarity is loudness-invariant
 *
 * Limitations: amplitude-envelope shape is order-invariant
 * relative to phonemes — captures word duration + energy contour
 * but not what's actually said. Distinguishes "silence" from
 * "speech" reliably; distinguishes a sharp consonant-heavy word
 * from a soft vowel-heavy word; can't distinguish "hello" from
 * "yellow" reliably. For phoneme-level detection the next pass
 * needs MFCC features + DTW. Out of scope for v1.
 * ======================================================================== */

const KS_ENV_BINS = 16;
const KS_TEMPLATE_DURATION_S = 1.5;
const KS_DETECT_INTERVAL_MS = 80;
const KS_COOLDOWN_MS = 600;

// Map nodeId → { templates: [Float32Array(16)], spec: { sampleRate, bufferSec, ringBuf, writeIdx, scriptProc, sourceNode, intervalId, lastFireMs, threshold, fireSetterIndex }}
const _ksDetectors = new Map();

function _ksComputeEnvelope(data, len) {
  // data: typed-array-like of mono PCM samples; len: number of samples to use
  const out = new Float32Array(KS_ENV_BINS);
  const usable = Math.max(1, Math.min(len || data.length, data.length));
  const step = usable / KS_ENV_BINS;
  for (let bin = 0; bin < KS_ENV_BINS; bin++) {
    const lo = Math.floor(bin * step);
    const hi = Math.min(usable, Math.floor((bin + 1) * step));
    let sumSq = 0; let n = 0;
    for (let i = lo; i < hi; i++) { const v = data[i]; sumSq += v * v; n++; }
    out[bin] = n ? Math.sqrt(sumSq / n) : 0;
  }
  // Normalize to zero-mean, unit-variance so cosine similarity is
  // loudness-invariant. Templates and live frames both go through
  // this same normalization.
  let mean = 0;
  for (let i = 0; i < KS_ENV_BINS; i++) mean += out[i];
  mean /= KS_ENV_BINS;
  let varSum = 0;
  for (let i = 0; i < KS_ENV_BINS; i++) { const d = out[i] - mean; out[i] = d; varSum += d * d; }
  const std = Math.sqrt(varSum / KS_ENV_BINS) || 1;
  for (let i = 0; i < KS_ENV_BINS; i++) out[i] /= std;
  return out;
}

function _ksCosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < KS_ENV_BINS; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb) || 1;
  return dot / denom;
}

/* Fuzzy transcript similarity — used in whisper / hybrid modes.
 * Strips punctuation, lowercases. Returns 1 if the template
 * (typically a short word) appears as a substring of the live
 * transcript (best case for keyword spotting — user said the
 * trigger word, possibly surrounded by other speech). Falls back
 * to in-order word-overlap ratio for partial matches. */
function _ksTranscriptMatch(live, template) {
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const L = norm(live);
  const T = norm(template);
  if (!L || !T) return 0;
  if (L.includes(T)) return 1;
  if (T.includes(L)) return Math.min(1, L.length / Math.max(1, T.length));
  // In-order word overlap.
  const tWords = T.split(" ");
  const lWords = L.split(" ");
  if (!tWords.length) return 0;
  let matched = 0, li = 0;
  for (const tw of tWords) {
    while (li < lWords.length && lWords[li] !== tw) li++;
    if (li < lWords.length) { matched++; li++; }
  }
  return matched / tWords.length;
}

/* Lazy-load the Whisper-tiny pipeline (the same instance the AI-
 * prompt voice button uses, exposed via the `whisperPipeline`
 * global at the top of that block). Kept async + serialized so a
 * burst of KeywordSpotter setups doesn't trigger N parallel
 * loads. */
let _ksWhisperLoading = null;
async function _ksEnsureWhisper() {
  if (typeof whisperPipeline !== "undefined" && whisperPipeline) return whisperPipeline;
  if (_ksWhisperLoading) return _ksWhisperLoading;
  _ksWhisperLoading = (async () => {
    const tx = await getTransformersJs();
    // eslint-disable-next-line no-undef -- whisperPipeline is a top-level let in the AI section
    whisperPipeline = await tx.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en");
    return whisperPipeline;
  })();
  try {
    return await _ksWhisperLoading;
  } finally {
    _ksWhisperLoading = null;
  }
}

/* Find the setter index for a KeywordSpotter's `match` host gate.
 * Returns -1 if not found (e.g., the patch wasn't compiled with
 * the spotter, or the setter table is stale). */
function _ksFindMatchSetterIndex(nodeId) {
  if (typeof collectExposedSetters !== "function") return -1;
  const setters = collectExposedSetters();
  for (let i = 0; i < setters.length; i++) {
    const s = setters[i];
    if (s.nodeId === nodeId && s.key === "match" && s.isGate) return i;
  }
  return -1;
}

/* Stand up the detector for one KeywordSpotter node. Idempotent —
 * if a detector is already running for the node, it's torn down
 * and recreated (used when the user re-records or changes the
 * threshold or detect-mode). Async because the whisper / hybrid
 * modes load the pipeline + transcribe templates upfront. */
async function setupKeywordSpotter(node) {
  if (!node || node.type !== "KeywordSpotter") return;
  const recs = (node.params && node.params.triggerSamples) || [];
  if (!recs.length) return;
  if (!previewState.audioCtx || !_micStream) return;
  // Tear down any existing detector for this node first.
  teardownKeywordSpotter(node.id);
  // Always compute envelope templates — used by 'envelope' mode
  // directly and by 'hybrid' mode as the fast pre-filter.
  const templates = recs
    .filter(r => r && Array.isArray(r.data) && r.data.length > 0)
    .map(r => _ksComputeEnvelope(r.data, r.data.length));
  if (!templates.length) return;
  const mode = (typeof node.params.detectMode === "string") ? node.params.detectMode : "envelope";
  // For whisper / hybrid modes, transcribe each recording so we
  // have a string template to match against the live transcript.
  let templateTranscripts = null;
  if (mode === "whisper" || mode === "hybrid") {
    const statusEl = document.getElementById("ks-status-" + node.id);
    if (statusEl) statusEl.textContent = "Detector: loading Whisper-tiny (one-time, ~75 MB)…";
    try {
      const wp = await _ksEnsureWhisper();
      const validRecs = recs.filter(r => r && Array.isArray(r.data) && r.data.length > 0);
      templateTranscripts = [];
      for (let i = 0; i < validRecs.length; i++) {
        if (statusEl) statusEl.textContent = `Detector: transcribing template ${i+1}/${validRecs.length}…`;
        const audio = new Float32Array(validRecs[i].data);
        try {
          const out = await wp(audio);
          const text = (out && out.text || "").trim();
          templateTranscripts.push(text);
        } catch (e) {
          console.warn("[ks] template transcribe failed:", e);
          templateTranscripts.push("");
        }
      }
      console.info("[ks] node", node.id, "template transcripts:", templateTranscripts);
    } catch (err) {
      console.warn("[ks] whisper load failed, falling back to envelope:", err);
      if (statusEl) statusEl.textContent = "Detector: Whisper load failed — using envelope mode.";
      templateTranscripts = null;
    }
  }
  // Tap the mic into a ScriptProcessor so we can read live frames.
  const ctx = previewState.audioCtx;
  const PROC_BUF = 1024;
  const sourceNode = ctx.createMediaStreamSource(_micStream);
  const proc = ctx.createScriptProcessor(PROC_BUF, 1, 1);
  // Rolling buffer of the last KS_TEMPLATE_DURATION_S seconds.
  const bufferSamples = Math.ceil(KS_TEMPLATE_DURATION_S * ctx.sampleRate);
  const ringBuf = new Float32Array(bufferSamples);
  const state = {
    templates,
    templateTranscripts,    // null in envelope mode; array of strings in whisper/hybrid
    mode,                   // "envelope" | "whisper" | "hybrid"
    threshold: (typeof node.params.matchThreshold === "number") ? node.params.matchThreshold : 0.85,
    sampleRate: ctx.sampleRate,
    ringBuf,
    bufferSamples,
    writeIdx: 0,
    sourceNode,
    scriptProc: proc,
    muteGain: null,
    intervalId: null,
    lastFireMs: 0,
    fireSetterIndex: _ksFindMatchSetterIndex(node.id),
    transcribeInFlight: false,
    lastTranscribeMs: 0
  };
  proc.onaudioprocess = (ev) => {
    const inBuf = ev.inputBuffer.getChannelData(0);
    // Append into the circular buffer.
    for (let i = 0; i < inBuf.length; i++) {
      state.ringBuf[state.writeIdx] = inBuf[i];
      state.writeIdx = (state.writeIdx + 1) % state.bufferSamples;
    }
  };
  // Connect through a zero-gain node so the ScriptProcessor ticks
  // (it needs a destination) without echoing the mic to speakers.
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;
  sourceNode.connect(proc);
  proc.connect(muteGain);
  muteGain.connect(ctx.destination);
  state.muteGain = muteGain;
  // Run the comparison on a JS interval. Keep the work small —
  // 16-point envelope on a 1.5 s buffer + 16-element dot products
  // for each template + a few comparisons. Cheap.
  // Reusable: snapshot the rolling buffer in chronological order.
  function _snapshotBuffer() {
    const frame = new Float32Array(state.bufferSamples);
    let r = state.writeIdx;
    for (let i = 0; i < state.bufferSamples; i++) {
      frame[i] = state.ringBuf[r];
      r = (r + 1) % state.bufferSamples;
    }
    return frame;
  }
  // Reusable: dispatch the `match` host gate. Re-resolves the
  // setter index lazily since the setter order can change between
  // recompiles.
  function _fireMatch(reason, scoreText, statusEl) {
    const now = Date.now();
    if (now - state.lastFireMs <= KS_COOLDOWN_MS) return false;
    state.lastFireMs = now;
    if (state.fireSetterIndex < 0) {
      state.fireSetterIndex = _ksFindMatchSetterIndex(node.id);
    }
    if (state.fireSetterIndex >= 0 && previewState.workletNode) {
      previewState.workletNode.port.postMessage({
        type: "set",
        index: state.fireSetterIndex,
        value: 0
      });
    }
    if (statusEl) {
      statusEl.style.color = "var(--phosphor)";
      statusEl.textContent = `▲ MATCH · ${reason} ${scoreText}`;
      setTimeout(() => { if (statusEl) statusEl.style.color = ""; }, 400);
    }
    return true;
  }
  // Schedule a Whisper transcription on the current buffer if one
  // isn't already in flight and the cadence (~600 ms) has elapsed.
  // Returns immediately; the result drives _fireMatch via promise.
  // Used by both 'whisper' (sole detector) and 'hybrid' (confirm).
  function _maybeTranscribe(onResult) {
    if (state.transcribeInFlight) return;
    const now = Date.now();
    if (now - state.lastTranscribeMs < 600) return;
    state.lastTranscribeMs = now;
    state.transcribeInFlight = true;
    const frame = _snapshotBuffer();
    Promise.resolve()
      .then(() => whisperPipeline(frame))
      .then((out) => {
        const live = (out && out.text || "").trim();
        let bestSim = 0;
        if (state.templateTranscripts) {
          for (const tt of state.templateTranscripts) {
            const sim = _ksTranscriptMatch(live, tt);
            if (sim > bestSim) bestSim = sim;
          }
        }
        onResult(live, bestSim);
      })
      .catch((err) => { console.warn("[ks] transcribe error:", err); })
      .finally(() => { state.transcribeInFlight = false; });
  }
  state.intervalId = setInterval(() => {
    const statusEl = document.getElementById("ks-status-" + node.id);
    // Always compute the envelope similarity — needed for 'envelope'
    // and 'hybrid' modes, and useful as a status readout in
    // 'whisper' mode too.
    const frame = _snapshotBuffer();
    const liveEnv = _ksComputeEnvelope(frame, frame.length);
    let bestEnv = -1;
    for (let i = 0; i < state.templates.length; i++) {
      const sim = _ksCosine(liveEnv, state.templates[i]);
      if (sim > bestEnv) bestEnv = sim;
    }
    if (state.mode === "envelope") {
      if (statusEl) {
        statusEl.textContent =
          `Detector [env]: ${state.templates.length} templates · best ${bestEnv.toFixed(2)} / threshold ${state.threshold.toFixed(2)}`;
      }
      if (bestEnv > state.threshold) {
        _fireMatch("envelope", `· similarity ${bestEnv.toFixed(2)}`, statusEl);
      }
    } else if (state.mode === "whisper") {
      // Pure whisper mode — fire only on transcript match.
      if (statusEl && !state.transcribeInFlight) {
        statusEl.textContent =
          `Detector [whisper]: ${state.templates.length} templates · listening… (env ${bestEnv.toFixed(2)} unused) / threshold ${state.threshold.toFixed(2)}`;
      }
      _maybeTranscribe((live, bestSim) => {
        if (statusEl) {
          statusEl.textContent =
            `Detector [whisper]: heard "${(live || "—").slice(0, 40)}" · match ${bestSim.toFixed(2)} / threshold ${state.threshold.toFixed(2)}`;
        }
        if (bestSim > state.threshold) {
          _fireMatch("whisper", `· "${(live || "").slice(0, 30)}" match ${bestSim.toFixed(2)}`, statusEl);
        }
      });
    } else if (state.mode === "hybrid") {
      // Hybrid: envelope is the fast trigger, whisper is the
      // confirm/cancel filter. Logic — fire only when envelope
      // suggests a candidate AND whisper agrees within a recent
      // window. We keep a "pending envelope hit" state and let
      // the whisper pass either upgrade it to a fire or drop it.
      const envHot = bestEnv > state.threshold;
      const ENV_HOT_TTL_MS = 800;   // how long after envelope-hot the whisper pass has to confirm
      const now = Date.now();
      if (envHot) state.envHotUntilMs = now + ENV_HOT_TTL_MS;
      const stillHot = state.envHotUntilMs && now < state.envHotUntilMs;
      if (statusEl && !state.transcribeInFlight) {
        statusEl.textContent =
          `Detector [hybrid]: env ${bestEnv.toFixed(2)} ${stillHot ? "· hot — awaiting whisper confirm" : ""} / threshold ${state.threshold.toFixed(2)}`;
      }
      if (stillHot) {
        _maybeTranscribe((live, bestSim) => {
          if (statusEl) {
            statusEl.textContent =
              `Detector [hybrid]: env ${bestEnv.toFixed(2)} · whisper "${(live || "—").slice(0, 30)}" match ${bestSim.toFixed(2)}`;
          }
          if (bestSim > state.threshold) {
            _fireMatch("hybrid", `· env ${bestEnv.toFixed(2)} + whisper ${bestSim.toFixed(2)}`, statusEl);
            state.envHotUntilMs = 0;
          }
        });
      }
    }
  }, KS_DETECT_INTERVAL_MS);
  _ksDetectors.set(node.id, state);
}

/* Tear down the detector for one node — disconnect Web Audio
 * graph, clear the comparison interval. Called from preview stop,
 * mic disconnect, and any node-edit that invalidates the templates. */
function teardownKeywordSpotter(nodeId) {
  const s = _ksDetectors.get(nodeId);
  if (!s) return;
  if (s.intervalId) clearInterval(s.intervalId);
  try { s.sourceNode && s.sourceNode.disconnect(); } catch (e) {}
  try { s.scriptProc && s.scriptProc.disconnect(); } catch (e) {}
  try { s.muteGain && s.muteGain.disconnect(); } catch (e) {}
  _ksDetectors.delete(nodeId);
}

function teardownAllKeywordSpotters() {
  Array.from(_ksDetectors.keys()).forEach(teardownKeywordSpotter);
}

/* Re-prime templates for a single node. Called from the props
 * pane when the user adds or deletes a recording or moves the
 * threshold slider. If the node isn't currently running (no
 * preview), this is a no-op — the fresh templates will be
 * computed at next preview start. Re-transcribes templates if
 * the detector is in whisper / hybrid mode. */
async function refreshKeywordSpotterTemplates(nodeId) {
  if (!_ksDetectors.has(nodeId)) return;
  const node = nodeById(nodeId);
  if (!node) { teardownKeywordSpotter(nodeId); return; }
  const recs = (node.params && node.params.triggerSamples) || [];
  if (!recs.length) { teardownKeywordSpotter(nodeId); return; }
  const s = _ksDetectors.get(nodeId);
  s.templates = recs
    .filter(r => r && Array.isArray(r.data) && r.data.length > 0)
    .map(r => _ksComputeEnvelope(r.data, r.data.length));
  s.threshold = (typeof node.params.matchThreshold === "number") ? node.params.matchThreshold : 0.85;
  // Whisper / hybrid: re-transcribe templates if the recording
  // set changed. Threshold-only updates skip this since they
  // don't affect the templates themselves.
  if ((s.mode === "whisper" || s.mode === "hybrid") && typeof whisperPipeline !== "undefined" && whisperPipeline) {
    const validRecs = recs.filter(r => r && Array.isArray(r.data) && r.data.length > 0);
    const next = [];
    for (const r of validRecs) {
      try {
        const audio = new Float32Array(r.data);
        const out = await whisperPipeline(audio);
        next.push((out && out.text || "").trim());
      } catch (e) {
        next.push("");
      }
    }
    s.templateTranscripts = next;
    console.info("[ks] refreshed transcripts for", nodeId, ":", next);
  }
}

/* Stand up detectors for every KeywordSpotter in the current
 * patch. Called from the preview-start path after the mic stream
 * is hooked up. Async since whisper-mode setup loads the
 * pipeline + transcribes templates upfront. */
async function setupAllKeywordSpotters() {
  for (const n of state.nodes) {
    if (n.type === "KeywordSpotter") {
      try { await setupKeywordSpotter(n); }
      catch (e) { console.warn("[ks] setup failed for", n.id, e); }
    }
  }
}

function showCompileStderr(stderr, errMsg) {
  const sect = document.getElementById("build-stderr-section");
  const out  = document.getElementById("build-stderr");
  if (!sect || !out) return;
  if (!stderr && !errMsg) { sect.style.display = "none"; return; }
  sect.style.display = "block";
  out.textContent = (errMsg ? "// " + errMsg + "\n\n" : "") + (stderr || "");
}

function previewStop() {
  // If a compile is in-flight, kill the worker so user gets out of a
  // long-running clang invocation. Next Play will respawn the worker;
  // the @wasmer/sdk + clang package stay cached in IndexedDB so the
  // restart is fast (the SDK init takes ~2 s; clang reload is ~5 s
  // when cached vs the original ~3 min download).
  if (previewState.state === "compiling" && previewState.worker) {
    previewState.worker.terminate();
    previewState.worker = null;
    previewState.workerReady = null;
    previewProgressEnd(false);
    setPreviewStatus("idle", "compile canceled");
    return;
  }
  // Disconnect mic source BEFORE the audio context is closed —
  // otherwise the source's underlying MediaStreamTrack stays active
  // (different lifecycle) and the OS-level mic indicator stays on.
  disconnectMic();
  // v0.3.19 — also tear down the VideoSrc routing chain so the
  // ChannelMerger / GainNodes / MediaElementSources don't outlive
  // the audio context. We can't recreate MES for the same videoEl
  // later (one-shot per element); we clear the cached refs so a
  // future Play+ensureVideoAudioConnected can reuse the videoEls
  // (the existing _videoSources entries persist) with fresh MES.
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
  // Clear per-source MES refs so the next Play creates fresh ones
  // against the new audioCtx (MES is tied to its creation context).
  _videoSources.forEach(entry => {
    if (entry._mediaSource) {
      try { entry._mediaSource.disconnect(); } catch (_) {}
      entry._mediaSource = null;
    }
    if (entry._directGain) {
      try { entry._directGain.disconnect(); } catch (_) {}
      entry._directGain = null;
    }
  });
  if (previewState.workletNode) {
    previewState.workletNode.port.postMessage({ type: "stop" });
    previewState.workletNode.disconnect();
    previewState.workletNode = null;
  }
  if (previewState.audioCtx) {
    previewState.audioCtx.close().catch(() => {});
    previewState.audioCtx = null;
  }
  previewState.analyserL = null;
  previewState.analyserR = null;
  stopMeterLoop();
  previewProgressEnd(false);
  setPreviewStatus("idle", "idle");
}

if (previewBtnPlay) {
  previewBtnPlay.addEventListener("click", () => {
    if (previewState.state === "playing") {
      // Pause
      if (previewState.audioCtx) previewState.audioCtx.suspend();
      setPreviewStatus("paused", "paused");
    } else if (previewState.state === "paused") {
      if (previewState.audioCtx) previewState.audioCtx.resume();
      setPreviewStatus("playing", "playing");
    } else {
      previewCompileAndPlay();
    }
  });
}
if (previewBtnStop) previewBtnStop.addEventListener("click", previewStop);

