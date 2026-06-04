

function _tickGameInputs(dt) {
  if (!state || !Array.isArray(state.nodes)) return;
  let needAny = false;
  for (const n of state.nodes) {
    if (n && (n.type === "KeyAxis2D" || n.type === "PlatformerBody2D" || n.type === "AnimationState2D"
              || n.type === "PickupCollector" || n.type === "LevelGoal2D")) {
      needAny = true; break;
    }
  }
  if (!needAny) return;
  _wireGameInput();
  // Clamp dt so the first frame (where dt = time-since-page-load,
  // often 1+ seconds) doesn't teleport the body through the world.
  // Cap at 1/30s -- if the renderer's actually running below 30fps,
  // physics simulates slower but doesn't tunnel. (Standard fixed-
  // step approach in 2D game engines.)
  if (!(dt > 0) || dt > 0.034) dt = 0.034;
  const gi = Visual.gameInput;
  const held    = gi.keys;
  const pressed = gi.pressed;
  // Pass 1: KeyAxis2D. Read held + pressed sets, write outputs.
  for (const node of state.nodes) {
    if (!node || node.type !== "KeyAxis2D") continue;
    if (!_isNodeActive(node)) continue;   // 8.A.2-filtering
    const p = node.params = node.params || {};
    const kL = (typeof p.keyLeft    === "string") ? p.keyLeft    : "KeyA";
    const kR = (typeof p.keyRight   === "string") ? p.keyRight   : "KeyD";
    const kU = (typeof p.keyUp      === "string") ? p.keyUp      : "KeyW";
    const kD = (typeof p.keyDown    === "string") ? p.keyDown    : "KeyS";
    const kJ = (typeof p.keyJump    === "string") ? p.keyJump    : "Space";
    const kA = (typeof p.keyActionA === "string") ? p.keyActionA : "KeyZ";
    const kB = (typeof p.keyActionB === "string") ? p.keyActionB : "KeyX";
    // x: -1 if left held, +1 if right held, 0 if both/neither.
    p.x = (held.has(kR) ? 1 : 0) - (held.has(kL) ? 1 : 0);
    // y: +1 if up held, -1 if down held (screen-style with y-up world).
    p.y = (held.has(kU) ? 1 : 0) - (held.has(kD) ? 1 : 0);
    // Edge-trigger outputs: 1 the frame the key was pressed, else 0.
    p.jump    = pressed.has(kJ) ? 1 : 0;
    p.actionA = pressed.has(kA) ? 1 : 0;
    p.actionB = pressed.has(kB) ? 1 : 0;
  }
  // Pass 2: PlatformerBody2D. Reads wired/static inputX + jump,
  // integrates physics, writes x/y/vx/vy/grounded/facing.
  const _resolveNumIn = (node, port, fallback) => {
    // Walk the wire (if any) to find the source's numeric value.
    if (Array.isArray(state.edges)) {
      const edge = state.edges.find(e => e && e.to && e.to.node === node.id && e.to.port === port);
      if (edge && edge.from) {
        const src = state.nodes.find(n => n && n.id === edge.from.node);
        if (src && src.params && typeof src.params[edge.from.port] === "number") {
          return src.params[edge.from.port];
        }
      }
    }
    const v = node.params ? node.params[port] : undefined;
    return (typeof v === "number") ? v : fallback;
  };
  // Helper: locate the Tilemap2D node that backs this body's
  // collision. Order: wire on `tilemap` input → first Tilemap2D in
  // the patch. Returns null if no tilemap exists (body falls back to
  // groundY-only behavior).
  const _findTilemap = (bodyNode) => {
    // Phase 5a -- accept Level2D as a collision source; synth proxy
    // backed by its first collidable tilemap layer. Same identity
    // across frames so _parseTilemap's per-node cache stays warm.
    if (Array.isArray(state.edges)) {
      const wire = state.edges.find(e =>
        e && e.to && e.to.node === bodyNode.id && e.to.port === "tilemap"
      );
      if (wire && wire.from) {
        const src = state.nodes.find(n => n && n.id === wire.from.node);
        if (src) {
          if (src.type === "Tilemap2D") return src;
          if (src.type === "Level2D")  {
            const synth = _level2dCollidableTilemap(src);
            if (synth) return synth;
          }
        }
      }
    }
    const direct = state.nodes.find(n => n && n.type === "Tilemap2D");
    if (direct) return direct;
    const lvl = state.nodes.find(n => n && n.type === "Level2D");
    if (lvl) return _level2dCollidableTilemap(lvl);
    return null;
  };
  // Helper: parse a Tilemap2D's tileData into a {rows, cols, grid,
  // tileSize, originX, originY, solidSet} object cached on the
  // tilemap node so we re-parse only when params change.
  const _parseTilemap = (tnode) => {
    const tp = tnode.params || {};
    const data = (typeof tp.tileData === "string") ? tp.tileData : "";
    const ts   = (typeof tp.tileSize === "number" && tp.tileSize > 0) ? tp.tileSize : 1;
    const ox   = (typeof tp.originX  === "number") ? tp.originX  : 0;
    const oy   = (typeof tp.originY  === "number") ? tp.originY  : 0;
    const key = data + "|" + ts + "|" + ox + "|" + oy;
    if (tnode._collisionCacheKey === key) return tnode._collisionCache;
    const rowsArr = data.split(/\r?\n/);
    const rows = rowsArr.length;
    const cols = rowsArr.reduce((m, r) => Math.max(m, r.length), 0);
    tnode._collisionCacheKey = key;
    tnode._collisionCache = {
      rows, cols, ts, ox, oy,
      cx: (cols - 1) * 0.5,
      cy: (rows - 1) * 0.5,
      rowsArr
    };
    return tnode._collisionCache;
  };
  // Helper: is the given (col, row) a SOLID tile in tilemap? Passable
  // chars: '.', ' ', '' (empty), '4' (pickup marker -- collectible,
  // not blocking), and '5' (goal marker -- detector, not blocking).
  // Everything else solid. Out-of-bounds = passable so the player can
  // walk off the side of the map; groundY catches the fall.
  const _isSolid = (tcache, col, row) => {
    if (col < 0 || row < 0 || row >= tcache.rows) return false;
    const line = tcache.rowsArr[row];
    if (col >= line.length) return false;
    const ch = line[col];
    return ch !== "." && ch !== " " && ch !== "" && ch !== "4" && ch !== "5";
  };
  // Helper: does the AABB at (cx, cyf, halfW, halfH) overlap any solid
  // tile in tilemap? cyf = AABB center y. Returns true on first hit
  // for early exit. Iterates only the col/row range covering the AABB.
  const _aabbOverlaps = (tcache, axLo, axHi, ayLo, ayHi) => {
    const halfTS = tcache.ts * 0.5;
    // Cell containing worldX: col = floor((x - ox)/ts + cx + 0.5).
    // Cell containing worldY: row = floor(cy - (y - oy)/ts + 0.5)
    //   (row 0 = top of grid, so higher world-Y = lower row).
    // Iterate one cell beyond the floor/ceil to absorb any edge-case
    // misalignment; the AABB overlap test inside filters out the slack.
    const colMin = Math.floor((axLo - tcache.ox) / tcache.ts + tcache.cx) - 1;
    const colMax = Math.floor((axHi - tcache.ox) / tcache.ts + tcache.cx) + 1;
    const rowMin = Math.floor(tcache.cy - (ayHi - tcache.oy) / tcache.ts) - 1;
    const rowMax = Math.floor(tcache.cy - (ayLo - tcache.oy) / tcache.ts) + 1;
    for (let r = rowMin; r <= rowMax; r++) {
      for (let c = colMin; c <= colMax; c++) {
        if (!_isSolid(tcache, c, r)) continue;
        // Cell AABB
        const tx = (c - tcache.cx) * tcache.ts + tcache.ox;
        const ty = (tcache.cy - r) * tcache.ts + tcache.oy;
        const tLo_x = tx - halfTS, tHi_x = tx + halfTS;
        const tLo_y = ty - halfTS, tHi_y = ty + halfTS;
        if (axHi > tLo_x && axLo < tHi_x && ayHi > tLo_y && ayLo < tHi_y) {
          return { col: c, row: r, tx, ty, tLo_x, tHi_x, tLo_y, tHi_y };
        }
      }
    }
    return null;
  };

  for (const node of state.nodes) {
    if (!node || node.type !== "PlatformerBody2D") continue;
    if (!_isNodeActive(node)) continue;   // 8.A.2-filtering
    const p = node.params = node.params || {};
    // Init on first tick OR when reset rises.
    const resetNow  = _resolveNumIn(node, "reset", 0);
    const resetEdge = resetNow >= 0.5 && (p._prevReset || 0) < 0.5;
    if (!p._inited || resetEdge) {
      p.x = _resolveNumIn(node, "initX", 0);
      p.y = _resolveNumIn(node, "initY", 1);
      p.vx = 0; p.vy = 0;
      p.grounded = 0; p.facing = 1;
      p._inited = 1;
    }
    p._prevReset = resetNow;
    const inputX     = _resolveNumIn(node, "inputX",     0);
    const jump       = _resolveNumIn(node, "jump",       0);
    const walkSpeed  = _resolveNumIn(node, "walkSpeed",  6);
    const gravity    = _resolveNumIn(node, "gravity",    22);
    const jumpForce  = _resolveNumIn(node, "jumpForce",  11);
    const airControl = _resolveNumIn(node, "airControl", 1);
    const width      = _resolveNumIn(node, "width",      0.6);
    const height     = _resolveNumIn(node, "height",     1.0);
    const groundY    = _resolveNumIn(node, "groundY",    -100);
    const halfW      = width * 0.5;
    // Horizontal: snap velocity to inputX * walkSpeed, scaled by
    // airControl when not grounded. (Arcade feel; no acceleration.)
    const ctrl = (p.grounded >= 0.5) ? 1 : airControl;
    p.vx = inputX * walkSpeed * ctrl;
    // Vertical: gravity always; jump impulse only if grounded.
    if (jump >= 0.5 && p.grounded >= 0.5) p.vy = jumpForce;
    p.vy -= gravity * dt;
    // Resolve collision against tilemap (if any). Anchor is BOTTOM-
    // CENTER so y is the feet line; AABB = (x - halfW, y) → (x + halfW, y + height).
    const tnode = _findTilemap(node);
    const tcache = tnode ? _parseTilemap(tnode) : null;
    // -- X axis movement + push-back --
    const intendedX = p.x + p.vx * dt;
    let newX = intendedX;
    if (tcache) {
      const ayLo = p.y, ayHi = p.y + height;
      const hit = _aabbOverlaps(tcache, newX - halfW, newX + halfW, ayLo, ayHi);
      if (hit) {
        if (p.vx > 0)      newX = hit.tLo_x - halfW - 0.0001;
        else if (p.vx < 0) newX = hit.tHi_x + halfW + 0.0001;
        p.vx = 0;
      }
    }
    p.x = newX;
    // -- Y axis movement + push-back --
    const intendedY = p.y + p.vy * dt;
    let newY = intendedY;
    let groundedFromTile = false;
    if (tcache) {
      const axLo = p.x - halfW, axHi = p.x + halfW;
      const hit = _aabbOverlaps(tcache, axLo, axHi, newY, newY + height);
      if (hit) {
        if (p.vy < 0) {
          // Falling onto tile top -- land. Push feet up to tile top.
          newY = hit.tHi_y + 0.0001;
          groundedFromTile = true;
        } else if (p.vy > 0) {
          // Rising into tile bottom -- bonk head. Push top down.
          newY = hit.tLo_y - height - 0.0001;
        }
        p.vy = 0;
      }
    }
    p.y = newY;
    // Safety-net ground (when off the tilemap, or no tilemap at all).
    if (p.y <= groundY) {
      p.y = groundY;
      if (p.vy < 0) p.vy = 0;
      p.grounded = 1;
    } else {
      p.grounded = groundedFromTile ? 1 : 0;
    }
    // Facing follows last non-zero inputX.
    if (inputX > 0.1)      p.facing = 1;
    else if (inputX < -0.1) p.facing = -1;
  }
  // Pass 3: AnimationState2D. Reads vx/vy/grounded/facing (wired or
  // static), derives state, advances frame loop, writes frame/flipX/
  // stateIdx. Runs after PlatformerBody2D so it sees this frame's
  // physics outputs, not last frame's.
  for (const node of state.nodes) {
    if (!node || node.type !== "AnimationState2D") continue;
    if (!_isNodeActive(node)) continue;   // 8.A.2-filtering
    const p = node.params = node.params || {};
    const vx       = _resolveNumIn(node, "vx",       0);
    const vy       = _resolveNumIn(node, "vy",       0);
    const grounded = _resolveNumIn(node, "grounded", 1);
    const facing   = _resolveNumIn(node, "facing",   1);
    const fps      = Math.max(0.5, _resolveNumIn(node, "fps", 8));
    const wThresh  = _resolveNumIn(node, "walkThreshold", 0.1);
    // Pick state.
    let stateName, stateIdx;
    if (grounded < 0.5) {
      if (vy > 0.1) { stateName = "jump"; stateIdx = 2; }
      else          { stateName = "fall"; stateIdx = 3; }
    } else if (Math.abs(vx) > wThresh) {
      stateName = "walk"; stateIdx = 1;
    } else {
      stateName = "idle"; stateIdx = 0;
    }
    // Restart cycle on state transition so a freshly-entered state
    // always shows frame 0 of its loop, not a stale mid-cycle frame.
    if (p._lastState !== stateName) {
      p._animTime = 0;
      p._lastState = stateName;
    } else {
      p._animTime = (p._animTime || 0) + dt;
    }
    // Look up the active state's frame spec + parse.
    const specKey = stateName + "Frames";
    const spec    = (typeof p[specKey] === "string") ? p[specKey] : "0";
    const frames  = _parseFrameSpec(spec);
    const idx     = Math.floor(p._animTime * fps) % frames.length;
    p.frame    = frames[idx] | 0;
    p.flipX    = facing < 0 ? 1 : 0;
    p.stateIdx = stateIdx;
  }
  // Pass 4: pickup + goal behavior. Reads body's just-computed x/y
  // so the AABB checks are against this frame's position.
  _tickPickupCollectors();
  _tickLevelGoals();
  _tickEdgeCounts();
  // Clear edge sets so the next frame starts fresh. Done at the END
  // so multiple consumers within this frame all see the same edges.
  gi.pressed.clear();
  gi.released.clear();
}

/* Sprint platformer-level-1 -- shared per-tick logic for PickupCollector
 * and LevelGoal2D. Both need: (1) find the wired or first-in-patch
 * Tilemap2D, (2) find the wired or first PlatformerBody2D, (3) iterate
 * cells matching a tileChar + check AABB overlap with the body. We
 * inline the AABB math here (it's small) instead of hoisting the
 * scoped helper out of _tickGameInputs. */
function _findWiredOrFirst(consumerNode, portName, sourceType) {
  // Phase 5a -- when callers ask for "Tilemap2D", also accept a
  // Level2D and synthesize a tilemap proxy backed by its first
  // collidable tilemap layer. Lets PlatformerBody2D / PickupCollector
  // / LevelGoal2D treat Level2D as a level container without each
  // tick function needing its own Level2D parse path.
  const _maybeLvlSynth = (n) =>
    (n && n.type === "Level2D" && sourceType === "Tilemap2D")
      ? _level2dCollidableTilemap(n) : null;
  if (state && Array.isArray(state.edges)) {
    const wire = state.edges.find(e =>
      e && e.to && e.to.node === consumerNode.id && e.to.port === portName
    );
    if (wire && wire.from) {
      const src = state.nodes.find(n => n && n.id === wire.from.node);
      if (src) {
        if (src.type === sourceType) return src;
        const synth = _maybeLvlSynth(src);
        if (synth) return synth;
      }
    }
  }
  if (state && Array.isArray(state.nodes)) {
    const direct = state.nodes.find(n => n && n.type === sourceType);
    if (direct) return direct;
    if (sourceType === "Tilemap2D") {
      const lvl = state.nodes.find(n => n && n.type === "Level2D");
      if (lvl) {
        const synth = _level2dCollidableTilemap(lvl);
        if (synth) return synth;
      }
    }
  }
  return null;
}

/* Phase 5a -- parse a Level2D's params.layers string ONCE per change
 * and cache the parsed array on the node. The cached array is the
 * source-of-truth for gameplay-tick mutations (PickupCollector
 * clearing '4' cells, etc), so re-parsing every frame would discard
 * those mutations. Cache invalidates whenever the raw string changes
 * (modal save serializes back to params.layers). */
function _level2dParsedLayers(levelNode) {
  const raw = (levelNode.params && typeof levelNode.params.layers === "string")
    ? levelNode.params.layers : "[]";
  if (levelNode._cachedLayersKey === raw && Array.isArray(levelNode._cachedLayers)) {
    return levelNode._cachedLayers;
  }
  let layers;
  try { layers = JSON.parse(raw); } catch (_) { layers = []; }
  if (!Array.isArray(layers)) layers = [];
  levelNode._cachedLayersKey  = raw;
  levelNode._cachedLayers     = layers;
  // The synth proxy is layer-identity-bound; rebuild on next request.
  levelNode._collisionLayerSynth = null;
  return layers;
}

/* Phase 5a -- return a Tilemap2D-shaped node backed by the FIRST
 * tilemap layer with collides!==false. The synth's params IS the
 * layer object (shared reference), so mutations the gameplay tick
 * does to params.tileData write through to the cached layer array
 * and the next frame's mesh build picks them up. Cached on the
 * Level2D for stable identity (so _parseTilemap's per-node cache
 * persists across frames). Returns null if no collidable tilemap. */
function _level2dCollidableTilemap(levelNode) {
  const layers = _level2dParsedLayers(levelNode);
  const lyr = layers.find(l => l && l.type === "tilemap" && l.collides !== false);
  if (!lyr) return null;
  if (levelNode._collisionLayerSynth && levelNode._collisionLayerSynth._levelLayer === lyr) {
    return levelNode._collisionLayerSynth;
  }
  const synth = {
    id: levelNode.id + ":collision",
    type: "Tilemap2D",
    params: lyr,
    _isSynthetic: true,
    _levelLayer: lyr,
    _levelParentId: levelNode.id
  };
  levelNode._collisionLayerSynth = synth;
  return synth;
}

function _tilemapCellsMatching(tilemapNode, ch) {
  const tp = tilemapNode.params || {};
  const data = (typeof tp.tileData === "string") ? tp.tileData : "";
  const ts = (typeof tp.tileSize === "number" && tp.tileSize > 0) ? tp.tileSize : 1;
  const ox = (typeof tp.originX  === "number") ? tp.originX : 0;
  const oy = (typeof tp.originY  === "number") ? tp.originY : 0;
  const rowsArr = data.split(/\r?\n/);
  const rows = rowsArr.length;
  const cols = rowsArr.reduce((m, r) => Math.max(m, r.length), 0);
  const cx = (cols - 1) * 0.5;
  const cy = (rows - 1) * 0.5;
  const out = [];
  for (let r = 0; r < rows; r++) {
    const line = rowsArr[r];
    for (let c = 0; c < line.length; c++) {
      if (line[c] !== ch) continue;
      out.push({
        col: c, row: r,
        x: (c - cx) * ts + ox,
        y: (cy - r) * ts + oy,
        halfTS: ts * 0.5
      });
    }
  }
  return { cells: out, rowsArr, rows };
}

function _bodyAabb(bodyNode) {
  const p = bodyNode.params || {};
  const w = (typeof p.width  === "number") ? p.width  : 0.6;
  const h = (typeof p.height === "number") ? p.height : 1.0;
  // PlatformerBody2D anchor: bottom-center (y is FEET line, growing up).
  const cx = (typeof p.x === "number") ? p.x : 0;
  const yFoot = (typeof p.y === "number") ? p.y : 0;
  return {
    xLo: cx - w * 0.5,
    xHi: cx + w * 0.5,
    yLo: yFoot,
    yHi: yFoot + h
  };
}

function _aabbHitsCell(a, c) {
  return a.xHi > c.x - c.halfTS && a.xLo < c.x + c.halfTS
      && a.yHi > c.y - c.halfTS && a.yLo < c.y + c.halfTS;
}

function _tickPickupCollectors() {
  if (!state || !Array.isArray(state.nodes)) return;
  for (const node of state.nodes) {
    if (!node || node.type !== "PickupCollector") continue;
    if (!_isNodeActive(node)) continue;   // 8.A.2-filtering
    const p = node.params = node.params || {};
    const tilemap = _findWiredOrFirst(node, "tilemap", "Tilemap2D");
    const body    = _findWiredOrFirst(node, "body",    "PlatformerBody2D");
    if (!tilemap || !body) continue;
    const charRaw = (typeof p.tileChar === "string" && p.tileChar.length) ? p.tileChar[0] : "4";
    // First-frame snapshot: count total + reset collected.
    // §8.A-reset: also snapshot the tilemap's tileData so a `reset`
    // rising edge can restore picked-up cells. The snapshot is held
    // on the node (transient, not serialized) so it survives Hot-
    // Reload-style edits but resets on patch reload.
    if (!p._inited) {
      const snap = _tilemapCellsMatching(tilemap, charRaw);
      p.total = snap.cells.length;
      p.collected = 0;
      p.remaining = p.total;
      p.done = p.total === 0 ? 1 : 0;
      p._inited = 1;
      node._resetTileSnapshot = (tilemap.params && typeof tilemap.params.tileData === "string")
        ? tilemap.params.tileData : "";
    }
    // §8.A-reset: rising-edge `reset` restores the tilemap to its
    // snapshot + zeros the counters so all pickups respawn.
    const resolvedP = (typeof _resolveNodeParams === "function") ? _resolveNodeParams(node) : p;
    const resetNow = (typeof resolvedP.reset === "number") ? resolvedP.reset : 0;
    if (resetNow >= 0.5 && (node._resetPrev || 0) < 0.5) {
      if (typeof node._resetTileSnapshot === "string" && tilemap.params) {
        tilemap.params.tileData = node._resetTileSnapshot;
        const snap = _tilemapCellsMatching(tilemap, charRaw);
        p.total = snap.cells.length;
      }
      p.collected = 0;
      p.remaining = p.total;
      p.done = p.total === 0 ? 1 : 0;
    }
    node._resetPrev = resetNow;
    if (p.done) continue;
    const aabb = _bodyAabb(body);
    const parsed = _tilemapCellsMatching(tilemap, charRaw);
    const { cells, rowsArr } = parsed;
    if (cells.length === 0) {
      // Tilemap empty of this char now -- mark done.
      p.remaining = 0;
      p.done = 1;
      continue;
    }
    let mutated = false;
    for (const cell of cells) {
      if (_aabbHitsCell(aabb, cell)) {
        const line = rowsArr[cell.row];
        rowsArr[cell.row] = line.slice(0, cell.col) + "." + line.slice(cell.col + 1);
        p.collected = (p.collected | 0) + 1;
        mutated = true;
      }
    }
    if (mutated) {
      tilemap.params.tileData = rowsArr.join("\n");
      // Tilemap2D's _meshCacheKey includes tileData -- mutation here
      // produces a new key so the mesh auto-rebuilds next frame.
      p.remaining = Math.max(0, p.total - p.collected);
      if (p.remaining === 0) p.done = 1;
    }
  }
}

function _tickEdgeCounts() {
  if (!state || !Array.isArray(state.nodes)) return;
  for (const node of state.nodes) {
    if (!node || node.type !== "EdgeCount") continue;
    if (!_isNodeActive(node)) continue;
    const p = node.params = node.params || {};
    const r = (typeof _resolveNodeParams === "function") ? _resolveNodeParams(node) : p;
    const max = Math.max(1, Math.round(typeof r.max === "number" ? r.max : 3));

    const resetNow = (typeof r.reset === "number") ? r.reset : 0;
    if (resetNow >= 0.5 && (node._edgePrevReset || 0) < 0.5) {
      p.count = 0;
      p.limitHit = 0;
    }
    node._edgePrevReset = resetNow;

    const trig = (typeof r.trigger === "number") ? r.trigger : 0;
    if (trig >= 0.5 && (node._edgePrevTrig || 0) < 0.5) {
      const c = Math.min(max, (p.count || 0) + 1);
      p.count = c;
      p.limitHit = c >= max ? 1 : 0;
    }
    node._edgePrevTrig = trig;
    p.remaining = Math.max(0, max - (p.count || 0));
  }
}

function _tickLevelGoals() {
  if (!state || !Array.isArray(state.nodes)) return;
  for (const node of state.nodes) {
    if (!node || node.type !== "LevelGoal2D") continue;
    if (!_isNodeActive(node)) continue;   // 8.A.2-filtering
    const p = node.params = node.params || {};
    // §8.A-reset: rising-edge `reset` clears the latched `reached`
    // flag, letting the goal re-arm for a fresh playthrough.
    const resolved = (typeof _resolveNodeParams === "function") ? _resolveNodeParams(node) : p;
    const resetNow = (typeof resolved.reset === "number") ? resolved.reset : 0;
    if (resetNow >= 0.5 && (node._resetPrev || 0) < 0.5) {
      p.reached = 0;
    }
    node._resetPrev = resetNow;
    if (p.reached) continue;   // latched -- skip checks once reached
    const tilemap = _findWiredOrFirst(node, "tilemap", "Tilemap2D");
    const body    = _findWiredOrFirst(node, "body",    "PlatformerBody2D");
    if (!tilemap || !body) continue;
    const charRaw = (typeof p.tileChar === "string" && p.tileChar.length) ? p.tileChar[0] : "5";
    const { cells } = _tilemapCellsMatching(tilemap, charRaw);
    if (cells.length === 0) continue;
    const aabb = _bodyAabb(body);
    for (const cell of cells) {
      if (_aabbHitsCell(aabb, cell)) { p.reached = 1; break; }
    }
  }
}

/* Parse a frame-range spec used by AnimationState2D.
 *   "5"            → [5]
 *   "0,1,2"        → [0, 1, 2]
 *   "0-3"          → [0, 1, 2, 3]      (range)
 *   "0,1,2,3,2,1"  → ping-pong sequence
 * Negative / NaN segments are skipped; empty input → [0]. */
function _parseFrameSpec(s) {
  if (!s || typeof s !== "string") return [0];
  const out = [];
  for (const part of s.split(",")) {
    const seg = part.trim();
    if (!seg) continue;
    const range = seg.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const step = a <= b ? 1 : -1;
        for (let i = a; step > 0 ? i <= b : i >= b; i += step) out.push(i);
      }
    } else {
      const n = parseInt(seg, 10);
      if (Number.isFinite(n) && n >= 0) out.push(n);
    }
  }
  return out.length ? out : [0];
}

function _tickFPCameras(dt) {
  if (!state || !Array.isArray(state.nodes)) return;
  const input = Visual.fpcInput;
  if (!input) return;
  const k = input.keys;

  // Sprint 8-8: F = toggle fly / walk (rising-edge latched so holding
  // doesn't oscillate). Auto-walk on surface contact handles the
  // "just landed" case; F is the manual override to take off again.
  const fNow = !!(k && k.has("KeyF"));
  const flyToggleEdge = fNow && !input._lastKeyF;
  input._lastKeyF = fNow;

  for (const node of state.nodes) {
    if (!node || node.type !== "FPCamera") continue;
    const p = node.params = node.params || {};
    if (flyToggleEdge) p.walkMode = ((typeof p.walkMode === "number") ? p.walkMode : 1) >= 0.5 ? 0 : 1;
    const walkMode = (typeof p.walkMode === "number") ? (p.walkMode >= 0.5) : true;
    if (walkMode) _tickFPCameraWalk(node, p, dt, input, k);
    else          _tickFPCameraFlight(node, p, dt, input, k);
  }
  input.mouseDx = 0;
  input.mouseDy = 0;
}

function _tickFPCameraWalk(node, p, dt, input, k) {
  const sens     = (typeof p.mouseSensitivity === "number") ? p.mouseSensitivity : 0.0025;
  if (k && (k.has("KeyX") || k.has("KeyZ"))) {
    const cur = (typeof p.walkSpeed === "number") ? p.walkSpeed : 12;
    const rate = Math.pow(4, dt);
    const factor = k.has("KeyX") ? rate : (1 / rate);
    p.walkSpeed = Math.max(1, Math.min(50000, cur * factor));
  }
  const speed    = (typeof p.walkSpeed        === "number") ? p.walkSpeed        : 12;
  const lookRate = (typeof p.lookSpeed        === "number") ? p.lookSpeed        : 2.0;
  const eyeH     = (typeof p.eyeHeight        === "number") ? p.eyeHeight        : 1.7;

  let px = (typeof p.posX === "number") ? p.posX : 0;
  let py = (typeof p.posY === "number") ? p.posY : 2;
  let pz = (typeof p.posZ === "number") ? p.posZ : 0;

  // === Sprint 8-8c: tangent-plane basis when on a planet ===
  // World yaw/pitch Euler angles don't work at non-pole latitudes --
  // the camera's "up" rotates with planet position, so mouse-look has
  // to be defined relative to the LOCAL up (radial). We store forward
  // as a 3D vector (re-derived from targetXYZ if it survives the
  // tick) and rotate it around the local up / right just like flight
  // mode does. Flat-terrain patches still use the Euler path so
  // legacy demos behave the same.
  const _walkPL = _findPlanetInfo();
  const _walkOnPlanet = _walkPL && state.nodes.some(n => n && n.type === "PlanetMesh");

  let upX, upY, upZ;
  if (_walkOnPlanet) {
    const rdx = px - _walkPL.centerX, rdy = py - _walkPL.centerY, rdz = pz - _walkPL.centerZ;
    const rLen = Math.hypot(rdx, rdy, rdz) || 1;
    upX = rdx / rLen; upY = rdy / rLen; upZ = rdz / rLen;
  } else {
    upX = 0; upY = 1; upZ = 0;
  }

  // Bring in the previous tick's forward (set via targetXYZ at the
  // end of last frame, by either walk OR flight). Fall back to a
  // yaw/pitch-derived forward if no target exists yet.
  let fx, fy, fz;
  const tdx = (typeof p.targetX === "number" ? p.targetX : 0) - px;
  const tdy = (typeof p.targetY === "number" ? p.targetY : 0) - py;
  const tdz = (typeof p.targetZ === "number" ? p.targetZ : 1) - pz;
  const tLen = Math.hypot(tdx, tdy, tdz);
  if (tLen > 1e-6) {
    fx = tdx / tLen; fy = tdy / tLen; fz = tdz / tLen;
  } else {
    const yaw0 = (typeof p.yaw === "number") ? p.yaw : 0;
    const pitch0 = (typeof p.pitch === "number") ? p.pitch : 0;
    const cy0 = Math.cos(yaw0), sy0 = Math.sin(yaw0);
    const cp0 = Math.cos(pitch0), sp0 = Math.sin(pitch0);
    fx = sy0 * cp0; fy = sp0; fz = cy0 * cp0;
  }

  // Mouse / key look deltas.
  let yawD = 0, pitchD = 0;
  if (input.pointerLocked) {
    yawD   -= input.mouseDx * sens;
    pitchD -= input.mouseDy * sens;
  }
  if (k.has("KeyJ")) yawD   -= lookRate * dt;
  if (k.has("KeyL")) yawD   += lookRate * dt;
  if (k.has("KeyI")) pitchD += lookRate * dt;
  if (k.has("KeyK")) pitchD -= lookRate * dt;

  // Build initial tangent-plane right vector: project forward onto
  // tangent plane and take its 90deg rotation around up.
  let fdu = fx*upX + fy*upY + fz*upZ;
  let fhX = fx - upX * fdu, fhY = fy - upY * fdu, fhZ = fz - upZ * fdu;
  let fhLen = Math.hypot(fhX, fhY, fhZ);
  if (fhLen < 1e-6) {
    // Forward is nearly parallel to up -- pick an arbitrary tangent.
    const refX = Math.abs(upX) < 0.9 ? 1 : 0;
    const refY = Math.abs(upX) < 0.9 ? 0 : 1;
    fhX = refX - upX * (refX*upX + refY*upY);
    fhY = refY - upY * (refX*upX + refY*upY);
    fhZ = 0    - upZ * (refX*upX + refY*upY);
    fhLen = Math.hypot(fhX, fhY, fhZ) || 1;
  }
  fhX /= fhLen; fhY /= fhLen; fhZ /= fhLen;
  // right = forward_h x up (matches flight-mode sign so D = right).
  let rX = fhY*upZ - fhZ*upY;
  let rY = fhZ*upX - fhX*upZ;
  let rZ = fhX*upY - fhY*upX;

  // Apply yaw around UP, then pitch around RIGHT.
  if (yawD !== 0) {
    const r1 = _rotAroundUnit(fx, fy, fz, upX, upY, upZ, yawD);
    fx = r1[0]; fy = r1[1]; fz = r1[2];
    fdu = fx*upX + fy*upY + fz*upZ;
    fhX = fx - upX * fdu; fhY = fy - upY * fdu; fhZ = fz - upZ * fdu;
    fhLen = Math.hypot(fhX, fhY, fhZ) || 1;
    fhX /= fhLen; fhY /= fhLen; fhZ /= fhLen;
    rX = fhY*upZ - fhZ*upY; rY = fhZ*upX - fhX*upZ; rZ = fhX*upY - fhY*upX;
  }
  if (pitchD !== 0) {
    const r2 = _rotAroundUnit(fx, fy, fz, rX, rY, rZ, pitchD);
    fx = r2[0]; fy = r2[1]; fz = r2[2];
  }
  // Pitch clamp: cap |sin(angle between forward and tangent)| at
  // sin(88deg) so the camera never goes fully vertical.
  const limSin = Math.sin(Math.PI * 0.49);
  const sinP = fx*upX + fy*upY + fz*upZ;
  if (Math.abs(sinP) > limSin) {
    const tgtSin = (sinP > 0) ? limSin : -limSin;
    const tgtCos = Math.sqrt(Math.max(0, 1 - tgtSin * tgtSin));
    fdu = fx*upX + fy*upY + fz*upZ;
    const hX = fx - upX * fdu, hY = fy - upY * fdu, hZ = fz - upZ * fdu;
    const hLen = Math.hypot(hX, hY, hZ) || 1;
    fx = hX / hLen * tgtCos + upX * tgtSin;
    fy = hY / hLen * tgtCos + upY * tgtSin;
    fz = hZ / hLen * tgtCos + upZ * tgtSin;
  }
  // Re-derive horiz + right after pitch clamp.
  fdu = fx*upX + fy*upY + fz*upZ;
  fhX = fx - upX * fdu; fhY = fy - upY * fdu; fhZ = fz - upZ * fdu;
  fhLen = Math.hypot(fhX, fhY, fhZ) || 1;
  fhX /= fhLen; fhY /= fhLen; fhZ /= fhLen;
  rX = fhY*upZ - fhZ*upY; rY = fhZ*upX - fhX*upZ; rZ = fhX*upY - fhY*upX;

  // Movement on the tangent plane.
  let dx = 0, dy = 0, dz = 0;
  if (k.has("KeyW")) { dx += fhX; dy += fhY; dz += fhZ; }
  if (k.has("KeyS")) { dx -= fhX; dy -= fhY; dz -= fhZ; }
  if (k.has("KeyD")) { dx += rX;  dy += rY;  dz += rZ;  }
  if (k.has("KeyA")) { dx -= rX;  dy -= rY;  dz -= rZ;  }
  const sprint = (k.has("ShiftLeft") || k.has("ShiftRight")) ? 4 : 1;
  const l = Math.hypot(dx, dy, dz);
  if (l > 0.0001) {
    const step = speed * sprint * dt;
    px += (dx / l) * step;
    py += (dy / l) * step;
    pz += (dz / l) * step;
  }

  // Sprint 10-6 v4: detect input-this-tick FIRST so the surf cache
  // below can decide whether to re-sample. Drift log uses this too.
  const _hasInputThisTick = (
    k.has("KeyW") || k.has("KeyA") || k.has("KeyS") || k.has("KeyD") ||
    k.has("KeyI") || k.has("KeyJ") || k.has("KeyK") || k.has("KeyL") ||
    k.has("KeyX") || k.has("KeyZ") || k.has("KeyR") || k.has("KeyF") ||
    k.has("Space") || k.has("ShiftLeft") || k.has("ShiftRight") ||
    Math.abs(input.mouseDx || 0) > 0.0001 ||
    Math.abs(input.mouseDy || 0) > 0.0001
  );

  // Snap to ground.
  const _preSnapPx = px, _preSnapPy = py, _preSnapPz = pz;
  if (_walkOnPlanet) {
    // Sprint 10-6 v5: surf cache with sanity checks. v4 froze surf
    // whenever no input was held -- but if camera was teleported or
    // the chunk rebuilt with very different alts, cached surf could
    // be hundreds of meters off, leaving the camera floating. v5
    // refreshes when:
    //   - Input is held (normal walking)
    //   - No cache yet
    //   - Cache > 2 seconds old (covers slow tile loads)
    //   - Cached surf is far (> 50 m) from current camera direction
    //     (covers teleport / large jumps)
    let surf;
    const now = (typeof performance !== "undefined") ? performance.now() : 0;
    let needsFresh = _hasInputThisTick || !input._cachedSurf;
    if (!needsFresh && input._cachedSurfTime
        && (now - input._cachedSurfTime) > 2000) {
      needsFresh = true;
    }
    if (!needsFresh && input._cachedSurf) {
      // Distance from cam to cached surf along the radial. If we've
      // moved far from the cached position (unexpected) recompute.
      const sdx = input._cachedSurf.x - px;
      const sdy = input._cachedSurf.y - py;
      const sdz = input._cachedSurf.z - pz;
      if ((sdx*sdx + sdy*sdy + sdz*sdz) > 50*50) needsFresh = true;
    }
    if (needsFresh) {
      surf = _planetMeshSurfacePos(px, py, pz, _walkPL);
      if (surf) {
        input._cachedSurf = surf;
        input._cachedSurfTime = now;
      }
    } else {
      surf = input._cachedSurf;
    }
    if (surf) {
      // Re-derive up at the new position (we moved along a flat
      // tangent plane but the planet is curved, so the radial just
      // rotated slightly).
      const rdx = px - _walkPL.centerX, rdy = py - _walkPL.centerY, rdz = pz - _walkPL.centerZ;
      const rLen = Math.hypot(rdx, rdy, rdz) || 1;
      upX = rdx / rLen; upY = rdy / rLen; upZ = rdz / rLen;
      px = surf.x + upX * eyeH;
      py = surf.y + upY * eyeH;
      pz = surf.z + upZ * eyeH;
    }
  } else {
    const groundY = _fpcSampleGroundY(px, pz, py);
    if (groundY !== null) py = groundY + eyeH;
  }
  if (!input._prevCamPos) input._prevCamPos = { x: null, y: null, z: null };
  const _prevPx = input._prevCamPos.x, _prevPy = input._prevCamPos.y, _prevPz = input._prevCamPos.z;
  if (_prevPx !== null && !_hasInputThisTick) {
    const drift = Math.hypot(px - _prevPx, py - _prevPy, pz - _prevPz);
    if (drift > 0.01) {
      const now = (typeof performance !== "undefined") ? performance.now() : 0;
      if (!input._lastDriftLog || (now - input._lastDriftLog) > 500) {
        input._lastDriftLog = now;
        const dPreX = _preSnapPx - _prevPx, dPreY = _preSnapPy - _prevPy, dPreZ = _preSnapPz - _prevPz;
        const dSnapX = px - _preSnapPx,    dSnapY = py - _preSnapPy,    dSnapZ = pz - _preSnapPz;
        const driftPre  = Math.hypot(dPreX, dPreY, dPreZ);
        const driftSnap = Math.hypot(dSnapX, dSnapY, dSnapZ);
        console.log("[cam-drift] no-input drift " + drift.toFixed(2) + "m total"
                  + " (pre-snap " + driftPre.toFixed(2) + "m, terrain-snap " + driftSnap.toFixed(2) + "m)"
                  + " | pos=(" + px.toFixed(0) + "," + py.toFixed(0) + "," + pz.toFixed(0) + ")");
      }
    }
  }
  input._prevCamPos.x = px; input._prevCamPos.y = py; input._prevCamPos.z = pz;

  p.posX = px; p.posY = py; p.posZ = pz;
  // Derive yaw/pitch from forward in the LOCAL frame so HUD and the
  // walk<->flight transition keep working. pitch = angle of forward
  // above tangent plane.
  p.pitch = Math.asin(Math.max(-1, Math.min(1, fx*upX + fy*upY + fz*upZ)));
  p.yaw   = Math.atan2(fx, fz);  // approximate; only used for HUD
  p.targetX = px + fx;
  p.targetY = py + fy;
  p.targetZ = pz + fz;
  p.upX = upX; p.upY = upY; p.upZ = upZ;
}

/* Rodrigues rotation of vector v around unit axis (ax, ay, az) by
 * angle a. Returns [vx', vy', vz'] in-place-safe (reads v first).
 * When axis is perpendicular to v (the common case for our basis
 * rotations) the formula simplifies, but we keep the general form. */
function _rotAroundUnit(vx, vy, vz, ax, ay, az, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const omc = 1 - c;
  const d = ax*vx + ay*vy + az*vz;
  const cx = ay*vz - az*vy;
  const cy = az*vx - ax*vz;
  const cz = ax*vy - ay*vx;
  return [
    vx*c + cx*s + ax*d*omc,
    vy*c + cy*s + ay*d*omc,
    vz*c + cz*s + az*d*omc
  ];
}

function _tickFPCameraFlight(node, p, dt, input, k) {
  const sens     = (typeof p.mouseSensitivity === "number") ? p.mouseSensitivity : 0.0025;
  if (k && (k.has("KeyX") || k.has("KeyZ"))) {
    const cur = (typeof p.walkSpeed === "number") ? p.walkSpeed : 12;
    const rate = Math.pow(4, dt);
    const factor = k.has("KeyX") ? rate : (1 / rate);
    p.walkSpeed = Math.max(1, Math.min(50000, cur * factor));
  }
  const speed    = (typeof p.walkSpeed        === "number") ? p.walkSpeed        : 12;
  const lookRate = (typeof p.lookSpeed        === "number") ? p.lookSpeed        : 2.0;

  let px = (typeof p.posX === "number") ? p.posX : 0;
  let py = (typeof p.posY === "number") ? p.posY : 2;
  let pz = (typeof p.posZ === "number") ? p.posZ : 0;

  // Build current basis (forward, up). If a meaningful target +
  // upX/Y/Z exist on the params (set by the demo OR carried from
  // the prior tick), use them directly -- they ARE the orientation.
  // Otherwise derive from yaw/pitch + world up (first tick after
  // entering flight mode from walk, or fresh node).
  let fx, fy, fz, ux, uy, uz;
  const tdx = (typeof p.targetX === "number" ? p.targetX : 0) - px;
  const tdy = (typeof p.targetY === "number" ? p.targetY : 0) - py;
  const tdz = (typeof p.targetZ === "number" ? p.targetZ : 1) - pz;
  const tLen = Math.hypot(tdx, tdy, tdz);
  const hasUp = (typeof p.upX === "number" && typeof p.upY === "number" && typeof p.upZ === "number")
                && (Math.abs(p.upX) + Math.abs(p.upY) + Math.abs(p.upZ) > 1e-6);
  if (tLen > 1e-6 && hasUp) {
    fx = tdx / tLen; fy = tdy / tLen; fz = tdz / tLen;
    const uLen = Math.hypot(p.upX, p.upY, p.upZ) || 1;
    ux = p.upX / uLen; uy = p.upY / uLen; uz = p.upZ / uLen;
  } else {
    const yaw   = (typeof p.yaw   === "number") ? p.yaw   : 0;
    const pitch = (typeof p.pitch === "number") ? p.pitch : 0;
    const cy = Math.cos(yaw),   sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    fx = sy * cp; fy = sp; fz = cy * cp;
    ux = 0; uy = 1; uz = 0;
  }
  // Gram-Schmidt to enforce orthogonality up front.
  {
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    const fu = fx*ux + fy*uy + fz*uz;
    ux -= fx * fu; uy -= fy * fu; uz -= fz * fu;
    const ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6) { ux = 0; uy = 1; uz = 0; }
    else { ux /= ul; uy /= ul; uz /= ul; }
  }
  // Right = up × forward (right-handed; at yaw=0 with up=+Y gives +X).
  let rx = uy*fz - uz*fy, ry = uz*fx - ux*fz, rz = ux*fy - uy*fx;

  // Rotation deltas
  let pitchD = 0, yawD = 0, rollD = 0;
  if (input.pointerLocked) {
    pitchD -= input.mouseDy * sens;
    yawD   -= input.mouseDx * sens;
  }
  if (k.has("KeyI")) pitchD += lookRate * dt;
  if (k.has("KeyK")) pitchD -= lookRate * dt;
  if (k.has("KeyJ")) yawD   -= lookRate * dt;
  if (k.has("KeyL")) yawD   += lookRate * dt;
  if (k.has("KeyU")) rollD  -= lookRate * dt;
  if (k.has("KeyO")) rollD  += lookRate * dt;

  // Pitch: rotate forward + up around right.
  if (pitchD !== 0) {
    const r1 = _rotAroundUnit(fx, fy, fz, rx, ry, rz, pitchD);
    fx = r1[0]; fy = r1[1]; fz = r1[2];
    const r2 = _rotAroundUnit(ux, uy, uz, rx, ry, rz, pitchD);
    ux = r2[0]; uy = r2[1]; uz = r2[2];
  }
  // Yaw: rotate forward + right around up.
  if (yawD !== 0) {
    const r1 = _rotAroundUnit(fx, fy, fz, ux, uy, uz, yawD);
    fx = r1[0]; fy = r1[1]; fz = r1[2];
    rx = uy*fz - uz*fy; ry = uz*fx - ux*fz; rz = ux*fy - uy*fx;
  }
  // Roll: rotate up + right around forward.
  if (rollD !== 0) {
    const r1 = _rotAroundUnit(ux, uy, uz, fx, fy, fz, rollD);
    ux = r1[0]; uy = r1[1]; uz = r1[2];
    rx = uy*fz - uz*fy; ry = uz*fx - ux*fz; rz = ux*fy - uy*fx;
  }
  // Re-normalize against drift.
  {
    const fl = Math.hypot(fx, fy, fz) || 1; fx/=fl; fy/=fl; fz/=fl;
    const fu = fx*ux + fy*uy + fz*uz;
    ux -= fx*fu; uy -= fy*fu; uz -= fz*fu;
    const ul = Math.hypot(ux, uy, uz) || 1; ux/=ul; uy/=ul; uz/=ul;
    rx = uy*fz - uz*fy; ry = uz*fx - ux*fz; rz = ux*fy - uy*fx;
  }

  // Movement: WASD along forward/right; Space/C along planet-radial.
  let dx = 0, dy = 0, dz = 0;
  if (k.has("KeyW")) { dx += fx; dy += fy; dz += fz; }
  if (k.has("KeyS")) { dx -= fx; dy -= fy; dz -= fz; }
  if (k.has("KeyD")) { dx += rx; dy += ry; dz += rz; }
  if (k.has("KeyA")) { dx -= rx; dy -= ry; dz -= rz; }
  const wantUp   = k.has("Space");
  const wantDown = k.has("KeyC") || k.has("ControlLeft") || k.has("ControlRight");
  if (wantUp || wantDown) {
    const sign = wantUp ? 1 : -1;
    const pUp = _planetRadialUp(px, py, pz);
    if (pUp) { dx += sign*pUp[0]; dy += sign*pUp[1]; dz += sign*pUp[2]; }
    else     { dy += sign; }
  }
  const sprint = (k.has("ShiftLeft") || k.has("ShiftRight")) ? 4 : 1;
  const l = Math.hypot(dx, dy, dz);
  if (l > 0.0001) {
    const step = speed * sprint * dt;
    px += (dx / l) * step;
    py += (dy / l) * step;
    pz += (dz / l) * step;
  }

  // Walk-dir tracking (used by TiledTerrain forwardBias; planet
  // ignores it but harmless to keep updated for mixed patches).
  const horizMoveLen = Math.hypot(dx, dz);
  if (horizMoveLen > 0.001) {
    const ndx = dx / horizMoveLen, ndz = dz / horizMoveLen;
    const tcFactor = Math.min(1, dt * 1.5);
    const wdx0 = (typeof p.walkDirX === "number") ? p.walkDirX : ndx;
    const wdz0 = (typeof p.walkDirZ === "number") ? p.walkDirZ : ndz;
    p.walkDirX = wdx0 + (ndx - wdx0) * tcFactor;
    p.walkDirZ = wdz0 + (ndz - wdz0) * tcFactor;
  }

  // Sprint 8-8: PlanetMesh ground collision + auto-switch to walk
  // mode when the camera touches down. Sliding rather than stopping
  // (we project to surface + eyeHeight along the radial) so flying
  // INTO terrain at speed doesn't lock the user up.
  const _flyPL = _findPlanetInfo();
  if (_flyPL && state.nodes.some(n => n && n.type === "PlanetMesh")) {
    const surf = _planetMeshSurfacePos(px, py, pz, _flyPL);
    if (surf) {
      const cdx = px - _flyPL.centerX, cdy = py - _flyPL.centerY, cdz = pz - _flyPL.centerZ;
      const sdx = surf.x - _flyPL.centerX, sdy = surf.y - _flyPL.centerY, sdz = surf.z - _flyPL.centerZ;
      const camR = Math.hypot(cdx, cdy, cdz);
      const surfR = Math.hypot(sdx, sdy, sdz);
      const agl = camR - surfR;
      const eyeH = (typeof p.eyeHeight === "number") ? p.eyeHeight : 1.7;
      // Land threshold: 1x eyeHeight. Below that we clamp + switch
      // to walk. Anything above is free flight.
      if (agl < eyeH) {
        const cLen = camR || 1;
        const upx = cdx / cLen, upy = cdy / cLen, upz = cdz / cLen;
        px = surf.x + upx * eyeH;
        py = surf.y + upy * eyeH;
        pz = surf.z + upz * eyeH;
        const autoWalk = (typeof p.autoWalkOnLand === "number") ? (p.autoWalkOnLand >= 0.5) : true;
        if (autoWalk) p.walkMode = 1;
      }
    }
  }

  p.posX = px; p.posY = py; p.posZ = pz;
  p.targetX = px + fx;
  p.targetY = py + fy;
  p.targetZ = pz + fz;
  p.upX = ux; p.upY = uy; p.upZ = uz;
  // Derive yaw/pitch from forward for display continuity. Roll is
  // implicit in the up vector and not extracted; switching back to
  // walk mode flattens up to world +Y.
  p.pitch = Math.asin(Math.max(-1, Math.min(1, fy)));
  p.yaw   = Math.atan2(fx, fz);
}

/* Phase 7 §5.5.g -- Minimap HUD node renderer. Driven by the
 * presence of a Minimap node in the patch (no toggle pill -- delete
 * the node to hide). Draws the actual terrain top-down from the
 * patch's first TiledTerrain: samples the same fBm formula the
 * mesh builder uses, colors each sample by altitude band, scales
 * up via a tmp canvas + drawImage so 60×60 samples produce a
 * smooth-looking ~200px overlay. Camera dot + heading line render
 * on top. Position controlled by the Minimap node's corner /
 * margin / size params. */
function _ensureMinimapCanvas() {
  let c = document.getElementById("hud-minimap");
  if (c) return c;
  c = document.createElement("canvas");
  c.id = "hud-minimap";
  c.style.cssText =
    "position:fixed;z-index:85;border:1px solid rgba(120,140,170,0.35);" +
    "border-radius:6px;background:rgba(8,11,16,0.55);" +
    "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "box-shadow:0 4px 18px rgba(0,0,0,0.45);pointer-events:none;display:none;";
  document.body.appendChild(c);
  return c;
}

// Re-usable tmp canvas for the heightmap raster. Created once + reused
// every frame to avoid GC churn.
let _minimapTmp = null;

/* Planet minimap: azimuthal-orthographic hemisphere centered on the
 * camera's surface projection. Each pixel maps to (u, v) ∈ [-1, 1];
 * pixels with u² + v² > 1 are background (off the visible hemisphere).
 * For pixels inside the disc, compute the surface direction via
 *   dir = up*sqrt(1 - u² - v²) + east*u + north*v
 * where up = camera-radial, north = projection of world +Y onto the
 * tangent plane (gracefully degenerates when camera is exactly polar
 * by falling back to camera's local up). The cell graph's spatial
 * hash makes per-pixel nearest-cell lookup O(1)-ish (3³ bucket scan
 * × ~15 candidates = ~30 dot products). */
function _renderPlanetMinimap(img, RES, planet, minimapNode) {
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  if (!cam || !cam.params) {
    // Just paint a dark background.
    for (let i = 0; i < RES * RES; i++) {
      img.data[i*4+0] = 8; img.data[i*4+1] = 11; img.data[i*4+2] = 18; img.data[i*4+3] = 255;
    }
    return;
  }
  const cp = cam.params;
  const px = (typeof cp.posX === "number") ? cp.posX : 0;
  const py = (typeof cp.posY === "number") ? cp.posY : 0;
  const pz = (typeof cp.posZ === "number") ? cp.posZ : 0;
  const dx0 = px - planet.centerX, dy0 = py - planet.centerY, dz0 = pz - planet.centerZ;
  const rCam = Math.hypot(dx0, dy0, dz0) || 1;
  // Camera-surface up = radial unit vector
  const upX = dx0 / rCam, upY = dy0 / rCam, upZ = dz0 / rCam;
  // North reference: world +Y projected onto tangent plane. If camera
  // is near polar (radial ≈ world Y), use forward as a tiebreaker.
  let nx = 0, ny = 1, nz = 0;
  let nDotUp = nx*upX + ny*upY + nz*upZ;
  if (Math.abs(nDotUp) > 0.999) {
    // Polar fallback: use camera's local up as the north reference.
    const cux = (typeof cp.upX === "number") ? cp.upX : 0;
    const cuy = (typeof cp.upY === "number") ? cp.upY : 1;
    const cuz = (typeof cp.upZ === "number") ? cp.upZ : 0;
    nx = cux; ny = cuy; nz = cuz;
    nDotUp = nx*upX + ny*upY + nz*upZ;
  }
  // Gram-Schmidt: north = north - (north·up)*up, then normalize.
  nx -= upX * nDotUp; ny -= upY * nDotUp; nz -= upZ * nDotUp;
  const nLen = Math.hypot(nx, ny, nz) || 1;
  nx /= nLen; ny /= nLen; nz /= nLen;
  // East = north × up (right-handed)
  const ex = ny*upZ - nz*upY, ey = nz*upX - nx*upZ, ez = nx*upY - ny*upX;

  const p = minimapNode.params || {};
  const range = Math.max(0.1, Math.min(2.0, p.range || 1.0));   // 1.0 = full hemisphere
  // Sprint 10-5b: cubemap-sourced minimap. Mirrors the planet's actual
  // render path -- _samplePlanetMapCubemap for elev, _earthSurfaceColorAt
  // for color -- so the minimap visually matches what the 3D mesh shows.
  const cubemap = planet.mapNode._cubemap;
  const seaLevel = planet.seaLevel;

  for (let pyi = 0; pyi < RES; pyi++) {
    for (let pxi = 0; pxi < RES; pxi++) {
      const u = ((pxi + 0.5) / RES * 2 - 1) * range;
      const v = ((pyi + 0.5) / RES * 2 - 1) * range;
      const r2 = u*u + v*v;
      const o = (pyi * RES + pxi) * 4;
      if (r2 > 1) {
        // Off the visible hemisphere -- paint deep space.
        img.data[o+0] = 6; img.data[o+1] = 8; img.data[o+2] = 14; img.data[o+3] = 255;
        continue;
      }
      const w = Math.sqrt(1 - r2);
      // North on canvas is screen-up (-v); flip sign to get conventional map.
      const dx = upX*w + ex*u + nx*(-v);
      const dy = upY*w + ey*u + ny*(-v);
      const dz = upZ*w + ez*u + nz*(-v);
      // Cubemap sample + Earth-LUT color. Same lat formula as the chunk
      // builder + Earth cubemap bake so positions / colors are consistent.
      const elev = _samplePlanetMapCubemap(cubemap, dx, dy, dz);
      const latDeg = Math.asin(Math.max(-1, Math.min(1, dy))) * 180 / Math.PI;
      const lonDeg = -Math.atan2(dz, dx) * 180 / Math.PI;
      const col = _earthSurfaceColorAt(latDeg, lonDeg, elev, seaLevel);
      const shade = 0.55 + 0.45 * w;   // curvature shading
      img.data[o+0] = Math.max(0, Math.min(255, Math.floor(col[0] * shade * 255)));
      img.data[o+1] = Math.max(0, Math.min(255, Math.floor(col[1] * shade * 255)));
      img.data[o+2] = Math.max(0, Math.min(255, Math.floor(col[2] * shade * 255)));
      img.data[o+3] = 255;
    }
  }
}

/* Overlay (camera dot + heading line + N label) for the planet minimap.
 * Heading line is the camera's forward direction projected onto the
 * local east/north tangent plane. */
function _drawMinimapCameraOverlay(ctx, W, H, size, planet) {
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  const mx = W * 0.5, my = H * 0.5;
  // Recompute east/north (matches _renderPlanetMinimap convention).
  let headingX = 0, headingY = 1;
  if (cam && cam.params) {
    const cp = cam.params;
    const px = (typeof cp.posX === "number") ? cp.posX : 0;
    const py = (typeof cp.posY === "number") ? cp.posY : 0;
    const pz = (typeof cp.posZ === "number") ? cp.posZ : 0;
    const dx0 = px - planet.centerX, dy0 = py - planet.centerY, dz0 = pz - planet.centerZ;
    const rCam = Math.hypot(dx0, dy0, dz0) || 1;
    const upX = dx0 / rCam, upY = dy0 / rCam, upZ = dz0 / rCam;
    let nx = 0, ny = 1, nz = 0;
    let nDotUp = nx*upX + ny*upY + nz*upZ;
    if (Math.abs(nDotUp) > 0.999) {
      nx = (typeof cp.upX === "number") ? cp.upX : 0;
      ny = (typeof cp.upY === "number") ? cp.upY : 1;
      nz = (typeof cp.upZ === "number") ? cp.upZ : 0;
      nDotUp = nx*upX + ny*upY + nz*upZ;
    }
    nx -= upX * nDotUp; ny -= upY * nDotUp; nz -= upZ * nDotUp;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen; ny /= nLen; nz /= nLen;
    const ex = ny*upZ - nz*upY, ey = nz*upX - nx*upZ, ez = nx*upY - ny*upX;
    // Camera forward (target - pos), projected onto east/north plane.
    const tx = (typeof cp.targetX === "number") ? cp.targetX : 0;
    const ty = (typeof cp.targetY === "number") ? cp.targetY : 0;
    const tz = (typeof cp.targetZ === "number") ? cp.targetZ : 1;
    const fx = tx - px, fy = ty - py, fz = tz - pz;
    headingX = fx*ex + fy*ey + fz*ez;
    headingY = fx*nx + fy*ny + fz*nz;
    const hl = Math.hypot(headingX, headingY) || 1;
    headingX /= hl; headingY /= hl;
  }
  const len = Math.max(10, size * 0.10);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = Math.max(1.4, size * 0.012);
  ctx.beginPath();
  ctx.moveTo(mx, my);
  // Canvas Y grows downward; screen-up = -Y. headingY=+1 means "north"
  // which we want at the top of the minimap.
  ctx.lineTo(mx + headingX * len, my - headingY * len);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 220, 90, 1)";
  ctx.strokeStyle = "rgba(20, 20, 20, 0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mx, my, Math.max(3.5, size * 0.022), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = Math.max(10, Math.floor(size * 0.06)) + "px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText("N", W * 0.5, 14);
  ctx.textAlign = "left";

  // Scale label: hemisphere arc-distance from center to disc edge.
  // At range=1.0 the disc edge is the horizon (angular dist = 90°
  // around the planet, ~10000 km on Earth). Useful as a magnitude
  // marker -- not a strict scale bar.
  const arcKm = (planet.radius * Math.PI * 0.5 / 1000) * 1.0;
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText(Math.round(arcKm).toLocaleString() + " km horizon", 6, H - 6);
}

function _tickMinimapNodes() {
  if (!state || !Array.isArray(state.nodes)) return;
  const minimapNode = state.nodes.find(n => n && n.type === "Minimap");
  const canvas = _ensureMinimapCanvas();
  // HUD overlays only show in live mode. Otherwise the patch
  // editor's node graph competes with the overlay for the corner.
  if (!minimapNode || (typeof isLiveMode === "function" && !isLiveMode())) {
    canvas.style.display = "none";
    return;
  }
  // §5.5.g -- HUD overlays require the Minimap to be wired into a
  // Scene's hud1..hud4 input. The wire establishes "this minimap
  // belongs to this scene". If unwired, hide -- the user must drop
  // a wire to make it appear, so demos using multiple Scenes can
  // route HUDs to specific ones.
  const hudWire = state.edges && state.edges.find(e =>
    e && e.from && e.from.node === minimapNode.id && e.from.port === "hud"
  );
  if (!hudWire || !hudWire.to) {
    canvas.style.display = "none";
    return;
  }
  // Source: prefer a planet (PlanetMap with built cells) -- planet
  // patches show an azimuthal-ortho hemisphere centered on the
  // camera's surface projection. Fall back to TiledTerrain for the
  // legacy XZ heightmap minimap. If neither, hide.
  const planet = _findPlanetInfo();
  // Sprint 10-5b: minimap now reads from the baked Earth cubemap, not
  // from cells (Earth mode skips the cell graph entirely). cubemap is
  // baked lazily; ensure it before checking ready-ness.
  if (planet && planet.mapNode && !planet.mapNode._cubemap) {
    try { _ensurePlanetMapCubemap(planet.mapNode); } catch (_) {}
  }
  const planetReady = planet && planet.mapNode && planet.mapNode._cubemap;
  const tt = planetReady ? null : state.nodes.find(n => n && n.type === "TiledTerrain");
  if (!planetReady && (!tt || !tt.params)) {
    canvas.style.display = "none";
    return;
  }
  const p   = minimapNode.params || {};
  const size   = Math.max(80, Math.min(600, p.size   || 200));
  const margin = Math.max(0, p.margin || 18);
  const opacity = Math.max(0.05, Math.min(1.0, (typeof p.opacity === "number") ? p.opacity : 0.90));
  const range  = Math.max(0.1, Math.min(10, p.range || 1.0));
  const corner = (typeof p.corner === "string") ? p.corner : "top-right";

  canvas.style.display = "block";
  canvas.style.opacity = opacity;
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width  = size;
    canvas.height = size;
  }
  canvas.style.width  = size + "px";
  canvas.style.height = size + "px";
  canvas.style.top = canvas.style.bottom = canvas.style.left = canvas.style.right = "";
  if (corner === "top-right") { canvas.style.top = margin + "px"; canvas.style.right = margin + "px"; }
  else if (corner === "top-left") { canvas.style.top = margin + "px"; canvas.style.left = margin + "px"; }
  else if (corner === "bottom-left") { canvas.style.bottom = margin + "px"; canvas.style.left = margin + "px"; }
  else { canvas.style.bottom = margin + "px"; canvas.style.right = margin + "px"; }

  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  const RES = Math.min(96, Math.max(32, Math.floor(size / 3)));
  if (!_minimapTmp || _minimapTmp.width !== RES) {
    _minimapTmp = document.createElement("canvas");
    _minimapTmp.width  = RES;
    _minimapTmp.height = RES;
  }
  const tmpCtx = _minimapTmp.getContext("2d");
  const img = tmpCtx.createImageData(RES, RES);

  if (planetReady) {
    _renderPlanetMinimap(img, RES, planet, minimapNode);
    tmpCtx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(_minimapTmp, 0, 0, W, H);
    _drawMinimapCameraOverlay(ctx, W, H, size, planet);
    return;
  }


  // World disc covered by the minimap. Range=1 matches the terrain's
  // visible-chunk disc; larger range shows more world (zoomed out).
  const ttp = tt.params;
  const cs  = Math.max(1, ttp.chunkSize || 64);
  const r   = Math.max(0, Math.floor(ttp.chunkRadius || 0));
  const visibleDiameter = (2 * r + 1) * cs;
  const worldDiameter   = visibleDiameter * range;
  const noise = {
    seed:       (typeof ttp.seed       === "number") ? ttp.seed       : 7.42,
    frequency:  (typeof ttp.frequency  === "number") ? ttp.frequency  : 0.008,
    octaves:    (typeof ttp.octaves    === "number") ? ttp.octaves    : 6,
    lacunarity: (typeof ttp.lacunarity === "number") ? ttp.lacunarity : 2.05,
    gain:       (typeof ttp.gain       === "number") ? ttp.gain       : 0.5,
    ridges:     (typeof ttp.ridges     === "number") ? ttp.ridges     : 0.0,
    plateau:    (typeof ttp.plateau    === "number") ? ttp.plateau    : 0.0,
    // §5.5.e-8 -- intentionally NOT applying erosion here (8 neighbor
    // samples × iterations would burn tens of ms per frame). The
    // map silhouette + altitude bands are good enough without it.
    // Island params ARE applied (cheap -- 1 mask sample per pixel)
    // so the minimap correctly shows the archipelago silhouette.
    islandParams: _findTiledIslandParams(tt)
  };
  // Center the disc on the wired camera (or origin if none).
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  let camX = 0, camZ = 0, camYaw = 0;
  if (cam && cam.params) {
    camX = (typeof cam.params.posX === "number") ? cam.params.posX : 0;
    camZ = (typeof cam.params.posZ === "number") ? cam.params.posZ : 0;
    camYaw = (typeof cam.params.yaw === "number") ? cam.params.yaw : 0;
  }

  // Fill pixel buffer. Each pixel = one fBm sample colored by band.
  for (let py = 0; py < RES; py++) {
    for (let px = 0; px < RES; px++) {
      const u = (px + 0.5) / RES;
      const v = (py + 0.5) / RES;
      const wx = camX + (u - 0.5) * worldDiameter;
      const wz = camZ + (v - 0.5) * worldDiameter;
      const h01 = _tiledTerrainHeightAt(wx, wz, noise);
      let rT, gT, bT;
      if (h01 < 0.25) {
        const t = h01 / 0.25;
        rT = 0.20 + t * 0.20; gT = 0.32 + t * 0.30; bT = 0.55 - t * 0.20;
      } else if (h01 < 0.55) {
        const t = (h01 - 0.25) / 0.30;
        rT = 0.36 + t * 0.10; gT = 0.58 - t * 0.12; bT = 0.26 + t * 0.04;
      } else if (h01 < 0.80) {
        const t = (h01 - 0.55) / 0.25;
        rT = 0.48 + t * 0.20; gT = 0.42 + t * 0.18; bT = 0.36 + t * 0.10;
      } else {
        const t = (h01 - 0.80) / 0.20;
        rT = 0.85 + t * 0.15; gT = 0.86 + t * 0.14; bT = 0.88 + t * 0.12;
      }
      // §5.5.e-11 -- LERP terrain color toward ocean blue based on
      // island land-amount. Shows the archipelago silhouette on the
      // minimap exactly the way the rendered mesh shows it in 3D.
      const land = noise.islandParams ? _tiledIslandLandAmount(wx, wz, noise.islandParams) : 1;
      const rC = rT * land + 0.08 * (1 - land);
      const gC = gT * land + 0.18 * (1 - land);
      const bC = bT * land + 0.38 * (1 - land);
      // Cheap hillshade -- darken by a finite-diff slope in X so
      // the map reads as 3D-feeling instead of flat color blobs.
      const dx = 1.0 / RES * worldDiameter * 0.5;
      const hL = (px > 0)       ? _tiledTerrainHeightAt(wx - dx, wz, noise) : h01;
      const hR = (px < RES - 1) ? _tiledTerrainHeightAt(wx + dx, wz, noise) : h01;
      const shade = 1.0 + (hL - hR) * 0.6 * land;
      const o = (py * RES + px) * 4;
      img.data[o + 0] = Math.max(0, Math.min(255, Math.floor(rC * shade * 255)));
      img.data[o + 1] = Math.max(0, Math.min(255, Math.floor(gC * shade * 255)));
      img.data[o + 2] = Math.max(0, Math.min(255, Math.floor(bC * shade * 255)));
      img.data[o + 3] = 255;
    }
  }
  tmpCtx.putImageData(img, 0, 0);
  // Scale up to canvas size using browser smoothing.
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(_minimapTmp, 0, 0, W, H);

  // Camera dot + heading line at the canvas center (camera is the
  // anchor for the disc so it's always centered).
  const mx = W * 0.5, my = H * 0.5;
  const len = Math.max(10, size * 0.10);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = Math.max(1.4, size * 0.012);
  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(mx + Math.sin(camYaw) * len, my + Math.cos(camYaw) * len);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 220, 90, 1)";
  ctx.strokeStyle = "rgba(20, 20, 20, 0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mx, my, Math.max(3.5, size * 0.022), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Compass label (north arrow). In our convention yaw=0 looks +Z,
  // which is "south" by typical map orientation -- N points -Z so
  // it draws at the top when camYaw=0 (where forward is +Z = south
  // on the map). Just label the screen-up direction "N" so users
  // get a stable orientation reference.
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = Math.max(10, Math.floor(size * 0.06)) + "px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText("N", W * 0.5, 14);
  ctx.textAlign = "left";

  // Scale label.
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText(`${Math.round(worldDiameter).toLocaleString()}m`, 6, H - 6);
}

/* Phase 7 §5.5.h-27 -- Altimeter HUD overlay. Renders a small
 * fixed-position canvas in a screen corner with the patch's
 * FPCamera/Camera altitude + optional speed indicator. */
function _ensureAltimeterCanvas() {
  let c = document.getElementById("hud-altimeter");
  if (c) return c;
  c = document.createElement("canvas");
  c.id = "hud-altimeter";
  c.style.cssText =
    "position:fixed;z-index:85;border:1px solid rgba(120,140,170,0.35);" +
    "border-radius:6px;background:rgba(8,11,16,0.55);" +
    "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "box-shadow:0 4px 18px rgba(0,0,0,0.45);pointer-events:none;display:none;";
  document.body.appendChild(c);
  return c;
}

/* Sprint 10-5b -- fly-to-coordinates panel + walk/fly mode toggle.
 * DOM overlay (not canvas) so we can use real inputs + buttons.
 * Positioned just below the altimeter HUD. Shown whenever the HUD is. */
function _ensureFlyToPanel() {
  let panel = document.getElementById("hud-flyto");
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "hud-flyto";
  panel.style.cssText =
    "position:fixed;z-index:86;border:1px solid rgba(120,140,170,0.35);" +
    "border-radius:6px;background:rgba(8,11,16,0.62);" +
    "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "box-shadow:0 4px 18px rgba(0,0,0,0.45);" +
    "padding:8px 10px;color:rgba(255,255,255,0.88);" +
    "font:11px ui-monospace,'SF Mono',Menlo,monospace;display:none;" +
    "pointer-events:auto;user-select:none;width:240px;box-sizing:border-box;";
  const inputCss = "width:62px;padding:2px 4px;background:rgba(0,0,0,0.4);"
                 + "border:1px solid rgba(120,140,170,0.3);border-radius:3px;"
                 + "color:rgba(255,255,255,0.95);font:inherit;text-align:right;";
  const btnCss = "padding:4px 8px;background:rgba(70,90,120,0.55);"
               + "border:1px solid rgba(140,170,200,0.5);border-radius:3px;"
               + "color:rgba(255,255,255,0.95);font:inherit;cursor:pointer;flex:1;";
  panel.innerHTML = ''
    + '<div style="display:grid;grid-template-columns:30px 1fr 30px 1fr;gap:4px 4px;align-items:center;margin-bottom:6px;">'
    + '  <span style="opacity:0.7;">LAT</span><input id="flyto-lat" type="number" step="0.5" placeholder="0" style="' + inputCss + '"/>'
    + '  <span style="opacity:0.7;">LON</span><input id="flyto-lon" type="number" step="0.5" placeholder="0" style="' + inputCss + '"/>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:30px 1fr 30px 1fr;gap:4px 4px;align-items:center;margin-bottom:6px;">'
    + '  <span style="opacity:0.7;">ALT</span><input id="flyto-alt" type="number" step="10" placeholder="100" style="' + inputCss + '"/>'
    + '  <span style="opacity:0.5;">km</span><span></span>'
    + '</div>'
    + '<div style="display:flex;gap:4px;">'
    + '  <button id="flyto-go"   style="' + btnCss + '">FLY TO</button>'
    + '  <button id="flyto-mode" style="' + btnCss + '">MODE: WALK</button>'
    + '</div>';
  document.body.appendChild(panel);
  panel.querySelector("#flyto-go").addEventListener("click", _flyToGoClicked);
  panel.querySelector("#flyto-mode").addEventListener("click", _flyToModeClicked);
  // Prevent input keystrokes from being captured by the WASD camera.
  for (const inp of panel.querySelectorAll("input")) {
    inp.addEventListener("keydown", (e) => e.stopPropagation());
    inp.addEventListener("keyup",   (e) => e.stopPropagation());
  }
  return panel;
}

function _flyToGoClicked() {
  const panel = document.getElementById("hud-flyto");
  if (!panel || !state || !Array.isArray(state.nodes)) return;
  const latDeg = parseFloat(panel.querySelector("#flyto-lat").value);
  const lonDeg = parseFloat(panel.querySelector("#flyto-lon").value);
  const altKm  = parseFloat(panel.querySelector("#flyto-alt").value);
  if (isNaN(latDeg) || isNaN(lonDeg)) { console.warn("[flyto] lat/lon required"); return; }
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  const pl = _findPlanetInfo();
  if (!cam || !cam.params || !pl) { console.warn("[flyto] need wired Camera + Planet"); return; }
  const altM = (isNaN(altKm) ? 100 : altKm) * 1000;
  const latR = latDeg * Math.PI / 180;
  const lonR = lonDeg * Math.PI / 180;
  const cosLat = Math.cos(latR);
  // Sprint 10-6 v6: convert user-friendly lon to internal coords with
  // an east-west flip. The bake stores real-world east at internal -Z
  // direction (so it renders on screen RIGHT). For user typing lon=87
  // to land at the same place the cubemap put real-world lon=87 data,
  // we negate the uz component: internal_lon = -user_lon.
  const ux = cosLat * Math.cos(lonR);
  const uy = Math.sin(latR);
  const uz = -cosLat * Math.sin(lonR);
  const rAlt = pl.radius + altM;
  const newPx = pl.centerX + rAlt * ux;
  const newPy = pl.centerY + rAlt * uy * pl.polRatio;
  const newPz = pl.centerZ + rAlt * uz;
  cam.params.posX = newPx;
  cam.params.posY = newPy;
  cam.params.posZ = newPz;
  // Sprint 10-6 v5: set camera orientation on teleport.
  // Previously target/up survived from pre-teleport orientation,
  // meaning "forward" pointed in whatever direction the camera last
  // happened to face -- usually NOT a useful direction at the new
  // lat/lon. Now we set:
  //   up      = radial outward (camera upright on the surface)
  //   forward = local east (along +lon tangent)
  // So pressing W after teleport reliably moves you eastward, and
  // mouse-look rotates around the local horizon plane as expected.
  // Tangent basis at (lat, lon):
  //   east  = (-sinLon, 0, -cosLon)  ← Z negated for v6 east-west flip
  //   up    = (cosLat*cosLon, sinLat, -cosLat*sinLon) = (ux, uy, uz)
  // East tangent points in the direction of increasing user_lon. Since
  // internal_lon = -user_lon, increasing user_lon = decreasing internal_lon,
  // and the tangent of decreasing internal_lon is the negation of the
  // standard east tangent (-sinLon, 0, cosLon) → (-sinLon, 0, -cosLon).
  // Same world direction as the cubemap's east hemisphere (now on
  // screen RIGHT).
  const sinLon = Math.sin(lonR), cosLon = Math.cos(lonR);
  const eastX = -sinLon, eastY = 0, eastZ = -cosLon;
  cam.params.upX = ux; cam.params.upY = uy; cam.params.upZ = uz;
  cam.params.targetX = newPx + eastX;
  cam.params.targetY = newPy + eastY;
  cam.params.targetZ = newPz + eastZ;
  // Engage fly mode so we don't immediately snap to terrain on arrival.
  cam.params.walkMode = 0;
  // Reset cached surf so walk-mode (if you switch later) doesn't try
  // to use a surf from the old location.
  const fpcInput = Visual.fpcInput;
  if (fpcInput) {
    fpcInput._cachedSurf = null;
    fpcInput._cachedSurfTime = 0;
  }
  console.log("[flyto] teleported to lat=" + latDeg.toFixed(2) + " lon=" + lonDeg.toFixed(2)
              + " alt=" + (altM/1000).toFixed(0) + "km (mode=FLY, facing east)");
}

function _flyToModeClicked() {
  if (!state || !Array.isArray(state.nodes)) return;
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  if (!cam || !cam.params) return;
  const cur = (typeof cam.params.walkMode === "number") ? cam.params.walkMode : 1;
  cam.params.walkMode = (cur >= 0.5) ? 0 : 1;
  console.log("[flyto] mode -> " + (cam.params.walkMode >= 0.5 ? "WALK" : "FLY"));
}

function _tickAltimeterNodes() {
  if (!state || !Array.isArray(state.nodes)) return;
  const altNode = state.nodes.find(n => n && n.type === "Altimeter");
  const canvas = _ensureAltimeterCanvas();
  if (!altNode || (typeof isLiveMode === "function" && !isLiveMode())) {
    canvas.style.display = "none";
    return;
  }
  const hudWire = state.edges && state.edges.find(e =>
    e && e.from && e.from.node === altNode.id && e.from.port === "hud"
  );
  if (!hudWire || !hudWire.to) {
    canvas.style.display = "none";
    return;
  }
  const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
  if (!cam || !cam.params) {
    canvas.style.display = "none";
    return;
  }
  const p = altNode.params || {};
  const corner    = (typeof p.corner === "string") ? p.corner : "top-left";
  const margin    = Math.max(0, p.margin || 18);
  const opacity   = Math.max(0.05, Math.min(1.0, (typeof p.opacity === "number") ? p.opacity : 0.90));
  const showSpeed = ((typeof p.showSpeed === "number") ? p.showSpeed : 1) >= 0.5;

  const posX = (typeof cam.params.posX === "number") ? cam.params.posX : 0;
  const posY = (typeof cam.params.posY === "number") ? cam.params.posY : 0;
  const posZ = (typeof cam.params.posZ === "number") ? cam.params.posZ : 0;

  // §planet-spec Phase 7.h-overhaul -- globe altimeter.
  //   MSL = |camera - planet_center| - planet_radius
  //   AGL = MSL - heightmap_at_camera's_surface_projection
  // For terrain patches (no planet), MSL falls back to plain posY
  // (legacy behavior) and AGL is hidden.
  let mslMeters = posY, aglMeters = null;
  let latDeg = null, lonDeg = null;
  const pl = _findPlanetInfo();
  if (pl) {
    const dx = posX - pl.centerX, dy = posY - pl.centerY, dz = posZ - pl.centerZ;
    const r = Math.hypot(dx, dy, dz);
    mslMeters = r - pl.radius;
    // Sprint 10-5b: latitude / longitude readout. Camera-to-center
    // direction projected on the unit sphere; same convention as
    // _buildEarthCubemap (lat = asin(uy), lon = atan2(uz, ux)) so
    // probe locations the user reads off the HUD match the DEM
    // sample locations exactly.
    if (r > 1e-6) {
      const ux = dx / r, uy = dy / r, uz = dz / r;
      latDeg = Math.asin(Math.max(-1, Math.min(1, uy))) * 180 / Math.PI;
      // Sprint 10-6 v6: negate atan2(uz,ux) so display matches the
      // visible planet orientation (east on screen RIGHT). Right-handed
      // lookAt puts world +Z on screen LEFT, so what's at internal
      // lon=+90 (atan2=+90) appears on the user's left; we want the
      // HUD to report real-world lon (east=positive).
      lonDeg = -Math.atan2(uz, ux) * 180 / Math.PI;
    }
    // Sprint 8-8: AGL via shared _planetMeshSurfacePos helper. It
    // applies the polRatio-corrected unit-sphere direction (matches
    // _buildPlanetMesh + per-frame detail-patch encoder), looks up
    // the cell, and uses the (R + alt, R*pr + alt, R + alt) surface-
    // position formula so AGL stays consistent with what walk mode
    // and flight collision see -- no more 4km readout error on
    // non-equator mountains.
    const surf = _planetMeshSurfacePos(posX, posY, posZ, pl);
    // Sprint 10-5b-fix v3: drop the `_cells` requirement -- Earth mode
    // has no cells but still has a cubemap, and _planetMeshSurfacePos
    // returns a real surf in that case. AGL now reads correctly in
    // Earth mode (was always null -> hidden -> the "no AGL" symptom).
    if (surf && pl.mapNode) {
      const sdx = surf.x - pl.centerX, sdy = surf.y - pl.centerY, sdz = surf.z - pl.centerZ;
      aglMeters = r - Math.hypot(sdx, sdy, sdz);
    }
  }

  const fmtAlt = function(m) {
    const a = Math.abs(m);
    if (a >= 1000) return (m / 1000).toFixed(a >= 100000 ? 0 : 2) + " km";
    return m.toFixed(0) + " m";
  };
  const fmtLat = function(d) {
    return Math.abs(d).toFixed(3) + "° " + (d >= 0 ? "N" : "S");
  };
  const fmtLon = function(d) {
    return Math.abs(d).toFixed(3) + "° " + (d >= 0 ? "E" : "W");
  };
  // §bonus-perf-foot-12 (2026-05-25) -- user feedback: MSL is
  // unreliable (terrain-relative changes don't reflect in MSL when
  // moving across continents at constant AGL); AGL is what the
  // player actually feels. Promote AGL to the primary big readout;
  // MSL falls back only when AGL isn't computable (no planet, or
  // surface sample failed).
  const primary = (aglMeters !== null) ? aglMeters : mslMeters;
  const primaryLabel = (aglMeters !== null) ? "AGL" : (pl ? "MSL" : "ALT");
  const primaryStr = fmtAlt(primary);
  const latStr = (latDeg === null) ? null : fmtLat(latDeg);
  const lonStr = (lonDeg === null) ? null : fmtLon(lonDeg);

  const W = 240;
  let H = 44;
  if (latStr !== null)              H += 22;
  if (lonStr !== null)              H += 22;
  if (showSpeed)                    H += 32;

  canvas.style.display = "block";
  canvas.style.opacity = opacity;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
  }
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  canvas.style.top = canvas.style.bottom = canvas.style.left = canvas.style.right = "";
  if (corner === "top-right")    { canvas.style.top    = margin + "px"; canvas.style.right = margin + "px"; }
  else if (corner === "top-left"){ canvas.style.top    = margin + "px"; canvas.style.left  = margin + "px"; }
  else if (corner === "bottom-left") { canvas.style.bottom = margin + "px"; canvas.style.left  = margin + "px"; }
  else                           { canvas.style.bottom = margin + "px"; canvas.style.right = margin + "px"; }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  let y = 16;
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText(primaryLabel, 12, y);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "bold 22px ui-monospace, monospace";
  ctx.fillText(primaryStr, 12, y + 22);
  y += 38;

  if (latStr !== null) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("LAT", 12, y);
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.font = "bold 14px ui-monospace, monospace";
    ctx.fillText(latStr, 40, y);
    y += 22;
  }
  if (lonStr !== null) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("LON", 12, y);
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.font = "bold 14px ui-monospace, monospace";
    ctx.fillText(lonStr, 40, y);
    y += 22;
  }

  if (showSpeed) {
    const baseSpeed = (typeof cam.params.walkSpeed === "number") ? cam.params.walkSpeed : 10;
    let speedStr;
    if (baseSpeed >= 1000) speedStr = (baseSpeed / 1000).toFixed(2) + " km/s";
    else                   speedStr = Math.round(baseSpeed) + " m/s";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("SPEED  " + speedStr + "  (×4 sprint)", 12, y + 12);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillText("hold X faster · Z slower", 12, y + 24);
  }

  // Sprint 10-5b: fly-to panel + mode toggle. Position it just below
  // the altimeter HUD on the same corner. Only shown when a Planet is
  // wired (lat/lon teleport needs a planet center to project against).
  const flyPanel = _ensureFlyToPanel();
  if (pl) {
    flyPanel.style.display = "block";
    flyPanel.style.opacity = opacity;
    flyPanel.style.top = flyPanel.style.bottom = flyPanel.style.left = flyPanel.style.right = "";
    const gap = 6;
    if (corner === "top-right") {
      flyPanel.style.top = (margin + H + gap) + "px";
      flyPanel.style.right = margin + "px";
    } else if (corner === "top-left") {
      flyPanel.style.top = (margin + H + gap) + "px";
      flyPanel.style.left = margin + "px";
    } else if (corner === "bottom-left") {
      flyPanel.style.bottom = (margin + H + gap) + "px";
      flyPanel.style.left = margin + "px";
    } else {
      flyPanel.style.bottom = (margin + H + gap) + "px";
      flyPanel.style.right = margin + "px";
    }
    // Update mode button label each tick.
    const modeBtn = flyPanel.querySelector("#flyto-mode");
    if (modeBtn) {
      const isWalk = ((typeof cam.params.walkMode === "number") ? cam.params.walkMode : 1) >= 0.5;
      modeBtn.textContent = isWalk ? "MODE: WALK → FLY" : "MODE: FLY → WALK";
    }
  } else {
    flyPanel.style.display = "none";
  }
}

/* Sprint hud-text -- per-node canvas factory for HUDText. Each node
 * gets its own canvas keyed by node id so multiple HUDText nodes
 * coexist without trampling each other. position:fixed lets us pin
 * to a screen corner regardless of viewport scroll / layout. */
function _ensureHudTextCanvas(nodeId) {
  const id = "hud-text-" + nodeId;
  let c = document.getElementById(id);
  if (c) return c;
  c = document.createElement("canvas");
  c.id = id;
  c.style.cssText =
    "position:fixed;z-index:84;border:1px solid rgba(120,140,170,0.35);" +
    "border-radius:6px;background:rgba(8,11,16,0.55);" +
    "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "box-shadow:0 4px 18px rgba(0,0,0,0.45);pointer-events:none;display:none;";
  document.body.appendChild(c);
  return c;
}

/* ── Phase 8.D.1 -- UI node rendering + pointer events ────────────
 *
 * UIButton / UIText / UIPanel each get their own absolute-positioned
 * canvas overlay. UIButton's canvas has pointer-events: auto + click
 * listeners; the others are passive (pointer-events: none).
 *
 * customRender param: when set, runs as a JS function body with
 * (ctx, p, input) in scope, replacing the default render. Lets users
 * draw fully custom widgets without leaving the node graph. */
function _ensureUiCanvas(node) {
  const id = "ui-canvas-" + node.id;
  let c = document.getElementById(id);
  if (c) return c;
  c = document.createElement("canvas");
  c.id = id;
  // UIButton is always interactive; UIText/UIPanel honor their
  // node.params.interactive flag (toggleable each tick, see
  // _tickUiNodes which updates pointer-events live).
  const startInteractive = _uiNodeIsInteractive(node);
  c.style.cssText =
    "position:fixed;z-index:85;pointer-events:" + (startInteractive ? "auto" : "none") +
    ";display:none;cursor:" + (startInteractive ? "pointer" : "default") + ";";
  document.body.appendChild(c);
  // Wire events on EVERY UI canvas; the pointer-events: none style
  // makes them no-ops when the node isn't interactive. Avoids
  // having to bind/unbind listeners when interactive toggles.
  _wireUiButtonEvents(node, c);
  return c;
}

function _uiNodeIsInteractive(node) {
  if (!node) return false;
  if (node.type === "UIButton" || node.type === "UISlider") return true;
  const v = node.params && node.params.interactive;
  return (typeof v === "number") && v >= 0.5;
}

function _wireUiButtonEvents(node, canvas) {
  canvas.addEventListener("pointerenter", () => { node._uiHover = true; });
  canvas.addEventListener("pointerleave", () => { node._uiHover = false; node._uiPressed = false; });
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    node._uiPressed = true;
    if (node.type === "UISlider") {
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      node._uiDragX = e.clientX - rect.left;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (node._uiPressed && node.type === "UISlider") {
      const rect = canvas.getBoundingClientRect();
      node._uiDragX = e.clientX - rect.left;
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    if (node._uiPressed) {
      e.preventDefault();
      node._uiPendingClick = true;
      node._uiPressed = false;
      if (node.type === "UISlider") node._uiDragX = undefined;
    }
  });
}

function _resolveUiAnchorPos(node, w, h) {
  const p = node.params || {};
  const corner = (typeof p.corner === "string") ? p.corner : "center";
  const x = (typeof p.x === "number") ? p.x : 0;
  const y = (typeof p.y === "number") ? p.y : 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left, top;
  if      (corner === "top-left")     { left = x;             top = y; }
  else if (corner === "top-right")    { left = vw - w - x;    top = y; }
  else if (corner === "bottom-left")  { left = x;             top = vh - h - y; }
  else if (corner === "bottom-right") { left = vw - w - x;    top = vh - h - y; }
  else /* center */                   { left = vw * 0.5 - w * 0.5 + x; top = vh * 0.5 - h * 0.5 + y; }
  return { left, top };
}

/* Compile + cache a customRender function per (node, code) pair so we
 * don't re-parse the JS every tick. Cleared when the code string
 * changes. Errors fall back to the default renderer + log once. */
function _runCustomRender(node, ctx, code, input) {
  if (typeof code !== "string" || !code.trim()) return false;
  if (node._uiCustomFnCode !== code) {
    try {
      node._uiCustomFn = new Function("ctx", "p", "input", code);
    } catch (e) {
      if (!node._uiCustomErrLogged) {
        node._uiCustomErrLogged = true;
        console.warn("[ui " + node.id + "] customRender parse error: " + e.message);
      }
      node._uiCustomFn = null;
    }
    node._uiCustomFnCode = code;
  }
  if (!node._uiCustomFn) return false;
  try {
    node._uiCustomFn(ctx, node.params || {}, input || {});
    return true;
  } catch (e) {
    if (!node._uiCustomRunErrLogged) {
      node._uiCustomRunErrLogged = true;
      console.warn("[ui " + node.id + "] customRender runtime error: " + e.message);
    }
    return false;
  }
}

function _drawUiButtonDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const hovered = !!input.hovered;
  const bg = hovered ? (p.hoverColor || "#5f7a98") : (p.color || "#3a4a60");
  const fg = p.textColor || "#ffffff";
  const border = p.borderColor || "#9bd0ff";
  const bw = (typeof p.borderWidth === "number") ? p.borderWidth : 1.5;
  const radius = Math.max(0, (typeof p.borderRadius === "number") ? p.borderRadius : 6);
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.95;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(bw, bw, w - 2*bw, h - 2*bw, radius);
  else ctx.rect(bw, bw, w - 2*bw, h - 2*bw);
  ctx.fillStyle = bg;   ctx.fill();
  ctx.lineWidth = bw;   ctx.strokeStyle = border; ctx.stroke();
  ctx.fillStyle = fg;
  ctx.font = (p.fontSize || 16) + "px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(p.label || ""), w * 0.5, h * 0.5);
  ctx.globalAlpha = 1;
}

function _drawUiTextDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const resolved = _resolveNodeParams ? _resolveNodeParams(input.node) : (input.node ? input.node.params : p);
  const text = (typeof resolved.text === "string") ? resolved.text :
               (Number.isFinite(resolved.text) ? String(resolved.text) : String(p.text || ""));
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.95;
  ctx.fillStyle = p.color || "#ffffff";
  ctx.font = (p.fontSize || 24) + "px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const align = p.align || "center";
  ctx.textAlign = align;
  const x = (align === "left") ? 0 : (align === "right") ? w : w * 0.5;
  ctx.fillText(text, x, h * 0.5);
  ctx.globalAlpha = 1;
}

function _drawUiPanelDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const radius = Math.max(0, (typeof p.borderRadius === "number") ? p.borderRadius : 8);
  const bw = (typeof p.borderWidth === "number") ? p.borderWidth : 1;
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.85;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(bw, bw, w - 2*bw, h - 2*bw, radius);
  else ctx.rect(bw, bw, w - 2*bw, h - 2*bw);
  ctx.fillStyle = p.color || "#0a0e16"; ctx.fill();
  if (bw > 0) { ctx.lineWidth = bw; ctx.strokeStyle = p.borderColor || "#5a7090"; ctx.stroke(); }
  ctx.globalAlpha = 1;
}

function _drawUiSliderDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const bw = (typeof p.borderWidth === "number") ? p.borderWidth : 1;
  const radius = Math.max(0, (typeof p.borderRadius === "number") ? p.borderRadius : 4);
  const min = typeof p.min === "number" ? p.min : 0;
  const max = typeof p.max === "number" ? p.max : 1;
  const range = max - min || 1;
  const val = typeof p.value === "number" ? p.value : min;
  const t = Math.max(0, Math.min(1, (val - min) / range));

  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.95;

  // Track background
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(bw, bw, w - 2 * bw, h - 2 * bw, radius);
  else ctx.rect(bw, bw, w - 2 * bw, h - 2 * bw);
  ctx.fillStyle = p.trackColor || "#2a3a50"; ctx.fill();
  if (bw > 0) { ctx.lineWidth = bw; ctx.strokeStyle = p.borderColor || "#5a7090"; ctx.stroke(); }

  // Fill bar
  const pad = bw + 2;
  const fillW = Math.max(0, (w - 2 * pad) * t);
  if (fillW > 0) {
    ctx.beginPath();
    const fr = Math.min(radius - 1, fillW * 0.5);
    if (typeof ctx.roundRect === "function") ctx.roundRect(pad, pad, fillW, h - 2 * pad, [fr, 0, 0, fr]);
    else ctx.rect(pad, pad, fillW, h - 2 * pad);
    ctx.fillStyle = p.fillColor || "#5a8ab0"; ctx.fill();
  }

  // Handle
  const handleX = pad + (w - 2 * pad) * t;
  const handleR = (h - 2 * pad) * 0.5;
  ctx.beginPath();
  ctx.arc(handleX, h * 0.5, Math.max(4, handleR), 0, Math.PI * 2);
  ctx.fillStyle = input.pressed ? "#ffffff" : (p.handleColor || "#cfe9ff");
  ctx.fill();

  // Label + value text
  const fs = typeof p.fontSize === "number" ? p.fontSize : 11;
  ctx.font = fs + "px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = p.textColor || "#cfe9ff";
  ctx.textBaseline = "middle";
  const label = (typeof p.label === "string" && p.label) ? p.label : "";
  if (label) {
    ctx.textAlign = "left";
    ctx.fillText(label, pad + 4, h * 0.5);
  }
  if ((typeof p.showValue === "number" ? p.showValue : 1) >= 0.5) {
    const step = typeof p.step === "number" ? p.step : 0;
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 2;
    ctx.textAlign = "right";
    ctx.fillText(val.toFixed(decimals), w - pad - 4, h * 0.5);
  }
  ctx.globalAlpha = 1;
}

function _leaderboardLoad(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(e => e && typeof e.score === "number" && isFinite(e.score));
  } catch (_) { return []; }
}
function _leaderboardSave(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (_) {}
}

function _drawLeaderboardDefault(ctx, p, input) {
  const w = input.width, h = input.height;
  const radius = Math.max(0, (typeof p.borderRadius === "number") ? p.borderRadius : 8);
  const bw = (typeof p.borderWidth === "number") ? p.borderWidth : 2;
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.94;
  // Panel background
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(bw, bw, w - 2*bw, h - 2*bw, radius);
  else ctx.rect(bw, bw, w - 2*bw, h - 2*bw);
  ctx.fillStyle = p.color || "#0a1018"; ctx.fill();
  if (bw > 0) { ctx.lineWidth = bw; ctx.strokeStyle = p.borderColor || "#ff8844"; ctx.stroke(); }

  const padX = 18, padY = 14;
  const titleFs = typeof p.titleFontSize === "number" ? p.titleFontSize : 18;
  const rowFs   = typeof p.fontSize       === "number" ? p.fontSize       : 14;

  // Title
  ctx.font = "600 " + titleFs + "px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = p.titleColor || "#ff8844";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  const title = (typeof p.title === "string") ? p.title : "TOP SCORES";
  ctx.fillText(title, w * 0.5, padY);

  // Entries
  const list = _leaderboardLoad(p.lsKey || "gamma-leaderboard-v1");
  list.sort((a, b) => b.score - a.score);
  const max = Math.max(1, Math.min(20, Math.round(p.maxEntries || 5)));
  const top = list.slice(0, max);
  const rowH = rowFs * 1.6;
  const topRowY = padY + titleFs * 1.5 + 6;
  ctx.font = rowFs + "px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = p.textColor || "#ffcc88";
  ctx.textBaseline = "middle";

  if (top.length === 0) {
    ctx.textAlign = "center";
    ctx.fillStyle = (p.textColor || "#ffcc88") + (p.opacity < 1 ? "" : "");
    ctx.globalAlpha *= 0.6;
    ctx.fillText("(no scores yet — fire the cannon!)", w * 0.5, topRowY + rowH * 0.5);
    ctx.globalAlpha = (typeof p.opacity === "number") ? p.opacity : 0.94;
  } else {
    for (let i = 0; i < top.length; i++) {
      const y = topRowY + rowH * (i + 0.5);
      // Rank
      ctx.textAlign = "left";
      ctx.fillText((i + 1) + ".", padX, y);
      // Score (right-aligned)
      ctx.textAlign = "right";
      ctx.fillText(String(top[i].score), w - padX, y);
      // Date in the middle (subtle)
      if (top[i].date) {
        ctx.textAlign = "center";
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * 0.55;
        ctx.fillText(top[i].date, w * 0.5, y);
        ctx.globalAlpha = prevAlpha;
      }
    }
  }
  ctx.globalAlpha = 1;
}

function _tickLeaderboards() {
  if (!state || !Array.isArray(state.nodes)) return;
  for (const node of state.nodes) {
    if (!node || node.type !== "Leaderboard") continue;
    if (!_isNodeActive(node)) continue;
    const p = node.params = node.params || {};
    const r = (typeof _resolveNodeParams === "function") ? _resolveNodeParams(node) : p;
    const key = p.lsKey || "gamma-leaderboard-v1";

    // Reset (rising edge): clear stored list
    const resetNow = (typeof r.reset === "number") ? r.reset : 0;
    if (resetNow >= 0.5 && (node._lbPrevReset || 0) < 0.5) {
      _leaderboardSave(key, []);
      p.topScore = 0;
      p.rank = 0;
    }
    node._lbPrevReset = resetNow;

    // Submit (rising edge): insert current score
    const submitNow = (typeof r.submit === "number") ? r.submit : 0;
    if (submitNow >= 0.5 && (node._lbPrevSubmit || 0) < 0.5) {
      const sc = Math.round(typeof r.score === "number" ? r.score : 0);
      if (sc > 0) {
        const list = _leaderboardLoad(key);
        const d = new Date();
        const date = d.getFullYear() + "-" +
          String(d.getMonth() + 1).padStart(2, "0") + "-" +
          String(d.getDate()).padStart(2, "0");
        list.push({ score: sc, date });
        list.sort((a, b) => b.score - a.score);
        const max = Math.max(1, Math.min(50, Math.round(p.maxEntries || 5)));
        const trimmed = list.slice(0, Math.max(max, 10));
        _leaderboardSave(key, trimmed);
        // Rank of just-inserted (highest-index match for ties)
        p.rank = trimmed.findIndex(e => e.score === sc && e.date === date) + 1;
      }
    }
    node._lbPrevSubmit = submitNow;

    // Always refresh topScore output
    const list = _leaderboardLoad(key);
    list.sort((a, b) => b.score - a.score);
    p.topScore = list.length ? list[0].score : 0;
  }
}

function _tickUiNodes() {
  if (!state || !Array.isArray(state.nodes)) return;
  _tickLeaderboards();
  const live = (typeof isLiveMode === "function") ? isLiveMode() : true;
  // Track which ui-canvas-* ids belong to the current patch so we can
  // hide orphans left over from a previous patch (mirrors the HUDText
  // GC). Without this, a UI canvas from a swapped-out demo stays
  // visible until something removes it.
  const touchedUi = new Set();
  for (const node of state.nodes) {
    if (!node) continue;
    if (node.type !== "UIButton" && node.type !== "UIText" && node.type !== "UIPanel" && node.type !== "UISlider" && node.type !== "Leaderboard") continue;
    touchedUi.add("ui-canvas-" + node.id);
    const canvas = _ensureUiCanvas(node);
    if (!live) { canvas.style.display = "none"; continue; }
    // R.3: if a `show` wire exists, use it for visibility; otherwise fall back to stage tag
    const showResolved = _resolveNodeParams(node);
    const hasShowWire = Array.isArray(state.edges) && state.edges.some(e =>
      e && e.to && e.to.node === node.id && e.to.port === "show");
    if (hasShowWire) {
      if ((typeof showResolved.show === "number" ? showResolved.show : 0) < 0.5) { canvas.style.display = "none"; continue; }
    } else {
      if (!_isNodeActive(node)) { canvas.style.display = "none"; continue; }
    }
    const p = node.params || {};
    let w, h;
    if (node.type === "UIText") {
      // UIText auto-sizes width to the rendered text + some padding.
      // For simplicity, use fontSize-based default.
      const fs = (typeof p.fontSize === "number") ? p.fontSize : 24;
      w = Math.max(40, (typeof p.width  === "number") ? p.width  : Math.max(120, String(p.text || "").length * fs * 0.55));
      h = Math.max(fs * 1.3, (typeof p.height === "number") ? p.height : fs * 1.6);
    } else {
      w = Math.max(8, (typeof p.width  === "number") ? p.width  : 180);
      h = Math.max(8, (typeof p.height === "number") ? p.height : 48);
    }
    if (canvas.width  !== Math.round(w)) canvas.width  = Math.round(w);
    if (canvas.height !== Math.round(h)) canvas.height = Math.round(h);
    const { left, top } = _resolveUiAnchorPos(node, w, h);
    canvas.style.left = left + "px";
    canvas.style.top  = top  + "px";
    canvas.style.width  = w + "px";
    canvas.style.height = h + "px";
    canvas.style.display = "block";
    // 8.D.1 v2 -- live-update pointer-events from the interactive
    // flag. Switching `interactive` 0->1 on a UIPanel/UIText in the
    // props panel takes effect on the next tick.
    const interactive = _uiNodeIsInteractive(node);
    const wantPe = interactive ? "auto" : "none";
    if (canvas.style.pointerEvents !== wantPe) {
      canvas.style.pointerEvents = wantPe;
      canvas.style.cursor = interactive ? "pointer" : "default";
      // Drop any captured hover state when going passive; clicks
      // already fall through, but the visual hover ring would stick.
      if (!interactive) {
        node._uiHover = false;
        node._uiPressed = false;
        node._uiPendingClick = false;
      }
    }
    const ctx = canvas.getContext("2d");
    const input = {
      node,
      width:   w,
      height:  h,
      hovered: !!node._uiHover,
      pressed: !!node._uiPressed
    };
    // Custom render takes precedence if defined.
    const customCode = (typeof p.customRender === "string") ? p.customRender : "";
    let usedCustom = false;
    if (customCode.trim()) {
      usedCustom = _runCustomRender(node, ctx, customCode, input);
    }
    if (!usedCustom) {
      if      (node.type === "UIButton")    _drawUiButtonDefault(ctx, p, input);
      else if (node.type === "UIText")      _drawUiTextDefault(ctx,   p, input);
      else if (node.type === "UIPanel")     _drawUiPanelDefault(ctx,  p, input);
      else if (node.type === "UISlider")    _drawUiSliderDefault(ctx,  p, input);
      else if (node.type === "Leaderboard") _drawLeaderboardDefault(ctx, p, input);
    }
    // UISlider drag logic: while pressed, map pointer X to value
    if (node.type === "UISlider" && node._uiPressed && node._uiDragX !== undefined) {
      const pad = ((typeof p.borderWidth === "number") ? p.borderWidth : 1) + 2;
      const trackW = w - 2 * pad;
      const localX = node._uiDragX;
      const t = Math.max(0, Math.min(1, (localX - pad) / (trackW || 1)));
      const min = typeof p.min === "number" ? p.min : 0;
      const max = typeof p.max === "number" ? p.max : 1;
      let val = min + t * (max - min);
      const step = typeof p.step === "number" ? p.step : 0;
      if (step > 0) val = Math.round(val / step) * step;
      val = Math.max(min, Math.min(max, val));
      p.value = val;
    }
    // 8.D.1 v2 -- interactivity readback. Every interactive UI node
    // (UIButton always, UIText/UIPanel when interactive=1, UISlider always) exposes
    // clicked + hovered. clicked pulses HIGH for one tick on each
    // pointer-up within bounds; hovered is 1 while the cursor sits
    // inside the rect.
    if (interactive) {
      if (node.type !== "UISlider") {
        p.clicked = node._uiPendingClick ? 1 : 0;
        node._uiPendingClick = false;
        p.hovered = node._uiHover ? 1 : 0;
      }
    } else {
      p.clicked = 0;
      p.hovered = 0;
    }
  }
  // Hide UI canvases that no longer correspond to a node in the
  // current patch (e.g. left over from a swapped-out demo).
  document.querySelectorAll('canvas[id^="ui-canvas-"]').forEach(c => {
    if (!touchedUi.has(c.id)) c.style.display = "none";
  });
}

function _tickHudTextNodes() {
  if (!state || !Array.isArray(state.nodes)) return;
  const live = (typeof isLiveMode === "function") ? isLiveMode() : true;
  // Track stacking offsets per-corner so multiple HUDText nodes in
  // the same corner don't overlap. Reset every tick.
  const cornerStack = { "top-left": 0, "top-right": 0, "bottom-left": 0, "bottom-right": 0 };
  const STACK_GAP = 4;
  // Also: collect ids we touched so we can hide canvases for deleted
  // HUDText nodes from a previous patch state.
  const touchedIds = new Set();
  for (const node of state.nodes) {
    if (!node || node.type !== "HUDText") continue;
    const canvas = _ensureHudTextCanvas(node.id);
    touchedIds.add("hud-text-" + node.id);
    if (!live) { canvas.style.display = "none"; continue; }
    // R.3: if a `show` wire exists, use it; otherwise fall back to stage tag
    const hudShowResolved = _resolveNodeParams(node);
    const hudHasShowWire = Array.isArray(state.edges) && state.edges.some(e =>
      e && e.to && e.to.node === node.id && e.to.port === "show");
    if (hudHasShowWire) {
      if ((typeof hudShowResolved.show === "number" ? hudShowResolved.show : 0) < 0.5) { canvas.style.display = "none"; continue; }
    } else {
      if (!_isNodeActive(node)) { canvas.style.display = "none"; continue; }
    }
    // Require a wire from this node's `hud` output -- matches the
    // Minimap/Altimeter convention so unwired HUDs stay invisible
    // and unobtrusive in the patch editor view.
    const hudWire = state.edges && state.edges.find(e =>
      e && e.from && e.from.node === node.id && e.from.port === "hud"
    );
    if (!hudWire || !hudWire.to) { canvas.style.display = "none"; continue; }
    const p = node.params || {};
    // Phase 8.D.1 -- if customRender is set, run it instead of the
    // default HUDText layout. ctx + p + input are in scope.
    if (typeof p.customRender === "string" && p.customRender.trim()) {
      // Auto-size canvas for custom render. Use width/height params
      // if present, else fall back to fontSize-based default.
      const fs = (typeof p.fontSize === "number") ? p.fontSize : 16;
      const w = Math.max(40, (typeof p.width  === "number") ? p.width  : 200);
      const h = Math.max(fs * 1.3, (typeof p.height === "number") ? p.height : fs * 1.8);
      if (canvas.width  !== Math.round(w)) canvas.width  = Math.round(w);
      if (canvas.height !== Math.round(h)) canvas.height = Math.round(h);
      const corner = (typeof p.corner === "string") ? p.corner : "top-left";
      const margin = Math.max(0, (typeof p.margin === "number") ? p.margin : 18);
      const vw = window.innerWidth, vh = window.innerHeight;
      let left, top;
      if      (corner === "top-left")     { left = margin;             top = margin; }
      else if (corner === "top-right")    { left = vw - w - margin;    top = margin; }
      else if (corner === "bottom-left")  { left = margin;             top = vh - h - margin; }
      else                                { left = vw - w - margin;    top = vh - h - margin; }
      canvas.style.left = left + "px";
      canvas.style.top  = top  + "px";
      canvas.style.width  = w + "px";
      canvas.style.height = h + "px";
      canvas.style.display = "block";
      const ctx = canvas.getContext("2d");
      _runCustomRender(node, ctx, p.customRender, { node, width: w, height: h });
      continue;
    }
    // Resolve text. If value is a finite number, format it with
    // prefix/suffix/decimals; otherwise use the static text param.
    const value = _resolveHudTextValue(node, "value");
    const prefix = (typeof p.prefix === "string") ? p.prefix : "";
    const suffix = (typeof p.suffix === "string") ? p.suffix : "";
    let body;
    if (Number.isFinite(value)) {
      const decimals = Math.max(0, Math.min(6, (typeof p.decimals === "number") ? p.decimals : 0));
      body = value.toFixed(decimals);
    } else {
      body = (typeof p.text === "string") ? p.text : "";
    }
    const display = prefix + body + suffix;
    const fontSize = Math.max(8, Math.min(96, (typeof p.fontSize === "number") ? p.fontSize : 16));
    const color    = (typeof p.color === "string" && p.color) ? p.color : "#ffffff";
    const opacity  = Math.max(0.05, Math.min(1.0, (typeof p.opacity === "number") ? p.opacity : 0.95));
    const margin   = Math.max(0, (typeof p.margin === "number") ? p.margin : 18);
    const corner   = (typeof p.corner === "string" && cornerStack[p.corner] !== undefined) ? p.corner : "top-left";
    // Measure with a temp ctx so the canvas can be sized to the text.
    // dpr-aware so the text stays crisp on retina displays.
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const pad = Math.round(fontSize * 0.5);
    // Temp canvas for measurement -- reuse the node's canvas at a
    // dummy size first, then resize.
    const tctx = canvas.getContext("2d");
    tctx.font = fontSize + "px ui-monospace, 'SF Mono', Menlo, monospace";
    const metrics = tctx.measureText(display);
    const textW = Math.ceil(metrics.width);
    const cssW = textW + pad * 2;
    const cssH = Math.ceil(fontSize * 1.4) + Math.round(pad * 0.5);
    // Set both the backing-store size (dpr-scaled) and the CSS size.
    if (canvas.width  !== Math.round(cssW * dpr)) canvas.width  = Math.round(cssW * dpr);
    if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    // Redraw -- transform to dpr-scaled space so text crisps.
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, cssW, cssH);
    tctx.fillStyle = color;
    tctx.font = fontSize + "px ui-monospace, 'SF Mono', Menlo, monospace";
    tctx.textBaseline = "middle";
    tctx.fillText(display, pad, cssH * 0.5);
    // Stack at the chosen corner -- offset by sum of previously
    // placed HUDText canvases in this corner.
    const stackOffset = cornerStack[corner];
    canvas.style.top = canvas.style.bottom = canvas.style.left = canvas.style.right = "";
    if (corner === "top-left")     { canvas.style.top    = (margin + stackOffset) + "px"; canvas.style.left  = margin + "px"; }
    else if (corner === "top-right")    { canvas.style.top    = (margin + stackOffset) + "px"; canvas.style.right = margin + "px"; }
    else if (corner === "bottom-left")  { canvas.style.bottom = (margin + stackOffset) + "px"; canvas.style.left  = margin + "px"; }
    else                                 { canvas.style.bottom = (margin + stackOffset) + "px"; canvas.style.right = margin + "px"; }
    cornerStack[corner] += cssH + STACK_GAP;
    canvas.style.opacity = String(opacity);
    canvas.style.display = "block";
  }
  // Clean up canvases for deleted nodes
  document.querySelectorAll('canvas[id^="hud-text-"]').forEach(c => {
    if (!touchedIds.has(c.id)) {
      c.style.display = "none";
    }
  });
}

/* Resolve a HUDText input -- walks the wire (if any) to find the
 * upstream numeric value. Returns the upstream value or the param's
 * static value if no wire is present. Returns NaN to signal
 * "use static text instead". */
function _resolveHudTextValue(node, port) {
  if (Array.isArray(state.edges)) {
    const edge = state.edges.find(e => e && e.to && e.to.node === node.id && e.to.port === port);
    if (edge && edge.from) {
      const src = state.nodes.find(n => n && n.id === edge.from.node);
      if (src && src.params && typeof src.params[edge.from.port] === "number") {
        return src.params[edge.from.port];
      }
    }
  }
  const v = node.params ? node.params[port] : undefined;
  return (typeof v === "number") ? v : NaN;
}

/* Phase 6.6.13 — virtual on-screen sticks for touch navigation.
 * Each pad is a 130 px circle; touching + dragging moves the inner
 * "knob" toward the touch point. The pad center represents zero
 * deflection; the pad radius (knob can travel half-radius from
 * center for clarity) maps to ±1 stick deflection.
 *
 * The knob position drives:
 *   move pad → cam.touchMove = { fwd: -dy/maxR, strafe: dx/maxR }
 *   look pad → cam.touchLook = { dx: dx/maxR * lookGain,
 *                                 dy: dy/maxR * lookGain }
 *
 * touchLook is a RATE (radians/sec), so holding the look pad to one
 * side keeps rotating; touchMove is a NORMAL (analog deflection), so
 * holding the move pad to one side moves at constant speed. Same
 * idiom as console game first-person controls. */
function _wireTouchPads() {
  const pads = document.querySelectorAll(".theater-pad");
  pads.forEach(pad => {
    const knob = pad.querySelector(".theater-pad-knob");
    let active = null;   // pointerId currently controlling this pad
    const updateKnob = (dx, dy, maxR) => {
      const cl = Math.max(0, Math.min(1, Math.hypot(dx, dy) / maxR));
      if (cl > 1) { dx = dx / cl; dy = dy / cl; }
      const visualX = Math.max(-maxR/2, Math.min(maxR/2, dx));
      const visualY = Math.max(-maxR/2, Math.min(maxR/2, dy));
      knob.style.transform = "translate(" + visualX + "px, " + visualY + "px)";
    };
    const reset = () => {
      knob.style.transform = "";
      pad.classList.remove("theater-pad-active");
      if (pad.dataset.pad === "move") Visual.theaterCam.touchMove = null;
      else                             Visual.theaterCam.touchLook = null;
    };
    pad.addEventListener("pointerdown", (e) => {
      if (active !== null) return;        // one finger per pad
      active = e.pointerId;
      try { pad.setPointerCapture(e.pointerId); } catch (_) {}
      pad.classList.add("theater-pad-active");
      e.preventDefault();
    });
    pad.addEventListener("pointermove", (e) => {
      if (e.pointerId !== active) return;
      const r = pad.getBoundingClientRect();
      const cx = r.left + r.width  * 0.5;
      const cy = r.top  + r.height * 0.5;
      const maxR = r.width * 0.5;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      // Clamp deflection magnitude to maxR so analog signal saturates
      // at ±1; the knob still moves to the edge but doesn't overshoot
      // the visual ring.
      const len = Math.hypot(dx, dy);
      if (len > maxR) { dx = dx * maxR / len; dy = dy * maxR / len; }
      updateKnob(dx, dy, maxR);
      const nx = dx / maxR;       // normalized -1..1
      const ny = dy / maxR;
      // Apply a small dead zone to prevent drift from a slightly-off-
      // center resting touch.
      const dead = 0.08;
      const m = Math.hypot(nx, ny);
      const scale = m > dead ? (m - dead) / (1 - dead) / m : 0;
      const sx = nx * scale, sy = ny * scale;
      if (pad.dataset.pad === "move") {
        // Up on the pad = forward (positive forward axis).
        Visual.theaterCam.touchMove = { fwd: -sy, strafe: sx };
      } else {
        // Look pad delivers a RATE: stick deflection × lookGain rad/s.
        // 2 rad/s at full stick gives ~115°/s — comfortable for
        // looking around without dizzy.
        const lookGain = 2.0;
        Visual.theaterCam.touchLook = { dx: sx * lookGain, dy: sy * lookGain };
      }
    });
    const end = (e) => {
      if (e.pointerId !== active) return;
      try { pad.releasePointerCapture(e.pointerId); } catch (_) {}
      active = null;
      reset();
    };
    pad.addEventListener("pointerup",     end);
    pad.addEventListener("pointercancel", end);
  });
}

/* Encode the theater-mode render pass. Replaces _encodeRigComposite
 * + _encodeWarpPasses for the frame when previewMode === "theater".
 * Returns true if the pass was successfully encoded. */
function _encodeTheaterPass(enc, dtSec) {
  if (!Visual.device || !Visual.context || !Visual.theaterPipeline ||
      !Visual.theaterBindGroup || !Visual.theaterUniformBuffer ||
      !Visual.theaterVertexBuffer || !Visual.theaterIndexBuffer ||
      !Visual.theaterDispParamsBuffer) return false;

  // Step the camera from currently-held keys / touch sticks before
  // computing the matrix so the very next frame reflects the input.
  _theaterStepCamera(dtSec || 0);

  const displays = (state && state.rig && state.rig.displays) || [];
  const layerCount = Math.min(displays.length, RIG_MAX_DISPLAYS);
  if (layerCount === 0) return false;

  // Build mesh geometry — one mesh per display; warp meshes used when
  // the display has them, identity 1×1 otherwise. Single drawIndexed
  // covers everything.
  const geom = _buildTheaterMeshGeometry(displays);
  if (geom.indexCount === 0) return false;
  const scratch = Visual._theaterScratch;
  Visual.device.queue.writeBuffer(
    Visual.theaterVertexBuffer, 0,
    scratch.verts.buffer, scratch.verts.byteOffset, geom.vertBytes
  );
  Visual.device.queue.writeBuffer(
    Visual.theaterIndexBuffer, 0,
    scratch.idx.buffer, scratch.idx.byteOffset, geom.idxBytes
  );

  // Pack per-display blend params (gamma, blackLift, power, _) and
  // write to the uniform array indexed by layer in the shader.
  const dpBuf = new Float32Array(RIG_MAX_DISPLAYS * 4);
  for (let i = 0; i < layerCount; i++) {
    const d = displays[i] || {};
    const eb = d.edgeBlend || _defaultEdgeBlend();
    dpBuf[i * 4 + 0] = eb.gamma;
    dpBuf[i * 4 + 1] = eb.blackLift;
    dpBuf[i * 4 + 2] = eb.power;
    dpBuf[i * 4 + 3] = 0;
  }
  Visual.device.queue.writeBuffer(Visual.theaterDispParamsBuffer, 0, dpBuf.buffer, dpBuf.byteOffset, dpBuf.byteLength);

  // View-projection matrix.
  const cw = Visual.canvas.width, ch = Visual.canvas.height;
  const aspect = (cw && ch) ? cw / ch : 1;
  const vp = _theaterViewProjMatrix(Visual.theaterCam, aspect);
  Visual.device.queue.writeBuffer(Visual.theaterUniformBuffer, 0, vp.buffer, vp.byteOffset, vp.byteLength);

  let canvasView;
  try { canvasView = Visual.context.getCurrentTexture().createView(); }
  catch (e) { return false; }

  const pass = enc.beginRenderPass({
    label: "theater-pass",
    colorAttachments: [{
      view: canvasView,
      clearValue: { r: 0, g: 0, b: 0, a: 1.0 },     // pure black, no skybox
      loadOp: "clear",
      storeOp: "store"
    }]
    // No depth attachment — additive blending makes order irrelevant
    // and lets overlap zones sum correctly.
  });
  pass.setPipeline(Visual.theaterPipeline);
  pass.setBindGroup(0, Visual.theaterBindGroup);
  pass.setVertexBuffer(0, Visual.theaterVertexBuffer);
  pass.setIndexBuffer(Visual.theaterIndexBuffer, "uint32");
  pass.drawIndexed(geom.indexCount);
  pass.end();
  return true;
}

/* Rebuild the rig composite bind group when the framebuffer changes
 * (display count, resolution). Layout is fixed; the texture-array
 * view + sampler + uniform buffer get rebound. */
function _rebuildRigCompositeBindGroup() {
  if (!Visual.device || !Visual.framebufferArrayView ||
      !Visual.rigCompositeBindGroupLayout || !Visual.blitSampler ||
      !Visual.rigCompositeUniformBuffer || !Visual.rigDisplaysBuffer) return;
  Visual.rigCompositeBindGroup = Visual.device.createBindGroup({
    label: "rig-composite-bg",
    layout: Visual.rigCompositeBindGroupLayout,
    entries: [
      { binding: 0, resource: Visual.framebufferArrayView },
      { binding: 1, resource: Visual.blitSampler },
      { binding: 2, resource: { buffer: Visual.rigCompositeUniformBuffer } },
      { binding: 3, resource: { buffer: Visual.rigDisplaysBuffer } }
    ]
  });
}

