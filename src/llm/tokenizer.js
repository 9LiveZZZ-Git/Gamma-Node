/* ============================================================================
 * Phase D §6.4 -- tokenizers (sprint llm-3)
 *
 * Builds the tokenizer HANDLES the data nodes tick against. Three modes:
 *
 *   char -- vocab = sorted unique code points of the training corpus.
 *           The §8 worked-example default for tiny char-level models.
 *   byte -- fixed 256-entry vocab over UTF-8 bytes (TextEncoder); no
 *           training pass, any text round-trips.
 *   hf   -- @huggingface/transformers AutoTokenizer by model id (e.g.
 *           "Xenova/gpt2"); async CDN load, same import the Whisper +
 *           MiniLM paths use. BPE re-implementation is a non-goal per
 *           spec §6.1 -- reuse beats re-deriving.
 *
 * A handle is { mode, vocabSize, encode(str)->Float32Array,
 * decode(arrayLike)->string, vocabPreview() }. Ids ride in Float32Array
 * because the llm-1 runtime is f32-only (embedding_gather rounds).
 * Handles hold closures, so they live in the per-node runtime-state map
 * (_llmGetState), never on node.params -- params get serialized.
 * ==========================================================================*/

function llmTokTrainChar(corpus) {
  const itos = Array.from(new Set(Array.from(String(corpus || "")))).sort();
  const stoi = new Map(itos.map((c, i) => [c, i]));
  return {
    mode: "char",
    vocabSize: itos.length,
    encode(s) {
      const cps = Array.from(String(s || ""));
      const out = new Float32Array(cps.length);
      let n = 0;
      for (const ch of cps) {
        const id = stoi.get(ch);
        if (id !== undefined) out[n++] = id;
      }
      return n === cps.length ? out : out.slice(0, n);
    },
    decode(ids) {
      let s = "";
      for (let i = 0; i < ids.length; i++) s += itos[Math.round(ids[i])] || "";
      return s;
    },
    vocabPreview() {
      return itos.slice(0, 48).map(c => JSON.stringify(c)).join(" ");
    }
  };
}

function llmTokByte() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    mode: "byte",
    vocabSize: 256,
    encode(s) {
      const bytes = enc.encode(String(s || ""));
      const out = new Float32Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) out[i] = bytes[i];
      return out;
    },
    decode(ids) {
      const bytes = new Uint8Array(ids.length);
      for (let i = 0; i < ids.length; i++) bytes[i] = Math.round(ids[i]) & 0xff;
      return dec.decode(bytes);
    },
    vocabPreview() { return "bytes 0-255 (UTF-8)"; }
  };
}

/* AutoTokenizer wrapper. Async: CDN module + tokenizer files load on
 * first use; per-id cached so two Tokenizer nodes with the same hfId
 * share one download. */
const _llmTokHfCache = new Map();
async function llmTokHf(hfId) {
  const id = String(hfId || "Xenova/gpt2");
  if (_llmTokHfCache.has(id)) return _llmTokHfCache.get(id);
  const p = (async () => {
    const tx = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@latest/+esm");
    const tok = await tx.AutoTokenizer.from_pretrained(id);
    // vocab size: try the model's vocab, fall back to scanning config.
    let vs = 0;
    try {
      const v = tok.model && tok.model.vocab;
      if (Array.isArray(v)) vs = v.length;
      else if (v && typeof v.size === "number") vs = v.size;
      else if (v) vs = Object.keys(v).length;
    } catch (_) {}
    if (!vs) { try { vs = tok.model.config.vocab_size || 0; } catch (_) {} }
    return {
      mode: "hf:" + id,
      vocabSize: vs,
      encode(s) {
        const ids = tok.encode(String(s || ""));
        const out = new Float32Array(ids.length);
        for (let i = 0; i < ids.length; i++) out[i] = ids[i];
        return out;
      },
      decode(ids) {
        return tok.decode(Array.from(ids, x => Math.round(x)), { skip_special_tokens: true });
      },
      vocabPreview() { return id + " · " + (vs || "?") + " tokens"; }
    };
  })();
  _llmTokHfCache.set(id, p);
  p.catch(() => _llmTokHfCache.delete(id));
  return p;
}
