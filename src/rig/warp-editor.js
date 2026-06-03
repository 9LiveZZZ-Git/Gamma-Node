/* ------------ Phase 6.6.9 — mesh warp editor state + helpers ----------- */

/* Editor state. Mesh edits mutate display.warpMesh.verts in place
 * so the live preview picks up changes on the next frame; the
 * GPU-cache invalidation hook (Visual._warpCache.delete) fires
 * after each drag so the warp pipeline rebuilds its vertex buffer
 * with the new positions. originalMesh is a deep clone snapshot
 * for Cancel — restores the pre-edit state if the user backs out. */
const _warpEditor = {
  open: false,
  displayIdx: -1,
  originalMesh: null,
  // Per-frame interaction state.
  draggedVertex: -1,    // index into mesh.verts; -1 = none
  hoverVertex:   -1
};

/* Resample a Bourke mesh to a different resolution while preserving
 * its current deformation. Each new vertex (r', c') in [0,1]² takes
 * its (mx, my) NDC position by bilinear interpolation of the four
 * surrounding old vertices. UV stays uniform (u' = c'/cols', v' =
 * r'/rows') since UV is the source-content mapping, not the warp.
 * Intensity carries over by bilinear interpolation too — handy when
 * a user has hand-painted blend ramps and wants finer control points
 * without losing the gradient. */
function _resampleWarpMesh(oldMesh, newCols, newRows) {
  const fresh = _makeIdentityWarpMesh(newCols, newRows);
  if (!_validateWarpMesh(oldMesh)) return fresh;
  const oW = oldMesh.cols + 1, oH = oldMesh.rows + 1;
  const nW = newCols + 1, nH = newRows + 1;
  for (let nr = 0; nr < nH; nr++) {
    for (let nc = 0; nc < nW; nc++) {
      const u = nc / newCols;
      const v = nr / newRows;
      // Find old-mesh fractional coords.
      const fc = u * oldMesh.cols;
      const fr = v * oldMesh.rows;
      const c0 = Math.max(0, Math.min(oldMesh.cols, Math.floor(fc)));
      const r0 = Math.max(0, Math.min(oldMesh.rows, Math.floor(fr)));
      const c1 = Math.min(oldMesh.cols, c0 + 1);
      const r1 = Math.min(oldMesh.rows, r0 + 1);
      const tx = fc - c0;
      const ty = fr - r0;
      // Bilinear weights.
      const w00 = (1 - tx) * (1 - ty);
      const w10 =      tx  * (1 - ty);
      const w01 = (1 - tx) *      ty;
      const w11 =      tx  *      ty;
      const i00 = (r0 * oW + c0) * 5;
      const i10 = (r0 * oW + c1) * 5;
      const i01 = (r1 * oW + c0) * 5;
      const i11 = (r1 * oW + c1) * 5;
      const mx = oldMesh.verts[i00+0]*w00 + oldMesh.verts[i10+0]*w10 +
                 oldMesh.verts[i01+0]*w01 + oldMesh.verts[i11+0]*w11;
      const my = oldMesh.verts[i00+1]*w00 + oldMesh.verts[i10+1]*w10 +
                 oldMesh.verts[i01+1]*w01 + oldMesh.verts[i11+1]*w11;
      const mi = oldMesh.verts[i00+4]*w00 + oldMesh.verts[i10+4]*w10 +
                 oldMesh.verts[i01+4]*w01 + oldMesh.verts[i11+4]*w11;
      const off = (nr * nW + nc) * 5;
      fresh.verts[off + 0] = mx;
      fresh.verts[off + 1] = my;
      fresh.verts[off + 2] = u;
      fresh.verts[off + 3] = v;
      fresh.verts[off + 4] = mi;
    }
  }
  return fresh;
}

/* Deep-clone a warp mesh so editor Cancel can restore the pre-edit
 * state without retaining a reference to the live mesh that gets
 * mutated during dragging. */
function _cloneWarpMesh(m) {
  if (!m) return null;
  const clone = {
    cols: m.cols,
    rows: m.rows,
    verts: m.verts.slice(),
    _isAutoBlend: m._isAutoBlend,
    _isTest: m._isTest,
    _isCustom: m._isCustom,
    _hasKeystone: m._hasKeystone,                 // 6.6.20.16 — idempotency flag
    _hasBezierCorrections: m._hasBezierCorrections // 6.6.20.17 — idempotency flag
  };
  // 6.6.19: preserve Bezier control grid through the editor's
  // Cancel-restore snapshot so undo doesn't silently downgrade
  // bezier authoring back to mesh authoring.
  if (m._bezier) {
    clone._bezier = {
      cols: m._bezier.cols,
      rows: m._bezier.rows,
      ctrl: m._bezier.ctrl.slice()
    };
  }
  return clone;
}

/* Open the modal for one display. If the display has no warp mesh,
 * a fresh identity mesh is created; if it has one, the user edits
 * a copy in place and originalMesh holds the snapshot for Cancel. */
function openWarpEditor(displayIdx) {
  const d = state.rig && state.rig.displays && state.rig.displays[displayIdx];
  if (!d) return;
  if (!d.warpMesh) d.warpMesh = _makeIdentityWarpMesh(8, 8);
  _warpEditor.open = true;
  _warpEditor.displayIdx = displayIdx;
  _warpEditor.originalMesh = _cloneWarpMesh(d.warpMesh);
  _warpEditor.draggedVertex = -1;
  _warpEditor.hoverVertex = -1;
  const overlay = document.getElementById("warp-editor");
  if (overlay) overlay.style.display = "flex";
  const title = document.getElementById("warp-editor-title");
  if (title) title.textContent = "Warp editor — Display " + displayIdx + " (" + (d.name || "") + ")";
  // 6.6.19: detect bezier-authored meshes on reopen and switch the
  // Mode dropdown accordingly. The mesh carries _bezier as the
  // source of truth in bezier mode; verts are derived.
  const isBezier = !!(d.warpMesh._bezier);
  const modeSel = document.getElementById("warp-editor-mode");
  if (modeSel) modeSel.value = isBezier ? "bezier" : "mesh";
  _updateWarpEditorModeUI(isBezier ? "bezier" : "mesh");

  const resSel = document.getElementById("warp-editor-res");
  if (resSel && !isBezier) {
    // Match the dropdown to the mesh's current cols. Non-square or
    // out-of-preset sizes show as "Custom…".
    const presetCols = ["4", "8", "12", "16", "24", "32"];
    const colsStr = String(d.warpMesh.cols);
    if (d.warpMesh.cols === d.warpMesh.rows && presetCols.includes(colsStr)) {
      resSel.value = colsStr;
    } else {
      resSel.value = "custom";
    }
  }
  // Bezier degree dropdown — match to current control-grid size.
  const degSel = document.getElementById("warp-editor-degree");
  if (degSel && isBezier) {
    const presetDegs = ["3", "4", "6", "8"];
    const degStr = String(d.warpMesh._bezier.cols);
    if (d.warpMesh._bezier.cols === d.warpMesh._bezier.rows && presetDegs.includes(degStr)) {
      degSel.value = degStr;
    } else {
      degSel.value = "4";    // fall back to default
    }
  }
  // Triangular checkbox starts unchecked since we can't reliably
  // detect a triangular mesh after load (the offset is baked in).
  const triCheck = document.getElementById("warp-editor-triangular");
  if (triCheck) triCheck.checked = false;
  // Drop GPU cache so the next frame rebuilds with the live edits.
  if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
  _drawWarpEditor();
}

/* Close the modal. save=true commits the in-place edits; save=false
 * restores the snapshot. Either way, GPU cache is dropped so the
 * next frame reflects the final state. */
function closeWarpEditor(save) {
  if (!_warpEditor.open) return;
  const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
  if (!save && d && _warpEditor.originalMesh) {
    d.warpMesh = _warpEditor.originalMesh;
  }
  if (save && state.rig && Object.keys(RIG_TEMPLATES).includes(state.rig.templateKey)) {
    state.rig.templateKey = "custom";
  }
  _warpEditor.open = false;
  _warpEditor.displayIdx = -1;
  _warpEditor.originalMesh = null;
  _warpEditor.draggedVertex = -1;
  _warpEditor.hoverVertex = -1;
  const overlay = document.getElementById("warp-editor");
  if (overlay) overlay.style.display = "none";
  if (Visual && Visual._warpCache && d) Visual._warpCache.delete(d.id);
  if (save) pushHistory("warp-edit:" + (d ? d.id : "?"));
  renderProps && renderProps();
  render();
}

/* 6.6.19: show/hide tools based on whether we're in mesh or bezier
 * authoring mode. In mesh mode: Resolution + Triangular visible. In
 * bezier mode: Degree visible, Triangular hidden (doesn't apply to
 * a single Bezier patch). Resolution stays visible in mesh mode only
 * so users don't accidentally bump the mesh tessellation density
 * while editing a bezier. */
function _updateWarpEditorModeUI(mode) {
  const resLabel  = document.getElementById("warp-editor-res-label");
  const degLabel  = document.getElementById("warp-editor-degree-label");
  const triLabel  = document.getElementById("warp-editor-tri-label");
  const hint      = document.getElementById("warp-editor-hint");
  if (resLabel) resLabel.style.display = (mode === "bezier") ? "none" : "";
  if (triLabel) triLabel.style.display = (mode === "bezier") ? "none" : "";
  if (degLabel) degLabel.style.display = (mode === "bezier") ? "" : "none";
  if (hint) {
    hint.textContent = (mode === "bezier")
      ? "Drag a control point to bend the warp · Right-click resets one point · × or Save commits · Esc / Cancel discards"
      : "Drag a point to warp · Right-click resets one point · × or Save commits · Esc / Cancel discards · Live preview visible behind";
  }
}

/* Render the editor canvas. Draws a calibration checkerboard +
 * overlays the warp mesh as a draggable point grid. The mesh's
 * (mx, my) NDC positions are mapped to canvas space [-1,+1] →
 * [pad, W-pad] / [pad, H-pad] (Y inverted: canvas y down vs NDC
 * y up). Selected / hovered points are drawn larger and accent-
 * colored so the user always knows which point they're moving.
 *
 * 6.6.19: in bezier mode, the dense mesh is drawn faintly and the
 * Bezier control polygon (dashed lines + control points) is the
 * draggable layer. */
function _drawWarpEditor() {
  const canvas = document.getElementById("warp-editor-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
  if (!d || !_validateWarpMesh(d.warpMesh)) return;
  const m = d.warpMesh;

  // Calibration checkerboard — 8×8 in canvas space, alternating dark
  // grey + lighter grey. Distinct from the warp mesh's grid lines.
  const cells = 8;
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      ctx.fillStyle = ((r + c) & 1) ? "rgba(80, 90, 105, 0.35)" : "rgba(40, 48, 60, 0.5)";
      ctx.fillRect(c * W / cells, r * H / cells, W / cells, H / cells);
    }
  }
  // Crosshair at canvas center for symmetry reference.
  ctx.strokeStyle = "rgba(200, 232, 90, 0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W * 0.5, 0); ctx.lineTo(W * 0.5, H);
  ctx.moveTo(0, H * 0.5); ctx.lineTo(W, H * 0.5);
  ctx.stroke();

  // Map mesh NDC (mx, my) ∈ [-1, 1]² to canvas pixels with a small
  // padding so the boundary points sit just inside the canvas edge.
  const pad = Math.min(W, H) * 0.06;
  const Wf = W - pad * 2, Hf = H - pad * 2;
  const meshToCanvas = (mx, my) => ({
    x: pad + (mx + 1) * 0.5 * Wf,
    y: pad + (1 - (my + 1) * 0.5) * Hf
  });

  const cols1 = m.cols + 1, rows1 = m.rows + 1;
  const inBezier = !!(m._bezier);

  // Mesh quad outlines + diagonals show how the warp is deforming
  // a uniform grid. Draw before the points so points sit on top.
  // In bezier mode, draw the dense mesh faintly so the user can
  // see the smooth Bezier surface, then draw the control polygon
  // on top of it.
  ctx.strokeStyle = inBezier ? "rgba(180, 190, 210, 0.18)" : "rgba(180, 190, 210, 0.45)";
  ctx.lineWidth = 1;
  // Horizontal lines (per row).
  for (let r = 0; r < rows1; r++) {
    ctx.beginPath();
    for (let c = 0; c < cols1; c++) {
      const v = m.verts.subarray ? m.verts.subarray((r*cols1+c)*5, (r*cols1+c)*5+5) : m.verts.slice((r*cols1+c)*5, (r*cols1+c)*5+5);
      const p = meshToCanvas(v[0], v[1]);
      if (c === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  // Vertical lines (per col).
  for (let c = 0; c < cols1; c++) {
    ctx.beginPath();
    for (let r = 0; r < rows1; r++) {
      const idx = (r * cols1 + c) * 5;
      const p = meshToCanvas(m.verts[idx], m.verts[idx + 1]);
      if (r === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  if (inBezier) {
    // Bezier mode: control polygon (dashed) + control points.
    const b = m._bezier;
    const bcols1 = b.cols + 1, brows1 = b.rows + 1;
    const cpToCanvas = (i) => meshToCanvas(b.ctrl[i * 2], b.ctrl[i * 2 + 1]);

    // Dashed control polygon — visually distinguishes "this is the
    // control net, not the actual surface" from the dense mesh below.
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(170, 162, 240, 0.55)";
    ctx.lineWidth = 1.25;
    // Horizontal control-net lines.
    for (let r = 0; r < brows1; r++) {
      ctx.beginPath();
      for (let c = 0; c < bcols1; c++) {
        const p = cpToCanvas(r * bcols1 + c);
        if (c === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    // Vertical control-net lines.
    for (let c = 0; c < bcols1; c++) {
      ctx.beginPath();
      for (let r = 0; r < brows1; r++) {
        const p = cpToCanvas(r * bcols1 + c);
        if (r === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Control points. The four corners are pinned visually (Bezier
    // interpolates corners) — render them slightly smaller and a
    // dimmer hue to suggest "anchor" rather than "free."
    for (let r = 0; r < brows1; r++) {
      for (let c = 0; c < bcols1; c++) {
        const flat = r * bcols1 + c;
        const p = cpToCanvas(flat);
        const isDragged = (_warpEditor.draggedVertex === flat);
        const isHover   = (_warpEditor.hoverVertex   === flat);
        const isCorner  = (r === 0 || r === b.rows) && (c === 0 || c === b.cols);
        const radius = isDragged ? 10 : (isHover ? 8 : 6);
        ctx.fillStyle = isDragged
          ? "rgba(200, 232, 90, 0.95)"
          : (isHover ? "rgba(170, 162, 240, 0.95)"
            : (isCorner ? "rgba(140, 132, 200, 0.85)" : "rgba(190, 180, 255, 0.85)"));
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(8, 11, 16, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  } else {
    // Mesh mode: every mesh vertex is draggable (legacy 6.6.2 UI).
    for (let r = 0; r < rows1; r++) {
      for (let c = 0; c < cols1; c++) {
        const idx = (r * cols1 + c) * 5;
        const p = meshToCanvas(m.verts[idx], m.verts[idx + 1]);
        const flat = r * cols1 + c;
        const isDragged = (_warpEditor.draggedVertex === flat);
        const isHover   = (_warpEditor.hoverVertex   === flat);
        const radius = isDragged ? 9 : (isHover ? 7 : 5);
        ctx.fillStyle = isDragged
          ? "rgba(200, 232, 90, 0.95)"
          : (isHover ? "rgba(170, 162, 240, 0.95)" : "rgba(170, 162, 240, 0.7)");
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(8, 11, 16, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}

/* Convert a canvas-space click to the closest mesh-vertex index, or
 * -1 if no vertex is within hitRadius pixels. Walks every vertex
 * (default 8×8 mesh = 81 points = trivial). */
function _warpEditorHitTest(canvas, clientX, clientY, hitRadius) {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width  / r.width;
  const sy = canvas.height / r.height;
  const cx = (clientX - r.left) * sx;
  const cy = (clientY - r.top)  * sy;
  const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
  if (!d || !_validateWarpMesh(d.warpMesh)) return { idx: -1, cx, cy };
  const m = d.warpMesh;
  const W = canvas.width, H = canvas.height;
  const pad = Math.min(W, H) * 0.06;
  const Wf = W - pad * 2, Hf = H - pad * 2;
  let bestIdx = -1, bestDist = hitRadius;
  // 6.6.19: in bezier mode, hit-test against control points instead
  // of mesh vertices. The flat-index space is the bezier control
  // grid (small) rather than the dense mesh (~1000 verts).
  if (m._bezier) {
    const b = m._bezier;
    const bcols1 = b.cols + 1, brows1 = b.rows + 1;
    for (let r2 = 0; r2 < brows1; r2++) {
      for (let c = 0; c < bcols1; c++) {
        const i = (r2 * bcols1 + c) * 2;
        const px = pad + (b.ctrl[i] + 1) * 0.5 * Wf;
        const py = pad + (1 - (b.ctrl[i+1] + 1) * 0.5) * Hf;
        const dist = Math.hypot(cx - px, cy - py);
        if (dist < bestDist) { bestDist = dist; bestIdx = r2 * bcols1 + c; }
      }
    }
    return { idx: bestIdx, cx, cy };
  }
  // Mesh mode (legacy).
  const cols1 = m.cols + 1, rows1 = m.rows + 1;
  for (let r2 = 0; r2 < rows1; r2++) {
    for (let c = 0; c < cols1; c++) {
      const i = (r2 * cols1 + c) * 5;
      const px = pad + (m.verts[i] + 1) * 0.5 * Wf;
      const py = pad + (1 - (m.verts[i+1] + 1) * 0.5) * Hf;
      const dist = Math.hypot(cx - px, cy - py);
      if (dist < bestDist) { bestDist = dist; bestIdx = r2 * cols1 + c; }
    }
  }
  return { idx: bestIdx, cx, cy };
}

/* Convert canvas pixel position to mesh NDC (mx, my). Inverse of the
 * meshToCanvas mapping in _drawWarpEditor. Clamped to the editable
 * range so the user can't drag a point all the way off the canvas. */
function _warpEditorCanvasToNdc(canvas, cx, cy) {
  const W = canvas.width, H = canvas.height;
  const pad = Math.min(W, H) * 0.06;
  const Wf = W - pad * 2, Hf = H - pad * 2;
  const u = (cx - pad) / Wf;
  const v = (cy - pad) / Hf;
  const mx = Math.max(-1.5, Math.min(1.5, u * 2 - 1));
  const my = Math.max(-1.5, Math.min(1.5, (1 - v) * 2 - 1));
  return { mx, my };
}

/* One-time wiring of editor controls + canvas pointer events. */
let _warpEditorWired = false;
function _wireWarpEditor() {
  if (_warpEditorWired) return;
  _warpEditorWired = true;
  const canvas = document.getElementById("warp-editor-canvas");
  const closeBtn  = document.getElementById("warp-editor-close");
  const cancelBtn = document.getElementById("warp-editor-cancel");
  const saveBtn   = document.getElementById("warp-editor-save");
  const resSel    = document.getElementById("warp-editor-res");
  const resetBtn  = document.getElementById("warp-editor-reset");

  // × button at the top-right is "save & close" — matches the
  // universal modern-web-app convention (Notion, Google Docs, etc.)
  // where clicking the corner X commits the work. Cancel button in
  // the footer is the explicit discard path; Esc also cancels for
  // keyboard fluency.
  if (closeBtn)  closeBtn.addEventListener("click",  () => closeWarpEditor(true));
  if (cancelBtn) cancelBtn.addEventListener("click", () => closeWarpEditor(false));
  if (saveBtn)   saveBtn.addEventListener("click",   () => closeWarpEditor(true));

  // 6.6.19: mode toggle (Mesh ↔ Bezier).
  const modeSel = document.getElementById("warp-editor-mode");
  if (modeSel) {
    modeSel.addEventListener("change", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      const target = modeSel.value;
      const isCurrentlyBezier = !!(d.warpMesh._bezier);
      if (target === "bezier" && !isCurrentlyBezier) {
        // Mesh → Bezier. If the current mesh has user edits, warn —
        // a fresh identity Bezier overwrites them. (Future work: a
        // least-squares fit of the existing mesh to a Bezier patch.)
        const hasEdits = !!d.warpMesh._isCustom || !!d.warpMesh._isAutoBlend || !!d.warpMesh._isTest;
        if (hasEdits) {
          const ok = (typeof confirm === "function")
            ? confirm("Switch to Bezier mode? The current mesh edits will be replaced with an identity Bezier patch (no warp). The corner X / Save still preserves whichever shape is on screen at the time.")
            : true;
          if (!ok) {
            modeSel.value = "mesh";
            return;
          }
        }
        // Default Bezier: 5×5 control points (degree 4) — enough for
        // AlloSphere-class smooth curvature.
        const degSel = document.getElementById("warp-editor-degree");
        const deg = degSel ? Math.max(2, parseInt(degSel.value, 10) || 4) : 4;
        const bez = _makeIdentityBezier(deg, deg);
        d.warpMesh = _bezierToWarpMesh(bez, BEZIER_MESH_TESS, BEZIER_MESH_TESS);
        d.warpMesh._isCustom = !!hasEdits;   // preserve edited-flag if user already had edits
      } else if (target === "mesh" && isCurrentlyBezier) {
        // Bezier → Mesh. Keep the dense tessellated mesh (the user
        // sees the same warp) and drop the bezier control grid. They
        // can now hand-edit individual mesh verts.
        delete d.warpMesh._bezier;
      }
      _updateWarpEditorModeUI(target);
      // Reset drag state and force a redraw with the new representation.
      _warpEditor.draggedVertex = -1;
      _warpEditor.hoverVertex = -1;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }

  // 6.6.19: bezier degree change. Rebuilds the control grid at the
  // new size; existing edits are not preserved (no fitter yet).
  const degSel = document.getElementById("warp-editor-degree");
  if (degSel) {
    degSel.addEventListener("change", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh || !d.warpMesh._bezier) return;
      const deg = Math.max(2, parseInt(degSel.value, 10) || 4);
      const hasEdits = !!d.warpMesh._isCustom;
      if (hasEdits) {
        const ok = (typeof confirm === "function")
          ? confirm("Change Bezier degree? Existing control-point edits will be reset.")
          : true;
        if (!ok) {
          // Restore dropdown to current degree.
          degSel.value = String(d.warpMesh._bezier.cols);
          return;
        }
      }
      const bez = _makeIdentityBezier(deg, deg);
      d.warpMesh = _bezierToWarpMesh(bez, BEZIER_MESH_TESS, BEZIER_MESH_TESS);
      _warpEditor.draggedVertex = -1;
      _warpEditor.hoverVertex = -1;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }

  if (resSel) {
    resSel.addEventListener("change", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d) return;
      let newCols, newRows;
      if (resSel.value === "custom") {
        // Prompt for "cols × rows" — accepts "16x12", "16 12", "16",
        // "16, 12". Any non-numeric falls back to the previous mesh
        // dimensions. Capped at 64 to protect the GPU buffers.
        const cur = d.warpMesh ? (d.warpMesh.cols + " × " + d.warpMesh.rows) : "8 × 8";
        const ans = (typeof prompt === "function")
          ? prompt("Mesh resolution (cols × rows, max 64):", cur)
          : null;
        if (!ans) {
          // User canceled — restore the dropdown to the current mesh's
          // dimensions so the UI stays consistent.
          if (d.warpMesh) resSel.value = String(d.warpMesh.cols);
          return;
        }
        const nums = ans.match(/\d+/g);
        if (!nums || !nums.length) {
          if (d.warpMesh) resSel.value = String(d.warpMesh.cols);
          return;
        }
        newCols = Math.max(1, Math.min(64, parseInt(nums[0], 10)));
        newRows = nums.length > 1
          ? Math.max(1, Math.min(64, parseInt(nums[1], 10)))
          : newCols;
      } else {
        const v = parseInt(resSel.value, 10);
        if (!Number.isFinite(v) || v < 2) return;
        newCols = newRows = v;
      }
      // Resample into the new dim. If triangular is on, regenerate
      // from scratch (offset rows) — there's no useful interpretation
      // of "preserve the warp + add row offset," so the toggle wins.
      const triCheck = document.getElementById("warp-editor-triangular");
      const triangular = !!(triCheck && triCheck.checked);
      d.warpMesh = triangular
        ? _makeTriangularWarpMesh(newCols, newRows)
        : _resampleWarpMesh(d.warpMesh, newCols, newRows);
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }
  const triCheckbox = document.getElementById("warp-editor-triangular");
  if (triCheckbox) {
    triCheckbox.addEventListener("change", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      // Regenerate at the current dim — toggling triangular discards
      // any in-progress hand-edits (sensible: the offset is a
      // generation-time choice, not a per-vertex edit). The existing
      // Bourke mesh format stores the offset baked into vert positions
      // so once saved, it's just a normal mesh.
      d.warpMesh = triCheckbox.checked
        ? _makeTriangularWarpMesh(d.warpMesh.cols, d.warpMesh.rows)
        : _makeIdentityWarpMesh(d.warpMesh.cols, d.warpMesh.rows);
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      // 6.6.19: in bezier mode reset rebuilds an identity bezier at
      // the current degree; the dense mesh follows from tessellation.
      if (d.warpMesh._bezier) {
        const deg = d.warpMesh._bezier.cols;
        const bez = _makeIdentityBezier(deg, deg);
        d.warpMesh = _bezierToWarpMesh(bez, BEZIER_MESH_TESS, BEZIER_MESH_TESS);
      } else {
        const triangular = !!(triCheckbox && triCheckbox.checked);
        d.warpMesh = triangular
          ? _makeTriangularWarpMesh(d.warpMesh.cols, d.warpMesh.rows)
          : _makeIdentityWarpMesh(d.warpMesh.cols, d.warpMesh.rows);
      }
      _warpEditor.draggedVertex = -1;
      _warpEditor.hoverVertex = -1;
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }

  if (canvas) {
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2) return;            // right-click handled by contextmenu
      const hit = _warpEditorHitTest(canvas, e.clientX, e.clientY, 18);
      if (hit.idx >= 0) {
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        _warpEditor.draggedVertex = hit.idx;
        _drawWarpEditor();
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      if (_warpEditor.draggedVertex >= 0) {
        // Drag the active vertex.
        const r = canvas.getBoundingClientRect();
        const sx = canvas.width  / r.width;
        const sy = canvas.height / r.height;
        const cx = (e.clientX - r.left) * sx;
        const cy = (e.clientY - r.top)  * sy;
        const ndc = _warpEditorCanvasToNdc(canvas, cx, cy);
        // 6.6.19: in bezier mode the dragged index is into the
        // control grid (cols+1 stride per row), not the dense mesh.
        // After updating the ctrl point we re-tessellate the mesh
        // verts so the GPU pipeline sees the new surface immediately.
        if (d.warpMesh._bezier) {
          const offset = _warpEditor.draggedVertex * 2;
          d.warpMesh._bezier.ctrl[offset + 0] = ndc.mx;
          d.warpMesh._bezier.ctrl[offset + 1] = ndc.my;
          _rebuildMeshFromBezier(d.warpMesh);
        } else {
          const offset = _warpEditor.draggedVertex * 5;
          d.warpMesh.verts[offset + 0] = ndc.mx;
          d.warpMesh.verts[offset + 1] = ndc.my;
        }
        // Editing makes the mesh "custom" — user-authored. Drop the
        // auto-/test- flags so the rig pane's warp pill flips to
        // "warp: custom" (red rim, doesn't get clobbered by pill
        // cycle without confirm) and a re-run of Auto-blend leaves
        // it alone.
        d.warpMesh._isAutoBlend = false;
        d.warpMesh._isTest      = false;
        d.warpMesh._isCustom    = true;
        if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
        _drawWarpEditor();
      } else {
        // Hover preview.
        const hit = _warpEditorHitTest(canvas, e.clientX, e.clientY, 14);
        if (hit.idx !== _warpEditor.hoverVertex) {
          _warpEditor.hoverVertex = hit.idx;
          _drawWarpEditor();
        }
      }
    });
    const endDrag = (e) => {
      if (_warpEditor.draggedVertex < 0) return;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      _warpEditor.draggedVertex = -1;
      _drawWarpEditor();
    };
    canvas.addEventListener("pointerup",     endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    // Right-click → reset that vertex / control point to its identity
    // NDC position. In bezier mode we also re-tessellate the mesh
    // from the (now-reset) control grid.
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const d = state.rig && state.rig.displays && state.rig.displays[_warpEditor.displayIdx];
      if (!d || !d.warpMesh) return;
      const hit = _warpEditorHitTest(canvas, e.clientX, e.clientY, 18);
      if (hit.idx < 0) return;
      if (d.warpMesh._bezier) {
        const b = d.warpMesh._bezier;
        const bcols1 = b.cols + 1;
        const r = Math.floor(hit.idx / bcols1);
        const c = hit.idx % bcols1;
        const off = hit.idx * 2;
        b.ctrl[off + 0] = (c / b.cols) * 2 - 1;
        b.ctrl[off + 1] = (r / b.rows) * 2 - 1;
        _rebuildMeshFromBezier(d.warpMesh);
      } else {
        const cols1 = d.warpMesh.cols + 1;
        const r = Math.floor(hit.idx / cols1);
        const c = hit.idx % cols1;
        const off = hit.idx * 5;
        d.warpMesh.verts[off + 0] = (c / d.warpMesh.cols) * 2 - 1;
        d.warpMesh.verts[off + 1] = (r / d.warpMesh.rows) * 2 - 1;
      }
      if (Visual && Visual._warpCache) Visual._warpCache.delete(d.id);
      _drawWarpEditor();
    });
  }

  // Esc cancels the editor.
  document.addEventListener("keydown", (e) => {
    if (!_warpEditor.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeWarpEditor(false);
    }
  });
}

