function applyView() {
  const cw = document.getElementById("canvas-world");
  if (cw) cw.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  const hud = document.getElementById("view-hud");
  if (hud) hud.textContent = Math.round(view.zoom * 100) + "%";
}
function resetView() {
  view.panX = 0; view.panY = 0; view.zoom = 1;
  applyView();
}
function screenToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - view.panX) / view.zoom,
    y: (clientY - rect.top - view.panY) / view.zoom
  };
}

function uid() { return "n" + (nextId++); }
function nodeById(id) { return state.nodes.find(n => n.id === id); }
/* Returns the effective definition for a node -- the base TYPES
 * entry merged with any per-node override (node.override). Used by
 * codegen + rendering everywhere, so editing node.override is the
 * single hook for the per-node code editor (E key / bottom-edge ✎
 * button) to change C++ source, port lists, and setter wiring.
 *
 * Override shape (all fields optional):
 *   { cppType, helperClass, header, ins, outs, methods, gateMethods,
 *     template, noSigArg }
 *
 * Field merge uses an "in ov" check rather than null-coalescing so
 * an override can explicitly set a field to null (or false, or "")
 * to DROP an inherited base value. Concrete use: when a template-
 * only node (Mul, Add, ...) is converted to a real helperClass,
 * we set override.template = null so codegen takes the cppType
 * path instead of inlining the template. */
function defOf(node) {
  const base = TYPES[node.type];
  if (!node || !node.override || !base) return base;
  const ov = node.override;
  const merged = { ...base };
  if ("cppType"     in ov) merged.cppType     = ov.cppType;
  if ("helperClass" in ov) merged.helperClass = ov.helperClass;
  if ("header"      in ov) merged.header      = ov.header;
  if ("ins"         in ov) merged.ins         = ov.ins;
  if ("outs"        in ov) merged.outs        = ov.outs;
  if ("methods"     in ov) merged.methods     = ov.methods;
  if ("gateMethods" in ov) merged.gateMethods = ov.gateMethods;
  if ("template"    in ov) merged.template    = ov.template;
  if ("noSigArg"    in ov) merged.noSigArg    = ov.noSigArg;
  if ("extraCtor"   in ov) merged.extraCtor   = ov.extraCtor;
  return merged;
}

function freshState() {
  return {
    version: 2,
    patchName: "MyPatch",
    nodes: [], edges: [], exposed: {},
    /* Groups: visual organization layer over the flat node graph.
     * Each entry is { id, name, collapsed, members: [nodeIds] }.
     * Members are by ID; a node belongs to at most one group. The
     * codegen path is unaware of groups — they're purely a UI
     * abstraction. When collapsed, member nodes hide and the group
     * renders as a single block with port stubs derived from
     * cross-boundary edges. */
    groups: [],
    /* Phase 6.5 — distributed display rig. The rig is a list of N
     * virtual displays + a global preview-projection mode + a master
     * resolution shared by all displays in 6.5 (per-display res
     * comes in 6.6). Each VisualOutput.display param indexes into
     * rig.displays.
     *
     * worldUv on each display defines that display's slice of the
     * rig's master canvas. When one shader feeds N displays, each
     * display's render pass receives world-UV uniforms that map its
     * local screen [0,1] into the slice — so a Pinwheel wired into
     * two side-by-side displays renders ONCE conceptually, with the
     * two passes drawing left and right halves of a single shared
     * image. Existing single-display patches default to a 1-display
     * rig with worldUv = [0,0]→[1,1], so old shaders see no change. */
    rig: defaultRig(),
    filename: "untitled.gpatch"
  };
}

/* ---------- Phase 6.5 — rig data layer + templates ---------- */

/* The default rig: one flat display covering the full master canvas.
 * Existing patches that don't carry a rig get this on load — combined
 * with VisualOutput's display param defaulting to 0, the editor's
 * pre-Phase-6.5 single-display behavior is preserved exactly. */
function defaultRig() {
  const surface = { type: "plane", normal: [0, 0, 1], offset: 5 };
  return {
    templateKey: "single",
    masterRes:   [1920, 1080],
    previewMode: "tile",          // tile | cylinder | equirect | fisheye
    // Phase 6.5.15+ — global "where the shader's center lands" offset
    // in degrees of world yaw/pitch. Default 0 means no shift; positive
    // yaw rotates content right (pinwheel center appears further right
    // in the rig's view). Conversion to per-VO world_uv shift is
    // computed in _renderWorldUvForVO and depends on whether the
    // shader is solo (denominated by display fov) or shared
    // (denominated by consumer set's azim range).
    shaderCenterYaw:   0,
    shaderCenterPitch: 0,
    // Phase 6.6.14 — physical screen geometry. Closes the gap with
    // Raskar et al.'s quadric-transfer math: knowing the screen as a
    // parametric surface (sphere/cylinder/plane/free) unlocks
    // analytic auto-warp (#3, next ticket) + screen-overlap-based
    // edge-blend (#4) without needing camera-feedback calibration.
    // Each template provides its own surface; the default rig is a
    // single flat display, which corresponds to a plane at z=offset.
    surface:    surface,
    // Phase 6.6.14 — sweet-spot, the audience-position the rig is
    // calibrated for. Theater-mode camera spawns there on rig
    // template apply / patch load. Per Raskar §4.1, sphere → center,
    // cylinder → midpoint of axis, plane → offset away from screen.
    // Helper _deriveSweetSpot builds defaults; user can override.
    sweetSpot:  _deriveSweetSpot(surface),
    // Phase 6.6.15 — when true, the screen surface is treated as a
    // physical curved screen for auto-warp + gizmo visualization.
    // When false, the rig is treated as flat monitors arranged at
    // the display poses (common for VJ wraparound LED-wall installs).
    // Default ON because most projection rigs do have a real screen;
    // toggle off if you're driving an array of monitors.
    surfaceVisible: true,
    displays:    [_makeDisplay("d0", "Display 1", {
      pose: { yaw: 0, pitch: 0, roll: 0 },
      fov:  { h: 90, v: 60 },
      worldUv: { minU: 0, minV: 0, maxU: 1, maxV: 1 }
    })]
  };
}

