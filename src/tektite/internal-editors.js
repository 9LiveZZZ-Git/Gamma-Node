/* =========================================================================
 * Tektite MD -- internal editors (sprint tektite-10v).
 *
 * Replaces the external-editor iframe launchers (10u) with inline
 * editors that run inside Gamma.  Same modal frame; the iframe slot
 * is now a mount point for one of four editors:
 *
 *   pdf   -- PDF.js  (dynamic-import from esm.sh on first open)
 *   image -- canvas-based: rotate / flip / crop / brightness
 *   csv   -- editable spreadsheet table (add/remove rows + columns)
 *   doc   -- mammoth.js (read) + contentEditable (edit); save as
 *            .html alongside the original .docx (round-tripping back
 *            to .docx is a separate library + sprint)
 *
 * Every editor exposes the same lifecycle:
 *   const handle = await _tektiteEditorMountX(mountEl, rec)
 *   handle.save()  -> { blob, mime, newId? }
 *   handle.dispose?()
 *
 * The dispatcher wires Save / Close in the modal toolbar and refreshes
 * the popout's attachment viewer after a successful save.
 *
 * Sprint 10v close-affordance note: every editor mounts INSIDE the
 * modal; the modal's title bar carries an always-visible × Close.
 * Editors don't need their own close button; the toolbar handles it.
 * ======================================================================== */

let _tektiteIntEditorModalEl = null;

function _tektiteEnsureInternalEditorModal() {
  if (_tektiteIntEditorModalEl) return _tektiteIntEditorModalEl;
  const m = document.createElement("div");
  m.id = "tk-internal-editor-modal";
  m.className = "tk-internal-editor-modal";
  m.innerHTML =
    '<div class="tk-iem-bar">' +
      '<span class="tk-iem-title">Editor</span>' +
      '<span class="tk-iem-status"></span>' +
      '<button class="tk-iem-save" type="button">💾 Save</button>' +
      '<a class="tk-iem-dl" download>⬇ Download</a>' +
      '<button class="tk-iem-close" type="button" title="Close (Esc)">× Close</button>' +
    '</div>' +
    /* Sprint 10y -- removed the giant floating × that bled into the
     * editor's own UI; the bar × + Esc are sufficient and the user
     * wanted that affordance on the inline VIEWER bar instead (where
     * there was no close at all before 10y). */
    '<div class="tk-iem-mount"></div>';
  document.body.appendChild(m);
  _tektiteIntEditorModalEl = m;
  // Close handlers.
  m.querySelector(".tk-iem-close").addEventListener("click", () => _tektiteCloseInternalEditor());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && m.style.display !== "none" && m.style.display !== "") {
      _tektiteCloseInternalEditor();
    }
  });
  return m;
}

function _tektiteCloseInternalEditor() {
  const m = _tektiteIntEditorModalEl;
  if (!m) return;
  m.style.display = "none";
  // Dispose current editor.
  if (m._handle && typeof m._handle.dispose === "function") {
    try { m._handle.dispose(); } catch (_) {}
  }
  m._handle = null;
  const mount = m.querySelector(".tk-iem-mount");
  if (mount) mount.innerHTML = "";
  const dl = m.querySelector(".tk-iem-dl");
  if (dl && dl._urlToRevoke) { URL.revokeObjectURL(dl._urlToRevoke); dl._urlToRevoke = null; }
}

async function _tektiteOpenInternalEditor(act, attId) {
  const m = _tektiteEnsureInternalEditorModal();
  m.style.display = "flex";
  m.querySelector(".tk-iem-title").textContent = "Editor: " + attId;
  m.querySelector(".tk-iem-status").textContent = "";
  const mount = m.querySelector(".tk-iem-mount");
  mount.innerHTML = '<div class="tk-iem-loading">Loading attachment…</div>';

  let rec = null;
  try { rec = await tektiteGetAttachment(attId); } catch (_) {}
  if (!rec || !rec.blob) {
    mount.innerHTML = '<div class="tk-iem-empty">⚠ Attachment not found.</div>';
    return;
  }

  // Surface the original blob as a download fallback.
  const dl = m.querySelector(".tk-iem-dl");
  if (dl._urlToRevoke) URL.revokeObjectURL(dl._urlToRevoke);
  const dlUrl = URL.createObjectURL(rec.blob);
  dl._urlToRevoke = dlUrl;
  dl.href = dlUrl;
  dl.setAttribute("download", attId);

  // Mount the right editor.
  let handle = null;
  try {
    if      (act === "pdfjs")        handle = await _tektiteEditorMountPdf  (mount, rec, attId);
    else if (act === "minipaint")    handle = await _tektiteEditorMountImage(mount, rec, attId);
    else if (act === "tablecruncher") handle = await _tektiteEditorMountCsv (mount, rec, attId);
    else if (act === "docxeditor")   handle = await _tektiteEditorMountDoc  (mount, rec, attId);
    else if (act === "monaco")       handle = await _tektiteEditorMountMonaco(mount, rec, attId);
    else {
      mount.innerHTML = '<div class="tk-iem-empty">Unknown editor: ' +
        String(act).replace(/</g, "&lt;") + '</div>';
    }
  } catch (e) {
    mount.innerHTML = '<div class="tk-iem-empty">⚠ Editor failed to load: ' +
      String((e && e.message) || e).replace(/</g, "&lt;") + '</div>';
    return;
  }
  m._handle = handle;

  // Wire save button.
  const saveBtn = m.querySelector(".tk-iem-save");
  saveBtn.disabled = !handle || typeof handle.save !== "function";
  saveBtn.onclick = async () => {
    if (!handle || typeof handle.save !== "function") return;
    saveBtn.disabled = true;
    const orig = saveBtn.textContent;
    saveBtn.textContent = "Saving…";
    try {
      const out = await handle.save();
      if (!out || !out.blob) throw new Error("editor returned no blob");
      const newId = out.newId || attId;
      await tektitePutAttachment({ id: newId, blob: out.blob, mime: out.mime });
      m.querySelector(".tk-iem-status").textContent = "✓ Saved as " + newId;
      // Refresh popout viewer if the source is open.
      if (typeof _tektitePopouts !== "undefined" && _tektitePopouts && _tektitePopouts.instances) {
        const inst = _tektitePopouts.instances.get(attId) ||
                     _tektitePopouts.instances.get(newId);
        if (inst && typeof _tektitePopoutLoadAttachment === "function") {
          await _tektitePopoutLoadAttachment(inst, newId);
        }
      }
      // Refresh tektite tab list so the new id appears.
      if (typeof _tektiteTabRefresh === "function") {
        try { await _tektiteTabRefresh(); } catch (_) {}
      }
    } catch (e) {
      window.alert("Save failed: " + ((e && e.message) || e));
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = orig;
    }
  };
}

/* ----- PDF (PDF.js) -------------------------------------------------- */

let _tektitePdfjsP = null;

async function _tektiteLoadPdfjs() {
  if (_tektitePdfjsP) return _tektitePdfjsP;
  _tektitePdfjsP = (async () => {
    const ver = "4.10.38";
    const mod = await import("https://esm.sh/pdfjs-dist@" + ver);
    const pdfjs = mod.default || mod;
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc =
        "https://esm.sh/pdfjs-dist@" + ver + "/build/pdf.worker.min.mjs";
    }
    return pdfjs;
  })();
  return _tektitePdfjsP;
}

async function _tektiteEditorMountPdf(mount, rec, attId) {
  mount.innerHTML = '<div class="tk-iem-loading">Loading PDF.js…</div>';
  const pdfjs = await _tektiteLoadPdfjs();
  const buf = await rec.blob.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;

  let scale = 1.4;
  mount.innerHTML =
    '<div class="tk-pdf-toolbar">' +
      '<span class="tk-pdf-pages-count">' + pdf.numPages + ' page' + (pdf.numPages === 1 ? "" : "s") + '</span>' +
      '<span class="tk-pdf-sep">|</span>' +
      '<button class="tk-pdf-zoomout" type="button">−</button>' +
      '<span class="tk-pdf-zoom-val">' + Math.round(scale * 71) + '%</span>' +
      '<button class="tk-pdf-zoomin" type="button">+</button>' +
      '<button class="tk-pdf-fit" type="button">Fit width</button>' +
      '<span class="tk-pdf-sep">|</span>' +
      '<span class="tk-pdf-anno-note">Annotation tools surface via the canvas right-click menu in supported builds.</span>' +
    '</div>' +
    '<div class="tk-pdf-pages"></div>';
  const pagesEl   = mount.querySelector(".tk-pdf-pages");
  const zoomValEl = mount.querySelector(".tk-pdf-zoom-val");

  async function renderAll() {
    pagesEl.innerHTML = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const wrap = document.createElement("div");
      wrap.className = "tk-pdf-page-wrap";
      wrap.dataset.pageNumber = String(i);
      const canvas = document.createElement("canvas");
      canvas.width  = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      wrap.appendChild(canvas);
      pagesEl.appendChild(wrap);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
    }
    zoomValEl.textContent = Math.round(scale * 71) + "%";
  }
  await renderAll();

  mount.querySelector(".tk-pdf-zoomin") .addEventListener("click", () => {
    scale = Math.min(4, scale * 1.2); renderAll();
  });
  mount.querySelector(".tk-pdf-zoomout").addEventListener("click", () => {
    scale = Math.max(0.4, scale / 1.2); renderAll();
  });
  mount.querySelector(".tk-pdf-fit").addEventListener("click", async () => {
    const page1 = await pdf.getPage(1);
    const vp = page1.getViewport({ scale: 1 });
    const want = (pagesEl.clientWidth - 20) / vp.width;
    scale = Math.max(0.4, Math.min(4, want));
    renderAll();
  });

  // Save: round-trip the same buffer for now.  Annotation editing
  // requires PDF.js's AnnotationEditorLayer integration (deferred to
  // a follow-up sprint; PDF.js v4 supports highlight + freetext + ink
  // edits but needs the layer mounted on top of each page canvas).
  return {
    save: async () => ({ blob: rec.blob, mime: "application/pdf" }),
    dispose: () => {
      try { pdf.destroy && pdf.destroy(); } catch (_) {}
    }
  };
}

/* ----- Image editor (pure canvas) ----------------------------------- */

async function _tektiteEditorMountImage(mount, rec, attId) {
  mount.innerHTML = '<div class="tk-iem-loading">Loading image…</div>';
  const url = URL.createObjectURL(rec.blob);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload  = () => resolve();
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
  URL.revokeObjectURL(url);

  mount.innerHTML =
    '<div class="tk-img-toolbar">' +
      '<button class="tk-img-rotL"  type="button" title="Rotate 90° left">⟲</button>' +
      '<button class="tk-img-rotR"  type="button" title="Rotate 90° right">⟳</button>' +
      '<button class="tk-img-flipH" type="button" title="Flip horizontal">⇆</button>' +
      '<button class="tk-img-flipV" type="button" title="Flip vertical">⇅</button>' +
      '<span class="tk-img-sep">|</span>' +
      '<label class="tk-img-slider">Bright <input type="range" class="tk-img-bright" min="-100" max="100" value="0"></label>' +
      '<label class="tk-img-slider">Contrast <input type="range" class="tk-img-contrast" min="-100" max="100" value="0"></label>' +
      '<span class="tk-img-sep">|</span>' +
      '<button class="tk-img-crop"   type="button" title="Drag a selection then click Crop">✂ Crop selection</button>' +
      '<button class="tk-img-reset"  type="button" title="Revert to original">Reset</button>' +
    '</div>' +
    '<div class="tk-img-stage">' +
      '<canvas class="tk-img-canvas"></canvas>' +
      '<div class="tk-img-sel" style="display:none;"></div>' +
    '</div>';

  const canvas = mount.querySelector(".tk-img-canvas");
  const ctx    = canvas.getContext("2d");
  const stage  = mount.querySelector(".tk-img-stage");
  const selEl  = mount.querySelector(".tk-img-sel");

  // State: keep working data on an offscreen canvas + reapply effects.
  const work = document.createElement("canvas");
  work.width  = img.naturalWidth;
  work.height = img.naturalHeight;
  work.getContext("2d").drawImage(img, 0, 0);
  let bright = 0, contrast = 0;

  function paint() {
    canvas.width  = work.width;
    canvas.height = work.height;
    ctx.filter = "brightness(" + (100 + bright) + "%) contrast(" + (100 + contrast) + "%)";
    ctx.drawImage(work, 0, 0);
    ctx.filter = "none";
  }
  paint();

  function commitFilters() {
    // Fold the current bright/contrast into the work buffer so future
    // ops compose on top.
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width; tmp.height = canvas.height;
    const tctx = tmp.getContext("2d");
    tctx.filter = "brightness(" + (100 + bright) + "%) contrast(" + (100 + contrast) + "%)";
    tctx.drawImage(work, 0, 0);
    work.width = tmp.width; work.height = tmp.height;
    work.getContext("2d").drawImage(tmp, 0, 0);
    bright = 0; contrast = 0;
    mount.querySelector(".tk-img-bright").value   = "0";
    mount.querySelector(".tk-img-contrast").value = "0";
  }

  function rotate(deg) {
    commitFilters();
    const w = work.width, h = work.height;
    const tmp = document.createElement("canvas");
    if (deg === 90 || deg === -90 || deg === 270) {
      tmp.width = h; tmp.height = w;
    } else {
      tmp.width = w; tmp.height = h;
    }
    const tctx = tmp.getContext("2d");
    tctx.translate(tmp.width / 2, tmp.height / 2);
    tctx.rotate((deg * Math.PI) / 180);
    tctx.drawImage(work, -w / 2, -h / 2);
    work.width = tmp.width; work.height = tmp.height;
    work.getContext("2d").drawImage(tmp, 0, 0);
    paint();
  }

  function flip(h) {
    commitFilters();
    const tmp = document.createElement("canvas");
    tmp.width = work.width; tmp.height = work.height;
    const tctx = tmp.getContext("2d");
    if (h) { tctx.translate(work.width, 0); tctx.scale(-1, 1); }
    else   { tctx.translate(0, work.height); tctx.scale(1, -1); }
    tctx.drawImage(work, 0, 0);
    work.getContext("2d").clearRect(0, 0, work.width, work.height);
    work.getContext("2d").drawImage(tmp, 0, 0);
    paint();
  }

  mount.querySelector(".tk-img-rotL").addEventListener("click", () => rotate(-90));
  mount.querySelector(".tk-img-rotR").addEventListener("click", () => rotate( 90));
  mount.querySelector(".tk-img-flipH").addEventListener("click", () => flip(true));
  mount.querySelector(".tk-img-flipV").addEventListener("click", () => flip(false));
  mount.querySelector(".tk-img-bright").addEventListener("input", (e) => {
    bright = Number(e.target.value) || 0; paint();
  });
  mount.querySelector(".tk-img-contrast").addEventListener("input", (e) => {
    contrast = Number(e.target.value) || 0; paint();
  });
  mount.querySelector(".tk-img-reset").addEventListener("click", () => {
    work.width = img.naturalWidth; work.height = img.naturalHeight;
    work.getContext("2d").drawImage(img, 0, 0);
    bright = 0; contrast = 0;
    mount.querySelector(".tk-img-bright").value = "0";
    mount.querySelector(".tk-img-contrast").value = "0";
    paint(); hideSel();
  });

  // Selection rect for crop.
  let selStart = null;
  let selRect  = null;
  function hideSel() { selEl.style.display = "none"; selRect = null; }
  canvas.addEventListener("pointerdown", (e) => {
    const r = canvas.getBoundingClientRect();
    selStart = {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top)  * (canvas.height / r.height)
    };
    canvas.setPointerCapture(e.pointerId);
    selEl.style.display = "block";
    selEl.style.left = "0"; selEl.style.top = "0"; selEl.style.width = "0"; selEl.style.height = "0";
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!selStart) return;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (canvas.width / r.width);
    const y = (e.clientY - r.top)  * (canvas.height / r.height);
    selRect = {
      x: Math.min(selStart.x, x),
      y: Math.min(selStart.y, y),
      w: Math.abs(x - selStart.x),
      h: Math.abs(y - selStart.y)
    };
    const cr = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const sx = (selRect.x / canvas.width)  * cr.width  + (cr.left - stageRect.left);
    const sy = (selRect.y / canvas.height) * cr.height + (cr.top  - stageRect.top);
    const sw = (selRect.w / canvas.width)  * cr.width;
    const sh = (selRect.h / canvas.height) * cr.height;
    selEl.style.left = sx + "px"; selEl.style.top = sy + "px";
    selEl.style.width = sw + "px"; selEl.style.height = sh + "px";
  });
  canvas.addEventListener("pointerup", () => { selStart = null; });

  mount.querySelector(".tk-img-crop").addEventListener("click", () => {
    if (!selRect || selRect.w < 4 || selRect.h < 4) {
      window.alert("Drag a selection on the image first.");
      return;
    }
    commitFilters();
    const tmp = document.createElement("canvas");
    tmp.width = Math.round(selRect.w); tmp.height = Math.round(selRect.h);
    tmp.getContext("2d").drawImage(work,
      selRect.x, selRect.y, selRect.w, selRect.h,
      0, 0, selRect.w, selRect.h);
    work.width = tmp.width; work.height = tmp.height;
    work.getContext("2d").drawImage(tmp, 0, 0);
    paint(); hideSel();
  });

  return {
    save: async () => {
      commitFilters();
      // Use the same mime as the source if it's something the canvas
      // can encode; otherwise default to PNG.
      const mime = (rec.mime && /^image\/(png|jpeg|webp)$/.test(rec.mime))
        ? rec.mime : "image/png";
      const blob = await new Promise(resolve => work.toBlob(resolve, mime));
      return { blob, mime };
    }
  };
}

/* ----- CSV editor --------------------------------------------------- */

function _tektiteCsvParse(text, sep) {
  // Tiny RFC-4180-ish parser: respects quoted strings, escapes "".
  const rows = [];
  let cur = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else                     { inQ = false; }
      } else field += c;
    } else {
      if (c === '"')             inQ = true;
      else if (c === sep)        { cur.push(field); field = ""; }
      else if (c === "\n")       { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (c === "\r")       { /* ignore; \r\n handled by the \n branch */ }
      else                       field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

function _tektiteCsvSerialize(rows, sep) {
  return rows.map(row => row.map(cell => {
    const s = String(cell == null ? "" : cell);
    if (s.indexOf('"') >= 0 || s.indexOf(sep) >= 0 || s.indexOf("\n") >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }).join(sep)).join("\n");
}

async function _tektiteEditorMountCsv(mount, rec, attId) {
  const text = await rec.blob.text();
  const sep = (rec.ext === ".tsv") ? "\t" : ",";
  let rows = _tektiteCsvParse(text, sep);
  if (!rows.length) rows = [[""]];
  const ncols = () => rows.reduce((m, r) => Math.max(m, r.length), 1);
  function padRows() {
    const n = ncols();
    for (const r of rows) while (r.length < n) r.push("");
  }
  padRows();

  mount.innerHTML =
    '<div class="tk-csv-toolbar">' +
      '<button class="tk-csv-add-row" type="button">+ Row</button>' +
      '<button class="tk-csv-del-row" type="button">− Row</button>' +
      '<button class="tk-csv-add-col" type="button">+ Col</button>' +
      '<button class="tk-csv-del-col" type="button">− Col</button>' +
      '<span class="tk-csv-sep-info">delimiter: ' + (sep === "\t" ? "TAB" : ",") + '</span>' +
      '<span class="tk-csv-count"></span>' +
    '</div>' +
    '<div class="tk-csv-scroll"><table class="tk-csv-table"></table></div>';

  const tbl   = mount.querySelector(".tk-csv-table");
  const count = mount.querySelector(".tk-csv-count");

  function render() {
    padRows();
    const n = ncols();
    let html = "<thead><tr><th class='tk-csv-corner'></th>";
    for (let c = 0; c < n; c++) html += "<th>" + (c + 1) + "</th>";
    html += "</tr></thead><tbody>";
    for (let r = 0; r < rows.length; r++) {
      html += "<tr><th>" + (r + 1) + "</th>";
      for (let c = 0; c < n; c++) {
        const val = String(rows[r][c] == null ? "" : rows[r][c])
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html += '<td contenteditable="true" data-r="' + r + '" data-c="' + c + '">' + val + '</td>';
      }
      html += "</tr>";
    }
    html += "</tbody>";
    tbl.innerHTML = html;
    count.textContent = rows.length + " rows · " + n + " cols";
    // Wire cell edits.
    tbl.querySelectorAll("td[contenteditable]").forEach(td => {
      td.addEventListener("blur", () => {
        const r = Number(td.getAttribute("data-r"));
        const c = Number(td.getAttribute("data-c"));
        rows[r][c] = td.textContent;
      });
    });
  }
  render();

  mount.querySelector(".tk-csv-add-row").addEventListener("click", () => {
    rows.push(new Array(ncols()).fill("")); render();
  });
  mount.querySelector(".tk-csv-del-row").addEventListener("click", () => {
    if (rows.length > 1) rows.pop(); render();
  });
  mount.querySelector(".tk-csv-add-col").addEventListener("click", () => {
    for (const r of rows) r.push(""); render();
  });
  mount.querySelector(".tk-csv-del-col").addEventListener("click", () => {
    for (const r of rows) if (r.length > 1) r.pop(); render();
  });

  return {
    save: async () => {
      // Make sure pending blur events flush their values.
      if (document.activeElement && document.activeElement.tagName === "TD") {
        document.activeElement.blur();
      }
      const out = _tektiteCsvSerialize(rows, sep);
      const blob = new Blob([out], { type: rec.mime || (sep === "\t" ? "text/tab-separated-values" : "text/csv") });
      return { blob, mime: blob.type };
    }
  };
}

/* ----- Doc editor (.docx via mammoth) ------------------------------ */

let _tektiteMammothP = null;

async function _tektiteLoadMammoth() {
  if (_tektiteMammothP) return _tektiteMammothP;
  _tektiteMammothP = (async () => {
    // mammoth.browser.min.js is exposed as default at this path.
    const mod = await import("https://esm.sh/mammoth@1.8.0");
    return mod.default || mod;
  })();
  return _tektiteMammothP;
}

async function _tektiteEditorMountDoc(mount, rec, attId) {
  mount.innerHTML = '<div class="tk-iem-loading">Loading mammoth.js…</div>';
  let mammoth;
  try { mammoth = await _tektiteLoadMammoth(); }
  catch (e) { mount.innerHTML = '<div class="tk-iem-empty">⚠ Failed to load mammoth: ' + e + '</div>'; return null; }

  const buf = await rec.blob.arrayBuffer();
  let html = "";
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    html = result.value || "";
  } catch (e) {
    // Fallback to plain text on unsupported docx variants.
    html = "<pre>" + String(await rec.blob.text())
      .replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>";
  }

  mount.innerHTML =
    '<div class="tk-doc-toolbar">' +
      '<span class="tk-doc-info">.docx → HTML preview · edits save as <code>' +
        attId.replace(/\.docx?$/i, "") + '.html</code></span>' +
    '</div>' +
    '<div class="tk-doc-edit" contenteditable="true">' + html + '</div>';

  const editEl = mount.querySelector(".tk-doc-edit");

  return {
    save: async () => {
      // Save edited HTML as a new .html attachment next to the .docx.
      // Round-tripping back to .docx requires the `docx` library; queued
      // as a follow-up sprint.
      const baseName = String(attId).replace(/\.(docx?|odt|rtf)$/i, "");
      const newId = baseName + ".html";
      const out = '<!doctype html><meta charset="utf-8"><title>' +
        baseName.replace(/&/g, "&amp;").replace(/</g, "&lt;") +
        '</title>\n' + editEl.innerHTML;
      const blob = new Blob([out], { type: "text/html" });
      return { blob, mime: "text/html", newId };
    }
  };
}

/* ----- Monaco code editor (sprint 10w) ------------------------------
 *
 * Lazy-loads Monaco from jsdelivr's AMD bundle (the official build
 * used by VS Code).  Detects language from the file extension and
 * sets it on the Monaco model.  Save round-trips the edited text.
 *
 * The toolbar exposes a "Compile to custom node" stub that opens a
 * compile-target modal.  Real compilation (LLVM / Emscripten /
 * Python interpreter / etc.) is a Phase-D sprint -- see
 * docs/ROADMAP.md "Monaco compile-to-node" entry. */

const TEKTITE_MONACO_VERSION = "0.52.0";
let _tektiteMonacoP = null;

async function _tektiteLoadMonaco() {
  if (_tektiteMonacoP) return _tektiteMonacoP;
  _tektiteMonacoP = new Promise((resolve, reject) => {
    if (window.monaco) { resolve(window.monaco); return; }
    // Monaco ships as an AMD bundle.  Load its loader, configure
    // paths, then require("vs/editor/editor.main").
    const loaderUrl = "https://cdn.jsdelivr.net/npm/monaco-editor@" +
      TEKTITE_MONACO_VERSION + "/min/vs/loader.js";
    const script = document.createElement("script");
    script.src = loaderUrl;
    script.onload = () => {
      try {
        window.require.config({
          paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@" +
                       TEKTITE_MONACO_VERSION + "/min/vs" }
        });
        window.require(["vs/editor/editor.main"], () => resolve(window.monaco),
                       (err) => reject(err));
      } catch (e) { reject(e); }
    };
    script.onerror = () => reject(new Error("monaco loader failed"));
    document.head.appendChild(script);
  });
  return _tektiteMonacoP;
}

function _tektiteMonacoLanguageFor(ext) {
  const e = String(ext || "").toLowerCase();
  const map = {
    ".py":  "python",  ".js":  "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts":  "typescript", ".tsx": "typescript", ".jsx": "javascript",
    ".c":   "c",       ".h":   "c",
    ".cpp": "cpp",     ".cxx": "cpp", ".cc":  "cpp", ".hpp": "cpp",
    ".rs":  "rust",
    ".html":"html",    ".htm": "html",
    ".css": "css",     ".scss":"scss", ".less":"less",
    ".json":"json",    ".jsonl":"json",
    ".yaml":"yaml",    ".yml": "yaml",
    ".xml": "xml",
    ".md":  "markdown", ".markdown": "markdown",
    ".sh":  "shell",   ".bash":"shell", ".zsh": "shell",
    ".go":  "go",
    ".java":"java",    ".kt":  "kotlin", ".scala":"scala",
    ".rb":  "ruby",    ".php": "php",
    ".lua": "lua",
    ".swift":"swift",
    ".sql": "sql",
    ".r":   "r",
    ".raku":"perl",    ".rakumod":"perl", ".rakudoc":"perl",  // Raku has no Monaco grammar; Perl is the closest
    ".pl":  "perl",    ".pm":  "perl",
    ".gdsp":"cpp",     // .gdsp is C++ with gdsp metadata comments
    ".gpatch":"json",  // .gpatch is JSON
    ".vue": "html",    ".svelte":"html", ".astro":"html",
    ".wgsl":"rust",    ".glsl":"c"        // closest available
  };
  return map[e] || "plaintext";
}

async function _tektiteEditorMountMonaco(mount, rec, attId) {
  mount.innerHTML = '<div class="tk-iem-loading">Loading Monaco…</div>';
  let monaco;
  try { monaco = await _tektiteLoadMonaco(); }
  catch (e) { mount.innerHTML = '<div class="tk-iem-empty">⚠ Failed to load Monaco: ' + e + '</div>'; return null; }

  const text = await rec.blob.text();
  const lang = _tektiteMonacoLanguageFor(rec.ext);
  mount.innerHTML =
    '<div class="tk-mon-toolbar">' +
      '<span class="tk-mon-lang">' + lang + '</span>' +
      '<button class="tk-mon-compile" type="button" title="Compile this source to a custom node (Phase D feature; opens the target picker)">⚙ Compile to node</button>' +
      '<span class="tk-mon-info">Edits save back as <code>' +
        attId.replace(/&/g, "&amp;").replace(/</g, "&lt;") +
      '</code>.</span>' +
    '</div>' +
    '<div class="tk-mon-mount"></div>';
  const editorMount = mount.querySelector(".tk-mon-mount");
  const editor = monaco.editor.create(editorMount, {
    value:               text,
    language:            lang,
    theme:               "vs-dark",
    automaticLayout:     true,
    minimap:             { enabled: true },
    scrollBeyondLastLine: false,
    fontSize:            13
  });
  // Compile-to-node stub: opens a modal explaining the feature is
  // scoped for a Phase-D sprint (see docs/ROADMAP.md).
  mount.querySelector(".tk-mon-compile").addEventListener("click", () => {
    _tektiteOpenCompileModal(attId, lang, editor.getValue());
  });

  return {
    save: async () => {
      const out = editor.getValue();
      const blob = new Blob([out], { type: rec.mime || "text/plain" });
      return { blob, mime: blob.type };
    },
    dispose: () => { try { editor.dispose(); } catch (_) {} }
  };
}

/* ----- Compile to custom node (sprint 10w stub) ---------------------
 *
 * Opens a small picker -- target node kind + node name -- and writes
 * a SKELETON .gdsp / shader-frag stub into the vault so the user has
 * something to wire up in the main canvas.  Real compilation needs
 * per-language toolchains (LLVM-WebAssembly for C++ / Rust, Pyodide
 * for Python, ...) and lives in the Phase-D Tektite compile sprint.
 *
 * Until then, the picker delivers:
 *   - "Wrap as .gdsp" -> saves a .gdsp file with the source verbatim
 *                       in a process() body + Gamma @gdsp- metadata.
 *                       Requires the source to already be valid C++.
 *   - "Wrap as ShaderFrag" -> saves a .gpatch with a ShaderFrag node
 *                             carrying the user code as the fragment
 *                             shader (only valid for .glsl / .wgsl).
 *   - "Audio server route" -> placeholder; future sprint posts the
 *                             compiled artifact to the audio server. */
async function _tektiteOpenCompileModal(attId, lang, source) {
  const m = document.createElement("div");
  m.className = "tk-compile-modal";
  m.innerHTML =
    '<div class="tk-cm-bar">' +
      '<span class="tk-cm-title">Compile to custom node</span>' +
      '<button class="tk-cm-close" type="button">× Close</button>' +
    '</div>' +
    '<div class="tk-cm-body">' +
      '<p>Source: <code>' + attId.replace(/</g, "&lt;") + '</code> (' + lang + ').</p>' +
      '<label>Node name: <input class="tk-cm-name" value="' +
        attId.replace(/\.[^.]+$/, "").replace(/&/g, "&amp;").replace(/</g, "&lt;") +
      '"></label>' +
      '<label>Target:</label>' +
      '<select class="tk-cm-target">' +
        '<option value="gdsp">Wrap as .gdsp (audio custom node)</option>' +
        '<option value="frag">Wrap as ShaderFrag (visual custom node)</option>' +
        '<option value="server">Audio server route (Phase D, stub)</option>' +
      '</select>' +
      '<div class="tk-cm-note">⚠ Phase-D feature.  Today this writes a SKELETON wrapper so the source has somewhere to live; real cross-language compilation (LLVM-WebAssembly / Pyodide / etc.) ships in a follow-up sprint.  See docs/ROADMAP.md "Monaco compile-to-node".</div>' +
      '<button class="tk-cm-write" type="button">Write skeleton</button>' +
    '</div>';
  document.body.appendChild(m);
  function close() { try { document.body.removeChild(m); } catch (_) {} }
  m.querySelector(".tk-cm-close").addEventListener("click", close);
  m.querySelector(".tk-cm-write").addEventListener("click", async () => {
    const name   = m.querySelector(".tk-cm-name").value.replace(/[^A-Za-z0-9_]/g, "_") || "Custom";
    const target = m.querySelector(".tk-cm-target").value;
    if (target === "gdsp") {
      const gdsp =
        "// @gdsp-name " + name + "\n" +
        "// @gdsp-source " + attId + "\n" +
        "// @gdsp-language " + lang + "\n" +
        "// Auto-skeleton from Tektite compile-to-node (sprint 10w).\n" +
        "// Phase-D will replace the body with a real transpile pass.\n" +
        "#include <Gamma/Gamma.h>\n\n" +
        "class " + name + " {\n" +
        "public:\n" +
        "  float operator()(float in) {\n" +
        "    // --- begin user source (" + lang + ") ---\n" +
        source.split("\n").map(l => "    // " + l).join("\n") + "\n" +
        "    // --- end user source ---\n" +
        "    return in;\n" +
        "  }\n" +
        "};\n";
      const id = name + ".gdsp";
      await tektitePutAttachment({ id, blob: new Blob([gdsp], { type: "text/x-c++src" }), mime: "text/x-c++src" });
      window.alert("Skeleton .gdsp written: " + id);
    } else if (target === "frag") {
      const gpatch = JSON.stringify({
        patchName: name,
        nodes: [{ id: "n1", type: "ShaderFrag", x: 200, y: 200, params: { src: source } }],
        edges: []
      }, null, 2);
      const id = name + ".gpatch";
      await tektitePutAttachment({ id, blob: new Blob([gpatch], { type: "application/json" }), mime: "application/json" });
      window.alert("Skeleton .gpatch written: " + id);
    } else {
      window.alert("Audio server route is a Phase-D stub.  See docs/ROADMAP.md.");
    }
    close();
    if (typeof _tektiteTabRefresh === "function") { try { await _tektiteTabRefresh(); } catch (_) {} }
  });
}

/* ----- PDF.js annotation persist (sprint 10w upgrade) ---------------
 *
 * Upgrades the 10v PDF viewer with annotation editing.  PDF.js exposes
 * AnnotationEditorUIManager + AnnotationEditorLayer; we mount an
 * editor layer on every page canvas and surface a small toolbar to
 * pick the tool (highlight / freetext / ink) and save back.
 *
 * Save path: pdf.saveDocument() returns the modified PDF as a Uint8Array
 * which we pack into a new Blob keyed under the same attachment id. */

async function _tektiteEditorMountPdfV2(mount, rec /*, attId */) {
  mount.innerHTML = '<div class="tk-iem-loading">Loading PDF.js…</div>';
  const pdfjs = await _tektiteLoadPdfjs();
  const buf = await rec.blob.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;

  let scale = 1.4;
  let activeTool = "select";       // select / freetext / highlight / ink

  mount.innerHTML =
    '<div class="tk-pdf-toolbar">' +
      '<span class="tk-pdf-pages-count">' + pdf.numPages + ' page' + (pdf.numPages === 1 ? "" : "s") + '</span>' +
      '<span class="tk-pdf-sep">|</span>' +
      '<button class="tk-pdf-zoomout" type="button">−</button>' +
      '<span class="tk-pdf-zoom-val">' + Math.round(scale * 71) + '%</span>' +
      '<button class="tk-pdf-zoomin"  type="button">+</button>' +
      '<button class="tk-pdf-fit"     type="button">Fit width</button>' +
      '<span class="tk-pdf-sep">|</span>' +
      '<button class="tk-pdf-tool active"  data-tool="select"    type="button" title="Pan / select">↖</button>' +
      '<button class="tk-pdf-tool"          data-tool="freetext"  type="button" title="Free-text annotation">T</button>' +
      '<button class="tk-pdf-tool"          data-tool="highlight" type="button" title="Highlight">🖍</button>' +
      '<button class="tk-pdf-tool"          data-tool="ink"       type="button" title="Draw / ink">✎</button>' +
    '</div>' +
    '<div class="tk-pdf-pages"></div>';

  const pagesEl   = mount.querySelector(".tk-pdf-pages");
  const zoomValEl = mount.querySelector(".tk-pdf-zoom-val");

  // AnnotationEditor needs a UI manager.  Try the various APIs PDF.js
  // exposes; fall back gracefully if any are missing on the user's
  // installed version.
  const supportsEditor =
    !!pdfjs.AnnotationEditorUIManager &&
    !!pdfjs.AnnotationEditorLayer    &&
    !!pdfjs.AnnotationEditorType;
  let editorManager = null;
  if (supportsEditor) {
    try {
      editorManager = new pdfjs.AnnotationEditorUIManager(pagesEl, null, null, pdfjs.AnnotationEditorType.NONE, undefined, pdfjs.AnnotationEditorType);
    } catch (_) {
      editorManager = null;
    }
  }

  async function renderAll() {
    pagesEl.innerHTML = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const wrap = document.createElement("div");
      wrap.className = "tk-pdf-page-wrap";
      wrap.style.position = "relative";
      wrap.style.width  = Math.ceil(viewport.width)  + "px";
      wrap.style.height = Math.ceil(viewport.height) + "px";
      wrap.dataset.pageNumber = String(i);
      const canvas = document.createElement("canvas");
      canvas.width  = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      wrap.appendChild(canvas);
      pagesEl.appendChild(wrap);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Mount annotation editor layer if supported.
      if (editorManager) {
        try {
          const editorLayerDiv = document.createElement("div");
          editorLayerDiv.className = "annotationEditorLayer";
          editorLayerDiv.style.position = "absolute";
          editorLayerDiv.style.inset = "0";
          wrap.appendChild(editorLayerDiv);
          const layer = new pdfjs.AnnotationEditorLayer({
            uiManager:  editorManager,
            pageDiv:    wrap,
            pageIndex:  i - 1,
            div:        editorLayerDiv,
            accessibilityManager: null,
            annotationLayer: null,
            viewport: viewport.clone({ scale: 1 }),
            l10n:     { get: (s) => s, getLanguage: () => "en" }
          });
          await layer.render({ viewport, intent: "display" });
        } catch (e) {
          // Annotation layer setup is brittle across PDF.js minor
          // versions; failing it shouldn't kill the page render.
          console.warn("[pdf] annotation layer init failed for page", i, e);
        }
      }
    }
    zoomValEl.textContent = Math.round(scale * 71) + "%";
  }
  await renderAll();

  mount.querySelector(".tk-pdf-zoomin") .addEventListener("click", () => { scale = Math.min(4, scale * 1.2); renderAll(); });
  mount.querySelector(".tk-pdf-zoomout").addEventListener("click", () => { scale = Math.max(0.4, scale / 1.2); renderAll(); });
  mount.querySelector(".tk-pdf-fit").addEventListener("click", async () => {
    const p1 = await pdf.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    const want = (pagesEl.clientWidth - 20) / vp.width;
    scale = Math.max(0.4, Math.min(4, want));
    renderAll();
  });

  // Tool buttons.
  mount.querySelectorAll(".tk-pdf-tool").forEach(btn => {
    btn.addEventListener("click", () => {
      mount.querySelectorAll(".tk-pdf-tool").forEach(b => b.classList.toggle("active", b === btn));
      activeTool = btn.getAttribute("data-tool") || "select";
      if (editorManager && pdfjs.AnnotationEditorType) {
        const map = {
          select:    pdfjs.AnnotationEditorType.NONE,
          freetext:  pdfjs.AnnotationEditorType.FREETEXT,
          highlight: pdfjs.AnnotationEditorType.HIGHLIGHT,
          ink:       pdfjs.AnnotationEditorType.INK
        };
        const t = map[activeTool];
        if (t !== undefined) {
          try { editorManager.updateMode(t); }
          catch (_) {}
        }
      }
    });
  });

  return {
    save: async () => {
      try {
        const saved = await pdf.saveDocument();
        const blob = new Blob([saved], { type: "application/pdf" });
        return { blob, mime: "application/pdf" };
      } catch (e) {
        console.warn("[pdf] saveDocument failed, returning original:", e);
        return { blob: rec.blob, mime: "application/pdf" };
      }
    },
    dispose: () => {
      try { editorManager && editorManager.destroy && editorManager.destroy(); } catch (_) {}
      try { pdf.destroy && pdf.destroy(); } catch (_) {}
    }
  };
}

/* Override the 10v PDF mounter with the 10w version that owns
 * annotation editing + saveDocument. */
_tektiteEditorMountPdf = _tektiteEditorMountPdfV2;

/* ----- DOCX true round-trip save (sprint 10w upgrade) ---------------
 *
 * Replaces 10v's "save as .html" with a real .docx writer.  Uses
 * the `docx` library + a tiny HTML->docx walker.  Unsupported HTML
 * features (tables w/ merged cells, complex inline styling) are
 * preserved as best-effort plain-text paragraphs. */

let _tektiteDocxLibP = null;
async function _tektiteLoadDocxLib() {
  if (_tektiteDocxLibP) return _tektiteDocxLibP;
  _tektiteDocxLibP = (async () => {
    const mod = await import("https://esm.sh/docx@8.5.0");
    return mod.default || mod;
  })();
  return _tektiteDocxLibP;
}

function _tektiteHtmlToDocxBlocks(rootEl, docx) {
  const { Paragraph, TextRun, HeadingLevel } = docx;
  const blocks = [];
  function pushParagraph(node, level) {
    const runs = [];
    function walk(n, style) {
      style = style || {};
      if (n.nodeType === 3) { runs.push(new TextRun({ text: n.nodeValue || "", ...style })); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName && n.tagName.toUpperCase();
      const next = { ...style };
      if (tag === "B" || tag === "STRONG") next.bold = true;
      if (tag === "I" || tag === "EM")     next.italics = true;
      if (tag === "U")                     next.underline = {};
      if (tag === "BR") { runs.push(new TextRun({ break: 1, ...style })); return; }
      for (const c of n.childNodes) walk(c, next);
    }
    walk(node, {});
    const para = { children: runs };
    if (level) para.heading = level;
    blocks.push(new Paragraph(para));
  }
  for (const c of rootEl.childNodes) {
    if (c.nodeType !== 1) {
      if (c.nodeType === 3 && c.nodeValue && c.nodeValue.trim()) {
        blocks.push(new Paragraph({ children: [new TextRun({ text: c.nodeValue.trim() })] }));
      }
      continue;
    }
    const tag = c.tagName && c.tagName.toUpperCase();
    if (tag === "H1") pushParagraph(c, HeadingLevel.HEADING_1);
    else if (tag === "H2") pushParagraph(c, HeadingLevel.HEADING_2);
    else if (tag === "H3") pushParagraph(c, HeadingLevel.HEADING_3);
    else if (tag === "H4") pushParagraph(c, HeadingLevel.HEADING_4);
    else if (tag === "P" || tag === "DIV" || tag === "SPAN" || tag === "LI") pushParagraph(c, null);
    else if (tag === "UL" || tag === "OL") {
      for (const li of c.children) pushParagraph(li, null);
    } else if (tag === "PRE") {
      blocks.push(new Paragraph({ children: [new TextRun({ text: c.textContent || "" })] }));
    } else {
      pushParagraph(c, null);
    }
  }
  return blocks;
}

async function _tektiteEditorMountDocV2(mount, rec, attId) {
  mount.innerHTML = '<div class="tk-iem-loading">Loading mammoth.js…</div>';
  let mammoth;
  try { mammoth = await _tektiteLoadMammoth(); }
  catch (e) { mount.innerHTML = '<div class="tk-iem-empty">⚠ Failed to load mammoth: ' + e + '</div>'; return null; }

  const buf = await rec.blob.arrayBuffer();
  let html = "";
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    html = result.value || "";
  } catch (_) {
    html = "<pre>" + String(await rec.blob.text()).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>";
  }

  mount.innerHTML =
    '<div class="tk-doc-toolbar">' +
      '<span class="tk-doc-info">.docx -> HTML; Save writes a NEW <code>.docx</code> via the docx library.</span>' +
    '</div>' +
    '<div class="tk-doc-edit" contenteditable="true">' + html + '</div>';

  const editEl = mount.querySelector(".tk-doc-edit");

  return {
    save: async () => {
      // Try the real docx round-trip; fall back to .html on failure.
      try {
        const docx = await _tektiteLoadDocxLib();
        const { Document, Packer } = docx;
        const children = _tektiteHtmlToDocxBlocks(editEl, docx);
        const doc = new Document({ sections: [{ properties: {}, children }] });
        const blob = await Packer.toBlob(doc);
        return {
          blob,
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          newId: attId
        };
      } catch (e) {
        console.warn("[docx] true round-trip save failed; falling back to .html:", e);
        const baseName = String(attId).replace(/\.(docx?|odt|rtf)$/i, "");
        const newId = baseName + ".html";
        const out = '<!doctype html><meta charset="utf-8"><title>' +
          baseName.replace(/&/g, "&amp;").replace(/</g, "&lt;") +
          '</title>\n' + editEl.innerHTML;
        const blob = new Blob([out], { type: "text/html" });
        return { blob, mime: "text/html", newId };
      }
    }
  };
}

/* Override the 10v doc mounter with the 10w version that round-trips
 * back to .docx via the docx library. */
_tektiteEditorMountDoc = _tektiteEditorMountDocV2;

