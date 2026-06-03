/* Plane -- flat quad in the XZ plane, +Y normal. 4 verts, 6 indices.
 * Colored by a soft cyan-to-violet gradient by U coord so even the
 * unlit pipeline shows it as more than a solid blob. */
function _buildPlane(node) {
  const p = node.params || {};
  const hw = ((typeof p.width === "number") ? p.width : 1) * 0.5;
  const hd = ((typeof p.depth === "number") ? p.depth : 1) * 0.5;
  // pos.xyz  color.rgb         normal.xyz (+Y, flat plane)  uv.xy
  const verts = new Float32Array([
    -hw, 0, -hd,   0.40, 0.62, 0.95,   0, 1, 0,   0, 0,   // back-left
     hw, 0, -hd,   0.78, 0.42, 0.95,   0, 1, 0,   1, 0,   // back-right
     hw, 0,  hd,   0.85, 0.50, 0.55,   0, 1, 0,   1, 1,   // front-right
    -hw, 0,  hd,   0.45, 0.78, 0.65,   0, 1, 0,   0, 1    // front-left
  ]);
  const indices = new Uint32Array([0, 1, 2,  0, 2, 3]);
  return { verts, indices };
}

/* Sprint 8.0.2-f -- Sprite. XY-plane quad facing +Z, with anchor
 * offset + tint color. Vertex layout matches the shared unlit-vc
 * pipeline so any scene (Scene/Scene3D/Scene2D/Scene25D) consumes
 * it the same way Plane / Box / etc do. anchorX/Y in [0..1]
 * controls where the local origin sits within the quad -- 0.5/0.5
 * = center, 0.5/0 = pin-by-feet (good for 2.5D Y-sort).
 *
 * The tint params multiply through the color channel uniformly
 * across all four verts (in contrast to Plane's hardcoded gradient).
 * UVs are 0..1 corner-to-corner so texture-coordinate consumers
 * read the sprite face directly. */
function _buildSprite(node) {
  const p = node.params || {};
  const w  = (typeof p.width   === "number") ? p.width   : 1;
  const h  = (typeof p.height  === "number") ? p.height  : 1;
  const ax = (typeof p.anchorX === "number") ? p.anchorX : 0.5;
  const ay = (typeof p.anchorY === "number") ? p.anchorY : 0.5;
  const tR = (typeof p.tintR   === "number") ? p.tintR   : 1;
  const tG = (typeof p.tintG   === "number") ? p.tintG   : 1;
  const tB = (typeof p.tintB   === "number") ? p.tintB   : 1;
  // anchor (ax, ay) is the [0..1] fraction within the quad that the
  // sprite's local origin sits at. world_left = -ax * w (origin at
  // anchor fraction from left); world_right = (1 - ax) * w; same in Y.
  const x0 = -ax * w,       x1 = (1 - ax) * w;
  const y0 = -ay * h,       y1 = (1 - ay) * h;
  // pos.xyz  color.rgb       normal.xyz (+Z)  uv.xy
  const verts = new Float32Array([
    x0, y0, 0,   tR, tG, tB,   0, 0, 1,   0, 0,   // bottom-left
    x1, y0, 0,   tR, tG, tB,   0, 0, 1,   1, 0,   // bottom-right
    x1, y1, 0,   tR, tG, tB,   0, 0, 1,   1, 1,   // top-right
    x0, y1, 0,   tR, tG, tB,   0, 0, 1,   0, 1    // top-left
  ]);
  // CCW winding when viewed from +Z (facing camera in default 2D pose).
  const indices = new Uint32Array([0, 1, 2,  0, 2, 3]);
  return { verts, indices };
}

/* Sprint platformer-tile-sprites -- TileSpriteOverlay mesh build.
 * One textured quad per cell in the wired tilemap matching tileChar.
 * Output goes through the same sprite pipeline as Sprite (encoder
 * dispatch checks node.type), so all N quads draw in a single call
 * with one texture binding.
 *
 * Quad vertex layout matches _buildSprite (pos.xyz, color.rgb,
 * normal.xyz, uv.xy = 11 floats per vertex) -- the sprite pipeline
 * shader reads UVs through frame/framesX/framesY uniforms, so this
 * mesh can render a sub-frame of a sheet just like a single Sprite
 * would. bobAmplitude adds a per-cell vertical offset that's
 * baked into the y position at build time -- combined with the
 * per-frame meshCacheKey time bucket, sprites visibly bob without
 * the mesh having to be rebuilt every frame at 60Hz. */
function _buildTileSpriteOverlay(node) {
  const p = node.params || {};
  // Find wired tilemap (or first in patch).
  const tilemapNode = (typeof _findWiredOrFirst === "function")
    ? _findWiredOrFirst(node, "tilemap", "Tilemap2D")
    : null;
  if (!tilemapNode) return { verts: new Float32Array(0), indices: new Uint32Array(0) };
  const tp = tilemapNode.params || {};
  const data = (typeof tp.tileData === "string") ? tp.tileData : "";
  const ts   = (typeof tp.tileSize === "number" && tp.tileSize > 0) ? tp.tileSize : 1;
  const ox   = (typeof tp.originX  === "number") ? tp.originX : 0;
  const oy   = (typeof tp.originY  === "number") ? tp.originY : 0;
  const charRaw = (typeof p.tileChar === "string" && p.tileChar.length) ? p.tileChar[0] : "4";
  const scale = (typeof p.scale   === "number" && p.scale > 0) ? p.scale : 1.0;
  const ax    = (typeof p.anchorX === "number") ? p.anchorX : 0.5;
  const ay    = (typeof p.anchorY === "number") ? p.anchorY : 0.5;
  const tR    = (typeof p.tintR   === "number") ? p.tintR   : 1;
  const tG    = (typeof p.tintG   === "number") ? p.tintG   : 1;
  const tB    = (typeof p.tintB   === "number") ? p.tintB   : 1;
  const bobA  = (typeof p.bobAmplitude === "number") ? p.bobAmplitude : 0;
  const bobS  = (typeof p.bobSpeed     === "number") ? p.bobSpeed     : 2;
  const zPos  = (typeof p.depthZ       === "number") ? p.depthZ       : 0;
  // Time bucket for the bob (quantize to 60ms so the meshCacheKey
  // doesn't change every frame). 0.06s = ~17fps bob update rate,
  // plenty smooth visually since the sine wave's slow.
  const tBucket = bobA > 0 ? Math.floor(performance.now() / 60) * 0.06 : 0;
  const rowsArr = data.split(/\r?\n/);
  const rows = rowsArr.length;
  const cols = rowsArr.reduce((m, r) => Math.max(m, r.length), 0);
  const cx = (cols - 1) * 0.5;
  const cy = (rows - 1) * 0.5;
  const verts = [];
  const indices = [];
  let vIdx = 0;
  for (let r = 0; r < rows; r++) {
    const line = rowsArr[r];
    for (let c = 0; c < line.length; c++) {
      if (line[c] !== charRaw) continue;
      // Cell world center
      const tx = (c  - cx) * ts + ox;
      const tyRaw = (cy - r) * ts + oy;
      // Per-cell phase so adjacent eggs bob out of sync. Hash from
      // (col, row); cheap deterministic mix.
      let bobY = 0;
      if (bobA > 0) {
        const phase = ((c * 12.9898 + r * 78.233) * 0.5) % (Math.PI * 2);
        bobY = Math.sin(tBucket * bobS + phase) * bobA;
      }
      const ty = tyRaw + bobY;
      // Sprite quad sized by `scale`, anchored within the cell.
      const x0 = tx - scale * ax;
      const x1 = x0 + scale;
      const y0 = ty - scale * ay;
      const y1 = y0 + scale;
      verts.push(
        x0, y0, zPos,   tR, tG, tB,   0, 0, 1,   0, 0,
        x1, y0, zPos,   tR, tG, tB,   0, 0, 1,   1, 0,
        x1, y1, zPos,   tR, tG, tB,   0, 0, 1,   1, 1,
        x0, y1, zPos,   tR, tG, tB,   0, 0, 1,   0, 1
      );
      indices.push(vIdx, vIdx + 1, vIdx + 2,
                   vIdx, vIdx + 2, vIdx + 3);
      vIdx += 4;
    }
  }
  return {
    verts:   new Float32Array(verts),
    indices: new Uint32Array(indices)
  };
}

/* Sprint platformer-parallax -- ParallaxLayer2D mesh build.
 *
 * Outputs a single screen-spanning quad at the wired camera's world
 * position. UVs are computed so that:
 *   - U sweeps [0, 1] across the screen at any moment
 *   - U also shifts by `cameraX * parallaxX / texWorldWidth` as the
 *     camera moves, causing the bg to scroll
 *   - At parallaxX=0 the shift is zero -> classic locked skybox
 *   - At parallaxX=1 the bg scrolls at world speed -> no parallax
 *
 * The repeat-mode sampler (configured upstream on ImageURL via
 * wrapMode='repeat-x') handles UVs outside [0,1] by tiling, so the
 * texture cycles seamlessly through the level.
 *
 * Vertical: the quad height = orthoSize * 2 * screenScaleY, anchored
 * at screenAnchorY (0..1, 0=bottom of camera view). worldOffsetY
 * adds a fixed world-space shift on top of that for layers that
 * want to be pinned to specific world Y bands. */
function _buildParallaxLayer2D(node) {
  const p = node.params || {};
  // Find wired camera (or first OrthoCamera2D in patch). For
  // synthetic Level2D layers, the parent Level2D already resolved
  // the camera once -- node._levelCameraNodeId points at it so we
  // don't re-walk wires per layer.
  let camNode = null;
  if (node._levelCameraNodeId) {
    camNode = state.nodes.find(n => n && n.id === node._levelCameraNodeId);
  }
  if (!camNode && state && Array.isArray(state.edges)) {
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "camera"
    );
    if (wire && wire.from) {
      const src = state.nodes.find(n => n && n.id === wire.from.node);
      if (src && (src.type === "OrthoCamera2D" || src.type === "Camera" || src.type === "FPCamera")) {
        camNode = src;
      }
    }
  }
  if (!camNode && state && Array.isArray(state.nodes)) {
    camNode = state.nodes.find(n => n && n.type === "OrthoCamera2D");
  }
  const cp = camNode ? camNode.params || {} : {};
  const camX = (typeof cp.posX === "number") ? cp.posX : 0;
  const camY = (typeof cp.posY === "number") ? cp.posY : 0;
  const orthoSize = (typeof cp.orthoSize === "number" && cp.orthoSize > 0) ? cp.orthoSize : 5;
  // Aspect from current visual canvas (falls back to 16:9 if not ready).
  let aspect = 16 / 9;
  if (typeof Visual !== "undefined" && Visual.canvas && Visual.canvas.width > 0 && Visual.canvas.height > 0) {
    aspect = Visual.canvas.width / Visual.canvas.height;
  }
  const halfW = orthoSize * aspect;
  const halfH = orthoSize;
  // Tunables
  const parallaxX     = (typeof p.parallaxX     === "number") ? p.parallaxX     : 0.3;
  const texWorldWidth = (typeof p.texWorldWidth === "number" && p.texWorldWidth > 0) ? p.texWorldWidth : 30;
  const scaleY        = (typeof p.screenScaleY  === "number" && p.screenScaleY  > 0) ? p.screenScaleY  : 1.0;
  const anchorY       = (typeof p.screenAnchorY === "number") ? p.screenAnchorY : 0.5;
  const offsetY       = (typeof p.worldOffsetY  === "number") ? p.worldOffsetY  : 0;
  const tR = (typeof p.tintR === "number") ? p.tintR : 1;
  const tG = (typeof p.tintG === "number") ? p.tintG : 1;
  const tB = (typeof p.tintB === "number") ? p.tintB : 1;
  // Quad position: centered on camX horizontally, vertically anchored
  // within the camera frustum + offset.
  const quadHalfH = halfH * scaleY;
  // anchorY=0.5 centers on camY; 0=bottom of view; 1=top.
  const quadCenterY = camY + (anchorY - 0.5) * 2 * halfH + offsetY;
  const x0 = camX - halfW, x1 = camX + halfW;
  const y0 = quadCenterY - quadHalfH, y1 = quadCenterY + quadHalfH;
  // UV: U shifts with camera × parallax; V always [0,1] across quad.
  const uShift = (camX * parallaxX) / texWorldWidth;
  const u0 = uShift;
  const u1 = uShift + 1;
  const zPos = (typeof p.depthZ === "number") ? p.depthZ : 20;
  // pos.xyz  color.rgb       normal.xyz (+Z)  uv.xy
  const verts = new Float32Array([
    x0, y0, zPos,   tR, tG, tB,   0, 0, 1,   u0, 0,
    x1, y0, zPos,   tR, tG, tB,   0, 0, 1,   u1, 0,
    x1, y1, zPos,   tR, tG, tB,   0, 0, 1,   u1, 1,
    x0, y1, zPos,   tR, tG, tB,   0, 0, 1,   u0, 1
  ]);
  const indices = new Uint32Array([0, 1, 2,  0, 2, 3]);
  return { verts, indices };
}

/* Sprint SpriteScatter2D -- world-space sprite instancer mesh build.
 *
 * Parses the `positions` string ("x,y; x,y,scale; ...") and emits
 * one textured quad per instance, all using the same vertex layout
 * as Sprite/TileSpriteOverlay so the sprite pipeline draws the whole
 * field in one call. Per-instance scale + frame + flipX optional;
 * any unspecified field falls back to the node's default param.
 *
 * Common shapes:
 *   "0,-3.5"                 single sprite at world (0, -3.5), defaults
 *   "0,-3.5; 5,-3.5; 10,-3.5" three sprites along the ground at y=-3.5
 *   "0,-3.5,1.2"              one sprite scaled 1.2×
 *   "0,-3.5,1,0,1"            x=0, y=-3.5, scale=1, frame=0, flipX=1
 */
function _buildSpriteScatter2D(node) {
  const p = node.params || {};
  const posStr  = (typeof p.positions === "string") ? p.positions : "";
  const defScale  = (typeof p.scale   === "number" && p.scale > 0) ? p.scale : 1.0;
  const defAx     = (typeof p.anchorX === "number") ? p.anchorX : 0.5;
  const defAy     = (typeof p.anchorY === "number") ? p.anchorY : 0;
  const defFrame  = (typeof p.frame   === "number") ? Math.floor(p.frame) : 0;
  const framesX   = (typeof p.framesX === "number" && p.framesX > 0) ? Math.floor(p.framesX) : 1;
  const framesY   = (typeof p.framesY === "number" && p.framesY > 0) ? Math.floor(p.framesY) : 1;
  const tR = (typeof p.tintR === "number") ? p.tintR : 1;
  const tG = (typeof p.tintG === "number") ? p.tintG : 1;
  const tB = (typeof p.tintB === "number") ? p.tintB : 1;
  const zPos = (typeof p.depthZ === "number") ? p.depthZ : 0;
  // Per-instance frame override gets BAKED INTO UVs (since the
  // sprite pipeline applies the SAME frame uniform to every quad
  // in this draw, we can't have heterogeneous frames otherwise).
  // For frames=[0,1,2,3,...]: compute sub-uv rect for each frame
  // at vert time.
  const totalFrames = framesX * framesY;
  function frameSubUV(frame) {
    const f = Math.max(0, Math.min(totalFrames - 1, Math.floor(frame)));
    const col = f % framesX;
    const row = Math.floor(f / framesX);
    const cellW = 1 / framesX;
    const cellH = 1 / framesY;
    return { u0: col * cellW, u1: (col + 1) * cellW,
             v0: row * cellH, v1: (row + 1) * cellH };
  }
  const verts = [];
  const indices = [];
  let vIdx = 0;
  // Parse positions string. Tolerant of newlines + extra whitespace.
  const insts = posStr.split(";");
  for (const seg of insts) {
    const parts = seg.split(",").map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length < 2) continue;
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const scale = (parts.length >= 3 && Number.isFinite(parseFloat(parts[2]))) ? parseFloat(parts[2]) : defScale;
    const frame = (parts.length >= 4 && Number.isFinite(parseFloat(parts[3]))) ? parseInt(parts[3], 10) : defFrame;
    const flipX = (parts.length >= 5 && Number.isFinite(parseFloat(parts[4]))) ? (parseFloat(parts[4]) >= 0.5) : false;
    // Quad corners
    const x0 = x - scale * defAx;
    const x1 = x0 + scale;
    const y0 = y - scale * defAy;
    const y1 = y0 + scale;
    // Per-instance UV based on frame
    let { u0, u1, v0, v1 } = frameSubUV(frame);
    if (flipX) { const t = u0; u0 = u1; u1 = t; }
    // pos.xyz  color.rgb       normal.xyz (+Z)  uv.xy
    // Sprite-pipeline vertex shader applies v = 1 - inUV.y, so to
    // get the final out.uv.y = (frameRow+1)*cellH (bottom of frame)
    // at the bottom of the quad and = frameRow*cellH (top of frame)
    // at the top, we pre-bake inUV.y = 1 - v1 / 1 - v0 here. For
    // a single-frame texture (v0=0, v1=1) this collapses to the
    // standard _buildSprite layout (bottom inUV.y=0, top inUV.y=1).
    // Previously bottom got v1 and top got v0 -> rendered upside down.
    const bottomV = 1 - v1;
    const topV    = 1 - v0;
    verts.push(
      x0, y0, zPos,   tR, tG, tB,   0, 0, 1,   u0, bottomV,
      x1, y0, zPos,   tR, tG, tB,   0, 0, 1,   u1, bottomV,
      x1, y1, zPos,   tR, tG, tB,   0, 0, 1,   u1, topV,
      x0, y1, zPos,   tR, tG, tB,   0, 0, 1,   u0, topV
    );
    indices.push(vIdx, vIdx + 1, vIdx + 2,
                 vIdx, vIdx + 2, vIdx + 3);
    vIdx += 4;
  }
  return {
    verts:   new Float32Array(verts),
    indices: new Uint32Array(indices)
  };
}

/* Sprint platformer-1 -- Tilemap2D. Parses the multi-line tileData
 * string into a 2D grid of cell indices; emits one quad per non-
 * empty cell, vertex-colored per the palette param. Origin is the
 * grid center (so a 10×10 tilemap spans world X ∈ [-5, 5], Y ∈ [-5, 5]
 * before originX/originY offset). Row 0 is at the TOP of the grid in
 * world space (positive Y), to match how level designers think about
 * "top of the level."
 *
 * Cell glyphs:
 *   '.', ' '        -- empty (no quad emitted)
 *   '1' or '#'      -- color1 (default: grass green)
 *   '2'             -- color2 (default: dirt brown)
 *   '3'             -- color3 (default: stone gray)
 *   '4'             -- color4 (default: gold)
 *   any other char  -- color1 (lenient default) */
/* True iff a Tilemap2D node's params resolve to the encoder's
 * "textured tileset" path. Mirrors the decision in _buildTilemap2D
 * (tileset URL non-empty AND tileMap parses to a non-array object).
 * The sprite-pipeline dispatch in _encodeScenePass uses this so the
 * pipeline selection always matches the UVs the mesh was built with
 * -- otherwise a mismatch routes vertex-color [0,1]^2 UVs through
 * the texture sampler and renders the whole sheet per cell. */
function _tilemap2dUsesTileset(node) {
  if (!node || node.type !== "Tilemap2D") return false;
  const p = node.params;
  if (!p || typeof p.tileset !== "string" || !p.tileset.length) return false;
  if (p.tileMap && typeof p.tileMap === "object" && !Array.isArray(p.tileMap)) return true;
  if (typeof p.tileMap === "string" && p.tileMap.length > 0) {
    try {
      const parsed = JSON.parse(p.tileMap);
      return !!(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    } catch (_) { return false; }
  }
  return false;
}

function _buildTilemap2D(node) {
  const p = node.params || {};
  const data = (typeof p.tileData === "string") ? p.tileData : "";
  const ts   = (typeof p.tileSize === "number" && p.tileSize > 0) ? p.tileSize : 1;
  const ox   = (typeof p.originX === "number") ? p.originX : 0;
  const oy   = (typeof p.originY === "number") ? p.originY : 0;
  const palette = [
    [(typeof p.color1R === "number") ? p.color1R : 0.30,
     (typeof p.color1G === "number") ? p.color1G : 0.55,
     (typeof p.color1B === "number") ? p.color1B : 0.35],
    [(typeof p.color2R === "number") ? p.color2R : 0.42,
     (typeof p.color2G === "number") ? p.color2G : 0.28,
     (typeof p.color2B === "number") ? p.color2B : 0.18],
    [(typeof p.color3R === "number") ? p.color3R : 0.55,
     (typeof p.color3G === "number") ? p.color3G : 0.55,
     (typeof p.color3B === "number") ? p.color3B : 0.62],
    [(typeof p.color4R === "number") ? p.color4R : 0.96,
     (typeof p.color4G === "number") ? p.color4G : 0.90,
     (typeof p.color4B === "number") ? p.color4B : 0.78],
    [(typeof p.color5R === "number") ? p.color5R : 0.92,
     (typeof p.color5G === "number") ? p.color5G : 0.25,
     (typeof p.color5B === "number") ? p.color5B : 0.30]
  ];
  const rowsArr = data.split(/\r?\n/);
  const rows = rowsArr.length;
  const cols = rowsArr.reduce((m, r) => Math.max(m, r.length), 0);
  const cx = (cols - 1) * 0.5;
  const cy = (rows - 1) * 0.5;
  // Chars to omit from the rendered mesh (cells stay in tileData for
  // collision / overlay detection). Default empty -- old patches keep
  // their full visible tilemap. Demos using TileSpriteOverlay for
  // eggs/flag set this to "45" so the squares don't peek out behind
  // the sprite.
  const skipRender = (typeof p.skipRenderChars === "string") ? p.skipRenderChars : "";
  const zPos = (typeof p.depthZ === "number") ? p.depthZ : 0;
  // Sprint Level2D Phase 2 -- textured tileset path. When `tileset`
  // is set the cell chars look up a frame index via the `tileMap`
  // JSON (e.g. {"1":0,"2":1,...}) and we emit UVs into the sheet's
  // sub-cells. The encoder dispatch picks the sprite pipeline based
  // on _resolveSpriteTextureEntry returning a ready entry.
  let tileMap = null;
  const tilesetURL = (typeof p.tileset === "string" && p.tileset.length > 0) ? p.tileset : "";
  if (tilesetURL) {
    if (typeof p.tileMap === "object" && p.tileMap !== null && !Array.isArray(p.tileMap)) {
      tileMap = p.tileMap;
    } else if (typeof p.tileMap === "string" && p.tileMap.length > 0) {
      try { tileMap = JSON.parse(p.tileMap); }
      catch (e) {
        if (!node._tmTileMapErrLogged) {
          node._tmTileMapErrLogged = true;
          console.warn("[Tilemap2D " + node.id + "] tileMap JSON parse failed: " + e.message);
        }
      }
    }
  }
  const useTileset = !!(tilesetURL && tileMap);
  const framesX = useTileset
    ? Math.max(1, Math.floor((typeof p.tilesetFramesX === "number" && p.tilesetFramesX > 0) ? p.tilesetFramesX : 4))
    : 1;
  const framesY = useTileset
    ? Math.max(1, Math.floor((typeof p.tilesetFramesY === "number" && p.tilesetFramesY > 0) ? p.tilesetFramesY : 2))
    : 1;
  const cellW_uv = 1 / framesX;
  const cellH_uv = 1 / framesY;
  const totalTiles = framesX * framesY;
  const verts = [];
  const indices = [];
  let vIdx = 0;
  for (let r = 0; r < rows; r++) {
    const line = rowsArr[r];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "." || ch === " " || ch === "") continue;
      if (skipRender.indexOf(ch) >= 0) continue;
      // Cell world position. Row 0 lives at the TOP (positive Y).
      const x = (c  - cx) * ts + ox;
      const y = (cy - r ) * ts + oy;
      const x0 = x - ts * 0.5, x1 = x + ts * 0.5;
      const y0 = y - ts * 0.5, y1 = y + ts * 0.5;
      if (useTileset && Object.prototype.hasOwnProperty.call(tileMap, ch)) {
        // Textured tile path. Look up tile index, compute frame UV
        // sub-rect in the sheet. Same V-flip compensation as
        // SpriteScatter2D: bottom inUV.y = 1 - v1, top inUV.y = 1 - v0.
        const tileIdx = Math.max(0, Math.min(totalTiles - 1, Math.floor(tileMap[ch])));
        const fcol = tileIdx % framesX;
        const frow = Math.floor(tileIdx / framesX);
        const u0 = fcol * cellW_uv,   u1 = u0 + cellW_uv;
        const v0 = frow * cellH_uv,   v1 = v0 + cellH_uv;
        const bottomV = 1 - v1;
        const topV    = 1 - v0;
        // Tint stays white so the texture shows unchanged.
        verts.push(
          x0, y0, zPos,   1, 1, 1,   0, 0, 1,   u0, bottomV,
          x1, y0, zPos,   1, 1, 1,   0, 0, 1,   u1, bottomV,
          x1, y1, zPos,   1, 1, 1,   0, 0, 1,   u1, topV,
          x0, y1, zPos,   1, 1, 1,   0, 0, 1,   u0, topV
        );
      } else if (useTileset) {
        // Bug fix v0.3.458 -- when the mesh is textured (sprite
        // pipeline) but this char isn't in tileMap, we MUST NOT emit
        // full [0,1] UVs: that would sample the entire tileset sheet
        // into the cell and tint it with the palette color, producing
        // the "every cell shows the whole sheet" glitch. Instead emit
        // a degenerate point-UV at (0,0): the sprite shader samples a
        // single pixel of the sheet, multiplied by the palette tint,
        // giving a recognisable solid-color marker quad (still visible
        // as a '4'/'5' pickup/goal hint) without bleeding the sheet.
        let pi = 0;
        if      (ch === "1" || ch === "#") pi = 0;
        else if (ch === "2")               pi = 1;
        else if (ch === "3")               pi = 2;
        else if (ch === "4")               pi = 3;
        else if (ch === "5")               pi = 4;
        const col = palette[pi];
        verts.push(
          x0, y0, zPos,   col[0], col[1], col[2],   0, 0, 1,   0, 0,
          x1, y0, zPos,   col[0], col[1], col[2],   0, 0, 1,   0, 0,
          x1, y1, zPos,   col[0], col[1], col[2],   0, 0, 1,   0, 0,
          x0, y1, zPos,   col[0], col[1], col[2],   0, 0, 1,   0, 0
        );
      } else {
        // Vertex-color path (no tileset configured). Goes through the
        // mesh pipeline downstream so full [0,1] UVs are harmless.
        let pi = 0;
        if      (ch === "1" || ch === "#") pi = 0;
        else if (ch === "2")               pi = 1;
        else if (ch === "3")               pi = 2;
        else if (ch === "4")               pi = 3;
        else if (ch === "5")               pi = 4;
        const col = palette[pi];
        verts.push(
          x0, y0, zPos,   col[0], col[1], col[2],   0, 0, 1,   0, 0,
          x1, y0, zPos,   col[0], col[1], col[2],   0, 0, 1,   1, 0,
          x1, y1, zPos,   col[0], col[1], col[2],   0, 0, 1,   1, 1,
          x0, y1, zPos,   col[0], col[1], col[2],   0, 0, 1,   0, 1
        );
      }
      indices.push(vIdx, vIdx + 1, vIdx + 2,
                   vIdx, vIdx + 2, vIdx + 3);
      vIdx += 4;
    }
  }
  return {
    verts:   new Float32Array(verts),
    indices: new Uint32Array(indices)
  };
}

/* Phase 7 §5.5.a — Terrain noise helpers. Same hash + value-noise +
 * fBm formula as ProceduralTerrain's WGSL (§5.5.b) so a JS-built
 * Terrain mesh with identical noise params previews what a future
 * ProceduralTerrain → Terrain wired path would emit at GPU time. */
function _terrainHash(x, y, seed) {
  // §5.5.h-7 -- deterministic integer-bit-mix hash. Replaces the
  // old Math.sin-based hash so the JS noise (mesh build) is
  // bit-identical with the WGSL noise (water shader's fs_water).
  // sin-based hashes diverge at large world coords because JS uses
  // f64 sin while WGSL uses f32 sin; the resulting noise mismatch
  // made water foam misalign with the terrain mesh past ~1km. The
  // bit-mix below uses only i32 multiplies + XOR + bit-shifts that
  // produce identical results across both languages.
  const sx = x | 0;
  const sy = y | 0;
  const ss = (Math.floor(seed * 1000) | 0);
  let h = Math.imul(sx, 374761393) ^ Math.imul(sy, 668265263) ^ Math.imul(ss, 2147483647);
  // unsigned shifts -- the signed `>>` sign-extends, so `h ^ (h >> 16)`
  // always zeroed the result's top bit, capping the range at [0, 0.5).
  // With threshold=0.5 that meant the island mask was uniformly OCEAN.
  h = h ^ (h >>> 13);
  h = Math.imul(h, 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
function _terrainValueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = _terrainHash(ix,     iy,     seed);
  const b = _terrainHash(ix + 1, iy,     seed);
  const c = _terrainHash(ix,     iy + 1, seed);
  const d = _terrainHash(ix + 1, iy + 1, seed);
  // §planet-spec Phase 3 -- quintic interpolation (6t^5 - 15t^4 +
  // 10t^3). C2 continuous: kills the second-derivative kinks at
  // lattice cell boundaries that show as faint seam artifacts when
  // adjacent vertices fall on opposite sides of a cell border at
  // different LODs. Cheap (two more multiplies per axis vs cubic).
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const ab = a + (b - a) * sx;
  const cd = c + (d - c) * sx;
  return ab + (cd - ab) * sy;
}
/* §planet-spec Phase 4.b -- 3D analogues of _terrainHash /
 * _terrainValueNoise / _terrainFBM. Same bit-mix hash + quintic
 * interpolation, extended to a 3D lattice with 8-corner trilinear
 * blend. Used by the Planet node to sample fBm on a unit sphere
 * (rotationally symmetric, no face-seam concerns -- cuberact /
 * Outerra / NMS all use 3D noise on the surface).
 *
 * Distinct prime for z (1597334677) keeps the bit-mix entropy across
 * the new axis. Same Math.imul + unsigned shifts so the result is
 * deterministic and matches a future WGSL port. */
function _terrainHash3D(x, y, z, seed) {
  const sx = x | 0;
  const sy = y | 0;
  const sz = z | 0;
  const ss = (Math.floor(seed * 1000) | 0);
  let h = Math.imul(sx, 374761393) ^ Math.imul(sy, 668265263) ^ Math.imul(sz, 1597334677) ^ Math.imul(ss, 2147483647);
  h = h ^ (h >>> 13);
  h = Math.imul(h, 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
function _terrainValueNoise3D(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const c000 = _terrainHash3D(ix,     iy,     iz,     seed);
  const c100 = _terrainHash3D(ix + 1, iy,     iz,     seed);
  const c010 = _terrainHash3D(ix,     iy + 1, iz,     seed);
  const c110 = _terrainHash3D(ix + 1, iy + 1, iz,     seed);
  const c001 = _terrainHash3D(ix,     iy,     iz + 1, seed);
  const c101 = _terrainHash3D(ix + 1, iy,     iz + 1, seed);
  const c011 = _terrainHash3D(ix,     iy + 1, iz + 1, seed);
  const c111 = _terrainHash3D(ix + 1, iy + 1, iz + 1, seed);
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const sz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const ab0 = c000 + (c100 - c000) * sx;
  const cd0 = c010 + (c110 - c010) * sx;
  const v0  = ab0  + (cd0  - ab0) * sy;
  const ab1 = c001 + (c101 - c001) * sx;
  const cd1 = c011 + (c111 - c011) * sx;
  const v1  = ab1  + (cd1  - ab1) * sy;
  return v0 + (v1 - v0) * sz;
}
function _terrainFBM3D(x, y, z, n) {
  let px = x * Math.max(1e-9, n.frequency);
  let py = y * Math.max(1e-9, n.frequency);
  let pz = z * Math.max(1e-9, n.frequency);
  const totalOctF = (typeof n.effectiveOctavesF === "number")
    ? Math.max(0.0, Math.min(20, n.effectiveOctavesF))
    : Math.max(1, Math.min(20, Math.floor(n.octaves)));
  const fullOcts = Math.floor(totalOctF);
  const frac = totalOctF - fullOcts;
  const lac = (typeof n.lacunarity === "number") ? n.lacunarity : 2.0;
  const gain = (typeof n.gain === "number") ? n.gain : 0.5;
  const r = Math.max(0, Math.min(1, (typeof n.ridges === "number") ? n.ridges : 0));
  let amp = 1.0, sum = 0.0, maxAmp = 0.0;
  for (let i = 0; i < fullOcts; i++) {
    let s = _terrainValueNoise3D(px, py, pz, n.seed);
    const ridge = 1 - Math.abs(2 * s - 1);
    s = s * (1 - r) + ridge * ridge * r;
    sum += s * amp;
    maxAmp += amp;
    px *= lac; py *= lac; pz *= lac;
    amp *= gain;
  }
  if (frac > 0) {
    let s = _terrainValueNoise3D(px, py, pz, n.seed);
    const ridge = 1 - Math.abs(2 * s - 1);
    s = s * (1 - r) + ridge * ridge * r;
    sum += s * amp * frac;
    maxAmp += amp * frac;
  }
  return Math.max(0, Math.min(1, sum / Math.max(1e-6, maxAmp)));
}

/* §planet-spec Phase 4.b -- per-vertex terrain-palette color from
 * normalized fBm height h ∈ [0, 1] and a seaLevel cutoff. Below
 * seaLevel: deep-to-shallow ocean blue. Above: beach → vegetation
 * → rock → snow gradient. Used by _buildPlanet so the heightfield
 * reads under the unlit-vc shader without needing a material yet. */
function _planetColorForHeight(h, seaLevel) {
  if (h < seaLevel) {
    // Brighter ocean than the original 4.b palette so the planet
    // doesn't blend with the black space sky at high altitudes. Base
    // floor lifted from 0.03/0.08/0.28 (near-black navy) to a clearly
    // visible mid-blue. Lambert shading applied at build time on top
    // of this gives the day/night terminator.
    const t = h / Math.max(1e-6, seaLevel);
    return [0.12 + t * 0.10, 0.22 + t * 0.20, 0.42 + t * 0.28];
  }
  const t = (h - seaLevel) / Math.max(1e-6, 1 - seaLevel);
  // §planet-spec Phase 7.d follow-up -- wider beach band (was 0.06).
  // 0.15 of land range = ~1500m wide at heightScale=20km, gives a
  // clearly-visible coastline strip from orbit. Sand starts AT sea
  // level (t = 0) and fades to grass.
  if (t < 0.15) {
    const u = t / 0.15;
    return [0.84 + u * 0.02, 0.76 + u * 0.02, 0.52 + u * 0.02];
  }
  if (t < 0.65) {
    const u = (t - 0.15) / 0.50;
    return [0.20 + u * 0.18, 0.50 - u * 0.22, 0.15 + u * 0.04];
  }
  if (t < 0.85) {
    const u = (t - 0.65) / 0.20;
    return [0.38 + u * 0.22, 0.32 + u * 0.16, 0.22 + u * 0.10];
  }
  return [0.92, 0.94, 0.98];
}

/* §planet-spec Phase 4.f -- Planet sun shading helper. Reads the
 * patch's Sun node (if any) and returns a unit sun direction matching
 * the WGSL sample_procedural_sky_* path. Falls back to a fixed "late
 * morning" direction if no Sun is wired so Planet still looks 3D in
 * scenes without explicit lighting. */
function _planetSunDir() {
  let t = 0.42;
  if (state && Array.isArray(state.nodes)) {
    const sun = state.nodes.find(n => n && n.type === "Sun");
    if (sun && sun.params && typeof sun.params.timeOfDay === "number") {
      t = sun.params.timeOfDay;
    }
  }
  return _sunDirFromTime(t);
}

function _terrainFBM(u, v, n) {
  // §planet-spec Phase 3 -- fBm with CONTINUOUS fractional octave
  // count. Caller sets n.effectiveOctavesF (a Number) to vary the
  // octave count per-sample based on local mesh spacing; this is
  // the LOD knob that keeps the silhouette stable across zoom
  // levels (Nyquist: an octave with wavelength lambda_k can't be
  // resolved at sample spacing Δx > lambda_k / 2, so we truncate).
  // The fractional part fades the last octave in proportionally so
  // there's no popping when chunks cross LOD boundaries.
  // Fallback: if n.effectiveOctavesF is undefined, use n.octaves as
  // an integer count (legacy path).
  let px = u * Math.max(0.001, n.frequency);
  let py = v * Math.max(0.001, n.frequency);
  const totalOctF = (typeof n.effectiveOctavesF === "number")
    ? Math.max(0.0, Math.min(20, n.effectiveOctavesF))
    : Math.max(1, Math.min(8, Math.floor(n.octaves)));
  const fullOcts = Math.floor(totalOctF);
  const frac = totalOctF - fullOcts;
  let amp = 1.0, sum = 0.0, maxAmp = 0.0;
  const r = Math.max(0, Math.min(1, n.ridges));
  for (let i = 0; i < fullOcts; i++) {
    let s = _terrainValueNoise(px, py, n.seed);
    const ridge = 1 - Math.abs(2 * s - 1);
    s = s * (1 - r) + ridge * ridge * r;
    sum += s * amp;
    maxAmp += amp;
    px *= n.lacunarity;
    py *= n.lacunarity;
    amp *= n.gain;
  }
  if (frac > 0) {
    let s = _terrainValueNoise(px, py, n.seed);
    const ridge = 1 - Math.abs(2 * s - 1);
    s = s * (1 - r) + ridge * ridge * r;
    sum += s * amp * frac;
    maxAmp += amp * frac;
  }
  return Math.max(0, Math.min(1, sum / Math.max(1e-6, maxAmp)));
}

/* §planet-spec Phase 3 -- derive the fractional octave count to
 * evaluate for a given sample spacing. Implements the Nyquist rule
 * (octave k has wavelength 1/(freq * lac^k); spacing must be
 * <= wavelength/2 to resolve it without aliasing). lacunarity 2 is
 * assumed -- close enough for our typical noise. Pass a small
 * positive `pad` to evaluate slightly less than Nyquist for a
 * safety margin against aliasing on grid-aligned sample patterns. */
function _octavesForSpacing(freq, spacing, maxOctaves) {
  const f = Math.max(1e-9, freq);
  const dx = Math.max(1e-3, spacing);
  // log2(1 / (2 * f * dx))
  const k = Math.log2(1.0 / (2.0 * f * dx));
  return Math.max(0, Math.min(maxOctaves || 16, k));
}

/* Terrain -- heightmap-displaced XZ grid. (segments+1)² verts laid
 * out on the XZ plane centered at origin, Y displaced by built-in
 * fBm. Normals via central-difference finite-difference on the
 * height field. Vertex color grades by altitude (blue → grass →
 * rock → snow) so the mesh reads as terrain under the default
 * unlit-vc material; pair with a Phong / PBR material for lit
 * shading. */
function _buildTerrain(node) {
  const p = node.params || {};
  // Size: dropdown presets override worldSize when sizeMode != "custom".
  // "infinite" caps at 10000u for single-mesh; the proper infinite
  // chunked-streaming path lands in §5.5.c (needs §5.10 streaming
  // infra), so the value here is a "very large finite" stand-in.
  const sizePresets = { small: 20, medium: 100, large: 1000, infinite: 10000 };
  const mode = (typeof p.sizeMode === "string") ? p.sizeMode : "medium";
  const customSize = (typeof p.worldSize === "number") ? p.worldSize : 100;
  const w = (mode === "custom") ? customSize : (sizePresets[mode] || customSize);
  const dd = w;                                         // square terrain for now
  // Scale vertical gain proportionally to world size so the
  // height-to-width ratio stays constant across ALL modes
  // including custom. Reference = medium (100u) where the literal
  // heightScale is applied; any other world size scales the
  // vertical gain by (w / 100) so a person walking a worldSize=1000
  // landscape sees peaks 10x taller than a worldSize=100 landscape.
  const hsRaw = (typeof p.heightScale === "number") ? p.heightScale : 12;
  const hsScale = w / 100;
  const hs = hsRaw * hsScale;
  // yOffset: peaks land at Y = 0 + yOffset by default, valleys at
  // Y = -hs + yOffset. Default 0 (peaks at horizon) so the terrain
  // doesn't dominate the upper screen under the default camera. Set
  // positive to push the whole terrain UP (peaks above horizon).
  const yOff = (typeof p.yOffset === "number") ? p.yOffset : 0;
  const segs = Math.max(1, Math.min(256, Math.floor((typeof p.segments === "number") ? p.segments : 64)));
  const noise = {
    seed:       (typeof p.seed       === "number") ? p.seed       : 1.234,
    frequency:  (typeof p.frequency  === "number") ? p.frequency  : 2.0,
    octaves:    (typeof p.octaves    === "number") ? p.octaves    : 5,
    lacunarity: (typeof p.lacunarity === "number") ? p.lacunarity : 2.0,
    gain:       (typeof p.gain       === "number") ? p.gain       : 0.5,
    ridges:     (typeof p.ridges     === "number") ? p.ridges     : 0.0
  };
  const N = segs + 1;
  const hw = w * 0.5, hd = dd * 0.5;
  const dx = w / segs, dz = dd / segs;

  // v0.3.126 §5.5.c-3 -- if a heightmap texture is wired into this
  // Terrain, the GPU vertex shader (vs_terrain) does the Y
  // displacement at render time. The CPU build emits a flat grid
  // (Y=0 + yOffset) with valid UVs so vs_terrain has something
  // to sample. Normals stay flat-up (+Y); vs_terrain recomputes
  // them per-vertex from neighbor heightmap samples. When NO
  // heightmap is wired, fall through to the original CPU-side
  // fBm displacement path (the §5.5.a behavior).
  const hmWired = Array.isArray(state.edges) && state.edges.some(e =>
    e && e.to && e.to.node === node.id && e.to.port === "heightmap"
  );

  // Pre-sample the height field. Reused for the central-difference
  // normal computation -- without the cache we'd re-evaluate 4× per
  // vertex which gets expensive at segments=256 (~260k extra fBm calls).
  // Y mapping: fBm returns 0..1, we map to -hs..0 so peaks (fBm=1)
  // land at Y = 0 and valleys (fBm=0) descend to Y = -hs. yOffset
  // shifts the whole stack so users can re-position vertically.
  // §bonus-parity (2026-05-25) -- plateau remap matches TiledTerrain's
  // _tiledBaseHeight. k = 1 + plateau*4: pow(h, k) compresses the lower
  // band of the height field, leaving sharper isolated peaks rising
  // out of a flatter plain. plateau=0 is a no-op (existing behavior).
  const plateau = Math.max(0, Math.min(1, (typeof p.plateau === "number") ? p.plateau : 0));
  const plateauK = 1 + plateau * 4;
  const heights = new Float32Array(N * N);
  if (!hmWired) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let h01 = _terrainFBM(i / segs, j / segs, noise);
        if (plateau > 0) {
          h01 = Math.pow(Math.max(0, Math.min(1, h01)), plateauK);
        }
        heights[j * N + i] = (h01 - 1) * hs + yOff;
      }
    }
  } else {
    // Flat baseline; vs_terrain will displace per-vertex on the GPU.
    for (let k = 0; k < N * N; k++) heights[k] = yOff;
  }

  const verts = new Float32Array(N * N * 11);
  const indices = new Uint32Array(segs * segs * 6);
  let vi = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -hw + i * dx;
      const z = -hd + j * dz;
      const y = heights[j * N + i];

      // Central-difference normal. Edge pixels clamp to the cell
      // value (matches sample-edge semantics).
      const yL = (i > 0)    ? heights[j * N + (i - 1)] : y;
      const yR = (i < segs) ? heights[j * N + (i + 1)] : y;
      const yD = (j > 0)    ? heights[(j - 1) * N + i] : y;
      const yU = (j < segs) ? heights[(j + 1) * N + i] : y;
      const dydx = (yR - yL) / (2 * dx);
      const dydz = (yU - yD) / (2 * dz);
      // Tangent_x = (1, dydx, 0), Tangent_z = (0, dydz, 1). Cross
      // gives (dydx, -1, dydz); flip sign so the normal points +Y.
      let nx = -dydx, ny = 1, nz = -dydz;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nlen; ny /= nlen; nz /= nlen;

      // Altitude-based color gradient. Smooth-shaded transitions
      // between four bands so the mesh reads as terrain even unlit.
      // Bands: water (h<0.25) / grass (0.25..0.55) / rock (0.55..0.80)
      // / snow (>0.80). h01 is the normalized fBm value (0=valleys,
      // 1=peaks), recovered from y by inverting the (fbm-1)*hs+yOff
      // mapping so it stays in [0, 1] regardless of yOffset.
      const h01 = (hs > 0) ? Math.max(0, Math.min(1, (y - yOff) / hs + 1)) : 0;
      let rC, gC, bC;
      if (h01 < 0.25) {
        // Slate-blue water -> grass-green
        const t = h01 / 0.25;
        rC = 0.25 + t * 0.20; gC = 0.35 + t * 0.30; bC = 0.55 - t * 0.30;
      } else if (h01 < 0.55) {
        // Grass
        const t = (h01 - 0.25) / 0.30;
        rC = 0.45 - t * 0.10; gC = 0.65 - t * 0.20; bC = 0.25 - t * 0.05;
      } else if (h01 < 0.80) {
        // Rock (warm gray)
        const t = (h01 - 0.55) / 0.25;
        rC = 0.35 + t * 0.30; gC = 0.45 + t * 0.20; bC = 0.20 + t * 0.30;
      } else {
        // Snow caps
        const t = (h01 - 0.80) / 0.20;
        rC = 0.65 + t * 0.35; gC = 0.65 + t * 0.35; bC = 0.50 + t * 0.50;
      }
      // Slope tint: steep faces darken slightly so peaks look craggy.
      const slope = 1 - ny;
      const slopeMul = 1 - slope * 0.4;
      rC *= slopeMul; gC *= slopeMul; bC *= slopeMul;

      verts[vi++] = x;
      verts[vi++] = y;
      verts[vi++] = z;
      verts[vi++] = Math.max(0, Math.min(1, rC));
      verts[vi++] = Math.max(0, Math.min(1, gC));
      verts[vi++] = Math.max(0, Math.min(1, bC));
      verts[vi++] = nx;
      verts[vi++] = ny;
      verts[vi++] = nz;
      verts[vi++] = i / segs;
      verts[vi++] = j / segs;
    }
  }

  // Two triangles per quad. Winding matches Plane's (BL, BR, FR /
  // BL, FR, FL) so the visible side is +Y per the existing CCW
  // front-face convention.
  let ii = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * N + i;             // back-left
      const b = a + 1;                  // back-right
      const c = (j + 1) * N + i;        // front-left
      const d = c + 1;                  // front-right
      indices[ii++] = a;
      indices[ii++] = b;
      indices[ii++] = d;
      indices[ii++] = a;
      indices[ii++] = d;
      indices[ii++] = c;
    }
  }
  return { verts, indices };
}

/* Phase 7 §5.5.e -- TiledTerrain helpers. */

/* World-space anchor for the chunk grid. "auto" picks the position
 * of the first FPCamera (or Camera) in the patch; "manual" uses
 * the centerX / centerZ params. */
function _tiledTerrainAnchor(node) {
  const p = node.params || {};
  if (p.anchorMode === "manual") {
    return {
      cx: (typeof p.centerX === "number") ? p.centerX : 0,
      cz: (typeof p.centerZ === "number") ? p.centerZ : 0
    };
  }
  if (state && Array.isArray(state.nodes)) {
    // Prefer FPCamera; fall back to any Camera.
    const fpc = state.nodes.find(n => n && n.type === "FPCamera");
    const cam = fpc || state.nodes.find(n => n && n.type === "Camera");
    if (cam && cam.params) {
      const px = (typeof cam.params.posX === "number") ? cam.params.posX : 0;
      const pz = (typeof cam.params.posZ === "number") ? cam.params.posZ : 0;
      return { cx: px, cz: pz };
    }
  }
  return { cx: 0, cz: 0 };
}

/* Current center-tile coordinates (integer tile-grid indices). The
 * cache key includes these so mesh rebuilds happen ONLY when the
 * camera crosses a chunk boundary, not on every frame. */
function _tiledTerrainCenterTile(node) {
  const p = node.params || {};
  const chunkSize = Math.max(1, (typeof p.chunkSize === "number") ? p.chunkSize : 32);
  const radius = Math.max(0, (typeof p.chunkRadius === "number") ? p.chunkRadius : 0);
  const a = _tiledTerrainAnchor(node);
  let cx = a.cx;
  let cz = a.cz;
  // §5.5.e-7 -- forward bias. Shifts the loaded-disc center toward
  // the player's WALKING direction (NOT look direction). Walking
  // direction is a low-pass-filtered unit vector tracked by the
  // FPCamera tick; turning your head doesn't move it, so look-only
  // turns don't churn the chunk cache.
  //
  // Hysteresis: the quantum direction is "sticky" -- we only flip
  // to a new octant after the smoothed walkDir has been pointing
  // there for >700ms continuous. Strafing sideways briefly (e.g.
  // dodging) doesn't shift the disc; sustained sideways walking
  // does. Cached on node._biasQ / _biasCandidate / _biasCandidateT
  // so re-evaluating the center tile is idempotent within a frame.
  const forwardBias = Math.max(0, Math.min(1, (typeof p.forwardBias === "number") ? p.forwardBias : 0));
  if (forwardBias > 0 && state && Array.isArray(state.nodes)) {
    const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
    if (cam && cam.params) {
      let bx, bz;
      if (typeof cam.params.walkDirX === "number" &&
          typeof cam.params.walkDirZ === "number" &&
          (cam.params.walkDirX !== 0 || cam.params.walkDirZ !== 0)) {
        bx = cam.params.walkDirX;
        bz = cam.params.walkDirZ;
      } else if (typeof cam.params.yaw === "number") {
        bx = Math.sin(cam.params.yaw);
        bz = Math.cos(cam.params.yaw);
      } else {
        bx = 0; bz = 1;
      }
      const angle  = Math.atan2(bx, bz);
      const q      = Math.PI / 4;            // 45° quantum (8 cardinals)
      const target = Math.round(angle / q) * q;
      const now    = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (typeof node._biasQ !== "number") {
        // First frame -- commit immediately.
        node._biasQ = target;
        node._biasCandidate = target;
        node._biasCandidateT = now;
      } else if (target !== node._biasCandidate) {
        // Direction shifted -- start the confirmation timer.
        node._biasCandidate = target;
        node._biasCandidateT = now;
      } else if (now - node._biasCandidateT > 700) {
        // Candidate held for >700ms -- commit it.
        node._biasQ = target;
      }
      const shift = forwardBias * radius * chunkSize;
      cx += Math.sin(node._biasQ) * shift;
      cz += Math.cos(node._biasQ) * shift;
    }
  }
  return {
    tx: Math.round(cx / chunkSize),
    tz: Math.round(cz / chunkSize)
  };
}

/* World-space fBm sample. Wraps _terrainFBM to take WORLD coordinates
 * (x, z in world units) instead of normalized 0..1 UV -- so adjacent
 * chunks produce a continuous height field at their shared boundary
 * without any per-chunk seam offset.
 *
 * The "frequency" param at this layer is cycles-per-world-unit (not
 * cycles-per-chunk). At freq=0.02 the noise wraps once every 50 units
 * which matches typical open-world rolling-terrain feature scale. */
/* §5.5.e-11 -- island-mode "land amount" at a world XZ. Returns 1
 * inside an island (full terrain), 0 in the ocean (sea-floor), with
 * smooth transitions at the shoreline. Branches on ip.mode:
 *   "single"      -- radial falloff from (cx, cz), power curve
 *   "archipelago" -- low-frequency noise mask, smoothstep threshold
 * Cheap: at most one mask-noise call per sample. */
function _tiledIslandLandAmount(wx, wz, ip) {
  if (!ip) return 1;
  if (ip.mode === "single") {
    const dx = wx - ip.cx;
    const dz = wz - ip.cz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const t = (ip.radius > 0) ? (dist / ip.radius) : 0;
    if (t >= 1) return 0;
    return Math.pow(1 - t, ip.power);
  }
  if (ip.mode === "archipelago") {
    // Low-frequency single-octave noise as the island mask. Cheap;
    // returns 0..1. Threshold + smoothstep produce sharp coastlines
    // with soft transitions. Octaves=1 keeps cost minimal.
    const m = _terrainValueNoise(wx * ip.maskFreq, wz * ip.maskFreq, ip.maskSeed);
    const lo = ip.maskThreshold - ip.maskSoftness;
    const hi = ip.maskThreshold + ip.maskSoftness;
    const u = Math.max(0, Math.min(1, (m - lo) / Math.max(1e-6, hi - lo)));
    return u * u * (3 - 2 * u);    // smoothstep
  }
  return 1;
}

/* §5.5.e-11 -- LERP between terrain Y and sea-floor Y based on
 * island land amount. Called from chunk builder + ground sampler
 * AFTER erosion so erosion only sees the natural unbounded terrain.
 * This is cheaper than the previous height-amplitude squish (which
 * lived inside _tiledBaseHeight and got hit by every erosion
 * neighbor lookup -- 8x cost). Here the mask sample is once per
 * vertex only. */
function _tiledFinalY(wx, wz, noise, hs, yOff) {
  const h = _tiledTerrainHeightAt(wx, wz, noise);
  let terrainY = (h - 1) * hs + yOff;
  if (!noise || !noise.islandParams) return terrainY;
  const ip = noise.islandParams;
  const f  = _tiledIslandLandAmount(wx, wz, ip);
  // §5.5.h-11 -- coastal peak squash. Scale terrain elevation ABOVE
  // sea level by f^2 so peaks only emerge well inland; near the
  // shoreline (low f) the surface stays close to sea level. Combined
  // with a wider mask softness this gives islands a natural conical
  // slope from coast to interior, which in turn gives the beach band
  // and the water's shallow band more horizontal real estate.
  if (terrainY > yOff) {
    const peakAmt = f * f;
    terrainY = yOff + (terrainY - yOff) * peakAmt;
  }
  // §5.5.h-9 beach band. Where coastal noise (seed derived from
  // maskSeed) is high AND the island mask is in the shore band, blend
  // terrain elevation toward a flat beach plane at yOff + 4m. Mirrors
  // the WGSL water shader's shore-detect path so the foam line still
  // lands at the visible beach edge.
  if (ip.beachStrength > 0 && f > 0.0 && f < 0.95) {
    const bn = _terrainValueNoise(wx * ip.beachFreq, wz * ip.beachFreq, ip.maskSeed + 17.3);
    const coastal = Math.min(1, f / 0.5) * Math.min(1, (0.95 - f) / 0.4);
    const beachy = Math.max(0, (bn - 0.45) / 0.25);
    const blend = Math.min(1, coastal * beachy * ip.beachStrength);
    if (blend > 0) {
      const beachY = yOff + 4;
      terrainY = terrainY * (1 - blend) + beachY * blend;
    }
  }
  if (f >= 0.9999) return terrainY;
  const seaFloor = yOff - ip.sinkDepth;
  return terrainY * f + seaFloor * (1 - f);
}

/* Base height field: pure fBm + plateau remap. Erosion samples
 * this; the island LERP is applied LATER in _tiledFinalY so it
 * doesn't multiply by erosion's neighbor count. */
function _tiledBaseHeight(wx, wz, noise) {
  let h = _terrainFBM(wx, wz, noise);
  const p = (noise && typeof noise.plateau === "number") ? noise.plateau : 0;
  if (p > 0) {
    const k = 1 + Math.max(0, Math.min(1, p)) * 4;
    h = Math.pow(Math.max(0, Math.min(1, h)), k);
  }
  return h;
}

/* §5.5.e-8 -- JS port of the TerrainErosion fragment shader.
 * Samples the BASE height field at 8 neighbors per iteration at
 * progressively larger radii (geometric ×1.5). Each iteration runs
 * thermal (move toward min neighbor when slope > talus) + hydraulic
 * (move toward avg neighbor on convex curvature). Cost per call is
 * O(iters * 8) fBm evals -- meaningfully expensive, so keep
 * iterations small (3-6) on this path. Radius is in world units. */
function _tiledApplyErosionJS(centerH, wx, wz, noise) {
  const ep = noise.erosionParams;
  if (!ep) return centerH;
  const iters     = Math.max(1, Math.min(16, Math.floor(ep.iterations || 6)));
  const baseR     = Math.max(0.1, ep.radius || 4.0);
  const thermal   = Math.max(0, Math.min(1, ep.thermal   || 0));
  const hydraulic = Math.max(0, Math.min(1, ep.hydraulic || 0));
  const talus     = Math.max(0, ep.talus || 0.01);
  const strength  = Math.max(0, Math.min(1, ep.strength || 1));
  const smoothstepClamped = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-6, e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  let eroded = centerH;
  for (let i = 0; i < iters; i++) {
    const r = baseR * Math.pow(1.5, i);
    const nW  = _tiledBaseHeight(wx - r, wz,     noise);
    const nE  = _tiledBaseHeight(wx + r, wz,     noise);
    const nN  = _tiledBaseHeight(wx,     wz + r, noise);
    const nS  = _tiledBaseHeight(wx,     wz - r, noise);
    const nNW = _tiledBaseHeight(wx - r, wz + r, noise);
    const nNE = _tiledBaseHeight(wx + r, wz + r, noise);
    const nSW = _tiledBaseHeight(wx - r, wz - r, noise);
    const nSE = _tiledBaseHeight(wx + r, wz - r, noise);
    const nbrAvg = (nW + nE + nN + nS + nNW + nNE + nSW + nSE) * 0.125;
    const minNbr = Math.min(nW, nE, Math.min(nN, nS),
                             Math.min(Math.min(nNW, nNE), Math.min(nSW, nSE)));
    const slope = Math.max(0, eroded - minNbr);
    const thermalBlend = thermal * smoothstepClamped(talus, talus + 0.04, slope);
    eroded = eroded + (minNbr - eroded) * thermalBlend;
    const curvature = nbrAvg - eroded;
    const convexAmt = smoothstepClamped(0.0, 0.02, -curvature);
    const hydroBlend = hydraulic * convexAmt;
    eroded = eroded + (nbrAvg - eroded) * hydroBlend;
  }
  return centerH + (eroded - centerH) * strength;
}

/* Public sample: base height + (optional) JS-port erosion. Same
 * formula that the rendered mesh + the camera walk surface read,
 * so they always agree on Y. */
function _tiledTerrainHeightAt(wx, wz, noise) {
  let h = _tiledBaseHeight(wx, wz, noise);
  if (noise && noise.erosionParams) {
    h = _tiledApplyErosionJS(h, wx, wz, noise);
  }
  return h;
}

/* §5.5.e-10 -- read island-mode params off the TiledTerrain node.
 * Returns null when islandMode is "off" so the no-island path stays
 * a zero-overhead branch in the Y mapping + ground sampler. */
function _findTiledIslandParams(ttNode) {
  const p = ttNode && ttNode.params;
  if (!p) return null;
  const mode = (typeof p.islandMode === "string") ? p.islandMode : "off";
  if (mode === "off") return null;
  return {
    mode:       mode,
    sinkDepth:  (typeof p.islandSinkDepth     === "number") ? p.islandSinkDepth     : 2200,
    // single-mode params
    cx:         (typeof p.islandCenterX       === "number") ? p.islandCenterX       : 0,
    cz:         (typeof p.islandCenterZ       === "number") ? p.islandCenterZ       : 0,
    radius:     (typeof p.islandRadius        === "number") ? p.islandRadius        : 2500,
    power:      (typeof p.islandFalloff       === "number") ? p.islandFalloff       : 2.0,
    // archipelago-mode params
    maskFreq:      (typeof p.islandMaskFreq      === "number") ? p.islandMaskFreq      : 0.00012,
    maskSeed:      (typeof p.islandMaskSeed      === "number") ? p.islandMaskSeed      : 11.7,
    maskThreshold: (typeof p.islandMaskThreshold === "number") ? p.islandMaskThreshold : 0.50,
    maskSoftness:  (typeof p.islandMaskSoftness  === "number") ? p.islandMaskSoftness  : 0.08,
    beachStrength: (typeof p.islandBeachStrength === "number") ? p.islandBeachStrength : 0.0,
    beachFreq:     (typeof p.islandBeachFreq     === "number") ? p.islandBeachFreq     : 0.0008
  };
}

/* Read built-in erosion params off the TiledTerrain node itself.
 * Returns null when erosionStrength <= 0 so the no-erosion path
 * stays a zero-overhead branch in _tiledTerrainHeightAt. */
function _findTiledErosionParams(ttNode) {
  const p = ttNode && ttNode.params;
  if (!p) return null;
  const strength = (typeof p.erosionStrength === "number") ? p.erosionStrength : 0;
  if (strength <= 0.0001) return null;
  return {
    thermal:    (typeof p.erosionThermal    === "number") ? p.erosionThermal    : 0.65,
    hydraulic:  (typeof p.erosionHydraulic  === "number") ? p.erosionHydraulic  : 0.55,
    talus:      (typeof p.erosionTalus      === "number") ? p.erosionTalus      : 0.02,
    iterations: (typeof p.erosionIterations === "number") ? p.erosionIterations : 4,
    radius:     (typeof p.erosionRadius     === "number") ? p.erosionRadius     : 80,
    strength:   strength
  };
}

/* §5.5.e-7 -- per-chunk LOD picker with FIVE rings (was three).
 * Lets the user crank chunkRadius up to 20+ for 20/20-vision view
 * distances (10km+ diameter) while keeping per-frame vert / index
 * cost bounded. Per-ring fraction of radius:
 *
 *   ring <= 20% radius : full detail (close detail walked on)
 *   ring <= 40%        : half  (still readable)
 *   ring <= 60%        : quarter (mountainsides at distance)
 *   ring <= 80%        : eighth (far peaks, distinguishable silhouette)
 *   ring  > 80%        : sixteenth (horizon haze region)
 *
 * Each step halves segment count, so a 24-seg base becomes
 * 24 / 12 / 6 / 3 / 2 across the five rings. T-junction seams
 * between LOD levels are masked by per-chunk vertical skirts. */
function _tiledTerrainLodSegments(dxAbs, dzAbs, radius, baseSegs) {
  const ring = Math.max(dxAbs, dzAbs);
  if (radius <= 0) return baseSegs;
  const t = ring / radius;
  if (t <= 0.20) return baseSegs;
  if (t <= 0.40) return Math.max(2, baseSegs >> 1);
  if (t <= 0.60) return Math.max(2, baseSegs >> 2);
  if (t <= 0.80) return Math.max(2, baseSegs >> 3);
  return 2;
}

/* Phase 7 §5.5.h -- Water plane mesh. A single huge XZ quad at
 * Y = seaLevel. 100km × 100km so it covers any practical walking
 * session without a follow-camera implementation. Just 4 verts +
 * 6 indices -- negligible memory. Wave animation + Fresnel happen
 * in the fragment shader (fs_water), not in the geometry. */
function _buildWater(node) {
  const p = node.params || {};
  const seaY = (typeof p.seaLevel === "number") ? p.seaLevel : 0;
  // §planet-spec Phase 6+ -- when a Planet is in the patch, emit a
  // SUBDIVIDED + sphere-projected water mesh so the ocean curves
  // with the planet instead of stretching as a flat quad. The
  // subdivision lets fs_water's existing per-fragment waves+foam+
  // Fresnel run on a curved surface; the wave function reads world
  // XZ which on a sphere is arc-distance-from-pole (correct near the
  // spawn, mild distortion at the limb -- acceptable for an ocean
  // shell). Beyond this mesh's extent, Planet's own h<seaLevel
  // ocean-color cells take over at the same Y, so the boundary is
  // invisible.
  const planet = _findPlanetForProjection();
  if (planet) {
    // §planet-spec Phase 6b -- Water as a 6-face cube-sphere SHELL
    // wrapping the entire planet at sea radius. The prior flat-quad-
    // projected mesh only covered a ~4Mm disc around the camera and
    // left the back of the planet uncovered, so flying away from the
    // spawn revealed Planet's flat blue ocean cells with no waves
    // outside the disc. This emits 6 cube faces of (segs+1)² verts
    // each, projected via the spherify warp; total ~6534 verts.
    //
    // fs_water computes waves + foam + Fresnel per-fragment, so per-
    // vertex density doesn't affect wave detail. The vertices just
    // define the underlying sphere surface, and 33-per-face is
    // plenty for a smooth sphere shape from any altitude.
    const segs = 32;
    const N = segs + 1;
    const vertsPerFace = N * N;
    const trisPerFace = segs * segs * 2;
    const verts = new Float32Array(6 * vertsPerFace * 11);
    const indices = new Uint32Array(6 * trisPerFace * 3);
    let vi = 0, ii = 0;
    for (let f = 0; f < 6; f++) {
      const face = _PLANET_FACES[f];
      const nX = face.n[0], nY = face.n[1], nZ = face.n[2];
      const tX = face.t[0], tY = face.t[1], tZ = face.t[2];
      const bX = face.b[0], bY = face.b[1], bZ = face.b[2];
      const vertBase = f * vertsPerFace;
      for (let iy = 0; iy <= segs; iy++) {
        const fy01 = iy / segs;
        const v = fy01 * 2 - 1;
        for (let ix = 0; ix <= segs; ix++) {
          const fx01 = ix / segs;
          const u = fx01 * 2 - 1;
          const cx = nX + tX * u + bX * v;
          const cy = nY + tY * u + bY * v;
          const cz = nZ + tZ * u + bZ * v;
          const cxx = cx * cx, cyy = cy * cy, czz = cz * cz;
          const sx = cx * Math.sqrt(Math.max(0, 1 - cyy * 0.5 - czz * 0.5 + cyy * czz / 3));
          const sy = cy * Math.sqrt(Math.max(0, 1 - cxx * 0.5 - czz * 0.5 + cxx * czz / 3));
          const sz = cz * Math.sqrt(Math.max(0, 1 - cxx * 0.5 - cyy * 0.5 + cxx * cyy / 3));
          const invLen = 1 / Math.max(1e-12, Math.sqrt(sx*sx + sy*sy + sz*sz));
          const ux = sx * invLen, uy = sy * invLen, uz = sz * invLen;
          // Position on the planet's sea-level ellipsoid + seaY offset
          // along radial direction (lets the user raise water above
          // the smooth-sphere surface if they want).
          const px = planet.cx + planet.r * ux + seaY * ux;
          const py = planet.cy + planet.r * uy * planet.polRatio + seaY * uy;
          const pz = planet.cz + planet.r * uz + seaY * uz;
          verts[vi++] = px;
          verts[vi++] = py;
          verts[vi++] = pz;
          verts[vi++] = 0.2; verts[vi++] = 0.4; verts[vi++] = 0.6;
          // Radial-outward normal -- correct for a sphere shell.
          verts[vi++] = ux; verts[vi++] = uy; verts[vi++] = uz;
          // World XZ as UV so fs_water reads world-space wave coords.
          verts[vi++] = px; verts[vi++] = pz;
        }
      }
      for (let iy = 0; iy < segs; iy++) {
        for (let ix = 0; ix < segs; ix++) {
          const a = vertBase + iy * N + ix;
          const b = a + 1;
          const c = a + N;
          const d = c + 1;
          indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
          indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
        }
      }
    }
    return { verts, indices };
  }
  // Flat fallback (no Planet): the original 4-vert stopgap.
  const half = 2000000;
  const verts = new Float32Array([
    -half, seaY, -half,   0.2, 0.4, 0.6,   0, 1, 0,   -half, -half,
     half, seaY, -half,   0.2, 0.4, 0.6,   0, 1, 0,    half, -half,
     half, seaY,  half,   0.2, 0.4, 0.6,   0, 1, 0,    half,  half,
    -half, seaY,  half,   0.2, 0.4, 0.6,   0, 1, 0,   -half,  half
  ]);
  const indices = new Uint32Array([0, 1, 2,  0, 2, 3]);
  return { verts, indices };
}

/* Phase 7 §5.5.h-23 -- TerrainHorizon. Macro-tile camera-follow helper. */
function _terrainHorizonMacroTile(node) {
  const p = node.params || {};
  const tileSize = Math.max(1000, (typeof p.tileSize === "number") ? p.tileSize : 10000);
  let cx = 0, cz = 0;
  if (state && Array.isArray(state.nodes)) {
    const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
    if (cam && cam.params) {
      if (typeof cam.params.posX === "number") cx = cam.params.posX;
      if (typeof cam.params.posZ === "number") cz = cam.params.posZ;
    }
  }
  return {
    // §5.5.h-24 -- round (not floor) so the tile center stays within
    // ±tileSize/2 of the camera; impostor extent stays symmetric.
    tx: Math.round(cx / tileSize),
    tz: Math.round(cz / tileSize),
    tileSize
  };
}

/* TerrainHorizon mesh builder. One subdivided plane covering `extent`
 * world units centered on the camera's current macro-tile. Samples the
 * upstream TiledTerrain's noise (capped at `octaves` for cheapness,
 * skipping erosion) so silhouettes match the chunked disc at their
 * meeting line. Per-vertex altitude-banded colors so it can render
 * unlit-vc without a separate Material node. */
function _buildTerrainHorizon(node) {
  const p = node.params || {};
  const extent  = Math.max(10000, (typeof p.extent === "number") ? p.extent : 100000);
  const segs    = Math.max(8, Math.min(256, Math.floor((typeof p.subdivisions === "number") ? p.subdivisions : 96)));
  const yBias   = (typeof p.yBias === "number") ? p.yBias : -0.5;

  // Pull noise from any TiledTerrain in the patch. Without one, the
  // impostor falls back to a flat sea-level plane.
  let tt = null;
  if (state && Array.isArray(state.nodes)) {
    tt = state.nodes.find(n => n && n.type === "TiledTerrain") || null;
  }
  const ttp = (tt && tt.params) || {};
  const macro = _terrainHorizonMacroTile(node);
  const centerX = macro.tx * macro.tileSize;
  const centerZ = macro.tz * macro.tileSize;
  const half    = extent * 0.5;
  const step    = extent / segs;
  const side    = segs + 1;
  const vertCount = side * side;

  // §planet-spec Phase 3 -- the impostor uses the SAME noise field
  // as the chunked TiledTerrain (no frequency rescaling). The LOD
  // truncation comes from the impostor's coarse vertex spacing
  // (`step`) feeding _octavesForSpacing -- octaves smaller than the
  // Nyquist limit are dropped, so the impostor naturally shows the
  // low-frequency big-shape silhouette of the same noise without
  // aliasing the high-freq detail. No more silhouette mismatch with
  // the chunked disc at the meeting line.
  const ttFreq    = (typeof ttp.frequency === "number") ? ttp.frequency : 0.0008;
  const ttOctaves = (typeof ttp.octaves   === "number") ? ttp.octaves   : 5;
  const horizonCap = (typeof p.octavesCap === "number") ? p.octavesCap : 20;
  const lodOctF   = _octavesForSpacing(ttFreq, step, 20);
  const effOctavesF = Math.min(ttOctaves, horizonCap, lodOctF);
  const noise = tt ? {
    seed:        (typeof ttp.seed       === "number") ? ttp.seed       : 7.42,
    frequency:   ttFreq,
    octaves:     ttOctaves,
    effectiveOctavesF: effOctavesF,
    lacunarity:  (typeof ttp.lacunarity === "number") ? ttp.lacunarity : 2.0,
    gain:        (typeof ttp.gain       === "number") ? ttp.gain       : 0.5,
    ridges:      (typeof ttp.ridges     === "number") ? ttp.ridges     : 0,
    plateau:     (typeof ttp.plateau    === "number") ? ttp.plateau    : 0,
    islandParams: _findTiledIslandParams(tt)
  } : null;
  const hs   = tt ? ((typeof ttp.heightScale === "number") ? ttp.heightScale : 80) : 0;
  const yOff = tt ? ((typeof ttp.yOffset    === "number") ? ttp.yOffset    : 0) : 0;

  // Pass 1: sample heights so pass 2 can compute normals via finite
  // difference. Cheap reuse of the existing _tiledFinalY (erosion is
  // gated inside _tiledTerrainHeightAt, off when noise.erosionParams
  // is null -- which is always true for the horizon since we don't
  // copy it from TiledTerrain).
  const heightArr = new Float32Array(vertCount);
  for (let iz = 0; iz <= segs; iz++) {
    const wz = centerZ - half + iz * step;
    for (let ix = 0; ix <= segs; ix++) {
      const wx = centerX - half + ix * step;
      const vi = iz * side + ix;
      heightArr[vi] = tt ? _tiledFinalY(wx, wz, noise, hs, yOff) + yBias : yOff + yBias;
    }
  }

  // §5.5.h-24 -- sea level for altitude bands + blue-water check.
  // Pulled from any Water node in the patch; defaults to 0.
  let seaLevel = 0;
  if (state && Array.isArray(state.nodes)) {
    const wn = state.nodes.find(n => n && n.type === "Water");
    if (wn && wn.params && typeof wn.params.seaLevel === "number") {
      seaLevel = wn.params.seaLevel;
    }
  }
  // Pass 2: emit verts with normals + altitude-band colors.
  const verts   = new Float32Array(vertCount * 11);
  const indices = new Uint32Array(segs * segs * 6);
  const sand   = [0.78, 0.72, 0.52];
  const grass  = [0.36, 0.50, 0.28];
  const rock   = [0.55, 0.50, 0.45];
  const snow   = [0.97, 0.97, 0.99];
  const deepW  = [0.05, 0.13, 0.24];
  function lerp3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  // Reference altitude band width: 1500m peak-to-sea is reasonable
  // for the archipelago demo and tracks heightScale for other patches.
  const bandRef = Math.max(200, hs * 1.25);
  for (let iz = 0; iz <= segs; iz++) {
    for (let ix = 0; ix <= segs; ix++) {
      const vi = iz * side + ix;
      const wx = centerX - half + ix * step;
      const wz = centerZ - half + iz * step;
      const y  = heightArr[vi];
      // Central difference normal.
      const ixn = (ix > 0)     ? ix - 1 : ix;
      const ixp = (ix < segs)  ? ix + 1 : ix;
      const izn = (iz > 0)     ? iz - 1 : iz;
      const izp = (iz < segs)  ? iz + 1 : iz;
      const yL  = heightArr[iz * side + ixn];
      const yR  = heightArr[iz * side + ixp];
      const yU  = heightArr[izn * side + ix];
      const yD  = heightArr[izp * side + ix];
      const dx  = (ixp - ixn) * step || 1;
      const dz  = (izp - izn) * step || 1;
      let nx = -(yR - yL) / dx;
      let ny = 1;
      let nz = -(yD - yU) / dz;
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 1e-6) { nx /= nl; ny /= nl; nz /= nl; }
      // §5.5.h-24 -- altitude bands referenced to actual SEA LEVEL,
      // not yOff. Vertices below sea level get the deep-water blue;
      // above-sea verts band by altitude over bandRef meters.
      let col;
      if (y < seaLevel - 5) {
        col = deepW;
      } else {
        const altNorm = Math.min(1, Math.max(0, (y - seaLevel) / bandRef));
        if (altNorm < 0.20) {
          col = lerp3(sand, grass, altNorm / 0.20);
        } else if (altNorm < 0.60) {
          col = lerp3(grass, rock, (altNorm - 0.20) / 0.40);
        } else {
          col = lerp3(rock, snow, Math.min(1, (altNorm - 0.60) / 0.30));
        }
      }
      const base = vi * 11;
      verts[base + 0] = wx;
      verts[base + 1] = y;
      verts[base + 2] = wz;
      verts[base + 3] = col[0];
      verts[base + 4] = col[1];
      verts[base + 5] = col[2];
      verts[base + 6] = nx;
      verts[base + 7] = ny;
      verts[base + 8] = nz;
      verts[base + 9] = ix / segs;
      verts[base + 10] = iz / segs;
    }
  }

  let idx = 0;
  for (let iz = 0; iz < segs; iz++) {
    for (let ix = 0; ix < segs; ix++) {
      const v00 = iz * side + ix;
      const v10 = v00 + 1;
      const v01 = v00 + side;
      const v11 = v01 + 1;
      indices[idx++] = v00; indices[idx++] = v01; indices[idx++] = v10;
      indices[idx++] = v10; indices[idx++] = v01; indices[idx++] = v11;
    }
  }
  return { verts, indices };
}

/* Phase 7 §5.5.h-18 -- Clouds3D chunked + rounded-bottom streaming.
 * Mirrors TiledTerrain's per-chunk VBO/IBO architecture so chunks
 * stream in/out as the camera moves, frustum-cull individually, and
 * LOD-down at distance. Each chunk emits TWO heightfield surfaces:
 *   - Top displaces UP from altitude by (noise - threshold) * puffHeight
 *   - Bottom displaces DOWN by the same amount × bottomRound
 * Top and bottom share per-vertex alpha (smoothstep around the
 * coverage threshold) so cloud edges meet at altitude where the
 * displacement goes to zero -- gives proper rounded puffs from
 * either side instead of flat-bottomed slabs.
 *
 * State lives in Visual.cloudsChunkCache, keyed by node.id:
 *   { chunks: Map<key, chunkBuf>, globalKey }
 * Same two-phase streaming as TiledTerrain (placeholder + upgrade
 * under separate time budgets) so tile crossings don't stall. */

function _cloudsCenterTile(node) {
  const p = node.params || {};
  const chunkSize = Math.max(1, (typeof p.chunkSize === "number") ? p.chunkSize : 1800);
  // Anchor to the first FPCamera / Camera in the patch -- same logic
  // TiledTerrain uses (camera-follow disc). Falls back to origin if
  // no camera is wired yet.
  let cx = 0, cz = 0;
  if (state && Array.isArray(state.nodes)) {
    const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
    if (cam && cam.params) {
      if (typeof cam.params.posX === "number") cx = cam.params.posX;
      if (typeof cam.params.posZ === "number") cz = cam.params.posZ;
    }
  }
  return { tx: Math.floor(cx / chunkSize), tz: Math.floor(cz / chunkSize), chunkSize };
}

function _cloudsLodSegments(dxAbs, dzAbs, radius, baseSegs) {
  const ring = Math.max(dxAbs, dzAbs);
  if (radius <= 0) return baseSegs;
  const t = ring / radius;
  if (t <= 0.30) return baseSegs;
  if (t <= 0.55) return Math.max(4, baseSegs >> 1);
  if (t <= 0.80) return Math.max(4, baseSegs >> 2);
  return Math.max(2, baseSegs >> 3);
}

function _cloudsGlobalCacheKey(node) {
  const p = node.params || {};
  return [
    p.chunkSize, p.chunkRadius, p.segments,
    p.altitude, p.puffHeight, p.bottomRound,
    p.coverage, p.scale, p.seed
  ].join(",");
}

function _computeVisibleCloudChunks(node) {
  const p = node.params || {};
  const radius   = Math.max(0, Math.min(16, Math.floor((typeof p.chunkRadius === "number") ? p.chunkRadius : 5)));
  const baseSegs = Math.max(4, Math.min(64, Math.floor((typeof p.segments    === "number") ? p.segments    : 28)));
  const center = _cloudsCenterTile(node);
  const visible = new Map();
  for (let cz = -radius; cz <= radius; cz++) {
    for (let cx = -radius; cx <= radius; cx++) {
      const segs = _cloudsLodSegments(Math.abs(cx), Math.abs(cz), radius, baseSegs);
      const tileX = center.tx + cx;
      const tileZ = center.tz + cz;
      const key = tileX + "," + tileZ;
      visible.set(key, { tileX, tileZ, segs });
    }
  }
  return visible;
}

/* Build ONE cloud chunk: top + bottom heightfields stitched together
 * into a single VBO/IBO so the encoder can issue one draw per chunk.
 * Returns { vertexBuffer, indexBuffer, indexCount, aabbMin, aabbMax,
 *           tileX, tileZ, lod }. */
function _buildSingleCloudChunk(node, info) {
  if (!Visual.device) return null;
  const p = node.params || {};
  const cy        = (typeof p.altitude    === "number") ? p.altitude    : 2500;
  const puffH     = (typeof p.puffHeight  === "number") ? p.puffHeight  : 600;
  const botRound  = Math.max(0, (typeof p.bottomRound === "number") ? p.bottomRound : 0.7);
  const coverage  = (typeof p.coverage    === "number") ? p.coverage    : 0.45;
  const scale     = (typeof p.scale       === "number") ? p.scale       : 0.0008;
  const seed      = (typeof p.seed        === "number") ? p.seed        : 11.3;
  const chunkSize = Math.max(1, (typeof p.chunkSize === "number") ? p.chunkSize : 1800);
  const segs      = Math.max(2, Math.floor(info.segs));
  const x0        = info.tileX * chunkSize;
  const z0        = info.tileZ * chunkSize;
  const step      = chunkSize / segs;
  const side      = segs + 1;
  const gridCount = side * side;
  const threshold = 1.0 - coverage;

  // Pass 1: sample noise, compute top + bottom heights for each grid cell.
  const noiseArr = new Float32Array(gridCount);
  const topY     = new Float32Array(gridCount);
  const botY     = new Float32Array(gridCount);
  for (let iz = 0; iz <= segs; iz++) {
    const z = z0 + iz * step;
    for (let ix = 0; ix <= segs; ix++) {
      const x = x0 + ix * step;
      // 4-octave fbm in world coords -- chunk boundaries are seamless
      // because we sample world XZ, not local.
      let n = 0, amp = 0.5, freq = 1, maxAmp = 0;
      for (let oct = 0; oct < 4; oct++) {
        n += amp * _terrainValueNoise(x * scale * freq, z * scale * freq, seed + oct * 3.7);
        maxAmp += amp;
        amp  *= 0.55;
        freq *= 2.07;
      }
      n = n / maxAmp;
      const displ = Math.max(0, n - threshold) / Math.max(0.001, 1 - threshold);
      const vi = iz * side + ix;
      noiseArr[vi] = n;
      topY[vi] = cy + displ * puffH;
      botY[vi] = cy - displ * puffH * botRound;
    }
  }

  // Pass 2: emit two vertex buffers (top + bottom), with finite-
  // difference normals. Top normals point up-ish, bottom normals
  // point down-ish so Phong shading reads correctly from each side.
  const verts = new Float32Array(gridCount * 2 * 11);
  const idxCount = segs * segs * 6 * 2;       // both surfaces
  const indices = new Uint32Array(idxCount);
  const alphaBand = 0.10;
  let aMinX = Infinity, aMinY = Infinity, aMinZ = Infinity;
  let aMaxX = -Infinity, aMaxY = -Infinity, aMaxZ = -Infinity;

  function writeSide(yArr, normalSign, vOff) {
    for (let iz = 0; iz <= segs; iz++) {
      for (let ix = 0; ix <= segs; ix++) {
        const vi = iz * side + ix;
        const x  = x0 + ix * step;
        const z  = z0 + iz * step;
        const y  = yArr[vi];
        const ixn = (ix > 0)        ? ix - 1 : ix;
        const ixp = (ix < segs)     ? ix + 1 : ix;
        const izn = (iz > 0)        ? iz - 1 : iz;
        const izp = (iz < segs)     ? iz + 1 : iz;
        const yL  = yArr[iz * side + ixn];
        const yR  = yArr[iz * side + ixp];
        const yU  = yArr[izn * side + ix];
        const yD  = yArr[izp * side + ix];
        const dx  = (ixp - ixn) * step || 1;
        const dz  = (izp - izn) * step || 1;
        let nx = -(yR - yL) / dx;
        let ny = normalSign;
        let nz = -(yD - yU) / dz;
        const nl = Math.hypot(nx, ny, nz);
        if (nl > 1e-6) { nx /= nl; ny /= nl; nz /= nl; }
        const t  = noiseArr[vi];
        const a  = Math.max(0, Math.min(1, (t - (threshold - alphaBand)) / (2 * alphaBand)));
        const base = (vOff + vi) * 11;
        verts[base + 0] = x;
        verts[base + 1] = y;
        verts[base + 2] = z;
        verts[base + 3] = a;
        verts[base + 4] = 0;
        verts[base + 5] = 0;
        verts[base + 6] = nx;
        verts[base + 7] = ny;
        verts[base + 8] = nz;
        verts[base + 9]  = ix / segs;
        verts[base + 10] = iz / segs;
        if (x < aMinX) aMinX = x; if (x > aMaxX) aMaxX = x;
        if (y < aMinY) aMinY = y; if (y > aMaxY) aMaxY = y;
        if (z < aMinZ) aMinZ = z; if (z > aMaxZ) aMaxZ = z;
      }
    }
  }

  writeSide(topY, +1, 0);                       // top surface, vertex slot 0..gridCount-1
  writeSide(botY, -1, gridCount);               // bottom surface, gridCount..2*gridCount-1

  let idx = 0;
  // Top: CCW from above
  for (let iz = 0; iz < segs; iz++) {
    for (let ix = 0; ix < segs; ix++) {
      const v00 = iz * side + ix;
      const v10 = v00 + 1;
      const v01 = v00 + side;
      const v11 = v01 + 1;
      indices[idx++] = v00; indices[idx++] = v01; indices[idx++] = v10;
      indices[idx++] = v10; indices[idx++] = v01; indices[idx++] = v11;
    }
  }
  // Bottom: opposite winding so its normals' "front face" sense matches
  for (let iz = 0; iz < segs; iz++) {
    for (let ix = 0; ix < segs; ix++) {
      const v00 = gridCount + iz * side + ix;
      const v10 = v00 + 1;
      const v01 = v00 + side;
      const v11 = v01 + 1;
      indices[idx++] = v00; indices[idx++] = v10; indices[idx++] = v01;
      indices[idx++] = v10; indices[idx++] = v11; indices[idx++] = v01;
    }
  }

  const vertexBuffer = Visual.device.createBuffer({
    label: "clouds-vb-" + node.id + "-" + info.tileX + "," + info.tileZ + "-l" + segs,
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(verts);
  vertexBuffer.unmap();
  const indexBuffer = Visual.device.createBuffer({
    label: "clouds-ib-" + node.id + "-" + info.tileX + "," + info.tileZ + "-l" + segs,
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(indexBuffer.getMappedRange()).set(indices);
  indexBuffer.unmap();

  return {
    vertexBuffer, indexBuffer,
    indexCount: indices.length,
    vertexCount: gridCount * 2,
    aabbMin: new Float32Array([aMinX, aMinY, aMinZ]),
    aabbMax: new Float32Array([aMaxX, aMaxY, aMaxZ]),
    tileX: info.tileX, tileZ: info.tileZ, lod: segs
  };
}

/* Streaming entry. Drop chunks that left the disc, build new ones
 * under a per-frame time budget, return the live chunk list for the
 * encoder. Identical two-phase (placeholder + upgrade) shape as
 * _ensureTiledTerrainChunks. */
function _ensureClouds3DChunks(node) {
  if (!Visual.device) return null;
  if (!Visual.cloudsChunkCache) Visual.cloudsChunkCache = new Map();
  let entry = Visual.cloudsChunkCache.get(node.id);
  if (!entry) {
    entry = { chunks: new Map(), globalKey: null };
    Visual.cloudsChunkCache.set(node.id, entry);
  }
  const globalKey = _cloudsGlobalCacheKey(node);
  if (globalKey !== entry.globalKey) {
    for (const c of entry.chunks.values()) {
      try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
      try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
    }
    entry.chunks.clear();
    entry.globalKey = globalKey;
  }

  const visible = _computeVisibleCloudChunks(node);

  // Drop chunks that left the disc.
  const keysToDrop = [];
  for (const key of entry.chunks.keys()) {
    if (!visible.has(key)) keysToDrop.push(key);
  }
  for (const key of keysToDrop) {
    const c = entry.chunks.get(key);
    try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
    try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
    entry.chunks.delete(key);
  }

  const center = _cloudsCenterTile(node);
  const ringOf = (i) => Math.max(Math.abs(i.tileX - center.tx), Math.abs(i.tileZ - center.tz));

  // Phase 1: cheap LOD-4 placeholders for visible tiles not yet built.
  const phPending = [];
  for (const [key, info] of visible) {
    if (entry.chunks.has(key)) continue;
    phPending.push({ key, info, ring: ringOf(info) });
  }
  phPending.sort((a, b) => a.ring - b.ring);
  const phStart = performance.now();
  for (let i = 0; i < phPending.length; i++) {
    const item = phPending[i];
    const ph = _buildSingleCloudChunk(node, { tileX: item.info.tileX, tileZ: item.info.tileZ, segs: 4 });
    if (ph) {
      ph.currentLod = 4;
      entry.chunks.set(item.key, ph);
    }
    if (performance.now() - phStart > 6) break;
  }

  // Phase 2: upgrade to desired LOD.
  const upPending = [];
  for (const [key, info] of visible) {
    const c = entry.chunks.get(key);
    if (!c) continue;
    if (c.currentLod === info.segs) continue;
    upPending.push({ key, info, c, ring: ringOf(info) });
  }
  upPending.sort((a, b) => a.ring - b.ring);
  const upStart = performance.now();
  for (let i = 0; i < upPending.length; i++) {
    const item = upPending[i];
    const proper = _buildSingleCloudChunk(node, { tileX: item.info.tileX, tileZ: item.info.tileZ, segs: item.info.segs });
    if (proper) {
      try { item.c.vertexBuffer && item.c.vertexBuffer.destroy(); } catch (_) {}
      try { item.c.indexBuffer  && item.c.indexBuffer.destroy();  } catch (_) {}
      proper.currentLod = item.info.segs;
      entry.chunks.set(item.key, proper);
    }
    if (performance.now() - upStart > 10) break;
  }

  let aabbMin = new Float32Array([0, 0, 0]);
  let aabbMax = new Float32Array([0, 0, 0]);
  if (entry.chunks.size > 0) {
    aabbMin = new Float32Array([Infinity, Infinity, Infinity]);
    aabbMax = new Float32Array([-Infinity, -Infinity, -Infinity]);
    for (const c of entry.chunks.values()) {
      if (c.aabbMin[0] < aabbMin[0]) aabbMin[0] = c.aabbMin[0];
      if (c.aabbMin[1] < aabbMin[1]) aabbMin[1] = c.aabbMin[1];
      if (c.aabbMin[2] < aabbMin[2]) aabbMin[2] = c.aabbMin[2];
      if (c.aabbMax[0] > aabbMax[0]) aabbMax[0] = c.aabbMax[0];
      if (c.aabbMax[1] > aabbMax[1]) aabbMax[1] = c.aabbMax[1];
      if (c.aabbMax[2] > aabbMax[2]) aabbMax[2] = c.aabbMax[2];
    }
  }

  const allChunks = [];
  for (const c of entry.chunks.values()) allChunks.push(c);

  return {
    tiledChunks: allChunks,
    vertexBuffer: null,
    indexBuffer: null,
    vertexCount: 0,
    indexCount: 0,
    aabbMin, aabbMax,
    cacheKey: globalKey
  };
}

/* §5.5.e-6 -- TiledTerrain streaming. Each chunk gets its own
 * VBO+IBO, cached in Visual.tiledChunkCache per-node. As the camera
 * disc shifts (tile crossing OR yaw quantum crossing in forwardBias
 * mode), only NEW chunks build and old chunks drop -- the rest
 * stays put. Eliminates the ~200ms full-mesh rebuild stall.
 *
 * Cache layout:
 *   Visual.tiledChunkCache: Map<nodeId, { chunks: Map<key, chunkBuf>, globalKey }>
 *   key  = "tileX,tileZ,lod"  (LOD bake-in invalidates per-chunk on LOD change)
 *   buf  = { vertexBuffer, indexBuffer, indexCount, aabbMin, aabbMax,
 *            tileX, tileZ, lod }
 *
 * Global cache key encodes the non-anchor params (chunkSize, segments,
 * heightScale, noise...). Changing any drops EVERY chunk so geometry
 * never lingers stale. Anchor changes (centerTile shift) are handled
 * incrementally -- only chunks no longer in the visible set are
 * dropped + new ones build. */

function _tiledTerrainGlobalCacheKey(node) {
  const p = node.params || {};
  const ep = _findTiledErosionParams(node);
  const epKey = ep
    ? ("e:" + [ep.thermal, ep.hydraulic, ep.talus, ep.iterations, ep.radius, ep.strength].join(","))
    : "e0";
  const ip = _findTiledIslandParams(node);
  const ipKey = ip
    ? ("i:" + [ip.cx, ip.cz, ip.radius, ip.power, ip.sinkDepth].join(","))
    : "i0";
  // §planet-spec Phase 5+ -- include Planet projection parameters in
  // the cache key so chunks regenerate if a Planet is added/removed
  // or its center/radius changes (geometry depends on it).
  const planetProj = _findPlanetForProjection();
  const planetKey = planetProj
    ? ("p:" + [planetProj.cx, planetProj.cy, planetProj.cz, planetProj.r, planetProj.polRatio].join(","))
    : "p0";
  return [
    p.chunkSize, p.chunkRadius, p.segments, p.heightScale, p.yOffset,
    p.seed, p.frequency, p.octaves, p.lacunarity, p.gain, p.ridges,
    p.plateau, epKey, ipKey, planetKey
  ].join(",");
}

/* §5.5.e-13 -- visible-chunk set. Key is "tileX,tileZ" only (no
 * LOD), so a tile in the cache survives LOD changes (gets upgraded
 * in-place instead of getting dropped and re-built from scratch).
 * info.segs is the DESIRED LOD; the streaming logic ensures every
 * tile has at least a placeholder (LOD 2) within one frame of
 * becoming visible, then upgrades to info.segs over subsequent
 * frames under a budget. */
function _computeVisibleChunkSet(node) {
  const p = node.params || {};
  const radius   = Math.max(0, Math.min(32, Math.floor((typeof p.chunkRadius === "number") ? p.chunkRadius : 8)));
  const baseSegs = Math.max(2, Math.min(64, Math.floor((typeof p.segments    === "number") ? p.segments    : 24)));
  const center = _tiledTerrainCenterTile(node);
  const visible = new Map();
  for (let cz = -radius; cz <= radius; cz++) {
    for (let cx = -radius; cx <= radius; cx++) {
      const segs = _tiledTerrainLodSegments(Math.abs(cx), Math.abs(cz), radius, baseSegs);
      const tileX = center.tx + cx;
      const tileZ = center.tz + cz;
      const key = tileX + "," + tileZ;
      visible.set(key, { tileX, tileZ, segs });
    }
  }
  return visible;
}

/* Build ONE chunk's vertex + index data and upload to GPU. Returns
 * { vertexBuffer, indexBuffer, indexCount, aabbMin, aabbMax,
 *   tileX, tileZ, lod }. Same per-chunk geometry the old
 * monolithic builder produced (chunk grid + 4 vertical skirts);
 * factored out so it can be called incrementally. */
function _buildSingleChunk(node, info) {
  const p = node.params || {};
  const chunkSize = Math.max(1, (typeof p.chunkSize === "number") ? p.chunkSize : 64);
  const hs   = (typeof p.heightScale === "number") ? p.heightScale : 80;
  const yOff = (typeof p.yOffset === "number")     ? p.yOffset     : 0;
  // §planet-spec Phase 5+ -- if a Planet is in the patch, every chunk
  // vertex projects onto the planet's sphere so the local terrain
  // disc visibly bends with the planet's curvature instead of
  // floating as a flat square at altitude. The spawn (world 0, 0, 0)
  // is treated as the planet's pole; chunks at horizontal distance d
  // map to lat/lon offset arc d on the sphere. No projection if there
  // is no Planet (preserves the flat-XZ behavior of Walkable Terrain
  // and other non-planet demos).
  const planetProj = _findPlanetForProjection();
  const tileX = info.tileX;
  const tileZ = info.tileZ;
  const segs  = info.segs;
  const originX = tileX * chunkSize;
  const originZ = tileZ * chunkSize;
  const N = segs + 1;
  const dStep = chunkSize / segs;
  // §planet-spec Phase 3 -- truncate octaves to the chunk's actual
  // vertex spacing. The outermost LOD rings (segs=2) have ~chunkSize/2
  // m vertex spacing; evaluating all 6 octaves there would alias the
  // high-freq detail into low-freq garbage that shimmers as the
  // camera moves. min() with node.octaves so a coarse-noise patch
  // doesn't suddenly grow octaves it never had.
  const nodeOctaves = (typeof p.octaves === "number") ? p.octaves : 6;
  const nodeFreq    = (typeof p.frequency === "number") ? p.frequency : 0.008;
  const lodOctF     = _octavesForSpacing(nodeFreq, dStep, 20);
  const effOctavesF = Math.min(nodeOctaves, lodOctF);
  const noise = {
    seed:       (typeof p.seed       === "number") ? p.seed       : 7.42,
    frequency:  nodeFreq,
    octaves:    nodeOctaves,
    effectiveOctavesF: effOctavesF,
    lacunarity: (typeof p.lacunarity === "number") ? p.lacunarity : 2.05,
    gain:       (typeof p.gain       === "number") ? p.gain       : 0.5,
    ridges:     (typeof p.ridges     === "number") ? p.ridges     : 0.5,
    plateau:    (typeof p.plateau    === "number") ? p.plateau    : 0.0,
    erosionParams: _findTiledErosionParams(node),
    islandParams:  _findTiledIslandParams(node)
  };
  const skirtY = yOff - hs * 3;

  // Exact-size allocation (no padding) since each chunk knows its LOD.
  const vertCount = N * N + 4 * N;                          // grid + 4 skirt-bottom rows
  const indCount  = segs * segs * 6 + 4 * segs * 6;         // grid quads + skirt quads
  const verts   = new Float32Array(vertCount * 11);
  const indices = new Uint32Array(indCount);
  let vi = 0, ii = 0;

  // Heights for normals + AABB.
  const heights = new Float32Array(N * N);
  let chunkMinY = Infinity, chunkMaxY = -Infinity;
  // §planet-spec Phase 5+ -- projected-position AABB bounds. When
  // planetProj is non-null we track these during vertex emission;
  // the AABB at the bottom uses them instead of the flat-XZ origin
  // rectangle. Frustum culling depends on a tight correct AABB.
  let projMinX = Infinity, projMaxX = -Infinity;
  let projMinY = Infinity, projMaxY = -Infinity;
  let projMinZ = Infinity, projMaxZ = -Infinity;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const wx = originX + i * dStep;
      const wz = originZ + j * dStep;
      const y = _tiledFinalY(wx, wz, noise, hs, yOff);
      heights[j * N + i] = y;
      if (y < chunkMinY) chunkMinY = y;
      if (y > chunkMaxY) chunkMaxY = y;
    }
  }

  // Grid verts.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const wx = originX + i * dStep;
      const wz = originZ + j * dStep;
      const y = heights[j * N + i];
      // Central-difference normal sampled in world space so it
      // matches across chunk boundaries (the underlying fBm field
      // is continuous; LOD seams only affect mesh-level vertex
      // placement, not the world-space gradient).
      const yL = (i > 0)    ? heights[j * N + (i - 1)] : _tiledFinalY(wx - dStep, wz,         noise, hs, yOff);
      const yR = (i < segs) ? heights[j * N + (i + 1)] : _tiledFinalY(wx + dStep, wz,         noise, hs, yOff);
      const yD = (j > 0)    ? heights[(j - 1) * N + i] : _tiledFinalY(wx,         wz - dStep, noise, hs, yOff);
      const yU = (j < segs) ? heights[(j + 1) * N + i] : _tiledFinalY(wx,         wz + dStep, noise, hs, yOff);
      const dydx = (yR - yL) / (2 * dStep);
      const dydz = (yU - yD) / (2 * dStep);
      let nx = -dydx, ny = 1, nz = -dydz;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nlen; ny /= nlen; nz /= nlen;

      const h01 = (hs > 0) ? Math.max(0, Math.min(1, (y - yOff) / hs + 1)) : 0;
      let rC, gC, bC;
      if (h01 < 0.25) {
        const t = h01 / 0.25;
        rC = 0.25 + t * 0.20; gC = 0.35 + t * 0.30; bC = 0.55 - t * 0.30;
      } else if (h01 < 0.55) {
        const t = (h01 - 0.25) / 0.30;
        rC = 0.45 - t * 0.10; gC = 0.65 - t * 0.20; bC = 0.25 - t * 0.05;
      } else if (h01 < 0.80) {
        const t = (h01 - 0.55) / 0.25;
        rC = 0.35 + t * 0.30; gC = 0.45 + t * 0.20; bC = 0.20 + t * 0.30;
      } else {
        const t = (h01 - 0.80) / 0.20;
        rC = 0.65 + t * 0.35; gC = 0.65 + t * 0.35; bC = 0.50 + t * 0.50;
      }
      const slope = 1 - ny;
      const slopeMul = 1 - slope * 0.4;
      rC *= slopeMul; gC *= slopeMul; bC *= slopeMul;

      // §planet-spec Phase 5+ -- sphere-project this vertex if a
      // Planet exists. The normal stays in local (Y-up) frame -- at
      // chunk scale (≤ 256m) the arc rotation is < 0.0025° so the
      // approximation is invisible. Lambert shading on the projected
      // chunks uses this local normal, which gives correct ground
      // shading near the pole and degrades smoothly elsewhere.
      let px = wx, py = y, pz = wz;
      if (planetProj) {
        const proj = _projectFlatToPlanet(wx, y, wz, planetProj);
        px = proj[0]; py = proj[1]; pz = proj[2];
      }
      if (px < projMinX) projMinX = px;
      if (px > projMaxX) projMaxX = px;
      if (py < projMinY) projMinY = py;
      if (py > projMaxY) projMaxY = py;
      if (pz < projMinZ) projMinZ = pz;
      if (pz > projMaxZ) projMaxZ = pz;
      verts[vi++] = px;
      verts[vi++] = py;
      verts[vi++] = pz;
      verts[vi++] = Math.max(0, Math.min(1, rC));
      verts[vi++] = Math.max(0, Math.min(1, gC));
      verts[vi++] = Math.max(0, Math.min(1, bC));
      verts[vi++] = nx;
      verts[vi++] = ny;
      verts[vi++] = nz;
      verts[vi++] = i / segs;
      verts[vi++] = j / segs;
    }
  }

  // Grid indices (chunk vert offset = 0 since each chunk now has its
  // own private VBO, no need to baseIndex into a shared buffer).
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = (j + 1) * N + i;
      const d = c + 1;
      indices[ii++] = a;
      indices[ii++] = b;
      indices[ii++] = d;
      indices[ii++] = a;
      indices[ii++] = d;
      indices[ii++] = c;
    }
  }

  // Skirts (4 vertical strips). Same structure as the monolithic
  // build: top row reuses chunk edge verts by index; bottom row is
  // a new ring of verts at skirtY.
  const skirtBottomBase = N * N;
  const skirtR = 0.18, skirtG = 0.16, skirtB = 0.14;
  const writeSkirtBottom = (k, wx, wz) => {
    let px = wx, py = skirtY, pz = wz;
    if (planetProj) {
      const proj = _projectFlatToPlanet(wx, skirtY, wz, planetProj);
      px = proj[0]; py = proj[1]; pz = proj[2];
    }
    if (px < projMinX) projMinX = px;
    if (px > projMaxX) projMaxX = px;
    if (py < projMinY) projMinY = py;
    if (py > projMaxY) projMaxY = py;
    if (pz < projMinZ) projMinZ = pz;
    if (pz > projMaxZ) projMaxZ = pz;
    verts[vi++] = px;
    verts[vi++] = py;
    verts[vi++] = pz;
    verts[vi++] = skirtR;
    verts[vi++] = skirtG;
    verts[vi++] = skirtB;
    verts[vi++] = 0; verts[vi++] = -1; verts[vi++] = 0;
    verts[vi++] = k / segs;
    verts[vi++] = 1;
  };
  for (let k = 0; k < N; k++) writeSkirtBottom(k, originX + k * dStep, originZ);
  for (let k = 0; k < N; k++) writeSkirtBottom(k, originX + k * dStep, originZ + chunkSize);
  for (let k = 0; k < N; k++) writeSkirtBottom(k, originX, originZ + k * dStep);
  for (let k = 0; k < N; k++) writeSkirtBottom(k, originX + chunkSize, originZ + k * dStep);
  for (let edge = 0; edge < 4; edge++) {
    for (let k = 0; k < segs; k++) {
      let topA, topB;
      if (edge === 0)      { topA = 0       * N + k; topB = 0       * N + (k + 1); }
      else if (edge === 1) { topA = segs    * N + k; topB = segs    * N + (k + 1); }
      else if (edge === 2) { topA = k       * N + 0; topB = (k + 1) * N + 0; }
      else                 { topA = k       * N + segs; topB = (k + 1) * N + segs; }
      const botA = skirtBottomBase + edge * N + k;
      const botB = skirtBottomBase + edge * N + (k + 1);
      indices[ii++] = topA; indices[ii++] = botA; indices[ii++] = botB;
      indices[ii++] = topA; indices[ii++] = botB; indices[ii++] = topB;
    }
  }

  // Upload to GPU. Per-chunk VBO + IBO so each chunk can be destroyed
  // independently when it leaves the disc.
  if (!Visual.device) return null;
  const vertexBuffer = Visual.device.createBuffer({
    label: "tiled-vb-" + tileX + "-" + tileZ + "-" + segs,
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(verts);
  vertexBuffer.unmap();
  const indexBuffer = Visual.device.createBuffer({
    label: "tiled-ib-" + tileX + "-" + tileZ + "-" + segs,
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(indexBuffer.getMappedRange()).set(indices);
  indexBuffer.unmap();

  const aabbMin = planetProj
    ? new Float32Array([projMinX, projMinY, projMinZ])
    : new Float32Array([originX,             Math.min(chunkMinY, skirtY), originZ]);
  const aabbMax = planetProj
    ? new Float32Array([projMaxX, projMaxY, projMaxZ])
    : new Float32Array([originX + chunkSize, chunkMaxY,                    originZ + chunkSize]);
  return {
    vertexBuffer,
    indexBuffer,
    indexCount: ii,
    aabbMin,
    aabbMax,
    tileX,
    tileZ,
    lod: segs
  };
}

/* Main streaming entry. Drops chunks that left the disc, builds new
 * ones (within a per-frame time budget so tile-crossings don't
 * stall), returns the full live chunk list for the encoder. */
function _ensureTiledTerrainChunks(node) {
  if (!Visual.device) return null;
  if (!Visual.tiledChunkCache) Visual.tiledChunkCache = new Map();
  let entry = Visual.tiledChunkCache.get(node.id);
  if (!entry) {
    entry = { chunks: new Map(), globalKey: null };
    Visual.tiledChunkCache.set(node.id, entry);
  }

  // Global param change -> nuke every chunk (geometry is invalid).
  const globalKey = _tiledTerrainGlobalCacheKey(node);
  if (globalKey !== entry.globalKey) {
    for (const c of entry.chunks.values()) {
      try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
      try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
    }
    entry.chunks.clear();
    entry.globalKey = globalKey;
  }

  const visible = _computeVisibleChunkSet(node);

  // Drop chunks no longer in the visible set (camera moved away).
  const keysToDrop = [];
  for (const key of entry.chunks.keys()) {
    if (!visible.has(key)) keysToDrop.push(key);
  }
  for (const key of keysToDrop) {
    const c = entry.chunks.get(key);
    try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
    try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
    entry.chunks.delete(key);
  }

  // §5.5.e-13 -- two-phase streaming. Eliminates the "sinkhole" gap
  // by guaranteeing every visible tile has at least a placeholder
  // chunk (LOD 2 = ~21 verts, builds in <0.1ms) within the first
  // frame it appears. Phase 1 (placeholders) gets a small budget;
  // phase 2 (proper LOD) gets a larger budget for upgrades.
  //
  //   phase 1: for each visible tile WITHOUT any cached chunk, build
  //            an LOD-2 placeholder. Closest-first. Tight budget --
  //            placeholders are cheap so most fit in one frame.
  //   phase 2: for each visible tile WITH a chunk at the wrong LOD,
  //            rebuild at the desired LOD. Old chunk destroyed only
  //            after the new chunk is in hand -- no transient void.
  const center = _tiledTerrainCenterTile(node);
  const ringOf = (info) => Math.max(Math.abs(info.tileX - center.tx),
                                    Math.abs(info.tileZ - center.tz));
  // PHASE 1: placeholders for any tile that has nothing yet.
  const phPending = [];
  for (const [key, info] of visible) {
    if (entry.chunks.has(key)) continue;
    phPending.push({ key, info, ring: ringOf(info) });
  }
  phPending.sort((a, b) => a.ring - b.ring);
  const PH_BUDGET_MS = 8;
  const phStart = performance.now();
  let phBuilt = 0;
  for (let i = 0; i < phPending.length; i++) {
    const item = phPending[i];
    const ph = _buildSingleChunk(node, {
      tileX: item.info.tileX,
      tileZ: item.info.tileZ,
      segs: 2                            // minimum-LOD placeholder
    });
    if (ph) {
      ph.currentLod = 2;
      entry.chunks.set(item.key, ph);
    }
    phBuilt++;
    if (performance.now() - phStart > PH_BUDGET_MS) break;
  }
  // PHASE 2: upgrade existing chunks whose currentLod differs from
  // the desired LOD. Old chunk stays in the cache until the upgrade
  // is in hand, so the visible mesh never goes empty.
  const upPending = [];
  for (const [key, info] of visible) {
    const c = entry.chunks.get(key);
    if (!c) continue;
    if (c.currentLod === info.segs) continue;
    upPending.push({ key, info, c, ring: ringOf(info) });
  }
  upPending.sort((a, b) => a.ring - b.ring);
  const UP_BUDGET_MS = 12;
  const upStart = performance.now();
  let upBuilt = 0;
  for (let i = 0; i < upPending.length; i++) {
    const item = upPending[i];
    const proper = _buildSingleChunk(node, {
      tileX: item.info.tileX,
      tileZ: item.info.tileZ,
      segs: item.info.segs
    });
    if (proper) {
      try { item.c.vertexBuffer && item.c.vertexBuffer.destroy(); } catch (_) {}
      try { item.c.indexBuffer  && item.c.indexBuffer.destroy();  } catch (_) {}
      proper.currentLod = item.info.segs;
      entry.chunks.set(item.key, proper);
    }
    upBuilt++;
    if (performance.now() - upStart > UP_BUDGET_MS) break;
  }
  if ((phBuilt > 0 || upBuilt > 0) && !Visual._tiledStreamLogged) {
    Visual._tiledStreamLogged = true;
    console.log("[tiled] two-phase streaming active. Placeholder LOD-2 ensures no empty tile; upgrades happen under a separate budget.");
  }

  // Aggregate AABB for the mesh-level outer frustum cull.
  let aabbMin, aabbMax;
  if (entry.chunks.size === 0) {
    aabbMin = new Float32Array([0, 0, 0]);
    aabbMax = new Float32Array([0, 0, 0]);
  } else {
    aabbMin = new Float32Array([Infinity, Infinity, Infinity]);
    aabbMax = new Float32Array([-Infinity, -Infinity, -Infinity]);
    for (const c of entry.chunks.values()) {
      if (c.aabbMin[0] < aabbMin[0]) aabbMin[0] = c.aabbMin[0];
      if (c.aabbMin[1] < aabbMin[1]) aabbMin[1] = c.aabbMin[1];
      if (c.aabbMin[2] < aabbMin[2]) aabbMin[2] = c.aabbMin[2];
      if (c.aabbMax[0] > aabbMax[0]) aabbMax[0] = c.aabbMax[0];
      if (c.aabbMax[1] > aabbMax[1]) aabbMax[1] = c.aabbMax[1];
      if (c.aabbMax[2] > aabbMax[2]) aabbMax[2] = c.aabbMax[2];
    }
  }

  // Live chunk list (encoder iterates this for per-chunk draws).
  const allChunks = [];
  for (const c of entry.chunks.values()) allChunks.push(c);

  // Minimap metadata: chunk world bounds + LOD per loaded chunk.
  // Reuses `center` computed earlier for the build-order sort.
  const p = node.params || {};
  node._tiledMinimap = {
    centerTile: center,
    chunkSize: (typeof p.chunkSize === "number") ? p.chunkSize : 64,
    radius:    (typeof p.chunkRadius === "number") ? p.chunkRadius : 8,
    chunks: allChunks.map(function (c) {
      return {
        tileX: c.tileX, tileZ: c.tileZ, lod: c.lod,
        x0: c.aabbMin[0], z0: c.aabbMin[2],
        x1: c.aabbMax[0], z1: c.aabbMax[2]
      };
    })
  };

  return {
    tiledChunks: allChunks,
    vertexBuffer: null,         // dummy -- encoder branches on tiledChunks
    indexBuffer: null,
    vertexCount: 0,
    indexCount: 0,
    aabbMin,
    aabbMax,
    cacheKey: "tiled"
  };
}

/* Torus -- (majorSlices+1)*(minorSlices+1) verts. Standard parametric
 * formulation with major radius R + minor radius r. Normal = (cos(θ)*cos(φ),
 * sin(φ), sin(θ)*cos(φ)). */
function _buildTorus(node) {
  const p = node.params || {};
  const R = (typeof p.majorRadius === "number") ? p.majorRadius : 1.0;
  const r = (typeof p.minorRadius === "number") ? p.minorRadius : 0.3;
  const majS = Math.max(3, Math.min(128, Math.floor((typeof p.majorSlices === "number") ? p.majorSlices : 24)));
  const minS = Math.max(3, Math.min(64,  Math.floor((typeof p.minorSlices === "number") ? p.minorSlices : 12)));
  // UV: u along major angle (around the donut hole), v along
  // minor angle (around the tube cross-section). Seam at both
  // u=0/1 and v=0/1 handled by including j=majS + k=minS verts.
  const verts = new Float32Array((majS + 1) * (minS + 1) * 11);
  const indices = new Uint32Array(majS * minS * 6);
  let v = 0, i = 0;
  for (let j = 0; j <= majS; j++) {
    const u = j / majS;
    const theta = 2 * Math.PI * u;
    const cth = Math.cos(theta), sth = Math.sin(theta);
    for (let k = 0; k <= minS; k++) {
      const vv = k / minS;
      const phi = 2 * Math.PI * vv;
      const cphi = Math.cos(phi), sphi = Math.sin(phi);
      const nx = cth * cphi, ny = sphi, nz = sth * cphi;
      verts[v++] = (R + r * cphi) * cth;
      verts[v++] = r * sphi;
      verts[v++] = (R + r * cphi) * sth;
      verts[v++] = nx * 0.5 + 0.5;
      verts[v++] = ny * 0.5 + 0.5;
      verts[v++] = nz * 0.5 + 0.5;
      verts[v++] = nx; verts[v++] = ny; verts[v++] = nz;
      verts[v++] = u;  verts[v++] = vv;
    }
  }
  for (let j = 0; j < majS; j++) {
    for (let k = 0; k < minS; k++) {
      const a = j * (minS + 1) + k;
      const b = a + minS + 1;
      indices[i++] = a;     indices[i++] = b;     indices[i++] = a + 1;
      indices[i++] = a + 1; indices[i++] = b;     indices[i++] = b + 1;
    }
  }
  return { verts, indices };
}

/* Cylinder -- side strip + top cap + bottom cap. Centered at origin,
 * Y axis. Side normal = radial; cap normals = ±Y. */
function _buildCylinder(node) {
  const p = node.params || {};
  const r = (typeof p.radius === "number") ? p.radius : 0.5;
  const h = (typeof p.height === "number") ? p.height : 1.0;
  const slices = Math.max(3, Math.min(128, Math.floor((typeof p.slices === "number") ? p.slices : 24)));
  const hy = h * 0.5;
  // Side: 2*(slices+1) verts. Top cap: 1 center + (slices+1) rim. Bottom cap: same.
  // Each vertex: pos.xyz + color.rgb + normal.xyz + uv.xy = 11 floats.
  // Side UV: u = theta around (0..1, seamed at k=slices), v = 0 (bottom)..1 (top).
  // Cap UV: radial from center; center=(0.5, 0.5), rim=(cosθ/2+0.5, sinθ/2+0.5).
  const sideVerts = 2 * (slices + 1);
  const totalVerts = sideVerts + 2 * (1 + slices + 1);
  const verts = new Float32Array(totalVerts * 11);
  const sideIdx = slices * 6;
  const capIdx  = slices * 3;
  const indices = new Uint32Array(sideIdx + 2 * capIdx);
  let v = 0, i = 0;
  // Side strip -- normal is radial (cosθ, 0, sinθ).
  for (let k = 0; k <= slices; k++) {
    const u = k / slices;
    const theta = 2 * Math.PI * u;
    const cth = Math.cos(theta), sth = Math.sin(theta);
    // bottom rim
    verts[v++] = r * cth; verts[v++] = -hy; verts[v++] = r * sth;
    verts[v++] = cth * 0.5 + 0.5; verts[v++] = 0.5; verts[v++] = sth * 0.5 + 0.5;
    verts[v++] = cth; verts[v++] = 0; verts[v++] = sth;
    verts[v++] = u; verts[v++] = 0;
    // top rim
    verts[v++] = r * cth; verts[v++] =  hy; verts[v++] = r * sth;
    verts[v++] = cth * 0.5 + 0.5; verts[v++] = 0.8; verts[v++] = sth * 0.5 + 0.5;
    verts[v++] = cth; verts[v++] = 0; verts[v++] = sth;
    verts[v++] = u; verts[v++] = 1;
  }
  for (let k = 0; k < slices; k++) {
    const a = k * 2;
    indices[i++] = a;     indices[i++] = a + 1; indices[i++] = a + 2;
    indices[i++] = a + 2; indices[i++] = a + 1; indices[i++] = a + 3;
  }
  // Top cap (normal = +Y, radial UV)
  const topCenter = sideVerts;
  verts[v++] = 0; verts[v++] = hy; verts[v++] = 0;
  verts[v++] = 0.6; verts[v++] = 0.95; verts[v++] = 0.6;
  verts[v++] = 0; verts[v++] = 1; verts[v++] = 0;
  verts[v++] = 0.5; verts[v++] = 0.5;
  for (let k = 0; k <= slices; k++) {
    const theta = 2 * Math.PI * (k / slices);
    const cth = Math.cos(theta), sth = Math.sin(theta);
    verts[v++] = r * cth; verts[v++] = hy; verts[v++] = r * sth;
    verts[v++] = 0.65; verts[v++] = 0.95; verts[v++] = 0.65;
    verts[v++] = 0; verts[v++] = 1; verts[v++] = 0;
    verts[v++] = cth * 0.5 + 0.5; verts[v++] = sth * 0.5 + 0.5;
  }
  for (let k = 0; k < slices; k++) {
    indices[i++] = topCenter; indices[i++] = topCenter + 1 + k + 1; indices[i++] = topCenter + 1 + k;
  }
  // Bottom cap (normal = -Y, radial UV)
  const botCenter = topCenter + 1 + slices + 1;
  verts[v++] = 0; verts[v++] = -hy; verts[v++] = 0;
  verts[v++] = 0.4; verts[v++] = 0.4; verts[v++] = 0.6;
  verts[v++] = 0; verts[v++] = -1; verts[v++] = 0;
  verts[v++] = 0.5; verts[v++] = 0.5;
  for (let k = 0; k <= slices; k++) {
    const theta = 2 * Math.PI * (k / slices);
    const cth = Math.cos(theta), sth = Math.sin(theta);
    verts[v++] = r * cth; verts[v++] = -hy; verts[v++] = r * sth;
    verts[v++] = 0.42; verts[v++] = 0.42; verts[v++] = 0.65;
    verts[v++] = 0; verts[v++] = -1; verts[v++] = 0;
    verts[v++] = cth * 0.5 + 0.5; verts[v++] = sth * 0.5 + 0.5;
  }
  for (let k = 0; k < slices; k++) {
    indices[i++] = botCenter; indices[i++] = botCenter + 1 + k; indices[i++] = botCenter + 1 + k + 1;
  }
  return { verts, indices };
}

/* Cone -- side strip from apex to a circular base + one bottom cap.
 * Centered at origin; apex at +Y, base at -Y. */
function _buildCone(node) {
  const p = node.params || {};
  const r = (typeof p.radius === "number") ? p.radius : 0.5;
  const h = (typeof p.height === "number") ? p.height : 1.0;
  const slices = Math.max(3, Math.min(128, Math.floor((typeof p.slices === "number") ? p.slices : 24)));
  const hy = h * 0.5;
  // Side: `slices` apex copies (duplicated so each triangle's apex
  // vertex has a unique UV.x matching the slice center) + (slices+1)
  // rim. Base: 1 center + (slices+1) rim. Total: slices + (slices+1)
  // + 1 + (slices+1) = 3*slices + 3 verts.
  // Side normal tilted: pointing outward + slightly up (apex bias).
  // For a cone of radius r and height h, the slant makes side-normal
  // (cosθ * h, r, sinθ * h) normalized.
  // Side UV: u = theta/2π, v = 0 (apex) → 1 (base).
  // Base UV: radial (cap).
  const slantLen = Math.hypot(r, h);
  const ny_side  = r / slantLen;
  const horiz    = h / slantLen;
  const totalVerts = slices + (slices + 1) + 1 + (slices + 1);
  const verts = new Float32Array(totalVerts * 11);
  const indices = new Uint32Array(slices * 6);
  let v = 0, i = 0;
  // Apex copies -- one per triangle, each with UV.x = (k+0.5)/slices.
  // All share the same world position (0, hy, 0). Normal +Y as a
  // standard hack for the apex degenerate.
  for (let k = 0; k < slices; k++) {
    verts[v++] = 0; verts[v++] = hy; verts[v++] = 0;
    verts[v++] = 0.95; verts[v++] = 0.85; verts[v++] = 0.55;
    verts[v++] = 0; verts[v++] = 1; verts[v++] = 0;
    verts[v++] = (k + 0.5) / slices; verts[v++] = 0;
  }
  // Rim verts (slices+1 of them so the texture seam closes).
  const rimStart = slices;
  for (let k = 0; k <= slices; k++) {
    const u = k / slices;
    const theta = 2 * Math.PI * u;
    const cth = Math.cos(theta), sth = Math.sin(theta);
    verts[v++] = r * cth; verts[v++] = -hy; verts[v++] = r * sth;
    verts[v++] = cth * 0.45 + 0.5; verts[v++] = 0.5; verts[v++] = sth * 0.45 + 0.5;
    verts[v++] = horiz * cth; verts[v++] = ny_side; verts[v++] = horiz * sth;
    verts[v++] = u; verts[v++] = 1;
  }
  for (let k = 0; k < slices; k++) {
    // Triangle k: apex_k, rim_k, rim_{k+1}
    indices[i++] = k;
    indices[i++] = rimStart + k;
    indices[i++] = rimStart + k + 1;
  }
  // Bottom cap (normal = -Y, radial UV)
  const botCenter = rimStart + slices + 1;
  verts[v++] = 0; verts[v++] = -hy; verts[v++] = 0;
  verts[v++] = 0.3; verts[v++] = 0.3; verts[v++] = 0.5;
  verts[v++] = 0; verts[v++] = -1; verts[v++] = 0;
  verts[v++] = 0.5; verts[v++] = 0.5;
  for (let k = 0; k <= slices; k++) {
    const theta = 2 * Math.PI * (k / slices);
    const cth = Math.cos(theta), sth = Math.sin(theta);
    verts[v++] = r * cth; verts[v++] = -hy; verts[v++] = r * sth;
    verts[v++] = 0.35; verts[v++] = 0.35; verts[v++] = 0.55;
    verts[v++] = 0; verts[v++] = -1; verts[v++] = 0;
    verts[v++] = cth * 0.5 + 0.5; verts[v++] = sth * 0.5 + 0.5;
  }
  for (let k = 0; k < slices; k++) {
    indices[i++] = botCenter; indices[i++] = botCenter + 1 + k; indices[i++] = botCenter + 1 + k + 1;
  }
  return { verts, indices };
}

/* Acquire / build the per-Scene uniform buffers + bind group. Two
 * uniform buffers:
 *   perSceneBuffer (binding 0, 112 bytes) -- viewProj (64) +
 *     lightDir (16) + lightColor (16) + eye (16). Written once per
 *     Scene render before the draw loop.
 *   perDrawBuffer  (binding 1, 96 bytes) -- model (64) + baseColor
 *     (16) + matParams (16). Written before each mesh draw.
 * The bind group references both; the underlying buffer contents
 * change per call but the bind group itself stays constant. */
function _ensureSceneInstance(sceneNode) {
  let inst = Visual.sceneInstances.get(sceneNode.id);
  if (inst) return inst;
  if (!Visual.device) return null;
  // Sprint 7.5.3c bug fix -- build BGL on demand so instance
  // allocation works regardless of whether a pipeline has been
  // built yet. Was the v0.3.53 regression cause.
  if (!_ensureMeshBindGroupLayout()) return null;
  // perScene: viewProj (16) + eye (4) + lightCount (4) + lights[4]
  // (64) + envParams (4) + envSky (4) + envHorizon (4) + envGround
  // (4) + envSun (4) + camRight (4) + camUp (4) + camForward (4)
  // + envCloudParams (4) + envFogParams (4) + envFogColor (4)
  // = 132 floats = 528 bytes.
  // Sprint 7.5.3c push 3 grew this from 128 to 352 to hold up to 4
  // lights. Sprint 7.5.4 grew 352 -> 416 for environment data.
  // Sprint 7.5.4.c grew 416 -> 432 for the ProceduralSky sun vec4.
  // Sprint 7.5.4.c-sky grew 432 -> 480 for camera basis (sky pass).
  // Sprint 7.5.4.d/e grew 480 -> 528 for cloud + fog data.
  // Sprint 7.6.a-atm grew 528 -> 560 for envPlanet + envPlanetAtm
  // (Tier B planet-aware atmospheric scattering).
  // Sprint 7.6.b-atm grew 560 -> 576 for envPlanetGeom (oblate
  // spheroid polarRadiusRatio so atmosphere matches planet shape).
  // Sprint 8-4 grew 576 -> 992 for biomeParams (13 biomes x 2 vec4
  // each = 416 bytes, appended after envPlanetGeom). Lets the
  // PlanetMap editor tab tweak biome detail-noise params at runtime
  // without WGSL recompiles.
  // Sprint 9-3 grew 992 -> 1056 for proj (projection-only matrix,
  // 64 bytes appended at end). Read by vs_planet_cdlod which uses
  // the per-draw mv_rtc model matrix; other variants ignore it.
  const perSceneBuffer = Visual.device.createBuffer({
    label: "scene-perscene-" + sceneNode.id,
    size: 1056,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  // Sprint 7.5.3c bug fix -- queue.writeBuffer ordering. All
  // writeBuffer calls in a submit happen BEFORE any encoder command
  // executes; they don't interleave with draws. So a single per-draw
  // buffer overwritten between draws would mean every draw saw the
  // LAST write -- broken for multi-mesh scenes.
  // Fix: one per-draw buffer + one bind group per Scene mesh slot
  // (4 total). Each slot's buffer holds its own model + material.
  // Cheap (96 bytes per slot) and the bind groups are stable across
  // frames (the underlying buffer object stays the same; only its
  // contents change per frame).
  // v0.3.120 -- TWO bind groups per slot, one per scratch-parity, so
  // a Scene rendered into a composition chain (Scene → CRT → VO)
  // doesn't alias its render target with binding 2's read-only
  // scratch view. The plan walker assigns Scene at depth=1 with
  // writeKey="a" + readKey="b": Scene writes to scratchA, so its
  // bind group must NOT bind scratchA at binding 2 (WebGPU rejects
  // same-texture-as-attachment-and-binding in one pass, silently
  // failing the encode and leaving the downstream composition input
  // empty -- the original Scene→CRT bug). Selecting by readKey
  // mirrors the composition-shader convention: bind group reads the
  // OPPOSITE parity of what the pass writes.
  //
  // For direct-VO Scene (depth=0, readKey="a"), upstream ShaderMat
  // texture inputs land in scratchA (depth=1 writeKey="a") so
  // binding scratchArrayViewA is correct. For composition-chain
  // Scene (depth=1, readKey="b"), upstream textures would be at
  // depth=2 in scratchB, so scratchArrayViewB matches.
  if (!Visual.meshSampler) {
    Visual.meshSampler = Visual.device.createSampler({
      label: "mesh-shadermat-sampler",
      magFilter: "linear", minFilter: "linear",
      addressModeU: "repeat", addressModeV: "repeat"
    });
  }
  // Phase 4b -- slot allocation extracted into a closure so we can
  // grow the slot array on demand (e.g. a chunked Level2D with 32
  // tilemap chunks needs more than the original 4-slot cap). The
  // closure captures perSceneBuffer + sceneNode.id; Visual.* views
  // are re-resolved per call so newly-allocated slots reference the
  // current atm/svt/scratch views.
  _ensureEnvTextureDefault();
  _ensureAtmosphereLUTs();
  if (!_SVT.atlasView && Visual.device) _ensureSVT();
  _ensureSVTDefaultPageTable();
  const _allocSceneSlot = (slotIdx) => {
    const perDrawBuffer = Visual.device.createBuffer({
      label: "scene-perdraw-" + sceneNode.id + "-slot" + slotIdx,
      // v0.3.123 -- grown 96 → 160 for TerrainMaterial bands.
      // v0.3.126 §5.5.c-3 -- grown 160 → 192 for vsParams.
      // v0.3.129 TerrainMaterial v2 -- grown 192 → 224 for
      // detailParams + bumpParams (AAA-style multi-scale detail
      // noise + slope-masked snow + procedural bump mapping).
      // v0.3.171 §5.5.h-21 -- grown 240 → 256 for cloudExtra (sun-
      // projected cloud-shadow params on water).
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const transmittanceView = Visual.atmTransmittanceLUTView || Visual.atmLut1x1DefaultView;
    const multiScatterView  = Visual.atmMultiScatterLUTView  || Visual.atmLut1x1DefaultView;
    const skyViewView       = Visual.atmSkyViewLUTView       || Visual.atmLut1x1DefaultView;
    const svtAtlasView    = _SVT.atlasView       || Visual.envTextureView;
    const svtAtlasSampler = _SVT.atlasSampler    || Visual.envSampler;
    const svtPageTableV   = _SVT.pageTableView   || Visual.svtPageTableDefaultView;
    const svtNormalView   = _SVT.normalAtlasView   || Visual.envTextureView;
    const svtMaterialView = _SVT.materialAtlasView || Visual.envTextureView;
    const svtFinePageV    = _SVT.finePageTableView || Visual.svtPageTableDefaultView;
    _ensureMatDefaultTextures();
    const matW = Visual.matWhiteTexView, matN = Visual.matNormalTexView;
    // A.4 -- per-material map views (default to 1×1 no-op textures).
    const makeBindGroup = (scratchView, parity, mat) =>
      Visual.device.createBindGroup({
        label: "scene-bg-" + sceneNode.id + "-slot" + slotIdx + "-" + parity,
        layout: Visual.meshBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: perSceneBuffer } },
          { binding: 1, resource: { buffer: perDrawBuffer  } },
          { binding: 2, resource: scratchView },
          { binding: 3, resource: Visual.meshSampler },
          { binding: 4, resource: Visual.envTextureView },
          { binding: 5, resource: Visual.envSampler },
          { binding: 6, resource: transmittanceView },
          { binding: 7, resource: multiScatterView },
          { binding: 8, resource: Visual.atmLutSampler || Visual.envSampler },
          { binding: 9, resource: skyViewView },
          { binding: 10, resource: svtAtlasView },
          { binding: 11, resource: svtAtlasSampler },
          { binding: 12, resource: svtPageTableV },
          { binding: 13, resource: svtNormalView },
          { binding: 14, resource: svtMaterialView },
          { binding: 15, resource: svtFinePageV },
          { binding: 16, resource: (mat && mat.albedo) || matW },
          { binding: 17, resource: (mat && mat.normal) || matN },
          { binding: 18, resource: (mat && mat.rough)  || matW },
          { binding: 19, resource: (mat && mat.metal)  || matW }
        ]
      });
    const slot = { perDrawBuffer, _matKey: "" };
    // Rebuild both parity bind groups with a material's resolved map
    // views (or defaults). Called from the draw loop when a slot's
    // PhysicalMat textures finish streaming / change.
    slot.setMaterialTextures = (mat) => {
      slot.bindGroupA = makeBindGroup(Visual.scratchArrayViewA, "a", mat);
      slot.bindGroupB = makeBindGroup(Visual.scratchArrayViewB, "b", mat);
      slot.bindGroup  = slot.bindGroupA;
    };
    slot.setMaterialTextures(null);
    return slot;
  };
  const SLOT_COUNT_INITIAL = 4;
  const slots = [];
  for (let i = 0; i < SLOT_COUNT_INITIAL; i++) slots.push(_allocSceneSlot(i));
  inst = {
    perSceneBuffer,
    slots,
    _allocSlot: _allocSceneSlot,   // grow on demand from _encodeScenePass
    sceneScratch: new Float32Array(264),  // 1056 bytes (sprint 9-3 -- + proj matrix at end)
    // v0.3.123 -- 40 floats / 160 B for TerrainMaterial band slots.
    // v0.3.126 §5.5.c-3 -- bumped 40 → 48 / 192 B; slots [40..43]
    // are vsParams (vertex-shader displacement params for
    // ProceduralTerrain → Terrain.heightmap).
    // v0.3.129 -- 56 floats / 224 B. Slots [48..55] hold the
    // TerrainMaterial v2 detail + bump param blocks for AAA-
    // style multi-scale noise / procedural bump / snow masking.
    drawScratch:  new Float32Array(64)
  };
  Visual.sceneInstances.set(sceneNode.id, inst);
  return inst;
}

/* Encode a single Scene render pass. Color attachment is the
 * Scene's assigned framebuffer / scratch layer; depth attachment
 * is the shared Visual.depthTextureView. Iterates each wired mesh
 * input, writes the viewProj + model uniform, and issues one draw
 * per mesh. */
function _encodeScenePass(enc, entry) {
  const { node, layerIdx, isScratch, writeKey } = entry;
  let layerView;
  if (isScratch) {
    const views = (writeKey === "a") ? Visual.scratchLayerViewsA : Visual.scratchLayerViewsB;
    layerView = views[layerIdx];
  } else {
    layerView = Visual.framebufferLayerViews[layerIdx];
  }
  if (!layerView) {
    if (!_SCENE_DIAG.bail_layer) {
      _SCENE_DIAG.bail_layer = true;
      console.warn("[scene] bail: no layerView for layerIdx=" + layerIdx + " isScratch=" + isScratch);
    }
    return false;
  }
  const sampleCount = Visual.msaaSampleCount || 1;
  const inst = _ensureSceneInstance(node);
  if (!inst) {
    if (!_SCENE_DIAG.bail_inst) {
      _SCENE_DIAG.bail_inst = true;
      console.warn("[scene] bail: _ensureSceneInstance returned null; Visual.device=" + !!Visual.device +
                   " bgl=" + !!Visual.meshBindGroupLayout);
    }
    return false;
  }
  if (!Visual.depthTextureView) {
    if (!_SCENE_DIAG.bail_depth) {
      _SCENE_DIAG.bail_depth = true;
      console.warn("[scene] bail: no depthTextureView; fbW=" + Visual.fbWidth + " fbH=" + Visual.fbHeight);
    }
    return false;
  }
  if (sampleCount > 1 && !Visual.msaaColorTextureView) {
    if (!_SCENE_DIAG.bail_msaa) {
      _SCENE_DIAG.bail_msaa = true;
      console.warn("[scene] bail: msaa sampleCount=" + sampleCount + " but no msaaColorTextureView");
    }
    return false;
  }

  const p = node.params || {};
  const clearR = (typeof p.clearR === "number") ? p.clearR : 0.04;
  const clearG = (typeof p.clearG === "number") ? p.clearG : 0.05;
  const clearB = (typeof p.clearB === "number") ? p.clearB : 0.09;

  const camera = _resolveSceneCamera(node, Visual.fbWidth, Visual.fbHeight);
  const meshes = _resolveSceneMeshes(node);
  const lights = _resolveSceneLights(node);
  if (!_SCENE_DIAG.encode) {
    _SCENE_DIAG.encode = true;
    console.log("[scene] first encode: node=" + node.id +
                " layer=" + layerIdx + (isScratch ? " (scratch)" : " (display)") +
                " sampleCount=" + sampleCount + "x" +
                " meshes=" + meshes.length +
                " eye=(" + camera.eye.map(v => v.toFixed(2)).join(",") + ")");
    if (meshes.length === 0) {
      console.warn("[scene] node " + node.id + " has no wired mesh inputs -- " +
                   "the Scene will only show the clear color. Wire a DebugTriangle " +
                   "(or any mesh-gen node) into mesh1/mesh2/mesh3/mesh4.");
    }
  }

  // MSAA path: render into the MSAA color texture + use the
  // framebuffer layer as resolveTarget so WebGPU does the down-
  // sample at end-of-pass. storeOp "discard" because we only need
  // the resolved output -- saves bandwidth.
  // Single-sample path: render directly into the framebuffer layer.
  const colorAttachment = (sampleCount > 1)
    ? {
        view: Visual.msaaColorTextureView,
        resolveTarget: layerView,
        clearValue: { r: clearR, g: clearG, b: clearB, a: 1.0 },
        loadOp: "clear",
        storeOp: "discard"
      }
    : {
        view: layerView,
        clearValue: { r: clearR, g: clearG, b: clearB, a: 1.0 },
        loadOp: "clear",
        storeOp: "store"
      };
  const pass = enc.beginRenderPass({
    label: "scene-pass-" + node.id + "-" + sampleCount + "x",
    colorAttachments: [colorAttachment],
    depthStencilAttachment: {
      view: Visual.depthTextureView,
      depthLoadOp: "clear",
      // §planet-spec Phase 1 -- reverse-Z. Clear to 0.0 (far plane);
      // mesh fragments at ndc_z>0 then pass depthCompare:"greater".
      depthClearValue: 0.0,
      depthStoreOp: (sampleCount > 1) ? "discard" : "store"
    }
  });
  // Per-Scene uniform layout (sprint 7.5.4.c-sky, 120 floats / 480 bytes):
  //   [ 0..15]   viewProj (mat4)
  //   [16..19]   eye         (vec4: xyz = camera world pos, w = unused)
  //   [20..23]   lightCount  (vec4: x = N in [1..4])
  //   [24..39]   light 0 (4 vec4: pos / color / params / spotDir)
  //   [40..55]   light 1
  //   [56..71]   light 2
  //   [72..87]   light 3
  //   [88..91]   envParams   (vec4: x = mode 0/1/2, y = intensity,
  //                          z = turbidity, w = mieG)
  //   [92..95]   envSky      (vec4: rgb = sky/top color)
  //   [96..99]   envHorizon  (vec4: rgb = horizon color)
  //   [100..103] envGround   (vec4: rgb = ground/bottom color)
  //   [104..107] envSun      (vec4: xyz = dir TO sun, w = visibility)
  //   [108..111] camRight    (vec4: xyz = world right, w = tanHFov*aspect)
  //   [112..115] camUp       (vec4: xyz = world up,    w = tanHFov)
  //   [116..119] camForward  (vec4: xyz = world fwd,   w = 0persp/1ortho)
  //   [120..123] envCloudParams (vec4: x=coverage, y=density, z/w=wind)
  //   [124..127] envFogParams   (vec4: x=density, y=start, z=hFalloff, w=autoEnv)
  //   [128..131] envFogColor    (vec4: rgb=color)
  inst.sceneScratch.set(camera.viewProj, 0);
  inst.sceneScratch[16] = camera.eye[0];
  inst.sceneScratch[17] = camera.eye[1];
  inst.sceneScratch[18] = camera.eye[2];
  inst.sceneScratch[19] = 0;
  const usedLights = Math.min(4, lights.length || 1);
  inst.sceneScratch[20] = usedLights;
  inst.sceneScratch[21] = 0; inst.sceneScratch[22] = 0; inst.sceneScratch[23] = 0;
  for (let i = 0; i < 4; i++) {
    const L = (i < usedLights && lights[i]) ? lights[i] : null;
    const base = 24 + i * 16;
    if (L) {
      inst.sceneScratch[base + 0]  = L.pos[0];
      inst.sceneScratch[base + 1]  = L.pos[1];
      inst.sceneScratch[base + 2]  = L.pos[2];
      inst.sceneScratch[base + 3]  = L.type;            // 0=dir, 1=point, 2=spot
      inst.sceneScratch[base + 4]  = L.color[0];
      inst.sceneScratch[base + 5]  = L.color[1];
      inst.sceneScratch[base + 6]  = L.color[2];
      inst.sceneScratch[base + 7]  = L.intensity;
      inst.sceneScratch[base + 8]  = L.range || 0;      // params.x
      inst.sceneScratch[base + 9]  = L.cosInner || 1;   // params.y
      inst.sceneScratch[base + 10] = L.cosOuter || 1;   // params.z
      inst.sceneScratch[base + 11] = 0;                 // params.w reserved
      inst.sceneScratch[base + 12] = L.spotDir[0];
      inst.sceneScratch[base + 13] = L.spotDir[1];
      inst.sceneScratch[base + 14] = L.spotDir[2];
      inst.sceneScratch[base + 15] = 0;
    } else {
      // Zero out unused light slots so old data doesn't bleed in.
      for (let k = 0; k < 16; k++) inst.sceneScratch[base + k] = 0;
    }
  }
  // Sprint 7.5.4 -- environment. Pull from the wired environment
  // input (if any) and pack into the env vec4s. mode=0 means
  // unwired -> shader falls back to the hardcoded hemisphere-IBL.
  // Sprint 7.5.4.c -- mode 2 (ProceduralSky) also writes envSun.
  const env = _resolveSceneEnvironment(node);
  if (env) {
    inst.sceneScratch[88]  = env.mode;
    inst.sceneScratch[89]  = (typeof env.intensity === "number") ? env.intensity : 1.0;
    inst.sceneScratch[90]  = (typeof env.turbidity === "number") ? env.turbidity : 1.0;
    inst.sceneScratch[91]  = (typeof env.mieG      === "number") ? env.mieG      : 0.76;
    const sky     = env.sky     || [0, 0, 0];
    const horizon = env.horizon || [0, 0, 0];
    const ground  = env.ground  || [0, 0, 0];
    const sun     = env.sun     || [0, 1, 0, 0];
    // 7.5.4.c-polish -- sky.w carries moonPhase for ProceduralSky.
    // GradientSky doesn't use it; falls through to 0.
    inst.sceneScratch[92]  = sky[0];     inst.sceneScratch[93]  = sky[1];     inst.sceneScratch[94]  = sky[2];     inst.sceneScratch[95]  = (typeof sky[3] === "number") ? sky[3] : 0;
    inst.sceneScratch[96]  = horizon[0]; inst.sceneScratch[97]  = horizon[1]; inst.sceneScratch[98]  = horizon[2]; inst.sceneScratch[99]  = 0;
    inst.sceneScratch[100] = ground[0];  inst.sceneScratch[101] = ground[1];  inst.sceneScratch[102] = ground[2];  inst.sceneScratch[103] = 0;
    inst.sceneScratch[104] = sun[0];     inst.sceneScratch[105] = sun[1];     inst.sceneScratch[106] = sun[2];     inst.sceneScratch[107] = sun[3];
  } else {
    // Zero out env slots when nothing is wired (mode=0 = fallback).
    for (let k = 88; k < 108; k++) inst.sceneScratch[k] = 0;
  }
  // Sprint 7.5.4.c-sky -- camera basis vectors for the background
  // sky pass. Always written (even when no env wired) so the data
  // is fresh; the sky pass is only dispatched conditionally below.
  const cR = camera.camRight   || [1, 0, 0, 1];
  const cU = camera.camUp      || [0, 1, 0, 1];
  const cF = camera.camForward || [0, 0, -1, 0];
  inst.sceneScratch[108] = cR[0]; inst.sceneScratch[109] = cR[1]; inst.sceneScratch[110] = cR[2]; inst.sceneScratch[111] = cR[3];
  inst.sceneScratch[112] = cU[0]; inst.sceneScratch[113] = cU[1]; inst.sceneScratch[114] = cU[2]; inst.sceneScratch[115] = cU[3];
  inst.sceneScratch[116] = cF[0]; inst.sceneScratch[117] = cF[1]; inst.sceneScratch[118] = cF[2]; inst.sceneScratch[119] = cF[3];
  // Sprint 7.5.4.d -- cloud params (from env source, typically ProceduralSky).
  // §5.5.h-11 -- subtract camera.xz from the wind offset so the cloud
  // noise sample stays world-anchored as the camera moves. Without
  // this, the cloud shader's `pos = dir * t` puts every cloud at a
  // fixed direction from the camera, making them drag along with
  // motion. The shader does `pos.xz - wind`, so pre-subtracting
  // camera position from wind effectively adds camera position to pos.
  const cl = (env && env.cloud) || [0, 0, 0, 0];
  const camX = (camera && camera.eye) ? camera.eye[0] : 0;
  const camZ = (camera && camera.eye) ? camera.eye[2] : 0;
  inst.sceneScratch[120] = cl[0]; inst.sceneScratch[121] = cl[1];
  inst.sceneScratch[122] = cl[2] - camX;
  inst.sceneScratch[123] = cl[3] - camZ;
  // Sprint 7.5.4.e -- fog params (from Scene node's fog* params).
  const sp = _resolveNodeParams(node);
  const fogDensity = (typeof sp.fogDensity === "number") ? sp.fogDensity : 0;
  const fogStart   = (typeof sp.fogStart   === "number") ? sp.fogStart   : 5;
  const fogHeight  = (typeof sp.fogHeight  === "number") ? sp.fogHeight  : 0;
  const fogAuto    = (typeof sp.fogAuto    === "number") ? sp.fogAuto    : 1;
  const fogR       = (typeof sp.fogR       === "number") ? sp.fogR       : 0.65;
  const fogG       = (typeof sp.fogG       === "number") ? sp.fogG       : 0.70;
  const fogB       = (typeof sp.fogB       === "number") ? sp.fogB       : 0.78;
  inst.sceneScratch[124] = fogDensity;
  inst.sceneScratch[125] = fogStart;
  inst.sceneScratch[126] = fogHeight;
  inst.sceneScratch[127] = fogAuto;
  inst.sceneScratch[128] = fogR; inst.sceneScratch[129] = fogG; inst.sceneScratch[130] = fogB; inst.sceneScratch[131] = 0;

  // Sprint 7.6.a-atm -- envPlanet + envPlanetAtm. Re-uses the same
  // _findPlanetInfo() helper that powers the HUD altimeter, so the
  // shader's idea of the planet's location matches the altimeter's
  // and the actual rendered mesh exactly. Foot-to-Orbit positions
  // the planet so its north pole sits at world Y=0 -- center is at
  // (0, -PLANET_R * polRatio, 0) -- and _findPlanetInfo picks up
  // those node-params (centerX/Y/Z) correctly.
  //
  // 2026-05-21 history:
  //   * Pass 1 hardcoded center to (0,0,0); 200km-altitude testing
  //     in Foot-to-Orbit produced wrong atmosphere because the
  //     shader was using a phantom planet 6371km off from the real.
  //   * Pass 2 read centerX/Y/Z from `meshes`, but `meshes` is the
  //     render-pipeline mesh list (vertex+index buffer pairs), and
  //     PlanetMesh's procedural-surface entry may not be in that
  //     list at all render passes. Result: stars still didn't show
  //     because envPlanet.w stayed 0 -> shader fell back to flat-
  //     ground path -> features used eye.y altitude (-6,376,329 in
  //     Foot-to-Orbit) -> altFade = 0 -> no stars.
  //   * Pass 3 (now): use _findPlanetInfo which walks state.nodes
  //     directly and finds the planet node by .type regardless of
  //     render-pipeline state.
  //
  // Atmosphere parameters are Earth-relative so the sky reads
  // physically-right at any world-unit scale.
  const planetInfo = (typeof _findPlanetInfo === "function") ? _findPlanetInfo() : null;
  if (planetInfo && planetInfo.radius > 0) {
    const planetR = planetInfo.radius;
    const atmTop  = planetR * 1.0157;             // 100km on Earth-scale (Karman line)
    const scaleHR = planetR * 0.001334;           // 8500m on Earth-scale
    const scaleHM = planetR * 0.000188;           // 1200m on Earth-scale
    const sunI    = 22.0;
    const polRatio = (typeof planetInfo.polRatio === "number" && planetInfo.polRatio > 0)
      ? planetInfo.polRatio : 1.0;
    // 2026-05-21 diagnostic: log ONCE so we can confirm the center the
    // atmosphere shader is given matches the actual rendered planet
    // mesh's vertex-space center. If they disagree, atmosphere appears
    // offset from planet silhouette (the symptom in 21-16/17 screenshots).
    if (!Visual._planetCenterDiagnosticLogged) {
      Visual._planetCenterDiagnosticLogged = true;
      const planetNodes = (state && state.nodes || []).filter(n =>
        n && (n.type === "PlanetMesh" || n.type === "Planet")
      );
      console.log("[atm-diagnostic] _findPlanetInfo returned center=("
        + planetInfo.centerX + ", " + planetInfo.centerY + ", " + planetInfo.centerZ
        + ") radius=" + planetR + " polRatio=" + polRatio
        + " sceneNodeCount=" + planetNodes.length);
      for (const n of planetNodes) {
        const np = n.params || {};
        console.log("[atm-diagnostic]   node id=" + n.id + " type=" + n.type
          + " center=(" + (np.centerX||0) + ", " + (np.centerY||0) + ", " + (np.centerZ||0) + ")"
          + " radius=" + (np.radius||0)
          + " polarRadiusRatio=" + (np.polarRadiusRatio||1));
      }
      console.log("[atm-diagnostic] camera eye=("
        + camera.eye[0] + ", " + camera.eye[1] + ", " + camera.eye[2] + ")"
        + " camForward=(" + camera.camForward[0].toFixed(4) + ", "
        + camera.camForward[1].toFixed(4) + ", " + camera.camForward[2].toFixed(4) + ")"
        + " camRight.w=" + camera.camRight[3].toFixed(4)
        + " camUp.w=" + camera.camUp[3].toFixed(4));
      // Project planet center through viewProj to see its expected
      // screen position. If this lands in the planet body's pixels,
      // envPlanet IS at the right place and the bug is shader-side.
      const cx = planetInfo.centerX, cy = planetInfo.centerY, cz = planetInfo.centerZ;
      const vp = camera.viewProj;
      const clipX = vp[0]*cx + vp[4]*cy + vp[8]*cz  + vp[12];
      const clipY = vp[1]*cx + vp[5]*cy + vp[9]*cz  + vp[13];
      const clipZ = vp[2]*cx + vp[6]*cy + vp[10]*cz + vp[14];
      const clipW = vp[3]*cx + vp[7]*cy + vp[11]*cz + vp[15];
      console.log("[atm-diagnostic] planet center projected: clip=("
        + clipX.toFixed(2) + "," + clipY.toFixed(2) + "," + clipZ.toFixed(2) + "," + clipW.toFixed(2)
        + ") ndc=(" + (clipX/clipW).toFixed(3) + "," + (clipY/clipW).toFixed(3) + "," + (clipZ/clipW).toFixed(3) + ")");
    }
    inst.sceneScratch[132] = planetInfo.centerX;
    inst.sceneScratch[133] = planetInfo.centerY;
    inst.sceneScratch[134] = planetInfo.centerZ;
    inst.sceneScratch[135] = planetR;
    inst.sceneScratch[136] = atmTop;
    inst.sceneScratch[137] = scaleHR;
    inst.sceneScratch[138] = scaleHM;
    inst.sceneScratch[139] = sunI;
    inst.sceneScratch[140] = polRatio;
    // Sprint 10-6 v7: terrain height at the camera's lat/lon (meters
    // above planet radius). Sent every frame so the aerial-perspective
    // shader can convert MSL → AGL when looking up the LUT. The LUT
    // is MSL-referenced (densest at sea level), so when camera is over
    // ocean (terrain=0) it works correctly; but over a 5km mountain
    // it treats the camera as if it were in a thick column of 5km
    // of sea-level air, washing out nearby terrain. AGL shifts the
    // reference to local ground so the atmosphere "sits on" the
    // terrain instead of bleeding through it.
    let _terrainAtCamM = 0;
    if (typeof _planetMeshSurfacePos === "function") {
      const _surf = _planetMeshSurfacePos(camera.eye[0], camera.eye[1], camera.eye[2], planetInfo);
      if (_surf) {
        const _sdx = _surf.x - planetInfo.centerX;
        const _sdy = _surf.y - planetInfo.centerY;
        const _sdz = _surf.z - planetInfo.centerZ;
        _terrainAtCamM = Math.max(0, Math.hypot(_sdx, _sdy, _sdz) - planetR);
      }
    }
    inst.sceneScratch[141] = _terrainAtCamM;
    inst.sceneScratch[142] = 0;
    inst.sceneScratch[143] = 0;
  } else {
    inst.sceneScratch[132] = 0; inst.sceneScratch[133] = 0;
    inst.sceneScratch[134] = 0; inst.sceneScratch[135] = 0;
    inst.sceneScratch[136] = 0; inst.sceneScratch[137] = 0;
    inst.sceneScratch[138] = 0; inst.sceneScratch[139] = 0;
    inst.sceneScratch[140] = 1.0;  // polRatio default = 1 (sphere)
    inst.sceneScratch[141] = 0; inst.sceneScratch[142] = 0; inst.sceneScratch[143] = 0;
  }

  // Sprint 8-4 -- biome detail-noise params at scratch slots [144..247]
  // (= bytes 576..991 = uS.biomeParams[26]). 13 biomes x 8 floats each:
  //   [amp, freq, roughness, lacunarity, shape, warpStrength, warpFreq, textureStyleId]
  // Defaults mirror what the previous WGSL const held; PlanetMap's
  // node.params.biomes overrides each row when the user edits.
  const biomeParamsBase = 144;
  for (let bk = 0; bk < 13; bk++) {
    const def = PLANET_BIOME_DETAIL_DEFAULTS[bk];
    const ov  = (planetInfo && planetInfo.mapNode && planetInfo.mapNode.params &&
                 Array.isArray(planetInfo.mapNode.params.biomes) &&
                 planetInfo.mapNode.params.biomes[bk]) || null;
    const off = biomeParamsBase + bk * 8;
    inst.sceneScratch[off + 0] = (ov && typeof ov.amp === "number") ? ov.amp : def[0];
    inst.sceneScratch[off + 1] = (ov && typeof ov.freq === "number") ? ov.freq : def[1];
    inst.sceneScratch[off + 2] = (ov && typeof ov.roughness === "number") ? ov.roughness : def[2];
    inst.sceneScratch[off + 3] = (ov && typeof ov.lacunarity === "number") ? ov.lacunarity : def[3];
    inst.sceneScratch[off + 4] = (ov && typeof ov.shape === "number") ? ov.shape : def[4];
    inst.sceneScratch[off + 5] = (ov && typeof ov.warpStrength === "number") ? ov.warpStrength : def[5];
    inst.sceneScratch[off + 6] = (ov && typeof ov.warpFreq === "number") ? ov.warpFreq : def[6];
    inst.sceneScratch[off + 7] = (ov && typeof ov.textureStyleId === "number") ? ov.textureStyleId : def[7];
  }

  // Sprint 9-3: write proj at the trailing slot (float index 248,
  // byte offset 992). Read by vs_planet_cdlod; other shaders ignore.
  inst.sceneScratch.set(camera.proj, 248);
  Visual.device.queue.writeBuffer(inst.perSceneBuffer, 0, inst.sceneScratch.buffer, 0, 1056);

  // Per-draw loop. Each mesh writes to its OWN per-slot buffer +
  // binds its OWN bind group, so multi-mesh draws work correctly
  // (queue.writeBuffer ordering doesn't interleave with draws).
  //
  // Sprint 5.10 -- frustum culling. Scene.cullEnable (default 1)
  // gates the test. Per mesh: transform local AABB through model
  // matrix, run 6-plane SAT against camera.frustumPlanes. Outside
  // the frustum -> skip draw entirely.
  const sParams = _resolveNodeParams(node);
  const cullEnable = (typeof sParams.cullEnable === "number")
    ? sParams.cullEnable >= 0.5 : true;
  let culledCount = 0;
  const _aabbMinScratch = new Float32Array(3);
  const _aabbMaxScratch = new Float32Array(3);
  let curMaterialType = null;
  // Phase 4b -- grow per-draw slots if the mesh list exceeds the
  // initial 4-slot allocation. Each Level2D tilemap chunk needs its
  // own slot; without growth the encoder would silently drop chunks
  // past slot[3], leaving a 4-chunk visible square in a larger map.
  if (meshes.length > inst.slots.length && typeof inst._allocSlot === "function") {
    const oldCount = inst.slots.length;
    while (inst.slots.length < meshes.length) {
      inst.slots.push(inst._allocSlot(inst.slots.length));
    }
    if (!Visual._slotGrowLogged || Visual._slotGrowLogged < inst.slots.length) {
      Visual._slotGrowLogged = inst.slots.length;
      console.log("[scene] grew per-draw slots: " + node.id + " " + oldCount + " -> " + inst.slots.length +
        " (meshes=" + meshes.length + ")");
    }
  }
  for (let i = 0; i < meshes.length && i < inst.slots.length; i++) {
    const m = meshes[i];
    const slot = inst.slots[i];
    // Sprint 8-7c -- LOD gate for the synthesized planet detail
    // patch. Skip the draw entirely when the camera is above the
    // patch's maxAltitude; the patch's altitude-fade in the vertex
    // shader was previously rendering it as a gray scaled square
    // instead of becoming invisible.
    if (m.isPlanetDetailPatch) {
      const pp = (m.node && m.node.params) || {};
      const maxAlt = (typeof pp.detailPatchMaxAlt === "number") ? pp.detailPatchMaxAlt : 5000;
      const cx = inst.sceneScratch[132];
      const cy = inst.sceneScratch[133];
      const cz = inst.sceneScratch[134];
      const pR = inst.sceneScratch[135];
      if (pR > 0) {
        const dx = camera.eye[0] - cx;
        const dy = camera.eye[1] - cy;
        const dz = camera.eye[2] - cz;
        const camDist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        const camAlt  = Math.max(0, camDist - pR);
        if (camAlt > maxAlt) continue;
      }
    }
    const buf = _ensureMeshBuffers(m);
    // §5.5.e-6 -- TiledTerrain returns buf.tiledChunks (per-chunk
    // VBOs) instead of a single buf.vertexBuffer. Both shapes are
    // valid; skip only if neither is present.
    if (!buf) {
      if (m.node && m.node.type === "Water" && !Visual._waterSkipBufLogged) {
        Visual._waterSkipBufLogged = true;
        console.error("[water] SKIPPED: _ensureMeshBuffers returned null. Mesh build failed?");
      }
      continue;
    }
    if (!buf.vertexBuffer && !(buf.tiledChunks && buf.tiledChunks.length)) {
      if (m.node && m.node.type === "Water" && !Visual._waterSkipVbLogged) {
        Visual._waterSkipVbLogged = true;
        console.error("[water] SKIPPED: no vertexBuffer + no tiledChunks. buf=", buf);
      }
      continue;
    }
    // 5.10 -- frustum cull. Skip mesh draws entirely outside the
    // camera frustum. Tested in world space via 8-corner-transform
    // of the cached local AABB. Diagnostic count logged once per
    // frame so users can see culling actually firing.
    if (cullEnable && camera.frustumPlanes && buf.aabbMin && buf.aabbMax) {
      _transformAABB(buf.aabbMin, buf.aabbMax, m.transform,
                     _aabbMinScratch, _aabbMaxScratch);
      if (!_aabbInsideFrustum(camera.frustumPlanes, _aabbMinScratch, _aabbMaxScratch)) {
        culledCount++;
        continue;
      }
    }
    // Sprint plat-2a-render -- textured-sprite dispatch. Sprites with
    // a wired (and loaded) ImageURL on their `texture` input render
    // through the dedicated sprite pipeline (3-binding BGL: drawU,
    // texture, sampler). After the draw, curMaterialType is cleared
    // so the next mesh in the loop re-sets its own pipeline state.
    // Sprint Level2D Phase 2 -- Tilemap2D enters the sprite-pipeline
    // branch when it has a textured tileset (params.tileset). Without
    // a tileset it falls through to the unlit-vc mesh pipeline below.
    if (m.node && (
        m.node.type === "Sprite"
        || m.node.type === "TileSpriteOverlay"
        || m.node.type === "ParallaxLayer2D"
        || m.node.type === "SpriteScatter2D"
        || (m.node.type === "Tilemap2D" && _tilemap2dUsesTileset(m.node))
      ) && buf && buf.vertexBuffer) {
      const texEntry = (typeof _resolveSpriteTextureEntry === "function")
        ? _resolveSpriteTextureEntry(m.node) : null;
      if (texEntry && texEntry.state === "ready" && texEntry.view) {
        const spritePipeline = _ensureSpritePipeline(sampleCount);
        if (spritePipeline) {
          const sp = _resolveNodeParams(m.node);
          // Sampler filter follows the upstream ImageURL's filterMode
          // (default nearest = pixel-art crisp).
          let filterMode = "nearest";
          let wrapMode   = "clamp";
          // Level2D Phase 1a: synthetic layer nodes carry filter/wrap
          // inline in their _levelLayer config; everything else walks
          // the texture wire to the upstream ImageURL.
          if (m.node._levelLayer) {
            if (typeof m.node._levelLayer.filterMode === "string") filterMode = m.node._levelLayer.filterMode;
            if (typeof m.node._levelLayer.wrapMode   === "string") wrapMode   = m.node._levelLayer.wrapMode;
          } else {
            const texWire = state && Array.isArray(state.edges) && state.edges.find(e =>
              e && e.to && e.to.node === m.node.id && e.to.port === "texture"
            );
            if (texWire && texWire.from) {
              const imgNode = state.nodes.find(n => n && n.id === texWire.from.node);
              if (imgNode && imgNode.params) {
                if (typeof imgNode.params.filterMode === "string") filterMode = imgNode.params.filterMode;
                if (typeof imgNode.params.wrapMode   === "string") wrapMode   = imgNode.params.wrapMode;
              }
            }
          }
          const sampler = _ensureSpriteSampler(filterMode, wrapMode);
          const inst = _ensureSpriteInstance(m.node, texEntry.view, sampler);
          if (inst) {
            // Pack uniform: modelViewProj (16) + tint (4) + frameMeta (4) = 24 floats.
            const mvp = inst.scratch;
            // viewProj * model -- model is m.transform (Translate-chain composed).
            const tmp = new Float32Array(16);
            _mat4Multiply(tmp, camera.viewProj, m.transform || _mat4Identity());
            for (let k = 0; k < 16; k++) mvp[k] = tmp[k];
            mvp[16] = (typeof sp.tintR === "number") ? sp.tintR : 1.0;
            mvp[17] = (typeof sp.tintG === "number") ? sp.tintG : 1.0;
            mvp[18] = (typeof sp.tintB === "number") ? sp.tintB : 1.0;
            mvp[19] = (typeof sp.tintA === "number") ? sp.tintA : 1.0;
            mvp[20] = (typeof sp.frame   === "number") ? Math.floor(sp.frame)   : 0;
            mvp[21] = (typeof sp.framesX === "number") ? Math.max(1, Math.floor(sp.framesX)) : 1;
            mvp[22] = (typeof sp.framesY === "number") ? Math.max(1, Math.floor(sp.framesY)) : 1;
            mvp[23] = (typeof sp.flipX   === "number" && sp.flipX >= 0.5) ? 1.0 : 0.0;
            Visual.device.queue.writeBuffer(inst.uniformBuffer, 0, mvp.buffer, 0, 24 * 4);
            pass.setPipeline(spritePipeline);
            pass.setBindGroup(0, inst.bindGroup);
            pass.setVertexBuffer(0, buf.vertexBuffer);
            if (buf.indexBuffer) {
              pass.setIndexBuffer(buf.indexBuffer, "uint32");
              pass.drawIndexed(buf.indexCount);
            } else {
              pass.draw(buf.vertexCount);
            }
            curMaterialType = null;  // next mesh must re-set the mesh pipeline + bind group
            if (!Visual._spriteFirstDrawLogged) {
              Visual._spriteFirstDrawLogged = true;
              console.log("[sprite] first textured draw: node=" + m.node.id
                + " tex=" + texEntry.width + "×" + texEntry.height
                + " filter=" + filterMode
                + " frame=" + mvp[20] + "/" + (mvp[21] * mvp[22]));
            }
            continue;
          }
        }
      }
      // Sprite without a loaded texture falls through to the standard
      // unlit-vc path (solid-color from vertex tint). Same behavior as
      // before platformer-2a so unwired sprites keep working.
    }
    // §5.5.h -- Water node bakes its own material; override matType
    // so fs_water fires regardless of any wired Material.
    // §5.5.h-14 -- same pattern for Clouds3D -> fs_clouds.
    let matType = (m.material && m.material.type) || "unlit-vc";
    if (m.node && m.node.type === "Clouds3D") {
      matType = "clouds";
    }
    // §5.5.h-24 -- TerrainHorizon gets its own pipeline with a
    // camera-distance discard so it doesn't draw over the chunked
    // TiledTerrain inside the visible disc.
    if (m.node && m.node.type === "TerrainHorizon") {
      matType = "horizon";
    }
    if (m.node && m.node.type === "Water") {
      matType = "water";
      if (!Visual._waterDrawLogged) {
        Visual._waterDrawLogged = true;
        const tt = state && state.nodes && state.nodes.find(n => n && n.type === "TiledTerrain");
        const ttp = tt && tt.params;
        console.log("[water] reached encoder: slot=" + i +
                    " verts=" + buf.vertexCount +
                    " indices=" + buf.indexCount +
                    " aabb=[" + (buf.aabbMin ? buf.aabbMin.join(",") : "?") +
                    "..." + (buf.aabbMax ? buf.aabbMax.join(",") : "?") + "]");
        if (ttp) {
          console.log("[water] terrain noise params from TiledTerrain: " +
                      "seed=" + ttp.seed +
                      " freq=" + ttp.frequency +
                      " octs=" + ttp.octaves +
                      " hs=" + ttp.heightScale +
                      " yOff=" + ttp.yOffset +
                      " plateau=" + ttp.plateau +
                      " islandMode=" + ttp.islandMode);
        } else {
          console.log("[water] no TiledTerrain found -- shore detect will use fallback (open ocean everywhere).");
        }
      }
    }
    // v0.3.126 §5.5.c-3 -- detect Terrain w/ heightmap wired ->
    // pick the `displaced` pipeline variant so vs_terrain runs in
    // place of vs_main. Plan walker schedules the heightmap source
    // (ProceduralTerrain or whatever) into a scratch slot before
    // Scene's pass; we resolve the layer index below for vsParams.
    const isTerrainGen = m.node && m.node.type === "Terrain";
    let hmWire = null;
    if (isTerrainGen) {
      hmWire = state.edges.find(e =>
        e && e.to && e.to.node === m.node.id && e.to.port === "heightmap"
      );
    }
    const useDisplaced = !!(isTerrainGen && hmWire && hmWire.from);
    // Phase 8 sprint 8-7b: synthesized detail-patch entries use
    // vs_planet_detail. Flag set by _resolveSceneMeshes alongside
    // PlanetMesh; the node still points to the PlanetMesh for
    // param access.
    //
    // Sprint 9-2c: PlanetMesh chunks (resolved through
    // _ensurePlanetMeshChunks, kind=mesh-gen) use the CDLOD vertex
    // shader. The 14-float per-vertex layout requires the matching
    // pipeline variant -- routing it via vsVariant keeps the
    // pipeline-cache key correct and the input attribute layout in
    // sync with the VBO.
    const vsVariant = m.isPlanetDetailPatch        ? "planet_detail"
                    : (m.node && m.node.type === "PlanetMesh") ? "planet_cdlod"
                    : null;
    const pipelineKeyStr = matType + (useDisplaced ? "+d" : "") + (vsVariant ? ("+" + vsVariant) : "");
    if (pipelineKeyStr !== curMaterialType) {
      const pipeline = _ensureMeshPipeline(matType, sampleCount, useDisplaced, vsVariant);
      if (!pipeline) continue;
      pass.setPipeline(pipeline);
      curMaterialType = pipelineKeyStr;
    }
    // Write model + material into THIS slot's per-draw buffer.
    // Sprint 9-3: PlanetMesh chunks use mv_rtc (view * translate(anchor)
    // composed JS-side in f64) instead of m.transform. The chunk's
    // anchorF64 lives on each tiledChunks entry; for now all chunks
    // of a PlanetMesh share the planet-center anchor so we read the
    // first chunk's anchor and compose mv_rtc once per mesh. Per-chunk
    // dynamic-offset upload (true foot-level f32 precision) is 9-3b.
    if (vsVariant === "planet_cdlod" && buf && buf.tiledChunks && buf.tiledChunks.length > 0 && camera.viewF64) {
      const anchor = buf.tiledChunks[0].anchorF64 || { x: 0, y: 0, z: 0 };
      const mvRtc = _composeRtcModelView(camera.viewF64, anchor, m.transform || _mat4Identity());
      inst.drawScratch.set(mvRtc, 0);
    } else {
      inst.drawScratch.set(m.transform, 0);
    }
    let mp = (m.material && m.material.params) || {};
    // §5.5.h -- Water packs its own params from m.node (mesh-gen
    // doubles as material since Water bakes the shader in).
    // §5.5.h-14 -- same pattern for Clouds3D.
    if (matType === "water" && m.node && m.node.params) mp = m.node.params;
    if (matType === "clouds" && m.node && m.node.params) mp = m.node.params;
    inst.drawScratch[16] = (typeof mp.r === "number") ? mp.r : ((typeof mp.colorR === "number") ? mp.colorR : 1.0);
    inst.drawScratch[17] = (typeof mp.g === "number") ? mp.g : ((typeof mp.colorG === "number") ? mp.colorG : 1.0);
    inst.drawScratch[18] = (typeof mp.b === "number") ? mp.b : ((typeof mp.colorB === "number") ? mp.colorB : 1.0);
    inst.drawScratch[19] = (typeof mp.vertexMix === "number") ? mp.vertexMix : (matType === "unlit-vc" ? 1.0 : 0.0);
    inst.drawScratch[20] = (typeof mp.shininess === "number") ? mp.shininess : 32.0;
    inst.drawScratch[21] = (typeof mp.ambient   === "number") ? mp.ambient   : 0.15;
    inst.drawScratch[22] = (typeof mp.metallic  === "number") ? mp.metallic  : 0.0;
    inst.drawScratch[23] = (typeof mp.roughness === "number") ? mp.roughness : 0.5;
    // A.4 -- pbr reads matParams.x as a UV tile factor (fs_pbr ignores
    // .x/.y otherwise). Default 1 = no tiling. Lets seamless textures
    // repeat across large faces without a per-mesh UV-gen change.
    if (matType === "pbr") {
      inst.drawScratch[20] = (typeof mp.uvScale === "number" && mp.uvScale > 0) ? mp.uvScale : 1.0;
    }
    // §5.5.h -- Water remap. See fs_water for the per-slot legend.
    if (matType === "water") {
      inst.drawScratch[19] = (typeof mp.fresnelStrength === "number") ? mp.fresnelStrength : 1.0;
      inst.drawScratch[20] = (typeof mp.seaLevel  === "number") ? mp.seaLevel  : 0;
      inst.drawScratch[21] = (typeof mp.waveFreq  === "number") ? mp.waveFreq  : 0.012;
      inst.drawScratch[22] = (typeof mp.waveSpeed === "number") ? mp.waveSpeed : 0.6;
      inst.drawScratch[23] = (typeof mp.waveAmp   === "number") ? mp.waveAmp   : 1.0;
      inst.drawScratch[24] = (typeof mp.skyR === "number") ? mp.skyR : 0.62;
      inst.drawScratch[25] = (typeof mp.skyG === "number") ? mp.skyG : 0.78;
      inst.drawScratch[26] = (typeof mp.skyB === "number") ? mp.skyB : 0.92;
      if (!Visual._waterStartT) Visual._waterStartT = performance.now();
      inst.drawScratch[27] = (performance.now() - Visual._waterStartT) * 0.001;
      // §5.5.h-5 -- shore detection. The Water node's `heightmap`
      // input takes a wire from a TiledTerrain's `heightmap` output;
      // we walk state.edges to find that wire's source. If unwired,
      // shore detect is disabled (depth defaults to "open ocean
      // everywhere" in fs_water).
      let tt = null;
      if (state && Array.isArray(state.edges)) {
        const hmWire = state.edges.find(e =>
          e && e.to && e.to.node === m.node.id && e.to.port === "heightmap"
        );
        if (hmWire && hmWire.from) {
          const src = state.nodes.find(n => n && n.id === hmWire.from.node);
          if (src && src.type === "TiledTerrain") tt = src;
        }
      }
      if (tt && tt.params) {
        const tp2 = tt.params;
        inst.drawScratch[28] = (typeof tp2.seed       === "number") ? tp2.seed       : 7.42;
        inst.drawScratch[29] = (typeof tp2.frequency  === "number") ? tp2.frequency  : 0.008;
        inst.drawScratch[30] = (typeof tp2.octaves    === "number") ? tp2.octaves    : 6;
        inst.drawScratch[31] = (typeof tp2.plateau    === "number") ? tp2.plateau    : 0;
        inst.drawScratch[32] = (typeof tp2.lacunarity === "number") ? tp2.lacunarity : 2.0;
        inst.drawScratch[33] = (typeof tp2.gain       === "number") ? tp2.gain       : 0.5;
        inst.drawScratch[34] = (typeof tp2.ridges     === "number") ? tp2.ridges     : 0;
        inst.drawScratch[35] = (typeof tp2.heightScale=== "number") ? tp2.heightScale: 80;
        inst.drawScratch[36] = (typeof tp2.yOffset    === "number") ? tp2.yOffset    : 0;
        inst.drawScratch[37] = (typeof tp2.islandSinkDepth === "number") ? tp2.islandSinkDepth : 0;
        inst.drawScratch[38] = (tp2.islandMode === "archipelago") ? 1 : 0;
        inst.drawScratch[39] = (typeof tp2.islandMaskFreq      === "number") ? tp2.islandMaskFreq      : 0.0001;
        inst.drawScratch[40] = (typeof tp2.islandMaskSeed      === "number") ? tp2.islandMaskSeed      : 0;
        inst.drawScratch[41] = (typeof tp2.islandMaskThreshold === "number") ? tp2.islandMaskThreshold : 0.5;
        inst.drawScratch[42] = (typeof tp2.islandMaskSoftness  === "number") ? tp2.islandMaskSoftness  : 0.08;
      } else {
        for (let s = 28; s <= 42; s++) inst.drawScratch[s] = 0;
      }
      inst.drawScratch[43] = (typeof mp.foamWidth      === "number") ? mp.foamWidth      : 6;
      inst.drawScratch[44] = (typeof mp.shallowDepth   === "number") ? mp.shallowDepth   : 40;
      inst.drawScratch[45] = (typeof mp.waveShoreFreq  === "number") ? mp.waveShoreFreq  : 0.018;
      inst.drawScratch[46] = (typeof mp.foamR === "number") ? mp.foamR : 0.96;
      inst.drawScratch[47] = (typeof mp.foamG === "number") ? mp.foamG : 0.97;
      inst.drawScratch[48] = (typeof mp.foamB === "number") ? mp.foamB : 1.00;
      // §5.5.h-4 -- pack the TiledTerrain LOD geometry into
      // bumpParams.yzw so fs_water can sample at the same grid
      // density the mesh uses. Without these the shader samples
      // exact noise and the foam line drifts off the discretized
      // mesh edge at distant LOD rings.
      if (tt && tt.params) {
        inst.drawScratch[49] = (typeof tt.params.chunkSize   === "number") ? tt.params.chunkSize   : 64;
        inst.drawScratch[50] = (typeof tt.params.segments    === "number") ? tt.params.segments    : 24;
        inst.drawScratch[51] = (typeof tt.params.chunkRadius === "number") ? tt.params.chunkRadius : 8;
        // §5.5.h-5 -- actual disc center tile (with forwardBias).
        // Using camera tile as fallback caused east/west water to
        // disappear because the LOD ring calc was off by the bias
        // shift. _tiledTerrainCenterTile applies the bias internally.
        const dc = (typeof _tiledTerrainCenterTile === "function")
          ? _tiledTerrainCenterTile(tt) : { tx: 0, tz: 0 };
        inst.drawScratch[52] = dc.tx;
        inst.drawScratch[53] = dc.tz;
        // §5.5.h-9 -- beach band params from upstream TiledTerrain.
        // Drives fs_water's beach blend so shore detect lines up with
        // the mesh's flattened beach zones.
        inst.drawScratch[54] = (typeof tt.params.islandBeachStrength === "number") ? tt.params.islandBeachStrength : 0;
        inst.drawScratch[55] = (typeof tt.params.islandBeachFreq     === "number") ? tt.params.islandBeachFreq     : 0.0008;
      } else {
        inst.drawScratch[49] = 0; inst.drawScratch[50] = 0; inst.drawScratch[51] = 0;
        inst.drawScratch[52] = 0; inst.drawScratch[53] = 0;
      }
      // §5.5.h-21 -- cloud-shadow params from any Clouds3D node in
      // the patch. Slots 56..59 map to PerDraw.cloudExtra.xyzw =
      // (altitude, coverage, scale, seed). coverage=0 disables the
      // shadow path in fs_water.
      let cl = null;
      if (state && Array.isArray(state.nodes)) {
        cl = state.nodes.find(n => n && n.type === "Clouds3D");
      }
      if (cl && cl.params) {
        inst.drawScratch[56] = (typeof cl.params.altitude === "number") ? cl.params.altitude : 2500;
        inst.drawScratch[57] = (typeof cl.params.coverage === "number") ? cl.params.coverage : 0;
        inst.drawScratch[58] = (typeof cl.params.scale    === "number") ? cl.params.scale    : 0.0008;
        inst.drawScratch[59] = (typeof cl.params.seed     === "number") ? cl.params.seed     : 11.3;
      } else {
        inst.drawScratch[56] = 0; inst.drawScratch[57] = 0;
        inst.drawScratch[58] = 0; inst.drawScratch[59] = 0;
      }
    }
    // §5.5.h-17 -- Clouds3D remap. fs_clouds is now a Phong-style
    // shader over a CPU-built displaced mesh. Reads:
    //   baseColor.rgb = cloud color, baseColor.a = density (alpha mult)
    //   matParams.x = ambient fill light strength
    //   matParams.y = sun-dot contribution strength
    //   matParams.zw = unused
    if (matType === "clouds") {
      inst.drawScratch[16] = (typeof mp.colorR === "number") ? mp.colorR : 1.0;
      inst.drawScratch[17] = (typeof mp.colorG === "number") ? mp.colorG : 1.0;
      inst.drawScratch[18] = (typeof mp.colorB === "number") ? mp.colorB : 1.0;
      inst.drawScratch[19] = (typeof mp.density === "number") ? mp.density : 1.0;
      inst.drawScratch[20] = (typeof mp.ambient     === "number") ? mp.ambient     : 0.55;
      inst.drawScratch[21] = (typeof mp.sunStrength === "number") ? mp.sunStrength : 0.65;
      inst.drawScratch[22] = 0;
      inst.drawScratch[23] = 0;
      // Clear remaining slots so stale water/terrain data doesn't bleed.
      for (let s = 24; s < 56; s++) inst.drawScratch[s] = 0;
    }
    // §5.5.h-24 -- TerrainHorizon remap. fs_horizon reads:
    //   matParams.x = innerRadius (camera-XZ discard radius)
    //   matParams.y = fadeWidth   (smoothstep band beyond innerRadius)
    //   matParams.z = ambient
    //   matParams.w = sunStrength
    // innerRadius pulls from the patch's TiledTerrain (chunkRadius *
    // chunkSize, scaled by 0.9 so the impostor fades in just before
    // the chunked disc's outer edge instead of leaving a visible gap).
    if (matType === "horizon") {
      let innerR = 4000;
      const ttx = state && Array.isArray(state.nodes) && state.nodes.find(n => n && n.type === "TiledTerrain");
      if (ttx && ttx.params) {
        const cs = (typeof ttx.params.chunkSize   === "number") ? ttx.params.chunkSize   : 256;
        const cr = (typeof ttx.params.chunkRadius === "number") ? ttx.params.chunkRadius : 8;
        innerR = Math.max(1000, cs * cr * 0.9);
      }
      inst.drawScratch[16] = 1; inst.drawScratch[17] = 1; inst.drawScratch[18] = 1;
      inst.drawScratch[19] = 1;
      inst.drawScratch[20] = innerR;
      inst.drawScratch[21] = Math.max(200, innerR * 0.15);     // fadeWidth ~ 15% of innerR
      inst.drawScratch[22] = 0.55;                              // ambient
      inst.drawScratch[23] = 0.65;                              // sunStrength
      for (let s = 24; s < 56; s++) inst.drawScratch[s] = 0;
      // §5.5.h-25 -- planet curvature params for vs_horizon. Read
      // from the TerrainHorizon node's own params with sensible
      // defaults; band1.xyz = (altLow, altHigh, planetRadius).
      // §planet-spec Phase 1.5 -- band1.w = visAltLow, band2.x =
      // visAltHigh. fs_horizon discards fragments at camera Y below
      // visAltLow and fades in over [visAltLow, visAltHigh].
      const hp = (m.node && m.node.params) || {};
      inst.drawScratch[24] = (typeof hp.curveAltLow  === "number") ? hp.curveAltLow  : 2000;
      inst.drawScratch[25] = (typeof hp.curveAltHigh === "number") ? hp.curveAltHigh : 8000;
      inst.drawScratch[26] = (typeof hp.planetRadius === "number") ? hp.planetRadius : 200000;
      inst.drawScratch[27] = (typeof hp.visAltLow    === "number") ? hp.visAltLow    : 60000;
      inst.drawScratch[28] = (typeof hp.visAltHigh   === "number") ? hp.visAltHigh   : 100000;
      inst.drawScratch[29] = 0; inst.drawScratch[30] = 0; inst.drawScratch[31] = 0;
    }
    // Phase 7 §5.5.c -- TerrainMaterial uses the extended band
    // slots [24..39] and reinterprets matParams as
    // (shininess, ambient, slopeRockiness, vertexMix). Other
    // materials don't touch [24..39] -- the GPU just reads from
    // its own slots and ignores the rest of the uniform.
    if (matType === "terrain") {
      // Auto-scale Y-dependent material params by the upstream
      // Terrain's effective heightScale, so altitude bands stay
      // proportional when the user changes sizeMode (small / medium
      // / large / infinite / custom). Default heightScale = 12 at
      // worldSize = 100 (medium) matches the alt defaults (-8/-4/-1).
      // For any other (heightScale × worldSize/100) pair, scale alts,
      // edgeJitter, and softness by the ratio so a "large" landscape
      // sees the snow line at Y=-10 instead of where the whole
      // terrain sits. Inverse-scale detail / micro noise frequencies
      // so a person walking the larger world sees roughly the same
      // visual texture density per step. If the mesh source isn't
      // a Terrain node (rare -- material on a Sphere, etc.), bandScale
      // stays at 1 and behavior matches v0.3.131.
      let bandScale = 1;
      let xzScale   = 1;
      if (m.node && m.node.type === "Terrain") {
        const ttp = m.node.params || {};
        const sizePresetsM = { small: 20, medium: 100, large: 1000, infinite: 10000 };
        const tMode = (typeof ttp.sizeMode === "string") ? ttp.sizeMode : "medium";
        const tCustomSize = (typeof ttp.worldSize === "number") ? ttp.worldSize : 100;
        const tWS = (tMode === "custom") ? tCustomSize : (sizePresetsM[tMode] || tCustomSize);
        const tHsRaw = (typeof ttp.heightScale === "number") ? ttp.heightScale : 12;
        const tEffectiveHs = tHsRaw * (tWS / 100);
        bandScale = tEffectiveHs / 12;        // default 1
        xzScale   = 100 / Math.max(1, tWS);   // default 1 at medium; <1 at larger
      } else if (m.node && m.node.type === "TiledTerrain") {
        // §5.5.e -- TiledTerrain's heightScale IS the world Y range
        // directly (no worldSize ratio). xzScale derived from the
        // visible-disc diameter so detail noise stays at the same
        // visual density per step as the user walks.
        const ttp = m.node.params || {};
        const tHs = (typeof ttp.heightScale === "number") ? ttp.heightScale : 20;
        const tCS = (typeof ttp.chunkSize   === "number") ? ttp.chunkSize   : 32;
        const tR  = (typeof ttp.chunkRadius === "number") ? ttp.chunkRadius : 4;
        const tDiameter = (2 * tR + 1) * tCS;
        bandScale = tHs / 12;
        xzScale   = 100 / Math.max(1, tDiameter);
      }
      inst.drawScratch[20] = mp.shininess;
      inst.drawScratch[21] = mp.ambient;
      inst.drawScratch[22] = mp.slopeRockiness;
      inst.drawScratch[23] = mp.vertexMix;
      // band1 = sand
      inst.drawScratch[24] = mp.color1R; inst.drawScratch[25] = mp.color1G; inst.drawScratch[26] = mp.color1B; inst.drawScratch[27] = mp.alt1 * bandScale;
      // band2 = grass
      inst.drawScratch[28] = mp.color2R; inst.drawScratch[29] = mp.color2G; inst.drawScratch[30] = mp.color2B; inst.drawScratch[31] = mp.alt2 * bandScale;
      // band3 = rock
      inst.drawScratch[32] = mp.color3R; inst.drawScratch[33] = mp.color3G; inst.drawScratch[34] = mp.color3B; inst.drawScratch[35] = mp.alt3 * bandScale;
      // band4 = snow + softness (smoothstep width in Y units -> scales).
      inst.drawScratch[36] = mp.color4R; inst.drawScratch[37] = mp.color4G; inst.drawScratch[38] = mp.color4B; inst.drawScratch[39] = mp.softness * bandScale;
      // detailParams (vec4) at [44..47]; bumpParams (vec4) at [48..51].
      // Noise frequencies (detailScale / microScale) are cycles per
      // world unit -- inverse-scale so larger worlds get coarser
      // noise per step. Strengths + bump are dimensionless, pass-through.
      // edgeJitter is in Y world units, so it scales like alt.
      inst.drawScratch[44] = mp.detailScale * xzScale;
      inst.drawScratch[45] = mp.detailStrength;
      inst.drawScratch[46] = mp.microScale * xzScale;
      inst.drawScratch[47] = mp.microStrength;
      inst.drawScratch[48] = mp.edgeJitter * bandScale;
      inst.drawScratch[49] = mp.bumpStrength;
      inst.drawScratch[50] = mp.snowMaskAmount;
      inst.drawScratch[51] = 0;
    }
    // Sprint 7.5.3c push 5 -- for ShaderMat with a wired texture
    // input, look up the upstream's scratch layer + override
    // matParams.w (roughness slot) with the layer index. The
    // "texture" preset reads this to know which scratch layer to
    // sample. Other presets ignore matParams.w (it was reserved
    // before this push).
    if (matType.indexOf("shadermat-") === 0 && m.material && m.material.node) {
      const texWire = state.edges.find(e =>
        e && e.to && e.to.node === m.material.node.id && e.to.port === "texture"
      );
      if (texWire && texWire.from) {
        const planMap = Visual._currentRenderPlan;
        const upstreamEntry = planMap && planMap.get(texWire.from.node + "@" + entry.consumerVO.id);
        if (upstreamEntry && upstreamEntry.isScratch) {
          inst.drawScratch[23] = upstreamEntry.layerIdx;
        }
      }
    }
    // v0.3.126 §5.5.c-3 -- when this Terrain draw uses the
    // displaced vertex shader, pack vsParams: heightScale,
    // worldSize, _, heightmap-layer-index. Pulls the layer from
    // the render plan (same lookup ShaderMat.texture uses).
    if (useDisplaced) {
      const tp = m.node.params || {};
      const sizePresets = { small: 20, medium: 100, large: 1000, infinite: 10000 };
      const mode = (typeof tp.sizeMode === "string") ? tp.sizeMode : "medium";
      const customSize = (typeof tp.worldSize === "number") ? tp.worldSize : 100;
      const ws = (mode === "custom") ? customSize : (sizePresets[mode] || customSize);
      // Match _buildTerrain: scale vertical gain by world size so
      // the GPU-displaced path stays in sync with the CPU path
      // (always-on ratio, including custom mode).
      const hsRawT = (typeof tp.heightScale === "number") ? tp.heightScale : 12;
      const hsScaleT = ws / 100;
      const hsT = hsRawT * hsScaleT;
      let hmLayer = 0;
      const planMap = Visual._currentRenderPlan;
      const upstreamEntry = planMap && planMap.get(hmWire.from.node + "@" + entry.consumerVO.id);
      if (upstreamEntry) hmLayer = upstreamEntry.layerIdx;
      // vsParams lives at slots [40..43]. vs_terrain reads .x/.y/.w.
      inst.drawScratch[40] = hsT;
      inst.drawScratch[41] = ws;
      inst.drawScratch[42] = 0;
      inst.drawScratch[43] = hmLayer;
    } else if (matType !== "water") {
      // Clear vsParams when not displaced (avoids stale layer values
      // from a previous draw on the same slot in the same frame).
      // SKIP for water: the water block above packs its own
      // vsParams (mask seed / threshold / softness / foamWidth) and
      // clearing here would overwrite them with zeros -- which
      // collapses the shore-detect smoothstep to land=1 everywhere
      // and renders the entire water plane as solid foam-white.
      inst.drawScratch[40] = 0;
      inst.drawScratch[41] = 0;
      inst.drawScratch[42] = 0;
      inst.drawScratch[43] = 0;
    }
    // Sprint 9-3 / 9-4-fix: for PlanetMesh draws, vsParams now
    // carries the f32 approximation of the chunk's anchorF64 so
    // vs_planet_cdlod can reconstruct world position by adding it
    // to the anchor-relative vertex. (sprint 9-3 had repurposed
    // uD.model for mv_rtc = view * translate(anchor), which lands
    // pos in VIEW space; the fragment-side worldPos consumers --
    // biome textures, atmosphere, lighting -- need true world
    // space.) The old displacementScale-flag use of vsParams in
    // vs_main is retired (displacementScale default 0 after 9-1).
    if (m.node && m.node.type === "PlanetMesh" && !m.isPlanetDetailPatch
        && buf && buf.tiledChunks && buf.tiledChunks.length > 0) {
      const anchor = buf.tiledChunks[0].anchorF64 || { x: 0, y: 0, z: 0 };
      inst.drawScratch[40] = anchor.x;   // vsParams.x = anchorF32.x
      inst.drawScratch[41] = anchor.y;   // vsParams.y = anchorF32.y
      inst.drawScratch[42] = anchor.z;   // vsParams.z = anchorF32.z
      inst.drawScratch[43] = 0;
    }
    // Phase 8 sprint 8-7b -- synthesized planet detail-patch
    // per-draw uniforms. Reads detailPatch* params from the
    // PlanetMesh node that the patch is attached to.
    if (m.isPlanetDetailPatch) {
      const dpp = (m.node && m.node.params) || {};
      inst.drawScratch[40] = (typeof dpp.detailPatchSize     === "number") ? dpp.detailPatchSize     : 3000.0;
      let patchBiomeId      = (typeof dpp.detailPatchBiomeId  === "number") ? dpp.detailPatchBiomeId  : 4.0;
      inst.drawScratch[42] = (typeof dpp.detailPatchDispScale === "number") ? dpp.detailPatchDispScale : 1.0;
      inst.drawScratch[43] = (typeof dpp.detailPatchMaxAlt   === "number") ? dpp.detailPatchMaxAlt   : 5000.0;

      // Sprint 8-7d -- per-frame macro-elevation + biome lookup for
      // the camera's location. Sprint 8-8 routes this through the
      // shared _planetMeshSurfacePos helper so the patch, altimeter,
      // walk-mode lock, and flight collision all read the SAME cell.
      // Previously this used an inline cell lookup that, while
      // matching the formula, made it easy to drift apart on later
      // edits.
      let macroElev = 0.0;
      const _patchPL = _findPlanetInfo();
      if (_patchPL && _patchPL.mapNode && _patchPL.mapNode._cells) {
        const surf = _planetMeshSurfacePos(camera.eye[0], camera.eye[1], camera.eye[2], _patchPL);
        if (surf) {
          macroElev = surf.altitude;
          if (surf.biomeId >= 0) patchBiomeId = surf.biomeId;
        }
      }
      inst.drawScratch[41] = patchBiomeId;
      // baseColor.w (slot 19) repurposed as macro elevation for the
      // patch draw. The vertex shader adds this to the surface radial
      // position so the patch lines up with the PlanetMesh's macro
      // terrain instead of sitting at bare sea level under the camera.
      inst.drawScratch[19] = macroElev;
    }
    // Phase 8 sprint 8-3b -- PlanetMesh texture layer resolution.
    // Slots [60..63] map to PerDraw.planetExtra.xyzw = (landLayer,
    // waterLayer, textureScale, textureMix). Default to "no
    // texture" (-1) so unwired planet draws keep the existing biome
    // / water shading. When the PlanetMesh node has landTexture or
    // waterTexture wires, the upstream's scratch slot is resolved
    // via the same render-plan lookup ShaderMat uses.
    inst.drawScratch[60] = -1;
    inst.drawScratch[61] = -1;
    inst.drawScratch[62] = 0.001;
    inst.drawScratch[63] = 0.0;
    if (m.node && m.node.type === "PlanetMesh") {
      const ptp = m.node.params || {};
      const planMap = Visual._currentRenderPlan;
      const landWire = state && Array.isArray(state.edges) && state.edges.find(e =>
        e && e.to && e.to.node === m.node.id && e.to.port === "landTexture"
      );
      if (landWire && landWire.from) {
        const upstreamEntry = planMap && planMap.get(landWire.from.node + "@" + entry.consumerVO.id);
        if (upstreamEntry && upstreamEntry.isScratch) {
          inst.drawScratch[60] = upstreamEntry.layerIdx;
        }
      }
      const waterWire = state && Array.isArray(state.edges) && state.edges.find(e =>
        e && e.to && e.to.node === m.node.id && e.to.port === "waterTexture"
      );
      if (waterWire && waterWire.from) {
        const upstreamEntry = planMap && planMap.get(waterWire.from.node + "@" + entry.consumerVO.id);
        if (upstreamEntry && upstreamEntry.isScratch) {
          inst.drawScratch[61] = upstreamEntry.layerIdx;
        }
      }
      inst.drawScratch[62] = (typeof ptp.textureScale === "number") ? ptp.textureScale : 0.001;
      inst.drawScratch[63] = (typeof ptp.textureMix   === "number") ? ptp.textureMix   : 1.0;
    }
    Visual.device.queue.writeBuffer(slot.perDrawBuffer, 0, inst.drawScratch.buffer, 0, 256);
    // A.4 -- per-material PBR maps. If this slot's mesh has a
    // PhysicalMat with map params, stream them + rebind the slot's
    // bind groups with the resolved views (keyed so we only rebuild
    // when the loaded set changes). Untextured slots keep the 1×1
    // defaults (no-op).
    if (slot.setMaterialTextures && m.material && m.material.node &&
        m.material.node.type === "PhysicalMat") {
      const mn = m.material.node, mpp = mn.params || {};
      if (mpp.albedoMap || mpp.normalMap || mpp.roughMap || mpp.metalMap) {
        _ensureMatTextures(mn);
        const key = (mn._mapAlbedo ? "a" : "") + (mn._mapNormal ? "n" : "") +
                    (mn._mapRough ? "r" : "") + (mn._mapMetal ? "m" : "");
        if (slot._matKey !== key) {
          slot.setMaterialTextures({ albedo: mn._mapAlbedo, normal: mn._mapNormal, rough: mn._mapRough, metal: mn._mapMetal });
          slot._matKey = key;
        }
      } else if (slot._matKey !== "") {
        slot.setMaterialTextures(null);
        slot._matKey = "";
      }
    }
    // v0.3.120 -- pick the bind group whose binding 2 is OPPOSITE
    // parity to the scratch layer we're writing to. Prevents the
    // texture-as-binding-and-attachment aliasing that silently broke
    // Scene → composition chains (Scene → CRT, Scene → Blur, etc.).
    const bg = (entry.readKey === "b") ? slot.bindGroupB : slot.bindGroupA;
    pass.setBindGroup(0, bg);
    // §5.5.e-6 -- per-chunk VBO/IBO draw for TiledTerrain streaming.
    // Each chunk has its OWN vertex + index buffer (so chunks can
    // be destroyed independently when they leave the visible disc).
    // Frustum-cull per chunk, then bind chunk's buffers + draw.
    if (buf.tiledChunks) {
      let chunkCulled = 0;
      for (let ck = 0; ck < buf.tiledChunks.length; ck++) {
        const c = buf.tiledChunks[ck];
        if (cullEnable && camera.frustumPlanes) {
          _transformAABB(c.aabbMin, c.aabbMax, m.transform,
                         _aabbMinScratch, _aabbMaxScratch);
          if (!_aabbInsideFrustum(camera.frustumPlanes, _aabbMinScratch, _aabbMaxScratch)) {
            chunkCulled++;
            continue;
          }
        }
        pass.setVertexBuffer(0, c.vertexBuffer);
        pass.setIndexBuffer(c.indexBuffer, "uint32");
        pass.drawIndexed(c.indexCount);
      }
      culledCount += chunkCulled;
    } else {
      pass.setVertexBuffer(0, buf.vertexBuffer);
      if (buf.indexBuffer) {
        pass.setIndexBuffer(buf.indexBuffer, "uint32");
        pass.drawIndexed(buf.indexCount);
      } else {
        pass.draw(buf.vertexCount);
      }
    }
    if (!_SCENE_DIAG.draw) {
      _SCENE_DIAG.draw = true;
      console.log("[scene] first mesh draw: slot=" + i + " src=" + m.node.type + "#" + m.node.id +
                  " material=" + matType +
                  " verts=" + buf.vertexCount + (buf.indexCount ? " indices=" + buf.indexCount : ""));
    }
  }

  // Sprint 5.10 -- one-shot diagnostic on first frustum cull so the
  // user can confirm culling is working without needing a gizmo.
  if (culledCount > 0 && !_SCENE_DIAG.cull) {
    _SCENE_DIAG.cull = true;
    console.log("[scene] frustum culling active (" + culledCount +
                " mesh(es) culled this frame). Disable via Scene.cullEnable=0.");
  }

  // Sprint 7.5.4.c-sky -- background sky pass. Fills the
  // not-covered-by-mesh pixels with sample_env(rayDir) so the wired
  // environment becomes the actual visible sky behind the scene,
  // not just IBL ambient on surfaces. Only fires when an env is
  // wired (env != null); otherwise the Scene's clearR/G/B persists
  // as the background and existing patches don't shift visually.
  // Runs LAST in the render pass: meshes have already written
  // depth < 1 wherever they cover, so depth-test less-equal +
  // sky-vertex-z=1 paints only the uncovered pixels.
  if (env && inst.slots[0] && inst.slots[0].bindGroup) {
    const skyPipeline = _ensureSkyPipeline(sampleCount);
    if (skyPipeline) {
      pass.setPipeline(skyPipeline);
      // v0.3.120 -- same parity selection as the mesh draws above.
      const skyBg = (entry.readKey === "b") ? inst.slots[0].bindGroupB : inst.slots[0].bindGroupA;
      pass.setBindGroup(0, skyBg);
      pass.draw(3);
      if (!_SCENE_DIAG.sky) {
        _SCENE_DIAG.sky = true;
        console.log("[scene] first sky pass (env mode=" + env.mode + ")");
      }
    }
  }

  pass.end();
  return true;
}

/* Resolve a single light node's params into the unified Light
 * descriptor shape used by the per-Scene uniform writer. Returns
 * null if the node isn't a recognized light type. */
function _resolveLightNode(lightNode) {
  if (!lightNode) return null;
  const p = _resolveNodeParams(lightNode);
  if (lightNode.type === "DirectionalLight") {
    const dx = (typeof p.dirX === "number") ? p.dirX : 0.3;
    const dy = (typeof p.dirY === "number") ? p.dirY : 1.0;
    const dz = (typeof p.dirZ === "number") ? p.dirZ : 0.4;
    const len = Math.hypot(dx, dy, dz) || 1.0;
    return {
      type:  0,
      pos:   [dx / len, dy / len, dz / len],
      color: [
        (typeof p.colorR === "number") ? p.colorR : 1.0,
        (typeof p.colorG === "number") ? p.colorG : 1.0,
        (typeof p.colorB === "number") ? p.colorB : 1.0
      ],
      intensity: (typeof p.intensity === "number") ? p.intensity : 1.0,
      range:     0,
      cosInner:  1.0,
      cosOuter:  1.0,
      spotDir:   [0, -1, 0]
    };
  }
  if (lightNode.type === "PointLight") {
    return {
      type:  1,
      pos:   [
        (typeof p.posX === "number") ? p.posX : 0,
        (typeof p.posY === "number") ? p.posY : 2,
        (typeof p.posZ === "number") ? p.posZ : 2
      ],
      color: [
        (typeof p.colorR === "number") ? p.colorR : 1.0,
        (typeof p.colorG === "number") ? p.colorG : 1.0,
        (typeof p.colorB === "number") ? p.colorB : 1.0
      ],
      intensity: (typeof p.intensity === "number") ? p.intensity : 1.5,
      range:     (typeof p.range === "number") ? p.range : 8.0,
      cosInner:  1.0,
      cosOuter:  1.0,
      spotDir:   [0, -1, 0]
    };
  }
  if (lightNode.type === "SpotLight") {
    const inDeg  = (typeof p.innerAngle === "number") ? p.innerAngle : 15;
    const outDeg = (typeof p.outerAngle === "number") ? p.outerAngle : Math.max(20, inDeg + 5);
    return {
      type:  2,
      pos:   [
        (typeof p.posX === "number") ? p.posX : 0,
        (typeof p.posY === "number") ? p.posY : 3,
        (typeof p.posZ === "number") ? p.posZ : 0
      ],
      color: [
        (typeof p.colorR === "number") ? p.colorR : 1.0,
        (typeof p.colorG === "number") ? p.colorG : 1.0,
        (typeof p.colorB === "number") ? p.colorB : 0.95
      ],
      intensity: (typeof p.intensity === "number") ? p.intensity : 2.0,
      range:     (typeof p.range === "number") ? p.range : 12.0,
      // Pre-compute cos(half-angle) here so the WGSL doesn't have to.
      // Half-angles convert deg -> rad first.
      cosInner: Math.cos(inDeg  * Math.PI / 180.0),
      cosOuter: Math.cos(outDeg * Math.PI / 180.0),
      spotDir: [
        (typeof p.dirX === "number") ? p.dirX : 0,
        (typeof p.dirY === "number") ? p.dirY : -1,
        (typeof p.dirZ === "number") ? p.dirZ : 0
      ]
    };
  }
  if (lightNode.type === "Sun") {
    // 7.5.4.c-polish -- Sun emits SUNLIGHT by day, MOONLIGHT by
    // night. _sunColorFromElevation returns isNight=true when sun
    // is below horizon (cool-blue, low intensity); the moon is
    // opposite the sun, so we flip the direction so the light
    // comes FROM the moon's position. This way the scene never
    // goes pitch dark just because the sun set.
    const t = (typeof p.timeOfDay === "number") ? p.timeOfDay : 0.5;
    const sunDir = _sunDirFromTime(t);
    const sc = _sunColorFromElevation(sunDir[1]);
    const tint = {
      r: (typeof p.tintR === "number") ? p.tintR : 1.0,
      g: (typeof p.tintG === "number") ? p.tintG : 1.0,
      b: (typeof p.tintB === "number") ? p.tintB : 1.0
    };
    const lightDir = sc.isNight
      ? [-sunDir[0], -sunDir[1], -sunDir[2]]
      : sunDir;
    return {
      type:  0,
      pos:   lightDir,
      color: [sc.r * tint.r, sc.g * tint.g, sc.b * tint.b],
      intensity: sc.intensity * ((typeof p.intensityScale === "number") ? p.intensityScale : 1.0),
      range:    0,
      cosInner: 1.0,
      cosOuter: 1.0,
      spotDir:  [0, -1, 0]
    };
  }
  if (lightNode.type === "AreaLight") {
    // 7.5.6.h -- raster Scene has no shadow-ray equivalent, so we
    // degrade the area light to a single PointLight at the panel
    // center. Same color + intensity. Cos_light and 1/r^2 area-MC
    // weight aren't expressible here, but the visual result (a soft
    // fill from that direction) is close enough that swapping between
    // Scene and RayTracedScene doesn't black out.
    return {
      type:  1,  // point
      pos:   [
        (typeof p.posX === "number") ? p.posX : 0,
        (typeof p.posY === "number") ? p.posY : 3,
        (typeof p.posZ === "number") ? p.posZ : 0
      ],
      color: [
        (typeof p.colorR === "number") ? p.colorR : 1.0,
        (typeof p.colorG === "number") ? p.colorG : 0.97,
        (typeof p.colorB === "number") ? p.colorB : 0.92
      ],
      intensity: (typeof p.intensity === "number") ? p.intensity : 4.0,
      range:     20.0,
      cosInner:  1.0,
      cosOuter:  1.0,
      spotDir:   [0, -1, 0]
    };
  }
  return null;
}

/* Resolve all of a Scene's light* inputs (light1..light4). Returns
 * an array of light descriptors. Falls back to a single default
 * directional light when nothing is wired so meshes don't render
 * pitch-black. Per-frame cache via Visual._frameLightCache. */
/* Sprint 7.5.4.c -- shared math for sun direction + sun light
 * color. Used by Sun (the light node), ProceduralSky (the env
 * source), and DayNightCycle's diagnostic output. Keeping it here
 * means the Sun's DirectionalLight color matches the sun-disk
 * color rendered into the env exactly. timeOfDay convention:
 *   0.00 = midnight (sun straight down, well below horizon)
 *   0.25 = sunrise   (sun at the +X horizon)
 *   0.50 = noon      (sun overhead, slightly +Z tilt)
 *   0.75 = sunset    (sun at the -X horizon)
 * The +Z tilt is cosmetic -- a perfectly polar arc looks flat. */
function _sunDirFromTime(t) {
  const wrapped = ((t % 1) + 1) % 1;        // wrap to [0, 1)
  // On the spherical planet, world +Y is the NORTH POLE; the local up
  // at the equator (where the demo camera lands) is radial-outward,
  // NOT +Y. So the sun must arc in the EQUATORIAL plane (XZ), with
  // a small +Y tilt for axial-tilt cosmetics. The old XY-plane sweep
  // made the sun visibly traverse north-to-south because +Y is the
  // polar axis on a sphere.
  const planetMode = !!(typeof state !== "undefined"
    && state && Array.isArray(state.nodes)
    && state.nodes.some(n => n && (n.type === "Planet" || n.type === "PlanetMesh")));
  if (planetMode) {
    // t=0.5 (noon)    → +X    (up for the demo cam)
    // t=0.25 (sunrise)→ +Z    (east tangent)
    // t=0.75 (sunset) → -Z    (west tangent)
    // t=0 / t=1       → -X    (below horizon — night)
    const theta = (0.5 - wrapped) * Math.PI * 2;
    const sx = Math.cos(theta);
    const sz = Math.sin(theta);
    const sy = 0.30;                  // ~17° axial-tilt cosmetic
    const len = Math.hypot(sx, sy, sz) || 1.0;
    return [sx / len, sy / len, sz / len];
  }
  // Legacy flat-terrain mode kept verbatim: scene up = +Y, so a sun
  // arc in the XY plane gives the expected zenith pass.
  const theta = (wrapped - 0.25) * Math.PI * 2;
  const sx = Math.cos(theta);
  const sy = Math.sin(theta);
  const sz = 0.3;
  const len = Math.hypot(sx, sy, sz) || 1.0;
  return [sx / len, sy / len, sz / len];
}

/* Sprint 7.5.4.c -- celestial light: sun color + intensity from
 * elevation, with moonlight at night. elev is the Y of normalized
 * sunDir (= sin of altitude angle); +1 = zenith, 0 = horizon,
 * -1 = nadir.
 *
 * Above horizon (sun visible): color reddens at horizon (Beer-
 * Lambert through more atmosphere), intensity ramps with elevation.
 * Below horizon (sun set): emit MOONLIGHT instead -- soft cool-blue
 * from the opposite direction (caller flips dir). This way Sun.light
 * still illuminates the scene at night, just dimmer + cooler.
 *
 * MATCHES the sun-disk color the WGSL sample_procedural_sky_features
 * generates, so the Sun DirectionalLight visually agrees with the
 * disk that shows in the sky. */
function _sunColorFromElevation(elev) {
  if (elev <= 0) {
    // Night: moonlight. The caller (_resolveLightNode / _rtExtract-
    // Light for Sun) will INVERT the direction so the moonlight
    // comes from the moon's position (opposite the sun). Soft cool-
    // blue, ~5-8% of daylight intensity (real moonlight is ~0.1%,
    // but at that brightness PBR scenes go pitch dark; tuned up).
    const moonRamp = Math.min(1, -elev / 0.4);
    return {
      r: 0.55,
      g: 0.65,
      b: 0.95,
      intensity: 0.03 + 0.05 * moonRamp,
      visibility: 0,
      isNight: true
    };
  }
  // Day: sunlight. Sunset (low elev) -> warm red. Noon -> neutral.
  const s = Math.min(1, elev / 0.35);
  return {
    r: 1.0,
    g: 0.55 + 0.40 * s,
    b: 0.25 + 0.65 * s,
    intensity: 0.50 + 0.75 * s,
    visibility: Math.min(1, elev / 0.18),
    isNight: false
  };
}

/* Sprint 7.5.4 -- resolve the Scene's wired environment input.
 * Returns the descriptor the per-Scene uniform writer packs into
 * the env vec4s, or null when nothing is wired (= shader falls
 * back to hardcoded hemisphere-IBL). The structure mirrors what
 * sample_env() in WGSL expects:
 *   { mode, intensity, turbidity, mieG, sky, horizon, ground, sun }
 * sun = [x, y, z, visibility]; only used by mode 2 (ProceduralSky).
 * Future modes (Skybox, HDRI) will return higher mode numbers
 * + possibly resolved-texture handles. */
function _resolveSceneEnvironment(sceneNode) {
  const wire = state.edges && state.edges.find(e =>
    e && e.to && e.to.node === sceneNode.id && e.to.port === "environment"
  );
  if (!wire || !wire.from) return null;
  const src = state.nodes.find(n => n && n.id === wire.from.node);
  if (!src) return null;
  const p = _resolveNodeParams(src);
  const num = (v, d) => (typeof v === "number" ? v : d);
  if (src.type === "GradientSky") {
    return {
      mode: 1,
      intensity: num(p.intensity, 1.0),
      sky:     [num(p.skyR, 0.55),     num(p.skyG, 0.65),     num(p.skyB, 0.85)],
      horizon: [num(p.horizonR, 0.78), num(p.horizonG, 0.80), num(p.horizonB, 0.85)],
      ground:  [num(p.groundR, 0.18),  num(p.groundG, 0.16),  num(p.groundB, 0.14)]
    };
  }
  if (src.type === "ProceduralSky") {
    const t = num(p.timeOfDay, 0.5);
    const sunDir = _sunDirFromTime(t);
    const sunColor = _sunColorFromElevation(sunDir[1]);
    // 7.5.4.c-polish -- pack moonPhase into envSky.w (unused slot
    // when mode=2 since GradientSky's sky colors are ignored for
    // ProceduralSky). Shader reads uS.envSky.w as moon lit-fraction.
    // 7.5.4.d -- cloud params + wind offsets (= speed × elapsed s).
    const elapsed = (typeof performance !== "undefined")
      ? performance.now() * 0.001 : 0;
    const windX = num(p.windSpeedX, 0.0) * elapsed;
    const windZ = num(p.windSpeedZ, 0.0) * elapsed;
    return {
      mode: 2,
      intensity: num(p.intensity, 1.0),
      turbidity: num(p.turbidity, 1.0),
      mieG:      num(p.mieG, 0.76),
      sky: [0, 0, 0, Math.max(0, Math.min(1, num(p.moonPhase, 0.5)))],
      sun: [sunDir[0], sunDir[1], sunDir[2], sunColor.visibility],
      cloud: [
        Math.max(0, Math.min(1, num(p.cloudCoverage, 0.0))),
        Math.max(0, num(p.cloudDensity, 1.0)),
        windX,
        windZ
      ]
    };
  }
  if (src.type === "HDRI" || src.type === "Skybox") {
    // 7.5.4.b -- equirectangular HDR/LDR. The preset string maps
    // to a URL in assets/hdri/. Loading is async + cached; first
    // resolution kicks off the fetch and falls back to mode 0
    // (hardcoded hemisphere) until the texture is uploaded. Next
    // frame after upload picks up mode 3.
    // A.5 -- an explicit `url` (server:/asset:/http) wins over the
    // bundled preset. _resolveGLBUrl handles the server-asset scheme.
    let url = null;
    const rawUrl = (typeof p.url === "string") ? p.url.trim() : "";
    if (rawUrl) {
      url = (typeof _resolveGLBUrl === "function") ? _resolveGLBUrl(rawUrl) : (/^https?:/.test(rawUrl) ? rawUrl : null);
    } else {
      const preset = (typeof p.preset === "string") ? p.preset : "table-mountain";
      url = _hdriPresetUrl(preset);
    }
    if (!url) return null;
    const cached = Visual._hdriCache && Visual._hdriCache.get(url);
    if (cached && cached.__loaded) {
      // Make sure the global env texture matches this preset.
      _applyHdriToEnvTexture(cached.__data, url);
      return {
        mode: 3,
        intensity: num(p.intensity, 1.0)
      };
    }
    // Kick off the load (idempotent via the cache promise) and
    // mark loaded when it resolves.
    _loadHdri(url).then(data => {
      const promiseEntry = Visual._hdriCache.get(url);
      // Promote the cache entry from "promise" to "loaded data" so
      // the next resolve hits the fast path. Attach the data onto
      // the promise to survive any external consumers still
      // awaiting it.
      promiseEntry.__loaded = true;
      promiseEntry.__data = data;
    }).catch(e => {
      console.warn("[hdri] failed to load " + url + ":", e);
    });
    // Not yet ready -- render with hemisphere fallback. Next frame
    // (after the async load resolves) will switch to mode 3.
    return null;
  }
  return null;
}

/* Sprint 7.5.4.b -- map an HDRI preset name to a URL relative to
 * the editor's hosting origin. Edit here + the HDRI node's
 * paramOptions entries to add presets. */
function _hdriPresetUrl(presetName) {
  const map = {
    "table-mountain": "./assets/hdri/table_mountain_1_puresky_4k.hdr"
  };
  return map[presetName] || null;
}

function _resolveSceneLights(sceneNode) {
  if (!Visual._frameLightCache) Visual._frameLightCache = new Map();
  const lights = [];
  const portNames = ["light1", "light2", "light3", "light4"];
  for (const portName of portNames) {
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === sceneNode.id && e.to.port === portName
    );
    if (!wire || !wire.from) continue;
    let resolved = Visual._frameLightCache.get(wire.from.node);
    if (!resolved) {
      const src = state.nodes.find(n => n && n.id === wire.from.node);
      resolved = _resolveLightNode(src);
      if (resolved) Visual._frameLightCache.set(wire.from.node, resolved);
    }
    if (resolved) lights.push(resolved);
  }
  if (lights.length === 0) {
    // Default warm-white directional from above-front so PhongMat /
    // PBR scenes with no light wired don't go pitch-black.
    lights.push({
      type:  0,
      pos:   [0.3 / 1.118, 1.0 / 1.118, 0.4 / 1.118],
      color: [1.0, 0.98, 0.92],
      intensity: 1.0,
      range:     0,
      cosInner:  1.0,
      cosOuter:  1.0,
      spotDir:   [0, -1, 0]
    });
  }
  return lights;
}

/* =========================================================================
 * Sprint 7.5.6.a part 2d -- RayTracedScene encoder + WebSocket client
 *
 * Per-RayTracedScene-node state:
 *   { ws, status, width, height, texture, textureView, bindGroup,
 *     pendingFrame (Uint8Array | null), frameCount, lastFrameAt,
 *     error (string | null) }
 *
 * Lifecycle:
 *   1. First _ensureRtSceneInstance call allocates the state +
 *      opens a WebSocket to ${localServerEndpoint}/rt.
 *   2. On WS open, sends {hello} + {render-start} (with the
 *      compile-server probing the engine in the middle).
 *   3. Engine replies with frame-config message; editor allocates
 *      a GPUTexture at the matching dims + a bind group.
 *   4. Binary messages arrive at ~30 fps with raw RGBA8 pixel data;
 *      we stash the latest as `pendingFrame` (overwriting any older
 *      one -- we only ever display the freshest).
 *   5. _encodeRtScenePass on each render frame: if pendingFrame,
 *      queue.writeTexture into the GPUTexture; then blit the
 *      texture to the assigned framebuffer/scratch layer via a
 *      dedicated fullscreen-triangle pipeline.
 *
 * Cleanup happens in _disposeShaderInstance when a RayTracedScene
 * node is removed from the patch -- closes the WS + destroys the
 * texture. */

const _RT_BLIT_WGSL = `
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  return textureSampleLevel(srcTex, srcSampler, in.uv, 0.0);
}
`;

function _ensureRtBlitPipeline() {
  if (Visual._rtBlitPipeline) return Visual._rtBlitPipeline;
  if (!Visual.device) return null;
  Visual._rtBlitBgl = Visual.device.createBindGroupLayout({
    label: "rt-blit-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" } }
    ]
  });
  const layout = Visual.device.createPipelineLayout({
    label: "rt-blit-pl",
    bindGroupLayouts: [Visual._rtBlitBgl]
  });
  const module = Visual.device.createShaderModule({
    label: "rt-blit-shader",
    code: _RT_BLIT_WGSL
  });
  Visual._rtBlitPipeline = Visual.device.createRenderPipeline({
    label: "rt-blit-pipeline",
    layout,
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module, entryPoint: "fs_main",
      targets: [{ format: Visual.fbFormat }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" }
  });
  Visual._rtBlitSampler = Visual.device.createSampler({
    label: "rt-blit-sampler",
    magFilter: "linear", minFilter: "linear",
    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge"
  });
  console.log("[rt-scene] blit pipeline built");
  return Visual._rtBlitPipeline;
}

function _ensureRtSceneInstance(node) {
  if (!Visual.rtSceneInstances) Visual.rtSceneInstances = new Map();
  let inst = Visual.rtSceneInstances.get(node.id);
  if (inst) return inst;
  if (!Visual.device) return null;
  inst = {
    status: "idle",
    ws: null,
    width: 0, height: 0,
    texture: null, textureView: null, bindGroup: null,
    pendingFrame: null,
    frameCount: 0,
    lastFrameAt: 0,
    error: null,
    reconnectTimer: null,
    // Sprint 7.5.6.a part 2e-2 + 7.5.6.c-1 -- three-tier live
    // update tracking. Each render tick re-derives these from the
    // current graph state:
    //   * lastSceneSig       -- structural (mesh wiring + material
    //                           wiring + light wiring + mesh geometry
    //                           params). Change triggers full Scene
    //                           replace + AS rebuild on the engine.
    //   * lastMaterialsJson  -- packed materials array. Change ->
    //                           Params(materials); engine patches
    //                           material_buffer in place. Catches
    //                           live PhongMat / PhysicalMat slider
    //                           drags without churning the BVH.
    //   * lastLightsJson     -- packed lights array. Change ->
    //                           Params(lights); engine patches
    //                           lights_buffer in place.
    //   * lastCameraJson     -- packed camera. Change -> Params(camera);
    //                           engine patches camera_buffer.
    lastCameraJson: null,
    lastLightsJson: null,
    lastMaterialsJson: null,
    lastSceneSig: null,
    lastClearSig: null
  };
  Visual.rtSceneInstances.set(node.id, inst);
  _rtSceneConnect(node.id, inst);
  return inst;
}

/* Sprint 7.5.6.a part 2e-1 -- serialize the editor's RayTracedScene
 * node state into the JSON shape the engine's `scene` IPC message
 * expects (mirrors scene.rs in the gamma-compile-server repo).
 *
 * Option (a) materials: per-mesh flat RGB color, derived as the
 * average of the upstream mesh's per-vertex colors. No PBR fields,
 * no lights, no environment. Transforms identity for 2e-1 -- wire-
 * based Translate/Rotate/Scale composition lands in 2e-2.
 *
 * Returns a Scene-shaped object ready for JSON.stringify. Always
 * succeeds (returns an empty meshes[] if nothing wired). */
function _rtBuildSceneJson(rtNode) {
  const meshes = [];
  // Walk mesh1..mesh4 inputs; collect each mesh node plus any
  // material node wired between mesh and RayTracedScene (so a chain
  // like Sphere → PhysicalMat → RT.mesh1 sends PBR params to the
  // engine instead of an Unlit fallback).
  for (let i = 1; i <= 4; i++) {
    const portName = "mesh" + i;
    const found = _rtFindUpstreamMeshAndMaterial(rtNode.id, portName);
    if (!found) continue;
    const { mesh: meshNode, material: matNode, transform } = found;
    const data = _buildMeshData(meshNode);
    if (!data) continue;
    const stride = 11;
    const verts = Array.from(data.verts);
    const indices = data.indices ? Array.from(data.indices) : null;
    // Material wiring + fallback (c-2): real material params if a
    // material node is in the chain, else Phong with the mesh's
    // average per-vertex color so unmaterialed meshes stay shaded.
    let material = matNode ? _rtExtractMaterial(matNode) : null;
    if (!material) {
      material = {
        type: "phong",
        color: _rtMeshAverageColor(data.verts, stride),
        shininess: 32,
        ambient: 0.15
      };
    }
    meshes.push({
      geometry: {
        kind: "inline",
        vertices: verts,
        indices: indices,
        stride: stride
      },
      // Sprint 7.5.6.a part 2e-2 -- composed Translate/Rotate/Scale
      // matrix from the wire chain. Engine applies this CPU-side
      // to vertex positions during AS build (and to normals via
      // the upper-3×3 path, sufficient for rotation/uniform-scale).
      transform: Array.from(transform),
      material
    });
  }

  // Camera input -- if a Camera node is wired, pull its pose. Else
  // default to the same eye/target as the engine's --render-test path.
  const camNode = _rtFindUpstreamByPort(rtNode.id, "camera");
  const camera = camNode ? _rtExtractCamera(camNode) : {
    mode: "perspective",
    pos: [0, 0, 2],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fov_deg: 60,
    near: 0.1,
    far: 100
  };

  // Sprint 7.5.6.c-1: light1..light4 inputs. Walk each, pack into
  // the scene's lights[] array if the upstream node is a light type
  // we recognize. Engine ignores types it can't render in c-1
  // (point / spot / area). Empty lights array → engine synthesizes
  // a default sunlit angle so shaded materials still look right.
  const lights = [];
  for (let i = 1; i <= 4; i++) {
    const ln = _rtFindUpstreamByPort(rtNode.id, "light" + i);
    if (!ln) continue;
    const packed = _rtExtractLight(ln);
    if (packed) lights.push(packed);
  }

  const p = rtNode.params || {};
  const num = (v, d) => (typeof v === "number" ? v : d);
  return {
    camera,
    meshes,
    lights,
    clear_color: [num(p.clearR, 0.05), num(p.clearG, 0.06), num(p.clearB, 0.10)]
  };
}

/* Sprint 7.5.6.c-1 -- pack one light node into the wire format the
 * engine's scene.rs Light enum expects. Returns null for unknown
 * node types (caller skips them). c-1 only renders Directional;
 * Point / Spot / Area get parsed into the JSON but the engine
 * silently skips them. c-2 wires up real point/spot evaluation. */
function _rtExtractLight(lightNode) {
  const p = _resolveNodeParams(lightNode);
  const num = (v, d) => (typeof v === "number" ? v : d);
  switch (lightNode.type) {
    case "DirectionalLight":
      // Editor's DirectionalLight registry: dirX/Y/Z is direction TO
      // the light (NOT direction the light shines). Defaults match
      // the registry params block so an un-touched DirectionalLight
      // gives the same lighting as the engine's no-light default.
      return {
        type: "directional",
        direction: [num(p.dirX, 0.3), num(p.dirY, 1.0), num(p.dirZ, 0.4)],
        color:     [num(p.colorR, 1.0), num(p.colorG, 0.98), num(p.colorB, 0.92)],
        intensity: num(p.intensity, 1.0)
      };
    case "PointLight":
      return {
        type: "point",
        position:  [num(p.posX, 0), num(p.posY, 2), num(p.posZ, 2)],
        color:     [num(p.colorR, 1.0), num(p.colorG, 0.95), num(p.colorB, 0.85)],
        intensity: num(p.intensity, 1.5),
        range:     num(p.range, 8.0)
      };
    case "SpotLight":
      return {
        type: "spot",
        position:  [num(p.posX, 0), num(p.posY, 3), num(p.posZ, 0)],
        direction: [num(p.dirX, 0), num(p.dirY, -1), num(p.dirZ, 0)],
        color:     [num(p.colorR, 1.0), num(p.colorG, 0.95), num(p.colorB, 0.85)],
        intensity: num(p.intensity, 2.0),
        range:     num(p.range, 8.0),
        inner_angle_deg: num(p.innerAngle, 15),
        outer_angle_deg: num(p.outerAngle, 25)
      };
    case "AreaLight":
      // 7.5.6.h -- rectangular emitter, RT-only. Engine kernel
      // samples one point on the rect per shadow ray; TDS averages
      // across primaries -> real soft shadows.
      return {
        type: "area",
        position:  [num(p.posX, 0), num(p.posY, 3), num(p.posZ, 0)],
        normal:    [num(p.dirX, 0), num(p.dirY, -1), num(p.dirZ, 0)],
        width:     num(p.width, 2.0),
        height:    num(p.height, 2.0),
        color:     [num(p.colorR, 1.0), num(p.colorG, 0.97), num(p.colorB, 0.92)],
        intensity: num(p.intensity, 4.0)
      };
    case "Sun": {
      // 7.5.4.c-polish -- emits sunlight by day, moonlight by night
      // (with direction flipped to come FROM the moon's position so
      // the scene gets cool-blue fill at night). Engine receives it
      // as a regular Light::Directional regardless of which mode.
      const t = num(p.timeOfDay, 0.5);
      const sunDir = _sunDirFromTime(t);
      const sc = _sunColorFromElevation(sunDir[1]);
      const tintR = num(p.tintR, 1.0);
      const tintG = num(p.tintG, 1.0);
      const tintB = num(p.tintB, 1.0);
      const scale = num(p.intensityScale, 1.0);
      const lightDir = sc.isNight
        ? [-sunDir[0], -sunDir[1], -sunDir[2]]
        : sunDir;
      return {
        type: "directional",
        direction: lightDir,
        color:     [sc.r * tintR, sc.g * tintG, sc.b * tintB],
        intensity: sc.intensity * scale
      };
    }
    default:
      return null;
  }
}

/* Sprint 7.5.6.a part 2e-2 -- walk the wire chain from RT.meshN
 * back to a mesh-gen node, accumulating Translate/Rotate/Scale
 * matrices AND capturing the first material in the chain. Returns
 *   { mesh, material, transform }   (transform is Float32Array[16])
 * or null if the chain doesn't resolve to a mesh-gen node.
 *
 * Chain semantics (same as the raster Scene's _walkMeshChain):
 *   leaf-gen → T_inner → T_middle → T_outer → RT
 * yields transform = T_outer · T_middle · T_inner, so inner-most
 * transforms hit vertices first. e.g.
 *   Sphere → Rotate(45y) → Translate(2,0,0) → RT
 * rotates the sphere around its own origin, THEN translates it out.
 * Reverse for "swing around the world origin":
 *   Sphere → Translate(2,0,0) → Rotate(45y) → RT
 *
 * Material: the FIRST material encountered going RT → leaf wins
 * (outermost wrapper). Same convention as the raster path. */
function _rtFindUpstreamMeshAndMaterial(rtNodeId, portName) {
  const edge = state.edges && state.edges.find(e =>
    e && e.to && e.to.node === rtNodeId && e.to.port === portName
  );
  if (!edge || !edge.from) return null;
  return _rtWalkChainUpstream(edge.from.node, _mat4Identity(), null, 0);
}

function _rtWalkChainUpstream(nodeId, accMat, accMaterial, depth) {
  if (depth > 16) return null;            // cycle guard
  const node = state.nodes.find(n => n && n.id === nodeId);
  if (!node) return null;
  const def = TYPES[node.type];
  if (!def) return null;
  if (def.kind === "mesh-gen") {
    return { mesh: node, material: accMaterial, transform: accMat };
  }
  if (def.kind === "mesh-transform") {
    const local = _buildTransformMatrix(node);
    // accMat is the RT-side accumulator; multiply local in on the
    // RIGHT so leaf-side transforms end up rightmost in the product
    // (= applied first to vertices). Matches raster _walkMeshChain.
    const next = new Float32Array(16);
    _mat4Multiply(next, accMat, local);
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "mesh"
    );
    if (!wire || !wire.from) return null;
    return _rtWalkChainUpstream(wire.from.node, next, accMaterial, depth + 1);
  }
  if (def.kind === "material") {
    // First material wins -- outermost wrapper (closest to RT).
    const myMaterial = accMaterial || node;
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "mesh"
    );
    if (!wire || !wire.from) return null;
    return _rtWalkChainUpstream(wire.from.node, accMat, myMaterial, depth + 1);
  }
  return null;
}

// Legacy wrapper -- a few call sites only need the mesh.
function _rtFindUpstreamMesh(rtNodeId, portName) {
  const r = _rtFindUpstreamMeshAndMaterial(rtNodeId, portName);
  return r ? r.mesh : null;
}

/* Sprint 7.5.6.c-2 -- pack a material node into the scene.rs
 * Material enum's JSON shape. The engine's c-2 kernel honors
 * Unlit / Phong / Pbr; ShaderMat collapses to Unlit for now
 * (matching the engine's material_to_uniform fallback). */
function _rtExtractMaterial(matNode) {
  const p = _resolveNodeParams(matNode);
  const num = (v, d) => (typeof v === "number" ? v : d);
  switch (matNode.type) {
    case "UnlitMat":
      return {
        type: "unlit",
        color: [num(p.r, 1), num(p.g, 1), num(p.b, 1)],
        vertex_mix: num(p.vertexMix, 0)
      };
    case "PhongMat":
      return {
        type: "phong",
        color: [num(p.r, 0.85), num(p.g, 0.85), num(p.b, 0.92)],
        shininess: num(p.shininess, 32),
        ambient: num(p.ambient, 0.15)
      };
    case "PhysicalMat":
      return {
        type: "pbr",
        color: [num(p.r, 0.85), num(p.g, 0.85), num(p.b, 0.85)],
        metallic: num(p.metallic, 0),
        roughness: num(p.roughness, 0.5)
      };
    case "MirrorMat":
      // scene.rs Material::Mirror uses .tint instead of .color.
      return {
        type: "mirror",
        tint: [num(p.r, 1), num(p.g, 1), num(p.b, 1)]
      };
    case "GlassMat":
      // scene.rs Material::Glass: color (= absorption tint), ior,
      // optional absorption (here we use color directly; absorption
      // could be a separate per-component density param in c-d.2).
      return {
        type: "glass",
        color: [num(p.r, 0.95), num(p.g, 0.97), num(p.b, 1.0)],
        ior: num(p.ior, 1.5),
        absorption: [0.0, 0.0, 0.0]
      };
    case "ShaderMat":
      // c-2 fallback: Slang transpile not implemented yet, so a
      // ShaderMat-wrapped mesh just renders as Unlit with whatever
      // tint params the user set.
      return {
        type: "unlit",
        color: [num(p.r, 1), num(p.g, 1), num(p.b, 1)],
        vertex_mix: 0
      };
    default:
      return null;
  }
}

/* Find a node wired into rtNode.portName regardless of type. Used
 * for the camera input. */
function _rtFindUpstreamByPort(rtNodeId, portName) {
  const edge = state.edges.find(e => e.to.node === rtNodeId && e.to.port === portName);
  if (!edge) return null;
  return state.nodes.find(n => n.id === edge.from.node) || null;
}

function _rtMeshAverageColor(verts, stride) {
  const n = verts.length / stride;
  if (n === 0) return [1, 1, 1];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) {
    r += verts[i * stride + 3];
    g += verts[i * stride + 4];
    b += verts[i * stride + 5];
  }
  return [r / n, g / n, b / n];
}

function _rtExtractCamera(camNode) {
  // Sprint 7.5.6.a part 2h -- read wired-param-resolved values, not
  // static .params. Without this, a `MasterClock → ... → Camera.posX`
  // orbit chain wouldn't update the engine (we'd see the static
  // posX=0 every frame). _resolveNodeParams is the same resolver
  // the raster Scene's _evaluateCamera uses; single source of truth.
  const p = _resolveNodeParams(camNode);
  const num = (v, d) => (typeof v === "number" ? v : d);
  return {
    mode: "perspective",
    pos: [num(p.posX, 0), num(p.posY, 0), num(p.posZ, 5)],
    target: [num(p.targetX, 0), num(p.targetY, 0), num(p.targetZ, 0)],
    up: [num(p.upX, 0), num(p.upY, 1), num(p.upZ, 0)],
    fov_deg: num(p.fov, 60),
    near: num(p.near, 0.1),
    far: num(p.far, 100)
  };
}

const _RT_DEFAULT_CAMERA = Object.freeze({
  mode: "perspective",
  pos: [0, 0, 2],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fov_deg: 60,
  near: 0.1,
  far: 100
});

// 7.5.6.h-warmup -- when the engine resets TDS history (preset
// change, scale change, reconnect) the first ~30 frames are
// intrinsically less converged than steady-state. Holding the
// previous frame for this many incoming frames hides the visual
// "noise pop" without complicating the engine. ~1s at 30fps;
// long enough for TDS to populate temporal history, short enough
// that camera/scene drift over the hold isn't visible.
const _RT_WARMUP_FRAMES = 30;

/* Sprint 7.5.6.a part 2e-2 -- structural signature for the scene.
 * Stringifies the things that, if changed, require a full Scene
 * replace + AS rebuild on the engine side: which mesh-builder node
 * is wired to each port, its geometry-affecting params (radius,
 * slices, etc -- already captured by _meshCacheKey from the raster
 * path), and which camera node is wired. Cheap to compute (one wire
 * walk per port) so per-frame polling is fine. */
function _rtComputeSceneSignature(rtNode) {
  const parts = [];
  for (let i = 1; i <= 4; i++) {
    const portName = "mesh" + i;
    const found = _rtFindUpstreamMeshAndMaterial(rtNode.id, portName);
    if (!found) {
      parts.push("-");
      continue;
    }
    const { mesh: meshNode, transform } = found;
    // Hash the transform values too -- 2e-2 transforms are baked
    // into vertex positions on the engine side, so a Translate
    // slider drag DOES need a full Scene replace + AS rebuild.
    // Rounded to 4 decimals to keep the sig string short and to
    // throttle ultra-fine slider jitter at sub-pixel scales.
    const tHash = Array.from(transform).map(v => v.toFixed(4)).join(",");
    parts.push(meshNode.id + ":" + meshNode.type +
               ":" + _meshCacheKey(meshNode) +
               ":t=" + tHash);
  }
  // Light wiring (not light params -- those flow through the
  // tier-3 Params(lights) path for cheap live updates).
  for (let i = 1; i <= 4; i++) {
    const ln = _rtFindUpstreamByPort(rtNode.id, "light" + i);
    parts.push(ln ? "l" + i + ":" + ln.id + ":" + ln.type : "l" + i + ":-");
  }
  return parts.join("|");
}

/* Sprint 7.5.6.a part 2e-2 -- per-frame poll. Called from
 * _encodeRtScenePass on every render tick the RayTracedScene is
 * actually visible. Compares the camera + scene signature against
 * what we last shipped and sends the minimal patch (Params for
 * camera-only, full Scene for structural changes). No-op when the
 * WS isn't open. */
function _rtScenePollAndSend(node, inst) {
  if (!inst.ws || inst.ws.readyState !== 1) return;

  const p = node.params || {};
  const num = (v, d) => (typeof v === "number" ? v : d);

  // Tier 0 -- displaySize / renderScale changes (f.3.g). These can't
  // be patched live; the engine has to allocate new textures + a new
  // TDS scaler at the right input/output dims. Cleanest path is to
  // close the current WS so the next render tick reconnects + ships
  // a fresh `configure` with the new values. `inst.lastConfigKey` is
  // primed in _rtSceneConnect's onopen handler after the configure
  // send, so the first poll never trips this branch.
  const dsNow = String(p.displaySize != null ? p.displaySize : "720p");
  const rsNow = String(p.renderScale != null ? p.renderScale : "native");
  const cfgKey = dsNow + "|" + rsNow;
  if (inst.lastConfigKey != null && inst.lastConfigKey !== cfgKey) {
    console.log("[rt-scene] config change " + inst.lastConfigKey +
                " -> " + cfgKey + "; reconnecting");
    try { inst.ws.close(); } catch (_) {}
    inst.lastConfigKey = cfgKey;
    return;
  }

  const clearSig = num(p.clearR, 0.05) + "," + num(p.clearG, 0.06) + "," + num(p.clearB, 0.10);

  const sceneSig = _rtComputeSceneSignature(node) + "|clr=" + clearSig;
  if (sceneSig !== inst.lastSceneSig) {
    // Structural change -- rebuild scene fully. This also resends the
    // camera + lights (they're part of the Scene payload), so prime
    // the tier-2 / tier-3 hashes to match so we don't immediately
    // re-send a redundant Params next frame.
    const sceneJson = _rtBuildSceneJson(node);
    const camJson = JSON.stringify(sceneJson.camera);
    const lightsJson = JSON.stringify(sceneJson.lights);
    const matsJson = JSON.stringify(sceneJson.meshes.map(m => m.material));
    try {
      inst.ws.send(JSON.stringify({ type: "scene", patch: sceneJson }));
      inst.lastSceneSig = sceneSig;
      inst.lastCameraJson = camJson;
      inst.lastLightsJson = lightsJson;
      inst.lastMaterialsJson = matsJson;
      console.log("[rt-scene] scene replace (sig change) — " +
                  sceneJson.meshes.length + " mesh(es), " +
                  sceneJson.lights.length + " light(s)");
    } catch (e) {
      console.warn("[rt-scene] scene send failed:", e);
    }
    return;
  }

  // Tier 2 -- materials. Same wiring, possibly drifted params
  // (PhongMat.shininess drag, PhysicalMat.metallic drag, etc).
  // Engine's update_materials patches the per-mesh material buffer
  // in place; no AS rebuild.
  const matsArr = [];
  for (let i = 1; i <= 4; i++) {
    const portName = "mesh" + i;
    const found = _rtFindUpstreamMeshAndMaterial(node.id, portName);
    if (!found) continue;
    const { mesh: meshNode, material: matNode } = found;
    const data = _buildMeshData(meshNode);
    if (!data) continue;
    let m = matNode ? _rtExtractMaterial(matNode) : null;
    if (!m) {
      // Matches the _rtBuildSceneJson default -- Phong with average
      // per-vertex color so unmaterialed meshes stay shaded.
      m = {
        type: "phong",
        color: _rtMeshAverageColor(data.verts, 11),
        shininess: 32,
        ambient: 0.15
      };
    }
    matsArr.push(m);
  }
  const matsJson = JSON.stringify(matsArr);
  if (matsJson !== inst.lastMaterialsJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { materials: matsArr } }));
      inst.lastMaterialsJson = matsJson;
    } catch (e) {
      console.warn("[rt-scene] materials params send failed:", e);
    }
  }

  // Tier 3 -- lights. Same wiring as last send, but the light
  // node's params may have moved (slider drag on intensity/hue).
  // Catches that without rebuilding the AS.
  const lightsArr = [];
  for (let i = 1; i <= 4; i++) {
    const ln = _rtFindUpstreamByPort(node.id, "light" + i);
    if (!ln) continue;
    const packed = _rtExtractLight(ln);
    if (packed) lightsArr.push(packed);
  }
  const lightsJson = JSON.stringify(lightsArr);
  if (lightsJson !== inst.lastLightsJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { lights: lightsArr } }));
      inst.lastLightsJson = lightsJson;
    } catch (e) {
      console.warn("[rt-scene] lights params send failed:", e);
    }
  }

  // Tier 4 -- camera. Cheap stringify-compare on the camera node's
  // resolved params. Fires on every slider drag / clock-driven orbit
  // tick that moves the camera.
  const camNode = _rtFindUpstreamByPort(node.id, "camera");
  const camObj = camNode ? _rtExtractCamera(camNode) : _RT_DEFAULT_CAMERA;
  const camJson = JSON.stringify(camObj);
  if (camJson !== inst.lastCameraJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { camera: camObj } }));
      inst.lastCameraJson = camJson;
    } catch (e) {
      console.warn("[rt-scene] camera params send failed:", e);
    }
  }

  // Tier 5 -- quality. Sprint 7.5.6.f.3.d. The `quality` preset is
  // the user's primary noise/detail dial; presets match the spec
  // in docs/RAYTRACING.md §5.6.g:
  //   draft    1 spp, 2 bounces   (cheapest, intentionally grainy)
  //   preview  4 spp, 4 bounces   (denoised, "looks ok in motion")
  //   final   16 spp, 8 bounces   (multi-bounce, denoised, render-grade)
  // Extra spp at higher presets targets edge / disocclusion noise
  // that MetalFX TDS history validation can't clear on its own (see
  // docs/RAYTRACING.md §5.6.f for the TDS aux-texture requirements).
  //
  // `samples` / `bounces` params act as explicit overrides: 0 = follow
  // preset, non-zero = pin. spp clamped to [1, 16], bounces to [1, 8].
  // Changing either resets path-tracing accumulation engine-side.
  const QUALITY_PRESETS = [
    { spp:  1, bounces: 2 }, // 0 draft
    { spp:  4, bounces: 4 }, // 1 preview (default)
    { spp: 16, bounces: 8 }, // 2 final
  ];
  // f.3.d-fix7 -- accept `quality` as either a string ("draft" /
  // "preview" / "final") or a number (0 / 1 / 2). The registry's
  // paramOptions dropdown writes the STRING form on user change
  // (matches every other paramOptions node in the codebase); loaded
  // .gpatch files + demo initializers may use the numeric form.
  // Both must resolve to the same preset index, or toggling the
  // dropdown silently no-ops (which is exactly what fix6 shipped --
  // num(string, 1) falls back to 1, preview pinned forever).
  const QUALITY_KEYS = ["draft", "preview", "final"];
  let qIdx;
  if (typeof p.quality === "string") {
    qIdx = QUALITY_KEYS.indexOf(p.quality);
    if (qIdx < 0) qIdx = 1; // unknown string -> preview
  } else {
    qIdx = Math.max(0, Math.min(2, Math.round(num(p.quality, 1))));
  }
  const preset = QUALITY_PRESETS[qIdx];
  const sppOverride = Math.round(num(p.samples, 0));
  const bouncesOverride = Math.round(num(p.bounces, 0));
  const qSpp = Math.max(1, Math.min(16, sppOverride || preset.spp));
  const qBounces = Math.max(1, Math.min(8, bouncesOverride || preset.bounces));
  const qObj = { spp: qSpp, bounces: qBounces };
  const qJson = JSON.stringify(qObj);
  if (qJson !== inst.lastQualityJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { quality: qObj } }));
      // 7.5.6.h-warmup -- a real preset/spp/bounces change resets
      // accumulation engine-side (set_spp / set_bounces both call
      // reset_accumulation, plus TDS gets set_reset on frame_count
      // == 0). Hide the warmup pop by holding the previous frame
      // until TDS history rebuilds. Only fires when there's a
      // PREVIOUS quality value (lastQualityJson != null), so the
      // very first send after connect doesn't trigger this.
      if (inst.lastQualityJson !== null && inst.heldFrame) {
        inst.warmupFramesRemaining = _RT_WARMUP_FRAMES;
      }
      inst.lastQualityJson = qJson;
    } catch (e) {
      console.warn("[rt-scene] quality params send failed:", e);
    }
  }

  // Tier 6 -- environment (5.4-rt). Mirror the raster Scene's env
  // uniform (8 vec4s: mode/intensity/turbidity/mieG + sky/horizon/
  // ground + sun + cloud/fog) to the engine so RayTracedScene shows
  // ProceduralSky / GradientSky / clouds / fog identical to what the
  // raster Scene does. Engine kernel reads these from PathState
  // and dispatches sample_env_smooth/full + apply_fog accordingly.
  // HDRI (mode 3) intentionally not supported in this first pass --
  // engine doesn't yet have an env texture binding.
  // Also pulls Scene fog params (fogDensity etc.) since fog lives
  // on the Scene node, not the env source.
  const envRT = _rtBuildEnvWire(node);
  const envJson = JSON.stringify(envRT);
  if (envJson !== inst.lastEnvJson) {
    try {
      inst.ws.send(JSON.stringify({ type: "params", patch: { env: envRT } }));
      inst.lastEnvJson = envJson;
    } catch (e) {
      console.warn("[rt-scene] env params send failed:", e);
    }
  }
}

/* Sprint 5.4-rt -- build the 8-vec4 wire env payload from the
 * RayTracedScene node's wired environment + Scene-level fog params.
 * Engine's set_env() reads these by key (params/sky/horizon/ground/
 * sun/cloudParams/fogParams/fogColor). Missing keys keep the engine
 * defaults (mode 0 = hemisphere fallback). */
function _rtBuildEnvWire(rtNode) {
  // Find the wired environment source via the RayTracedScene's
  // `environment` input port. Resolve into the same descriptor
  // shape the raster Scene uses, so the same math lands engine-side.
  const sceneLike = { id: rtNode.id };
  // Reuse the raster Scene's env resolver. It looks at
  // state.edges where to.node = rtNode.id + to.port = "environment".
  // RayTracedScene has the same port name + type, so this works.
  const env = _resolveSceneEnvironment(rtNode);
  // Pull RayTracedScene's own fog params (Scene + RayTracedScene
  // both expose fogDensity/Start/Height/Auto + fogR/G/B as params).
  const p = _resolveNodeParams(rtNode);
  const num = (v, d) => (typeof v === "number" ? v : d);

  if (!env) {
    return {
      params:      [0, 1, 1, 0.76],
      sky:         [0, 0, 0, 0],
      horizon:     [0, 0, 0, 0],
      ground:      [0, 0, 0, 0],
      sun:         [0, 1, 0, 0],
      cloudParams: [0, 0, 0, 0],
      fogParams:   [num(p.fogDensity, 0), num(p.fogStart, 5),
                    num(p.fogHeight, 0),  num(p.fogAuto, 1)],
      fogColor:    [num(p.fogR, 0.65), num(p.fogG, 0.70), num(p.fogB, 0.78), 0]
    };
  }
  const sky     = env.sky     || [0, 0, 0, 0];
  const horizon = env.horizon || [0, 0, 0, 0];
  const ground  = env.ground  || [0, 0, 0, 0];
  const sun     = env.sun     || [0, 1, 0, 0];
  const cloud   = env.cloud   || [0, 0, 0, 0];
  return {
    params: [
      (typeof env.mode === "number") ? env.mode : 0,
      (typeof env.intensity === "number") ? env.intensity : 1,
      (typeof env.turbidity === "number") ? env.turbidity : 1,
      (typeof env.mieG === "number") ? env.mieG : 0.76
    ],
    sky:     [sky[0]||0, sky[1]||0, sky[2]||0, sky[3]||0],
    horizon: [horizon[0]||0, horizon[1]||0, horizon[2]||0, horizon[3]||0],
    ground:  [ground[0]||0, ground[1]||0, ground[2]||0, ground[3]||0],
    sun:     [sun[0]||0, sun[1]||0, sun[2]||0, sun[3]||0],
    cloudParams: [cloud[0]||0, cloud[1]||0, cloud[2]||0, cloud[3]||0],
    fogParams:   [num(p.fogDensity, 0), num(p.fogStart, 5),
                  num(p.fogHeight, 0),  num(p.fogAuto, 1)],
    fogColor:    [num(p.fogR, 0.65), num(p.fogG, 0.70), num(p.fogB, 0.78), 0]
  };
}

async function _rtSceneConnect(nodeId, inst) {
  if (inst.ws && inst.ws.readyState <= 1) return;
  inst.status = "connecting";
  await probeLocalServer();
  if (!localServerEndpoint) {
    inst.status = "no-server";
    inst.error = "compile-server not detected; start gamma-compile-server locally";
    console.warn("[rt-scene] no compile-server at first probe -- will retry on next render");
    return;
  }
  // Sprint 7.5.6.a part 2d-direct: bypass the /rt proxy on the
  // compile-server and connect straight to the engine. After four
  // proxy iterations Chrome reproducibly closes the browser-side
  // socket 1-2ms after onopen with "Invalid frame header" -- the
  // exact same symptom appeared with ws.WebSocketServer-based
  // proxy AND raw TCP forward AND manual split-handshake. Meanwhile
  // direct connections to ws://127.0.0.1:9100/ work end-to-end (
  // verified via scripts/test-engine-ws.mjs in the compile-server
  // repo).
  //
  // Chrome's mixed-content policy explicitly allows ws:// to
  // loopback addresses from https origins (the same exception that
  // makes localhost dev viable from gh-pages). So we read the
  // engine port from /health (already cached in _rtEngineState)
  // and connect there directly. The compile-server proxy is left
  // in place for a future production path where the engine isn't
  // on the same machine -- can be re-enabled by setting
  // localStorage["gamma-rt-via-proxy"] = "1".
  const engineInfo = _rtEngineState && _rtEngineState.serverInfo;
  const enginePort = engineInfo && engineInfo.enginePort;
  const useProxy = (typeof localStorage !== "undefined") &&
                   localStorage.getItem("gamma-rt-via-proxy") === "1";
  let wsUrl;
  if (!useProxy && enginePort) {
    wsUrl = "ws://127.0.0.1:" + enginePort + "/";
  } else {
    wsUrl = localServerEndpoint.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/rt";
  }
  console.log("[rt-scene] connecting to " + wsUrl + " (useProxy=" + useProxy + ")");
  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch (e) {
    inst.status = "error";
    inst.error = "WebSocket ctor: " + e.message;
    return;
  }
  ws.binaryType = "arraybuffer";
  inst.ws = ws;
  ws.onopen = () => {
    inst.status = "connected";
    inst.error = null;
    console.log("[rt-scene] connected for node " + nodeId);
    // Reset send-tracking so the next poll fires a fresh scene
    // (the lastSceneSig=null branch ships scene + camera + lights
    // + materials in one Scene message and primes all four trackers).
    inst.lastSceneSig = null;
    inst.lastCameraJson = null;
    inst.lastLightsJson = null;
    inst.lastMaterialsJson = null;
    inst.lastQualityJson = null;
    inst.lastEnvJson = null;
    try {
      ws.send(JSON.stringify({ type: "hello" }));

      // f.3.f-prep -- read display dims + render scale from the
      // RayTracedScene node's params so the engine allocates at the
      // requested output resolution. renderScale is the fraction of
      // displaySize the kernel will shade (next-sprint TDS upscale
      // path); the engine logs it but doesn't honor it yet. Applies
      // at WS-connect time only -- live re-configure on param
      // change lands with the upscale wiring.
      const node = state.nodes.find(n => n.id === nodeId);
      const DISPLAY_SIZES = {
        "480p":  [854,  480],
        "600p":  [800,  600],
        "720p":  [1280, 720],
        "900p":  [1600, 900],
        "1080p": [1920, 1080]
      };
      const RENDER_SCALES = {
        "native":      1.0,
        "quality":     0.75,
        "balanced":    0.66,
        "performance": 0.5,
        // f.3.g-fix1 -- Apple's MetalFX TDS caps the upscale ratio
        // at 3x per axis. 0.33 (= 3.03x) put TDS just over the limit,
        // causing it to refuse the descriptor; the engine then fell
        // back to the spatial denoiser (visibly noisier; plus a pre-
        // fix1 rebuild-loop dropped scene state -> black screen).
        // 0.35 = ~2.86x stays safely inside the cap at every
        // displaySize the dropdown offers.
        "ultra":       0.35
      };
      const ds = (node && node.params && node.params.displaySize) || "720p";
      const rs = (node && node.params && node.params.renderScale) || "native";
      const [dispW, dispH] = DISPLAY_SIZES[ds] || DISPLAY_SIZES["720p"];
      const rsFloat = RENDER_SCALES[rs] != null ? RENDER_SCALES[rs] : 1.0;
      ws.send(JSON.stringify({
        type: "configure",
        width: dispW,
        height: dispH,
        renderScale: rsFloat
      }));
      console.log("[rt-scene] configure: " + ds + " (" + dispW + "x" + dispH +
                  ")  renderScale=" + rs + " (" + rsFloat + ")");
      // f.3.g -- prime the Tier-0 reconnect-on-change tracker.
      // Subsequent polls compare current ds/rs against this key and
      // close the WS when it drifts (triggers reconnect with the new
      // configure values).
      inst.lastConfigKey = ds + "|" + rs;

      // 7.5.6.h-warmup -- if we had a previous session whose last
      // frame is still in memory, hide TDS warmup by displaying the
      // held frame for the first WARMUP_FRAMES we receive on this
      // new connection. _rtSceneAllocateTexture clears heldFrame
      // when dims change, so a displaySize change correctly falls
      // through to "no held -> show new frames immediately."
      if (inst.heldFrame) {
        inst.warmupFramesRemaining = _RT_WARMUP_FRAMES;
        console.log("[rt-scene] warmup-hide: holding previous frame for " +
                    _RT_WARMUP_FRAMES + " frames after reconnect");
      }

      // Sprint 7.5.6.a part 2e-2: route the initial scene send
      // through the poll function so the diff-tracking state stays
      // consistent. Sends a Scene message (the lastSceneSig=null
      // forces the "structural change" branch).
      if (node) {
        _rtScenePollAndSend(node, inst);
      } else {
        console.warn("[rt-scene] node " + nodeId + " gone before scene send; sending empty");
        ws.send(JSON.stringify({ type: "scene", patch: {
          camera: { mode: "perspective", pos:[0,0,2], target:[0,0,0], up:[0,1,0],
                    fov_deg: 60, near: 0.1, far: 100 },
          meshes: [], lights: [], clear_color: [0.05, 0.06, 0.10]
        }}));
      }
      ws.send(JSON.stringify({ type: "render-start" }));
    } catch (e) {
      console.warn("[rt-scene] onopen send threw:", e);
    }
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === "hello") {
        console.log("[rt-scene] engine hello:",
          "backend=" + msg.backend,
          "gpu=" + (msg.capabilities && msg.capabilities.gpu_name));
      } else if (msg.type === "frame-config") {
        _rtSceneAllocateTexture(inst, msg.width | 0, msg.height | 0);
        console.log("[rt-scene] frame-config " + msg.width + "x" + msg.height +
                    " format=" + msg.format);
      } else if (msg.type === "error") {
        console.warn("[rt-scene] engine error:", msg.where, msg.message);
        inst.error = (msg.where || "engine") + ": " + msg.message;
        // 7.5.6.h-status -- promote engine-side errors to inst.status
        // so the node's fallback clear color reflects them. WS is
        // still alive; future frames will replace the red clear if
        // the engine recovers.
        inst.status = "error";
      }
    } else {
      // Binary frame -- raw RGBA8 pixel data. Stash for the next
      // render tick's queue.writeTexture; overwrite any older
      // pending frame (we only display the freshest).
      const incoming = new Uint8Array(ev.data);
      if (inst.warmupFramesRemaining > 0 && inst.heldFrame &&
          inst.heldFrame.byteLength === incoming.byteLength) {
        // 7.5.6.h-warmup -- during TDS warmup, show the previous
        // frame instead of the noisy incoming one. heldFrame stays
        // unchanged so every warmup-hide tick displays the same
        // pre-reset content. The byteLength guard catches a stale
        // heldFrame whose dims don't match the current texture
        // (defense; _rtSceneAllocateTexture should already null
        // heldFrame on dim change).
        inst.pendingFrame = inst.heldFrame;
        inst.warmupFramesRemaining--;
      } else {
        inst.pendingFrame = incoming;
        inst.heldFrame = incoming;
      }
      inst.frameCount++;
      inst.lastFrameAt = performance.now();
      if (inst.frameCount === 1) {
        console.log("[rt-scene] first frame received (" + ev.data.byteLength + " bytes)");
      }
    }
  };
  ws.onerror = (e) => {
    console.warn("[rt-scene] ws error for node " + nodeId, e);
    inst.status = "error";
  };
  ws.onclose = () => {
    console.log("[rt-scene] ws closed for node " + nodeId);
    inst.ws = null;
    if (inst.status !== "error") inst.status = "closed";
    // Try reconnecting after 2s -- handles engine restarts gracefully.
    if (!inst.reconnectTimer) {
      inst.reconnectTimer = setTimeout(() => {
        inst.reconnectTimer = null;
        if (Visual.rtSceneInstances && Visual.rtSceneInstances.get(nodeId) === inst) {
          _rtSceneConnect(nodeId, inst);
        }
      }, 2000);
    }
  };
}

function _rtSceneAllocateTexture(inst, width, height) {
  if (inst.width === width && inst.height === height && inst.texture) return;
  if (inst.texture) try { inst.texture.destroy(); } catch (_) {}
  // 7.5.6.h-warmup -- a dim change invalidates any held frame
  // (different byteLength = can't blit into the new texture). Clear
  // it so the new connection falls through to "no held -> show new
  // frames immediately."
  inst.heldFrame = null;
  inst.warmupFramesRemaining = 0;
  inst.width = width;
  inst.height = height;
  inst.texture = Visual.device.createTexture({
    label: "rt-scene-tex-" + width + "x" + height,
    size: [width, height, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  inst.textureView = inst.texture.createView();
  _ensureRtBlitPipeline();
  inst.bindGroup = Visual.device.createBindGroup({
    label: "rt-scene-bg-" + width + "x" + height,
    layout: Visual._rtBlitBgl,
    entries: [
      { binding: 0, resource: inst.textureView },
      { binding: 1, resource: Visual._rtBlitSampler }
    ]
  });
}

function _encodeRtScenePass(enc, entry) {
  const { node, layerIdx, isScratch, writeKey } = entry;
  let layerView;
  if (isScratch) {
    const views = (writeKey === "a") ? Visual.scratchLayerViewsA : Visual.scratchLayerViewsB;
    layerView = views[layerIdx];
  } else {
    layerView = Visual.framebufferLayerViews[layerIdx];
  }
  if (!layerView) return false;

  const inst = _ensureRtSceneInstance(node);
  if (!inst) return false;

  // Sprint 7.5.6.a part 2e-2 -- live update diff-send. Runs every
  // frame the RT scene is visible; sends a Params or full Scene
  // message ONLY when the wired state has changed since last send.
  // No-op when the WS isn't open yet (initial scene goes via onopen).
  _rtScenePollAndSend(node, inst);

  // Upload pending frame, if any, into the GPU texture.
  if (inst.pendingFrame && inst.texture &&
      inst.pendingFrame.byteLength === inst.width * inst.height * 4) {
    Visual.device.queue.writeTexture(
      { texture: inst.texture },
      inst.pendingFrame,
      { bytesPerRow: inst.width * 4, rowsPerImage: inst.height },
      { width: inst.width, height: inst.height, depthOrArrayLayers: 1 }
    );
    inst.pendingFrame = null;
  }

  // If we don't have a texture yet (still connecting / no frame-
  // config received), clear the layer to a status-coded color +
  // return. Downstream consumers see a flat color; no crash. The
  // color tells the user at a glance which failure mode they're in
  // without having to open dev tools (the actual error message is
  // still in inst.error / the browser console).
  //
  //   navy   = waiting / connecting (normal startup)
  //   red    = engine reported an error (look at inst.error)
  //   crimson= compile-server not detected (start gamma-compile-server)
  //   amber  = WS closed (auto-reconnecting; usually transient)
  // 7.5.6.h-status -- pre-fix, the fallback was always navy regardless
  // of why we had no texture, which meant "engine crashed" looked
  // identical to "I just opened the editor."
  if (!inst.bindGroup || !inst.texture) {
    let clearValue;
    switch (inst.status) {
      case "error":     clearValue = { r: 0.50, g: 0.06, b: 0.06, a: 1.0 }; break;
      case "no-server": clearValue = { r: 0.25, g: 0.05, b: 0.05, a: 1.0 }; break;
      case "closed":    clearValue = { r: 0.20, g: 0.10, b: 0.03, a: 1.0 }; break;
      default:          clearValue = { r: 0.02, g: 0.03, b: 0.05, a: 1.0 }; break;
    }
    enc.beginRenderPass({
      label: "rt-scene-clear-" + node.id + "-" + (inst.status || "init"),
      colorAttachments: [{
        view: layerView,
        clearValue: clearValue,
        loadOp: "clear",
        storeOp: "store"
      }]
    }).end();
    return true;
  }

  // Blit the RT texture onto the framebuffer / scratch layer.
  const pass = enc.beginRenderPass({
    label: "rt-scene-blit-" + node.id,
    colorAttachments: [{
      view: layerView,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  pass.setPipeline(Visual._rtBlitPipeline);
  pass.setBindGroup(0, inst.bindGroup);
  pass.draw(3);
  pass.end();
  return true;
}

/* Phase 6.6.30 + v0.2.16 — render one plan entry. Handles BOTH the
 * scratch case (writes to scratchLayerViewsA/B[layerIdx] -- relative
 * index 0..SCRATCH_BUDGET-1, used by composition reads in the same
 * frame) AND the direct VO case (writes to
 * Visual.framebufferLayerViews[layerIdx] -- absolute display layer).
 *
 * v0.2.16 ping-pong: writeKey picks the scratch texture this pass
 * writes to; readKey picks the scratch texture the bind group reads
 * from. Always opposite parities so WebGPU never sees the same
 * texture in both bindings within one pass. Instance key includes
 * readKey so composition instances are cached per scratch-view they
 * bind (instead of one shared bind group that could be stale).
 *
 * Per-consumer instance key prevents collision between the same
 * source feeding multiple consumer VOs (each has its own uniform
 * buffer + pose). The writeUniforms-resolved scratch indices are
 * RELATIVE so the WGSL sample with those indices reads the right
 * scratch layer in the bound parity. */
function _encodeShaderFragPassForPlan(enc, entry, dtSec) {
  const { node, def, layerIdx, consumerVO, isScratch, readKey, writeKey } = entry;
  let layerView;
  if (isScratch) {
    const views = (writeKey === "a") ? Visual.scratchLayerViewsA : Visual.scratchLayerViewsB;
    layerView = views[layerIdx];
  } else {
    layerView = Visual.framebufferLayerViews[layerIdx];
  }
  if (!layerView) return false;

  // Sprint 7.5.3a -- Scene render path. Beats the rest of the function
  // by handing off to _encodeScenePass which has its own pipeline,
  // depth attachment, and per-mesh draw loop.
  if (def.kind === "scene") {
    return _encodeScenePass(enc, entry);
  }
  // Sprint 7.5.6.a part 2d -- RayTracedScene render path. The actual
  // rendering happens in the native gamma-rt-engine; the editor just
  // receives H.264 / RGBA frames over WebSocket + blits the latest
  // one to the assigned framebuffer/scratch layer.
  if (def.kind === "scene-rt") {
    return _encodeRtScenePass(enc, entry);
  }

  // v0.3.3 — ai-vision-canvas branch: bypass the shader pipeline
  // entirely. The MediaPipe detection loop drew video + landmark
  // overlay into entry.drawCanvas; queue a direct
  // copyExternalImageToTexture into the assigned framebuffer / scratch
  // layer. queue.copy* runs in submission order alongside encoder
  // commands, so downstream composition passes in the same submit see
  // the freshly-copied pixels.
  if (def.kind === "ai-vision-canvas") {
    const e = _mediapipeNodes.get(node.id);
    if (!e) {
      // Dispatch by node type to the right init helper.
      if (node.type === "PoseLandmarker")      _ensurePoseLandmarker(node.id, node.params || {});
      else if (node.type === "FaceLandmarker") _ensureFaceLandmarker(node.id, node.params || {});
      else if (node.type === "HandKeyboard")   _ensureHandKeyboard(node.id, node.params || {});
      else if (node.type === "BlobTracker")    _ensureBlobTracker(node.id, node.params || {});
      else                                     _ensureHandLandmarker(node.id, node.params || {});
      return false;
    }
    if (!e.ready || !e.drawCanvas) return false;

    // v0.3.12 — texture-source path. If the landmark's "video" input
    // is wired to a non-video shader-frag (Plasma / Butterflies /
    // BlendShader / Gradient), the upstream node renders to a GPU
    // layer (assigned by the plan walker). Blit that layer into
    // entry.gpuInputCanvas so both MediaPipe + the bgMode=1 drawCanvas
    // composite can read its content. The blit lands in the same
    // command encoder as the rest of the visual frame, so timing is
    // implicit (upstream's render pass appears earlier in the
    // schedule and finishes before this blit runs).
    if (e.useTextureSource && e.upstreamNodeId && e.gpuInputCtx) {
      const planMap = Visual._currentRenderPlan;
      const srcEntry = planMap && planMap.get(e.upstreamNodeId + "@" + consumerVO.id);
      if (srcEntry) {
        let srcView = null;
        if (srcEntry.isScratch) {
          const views = srcEntry.writeKey === "a"
            ? Visual.scratchLayerViewsA : Visual.scratchLayerViewsB;
          srcView = views[srcEntry.layerIdx];
        } else {
          srcView = Visual.framebufferLayerViews[srcEntry.layerIdx];
        }
        if (srcView) {
          // (Re)build the bind group when the source view changes
          // (e.g. resolution change reallocated the framebuffer, or
          // the plan ping-pong'd the source to a different scratch
          // parity).
          if (!e.gpuInputBindGroup || e._gpuInputSrcView !== srcView) {
            try {
              e.gpuInputBindGroup = Visual.device.createBindGroup({
                label: "ai-vision-input-bg-" + node.id,
                layout: Visual.blitBindGroupLayout,
                entries: [
                  { binding: 0, resource: srcView },
                  { binding: 1, resource: Visual.blitSampler }
                ]
              });
              e._gpuInputSrcView = srcView;
            } catch (err) {
              e.gpuInputBindGroup = null;
            }
          }
          if (e.gpuInputBindGroup) {
            let canvasView = null;
            try { canvasView = e.gpuInputCtx.getCurrentTexture().createView(); }
            catch (_) { canvasView = null; }
            if (canvasView) {
              const pass = enc.beginRenderPass({
                label: "ai-vision-input-blit-" + node.id,
                colorAttachments: [{
                  view: canvasView,
                  clearValue: { r: 0, g: 0, b: 0, a: 1 },
                  loadOp: "clear",
                  storeOp: "store"
                }]
              });
              pass.setPipeline(Visual.blitPipeline);
              pass.setBindGroup(0, e.gpuInputBindGroup);
              pass.draw(3);
              pass.end();
            }
          }
        }
      }
    }

    const destTexture = isScratch
      ? (writeKey === "a" ? Visual.scratchTextureA : Visual.scratchTextureB)
      : Visual.framebuffer;
    const cw = Math.min(e.drawCanvas.width  || 0, Visual.fbWidth);
    const ch = Math.min(e.drawCanvas.height || 0, Visual.fbHeight);
    if (cw === 0 || ch === 0) return false;
    try {
      Visual.device.queue.copyExternalImageToTexture(
        { source: e.drawCanvas, flipY: false },
        { texture: destTexture, origin: { x: 0, y: 0, z: layerIdx } },
        [cw, ch, 1]
      );
    } catch (err) {
      // Canvas not yet drawable (first frame race, etc). Silent skip.
      return false;
    }
    return true;
  }

  // Instance key — direct entries use the consumer VO id (one
  // shader instance per VO target, matching the pre-6.6.30 form).
  // Scratch entries use a "scratch:" prefix so a node that's BOTH
  // direct-wired AND used as a composition input has two separate
  // instances (different bind layouts, different uniforms).
  //
  // v0.2.16 — composition bind layout needs distinct instances per
  // readKey parity so each instance's bind group references the
  // matching scratchArrayView. Append :rk-<a|b> when this node is a
  // composition shader (its bind group binds a scratch texture).
  const isComp = def.bindLayout === "composition";
  let instKey = isScratch
    ? "scratch:" + node.id + ":" + consumerVO.id
    : consumerVO.id;
  if (isComp) instKey += ":rk-" + readKey;
  // Phase 6.6.28 — wire-resolved params for the dynamic WGSL fn too.
  const nodeResolvedForInst = _nodeWithResolvedParams(node);
  const inst = _ensureShaderInstance(instKey, def, nodeResolvedForInst, readKey);
  if (!inst) return false;
  const pipeEntry = inst.pipelineEntry;
  if (!pipeEntry || !pipeEntry.pipeline) return false;

  // Pose: consumer VO's display drives u_view for BOTH scratch and
  // direct passes. Scratch passes render the source FROM the
  // consumer's perspective; direct passes write the consumer's
  // display layer with the consumer's pose.
  const consumerDisp = (consumerVO.params && typeof consumerVO.params.display === "number")
    ? (consumerVO.params.display | 0) : 0;
  const display = state.rig && state.rig.displays && state.rig.displays[consumerDisp];
  const renderWuv = _renderWorldUvForVO(consumerVO, node.id);

  // u_layer in the uniform = consumer's display layer (used by
  // FeedbackShader to know which feedback layer to sample as
  // "previous frame of THIS display"). Scratch entries also use the
  // consumer's display layer here, not the scratch slot.
  _writeShaderPreamble(inst.scratch, dtSec, display, renderWuv, consumerDisp);
  if (typeof def.writeUniforms === "function") {
    def.writeUniforms(nodeResolvedForInst, inst.scratch);
  }
  const slotMap = def.textureInputSlots;
  if (slotMap && Array.isArray(def.ins)) {
    for (const port of def.ins) {
      if (!port || port.t !== "texture") continue;
      const slot = slotMap[port.n];
      if (typeof slot !== "number") continue;
      const resolved = _resolveTextureInputLayer(node, port.n, consumerVO.id);
      if (resolved >= 0) inst.scratch[slot] = resolved;
    }
  }
  Visual.device.queue.writeBuffer(inst.uniformBuffer, 0, inst.scratch.buffer, inst.scratch.byteOffset, inst.scratch.byteLength);

  // Phase 7.1 — video-source bind group is rebuilt per frame because
  // GPUExternalTexture is single-task-scoped. The source's <video>
  // element must already have a frame ready (readyState >= 2); if
  // not, kick off the getUserMedia request (idempotent) and skip the
  // frame -- framebuffer layer keeps its prior content, recipient
  // composition shaders see the previous frame.
  //
  // Multi-display distribution (v0.3.1): this function runs once per
  // (source × consumerVO) pair (e.g. 26x for a Webcam wired to an
  // AlloSphere rig). Each VO gets its own instance + uniform buffer +
  // bind group, so the per-display pose / world_uv preamble lands
  // correctly. But device.importExternalTexture would also fire 26x
  // per frame for the SAME source video frame -- redundant. We cache
  // the imported handle in Visual._frameVideoTextures (cleared each
  // renderVisualFrame) so the first pass imports + populates the
  // cache, and the other N-1 passes reuse the same handle. The bind
  // group itself still has to be per-VO (different uniform buffer
  // per VO instance) but the external texture handle is shared.
  let bindGroupForPass = inst.bindGroup;
  if (def.bindLayout === "video-source") {
    const src = _videoSources.get(node.id);
    if (!src) {
      // v0.3.11 — dispatch by node type: VideoFile loads from a URL,
      // Webcam (default) opens getUserMedia.
      // v0.3.22 — ScreenShare is gesture-gated; we DON'T auto-init
      // it here (browsers reject getDisplayMedia() outside a user
      // gesture frame). The node renders nothing until the user
      // clicks "Pick screen / window / tab…" in the props pane.
      if (node.type === "VideoFile")       _ensureVideoFile(node.id, node.params || {});
      else if (node.type === "ScreenShare") { /* deferred to user gesture */ }
      else                                  _ensureWebcamStream(node.id);
      return false;
    }
    // v0.3.11 — if the source's params changed (e.g. VideoFile fileUrl
    // edited), re-init so the new URL takes effect.
    if (node.type === "VideoFile" && src.fileUrl !== (node.params && node.params.fileUrl)) {
      _ensureVideoFile(node.id, node.params || {});
      return false;
    }
    if (!src.ready || !src.videoEl || src.videoEl.readyState < 2) return false;
    if (!Visual._frameVideoTextures) Visual._frameVideoTextures = new Map();
    let extTex = Visual._frameVideoTextures.get(node.id);
    if (!extTex) {
      try {
        extTex = Visual.device.importExternalTexture({ source: src.videoEl });
      } catch (e) {
        // importExternalTexture can throw if the video frame isn't
        // ready yet despite readyState >= 2 (race during the very
        // first few frames). Skip silently, retry next tick.
        return false;
      }
      Visual._frameVideoTextures.set(node.id, extTex);
    }
    const audioBuf = Visual.audioUniformBuffer
      ? { binding: 3, resource: { buffer: Visual.audioUniformBuffer } }
      : null;
    bindGroupForPass = Visual.device.createBindGroup({
      label: "shader-frag-videosource-bg-" + node.id + "-vo-" + consumerVO.id,
      layout: Visual.videoSourceShaderBgl,
      entries: [
        { binding: 0, resource: { buffer: inst.uniformBuffer } },
        { binding: 1, resource: extTex },
        { binding: 2, resource: Visual.blitSampler },
        audioBuf
      ].filter(Boolean)
    });
  }
  if (!bindGroupForPass) return false;

  const label = (isScratch ? "shader-frag-scratch-" : "shader-frag-") +
    node.type + "-" + node.id + "-vo-" + consumerVO.id + "-" +
    (isScratch ? "scratch" + layerIdx : "layer" + layerIdx);
  const pass = enc.beginRenderPass({
    label: label,
    colorAttachments: [{
      view: layerView,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  pass.setPipeline(pipeEntry.pipeline);
  pass.setBindGroup(0, bindGroupForPass);
  pass.draw(3);
  pass.end();
  return true;
}

