/* ============================================================================
 * Phase D §6.3 -- data nodes runtime (sprint llm-3)
 *
 * Tick handlers for TextCorpus / Tokenizer / Vocabulary / DatasetLoader,
 * dispatched from _tickLLMRuntime's llm-op walk (same slot NotesCorpus
 * uses). Conventions:
 *
 *   - bulky text rides on params._corpus (the _-twin _readTextWire knows)
 *   - vectors ride on params._vec_<port> ({data, shape, dtype, meta} --
 *     the port-aware extension of the Phase A params._vec convention)
 *   - live tokenizer handles (closures!) live in _llmGetState(node.id),
 *     NEVER on params: params are JSON-serialized into .gpatch + undo
 *
 * The pure batch-slicing core (_llmDatasetSlice) is separated from the
 * tick so it unit-tests offline.
 * ==========================================================================*/

const LLM_TINY_SHAKESPEARE_URL =
  "https://raw.githubusercontent.com/karpathy/char-rnn/master/data/tinyshakespeare/input.txt";

/* Cheap change signature for possibly-megabyte strings: length + FNV of
 * head and tail. Corpus edits that keep both ends + length identical are
 * pathological enough to ignore at tick rate. */
function _llmTextSig(s) {
  const t = String(s || "");
  const fnv = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  return t.length + ":" + fnv(t.slice(0, 256)) + ":" + fnv(t.slice(-256));
}

/* --- TextCorpus ------------------------------------------------------------
 * source="url": fetch once per url change / refresh pulse (async, busy-
 * guarded). source="inline": params.text IS the corpus. Publishes on
 * params._corpus; chars/status are display params. */
function _tickTextCorpus(node, rt) {
  const p = node.params;
  if (p.source === "inline") {
    const sig = "inline:" + _llmTextSig(p.text);
    if (rt._corpusSig !== sig) {
      rt._corpusSig = sig;
      p._corpus = String(p.text || "");
      p.chars = p._corpus.length;
      p.status = "inline · " + p.chars + " chars";
    }
    return;
  }
  const url = String(p.url || "").trim();
  const refreshFired = _llmDetectGate(node, rt, "refresh", "lastCorpusRefresh");
  const sig = "url:" + url;
  if (rt._corpusBusy || !url) return;
  if (rt._corpusSig === sig && !refreshFired) return;
  rt._corpusBusy = true;
  rt._corpusSig = sig;
  p.status = "fetching…";
  fetch(url)
    .then(r => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    })
    .then(t => {
      node.params._corpus = t;
      node.params.chars = t.length;
      node.params.status = "ok · " + t.length + " chars";
    })
    .catch(e => {
      node.params.status = "⚠ " + ((e && e.message) || e);
      if (typeof node.params._corpus !== "string") node.params._corpus = "";
    })
    .finally(() => { rt._corpusBusy = false; });
}

/* --- Tokenizer -------------------------------------------------------------
 * Trains/loads per (mode, hfId, corpus) signature. char/byte are sync;
 * hf is async (CDN). Handle lands in rt.tok; the encoded corpus ids land
 * on params._vec_ids so DatasetLoader reads them like any vector wire. */
function _tickTokenizerNode(node, rt) {
  const p = node.params;
  const corpus = _readTextWire(node, "corpus");
  const mode = (p.mode === "byte" || p.mode === "hf") ? p.mode : "char";
  const sig = mode + ":" + (mode === "hf" ? p.hfId : "") + ":" + _llmTextSig(corpus);
  if (rt._tokBusy || rt._tokSig === sig) return;
  if (!corpus && mode !== "byte") { p.status = "wire a corpus in"; return; }
  rt._tokSig = sig;

  const finish = (handle) => {
    rt.tok = handle;
    const ids = handle.encode(corpus);
    p._vec_ids = {
      data: ids, shape: [ids.length], dtype: "f32",
      meta: { kind: "token-ids", vocabSize: handle.vocabSize, mode: handle.mode }
    };
    p.vocabSize = handle.vocabSize;
    p.status = handle.mode + " · vocab " + handle.vocabSize + " · " + ids.length + " tokens";
  };

  if (mode === "char") { finish(llmTokTrainChar(corpus)); return; }
  if (mode === "byte") { finish(llmTokByte()); return; }
  rt._tokBusy = true;
  p.status = "loading " + p.hfId + "…";
  llmTokHf(p.hfId)
    .then(h => { if (rt._tokSig === sig) finish(h); })
    .catch(e => { p.status = "⚠ " + ((e && e.message) || e); rt._tokSig = null; })
    .finally(() => { rt._tokBusy = false; });
}

/* --- Vocabulary ------------------------------------------------------------
 * Reads the upstream Tokenizer's handle (via the wire into `tok`) and
 * surfaces size + a printable preview. */
function _tickVocabularyNode(node) {
  const p = node.params;
  let src = null;
  if (state && Array.isArray(state.edges)) {
    const e = state.edges.find(e => e && e.to && e.to.node === node.id && e.to.port === "tok");
    if (e && e.from) src = state.nodes.find(n => n && n.id === e.from.node);
  }
  const h = src && typeof _llmGetState === "function" ? _llmGetState(src.id).tok : null;
  if (!h) {
    const vec = _readVectorWire(node, "tok");
    p.size = (vec && vec.meta && vec.meta.vocabSize) || 0;
    p.preview = p.size ? "(tokenizer handle pending)" : "wire Tokenizer.ids in";
    return;
  }
  p.size = h.vocabSize;
  p.preview = h.vocabPreview();
}

/* --- DatasetLoader ---------------------------------------------------------
 * Slices [batchSize, seqLen] windows (+1-shifted targets) out of the id
 * stream. First batch builds as soon as ids arrive; the `next` gate
 * advances the cursor. Pure core below; epoch increments on wrap. */
function _llmDatasetSlice(ids, cursor, seqLen, batchSize, stride) {
  const N = ids.length;
  const span = N - seqLen - 1;             // last legal window start
  if (span < 0) return null;
  const batch = new Float32Array(batchSize * seqLen);
  const targets = new Float32Array(batchSize * seqLen);
  for (let b = 0; b < batchSize; b++) {
    const start = (cursor + b * stride) % (span + 1);
    for (let t = 0; t < seqLen; t++) {
      batch[b * seqLen + t] = ids[start + t];
      targets[b * seqLen + t] = ids[start + t + 1];
    }
  }
  const nextCursor = cursor + batchSize * stride;
  return {
    batch, targets,
    cursor: nextCursor % (span + 1),
    wrapped: nextCursor > span
  };
}

function _tickDatasetLoader(node, rt) {
  const p = node.params;
  const vec = _readVectorWire(node, "ids");
  if (!vec || !vec.data || !vec.data.length) { p.batchShape = "wire token ids in"; return; }
  const seqLen = Math.max(1, Math.round(p.seqLen) || 128);
  const batchSize = Math.max(1, Math.round(p.batchSize) || 8);
  const stride = Math.max(1, Math.round(p.stride) || seqLen);
  const sig = vec.data.length + ":" + seqLen + ":" + batchSize + ":" + stride;
  const nextFired = _llmDetectGate(node, rt, "next", "lastDatasetNext");
  if (rt._dsSig === sig && !nextFired) return;
  const fresh = rt._dsSig !== sig;
  if (fresh) { rt._dsSig = sig; rt._dsCursor = 0; p.epoch = 0; p.step = 0; }

  const res = _llmDatasetSlice(vec.data, rt._dsCursor || 0, seqLen, batchSize, stride);
  if (!res) { p.batchShape = "corpus shorter than seqLen+1"; return; }
  rt._dsCursor = res.cursor;
  if (!fresh && res.wrapped) p.epoch = (p.epoch || 0) + 1;
  if (!fresh) p.step = (p.step || 0) + 1;

  const meta = { kind: "token-ids", vocabSize: (vec.meta && vec.meta.vocabSize) || 0 };
  p._vec_batch   = { data: res.batch,   shape: [batchSize, seqLen], dtype: "f32", meta };
  p._vec_targets = { data: res.targets, shape: [batchSize, seqLen], dtype: "f32", meta };
  p.batchShape = "[" + batchSize + "," + seqLen + "]";
}
