/* ============================================================================
 * Phase D §6.2 -- autograd tape (sprint llm-2)
 *
 * Tape-based reverse-mode autodiff over the llm-1 runtime (micrograd
 * style, tensor-flavored). The visual graph defines the FORWARD topology
 * only; this tape defines the backward one -- users never see gradient
 * wires.
 *
 *   LLMAG.startTape()                begin recording
 *   LLMAG.mm/mmBiased/softmax/layernorm/rmsnorm/gelu/add/mul/
 *         embedding/sdpa(...)        tape-aware twins of the LLMRT ops
 *   await LLMAG.backward(out, gradOut)  walk the tape in reverse;
 *                                    gradients ACCUMULATE per tensor
 *   LLMAG.gradOf(t)                  the grad tensor (or null)
 *   LLMAG.zeroGrad() / stopTape()    reset between steps
 *   await LLMAG.clipGradNorm(ts, max)  global-norm clip (readback-based
 *                                    skeleton; fused in llm-11)
 *   await LLMAG.gradCheck()          every op's tape gradient vs central
 *                                    finite differences on the GPU
 *                                    forward passes; max rel-err < 1e-3
 *
 * Backward kernels are correctness skeletons like llm-1's forwards: one
 * invocation per output element (or per row), no shared-memory tricks.
 * Column-reduced grads (dGamma/dBeta/dBias/dTable) use one-thread-per-
 * column scans instead of atomics -- WGSL has no f32 atomics, and
 * deterministic sums beat atomic float races for gradCheck anyway.
 * SDPA backward materializes P and dS into scratch ([B,H,T,T]) rather
 * than recomputing flash-style; llm-5's attnWeights output needs P
 * materialized regardless.
 * ==========================================================================*/

const _llmagState = {
  taping: false,
  records: [],            // { op, inputs:[LLMTensor], out:LLMTensor, ctx }
  grads: new Map()        // LLMTensor -> LLMTensor (same shape)
};

function llmagStartTape() {
  _llmagState.taping = true;
  _llmagState.records.length = 0;
}
function llmagStopTape() {
  _llmagState.taping = false;
  _llmagState.records.length = 0;
}
function llmagZeroGrad() {
  for (const g of _llmagState.grads.values()) g.destroy();
  _llmagState.grads.clear();
}

function _llmagRecord(op, inputs, out, ctx) {
  if (!_llmagState.taping) return;
  if (!inputs.some(t => t && t.requiresGrad)) return;
  out.requiresGrad = true;
  out.tapeId = _llmagState.records.length;
  _llmagState.records.push({ op, inputs, out, ctx: ctx || {} });
}

/* Lazily-allocated, zero-initialized grad for a tensor. Mirrors the
 * spec's Tensor.gradBuffer field for downstream consumers. */
function _llmagGrad(t) {
  let g = _llmagState.grads.get(t);
  if (!g) {
    g = llmrtZeros(t.shape);                  // fresh GPUBuffers are zeroed
    _llmagState.grads.set(t, g);
    t.gradBuffer = g.buffer;
  }
  return g;
}
function llmagGradOf(t) { return _llmagState.grads.get(t) || null; }

/* --- backward WGSL --------------------------------------------------------- */
const _LLMAG_WGSL = {

  /* G += S (gradient accumulation; also seeds via zero + acc). */
  acc: `
struct P { N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read_write> G : array<f32>;
@group(0) @binding(2) var<storage, read> S : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.N) { return; }
  G[i] = G[i] + S[i];
}`,

  gelu_bwd: `
struct P { N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> X : array<f32>;
@group(0) @binding(2) var<storage, read> dY : array<f32>;
@group(0) @binding(3) var<storage, read_write> dX : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.N) { return; }
  let x = X[i];
  let t = tanh(0.7978845608028654 * (x + 0.044715 * x * x * x));
  let dt = 0.7978845608028654 * (1.0 + 3.0 * 0.044715 * x * x);
  dX[i] = dY[i] * (0.5 * (1.0 + t) + 0.5 * x * (1.0 - t * t) * dt);
}`,

  /* dA[b,m,k] = sum_n dC[b,m,n] * W[k,n] */
  matmul_bwd_dA: `
struct P { B:u32, M:u32, K:u32, N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> dC : array<f32>;
@group(0) @binding(2) var<storage, read> W : array<f32>;
@group(0) @binding(3) var<storage, read_write> dA : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  let total = p.B * p.M * p.K;
  if (i >= total) { return; }
  let k = i % p.K;
  let m = (i / p.K) % p.M;
  let b = i / (p.K * p.M);
  var acc = 0.0;
  for (var n = 0u; n < p.N; n = n + 1u) {
    acc = acc + dC[(b * p.M + m) * p.N + n] * W[k * p.N + n];
  }
  dA[i] = acc;
}`,

  /* dW[k,n] = sum_b sum_m A[b,m,k] * dC[b,m,n] */
  matmul_bwd_dW: `
struct P { B:u32, M:u32, K:u32, N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> A : array<f32>;
@group(0) @binding(2) var<storage, read> dC : array<f32>;
@group(0) @binding(3) var<storage, read_write> dW : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.K * p.N) { return; }
  let n = i % p.N;
  let k = i / p.N;
  var acc = 0.0;
  for (var b = 0u; b < p.B; b = b + 1u) {
    for (var m = 0u; m < p.M; m = m + 1u) {
      acc = acc + A[(b * p.M + m) * p.K + k] * dC[(b * p.M + m) * p.N + n];
    }
  }
  dW[i] = acc;
}`,

  /* dbias[n] = sum_b sum_m dC[b,m,n] */
  bias_bwd: `
struct P { B:u32, M:u32, N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> dC : array<f32>;
@group(0) @binding(2) var<storage, read_write> db : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let n = gid.x;
  if (n >= p.N) { return; }
  var acc = 0.0;
  for (var r = 0u; r < p.B * p.M; r = r + 1u) {
    acc = acc + dC[r * p.N + n];
  }
  db[n] = acc;
}`,

  /* dX = Y * (dY - rowdot(dY, Y)) */
  softmax_bwd: `
struct P { R:u32, C:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> Y : array<f32>;
@group(0) @binding(2) var<storage, read> dY : array<f32>;
@group(0) @binding(3) var<storage, read_write> dX : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let r = gid.x;
  if (r >= p.R) { return; }
  let base = r * p.C;
  var dot = 0.0;
  for (var c = 0u; c < p.C; c = c + 1u) { dot = dot + dY[base + c] * Y[base + c]; }
  for (var c = 0u; c < p.C; c = c + 1u) {
    dX[base + c] = Y[base + c] * (dY[base + c] - dot);
  }
}`,

  /* Per-row dX + xhat scratch.  g = dY*gamma;
   * dX = inv/C * (C*g - sum(g) - xhat * sum(g*xhat)) */
  layernorm_bwd_dx: `
struct P { R:u32, C:u32, _p0:u32, _p1:u32, eps:f32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> X : array<f32>;
@group(0) @binding(2) var<storage, read> gamma : array<f32>;
@group(0) @binding(3) var<storage, read> dY : array<f32>;
@group(0) @binding(4) var<storage, read_write> dX : array<f32>;
@group(0) @binding(5) var<storage, read_write> xhat : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let r = gid.x;
  if (r >= p.R) { return; }
  let base = r * p.C;
  var mean = 0.0;
  for (var c = 0u; c < p.C; c = c + 1u) { mean = mean + X[base + c]; }
  mean = mean / f32(p.C);
  var v = 0.0;
  for (var c = 0u; c < p.C; c = c + 1u) {
    let d = X[base + c] - mean;
    v = v + d * d;
  }
  let inv = inverseSqrt(v / f32(p.C) + p.eps);
  var sg = 0.0;
  var sgx = 0.0;
  for (var c = 0u; c < p.C; c = c + 1u) {
    let xh = (X[base + c] - mean) * inv;
    xhat[base + c] = xh;
    let g = dY[base + c] * gamma[c];
    sg = sg + g;
    sgx = sgx + g * xh;
  }
  for (var c = 0u; c < p.C; c = c + 1u) {
    let g = dY[base + c] * gamma[c];
    dX[base + c] = (inv / f32(p.C)) * (f32(p.C) * g - sg - xhat[base + c] * sgx);
  }
}`,

  /* dGamma[c] = sum_r dY*xhat ; dBeta[c] = sum_r dY */
  norm_bwd_dgb: `
struct P { R:u32, C:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> xhat : array<f32>;
@group(0) @binding(2) var<storage, read> dY : array<f32>;
@group(0) @binding(3) var<storage, read_write> dGamma : array<f32>;
@group(0) @binding(4) var<storage, read_write> dBeta : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = gid.x;
  if (c >= p.C) { return; }
  var sg = 0.0;
  var sb = 0.0;
  for (var r = 0u; r < p.R; r = r + 1u) {
    sg = sg + dY[r * p.C + c] * xhat[r * p.C + c];
    sb = sb + dY[r * p.C + c];
  }
  dGamma[c] = sg;
  dBeta[c] = sb;
}`,

  /* RMSNorm: g = dY*gamma; dX = inv*(g - x*inv^2*sum(g*x)/C);
   * xnorm scratch = x*inv feeds the shared dGamma column kernel. */
  rmsnorm_bwd_dx: `
struct P { R:u32, C:u32, _p0:u32, _p1:u32, eps:f32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> X : array<f32>;
@group(0) @binding(2) var<storage, read> gamma : array<f32>;
@group(0) @binding(3) var<storage, read> dY : array<f32>;
@group(0) @binding(4) var<storage, read_write> dX : array<f32>;
@group(0) @binding(5) var<storage, read_write> xnorm : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let r = gid.x;
  if (r >= p.R) { return; }
  let base = r * p.C;
  var ss = 0.0;
  for (var c = 0u; c < p.C; c = c + 1u) { ss = ss + X[base + c] * X[base + c]; }
  let inv = inverseSqrt(ss / f32(p.C) + p.eps);
  var sgx = 0.0;
  for (var c = 0u; c < p.C; c = c + 1u) {
    xnorm[base + c] = X[base + c] * inv;
    sgx = sgx + dY[base + c] * gamma[c] * X[base + c];
  }
  for (var c = 0u; c < p.C; c = c + 1u) {
    let g = dY[base + c] * gamma[c];
    dX[base + c] = inv * (g - X[base + c] * inv * inv * sgx / f32(p.C));
  }
}`,

  /* dTable[v,d] = sum over n with ids[n]==v of dY[n,d].  One thread per
   * (v,d) scan -- deterministic, no f32 atomics needed. */
  embedding_bwd: `
struct P { N:u32, V:u32, D:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> ids : array<f32>;
@group(0) @binding(2) var<storage, read> dY : array<f32>;
@group(0) @binding(3) var<storage, read_write> dT : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.V * p.D) { return; }
  let d = i % p.D;
  let v = i / p.D;
  var acc = 0.0;
  for (var n = 0u; n < p.N; n = n + 1u) {
    if (min(u32(ids[n] + 0.5), p.V - 1u) == v) {
      acc = acc + dY[n * p.D + d];
    }
  }
  dT[i] = acc;
}`,

  /* SDPA backward, stage 1: materialize P[b,h,t,s] (same math as the
   * forward, but keeping the probabilities). */
  sdpa_probs: `
struct P { B:u32, H:u32, T:u32, D:u32, causal:u32, _p0:u32, _p1:u32, _p2:u32, scale:f32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> Q : array<f32>;
@group(0) @binding(2) var<storage, read> K : array<f32>;
@group(0) @binding(3) var<storage, read_write> Pr : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.B * p.H * p.T) { return; }
  let t = i % p.T;
  let h = (i / p.T) % p.H;
  let b = i / (p.T * p.H);
  let qBase = ((b * p.H + h) * p.T + t) * p.D;
  let kvBase = (b * p.H + h) * p.T * p.D;
  let pBase = ((b * p.H + h) * p.T + t) * p.T;
  let tMax = select(p.T, t + 1u, p.causal != 0u);
  var mx = -3.0e38;
  for (var s = 0u; s < tMax; s = s + 1u) {
    var dot = 0.0;
    for (var d = 0u; d < p.D; d = d + 1u) {
      dot = dot + Q[qBase + d] * K[kvBase + s * p.D + d];
    }
    mx = max(mx, dot * p.scale);
  }
  var sum = 0.0;
  for (var s = 0u; s < tMax; s = s + 1u) {
    var dot = 0.0;
    for (var d = 0u; d < p.D; d = d + 1u) {
      dot = dot + Q[qBase + d] * K[kvBase + s * p.D + d];
    }
    let w = exp(dot * p.scale - mx);
    Pr[pBase + s] = w;
    sum = sum + w;
  }
  for (var s = 0u; s < tMax; s = s + 1u) { Pr[pBase + s] = Pr[pBase + s] / sum; }
  for (var s = tMax; s < p.T; s = s + 1u) { Pr[pBase + s] = 0.0; }
}`,

  /* Stage 2: dP[t,s] = dY[t,:]·V[s,:];  dS = P*(dP - rowdot(dP,P)). */
  sdpa_ds: `
struct P { B:u32, H:u32, T:u32, D:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> Pr : array<f32>;
@group(0) @binding(2) var<storage, read> V : array<f32>;
@group(0) @binding(3) var<storage, read> dY : array<f32>;
@group(0) @binding(4) var<storage, read_write> dS : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.B * p.H * p.T) { return; }
  let t = i % p.T;
  let h = (i / p.T) % p.H;
  let b = i / (p.T * p.H);
  let yBase = ((b * p.H + h) * p.T + t) * p.D;
  let kvBase = (b * p.H + h) * p.T * p.D;
  let pBase = ((b * p.H + h) * p.T + t) * p.T;
  var dot = 0.0;
  for (var s = 0u; s < p.T; s = s + 1u) {
    var dp = 0.0;
    for (var d = 0u; d < p.D; d = d + 1u) {
      dp = dp + dY[yBase + d] * V[kvBase + s * p.D + d];
    }
    dS[pBase + s] = dp;                       // stash dP first
    dot = dot + dp * Pr[pBase + s];
  }
  for (var s = 0u; s < p.T; s = s + 1u) {
    dS[pBase + s] = Pr[pBase + s] * (dS[pBase + s] - dot);
  }
}`,

  /* Stage 3a: dQ[t,d] = scale * sum_s dS[t,s] K[s,d] */
  sdpa_dq: `
struct P { B:u32, H:u32, T:u32, D:u32, _p0:u32, _p1:u32, _p2:u32, _p3:u32, scale:f32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> dS : array<f32>;
@group(0) @binding(2) var<storage, read> K : array<f32>;
@group(0) @binding(3) var<storage, read_write> dQ : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.B * p.H * p.T * p.D) { return; }
  let d = i % p.D;
  let t = (i / p.D) % p.T;
  let h = (i / (p.D * p.T)) % p.H;
  let b = i / (p.D * p.T * p.H);
  let sBase = ((b * p.H + h) * p.T + t) * p.T;
  let kvBase = (b * p.H + h) * p.T * p.D;
  var acc = 0.0;
  for (var s = 0u; s < p.T; s = s + 1u) {
    acc = acc + dS[sBase + s] * K[kvBase + s * p.D + d];
  }
  dQ[i] = acc * p.scale;
}`,

  /* Stage 3b: dK[s,d] = scale * sum_t dS[t,s] Q[t,d] */
  sdpa_dk: `
struct P { B:u32, H:u32, T:u32, D:u32, _p0:u32, _p1:u32, _p2:u32, _p3:u32, scale:f32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> dS : array<f32>;
@group(0) @binding(2) var<storage, read> Q : array<f32>;
@group(0) @binding(3) var<storage, read_write> dK : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.B * p.H * p.T * p.D) { return; }
  let d = i % p.D;
  let s = (i / p.D) % p.T;
  let h = (i / (p.D * p.T)) % p.H;
  let b = i / (p.D * p.T * p.H);
  let kvBase = (b * p.H + h) * p.T * p.D;
  var acc = 0.0;
  for (var t = 0u; t < p.T; t = t + 1u) {
    acc = acc + dS[((b * p.H + h) * p.T + t) * p.T + s] * Q[kvBase + t * p.D + d];
  }
  dK[i] = acc * p.scale;
}`,

  /* Stage 3c: dV[s,d] = sum_t P[t,s] dY[t,d] */
  sdpa_dv: `
struct P { B:u32, H:u32, T:u32, D:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> Pr : array<f32>;
@group(0) @binding(2) var<storage, read> dY : array<f32>;
@group(0) @binding(3) var<storage, read_write> dV : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.B * p.H * p.T * p.D) { return; }
  let d = i % p.D;
  let s = (i / p.D) % p.T;
  let h = (i / (p.D * p.T)) % p.H;
  let b = i / (p.D * p.T * p.H);
  var acc = 0.0;
  for (var t = 0u; t < p.T; t = t + 1u) {
    acc = acc + Pr[((b * p.H + h) * p.T + t) * p.T + s] * dY[((b * p.H + h) * p.T + t) * p.D + d];
  }
  dV[i] = acc;
}`
};

/* Accumulate scratch into a tensor's grad, then free the scratch. */
function _llmagAcc(target, scratch) {
  const g = _llmagGrad(target);
  _llmrtDispatch("ag_acc", _LLMAG_WGSL.acc, _llmrtParamsU32F32([g.size]), [g, scratch], g.size);
  scratch.destroy();
}

/* --- per-op backward registry (spec §6.2) ---------------------------------- */
const _llmagBackward = {
  add(rec, dOut) {
    for (const inp of rec.inputs) {
      if (!inp.requiresGrad) continue;
      const s = llmrtZeros(inp.shape);
      _llmrtDispatch("ag_acc", _LLMAG_WGSL.acc, _llmrtParamsU32F32([s.size]), [s, dOut], s.size);
      _llmagAcc(inp, s);
    }
  },
  mul(rec, dOut) {
    const [A, B] = rec.inputs;
    if (A.requiresGrad) _llmagAcc(A, LLMRT.mul(dOut, B));      // reuse forward kernel
    if (B.requiresGrad) _llmagAcc(B, LLMRT.mul(dOut, A));
  },
  gelu(rec, dOut) {
    const [X] = rec.inputs;
    if (!X.requiresGrad) return;
    const s = llmrtZeros(X.shape);
    _llmrtDispatch("ag_gelu_bwd", _LLMAG_WGSL.gelu_bwd, _llmrtParamsU32F32([X.size]), [X, dOut, s], X.size);
    _llmagAcc(X, s);
  },
  mm(rec, dOut) {
    const { A, W, B, M, K, N } = rec.ctx;
    if (A.requiresGrad) {
      const s = llmrtZeros(A.shape);
      _llmrtDispatch("ag_mm_dA", _LLMAG_WGSL.matmul_bwd_dA, _llmrtParamsU32F32([B, M, K, N]), [dOut, W, s], B * M * K);
      _llmagAcc(A, s);
    }
    if (W.requiresGrad) {
      const s = llmrtZeros(W.shape);
      _llmrtDispatch("ag_mm_dW", _LLMAG_WGSL.matmul_bwd_dW, _llmrtParamsU32F32([B, M, K, N]), [A, dOut, s], K * N);
      _llmagAcc(W, s);
    }
  },
  mmBiased(rec, dOut) {
    _llmagBackward.mm(rec, dOut);
    const { bias, B, M, N } = rec.ctx;
    if (bias.requiresGrad) {
      const s = llmrtZeros(bias.shape);
      _llmrtDispatch("ag_bias_bwd", _LLMAG_WGSL.bias_bwd, _llmrtParamsU32F32([B, M, N]), [dOut, s], N);
      _llmagAcc(bias, s);
    }
  },
  softmax(rec, dOut) {
    const [X] = rec.inputs;
    if (!X.requiresGrad) return;
    const C = X.shape[X.shape.length - 1], R = X.size / C;
    const s = llmrtZeros(X.shape);
    _llmrtDispatch("ag_softmax_bwd", _LLMAG_WGSL.softmax_bwd, _llmrtParamsU32F32([R, C]), [rec.out, dOut, s], R);
    _llmagAcc(X, s);
  },
  layernorm(rec, dOut) {
    const { X, gamma, beta, eps } = rec.ctx;
    const C = X.shape[X.shape.length - 1], R = X.size / C;
    const xhat = llmrtZeros(X.shape);
    if (X.requiresGrad) {
      const s = llmrtZeros(X.shape);
      _llmrtDispatch("ag_ln_dx", _LLMAG_WGSL.layernorm_bwd_dx,
        _llmrtParamsU32F32([R, C, 0, 0], [eps]), [X, gamma, dOut, s, xhat], R);
      _llmagAcc(X, s);
    } else {
      // xhat is still needed for dGamma -- run the kernel into a junk dX.
      const junk = llmrtZeros(X.shape);
      _llmrtDispatch("ag_ln_dx", _LLMAG_WGSL.layernorm_bwd_dx,
        _llmrtParamsU32F32([R, C, 0, 0], [eps]), [X, gamma, dOut, junk, xhat], R);
      junk.destroy();
    }
    if (gamma.requiresGrad || beta.requiresGrad) {
      const dg = llmrtZeros(gamma.shape), db = llmrtZeros(beta.shape);
      _llmrtDispatch("ag_norm_dgb", _LLMAG_WGSL.norm_bwd_dgb, _llmrtParamsU32F32([R, C]), [xhat, dOut, dg, db], C);
      if (gamma.requiresGrad) _llmagAcc(gamma, dg); else dg.destroy();
      if (beta.requiresGrad) _llmagAcc(beta, db); else db.destroy();
    }
    xhat.destroy();
  },
  rmsnorm(rec, dOut) {
    const { X, gamma, eps } = rec.ctx;
    const C = X.shape[X.shape.length - 1], R = X.size / C;
    const xnorm = llmrtZeros(X.shape);
    const dx = llmrtZeros(X.shape);
    _llmrtDispatch("ag_rms_dx", _LLMAG_WGSL.rmsnorm_bwd_dx,
      _llmrtParamsU32F32([R, C, 0, 0], [eps]), [X, gamma, dOut, dx, xnorm], R);
    if (X.requiresGrad) _llmagAcc(X, dx); else dx.destroy();
    if (gamma.requiresGrad) {
      const dg = llmrtZeros(gamma.shape), junk = llmrtZeros(gamma.shape);
      _llmrtDispatch("ag_norm_dgb", _LLMAG_WGSL.norm_bwd_dgb, _llmrtParamsU32F32([R, C]), [xnorm, dOut, dg, junk], C);
      _llmagAcc(gamma, dg);
      junk.destroy();
    }
    xnorm.destroy();
  },
  embedding(rec, dOut) {
    const { ids, table, N, V, D } = rec.ctx;
    if (!table.requiresGrad) return;            // ids are integers, no grad
    const s = llmrtZeros(table.shape);
    _llmrtDispatch("ag_emb_bwd", _LLMAG_WGSL.embedding_bwd, _llmrtParamsU32F32([N, V, D]), [ids, dOut, s], V * D);
    _llmagAcc(table, s);
  },
  sdpa(rec, dOut) {
    const { Q, K, V, B, H, T, D, causal, scale } = rec.ctx;
    const Pr = llmrtZeros([B, H, T, T]);
    const dS = llmrtZeros([B, H, T, T]);
    _llmrtDispatch("ag_sdpa_probs", _LLMAG_WGSL.sdpa_probs,
      _llmrtParamsU32F32([B, H, T, D, causal, 0, 0, 0], [scale]), [Q, K, Pr], B * H * T);
    _llmrtDispatch("ag_sdpa_ds", _LLMAG_WGSL.sdpa_ds,
      _llmrtParamsU32F32([B, H, T, D]), [Pr, V, dOut, dS], B * H * T);
    if (Q.requiresGrad) {
      const s = llmrtZeros(Q.shape);
      _llmrtDispatch("ag_sdpa_dq", _LLMAG_WGSL.sdpa_dq,
        _llmrtParamsU32F32([B, H, T, D, 0, 0, 0, 0], [scale]), [dS, K, s], Q.size);
      _llmagAcc(Q, s);
    }
    if (K.requiresGrad) {
      const s = llmrtZeros(K.shape);
      _llmrtDispatch("ag_sdpa_dk", _LLMAG_WGSL.sdpa_dk,
        _llmrtParamsU32F32([B, H, T, D, 0, 0, 0, 0], [scale]), [dS, Q, s], K.size);
      _llmagAcc(K, s);
    }
    if (V.requiresGrad) {
      const s = llmrtZeros(V.shape);
      _llmrtDispatch("ag_sdpa_dv", _LLMAG_WGSL.sdpa_dv,
        _llmrtParamsU32F32([B, H, T, D]), [Pr, dOut, s], V.size);
      _llmagAcc(V, s);
    }
    Pr.destroy();
    dS.destroy();
  }
};

/* --- tape-aware op twins ---------------------------------------------------
 * Same signatures as LLMRT.*; record enough ctx for the backward. */
const LLMAG = {
  startTape: llmagStartTape,
  stopTape: llmagStopTape,
  zeroGrad: llmagZeroGrad,
  gradOf: llmagGradOf,

  mm(A, W) {
    const out = LLMRT.mm(A, W);
    const a3 = A.shape.length === 3 ? A.shape : [1, A.shape[0], A.shape[1]];
    _llmagRecord("mm", [A, W], out, { A, W, B: a3[0], M: a3[1], K: a3[2], N: W.shape[1] });
    return out;
  },
  mmBiased(A, W, bias) {
    const out = LLMRT.mmBiased(A, W, bias);
    const a3 = A.shape.length === 3 ? A.shape : [1, A.shape[0], A.shape[1]];
    _llmagRecord("mmBiased", [A, W, bias], out, { A, W, bias, B: a3[0], M: a3[1], K: a3[2], N: W.shape[1] });
    return out;
  },
  softmax(X) {
    const out = LLMRT.softmax(X);
    _llmagRecord("softmax", [X], out, {});
    return out;
  },
  layernorm(X, gamma, beta, eps) {
    const e = eps == null ? 1e-5 : eps;
    const out = LLMRT.layernorm(X, gamma, beta, e);
    _llmagRecord("layernorm", [X, gamma, beta], out, { X, gamma, beta, eps: e });
    return out;
  },
  rmsnorm(X, gamma, eps) {
    const e = eps == null ? 1e-5 : eps;
    const out = LLMRT.rmsnorm(X, gamma, e);
    _llmagRecord("rmsnorm", [X, gamma], out, { X, gamma, eps: e });
    return out;
  },
  gelu(X) {
    const out = LLMRT.gelu(X);
    _llmagRecord("gelu", [X], out, {});
    return out;
  },
  add(A, B) {
    const out = LLMRT.add(A, B);
    _llmagRecord("add", [A, B], out, {});
    return out;
  },
  mul(A, B) {
    const out = LLMRT.mul(A, B);
    _llmagRecord("mul", [A, B], out, {});
    return out;
  },
  embedding(ids, table) {
    const out = LLMRT.embedding(ids, table);
    _llmagRecord("embedding", [ids, table], out,
      { ids, table, N: ids.size, V: table.shape[0], D: table.shape[1] });
    return out;
  },
  sdpa(Q, K, V, opts) {
    const out = LLMRT.sdpa(Q, K, V, opts);
    const [B, H, T, D] = Q.shape;
    _llmagRecord("sdpa", [Q, K, V], out,
      { Q, K, V, B, H, T, D, causal: (opts && opts.causal) ? 1 : 0, scale: 1 / Math.sqrt(D) });
    return out;
  },

  /* Reverse walk. `gradOut` seeds d(out); defaults to ones (sum-loss
   * semantics). Gradients ACCUMULATE across backward() calls until
   * zeroGrad(). Returns after the GPU queue has the full backward. */
  async backward(out, gradOut) {
    const dOutSeed = _llmagGrad(out);
    if (gradOut) {
      _llmrtDispatch("ag_acc", _LLMAG_WGSL.acc, _llmrtParamsU32F32([dOutSeed.size]), [dOutSeed, gradOut], dOutSeed.size);
    } else {
      const ones = llmrtTensor(out.shape, new Float32Array(out.size).fill(1));
      _llmrtDispatch("ag_acc", _LLMAG_WGSL.acc, _llmrtParamsU32F32([dOutSeed.size]), [dOutSeed, ones], dOutSeed.size);
      ones.destroy();
    }
    for (let i = _llmagState.records.length - 1; i >= 0; i--) {
      const rec = _llmagState.records[i];
      const dOut = _llmagState.grads.get(rec.out);
      if (!dOut) continue;                       // never contributed to the loss
      _llmagBackward[rec.op](rec, dOut);
    }
  },

  /* Global-norm clip. Readback skeleton -- llm-11 fuses this. */
  async clipGradNorm(tensors, maxNorm) {
    let total = 0;
    const grads = [];
    for (const t of tensors) {
      const g = llmagGradOf(t);
      if (!g) continue;
      const v = await llmrtRead(g);
      grads.push({ g, v });
      for (let i = 0; i < v.length; i++) total += v[i] * v[i];
    }
    total = Math.sqrt(total);
    if (total <= maxNorm) return total;
    const k = maxNorm / (total + 1e-6);
    for (const { g, v } of grads) {
      for (let i = 0; i < v.length; i++) v[i] *= k;
      _llmrtState.device.queue.writeBuffer(g.buffer, 0, v);
    }
    return total;
  },

  test: llmagGradCheck,
  gradCheck: llmagGradCheck
};

/* --- gradient check (spec llm-2 verify) ------------------------------------
 * For each op: run the tape-aware forward with a fixed random gradOut
 * seed, backward once, then compare every input-tensor gradient against
 * central finite differences of the GPU FORWARD pass:
 *     dL/dx[i] ~ (L(x[i]+h) - L(x[i]-h)) / 2h,  L = dot(out, gradOut)
 * Max |analytic - numeric| / max(1, |numeric|) must stay under 1e-3
 * (f32 forward + h=1e-2 central differences). */
async function llmagGradCheck() {
  await llmrtInit();
  const rng = _llmrtRng(0xBADF00D);
  const TOL = 1e-3;
  const H = 1e-2;
  const results = [];

  /* L(x) for FD: rewrite one input value, rerun plain forward, dot with seed. */
  async function lossAt(forward, inputs, seedV) {
    const out = forward();
    const o = await llmrtRead(out);
    out.destroy();
    let L = 0;
    for (let i = 0; i < o.length; i++) L += o[i] * seedV[i];
    return L;
  }

  async function checkOp(name, makeInputs, forward, checkTensors, sampleCap) {
    const inputs = makeInputs();
    llmagStartTape();
    const out = forward(inputs);
    const seedV = _llmrtFill(out.size, rng).map(x => x); // fixed seed
    const seed = llmrtTensor(out.shape, seedV);
    await LLMAG.backward(out, seed);
    let maxErr = 0;
    for (const key of checkTensors) {
      const t = inputs[key];
      const analytic = await llmrtRead(llmagGradOf(t));
      const data = await llmrtRead(t);
      const total = data.length;
      const stride = sampleCap && total > sampleCap ? Math.ceil(total / sampleCap) : 1;
      for (let i = 0; i < total; i += stride) {
        const orig = data[i];
        data[i] = orig + H;
        t.upload(data);
        const Lp = await lossAt(() => forward(inputs, true), inputs, seedV);
        data[i] = orig - H;
        t.upload(data);
        const Lm = await lossAt(() => forward(inputs, true), inputs, seedV);
        data[i] = orig;
        t.upload(data);
        const numeric = (Lp - Lm) / (2 * H);
        const err = Math.abs(analytic[i] - numeric) / Math.max(1, Math.abs(numeric));
        if (err > maxErr) maxErr = err;
      }
    }
    seed.destroy();
    llmagZeroGrad();
    llmagStopTape();
    for (const k of Object.keys(inputs)) { try { inputs[k].destroy(); } catch (_) {} }
    const ok = maxErr < TOL && Number.isFinite(maxErr);
    results.push({ name, ok, maxErr });
    console.log((ok ? "OK   " : "FAIL ") + name + "  maxRelErr=" + maxErr.toExponential(2));
  }

  const g = (shape) => llmrtTensor(shape, _llmrtFill(shape.reduce((a, b) => a * b, 1), rng), { requiresGrad: true });

  await checkOp("add",
    () => ({ A: g([40]), B: g([40]) }),
    (t, plain) => (plain ? LLMRT : LLMAG).add(t.A, t.B), ["A", "B"]);
  await checkOp("mul",
    () => ({ A: g([40]), B: g([40]) }),
    (t, plain) => (plain ? LLMRT : LLMAG).mul(t.A, t.B), ["A", "B"]);
  await checkOp("gelu",
    () => ({ X: g([40]) }),
    (t, plain) => (plain ? LLMRT : LLMAG).gelu(t.X), ["X"]);
  await checkOp("mm",
    () => ({ A: g([2, 4, 5]), W: g([5, 3]) }),
    (t, plain) => (plain ? LLMRT : LLMAG).mm(t.A, t.W), ["A", "W"]);
  await checkOp("mmBiased",
    () => ({ A: g([2, 4, 5]), W: g([5, 3]), bias: g([3]) }),
    (t, plain) => (plain ? LLMRT : LLMAG).mmBiased(t.A, t.W, t.bias), ["A", "W", "bias"]);
  await checkOp("softmax",
    () => ({ X: g([5, 7]) }),
    (t, plain) => (plain ? LLMRT : LLMAG).softmax(t.X), ["X"]);
  await checkOp("layernorm",
    () => ({ X: g([4, 6]), gamma: g([6]), beta: g([6]) }),
    (t, plain) => (plain ? LLMRT : LLMAG).layernorm(t.X, t.gamma, t.beta, 1e-5), ["X", "gamma", "beta"]);
  await checkOp("rmsnorm",
    () => ({ X: g([4, 6]), gamma: g([6]) }),
    (t, plain) => (plain ? LLMRT : LLMAG).rmsnorm(t.X, t.gamma, 1e-5), ["X", "gamma"]);
  {
    // embedding: ids fixed (no grad), table checked
    const ids = new Float32Array(8);
    for (let i = 0; i < 8; i++) ids[i] = Math.floor((rng() + 1) / 2 * 10) % 10;
    await checkOp("embedding",
      () => ({ ids: llmrtTensor([8], ids), table: g([10, 4]) }),
      (t, plain) => (plain ? LLMRT : LLMAG).embedding(t.ids, t.table), ["table"]);
  }
  await checkOp("sdpa(causal)",
    () => ({ Q: g([1, 2, 5, 4]), K: g([1, 2, 5, 4]), V: g([1, 2, 5, 4]) }),
    (t, plain) => (plain ? LLMRT : LLMAG).sdpa(t.Q, t.K, t.V, { causal: true }), ["Q", "K", "V"], 24);

  const ok = results.every(r => r.ok);
  console.log(ok ? "LLMAG: gradCheck OK for all " + results.length + " ops" : "LLMAG: gradCheck FAILURES present");
  return { ok, results };
}
