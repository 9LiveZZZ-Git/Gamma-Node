/* User-facing entry point — wraps iterative AI calibration into one
 * flow. Calls runAICalibrationIterative (Phase 6.6.20.13 v2) which
 * runs N=5 passes capped at ±0.5°/pass each, then shows a diff
 * modal of the cumulative baseline → current changes so the user
 * can review + revert any drift they don't like. */
async function runAICalibrationFlow(opts) {
  const statusCb = opts && opts.onStatus;
  const skipBezier = !!(opts && opts.skipBezier);
  try {
    if (statusCb) statusCb("Phase 1 — pose+FOV+keystone calibration starting...");
    // PHASE 1 — main pose+FOV+keystone iterative.
    const phase1 = await runAICalibrationIterative({
      mode:             "main",
      maxIterations:    5,
      maxDeltaPerPass:  0.5,
      stopThreshold:    0.15,
      onStatus: (msg) => { if (statusCb) statusCb(msg); }
    });

    // PHASE 2 — Bezier interior fine-tune (AI v4). Runs after main
    // phase converges, on the now-refined rig. Smaller iteration
    // budget (3 passes) since Bezier adjustments converge faster
    // — typically 1-2 passes catch most residual mesh issues.
    let phase2 = null;
    if (!skipBezier) {
      if (statusCb) statusCb("Phase 2 — Bezier interior fine-tune starting...");
      phase2 = await runAICalibrationIterative({
        mode:             "bezier",
        maxIterations:    3,
        bezierMaxDeltaPerPass: 0.015,
        stopThreshold:    0.001,
        onStatus: (msg) => { if (statusCb) statusCb(msg); }
      });
    }

    // Combine phase 1 + phase 2 cumulative diffs. Both phases'
    // baselines were captured at THEIR start; phase 2's baseline
    // is the post-phase-1 state, so its diff represents only the
    // Bezier work. Total diff = phase1.finalDiff + phase2.bezierDiff.
    const result = {
      iterations: phase1.iterations + (phase2 ? phase2.iterations : 0),
      totalCorrections: phase1.totalCorrections + (phase2 ? phase2.totalCorrections : 0),
      finalDiff: phase1.finalDiff.map(d1 => {
        // Find the matching phase2 entry for this display.
        const d2 = phase2 ? phase2.finalDiff.find(x => x.idx === d1.idx) : null;
        if (!d2) return d1;
        return Object.assign({}, d1, {
          // Carry phase 2's bezierDiff onto the merged record.
          bezierDiff: d2.bezierDiff,
          reasoning: "Phase 1: pose+FOV+keystone over " + phase1.iterations + " pass(es). Phase 2: Bezier over " + phase2.iterations + " pass(es)."
        });
      }),
      lastResult: (phase2 && phase2.lastResult) || phase1.lastResult,
      lastMeta:   (phase2 && phase2.lastMeta)   || phase1.lastMeta,
      phase1, phase2
    };

    // 6.6.20.14 — better UX for the three "nothing happened" cases.
    // 6.6.20.16 — also count keystone corner deltas (NDC) toward
    // hasChanges, since AI v3 may propose only keystone with no pose.
    const cumDelta = result.finalDiff.reduce((s, c) => {
      let m = Math.abs(c.deltaYaw) + Math.abs(c.deltaPitch) +
              Math.abs(c.deltaFovH) + Math.abs(c.deltaFovV);
      if (c.keystone) {
        const k = c.keystone;
        m += (Math.abs(k.tlx) + Math.abs(k.tly) + Math.abs(k.trx) + Math.abs(k.try_) +
              Math.abs(k.blx) + Math.abs(k.bly) + Math.abs(k.brx) + Math.abs(k.bry)) * 100;
      }
      if (c.bezierDiff && c.bezierDiff.totalAbs > 0) {
        m += c.bezierDiff.totalAbs * 100;
      }
      return s + m;
    }, 0);
    const hasChanges = cumDelta > 0.005;

    // Pull last iteration's per-display errors for diagnostics.
    const lastCorrections = (result.lastResult && Array.isArray(result.lastResult.corrections))
      ? result.lastResult.corrections : [];
    const errored = lastCorrections.filter(c => c.error);
    const allErrored = lastCorrections.length > 0 &&
                       errored.length === lastCorrections.length;

    if (allErrored) {
      const sample = errored.slice(0, 3)
        .map(e => "  • Display " + e.idx + " (" + (e.displayName || e.displayId) + "): " + e.error)
        .join("\n");
      const more = errored.length > 3 ? "\n  ... and " + (errored.length - 3) + " more" : "";
      const msg = "AI calibration: every API call failed (" + errored.length + " of " +
                  lastCorrections.length + ").\n\nFirst few errors:\n" + sample + more +
                  "\n\nLikely fix: open the User DSP tab, click the ⚙ button next to the model badge, " +
                  "and check your provider + API key. For Anthropic the key starts with sk-ant-.";
      if (statusCb) statusCb("All " + errored.length + " AI calls failed");
      alert(msg);
      return { applied: 0, skipped: 0, iterations: result.iterations, errors: errored.length };
    }

    if (!hasChanges) {
      // 6.6.20.15 — be honest about scope. AI v2 only does pose+FOV;
      // it doesn't edit warp meshes or Bezier patches. Most visible
      // boundary artifacts (ghosting, X-shapes, blurring) are mesh-
      // related, not pose-related, so the AI returning "0 deltas"
      // doesn't mean the rig looks perfect — it means there's
      // nothing AI v2 can fix. Surface the AI's REASONING per
      // display so user sees what the model actually saw.
      const erroredCount = errored.length;
      const reasoningSamples = lastCorrections
        .filter(c => !c.error && c.reasoning)
        .slice(0, 3)
        .map(c => "  • Display " + c.idx + " (" + (c.displayName || c.displayId) + "): " + c.reasoning);
      const reasonBlock = reasoningSamples.length
        ? "\n\nWhat the AI reported seeing (sample):\n" + reasoningSamples.join("\n")
        : "";
      const errorBlock = erroredCount > 0
        ? "\n\n" + erroredCount + " API call(s) errored:\n  " +
          errored.slice(0, 2).map(e => "Display " + e.idx + ": " + e.error).join("\n  ")
        : "";
      const msg =
        "AI v2 (pose+FOV only) proposed no significant pose/FOV changes after " +
        result.iterations + " iteration" + (result.iterations === 1 ? "" : "s") + ".\n\n" +
        "What this means:\n" +
        "  1. Projector POSES are likely already correctly placed.\n" +
        "  2. Visible artifacts you still see (ghosting on great circles, X-shapes at corners, " +
        "blurry projector boundaries) are MESH-related, not pose-related — beyond AI v2's scope.\n\n" +
        "Three things to try if artifacts remain:\n" +
        "  a) Re-run Auto-warp + Auto-blend (hard cuts). Defaults bumped to 128×128 mesh in " +
        "v0.1.83 (was 8×8 before v0.1.81), which is the proper fix for sub-pixel boundary " +
        "disagreement. The auto-prep step does this for you each AI pass.\n" +
        "  b) Hand-edit the warp on a problem display: open the warp editor, switch to Bezier " +
        "mode, adjust corner control points. AI v2 does NOT edit warp meshes — that's manual.\n" +
        "  c) If you've stacked multiple AI calibration runs, undo (Ctrl+Z) the older ones — " +
        "accumulated per-projector drift from previous passes can outlast convergence." +
        reasonBlock + errorBlock;
      if (statusCb) statusCb("AI v2 done — see dialog for next steps");
      alert(msg);
      return { applied: 0, skipped: 0, iterations: result.iterations, errors: erroredCount };
    }

    if (statusCb) statusCb("Showing cumulative diff (" + result.iterations + " iterations)...");

    // Has changes — show diff modal. Unchecked rows get reverted.
    const beforeRevert = result.finalDiff.slice();
    // 6.6.20.18 — pass the full result so the modal can build a
    // diagnostic report (phase1/phase2 reasoning + cumulative
    // diffs) on demand. The modal still uses .corrections for the
    // diff rows; the rest is for the Export button.
    const approved = await showAICalibrationModal({
      corrections:      result.finalDiff,
      finalDiff:        result.finalDiff,
      phase1:           result.phase1,
      phase2:           result.phase2,
      iterations:       result.iterations,
      totalCorrections: result.totalCorrections
    });
    const keepIds = new Set(approved.map(c => c.idx));
    let reverted = 0;
    for (const c of beforeRevert) {
      if (keepIds.has(c.idx)) continue;
      const display = state.rig.displays[c.idx];
      if (!display) continue;
      if (display.pose) {
        display.pose.yaw   = (display.pose.yaw   || 0) - (c.deltaYaw   || 0);
        display.pose.pitch = (display.pose.pitch || 0) - (c.deltaPitch || 0);
      }
      if (display.fov) {
        display.fov.h = Math.max(5, (display.fov.h || 90) - (c.deltaFovH || 0));
        display.fov.v = Math.max(5, (display.fov.v || 60) - (c.deltaFovV || 0));
      }
      // 6.6.20.16 — revert keystone deltas if present.
      if (c.keystone) {
        if (!display.keystoneCorners) {
          display.keystoneCorners = { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 };
        }
        const k = display.keystoneCorners;
        k.tlx  -= (c.keystone.tlx  || 0);
        k.tly  -= (c.keystone.tly  || 0);
        k.trx  -= (c.keystone.trx  || 0);
        k.try_ -= (c.keystone.try_ || 0);
        k.blx  -= (c.keystone.blx  || 0);
        k.bly  -= (c.keystone.bly  || 0);
        k.brx  -= (c.keystone.brx  || 0);
        k.bry  -= (c.keystone.bry  || 0);
      }
      // 6.6.20.17 — revert Bezier per-point deltas. bezierDiff.perPoint
      // has each {idx, dx, dy} that changed; subtract them from the
      // display's bezierCorrections.ctrl array.
      if (c.bezierDiff && Array.isArray(c.bezierDiff.perPoint) &&
          c.bezierDiff.perPoint.length > 0 && display.bezierCorrections &&
          Array.isArray(display.bezierCorrections.ctrl)) {
        for (const pt of c.bezierDiff.perPoint) {
          const k = pt.idx * 2;
          display.bezierCorrections.ctrl[k + 0] = (display.bezierCorrections.ctrl[k + 0] || 0) - pt.dx;
          display.bezierCorrections.ctrl[k + 1] = (display.bezierCorrections.ctrl[k + 1] || 0) - pt.dy;
        }
      }
      if (Visual && Visual._warpCache) Visual._warpCache.delete(display.id);
      reverted++;
    }
    if (reverted > 0) {
      pushHistory("ai-calibration-revert");
      renderProps && renderProps();
      render();
    }
    const kept = beforeRevert.length - reverted;
    // 6.6.20.19 — bake AI corrections into the visible warp meshes
    // so the user sees the result when they open the warp editor on
    // any display. The AI corrections live in display.keystoneCorners
    // + display.bezierCorrections (separate fields), and only get
    // applied when auto-warp / auto-blend regenerates the mesh. This
    // forces that regeneration NOW so the on-screen state matches
    // what the AI corrected. Custom (hand-edited) meshes are still
    // skipped per the existing _isCustom check.
    if (kept > 0 && state.rig && state.rig.surfaceVisible) {
      // 6.6.20.22 — bake corrections by re-running Auto-blend ONLY
      // (NOT Auto-warp; see autoPrep comment). Auto-blend at this
      // density preserves keystone+Bezier corrections via the
      // _applyKeystoneCornersToMesh + _applyBezierCorrectionsToMesh
      // helpers it calls internally. Auto-warp would double-warp.
      try {
        _applyAutoBlendToRig({ skipHistory: true, hardCuts: true });
      } catch (_) {}
      if (Visual && Visual._warpCache) {
        // Force every display's warp cache to rebuild on next frame.
        if (typeof Visual._warpCache.clear === "function") Visual._warpCache.clear();
      }
      render();
    }
    if (statusCb) statusCb("Done — " + kept + " kept, " + reverted + " reverted (" + result.iterations + " iter)");
    return { applied: kept, skipped: reverted, iterations: result.iterations };
  } catch (e) {
    if (statusCb) statusCb("Error: " + (e && e.message ? e.message : String(e)));
    throw e;
  }
}

