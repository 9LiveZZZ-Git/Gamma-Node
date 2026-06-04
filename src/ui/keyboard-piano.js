/* ------------- Keyboard-input driver ------------- */
/* Maps QWERTY rows to a 1.5-octave virtual keyboard. White keys on the
 * home row (A=C4 … L=E5+), black keys on the row above. When a
 * KeyboardIn node is present in the patch and preview is playing,
 * keydown sends two messages to the worklet:
 *
 *   1. preview_set(<freq setter index for the KeyboardIn node>, freqHz)
 *   2. preview_set(<i>, 0) for each isGate setter in the patch
 *      → retriggers AD/AHD/etc. envelopes on every press.
 *
 * keyup is a no-op (held notes sustain until envelope releases on its
 * own). Doesn't capture when the focused element is text-input —
 * typing into the patch name or User-DSP editor still works. */
const QWERTY_TO_MIDI = {
  // White keys (home row) — A=C4, S=D4, D=E4, F=F4, G=G4, H=A4, J=B4, K=C5, L=D5, ";"=E5
  "a": 60, "s": 62, "d": 64, "f": 65, "g": 67, "h": 69, "j": 71, "k": 72, "l": 74, ";": 76,
  // Black keys (top row) — W=C#4, E=D#4, T=F#4, Y=G#4, U=A#4, O=C#5, P=D#5
  "w": 61, "e": 63, "t": 66, "y": 68, "u": 70, "o": 73, "p": 75
};
const kbHeldKeys = new Set();
// Per-key frequency overrides: { qwertyKey: hz }. Set rows ignore the
// MIDI mapping and the octave shift — pinned to whatever Hz the user
// typed in the keymap modal. Empty rows fall back to default behavior.
let kbCustomFreqs = (function () {
  try {
    const raw = localStorage.getItem("gamma-kb-key-freqs");
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch (_) { return {}; }
})();
function saveCustomFreqs() {
  try { localStorage.setItem("gamma-kb-key-freqs", JSON.stringify(kbCustomFreqs)); } catch (_) {}
}
// Octave-shift state. Z lowers, X raises, in 12-semitone steps.
// Persists to localStorage so the shift survives reloads.
let kbOctaveShift = (function () {
  try { return parseInt(localStorage.getItem("gamma-kb-octave-shift") || "0", 10) || 0; }
  catch (_) { return 0; }
})();
const KB_OCTAVE_MIN = -36, KB_OCTAVE_MAX = 36;     // ±3 octaves of headroom
function setKbOctaveShift(s) {
  kbOctaveShift = Math.max(KB_OCTAVE_MIN, Math.min(KB_OCTAVE_MAX, s));
  try { localStorage.setItem("gamma-kb-octave-shift", String(kbOctaveShift)); } catch (_) {}
  updateOctaveReadout();
  // Re-render piano to reposition the highlighted octave window.
  renderPiano();
  // Mirror octave label / key letters to the touchscreen popup.
  if (typeof _pushTouchControlsSnapshot === "function") _pushTouchControlsSnapshot();
}
function updateOctaveReadout() {
  const r = document.getElementById("piano-octave-readout");
  if (!r) return;
  const semis = kbOctaveShift;
  const oct = semis / 12;
  if (semis === 0) r.textContent = "octave 0";
  else r.textContent = "octave " + (oct >= 0 ? "+" : "") + oct;
}
function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

function findKeyboardSetterIndex() {
  const setters = collectExposedSetters();
  for (let i = 0; i < setters.length; i++) {
    const s = setters[i];
    if (s.nodeType === "KeyboardIn" && s.key === "freq" && !s.isGate) return i;
  }
  return -1;
}
/* Gate setters split by role. "press" = anything that should fire on
 * key-down (the default — covers AD.trig, Button.press, KeyboardIn's
 * trigger, etc.); "release" = anything bound to a key-up event. The
 * heuristic is purely by setter key name: "rel" / "release" are
 * release; everything else is press. Without this split, adding
 * KeyboardIn's rel hostGate would cause press-and-immediate-release
 * since the JS used to fire ALL gate setters on every keydown. */
function listGateSetterIndices(role) {
  role = role || "press";
  const setters = collectExposedSetters();
  const out = [];
  setters.forEach((s, i) => {
    if (!s.isGate) return;
    const isRelease = (s.key === "rel" || s.key === "release");
    if (role === "release" ? isRelease : !isRelease) out.push(i);
  });
  return out;
}

/* Trigger one note. Sends freq + every exposed gate, lights the
 * matching piano key, updates the readout. Source can be the
 * QWERTY keydown handler or a piano-key mouse click. */
function playKeyboardNote(qwertyKey) {
  if (!(qwertyKey in QWERTY_TO_MIDI)) return false;
  if (!previewState.workletNode || previewState.state !== "playing") return false;
  const kbIdx = findKeyboardSetterIndex();
  if (kbIdx < 0) return false;
  // Custom override wins; otherwise apply the octave-shifted default.
  let midi, freq;
  if (typeof kbCustomFreqs[qwertyKey] === "number" && isFinite(kbCustomFreqs[qwertyKey])) {
    freq = kbCustomFreqs[qwertyKey];
    midi = freqToMidi(freq);
  } else {
    midi = QWERTY_TO_MIDI[qwertyKey] + kbOctaveShift;
    freq = midiToFreq(midi);
  }
  previewState.workletNode.port.postMessage({ type: "set", index: kbIdx, value: freq });
  // Fire only press-style gate setters (trigger / press / reset).
  // Release-style gates (KeyboardIn.rel / ADSR.rel) fire on key-up.
  listGateSetterIndices("press").forEach(i => {
    previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
  });
  highlightPianoKey(qwertyKey, true);
  updatePianoReadout(midi, freq);
  return true;
}
// Reverse of midiToFreq — used to display a meaningful note name when
// a key has been overridden to an arbitrary Hz value.
function freqToMidi(hz) {
  if (!hz || !isFinite(hz) || hz <= 0) return 0;
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

/* Sprint 5.handwriting-multimonitor -- MIDI-direct play/release for
 * the touchscreen popup's multi-octave keyboard. playKeyboardNote
 * is QWERTY-keyed (and only handles the one octave QWERTY_TO_MIDI
 * spans); the touch keyboard can reach any MIDI note. Same audio
 * path otherwise: write freq to KeyboardIn.setFreq, fire all press
 * gates (release fires the rel gates). Also highlights the on-
 * screen piano key if the MIDI value happens to land in the visible
 * QWERTY-mapped octave -- otherwise no highlight, since the main
 * piano widget only renders that octave. */
function playKeyboardMidi(midi) {
  if (!previewState.workletNode || previewState.state !== "playing") return false;
  const kbIdx = findKeyboardSetterIndex();
  if (kbIdx < 0) return false;
  const freq = midiToFreq(midi);
  previewState.workletNode.port.postMessage({ type: "set", index: kbIdx, value: freq });
  listGateSetterIndices("press").forEach(i => {
    previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
  });
  // If the MIDI value maps to a visible QWERTY key (under the
  // current octave shift), light it up so the user sees their
  // touchscreen press on main's piano too.
  const qk = midiToQwertyAt(midi);
  if (qk) highlightPianoKey(qk, true);
  updatePianoReadout(midi, freq);
  return true;
}
function releaseKeyboardMidi(midi) {
  if (previewState.workletNode && previewState.state === "playing") {
    listGateSetterIndices("release").forEach(i => {
      previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
    });
  }
  const qk = midiToQwertyAt(midi);
  if (qk) highlightPianoKey(qk, false);
}
// Reverse-lookup: which QWERTY letter maps to this MIDI note (with
// the current octave shift applied)? Returns null if outside the
// QWERTY-mapped range. Used to highlight main's piano widget for
// touchscreen-initiated notes that land in the visible octave.
function midiToQwertyAt(midi) {
  for (const k in QWERTY_TO_MIDI) {
    if ((QWERTY_TO_MIDI[k] + kbOctaveShift) === midi) return k;
  }
  return null;
}
function releaseKeyboardNote(qwertyKey) {
  if (!(qwertyKey in QWERTY_TO_MIDI)) return;
  highlightPianoKey(qwertyKey, false);
  // Fire any release-style gate setters (KeyboardIn.rel → ADSR.rel etc).
  // Lets a held QWERTY key sustain an ADSR envelope; key-up triggers
  // the release stage. No-op if no release gate is exposed.
  if (previewState.workletNode && previewState.state === "playing") {
    listGateSetterIndices("release").forEach(i => {
      previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
    });
  }
}

document.addEventListener("keydown", (ev) => {
  if (ev.repeat) return;
  const tgt = ev.target;
  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  // Z / X — octave shift while audio is live. Active in any state so
  // users can pre-set the octave before clicking Play.
  if (k === "z") { ev.preventDefault(); setKbOctaveShift(kbOctaveShift - 12); return; }
  if (k === "x") { ev.preventDefault(); setKbOctaveShift(kbOctaveShift + 12); return; }
  if (!(k in QWERTY_TO_MIDI)) return;
  ev.preventDefault();
  if (kbHeldKeys.has(k)) return;
  kbHeldKeys.add(k);
  playKeyboardNote(k);
});
document.addEventListener("keyup", (ev) => {
  const k = ev.key.toLowerCase();
  if (k in QWERTY_TO_MIDI) {
    kbHeldKeys.delete(k);
    releaseKeyboardNote(k);
  }
});

/* ------------- On-screen piano widget ------------- */
/* Mirrors QWERTY_TO_MIDI as a one-octave-and-change visual keyboard.
 * Active state is set by playKeyboardNote / releaseKeyboardNote so
 * QWERTY presses, mouse clicks, and any future MIDI input paths all
 * surface through the same lit-key feedback. */
const PIANO_LAYOUT = [
  // [qwertyKey, "white" | "black", label] — order matches MIDI ascending
  ["a","white"], ["w","black"], ["s","white"], ["e","black"], ["d","white"],
  ["f","white"], ["t","black"], ["g","white"], ["y","black"], ["h","white"],
  ["u","black"], ["j","white"], ["k","white"], ["o","black"], ["l","white"],
  ["p","black"], [";","white"]
];
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function midiName(m) {
  return NOTE_NAMES[((m % 12) + 12) % 12] + Math.floor(m / 12 - 1);
}
function renderPiano() {
  const wrap = document.getElementById("piano-keys");
  if (!wrap) return;
  wrap.innerHTML = "";
  // Show three octaves of keys (C3..B5 = MIDI 48..83 — 21 white keys).
  // The MIDI range covered by QWERTY_TO_MIDI (60..76) plus octave shift
  // is highlighted as the playable window; out-of-window keys render
  // dimmer with no QWERTY label.
  const PLAYABLE_LO = 60 + kbOctaveShift;
  const PLAYABLE_HI = 76 + kbOctaveShift;
  // Reverse map: midi → qwerty (for the playable window).
  const midiToQwerty = {};
  Object.entries(QWERTY_TO_MIDI).forEach(([k, m]) => { midiToQwerty[m + kbOctaveShift] = k; });
  // Black-key flag per chroma.
  const isBlack = (m) => [1,3,6,8,10].includes(((m % 12) + 12) % 12);
  const RANGE_LO = 48, RANGE_HI = 83;
  let whiteIndex = 0;
  for (let m = RANGE_LO; m <= RANGE_HI; m++) {
    const black = isBlack(m);
    const qwerty = midiToQwerty[m] || null;
    const inWindow = (m >= PLAYABLE_LO && m <= PLAYABLE_HI);
    const el = document.createElement("div");
    el.className = "piano-key " + (black ? "black" : "white") + (inWindow ? "" : " inactive");
    el.dataset.midi = String(m);
    if (qwerty) el.dataset.qwerty = qwerty;
    // Custom-frequency override mark — amber underline so the user can
    // see at a glance which keys are pinned.
    if (qwerty && typeof kbCustomFreqs[qwerty] === "number") {
      el.classList.add("overridden");
    }
    // Label: QWERTY letter if this MIDI is mapped, else the note name
    // for the C key of each octave (orientation marker).
    if (qwerty) {
      el.textContent = qwerty === ";" ? ";" : qwerty;
    } else if (((m % 12) + 12) % 12 === 0 && !black) {
      // Show "C4" / "C5" / ... on every C as an orientation marker.
      el.textContent = "C" + (Math.floor(m / 12 - 1));
      el.classList.add("octave-marker");
    } else {
      el.textContent = "";
    }
    if (black) {
      el.style.left = (1 + whiteIndex * 31 - 10) + "px";
      wrap.appendChild(el);
    } else {
      wrap.appendChild(el);
      whiteIndex++;
    }
  }
  // Pointer interactions: mouse plays whichever MIDI the key carries
  // (regardless of whether it has a QWERTY mapping in the current
  // window). Lets the user reach any note via mouse without shifting.
  wrap.querySelectorAll(".piano-key").forEach(el => {
    const m = parseInt(el.dataset.midi, 10);
    const onDown = (ev) => { ev.preventDefault(); playMidi(m, el); };
    const onUp   = ()     => { releaseMidi(el); };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup",   onUp);
    el.addEventListener("pointerleave",onUp);
  });
  updateOctaveReadout();
}
// Mouse-driven note play — bypasses the qwerty→midi map so users can
// click any key in the visible 3-octave range, not just those bound
// to letters in the current window.
function playMidi(midi, keyEl) {
  if (!previewState.workletNode || previewState.state !== "playing") return;
  const kbIdx = findKeyboardSetterIndex();
  if (kbIdx < 0) return;
  const freq = midiToFreq(midi);
  previewState.workletNode.port.postMessage({ type: "set", index: kbIdx, value: freq });
  listGateSetterIndices("press").forEach(i => {
    previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
  });
  if (keyEl) keyEl.classList.add("active");
  updatePianoReadout(midi, freq);
}
/* Mouse-up on a piano key — counterpart to playMidi. Fires any
 * release-gate setters so an ADSR envelope's release stage triggers
 * when the user lets go of a clicked key. */
function releaseMidi(keyEl) {
  if (keyEl) keyEl.classList.remove("active");
  if (!previewState.workletNode || previewState.state !== "playing") return;
  listGateSetterIndices("release").forEach(i => {
    previewState.workletNode.port.postMessage({ type: "set", index: i, value: 0 });
  });
}
function highlightPianoKey(qwertyKey, on) {
  const wrap = document.getElementById("piano-keys");
  if (!wrap) return;
  const el = wrap.querySelector('[data-qwerty="' + qwertyKey.replace('"','\\"') + '"]');
  if (!el) return;
  el.classList.toggle("active", !!on);
}
function updatePianoReadout(midi, freq) {
  const r = document.getElementById("piano-readout");
  if (!r) return;
  r.innerHTML =
    midiName(midi) +
    ' <span class="dim">·</span> ' +
    Math.round(freq) + 'hz' +
    ' <span class="dim">·</span> ' +
    'midi ' + midi;
}
function resetPiano() {
  document.querySelectorAll(".piano-key.active").forEach(el => el.classList.remove("active"));
  const r = document.getElementById("piano-readout");
  if (r) r.innerHTML = '<span class="dim">no note</span>';
  const status = document.getElementById("monitor-status");
  if (status) status.textContent = "idle";
}
function showPiano() {
  // Piano is now part of the Monitor tab — no visibility toggle needed.
  // Just update the status readout so users know audio is live.
  const status = document.getElementById("monitor-status");
  if (status) status.textContent = "live";
}
renderPiano();

/* ------------- Per-key frequency override modal ------------- */
/* Lists every QWERTY key bound by QWERTY_TO_MIDI; user types an Hz
 * value to pin that key, leaves blank to fall back to the default
 * MIDI mapping. Pinned keys ignore octave shift. */
function openKeymapModal() {
  const modal = document.getElementById("keymap-modal");
  const grid  = document.getElementById("keymap-grid");
  if (!modal || !grid) return;
  // Build rows in MIDI ascending order to match the piano layout.
  const ordered = Object.entries(QWERTY_TO_MIDI).sort((a, b) => a[1] - b[1]);
  grid.innerHTML = "";
  ordered.forEach(([k, midi]) => {
    const defFreq = midiToFreq(midi);
    const cur = kbCustomFreqs[k];
    const isSet = typeof cur === "number" && isFinite(cur);
    const row = document.createElement("div");
    row.className = "keymap-row";
    row.innerHTML =
      '<div class="keymap-letter">' + (k === ";" ? ";" : k) + '</div>' +
      '<div class="keymap-default">' + midiName(midi) + ' · ' + defFreq.toFixed(1) + 'hz</div>' +
      '<input class="keymap-input' + (isSet ? ' set' : '') + '" type="number" step="any" min="1" placeholder="' + defFreq.toFixed(2) + '" value="' + (isSet ? cur : '') + '" data-key="' + k + '" />' +
      '<button class="keymap-clear" data-key="' + k + '" title="Clear override"' + (isSet ? '' : ' disabled') + '>×</button>';
    grid.appendChild(row);
  });
  // Wire input + clear handlers.
  grid.querySelectorAll(".keymap-input").forEach(inp => {
    inp.addEventListener("input", () => {
      const k = inp.dataset.key;
      const v = parseFloat(inp.value);
      if (isFinite(v) && v > 0) {
        kbCustomFreqs[k] = v;
        inp.classList.add("set");
        const btn = grid.querySelector('.keymap-clear[data-key="' + k.replace('"','\\"') + '"]');
        if (btn) btn.disabled = false;
      } else {
        delete kbCustomFreqs[k];
        inp.classList.remove("set");
        const btn = grid.querySelector('.keymap-clear[data-key="' + k.replace('"','\\"') + '"]');
        if (btn) btn.disabled = true;
      }
      saveCustomFreqs();
      renderPiano();
    });
  });
  grid.querySelectorAll(".keymap-clear").forEach(btn => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.key;
      delete kbCustomFreqs[k];
      saveCustomFreqs();
      const inp = grid.querySelector('.keymap-input[data-key="' + k.replace('"','\\"') + '"]');
      if (inp) { inp.value = ""; inp.classList.remove("set"); }
      btn.disabled = true;
      renderPiano();
    });
  });
  modal.style.display = "flex";
}
function closeKeymapModal() {
  const modal = document.getElementById("keymap-modal");
  if (modal) modal.style.display = "none";
}
(function setupKeymapModal() {
  const open = document.getElementById("btn-keymap-edit");
  const close = document.getElementById("btn-keymap-close");
  const done = document.getElementById("btn-keymap-done");
  const reset = document.getElementById("btn-keymap-reset");
  const modal = document.getElementById("keymap-modal");
  if (!open || !modal) return;
  open.addEventListener("click", openKeymapModal);
  if (close) close.addEventListener("click", closeKeymapModal);
  if (done)  done .addEventListener("click", closeKeymapModal);
  if (reset) reset.addEventListener("click", () => {
    kbCustomFreqs = {};
    saveCustomFreqs();
    renderPiano();
    openKeymapModal();   // rebuild the rows with cleared values
  });
  modal.addEventListener("click", e => { if (e.target === modal) closeKeymapModal(); });
})();

