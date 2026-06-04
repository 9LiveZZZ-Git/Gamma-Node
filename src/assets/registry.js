/* ====================================================================
 * SAMPLE ASSET REGISTRY
 *
 * Sample-based nodes (SamplePlayer / StereoSamplePlayer / Granular)
 * reference audio data via an `assetId` stored on the node's params.
 * The actual Float32Array(s) live in this in-memory registry, with
 * IndexedDB-backed persistence keyed by patch filename so samples
 * survive page reloads.
 *
 * Storage shape:
 *   editor.assets : Map<assetId, AssetRecord>
 *   AssetRecord = {
 *     id, name (original filename),
 *     sampleRate (decoded SR),
 *     channels (1 = mono Float32Array; 2 = [L, R]),
 *     durationSec,
 *     data (Float32Array or [Float32Array, Float32Array])
 *   }
 *
 * Sidecar manifest: on .gpatch save we emit `<patch>.assets.json`
 * alongside the .gpatch, listing each referenced assetId and its
 * metadata. The actual sample binaries are NOT bundled with the
 * .gpatch (multi-MB stems would inflate the JSON beyond reason);
 * users keep the .wav files they originally dragged in. The IDB
 * cache keeps them browser-side for repeat editing sessions.
 *
 * Codegen embeds samples up to 256K samples (~5.3 sec @ 48k mono)
 * directly as a static constexpr float[] + load() call. Larger
 * samples emit a TODO comment with the metadata so the user can
 * wire up runtime loading on the AlloLib side.
 * ================================================================= */

const _assets = new Map();          // assetId → AssetRecord (audio)
const _spriteAssets = new Map();    // assetId → SpriteAssetRecord (§8.A.1)
const _prefabAssets = new Map();    // assetId → PrefabAssetRecord (§8.A.6)
const _folderAssets = new Map();    // assetId → AssetFolderRecord (asset-folders sprint)
let _assetIdCounter = 1;

/* Sprint asset-folders -- function registry. Each function defines the
 * slots a folder of that function exposes. Slot list is fixed per
 * function (so a Playable Character folder always has the same slots),
 * but optional slots are marked with `optional: true` -- the LLM
 * auto-sort honors that when deciding which sprites get assigned.
 *
 * Adding a new function: add an entry here, the editor + LLM prompt
 * pick it up automatically. The function name is the IDB-stored
 * key on the folder record.
 *
 * Slot descriptions are sent to the LLM during auto-sort to help it
 * pick the right sprite for each slot. Keep them concise + literal
 * (the LLM matches sprite NAMES against descriptions). */
const _ASSET_FUNCTIONS = {
  "playable-character": {
    label: "Playable Character",
    description: "Player-controlled hero. Wires into PlatformerBody2D for movement.",
    slots: [
      { name: "idle",     desc: "Standing still pose; small ambient motion (breathing, tail sway)" },
      { name: "walk",     desc: "Walking sideways, 6-8 frame cycle" },
      { name: "run",      desc: "Running sideways, faster than walk with forward lean", optional: true },
      { name: "jump-up",  desc: "Crouch + leap, body compressing then extending upward" },
      { name: "jump-apex",desc: "Mid-air arc peak, body stretched", optional: true },
      { name: "fall",     desc: "Falling downward, arms/limbs spread" },
      { name: "land",     desc: "Brief crouch on landing impact", optional: true },
      { name: "crouch",   desc: "Held crouch / duck pose", optional: true },
      { name: "attack",   desc: "Attack swing / punch / shoot pose", optional: true },
      { name: "hurt",     desc: "Damage reaction frame", optional: true }
    ]
  },
  "enemy": {
    label: "Enemy",
    description: "Hostile NPC. Same slots as Character but with simpler AI defaults.",
    slots: [
      { name: "idle",     desc: "Default pose when not actively threatening" },
      { name: "patrol",   desc: "Walking back and forth" },
      { name: "attack",   desc: "Striking the player" },
      { name: "hurt",     desc: "Damage reaction", optional: true },
      { name: "die",      desc: "Death frame" }
    ]
  },
  "npc": {
    label: "NPC (non-combat)",
    description: "Friendly or neutral. Often dialog hooks.",
    slots: [
      { name: "idle",     desc: "Standing still" },
      { name: "talk",     desc: "Talking / gesturing pose", optional: true },
      { name: "walk",     desc: "Walking", optional: true }
    ]
  },
  "decoration": {
    label: "Terrain Decoration",
    description: "Static (or looping) scenery — trees, rocks, signs, banners. No interaction.",
    slots: [
      { name: "main",     desc: "The decoration itself" }
    ]
  },
  "item": {
    label: "Item / Collectible",
    description: "Pickups, power-ups, coins. Usually has a looping idle + a one-shot collect.",
    slots: [
      { name: "idle",     desc: "Looping idle frames (twinkle, bob, sparkle)" },
      { name: "collect",  desc: "One-shot collected animation (poof, fade)", optional: true }
    ]
  },
  "interactive": {
    label: "Interactive Object",
    description: "Switches, buttons, levers. Two states + optional transition.",
    slots: [
      { name: "off",      desc: "Inactive / default state" },
      { name: "on",       desc: "Activated state" },
      { name: "transition", desc: "Animation between off and on", optional: true }
    ]
  },
  "door": {
    label: "Door / Portal",
    description: "Opens and closes; the player passes through. Often locked → unlocked.",
    slots: [
      { name: "closed",   desc: "Fully closed" },
      { name: "opening",  desc: "Mid-animation opening", optional: true },
      { name: "open",     desc: "Fully open" },
      { name: "closing",  desc: "Mid-animation closing", optional: true }
    ]
  },
  "effect": {
    label: "Effect (particles / hits)",
    description: "One-shot VFX: explosions, sparkles, hit-flashes. Frames play once.",
    slots: [
      { name: "frame0",   desc: "First frame of the effect" },
      { name: "frame1",   desc: "Second frame", optional: true },
      { name: "frame2",   desc: "Third frame", optional: true },
      { name: "frame3",   desc: "Fourth frame", optional: true }
    ]
  }
};
const ASSET_EMBED_LIMIT = 262144;   // ~5.3 sec @ 48kHz mono

/* Sprint §8.A.1 -- generic Assets namespace. Wraps the existing IDB
 * + in-memory maps so callers don't need to know which map a given
 * asset type lives in. Audio records (no `assetType` field, written
 * by the old `loadAudioFileToAsset` path) are treated as audio by
 * default for backward compat. New record types must set
 * `assetType: "sprite"` (or future "font" / "midi-clip" / etc.).
 *
 * API:
 *   Assets.put(record)       async; writes IDB + in-memory map for type
 *   Assets.get(id)           sync; returns record from whichever map holds it
 *   Assets.list({type})      sync; returns array of records (filtered by type if given)
 *   Assets.delete(id)        async; removes from IDB + memory
 *   Assets.byType(type)      sync; returns the Map for that type (live ref)
 *
 * Records always carry { id, assetType, name, createdAt, updatedAt }.
 * Type-specific fields live alongside (e.g. sprite has blob + framesX/Y;
 * audio has data + sampleRate). */
const Assets = {
  byType(type) {
    if (type === "sprite") return _spriteAssets;
    if (type === "folder") return _folderAssets;
    if (type === "prefab") return _prefabAssets;   // §8.A.6
    return _assets;  // default = audio
  },
  async put(record) {
    if (!record || !record.id) throw new Error("Assets.put: record needs an id");
    record.updatedAt = Date.now();
    if (!record.createdAt) record.createdAt = record.updatedAt;
    const map = this.byType(record.assetType);
    map.set(record.id, record);
    try { await _idbPut(record); } catch (e) { console.warn("[assets] put IDB failed:", e); }
    // §8.A.6 -- when a prefab asset is updated, invalidate all live
    // PrefabInstance refs so they re-expand from the new template
    // on the next tick.
    if (record.assetType === "prefab" && typeof _invalidatePrefabRefs === "function") {
      _invalidatePrefabRefs(record.id);
    }
    return record;
  },
  get(id) {
    if (_spriteAssets.has(id)) return _spriteAssets.get(id);
    if (_folderAssets.has(id)) return _folderAssets.get(id);
    if (_prefabAssets.has(id)) return _prefabAssets.get(id);
    if (_assets.has(id))       return _assets.get(id);
    return null;
  },
  list(opts) {
    const type = opts && opts.type;
    if (type === "sprite") return Array.from(_spriteAssets.values());
    if (type === "folder") return Array.from(_folderAssets.values());
    if (type === "prefab") return Array.from(_prefabAssets.values());
    if (type === "audio")  return Array.from(_assets.values());
    // No type filter: everything.
    return Array.from(_assets.values())
      .concat(Array.from(_spriteAssets.values()))
      .concat(Array.from(_folderAssets.values()))
      .concat(Array.from(_prefabAssets.values()));
  },
  async delete(id) {
    let found = false;
    if (_spriteAssets.has(id)) { _spriteAssets.delete(id); found = true; }
    if (_folderAssets.has(id)) { _folderAssets.delete(id); found = true; }
    if (_prefabAssets.has(id)) { _prefabAssets.delete(id); found = true; }
    if (_assets.has(id))       { _assets.delete(id);       found = true; }
    if (!found) return false;
    try { await _idbDelete(id); } catch (e) { console.warn("[assets] delete IDB failed:", e); }
    return true;
  },
  // §8.A.6 -- prefab lookup by user-facing name (case-insensitive).
  findPrefabByName(name) {
    if (typeof name !== "string") return null;
    const lower = name.toLowerCase();
    for (const rec of _prefabAssets.values()) {
      if ((rec.name || "").toLowerCase() === lower) return rec;
    }
    return null;
  },
  // Find sprite by user-facing name (case-insensitive). Used by the
  // `asset:NAME` ImageURL resolver in §8.A.2.
  findSpriteByName(name) {
    if (typeof name !== "string") return null;
    const lower = name.toLowerCase();
    for (const rec of _spriteAssets.values()) {
      if ((rec.name || "").toLowerCase() === lower) return rec;
    }
    return null;
  },
  // Find folder by user-facing name (case-insensitive). Used by the
  // scene-bulk drop handler + future SpriteCollection nodes.
  findFolderByName(name) {
    if (typeof name !== "string") return null;
    const lower = name.toLowerCase();
    for (const rec of _folderAssets.values()) {
      if ((rec.name || "").toLowerCase() === lower) return rec;
    }
    return null;
  },
  // Resolve a slot in a folder to the underlying sprite asset record.
  // Returns null if the slot is empty or the assigned sprite was deleted.
  resolveFolderSlot(folder, slotName) {
    if (!folder || !folder.slots) return null;
    const sid = folder.slots[slotName];
    if (!sid) return null;
    return _spriteAssets.get(sid) || null;
  }
};
if (typeof window !== "undefined") window.Assets = Assets;

/* Globally-held mic MediaStream + cached device label. One grant per
 * session shared across all MicInput nodes (browsers only need one
 * `getUserMedia` permission per origin). When the AudioWorklet
 * runtime integration lands [v2], this is the stream that gets
 * connected via MediaStreamAudioSourceNode → AudioWorkletNode. */
let _micStream = null;
let _micDeviceLabel = "";

function _newAssetId() {
  return "a_" + Date.now().toString(36) + "_" + (_assetIdCounter++).toString(36);
}

/* ── IndexedDB layer ─────────────────────────────────────────────
 * Single object store "assets", keyed by assetId. Float32Arrays are
 * structured-cloned natively, no serialization needed. */
const IDB_NAME = "gamma-node-assets";
const IDB_STORE = "assets";
let _idbPromise = null;
function _idbOpen() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}
async function _idbPut(record) {
  const db = await _idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function _idbDelete(id) {
  const db = await _idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function _idbLoadAll() {
  const db = await _idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* Restore all previously-stored assets into the in-memory map on
 * startup. Idempotent — calls a second time noop if already loaded. */
let _assetsLoaded = false;
async function loadAssetsFromIdb() {
  if (_assetsLoaded) return;
  _assetsLoaded = true;
  try {
    const records = await _idbLoadAll();
    let nAudio = 0, nSprite = 0, nFolder = 0, nPrefab = 0;
    records.forEach(r => {
      // §8.A.1 + asset-folders + §8.A.6 dispatch: bucket by assetType.
      // Old audio records (written before §8.A.1) have no assetType
      // field; default them to "audio" for backward compatibility.
      if      (r.assetType === "sprite") { _spriteAssets.set(r.id, r); nSprite++; }
      else if (r.assetType === "folder") { _folderAssets.set(r.id, r); nFolder++; }
      else if (r.assetType === "prefab") { _prefabAssets.set(r.id, r); nPrefab++; }
      else                               { _assets.set(r.id, r);       nAudio++; }
    });
    if (nAudio + nSprite + nFolder + nPrefab > 0) {
      console.log("[assets] loaded from IDB: " + nAudio + " audio, " + nSprite + " sprite, " +
        nFolder + " folder, " + nPrefab + " prefab");
    }
    // Refresh any open props pane so file-name labels appear.
    if (typeof renderProps === "function") renderProps();
    // Refresh the Assets tab if it's currently open.
    if (typeof brRenderAssets === "function") {
      try { brRenderAssets(); } catch (_) {}
    }
  } catch (e) {
    console.warn("[assets] IDB load failed:", e);
  }
}
// Kick off the load — no need to await; UI fills in as data arrives.
loadAssetsFromIdb();

/* ── Sprite asset creation (§8.A.1) ─────────────────────────────── */
/* Take a dropped/selected image file (PNG/JPEG/WebP/GIF), read its
 * pixel dimensions, generate a unique id + name, and store it as a
 * sprite asset (in IDB + _spriteAssets). Returns the asset record so
 * callers can immediately wire it into an ImageURL node.
 *
 * Default metadata: framesX=1, framesY=1, fps=1, anchor center. The
 * SpriteCreator UI (§8.A.2 followup) will let users edit those after
 * upload. Animation framing has to come from the user because we can't
 * auto-detect grid layout from a single PNG. */
async function loadImageFileToSpriteAsset(file, opts) {
  if (!file) return null;
  opts = opts || {};
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf], { type: file.type || "image/png" });
  // Read dimensions via createImageBitmap (faster than HTMLImageElement).
  let width = 0, height = 0;
  try {
    const bmp = await createImageBitmap(blob);
    width = bmp.width; height = bmp.height;
    if (bmp.close) try { bmp.close(); } catch (_) {}
  } catch (e) {
    console.warn("[assets] sprite decode failed for " + file.name + ":", e);
    return null;
  }
  // Derive a clean name: strip extension + collapse non-name chars.
  const baseName = (typeof opts.name === "string" && opts.name)
    ? opts.name
    : file.name.replace(/\.[^/.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-");
  const rec = {
    id: "spr_" + Date.now() + "_" + Math.floor(Math.random() * 1e6),
    assetType: "sprite",
    name: baseName,
    blob,
    mimeType: blob.type,
    width, height,
    framesX: (typeof opts.framesX === "number" && opts.framesX > 0) ? opts.framesX : 1,
    framesY: (typeof opts.framesY === "number" && opts.framesY > 0) ? opts.framesY : 1,
    fps: (typeof opts.fps === "number" && opts.fps > 0) ? opts.fps : 1,
    // §8.A.3 -- pixels per world unit. Drop-time Sprite sizing reads
    // this. Default 32 matches typical retro tile pitch.
    scale: (typeof opts.scale === "number" && opts.scale > 0) ? opts.scale : 32,
    anchor: opts.anchor || { x: 0.5, y: 0.5 },
    hitbox: opts.hitbox || null,
    palette: opts.palette || [],
    source: opts.source || "drop",   // "drop" / "creator" / "batch" / "asset:NAME"
  };
  await Assets.put(rec);
  console.log("[assets] added sprite '" + rec.name + "' (" + width + "×" + height + ") id=" + rec.id);
  return rec;
}

/* ── Sprite Studio modal (SpriteCreator-1) ──────────────────────── */
/* LLM-driven pixel art generator. Opens from the topbar 'Sprite Studio'
 * button. User types a description; Claude (or local Gemma) writes JS
 * canvas paint code; we run it against an offscreen canvas; preview
 * + save into the asset library.
 *
 * System prompt is crafted to:
 *   - Forbid corporate-IP references (no Mario, Pokemon, Disney, etc).
 *   - Produce concise canvas-2D code (no setup boilerplate).
 *   - Honor size + frame count (multi-frame strips horizontal).
 *   - Use a palette appropriate to the chosen style preset.
 *
 * Generated JS runs in `new Function('ctx', 'width', 'height', 'framesX', 'framesY', code)`.
 * The LLM is trusted via the user's own API key; v1 trades worker
 * isolation for simpler debugging. Future hardening = Worker sandbox. */
const _SS_STYLE_PROMPTS = {
  snes: "16-bit SNES era pixel art, limited palette of 16 colors, no anti-aliasing on edges (1px solid strokes only), readable silhouette, slight shading for depth using 2-3 tones per color.",
  nes:  "8-bit NES era pixel art, hard-limit to 4 colors per sprite total (one transparent + three solids), bold flat colors with no gradient, blocky silhouette.",
  gameboy: "Game Boy era pixel art, hard-limit to 4 colors from the GB palette (#0f380f, #306230, #8bac0f, #9bbc0f), no other colors.",
  modern: "Modern pixel art style, free palette, soft shading is OK, anti-aliasing on diagonals is OK, crisp silhouette."
};
function _ssBuildSystemPrompt() {
  return [
    "You are a pixel-art sprite painter. The user describes a sprite; you write JavaScript that draws it onto a CanvasRenderingContext2D.",
    "",
    "OUTPUT RULES:",
    "- Output ONLY raw JavaScript code, no markdown fences, no comments, no setup.",
    "- The available globals are: ctx (CanvasRenderingContext2D), width (number), height (number), framesX (number, columns), framesY (number, rows).",
    "- For multi-frame sprites: width and height are the FULL sheet dimensions; one frame is (width/framesX) x (height/framesY). Draw frames left-to-right, top-to-bottom.",
    "- Do NOT call any APIs other than ctx.* (no fetch, no document, no window, no eval, no new Function, no createElement).",
    "- Do NOT reference any real-world brand, franchise, character name, or company. Generic descriptions only (e.g. 'red fox', NOT 'Pokemon fox').",
    "- The canvas comes pre-cleared to transparent. Draw your sprite directly.",
    "- Use ctx.fillRect with integer coords for crisp pixels. Do not use fillStyle gradients on edges.",
    "",
    "STYLE: see the user message for the chosen preset."
  ].join("\n");
}
function _ssBuildUserPrompt(description, stylePreset, width, height, framesX, framesY) {
  const styleNote = _SS_STYLE_PROMPTS[stylePreset] || _SS_STYLE_PROMPTS.snes;
  const frameNote = (framesX > 1 || framesY > 1)
    ? `Animation: ${framesX * framesY} frames arranged as ${framesX} cols x ${framesY} rows. Each frame is ${Math.floor(width/framesX)}x${Math.floor(height/framesY)} pixels.`
    : "Single frame.";
  return [
    `Sprite description: ${description}`,
    `Sheet size: ${width}x${height} pixels.`,
    frameNote,
    `Style: ${styleNote}`,
    "",
    "Now output the JavaScript paint code:"
  ].join("\n");
}

function _ssNextPow2(n) {
  let v = 256;
  while (v < n) v *= 2;
  return v;
}

/* §sd-polish -- poll /sprite-gen/info to mark installed models in the
 * dropdown and surface the current worker state. Updates the
 * #ss-model-status line below the dropdown.
 *
 * Output shapes (small bits, all defensive):
 *   server unreachable:  "compile-server not detected (defaults shown)"
 *   server ok, none installed: "no models installed -- run scripts/install-sd.sh"
 *   server ok, X installed:    "installed: z-image-turbo, sdxl • worker: idle"
 *   worker loaded:             "installed: z-image-turbo • worker: z-image-turbo (ready)" */
async function _ssRefreshModelStatus() {
  const statusEl = document.getElementById("ss-model-status");
  const modelEl  = document.getElementById("ss-sd-model");
  if (!statusEl || !modelEl) return;
  statusEl.textContent = "checking compile-server…";
  const base = (typeof localServerEndpoint === "string" && localServerEndpoint)
    ? localServerEndpoint
    : "http://127.0.0.1:8765";
  try {
    const res = await fetch(base.replace(/\/+$/, "") + "/sprite-gen/info", {
      method: "GET",
      cache: "no-store"
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const info = await res.json();
    if (!info || !info.models) throw new Error("missing models field");
    // Decorate dropdown options with an installed marker.
    const opts = modelEl.querySelectorAll("option");
    const installed = [];
    opts.forEach(opt => {
      const m = info.models[opt.value];
      const ok = m && m.installed;
      // Strip any previous prefix added by us, then prepend new marker.
      const label = (opt.textContent || "").replace(/^(✓ |• )/, "");
      opt.textContent = (ok ? "✓ " : "• ") + label;
      if (ok) installed.push(opt.value);
    });
    let line = "";
    if (installed.length === 0) {
      line = "no models installed — run scripts/install-sd.sh in the compile-server";
    } else {
      line = "installed: " + installed.join(", ");
    }
    if (info.currentWorker) {
      line += " • worker: " + info.currentWorker.model +
              (info.currentWorker.ready ? " (ready)" : " (loading…)");
    } else {
      line += " • worker: idle";
    }
    statusEl.textContent = line;
  } catch (e) {
    statusEl.textContent = "compile-server not detected (defaults shown)";
  }
}

/* Sprint sprite-sd-1 -- call AUTOMATIC1111 webui's txt2img endpoint.
 * Returns a Blob (PNG) on success. Throws on network / API errors.
 *
 * A1111 native generation size is set per-call (we use 512×512 for
 * fidelity); the result is downsampled to the user's target sprite
 * dims via nearest-neighbor in _ssDownsampleBlob.
 *
 * Prompt construction:
 *   - Prepend pixel-art keywords matching the chosen style preset.
 *   - Append a strong negative prompt (blur / AA / gradient / artifacts).
 *   - Don't enrich with corporate IP terms; respect the system rule. */
const _SS_SD_NEGATIVE = "blurry, smooth, anti-aliased, soft, gradient, low quality, watermark, text, signature, jpeg artifacts, motion blur, dithered, noisy, scenery, environment, landscape, background details, props, multiple subjects, tiny subject, distant subject, cropped";
const _SS_SD_STYLE_PROMPTS = {
  snes:    "pixel art, 16-bit SNES style, crisp pixels, limited 16-color palette, hard edges, no anti-aliasing",
  nes:     "pixel art, 8-bit NES style, 4 colors, blocky, hard edges, no anti-aliasing",
  gameboy: "pixel art, Game Boy DMG style, 4-shade green palette (#0f380f, #306230, #8bac0f, #9bbc0f), hard edges",
  modern:  "pixel art, modern indie game style, crisp pixels, limited palette"
};
/* Composition tail appended to every SD prompt. The key things this
 * does: push subject to fill the frame (otherwise the model loves
 * to leave 60% empty space around it -- looks fine in art galleries,
 * useless for a 32×32 sprite where the subject ends up 8px tall),
 * and lock the background to plain white so the chroma-key in
 * _ssDownsampleBlob can isolate the sprite cleanly. */
const _SS_SD_COMPOSITION = "subject fills entire frame, full body in view, large centered subject, isolated subject, on plain pure white background #ffffff, no scenery, no decoration";
/* Sprint sprite-sd-2 -- call the compile-server's /sprite-gen route,
 * which proxies to a persistent Python SD worker. The server returns a
 * raw PNG; we just package it into a Blob.
 *
 * Endpoint URL: compile-server's base (auto-detected by the existing
 * compileServer.detect path; default http://127.0.0.1:8765).
 *
 * Model + LoRA defaults live server-side per the MODELS map in
 * sd-route.js; the browser only sends `model`, `prompt`, `width`,
 * `height`, `steps?`, `seed?`, and the server fills the rest. */
async function _ssCallCompileServerSD(serverBase, model, prompt, stylePreset, nativeSize, steps, seed) {
  const styleNote = _SS_SD_STYLE_PROMPTS[stylePreset] || _SS_SD_STYLE_PROMPTS.snes;
  const fullPrompt = styleNote + ", " + prompt + ", " + _SS_SD_COMPOSITION;
  const url = serverBase.replace(/\/+$/, "") + "/sprite-gen";
  const body = {
    model,
    prompt: fullPrompt,
    negative: _SS_SD_NEGATIVE,
    width: nativeSize,
    height: nativeSize,
    steps: Math.max(1, Math.floor(steps))
  };
  // Optional seed -- critical for multi-pose batches where every
  // frame must look like the same character. Caller picks one random
  // seed before the loop and passes it to every per-frame call.
  if (typeof seed === "number" && seed >= 0) body.seed = seed;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error("Cannot reach compile-server at " + serverBase
      + " — is `gamma-compile-server` running and has scripts/install-sd.sh been run? " + (e.message || e));
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.error || JSON.stringify(j);
    } catch (_) {}
    throw new Error("compile-server /sprite-gen " + res.status + ": " + detail);
  }
  const elapsedMs = res.headers.get("X-SD-Elapsed-Ms");
  const device = res.headers.get("X-SD-Device");
  if (elapsedMs || device) {
    console.log("[sprite-studio] SD generated in " + elapsedMs + "ms on " + device);
  }
  return await res.blob();
}

async function _ssCallA1111(endpoint, prompt, stylePreset, nativeSize, steps, sampler) {
  const url = (endpoint || "http://localhost:7860").replace(/\/+$/, "") + "/sdapi/v1/txt2img";
  const styleNote = _SS_SD_STYLE_PROMPTS[stylePreset] || _SS_SD_STYLE_PROMPTS.snes;
  const fullPrompt = styleNote + ", " + prompt + ", " + _SS_SD_COMPOSITION;
  const body = {
    prompt: fullPrompt,
    negative_prompt: _SS_SD_NEGATIVE,
    width: nativeSize,
    height: nativeSize,
    steps: Math.max(5, Math.min(100, Math.floor(steps))),
    sampler_name: sampler || "DPM++ 2M Karras",
    cfg_scale: 7.0,
    seed: -1
  };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error("Cannot reach A1111 at " + endpoint + " (is the webui running with --api?). " + (e.message || e));
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("A1111 " + res.status + ": " + (txt || res.statusText));
  }
  const data = await res.json();
  if (!data.images || !data.images.length) throw new Error("A1111 returned no images");
  // images[0] is a base64 PNG (no data: prefix).
  const b64 = data.images[0];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: "image/png" });
}

/* Downsample a Blob (PNG) to the target sprite dimensions using
 * nearest-neighbor filtering, returning a new PNG Blob. This is what
 * makes 1024×1024 SD output land on a 32×32 sprite as crisp pixels.
 * Also strips the (prompted) white background via a chroma-key so the
 * resulting sprite has a transparent background and can be composited
 * straight into a Scene2D without a halo. */
async function _ssDownsampleBlob(srcBlob, targetW, targetH) {
  const bmp = await createImageBitmap(srcBlob);
  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, targetW, targetH);
  if (bmp.close) try { bmp.close(); } catch (_) {}
  // Chroma-key the prompted white background. We push hard for
  // "plain pure white background" in _SS_SD_COMPOSITION, so a tight
  // threshold cleanly isolates the sprite without eating its own
  // highlights (white-on-fur is rare and usually <230 in practice).
  _ssChromaKeyWhite(canvas, ctx, 232);
  return await canvas.convertToBlob({ type: "image/png" });
}

/* Mark every pixel whose RGB channels are all ≥ `threshold` as
 * transparent. The threshold is tuned for SD's "plain white" output:
 * 232 catches near-white halos around the subject while preserving
 * the sprite's own light tones (which usually fall in the 180-220
 * range after the pixel-art LoRA/prompt collapses the palette). */
function _ssChromaKeyWhite(canvas, ctx, threshold) {
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const t = threshold ?? 232;
  let cleared = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] >= t && d[i + 1] >= t && d[i + 2] >= t) {
      d[i + 3] = 0;
      cleared++;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cleared;
}

/* Build a list of N pose-variant prompt fragments for a multi-frame
 * sprite-sheet batch. Pose names land in the model prompt as
 * "<description>, <pose>, side view, ...composition tail". Combined
 * with a shared seed across all frames, this produces a consistent
 * character animated through the poses.
 *
 * Recipes are hardcoded for the common SNES-era walk-cycle counts
 * (1 / 2 / 4 / 6 / 8). Arbitrary counts fall through to an
 * idle-alternate pattern so a 12-frame sheet still has variety. */
function _ssBuildPosePrompts(totalFrames) {
  if (totalFrames <= 1) return [""];
  if (totalFrames === 2) return ["idle stance, side view", "walking pose, side view"];
  if (totalFrames === 4) return [
    "idle stance, side view",
    "walking, right foot forward, side view",
    "idle stance mid-stride, side view",
    "walking, left foot forward, side view"
  ];
  if (totalFrames === 6) return [
    "idle stance, side view",
    "walking, right foot lift, side view",
    "walking, right foot forward, side view",
    "idle stance mid-stride, side view",
    "walking, left foot lift, side view",
    "walking, left foot forward, side view"
  ];
  if (totalFrames === 8) return [
    "idle stance, side view",
    "walking, right foot slight lift, side view",
    "walking, right foot mid stride, side view",
    "walking, right foot forward full step, side view",
    "idle stance, side view",
    "walking, left foot slight lift, side view",
    "walking, left foot mid stride, side view",
    "walking, left foot forward full step, side view"
  ];
  // Fallback for arbitrary N: alternate idle / walk / idle / walk-other.
  const variants = [
    "idle stance, side view",
    "walking, right foot forward, side view",
    "idle stance mid-stride, side view",
    "walking, left foot forward, side view"
  ];
  return Array.from({ length: totalFrames }, (_, i) => variants[i % variants.length]);
}

/* Stitch N already-downsampled per-frame blobs into a single sheet
 * canvas of dimensions (frameW*cols) × (frameH*rows). Frames are
 * laid out left-to-right, top-to-bottom -- the same convention
 * Scene2D / Sprite expects when reading framesX/framesY metadata. */
async function _ssStitchSheet(frameBlobs, frameW, frameH, cols, rows) {
  const sheetW = frameW * cols;
  const sheetH = frameH * rows;
  const canvas = new OffscreenCanvas(sheetW, sheetH);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, sheetW, sheetH);
  for (let i = 0; i < frameBlobs.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const bmp = await createImageBitmap(frameBlobs[i]);
    ctx.drawImage(bmp, col * frameW, row * frameH);
    if (bmp.close) try { bmp.close(); } catch (_) {}
  }
  return await canvas.convertToBlob({ type: "image/png" });
}

/* Strip markdown fences if Claude wrapped the code despite instructions. */
function _ssExtractJsFromResponse(text) {
  if (!text) return "";
  // Match ```javascript ... ``` or ``` ... ``` fences.
  const fence = text.match(/```(?:javascript|js)?\s*\n?([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return text.trim();
}

/* Run the generated JS against an OffscreenCanvas, return the bitmap.
 * Throws if the code errors. Time-budget: hard 2-second cap via setTimeout
 * defeats infinite loops only across yields (a tight sync loop will still
 * hang for now; Worker isolation in -2 fixes that). */
async function _ssExecutePaintCode(code, width, height, framesX, framesY) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // Match the sprite shader's "pixelated" rendering convention.
  ctx.imageSmoothingEnabled = false;
  // Throws if code is invalid JavaScript.
  const fn = new Function("ctx", "width", "height", "framesX", "framesY", code);
  fn(ctx, width, height, framesX, framesY);
  return await canvas.convertToBlob({ type: "image/png" });
}

/* Open / close the Sprite Studio modal.
 *
 * When called with a SpriteCreator nodeId, preload the modal's inputs
 * from the node's params (prompt / style / size / frames / fps / scale)
 * and remember the nodeId so Save writes the new asset name back to
 * node.params.lastAssetName. When called without a nodeId (e.g. from
 * a future topbar button or REPL), the modal opens with whatever
 * inputs are already in place. */
function _ssOpen(nodeId) {
  const modal = document.getElementById("spritestudio-modal");
  if (!modal) return;
  modal.style.display = "flex";
  modal._ssSourceNodeId = nodeId || null;
  // Prefill from the SpriteCreator node's params if one was supplied.
  if (nodeId) {
    const node = (typeof nodeById === "function") ? nodeById(nodeId) : null;
    if (node && node.params) {
      const p = node.params;
      if (typeof p.prompt   === "string") document.getElementById("ss-prompt").value = p.prompt;
      if (typeof p.style    === "string") document.getElementById("ss-preset").value = p.style;
      if (typeof p.width    === "number") document.getElementById("ss-width").value  = p.width;
      if (typeof p.height   === "number") document.getElementById("ss-height").value = p.height;
      if (typeof p.framesX  === "number") document.getElementById("ss-framesX").value = p.framesX;
      if (typeof p.framesY  === "number") document.getElementById("ss-framesY").value = p.framesY;
      if (typeof p.fps      === "number") document.getElementById("ss-fps").value    = p.fps;
      if (typeof p.scale    === "number") document.getElementById("ss-scale").value  = p.scale;
    }
  }
  // Default name to a slugified prompt-ish placeholder if empty.
  const nameEl = document.getElementById("ss-name");
  if (nameEl && !nameEl.value) nameEl.value = "sprite-" + Date.now().toString(36).slice(-5);
  // §sd-1 -- prefill SD endpoint / steps / sampler / chosen backend
  // from persisted aiSettings so the user's last picks come back.
  const backendEl = document.getElementById("ss-backend");
  if (backendEl) {
    backendEl.value = aiSettings.spriteBackend || "llm-canvas";
    if (backendEl._ssUpdateUI) backendEl._ssUpdateUI();
  }
  const sdEndpointEl = document.getElementById("ss-sd-endpoint");
  if (sdEndpointEl) sdEndpointEl.value = aiSettings.sdEndpoint || "http://localhost:7860";
  const sdStepsEl = document.getElementById("ss-sd-steps");
  if (sdStepsEl) sdStepsEl.value = aiSettings.sdSteps || 20;
  const sdSamplerEl = document.getElementById("ss-sd-sampler");
  if (sdSamplerEl) sdSamplerEl.value = aiSettings.sdSampler || "DPM++ 2M Karras";
  // §sd-polish -- model dropdown for the compile-server SD backend.
  const sdModelEl = document.getElementById("ss-sd-model");
  if (sdModelEl) sdModelEl.value = aiSettings.sdModel || "z-image-turbo";
  const sdQualityEl = document.getElementById("ss-sd-quality");
  if (sdQualityEl) sdQualityEl.value = aiSettings.sdQuality || "512";
  // Fetch /sprite-gen/info to mark which models are actually downloaded
  // on the server. Async; no spinner -- status line updates when reply
  // arrives (typically 10-50 ms for the compile-server probe).
  _ssRefreshModelStatus();
  _ssRedrawPreview(null);  // clear preview if any
  const promptEl = document.getElementById("ss-prompt");
  if (promptEl) setTimeout(() => promptEl.focus(), 50);
}
function _ssClose() {
  const modal = document.getElementById("spritestudio-modal");
  if (modal) {
    modal.style.display = "none";
    modal._ssSourceNodeId = null;
  }
}

/* ───────────────────────────────────────────────────────────────
 * Sprint tilemap-painter -- visual click-paint editor for
 * Tilemap2D nodes. Opens via the ⚙ gear handle on a Tilemap2D
 * node. Loads tileData + palette + dims into a canvas grid;
 * user paints with brush '.', '1'..'5'; Save writes the modified
 * tileData back to the node and triggers a mesh rebuild via the
 * existing meshCacheKey path.
 *
 * State held on the DOM modal element itself (modal._tme):
 *   nodeId    -- the source Tilemap2D
 *   rows[]    -- working copy of tileData split into row strings
 *   brush     -- active paint character
 *   cellPx    -- canvas-side cell size (16 px)
 *   palette   -- [{ch, color}] for swatch rendering
 *   painting  -- true while pointer is down (paint stroke)
 *   eraseMode -- true if right button held (paints '.')
 * ─────────────────────────────────────────────────────────────── */
const _TME_BRUSH_CHARS = [".", "1", "2", "3", "4", "5"];
const _TME_BRUSH_LABELS = {
  ".": "empty (sky)",
  "1": "grass / color1",
  "2": "dirt / color2",
  "3": "stone / color3",
  "4": "pickup '4'",
  "5": "goal '5'"
};

function _tmeOpen(nodeId) {
  if (!state || !Array.isArray(state.nodes)) return;
  const node = state.nodes.find(n => n && n.id === nodeId);
  if (!node || node.type !== "Tilemap2D") {
    console.warn("[tilemap-painter] node not found or not Tilemap2D: " + nodeId);
    return;
  }
  const modal = document.getElementById("tilemap-editor-modal");
  if (!modal) return;
  const p = node.params || {};
  const data = (typeof p.tileData === "string") ? p.tileData : "";
  // Split into mutable row array. Pad short rows so the grid is
  // rectangular (avoids ragged-edge clicks landing in undefined col).
  let rows = data.split(/\r?\n/);
  const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);
  rows = rows.map(r => r.padEnd(maxLen, "."));
  // Build palette swatches from the node's current color params.
  const palette = _TME_BRUSH_CHARS.map(ch => ({
    ch,
    color: _tmeColorForChar(ch, p)
  }));
  modal._tme = {
    nodeId,
    rows,
    cols: maxLen,
    nRows: rows.length,
    brush: "1",
    cellPx: 16,
    palette,
    painting: false,
    eraseMode: false
  };
  document.getElementById("tme-cols").value = maxLen;
  document.getElementById("tme-rows").value = rows.length;
  document.getElementById("tme-status").textContent =
    "Tilemap2D#" + node.id + " — " + maxLen + " × " + rows.length;
  _tmeRenderPalette();
  _tmeRenderGrid();
  modal.style.display = "flex";
}

function _tmeClose() {
  const modal = document.getElementById("tilemap-editor-modal");
  if (modal) {
    modal.style.display = "none";
    modal._tme = null;
  }
}

/* Convert a tile char to a CSS hex color using the node's palette
 * params (color1R/G/B etc). For '.' returns transparent-marker dark
 * gray so the brush UI shows it as the "empty" choice. */
function _tmeColorForChar(ch, p) {
  if (ch === "." || ch === " " || ch === "") return "#1a1f28";
  let r = 0.3, g = 0.55, b = 0.35;   // default = color1
  if (ch === "1" || ch === "#") { r = p.color1R ?? 0.30; g = p.color1G ?? 0.55; b = p.color1B ?? 0.35; }
  else if (ch === "2")          { r = p.color2R ?? 0.42; g = p.color2G ?? 0.28; b = p.color2B ?? 0.18; }
  else if (ch === "3")          { r = p.color3R ?? 0.55; g = p.color3G ?? 0.55; b = p.color3B ?? 0.62; }
  else if (ch === "4")          { r = p.color4R ?? 0.96; g = p.color4G ?? 0.90; b = p.color4B ?? 0.78; }
  else if (ch === "5")          { r = p.color5R ?? 0.92; g = p.color5G ?? 0.25; b = p.color5B ?? 0.30; }
  return "#" +
    [r, g, b].map(c => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, "0")).join("");
}

function _tmeRenderPalette() {
  const wrap = document.getElementById("tme-palette");
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!wrap || !tme) return;
  wrap.innerHTML = tme.palette.map(({ ch, color }) => {
    const active = (ch === tme.brush);
    const label = _TME_BRUSH_LABELS[ch] || ch;
    const border = active ? "var(--phosphor)" : "var(--instr-rule)";
    return '<button class="tme-brush-btn" data-brush="' + escapeAttr(ch) +
      '" style="display:flex; align-items:center; gap:8px; padding:5px 8px; ' +
      'background:var(--bg-1); color:var(--text-1); border:2px solid ' + border + '; ' +
      'border-radius:3px; cursor:pointer; font-family:var(--font-mono); font-size:10.5px; text-align:left;">' +
      '<span style="display:inline-block; width:18px; height:18px; background:' + color +
      '; border:1px solid var(--instr-rule); border-radius:2px;"></span>' +
      '<span style="opacity:0.92;">' + escapeText(ch) + '</span>' +
      '<span style="opacity:0.6; font-size:9.5px;">' + escapeText(label) + '</span>' +
      '</button>';
  }).join("");
  // Wire click handlers
  wrap.querySelectorAll(".tme-brush-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tme2 = document.getElementById("tilemap-editor-modal")._tme;
      if (!tme2) return;
      tme2.brush = btn.dataset.brush;
      _tmeRenderPalette();
    });
  });
}

function _tmeRenderGrid() {
  const canvas = document.getElementById("tme-grid");
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!canvas || !tme) return;
  const node = state.nodes.find(n => n && n.id === tme.nodeId);
  const p = (node && node.params) || {};
  const cell = tme.cellPx;
  const W = tme.cols * cell;
  const H = tme.nRows * cell;
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  // Background: dark sky gradient so '.' cells read as background.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#1a2840"); grad.addColorStop(1, "#2a3850");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Render each cell
  for (let r = 0; r < tme.nRows; r++) {
    const row = tme.rows[r];
    for (let c = 0; c < tme.cols; c++) {
      const ch = row[c] || ".";
      if (ch === "." || ch === " " || ch === "") continue;   // background already drawn
      ctx.fillStyle = _tmeColorForChar(ch, p);
      ctx.fillRect(c * cell, r * cell, cell, cell);
    }
  }
  // Grid lines (subtle)
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = 0; r <= tme.nRows; r++) { ctx.moveTo(0, r * cell + 0.5); ctx.lineTo(W, r * cell + 0.5); }
  for (let c = 0; c <= tme.cols;  c++) { ctx.moveTo(c * cell + 0.5, 0); ctx.lineTo(c * cell + 0.5, H); }
  ctx.stroke();
  // Highlight every-10th gridline + center marker so the user has
  // a sense of position (col 39.5 = world x=0 for a 80-col map).
  ctx.strokeStyle = "rgba(150,180,210,0.18)";
  ctx.beginPath();
  for (let r = 0; r <= tme.nRows; r += 5) { ctx.moveTo(0, r * cell + 0.5); ctx.lineTo(W, r * cell + 0.5); }
  for (let c = 0; c <= tme.cols;  c += 5) { ctx.moveTo(c * cell + 0.5, 0); ctx.lineTo(c * cell + 0.5, H); }
  ctx.stroke();
}

function _tmePaintCell(col, row, eraseMode) {
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!tme) return;
  if (col < 0 || col >= tme.cols || row < 0 || row >= tme.nRows) return;
  const newCh = eraseMode ? "." : tme.brush;
  const line = tme.rows[row];
  if (line[col] === newCh) return;   // no-op
  tme.rows[row] = line.substring(0, col) + newCh + line.substring(col + 1);
  // Redraw just this cell for snappy paint feel.
  const canvas = document.getElementById("tme-grid");
  const ctx = canvas.getContext("2d");
  const cell = tme.cellPx;
  const node = state.nodes.find(n => n && n.id === tme.nodeId);
  const p = (node && node.params) || {};
  // Clear cell + repaint background sliver under it
  ctx.fillStyle = "#1f2e44";
  ctx.fillRect(col * cell, row * cell, cell, cell);
  if (newCh !== "." && newCh !== " ") {
    ctx.fillStyle = _tmeColorForChar(newCh, p);
    ctx.fillRect(col * cell, row * cell, cell, cell);
  }
  // Re-stroke the cell's borders so gridlines stay visible
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.strokeRect(col * cell + 0.5, row * cell + 0.5, cell - 1, cell - 1);
}

function _tmeResize(newCols, newRows) {
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!tme) return;
  newCols = Math.max(1, Math.min(200, newCols | 0));
  newRows = Math.max(1, Math.min(100, newRows | 0));
  // Truncate or pad each existing row to newCols
  const newRowArr = [];
  for (let r = 0; r < newRows; r++) {
    if (r < tme.rows.length) {
      const old = tme.rows[r];
      newRowArr.push(old.length >= newCols ? old.substring(0, newCols) : old.padEnd(newCols, "."));
    } else {
      newRowArr.push(".".repeat(newCols));
    }
  }
  tme.rows = newRowArr;
  tme.cols = newCols;
  tme.nRows = newRows;
  document.getElementById("tme-status").textContent =
    "Tilemap2D#" + tme.nodeId + " — " + newCols + " × " + newRows + " (resized)";
  _tmeRenderGrid();
}

function _tmeSave() {
  const modal = document.getElementById("tilemap-editor-modal");
  const tme = modal && modal._tme;
  if (!tme) return;
  const node = state.nodes.find(n => n && n.id === tme.nodeId);
  if (!node) return;
  pushHistory("tilemap-painter:save:" + tme.nodeId);
  node.params = node.params || {};
  const newData = tme.rows.join("\n");
  const oldLen = (node.params.tileData || "").length;
  node.params.tileData = newData;
  console.log("[tilemap-painter] saved " + tme.cols + "×" + tme.nRows +
    " to " + tme.nodeId + ": " + oldLen + " -> " + newData.length + " chars" +
    (oldLen === newData.length ? " (size unchanged; mesh cache key still differs due to content)" : ""));
  // Belt-and-braces invalidation: the cacheKey check in _ensureMeshBuffers
  // SHOULD pick up the tileData mutation on the next frame, but make it
  // explicit so a stale cache can't possibly survive a save.
  if (typeof Visual !== "undefined" && Visual.meshBufferCache) {
    const cached = Visual.meshBufferCache.get(tme.nodeId);
    if (cached) {
      try { cached.vertexBuffer && cached.vertexBuffer.destroy(); } catch (_) {}
      try { cached.indexBuffer  && cached.indexBuffer.destroy();  } catch (_) {}
      Visual.meshBufferCache.delete(tme.nodeId);
      console.log("[tilemap-painter] mesh buffer cache cleared for " + tme.nodeId);
    }
  }
  // Also clear the tilemap's collision cache so PlatformerBody2D re-parses.
  node._collisionCacheKey = null;
  node._collisionCache    = null;
  // Anything downstream that depends on this mesh (TileSpriteOverlay,
  // PickupCollector, LevelGoal2D, TileSpriteOverlay overlays) reads the
  // tileData live, so they pick up the change on their next tick.
  _tmeClose();
  if (typeof render      === "function") render();
  if (typeof renderProps === "function") renderProps();
}

/* Wire up DOM event handlers once at startup. Click + drag paints
 * with the brush; right-click drags erase to '.'. */
function _tmeInstall() {
  const modal = document.getElementById("tilemap-editor-modal");
  if (!modal || modal._tmeWired) return;
  modal._tmeWired = true;
  const closeBtn  = document.getElementById("tme-close");
  const cancelBtn = document.getElementById("tme-cancel");
  const saveBtn   = document.getElementById("tme-save");
  const resizeBtn = document.getElementById("tme-resize");
  const canvas    = document.getElementById("tme-grid");
  if (closeBtn)  closeBtn.addEventListener("click", _tmeClose);
  if (cancelBtn) cancelBtn.addEventListener("click", _tmeClose);
  if (saveBtn)   saveBtn.addEventListener("click", _tmeSave);
  if (resizeBtn) resizeBtn.addEventListener("click", () => {
    const c = parseInt(document.getElementById("tme-cols").value, 10) || 1;
    const r = parseInt(document.getElementById("tme-rows").value, 10) || 1;
    _tmeResize(c, r);
  });
  if (canvas) {
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("pointerdown", e => {
      const tme = modal._tme; if (!tme) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      tme.painting = true;
      tme.eraseMode = (e.button === 2);
      const rect = canvas.getBoundingClientRect();
      const col = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width)  / tme.cellPx);
      const row = Math.floor((e.clientY - rect.top)  * (canvas.height / rect.height) / tme.cellPx);
      _tmePaintCell(col, row, tme.eraseMode);
    });
    canvas.addEventListener("pointermove", e => {
      const tme = modal._tme; if (!tme || !tme.painting) return;
      const rect = canvas.getBoundingClientRect();
      const col = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width)  / tme.cellPx);
      const row = Math.floor((e.clientY - rect.top)  * (canvas.height / rect.height) / tme.cellPx);
      _tmePaintCell(col, row, tme.eraseMode);
    });
    canvas.addEventListener("pointerup", e => {
      const tme = modal._tme; if (!tme) return;
      tme.painting = false;
      tme.eraseMode = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    });
  }
  // ESC closes
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display !== "none") _tmeClose();
  });
  // Backdrop click closes
  modal.addEventListener("click", (e) => {
    if (e.target === modal) _tmeClose();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", _tmeInstall);
}

/* ───────────────────────────────────────────────────────────────
 * Sprint Level2D Phase 1b -- layer-list modal for Level2D nodes.
 * Visual editor for the layers JSON: add/remove/reorder layers
 * and tweak per-layer fields (depthZ, parallaxX, texture URL,
 * tileData, etc.) without hand-editing JSON in the props pane.
 *
 * State held on the modal DOM element (modal._lvl):
 *   nodeId   -- the Level2D being edited
 *   layers[] -- working copy of params.layers (parsed JSON)
 *
 * Defaults for "+ Add" use sensible starting points so a freshly
 * added layer is immediately visible (e.g. a new parallax layer
 * defaults to the parallax-sky asset at depthZ=60). User tunes
 * from there. Save serializes back; Cancel discards working copy.
 * ─────────────────────────────────────────────────────────────── */

const _LVL_LAYER_DEFAULTS = {
  parallax: {
    type: "parallax", name: "parallax-bg",
    depthZ: 40,
    parallaxX: 0.15,
    texWorldWidth: 30,
    screenScaleY: 0.7,
    screenAnchorY: 0.5,
    worldOffsetY: 0,
    tintR: 1, tintG: 1, tintB: 1, tintA: 1,
    texture: "asset:parallax-sky",
    wrapMode: "repeat-x",
    filterMode: "linear"
  },
  tilemap: {
    type: "tilemap", name: "tilemap",
    depthZ: 0,
    collides: true,
    tileSize: 1,
    originX: 0, originY: 0,
    tileData: "................\n................\n................\n................\n................\n................\n11111111111111111\n22222222222222222",
    color1R: 0.30, color1G: 0.55, color1B: 0.35,
    color2R: 0.42, color2G: 0.28, color2B: 0.18,
    color3R: 0.55, color3G: 0.55, color3B: 0.62,
    color4R: 0.96, color4G: 0.90, color4B: 0.78,
    color5R: 0.92, color5G: 0.25, color5B: 0.30,
    skipRenderChars: "",
    // Phase 2 tileset path. Default to the shipped demo-tileset
    // so a fresh tilemap layer renders textured immediately. Set
    // tileset to "" to fall back to the vertex-color palette path.
    tileset: "asset:demo-tileset",
    tileMap: { "1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5, "7": 6, "8": 7 },
    tilesetFramesX: 4,
    tilesetFramesY: 2
  },
  scatter: {
    type: "scatter", name: "scatter",
    depthZ: -0.3,
    texture: "asset:grass-tuft",
    filterMode: "nearest",
    wrapMode: "clamp",
    positions: "-10,-3.5;-5,-3.5;0,-3.5;5,-3.5;10,-3.5",
    scale: 0.6,
    anchorX: 0.5, anchorY: 0,
    frame: 0, framesX: 1, framesY: 1,
    tintR: 1, tintG: 1, tintB: 1, tintA: 1
  }
};

function _lvlOpen(nodeId) {
  if (!state || !Array.isArray(state.nodes)) return;
  const node = state.nodes.find(n => n && n.id === nodeId);
  if (!node || node.type !== "Level2D") {
    console.warn("[level-editor] node not found or not Level2D: " + nodeId);
    return;
  }
  const modal = document.getElementById("level2d-editor-modal");
  if (!modal) return;
  // Parse current layers JSON. If malformed, log + start with empty.
  let layers = [];
  try {
    const raw = (node.params && typeof node.params.layers === "string") ? node.params.layers : "[]";
    layers = JSON.parse(raw);
    if (!Array.isArray(layers)) layers = [];
  } catch (e) {
    console.warn("[level-editor] layers JSON parse failed, starting empty: " + e.message);
    layers = [];
  }
  modal._lvl = {
    nodeId,
    // Deep clone so cancel discards changes.
    layers: JSON.parse(JSON.stringify(layers)),
    // Per-layer-idx painter state (active brush, painting flag).
    // Lives only while the modal is open; not persisted to the patch.
    paintState: {},
    // Per-layer-idx scatter canvas state (drag/hover, cached bitmap).
    scatterState: {},
    // Per-layer-idx ephemeral state. _prevTileSize is captured here
    // (not on layer itself) so it doesn't leak into the saved JSON.
    layerState: {}
  };
  // Seed _prevTileSize for tilemap layers so the first tileSize edit
  // can compare against the open-time value (Phase 3.1 auto-resize).
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l && l.type === "tilemap") {
      modal._lvl.layerState[i] = { _prevTileSize: (typeof l.tileSize === "number" && l.tileSize > 0) ? l.tileSize : 1 };
    }
  }
  document.getElementById("lvl-status").textContent =
    "Level2D#" + node.id + " — " + layers.length + " layer(s)";
  _lvlRenderList();
  modal.style.display = "flex";
}

function _lvlClose() {
  const modal = document.getElementById("level2d-editor-modal");
  if (modal) {
    modal.style.display = "none";
    modal._lvl = null;
  }
}

function _lvlAddLayer(type) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const template = _LVL_LAYER_DEFAULTS[type];
  if (!template) { console.warn("[level-editor] unknown layer type: " + type); return; }
  // Clone template + give a unique-ish name based on count.
  const clone = JSON.parse(JSON.stringify(template));
  const sameTypeCount = lvl.layers.filter(l => l && l.type === type).length;
  clone.name = type + (sameTypeCount > 0 ? "-" + (sameTypeCount + 1) : "");
  lvl.layers.push(clone);
  _lvlRenderList();
}

function _lvlMoveLayer(idx, dir) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const tgt = idx + dir;
  if (tgt < 0 || tgt >= lvl.layers.length) return;
  const tmp = lvl.layers[idx];
  lvl.layers[idx] = lvl.layers[tgt];
  lvl.layers[tgt] = tmp;
  _lvlRenderList();
}

function _lvlDeleteLayer(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  lvl.layers.splice(idx, 1);
  _lvlRenderList();
}

/* Mutate a single field on a layer + skip re-render (the input
 * already shows the new value; re-rendering would lose focus). */
function _lvlSetField(idx, field, value) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl || idx >= lvl.layers.length) return;
  lvl.layers[idx][field] = value;
  // Update layer count + name display in the status line.
  const layer = lvl.layers[idx];
  if (field === "name" || field === "depthZ") {
    _lvlUpdateCardHeader(idx);
  }
}

function _lvlUpdateCardHeader(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const headEl = document.getElementById("lvl-card-head-" + idx);
  if (headEl && layer) {
    headEl.textContent = (layer.name || "(unnamed)") + "  ·  " + layer.type + "  ·  z=" + (layer.depthZ ?? 0);
  }
}

function _lvlRenderList() {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  const wrap = document.getElementById("lvl-layers");
  const countEl = document.getElementById("lvl-layer-count");
  if (!wrap || !lvl) return;
  if (countEl) countEl.textContent = lvl.layers.length + " layer(s)";
  // Build all cards via innerHTML for speed, then wire handlers.
  wrap.innerHTML = lvl.layers.map((layer, idx) => _lvlRenderCard(layer, idx)).join("");
  // Wire reorder / delete / field-edit handlers on each card.
  for (let idx = 0; idx < lvl.layers.length; idx++) _lvlWireCard(idx);
  // Phase 2b: async-hydrate the tilemap painter for any tilemap
  // layer. Fire-and-forget; await happens inside the hydrate fn.
  for (let idx = 0; idx < lvl.layers.length; idx++) {
    const layer = lvl.layers[idx];
    if (layer && layer.type === "tilemap") {
      _lvlWireTilemapPainter(idx);
      _lvlHydrateTilemapPainter(idx);
    } else if (layer && layer.type === "scatter") {
      // Phase 3: scatter placement canvas.
      _lvlWireScatterCanvas(idx);
      _lvlHydrateScatterCanvas(idx);
    }
  }
}

function _lvlRenderCard(layer, idx) {
  const name = escapeText(layer.name || "(unnamed)");
  const type = layer.type || "?";
  const z = layer.depthZ ?? 0;
  // Color-code by type so the eye can scan the layer stack.
  const typeColor = type === "parallax" ? "#8aa3d0"
                  : type === "tilemap"  ? "#9bd0a0"
                  : type === "scatter"  ? "#d0a98a"
                  : "#888";
  let bodyHtml = "";
  if (type === "parallax") bodyHtml = _lvlRenderParallaxFields(layer, idx);
  else if (type === "tilemap") bodyHtml = _lvlRenderTilemapFields(layer, idx);
  else if (type === "scatter") bodyHtml = _lvlRenderScatterFields(layer, idx);
  else bodyHtml = '<div style="font-family:var(--font-mono); font-size:10px; color:#ff8060;">unknown layer type: ' + escapeText(type) + '</div>';
  return '' +
    '<div class="lvl-card" data-idx="' + idx + '" style="border:1px solid var(--instr-rule); border-radius:4px; background:var(--bg-1); padding:8px 10px;">' +
      '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">' +
        '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:' + typeColor + ';"></span>' +
        '<span id="lvl-card-head-' + idx + '" style="flex:1; font-family:var(--font-mono); font-size:11px; color:var(--text-1);">' + name + '  ·  ' + escapeText(type) + '  ·  z=' + z + '</span>' +
        '<button class="btn lvl-up"     data-idx="' + idx + '" title="Move up (drawn earlier / further back)">↑</button>' +
        '<button class="btn lvl-down"   data-idx="' + idx + '" title="Move down (drawn later / closer to camera)">↓</button>' +
        '<button class="btn lvl-delete" data-idx="' + idx + '" title="Remove this layer" style="color:#ff8060;">×</button>' +
      '</div>' +
      '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 12px;">' +
        '<div>' +
          '<div class="lvl-label">NAME</div>' +
          '<input class="lvl-name-in"  data-idx="' + idx + '" type="text"   value="' + escapeAttr(layer.name || "") + '" />' +
        '</div>' +
        '<div>' +
          '<div class="lvl-label">DEPTH-Z  (lower = nearer)</div>' +
          '<input class="lvl-z-in"     data-idx="' + idx + '" type="number" step="0.1" value="' + (layer.depthZ ?? 0) + '" />' +
        '</div>' +
      '</div>' +
      bodyHtml +
    '</div>';
}

function _lvlRenderParallaxFields(layer, idx) {
  return '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 12px; margin-top:6px;">' +
    '<div><div class="lvl-label">TEXTURE</div><input class="lvl-x-in"      data-idx="' + idx + '" data-field="texture"      type="text"   value="' + escapeAttr(layer.texture || "") + '" /></div>' +
    '<div><div class="lvl-label">PARALLAX-X  (0..1)</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="parallaxX" type="number" step="0.01" value="' + (layer.parallaxX ?? 0.15) + '" /></div>' +
    '<div><div class="lvl-label">TEX WORLD WIDTH</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="texWorldWidth" type="number" step="1" value="' + (layer.texWorldWidth ?? 30) + '" /></div>' +
    '<div><div class="lvl-label">SCREEN SCALE-Y</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="screenScaleY" type="number" step="0.05" value="' + (layer.screenScaleY ?? 1.0) + '" /></div>' +
    '<div><div class="lvl-label">SCREEN ANCHOR-Y</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="screenAnchorY" type="number" step="0.05" value="' + (layer.screenAnchorY ?? 0.5) + '" /></div>' +
    '<div><div class="lvl-label">WORLD OFFSET-Y</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="worldOffsetY" type="number" step="0.1" value="' + (layer.worldOffsetY ?? 0) + '" /></div>' +
    '<div><div class="lvl-label">FILTER</div>' +
      '<select class="lvl-x-in" data-idx="' + idx + '" data-field="filterMode">' +
        '<option value="nearest"' + (layer.filterMode === "nearest" ? " selected" : "") + '>nearest</option>' +
        '<option value="linear"'  + (layer.filterMode === "linear"  ? " selected" : "") + '>linear</option>' +
      '</select>' +
    '</div>' +
    '<div><div class="lvl-label">WRAP</div>' +
      '<select class="lvl-x-in" data-idx="' + idx + '" data-field="wrapMode">' +
        '<option value="clamp">clamp</option>' +
        '<option value="repeat"'   + (layer.wrapMode === "repeat"   ? " selected" : "") + '>repeat</option>' +
        '<option value="repeat-x"' + (layer.wrapMode === "repeat-x" ? " selected" : "") + '>repeat-x</option>' +
        '<option value="repeat-y"' + (layer.wrapMode === "repeat-y" ? " selected" : "") + '>repeat-y</option>' +
      '</select>' +
    '</div>' +
    '</div>';
}

function _lvlRenderTilemapFields(layer, idx) {
  const data = (layer.tileData || "");
  const rows = data.split("\n").length;
  const cols = data.split("\n").reduce((m, r) => Math.max(m, r.length), 0);
  const tileMapStr = (typeof layer.tileMap === "object" && layer.tileMap !== null)
    ? JSON.stringify(layer.tileMap)
    : (typeof layer.tileMap === "string" ? layer.tileMap : "");
  const tilesetEnabled = !!(layer.tileset && layer.tileset.length);
  // Phase 2b -- visual painter. Two canvases (palette + paint grid).
  // Hydrated asynchronously by _lvlHydrateTilemapPainter once the
  // tileset bitmap loads. Always emit the painter container so
  // toggling tileset on/off rebinds without a full card rerender;
  // hydrate writes a "set tileset" placeholder when empty.
  return '<div style="margin-top:6px;">' +
    '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 12px;">' +
      '<div><div class="lvl-label">TILE SIZE (world units)</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="tileSize" type="number" step="0.1" value="' + (layer.tileSize ?? 1) + '" /></div>' +
      '<div><div class="lvl-label">COLLIDES (Phase 5 actually enforces)</div>' +
        '<select class="lvl-x-in" data-idx="' + idx + '" data-field="collides">' +
          '<option value="true"'  + (layer.collides !== false ? " selected" : "") + '>yes</option>' +
          '<option value="false"' + (layer.collides === false ? " selected" : "") + '>no</option>' +
        '</select></div>' +
      '<div><div class="lvl-label">ORIGIN-X</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="originX" type="number" step="0.1" value="' + (layer.originX ?? 0) + '" /></div>' +
      '<div><div class="lvl-label">ORIGIN-Y</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="originY" type="number" step="0.1" value="' + (layer.originY ?? 0) + '" /></div>' +
      '<div><div class="lvl-label">SKIP RENDER CHARS</div><input class="lvl-x-in" data-idx="' + idx + '" data-field="skipRenderChars" type="text" value="' + escapeAttr(layer.skipRenderChars || "") + '" /></div>' +
    '</div>' +
    '<div style="margin-top:8px; padding:8px; border:1px dashed var(--instr-rule); border-radius:3px; background:rgba(80,120,80,0.05);">' +
      '<div style="font-family:var(--font-mono); font-size:9.5px; color:' + (tilesetEnabled ? "#9bd0a0" : "var(--text-3)") + '; letter-spacing:0.06em; margin-bottom:6px;">TILESET  ·  textured rendering ' + (tilesetEnabled ? "ACTIVE" : "OFF (clear tileset URL = vertex-color squares)") + '</div>' +
      '<div style="display:grid; grid-template-columns: 2fr 1fr 1fr; gap:6px 12px;">' +
        '<div><div class="lvl-label">TILESET (asset URL)</div><input class="lvl-x-in lvl-tileset-in" data-idx="' + idx + '" data-field="tileset" type="text" placeholder="asset:demo-tileset" value="' + escapeAttr(layer.tileset || "") + '" /></div>' +
        '<div><div class="lvl-label">FRAMES-X</div><input class="lvl-x-in lvl-tileset-shape-in" data-idx="' + idx + '" data-field="tilesetFramesX" type="number" step="1" min="1" value="' + (layer.tilesetFramesX ?? 4) + '" /></div>' +
        '<div><div class="lvl-label">FRAMES-Y</div><input class="lvl-x-in lvl-tileset-shape-in" data-idx="' + idx + '" data-field="tilesetFramesY" type="number" step="1" min="1" value="' + (layer.tilesetFramesY ?? 2) + '" /></div>' +
      '</div>' +
    '</div>' +
    '<div id="lvl-painter-' + idx + '" style="margin-top:8px;">' +
      '<div style="display:flex; align-items:flex-start; gap:14px; flex-wrap:wrap;">' +
        '<div style="flex:0 0 auto;">' +
          '<div class="lvl-label">PALETTE  ·  click to pick brush  ·  green = active</div>' +
          '<canvas id="lvl-pal-' + idx + '" style="display:block; image-rendering:pixelated; cursor:pointer; background:#0e1218; border:1px solid var(--instr-rule); border-radius:2px;"></canvas>' +
          '<div id="lvl-brush-' + idx + '" style="margin-top:4px; font-family:var(--font-mono); font-size:9.5px; color:var(--text-3);">brush: —</div>' +
        '</div>' +
        '<div style="flex:1 1 auto; min-width:240px;">' +
          '<div class="lvl-label">CANVAS  ·  click/drag = paint  ·  right-click/drag = erase  ·  ' + cols + ' × ' + rows + '</div>' +
          '<div style="overflow:auto; max-width:100%; max-height:280px; background:#101820; border:1px solid var(--instr-rule); border-radius:2px;">' +
            '<canvas id="lvl-paint-' + idx + '" style="display:block; image-rendering:pixelated; cursor:crosshair;"></canvas>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<details style="margin-top:8px;">' +
      '<summary style="cursor:pointer; font-family:var(--font-mono); font-size:9.5px; color:var(--text-3); letter-spacing:0.05em;">RAW  ·  tileMap JSON + tileData (advanced)</summary>' +
      '<div style="margin-top:6px;">' +
        '<div class="lvl-label">TILE MAP  ·  JSON: char -> tile index (painter writes here; edit to fine-tune)</div>' +
        '<input class="lvl-x-in lvl-tilemap-in" data-idx="' + idx + '" data-field="tileMap" type="text" placeholder=\'{"1":0,"2":1,"3":2}\' value="' + escapeAttr(tileMapStr) + '" style="font-family:ui-monospace,monospace;" />' +
      '</div>' +
      '<div style="margin-top:6px;">' +
        '<div class="lvl-label">TILE DATA  ·  ' + cols + ' × ' + rows + '  (painter writes here; edit to bulk-paste or resize)</div>' +
        '<textarea class="lvl-x-in lvl-tiledata-in" data-idx="' + idx + '" data-field="tileData" spellcheck="false" wrap="off" style="width:100%; height:140px; padding:4px 6px; background:var(--bg-2); color:var(--text-1); border:1px solid var(--instr-rule); border-radius:2px; font-family:ui-monospace, monospace; font-size:10px; resize:vertical; white-space:pre;">' + escapeText(data) + '</textarea>' +
      '</div>' +
    '</details>' +
  '</div>';
}

function _lvlRenderScatterFields(layer, idx) {
  return '<div style="margin-top:6px;">' +
    '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 12px;">' +
      '<div><div class="lvl-label">TEXTURE</div><input class="lvl-x-in lvl-scatter-tex-in" data-idx="' + idx + '" data-field="texture" type="text"   value="' + escapeAttr(layer.texture || "") + '" /></div>' +
      '<div><div class="lvl-label">SCALE</div><input class="lvl-x-in lvl-scatter-cfg-in"   data-idx="' + idx + '" data-field="scale"   type="number" step="0.05" value="' + (layer.scale ?? 1) + '" /></div>' +
      '<div><div class="lvl-label">ANCHOR-X</div><input class="lvl-x-in lvl-scatter-cfg-in" data-idx="' + idx + '" data-field="anchorX" type="number" step="0.1" value="' + (layer.anchorX ?? 0.5) + '" /></div>' +
      '<div><div class="lvl-label">ANCHOR-Y (0=bottom-pin)</div><input class="lvl-x-in lvl-scatter-cfg-in" data-idx="' + idx + '" data-field="anchorY" type="number" step="0.1" value="' + (layer.anchorY ?? 0) + '" /></div>' +
      '<div><div class="lvl-label">FILTER</div>' +
        '<select class="lvl-x-in" data-idx="' + idx + '" data-field="filterMode">' +
          '<option value="nearest"' + (layer.filterMode !== "linear" ? " selected" : "") + '>nearest</option>' +
          '<option value="linear"'  + (layer.filterMode === "linear" ? " selected" : "") + '>linear</option>' +
        '</select></div>' +
      '<div><div class="lvl-label">FRAME</div><input class="lvl-x-in lvl-scatter-cfg-in" data-idx="' + idx + '" data-field="frame" type="number" step="1" value="' + (layer.frame ?? 0) + '" /></div>' +
    '</div>' +
    // Phase 3: world-space placement canvas. Sprite icons drawn at
    // each (x,y); click empty space to add, drag instance to move,
    // right-click to delete. Auto-fits bounds to existing instances.
    '<div id="lvl-scatter-mount-' + idx + '" style="margin-top:8px;">' +
      '<div class="lvl-label">CANVAS  ·  click empty = add sprite  ·  drag = move  ·  right-click = delete  ·  <span id="lvl-scatter-status-' + idx + '">0 instance(s)</span></div>' +
      '<div style="overflow:hidden; background:#101820; border:1px solid var(--instr-rule); border-radius:2px;">' +
        '<canvas id="lvl-scatter-' + idx + '" width="480" height="260" style="display:block; image-rendering:pixelated; cursor:crosshair; touch-action:none;"></canvas>' +
      '</div>' +
    '</div>' +
    '<details style="margin-top:8px;">' +
      '<summary style="cursor:pointer; font-family:var(--font-mono); font-size:9.5px; color:var(--text-3); letter-spacing:0.05em;">RAW  ·  positions string (advanced)</summary>' +
      '<div style="margin-top:6px;">' +
        '<div class="lvl-label">POSITIONS  ·  format: "x,y[,scale[,frame[,flipX]]]; ..."  (canvas writes here; edit to bulk-paste)</div>' +
        '<textarea class="lvl-x-in lvl-scatter-positions-in" data-idx="' + idx + '" data-field="positions" spellcheck="false" style="width:100%; height:80px; padding:4px 6px; background:var(--bg-2); color:var(--text-1); border:1px solid var(--instr-rule); border-radius:2px; font-family:ui-monospace, monospace; font-size:10px; resize:vertical;">' + escapeText(layer.positions || "") + '</textarea>' +
      '</div>' +
    '</details>' +
  '</div>';
}

function _lvlWireCard(idx) {
  const wrap = document.getElementById("lvl-layers");
  if (!wrap) return;
  const card = wrap.querySelector('.lvl-card[data-idx="' + idx + '"]');
  if (!card) return;
  card.querySelectorAll(".lvl-up").forEach(b => b.addEventListener("click", () => _lvlMoveLayer(idx, -1)));
  card.querySelectorAll(".lvl-down").forEach(b => b.addEventListener("click", () => _lvlMoveLayer(idx, +1)));
  card.querySelectorAll(".lvl-delete").forEach(b => b.addEventListener("click", () => {
    if (confirm("Delete layer '" + (document.getElementById("lvl-card-head-" + idx)?.textContent || idx) + "'?")) _lvlDeleteLayer(idx);
  }));
  // Name field
  card.querySelectorAll(".lvl-name-in").forEach(inp => {
    inp.addEventListener("input", () => _lvlSetField(idx, "name", inp.value));
  });
  // DepthZ field
  card.querySelectorAll(".lvl-z-in").forEach(inp => {
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) _lvlSetField(idx, "depthZ", v);
    });
  });
  // Phase 3.1 auto-resize: on tileSize blur, if value changed since
  // open/last-commit, nearest-neighbor rescale tileData so the world
  // extent (cols*ts × rows*ts) is preserved. tileSize=1 -> 0.1 grows
  // a 17x8 grid to 170x80 etc. Uses change event so we don't fire
  // mid-keystroke ("0.1" passes through "0" first).
  const modalLvl = (function () {
    const m = document.getElementById("level2d-editor-modal");
    return m && m._lvl;
  })();
  if (modalLvl && modalLvl.layers[idx] && modalLvl.layers[idx].type === "tilemap") {
    const tsInp = card.querySelector('input[data-field="tileSize"]');
    if (tsInp) {
      tsInp.addEventListener("change", () => {
        const newSize = parseFloat(tsInp.value);
        if (!Number.isFinite(newSize) || newSize <= 0) return;
        const layerState = (modalLvl.layerState && modalLvl.layerState[idx]) || null;
        const oldSize = layerState ? layerState._prevTileSize : newSize;
        if (Math.abs(newSize / oldSize - 1) < 1e-6) return;
        _lvlResizeTileDataForTileSize(idx, oldSize, newSize);
        if (layerState) layerState._prevTileSize = newSize;
      });
    }
  }
  // Generic field inputs (data-field on each input)
  card.querySelectorAll(".lvl-x-in").forEach(inp => {
    const field = inp.dataset.field;
    if (!field) return;
    const evt = (inp.tagName === "SELECT") ? "change" : "input";
    inp.addEventListener(evt, () => {
      let v = inp.value;
      // tileMap input holds a JSON object stringified; parse before
      // storing so the layer's tileMap stays an object (otherwise the
      // saved patch double-encodes it as a JSON-in-JSON string).
      if (inp.classList.contains("lvl-tilemap-in")) {
        try {
          const parsed = JSON.parse(v);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            v = parsed;
          } else {
            return;  // not an object, don't clobber the layer
          }
        } catch (_) {
          return;  // mid-edit JSON; wait for valid input
        }
      } else if (inp.type === "number") {
        const n = parseFloat(v);
        v = Number.isFinite(n) ? n : 0;
      } else if (v === "true")  v = true;
      else if (v === "false") v = false;
      _lvlSetField(idx, field, v);
      // Painter re-render hooks for tilemap fields that affect the
      // visual canvases. Cheap (~1-2ms each).
      let touchedTilemap = false;
      if (inp.classList.contains("lvl-tileset-in")) {
        _lvlHydrateTilemapPainter(idx);
        touchedTilemap = true;
      } else if (inp.classList.contains("lvl-tileset-shape-in")) {
        _lvlRenderTilesetPalette(idx);
        _lvlRenderTilemapPaint(idx);
        touchedTilemap = true;
      } else if (inp.classList.contains("lvl-tilemap-in")) {
        _lvlRenderTilesetPalette(idx);
        _lvlRenderTilemapPaint(idx);
        touchedTilemap = true;
      } else if (inp.classList.contains("lvl-tiledata-in")) {
        _lvlRenderTilemapPaint(idx);
        touchedTilemap = true;
      } else if (inp.classList.contains("lvl-scatter-tex-in")) {
        _lvlHydrateScatterCanvas(idx);
      } else if (inp.classList.contains("lvl-scatter-cfg-in")) {
        _lvlRenderScatterCanvas(idx);
      } else if (inp.classList.contains("lvl-scatter-positions-in")) {
        _lvlRenderScatterCanvas(idx);
      }
      // Phase 3.2: tilemap changes invalidate scatter backdrops in
      // the same Level2D. Refresh them so the user sees the latest
      // terrain while placing sprites.
      if (touchedTilemap && modalLvl && Array.isArray(modalLvl.layers)) {
        for (let li = 0; li < modalLvl.layers.length; li++) {
          if (modalLvl.layers[li] && modalLvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
        }
      }
    });
  });
}

function _lvlSave() {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const node = state.nodes.find(n => n && n.id === lvl.nodeId);
  if (!node) return;
  pushHistory("level-editor:save:" + lvl.nodeId);
  node.params = node.params || {};
  node.params.layers = JSON.stringify(lvl.layers, null, 2);
  console.log("[level-editor] saved " + lvl.layers.length + " layers to " + lvl.nodeId);
  // Bust Visual.meshBufferCache for any layer-synthetic ID derived
  // from this Level2D, so the next render rebuilds them all.
  if (typeof Visual !== "undefined" && Visual.meshBufferCache) {
    const prefix = lvl.nodeId + ":lyr";
    const toDelete = [];
    for (const key of Visual.meshBufferCache.keys()) {
      if (key.indexOf && key.indexOf(prefix) === 0) toDelete.push(key);
    }
    for (const k of toDelete) {
      try {
        const c = Visual.meshBufferCache.get(k);
        if (c) {
          try { c.vertexBuffer && c.vertexBuffer.destroy(); } catch (_) {}
          try { c.indexBuffer  && c.indexBuffer.destroy();  } catch (_) {}
        }
      } catch (_) {}
      Visual.meshBufferCache.delete(k);
    }
    if (toDelete.length) console.log("[level-editor] cleared " + toDelete.length + " synthetic-layer mesh cache entries");
  }
  _lvlClose();
  if (typeof render      === "function") render();
  if (typeof renderProps === "function") renderProps();
}

/* ── Phase 2b: per-tilemap-layer visual painter ──────────────────
 *
 * Two canvases per tilemap layer card:
 *   lvl-pal-IDX   -- the tileset sprite-sheet drawn as a grid.
 *                    Click a tile to pick it as the active brush.
 *                    If the tile isn't yet in tileMap, a free char
 *                    (1..9, a..z, A..Z) is auto-allocated.
 *   lvl-paint-IDX -- the level cells, drawn with the bitmap for any
 *                    char that's in tileMap, vertex-color palette
 *                    for any char that isn't. Click+drag paints
 *                    with active brush; right-click drags erase to '.'.
 *
 * Both canvases live inline in the card (no second modal). The raw
 * tileData textarea + tileMap JSON input are still present in a
 * <details> disclosure for bulk edit / paste.
 *
 * Bitmap loading is async (createImageBitmap from the asset blob);
 * results are cached in _LVL_TILESET_BITMAP_CACHE so re-opening the
 * modal or hydrating multiple layers with the same tileset is fast.
 * ──────────────────────────────────────────────────────────────── */

const _LVL_TILESET_BITMAP_CACHE = new Map();  // url -> Promise<ImageBitmap|null>
const _LVL_TILESET_BITMAP_SYNC  = new Map();  // url -> ImageBitmap|null (after resolve, for sync render paths)

/* Chars to auto-allocate when the user clicks a palette tile that
 * isn't yet bound to any char in tileMap. Skips '.' and ' ' (used
 * as "empty"), and starts at '1' so the default {"1":0,...} pattern
 * stays natural. */
const _LVL_BRUSH_ALLOC_CHARS = "123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function _lvlLoadTilesetBitmap(url) {
  if (!url) return Promise.resolve(null);
  if (_LVL_TILESET_BITMAP_CACHE.has(url)) return _LVL_TILESET_BITMAP_CACHE.get(url);
  const p = (async () => {
    try {
      let bmp = null;
      if (url.indexOf("asset:") === 0) {
        const name = url.substring("asset:".length);
        const rec = (typeof Assets !== "undefined" && Assets.findSpriteByName)
          ? Assets.findSpriteByName(name) : null;
        if (!rec || !rec.blob) {
          _LVL_TILESET_BITMAP_SYNC.set(url, null);
          return null;
        }
        bmp = await createImageBitmap(rec.blob);
      } else {
        const res = await fetch(url);
        if (!res.ok) { _LVL_TILESET_BITMAP_SYNC.set(url, null); return null; }
        const blob = await res.blob();
        bmp = await createImageBitmap(blob);
      }
      _LVL_TILESET_BITMAP_SYNC.set(url, bmp);
      return bmp;
    } catch (e) {
      console.warn("[level-editor] tileset bitmap load failed for " + url + ": " + e.message);
      _LVL_TILESET_BITMAP_SYNC.set(url, null);
      return null;
    }
  })();
  _LVL_TILESET_BITMAP_CACHE.set(url, p);
  return p;
}

/* Sync accessor for render paths that can't await. Returns the
 * ImageBitmap once the loader's Promise has resolved, null before. */
function _lvlGetTilesetBitmapSync(url) {
  if (!url) return null;
  return _LVL_TILESET_BITMAP_SYNC.get(url) || null;
}

/* Phase 3.1 -- nearest-neighbor rescale of a tilemap layer's tileData
 * when its tileSize changes, preserving world extent (cols*ts × rows*ts).
 * Skips the resize if the result would exceed 1024 in either dimension
 * (a hard cap so a typo like ts=0.001 doesn't churn a million cells). */
function _lvlResizeTileDataForTileSize(idx, oldSize, newSize) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer) return;
  if (!Number.isFinite(oldSize) || oldSize <= 0) return;
  if (!Number.isFinite(newSize) || newSize <= 0) return;
  const factor = oldSize / newSize;
  if (Math.abs(factor - 1) < 1e-6) return;
  const lines = (layer.tileData || "").split("\n");
  const oldRows = Math.max(1, lines.length);
  const oldCols = Math.max(1, lines.reduce((m, r) => Math.max(m, r.length), 1));
  const newRows = Math.max(1, Math.round(oldRows * factor));
  const newCols = Math.max(1, Math.round(oldCols * factor));
  const MAX_DIM = 1024;
  if (newRows > MAX_DIM || newCols > MAX_DIM) {
    console.warn("[level-editor] tileSize " + oldSize + " -> " + newSize +
      " would resize " + oldCols + "x" + oldRows + " -> " + newCols + "x" + newRows +
      " (exceeds " + MAX_DIM + " cap); accepting size change without grid resize");
    _lvlRenderTilemapPaint(idx);
    return;
  }
  const newLines = new Array(newRows);
  for (let r = 0; r < newRows; r++) {
    const srcR = Math.min(oldRows - 1, Math.floor(r / factor));
    const srcLine = lines[srcR] || "";
    let outLine = "";
    for (let c = 0; c < newCols; c++) {
      const srcC = Math.min(oldCols - 1, Math.floor(c / factor));
      outLine += srcLine[srcC] || ".";
    }
    newLines[r] = outLine;
  }
  layer.tileData = newLines.join("\n");
  // Reflect into the RAW textarea (if mounted).
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  _lvlRenderTilemapPaint(idx);
  // Phase 3.2 -- if there's a scatter layer in this Level2D the
  // backdrop just got bigger/smaller; re-render those canvases too.
  for (let li = 0; li < lvl.layers.length; li++) {
    if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
  }
  console.log("[level-editor] tileSize " + oldSize + " -> " + newSize +
    ": resized " + oldCols + "x" + oldRows + " -> " + newCols + "x" + newRows +
    " (factor " + factor.toFixed(3) + ")");
}

function _lvlGetLayerPaintState(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return null;
  lvl.paintState = lvl.paintState || {};
  if (!lvl.paintState[idx]) {
    lvl.paintState[idx] = {
      activeTileIdx: 0,
      activeBrush: null,
      bitmap: null,
      tilesetURL: "",
      painting: false,
      eraseMode: false,
      paintCellPx: 14,
      paletteCellPx: 32,
      // Phase 5b -- undo/redo stacks of pre-stroke tileData snapshots.
      // Per-modal-session only; cleared when modal closes.
      undoStack: [],
      redoStack: [],
      // Phase 5b -- Shift+drag rectangle-fill state. While rectMode is
      // true, pointermove updates the rect preview overlay instead of
      // painting; pointerup commits all cells in the rect.
      rectMode: false,
      rectStartCol: 0, rectStartRow: 0,
      rectCurCol: 0,   rectCurRow: 0,
      rectEraseMode: false
    };
  }
  return lvl.paintState[idx];
}

/* Phase 5b -- snapshot the layer's tileData onto the undo stack
 * before mutating. Called once per stroke (pointerdown). The redo
 * stack is cleared because new edits invalidate any pending redo.
 * Cap at 64 snapshots so a long session doesn't grow unbounded. */
function _lvlBeginPaintStroke(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer || layer.type !== "tilemap") return;
  const ps = _lvlGetLayerPaintState(idx);
  ps.undoStack.push(layer.tileData || "");
  if (ps.undoStack.length > 64) ps.undoStack.shift();
  ps.redoStack.length = 0;
  lvl.lastPaintedLayerIdx = idx;
}

function _lvlUndoLastStroke() {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return false;
  const idx = (typeof lvl.lastPaintedLayerIdx === "number") ? lvl.lastPaintedLayerIdx : -1;
  if (idx < 0) return false;
  const layer = lvl.layers[idx];
  const ps = lvl.paintState && lvl.paintState[idx];
  if (!layer || !ps || !ps.undoStack || ps.undoStack.length === 0) return false;
  const prev = ps.undoStack.pop();
  ps.redoStack.push(layer.tileData || "");
  layer.tileData = prev;
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  _lvlRenderTilemapPaint(idx);
  // Repaint any scatter backdrops (terrain changed).
  if (Array.isArray(lvl.layers)) {
    for (let li = 0; li < lvl.layers.length; li++) {
      if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
    }
  }
  return true;
}

function _lvlRedoLastStroke() {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return false;
  const idx = (typeof lvl.lastPaintedLayerIdx === "number") ? lvl.lastPaintedLayerIdx : -1;
  if (idx < 0) return false;
  const layer = lvl.layers[idx];
  const ps = lvl.paintState && lvl.paintState[idx];
  if (!layer || !ps || !ps.redoStack || ps.redoStack.length === 0) return false;
  const next = ps.redoStack.pop();
  ps.undoStack.push(layer.tileData || "");
  if (ps.undoStack.length > 64) ps.undoStack.shift();
  layer.tileData = next;
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  _lvlRenderTilemapPaint(idx);
  if (Array.isArray(lvl.layers)) {
    for (let li = 0; li < lvl.layers.length; li++) {
      if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
    }
  }
  return true;
}

/* Phase 5b -- commit a rect-fill / rect-erase from rectStart to rectCur.
 * Single undo entry (push once before the bulk write, not per-cell). */
function _lvlCommitRectFill(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  if (!layer || !ps || !ps.rectMode) return;
  const c0 = Math.min(ps.rectStartCol, ps.rectCurCol);
  const c1 = Math.max(ps.rectStartCol, ps.rectCurCol);
  const r0 = Math.min(ps.rectStartRow, ps.rectCurRow);
  const r1 = Math.max(ps.rectStartRow, ps.rectCurRow);
  const newCh = ps.rectEraseMode ? "." : (ps.activeBrush || ".");
  const lines = (layer.tileData || "").split("\n");
  // Pre-stroke snapshot (already pushed by pointerdown via
  // _lvlBeginPaintStroke); just mutate.
  let touched = 0;
  for (let r = r0; r <= r1; r++) {
    if (r < 0) continue;
    while (r >= lines.length) lines.push("");
    let line = lines[r] || "";
    if (c1 >= line.length) line = line.padEnd(c1 + 1, ".");
    let mutated = "";
    let prev = 0;
    for (let c = Math.max(0, c0); c <= c1; c++) {
      if (line[c] !== newCh) {
        mutated += line.substring(prev, c) + newCh;
        prev = c + 1;
        touched++;
      }
    }
    mutated += line.substring(prev);
    lines[r] = mutated;
  }
  if (touched === 0) {
    // No-op: revert the snapshot we pushed in pointerdown so undo
    // doesn't accumulate empty entries.
    ps.undoStack.pop();
    return;
  }
  layer.tileData = lines.join("\n");
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  _lvlRenderTilemapPaint(idx);
  for (let li = 0; li < lvl.layers.length; li++) {
    if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
  }
}

function _lvlFreeBrushChar(tileMap) {
  const used = new Set(Object.keys(tileMap || {}));
  for (const c of _LVL_BRUSH_ALLOC_CHARS) {
    if (!used.has(c)) return c;
  }
  return null;
}

async function _lvlHydrateTilemapPainter(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer || layer.type !== "tilemap") return;
  const palCanvas   = document.getElementById("lvl-pal-"   + idx);
  const paintCanvas = document.getElementById("lvl-paint-" + idx);
  if (!palCanvas || !paintCanvas) return;
  const ps = _lvlGetLayerPaintState(idx);
  // No tileset -> draw a placeholder, render paint canvas using the
  // vertex-color fallback only.
  if (!layer.tileset || !layer.tileset.length) {
    ps.bitmap = null;
    ps.tilesetURL = "";
    palCanvas.width = 160;
    palCanvas.height = 40;
    const pctx = palCanvas.getContext("2d");
    pctx.fillStyle = "#1a1f28";
    pctx.fillRect(0, 0, palCanvas.width, palCanvas.height);
    pctx.fillStyle = "#888";
    pctx.font = "10px ui-monospace, monospace";
    pctx.fillText("(no tileset)", 10, 24);
    _lvlRenderTilemapPaint(idx);
    _lvlUpdateBrushReadout(idx);
    return;
  }
  const bmp = await _lvlLoadTilesetBitmap(layer.tileset);
  // Modal may have closed during the await; bail if so.
  if (!document.getElementById("lvl-pal-" + idx)) return;
  if (!bmp) {
    palCanvas.width = 200;
    palCanvas.height = 40;
    const pctx = palCanvas.getContext("2d");
    pctx.fillStyle = "#3a2424";
    pctx.fillRect(0, 0, palCanvas.width, palCanvas.height);
    pctx.fillStyle = "#ff8060";
    pctx.font = "11px ui-monospace, monospace";
    pctx.fillText("tileset load failed", 6, 24);
    return;
  }
  ps.bitmap = bmp;
  ps.tilesetURL = layer.tileset;
  _lvlRenderTilesetPalette(idx);
  _lvlRenderTilemapPaint(idx);
  _lvlUpdateBrushReadout(idx);
}

function _lvlRenderTilesetPalette(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  const canvas = document.getElementById("lvl-pal-" + idx);
  if (!canvas || !ps || !ps.bitmap || !layer) return;
  const framesX = Math.max(1, (layer.tilesetFramesX | 0) || 4);
  const framesY = Math.max(1, (layer.tilesetFramesY | 0) || 2);
  const cell = ps.paletteCellPx;
  const W = framesX * cell;
  const H = framesY * cell;
  if (canvas.width  !== W) canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#0e1218";
  ctx.fillRect(0, 0, W, H);
  const tileW = ps.bitmap.width  / framesX;
  const tileH = ps.bitmap.height / framesY;
  const tileMap = (layer.tileMap && typeof layer.tileMap === "object") ? layer.tileMap : {};
  for (let row = 0; row < framesY; row++) {
    for (let col = 0; col < framesX; col++) {
      const tileIdx = row * framesX + col;
      ctx.drawImage(ps.bitmap,
        col * tileW, row * tileH, tileW, tileH,
        col * cell,  row * cell,  cell,  cell);
      // Label with the char(s) currently mapped to this index.
      const mapped = [];
      for (const k of Object.keys(tileMap)) if ((tileMap[k] | 0) === tileIdx) mapped.push(k);
      if (mapped.length) {
        const text = mapped.join("");
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(col * cell, row * cell + cell - 12, cell, 12);
        ctx.fillStyle = "#cfe9ff";
        ctx.font = "9px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, col * cell + cell / 2, row * cell + cell - 6);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.strokeRect(col * cell + 0.5, row * cell + 0.5, cell - 1, cell - 1);
    }
  }
  // Highlight active tile.
  if (ps.activeTileIdx != null && ps.activeTileIdx >= 0 && ps.activeTileIdx < framesX * framesY) {
    const ar = Math.floor(ps.activeTileIdx / framesX);
    const ac = ps.activeTileIdx % framesX;
    ctx.strokeStyle = "#67ff80";
    ctx.lineWidth = 2;
    ctx.strokeRect(ac * cell + 1, ar * cell + 1, cell - 2, cell - 2);
  }
}

function _lvlRenderTilemapPaint(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  const canvas = document.getElementById("lvl-paint-" + idx);
  if (!canvas || !ps || !layer) return;
  const lines = (layer.tileData || "").split("\n");
  const nRows = Math.max(1, lines.length);
  const nCols = Math.max(1, lines.reduce((m, r) => Math.max(m, r.length), 1));
  const cell = ps.paintCellPx;
  const W = nCols * cell;
  const H = nRows * cell;
  if (canvas.width  !== W) canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#1a2840";
  ctx.fillRect(0, 0, W, H);
  const tileMap = (layer.tileMap && typeof layer.tileMap === "object") ? layer.tileMap : {};
  const framesX = Math.max(1, (layer.tilesetFramesX | 0) || 4);
  const framesY = Math.max(1, (layer.tilesetFramesY | 0) || 2);
  const bmp = ps.bitmap;
  const tileW = bmp ? bmp.width  / framesX : 0;
  const tileH = bmp ? bmp.height / framesY : 0;
  // Color palette for vertex-color fallback (chars not in tileMap).
  const p = {
    color1R: layer.color1R, color1G: layer.color1G, color1B: layer.color1B,
    color2R: layer.color2R, color2G: layer.color2G, color2B: layer.color2B,
    color3R: layer.color3R, color3G: layer.color3G, color3B: layer.color3B,
    color4R: layer.color4R, color4G: layer.color4G, color4B: layer.color4B,
    color5R: layer.color5R, color5G: layer.color5G, color5B: layer.color5B
  };
  for (let r = 0; r < nRows; r++) {
    const line = lines[r] || "";
    for (let c = 0; c < nCols; c++) {
      const ch = line[c] || ".";
      if (ch === "." || ch === " ") continue;
      if (bmp && Object.prototype.hasOwnProperty.call(tileMap, ch)) {
        const tIdx = tileMap[ch] | 0;
        if (tIdx >= 0 && tIdx < framesX * framesY) {
          const trow = Math.floor(tIdx / framesX);
          const tcol = tIdx % framesX;
          ctx.drawImage(bmp,
            tcol * tileW, trow * tileH, tileW, tileH,
            c * cell, r * cell, cell, cell);
          continue;
        }
      }
      ctx.fillStyle = _tmeColorForChar(ch, p);
      ctx.fillRect(c * cell, r * cell, cell, cell);
    }
  }
  // Gridlines.
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = 0; r <= nRows; r++) { ctx.moveTo(0, r * cell + 0.5); ctx.lineTo(W, r * cell + 0.5); }
  for (let c = 0; c <= nCols; c++) { ctx.moveTo(c * cell + 0.5, 0); ctx.lineTo(c * cell + 0.5, H); }
  ctx.stroke();
  // Stronger every-5th for orientation.
  ctx.strokeStyle = "rgba(150,180,210,0.18)";
  ctx.beginPath();
  for (let r = 0; r <= nRows; r += 5) { ctx.moveTo(0, r * cell + 0.5); ctx.lineTo(W, r * cell + 0.5); }
  for (let c = 0; c <= nCols; c += 5) { ctx.moveTo(c * cell + 0.5, 0); ctx.lineTo(c * cell + 0.5, H); }
  ctx.stroke();
  // Phase 5b -- rect-fill preview overlay (active during Shift+drag).
  if (ps.rectMode) {
    const rc0 = Math.min(ps.rectStartCol, ps.rectCurCol);
    const rc1 = Math.max(ps.rectStartCol, ps.rectCurCol);
    const rr0 = Math.min(ps.rectStartRow, ps.rectCurRow);
    const rr1 = Math.max(ps.rectStartRow, ps.rectCurRow);
    ctx.save();
    ctx.fillStyle = ps.rectEraseMode ? "rgba(255,140,80,0.22)" : "rgba(100,255,140,0.22)";
    ctx.fillRect(rc0 * cell, rr0 * cell, (rc1 - rc0 + 1) * cell, (rr1 - rr0 + 1) * cell);
    ctx.strokeStyle = ps.rectEraseMode ? "#ff8c50" : "#67ff80";
    ctx.lineWidth = 2;
    ctx.strokeRect(rc0 * cell + 1, rr0 * cell + 1, (rc1 - rc0 + 1) * cell - 2, (rr1 - rr0 + 1) * cell - 2);
    ctx.restore();
  }
}

/* Phase 3.2 -- draw a tilemap layer into the scatter canvas using
 * the scatter's world->screen projection. Used as a faded backdrop
 * so the user can place scatter sprites onto the visible terrain.
 * Mirrors _buildTilemap2D's world-position math: row 0 at +Y, cells
 * centered on (c-cx)*ts + ox, (cy-r)*ts + oy with ts=tileSize. */
function _lvlDrawTilemapBackdrop(ctx, layer, proj) {
  const lines = (layer.tileData || "").split("\n");
  const rows = lines.length;
  if (rows === 0) return;
  const cols = lines.reduce((m, r) => Math.max(m, r.length), 0);
  if (cols === 0) return;
  const ts = (typeof layer.tileSize === "number" && layer.tileSize > 0) ? layer.tileSize : 1;
  const ox = (typeof layer.originX === "number") ? layer.originX : 0;
  const oy = (typeof layer.originY === "number") ? layer.originY : 0;
  const cx = (cols - 1) * 0.5;
  const cy = (rows - 1) * 0.5;
  let bmp = null, framesX = 1, framesY = 1, tileMap = null;
  if (layer.tileset && layer.tileset.length) {
    bmp = _lvlGetTilesetBitmapSync(layer.tileset);
    framesX = Math.max(1, (layer.tilesetFramesX | 0) || 4);
    framesY = Math.max(1, (layer.tilesetFramesY | 0) || 2);
    if (layer.tileMap && typeof layer.tileMap === "object" && !Array.isArray(layer.tileMap)) {
      tileMap = layer.tileMap;
    } else if (typeof layer.tileMap === "string" && layer.tileMap.length) {
      try { tileMap = JSON.parse(layer.tileMap); } catch (_) { tileMap = null; }
    }
  }
  const palette = {
    color1R: layer.color1R, color1G: layer.color1G, color1B: layer.color1B,
    color2R: layer.color2R, color2G: layer.color2G, color2B: layer.color2B,
    color3R: layer.color3R, color3G: layer.color3G, color3B: layer.color3B,
    color4R: layer.color4R, color4G: layer.color4G, color4B: layer.color4B,
    color5R: layer.color5R, color5G: layer.color5G, color5B: layer.color5B
  };
  const tileW = bmp ? bmp.width  / framesX : 0;
  const tileH = bmp ? bmp.height / framesY : 0;
  for (let r = 0; r < rows; r++) {
    const line = lines[r] || "";
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "." || ch === " ") continue;
      const wx = (c  - cx) * ts + ox;
      const wy = (cy - r ) * ts + oy;
      const wx0 = wx - ts * 0.5, wx1 = wx + ts * 0.5;
      const wy0 = wy - ts * 0.5, wy1 = wy + ts * 0.5;
      const a = proj.wToS(wx0, wy1);
      const b = proj.wToS(wx1, wy0);
      const sx0 = Math.min(a.sx, b.sx);
      const sy0 = Math.min(a.sy, b.sy);
      const ww  = Math.abs(b.sx - a.sx);
      const hh  = Math.abs(b.sy - a.sy);
      // Cull cells fully outside the canvas (cheap; matters when
      // tileSize is tiny and the grid is huge).
      if (sx0 + ww < 0 || sy0 + hh < 0 || sx0 > proj.W || sy0 > proj.H) continue;
      if (bmp && tileMap && Object.prototype.hasOwnProperty.call(tileMap, ch)) {
        const tIdx = tileMap[ch] | 0;
        if (tIdx >= 0 && tIdx < framesX * framesY) {
          const trow = Math.floor(tIdx / framesX);
          const tcol = tIdx % framesX;
          ctx.drawImage(bmp, tcol * tileW, trow * tileH, tileW, tileH, sx0, sy0, ww, hh);
          continue;
        }
      }
      ctx.fillStyle = _tmeColorForChar(ch, palette);
      ctx.fillRect(sx0, sy0, ww, hh);
    }
  }
}

function _lvlUpdateBrushReadout(idx) {
  const ps = _lvlGetLayerPaintState(idx);
  const el = document.getElementById("lvl-brush-" + idx);
  if (!ps || !el) return;
  if (ps.activeBrush) {
    el.textContent = "brush: '" + ps.activeBrush + "' → tile " + ps.activeTileIdx;
    el.style.color = "#67ff80";
  } else {
    el.textContent = "brush: — (click a palette tile)";
    el.style.color = "var(--text-3)";
  }
}

function _lvlPickPaletteTile(idx, tileIdx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  if (!layer || !ps) return;
  ps.activeTileIdx = tileIdx;
  if (!layer.tileMap || typeof layer.tileMap !== "object" || Array.isArray(layer.tileMap)) {
    layer.tileMap = {};
  }
  // Find existing char mapped to this tile, else allocate one.
  let brush = null;
  for (const k of Object.keys(layer.tileMap)) {
    if ((layer.tileMap[k] | 0) === tileIdx) { brush = k; break; }
  }
  if (!brush) {
    brush = _lvlFreeBrushChar(layer.tileMap);
    if (brush) {
      layer.tileMap[brush] = tileIdx;
      // Reflect into the raw tileMap JSON input (if mounted).
      const inp = document.querySelector('.lvl-tilemap-in[data-idx="' + idx + '"]');
      if (inp) inp.value = JSON.stringify(layer.tileMap);
    }
  }
  ps.activeBrush = brush;
  _lvlRenderTilesetPalette(idx);
  _lvlUpdateBrushReadout(idx);
}

function _lvlPaintCell(idx, col, row, eraseMode) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ps = _lvlGetLayerPaintState(idx);
  if (!layer || !ps) return;
  if (col < 0 || row < 0) return;
  const lines = (layer.tileData || "").split("\n");
  if (row >= lines.length) return;
  let line = lines[row];
  if (col >= line.length) line = line.padEnd(col + 1, ".");
  const newCh = eraseMode ? "." : (ps.activeBrush || ".");
  if (line[col] === newCh) return;
  lines[row] = line.substring(0, col) + newCh + line.substring(col + 1);
  layer.tileData = lines.join("\n");
  // Reflect into raw textarea (if mounted in the <details> disclosure).
  const ta = document.querySelector('textarea.lvl-tiledata-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.tileData;
  // Re-render the paint canvas. ~1-2ms for typical sizes; cheap.
  _lvlRenderTilemapPaint(idx);
}

function _lvlWireTilemapPainter(idx) {
  const palCanvas   = document.getElementById("lvl-pal-"   + idx);
  const paintCanvas = document.getElementById("lvl-paint-" + idx);
  if (palCanvas && !palCanvas._lvlWired) {
    palCanvas._lvlWired = true;
    palCanvas.addEventListener("click", (e) => {
      const modal = document.getElementById("level2d-editor-modal");
      const lvl = modal && modal._lvl;
      if (!lvl) return;
      const layer = lvl.layers[idx];
      const ps = _lvlGetLayerPaintState(idx);
      if (!layer || !ps || !ps.bitmap) return;
      const framesX = Math.max(1, (layer.tilesetFramesX | 0) || 4);
      const framesY = Math.max(1, (layer.tilesetFramesY | 0) || 2);
      const cell = ps.paletteCellPx;
      const rect = palCanvas.getBoundingClientRect();
      const c = Math.floor((e.clientX - rect.left) * (palCanvas.width  / rect.width)  / cell);
      const r = Math.floor((e.clientY - rect.top)  * (palCanvas.height / rect.height) / cell);
      if (c < 0 || c >= framesX || r < 0 || r >= framesY) return;
      _lvlPickPaletteTile(idx, r * framesX + c);
    });
  }
  if (paintCanvas && !paintCanvas._lvlWired) {
    paintCanvas._lvlWired = true;
    paintCanvas.addEventListener("contextmenu", e => e.preventDefault());
    const _coords = (e) => {
      const rect = paintCanvas.getBoundingClientRect();
      const ps = _lvlGetLayerPaintState(idx);
      return {
        col: Math.floor((e.clientX - rect.left) * (paintCanvas.width  / rect.width)  / ps.paintCellPx),
        row: Math.floor((e.clientY - rect.top)  * (paintCanvas.height / rect.height) / ps.paintCellPx)
      };
    };
    paintCanvas.addEventListener("pointerdown", e => {
      const ps = _lvlGetLayerPaintState(idx); if (!ps) return;
      e.preventDefault();
      try { paintCanvas.setPointerCapture(e.pointerId); } catch (_) {}
      const { col, row } = _coords(e);
      const erase = (e.button === 2);
      _lvlBeginPaintStroke(idx);
      if (e.shiftKey) {
        // Phase 5b -- start rect-fill / rect-erase. pointermove
        // updates the preview; pointerup commits the bulk write.
        ps.rectMode      = true;
        ps.rectStartCol  = col;   ps.rectStartRow = row;
        ps.rectCurCol    = col;   ps.rectCurRow   = row;
        ps.rectEraseMode = erase;
        ps.painting      = false;
        _lvlRenderTilemapPaint(idx);
      } else {
        ps.rectMode  = false;
        ps.painting  = true;
        ps.eraseMode = erase;
        _lvlPaintCell(idx, col, row, ps.eraseMode);
      }
    });
    paintCanvas.addEventListener("pointermove", e => {
      const ps = _lvlGetLayerPaintState(idx); if (!ps) return;
      const { col, row } = _coords(e);
      if (ps.rectMode) {
        if (col === ps.rectCurCol && row === ps.rectCurRow) return;
        ps.rectCurCol = col;
        ps.rectCurRow = row;
        _lvlRenderTilemapPaint(idx);
        return;
      }
      if (!ps.painting) return;
      _lvlPaintCell(idx, col, row, ps.eraseMode);
    });
    const _endPaint = (e) => {
      const ps = _lvlGetLayerPaintState(idx); if (!ps) return;
      const wasPainting = ps.painting || ps.rectMode;
      if (ps.rectMode) {
        _lvlCommitRectFill(idx);
        ps.rectMode = false;
        ps.rectEraseMode = false;
        _lvlRenderTilemapPaint(idx);
      }
      ps.painting  = false;
      ps.eraseMode = false;
      try { paintCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
      // Phase 5b -- refresh sibling scatter backdrops once at end of
      // stroke (cheap; avoids per-cell re-render during drag).
      const modal = document.getElementById("level2d-editor-modal");
      const lvl = modal && modal._lvl;
      if (wasPainting && lvl && Array.isArray(lvl.layers)) {
        for (let li = 0; li < lvl.layers.length; li++) {
          if (lvl.layers[li] && lvl.layers[li].type === "scatter") _lvlRenderScatterCanvas(li);
        }
      }
    };
    paintCanvas.addEventListener("pointerup", _endPaint);
    paintCanvas.addEventListener("pointercancel", _endPaint);
  }
}

/* ── Phase 3: per-scatter-layer placement canvas ─────────────────
 *
 * World-space canvas inline in each scatter card. The layer's
 * `positions` string is parsed into an array of {x,y,scale?,frame?,
 * flipX?} instances; each instance is drawn at its world position
 * using the layer's texture (or a placeholder if the asset bitmap
 * hasn't loaded).
 *
 * Interactions:
 *   Click empty space (left)        -> add new instance at world pos
 *   Drag instance (left)            -> move; pos snaps to 0.25-unit grid
 *   Click instance (right)          -> delete that instance
 *
 * Bounds auto-fit to existing instances + 4-unit padding, with a
 * minimum extent of 40x18 world units. pxPerWorld scales to fit
 * the fixed 480x260 canvas. No pan/zoom yet -- if levels need
 * coordinates far outside the auto-fit bounds, edit via the RAW
 * disclosure for now.
 * ──────────────────────────────────────────────────────────────── */

function _lvlGetLayerScatterState(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return null;
  lvl.scatterState = lvl.scatterState || {};
  if (!lvl.scatterState[idx]) {
    lvl.scatterState[idx] = {
      bitmap: null,
      bitmapURL: "",
      drag: null,                // single-inst drag (legacy) or selection drag
      hoverIdx: -1,
      // Phase 5b -- marquee selection state.
      selected: new Set(),       // instance indices currently selected
      marquee: null              // {sx0, sy0, sx1, sy1} while shift-drag in flight
    };
  }
  return lvl.scatterState[idx];
}

function _lvlParseScatterInstances(layer) {
  const posStr = (typeof layer.positions === "string") ? layer.positions : "";
  const out = [];
  for (const seg of posStr.split(";")) {
    const parts = seg.split(",").map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length < 2) continue;
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const inst = { x, y };
    if (parts.length >= 3 && Number.isFinite(parseFloat(parts[2]))) inst.scale = parseFloat(parts[2]);
    if (parts.length >= 4 && Number.isFinite(parseFloat(parts[3]))) inst.frame = parseInt(parts[3], 10);
    if (parts.length >= 5 && Number.isFinite(parseFloat(parts[4]))) inst.flipX = (parseFloat(parts[4]) >= 0.5);
    out.push(inst);
  }
  return out;
}

function _lvlSerializeScatterInstances(insts) {
  return insts.map(i => {
    let s = (Math.round(i.x * 1000) / 1000) + "," + (Math.round(i.y * 1000) / 1000);
    if (i.scale != null) s += "," + i.scale;
    if (i.frame != null) s += "," + i.frame;
    if (i.flipX) s += ",1";
    return s;
  }).join(";");
}

/* Compute world->canvas projection. Auto-fits to existing instances
 * + padding; canvas size is fixed at 480x260 css px (= native px,
 * since we don't apply DPR scaling for the editor canvases). */
function _lvlScatterProjection(layer, insts, canvas) {
  const W = canvas.width, H = canvas.height;
  // Phase 3.2 -- also fold tilemap-layer extents into the auto-fit
  // bounds so the canvas frames the actual world even when this
  // scatter layer has zero instances yet. Looks at sibling layers
  // on the same Level2D via the open modal's working copy.
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  const sibTilemaps = (lvl && Array.isArray(lvl.layers))
    ? lvl.layers.filter(l => l && l.type === "tilemap" && (l.tileData || "").length > 0)
    : [];
  const haveAnchors = insts.length > 0 || sibTilemaps.length > 0;
  let minX = -20, maxX = 20, minY = -4, maxY = 6;
  if (haveAnchors) {
    minX =  Infinity; maxX = -Infinity;
    minY =  Infinity; maxY = -Infinity;
    const defScale = (typeof layer.scale === "number" && layer.scale > 0) ? layer.scale : 1;
    for (const i of insts) {
      const s = (i.scale != null) ? i.scale : defScale;
      minX = Math.min(minX, i.x - s); maxX = Math.max(maxX, i.x + s);
      minY = Math.min(minY, i.y);     maxY = Math.max(maxY, i.y + s);
    }
    for (const tm of sibTilemaps) {
      const lines = (tm.tileData || "").split("\n");
      const tRows = lines.length;
      const tCols = lines.reduce((m, r) => Math.max(m, r.length), 0);
      const ts = (typeof tm.tileSize === "number" && tm.tileSize > 0) ? tm.tileSize : 1;
      const ox = (typeof tm.originX === "number") ? tm.originX : 0;
      const oy = (typeof tm.originY === "number") ? tm.originY : 0;
      const halfW = tCols * ts * 0.5;
      const halfH = tRows * ts * 0.5;
      minX = Math.min(minX, ox - halfW); maxX = Math.max(maxX, ox + halfW);
      minY = Math.min(minY, oy - halfH); maxY = Math.max(maxY, oy + halfH);
    }
    const pad = 4;
    minX -= pad; maxX += pad;
    minY -= pad; maxY += pad;
  }
  // Enforce minimum extent so a single instance doesn't render
  // huge / a sparse map keeps the world axes visible.
  const minWorldW = 40, minWorldH = 18;
  const cw = maxX - minX, ch = maxY - minY;
  if (cw < minWorldW) {
    const c = (minX + maxX) * 0.5;
    minX = c - minWorldW / 2; maxX = c + minWorldW / 2;
  }
  if (ch < minWorldH) {
    const c = (minY + maxY) * 0.5;
    minY = c - minWorldH / 2; maxY = c + minWorldH / 2;
  }
  // Fit isotropic pxPerWorld so circles stay circles.
  const pxPerWorld = Math.min(W / (maxX - minX), H / (maxY - minY));
  // Center within canvas with leftover margin.
  const usedW = (maxX - minX) * pxPerWorld;
  const usedH = (maxY - minY) * pxPerWorld;
  const offsetX = (W - usedW) * 0.5;
  const offsetY = (H - usedH) * 0.5;
  return {
    minX, maxX, minY, maxY, pxPerWorld, offsetX, offsetY, W, H,
    wToS: (wx, wy) => ({
      sx: offsetX + (wx - minX) * pxPerWorld,
      sy: offsetY + (maxY - wy) * pxPerWorld  // flip Y so +y is up
    }),
    sToW: (sx, sy) => ({
      wx: minX + (sx - offsetX) / pxPerWorld,
      wy: maxY - (sy - offsetY) / pxPerWorld
    })
  };
}

async function _lvlHydrateScatterCanvas(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer || layer.type !== "scatter") return;
  const canvas = document.getElementById("lvl-scatter-" + idx);
  if (!canvas) return;
  const ss = _lvlGetLayerScatterState(idx);
  // Load scatter texture + all tilemap backdrop tilesets in parallel.
  // The sync bitmap cache is populated as each promise resolves, so
  // the next _lvlRenderScatterCanvas pass can drawImage them.
  const loads = [];
  if (layer.texture && layer.texture.length) {
    loads.push(_lvlLoadTilesetBitmap(layer.texture).then(bmp => { ss.bitmap = bmp; ss.bitmapURL = layer.texture; }));
  } else {
    ss.bitmap = null;
    ss.bitmapURL = "";
  }
  for (const other of lvl.layers) {
    if (other && other.type === "tilemap" && other.tileset && other.tileset.length) {
      loads.push(_lvlLoadTilesetBitmap(other.tileset));
    }
  }
  await Promise.all(loads);
  if (!document.getElementById("lvl-scatter-" + idx)) return;
  _lvlRenderScatterCanvas(idx);
}

function _lvlRenderScatterCanvas(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const canvas = document.getElementById("lvl-scatter-" + idx);
  const statusEl = document.getElementById("lvl-scatter-status-" + idx);
  if (!canvas || !layer) return;
  const ss = _lvlGetLayerScatterState(idx);
  const insts = _lvlParseScatterInstances(layer);
  if (statusEl) statusEl.textContent = insts.length + " instance(s)";
  const proj = _lvlScatterProjection(layer, insts, canvas);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  // Sky-ish background.
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, "#0e1828"); grad.addColorStop(1, "#1b2a40");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Integer-unit grid.
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const ix0 = Math.ceil(proj.minX), ix1 = Math.floor(proj.maxX);
  const iy0 = Math.ceil(proj.minY), iy1 = Math.floor(proj.maxY);
  for (let i = ix0; i <= ix1; i++) {
    const { sx } = proj.wToS(i, 0);
    ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, canvas.height);
  }
  for (let j = iy0; j <= iy1; j++) {
    const { sy } = proj.wToS(0, j);
    ctx.moveTo(0, sy + 0.5); ctx.lineTo(canvas.width, sy + 0.5);
  }
  ctx.stroke();
  // 5-unit emphasis.
  ctx.strokeStyle = "rgba(150,180,210,0.13)";
  ctx.beginPath();
  for (let i = Math.ceil(proj.minX / 5) * 5; i <= proj.maxX; i += 5) {
    const { sx } = proj.wToS(i, 0);
    ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, canvas.height);
  }
  for (let j = Math.ceil(proj.minY / 5) * 5; j <= proj.maxY; j += 5) {
    const { sy } = proj.wToS(0, j);
    ctx.moveTo(0, sy + 0.5); ctx.lineTo(canvas.width, sy + 0.5);
  }
  ctx.stroke();
  // World axes (x=0 / y=0) strongly.
  ctx.strokeStyle = "rgba(180,210,240,0.32)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (proj.minX <= 0 && proj.maxX >= 0) {
    const { sx } = proj.wToS(0, 0);
    ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, canvas.height);
  }
  if (proj.minY <= 0 && proj.maxY >= 0) {
    const { sy } = proj.wToS(0, 0);
    ctx.moveTo(0, sy + 0.5); ctx.lineTo(canvas.width, sy + 0.5);
  }
  ctx.stroke();
  // Phase 3.2 -- tilemap backdrop. Faded so scatter sprites read
  // clearly on top. Drawn in layer order (matches in-game depth
  // sort, roughly) so parallax-style stacks make sense visually.
  ctx.save();
  ctx.globalAlpha = 0.55;
  for (let li = 0; li < lvl.layers.length; li++) {
    const other = lvl.layers[li];
    if (other && other.type === "tilemap") {
      _lvlDrawTilemapBackdrop(ctx, other, proj);
    }
  }
  ctx.restore();
  // Each instance.
  const defScale = (typeof layer.scale === "number" && layer.scale > 0) ? layer.scale : 1;
  const defAx    = (typeof layer.anchorX === "number") ? layer.anchorX : 0.5;
  const defAy    = (typeof layer.anchorY === "number") ? layer.anchorY : 0;
  const defFrame = (typeof layer.frame === "number") ? Math.floor(layer.frame) : 0;
  const framesX  = Math.max(1, (typeof layer.framesX === "number") ? Math.floor(layer.framesX) : 1);
  const framesY  = Math.max(1, (typeof layer.framesY === "number") ? Math.floor(layer.framesY) : 1);
  const bmp = ss.bitmap;
  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i];
    const scale = (inst.scale != null) ? inst.scale : defScale;
    const frame = (inst.frame != null) ? inst.frame : defFrame;
    const flipX = !!inst.flipX;
    // World-space quad rect.
    const wx0 = inst.x - scale * defAx;
    const wx1 = wx0 + scale;
    const wy0 = inst.y - scale * defAy;  // anchorY=0 -> wy0 = inst.y (bottom)
    const wy1 = wy0 + scale;
    const a = proj.wToS(wx0, wy1);
    const b = proj.wToS(wx1, wy0);
    const sx0 = Math.min(a.sx, b.sx);
    const sy0 = Math.min(a.sy, b.sy);
    const ww  = Math.abs(b.sx - a.sx);
    const hh  = Math.abs(b.sy - a.sy);
    if (bmp) {
      // Pick frame sub-rect.
      const fcol = frame % framesX;
      const frow = Math.floor(frame / framesX) % framesY;
      const tileW = bmp.width  / framesX;
      const tileH = bmp.height / framesY;
      if (flipX) {
        ctx.save();
        ctx.translate(sx0 + ww, sy0);
        ctx.scale(-1, 1);
        ctx.drawImage(bmp, fcol * tileW, frow * tileH, tileW, tileH, 0, 0, ww, hh);
        ctx.restore();
      } else {
        ctx.drawImage(bmp, fcol * tileW, frow * tileH, tileW, tileH, sx0, sy0, ww, hh);
      }
    } else {
      // Placeholder when bitmap not loaded.
      ctx.fillStyle = "rgba(180,140,90,0.55)";
      ctx.fillRect(sx0, sy0, ww, hh);
      ctx.strokeStyle = "rgba(220,180,120,0.9)";
      ctx.strokeRect(sx0 + 0.5, sy0 + 0.5, ww - 1, hh - 1);
    }
    // Phase 5b -- selection / hover / drag ring. Selected = blue
    // (persistent), hover/drag = green.
    const isSelected = ss.selected && ss.selected.has(i);
    const isHoverOrDrag = (ss.hoverIdx === i) || (ss.drag && ss.drag.instIdx === i);
    if (isSelected) {
      ctx.strokeStyle = "#67c8ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx0 - 0.5, sy0 - 0.5, ww + 1, hh + 1);
    }
    if (isHoverOrDrag) {
      ctx.strokeStyle = "#67ff80";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx0 - 0.5, sy0 - 0.5, ww + 1, hh + 1);
      const label = "(" + (Math.round(inst.x * 100) / 100) + ", " + (Math.round(inst.y * 100) / 100) + ")";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textBaseline = "bottom";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(sx0, sy0 - 12, tw + 6, 12);
      ctx.fillStyle = "#67ff80";
      ctx.fillText(label, sx0 + 3, sy0 - 2);
      ctx.textBaseline = "alphabetic";
    }
  }
  // Phase 5b -- marquee selection overlay.
  if (ss.marquee) {
    const m = ss.marquee;
    const mx0 = Math.min(m.sx0, m.sx1), mx1 = Math.max(m.sx0, m.sx1);
    const my0 = Math.min(m.sy0, m.sy1), my1 = Math.max(m.sy0, m.sy1);
    ctx.save();
    ctx.fillStyle = "rgba(100,200,255,0.13)";
    ctx.fillRect(mx0, my0, mx1 - mx0, my1 - my0);
    ctx.strokeStyle = "#67c8ff";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(mx0 + 0.5, my0 + 0.5, mx1 - mx0 - 1, my1 - my0 - 1);
    ctx.setLineDash([]);
    ctx.restore();
  }
  // Status: instance count + selection count.
  if (statusEl && ss.selected && ss.selected.size > 0) {
    statusEl.textContent = insts.length + " instance(s)  ·  " + ss.selected.size + " selected (Delete to remove)";
  }
}

function _lvlScatterHitTest(idx, sx, sy) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return -1;
  const layer = lvl.layers[idx];
  const canvas = document.getElementById("lvl-scatter-" + idx);
  if (!layer || !canvas) return -1;
  const insts = _lvlParseScatterInstances(layer);
  const proj = _lvlScatterProjection(layer, insts, canvas);
  const defScale = (typeof layer.scale === "number" && layer.scale > 0) ? layer.scale : 1;
  const defAx    = (typeof layer.anchorX === "number") ? layer.anchorX : 0.5;
  const defAy    = (typeof layer.anchorY === "number") ? layer.anchorY : 0;
  // Top-down hit-test (later instances visually overlap earlier ones).
  for (let i = insts.length - 1; i >= 0; i--) {
    const inst = insts[i];
    const scale = (inst.scale != null) ? inst.scale : defScale;
    const wx0 = inst.x - scale * defAx;
    const wx1 = wx0 + scale;
    const wy0 = inst.y - scale * defAy;
    const wy1 = wy0 + scale;
    const a = proj.wToS(wx0, wy1);
    const b = proj.wToS(wx1, wy0);
    const sx0 = Math.min(a.sx, b.sx), sy0 = Math.min(a.sy, b.sy);
    const sx1 = Math.max(a.sx, b.sx), sy1 = Math.max(a.sy, b.sy);
    if (sx >= sx0 && sx <= sx1 && sy >= sy0 && sy <= sy1) return i;
  }
  return -1;
}

function _lvlScatterCommit(idx, insts) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  if (!layer) return;
  layer.positions = _lvlSerializeScatterInstances(insts);
  // Reflect into RAW textarea (if mounted).
  const ta = document.querySelector('textarea.lvl-scatter-positions-in[data-idx="' + idx + '"]');
  if (ta) ta.value = layer.positions;
  _lvlRenderScatterCanvas(idx);
}

function _lvlScatterCanvasCoords(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  return {
    sx: (evt.clientX - rect.left) * (canvas.width  / rect.width),
    sy: (evt.clientY - rect.top)  * (canvas.height / rect.height)
  };
}

function _lvlScatterSnap(v) {
  // 0.25-unit grid -- fine enough to place sprites tightly but
  // coarse enough that "the same y" reads as obviously aligned.
  return Math.round(v * 4) / 4;
}

/* Phase 5b -- delete every currently-selected scatter instance.
 * Called from the modal-scoped Delete keydown handler. */
function _lvlScatterDeleteSelection(idx) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return;
  const layer = lvl.layers[idx];
  const ss = lvl.scatterState && lvl.scatterState[idx];
  if (!layer || !ss || !ss.selected || ss.selected.size === 0) return;
  const insts = _lvlParseScatterInstances(layer);
  const remaining = insts.filter((_, i) => !ss.selected.has(i));
  ss.selected.clear();
  _lvlScatterCommit(idx, remaining);
}

/* Phase 5b -- pick all instances whose visible quad intersects a
 * screen-space rect. Used by the marquee on pointerup. */
function _lvlScatterPickInRect(idx, sx0, sy0, sx1, sy1) {
  const modal = document.getElementById("level2d-editor-modal");
  const lvl = modal && modal._lvl;
  if (!lvl) return new Set();
  const layer = lvl.layers[idx];
  const canvas = document.getElementById("lvl-scatter-" + idx);
  if (!layer || !canvas) return new Set();
  const insts = _lvlParseScatterInstances(layer);
  const proj = _lvlScatterProjection(layer, insts, canvas);
  const defScale = (typeof layer.scale === "number" && layer.scale > 0) ? layer.scale : 1;
  const defAx    = (typeof layer.anchorX === "number") ? layer.anchorX : 0.5;
  const defAy    = (typeof layer.anchorY === "number") ? layer.anchorY : 0;
  const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
  const mx0 = lo(sx0, sx1), mx1 = hi(sx0, sx1);
  const my0 = lo(sy0, sy1), my1 = hi(sy0, sy1);
  const out = new Set();
  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i];
    const scale = (inst.scale != null) ? inst.scale : defScale;
    const wx0 = inst.x - scale * defAx;
    const wx1 = wx0 + scale;
    const wy0 = inst.y - scale * defAy;
    const wy1 = wy0 + scale;
    const a = proj.wToS(wx0, wy1);
    const b = proj.wToS(wx1, wy0);
    const ix0 = lo(a.sx, b.sx), iy0 = lo(a.sy, b.sy);
    const ix1 = hi(a.sx, b.sx), iy1 = hi(a.sy, b.sy);
    // AABB overlap test.
    if (ix1 < mx0 || ix0 > mx1 || iy1 < my0 || iy0 > my1) continue;
    out.add(i);
  }
  return out;
}

function _lvlWireScatterCanvas(idx) {
  const canvas = document.getElementById("lvl-scatter-" + idx);
  if (!canvas || canvas._lvlWired) return;
  canvas._lvlWired = true;
  canvas.addEventListener("contextmenu", e => e.preventDefault());
  canvas.addEventListener("pointerdown", e => {
    const modal = document.getElementById("level2d-editor-modal");
    const lvl = modal && modal._lvl;
    if (!lvl) return;
    const layer = lvl.layers[idx];
    if (!layer) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const { sx, sy } = _lvlScatterCanvasCoords(canvas, e);
    const hit = _lvlScatterHitTest(idx, sx, sy);
    const insts = _lvlParseScatterInstances(layer);
    const ss = _lvlGetLayerScatterState(idx);

    // Right-click: delete the hit instance (selection too if hit is selected).
    if (e.button === 2) {
      if (hit >= 0) {
        if (ss.selected.has(hit) && ss.selected.size > 0) {
          _lvlScatterDeleteSelection(idx);
        } else {
          insts.splice(hit, 1);
          ss.selected.clear();
          _lvlScatterCommit(idx, insts);
        }
      }
      return;
    }

    // Shift+drag on empty (or on instance) -> start marquee selection.
    // Shift+click on an instance toggles its selected state.
    if (e.shiftKey) {
      if (hit >= 0) {
        if (ss.selected.has(hit)) ss.selected.delete(hit);
        else                       ss.selected.add(hit);
        _lvlRenderScatterCanvas(idx);
        return;
      }
      ss.marquee = { sx0: sx, sy0: sy, sx1: sx, sy1: sy, pointerId: e.pointerId };
      _lvlRenderScatterCanvas(idx);
      return;
    }

    if (hit >= 0) {
      // If hit is part of the existing selection, drag the WHOLE
      // selection. Otherwise clear the selection and drag just this.
      const proj = _lvlScatterProjection(layer, insts, canvas);
      const handlePt = proj.wToS(insts[hit].x, insts[hit].y);
      const groupDrag = ss.selected.has(hit) && ss.selected.size > 1;
      if (!ss.selected.has(hit)) ss.selected.clear();
      ss.drag = {
        instIdx: hit,
        pointerId: e.pointerId,
        offsetSX: sx - handlePt.sx,
        offsetSY: sy - handlePt.sy,
        groupDrag,
        // Snapshot original positions for the group so relative
        // offsets stay intact as the cursor moves.
        anchorX: insts[hit].x,
        anchorY: insts[hit].y,
        groupOrigPos: groupDrag
          ? Array.from(ss.selected).map(i => ({ i, x: insts[i].x, y: insts[i].y }))
          : null
      };
      ss.hoverIdx = hit;
      _lvlRenderScatterCanvas(idx);
    } else {
      // Click empty space (no Shift): clear selection + add new instance.
      ss.selected.clear();
      const proj = _lvlScatterProjection(layer, insts, canvas);
      const w = proj.sToW(sx, sy);
      insts.push({ x: _lvlScatterSnap(w.wx), y: _lvlScatterSnap(w.wy) });
      _lvlScatterCommit(idx, insts);
    }
  });
  canvas.addEventListener("pointermove", e => {
    const modal = document.getElementById("level2d-editor-modal");
    const lvl = modal && modal._lvl;
    if (!lvl) return;
    const layer = lvl.layers[idx];
    if (!layer) return;
    const ss = _lvlGetLayerScatterState(idx);
    const { sx, sy } = _lvlScatterCanvasCoords(canvas, e);
    // Marquee in flight: just update the rect; pick on pointerup.
    if (ss.marquee && ss.marquee.pointerId === e.pointerId) {
      ss.marquee.sx1 = sx;
      ss.marquee.sy1 = sy;
      _lvlRenderScatterCanvas(idx);
      return;
    }
    if (ss.drag && ss.drag.pointerId === e.pointerId) {
      const insts = _lvlParseScatterInstances(layer);
      if (ss.drag.instIdx < 0 || ss.drag.instIdx >= insts.length) {
        ss.drag = null;
        return;
      }
      const proj = _lvlScatterProjection(layer, insts, canvas);
      const w = proj.sToW(sx - ss.drag.offsetSX, sy - ss.drag.offsetSY);
      const newX = _lvlScatterSnap(w.wx);
      const newY = _lvlScatterSnap(w.wy);
      if (ss.drag.groupDrag && ss.drag.groupOrigPos) {
        const dx = newX - ss.drag.anchorX;
        const dy = newY - ss.drag.anchorY;
        for (const o of ss.drag.groupOrigPos) {
          if (o.i >= 0 && o.i < insts.length) {
            insts[o.i].x = _lvlScatterSnap(o.x + dx);
            insts[o.i].y = _lvlScatterSnap(o.y + dy);
          }
        }
      } else {
        insts[ss.drag.instIdx].x = newX;
        insts[ss.drag.instIdx].y = newY;
      }
      _lvlScatterCommit(idx, insts);
    } else {
      const hit = _lvlScatterHitTest(idx, sx, sy);
      if (hit !== ss.hoverIdx) {
        ss.hoverIdx = hit;
        _lvlRenderScatterCanvas(idx);
      }
      canvas.style.cursor = (hit >= 0) ? "grab" : "crosshair";
    }
  });
  const endDrag = e => {
    const modal = document.getElementById("level2d-editor-modal");
    const lvl = modal && modal._lvl;
    if (!lvl) return;
    const ss = _lvlGetLayerScatterState(idx);
    // Marquee finished -> pick instances inside it.
    if (ss.marquee && ss.marquee.pointerId === e.pointerId) {
      const m = ss.marquee;
      // Tiny marquees (single-pixel) -> treat as click, clear selection.
      const minDim = Math.min(Math.abs(m.sx1 - m.sx0), Math.abs(m.sy1 - m.sy0));
      if (minDim >= 3) {
        const picked = _lvlScatterPickInRect(idx, m.sx0, m.sy0, m.sx1, m.sy1);
        // Shift+marquee adds to selection (toggle would be confusing
        // for groups); plain marquee is implied by Shift being held
        // throughout the drag, so always add.
        for (const i of picked) ss.selected.add(i);
      }
      ss.marquee = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      _lvlRenderScatterCanvas(idx);
      return;
    }
    if (ss.drag && ss.drag.pointerId === e.pointerId) {
      ss.drag = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      _lvlRenderScatterCanvas(idx);
    }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    const ss = _lvlGetLayerScatterState(idx);
    if (!ss.drag && !ss.marquee && ss.hoverIdx !== -1) {
      ss.hoverIdx = -1;
      _lvlRenderScatterCanvas(idx);
    }
  });
}

function _lvlInstall() {
  const modal = document.getElementById("level2d-editor-modal");
  if (!modal || modal._lvlWired) return;
  modal._lvlWired = true;
  // Inject a tiny stylesheet for the field labels + inputs so the
  // modal looks consistent without bloating every input's inline style.
  const style = document.createElement("style");
  style.textContent =
    ".lvl-label { font-family:var(--font-mono); font-size:9px; color:var(--text-3); letter-spacing:0.05em; margin-bottom:2px; }" +
    ".lvl-card input[type='text'], .lvl-card input[type='number'], .lvl-card select { width:100%; padding:3px 5px; background:var(--bg-2); color:var(--text-1); border:1px solid var(--instr-rule); border-radius:2px; font-family:var(--font-mono); font-size:10px; }";
  document.head.appendChild(style);
  document.getElementById("lvl-close").addEventListener("click",  _lvlClose);
  document.getElementById("lvl-cancel").addEventListener("click", _lvlClose);
  document.getElementById("lvl-save").addEventListener("click",   _lvlSave);
  document.getElementById("lvl-add-parallax").addEventListener("click", () => _lvlAddLayer("parallax"));
  document.getElementById("lvl-add-tilemap").addEventListener("click",  () => _lvlAddLayer("tilemap"));
  document.getElementById("lvl-add-scatter").addEventListener("click",  () => _lvlAddLayer("scatter"));
  // ESC closes, Ctrl+Z / Ctrl+Shift+Z undo/redo the last paint stroke
  // (only when typing focus is outside a text input -- otherwise the
  // browser's textfield undo wins, which is what users expect).
  document.addEventListener("keydown", (e) => {
    if (modal.style.display === "none") return;
    if (e.key === "Escape") { _lvlClose(); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const ae = document.activeElement;
    const inTextField = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT");
    if (inTextField) return;
    if (e.key === "z" || e.key === "Z") {
      const handled = e.shiftKey ? _lvlRedoLastStroke() : _lvlUndoLastStroke();
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    } else if (e.key === "y" || e.key === "Y") {
      if (_lvlRedoLastStroke()) { e.preventDefault(); e.stopPropagation(); }
    }
    // Delete / Backspace -- remove selected scatter instances.
    if (e.key === "Delete" || e.key === "Backspace") {
      // Phase 5b -- scatter rect-select deletion lives on the canvas;
      // dispatch here so any scatter layer with a non-empty selection
      // gets cleared.
      const lvl = modal._lvl;
      if (lvl && Array.isArray(lvl.layers) && lvl.scatterState) {
        for (let li = 0; li < lvl.layers.length; li++) {
          const ss = lvl.scatterState[li];
          if (ss && ss.selected && ss.selected.size > 0) {
            _lvlScatterDeleteSelection(li);
            e.preventDefault(); e.stopPropagation();
            return;
          }
        }
      }
    }
  });
  // Backdrop click closes (only when click was on the backdrop itself)
  modal.addEventListener("click", (e) => {
    if (e.target === modal) _lvlClose();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", _lvlInstall);
}

/* Draw the result blob into the preview canvas, sized to the chosen
 * width/height. Empty placeholder hidden when bitmap is present. */
async function _ssRedrawPreview(blob) {
  const canvas = document.getElementById("ss-canvas");
  const empty = document.getElementById("ss-empty");
  if (!canvas) return;
  const w = parseInt(document.getElementById("ss-width").value, 10) || 32;
  const h = parseInt(document.getElementById("ss-height").value, 10) || 32;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  if (!blob) {
    if (empty) empty.style.display = "block";
    document.getElementById("ss-save").disabled = true;
    return;
  }
  if (empty) empty.style.display = "none";
  try {
    const bmp = await createImageBitmap(blob);
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) try { bmp.close(); } catch (_) {}
    document.getElementById("ss-save").disabled = false;
    // Stash the blob on the canvas DOM node so Save can read it.
    canvas._ssBlob = blob;
  } catch (e) {
    _ssStatus("Preview failed: " + (e.message || e), "err");
  }
}

function _ssStatus(msg, kind) {
  const el = document.getElementById("ss-status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === "err" ? "#ff8060"
                 : kind === "ok"  ? "#80ff80"
                 : kind === "thinking" ? "var(--phosphor)"
                 : "var(--text-3)";
}

/* Generation progress poll. Drives the thin bar under the modal head
 * and updates the status line with step / elapsed / ETA while the
 * compile-server worker is running a diffusion. Returns a cancel fn
 * the caller invokes on success/failure to tear it down.
 *
 * Poll cadence: Chrome's Local Network Access (LNA) gate flags every
 * file:// → 127.0.0.1 request as a CSRF concern; a tight poll racks
 * up hundreds of DevTools issues per minute. We poll at 1.2 s, skip
 * when the tab is hidden, and delay the first poll 1.2 s to skip
 * the warm-up window when nothing has been emitted yet. (Switching
 * to SSE / WebSocket would drop this to 1 connection per gen but is
 * a bigger change -- file an issue if the slow poll feels laggy.) */
const _SS_POLL_INTERVAL_MS = 1200;
const _SS_POLL_FIRST_DELAY_MS = 1200;
function _ssStartProgressPoll(serverBase, label) {
  const wrap = document.getElementById("ss-progress-wrap");
  const bar  = document.getElementById("ss-progress-bar");
  if (!wrap || !bar) return () => {};
  wrap.style.display = "block";
  bar.style.width = "0%";
  bar.style.background = "var(--phosphor)";
  const t0 = performance.now();
  const url = serverBase.replace(/\/+$/, "") + "/sprite-gen/progress";
  let cancelled = false;
  let lastStep = 0;
  let stalledSince = t0;
  async function poll() {
    if (cancelled) return;
    // Skip the fetch when the tab is hidden -- the user can't see the
    // bar anyway, and these add up to ~1 LNA flag per second otherwise.
    if (document.hidden) {
      setTimeout(poll, _SS_POLL_INTERVAL_MS);
      return;
    }
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        const browserElapsed = Math.round(performance.now() - t0);
        const total = Math.max(1, j.total | 0);
        const step  = Math.max(0, Math.min(total, j.step | 0));
        // Bar fills proportional to steps. Before the first callback
        // (warm-up / LoRA swap) we creep to 8% so the user sees motion.
        let pct;
        if (step === 0) {
          pct = Math.min(8, browserElapsed / 200);
        } else {
          pct = 8 + (92 * step) / total;
        }
        bar.style.width = pct.toFixed(1) + "%";
        // ETA: extrapolate from elapsed-per-step. Reasonable once step ≥ 2.
        let etaTxt = "";
        if (step >= 2 && j.elapsedMs > 0) {
          const perStep = j.elapsedMs / step;
          const remainMs = perStep * (total - step);
          etaTxt = " · ~" + (remainMs / 1000).toFixed(1) + "s left";
        }
        // Detect stalls -- if step doesn't move for >12s after step 1,
        // turn the bar amber so the user knows something's off (model
        // loading / OS swapping / etc).
        if (step !== lastStep) {
          stalledSince = performance.now();
          lastStep = step;
        }
        if (step >= 1 && performance.now() - stalledSince > 12000) {
          bar.style.background = "#e0b060";
        }
        const elapsedSec = (browserElapsed / 1000).toFixed(1);
        _ssStatus(
          (label || "rendering") +
          " · step " + step + "/" + total +
          " · " + elapsedSec + "s" + etaTxt,
          "thinking"
        );
      }
    } catch (_) {
      // Polling failures are non-fatal -- the bar just freezes briefly.
    }
    if (!cancelled) setTimeout(poll, _SS_POLL_INTERVAL_MS);
  }
  // Defer the first poll past the worker's typical "no-op warm-up"
  // window so the very first frame doesn't show an empty `step 0/M`.
  setTimeout(poll, _SS_POLL_FIRST_DELAY_MS);
  return () => {
    cancelled = true;
    wrap.style.display = "none";
    bar.style.width = "0%";
    bar.style.background = "var(--phosphor)";
  };
}

/* Wire the Sprite Studio: modal close, generate, save. Entry point is
 * the SpriteCreator node's ⚙ gear handle, which calls _ssOpen(nodeId)
 * directly from the node render code in render(). */
function _ssInstall() {
  const closeBtn = document.getElementById("ss-close");
  if (closeBtn && !closeBtn._ssWired) {
    closeBtn._ssWired = true;
    closeBtn.addEventListener("click", _ssClose);
  }
  const modal = document.getElementById("spritestudio-modal");
  if (modal && !modal._ssWired) {
    modal._ssWired = true;
    modal.addEventListener("click", e => { if (e.target === modal) _ssClose(); });
  }
  const genBtn = document.getElementById("ss-generate");
  if (genBtn && !genBtn._ssWired) {
    genBtn._ssWired = true;
    genBtn.addEventListener("click", async () => {
      const description = document.getElementById("ss-prompt").value.trim();
      if (!description) { _ssStatus("Enter a description first.", "err"); return; }
      const stylePreset = document.getElementById("ss-preset").value;
      const backend     = document.getElementById("ss-backend").value;
      const w = parseInt(document.getElementById("ss-width").value, 10) || 32;
      const h = parseInt(document.getElementById("ss-height").value, 10) || 32;
      const fx = parseInt(document.getElementById("ss-framesX").value, 10) || 1;
      const fy = parseInt(document.getElementById("ss-framesY").value, 10) || 1;
      // Persist the backend choice across opens.
      aiSettings.spriteBackend = backend;
      saveAiSettings();
      genBtn.disabled = true;
      try {
        let blob = null;
        if (backend === "compile-server-sd") {
          // Bundled SD via compile-server (the default for users who
          // ran scripts/install-sd.sh). Uses model defaults set
          // server-side; here we just send prompt + dims + steps.
          const serverBase = (typeof localServerEndpoint === "string" && localServerEndpoint)
            ? localServerEndpoint
            : "http://127.0.0.1:8765";
          const sheetW = w, sheetH = h;
          // Native gen resolution from the QUALITY dropdown. Default
          // 512 (was 1024) since 1024 takes 4-5 min per frame on M4
          // and routinely times out. 512 is "Standard" quality and
          // still downsamples cleanly to any sprite size. User can
          // bump to High / Max if they want sharper detail and have
          // time to wait.
          const qualityEl = document.getElementById("ss-sd-quality");
          const nativeSize = parseInt((qualityEl && qualityEl.value) || aiSettings.sdQuality || "512", 10) || 512;
          aiSettings.sdQuality = String(nativeSize);
          const model = (document.getElementById("ss-sd-model").value)
            || aiSettings.sdModel || "z-image-turbo";
          aiSettings.sdModel = model;
          saveAiSettings();
          const steps = parseInt(document.getElementById("ss-sd-steps").value, 10) || 9;
          const totalFrames = fx * fy;
          // Lock one seed across the whole batch so every frame looks
          // like the same character. Without this, each gen returns a
          // different fox / robot / whatever -- useless for animation.
          const sharedSeed = Math.floor(Math.random() * 1e9);
          if (totalFrames <= 1) {
            // Single-pose, fast path.
            _ssStatus("compile-server SD (" + model + ") rendering " + nativeSize + "×" + nativeSize + "…", "thinking");
            const stopPoll = _ssStartProgressPoll(
              serverBase,
              "SD (" + model + ") " + nativeSize + "×" + nativeSize
            );
            let raw;
            try {
              raw = await _ssCallCompileServerSD(serverBase, model, description, stylePreset, nativeSize, steps, sharedSeed);
            } finally {
              stopPoll();
            }
            _ssStatus("Downsampling to " + sheetW + "×" + sheetH + "…", "thinking");
            blob = await _ssDownsampleBlob(raw, sheetW, sheetH);
            document.getElementById("ss-code").value = "// compile-server SD\n// model: " + model + "\n// prompt: " + description + "\n// seed: " + sharedSeed + "\n// native " + nativeSize + " → sprite " + sheetW + "×" + sheetH;
          } else {
            // Multi-pose batch: N gens with auto pose variants, stitched.
            const poses = _ssBuildPosePrompts(totalFrames);
            const frameBlobs = [];
            const batchT0 = performance.now();
            for (let i = 0; i < totalFrames; i++) {
              const framePrompt = description + (poses[i] ? ", " + poses[i] : "");
              const framelabel = "Frame " + (i + 1) + "/" + totalFrames;
              _ssStatus(framelabel + " (" + (poses[i] || "default") + ")…", "thinking");
              const stopPoll = _ssStartProgressPoll(
                serverBase,
                framelabel + " — SD " + nativeSize + "×" + nativeSize
              );
              let raw;
              try {
                raw = await _ssCallCompileServerSD(serverBase, model, framePrompt, stylePreset, nativeSize, steps, sharedSeed);
              } finally {
                stopPoll();
              }
              const frameBlob = await _ssDownsampleBlob(raw, sheetW, sheetH);
              frameBlobs.push(frameBlob);
            }
            _ssStatus("Stitching " + totalFrames + " frames into " + fx + "×" + fy + " sheet…", "thinking");
            blob = await _ssStitchSheet(frameBlobs, sheetW, sheetH, fx, fy);
            const batchSec = ((performance.now() - batchT0) / 1000).toFixed(1);
            document.getElementById("ss-code").value =
              "// compile-server SD multi-pose batch\n"
              + "// model: " + model + "\n"
              + "// prompt: " + description + "\n"
              + "// seed: " + sharedSeed + " (locked across all frames)\n"
              + "// grid: " + fx + "×" + fy + " = " + totalFrames + " frames\n"
              + "// frame: " + sheetW + "×" + sheetH + "  sheet: " + (sheetW * fx) + "×" + (sheetH * fy) + "\n"
              + "// total time: " + batchSec + "s\n"
              + "// poses:\n//   " + poses.map((p, i) => "[" + i + "] " + (p || "(none)")).join("\n//   ");
          }
        } else if (backend === "local-sd-a1111") {
          // Persist endpoint + sampler settings.
          const endpoint = document.getElementById("ss-sd-endpoint").value.trim() || "http://localhost:7860";
          const steps = parseInt(document.getElementById("ss-sd-steps").value, 10) || 20;
          const sampler = document.getElementById("ss-sd-sampler").value.trim() || "DPM++ 2M Karras";
          aiSettings.sdEndpoint = endpoint;
          aiSettings.sdSteps = steps;
          aiSettings.sdSampler = sampler;
          saveAiSettings();
          // SD native size: power-of-two ≥ max(w*fx, h*fy), capped at 768
          // for M4 perf. Final downsample maps to user's sprite dims.
          const sheetW = w; // for now: single-frame; spritesheets need
          const sheetH = h; // a per-frame loop, deferred to sd-2.
          const nativeSize = Math.min(768, Math.max(256, _ssNextPow2(Math.max(sheetW, sheetH) * 4)));
          _ssStatus("SD rendering at " + nativeSize + "×" + nativeSize + " (steps=" + steps + ")…", "thinking");
          const raw = await _ssCallA1111(endpoint, description, stylePreset, nativeSize, steps, sampler);
          _ssStatus("Downsampling to " + sheetW + "×" + sheetH + "…", "thinking");
          blob = await _ssDownsampleBlob(raw, sheetW, sheetH);
          document.getElementById("ss-code").value = "// SD output from " + endpoint + "\n// prompt: " + description + "\n// style: " + stylePreset + "\n// native " + nativeSize + " → sprite " + sheetW + "×" + sheetH;
        } else {
          // Default: LLM → JS canvas code path (the v1 cheap+free option).
          const provider = PROVIDERS[aiSettings.provider];
          if (!provider) { throw new Error("No LLM provider configured (User DSP → ⚙)."); }
          let key = "";
          if (provider.requiresKey) {
            key = aiSettings.anthropicKey;
            if (!key) { throw new Error("API key required — set in User DSP → ⚙."); }
          }
          _ssStatus("Asking " + aiSettings.provider + "…", "thinking");
          const system = _ssBuildSystemPrompt();
          const user = _ssBuildUserPrompt(description, stylePreset, w, h, fx, fy);
          const reply = await provider.call({
            system, user, key, model: aiSettings.model,
            temperature: 0.4, maxTokens: 4096
          });
          const code = _ssExtractJsFromResponse(reply);
          document.getElementById("ss-code").value = code;
          _ssStatus("Painting…", "thinking");
          blob = await _ssExecutePaintCode(code, w, h, fx, fy);
        }
        await _ssRedrawPreview(blob);
        _ssStatus("Generated (" + Math.round(blob.size / 1024) + " KB). Click Save.", "ok");
      } catch (e) {
        console.error("[sprite-studio] generate failed:", e);
        _ssStatus("Generate failed: " + (e.message || e), "err");
        document.getElementById("ss-save").disabled = true;
      } finally {
        genBtn.disabled = false;
      }
    });
  }
  // Toggle SD config row based on backend selector + persist choice.
  const backendEl = document.getElementById("ss-backend");
  if (backendEl && !backendEl._ssWired) {
    backendEl._ssWired = true;
    const sdConfig = document.getElementById("ss-sd-config");
    const helpEl = document.getElementById("ss-help");
    const updateBackendUI = () => {
      const b = backendEl.value;
      const isA1111 = b === "local-sd-a1111";
      const isCSSD  = b === "compile-server-sd";
      if (sdConfig) sdConfig.style.display = isA1111 ? "block" : "none";
      if (helpEl) {
        if (isCSSD) {
          helpEl.innerHTML = "Calls the local <strong>gamma-compile-server</strong>'s <code>/sprite-gen</code> route. Uses bundled <strong>Z-Image-Turbo</strong> + Pixel Art LoRA. Make sure you ran <code>scripts/install-sd.sh</code> in the compile-server checkout. First gen pays the model-load cost (~30–60s on Apple Silicon); subsequent ones are fast.";
        } else if (isA1111) {
          helpEl.innerHTML = "Calls AUTOMATIC1111 webui at the endpoint above. Make sure it's running with <code>--api</code> (and <code>--cors-allow-origins=*</code> if browser blocks it). Output renders at native size then downsamples to the sprite dims using nearest-neighbor.";
        } else {
          helpEl.innerHTML = "Uses the LLM provider set in <em>User DSP → ⚙</em>. Default: Claude API. Output runs as JS canvas paint code in this page. No corporate-IP references in the prompt.";
        }
      }
    };
    backendEl.addEventListener("change", updateBackendUI);
    backendEl._ssUpdateUI = updateBackendUI;
  }
  const saveBtn = document.getElementById("ss-save");
  if (saveBtn && !saveBtn._ssWired) {
    saveBtn._ssWired = true;
    saveBtn.addEventListener("click", async () => {
      const canvas = document.getElementById("ss-canvas");
      const blob = canvas && canvas._ssBlob;
      if (!blob) { _ssStatus("Nothing to save yet.", "err"); return; }
      const nameRaw = (document.getElementById("ss-name").value || "").trim();
      const name = nameRaw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || ("sprite-" + Date.now().toString(36).slice(-5));
      const w = parseInt(document.getElementById("ss-width").value, 10) || 32;
      const h = parseInt(document.getElementById("ss-height").value, 10) || 32;
      const fx = parseInt(document.getElementById("ss-framesX").value, 10) || 1;
      const fy = parseInt(document.getElementById("ss-framesY").value, 10) || 1;
      const fps = parseFloat(document.getElementById("ss-fps").value) || 8;
      const scale = parseFloat(document.getElementById("ss-scale").value) || 32;
      saveBtn.disabled = true;
      _ssStatus("Saving to asset library…", "thinking");
      try {
        // Wrap the blob in a fake File-like so loadImageFileToSpriteAsset
        // can compute width/height + create the asset record via the
        // existing path. We pre-set framesX/Y/fps/scale via opts so the
        // record carries the user's chosen metadata immediately.
        const fakeFile = new File([blob], name + ".png", { type: "image/png" });
        const rec = await loadImageFileToSpriteAsset(fakeFile, {
          name, framesX: fx, framesY: fy, fps, scale,
          source: "creator"
        });
        if (!rec) throw new Error("asset create returned null");
        // Write back to the source SpriteCreator node (if opened from one)
        // so its defaults reflect the latest generation and downstream
        // nodes wired to `lastAsset` see the new name.
        const modal = document.getElementById("spritestudio-modal");
        const sourceNodeId = modal && modal._ssSourceNodeId;
        if (sourceNodeId) {
          const node = (typeof nodeById === "function") ? nodeById(sourceNodeId) : null;
          if (node && node.params) {
            node.params.prompt   = document.getElementById("ss-prompt").value.trim();
            node.params.style    = document.getElementById("ss-preset").value;
            node.params.width    = w;
            node.params.height   = h;
            node.params.framesX  = fx;
            node.params.framesY  = fy;
            node.params.fps      = fps;
            node.params.scale    = scale;
            node.params.lastAssetName = rec.name;
            if (typeof render === "function") {
              try { render(); } catch (_) {}
            }
          }
        }
        _ssStatus("Saved as '" + rec.name + "'.", "ok");
        // Refresh Assets tab so the new sprite shows up immediately.
        if (typeof brRenderAssets === "function") brRenderAssets();
        // Auto-close after a short delay so the user sees the success msg.
        setTimeout(_ssClose, 700);
      } catch (e) {
        console.error("[sprite-studio] save failed:", e);
        _ssStatus("Save failed: " + (e.message || e), "err");
        saveBtn.disabled = false;
      }
    });
  }
  // Live-update preview canvas size when width/height inputs change
  // (so the user can see the empty canvas at the right aspect before
  // clicking Generate).
  ["ss-width", "ss-height"].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el._ssWired) {
      el._ssWired = true;
      el.addEventListener("change", () => _ssRedrawPreview(null));
    }
  });
  // §sd-polish -- model dropdown persists to aiSettings + re-probes the
  // server so the installed marker stays accurate after a fresh install.
  const sdModelEl = document.getElementById("ss-sd-model");
  if (sdModelEl && !sdModelEl._ssWired) {
    sdModelEl._ssWired = true;
    sdModelEl.addEventListener("change", () => {
      aiSettings.sdModel = sdModelEl.value;
      saveAiSettings();
      _ssRefreshModelStatus();
    });
  }
}
// Install on next tick (DOM is ready by the time this script tag runs).
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _ssInstall);
  } else {
    _ssInstall();
  }
}

/* ── Asset folder creation (asset-folders sprint) ───────────────── */
/* Create a folder asset. function must be one of _ASSET_FUNCTIONS;
 * defaults to 'decoration' (single-slot, lowest friction). Slots are
 * pre-populated empty (each slot value = null) so the editor can
 * render placeholders without checking for missing keys.
 *
 * `slots` arg lets the caller pre-fill assignments (LLM auto-sort uses
 * this). Format: {slotName: spriteAssetId}. Anything not in the
 * function's slot list is dropped (with a warning) so a relabel later
 * doesn't leave orphan keys behind. */
async function createFolderAsset(name, functionKey, opts) {
  opts = opts || {};
  const fdef = _ASSET_FUNCTIONS[functionKey] || _ASSET_FUNCTIONS["decoration"];
  const slotMap = {};
  for (const s of fdef.slots) slotMap[s.name] = null;
  if (opts.slots) {
    for (const k of Object.keys(opts.slots)) {
      if (k in slotMap) slotMap[k] = opts.slots[k];
      else console.warn("[folder] dropping unknown slot '" + k + "' for function " + functionKey);
    }
  }
  const baseName = (typeof name === "string" && name.length)
    ? name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
    : "folder-" + Date.now().toString(36).slice(-5);
  const rec = {
    id: "fold_" + Date.now() + "_" + Math.floor(Math.random() * 1e6),
    assetType: "folder",
    name: baseName,
    functionKey: functionKey || "decoration",
    slots: slotMap,            // slotName → spriteAssetId | null
    notes: opts.notes || "",
    source: opts.source || "manual"
  };
  await Assets.put(rec);
  console.log("[assets] created folder '" + rec.name + "' (" + rec.functionKey + ") id=" + rec.id);
  return rec;
}

/* ── Folder editor modal (asset-folders sprint) ─────────────────── */
/* Edits a single AssetFolder record. Opens via _folderOpen(id);
 * everything writes back to the in-memory map immediately and Persists
 * via Assets.put on field changes. No explicit Save button — every
 * input edit is autosaved. */

function _folderOpen(folderId) {
  const modal = document.getElementById("folder-modal");
  if (!modal) return;
  modal._folderId = folderId;
  modal.style.display = "flex";
  _folderRender();
}
function _folderClose() {
  const modal = document.getElementById("folder-modal");
  if (!modal) return;
  modal.style.display = "none";
  modal._folderId = null;
  // Re-render the Assets tab so the card sub-line (filled/total slots)
  // reflects the latest assignments.
  if (typeof brRenderAssets === "function") brRenderAssets();
}
function _folderStatus(msg, kind) {
  const el = document.getElementById("folder-status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = kind === "err" ? "#ff8060"
                 : kind === "ok"  ? "#80ff80"
                 : kind === "thinking" ? "var(--phosphor)"
                 : "var(--text-3)";
}
function _folderAutoStatus(msg, kind) {
  const el = document.getElementById("folder-autosort-status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = kind === "err" ? "#ff8060"
                 : kind === "ok"  ? "#80ff80"
                 : kind === "thinking" ? "var(--phosphor)"
                 : "var(--text-3)";
}

function _folderRender() {
  const modal = document.getElementById("folder-modal");
  if (!modal || !modal._folderId) return;
  const rec = Assets.get(modal._folderId);
  if (!rec) { _folderStatus("folder not found", "err"); return; }
  const fdef = _ASSET_FUNCTIONS[rec.functionKey] || _ASSET_FUNCTIONS["decoration"];

  // Name
  const nameEl = document.getElementById("folder-name");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = rec.name;

  // Function dropdown (populate options once; preserve selection across renders).
  const funcEl = document.getElementById("folder-function");
  if (funcEl && funcEl.options.length === 0) {
    funcEl.innerHTML = Object.keys(_ASSET_FUNCTIONS).map(k =>
      `<option value="${escapeAttr(k)}">${escapeText(_ASSET_FUNCTIONS[k].label)}</option>`
    ).join("");
  }
  if (funcEl) funcEl.value = rec.functionKey;
  const descEl = document.getElementById("folder-func-desc");
  if (descEl) descEl.textContent = fdef.description;

  // Slot rows
  const slotsEl = document.getElementById("folder-slots");
  if (!slotsEl) return;
  slotsEl.innerHTML = fdef.slots.map(slot => {
    const sid = (rec.slots || {})[slot.name];
    const srec = sid ? _spriteAssets.get(sid) : null;
    let preview;
    if (srec && srec.blob) {
      let url = srec._thumbUrl;
      if (!url) { try { url = URL.createObjectURL(srec.blob); srec._thumbUrl = url; } catch (_) {} }
      preview = `<img src="${escapeAttr(url)}" style="max-width:42px; max-height:42px; image-rendering:pixelated; image-rendering:crisp-edges;"/>`;
    } else if (sid && !srec) {
      preview = `<span style="color:#ff8060; font-size:9.5px;">(deleted)</span>`;
    } else {
      preview = `<span style="color:var(--text-3); font-size:18px; opacity:0.4;">+</span>`;
    }
    return `
      <div class="folder-slot-row" data-slot="${escapeAttr(slot.name)}" style="display:flex; gap:10px; align-items:center; padding:6px 8px; background:var(--bg-1); border:1px solid var(--instr-rule); border-radius:3px;">
        <div class="folder-slot-drop" style="width:50px; height:50px; flex-shrink:0; background:#0a0c10; border:1px dashed rgba(255,255,255,0.15); border-radius:2px; display:flex; align-items:center; justify-content:center;">${preview}</div>
        <div style="flex:1; min-width:0;">
          <div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-1); font-weight:600; display:flex; align-items:center; gap:6px;">
            ${escapeText(slot.name)}
            ${slot.optional ? '<span style="font-weight:400; font-size:8.5px; color:var(--text-3); letter-spacing:0.05em;">OPTIONAL</span>' : ""}
          </div>
          <div style="font-family:var(--font-mono); font-size:9.5px; color:var(--text-3); line-height:1.4; margin-top:1px;">${escapeText(slot.desc)}</div>
          ${srec ? `<div style="font-family:var(--font-mono); font-size:9px; color:#80ff80; margin-top:2px;">→ ${escapeText(srec.name)}</div>` : ""}
        </div>
        ${sid ? `<button class="folder-slot-clear" data-slot="${escapeAttr(slot.name)}" title="Unassign this slot" style="padding:2px 6px; background:var(--bg-1); color:var(--text-3); border:1px solid var(--text-3); border-radius:2px; cursor:pointer; font-family:var(--font-mono); font-size:9.5px;">clear</button>` : ""}
      </div>
    `;
  }).join("");

  // Wire drop targets on slot rows. Accept text/x-gamma-asset-id with
  // type=sprite; refuse anything else.
  slotsEl.querySelectorAll(".folder-slot-row").forEach(row => {
    const slotName = row.dataset.slot;
    row.addEventListener("dragover", e => {
      const types = e.dataTransfer && e.dataTransfer.types;
      if (!types || !types.indexOf) return;
      if (types.indexOf("text/x-gamma-asset-id") < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      row.style.borderColor = "var(--phosphor)";
    });
    row.addEventListener("dragleave", () => { row.style.borderColor = "var(--instr-rule)"; });
    row.addEventListener("drop", async e => {
      row.style.borderColor = "var(--instr-rule)";
      const id = e.dataTransfer.getData("text/x-gamma-asset-id");
      const type = e.dataTransfer.getData("text/x-gamma-asset-type");
      if (!id || (type && type !== "sprite")) return;
      e.preventDefault();
      const fid = modal._folderId;
      const folder = Assets.get(fid);
      if (!folder) return;
      folder.slots[slotName] = id;
      await Assets.put(folder);
      _folderRender();
    });
  });
  slotsEl.querySelectorAll(".folder-slot-clear").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const fid = modal._folderId;
      const folder = Assets.get(fid);
      if (!folder) return;
      folder.slots[btn.dataset.slot] = null;
      await Assets.put(folder);
      _folderRender();
    });
  });
}

/* LLM-driven slot assignment. Sends sprite names + slot descriptions
 * to the configured provider; parses JSON response of the form
 *   {slotName: spriteName, ...}
 * and applies. Only assigns slots that are currently empty (preserves
 * the user's manual picks); set the FOLDER_AUTOSORT_OVERWRITE flag
 * if/when we want a "Re-sort everything" affordance. */
async function _folderAutoSort() {
  const modal = document.getElementById("folder-modal");
  if (!modal || !modal._folderId) return;
  const rec = Assets.get(modal._folderId);
  if (!rec) return;
  const fdef = _ASSET_FUNCTIONS[rec.functionKey] || _ASSET_FUNCTIONS["decoration"];
  const sprites = Assets.list({ type: "sprite" });
  if (sprites.length === 0) {
    _folderAutoStatus("no sprites in the library to sort", "err");
    return;
  }
  const provider = PROVIDERS[aiSettings.provider];
  if (!provider) { _folderAutoStatus("no LLM provider (User DSP → ⚙)", "err"); return; }
  let key = "";
  if (provider.requiresKey) {
    key = aiSettings.anthropicKey;
    if (!key) { _folderAutoStatus("API key required (User DSP → ⚙)", "err"); return; }
  }

  const slotLines = fdef.slots.map(s =>
    "  " + s.name + (s.optional ? " (optional)" : "") + " — " + s.desc
  ).join("\n");
  const spriteNames = sprites.map(s => "  " + s.name).join("\n");

  const system = [
    "You are organizing pixel-art sprite assets for a 2D game.",
    "Given a function and its slots, plus a list of available sprite names,",
    "match each sprite to the slot it best fits. Slot names are fixed;",
    "sprite names are user-provided. Match by name semantics (e.g. a sprite",
    "called 'fox-idle' fits the 'idle' slot).",
    "",
    "OUTPUT RULES:",
    "- Output ONLY a JSON object, no markdown fences, no comments.",
    "- Keys are slot names from the provided list.",
    "- Values are sprite names from the provided list.",
    "- Omit slots that don't have a clear match. Don't invent slot names.",
    "- Don't reuse the same sprite for multiple slots unless it genuinely fits both.",
    "- Sprites that don't fit any slot are ignored."
  ].join("\n");

  const user = [
    "Folder function: " + fdef.label,
    "Function description: " + fdef.description,
    "",
    "Slots:",
    slotLines,
    "",
    "Available sprites (by name):",
    spriteNames,
    "",
    "Return the JSON object now:"
  ].join("\n");

  _folderAutoStatus("asking " + aiSettings.provider + "…", "thinking");
  let reply;
  try {
    reply = await provider.call({ system, user, key, model: aiSettings.model,
      temperature: 0.2, maxTokens: 1024 });
  } catch (e) {
    _folderAutoStatus("LLM call failed: " + (e.message || e), "err");
    return;
  }
  // Extract JSON (strip markdown fences if Claude wrapped it).
  let raw = reply.trim();
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  let map;
  try {
    map = JSON.parse(raw);
  } catch (e) {
    _folderAutoStatus("LLM returned invalid JSON: " + e.message, "err");
    console.warn("[folder-autosort] reply was:", reply);
    return;
  }
  // Apply: for each entry, find a sprite by name (case-insensitive) and
  // assign IF the slot is currently empty. Tracks how many were assigned.
  let n = 0;
  for (const [slotName, spriteName] of Object.entries(map)) {
    if (!(slotName in rec.slots)) continue;            // unknown slot
    if (rec.slots[slotName]) continue;                 // already filled (preserve manual)
    const srec = Assets.findSpriteByName(spriteName);
    if (!srec) continue;
    rec.slots[slotName] = srec.id;
    n++;
  }
  await Assets.put(rec);
  _folderAutoStatus("assigned " + n + " slot" + (n === 1 ? "" : "s"), n > 0 ? "ok" : "err");
  _folderRender();
}

function _folderInstallHandlers() {
  const closeBtn = document.getElementById("folder-close");
  if (closeBtn && !closeBtn._folderWired) {
    closeBtn._folderWired = true;
    closeBtn.addEventListener("click", _folderClose);
  }
  const modal = document.getElementById("folder-modal");
  if (modal && !modal._folderWired) {
    modal._folderWired = true;
    modal.addEventListener("click", e => { if (e.target === modal) _folderClose(); });
  }
  const nameEl = document.getElementById("folder-name");
  if (nameEl && !nameEl._folderWired) {
    nameEl._folderWired = true;
    let commitTimer = null;
    nameEl.addEventListener("input", () => {
      // Debounced commit so we're not writing IDB on every keystroke.
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(async () => {
        const fid = document.getElementById("folder-modal")._folderId;
        const rec = Assets.get(fid);
        if (!rec) return;
        const raw = nameEl.value.trim();
        const clean = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
        if (clean && clean !== rec.name) {
          rec.name = clean;
          await Assets.put(rec);
        }
      }, 250);
    });
  }
  const funcEl = document.getElementById("folder-function");
  if (funcEl && !funcEl._folderWired) {
    funcEl._folderWired = true;
    funcEl.addEventListener("change", async () => {
      const fid = document.getElementById("folder-modal")._folderId;
      const rec = Assets.get(fid);
      if (!rec) return;
      const newFunc = funcEl.value;
      if (newFunc === rec.functionKey) return;
      // Keep slot assignments that exist in BOTH old and new function;
      // drop anything else. Preserves user effort when relabeling
      // between similar functions (e.g. character ↔ enemy share 'idle').
      const newDef = _ASSET_FUNCTIONS[newFunc] || _ASSET_FUNCTIONS["decoration"];
      const newSlots = {};
      for (const s of newDef.slots) {
        newSlots[s.name] = (rec.slots && rec.slots[s.name]) || null;
      }
      rec.functionKey = newFunc;
      rec.slots = newSlots;
      await Assets.put(rec);
      _folderRender();
    });
  }
  const autoBtn = document.getElementById("folder-autosort");
  if (autoBtn && !autoBtn._folderWired) {
    autoBtn._folderWired = true;
    autoBtn.addEventListener("click", _folderAutoSort);
  }
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _folderInstallHandlers);
  } else {
    _folderInstallHandlers();
  }
}

/* ── Audio file decode + asset creation ─────────────────────────── */
async function loadAudioFileToAsset(file) {
  const buf = await file.arrayBuffer();
  // Use the page's existing AudioContext (first one created on Play
  // start) when available — otherwise spawn a transient one. Either
  // way it's only used to decode; we take a copy of the channel data.
  let ctx = (previewState && previewState.audioCtx) || null;
  let ctxIsTransient = false;
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxIsTransient = true;
  }
  const decoded = await ctx.decodeAudioData(buf.slice(0));
  let data;
  if (decoded.numberOfChannels >= 2) {
    data = [decoded.getChannelData(0).slice(), decoded.getChannelData(1).slice()];
  } else {
    data = decoded.getChannelData(0).slice();
  }
  if (ctxIsTransient) try { ctx.close(); } catch (e) {}
  const id = _newAssetId();
  const record = {
    id,
    name: file.name,
    sampleRate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
    durationSec: decoded.duration,
    data
  };
  _assets.set(id, record);
  // Persist async — don't block the UI on slow disks.
  _idbPut(record).catch(e => console.warn("[assets] IDB put failed:", e));
  return record;
}

function getAsset(id) { return id ? _assets.get(id) : null; }

async function deleteAsset(id) {
  if (!id) return;
  _assets.delete(id);
  try { await _idbDelete(id); } catch (e) {}
}

/* Codegen helper — emit a setSampleRate + load(...) call for a node
 * with an assetId. For mono nodes pass channelIndex (default 0); for
 * stereo nodes call twice (channels 0 and 1) into setLoadL/setLoadR.
 * Samples larger than ASSET_EMBED_LIMIT emit a TODO comment with the
 * asset's metadata so the user can hook runtime loading externally
 * (full musical stems use this path). */
function emitAssetLoadCpp(node, channel, methodLoad, methodSetSr) {
  const id = node.params && node.params.assetId;
  const a = getAsset(id);
  if (!a) {
    return `        // ${node.id}: no sample loaded`;
  }
  const arr = (a.channels >= 2 && Array.isArray(a.data)) ? a.data[channel | 0] : a.data;
  if (!arr || !arr.length) return `        // ${node.id}: empty sample`;
  const N = arr.length;
  if (N > ASSET_EMBED_LIMIT) {
    // Stem-sized samples — too big to embed as constexpr without
    // bloating the source. Skip the embed and leave a TODO; live
    // preview's AudioWorklet path will load via postMessage in v2.
    return [
      `        // ${node.id}: sample too large to embed (${N} samples,`,
      `        //   ${a.durationSec.toFixed(2)}s @ ${a.sampleRate}Hz, file=${JSON.stringify(a.name)})`,
      `        //   wire runtime sample loading manually if exporting; live preview`,
      `        //   loads via AudioWorklet postMessage [v2 — not yet implemented]`,
      `        ${node.id}.${methodSetSr}(${a.sampleRate.toFixed(1)}f);`
    ].join("\n");
  }
  // Embed up to ASSET_EMBED_LIMIT samples as a static constexpr float[].
  // Per-sample lit takes ~9 chars × N — ~2.3MB worst case at the limit;
  // reasonable for an exported header. Wrap in a brace-block scope so
  // multiple instances don't collide on the array name.
  const chunks = [];
  for (let i = 0; i < N; i += 8) {
    const slice = [];
    for (let j = 0; j < 8 && i + j < N; j++) {
      const v = arr[i + j];
      slice.push((isFinite(v) ? v : 0).toFixed(5) + "f");
    }
    chunks.push(slice.join(", "));
  }
  const arrName = `${node.id}_${channel === 1 ? "R" : "L"}`;
  const loadMeth = methodLoad;
  return [
    `        {`,
    `            static constexpr float ${arrName}[] = {`,
    `                ${chunks.join(",\n                ")}`,
    `            };`,
    `            ${node.id}.${methodSetSr}(${a.sampleRate.toFixed(1)}f);`,
    `            ${node.id}.${loadMeth}(${arrName}, ${N});`,
    `        }`
  ].join("\n");
}

/* Sidecar manifest — emitted alongside the .gpatch on save. JSON
 * listing the asset metadata for any sample-based node in the patch.
 * Audio data is NOT included (would inflate the file beyond reason);
 * the .wav files stay on the user's disk in their original location. */
function buildAssetManifest() {
  const used = new Set();
  state.nodes.forEach(n => {
    const id = n.params && n.params.assetId;
    if (id) used.add(id);
  });
  const out = { version: 1, assets: {} };
  used.forEach(id => {
    const a = _assets.get(id);
    if (!a) return;
    out.assets[id] = {
      name: a.name,
      sampleRate: a.sampleRate,
      channels: a.channels,
      durationSec: a.durationSec,
      lengthSamples: Array.isArray(a.data) ? a.data[0].length : a.data.length
    };
  });
  return out;
}

/* Hook into the existing btn-save click. We can't replace the listener
 * cleanly (it's attached above), so instead extend the save flow by
 * adding a second listener that also drops a sidecar. The original
 * downloads .gpatch as well — both files arrive in the user's
 * Downloads folder back-to-back. */
(function installSidecarSave() {
  const saveBtn = document.getElementById("btn-save");
  if (!saveBtn) return;
  saveBtn.addEventListener("click", () => {
    const manifest = buildAssetManifest();
    if (!Object.keys(manifest.assets).length) return;  // no samples → no sidecar
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (state.filename || "patch.gpatch").replace(/\.gpatch$/, "") + ".assets.json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
})();

// Hook into render() so adding/removing Button or Slider nodes refreshes
// the controls panel.
const _render_for_controls = render;
render = function () {
  _render_for_controls.apply(this, arguments);
  renderMonitorControls();
};

// Reveal piano (status flag) whenever a setPreviewStatus("playing") fires.
const _setPreviewStatus = setPreviewStatus;
setPreviewStatus = function(state, label) {
  _setPreviewStatus(state, label);
  if (state === "playing") showPiano();
  else if (state === "idle" || state === "error") resetPiano();
};

