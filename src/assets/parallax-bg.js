const PARALLAX_BG_VERSION = 2;
async function _ensureParallaxBgAssets() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    const layers = [
      { name: "parallax-sky",       generator: _makeParallaxSkySprite,       slot: "sky" },
      { name: "parallax-mountains", generator: _makeParallaxMountainsSprite, slot: "far" },
      { name: "parallax-forest",    generator: _makeParallaxForestSprite,    slot: "mid" }
    ];
    const slots = {};
    let createdAny = false;
    for (const layer of layers) {
      let sprite = Assets.findSpriteByName(layer.name);
      // Stale-art replacement: if the existing record was created by
      // an older version of this bootstrap, delete it so the new
      // generator output gets saved this run.
      if (sprite && (sprite.parallaxBgVersion || 0) < PARALLAX_BG_VERSION) {
        console.log("[default-assets] replacing stale " + layer.name +
          " (v" + (sprite.parallaxBgVersion || 0) + " -> v" + PARALLAX_BG_VERSION + ")");
        try { await Assets.delete(sprite.id); } catch (e) {
          console.warn("[default-assets] delete failed:", e);
        }
        sprite = null;
      }
      if (!sprite) {
        const blob = await layer.generator();
        const file = new File([blob], layer.name + ".png", { type: "image/png" });
        sprite = await loadImageFileToSpriteAsset(file, {
          name: layer.name,
          framesX: 1, framesY: 1,
          fps: 1, scale: 32,
          source: "default:parallax-bg"
        });
        if (sprite) {
          sprite.parallaxBgVersion = PARALLAX_BG_VERSION;
          try { await Assets.put(sprite); } catch (e) { console.warn("[default-assets] version-tag put failed:", e); }
          if (sprite.blob) {
            console.log("[default-assets] " + layer.name + " v" + PARALLAX_BG_VERSION +
              " sprite saved (" + sprite.blob.size + " bytes)");
          }
        }
        createdAny = true;
      }
      if (sprite) slots[layer.slot] = sprite.id;
    }
    let folder = Assets.findFolderByName("parallax-bg-folder");
    if (!folder) {
      folder = await createFolderAsset("parallax-bg-folder", "decoration", {
        slots: { main: slots.sky || null },   // decoration has 'main' slot
        notes: "Default parallax background set bundled with the editor. Three layers (sky / mountains / forest) for Snow-White-style multi-plane scrolling in Scene2D demos. Wire each into a ParallaxLayer2D with an ImageURL(wrapMode='repeat-x'), then into Scene2D.mesh1..mesh3 (back-to-front). See the Platformer 2D · Animated demo for the canonical layout.",
        source: "default:parallax-bg"
      });
    }
    if (createdAny) {
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return slots;
  } catch (e) {
    console.warn("[default-assets] parallax bg bootstrap failed:", e);
    return null;
  }
}

/* Default ship-with-app tileset for Level2D textured tilemap layers.
 * 4×2 grid of 16px tiles -> 64×32 PNG. Each tile is hand-drawn
 * procedurally; user can replace via SpriteCreator once Phase 2c
 * adds a real tileset asset type.
 *
 * Tile index layout:
 *   0 grass-top  1 dirt       2 stone     3 sand
 *   4 water      5 wood-plank 6 brick     7 door
 *
 * Level2D tilemap layer uses tileMap = { "1": 0, "2": 1, ... } to
 * map cell chars to tile indices into this sheet.
 */
async function _makeDemoTilesetSprite() {
  const TW = 16, TH = 16, COLS = 4, ROWS = 2;
  const W = TW * COLS, H = TH * ROWS;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  function tileAt(col, row) { return { ox: col * TW, oy: row * TH }; }
  // Tile 0: grass-top (green w/ darker grass blades on top)
  {
    const { ox, oy } = tileAt(0, 0);
    px(ox, oy + 2, 16, 14, "#3a8a3e");      // body
    px(ox, oy + 2, 16, 1,  "#5fa860");      // top highlight
    px(ox, oy + 15, 16, 1, "#1f5024");      // bottom shadow
    // grass blades on top edge
    for (let i = 0; i < 8; i++) px(ox + i * 2 + (i % 2), oy + (i % 2 ? 0 : 1), 1, (i % 2 ? 2 : 1), "#7ec48a");
  }
  // Tile 1: dirt
  {
    const { ox, oy } = tileAt(1, 0);
    px(ox, oy, 16, 16, "#6a4520");
    // pebbles
    px(ox + 3,  oy + 3,  2, 2, "#52341c");
    px(ox + 10, oy + 7,  2, 2, "#7a5230");
    px(ox + 5,  oy + 11, 2, 2, "#4a2e18");
    px(ox + 12, oy + 12, 1, 1, "#52341c");
  }
  // Tile 2: stone
  {
    const { ox, oy } = tileAt(2, 0);
    px(ox, oy, 16, 16, "#6e7280");
    // cracks
    px(ox + 1, oy + 4, 5, 1, "#52555f");
    px(ox + 9, oy + 9, 5, 1, "#52555f");
    px(ox + 4, oy + 12, 1, 3, "#52555f");
    // highlights
    px(ox + 2, oy + 1, 3, 1, "#8b8f9c");
    px(ox + 11, oy + 5, 3, 1, "#8b8f9c");
  }
  // Tile 3: sand
  {
    const { ox, oy } = tileAt(3, 0);
    px(ox, oy, 16, 16, "#e2c887");
    // texture dots
    px(ox + 3,  oy + 4,  1, 1, "#c8ad6b");
    px(ox + 9,  oy + 6,  1, 1, "#c8ad6b");
    px(ox + 5,  oy + 11, 1, 1, "#c8ad6b");
    px(ox + 12, oy + 13, 1, 1, "#c8ad6b");
    px(ox + 7,  oy + 2,  1, 1, "#f0d59a");
    px(ox + 11, oy + 9,  1, 1, "#f0d59a");
  }
  // Tile 4: water
  {
    const { ox, oy } = tileAt(0, 1);
    px(ox, oy, 16, 16, "#3a6eb4");
    // wave highlights
    px(ox + 1, oy + 2,  6, 1, "#5a8cd4");
    px(ox + 9, oy + 5,  5, 1, "#5a8cd4");
    px(ox + 3, oy + 9,  7, 1, "#5a8cd4");
    px(ox + 10, oy + 12, 4, 1, "#5a8cd4");
    px(ox + 2, oy + 13, 3, 1, "#7daad8");
  }
  // Tile 5: wood plank
  {
    const { ox, oy } = tileAt(1, 1);
    px(ox, oy, 16, 16, "#9c6a3a");
    // horizontal plank lines
    px(ox, oy + 5,  16, 1, "#6e4828");
    px(ox, oy + 10, 16, 1, "#6e4828");
    px(ox, oy + 15, 16, 1, "#5a3a20");
    // grain
    px(ox + 3,  oy + 2, 4, 1, "#b08858");
    px(ox + 9,  oy + 7, 5, 1, "#b08858");
    px(ox + 2,  oy + 12, 6, 1, "#b08858");
  }
  // Tile 6: brick wall
  {
    const { ox, oy } = tileAt(2, 1);
    px(ox, oy, 16, 16, "#7a4030");           // mortar
    const BRICK = "#b85a3a";
    // top row (offset 0)
    px(ox + 1, oy + 1, 6, 5, BRICK);
    px(ox + 8, oy + 1, 7, 5, BRICK);
    // middle row (offset 4)
    px(ox + 0, oy + 7, 3, 5, BRICK);
    px(ox + 4, oy + 7, 7, 5, BRICK);
    px(ox + 12, oy + 7, 4, 5, BRICK);
    // bottom row (offset 0)
    px(ox + 1, oy + 13, 6, 3, BRICK);
    px(ox + 8, oy + 13, 7, 3, BRICK);
  }
  // Tile 7: door
  {
    const { ox, oy } = tileAt(3, 1);
    px(ox, oy, 16, 16, "#5a3a1c");           // frame
    px(ox + 1, oy + 1, 14, 14, "#8a5a2a");   // door body
    // panels
    px(ox + 3, oy + 3, 4, 4, "#6e4520");
    px(ox + 9, oy + 3, 4, 4, "#6e4520");
    px(ox + 3, oy + 9, 4, 4, "#6e4520");
    px(ox + 9, oy + 9, 4, 4, "#6e4520");
    // knob
    px(ox + 12, oy + 8, 1, 1, "#fcd34d");
  }
  return await c.convertToBlob({ type: "image/png" });
}

async function _ensureDemoTilesetAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("demo-tileset");
    if (!sprite) {
      const blob = await _makeDemoTilesetSprite();
      const file = new File([blob], "demo-tileset.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "demo-tileset",
        framesX: 4, framesY: 2,
        fps: 1, scale: 16,
        source: "default:level2d-tileset"
      });
      if (sprite && sprite.blob) {
        console.log("[default-assets] demo-tileset sprite saved (" + sprite.blob.size + " bytes, 4×2 = 8 tiles)");
      }
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] demo-tileset bootstrap failed:", e);
    return null;
  }
}

/* Programmatic grass-tuft sprite. 16×12, single frame. Tiny green
 * silhouette with three blades + a hint of shadow at the base. Used
 * by the demo's SpriteScatter2D to lay decorative tufts along the
 * ground line. */
async function _makeGrassTuftSprite() {
  const W = 16, H = 12;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }
  // Three blades of grass + a small shadow.
  const BLADE  = "#4a8e4a";
  const BLADE2 = "#5fa05f";
  const BLADE3 = "#2c5e2c";
  const SHADOW = "#2a3a20";
  // Shadow at base
  px(3, 10, 10, 1, SHADOW);
  // Blade A (left, leans left)
  px(3, 3, 1, 8, BLADE3);
  px(4, 4, 1, 6, BLADE);
  px(4, 3, 1, 1, BLADE2);
  // Blade B (center, tallest)
  px(7, 1, 1, 10, BLADE);
  px(8, 1, 1, 10, BLADE3);
  px(8, 0, 1, 1, BLADE2);
  // Blade C (right, leans right)
  px(11, 4, 1, 6, BLADE);
  px(12, 3, 1, 8, BLADE3);
  px(11, 3, 1, 1, BLADE2);
  return await c.convertToBlob({ type: "image/png" });
}

/* Default-ship bootstrap for the grass tuft. */
async function _ensureGrassTuftAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("grass-tuft");
    if (!sprite) {
      const blob = await _makeGrassTuftSprite();
      const file = new File([blob], "grass-tuft.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "grass-tuft",
        framesX: 1, framesY: 1,
        fps: 1, scale: 16,
        source: "default:platformer-scatter"
      });
      if (sprite && sprite.blob) {
        console.log("[default-assets] grass-tuft sprite saved (" + sprite.blob.size + " bytes)");
      }
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] grass-tuft bootstrap failed:", e);
    return null;
  }
}

/* Default-ship bootstrap for the egg pickup. Same idempotency
 * contract as the hero. Saved as a 1-frame sprite in the asset
 * library + wrapped in a single-slot 'item' folder. */
async function _ensureEggPickupAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("egg-pickup");
    let created = false;
    if (!sprite) {
      const blob = await _makeEggPickupSprite();
      const file = new File([blob], "egg-pickup.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "egg-pickup",
        framesX: 1, framesY: 1,
        fps: 1, scale: 16,
        source: "default:platformer-items"
      });
      created = true;
      if (sprite && sprite.blob) {
        console.log("[default-assets] egg-pickup sprite saved (" + sprite.blob.size + " bytes)");
      }
    }
    if (!sprite) return null;
    let folder = Assets.findFolderByName("egg-pickup-folder");
    if (!folder) {
      folder = await createFolderAsset("egg-pickup-folder", "item", {
        slots: { idle: sprite.id },
        notes: "Default platformer pickup. Cream egg-shell sprite shipped with the editor; the Platformer 2D · Animated demo uses tilemap-based detection for now (a future push will swap in this sprite for the visual).",
        source: "default:platformer-items"
      });
    }
    if (created || folder) {
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] egg-pickup bootstrap failed:", e);
    return null;
  }
}

/* Default-ship bootstrap for the goal flag. Wrapped in a
 * 'decoration' folder since the flag is more "scenery you can
 * stand next to" than a state-machine-driven interactive. */
async function _ensureGoalFlagAsset() {
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("goal-flag");
    let created = false;
    if (!sprite) {
      const blob = await _makeGoalFlagSprite();
      const file = new File([blob], "goal-flag.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "goal-flag",
        framesX: 1, framesY: 1,
        fps: 1, scale: 16,
        source: "default:platformer-items"
      });
      created = true;
      if (sprite && sprite.blob) {
        console.log("[default-assets] goal-flag sprite saved (" + sprite.blob.size + " bytes)");
      }
    }
    if (!sprite) return null;
    let folder = Assets.findFolderByName("goal-flag-folder");
    if (!folder) {
      folder = await createFolderAsset("goal-flag-folder", "decoration", {
        slots: { main: sprite.id },
        notes: "Default platformer goal marker. Red triangular flag on a wooden pole; drop next to a LevelGoal2D in your patch.",
        source: "default:platformer-items"
      });
    }
    if (created || folder) {
      if (typeof brRenderAssets === "function") { try { brRenderAssets(); } catch (_) {} }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] goal-flag bootstrap failed:", e);
    return null;
  }
}

async function _ensureHeroPlaceholderAsset() {
  // Skip if Assets isn't ready yet (very early bootstrap).
  if (typeof Assets === "undefined" || typeof Assets.findSpriteByName !== "function") return null;
  try {
    let sprite = Assets.findSpriteByName("hero-placeholder");
    let createdSprite = false;
    if (!sprite) {
      const blob = await _makePlaceholderHeroSheet();
      const file = new File([blob], "hero-placeholder.png", { type: "image/png" });
      sprite = await loadImageFileToSpriteAsset(file, {
        name: "hero-placeholder",
        framesX: 6, framesY: 1,
        fps: 8, scale: 32,
        source: "default:platformer"
      });
      createdSprite = true;
      if (sprite && sprite.blob) {
        console.log("[default-assets] hero-placeholder sprite saved ("
          + sprite.blob.size + " bytes PNG, 6 frames @ 32×32)");
      }
    }
    if (!sprite) return null;
    // Folder is keyed by name independently of the sprite -- if the
    // user nuked the folder but kept the sprite, recreate the folder.
    let folder = Assets.findFolderByName("hero-placeholder-folder");
    if (!folder) {
      folder = await createFolderAsset("hero-placeholder-folder", "playable-character", {
        slots: {
          idle:        sprite.id,
          walk:        sprite.id,
          "jump-up":   sprite.id,
          fall:        sprite.id
        },
        notes: "Default placeholder bundled with the editor. 6-frame sprite-sheet (idle / walk-A / walk-mid / walk-B / jump / fall) auto-generated on first launch. Replace via SpriteCreator when you've generated a real character — the demo will pick up the new sprite as long as you rename it 'hero-placeholder' or wire ImageURL to your asset name.",
        source: "default:platformer"
      });
    }
    if (createdSprite || folder) {
      // Refresh the Assets tab if it's currently rendered so the new
      // entries show up without requiring a tab-switch.
      if (typeof brRenderAssets === "function") {
        try { brRenderAssets(); } catch (_) {}
      }
    }
    return sprite;
  } catch (e) {
    console.warn("[default-assets] hero placeholder bootstrap failed:", e);
    return null;
  }
}

