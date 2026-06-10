/* ============================================================================
 * Phase C §7.4 -- node <-> Tektite-note attachment   (sprint: node-note-attach)
 *
 * Links a Tektite vault note to a graph node as that node's documentation.
 * The note's markdown is snapshotted onto the node so it:
 *   (a) persists and travels inside the .gpatch (params are serialized), and
 *   (b) is synchronously available to codegen, which emits it as a /** *​/
 *       doc comment above the node's generated member (see codegen sprint).
 * The id stays as the live link back to the vault note -- "Refresh" re-pulls
 * the latest text, "Open" floats the note's Tektite editor popout.
 *
 * Storage lives in node.params under the three NODE_NOTE_PARAM_KEYS below;
 * render-props.js excludes those keys from the parameter grid so they don't
 * render as editable rows.
 * ==========================================================================*/

const NODE_NOTE_PARAM_KEYS = ["tektiteNoteId", "tektiteNoteTitle", "tektiteNoteBody"];

/* Read the attachment off a node, or null when nothing is linked. */
function nodeAttachedNote(node) {
  if (!node || !node.params || !node.params.tektiteNoteId) return null;
  return {
    id:    node.params.tektiteNoteId,
    title: node.params.tektiteNoteTitle || node.params.tektiteNoteId,
    body:  (typeof node.params.tektiteNoteBody === "string") ? node.params.tektiteNoteBody : ""
  };
}

/* Snapshot a vault-note record onto a node. `content` is Tektite's body
 * field; tolerate `body` too for callers that hand us a normalized shape. */
function _nodeNoteApplySnapshot(node, note) {
  if (!node.params) node.params = {};
  node.params.tektiteNoteId    = String(note.id);
  node.params.tektiteNoteTitle = String(note.title || note.id);
  node.params.tektiteNoteBody  = String(note.content != null ? note.content : (note.body || ""));
}

function _nodeNoteAttach(nodeId, note) {
  const node = nodeById(nodeId);
  if (!node || !note) return;
  pushHistory("attach-note:" + nodeId);
  _nodeNoteApplySnapshot(node, note);
  if (typeof render === "function") render();
  if (typeof renderProps === "function") renderProps();
}

function _nodeNoteDetach(nodeId) {
  const node = nodeById(nodeId);
  if (!node || !node.params || !node.params.tektiteNoteId) return;
  pushHistory("detach-note:" + nodeId);
  for (const k of NODE_NOTE_PARAM_KEYS) delete node.params[k];
  if (typeof render === "function") render();
  if (typeof renderProps === "function") renderProps();
}

/* Re-pull the linked note's current text from the vault. Keeps the link
 * even when the note has been deleted, so the user can re-create or detach. */
async function _nodeNoteRefresh(nodeId) {
  const node = nodeById(nodeId);
  if (!node || !node.params || !node.params.tektiteNoteId) return;
  let note = null;
  try { note = await tektiteGetNote(node.params.tektiteNoteId); } catch (_) {}
  if (!note) {
    window.alert("Linked note '" + node.params.tektiteNoteId +
      "' was not found in the vault. It stays linked -- detach, or re-create it in Tektite.");
    return;
  }
  pushHistory("refresh-note:" + nodeId);
  _nodeNoteApplySnapshot(node, note);
  if (typeof renderProps === "function") renderProps();
}

/* Surface the Tektite tab and float the linked note's editor popout. */
async function _nodeNoteOpenInTektite(nodeId) {
  const node = nodeById(nodeId);
  if (!node || !node.params || !node.params.tektiteNoteId) return;
  const tabBtn = document.getElementById("br-tab-tektite");
  if (tabBtn) tabBtn.click();
  if (typeof _tektitePopoutOpen === "function") {
    try { await _tektitePopoutOpen(node.params.tektiteNoteId); } catch (_) {}
  }
}

/* --- attach picker modal ------------------------------------------------- */

let _attachNoteModalEl = null;
let _attachNoteModalGen = 0; // incremented on each open; stale awaits bail out

function _nodeNoteCloseModal() {
  if (_attachNoteModalEl) { _attachNoteModalEl.remove(); _attachNoteModalEl = null; }
  document.removeEventListener("keydown", _nodeNoteModalKeydown, true);
}

function _nodeNoteModalKeydown(e) {
  if (e.key === "Escape" && _attachNoteModalEl) { e.stopPropagation(); _nodeNoteCloseModal(); }
}

async function openAttachNoteModal(nodeId) {
  const node = nodeById(nodeId);
  if (!node) return;
  _nodeNoteCloseModal();

  // Claim this invocation's generation token synchronously before yielding.
  // Any concurrent call that races through the await will see a newer token
  // and discard its result, preventing double-backdrop orphan.
  const myGen = ++_attachNoteModalGen;

  let notes = [];
  try { notes = await tektiteListNotes(); } catch (_) { notes = []; }

  // A newer openAttachNoteModal call started while we were awaiting -- bail.
  if (myGen !== _attachNoteModalGen) return;

  // Remove any backdrop that a concurrent call may have appended between our
  // await and this point (shouldn't happen given the gen-check above, but
  // guards against any future refactor that changes the guard order).
  if (_attachNoteModalEl) { _attachNoteModalEl.remove(); _attachNoteModalEl = null; }

  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.innerHTML =
    `<div class="modal" style="width:520px;">
       <div class="modal-head">
         <span>Attach documentation note &rarr; <code>${escapeText(node.type)}</code></span>
         <button class="btn modal-x" data-act="close" title="Close (Esc)">&times;</button>
       </div>
       <div class="modal-body">
         <p class="modal-note">Pick a Tektite vault note to document this node. Its markdown becomes a <code>/** */</code> doc comment in the generated C++ and travels inside the .gpatch.</p>
         <input type="text" id="node-note-filter" placeholder="Filter notes&hellip;" autocomplete="off"
                style="width:100%;height:30px;box-sizing:border-box;background:var(--bg);border:1px solid var(--border-strong);border-radius:3px;color:var(--text);font-size:12px;padding:0 10px;outline:none;margin-bottom:10px;" />
         <div id="node-note-list" style="max-height:46vh;overflow:auto;border:1px solid var(--border);border-radius:4px;"></div>
         <div class="modal-actions" style="margin-top:14px;">
           <button class="btn primary" data-act="new" style="flex:1;">&#43; New note for this node</button>
           <button class="btn" data-act="close">Cancel</button>
         </div>
       </div>
     </div>`;
  document.body.appendChild(back);
  _attachNoteModalEl = back;

  const listEl   = back.querySelector("#node-note-list");
  const filterEl = back.querySelector("#node-note-filter");
  const curId    = node.params && node.params.tektiteNoteId;

  const renderList = (q) => {
    const needle = (q || "").trim().toLowerCase();
    const rows = notes.filter(n => !needle ||
      (n.title || "").toLowerCase().includes(needle) ||
      (n.id || "").toLowerCase().includes(needle));
    if (!rows.length) {
      listEl.innerHTML =
        `<div style="padding:14px;color:var(--text-2);font-size:11.5px;">` +
        (notes.length ? "No notes match." : "Vault is empty -- create one below.") + `</div>`;
      return;
    }
    listEl.innerHTML = rows.map(n => {
      const isCur   = (n.id === curId);
      const selBg   = isCur ? "background:var(--surface-2);" : "";
      const preview = String(n.content || "").replace(/\s+/g, " ").trim().slice(0, 90);
      return `<div class="node-note-pick" data-id="${escapeAttr(n.id)}" role="button" tabindex="0"
                style="padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;${selBg}">
                <div style="font-size:12px;color:var(--text);font-weight:500;">${escapeText(n.title || n.id)}` +
                (isCur ? ` &middot; <span style="color:var(--accent,#67c8ff);font-weight:400;">attached</span>` : ``) +
                `</div>
                 <div style="font-size:10px;color:var(--text-2);font-family:var(--font-mono);">${escapeText(n.id)}</div>` +
                (preview ? `<div style="font-size:10.5px;color:var(--text-2);opacity:.75;margin-top:2px;">${escapeText(preview)}</div>` : ``) +
              `</div>`;
    }).join("");
    listEl.querySelectorAll(".node-note-pick").forEach(row => {
      const pick = () => {
        const note = notes.find(n => n.id === row.getAttribute("data-id"));
        if (note) { _nodeNoteAttach(nodeId, note); _nodeNoteCloseModal(); }
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
    });
  };
  renderList("");

  filterEl.addEventListener("input", () => renderList(filterEl.value));
  setTimeout(() => { try { filterEl.focus(); } catch (_) {} }, 30);

  back.addEventListener("mousedown", (e) => { if (e.target === back) _nodeNoteCloseModal(); });
  back.querySelectorAll('[data-act="close"]').forEach(b => b.addEventListener("click", _nodeNoteCloseModal));

  back.querySelector('[data-act="new"]').addEventListener("click", async () => {
    const existing = new Set(notes.map(n => n.id));
    const base = tektiteSlugify(node.type + "-" + node.id) || ("node-" + node.id);
    let id = base, i = 2;
    while (existing.has(id)) { id = base + "-" + i; i++; }
    const title   = node.type + " · " + node.id;
    const content = "# " + title + "\n\nDocumentation for the `" + node.type + "` node.\n";
    let saved = null;
    try { saved = await tektitePutNote({ id, title, content }); } catch (e) {
      window.alert("Could not create note: " + (e && e.message ? e.message : e));
      return;
    }
    if (saved) {
      _nodeNoteAttach(nodeId, saved);
      _nodeNoteCloseModal();
      if (typeof _tektiteTabRefresh === "function") { try { await _tektiteTabRefresh(); } catch (_) {} }
    }
  });

  document.addEventListener("keydown", _nodeNoteModalKeydown, true);
}
