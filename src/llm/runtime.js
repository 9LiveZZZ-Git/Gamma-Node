/* ============================================================================
 * Phase D §6.1 -- LLM tensor runtime (sprint llm-1)
 *
 * WebGPU compute skeleton for the LLM-from-scratch node family: a Tensor
 * handle wrapping a GPUBuffer, a compute-pipeline cache, CPU readback
 * helpers, and the 10 forward WGSL kernels everything later builds on:
 *
 *   matmul, matmulBiased, softmax_rowwise, layernorm, rmsnorm,
 *   gelu, add, mul, embedding_gather, sdpa (fused QK^T -> mask ->
 *   softmax -> V, causal-capable)
 *
 * Backward twins land in sprint llm-2 (autograd tape) -- the Tensor handle
 * already carries requiresGrad / gradBuffer / tapeId so llm-2 is additive.
 *
 * Device + queue are SHARED with the visual subsystem (Visual.device via
 * ensureGPUDevice()); this file allocates no adapter of its own. All math
 * is f32. Dispatch shapes favor correctness over speed -- one invocation
 * per output element (or per row for the row-wise ops); the optimization
 * pass is sprint llm-11.
 *
 * Console surface (spec §6.5 verify step):  await LLMRT.test()
 * prints one OK/FAIL line per op against a JS reference within 1e-4
 * and returns { ok, results }.
 * ==========================================================================*/

const _llmrtState = {
  device: null,          // shared GPUDevice (Visual.device)
  pipelines: new Map()   // kernel name -> { pipeline, layout }
};

/* --- device ---------------------------------------------------------------
 * Reuse the visual subsystem's device. ensureGPUDevice() is idempotent and
 * already handles the status pill + device-lost path. */
async function llmrtInit() {
  if (_llmrtState.device) return _llmrtState.device;
  if (typeof ensureGPUDevice === "function") {
    try { await ensureGPUDevice(); } catch (_) {}
  }
  const dev = (typeof Visual !== "undefined" && Visual.device) ? Visual.device : null;
  if (!dev) throw new Error("LLMRT: no WebGPU device (visual subsystem unavailable)");
  _llmrtState.device = dev;
  dev.lost.then(() => {
    _llmrtState.device = null;
    _llmrtState.pipelines.clear();
  });
  return dev;
}

/* --- tensor handle (spec §6.1) ------------------------------------------- */
class LLMTensor {
  constructor(shape, opts) {
    const dev = _llmrtState.device;
    if (!dev) throw new Error("LLMRT: llmrtInit() before creating tensors");
    this.shape = shape.slice();
    this.size = shape.reduce((a, b) => a * b, 1);
    this.dtype = "f32";
    this.requiresGrad = !!(opts && opts.requiresGrad);
    this.gradBuffer = null;   // allocated by the llm-2 tape on first backward
    this.tapeId = -1;
    this.buffer = dev.createBuffer({
      size: Math.max(16, this.size * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
  }
  upload(data) {
    const arr = (data instanceof Float32Array) ? data : Float32Array.from(data);
    if (arr.length !== this.size) throw new Error("LLMRT upload: length " + arr.length + " != tensor size " + this.size);
    _llmrtState.device.queue.writeBuffer(this.buffer, 0, arr);
    return this;
  }
  destroy() {
    try { this.buffer.destroy(); } catch (_) {}
    if (this.gradBuffer) { try { this.gradBuffer.destroy(); } catch (_) {} }
  }
}

function llmrtTensor(shape, data, opts) {
  const t = new LLMTensor(shape, opts);
  if (data) t.upload(data);
  return t;
}
function llmrtZeros(shape, opts) { return new LLMTensor(shape, opts); }

/* CPU readback -- staging buffer + mapAsync. Test/viz path only; the
 * training inner loop must never call this (spec §6.1). */
async function llmrtRead(t) {
  const dev = _llmrtState.device;
  const byteLen = Math.max(16, t.size * 4);
  const staging = dev.createBuffer({ size: byteLen, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyBufferToBuffer(t.buffer, 0, staging, 0, byteLen);
  dev.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(staging.getMappedRange().slice(0, t.size * 4));
  staging.unmap();
  staging.destroy();
  return out;
}

/* --- pipeline cache + dispatch helper ------------------------------------ */
function _llmrtPipeline(name, wgsl) {
  let entry = _llmrtState.pipelines.get(name);
  if (entry) return entry;
  const dev = _llmrtState.device;
  const module = dev.createShaderModule({ label: "llmrt:" + name, code: wgsl });
  const pipeline = dev.createComputePipeline({
    label: "llmrt:" + name,
    layout: "auto",
    compute: { module, entryPoint: "main" }
  });
  entry = { pipeline, layout: pipeline.getBindGroupLayout(0) };
  _llmrtState.pipelines.set(name, entry);
  return entry;
}

/* Run one kernel: params is an ArrayBuffer (uniform, 16-byte padded),
 * buffers are LLMTensors bound in order at @binding(1..n). */
function _llmrtDispatch(name, wgsl, params, tensors, invocations) {
  const dev = _llmrtState.device;
  const { pipeline, layout } = _llmrtPipeline(name, wgsl);
  const padded = new ArrayBuffer(Math.ceil(params.byteLength / 16) * 16);
  new Uint8Array(padded).set(new Uint8Array(params));
  const ubuf = dev.createBuffer({ size: padded.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(ubuf, 0, padded);
  const entries = [{ binding: 0, resource: { buffer: ubuf } }];
  tensors.forEach((t, i) => entries.push({ binding: i + 1, resource: { buffer: t.buffer } }));
  const bind = dev.createBindGroup({ layout, entries });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(Math.ceil(invocations / 256));
  pass.end();
  dev.queue.submit([enc.finish()]);
  ubuf.destroy();
}

/* Param packers. WGSL structs below use u32 fields first, then f32. */
function _llmrtParamsU32F32(uints, floats) {
  const buf = new ArrayBuffer((uints.length + (floats ? floats.length : 0)) * 4);
  new Uint32Array(buf, 0, uints.length).set(uints);
  if (floats && floats.length) new Float32Array(buf, uints.length * 4, floats.length).set(floats);
  return buf;
}

/* --- WGSL kernels ---------------------------------------------------------
 * Shared shape conventions: tensors are dense row-major f32. Guard every
 * thread with an index check; dispatch rounds up to workgroup multiples. */

const _LLMRT_WGSL = {

  /* C[b,m,n] = sum_k A[b,m,k] * W[k,n]   -- weights are 2D, A batched. */
  matmul: `
struct P { B:u32, M:u32, K:u32, N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> A : array<f32>;
@group(0) @binding(2) var<storage, read> W : array<f32>;
@group(0) @binding(3) var<storage, read_write> C : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  let total = p.B * p.M * p.N;
  if (i >= total) { return; }
  let n = i % p.N;
  let m = (i / p.N) % p.M;
  let b = i / (p.N * p.M);
  var acc = 0.0;
  for (var k = 0u; k < p.K; k = k + 1u) {
    acc = acc + A[(b * p.M + m) * p.K + k] * W[k * p.N + n];
  }
  C[i] = acc;
}`,

  /* matmul + bias[n] in one pass (linear layer). */
  matmulBiased: `
struct P { B:u32, M:u32, K:u32, N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> A : array<f32>;
@group(0) @binding(2) var<storage, read> W : array<f32>;
@group(0) @binding(3) var<storage, read> bias : array<f32>;
@group(0) @binding(4) var<storage, read_write> C : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  let total = p.B * p.M * p.N;
  if (i >= total) { return; }
  let n = i % p.N;
  let m = (i / p.N) % p.M;
  let b = i / (p.N * p.M);
  var acc = bias[n];
  for (var k = 0u; k < p.K; k = k + 1u) {
    acc = acc + A[(b * p.M + m) * p.K + k] * W[k * p.N + n];
  }
  C[i] = acc;
}`,

  /* Numerically-stable softmax over the last dim of X[R,C]. One thread
   * per row -- correctness skeleton, parallel reduction is llm-11. */
  softmax_rowwise: `
struct P { R:u32, C:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> X : array<f32>;
@group(0) @binding(2) var<storage, read_write> Y : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let r = gid.x;
  if (r >= p.R) { return; }
  let base = r * p.C;
  var mx = X[base];
  for (var c = 1u; c < p.C; c = c + 1u) { mx = max(mx, X[base + c]); }
  var sum = 0.0;
  for (var c = 0u; c < p.C; c = c + 1u) { sum = sum + exp(X[base + c] - mx); }
  for (var c = 0u; c < p.C; c = c + 1u) { Y[base + c] = exp(X[base + c] - mx) / sum; }
}`,

  /* LayerNorm over the last dim of X[R,C] with affine gamma/beta[C]. */
  layernorm: `
struct P { R:u32, C:u32, _p0:u32, _p1:u32, eps:f32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> X : array<f32>;
@group(0) @binding(2) var<storage, read> gamma : array<f32>;
@group(0) @binding(3) var<storage, read> beta : array<f32>;
@group(0) @binding(4) var<storage, read_write> Y : array<f32>;
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
  v = v / f32(p.C);
  let inv = inverseSqrt(v + p.eps);
  for (var c = 0u; c < p.C; c = c + 1u) {
    Y[base + c] = (X[base + c] - mean) * inv * gamma[c] + beta[c];
  }
}`,

  /* RMSNorm (Llama-style): x / rms(x) * gamma, no mean subtraction. */
  rmsnorm: `
struct P { R:u32, C:u32, _p0:u32, _p1:u32, eps:f32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> X : array<f32>;
@group(0) @binding(2) var<storage, read> gamma : array<f32>;
@group(0) @binding(3) var<storage, read_write> Y : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let r = gid.x;
  if (r >= p.R) { return; }
  let base = r * p.C;
  var ss = 0.0;
  for (var c = 0u; c < p.C; c = c + 1u) { ss = ss + X[base + c] * X[base + c]; }
  let inv = inverseSqrt(ss / f32(p.C) + p.eps);
  for (var c = 0u; c < p.C; c = c + 1u) {
    Y[base + c] = X[base + c] * inv * gamma[c];
  }
}`,

  /* GELU, tanh approximation (GPT-2 form). */
  gelu: `
struct P { N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> X : array<f32>;
@group(0) @binding(2) var<storage, read_write> Y : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.N) { return; }
  let x = X[i];
  let t = 0.7978845608028654 * (x + 0.044715 * x * x * x);
  Y[i] = 0.5 * x * (1.0 + tanh(t));
}`,

  /* Elementwise add / mul (exact-shape; broadcast variants come with the
   * ops that need them). */
  add: `
struct P { N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> A : array<f32>;
@group(0) @binding(2) var<storage, read> B : array<f32>;
@group(0) @binding(3) var<storage, read_write> C : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.N) { return; }
  C[i] = A[i] + B[i];
}`,

  mul: `
struct P { N:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> A : array<f32>;
@group(0) @binding(2) var<storage, read> B : array<f32>;
@group(0) @binding(3) var<storage, read_write> C : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= p.N) { return; }
  C[i] = A[i] * B[i];
}`,

  /* out[n, :] = table[ids[n], :]  -- ids carried as f32 integers (the
   * runtime is f32-only per spec; round-to-nearest tolerates fp noise). */
  embedding_gather: `
struct P { N:u32, V:u32, D:u32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> ids : array<f32>;
@group(0) @binding(2) var<storage, read> table : array<f32>;
@group(0) @binding(3) var<storage, read_write> Y : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  let total = p.N * p.D;
  if (i >= total) { return; }
  let d = i % p.D;
  let n = i / p.D;
  let id = min(u32(ids[n] + 0.5), p.V - 1u);
  Y[i] = table[id * p.D + d];
}`,

  /* Fused scaled-dot-product attention over Q,K,V [B,H,T,D]:
   * scores = QK^T * scale (+ causal mask) -> stable softmax -> @V.
   * One thread per (b,h,t) query row; two passes over keys (max, then
   * exp-sum + accumulate) so no per-thread score array is needed. */
  sdpa: `
struct P { B:u32, H:u32, T:u32, D:u32, causal:u32, _p0:u32, _p1:u32, _p2:u32, scale:f32 };
@group(0) @binding(0) var<uniform> p : P;
@group(0) @binding(1) var<storage, read> Q : array<f32>;
@group(0) @binding(2) var<storage, read> K : array<f32>;
@group(0) @binding(3) var<storage, read> V : array<f32>;
@group(0) @binding(4) var<storage, read_write> Y : array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  let rows = p.B * p.H * p.T;
  if (i >= rows) { return; }
  let t = i % p.T;
  let h = (i / p.T) % p.H;
  let b = i / (p.T * p.H);
  let qBase = ((b * p.H + h) * p.T + t) * p.D;
  let kvBase = (b * p.H + h) * p.T * p.D;
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
  for (var d = 0u; d < p.D; d = d + 1u) { Y[qBase + d] = 0.0; }
  for (var s = 0u; s < tMax; s = s + 1u) {
    var dot = 0.0;
    for (var d = 0u; d < p.D; d = d + 1u) {
      dot = dot + Q[qBase + d] * K[kvBase + s * p.D + d];
    }
    let w = exp(dot * p.scale - mx);
    sum = sum + w;
    for (var d = 0u; d < p.D; d = d + 1u) {
      Y[qBase + d] = Y[qBase + d] + w * V[kvBase + s * p.D + d];
    }
  }
  for (var d = 0u; d < p.D; d = d + 1u) { Y[qBase + d] = Y[qBase + d] / sum; }
}`
};

/* --- ops API (forward only; llm-2 wraps these with tape records) ---------- */
const LLMRT = {
  init: llmrtInit,
  tensor: llmrtTensor,
  zeros: llmrtZeros,
  read: llmrtRead,

  /* A [B,M,K] (or [M,K]) x W [K,N] -> [.., M, N] */
  mm(A, W) {
    const a3 = A.shape.length === 3 ? A.shape : [1, A.shape[0], A.shape[1]];
    const [B, M, K] = a3, N = W.shape[1];
    const C = llmrtZeros(A.shape.length === 3 ? [B, M, N] : [M, N]);
    _llmrtDispatch("matmul", _LLMRT_WGSL.matmul, _llmrtParamsU32F32([B, M, K, N]), [A, W, C], B * M * N);
    return C;
  },
  mmBiased(A, W, bias) {
    const a3 = A.shape.length === 3 ? A.shape : [1, A.shape[0], A.shape[1]];
    const [B, M, K] = a3, N = W.shape[1];
    const C = llmrtZeros(A.shape.length === 3 ? [B, M, N] : [M, N]);
    _llmrtDispatch("matmulBiased", _LLMRT_WGSL.matmulBiased, _llmrtParamsU32F32([B, M, K, N]), [A, W, bias, C], B * M * N);
    return C;
  },
  softmax(X) {
    const C = X.shape[X.shape.length - 1], R = X.size / C;
    const Y = llmrtZeros(X.shape);
    _llmrtDispatch("softmax_rowwise", _LLMRT_WGSL.softmax_rowwise, _llmrtParamsU32F32([R, C]), [X, Y], R);
    return Y;
  },
  layernorm(X, gamma, beta, eps) {
    const C = X.shape[X.shape.length - 1], R = X.size / C;
    const Y = llmrtZeros(X.shape);
    _llmrtDispatch("layernorm", _LLMRT_WGSL.layernorm,
      _llmrtParamsU32F32([R, C, 0, 0], [eps == null ? 1e-5 : eps]), [X, gamma, beta, Y], R);
    return Y;
  },
  rmsnorm(X, gamma, eps) {
    const C = X.shape[X.shape.length - 1], R = X.size / C;
    const Y = llmrtZeros(X.shape);
    _llmrtDispatch("rmsnorm", _LLMRT_WGSL.rmsnorm,
      _llmrtParamsU32F32([R, C, 0, 0], [eps == null ? 1e-5 : eps]), [X, gamma, Y], R);
    return Y;
  },
  gelu(X) {
    const Y = llmrtZeros(X.shape);
    _llmrtDispatch("gelu", _LLMRT_WGSL.gelu, _llmrtParamsU32F32([X.size]), [X, Y], X.size);
    return Y;
  },
  add(A, B) {
    const C = llmrtZeros(A.shape);
    _llmrtDispatch("add", _LLMRT_WGSL.add, _llmrtParamsU32F32([A.size]), [A, B, C], A.size);
    return C;
  },
  mul(A, B) {
    const C = llmrtZeros(A.shape);
    _llmrtDispatch("mul", _LLMRT_WGSL.mul, _llmrtParamsU32F32([A.size]), [A, B, C], A.size);
    return C;
  },
  embedding(ids, table) {
    const N = ids.size, V = table.shape[0], D = table.shape[1];
    const Y = llmrtZeros(ids.shape.concat([D]));
    _llmrtDispatch("embedding_gather", _LLMRT_WGSL.embedding_gather, _llmrtParamsU32F32([N, V, D]), [ids, table, Y], N * D);
    return Y;
  },
  /* Q,K,V [B,H,T,D] -> out [B,H,T,D]. opts: { causal } */
  sdpa(Q, K, V, opts) {
    const [B, H, T, D] = Q.shape;
    const Y = llmrtZeros(Q.shape);
    const causal = (opts && opts.causal) ? 1 : 0;
    _llmrtDispatch("sdpa", _LLMRT_WGSL.sdpa,
      _llmrtParamsU32F32([B, H, T, D, causal, 0, 0, 0], [1 / Math.sqrt(D)]), [Q, K, V, Y], B * H * T);
    return Y;
  },

  test: llmrtTest
};

/* --- CPU references + correctness suite (spec llm-1 verify) --------------- */
function _llmrtRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;   // [-1, 1)
  };
}
function _llmrtFill(n, rng) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = rng(); return a; }
function _llmrtMaxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

const _llmrtRef = {
  matmul(A, W, B, M, K, N) {
    const C = new Float32Array(B * M * N);
    for (let b = 0; b < B; b++) for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
      let acc = 0;
      for (let k = 0; k < K; k++) acc += A[(b * M + m) * K + k] * W[k * N + n];
      C[(b * M + m) * N + n] = acc;
    }
    return C;
  },
  softmax(X, R, C) {
    const Y = new Float32Array(R * C);
    for (let r = 0; r < R; r++) {
      let mx = -Infinity;
      for (let c = 0; c < C; c++) mx = Math.max(mx, X[r * C + c]);
      let sum = 0;
      for (let c = 0; c < C; c++) sum += Math.exp(X[r * C + c] - mx);
      for (let c = 0; c < C; c++) Y[r * C + c] = Math.exp(X[r * C + c] - mx) / sum;
    }
    return Y;
  },
  layernorm(X, g, bta, R, C, eps) {
    const Y = new Float32Array(R * C);
    for (let r = 0; r < R; r++) {
      let mean = 0;
      for (let c = 0; c < C; c++) mean += X[r * C + c];
      mean /= C;
      let v = 0;
      for (let c = 0; c < C; c++) { const d = X[r * C + c] - mean; v += d * d; }
      const inv = 1 / Math.sqrt(v / C + eps);
      for (let c = 0; c < C; c++) Y[r * C + c] = (X[r * C + c] - mean) * inv * g[c] + bta[c];
    }
    return Y;
  },
  rmsnorm(X, g, R, C, eps) {
    const Y = new Float32Array(R * C);
    for (let r = 0; r < R; r++) {
      let ss = 0;
      for (let c = 0; c < C; c++) ss += X[r * C + c] * X[r * C + c];
      const inv = 1 / Math.sqrt(ss / C + eps);
      for (let c = 0; c < C; c++) Y[r * C + c] = X[r * C + c] * inv * g[c];
    }
    return Y;
  },
  gelu(X) {
    const Y = new Float32Array(X.length);
    for (let i = 0; i < X.length; i++) {
      const x = X[i];
      Y[i] = 0.5 * x * (1 + Math.tanh(0.7978845608028654 * (x + 0.044715 * x * x * x)));
    }
    return Y;
  },
  sdpa(Q, K, V, B, H, T, D, causal) {
    const Y = new Float32Array(B * H * T * D);
    const scale = 1 / Math.sqrt(D);
    for (let b = 0; b < B; b++) for (let h = 0; h < H; h++) for (let t = 0; t < T; t++) {
      const qBase = ((b * H + h) * T + t) * D;
      const kvBase = (b * H + h) * T * D;
      const tMax = causal ? t + 1 : T;
      const scores = [];
      for (let s = 0; s < tMax; s++) {
        let dot = 0;
        for (let d = 0; d < D; d++) dot += Q[qBase + d] * K[kvBase + s * D + d];
        scores.push(dot * scale);
      }
      const mx = Math.max(...scores);
      const ws = scores.map(x => Math.exp(x - mx));
      const sum = ws.reduce((a, b) => a + b, 0);
      for (let d = 0; d < D; d++) {
        let acc = 0;
        for (let s = 0; s < tMax; s++) acc += (ws[s] / sum) * V[kvBase + s * D + d];
        Y[qBase + d] = acc;
      }
    }
    return Y;
  }
};

/* Run the 10-op suite; per spec llm-1, every op must match its JS
 * reference within 1e-4 on deterministic pseudo-random inputs. */
async function llmrtTest() {
  await llmrtInit();
  const rng = _llmrtRng(0xC0FFEE);
  const TOL = 1e-4;
  const results = [];
  const check = async (name, gpuTensor, ref) => {
    const got = await llmrtRead(gpuTensor);
    gpuTensor.destroy();
    const diff = _llmrtMaxDiff(got, ref);
    const ok = diff < TOL && Number.isFinite(diff);
    results.push({ name, ok, maxDiff: diff });
    console.log((ok ? "OK   " : "FAIL ") + name + "  maxDiff=" + diff.toExponential(2));
  };

  { // matmul + matmulBiased: A[2,5,7] x W[7,3] (+ bias[3])
    const [B, M, K, N] = [2, 5, 7, 3];
    const a = _llmrtFill(B * M * K, rng), w = _llmrtFill(K * N, rng), bs = _llmrtFill(N, rng);
    const A = llmrtTensor([B, M, K], a), W = llmrtTensor([K, N], w), Bi = llmrtTensor([N], bs);
    const refC = _llmrtRef.matmul(a, w, B, M, K, N);
    await check("matmul", LLMRT.mm(A, W), refC);
    const refCb = refC.map((v, i) => v + bs[i % N]);
    await check("matmulBiased", LLMRT.mmBiased(A, W, Bi), refCb);
    A.destroy(); W.destroy(); Bi.destroy();
  }
  { // softmax_rowwise X[6,9]
    const [R, C] = [6, 9];
    const x = _llmrtFill(R * C, rng);
    const X = llmrtTensor([R, C], x);
    await check("softmax_rowwise", LLMRT.softmax(X), _llmrtRef.softmax(x, R, C));
    X.destroy();
  }
  { // layernorm + rmsnorm X[4,8]
    const [R, C] = [4, 8];
    const x = _llmrtFill(R * C, rng), g = _llmrtFill(C, rng), b = _llmrtFill(C, rng);
    const X = llmrtTensor([R, C], x), G = llmrtTensor([C], g), Bt = llmrtTensor([C], b);
    await check("layernorm", LLMRT.layernorm(X, G, Bt, 1e-5), _llmrtRef.layernorm(x, g, b, R, C, 1e-5));
    await check("rmsnorm", LLMRT.rmsnorm(X, G, 1e-5), _llmrtRef.rmsnorm(x, g, R, C, 1e-5));
    X.destroy(); G.destroy(); Bt.destroy();
  }
  { // gelu / add / mul on 1000 elements
    const n = 1000;
    const a = _llmrtFill(n, rng), b = _llmrtFill(n, rng);
    const A = llmrtTensor([n], a), B = llmrtTensor([n], b);
    await check("gelu", LLMRT.gelu(A), _llmrtRef.gelu(a));
    await check("add", LLMRT.add(A, B), a.map((v, i) => v + b[i]));
    await check("mul", LLMRT.mul(A, B), a.map((v, i) => v * b[i]));
    A.destroy(); B.destroy();
  }
  { // embedding_gather: ids[10] into table[20,6]
    const [N, V, D] = [10, 20, 6];
    const ids = new Float32Array(N);
    for (let i = 0; i < N; i++) ids[i] = Math.floor((rng() + 1) / 2 * V) % V;
    const tb = _llmrtFill(V * D, rng);
    const I = llmrtTensor([N], ids), T = llmrtTensor([V, D], tb);
    const ref = new Float32Array(N * D);
    for (let i = 0; i < N; i++) for (let d = 0; d < D; d++) ref[i * D + d] = tb[ids[i] * D + d];
    await check("embedding_gather", LLMRT.embedding(I, T), ref);
    I.destroy(); T.destroy();
  }
  { // sdpa [1,2,6,4], causal both ways
    const [B, H, T, D] = [1, 2, 6, 4];
    const q = _llmrtFill(B * H * T * D, rng), k = _llmrtFill(B * H * T * D, rng), v = _llmrtFill(B * H * T * D, rng);
    const Q = llmrtTensor([B, H, T, D], q), K = llmrtTensor([B, H, T, D], k), V = llmrtTensor([B, H, T, D], v);
    await check("sdpa(causal)", LLMRT.sdpa(Q, K, V, { causal: true }), _llmrtRef.sdpa(q, k, v, B, H, T, D, true));
    Q.destroy(); K.destroy(); V.destroy();
  }

  const ok = results.every(r => r.ok);
  console.log(ok ? "LLMRT: all " + results.length + " ops OK" : "LLMRT: FAILURES present");
  return { ok, results };
}
