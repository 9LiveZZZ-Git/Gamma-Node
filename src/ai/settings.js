/* =========================================================================
 * AI assistant for .gdsp authoring
 *
 * Architecture:
 *   - User stores their own API key in localStorage. The editor calls the
 *     provider's API directly from the browser. No server in the middle.
 *     This keeps the standalone HTML genuinely standalone.
 *   - Provider is pluggable via the PROVIDERS map. Adding a new provider is
 *     one entry: { fetch, parseResponse, defaultModel, headers }.
 *   - When this gets integrated into AlloLib Studio Online, swap in a
 *     server-proxy provider that the IDE controls — same call signature,
 *     no other code changes.
 *
 * The system prompt teaches the model the .gdsp format because that's not
 * in any training data. The format spec is built fresh from the actual
 * directives the editor parses, so it can't drift.
 * ======================================================================== */

const AI_LS_KEY = "gamma-editor-ai-settings-v1";
let aiSettings = loadAiSettings();
let aiPending = null;   // last suggestion awaiting Apply/Discard

function loadAiSettings() {
  try {
    const raw = localStorage.getItem(AI_LS_KEY);
    if (raw) return Object.assign(defaultAiSettings(), JSON.parse(raw));
  } catch (e) {}
  return defaultAiSettings();
}
function defaultAiSettings() {
  // compileServerUrl: empty → use the default 127.0.0.1/localhost probe.
  // Set to a full URL (e.g. "http://192.168.1.42:8765") to point at a
  // daemon on another machine — useful for patching on an iPad against
  // a Mac on the same LAN. The settings-modal field both reads and
  // writes this value; probeLocalServer honors it when present.
  return {
    provider: "gemma",
    model: "onnx-community/gemma-4-E2B-it-ONNX",
    anthropicKey: "",
    compileServerUrl: "",
    // Sprite Studio settings (SpriteCreator-1 / sd-1 / sd-2).
    // Default = compile-server-sd because it's the bundled path; users
    // who installed via scripts/install-sd.sh get one-click generation.
    // A1111 / LLM remain as fallbacks if the compile-server doesn't have
    // the SD worker installed yet.
    spriteBackend: "compile-server-sd",           // 'compile-server-sd' | 'local-sd-a1111' | 'llm-canvas'
    sdModel:       "z-image-turbo",               // compile-server model name (z-image-turbo | sdxl | flux2-klein)
    sdEndpoint:    "http://localhost:7860",       // A1111 webui base URL (a1111 backend only)
    sdSteps:       20,                             // sampling steps (quality vs speed)
    sdSampler:     "DPM++ 2M Karras"              // A1111 sampler name
  };
}
function saveAiSettings() {
  try { localStorage.setItem(AI_LS_KEY, JSON.stringify(aiSettings)); } catch (e) {}
}

/* ---------------- Prompt construction ---------------- */

function gdspFormatSpec() {
  return `The .gdsp format is a single C++ class preceded by metadata in // @gdsp-* comments.

Required directives:
  // @gdsp-name        ClassName              (must match the class declaration below)
  // @gdsp-category    PaletteCategoryName
  // @gdsp-input       portName  TYPE  [default]
  // @gdsp-output      portName  TYPE

Optional:
  // @gdsp-description One-line description
  // @gdsp-color       #rrggbb
  // @gdsp-method      paramName methodName    (override default param→setter)
  // @gdsp-gate        gateName  methodName    (override "reset" for non-trigger gates)
  // @gdsp-header      <some/header.h>         (extra include)

TYPE is one of: audio, param, gate.

The class itself must:
  - Be named exactly the @gdsp-name value.
  - Define float operator()(float in) for one-audio-input nodes,
    or float operator()() for sources (no audio input).
  - Define void <paramName>(float v) for each "param" input
    (or void <method>(float v) when @gdsp-method redirects).
  - Define void <gateName>() for each "gate" input
    (or void <method>() when @gdsp-gate redirects).

A complete example:

// @gdsp-name        BitCrush
// @gdsp-category    UserDSP
// @gdsp-description Sample-rate and bit-depth reducer
// @gdsp-color       #c8e85a
// @gdsp-input       in    audio
// @gdsp-input       bits  param  8
// @gdsp-input       rate  param  0.5
// @gdsp-output      out   audio
// @gdsp-method      bits  setBits

#include <cmath>

class BitCrush {
    float held = 0.f;
    float phase = 0.f;
    float rate_ = 0.5f;
    int   bits_ = 8;
public:
    void rate(float v)    { rate_ = v; }
    void setBits(float v) { bits_ = (int)v; }

    float operator()(float in) {
        phase += rate_;
        if (phase >= 1.f) {
            phase -= 1.f;
            float step = float(1 << bits_);
            held = std::floor(in * step) / step;
        }
        return held;
    }
};

The output of your generation is the entire file — directives + class — and nothing else. No prose, no markdown fences.

ALTERNATE KIND: shader-frag (Phase 6 visual layer)

Set "// @gdsp-kind shader-frag" on the first metadata line to author a
WGSL fragment shader instead of a C++ DSP class. The body is WGSL, not
C++; the rest of the metadata + class checks above are bypassed.

Required directives for shader-frag:
  // @gdsp-kind        shader-frag
  // @gdsp-name        ShaderName
  // @gdsp-output      out  texture          (must be texture, exactly one)

Optional:
  // @gdsp-category    Visual                (default: Visual)
  // @gdsp-input       paramName  param  default   (zero or more)
  // @gdsp-description One-line description
  // @gdsp-color       #rrggbb

WGSL conventions:
  - Define BOTH @vertex fn vs_main(...) -> VsOut and
    @fragment fn fs_main(in: VsOut) -> @location(0) vec4f.
  - Use a fullscreen triangle in vs_main (see SolidColor / Gradient for
    the canonical pattern — three positions, derive uv from clip pos
    with v flipped).
  - Bind your uniform struct at @group(0) @binding(0). The struct must
    start with the standard 64-byte preamble:
        u_resolution: vec4f,   // (w, h, 1/w, 1/h) of THIS display
        u_time:       f32,     // seconds since the GPU device acquired
        u_dt:         f32,     // seconds since the previous frame
        _pad0:        vec2f,   // 8 B (always zero)
        u_view:       vec4f,   // (yaw, pitch, roll, fov_h_deg) of this display
        u_world_uv:   vec4f,   // (minU, minV, maxU, maxV) on rig's master canvas
    Then your @gdsp-input params follow as f32 fields IN DECLARATION
    ORDER (each param = 4 B). For non-trivial layouts (vec3, vec4)
    interleave manual padding so 16-byte-aligned types start on
    16-byte offsets — same rules as WGSL struct alignment in general.

  - Display awareness — when one shader is wired into multiple
    VisualOutput nodes (e.g. for a multi-projector dome), each
    display's render pass receives a different u_world_uv slice. Map
    your local uv [0,1] into the rig's shared master canvas with:
        let world_uv = mix(u.u_world_uv.xy, u.u_world_uv.zw, in.uv);
    For single-display rigs world_uv == in.uv (the slice is the full
    [0,0]→[1,1]), so shaders that don't bother with world_uv still
    work — they just tile their output independently per display
    rather than spanning across them.

A complete shader-frag example (display-aware Pinwheel — center
sits at the rig's master center, so a 2-display side-by-side rig
shows the pinwheel split across them with the center on the seam):

// @gdsp-kind        shader-frag
// @gdsp-name        Pinwheel
// @gdsp-category    Visual
// @gdsp-description Rotating radial sweep, spans the rig's master canvas
// @gdsp-input       speed  param  1.0
// @gdsp-input       arms   param  6.0
// @gdsp-output      out    texture

struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  speed:        f32,
  arms:         f32,
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let world_uv = mix(u.u_world_uv.xy, u.u_world_uv.zw, in.uv);
  let p = world_uv - vec2f(0.5);
  let a = atan2(p.y, p.x) + u.u_time * u.speed;
  let s = 0.5 + 0.5 * sin(a * u.arms);
  return vec4f(s, s, s, 1.0);
}

Audio + clock uniform (always bound at @group(0) @binding(3)):
A second uniform carries global audio + tempo signals. Declare it
optionally — shaders that don't need it can skip the struct entirely.

    struct AudioU {
      values: array<vec4<f32>, 4>,   // 16 scalar slots
      fft:    array<vec4<f32>, 64>,  // 256 log-spaced FFT bins
    };
    @group(0) @binding(3) var<uniform> u_audio: AudioU;

Slot assignments (read AS-IS, no further mapping needed):
    values[0].x   = master output peak this quantum    (0..1)
    values[2].w   = MasterClock bpm                    (raw, e.g. 120.0)
    values[3].x   = MasterClock bar       envelope     (1 at downbeat -> ~0)
    values[3].y   = MasterClock beat      envelope     (pulses each beat)
    values[3].z   = MasterClock sixteenth envelope     (pulses every 1/16)
    values[3].w   = MasterClock phase                  (continuous 0..1 ramp / beat)
    fft[k/4u][k%4u] for k in 0..255                    = log-spaced 20Hz..Nyquist (0..1)

The clock slots are populated by the first MasterClock node in the
patch (no MasterClock -> zero). This means you can write audio-reactive
or tempo-synced shaders WITHOUT exposing a clockReact param + asking
the user to wire it — just read u_audio.values[3].y directly. A common
pattern: amplify the cubic-decay envelope into a flash that pulses on
each beat:
    let beat_pulse = u_audio.values[3].y;       // 1.0 at the beat, ~0 between
    let beat_flash = beat_pulse * beat_pulse;   // sharpen the decay
    color = color + vec3f(beat_flash * 0.3);    // additive flash

To read an FFT bin as a plain scalar:
    fn fft_bin(k: u32) -> f32 {
      let v = u_audio.fft[k / 4u];
      let lane = k & 3u;
      if (lane == 0u) { return v.x; }
      if (lane == 1u) { return v.y; }
      if (lane == 2u) { return v.z; }
      return v.w;
    }

Hot reload is automatic: any edit to the WGSL body re-hashes into a
fresh pipeline-cache entry, async-compiles, and swaps onto live
shader-frag nodes on the next frame — the old pipeline keeps rendering
during compile so there's no flicker.`;
}

function buildPrompt(mode, userText, currentSource) {
  const spec = gdspFormatSpec();
  let task;
  switch (mode) {
    case "generate":
      task = `Generate a complete .gdsp file for: ${userText}\n\nReturn ONLY the .gdsp source, starting with the // @gdsp- directives.`;
      break;
    case "modify":
      task = `Here is the current .gdsp source:\n\n${currentSource}\n\nModify it as follows: ${userText}\n\nReturn ONLY the new .gdsp source, starting with the // @gdsp- directives. Preserve everything that doesn't need to change.`;
      break;
    case "fix":
      task = `Here is .gdsp source that fails validation:\n\n${currentSource}\n\nThe error message is: ${userText}\n\nFix the source. Return ONLY the corrected .gdsp source, starting with the // @gdsp- directives.`;
      break;
    case "explain":
      task = `Here is .gdsp source:\n\n${currentSource}\n\nExplain what it does in plain prose. Cover: the DSP algorithm, what each parameter controls, and any caveats. Do NOT return code; this is a read-only explanation.`;
      break;
  }
  return { system: `You are a DSP programmer helping author nodes for the Gamma node editor. ${spec}`, user: task };
}

/* ---------------- Provider adapters ----------------
 *
 * Each provider exposes async call({ system, user, model, key, onToken }).
 * If onToken is provided, the response is streamed and onToken is called
 * with each incremental text chunk. The final return value is always the
 * complete accumulated text. If onToken is omitted, the provider may use
 * a simpler non-streaming code path.
 * --------------------------------------------------------------------- */

async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by \n\n. Each event has one or more lines
    // prefixed with "data: " (we ignore "event:" and "id:" for simplicity).
    let nl;
    while ((nl = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      block.split("\n").forEach(line => {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;
          try { onEvent(JSON.parse(data)); }
          catch (e) { /* skip malformed event */ }
        }
      });
    }
  }
}

const PROVIDERS = {
  anthropic: {
    defaultModel: "claude-sonnet-4-5",
    requiresKey: true,
    supportsImage: true,
    supportsAudio: false,   // Whisper isn't routed through this path
    goodClassifier: true,   // HW.3 -- strong enough for constrained node-name classification
    async call({ system, user, model, key, onToken, image, audio, temperature, maxTokens }) {
      if (audio) throw new Error("Anthropic provider does not handle audio input. Use Gemma for voice.");

      // image can be a single base64 string OR an array of base64
      // strings for multi-image input (e.g., reference + current view).
      const imageList = Array.isArray(image) ? image.filter(s => s) : (image ? [image] : []);
      const userContent = (imageList.length > 0)
        ? imageList.map(b => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b } }))
            .concat([{ type: "text", text: user }])
        : user;

      const body = {
        model: model || "claude-sonnet-4-5",
        max_tokens: (typeof maxTokens === "number" && maxTokens > 0) ? maxTokens : 2048,
        system,
        messages: [{ role: "user", content: userContent }],
        stream: !!onToken
      };
      if (typeof temperature === "number") body.temperature = temperature;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = (data.error && data.error.message) || res.statusText;
        throw new Error(`API ${res.status}: ${msg}`);
      }
      if (!onToken) {
        const data = await res.json();
        return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      }
      let acc = "";
      await readSSE(res, ev => {
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          acc += ev.delta.text;
          onToken(ev.delta.text);
        }
      });
      return acc;
    }
  },

  /* Gemma 4 via @huggingface/transformers + WebGPU.
   *
   * One model, three jobs:
   *   - Text generation (.gdsp authoring, voice → prompt)
   *   - Vision (handwriting recognition for pen-tablet draw-to-create)
   *   - Audio (speech-to-text for voice input)
   *
   * E4B is the default. E2B is a settings option for lower-VRAM machines.
   * Both use q4f16 quantization and load via the any-to-any pipeline.
   *
   * The transformers.js library is the same one we already load for
   * Whisper-tiny (legacy voice fallback). Gemma 4 supersedes both
   * WebLLM (text) and Whisper-tiny (audio) for users who pick it.
   */
  gemma: {
    defaultModel: "onnx-community/gemma-4-E2B-it-ONNX",
    requiresKey: false,
    supportsImage: true,
    supportsAudio: true,
    async call({ system, user, model, onToken, image, audio, temperature, maxTokens }) {
      const pipe = await ensureGemmaPipeline(model);

      // Build the messages array. Multimodal content (image / audio) goes
      // BEFORE the text per Google's recommendation for best results.
      const userContent = [];
      if (image) {
        userContent.push({ type: "image", image: "data:image/png;base64," + image });
      }
      if (audio) {
        userContent.push({ type: "audio", audio });
      }
      userContent.push({ type: "text", text: user });

      const messages = [
        { role: "system", content: system },
        { role: "user",   content: userContent }
      ];

      const tx = await getTransformersJs();
      const inputs = await pipe.processor.apply_chat_template(messages, {
        add_generation_prompt: true,
        tokenize: true,
        return_dict: true
      });

      // Deterministic decode (HWR / classification) when caller passes
      // temperature: 0; sample for free-form text generation otherwise.
      // maxTokens lets callers override the per-task budget — HWR needs
      // ~48 (room for "The word is X." style preamble before our parser
      // strips it), generation needs ~2048.
      const det = (typeof temperature === "number" && temperature <= 0);
      const detTokens = (typeof maxTokens === "number" && maxTokens > 0) ? maxTokens : 16;
      const genTokens = (typeof maxTokens === "number" && maxTokens > 0) ? maxTokens : 2048;
      const generateOpts = {
        ...inputs,
        max_new_tokens: det ? detTokens : genTokens,
        do_sample: !det,
        temperature: det ? 1.0 : (typeof temperature === "number" ? temperature : 0.4)
      };
      if (onToken) {
        generateOpts.streamer = new tx.TextStreamer(pipe.tokenizer, {
          skip_prompt: true,
          callback_function: (text) => onToken(text)
        });
      }

      const output = await pipe.model.generate(generateOpts);

      // Slice off the prompt tokens — output includes them verbatim.
      const promptLen = inputs.input_ids.dims[inputs.input_ids.dims.length - 1];
      const newTokens = output.slice(null, [promptLen, null]);
      const decoded = pipe.processor.batch_decode(newTokens, { skip_special_tokens: true });
      return Array.isArray(decoded) ? decoded[0] : String(decoded);
    }
  }
};

function extractGemmaText(out) {
  // pipeline returns either a string, an array of generation objects,
  // or a chat-style structure depending on the task.
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    const last = out[out.length - 1];
    if (typeof last === "string") return last;
    if (last && typeof last.generated_text === "string") return last.generated_text;
    if (last && Array.isArray(last.generated_text)) {
      const tail = last.generated_text[last.generated_text.length - 1];
      if (tail && typeof tail.content === "string") return tail.content;
      return JSON.stringify(tail);
    }
  }
  return JSON.stringify(out);
}

/* Gemma 4 pipeline — singleton, loaded on demand via dynamic import.
 * Users who don't select Gemma never trigger the import, so cloud-only
 * users pay zero bytes for the local-model path. */
let gemmaPipeline = null;
let gemmaCurrentModel = null;
let gemmaLoadPromise = null;
let transformersJsCache = null;
let gemmaProgressHook = null;

function setGemmaProgressHook(fn) { gemmaProgressHook = fn; }

function setupGemmaAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

async function getTransformersJs() {
  if (transformersJsCache) return transformersJsCache;
  // Use jsdelivr's +esm endpoint (NOT esm.run; the latter rebundles
  // and breaks the package's relative-URL lookup of its sibling WASM
  // blobs, which surfaces as "Failed to fetch dynamically imported
  // module"). Same root cause as the Wasmer SDK loader fix above.
  // @latest gets us whatever transformers.js has shipped recently —
  // gemma4 model support landed in 3.5+ (the @3 pin we used before
  // resolved to an older 3.x without it). Bumping to @latest until we
  // hit a regression worth pinning around.
  transformersJsCache = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@latest/+esm");
  return transformersJsCache;
}

async function ensureGemmaPipeline(model) {
  if (!setupGemmaAvailable()) {
    throw new Error("WebGPU not available — Gemma 4 needs Chrome/Edge or recent Safari with WebGPU.");
  }
  if (gemmaPipeline && gemmaCurrentModel === model) return gemmaPipeline;
  if (gemmaLoadPromise && gemmaCurrentModel === model) return gemmaLoadPromise;

  gemmaCurrentModel = model;
  gemmaLoadPromise = (async () => {
    const tx = await getTransformersJs();
    // Use the lower-level AutoProcessor + AutoModelForImageTextToText
    // pair instead of pipeline(). The pipeline() shorthand in
    // transformers.js v3 doesn't expose multimodal tasks
    // (image-text-to-text / any-to-any are rejected), but the
    // AutoModelForImageTextToText class loads gemma-4 multimodal
    // correctly and accepts {role: "user", content: [{type:"image",
    // image: dataUrl}, {type:"text", text:"..."}]} message blocks.
    // Same model weights as text-generation pipeline; this just
    // exposes the vision input path that HWR needs.
    const cb = (p) => { if (gemmaProgressHook) gemmaProgressHook(p); };
    const opts = { device: "webgpu", dtype: "q4f16", progress_callback: cb };
    const processor = await tx.AutoProcessor.from_pretrained(model, { progress_callback: cb });
    const m = await tx.AutoModelForImageTextToText.from_pretrained(model, opts);
    // Wrap into a "pipeline-like" object so the rest of the editor
    // doesn't have to care which loader was used. .processor + .model
    // are exposed for the lower-level call paths (HWR via images);
    // .tokenizer matches what TextStreamer expects for streaming.
    gemmaPipeline = {
      processor, model: m,
      tokenizer: processor.tokenizer || processor
    };
    return gemmaPipeline;
  })();

  try {
    return await gemmaLoadPromise;
  } catch (err) {
    gemmaLoadPromise = null;
    gemmaCurrentModel = null;
    throw err;
  }
}

/* Audio decoding helper — converts a MediaRecorder webm blob into the
 * Float32Array @ 16kHz mono that Gemma's audio encoder expects. Reused
 * by the legacy Whisper path too since it has the same input shape. */
async function blobToAudioFloat32(blob, targetSampleRate) {
  const targetRate = targetSampleRate || 16000;
  const arrayBuffer = await blob.arrayBuffer();
  // Some browsers don't accept sampleRate in AudioContext constructor for
  // arbitrary values; create at default and resample manually if needed.
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
    1, 1, targetRate
  );
  const decoded = await new AudioContext().decodeAudioData(arrayBuffer);
  // Resample by mixing into a single-channel offline context at target rate.
  const offline = new OfflineAudioContext(
    1, Math.ceil(decoded.duration * targetRate), targetRate
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/* ---------------- Response cleanup ---------------- */

// Strip markdown code fences if the model wrapped its output in ```cpp ... ```
function cleanGdspResponse(text) {
  text = text.trim();
  const fence = text.match(/^```(?:cpp|c\+\+)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) return fence[1].trim();
  return text;
}

/* ---------------- AI panel UI ---------------- */

const aiPanel    = document.getElementById("ai-panel");
const aiPromptEl = document.getElementById("ai-prompt");
const aiModeEl   = document.getElementById("ai-mode");
const aiStatus   = document.getElementById("ai-status");
const aiResult   = document.getElementById("ai-result");
const aiResultBody = document.getElementById("ai-result-body");
const aiResultLabel = document.getElementById("ai-result-label");

function setAiStatus(msg, kind) {
  aiStatus.textContent = msg;
  aiStatus.className = "ai-status" + (kind ? " " + kind : "");
}

function openAiPanel() {
  aiPanel.style.display = "flex";
  aiPromptEl.focus();
  // Autofill prompt for "fix" mode if there's a current error
  const status = udspStatus.textContent || "";
  if (status.startsWith("Error —")) {
    aiModeEl.value = "fix";
    aiPromptEl.value = status.replace(/^Error\s*—\s*/, "");
  }
}
function closeAiPanel() {
  aiPanel.style.display = "none";
  aiResult.style.display = "none";
  aiPending = null;
}

document.getElementById("btn-udsp-ai").addEventListener("click", openAiPanel);

/* ---------- Model badge + provider switcher ----------
 * The badge in the User DSP toolbar shows which provider/model is
 * currently active. Click it to switch between configured providers
 * without opening the full settings modal. */
const MODEL_OPTIONS = [
  {
    provider: "gemma",
    model: "onnx-community/gemma-4-E2B-it-ONNX",
    name: "Gemma 4 E2B",
    meta: "~500 MB · WebGPU · text + image",
    tag: "local"
  },
  {
    provider: "gemma",
    model: "onnx-community/gemma-4-E4B-it-ONNX",
    name: "Gemma 4 E4B",
    meta: "~1.5 GB · WebGPU · higher quality",
    tag: "local"
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    meta: "Anthropic API · text + image · per-call cost",
    tag: "cloud"
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    meta: "Anthropic API · top quality · higher cost",
    tag: "cloud"
  }
];

function shortModelName(provider, model) {
  if (provider === "gemma") {
    if (/E2B/i.test(model)) return "Gemma 4 E2B";
    if (/E4B/i.test(model)) return "Gemma 4 E4B";
    return model.split("/").pop();
  }
  if (provider === "anthropic") {
    if (/opus/i.test(model)) return "Claude Opus";
    if (/sonnet/i.test(model)) return "Claude Sonnet";
    if (/haiku/i.test(model)) return "Claude Haiku";
    return model;
  }
  return model;
}

function refreshModelBadge() {
  const tag = document.getElementById("model-badge-tag");
  const name = document.getElementById("model-badge-name");
  const btn = document.getElementById("btn-model-badge");
  if (!tag || !name || !btn) return;
  const p = aiSettings.provider;
  const isLocal = p === "gemma";
  const hasKey = p === "gemma" || (p === "anthropic" && !!aiSettings.anthropicKey);
  tag.textContent = isLocal ? "local" : "cloud";
  tag.className = "model-badge-tag " + (isLocal ? "local" : (hasKey ? "cloud" : "unset"));
  name.textContent = shortModelName(p, aiSettings.model);
  btn.title = "Active model: " + shortModelName(p, aiSettings.model) +
    " (" + (isLocal ? "local Gemma" : "Anthropic API") + ")" +
    (!hasKey ? " — needs API key" : "") +
    " — click to switch";
}

function renderModelPopover() {
  const pop = document.getElementById("model-popover");
  if (!pop) return;
  const hasAnthKey = !!aiSettings.anthropicKey;
  let html = `<div class="model-popover-head">Active AI model</div>`;
  MODEL_OPTIONS.forEach((opt, i) => {
    const isActive = aiSettings.provider === opt.provider && aiSettings.model === opt.model;
    const needsKey = opt.tag === "cloud" && !hasAnthKey;
    const cls = "model-popover-item " + opt.tag + (isActive ? " active" : "") + (needsKey ? " disabled" : "");
    html += `<div class="${cls}" data-idx="${i}" role="menuitem"${needsKey ? ' aria-disabled="true"' : ""}>
      <span class="check" aria-hidden="true"></span>
      <span class="info">
        <span class="name">${escapeText(opt.name)}</span>
        <span class="meta">${escapeText(opt.meta)}${needsKey ? " · API key not set" : ""}</span>
      </span>
      <span class="badge-tag">${opt.tag}</span>
    </div>`;
  });
  html += `<div class="model-popover-foot">
    <span>${hasAnthKey ? "API key set" : "No Anthropic key configured"}</span>
    <a id="model-popover-settings">Settings →</a>
  </div>`;
  pop.innerHTML = html;

  pop.querySelectorAll(".model-popover-item").forEach(el => {
    el.addEventListener("click", () => {
      if (el.classList.contains("disabled")) return;
      const opt = MODEL_OPTIONS[+el.dataset.idx];
      aiSettings.provider = opt.provider;
      aiSettings.model = opt.model;
      try { localStorage.setItem(AI_LS_KEY, JSON.stringify(aiSettings)); } catch (_) {}
      // If switching providers, drop the cached Gemma pipeline so it
      // reloads with the new model on next Run.
      if (opt.provider === "gemma") {
        gemmaPipeline = null;
        gemmaCurrentModel = null;
        gemmaLoadPromise = null;
      }
      refreshModelBadge();
      closeModelPopover();
      setUdspStatus("Switched to " + opt.name + " (" + opt.tag + ")", "ok");
    });
  });
  const settingsLink = pop.querySelector("#model-popover-settings");
  if (settingsLink) settingsLink.addEventListener("click", () => {
    closeModelPopover();
    openSettings();
  });
}

function openModelPopover() {
  const pop = document.getElementById("model-popover");
  const btn = document.getElementById("btn-model-badge");
  if (!pop || !btn) return;
  renderModelPopover();
  pop.style.display = "block";
  btn.setAttribute("aria-expanded", "true");
  setTimeout(() => document.addEventListener("click", outsideClickClose, { capture: true }), 0);
}
function closeModelPopover() {
  const pop = document.getElementById("model-popover");
  const btn = document.getElementById("btn-model-badge");
  if (pop) pop.style.display = "none";
  if (btn) btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", outsideClickClose, { capture: true });
}
function outsideClickClose(e) {
  const pop = document.getElementById("model-popover");
  const btn = document.getElementById("btn-model-badge");
  if (!pop) return;
  if (pop.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeModelPopover();
}

document.getElementById("btn-model-badge").addEventListener("click", () => {
  const pop = document.getElementById("model-popover");
  if (pop && pop.style.display === "block") closeModelPopover();
  else openModelPopover();
});
document.getElementById("btn-ai-close").addEventListener("click", closeAiPanel);

document.getElementById("btn-ai-go").addEventListener("click", async () => {
  const mode = aiModeEl.value;
  const userText = aiPromptEl.value.trim();
  if (!userText && mode !== "explain") {
    setAiStatus("Enter a description above.", "err");
    return;
  }

  const provider = PROVIDERS[aiSettings.provider];
  let key = "";
  if (provider.requiresKey) {
    key = aiSettings.anthropicKey;  // Only Anthropic needs a key now
    if (!key) {
      setAiStatus("No API key set — click ⚙ to configure.", "err");
      return;
    }
  }

  // Hook Gemma init progress into the status line on first use
  if (aiSettings.provider === "gemma") {
    setGemmaProgressHook((p) => {
      // p has { status, file, progress (0..1), loaded, total }
      const pct = p.progress != null ? Math.round(p.progress * 100) : 0;
      const label = p.file || p.status || "loading model…";
      setAiStatus(`${label} (${pct}%)`, "thinking");
    });
  } else {
    setGemmaProgressHook(null);
  }

  const { system, user } = buildPrompt(mode, userText, getUdspText());
  setAiStatus("Thinking… (" + shortModelName(aiSettings.provider, aiSettings.model) + ", " +
    (aiSettings.provider === "gemma" ? "local" : "cloud") + ")", "thinking");

  // Show the result panel immediately and stream tokens into it.
  // Apply button stays hidden until streaming finishes (and isn't shown
  // for explain mode at all).
  const isExplain = (mode === "explain");
  aiResultLabel.textContent = isExplain
    ? "Explanation (streaming…)"
    : mode.charAt(0).toUpperCase() + mode.slice(1) + " — streaming…";
  aiResultBody.textContent = "";
  aiResult.style.display = "flex";
  document.getElementById("btn-ai-apply").style.display = "none";
  document.getElementById("btn-ai-discard").style.display = "";

  let streamed = "";
  const onToken = (chunk) => {
    streamed += chunk;
    aiResultBody.textContent = streamed;
    aiResultBody.scrollTop = aiResultBody.scrollHeight;
  };

  try {
    const text = await provider.call({
      system, user,
      model: aiSettings.model,
      key,
      onToken
    });
    if (isExplain) {
      aiResultLabel.textContent = "Explanation";
      aiResultBody.textContent = text;
      aiPending = null;
    } else {
      const cleaned = cleanGdspResponse(text);
      aiResultLabel.textContent = mode.charAt(0).toUpperCase() + mode.slice(1) + " — review and Apply to overwrite the editor";
      aiResultBody.textContent = cleaned;
      aiPending = cleaned;
      document.getElementById("btn-ai-apply").style.display = "";
    }
    setAiStatus("Done.", "ok");
  } catch (err) {
    setAiStatus(err.message, "err");
    if (!streamed) aiResult.style.display = "none";
  } finally {
    setGemmaProgressHook(null);
  }
});

document.getElementById("btn-ai-apply").addEventListener("click", () => {
  if (aiPending == null) return;
  setUdspText(aiPending);
  setAiStatus("Applied to editor — click Validate or Save & Add to register.", "ok");
  aiPending = null;
  aiResult.style.display = "none";
});
document.getElementById("btn-ai-discard").addEventListener("click", () => {
  aiPending = null;
  aiResult.style.display = "none";
  setAiStatus("Discarded.", "");
});

/* ---------------- Settings modal ---------------- */

const settingsModal = document.getElementById("settings-modal");
const sProvider     = document.getElementById("settings-provider");
const sModel        = document.getElementById("settings-model");
const sModelLocal   = document.getElementById("settings-model-local");
const sKey          = document.getElementById("settings-key");
const sKeyLabel     = document.getElementById("settings-key-label");
const sNoteApi      = document.getElementById("settings-note-api");
const sNoteLocal    = document.getElementById("settings-note-local");
const sCompileUrl   = document.getElementById("settings-compile-url");
const sServerResult = document.getElementById("settings-server-result");

function applyProviderUi(p) {
  const isLocal = p === "gemma";
  // Toggle WebGPU note vs API-key note
  sNoteApi.style.display   = isLocal ? "none" : "block";
  sNoteLocal.style.display = isLocal ? "block" : "none";
  // Toggle model-id input vs model dropdown
  sModel.style.display      = isLocal ? "none" : "block";
  sModelLocal.style.display = isLocal ? "block" : "none";
  // Hide key field for Gemma (no key needed)
  sKey.style.display      = isLocal ? "none" : "block";
  sKeyLabel.style.display = isLocal ? "none" : "block";
  // Show / refresh the local-model status panel
  const panel = document.getElementById("gemma-status-panel");
  if (panel) panel.style.display = isLocal ? "block" : "none";
  if (isLocal) refreshGemmaStatus();
  // Warn if WebGPU isn't available
  if (isLocal && !setupGemmaAvailable()) {
    sNoteLocal.style.color = "var(--danger)";
    sNoteLocal.textContent = "WebGPU is not available in this browser. Gemma 4 requires Chrome, Edge, or recent Safari with WebGPU enabled. Try chrome://flags/#enable-unsafe-webgpu if needed, or switch to the Anthropic provider.";
  } else {
    sNoteLocal.style.color = "";
    sNoteLocal.textContent = "Local models run entirely in your browser via WebGPU. No data leaves your machine. The first time you Run, the model weights download (~1.5 GB for E4B, ~500 MB for E2B) and are cached in the browser; subsequent runs are offline. Requires a WebGPU-capable browser (Chrome, Edge, recent Safari) and a discrete GPU or unified-memory machine with at least 4 GB free.";
  }
}

/* Gemma status panel — shows WebGPU availability and current model load
 * state in the settings modal. The "Preload model" button triggers
 * ensureGemmaPipeline without running inference, so users can warm the
 * model at their leisure rather than waiting at the first prompt. */
function refreshGemmaStatus() {
  const gpu = document.getElementById("gemma-webgpu-state");
  const mod = document.getElementById("gemma-model-state");
  if (!gpu || !mod) return;
  if (setupGemmaAvailable()) {
    gpu.textContent = "available";
    gpu.style.color = "var(--audio)";
  } else {
    gpu.textContent = "not available";
    gpu.style.color = "var(--danger)";
  }
  if (gemmaPipeline) {
    mod.textContent = "loaded — " + (gemmaCurrentModel || "");
    mod.style.color = "var(--audio)";
  } else if (gemmaLoadPromise) {
    mod.textContent = "loading…";
    mod.style.color = "var(--accent)";
  } else {
    mod.textContent = "not loaded — first Run will download";
    mod.style.color = "var(--text-3)";
  }
}

document.getElementById("btn-gemma-preload").addEventListener("click", async () => {
  const note = document.getElementById("gemma-preload-note");
  if (!setupGemmaAvailable()) {
    note.textContent = "WebGPU isn't available — preload would fail.";
    note.style.color = "var(--danger)";
    return;
  }
  const model = sModelLocal.value || PROVIDERS.gemma.defaultModel;
  note.textContent = "Loading model… first run downloads ~1.5 GB. Watch the network tab if curious.";
  note.style.color = "var(--text-2)";
  setGemmaProgressHook((p) => {
    if (!p) return;
    // transformers.js's progress_callback gives `progress` already in
    // 0–100 range (NOT 0–1). Clamp + display directly. Each file in
    // the download emits its own stream; `status` distinguishes
    // initiate / download / progress / done / ready.
    if (p.status === "progress" && typeof p.progress === "number") {
      const pct = Math.max(0, Math.min(100, p.progress));
      const sizeMB = p.total ? ` of ${(p.total / 1048576).toFixed(0)} MB` : "";
      note.textContent = `Loading ${p.file || ""}: ${pct.toFixed(0)}%${sizeMB}`;
    } else if (p.status === "done") {
      note.textContent = `Downloaded ${p.file || ""}`;
    } else if (p.status === "ready") {
      note.textContent = "Model ready";
    } else if (p.status) {
      note.textContent = `${p.status}: ${p.file || ""}`;
    }
    refreshGemmaStatus();
  });
  try {
    await ensureGemmaPipeline(model);
    note.textContent = "Loaded. Future Runs are instant until the page reloads.";
    note.style.color = "var(--audio)";
    refreshGemmaStatus();
  } catch (e) {
    note.textContent = "Preload failed: " + e.message;
    note.style.color = "var(--danger)";
  } finally {
    setGemmaProgressHook(null);
  }
});

function openSettings() {
  sProvider.value = aiSettings.provider;
  if (aiSettings.provider === "gemma") {
    const opts = Array.from(sModelLocal.options).map(o => o.value);
    sModelLocal.value = opts.includes(aiSettings.model) ? aiSettings.model : PROVIDERS.gemma.defaultModel;
  } else {
    sModel.value = aiSettings.model;
    sKey.value   = aiSettings.anthropicKey;
  }
  if (sCompileUrl) sCompileUrl.value = aiSettings.compileServerUrl || "";
  if (sServerResult) { sServerResult.textContent = ""; sServerResult.style.color = ""; }
  applyProviderUi(aiSettings.provider);
  settingsModal.style.display = "flex";
}
function closeSettings() { settingsModal.style.display = "none"; }

document.getElementById("btn-udsp-settings").addEventListener("click", openSettings);
document.getElementById("btn-settings-close").addEventListener("click", closeSettings);

sProvider.addEventListener("change", () => {
  const p = sProvider.value;
  applyProviderUi(p);
  if (p === "gemma") {
    const opts = Array.from(sModelLocal.options).map(o => o.value);
    sModelLocal.value = opts.includes(aiSettings.model) ? aiSettings.model : PROVIDERS.gemma.defaultModel;
  } else {
    sKey.value = aiSettings.anthropicKey;
    // Anthropic — pre-fill with default model if user hasn't already typed one
    if (!sModel.value || sModel.value.startsWith("onnx-community/")) {
      sModel.value = PROVIDERS.anthropic.defaultModel;
    }
  }
});

document.getElementById("btn-settings-save").addEventListener("click", () => {
  aiSettings.provider = sProvider.value;
  if (aiSettings.provider === "gemma") {
    const newModel = sModelLocal.value;
    // If switching to a different model, drop the cached engine so next Run reloads
    if (aiSettings.model !== newModel) {
      gemmaPipeline = null;
      gemmaCurrentModel = null;
      gemmaLoadPromise = null;
    }
    aiSettings.model = newModel;
  } else {
    aiSettings.model = sModel.value.trim() || PROVIDERS.anthropic.defaultModel;
    aiSettings.anthropicKey = sKey.value.trim();
  }
  // Compile-server URL: trim, strip trailing slash, accept blank to mean
  // "use the default 127.0.0.1/localhost probe". Force a fresh probe on
  // next Play so the new URL takes effect immediately.
  if (sCompileUrl) {
    let url = sCompileUrl.value.trim().replace(/\/+$/, "");
    aiSettings.compileServerUrl = url;
  }
  localServerStatus = null;
  localServerEndpoint = null;
  saveAiSettings();
  closeSettings();
  setAiStatus("Settings saved.", "ok");
  refreshModelBadge();
});

/* Test the user-entered (or default) compile server URL inline so they
 * can confirm it's reachable before saving. Runs the same /health
 * handshake as probeLocalServer, with a longer timeout (3 s) since LAN
 * round-trips can be a touch slower than localhost. */
document.getElementById("btn-settings-test-server").addEventListener("click", async () => {
  if (!sServerResult) return;
  const raw = (sCompileUrl ? sCompileUrl.value : "").trim().replace(/\/+$/, "");
  const url = raw || "http://127.0.0.1:8765";
  sServerResult.textContent = "probing " + url + "…";
  sServerResult.style.color = "var(--text-3)";
  try {
    const res = await fetch(url + "/health", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (!j || j.service !== "gamma-compile-server") throw new Error("not gamma-compile-server (got " + JSON.stringify(j).slice(0, 80) + ")");
    const ver = j.version ? " v" + j.version : "";
    sServerResult.textContent = "✓ reachable" + ver;
    sServerResult.style.color = "var(--audio)";
  } catch (e) {
    // Mixed-content failures show as TypeError "Failed to fetch" with no
    // useful detail in DevTools — surface a clearer hint inline.
    const msg = (e && e.message) || String(e);
    let hint = msg;
    if (/Failed to fetch|NetworkError/i.test(msg) && /^https?:/i.test(location.protocol) && location.protocol === "https:" && url.startsWith("http://") && !/\/\/(127\.0\.0\.1|localhost)/.test(url)) {
      hint = "blocked — editor is on https://, daemon is on http:// LAN. Serve the editor over http:// (e.g. python -m http.server) or run the daemon behind https.";
    } else if (/abort|timeout/i.test(msg)) {
      hint = "timeout — daemon not running or unreachable from this device";
    }
    sServerResult.textContent = "✗ " + hint;
    sServerResult.style.color = "var(--danger)";
  }
});
document.getElementById("btn-settings-clear").addEventListener("click", () => {
  if (!confirm("Clear stored Anthropic API key from this browser?")) return;
  aiSettings.anthropicKey = "";
  saveAiSettings();
  sKey.value = "";
  refreshModelBadge();
});

// Initial paint of the badge after AI settings are wired up.
refreshModelBadge();

// Cmd/Ctrl-Enter in prompt = run
aiPromptEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    document.getElementById("btn-ai-go").click();
  }
});

