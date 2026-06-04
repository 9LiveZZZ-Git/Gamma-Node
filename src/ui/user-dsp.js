/* =========================================================================
 * User DSP UI — left list of registered .gdsp types, right code editor
 * ======================================================================== */
const GDSP_TEMPLATE = `// @gdsp-name        BitCrush
// @gdsp-category    UserDSP
// @gdsp-description Sample-rate and bit-depth reducer
// @gdsp-color       #c8e85a
// @gdsp-input       in    audio
// @gdsp-input       bits  param  8
// @gdsp-input       rate  param  0.5
// @gdsp-output      out   audio
// @gdsp-method      bits  setBits

#include <cmath>

class BitCrush {
    float held = 0.f;
    float phase = 0.f;
    float rate_ = 0.5f;
    int   bits_ = 8;
public:
    void rate(float v)    { rate_ = v; }
    void setBits(float v) { bits_ = (int)v; }

    float operator()(float in) {
        phase += rate_;
        if (phase >= 1.f) {
            phase -= 1.f;
            float step = float(1 << bits_);
            held = std::floor(in * step) / step;
        }
        return held;
    }
};
`;

let editingUdsp = null;  // null = new file; otherwise the type name being edited

/* ---------- Community library cache ----------
 * Fetched on first User DSP tab activation, then cached in localStorage
 * for one hour so we don't burn rate-limit budget on every page load.
 * The list shows above the user's local saves; clicking an entry pulls
 * the source into the editor as a fresh draft (Save & Add to keep). */
const COMMUNITY_CACHE_KEY = "gamma-editor-community-cache-v1";
const COMMUNITY_TTL_MS = 60 * 60 * 1000;
let communityCache = null;     // { fetchedAt, items: [{name, sha, html_url, source?, directives?}] }
let communityLoading = false;
let communityError = null;

async function loadCommunityList(force) {
  if (communityLoading) return;
  if (!force) {
    try {
      const raw = localStorage.getItem(COMMUNITY_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Date.now() - parsed.fetchedAt < COMMUNITY_TTL_MS) {
          communityCache = parsed;
          renderUdspList();
          return;
        }
      }
    } catch (_) {}
  }
  communityLoading = true;
  communityError = null;
  renderUdspList();
  try {
    const url = `https://api.github.com/repos/${COMMUNITY_REPO}/contents/gdsp`;
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const items = data
      .filter(f => f.type === "file" && f.name.endsWith(".gdsp"))
      .map(f => ({
        name: f.name.replace(/\.gdsp$/, ""),
        sha: f.sha,
        html_url: f.html_url,
        download_url: f.download_url
      }));
    communityCache = { fetchedAt: Date.now(), items };
    try { localStorage.setItem(COMMUNITY_CACHE_KEY, JSON.stringify(communityCache)); } catch (_) {}
  } catch (e) {
    communityError = e.message;
  } finally {
    communityLoading = false;
    renderUdspList();
  }
}

async function loadCommunityItem(item) {
  setUdspStatus(`Loading ${item.name}.gdsp…`, "");
  try {
    const res = await fetch(item.download_url);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const text = await res.text();
    editingUdsp = null;     // treat as a fresh draft, not editing the community file
    setUdspText(text);
    setUdspStatus(`Loaded ${item.name} from community — Save & Add to keep, or edit and Submit a PR.`, "ok");
    renderUdspList();
  } catch (e) {
    setUdspStatus("Could not load community item: " + e.message, "err");
  }
}

function renderUdspList() {
  let html = "";

  // ---- Community section ----
  html += `<div class="udsp-section-head">Community
    <span class="reload" id="udsp-comm-reload" title="Refresh from github.com">↻</span>
  </div>`;
  if (communityLoading) {
    html += `<div class="udsp-comm-status">Fetching community library…</div>`;
  } else if (communityError) {
    html += `<div class="udsp-comm-status err">Couldn't reach github.com — ${escapeText(communityError)}</div>`;
  } else if (!communityCache || !communityCache.items.length) {
    html += `<div class="udsp-comm-status">No community library yet.</div>`;
  } else {
    html += `<div class="udsp-comm-list">`;
    communityCache.items.forEach(it => {
      html += `<div class="udsp-list-item" data-comm="${escapeAttr(it.name)}">
        <span class="dot" style="background:#7f77dd"></span>
        <span class="name">${escapeText(it.name)}</span>
      </div>`;
    });
    html += `</div>`;
  }

  // ---- Local section ----
  html += `<div class="udsp-section-head">Your library</div>`;
  const names = Object.keys(USER_DSP_SOURCES).sort();
  html += `<div class="udsp-new" id="udsp-new">New .gdsp</div>`;
  if (!names.length) {
    html += `<div class="udsp-list-empty">No user DSP yet — click "New .gdsp" to start</div>`;
  } else {
    names.forEach(name => {
      const meta = USER_DSP_META[name] || {};
      const active = name === editingUdsp ? " active" : "";
      html += `<div class="udsp-list-item${active}" data-name="${name}">
        <span class="dot" style="background:${meta.color || "#c8e85a"}"></span>
        <span class="name">${name}</span>
        <span class="x" data-del="${name}" title="Delete">×</span>
      </div>`;
    });
  }

  udspList.innerHTML = html;

  const reloadEl = document.getElementById("udsp-comm-reload");
  if (reloadEl) reloadEl.addEventListener("click", e => {
    e.stopPropagation();
    loadCommunityList(true);
  });
  udspList.querySelectorAll("[data-comm]").forEach(item => {
    item.addEventListener("click", () => {
      const name = item.dataset.comm;
      const cached = communityCache && communityCache.items.find(x => x.name === name);
      if (cached) loadCommunityItem(cached);
    });
  });

  document.getElementById("udsp-new").addEventListener("click", () => {
    editingUdsp = null;
    setUdspText(GDSP_TEMPLATE);
    udspStatus.textContent = "New .gdsp — edit and click Save & Add";
    udspStatus.className = "udsp-status";
    renderUdspList();
  });
  udspList.querySelectorAll(".udsp-list-item[data-name]").forEach(item => {
    item.addEventListener("click", e => {
      if (e.target.dataset.del) return;
      const name = item.dataset.name;
      editingUdsp = name;
      setUdspText(USER_DSP_SOURCES[name] || "");
      udspStatus.textContent = `Editing ${name}`;
      udspStatus.className = "udsp-status";
      renderUdspList();
    });
  });
  udspList.querySelectorAll(".x").forEach(x => {
    x.addEventListener("click", e => {
      e.stopPropagation();
      const name = x.dataset.del;
      if (!confirm(`Delete user DSP "${name}"? Any nodes using it will be removed from the patch.`)) return;
      unregisterUserDsp(name);
      if (editingUdsp === name) {
        editingUdsp = null;
        setUdspText(GDSP_TEMPLATE);
      }
      renderUdspList();
      renderPalette(search.value);
      render();
      saveUserDspToStorage();
    });
  });
}

function setUdspStatus(msg, kind) {
  udspStatus.textContent = msg;
  udspStatus.className = "udsp-status" + (kind ? " " + kind : "");
}

document.getElementById("btn-udsp-validate").addEventListener("click", () => {
  try {
    const { name, def } = buildUserDspDef(getUdspText());
    setUdspStatus(`OK — ${name}: ${def.ins.length} in, ${def.outs.length} out, ${Object.keys(def.params).length} params`, "ok");
  } catch (err) {
    setUdspStatus("Error — " + err.message, "err");
  }
});

document.getElementById("btn-udsp-save").addEventListener("click", () => {
  try {
    // If renaming, drop the old entry first
    const probe = parseGdsp(getUdspText()).directives;
    const newName = probe.name;
    if (editingUdsp && editingUdsp !== newName) {
      unregisterUserDsp(editingUdsp);
    }
    const name = registerUserDsp(getUdspText());
    editingUdsp = name;
    setUdspStatus(`Saved ${name} — added to palette`, "ok");
    renderUdspList();
    renderPalette(search.value);
    render();
    saveUserDspToStorage();
  } catch (err) {
    setUdspStatus("Error — " + err.message, "err");
  }
});

/* ---------- Submit to community library ----------
 * Opens a GitHub PR-creation page pre-filled with the current .gdsp
 * source. The user authenticates on github.com, sees the diff, and
 * clicks "Create pull request". The community repo's CI then validates.
 *
 * GitHub limits the URL ?value= length around ~10–14 KB depending on
 * browser. For oversized files we fall back to copying source to the
 * clipboard and just opening the empty new-file page. */
const COMMUNITY_REPO = "9LiveZZZ-Git/gamma-community-gdsp";
const COMMUNITY_BRANCH = "main";

document.getElementById("btn-udsp-submit").addEventListener("click", async () => {
  const src = getUdspText();
  let directives;
  try {
    directives = parseGdsp(src).directives;
  } catch (e) {
    setUdspStatus("Submit needs a parseable .gdsp — fix errors first.", "err");
    return;
  }
  if (!directives.name) {
    setUdspStatus("Submit needs @gdsp-name.", "err");
    return;
  }
  const filename = `gdsp/${directives.name}.gdsp`;
  const baseUrl = `https://github.com/${COMMUNITY_REPO}/new/${COMMUNITY_BRANCH}`;
  const params = new URLSearchParams({
    filename,
    value: src,
    message: `Add ${directives.name}`,
    description: directives.description || ""
  });
  const fullUrl = baseUrl + "?" + params.toString();

  // Some browsers cap URL length around 8K. If we'd exceed that, copy
  // the source to clipboard and open the empty new-file page so the
  // user can paste it themselves.
  if (fullUrl.length > 7800) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(src); } catch (_) {}
      setUdspStatus("File too large to prefill — source copied to clipboard. Paste in the new file.", "ok");
    } else {
      setUdspStatus("File too large to prefill the URL — copy the source manually after the page opens.", "err");
    }
    window.open(`${baseUrl}?filename=${encodeURIComponent(filename)}`, "_blank", "noopener");
    return;
  }
  window.open(fullUrl, "_blank", "noopener");
  setUdspStatus(`Opened submit page for ${directives.name}.gdsp on github.com`, "ok");
});

document.getElementById("btn-udsp-export").addEventListener("click", () => {
  if (!editingUdsp) {
    setUdspStatus("Save first, then export", "err");
    return;
  }
  exportGdsp(editingUdsp);
  setUdspStatus(`Exported ${editingUdsp}.gdsp`, "ok");
});

// localStorage persistence — survives page reload
const LS_KEY = "gamma-editor-userdsp-v1";

function saveUserDspToStorage() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(USER_DSP_SOURCES));
  } catch (e) { /* ignore quota / private mode */ }
}

function loadUserDspFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const map = JSON.parse(raw);
    Object.values(map).forEach(src => {
      try { registerUserDsp(src); } catch (e) { console.warn("Bad stored gdsp:", e.message); }
    });
  } catch (e) { /* ignore */ }
}

loadUserDspFromStorage();
setUdspText(GDSP_TEMPLATE);
renderUdspList();
renderPalette();

