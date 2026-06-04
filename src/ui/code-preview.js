

function highlightCpp(code) {
  return code
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/(#\w+(?:\s+&lt;[^&]+&gt;)?)/g, '<span class="pp">$1</span>')
    .replace(/\b(class|public|private|void|float|return|new|auto|template)\b/g, '<span class="kw">$1</span>')
    .replace(/(gam::[A-Za-z0-9_]+(?:&lt;[^&]*&gt;)?)/g, '<span class="ty">$1</span>')
    .replace(/(std::[A-Za-z0-9_]+(?:&lt;[^&]*&gt;)?)/g, '<span class="ty">$1</span>')
    .replace(/\b(\d+\.?\d*f?)\b/g, '<span class="nu">$1</span>');
}

function renderCode() {
  codeOut.innerHTML = highlightCpp(generateCode());
}

/* JSON.stringify replacer that strips runtime-only fields (any key
 * prefixed with `_`) from serialization. Currently in use:
 *   - state._cycleErrors  — cycle-detector cache rebuilt on each render
 *   - notes[i]._id        — piano-roll selection key, regenerated on
 *                           open from the (start, dur, midi, vel) tuple
 * Both .gpatch save and the JSON preview tab use this so transient
 * editor bookkeeping never lands in source files or pasted snippets. */
function _omitRuntimeKeys(key, val) {
  if (typeof key === "string" && key.length > 0 && key.charCodeAt(0) === 95) return undefined;
  return val;
}

function renderJson() {
  jsonOut.textContent = JSON.stringify(state, _omitRuntimeKeys, 2);
}

