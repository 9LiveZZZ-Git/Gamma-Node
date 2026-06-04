/* =========================================================================
 * Ollama provider helpers
 *
 * Phase B sprint 1 of docs/LLM-KNOWLEDGE-PHASE.md §4. Two flavors via
 * the same code:
 *
 *   Local Ollama (default)
 *     User installs Ollama themselves from ollama.com/download. The
 *     native installers auto-start a background daemon on login at
 *     127.0.0.1:11434. No auth header; editor talks directly (the
 *     compile-server proxy is bypassed per the rt-engine memory --
 *     Chrome's loopback mixed-content exception covers it).
 *
 *   Ollama Cloud (ollama.com hosted "Turbo" models)
 *     User-supplied API key from their ollama.com account, sent as
 *     `Authorization: Bearer <key>`. Same `/api/*` endpoints; the
 *     model name typically carries a `-cloud` suffix (gpt-oss:120b-cloud,
 *     llama4:128b-cloud, etc.).
 *
 * Six entry points, all routing through `_ollamaFetch` for consistent
 * error handling + auth + URL resolution:
 *
 *   probeOllama({ baseUrl, key })
 *       GET /api/version -> { version: "..." }.
 *
 *   listOllamaModels({ baseUrl, key })
 *       GET /api/tags -> array of { name, size, modified_at, ... }.
 *
 *   pullOllamaModel({ baseUrl, key, model, onProgress })
 *       POST /api/pull, streams NDJSON progress.
 *       onProgress receives { status, completed?, total?, digest? } events.
 *
 *   ollamaChat({ baseUrl, key, model, system, user, image, onToken,
 *                temperature, maxTokens })
 *       POST /api/chat, NDJSON-streams when onToken is provided.
 *       Returns the accumulated text. Supports `system` role + multi-
 *       turn (passing `messages` array via the `messages` opt overrides
 *       system+user). image accepts a base64 string or array of them.
 *
 *   ollamaGenerate({ baseUrl, key, model, prompt, onToken,
 *                    temperature, maxTokens })
 *       POST /api/generate, NDJSON-streams when onToken is provided.
 *       Cheaper than /chat for stateless single-prompt completions.
 *
 *   ollamaEmbed({ baseUrl, key, model, input })
 *       POST /api/embed. input can be a string or array of strings.
 *       Returns the raw response { model, embeddings: [[...], ...] }.
 *
 * Streaming uses streamNDJSONEvents from src/ai/streaming.js. Errors
 * are surfaced via thrown Error with the HTTP status + first 200 bytes
 * of the response body for inline-debuggability.
 *
 * Cancellation isn't implemented here yet (Sprint B.6 introduces an
 * AbortController surface). For now, an in-flight stream cannot be
 * interrupted -- the editor's existing "Cancel generation" button is
 * the workaround.
 * ======================================================================== */

const OLLAMA_LOCAL_DEFAULT_URL = "http://127.0.0.1:11434";
const OLLAMA_CLOUD_BASE_URL    = "https://ollama.com";
const OLLAMA_LOCAL_DEFAULT_MODEL = "llama3.2";
const OLLAMA_CLOUD_DEFAULT_MODEL = "gpt-oss:120b-cloud";
const OLLAMA_DEFAULT_EMBED_MODEL = "nomic-embed-text";

/* Return `true` if `s` looks plausibly like an Ollama base URL --
 * either with an explicit http(s):// scheme, or scheme-less but having
 * the host:port shape that a developer would actually type. Rejects
 * obvious garbage so we don't auto-prefix http:// to things like
 * accidentally-pasted API keys.
 *
 * The validation isn't trying to be exhaustive; just defensive enough
 * to avoid the failure mode reported in v0.3.702: an Anthropic API
 * key (`sk-ant-api03-...`) had been written into aiSettings.ollamaUrl,
 * and the http:// auto-prefix turned it into a real http URL that
 * leaked the key in console errors. Anything not looking like a host
 * (no dot, no colon, no slash; or starting with the well-known API-key
 * prefixes) falls back to the default. */
function _looksLikeOllamaUrl(s) {
  if (typeof s !== "string") return false;
  s = s.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  // Heuristic rejects: obvious API-key shapes that aren't URLs.
  if (/^(sk-|api[-_]key|bearer\s)/i.test(s)) return false;
  if (/\s/.test(s)) return false;  // spaces in a URL hostname are a tell
  // Plausible scheme-less host:port: contains a `:` OR a `.`.
  if (/[:.]/.test(s)) {
    // Sanity-check by attempting URL parse with the http:// prefix.
    try { new URL("http://" + s); return true; } catch (_) { return false; }
  }
  return false;
}

function _resolveOllamaBase(baseUrl) {
  let u = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!u) return OLLAMA_LOCAL_DEFAULT_URL;
  // Phase B sprint 3 fix -- if the user pasted just "127.0.0.1:11434" or
  // "192.168.1.42:11434" without a scheme, fetch() would treat it as a
  // RELATIVE path and resolve against the editor's origin
  // (https://...github.io/127.0.0.1:11434/api/version), which returns
  // the editor host's 404 HTML page instead of the Ollama API.
  //
  // v0.3.703 fix on top: validate the URL shape BEFORE auto-prefixing
  // http://. If it doesn't look like a URL (e.g. an Anthropic API key
  // got accidentally written into ollamaUrl), reject it and fall back
  // to the default. Without this, the auto-prefix would turn the key
  // into a real http:// URL, leaking it in console error messages.
  if (!_looksLikeOllamaUrl(u)) {
    console.warn("[ollama] aiSettings.ollamaUrl does not look like a URL; falling back to default. Clear the field in Settings if you didn't intend to set it. Value preview:",
      u.slice(0, 12) + (u.length > 12 ? "…" : ""));
    return OLLAMA_LOCAL_DEFAULT_URL;
  }
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u;
}

function _ollamaHeaders(key) {
  const h = { "content-type": "application/json" };
  if (key) h["authorization"] = "Bearer " + key;
  return h;
}

async function _ollamaFetch(path, opts) {
  opts = opts || {};
  const url = _resolveOllamaBase(opts.baseUrl) + path;
  // Phase B sprint 6 -- signal lets callers wire an AbortController so
  // a second trigger on a sink node can cancel an in-flight stream.
  // Pass-through to fetch; downstream stream reader sees the abort as
  // a normal stream error and our finally{} clears state.
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: _ollamaHeaders(opts.key),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal || undefined
  });
  if (!res.ok) {
    let detail = "";
    let bodyLooksHtml = false;
    try {
      const txt = await res.text();
      detail = txt.slice(0, 200);
      bodyLooksHtml = /^\s*<!doctype html|^\s*<html/i.test(txt);
    } catch (_) {}
    const tag = (opts.baseUrl && /^https?:\/\/ollama\.com/i.test(opts.baseUrl))
      ? "Ollama Cloud"
      : "Ollama";
    // Phase B sprint 3 fix -- a HTML body on /api/version is a strong
    // signal that the URL didn't reach Ollama at all (Ollama always
    // returns JSON). Most common cause: the user pasted a URL without
    // an http:// scheme so fetch resolved it against the editor's origin
    // and got back the editor host's 404 page. Surface a hint inline so
    // they don't have to dig through DevTools to find the cause.
    if (bodyLooksHtml) {
      throw new Error(`${tag} ${path} ${res.status}: got HTML response (probably wrong URL — request likely hit the editor's host, not Ollama). Resolved URL: ${url}`);
    }
    throw new Error(`${tag} ${path} ${res.status}: ${detail || res.statusText}`);
  }
  return res;
}

/* Phase B sprint 7 -- HuggingFace URL/tag normalization.
 *
 * Ollama 0.3+ accepts model identifiers of the shape
 *   hf.co/{user}/{repo}[:{quant}]
 * which it routes through HuggingFace's hub to pull a GGUF-quantized
 * model. The model has to be a GGUF repo (or a conversion-on-the-fly
 * candidate); SafeTensors / diffusion / multimodal repos like
 * `microsoft/TRELLIS.2-4B` will pull and then fail on Ollama's side --
 * we surface the daemon's error verbatim.
 *
 * Accepts (all equivalent):
 *   https://huggingface.co/microsoft/TRELLIS.2-4B
 *   https://huggingface.co/microsoft/TRELLIS.2-4B/tree/main
 *   huggingface.co/microsoft/TRELLIS.2-4B
 *   hf.co/microsoft/TRELLIS.2-4B
 *   microsoft/TRELLIS.2-4B  (org/repo bare, when defaultHf=true)
 *
 * Returns either the normalized `hf.co/...` form OR the original
 * input unchanged (when not an HF reference) so the caller can use
 * it for both registry tags (llama3.2) and HF mirrors. A second
 * arg `quant` appends `:{quant}` only when not already present in
 * the input.
 *
 * Used by the Pull UI in src/ai/settings.js to let the user paste
 * a HuggingFace page URL directly into the model-tag input. */
function normalizeOllamaModelTag(input, quant) {
  if (typeof input !== "string") return "";
  let s = input.trim();
  if (!s) return "";
  // Strip scheme.
  s = s.replace(/^https?:\/\//i, "");
  // Strip trailing /tree/{branch}, /blob/..., /resolve/..., /commit/...
  s = s.replace(/\/(tree|blob|resolve|commit|raw)\/.*$/i, "");
  // Strip trailing slashes / query / fragment.
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  // Now recognize HF variants.
  let isHf = false;
  if (/^huggingface\.co\//i.test(s)) { s = s.replace(/^huggingface\.co\//i, "hf.co/"); isHf = true; }
  else if (/^hf\.co\//i.test(s))     { isHf = true; }
  // If the cleaned string is bare "user/repo" (one slash, no dots in
  // the leading segment) treat it as an HF reference. This handles
  // copy-pastes of just the org/repo line from a HF page.
  if (!isHf && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s)) {
    s = "hf.co/" + s;
    isHf = true;
  }
  // Optional quant suffix. Only append if the user didn't already
  // type one and the caller asked for one.
  if (isHf && quant && !/:[A-Za-z0-9_]+$/.test(s)) {
    s = s + ":" + quant;
  }
  return s;
}

/* Phase B sprint 9 -- HuggingFace repo pre-pull probe.
 *
 * Ollama can only pull HF models that ship GGUF files. There's no way
 * to know that until the pull fails (and the daemon's error is
 * usually a not-very-helpful "manifest not found"). This probe hits
 * HF's public model-metadata endpoint to check for `.gguf` siblings
 * before we even bother Ollama:
 *
 *   GET https://huggingface.co/api/models/{user}/{repo}
 *     -> { id, siblings: [{ rfilename: "model.Q4_K_M.gguf" }, ...], ... }
 *
 * Returns a result object:
 *   {
 *     ok:        boolean,      -- network/parse success
 *     status:    number,       -- HTTP status (404 = private/gated/missing)
 *     hasGguf:   boolean,      -- at least one .gguf file in the file list
 *     ggufFiles: string[],     -- the .gguf filenames (for quant picker hints)
 *     repoFull:  string,       -- "user/repo"
 *     error:     string|null   -- human message when ok=false
 *   }
 *
 * A network failure (CORS, offline, gated repo) returns ok=false but
 * with hasGguf=null so the caller can decide whether to proceed anyway
 * (a private repo with the right HF_TOKEN on the Ollama daemon side
 * might still succeed). */
async function probeHuggingFaceRepo(userOrRepo, maybeRepo) {
  let user, repo;
  if (maybeRepo !== undefined) { user = userOrRepo; repo = maybeRepo; }
  else {
    const s = String(userOrRepo || "").trim();
    // Accept "user/repo", "hf.co/user/repo[:quant]", "huggingface.co/user/repo[/tree/...]".
    const cleaned = s
      .replace(/^https?:\/\//i, "")
      .replace(/^(huggingface\.co|hf\.co)\//i, "")
      .replace(/\/(tree|blob|resolve|commit|raw)\/.*$/i, "")
      .replace(/:[A-Za-z0-9_]+$/, "");  // drop quant suffix for probe
    const parts = cleaned.split("/");
    if (parts.length < 2) return { ok: false, status: 0, hasGguf: null, ggufFiles: [], repoFull: s, error: "Not a user/repo path" };
    user = parts[0]; repo = parts[1];
  }
  const repoFull = user + "/" + repo;
  const url = "https://huggingface.co/api/models/" + encodeURIComponent(user) + "/" + encodeURIComponent(repo);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      return { ok: false, status: res.status, hasGguf: null, ggufFiles: [], repoFull,
        error: res.status === 404 ? "Repo not found (could be private/gated)" : ("HF API " + res.status) };
    }
    const data = await res.json();
    const sibs = Array.isArray(data && data.siblings) ? data.siblings : [];
    const ggufFiles = sibs
      .map(s => (s && s.rfilename) || "")
      .filter(name => /\.gguf$/i.test(name));
    return { ok: true, status: 200, hasGguf: ggufFiles.length > 0, ggufFiles, repoFull, error: null };
  } catch (e) {
    return { ok: false, status: 0, hasGguf: null, ggufFiles: [], repoFull,
      error: (e && e.message) || String(e) };
  }
}

async function probeOllama(opts) {
  const res = await _ollamaFetch("/api/version", opts);
  return await res.json();
}

async function listOllamaModels(opts) {
  const res = await _ollamaFetch("/api/tags", opts);
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

async function pullOllamaModel(opts) {
  opts = opts || {};
  const res = await _ollamaFetch("/api/pull", {
    baseUrl: opts.baseUrl,
    key: opts.key,
    method: "POST",
    body: { model: opts.model, stream: true }
  });
  await streamNDJSONEvents(res, (ev) => {
    if (typeof opts.onProgress === "function") opts.onProgress(ev);
  });
}

async function ollamaChat(opts) {
  opts = opts || {};
  const model = opts.model || OLLAMA_LOCAL_DEFAULT_MODEL;
  // Caller can pass a fully-formed `messages` array (multi-turn history);
  // otherwise build a 1- or 2-message exchange from system + user.
  let messages;
  if (Array.isArray(opts.messages)) {
    messages = opts.messages;
  } else {
    messages = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    const userMsg = { role: "user", content: opts.user || "" };
    if (opts.image) {
      // Ollama accepts an `images` array of base64 strings on a
      // user-role message. Some models reject this entirely; others
      // (llava, llama3.2-vision) consume it. Surface failures verbatim.
      userMsg.images = Array.isArray(opts.image) ? opts.image : [opts.image];
    }
    messages.push(userMsg);
  }

  const body = {
    model,
    messages,
    stream: !!opts.onToken
  };
  // Phase B sprint 6 -- format: "json" enables Ollama's constrained
  // JSON output. Pairs well with a schema-style system prompt. Some
  // models honor this better than others (llama3.1+, qwen2.5+).
  if (opts.format) body.format = opts.format;
  const inner = {};
  if (typeof opts.temperature === "number") inner.temperature = opts.temperature;
  if (typeof opts.maxTokens === "number" && opts.maxTokens > 0) inner.num_predict = opts.maxTokens;
  if (Object.keys(inner).length) body.options = inner;

  const res = await _ollamaFetch("/api/chat", {
    baseUrl: opts.baseUrl,
    key: opts.key,
    method: "POST",
    body,
    signal: opts.signal
  });

  if (!opts.onToken) {
    const data = await res.json();
    return (data && data.message && typeof data.message.content === "string")
      ? data.message.content
      : "";
  }
  let acc = "";
  await streamNDJSONEvents(res, (ev) => {
    if (ev && ev.message && typeof ev.message.content === "string") {
      const tok = ev.message.content;
      if (tok) {
        acc += tok;
        opts.onToken(tok);
      }
    }
  });
  return acc;
}

async function ollamaGenerate(opts) {
  opts = opts || {};
  const body = {
    model: opts.model || OLLAMA_LOCAL_DEFAULT_MODEL,
    prompt: opts.prompt || "",
    stream: !!opts.onToken
  };
  if (opts.system) body.system = opts.system;
  if (opts.format) body.format = opts.format;  // Phase B sprint 6 -- JSON mode.
  const inner = {};
  if (typeof opts.temperature === "number") inner.temperature = opts.temperature;
  if (typeof opts.maxTokens === "number" && opts.maxTokens > 0) inner.num_predict = opts.maxTokens;
  if (Object.keys(inner).length) body.options = inner;

  const res = await _ollamaFetch("/api/generate", {
    baseUrl: opts.baseUrl,
    key: opts.key,
    method: "POST",
    body,
    signal: opts.signal
  });

  if (!opts.onToken) {
    const data = await res.json();
    return (data && typeof data.response === "string") ? data.response : "";
  }
  let acc = "";
  await streamNDJSONEvents(res, (ev) => {
    if (ev && typeof ev.response === "string") {
      const tok = ev.response;
      if (tok) {
        acc += tok;
        opts.onToken(tok);
      }
    }
  });
  return acc;
}

async function ollamaEmbed(opts) {
  opts = opts || {};
  const body = {
    model: opts.model || OLLAMA_DEFAULT_EMBED_MODEL,
    input: Array.isArray(opts.input) ? opts.input : [opts.input || ""]
  };
  const res = await _ollamaFetch("/api/embed", {
    baseUrl: opts.baseUrl,
    key: opts.key,
    method: "POST",
    body
  });
  return await res.json();
}

/* Phase B sprint 2 -- cached status probes
 *
 * Daemons + model lists move slowly; the badge popover, the model-
 * picker, and the AI panel's run-time gating all read the same data.
 * Probing on every consumer access spams /api/version + /api/tags
 * unnecessarily and feels laggy at popover-open time. So we keep two
 * keyed caches (one per base-url + key pair) with short TTLs and an
 * `expectingFreshness` async getter that returns last-good data
 * immediately while a background refetch updates the cache for the
 * next read.
 *
 * Cache shape:
 *   _ollamaStatusCache.get(key) = {
 *     version: string | null,
 *     models:  array  | null,        // from /api/tags
 *     error:   string | null,
 *     fetchedAt: number,             // ms epoch
 *     inFlight: Promise | null
 *   }
 *
 * Cache key: `${baseUrlResolved}::${key || ""}`. We don't store the
 * auth key in the cache value, just hash it into the key so two users
 * on the same machine with different api keys don't see each other's
 * cloud-status payloads.
 *
 * TTL = 30 s. After that, the next consumer triggers a background
 * refetch but still gets the stale value synchronously for snappy UX.
 * `forceProbeOllama` bypasses TTL (the "Test connection" + "Refresh"
 * buttons in settings call this).
 */
const OLLAMA_STATUS_TTL_MS = 30 * 1000;
const _ollamaStatusCache = new Map();

function _ollamaCacheKey(baseUrl, key) {
  return _resolveOllamaBase(baseUrl) + "::" + (key || "");
}

function getCachedOllamaStatus(baseUrl, key) {
  return _ollamaStatusCache.get(_ollamaCacheKey(baseUrl, key)) || null;
}

async function _doOllamaProbe(baseUrl, key) {
  const out = { version: null, models: null, error: null, fetchedAt: Date.now(), inFlight: null };
  try {
    const v = await probeOllama({ baseUrl, key });
    out.version = (v && typeof v.version === "string") ? v.version : "?";
  } catch (e) {
    out.error = (e && e.message) || String(e);
    return out;  // models call would fail too if version did
  }
  try {
    out.models = await listOllamaModels({ baseUrl, key });
  } catch (e) {
    // Probe succeeded but model list failed. Surface in `error` so the
    // panel can show a partial-success state.
    out.error = (e && e.message) || String(e);
  }
  return out;
}

async function probeOllamaStatus(opts) {
  opts = opts || {};
  const cacheKey = _ollamaCacheKey(opts.baseUrl, opts.key);
  const cached = _ollamaStatusCache.get(cacheKey);
  const now = Date.now();
  const fresh = cached && !opts.force && (now - cached.fetchedAt) < OLLAMA_STATUS_TTL_MS;
  if (fresh && !cached.inFlight) return cached;

  // If a probe is already in flight for this cache key, return its
  // promise rather than starting a parallel one.
  if (cached && cached.inFlight) return cached.inFlight;

  const p = _doOllamaProbe(opts.baseUrl, opts.key).then(out => {
    _ollamaStatusCache.set(cacheKey, out);
    if (typeof opts.onUpdate === "function") {
      try { opts.onUpdate(out); } catch (_) {}
    }
    return out;
  });
  // Mark in-flight so concurrent callers reuse the promise. The promise
  // itself replaces the cached `inFlight` field above.
  _ollamaStatusCache.set(cacheKey, Object.assign({}, cached || {}, { inFlight: p }));
  return p;
}

/* "Background refresh" pattern: return the cached snapshot synchronously
 * (or null) and kick a probe whose result is delivered via onUpdate.
 * Useful for the model badge / popover where the UI shouldn't block. */
function probeOllamaStatusBackground(opts) {
  opts = opts || {};
  const cached = getCachedOllamaStatus(opts.baseUrl, opts.key);
  const stale = !cached || (Date.now() - cached.fetchedAt) >= OLLAMA_STATUS_TTL_MS;
  if (stale) probeOllamaStatus(opts);
  return cached;
}

/* Phase B sprint 3 -- compile-server /health advertisement consumer.
 *
 * The gamma-compile-server daemon polls its own local Ollama every 60s
 * and includes the snapshot in /health under `ollama`. When the editor
 * parses /health (in src/audio/preview.js's probeLocalServer), it calls
 * this helper to prime our cache so the model badge can surface Ollama
 * state from the compile-server's perspective.
 *
 * Why useful:
 *   - LAN setups where the editor loads from https://9livezzz-git.github.io
 *     and the compile-server is on a non-loopback LAN address. The
 *     direct browser probe of Ollama there is blocked by mixed-content;
 *     /health (relayed through the compile-server) succeeds.
 *   - Cold start: the compile-server's /health response often lands
 *     faster than our own 30s direct probe schedule.
 *
 * The snapshot is stored under its own `baseUrl` key so the user's
 * configured aiSettings.ollamaUrl cache slot isn't overwritten when
 * those URLs differ (a remote compile-server's "127.0.0.1:11434" is
 * NOT the editor user's "127.0.0.1:11434"). Direct probes by the
 * editor later for any matching baseUrl will overwrite this entry
 * with whatever the direct probe finds. */
function applyOllamaHealthSnapshot(s) {
  if (!s || typeof s !== "object") return null;
  const baseUrl = (typeof s.baseUrl === "string") ? s.baseUrl : OLLAMA_LOCAL_DEFAULT_URL;
  const snapshot = {
    version:   typeof s.version === "string" ? s.version : null,
    models:    Array.isArray(s.models) ? s.models : null,
    error:     typeof s.error === "string" ? s.error : (s.present ? null : "compile-server reported no daemon"),
    fetchedAt: typeof s.fetchedAt === "number" ? s.fetchedAt : Date.now(),
    inFlight:  null
  };
  // Only write if we don't have a fresher direct-probe snapshot for the
  // same baseUrl -- the direct probe is authoritative; this is only a
  // hint. Also skip overwriting a successful direct probe with a failed
  // health-relay snapshot (would degrade UX for no reason).
  const cacheKey = _ollamaCacheKey(baseUrl, "");
  const existing = _ollamaStatusCache.get(cacheKey);
  if (existing && existing.fetchedAt >= snapshot.fetchedAt) return existing;
  if (existing && existing.version && !snapshot.version) return existing;
  _ollamaStatusCache.set(cacheKey, snapshot);
  return snapshot;
}
