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

