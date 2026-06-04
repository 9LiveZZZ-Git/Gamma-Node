

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

