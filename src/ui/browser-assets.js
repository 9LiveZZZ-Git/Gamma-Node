function brRenderAssets() {
  brRenderSourceList();
  brRenderTypeRail();
  brRenderAssetGrid();
  // Phase 8.B.15 -- refresh the compile-server manifest in the
  // background; re-render when it lands (kept out of the sync path so
  // the tab opens instantly even if the server is slow / absent).
  if (!brRenderAssets._refreshing) {
    brRenderAssets._refreshing = true;
    brRefreshServerAssets().finally(() => {
      brRenderAssets._refreshing = false;
      // Only re-render if the user is still on the Assets tab.
      if (brState.tab === "assets") {
        brRenderSourceList(); brRenderTypeRail(); brRenderAssetGrid();
      }
    });
  }
}

function brRenderSourceList() {
  const wrap = document.getElementById("br-src-list");
  if (!wrap) return;
  wrap.innerHTML = _brSources.map(s => `
    <div class="src-chip ${s.status} ${brState.assetSource === s.id ? "active" : ""}" data-id="${escapeAttr(s.id)}">
      <span class="src-led"></span>
      <span style="display:flex; flex-direction:column; gap:1px; min-width:0;">
        <span class="src-name">${escapeText(s.name)}</span>
        <span class="src-path">${escapeText(s.path)}</span>
      </span>
      <span class="src-status">${escapeText(s.status)}</span>
    </div>
  `).join("");
  wrap.querySelectorAll(".src-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      brState.assetSource = (brState.assetSource === chip.dataset.id) ? null : chip.dataset.id;
      brRenderAssets();
    });
  });
}

function brRenderTypeRail() {
  const wrap = document.getElementById("br-type-rail");
  if (!wrap) return;
  const all = brCollectAssets();
  const counts = { audio: 0, midi: 0, video: 0, gpatch: 0, gdsp: 0, sprite: 0, folder: 0, mesh: 0, texture: 0, hdri: 0 };
  all.forEach(a => { if (counts[a.type] != null) counts[a.type]++; });
  const types = [
    { k: null,     label: "ALL",     count: all.length },
    { k: "audio",  label: ".WAV",    count: counts.audio  },
    { k: "midi",   label: ".MID",    count: counts.midi   },
    { k: "video",  label: ".MP4",    count: counts.video  },
    { k: "gpatch", label: ".GPATCH", count: counts.gpatch },
    { k: "gdsp",   label: ".GDSP",   count: counts.gdsp   },
    { k: "sprite", label: ".SPRITE", count: counts.sprite },
    { k: "folder", label: ".FOLDER", count: counts.folder },
    { k: "mesh",   label: ".GLB",    count: counts.mesh    },
    { k: "texture",label: ".TEX",    count: counts.texture },
    { k: "hdri",   label: ".HDRI",   count: counts.hdri    },
  ];
  wrap.innerHTML = types.map(t => `
    <span class="type-chip ${brState.assetType === t.k ? "active" : ""}" data-type="${t.k || ""}">
      ${escapeText(t.label)}<span class="count">${t.count}</span>
    </span>
  `).join("")
  // asset-folders -- + Folder shortcut next to the type chips. Opens
  // the folder editor on a freshly-created blank folder.
  + `<span class="type-chip" id="br-new-folder-btn" data-action="new-folder" title="Create a new asset folder (group related sprites by function: character / enemy / item / etc.)" style="cursor:pointer; background:rgba(255,200,100,0.15); color:#ffd080;">+ FOLDER</span>`;
  wrap.querySelectorAll(".type-chip").forEach(c => {
    if (c.dataset.action === "new-folder") {
      c.addEventListener("click", async () => {
        const rec = await createFolderAsset("", "decoration", { source: "manual" });
        brRenderAssets();
        if (typeof _folderOpen === "function") _folderOpen(rec.id);
      });
    } else {
      c.addEventListener("click", () => {
        brState.assetType = c.dataset.type || null;
        brRenderAssets();
      });
    }
  });
}

/* Pull assets from every connected source. For now only local-idb
 * is real (the existing _assets map populated from IDB on startup);
 * cloud sources will append into this list once their connect
 * handlers populate the per-source asset cache. */
function brCollectAssets() {
  const out = [];
  if (_assets) {
    _assets.forEach((a, id) => {
      out.push({
        id, name: a.name, type: "audio",
        sub: `${a.durationSec.toFixed(2)} s · ${a.sampleRate} Hz · ${a.channels >= 2 ? "stereo" : "mono"}`,
        source: "local-idb", asset: a,
      });
    });
  }
  // §8.A.1 -- include sprite assets. Sub line shows pixel dims +
  // frames metadata; defaults frame count to 1×1 when unset.
  if (_spriteAssets) {
    _spriteAssets.forEach((a, id) => {
      const fx = a.framesX || 1;
      const fy = a.framesY || 1;
      const nFrames = fx * fy;
      const sub = (nFrames > 1)
        ? `${a.width}×${a.height} · ${fx}×${fy} frames · ${a.fps || 1} fps`
        : `${a.width}×${a.height}`;
      out.push({
        id, name: a.name, type: "sprite",
        sub, source: "local-idb", asset: a,
      });
    });
  }
  // asset-folders -- include folder assets. Sub line shows function +
  // filled / total slots so the user can see how complete a folder is.
  if (_folderAssets) {
    _folderAssets.forEach((a, id) => {
      const fdef = _ASSET_FUNCTIONS[a.functionKey] || _ASSET_FUNCTIONS["decoration"];
      const totalSlots = fdef.slots.length;
      const filled = Object.values(a.slots || {}).filter(v => v).length;
      const sub = `${fdef.label} · ${filled}/${totalSlots} slots`;
      out.push({
        id, name: a.name, type: "folder",
        sub, source: "local-idb", asset: a,
      });
    });
  }
  // Phase 8.B.15 -- compile-server assets (mesh / texture / hdri).
  for (const sa of _serverAssets) {
    if (!sa || !sa.id) continue;
    const kb = sa.size ? Math.round(sa.size / 1024) : 0;
    const sizeStr = kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB";
    out.push({
      id: "server:" + sa.id, name: sa.name || sa.id, type: sa.type || "file",
      sub: (sa.source || "server") + " · " + sizeStr,
      source: "server", asset: sa, serverId: sa.id
    });
  }
  return out;
}

function brRenderAssetGrid() {
  const grid = document.getElementById("br-assets-grid");
  if (!grid) return;
  let list = brCollectAssets();
  if (brState.assetType)   list = list.filter(a => a.type === brState.assetType);
  if (brState.assetSource) list = list.filter(a => a.source === brState.assetSource);

  if (!list.length) {
    grid.innerHTML = `<div style="grid-column:1/-1; padding:30px 16px; text-align:center; color:var(--text-3); font-family:var(--font-body-m); font-size:11px; line-height:1.6;">
      No assets match.<br><br>
      <span style="font-family:var(--font-mono); font-size:9.5px; letter-spacing:0.10em;">DROP A FILE HERE TO IMPORT — or load from a sample-host node's properties pane.</span>
    </div>`;
    return;
  }

  grid.innerHTML = list.map(a => {
    const dragTitle = (a.type === "sprite")
      ? a.name + ' — drag onto the patch canvas to drop in an ImageURL + Sprite pair (double-click name to rename)'
      : a.name + ' — drag onto a SamplePlayer / GranularPlayer node (double-click name to rename)';
    // §8.A.2 / §8.A.3 -- sprite metadata inline editor: cols / rows /
    // fps / px-u (pixels per world unit). All persist via Assets.put.
    const meta = (a.type === "sprite" && a.asset) ? `
      <div class="asset-spr-meta" style="display:flex; flex-wrap:wrap; gap:4px 6px; margin-top:4px; font-size:9.5px; font-family:var(--font-mono); color:var(--text-3);">
        <label style="display:flex; align-items:center; gap:2px;">cols
          <input type="number" min="1" max="64" value="${a.asset.framesX || 1}" data-spr-field="framesX" data-asset-id="${escapeAttr(a.id)}" style="width:34px; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--text-3); border-radius:2px; font-family:inherit; font-size:9.5px;"/>
        </label>
        <label style="display:flex; align-items:center; gap:2px;">rows
          <input type="number" min="1" max="64" value="${a.asset.framesY || 1}" data-spr-field="framesY" data-asset-id="${escapeAttr(a.id)}" style="width:34px; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--text-3); border-radius:2px; font-family:inherit; font-size:9.5px;"/>
        </label>
        <label style="display:flex; align-items:center; gap:2px;">fps
          <input type="number" min="0.5" max="60" step="0.5" value="${a.asset.fps || 1}" data-spr-field="fps" data-asset-id="${escapeAttr(a.id)}" style="width:38px; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--text-3); border-radius:2px; font-family:inherit; font-size:9.5px;"/>
        </label>
        <label style="display:flex; align-items:center; gap:2px;" title="pixels per world unit: drop-time Sprite size = textureDims / framesXY / scale">scale
          <input type="number" min="1" max="2048" step="1" value="${a.asset.scale || 32}" data-spr-field="scale" data-asset-id="${escapeAttr(a.id)}" style="width:46px; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--text-3); border-radius:2px; font-family:inherit; font-size:9.5px;"/>
        </label>
      </div>` : "";
    const _isServer = a.source === "server";
    const _serverId = _isServer ? (a.serverId || a.id.replace(/^server:/, "")) : "";
    return `
    <div class="asset-card" draggable="true" data-asset-id="${escapeAttr(a.id)}" data-asset-type="${escapeAttr(a.type)}"${_isServer ? ` data-server-id="${escapeAttr(_serverId)}"` : ""} title="${escapeAttr(dragTitle)}">
      ${_isServer ? "" : `<button class="asset-del" data-del-id="${escapeAttr(a.id)}" title="Delete this asset (irreversible)" style="position:absolute; top:3px; right:3px; width:18px; height:18px; padding:0; line-height:16px; border-radius:50%; background:rgba(40,12,12,0.85); color:#ffb0a0; border:1px solid rgba(200,80,80,0.4); cursor:pointer; font-size:12px; font-weight:600; z-index:2;">×</button>`}
      <div class="asset-thumb">${brAssetThumb(a)}</div>
      <div class="asset-meta">
        <span class="asset-name" data-asset-id="${escapeAttr(a.id)}" title="Double-click to rename" style="cursor:text;">${escapeText(a.name)}</span>
        <span class="asset-sub">${escapeText(a.sub)}</span>
        ${meta}
      </div>
      <span class="asset-badge ${a.type}">${escapeText(a.type)}</span>
    </div>
  `;
  }).join("");

  // Wire dragstart so the card can carry the asset id onto a node.
  // For sprite assets the patch canvas accepts the drop and creates
  // an ImageURL + Sprite pair (see _wirePatchCanvasAssetDrop).
  grid.querySelectorAll(".asset-card").forEach(card => {
    card.style.position = "relative";  // anchor for the delete button
    card.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/x-gamma-asset-id", card.dataset.assetId);
      // Drops also carry a type tag so the patch handler knows whether
      // to spawn ImageURL+Sprite (sprite), a SpriteFolder node (folder),
      // or something else.
      if (card.dataset.assetType) {
        e.dataTransfer.setData("text/x-gamma-asset-type", card.dataset.assetType);
      }
      e.dataTransfer.effectAllowed = "copy";
    });
    // asset-folders -- folder cards open the editor on click.
    if (card.dataset.assetType === "folder") {
      card.addEventListener("click", e => {
        // Don't trigger when the click was on the × delete button or an
        // input. Both stop propagation in their own handlers, but
        // guard defensively in case markup changes.
        if (e.target.closest("button.asset-del")) return;
        if (e.target.tagName === "INPUT") return;
        if (typeof _folderOpen === "function") _folderOpen(card.dataset.assetId);
      });
      card.style.cursor = "pointer";
    }
    // Phase 8.B.15 -- server assets: click drops the matching loader
    // node into the canvas (mesh → LoadGLB, hdri → HDRISky, texture →
    // a textured PhysicalMat). dragstart already carries the id.
    if (card.dataset.serverId) {
      card.style.cursor = "pointer";
      card.addEventListener("click", e => {
        if (e.target.tagName === "INPUT") return;
        _dropServerAsset(card.dataset.serverId, card.dataset.assetType);
      });
    }
  });
  // §8.A.1 / §8.A.2 -- delete buttons.
  grid.querySelectorAll(".asset-del").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delId;
      const rec = Assets.get(id);
      const label = rec ? rec.name : id;
      if (!confirm("Delete asset '" + label + "'? This can't be undone.")) return;
      // Revoke any cached object URL on the thumbnail to free the blob.
      if (rec && rec._thumbUrl) {
        try { URL.revokeObjectURL(rec._thumbUrl); } catch (_) {}
      }
      await Assets.delete(id);
      console.log("[assets] deleted '" + label + "' id=" + id);
      brRenderAssets();
    });
  });
  // §8.A.2 -- sprite metadata inputs. Edit framesX/framesY/fps/scale in
  // place; changes persist via Assets.put. Refresh the card sub-line + any
  // already-wired Sprite nodes via render().
  grid.querySelectorAll("input[data-spr-field]").forEach(inp => {
    inp.addEventListener("change", async (e) => {
      e.stopPropagation();
      const id = inp.dataset.assetId;
      const field = inp.dataset.sprField;
      const rec = Assets.get(id);
      if (!rec) return;
      let val = parseFloat(inp.value);
      if (!Number.isFinite(val) || val <= 0) val = (field === "fps" ? 1 : (field === "scale" ? 32 : 1));
      rec[field] = val;
      await Assets.put(rec);
      brRenderAssets();
      // Live-refresh any patches consuming this asset (so framesX/Y
      // changes are immediately reflected without a reload).
      if (typeof render === "function") {
        try { render(); } catch (_) {}
      }
    });
    // Don't let typing in the input start a drag-card behavior.
    inp.addEventListener("mousedown", e => e.stopPropagation());
    inp.addEventListener("dragstart", e => e.preventDefault());
  });
  // §8.A.3 -- rename. Double-click the asset name to edit in place.
  // Enter commits, Escape cancels, blur commits. All asset types support
  // rename (audio + sprite). Stops propagation so card drag doesn't fire.
  grid.querySelectorAll(".asset-name").forEach(nameEl => {
    nameEl.addEventListener("mousedown", e => e.stopPropagation());
    nameEl.addEventListener("dragstart", e => e.preventDefault());
    nameEl.addEventListener("dblclick", e => {
      e.stopPropagation();
      const id = nameEl.dataset.assetId;
      if (!id) return;
      const rec = Assets.get(id);
      if (!rec) return;
      const original = rec.name;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = original;
      inp.style.cssText = "width:100%; padding:1px 3px; background:var(--bg-1); color:var(--text-1); border:1px solid var(--phosphor); border-radius:2px; font-family:var(--font-mono); font-size:9.5px;";
      nameEl.replaceWith(inp);
      inp.focus();
      inp.select();
      let committed = false;
      const commit = async () => {
        if (committed) return;
        committed = true;
        const raw = inp.value.trim();
        const newName = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || original;
        if (newName !== original) {
          rec.name = newName;
          await Assets.put(rec);
          console.log("[assets] renamed '" + original + "' → '" + newName + "' (id=" + rec.id + ")");
        }
        brRenderAssets();
        if (typeof render === "function") {
          // Live-update any wired ImageURL nodes that reference the old
          // name via 'asset:OLD' so the resolver finds the new name.
          if (newName !== original && Array.isArray(state.edges)) {
            for (const n of state.nodes || []) {
              if (n && n.type === "ImageURL" && n.params &&
                  n.params.url === "asset:" + original) {
                n.params.url = "asset:" + newName;
              }
            }
          }
          try { render(); } catch (_) {}
        }
      };
      inp.addEventListener("keydown", ev => {
        if (ev.key === "Enter")  { ev.preventDefault(); commit(); }
        if (ev.key === "Escape") { ev.preventDefault(); committed = true; brRenderAssets(); }
      });
      inp.addEventListener("blur", commit);
    });
  });
}

/* Generate a tiny SVG thumbnail per asset type. Audio uses the cached
 * data when available (real waveform); MIDI/video/gpatch/gdsp get
 * stylized glyphs since there's no representational data yet. */
function brAssetThumb(a) {
  if (a.type === "audio" && a.asset && a.asset.data) {
    // Quick downsampled min/max — 64 buckets across the asset.
    const data = Array.isArray(a.asset.data) ? a.asset.data[0] : a.asset.data;
    const W = 100, H = 44, BUCKETS = 50;
    const step = Math.max(1, Math.floor(data.length / BUCKETS));
    let path = "";
    for (let i = 0; i < BUCKETS; i++) {
      let mn = 1, mx = -1;
      for (let j = 0; j < step; j++) {
        const v = data[i * step + j] || 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const x = (i / BUCKETS) * W;
      const yMx = H/2 - mx * (H/2 - 2);
      const yMn = H/2 - mn * (H/2 - 2);
      path += `M ${x.toFixed(1)} ${yMx.toFixed(1)} L ${x.toFixed(1)} ${yMn.toFixed(1)} `;
    }
    return `<svg viewBox="0 0 100 44" preserveAspectRatio="none">
      <line x1="0" y1="22" x2="100" y2="22" stroke="rgba(200,232,90,0.10)" stroke-width="0.5"/>
      <path d="${path}" stroke="var(--phosphor)" stroke-width="0.7" fill="none" opacity="0.85"/>
    </svg>`;
  }
  // Phase 8.B.15 -- server asset glyphs (mesh / texture / hdri).
  if (a.type === "mesh") {
    return `<svg viewBox="0 0 100 44">
      <g fill="none" stroke="rgba(150,200,255,0.9)" stroke-width="1">
        <polygon points="50,8 78,22 50,36 22,22"/>
        <line x1="50" y1="8" x2="50" y2="36"/>
        <line x1="22" y1="22" x2="78" y2="22"/>
      </g>
    </svg>`;
  }
  if (a.type === "texture") {
    return `<svg viewBox="0 0 100 44">
      <rect x="24" y="6" width="52" height="32" rx="2" fill="none" stroke="rgba(160,220,160,0.9)" stroke-width="1"/>
      <path d="M 24 28 L 38 16 L 50 26 L 62 12 L 76 24" fill="none" stroke="rgba(160,220,160,0.7)" stroke-width="1"/>
      <circle cx="40" cy="14" r="3" fill="rgba(255,240,160,0.8)"/>
    </svg>`;
  }
  if (a.type === "hdri") {
    return `<svg viewBox="0 0 100 44">
      <rect x="14" y="8" width="72" height="28" rx="3" fill="url(#hdg)"/>
      <defs><linearGradient id="hdg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(120,170,255,0.9)"/>
        <stop offset="0.6" stop-color="rgba(255,210,140,0.8)"/>
        <stop offset="1" stop-color="rgba(120,90,60,0.8)"/>
      </linearGradient></defs>
      <circle cx="68" cy="16" r="4" fill="rgba(255,250,210,0.95)"/>
    </svg>`;
  }
  // Type-specific glyphs (stubs for non-audio sources)
  if (a.type === "midi") {
    return `<svg viewBox="0 0 100 44">
      <g fill="var(--gate)" opacity="0.85">
        <rect x="6"  y="22" width="6" height="3"/>
        <rect x="16" y="14" width="6" height="3"/>
        <rect x="26" y="26" width="6" height="3"/>
        <rect x="36" y="10" width="6" height="3"/>
        <rect x="46" y="18" width="6" height="3"/>
        <rect x="56" y="22" width="6" height="3"/>
        <rect x="66" y="14" width="6" height="3"/>
        <rect x="76" y="26" width="6" height="3"/>
      </g>
    </svg>`;
  }
  if (a.type === "video") {
    return `<svg viewBox="0 0 100 44">
      <rect x="0" y="0" width="100" height="44" fill="#0a0c10"/>
      <polygon points="42,14 42,30 58,22" fill="var(--info)" opacity="0.9"/>
      <line x1="0" y1="40" x2="40" y2="40" stroke="var(--info)" stroke-width="2"/>
    </svg>`;
  }
  if (a.type === "gpatch") {
    return `<svg viewBox="0 0 100 44">
      <line x1="14" y1="14" x2="42" y2="12" stroke="var(--warn)" stroke-width="0.7" opacity="0.6"/>
      <line x1="42" y1="12" x2="68" y2="22" stroke="var(--warn)" stroke-width="0.7" opacity="0.6"/>
      <line x1="68" y1="22" x2="42" y2="32" stroke="var(--warn)" stroke-width="0.7" opacity="0.6"/>
      <circle cx="14" cy="14" r="2" fill="var(--warn)"/>
      <circle cx="42" cy="12" r="2" fill="var(--warn)"/>
      <circle cx="68" cy="22" r="2" fill="var(--warn)"/>
      <circle cx="42" cy="32" r="2" fill="var(--warn)"/>
    </svg>`;
  }
  if (a.type === "gdsp") {
    return `<svg viewBox="0 0 100 44">
      <text x="50" y="18" text-anchor="middle" font-family="JetBrains Mono" font-size="6" fill="#a89cff" opacity="0.85">class</text>
      <text x="50" y="28" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#a89cff" font-weight="600">{ }</text>
      <text x="50" y="38" text-anchor="middle" font-family="JetBrains Mono" font-size="5" fill="#a89cff" opacity="0.6">.gdsp</text>
    </svg>`;
  }
  // asset-folders -- folder thumbnail. Shows a 2×2 mini-grid of the
  // folder's first 4 filled slots so the user can scan the contents at
  // a glance. Empty slots get a "+" placeholder.
  if (a.type === "folder" && a.asset) {
    const slots = a.asset.slots || {};
    const filled = Object.entries(slots).filter(([k, v]) => v).slice(0, 4);
    const cells = [0, 1, 2, 3].map(i => {
      const entry = filled[i];
      if (!entry) {
        return `<div style="background:#0a0c10; border:1px dashed rgba(255,255,255,0.08); display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,0.18); font-size:14px;">+</div>`;
      }
      const sid = entry[1];
      const srec = _spriteAssets.get(sid);
      if (!srec || !srec.blob) {
        return `<div style="background:#0a0c10; border:1px solid rgba(255,80,80,0.4); color:#ff8060; font-size:8px; padding:1px;" title="sprite deleted">${escapeText(entry[0])}</div>`;
      }
      let url = srec._thumbUrl;
      if (!url) {
        try { url = URL.createObjectURL(srec.blob); srec._thumbUrl = url; } catch (_) { url = ""; }
      }
      return `<div style="background:#0a0c10; overflow:hidden; display:flex; align-items:center; justify-content:center;"><img src="${escapeAttr(url)}" style="max-width:100%; max-height:100%; image-rendering:pixelated; image-rendering:crisp-edges;"/></div>`;
    }).join("");
    return `<div style="width:100%; height:100%; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:1px; background:rgba(255,200,100,0.10);">${cells}</div>`;
  }
  // §8.A.1 -- sprite thumbnail. Lazy-build an object URL from the blob
  // (cached on the record so we don't leak one per re-render). pixelated
  // image-rendering keeps SNES-style art crisp at thumbnail scale.
  if (a.type === "sprite" && a.asset && a.asset.blob) {
    let url = a.asset._thumbUrl;
    if (!url) {
      try {
        url = URL.createObjectURL(a.asset.blob);
        a.asset._thumbUrl = url;
      } catch (_) { url = ""; }
    }
    return `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:#0a0c10;">
      <img src="${escapeAttr(url)}" style="max-width:100%; max-height:100%; image-rendering:pixelated; image-rendering:crisp-edges;" alt="${escapeAttr(a.name)}"/>
    </div>`;
  }
  return "";
}

/* ─── Connect modal handlers ────────────────────────────────────── */
function brOpenConnectModal() {
  const m = document.getElementById("connect-modal");
  if (m) m.style.display = "flex";
}
function brCloseConnectModal() {
  const m = document.getElementById("connect-modal");
  if (m) m.style.display = "none";
}

/* Local-folder connect uses the File System Access API where
 * available. On non-Chromium browsers we fall back to letting the
 * user click a hidden <input type="file"> — that's slimmer than
 * the directory picker but at least imports do work. */
async function brConnectLocalFolder() {
  const labelEl = document.getElementById("connect-local-name");
  const label = (labelEl && labelEl.value.trim()) || "Local Folder";
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const dir = await window.showDirectoryPicker({ id: "gamma-asset-source" });
      _brSources.push({
        id: "local-fs-" + Date.now(),
        name: label, path: dir.name + "/",
        status: "connected", handle: dir,
      });
      brRenderAssets();
      brCloseConnectModal();
      // Future: walk the directory and populate per-source assets.
      console.info("[browser] Connected local folder:", dir.name);
    } catch (e) {
      // User cancelled the picker — silent.
    }
  } else {
    alert("Local folder picker needs the File System Access API (Chromium-based browsers). Drop files into the Assets list to import them instead.");
  }
}

/* GitHub repo connect: list files via the public Contents API. The
 * modal field captures owner/repo + path + optional PAT. The
 * fetched listing is held in-memory under a new source entry. */
async function brConnectGitHub() {
  const repo  = (document.getElementById("connect-gh-repo")  || {}).value || "";
  const path  = (document.getElementById("connect-gh-path")  || {}).value || "";
  const token = (document.getElementById("connect-gh-token") || {}).value || "";
  if (!repo || !repo.includes("/")) { alert("Repository must be owner/name"); return; }
  const url = `https://api.github.com/repos/${repo}/contents${path.startsWith("/") ? path : "/" + path}`;
  const headers = { "Accept": "application/vnd.github+json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const list = await r.json();
    const files = (Array.isArray(list) ? list : []).filter(x => x.type === "file");
    _brSources.push({
      id: "github-" + Date.now(),
      name: "GitHub · " + repo,
      path: (path || "/") + ` · ${files.length} files`,
      status: "connected",
      githubFiles: files,
    });
    brRenderAssets();
    brCloseConnectModal();
    console.info("[browser] Connected GitHub:", repo, path, files.length, "files");
  } catch (e) {
    alert("GitHub fetch failed: " + e.message);
  }
}

/* ─── Drop-zone wiring on the assets list ───────────────────────── */
function brWireAssetDropZone() {
  const list = document.getElementById("br-assets-list");
  if (!list || list._brWired) return;
  list._brWired = true;
  list.addEventListener("dragover", e => { e.preventDefault(); list.classList.add("dragover"); });
  list.addEventListener("dragleave", e => { if (e.target === list) list.classList.remove("dragover"); });
  list.addEventListener("drop", async e => {
    e.preventDefault();
    list.classList.remove("dragover");
    const files = Array.from(e.dataTransfer.files || []);
    for (const f of files) {
      // Audio files → reuse the existing IDB-backed loader.
      if (typeof loadAudioFileToAsset === "function" && /\.(wav|mp3|ogg|flac|m4a|webm)$/i.test(f.name)) {
        try { await loadAudioFileToAsset(f); } catch (err) { console.warn("[browser] decode failed:", f.name, err); }
      }
      // §8.A.1 -- image files → sprite assets (default 1×1 frames; the
      // user can edit framesX/Y after upload via the sprite props panel
      // shipping in §8.A.2). MIME-type sniff is lenient because Drag-Drop
      // sometimes drops files with no type set.
      else if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name) ||
               (f.type && f.type.indexOf("image/") === 0)) {
        try { await loadImageFileToSpriteAsset(f); }
        catch (err) { console.warn("[browser] sprite import failed:", f.name, err); }
      }
      // Other types — log a TODO; storage shape for them lands later.
      else { console.info("[browser] skipping unsupported file (storage TBD):", f.name); }
    }
    brRenderAssets();
  });
}

