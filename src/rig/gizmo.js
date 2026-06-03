/* ----- Phase 6.5.16 — 3D rig wireframe gizmo ------------------------- */

/* Orbit-camera state for the gizmo. yaw/pitch in degrees; scale is a
 * multiplier on the orthographic projection (mouse-wheel zoom).
 * Persisted only in memory — no .gpatch round-trip; the gizmo is a
 * UX overlay, not patch state.
 *
 * Default: pitch=+35 so the camera looks DOWN at the rig from
 * above at a moderately steep angle — steep enough that the four
 * elevation rings of the AlloSphere templates read as separate
 * latitudes, not concentric vertical bars. Combined with the
 * wireframe sphere drawn behind the frustums, this gives an
 * unambiguous "looking down into a sphere" read on first open. */
const _gizmoCam = { yaw: 30, pitch: 35, scale: 1.0 };
let _gizmoOpen = false;
let _gizmoDrag = null;

function _setGizmoOpen(on) {
  on = !!on;
  if (on === _gizmoOpen) return;
  _gizmoOpen = on;
  const overlay = document.getElementById("rig-gizmo");
  if (overlay) overlay.style.display = on ? "block" : "none";
  const pill = document.getElementById("gizmo-pill");
  if (pill) pill.classList.toggle("active", on);
}
function toggleRigGizmo() { _setGizmoOpen(!_gizmoOpen); }

/* Build a unit-vector "forward" direction from yaw / pitch in
 * degrees. yaw=0 → +Z, yaw=+90 → +X, pitch=+90 → +Y (zenith). */
function _yawPitchToVec(yawDeg, pitchDeg) {
  const yr = yawDeg * Math.PI / 180;
  const pr = pitchDeg * Math.PI / 180;
  return [
    Math.sin(yr) * Math.cos(pr),
    Math.sin(pr),
    Math.cos(yr) * Math.cos(pr)
  ];
}

/* Apply display rotation (yaw + pitch) to a point in display-local
 * space. Roll is supported via the registry but skipped here — most
 * rig templates leave it 0 and the gizmo prioritizes legibility over
 * pixel-exact pose match. Order: pitch around X, then yaw around Y.
 *
 * Convention: positive pitch = looks UP toward +Y zenith. So
 * (0, 0, 1) rotated by pitch=+90 gives (0, 1, 0). Matches the
 * spherical-projection math elsewhere in the editor. */
function _rotateDisplayPoint(p, yawDeg, pitchDeg) {
  let [x, y, z] = p;
  const pr = pitchDeg * Math.PI / 180;
  const cp = Math.cos(pr), sp = Math.sin(pr);
  const y1 = y * cp + z * sp;       // +Z → +Y at pitch=+90 (looks up)
  const z1 = -y * sp + z * cp;
  y = y1; z = z1;
  const yr = yawDeg * Math.PI / 180;
  const cy = Math.cos(yr), sy = Math.sin(yr);
  const x2 = x * cy + z * sy;
  const z2 = -x * sy + z * cy;
  x = x2; z = z2;
  return [x, y, z];
}

/* Phase 6.6.4b — visual overlay (RigGizmo). Per-frame 2D pass that
 * draws labels, outlines, warp/blend badges, and audio-reactive
 * highlights on top of each display tile. Active only when the patch
 * contains a RigGizmo node and the rig preview is in tile mode. The
 * overlay is fully decorative — pointer-events:none on the canvas
 * means the editor's pointer flow is unaffected.
 *
 * Audio reactivity: if previewState.analyserL/R are running (preview
 * is playing), METER.smoothL/R is read as the current peak amplitude
 * and added to the base intensity param. Wiring an audio source into
 * the RigGizmo's "level" input is currently decorative — the routing
 * is shown in the patch but the value comes from the master meter.
 * Per-tap routing is its own ticket. */
function _drawVisualOverlay() {
  const ov = document.getElementById("visual-overlay");
  if (!ov) return;
  const ctx2 = ov.getContext("2d");
  if (!ctx2) return;
  const W = ov.width, H = ov.height;
  ctx2.clearRect(0, 0, W, H);

  const nodes    = (state && state.nodes) || [];
  const displays = (state && state.rig && state.rig.displays) || [];
  if (displays.length === 0) return;
  const mode = (state && state.rig && state.rig.previewMode) || "tile";

  // Tile geometry — shared between RigGizmo and Text per-display modes.
  const layerCount = Math.min(displays.length, RIG_MAX_DISPLAYS);
  const { cols, rows } = _rigTileLayout(layerCount);
  const masterAspect = _projectionMasterAspect();
  const vp = _projectionViewportRect(masterAspect);
  const tileW = vp.w / cols;
  const tileH = vp.h / rows;

  // Phase 6.6.4b — RigGizmo HUD. Find first RigGizmo node; tile mode
  // only since the per-tile labels don't make sense in audience-
  // perspective unwraps.
  const gizmoNode = nodes.find(n => n && n.type === "RigGizmo");
  if (gizmoNode && mode === "tile") {
    _drawRigGizmoHud(ctx2, gizmoNode, displays, layerCount, vp, tileW, tileH, cols);
  }

  // Phase 6.6.25 — Text nodes are now shader-frag mesh text
  // (rendered via the regular shader-frag pipeline + VisualOutput).
  // The legacy 2D-overlay path here is filtered out for any Text
  // whose registry def has kind: "shader-frag" -- i.e. all of them
  // post-6.6.25. If a future TextOverlay node ships as a 2D
  // overlay variant, this filter lets both coexist.
  const textNodes = nodes.filter(n =>
    n && n.type === "Text" &&
    !(TYPES[n.type] && TYPES[n.type].kind === "shader-frag")
  );
  for (const t of textNodes) {
    _drawTextOverlay(ctx2, t, displays, layerCount, vp, tileW, tileH, cols, mode);
  }

  // Phase 6.6.13 — theater-mode entry hint. Visible when the rig is
  // in theater preview but the user hasn't engaged pointer-lock yet.
  // Hides itself once the camera is captured so it doesn't clutter
  // the immersive view. On touch devices the pads are always live, so
  // the hint reads as touch instructions instead of the pointer-lock
  // gesture.
  const isTouch = document.body.classList.contains("theater-touch-capable");
  if (mode === "theater" && Visual.theaterCam && !Visual.theaterCam.pointerLocked && !isTouch) {
    _drawTheaterHint(ctx2, vp, false);
  }
  if (mode === "theater" && isTouch && Visual.theaterCam && !Visual.theaterCam.touchMove && !Visual.theaterCam.touchLook) {
    _drawTheaterHint(ctx2, vp, true);
  }
}

/* Phase 6.6.13 — small instructional plate centered on the visual
 * viewport when theater mode is awaiting user engagement. Once the
 * pointer is locked (or any pad is active) the hint goes away. */
function _drawTheaterHint(ctx2, vp, isTouch) {
  const dpr = window.devicePixelRatio || 1;
  const cx = vp.x + vp.w * 0.5;
  const cy = vp.y + vp.h * 0.5;
  const fontMain = Math.max(20 * dpr, vp.h * 0.04);
  const fontSub  = fontMain * 0.55;
  const lines = isTouch
    ? [
        "Theater mode",
        "Drag the LEFT pad to move · Drag the RIGHT pad to look around"
      ]
    : [
        "Click to enter Theater control",
        "Arrows move · PgUp/PgDn up/down · Shift sprint · Mouse look · ESC release"
      ];
  ctx2.textAlign = "center";
  ctx2.textBaseline = "middle";

  // Plate
  ctx2.font = "700 " + fontMain + "px Inter, system-ui, sans-serif";
  const w0 = ctx2.measureText(lines[0]).width;
  ctx2.font = "500 " + fontSub  + "px Inter, system-ui, sans-serif";
  const w1 = ctx2.measureText(lines[1]).width;
  const plateW = Math.max(w0, w1) + fontMain * 1.4;
  const plateH = fontMain + fontSub + fontMain * 1.2;
  ctx2.fillStyle = "rgba(8, 11, 16, 0.78)";
  ctx2.fillRect(cx - plateW/2, cy - plateH/2, plateW, plateH);
  ctx2.strokeStyle = "rgba(127, 119, 221, 0.55)";
  ctx2.lineWidth = Math.max(2, dpr);
  ctx2.strokeRect(cx - plateW/2, cy - plateH/2, plateW, plateH);

  // Lines
  ctx2.fillStyle = "rgba(200, 232, 90, 0.95)";
  ctx2.font = "700 " + fontMain + "px Inter, system-ui, sans-serif";
  ctx2.fillText(lines[0], cx, cy - fontSub * 0.6);
  ctx2.fillStyle = "rgba(200, 200, 220, 0.85)";
  ctx2.font = "500 " + fontSub + "px Inter, system-ui, sans-serif";
  ctx2.fillText(lines[1], cx, cy + fontMain * 0.55);
}

/* Phase 6.6.4b helper extracted for clarity — was inline in
 * _drawVisualOverlay. Renders the RigGizmo HUD on each display tile:
 * outline, intensity-pulse highlight, label, warp/blend badges. */
function _drawRigGizmoHud(ctx2, gizmoNode, displays, layerCount, vp, tileW, tileH, cols) {
  const params = gizmoNode.params || {};
  const baseIntensity = (typeof params.intensity === "number") ? params.intensity : 0.5;
  const labelMode    = params.labelMode || "index";
  const showWarp     = params.showWarp     !== false;
  const showBlend    = params.showBlend    !== false;
  const outlineTiles = params.outlineTiles !== false;

  let audioLevel = 0;
  if (typeof METER !== "undefined" && METER && Number.isFinite(METER.smoothL)) {
    audioLevel = Math.max(METER.smoothL || 0, METER.smoothR || 0);
  }
  const intensity = Math.min(1, baseIntensity + audioLevel * 0.7);

  const defaultEB = _defaultEdgeBlend();
  const isCustomBlend = (eb) => !eb ||
    eb.gamma     !== defaultEB.gamma ||
    eb.blackLift !== defaultEB.blackLift ||
    eb.power     !== defaultEB.power;

  for (let i = 0; i < layerCount; i++) {
    const d = displays[i];
    if (!d) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const tx  = vp.x + col * tileW;
    const ty  = vp.y + row * tileH;

    if (intensity > 0.01) {
      ctx2.fillStyle = "rgba(200, 232, 90, " + (0.06 + intensity * 0.18).toFixed(3) + ")";
      ctx2.fillRect(tx, ty, tileW, tileH);
    }
    if (outlineTiles) {
      ctx2.strokeStyle = "rgba(200, 232, 90, " + (0.35 + intensity * 0.45).toFixed(3) + ")";
      ctx2.lineWidth = Math.max(2, 2 * (window.devicePixelRatio || 1));
      ctx2.strokeRect(tx + 1, ty + 1, tileW - 2, tileH - 2);
    }
    if (labelMode !== "none") {
      const text = labelMode === "name"
        ? (d.name || ("Display " + (i + 1)))
        : String(i);
      const fontPx = Math.max(14 * (window.devicePixelRatio || 1),
                              Math.min(tileH * 0.10, 64 * (window.devicePixelRatio || 1)));
      ctx2.font = "600 " + fontPx + "px JetBrains Mono, ui-monospace, monospace";
      ctx2.textBaseline = "top";
      const padX = fontPx * 0.5;
      const padY = fontPx * 0.4;
      const tw = ctx2.measureText(text).width;
      ctx2.fillStyle = "rgba(8, 11, 16, 0.55)";
      ctx2.fillRect(tx + padX - 4, ty + padY - 2, tw + 8, fontPx + 4);
      ctx2.fillStyle = "rgba(200, 232, 90, 0.92)";
      ctx2.fillText(text, tx + padX, ty + padY);

      const badges = [];
      if (showWarp && d.warpMesh) {
        badges.push({ text: d.warpMesh._isTest ? "WARP•TEST" : "WARP", color: "rgba(127, 119, 221, 0.95)" });
      }
      if (showBlend && isCustomBlend(d.edgeBlend)) {
        badges.push({ text: "BLEND", color: "rgba(226, 75, 74, 0.95)" });
      }
      if (badges.length) {
        const badgeFont = Math.max(10 * (window.devicePixelRatio || 1), fontPx * 0.42);
        ctx2.font = "500 " + badgeFont + "px JetBrains Mono, ui-monospace, monospace";
        let bx = tx + padX + tw + 12;
        const by = ty + padY + (fontPx - badgeFont) * 0.5;
        for (const b of badges) {
          const bw = ctx2.measureText(b.text).width;
          ctx2.fillStyle = "rgba(8, 11, 16, 0.6)";
          ctx2.fillRect(bx - 4, by - 2, bw + 8, badgeFont + 4);
          ctx2.fillStyle = b.color;
          ctx2.fillText(b.text, bx, by);
          bx += bw + 12;
        }
      }
    }
  }
}

/* Phase 6.6.12 — render one Text-node's string on the overlay
 * canvas. perDisplay=true → once per tile, with {idx}/{name}/{n}
 * substitution per display. perDisplay=false → once at the user-
 * positioned spot on the canvas (or the rig's master viewport rect
 * in non-tile modes — text stays inside the visible rendered area).
 *
 * Font stack maps the dropdown choice to the editor's loaded fonts:
 *   mono    → JetBrains Mono (the editor default)
 *   sans    → Inter / system-ui / sans-serif
 *   serif   → Georgia / serif
 *   display → Impact / Arial Black / heavy sans (for big calibration
 *             markers that read from across the room)
 */
function _drawTextOverlay(ctx2, node, displays, layerCount, vp, tileW, tileH, cols, mode) {
  const p = node.params || {};
  const text = (typeof p.text === "string") ? p.text : "TEST";
  if (!text) return;
  const fontKey = p.font || "sans";
  const fontStack = ({
    mono:    "JetBrains Mono, ui-monospace, SFMono-Regular, monospace",
    sans:    "Inter, system-ui, -apple-system, Segoe UI, sans-serif",
    serif:   "Georgia, 'Times New Roman', serif",
    display: "Impact, 'Arial Black', 'Helvetica Neue', sans-serif"
  })[fontKey] || "Inter, sans-serif";

  const dpr = window.devicePixelRatio || 1;
  const fontSize = Math.max(8, (typeof p.fontSize === "number" ? p.fontSize : 96)) * dpr;
  const r = Math.max(0, Math.min(1, typeof p.r === "number" ? p.r : 1));
  const g = Math.max(0, Math.min(1, typeof p.g === "number" ? p.g : 1));
  const b = Math.max(0, Math.min(1, typeof p.b === "number" ? p.b : 1));
  const colorRgb = (Math.round(r*255)) + "," + (Math.round(g*255)) + "," + (Math.round(b*255));
  const x = (typeof p.x === "number") ? p.x : 0.5;
  const y = (typeof p.y === "number") ? p.y : 0.5;
  const plateOpacity = Math.max(0, Math.min(1,
    typeof p.plateOpacity === "number" ? p.plateOpacity : 0.55));
  const perDisplay = p.perDisplay !== false;

  ctx2.font = "700 " + fontSize + "px " + fontStack;
  ctx2.textBaseline = "middle";
  ctx2.textAlign    = "center";

  const drawAt = (cx, cy, label) => {
    const tw = ctx2.measureText(label).width;
    const th = fontSize;
    if (plateOpacity > 0.001) {
      ctx2.fillStyle = "rgba(8, 11, 16, " + plateOpacity.toFixed(3) + ")";
      const padX = fontSize * 0.25;
      const padY = fontSize * 0.15;
      ctx2.fillRect(cx - tw/2 - padX, cy - th/2 - padY, tw + padX*2, th + padY*2);
    }
    ctx2.fillStyle = "rgba(" + colorRgb + ",1)";
    ctx2.fillText(label, cx, cy);
  };

  if (perDisplay && mode === "tile") {
    // Per-tile rendering with token substitution.
    for (let i = 0; i < layerCount; i++) {
      const d = displays[i];
      if (!d) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const tx  = vp.x + col * tileW;
      const ty  = vp.y + row * tileH;
      const cx  = tx + tileW * x;
      const cy  = ty + tileH * y;
      const label = text
        .replace(/\{idx\}/g,  String(i))
        .replace(/\{name\}/g, d.name || ("Display " + (i + 1)))
        .replace(/\{n\}/g,    String(layerCount));
      drawAt(cx, cy, label);
    }
  } else if (perDisplay && mode === "theater") {
    // Phase 6.6.13 carry-over — in theater mode, project each
    // display's 3D center to canvas space using the theater camera
    // and draw the label there. Labels follow displays as the user
    // walks around. Displays behind the camera are skipped (clip.w
    // ≤ 0 means projecting through the near plane); displays
    // outside the canvas (NDC out of [-1, 1]) are clipped naturally
    // by drawAt landing offscreen — it's fine to overdraw the
    // letterbox because the canvas2D clears each frame.
    const ov = document.getElementById("visual-overlay");
    if (!ov || !Visual || !Visual.theaterCam) return;
    const cw = ov.width, ch = ov.height;
    const aspect = (cw && ch) ? cw / ch : 1;
    const vpMat = _theaterViewProjMatrix(Visual.theaterCam, aspect);
    const R = 5.0;     // theater sphere radius (must match _buildTheaterMeshGeometry)
    for (let i = 0; i < layerCount; i++) {
      const d = displays[i];
      if (!d) continue;
      const pose = d.pose || { yaw: 0, pitch: 0 };
      const yr = pose.yaw   * Math.PI / 180;
      const pr = pose.pitch * Math.PI / 180;
      // World-space display center on the rig sphere.
      const wx = R * Math.sin(yr) * Math.cos(pr);
      const wy = R * Math.sin(pr);
      const wz = R * Math.cos(yr) * Math.cos(pr);
      // Project: clip = vpMat * (wx, wy, wz, 1)
      const c0 = vpMat[0]*wx + vpMat[4]*wy + vpMat[8]*wz  + vpMat[12];
      const c1 = vpMat[1]*wx + vpMat[5]*wy + vpMat[9]*wz  + vpMat[13];
      const c3 = vpMat[3]*wx + vpMat[7]*wy + vpMat[11]*wz + vpMat[15];
      if (c3 <= 0.0001) continue;     // behind camera
      const ndcX = c0 / c3;
      const ndcY = c1 / c3;
      const cx = vp.x + (ndcX * 0.5 + 0.5) * vp.w;
      const cy = vp.y + (1 - (ndcY * 0.5 + 0.5)) * vp.h;
      const label = text
        .replace(/\{idx\}/g,  String(i))
        .replace(/\{name\}/g, d.name || ("Display " + (i + 1)))
        .replace(/\{n\}/g,    String(layerCount));
      drawAt(cx, cy, label);
    }
  } else {
    // Single-instance: positioned within the master viewport rect so
    // the text stays inside the actual rendered region (not in the
    // letterbox bars). {idx} / {name} / {n} get a sensible fallback.
    const cx = vp.x + vp.w * x;
    const cy = vp.y + vp.h * y;
    const label = text
      .replace(/\{idx\}/g,  "")
      .replace(/\{name\}/g, "")
      .replace(/\{n\}/g,    String(layerCount));
    drawAt(cx, cy, label);
  }
}

/* Per-frame gizmo render. Cheap — single 280×280 canvas, ~200
 * line segments at most. Hooked into the visual rAF loop so it
 * updates in lockstep with the visual canvas. */
function _drawGizmoFrame() {
  if (!_gizmoOpen) return;
  const canvas = document.getElementById("rig-gizmo-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  const baseScale = Math.min(W, H) * 0.32 * _gizmoCam.scale;
  const cyaw   = _gizmoCam.yaw   * Math.PI / 180;
  const cpitch = _gizmoCam.pitch * Math.PI / 180;
  const ccy = Math.cos(cyaw),  csy = Math.sin(cyaw);
  const ccp = Math.cos(cpitch), csp = Math.sin(cpitch);

  // Project a 3D world point into canvas coords. Returns z too so
  // callers can sort / depth-cue. Orthographic projection — simpler
  // and cleaner-looking than perspective for a tiny gizmo.
  //
  // Camera convention: positive pitch = camera elevated above the
  // rig looking DOWN. Same matrix shape as the display rotation
  // (y2 = y*cp + z*sp) so both pitch axes follow the same right-
  // hand convention.
  function project(p) {
    let x = p[0], y = p[1], z = p[2];
    // Camera yaw around Y
    const x1 = x * ccy - z * csy;
    const z1 = x * csy + z * ccy;
    x = x1; z = z1;
    // Camera pitch around X
    const y2 = y * ccp + z * csp;
    const z2 = -y * csp + z * ccp;
    y = y2; z = z2;
    return { x: cx + x * baseScale, y: cy - y * baseScale, z: z };
  }

  // Phase 6.6.15 — render the actual screen surface based on
  // rig.surface (sphere / cylinder / plane / free). Shown only when
  // rig.surfaceVisible is true; toggled off treats the rig as
  // monitors and the gizmo just shows frustums + sweet-spot.
  // Sphere is drawn at unit radius regardless of surface.radius
  // because the gizmo uses normalized coords matching frustum
  // corners; sweet-spot positions are scaled by 1/surface.radius
  // so an audience at sphere-center renders at gizmo origin even
  // for non-default radii.
  const rigSurface = (state && state.rig && state.rig.surface) || null;
  const surfVisibleNow = !!(state && state.rig && state.rig.surfaceVisible !== false);

  function drawLatRing(pitchDeg, color) {
    const py = pitchDeg * Math.PI / 180;
    const r = Math.cos(py);
    const y = Math.sin(py);
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = i / 64 * 2 * Math.PI;
      const p = project([r * Math.cos(a), y, r * Math.sin(a)]);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  function drawMeridians(brightCardinal, dimRest) {
    for (let m = 0; m < 12; m++) {
      const yaw0 = m * Math.PI / 6;
      const isCardinal = (m % 3 === 0);
      ctx.beginPath();
      for (let i = -8; i <= 8; i++) {
        const pitch = i / 8 * (Math.PI / 2 - 0.05);
        const x = Math.sin(yaw0) * Math.cos(pitch);
        const y = Math.sin(pitch);
        const z = Math.cos(yaw0) * Math.cos(pitch);
        const p = project([x, y, z]);
        if (i === -8) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = isCardinal ? brightCardinal : dimRest;
      ctx.stroke();
    }
  }
  function drawCylinder(length, radius) {
    const halfL = length * 0.5;
    // Top + bottom rings
    for (const y of [-halfL, halfL]) {
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = i / 64 * 2 * Math.PI;
        const p = project([radius * Math.cos(a), y, radius * Math.sin(a)]);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = "rgba(200, 232, 90, 0.18)";
      ctx.stroke();
    }
    // 12 vertical lines connecting top + bottom
    for (let m = 0; m < 12; m++) {
      const a = m * Math.PI / 6;
      const x = radius * Math.cos(a), z = radius * Math.sin(a);
      const top = project([x, halfL, z]);
      const bot = project([x, -halfL, z]);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y);
      ctx.strokeStyle = (m % 3 === 0)
        ? "rgba(200, 232, 90, 0.12)"
        : "rgba(200, 232, 90, 0.05)";
      ctx.stroke();
    }
  }
  function drawPlane(z, w, h) {
    const halfW = w * 0.5, halfH = h * 0.5;
    const corners = [
      project([-halfW, -halfH, z]),
      project([ halfW, -halfH, z]),
      project([ halfW,  halfH, z]),
      project([-halfW,  halfH, z])
    ];
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.strokeStyle = "rgba(200, 232, 90, 0.22)";
    ctx.stroke();
    // Cross at center
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y); ctx.lineTo(corners[2].x, corners[2].y);
    ctx.moveTo(corners[1].x, corners[1].y); ctx.lineTo(corners[3].x, corners[3].y);
    ctx.strokeStyle = "rgba(200, 232, 90, 0.06)";
    ctx.stroke();
  }

  // 6.6.20 — generalized swept-surface wireframe. Draws latitude
  // rings (along the path direction) and meridians (along the
  // profile direction) over the visible yaw + pitch range. Used for
  // type:"swept" but also as the engine for type:"sphere" /
  // type:"cylinder" — those just dispatch to a hardcoded preset.
  function drawSweptSurface(surface) {
    const profile = surface.profile || {};
    const path = surface.path || { yawStart: -180, yawEnd: 180 };
    const yawStartDeg = path.yawStart || -180;
    const yawEndDeg   = path.yawEnd   ||  180;
    const yawStart = yawStartDeg * Math.PI / 180;
    const yawEnd   = yawEndDeg   * Math.PI / 180;
    const yawSpan  = yawEnd - yawStart;

    if (profile.kind === "arc") {
      const p0 = (profile.pitchStart || -90) * Math.PI / 180;
      const p1 = (profile.pitchEnd   ||  90) * Math.PI / 180;
      // Latitude rings: 5 evenly spaced across the profile range,
      // plus the equator (pitch=0) if it's inside that range.
      const ringPitches = [];
      const pitchCount = 5;
      for (let i = 0; i <= pitchCount; i++) {
        ringPitches.push(p0 + (p1 - p0) * (i / pitchCount));
      }
      if (p0 < 0 && p1 > 0) ringPitches.push(0);   // equator emphasis
      ringPitches.sort();
      for (const pitch of ringPitches) {
        const isEquator = Math.abs(pitch) < 0.001;
        const isEdge = Math.abs(pitch - p0) < 0.001 || Math.abs(pitch - p1) < 0.001;
        const ringR = Math.cos(pitch);
        const yL = Math.sin(pitch);
        const color = (isEdge || isEquator)
          ? "rgba(200, 232, 90, 0.22)"
          : "rgba(200, 232, 90, 0.07)";
        ctx.beginPath();
        const segs = 64;
        for (let j = 0; j <= segs; j++) {
          const a = yawStart + yawSpan * (j / segs);
          const p = project([ringR * Math.sin(a), yL, ringR * Math.cos(a)]);
          if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // Meridians: density follows the yaw span. 12 over a full
      // revolution, fewer for narrower arcs.
      const meridiansPerRev = 12;
      const meridiansVisible = Math.max(2, Math.round(meridiansPerRev * Math.abs(yawSpan) / (2 * Math.PI)));
      for (let m = 0; m <= meridiansVisible; m++) {
        const yaw = yawStart + yawSpan * (m / Math.max(1, meridiansVisible));
        const yawDeg = yaw * 180 / Math.PI;
        const isCardinal = (m === 0) || (m === meridiansVisible) ||
                           (Math.abs(yawDeg % 90) < 1);
        const color = isCardinal
          ? "rgba(200, 232, 90, 0.12)"
          : "rgba(200, 232, 90, 0.05)";
        ctx.beginPath();
        const segs = 32;
        for (let j = 0; j <= segs; j++) {
          const pitch = p0 + (p1 - p0) * (j / segs);
          const x = Math.cos(pitch) * Math.sin(yaw);
          const yL = Math.sin(pitch);
          const z = Math.cos(pitch) * Math.cos(yaw);
          const p = project([x, yL, z]);
          if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    } else if (profile.kind === "vertical") {
      // Cylinder segment. Normalize Y range by radius so the gizmo
      // shape is consistent regardless of absolute scale.
      const R = profile.radius || 5;
      const yScale = 1 / R;
      const yLo = (profile.yMin || -1) * yScale;
      const yHi = (profile.yMax ||  1) * yScale;
      // Top + bottom rings.
      for (const y of [yLo, yHi]) {
        ctx.beginPath();
        const segs = 64;
        for (let j = 0; j <= segs; j++) {
          const a = yawStart + yawSpan * (j / segs);
          const p = project([Math.sin(a), y, Math.cos(a)]);
          if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = "rgba(200, 232, 90, 0.18)";
        ctx.stroke();
      }
      // Vertical edge lines.
      const yawCount = Math.max(2, Math.round(12 * Math.abs(yawSpan) / (2 * Math.PI)));
      for (let m = 0; m <= yawCount; m++) {
        const yaw = yawStart + yawSpan * (m / Math.max(1, yawCount));
        const yawDeg = yaw * 180 / Math.PI;
        const isCardinal = (m === 0) || (m === yawCount) ||
                           (Math.abs(yawDeg % 90) < 1);
        const x = Math.sin(yaw), z = Math.cos(yaw);
        const top = project([x, yHi, z]);
        const bot = project([x, yLo, z]);
        ctx.beginPath();
        ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y);
        ctx.strokeStyle = isCardinal
          ? "rgba(200, 232, 90, 0.12)"
          : "rgba(200, 232, 90, 0.05)";
        ctx.stroke();
      }
    }
  }

  if (surfVisibleNow && rigSurface) {
    if (rigSurface.type === "sphere") {
      drawLatRing(-60, "rgba(200, 232, 90, 0.07)");
      drawLatRing(-30, "rgba(200, 232, 90, 0.07)");
      drawLatRing(  0, "rgba(200, 232, 90, 0.22)");
      drawLatRing( 30, "rgba(200, 232, 90, 0.07)");
      drawLatRing( 60, "rgba(200, 232, 90, 0.07)");
      drawMeridians("rgba(200, 232, 90, 0.12)", "rgba(200, 232, 90, 0.05)");
    } else if (rigSurface.type === "cylinder") {
      // Normalize cylinder dims so the rendered radius matches the
      // frustum-corner unit sphere. length is scaled the same way.
      const r = 1;
      const L = (rigSurface.length || 5) / (rigSurface.radius || 5);
      drawCylinder(L, r);
    } else if (rigSurface.type === "swept") {
      drawSweptSurface(rigSurface);
    } else if (rigSurface.type === "plane") {
      drawPlane(1, 1.5, 1.0);
    } else {
      // Free / unknown — faint orientation reference only.
      drawLatRing(0, "rgba(200, 232, 90, 0.05)");
    }
  } else {
    // Surface viz off — keep just the equator as a faint orientation
    // ref so frustums still have a horizon to relate to.
    drawLatRing(0, "rgba(200, 232, 90, 0.05)");
  }

  // RGB axes — X red, Y green, Z violet — labeled on the +ends.
  function drawAxis(dir, color, label) {
    const o = project([0, 0, 0]);
    const e = project([dir[0] * 1.18, dir[1] * 1.18, dir[2] * 1.18]);
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(e.x, e.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "10px JetBrains Mono, monospace";
    ctx.fillText(label, e.x + 3, e.y - 2);
  }
  drawAxis([1, 0, 0], "rgba(226, 75, 74, 0.7)",  "X");
  drawAxis([0, 1, 0], "rgba(29, 158, 117, 0.7)", "Y");
  drawAxis([0, 0, 1], "rgba(127, 119, 221, 0.7)","Z");

  // Display frustums — z-sort by mean depth so back ones draw first
  // (preserves "closer wins" ordering in wireframe-painters fashion).
  // 6.6.20+: when a curved screen is active, the frustum FACE wraps
  // onto the actual screen surface (sphere/cylinder/swept) rather
  // than sitting at depth=1 as a flat quad. We tessellate the face
  // into a grid + project each grid vertex onto the normalized
  // screen — this shows AlloSphere / dome / bowl curvature directly
  // on each display tile.
  const displays = (state && state.rig && state.rig.displays) || [];
  const defaultEB = _defaultEdgeBlend();
  const isCustomBlend = (eb) => !eb ||
    eb.gamma     !== defaultEB.gamma ||
    eb.blackLift !== defaultEB.blackLift ||
    eb.power     !== defaultEB.power;
  const gizmoSurface = surfVisibleNow ? _normalizeSurfaceForGizmo(rigSurface) : null;
  const useCurvedFrustum = !!gizmoSurface;
  const FACE_TESS = useCurvedFrustum ? 6 : 1;   // 6×6 grid wraps smoothly
  const frustums = [];
  for (let i = 0; i < displays.length; i++) {
    const d = displays[i];
    if (!d) continue;
    const pose = d.pose || { yaw: 0, pitch: 0, roll: 0 };
    const fov  = d.fov  || { h: 90, v: 60 };
    const hH = Math.tan(fov.h * Math.PI / 360);
    const hV = Math.tan(fov.v * Math.PI / 360);
    const r = (p) => _rotateDisplayPoint(p, pose.yaw, pose.pitch);

    // Tessellated face — (FACE_TESS+1)² grid points. For flat (no
    // curved screen) this is just a 2×2 grid = the original 4
    // corners. For curved screens, the grid points get projected
    // onto the unit-normalized screen.
    const N = FACE_TESS + 1;
    const faceGrid = new Array(N * N);
    let zSum = 0;
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const u = (col / FACE_TESS) * 2 - 1;
        const v = (row / FACE_TESS) * 2 - 1;
        // Beam direction through frustum NDC (u, v).
        const beam = r([u * hH, v * hV, 1]);
        let pt;
        if (useCurvedFrustum) {
          const hit = _screenProjectionPoint(beam, gizmoSurface, 1);
          pt = hit || beam;
        } else {
          pt = beam;
        }
        const proj = project(pt);
        faceGrid[row * N + col] = proj;
        zSum += proj.z;
      }
    }
    // Outer perimeter for the face outline + frustum-face fill (in
    // CW order: top-left → top-right → bottom-right → bottom-left).
    // This still works for the flat case (4 actual corners) and for
    // curved (the 4 grid corners — face fill is a polygon of just
    // the outline, interior is drawn via grid quads when curved).
    const corners = [
      faceGrid[0],
      faceGrid[FACE_TESS],
      faceGrid[N * N - 1],
      faceGrid[(N - 1) * N]
    ];
    const apex = project([0, 0, 0]);
    frustums.push({
      idx: i, corners, apex,
      faceGrid, faceN: N,
      meanZ: zSum / (N * N),
      // Phase 6.6.4b — flag warp + blend so the frustum stroke can
      // signal calibration state without an extra badge layer.
      hasWarp:    !!d.warpMesh,
      isTestWarp: !!(d.warpMesh && d.warpMesh._isTest),
      hasBlend:   isCustomBlend(d.edgeBlend)
    });
  }
  frustums.sort((a, b) => b.meanZ - a.meanZ);   // back to front

  for (const f of frustums) {
    const hue = (f.idx / Math.max(1, displays.length)) * 360;
    // Calibration state changes the stroke style so warped / blended
    // displays read at a glance. Test mesh = dashed violet; calibrated
    // mesh = solid violet; non-default blend params = red rim.
    let stroke = "hsla(" + hue + ", 70%, 65%, 0.92)";
    let fill   = "hsla(" + hue + ", 70%, 55%, 0.18)";
    if (f.hasWarp) {
      stroke = f.isTestWarp
        ? "rgba(170, 162, 240, 0.95)"
        : "rgba(127, 119, 221, 0.95)";
      fill   = "rgba(127, 119, 221, 0.16)";
    }
    if (f.hasBlend) {
      stroke = "rgba(240, 130, 130, 0.95)";
      fill   = "rgba(226, 75, 74, 0.16)";
    }
    // Quad face. 6.6.20+: when curved screen is active, we have a
    // tessellated grid of points wrapped onto the screen — fill it
    // by tracing the outer perimeter, then stroke each grid line so
    // the curvature reads visually. Flat case (faceN=2) collapses
    // back to the original 4-corner quad.
    const N = f.faceN;
    if (N > 2) {
      // Outer perimeter polygon for the fill — top edge, right edge,
      // reversed bottom, reversed left.
      ctx.beginPath();
      const moveTo = (p, first) => first ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      let firstPt = true;
      for (let c = 0; c < N; c++)        { moveTo(f.faceGrid[c],                 firstPt); firstPt = false; }
      for (let r = 1; r < N; r++)        { moveTo(f.faceGrid[r * N + (N - 1)],   firstPt); firstPt = false; }
      for (let c = N - 2; c >= 0; c--)   { moveTo(f.faceGrid[(N - 1) * N + c],   firstPt); firstPt = false; }
      for (let r = N - 2; r > 0; r--)    { moveTo(f.faceGrid[r * N],             firstPt); firstPt = false; }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      // Stroke the whole grid: horizontal lines per row + vertical
      // lines per column. The curvature shows in the bow of each
      // line on a sphere/swept surface.
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.0;
      if (f.hasWarp && f.isTestWarp) ctx.setLineDash([3, 2]);
      for (let r = 0; r < N; r++) {
        ctx.beginPath();
        for (let c = 0; c < N; c++) {
          const p = f.faceGrid[r * N + c];
          if (c === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      for (let c = 0; c < N; c++) {
        ctx.beginPath();
        for (let r = 0; r < N; r++) {
          const p = f.faceGrid[r * N + c];
          if (r === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    } else {
      // Flat quad fast path (legacy 6.6.4b behavior).
      ctx.beginPath();
      ctx.moveTo(f.corners[0].x, f.corners[0].y);
      for (let c = 1; c < 4; c++) ctx.lineTo(f.corners[c].x, f.corners[c].y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.2;
      if (f.hasWarp && f.isTestWarp) ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Apex-to-corner edges — always to the 4 outer corners regardless
    // of tessellation density, so the frustum reads as "lines from the
    // projector to each corner of the projected patch."
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;
    if (f.hasWarp && f.isTestWarp) ctx.setLineDash([3, 2]);
    ctx.beginPath();
    for (const c of f.corners) {
      ctx.moveTo(f.apex.x, f.apex.y);
      ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Index label at frustum face center, with W/B suffixes when the
    // frustum is warped/blended. Color alone is not enough — the
    // suffixes survive monochrome capture and color-blind viewing.
    // For curved tessellation, use the actual face center grid point
    // so the label sits on the curve, not at a polygon centroid that
    // could be inside the screen.
    let lx, ly;
    if (N > 2) {
      const mid = f.faceGrid[Math.floor(N / 2) * N + Math.floor(N / 2)];
      lx = mid.x; ly = mid.y;
    } else {
      lx = 0; ly = 0;
      for (const c of f.corners) { lx += c.x; ly += c.y; }
      lx /= 4; ly /= 4;
    }
    ctx.fillStyle = stroke;
    ctx.font = "bold 11px JetBrains Mono, monospace";
    let label = String(f.idx);
    if (f.hasWarp)  label += "·W";
    if (f.hasBlend) label += "·B";
    ctx.fillText(label, lx - (label.length * 3.2), ly + 4);
  }

  // Shader-center direction arrow — only drawn when the user has
  // shifted the center off the rig's natural origin.
  const sCY = (state.rig && state.rig.shaderCenterYaw)   || 0;
  const sCP = (state.rig && state.rig.shaderCenterPitch) || 0;
  if (sCY !== 0 || sCP !== 0) {
    const dir = _yawPitchToVec(sCY, sCP);
    const o = project([0, 0, 0]);
    const e = project([dir[0] * 1.4, dir[1] * 1.4, dir[2] * 1.4]);
    ctx.strokeStyle = "rgba(200, 232, 90, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    ctx.fillStyle = "rgba(200, 232, 90, 0.95)";
    ctx.beginPath();
    ctx.arc(e.x, e.y, 3.5, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Phase 6.6.15 — sweet-spot marker. Tiny accent circle at the
  // sweet-spot's normalized 3D position so the user can see where
  // the audience-view origin sits relative to displays + screen.
  // Only drawn when the surface is visible AND the sweet-spot is
  // explicitly off-origin (otherwise it's just a dot at canvas
  // center, redundant with the axes).
  if (surfVisibleNow && state && state.rig && Array.isArray(state.rig.sweetSpot)) {
    const ss = state.rig.sweetSpot;
    const refRadius = (rigSurface && (rigSurface.radius || rigSurface.offset)) || 5;
    const sx = ss[0] / refRadius;
    const sy = ss[1] / refRadius;
    const sz = ss[2] / refRadius;
    if (Math.hypot(sx, sy, sz) > 0.001) {
      const sp = project([sx, sy, sz]);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(220, 240, 130, 0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(8, 11, 16, 0.9)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = "rgba(220, 240, 130, 0.85)";
      ctx.font = "8px JetBrains Mono, monospace";
      ctx.fillText("◉", sp.x + 5, sp.y - 3);
    }
  }

  // Camera-orientation badge — corner pip showing roughly where
  // "north" (yaw 0) is on the canvas. Helps reorient after orbit.
  const north = project([0, 0, 1.05]);
  ctx.fillStyle = "rgba(200, 232, 90, 0.55)";
  ctx.font = "9px JetBrains Mono, monospace";
  ctx.fillText("N", north.x - 3, north.y);
}

/* Wire camera-orbit + zoom on the gizmo canvas. Set up once on
 * first toggle-open via _wireGizmoCanvas; subsequent opens reuse
 * the existing handlers. */
let _gizmoWired = false;
function _wireGizmoCanvas() {
  if (_gizmoWired) return;
  const canvas = document.getElementById("rig-gizmo-canvas");
  if (!canvas) return;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    _gizmoDrag = {
      px: e.clientX, py: e.clientY,
      yaw0: _gizmoCam.yaw, pitch0: _gizmoCam.pitch
    };
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!_gizmoDrag) return;
    const dx = e.clientX - _gizmoDrag.px;
    const dy = e.clientY - _gizmoDrag.py;
    _gizmoCam.yaw   = _gizmoDrag.yaw0 + dx * 0.5;
    _gizmoCam.pitch = Math.max(-85, Math.min(85, _gizmoDrag.pitch0 + dy * 0.5));
  });
  const endDrag = (e) => {
    if (!_gizmoDrag) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    _gizmoDrag = null;
  };
  canvas.addEventListener("pointerup",     endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    _gizmoCam.scale *= e.deltaY < 0 ? 1.12 : (1 / 1.12);
    _gizmoCam.scale = Math.max(0.25, Math.min(4, _gizmoCam.scale));
  }, { passive: false });
  _gizmoWired = true;
}

