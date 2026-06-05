/* =========================================================================
 * Toolbar
 * ======================================================================== */
document.getElementById("btn-reset").addEventListener("click", () => {
  if (state.nodes.length && !confirm("Reset to demo patch?")) return;
  reset(); render();
});

// Phase 6.6.31 — Clear button. Like Reset but leaves the canvas
// empty instead of repopulating with the demo patch. Useful when
// you want to start from scratch without first deleting every
// node by hand. Confirms when nodes/edges exist (so an accidental
// click doesn't nuke an in-progress patch).
document.getElementById("btn-clear").addEventListener("click", () => {
  const hasContent = (state.nodes && state.nodes.length) || (state.edges && state.edges.length);
  if (hasContent && !confirm("Clear the graph? All nodes + edges will be removed.")) return;
  pushHistory("clear");
  _cleanupBeforePatchSwitch();
  state = freshState();
  clearSelection();
  nextId = 1;
  // Don't wipe the undo/redo stacks — Clear is undo-able, same as
  // any other edit. pushHistory above captured the pre-clear state.
  render();
  renderProps && renderProps();
});

document.getElementById("btn-delete").addEventListener("click", () => {
  deleteSelection();
});

document.getElementById("btn-gen").addEventListener("click", () => {
  document.querySelector('.tab[data-tab="codepreview"]').click();
  switchCodePreviewSub("code");
});

document.getElementById("btn-save").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, _omitRuntimeKeys, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = state.filename || "patch.gpatch";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById("btn-load").addEventListener("click", () => {
  document.getElementById("file-input").click();
});

/* v0.2.23 — extracted from the file-input handler's onload body so
 * the same migration + state-setup path runs whether the patch comes
 * from a user-selected .gpatch file OR from a `<script id="gamma-
 * embedded-patch">` tag baked into a standalone HTML export. The
 * `filename` arg labels the source in state.filename + drives the
 * patchName fallback when the loaded JSON didn't carry one. */
function _applyLoadedPatch(loaded, filename) {
  if (!loaded || !loaded.nodes || !loaded.edges) throw new Error("missing nodes/edges");
  state = Object.assign({ version: 2, patchName: "MyPatch", exposed: {}, groups: [] }, loaded);
  if (!Array.isArray(state.groups)) state.groups = [];
  if (!state.rig || !Array.isArray(state.rig.displays)) state.rig = defaultRig();
  if (typeof state.rig.shaderCenterYaw   !== "number") state.rig.shaderCenterYaw   = 0;
  if (typeof state.rig.shaderCenterPitch !== "number") state.rig.shaderCenterPitch = 0;
  state.rig.surface = _migrateRigSurface(state.rig.surface
    || (RIG_TEMPLATES[state.rig.templateKey] && RIG_TEMPLATES[state.rig.templateKey].surface)
    || null);
  if (!Array.isArray(state.rig.sweetSpot) || state.rig.sweetSpot.length !== 3) {
    state.rig.sweetSpot = _deriveSweetSpot(state.rig.surface);
  }
  if (typeof state.rig.surfaceVisible !== "boolean") state.rig.surfaceVisible = true;
  state.rig.displays.forEach(d => {
    if (!("warpMesh" in d) || (d.warpMesh !== null && !_validateWarpMesh(d.warpMesh))) {
      d.warpMesh = null;
    }
    d.edgeBlend = _migrateEdgeBlend(d.edgeBlend);
    if (!d.keystoneCorners || typeof d.keystoneCorners !== "object") {
      d.keystoneCorners = { tlx: 0, tly: 0, trx: 0, try_: 0, blx: 0, bly: 0, brx: 0, bry: 0 };
    } else {
      d.keystoneCorners.tlx  = +(d.keystoneCorners.tlx)  || 0;
      d.keystoneCorners.tly  = +(d.keystoneCorners.tly)  || 0;
      d.keystoneCorners.trx  = +(d.keystoneCorners.trx)  || 0;
      d.keystoneCorners.try_ = +(d.keystoneCorners.try_) || 0;
      d.keystoneCorners.blx  = +(d.keystoneCorners.blx)  || 0;
      d.keystoneCorners.bly  = +(d.keystoneCorners.bly)  || 0;
      d.keystoneCorners.brx  = +(d.keystoneCorners.brx)  || 0;
      d.keystoneCorners.bry  = +(d.keystoneCorners.bry)  || 0;
    }
    if (!('bezierCorrections' in d)) d.bezierCorrections = null;
    if (d.bezierCorrections && (!Array.isArray(d.bezierCorrections.ctrl) ||
        !Number.isInteger(d.bezierCorrections.cols) ||
        !Number.isInteger(d.bezierCorrections.rows))) {
      d.bezierCorrections = null;
    }
  });
  state.nodes.forEach(n => {
    if (n.type === "VisualOutput") {
      if (!n.params) n.params = {};
      if (typeof n.params.display !== "number") n.params.display = 0;
    }
  });
  const fname = filename || "embedded.gpatch";
  state.filename = fname;
  const stem = fname.replace(/\.[^.]+$/, "");
  if (!loaded.patchName) state.patchName = stem.replace(/[^A-Za-z0-9_]/g, "_");
  let maxId = 0;
  state.nodes.forEach(n => {
    const m = parseInt(String(n.id).replace(/\D/g, ""), 10);
    if (m > maxId) maxId = m;
  });
  nextId = maxId + 1;
  clearSelection();
  undoStack.length = 0;
  redoStack.length = 0;
  resetView();
  if (typeof _updateProjectionPill === "function") _updateProjectionPill();
  if (Visual && Visual.theaterCam && state.rig && Array.isArray(state.rig.sweetSpot)) {
    Visual.theaterCam.pos[0] = state.rig.sweetSpot[0];
    Visual.theaterCam.pos[1] = state.rig.sweetSpot[1];
    Visual.theaterCam.pos[2] = state.rig.sweetSpot[2];
  }
  render();
}

document.getElementById("file-input").addEventListener("change", ev => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      // Phase 8.A.3.2 -- prefab detection. If the loaded .gpatch has
      // a prefabMeta field, the user probably wants to DROP it as a
      // PrefabInstance into the current patch, not replace the whole
      // editor session with it. Ask -- "Drop" inserts an instance,
      // "Load full" runs the legacy patch-replace path.
      if (parsed && parsed.prefabMeta && typeof parsed.prefabMeta === "object") {
        const drop = confirm(
          "'" + file.name + "' is a prefab template.\n\n" +
          "OK = drop a PrefabInstance into the current patch\n" +
          "Cancel = load it as a full .gpatch (replaces current)"
        );
        if (drop) {
          _dropPrefabInstance(parsed, file.name);
          ev.target.value = "";
          return;
        }
      }
      _applyLoadedPatch(parsed, file.name);
    } catch (err) {
      alert("Could not load file: " + err.message);
    }
  };
  reader.readAsText(file);
  ev.target.value = "";
});

/* Phase 8.A.3.2 -- drop a loaded prefab template into the current
 * patch as a PrefabInstance node. Embeds the template JSON in the
 * instance's templateInline param; subsequent _tickPrefabInstances
 * passes auto-expand it on the next visual frame. */
function _dropPrefabInstance(template, sourceName) {
  if (!state || !Array.isArray(state.nodes)) return;
  const name = (typeof template.patchName === "string" && template.patchName)
    ? template.patchName : (sourceName || "Prefab").replace(/\.gpatch$/i, "");
  // Strip top-level non-graph fields from the embedded JSON so the
  // instance only carries what _expandPrefabInstance needs.
  const embed = {
    nodes: Array.isArray(template.nodes) ? template.nodes : [],
    edges: Array.isArray(template.edges) ? template.edges : [],
    prefabMeta: template.prefabMeta || {}
  };
  // Drop at a clear spot on the canvas (~viewport center).
  const _dp = _canvasDropPoint();
  const dropX = _dp.x, dropY = _dp.y;
  pushHistory("prefab-drop:" + name);
  const instId = makeNode("PrefabInstance", dropX, dropY, {
    templateName: name,
    templateInline: JSON.stringify(embed)
  });
  console.log("[prefab] dropped instance " + instId + " from '" + name + "' (" + embed.nodes.length + " template nodes)");
  if (typeof render === "function") render();
  if (typeof renderProps === "function") renderProps();
}

/* Phase 8.A.3.2 -- Save Selection as Prefab modal. */
function _openPrefabSaveModal() {
  const modal = document.getElementById("prefab-save-modal");
  if (!modal) return;
  const selected = Array.from(selectedSet).map(id => state.nodes.find(n => n && n.id === id)).filter(Boolean);
  if (selected.length === 0) {
    alert("Select one or more nodes before saving as prefab.");
    return;
  }
  // Default name = current patch name + "-prefab" if reasonable.
  document.getElementById("pfs-name").value =
    (state.patchName && state.patchName.length) ? (state.patchName + "Prefab") : "MyPrefab";
  document.getElementById("pfs-status").textContent =
    selected.length + " node(s) selected";

  // Build the parameter list. Iterate each selected node's numeric
  // params (skip strings + uiOnlyParams + already-internal `_`-fields).
  const paramsEl = document.getElementById("pfs-params");
  let paramRows = "";
  let paramRowCount = 0;
  for (const node of selected) {
    const def = TYPES[node.type];
    if (!def || !node.params) continue;
    const uiOnly = def.uiOnlyParams || [];
    for (const k of Object.keys(node.params)) {
      if (k.charCodeAt(0) === 95) continue;   // skip _-prefixed
      if (uiOnly.includes(k)) continue;
      if (typeof node.params[k] !== "number") continue;
      const labelDefault = (selected.length > 1) ? (node.type.toLowerCase() + "_" + k) : k;
      const rowId = "pfs-row-" + paramRowCount++;
      paramRows +=
        `<label style="display:flex; align-items:center; gap:8px; font-family:var(--font-mono); font-size:10.5px;">` +
          `<input type="checkbox" data-pfs-node="${escapeAttr(node.id)}" data-pfs-param="${escapeAttr(k)}" checked />` +
          `<span style="flex:0 0 220px; color:var(--text-3);">${escapeText(node.type + "#" + node.id + "." + k)}</span>` +
          `<input type="text" data-pfs-label-for="${rowId}" data-pfs-node-l="${escapeAttr(node.id)}" data-pfs-param-l="${escapeAttr(k)}" value="${escapeAttr(labelDefault)}" style="flex:1; padding:2px 4px; background:var(--bg-2); color:var(--text-1); border:1px solid var(--instr-rule); border-radius:2px; font-family:var(--font-mono); font-size:10px;" />` +
        `</label>`;
    }
  }
  paramsEl.innerHTML = paramRows || `<div style="font-family:var(--font-mono); font-size:10px; color:var(--text-3); padding:4px;">(no numeric params on selected nodes)</div>`;

  // Build the port list. Iterate each selected node's mesh-out ports.
  const portsEl = document.getElementById("pfs-ports");
  let portRows = "";
  let portRowCount = 0;
  let portFirst = null;
  for (const node of selected) {
    const def = TYPES[node.type];
    if (!def || !Array.isArray(def.outs)) continue;
    for (const p of def.outs) {
      if (p.t !== "mesh") continue;
      const rowId = "pfs-port-" + portRowCount++;
      if (!portFirst) portFirst = rowId;
      portRows +=
        `<label style="display:flex; align-items:center; gap:8px; font-family:var(--font-mono); font-size:10.5px;">` +
          `<input type="radio" name="pfs-port" id="${rowId}" data-pfs-port-node="${escapeAttr(node.id)}" data-pfs-port-name="${escapeAttr(p.n)}" ${portFirst === rowId ? "checked" : ""} />` +
          `<span style="color:var(--text-1);">${escapeText(node.type + "#" + node.id + "." + p.n)}</span>` +
          `<span style="color:var(--text-3); font-size:9.5px;">(${escapeText(p.t)})</span>` +
        `</label>`;
    }
  }
  portRows += `<label style="display:flex; align-items:center; gap:8px; font-family:var(--font-mono); font-size:10.5px; margin-top:4px; padding-top:4px; border-top:1px dashed var(--instr-rule); color:var(--text-3);">` +
    `<input type="radio" name="pfs-port" id="pfs-port-none" />` +
    `<span>(none — prefab has no exposed mesh output)</span>` +
    `</label>`;
  portsEl.innerHTML = portRows;

  modal.style.display = "flex";
}

function _closePrefabSaveModal() {
  const modal = document.getElementById("prefab-save-modal");
  if (modal) modal.style.display = "none";
}

function _commitPrefabSave() {
  const selected = Array.from(selectedSet).map(id => state.nodes.find(n => n && n.id === id)).filter(Boolean);
  if (selected.length === 0) { _closePrefabSaveModal(); return; }
  const name = (document.getElementById("pfs-name").value || "Prefab").trim().replace(/[^A-Za-z0-9_-]/g, "_") || "Prefab";

  // Build the exposedParams list from checked rows.
  const exposedParams = [];
  document.querySelectorAll("#pfs-params input[type='checkbox']").forEach(cb => {
    if (!cb.checked) return;
    const nodeId    = cb.dataset.pfsNode;
    const paramName = cb.dataset.pfsParam;
    const labelInp  = document.querySelector(`#pfs-params input[data-pfs-node-l="${nodeId}"][data-pfs-param-l="${paramName}"]`);
    const label     = (labelInp && labelInp.value && labelInp.value.trim()) || paramName;
    exposedParams.push({ label, nodeId, paramName });
  });

  // Selected exposed mesh-out port (radio button "pfs-port").
  const exposedPorts = [];
  const portRadio = document.querySelector("#pfs-ports input[name='pfs-port']:checked");
  if (portRadio && portRadio.id !== "pfs-port-none") {
    exposedPorts.push({
      label: "mesh",
      nodeId: portRadio.dataset.pfsPortNode,
      portName: portRadio.dataset.pfsPortName,
      direction: "out"
    });
  }

  // Snapshot selected nodes + their edges as the template.
  const selectedIds = new Set(selected.map(n => n.id));
  const nodes = selected.map(n => {
    // Strip _-prefixed runtime keys (already-handled by _omitRuntimeKeys
    // on the global save, but doing it inline for the prefab snapshot
    // keeps the inline JSON tidy).
    const clean = {};
    for (const k of Object.keys(n)) {
      if (k.charCodeAt(0) === 95) continue;
      clean[k] = n[k];
    }
    return JSON.parse(JSON.stringify(clean));
  });
  const edges = state.edges
    .filter(e => e && e.from && e.to && selectedIds.has(e.from.node) && selectedIds.has(e.to.node))
    .map(e => ({
      from: { node: e.from.node, port: e.from.port },
      to:   { node: e.to.node,   port: e.to.port   }
    }));

  const payload = {
    version: 2,
    patchName: name,
    nodes,
    edges,
    prefabMeta: { exposedParams, exposedPorts }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".gpatch";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log("[prefab] saved '" + name + ".gpatch' (" + nodes.length + " nodes, " + edges.length + " edges, " +
    exposedParams.length + " exposed params, " + exposedPorts.length + " exposed ports)");
  _closePrefabSaveModal();
}

/* §8.A.6 -- build the same prefab payload as _commitPrefabSave but
 * persist into the IDB Assets store instead of downloading. Re-uses
 * the modal's UI state (name + checkboxes + radio). Triggers
 * _invalidatePrefabRefs via Assets.put -> any live PrefabInstance
 * already pointing at this assetId re-expands from the new template. */
async function _commitPrefabSaveToIdb() {
  const selected = Array.from(selectedSet).map(id => state.nodes.find(n => n && n.id === id)).filter(Boolean);
  if (selected.length === 0) { _closePrefabSaveModal(); return; }
  const rawName = (document.getElementById("pfs-name").value || "Prefab").trim();
  const name = rawName || "Prefab";

  const exposedParams = [];
  document.querySelectorAll("#pfs-params input[type='checkbox']").forEach(cb => {
    if (!cb.checked) return;
    const nodeId    = cb.dataset.pfsNode;
    const paramName = cb.dataset.pfsParam;
    const labelInp  = document.querySelector(`#pfs-params input[data-pfs-node-l="${nodeId}"][data-pfs-param-l="${paramName}"]`);
    const label     = (labelInp && labelInp.value && labelInp.value.trim()) || paramName;
    exposedParams.push({ label, nodeId, paramName });
  });
  const exposedPorts = [];
  const portRadio = document.querySelector("#pfs-ports input[name='pfs-port']:checked");
  if (portRadio && portRadio.id !== "pfs-port-none") {
    exposedPorts.push({
      label: "mesh",
      nodeId: portRadio.dataset.pfsPortNode,
      portName: portRadio.dataset.pfsPortName,
      direction: "out"
    });
  }
  const selectedIds = new Set(selected.map(n => n.id));
  const nodes = selected.map(n => {
    const clean = {};
    for (const k of Object.keys(n)) {
      if (k.charCodeAt(0) === 95) continue;
      clean[k] = n[k];
    }
    return JSON.parse(JSON.stringify(clean));
  });
  const edges = state.edges
    .filter(e => e && e.from && e.to && selectedIds.has(e.from.node) && selectedIds.has(e.to.node))
    .map(e => ({
      from: { node: e.from.node, port: e.from.port },
      to:   { node: e.to.node,   port: e.to.port   }
    }));

  // Try to find an existing prefab asset with the same name --
  // updating it propagates to live instances via Assets.put hook.
  let existing = (typeof Assets !== "undefined" && Assets.findPrefabByName)
    ? Assets.findPrefabByName(name) : null;
  const id = existing ? existing.id : ("p_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1296).toString(36));
  const record = {
    id,
    assetType: "prefab",
    name,
    patchName: name,
    version: 2,
    nodes,
    edges,
    prefabMeta: { exposedParams, exposedPorts },
    createdAt: existing ? existing.createdAt : Date.now()
  };
  try {
    await Assets.put(record);
    const verb = existing ? "updated" : "saved";
    console.log("[prefab] " + verb + " '" + name + "' to IDB (id=" + id + ", " +
      nodes.length + " nodes, " + edges.length + " edges, " +
      exposedParams.length + " exposed params, " + exposedPorts.length + " exposed ports)");
    _closePrefabSaveModal();
    // Refresh assets + prefabs tabs if their render fns exist.
    if (typeof brRenderAssets === "function") {
      try { brRenderAssets(); } catch (_) {}
    }
    if (typeof brRenderPrefabs === "function") {
      try { brRenderPrefabs(); } catch (_) {}
    }
  } catch (e) {
    console.error("[prefab] IDB save failed:", e);
    alert("Failed to save prefab to IDB: " + e.message);
  }
}

/* §8.A.6 -- Drop Prefab from IDB picker. */
function _openPrefabPickModal() {
  const modal = document.getElementById("prefab-pick-modal");
  if (!modal) return;
  const list = (typeof Assets !== "undefined") ? Assets.list({ type: "prefab" }) : [];
  const statusEl = document.getElementById("pfp-status");
  if (statusEl) statusEl.textContent = list.length + " prefab asset(s) in IDB";
  const listEl = document.getElementById("pfp-list");
  if (list.length === 0) {
    listEl.innerHTML = `<div style="padding:16px; font-family:var(--font-mono); font-size:10.5px; color:var(--text-3); text-align:center;">
      No prefab assets in IDB yet.<br><br>
      Select some nodes -> click <b>Save Prefab</b> -> use the <b>Save to IDB</b> button to add one.
    </div>`;
  } else {
    listEl.innerHTML = list.map(p => {
      const meta = (p.prefabMeta || {});
      const nP = (meta.exposedParams || []).length;
      const nN = (p.nodes || []).length;
      const nE = (p.edges || []).length;
      const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "unknown";
      return `<div class="pfp-row" data-asset-id="${escapeAttr(p.id)}" style="display:flex; align-items:center; gap:10px; padding:8px 10px; background:var(--bg-1); border:1px solid var(--instr-rule); border-radius:3px; cursor:pointer;">
        <div style="flex:1; min-width:0;">
          <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-1);">${escapeText(p.name || p.id)}</div>
          <div style="font-family:var(--font-mono); font-size:9.5px; color:var(--text-3); margin-top:2px;">
            ${nN} nodes · ${nE} edges · ${nP} exposed params · updated ${escapeText(updated)}
          </div>
        </div>
        <button class="btn pfp-drop" data-asset-id="${escapeAttr(p.id)}" type="button" title="Insert PrefabInstance referencing this asset">Drop</button>
        <button class="btn danger pfp-del" data-asset-id="${escapeAttr(p.id)}" type="button" title="Delete this asset from IDB (live instances become unresolvable)">×</button>
      </div>`;
    }).join("");
    listEl.querySelectorAll(".pfp-drop").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        _dropPrefabFromAsset(btn.dataset.assetId);
        _closePrefabPickModal();
      });
    });
    listEl.querySelectorAll(".pfp-del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.assetId;
        const rec = Assets.get(id);
        if (!rec) return;
        if (!confirm("Delete prefab '" + (rec.name || id) + "' from IDB?\n\nLive PrefabInstance nodes referencing this asset will keep their last expansion but won't refresh.")) return;
        await Assets.delete(id);
        _openPrefabPickModal();   // refresh list
      });
    });
    listEl.querySelectorAll(".pfp-row").forEach(row => {
      row.addEventListener("click", () => {
        _dropPrefabFromAsset(row.dataset.assetId);
        _closePrefabPickModal();
      });
    });
  }
  modal.style.display = "flex";
}

function _closePrefabPickModal() {
  const m = document.getElementById("prefab-pick-modal");
  if (m) m.style.display = "none";
}

function _dropPrefabFromAsset(assetId) {
  const asset = (typeof Assets !== "undefined") ? Assets.get(assetId) : null;
  if (!asset || asset.assetType !== "prefab") {
    alert("Prefab asset not found: " + assetId);
    return;
  }
  const _dp = _canvasDropPoint();
  const dropX = _dp.x, dropY = _dp.y;
  pushHistory("prefab-drop-idb:" + (asset.name || assetId));
  const instId = makeNode("PrefabInstance", dropX, dropY, {
    templateName:    asset.name || "Prefab",
    templateAssetId: assetId,
    templateInline:  ""   // explicit empty -- the assetId path wins
  });
  console.log("[prefab] dropped instance " + instId + " referencing asset '" + (asset.name || assetId) + "'");
  if (typeof render === "function") render();
  if (typeof renderProps === "function") renderProps();
}

// btn-save-prefab + btn-drop-prefab were moved to the Prefabs browser
// tab (sprint 10d-fix house-keeping); their handlers stay reachable
// via br-prefab-save-sel (palette.js) + card-click drop in the tab.
{
  const _saveBtn = document.getElementById("btn-save-prefab");
  if (_saveBtn) _saveBtn.addEventListener("click", _openPrefabSaveModal);
  const _dropBtn = document.getElementById("btn-drop-prefab");
  if (_dropBtn) _dropBtn.addEventListener("click", _openPrefabPickModal);
}
document.getElementById("pfs-close").addEventListener("click", _closePrefabSaveModal);
document.getElementById("pfs-cancel").addEventListener("click", _closePrefabSaveModal);
document.getElementById("pfs-save").addEventListener("click", _commitPrefabSave);
document.getElementById("pfs-save-idb").addEventListener("click", _commitPrefabSaveToIdb);
document.getElementById("prefab-save-modal").addEventListener("click", (e) => {
  if (e.target.id === "prefab-save-modal") _closePrefabSaveModal();
});
document.getElementById("pfp-close").addEventListener("click", _closePrefabPickModal);
document.getElementById("pfp-cancel").addEventListener("click", _closePrefabPickModal);
document.getElementById("prefab-pick-modal").addEventListener("click", (e) => {
  if (e.target.id === "prefab-pick-modal") _closePrefabPickModal();
});
document.addEventListener("keydown", (e) => {
  const m = document.getElementById("prefab-save-modal");
  if (m && m.style.display !== "none" && e.key === "Escape") _closePrefabSaveModal();
  const m2 = document.getElementById("prefab-pick-modal");
  if (m2 && m2.style.display !== "none" && e.key === "Escape") _closePrefabPickModal();
});


copyBtn.addEventListener("click", () => {
  const which = document.querySelector(".tab.active").dataset.tab;
  const text = which === "code" ? codeOut.innerText : jsonOut.innerText;
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = "Copied";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
  });
});

tabs.forEach(t => {
  t.addEventListener("click", () => {
    tabs.forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    paneProps.style.display = t.dataset.tab === "props" ? "block" : "none";
    paneUdsp.style.display  = t.dataset.tab === "udsp"  ? "grid"  : "none";
    const paneCpEl = document.getElementById("pane-codepreview");
    if (paneCpEl) paneCpEl.style.display = t.dataset.tab === "codepreview" ? "flex" : "none";
    const paneMonEl = document.getElementById("pane-monitor");
    if (paneMonEl) paneMonEl.style.display = t.dataset.tab === "monitor" ? "block" : "none";
    // Copy button only meaningful for the code-preview sub-tabs that
    // show plain text (Generated C++ and JSON). Build pane has its
    // own per-section copy button.
    const cpActive = t.dataset.tab === "codepreview";
    const sub = cpActive ? (document.querySelector(".subtab.active") || {}).dataset?.subtab : null;
    copyBtn.style.display = (cpActive && (sub === "code" || sub === "json")) ? "inline-block" : "none";
    if (cpActive && sub === "build" && typeof renderBuildPane === "function") renderBuildPane();
    // Lazy-fetch the community library on first User DSP tab activation.
    if (t.dataset.tab === "udsp" && !communityCache && !communityLoading) {
      loadCommunityList(false);
    }
    // CodeMirror needs a refresh when its container becomes visible —
    // otherwise gutters/cursor render misaligned until the user clicks.
    if (t.dataset.tab === "udsp" && udspEditor) {
      setTimeout(() => udspEditor.refresh(), 0);
    }
  });
});

/* Sub-tab switching inside the Code preview pane. The three inner panes
 * keep their original IDs (pane-code / pane-json / pane-build), so the
 * existing render functions just keep working. */
function switchCodePreviewSub(sub) {
  document.querySelectorAll("#codepreview-subtabs .subtab").forEach(b => {
    b.classList.toggle("active", b.dataset.subtab === sub);
  });
  const codeEl  = document.getElementById("pane-code");
  const jsonEl  = document.getElementById("pane-json");
  const buildEl = document.getElementById("pane-build");
  if (codeEl)  codeEl.style.display  = sub === "code"  ? "block" : "none";
  if (jsonEl)  jsonEl.style.display  = sub === "json"  ? "block" : "none";
  if (buildEl) buildEl.style.display = sub === "build" ? "block" : "none";
  copyBtn.style.display = (sub === "code" || sub === "json") ? "inline-block" : "none";
  if (sub === "build" && typeof renderBuildPane === "function") renderBuildPane();
}
document.querySelectorAll("#codepreview-subtabs .subtab").forEach(b => {
  b.addEventListener("click", () => switchCodePreviewSub(b.dataset.subtab));
});

