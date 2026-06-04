function renderGroupProps(g) {
  const dot = `background: var(--accent); --prop-dot: var(--accent);`;
  const memberRows = (g.members || []).map(id => {
    const n = nodeById(id);
    if (!n) return "";
    const def = defOf(n);
    const colour = def ? def.color : "var(--text-3)";
    return `<div class="group-member-row">
      <span class="group-member-dot" style="background:${colour}"></span>
      <span class="group-member-type">${escapeText(n.type)}</span>
      <span class="group-member-id">${n.id}</span>
    </div>`;
  }).join("");
  const ports = computeGroupPorts(g);
  const portsHtml = (ports.inputs.length || ports.outputs.length)
    ? `<div class="prop-section">Cross-boundary ports</div>
       <div class="prop-inline" style="opacity:0.75;">
         ${ports.inputs.length} in / ${ports.outputs.length} out — these stub up on the collapsed block so you can wire to/from the group as a whole.
       </div>`
    : "";
  return `
    <div class="prop-head">
      <span class="dot" style="${dot}"></span>
      <span style="font-family: var(--font-instr); letter-spacing: 0.12em;">${g.collapsed ? "⊟" : "▾"} GROUP</span>
      <span class="id">${g.id}</span>
      <span class="desc">${g.collapsed ? "collapsed — double-click block or press E to expand" : "expanded — drag header to move all members"}</span>
    </div>
    <div class="prop-section">Name</div>
    <div class="prop-grid" style="grid-template-columns: 1fr;">
      <input type="text" id="group-name-input" value="${escapeAttr(g.name)}" style="background: var(--surface-2); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 3px; font-family: var(--font-mono); font-size: 12px;" />
    </div>
    <div class="prop-section">View</div>
    <div class="prop-grid" style="grid-template-columns: 1fr 1fr;">
      <button class="btn" id="group-collapse-btn">${g.collapsed ? "Expand (E)" : "Collapse (E)"}</button>
      <button class="btn" id="group-ungroup-btn">Ungroup (Ctrl+Shift+G)</button>
    </div>
    <div class="prop-section">Members · ${(g.members||[]).length} nodes</div>
    <div class="group-member-list">${memberRows}</div>
    ${portsHtml}
    <div class="prop-section">Export</div>
    <div class="prop-grid" style="grid-template-columns: 1fr;">
      <button class="btn primary" id="group-save-gpatch-btn">Save group as .gpatch</button>
      <p class="prop-inline" style="opacity:0.55; font-size:10px;">Writes a standalone .gpatch containing only this group's member nodes + their internal edges. Cross-boundary edges become exposed setters / unconnected ports on the saved patch.</p>
    </div>
  `;
}
function wireGroupPropsHandlers(g) {
  const nameInp = document.getElementById("group-name-input");
  if (nameInp) {
    nameInp.addEventListener("change", () => renameGroup(g.id, nameInp.value));
    nameInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { renameGroup(g.id, nameInp.value); nameInp.blur(); }
    });
  }
  const cbtn = document.getElementById("group-collapse-btn");
  if (cbtn) cbtn.addEventListener("click", () => toggleGroupCollapse(g.id));
  const ubtn = document.getElementById("group-ungroup-btn");
  if (ubtn) ubtn.addEventListener("click", () => ungroupSelection());
  const sbtn = document.getElementById("group-save-gpatch-btn");
  if (sbtn) sbtn.addEventListener("click", () => saveGroupAsGpatch(g));
}

/* Export a group as a standalone .gpatch file. The output contains:
 *   • Only the group's member nodes (positions translated to start
 *     near the origin so the loaded patch isn't off-screen).
 *   • Only the edges that are fully internal to the group (cross-
 *     boundary edges become dangling endpoints — the user wires
 *     them up after importing into another patch).
 *   • A patchName derived from the group name (sanitized to be a
 *     valid C++ identifier so codegen produces a clean class).
 *   • Exposed-setter entries that survive the cut (only those that
 *     reference member nodes). */
function saveGroupAsGpatch(g) {
  if (!g) return;
  const memberSet = new Set(g.members);
  const memberNodes = (g.members || []).map(id => nodeById(id)).filter(Boolean);
  if (!memberNodes.length) { alert("Group has no members — nothing to save."); return; }
  // Translate to origin so the saved patch loads at a sane location.
  let minX = Infinity, minY = Infinity;
  memberNodes.forEach(n => { if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y; });
  const dx = isFinite(minX) ? Math.max(0, minX - 60) : 0;
  const dy = isFinite(minY) ? Math.max(0, minY - 60) : 0;
  const nodes = memberNodes.map(n => ({
    ...JSON.parse(JSON.stringify(n)),  // deep copy so we don't mutate live state
    x: n.x - dx,
    y: n.y - dy
  }));
  // Internal edges only — drop cross-boundary connections.
  const edges = state.edges
    .filter(e => memberSet.has(e.from.node) && memberSet.has(e.to.node))
    .map(e => JSON.parse(JSON.stringify(e)));
  // Restrict exposed-setter map to entries that reference member nodes.
  const exposed = {};
  Object.keys(state.exposed || {}).forEach(k => {
    const id = k.split(".")[0];
    if (memberSet.has(id)) exposed[k] = state.exposed[k];
  });
  const className = (g.name || "Group").replace(/[^A-Za-z0-9_]/g, "_");
  const filename = (g.name || "group").replace(/[^A-Za-z0-9_-]/g, "_") + ".gpatch";
  const out = {
    version: 2,
    patchName: className || "Group",
    nodes, edges, exposed,
    groups: [],   // empty — the group itself becomes the new patch
    filename
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderProps() {
  // Group selection takes precedence — when the user has a group
  // entity selected (clicked the header / collapsed block), the
  // props pane shows group-specific UI: rename, expand/collapse,
  // member list, save-as-.gpatch.
  if (selectedGroupId) {
    const g = groupById(selectedGroupId);
    if (g) {
      empty.style.display = "none";
      propsEl.innerHTML = renderGroupProps(g);
      wireGroupPropsHandlers(g);
      return;
    }
    selectedGroupId = null;  // stale id — fall through to node path
  }
  if (!selected) {
    // Phase 6.5 — when nothing is selected, the props pane shows the
    // RIG editor instead of being empty. Lets users tune their
    // distributed-display layout without first having to create a
    // dummy node to select.
    empty.style.display = "none";
    propsEl.innerHTML = renderRigPane();
    wireRigPaneHandlers();
    return;
  }
  const node = nodeById(selected);
  if (!node) { empty.style.display = "block"; propsEl.innerHTML = ""; return; }
  empty.style.display = "none";
  const def = defOf(node);
  if (!def) {
    propsEl.innerHTML =
      `<div class="prop-head"><span class="dot" style="background:var(--danger);--prop-dot:var(--danger)"></span>` +
      `⚠ ${escapeText(node.type)}<span class="id">${node.id}</span></div>` +
      `<div class="prop-inline">Unknown node type. This usually means a User DSP class was deleted, or the patch was authored against a registry that this build doesn't have. Delete this node or re-register the type.</div>`;
    return;
  }
  const dotStyle = `background:${def.color};--prop-dot:${def.color}`;
  // Phase 8.D.1 -- if a UI/HUD node has customRender code defined,
  // show a small badge in the header so users see it without opening
  // the modal.
  let customBadge = "";
  if (node.params && typeof node.params.customRender === "string" && node.params.customRender.trim()) {
    customBadge = `<span class="prop-render-badge" title="customRender JS code is set -- press E or click the ✎ handle to edit">render code &middot; <code>E</code></span>`;
  }
  let html = `<div class="prop-head"><span class="dot" style="${dotStyle}"></span>${node.type}<span class="id">${node.id}</span>${customBadge}<span class="desc">${escapeText(def.description || "")}</span></div>`;
  // Phase 8.A.2-ui -- Stage assignment. Every node can be tagged
  // into a named stage; nodes without a tag are "_global" (always
  // active). Datalist autocompletes from any StageManager's stages
  // list so users don't have to remember exact names.
  {
    const knownStages = new Set();
    for (const n of state.nodes) {
      if (n && n.type === "StageManager" && n.params && typeof n.params.stages === "string") {
        for (const s of n.params.stages.split(",")) {
          const t = s.trim();
          if (t) knownStages.add(t);
        }
      }
    }
    const stageVal = (typeof node.stage === "string") ? node.stage : "";
    // Compute active status for the dot color.
    let dotColor, dotTitle;
    if (!stageVal) {
      dotColor = "#67c8ff";
      dotTitle = "Untagged -- always active (persists across stage changes)";
    } else {
      const phase = (Visual && Visual.lifecyclePhases) ? Visual.lifecyclePhases[stageVal] : null;
      if (phase === "running" || phase === "awoken") {
        dotColor = "#67ff80";
        dotTitle = "Stage '" + stageVal + "' is ACTIVE (phase=" + phase + ")";
      } else if (phase === "dormant" || phase === "destroying" || phase === "uninitialized") {
        dotColor = "#ff8c50";
        dotTitle = "Stage '" + stageVal + "' is INACTIVE (phase=" + phase + ") -- this node won't tick or render";
      } else {
        dotColor = "#888";
        dotTitle = "Stage '" + stageVal + "' is unknown (no StageManager references it). Treated as INACTIVE.";
      }
    }
    const datalistId = "prop-stages-" + node.id;
    const datalistOpts = Array.from(knownStages).map(s =>
      `<option value="${escapeAttr(s)}"></option>`).join("");
    html += `<div class="prop-stage-row">` +
      `<span class="stage-dot" style="background:${dotColor};" title="${escapeAttr(dotTitle)}"></span>` +
      `<label class="k">stage</label>` +
      `<input type="text" id="prop-stage-input" value="${escapeAttr(stageVal)}" placeholder="(blank = global)" list="${datalistId}" autocomplete="off" />` +
      `<datalist id="${datalistId}">${datalistOpts}</datalist>` +
      `</div>`;
  }
  const keys = Object.keys(node.params);
  const gateIns = def.ins.filter(p => p.t === "gate");

  if (!keys.length && !gateIns.length) {
    html += `<div class="prop-inline">This node has no parameters or triggers — it just passes signal through.</div>`;
  } else {
    if (keys.length) {
      html += `<div class="prop-section">Parameters</div>`;
      html += `<div class="prop-grid">`;
      const uiOnly = def.uiOnlyParams || [];
      keys.forEach(k => {
        // Phase 8.D.1 -- customRender is edited exclusively via the
        // node-edit modal (E key or ✎ handle), so we skip it in the
        // props grid. A badge in the prop-head signals when it's set.
        if (k === "customRender") return;
        const ex = !!state.exposed[node.id + "." + k];
        const enumOpts = def.paramOptions && def.paramOptions[k];
        const isUiOnly = uiOnly.includes(k);
        const isString = typeof node.params[k] === "string";
        // Enum params can't be exposed as runtime float setters — they
        // take a distinct C++ symbol type and are construction-only.
        // ui-only params (Slider min/max, Button label) are not C++ at all.
        const exposable = !!def.cppType && !enumOpts && !isUiOnly && !isString;
        let inputHtml;
        // Phase 6.5 — VisualOutput.display: dynamic dropdown sourced
        // from the live rig.displays list. Updates whenever the user
        // swaps templates or edits the display list. Treated like an
        // enum but the option list is fetched from state.rig instead
        // of the static def.paramOptions.
        const isRigDisplayDropdown = node.type === "VisualOutput" && k === "display";
        if (isRigDisplayDropdown) {
          const displays = (state.rig && state.rig.displays) || [];
          const opts = displays.map((d, i) => {
            const sel = (node.params[k] | 0) === i ? " selected" : "";
            return `<option value="${i}"${sel}>${i}: ${escapeText(d.name || ("Display " + (i + 1)))}</option>`;
          }).join("");
          const placeholder = displays.length === 0
            ? `<option value="0" selected>(no displays — pick a template in rig pane)</option>`
            : "";
          inputHtml = `<select class="enum-select" data-key="${escapeAttr(k)}" data-rig-display="1">${placeholder}${opts}</select>`;
        } else if (enumOpts) {
          const opts = enumOpts.map(o => {
            const sel = node.params[k] === o ? " selected" : "";
            return `<option value="${escapeAttr(o)}"${sel}>${escapeText(o)}</option>`;
          }).join("");
          // For nodes with a "custom" curve / shape option, attach a
          // small ≈ button that opens the ramp/curve modal directly
          // (so the user doesn't have to first pick "custom" + then
          // hunt for the editor — one click and they're drawing).
          const hasCustom = enumOpts.indexOf("custom") >= 0;
          const editBtn = hasCustom
            ? `<button class="ramp-edit-btn" data-ramp-edit="${escapeAttr(k)}" title="Open curve editor">≈</button>`
            : "";
          inputHtml = `<span class="enum-select-wrap"><select class="enum-select" data-key="${escapeAttr(k)}">${opts}</select>${editBtn}</span>`;
        } else if (isString) {
          inputHtml = `<input type="text" value="${escapeAttr(String(node.params[k]))}" data-key="${escapeAttr(k)}" data-string="1" />`;
        } else {
          // HUDText.value et al use NaN as a "use static text" sentinel.
          // type="number" can't bind to NaN -- it logs a "specified value
          // 'NaN' cannot be parsed" warning. Render NaN as empty + a
          // NaN placeholder so the input still communicates the state.
          const vRaw = node.params[k];
          const vAttr = Number.isFinite(vRaw) ? vRaw : "";
          const phAttr = Number.isFinite(vRaw) ? "" : ` placeholder="NaN"`;
          inputHtml = `<input type="number" step="any" value="${vAttr}"${phAttr} data-key="${escapeAttr(k)}" />`;
        }
        const trailing = isRigDisplayDropdown
          ? `<span class="prop-inline">rig display index</span>`
          : exposable
            ? `<label class="expose" title="When checked, the generated class exposes a ${k}(float) setter."><input type="checkbox" data-expose="${escapeAttr(k)}" ${ex?"checked":""} /> expose</label>`
            : enumOpts
              ? `<span class="prop-inline">construction-time</span>`
              : isUiOnly
                ? `<span class="prop-inline">UI only</span>`
                : `<span class="prop-inline">inlined at compile</span>`;
        html += `
          <label class="k">${escapeText(k)}</label>
          ${inputHtml}
          ${trailing}
        `;
      });
      html += `</div>`;
    }
    if (gateIns.length) {
      html += `<div class="prop-section">Triggers</div>`;
      html += `<div class="prop-grid">`;
      gateIns.forEach(p => {
        const ex = !!state.exposed[node.id + "." + p.n];
        const meth = (def.gateMethods && def.gateMethods[p.n]) || "reset";
        const setterName = p.n === "trig" ? "trigger()" : p.n + "()";
        html += `
          <label class="k">${escapeText(p.n)}</label>
          <span class="gate-tag">${escapeText(meth)}()</span>
          <label class="expose" title="When checked, the generated class exposes ${setterName}."><input type="checkbox" data-expose="${escapeAttr(p.n)}" ${ex?"checked":""} /> expose ${escapeText(setterName)}</label>
        `;
      });
      html += `</div>`;
    }
    // Piano-roll: a single button that opens the editor modal.
    // Notes live in node.params.notes; the modal handles all the
    // drawing / saving.
    if (def.kind === "pianoRoll") {
      const noteCount = (Array.isArray(node.params.notes) ? node.params.notes.length : 0);
      const len = (typeof node.params.patternLen === "number") ? node.params.patternLen : 16;
      html += `<div class="prop-section">Pattern</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-pianoroll" style="width: 100%;">Edit piano roll · ${noteCount} note${noteCount===1?"":"s"} · ${len} steps</button>
      </div>`;
    }
    // Multi-track piano roll uses the same modal with track tabs in
    // the toolbar (gated on def.kind === "multiPianoRoll" inside the
    // modal). Notes carry an extra `track` field.
    if (def.kind === "multiPianoRoll") {
      const notes = Array.isArray(node.params.notes) ? node.params.notes : [];
      const counts = [0, 0, 0, 0];
      notes.forEach(n => { if (n && n.track >= 0 && n.track < 4) counts[n.track]++; });
      html += `<div class="prop-section">Pattern · 4 tracks</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-pianoroll" style="width: 100%;">Edit multi-track · ${counts[0]}·${counts[1]}·${counts[2]}·${counts[3]} notes</button>
      </div>`;
    }
    // Matrix-mixer: 8×8 grid of clickable cells. Each cell holds a
    // gain value 0..1 (drag vertically for finer; click toggles). The
    // value also drives the cell's fill intensity for at-a-glance
    // routing legibility.
    // WavetableOsc with shape="custom" gets an "Edit waveform" button
    // that opens the drawable single-cycle editor. Other shape values
    // are algorithmic so they don't need a UI.
    if (def.kind === "wavetable" && node.params && node.params.shape === "custom") {
      const tbl = Array.isArray(node.params.table) ? node.params.table : null;
      const len = tbl ? tbl.length : 0;
      html += `<div class="prop-section">Custom waveform</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-wavetable" style="width: 100%;">Edit waveform${len ? ` · ${len} samples` : ""}</button>
      </div>`;
    }
    // AutomationLane / MultiAutomationLane: open the drawable
    // automation modal. Single-lane has one curveTable; multi-lane
    // has node.params.lanes[] (4 entries). Button label shows a
    // quick stat line so the user sees what they've configured.
    if (def.kind === "autoLane") {
      const tbl = Array.isArray(node.params && node.params.curveTable) ? node.params.curveTable : null;
      const len = tbl ? tbl.length : 0;
      const bars = (typeof node.params.bars === "number") ? node.params.bars : 4;
      const bpm = (typeof node.params.bpm === "number") ? node.params.bpm : 120;
      const looping = node.params && node.params.loop ? "loop" : "one-shot";
      html += `<div class="prop-section">Automation curve</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-autolane" style="width: 100%;">Edit lane${len ? ` · ${bars} bars · ${bpm} BPM · ${looping}` : ""}</button>
      </div>`;
    }
    if (def.kind === "multiAutoLane") {
      const lanes = Array.isArray(node.params && node.params.lanes) ? node.params.lanes : [];
      const bars = (typeof node.params.bars === "number") ? node.params.bars : 4;
      const bpm = (typeof node.params.bpm === "number") ? node.params.bpm : 120;
      const looping = node.params && node.params.loop ? "loop" : "one-shot";
      const filledLanes = lanes.filter(l => l && Array.isArray(l.curveTable) && l.curveTable.length).length;
      html += `<div class="prop-section">Automation lanes · 4 tracks</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-autolane" style="width: 100%;">Edit lanes${filledLanes ? ` · ${filledLanes}/4 drawn · ${bars} bars · ${bpm} BPM · ${looping}` : ""}</button>
      </div>`;
    }
    // EnvDraw: drawable ADSR with movable sustain marker. The button
    // shows a quick stat (current sustain index + attack/release
    // times) so the user knows what they've set without opening it.
    if (def.kind === "envDraw") {
      const tbl = Array.isArray(node.params && node.params.curveTable) ? node.params.curveTable : null;
      const sIdx = (node.params && typeof node.params.sustainIdx === "number") ? node.params.sustainIdx : 32;
      const len = tbl ? tbl.length : 0;
      const aT = (node.params && typeof node.params.attack === "number") ? node.params.attack.toFixed(2) : "0.50";
      const rT = (node.params && typeof node.params.release === "number") ? node.params.release.toFixed(2) : "0.50";
      html += `<div class="prop-section">Envelope shape</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-envdraw" style="width: 100%;">Edit envelope${len ? ` · sustain ${sIdx}/${len-1} · A ${aT}s · R ${rT}s` : ""}</button>
      </div>`;
    }
    // v0.3.29 — ColorCurves: 4-channel paint-drawable LUT editor.
    // Summary line shows which channels have been touched (not identity).
    if (node.type === "ColorCurves") {
      const N = 64;
      const isIdentity = (arr) => {
        if (!Array.isArray(arr) || arr.length !== N) return true;
        for (let i = 0; i < N; i++) {
          if (Math.abs(arr[i] - i / (N - 1)) > 0.002) return false;
        }
        return true;
      };
      const labels = ["M", "R", "G", "B"];
      const keys   = ["curveMaster", "curveR", "curveG", "curveB"];
      const touched = keys.map((k, i) => isIdentity(node.params && node.params[k]) ? null : labels[i]).filter(Boolean);
      const summary = touched.length ? "edited: " + touched.join(" · ") : "identity (no grade)";
      html += `<div class="prop-section">Color curves</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-colorcurves" style="width: 100%;">Edit curves… · ${summary}</button>
      </div>`;
    }
    // WavetableScan: button opens the 3D stacked-frames modal. Custom-
    // frame count is shown so the user knows whether they've overridden
    // any of the algorithmic bank's defaults.
    if (def.kind === "wavetableScan") {
      const cf = (node.params && node.params.customFrames && typeof node.params.customFrames === "object") ? node.params.customFrames : {};
      const overrides = Object.keys(cf).length;
      html += `<div class="prop-section">Wavetable bank · 512 frames</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-open-wavescan" style="width: 100%;">Edit wavetable bank${overrides ? ` · ${overrides} custom frame${overrides === 1 ? "" : "s"}` : ""}</button>
      </div>`;
    }
    // Sample-host nodes (SamplePlayer / StereoSamplePlayer / Granular):
    // file-drop button, current-asset readout, "Load" + "Clear" buttons.
    // Files are decoded via decodeAudioData and stored in editor.assets;
    // node.params.assetId references the loaded record.
    if (def.kind === "sampleHost") {
      const a = getAsset(node.params && node.params.assetId);
      html += `<div class="prop-section">Sample asset</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">`;
      if (a) {
        const ch = a.channels >= 2 ? "stereo" : "mono";
        const samp = Array.isArray(a.data) ? a.data[0].length : a.data.length;
        const tooBig = samp > ASSET_EMBED_LIMIT;
        const sizeNote = tooBig
          ? `<span class="asset-warn" title="Too large to embed in codegen — fine for live preview but exporting will need runtime sample loading">stem-sized · v2 export</span>`
          : ``;
        html += `<div class="asset-card">
          <div class="asset-card-head">
            <span class="asset-card-name" title="${escapeAttr(a.name)}">${escapeText(a.name)}</span>
            ${sizeNote}
          </div>
          <div class="asset-card-meta">${a.durationSec.toFixed(2)} s · ${a.sampleRate} Hz · ${ch} · ${samp.toLocaleString()} samples</div>
          <div class="asset-card-row">
            <button class="btn pr-btn pr-btn-primary" data-asset-action="open">EDIT WAVEFORM</button>
            <button class="btn pr-btn" data-asset-action="load">REPLACE…</button>
            <button class="btn pr-btn" data-asset-action="clear">CLEAR</button>
          </div>
        </div>`;
      } else {
        html += `<button class="btn primary" data-asset-action="open" style="width: 100%;">Open sample editor</button>`;
        html += `<p class="prop-inline">Drag a .wav / .mp3 / .ogg / .flac into the editor — or click the button above and drop in there. Files persist to IndexedDB. Up to ~5s embeds in codegen; longer stems need runtime loading on export.</p>`;
      }
      html += `</div>`;
    }
    // MicInput: permission button + status line. Live preview wires
    // the MediaStream into the AudioWorklet automatically when Play
    // is clicked on a patch containing MicInput; clicking Enable here
    // pre-grants the permission so there's no first-tick delay.
    if (def.kind === "micInput") {
      const granted = !!_micStream;
      const statusLine = granted
        ? `Granted ✓ · ${escapeText(_micDeviceLabel || "default device")}`
        : `Not yet enabled — click ▶ Play to auto-prompt, or grant ahead of time below.`;
      const selectedDevice = (node.params && node.params.inputSourceId) || "";
      // Build a device dropdown from the previously-enumerated list.
      // The list itself is populated lazily on first mic grant (see
      // ensureMicConnected); until then we just show "default device".
      let deviceOptions = `<option value="">default device</option>`;
      if (Array.isArray(_micDeviceList) && _micDeviceList.length) {
        _micDeviceList.forEach(d => {
          const sel = (d.deviceId === selectedDevice) ? " selected" : "";
          deviceOptions += `<option value="${escapeAttr(d.deviceId)}"${sel}>${escapeText(d.label || ("device " + d.deviceId.slice(0, 8)))}</option>`;
        });
      }
      html += `<div class="prop-section">Microphone</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">
        <button class="btn primary" id="btn-enable-mic" style="width: 100%;">${granted ? "Re-check device" : "Enable microphone"}</button>
        <p class="prop-inline" id="mic-status-${node.id}">${statusLine}</p>
        <label class="prop-inline" style="display:flex; gap:8px; align-items:center;">
          <span style="opacity:0.7; min-width: 80px;">Input source</span>
          <select id="mic-source-${node.id}" style="flex:1; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); padding: 4px 6px; border-radius: 3px;">${deviceOptions}</select>
        </label>
        <p class="prop-inline" style="opacity: 0.55; font-size: 10px;">Picks a specific input device on multi-mic systems. Takes effect on next ▶ Play. The device list populates after the first permission grant — click "Enable microphone" once to populate.</p>
      </div>`;
    }
    // VoiceTrigger / KeywordSpotter: trigger-word recording UI.
    // Captures 1.5-second mic snippets into node.params.triggerSamples.
    // Storage is in-memory + serialized into the .gpatch JSON.
    // VoiceTrigger uses energy gate at runtime; KeywordSpotter
    // additionally runs JS-side amplitude-envelope template
    // matching against the recordings (computed at preview start).
    if (def.kind === "voiceTrigger" || def.kind === "keywordSpotter") {
      const isSpotter = def.kind === "keywordSpotter";
      const recs = Array.isArray(node.params && node.params.triggerSamples) ? node.params.triggerSamples : [];
      html += `<div class="prop-section">Trigger word recordings</div>`;
      html += `<div class="prop-grid" style="grid-template-columns: 1fr;">`;
      if (recs.length) {
        html += `<div class="vt-rec-list" style="display:flex; flex-direction:column; gap:4px;">`;
        recs.forEach((r, i) => {
          html += `<div class="vt-rec-row" style="display:grid; grid-template-columns: 22px 1fr auto auto; gap:8px; align-items:center; padding:4px 8px; background:var(--surface-2); border:1px solid var(--border); border-radius:3px;">
            <span style="text-align:center; color:var(--text-3); font-family:var(--font-mono); font-size:10px;">${i + 1}</span>
            <span style="font-family:var(--font-mono); font-size:11px; color:var(--text);">${escapeText(r.name || "rec_" + (i+1))}</span>
            <span style="font-family:var(--font-mono); font-size:9.5px; color:var(--text-3);">${(r.durationSec || 0).toFixed(2)} s</span>
            <button class="btn" data-vt-del="${i}" title="Delete this recording" style="padding: 2px 8px; font-size: 10px;">×</button>
          </div>`;
        });
        html += `</div>`;
      } else {
        html += `<p class="prop-inline" style="opacity: 0.6; font-style: italic;">No recordings yet. Record 3–5 takes of the trigger word for best detection.</p>`;
      }
      html += `<button class="btn primary" id="btn-vt-record" style="width:100%;">⏺ Record trigger word (1.5 s)</button>`;
      // KeywordSpotter-only: detect-mode dropdown + match-threshold
      // slider + live status pill.
      if (isSpotter) {
        const mt = (typeof node.params.matchThreshold === "number") ? node.params.matchThreshold : 0.85;
        const mode = (typeof node.params.detectMode === "string") ? node.params.detectMode : "envelope";
        html += `<label class="prop-inline" style="display:flex; gap:8px; align-items:center; margin-top: 4px;">
          <span style="opacity:0.7; min-width: 110px;">Detect mode</span>
          <select id="ks-mode-${node.id}" style="flex:1; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); padding: 4px 6px; border-radius: 3px; font-family: var(--font-mono); font-size: 11px;">
            <option value="envelope"${mode === "envelope" ? " selected" : ""}>envelope · fast, no model</option>
            <option value="whisper"${mode === "whisper" ? " selected" : ""}>whisper · phoneme-aware (~75 MB)</option>
            <option value="hybrid"${mode === "hybrid" ? " selected" : ""}>hybrid · envelope + whisper confirm</option>
          </select>
        </label>`;
        html += `<label class="prop-inline" style="display:flex; gap:8px; align-items:center; margin-top: 4px;">
          <span style="opacity:0.7; min-width: 110px;">Match threshold</span>
          <input type="range" id="ks-thresh-${node.id}" min="0.5" max="0.99" step="0.01" value="${mt}" style="flex:1;" />
          <span id="ks-thresh-val-${node.id}" style="font-family:var(--font-mono); font-size:11px; color:var(--phosphor); width:42px; text-align:right;">${mt.toFixed(2)}</span>
        </label>`;
        html += `<p class="prop-inline" style="opacity: 0.55; font-size: 10px; margin-top: 2px;">In <strong>envelope</strong> mode: cosine similarity of 16-point amplitude-envelope fingerprints (loudness-invariant; can't distinguish phonemes). In <strong>whisper</strong> mode: Whisper-tiny transcribes the live audio and the threshold becomes a fuzzy-string match score (1.0 = template fully contained in transcript). <strong>Hybrid</strong> uses envelope for the fast path and whisper as a confirm/cancel filter — best of both at the cost of model download.</p>`;
        const liveStatusId = `ks-status-${node.id}`;
        html += `<p class="prop-inline" id="${liveStatusId}" style="font-family:var(--font-mono); font-size:10px; color:var(--text-3); margin-top: 4px;">Detector: ${recs.length ? `${recs.length} template${recs.length===1?"":"s"} loaded · ` : ""}${(typeof previewState !== "undefined" && previewState.state === "playing") ? "running" : "idle (start preview to enable)"}</p>`;
      } else {
        html += `<p class="prop-inline" style="opacity: 0.55; font-size: 10px;">Recordings are stored per-node and saved with the .gpatch. Today's runtime fires .trig from the energy gate above. For ML keyword detection, swap this node for a <strong>KeywordSpotter</strong> — same recording UI plus live envelope-matching against the templates while preview is playing.</p>`;
      }
      html += `</div>`;
    }
    if (def.kind === "patchMatrix") {
      if (!Array.isArray(node.params.matrix) || node.params.matrix.length !== 8) {
        node.params.matrix = Array.from({ length: 8 }, () => new Array(8).fill(0));
      }
      const m = node.params.matrix;
      // Count active routes for the section label
      let active = 0;
      m.forEach(row => row.forEach(v => { if (v > 0) active++; }));
      html += `<div class="prop-section">Matrix · ${active} active route${active === 1 ? "" : "s"}</div>`;
      html += `<div class="patch-matrix-wrap">`;
      // Header row: in1..in8 across the top
      html += `<div class="pm-corner">in ↓ / out →</div>`;
      for (let j = 0; j < 8; j++) {
        html += `<div class="pm-col-head">o${j + 1}</div>`;
      }
      for (let i = 0; i < 8; i++) {
        html += `<div class="pm-row-head">i${i + 1}</div>`;
        for (let j = 0; j < 8; j++) {
          const g = Number(m[i][j]) || 0;
          const lvl = Math.max(0, Math.min(1, Math.abs(g)));
          const cls = "pm-cell" + (g > 0 ? " on" : (g < 0 ? " inv" : ""));
          html += `<div class="${cls}" data-i="${i}" data-j="${j}" style="--lvl: ${lvl.toFixed(3)}" title="i${i+1} → o${j+1} · gain ${g.toFixed(2)}"></div>`;
        }
      }
      html += `</div>`;
      html += `<p class="prop-inline">Click toggles 0 ↔ 1. Vertical drag adjusts gain (0..1). Shift-click inverts (-1).</p>`;
    }
    // Step-grid UI for sequencer nodes — N small clickable cells
    // mirroring node.params.steps (boolean array). Click to toggle.
    if (def.kind === "stepSeq") {
      const N = def.stepCount || 16;
      if (!Array.isArray(node.params.steps) || node.params.steps.length !== N) {
        node.params.steps = new Array(N).fill(false);
      }
      const steps = node.params.steps;
      html += `<div class="prop-section">Pattern · ${N} steps</div>`;
      html += `<div class="step-grid step-grid-${N}">`;
      for (let i = 0; i < N; i++) {
        const on = !!steps[i];
        html += `<button class="step-cell${on ? ' on' : ''}" data-step="${i}" title="step ${i+1}">${i+1}</button>`;
      }
      html += `</div>`;
    }
  }
  // v0.3.11 — VideoFile pick-file button. Renders inline in the
  // props panel; clicking opens an OS file picker; selection makes
  // a blob URL + assigns to params.fileUrl. The text input above
  // (the standard string-param renderer) still works for pasting
  // http(s) URLs directly.
  if (node.type === "VideoFile") {
    const curUrl = (node.params && node.params.fileUrl) || "";
    const summary = curUrl
      ? (curUrl.startsWith("blob:")
          ? "Local file loaded (blob URL — session-only)"
          : "URL: " + escapeText(curUrl.length > 60 ? curUrl.slice(0, 57) + "…" : curUrl))
      : "No file picked yet. Click below to browse or paste a URL above.";
    const paused = !!(node.params && node.params.paused);
    const rate = (node.params && typeof node.params.playbackRate === "number")
      ? node.params.playbackRate : 1.0;
    html += `<div class="prop-section">Video source</div>
             <div class="prop-inline" style="margin-bottom:8px;color:var(--text-2);font-size:11px;">${summary}</div>
             <button class="btn primary" id="btn-videofile-pick" style="width:100%;">📁 Pick video file…</button>`;
    // v0.3.15 — transport controls. Direct buttons that manipulate
    // the underlying HTMLVideoElement via _videoSources.get(node.id).
    // params.paused + params.playbackRate persist with the patch so
    // a saved-then-reopened patch resumes in the user's chosen state.
    html += `<div class="prop-section" style="margin-top:14px;">Transport</div>
             <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:6px;">
               <button class="btn" id="btn-videofile-stop"    title="Stop &amp; rewind to 0">⏮</button>
               <button class="btn" id="btn-videofile-back"    title="Skip back 5 s">⏪</button>
               <button class="btn primary" id="btn-videofile-playpause" title="Play / Pause (space)">${paused ? "▶" : "⏸"}</button>
               <button class="btn" id="btn-videofile-forward" title="Skip forward 5 s">⏩</button>
               <button class="btn" id="btn-videofile-end"     title="Jump to end">⏭</button>
             </div>
             <div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-family:var(--font-mono);font-size:11px;color:var(--text-2);">
               <span style="min-width:48px;">rate ${rate.toFixed(2)}×</span>
               <input id="videofile-rate" type="range" min="0.10" max="4.00" step="0.05" value="${rate}" style="flex:1;" />
             </div>
             <div style="display:flex;gap:4px;margin-top:6px;">
               <button class="btn" data-vf-rate="0.25" title="0.25×" style="flex:1;font-size:10px;">¼×</button>
               <button class="btn" data-vf-rate="0.5"  title="0.5×"  style="flex:1;font-size:10px;">½×</button>
               <button class="btn" data-vf-rate="1.0"  title="1×"    style="flex:1;font-size:10px;">1×</button>
               <button class="btn" data-vf-rate="2.0"  title="2×"    style="flex:1;font-size:10px;">2×</button>
               <button class="btn" data-vf-rate="4.0"  title="4×"    style="flex:1;font-size:10px;">4×</button>
             </div>`;
    // v0.3.19 — audio section. Two paths:
    //   1. No audio wires from this node → direct playback (MES →
    //      GainNode → ctx.destination). audioEnabled gates, volume
    //      scales. Until the user hits ▶ Play, audio plays via the
    //      videoEl directly (no Web Audio context yet).
    //   2. Audio wires exist → patch is the audio path. Direct
    //      playback muted; outL/outR feed the wire-routed processing.
    //      audioEnabled/volume become moot for direct, but volume is
    //      preserved for when the user removes the wire.
    const audioOn = !node.params || node.params.audioEnabled !== 0;
    const vol = (node.params && typeof node.params.volume === "number")
      ? node.params.volume : 1.0;
    const hasAudioWire = (typeof state !== "undefined" && state &&
      Array.isArray(state.edges) && state.edges.some(e =>
        e && e.from && e.from.node === node.id &&
        (e.from.port === "outL" || e.from.port === "outR")));
    const statusHint = hasAudioWire
      ? `<span style="font-weight:normal;font-size:10px;color:var(--accent-2,#a07cff);opacity:0.95;">(patch-routed via outL/outR — direct playback muted)</span>`
      : `<span style="font-weight:normal;font-size:10px;color:var(--text-2);opacity:0.7;">(direct to speakers — wire outL/outR to route through patch)</span>`;
    html += `<div class="prop-section" style="margin-top:14px;">Audio ${statusHint}
             </div>
             <div style="display:flex;align-items:center;gap:8px;">
               <button class="btn ${audioOn ? "primary" : ""}" id="btn-videofile-mute"
                       title="Toggle direct audio playback (ignored when patch-routed)" style="min-width:48px;"
                       ${hasAudioWire ? "disabled" : ""}>${audioOn ? "🔊 on" : "🔇 off"}</button>
               <input id="videofile-volume" type="range" min="0" max="1" step="0.01" value="${vol}"
                      style="flex:1;" ${(audioOn && !hasAudioWire) ? "" : "disabled"} />
               <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-2);min-width:32px;text-align:right;">${Math.round(vol * 100)}%</span>
             </div>
             <div style="margin-top:6px;font-size:10px;color:var(--text-2);opacity:0.6;line-height:1.4;">
               Wire MasterClock.bar/.beat → <code>trig</code> to retrigger the clip from 0 on every pulse.
               outL/outR carry the file's stereo audio (sample-accurate, ~3 ms quantum) — pipe through any Gamma audio node.
             </div>`;
  }
  // v0.3.22 — ScreenShare props panel. Mirrors the VideoFile pattern
  // (pick button + status line + audio toggle) but with a "Stop"
  // button replacing transport controls (live stream -- no scrubbing).
  // The pick button is the user gesture that lets getDisplayMedia()
  // open the source picker; we can't auto-init from the render loop.
  if (node.type === "ScreenShare") {
    const entry = _videoSources.get(node.id);
    const isActive = !!(entry && entry.videoEl && entry.ready);
    const audioTracks = isActive && entry.stream ? entry.stream.getAudioTracks().length : 0;
    const summary = isActive
      ? `Sharing ${entry.videoEl.videoWidth || "?"}×${entry.videoEl.videoHeight || "?"}` +
        (audioTracks ? " (with system audio)" : " (video only — re-pick + check 'Share audio' in the dialog for sound)")
      : "Not sharing. Click below to pick a screen / window / browser tab.";
    const audioOn = !node.params || node.params.audioEnabled !== 0;
    const hasAudioWire = (typeof state !== "undefined" && state &&
      Array.isArray(state.edges) && state.edges.some(e =>
        e && e.from && e.from.node === node.id &&
        (e.from.port === "outL" || e.from.port === "outR")));
    html += `<div class="prop-section">Screen source</div>
             <div class="prop-inline" style="margin-bottom:8px;color:var(--text-2);font-size:11px;">${escapeText(summary)}</div>
             <button class="btn primary" id="btn-screenshare-pick" style="width:100%;">${isActive ? "🔄 Re-pick source…" : "📺 Pick screen / window / tab…"}</button>`;
    if (isActive) {
      html += `<button class="btn" id="btn-screenshare-stop" style="width:100%;margin-top:6px;">⏹ Stop sharing</button>`;
    }
    html += `<div class="prop-section" style="margin-top:14px;">Audio
               ${hasAudioWire
                 ? `<span style="font-weight:normal;font-size:10px;color:var(--accent-2,#a07cff);opacity:0.95;">(patch-routed via outL/outR)</span>`
                 : `<span style="font-weight:normal;font-size:10px;color:var(--text-2);opacity:0.7;">(request system audio; wire outL/outR to route through patch)</span>`}
             </div>
             <div style="display:flex;align-items:center;gap:8px;">
               <button class="btn ${audioOn ? "primary" : ""}" id="btn-screenshare-audio"
                       title="Request system audio on the next 'Pick source' (browser may still refuse for full-screen shares)" style="min-width:48px;">${audioOn ? "🔊 request" : "🔇 video only"}</button>
               <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-2);flex:1;line-height:1.3;">
                 ${audioTracks > 0 ? "✓ audio track live" : (isActive ? "no audio in current share" : "next pick will request system audio")}
               </span>
             </div>
             <div style="margin-top:6px;font-size:10px;color:var(--text-2);opacity:0.6;line-height:1.4;">
               Chrome / Edge on Windows show a "Share audio" checkbox when sharing a <em>tab</em> or <em>window</em>. Full-screen shares typically can't capture audio. Toggling the request flag mid-share has no effect — re-pick to apply.
             </div>`;
  }
  propsEl.innerHTML = html;

  // Phase 8.A.2-ui -- stage input. Blur or Enter commits; trims
  // whitespace; empty value clears the tag (back to _global).
  const stageInput = propsEl.querySelector("#prop-stage-input");
  if (stageInput) {
    const commitStage = () => {
      const raw = stageInput.value;
      const trimmed = (typeof raw === "string") ? raw.trim() : "";
      const current = (typeof node.stage === "string") ? node.stage : "";
      if (trimmed === current) return;
      pushHistory("stage:" + node.id + "->" + (trimmed || "_global"));
      if (trimmed) node.stage = trimmed;
      else delete node.stage;
      // Re-render the canvas (mesh filtering may have shifted) +
      // re-render props so the active-status dot updates.
      if (typeof render === "function") render();
      renderProps();
    };
    stageInput.addEventListener("blur", commitStage);
    stageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); stageInput.blur(); }
      else if (e.key === "Escape") { stageInput.value = (typeof node.stage === "string") ? node.stage : ""; stageInput.blur(); }
    });
  }

  // v0.3.15 — VideoFile transport-button wiring. Direct manipulation
  // of the underlying HTMLVideoElement (via _videoSources lookup).
  // params.paused / params.playbackRate persist in the patch; the
  // currentTime nudges are transient (browser tracks them).
  if (node.type === "VideoFile") {
    const getVideoEl = () => {
      const src = _videoSources.get(node.id);
      return src && src.videoEl;
    };
    const applyPaused = (paused) => {
      if (!node.params) node.params = {};
      node.params.paused = paused ? 1 : 0;
      const v = getVideoEl();
      if (v) { if (paused) { try { v.pause(); } catch (_) {} } else { try { v.play(); } catch (_) {} } }
      // Re-render to flip the ▶/⏸ button glyph + persist.
      renderProps();
    };
    const applyRate = (rate) => {
      rate = Math.max(0.10, Math.min(4.0, Number(rate) || 1.0));
      if (!node.params) node.params = {};
      node.params.playbackRate = rate;
      const v = getVideoEl();
      if (v) { try { v.playbackRate = rate; } catch (_) {} }
      renderProps();
    };
    const ppBtn   = propsEl.querySelector('#btn-videofile-playpause');
    const stopBtn = propsEl.querySelector('#btn-videofile-stop');
    const backBtn = propsEl.querySelector('#btn-videofile-back');
    const fwdBtn  = propsEl.querySelector('#btn-videofile-forward');
    const endBtn  = propsEl.querySelector('#btn-videofile-end');
    const rateSlider = propsEl.querySelector('#videofile-rate');
    if (ppBtn) ppBtn.addEventListener('click', () => {
      applyPaused(!(node.params && node.params.paused));
    });
    if (stopBtn) stopBtn.addEventListener('click', () => {
      const v = getVideoEl();
      if (v) { try { v.currentTime = 0; } catch (_) {} }
      applyPaused(true);
    });
    if (backBtn) backBtn.addEventListener('click', () => {
      const v = getVideoEl();
      if (v) { try { v.currentTime = Math.max(0, (v.currentTime || 0) - 5); } catch (_) {} }
    });
    if (fwdBtn) fwdBtn.addEventListener('click', () => {
      const v = getVideoEl();
      if (v) {
        try { v.currentTime = Math.min(v.duration || Infinity, (v.currentTime || 0) + 5); } catch (_) {}
      }
    });
    if (endBtn) endBtn.addEventListener('click', () => {
      const v = getVideoEl();
      if (v && Number.isFinite(v.duration)) {
        // Subtract a tiny epsilon so loop kicks in cleanly instead of
        // sticking at exactly duration.
        try { v.currentTime = Math.max(0, v.duration - 0.05); } catch (_) {}
      }
    });
    if (rateSlider) rateSlider.addEventListener('input', () => {
      applyRate(rateSlider.value);
    });
    propsEl.querySelectorAll('[data-vf-rate]').forEach(b => {
      b.addEventListener('click', () => {
        applyRate(b.getAttribute('data-vf-rate'));
      });
    });
    // v0.3.16 — audio toggle + volume slider wiring.
    // v0.3.19 — when the patch is playing AND a MediaElementSource
    // has been created (via ensureVideoAudioConnected), audio plays
    // through Web Audio (MES → GainNode → ctx.destination). We
    // update the GainNode via _updateVideoAudioGains. Fall back to
    // direct videoEl.muted/volume when MES doesn't exist yet (no
    // audioCtx — patch hasn't been played).
    const applyMute = (audioOn) => {
      if (!node.params) node.params = {};
      node.params.audioEnabled = audioOn ? 1 : 0;
      const src = _videoSources.get(node.id);
      if (src && src._mediaSource && typeof _updateVideoAudioGains === "function") {
        _updateVideoAudioGains();
      } else {
        const v = getVideoEl();
        if (v) { try { v.muted = !audioOn; } catch (_) {} }
      }
      renderProps();
    };
    const applyVolume = (vol) => {
      vol = Math.max(0, Math.min(1, Number(vol) || 0));
      if (!node.params) node.params = {};
      node.params.volume = vol;
      const src = _videoSources.get(node.id);
      if (src && src._mediaSource && typeof _updateVideoAudioGains === "function") {
        _updateVideoAudioGains();
      } else {
        const v = getVideoEl();
        if (v) { try { v.volume = vol; } catch (_) {} }
      }
      // No renderProps() here -- the slider drag would lose focus on
      // every input event. The displayed % only refreshes when the
      // user releases the slider (via 'change' event below).
    };
    const muteBtn = propsEl.querySelector('#btn-videofile-mute');
    const volSlider = propsEl.querySelector('#videofile-volume');
    if (muteBtn) muteBtn.addEventListener('click', () => {
      const audioOn = !(node.params && node.params.audioEnabled !== 0);
      applyMute(audioOn);
    });
    if (volSlider) {
      volSlider.addEventListener('input', () => applyVolume(volSlider.value));
      volSlider.addEventListener('change', () => renderProps());
    }
  }

  // VideoFile pick-button wiring.
  const pickBtn = propsEl.querySelector('#btn-videofile-pick');
  if (pickBtn && node.type === "VideoFile") {
    pickBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        // Revoke any previous blob URL so we don't leak.
        const oldUrl = node.params && node.params.fileUrl;
        if (oldUrl && oldUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(oldUrl); } catch (_) {}
        }
        const url = URL.createObjectURL(file);
        if (!node.params) node.params = {};
        node.params.fileUrl = url;
        // Re-render props to reflect the new URL summary + nudge the
        // render loop to re-init the VideoFile node with the new src.
        pushHistory("videofile-pick:" + node.id);
        _disposeVideoSource(node.id);
        renderProps();
        render();
      });
      input.click();
    });
  }

  // v0.3.22 — ScreenShare button wiring. The pick handler is the
  // user-gesture frame that getDisplayMedia() requires; the stop
  // handler tears down the stream without rebuilding. Audio-request
  // toggle just flips the param for the NEXT pick (you can't change
  // the audio constraint on an active stream).
  if (node.type === "ScreenShare") {
    const ssPick = propsEl.querySelector('#btn-screenshare-pick');
    if (ssPick) ssPick.addEventListener('click', async () => {
      _disposeVideoSource(node.id);
      try {
        await _ensureScreenShareStream(node.id);
      } catch (e) {
        console.warn("[screenshare] pick failed:", e);
      }
      pushHistory("screenshare-pick:" + node.id);
      renderProps();
      render();
    });
    const ssStop = propsEl.querySelector('#btn-screenshare-stop');
    if (ssStop) ssStop.addEventListener('click', () => {
      _disposeVideoSource(node.id);
      pushHistory("screenshare-stop:" + node.id);
      renderProps();
      render();
    });
    const ssAudio = propsEl.querySelector('#btn-screenshare-audio');
    if (ssAudio) ssAudio.addEventListener('click', () => {
      if (!node.params) node.params = {};
      node.params.audioEnabled = (node.params.audioEnabled === 0) ? 1 : 0;
      renderProps();
    });
  }

  // Wire the "Edit piano roll" button (PianoRoll AND MultiPianoRoll
  // both use #btn-open-pianoroll → the modal detects which one via
  // the node's def.kind and shows track tabs accordingly).
  const openPianoRollBtn = propsEl.querySelector('#btn-open-pianoroll');
  if (openPianoRollBtn) openPianoRollBtn.addEventListener('click', () => openPianoRollModal(node.id));

  // Wavetable editors — `Edit waveform` opens the single-cycle drawing
  // modal; `Edit wavetable bank` opens the 3D 512-frame view (which
  // can in turn drill into the same single-cycle modal for per-frame
  // editing).
  const openWtBtn = propsEl.querySelector('#btn-open-wavetable');
  if (openWtBtn) openWtBtn.addEventListener('click', () => openWavetableEditModal({ nodeId: node.id, mode: "single" }));
  const openWsBtn = propsEl.querySelector('#btn-open-wavescan');
  if (openWsBtn) openWsBtn.addEventListener('click', () => openWavescanModal(node.id));
  // EnvDraw — drawable ADSR modal.
  const openEnvBtn = propsEl.querySelector('#btn-open-envdraw');
  if (openEnvBtn) openEnvBtn.addEventListener('click', () => openEnvDrawModal(node.id));
  // AutomationLane / MultiAutomationLane — drawable automation modal.
  const openAutoLaneBtn = propsEl.querySelector('#btn-open-autolane');
  if (openAutoLaneBtn) openAutoLaneBtn.addEventListener('click', () => openAutoLaneModal(node.id));
  // v0.3.28 — ColorCurves: per-channel 16-point LUT editor.
  const openCcBtn = propsEl.querySelector('#btn-open-colorcurves');
  if (openCcBtn) openCcBtn.addEventListener('click', () => openColorCurvesModal(node.id));

  // Sample-host action buttons — load opens a file picker, open
  // launches the waveform editor modal, clear detaches the asset
  // (does NOT delete the asset record from IDB so other nodes
  // referencing it still work).
  propsEl.querySelectorAll('[data-asset-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.assetAction;
      if (action === "open") {
        openSampleModal(node.id);
        return;
      }
      if (action === "clear") {
        pushHistory("asset:clear:" + node.id);
        node.params.assetId = "";
        renderProps(); renderCode(); renderJson();
        return;
      }
      // "load" — file picker → decode → store → attach
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a";
      inp.addEventListener("change", async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        btn.textContent = "DECODING…";
        try {
          const rec = await loadAudioFileToAsset(f);
          pushHistory("asset:load:" + node.id);
          node.params.assetId = rec.id;
          renderProps(); renderCode(); renderJson();
        } catch (e) {
          alert("Audio decode failed: " + (e && e.message || e));
          renderProps();
        }
      });
      inp.click();
    });
  });

  // Mic enable — request permission + hold the MediaStream so the
  // worklet (when v2 lands) can pick it up. Stream is reused across
  // multiple MicInput nodes — only one grant per session.
  const enableMicBtn = propsEl.querySelector('#btn-enable-mic');
  if (enableMicBtn) enableMicBtn.addEventListener('click', async () => {
    if (_micStream) {
      // Already granted — re-enumerate the device list (browsers
      // only return labels once the user has granted permission).
      await refreshMicDeviceList();
      renderProps();
      return;
    }
    try {
      enableMicBtn.textContent = "REQUESTING…";
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _micStream = stream;
      const tracks = stream.getAudioTracks();
      _micDeviceLabel = tracks.length ? tracks[0].label : "default";
      await refreshMicDeviceList();
      renderProps();
    } catch (err) {
      enableMicBtn.textContent = "Enable microphone";
      alert("Microphone access denied: " + (err && err.message || err));
    }
  });
  // Per-node device-source dropdown (MicInput). Stores deviceId on
  // the node; takes effect on next ▶ Play (we don't hot-swap the
  // active stream — that'd require re-creating the worklet source).
  const micSrcSel = propsEl.querySelector('#mic-source-' + node.id);
  if (micSrcSel) micSrcSel.addEventListener('change', () => {
    pushHistory("mic-source:" + node.id);
    if (!node.params) node.params = {};
    node.params.inputSourceId = micSrcSel.value || "";
  });
  // VoiceTrigger / KeywordSpotter record button + delete buttons.
  const vtRecBtn = propsEl.querySelector('#btn-vt-record');
  if (vtRecBtn) vtRecBtn.addEventListener('click', () => recordVoiceTriggerSample(node));
  propsEl.querySelectorAll('[data-vt-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.vtDel, 10);
      if (!Array.isArray(node.params.triggerSamples)) return;
      pushHistory("vt-del:" + node.id);
      node.params.triggerSamples.splice(idx, 1);
      // If the spotter is currently running, refresh its templates
      // so the deleted recording stops being a match candidate.
      if (typeof refreshKeywordSpotterTemplates === "function") refreshKeywordSpotterTemplates(node.id);
      renderProps(); renderJson();
    });
  });
  // KeywordSpotter match-threshold slider — live update.
  const ksThresh = propsEl.querySelector('#ks-thresh-' + node.id);
  const ksThreshVal = propsEl.querySelector('#ks-thresh-val-' + node.id);
  if (ksThresh) {
    ksThresh.addEventListener('input', () => {
      const v = parseFloat(ksThresh.value);
      if (!isFinite(v)) return;
      node.params.matchThreshold = v;
      if (ksThreshVal) ksThreshVal.textContent = v.toFixed(2);
      // Live update — no pushHistory on input (would spam the
      // undo stack on every drag tick); commit on change instead.
      if (typeof refreshKeywordSpotterTemplates === "function") refreshKeywordSpotterTemplates(node.id);
    });
    ksThresh.addEventListener('change', () => {
      pushHistory("ks-thresh:" + node.id);
    });
  }
  // KeywordSpotter detect-mode dropdown — switching modes tears
  // down the running detector and re-sets up so whisper templates
  // get transcribed on the way in (or skipped on the way out).
  const ksMode = propsEl.querySelector('#ks-mode-' + node.id);
  if (ksMode) {
    ksMode.addEventListener('change', () => {
      pushHistory("ks-mode:" + node.id);
      node.params.detectMode = ksMode.value;
      // Restart the detector if it was running so the mode change
      // takes effect immediately (without a full preview-stop/start).
      if (typeof teardownKeywordSpotter === "function") teardownKeywordSpotter(node.id);
      if (typeof setupKeywordSpotter === "function" &&
          typeof previewState !== "undefined" && previewState.state === "playing") {
        setupKeywordSpotter(node);
      }
      renderJson();
    });
  }

  // PatchMatrix cell interaction. Click toggles 0↔1; shift-click sets
  // -1 (inversion); vertical drag inside the cell adjusts gain
  // continuously. State lives in node.params.matrix[i][j].
  propsEl.querySelectorAll('.pm-cell').forEach(cell => {
    const i = parseInt(cell.dataset.i, 10);
    const j = parseInt(cell.dataset.j, 10);
    const startDrag = (ev) => {
      ev.preventDefault();
      if (!Array.isArray(node.params.matrix)) {
        node.params.matrix = Array.from({ length: 8 }, () => new Array(8).fill(0));
      }
      const startY = ev.clientY;
      const startG = Number(node.params.matrix[i][j]) || 0;
      let dragged = false;
      pushHistory("pm:" + node.id + ":" + i + ":" + j);
      const onMove = (mev) => {
        const dy = startY - mev.clientY;
        if (Math.abs(dy) < 3 && !dragged) return;
        dragged = true;
        // 80px = full 0..1 range. Past 80px keeps growing up to ~1.5
        // so users can boost; clamp at +/- 2 for safety.
        const span = 80;
        const sign = ev.shiftKey ? -1 : 1;
        const v = Math.max(-2, Math.min(2, startG + sign * dy / span));
        node.params.matrix[i][j] = v;
        cell.style.setProperty("--lvl", Math.max(0, Math.min(1, Math.abs(v))).toFixed(3));
        cell.classList.toggle("on",  v > 0);
        cell.classList.toggle("inv", v < 0);
        cell.title = `i${i+1} → o${j+1} · gain ${v.toFixed(2)}`;
      };
      const onUp = (uev) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        if (!dragged) {
          // Plain click — toggle 0 ↔ 1, or shift-click for inverted -1.
          const cur = Number(node.params.matrix[i][j]) || 0;
          const sign = ev.shiftKey ? -1 : 1;
          node.params.matrix[i][j] = cur === 0 ? sign : 0;
        }
        const v = Number(node.params.matrix[i][j]) || 0;
        cell.style.setProperty("--lvl", Math.max(0, Math.min(1, Math.abs(v))).toFixed(3));
        cell.classList.toggle("on",  v > 0);
        cell.classList.toggle("inv", v < 0);
        cell.title = `i${i+1} → o${j+1} · gain ${v.toFixed(2)}`;
        renderCode(); renderJson();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    };
    cell.addEventListener("pointerdown", startDrag);
  });
  // Wire step-grid clicks (after innerHTML so the buttons exist).
  propsEl.querySelectorAll('.step-cell').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.step, 10);
      if (!Array.isArray(node.params.steps)) {
        node.params.steps = new Array(def.stepCount || 16).fill(false);
      }
      pushHistory("step:" + node.id + ":" + i);
      node.params.steps[i] = !node.params.steps[i];
      btn.classList.toggle('on', node.params.steps[i]);
      renderCode(); renderJson();
    });
  });

  propsEl.querySelectorAll('input[type="number"]').forEach(inp => {
    inp.addEventListener("input", () => {
      pushHistory("param:" + node.id + ":" + inp.dataset.key);
      const v = parseFloat(inp.value);
      node.params[inp.dataset.key] = isNaN(v) ? 0 : v;
      renderCode(); renderJson();
      if (typeof renderMonitorControls === "function") renderMonitorControls();
    });
  });
  propsEl.querySelectorAll('input[type="text"][data-string="1"]').forEach(inp => {
    inp.addEventListener("input", () => {
      pushHistory("param:" + node.id + ":" + inp.dataset.key);
      node.params[inp.dataset.key] = inp.value;
      if (typeof renderMonitorControls === "function") renderMonitorControls();
    });
  });
  propsEl.querySelectorAll('select.enum-select').forEach(sel => {
    sel.addEventListener("change", () => {
      pushHistory("param:" + node.id + ":" + sel.dataset.key);
      // Phase 6.5 — rig-display selects are numeric indices, not enum
      // strings. Convert before assigning so downstream code (validation,
      // render path) gets a number consistently.
      if (sel.dataset.rigDisplay) {
        node.params[sel.dataset.key] = parseInt(sel.value, 10) | 0;
      } else {
        node.params[sel.dataset.key] = sel.value;   // string, not number
      }
      renderCode(); renderJson();
      // If the user picked "custom" on a ramp-editable enum dropdown
      // (Ramp shape, Button shape), jump straight into the drawing
      // modal — saves an extra click.
      if (sel.value === "custom") {
        if (node.type === "Ramp"   && sel.dataset.key === "shape") openRampModal("ramp",   node.id);
        if (node.type === "Button" && sel.dataset.key === "shape") openRampModal("button", node.id);
      }
    });
  });
  // Inline ≈ button next to enum dropdowns that carry a "custom" option.
  propsEl.querySelectorAll('button.ramp-edit-btn').forEach(btn => {
    btn.addEventListener("click", () => {
      const kind = node.type === "Ramp" ? "ramp"
                : node.type === "Slider" ? "slider"
                : node.type === "Button" ? "button"
                : "ramp";
      openRampModal(kind, node.id);
    });
  });
  propsEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", () => {
      pushHistory("expose:" + node.id + ":" + cb.dataset.expose);
      state.exposed[node.id + "." + cb.dataset.expose] = cb.checked;
      renderCode(); renderJson();
    });
  });
}

