// M2.11 extractor: six-way split of src/_monolith.tail.2.1.js
// (~133 KB / ~3119 lines) at section-divider boundaries.
//
// Layout:
//   src/ui/code-preview.js     (~1 KB / lines 1-32)
//       highlightCpp (basic C++ syntax highlighter for the Code
//       preview tab), renderCode (calls generateCode + paints into
//       the tab), _omitRuntimeKeys + renderJson (the .gpatch JSON
//       view).
//
//   src/ui/touch.js            (~37 KB / lines 33-1027)
//       Touch handling cluster:
//         * Touch helpers: _midpoint, _ptDist, _endTouchPointer
//         * Touch hold-and-swipe context menu: TOUCH_HOLD_MS,
//           _ensureTouchMenu, _showTouchMenu, _hideTouchMenu,
//           _highlightChipAt, _chipActionAt, _startTouchHold,
//           _cancelTouchHold, _fireTouchHold, _commitTouchAction
//         * Marquee paint, isTextInput, deleteSelection
//         * Copy / paste / duplicate -- CLIPBOARD_MIME,
//           serializeSelection, pasteFragment,
//           copySelectionToClipboard, pasteFromClipboard,
//           duplicateSelection.
//
//   src/ui/tabs.js             (~4 KB / lines 1028-1123)
//       Sidebar tabs (Patch / Code / Build / etc.): switchTab +
//       editable patch filename in the title bar.
//
//   src/persistence/patch-load.js (~25 KB / lines 1124-1692)
//       Patch loading + prefab modals:
//         _applyLoadedPatch (the post-decode reconciliation that
//         hydrates state, runs migrations, schedules the
//         post-load render),
//         _dropPrefabInstance (drop a prefab template onto the
//         canvas as an instance with its overrides),
//         _openPrefabSaveModal / _closePrefabSaveModal /
//         _commitPrefabSave (Save selection as prefab),
//         _openPrefabPickModal / _closePrefabPickModal,
//         _dropPrefabFromAsset (insert a prefab from the asset
//         registry), switchCodePreviewSub.
//
//   src/ui/user-dsp.js         (~14 KB / lines 1693-2009)
//       User DSP tab -- bundled .gdsp authoring UI:
//         GDSP_TEMPLATE (the BitCrush starter scaffold),
//         Community library cache (COMMUNITY_CACHE_KEY,
//         COMMUNITY_TTL_MS, COMMUNITY_REPO, COMMUNITY_BRANCH),
//         renderUdspList, setUdspStatus, submit-to-community
//         flow, localStorage persistence
//         (LS_KEY = "gamma-editor-userdsp-v1",
//          saveUserDspToStorage, loadUserDspFromStorage).
//
//   src/ai/settings.js         (~50 KB / lines 2010-EOF)
//       AI assistant for .gdsp authoring:
//         AI_LS_KEY localStorage, aiSettings, aiPending,
//         loadAiSettings, defaultAiSettings, saveAiSettings,
//         provider-pluggable PROVIDERS map (Anthropic / Gemma 4
//         / etc. -- each entry is { fetch, parseResponse,
//         defaultModel, headers }), system prompt builder
//         (built fresh from the actual .gdsp directives the
//         editor parses so it can't drift), full UI for the
//         AI settings panel.
//
// Source file is fully consumed and deleted.
//
// Pure relocation: no code changes. `node build.mjs` must regenerate
// a byte-identical gamma-node-editor.html.

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync
} from "node:fs";

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

function leadingCommentStart(src, idx) {
  let i = idx;
  while (i > 0 && (src[i - 1] === " " || src[i - 1] === "\t" || src[i - 1] === "\r" || src[i - 1] === "\n")) i--;
  if (i >= 2 && src[i - 1] === "/" && src[i - 2] === "*") {
    const open = src.lastIndexOf("/*", i - 3);
    if (open >= 0) {
      let j = open;
      while (j > 0 && (src[j - 1] === " " || src[j - 1] === "\t")) j--;
      return j;
    }
  }
  let j = idx;
  while (j > 0 && (src[j - 1] === " " || src[j - 1] === "\t")) j--;
  return j;
}

const sourcePath = "src/_monolith.tail.2.1.js";
const src = readFileSync(sourcePath, "utf8");

function cutAtDivider(src, marker, from = 0, prefix = "/* ====") {
  const anchor = src.indexOf(marker, from);
  if (anchor < 0) throw new Error(`anchor not found: ${marker}`);
  const open = src.lastIndexOf(prefix, anchor);
  if (open < 0) throw new Error(`${prefix} not found before: ${marker}`);
  let pos = open;
  while (pos > 0 && (src[pos - 1] === " " || src[pos - 1] === "\t")) pos--;
  return pos;
}

// Cuts at section / function boundaries.
const cut1 = cutAtDivider(src, "Pointer interactions");        // line 33
const cut2 = cutAtDivider(src, "Toolbar", cut1);               // line 1124
const cut3 = cutAtDivider(src, "User DSP UI", cut2);           // line 1693
const cut4 = cutAtDivider(src, "AI assistant for", cut3);      // line 2010
const cut5 = cutAtDivider(src, "Canvas tools: Select", cut4);  // line 3081

if (!(0 < cut1 && cut1 < cut2 && cut2 < cut3 && cut3 < cut4 && cut4 < cut5 && cut5 < src.length)) {
  throw new Error("cut points not strictly increasing");
}

console.log("M2.11 six-way split cut points:");
console.log("  cut1 (pointer start):    ", cut1, "line", lineOf(src, cut1));
console.log("  cut2 (toolbar+patch):    ", cut2, "line", lineOf(src, cut2));
console.log("  cut3 (user-dsp):         ", cut3, "line", lineOf(src, cut3));
console.log("  cut4 (ai settings):      ", cut4, "line", lineOf(src, cut4));
console.log("  cut5 (canvas tools):     ", cut5, "line", lineOf(src, cut5));

const codePreview   = src.slice(0,    cut1);
const pointer       = src.slice(cut1, cut2);
const toolbarPatch  = src.slice(cut2, cut3);
const userDsp       = src.slice(cut3, cut4);
const aiSettings    = src.slice(cut4, cut5);
const canvasTools   = src.slice(cut5);

const sum = codePreview.length + pointer.length + toolbarPatch.length + userDsp.length + aiSettings.length + canvasTools.length;
if (sum !== src.length) throw new Error("slice math wrong");

mkdirSync("src/ui", { recursive: true });
mkdirSync("src/ai", { recursive: true });

writeFileSync("src/ui/code-preview.js",   codePreview);
writeFileSync("src/ui/pointer.js",        pointer);
writeFileSync("src/ui/toolbar-patch.js",  toolbarPatch);
writeFileSync("src/ui/user-dsp.js",       userDsp);
writeFileSync("src/ai/settings.js",       aiSettings);
writeFileSync("src/ui/canvas-tools.js",   canvasTools);

const manifestPath = "src/build-order.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const idx = manifest.js.indexOf("_monolith.tail.2.1.js");
if (idx < 0) throw new Error("manifest entry _monolith.tail.2.1.js not found");
manifest.js.splice(idx, 1,
  "ui/code-preview.js",
  "ui/pointer.js",
  "ui/toolbar-patch.js",
  "ui/user-dsp.js",
  "ai/settings.js",
  "ui/canvas-tools.js"
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (existsSync(sourcePath)) unlinkSync(sourcePath);

const fmt = n => n.toLocaleString();
console.log("");
console.log("M2.11 six-way split complete (pure relocation):");
console.log("  src/ui/code-preview.js    ", fmt(codePreview.length).padStart(11),  "bytes");
console.log("  src/ui/pointer.js         ", fmt(pointer.length).padStart(11),      "bytes");
console.log("  src/ui/toolbar-patch.js   ", fmt(toolbarPatch.length).padStart(11), "bytes");
console.log("  src/ui/user-dsp.js        ", fmt(userDsp.length).padStart(11),      "bytes");
console.log("  src/ai/settings.js        ", fmt(aiSettings.length).padStart(11),   "bytes");
console.log("  src/ui/canvas-tools.js    ", fmt(canvasTools.length).padStart(11),  "bytes");
console.log("  ────────────────────────────────────────");
console.log("  sum                           ", fmt(sum).padStart(11), "bytes");
console.log("  original tail.2.1.js          ", fmt(src.length).padStart(11), "bytes  (deleted)");
console.log("");
console.log("Manifest js order:", manifest.js.join(" -> "));
console.log("");
console.log("Next: node build.mjs && cmp /tmp/m2-tail21-before.html gamma-node-editor.html");
