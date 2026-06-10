/* ============================================================================
 * Phase D §6.4 -- layers (sprint llm-4)
 *
 * Layer-level math for the embedding front of the model: trainable token
 * embedding tables, positional-encoding tables (sinusoidal + learned),
 * inverted-dropout masks, and the one new autograd op this sprint needs:
 *
 *   addRows:  Y[b,t,d] = X[b,t,d] + P[t,d]    (broadcast over batch)
 *   backward: dX = dY;  dP[t,d] = sum_b dY[b,t,d]
 *
 * The op registers itself into the llm-2 tape (LLMAG.addRows + a
 * _llmagBackward entry) -- concatenation order puts this file after
 * autograd.js, same global scope.
 *
 * RoPE + ALiBi are NOT additive tables: RoPE rotates Q/K inside
 * attention, ALiBi biases the score matrix. The PositionalEncoding node
 * passes them through as wire metadata for MultiHeadAttention (llm-5)
 * to apply where they mathematically belong.
 * ==========================================================================*/

const _LLM_LAYERS_WGSL = {
  /* Broadcast row add over the batch dim. */
  add_rows: `
struct P { B:u32, T:u32, D:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> X : array<f32>;
@group(0) @binding(2) var<storage, read> Pt : array<f32>;
@group(0) @binding(3) var<storage, read_write> Y : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.B * p.T * p.D) { return; }
  let d = i % p.D;
  let t = (i / p.D) % p.T;
  Y[i] = X[i] + Pt[t * p.D + d];
}`,

  /* dP[t,d] = sum_b dY[b,t,d]  (dX is just dY, accumulated directly). */
  add_rows_bwd_dP: `
struct P { B:u32, T:u32, D:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> dY : array<f32>;
@group(0) @binding(2) var<storage, read_write> dP : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.T * p.D) { return; }
  var acc = 0.0;
  for (var b = 0u; b < p.B; b = b + 1u) {
    acc = acc + dY[b * p.T * p.D + i];
  }
  dP[i] = acc;
}`
};

/* Forward: X [B,T,D] + table [T',D] (first T rows used; T' >= T). */
LLMRT.addRows = function (X, table) {
  const [B, T, D] = X.shape;
  const Y = llmrtZeros(X.shape);
  _llmrtDispatch("add_rows", _LLM_LAYERS_WGSL.add_rows,
    _llmrtParamsU32F32([B, T, D]), [X, table, Y], B * T * D);
  return Y;
};

_llmagBackward.addRows = function (rec, dOut) {
  const { X, table, B, T, D } = rec.ctx;
  if (X.requiresGrad) {
    const s = llmrtZeros(X.shape);
    _llmrtDispatch("ag_acc", _LLMAG_WGSL.acc, _llmrtParamsU32F32([s.size]), [s, dOut], s.size);
    _llmagAcc(X, s);
  }
  if (table.requiresGrad) {
    // Gradient lands on the first T rows; rows past T stay zero, which
    // the acc into the full [T',D] grad preserves.
    const s = llmrtZeros([T, D]);
    _llmrtDispatch("ag_add_rows_dP", _LLM_LAYERS_WGSL.add_rows_bwd_dP,
      _llmrtParamsU32F32([B, T, D]), [dOut, s], T * D);
    if (table.shape[0] === T) {
      _llmagAcc(table, s);
    } else {
      // Table is [maxLen, D] with maxLen > T: widen into a full-shape
      // scratch before accumulating (fresh buffers are zeroed, so rows
      // >= T stay zero).
      const wide = llmrtZeros(table.shape);
      const enc = _llmrtState.device.createCommandEncoder();
      enc.copyBufferToBuffer(s.buffer, 0, wide.buffer, 0, T * D * 4);
      _llmrtState.device.queue.submit([enc.finish()]);
      s.destroy();
      _llmagAcc(table, wide);
    }
  }
};

LLMAG.addRows = function (X, table) {
  const out = LLMRT.addRows(X, table);
  const [B, T, D] = X.shape;
  _llmagRecord("addRows", [X, table], out, { X, table, B, T, D });
  return out;
};

/* --- table builders --------------------------------------------------------
 * Pure CPU builders (unit-testable offline); upload happens node-side. */

/* GPT-2-style init: N(0, std) via Box-Muller on the deterministic LCG. */
function llmLayersRandn(n, std, seed) {
  const rng = _llmrtRng(seed >>> 0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = (rng() + 1) * 0.5 || 1e-12;   // (0,1]
    const u2 = (rng() + 1) * 0.5;
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2) * std;
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2) * std;
  }
  return out;
}

/* Classic Vaswani sinusoidal table [T, D]:
 * PE[t, 2i] = sin(t / 10000^(2i/D)), PE[t, 2i+1] = cos(same). */
function llmLayersSinusoidalTable(T, D) {
  const out = new Float32Array(T * D);
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < D; i += 2) {
      const freq = Math.pow(10000, -i / D);
      out[t * D + i] = Math.sin(t * freq);
      if (i + 1 < D) out[t * D + i + 1] = Math.cos(t * freq);
    }
  }
  return out;
}

/* Inverted-dropout mask: 0 with probability rate, else 1/(1-rate). */
function llmLayersDropoutMask(n, rate, seed) {
  const rng = _llmrtRng(seed >>> 0);
  const out = new Float32Array(n);
  const keep = 1 - rate;
  const inv = keep > 0 ? 1 / keep : 0;
  for (let i = 0; i < n; i++) {
    out[i] = ((rng() + 1) * 0.5) < rate ? 0 : inv;
  }
  return out;
}
