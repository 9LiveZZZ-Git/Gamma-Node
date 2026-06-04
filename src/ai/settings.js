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
    if (raw) {
      const merged = Object.assign(defaultAiSettings(), JSON.parse(raw));
      // v0.3.703 fix -- if a previous build allowed an API key to be
      // saved into ollamaUrl (e.g. paste-into-wrong-field), scrub it on
      // load so the auto-prefix-http:// path can never turn it into a
      // URL again. Logs a warning so the user knows their stored
      // setting was reset.
      if (merged.ollamaUrl && !_looksLikeOllamaUrl(merged.ollamaUrl)) {
        console.warn("[ai-settings] Stored ollamaUrl doesn't look like a URL — clearing it. (Open Settings to re-enter a real URL, or leave blank for default 127.0.0.1:11434.)");
        merged.ollamaUrl = "";
        try { localStorage.setItem(AI_LS_KEY, JSON.stringify(merged)); } catch (_) {}
      }
      return merged;
    }
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
    // Phase B sprint 1 — Ollama provider plumbing.
    //   ollamaUrl: empty → auto-probe 127.0.0.1:11434. Set to a full URL
    //     (e.g. "http://192.168.1.42:11434") to point at a daemon on
    //     another machine — same LAN-iPad story as compileServerUrl.
    //   ollamaKey: API key for the ollama-cloud variant (ollama.com
    //     hosted Turbo models). Empty when using the local daemon.
    ollamaUrl: "",
    ollamaKey: "",
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

// Phase A.2 — SSE reader extracted to src/ai/streaming.js so the Ollama
// provider (NDJSON) and the LLM-from-scratch Generate node can share a
// uniform reader API. `readSSE` kept here as a thin alias so any
// external callers (older code paths that touched this file by name)
// still resolve. New code should call streamSSEEvents directly.
const readSSE = streamSSEEvents;

const PROVIDERS = {
  anthropic: {
    defaultModel: "claude-sonnet-4-5",
    requiresKey: true,
    supportsImage: true,
    supportsAudio: false,   // Whisper isn't routed through this path
    goodClassifier: true,   // HW.3 -- strong enough for constrained node-name classification
    async call({ system, user, model, key, onToken, image, audio, temperature, maxTokens, format, signal }) {
      if (audio) throw new Error("Anthropic provider does not handle audio input. Use Gemma for voice.");

      // image can be a single base64 string OR an array of base64
      // strings for multi-image input (e.g., reference + current view).
      const imageList = Array.isArray(image) ? image.filter(s => s) : (image ? [image] : []);
      const userContent = (imageList.length > 0)
        ? imageList.map(b => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b } }))
            .concat([{ type: "text", text: user }])
        : user;

      // Sprint B.10 -- JSON-mode shim. Anthropic doesn't have a
      // "format" knob like Ollama; the canonical pattern is to append
      // a system-prompt instruction + assert in the user message.
      let effectiveSystem = system || "";
      if (format === "json") {
        effectiveSystem = (effectiveSystem ? (effectiveSystem + "\n\n") : "") +
          "Respond with a single valid JSON object. No prose, no markdown fences, no commentary.";
      }

      const body = {
        model: model || "claude-sonnet-4-5",
        max_tokens: (typeof maxTokens === "number" && maxTokens > 0) ? maxTokens : 2048,
        system: effectiveSystem,
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
        body: JSON.stringify(body),
        signal: signal || undefined  // Sprint B.10 -- AbortController hookup
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

  /* Phase B sprint 1 -- Local Ollama daemon (ollama.com/download).
   * Talks directly to 127.0.0.1:11434 (or aiSettings.ollamaUrl if the
   * user pointed it at a LAN host). NDJSON streaming via ollamaChat in
   * src/ai/ollama.js. supportsImage is conservative-false; multimodal
   * models (llava, llama3.2-vision) do accept the `images` field but
   * non-vision models error noisily, and we have no way to know from
   * the model name alone -- a Sprint B.2 dynamic-capabilities probe
   * will flip this per-model later. goodClassifier=false to keep HW.3
   * handwriting-recognition fallbacks off Ollama for now (small local
   * models drift on constrained classification). */
  ollama: {
    defaultModel: "llama3.2",
    requiresKey: false,
    supportsImage: false,
    supportsAudio: false,
    goodClassifier: false,
    async call({ system, user, model, onToken, image, temperature, maxTokens, format, signal }) {
      return await ollamaChat({
        baseUrl: aiSettings.ollamaUrl,
        model,
        system,
        user,
        image,
        onToken,
        temperature,
        maxTokens,
        format,
        signal
      });
    }
  },

  /* Phase B sprint 1 -- Ollama Cloud (ollama.com hosted Turbo models).
   * Same endpoints + same NDJSON streaming, but with the cloud base URL
   * and a Bearer token from the user's ollama.com account. Larger models
   * make goodClassifier=true defensible. */
  "ollama-cloud": {
    defaultModel: "gpt-oss:120b-cloud",
    requiresKey: true,
    supportsImage: false,
    supportsAudio: false,
    goodClassifier: true,
    async call({ system, user, model, key, onToken, image, temperature, maxTokens, format, signal }) {
      return await ollamaChat({
        baseUrl: OLLAMA_CLOUD_BASE_URL,
        key,
        model,
        system,
        user,
        image,
        onToken,
        temperature,
        maxTokens,
        format,
        signal
      });
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
    async call({ system, user, model, onToken, image, audio, temperature, maxTokens, format, signal }) {
      // Note: `signal` is accepted for API parity but ignored. Gemma
      // runs in-browser via transformers.js without a native abort
      // hook; the LLM-runtime generation counter handles cancellation
      // at the consumer side (late tokens drop, see llm-runtime.js).
      const pipe = await ensureGemmaPipeline(model);

      // Sprint B.10 -- JSON-mode shim. Same pattern as Anthropic;
      // Gemma honors a "respond as JSON only" instruction reasonably
      // well on the E2B/E4B sizes.
      let effectiveSystem = system || "";
      if (format === "json") {
        effectiveSystem = (effectiveSystem ? (effectiveSystem + "\n\n") : "") +
          "Respond with a single valid JSON object. No prose, no markdown fences, no commentary.";
      }

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
        { role: "system", content: effectiveSystem },
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
  },
  /* Phase B sprint 1 -- Ollama placeholders for the badge picker. Sprint
   * B.2 will replace these with a dynamic list from /api/tags. For now
   * llama3.2 is a sensible bootstrap (a single `ollama pull llama3.2`
   * gets the user going); qwen3:8b is a small coding-capable alt. */
  {
    provider: "ollama",
    model: "llama3.2",
    name: "Llama 3.2 (Ollama)",
    meta: "Local · ollama daemon · 2 GB",
    tag: "local"
  },
  {
    provider: "ollama",
    model: "qwen3:8b",
    name: "Qwen3 8B (Ollama)",
    meta: "Local · ollama daemon · 5 GB",
    tag: "local"
  },
  {
    provider: "ollama-cloud",
    model: "gpt-oss:120b-cloud",
    name: "gpt-oss 120B (Cloud)",
    meta: "ollama.com Turbo · per-call cost",
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
  // Phase B sprint 1 -- Ollama. Drop the optional ":tag" suffix and the
  // -cloud sigil for the short display name.
  if (provider === "ollama" || provider === "ollama-cloud") {
    const base = (model || "").split(":")[0].replace(/-cloud$/, "");
    return base || model || "ollama";
  }
  return model;
}

function refreshModelBadge() {
  const tag = document.getElementById("model-badge-tag");
  const name = document.getElementById("model-badge-name");
  const btn = document.getElementById("btn-model-badge");
  if (!tag || !name || !btn) return;
  const p = aiSettings.provider;
  const isLocal = (p === "gemma" || p === "ollama");
  const hasKey = (p === "gemma" || p === "ollama")
              || (p === "anthropic"    && !!aiSettings.anthropicKey)
              || (p === "ollama-cloud" && !!aiSettings.ollamaKey);
  tag.textContent = isLocal ? "local" : "cloud";
  tag.className = "model-badge-tag " + (isLocal ? "local" : (hasKey ? "cloud" : "unset"));
  name.textContent = shortModelName(p, aiSettings.model);
  const providerLabel = (p === "gemma")        ? "local Gemma"
                      : (p === "ollama")       ? "local Ollama"
                      : (p === "ollama-cloud") ? "Ollama Cloud"
                      :                          "Anthropic API";
  btn.title = "Active model: " + shortModelName(p, aiSettings.model) +
    " (" + providerLabel + ")" +
    (!hasKey ? " — needs API key" : "") +
    " — click to switch";
}

function renderModelPopover() {
  const pop = document.getElementById("model-popover");
  if (!pop) return;
  const hasAnthKey = !!aiSettings.anthropicKey;
  const hasOllamaCloudKey = !!aiSettings.ollamaKey;

  // Phase B sprint 2 -- inject live Ollama models alongside the static
  // MODEL_OPTIONS so the popover reflects whatever the user actually has
  // installed. Status is read from the cache (populated by
  // probeOllamaStatus, called from refreshOllamaStatus / openSettings /
  // initial idle probe below). Stale cached data is rendered immediately;
  // a background refresh updates the cache for the next popover open.
  const localStatus = getCachedOllamaStatus(aiSettings.ollamaUrl, "");
  const localModels = (localStatus && localStatus.models) || [];
  const localOk     = !!(localStatus && localStatus.version && !localStatus.error);

  // Build the combined item list. Static MODEL_OPTIONS minus the local-
  // Ollama placeholders if we have a real list to substitute in; cloud
  // Ollama placeholder is kept regardless (cloud probe needs a key to
  // succeed and we don't pre-emptively probe with an empty key).
  const items = [];
  MODEL_OPTIONS.forEach(opt => {
    if (opt.provider === "ollama" && localOk && localModels.length) return;  // replaced by live list below
    items.push({ kind: "static", opt });
  });
  if (localOk && localModels.length) {
    localModels.forEach(m => {
      items.push({
        kind: "ollama",
        opt: {
          provider: "ollama",
          model: m.name,
          name: m.name,
          meta: (typeof m.size === "number")
            ? "Local · ollama daemon · " + (m.size / 1e9).toFixed(2) + " GB"
            : "Local · ollama daemon",
          tag: "local"
        }
      });
    });
  }

  let html = `<div class="model-popover-head">Active AI model</div>`;
  items.forEach((it, i) => {
    const opt = it.opt;
    const isActive = aiSettings.provider === opt.provider && aiSettings.model === opt.model;
    let needsKey = false;
    if (opt.provider === "anthropic"   && !hasAnthKey)        needsKey = true;
    if (opt.provider === "ollama-cloud" && !hasOllamaCloudKey) needsKey = true;
    const cls = "model-popover-item " + opt.tag + (isActive ? " active" : "") + (needsKey ? " disabled" : "");
    let keyHint = "";
    if (needsKey) keyHint = (opt.provider === "ollama-cloud") ? " · Ollama key not set" : " · API key not set";
    html += `<div class="${cls}" data-i="${i}" role="menuitem"${needsKey ? ' aria-disabled="true"' : ""}>
      <span class="check" aria-hidden="true"></span>
      <span class="info">
        <span class="name">${escapeText(opt.name)}</span>
        <span class="meta">${escapeText(opt.meta)}${keyHint}</span>
      </span>
      <span class="badge-tag">${opt.tag}</span>
    </div>`;
  });

  // Footer: status summary + Settings link. The summary covers both
  // Anthropic key state AND the local-Ollama probe state, which is what
  // the user most often wants to glance at when switching models.
  let footerSummary = "";
  if (localStatus) {
    if (localOk) {
      footerSummary = "Ollama: ✓ v" + localStatus.version + " · " + localModels.length + " models";
    } else if (localStatus.error) {
      footerSummary = "Ollama: ✗ unreachable";
    }
  }
  if (hasAnthKey)        footerSummary += (footerSummary ? " · " : "") + "Anthropic key set";
  if (hasOllamaCloudKey) footerSummary += (footerSummary ? " · " : "") + "Cloud key set";
  if (!footerSummary)    footerSummary = "Run probe in Settings to discover local models";

  html += `<div class="model-popover-foot">
    <span>${escapeText(footerSummary)}</span>
    <a id="model-popover-settings">Settings →</a>
  </div>`;
  pop.innerHTML = html;

  pop.querySelectorAll(".model-popover-item").forEach(el => {
    el.addEventListener("click", () => {
      if (el.classList.contains("disabled")) return;
      const opt = items[+el.dataset.i].opt;
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

  // Phase B sprint 2 -- kick a background Ollama probe so the popover
  // reflects whatever the user has installed RIGHT NOW. The first render
  // above used the cached snapshot (if any); when this probe lands, we
  // re-render the popover IFF it's still open.
  probeOllamaStatus({
    baseUrl: aiSettings.ollamaUrl,
    key:     "",
    onUpdate: () => {
      if (pop.style.display === "block") renderModelPopover();
    }
  });
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
    // Phase B sprint 1 -- per-provider key field. Anthropic uses
    // anthropicKey; ollama-cloud uses ollamaKey. Local Ollama + Gemma
    // don't enter this branch (requiresKey=false).
    if (aiSettings.provider === "ollama-cloud") key = aiSettings.ollamaKey;
    else                                        key = aiSettings.anthropicKey;
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
  const localityLabel = (aiSettings.provider === "gemma" || aiSettings.provider === "ollama") ? "local" : "cloud";
  setAiStatus("Thinking… (" + shortModelName(aiSettings.provider, aiSettings.model) + ", " +
    localityLabel + ")", "thinking");

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
  // Phase B sprint 1 -- four flavors now: gemma, ollama (local),
  // ollama-cloud, anthropic.
  const isGemma       = (p === "gemma");
  const isOllamaLocal = (p === "ollama");
  const isOllamaCloud = (p === "ollama-cloud");
  const isAnthropic   = (p === "anthropic");

  // The WebGPU note belongs to Gemma; the API-key note belongs to any
  // cloud provider (Anthropic, Ollama Cloud). Local Ollama gets neither
  // -- it's covered by the per-field placeholder below + the dedicated
  // ollama install note (added Sprint B.2).
  sNoteApi.style.display   = (isAnthropic || isOllamaCloud) ? "block" : "none";
  sNoteLocal.style.display = isGemma ? "block" : "none";

  // Gemma uses a fixed dropdown of two ONNX checkpoints. Everything else
  // is a free-text model-id input (Ollama tags, Anthropic model names).
  sModel.style.display      = isGemma ? "none"  : "block";
  sModelLocal.style.display = isGemma ? "block" : "none";

  // Key field repurposing:
  //   Gemma          -- hidden (no auth)
  //   Anthropic      -- API key (password input)
  //   Ollama Cloud   -- API key (password input)
  //   Local Ollama   -- visible as URL field (text input) so the user can
  //                     point at a LAN host. Empty -> auto-probe 127.0.0.1:11434.
  sKey.style.display      = isGemma ? "none" : "block";
  sKeyLabel.style.display = isGemma ? "none" : "block";
  if (isOllamaLocal) {
    sKeyLabel.textContent = "Ollama URL";
    sKey.placeholder = "http://127.0.0.1:11434 (leave empty for default)";
    sKey.type = "text";
  } else if (isOllamaCloud) {
    sKeyLabel.textContent = "Ollama Cloud key";
    sKey.placeholder = "Bearer token from ollama.com";
    sKey.type = "password";
  } else if (isAnthropic) {
    sKeyLabel.textContent = "API key";
    sKey.placeholder = "sk-ant-…";
    sKey.type = "password";
  }

  // Show / refresh the local-model status panel (Gemma's WebGPU + cache state).
  const panel = document.getElementById("gemma-status-panel");
  if (panel) panel.style.display = isGemma ? "block" : "none";
  if (isGemma) refreshGemmaStatus();

  // Phase B sprint 2 -- Ollama status panel (daemon version + installed
  // models list). Shown for BOTH local and cloud variants; the probe
  // targets the appropriate base URL based on provider.
  const ollamaPanel = document.getElementById("ollama-status-panel");
  if (ollamaPanel) ollamaPanel.style.display = (isOllamaLocal || isOllamaCloud) ? "block" : "none";
  if (isOllamaLocal || isOllamaCloud) refreshOllamaStatus();

  // Warn if WebGPU isn't available (Gemma-only concern).
  if (isGemma && !setupGemmaAvailable()) {
    sNoteLocal.style.color = "var(--danger)";
    sNoteLocal.textContent = "WebGPU is not available in this browser. Gemma 4 requires Chrome, Edge, or recent Safari with WebGPU enabled. Try chrome://flags/#enable-unsafe-webgpu if needed, or switch to the Anthropic / Ollama provider.";
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

/* Phase B sprint 2 -- Ollama status panel.
 *
 * Mirrors the Gemma panel shape: shows daemon-version + installed-model
 * lines, a "Test connection" button, and a scrollable list of installed
 * models. Each model row is clickable -- click sets it as the active
 * model. List repopulates via probeOllamaStatus() from src/ai/ollama.js
 * with a 30s cache + background-refresh fallback.
 *
 * The same panel serves both provider variants: for "ollama" the base
 * URL comes from aiSettings.ollamaUrl (or the 127.0.0.1:11434 default),
 * for "ollama-cloud" it's the fixed ollama.com endpoint. The panel
 * detects which is active and probes accordingly.
 */
function _ollamaPanelOptsFor(provider) {
  // Read the LIVE settings-modal field value, not aiSettings, so the
  // user can test before saving. The "key" field doubles as URL for
  // local Ollama -- see applyProviderUi for the dual-role.
  const raw = (sKey && sKey.value) ? sKey.value.trim() : "";
  if (provider === "ollama-cloud") {
    return { baseUrl: OLLAMA_CLOUD_BASE_URL, key: raw || aiSettings.ollamaKey };
  }
  // Local Ollama.
  const url = raw.replace(/\/+$/, "");
  return { baseUrl: url || aiSettings.ollamaUrl, key: "" };
}

function refreshOllamaStatus() {
  const verSpan   = document.getElementById("ollama-version-state");
  const countSpan = document.getElementById("ollama-models-state");
  const listEl    = document.getElementById("ollama-models-list");
  const noteEl    = document.getElementById("ollama-probe-note");
  if (!verSpan || !countSpan || !listEl) return;

  const provider = sProvider ? sProvider.value : aiSettings.provider;
  const opts = _ollamaPanelOptsFor(provider);
  const cached = getCachedOllamaStatus(opts.baseUrl, opts.key);

  // Render whatever cached snapshot we have right now.
  _ollamaRenderStatus(cached, provider);

  // Kick a background probe; re-render when it lands.
  probeOllamaStatus({
    baseUrl: opts.baseUrl,
    key:     opts.key,
    onUpdate: (out) => _ollamaRenderStatus(out, provider)
  });
  if (noteEl) {
    noteEl.textContent = cached ? "" : "probing " + _resolveOllamaBase(opts.baseUrl) + "…";
    noteEl.style.color = "var(--text-3)";
  }
}

function _ollamaRenderStatus(snapshot, provider) {
  const verSpan   = document.getElementById("ollama-version-state");
  const countSpan = document.getElementById("ollama-models-state");
  const listEl    = document.getElementById("ollama-models-list");
  const noteEl    = document.getElementById("ollama-probe-note");
  if (!verSpan || !countSpan || !listEl) return;
  if (!snapshot) {
    verSpan.textContent   = "checking…";
    verSpan.style.color   = "var(--text-3)";
    countSpan.textContent = "—";
    countSpan.style.color = "var(--text-3)";
    listEl.innerHTML = "";
    return;
  }
  if (snapshot.error && !snapshot.version) {
    verSpan.textContent   = "✗ unreachable";
    verSpan.style.color   = "var(--danger)";
    countSpan.textContent = "—";
    countSpan.style.color = "var(--text-3)";
    listEl.innerHTML = "";
    if (noteEl) {
      // Most common failure: daemon not running. Surface install hint.
      const msg = snapshot.error;
      let hint = msg;
      if (/Failed to fetch|NetworkError/i.test(msg)) {
        if (provider === "ollama-cloud") {
          hint = "blocked — check your Ollama Cloud key or network connection";
        } else {
          hint = "daemon not reachable. Install Ollama from ollama.com/download and run `ollama serve`, or set the URL above to point at a daemon on another machine.";
        }
      }
      noteEl.textContent = hint;
      noteEl.style.color = "var(--danger)";
    }
    return;
  }
  // Success path.
  verSpan.textContent = "✓ v" + snapshot.version;
  verSpan.style.color = "var(--audio)";
  const models = snapshot.models || [];
  countSpan.textContent = models.length + (models.length === 1 ? " model" : " models");
  countSpan.style.color = models.length ? "var(--audio)" : "var(--warn)";

  // Render the scrollable list of installed models. Each row sets that
  // model as the active one on click. Active model gets a check.
  const activeModel = (sModel && sModel.value) || aiSettings.model;
  if (!models.length) {
    listEl.innerHTML = '<div class="ollama-model-empty">No models pulled yet. Run <code>ollama pull llama3.2</code> in a terminal, then click Refresh.</div>';
  } else {
    listEl.innerHTML = models.map(m => {
      const sizeStr = (typeof m.size === "number") ? (m.size / 1e9).toFixed(2) + " GB" : "";
      const isActive = (m.name === activeModel);
      return `<div class="ollama-model${isActive ? " active" : ""}" data-name="${escapeAttr(m.name)}" role="button">
        <span class="ollama-model-name">${escapeText(m.name)}</span>
        <span class="ollama-model-size">${sizeStr}</span>
      </div>`;
    }).join("");
    listEl.querySelectorAll(".ollama-model").forEach(el => {
      el.addEventListener("click", () => {
        const name = el.dataset.name;
        if (sModel) sModel.value = name;
        // Update the active highlight without a full re-render.
        listEl.querySelectorAll(".ollama-model").forEach(e => e.classList.remove("active"));
        el.classList.add("active");
      });
    });
  }
  if (noteEl) {
    noteEl.textContent = "Last probed " + new Date(snapshot.fetchedAt).toLocaleTimeString();
    noteEl.style.color = "var(--text-3)";
  }
}

/* Buttons inside the Ollama status panel. Both end up calling
 * refreshOllamaStatus() with a force flag (Test connection) or without
 * (Refresh) -- the difference is only whether we honor the 30s cache. */
const btnOllamaTest = document.getElementById("btn-ollama-test");
if (btnOllamaTest) btnOllamaTest.addEventListener("click", async () => {
  const noteEl = document.getElementById("ollama-probe-note");
  const provider = sProvider ? sProvider.value : aiSettings.provider;
  const opts = _ollamaPanelOptsFor(provider);
  if (noteEl) {
    noteEl.textContent = "probing " + _resolveOllamaBase(opts.baseUrl) + "…";
    noteEl.style.color = "var(--text-3)";
  }
  await probeOllamaStatus({ baseUrl: opts.baseUrl, key: opts.key, force: true });
  refreshOllamaStatus();
});
const btnOllamaRefresh = document.getElementById("btn-ollama-refresh");
if (btnOllamaRefresh) btnOllamaRefresh.addEventListener("click", async () => {
  const provider = sProvider ? sProvider.value : aiSettings.provider;
  const opts = _ollamaPanelOptsFor(provider);
  await probeOllamaStatus({ baseUrl: opts.baseUrl, key: opts.key, force: true });
  refreshOllamaStatus();
});

/* Phase B sprint 5 -- model download UX. The Ollama panel exposes a
 * "Pull model" form: tag input + 4 suggestion chips + Pull button +
 * progress bar. The Pull button streams NDJSON events from /api/pull
 * and drives the bar from the {completed, total} pair when the daemon
 * sends them. The "pulling manifest" / "verifying" / "writing
 * manifest" phases don't have byte totals -- we render an
 * indeterminate shimmer for those so the user knows we're still alive.
 *
 * Suggestion chips just stuff the input field. The user is free to
 * type any tag they want, including registry-namespaced ones like
 * "library/mistral".
 *
 * On success the status panel is force-refreshed so the new model
 * shows up in the model badge popover + the installed-models list. */
const _ollamaPullSuggestNodes = document.querySelectorAll(".ollama-pull-suggest");
const _ollamaPullInput = document.getElementById("ollama-pull-name");
const _ollamaPullHfRow     = document.getElementById("ollama-pull-hf-row");
const _ollamaPullHfPreview = document.getElementById("ollama-pull-hf-preview");
const _ollamaPullHfQuant   = document.getElementById("ollama-pull-hf-quant");

/* Phase B sprint 7 -- preview the HF normalization live. When the user
 * types or pastes an HF URL into the pull-name field, normalize it via
 * normalizeOllamaModelTag() and show the rewritten `hf.co/...` form
 * (so they can verify before pulling). Also reveal the quant dropdown
 * so they can pick a quantization tier. */
function _ollamaUpdateHfPreview() {
  if (!_ollamaPullInput || !_ollamaPullHfRow) return;
  const raw = _ollamaPullInput.value || "";
  const quant = _ollamaPullHfQuant ? _ollamaPullHfQuant.value : "";
  const normalized = normalizeOllamaModelTag(raw, quant);
  const isHf = /^hf\.co\//i.test(normalized);
  if (isHf && normalized !== raw.trim()) {
    _ollamaPullHfRow.style.display = "block";
    if (_ollamaPullHfPreview) _ollamaPullHfPreview.textContent = normalized;
  } else if (isHf) {
    // User typed `hf.co/...` directly; still show the quant picker.
    _ollamaPullHfRow.style.display = "block";
    if (_ollamaPullHfPreview) _ollamaPullHfPreview.textContent = normalized;
  } else {
    _ollamaPullHfRow.style.display = "none";
  }
}
if (_ollamaPullInput) _ollamaPullInput.addEventListener("input", _ollamaUpdateHfPreview);
if (_ollamaPullHfQuant) _ollamaPullHfQuant.addEventListener("change", _ollamaUpdateHfPreview);

_ollamaPullSuggestNodes.forEach((chip) => {
  chip.addEventListener("click", () => {
    const tag = chip.getAttribute("data-pull") || "";
    if (_ollamaPullInput) {
      _ollamaPullInput.value = tag;
      _ollamaPullInput.focus();
      _ollamaUpdateHfPreview();
    }
  });
});

function _formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : (n >= 10 ? 1 : 2)) + " " + units[i];
}

/* HTML-escape for the small set of chars that can break attribute /
 * element context when surfacing user-controlled HF repo names into
 * the pull-note innerHTML. Used by the sprint-9 HF probe error path. */
function _ollamaPullEscapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const btnOllamaPull = document.getElementById("btn-ollama-pull");
if (btnOllamaPull) btnOllamaPull.addEventListener("click", async () => {
  const input    = document.getElementById("ollama-pull-name");
  const note     = document.getElementById("ollama-pull-note");
  const progWrap = document.getElementById("ollama-pull-progress-wrap");
  const progEl   = progWrap ? progWrap.querySelector(".ollama-pull-progress") : null;
  const fillEl   = document.getElementById("ollama-pull-progress-fill");
  const rateEl   = document.getElementById("ollama-pull-rate");
  const rawInput = (input && input.value || "").trim();
  if (!rawInput) {
    if (note) { note.textContent = "Enter a model tag (e.g. llama3.2) or HuggingFace URL."; note.style.color = "var(--danger)"; }
    return;
  }
  // Phase B sprint 7 -- HF URL / org-slash-repo / plain tag all flow
  // through normalizeOllamaModelTag. Plain Ollama-registry tags pass
  // through unchanged; HF references get rewritten to `hf.co/...:quant`.
  const quant = _ollamaPullHfQuant ? _ollamaPullHfQuant.value : "";
  const model = normalizeOllamaModelTag(rawInput, quant);
  const isHf  = /^hf\.co\//i.test(model);

  const provider = sProvider ? sProvider.value : aiSettings.provider;
  const opts     = _ollamaPanelOptsFor(provider);

  /* Phase B sprint 9 -- HF pre-pull probe. If the input is an HF
   * reference, check the public HF API for actual `.gguf` siblings
   * before bothering Ollama. Avoids the daemon's "manifest not found"
   * error for non-GGUF repos like microsoft/TRELLIS.2-4B (a 3D-
   * generation model with no GGUF artifacts at all). */
  if (isHf) {
    if (note) { note.textContent = "Checking HuggingFace for GGUF files…"; note.style.color = "var(--text-3)"; }
    const probe = await probeHuggingFaceRepo(model);
    if (probe.ok && probe.hasGguf === false) {
      if (note) {
        const repoFull = probe.repoFull || "";
        const searchTerm = (repoFull.split("/")[1] || repoFull) + " GGUF";
        const searchUrl  = "https://huggingface.co/models?search=" + encodeURIComponent(searchTerm);
        note.innerHTML = "✗ <strong>" + _ollamaPullEscapeHtml(repoFull) + "</strong> has no <code style=\"color:var(--accent);\">.gguf</code> files. " +
          "Ollama can only pull GGUF-quantized repos -- this one is likely SafeTensors / diffusion / multimodal. " +
          "<a href=\"" + searchUrl + "\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--text-wire);\">Search HF for GGUF versions →</a>";
        note.style.color = "var(--danger)";
      }
      return;
    }
    if (!probe.ok && probe.status === 404) {
      if (note) {
        note.textContent = "✗ " + (probe.repoFull || rawInput) +
          " not found on HF (or private/gated -- set HF_TOKEN as an env var on the Ollama daemon for private pulls).";
        note.style.color = "var(--danger)";
      }
      return;
    }
    // probe.ok && hasGguf=true: hint if the picked quant isn't in the
    // available file list (Ollama will fall back to a default).
    if (probe.ok && quant && probe.ggufFiles.length &&
        !probe.ggufFiles.some(f => f.toUpperCase().includes(quant.toUpperCase()))) {
      if (note) {
        const available = probe.ggufFiles.slice(0, 4).map(f => f.replace(/\.gguf$/i, "")).join(", ");
        note.textContent = "ⓘ " + quant + " not in this repo. Available: " + available +
          (probe.ggufFiles.length > 4 ? "…" : "") + ". Pulling default anyway…";
        note.style.color = "var(--warn)";
      }
    }
    // ok=false with non-404 status (CORS / offline / private with failed
    // auth) -- proceed silently, let Ollama decide.
  }

  // Show the progress UI, start in indeterminate mode (we don't know
  // total bytes until the first layer event arrives).
  if (progWrap) progWrap.style.display = "block";
  if (progEl)   progEl.classList.add("indeterminate");
  if (fillEl)   fillEl.style.width = "30%";
  if (note)     { note.textContent = "Starting pull of " + model + "…"; note.style.color = "var(--text-3)"; }
  if (rateEl)   rateEl.textContent = "";
  btnOllamaPull.disabled = true;
  _ollamaPullSuggestNodes.forEach(c => c.style.pointerEvents = "none");

  // Throttle UI updates to once per ~90ms to avoid layout thrash --
  // Ollama emits dozens of progress events per second on a fast link.
  let lastUiAt = 0;
  const startedAt = performance.now();
  let lastCompleted = 0;
  let lastSampleAt = startedAt;

  const onProgress = (ev) => {
    if (!ev || typeof ev !== "object") return;
    const status    = ev.status || "";
    const total     = Number(ev.total);
    const completed = Number(ev.completed);
    const hasBytes  = Number.isFinite(total) && total > 0 && Number.isFinite(completed);

    // Status text always updates (cheap), bar updates throttled.
    const now = performance.now();
    if (now - lastUiAt < 90 && status === note?._lastStatus) return;
    lastUiAt = now;
    if (note) { note._lastStatus = status; }

    if (hasBytes) {
      if (progEl) progEl.classList.remove("indeterminate");
      const pct = Math.max(0, Math.min(100, (completed / total) * 100));
      if (fillEl) fillEl.style.width = pct.toFixed(1) + "%";
      // Rolling rate sample over the last ~600ms window.
      const dtMs = now - lastSampleAt;
      if (dtMs > 600) {
        const dBytes = completed - lastCompleted;
        const rate   = dBytes / (dtMs / 1000);  // bytes / s
        if (rateEl && rate > 0) rateEl.textContent = _formatBytes(rate) + "/s";
        lastSampleAt  = now;
        lastCompleted = completed;
      }
      if (note) {
        note.textContent = status + " — " + _formatBytes(completed) + " / " + _formatBytes(total)
          + " (" + pct.toFixed(0) + "%)";
        note.style.color = "var(--text-3)";
      }
    } else {
      // Indeterminate phase (manifest / verify / write manifest / success).
      if (progEl) progEl.classList.add("indeterminate");
      if (note) {
        note.textContent = status;
        note.style.color = "var(--text-3)";
      }
    }
  };

  try {
    await pullOllamaModel({ baseUrl: opts.baseUrl, key: opts.key, model, onProgress });
    // Fill to 100% on success regardless of the last progress event.
    if (progEl) progEl.classList.remove("indeterminate");
    if (fillEl) fillEl.style.width = "100%";
    if (rateEl) rateEl.textContent = "";
    const elapsedS = ((performance.now() - startedAt) / 1000).toFixed(1);
    if (note) {
      note.textContent = "✓ Pulled " + model + " (" + elapsedS + "s). Refreshing model list…";
      note.style.color = "var(--accent)";
    }
    // Force a fresh probe so the badge + installed-models list show the new tag.
    await probeOllamaStatus({ baseUrl: opts.baseUrl, key: opts.key, force: true });
    refreshOllamaStatus();
  } catch (err) {
    if (progEl) progEl.classList.remove("indeterminate");
    if (fillEl) fillEl.style.width = "0%";
    if (rateEl) rateEl.textContent = "";
    if (note) {
      const msg = (err && err.message) || String(err);
      // Phase B sprint 9 -- if the pull failed AND we were targeting
      // an HF tag, append the GGUF reminder. Catches the case where
      // the pre-probe couldn't reach HF (CORS / offline) but the
      // daemon-side pull failed for the same gguf-absent reason.
      if (isHf && /manifest|not found|no such|404/i.test(msg)) {
        note.innerHTML = "✗ Pull failed: " + _ollamaPullEscapeHtml(msg) +
          "<br><span style=\"font-size:11px;color:var(--text-3);\">Tip: Ollama only pulls <code style=\"color:var(--accent);\">.gguf</code> files. " +
          "Confirm this HF repo has a GGUF release.</span>";
      } else {
        note.textContent = "✗ Pull failed: " + msg;
      }
      note.style.color = "var(--danger)";
    }
  } finally {
    btnOllamaPull.disabled = false;
    _ollamaPullSuggestNodes.forEach(c => c.style.pointerEvents = "");
  }
});

function openSettings() {
  sProvider.value = aiSettings.provider;
  if (aiSettings.provider === "gemma") {
    const opts = Array.from(sModelLocal.options).map(o => o.value);
    sModelLocal.value = opts.includes(aiSettings.model) ? aiSettings.model : PROVIDERS.gemma.defaultModel;
  } else if (aiSettings.provider === "ollama") {
    // Phase B sprint 1 -- Ollama local. Model is a free-text tag like
    // "llama3.2" or "qwen3:8b". Key field is repurposed as the URL.
    sModel.value = aiSettings.model || PROVIDERS.ollama.defaultModel;
    sKey.value   = aiSettings.ollamaUrl || "";
  } else if (aiSettings.provider === "ollama-cloud") {
    sModel.value = aiSettings.model || PROVIDERS["ollama-cloud"].defaultModel;
    sKey.value   = aiSettings.ollamaKey || "";
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
  } else if (p === "ollama") {
    sKey.value = aiSettings.ollamaUrl || "";
    if (!sModel.value || sModel.value.startsWith("onnx-community/") || sModel.value.startsWith("claude-")) {
      sModel.value = PROVIDERS.ollama.defaultModel;
    }
  } else if (p === "ollama-cloud") {
    sKey.value = aiSettings.ollamaKey || "";
    if (!sModel.value || sModel.value.startsWith("onnx-community/") || sModel.value.startsWith("claude-")) {
      sModel.value = PROVIDERS["ollama-cloud"].defaultModel;
    }
  } else {
    sKey.value = aiSettings.anthropicKey;
    // Anthropic — pre-fill with default model if user hasn't already typed one
    if (!sModel.value || sModel.value.startsWith("onnx-community/") || /(:|^ll|^qw|^gpt-oss)/i.test(sModel.value)) {
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
  } else if (aiSettings.provider === "ollama") {
    aiSettings.model     = sModel.value.trim() || PROVIDERS.ollama.defaultModel;
    // v0.3.703 fix -- if the URL field looks like an API key (most
    // commonly an Anthropic sk-ant-... value pasted into the wrong
    // input), refuse to save. The previous behaviour stored that in
    // localStorage which then got auto-prefixed with http:// and
    // showed up in console URLs, leaking the key.
    const rawUrl = sKey.value.trim();
    if (rawUrl && !_looksLikeOllamaUrl(rawUrl)) {
      setAiStatus("Ollama URL doesn't look like a URL — leave blank for the default 127.0.0.1:11434, or paste a real http:// URL.", "err");
      return;
    }
    aiSettings.ollamaUrl = rawUrl.replace(/\/+$/, "");
  } else if (aiSettings.provider === "ollama-cloud") {
    aiSettings.model     = sModel.value.trim() || PROVIDERS["ollama-cloud"].defaultModel;
    aiSettings.ollamaKey = sKey.value.trim();
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
  // Phase B sprint 1 -- clears the credential / URL relevant to the
  // currently-selected provider. Gemma has no credential so the button
  // is a no-op there.
  const p = aiSettings.provider;
  let what = "Anthropic API key";
  if (p === "ollama")       what = "Ollama URL override";
  if (p === "ollama-cloud") what = "Ollama Cloud key";
  if (!confirm("Clear stored " + what + " from this browser?")) return;
  if (p === "ollama")            aiSettings.ollamaUrl = "";
  else if (p === "ollama-cloud") aiSettings.ollamaKey = "";
  else                           aiSettings.anthropicKey = "";
  saveAiSettings();
  sKey.value = "";
  refreshModelBadge();
});

// Initial paint of the badge after AI settings are wired up.
refreshModelBadge();

// Phase B sprint 2 -- idle probe of the local Ollama daemon so the
// model badge popover has fresh `installed models` data the first time
// the user clicks it. requestIdleCallback (with a setTimeout fallback)
// keeps this off the startup-paint critical path. Failures are silent
// here -- the cache will record the error and the popover renders
// "Ollama: ✗ unreachable" in the footer next time it opens.
const _kickIdleOllamaProbe = () => {
  probeOllamaStatus({ baseUrl: aiSettings.ollamaUrl, key: "" })
    .then(() => refreshModelBadge())
    .catch(() => {});
};
if (typeof requestIdleCallback === "function") {
  requestIdleCallback(_kickIdleOllamaProbe, { timeout: 4000 });
} else {
  setTimeout(_kickIdleOllamaProbe, 1500);
}

// Cmd/Ctrl-Enter in prompt = run
aiPromptEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    document.getElementById("btn-ai-go").click();
  }
});

