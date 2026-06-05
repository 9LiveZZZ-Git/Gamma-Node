/* =========================================================================
 * Tektite MD -- embeddings + cache + PCA (sprint tektite-6).
 *
 * MVP backend: hash-trick TF-IDF-ish vectors of fixed 128 dim.  Fast,
 * deterministic, in-process, no model download.  Real transformers.js
 * /api/embed backends slot in later behind the same tektiteEmbed*
 * surface.
 *
 * Public surface:
 *   await tektiteEmbedText(text)        -> Float32Array(EMB_DIM)
 *   await tektiteEmbeddingsGet(noteId)  -> Float32Array(EMB_DIM)
 *                                          (cached by modifiedAt;
 *                                           computed on demand)
 *   await tektiteEmbeddingsGetMany(ids) -> Map<id, Float32Array>
 *   tektitePca(vectors, k)              -> projected positions [N][k]
 *
 * Cache: IndexedDB store "tektite-embeddings" keyed by note id.
 * Values: { id, vector: Float32Array, modifiedAt: number }.
 * Invalidated when the note's modifiedAt advances past the cached
 * version.  Bulk paths (Get/Many) walk the vault list + lazily
 * compute missing or stale entries.
 * ======================================================================== */

const TEKTITE_EMB_DIM         = 128;
const TEKTITE_EMB_STORE       = "tektite-embeddings";
const TEKTITE_EMB_DB_VERSION  = 1;   // bumped if the schema changes
let   _tektiteEmbDbPromise    = null;

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

/* Hash-trick MVP embedding.  Tokenize on word boundaries, hash each
 * token into a fixed bucket, log-scale TF, L2-normalize.  Cheap; gives
 * "similar notes cluster" quality without a model download. */
function _tektiteEmbHashToken(t) {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % TEKTITE_EMB_DIM;
}

async function tektiteEmbedText(text) {
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

/* Single-note get with cache.  Sprint 10z -- falls back to attachment
 * metadata when noteId names an attachment instead of a note (no
 * markdown content available for binary files, so we embed
 * "filename kind ext" as a coarse semantic signature). */
async function tektiteEmbeddingsGet(noteId) {
  if (!noteId) return new Float32Array(TEKTITE_EMB_DIM);
  const note = await tektiteGetNote(noteId);
  if (note) {
    const cached = await _tektiteEmbCacheGet(noteId);
    if (cached && cached.modifiedAt >= (note.modifiedAt || 0) && cached.vector) {
      return cached.vector instanceof Float32Array ? cached.vector : new Float32Array(cached.vector);
    }
    const vec = await tektiteEmbedText((note.title || "") + " " + (note.content || ""));
    await _tektiteEmbCachePut({
      id:         noteId,
      vector:     vec,
      modifiedAt: note.modifiedAt || Date.now()
    });
    return vec;
  }
  // No note -> maybe an attachment.
  if (typeof tektiteGetAttachment === "function") {
    try {
      const att = await tektiteGetAttachment(noteId);
      if (att) {
        const cached = await _tektiteEmbCacheGet(noteId);
        if (cached && cached.modifiedAt >= (att.modifiedAt || 0) && cached.vector) {
          return cached.vector instanceof Float32Array ? cached.vector : new Float32Array(cached.vector);
        }
        const text = [att.id || "", att.kind || "", att.ext || "", att.mime || ""].join(" ");
        const vec  = await tektiteEmbedText(text);
        await _tektiteEmbCachePut({
          id:         noteId,
          vector:     vec,
          modifiedAt: att.modifiedAt || Date.now()
        });
        return vec;
      }
    } catch (_) {}
  }
  return new Float32Array(TEKTITE_EMB_DIM);
}

/* Bulk path: ensures every id in `ids` has an up-to-date embedding.
 * Returns a Map<id, Float32Array>.  Used by the graph modal layouts. */
async function tektiteEmbeddingsGetMany(ids) {
  const out = new Map();
  for (const id of ids) {
    out.set(id, await tektiteEmbeddingsGet(id));
  }
  return out;
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
