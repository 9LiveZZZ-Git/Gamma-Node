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

function _resolveOllamaBase(baseUrl) {
  const u = String(baseUrl || "").trim().replace(/\/+$/, "");
  return u || OLLAMA_LOCAL_DEFAULT_URL;
}

function _ollamaHeaders(key) {
  const h = { "content-type": "application/json" };
  if (key) h["authorization"] = "Bearer " + key;
  return h;
}

async function _ollamaFetch(path, opts) {
  opts = opts || {};
  const url = _resolveOllamaBase(opts.baseUrl) + path;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: _ollamaHeaders(opts.key),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch (_) {}
    const tag = (opts.baseUrl && /^https?:\/\/ollama\.com/i.test(opts.baseUrl))
      ? "Ollama Cloud"
      : "Ollama";
    throw new Error(`${tag} ${path} ${res.status}: ${detail || res.statusText}`);
  }
  return res;
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
  const inner = {};
  if (typeof opts.temperature === "number") inner.temperature = opts.temperature;
  if (typeof opts.maxTokens === "number" && opts.maxTokens > 0) inner.num_predict = opts.maxTokens;
  if (Object.keys(inner).length) body.options = inner;

  const res = await _ollamaFetch("/api/chat", {
    baseUrl: opts.baseUrl,
    key: opts.key,
    method: "POST",
    body
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
  const inner = {};
  if (typeof opts.temperature === "number") inner.temperature = opts.temperature;
  if (typeof opts.maxTokens === "number" && opts.maxTokens > 0) inner.num_predict = opts.maxTokens;
  if (Object.keys(inner).length) body.options = inner;

  const res = await _ollamaFetch("/api/generate", {
    baseUrl: opts.baseUrl,
    key: opts.key,
    method: "POST",
    body
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
