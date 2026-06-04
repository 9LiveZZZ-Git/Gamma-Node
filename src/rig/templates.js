/* Edge-blend parameter defaults. These are the values applied by the
 * blend WGSL pass (Phase 6.6.5–6.6.8). Gamma 2.2 matches the standard
 * sRGB → linear gamma — applying it before blending and reversing
 * after gives perceptually-uniform brightness across the overlap.
 * blackLift and power start at "no perceptual effect" so a default-
 * configured rig that hasn't been hand-tuned simply renders the
 * identity blend. */
function _defaultEdgeBlend() {
  return { gamma: 2.2, blackLift: 0, power: 2.0 };
}

/* Validate edge-blend params loaded from .gpatch. Numbers must be
 * finite; gamma > 0 (avoid divide-by-zero); blackLift in [0, 1];
 * power > 0. Returns a clean object with any invalid fields replaced
 * by defaults. */
function _migrateEdgeBlend(eb) {
  const def = _defaultEdgeBlend();
  if (!eb || typeof eb !== "object") return def;
  const out = {
    gamma:     Number.isFinite(eb.gamma)     && eb.gamma     > 0 ? eb.gamma     : def.gamma,
    blackLift: Number.isFinite(eb.blackLift) && eb.blackLift >= 0 && eb.blackLift <= 1 ? eb.blackLift : def.blackLift,
    power:     Number.isFinite(eb.power)     && eb.power     > 0 ? eb.power     : def.power
  };
  return out;
}

function _makeDisplay(id, name, overrides) {
  return Object.assign({
    id,
    name,
    pose:      { yaw: 0, pitch: 0, roll: 0 },
    fov:       { h: 90, v: 60 },
    aspect:    16 / 9,
    curvature: 0,
    // Phase 6.6 — calibration warp + edge blend. null = no warp,
    // fullscreen-triangle pipeline. Becomes a Bourke mesh once the
    // user runs the warp editor (6.6.9) or imports MPCDI (6.6.2).
    warpMesh:  null,
    edgeBlend: _defaultEdgeBlend(),
    // Phase 6.6.20.16 — AI v3 keystone corner offsets. 8 floats in
    // NDC space (~ ±2 unit framebuffer). Applied AFTER auto-warp +
    // auto-blend as a bilinear shift across the mesh, so they
    // persist across auto-prep regenerations. Default 0; AI v3
    // proposes deltas during iterative calibration.
    keystoneCorners: { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 },
    // Phase 6.6.20.17 — AI v4 Bezier interior corrections. 5×5
    // grid of NDC offsets (50 floats) — mostly 0, populated
    // sparsely by Bezier fine-tune. Applied AFTER keystone via
    // tensor-product Bezier eval — each control point's offset
    // smoothly blends into the mesh interior. Default null; lazy-
    // inits when first non-zero adjustment applied.
    bezierCorrections: null,
    worldUv:   { minU: 0, minV: 0, maxU: 1, maxV: 1 }
  }, overrides);
}

/* Catalog of rig templates. Each builds a display list from a single
 * key. The math for cylindrical / spherical layouts:
 *   - Cylindrical: yaws spaced evenly around the azimuth covered by
 *     the rig (90° for quarter, 180° for half, 360° for full). Each
 *     display's worldUv.u range is its azimuth slice / total
 *     azimuth. v range is full [0,1].
 *   - Cube: 6 displays each looking down a cardinal axis (front /
 *     back / left / right / up / down). worldUv slices a cubemap
 *     unfold into 6 rectangles.
 *   - AlloSphere-like: 16 displays in a partial sphere matching the
 *     practical AlloSphere coverage (~360° H × ~150° V on a bisected
 *     sphere). worldUv slices an equirect master into 16 rects in a
 *     4-cols × 4-rows arrangement that approximates the dome's
 *     projector layout. Real AlloSphere has 26 projectors; 16 is
 *     the "consumer-class" approximation per docs/DISTRIBUTED-RIG.md
 *     §9.3. */
const RIG_TEMPLATES = {
  single: {
    label: "Single (1 display)",
    surface: { type: "plane", normal: [0, 0, 1], offset: 5 },
    build: () => [_makeDisplay("d0", "Display 1", {
      pose: { yaw: 0, pitch: 0, roll: 0 },
      fov:  { h: 90, v: 60 },
      worldUv: { minU: 0, minV: 0, maxU: 1, maxV: 1 }
    })]
  },
  "side-by-side": {
    label: "Side-by-side (2 flat)",
    surface: { type: "plane", normal: [0, 0, 1], offset: 5 },
    build: () => [
      _makeDisplay("d0", "Left", {
        pose: { yaw: -45, pitch: 0, roll: 0 },
        fov:  { h: 90, v: 60 },
        worldUv: { minU: 0,   minV: 0, maxU: 0.5, maxV: 1 }
      }),
      _makeDisplay("d1", "Right", {
        pose: { yaw:  45, pitch: 0, roll: 0 },
        fov:  { h: 90, v: 60 },
        worldUv: { minU: 0.5, minV: 0, maxU: 1,   maxV: 1 }
      })
    ]
  },
  "quarter-wrap": {
    label: "Quarter-wrap (4 flat, 90°)",
    surface: { type: "cylinder", radius: 5, axis: [0, 1, 0], length: 5, center: [0, 0, 0] },
    build: () => _evenAzimuthRing(4, 90, "Q")
  },
  "half-wrap": {
    label: "Half-wrap (8 flat, 180°)",
    surface: { type: "cylinder", radius: 5, axis: [0, 1, 0], length: 5, center: [0, 0, 0] },
    build: () => _evenAzimuthRing(8, 180, "H")
  },
  "full-wrap-16": {
    label: "Full-wrap (16 flat, 360°)",
    surface: { type: "cylinder", radius: 5, axis: [0, 1, 0], length: 5, center: [0, 0, 0] },
    build: () => _evenAzimuthRing(16, 360, "F")
  },
  cube: {
    label: "Cube (6 faces)",
    // Cube isn't a quadric — surface is a 6-faced polyhedron, marked
    // "free" so auto-warp falls back to identity. Sweet-spot defaults
    // to origin (cube center).
    surface: { type: "free" },
    build: () => {
      const pose = (yaw, pitch) => ({ yaw, pitch, roll: 0 });
      // Standard cubemap unfold: 4 sides + top + bottom in a 4×3 layout
      // but compressed into a 1×6 row in the master canvas for
      // simplicity. Each face is 1/6th of the master width.
      const f = 1 / 6;
      const fov = { h: 90, v: 90 };
      return [
        _makeDisplay("front",  "+Z front",  { pose: pose(0,    0),  fov, worldUv: { minU: 0*f, minV: 0, maxU: 1*f, maxV: 1 } }),
        _makeDisplay("right",  "+X right",  { pose: pose(90,   0),  fov, worldUv: { minU: 1*f, minV: 0, maxU: 2*f, maxV: 1 } }),
        _makeDisplay("back",   "-Z back",   { pose: pose(180,  0),  fov, worldUv: { minU: 2*f, minV: 0, maxU: 3*f, maxV: 1 } }),
        _makeDisplay("left",   "-X left",   { pose: pose(-90,  0),  fov, worldUv: { minU: 3*f, minV: 0, maxU: 4*f, maxV: 1 } }),
        _makeDisplay("top",    "+Y top",    { pose: pose(0,   90),  fov, worldUv: { minU: 4*f, minV: 0, maxU: 5*f, maxV: 1 } }),
        _makeDisplay("bottom", "-Y bottom", { pose: pose(0,  -90),  fov, worldUv: { minU: 5*f, minV: 0, maxU: 6*f, maxV: 1 } })
      ];
    }
  },
  "allosphere-like": {
    label: "AlloSphere-like (16 partial sphere)",
    surface: { type: "sphere", radius: 5, center: [0, 0, 0] },
    build: () => {
      // 4 columns × 4 rows on a partial sphere. Vertical FOV ≈ 150°
      // (bisected sphere), horizontal 360°. Each cell is one display.
      // worldUv tiles the equirect master into a 4×4 grid.
      const cols = 4, rows = 4;
      const out = [];
      const cellW = 1 / cols;
      const cellH = 1 / rows;
      const azimuthStep   = 360 / cols;
      const elevationStep = 150 / rows;   // partial sphere: 150° vertical
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const yaw   = -180 + (c + 0.5) * azimuthStep;        // span -180..180
          const pitch =  -75 + (r + 0.5) * elevationStep;      // span -75..75
          out.push(_makeDisplay("a" + idx, "Allo-" + (idx + 1), {
            pose: { yaw, pitch, roll: 0 },
            fov:  { h: azimuthStep, v: elevationStep },
            curvature: 22,   // soft curve, ≈ projector throw aperture
            worldUv: {
              minU: c * cellW, minV: r * cellH,
              maxU: (c + 1) * cellW, maxV: (r + 1) * cellH
            }
          }));
        }
      }
      return out;
    }
  },
  "allosphere-real": {
    label: "AlloSphere (real 26-projector layout)",
    surface: { type: "sphere", radius: 5, center: [0, 0, 0] },
    build: () => {
      // The real UCSB AlloSphere has 26 projectors arranged
      // asymmetrically across two listening hemispheres separated by
      // a catwalk seam at the equator. Ring counts approximate the
      // published "14 upper / 12 lower" channel split: more density
      // near the catwalk (where projector mounts have line-of-sight)
      // and sparser near the poles (which need wider-FOV optics).
      //
      // Rings (top → bottom):
      //   +60°: 5 projectors  ┐
      //   +20°: 9 projectors  ┘ 14 upper hemisphere
      //   ---  catwalk gap (no projectors near 0°)  ---
      //   -20°: 8 projectors  ┐
      //   -60°: 4 projectors  ┘ 12 lower hemisphere
      //
      // FOVs are sized to overlap slightly within each ring (azimuth
      // step + ~10% bleed) and to bridge between rings (~50° vertical
      // FOV per projector). worldUv tiles the equirect master in a
      // ring-by-ring band layout: top band 0..1/4 V, mid-top 1/4..2/4,
      // mid-bot 2/4..3/4, bottom 3/4..1.
      const rings = [
        { pitch:  60, count: 5, vBand: [0,    0.22] },
        { pitch:  20, count: 9, vBand: [0.22, 0.50] },
        { pitch: -20, count: 8, vBand: [0.50, 0.78] },
        { pitch: -60, count: 4, vBand: [0.78, 1.00] }
      ];
      const out = [];
      let idx = 0;
      for (const ring of rings) {
        const fovH = (360 / ring.count) * 1.10;     // 10% azimuth bleed
        const fovV = 50;
        const cellU = 1 / ring.count;
        for (let i = 0; i < ring.count; i++) {
          const yaw = -180 + (i + 0.5) * (360 / ring.count);
          out.push(_makeDisplay("ar" + idx, "Allo-" + (idx + 1), {
            pose: { yaw, pitch: ring.pitch, roll: 0 },
            fov:  { h: fovH, v: fovV },
            curvature: 30,   // sphere screen curve, dome-projection style
            worldUv: {
              minU:  i      * cellU, minV: ring.vBand[0],
              maxU: (i + 1) * cellU, maxV: ring.vBand[1]
            }
          }));
          idx++;
        }
      }
      return out;
    }
  }
};

/* Helper for cylindrical-wrap templates: N displays evenly spaced
 * across a horizontal arc of `azimuthDeg` total. Each display gets an
 * equal slice of worldUv along U. */
function _evenAzimuthRing(n, azimuthDeg, prefix) {
  const out = [];
  const fovH = azimuthDeg / n;
  const start = -azimuthDeg / 2;
  for (let i = 0; i < n; i++) {
    const yaw = start + (i + 0.5) * fovH;
    out.push(_makeDisplay(prefix + i, prefix + (i + 1), {
      pose: { yaw, pitch: 0, roll: 0 },
      fov:  { h: fovH, v: 60 },
      worldUv: {
        minU: i / n,       minV: 0,
        maxU: (i + 1) / n, maxV: 1
      }
    }));
  }
  return out;
}

/* Replace the rig's display list with the catalog template's output.
 * Preserves rig-level settings (masterRes, previewMode) so the user's
 * choice of resolution + projection survives a template swap. */
function applyRigTemplate(key) {
  const t = RIG_TEMPLATES[key];
  if (!t) return;
  pushHistory("rig-template:" + key);
  if (!state.rig) state.rig = defaultRig();
  state.rig.templateKey = key;
  state.rig.displays    = t.build();
  // Phase 6.6.14 — propagate the template's screen-surface descriptor
  // and re-derive the sweet-spot. Templates without an explicit surface
  // get a "free" default so auto-warp falls through to identity. The
  // sweet-spot is freshly derived because the user picking a new
  // template implies they want the canonical viewing position for
  // that geometry; if they tweak it after, their override persists
  // until the next template change.
  state.rig.surface   = _migrateRigSurface(t.surface || { type: "free" });
  state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface);
  // Reset the theater camera to the new sweet-spot so the next
  // entry to theater preview spawns the user at the canonical
  // viewing position. Yaw/pitch keep their last orientation —
  // changing positions but staying "facing" the same way is less
  // disorienting than a full reset.
  if (Visual && Visual.theaterCam) {
    Visual.theaterCam.pos[0] = state.rig.sweetSpot[0];
    Visual.theaterCam.pos[1] = state.rig.sweetSpot[1];
    Visual.theaterCam.pos[2] = state.rig.sweetSpot[2];
  }
  // Validate that any VisualOutput nodes still point at a valid
  // display index. Anything pointing past the new display count gets
  // clamped to the last available display.
  const max = state.rig.displays.length - 1;
  state.nodes.forEach(n => {
    if (n.type === "VisualOutput" && n.params && typeof n.params.display === "number") {
      if (n.params.display > max) n.params.display = max;
    }
  });
  // Phase 6.6.11 — auto-apply blend on template change. Templates
  // with overlapping pose footprints (allosphere-real with its 10%
  // azimuth bleed) get intensity ramps for free; templates without
  // overlap (single, side-by-side, quarter-wrap, etc.) skip silently
  // since _applyAutoBlendToRig no-ops on isolated displays. Saves a
  // click in the AlloSphere case, never penalizes the others.
  // skipHistory: outer pushHistory is the single undo entry for the
  // whole template+blend bundle.
  // keepTemplate: this IS the template apply path — don't flip to
  // "custom" since the dropdown still reflects the picked template.
  _applyAutoBlendToRig({ skipHistory: true, keepTemplate: true });
  // Phase 6.5.5 — display count changed → reallocate the texture array
  // + rebuild bind groups so subsequent renders target the new layer
  // count. Skips silently if the GPU device hasn't acquired yet
  // (ensureGPUDevice will run the alloc when it does).
  if (Visual.device) {
    _allocateFramebuffer();
    _rebuildBlitBindGroup();
    _rebuildRigCompositeBindGroup();
    _rebuildWarpBindGroup();
    _rebuildTheaterBindGroup();
  }
  render();
  renderProps && renderProps();
}

