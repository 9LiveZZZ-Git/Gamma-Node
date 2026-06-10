/* ============================================================================
 * Phase D §6.3 -- embedding nodes runtime (sprint llm-4)
 *
 * Tick handlers for TokenEmbedding / PositionalEncoding / EmbeddingDropout,
 * dispatched from _tickLLMRuntime's llm-op walk.
 *
 * GPU-TENSOR WIRE CONVENTION (new this sprint): a node that produces
 * GPU-resident tensors keeps the live LLMTensor in its runtime state at
 * _llmGetState(id).tensors[<outPort>] and publishes a CPU-safe stub on
 * params._vec_<port>: { shape, dtype, gpuVer, meta } -- NO data field.
 * GPUBuffers must never ride params (params serialize into .gpatch +
 * undo snapshots). _readGpuTensorWire() resolves the live tensor;
 * `gpuVer` bumps every recompute so consumers' change signatures fire.
 * CPU readback stays viz-only per spec §6.1.
 *
 * Recompute is signature-driven (input gpuVer/content + node params).
 * Old output tensors go to a one-recompute graveyard instead of being
 * destroyed immediately: the _tickLLMRuntime walk is node-list-ordered,
 * not topological, so a downstream node may still bind last tick's
 * tensor this frame.
 * ==========================================================================*/

/* FNV over a Float32Array's bytes -- change signature for CPU id
 * batches (1k elements at tick rate is fine; tensors use gpuVer). */
function _llmVecSig(arr) {
  if (!arr || !arr.length) return "0";
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, Math.min(arr.byteLength, 8192));
  let h = 2166136261;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 16777619);
  }
  return arr.length + ":" + (h >>> 0);
}

/* Resolve a vector-typed input that may be GPU-resident. Returns
 * { gpu, shape, ver, meta } | { cpu, shape, ver, meta } | null.
 *
 * FORWARDING: passthrough nodes (PositionalEncoding rope/alibi,
 * EmbeddingDropout in eval) own no tensor -- they set
 * rt.forwards[<outPort>] = <their own input port> and the resolver
 * follows the chain to the real owner AT READ TIME. The consumer
 * therefore always binds the owner's CURRENT tensor (no per-hop frame
 * lag under the non-topological tick walk) and no node ever
 * graveyards a buffer it didn't allocate. Hop metas merge along the
 * chain (outermost wins) so the rope/alibi tags survive; `ver` comes
 * from the owning leaf so consumer signatures fire exactly when the
 * real tensor changes. */
function _readGpuTensorWire(node, portName) {
  if (!state || !Array.isArray(state.edges)) return null;
  let curNode = node, curPort = portName, meta = null;
  for (let hop = 0; hop < 8; hop++) {
    const e = state.edges.find(e => e && e.to && e.to.node === curNode.id && e.to.port === curPort);
    if (!e || !e.from) break;
    const src = state.nodes.find(n => n && n.id === e.from.node);
    if (!src) break;
    const rt = (typeof _llmGetState === "function") ? _llmGetState(src.id) : null;
    const stub = src.params && src.params["_vec_" + e.from.port];
    if (stub && stub.meta) meta = meta ? { ...stub.meta, ...meta } : stub.meta;
    if (rt && rt.forwards && rt.forwards[e.from.port]) {
      curNode = src;
      curPort = rt.forwards[e.from.port];      // follow to the owner
      continue;
    }
    const gpu = rt && rt.tensors && rt.tensors[e.from.port];
    if (gpu && gpu.buffer) {
      return { gpu, shape: gpu.shape, ver: (stub && stub.gpuVer) || rt._tensorVer || 0, meta: meta || {} };
    }
    break;
  }
  const v = _readVectorWire(node, portName);
  if (v && v.data) return { cpu: v.data, shape: v.shape || [v.data.length], ver: _llmVecSig(v.data), meta: { ...(v.meta || {}), ...(meta || {}) } };
  return null;
}

/* Retire a node's OWNED tensor on an out port (compute -> passthrough
 * transitions, mode changes): rotate it through the graveyard so an
 * already-bound consumer survives the frame, then forget it. */
function _llmRetireTensor(rt, portName) {
  rt._graveyard = rt._graveyard || {};
  const prev = rt._graveyard[portName];
  if (prev && prev !== (rt.tensors && rt.tensors[portName])) { try { prev.destroy(); } catch (_) {} }
  rt._graveyard[portName] = rt.tensors ? rt.tensors[portName] : null;
  if (rt.tensors) delete rt.tensors[portName];
}

/* Publish a GPU tensor the node OWNS on an out port (stub on params,
 * live in rt). Only ever called with tensors this node allocated --
 * passthroughs use rt.forwards, never this. */
function _llmPublishTensor(node, rt, portName, tensor, meta) {
  rt.tensors = rt.tensors || {};
  if (rt.forwards) delete rt.forwards[portName];   // compute supersedes passthrough
  rt._tensorVer = (rt._tensorVer || 0) + 1;
  // Previous tensor -> graveyard; the one before that actually dies.
  rt._graveyard = rt._graveyard || {};
  const prevPrev = rt._graveyard[portName];
  if (prevPrev && prevPrev !== tensor) { try { prevPrev.destroy(); } catch (_) {} }
  rt._graveyard[portName] = rt.tensors[portName];
  rt.tensors[portName] = tensor;
  node.params["_vec_" + portName] = {
    shape: tensor.shape.slice(), dtype: "f32", gpuVer: rt._tensorVer, meta: meta || {}
  };
}

/* Publish a PASSTHROUGH: the out port forwards to one of this node's
 * own input ports; readers resolve to the real owner at read time.
 * Retires any tensor the node previously computed for the port. */
function _llmPublishForward(node, rt, portName, inPort, x, meta) {
  rt.forwards = rt.forwards || {};
  if (rt.tensors && rt.tensors[portName]) _llmRetireTensor(rt, portName);
  rt.forwards[portName] = inPort;
  rt._tensorVer = (rt._tensorVer || 0) + 1;
  node.params["_vec_" + portName] = {
    shape: x.shape.slice(), dtype: "f32", gpuVer: rt._tensorVer,
    meta: { ...(x.meta || {}), ...(meta || {}) }
  };
}

/* --- TokenEmbedding [B,T] ids -> [B,T,D] ----------------------------------- */
function _tickTokenEmbedding(node, rt) {
  const p = node.params;
  if (typeof LLMRT === "undefined" || !_llmrtState.device) {
    if (!rt._embInitKicked) { rt._embInitKicked = true; llmrtInit().catch(() => {}); }
    p.status = "waiting for GPU device…";
    return;
  }
  const ids = _readGpuTensorWire(node, "ids");
  if (!ids || !ids.cpu) { p.status = "wire DatasetLoader.batch in"; return; }
  if (ids.shape && ids.shape.length > 2) { p.status = "⚠ ids must be [B,T] or [T], got [" + ids.shape.join(",") + "]"; return; }
  const dModel = Math.max(2, Math.round(p.dModel) || 64);
  const vocabSize = Math.max(2, Math.round(p.vocabSize) || (ids.meta && ids.meta.vocabSize) || 256);
  const tableSig = vocabSize + "x" + dModel;
  if (rt._embTableSig !== tableSig) {
    rt._embTableSig = tableSig;
    if (rt.table) { try { rt.table.destroy(); } catch (_) {} }
    rt.table = llmrtTensor([vocabSize, dModel],
      llmLayersRandn(vocabSize * dModel, 0.02, vocabSize * 131 + dModel), { requiresGrad: true });
    rt._embInSig = null;                     // force a forward with the new table
  }
  // Shape is part of the signature: a batchSize/seqLen swap that keeps
  // B*T and content identical must still re-run with the new layout.
  const inSig = (ids.shape || []).join("x") + ":" + ids.ver + ":" + tableSig;
  if (rt._embInSig === inSig) return;
  rt._embInSig = inSig;

  const shape = (ids.shape && ids.shape.length === 2) ? ids.shape : [1, ids.cpu.length];
  if (rt._idsT) { try { rt._idsT.destroy(); } catch (_) {} }
  rt._idsT = llmrtTensor(shape, ids.cpu);
  const out = LLMAG.embedding(rt._idsT, rt.table);
  // embedding() returns [B,T,D] via ids.shape.concat([D])
  _llmPublishTensor(node, rt, "emb", out, { kind: "activations", vocabSize, dModel });
  _llmPublishTensor(node, rt, "weights", rt.table, { kind: "weights", trainable: true });
  // weights is the live table, never graveyard-destroyed: undo the
  // graveyard slot the publish just claimed for it.
  rt._graveyard.weights = null;
  p.status = "[" + shape.join(",") + "] → [" + out.shape.join(",") + "] · vocab " + vocabSize;
}

/* --- PositionalEncoding ----------------------------------------------------- */
function _tickPositionalEncoding(node, rt) {
  const p = node.params;
  const x = _readGpuTensorWire(node, "x");
  if (!x || !x.gpu) { p.status = "wire TokenEmbedding.emb in"; return; }
  if (!x.shape || x.shape.length !== 3) { p.status = "⚠ expects [B,T,D] activations, got [" + (x.shape || []).join(",") + "]"; return; }
  const mode = ["sinusoidal", "learned", "rope", "alibi"].includes(p.mode) ? p.mode : "sinusoidal";
  const [B, T, D] = x.shape;

  if (mode === "rope" || mode === "alibi") {
    // Not additive: RoPE rotates Q/K, ALiBi biases attention scores.
    // Forward the wire untouched + tag it so MultiHeadAttention
    // (llm-5) applies the encoding where it belongs. The resolver
    // follows the forward to the owning node at read time -- this
    // node never holds the upstream's tensor.
    const sig = "pass:" + mode + ":" + (p.theta || 10000) + ":" + x.ver;
    if (rt._peSig === sig) return;
    rt._peSig = sig;
    _llmPublishForward(node, rt, "y", "x", x, { positional: mode, ropeTheta: p.theta || 10000 });
    delete node.params._vec_weights;
    p.status = mode + " is applied inside MultiHeadAttention (llm-5) — passthrough + wire tag";
    return;
  }

  const maxLen = Math.max(T, Math.round(p.maxLen) || T);
  const tableSig = mode + ":" + (mode === "learned" ? maxLen : T) + "x" + D;
  if (rt._peTableSig !== tableSig) {
    rt._peTableSig = tableSig;
    if (rt.tensors && rt.tensors.weights) { rt.tensors.weights = null; delete node.params._vec_weights; }
    if (rt.posTable) { try { rt.posTable.destroy(); } catch (_) {} }
    rt.posTable = (mode === "sinusoidal")
      ? llmrtTensor([T, D], llmLayersSinusoidalTable(T, D))
      : llmrtTensor([maxLen, D], llmLayersRandn(maxLen * D, 0.02, maxLen * 257 + D), { requiresGrad: true });
    rt._peSig = null;
  }
  const sig = mode + ":" + x.ver + ":" + tableSig;
  if (rt._peSig === sig) return;
  rt._peSig = sig;
  const out = LLMAG.addRows(x.gpu, rt.posTable);
  _llmPublishTensor(node, rt, "y", out, { ...(x.meta || {}), kind: "activations", positional: mode });
  if (mode === "learned") {
    // Expose the trainable table like TokenEmbedding.weights; it is
    // the live parameter tensor, so keep it out of graveyard rotation.
    _llmPublishTensor(node, rt, "weights", rt.posTable, { kind: "weights", trainable: true });
    rt._graveyard.weights = null;
  } else {
    delete node.params._vec_weights;
  }
  p.status = mode + " · [" + out.shape.join(",") + "]" + (mode === "learned" ? " · trainable[" + maxLen + "," + D + "]" : "");
}

/* --- EmbeddingDropout -------------------------------------------------------- */
function _tickEmbeddingDropout(node, rt) {
  const p = node.params;
  const x = _readGpuTensorWire(node, "x");
  if (!x || !x.gpu) { p.status = "wire an embedding stream in"; return; }
  if (!x.shape || !x.shape.length) { p.status = "⚠ empty input shape"; return; }
  const rate = Math.min(0.95, Math.max(0, Number(p.rate) || 0));
  const training = (Number(p.training) || 0) >= 0.5;
  const sig = x.ver + ":" + rate + ":" + (training ? 1 : 0);
  if (rt._doSig === sig) return;
  rt._doSig = sig;

  if (!training || rate === 0) {
    // Exact passthrough: forward the wire, own nothing.
    _llmPublishForward(node, rt, "y", "x", x, null);
    p.status = training ? "rate 0 · passthrough" : "eval · passthrough";
    return;
  }
  // Fresh mask per recompute (i.e. per batch step) -- inverted dropout,
  // backward flows through the same mask via the tape's mul.
  rt._doSeed = ((rt._doSeed || 0) + 1) >>> 0;
  const n = x.shape.reduce((a, b) => a * b, 1);
  if (rt._mask) { try { rt._mask.destroy(); } catch (_) {} }
  rt._mask = llmrtTensor(x.shape, llmLayersDropoutMask(n, rate, 0x9E3779B9 ^ rt._doSeed));
  const out = LLMAG.mul(x.gpu, rt._mask);
  _llmPublishTensor(node, rt, "y", out, { ...(x.meta || {}), kind: "activations" });
  p.status = "rate " + rate + " · mask resampled · [" + out.shape.join(",") + "]";
}

/* --- llm-4 verify (spec §6.5): console smoke test --------------------------
 * GPU forward (gather + sinusoidal addRows) vs float64 CPU reference;
 * compares per-tensor L2 norms + max element diff. */
async function llm4Test() {
  await llmrtInit();
  const [B, T, D, V] = [2, 16, 64, 256];
  const rng = _llmrtRng(0x5EED);
  const ids = new Float32Array(B * T);
  for (let i = 0; i < ids.length; i++) ids[i] = Math.floor((rng() + 1) / 2 * V) % V;
  const tableV = llmLayersRandn(V * D, 0.02, V * 131 + D);
  const posV = llmLayersSinusoidalTable(T, D);

  const idsT = llmrtTensor([B, T], ids);
  const table = llmrtTensor([V, D], tableV);
  const pos = llmrtTensor([T, D], posV);
  const emb = LLMRT.embedding(idsT, table);
  const out = LLMRT.addRows(emb, pos);
  const gpu = await llmrtRead(out);

  // float64 reference
  const ref = new Float64Array(B * T * D);
  for (let b = 0; b < B; b++) for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) {
    ref[(b * T + t) * D + d] = tableV[ids[b * T + t] * D + d] + posV[t * D + d];
  }
  let maxDiff = 0, nGpu = 0, nRef = 0;
  for (let i = 0; i < ref.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(gpu[i] - ref[i]));
    nGpu += gpu[i] * gpu[i];
    nRef += ref[i] * ref[i];
  }
  nGpu = Math.sqrt(nGpu); nRef = Math.sqrt(nRef);
  const ok = maxDiff < 1e-4 && Math.abs(nGpu - nRef) / nRef < 1e-5;
  console.log((ok ? "OK   " : "FAIL ") + "llm-4 embed+positional  ‖gpu‖=" + nGpu.toFixed(5) +
    " ‖ref‖=" + nRef.toFixed(5) + "  maxDiff=" + maxDiff.toExponential(2));
  [idsT, table, pos, emb, out].forEach(t => t.destroy());
  return { ok, normGpu: nGpu, normRef: nRef, maxDiff };
}
