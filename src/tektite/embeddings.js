/* =========================================================================
 * Tektite MD -- embeddings + cache + PCA (sprint tektite-6; real model
 * backends added for Phase C item 10 / spec §7.2).
 *
 * Three backends behind one surface, user-picked in the vault DevTools
 * menu (#tektite-embed-backend, persisted in localStorage):
 *
 *   hash    -- hash-trick TF-IDF-ish 128-dim vectors (sprint-6 MVP).
 *              In-process, deterministic, no download. Always available;
 *              also the silent fallback when a model backend fails.
 *   minilm  -- all-MiniLM-L6-v2 (384-dim) in-browser via
 *              @huggingface/transformers feature-extraction, mean-pooled
 *              + normalized. ~25 MB one-time download, cached by the
 *              browser. Same CDN import the Whisper voice path uses.
 *   ollama  -- POST /api/embed through Phase B's ollamaEmbed() (default
 *              model nomic-embed-text, 768-dim). Uses the AI panel's
 *              Ollama URL/key settings; cloud when the active provider
 *              is ollama-cloud, local otherwise.
 *
 * Public surface (unchanged):
 *   await tektiteEmbedText(text)        -> Float32Array
 *   await tektiteEmbedTexts(texts)      -> { vectors, tag }  (bulk; tag =
 *                                          backend actually used, so cache
 *                                          writers never mislabel fallbacks)
 *   await tektiteEmbeddingsGet(noteId)  -> Float32Array (cached)
 *   await tektiteEmbeddingsGetMany(ids) -> Map<id, Float32Array>
 *   tektitePca(vectors, k)              -> projected positions [N][k]
 *   tektiteEmbSettings() / tektiteEmbSetBackend(backend)
 *
 * Cache: IndexedDB store "tektite-embeddings" keyed by note id.
 * Values: { id, vector, modifiedAt, backend }. A record is stale when
 * the note's modifiedAt advances OR the active backend tag differs --
 * switching backends recomputes lazily, no flush needed. Vector
 * dimensions differ per backend (128/384/768); consumers (PCA, galaxy)
 * are dimension-agnostic and each GetMany call is single-backend.
 * ======================================================================== */

const TEKTITE_EMB_DIM         = 128;   // hash backend only
const TEKTITE_EMB_STORE       = "tektite-embeddings";
const TEKTITE_EMB_DB_VERSION  = 1;   // bumped if the schema changes
const TEKTITE_EMB_LS_KEY      = "gamma-editor-tektite-embeddings-v1";
let   _tektiteEmbDbPromise    = null;
let   _tektiteEmbWarnedFallback = false;

/* --- backend settings ---------------------------------------------------- */
function tektiteEmbSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(TEKTITE_EMB_LS_KEY) || "null"); } catch (_) {}
  if (!s || typeof s !== "object") s = {};
  if (s.backend !== "minilm" && s.backend !== "ollama") s.backend = "hash";
  if (!s.ollamaModel) s.ollamaModel = (typeof OLLAMA_DEFAULT_EMBED_MODEL === "string") ? OLLAMA_DEFAULT_EMBED_MODEL : "nomic-embed-text";
  return s;
}

function tektiteEmbSetBackend(backend, opts) {
  const s = tektiteEmbSettings();
  if (backend === "hash" || backend === "minilm" || backend === "ollama") s.backend = backend;
  if (opts && opts.ollamaModel) s.ollamaModel = String(opts.ollamaModel);
  try { localStorage.setItem(TEKTITE_EMB_LS_KEY, JSON.stringify(s)); } catch (_) {}
  _tektiteEmbWarnedFallback = false;   // a new backend gets a fresh warning slot
  return s;
}

/* Cache tag for the active backend; fallback writes tag "hash" so a
 * later successful model run still recomputes. */
function _tektiteEmbBackendTag() {
  const s = tektiteEmbSettings();
  if (s.backend === "minilm") return "minilm";
  if (s.backend === "ollama") return "ollama:" + s.ollamaModel;
  return "hash";
}

/* --- IDB cache ------------------------------------------------------------ */
function _tektiteEmbOpenDb() {
  if (_tektiteEmbDbPromise) return _tektiteEmbDbPromise;
  _tektiteEmbDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("tektite-vault", TEKTITE_EMB_DB_VERSION + 100);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TEKTITE_EMB_STORE)) {
        db.createObjectStore(TEKTITE_EMB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _tektiteEmbDbPromise;
}

async function _tektiteEmbCacheGet(id) {
  try {
    const db = await _tektiteEmbOpenDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TEKTITE_EMB_STORE, "readonly");
      const req = tx.objectStore(TEKTITE_EMB_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  } catch (_) { return null; }
}

async function _tektiteEmbCachePut(record) {
  try {
    const db = await _tektiteEmbOpenDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TEKTITE_EMB_STORE, "readwrite");
      tx.objectStore(TEKTITE_EMB_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch (_) {}
}

/* --- backend: hash (sprint-6 MVP, always available) ------------------------
 * Tokenize on word boundaries, hash each token into a fixed bucket,
 * log-scale TF, L2-normalize. */
function _tektiteEmbHashToken(t) {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % TEKTITE_EMB_DIM;
}

function _tektiteEmbHashOne(text) {
  const v = new Float32Array(TEKTITE_EMB_DIM);
  if (!text) return v;
  const tokens = String(text).toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || [];
  for (const t of tokens) v[_tektiteEmbHashToken(t)] += 1;
  let norm = 0;
  for (let i = 0; i < TEKTITE_EMB_DIM; i++) {
    v[i] = Math.log(1 + v[i]);
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < TEKTITE_EMB_DIM; i++) v[i] /= norm;
  return v;
}

/* --- backend: MiniLM via transformers.js ----------------------------------
 * Lazy CDN import, one cached pipeline. Failed loads clear the promise
 * so a later attempt can retry (e.g. network came back). */
let _tektiteEmbMiniLMPromise = null;
function _tektiteEmbMiniLMPipe() {
  if (!_tektiteEmbMiniLMPromise) {
    _tektiteEmbMiniLMPromise = (async () => {
      const tx = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@latest/+esm");
      return await tx.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    })();
    _tektiteEmbMiniLMPromise.catch(() => { _tektiteEmbMiniLMPromise = null; });
  }
  return _tektiteEmbMiniLMPromise;
}

async function _tektiteEmbMiniLM(texts) {
  const pipe = await _tektiteEmbMiniLMPipe();
  const out = [];
  for (let i = 0; i < texts.length; i += 8) {
    const batch = texts.slice(i, i + 8).map(t => t || " ");
    const res = await pipe(batch, { pooling: "mean", normalize: true });
    const dims = res.dims;                 // [batch, 384]
    const d = dims[dims.length - 1];
    const data = res.data;
    for (let r = 0; r < batch.length; r++) {
      out.push(Float32Array.from(data.slice(r * d, (r + 1) * d)));
    }
  }
  return out;
}

/* --- backend: Ollama /api/embed (Phase B plumbing) -------------------------
 * Local Ollama by default (AI-panel URL when configured); cloud when the
 * active provider is ollama-cloud. Vectors are L2-normalized here so
 * cosine/PCA behavior matches the other backends. */
async function _tektiteEmbOllama(texts) {
  if (typeof ollamaEmbed !== "function") throw new Error("ollamaEmbed unavailable");
  const s = tektiteEmbSettings();
  const providerId = (typeof aiSettings === "object" && aiSettings && aiSettings.provider) || "";
  const cloud  = providerId === "ollama-cloud";
  const baseUrl = cloud
    ? ((typeof OLLAMA_CLOUD_BASE_URL === "string") ? OLLAMA_CLOUD_BASE_URL : "https://ollama.com")
    : ((typeof aiSettings === "object" && aiSettings && aiSettings.ollamaUrl) || "");
  const key = cloud ? (aiSettings && aiSettings.ollamaKey) : undefined;
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32).map(t => t || " ");
    const res = await ollamaEmbed({ baseUrl, key, model: s.ollamaModel, input: batch });
    const embs = (res && res.embeddings) || [];
    if (embs.length !== batch.length) throw new Error("ollama /api/embed returned " + embs.length + " vectors for " + batch.length + " inputs");
    for (const e of embs) {
      const v = Float32Array.from(e);
      let norm = 0;
      for (let j = 0; j < v.length; j++) norm += v[j] * v[j];
      norm = Math.sqrt(norm) || 1;
      for (let j = 0; j < v.length; j++) v[j] /= norm;
      out.push(v);
    }
  }
  return out;
}

/* --- dispatcher ------------------------------------------------------------
 * Model backends see a truncated head of the note (their token windows
 * are small and the embedding quality of a title + lead paragraphs
 * beats a hard-truncated wall of text anyway). */
function _tektiteEmbPrep(text, backend) {
  const t = String(text || "");
  return backend === "minilm" ? t.slice(0, 2000) : t.slice(0, 6000);
}

async function tektiteEmbedTexts(texts) {
  const s = tektiteEmbSettings();
  if (s.backend === "minilm" || s.backend === "ollama") {
    try {
      const prepped = texts.map(t => _tektiteEmbPrep(t, s.backend));
      const vectors = (s.backend === "minilm")
        ? await _tektiteEmbMiniLM(prepped)
        : await _tektiteEmbOllama(prepped);
      return { vectors, tag: _tektiteEmbBackendTag() };
    } catch (e) {
      if (!_tektiteEmbWarnedFallback) {
        _tektiteEmbWarnedFallback = true;
        console.warn("[tektite] '" + s.backend + "' embedding backend failed; falling back to built-in hash vectors:", e && e.message ? e.message : e);
      }
    }
  }
  return { vectors: texts.map(_tektiteEmbHashOne), tag: "hash" };
}

async function tektiteEmbedText(text) {
  return (await tektiteEmbedTexts([text])).vectors[0];
}

/* --- cached note/attachment embeddings ------------------------------------
 * Sprint 10z -- attachments embed "filename kind ext" as a coarse
 * semantic signature (no markdown content for binary files). */
async function _tektiteEmbSourceText(id) {
  const note = await tektiteGetNote(id);
  if (note) {
    return { text: (note.title || "") + " " + (note.content || ""), modifiedAt: note.modifiedAt || Date.now() };
  }
  if (typeof tektiteGetAttachment === "function") {
    try {
      const att = await tektiteGetAttachment(id);
      if (att) {
        return { text: [att.id || "", att.kind || "", att.ext || "", att.mime || ""].join(" "), modifiedAt: att.modifiedAt || Date.now() };
      }
    } catch (_) {}
  }
  return null;
}

/* Bulk path: ensures every id in `ids` has an up-to-date embedding for
 * the ACTIVE backend; misses are recomputed in one batched backend call.
 * Returns a Map<id, Float32Array>. Used by the graph modal layouts. */
async function tektiteEmbeddingsGetMany(ids) {
  const out = new Map();
  const tag = _tektiteEmbBackendTag();
  const hits = [];   // {id, text} -- cache hits under the active tag
  const need = [];   // {id, text, modifiedAt} -- must (re)compute
  for (const id of ids) {
    if (!id) { out.set(id, new Float32Array(TEKTITE_EMB_DIM)); continue; }
    const src = await _tektiteEmbSourceText(id);
    if (!src) { out.set(id, new Float32Array(TEKTITE_EMB_DIM)); continue; }
    const cached = await _tektiteEmbCacheGet(id);
    if (cached && cached.vector && cached.modifiedAt >= src.modifiedAt &&
        (cached.backend || "hash") === tag) {
      out.set(id, cached.vector instanceof Float32Array ? cached.vector : new Float32Array(cached.vector));
      hits.push({ id, text: src.text });
    } else {
      need.push({ id, text: src.text, modifiedAt: src.modifiedAt });
    }
  }
  if (need.length) {
    const res = await tektiteEmbedTexts(need.map(n => n.text));
    for (let i = 0; i < need.length; i++) {
      const vec = res.vectors[i];
      out.set(need[i].id, vec);
      await _tektiteEmbCachePut({
        id:         need[i].id,
        vector:     vec,
        modifiedAt: need[i].modifiedAt,
        backend:    res.tag
      });
    }
    // Mid-call fallback (model backend died): the fresh vectors are hash
    // (128-dim) but earlier cache hits carry the model tag (384/768-dim).
    // Mixed dimensions would NaN the PCA layouts, so recompute the hits
    // as hash too -- in-process, cheap -- WITHOUT overwriting their good
    // model-tagged cache records.
    if (res.tag !== tag) {
      for (const h of hits) out.set(h.id, _tektiteEmbHashOne(h.text));
    }
  }
  return out;
}

async function tektiteEmbeddingsGet(noteId) {
  if (!noteId) return new Float32Array(TEKTITE_EMB_DIM);
  return (await tektiteEmbeddingsGetMany([noteId])).get(noteId);
}

/* Power-iteration PCA.  Returns array of projected vectors [N][k].
 * Centered + deflated for each principal axis.  k <= D. */
function tektitePca(vectors, k) {
  const n = vectors.length;
  if (!n) return [];
  const d = vectors[0].length;
  const kClamp = Math.min(k, d);
  // Center.
  const mean = new Float32Array(d);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i];
  for (let i = 0; i < d; i++) mean[i] /= n;
  const centered = vectors.map(v => {
    const c = new Float32Array(d);
    for (let i = 0; i < d; i++) c[i] = v[i] - mean[i];
    return c;
  });
  const components = [];
  for (let kIdx = 0; kIdx < kClamp; kIdx++) {
    let eig = new Float32Array(d);
    // Deterministic init avoids run-to-run jitter on the layout.
    for (let i = 0; i < d; i++) eig[i] = Math.sin((i + 1) * (kIdx + 1) * 0.7);
    let nrm = 0;
    for (let i = 0; i < d; i++) nrm += eig[i] * eig[i];
    nrm = Math.sqrt(nrm) || 1;
    for (let i = 0; i < d; i++) eig[i] /= nrm;
    for (let iter = 0; iter < 30; iter++) {
      // y = X * eig  (length n)
      const y = new Float32Array(n);
      for (let row = 0; row < n; row++) {
        let s = 0;
        const cv = centered[row];
        for (let col = 0; col < d; col++) s += cv[col] * eig[col];
        y[row] = s;
      }
      // x = X^T * y / n  (length d)
      const x = new Float32Array(d);
      for (let row = 0; row < n; row++) {
        const cv = centered[row];
        const yr = y[row];
        for (let col = 0; col < d; col++) x[col] += cv[col] * yr;
      }
      for (let col = 0; col < d; col++) x[col] /= n;
      // Deflate.
      for (const c of components) {
        let dot = 0;
        for (let i = 0; i < d; i++) dot += x[i] * c[i];
        for (let i = 0; i < d; i++) x[i] -= dot * c[i];
      }
      // Normalize.
      let nr2 = 0;
      for (let i = 0; i < d; i++) nr2 += x[i] * x[i];
      nr2 = Math.sqrt(nr2) || 1;
      for (let i = 0; i < d; i++) x[i] /= nr2;
      eig = x;
    }
    components.push(eig);
  }
  // Project.
  return vectors.map(v => {
    const p = new Float32Array(kClamp);
    for (let kIdx = 0; kIdx < kClamp; kIdx++) {
      let s = 0;
      const c = components[kIdx];
      for (let i = 0; i < d; i++) s += (v[i] - mean[i]) * c[i];
      p[kIdx] = s;
    }
    return p;
  });
}
