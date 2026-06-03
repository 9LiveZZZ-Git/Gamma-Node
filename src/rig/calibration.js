/* ------------ Phase 6.6.20.8 — Auto-capture calibration ---------------- *
 *
 * Walks through the theater preview from the rig's sweet-spot in 6
 * cardinal directions (front/back/left/right/up/down), optionally
 * cycling Checkerboard.mode 0..4 between snapshots, and packages the
 * resulting PNGs into a downloadable ZIP bundle along with a JSON
 * metadata file describing the rig + capture parameters.
 *
 * Use case: visually verify projector calibration. Pair with the
 * WireframeCalibration shader-frag (6.6.20.7) — wireframe lines
 * should connect smoothly across projector boundaries; any
 * shift/break diagnoses bad calibration. The capture ZIP also
 * documents the rig state at calibration time, ready to feed to
 * Claude API / Gemma 4 vision in a future phase for automatic
 * misalignment scoring + auto-correction of pose/FOV/warp params. */

/* Helper — wait for N rAF ticks. Lets us settle WebGPU pipeline
 * before reading back the canvas via toBlob (which the browser
 * gates on GPU work completion, but we still need at least one
 * frame to commit the new uniforms). */
function _waitForFrames(n) {
  return new Promise(resolve => {
    let count = 0;
    const tick = () => {
      count++;
      if (count >= n) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* 6.6.20.9 — coverage check. Returns true if a viewing direction
 * (yawDeg, pitchDeg) from the rig origin would actually hit the
 * screen surface. Used to prune capture directions for partial
 * surfaces (e.g. AlloSphere yaw [-80, 80] doesn't cover yaw=180°
 * "back" — capturing back yields useless garbage from off-axis
 * projectors). */
function _directionInCoverage(yawDeg, pitchDeg, surface) {
  if (!surface || surface.type === "free")  return true;
  if (surface.type === "plane")             return true;
  if (surface.type === "sphere")            return true;
  if (surface.type === "cylinder") {
    const halfL = (surface.length || 5) * 0.5;
    const R = surface.radius || 5;
    const maxPitchDeg = Math.atan(halfL / R) * 180 / Math.PI;
    return Math.abs(pitchDeg) <= maxPitchDeg + 5;
  }
  if (surface.type === "swept") {
    const path = surface.path || { yawStart: -180, yawEnd: 180 };
    const profile = surface.profile || { kind: "arc", pitchStart: -90, pitchEnd: 90 };
    const yawStart = path.yawStart != null ? path.yawStart : -180;
    const yawEnd   = path.yawEnd   != null ? path.yawEnd   :  180;
    // Wrap yaw into the path range
    let yaw = yawDeg;
    while (yaw > yawEnd + 180) yaw -= 360;
    while (yaw < yawStart - 180) yaw += 360;
    if (yaw < yawStart - 1 || yaw > yawEnd + 1) return false;
    if (profile.kind === "arc") {
      const pStart = profile.pitchStart != null ? profile.pitchStart : -90;
      const pEnd   = profile.pitchEnd   != null ? profile.pitchEnd   :  90;
      return pitchDeg >= pStart - 1 && pitchDeg <= pEnd + 1;
    }
    if (profile.kind === "vertical") {
      const R = profile.radius || 5;
      const yMin = profile.yMin != null ? profile.yMin : -2.5;
      const yMax = profile.yMax != null ? profile.yMax :  2.5;
      // y on the cylinder at this pitch from origin
      const cosP = Math.cos(pitchDeg * Math.PI / 180);
      if (Math.abs(cosP) < 1e-6) {
        // Looking straight up/down — nominally outside vertical-profile range
        return false;
      }
      const y = R * Math.tan(pitchDeg * Math.PI / 180);
      return y >= yMin - 0.1 && y <= yMax + 0.1;
    }
  }
  return true;
}

async function autoCaptureCalibration(opts) {
  if (!Visual || !Visual.canvas) {
    throw new Error("Visual canvas not initialized");
  }
  if (!Visual.theaterCam) {
    throw new Error("Theater camera not initialized");
  }
  if (!state.rig || !Array.isArray(state.rig.displays)) {
    throw new Error("Rig not configured");
  }
  const onProgress    = (opts && opts.onProgress) || null;
  // 6.6.20.9 defaults — all three improvements ON unless explicitly
  // disabled via opts. User can override per-call from a future UI.
  const autoPrep      = !(opts && opts.autoPrep      === false);  // apply Auto-warp + hard-cut blend before capture
  const coverageAware = !(opts && opts.coverageAware === false);  // skip directions outside surface coverage
  const perDisplay    = !(opts && opts.perDisplay    === false);  // also capture aimed at each display's pose
  // 6.6.20.20 — also capture BOUNDARY views between adjacent
  // projector pairs. Each pair's mid-direction shows the seam
  // mid-frame so the AI can verify whether wireframe lines
  // connect cleanly across the boundary. Default ON.
  const boundaryPairs = !(opts && opts.boundaryPairs === false);
  // 6.6.20.20 — also capture POLE shots (forced inside surface
  // coverage at ±80° pitch). Reveals polar projector convergence
  // issues that the cardinal up/down (89.4°) miss because they're
  // outside coverage. Default ON.
  const polarShots    = !(opts && opts.polarShots    === false);

  // Snapshot state so finally{} can put everything back exactly.
  const prevPreviewMode = state.rig.previewMode;
  const prevCam = {
    pos:   Visual.theaterCam.pos.slice(),
    yaw:   Visual.theaterCam.yaw,
    pitch: Visual.theaterCam.pitch,
    fov:   Visual.theaterCam.fov   // 6.6.20.19 — also save FOV for wider AI captures
  };
  // 6.6.20.20 — detect what shaders are in the patch. AI calibration
  // expects WireframeCalibration to be wired to the VOs (it's the
  // shader whose output the AI prompts describe — red equator,
  // RGB great circles, beacon circles etc.). When called from the
  // AI flow (opts.aiMode), we SKIP Checkerboard mode-cycling
  // entirely; cycling 5 modes mid-loop confuses the AI's frame-to-
  // frame comparison and the captures become inconsistent.
  const aiMode = !!(opts && opts.aiMode);
  const wireframeNodes = (state.nodes || []).filter(n => n.type === "WireframeCalibration");
  const checkerNodes   = (state.nodes || []).filter(n => n.type === "Checkerboard");
  const prevCheckerModes = checkerNodes.map(n => (n.params && n.params.mode));
  // If autoPrep mutates warp meshes, save them too so capture is
  // side-effect-free. (User runs Auto-warp / Auto-blend manually if
  // they want to keep the prep result.)
  let prevWarpMeshes = null;
  if (autoPrep) {
    prevWarpMeshes = state.rig.displays.map(d =>
      (d && d.warpMesh) ? _cloneWarpMesh(d.warpMesh) : null
    );
  }

  const restoreState = () => {
    state.rig.previewMode = prevPreviewMode;
    Visual.theaterCam.pos[0] = prevCam.pos[0];
    Visual.theaterCam.pos[1] = prevCam.pos[1];
    Visual.theaterCam.pos[2] = prevCam.pos[2];
    Visual.theaterCam.yaw   = prevCam.yaw;
    Visual.theaterCam.pitch = prevCam.pitch;
    Visual.theaterCam.fov   = prevCam.fov;       // 6.6.20.19 — restore FOV
    checkerNodes.forEach((n, i) => {
      if (n.params && prevCheckerModes[i] !== undefined) {
        n.params.mode = prevCheckerModes[i];
      }
    });
    if (prevWarpMeshes) {
      state.rig.displays.forEach((d, i) => {
        if (!d) return;
        d.warpMesh = prevWarpMeshes[i];
        if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      });
    }
    if (typeof _updateProjectionPill === "function") _updateProjectionPill();
    render();
  };

  // Track which prep operations actually ran (for the meta JSON).
  const prepApplied = { autoWarp: false, autoBlend: false };

  try {
    // PHASE 1 — Auto-prep. Phase 6.6.20.22: SKIP auto-warp here.
    // Auto-warp was originally designed for the OLD flat-quad
    // theater rendering — it pre-distorts source UVs so flat
    // projector tiles look audience-correct on a curved screen.
    // But theater since 6.6.20.1 places mesh vertices on the
    // actual sphere via raycasting, which already handles
    // audience-correctness. Running auto-warp on top creates a
    // DOUBLE WARP (UV remapping + raycast displacement) that
    // shifts adjacent projectors' content out of alignment at
    // boundaries, producing the visible "thick stacked line"
    // artifacts the user reported.
    //
    // Auto-blend stays (its hard-cut alpha doesn't remap UVs,
    // just sets per-vertex intensity for projector overlap
    // assignment). Custom hand-edited warps still survive via
    // _isCustom skip.
    if (autoPrep) {
      try {
        const blendResults = _applyAutoBlendToRig({ skipHistory: true, hardCuts: true });
        prepApplied.autoBlend = !!(blendResults && blendResults.length > 0);
      } catch (_) { /* skip */ }
      // autoWarp deliberately omitted — see comment above.
      await _waitForFrames(3);
    }

    // PHASE 2 — switch to theater + sweet-spot.
    state.rig.previewMode = "theater";
    if (typeof _updateProjectionPill === "function") _updateProjectionPill();
    const ss = Array.isArray(state.rig.sweetSpot) ? state.rig.sweetSpot : [0, 0, 0];
    Visual.theaterCam.pos[0] = ss[0];
    Visual.theaterCam.pos[1] = ss[1];
    Visual.theaterCam.pos[2] = ss[2];
    // 6.6.20.19 — wider capture FOV (90° vertical, was 60°) so each
    // per-display photo shows the target projector + ~50% of the
    // adjacent neighbors' coverage at the frame edges. Without this,
    // the AI was only seeing one projector centered and couldn't
    // verify boundary alignment — Phase 2 reasoning was generic
    // ("slight edge bulge") because the boundary literally wasn't
    // in the frame. Wide FOV puts the boundary mid-frame where AI
    // can see both sides. Restored in finally{}.
    Visual.theaterCam.fov = 90;

    // PHASE 3 — build the direction list.
    //
    // Cardinal directions: 6 axis-aligned views from the sweet-spot.
    // Up/down stop just shy of the zenith / nadir (89.4°) to avoid
    // the theater view matrix's gimbal-lock numerical degeneracy.
    let directions = [
      { name: "front", yawDeg: 0,    pitchDeg:  0,    kind: "cardinal" },
      { name: "right", yawDeg: 90,   pitchDeg:  0,    kind: "cardinal" },
      { name: "back",  yawDeg: 180,  pitchDeg:  0,    kind: "cardinal" },
      { name: "left",  yawDeg: -90,  pitchDeg:  0,    kind: "cardinal" },
      { name: "up",    yawDeg: 0,    pitchDeg:  89.4, kind: "cardinal" },
      { name: "down",  yawDeg: 0,    pitchDeg: -89.4, kind: "cardinal" }
    ];

    // Coverage-aware filter — for partial surfaces (AlloSphere yaw
    // [-80,80] etc.) drop the cardinals that aim at empty space.
    if (coverageAware) {
      directions = directions.filter(d =>
        _directionInCoverage(d.yawDeg, d.pitchDeg, state.rig.surface)
      );
    }

    // Per-display centers — one capture per projector aimed at its
    // pose direction. Most diagnostic for finding which projector
    // is misaligned (the wireframe pattern in that capture should
    // be centered + the surrounding projectors' edges should
    // connect smoothly to the central one's edges).
    if (perDisplay && Array.isArray(state.rig.displays)) {
      const seenNames = new Set(directions.map(d => d.name));
      state.rig.displays.forEach((display, idx) => {
        if (!display) return;
        const pose = display.pose || { yaw: 0, pitch: 0 };
        const yawDeg   = pose.yaw   || 0;
        // Clamp pitch so we don't gimbal-lock at ±90.
        const pitchDeg = Math.max(-89.4, Math.min(89.4, pose.pitch || 0));
        if (coverageAware && !_directionInCoverage(yawDeg, pitchDeg, state.rig.surface)) return;
        const safeId   = String(display.id   || ("d" + idx)).replace(/[^a-zA-Z0-9_-]/g, "");
        const safeName = String(display.name || "").replace(/[^a-zA-Z0-9_-]/g, "");
        const idxStr   = String(idx).padStart(2, "0");
        const name = "display-" + idxStr + (safeId ? "-" + safeId : "") + (safeName ? "-" + safeName : "");
        if (seenNames.has(name)) return;
        seenNames.add(name);
        directions.push({ name, yawDeg, pitchDeg, kind: "per-display", displayIdx: idx });
      });
    }

    // 6.6.20.20 — BOUNDARY-PAIR captures. For each pair of
    // projectors whose coverage overlaps, aim camera at the midpoint
    // between their pose directions. This puts the SEAM between
    // them dead-center in the frame, so the AI can verify whether
    // wireframe lines actually connect across the boundary (which
    // it cannot do from a single-projector-centered capture).
    if (boundaryPairs && Array.isArray(state.rig.displays)) {
      const seenNames = new Set(directions.map(d => d.name));
      const displays = state.rig.displays;
      // Two projectors share a boundary if their pose-to-pose
      // angular distance is less than the sum of their half-FOVs.
      // Compute half-fov as max(fov.h, fov.v)/2 for a conservative
      // overlap test.
      const angDist = (poseA, poseB) => {
        // Unit vectors for each pose; angular distance = arccos(dot).
        const ya = (poseA.yaw || 0) * Math.PI / 180, pa = (poseA.pitch || 0) * Math.PI / 180;
        const yb = (poseB.yaw || 0) * Math.PI / 180, pb = (poseB.pitch || 0) * Math.PI / 180;
        const ax = Math.sin(ya) * Math.cos(pa), ay = Math.sin(pa), az = Math.cos(ya) * Math.cos(pa);
        const bx = Math.sin(yb) * Math.cos(pb), by = Math.sin(pb), bz = Math.cos(yb) * Math.cos(pb);
        const dot = Math.max(-1, Math.min(1, ax*bx + ay*by + az*bz));
        return Math.acos(dot) * 180 / Math.PI;
      };
      const midDirection = (poseA, poseB) => {
        // Slerp midpoint (unit-vector average + renormalize works
        // for non-antipodal pairs, which all rig pairs are).
        const ya = (poseA.yaw || 0) * Math.PI / 180, pa = (poseA.pitch || 0) * Math.PI / 180;
        const yb = (poseB.yaw || 0) * Math.PI / 180, pb = (poseB.pitch || 0) * Math.PI / 180;
        const ax = Math.sin(ya) * Math.cos(pa), ay = Math.sin(pa), az = Math.cos(ya) * Math.cos(pa);
        const bx = Math.sin(yb) * Math.cos(pb), by = Math.sin(pb), bz = Math.cos(yb) * Math.cos(pb);
        const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
        const len = Math.hypot(mx, my, mz);
        if (len < 1e-6) return null;     // antipodal, can't midpoint
        const nx = mx / len, ny = my / len, nz = mz / len;
        return {
          yawDeg:   Math.atan2(nx, nz) * 180 / Math.PI,
          pitchDeg: Math.asin(Math.max(-1, Math.min(1, ny))) * 180 / Math.PI
        };
      };
      let added = 0;
      const MAX_BOUNDARY_PAIRS = 60;       // cap so 26-display rigs don't explode
      for (let i = 0; i < displays.length && added < MAX_BOUNDARY_PAIRS; i++) {
        const dA = displays[i];
        if (!dA || !dA.pose || !dA.fov) continue;
        const halfA = Math.max(dA.fov.h || 90, dA.fov.v || 60) * 0.5;
        for (let j = i + 1; j < displays.length && added < MAX_BOUNDARY_PAIRS; j++) {
          const dB = displays[j];
          if (!dB || !dB.pose || !dB.fov) continue;
          const halfB = Math.max(dB.fov.h || 90, dB.fov.v || 60) * 0.5;
          const dist = angDist(dA.pose, dB.pose);
          // Adjacent if angular distance < sum of half-FOVs (overlap)
          // AND > some minimum (not the same projector twice).
          if (dist > halfA + halfB || dist < 5) continue;
          const mid = midDirection(dA.pose, dB.pose);
          if (!mid) continue;
          // Clamp pitch to avoid gimbal-lock.
          const pitchDeg = Math.max(-89.4, Math.min(89.4, mid.pitchDeg));
          if (coverageAware && !_directionInCoverage(mid.yawDeg, pitchDeg, state.rig.surface)) continue;
          const idxA = String(i).padStart(2, "0");
          const idxB = String(j).padStart(2, "0");
          const name = "boundary-" + idxA + "-" + idxB;
          if (seenNames.has(name)) continue;
          seenNames.add(name);
          directions.push({
            name,
            yawDeg: mid.yawDeg,
            pitchDeg,
            kind: "boundary",
            displayPair: [i, j]
          });
          added++;
        }
      }
    }

    // 6.6.20.20 — POLE shots forced (within coverage). Cardinals
    // up/down (±89.4°) get filtered out for partial-pitch surfaces,
    // but projector convergence near the poles is exactly where
    // calibration usually fails. Capture at ±80° pitch which sits
    // INSIDE the AlloSphere preset's ±85° range — same direction
    // intent (looking near a pole) but inside coverage.
    if (polarShots) {
      const seenNames = new Set(directions.map(d => d.name));
      const polePitches = [80, -80];
      for (const pitchDeg of polePitches) {
        if (coverageAware && !_directionInCoverage(0, pitchDeg, state.rig.surface)) continue;
        const name = pitchDeg > 0 ? "near-zenith" : "near-nadir";
        if (seenNames.has(name)) continue;
        directions.push({ name, yawDeg: 0, pitchDeg, kind: "pole" });
      }
    }

    // PHASE 4 — build configs (Checkerboard mode cycle if wired).
    // 6.6.20.20 — in AI mode, suppress mode cycling. The AI flow
    // wants stable WireframeCalibration captures; cycling
    // Checkerboard modes mid-loop produces 5× as many captures
    // and the AI compares mode-0 vs mode-1 vs ... visuals as if
    // they were calibration changes. Stability beats variety here.
    const configs = [];
    if (!aiMode && checkerNodes.length > 0) {
      const modeLabels = ["healpix", "lambert", "cube", "octahedral", "lat-long"];
      for (let mode = 0; mode <= 4; mode++) {
        configs.push({
          label: "checker-" + modeLabels[mode] + "-m" + mode,
          apply: () => checkerNodes.forEach(n => {
            if (n.params) n.params.mode = mode;
          })
        });
      }
    } else {
      configs.push({ label: "current", apply: () => {} });
    }

    const total = directions.length * configs.length;
    let captured = 0;
    const captures = [];

    // PHASE 5 — capture loop.
    for (const cfg of configs) {
      cfg.apply();
      for (const dir of directions) {
        Visual.theaterCam.yaw   = dir.yawDeg   * Math.PI / 180;
        Visual.theaterCam.pitch = dir.pitchDeg * Math.PI / 180;
        // 6.6.20.20 — render twice (once to update the visual
        // pipeline's theater camera matrix from the new yaw/pitch,
        // once to actually draw with the new matrix in place) and
        // wait 6 frames so WebGPU's command queue + canvas
        // composition settles. The previous 3-frame wait was
        // enough for static rigs but missed transient rendering
        // states when the camera angle changed mid-loop.
        render();
        await _waitForFrames(2);
        render();
        await _waitForFrames(6);
        const blob = await new Promise((resolve, reject) => {
          Visual.canvas.toBlob((b) => {
            if (b) resolve(b);
            else  reject(new Error("canvas.toBlob returned null"));
          }, "image/png");
        });
        captures.push({ filename: cfg.label + "_" + dir.name + ".png", blob });
        captured++;
        if (onProgress) onProgress(captured, total);
      }
    }

    // Build ZIP via the existing pure-JS ZIP encoder (also used by
    // MPCDI export). Each entry is a Uint8Array.
    const files = {};
    for (const c of captures) {
      const buf = await c.blob.arrayBuffer();
      files[c.filename] = new Uint8Array(buf);
    }

    // Metadata JSON. Useful for documentation and for a future
    // Claude/Gemma vision pipeline that scores misalignment.
    const meta = {
      app: "Gamma Node",
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      captureOptions: {
        autoPrep,
        coverageAware,
        perDisplay,
        prepApplied
      },
      rig: {
        templateKey: state.rig.templateKey,
        surface:     state.rig.surface,
        surfaceVisible: state.rig.surfaceVisible !== false,
        sweetSpot:   ss.slice(),
        displayCount: state.rig.displays.length,
        previewMode: prevPreviewMode,
        shaderCenterYaw:   state.rig.shaderCenterYaw   || 0,
        shaderCenterPitch: state.rig.shaderCenterPitch || 0
      },
      directions: directions.map(d => ({
        name:     d.name,
        kind:     d.kind || "cardinal",
        yawDeg:   d.yawDeg,
        pitchDeg: d.pitchDeg,
        displayIdx: d.displayIdx
      })),
      captureConfigs: configs.map(c => c.label),
      checkerNodeCount: checkerNodes.length,
      // Per-display poses + FOVs so a future analyzer can correlate
      // visible misalignments with the rig's parameters.
      displays: state.rig.displays.map((d, i) => d ? {
        idx: i,
        id:  d.id,
        name: d.name,
        pose: d.pose || { yaw: 0, pitch: 0, roll: 0 },
        fov:  d.fov  || { h: 90, v: 60 },
        worldUv: d.worldUv,
        edgeBlend: d.edgeBlend,
        warpKind: !d.warpMesh ? "none"
                  : d.warpMesh._isTest      ? "test"
                  : d.warpMesh._isHardCuts  ? "auto-blend-hardcuts"
                  : d.warpMesh._isAutoBlend ? "auto-blend"
                  : d.warpMesh._isCustom    ? "custom"
                  : d.warpMesh._bezier      ? "bezier"
                  : "identity"
      } : null)
    };
    files["calibration-meta.json"] = new TextEncoder().encode(
      JSON.stringify(meta, null, 2)
    );
    // README so users know what they're looking at.
    const cardinalDirs   = meta.directions.filter(d => d.kind === "cardinal");
    const perDisplayDirs = meta.directions.filter(d => d.kind === "per-display");
    files["README.md"] = new TextEncoder().encode(
`# Gamma Node — auto-capture calibration bundle

Generated ${meta.timestamp} by Gamma Node v${APP_VERSION}.

## Capture options

- **Auto-prep:** ${autoPrep ? "ON" : "OFF"} — ${autoPrep ? "Auto-warp + hard-cut Auto-blend applied before capture (warp:" + (prepApplied.autoWarp ? " applied" : " skipped") + ", blend:" + (prepApplied.autoBlend ? " applied" : " skipped") + "). Restored to user's previous warp meshes after capture." : "Skipped — capture used whatever warp/blend state was already in place."}
- **Coverage-aware:** ${coverageAware ? "ON" : "OFF"} — ${coverageAware ? "Cardinal directions outside the surface's coverage range were skipped." : "All 6 cardinal directions captured regardless of coverage."}
- **Per-display:** ${perDisplay ? "ON" : "OFF"} — ${perDisplay ? "Captured one frame per projector aimed at that projector's pose direction (most diagnostic for finding which projector is misaligned)." : "Skipped per-display captures."}

## Files

- \`*_<direction>.png\` — theater-view screenshots. Two kinds:
  - \`*_front\` / \`*_right\` / \`*_back\` / \`*_left\` / \`*_up\` / \`*_down\` — cardinal axes
  - \`*_display-NN-<id>-<name>\` — one per projector, aimed at that projector's pose
- \`calibration-meta.json\` — full rig configuration at capture
  time (surface, displays, poses, warp kinds, capture options).

## Directions captured (${meta.directions.length})

### Cardinal (${cardinalDirs.length}/6)
${cardinalDirs.length ? cardinalDirs.map(d => "- **" + d.name + "** — yaw " + d.yawDeg.toFixed(1) + "°, pitch " + d.pitchDeg.toFixed(1) + "°").join("\n") : "_(none — coverage-aware filter excluded all cardinals)_"}

### Per-display (${perDisplayDirs.length})
${perDisplayDirs.length ? perDisplayDirs.map(d => "- **" + d.name + "** — yaw " + d.yawDeg.toFixed(1) + "°, pitch " + d.pitchDeg.toFixed(1) + "°").join("\n") : "_(per-display disabled or no displays in coverage)_"}

## Capture configurations (${configs.length})

${configs.map(c => "- " + c.label).join("\n")}

## How to read

For each capture, calibration verification guidelines:

- **Lines should connect across projector boundaries.** A clean
  edge means good calibration; shift/break means a projector's
  pose, FOV, or warp is off.
- **Beacon circles should center on cardinal axes** (red on +X,
  green on +Y, blue on +Z if WireframeCalibration is the source).
- **In per-display captures**, the targeted projector's coverage
  should be centered in the frame. Mismatches: rotation = pose
  yaw/pitch off; size = FOV off; barrel/pincushion = warp off.
- **Cell parity should alternate evenly** if Checkerboard is the
  source.

## Auto-analysis

A future Gamma Node release will feed this bundle (PNGs + meta JSON)
to a Claude API or Gemma 4 vision endpoint for automatic misalignment
scoring + per-display correction proposals (Δyaw, Δpitch, Δfov, warp
adjustments). The bundle format is designed to be self-contained for
this.
`
    );

    let filename = null;
    if (!(opts && opts.skipDownload)) {
      const zip = _writeZipArchive(files);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      filename = "gamma-calibration-" + ts + ".zip";
      _downloadBlob(new Blob([zip], { type: "application/zip" }), filename);
      console.log("[auto-capture] saved", filename, "(" + captures.length + " PNGs)");
    }
    return { captured, total, filename, captures, meta, files };
  } finally {
    restoreState();
  }
}

/* ------------ Phase 6.6.20.10 — AI calibration analysis -------------- *
 *
 * Closes the calibration loop: captures the rig (using
 * autoCaptureCalibration above with skipDownload), sends each
 * per-display PNG to the active AI provider (Claude API or Gemma 4
 * via transformers.js) along with the projector's expected pose +
 * FOV, parses the response into proposed corrections, and shows
 * a diff modal where the user picks which corrections to apply.
 *
 * Reuses the existing PROVIDERS infrastructure (binding 0 in the
 * existing AI panel for User DSP). API keys + model selection live
 * in the same gamma-editor-ai-settings-v1 localStorage slot.
 *
 * For 26-projector AlloSphere, this is 26 sequential vision API
 * calls — slow (~1-2 min total) but cheap and reliable. Batching
 * 26 images in one call hits message-size limits.
 */

function _arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  // Chunked to avoid stack overflow on large buffers.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

const _AI_CALIBRATION_SYSTEM_PROMPT =
`You are a multi-projector dome calibration expert. You analyze screenshots from a virtual multi-projector rig with a 3D wireframe calibration pattern (lat/long sphere grid + 3 axis-colored great circles + 3 cardinal-axis beacon circles).

Each capture is a WIDE-FOV (90° vertical) view from the rig's audience sweet-spot, AIMED at one projector's pose direction. The TARGET projector fills the central ~50% of the frame; ADJACENT projectors' coverage is visible at the EDGES of the frame. This lets you compare boundaries — your job is largely to check that the wireframe lines on this projector's edges connect cleanly to the neighbor projectors' edges visible alongside.

The wireframe pattern is rendered globally in world space; if pose / FOV / warp are perfectly calibrated, the lat/long lines should connect with no shift, the great circles should be unbroken curves, and the beacons should appear at consistent angles. Visible disconnects at projector boundaries are exactly what calibration is meant to fix.

Calibration cues:
- The CENTER of the frame should be where the projector aims. If the visible pattern's "center of mass" is offset from the screen center, that suggests a yaw / pitch error in the projector's pose.
- The 3 colored great circles (red=XZ/equator, green=XY, blue=YZ) should be straight curved lines, not broken or doubled. Breaks reveal pose mismatches with neighbors.
- The 3 beacons (red=+X, green=+Y, blue=+Z) appear in only one direction; their angular position relative to the frame center can be cross-checked against the projector's expected pose.
- Lat/long grid line spacing should look uniform; sudden jumps reveal warp mesh or FOV errors.

For each capture, output JSON ONLY (no prose, no code fences) with these fields:
{
  "deltaYawDeg":   <degrees, + = projector should rotate to its right>,
  "deltaPitchDeg": <degrees, + = projector should tilt up>,
  "deltaFovHDeg":  <degrees, + = wider horizontal FOV>,
  "deltaFovVDeg":  <degrees, + = wider vertical FOV>,
  "keystone": {
    "tlx": <NDC dx for top-left corner>,
    "tly": <NDC dy>,
    "trx": <NDC dx for top-right>,
    "try":  <NDC dy>,
    "blx": <NDC dx for bottom-left>,
    "bly": <NDC dy>,
    "brx": <NDC dx for bottom-right>,
    "bry": <NDC dy>
  },
  "confidence":    <0..1, your certainty in these corrections>,
  "reasoning":     "<one short sentence explaining what you saw>"
}

KEYSTONE CORNERS (AI v3): each corner of THIS projector's warp mesh
can shift by a small NDC offset (range ±2.0 covers the whole
framebuffer; ±0.02 is typical = ~1% of framebuffer = ~5 px at
1080p). Use keystone deltas to FIX MESH-LEVEL ALIGNMENT that pose
+ FOV alone can't:

  - If the wireframe lines on this projector's edge don't meet the
    next projector's edge cleanly (e.g., top edge lines are shifted
    right relative to the projector above), propose a small dx/dy
    shift for the top-left + top-right corners to align them.

  - If the projector's quad looks rotated relative to its
    neighbors (parallelogram / trapezoid), opposite corners need
    opposite shifts — e.g. tlx +0.005 and brx -0.005 rotates the
    quad slightly clockwise.

  - If pose+FOV deltas are 0 but you still see boundary artifacts,
    those are usually mesh-level — propose small keystone deltas.
    Don't propose pose to mask mesh issues.

Per-pass clamp: each keystone delta is clamped to ±0.02 NDC by the
iterative loop. So output realistic values in [-0.02, 0.02].

Use 0 for any axis you can't determine from this single view. Keep |delta| values SMALL and CONSERVATIVE — this calibration runs ITERATIVELY (multiple passes converging on the right answer), so single-pass deltas above ±0.5° will be clamped anyway. Better to suggest a small confident correction (±0.2°) and let the next pass refine, than overshoot in one pass and break neighbor agreement.

This is one projector in a 26-projector RING-based dome. Adjacent projectors in the SAME ring share the same nominal pitch. If you're tempted to suggest a big pitch correction (>1°), pause and ask "does this projector look more wrong than its neighbors would, or am I seeing the natural curvature of the wireframe pattern?" Default to small deltas.

SCOPE: this version of the calibration AI only proposes pose+FOV corrections — it does NOT edit warp meshes or Bezier patches. If you see visible artifacts that are NOT pose/FOV related (ghost-doubled great circles from warp-mesh interpolation drift, X-shapes at projector corners from quad-fragment aliasing, blurry boundaries from low-density warp meshes), output 0 deltas and explain in the reasoning field that "this artifact is mesh-related, not pose-related — user should bump WARP_MESH_DENSITY or hand-edit the warp mesh." Don't propose pose corrections to mask non-pose artifacts; that breaks neighbor agreement.

Even when proposing 0 deltas, the reasoning field should describe any visible artifacts you saw and explain why no pose correction is needed (calibration looks fine vs. artifacts are out of scope).`;

/* Phase 6.6.20.17 — AI v4 Bezier fine-tune system prompt.
 * Used for Phase 2 of the calibration flow, AFTER main pose/FOV/
 * keystone has converged. Asks the AI to identify residual mesh-
 * level alignment issues and propose specific Bezier control
 * point shifts to fix them. Sparse adjustments (max 6 per
 * display per pass) keep parameter space tractable. */
const _AI_BEZIER_FINETUNE_PROMPT =
`You are a multi-projector dome calibration expert. The rig has
already been globally aligned via pose + FOV + keystone-corner
adjustments. You are now doing FINE MESH-LEVEL TUNING of one
projector at a time, using Bezier control point shifts.

The wireframe pattern (grid + 3 colored great circles + 3 beacons)
is rendered in world space. The capture is a WIDE-FOV (90°
vertical) view aimed at this projector's pose direction. The
TARGET projector fills the central ~50% of the frame; ADJACENT
projectors' coverage is visible at the EDGES of the frame.

CRITICAL: be very conservative. Earlier passes of this calibration
flow turned out to propose hallucinated corrections that DEGRADED
the rig. Symptoms of hallucination: identical adjustments across
multiple displays, vague "slight edge bulges" reasoning, no
specific named feature in the image. Avoid these failure modes.

YOU MAY ONLY PROPOSE A NON-EMPTY bezierAdjustments LIST IF:

  1. You can describe in your reasoning a SPECIFIC boundary
     discontinuity by reference to a NAMED FEATURE in the image
     (e.g., "the red equator line breaks 4 px to the right at the
     boundary between this projector and its left neighbor").
  2. You see the SAME line on both projectors at the boundary,
     and they fail to meet.
  3. Your confidence is 0.7 or higher.

If any of those isn't true, output bezierAdjustments: [] and
confidence ≤ 0.6. The default rig is already well-calibrated;
"no changes needed" is the correct answer most of the time.

Indexing: 5 cols × 5 rows. col 0..4 = left → right.
row 0..4 = top → bottom. (0,0) = top-left, (4,4) = bottom-right.
Mid-edge points (col=2 row=0 = top-edge midpoint, col=4 row=2 =
right-edge midpoint, etc.) are the most useful for fixing edge
mismatches that corner adjustments alone can't reach. Interior
points (col 1..3, row 1..3) handle bulges in the middle of the
projected quad.

For each capture, output JSON ONLY:
{
  "bezierAdjustments": [
    {"col": 2, "row": 0, "dx": 0.005, "dy": 0},
    {"col": 0, "row": 2, "dx": 0,     "dy": 0.003},
    ... up to 6 adjustments total ...
  ],
  "confidence": <0..1>,
  "reasoning": "<one sentence>"
}

Each dx/dy is in NDC units. Per-pass clamp is ±0.015 NDC (~3-4 px
at 1080p). Output [] if you don't see any mesh-level issues to
fix. Don't propose corner adjustments here — those went through
the keystone phase already and should already be good.

Look for:
- Top edge of THIS projector's wireframe doesn't quite meet the
  bottom of the projector above → adjust top-row points (row=0).
- Mid-edge bulge: a horizontal grid line that bows inward/outward
  near one side → adjust the mid-edge control point.
- Interior wave: the wireframe within the projector is bowed in
  one place but flat elsewhere → propose a small interior point
  shift to compensate.

If everything looks aligned, output bezierAdjustments: [] and
confidence ≥ 0.7 with reasoning describing how good it looks.`;

async function analyzeCalibrationWithAI(opts) {
  const onProgress = (opts && opts.onProgress) || null;
  const onCapture  = (opts && opts.onCapture)  || null;
  // 6.6.20.17 — mode "main" (pose+FOV+keystone) or "bezier" (interior
  // control-point fine-tune). Different system prompt + different
  // parsing per mode; same per-display capture loop.
  const mode = (opts && opts.mode === "bezier") ? "bezier" : "main";
  const systemPrompt = mode === "bezier"
    ? _AI_BEZIER_FINETUNE_PROMPT
    : _AI_CALIBRATION_SYSTEM_PROMPT;

  // 6.6.20.20 — pre-flight: warn if no WireframeCalibration is
  // wired to a VisualOutput. The AI prompts describe a specific
  // wireframe pattern (red equator, RGB great circles, beacon
  // circles) — if the user has Checkerboard or some other shader
  // wired instead, captures show that content and the AI's
  // analysis is meaningless.
  const hasWireframe = (state.nodes || []).some(n => n.type === "WireframeCalibration");
  const wireframeWiredToVO = hasWireframe && (state.edges || []).some(e => {
    const from = (state.nodes || []).find(n => n.id === e.from.node);
    return from && from.type === "WireframeCalibration" && (state.edges || []).some(e2 =>
      e2.from.node === from.id && e2.to.port === "in" &&
      (state.nodes || []).find(n => n.id === e2.to.node && n.type === "VisualOutput")
    );
  });
  if (!hasWireframe || !wireframeWiredToVO) {
    const proceed = (typeof confirm === "function")
      ? confirm("AI calibration expects a WireframeCalibration node wired to your VisualOutputs (it's the visual target the AI prompts describe — red equator + RGB great circles + beacon circles).\n\nNone detected wired. The AI will still run, but the captures will show whatever you have wired to the VOs and the corrections may not match what the AI thinks it's seeing.\n\nProceed anyway?")
      : true;
    if (!proceed) throw new Error("AI calibration cancelled — wire a WireframeCalibration node to your VOs first.");
  }

  // Stage 1 — capture (in memory, no ZIP). aiMode=true so
  // autoCaptureCalibration suppresses Checkerboard mode-cycling
  // and uses the wider 90° capture FOV.
  if (onProgress) onProgress({ stage: "capture", current: 0, total: 1 });
  const cap = await autoCaptureCalibration({
    skipDownload: true,
    autoPrep:      true,
    coverageAware: true,
    perDisplay:    true,
    aiMode:        true,
    onProgress: (cur, total) => {
      if (onCapture) onCapture(cur, total);
    }
  });
  if (!cap || !cap.captures || !cap.meta) {
    throw new Error("Capture failed — no captures returned");
  }

  // Stage 2 — filter to per-display captures (the AI's primary input).
  // Cardinals are useful for human review but each shows the WHOLE
  // rig, which is hard for the AI to fault-localize per-projector.
  const perDisplayDirs = cap.meta.directions.filter(d => d.kind === "per-display");
  const perDisplayCaps = [];
  for (const dir of perDisplayDirs) {
    const f = cap.captures.find(c => c.filename.includes("_" + dir.name + ".png"));
    if (f) perDisplayCaps.push({ blob: f.blob, dir, display: cap.meta.displays[dir.displayIdx] });
  }
  if (perDisplayCaps.length === 0) {
    throw new Error("No per-display captures to analyze");
  }

  // Stage 3 — provider check.
  const provider = PROVIDERS[aiSettings.provider];
  if (!provider) throw new Error("No AI provider selected. Open the AI Settings panel and pick one.");
  if (provider.requiresKey && !aiSettings.anthropicKey) {
    throw new Error("API key required for " + aiSettings.provider + ". Set it in the AI Settings panel.");
  }
  if (!provider.supportsImage) {
    throw new Error("Selected provider doesn't support image input.");
  }

  // Stage 4 — iterate per-display, sending each capture to the AI.
  const corrections = [];
  const total = perDisplayCaps.length;
  for (let i = 0; i < total; i++) {
    const item = perDisplayCaps[i];
    const display = item.display;
    if (onProgress) onProgress({
      stage: "analyze", current: i + 1, total,
      displayIdx: display.idx,
      displayName: display.name
    });

    let resultEntry = {
      idx:         display.idx,
      displayId:   display.id,
      displayName: display.name,
      pose:        display.pose,
      fov:         display.fov,
      deltaYaw:   0, deltaPitch: 0, deltaFovH: 0, deltaFovV: 0,
      // Phase 6.6.20.16 — AI v3 keystone corner deltas (NDC).
      keystone:   { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 },
      // Phase 6.6.20.17 — AI v4 sparse Bezier control-point shifts.
      bezierAdjustments: [],
      confidence: 0, reasoning: "", error: null
    };

    try {
      const buf = await item.blob.arrayBuffer();
      const base64 = _arrayBufferToBase64(buf);

      const userText =
`Display ${display.idx} ("${display.name}", id=${display.id}).
Expected pose: yaw=${display.pose.yaw.toFixed(2)}°, pitch=${display.pose.pitch.toFixed(2)}°.
Expected FOV: ${display.fov.h.toFixed(1)}°(h) × ${display.fov.v.toFixed(1)}°(v).
The capture below shows what this projector's coverage region looks like when viewed from the rig sweet-spot, aimed at the projector's expected pose direction. Output JSON only.`;

      const response = await provider.call({
        system:      systemPrompt,
        user:        userText,
        model:       aiSettings.model,
        key:         aiSettings.anthropicKey,
        image:       base64,
        temperature: 0.1
      });

      // Extract first {...} JSON blob from the response — providers
      // sometimes wrap with prose despite "JSON ONLY" in the prompt.
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in response: " + response.slice(0, 100));
      const parsed = JSON.parse(jsonMatch[0]);
      resultEntry.deltaYaw   = Number.isFinite(parsed.deltaYawDeg)   ? parsed.deltaYawDeg   : 0;
      resultEntry.deltaPitch = Number.isFinite(parsed.deltaPitchDeg) ? parsed.deltaPitchDeg : 0;
      resultEntry.deltaFovH  = Number.isFinite(parsed.deltaFovHDeg)  ? parsed.deltaFovHDeg  : 0;
      resultEntry.deltaFovV  = Number.isFinite(parsed.deltaFovVDeg)  ? parsed.deltaFovVDeg  : 0;
      // Phase 6.6.20.16 — extract keystone corner deltas (AI v3).
      // Note: AI uses "try" but JS uses "try_" because try is a
      // reserved word — translate either spelling on parse.
      const ks = parsed.keystone || {};
      resultEntry.keystone.tlx  = Number.isFinite(ks.tlx)  ? ks.tlx  : 0;
      resultEntry.keystone.tly  = Number.isFinite(ks.tly)  ? ks.tly  : 0;
      resultEntry.keystone.trx  = Number.isFinite(ks.trx)  ? ks.trx  : 0;
      resultEntry.keystone.try_ = Number.isFinite(ks.try_) ? ks.try_
                               : Number.isFinite(ks.try)  ? ks.try   : 0;
      resultEntry.keystone.blx  = Number.isFinite(ks.blx)  ? ks.blx  : 0;
      resultEntry.keystone.bly  = Number.isFinite(ks.bly)  ? ks.bly  : 0;
      resultEntry.keystone.brx  = Number.isFinite(ks.brx)  ? ks.brx  : 0;
      resultEntry.keystone.bry  = Number.isFinite(ks.bry)  ? ks.bry  : 0;
      // Phase 6.6.20.17 — sparse Bezier control-point adjustments.
      if (Array.isArray(parsed.bezierAdjustments)) {
        for (const adj of parsed.bezierAdjustments) {
          if (!adj || typeof adj !== "object") continue;
          const col = Math.max(0, Math.min(4, Math.round(+adj.col || 0)));
          const row = Math.max(0, Math.min(4, Math.round(+adj.row || 0)));
          const dx = Number.isFinite(adj.dx) ? adj.dx : 0;
          const dy = Number.isFinite(adj.dy) ? adj.dy : 0;
          if (Math.abs(dx) < 1e-7 && Math.abs(dy) < 1e-7) continue;
          resultEntry.bezierAdjustments.push({ col, row, dx, dy });
          // Cap at 6 per display per pass.
          if (resultEntry.bezierAdjustments.length >= 6) break;
        }
      }
      resultEntry.confidence = Number.isFinite(parsed.confidence)    ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
      resultEntry.reasoning  = (typeof parsed.reasoning === "string") ? parsed.reasoning : "";
    } catch (e) {
      console.warn("[ai-calibration] display " + display.idx + " analysis failed:", e);
      resultEntry.error = e && e.message ? e.message : String(e);
    }
    corrections.push(resultEntry);
  }

  if (onProgress) onProgress({ stage: "done", current: total, total });
  return { corrections, meta: cap.meta };
}

/* Apply a list of corrections (yaw / pitch / FOV deltas per display)
 * to state.rig.displays. Pushes one history entry. Caller is
 * responsible for filtering corrections by the user's modal choices
 * before calling. */
function applyCalibrationCorrections(corrections) {
  if (!Array.isArray(corrections) || corrections.length === 0) return 0;
  if (!state.rig || !Array.isArray(state.rig.displays)) return 0;
  pushHistory("ai-calibration");
  let applied = 0;
  for (const c of corrections) {
    const display = state.rig.displays[c.idx];
    if (!display) continue;
    if (display.pose) {
      display.pose.yaw   = (display.pose.yaw   || 0) + (c.deltaYaw   || 0);
      display.pose.pitch = (display.pose.pitch || 0) + (c.deltaPitch || 0);
    }
    if (display.fov) {
      display.fov.h = Math.max(5, (display.fov.h || 90) + (c.deltaFovH || 0));
      display.fov.v = Math.max(5, (display.fov.v || 60) + (c.deltaFovV || 0));
    }
    // Phase 6.6.20.16 — keystone corner deltas accumulate into the
    // display's persistent keystoneCorners field. Auto-prep on the
    // next iteration applies them after auto-warp + auto-blend so
    // they survive the regenerate.
    if (c.keystone) {
      if (!display.keystoneCorners) {
        display.keystoneCorners = { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 };
      }
      const k = display.keystoneCorners;
      k.tlx  = (k.tlx  || 0) + (c.keystone.tlx  || 0);
      k.tly  = (k.tly  || 0) + (c.keystone.tly  || 0);
      k.trx  = (k.trx  || 0) + (c.keystone.trx  || 0);
      k.try_ = (k.try_ || 0) + (c.keystone.try_ || 0);
      k.blx  = (k.blx  || 0) + (c.keystone.blx  || 0);
      k.bly  = (k.bly  || 0) + (c.keystone.bly  || 0);
      k.brx  = (k.brx  || 0) + (c.keystone.brx  || 0);
      k.bry  = (k.bry  || 0) + (c.keystone.bry  || 0);
    }
    // Phase 6.6.20.17 — Bezier interior corrections. Each entry is
    // {col, row, dx, dy}; we lazy-init the 5×5 ctrl grid on first
    // adjustment, then accumulate into specific control points.
    // The grid is stored as deltas (identity = all zeros), so the
    // accumulated deltas survive auto-prep regenerations and apply
    // after keystone in the mesh pipeline.
    if (Array.isArray(c.bezierAdjustments) && c.bezierAdjustments.length > 0) {
      if (!display.bezierCorrections ||
          !Number.isInteger(display.bezierCorrections.cols) ||
          !Number.isInteger(display.bezierCorrections.rows) ||
          !Array.isArray(display.bezierCorrections.ctrl)) {
        // Lazy-init: 5×5 grid of zeros (cols=4, rows=4 → 25 control points)
        display.bezierCorrections = { cols: 4, rows: 4, ctrl: new Array(50).fill(0) };
      }
      const bc = display.bezierCorrections;
      const W = bc.cols + 1;
      for (const adj of c.bezierAdjustments) {
        const col = Math.max(0, Math.min(bc.cols, adj.col | 0));
        const row = Math.max(0, Math.min(bc.rows, adj.row | 0));
        const k = (row * W + col) * 2;
        bc.ctrl[k + 0] = (bc.ctrl[k + 0] || 0) + (adj.dx || 0);
        bc.ctrl[k + 1] = (bc.ctrl[k + 1] || 0) + (adj.dy || 0);
      }
    }
    if (Visual && Visual._warpCache) Visual._warpCache.delete(display.id);
    applied++;
  }
  if (state.rig.templateKey && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
    state.rig.templateKey = "custom";
  }
  renderProps && renderProps();
  render();
  return applied;
}

/* Phase 6.6.20.18 — build a diagnostic + fixes report for an
 * AI calibration run. Inputs:
 *   analysisResult.finalDiff — cumulative per-display deltas
 *   analysisResult.phase1    — phase 1 result (if present)
 *   analysisResult.phase2    — phase 2 result (if present)
 *
 * Output: { md: <string>, json: <object> } where md is human-
 * readable Markdown and json is the full structured data
 * (suitable for downstream analyzers / spreadsheet imports). */
function _buildAICalibrationReport(analysisResult) {
  const finalDiff = (analysisResult && analysisResult.finalDiff) || [];
  const phase1    = analysisResult && analysisResult.phase1;
  const phase2    = analysisResult && analysisResult.phase2;
  const ts = new Date().toISOString();

  // Helper: extract last-iteration AI reasoning per display.
  const reasoningFromPhase = (phase) => {
    const m = {};
    if (!phase || !phase.lastResult || !Array.isArray(phase.lastResult.corrections)) return m;
    for (const c of phase.lastResult.corrections) {
      m[c.idx] = {
        reasoning: c.reasoning || "",
        confidence: c.confidence || 0,
        error: c.error || null
      };
    }
    return m;
  };
  const phase1Reason = reasoningFromPhase(phase1);
  const phase2Reason = reasoningFromPhase(phase2);

  // Per-display rows for the JSON payload + Markdown table.
  const rows = finalDiff.map(c => {
    const k = c.keystone || {};
    const ksAbs = Math.abs(k.tlx || 0) + Math.abs(k.tly || 0) +
                  Math.abs(k.trx || 0) + Math.abs(k.try_ || 0) +
                  Math.abs(k.blx || 0) + Math.abs(k.bly || 0) +
                  Math.abs(k.brx || 0) + Math.abs(k.bry || 0);
    const bdCount = (c.bezierDiff && c.bezierDiff.count) || 0;
    const bdAbs   = (c.bezierDiff && c.bezierDiff.totalAbs) || 0;
    const changedPose = Math.abs(c.deltaYaw)   > 0.005 ||
                        Math.abs(c.deltaPitch) > 0.005 ||
                        Math.abs(c.deltaFovH)  > 0.005 ||
                        Math.abs(c.deltaFovV)  > 0.005;
    const changed = changedPose || ksAbs > 5e-4 || bdCount > 0;
    return {
      idx: c.idx,
      displayId:   c.displayId,
      displayName: c.displayName,
      pose: c.pose,                // baseline pose
      fov:  c.fov,
      poseFinal: {
        yaw:   (c.pose ? c.pose.yaw   : 0) + (c.deltaYaw   || 0),
        pitch: (c.pose ? c.pose.pitch : 0) + (c.deltaPitch || 0)
      },
      fovFinal: {
        h: (c.fov ? c.fov.h : 0) + (c.deltaFovH || 0),
        v: (c.fov ? c.fov.v : 0) + (c.deltaFovV || 0)
      },
      deltas: {
        yaw:   c.deltaYaw   || 0,
        pitch: c.deltaPitch || 0,
        fovH:  c.deltaFovH  || 0,
        fovV:  c.deltaFovV  || 0
      },
      keystone: {
        tlx: k.tlx || 0, tly: k.tly || 0,
        trx: k.trx || 0, try_: k.try_ || 0,
        blx: k.blx || 0, bly: k.bly || 0,
        brx: k.brx || 0, bry: k.bry || 0,
        absSum: ksAbs
      },
      bezier: c.bezierDiff || { count: 0, totalAbs: 0, perPoint: [] },
      reasoning: {
        phase1: phase1Reason[c.idx] || null,
        phase2: phase2Reason[c.idx] || null
      },
      changed
    };
  });

  // Aggregate counts.
  const changedCount = rows.filter(r => r.changed).length;
  const erroredCount = rows.filter(r => (r.reasoning.phase1 && r.reasoning.phase1.error) ||
                                         (r.reasoning.phase2 && r.reasoning.phase2.error)).length;

  const json = {
    app: "Gamma Node",
    version: APP_VERSION,
    timestamp: ts,
    summary: {
      iterations: {
        phase1: phase1 ? phase1.iterations : 0,
        phase2: phase2 ? phase2.iterations : 0,
        total:  (phase1 ? phase1.iterations : 0) + (phase2 ? phase2.iterations : 0)
      },
      totalCorrectionsApplied: analysisResult.totalCorrections || 0,
      displaysChanged: changedCount,
      displaysErrored: erroredCount,
      totalDisplays: rows.length
    },
    rig: state.rig ? {
      templateKey: state.rig.templateKey,
      surface:     state.rig.surface,
      sweetSpot:   state.rig.sweetSpot,
      shaderCenterYaw:   state.rig.shaderCenterYaw   || 0,
      shaderCenterPitch: state.rig.shaderCenterPitch || 0
    } : null,
    displays: rows
  };

  // Build the Markdown report.
  const md = (() => {
    const lines = [];
    lines.push("# AI Calibration Report");
    lines.push("");
    lines.push("Generated " + ts + " by Gamma Node v" + APP_VERSION + ".");
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push("- **Phase 1** (pose+FOV+keystone): " + (phase1 ? phase1.iterations : 0) + " iteration(s)");
    lines.push("- **Phase 2** (Bezier interior): " + (phase2 ? phase2.iterations : 0) + " iteration(s)");
    lines.push("- **Displays changed:** " + changedCount + " / " + rows.length);
    lines.push("- **Errors:** " + erroredCount);
    lines.push("- **Total corrections applied:** " + (analysisResult.totalCorrections || 0));
    lines.push("");
    if (state.rig && state.rig.surface) {
      lines.push("## Rig configuration");
      lines.push("");
      lines.push("- Surface type: `" + state.rig.surface.type + "`");
      if (state.rig.surface.type === "swept") {
        const p = state.rig.surface.profile || {};
        const path = state.rig.surface.path || {};
        lines.push("  - Profile: " + p.kind + " radius=" + p.radius +
                   (p.kind === "arc" ? ", pitch [" + p.pitchStart + "°, " + p.pitchEnd + "°]"
                                     : ", y [" + p.yMin + ", " + p.yMax + "]"));
        lines.push("  - Path: yaw [" + path.yawStart + "°, " + path.yawEnd + "°]");
      }
      lines.push("- Sweet spot: " + JSON.stringify(state.rig.sweetSpot));
      lines.push("");
    }
    lines.push("## Per-display details");
    lines.push("");
    for (const r of rows) {
      lines.push("### Display " + r.idx + " — `" + (r.displayId || "") + "`" +
                 (r.displayName ? ' "' + r.displayName + '"' : "") +
                 (r.changed ? "" : "  *(no changes)*"));
      lines.push("");
      lines.push("**Pose**: yaw " + r.pose.yaw.toFixed(2) + "° → " + r.poseFinal.yaw.toFixed(2) +
                 "° (Δ " + (r.deltas.yaw >= 0 ? "+" : "") + r.deltas.yaw.toFixed(3) + "°), " +
                 "pitch " + r.pose.pitch.toFixed(2) + "° → " + r.poseFinal.pitch.toFixed(2) +
                 "° (Δ " + (r.deltas.pitch >= 0 ? "+" : "") + r.deltas.pitch.toFixed(3) + "°)");
      lines.push("");
      if (Math.abs(r.deltas.fovH) > 0.005 || Math.abs(r.deltas.fovV) > 0.005) {
        lines.push("**FOV**: " + r.fov.h.toFixed(2) + "° × " + r.fov.v.toFixed(2) +
                   "° → " + r.fovFinal.h.toFixed(2) + "° × " + r.fovFinal.v.toFixed(2) + "°");
        lines.push("");
      }
      if (r.keystone.absSum > 5e-4) {
        const k = r.keystone;
        const fmt = v => (v >= 0 ? "+" : "") + v.toFixed(4);
        lines.push("**Keystone corners** (NDC):");
        lines.push("  - TL = (" + fmt(k.tlx) + ", " + fmt(k.tly) + ")");
        lines.push("  - TR = (" + fmt(k.trx) + ", " + fmt(k.try_) + ")");
        lines.push("  - BL = (" + fmt(k.blx) + ", " + fmt(k.bly) + ")");
        lines.push("  - BR = (" + fmt(k.brx) + ", " + fmt(k.bry) + ")");
        lines.push("");
      }
      if (r.bezier && r.bezier.count > 0 && Array.isArray(r.bezier.perPoint)) {
        lines.push("**Bezier control points** (5×5 grid, " + r.bezier.count + " adjusted, Σ|Δ|=" +
                   r.bezier.totalAbs.toFixed(4) + " NDC):");
        for (const pt of r.bezier.perPoint) {
          const fmt = v => (v >= 0 ? "+" : "") + v.toFixed(5);
          lines.push("  - (col=" + pt.col + ", row=" + pt.row + ") = (" + fmt(pt.dx) + ", " + fmt(pt.dy) + ")");
        }
        lines.push("");
      }
      if (r.reasoning.phase1) {
        const p1 = r.reasoning.phase1;
        if (p1.error) {
          lines.push("> **Phase 1 ERROR**: " + p1.error);
        } else if (p1.reasoning) {
          lines.push("> **Phase 1 AI** (conf " + (p1.confidence * 100).toFixed(0) + "%): " + p1.reasoning);
        }
        lines.push("");
      }
      if (r.reasoning.phase2) {
        const p2 = r.reasoning.phase2;
        if (p2.error) {
          lines.push("> **Phase 2 ERROR**: " + p2.error);
        } else if (p2.reasoning) {
          lines.push("> **Phase 2 AI** (conf " + (p2.confidence * 100).toFixed(0) + "%): " + p2.reasoning);
        }
        lines.push("");
      }
    }
    if (erroredCount > 0) {
      lines.push("## Errors");
      lines.push("");
      lines.push(erroredCount + " display(s) had at least one phase with an API error. Review the per-display sections above for the specific error messages, then check AI Settings (User DSP tab → ⚙) for provider/key issues.");
      lines.push("");
    }
    return lines.join("\n");
  })();

  return { md, json };
}

/* Phase 6.6.20.18 — package the report into a ZIP and download. */
function exportAICalibrationReport(analysisResult) {
  const report = _buildAICalibrationReport(analysisResult);
  const files = {
    "report.md":         new TextEncoder().encode(report.md),
    "corrections.json":  new TextEncoder().encode(JSON.stringify(report.json, null, 2))
  };
  const zip = _writeZipArchive(files);
  const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fname = "ai-calibration-report-" + ts + ".zip";
  _downloadBlob(new Blob([zip], { type: "application/zip" }), fname);
  console.log("[ai-calibration-report] saved " + fname);
  return fname;
}

/* Show the AI corrections diff modal. Promise resolves with the
 * filtered list of corrections the user approved (or [] on cancel). */
function showAICalibrationModal(analysisResult) {
  return new Promise((resolve) => {
    const corrections = (analysisResult && analysisResult.corrections) || [];
    const overlay = document.getElementById("ai-calibration-modal");
    const list    = document.getElementById("ai-calibration-list");
    if (!overlay || !list) {
      resolve([]);
      return;
    }
    list.innerHTML = "";
    // Sort by confidence descending so the high-confidence
    // corrections (the ones the user is most likely to apply) sit
    // at the top of the modal.
    const sorted = corrections.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    sorted.forEach((c, listIdx) => {
      const row = document.createElement("div");
      row.className = "ai-calib-row";
      const hasError = !!c.error;
      const conf = c.confidence || 0;
      const confColor = hasError ? "rgba(220, 100, 100, 1)"
                      : conf > 0.8 ? "rgba(100, 220, 130, 1)"
                      : conf > 0.5 ? "rgba(220, 200, 100, 1)"
                      :              "rgba(220, 130, 100, 1)";
      // 6.6.20.16 — keystone deltas (NDC) also count toward
      // "significant" for pre-checking the row.
      const k = c.keystone || {};
      const ksSum = Math.abs(k.tlx || 0) + Math.abs(k.tly || 0) +
                    Math.abs(k.trx || 0) + Math.abs(k.try_ || 0) +
                    Math.abs(k.blx || 0) + Math.abs(k.bly || 0) +
                    Math.abs(k.brx || 0) + Math.abs(k.bry || 0);
      const bdSum = (c.bezierDiff && c.bezierDiff.totalAbs) || 0;
      const significant = !hasError &&
        (Math.abs(c.deltaYaw)   > 0.05 || Math.abs(c.deltaPitch) > 0.05 ||
         Math.abs(c.deltaFovH)  > 0.05 || Math.abs(c.deltaFovV)  > 0.05 ||
         ksSum > 0.001 || bdSum > 0.001);
      const checked = significant && conf >= 0.5 ? " checked" : "";
      const fmtDelta = (x, label) => {
        const v = (x || 0);
        if (Math.abs(v) < 0.005) return "";
        const sign = v > 0 ? "+" : "";
        return ' <span class="ai-calib-delta" data-label="' + label + '">' +
               sign + v.toFixed(2) + "° " + label + "</span>";
      };
      const fmtKs = (x, label) => {
        const v = (x || 0);
        if (Math.abs(v) < 0.0005) return "";
        const sign = v > 0 ? "+" : "";
        return ' <span class="ai-calib-delta" data-label="' + label + '">' +
               sign + v.toFixed(4) + " " + label + "</span>";
      };
      const ksLine = ksSum > 0.0005
        ? '<div class="ai-calib-deltas" style="opacity:0.85">keystone:' +
            fmtKs(k.tlx, "TLx") + fmtKs(k.tly, "TLy") +
            fmtKs(k.trx, "TRx") + fmtKs(k.try_, "TRy") +
            fmtKs(k.blx, "BLx") + fmtKs(k.bly, "BLy") +
            fmtKs(k.brx, "BRx") + fmtKs(k.bry, "BRy") +
          '</div>'
        : "";
      // 6.6.20.17 — Bezier diff summary. Don't enumerate every
      // changed control point (could be 25 entries); just show the
      // count + max delta so the user knows fine-tune touched this
      // display.
      const bd = c.bezierDiff;
      const bdLine = (bd && bd.count > 0)
        ? '<div class="ai-calib-deltas" style="opacity:0.85">bezier: ' +
            bd.count + ' control point' + (bd.count === 1 ? '' : 's') +
            ' adjusted (Σ|Δ| = ' + bd.totalAbs.toFixed(4) + ' NDC)</div>'
        : "";
      const beforeAfterPose = "yaw " + (c.pose ? c.pose.yaw.toFixed(2) : "?") +
                              "° → " + ((c.pose ? c.pose.yaw : 0) + (c.deltaYaw || 0)).toFixed(2) +
                              "°&nbsp;&nbsp;|&nbsp;&nbsp;pitch " +
                              (c.pose ? c.pose.pitch.toFixed(2) : "?") + "° → " +
                              ((c.pose ? c.pose.pitch : 0) + (c.deltaPitch || 0)).toFixed(2) + "°";
      const beforeAfterFov  = "FOV " + (c.fov ? c.fov.h.toFixed(1) : "?") + "° → " +
                              ((c.fov ? c.fov.h : 0) + (c.deltaFovH || 0)).toFixed(1) + "°&nbsp;×&nbsp;" +
                              (c.fov ? c.fov.v.toFixed(1) : "?") + "° → " +
                              ((c.fov ? c.fov.v : 0) + (c.deltaFovV || 0)).toFixed(1) + "°";
      row.innerHTML =
`<label class="ai-calib-check">
  <input type="checkbox" data-correction-idx="${c.idx}"${checked}${hasError ? " disabled" : ""}>
  <span class="ai-calib-display-name">Display ${c.idx} (${escapeText(c.displayName || "")})</span>
</label>
<div class="ai-calib-deltas">${fmtDelta(c.deltaYaw, "yaw")}${fmtDelta(c.deltaPitch, "pitch")}${fmtDelta(c.deltaFovH, "fovH")}${fmtDelta(c.deltaFovV, "fovV")}${significant ? "" : ' <span class="ai-calib-delta">(no change proposed)</span>'}</div>
${ksLine}
${bdLine}
<div class="ai-calib-detail">${beforeAfterPose}<br>${beforeAfterFov}</div>
<div class="ai-calib-confidence" style="color: ${confColor}">${hasError ? "ERROR: " + escapeText(c.error) : ("Confidence " + (conf * 100).toFixed(0) + "% — " + escapeText(c.reasoning || "(no reasoning)"))}</div>`;
      list.appendChild(row);
    });
    overlay.style.display = "flex";

    const close = (apply) => {
      overlay.style.display = "none";
      if (!apply) { resolve([]); return; }
      const checks = list.querySelectorAll('input[type="checkbox"][data-correction-idx]:checked');
      const selectedIdxs = new Set();
      checks.forEach(c => selectedIdxs.add(parseInt(c.dataset.correctionIdx, 10)));
      resolve(corrections.filter(c => selectedIdxs.has(c.idx) && !c.error));
    };

    const applyBtn  = document.getElementById("ai-calibration-apply");
    const cancelBtn = document.getElementById("ai-calibration-cancel");
    const closeBtn  = document.getElementById("ai-calibration-close");
    const selectAll = document.getElementById("ai-calibration-select-all");
    const selectNone = document.getElementById("ai-calibration-select-none");
    const exportBtn = document.getElementById("ai-calibration-export");
    const onApply  = () => close(true);
    const onCancel = () => close(false);
    const onAll    = () => list.querySelectorAll('input[type="checkbox"][data-correction-idx]:not(:disabled)').forEach(c => c.checked = true);
    const onNone   = () => list.querySelectorAll('input[type="checkbox"][data-correction-idx]').forEach(c => c.checked = false);
    // Phase 6.6.20.18 — export diagnostic + fixes report. Generates
    // a ZIP with report.md + corrections.json. Doesn't dismiss the
    // modal — user can still apply / cancel after exporting.
    const onExport = () => {
      try {
        const fname = exportAICalibrationReport(analysisResult);
        const orig = exportBtn.textContent;
        exportBtn.textContent = "Saved " + fname.split("-").slice(-2).join("-").replace(".zip", "");
        exportBtn.disabled = true;
        setTimeout(() => {
          exportBtn.textContent = orig;
          exportBtn.disabled = false;
        }, 1800);
      } catch (e) {
        console.error("[ai-calibration-report] export failed:", e);
        alert("Could not export report:\n\n" + (e && e.message ? e.message : String(e)));
      }
    };
    if (applyBtn)  applyBtn.onclick  = onApply;
    if (cancelBtn) cancelBtn.onclick = onCancel;
    if (closeBtn)  closeBtn.onclick  = onCancel;
    if (selectAll) selectAll.onclick = onAll;
    if (selectNone) selectNone.onclick = onNone;
    if (exportBtn) exportBtn.onclick = onExport;
  });
}

/* Phase 6.6.20.13 — AI calibration v2 (iterative converge).
 *
 * Single-pass calibration breaks ring symmetry: the AI sees each
 * projector independently, suggests a unique correction per
 * projector, and adjacent projectors that previously shared exact
 * ring poses now diverge. The user reported this exact failure
 * mode ("the lat/long grid is now severely fragmented").
 *
 * Iterative fix: cap per-pass deltas tightly (default ±0.5°), then
 * recapture and re-analyze. Each pass tightens. Adjacent-projector
 * mismatches don't compound across passes because each step is
 * smaller than the projector overlap region. Converges to typically
 * <0.2° error in 3-5 passes.
 *
 * Returns { iterations, totalCorrections, finalDiff }, where
 * finalDiff is the cumulative baseline → current change (so the
 * user can review + revert any drift they don't like).
 */
async function runAICalibrationIterative(opts) {
  const maxIters = (opts && Number.isFinite(opts.maxIterations)) ? opts.maxIterations : 5;
  const maxDelta = (opts && Number.isFinite(opts.maxDeltaPerPass)) ? opts.maxDeltaPerPass : 0.5;
  const stopThreshold = (opts && Number.isFinite(opts.stopThreshold)) ? opts.stopThreshold : 0.15;
  const onStatus = (opts && opts.onStatus) || null;
  // 6.6.20.17 — mode: "main" (pose+FOV+keystone) or "bezier" (sparse
  // interior adjustments). Bezier mode runs as Phase 2 after main
  // converges, with a different prompt + tighter clamp.
  const mode = (opts && opts.mode === "bezier") ? "bezier" : "main";
  const isBezier = mode === "bezier";
  const bezierMaxDelta = (opts && Number.isFinite(opts.bezierMaxDeltaPerPass)) ? opts.bezierMaxDeltaPerPass : 0.015;

  // Snapshot baseline poses + keystone so the final diff modal
  // shows cumulative changes from the user's pre-AI rig state.
  const cloneKC = (k) => (k ? {
    tlx: k.tlx || 0, tly: k.tly || 0,
    trx: k.trx || 0, try_: k.try_ || 0,
    blx: k.blx || 0, bly: k.bly || 0,
    brx: k.brx || 0, bry: k.bry || 0
  } : { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 });
  const baseline = (state.rig.displays || []).map((d, idx) => d ? {
    idx,
    id:   d.id,
    name: d.name,
    yaw:   d.pose ? (d.pose.yaw   || 0) : 0,
    pitch: d.pose ? (d.pose.pitch || 0) : 0,
    fovH:  d.fov  ? (d.fov.h      || 90) : 90,
    fovV:  d.fov  ? (d.fov.v      || 60) : 60,
    keystoneCorners: cloneKC(d.keystoneCorners),
    // 6.6.20.17 — snapshot Bezier corrections grid (deep copy of
    // ctrl float array) so cumulative diff captures fine-tune
    // changes too. null if no Bezier corrections set.
    bezierCorrections: d.bezierCorrections
      ? { cols: d.bezierCorrections.cols, rows: d.bezierCorrections.rows,
          ctrl: Array.isArray(d.bezierCorrections.ctrl) ? d.bezierCorrections.ctrl.slice() : [] }
      : null
  } : null);

  let iterCount = 0;
  let totalCorrections = 0;
  let lastResult = null;

  for (let iter = 0; iter < maxIters; iter++) {
    iterCount = iter + 1;
    if (onStatus) onStatus("Iteration " + iterCount + "/" + maxIters + " — capturing...");
    const result = await analyzeCalibrationWithAI({
      mode,
      onProgress: (p) => {
        if (!onStatus) return;
        const phase = isBezier ? "Phase 2 (Bezier)" : "Phase 1 (pose+FOV+keystone)";
        if (p.stage === "capture") onStatus(phase + " — iter " + iterCount + " — capturing");
        else if (p.stage === "analyze") onStatus(phase + " — iter " + iterCount + " — AI analyzing " + p.current + "/" + p.total);
      }
    });
    lastResult = result;

    // Clamp + filter to "significant" corrections.
    // Pose/FOV deltas: ±maxDelta degrees (default 0.5°).
    // Keystone deltas: ±keystoneMaxDelta NDC (default 0.02 = ~5 px @ 1080p).
    // Bezier deltas: ±bezierMaxDelta NDC (default 0.015 = ~3-4 px).
    const keystoneMaxDelta = 0.02;
    let totalDeltaSum = 0;
    let significantCount = 0;
    const clamp = (v, m) => Math.max(-m, Math.min(m, v || 0));
    const clamped = (result.corrections || [])
      .filter(c => !c.error)
      .map(c => {
        // In bezier mode we ignore pose/FOV/keystone (the AI doesn't
        // propose those in this phase); leave them at 0 so apply
        // skips them.
        const cy = isBezier ? 0 : clamp(c.deltaYaw,   maxDelta);
        const cp = isBezier ? 0 : clamp(c.deltaPitch, maxDelta);
        const ch = isBezier ? 0 : clamp(c.deltaFovH,  maxDelta);
        const cv = isBezier ? 0 : clamp(c.deltaFovV,  maxDelta);
        const ks = c.keystone || {};
        const k = isBezier
          ? { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 }
          : {
              tlx:  clamp(ks.tlx,  keystoneMaxDelta),
              tly:  clamp(ks.tly,  keystoneMaxDelta),
              trx:  clamp(ks.trx,  keystoneMaxDelta),
              try_: clamp(ks.try_, keystoneMaxDelta),
              blx:  clamp(ks.blx,  keystoneMaxDelta),
              bly:  clamp(ks.bly,  keystoneMaxDelta),
              brx:  clamp(ks.brx,  keystoneMaxDelta),
              bry:  clamp(ks.bry,  keystoneMaxDelta)
            };
        // Bezier adjustments: clamped per-entry, dropped if below
        // 5e-4 NDC (~0.25 px). Phase 6.6.20.21: also require AI
        // confidence ≥ 0.7 to apply ANY bezier adjustments — the
        // hallucination failure mode (uniform "slight edge bulge"
        // across all displays at confidence 0.75) was tipped over
        // by the threshold being too lenient. Bumped to 0.7 so
        // generic boilerplate at 0.5-0.65 confidence gets dropped.
        const conf = Number.isFinite(c.confidence) ? c.confidence : 0.5;
        const ba = isBezier && Array.isArray(c.bezierAdjustments) && conf >= 0.7
          ? c.bezierAdjustments.map(adj => ({
              col:  Math.max(0, Math.min(4, adj.col | 0)),
              row:  Math.max(0, Math.min(4, adj.row | 0)),
              dx:   clamp(adj.dx, bezierMaxDelta),
              dy:   clamp(adj.dy, bezierMaxDelta)
            })).filter(adj => Math.abs(adj.dx) > 5e-4 || Math.abs(adj.dy) > 5e-4)
          : [];
        const poseMag = Math.abs(cy) + Math.abs(cp) + Math.abs(ch) + Math.abs(cv);
        const ksMag = (Math.abs(k.tlx) + Math.abs(k.tly) + Math.abs(k.trx) + Math.abs(k.try_) +
                       Math.abs(k.blx) + Math.abs(k.bly) + Math.abs(k.brx) + Math.abs(k.bry)) * 100;
        const baMag = ba.reduce((s, adj) => s + (Math.abs(adj.dx) + Math.abs(adj.dy)) * 100, 0);
        const m = poseMag + ksMag + baMag;
        if (m > 0.08) significantCount++;
        totalDeltaSum += m;
        return Object.assign({}, c, {
          deltaYaw: cy, deltaPitch: cp, deltaFovH: ch, deltaFovV: cv,
          keystone: k,
          bezierAdjustments: ba
        });
      });

    const meanDelta = clamped.length > 0 ? totalDeltaSum / clamped.length / 4 : 0;
    if (onStatus) onStatus("Iter " + iterCount + " — applying " + significantCount + " corrections (mean Δ=" + meanDelta.toFixed(3) + "°)");

    if (significantCount === 0) {
      console.log("[ai-iterative] no significant corrections at iter " + iterCount + " — converged");
      break;
    }

    // Apply the clamped corrections (only significant ones).
    // Pose threshold: 0.02°. Keystone/Bezier threshold: 5e-4 NDC.
    const significant = clamped.filter(c => {
      if (Math.abs(c.deltaYaw)   > 0.02) return true;
      if (Math.abs(c.deltaPitch) > 0.02) return true;
      if (Math.abs(c.deltaFovH)  > 0.02) return true;
      if (Math.abs(c.deltaFovV)  > 0.02) return true;
      const k = c.keystone;
      if (k && (Math.abs(k.tlx)  > 5e-4 || Math.abs(k.tly)  > 5e-4 ||
                Math.abs(k.trx)  > 5e-4 || Math.abs(k.try_) > 5e-4 ||
                Math.abs(k.blx)  > 5e-4 || Math.abs(k.bly)  > 5e-4 ||
                Math.abs(k.brx)  > 5e-4 || Math.abs(k.bry)  > 5e-4)) return true;
      // Bezier adjustments are already filtered to >5e-4 in the
      // clamp step, so any non-empty list means significant.
      return Array.isArray(c.bezierAdjustments) && c.bezierAdjustments.length > 0;
    });
    const applied = applyCalibrationCorrections(significant);
    totalCorrections += applied;

    // Convergence check: average per-axis delta below threshold.
    if (meanDelta < stopThreshold) {
      console.log("[ai-iterative] converged at iter " + iterCount + " (mean Δ=" + meanDelta.toFixed(3) + "°)");
      break;
    }
  }

  // Build cumulative diff: baseline → current.
  const finalDiff = baseline.filter(b => b).map(b => {
    const display = state.rig.displays[b.idx];
    if (!display) return null;
    const curYaw   = display.pose ? (display.pose.yaw   || 0) : 0;
    const curPitch = display.pose ? (display.pose.pitch || 0) : 0;
    const curFovH  = display.fov  ? (display.fov.h      || 90) : 90;
    const curFovV  = display.fov  ? (display.fov.v      || 60) : 60;
    const curKC = display.keystoneCorners || {};
    const baseKC = b.keystoneCorners || {};
    return {
      idx:         b.idx,
      displayId:   b.id,
      displayName: b.name,
      pose:        { yaw: b.yaw, pitch: b.pitch },
      fov:         { h: b.fovH, v: b.fovV },
      deltaYaw:    curYaw   - b.yaw,
      deltaPitch:  curPitch - b.pitch,
      deltaFovH:   curFovH  - b.fovH,
      deltaFovV:   curFovV  - b.fovV,
      keystone: {
        tlx:  (curKC.tlx  || 0) - (baseKC.tlx  || 0),
        tly:  (curKC.tly  || 0) - (baseKC.tly  || 0),
        trx:  (curKC.trx  || 0) - (baseKC.trx  || 0),
        try_: (curKC.try_ || 0) - (baseKC.try_ || 0),
        blx:  (curKC.blx  || 0) - (baseKC.blx  || 0),
        bly:  (curKC.bly  || 0) - (baseKC.bly  || 0),
        brx:  (curKC.brx  || 0) - (baseKC.brx  || 0),
        bry:  (curKC.bry  || 0) - (baseKC.bry  || 0)
      },
      // 6.6.20.17 — Bezier diff: count of control points changed
      // and total absolute delta (NDC). Per-point detail kept for
      // revert.
      bezierDiff: (() => {
        const baseBC = b.bezierCorrections;
        const curBC  = display.bezierCorrections;
        if (!baseBC && !curBC) return { count: 0, totalAbs: 0, perPoint: null };
        const cols = (curBC && curBC.cols) || (baseBC && baseBC.cols) || 4;
        const rows = (curBC && curBC.rows) || (baseBC && baseBC.rows) || 4;
        const N = (cols + 1) * (rows + 1) * 2;
        const baseCtrl = (baseBC && Array.isArray(baseBC.ctrl)) ? baseBC.ctrl : new Array(N).fill(0);
        const curCtrl  = (curBC  && Array.isArray(curBC.ctrl))  ? curBC.ctrl  : new Array(N).fill(0);
        let count = 0, totalAbs = 0;
        const perPoint = [];
        for (let pi = 0; pi < (cols + 1) * (rows + 1); pi++) {
          const dx = (curCtrl[pi*2 + 0] || 0) - (baseCtrl[pi*2 + 0] || 0);
          const dy = (curCtrl[pi*2 + 1] || 0) - (baseCtrl[pi*2 + 1] || 0);
          if (Math.abs(dx) > 1e-5 || Math.abs(dy) > 1e-5) {
            count++;
            totalAbs += Math.abs(dx) + Math.abs(dy);
            perPoint.push({ idx: pi, col: pi % (cols+1), row: (pi / (cols+1)) | 0, dx, dy });
          }
        }
        return { count, totalAbs, perPoint, cols, rows };
      })(),
      confidence:  1.0,
      reasoning:   "Cumulative iterative correction over " + iterCount + " pass(es)",
      error:       null
    };
  }).filter(Boolean);

  return {
    iterations: iterCount,
    totalCorrections,
    finalDiff,
    lastResult,                              // last analyzeCalibrationWithAI return — has per-display errors
    lastMeta: lastResult ? lastResult.meta : null
  };
}

/* Phase 6.6.20.21 — wipe all AI calibration state from the rig.
 * Returns each display to baseline pose+FOV (per current rig
 * template), zeros keystoneCorners, drops bezierCorrections, and
 * re-runs auto-warp + auto-blend so the visible mesh state matches.
 *
 * Used when AI calibration produced a worse result and the user
 * wants to start over from a clean rig. Doesn't touch custom
 * (hand-edited) warp meshes — those are sacred per the existing
 * _isCustom check.
 *
 * Confirmation dialog by default; pass {silent: true} to skip. */
function resetAICalibration(opts) {
  if (!state.rig || !Array.isArray(state.rig.displays)) return 0;
  const silent = !!(opts && opts.silent);
  if (!silent) {
    const ok = (typeof confirm === "function")
      ? confirm("Reset all AI calibration corrections?\n\n" +
                "This will:\n" +
                "  • Zero every display's keystoneCorners (8 NDC offsets per display)\n" +
                "  • Drop every display's bezierCorrections (5×5 Bezier control grid)\n" +
                "  • Replace every display's warp mesh with a fresh Auto-blend\n" +
                "    (hard-cuts) mesh — identity NDC positions + projector-overlap\n" +
                "    alpha assignment, so every world point is rendered by exactly\n" +
                "    one projector and adjacent displays don't double up at the\n" +
                "    boundaries\n\n" +
                "Pose / FOV are NOT reverted (re-pick the rig template for that).\n" +
                "Custom hand-edited warp meshes are preserved.\n\n" +
                "Continue?")
      : true;
    if (!ok) return 0;
  }
  pushHistory("ai-calibration-reset");
  let cleaned = 0;
  // 6.6.20.23 — verbose logging so user can verify in devtools that
  // the right code path is running (vs. an old cached version of
  // the page). If they see "v0.1.90 reset starting" in console, the
  // fix is live; if they see no log line, hard-refresh (Ctrl+Shift+R).
  console.log("[ai-calibration-reset] v0.1.90 reset starting — " +
              state.rig.displays.length + " display(s)");
  for (const d of state.rig.displays) {
    if (!d) continue;
    // Custom (hand-edited) meshes are sacred — leave them.
    const isCustom = d.warpMesh && d.warpMesh._isCustom;
    let hadAny = false;
    if (d.keystoneCorners) {
      const k = d.keystoneCorners;
      if (Math.abs(k.tlx || 0) > 1e-6 || Math.abs(k.tly || 0) > 1e-6 ||
          Math.abs(k.trx || 0) > 1e-6 || Math.abs(k.try_ || 0) > 1e-6 ||
          Math.abs(k.blx || 0) > 1e-6 || Math.abs(k.bly || 0) > 1e-6 ||
          Math.abs(k.brx || 0) > 1e-6 || Math.abs(k.bry || 0) > 1e-6) {
        hadAny = true;
      }
      d.keystoneCorners = { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 };
    }
    if (d.bezierCorrections) {
      hadAny = true;
      d.bezierCorrections = null;
    }
    // 6.6.20.22 — KEY FIX: actually null out the warp mesh too. The
    // previous reset re-ran Auto-warp + Auto-blend, which generated
    // a fresh 128×128 mesh — but auto-warp combined with the
    // curved-screen-projection added in 6.6.20.1 produces a DOUBLE
    // WARP (theater raycasts vertex positions onto the sphere AND
    // auto-warp remaps source UVs for audience-correctness, which
    // was designed for the OLD flat-quad theater). The double-warp
    // is what causes adjacent projectors' content to disagree at
    // boundaries — the visible "thick green line stacking" the
    // user observed.
    //
    // True clean state = warpMesh: null. Theater then renders via
    // the curved-screen-projection alone (8×8 identity mesh per
    // display, vertices on the sphere, source UV = identity grid).
    // The wireframe shader is rendered correctly per display and
    // the lines actually meet at projector boundaries because
    // there's no UV remapping to misalign them.
    if (!isCustom && d.warpMesh) {
      hadAny = true;
      d.warpMesh = null;
    }
    if (hadAny) cleaned++;
    if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
  }
  // 6.6.20.23 — RE-RUN Auto-blend (hard cuts) after the wipe.
  // We DO NOT re-run Auto-warp (that was the audience-equirect UV
  // remapping that double-warped against curved-screen projection).
  // But Auto-blend is structurally different: _makeScreenSpaceBlendMesh
  // only writes per-vertex ALPHA values; the NDC positions stay on
  // the identity grid. No UV remapping, no double-warp.
  //
  // Without auto-blend, every projector renders its full framebuffer
  // at intensity 1.0. In overlap regions (any rig with adjacent
  // projectors covering the same world point — cylinders, dome,
  // AlloSphere) you get N copies of every wireframe line stacked on
  // top of each other, visibly fattening every great circle and
  // grid line. That's what produced the v0.1.90 "bigger fat blue
  // line" report on the 8-cylinder.
  //
  // Hard-cuts mode: alpha is binary per pixel — exactly one
  // projector wins each world point, so adjacent projectors never
  // double-up at overlap. Lines render once at their true thickness.
  try {
    _applyAutoBlendToRig({ skipHistory: true, hardCuts: true });
  } catch (_) { /* skip on errors (e.g. surface=free) */ }
  if (Visual && Visual._warpCache && typeof Visual._warpCache.clear === "function") {
    Visual._warpCache.clear();
  }
  // 6.6.20.23 — also log post-reset warpMesh state per display so we
  // can see whether the null actually stuck.
  let nonNullAfter = 0;
  for (const d of state.rig.displays) {
    if (d && d.warpMesh) {
      nonNullAfter++;
      console.log("  [post-reset] display " + d.id + " STILL has warpMesh:",
                  { _isCustom: d.warpMesh._isCustom,
                    _isAutoBlend: d.warpMesh._isAutoBlend,
                    _isAutoWarp: d.warpMesh._isAutoWarp,
                    cols: d.warpMesh.cols, rows: d.warpMesh.rows });
    }
  }
  renderProps && renderProps();
  render();
  console.log("[ai-calibration-reset] cleaned " + cleaned + " display(s) — back to no-warp baseline (" +
              nonNullAfter + " survivors w/ _isCustom=true)");
  return cleaned;
}

