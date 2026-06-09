/* ============================================================================
 * Phase C §5.4 / §7.4 -- notes-in-gpatch (round-trip of attached notes)
 *
 * Notes attached to graph nodes (the node-note-attach sprint) already TRAVEL
 * inside a .gpatch: their {id, title, body} snapshot lives in node.params,
 * which the patch serializer writes whole. This module closes the loop on
 * LOAD -- when a patch carries documentation notes that aren't in the local
 * Tektite vault (e.g. it was authored on another machine), it offers to
 * import them so Open / Refresh work and the knowledge base reconstitutes.
 *
 * Opt-in + non-destructive: the import runs only after a user confirm and
 * only for notes genuinely missing from the vault; existing notes are never
 * overwritten (the in-patch snapshot defers to the live vault copy).
 * ==========================================================================*/

/* Deduped set of attached notes embedded across a node list. */
function tektiteCollectAttachedNotes(nodes) {
  const byId = new Map();
  if (!Array.isArray(nodes)) return [];
  for (const n of nodes) {
    const p = n && n.params;
    if (!p || !p.tektiteNoteId) continue;
    const id = String(p.tektiteNoteId);
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      title:   String(p.tektiteNoteTitle || id),
      content: (typeof p.tektiteNoteBody === "string") ? p.tektiteNoteBody : ""
    });
  }
  return Array.from(byId.values());
}

/* On patch load: import any embedded notes missing from the vault (opt-in). */
async function tektiteRehydrateNotesFromPatch(nodes) {
  const embedded = tektiteCollectAttachedNotes(nodes);
  if (!embedded.length) return;
  if (typeof tektiteGetNote !== "function" || typeof tektitePutNote !== "function") return;

  const missing = [];
  for (const note of embedded) {
    let existing = null;
    try { existing = await tektiteGetNote(note.id); } catch (_) {}
    if (!existing) missing.push(note);
  }
  if (!missing.length) return;

  const names = missing.slice(0, 8).map(n => "  • " + n.title).join("\n");
  const more  = missing.length > 8 ? "\n  …and " + (missing.length - 8) + " more" : "";
  const ok = window.confirm(
    "This patch carries " + missing.length + " documentation note" +
    (missing.length === 1 ? "" : "s") + " not in your Tektite vault:\n\n" +
    names + more + "\n\nImport them into your vault?"
  );
  if (!ok) return;

  let imported = 0;
  for (const note of missing) {
    try { await tektitePutNote({ id: note.id, title: note.title, content: note.content }); imported++; }
    catch (_) {}
  }
  if (typeof _tektiteTabRefresh === "function") { try { await _tektiteTabRefresh(); } catch (_) {} }
  if (imported) console.log("[tektite] imported " + imported + " note(s) from the loaded patch into the vault");
}
