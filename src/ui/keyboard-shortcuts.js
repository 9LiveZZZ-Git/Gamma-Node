/* =========================================================================
 * Tool keyboard shortcuts
 * ======================================================================== */
document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  // While audio preview is playing AND the patch has a KeyboardIn,
  // bare letters belong to the on-screen instrument — don't steal
  // them for tool shortcuts. (D conflicts with E4; Z/X are reserved
  // below for octave shift.)
  const lk = (e.key || "").toLowerCase();
  if (previewState.state === "playing" && (lk in QWERTY_TO_MIDI || lk === "z" || lk === "x")) return;
  if (e.key === "v" || e.key === "V") setTool("select");
  if (e.key === "d" || e.key === "D") setTool("draw");
  // Sprint 5.smart-link -- W auto-wires the current selection
  // left-to-right; Shift+W asks the AI provider to propose edges
  // for the whole patch. Same playing-keyboard gate as V/D
  // (already checked at the top of this handler since "w" is in
  // QWERTY_TO_MIDI = C#4).
  //
  // e.key === "W" with shiftKey === true catches normal Shift+W;
  // unshifted caps-lock W falls through to the multi-select path.
  if (e.key === "W" && e.shiftKey) {
    _aiAutoConnect();
  } else if (e.key === "w" || e.key === "W") {
    _autoConnectSelection();
  }
});

