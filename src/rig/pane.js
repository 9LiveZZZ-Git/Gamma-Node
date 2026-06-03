/* ---------- Phase 6.5 — rig props pane ---------- */
/* Shown when nothing is selected (the old "empty" placeholder slot).
 * Two sections: template picker + display list. The display list is
 * read-only in 6.5 MVP — each row shows the display's name + key
 * pose/FOV values. Per-display editing (drag yaw/pitch sliders, edit
 * FOV) lands in 6.5.15 (week 3 of the phase).
 *
 * Template change rebuilds rig.displays from RIG_TEMPLATES[key].
 * Existing VisualOutput nodes get their display index clamped to the
 * new display count if the new template has fewer displays. */
function renderRigPane() {
  const rig = state.rig || defaultRig();
  // Add a "Custom" option that's only selectable implicitly when the
  // user edits a display pose (the dropdown displays it but picking
  // it deliberately is a no-op — switching back to a real template
  // rebuilds the display list).
  const tplKeys = Object.keys(RIG_TEMPLATES);
  const isCustom = !tplKeys.includes(rig.templateKey);
  const tplOptions = tplKeys.map(k =>
    `<option value="${k}"${k === rig.templateKey ? " selected" : ""}>${escapeText(RIG_TEMPLATES[k].label)}</option>`
  ).join("") + (isCustom ? `<option value="custom" selected>Custom (edited)</option>` : "");

  const displayRows = rig.displays.map((d, i) => {
    const pose = d.pose || { yaw: 0, pitch: 0, roll: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    const eb   = d.edgeBlend || _defaultEdgeBlend();
    // Phase 6.6.4 — warp state pill. Three states cycle on click:
    //   off (no warp) → identity (mesh exists but no distortion) →
    //   test (sinusoidal bow distortion, used to verify the warp pass
    //   ships pixels). Real per-vertex editing comes in 6.6.9.
    const warpState = !d.warpMesh ? "off"
                     : (d.warpMesh._isTest      ? "test"
                     : (d.warpMesh._isAutoBlend ? "auto"
                     : (d.warpMesh._bezier && d.warpMesh._isCustom ? "bezier"
                     : (d.warpMesh._isCustom    ? "custom"
                     : (d.warpMesh._bezier      ? "bezier-id"
                     : "identity")))));
    const warpLabel = ({
      off:        "warp: off",
      identity:   "warp: identity",
      test:       "warp: test",
      auto:       "warp: auto-blend",
      custom:     "warp: custom",
      bezier:     "warp: bezier",
      "bezier-id":"warp: bezier (identity)"
    })[warpState];
    // Phase 6.6.10 — per-display edge-blend inputs. γ / lift / pow
    // sit on a sub-row below the pose/fov line, kept visually
    // distinct from the geometric controls so the calibration
    // domains don't blur together. Reset button drops back to
    // defaults (gamma 2.2, blackLift 0, power 2.0).
    const defaultEB = _defaultEdgeBlend();
    const isCustomBlend = eb.gamma     !== defaultEB.gamma     ||
                          eb.blackLift !== defaultEB.blackLift ||
                          eb.power     !== defaultEB.power;
    return `<div class="rig-display-row rig-display-row-edit" data-display-index="${i}">
      <span class="rig-display-idx">${i}</span>
      <span class="rig-display-name">${escapeText(d.name || ("Display " + (i + 1)))}</span>
      <span class="rig-edit-cluster">
        <label>yaw</label>
        <input type="number" class="rig-edit-input" data-field="pose.yaw"   value="${(+pose.yaw).toFixed(0)}" step="1" />
        <label>pitch</label>
        <input type="number" class="rig-edit-input" data-field="pose.pitch" value="${(+pose.pitch).toFixed(0)}" step="1" />
        <label>fovH</label>
        <input type="number" class="rig-edit-input" data-field="fov.h"      value="${(+fov.h).toFixed(0)}" step="1" min="1" max="360" />
        <label>fovV</label>
        <input type="number" class="rig-edit-input" data-field="fov.v"      value="${(+fov.v).toFixed(0)}" step="1" min="1" max="180" />
        <button class="rig-warp-btn rig-warp-${warpState}"
                data-display-warp-toggle="${i}"
                title="Cycle warp state (off → identity → test). Phase 6.6.4 placeholder for the warp editor.">${warpLabel}</button>
        <button class="rig-warp-edit-btn"
                data-display-warp-edit="${i}"
                title="Open the mesh warp editor — drag control points to deform the calibration.">✎ edit</button>
        <button class="rig-warp-edit-btn"
                data-display-warp-import="${i}"
                title="Import a Bourke-style warp mesh CSV (.csv) for this display. File format: header line, 'N M' grid dimensions, then N×M rows of 'x y u v intensity'.">⇪ import</button>
        <button class="rig-warp-edit-btn"
                data-display-warp-export="${i}"
                title="Export this display's warp mesh as a Bourke .csv file. Round-trips with our importer; readable by VIOSO, Resolume, blendmesher, and any tool that consumes Bourke mesh files.">⇩ export</button>
      </span>
      <span class="rig-edit-cluster rig-edit-cluster-blend${isCustomBlend ? " rig-edit-cluster-custom" : ""}" title="Edge-blend params. γ = gamma compensation; lift = black-floor lift; pow = power-curve steepness on the intensity ramp.">
        <label>γ</label>
        <input type="number" class="rig-edit-input"
               data-field="edgeBlend.gamma"
               value="${(+eb.gamma).toFixed(2)}" step="0.1" min="0.1" max="5" />
        <label>lift</label>
        <input type="number" class="rig-edit-input"
               data-field="edgeBlend.blackLift"
               value="${(+eb.blackLift).toFixed(2)}" step="0.05" min="0" max="1" />
        <label>pow</label>
        <input type="number" class="rig-edit-input"
               data-field="edgeBlend.power"
               value="${(+eb.power).toFixed(2)}" step="0.1" min="0.1" max="10" />
        <button class="rig-warp-btn rig-blend-reset-btn ${isCustomBlend ? "rig-blend-custom" : ""}"
                data-display-blend-reset="${i}"
                title="Reset blend (γ 2.2 / lift 0 / pow 2.0)"${isCustomBlend ? "" : " disabled"}>blend: ${isCustomBlend ? "custom ↺" : "default"}</button>
      </span>
    </div>`;
  }).join("");
  return `
    <div class="rig-pane">
      <div class="rig-pane-head">
        <span class="rig-pane-title">Display rig</span>
        <span class="rig-pane-sub">${rig.displays.length} display${rig.displays.length === 1 ? "" : "s"}</span>
      </div>
      <div class="rig-grid">
        <label for="rig-template-select">Template</label>
        <select id="rig-template-select">${tplOptions}</select>
        <label for="rig-preview-select">Preview</label>
        <select id="rig-preview-select">
          <option value="tile"${rig.previewMode === "tile" ? " selected" : ""}>Tiled flat</option>
          <option value="cylinder"${rig.previewMode === "cylinder" ? " selected" : ""}>Cylindrical unwrap</option>
          <option value="equirect"${rig.previewMode === "equirect" ? " selected" : ""}>Equirectangular</option>
          <option value="fisheye"${rig.previewMode === "fisheye" ? " selected" : ""}>Stereographic / fisheye</option>
          <option value="theater"${rig.previewMode === "theater" ? " selected" : ""}>Theater (3D explorable)</option>
        </select>
        <label for="rig-shader-yaw" title="Where the shader's content center lands in world yaw degrees. 0 = no shift.">Center yaw</label>
        <input type="number" id="rig-shader-yaw" class="rig-grid-input" value="${(+(rig.shaderCenterYaw || 0)).toFixed(0)}" step="1" />
        <label for="rig-shader-pitch" title="Where the shader's content center lands in world pitch degrees. 0 = no shift.">Center pitch</label>
        <input type="number" id="rig-shader-pitch" class="rig-grid-input" value="${(+(rig.shaderCenterPitch || 0)).toFixed(0)}" step="1" />
      </div>
      ${(() => {
        // Phase 6.6.14 — screen surface + sweet-spot UI. Type dropdown
        // changes which params show below; sweet-spot is always 3 inputs
        // with a "from surface" reset button.
        const surf = rig.surface || { type: "free" };
        const ss   = Array.isArray(rig.sweetSpot) ? rig.sweetSpot : [0, 0, 0];
        const surfTypeOpts = [
          ["sphere",   "Sphere"],
          ["cylinder", "Cylinder"],
          ["plane",    "Plane"],
          ["swept",    "Swept (truncated dome / partial cylinder)"],
          ["free",     "Free / Custom"]
        ].map(([k, l]) => `<option value="${k}"${surf.type === k ? " selected" : ""}>${l}</option>`).join("");
        let surfParamsHtml = "";
        if (surf.type === "sphere") {
          surfParamsHtml = `
            <label title="Sphere radius — the audience sits inside; theater camera spawns at the center.">Radius</label>
            <input type="number" id="rig-surf-radius" class="rig-grid-input" value="${(+surf.radius).toFixed(2)}" step="0.5" min="0.5" />
          `;
        } else if (surf.type === "cylinder") {
          surfParamsHtml = `
            <label title="Cylinder radius (horizontal extent of curve).">Radius</label>
            <input type="number" id="rig-surf-radius" class="rig-grid-input" value="${(+surf.radius).toFixed(2)}" step="0.5" min="0.5" />
            <label title="Cylinder length along its axis.">Length</label>
            <input type="number" id="rig-surf-length" class="rig-grid-input" value="${(+surf.length).toFixed(2)}" step="0.5" min="0.5" />
          `;
        } else if (surf.type === "plane") {
          surfParamsHtml = `
            <label title="Distance from the audience to the screen along the plane normal.">Offset</label>
            <input type="number" id="rig-surf-offset" class="rig-grid-input" value="${(+surf.offset).toFixed(2)}" step="0.5" min="0.5" />
          `;
        } else if (surf.type === "swept") {
          // Phase 6.6.20 — swept surface (Sajadi & Majumder 2012).
          // Profile is either a circular arc (pitch range) or a
          // vertical line (yMin/yMax). Path is a yaw range. Preset
          // buttons fill in sensible defaults for common shapes.
          const prof = surf.profile || { kind: "arc", radius: 5, pitchStart: -90, pitchEnd: 90 };
          const path = surf.path    || { kind: "revolution", yawStart: -180, yawEnd: 180 };
          const presetButtons = `
            <span class="rig-swept-presets">
              <button class="btn rig-swept-preset" data-swept-preset="alloSphere"    title="UCSB AlloSphere — full 360° yaw, pitch ±85°. Aligns with the 'AlloSphere (real 26-projector layout)' rig template so coverage-aware capture filters keep front/back/left/right cardinals.">AlloSphere</button>
              <button class="btn rig-swept-preset" data-swept-preset="truncatedDome160" title="Sajadi-Majumder TVCG 2012 §6 truncated dome — 30ft radius, 26ft height, 160° horizontal. Different from UCSB AlloSphere; this is the paper's test installation.">Truncated dome 160°</button>
              <button class="btn rig-swept-preset" data-swept-preset="fullSphere"    title="Full sphere of revolution: pitch -90°→90°, yaw ±180°.">Full sphere</button>
              <button class="btn rig-swept-preset" data-swept-preset="dome"          title="Top hemisphere: pitch 0°→90°, full yaw.">Dome</button>
              <button class="btn rig-swept-preset" data-swept-preset="bowl"          title="Bottom hemisphere: pitch -90°→0°, full yaw.">Bowl</button>
              <button class="btn rig-swept-preset" data-swept-preset="truncatedDome" title="Sphere with polar caps cut: pitch -15°→75°, full yaw.">Truncated dome</button>
              <button class="btn rig-swept-preset" data-swept-preset="cylinderArc"   title="180° front-facing arc of a cylinder: vertical profile, yaw ±90°.">Cylinder arc</button>
            </span>
          `;
          const profileKindOpts = [
            ["arc",      "Arc (sphere segment)"],
            ["vertical", "Vertical (cylinder segment)"]
          ].map(([k, l]) => `<option value="${k}"${prof.kind === k ? " selected" : ""}>${l}</option>`).join("");
          const profileParams = (prof.kind === "vertical")
            ? `
              <label title="Cylinder radius — distance from the +Y axis to the surface.">Radius</label>
              <input type="number" id="rig-swept-radius" class="rig-grid-input" value="${(+prof.radius).toFixed(2)}" step="0.5" min="0.5" />
              <label title="Bottom of the cylinder (Y world coordinate).">Y min</label>
              <input type="number" id="rig-swept-ymin" class="rig-grid-input" value="${(+prof.yMin).toFixed(2)}" step="0.5" />
              <label title="Top of the cylinder (Y world coordinate).">Y max</label>
              <input type="number" id="rig-swept-ymax" class="rig-grid-input" value="${(+prof.yMax).toFixed(2)}" step="0.5" />
            `
            : `
              <label title="Sphere radius (also = radius at the equator).">Radius</label>
              <input type="number" id="rig-swept-radius" class="rig-grid-input" value="${(+prof.radius).toFixed(2)}" step="0.5" min="0.5" />
              <label title="Lower pitch boundary in degrees. -90 = south pole, 0 = equator, +90 = north pole.">Pitch min</label>
              <input type="number" id="rig-swept-pitch-start" class="rig-grid-input" value="${(+prof.pitchStart).toFixed(0)}" step="5" min="-90" max="90" />
              <label title="Upper pitch boundary in degrees.">Pitch max</label>
              <input type="number" id="rig-swept-pitch-end" class="rig-grid-input" value="${(+prof.pitchEnd).toFixed(0)}" step="5" min="-90" max="90" />
            `;
          surfParamsHtml = `
            <label title="Quick presets for common swept-surface shapes. Each fills in the parameters below — refine afterward.">Preset</label>
            ${presetButtons}
            <label title="Profile shape that is swept around the +Y axis. Arc = sphere segment, Vertical = cylinder segment.">Profile</label>
            <select id="rig-swept-profile-kind">${profileKindOpts}</select>
            ${profileParams}
            <label title="Yaw start in degrees. -180 = back, 0 = front, +180 = back. Full revolution: -180 to +180.">Yaw start</label>
            <input type="number" id="rig-swept-yaw-start" class="rig-grid-input" value="${(+path.yawStart).toFixed(0)}" step="10" min="-360" max="360" />
            <label title="Yaw end in degrees. yawEnd > yawStart.">Yaw end</label>
            <input type="number" id="rig-swept-yaw-end"   class="rig-grid-input" value="${(+path.yawEnd).toFixed(0)}"   step="10" min="-360" max="360" />
          `;
        }
        const surfVisible = rig.surfaceVisible !== false;
        return `
          <div class="rig-grid rig-grid-surface">
            <label for="rig-surface-type" title="Physical screen geometry. Used by theater preview for sweet-spot, and by 6.6.14+ auto-warp for analytic geometry correction.">Screen</label>
            <select id="rig-surface-type">${surfTypeOpts}</select>
            ${surfParamsHtml}
            <label title="When ON, the rig is treated as a curved screen (auto-warp + gizmo viz active). When OFF, the rig is treated as flat monitors at the display poses (auto-warp falls through to identity, gizmo skips screen drawing). Default ON; toggle off for VJ wraparound LED-wall installs where each panel is its own monitor.">Screen on</label>
            <span class="rig-surf-toggle">
              <label class="rig-surf-toggle-label">
                <input type="checkbox" id="rig-surface-visible"${surfVisible ? " checked" : ""}>
                <span>${surfVisible ? "treating as physical screen" : "treating as monitors"}</span>
              </label>
            </span>
          </div>
          <div class="rig-grid rig-grid-sweet-spot">
            <label title="The audience-position the rig is calibrated for. Theater camera spawns here on rig change / patch load.">Sweet spot</label>
            <span class="rig-sweet-spot-inputs">
              <input type="number" id="rig-sweet-spot-x" class="rig-grid-input" value="${(+ss[0]).toFixed(2)}" step="0.1" title="X" />
              <input type="number" id="rig-sweet-spot-y" class="rig-grid-input" value="${(+ss[1]).toFixed(2)}" step="0.1" title="Y" />
              <input type="number" id="rig-sweet-spot-z" class="rig-grid-input" value="${(+ss[2]).toFixed(2)}" step="0.1" title="Z" />
              <button class="rig-sweet-spot-btn" id="btn-rig-sweet-from-surface" title="Re-derive the sweet-spot from the current screen surface (sphere center / cylinder midpoint / plane offset).">↻ from surface</button>
              <button class="rig-sweet-spot-btn" id="btn-rig-camera-reset" title="Reset the theater-mode camera to the current sweet-spot position.">⟲ camera</button>
            </span>
          </div>
        `;
      })()}
      <div class="rig-display-list">
        <div class="rig-display-list-head">
          <span>Displays (yaw / pitch / fov in degrees)</span>
          <span class="rig-display-list-actions">
            <button class="rig-auto-blend-btn" id="btn-rig-mpcdi-import"
                    title="Import an MPCDI bundle (.mpcdi or .zip) — replaces the rig with the displays defined in the manifest. Geometry (pose/fov) imports now; per-display warp PFM + alpha-map PNG import ships in 6.6.2b.">Import MPCDI…</button>
            <button class="rig-auto-blend-btn" id="btn-rig-mpcdi-export"
                    title="Export the whole rig as an MPCDI ZIP bundle — mpcdi.xml + per-display Bourke warp CSVs. Round-trips with our importer; for full external compatibility (PFM warp output) wait for 6.6.3b.">Export MPCDI…</button>
            <button class="rig-auto-blend-btn" id="btn-rig-auto-warp"
                    title="Per Raskar §3.3 — analytically derive a per-display warp mesh from the rig's screen surface + sweet-spot. ⚠ ONLY USE FOR FLAT-UV CONTENT (photographs, video, custom .gdsp shaders that don't use angular math). The built-in Checkerboard / Voronoi / NoiseShader / Plasma all already render in angular (yaw, pitch) space — they're correctly sphere-projected without warp, and adding auto-warp produces double-correction artifacts. Phase 7's video / texture nodes are the canonical use case.">Auto-warp screen</button>
            <button class="rig-auto-blend-btn" id="btn-rig-warp-reset"
                    title="Clear all displays' warp meshes in one click — useful for recovering from an accidental Auto-warp on angular shaders. Custom (hand-edited) meshes are preserved.">Reset warps</button>
            <button class="rig-auto-blend-btn" id="btn-rig-auto-blend"
                    title="Auto-generate intensity ramps so adjacent projectors blend seamlessly. Two algorithms used depending on rig: angular bands (when surface is plane / free / off — fast, works for flat tile rigs) and Raskar §4.4 screen-space alpha-blend (when surface is sphere / cylinder + visible ON — α sums to 1.0 across overlapping projectors at every screen point, correct for curved screens).">Auto-blend rig</button>
            <button class="rig-auto-blend-btn" id="btn-rig-auto-blend-hardcuts"
                    title="Hard-cut blend (no smooth ramps): each screen pixel comes from EXACTLY ONE projector — the one whose framebuffer puts that pixel furthest from its frame edge. Voronoi-style assignment in screen space. Useful for calibration debugging (you can see which projector covers what), and for installations where smooth blending isn't possible (sharp masks, hard-edge LED panels). Requires curved screen surface (sphere/cylinder/swept) with surfaceVisible ON.">Auto-blend (hard cuts)</button>
            <button class="rig-auto-blend-btn" id="btn-rig-auto-capture"
                    title="Auto-capture calibration: switch to theater preview, position camera at sweet spot, take screenshots looking in 6 cardinal directions (front / back / left / right / up / down). If a Checkerboard node is wired, cycles its mode 0..4 between snapshots (HEALPix / Lambert / Cube / Octahedral / Cosine lat-long). Downloads a ZIP bundle with the PNGs + a JSON metadata file describing the rig. Use with WireframeCalibration + Auto-blend (hard cuts) to verify projector calibration visually.">Auto-capture calibration</button>
            <button class="rig-auto-blend-btn" id="btn-rig-ai-reset"
                    title="Reset all AI calibration corrections to a clean baseline. Zeros keystoneCorners + drops bezierCorrections on every display, then re-runs Auto-warp + Auto-blend so the visible mesh matches the clean state. Pose/FOV not reverted (re-pick the rig template for that). Custom hand-edited warps preserved.">Reset AI corrections</button>
            <button class="rig-auto-blend-btn" id="btn-rig-ai-calibrate"
                    title="AI calibration v2 (iterative converge): runs up to 5 passes, capping per-pass deltas at ±0.5° per axis. Each pass captures, sends to Anthropic/Gemma vision, applies clamped corrections, recaptures. Stops when mean delta drops below 0.15° OR after 5 passes. Final modal lets you review the CUMULATIVE baseline-to-current diff and uncheck any projector you want reverted. Wire WireframeCalibration to your VisualOutputs first; AI key set in the User DSP tab → ⚙ Settings.">AI calibrate rig…</button>
          </span>
        </div>
        ${displayRows}
      </div>
      <p class="modal-note" style="margin-top: 14px;">
        Wire a shader's texture output into a VisualOutput node and pick its display index in that node's properties. Multiple VisualOutput nodes wired to the same shader render the same image SHARED across their displays. <strong>Center yaw / pitch</strong> rotate the shader's content within the rig — useful for placing a focal point (e.g. the pinwheel's center) anywhere along a 360° wraparound.
      </p>
    </div>
  `;
}

function wireRigPaneHandlers() {
  const tpl = document.getElementById("rig-template-select");
  if (tpl) {
    tpl.addEventListener("change", () => {
      applyRigTemplate(tpl.value);
    });
  }
  const pv = document.getElementById("rig-preview-select");
  if (pv) {
    pv.addEventListener("change", () => {
      pushHistory("rig-preview:" + pv.value);
      if (!state.rig) state.rig = defaultRig();
      state.rig.previewMode = pv.value;
      // Keep the visual HUD's projection pill in sync with this
      // dropdown — the two control the same state.
      if (typeof _updateProjectionPill === "function") _updateProjectionPill();
      render();
    });
  }

  // Phase 6.5.15+ — global shader-center yaw/pitch.
  const sy = document.getElementById("rig-shader-yaw");
  if (sy) {
    sy.addEventListener("input", () => {
      const v = parseFloat(sy.value);
      if (!isFinite(v)) return;
      pushHistory("rig-shader-yaw");
      if (!state.rig) state.rig = defaultRig();
      state.rig.shaderCenterYaw = v;
      render();
    });
  }
  const sp = document.getElementById("rig-shader-pitch");
  if (sp) {
    sp.addEventListener("input", () => {
      const v = parseFloat(sp.value);
      if (!isFinite(v)) return;
      pushHistory("rig-shader-pitch");
      if (!state.rig) state.rig = defaultRig();
      state.rig.shaderCenterPitch = v;
      render();
    });
  }

  // Phase 6.6.14 — screen surface type dropdown + per-type params.
  // Type change rebuilds the surface object with sensible defaults
  // for that type (and re-renders the pane so the param inputs
  // match). Param changes mutate in place + render().
  const surfType = document.getElementById("rig-surface-type");
  if (surfType) {
    surfType.addEventListener("change", () => {
      pushHistory("rig-surface-type:" + surfType.value);
      if (!state.rig) state.rig = defaultRig();
      const t = surfType.value;
      if (t === "sphere")        state.rig.surface = { type: "sphere",   radius: 5,    center: [0, 0, 0] };
      else if (t === "cylinder") state.rig.surface = { type: "cylinder", radius: 5,    axis: [0, 1, 0], length: 5, center: [0, 0, 0] };
      else if (t === "plane")    state.rig.surface = { type: "plane",    normal: [0, 0, 1], offset: 5 };
      else if (t === "swept")    state.rig.surface = _sweptSurfacePreset("alloSphere", 5);
      else                       state.rig.surface = { type: "free" };
      state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface);
      renderProps && renderProps();
      render();
    });
  }
  const surfRadius = document.getElementById("rig-surf-radius");
  if (surfRadius) {
    surfRadius.addEventListener("input", () => {
      const v = parseFloat(surfRadius.value);
      if (!isFinite(v) || v <= 0) return;
      pushHistory("rig-surface-radius");
      if (state.rig && state.rig.surface) state.rig.surface.radius = v;
      render();
    });
  }
  const surfLength = document.getElementById("rig-surf-length");
  if (surfLength) {
    surfLength.addEventListener("input", () => {
      const v = parseFloat(surfLength.value);
      if (!isFinite(v) || v <= 0) return;
      pushHistory("rig-surface-length");
      if (state.rig && state.rig.surface) state.rig.surface.length = v;
      render();
    });
  }
  const surfOffset = document.getElementById("rig-surf-offset");
  if (surfOffset) {
    surfOffset.addEventListener("input", () => {
      const v = parseFloat(surfOffset.value);
      if (!isFinite(v) || v <= 0) return;
      pushHistory("rig-surface-offset");
      if (state.rig && state.rig.surface) state.rig.surface.offset = v;
      render();
    });
  }

  // Phase 6.6.20 — swept-surface controls. Preset buttons fully
  // replace the surface object (and re-render the pane to match);
  // numeric inputs mutate in place + re-render() the visualization.
  document.querySelectorAll(".rig-swept-preset").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const name = btn.dataset.sweptPreset;
      if (!name) return;
      pushHistory("rig-swept-preset:" + name);
      if (!state.rig) state.rig = defaultRig();
      // Preserve scale across presets if the user has already set
      // a non-default radius (5).
      const curR = (state.rig.surface && state.rig.surface.profile && state.rig.surface.profile.radius) || 5;
      state.rig.surface = _sweptSurfacePreset(name, curR);
      state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface);
      renderProps && renderProps();
      render();
    });
  });
  const sweptKind = document.getElementById("rig-swept-profile-kind");
  if (sweptKind) {
    sweptKind.addEventListener("change", () => {
      pushHistory("rig-swept-profile-kind:" + sweptKind.value);
      if (!state.rig || !state.rig.surface || state.rig.surface.type !== "swept") return;
      const surf = state.rig.surface;
      const curR = (surf.profile && surf.profile.radius) || 5;
      surf.profile = (sweptKind.value === "vertical")
        ? { kind: "vertical", radius: curR, yMin: -curR * 0.5, yMax: curR * 0.5 }
        : { kind: "arc",      radius: curR, pitchStart: -90, pitchEnd: 90 };
      renderProps && renderProps();
      render();
    });
  }
  // Numeric input wiring — generic (id → mutator) table avoids 7
  // near-identical handlers.
  const sweptInputs = [
    ["rig-swept-radius",      "profile", "radius",     v => v > 0],
    ["rig-swept-ymin",        "profile", "yMin",       () => true],
    ["rig-swept-ymax",        "profile", "yMax",       () => true],
    ["rig-swept-pitch-start", "profile", "pitchStart", v => v >= -90 && v <= 90],
    ["rig-swept-pitch-end",   "profile", "pitchEnd",   v => v >= -90 && v <= 90],
    ["rig-swept-yaw-start",   "path",    "yawStart",   v => v >= -360 && v <= 360],
    ["rig-swept-yaw-end",     "path",    "yawEnd",     v => v >= -360 && v <= 360]
  ];
  for (const [id, branch, key, accept] of sweptInputs) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      if (!isFinite(v) || !accept(v)) return;
      pushHistory("rig-swept-" + key);
      if (!state.rig || !state.rig.surface || state.rig.surface.type !== "swept") return;
      if (!state.rig.surface[branch]) state.rig.surface[branch] = {};
      state.rig.surface[branch][key] = v;
      render();
    });
  }

  // Phase 6.6.14 — sweet-spot manual edit (X/Y/Z) + the two action
  // pills (re-derive from surface, reset theater camera).
  ["x", "y", "z"].forEach((axis, i) => {
    const inp = document.getElementById("rig-sweet-spot-" + axis);
    if (!inp) return;
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (!isFinite(v)) return;
      pushHistory("rig-sweet-spot");
      if (!state.rig) state.rig = defaultRig();
      if (!Array.isArray(state.rig.sweetSpot)) state.rig.sweetSpot = [0, 0, 0];
      state.rig.sweetSpot[i] = v;
      render();
    });
  });
  const fromSurfBtn = document.getElementById("btn-rig-sweet-from-surface");
  if (fromSurfBtn) {
    fromSurfBtn.addEventListener("click", () => {
      pushHistory("rig-sweet-from-surface");
      if (!state.rig) state.rig = defaultRig();
      state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface || { type: "free" });
      renderProps && renderProps();
      render();
    });
  }
  const camResetBtn = document.getElementById("btn-rig-camera-reset");
  if (camResetBtn) {
    camResetBtn.addEventListener("click", () => {
      if (Visual && Visual.theaterCam && state.rig && Array.isArray(state.rig.sweetSpot)) {
        Visual.theaterCam.pos[0] = state.rig.sweetSpot[0];
        Visual.theaterCam.pos[1] = state.rig.sweetSpot[1];
        Visual.theaterCam.pos[2] = state.rig.sweetSpot[2];
        Visual.theaterCam.yaw   = 0;
        Visual.theaterCam.pitch = 0;
      }
    });
  }

  // Phase 6.6.15 — screen-visible toggle. When ON the rig is a
  // curved screen (auto-warp + gizmo viz active). When OFF treat
  // as flat monitors (auto-warp falls through, gizmo skips surface).
  const surfVisCb = document.getElementById("rig-surface-visible");
  if (surfVisCb) {
    surfVisCb.addEventListener("change", () => {
      pushHistory("rig-surface-visible:" + surfVisCb.checked);
      if (!state.rig) state.rig = defaultRig();
      state.rig.surfaceVisible = surfVisCb.checked;
      renderProps && renderProps();
      render();
    });
  }

  // Phase 6.6.15 — Auto-warp screen button. Fires only when surface
  // is sphere/cylinder + surfaceVisible is on. Custom meshes are
  // preserved (same idiom as Auto-blend).
  //
  // Confirms before applying: auto-warp produces visible distortion
  // when applied to angular-aware shaders (Checkerboard / Voronoi /
  // NoiseShader / Plasma — anything in 6.4 polish onward) because
  // those shaders already render correctly for the sphere geometry.
  // Auto-warp is meaningful for flat-UV content — coming with the
  // Phase 7 VideoFile / Webcam / Texture nodes.
  const autoWarpBtn = document.getElementById("btn-rig-auto-warp");
  if (autoWarpBtn) {
    autoWarpBtn.addEventListener("click", () => {
      const ok = (typeof confirm === "function")
        ? confirm("Auto-warp is for FLAT-UV content (photos, video, custom shaders).\n\n" +
                  "The built-in Checkerboard, Voronoi, NoiseShader, and Plasma already render in angular space — adding auto-warp produces visible double-correction distortion.\n\n" +
                  "Apply anyway?")
        : true;
      if (!ok) return;
      const results = _applyAutoWarpToRig();
      if (results.length) {
        const applied = results.filter(r => r.applied).length;
        const skipped = results.length - applied;
        autoWarpBtn.textContent = applied + " warped";
        autoWarpBtn.disabled = true;
        setTimeout(() => {
          autoWarpBtn.textContent = "Auto-warp screen";
          autoWarpBtn.disabled = false;
        }, 900);
        console.log("[auto-warp] applied to", applied, "displays;", skipped, "skipped (custom)");
        renderProps && renderProps();
        render();
      }
    });
  }

  // Phase 6.6.15 — Reset warps button. Clears every display's
  // auto-warp / identity / test mesh in one click while preserving
  // user-edited (custom) meshes. Recovery path for accidental
  // auto-warp on angular shaders.
  const resetWarpsBtn = document.getElementById("btn-rig-warp-reset");
  if (resetWarpsBtn) {
    resetWarpsBtn.addEventListener("click", () => {
      if (!state.rig || !Array.isArray(state.rig.displays)) return;
      let cleared = 0, kept = 0;
      pushHistory("rig-warp-reset");
      state.rig.displays.forEach(d => {
        if (!d) return;
        if (d.warpMesh && d.warpMesh._isCustom) { kept++; return; }
        if (d.warpMesh) {
          d.warpMesh = null;
          if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
          cleared++;
        }
      });
      console.log("[warp-reset] cleared", cleared, "displays;", kept, "custom meshes preserved");
      renderProps && renderProps();
      render();
    });
  }

  // Phase 6.5.15 — per-display pose / fov editing. Each input has
  // data-field=pose.yaw / pose.pitch / fov.h / fov.v; the parent
  // .rig-display-row carries data-display-index. On any change,
  // patch state.rig.displays[i] and switch templateKey to a custom
  // marker so the dropdown shows we've diverged from the preset.
  // No re-render of the rig pane on every keystroke (would steal
  // focus from the input mid-edit) — just call render() to repaint
  // the visual canvas. The pane re-renders on next deselection.
  // Phase 6.6.4 — warp-state toggle on each display row.
  // Cycle: off (null) → identity → test (sin-bow) → off …
  document.querySelectorAll('[data-display-warp-toggle]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayWarpToggle, 10);
      const display = state.rig && state.rig.displays && state.rig.displays[i];
      if (!display) return;
      const cur = !display.warpMesh ? "off"
                : (display.warpMesh._isTest      ? "test"
                : (display.warpMesh._isAutoBlend ? "auto"
                : (display.warpMesh._isCustom    ? "custom"
                : "identity")));
      // Custom meshes hold the user's hand-editing work — we don't
      // want a casual pill click to silently clobber them with a test
      // bow. Confirm before discarding. User can also use the editor's
      // Reset button (less ambiguous path).
      if (cur === "custom") {
        const ok = (typeof confirm === "function")
          ? confirm("Discard your custom warp on display " + i + "?\n\nClick the ✎ edit pill instead if you want to keep editing.")
          : true;
        if (!ok) return;
      }
      pushHistory("rig-warp-toggle:" + i);
      // Cycle: off → identity → test → off. Auto-blend / custom both
      // live outside this cycle (set by other paths); clicking the pill
      // on either drops back to off cleanly.
      const next = cur === "off"      ? "identity"
                 : cur === "identity" ? "test"
                 : cur === "test"     ? "off"
                 : "off";   // auto / custom both clear to off
      if (next === "off")           display.warpMesh = null;
      else if (next === "identity") display.warpMesh = _makeIdentityWarpMesh(8, 8);
      else                          display.warpMesh = _makeTestWarpMesh(8, 8);
      // Drop the cached GPU buffers so the next frame rebuilds with
      // the new mesh dimensions / contents.
      if (Visual && Visual._warpCache) Visual._warpCache.delete(display.id);
      // Mark as customized so the template dropdown doesn't pretend
      // we're still on the preset.
      if (state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
        state.rig.templateKey = "custom";
      }
      renderProps && renderProps();
      render();
    });
  });

  document.querySelectorAll('.rig-edit-input').forEach(input => {
    input.addEventListener("input", () => {
      const row = input.closest(".rig-display-row");
      if (!row) return;
      const i = parseInt(row.dataset.displayIndex, 10);
      if (!isFinite(i)) return;
      const display = state.rig && state.rig.displays && state.rig.displays[i];
      if (!display) return;
      const v = parseFloat(input.value);
      if (!isFinite(v)) return;
      const field = input.dataset.field;
      pushHistory("rig-display-edit:" + i + ":" + field);
      if (field === "pose.yaw")   { display.pose = display.pose || {}; display.pose.yaw   = v; }
      else if (field === "pose.pitch") { display.pose = display.pose || {}; display.pose.pitch = v; }
      else if (field === "fov.h")  { display.fov  = display.fov  || {}; display.fov.h  = v; }
      else if (field === "fov.v")  { display.fov  = display.fov  || {}; display.fov.v  = v; }
      // Phase 6.6.10 — edge-blend params. Each is range-clamped:
      // gamma must be > 0 (avoid divide-by-zero in 1/g); blackLift
      // is in [0, 1] (above 1 saturates the whole image); power is
      // > 0 (controls the steepness of the symmetric ramp).
      else if (field === "edgeBlend.gamma") {
        display.edgeBlend = display.edgeBlend || _defaultEdgeBlend();
        display.edgeBlend.gamma = Math.max(0.1, Math.min(5, v));
      }
      else if (field === "edgeBlend.blackLift") {
        display.edgeBlend = display.edgeBlend || _defaultEdgeBlend();
        display.edgeBlend.blackLift = Math.max(0, Math.min(1, v));
      }
      else if (field === "edgeBlend.power") {
        display.edgeBlend = display.edgeBlend || _defaultEdgeBlend();
        display.edgeBlend.power = Math.max(0.1, Math.min(10, v));
      }
      // Mark rig as customized so the template dropdown reflects the
      // edit instead of pretending we're still on the preset.
      if (Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
        state.rig.templateKey = "custom";
      }
      render();
    });
  });

  // Phase 6.6.9 — open the mesh warp editor for a specific display.
  // Wires the editor's controls/canvas once on first call (idempotent).
  document.querySelectorAll('[data-display-warp-edit]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayWarpEdit, 10);
      if (!Number.isFinite(i)) return;
      _wireWarpEditor();
      openWarpEditor(i);
    });
  });

  // Phase 6.6.2 — per-display Bourke-CSV warp-mesh import.
  document.querySelectorAll('[data-display-warp-import]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayWarpImport, 10);
      if (!Number.isFinite(i)) return;
      importBourkeMeshForDisplay(i);
    });
  });

  // Phase 6.6.3 — per-display Bourke-CSV warp-mesh export.
  document.querySelectorAll('[data-display-warp-export]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayWarpExport, 10);
      if (!Number.isFinite(i)) return;
      exportBourkeMeshForDisplay(i);
    });
  });

  // Phase 6.6.2 — whole-rig MPCDI bundle import.
  const mpcdiBtn = document.getElementById("btn-rig-mpcdi-import");
  if (mpcdiBtn) {
    mpcdiBtn.addEventListener("click", () => {
      importMpcdiBundle();
    });
  }

  // Phase 6.6.3 — whole-rig MPCDI bundle export.
  const mpcdiExpBtn = document.getElementById("btn-rig-mpcdi-export");
  if (mpcdiExpBtn) {
    mpcdiExpBtn.addEventListener("click", () => {
      exportMpcdiBundle();
    });
  }

  // Phase 6.6.11 — global "Auto-blend rig" button. Runs overlap
  // detection across all displays + sets warpMesh to per-display
  // auto-generated intensity ramps. Re-renders so the warp pills
  // flip to "warp: auto-blend" on every affected display.
  const autoBtn = document.getElementById("btn-rig-auto-blend");
  if (autoBtn) {
    autoBtn.addEventListener("click", () => {
      const results = _applyAutoBlendToRig();
      const applied = results.filter(r => r.applied).length;
      const skipped = results.length - applied;
      autoBtn.textContent = applied + " blended";
      autoBtn.disabled = true;
      setTimeout(() => {
        autoBtn.textContent = "Auto-blend rig";
        autoBtn.disabled = false;
      }, 900);
      console.log("[auto-blend] applied to", applied, "displays;", skipped, "left as-is (no overlap)");
      renderProps && renderProps();
      render();
    });
  }

  // Phase 6.6.20.21 — Reset AI corrections button. Zeros all
  // keystoneCorners + bezierCorrections, re-bakes clean meshes.
  const aiResetBtn = document.getElementById("btn-rig-ai-reset");
  if (aiResetBtn) {
    aiResetBtn.addEventListener("click", () => {
      const cleaned = resetAICalibration();
      if (cleaned >= 0) {
        const orig = aiResetBtn.textContent;
        aiResetBtn.textContent = "Cleaned " + cleaned + " display(s)";
        aiResetBtn.disabled = true;
        setTimeout(() => {
          aiResetBtn.textContent = orig;
          aiResetBtn.disabled = false;
        }, 1500);
      }
    });
  }

  // Phase 6.6.20.10 — AI calibration button. Captures per-display +
  // sends to AI provider + diff modal + apply.
  const aiCalibBtn = document.getElementById("btn-rig-ai-calibrate");
  if (aiCalibBtn) {
    aiCalibBtn.addEventListener("click", async () => {
      if (aiCalibBtn.disabled) return;
      const orig = aiCalibBtn.textContent;
      aiCalibBtn.disabled = true;
      try {
        const result = await runAICalibrationFlow({
          onStatus: (msg) => { aiCalibBtn.textContent = msg; }
        });
        aiCalibBtn.textContent = "Applied " + result.applied + " corrections";
      } catch (e) {
        console.error("[ai-calibrate] failed:", e);
        aiCalibBtn.textContent = "Failed";
        alert("AI calibration failed:\n\n" + (e && e.message ? e.message : String(e)));
      } finally {
        setTimeout(() => {
          aiCalibBtn.textContent = orig;
          aiCalibBtn.disabled = false;
        }, 2200);
      }
    });
  }

  // Phase 6.6.20.8 — auto-capture calibration button. Walks 6
  // cardinal directions in theater mode, optionally cycles
  // Checkerboard.mode, downloads ZIP bundle of PNGs + metadata.
  const captureBtn = document.getElementById("btn-rig-auto-capture");
  if (captureBtn) {
    captureBtn.addEventListener("click", async () => {
      if (captureBtn.disabled) return;
      const origLabel = captureBtn.textContent;
      captureBtn.disabled = true;
      captureBtn.textContent = "Capturing 0/?...";
      try {
        const result = await autoCaptureCalibration({
          onProgress: (cur, total) => {
            captureBtn.textContent = "Capturing " + cur + "/" + total + "...";
          }
        });
        captureBtn.textContent = "Saved (" + result.captured + ")";
      } catch (e) {
        console.error("[auto-capture] failed:", e);
        captureBtn.textContent = "Failed";
        alert("Auto-capture failed:\n\n" + (e && e.message ? e.message : String(e)));
      } finally {
        setTimeout(() => {
          captureBtn.textContent = origLabel;
          captureBtn.disabled = false;
        }, 1800);
      }
    });
  }

  // Phase 6.6.20.6 — hard-cuts variant. Each screen pixel goes to
  // exactly one projector. Same dispatch as smooth blend but flags
  // the path with hardCuts:true.
  const autoHardBtn = document.getElementById("btn-rig-auto-blend-hardcuts");
  if (autoHardBtn) {
    autoHardBtn.addEventListener("click", () => {
      const results = _applyAutoBlendToRig({ hardCuts: true });
      const applied = results.filter(r => r.applied).length;
      const skipped = results.length - applied;
      autoHardBtn.textContent = applied + " hard-cut";
      autoHardBtn.disabled = true;
      setTimeout(() => {
        autoHardBtn.textContent = "Auto-blend (hard cuts)";
        autoHardBtn.disabled = false;
      }, 900);
      console.log("[auto-blend hardcuts] applied to", applied, "displays;", skipped, "skipped");
      renderProps && renderProps();
      render();
    });
  }

  // Phase 6.6.10 — edge-blend reset button. Drops the display's
  // edgeBlend back to defaults (gamma 2.2, blackLift 0, power 2.0)
  // and re-renders the row so the disabled state on the button
  // reflects the now-pristine values.
  document.querySelectorAll('[data-display-blend-reset]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.displayBlendReset, 10);
      const display = state.rig && state.rig.displays && state.rig.displays[i];
      if (!display) return;
      pushHistory("rig-blend-reset:" + i);
      display.edgeBlend = _defaultEdgeBlend();
      if (Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
        state.rig.templateKey = "custom";
      }
      renderProps && renderProps();
      render();
    });
  });
}

