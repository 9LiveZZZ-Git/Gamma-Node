/* ------------- Smoke test ----------------------------------------------
 * Compiles a trivial 4-line C++ source (no Gamma) to verify the toolchain
 * works end-to-end. Useful when a real patch fails — tells you whether
 * the issue is with Gamma specifically or the entire SDK / clang path.
 * Output isn't loaded into the AudioWorklet; just shows wasm size +
 * timing in the status pill on success, or the actual error on failure. */
const SMOKE_TEST_SRC = `
__attribute__((export_name("smoke")))
extern "C" int smoke() { return 42; }
`;

const previewBtnSmoke = document.getElementById("btn-preview-smoke");
if (previewBtnSmoke) previewBtnSmoke.addEventListener("click", async () => {
  if (previewState.state === "compiling") return;
  setPreviewStatus("compiling", "smoke test compiling…");
  previewProgressStart();
  previewProgressStage("prepare");
  // Local-server fast path for smoke too.
  if (await probeLocalServer()) {
    const t0 = Date.now();
    try {
      previewProgressStage("compile");
      const { wasmBytes, stderr } = await compileViaLocalServer(SMOKE_TEST_SRC, true);
      const ms = Date.now() - t0;
      previewProgressFinish();
      setPreviewStatus("idle", "smoke ✓ via local-cli — " + wasmBytes.byteLength + " byte wasm in " + fmtDuration(ms));
      showCompileStderr(stderr || "", null);
    } catch (e) {
      previewProgressEnd(false);
      setPreviewStatus("error", "smoke (local-cli): " + e.message);
      showCompileStderr(e.stderr || "", e.message);
    }
    return;
  }
  try {
    await ensureCompileWorker();
  } catch (e) {
    previewProgressEnd(false);
    setPreviewStatus("error", "smoke worker init: " + e.message);
    return;
  }
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const onReply = (ev) => {
      const m = ev.data;
      if (m.type === "progress" && m.stage) {
        if (typeof m.subProgress === "number" && m.subProgress > 0) {
          const idx = PREVIEW_STAGES.findIndex(s => s.id === m.stage);
          if (idx === previewProgress.stageIdx) previewProgressSub(m.subProgress);
          else previewProgressStage(m.stage, m.subProgress);
        } else {
          previewProgressStage(m.stage);
        }
        const stage = PREVIEW_STAGES.find(s => s.id === m.stage);
        if (stage) setPreviewStatus("compiling", "smoke: " + stage.label);
      } else if (m.type === "compiled") {
        previewState.worker.removeEventListener("message", onReply);
        const ms = Date.now() - t0;
        const bytes = m.wasmBytes instanceof ArrayBuffer ? m.wasmBytes : m.wasmBytes.buffer;
        previewProgressFinish();
        setPreviewStatus("idle", `smoke ✓ — ${bytes.byteLength} byte wasm in ${fmtDuration(ms)}`);
        showCompileStderr(m.stderr || "", null);
        resolve();
      } else if (m.type === "compile-error") {
        previewState.worker.removeEventListener("message", onReply);
        previewProgressEnd(false);
        setPreviewStatus("error", "smoke: " + m.error);
        showCompileStderr(m.stderr || "", m.error);
        reject(new Error(m.error));
      }
    };
    previewState.worker.addEventListener("message", onReply);
    previewState.worker.postMessage({
      type: "compile",
      smokeTest: true,
      wrappedSrc: SMOKE_TEST_SRC,
      archiveUrl: new URL(PREVIEW.gammaArchiveUrl, location.href).toString(),
      sdkUrl: PREVIEW.wasmerSdkUrl
    });
  }).catch(() => { /* status already set */ });
});

/* ------------- Hot-reload trigger ------------- */
/* Hook into render() so any graph mutation kicks a debounced recompile
 * when preview is currently playing. */
const originalRender = render;
render = function() {
  originalRender.apply(this, arguments);
  if (previewState.state === "playing" || previewState.state === "compiling") {
    if (previewState.pendingCompile) clearTimeout(previewState.pendingCompile);
    previewState.pendingCompile = setTimeout(() => {
      previewState.pendingCompile = null;
      // Only recompile if the wrapped C++ actually changed.
      try {
        const cpp = generateCode();
        if (cpp.startsWith("// ❌")) return;
        const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
        const wrapped = wrapForPreview(cpp, className);
        if (wrapped === previewState.lastWrapped) return;
        previewCompileAndPlay();
      } catch (e) { /* swallow — codegen errors shown in main path */ }
    }, PREVIEW.hotReloadDebounceMs);
  }
  // Also refresh the Build pane if visible.
  const buildPane = document.getElementById("pane-build");
  if (buildPane && buildPane.style.display !== "none") renderBuildPane();
};

setPreviewStatus("idle", "idle");

/* (Community library tab removed; meter + keyboard now live in the
 * Monitor tab and use the existing app palette.) */

/* ------------- Panel sizing / collapse / maximize ------------- */
/* Side palette + bottom footer can be resized by dragging splitters,
 * collapsed (▾/›), maximized (footer only — fills viewport), or
 * popped out into a separate window (snapshot of active pane). All
 * preferences persist to localStorage so the layout survives reloads. */
const PANEL_PREFS_KEY = "gamma-editor-panel-prefs-v1";
const panelPrefs = (() => {
  try { return JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || "{}") || {}; }
  catch (_) { return {}; }
})();
function savePanelPrefs() {
  try { localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(panelPrefs)); } catch (_) {}
}

// Restore saved sizes / collapse state.
const paletteAside = document.getElementById("palette-aside");
const bottomFooter = document.getElementById("bottom-footer");
/* Restore the palette width from prefs. If the stored value is
 * below the drag minimum (180px) we ignore it and fall through to
 * the CSS default (248px) — that's the self-heal for users who
 * persisted a too-narrow value before the min was raised. The
 * dedicated collapsed state (32px + `.collapsed` class) is set
 * further down via the paletteCollapsed flag, not here. */
if (typeof panelPrefs.paletteW === "number" && panelPrefs.paletteW >= 180) {
  document.documentElement.style.setProperty("--palette-w", panelPrefs.paletteW + "px");
} else if (typeof panelPrefs.paletteW === "number" && panelPrefs.paletteW < 180) {
  // Auto-correct the stored value so future saves don't drift back
  panelPrefs.paletteW = 248;
  savePanelPrefs();
}
if (typeof panelPrefs.footerH === "number" && panelPrefs.footerH >= 38) {
  document.documentElement.style.setProperty("--footer-h", panelPrefs.footerH + "px");
}
if (panelPrefs.paletteCollapsed) {
  paletteAside.classList.add("collapsed");
  document.documentElement.style.setProperty("--palette-w", "32px");
}
if (panelPrefs.footerCollapsed) bottomFooter.classList.add("collapsed");

/* Drag to resize. Each splitter installs a pointerdown handler that
 * captures the pointer + tracks delta until pointerup. We update the
 * CSS variable live so the grid reflows in real time. */
function installResize(handle, opts) {
  let startVal = 0, startCoord = 0;
  const onMove = (ev) => {
    const delta = (ev[opts.coord] - startCoord) * (opts.invert ? -1 : 1);
    let next = startVal + delta;
    next = Math.max(opts.min, Math.min(opts.max(), next));
    document.documentElement.style.setProperty(opts.cssVar, next + "px");
    opts.last = next;
  };
  const onUp = (ev) => {
    handle.classList.remove("dragging");
    handle.releasePointerCapture(ev.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    if (typeof opts.last === "number") {
      panelPrefs[opts.prefKey] = opts.last;
      savePanelPrefs();
    }
  };
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    handle.classList.add("dragging");
    startCoord = ev[opts.coord];
    startVal = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(opts.cssVar)) || opts.fallback;
    handle.setPointerCapture(ev.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    ev.preventDefault();
  });
}
installResize(document.getElementById("palette-resize"), {
  coord: "clientX",
  cssVar: "--palette-w",
  fallback: 248,
  // Don't let the drag shrink the panel below where the content is
  // still useful. The dedicated collapsed state (32px) is reached
  // by clicking the ‹ button, not by dragging — a separate gesture
  // with its own CSS that hides the search/list/foot in favour of
  // the vertical "PALETTE ›" expand strip. Dragging to ~32px without
  // the .collapsed class left the panel in a half-broken in-between
  // where the scrollbar took most of the width and the resize
  // column itself became unfindable.
  min: 180,
  max: () => Math.min(window.innerWidth - 200, 600),
  prefKey: "paletteW"
});
installResize(document.getElementById("footer-resize"), {
  coord: "clientY",
  cssVar: "--footer-h",
  fallback: 240,
  min: 38,
  max: () => window.innerHeight - 80,
  prefKey: "footerH",
  invert: true       // dragging UP increases footer height
});

// Side-panel collapse toggle.
const btnPaletteMin = document.getElementById("btn-palette-min");
const paletteCollapseStrip = document.getElementById("palette-collapse-strip");
function setPaletteCollapsed(collapsed) {
  panelPrefs.paletteCollapsed = collapsed;
  if (collapsed) {
    paletteAside.classList.add("collapsed");
    panelPrefs.paletteWBeforeCollapse = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--palette-w")) || 248;
    document.documentElement.style.setProperty("--palette-w", "32px");
  } else {
    paletteAside.classList.remove("collapsed");
    const restoreW = panelPrefs.paletteWBeforeCollapse || 248;
    document.documentElement.style.setProperty("--palette-w", restoreW + "px");
    panelPrefs.paletteW = restoreW;
  }
  savePanelPrefs();
}
btnPaletteMin.addEventListener("click", () => setPaletteCollapsed(true));
paletteCollapseStrip.addEventListener("click", () => setPaletteCollapsed(false));

// Footer collapse / maximize / exit.
const btnFooterMin = document.getElementById("btn-footer-min");
const btnFooterMax = document.getElementById("btn-footer-max");
const btnFooterExit = document.getElementById("btn-footer-exit");

btnFooterMin.addEventListener("click", () => {
  const collapsed = bottomFooter.classList.toggle("collapsed");
  panelPrefs.footerCollapsed = collapsed;
  savePanelPrefs();
});
btnFooterMax.addEventListener("click", () => {
  bottomFooter.classList.add("maximized");
  bottomFooter.classList.remove("collapsed");
});
btnFooterExit.addEventListener("click", () => {
  bottomFooter.classList.remove("maximized");
});

// Esc exits maximize.
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && bottomFooter.classList.contains("maximized")) {
    bottomFooter.classList.remove("maximized");
  }
});

/* v0.2.23 — Standalone HTML loader. The Export → Standalone HTML
 * flow bakes the current patch into a fresh copy of this file as a
 * `<script type="application/json" id="gamma-embedded-patch">` tag.
 * On reopen, that tag's presence is the cue to replace the default
 * freshState() patch with the embedded one BEFORE the first render.
 * If the tag is absent (normal editor load) this is a no-op.
 *
 * Auto Live-Mode: an optional sidecar tag `gamma-embedded-config`
 * carries the export-time preferences. Today supports
 * { autoLiveMode: true } so the standalone opens fullscreen visuals
 * by default. Press L to toggle back to the editor either way. */
(function _maybeLoadEmbeddedPatch() {
  const tag = document.getElementById("gamma-embedded-patch");
  if (!tag) return;
  try {
    const loaded = JSON.parse(tag.textContent);
    if (!loaded || !loaded.nodes || !loaded.edges) {
      console.warn("[standalone] embedded patch missing nodes/edges; falling back to default");
      return;
    }
    const fname = loaded.filename ||
      ((loaded.patchName ? String(loaded.patchName) : "embedded") + ".gpatch");
    _applyLoadedPatch(loaded, fname);
    console.log("[standalone] embedded patch loaded: " + (loaded.patchName || "(unnamed)"));
  } catch (e) {
    console.warn("[standalone] embedded patch parse failed; using default:", e);
    return;
  }

  // v0.2.24 — decode embedded wasm. The Export → Standalone viewer
  // path bakes the compiled patch wasm as a base64 <script> block
  // so the page can run audio without a compile-server / Wasmer SDK.
  // Decoded once at boot, stashed both on previewState.lastWasm (so
  // the Audio render path can reuse it) and on window._gammaViewerWasm
  // (so the play button has a fresh untransferred copy to send).
  const wasmTag = document.getElementById("gamma-embedded-wasm");
  if (wasmTag) {
    try {
      const b64 = (wasmTag.textContent || "").trim();
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      previewState.lastWasm = arr.buffer;
      window._gammaViewerWasm = arr.buffer;
      console.log("[viewer] embedded wasm loaded (" + bin.length + " bytes)");
    } catch (e) {
      console.warn("[viewer] embedded wasm decode failed:", e);
    }
  }

  // Optional auto-Live-Mode + viewer mode after WebGPU has settled.
  const cfgTag = document.getElementById("gamma-embedded-config");
  if (cfgTag) {
    try {
      const cfg = JSON.parse(cfgTag.textContent);
      if (cfg && cfg.viewerMode) {
        document.body.classList.add("viewer-mode");
      }
      if (cfg && cfg.autoLiveMode) {
        // Delay so WebGPU + audio context init can settle.
        setTimeout(() => {
          if (typeof setLiveMode === "function") setLiveMode(true);
        }, 600);
      }
    } catch (e) {
      console.warn("[standalone] embedded config parse failed:", e);
    }
  }
})();

/* v0.2.24 — Standalone viewer: play the bundled wasm.
 *
 * Bypasses generateCode + Wasmer/local-server compile entirely.
 * Just creates / reuses the audio worklet and sends it a fresh
 * clone of window._gammaViewerWasm. Used by:
 *   - The big "▶ Play" disc in #live-mode-overlay (viewer mode)
 *   - Future "auto-play after user gesture" experiments
 *
 * Status flips body.viewer-playing so the play disc fades out via
 * the CSS rule body.viewer-mode.viewer-playing #btn-viewer-play
 * { display:none }. */
async function playEmbeddedWasm() {
  if (!window._gammaViewerWasm) {
    alert("No embedded wasm in this file. Save a standalone viewer from the Export menu first.");
    return;
  }
  try {
    const node = await ensureAudioWorklet();
    if (previewState.audioCtx && previewState.audioCtx.state === "suspended") {
      await previewState.audioCtx.resume();
    }
    // Clone before postMessage transfer (detaches the source buffer).
    const bytes = window._gammaViewerWasm.slice(0);
    previewState.lastWasm = bytes.slice(0);
    node.port.postMessage({ type: "load", wasmBytes: bytes }, [bytes]);
    document.body.classList.add("viewer-playing");
    setPreviewStatus("playing", "playing (viewer)");
  } catch (e) {
    console.warn("[viewer] play failed:", e);
    alert("Could not start playback: " + (e && e.message || e));
  }
}

/* Wire the viewer play button. Outside viewer mode the button is
 * display:none via CSS and click never fires. */
(function _wireViewerPlay() {
  const btn = document.getElementById("btn-viewer-play");
  if (btn) btn.addEventListener("click", () => playEmbeddedWasm());
})();

// _applyLoadedPatch already calls render() when it succeeds. Calling
// render() unconditionally below would be redundant in the embedded
// case but is needed for the default (no-embedded-patch) load. The
// extra call is cheap (DOM diff already done) so we keep it for the
// simpler control flow.
render();

/* Phase 6.1.2 — kick off WebGPU device acquisition. Lazy enough that
 * it doesn't block first paint (the editor is fully usable for audio
 * before this resolves), but eager enough that the GPU pill in the
 * header settles to its final state (ready / unavailable / error)
 * within ~50 ms of page load on a typical machine. WebGPU is
 * permissionless — no consent dialog, no risk of surprising the user
 * mid-session — so calling it at startup is safe. */
ensureGPUDevice();

/* Live Mode wiring — toolbar button, in-mode exit button, and the L
 * hotkey. The hotkey runs on the existing window keydown handler
 * registered higher up; we add a second listener here that's gated on
 * !isTextInput so typing 'l' in a CodeMirror or properties field
 * doesn't trip live-mode. Escape inside live-mode also exits (safety
 * fallback; doesn't conflict with modal-close because no modal can be
 * open while #app is display:none). */
{
  const liveBtn  = document.getElementById("btn-live-mode");
  const liveExit = document.getElementById("btn-live-exit");
  if (liveBtn)  liveBtn.addEventListener("click",  () => toggleLiveMode());
  if (liveExit) liveExit.addEventListener("click", () => setLiveMode(false));
  window.addEventListener("keydown", (e) => {
    // Live-mode hotkey: Ctrl+L (or Cmd+L on Mac). Bare L is reserved
    // for FPCamera look-right + the QWERTY musical keyboard (D5),
    // so the toggle moved to the modifier form in v0.3.135 -- avoids
    // accidental live-mode flips while walking the Walkable Terrain
    // demo. Alt left untouched (it's a modifier for other shortcuts).
    if (e.altKey) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) {
      if (!isLiveMode() && isTextInput(document.activeElement)) return;
      // Browser may also map Ctrl+L to address-bar focus; preventDefault
      // claims the chord for the editor.
      e.preventDefault();
      toggleLiveMode();
      return;
    }
    if (e.key === "Escape" && isLiveMode()) {
      e.preventDefault();
      setLiveMode(false);
    }
  });
}

/* Phase 6.7.1 + 6.7.2 + 6.7.3 — wire the three visual-HUD pills:
 *   ⊟ / ▣  → hide-graph toggle (also bare H hotkey)
 *   📷    → capture frame to PNG
 *   ●     → start/stop video capture (.webm)
 * Hotkey guards mirror the Live-Mode L pattern: skip modifier-chord,
 * skip text-input typing, skip when audio preview is playing (H is
 * MIDI A4 on the QWERTY keymap). */
{
  const hidePill   = document.getElementById("graph-hide-pill");
  const snapBtn    = document.getElementById("snap-btn");
  const recPill    = document.getElementById("video-rec-pill");
  if (hidePill) hidePill.addEventListener("click", () => toggleGraphHidden());
  if (snapBtn)  snapBtn.addEventListener("click",  () => captureVisualFrame());
  if (recPill)  recPill.addEventListener("click",  () => captureVideoToggle());
  // Phase 6.7.4 -- perf overlay pill + Shift+P hotkey.
  const perfPill = document.getElementById("perf-pill");
  if (perfPill) perfPill.addEventListener("click", () => togglePerfOverlay());
  // Initialize the rec pill title (the "stop" state) so screen readers
  // pick it up before the first click.
  _updateVideoUi(false);
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTextInput(document.activeElement)) return;
    // Phase 6.7.4 -- Shift+P toggles perf overlay. (Bare P is QWERTY
    // MIDI G#4 -- audio runtime wins like the H rule below.)
    if (e.shiftKey && (e.key === "P" || e.key === "p")) {
      e.preventDefault();
      togglePerfOverlay();
      return;
    }
    if (e.shiftKey) return;          // any other shift-chord is not ours
    if (e.key !== "h" && e.key !== "H") return;
    // Audio runtime wins: H plays MIDI A4 when the preview is running.
    if (typeof previewState !== "undefined" && previewState && previewState.state === "playing") return;
    e.preventDefault();
    toggleGraphHidden();
  });
}

/* v0.2.19 — Export center wiring. Toolbar Export button opens the
 * modal; each action proxies to the right capture/export function.
 * Patch / MPCDI / auto-capture actions defer to the EXISTING button
 * handlers (click on the hidden buttons) so the underlying behavior
 * stays in one place even though the surface UI now lives in two
 * places (Export menu + rig editor panel). */
{
  const openBtn  = document.getElementById("btn-export-open");
  const closeBtn = document.getElementById("btn-export-close");
  const modal    = document.getElementById("export-modal");
  if (openBtn)  openBtn.addEventListener("click",  _openExportModal);
  if (closeBtn) closeBtn.addEventListener("click", _closeExportModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) _closeExportModal();
    });
  }
  // Escape closes when modal is open + no other modal is intercepting.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modal && modal.style.display !== "none" && modal.style.display !== "") {
      _closeExportModal();
    }
  });

  // -- Patch --
  const savePatchBtn = document.getElementById("exp-save-gpatch");
  if (savePatchBtn) {
    savePatchBtn.addEventListener("click", () => {
      const realBtn = document.getElementById("btn-save");
      if (realBtn) realBtn.click();
      _setExportStatus("Saved .gpatch", "success");
    });
  }
  const standaloneBtn = document.getElementById("exp-standalone-html");
  if (standaloneBtn) {
    standaloneBtn.addEventListener("click", async () => {
      standaloneBtn.disabled = true;
      const nameEl = standaloneBtn.querySelector(".export-action-name");
      const orig = nameEl ? nameEl.textContent : null;
      try {
        if (nameEl) nameEl.textContent = "Building standalone HTML…";
        _setExportStatus("Fetching editor HTML + bundling patch…");
        const liveBox   = document.getElementById("exp-standalone-livemode");
        const viewerBox = document.getElementById("exp-standalone-viewer");
        const autoLiveMode = !!(liveBox && liveBox.checked);
        const viewerMode   = !!(viewerBox && viewerBox.checked);
        // Forward compile-progress to the modal status line so the
        // user sees what's happening during the (potentially long)
        // first-time compile from a freshly-loaded patch.
        const progress = (msg) => _setExportStatus(msg);
        const out = await exportStandaloneHtml({ autoLiveMode, viewerMode, progress });
        _downloadBlob(new Blob([out.html], { type: "text/html" }), out.filename);
        const mb = (out.size / (1024 * 1024)).toFixed(2);
        const wasmLine = out.viewerMode && out.wasmKb
          ? " · " + out.wasmKb.toFixed(0) + " KB wasm bundled"
          : "";
        _setExportStatus("Saved " + out.filename + " (" + mb + " MB" + wasmLine + ")", "success");
      } catch (e) {
        console.warn("[export] standalone HTML failed:", e);
        _setExportStatus("Standalone export failed: " + (e && e.message || e), "error");
      } finally {
        standaloneBtn.disabled = false;
        if (nameEl && orig) nameEl.textContent = orig;
      }
    });
  }
  const saveHeaderBtn = document.getElementById("exp-save-header");
  if (saveHeaderBtn) {
    saveHeaderBtn.addEventListener("click", () => {
      try {
        const cpp = generateCode();
        const className = (state.patchName || "MyPatch").replace(/[^A-Za-z0-9_]/g, "");
        const filename  = className + ".h";
        const blob = new Blob([cpp], { type: "text/x-c++hdr" });
        _downloadBlob(blob, filename);
        if (cpp.startsWith("// ❌")) {
          _setExportStatus("Saved " + filename + " — but contains a codegen error (see top comment)", "error");
        } else {
          _setExportStatus("Saved " + filename + " (" + cpp.length + " chars)", "success");
        }
      } catch (e) {
        console.warn("[export] header save failed:", e);
        _setExportStatus("Header save failed: " + (e && e.message || e), "error");
      }
    });
  }

  // -- Visual: composite PNG (mirrors HUD 📷 pill) --
  const compSnapBtn = document.getElementById("exp-snap-composite");
  if (compSnapBtn) {
    compSnapBtn.addEventListener("click", async () => {
      _setExportStatus("Capturing composite…");
      try {
        await captureVisualFrame();
        _setExportStatus("Composite preview saved", "success");
      } catch (e) {
        _setExportStatus("Composite capture failed: " + (e && e.message || e), "error");
      }
    });
  }

  // -- Visual: single display PNG at target resolution --
  const dispSnapBtn = document.getElementById("exp-snap-display");
  const dispSel     = document.getElementById("exp-display-pick");
  if (dispSnapBtn && dispSel) {
    dispSnapBtn.addEventListener("click", async () => {
      const idx = parseInt(dispSel.value, 10);
      if (!Number.isInteger(idx) || idx < 0) {
        _setExportStatus("Pick a display first", "error");
        return;
      }
      dispSnapBtn.disabled = true;
      const orig = dispSnapBtn.textContent;
      dispSnapBtn.textContent = "…";
      _setExportStatus("Reading display " + idx + " at " + Visual.fbWidth + "×" + Visual.fbHeight + "…");
      try {
        const blob = await capturePerDisplayPng(idx);
        const disp = state && state.rig && state.rig.displays && state.rig.displays[idx];
        const idStr = disp && disp.id ? String(disp.id) : ("d" + idx);
        const safeId = idStr.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        _downloadBlob(blob, "gamma-display-" + String(idx).padStart(2, "0") + "-" + safeId + "-" + stamp + ".png");
        _setExportStatus("Display " + idx + " saved (" + Visual.fbWidth + "×" + Visual.fbHeight + ")", "success");
      } catch (e) {
        console.warn("[export] per-display capture failed:", e);
        _setExportStatus("Per-display capture failed: " + (e && e.message || e), "error");
      } finally {
        dispSnapBtn.disabled = false;
        dispSnapBtn.textContent = orig;
      }
    });
  }

  // -- Visual: all displays ZIP --
  const allDispBtn = document.getElementById("exp-snap-all-displays");
  if (allDispBtn) {
    allDispBtn.addEventListener("click", async () => {
      allDispBtn.disabled = true;
      const orig = allDispBtn.querySelector(".export-action-name").textContent;
      try {
        const N = (Visual.framebufferLayerViews && Visual.framebufferLayerViews.length) || 0;
        if (N === 0) { _setExportStatus("No rig displays to capture", "error"); return; }
        _setExportStatus("Capturing display 0/" + N + "…");
        const blob = await captureAllDisplaysZip((cur, total) => {
          _setExportStatus("Capturing display " + cur + "/" + total + "…");
          const nameEl = allDispBtn.querySelector(".export-action-name");
          if (nameEl) nameEl.textContent = "Capturing… " + cur + "/" + total;
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        _downloadBlob(blob, "gamma-displays-" + stamp + ".zip");
        _setExportStatus(N + " displays saved as ZIP (each at " + Visual.fbWidth + "×" + Visual.fbHeight + ")", "success");
      } catch (e) {
        console.warn("[export] all-displays ZIP failed:", e);
        _setExportStatus("All-displays ZIP failed: " + (e && e.message || e), "error");
      } finally {
        allDispBtn.disabled = false;
        const nameEl = allDispBtn.querySelector(".export-action-name");
        if (nameEl) nameEl.textContent = orig;
      }
    });
  }

  // -- Visual: composite video (mirrors HUD ● pill) --
  const recBtn = document.getElementById("exp-rec-composite");
  if (recBtn) {
    recBtn.addEventListener("click", () => {
      captureVideoToggle();
      const tag = document.getElementById("exp-rec-state-tag");
      if (tag) tag.style.display = _videoRecorder ? "inline-block" : "none";
      _setExportStatus(_videoRecorder ? "Recording started — click again to stop" : "Recording stopped + downloaded", "success");
    });
  }



  // -- Visual: per-display recording (toggle, bundles into ZIP) --
  const pdRecBtn = document.getElementById("exp-rec-perdisplay");
  if (pdRecBtn) {
    pdRecBtn.addEventListener("click", async () => {
      pdRecBtn.disabled = true;
      try {
        if (perDisplayRecordingActive()) {
          _setExportStatus("Stopping per-display recording + bundling…");
          await _stopPerDisplayRecordingAndDownload();
          _setExportStatus("Per-display ZIP downloaded", "success");
        } else {
          const N = (Visual.framebufferLayerViews && Visual.framebufferLayerViews.length) || 0;
          if (N === 0) { _setExportStatus("No rig displays to record", "error"); return; }
          _setExportStatus("Starting " + N + " parallel MediaRecorders at " + Visual.fbWidth + "×" + Visual.fbHeight + "…");
          await _startPerDisplayRecording();
          _setExportStatus("Recording " + N + " displays — click again to stop", "success");
        }
      } catch (e) {
        console.warn("[export] per-display recording toggle failed:", e);
        _setExportStatus("Per-display recording failed: " + (e && e.message || e), "error");
      } finally {
        pdRecBtn.disabled = false;
      }
    });
  }

  // -- Audio render → WAV/MP3 (offline) — format selected via dropdown --
  const audioBtn  = document.getElementById("exp-audio-render");
  const audioFmt  = document.getElementById("exp-audio-format");
  if (audioBtn) {
    audioBtn.addEventListener("click", async () => {
      const fmt = (audioFmt && audioFmt.value) || "wav16";
      const fmtLabels = {
        wav16:  { ext: "wav", label: "WAV 16-bit PCM",   bitDepth: 16 },
        wav24:  { ext: "wav", label: "WAV 24-bit PCM",   bitDepth: 24 },
        wav32f: { ext: "wav", label: "WAV 32-bit float", bitDepth: 32 },
        mp3:    { ext: "mp3", label: "MP3 320 kbps",     bitrate: 320 }
      };
      const info = fmtLabels[fmt] || fmtLabels.wav16;
      const defaultDuration = 30;
      const answer = window.prompt("Render duration in seconds (1–3600):", String(defaultDuration));
      if (answer == null) return;   // user cancelled
      const duration = Math.max(1, Math.min(3600, parseFloat(answer) || defaultDuration));
      audioBtn.disabled = true;
      const orig = audioBtn.textContent;
      audioBtn.textContent = "…";
      try {
        _setExportStatus("Rendering " + duration + " s through OfflineAudioContext…");
        const audioBuf = await renderOfflineAudio(duration);
        let blob;
        if (fmt === "mp3") {
          _setExportStatus("Loading lamejs + encoding MP3…");
          blob = await audioBufferToMp3Blob(audioBuf, info.bitrate);
        } else {
          _setExportStatus("Encoding " + info.label + "…");
          blob = audioBufferToWavBlob(audioBuf, info.bitDepth);
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const className = ((state && state.patchName) || "MyPatch").replace(/[^A-Za-z0-9_]/g, "") || "MyPatch";
        const tag = fmt === "wav16"  ? "16bit"
                  : fmt === "wav24"  ? "24bit"
                  : fmt === "wav32f" ? "32bitf"
                  : "320k";
        _downloadBlob(blob, "gamma-render-" + className + "-" + tag + "-" + stamp + "." + info.ext);
        _setExportStatus("Saved " + info.label + " (" + duration + " s × " +
          audioBuf.numberOfChannels + "ch × " + audioBuf.sampleRate + " Hz, " +
          (blob.size / (1024 * 1024)).toFixed(1) + " MB)", "success");
      } catch (e) {
        console.warn("[export] audio render failed:", e);
        _setExportStatus(info.label + " render failed: " + (e && e.message || e), "error");
      } finally {
        audioBtn.disabled = false;
        audioBtn.textContent = orig;
      }
    });
  }

  // -- Timed composite A/V recording (auto-stops after N seconds) --
  const timedRecBtn = document.getElementById("exp-rec-composite-timed");
  if (timedRecBtn) {
    timedRecBtn.addEventListener("click", async () => {
      if (_videoRecorder) {
        _setExportStatus("Composite recording already running — stop it first", "error");
        return;
      }
      const answer = window.prompt("Duration in seconds (1–3600):", "30");
      if (answer == null) return;
      const duration = Math.max(1, Math.min(3600, parseFloat(answer) || 30));
      try {
        await startTimedAVRecording(duration);
        _setExportStatus("Recording " + duration + " s — will auto-stop + download", "success");
      } catch (e) {
        console.warn("[export] timed A/V record failed:", e);
        _setExportStatus("Timed recording failed: " + (e && e.message || e), "error");
      }
    });
  }

  // -- Rig: MPCDI + auto-capture (defer to the underlying buttons) --
  const mpcdiBtn = document.getElementById("exp-mpcdi");
  if (mpcdiBtn) {
    mpcdiBtn.addEventListener("click", () => {
      const realBtn = document.getElementById("btn-rig-mpcdi-export");
      if (realBtn) {
        realBtn.click();
        _setExportStatus("MPCDI bundle exported", "success");
      } else {
        _setExportStatus("MPCDI export action not available — open the Rig editor first", "error");
      }
    });
  }
  const autoCapBtn = document.getElementById("exp-auto-cap");
  if (autoCapBtn) {
    autoCapBtn.addEventListener("click", () => {
      const realBtn = document.getElementById("btn-rig-auto-capture");
      if (realBtn) {
        _closeExportModal();   // walk is long-running + uses theater preview; menu would obscure it
        realBtn.click();
      } else {
        _setExportStatus("Auto-capture action not available — open the Rig editor first", "error");
      }
    });
  }
}

/* Phase 6.1.5 — Visual HUD wiring. Resolution pill cycles on click,
 * freeze button toggles. fps readout is driven from the future rAF
 * loop (6.1.7+); for now it stays at "— fps" placeholder. Initial
 * pill text reflects the default resolution captured at Visual init. */
{
  const resPill   = document.getElementById("res-pill");
  const projPill  = document.getElementById("proj-pill");
  const freezeBtn = document.getElementById("freeze-btn");
  if (resPill) {
    _updateResolutionPill();
    resPill.addEventListener("click", _cycleRenderResolution);
  }
  // Sprint 7.5.3a -- MSAA pill cycles 1x -> 4x -> 8x.
  const msaaPill = document.getElementById("msaa-pill");
  if (msaaPill) {
    _updateMsaaPill();
    msaaPill.addEventListener("click", cycleMsaa);
  }
  if (projPill) {
    _updateProjectionPill();
    projPill.addEventListener("click", _cycleProjectionMode);
  }
  if (freezeBtn) {
    freezeBtn.addEventListener("click", toggleVisualFreeze);
  }
  // Phase 6.5.16 — gizmo toggle pill. Wires the canvas's orbit/zoom
  // handlers on first open. The gizmo is just an inset canvas now —
  // there's no separate close button (toggle the pill to dismiss).
  const gizmoPill = document.getElementById("gizmo-pill");
  if (gizmoPill) {
    gizmoPill.addEventListener("click", () => {
      toggleRigGizmo();
      if (_gizmoOpen) _wireGizmoCanvas();
    });
  }
}

// §planet-spec Phase 7.f-ai -- offline prompt-tester export hook.
// tools/pmap-prompt-tester.html loads this file in a hidden iframe
// and pulls these handles to drive the planet-map AI pipeline
// without spinning up the full painter. Exposes the building blocks:
//   .buildCells(N, noiseDef, jitter) -> cells
//   .buildHash(cells), .buildNeighbors(cells, hash, K) -> neighbors
//   .parsePlan(rawText) -> { caps: [...] }
//   .applyPlan(plan, cells, neighbors, K, seaLevel, lockedCenter)
//   .measureLandmass(cells, seaLevel) -> { landCells, totalCells, landFraction }
//   .loadReference(refKey) -> Promise<base64 png>
//   .colorForHeight(h, seaLevel) -> [r,g,b] (0..1)
//   .references, .presets, .keywords -> data tables
//   .systemPrompt, .auditPrompt -> string defaults
//   .providers -> the PROVIDERS map (call providers.anthropic.call(...))
//   .getAiSettings() -> live { provider, model, anthropicKey } from editor
// All references are LIVE handles -- editing the editor reflects here
// on next call. The tester treats prompts as DRAFT TEXT (editable in
// the UI) starting from the systemPrompt / auditPrompt defaults.
window.__PMAP = {
  buildCells: _buildFibonacciCells,
  buildHash: _buildCellSpatialHash,
  buildNeighbors: _buildCellNeighbors,
  applyPlan: _applyAIPlan,
  stampGeoJSON: _planetStampGeoJSON,
  stampAzgaarJSON: _planetStampAzgaarJSON,
  stampLandmass: _planetStampLandmass,
  measureLandmass: _planetMeasureLandmass,
  colorForHeight: _planetColorForHeight,
};

// Sprint 8.0.3-a -- TerrainCollider scripting / harness surface.
// heightAt(wx, wz)        -- world Y at flat-XZ point; auto-source
// radialAt(dx, dy, dz)    -- planet surface radius along direction
//                            (planet sources only)
// Foliage / character controllers / future Rapier physics bridge
// consume these; 10-5d ground scatter is the first user.
window.__COLLIDER = {
  heightAt: function (wx, wz) { return _terrainColliderHeightAt(wx, wz); },
  radialAt: function (dx, dy, dz) { return _terrainColliderRadialAt(dx, dy, dz); }
};

