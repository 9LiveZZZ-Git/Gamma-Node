const TYPES = {

  /* ---- Oscillators (Oscillator.h) ---- */
  /* Phase-resettable oscillators. trig is OPTIONAL — wire a clock /
   * gate / button into it to retrigger the phase to 0 on each pulse
   * (clean transients for percussive use; sine-as-kick patterns).
   * Codegen emits `if ((upstream) > 0.5f) n.phase(0.f);` per sample
   * when wired. Most of these inherit AccumPhase, which provides
   * phase(T). SineR uses reset(); SineD already had its own trig. */
  Sine: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::Sine<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 440 },
    methods: { freq: "freq" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Sinusoid via table lookup. Optional trig resets phase."
  },
  Saw: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::Saw<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 110 },
    methods: { freq: "freq" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Bandlimited sawtooth. Optional trig resets phase."
  },
  Square: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::Square<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 220 },
    methods: { freq: "freq" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Bandlimited square. Optional trig resets phase."
  },
  Impulse: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::Impulse<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 100 },
    methods: { freq: "freq" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Bandlimited impulse train. Optional trig resets phase."
  },
  /* LFO + Triangle — both wrapped in GammaLFOWrap below. Reason:
   * gam::LFO inherits Accum::operator() which returns bool (true
   * once per phase wrap), so calling `n()` directly gave a sparse
   * impulse train, not the LFO's actual waveshape. The wrapper
   * picks one of LFO's named output methods (.tri / .sqr / .up /
   * .down / .pulse / .para) based on the shape param. Triangle is
   * the same wrapper with shape locked to 0 in the registry, no
   * UI dropdown. */
  LFO: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "GammaLFOWrap",
    helperClass:
`class GammaLFOWrap {
    gam::LFO<> lfo_;
    int shape_ = 0;       // 0=tri, 1=sqr, 2=up, 3=down, 4=pulse, 5=para, 6=sinPara
public:
    void freq(float v)    { lfo_.freq(v); }
    void mod(float v)     { lfo_.mod(v); }
    void phase(float p)   { lfo_.phase(p); }
    void setShape(float s){ shape_ = (int)s; }
    float operator()() {
        switch (shape_) {
            case 1: return lfo_.sqr();
            case 2: return lfo_.up();
            case 3: return lfo_.down();
            case 4: return lfo_.pulse();
            case 5: return lfo_.para();
            case 6: return lfo_.sinPara();
            default: return lfo_.tri();
        }
    }
};`,
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}, {n:"mod", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 1, mod: 0.5, shape: "tri" },
    methods: { freq: "freq", mod: "mod", shape: "setShape" },
    paramOptions: { shape: ["tri", "sqr", "up", "down", "pulse", "para", "sinPara"] },
    enumMap:      { shape: { tri: "0", sqr: "1", up: "2", down: "3", pulse: "4", para: "5", sinPara: "6" } },
    gateMethods: { trig: "phase(0.f)" },
    description: "Low-freq oscillator. shape picks the output waveform; mod adjusts pulse-width / wave-morph (used by sqr / pulse / stair shapes). Optional trig resets phase to 0 (sync to clock)."
  },
  Buzz: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::Buzz<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}, {n:"harmonics", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 200, harmonics: 8 },
    methods: { freq: "freq", harmonics: "harmonics" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Bandlimited impulse train via DSF. Optional trig resets phase."
  },
  DSF: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::DSF<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}, {n:"freqRatio", t:"param"}, {n:"ampRatio", t:"param"}, {n:"harmonics", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 220, freqRatio: 1, ampRatio: 0.7, harmonics: 8 },
    methods: { freq: "freq", freqRatio: "freqRatio", ampRatio: "ampRatio", harmonics: "harmonics" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Discrete Summation Formula synth. Optional trig resets phase."
  },
  SineD: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::SineD<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 440 },
    methods: { freq: "freq" },
    description: "Decaying sinusoid (a single partial). trig restarts the decay."
  },
  SineR: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::SineR<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 440, amp: 1 },
    methods: { freq: "freq", amp: "amp" },
    description: "Resonator-based sine (recursive). trig calls reset() to re-zero state."
  },
  CSine: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::CSine<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 440 },
    methods: { freq: "freq" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Complex sine (rotates on unit circle). Optional trig resets phase."
  },
  /* Triangle — same wrapper as LFO, shape pinned to 0 (= .tri()).
   * The previous registry was broken multiple ways: amp setter
   * didn't exist on LFO, .mode()/::TRI weren't real members, and
   * the bare `n()` returns bool from Accum's operator(). All gone
   * now via the GammaLFOWrap helper (defined on the LFO entry,
   * deduped in codegen). */
  Triangle: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "GammaLFOWrap",
    helperClass:
`class GammaLFOWrap {
    gam::LFO<> lfo_;
    int shape_ = 0;
public:
    void freq(float v)    { lfo_.freq(v); }
    void mod(float v)     { lfo_.mod(v); }
    void phase(float p)   { lfo_.phase(p); }
    void setShape(float s){ shape_ = (int)s; }
    float operator()() {
        switch (shape_) {
            case 1: return lfo_.sqr();
            case 2: return lfo_.up();
            case 3: return lfo_.down();
            case 4: return lfo_.pulse();
            case 5: return lfo_.para();
            case 6: return lfo_.sinPara();
            default: return lfo_.tri();
        }
    }
};`,
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 220 },
    methods: { freq: "freq" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Bandlimited triangle (LFO in tri mode, audio-rate). Optional trig resets phase to 0."
  },
  /* TableSine — gam::TableSine<> doesn't exist. The class was
   * referenced in Gamma's docstrings but never declared. Aliasing
   * to gam::Sine (the polynomial-approximation sine, not actually
   * table-based) so the node still functions; the description
   * walks back the "table" claim. Doesn't need its own helper —
   * the cppType, methods, ins/outs are identical to plain Sine. */
  TableSine: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::Sine<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 440 },
    methods: { freq: "freq" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Sine wave (alias of Sine — the original gam::TableSine class doesn't exist in this Gamma checkout). Optional trig resets phase."
  },
  Sweep: {
    category: "Oscillator", color: COLOR.oscillator, header: "Oscillator",
    cppType: "gam::Sweep<>",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 1 },
    methods: { freq: "freq" },
    gateMethods: { trig: "phase(0.f)" },
    description: "Linear ramp from 0 to 1, then wraps. Useful as a phase source. trig restarts the ramp."
  },

  /* ============================================================
   * Composite oscillators — synthesis primitives implemented as
   * helper classes (not direct gam:: bindings). Each maintains its
   * own phase + state and uses std::sin / std::pow from <cmath>.
   * Naive (non-bandlimited) — fine for use cases where the user
   * stacks an anti-aliased filter or runs at high sample-rates;
   * a bandlimited variant pass can swap implementations later
   * without changing the registry shape.
   * ============================================================ */

  /* Wavetable oscillator — single-cycle 256-sample table looked up
   * with linear interpolation. The table is initialized from a
   * `shape` enum at constructor time (sine / saw / square / triangle
   * / halfSine / noise / hollow / spike). A future revision will add
   * a drawable wavetable editor (kind: "waveTable" hook reserved). */
  WavetableOsc: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaWavetableOsc",
    helperClass:
`class GammaWavetableOsc {
    static constexpr int N = 256;
    float table_[N];
    float phase_ = 0.f;
    float freq_ = 220.f;
    float sr_ = 48000.f;
public:
    GammaWavetableOsc() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        // Sine fallback so the osc produces sound out of the box.
        for (int i = 0; i < N; i++) table_[i] = std::sin(2.f * 3.14159265f * i / N);
    }
    void setFreq(float f) { freq_ = f; }
    void setShape(float s) {
        const int sh = (int)s;
        for (int i = 0; i < N; i++) {
            const float t = (float)i / N;
            switch (sh) {
                case 0: table_[i] = std::sin(2.f * 3.14159265f * t);                 break; // sine
                case 1: table_[i] = 2.f * t - 1.f;                                   break; // saw
                case 2: table_[i] = (t < 0.5f) ? 1.f : -1.f;                          break; // square
                case 3: table_[i] = (t < 0.5f) ? (4.f*t - 1.f) : (3.f - 4.f*t);       break; // triangle
                case 4: table_[i] = (t < 0.5f) ? std::sin(2.f * 3.14159265f * t) : 0.f; break; // halfSine
                case 5: { unsigned r = (unsigned)i * 1664525u + 1013904223u;
                          table_[i] = ((float)((r >> 8) & 0xFFFFu) / 32768.f - 1.f); break; } // noise
                case 6: table_[i] = std::sin(2.f * 3.14159265f * t)
                                  - 0.5f * std::sin(4.f * 3.14159265f * t);          break; // hollow
                case 7: table_[i] = (t < 0.05f || t > 0.95f) ? 1.f : 0.f;            break; // spike
                default: table_[i] = std::sin(2.f * 3.14159265f * t);
            }
        }
    }
    void setTable(const float* src, int n) {
        if (n > N) n = N;
        for (int i = 0; i < n; i++) table_[i] = src[i];
    }
    void reset() { phase_ = 0.f; }
    float operator()() {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= (int)phase_;
        if (phase_ < 0.f)  phase_ += 1.f - (int)phase_;
        const float fi = phase_ * N;
        const int   i0 = (int)fi;
        const int   i1 = i0 < N - 1 ? i0 + 1 : 0;
        const float t  = fi - i0;
        return table_[i0] * (1.f - t) + table_[i1] * t;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { freq: 220, shape: "sine" },
    methods: { freq: "setFreq", shape: "setShape" },
    paramOptions: { shape: ["sine", "saw", "square", "triangle", "halfSine", "noise", "hollow", "spike", "custom"] },
    enumMap:      { shape: { sine: "0", saw: "1", square: "2", triangle: "3", halfSine: "4", noise: "5", hollow: "6", spike: "7", custom: "8" } },
    gateMethods: { trig: "reset" },
    uiOnlyParams: ["table"],
    kind: "wavetable",
    extraHeaders: ["<cmath>"],
    extraCtor: [
      // Custom mode emits a static constexpr float array + setTable
      // call. Pattern matches Ramp/Button's curve LUT — wrapped in
      // braces so multiple instances don't collide on the array name.
      (n) => {
        if (!n.params || n.params.shape !== "custom") return null;
        const tbl = n.params.table;
        if (!Array.isArray(tbl) || tbl.length === 0) return null;
        const N = Math.min(tbl.length, 256);
        const vals = tbl.slice(0, N).map(v => {
          const f = Number(v);
          return (isFinite(f) ? f : 0).toFixed(5) + "f";
        }).join(", ");
        return [
          "        {",
          `            static constexpr float ${n.id}_wt[] = { ${vals} };`,
          `            ${n.id}.setTable(${n.id}_wt, ${N});`,
          "        }"
        ].join("\n");
      }
    ],
    description: "Wavetable oscillator — single-cycle 256-sample table, linearly interpolated. Pick a shape preset (sine / saw / square / triangle / halfSine / noise / hollow / spike) or `custom` to draw your own waveform. Wire trig to reset phase."
  },

  /* WavetableScan — 512-frame stacked-wavetable synth (Serum / Vital
   * style). Each frame is a 256-sample single-cycle waveform; the
   * `position` param 0..1 scrubs through the bank with linear
   * interpolation between adjacent frames (so morphing is smooth, not
   * stepped). Frames are generated algorithmically at construction
   * via setBank() — emitting all 131072 floats as constexpr would
   * bloat the source by ~1MB per instance, so the bank algorithms
   * live in C++ and run at startup. Custom per-frame edits are stored
   * as a sparse map (params.customFrames = { idx: [256 floats], ... })
   * and emitted as additional setFrame calls AFTER the bank fill.
   *
   * 6 bank presets: sineToSaw / harmonicWalk / formantScan / sineFold
   * / sineToTri / morphPair. The visual modal shows all 512 frames
   * in a pseudo-3D stacked view with a scrubable position cursor;
   * clicking a frame opens the per-frame drawable editor. */
  WavetableScan: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaWavetableScan",
    helperClass:
`class GammaWavetableScan {
    static constexpr int N_FRAMES  = 512;
    static constexpr int N_SAMPLES = 256;
    float frames_[N_FRAMES][N_SAMPLES];
    float phase_ = 0.f;
    float freq_ = 220.f;
    float position_ = 0.f;
    float sr_ = 48000.f;
public:
    GammaWavetableScan() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        setBank(0.f);
    }
    void setFreq(float f) { freq_ = f; }
    void setPosition(float p) {
        if (p < 0.f) p = 0.f;
        if (p > 1.f) p = 1.f;
        position_ = p;
    }
    void setBank(float b) {
        const int bank = (int)b;
        constexpr float TWO_PI = 6.28318530718f;
        for (int f = 0; f < N_FRAMES; f++) {
            const float t = (float)f / (float)(N_FRAMES - 1);
            for (int i = 0; i < N_SAMPLES; i++) {
                const float p = (float)i / (float)N_SAMPLES;
                float v = 0.f;
                switch (bank) {
                    case 0: { // sine -> saw
                        const float s = std::sin(TWO_PI * p);
                        const float saw = 2.f * p - 1.f;
                        v = s * (1.f - t) + saw * t;
                    } break;
                    case 1: { // harmonic walk — partials emerge progressively
                        const int maxH = 1 + (int)(t * 16.f);
                        for (int h = 1; h <= maxH; h++) v += std::sin(TWO_PI * p * h) / (float)h;
                        v *= 0.6f;
                    } break;
                    case 2: { // formant scan — phase shift + amplitude window
                        const float shift = t * 0.5f;
                        float p2 = p + shift; if (p2 >= 1.f) p2 -= 1.f;
                        v = std::sin(TWO_PI * p2) * (1.f - 0.5f * std::cos(TWO_PI * p));
                    } break;
                    case 3: { // sine -> hard-clipped (fold)
                        const float s = std::sin(TWO_PI * p);
                        const float clipped = s * (1.f + t * 4.f);
                        v = clipped > 1.f ? 1.f : (clipped < -1.f ? -1.f : clipped);
                    } break;
                    case 4: { // sine -> triangle
                        const float s = std::sin(TWO_PI * p);
                        const float tri = (p < 0.5f) ? (4.f * p - 1.f) : (3.f - 4.f * p);
                        v = s * (1.f - t) + tri * t;
                    } break;
                    case 5: { // morph pair — sine + 3rd harmonic phase shift
                        const float a = std::sin(TWO_PI * p);
                        const float ph = TWO_PI * t;
                        const float bb = std::sin(TWO_PI * 3.f * p + ph) * 0.5f;
                        v = a * (1.f - t * 0.7f) + bb * t * 0.7f;
                    } break;
                }
                frames_[f][i] = v;
            }
        }
    }
    void setFrame(int idx, const float* src, int n) {
        if (idx < 0 || idx >= N_FRAMES) return;
        if (n > N_SAMPLES) n = N_SAMPLES;
        for (int i = 0; i < n; i++) frames_[idx][i] = src[i];
    }
    void reset() { phase_ = 0.f; }
    float operator()() {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= (int)phase_;
        if (phase_ < 0.f)  phase_ += 1.f - (int)phase_;
        const float fp = position_ * (float)(N_FRAMES - 1);
        const int   f0 = (int)fp;
        const int   f1 = f0 < N_FRAMES - 1 ? f0 + 1 : f0;
        const float ft = fp - f0;
        const float si = phase_ * (float)N_SAMPLES;
        const int   s0 = (int)si;
        const int   s1 = s0 < N_SAMPLES - 1 ? s0 + 1 : 0;
        const float st = si - s0;
        const float a0 = frames_[f0][s0] * (1.f - st) + frames_[f0][s1] * st;
        const float a1 = frames_[f1][s0] * (1.f - st) + frames_[f1][s1] * st;
        return a0 * (1.f - ft) + a1 * ft;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" },
      { n: "position", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { freq: 220, position: 0.0, bank: "sineToSaw", customFrames: {} },
    methods: { freq: "setFreq", position: "setPosition", bank: "setBank" },
    paramOptions: { bank: ["sineToSaw", "harmonicWalk", "formantScan", "sineFold", "sineToTri", "morphPair"] },
    enumMap:      { bank: { sineToSaw: "0", harmonicWalk: "1", formantScan: "2", sineFold: "3", sineToTri: "4", morphPair: "5" } },
    gateMethods: { trig: "reset" },
    autoExpose: ["position"],
    // `bank` is uiOnly so the codegen's auto-setter pass skips it —
    // we emit setBank manually in extraCtor BEFORE the per-frame
    // overrides (otherwise setBank would overwrite our customs since
    // it fills all 512 frames). The props-pane dropdown still works
    // because it keys off paramOptions, not the uiOnly flag.
    uiOnlyParams: ["customFrames", "bank"],
    kind: "wavetableScan",
    extraHeaders: ["<cmath>"],
    extraCtor: [
      // Step 1: setBank() — initialize all 512 frames from the chosen
      // algorithm. Map the bank enum string to its int via enumMap.
      (n) => {
        const bank = (n.params && typeof n.params.bank === "string") ? n.params.bank : "sineToSaw";
        const map = { sineToSaw: 0, harmonicWalk: 1, formantScan: 2, sineFold: 3, sineToTri: 4, morphPair: 5 };
        const ix = map[bank] !== undefined ? map[bank] : 0;
        return `        ${n.id}.setBank(${ix}.f);`;
      },
      // Step 2: per-frame overrides as static constexpr float arrays.
      // Sparse map so unedited frames stay algorithmic. Each frame
      // emits ~256 floats × ~9 chars = ~2KB of source, but only for
      // user-touched frames — most banks emit zero of these.
      (n) => {
        const cf = (n.params && n.params.customFrames && typeof n.params.customFrames === "object") ? n.params.customFrames : {};
        const keys = Object.keys(cf).filter(k => Array.isArray(cf[k]) && cf[k].length > 0);
        if (!keys.length) return null;
        const lines = [];
        keys.forEach(k => {
          const idx = parseInt(k, 10);
          if (!isFinite(idx) || idx < 0 || idx >= 512) return;
          const tbl = cf[k];
          const N = Math.min(tbl.length, 256);
          const vals = tbl.slice(0, N).map(v => {
            const f = Number(v);
            return (isFinite(f) ? f : 0).toFixed(5) + "f";
          }).join(", ");
          lines.push("        {");
          lines.push(`            static constexpr float ${n.id}_f${idx}[] = { ${vals} };`);
          lines.push(`            ${n.id}.setFrame(${idx}, ${n.id}_f${idx}, ${N});`);
          lines.push("        }");
        });
        return lines.length ? lines.join("\n") : null;
      }
    ],
    description: "512-frame scannable wavetable synth (Serum/Vital style). Pick a bank preset (algorithmic) or override individual frames via the 3D editor. position 0..1 scrubs through frames with linear interpolation. Wire LFO into position for classic wavetable sweeps."
  },

  /* Pulse-Width-Modulated square. width = 0.5 is a 50% duty square;
   * 0.0..1.0 sweeps the pulse width. Wire an LFO into `width` for
   * classic PWM motion. Naive (aliasing above ~3kHz at 48k SR);
   * stack an anti-aliasing lowpass downstream for clean tone. */
  PulsePWM: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaPulsePWM",
    helperClass:
`class GammaPulsePWM {
    float phase_ = 0.f;
    float freq_ = 220.f;
    float width_ = 0.5f;
    float sr_ = 48000.f;
public:
    GammaPulsePWM() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFreq(float f) { freq_ = f; }
    void setWidth(float w) { width_ = w; }
    void reset() { phase_ = 0.f; }
    float operator()() {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= (int)phase_;
        if (phase_ < 0.f)  phase_ += 1.f - (int)phase_;
        const float w = width_ < 0.01f ? 0.01f : (width_ > 0.99f ? 0.99f : width_);
        return phase_ < w ? 1.f : -1.f;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" },
      { n: "width", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { freq: 220, width: 0.5 },
    methods: { freq: "setFreq", width: "setWidth" },
    gateMethods: { trig: "reset" },
    description: "Pulse-Width-Modulated square. width 0..1 sets duty cycle (0.5 = symmetric). Wire LFO into width for PWM. Naive (aliases above ~3kHz at 48k); follow with a lowpass for clean tone."
  },

  /* Supersaw — 7 detuned saws summed. Classic JP-8000 "Roland trance"
   * sound. detune controls the spread (0 = unison, 1 = wide); mix
   * blends the 6 side voices vs the center voice (0 = pure center,
   * 1 = pure sides). The default mix=0.7 gives the characteristic
   * "shimmery" supersaw timbre. */
  Supersaw: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaSupersaw",
    helperClass:
`class GammaSupersaw {
    static constexpr int N = 7;
    float phase_[N] = { 0.f, 0.13f, 0.27f, 0.41f, 0.59f, 0.71f, 0.83f };
    float freq_ = 220.f;
    float detune_ = 0.3f;
    float mix_ = 0.7f;
    float sr_ = 48000.f;
public:
    GammaSupersaw() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFreq(float f) { freq_ = f; }
    void setDetune(float d) { detune_ = d; }
    void setMix(float m) { mix_ = m; }
    void reset() { for (int i = 0; i < N; i++) phase_[i] = (float)i * 0.137f; }
    float operator()() {
        // Voice freq ratios — center + 3 above + 3 below, in cents.
        // Curve from Adam Szabo's "How to Emulate the Super Saw".
        static constexpr float ratios[N] = {
            1.f, 1.0079f, 1.0158f, 1.0237f, 0.9921f, 0.9844f, 0.9766f
        };
        float out = 0.f;
        for (int i = 0; i < N; i++) {
            const float r = 1.f + (ratios[i] - 1.f) * detune_;
            phase_[i] += (freq_ * r) / sr_;
            if (phase_[i] >= 1.f) phase_[i] -= (int)phase_[i];
            if (phase_[i] < 0.f)  phase_[i] += 1.f - (int)phase_[i];
            const float saw = 2.f * phase_[i] - 1.f;
            const float w = (i == 0) ? (1.f - mix_) : (mix_ / 6.f);
            out += saw * w;
        }
        return out;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" },
      { n: "detune", t: "param" },
      { n: "mix",  t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { freq: 220, detune: 0.3, mix: 0.7 },
    methods: { freq: "setFreq", detune: "setDetune", mix: "setMix" },
    gateMethods: { trig: "reset" },
    description: "Supersaw — 7 detuned saws summed (JP-8000 style). detune sets spread (0..1); mix blends side voices vs center (0=center, 1=sides). Iconic '90s trance / EDM lead sound."
  },

  /* 2-operator FM — carrier sine modulated by a second sine. ratio
   * sets modulator-to-carrier freq ratio (1.0 = same; 2.0 = octave
   * up; 0.5 = octave down; non-integer = inharmonic / metallic).
   * index controls modulation depth in radians (0..10 typical). */
  FMOp: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaFMOp",
    helperClass:
`class GammaFMOp {
    float pCar_ = 0.f, pMod_ = 0.f;
    float freq_ = 220.f, ratio_ = 1.f, index_ = 1.f;
    float sr_ = 48000.f;
public:
    GammaFMOp() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFreq(float f) { freq_ = f; }
    void setRatio(float r) { ratio_ = r; }
    void setIndex(float i) { index_ = i; }
    void reset() { pCar_ = 0.f; pMod_ = 0.f; }
    float operator()() {
        pMod_ += (freq_ * ratio_) / sr_;
        if (pMod_ >= 1.f) pMod_ -= (int)pMod_;
        if (pMod_ < 0.f)  pMod_ += 1.f - (int)pMod_;
        const float mod = std::sin(2.f * 3.14159265f * pMod_) * index_;
        pCar_ += freq_ / sr_;
        if (pCar_ >= 1.f) pCar_ -= (int)pCar_;
        if (pCar_ < 0.f)  pCar_ += 1.f - (int)pCar_;
        return std::sin(2.f * 3.14159265f * pCar_ + mod);
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" },
      { n: "ratio", t: "param" },
      { n: "index", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { freq: 220, ratio: 1.0, index: 1.0 },
    methods: { freq: "setFreq", ratio: "setRatio", index: "setIndex" },
    gateMethods: { trig: "reset" },
    extraHeaders: ["<cmath>"],
    description: "2-op FM — carrier sine + modulator sine. ratio = modulator/carrier freq (integers = harmonic; non-integers = bell/metallic). index = modulation depth (0..10). DX-style timbres without the 6-op complexity."
  },

  /* FM4 — 4-operator FM with selectable algorithm. Each operator
   * has its own freq ratio + output level (0..1). The `algo` param
   * picks how the four ops are connected; we ship four
   * representative algorithms covering the breadth of DX-style
   * topologies without the full 32-algorithm DX7 complexity:
   *
   *   serial   — 1→2→3→4 → out (single carrier, deepest cascade,
   *              most spectral content)
   *   parallel — (1→2) + (3→4) → out (two parallel pairs, two
   *              independent timbres summed)
   *   stack    — 1→4, 2→4, 3→4 → out (three modulators on a
   *              single carrier, "stacked" mod density)
   *   additive — 1+2+3+4 → out (no modulation, all carriers, sum
   *              of sines — useful for additive synthesis voices)
   *
   * Phase accumulators are normalized (0..1) per op. Output is
   * the carrier (or carrier sum) clipped to [-1, 1] for safety. */
  FM4: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaFM4",
    extraHeaders: ["<cmath>"],
    helperClass:
`class GammaFM4 {
    static constexpr float TAU = 6.2831853f;
    float p1=0, p2=0, p3=0, p4=0;
    float freq_  = 220.f;
    float r1=1.f, r2=1.f, r3=1.f, r4=1.f;
    float l1=1.f, l2=1.f, l3=1.f, l4=1.f;
    int   algo_ = 0;
    float sr_   = 48000.f;
    static float adv_(float& p, float hz, float sr) {
        p += hz / sr;
        if (p >= 1.f) p -= (int)p;
        if (p < 0.f)  p += 1.f - (int)p;
        return p;
    }
public:
    GammaFM4() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFreq(float f)  { freq_ = f; }
    void setRatio1(float v){ r1 = v; }
    void setRatio2(float v){ r2 = v; }
    void setRatio3(float v){ r3 = v; }
    void setRatio4(float v){ r4 = v; }
    void setLevel1(float v){ l1 = v; }
    void setLevel2(float v){ l2 = v; }
    void setLevel3(float v){ l3 = v; }
    void setLevel4(float v){ l4 = v; }
    void setAlgo(float a)  { algo_ = (int)a; }
    void reset()           { p1=p2=p3=p4=0; }
    float operator()() {
        const float ph1 = adv_(p1, freq_ * r1, sr_);
        const float ph2 = adv_(p2, freq_ * r2, sr_);
        const float ph3 = adv_(p3, freq_ * r3, sr_);
        const float ph4 = adv_(p4, freq_ * r4, sr_);
        float out = 0.f;
        switch (algo_) {
            case 0: { // serial 1→2→3→4
                const float o1 = std::sin(TAU * ph1) * l1;
                const float o2 = std::sin(TAU * ph2 + o1) * l2;
                const float o3 = std::sin(TAU * ph3 + o2) * l3;
                out = std::sin(TAU * ph4 + o3) * l4;
                break;
            }
            case 1: { // parallel pairs (1→2) + (3→4)
                const float o1 = std::sin(TAU * ph1) * l1;
                const float o2 = std::sin(TAU * ph2 + o1) * l2;
                const float o3 = std::sin(TAU * ph3) * l3;
                const float o4 = std::sin(TAU * ph4 + o3) * l4;
                out = (o2 + o4) * 0.5f;
                break;
            }
            case 2: { // stack — 3 modulators on 1 carrier
                const float o1 = std::sin(TAU * ph1) * l1;
                const float o2 = std::sin(TAU * ph2) * l2;
                const float o3 = std::sin(TAU * ph3) * l3;
                out = std::sin(TAU * ph4 + o1 + o2 + o3) * l4;
                break;
            }
            default: { // additive — sum of carriers
                const float o1 = std::sin(TAU * ph1) * l1;
                const float o2 = std::sin(TAU * ph2) * l2;
                const float o3 = std::sin(TAU * ph3) * l3;
                const float o4 = std::sin(TAU * ph4) * l4;
                out = (o1 + o2 + o3 + o4) * 0.25f;
                break;
            }
        }
        // Soft clip — FM at high indices can shoot well past unity.
        if (out >  1.f) out =  1.f;
        if (out < -1.f) out = -1.f;
        return out;
    }
};`,
    ins: [
      { n: "trig",   t: "gate" },
      { n: "freq",   t: "param" },
      { n: "algo",   t: "param" },
      { n: "ratio1", t: "param" },
      { n: "ratio2", t: "param" },
      { n: "ratio3", t: "param" },
      { n: "ratio4", t: "param" },
      { n: "level1", t: "param" },
      { n: "level2", t: "param" },
      { n: "level3", t: "param" },
      { n: "level4", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: {
      freq: 220, algo: "serial",
      ratio1: 1.0, ratio2: 2.0, ratio3: 3.0, ratio4: 1.0,
      level1: 1.0, level2: 0.6, level3: 0.4, level4: 1.0
    },
    methods: {
      freq: "setFreq", algo: "setAlgo",
      ratio1: "setRatio1", ratio2: "setRatio2", ratio3: "setRatio3", ratio4: "setRatio4",
      level1: "setLevel1", level2: "setLevel2", level3: "setLevel3", level4: "setLevel4"
    },
    paramOptions: { algo: ["serial", "parallel", "stack", "additive"] },
    enumMap:      { algo: { serial: "0", parallel: "1", stack: "2", additive: "3" } },
    gateMethods: { trig: "reset" },
    description: "4-operator FM. Each op has freq ratio + level. algo picks topology: serial (1→2→3→4), parallel (two pairs), stack (3 mods → 1 carrier), additive (4 carriers summed). DX-style timbres without DX7's 32-algorithm complexity."
  },

  /* Phase modulation oscillator — sine carrier whose phase is
   * modulated by an audio-rate input signal (typically another
   * oscillator's output). Wire any audio source into `pm`. depth
   * scales the modulation. PMOsc is what real DX synths use under
   * the hood (Yamaha called it FM but it's PM internally). */
  PMOsc: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaPMOsc",
    helperClass:
`class GammaPMOsc {
    float phase_ = 0.f;
    float freq_ = 220.f, depth_ = 1.f;
    float sr_ = 48000.f;
public:
    GammaPMOsc() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFreq(float f) { freq_ = f; }
    void setDepth(float d) { depth_ = d; }
    void reset() { phase_ = 0.f; }
    float operator()(float pm) {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= (int)phase_;
        if (phase_ < 0.f)  phase_ += 1.f - (int)phase_;
        return std::sin(2.f * 3.14159265f * phase_ + pm * depth_);
    }
};`,
    ins: [
      { n: "pm",   t: "audio" },
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" },
      { n: "depth", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { freq: 220, depth: 1.0 },
    methods: { freq: "setFreq", depth: "setDepth" },
    gateMethods: { trig: "reset" },
    extraHeaders: ["<cmath>"],
    description: "Phase modulation oscillator — sine carrier whose phase is modulated by the `pm` audio input. depth scales the modulation (0..10 typical). The PM building block for DX-style FM patches: chain two PMOscs to build a 2-op stack."
  },

  /* Self-feedback sine — Yamaha-style. The osc's own previous output
   * is fed back into its phase, scaled by `feedback` (0..2). At
   * feedback ≈ 1.5 the sine breaks down into noisy / sawtooth-like
   * output — used for percussion and noise effects on FM synths. */
  FBSine: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaFBSine",
    helperClass:
`class GammaFBSine {
    float phase_ = 0.f, last_ = 0.f;
    float freq_ = 220.f, fb_ = 0.f;
    float sr_ = 48000.f;
public:
    GammaFBSine() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFreq(float f) { freq_ = f; }
    void setFeedback(float f) { fb_ = f; }
    void reset() { phase_ = 0.f; last_ = 0.f; }
    float operator()() {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= (int)phase_;
        if (phase_ < 0.f)  phase_ += 1.f - (int)phase_;
        last_ = std::sin(2.f * 3.14159265f * phase_ + last_ * fb_);
        return last_;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" },
      { n: "feedback", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { freq: 220, feedback: 0.0 },
    methods: { freq: "setFreq", feedback: "setFeedback" },
    gateMethods: { trig: "reset" },
    extraHeaders: ["<cmath>"],
    description: "Self-feedback sine — output is fed back into phase. feedback 0..2; at ≈1.5 the sine breaks into saw-like noise (DX percussion trick). Standalone DX op approximation."
  },

  /* Phase distortion (Casio CZ-style) — warps the phase ramp through
   * a kink at `amount` before the sine lookup, producing harmonics
   * that sweep with `amount`. amount=0.5 ≈ pure sine; lower or higher
   * values bend the spectrum. The CZ-101's signature timbre. */
  PhaseDistortion: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaPhaseDistortion",
    helperClass:
`class GammaPhaseDistortion {
    float phase_ = 0.f;
    float freq_ = 220.f, amount_ = 0.5f;
    float sr_ = 48000.f;
public:
    GammaPhaseDistortion() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFreq(float f) { freq_ = f; }
    void setAmount(float a) { amount_ = a; }
    void reset() { phase_ = 0.f; }
    float operator()() {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= (int)phase_;
        if (phase_ < 0.f)  phase_ += 1.f - (int)phase_;
        const float a = amount_ < 0.05f ? 0.05f : (amount_ > 0.95f ? 0.95f : amount_);
        float p;
        if (phase_ < a) p = 0.5f * phase_ / a;
        else            p = 0.5f + 0.5f * (phase_ - a) / (1.f - a);
        return std::sin(2.f * 3.14159265f * p);
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" },
      { n: "amount", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { freq: 220, amount: 0.5 },
    methods: { freq: "setFreq", amount: "setAmount" },
    gateMethods: { trig: "reset" },
    extraHeaders: ["<cmath>"],
    description: "Phase-distortion oscillator (Casio CZ-style). `amount` warps the phase through a kink before the sine lookup — sweeping it produces harmonic motion. amount=0.5 ≈ pure sine."
  },

  /* Hard-sync oscillator pair — master saw runs at masterFreq, slave
   * saw runs at slaveFreq but is reset to phase 0 every time the
   * master phase wraps. Sweeping slaveFreq above masterFreq produces
   * the characteristic sync-sweep timbre (Cars, "Just What I Needed";
   * '80s synth-pop lead). */
  HardSync: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaHardSync",
    helperClass:
`class GammaHardSync {
    float phaseM_ = 0.f, phaseS_ = 0.f;
    float freqM_ = 110.f, freqS_ = 220.f;
    float sr_ = 48000.f;
public:
    GammaHardSync() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setMasterFreq(float f) { freqM_ = f; }
    void setSlaveFreq(float f)  { freqS_ = f; }
    void reset() { phaseM_ = 0.f; phaseS_ = 0.f; }
    float operator()() {
        phaseM_ += freqM_ / sr_;
        if (phaseM_ >= 1.f) {
            phaseM_ -= (int)phaseM_;
            phaseS_ = 0.f;  // hard-sync the slave on master wrap
        }
        if (phaseM_ < 0.f) phaseM_ += 1.f - (int)phaseM_;
        phaseS_ += freqS_ / sr_;
        if (phaseS_ >= 1.f) phaseS_ -= (int)phaseS_;
        if (phaseS_ < 0.f)  phaseS_ += 1.f - (int)phaseS_;
        return 2.f * phaseS_ - 1.f;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "master", t: "param" },
      { n: "slave",  t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { master: 110, slave: 220 },
    methods: { master: "setMasterFreq", slave: "setSlaveFreq" },
    gateMethods: { trig: "reset" },
    description: "Hard-sync oscillator pair. master sets pitch; slave generates harmonic content (sweep above master for sync-sweep). Iconic '80s synth-pop lead. Output is slave saw."
  },

  /* Karplus-Strong plucked-string synthesis. A delay line filled with
   * noise on `pluck`, with a 2-tap lowpass in the feedback loop for
   * natural decay. damping (0..1) controls how fast highs roll off
   * (1 = bright, 0 = dull/dead string). feedback (0..1) sets sustain
   * (1 = infinite, 0.99 = realistic decay). Wire trig into pluck for
   * note-on triggering. Length is driven by setFreq → buffer length. */
  KSString: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaKSString",
    helperClass:
`class GammaKSString {
    static constexpr int MAX_DELAY = 4096;
    float buf_[MAX_DELAY];
    int   len_ = 200;
    int   pos_ = 0;
    float damping_ = 0.5f;
    float feedback_ = 0.997f;
    float prev_ = 0.f;
    float sr_ = 48000.f;
    unsigned rng_ = 0x12345u;
public:
    GammaKSString() {
        for (int i = 0; i < MAX_DELAY; i++) buf_[i] = 0.f;
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        setFreq(220.f);
    }
    void setFreq(float f) {
        if (f < 1.f) f = 1.f;
        len_ = (int)(sr_ / f);
        if (len_ < 2) len_ = 2;
        if (len_ >= MAX_DELAY) len_ = MAX_DELAY - 1;
    }
    void setDamping(float d)  { damping_ = d; }
    void setFeedback(float f) { feedback_ = f; }
    void pluck() {
        for (int i = 0; i < len_; i++) {
            rng_ = rng_ * 1664525u + 1013904223u;
            buf_[i] = ((float)((rng_ >> 8) & 0xFFFFu) / 32768.f - 1.f);
        }
        prev_ = 0.f;
        pos_ = 0;
    }
    void reset() { for (int i = 0; i < MAX_DELAY; i++) buf_[i] = 0.f; prev_ = 0.f; pos_ = 0; }
    float operator()() {
        const float s = buf_[pos_];
        const float lp = 0.5f * (s + prev_);
        prev_ = s;
        const float filtered = damping_ * lp + (1.f - damping_) * s;
        buf_[pos_] = filtered * feedback_;
        pos_++;
        if (pos_ >= len_) pos_ = 0;
        return s;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" },
      { n: "damping",  t: "param" },
      { n: "feedback", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { freq: 220, damping: 0.5, feedback: 0.997 },
    methods: { freq: "setFreq", damping: "setDamping", feedback: "setFeedback" },
    gateMethods: { trig: "pluck" },
    description: "Karplus-Strong plucked string. trig fills the delay line with noise (the pluck); damping (0..1) sets brightness, feedback (0..1) sets sustain. freq drives the delay length (= pitch). Classic acoustic-guitar / harp / koto sound."
  },

  /* Additive oscillator — 8 sine partials with per-partial amplitude
   * + a partial mode (harmonic / odd-only / Shepard / inharmonic).
   * amp1..amp8 are the partial gains. Wire LFOs into them for
   * morphing additive timbres. The harmonic series default (1, 1/2,
   * 1/3, …, 1/8) gives a saw-like spectrum. */
  AdditiveOsc: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaAdditiveOsc",
    helperClass:
`class GammaAdditiveOsc {
    static constexpr int N = 8;
    float phase_[N] = {0,0,0,0,0,0,0,0};
    float amp_[N]   = {1.f, 0.5f, 0.333f, 0.25f, 0.2f, 0.166f, 0.143f, 0.125f};
    float ratio_[N] = {1.f, 2.f, 3.f, 4.f, 5.f, 6.f, 7.f, 8.f};
    float freq_ = 220.f;
    float sr_ = 48000.f;
public:
    GammaAdditiveOsc() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFreq(float f) { freq_ = f; }
    void setMode(float m) {
        const int mode = (int)m;
        for (int i = 0; i < N; i++) {
            switch (mode) {
                case 0: ratio_[i] = (float)(i + 1); break;             // harmonic 1,2,3,...
                case 1: ratio_[i] = (float)(2*i + 1); break;            // odd-only 1,3,5,...
                case 2: ratio_[i] = std::pow(2.f, (float)i / 2.f); break; // half-octave (Shepard-ish)
                case 3: ratio_[i] = (float)(i + 1) + 0.07f * (float)i;  break; // slightly inharmonic (bell-ish)
                default: ratio_[i] = (float)(i + 1);
            }
        }
    }
    void setAmp0(float a) { amp_[0] = a; }
    void setAmp1(float a) { amp_[1] = a; }
    void setAmp2(float a) { amp_[2] = a; }
    void setAmp3(float a) { amp_[3] = a; }
    void setAmp4(float a) { amp_[4] = a; }
    void setAmp5(float a) { amp_[5] = a; }
    void setAmp6(float a) { amp_[6] = a; }
    void setAmp7(float a) { amp_[7] = a; }
    void reset() { for (int i = 0; i < N; i++) phase_[i] = 0.f; }
    float operator()() {
        float out = 0.f;
        for (int i = 0; i < N; i++) {
            phase_[i] += (freq_ * ratio_[i]) / sr_;
            if (phase_[i] >= 1.f) phase_[i] -= (int)phase_[i];
            if (phase_[i] < 0.f)  phase_[i] += 1.f - (int)phase_[i];
            out += std::sin(2.f * 3.14159265f * phase_[i]) * amp_[i];
        }
        return out;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq", t: "param" },
      { n: "amp1", t: "param" }, { n: "amp2", t: "param" },
      { n: "amp3", t: "param" }, { n: "amp4", t: "param" },
      { n: "amp5", t: "param" }, { n: "amp6", t: "param" },
      { n: "amp7", t: "param" }, { n: "amp8", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: {
      freq: 220, mode: "harmonic",
      amp1: 1.0,  amp2: 0.5,  amp3: 0.333, amp4: 0.25,
      amp5: 0.2,  amp6: 0.166, amp7: 0.143, amp8: 0.125
    },
    methods: {
      freq: "setFreq", mode: "setMode",
      amp1: "setAmp0", amp2: "setAmp1", amp3: "setAmp2", amp4: "setAmp3",
      amp5: "setAmp4", amp6: "setAmp5", amp7: "setAmp6", amp8: "setAmp7"
    },
    paramOptions: { mode: ["harmonic", "odd", "shepard", "inharmonic"] },
    enumMap:      { mode: { harmonic: "0", odd: "1", shepard: "2", inharmonic: "3" } },
    gateMethods: { trig: "reset" },
    extraHeaders: ["<cmath>"],
    description: "Additive oscillator — 8 sine partials with per-partial amplitude. mode picks the partial-frequency series (harmonic 1,2,3..; odd 1,3,5..; shepard half-octave; inharmonic bell). Modulate amp1..amp8 with LFOs for morphing timbres."
  },

  /* Wavefolder (Buchla-style) — reflects the input back into [-t, t]
   * when out of range, producing harmonic-rich folded sound. Pair
   * with an oscillator + amplitude envelope for evolving timbres
   * (Buchla "Easel" patches). threshold sets the fold point. */
  Foldback: {
    category: "Effect", color: COLOR.effect, header: null,
    cppType: "GammaFoldback",
    helperClass:
`class GammaFoldback {
    float threshold_ = 1.f;
public:
    void setThreshold(float t) { threshold_ = (t < 0.001f) ? 0.001f : t; }
    float operator()(float in) {
        float x = in;
        const float t = threshold_;
        // Clamp iterations to prevent infinite loops on huge inputs.
        for (int i = 0; i < 16; i++) {
            if (x > t)       x = 2.f * t - x;
            else if (x < -t) x = -2.f * t - x;
            else break;
        }
        return x;
    }
};`,
    ins: [
      { n: "in", t: "audio" },
      { n: "threshold", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { threshold: 1.0 },
    methods: { threshold: "setThreshold" },
    description: "Wavefolder (Buchla-style). Reflects input back into [-threshold, threshold] when it exceeds — producing harmonic-rich folded sound. Drive an oscillator hot into a Foldback for evolving timbres. Pair with envelope-modulated input gain for the classic Easel sound."
  },

  /* Multi-phasor — sum of 4 free-running phasors at user-set frequency
   * ratios (not necessarily harmonic). Outputs the summed phase ramps
   * (0..1 each). Useful as a multi-rate phase source for shaping
   * other oscillators (chain into PMOsc.pm or PhaseDistortion.amount
   * for polyrhythmic modulation). */
  MultiPhasorOsc: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaMultiPhasor",
    helperClass:
`class GammaMultiPhasor {
    float phase_[4] = {0.f, 0.f, 0.f, 0.f};
    float ratio_[4] = {1.f, 2.f, 3.f, 5.f};
    float freq_ = 1.f;
    float sr_ = 48000.f;
public:
    GammaMultiPhasor() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFreq(float f)   { freq_ = f; }
    void setRatio0(float r) { ratio_[0] = r; }
    void setRatio1(float r) { ratio_[1] = r; }
    void setRatio2(float r) { ratio_[2] = r; }
    void setRatio3(float r) { ratio_[3] = r; }
    void reset() { for (int i = 0; i < 4; i++) phase_[i] = 0.f; }
    struct Out { float p1, p2, p3, p4, sum; };
    Out operator()() {
        Out o;
        for (int i = 0; i < 4; i++) {
            phase_[i] += (freq_ * ratio_[i]) / sr_;
            if (phase_[i] >= 1.f) phase_[i] -= (int)phase_[i];
            if (phase_[i] < 0.f)  phase_[i] += 1.f - (int)phase_[i];
        }
        o.p1 = phase_[0]; o.p2 = phase_[1]; o.p3 = phase_[2]; o.p4 = phase_[3];
        o.sum = 0.25f * (phase_[0] + phase_[1] + phase_[2] + phase_[3]);
        return o;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "freq",   t: "param" },
      { n: "ratio1", t: "param" }, { n: "ratio2", t: "param" },
      { n: "ratio3", t: "param" }, { n: "ratio4", t: "param" }
    ],
    outs: [
      { n: "p1",  t: "audio", access: ".p1"  },
      { n: "p2",  t: "audio", access: ".p2"  },
      { n: "p3",  t: "audio", access: ".p3"  },
      { n: "p4",  t: "audio", access: ".p4"  },
      { n: "sum", t: "audio", access: ".sum" }
    ],
    params: { freq: 1.0, ratio1: 1.0, ratio2: 2.0, ratio3: 3.0, ratio4: 5.0 },
    methods: {
      freq: "setFreq",
      ratio1: "setRatio0", ratio2: "setRatio1",
      ratio3: "setRatio2", ratio4: "setRatio3"
    },
    gateMethods: { trig: "reset" },
    description: "Multi-phasor — 4 free-running phasors at independent frequency ratios. Outputs each ramp (p1..p4, all 0..1) plus their average (sum). Useful as a multi-rate phase source for cross-modulation (PMOsc / PhaseDistortion) or polyrhythmic LFO clusters."
  },

  /* ============================================================
   * Sample / mic / live-audio nodes. Sample-based nodes (mono /
   * stereo / granular players) reference audio data via an
   * `assetId` stored on the node — actual Float32Arrays live in
   * the editor's asset registry, persisted to IndexedDB. The
   * codegen embeds samples up to ASSET_EMBED_LIMIT samples (~5.3s
   * at 48kHz mono) directly; bigger samples emit a TODO + meta
   * comment + setSampleRate call so users wire up runtime sample
   * loading externally for full musical stems.
   * ============================================================ */

  /* Mono sample player. Wire trig into trig to retrigger from start;
   * loop=1 wraps back to start at end. pitch=1 plays at correct pitch
   * (resamples for source SR ≠ engine SR). start/end are seconds. */
  SamplePlayer: {
    category: "Oscillator", color: COLOR.sample, header: null,
    cppType: "GammaSamplePlayer",
    helperClass:
`class GammaSamplePlayer {
    /* BPM stretching: when bpmSync_ is on AND a non-zero incoming
     * bpm is wired in (typically from MasterClock.bpm), the pitch
     * advance is scaled by stretch_ = incomingBpm_ / naturalBpm_.
     * naturalBpm_ is the user's annotation of "what BPM was the
     * sample recorded at" — the editor doesn't auto-detect.
     * Without a wire to bpm (or with bpmSync_ off), stretch_ stays
     * at 1.0 and the player behaves exactly like before. */
    std::vector<float> buf_;
    int    nSamples_ = 0;
    double pos_ = 0.0;
    float  pitch_ = 1.f;
    float  startSec_ = 0.f;
    float  endSec_ = 1e9f;
    bool   loop_ = false;
    bool   playing_ = false;
    float  gain_ = 1.f;
    float  dcOffset_ = 0.f;
    float  incomingBpm_ = 0.f;
    float  naturalBpm_ = 120.f;
    bool   bpmSync_ = false;
    float  stretch_ = 1.f;
    float  sr_ = 48000.f;
    float  sourceSr_ = 48000.f;
    void recalcStretch_() {
        stretch_ = (bpmSync_ && incomingBpm_ > 0.f && naturalBpm_ > 0.f)
            ? (incomingBpm_ / naturalBpm_) : 1.f;
    }
public:
    GammaSamplePlayer() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setSampleRate(float sr) { sourceSr_ = sr; }
    void load(const float* src, int n) {
        buf_.assign(src, src + n);
        nSamples_ = n;
    }
    void setPitch(float p)        { pitch_ = p; }
    void setStart(float s)        { startSec_ = s; }
    void setEnd(float e)          { endSec_   = e < 0.f ? 1e9f : e; }
    void setLoop(float l)         { loop_     = l > 0.5f; }
    void setGain(float g)         { gain_ = g; }
    void setDcOffset(float d)     { dcOffset_ = d; }
    void setBpm(float v)          { incomingBpm_ = v; recalcStretch_(); }
    void setNaturalBpm(float v)   { naturalBpm_ = v;  recalcStretch_(); }
    void setBpmSync(float v)      { bpmSync_ = v > 0.5f; recalcStretch_(); }
    void play()  { pos_ = (double)startSec_ * (double)sourceSr_; playing_ = true; }
    void stop()  { playing_ = false; }
    void reset() { pos_ = (double)startSec_ * (double)sourceSr_; }
    float operator()() {
        if (!playing_ || nSamples_ < 2) return 0.f;
        const double endSamp = (double)endSec_ * (double)sourceSr_;
        const double cap = (double)(nSamples_ - 1);
        const double endLim = endSamp < cap ? endSamp : cap;
        if (pos_ >= endLim) {
            if (loop_) pos_ = (double)startSec_ * (double)sourceSr_;
            else { playing_ = false; return 0.f; }
        }
        const int i0 = (int)pos_;
        if (i0 < 0 || i0 >= nSamples_ - 1) return 0.f;
        const float t = (float)(pos_ - i0);
        const float v = buf_[i0] * (1.f - t) + buf_[i0 + 1] * t;
        pos_ += (double)pitch_ * (double)stretch_ * ((double)sourceSr_ / (double)sr_);
        return v * gain_ - dcOffset_;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "pitch", t: "param" },
      { n: "start", t: "param" },
      { n: "end",   t: "param" },
      { n: "loop",  t: "param" },
      { n: "gain",     t: "param" },
      { n: "dcOffset", t: "param" },
      { n: "bpm",        t: "param" },
      { n: "naturalBpm", t: "param" },
      { n: "bpmSync",    t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { assetId: "", pitch: 1.0, start: 0.0, end: -1.0, loop: 0, gain: 1.0, dcOffset: 0.0, naturalBpm: 120, bpmSync: 0 },
    methods: { pitch: "setPitch", start: "setStart", end: "setEnd", loop: "setLoop", gain: "setGain", dcOffset: "setDcOffset", bpm: "setBpm", naturalBpm: "setNaturalBpm", bpmSync: "setBpmSync" },
    gateMethods: { trig: "play" },
    autoExpose: ["pitch", "start", "end", "loop"],
    uiOnlyParams: ["assetId"],
    kind: "sampleHost",
    extraHeaders: ["<vector>"],
    extraCtor: [
      (n) => emitAssetLoadCpp(n, 0, "load", "setSampleRate")
    ],
    description: "Mono sample player. Drop a .wav onto the props pane to load (any SR; resampled at runtime). trig retriggers from `start`; loop=1 wraps to start at end. pitch=1 plays at correct pitch."
  },

  /* Stereo variant — two channel buffers (L/R), two outputs. Same
   * controls otherwise. Mono files duplicate to both channels on load. */
  StereoSamplePlayer: {
    category: "Oscillator", color: COLOR.sample, header: null,
    cppType: "GammaStereoSamplePlayer",
    helperClass:
`class GammaStereoSamplePlayer {
    /* See GammaSamplePlayer above for the bpm-stretch design. */
    std::vector<float> bufL_, bufR_;
    int    nSamples_ = 0;
    double pos_ = 0.0;
    float  pitch_ = 1.f;
    float  startSec_ = 0.f;
    float  endSec_ = 1e9f;
    bool   loop_ = false;
    bool   playing_ = false;
    float  gain_ = 1.f;
    float  dcOffset_ = 0.f;
    float  incomingBpm_ = 0.f;
    float  naturalBpm_ = 120.f;
    bool   bpmSync_ = false;
    float  stretch_ = 1.f;
    float  sr_ = 48000.f;
    float  sourceSr_ = 48000.f;
    void recalcStretch_() {
        stretch_ = (bpmSync_ && incomingBpm_ > 0.f && naturalBpm_ > 0.f)
            ? (incomingBpm_ / naturalBpm_) : 1.f;
    }
public:
    GammaStereoSamplePlayer() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setSampleRate(float sr) { sourceSr_ = sr; }
    void loadL(const float* src, int n) { bufL_.assign(src, src + n); nSamples_ = n; }
    void loadR(const float* src, int n) { bufR_.assign(src, src + n); if (n > nSamples_) nSamples_ = n; }
    void setPitch(float p)        { pitch_ = p; }
    void setStart(float s)        { startSec_ = s; }
    void setEnd(float e)          { endSec_   = e < 0.f ? 1e9f : e; }
    void setLoop(float l)         { loop_     = l > 0.5f; }
    void setGain(float g)         { gain_ = g; }
    void setDcOffset(float d)     { dcOffset_ = d; }
    void setBpm(float v)          { incomingBpm_ = v; recalcStretch_(); }
    void setNaturalBpm(float v)   { naturalBpm_ = v;  recalcStretch_(); }
    void setBpmSync(float v)      { bpmSync_ = v > 0.5f; recalcStretch_(); }
    void play()  { pos_ = (double)startSec_ * (double)sourceSr_; playing_ = true; }
    void stop()  { playing_ = false; }
    void reset() { pos_ = (double)startSec_ * (double)sourceSr_; }
    struct Out { float l, r; };
    Out operator()() {
        Out o = { 0.f, 0.f };
        if (!playing_ || nSamples_ < 2) return o;
        const double endSamp = (double)endSec_ * (double)sourceSr_;
        const double cap = (double)(nSamples_ - 1);
        const double endLim = endSamp < cap ? endSamp : cap;
        if (pos_ >= endLim) {
            if (loop_) pos_ = (double)startSec_ * (double)sourceSr_;
            else { playing_ = false; return o; }
        }
        const int i0 = (int)pos_;
        if (i0 < 0 || i0 >= nSamples_ - 1) return o;
        const float t = (float)(pos_ - i0);
        if (i0 + 1 < (int)bufL_.size()) o.l = bufL_[i0] * (1.f - t) + bufL_[i0 + 1] * t;
        if (i0 + 1 < (int)bufR_.size()) o.r = bufR_[i0] * (1.f - t) + bufR_[i0 + 1] * t;
        else                            o.r = o.l;
        pos_ += (double)pitch_ * (double)stretch_ * ((double)sourceSr_ / (double)sr_);
        o.l = o.l * gain_ - dcOffset_;
        o.r = o.r * gain_ - dcOffset_;
        return o;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "pitch", t: "param" },
      { n: "start", t: "param" },
      { n: "end",   t: "param" },
      { n: "loop",  t: "param" },
      { n: "gain",     t: "param" },
      { n: "dcOffset", t: "param" },
      { n: "bpm",        t: "param" },
      { n: "naturalBpm", t: "param" },
      { n: "bpmSync",    t: "param" }
    ],
    outs: [
      { n: "L", t: "audio", access: ".l" },
      { n: "R", t: "audio", access: ".r" }
    ],
    params: { assetId: "", pitch: 1.0, start: 0.0, end: -1.0, loop: 0, gain: 1.0, dcOffset: 0.0, naturalBpm: 120, bpmSync: 0 },
    methods: { pitch: "setPitch", start: "setStart", end: "setEnd", loop: "setLoop", gain: "setGain", dcOffset: "setDcOffset", bpm: "setBpm", naturalBpm: "setNaturalBpm", bpmSync: "setBpmSync" },
    gateMethods: { trig: "play" },
    autoExpose: ["pitch", "start", "end", "loop"],
    uiOnlyParams: ["assetId"],
    kind: "sampleHost",
    extraHeaders: ["<vector>"],
    extraCtor: [
      // Mono asset: duplicate the L data into R via loadR. Stereo
      // asset: emit both channels' data separately.
      (n) => {
        const a = getAsset(n.params && n.params.assetId);
        if (!a) return `        // ${n.id}: no sample loaded`;
        const lLines = emitAssetLoadCpp(n, 0, "loadL", "setSampleRate");
        if (a.channels >= 2) {
          // emitAssetLoadCpp's setSampleRate is idempotent; cheap to repeat.
          const rLines = emitAssetLoadCpp(n, 1, "loadR", "setSampleRate");
          return [lLines, rLines].join("\n");
        }
        // Mono → also wire R to the same data via loadR for symmetry.
        const rLines = emitAssetLoadCpp(n, 0, "loadR", "setSampleRate");
        return [lLines, rLines].join("\n");
      }
    ],
    description: "Stereo sample player. Wire L/R into OutputStereo. Same controls as SamplePlayer; mono files duplicate to both channels on load."
  },

  /* Asynchronous granular player. Spawns up to MAX_GRAINS overlapping
   * grains randomly from the sample at `position` (0..1 = play head
   * within source). density = grains/sec, grainSize in ms, spread =
   * randomness of the read position around `position`. Pitch shifts
   * each grain independently. The classic "time-stretching freeze"
   * happens at high density + low spread; "smear" at high spread. */
  GranularPlayer: {
    category: "Oscillator", color: COLOR.sample, header: null,
    cppType: "GammaGranularPlayer",
    helperClass:
`class GammaGranularPlayer {
    static constexpr int MAX_GRAINS = 32;
    struct Grain {
        bool   active = false;
        double pos = 0.0;
        int    age = 0;
        int    duration = 0;
        float  pitch = 1.f;
    };
    std::vector<float> buf_;
    int    nSamples_ = 0;
    Grain  grains_[MAX_GRAINS];
    float  density_ = 30.f;
    float  grainSizeMs_ = 50.f;
    float  position_ = 0.f;
    float  pitch_ = 1.f;
    float  spread_ = 0.05f;
    float  gain_ = 1.f;
    float  dcOffset_ = 0.f;
    float  incomingBpm_ = 0.f;
    float  naturalBpm_ = 120.f;
    bool   bpmSync_ = false;
    float  stretch_ = 1.f;
    float  sr_ = 48000.f;
    float  sourceSr_ = 48000.f;
    unsigned rng_ = 0x12345u;
    void recalcStretch_() {
        stretch_ = (bpmSync_ && incomingBpm_ > 0.f && naturalBpm_ > 0.f)
            ? (incomingBpm_ / naturalBpm_) : 1.f;
    }
    float rand01() {
        rng_ = rng_ * 1664525u + 1013904223u;
        return (float)((rng_ >> 8) & 0xFFFFu) / 65535.f;
    }
public:
    GammaGranularPlayer() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        for (int i = 0; i < MAX_GRAINS; i++) grains_[i].active = false;
    }
    void setSampleRate(float sr) { sourceSr_ = sr; }
    void load(const float* src, int n) {
        buf_.assign(src, src + n);
        nSamples_ = n;
    }
    void setDensity(float d)   { density_ = d; }
    void setGrainSize(float m) { grainSizeMs_ = m; }
    void setPosition(float p)  { position_ = p; }
    void setPitch(float p)     { pitch_ = p; }
    void setSpread(float s)    { spread_ = s; }
    void setGain(float g)      { gain_ = g; }
    void setDcOffset(float d)  { dcOffset_ = d; }
    void setBpm(float v)        { incomingBpm_ = v; recalcStretch_(); }
    void setNaturalBpm(float v) { naturalBpm_ = v;  recalcStretch_(); }
    void setBpmSync(float v)    { bpmSync_ = v > 0.5f; recalcStretch_(); }
    float operator()() {
        if (nSamples_ < 2) return 0.f;
        // Probabilistic grain trigger — density grains/sec means
        // probability density/sr per sample.
        const float pTrig = density_ / sr_;
        if (rand01() < pTrig) {
            for (int i = 0; i < MAX_GRAINS; i++) {
                if (!grains_[i].active) {
                    grains_[i].active = true;
                    grains_[i].age = 0;
                    grains_[i].duration = (int)(grainSizeMs_ * sr_ * 0.001f);
                    if (grains_[i].duration < 4) grains_[i].duration = 4;
                    const float spr = (rand01() * 2.f - 1.f) * spread_;
                    float p = position_ + spr;
                    if (p < 0.f) p = 0.f; if (p > 1.f) p = 1.f;
                    grains_[i].pos = (double)p * (double)(nSamples_ - 1);
                    grains_[i].pitch = pitch_;
                    break;
                }
            }
        }
        float out = 0.f;
        constexpr float TWO_PI = 6.28318530718f;
        for (int i = 0; i < MAX_GRAINS; i++) {
            if (!grains_[i].active) continue;
            const float t = (float)grains_[i].age / (float)grains_[i].duration;
            const float env = 0.5f * (1.f - std::cos(TWO_PI * t));
            const int p0 = (int)grains_[i].pos;
            if (p0 >= 0 && p0 < nSamples_ - 1) {
                const float ft = (float)(grains_[i].pos - p0);
                const float v = buf_[p0] * (1.f - ft) + buf_[p0 + 1] * ft;
                out += v * env;
            }
            grains_[i].pos += (double)grains_[i].pitch * (double)stretch_ * ((double)sourceSr_ / (double)sr_);
            grains_[i].age++;
            if (grains_[i].age >= grains_[i].duration) grains_[i].active = false;
        }
        return (out * 0.5f) * gain_ - dcOffset_;
    }
};`,
    ins: [
      { n: "trig",      t: "gate" },
      { n: "position",  t: "param" },
      { n: "density",   t: "param" },
      { n: "grainSize", t: "param" },
      { n: "pitch",     t: "param" },
      { n: "spread",    t: "param" },
      { n: "gain",      t: "param" },
      { n: "dcOffset",  t: "param" },
      { n: "bpm",        t: "param" },
      { n: "naturalBpm", t: "param" },
      { n: "bpmSync",    t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { assetId: "", position: 0.5, density: 30, grainSize: 50, pitch: 1.0, spread: 0.05, gain: 1.0, dcOffset: 0.0, naturalBpm: 120, bpmSync: 0 },
    methods: {
      position: "setPosition", density: "setDensity",
      grainSize: "setGrainSize", pitch: "setPitch", spread: "setSpread",
      gain: "setGain", dcOffset: "setDcOffset",
      bpm: "setBpm", naturalBpm: "setNaturalBpm", bpmSync: "setBpmSync"
    },
    gateMethods: { trig: "reset" },
    autoExpose: ["position", "density", "grainSize", "pitch", "spread"],
    uiOnlyParams: ["assetId"],
    kind: "sampleHost",
    extraHeaders: ["<vector>", "<cmath>"],
    extraCtor: [(n) => emitAssetLoadCpp(n, 0, "load", "setSampleRate")],
    description: "Asynchronous granular player. Spawns overlapping grains from a sample at `position`. density (grains/sec), grainSize (ms), spread (random position offset). Time-stretch freeze at high density + low spread; smear at high spread."
  },

  /* WarpPlayer — pitch-preserving time-stretch sample player.
   * The naïve `bpmSync` on SamplePlayer/Stereo/Granular shifts
   * pitch with tempo (resampling). This node decouples them: a
   * 4-grain Hann-windowed WSOLA reads the source through
   * overlapping windows, with each grain reading at `pitch`
   * speed and the grain-trigger cursor advancing at `speed`
   * (independent). Wire `MasterClock.bpm → bpm`, set
   * `naturalBpm` to the loop's recorded tempo, toggle `bpmSync`
   * on, and the loop locks to the master clock without going
   * chipmunk on speed-up.
   *
   * Quality: WSOLA without epoch detection — fine for typical
   * music material in the [0.5, 2.0] pitch / speed range. Wider
   * ratios may show flanging artifacts. Studio-grade quality
   * needs PSOLA + pitch-period detection — out of scope.
   *
   * Same asset-host plumbing as SamplePlayer (kind "sampleHost")
   * — drop a .wav onto the props pane to load. */
  WarpPlayer: {
    category: "Oscillator", color: COLOR.sample, header: null,
    cppType: "GammaWarpPlayer",
    helperClass:
`class GammaWarpPlayer {
    static constexpr int FRAME  = 2048;
    static constexpr int HOP    = 512;
    static constexpr int GRAINS = 4;
    std::vector<float> buf_;
    int    nSamples_ = 0;
    struct Grain {
        bool   active = false;
        double srcPos = 0.0;
        int    outAge = 0;
    };
    Grain  grains_[GRAINS];
    int    outCounter_ = 0;
    double sourceCursor_ = 0.0;
    float  pitch_ = 1.f;
    float  speed_ = 1.f;
    float  bpm_ = 120.f;
    float  naturalBpm_ = 120.f;
    bool   bpmSync_ = false;
    float  effSpeed_ = 1.f;
    float  gain_ = 1.f;
    float  dcOffset_ = 0.f;
    bool   loop_ = false;
    bool   playing_ = false;
    bool   atEnd_ = false;
    float  sr_ = 48000.f;
    float  sourceSr_ = 48000.f;
    void recalcSpeed_() {
        effSpeed_ = (bpmSync_ && bpm_ > 0.f && naturalBpm_ > 0.f)
            ? (bpm_ / naturalBpm_) : speed_;
    }
public:
    GammaWarpPlayer() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        for (int i = 0; i < GRAINS; i++) grains_[i].active = false;
    }
    void setSampleRate(float sr) { sourceSr_ = sr; }
    void load(const float* src, int n) {
        buf_.assign(src, src + n);
        nSamples_ = n;
    }
    void setPitch(float p)      { pitch_ = (p < 0.1f) ? 0.1f : (p > 4.f ? 4.f : p); }
    void setSpeed(float s)      { speed_ = (s < 0.1f) ? 0.1f : (s > 4.f ? 4.f : s); recalcSpeed_(); }
    void setBpm(float v)        { bpm_ = v; recalcSpeed_(); }
    void setNaturalBpm(float v) { naturalBpm_ = v; recalcSpeed_(); }
    void setBpmSync(float v)    { bpmSync_ = v > 0.5f; recalcSpeed_(); }
    void setGain(float g)       { gain_ = g; }
    void setDcOffset(float d)   { dcOffset_ = d; }
    void setLoop(float l)       { loop_ = l > 0.5f; }
    void play() {
        outCounter_ = 0;
        sourceCursor_ = 0.0;
        atEnd_ = false;
        for (int i = 0; i < GRAINS; i++) grains_[i].active = false;
        grains_[0].active = true;
        grains_[0].srcPos = 0.0;
        grains_[0].outAge = 0;
        playing_ = true;
    }
    void stop() { playing_ = false; }
    void reset() { play(); }
    float operator()() {
        if (!playing_ || nSamples_ < 2) return 0.f;
        // Trigger a new grain every HOP samples. Source cursor
        // advances by HOP * effSpeed per trigger — this is what
        // decouples output time from source time. With pitch=1
        // and speed=1, the grain starts line up exactly with the
        // 4 overlapping Hann windows summing to ~1.0 (constant-
        // overlap-add), so output ≈ source.
        if (!atEnd_ && outCounter_ > 0 && (outCounter_ % HOP) == 0) {
            for (int i = 0; i < GRAINS; i++) {
                if (!grains_[i].active) {
                    grains_[i].active = true;
                    grains_[i].srcPos = sourceCursor_;
                    grains_[i].outAge = 0;
                    break;
                }
            }
            sourceCursor_ += (double)HOP * (double)effSpeed_ * (double)sourceSr_ / (double)sr_;
            if (sourceCursor_ >= (double)(nSamples_ - FRAME)) {
                if (loop_) sourceCursor_ = 0.0;
                else      atEnd_ = true;
            }
        }
        outCounter_++;
        constexpr float TWO_PI = 6.28318530718f;
        float sum = 0.f;
        for (int i = 0; i < GRAINS; i++) {
            if (!grains_[i].active) continue;
            const int age = grains_[i].outAge;
            const double pos = grains_[i].srcPos
                + (double)age * (double)pitch_ * (double)sourceSr_ / (double)sr_;
            const int i0 = (int)pos;
            if (i0 >= 0 && i0 < nSamples_ - 1) {
                const float t = (float)(pos - i0);
                const float v = buf_[i0] * (1.f - t) + buf_[i0 + 1] * t;
                const float w = 0.5f * (1.f - std::cos(TWO_PI * (float)age / (float)(FRAME - 1)));
                sum += v * w;
            }
            grains_[i].outAge++;
            if (grains_[i].outAge >= FRAME) grains_[i].active = false;
        }
        // After the last grain finishes (no new triggers, all
        // inactive), stop output. This avoids dribbling silence
        // through gain * 0 - dcOffset which would emit a DC bias.
        if (atEnd_) {
            bool anyActive = false;
            for (int i = 0; i < GRAINS; i++) if (grains_[i].active) { anyActive = true; break; }
            if (!anyActive) playing_ = false;
        }
        return sum * gain_ - dcOffset_;
    }
};`,
    ins: [
      { n: "trig",       t: "gate" },
      { n: "pitch",      t: "param" },
      { n: "speed",      t: "param" },
      { n: "loop",       t: "param" },
      { n: "gain",       t: "param" },
      { n: "dcOffset",   t: "param" },
      { n: "bpm",        t: "param" },
      { n: "naturalBpm", t: "param" },
      { n: "bpmSync",    t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { assetId: "", pitch: 1.0, speed: 1.0, loop: 0, gain: 1.0, dcOffset: 0.0, naturalBpm: 120, bpmSync: 0 },
    methods: {
      pitch: "setPitch", speed: "setSpeed", loop: "setLoop",
      gain: "setGain", dcOffset: "setDcOffset",
      bpm: "setBpm", naturalBpm: "setNaturalBpm", bpmSync: "setBpmSync"
    },
    gateMethods: { trig: "play" },
    autoExpose: ["pitch", "speed", "loop"],
    uiOnlyParams: ["assetId"],
    kind: "sampleHost",
    extraHeaders: ["<vector>", "<cmath>"],
    extraCtor: [
      (n) => emitAssetLoadCpp(n, 0, "load", "setSampleRate")
    ],
    description: "Pitch-preserving time-stretch sample player. pitch shifts WITHOUT changing tempo; speed (or bpmSync) changes tempo WITHOUT affecting pitch. WSOLA grain overlap (4 grains × 2048 samples × Hann window). Set naturalBpm to the loop's recorded tempo, wire MasterClock.bpm → bpm, toggle bpmSync, and the loop tracks the master clock cleanly. Best in [0.5, 2.0] pitch/speed ratios."
  },

  /* Pulsar synthesis (Curtis Roads). A pulsar is a short waveform
   * (formant grain) with an envelope; pulsars repeat at the
   * fundamentalFreq rate, with each pulsar containing a waveform at
   * formantFreq. duty (0..1) is the fraction of each period filled by
   * the pulsar; the rest is silence. As duty → 1, output approaches a
   * straight sine at formantFreq. As duty → 0, output thins into clicks. */
  PulsarSynth: {
    category: "Oscillator", color: COLOR.oscillator, header: null,
    cppType: "GammaPulsarSynth",
    helperClass:
`class GammaPulsarSynth {
    float sampleInPeriod_ = 0.f;
    float fundamentalFreq_ = 100.f;
    float formantFreq_     = 800.f;
    float duty_            = 0.5f;
    int   waveform_        = 0;       // 0=sine, 1=saw, 2=square, 3=triangle
    float sr_ = 48000.f;
public:
    GammaPulsarSynth() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setFundamental(float f) { fundamentalFreq_ = f; }
    void setFormant(float f)     { formantFreq_ = f; }
    void setDuty(float d)        { duty_ = d < 0.01f ? 0.01f : (d > 0.99f ? 0.99f : d); }
    void setWaveform(float w)    { waveform_ = (int)w; }
    void reset() { sampleInPeriod_ = 0.f; }
    float operator()() {
        const float periodSamples = sr_ / fundamentalFreq_;
        if (sampleInPeriod_ >= periodSamples) sampleInPeriod_ -= periodSamples;
        const float pulsarSamples = duty_ * periodSamples;
        constexpr float TWO_PI = 6.28318530718f;
        if (sampleInPeriod_ >= pulsarSamples) {
            sampleInPeriod_ += 1.f;
            return 0.f;
        }
        const float t = sampleInPeriod_ / pulsarSamples;
        const float env = 0.5f * (1.f - std::cos(TWO_PI * t));
        const float wp = formantFreq_ * (sampleInPeriod_ / sr_);
        float wave;
        const float wpf = wp - (int)wp;
        switch (waveform_) {
            case 1: wave = 2.f * wpf - 1.f; break;
            case 2: wave = wpf < 0.5f ? 1.f : -1.f; break;
            case 3: wave = wpf < 0.5f ? (4.f * wpf - 1.f) : (3.f - 4.f * wpf); break;
            default: wave = std::sin(TWO_PI * wpf);
        }
        sampleInPeriod_ += 1.f;
        return wave * env;
    }
};`,
    ins: [
      { n: "trig",        t: "gate" },
      { n: "fundamental", t: "param" },
      { n: "formant",     t: "param" },
      { n: "duty",        t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { fundamental: 100, formant: 800, duty: 0.5, waveform: "sine" },
    methods: {
      fundamental: "setFundamental",
      formant: "setFormant",
      duty: "setDuty",
      waveform: "setWaveform"
    },
    paramOptions: { waveform: ["sine", "saw", "square", "triangle"] },
    enumMap:      { waveform: { sine: "0", saw: "1", square: "2", triangle: "3" } },
    gateMethods: { trig: "reset" },
    autoExpose: ["fundamental", "formant", "duty"],
    extraHeaders: ["<cmath>"],
    description: "Pulsar synthesis (Curtis Roads). Pulsars repeat at fundamental rate; each contains waveform at formant rate; duty 0..1 = pulsar/period ratio. Spans pitched tones (high duty) → granular clicks (low duty) → trains (varying fundamental)."
  },

  /* Live looper. Records audio in → buffer → plays buffer back as a
   * loop. recStart starts a fresh recording; recStop sets the loop
   * length to whatever was captured. playStart/playStop control
   * playback. While playing, recording overdubs (writes input + buffer
   * × feedback). clear wipes everything. maxSec sets the max buffer
   * length (allocated upfront). */
  LiveLooper: {
    category: "Effect", color: COLOR.effect, header: null,
    cppType: "GammaLiveLooper",
    helperClass:
`class GammaLiveLooper {
    std::vector<float> buf_;
    int   nSamples_ = 0;
    int   maxSamples_ = 480000;
    int   wpos_ = 0;
    int   rpos_ = 0;
    bool  recording_ = false;
    bool  playing_ = false;
    float feedback_ = 0.7f;
    float sr_ = 48000.f;
public:
    GammaLiveLooper() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        buf_.assign(maxSamples_, 0.f);
    }
    void setMaxSec(float s) {
        int n = (int)(s * sr_);
        if (n < 1024) n = 1024;
        maxSamples_ = n;
        buf_.assign(maxSamples_, 0.f);
        nSamples_ = 0; wpos_ = 0; rpos_ = 0;
    }
    void setFeedback(float f) { feedback_ = f; }
    void recStart() { recording_ = true; wpos_ = 0; nSamples_ = 0; }
    void recStop()  { recording_ = false; nSamples_ = wpos_; }
    void playStart() { playing_ = true; rpos_ = 0; }
    void playStop()  { playing_ = false; }
    void clear() {
        recording_ = false; playing_ = false; nSamples_ = 0; wpos_ = 0; rpos_ = 0;
        std::fill(buf_.begin(), buf_.end(), 0.f);
    }
    float operator()(float in) {
        if (recording_) {
            if (nSamples_ == 0) {
                if (wpos_ < maxSamples_) {
                    buf_[wpos_] = in;
                    wpos_++;
                }
            }
        }
        if (!playing_) return in;
        if (nSamples_ < 2) return in;
        float v = buf_[rpos_];
        if (recording_ && nSamples_ > 0) {
            buf_[rpos_] = in + buf_[rpos_] * feedback_;
        }
        rpos_++;
        if (rpos_ >= nSamples_) rpos_ = 0;
        return in + v;
    }
};`,
    ins: [
      { n: "in",       t: "audio" },
      { n: "recStart", t: "gate" },
      { n: "recStop",  t: "gate" },
      { n: "playStart",t: "gate" },
      { n: "playStop", t: "gate" },
      { n: "clear",    t: "gate" },
      { n: "maxSec",   t: "param" },
      { n: "feedback", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { maxSec: 10.0, feedback: 0.7 },
    methods: { maxSec: "setMaxSec", feedback: "setFeedback" },
    gateMethods: {
      recStart: "recStart", recStop: "recStop",
      playStart: "playStart", playStop: "playStop", clear: "clear"
    },
    autoExpose: ["maxSec", "feedback"],
    hostGates: ["recStart", "recStop", "playStart", "playStop", "clear"],
    extraHeaders: ["<vector>", "<algorithm>"],
    description: "Live looper. recStart/recStop captures audio in → buffer; playStart loops the buffer back at output. Overdub while playing (feedback scales the buffer's existing content before adding the new input). maxSec sets buffer cap."
  },

  /* Live microphone input. Helper class is a setter-driven pass-through;
   * the AudioWorklet writes incoming mic samples via setIn each sample.
   * When the patch contains a MicInput node, the editor automatically
   * connects the user's mic stream (after one-time permission grant)
   * to the worklet's input — codegen emits a setMicInput dispatcher
   * on the patch class + a mic-buffer getter on the wrapper. Stream
   * is shared across all MicInput instances in the patch. */
  MicInput: {
    category: "Sample", color: COLOR.sample, header: null,
    cppType: "GammaMicInput",
    helperClass:
`class GammaMicInput {
    /* Pass-through with three handles: gain (multiplier on the
     * incoming signal), dcOffset (subtracted after gain — useful for
     * mics with a small DC bias), and a setIn() the AudioWorklet
     * calls every sample with the live mic data. inputSourceId is
     * UI-only (handled JS-side via getUserMedia constraints) so it
     * doesn't show up in the helper class. */
    float in_ = 0.f;
    float gain_ = 1.f;
    float dcOffset_ = 0.f;
public:
    void setIn(float v)       { in_ = v; }
    void setGain(float g)     { gain_ = g; }
    void setDcOffset(float d) { dcOffset_ = d; }
    float operator()() { return in_ * gain_ - dcOffset_; }
};`,
    ins: [
      { n: "gain",     t: "param" },
      { n: "dcOffset", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { gain: 1.0, dcOffset: 0.0, inputSourceId: "" },
    methods: { gain: "setGain", dcOffset: "setDcOffset" },
    uiOnlyParams: ["inputSourceId"],
    kind: "micInput",
    description: "Live mic input source. Click ▶ Play to prompt for mic access (cached after first grant); inputs[0] is piped into the wasm patch via setIn per sample. gain scales the input, dcOffset subtracts a constant offset (some mics have a small DC bias). Pick a specific input device from the props pane on multi-mic systems. Use with VoiceTrigger for voice-activity-driven sequencing."
  },

  /* Voice activity detection — energy-based gate with attack / hold /
   * release. Outputs:
   *   env  — smoothed input envelope (audio-rate signal 0..N)
   *   gate — 1 while voice active, 0 while silent (with hysteresis)
   *   trig — one-sample pulse on each rising edge (gate goes 0→1)
   * Wire mic → VoiceTrigger.in. Wire .gate or .trig into AD.trig,
   * sequencer.trig, or any gate-typed input to drive other nodes
   * from voice activity. */
  VoiceTrigger: {
    category: "Analysis", color: COLOR.analysis, header: null,
    cppType: "GammaVoiceTrigger",
    helperClass:
`class GammaVoiceTrigger {
    float env_ = 0.f;
    float threshold_ = 0.05f;
    float attackMs_ = 5.f;
    float releaseMs_ = 100.f;
    float holdMs_ = 200.f;
    int   holdSamples_ = 0;
    bool  active_ = false;
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
    void recalc() {
        ka_ = 1.f - std::exp(-1.f / (attackMs_  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (releaseMs_ * sr_ * 0.001f));
    }
public:
    GammaVoiceTrigger() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc();
    }
    void setThreshold(float t) { threshold_ = t; }
    void setAttack(float ms)   { attackMs_  = ms; recalc(); }
    void setRelease(float ms)  { releaseMs_ = ms; recalc(); }
    void setHold(float ms)     { holdMs_    = ms; }
    struct Out { float env, gate, trig; };
    Out operator()(float in) {
        const float a = in < 0.f ? -in : in;
        const float k = a > env_ ? ka_ : kr_;
        env_ += k * (a - env_);
        Out o;
        o.env = env_;
        const bool wasActive = active_;
        if (env_ > threshold_) {
            active_ = true;
            holdSamples_ = (int)(holdMs_ * sr_ * 0.001f);
        } else if (active_ && holdSamples_ > 0) {
            holdSamples_--;
        } else {
            active_ = false;
        }
        o.gate = active_ ? 1.f : 0.f;
        o.trig = (active_ && !wasActive) ? 1.f : 0.f;
        return o;
    }
};`,
    ins: [
      { n: "in",        t: "audio" },
      { n: "threshold", t: "param" },
      { n: "attack",    t: "param" },
      { n: "release",   t: "param" },
      { n: "hold",      t: "param" }
    ],
    outs: [
      { n: "env",  t: "audio", access: ".env"  },
      { n: "gate", t: "clock", access: ".gate" },
      { n: "trig", t: "clock", access: ".trig" }
    ],
    params: { threshold: 0.05, attack: 5, release: 100, hold: 200, triggerSamples: [] },
    methods: {
      threshold: "setThreshold",
      attack:    "setAttack",
      release:   "setRelease",
      hold:      "setHold"
    },
    autoExpose: ["threshold", "attack", "release", "hold"],
    /* triggerSamples is a per-instance list of recorded "trigger word"
     * snippets (each an audio buffer captured via getUserMedia). The
     * recordings are stored in node.params for now; the runtime
     * detection still uses the energy-based gate above. Future work:
     * compute MFCCs from each recording and run sliding-window DTW
     * against the live signal to fire trig when the recorded word is
     * detected. UI for capturing the recordings ships in the props
     * pane (RECORD / list / delete). */
    uiOnlyParams: ["triggerSamples"],
    kind: "voiceTrigger",
    extraHeaders: ["<cmath>"],
    description: "Voice activity / keyword detection. Wire audio (e.g. MicInput.out) into in. env = smoothed envelope, gate = active flag (with hold + hysteresis), trig = one-sample pulse on each voice onset. Record trigger-word samples in the props pane to teach the detector your activation phrase (template-matching detection ships in a future build; energy gate is what fires today)."
  },

  /* KeywordSpotter — VoiceTrigger upgraded with JS-side template
   * matching. Same C++ helper shape as VoiceTrigger (energy gate
   * + env / gate / trig outputs) PLUS a triggerFromJS hostGate
   * that the JS detection pipeline calls when the live mic stream
   * matches one of the recorded trigger-word templates.
   *
   * How it works:
   *   1. User records 3–5 takes of the trigger word in the props
   *      pane (same UI as VoiceTrigger — both nodes share the
   *      recordTriggerSample / triggerSamples plumbing).
   *   2. On preview start, the editor computes a 16-point
   *      normalized amplitude envelope from each recording — a
   *      simple but discriminative fingerprint that captures the
   *      word's overall shape (sharpness, syllable structure,
   *      rise/fall pattern).
   *   3. While playing, JS taps the mic stream and maintains a
   *      rolling buffer (~1.5 s). Every 80 ms it extracts the
   *      same 16-point envelope from the buffer and compares to
   *      each template via cosine similarity.
   *   4. If the best similarity exceeds matchThreshold AND
   *      enough time has passed since the last match (cooldown),
   *      JS dispatches the C++ helper's triggerFromJS setter,
   *      which fires the trig output for one sample.
   *
   * Limitations: envelope-shape matching is order-invariant in
   * the time domain — it captures word duration + energy
   * contour but not phonemes, so similar-shape words ("hello"
   * vs "yellow") may be confused. For phoneme-level distinction
   * the next pass would compute MFCCs (FFT + mel filterbank +
   * DCT) per frame and run DTW between sequences. Out of scope
   * for v1 — this ships something users can demo today. */
  KeywordSpotter: {
    category: "Analysis", color: COLOR.analysis, header: null,
    cppType: "GammaKeywordSpotter",
    helperClass:
`class GammaKeywordSpotter {
    /* Same energy-gate logic as VoiceTrigger, plus a one-shot
     * pulse_ flag that the JS keyword detector flips via the
     * triggerFromJS() setter. trig fires either on energy-gate
     * onset (for backwards compat with VoiceTrigger patches)
     * OR when JS posts a keyword-match event. */
    float env_ = 0.f;
    float threshold_ = 0.05f;
    float attackMs_ = 5.f;
    float releaseMs_ = 100.f;
    float holdMs_ = 200.f;
    int   holdSamples_ = 0;
    bool  active_ = false;
    bool  pulse_ = false;
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
    void recalc() {
        ka_ = 1.f - std::exp(-1.f / (attackMs_  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (releaseMs_ * sr_ * 0.001f));
    }
public:
    GammaKeywordSpotter() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc();
    }
    void setThreshold(float t)  { threshold_ = t; }
    void setAttack(float ms)    { attackMs_  = ms; recalc(); }
    void setRelease(float ms)   { releaseMs_ = ms; recalc(); }
    void setHold(float ms)      { holdMs_    = ms; }
    void triggerFromJS()        { pulse_ = true; }
    struct Out { float env, gate, trig; };
    Out operator()(float in) {
        const float a = in < 0.f ? -in : in;
        const float k = a > env_ ? ka_ : kr_;
        env_ += k * (a - env_);
        Out o;
        o.env = env_;
        const bool wasActive = active_;
        if (env_ > threshold_) {
            active_ = true;
            holdSamples_ = (int)(holdMs_ * sr_ * 0.001f);
        } else if (active_ && holdSamples_ > 0) {
            holdSamples_--;
        } else {
            active_ = false;
        }
        o.gate = active_ ? 1.f : 0.f;
        // trig: one-sample pulse on either (a) voice-activity
        // onset (energy gate) or (b) JS keyword-match event.
        const bool fireTrig = pulse_ || (active_ && !wasActive);
        o.trig = fireTrig ? 1.f : 0.f;
        if (pulse_) pulse_ = false;
        return o;
    }
};`,
    ins: [
      { n: "in",        t: "audio" },
      { n: "threshold", t: "param" },
      { n: "attack",    t: "param" },
      { n: "release",   t: "param" },
      { n: "hold",      t: "param" }
    ],
    outs: [
      { n: "env",  t: "audio", access: ".env"  },
      { n: "gate", t: "clock", access: ".gate" },
      { n: "trig", t: "clock", access: ".trig" }
    ],
    params: { threshold: 0.05, attack: 5, release: 100, hold: 200, triggerSamples: [], matchThreshold: 0.85, detectMode: "envelope" },
    methods: {
      threshold: "setThreshold",
      attack:    "setAttack",
      release:   "setRelease",
      hold:      "setHold"
    },
    gateMethods: { match: "triggerFromJS" },
    hostGates: ["match"],
    autoExpose: ["threshold", "attack", "release", "hold"],
    uiOnlyParams: ["triggerSamples", "matchThreshold", "detectMode"],
    kind: "keywordSpotter",
    extraHeaders: ["<cmath>"],
    description: "Keyword / wake-word detection. Wire MicInput.out into in. Record 3–5 takes of the trigger word in the props pane. detectMode picks the algorithm: 'envelope' = fast amplitude-envelope cosine similarity (no model, instant); 'whisper' = phoneme-level transcription via Whisper-tiny (~75 MB one-time download, English-only, more accurate). Hybrid mode runs both — envelope fires immediately, whisper confirms or rejects. trig fires through the `match` host gate."
  },

  /* ---- Noise (Noise.h) ----
   * Each noise type is wrapped in a thin GammaNoiseT<> template so we
   * can attach a trigger() method (re-seeds the underlying generator
   * with a globally-incrementing counter, so consecutive triggers
   * never repeat the same noise sequence). For NoisePink / NoiseBrown
   * the re-seed also clears their filter / integrator state, which
   * gives a clean transient — useful for percussive layering. The
   * wire to trig is opt-in: leave it unconnected and noise behaves
   * exactly like before (always-on). The gam::Noise* class isn't
   * touched; we just compose. The shared helperClass below is
   * deduped by class-name in the codegen so it's emitted once. */
  NoiseWhite: {
    category: "Noise", color: COLOR.noise, header: "Noise",
    cppType: "GammaNoiseT<gam::NoiseWhite<>>",
    helperClass:
`inline unsigned int gammaNoiseSeedNext_() { static unsigned int k = 0; return ++k; }
template<typename N> class GammaNoiseT {
    N n_;
public:
    void trigger() { n_.seed(gammaNoiseSeedNext_()); }
    float operator()() { return n_(); }
};`,
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    gateMethods: { trig: "trigger" },
    description: "Uniform white noise. trig (optional) re-seeds the generator on each pulse — useful for percussive use where you want a clean fresh-sample transient."
  },
  NoisePink: {
    category: "Noise", color: COLOR.noise, header: "Noise",
    cppType: "GammaNoiseT<gam::NoisePink<>>",
    helperClass:
`inline unsigned int gammaNoiseSeedNext_() { static unsigned int k = 0; return ++k; }
template<typename N> class GammaNoiseT {
    N n_;
public:
    void trigger() { n_.seed(gammaNoiseSeedNext_()); }
    float operator()() { return n_(); }
};`,
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    gateMethods: { trig: "trigger" },
    description: "1/f noise (Voss-McCartney). trig re-seeds + clears the filter state — gives a clean transient on each pulse."
  },
  NoiseBrown: {
    category: "Noise", color: COLOR.noise, header: "Noise",
    cppType: "GammaNoiseT<gam::NoiseBrown<>>",
    helperClass:
`inline unsigned int gammaNoiseSeedNext_() { static unsigned int k = 0; return ++k; }
template<typename N> class GammaNoiseT {
    N n_;
public:
    void trigger() { n_.seed(gammaNoiseSeedNext_()); }
    float operator()() { return n_(); }
};`,
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    gateMethods: { trig: "trigger" },
    description: "1/f² noise (random walk). trig re-seeds + clears the integrator — clean restart on each pulse."
  },
  NoiseBinary: {
    category: "Noise", color: COLOR.noise, header: "Noise",
    cppType: "GammaNoiseT<gam::NoiseBinary<>>",
    helperClass:
`inline unsigned int gammaNoiseSeedNext_() { static unsigned int k = 0; return ++k; }
template<typename N> class GammaNoiseT {
    N n_;
public:
    void trigger() { n_.seed(gammaNoiseSeedNext_()); }
    float operator()() { return n_(); }
};`,
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    gateMethods: { trig: "trigger" },
    description: "Binary white noise (±1). trig re-seeds the generator."
  },

  /* ---- Envelopes (Envelope.h) ---- */
  /* AD / ADSR — `amp` setter dropped (was: `amp: "amp"` in methods).
   * Calling .amp(v) → maxLevel(v) → scl::max(...) which fails to
   * compile against the Gamma checkout the local compile server
   * pulls (the 2-arg scl::max overload is missing — only the 3-arg
   * and Vec versions are visible at the call site in Envelope.h:905).
   * Gamma's ADSR ctor already defaults amp to 1, so emitting an
   * `n.amp(1.f)` call was redundant *and* broke compilation. Drop
   * the param + method until either the upstream max-overload is
   * patched or codegen learns to skip default-value setter calls. */
  AD: {
    category: "Envelope", color: COLOR.envelope, header: "Envelope",
    cppType: "gam::AD<>",
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: { attack: 0.01, decay: 0.6 },
    methods: { attack: "attack", decay: "decay" },
    description: "Attack-Decay envelope"
  },
  ADSR: {
    category: "Envelope", color: COLOR.envelope, header: "Envelope",
    cppType: "gam::ADSR<>",
    ins: [{n:"trig", t:"gate"}, {n:"rel", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.4 },
    methods: { attack: "attack", decay: "decay", sustain: "sustain", release: "release" },
    /* rel-input gate fires triggerRelease(), NOT release(). Gamma's
     * gam::ADSR::release() is a const getter — it returns the release-
     * time parameter (and shadows Env::release() via the same name).
     * triggerRelease() is the member that actually advances to the
     * release stage. Wiring rel→release() silently sustained forever
     * since the getter just ran and discarded its return value. */
    gateMethods: { trig: "reset", rel: "triggerRelease" },
    description: "Attack-Decay-Sustain-Release envelope. Wire trig to start the envelope and rel to trigger the release stage; without rel wired, sustains forever after trig."
  },
  Decay: {
    category: "Envelope", color: COLOR.envelope, header: "Envelope",
    cppType: "gam::Decay<>",
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: { decay: 1 },
    methods: { decay: "decay" },
    description: "Exponential decay (–60 dB length)"
  },

  /* Drawable ADSR — sketch any envelope shape with a movable sustain
   * point. The 64-sample LUT covers the entire envelope; sustainIdx
   * marks where the curve "holds" while the gate is active. attack
   * controls how long indices [0..sustainIdx] take to play (key
   * down → sustain); release controls how long [sustainIdx..63]
   * takes (key up → silence). Wire trig/rel exactly like ADSR.
   * Click "Edit envelope" in the props pane to draw / drag the
   * sustain handle. */
  EnvDraw: {
    category: "Envelope", color: COLOR.envelope, header: null,
    cppType: "GammaEnvDraw",
    helperClass:
`class GammaEnvDraw {
    /* Drawable ADSR envelope. The LUT stores the full shape from
     * trigger (index 0) to natural end (index N-1). sustainIdx_
     * splits the curve in two halves: indices [0..sustainIdx_]
     * are traversed during attack at attack-time pace; the LUT
     * value at sustainIdx_ is held while the gate is active; on
     * release, indices [sustainIdx_..N-1] are traversed at
     * release-time pace. */
    static constexpr int N = 64;
    float lut_[N];
    int   sustainIdx_ = 32;
    float aDur_ = 0.5f;
    float rDur_ = 0.5f;
    float sr_   = 48000.f;
    int   stage_ = 0;          // 0=idle, 1=attack, 2=sustain, 3=release
    float phase_ = 0.f;        // float index within LUT
public:
    GammaEnvDraw() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        // Default shape: triangular peak at sustain — ramp up, ramp down.
        for (int i = 0; i <= sustainIdx_; i++) lut_[i] = (float)i / (float)sustainIdx_;
        for (int i = sustainIdx_+1; i < N; i++) lut_[i] = (float)(N - 1 - i) / (float)(N - 1 - sustainIdx_);
    }
    void setAttack(float s)  { aDur_ = (s > 0.0001f) ? s : 0.0001f; }
    void setRelease(float s) { rDur_ = (s > 0.0001f) ? s : 0.0001f; }
    void setSustainIdx(float i) {
        int v = (int)i;
        if (v < 1) v = 1;
        if (v > N - 2) v = N - 2;
        sustainIdx_ = v;
    }
    void setLut(const float* src, int n) {
        if (n > N) n = N;
        for (int i = 0; i < n; i++) lut_[i] = src[i];
    }
    void trigger() { stage_ = 1; phase_ = 0.f; }
    void release() {
        if (stage_ == 0 || stage_ == 3) return;
        stage_ = 3;
        if (phase_ < (float)sustainIdx_) phase_ = (float)sustainIdx_;
    }
    float lookup_(float fi) {
        if (fi < 0.f) fi = 0.f;
        if (fi > (float)(N - 1)) fi = (float)(N - 1);
        const int i0 = (int)fi;
        const int i1 = (i0 < N - 1) ? i0 + 1 : N - 1;
        const float t = fi - (float)i0;
        return lut_[i0] * (1.f - t) + lut_[i1] * t;
    }
    float operator()() {
        if (stage_ == 0) return 0.f;
        if (stage_ == 1) {
            const float step = (float)sustainIdx_ / (aDur_ * sr_);
            phase_ += step;
            if (phase_ >= (float)sustainIdx_) {
                phase_ = (float)sustainIdx_;
                stage_ = 2;
            }
            return lookup_(phase_);
        }
        if (stage_ == 2) {
            return lookup_((float)sustainIdx_);
        }
        const float step = (float)(N - 1 - sustainIdx_) / (rDur_ * sr_);
        phase_ += step;
        if (phase_ >= (float)(N - 1)) {
            phase_ = (float)(N - 1);
            stage_ = 0;
            return 0.f;
        }
        return lookup_(phase_);
    }
};`,
    ins: [{n:"trig", t:"gate"}, {n:"rel", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: { attack: 0.5, release: 0.5 },
    methods: { attack: "setAttack", release: "setRelease" },
    gateMethods: { trig: "trigger", rel: "release" },
    uiOnlyParams: ["curveTable", "sustainIdx"],
    kind: "envDraw",
    extraCtor: [
      (n) => {
        const tbl  = n.params && n.params.curveTable;
        const sIdx = (n.params && typeof n.params.sustainIdx === "number") ? n.params.sustainIdx : 32;
        const parts = [];
        if (Array.isArray(tbl) && tbl.length > 0) {
          const vals = tbl.map(v => Number(v).toFixed(4) + "f").join(", ");
          parts.push(`        {`);
          parts.push(`            static constexpr float ${n.id}_lut[] = { ${vals} };`);
          parts.push(`            ${n.id}.setLut(${n.id}_lut, ${tbl.length});`);
          parts.push(`        }`);
        }
        parts.push(`        ${n.id}.setSustainIdx(${sIdx}.f);`);
        return parts.join("\n");
      }
    ],
    description: "Drawable ADSR envelope — sketch the full shape and drag the sustain marker. Wire trig to start, rel to release. attack/release set how long each side of the curve takes to play."
  },
  Gate: {
    category: "Envelope", color: COLOR.envelope, header: "Envelope",
    cppType: "gam::Gate<>",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: { delay: 0 },
    methods: { delay: "delay" },
    description: "Threshold gate (1 if above, 0 if below)"
  },
  Seg: {
    category: "Envelope", color: COLOR.envelope, header: "Envelope",
    cppType: "gam::Seg<>",
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: { length: 0.5, start: 1, end: 0 },
    methods: { length: "length" },
    description: "Linear segment, useful as a value smoother"
  },
  SegExp: {
    category: "Envelope", color: COLOR.envelope, header: "Envelope",
    cppType: "gam::SegExp<>",
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: { length: 0.5, curve: -3, start: 1, end: 0 },
    methods: { length: "length", curve: "curve" },
    description: "Exponential segment with variable curvature"
  },

  /* ---- Filters (Filter.h) ---- */

  /* Unified Biquad with mode dropdown — replaces the four BiquadLP/HP/BP/BR
   * variants. Phase 3.6 enum-property UI: paramOptions populates the
   * <select>; enumMap maps each option to the corresponding gam:: symbol. */
  Biquad: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::Biquad<>",
    ins: [{n:"in", t:"audio"}, {n:"cutoff", t:"param"}, {n:"q", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { mode: "LOW_PASS", cutoff: 1200, q: 1.4 },
    paramOptions: { mode: ["LOW_PASS", "HIGH_PASS", "BAND_PASS", "BAND_REJECT", "ALL_PASS"] },
    enumMap: { mode: {
      LOW_PASS:    "gam::LOW_PASS",
      HIGH_PASS:   "gam::HIGH_PASS",
      BAND_PASS:   "gam::BAND_PASS",
      BAND_REJECT: "gam::BAND_REJECT",
      ALL_PASS:    "gam::ALL_PASS"
    } },
    methods: { mode: "type", cutoff: "freq", q: "res" },
    description: "Biquad filter — mode dropdown picks LP / HP / BP / BR / AP."
  },

  /* Computer-keyboard input. Two-output member node — `freq` is a
   * sticky float (held until the next keypress), `gate` is a
   * one-sample pulse (1.f for the sample after a keydown, 0.f
   * otherwise). Wire freq into Sine.freq for pitch + gate into
   * AD.trig for envelope retriggering. The host-fired `trigger`
   * setter is auto-exposed (no visible port — JS keydown handler
   * fires it; pulse propagates via the gate output wire). */
  KeyboardIn: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaKeyboard",
    helperClass:
`class GammaKeyboard {
    /* Sustained-note source. trigger() fires a one-sample pulse on
     * gate (key-down); release() fires a one-sample pulse on rel
     * (key-up). Wire gate into a gate-input that starts an envelope
     * (AD.trig / ADSR.trig) and rel into ADSR's rel input so the
     * envelope sustains while the key is held and releases on key
     * release. For mono triggers (AD), wiring gate alone is enough
     * — rel can be left unconnected. */
    float freq_   = 220.f;
    bool  pulse_  = false;
    bool  rPulse_ = false;
public:
    struct Out { float freq, gate, rel; };
    void setFreq(float v) { freq_ = v; }
    void trigger() { pulse_  = true; }
    void release() { rPulse_ = true; }
    Out operator()() {
        Out o;
        o.freq = freq_;
        o.gate = pulse_  ? 1.f : 0.f;
        o.rel  = rPulse_ ? 1.f : 0.f;
        pulse_  = false;
        rPulse_ = false;
        return o;
    }
};`,
    ins: [],
    outs: [
      { n: "freq", t: "audio", access: ".freq" },
      { n: "gate", t: "gate",  access: ".gate" },
      { n: "rel",  t: "gate",  access: ".rel"  }
    ],
    params: { freq: 220 },
    methods: { freq: "setFreq" },
    gateMethods: { trig: "trigger", rel: "release" },
    hostGates: ["trig", "rel"],
    autoExpose: ["freq"],
    description: "Computer keyboard → freq + gate + rel. A–K = white keys, W/E/T/Y/U = black. Wire freq into Sine.freq for pitch, gate into AD.trig or ADSR.trig to start the envelope, and rel into ADSR.rel for sustained notes (release on key-up)."
  },

  /* On-screen button. Renders as a clickable button in the Monitor
   * tab's Controls panel; pressing it sends a one-sample pulse on
   * the gate output. Wire into AD.trig (or any gate input) to fire
   * envelopes from the UI without QWERTY. */
  Button: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaButton",
    helperClass:
`class GammaButton {
    float lut_[64];
    int counter_  = 0;
    int duration_ = 4800;        // samples; 100ms at 48kHz
    int shape_    = 0;           // 0=pulse, 1=linRamp, 2=expDecay, 3=custom
    float sr_     = 48000.f;
public:
    GammaButton() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        for (int i = 0; i < 64; i++) lut_[i] = 1.f - (float)i / 63.f;
    }
    void setDuration(float ms) { duration_ = (int)(ms * sr_ * 0.001f); if (duration_ < 1) duration_ = 1; }
    void setShape(float s)     { shape_ = (int)s; }
    void setLut(const float* src, int n) {
        if (n > 64) n = 64;
        for (int i = 0; i < n; i++) lut_[i] = src[i];
    }
    void press() { counter_ = (shape_ == 0) ? 1 : duration_; }
    float operator()() {
        if (counter_ <= 0) return 0.f;
        counter_--;
        if (shape_ == 0) return 1.f;
        const float t = (float)(counter_ + 1) / (float)duration_;
        if (shape_ == 1) return t;
        if (shape_ == 2) return t * t;
        // shape_ == 3: custom LUT, indexed by (1 - t) so 0 = trigger, 1 = end.
        const float u  = 1.f - t;
        const float fi = u * 63.f;
        const int   i0 = (int)fi;
        const int   i1 = i0 < 63 ? i0 + 1 : 63;
        const float k  = fi - i0;
        return lut_[i0] * (1.f - k) + lut_[i1] * k;
    }
};`,
    ins: [],
    outs: [{ n: "gate", t: "gate" }],
    params: { label: "press", shape: "pulse", duration: 100 },
    methods: { duration: "setDuration", shape: "setShape" },
    paramOptions: { shape: ["pulse", "linRamp", "expDecay", "custom"] },
    enumMap:      { shape: { pulse: "0", linRamp: "1", expDecay: "2", custom: "3" } },
    gateMethods: { trig: "press" },
    hostGates: ["trig"],
    uiOnlyParams: ["label", "curveTable"],
    extraCtor: [
      (n) => {
        if (!n.params || n.params.shape !== "custom") return null;
        const tbl = n.params.curveTable;
        if (!Array.isArray(tbl) || tbl.length === 0) return null;
        const N = tbl.length;
        const vals = tbl.map(v => {
          const f = Number(v);
          return (isFinite(f) ? f : 0).toFixed(4) + "f";
        }).join(", ");
        return [
          "        {",
          `            static constexpr float ${n.id}_lut[] = { ${vals} };`,
          `            ${n.id}.setLut(${n.id}_lut, ${N});`,
          "        }"
        ].join("\n");
      }
    ],
    description: "On-screen button → gate output. shape: pulse (single 1.f sample), linRamp / expDecay (1→0 over `duration` ms), or custom (drawable envelope). Wire into a Mul to gate audio, or AD.trig for combined envelopes."
  },

  /* On-screen slider. Renders as a horizontal slider in the Monitor
   * tab's Controls panel; dragging the thumb writes a float into the
   * patch. min / max define the output range; curve picks how the
   * drag position maps to that range (linear / log / exp / sCurve). */
  Slider: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaSlider",
    helperClass:
`class GammaSlider {
    float val_ = 0.5f;
public:
    void setValue(float v) { val_ = v; }
    float operator()() { return val_; }
};`,
    ins: [],
    outs: [{ n: "out", t: "param" }],
    params: { value: 0.5, min: 0, max: 1, curve: "linear" },
    methods: { value: "setValue" },
    autoExpose: ["value"],
    uiOnlyParams: ["min", "max", "curve", "curveTable"],
    description: "On-screen slider → param-rate float output. Set min/max + curve (linear/log/exp/s-curve/custom) in the ramp editor. Drag in the Monitor's Controls panel. Wire out into any param input. (Type was 'audio' before Phase 6.6.24 — interconnected with audio/gate/clock via SIGNAL_PORT_TYPES, so old patches keep working.)"
  },

  /* v0.3.47 -- OscIn. External OSC source. The gamma-compile-server's
   * OSC bridge (UDP listener on port 9000 by default, WebSocket
   * fan-out to the editor) forwards inbound OSC messages here; this
   * node exposes the first four numeric args as v1..v4 param outputs
   * that can be wired into anything in the patch -- audio Sliders,
   * shader uniforms, MIDI gates, BiquadLP cutoffs, the lot.
   *
   * The address field is the OSC address pattern this node listens
   * to. Exact match (e.g. "/synth/freq") or single-segment wildcards
   * ("/synth/*" matches "/synth/freq" + "/synth/cutoff" but NOT
   * "/synth/sub/freq"). "?" matches one character.
   *
   * On the audio side this is a GammaSlider-shaped class with four
   * setters; the editor pushes incoming OSC arg values via setter
   * postMessages to the worklet (same path Slider drags use) so
   * downstream C++ classes see them update each quantum.
   *
   * On the visual side the wired-param resolver reads node.params.v1..v4
   * directly (no SAB round-trip needed -- the param is already the
   * live value). Drop one of these on any shader node's reactive
   * input and you've got a TouchOSC layout driving the visual layer. */
  OscIn: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaOscIn",
    helperClass:
`class GammaOscIn {
    float v1_ = 0.f;
    float v2_ = 0.f;
    float v3_ = 0.f;
    float v4_ = 0.f;
public:
    void setV1(float v) { v1_ = v; }
    void setV2(float v) { v2_ = v; }
    void setV3(float v) { v3_ = v; }
    void setV4(float v) { v4_ = v; }
    struct Out { float v1, v2, v3, v4; };
    Out operator()() { Out o; o.v1 = v1_; o.v2 = v2_; o.v3 = v3_; o.v4 = v4_; return o; }
};`,
    ins: [],
    outs: [
      { n: "v1", t: "param", access: ".v1" },
      { n: "v2", t: "param", access: ".v2" },
      { n: "v3", t: "param", access: ".v3" },
      { n: "v4", t: "param", access: ".v4" }
    ],
    params: {
      address: "/gamma/in",
      v1: 0, v2: 0, v3: 0, v4: 0
    },
    methods: { v1: "setV1", v2: "setV2", v3: "setV3", v4: "setV4" },
    autoExpose: ["v1", "v2", "v3", "v4"],
    uiOnlyParams: ["address"],
    description: "External OSC input. Subscribes to an OSC address pattern via the gamma-compile-server's OSC bridge; exposes the first four numeric args of each matching message as v1..v4 param outputs. Address supports exact match (\"/synth/freq\"), single-segment wildcard (\"/synth/*\"), and '?' for single-char (\"/cc/??\"). For full wildcards across segments use the daemon's UDP port (9000 by default) -- the bridge fans-out to every connected client. To use: start gamma-compile-server (the editor's status pill turns from grey to phosphor when the OSC bridge is reachable), set this node's address, point your OSC source at udp://<server-host>:9000."
  },

  /* v0.3.47 -- OscOut. Sends outbound OSC messages from the editor
   * through the compile-server's bridge. JS-side only -- no codegen,
   * no audio-worklet path. Each rAF tick the editor reads the current
   * JS-side value of each wired v1..v4 input (Slider.value,
   * HandLandmarker.h1_pinch, OscIn.v1, MasterClock.beat, etc) and
   * forwards them as an OSC bundle when any have changed.
   *
   * host + port override the daemon's default destination (configured
   * via --oscOutHost / --oscOutPort flags). Leave both blank to send
   * to the daemon's default target. The whole message is suppressed
   * when no inputs are wired, so an idle OscOut node is silent.
   *
   * Note: audio-side-only signals (e.g. an LFO compiled into the
   * worklet that has no JS-readable mirror) currently can't be sent
   * via OscOut. Wire through an intermediate Slider if you need that;
   * a SAB-mirror path for arbitrary audio-rate sources is a future
   * follow-up. */
  OscOut: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "",
    ins: [
      { n: "v1", t: "param" },
      { n: "v2", t: "param" },
      { n: "v3", t: "param" },
      { n: "v4", t: "param" }
    ],
    outs: [],
    params: {
      address: "/gamma/out",
      host: "",
      port: 0
    },
    methods: {},
    uiOnlyParams: ["address", "host", "port"],
    description: "Send OSC messages to an external app via the gamma-compile-server's OSC bridge. Each frame the editor reads the JS-side resolved value of every wired v1..v4 input + sends them as a single OSC message at the configured address. host + port override the daemon's default destination (leave blank to use the --oscOutHost / --oscOutPort defaults). Only forwards messages when at least one input value has changed since the last tick -- silent when idle. Audio-side-only signals can't be sent directly; wire through a Slider first if you need an audio-only source on OSC."
  },

  /* Sprint 7.5.3a -- Camera. Emits a `camera` port carrying view +
   * projection matrices to a Scene sink. Pure JS-side; no codegen
   * (matrices are evaluated at render time in _evaluateCamera).
   *
   * Defaults place the camera at (0, 0, 5) looking at the origin
   * with +Y up + a 60° vertical fov. That's a "general 3D viewer"
   * starting point; the first Box / DebugTriangle dropped into a
   * Scene with this Camera will be visible without further wiring.
   *
   * mode picks projection: 0 = perspective (uses fov), 1 = ortho
   * (uses orthoSize as the world-units-tall half-height; horizontal
   * derived from framebuffer aspect). near + far are world-space
   * clip distances. */
  Camera: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "camera",
    ins: [
      { n: "posX",    t: "param" },
      { n: "posY",    t: "param" },
      { n: "posZ",    t: "param" },
      { n: "targetX", t: "param" },
      { n: "targetY", t: "param" },
      { n: "targetZ", t: "param" },
      { n: "fov",     t: "param" },
      { n: "near",    t: "param" },
      { n: "far",     t: "param" },
      { n: "mode",    t: "param" },
      { n: "orthoSize", t: "param" }
    ],
    outs: [{ n: "camera", t: "camera" }],
    params: {
      posX: 0, posY: 0, posZ: 5,
      targetX: 0, targetY: 0, targetZ: 0,
      upX: 0, upY: 1, upZ: 0,
      fov: 60, near: 0.1, far: 100,
      mode: 0,
      orthoSize: 4
    },
    methods: {},
    paramOptions: { mode: ["perspective", "ortho"] },
    uiOnlyParams: ["upX", "upY", "upZ"],
    description: "3D camera. Wire its `camera` output into a Scene sink. Position + target are world-space points (camera looks from posX/Y/Z toward targetX/Y/Z); fov is vertical field-of-view in degrees (perspective mode); orthoSize is world-units half-height (ortho mode); near + far are clip distances. Up vector defaults to +Y; advanced users can edit it via the upX/upY/upZ uiOnly params for unusual orientations. All scalar params accept wires -- modulate the camera position from a MasterClock for orbit cameras, or from MediaPipe hands for VR-like control."
  },

  /* Phase 7 §5.5.f -- FPCamera. First-person camera for walking
   * through terrain demos AND flying around planets in 6DoF. Controls:
   *   WASD    move (W=forward, S=back, A/D=strafe)
   *   IJKL    pitch + yaw (I/K=pitch, J/L=yaw) -- works WITHOUT lock
   *   U/O     roll (flight mode only -- spacecraft-style)
   *   Mouse   pitch + yaw (after canvas click locks)
   *   Space   up (flight mode -- planet-radial if a planet's in patch)
   *   C/Ctrl  down (flight mode -- planet-radial)
   *   Shift   sprint (×4)
   *   X/Z     +/- walkSpeed (geometric 4×/sec, [1 m/s, 50 km/s])
   * walkMode (default 1) locks posY to terrain surface + eyeHeight.
   * walkMode=0 is true 6DoF: forward+up basis on the node, all
   * rotations are camera-local (proper spacecraft, no Euler gimbal
   * snap). Output shape matches Camera (posX/Y/Z + targetX/Y/Z +
   * upX/Y/Z + fov + near + far) so Scene reads a standard cam. */
  FPCamera: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "camera",
    ins: [
      { n: "posX",             t: "param" },
      { n: "posY",             t: "param" },
      { n: "posZ",             t: "param" },
      { n: "yaw",              t: "param" },
      { n: "pitch",            t: "param" },
      { n: "fov",              t: "param" },
      { n: "near",             t: "param" },
      { n: "far",              t: "param" },
      { n: "walkMode",         t: "param" },
      { n: "walkSpeed",        t: "param" },
      { n: "lookSpeed",        t: "param" },
      { n: "mouseSensitivity", t: "param" },
      { n: "eyeHeight",        t: "param" }
    ],
    outs: [{ n: "camera", t: "camera" }],
    params: {
      posX: 0, posY: 2, posZ: 0,
      yaw: 0, pitch: 0,
      fov: 75, near: 0.1, far: 3000,
      walkMode: 1,                 // 1 = walk on ground; 0 = fly free
      walkSpeed: 10,               // meters/sec at 1u=1m
      lookSpeed: 2.0,              // radians/sec for IJKL
      mouseSensitivity: 0.0025,
      eyeHeight: 1.7,
      // Computed each tick; written into params so _evaluateCamera
      // reads the same shape as Camera. Hidden from the UI.
      targetX: 0, targetY: 2, targetZ: 1,
      mode: 0,
      orthoSize: 4,
      upX: 0, upY: 1, upZ: 0
    },
    methods: {},
    uiOnlyParams: ["targetX", "targetY", "targetZ", "mode", "orthoSize", "upX", "upY", "upZ"],
    description: "First-person camera. WASD walks/strafes, IJKL pitch+yaw (no pointer-lock required), Shift sprints (×4). walkMode=1 (default) clamps posY to terrainHeight + eyeHeight by sampling the patch's first TiledTerrain. walkMode=0 is 6DoF spacecraft flight: U/O roll, Space/Ctrl move along planet-radial up/down (when a Planet/PlanetMesh/PlanetMap is in the patch -- world Y otherwise), all rotations are camera-local so there's no gimbal-lock when looking near 'up'. The flight orientation is carried as forward (= target - pos) + upX/Y/Z; demos can pre-set these to spawn the camera at any pose, e.g. tangent to a planet's equator. Optional mouse-look: click the canvas to lock; ESC releases. Output shape matches Camera (posX/Y/Z + targetX/Y/Z + upX/Y/Z + fov + near + far) so wire `camera` into a Scene like any other camera. Defaults: fov 75°, far 3000m, walkSpeed 10 m/s, eyeHeight 1.7 m. mouseSensitivity = radians/pixel (default 0.0025). lookSpeed = radians/sec for IJKL/UO (default 2.0)."
  },

  /* Sprint 8.0.2-e -- OrthoCamera2D. Pixel-perfect orthographic
   * camera designed to feed Scene2D. orthoSize is the world-units
   * half-height of the visible viewport; horizontal half-width is
   * derived from framebuffer aspect (matches Camera's ortho mode).
   * pixelSnap (1 = on, default) rounds posX/posY to the nearest
   * 1/pixelsPerUnit when the camera evaluates, eliminating sub-
   * pixel scroll jitter on retro sprite art. Output is the same
   * camera object shape as Camera/FPCamera, so it's interchangeable
   * for any scene that wants ortho 2D. */
  OrthoCamera2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "camera",
    ins: [
      { n: "posX",          t: "param" },
      { n: "posY",          t: "param" },
      { n: "orthoSize",     t: "param" },
      { n: "near",          t: "param" },
      { n: "far",           t: "param" },
      { n: "pixelSnap",     t: "param" },
      { n: "pixelsPerUnit", t: "param" }
    ],
    outs: [{ n: "camera", t: "camera" }],
    params: {
      posX: 0, posY: 0,
      orthoSize: 4,
      near: -100, far: 100,
      pixelSnap: 1, pixelsPerUnit: 32,
      // Filled in by _evaluateCamera; the shape matches Camera so any
      // scene reading the camera object gets the same fields. Hidden.
      posZ: 0, targetX: 0, targetY: 0, targetZ: -1,
      upX: 0, upY: 1, upZ: 0,
      fov: 60, mode: 1
    },
    methods: {},
    uiOnlyParams: ["posZ", "targetX", "targetY", "targetZ", "upX", "upY", "upZ", "fov", "mode"],
    description: "2D ortho camera. Pixel-perfect. posX/posY pan in world units; orthoSize is world-units half-height (e.g. orthoSize=4 means 8 units tall). near/far span +/-100 by default (Scene2D doesn't depth-test but the range lets you stack layers via Z if you want). pixelSnap (1=on) quantizes posX/posY to 1/pixelsPerUnit, so a posX wired to a continuous source (Slider, MasterClock) stays crisp without sub-pixel shimmer. Wire output into a Scene2D's `camera` input. For 3D ortho you want Camera with mode=ortho instead -- this node is the 2D specialization with pixel snap baked in."
  },

  /* Sprint 8.0.2-e -- OrthoCamera25D. Orthographic camera locked
   * to one of the classic 2.5D presets (isometric / hex / top-down).
   * posX/posY/posZ is the camera focus point in world space; yaw +
   * pitch are derived from the angle preset, then the camera position
   * is offset along (-forward) by `distance`. orthoSize controls the
   * world-units half-height of the viewport.
   *
   * Presets (angle param):
   *   "iso"        45° yaw, 30° pitch  -- classic isometric
   *   "iso-narrow" 30° yaw, 45° pitch  -- "narrow" iso (Diablo / Hades)
   *   "top-down"    0° yaw, 90° pitch  -- straight top
   *   "side"        0° yaw,  0° pitch  -- pure side view (platformer)
   *   "custom"     uses yaw + pitch params directly
   *
   * Output shape matches Camera (full posX/Y/Z + targetX/Y/Z + upX/Y/Z
   * + fov + mode) so wire into a Scene25D or any scene's `camera`
   * input. */
  OrthoCamera25D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "camera",
    ins: [
      { n: "posX",      t: "param" },
      { n: "posY",      t: "param" },
      { n: "posZ",      t: "param" },
      { n: "angle",     t: "param" },
      { n: "yaw",       t: "param" },
      { n: "pitch",     t: "param" },
      { n: "distance",  t: "param" },
      { n: "orthoSize", t: "param" },
      { n: "near",      t: "param" },
      { n: "far",       t: "param" }
    ],
    outs: [{ n: "camera", t: "camera" }],
    params: {
      posX: 0, posY: 0, posZ: 0,
      angle: "iso",
      yaw: 45, pitch: 30,
      distance: 20,
      orthoSize: 8,
      near: 0.1, far: 200,
      // Filled in by _evaluateCamera; same shape as Camera. Hidden.
      targetX: 0, targetY: 0, targetZ: 0,
      upX: 0, upY: 1, upZ: 0,
      fov: 60, mode: 1
    },
    methods: {},
    paramOptions: { angle: ["iso", "iso-narrow", "top-down", "side", "custom"] },
    uiOnlyParams: ["targetX", "targetY", "targetZ", "upX", "upY", "upZ", "fov", "mode"],
    description: "2.5D ortho camera. focusPoint = (posX, posY, posZ) is what the camera looks AT; the camera itself is placed `distance` away along -forward, where forward is derived from yaw + pitch. `angle` param selects a preset orientation: iso (45°/30°, classic isometric), iso-narrow (30°/45°, Diablo / Hades style), top-down (0°/90°), side (0°/0°, platformer), custom (uses yaw + pitch directly). orthoSize is world-units half-height of the viewport. Wire output into Scene25D for proper sprite Y-sorting against terrain, or any other scene's `camera` input."
  },

  /* ── Phase 8.B.15 -- ThirdPersonCamera (follow / orbit) ──────────── */
  ThirdPersonCamera: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "camera",
    ins: [
      { n: "targetX", t: "param" }, { n: "targetY", t: "param" }, { n: "targetZ", t: "param" },
      { n: "mode", t: "param" },
      { n: "distance", t: "param" }, { n: "height", t: "param" },
      { n: "orbitYaw", t: "param" }, { n: "orbitPitch", t: "param" },
      { n: "shoulder", t: "param" },
      { n: "fov", t: "param" }, { n: "near", t: "param" }, { n: "far", t: "param" },
      { n: "orthoSize", t: "param" }, { n: "smooth", t: "param" }
    ],
    outs: [
      { n: "camera", t: "camera" },
      { n: "yaw", t: "param" }
    ],
    params: {
      targetX: 0, targetY: 1, targetZ: 0,
      mode: 0,                 // 0 follow · 1 over-shoulder · 2 top-down · 3 2.5d · 4 2d-side
      distance: 6, height: 2.4,
      orbitYaw: 0, orbitPitch: -12, shoulder: 0.9,
      fov: 60, near: 0.1, far: 400, orthoSize: 7, smooth: 0.18,
      // computed each tick (consumed by _evaluateCamera lookAt path)
      posX: 0, posY: 2.4, posZ: 6,
      upX: 0, upY: 1, upZ: 0, yaw: 0
    },
    paramOptions: { mode: ["follow", "over-shoulder", "top-down", "2.5d", "2d-side"] },
    uiOnlyParams: ["posX", "posY", "posZ", "upX", "upY", "upZ", "yaw"],
    description: "Third-person follow camera with game-engine rigs. Tracks (targetX/Y/Z) — wire a character's x/y/z. mode: 0 = follow (close behind at `distance`/`height`, orbitYaw/orbitPitch aim it), 1 = over-shoulder (TPS — same trail but shifted to one side by `shoulder` so the character frames off-centre), 2 = top-down (high overhead, slight tilt), 3 = 2.5D (fixed ¾ perspective), 4 = 2D side (orthographic along -Z, `orthoSize` frames it). `distance` = trail distance, `height` = rig lift, `shoulder` = lateral offset (over-shoulder), `smooth` lerps the follow (0 = instant, ~0.2 = lazy). Aims slightly above the target (upper body) so the character isn't bottom-edge. Outputs `yaw` (camera heading °) — wire into BlobController3D.camYaw so movement stays camera-relative. Wire `camera` into any Scene3D.camera. Changing `mode` mid-level morphs the rig (used for the 'smooshed to 2D' level)."
  },

  /* Sprint platformer-1 -- KeyAxis2D. Game-style keyboard input.
   * Emits x/y as -1..1 axis values (released = 0; left/right combine
   * to signed); jump/actionA/actionB as one-frame rising-edge pulses
   * (1 on the frame the key was pressed, 0 otherwise). Default key
   * bindings use WASD + ArrowKeys for movement, Space for jump,
   * Z/X for the two action buttons. All bindings are params, so
   * the user can rebind to taste. Per-frame tick lives in
   * _tickGameInputs which lazy-wires the document listeners. */
  KeyAxis2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "game-input",
    ins: [
      { n: "keyLeft",    t: "param" },
      { n: "keyRight",   t: "param" },
      { n: "keyUp",      t: "param" },
      { n: "keyDown",    t: "param" },
      { n: "keyJump",    t: "param" },
      { n: "keyActionA", t: "param" },
      { n: "keyActionB", t: "param" }
    ],
    outs: [
      { n: "x",       t: "param" },
      { n: "y",       t: "param" },
      { n: "jump",    t: "param" },
      { n: "actionA", t: "param" },
      { n: "actionB", t: "param" }
    ],
    params: {
      keyLeft: "KeyA",  keyRight: "KeyD",
      keyUp:   "KeyW",  keyDown:  "KeyS",
      keyJump: "Space", keyActionA: "KeyZ", keyActionB: "KeyX",
      // Output values; written by tick, read by downstream.
      x: 0, y: 0, jump: 0, actionA: 0, actionB: 0
    },
    methods: {},
    uiOnlyParams: ["x", "y", "jump", "actionA", "actionB"],
    description: "Game keyboard input. Outputs x / y as signed (-1..1) axis values combining left/right and up/down key holds; jump / actionA / actionB are one-frame triggers that fire 1 on the frame the key is pressed (rising edge) and 0 otherwise. Defaults: WASD + Space for jump, Z/X for action buttons. Also accepts ArrowLeft/ArrowRight/etc -- bind via key params using KeyboardEvent.code strings (KeyA, ArrowUp, Space, KeyZ, ...)."
  },

  /* Sprint platformer-1 -- PlatformerBody2D. Composite character
   * controller: takes axis-style input + jump trigger + physics
   * tuning, runs the standard 2D platformer integration each frame
   * (horizontal velocity = input*walkSpeed, vertical velocity = grav
   * accumulation, jump impulse on rising edge while grounded, simple
   * AABB ground clamp), outputs the resulting x/y/vx/vy + grounded
   * flag + facing direction. Drop this between a KeyAxis2D and the
   * Sprite/Translate driving the player; wire 'x' and 'y' into the
   * Translate's x/y params.
   *
   * groundY is the world-Y of the floor (anything below clamps to
   * this height). For real level collision, a future sprint will
   * add a 'platforms' input that takes a Tilemap or rect list. */
  PlatformerBody2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "game-body",
    ins: [
      { n: "tilemap",    t: "mesh"  },
      { n: "inputX",     t: "param" },
      { n: "jump",       t: "param" },
      { n: "walkSpeed",  t: "param" },
      { n: "gravity",    t: "param" },
      { n: "jumpForce",  t: "param" },
      { n: "airControl", t: "param" },
      { n: "width",      t: "param" },
      { n: "height",     t: "param" },
      { n: "groundY",    t: "param" },
      { n: "initX",      t: "param" },
      { n: "initY",      t: "param" },
      { n: "reset",      t: "param" }
    ],
    outs: [
      { n: "x",        t: "param" },
      { n: "y",        t: "param" },
      { n: "vx",       t: "param" },
      { n: "vy",       t: "param" },
      { n: "grounded", t: "param" },
      { n: "facing",   t: "param" }
    ],
    params: {
      inputX: 0, jump: 0,
      walkSpeed: 6, gravity: 22, jumpForce: 11, airControl: 1,
      width: 0.6, height: 1.0,
      groundY: -100,
      initX: 0, initY: 1, reset: 0,
      // Internal state + outputs. Written by tick.
      x: 0, y: 1, vx: 0, vy: 0, grounded: 0, facing: 1,
      _inited: 0, _prevReset: 0
    },
    methods: {},
    uiOnlyParams: ["x", "y", "vx", "vy", "grounded", "facing", "_inited", "_prevReset"],
    description: "2D platformer character body. Takes inputX (-1..1, e.g. KeyAxis2D.x) + jump (one-frame edge, e.g. KeyAxis2D.jump) + tuning params (walkSpeed m/s, gravity m/s², jumpForce m/s impulse, airControl 0..1 multiplier when not grounded), runs the standard platformer integration each frame, outputs the resulting (x, y, vx, vy) + grounded flag + facing direction (-1 = left, 1 = right). Wire x/y into a Translate driving the player Sprite. width/height define the player AABB (anchored bottom-center: y is the FEET line). When a Tilemap2D is wired into `tilemap` (or auto-discovered as the first Tilemap2D in the patch), the body collides AABB-vs-tiles per axis: walks into walls, lands on platform tops, bonks ceilings. groundY is a safety floor for when the player walks off the tilemap (default -100, set to your level's actual floor for tighter behavior)."
  },

  /* ── Phase 8.B.15 -- BlobController3D (3D character controller) ──── */
  BlobController3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-control-3d",
    ins: [
      { n: "world", t: "param" }, { n: "body", t: "param" },
      { n: "inputX", t: "param" }, { n: "inputZ", t: "param" }, { n: "jump", t: "param" },
      { n: "moveSpeed", t: "param" }, { n: "jumpSpeed", t: "param" },
      { n: "camYaw", t: "param" }, { n: "airControl", t: "param" },
      { n: "planeLock", t: "param" }, { n: "enabled", t: "param" }
    ],
    outs: [
      { n: "grounded", t: "param" }, { n: "facing", t: "param" },
      { n: "vx", t: "param" }, { n: "vz", t: "param" }, { n: "speed", t: "param" },
      { n: "jumped", t: "param" }
    ],
    params: {
      inputX: 0, inputZ: 0, jump: 0,
      moveSpeed: 6, jumpSpeed: 8, camYaw: 0, airControl: 0.6,
      planeLock: 0, enabled: 1,
      grounded: 0, facing: 0, vx: 0, vz: 0, speed: 0, jumped: 0,
      _prevJump: 0
    },
    methods: {},
    uiOnlyParams: ["grounded", "facing", "vx", "vz", "speed", "jumped", "_prevJump"],
    description: "Camera-relative 3D character controller for a capsule RigidBody3D (wire the body's bodyId into `body`, PhysicsWorld3D.world into `world`). Each physics tick: rotate (inputX, inputZ) by `camYaw` so 'forward' is away from the camera, drive the body's horizontal velocity toward goal·moveSpeed (lerped by `airControl` while airborne), and on a `jump` rising edge while grounded set upward velocity = jumpSpeed + emit a one-frame `jumped` pulse (wire → a jump-SFX envelope gate). Ground is detected with a short downward raycast. Outputs grounded, facing (deg, horizontal velocity heading), vx/vz, speed, jumped. `planeLock`=1 zeroes Z motion + pulls Blob back to z=0 (the 'smooshed to 2D' level). Pairs with ThirdPersonCamera (wire its `yaw` → camYaw)."
  },

  /* Sprint AnimationState2D -- universal sprite state machine. Reads
   * velocity + grounded + facing signals (typically from a
   * PlatformerBody2D, but anything that writes numeric vx/vy/grounded
   * works), derives a state name (idle / walk / jump / fall), advances
   * a per-state frame loop at configurable fps, outputs a frame index
   * suitable for wiring straight into Sprite.frame.
   *
   * Frame ranges are declared as comma + range strings per state slot:
   *   "0"          → single frame
   *   "0,1,2"      → loop those three
   *   "0-3"        → 0,1,2,3 (range expansion)
   *   "0,1,2,3,2,1" → ping-pong by listing both directions
   * Out-of-range frames (past framesX*framesY-1) are clamped at the
   * Sprite shader so a misconfigured cycle never crashes -- you'll
   * just see the last valid frame stuck on.
   *
   * Character-agnostic by design: the same node drives players,
   * enemies, NPCs, projectiles -- anything with a sprite sheet that
   * needs state-driven frame playback. "Fox-wire" was just the first
   * use site; nothing in this node knows about foxes. */
  AnimationState2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "game-anim",
    ins: [
      { n: "vx",            t: "param" },
      { n: "vy",            t: "param" },
      { n: "grounded",      t: "param" },
      { n: "facing",        t: "param" },
      { n: "fps",           t: "param" },
      { n: "walkThreshold", t: "param" },
      { n: "idleFrames",    t: "param" },
      { n: "walkFrames",    t: "param" },
      { n: "jumpFrames",    t: "param" },
      { n: "fallFrames",    t: "param" }
    ],
    outs: [
      { n: "frame",    t: "param" },
      { n: "flipX",    t: "param" },
      { n: "stateIdx", t: "param" }
    ],
    params: {
      vx: 0, vy: 0, grounded: 1, facing: 1,
      fps: 8,
      // Magnitude of vx above which idle → walk. 0.1 m/s catches
      // analog-stick deadzone overflow + integer rounding noise
      // without false-triggering on a stationary character.
      walkThreshold: 0.1,
      // Default ranges assume a 4-frame walk sheet laid out
      // [idle, walk-a, walk-b, jump] in row-major order. Tweak
      // per-character; framesX/framesY come from the Sprite.
      idleFrames: "0",
      walkFrames: "1,2,1,3",
      jumpFrames: "4",
      fallFrames: "5",
      // Outputs + internal state. Written by tick.
      frame: 0, flipX: 0, stateIdx: 0,
      _animTime: 0, _lastState: ""
    },
    methods: {},
    uiOnlyParams: ["vx", "vy", "grounded", "facing", "frame", "flipX", "stateIdx", "_animTime", "_lastState"],
    description: "Universal sprite-sheet state machine. Reads vx/vy/grounded/facing (typically from PlatformerBody2D's outputs) and picks a state: !grounded + vy>0 → jump, !grounded + vy≤0 → fall, |vx|>walkThreshold → walk, else idle. Each state has a frame-range param (e.g. \"0\", \"0,1,2,3,2,1\", \"0-5\"); the node advances through the active cycle at `fps` and emits the current frame index, ready to wire into Sprite.frame. `flipX` is derived from `facing` (-1 → 1, +1 → 0), assuming sprites face right by default. `stateIdx` (0=idle, 1=walk, 2=jump, 3=fall) is exposed for downstream wiring (e.g. trigger different audio per state). State changes restart the cycle at frame 0 so transitions look snappy."
  },

  /* Sprint platformer-level-1 -- PickupCollector. Generic tile-pickup
   * mechanic. Each tick, finds cells matching `tileChar` in the wired
   * Tilemap2D (or first Tilemap2D in the patch), checks AABB overlap
   * vs the wired body (or first PlatformerBody2D), and on hit replaces
   * the cell with '.' (so it vanishes from the rendered mesh) while
   * bumping the `collected` counter. `total` is the count at first
   * frame -- useful for "Eggs N / M" HUDs.
   *
   * Default tileChar is '4' (matches Tilemap2D's pickup convention).
   * Set to '6'/'7'/etc for additional collectible types in the same
   * level; one PickupCollector per type, all watching the same map. */
  PickupCollector: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "game-behavior",
    ins: [
      { n: "tilemap",  t: "mesh"  },
      { n: "body",     t: "param" },
      { n: "tileChar", t: "param" },
      { n: "reset",    t: "param" }
    ],
    outs: [
      { n: "collected", t: "param" },
      { n: "total",     t: "param" },
      { n: "remaining", t: "param" },
      { n: "done",      t: "param" }
    ],
    params: {
      tileChar:  "4",
      collected: 0,
      total:     0,
      remaining: 0,
      done:      0,
      _inited:   0
    },
    methods: {},
    uiOnlyParams: ["collected", "total", "remaining", "done", "_inited"],
    description: "Tile-based pickup collector. Scans a wired Tilemap2D (or Level2D's first collidable tilemap layer) for cells matching `tileChar` (default '4'); on first frame, counts them into `total` AND snapshots the original tileData. Each subsequent tick, checks the wired body's AABB vs every uncollected cell; on overlap, mutates the tilemap (cell → '.') and increments `collected`. On rising edge of `reset`, restores the tilemap to the snapshot + zeros collected/done/remaining so all pickups respawn. Outputs collected / total / remaining / done (= 1 when all picked up). Pair with LevelGoal2D for level-completion logic that also requires all pickups."
  },

  /* Sprint platformer-level-1 -- LevelGoal2D. Detects the player
   * reaching a goal tile ('5' by default). Latches once -- once
   * reached, the `reached` output stays at 1 even if the player
   * walks back. Wire it into a HUDText to show a "GOAL!" message
   * or into a Scene2D state machine for end-of-level transitions. */
  LevelGoal2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "game-behavior",
    ins: [
      { n: "tilemap",  t: "mesh"  },
      { n: "body",     t: "param" },
      { n: "tileChar", t: "param" },
      { n: "reset",    t: "param" }
    ],
    outs: [
      { n: "reached", t: "param" }
    ],
    params: {
      tileChar: "5",
      reached:  0
    },
    methods: {},
    uiOnlyParams: ["reached"],
    description: "Detects when the player reaches a goal tile ('5' by default) in the wired Tilemap2D (or Level2D's first collidable tilemap layer). Latches on first AABB overlap -- `reached` stays 1 once tripped. On rising edge of `reset`, the latch clears (reached → 0). Pair with HUDText to show 'GOAL!' and / or with PickupCollector.done to require both: \"all eggs collected AND flag touched\"."
  },

  /* ── Phase 8.A.1 -- Lifecycle event nodes ─────────────────────
   * Per-scene lifecycle gates: a downstream node wired to one of
   * these reads a numeric 0/1 trigger value (1 = HIGH this frame).
   * OnUpdate also outputs dt (seconds since last frame).
   *
   * Phase order on a fresh load:
   *   frame 0:   OnAwake.trigger = 1
   *   frame 1:   OnStart.trigger = 1
   *   frame 2+:  OnUpdate.trigger = 1 every frame
   *
   * On scene reset (_resetLifecycle):
   *   next frame: OnDestroy.trigger = 1   (one-shot)
   *   frame +1:   OnAwake.trigger = 1     (cycle restarts)
   *   frame +2:   OnStart.trigger = 1
   *   frame +3+:  OnUpdate.trigger = 1
   *
   * Trigger ports are typed `param` (not `gate`) so the existing
   * _resolveNodeParams + _readWireJsSideValue machinery substitutes
   * the value into any param-typed downstream input. Consumers
   * (StateMachine transitions, Reset actions) treat value >= 0.5
   * as triggered. Avoids needing a parallel gate-resolution path. */
  OnAwake: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "lifecycle",
    ins: [],
    outs: [
      { n: "trigger",   t: "param" },
      { n: "fireCount", t: "param" }
    ],
    params: { trigger: 0, fireCount: 0 },
    methods: {},
    uiOnlyParams: ["trigger", "fireCount"],
    description: "Fires once on scene load, BEFORE OnStart. Use for setup that doesn't depend on other nodes (caching params, resetting counters). `trigger` is 1 for exactly one frame, then 0 -- wire this into a Reset action or StateMachine transition. `fireCount` is a persistent counter: 1 after first load, 2 after first resetScene(), etc. -- wire this into a HUDText to verify Awake fired even if you missed the one-frame pulse."
  },

  OnStart: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "lifecycle",
    ins: [],
    outs: [
      { n: "trigger",   t: "param" },
      { n: "fireCount", t: "param" }
    ],
    params: { trigger: 0, fireCount: 0 },
    methods: {},
    uiOnlyParams: ["trigger", "fireCount"],
    description: "Fires once on scene load, AFTER all OnAwakes have completed (so cross-node references are valid). `trigger` is 1 for one frame; `fireCount` is a persistent counter (1 after first load). Most common entry point for game-state setup: wire `trigger` to a StateMachine transition or to a Reset to restore initial values. After Reset, OnStart fires one frame after OnAwake."
  },

  OnUpdate: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "lifecycle",
    ins: [],
    outs: [
      { n: "trigger",   t: "param" },
      { n: "dt",        t: "param" },
      { n: "elapsed",   t: "param" },
      { n: "fireCount", t: "param" }
    ],
    params: { trigger: 0, dt: 0, elapsed: 0, fireCount: 0 },
    methods: {},
    uiOnlyParams: ["trigger", "dt", "elapsed", "fireCount"],
    description: "Fires every frame while the scene is active. `trigger` stays HIGH (1) continuously; `dt` is seconds since last frame (clamped 1/30 max); `elapsed` is total seconds since the current Awake (resets to 0 on each Reset); `fireCount` is the frame counter since current Awake (60 per second). For per-frame logic that doesn't fit into an existing tick node -- timers, custom interpolators."
  },

  OnDestroy: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "lifecycle",
    ins: [],
    outs: [
      { n: "trigger",   t: "param" },
      { n: "fireCount", t: "param" }
    ],
    params: { trigger: 0, fireCount: 0 },
    methods: {},
    uiOnlyParams: ["trigger", "fireCount"],
    description: "Fires once when the stage is reset or transitioned away from, BEFORE OnAwake fires again. `trigger` is 1 for one frame; `fireCount` is persistent (0 before any reset, 1 after first reset, etc). Use `trigger` for cleanup (saving state) and `fireCount` to verify a reset actually happened. Fires when resetStage() is invoked OR when a StageManager transitions away from this node's stage (set node.stage to bind a lifecycle node to a specific stage; leave it null for global lifecycle that survives stage changes)."
  },

  /* EdgeCount -- rising-edge counter with optional max + reset.
   * Useful for "fired N shots", "collected N items", any case where
   * you need to react to a button being clicked N times without
   * a dedicated tick handler in another node. */
  EdgeCount: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "lifecycle",
    ins: [
      { n: "trigger", t: "param" },
      { n: "reset",   t: "param" },
      { n: "max",     t: "param" }
    ],
    outs: [
      { n: "count",    t: "param" },
      { n: "limitHit", t: "param" },
      { n: "remaining",t: "param" }
    ],
    params: { trigger: 0, reset: 0, max: 3, count: 0, limitHit: 0, remaining: 3 },
    methods: {},
    uiOnlyParams: ["trigger", "reset", "count", "limitHit", "remaining"],
    description: "Counts rising edges on `trigger` (0→1 transitions). `max` sets a cap (default 3). When `count >= max`, `limitHit` latches to 1. `reset` (rising edge) clears the count. `remaining` is `max - count`. Wire a UIButton.clicked to trigger and limitHit to a StateMachine.transN to end a round after N clicks."
  },

  /* ── Phase 8.A.2 -- StageManager (state-container) ────────────────
   * Groups nodes into named "stages" (menu, playing, gameover, etc).
   * Only one stage is active at a time; switching unloads the old
   * stage (OnDestroy fires for lifecycle nodes in that stage) and
   * loads the new one (OnAwake -> OnStart -> OnUpdate).
   *
   * Distinct from Scene2D / Scene25D / Scene3D, which are RENDER
   * TARGETS (WebGPU scene sinks). A Scene2D LIVES IN a stage; when
   * its stage goes inactive, it stops rendering. Future sub-sprints
   * filter gameplay ticks + mesh emission by active stage.
   *
   * Convention: at most ONE StageManager per patch. Multiple are
   * permitted (nested state machines) but only the first found is
   * authoritative for global lifecycle dispatch. */
  StageManager: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "stage-manager",
    ins: [
      { n: "active", t: "param" },
      { n: "in0", t: "texture" },
      { n: "in1", t: "texture" },
      { n: "in2", t: "texture" },
      { n: "in3", t: "texture" }
    ],
    outs: [
      { n: "out",              t: "texture" },
      { n: "current",         t: "param" },
      { n: "transitioning",   t: "param" },
      { n: "transitionCount", t: "param" },
      { n: "active0",         t: "param" },
      { n: "active1",         t: "param" },
      { n: "active2",         t: "param" },
      { n: "active3",         t: "param" }
    ],
    params: {
      stages: "stage1,stage2",
      active: 0,
      current: 0,
      transitioning: 0,
      transitionCount: 0,
      active0: 0, active1: 0, active2: 0, active3: 0
    },
    methods: {},
    uiOnlyParams: ["current", "transitioning", "transitionCount", "active0", "active1", "active2", "active3"],
    description: "Stage router + state container. `stages` is a comma-separated list of stage names. Wire Scene2D outputs into texture inputs in0..in3 (one per stage); StageManager routes the active scene's texture to its `out` output — wire that to VisualOutput. active0..active3 are per-stage boolean outputs (1 when that stage is active) — wire to UIButton.show / UIText.show for stage-gated visibility. `active` selects the stage index. Wire StateMachine.current → active for FSM-driven transitions."
  },

  /* ── Phase 8.A.3 -- PrefabInstance ────────────────────────────────
   * Drops a SAVED subgraph as a reusable template, instantiated as
   * many times as needed with per-instance param overrides.
   *
   * Internals: when an instance is created, _expandPrefabInstance
   * spawns the template's nodes + edges into state.nodes with a
   * `prefabParentId` tag binding each child back to its instance.
   * Children are HIDDEN in the canvas view (render() skips them)
   * but tick + render normally otherwise -- the existing infra
   * (lifecycle, gameplay ticks, mesh resolver) handles them as
   * regular nodes.
   *
   * Exposed params on the template become regular fields on the
   * instance node -- editing them in the props panel propagates
   * to the corresponding child node each tick.
   *
   * Exposed ports let external wires connect to internal nodes:
   * a wire from `instance.mesh` is intercepted by _resolveSceneMeshes
   * and walks the actual exposed child instead. v1 supports a fixed
   * single mesh output; future versions will allow arbitrary
   * exposedPorts shapes (audio in / param in / mesh in etc).
   *
   * templateInline is the full template subgraph as JSON, embedded
   * directly in the instance node. After §8.A.6 ships asset
   * references, instances will reference templates by stable ID
   * with edit-template-propagates-live semantics. */
  /* ── Phase 8.A.4 -- MeshWorldPosition ─────────────────────────────
   * Readback for transform hierarchies. Takes a mesh chain on its
   * input and reports the world-space position of the chain's
   * effective origin (matrix * (0,0,0,1) = the matrix's translation
   * column).
   *
   * The editor already composes nested transforms via mesh-chain
   * wires (Box -> Translate(local) -> Translate(parent) -> Scene
   * produces parent * local at the leaf, which is exactly the
   * Unity/Godot parent-child world matrix). What was missing: a way
   * to ASK what that final world position is, so cameras / AI /
   * triggers / HUDs can track it without recomputing the chain by
   * hand. */
  MeshWorldPosition: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "query",
    ins: [
      { n: "mesh", t: "mesh" }
    ],
    outs: [
      { n: "worldX", t: "param" },
      { n: "worldY", t: "param" },
      { n: "worldZ", t: "param" }
    ],
    params: {},
    methods: {},
    description: "Reads back the world-space position of a mesh chain's origin. Wire any mesh into the input -- the node walks the chain (Box / Sprite / Tilemap2D leaf through any number of Translate / Rotate / Scale transforms), accumulates the world matrix, and exposes its translation column on worldX / Y / Z. Use this when a child node deeper in the transform chain needs its world position read by an external consumer: cameras following a hand-drawn parent + offset, HUDs showing 'distance to goal' computed from two endpoints, AI targeting a player whose mesh is several transforms deep, etc. Recomputed per-read (cheap; a single chain walk + 4x4 multiplies)."
  },

  /* ── Phase 8.D.1 -- core UI nodes (UIButton / UIText / UIPanel) ───
   * Interactive on-screen widgets. Each renders to its own canvas
   * overlay (same pattern as HUDText), absolutely positioned via
   * corner + x/y offset. UIButton catches pointer events and fires
   * `clicked` for one tick on each release-within-bounds.
   *
   * Every UI node (and HUDText) supports a customRender JS string:
   * when non-empty, the editor runs `new Function("ctx", "p", "input",
   * customRender)` each frame instead of the default render. ctx is
   * the canvas 2d context; p is node.params; input has { hovered,
   * width, height, mouseX, mouseY }. Edit the customRender field in
   * the props panel for fully custom canvas drawing.
   *
   * Distinct from HUDText: HUD is read-only data display anchored to
   * screen edges; UI is interactive widgets with click handlers + an
   * explicit (x, y) position relative to a corner anchor. */
  UIButton: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "ui",
    ins: [
      { n: "show", t: "param" }
    ],
    outs: [
      { n: "clicked", t: "param" },
      { n: "hovered", t: "param" }
    ],
    params: {
      label:        "Button",
      x:            0,
      y:            0,
      width:        180,
      height:       48,
      color:        "#3a4a60",
      hoverColor:   "#5f7a98",
      textColor:    "#ffffff",
      borderColor:  "#9bd0ff",
      borderWidth:  1.5,
      borderRadius: 6,
      fontSize:     16,
      opacity:      0.95,
      corner:       "center",
      customRender: "",
      clicked:      0,
      hovered:      0
    },
    paramOptions: {
      corner: ["center", "top-left", "top-right", "bottom-left", "bottom-right"]
    },
    methods: {},
    uiOnlyParams: ["label", "color", "hoverColor", "textColor", "borderColor", "corner", "customRender", "clicked", "hovered"],
    description: "Clickable on-screen button. Anchored to a screen corner (or center) + (x, y) pixel offset. Fires `clicked` for one tick on pointer-up within the rect; `hovered` is 1 while the cursor is inside. Wire clicked into StateMachine.transN to make button presses drive state transitions. customRender = optional JS body (free vars: ctx, p, input) that overrides the default rounded-rect drawing for fully custom widgets."
  },

  UIText: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "ui",
    ins: [
      { n: "show", t: "param" },
      { n: "text", t: "param" }
    ],
    outs: [
      { n: "clicked", t: "param" },
      { n: "hovered", t: "param" }
    ],
    params: {
      text:         "Hello",
      x:            0,
      y:            0,
      fontSize:     24,
      color:        "#ffffff",
      align:        "center",
      opacity:      0.95,
      corner:       "center",
      // Phase 8.D.1 v2 -- when 1, UIText accepts pointer events
      // (hover ring, clicked pulse). When 0, the canvas is
      // pointer-events: none and clicked/hovered stay at 0.
      // Default 0 because text labels are usually passive --
      // setting it to 1 makes them link-style clickable.
      interactive:  0,
      customRender: "",
      clicked:      0,
      hovered:      0
    },
    paramOptions: {
      corner: ["center", "top-left", "top-right", "bottom-left", "bottom-right"],
      align:  ["left", "center", "right"]
    },
    methods: {},
    uiOnlyParams: ["text", "color", "align", "corner", "customRender", "clicked", "hovered"],
    description: "Positionable text label. Different from HUDText: HUDText stacks by screen corner + formats data with prefix/suffix/decimals; UIText is positioned freely via (x, y) + corner anchor + alignment. Set interactive=1 to enable pointer events -- clicked + hovered outputs work like UIButton. interactive=0 (default) makes it passive (no event capture, doesn't steal clicks from widgets stacked behind it)."
  },

  /* Phase B sprint 8 -- UILLMText.
   *
   * Multi-line text panel for displaying LLM output (or any text-typed
   * wire) in the live scene overlay. The `text` input port is type
   * "text" so it accepts LLMChat.text / LLMGenerate.text / VoiceToLLM
   * .userText / .assistantText / ConversationMemory.messages / etc.
   *
   * Unlike UIText (single-line, param-typed) this auto-wraps, renders
   * a background panel + border, and trims to the last `maxLines` rows
   * so long streams scroll naturally. Set `autoScroll=0` to pin the
   * top instead. */
  UILLMText: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "ui",
    ins: [
      { n: "show", t: "param" },
      { n: "text", t: "text"  }
    ],
    outs: [
      { n: "clicked", t: "param" },
      { n: "hovered", t: "param" }
    ],
    params: {
      text:         "",
      x:            0,
      y:            0,
      width:        420,
      height:       180,
      corner:       "center",
      fontSize:     14,
      color:        "#e8f0ff",
      bgColor:      "#0a1018",
      borderColor:  "#9bd0ff",
      borderWidth:  1,
      borderRadius: 6,
      opacity:      0.95,
      padding:      10,
      lineHeight:   1.35,
      maxLines:     64,
      autoScroll:   1,
      interactive:  0,
      customRender: "",
      clicked:      0,
      hovered:      0
    },
    paramOptions: {
      corner: ["center", "top-left", "top-right", "bottom-left", "bottom-right"]
    },
    methods: {},
    uiOnlyParams: ["text", "color", "bgColor", "borderColor", "corner", "customRender", "clicked", "hovered"],
    description: "Phase B sprint 8 -- in-scene text panel that accepts a `text`-typed input (LLMChat.text, LLMGenerate.text, VoiceToLLM.assistantText, ConversationMemory.messages, etc.). Wraps to `width`, scrolls to the bottom `maxLines` lines as tokens stream in, renders a bgColor panel with optional border. Use this when the LLM nodes' inline body isn't visible in the live render (Play mode hides the editor; this surfaces the text on the VisualOutput overlay). Set interactive=1 to also expose clicked + hovered."
  },

  UIPanel: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "ui",
    ins: [
      { n: "show", t: "param" }
    ],
    outs: [
      { n: "clicked", t: "param" },
      { n: "hovered", t: "param" }
    ],
    params: {
      x:            0,
      y:            0,
      width:        300,
      height:       200,
      color:        "#0a0e16",
      borderColor:  "#5a7090",
      borderWidth:  1,
      borderRadius: 8,
      opacity:      0.85,
      corner:       "center",
      // Phase 8.D.1 v2 -- when 1, UIPanel intercepts pointer events
      // (clickable card / hoverable region). When 0 (default),
      // pointer-events: none -- a full-screen background panel
      // doesn't steal clicks from the buttons stacked on top of it.
      interactive:  0,
      customRender: "",
      clicked:      0,
      hovered:      0
    },
    paramOptions: {
      corner: ["center", "top-left", "top-right", "bottom-left", "bottom-right"]
    },
    methods: {},
    uiOnlyParams: ["color", "borderColor", "corner", "customRender", "clicked", "hovered"],
    description: "Rectangular panel for grouping UI / background fill. Anchored to a corner + offset, rounded corners + border. Set interactive=1 to make it a clickable card or hoverable region -- clicked + hovered outputs fire like UIButton. interactive=0 (default) makes the panel pointer-passthrough so it doesn't block clicks on widgets stacked on top of it (typical for backgrounds + grouping)."
  },

  /* ── Phase 8.D.2 -- UISlider (draggable on-screen slider) ─────────
   * Renders a horizontal slider bar as a screen-space overlay.
   * Drag the handle to change the value; output is a numeric param
   * readable via wires. Use for aim control, volume, threshold
   * tuning, or any parameter the user should tweak live. */
  UISlider: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "ui",
    ins: [
      { n: "show", t: "param" }
    ],
    outs: [
      { n: "value", t: "param" }
    ],
    params: {
      label:        "",
      min:          0,
      max:          1,
      value:        0.5,
      step:         0,
      x:            0,
      y:            0,
      width:        200,
      height:       32,
      trackColor:   "#2a3a50",
      fillColor:    "#5a8ab0",
      handleColor:  "#cfe9ff",
      textColor:    "#cfe9ff",
      borderColor:  "#5a7090",
      borderWidth:  1,
      borderRadius: 4,
      fontSize:     11,
      opacity:      0.95,
      corner:       "center",
      showValue:    1
    },
    paramOptions: {
      corner: ["center", "top-left", "top-right", "bottom-left", "bottom-right"]
    },
    methods: {},
    uiOnlyParams: ["label", "trackColor", "fillColor", "handleColor", "textColor", "borderColor", "corner"],
    description: "Draggable on-screen slider. min/max set the range; value is the current position; step > 0 snaps to increments. Outputs value as a numeric param — wire into any downstream input (Raycast2D.originY, RigidBody2D.gravityScale, etc.) for live tuning. Drag the handle in the preview to change the value. showValue=1 renders the numeric readout on the handle."
  },

  /* Leaderboard -- persistent top-N score table backed by localStorage.
   * Designed for arcade-style demos: wire a score (e.g. summed fragment
   * count) into `score` and pulse `submit` 0->1 when a round ends to
   * write it into the stored list. Renders the top `maxEntries` rows
   * (sorted descending). `topScore` + `rank` output the leaderboard
   * head + the just-submitted score's position. */
  Leaderboard: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "ui",
    ins: [
      { n: "show",   t: "param" },
      { n: "score",  t: "param" },
      { n: "submit", t: "param" },
      { n: "reset",  t: "param" }
    ],
    outs: [
      { n: "topScore", t: "param" },
      { n: "rank",     t: "param" }
    ],
    params: {
      show:          1,
      score:         0,
      submit:        0,
      reset:         0,
      title:         "TOP SCORES",
      lsKey:         "gamma-leaderboard-v1",
      maxEntries:    5,
      x:             0,
      y:             0,
      width:         320,
      height:        220,
      color:         "#0a1018",
      borderColor:   "#ff8844",
      borderWidth:   2,
      borderRadius:  8,
      textColor:     "#ffcc88",
      titleColor:    "#ff8844",
      fontSize:      14,
      titleFontSize: 18,
      opacity:       0.94,
      corner:        "center",
      topScore:      0,
      rank:          0
    },
    paramOptions: {
      corner: ["center", "top-left", "top-right", "bottom-left", "bottom-right"]
    },
    methods: {},
    uiOnlyParams: ["title", "lsKey", "color", "borderColor", "textColor", "titleColor", "corner", "topScore", "rank"],
    description: "Persistent top-N leaderboard widget. Wire a numeric `score` and pulse `submit` (rising edge) to insert the score into localStorage[`lsKey`]; renders the top `maxEntries` results descending. `topScore` outputs the head of the list (0 if empty); `rank` is the just-inserted score's position (1-based). `reset` (rising edge) clears the stored list. Position via x/y + corner anchor like UIPanel."
  },

  /* ── Phase 8.I.1 -- StateMachine (general-purpose FSM) ────────────
   * User-defined states + transitions. Distinct from AnimationState2D
   * (which is a hardcoded sprite-animation FSM driven by physics
   * signals) and from StageManager (which is a render+lifecycle
   * gate). StateMachine is the "what should happen next" graph
   * upstream of both -- wire its `current` output into
   * StageManager.active to make state changes drive scene swapping
   * cleanly.
   *
   * Transitions live as a JSON list on the `transitions` param --
   * each entry { from: <stateIdx>, to: <stateIdx> } maps to one of
   * the trans0..trans7 inputs by INDEX in the list. Rising edge on
   * trans-N's input fires that transition iff current === trans[N].from.
   * Reset gate returns to initialState regardless of current.
   *
   * Outputs `enter` + `transitioning` each pulse HIGH for one tick
   * on every state change; `previousState` is the state just left
   * (so exit-side consumers can branch on it). `transitionCount` is
   * cumulative. */
  StateMachine: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "state-machine",
    ins: [
      { n: "reset",  t: "param" },
      { n: "trans0", t: "param" },
      { n: "trans1", t: "param" },
      { n: "trans2", t: "param" },
      { n: "trans3", t: "param" },
      { n: "trans4", t: "param" },
      { n: "trans5", t: "param" },
      { n: "trans6", t: "param" },
      { n: "trans7", t: "param" }
    ],
    outs: [
      { n: "current",         t: "param" },
      { n: "previousState",   t: "param" },
      { n: "enter",           t: "param" },
      { n: "transitioning",   t: "param" },
      { n: "transitionCount", t: "param" }
    ],
    params: {
      states: "intro,playing,won,dead",
      transitions: JSON.stringify([
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 1, to: 3 },
        { from: 2, to: 0 },
        { from: 3, to: 0 }
      ]),
      initialState:    0,
      current:         0,
      previousState:   0,
      enter:           0,
      transitioning:   0,
      transitionCount: 0
    },
    methods: {},
    uiOnlyParams: ["current", "previousState", "enter", "transitioning", "transitionCount"],
    description: "General-purpose finite state machine. `states` is a comma-separated name list (display only -- code uses indices). `transitions` is a JSON list of {from: <fromStateIdx>, to: <toStateIdx>} entries -- each entry binds to the same-indexed transN input (transitions[0] -> trans0, etc). On a rising edge of transN, if current === transitions[N].from then the FSM advances to transitions[N].to. `reset` gate (rising edge) returns to initialState. `current` is the live state index -- wire into StageManager.active to make state changes drive scene swaps. `enter` and `transitioning` pulse HIGH for one tick on every state change; `previousState` is the state just left (exit consumers branch on it). Demo: states 'intro,playing,won,dead' with transitions intro->playing, playing->won, playing->dead, won->intro, dead->intro -- wire KeyAxis2D.jump into trans0 (start), LevelGoal2D.reached into trans1 (win), body-fell-off-map into trans2 (die), reset key into trans3+trans4 (back to intro)."
  },

  /* ── Phase 8.A.5 -- Pool (Wwise-style voice pool) ─────────────────
   * Pre-allocated pool of N voice subgraphs from a prefab template.
   * Spawning is rising-edge on the `spawn` gate; allocation policy
   * picks the next voice (first inactive, then steals oldest active
   * if full). Each voice has its own copy of the prefab's nodes +
   * edges in state.nodes (hidden via poolParentId tag) -- spawn
   * resets the voice's spawnTime to 0 + writes spawn-* inputs into
   * the voice's exposed params, then the voice ticks and renders
   * normally until lifetime expires.
   *
   * Visual pools: prefab exposes a `mesh` out -> _resolveSceneMeshes
   * fans out one mesh entry per ACTIVE voice. Inactive voices are
   * skipped (no mesh, no tick).
   *
   * Audio pools (8.A.5.2 next): prefab exposes an `audio` out ->
   * voices feed a JS-side mixer that sums actives. Envelope retrigger
   * happens by writing to the exposed gate input on each spawn. */
  Pool: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "pool",
    ins: [
      { n: "spawn",      t: "param" },
      { n: "x",          t: "param" },
      { n: "y",          t: "param" },
      { n: "z",          t: "param" },
      { n: "freq",       t: "param" },
      { n: "amp",        t: "param" }
    ],
    outs: [
      { n: "mesh",        t: "mesh"  },
      { n: "audio",       t: "audio" },
      { n: "activeCount", t: "param" }
    ],
    params: {
      templateName:    "",
      templateInline:  "",
      maxVoices:       8,
      voiceLifetime:   1.5,
      activeCount:     0,
      // Phase 8.A.5.2 -- Built-in Web Audio synth. When audioEnabled
      // is 1, each spawn creates a real OscillatorNode + envelope
      // GainNode -> AudioContext.destination, scheduling auto-stop
      // after voiceLifetime. Independent of the prefab template's
      // audio nodes (which feed Pool.audio's JS-mirror summation).
      audioEnabled:    0,
      audioWaveform:   "sine",
      audioGain:       0.15,
      audioAttack:     0.01,
      audioRelease:    0.30,
      audioBaseFreq:   220
    },
    methods: {},
    paramOptions: {
      audioWaveform: ["sine", "triangle", "square", "sawtooth"]
    },
    uiOnlyParams: ["templateName", "templateInline", "activeCount", "audioWaveform"],
    description: "Voice pool. Pre-allocates `maxVoices` copies of the prefab in templateInline; each voice is hidden behind this node until activated. `spawn` is a rising-edge gate -- each 0->1 transition allocates the next voice (first inactive; steals oldest active when all in use), sets its spawnTime to 0, and writes current input values (`x`/`y`/`z`/`freq`/`amp`) into the voice's exposed params with matching labels. Each voice auto-despawns after `voiceLifetime` seconds (0 = manual only). `activeCount` reports the live voice count. Wire `mesh` into Scene -- _resolveSceneMeshes fans out one mesh entry per active voice. `audio` is the JS-rate sum of all active voices' envelope amplitudes (good for visualization HUDs). Set `audioEnabled = 1` to also play REAL sound via built-in Web Audio: each spawn creates an OscillatorNode (audioWaveform) at the spawn's freq (or audioBaseFreq fallback), attack/release-shaped via audioAttack/audioRelease + audioGain. Wwise-style: many voices, voice stealing, polyphonic playback, no codegen required."
  },

  PrefabInstance: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "prefab-instance",
    ins: [],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      templateName:    "",
      templateInline:  "",
      templateAssetId: ""
    },
    methods: {},
    uiOnlyParams: ["templateName", "templateInline", "templateAssetId"],
    description: "Instance of a prefab template (a saved .gpatch with prefabMeta). Reference path: set templateAssetId to an IDB prefab asset's id -- the instance reads the asset at expansion time + auto-refreshes when the asset is updated (8.A.6 propagation). Fallback path: set templateInline to an embedded JSON copy of the template. On expansion the template's internal nodes + edges spawn into state.nodes with prefabParentId tag, hidden from canvas but ticking + rendering normally. Exposed params (defined in the template's prefabMeta.exposedParams) appear as regular fields on this instance; editing them propagates to the matching child node each tick. Exposed mesh out is wired through transparently."
  },

  /* ── Phase 8.B.1 -- Physics foundation (Rapier 2D) ────────────────
   * Real 2D physics via @dimforge/rapier2d-compat WASM. PhysicsWorld2D
   * owns the Rapier world; RigidBody2D nodes register bodies; collider
   * nodes attach shapes. Body outputs (x/y/rotation/vx/vy/angularVel)
   * are numeric params read via wires -- wire into Translate/Rotate to
   * drive meshes. Coexists with PlatformerBody2D (arcade feel) --
   * RigidBody2D is for "real physics" (stacking, bouncing, raycasts). */
  PhysicsWorld2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "physics-world",
    ins: [
      { n: "gravityX",  t: "param" },
      { n: "gravityY",  t: "param" },
      { n: "timeScale", t: "param" },
      { n: "subSteps",  t: "param" },
      { n: "enabled",   t: "param" }
    ],
    outs: [
      { n: "world",        t: "param" },
      { n: "ready",        t: "param" },
      { n: "bodyCount",    t: "param" },
      { n: "contactCount", t: "param" }
    ],
    params: {
      gravityX: 0, gravityY: -9.8, timeScale: 1, subSteps: 4, enabled: 1,
      allowSleep: 1, ccdEnabled: 0,
      ready: 0, bodyCount: 0, contactCount: 0
    },
    methods: {},
    uiOnlyParams: ["ready", "bodyCount", "contactCount"],
    description: "Rapier 2D physics world. Wire the world output to RigidBody2D.world inputs to register bodies. gravityX/Y set the world gravity vector (default: 0, -9.8). timeScale multiplies the timestep (0 = paused). subSteps controls solver iteration count (higher = more stable stacks, default 4). enabled gate pauses/resumes the simulation. ready is 1 once the Rapier WASM module has loaded."
  },
  RigidBody2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "physics-body",
    ins: [
      { n: "world",          t: "param" },
      { n: "type",           t: "param" },
      { n: "initX",          t: "param" },
      { n: "initY",          t: "param" },
      { n: "initRotation",   t: "param" },
      { n: "initVx",         t: "param" },
      { n: "initVy",         t: "param" },
      { n: "linearDamping",  t: "param" },
      { n: "angularDamping", t: "param" },
      { n: "gravityScale",   t: "param" },
      { n: "fixedRotation",  t: "param" },
      { n: "ccd",            t: "param" },
      { n: "forceX",         t: "param" },
      { n: "forceY",         t: "param" },
      { n: "forceScale",     t: "param" },
      { n: "impulseX",       t: "param" },
      { n: "impulseY",       t: "param" },
      { n: "impulseScale",   t: "param" },
      { n: "reset",          t: "param" }
    ],
    outs: [
      { n: "x",          t: "param" },
      { n: "y",          t: "param" },
      { n: "rotation",   t: "param" },
      { n: "vx",         t: "param" },
      { n: "vy",         t: "param" },
      { n: "angularVel", t: "param" },
      { n: "bodyId",     t: "param" }
    ],
    params: {
      type: "dynamic", initX: 0, initY: 0, initRotation: 0,
      initVx: 0, initVy: 0,
      linearDamping: 0, angularDamping: 0, gravityScale: 1,
      fixedRotation: 0, ccd: 0,
      forceX: 0, forceY: 0, forceScale: 1,
      impulseX: 0, impulseY: 0, impulseScale: 1,
      reset: 0,
      x: 0, y: 0, rotation: 0, vx: 0, vy: 0, angularVel: 0
    },
    paramOptions: { type: ["dynamic", "kinematic", "static"] },
    methods: {},
    uiOnlyParams: ["x", "y", "rotation", "vx", "vy", "angularVel"],
    description: "Rapier 2D rigid body. type: 'dynamic' (gravity + forces), 'kinematic' (script-driven, infinite mass), 'static' (immovable). initX/initY/initRotation set the spawn position; reset gate restores them. Outputs x/y/rotation/vx/vy/angularVel are written each physics tick -- wire into Translate.x/y and Rotate.angleZ to drive meshes. rotation is in degrees. fixedRotation=1 locks rotation (good for character controllers). gravityScale multiplies the world gravity for this body (0 = floaty). Wire a collider's body input FROM any output on this node to attach it."
  },
  BoxCollider2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "physics-collider",
    ins: [
      { n: "body",        t: "param" },
      { n: "width",       t: "param" },
      { n: "height",      t: "param" },
      { n: "offsetX",     t: "param" },
      { n: "offsetY",     t: "param" },
      { n: "density",     t: "param" },
      { n: "friction",    t: "param" },
      { n: "restitution", t: "param" },
      { n: "isSensor",    t: "param" }
    ],
    outs: [],
    params: {
      width: 1, height: 1, offsetX: 0, offsetY: 0,
      density: 1, friction: 0.5, restitution: 0.3, isSensor: 0
    },
    methods: {},
    description: "Box-shaped collider for Rapier 2D physics. Attach to a RigidBody2D by wiring any output on the body into this node's body input. width/height in world units. offsetX/Y shifts the shape relative to the body center. density affects mass (auto-computed from shape area × density). friction: 0 = ice, 1 = rubber. restitution: 0 = no bounce, 1 = full bounce. isSensor=1 makes it a trigger zone (fires contact events but no physical response)."
  },
  CircleCollider2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "physics-collider",
    ins: [
      { n: "body",        t: "param" },
      { n: "radius",      t: "param" },
      { n: "offsetX",     t: "param" },
      { n: "offsetY",     t: "param" },
      { n: "density",     t: "param" },
      { n: "friction",    t: "param" },
      { n: "restitution", t: "param" },
      { n: "isSensor",    t: "param" }
    ],
    outs: [],
    params: {
      radius: 0.5, offsetX: 0, offsetY: 0,
      density: 1, friction: 0.5, restitution: 0.3, isSensor: 0
    },
    methods: {},
    description: "Circle-shaped collider for Rapier 2D physics. Attach to a RigidBody2D by wiring any output on the body into this node's body input. radius in world units. offsetX/Y shifts the shape relative to the body center. density affects mass. friction: 0 = ice, 1 = rubber. restitution: 0 = no bounce, 1 = full bounce. isSensor=1 makes it a trigger zone."
  },
  /* ── Phase 8.B.2 -- More colliders + queries ──────────────────────── */
  CapsuleCollider2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-collider",
    ins: [
      { n: "body",        t: "param" },
      { n: "radius",      t: "param" },
      { n: "halfHeight",  t: "param" },
      { n: "offsetX",     t: "param" },
      { n: "offsetY",     t: "param" },
      { n: "density",     t: "param" },
      { n: "friction",    t: "param" },
      { n: "restitution", t: "param" },
      { n: "isSensor",    t: "param" }
    ],
    outs: [],
    params: {
      radius: 0.25, halfHeight: 0.5, offsetX: 0, offsetY: 0,
      density: 1, friction: 0.5, restitution: 0.3, isSensor: 0
    },
    methods: {},
    description: "Capsule-shaped collider (two semicircles joined by a rectangle). radius is the semicircle radius; halfHeight is the half-length of the straight segment between the caps (total height = 2*halfHeight + 2*radius). Good for character controllers. Attach to a RigidBody2D via the body input."
  },
  Raycast2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-query",
    ins: [
      { n: "world",       t: "param" },
      { n: "enabled",     t: "param" },
      { n: "originX",     t: "param" },
      { n: "originY",     t: "param" },
      { n: "dirX",        t: "param" },
      { n: "dirY",        t: "param" },
      { n: "maxDistance",  t: "param" }
    ],
    outs: [
      { n: "hit",      t: "param" },
      { n: "hitX",     t: "param" },
      { n: "hitY",     t: "param" },
      { n: "normalX",  t: "param" },
      { n: "normalY",  t: "param" },
      { n: "distance", t: "param" }
    ],
    params: {
      enabled: 1, originX: 0, originY: 0, dirX: 1, dirY: 0, maxDistance: 100,
      hit: 0, hitX: 0, hitY: 0, normalX: 0, normalY: 0, distance: 0
    },
    methods: {},
    uiOnlyParams: ["hit", "hitX", "hitY", "normalX", "normalY", "distance"],
    description: "Casts a ray from (originX, originY) in direction (dirX, dirY) up to maxDistance. Outputs: hit (0/1), hitX/hitY (world-space intersection), normalX/normalY (surface normal at hit), distance. Updated every physics tick when enabled >= 0.5. Wire originX/originY from a body's x/y to cast from a moving object."
  },
  OverlapCircle2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-query",
    ins: [
      { n: "world",    t: "param" },
      { n: "enabled",  t: "param" },
      { n: "centerX",  t: "param" },
      { n: "centerY",  t: "param" },
      { n: "radius",   t: "param" }
    ],
    outs: [
      { n: "count", t: "param" },
      { n: "hit",   t: "param" }
    ],
    params: {
      enabled: 1, centerX: 0, centerY: 0, radius: 1,
      count: 0, hit: 0
    },
    methods: {},
    uiOnlyParams: ["count", "hit"],
    description: "Tests how many colliders overlap a circle at (centerX, centerY) with the given radius. count = number of overlapping colliders; hit = 1 if count > 0. Updated every physics tick when enabled."
  },
  OverlapBox2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-query",
    ins: [
      { n: "world",    t: "param" },
      { n: "enabled",  t: "param" },
      { n: "centerX",  t: "param" },
      { n: "centerY",  t: "param" },
      { n: "halfW",    t: "param" },
      { n: "halfH",    t: "param" },
      { n: "rotation", t: "param" }
    ],
    outs: [
      { n: "count", t: "param" },
      { n: "hit",   t: "param" }
    ],
    params: {
      enabled: 1, centerX: 0, centerY: 0, halfW: 0.5, halfH: 0.5, rotation: 0,
      count: 0, hit: 0
    },
    methods: {},
    uiOnlyParams: ["count", "hit"],
    description: "Tests how many colliders overlap an axis-aligned (or rotated) box at (centerX, centerY) with half-extents halfW × halfH. rotation in degrees. count = number of overlapping colliders; hit = 1 if count > 0."
  },
  /* ── Phase 8.B.9 -- Spherecast (swept-circle query) ───────────────── */
  Spherecast2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-query",
    ins: [
      { n: "world",       t: "param" },
      { n: "enabled",     t: "param" },
      { n: "originX",     t: "param" },
      { n: "originY",     t: "param" },
      { n: "dirX",        t: "param" },
      { n: "dirY",        t: "param" },
      { n: "radius",      t: "param" },
      { n: "maxDistance", t: "param" }
    ],
    outs: [
      { n: "hit",       t: "param" },
      { n: "hitX",      t: "param" },
      { n: "hitY",      t: "param" },
      { n: "contactX",  t: "param" },
      { n: "contactY",  t: "param" },
      { n: "normalX",   t: "param" },
      { n: "normalY",   t: "param" },
      { n: "distance",  t: "param" }
    ],
    params: {
      enabled: 1, originX: 0, originY: 0, dirX: 1, dirY: 0, radius: 0.5, maxDistance: 100,
      hit: 0, hitX: 0, hitY: 0, contactX: 0, contactY: 0, normalX: 0, normalY: 0, distance: 0
    },
    methods: {},
    uiOnlyParams: ["hit", "hitX", "hitY", "contactX", "contactY", "normalX", "normalY", "distance"],
    description: "Sweeps a circle of `radius` from (originX, originY) along (dirX, dirY) up to maxDistance and reports the first collider it touches. Distinct from OverlapCircle2D (a single static overlap test) — this is a moving query. Outputs: hit (0/1); hitX/hitY = the swept circle's CENTER at the moment of impact (wire into a Translate to render the stopped circle); contactX/contactY = the surface contact point; normalX/normalY = surface normal; distance = sweep length to impact. Updated every physics tick when enabled."
  },
  /* ── Phase 8.B.3 -- Joints + ContactEvent2D ───────────────────────── */
  RevoluteJoint2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-joint",
    ins: [
      { n: "bodyA",   t: "param" },
      { n: "bodyB",   t: "param" },
      { n: "anchorAx", t: "param" }, { n: "anchorAy", t: "param" },
      { n: "anchorBx", t: "param" }, { n: "anchorBy", t: "param" },
      { n: "enableLimit", t: "param" },
      { n: "lowerAngle",  t: "param" }, { n: "upperAngle", t: "param" },
      { n: "enableMotor",  t: "param" },
      { n: "motorSpeed",   t: "param" }, { n: "motorMaxTorque", t: "param" }
    ],
    outs: [{ n: "angle", t: "param" }],
    params: {
      anchorAx: 0, anchorAy: 0, anchorBx: 0, anchorBy: 0,
      enableLimit: 0, lowerAngle: -180, upperAngle: 180,
      enableMotor: 0, motorSpeed: 0, motorMaxTorque: 10,
      angle: 0
    },
    methods: {},
    uiOnlyParams: ["angle"],
    description: "Revolute (hinge) joint. Pins bodyA and bodyB at a shared pivot point. anchorA/B are local offsets from each body's center. enableLimit=1 restricts rotation to lowerAngle..upperAngle (degrees). enableMotor=1 drives rotation at motorSpeed (deg/s) up to motorMaxTorque. angle output is the current joint angle in degrees."
  },
  DistanceJoint2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-joint",
    ins: [
      { n: "bodyA", t: "param" }, { n: "bodyB", t: "param" },
      { n: "anchorAx", t: "param" }, { n: "anchorAy", t: "param" },
      { n: "anchorBx", t: "param" }, { n: "anchorBy", t: "param" },
      { n: "restLength", t: "param" },
      { n: "stiffness",  t: "param" }, { n: "damping", t: "param" }
    ],
    outs: [],
    params: {
      anchorAx: 0, anchorAy: 0, anchorBx: 0, anchorBy: 0,
      restLength: 2, stiffness: 1, damping: 0.1
    },
    methods: {},
    description: "Spring/distance joint. Keeps bodyA and bodyB at restLength apart (measured between anchors). stiffness controls spring force; damping reduces oscillation. stiffness=0 + damping=0 = rigid rod."
  },
  PrismaticJoint2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-joint",
    ins: [
      { n: "bodyA", t: "param" }, { n: "bodyB", t: "param" },
      { n: "anchorAx", t: "param" }, { n: "anchorAy", t: "param" },
      { n: "anchorBx", t: "param" }, { n: "anchorBy", t: "param" },
      { n: "axisX", t: "param" }, { n: "axisY", t: "param" },
      { n: "enableLimit", t: "param" },
      { n: "lowerLimit",  t: "param" }, { n: "upperLimit", t: "param" }
    ],
    outs: [],
    params: {
      anchorAx: 0, anchorAy: 0, anchorBx: 0, anchorBy: 0,
      axisX: 1, axisY: 0,
      enableLimit: 0, lowerLimit: -1, upperLimit: 1
    },
    methods: {},
    description: "Prismatic (slider) joint. bodyB slides along a local axis relative to bodyA. axisX/Y defines the slide direction. enableLimit=1 restricts travel to lowerLimit..upperLimit (world units)."
  },
  WeldJoint2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-joint",
    ins: [
      { n: "bodyA", t: "param" }, { n: "bodyB", t: "param" },
      { n: "anchorAx", t: "param" }, { n: "anchorAy", t: "param" },
      { n: "anchorBx", t: "param" }, { n: "anchorBy", t: "param" }
    ],
    outs: [],
    params: { anchorAx: 0, anchorAy: 0, anchorBx: 0, anchorBy: 0 },
    methods: {},
    description: "Weld (fixed) joint. Rigidly attaches bodyA to bodyB at the anchor offsets. The two bodies move as one rigid structure."
  },
  ContactEvent2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-event",
    ins: [
      { n: "bodyA", t: "param" },
      { n: "bodyB", t: "param" }
    ],
    outs: [
      { n: "touching",     t: "param" },
      { n: "enterTrigger", t: "param" },
      { n: "exitTrigger",  t: "param" },
      { n: "enterCount",   t: "param" }
    ],
    params: { touching: 0, enterTrigger: 0, exitTrigger: 0, enterCount: 0 },
    methods: {},
    uiOnlyParams: ["touching", "enterTrigger", "exitTrigger", "enterCount"],
    description: "Detects contact between two bodies. Wire any output from bodyA and bodyB into the body inputs. touching=1 while colliders overlap; enterTrigger pulses 1 for one tick when contact starts; exitTrigger pulses 1 when contact ends; enterCount is cumulative. Works with sensor colliders for trigger zones."
  },
  /* ── Phase 8.B.4 -- TilemapCollider2D ─────────────────────────────
   * Auto-builds Rapier box colliders from a tilemap's solid cells.
   * Greedy-merges adjacent cells into larger rectangles to minimize
   * collider count. Rebuilds when tileData changes. */
  TilemapCollider2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-tilemap-collider",
    ins: [
      { n: "world",   t: "param" },
      { n: "tilemap", t: "mesh" },
      { n: "friction",    t: "param" },
      { n: "restitution", t: "param" }
    ],
    outs: [
      { n: "colliderCount", t: "param" }
    ],
    params: {
      friction: 0.6, restitution: 0.1, colliderCount: 0
    },
    methods: {},
    uiOnlyParams: ["colliderCount"],
    description: "Builds Rapier 2D box colliders from a wired Tilemap2D or Level2D's collidable layer. Solid tiles (anything except '.', ' ', '4', '5') are greedy-merged into minimal rectangles. Wire PhysicsWorld2D.world → world, and Level2D.mesh or Tilemap2D.mesh → tilemap. Rebuilds automatically when tile data changes (e.g. PickupCollector clearing cells)."
  },
  /* ── Phase 8.0.3-b / 8.B.6 -- 3D Physics foundation ──────────────
   * Rapier 3D via @dimforge/rapier3d-compat. Same architecture as
   * the 2D system but in 3 dimensions. */
  PhysicsWorld3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-world-3d",
    ins: [
      { n: "gravityX", t: "param" }, { n: "gravityY", t: "param" }, { n: "gravityZ", t: "param" },
      { n: "timeScale", t: "param" }, { n: "subSteps", t: "param" }, { n: "enabled", t: "param" }
    ],
    outs: [
      { n: "world", t: "param" }, { n: "ready", t: "param" },
      { n: "bodyCount", t: "param" }
    ],
    params: {
      gravityX: 0, gravityY: -9.8, gravityZ: 0,
      timeScale: 1, subSteps: 4, enabled: 1,
      ready: 0, bodyCount: 0
    },
    methods: {},
    uiOnlyParams: ["ready", "bodyCount"],
    description: "Rapier 3D physics world. Wire the world output to RigidBody3D.world inputs. Gravity defaults to (0, -9.8, 0). Same tick pattern as PhysicsWorld2D but in three dimensions."
  },
  RigidBody3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-body-3d",
    ins: [
      { n: "world", t: "param" }, { n: "type", t: "param" },
      { n: "initX", t: "param" }, { n: "initY", t: "param" }, { n: "initZ", t: "param" },
      { n: "initVx", t: "param" }, { n: "initVy", t: "param" }, { n: "initVz", t: "param" },
      { n: "linearDamping", t: "param" }, { n: "angularDamping", t: "param" },
      { n: "gravityScale", t: "param" },
      { n: "forceX", t: "param" }, { n: "forceY", t: "param" }, { n: "forceZ", t: "param" },
      { n: "forceScale", t: "param" },
      { n: "impulseX", t: "param" }, { n: "impulseY", t: "param" }, { n: "impulseZ", t: "param" },
      { n: "impulseScale", t: "param" },
      { n: "ccd", t: "param" }, { n: "reset", t: "param" }
    ],
    outs: [
      { n: "x", t: "param" }, { n: "y", t: "param" }, { n: "z", t: "param" },
      { n: "rotX", t: "param" }, { n: "rotY", t: "param" }, { n: "rotZ", t: "param" },
      { n: "vx", t: "param" }, { n: "vy", t: "param" }, { n: "vz", t: "param" },
      { n: "bodyId", t: "param" }
    ],
    params: {
      type: "dynamic", initX: 0, initY: 0, initZ: 0,
      initVx: 0, initVy: 0, initVz: 0,
      linearDamping: 0, angularDamping: 0, gravityScale: 1,
      forceX: 0, forceY: 0, forceZ: 0, forceScale: 1,
      impulseX: 0, impulseY: 0, impulseZ: 0, impulseScale: 1,
      ccd: 0, reset: 0,
      x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0,
      vx: 0, vy: 0, vz: 0
    },
    paramOptions: { type: ["dynamic", "kinematic", "static"] },
    methods: {},
    uiOnlyParams: ["x", "y", "z", "rotX", "rotY", "rotZ", "vx", "vy", "vz"],
    description: "Rapier 3D rigid body. Same pattern as RigidBody2D but with Z axis. Wire into Translate.x/y/z to drive 3D meshes."
  },
  BoxCollider3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-collider-3d",
    ins: [
      { n: "body", t: "param" },
      { n: "halfX", t: "param" }, { n: "halfY", t: "param" }, { n: "halfZ", t: "param" },
      { n: "density", t: "param" }, { n: "friction", t: "param" }, { n: "restitution", t: "param" },
      { n: "isSensor", t: "param" }
    ],
    outs: [],
    params: { halfX: 0.5, halfY: 0.5, halfZ: 0.5, density: 1, friction: 0.5, restitution: 0.3, isSensor: 0 },
    methods: {},
    description: "Box collider for Rapier 3D. halfX/Y/Z are half-extents. Wire body from a RigidBody3D."
  },
  SphereCollider3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-collider-3d",
    ins: [
      { n: "body", t: "param" },
      { n: "radius", t: "param" },
      { n: "density", t: "param" }, { n: "friction", t: "param" }, { n: "restitution", t: "param" },
      { n: "isSensor", t: "param" }
    ],
    outs: [],
    params: { radius: 0.5, density: 1, friction: 0.5, restitution: 0.3, isSensor: 0 },
    methods: {},
    description: "Sphere collider for Rapier 3D. Wire body from a RigidBody3D."
  },
  CapsuleCollider3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-collider-3d",
    ins: [
      { n: "body", t: "param" },
      { n: "radius", t: "param" }, { n: "halfHeight", t: "param" },
      { n: "density", t: "param" }, { n: "friction", t: "param" }, { n: "restitution", t: "param" },
      { n: "isSensor", t: "param" }
    ],
    outs: [],
    params: { radius: 0.25, halfHeight: 0.5, density: 1, friction: 0.5, restitution: 0.3, isSensor: 0 },
    methods: {},
    description: "Capsule collider for Rapier 3D (Y-axis aligned). radius = cap radius; halfHeight = half the straight segment between caps. Total height = 2*halfHeight + 2*radius. Good for character controllers."
  },
  /* ── Phase 8.B.7 -- 3D queries + joints ───────────────────────────── */
  Raycast3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-query-3d",
    ins: [
      { n: "world", t: "param" }, { n: "enabled", t: "param" },
      { n: "originX", t: "param" }, { n: "originY", t: "param" }, { n: "originZ", t: "param" },
      { n: "dirX", t: "param" }, { n: "dirY", t: "param" }, { n: "dirZ", t: "param" },
      { n: "maxDistance", t: "param" }
    ],
    outs: [
      { n: "hit", t: "param" },
      { n: "hitX", t: "param" }, { n: "hitY", t: "param" }, { n: "hitZ", t: "param" },
      { n: "distance", t: "param" }
    ],
    params: {
      enabled: 1, originX: 0, originY: 0, originZ: 0,
      dirX: 0, dirY: -1, dirZ: 0, maxDistance: 100,
      hit: 0, hitX: 0, hitY: 0, hitZ: 0, distance: 0
    },
    methods: {},
    uiOnlyParams: ["hit", "hitX", "hitY", "hitZ", "distance"],
    description: "3D ray cast. Fires from (originX/Y/Z) in direction (dirX/Y/Z) up to maxDistance. Outputs hit (0/1) and hitX/Y/Z + distance on hit."
  },
  OverlapSphere3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-query-3d",
    ins: [
      { n: "world", t: "param" }, { n: "enabled", t: "param" },
      { n: "centerX", t: "param" }, { n: "centerY", t: "param" }, { n: "centerZ", t: "param" },
      { n: "radius", t: "param" }
    ],
    outs: [{ n: "count", t: "param" }, { n: "hit", t: "param" }],
    params: { enabled: 1, centerX: 0, centerY: 0, centerZ: 0, radius: 1, count: 0, hit: 0 },
    methods: {},
    uiOnlyParams: ["count", "hit"],
    description: "Tests how many 3D colliders overlap a sphere at (centerX/Y/Z) with given radius."
  },
  Spherecast3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-query-3d",
    ins: [
      { n: "world", t: "param" }, { n: "enabled", t: "param" },
      { n: "originX", t: "param" }, { n: "originY", t: "param" }, { n: "originZ", t: "param" },
      { n: "dirX", t: "param" }, { n: "dirY", t: "param" }, { n: "dirZ", t: "param" },
      { n: "radius", t: "param" }, { n: "maxDistance", t: "param" }
    ],
    outs: [
      { n: "hit", t: "param" },
      { n: "hitX", t: "param" }, { n: "hitY", t: "param" }, { n: "hitZ", t: "param" },
      { n: "contactX", t: "param" }, { n: "contactY", t: "param" }, { n: "contactZ", t: "param" },
      { n: "normalX", t: "param" }, { n: "normalY", t: "param" }, { n: "normalZ", t: "param" },
      { n: "distance", t: "param" }
    ],
    params: {
      enabled: 1, originX: 0, originY: 0, originZ: 0,
      dirX: 0, dirY: -1, dirZ: 0, radius: 0.5, maxDistance: 100,
      hit: 0, hitX: 0, hitY: 0, hitZ: 0,
      contactX: 0, contactY: 0, contactZ: 0,
      normalX: 0, normalY: 0, normalZ: 0, distance: 0
    },
    methods: {},
    uiOnlyParams: ["hit", "hitX", "hitY", "hitZ", "contactX", "contactY", "contactZ", "normalX", "normalY", "normalZ", "distance"],
    description: "Sweeps a sphere of `radius` from (originX/Y/Z) along (dirX/Y/Z) up to maxDistance and reports the first collider it touches. Distinct from OverlapSphere3D (a static overlap test) — this is a moving query (Rapier castShape). Outputs: hit (0/1); hitX/Y/Z = the swept sphere's CENTER at impact (wire into a Translate to render the stopped sphere); contactX/Y/Z = surface contact point; normalX/Y/Z = surface normal; distance = sweep length to impact. Updated every physics tick when enabled."
  },
  HingeJoint3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-joint-3d",
    ins: [
      { n: "bodyA", t: "param" }, { n: "bodyB", t: "param" },
      { n: "anchorAx", t: "param" }, { n: "anchorAy", t: "param" }, { n: "anchorAz", t: "param" },
      { n: "anchorBx", t: "param" }, { n: "anchorBy", t: "param" }, { n: "anchorBz", t: "param" },
      { n: "axisX", t: "param" }, { n: "axisY", t: "param" }, { n: "axisZ", t: "param" }
    ],
    outs: [],
    params: {
      anchorAx: 0, anchorAy: 0, anchorAz: 0,
      anchorBx: 0, anchorBy: 0, anchorBz: 0,
      axisX: 0, axisY: 0, axisZ: 1
    },
    methods: {},
    description: "Hinge (revolute) joint for Rapier 3D. Constrains bodyB to rotate around a single axis relative to bodyA. axis defines the hinge direction in body-local space."
  },
  BallJoint3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-joint-3d",
    ins: [
      { n: "bodyA", t: "param" }, { n: "bodyB", t: "param" },
      { n: "anchorAx", t: "param" }, { n: "anchorAy", t: "param" }, { n: "anchorAz", t: "param" },
      { n: "anchorBx", t: "param" }, { n: "anchorBy", t: "param" }, { n: "anchorBz", t: "param" }
    ],
    outs: [],
    params: {
      anchorAx: 0, anchorAy: 0, anchorAz: 0,
      anchorBx: 0, anchorBy: 0, anchorBz: 0
    },
    methods: {},
    description: "Ball-and-socket joint for Rapier 3D. Constrains bodyB's anchor to bodyA's anchor but allows free rotation in all axes. Good for shoulders, hips, ragdoll connections."
  },
  FixedJoint3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-joint-3d",
    ins: [
      { n: "bodyA", t: "param" }, { n: "bodyB", t: "param" },
      { n: "anchorAx", t: "param" }, { n: "anchorAy", t: "param" }, { n: "anchorAz", t: "param" },
      { n: "anchorBx", t: "param" }, { n: "anchorBy", t: "param" }, { n: "anchorBz", t: "param" }
    ],
    outs: [],
    params: {
      anchorAx: 0, anchorAy: 0, anchorAz: 0,
      anchorBx: 0, anchorBy: 0, anchorBz: 0
    },
    methods: {},
    description: "Fixed (weld) joint for Rapier 3D. Rigidly attaches bodyB to bodyA at the anchor offsets."
  },
  RopeJoint3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-joint-3d",
    ins: [
      { n: "bodyA", t: "param" }, { n: "bodyB", t: "param" },
      { n: "length", t: "param" },
      { n: "anchorAx", t: "param" }, { n: "anchorAy", t: "param" }, { n: "anchorAz", t: "param" },
      { n: "anchorBx", t: "param" }, { n: "anchorBy", t: "param" }, { n: "anchorBz", t: "param" }
    ],
    outs: [],
    params: {
      length: 5,
      anchorAx: 0, anchorAy: 0, anchorAz: 0,
      anchorBx: 0, anchorBy: 0, anchorBz: 0
    },
    methods: {},
    description: "Rope (max-distance) joint for Rapier 3D. bodyB is free to move but cannot get farther than `length` from bodyA's anchor — like a taut rope/chain. Below that distance the rope is slack and exerts no force, so bodyB swings as a pendulum + falls freely until the rope snaps taut. Wire bodyA = anchor (usually a static body), bodyB = the hanging body. Pair with a Rope3D for the visual tube. Uses Rapier's rope joint (falls back to a rigid spherical link if unavailable)."
  },
  /* ── Sprint D.4 -- DestructibleBody3D ────────────────────────────── */
  DestructibleBody3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "mesh-gen",
    ins: [
      { n: "world",            t: "param" },
      { n: "body",             t: "param" },
      { n: "mesh",             t: "mesh" },
      { n: "fracture",         t: "mesh" },
      { n: "damageThreshold",  t: "param" },
      { n: "fragmentLifetime", t: "param" },
      { n: "radialImpulse",    t: "param" },
      { n: "maxDepth",         t: "param" },
      { n: "subFragments",     t: "param" },
      { n: "reset",            t: "param" }
    ],
    outs: [
      { n: "mesh",          t: "mesh" },
      { n: "destroyed",     t: "param" },
      { n: "fragmentCount", t: "param" }
    ],
    params: {
      damageThreshold: 500, fragmentLifetime: 5, radialImpulse: 3,
      maxDepth: 2, subFragments: 4,
      destroyed: 0, fragmentCount: 0, reset: 0
    },
    methods: {},
    uiOnlyParams: ["destroyed", "fragmentCount"],
    description: "Monitors a wired RigidBody3D for impact. When any nearby body's velocity-change force exceeds damageThreshold, removes the solid body and spawns Voronoi fragment bodies from the wired FractureMesh. Wire: RigidBody3D.bodyId → body, Box.mesh → mesh, FractureMesh.mesh → fracture, PhysicsWorld3D.world → world."
  },
  /* ── Sprint D.2/D.3 -- Voronoi fracture + FractureMesh ──────────── */
  FractureMesh: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "mesh-transform",
    ins: [
      { n: "mesh",      t: "mesh" },
      { n: "fragments", t: "param" },
      { n: "seed",      t: "param" }
    ],
    outs: [
      { n: "mesh",          t: "mesh" },
      { n: "fractureReady", t: "param" }
    ],
    params: {
      fragments: 8, seed: 42,
      interiorR: 0.3, interiorG: 0.25, interiorB: 0.2,
      fractureReady: 0
    },
    methods: {},
    uiOnlyParams: ["fractureReady"],
    description: "Pre-fractures the wired mesh into N Voronoi fragments. Passes the solid mesh through unchanged. Cached fragments are consumed by a downstream DestructibleBody3D on impact. fragments = piece count (2-32). seed = PRNG seed. interiorR/G/B = color of cut faces."
  },
  /* ── Sprint D.1 -- Contact force detection ────────────────────────── */
  ContactForce3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-event-3d",
    ins: [
      { n: "world", t: "param" },
      { n: "bodyA", t: "param" },
      { n: "bodyB", t: "param" }
    ],
    outs: [
      { n: "forceMagnitude", t: "param" },
      { n: "maxForce",       t: "param" }
    ],
    params: { forceMagnitude: 0, maxForce: 0 },
    methods: {},
    uiOnlyParams: ["forceMagnitude", "maxForce"],
    description: "Outputs the contact force magnitude between two 3D bodies each tick. forceMagnitude is the current-frame force; maxForce is the peak since last reset. Wire into a DestructibleBody3D's damageThreshold comparison or a HUD for diagnostics."
  },

  /* ── Phase 8.B.10 -- Force fields + wind ──────────────────────────── */
  ForceField3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-force-3d",
    ins: [
      { n: "world", t: "param" }, { n: "enabled", t: "param" },
      { n: "x", t: "param" }, { n: "y", t: "param" }, { n: "z", t: "param" },
      { n: "strength", t: "param" }, { n: "radius", t: "param" }, { n: "falloff", t: "param" }
    ],
    outs: [{ n: "affected", t: "param" }],
    params: {
      enabled: 1, x: 0, y: 0, z: 0,
      strength: 20, radius: 12, falloff: 1, mode: "attract", affected: 0
    },
    paramOptions: { mode: ["attract", "repel", "vortex"] },
    methods: {},
    uiOnlyParams: ["affected"],
    description: "Point force field acting on every dynamic body within `radius` of (x,y,z) each physics tick. mode: attract (pull toward center), repel (push away), vortex (swirl around the world Y axis through the center + slight inward pull). strength is the acceleration magnitude (mass-scaled, so light + heavy bodies accelerate alike). falloff: 0 = constant (full force everywhere in range), 1 = linear (full at center → 0 at edge), 2 = inverse-square (1/dist², clamped). Wire PhysicsWorld3D.world → world. `affected` outputs the body count acted on. Set the world's gravity to 0 for a clean gravity-well look."
  },
  Wind3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-force-3d",
    ins: [
      { n: "world", t: "param" }, { n: "enabled", t: "param" },
      { n: "dirX", t: "param" }, { n: "dirY", t: "param" }, { n: "dirZ", t: "param" },
      { n: "strength", t: "param" }, { n: "turbulence", t: "param" }, { n: "scale", t: "param" }
    ],
    outs: [
      { n: "sampleX", t: "param" }, { n: "sampleY", t: "param" }, { n: "sampleZ", t: "param" }
    ],
    params: {
      enabled: 1, dirX: 1, dirY: 0, dirZ: 0,
      strength: 5, turbulence: 0.3, scale: 0.4,
      sampleX: 0, sampleY: 0, sampleZ: 0
    },
    methods: {},
    uiOnlyParams: ["sampleX", "sampleY", "sampleZ"],
    description: "Directional wind force on every dynamic body in the world. Base force = normalize(dir) * strength, plus a time-varying turbulence component (cheap value-noise, `turbulence` = amount, `scale` = spatial frequency). Mass-scaled like ForceField3D. sampleX/Y/Z output the current wind vector at the world origin — wire these into a future Cloth3D / Rope3D `wind` input. Wire PhysicsWorld3D.world → world."
  },

  /* ── Phase 8.B.11 -- Rope3D (Position-Based-Dynamics visual rope) ── */
  Rope3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "mesh-gen",
    ins: [
      { n: "world",   t: "param" },
      { n: "attachA", t: "param" }, { n: "attachB", t: "param" },
      { n: "ax", t: "param" }, { n: "ay", t: "param" }, { n: "az", t: "param" },
      { n: "bx", t: "param" }, { n: "by", t: "param" }, { n: "bz", t: "param" },
      { n: "segments", t: "param" }, { n: "radius", t: "param" },
      { n: "stiffness", t: "param" }, { n: "gravity", t: "param" },
      { n: "windX", t: "param" }, { n: "windY", t: "param" }, { n: "windZ", t: "param" }
    ],
    outs: [
      { n: "mesh", t: "mesh" },
      { n: "tipX", t: "param" }, { n: "tipY", t: "param" }, { n: "tipZ", t: "param" }
    ],
    params: {
      ax: 0, ay: 6, az: 0, bx: 0, by: 0, bz: 0,
      segments: 16, radius: 0.12, stiffness: 1, gravity: -9.8,
      windX: 0, windY: 0, windZ: 0,
      r: 0.45, g: 0.32, b: 0.2,
      tipX: 0, tipY: 0, tipZ: 0
    },
    methods: {},
    uiOnlyParams: ["tipX", "tipY", "tipZ"],
    description: "A Position-Based-Dynamics rope rendered as a tube. `segments`+1 particles run a Verlet-style sim each physics tick: gravity + optional wind, then distance constraints pull adjacent particles back to the rest length so the rope keeps its length (`stiffness` 0–1 scales the correction). Endpoint A pins to (ax,ay,az) — or to a wired RigidBody3D via attachA (wire a body's bodyId). Endpoint B likewise via (bx,by,bz) / attachB. The rope is VISUAL (it follows its pinned ends); for the physical swing constrain the hanging body with a RopeJoint3D. `radius` = tube thickness; r/g/b = color. tipX/Y/Z output the free end's position. Wire PhysicsWorld3D.world → world (for dt + gravity default)."
  },

  /* ── Phase 8.B.12 -- Cloth3D (Position-Based-Dynamics cloth grid) ── */
  Cloth3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "mesh-gen",
    ins: [
      { n: "world",   t: "param" },
      { n: "originX", t: "param" }, { n: "originY", t: "param" }, { n: "originZ", t: "param" },
      { n: "width", t: "param" }, { n: "height", t: "param" },
      { n: "resX", t: "param" }, { n: "resY", t: "param" },
      { n: "stiffness", t: "param" }, { n: "gravity", t: "param" }, { n: "turbulence", t: "param" },
      { n: "windX", t: "param" }, { n: "windY", t: "param" }, { n: "windZ", t: "param" }
    ],
    outs: [
      { n: "mesh", t: "mesh" },
      { n: "vertexCount", t: "param" }
    ],
    params: {
      originX: 0, originY: 6, originZ: 0,
      width: 6, height: 4, resX: 16, resY: 10,
      stiffness: 0.9, gravity: -9.8, turbulence: 0.6,
      windX: 0, windY: 0, windZ: 0,
      pinEdge: "left",
      r: 0.7, g: 0.2, b: 0.25,
      vertexCount: 0
    },
    paramOptions: { pinEdge: ["none", "left", "right", "top", "bottom", "top-corners"] },
    methods: {},
    uiOnlyParams: ["vertexCount"],
    description: "A Position-Based-Dynamics cloth sheet rendered as a grid. (resX+1)×(resY+1) particles hang from the top-left origin and span `width` in +X, `height` in -Y. Each physics tick: gravity + base wind (windX/Y/Z) + per-particle `turbulence` accelerate the free particles, then structural + shear + bend distance constraints (scaled by `stiffness` 0–1) hold the weave together. `pinEdge` fixes one edge in place (left = flag hoist on a pole, top = hanging banner, etc.). Wind: wire a Wind3D's sampleX/Y/Z into windX/Y/Z, and/or raise `turbulence` for self-flutter. r/g/b = color; rendered double-sided. Wire PhysicsWorld3D.world → world."
  },

  /* ── Phase 8.B.13 -- SoftBody3D (Position-Based-Dynamics jelly) ──── */
  SoftBody3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "mesh-gen",
    ins: [
      { n: "world",   t: "param" },
      { n: "originX", t: "param" }, { n: "originY", t: "param" }, { n: "originZ", t: "param" },
      { n: "size", t: "param" }, { n: "res", t: "param" },
      { n: "stiffness", t: "param" }, { n: "volumePreserve", t: "param" },
      { n: "bounce", t: "param" }, { n: "gravity", t: "param" }, { n: "groundY", t: "param" },
      { n: "reset", t: "param" }
    ],
    outs: [
      { n: "mesh", t: "mesh" },
      { n: "centerX", t: "param" }, { n: "centerY", t: "param" }, { n: "centerZ", t: "param" }
    ],
    params: {
      originX: 0, originY: 6, originZ: 0,
      size: 2.5, res: 5,
      stiffness: 0.6, volumePreserve: 0.65, bounce: 0.5,
      gravity: -9.8, groundY: 0, reset: 0,
      r: 0.55, g: 0.85, b: 0.65,
      centerX: 0, centerY: 0, centerZ: 0
    },
    methods: {},
    uiOnlyParams: ["centerX", "centerY", "centerZ"],
    description: "A Position-Based-Dynamics soft body (jelly cube). A res³ lattice of particles fills a `size` cube at the origin. Each physics tick: gravity Verlet-integrates the particles, they collide + bounce off the ground plane at `groundY` (restitution = `bounce`), then distance constraints hold the lattice together — structural (axis) edges at full `stiffness`, plus diagonal edges scaled by `volumePreserve` (1 = holds its cube shape + bounces, 0 = shears + squashes flat). The deforming surface is rendered as a faceted shell; centerX/Y/Z output the centroid. `reset` (rising edge) restores the cube. Wire PhysicsWorld3D.world → world."
  },

  /* ── Phase 8.B.14 -- Determinism + Replay (record / scrub) ───────── */
  PhysicsRecord: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-record-3d",
    ins: [
      { n: "world", t: "param" }, { n: "record", t: "param" }, { n: "reset", t: "param" }, { n: "maxFrames", t: "param" }
    ],
    outs: [
      { n: "frameCount", t: "param" }, { n: "recording", t: "param" }
    ],
    params: { record: 1, reset: 0, maxFrames: 300, frameCount: 0, recording: 0 },
    methods: {},
    uiOnlyParams: ["frameCount", "recording"],
    description: "Records the transform (position + rotation) of every dynamic RigidBody3D in the wired world, one snapshot per physics tick, while `record` ≥ 0.5 — up to `maxFrames` frames, then stops. `reset` (rising edge) clears the buffer. `frameCount` outputs how many frames are stored; `recording` is 1 while actively capturing. Recording pauses automatically while a PhysicsReplay is scrubbing the same world. Wire PhysicsWorld3D.world → world, and recording → a PhysicsReplay's `recording`."
  },
  PhysicsReplay: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-replay-3d",
    ins: [
      { n: "world", t: "param" }, { n: "recording", t: "param" }, { n: "frame", t: "param" }, { n: "enabled", t: "param" }
    ],
    outs: [
      { n: "active", t: "param" }, { n: "atEnd", t: "param" }, { n: "frameIndex", t: "param" }
    ],
    params: { frame: 1, enabled: 1, active: 0, atEnd: 0, frameIndex: 0 },
    methods: {},
    uiOnlyParams: ["active", "atEnd", "frameIndex"],
    description: "Scrubs a PhysicsRecord. `frame` is a NORMALIZED time 0..1 into the recording: 1.0 = live (the world simulates + records normally), anything below ~0.99 freezes the world and snaps every body to the recorded snapshot at that point — so a single slider becomes a time machine (right edge = now, drag left = rewind). Wire PhysicsRecord.recording → recording, a UISlider.value → frame. `active` = 1 while scrubbing; `frameIndex` = the resolved frame number; `atEnd` = 1 at the last frame. Replaying captured transforms (not re-simulating) — true lockstep determinism is a §8.G concern."
  },

  /* Sprint platformer-tile-sprites -- TileSpriteOverlay. Renders one
   * textured quad per matching cell in a wired Tilemap2D, all
   * sharing the same texture + sampler so the whole overlay draws
   * in a single sprite-pipeline call (regardless of egg count).
   *
   * Drives the "tiles are actually sprites, not colored squares"
   * visual: Tilemap2D keeps the cells in its tileData for collision
   * + PickupCollector + LevelGoal2D detection, AND has those chars
   * in its `skipRenderChars` so the tilemap mesh doesn't draw a
   * box behind the sprite. The overlay sits in a higher Scene2D
   * mesh slot so it draws ON TOP of the level.
   *
   * Because the overlay's _meshCacheKey includes the upstream
   * tilemap's tileData, mutating the tilemap (e.g., PickupCollector
   * removing collected eggs) auto-rebuilds the overlay mesh -- the
   * sprite disappears on the same frame as the tile data clears. */
  TileSpriteOverlay: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "texture",  t: "texture" },
      { n: "tilemap",  t: "mesh"   },
      { n: "tileChar", t: "param"  },
      // Sprite quad size (world units). Default 1.0 = one tile cell.
      { n: "scale",    t: "param"  },
      // anchor inside the quad (0..1). 0,0 = bottom-left aligned.
      // 0.5,0.5 = centered on the cell. 0.5,0 = bottom-center,
      // good for ground-pinned sprites (eggs, flags resting on the
      // tile floor); use 0.5,0.5 for floating items.
      { n: "anchorX",  t: "param"  },
      { n: "anchorY",  t: "param"  },
      { n: "frame",    t: "param"  },
      { n: "framesX",  t: "param"  },
      { n: "framesY",  t: "param"  },
      { n: "tintR",    t: "param"  },
      { n: "tintG",    t: "param"  },
      { n: "tintB",    t: "param"  },
      { n: "tintA",    t: "param"  },
      // Bobbing amplitude (world units). 0 = static; >0 sine-waves
      // each sprite up/down by ±amplitude. Per-instance phase from
      // the cell's (col, row) so adjacent eggs don't sync.
      { n: "bobAmplitude", t: "param" },
      { n: "bobSpeed",     t: "param" },
      // Z depth baked into the mesh. Reverse-Z: lower (more negative)
      // = nearer to camera = drawn ON TOP of higher-Z meshes. Level
      // is at z=0; set to -0.4 to draw in front of the level.
      { n: "depthZ",       t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      tileChar: "4",
      scale:    1.0,
      anchorX:  0.5,
      anchorY:  0.5,
      frame:    0,
      framesX:  1,
      framesY:  1,
      tintR: 1, tintG: 1, tintB: 1, tintA: 1,
      bobAmplitude: 0,
      bobSpeed:     2,
      depthZ:       0
    },
    methods: {},
    description: "Renders one textured quad per cell in a wired Tilemap2D matching `tileChar`. All quads share the same texture + sampler so the whole overlay batches into a single draw call. Pair with Tilemap2D.skipRenderChars (set to the same tileChar) so the colored-square underneath doesn't show through. `scale` = sprite world size (1.0 = one tile cell). anchorX/Y position the sprite within its cell (0.5,0.5=centered, 0.5,0=bottom-pinned). frame / framesX / framesY work like Sprite for multi-frame sheets. bobAmplitude > 0 makes sprites bob up and down with a per-cell phase offset for a 'floating pickup' feel. depthZ bakes a z-offset into every vert (reverse-Z, so negative = nearer); set to -0.4 to draw in front of the level."
  },

  /* Sprint platformer-parallax -- ParallaxLayer2D. Single textured
   * quad that follows the wired camera horizontally + scrolls its
   * UV based on camera position × parallaxX. Snow-White-style
   * multi-plane scrolling: at parallaxX=0 the texture is locked
   * to the screen (skybox); at parallaxX=1 it's locked to world
   * coords (no parallax); in between, the bg appears to drift
   * slower than the foreground.
   *
   * Repeat-mode sampling is required so the bg tiles cleanly as
   * the camera moves through the level -- wire the texture from
   * an ImageURL with wrapMode='repeat-x' (or 'repeat').
   *
   * The quad SHARES the sprite pipeline (one textured pass, same
   * BGL); cache key includes the camera's quantized posX so the
   * mesh rebuilds whenever the camera moves > 0.05 world units. */
  ParallaxLayer2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "texture",       t: "texture" },
      { n: "camera",        t: "camera"  },
      // 0 = static skybox (texture locked to screen).
      // 1 = world-locked (no parallax; texture moves with the world).
      // 0.05 = very distant; 0.4 = midground; 0.7 = near.
      { n: "parallaxX",     t: "param" },
      // Texture's apparent world width = how far the camera has to
      // move for the bg to cycle one full texture width. Smaller =
      // more visible scroll per camera unit.
      { n: "texWorldWidth", t: "param" },
      // Vertical placement + size. screenScaleY clamps the quad to
      // a fraction of the visible screen height; e.g. 0.5 = bottom
      // half only (good for ground-level layers like grass / bushes).
      // 1.0 covers full screen height.
      { n: "screenScaleY",  t: "param" },
      // Vertical anchor inside the screen (0..1, 0 = bottom, 1 = top).
      { n: "screenAnchorY", t: "param" },
      // Vertical world offset added on top of the anchor; useful for
      // pinning a layer to a specific world-Y range regardless of
      // where the camera is looking.
      { n: "worldOffsetY",  t: "param" },
      { n: "tintR",         t: "param" },
      { n: "tintG",         t: "param" },
      { n: "tintB",         t: "param" },
      { n: "tintA",         t: "param" },
      // Z depth baked into vert positions. Reverse-Z: bigger Z =
      // farther = drawn first. Set this to push the layer behind
      // foreground content (e.g. 60 for sky, 40 mountains, 20 forest).
      { n: "depthZ",        t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      parallaxX:     0.30,
      texWorldWidth: 30,
      screenScaleY:  1.0,
      screenAnchorY: 0.5,
      worldOffsetY:  0,
      tintR: 1, tintG: 1, tintB: 1, tintA: 1,
      depthZ:        20
    },
    methods: {},
    description: "2D parallax background layer -- a screen-spanning textured quad that follows the wired camera and scrolls its UV by `cameraX * parallaxX / texWorldWidth`. parallaxX=0 locks to screen (sky / clouds); 1.0 locks to world (no parallax); 0.1-0.4 = distant layers, 0.4-0.7 = midground, 0.7-0.9 = foreground accents. Wire the texture through an ImageURL with wrapMode='repeat-x' so the bg tiles cleanly as the camera moves. screenScaleY + screenAnchorY confine the layer vertically. depthZ bakes a z-offset into every vert (reverse-Z: bigger = farther). Mesh rebuilds on every camera move > 0.05 world units."
  },

  /* Sprint SpriteScatter2D -- world-space sprite instancer. One
   * textured quad per parsed (x, y) position, all sharing one
   * texture/sampler so the whole field draws in a single sprite-
   * pipeline call. Sits in world space (no parallax, no camera
   * follow) -- if you wanted parallax, use ParallaxLayer2D.
   *
   * Use cases: in-world trees standing on the ground, decorative
   * grass tufts, varied platforms (different sprite per instance
   * via per-instance frame indices), pickup fields with explicit
   * positions (vs TileSpriteOverlay's tilemap-derived positions).
   *
   * Positions string format:
   *   "x,y; x,y,scale; x,y,scale,frame; x,y,scale,frame,flipX"
   * Instances separated by ';'. Each instance is 2-5 numbers:
   *   2 floats: x,y           (use node default scale + frame)
   *   3 floats: x,y,scale     (override scale)
   *   4 floats: x,y,scale,frame
   *   5 floats: x,y,scale,frame,flipX (0 or 1)
   * Whitespace is ignored. */
  SpriteScatter2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "texture",  t: "texture" },
      // The positions list. See format above. Default has 4 sample
      // tufts spaced 5 units apart so a brand-new node draws
      // visible content as soon as it's wired.
      { n: "positions", t: "param" },
      // Default per-instance scale (1 world unit wide). Overridden
      // by the third number in a position spec.
      { n: "scale",    t: "param" },
      { n: "anchorX",  t: "param" },
      { n: "anchorY",  t: "param" },
      // Default frame + sheet grid. Per-instance frame can override
      // (4th number in a position spec).
      { n: "frame",    t: "param" },
      { n: "framesX",  t: "param" },
      { n: "framesY",  t: "param" },
      { n: "tintR",    t: "param" },
      { n: "tintG",    t: "param" },
      { n: "tintB",    t: "param" },
      { n: "tintA",    t: "param" },
      { n: "depthZ",   t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      positions: "-10,-3.5; -4,-3.5; 4,-3.5; 10,-3.5",
      scale:    1.0,
      anchorX:  0.5,
      anchorY:  0,            // bottom-pin so sprite stands on the y coord
      frame:    0,
      framesX:  1,
      framesY:  1,
      tintR: 1, tintG: 1, tintB: 1, tintA: 1,
      depthZ:   0
    },
    methods: {},
    description: "World-space sprite instancer. Emits one textured quad per parsed position in the `positions` string, all batched through the sprite pipeline in a single draw call. positions format: 'x,y; x,y,scale; x,y,scale,frame; x,y,scale,frame,flipX' -- instances separated by ';', each instance is 2-5 numbers. Use for in-world trees / grass tufts / varied platforms / pickup fields with explicit world coordinates. Sits in world space (no parallax); if you want camera-relative scroll use ParallaxLayer2D. anchorY=0 bottom-pins (sprite stands on the y coord); 0.5 centers; 1 top-pins (hangs from ceiling)."
  },

  /* Sprint platformer-1 -- Tilemap2D. Grid-based mesh primitive.
   * tileData is a multi-line string where each character is a cell
   * (space / '.' = empty; any other char = solid tile colored by
   * the matching paletteR/G/B param). Emits one mesh containing
   * one quad per non-empty cell, vertex-colored per palette index.
   *
   * Cell (col, row) lives at world position
   *   x = (col - cols/2) * tileSize + originX
   *   y = (rows/2 - row) * tileSize + originY     (row 0 at top)
   *
   * Tilemaps are static -- changing tileData at runtime rebuilds
   * the mesh. For animated levels use multiple smaller Tilemaps. */
  Tilemap2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "tileData",  t: "param" },
      { n: "tileSize",  t: "param" },
      { n: "originX",   t: "param" },
      { n: "originY",   t: "param" },
      // 5-color palette. Tiles use the char to index: digit 1 → color1,
      // 2 → color2, etc. Char '#' aliases to 1 for ergonomics. Any
      // unknown char (besides '.' / ' ') = color1.
      { n: "color1R", t: "param" }, { n: "color1G", t: "param" }, { n: "color1B", t: "param" },
      { n: "color2R", t: "param" }, { n: "color2G", t: "param" }, { n: "color2B", t: "param" },
      { n: "color3R", t: "param" }, { n: "color3G", t: "param" }, { n: "color3B", t: "param" },
      { n: "color4R", t: "param" }, { n: "color4G", t: "param" }, { n: "color4B", t: "param" },
      { n: "color5R", t: "param" }, { n: "color5G", t: "param" }, { n: "color5B", t: "param" },
      // String of chars to OMIT from the rendered mesh while still
      // keeping them in tileData for collision + PickupCollector +
      // LevelGoal2D detection + TileSpriteOverlay overlays. Useful
      // when a sprite overlay sits on top of pickup/goal cells; you
      // don't want the underlying colored square peeking through.
      { n: "skipRenderChars", t: "param" },
      // Sprint Level2D Phase 2 -- optional tileset (sprite asset
      // URL) for textured rendering. When set, the mesh emits per-
      // cell quads with UVs computed from tileMap[char] -> tile
      // index in the framesX/framesY sheet. Cells whose chars are
      // NOT in tileMap fall back to the vertex-color palette path
      // (so a single tilemap can mix textured tiles + pickup/goal
      // markers). framesX/framesY default from the asset record.
      { n: "tileset",         t: "param" },
      { n: "tileMap",         t: "param" },   // JSON: {"1":0, "2":1, ...}
      { n: "tilesetFramesX",  t: "param" },
      { n: "tilesetFramesY",  t: "param" },
      { n: "depthZ",          t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      tileData: "................\n................\n................\n................\n................\n.......1........\n................\n................\n.....111........\n................\n111111111111....\n................\n2222222222222222",
      tileSize: 1,
      originX: 0, originY: 0,
      color1R: 0.30, color1G: 0.55, color1B: 0.35,   // grass-green
      color2R: 0.42, color2G: 0.28, color2B: 0.18,   // dirt-brown
      color3R: 0.55, color3G: 0.55, color3B: 0.62,   // stone-gray
      color4R: 0.96, color4G: 0.90, color4B: 0.78,   // egg cream (pickup marker)
      color5R: 0.92, color5G: 0.25, color5B: 0.30,   // goal-flag red
      skipRenderChars: "",
      tileset:         "",
      tileMap:         "",
      tilesetFramesX:  4,
      tilesetFramesY:  2,
      depthZ:          0
    },
    methods: {},
    description: "2D tilemap mesh. tileData is a multi-line string -- each char is a cell (space or '.' = empty). DEFAULT (no tileset) renders vertex-color squares: '1'/'#' = color1 (grass), '2' = color2 (dirt), '3' = color3 (stone), '4' = pickup-passable, '5' = goal-passable. TILESET MODE (set `tileset` to an asset URL + `tileMap` JSON like `{\"1\":0,\"2\":1}`) renders each char as the referenced tile from the sprite-sheet (framesX × framesY) via the sprite pipeline. depthZ bakes a z-offset into the verts. Cell pitch = tileSize world units. originX/Y shifts the grid origin. **Collision** (when wired into PlatformerBody2D.tilemap): solid = any rendered cell EXCEPT '4' / '5'."
  },

  /* Phase 7 §5.5.g -- Minimap HUD node. First member of a planned
   * "HUD" family (followed by Compass, Inventory, HealthBar, etc.).
   * Renders the patch's first TiledTerrain top-down (heightmap
   * sampled at low-res, colored by altitude bands matching the
   * unlit-vc gradient) into a fixed-position overlay canvas; camera
   * dot + heading line render on top. Drop the node into a patch
   * to show; delete to hide. No mesh / camera wires needed -- it
   * auto-discovers the terrain + the first FPCamera / Camera in
   * the patch. Use 4 corner anchors + offset for placement. */
  Minimap: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "hud",
    ins: [
      { n: "corner",  t: "param" },
      { n: "size",    t: "param" },
      { n: "margin",  t: "param" },
      { n: "range",   t: "param" },
      { n: "opacity", t: "param" }
    ],
    outs: [{ n: "hud", t: "hud" }],
    params: {
      corner:  "top-right",
      size:    200,
      margin:  18,
      range:   1.0,
      opacity: 0.90
    },
    paramOptions: { corner: ["top-right", "top-left", "bottom-right", "bottom-left"] },
    methods: {},
    description: "HUD minimap overlay. Top-down view of the patch's first TiledTerrain heightmap, colored by altitude band (blue valleys → grass → rock → snow). Camera dot + heading line render on top. corner picks one of the four screen corners; size is pixels; margin is the gap from the screen edge; range scales how much world to show (1 = exactly the terrain's visible disc, 2 = 2× zoomed out, 0.5 = zoomed in). opacity is the overlay alpha (0..1). Drop the node into the patch to show; delete to hide. No wires required -- it auto-discovers the terrain and camera."
  },

  /* Phase 7 §5.5.h-27 -- Altimeter HUD. Reads the patch's first
   * FPCamera / Camera posY and renders an altitude + speed readout
   * in a screen corner. Auto-discovers everything; wire `hud` into
   * Scene.hud1..hud4 to make it appear in live mode. */
  Altimeter: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "hud",
    ins: [
      { n: "corner",  t: "param" },
      { n: "margin",  t: "param" },
      { n: "opacity", t: "param" },
      { n: "showSpeed", t: "param" }
    ],
    outs: [{ n: "hud", t: "hud" }],
    params: {
      corner:    "top-left",
      margin:    18,
      opacity:   0.90,
      showSpeed: 1
    },
    paramOptions: { corner: ["top-right", "top-left", "bottom-right", "bottom-left"] },
    methods: {},
    description: "HUD altimeter overlay. Live readout of the patch's first FPCamera/Camera altitude (posY) in meters, plus optional speed/sprint indicator. Useful for the planet-scale archipelago demo where you need to know if you're at curve altitude (8km+) or in space (80km+). corner picks the screen anchor; margin is gap from edge; opacity is overlay alpha; showSpeed (0/1) toggles the secondary speed readout. Drop the node into a patch + wire `hud` into Scene.hud1..hud4 to make it appear in live mode."
  },

  /* Sprint hud-text -- HUDText. Generic text overlay. Renders a single
   * line of text in one of the four screen corners, drawn to its own
   * canvas so it composites cleanly with the rest of the HUD stack.
   * Value-wired use: connect a numeric param (score, health, timer)
   * to `value`; the node formats it with `prefix`/`suffix`/`decimals`.
   * Static-text use: leave `value` at NaN and set `text` directly.
   * Sample wirings:
   *   "Score: " + player.score          prefix="Score: " value=score
   *   "HP 100 / 100"                    text="HP 100 / 100" (static)
   *   "Time 1.23s"                      prefix="Time " suffix="s" decimals=2 */
  HUDText: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "hud",
    ins: [
      { n: "show",     t: "param" },
      { n: "text",     t: "param" },
      { n: "value",    t: "param" },
      { n: "prefix",   t: "param" },
      { n: "suffix",   t: "param" },
      { n: "decimals", t: "param" },
      { n: "corner",   t: "param" },
      { n: "fontSize", t: "param" },
      { n: "color",    t: "param" },
      { n: "opacity",  t: "param" },
      { n: "margin",   t: "param" }
    ],
    outs: [{ n: "hud", t: "hud" }],
    params: {
      text:     "HUD",
      // NaN signals "use static text instead of formatting a number".
      value:    NaN,
      prefix:   "",
      suffix:   "",
      decimals: 0,
      corner:   "top-left",
      fontSize: 16,
      color:    "#ffffff",
      opacity:  0.95,
      margin:   18,
      // Phase 8.D.1 -- optional JS body that overrides the default
      // HUD render. Free vars: ctx, p, input. width/height are used
      // to size the canvas when customRender is active.
      customRender: "",
      width:    0,
      height:   0
    },
    paramOptions: { corner: ["top-right", "top-left", "bottom-right", "bottom-left"] },
    methods: {},
    description: "Generic HUD text overlay. Renders one line of text in a screen corner. Two modes: (1) static text -- leave `value` at NaN and set `text` directly; (2) numeric readout -- wire a number into `value`, optional prefix/suffix and decimals format it (e.g. prefix='Score: ' decimals=0 -> 'Score: 42'). corner picks the anchor; fontSize is in CSS px; color accepts any CSS color (named or hex); margin is gap from screen edge; opacity is the overlay alpha. Multiple HUDText nodes in the same corner stack vertically. Drop + wire the `hud` output into Scene2D.hud1..hud4 to make it appear in live mode -- and yes, the text is now included in screenshots and video recordings as of v0.3.440."
  },

  /* Sprint 7.5.3a -- DebugTriangle. Smoke-test mesh source. Emits a
   * single colored triangle (RGB vertices) as a `mesh` output, used
   * to validate the Scene render pipeline end-to-end. Disappears
   * from the palette when sprint 7.5.3b ships proper primitives
   * (Box, Sphere, etc.) -- it's marked as a Debug-category entry
   * so it doesn't compete with the real shapes visually.
   *
   * Vertex layout (built lazily in _ensureMeshBuffers): 3 vertices
   * × (vec3 position + vec3 color) = 9 floats × 4 bytes = 24
   * bytes per vertex, 72 bytes total. Index buffer omitted (just 3
   * vertices, drawn non-indexed). */
  DebugTriangle: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "scale", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { scale: 1.0 },
    methods: {},
    description: "Debug-only mesh source -- a single RGB-vertex triangle. Wire its `mesh` output into a Scene sink to verify the 3D pipeline. Use this only while sprint 7.5.3b is still pending real primitives (Box, Sphere, Plane, etc); afterwards prefer the real shapes. scale uniformly resizes the triangle in world units."
  },

  /* Sprint 7.5.3a -- Scene sink. The 3D parallel of VisualOutput:
   * accepts up to 4 mesh inputs + 1 camera input + renders all
   * meshes into a framebuffer / scratch layer (so downstream
   * shader-frags can post-process the result). Subsequent sprints
   * will wire materials + lighting; sprint 7.5.3a uses an unlit
   * vertex-color pipeline.
   *
   * Output type is `texture` so a Scene's result feeds the existing
   * composition + post-processing graph (BlendShader, CRT, etc.)
   * without any new infrastructure. */
  Scene: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "scene",
    ins: [
      { n: "mesh1",       t: "mesh" },
      { n: "mesh2",       t: "mesh" },
      { n: "mesh3",       t: "mesh" },
      { n: "mesh4",       t: "mesh" },
      { n: "camera",      t: "camera" },
      { n: "light1",      t: "light" },
      { n: "light2",      t: "light" },
      { n: "light3",      t: "light" },
      { n: "light4",      t: "light" },
      // Sprint 7.5.4 -- environment / IBL source. When wired, the
      // PBR / Phong ambient sampling uses the wired sky instead of
      // the hardcoded blue-gray hemisphere. When unwired, falls back
      // to the prior behavior so existing patches don't change.
      { n: "environment", t: "environment" },
      // §5.5.g -- HUD overlay slots. Each accepts a Minimap / future
      // Compass / HealthBar etc. that wants to render on TOP of this
      // Scene's output. The HUD nodes draw to DOM overlays positioned
      // over the visual canvas; they only render in live mode when
      // this Scene's chain feeds the active VisualOutput.
      { n: "hud1",        t: "hud" },
      { n: "hud2",        t: "hud" },
      { n: "hud3",        t: "hud" },
      { n: "hud4",        t: "hud" },
      { n: "clearR",      t: "param" },
      { n: "clearG",      t: "param" },
      { n: "clearB",      t: "param" },
      // Sprint 7.5.4.e -- distance fog. fogDensity=0 disables (default).
      //   fogDensity  -- Beer-Lambert coefficient, ~0.01-0.05 typical
      //   fogStart    -- distance before fog kicks in
      //   fogHeight   -- 0 = uniform; >0 = ground fog (clouds stay clear)
      //   fogAuto     -- 1 = pull color from env in camera-forward;
      //                  0 = use fogR/G/B manual color
      //   fogR/G/B    -- manual fog color (used when fogAuto = 0)
      { n: "fogDensity", t: "param" },
      { n: "fogStart",   t: "param" },
      { n: "fogHeight",  t: "param" },
      { n: "fogAuto",    t: "param" },
      { n: "fogR",       t: "param" },
      { n: "fogG",       t: "param" },
      { n: "fogB",       t: "param" },
      // Sprint 5.10 -- view-frustum culling. cullEnable=1 (default)
      // skips draws for meshes whose world-space AABB lies fully
      // outside the camera frustum. Set to 0 to disable for
      // debugging or for non-frustum-bound projection setups.
      { n: "cullEnable", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      clearR: 0.04, clearG: 0.05, clearB: 0.09,
      fogDensity: 0.0, fogStart: 5.0, fogHeight: 0.0, fogAuto: 1.0,
      fogR: 0.65, fogG: 0.70, fogB: 0.78,
      cullEnable: 1
    },
    methods: {},
    description: "3D scene sink. Wire up to four `mesh` inputs (Box/Sphere/Plane/Torus/Cylinder/Cone via sprint 7.5.3b primitives, or DebugTriangle for the simplest smoke test) and one `camera` input from a Camera node. Renders the meshes through the camera into a framebuffer layer; output is `texture`-typed so the result flows into the existing post-processing graph (CRT, Bloom, BlendShader, etc.). clearR/G/B is the background color (default a deep navy). Depth-tested; meshes farther from the camera are correctly occluded. Sprint 7.5.3c adds materials + lighting; until then the pipeline is unlit + uses per-vertex colors. **Naming note (§8.0.2-b):** the canonical name going forward is `Scene3D` — `Scene2D` + `Scene25D` ship in §8.0.2-c/d. `Scene` remains supported as a backward-compat alias; existing patches keep working without migration."
  },

  /* Sprint 8.0.2-b -- Scene3D. Canonical name for the 3D raster
   * scene sink, alongside the upcoming Scene2D (§8.0.2-c) and
   * Scene25D (§8.0.2-d). Internally identical to Scene -- same
   * ins, outs, params, render kind. Encoder dispatches by
   * `kind: "scene"`, not by type name, so both names route into
   * the exact same pipeline with zero divergence. Old patches
   * with `type: "Scene"` keep loading; new content + demos use
   * Scene3D for symmetry with the 2D/2.5D variants. */
  Scene3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "scene",
    ins: [
      { n: "mesh1",       t: "mesh" },
      { n: "mesh2",       t: "mesh" },
      { n: "mesh3",       t: "mesh" },
      { n: "mesh4",       t: "mesh" },
      { n: "mesh5",       t: "mesh" },
      { n: "mesh6",       t: "mesh" },
      { n: "mesh7",       t: "mesh" },
      { n: "mesh8",       t: "mesh" },
      { n: "camera",      t: "camera" },
      { n: "light1",      t: "light" },
      { n: "light2",      t: "light" },
      { n: "light3",      t: "light" },
      { n: "light4",      t: "light" },
      { n: "environment", t: "environment" },
      { n: "hud1",        t: "hud" },
      { n: "hud2",        t: "hud" },
      { n: "hud3",        t: "hud" },
      { n: "hud4",        t: "hud" },
      { n: "clearR",      t: "param" },
      { n: "clearG",      t: "param" },
      { n: "clearB",      t: "param" },
      { n: "fogDensity",  t: "param" },
      { n: "fogStart",    t: "param" },
      { n: "fogHeight",   t: "param" },
      { n: "fogAuto",     t: "param" },
      { n: "fogR",        t: "param" },
      { n: "fogG",        t: "param" },
      { n: "fogB",        t: "param" },
      { n: "cullEnable",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      clearR: 0.04, clearG: 0.05, clearB: 0.09,
      fogDensity: 0.0, fogStart: 5.0, fogHeight: 0.0, fogAuto: 1.0,
      fogR: 0.65, fogG: 0.70, fogB: 0.78,
      cullEnable: 1
    },
    methods: {},
    description: "Sprint 8.0.2-b -- canonical name for the raster 3D scene sink. Identical to the older `Scene` node (kept as backward-compat alias); same inputs (4 meshes / camera / 4 lights / env / 4 HUDs / fog / clear / cullEnable), same render path (kind: 'scene'), same output texture. New demos + patches should use Scene3D for symmetry with Scene2D (§8.0.2-c) and Scene25D (§8.0.2-d). When you want hardware ray tracing instead, swap for `RayTracedScene` -- same input surface (§8.0.1 parity sprint), same downstream texture output."
  },

  /* Sprint 8.0.2-c -- Scene2D. 2D rendering pipeline. Layered
   * sprite + 2D primitives, no depth test, painter's-algorithm
   * ordering, transparent compositing native. Coords in world
   * units (typically pixels). Routes through `_encodeScenePass`
   * (kind: 'scene') with sceneMode='2d' set, which the encoder
   * uses to disable depth, switch sort to back-to-front by mesh
   * input order (mesh1=back, mesh4=front), and ignore lights.
   *
   * Cameras: pair with OrthoCamera2D for pixel-perfect output,
   * or a Camera with mode=ortho for non-snapped scrolling. */

  /* Sprint Level2D Phase 1a -- unified level container. One node
   * holds an ordered list of layers (parallax / tilemap / scatter /
   * future: objects). The encoder expansion in _resolveSceneMeshes
   * detects Level2D and emits N synthetic per-layer mesh entries,
   * so a single mesh1 wire to Scene2D draws the whole level instead
   * of consuming 7+ mesh ports. depthZ + parallax + collide all in
   * the per-layer JSON so the user controls z-ordering centrally.
   *
   * `layers` is a JSON string. Each layer object has at minimum
   * `type` and `depthZ`; per-type fields mirror the existing
   * ParallaxLayer2D / Tilemap2D / SpriteScatter2D params so the
   * mesh builders work unchanged. Texture URLs live inline in the
   * layer config (e.g. "texture": "asset:parallax-sky"); no need
   * to wire ImageURL nodes per layer.
   *
   * Phase 1a ships the data model + encoder expansion only. Phases
   * 1b -> 5 add the visual editor modal, tileset assets, scatter
   * placement UI, chunked loading, and per-tile collision shapes. */
  Level2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      // The camera the parallax layers in this Level2D follow. If
      // unwired, the parallax expansion auto-discovers the first
      // OrthoCamera2D / Camera in the patch (same fallback the
      // existing ParallaxLayer2D node uses).
      { n: "camera", t: "camera" },
      // JSON string. See _LEVEL2D_EXAMPLE for shape. Phase 1b will
      // hide this behind a visual layer-list modal.
      { n: "layers", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      // Default: a single tilemap layer at z=0 with a small 16×8
      // grid showing the data shape. User can replace via the
      // upcoming Level Editor modal OR by editing the JSON in the
      // props panel.
      layers: JSON.stringify([
        {
          type: "tilemap",
          name: "ground",
          depthZ: 0,
          collides: true,
          tileSize: 1,
          originX: 0, originY: 0,
          tileData: "................\n................\n................\n................\n................\n................\n11111111111111111\n22222222222222222",
          color1R: 0.30, color1G: 0.55, color1B: 0.35,
          color2R: 0.42, color2G: 0.28, color2B: 0.18,
          color3R: 0.55, color3G: 0.55, color3B: 0.62,
          color4R: 0.96, color4G: 0.90, color4B: 0.78,
          color5R: 0.92, color5G: 0.25, color5B: 0.30,
          skipRenderChars: ""
        }
      ], null, 2)
    },
    methods: {},
    description: "Unified 2D level container. One JSON-driven node holds an ordered list of layers (parallax bg / tilemap / scatter), each with its own depthZ + collision + parallax settings. The renderer expands it into per-layer meshes at draw time, so a single mesh1 wire to Scene2D draws the whole level (no more juggling 8 mesh slots). Phase 1a (this sprint) ships the data model + render expansion; Phase 1b+ will add the visual Level Editor modal, tileset assets, scatter placement UI, chunked loading for 1000+ col worlds, and per-tile collision shapes. Edit the `layers` JSON in the props pane to test before the modal lands."
  },

  Scene2D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "scene",
    sceneMode: "2d",
    ins: [
      { n: "mesh1",      t: "mesh" },
      { n: "mesh2",      t: "mesh" },
      { n: "mesh3",      t: "mesh" },
      { n: "mesh4",      t: "mesh" },
      { n: "mesh5",      t: "mesh" },
      { n: "mesh6",      t: "mesh" },
      { n: "mesh7",      t: "mesh" },
      { n: "mesh8",      t: "mesh" },
      { n: "camera",     t: "camera" },
      { n: "hud1",       t: "hud" },
      { n: "hud2",       t: "hud" },
      { n: "hud3",       t: "hud" },
      { n: "hud4",       t: "hud" },
      { n: "clearR",     t: "param" },
      { n: "clearG",     t: "param" },
      { n: "clearB",     t: "param" },
      { n: "cullEnable", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      clearR: 0.04, clearG: 0.05, clearB: 0.09,
      cullEnable: 1
    },
    methods: {},
    description: "Sprint 8.0.2-c -- 2D scene sink. Same input surface as Scene3D for meshes / camera / HUDs / clear, minus lights / fog / environment (not used in 2D). Render mode = depth-disabled, painter's-algorithm ordering by mesh-input slot (mesh1 draws first / behind, mesh8 last / in front). Wire Sprites or any other mesh as inputs and an OrthoCamera2D as the camera. Output is `texture` (just like Scene3D) so post-FX chains and BlendShader composition work identically. Eight mesh slots so a full platformer scene (3 parallax bg layers + level + pickups + props + enemies + player) fits without juggling."
  },

  /* Sprint 8.0.2-d -- Scene25D. Orthographic 3D under the hood
   * with isometric / parallax sprite conventions baked in. Same
   * render path as Scene3D (depth test enabled, full lights /
   * fog / env) but the encoder sees sceneMode='25d' and feeds
   * Sprite primitives a Y-sort hint (sprite.pivotZ) so they
   * sort correctly against terrain depth. Wire an OrthoCamera25D
   * for the right projection -- a perspective camera also works
   * for a "fake 2.5D" cinematic. */
  Scene25D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "scene",
    sceneMode: "25d",
    ins: [
      { n: "mesh1",       t: "mesh" },
      { n: "mesh2",       t: "mesh" },
      { n: "mesh3",       t: "mesh" },
      { n: "mesh4",       t: "mesh" },
      { n: "mesh5",       t: "mesh" },
      { n: "mesh6",       t: "mesh" },
      { n: "mesh7",       t: "mesh" },
      { n: "mesh8",       t: "mesh" },
      { n: "camera",      t: "camera" },
      { n: "light1",      t: "light" },
      { n: "light2",      t: "light" },
      { n: "light3",      t: "light" },
      { n: "light4",      t: "light" },
      { n: "environment", t: "environment" },
      { n: "hud1",        t: "hud" },
      { n: "hud2",        t: "hud" },
      { n: "hud3",        t: "hud" },
      { n: "hud4",        t: "hud" },
      { n: "clearR",      t: "param" },
      { n: "clearG",      t: "param" },
      { n: "clearB",      t: "param" },
      { n: "fogDensity",  t: "param" },
      { n: "fogStart",    t: "param" },
      { n: "fogHeight",   t: "param" },
      { n: "fogAuto",     t: "param" },
      { n: "fogR",        t: "param" },
      { n: "fogG",        t: "param" },
      { n: "fogB",        t: "param" },
      { n: "cullEnable",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      clearR: 0.04, clearG: 0.05, clearB: 0.09,
      fogDensity: 0.0, fogStart: 5.0, fogHeight: 0.0, fogAuto: 1.0,
      fogR: 0.65, fogG: 0.70, fogB: 0.78,
      cullEnable: 1
    },
    methods: {},
    description: "Sprint 8.0.2-d -- 2.5D scene sink. Identical input surface to Scene3D (4 meshes / camera / 4 lights / env / 4 HUDs / fog / clear / cull). Render path = depth-tested 3D BUT designed around an ortho camera at a fixed angle preset; Sprites in this scene use their pivotZ to sort correctly against terrain depth so character sprites slot in among 3D geometry. Pair with OrthoCamera25D for the canonical isometric / Hades / Diablo look."
  },

  /* RayTracedScene -- the hardware ray-tracing alternative to Scene.
   * Same inputs (meshes / camera / lights / environment), but the
   * scene is rendered by the native gamma-rt-engine on the local
   * compile-server (Vulkan-RT on PC, Metal-RT on Mac) and streamed
   * back as H.264 frames over WebSocket.
   *
   * Sprint 7.5.6.a part 1 -- STUB. The node exists + the editor
   * checks engine availability via /health, but no actual rendering
   * yet. The render loop + streaming proxy land in part 2. If the
   * engine isn't installed, the node displays a status message and
   * outputs the clear color so downstream graphs don't break.
   *
   * Quality presets:
   *   draft    1 spp, no denoise, no progressive accumulation
   *   preview  4 spp + denoiser + progressive accumulation
   *   final    16 spp + multi-bounce path tracing + denoiser
   *
   * Materials specific to RT (work ONLY inside RayTracedScene):
   *   - GlassMat   (refractive dielectric, lands in §5.6.d)
   *   - MirrorMat  (pure-mirror, lands in §5.6.d)
   *   - AreaLight  (rectangular soft-shadow source, lands in §5.6.c) */
  RayTracedScene: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "scene-rt",   // distinct from "scene" so the encoder
                        // dispatches a different path (not yet
                        // implemented in part 1; falls back to a
                        // black clear).
    ins: [
      { n: "mesh1",   t: "mesh" },
      { n: "mesh2",   t: "mesh" },
      { n: "mesh3",   t: "mesh" },
      { n: "mesh4",   t: "mesh" },
      { n: "camera",  t: "camera" },
      { n: "light1",  t: "light" },
      { n: "light2",  t: "light" },
      { n: "light3",  t: "light" },
      { n: "light4",  t: "light" },
      { n: "quality", t: "param" },
      { n: "bounces", t: "param" },
      { n: "samples", t: "param" },
      { n: "denoise", t: "param" },
      { n: "exposure", t: "param" },
      { n: "tonemap", t: "param" },
      { n: "displaySize", t: "param" },
      { n: "renderScale", t: "param" },
      // Sprint 5.4-rt -- environment + fog. RayTracedScene now
      // honors the same env sources as raster Scene (GradientSky,
      // ProceduralSky -- HDRI texture support is queued separately).
      // Engine kernel reads sample_env_smooth for IBL on PBR hits +
      // sample_env_full for primary-ray misses (sky background); fog
      // applied per-pixel via apply_fog_rt.
      { n: "environment", t: "environment" },
      { n: "fogDensity",  t: "param" },
      { n: "fogStart",    t: "param" },
      { n: "fogHeight",   t: "param" },
      { n: "fogAuto",     t: "param" },
      { n: "fogR",        t: "param" },
      { n: "fogG",        t: "param" },
      { n: "fogB",        t: "param" },
      // §8.0.1-a parity sprint -- HUD overlay slots so DOM-side HUD
      // nodes (Minimap, future Compass / HealthBar) detect this RT
      // scene as their active sink. The HUD nodes auto-display when
      // they find a wire from their `hud` output to ANY Scene-kind
      // node's hudN input; no per-Scene divergence needed beyond
      // exposing the ports.
      { n: "hud1",        t: "hud" },
      { n: "hud2",        t: "hud" },
      { n: "hud3",        t: "hud" },
      { n: "hud4",        t: "hud" },
      // §8.0.1-a parity sprint -- cullEnable param mirrors raster
      // Scene's. The engine does its own AS-driven culling already
      // (BVH traversal is intrinsically culled), so this is a no-op
      // today; it exists so dropping a wired-up Scene → RT renames
      // doesn't drop the param + cause a UI regression. Engine-side
      // surface for explicit cull override can land later if there's
      // a use case.
      { n: "cullEnable",  t: "param" },
      { n: "clearR",  t: "param" },
      { n: "clearG",  t: "param" },
      { n: "clearB",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      quality: 1,         // 0=draft, 1=preview, 2=final
      bounces: 0,         // 0 = follow quality preset (2/4/8);
                          //   1-8 = explicit override
      samples: 0,         // 0 = follow quality preset (1/4/16 spp);
                          //   1-16 = explicit per-frame override
      denoise: 1,
      exposure: 0.0,
      tonemap: 1,         // 0=none, 1=ACES, 2=Reinhard, 3=AgX
      // f.3.f-prep -- display target + internal render scale.
      // displaySize is the OUTPUT resolution streamed to the editor
      // (and what the user sees). renderScale is the fraction of
      // displaySize the kernel actually shades; the engine's TDS
      // scaler upscales kernel output back to displaySize. Both
      // apply at WS-connect time -- changes require reloading the
      // demo (live-reconfigure lands with the upscale wiring).
      displaySize: "720p",   // 854x480 / 800x600 / 1280x720 / 1600x900 / 1920x1080
      renderScale: "native", // native / quality / balanced / performance / ultra
      // 5.4-rt -- fog defaults match raster Scene's. fogDensity=0
      // disables fog; the env input remains a wire (no default value
      // — unwired = engine's mode-0 hemisphere fallback).
      fogDensity: 0.0, fogStart: 5.0, fogHeight: 0.0, fogAuto: 1.0,
      fogR: 0.65, fogG: 0.70, fogB: 0.78,
      // §8.0.1-a parity -- match raster Scene default (cullEnable=1).
      cullEnable: 1,
      clearR: 0.02, clearG: 0.02, clearB: 0.04
    },
    methods: {},
    paramOptions: {
      quality:     ["draft", "preview", "final"],
      tonemap:     ["none", "ACES", "Reinhard", "AgX"],
      displaySize: ["480p", "600p", "720p", "900p", "1080p"],
      renderScale: ["native", "quality", "balanced", "performance", "ultra"]
    },
    description: "Hardware ray-tracing scene sink. Requires gamma-compile-server to have the gamma-rt-engine binary installed (Rust monorepo sibling; see docs/RAYTRACING.md). Same inputs as Scene (meshes / camera / lights) but renders via native Vulkan-RT (PC) or Metal-RT (Mac) and streams the result as an H.264 video over WebSocket. Output is `texture`, so downstream nodes (CRT, BlendShader, post-processing) consume it like any other layer. Quality presets: draft (1spp, no denoise), preview (4spp + denoise + progressive accumulation), final (16spp + full multi-bounce path tracing + denoise). bounces caps recursion depth; samples is per-pixel-per-frame; denoise toggles the OIDN / MetalFX denoiser pass; exposure is the EV stop offset; tonemap picks the operator. Sprint 7.5.6.a part 1: NODE STUB ONLY -- the actual streaming pipeline lands in part 2. Falls back to a clear-color black when the engine isn't installed."
  },

  /* =========================================================================
   * Sprint 7.5.3b -- Procedural primitive meshes
   *
   * Six classic 3D primitives, each emitting a `mesh` output that
   * flows into a Scene sink (optionally through Translate / Rotate /
   * Scale transform nodes for positioning). Vertex layout matches
   * the existing unlit-vertex-color pipeline: (pos.xyz, color.rgb)
   * interleaved float32, stride 24 bytes. Color generation per type:
   *
   *   Box      distinct per-face colors (RGB/CMY for the 6 faces)
   *   Sphere   normal-as-color ((n+1)*0.5 maps each direction to a
   *            pastel hue)
   *   Plane    soft cyan→violet UV gradient
   *   Torus    normal-as-color
   *   Cylinder side strip + cap distinct tints
   *   Cone     apex-to-base falloff
   *
   * Geometry rebuilt on param change via the mesh-buffer cache's
   * cacheKey -- dimensional tweaks (e.g. dragging Sphere.stacks) cost
   * one buffer-rebuild per change, then re-cached. Sprint 7.5.3c
   * replaces the vertex-color shader with PBR / Phong / Unlit
   * material variants. ======================================================================== */
  Box: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "width",  t: "param" },
      { n: "height", t: "param" },
      { n: "depth",  t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { width: 1, height: 1, depth: 1 },
    methods: {},
    description: "3D box primitive. width / height / depth are world-units along X / Y / Z. 24 vertices (4 per face × 6 faces, NOT shared) so each face can carry its own color + normal. Faces are color-coded for easy orientation: +X red, -X cyan, +Y green, -Y magenta, +Z blue, -Z yellow. Wire `mesh` into a Scene (optionally through Translate / Rotate / Scale first). Geometry rebuilds when params change; cost is one small vertex-buffer rewrite."
  },

  Sphere: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "radius", t: "param" },
      { n: "stacks", t: "param" },
      { n: "slices", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { radius: 1, stacks: 16, slices: 24 },
    methods: {},
    description: "UV-sphere primitive. radius is world-units; stacks are horizontal slices (latitude, 2..64), slices are vertical meridians (longitude, 3..128). Higher numbers = smoother surface, more triangles. Vertex color is normal-as-RGB: ((n + 1) * 0.5) so each direction maps to a distinct pastel hue (visible smoothing reveals quality without materials). Defaults (16, 24) give a clean look at ~770 verts."
  },

  Capsule: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "radius",     t: "param" },
      { n: "halfHeight", t: "param" },
      { n: "slices",     t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { radius: 0.25, halfHeight: 0.5, slices: 12 },
    methods: {},
    description: "Capsule primitive (Y-axis). Two hemispheres joined by a cylinder. radius = cap radius; halfHeight = half the straight segment. Total height = 2*halfHeight + 2*radius. Vertex color is normal-as-RGB."
  },

  Planet: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "radius",            t: "param" },
      { n: "polarRadiusRatio",  t: "param" },
      { n: "centerX",           t: "param" },
      { n: "centerY",           t: "param" },
      { n: "centerZ",           t: "param" },
      { n: "segments",          t: "param" },
      { n: "maxDepth",          t: "param" },
      { n: "splitFactor",       t: "param" },
      { n: "heightScale",       t: "param" },
      { n: "seaLevel",          t: "param" },
      { n: "seed",              t: "param" },
      { n: "frequency",         t: "param" },
      { n: "octaves",           t: "param" },
      { n: "lacunarity",        t: "param" },
      { n: "gain",              t: "param" },
      { n: "ridges",            t: "param" },
      // §planet-spec Phase 7.a -- optional heightmap input. When wired
      // to a PlanetMap node's output, Planet samples per-vertex height
      // from the baked cubemap instead of running 3D fBm directly.
      // Same visual when the cubemap was baked from the same noise
      // params (proves the data flow); Phase 7.d+ painter will then
      // edit the cubemap and the visual diverges.
      { n: "heightmap",         t: "heightmap" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      radius: 1000, polarRadiusRatio: 1.0,
      centerX: 0, centerY: 0, centerZ: 0,
      segments: 16, maxDepth: 6, splitFactor: 5.0,
      heightScale: 0, seaLevel: 0.5,
      seed: 7.3, frequency: 1.0, octaves: 6,
      lacunarity: 2.0, gain: 0.5, ridges: 0
    },
    methods: {},
    description: "Spherified-cube planet with per-face quadtree LOD (Phase 4 of planet-spec). 6 cube faces, each adaptively subdivided into a quadtree of leaf chunks by camera distance with horizon-occlusion culling. Each leaf is a regular (segments+1)² grid in cube-face (u,v) coords, spherified + radially displaced by 3D fBm; vertex colors are Sun-Lambertian-shaded at build time for day/night terminator under unlit-vc. polarRadiusRatio (default 1.0 = perfect sphere; 0.9966 = WGS84 Earth oblate spheroid) squashes the Y axis post-spherify to mimic the equatorial bulge of a real rotating planet. (centerX, Y, Z) place the planet anywhere in world space. segments = per-chunk grid (default 16). maxDepth, splitFactor govern LOD aggressiveness. heightScale, seaLevel, seed, frequency, octaves, lacunarity, gain, ridges as in 4.b. Mesh rebuilds when the camera (relative to planet center) crosses a chunk-boundary quantum (~ radius / 2^maxDepth). Wire a PlanetMap's heightmap output here to source heights from a baked cubemap instead -- foundation for the Phase 7 heightmap painter."
  },

  PlanetMap: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "heightmap-gen",
    ins: [
      { n: "resolution", t: "param" },
      { n: "cellCount",  t: "param" },
      { n: "seed",       t: "param" },
      { n: "frequency",  t: "param" },
      { n: "octaves",    t: "param" },
      { n: "lacunarity", t: "param" },
      { n: "gain",       t: "param" },
      { n: "ridges",     t: "param" },
      { n: "jitter",     t: "param" }
    ],
    outs: [{ n: "heightmap", t: "heightmap" }],
    params: {
      // Sprint 10-7: source toggle restored. Three modes -- each one
      // a different macro-shape source for the planet cubemap; the
      // SVT / DEM / detail-amplification layers on TOP of this are
      // identical across modes.
      //
      //  "earth"  -- real-DEM-driven Earth (10-5b). Default.
      //              Africa, Eurasia, Andes, Himalayas etc. visible.
      //  "remix"  -- procedural plate layout + Earth-feature patch
      //              paste (10-8 series). For now this aliases to
      //              earth until 10-8c lands the paste pipeline;
      //              the toggle exists so 10-8d's UI can read it.
      //  "custom" -- cell-graph bake (Azgaar / Phase-7-painter).
      //              For users who want hand-painted maps.
      source: "earth",
      resolution: 512,
      cellCount: 30000,
      seed: 7.3, frequency: 1.0, octaves: 6,
      lacunarity: 2.0, gain: 0.5,
      // Sprint 10-1c: ridges 0 -> 1 ridged-multifractal for custom
      // mode. Earth mode ignores these noise params entirely.
      ridges: 1,
      jitter: 0.4
    },
    paramOptions: { source: ["earth", "remix", "custom"] },
    methods: {},
    description: "Phase 7.a-c of planet-spec -- baked cubemap heightfield for a Planet, backed by a cell graph. cellCount (default 10000) spherical-Fibonacci points are seeded on the unit sphere; each cell holds {elevation, biome, plateId}. The cubemap (resolution per face, default 256 → 256² × 6 = 393k texels) is baked via nearest-cell lookup per texel. Initial elevation = 3D fBm sampled at the cell's position, so the bake's macro shape matches the procedural fBm at low frequencies but loses sub-cell detail (visible voronoi pattern at close range until Phase 7.e adds biome-masked detail noise on top). Wire this node's heightmap output to a Planet's heightmap input. Foundation for the Phase 7.d painter -- brush strokes edit cell elevations and the cubemap re-bakes automatically. cubemapData (base64 R16 unorm) persists in .gpatch so authored maps survive save/reload."
  },

  PlanetMesh: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "radius",            t: "param" },
      { n: "polarRadiusRatio",  t: "param" },
      { n: "centerX",           t: "param" },
      { n: "centerY",           t: "param" },
      { n: "centerZ",           t: "param" },
      { n: "heightScale",       t: "param" },
      { n: "seaLevel",          t: "param" },
      { n: "subdivide",         t: "param" },
      // Sprint 9-1: cube-sphere static base resolution (legacy --
      // reachable only when the chunked path is bypassed for debug).
      { n: "gridResolution",    t: "param" },
      // Sprint 9-2: quadtree-streaming knobs. Each visible leaf is
      // a (segments+1)^2 grid in cube-face (u, v) coords; chunks
      // split when distance < chunkEdge * splitFactor up to maxDepth.
      // Foot-to-orbit on Earth radius wants maxDepth ~14-16 so leaf
      // chunkEdge gets to ~10m (Earth surface circumference 40000km /
      // 4 quadrants / 2^14 chunks per quadrant ≈ 610m per chunkEdge
      // -- enough for foot-level silhouette when segs >= 16).
      { n: "segments",          t: "param" },
      { n: "maxDepth",          t: "param" },
      { n: "splitFactor",       t: "param" },
      // Phase 8 sprint 8-3b -- texture inputs. When wired, the planet
      // body fragments sample triplanar from these textures (mixed
      // with the baked biome / water shading). When unwired, the
      // existing biome colors + procedural water shading apply.
      // textureScale = inverse world distance per repeat (0.001 =
      // 1km between repeats for Earth-scale planets). textureMix =
      // strength of the texture (0 = pure biome, 1 = pure texture).
      // Shared between land + water for now; per-side parameters can
      // be added later if the unified knob proves too coarse.
      { n: "textureScale",      t: "param" },
      { n: "textureMix",        t: "param" },
      // Phase 8 sprint 8-6: per-vertex detail-noise displacement scale.
      // detail_noise_height returns meters keyed to the biome's amp;
      // displacementScale multiplies that. Default 1.0 = use biome amp
      // as-is; bump higher (200-1000) to amplify mountains into the
      // kilometer range that breaks orbital silhouette.
      { n: "displacementScale", t: "param" },
      // Phase 8 sprint 8-7b: detail-patch params live on PlanetMesh
      // itself now (sprint 8-7 had them on a separate PlanetDetailPatch
      // node, which was an awkward extra graph wiring step). The patch
      // is auto-rendered alongside the coarse PlanetMesh when
      // detailPatchEnabled is true (default).
      { n: "detailPatchEnabled",  t: "param" },
      { n: "detailPatchSize",     t: "param" },
      { n: "detailPatchGridDim",  t: "param" },
      { n: "detailPatchBiomeId",  t: "param" },
      { n: "detailPatchDispScale", t: "param" },
      { n: "detailPatchMaxAlt",   t: "param" },
      { n: "heightmap",         t: "heightmap" },
      { n: "landTexture",       t: "texture" },
      { n: "waterTexture",      t: "texture" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      radius: 1000, polarRadiusRatio: 1.0,
      centerX: 0, centerY: 0, centerZ: 0,
      // Sprint 10-1c: heightScale 0 -> 200 (= 20% of default radius
      // 1000, i.e. ~Earth-scale 0.31% relief at sensible planet
      // sizes). With heightScale=0 (the previous default), cell
      // elevation differences NEVER show up as actual vertex height
      // -- continents look flat. The Foot-to-Orbit demo overrides
      // to 20000 for an Earth-radius planet but other patches were
      // inheriting flat. 200 reads correctly at radius=1000 and
      // scales sensibly for larger radii too.
      heightScale: 200, seaLevel: 0.5,
      subdivide: 0,
      gridResolution: 129,
      // Sprint 9-2 defaults: 16 verts/chunk-edge, splitFactor 5 =
      // split when camera is within 5x the chunk's edge-length.
      // Sprint 9-6: maxDepth bumped 12 -> 16 for foot-level
      // resolution (~10m vertex spacing under the camera at Earth
      // radius). Cap raised to 20 in the resolver for users who
      // want sub-foot detail.
      segments: 16,
      maxDepth: 16,
      splitFactor: 5.0,
      textureScale: 0.001,
      textureMix:   1.0,
      // Sprint 9-1: per-vertex detail-noise displacement retired in
      // favor of cube-sphere quadtree (Phase 9). Default 0 keeps the
      // shader path inert; user can opt back in by editing the param.
      displacementScale: 0.0,
      // Sprint 9-1: detail patch retired -- the quadtree's leaf
      // chunks (9-2) take over the foot-level detail role. Default
      // off; existing patches with detailPatchEnabled=1 still synthesize.
      detailPatchEnabled: 0,
      // Sprint 8-7c -- bigger default patch (8km) and ~10x
      // displacement so the surface relief reads even on hot-desert
      // / glacier biomes where per-biome amplitude is just a few
      // meters. User can dial back via the PlanetMap "biomes" tab
      // (rough/amp sliders) or these per-PlanetMesh knobs.
      detailPatchSize:     8000,
      detailPatchGridDim:  128,
      detailPatchBiomeId:  4,
      detailPatchDispScale: 10.0,
      detailPatchMaxAlt:   10000
    },
    methods: {},
    description: "Phase 7.d-azgaar of planet-spec -- direct cell-mesh planet, mirrors Azgaar's 3D scene mode (one mesh vertex per cell, triangles between mutually-adjacent cells). NO chunking, NO cubemap intermediate. Wire a PlanetMap's heightmap output; each cell becomes one vertex at unit_direction * (R + cell.h * heightScale * altitudeFactor) with color from _planetColorForHeight. Triangulation is built once from the cell-graph K-neighbor table (~120k triangles at cellCount=30000). subdivide=1 applies one Loop subdivision pass (Azgaar `loopSubdivision.modify(geometry, 1)` equivalent) -- 4× triangle count, smooths cell-faceting between mountains, gives the rounded terrain look from Azgaar's 3D scene. Best for orbit views; foot-level detail not provided (~130km per cell at Earth scale)."
  },

  Plane: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "width", t: "param" },
      { n: "depth", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { width: 2, depth: 2 },
    methods: {},
    description: "Flat 2D quad in the XZ plane (Y = 0 by default; wrap in a Translate to lift it). width / depth in world units. 4 verts, 6 indices -- the cheapest primitive. Vertex color is a soft cyan→teal→violet gradient by corner so the surface reads as more than a flat blob under the unlit shader. Common use: ground plane, billboard, reflection target."
  },

  /* ── Phase 8.B.15 / §8.F -- LoadGLB (glTF mesh import) ───────────── */
  LoadGLB: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "mesh-gen",
    ins: [
      { n: "url", t: "param" }, { n: "scale", t: "param" }, { n: "autoFit", t: "param" }
    ],
    outs: [
      { n: "mesh", t: "mesh" }, { n: "ready", t: "param" }
    ],
    params: { url: "", scale: 1, autoFit: 0, ready: 0 },
    methods: {},
    uiOnlyParams: ["ready"],
    description: "Imports a glTF/GLB mesh as a `mesh` output. `url` accepts `server:<id>` (stream from the compile-server asset host — drop a mesh from the Assets tab), `asset:<name>` (resolve by name through the server manifest / IDB cache), or a direct http(s) URL. Lazy-loads three.js GLTFLoader from CDN on first use (same dynamic-import pattern as Rapier), merges all primitives world-transformed into the editor's vertex format with the glTF base colors baked in, and caches the buffers. `scale` multiplies the imported geometry. `autoFit` > 0 normalizes the mesh to that size in world units (largest dimension), centered on X/Z with its base resting at y=0 — use it when a source mesh comes in at an unknown scale (props at metres vs. millimetres). `ready` is 1 once parsed; a placeholder box renders while loading. After parsing, three.js resources (incl. embedded textures) are disposed so big GLBs don't balloon memory."
  },

  /* Sprint platformer-2a -- ImageURL. Loads an image (URL, data URL,
   * or built-in preset name) and exposes it as a `texture` output for
   * downstream Sprite / future textured-mesh nodes to consume. Async:
   * starts loading on first frame the node is evaluated; subsequent
   * frames return the cached GPU texture. Failures (404, decode error)
   * leave the output null + log once to the console.
   *
   * Built-in presets (use 'preset:' prefix in the url param):
   *   preset:test4x4   -- 4x4 colorful checkerboard, useful for debugging
   *                       UV orientation / texture sampling.
   *   preset:testgrid  -- 64x64 black-on-white 8x8 grid lines.
   *
   * filterMode: "linear" (default; smooth) or "nearest" (pixel-art
   * crisp edges).
   *
   * Used at design time; texture stays resident on the GPU until the
   * node is deleted (or the URL changes). The CPU image is discarded
   * after upload. */
  ImageURL: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "image-source",
    ins: [
      { n: "url",        t: "param" },
      { n: "filterMode", t: "param" },
      { n: "wrapMode",   t: "param" },
      { n: "scale",      t: "param" }
    ],
    outs: [{ n: "texture", t: "texture" }],
    params: {
      url: "preset:test4x4",
      filterMode: "nearest",
      // Sprint platformer-parallax -- wrap mode controls the sprite
      // sampler's addressModeU/V. 'clamp' (default) for normal sprites,
      // 'repeat' for parallax bg layers that need the texture to tile
      // as the camera moves. 'repeat-x' / 'repeat-y' for single-axis.
      wrapMode: "clamp",
      scale: 32
    },
    methods: {},
    paramOptions: { filterMode: ["nearest", "linear"], wrapMode: ["clamp", "repeat", "repeat-x", "repeat-y"] },
    description: "Load an image into a GPU texture. url can be an http(s):// URL, a data:image/... URL, an 'asset:NAME' reference to an Assets-library sprite, or 'preset:NAME' built-in (preset:test4x4 = 2×2 color grid, preset:testgrid = 8×8 line grid). filterMode 'nearest' = pixel-art crisp, 'linear' = smooth bilinear. **scale** (pixels per world unit, default 32) is a hint used when this ImageURL is dropped into a patch via an asset drag: Sprite.width = (texW / framesX) / scale and height = (texH / framesY) / scale. A 32×32 sprite at scale=32 → 1×1 world units; halve scale to double the rendered size. After-drop edits to scale don't auto-update existing Sprites (Sprite.width/height are independent); edit Sprite directly for live resize, or re-drop the asset to apply the new scale. Wire output `texture` into Sprite.texture for a textured sprite. Async load: first 1-2 frames after creation may show the Sprite as untextured while the image fetches; once loaded the texture stays cached."
  },

  /* Sprint SpriteCreator-1 -- SpriteCreator. A "sprite project" node:
   * holds defaults for prompt + style + size + frames + fps + scale
   * for generating one or more related sprites. Click its gear handle
   * (⚙) to open the Sprite Studio modal preloaded with these defaults.
   * On save, the node remembers the last-created asset name so future
   * patches can wire `ImageURL("asset:" + node.params.lastAssetName)`
   * directly into a Sprite.
   *
   * No runtime behavior: this is a design-time node. The actual texture
   * delivery still flows through ImageURL + Sprite as usual. Output
   * port `lastAsset` (string) emits the most recently saved asset's
   * name so downstream nodes can react to "studio just generated X". */
  SpriteCreator: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "sprite-creator",
    ins: [
      { n: "prompt",   t: "param" },
      { n: "style",    t: "param" },
      { n: "width",    t: "param" },
      { n: "height",   t: "param" },
      { n: "framesX",  t: "param" },
      { n: "framesY",  t: "param" },
      { n: "fps",      t: "param" },
      { n: "scale",    t: "param" }
    ],
    outs: [{ n: "lastAsset", t: "param" }],
    params: {
      prompt: "small red fox, side view, idle pose",
      style: "snes",
      // Bumped 32 -> 128 with the gen-quality push: 1024-native SD
      // output downsampled to 128px keeps usable detail (modern indie
      // pixel-art baseline). Scale matches so the sprite lands at
      // ~1 world unit in Scene2D regardless of pixel resolution.
      width: 128, height: 128,
      framesX: 1, framesY: 1,
      fps: 8, scale: 128,
      // Set by the modal's Save flow. uiOnly so codegen ignores it.
      lastAssetName: ""
    },
    methods: {},
    paramOptions: { style: ["snes", "nes", "gameboy", "modern"] },
    uiOnlyParams: ["lastAssetName"],
    description: "Sprite Studio launcher node. Click the ⚙ gear handle below the node to open the Sprite Studio modal preloaded with these defaults. prompt is the description sent to the LLM; style picks a palette/aesthetic preset (snes = 16-bit, nes = 8-bit 4-color, gameboy = 4-green palette, modern = free); width/height are PIXEL dimensions of the sheet; framesX/framesY split the sheet into a grid for animation; fps is the animation rate (used at Sprite-creation time); scale is pixels per world unit (used at asset-drop time). Saved sprites go to the asset library (Assets tab); lastAssetName output emits the most recently saved name so downstream nodes can wire ImageURL.url to 'asset:<lastAssetName>'."
  },

  /* Sprint 8.0.2-f -- Sprite. Flat XY quad centered on origin,
   * facing +Z by default. The "2D" face plane (vs Plane's XZ
   * footprint) -- positioning a Sprite at world (x, y, 0) drops
   * it directly into a Scene2D view with no Translate gymnastics.
   *
   * Params:
   *   width / height   -- size in world units (default 1×1)
   *   anchorX/Y        -- normalized origin within the quad
   *                       (0.5 = center, 0 = left/bottom edge,
   *                        1 = right/top edge). Lets you pin a
   *                       sprite by its feet (anchorY=0) for
   *                       Scene25D Y-sort, or pin by center
   *                       for Scene2D rotation.
   *   tintR/G/B/A      -- color multiplier (vertex color), 1=identity
   *   pivotZ           -- Scene25D Y-sort hint: depth offset from
   *                       transform position. Sprites with larger
   *                       pivotZ draw in front. Ignored by Scene2D
   *                       (uses input slot order) and Scene3D
   *                       (uses true depth buffer).
   *
   * Output is the standard mesh type so any scene (Scene/Scene3D/
   * Scene2D/Scene25D) can consume it. Vertex layout matches the
   * shared unlit-vc pipeline (pos3 + col3 + nrm3 + uv2). */
  Sprite: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "texture",  t: "texture" },
      { n: "width",    t: "param" },
      { n: "height",   t: "param" },
      { n: "anchorX",  t: "param" },
      { n: "anchorY",  t: "param" },
      { n: "tintR",    t: "param" },
      { n: "tintG",    t: "param" },
      { n: "tintB",    t: "param" },
      { n: "tintA",    t: "param" },
      { n: "pivotZ",   t: "param" },
      { n: "frame",    t: "param" },
      { n: "framesX",  t: "param" },
      { n: "framesY",  t: "param" },
      { n: "flipX",    t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      width: 1, height: 1,
      anchorX: 0.5, anchorY: 0.5,
      tintR: 1, tintG: 1, tintB: 1, tintA: 1,
      pivotZ: 0,
      frame: 0, framesX: 1, framesY: 1,
      flipX: 0
    },
    methods: {},
    description: "2D sprite quad in the XY plane (facing +Z). The 2D-native primitive: drop a Sprite into a Scene2D and position it directly with Translate(x, y, 0). anchorX/anchorY (0..1) controls where the quad's origin sits -- anchorX=0.5 / anchorY=0.5 = center (default); anchorX=0.5 / anchorY=0 = pin-by-feet (use with Scene25D for proper Y-sort). tintR/G/B/A is a vertex-color multiplier (1,1,1,1 = white identity). pivotZ is a Scene25D-only sort hint. **Textured mode (platformer-2a):** wire an ImageURL into `texture` to map an image onto the quad; frame / framesX / framesY pick a sub-rect from a spritesheet (frame=0..framesX*framesY-1, walks the grid left-to-right then top-to-bottom). flipX=1 mirrors the texture horizontally (use facing direction from PlatformerBody2D for left/right walk animation)."
  },

  Torus: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "majorRadius", t: "param" },
      { n: "minorRadius", t: "param" },
      { n: "majorSlices", t: "param" },
      { n: "minorSlices", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { majorRadius: 1, minorRadius: 0.3, majorSlices: 24, minorSlices: 12 },
    methods: {},
    description: "Donut primitive. majorRadius is the distance from the center of the hole to the center of the tube; minorRadius is the tube thickness. majorSlices (3..128) controls the outer ring resolution, minorSlices (3..64) the tube cross-section. Vertex color from surface normal. Defaults give a classic donut at ~325 verts."
  },

  Cylinder: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "radius", t: "param" },
      { n: "height", t: "param" },
      { n: "slices", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { radius: 0.5, height: 1, slices: 24 },
    methods: {},
    description: "Cylinder primitive centered at origin, axis along +Y. radius + height in world units; slices (3..128) is the angular resolution. Includes top + bottom caps so the shape is closed. Top cap tints brighter (cyan-ish), bottom darker (slate); side wall is normal-based color so the curved surface reads cleanly at any rotation."
  },

  Cone: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "radius", t: "param" },
      { n: "height", t: "param" },
      { n: "slices", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { radius: 0.5, height: 1, slices: 24 },
    methods: {},
    description: "Cone primitive: apex at +Y, circular base at -Y. radius is the base radius; height is apex-to-base distance. slices (3..128) is the angular resolution. Includes bottom cap. Vertex color fades from a warm apex (gold) to a cool base (slate)."
  },

  /* Phase 7 §5.5.a — Terrain. Heightmap-displaced XZ grid mesh.
   * For this first push the displacement uses BUILT-IN fBm noise
   * computed CPU-side at mesh-build time (same hash + octave-mix
   * formula ProceduralTerrain uses in WGSL, so dialing in the noise
   * params here previews what ProceduralTerrain would emit). The
   * GPU heightmap-texture-into-vertex-shader path (so Terrain can
   * sample ProceduralTerrain.out per-frame) lands in a later sprint
   * once the mesh pipeline grows a per-mesh heightmap binding.
   *
   * Built-in noise params (seed/frequency/octaves/lacunarity/gain/
   * ridges) deliberately mirror ProceduralTerrain's so the eventual
   * wired path is a drop-in.
   *
   * Y convention: peaks land at Y = 0 (the conventional ground
   * level), valleys extend DOWN to Y = -heightScale. With the
   * default Scene camera at (0, 0, 5) looking at the origin (Y =
   * 0), the terrain spreads out from the horizon DOWNWARD instead
   * of dominating the upper half of the screen -- fixes the "the
   * terrain is the ceiling" complaint from the first §5.5.a push.
   * `yOffset` overrides if you want peaks above Y = 0.
   *
   * sizeMode lets you flip between numeric world sizes ("custom"
   * honors the `worldSize` param) and convenience presets ("small"
   * = 20 units, "medium" = 100, "large" = 1000, "infinite" = 10000
   * -- single-mesh terrain at this size is heavy on the GPU; the
   * proper infinite-landscape path lands in §5.5.c via chunked
   * streaming).
   *
   * Normals come from finite differences on the height field --
   * accurate enough for shading without an extra pass. Vertex color
   * grades by altitude (slate-blue valleys → grass → rock → snow
   * caps) so the mesh reads as terrain under the default unlit-vc
   * material. Pair with a Phong / PBR material when you want lit
   * terrain (the default unlit-vc ignores wired DirectionalLight /
   * PointLight -- that's not a bug, it's the unlit material's
   * spec). */
  Terrain: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      // v0.3.126 §5.5.c-3 -- heightmap texture input. When wired,
      // the mesh emits a FLAT grid (no CPU-side displacement) and
      // vs_terrain samples the wired texture per-vertex for Y
      // displacement. When unwired, the built-in noise params
      // below drive a CPU-side displaced grid (the §5.5.a path).
      { n: "heightmap",   t: "texture" },
      { n: "sizeMode",    t: "param" },
      { n: "worldSize",   t: "param" },
      { n: "heightScale", t: "param" },
      { n: "yOffset",     t: "param" },
      { n: "segments",    t: "param" },
      { n: "seed",        t: "param" },
      { n: "frequency",   t: "param" },
      { n: "octaves",     t: "param" },
      { n: "lacunarity",  t: "param" },
      { n: "gain",        t: "param" },
      { n: "ridges",      t: "param" },
      // §bonus-parity (2026-05-25) -- plateau remap. Matches the
      // TiledTerrain param of the same name so a noise-tuned design
      // ports cleanly between the two nodes. 0 = pure fBm (existing
      // behavior); 1 = strongly remapped toward "isolated peaks in
      // flat plain" via h^(1 + 4*plateau).
      { n: "plateau",     t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      sizeMode:    "medium",
      worldSize:   100,
      heightScale: 12,
      yOffset:     0,
      segments:    64,
      seed:        1.234,
      frequency:   2.0,
      octaves:     5,
      lacunarity:  2.0,
      gain:        0.5,
      ridges:      0.0,
      plateau:     0.0
    },
    paramOptions: { sizeMode: ["custom", "small", "medium", "large", "infinite"] },
    methods: {},
    description: "Heightmap-displaced terrain grid. heightmap input (Phase 7 §5.5.c-3) — wire ProceduralTerrain.out (or any texture source) and the mesh becomes a FLAT grid + the vertex shader samples your heightmap per-vertex for the Y displacement (cheap to animate). When unwired, the built-in fBm noise params (seed / frequency / octaves / lacunarity / gain / ridges) drive a CPU-displaced grid (the §5.5.a fallback path; same algorithm ProceduralTerrain uses, so visually equivalent for matching params). sizeMode picks the overall extent: custom (uses worldSize), small (20u), medium (100u), large (1000u), infinite (10000u; single-mesh, heavy — proper chunked streaming lands in §5.10). heightScale scales peak height. yOffset shifts the whole stack vertically (default 0 = peaks at horizon, valleys descend to -heightScale). segments (1..256) controls mesh resolution per axis (64 = 4225 verts, 8192 tris). Vertex color grades by altitude (blue valleys → grass → rock → snow caps); pair with PhongMat / PhysicalMat / TerrainMaterial between Terrain and Scene for lit shading."
  },

  /* Phase 7 §5.5.e — TiledTerrain. Chunked, camera-follow terrain
   * for "infinite" walkable worlds. Generates an N×N grid of chunks
   * centered on the wired Camera / FPCamera position; chunks regen
   * as the camera crosses tile boundaries. fBm heights are sampled
   * in WORLD space (not per-chunk UV) so chunk seams are exact.
   * Use the ⚙ handle on the node to open the Tiling Config popup
   * for chunk size + radius + segment count + minimap toggle.
   * Pair with TerrainMaterial + FPCamera + DirectionalLight for the
   * "walkable open-world test patch" demo. */
  TiledTerrain: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "chunkSize",   t: "param" },
      { n: "chunkRadius", t: "param" },
      { n: "segments",    t: "param" },
      { n: "heightScale", t: "param" },
      { n: "yOffset",     t: "param" },
      { n: "seed",        t: "param" },
      { n: "frequency",   t: "param" },
      { n: "octaves",     t: "param" },
      { n: "lacunarity",  t: "param" },
      { n: "gain",        t: "param" },
      { n: "ridges",      t: "param" },
      { n: "plateau",     t: "param" },
      { n: "forwardBias", t: "param" },
      // §5.5.e-8 -- built-in erosion. Baked at chunk build time.
      { n: "erosionThermal",    t: "param" },
      { n: "erosionHydraulic",  t: "param" },
      { n: "erosionTalus",      t: "param" },
      { n: "erosionIterations", t: "param" },
      { n: "erosionRadius",     t: "param" },
      { n: "erosionStrength",   t: "param" },
      // §5.5.e-10 -- island modes. "off" = infinite plain. "single"
      // = one radial island around (islandCenterX, islandCenterZ).
      // "archipelago" = multiple distinct islands driven by a low-
      // frequency noise mask -- player can walk between them on
      // the ocean floor (or swim, once Water lands).
      { n: "islandMode",          t: "param" },
      { n: "islandCenterX",       t: "param" },
      { n: "islandCenterZ",       t: "param" },
      { n: "islandRadius",        t: "param" },
      { n: "islandFalloff",       t: "param" },
      { n: "islandSinkDepth",     t: "param" },
      { n: "islandMaskFreq",      t: "param" },
      { n: "islandMaskSeed",      t: "param" },
      { n: "islandMaskThreshold", t: "param" },
      { n: "islandMaskSoftness",  t: "param" },
      { n: "islandBeachStrength", t: "param" },
      { n: "islandBeachFreq",     t: "param" }
    ],
    outs: [
      { n: "mesh",      t: "mesh" },
      // §5.5.h -- heightmap-ref output. Wire into Water.heightmap so
      // the water shader can sample the SAME noise + island LERP +
      // LOD discretization the rendered terrain mesh uses. Without
      // this wire the water has no shore detection at all (foam
      // disabled, just open water).
      { n: "heightmap", t: "heightmap" }
    ],
    params: {
      chunkSize:   64,           // world units per chunk side (= meters at 1u=1m)
      chunkRadius: 8,            // chunks from center -> 17×17 grid = 1088m visible disc
      segments:    24,           // inner-LOD segments per chunk; mid=12, outer=6
      heightScale: 80,           // mountain-scale peaks: ±80m at default freq
      yOffset:     -20,          // pull mean ground level down so eye-height stays above sea
      seed:        7.42,
      frequency:   0.008,        // cycles/m -- one major feature every ~120m
      octaves:     6,
      lacunarity:  2.05,
      gain:        0.5,
      ridges:      0.5,          // mountain-crest sharpening
      plateau:     0.0,          // 0 = rolling-hill fBm; 1 = sharp isolated peaks in flat plain
      forwardBias: 0.0,          // 0 = symmetric disc; 0.4 = shifts loaded disc 40% radius forward of camera look direction (yaw-quantized to 45°)
      // §5.5.e-8 -- built-in erosion knobs. Skipped when strength=0.
      // Bake-once at chunk build time; no per-frame cost. Defaults
      // off so the bare TiledTerrain emits pure fBm; demos crank
      // strength up for natural weathered look.
      erosionThermal:    0.65,
      erosionHydraulic:  0.55,
      erosionTalus:      0.02,
      erosionIterations: 4,
      erosionRadius:     80,
      erosionStrength:   0.0,
      // §5.5.e-10 island modes. Off by default; demos opt in.
      islandMode:          "off",     // "off" / "single" / "archipelago"
      // -- "single" mode params:
      islandCenterX:       0,
      islandCenterZ:       0,
      islandRadius:        2500,
      islandFalloff:       2.0,
      // -- shared between single + archipelago:
      islandSinkDepth:     2200,
      // -- "archipelago" mode params (noise-mask-driven islands):
      islandMaskFreq:      0.00012,   // ~1 cycle per ~8km -> islands ~few km across
      islandMaskSeed:      11.7,
      islandMaskThreshold: 0.50,      // mask value above this = land
      islandMaskSoftness:  0.08,      // smoothstep width around the threshold
      // §5.5.h-9 -- patchy beaches around island shores. Flattens land
      // elevation toward yOff+4m where coastal noise (controlled by
      // BeachFreq) is high AND the island mask is in the shore band.
      // Beach noise seed is derived as MaskSeed+17.3 so adjusting the
      // island layout naturally varies beach placement too. Default
      // 0 = off; existing patches don't get beaches without opt-in.
      islandBeachStrength: 0.0,
      islandBeachFreq:     0.0008,    // ~1 cycle per ~1.3km -> beach patches a few hundred m wide
      // Tiling-config-popup-only knobs (hidden from the default port row).
      anchorMode:  "auto",       // "auto" follows first FPCamera; "manual" uses centerX/Z
      centerX:     0,
      centerZ:     0
    },
    paramOptions: {
      anchorMode: ["auto", "manual"],
      islandMode: ["off", "single", "archipelago"]
    },
    uiOnlyParams: ["anchorMode", "centerX", "centerZ"],
    methods: {},
    description: "Phase 7 §5.5.e chunked terrain at mountain scale with per-chunk streaming. Each chunk has its own VBO+IBO and is built incrementally (~10ms budget per frame); crossing tile boundaries doesn't stall. As the camera moves, chunks leaving the visible disc are destroyed and new chunks build in their place. Per-chunk frustum culling skips off-view chunks at draw time. 5-ring distance-LOD (24/12/6/3/2 segments) with vertical skirts masking T-junction seams. World-space fBm sampling: seams are exact along same-LOD edges, skirts cover gaps at LOD edges. Defaults are mountain-scale at 1u=1m: chunkSize=64m, chunkRadius=8, segments=24, heightScale=80m. plateau (0..1) flattens low/mid altitudes for isolated peaks in plains. forwardBias (0..1) shifts the loaded disc toward the player's walk direction (8-cardinal-direction snap with 700ms hysteresis) so they see further forward than behind. erosionStrength (0..1) bakes a hydraulic+thermal erosion pass into the chunk mesh at build time -- carves ridges + settles valleys with no per-frame cost. Pair with TerrainMaterial + FPCamera. Drop a Minimap node + wire it to Scene.hud1 for a top-down overlay. Open the ⚙ Tiling Config popup on the node for the full knob set + a live preview. Anchor mode = manual locks the grid origin to (centerX, centerZ) instead of camera-follow."
  },

  /* Phase 7 §5.5.h-23 -- TerrainHorizon. Single low-poly mesh that
   * extends terrain coverage far past the chunked TiledTerrain disc.
   * Samples the SAME noise field at lower octaves + skips erosion,
   * so the big-shape mountain silhouettes match TiledTerrain at the
   * inner-edge meeting line. Camera-follows in coarse macro-tile
   * steps (default 10km) -- mesh stays put within a tile, jumps to a
   * new center when the camera crosses a tile boundary. Per-vertex
   * altitude-band coloring is baked in (sand / grass / rock / snow)
   * so the impostor doesn't need a TerrainMaterial; renders with the
   * default fs_unlit_vc pipeline, dirt-cheap.
   *
   * Bridges TODAY's 16km chunked disc to ~100km out, and is the
   * geometric foundation for the future planet-curvature blend (the
   * single mesh can be vertex-shader-warped into a sphere section
   * progressively as the camera flies high). */
  TerrainHorizon: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "extent",        t: "param" },
      { n: "subdivisions",  t: "param" },
      { n: "tileSize",      t: "param" },
      { n: "yBias",         t: "param" },
      { n: "octavesCap",    t: "param" },
      { n: "curveAltLow",   t: "param" },
      { n: "curveAltHigh",  t: "param" },
      { n: "planetRadius",  t: "param" },
      { n: "visAltLow",     t: "param" },
      { n: "visAltHigh",    t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      // §planet-spec Phase 3 -- the impostor now samples the SAME
      // noise field as the upstream chunked TiledTerrain (no
      // frequency rescaling). Octave count is derived per-build from
      // the impostor's vertex spacing via the Nyquist rule -- coarse
      // spacing automatically truncates to the few low-freq octaves
      // that can be resolved without aliasing. 5000km extent + 128
      // subs = ~39km/vert; octavesCap=20 means "no extra ceiling
      // beyond what spacing allows", just inherit the TiledTerrain's
      // octaves as the upper bound.
      extent:         5000000,
      subdivisions:   128,
      tileSize:       500000,
      yBias:          -0.5,
      octavesCap:     20,
      // §5.5.h-27 -- curve activation altitude dropped 8km -> 1km so
      // the user sees the bend kick in as soon as they leave ground
      // level, instead of needing to climb 8km of invisible-flat-Earth
      // before the curvature warp starts ramping. A small artistic
      // compromise vs. real Earth (where curvature is invisible until
      // ~20km altitude), but the user can crank these back up.
      curveAltLow:    1000,
      curveAltHigh:   25000,
      planetRadius:   6378000,
      // §planet-spec Phase 1.5 -- visibility gate. The impostor is a
      // coarse low-poly mesh that's only useful as a far-distance
      // "planet from above" backdrop. At low altitude it looks like
      // a flat tiled plane stretching to the horizon and ruins the
      // chunked-terrain view. fs_horizon discards every fragment
      // below visAltLow; fades in over [visAltLow, visAltHigh].
      // Default 60km..100km: invisible until orbital altitude.
      visAltLow:      60000,
      visAltHigh:     100000
    },
    methods: {},
    description: "Low-poly terrain impostor that extends visible coverage past TiledTerrain's chunked disc out to ~50km from the camera. Auto-detects the patch's TiledTerrain and samples the same noise (capped at `octaves`, no erosion) so big-shape silhouettes match the chunked disc at the inner-edge meeting line. Macro-tile camera-follow (default 10km) keeps the mesh roughly centered without per-frame rebuilds. Per-vertex altitude colors baked in so it renders unlit-vc with no material wire needed. `yBias` is a small downward offset (default -0.5m) so the chunked terrain wins the depth test in the overlap zone."
  },

  /* Phase 7 §5.5.h -- Water. Mesh-gen + baked-in water material.
   * Emits a single huge XZ plane at Y = seaLevel (100km × 100km --
   * effectively infinite for any walking session). Material is
   * applied automatically by the Scene encoder when m.node.type ===
   * "Water" so users don't need a separate WaterMat node. Phase 1
   * shader: animated wave normals from time-shifted fBm UVs +
   * Fresnel-mixed sky reflection (sky color is hardcoded for now;
   * future: read from a wired environment). Phase 2 will add SSR
   * (screen-space reflection ray-march) once the Scene exposes its
   * color+depth attachments to post-process passes. */

  /* Sprint 8.0.3-a -- TerrainCollider. Exposes the same height
   * field the renderer + FPCamera walk-mode use, as a queryable
   * API for foliage placement, simple character controllers,
   * future physics (Rapier mesh colliders land in §8.0.3-b),
   * AI ground-snap, prop pivot alignment, etc.
   *
   * Sources, in priority order (auto-resolved at query time):
   *   1. The wired `terrain` upstream chain (Terrain / TiledTerrain
   *      / Planet / PlanetMesh / TerrainHorizon).
   *   2. First TiledTerrain found in the scene.
   *   3. First Planet/PlanetMesh found in the scene (queried via
   *      the projected-flat path -- spawn-pole-tangent).
   *
   * Query API surface:
   *   window.__COLLIDER.heightAt(wx, wz)        → world Y or null
   *   window.__COLLIDER.radialHeightAt(dx,dy,dz) → planet surface
   *                                                radius (planet
   *                                                source only)
   *
   * The node itself emits a `height` output -- wiring it into a
   * downstream param at (wx, wz) yields the surface Y at that
   * point. Foliage / scatter nodes (10-5d) will consume this. */
  TerrainCollider: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "collider",
    ins: [
      { n: "terrain",    t: "mesh" },
      { n: "world3d",    t: "param" },
      { n: "queryX",     t: "param" },
      { n: "queryZ",     t: "param" },
    ],
    outs: [
      { n: "height",       t: "param" },
      { n: "trimeshReady", t: "param" }
    ],
    params: {
      queryX: 0, queryZ: 0,
      surfaceMode: 0,
      useTrimesh: 0,
      trimeshRes: 32,
      trimeshSize: 20,
      trimeshReady: 0
    },
    paramOptions: { surfaceMode: ["ground", "water"] },
    methods: {},
    uiOnlyParams: ["trimeshReady"],
    description: "Queryable collision surface for Terrain / TiledTerrain / Planet / PlanetMesh. Height query via (queryX, queryZ) → height output. useTrimesh=1 + wire world3d from a PhysicsWorld3D: samples the heightmap into a Rapier 3D heightfield collider (trimeshRes × trimeshRes grid, trimeshSize world units). trimeshReady=1 when the 3D collider is built. surfaceMode picks ground vs water."
  },

  /* ── Phase 8.0.3-c -- WaterCollider ─────────────────────────────── */
  WaterCollider: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "", kind: "physics-collider",
    ins: [
      { n: "world3d",   t: "param" },
      { n: "yLevel",    t: "param" },
      { n: "sizeX",     t: "param" },
      { n: "sizeZ",     t: "param" }
    ],
    outs: [
      { n: "bodyCount", t: "param" }
    ],
    params: {
      yLevel: 0, sizeX: 20, sizeZ: 20, bodyCount: 0
    },
    methods: {},
    uiOnlyParams: ["bodyCount"],
    description: "Water-surface sensor collider for Rapier 3D. Creates a thin box sensor at yLevel spanning sizeX × sizeZ. Bodies crossing the surface fire ContactEvent2D enter/exit triggers. Wire PhysicsWorld3D.world → world3d."
  },

  Water: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "seaLevel",         t: "param" },
      { n: "colorR",           t: "param" },
      { n: "colorG",           t: "param" },
      { n: "colorB",           t: "param" },
      { n: "waveFreq",         t: "param" },
      { n: "waveSpeed",        t: "param" },
      { n: "waveAmp",          t: "param" },
      { n: "fresnelStrength",  t: "param" },
      { n: "skyR",             t: "param" },
      { n: "skyG",             t: "param" },
      { n: "skyB",             t: "param" },
      // §5.5.h-3 -- shore + wave-shore-interaction knobs.
      { n: "foamWidth",        t: "param" },
      { n: "shallowDepth",     t: "param" },
      { n: "waveShoreFreq",    t: "param" },
      { n: "foamR",            t: "param" },
      { n: "foamG",            t: "param" },
      { n: "foamB",            t: "param" },
      // §5.5.h-5 -- explicit terrain reference. Wire a TiledTerrain's
      // `heightmap` output here so the water shader can compute
      // LOD-matched depth that aligns with the rendered mesh. Without
      // this wire the foam line drifts off the visible shore.
      { n: "heightmap",        t: "heightmap" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      seaLevel:        0,
      colorR:          0.10, colorG: 0.32, colorB: 0.48,
      waveFreq:        0.012,    // cycles per world unit
      waveSpeed:       0.6,
      waveAmp:         1.0,      // strength of normal perturbation
      fresnelStrength: 1.0,
      // Sky color for the Fresnel reflection. Soft hazy blue by
      // default; future: read from wired Environment.
      skyR:            0.62, skyG: 0.78, skyB: 0.92,
      // §5.5.h-3 shore + wave-shore interaction.
      foamWidth:       6,        // meters of water depth where foam fades out
      shallowDepth:    40,       // meters depth where shallow-shore color blend fades
      waveShoreFreq:   0.018,    // moving wave-crest spatial frequency (cycles/m of depth)
      foamR:           0.96, foamG: 0.97, foamB: 1.00
    },
    methods: {},
    description: "Phase 7 §5.5.h water surface. Emits a 100km × 100km plane mesh at Y=seaLevel with a baked water material -- Scene auto-applies the fs_water fragment shader when the mesh's source node is `Water`. Effects: animated wave normals (time-shifted fBm UV sample → perturbed normal each fragment); Fresnel sky-color reflection (Schlick power 5); shore detection by sampling the patch's TiledTerrain noise in-shader → shallow-water tint + foam band + moving wave-crests that sweep toward the coastline. waveFreq is cycles per world unit (default 0.012 ≈ ~80m wavelength). foamWidth (m) controls how far from the shoreline foam fades out; shallowDepth (m) is the shallow-color blend range. waveShoreFreq controls the spacing of moving wave-crest lines near the coast. Wire `mesh` into a Scene mesh slot like any other mesh. Phase 2 (SSR ray-march reflection) ships next."
  },

  /* Phase 7 §5.5.h-14 -- Clouds3D. Volumetric clouds as a real mesh
   * in the scene, not a skybox effect. Decouples cloud rendering
   * from ProceduralSky so:
   *   - Clouds are at a fixed world altitude (no parallax oddities
   *     during rotation, since they're real geometry)
   *   - Other meshes can be in front of / behind clouds correctly
   *   - The node can grow features (multi-layer, real volumetric
   *     ray-marching, lightning, etc.) without entangling the sky
   * MVP v1 is a flat plane at altitude Y with 2-layer fbm noise +
   * sun-direction shading. v2 will swap the plane for a true slab
   * with ray-marched volumetric integration. */
  Clouds3D: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-gen",
    ins: [
      { n: "altitude",    t: "param" },
      { n: "puffHeight",  t: "param" },
      { n: "bottomRound", t: "param" },
      { n: "chunkSize",   t: "param" },
      { n: "chunkRadius", t: "param" },
      { n: "segments",    t: "param" },
      { n: "coverage",    t: "param" },
      { n: "density",     t: "param" },
      { n: "scale",       t: "param" },
      { n: "seed",        t: "param" },
      { n: "colorR",      t: "param" },
      { n: "colorG",      t: "param" },
      { n: "colorB",      t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      altitude:    2500,    // base cloud Y in world units (mid-puff plane)
      puffHeight:  600,     // upward displacement above altitude
      bottomRound: 0.7,     // downward displacement scale (1.0 = mirror top, 0 = flat bottom)
      // Chunked-streaming controls (mirror TiledTerrain semantics):
      chunkSize:   1800,    // world units per chunk side
      chunkRadius: 5,       // chunks from center -> 11x11 grid -> 19.8km visible disc
      segments:    28,      // per-chunk subdivisions at inner LOD
      // Cloud shape:
      coverage:    0.45,    // 0..1 -- fraction of sky with clouds
      density:     1.0,     // opacity multiplier
      scale:       0.0008,  // noise frequency on world XZ
      seed:        11.3,
      colorR:      1.0, colorG: 1.0, colorB: 1.0
    },
    methods: {},
    description: "Chunked, streaming 3D cloud layer rendered as displaced mesh puffs. Each chunk emits two heightfield surfaces -- top displaces UP by up to puffHeight where noise exceeds the coverage threshold, bottom displaces DOWN by puffHeight × bottomRound so puffs are rounded on BOTH sides (not flat-bottomed slabs). The chunk grid streams like TiledTerrain: chunks within chunkRadius of the camera are built, far ones drop, and a 5-ring LOD distribution makes inner chunks denser than outer ones. ~50x cheaper than volumetric ray-march; chunking on top buys per-frame frustum cull + lets per-chunk segment counts go higher for nicer detail without exploding total verts. Wire `mesh` into a Scene mesh slot."
  },

  /* =========================================================================
   * Sprint 7.5.3b -- Mesh transforms
   *
   * Three chainable affine transforms. Each takes a `mesh` input
   * (from a primitive or a deeper transform chain) and emits a `mesh`
   * output with its own local matrix accumulated onto the chain. The
   * Scene's mesh resolver walks the chain leaf-up, multiplying local
   * matrices into the right side of the accumulator -- so the
   * leaf-side (closest to the primitive) transforms apply FIRST to
   * vertices, and root-side (closest to Scene) transforms apply LAST.
   *
   * Example:  Box → Rotate(45° Y) → Translate(2, 0, 0) → Scene
   *           rotates the box around its origin, then moves it +2 X
   *           (satellite orbiting nothing -- it's spun in place then
   *           offset).
   *
   *           Box → Translate(2, 0, 0) → Rotate(45° Y) → Scene
   *           translates the box first, then rotates it -- you get
   *           the box swinging around the world origin.
   *
   * No codegen (mesh-transform is JS-side only). Params are scalars
   * so they accept wires from any JS-readable source (Slider,
   * MasterClock, OscIn, math chains). ======================================================================== */
  Translate: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-transform",
    ins: [
      { n: "mesh", t: "mesh" },
      { n: "x",    t: "param" },
      { n: "y",    t: "param" },
      { n: "z",    t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { x: 0, y: 0, z: 0 },
    methods: {},
    description: "Translate a mesh by (x, y, z) world units. Wire any JS-readable source into x/y/z for animated translation: MasterClock.beat for tempo-locked bouncing, Slider for live control, OscIn for external automation. Chain order matters: T(2,0,0) → R(45° Y) → Scene swings the mesh around the world origin; R → T → Scene rotates the mesh in place then offsets it."
  },

  Rotate: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-transform",
    ins: [
      { n: "mesh",   t: "mesh" },
      { n: "angleX", t: "param" },
      { n: "angleY", t: "param" },
      { n: "angleZ", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { angleX: 0, angleY: 0, angleZ: 0 },
    methods: {},
    description: "Rotate a mesh by Euler angles (degrees) in X-Y-Z order: Rz · Ry · Rx · vertex, so the user's intuition 'spin around X, then Y, then Z' matches the result. Wire angleY into MasterClock.phase × 360 for one full revolution per beat; wire into a Slider for live control. Combine with Translate to build orbit / pivot animations."
  },

  Scale: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "mesh-transform",
    ins: [
      { n: "mesh",    t: "mesh" },
      { n: "x",       t: "param" },
      { n: "y",       t: "param" },
      { n: "z",       t: "param" },
      { n: "uniform", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { x: 1, y: 1, z: 1, uniform: 0 },
    methods: {},
    description: "Scale a mesh along each axis. x/y/z are individual scale factors (1 = no change). Set `uniform` to any non-zero value to override the per-axis values with a single scale (handy when you want to drive size from one Slider). Wire `uniform` to MasterClock.beat-derived values for breath / pulse effects."
  },

  /* =========================================================================
   * Sprint 7.5.3c -- Materials + lighting
   *
   * Materials are inline mesh-chain wrappers (mesh in -> mesh out)
   * that tag the wrapped mesh with a surface-shading model. The
   * Scene walker captures the outermost material in the chain + the
   * encoder picks the matching fragment shader at draw time.
   *
   * Chain semantics:
   *   Box -> PhongMat(color=red, shin=64) -> Rotate -> Scene
   *   - Box's vertices flow up
   *   - Rotate accumulates its local matrix into the model transform
   *   - PhongMat tags the chain with the phong material
   *   - Scene renders Box with Phong shading + the rotation applied
   *
   * Wrapping order: the OUTERMOST material wins (closest to Scene).
   * Inner materials in nested wrappers are ignored. This matches the
   * scene-graph "child overrides parent material" pattern inverted
   * for the data-flow direction.
   *
   * No codegen for materials -- pure JS-side configuration; the WGSL
   * fragment shaders live in _MESH_WGSL. ======================================================================== */
  UnlitMat: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "material",
    ins: [
      { n: "mesh",      t: "mesh" },
      { n: "r",         t: "param" },
      { n: "g",         t: "param" },
      { n: "b",         t: "param" },
      { n: "vertexMix", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { r: 1.0, g: 1.0, b: 1.0, vertexMix: 0.0 },
    methods: {},
    description: "Unlit (no shading) surface material. Emits the material color as the surface RGB regardless of lighting / normals -- meshes appear flat-shaded. r/g/b in [0..1]. vertexMix in [0..1] blends from pure material color (0) to the mesh's per-vertex color (1) -- useful for tinting normal-derived colors on Sphere/Torus/Cylinder/Cone, or for keeping Box's per-face palette while applying a global tint. Wire the mesh chain through this node to apply the material; chain leaves the mesh through `mesh` output."
  },

  PhongMat: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "material",
    ins: [
      { n: "mesh",      t: "mesh" },
      { n: "r",         t: "param" },
      { n: "g",         t: "param" },
      { n: "b",         t: "param" },
      { n: "shininess", t: "param" },
      { n: "ambient",   t: "param" },
      { n: "vertexMix", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { r: 0.85, g: 0.85, b: 0.92, shininess: 32.0, ambient: 0.15, vertexMix: 0.0 },
    methods: {},
    description: "Blinn-Phong surface material with one light (directional OR point; wire a DirectionalLight / PointLight into the Scene's `light` input; default light is warm-white directional from above-front). r/g/b is the diffuse base color. shininess controls specular highlight sharpness (1..256 typical, higher = tighter highlight). ambient (0..1) lifts the shadowed side so meshes don't go pitch-black -- bump up for a more 'cartoon shading' look. vertexMix in [0..1] blends the material color with the mesh's per-vertex color (0 = pure material; 1 = pure vertex-color; ~0.3 = nice 'colored highlights' look)."
  },

  /* PhysicalMat -- physically-based rendering with metallic-roughness
   * workflow (glTF / Disney style). Energy-conserving Cook-Torrance
   * BRDF with GGX distribution, Schlick-GGX geometry, Schlick
   * Fresnel. Visually a big step up from Phong: metals look like
   * actual metal (tinted speculars, no diffuse), dielectrics (skin,
   * plastic, wood) have white speculars + albedo-based diffuse,
   * roughness controls highlight spread realistically.
   *
   * metallic: 0 (pure dielectric) -> 1 (pure conductor). Mixed
   *   values are physically nonsensical but visually useful for
   *   transitional materials (anodized metal, painted metal).
   * roughness: 0.04 (mirror floor; pure mirror would div-by-zero) ->
   *   1.0 (fully matte / Lambertian). 0.3-0.5 is "fine plastic",
   *   0.7-0.9 is "weathered painted surface". */
  PhysicalMat: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "material",
    ins: [
      { n: "mesh",      t: "mesh" },
      { n: "r",         t: "param" },
      { n: "g",         t: "param" },
      { n: "b",         t: "param" },
      { n: "metallic",  t: "param" },
      { n: "roughness", t: "param" },
      { n: "vertexMix", t: "param" },
      { n: "albedoMap", t: "param" },
      { n: "normalMap", t: "param" },
      { n: "roughMap",  t: "param" },
      { n: "metalMap",  t: "param" },
      { n: "uvScale",   t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { r: 0.85, g: 0.85, b: 0.85, metallic: 0.0, roughness: 0.5, vertexMix: 0.0,
              albedoMap: "", normalMap: "", roughMap: "", metalMap: "", uvScale: 1 },
    methods: {},
    uiOnlyParams: ["albedoMap", "normalMap", "roughMap", "metalMap"],
    description: "Physically-based surface material with metallic-roughness workflow (glTF / Disney style). r/g/b is the albedo (basecolor): for metals this is the specular tint; for dielectrics it's the diffuse color. metallic in [0..1] mixes between dielectric (0, 4% F0 reflectance, full diffuse) and conductor (1, tinted F0 = albedo, no diffuse). roughness in [0.04..1] controls microfacet spread. Phase 8.B.15 A.4: albedoMap / normalMap / roughMap / metalMap accept a compile-server texture (`server:<id>`, `asset:<name>`, or a URL — jpg/png direct, .exr decoded via three.js). albedoMap MULTIPLIES r/g/b (set them to 1 to use the map as-is); roughMap/metalMap multiply the scalar (set those to 1); normalMap perturbs the surface normal. Maps stream + decode on first use; blank = no map. uvScale tiles every map across the surface (>1 repeats — useful for seamless brick/concrete on large faces; facade textures meant to map 1:1 stay at 1). Wire metallic / roughness to audio-reactive sources for live material modulation."
  },

  /* MirrorMat -- perfect mirror (RT-only). Reflects rays with a tint.
   * Raster fallback renders as a high-metallic PhysicalMat (low
   * roughness, albedo = tint). Behaves as a *true* mirror only when
   * fed through a RayTracedScene -- the RT kernel bounces a reflection
   * ray and gathers the surface it hits. */
  MirrorMat: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "material",
    ins: [
      { n: "mesh", t: "mesh" },
      { n: "r",    t: "param" },
      { n: "g",    t: "param" },
      { n: "b",    t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { r: 1.0, g: 1.0, b: 1.0 },
    methods: {},
    description: "Perfect mirror surface (RT-only material). r/g/b tints the reflected color: (1,1,1) = chrome, (0.95,0.82,0.5) = gold, (0.78,0.78,0.78) = aluminum, (0.6,0.6,0.65) = lead. The RT kernel casts a reflection ray at each hit and multiplies the gathered color by this tint, up to MAX_BOUNCES (4) deep. Raster fallback: high-metallic PhysicalMat (mirror-but-not-true-mirror). Wire through a RayTracedScene to see actual mirror behavior."
  },

  /* GlassMat -- refracting transparent material (RT-only). Bends rays
   * by Snell's law on entry + exit, attenuates color through Beer-
   * Lambert absorption along the medium-side ray. Raster fallback
   * renders as a low-opacity PhongMat (poor approximation; glass
   * needs RT to look right). */
  GlassMat: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "material",
    ins: [
      { n: "mesh", t: "mesh" },
      { n: "r",    t: "param" },
      { n: "g",    t: "param" },
      { n: "b",    t: "param" },
      { n: "ior",  t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: { r: 0.95, g: 0.97, b: 1.0, ior: 1.5 },
    methods: {},
    description: "Refracting transparent material (RT-only). r/g/b is the absorption tint -- the color the medium absorbs OUT of light passing through it; a deep blue tint gives blue glass. ior is the index of refraction: 1.0=air, 1.33=water, 1.46=quartz, 1.5=window glass, 1.7=lead crystal, 2.4=diamond. Total internal reflection happens automatically at angles steeper than the critical angle (gives the sparkling edges of diamond at high IoR). Raster fallback approximates with a low-opacity PhongMat; for the real look, wire into a RayTracedScene."
  },

  /* ShaderMat -- curated WGSL surface presets. Each preset is a
   * unique fragment shader compiled on first use; the rest of the
   * pipeline (vertex shader, uniforms, render state) is shared with
   * the standard materials. Presets:
   *
   *   iridescent  view-angle-dependent rainbow (oil-slick / soap-
   *               bubble look)
   *   plasma      classic 4-sine plasma in world space, scrolling
   *               with time
   *   scanlines   sci-fi hologram stripes scrolling vertically
   *   fresnelEdge bright rim from grazing angles, dim core
   *
   * Param remapping (vs PBR / Phong):
   *   time      -> matParams.x   (wire MasterClock.phase × 2π)
   *   freq      -> matParams.y   (cycles per unit / per second)
   *   intensity -> matParams.z   (effect strength)
   * r/g/b is the tint color (each preset uses it differently). */
  ShaderMat: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "material",
    ins: [
      { n: "mesh",      t: "mesh" },
      { n: "texture",   t: "texture" },
      { n: "preset",    t: "param" },
      { n: "r",         t: "param" },
      { n: "g",         t: "param" },
      { n: "b",         t: "param" },
      { n: "time",      t: "param" },
      { n: "freq",      t: "param" },
      { n: "intensity", t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      preset: 0,
      r: 0.7, g: 0.85, b: 1.0,
      time: 0, freq: 1.0, intensity: 1.0
    },
    methods: {},
    paramOptions: {
      preset: ["iridescent", "plasma", "scanlines", "fresnelEdge", "texture", "texture-triplanar"]
    },
    description: "Custom WGSL surface material. preset picks one of six built-in shader bodies. For most presets r/g/b is the tint, time advances animation (wire MasterClock.phase × 2π), freq scales density, intensity scales effect strength. The 'texture' preset wraps any upstream visual node's output (StarNest / Voronoi / MatrixRain / ShapeTunnel / Plasma / etc.) onto the mesh via per-vertex UVs -- wire the visual's `out` port into ShaderMat's `texture` input. 'texture-triplanar' (Phase 7 §5.5.c-2) is the same idea but projects via three world-axis planes blended by the surface normal -- the standard solve for surfaces where regular UVs stretch (cliffs on a Terrain mesh, sculpted shapes); freq reinterpreted as world scale (smaller = larger features; ~0.05 for terrain), time reinterpreted as triplanar sharpness (4 default; raise for harder axis-aligned, lower for softer cross-blending). Plan walker auto-schedules the upstream into a scratch slot before the Scene's pass; the texture is sampled with linear filtering."
  },

  /* Phase 7 §5.5.c — TerrainMaterial. Altitude- and slope-blended
   * Phong-style material designed for the Terrain mesh-gen. Four
   * RGB band colors (low → high, e.g. sand / grass / rock / snow);
   * three altitude thresholds in WORLD Y units mark the transitions;
   * a smoothstep `softness` controls how sharply they blend. The
   * `slopeRockiness` multiplier additionally pushes the rock-band
   * color in on steep faces, so cliffs read as rock regardless of
   * their altitude (which is the part that makes terrain look
   * carved instead of striped).
   *
   * Thresholds are ABSOLUTE world Y, not normalized -- so the
   * defaults assume the Terrain node's default Y range of -12..0
   * (heightScale=12, yOffset=0, peaks at Y=0). When you raise
   * heightScale or shift via yOffset, retune the alt1/2/3 thresholds
   * to match. */
  TerrainMaterial: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "material",
    ins: [
      { n: "mesh",            t: "mesh" },
      { n: "color1R",         t: "param" },
      { n: "color1G",         t: "param" },
      { n: "color1B",         t: "param" },
      { n: "alt1",            t: "param" },
      { n: "color2R",         t: "param" },
      { n: "color2G",         t: "param" },
      { n: "color2B",         t: "param" },
      { n: "alt2",            t: "param" },
      { n: "color3R",         t: "param" },
      { n: "color3G",         t: "param" },
      { n: "color3B",         t: "param" },
      { n: "alt3",            t: "param" },
      { n: "color4R",         t: "param" },
      { n: "color4G",         t: "param" },
      { n: "color4B",         t: "param" },
      { n: "softness",        t: "param" },
      { n: "slopeRockiness",  t: "param" },
      { n: "shininess",       t: "param" },
      { n: "ambient",         t: "param" },
      { n: "vertexMix",       t: "param" },
      // v0.3.129 v2 detail / bump / snow-mask knobs.
      { n: "detailScale",     t: "param" },
      { n: "detailStrength",  t: "param" },
      { n: "microScale",      t: "param" },
      { n: "microStrength",   t: "param" },
      { n: "edgeJitter",      t: "param" },
      { n: "bumpStrength",    t: "param" },
      { n: "snowMaskAmount",  t: "param" }
    ],
    outs: [{ n: "mesh", t: "mesh" }],
    params: {
      // Sand / shore (lowest band)
      color1R: 0.85, color1G: 0.78, color1B: 0.55,
      alt1:    -8,
      // Grass (mid-low)
      color2R: 0.40, color2G: 0.55, color2B: 0.30,
      alt2:    -4,
      // Rock (mid-high)
      color3R: 0.45, color3G: 0.40, color3B: 0.35,
      alt3:    -1,
      // Snow caps (highest band)
      color4R: 0.92, color4G: 0.94, color4B: 0.98,
      // Transition smoothness + slope-driven rock blending
      softness:       1.0,
      slopeRockiness: 1.5,
      shininess:      8.0,
      ambient:        0.22,
      vertexMix:      0.0,
      // v0.3.129 v2 -- detail noise + bump + snow-mask defaults
      // tuned for the §5.5.a Terrain Landscape demo (worldSize
      // 100, heightScale 12). detailScale = ~0.5 cycles per
      // world unit, microScale = ~3 cycles per world unit.
      detailScale:    0.5,
      detailStrength: 0.35,
      microScale:     3.0,
      microStrength:  0.20,
      edgeJitter:     1.5,
      bumpStrength:   0.4,
      snowMaskAmount: 0.8
    },
    methods: {},
    description: "AAA-style terrain material. Four RGB altitude bands (sand / grass / rock / snow) blend between three world-Y thresholds (alt1 < alt2 < alt3) with smoothstep softness, plus a slope-driven rock override so cliffs read as stone regardless of altitude. v2 adds five layers of realism that push the look close to modern game-engine terrain: detailScale + detailStrength macro variation (large color patches within each band, triplanar-projected so it doesn't stretch on cliffs); microScale + microStrength fine speckle (surface texture under close inspection); edgeJitter perturbs the band boundaries by macro noise so transitions follow the terrain naturally instead of running as horizontal stripes; bumpStrength procedural normal perturbation from micro-noise gradients (fake bump map without textures); snowMaskAmount restricts snow to flat tops via n.y so vertical cliffs above the snow line still read as rock. ~8 fbm samples per fragment -- cheap on modern GPUs but not free at 4K. shininess + ambient + vertexMix are the standard Phong knobs; defaults assume the Terrain node's default Y range -12..0."
  },

  /* DirectionalLight -- a single infinite-distance light source.
   * dirX/dirY/dirZ is the direction TO the light from the scene
   * (so dirY = 1 means the light is above, illuminating downward).
   * Normalized internally; user can leave it un-normalized + the
   * shader will handle it. colorR/G/B is the light color in [0..1].
   * intensity scales the contribution -- bump it for HDR feels. */
  DirectionalLight: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "light",
    ins: [
      { n: "dirX",      t: "param" },
      { n: "dirY",      t: "param" },
      { n: "dirZ",      t: "param" },
      { n: "colorR",    t: "param" },
      { n: "colorG",    t: "param" },
      { n: "colorB",    t: "param" },
      { n: "intensity", t: "param" }
    ],
    outs: [{ n: "light", t: "light" }],
    params: {
      dirX: 0.3, dirY: 1.0, dirZ: 0.4,
      colorR: 1.0, colorG: 0.98, colorB: 0.92,
      intensity: 1.0
    },
    methods: {},
    description: "Infinite-distance directional light. dirX/Y/Z is the direction TO the light (so dirY=1 means light is directly above, illuminating downward). Normalized internally. colorR/G/B in [0..1]. intensity scales contribution (bump above 1 for HDR-feel; PhongMat clamps). Wire the `light` output into a Scene's `light` input."
  },

  /* PointLight -- positional light with quadratic distance falloff.
   * posX/Y/Z is the light's world position; range controls how far
   * the light reaches (attenuation = (1 - dist/range)^2, clamped).
   * For PBR + Phong surfaces, attenuation multiplies both diffuse
   * and specular contributions -- a moving PointLight produces
   * sweeping highlights that read instantly as "this is a 3D
   * scene." */
  PointLight: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "light",
    ins: [
      { n: "posX",      t: "param" },
      { n: "posY",      t: "param" },
      { n: "posZ",      t: "param" },
      { n: "colorR",    t: "param" },
      { n: "colorG",    t: "param" },
      { n: "colorB",    t: "param" },
      { n: "intensity", t: "param" },
      { n: "range",     t: "param" }
    ],
    outs: [{ n: "light", t: "light" }],
    params: {
      posX: 0, posY: 2, posZ: 2,
      colorR: 1.0, colorG: 0.95, colorB: 0.85,
      intensity: 1.5,
      range: 8.0
    },
    methods: {},
    description: "Point light source with quadratic distance falloff. posX/Y/Z is the world position (wire to math chains for orbits / animation). colorR/G/B in [0..1]. intensity scales the brightness contribution. range is the distance at which attenuation reaches zero -- shorter range = sharper falloff (~2 for a candle-like local light; 10+ for a sun-substitute). The default range=8 is sized for a Scene with meshes around the origin (within ±3 world units) -- bump it if your scene is larger. Wire posX/Y/Z to a Phasor → Mul → Sin/Cos chain for an orbiting light."
  },

  /* SpotLight -- positional light with a cone-shaped illumination
   * pattern. Three-axis position + a direction the spot is pointing,
   * plus inner/outer cone half-angles in degrees. Light falls off
   * smoothly between the inner cone (full contribution) and the
   * outer cone (zero) -- classic spotlight gradient. Combined with
   * the standard distance falloff so it behaves correctly as you
   * move the source closer or farther.
   *
   * The cosines of the half-angles are pre-computed JS-side so the
   * WGSL just does a single dot + smoothstep per fragment. */
  SpotLight: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "light",
    ins: [
      { n: "posX",       t: "param" },
      { n: "posY",       t: "param" },
      { n: "posZ",       t: "param" },
      { n: "dirX",       t: "param" },
      { n: "dirY",       t: "param" },
      { n: "dirZ",       t: "param" },
      { n: "colorR",     t: "param" },
      { n: "colorG",     t: "param" },
      { n: "colorB",     t: "param" },
      { n: "intensity",  t: "param" },
      { n: "range",      t: "param" },
      { n: "innerAngle", t: "param" },
      { n: "outerAngle", t: "param" }
    ],
    outs: [{ n: "light", t: "light" }],
    params: {
      posX: 0, posY: 4, posZ: 2,
      dirX: 0, dirY: -1, dirZ: -0.3,
      colorR: 1.0, colorG: 0.95, colorB: 0.85,
      intensity: 2.5,
      range: 12.0,
      innerAngle: 15,
      outerAngle: 25
    },
    methods: {},
    description: "Spotlight -- positional light + cone-shaped emission. posX/Y/Z is the world position; dirX/Y/Z is the direction the spot is POINTING (so dirY=-1 means pointing straight down). innerAngle / outerAngle are HALF-angles in DEGREES: full contribution inside innerAngle, zero outside outerAngle, smooth falloff between. range is the distance falloff (same as PointLight). Common settings: tight cone (5°/10°) for a flashlight beam, wide cone (30°/45°) for a stage spot. Wire dirX/Y/Z to math chains for sweeping spots; wire intensity to MasterClock.beat for a strobe."
  },

  /* AreaLight -- rectangular emissive surface. RT-only: the kernel
   * Monte-Carlo samples one point on the rect per shadow ray, so
   * each primary ray sees a different sub-light-position. Combined
   * with TDS temporal averaging this yields TRUE SOFT SHADOWS
   * naturally -- the penumbra builds up over frames as primary rays
   * sample different parts of the light. No special light-source
   * algorithm beyond uniform sampling.
   *
   * posX/Y/Z is the CENTER of the rectangle. dirX/Y/Z is the
   * normal direction the surface points (so dirY=-1 means a ceiling
   * panel facing the floor). width / height are world-units along
   * the rectangle's tangent / bitangent (auto-derived from the
   * normal in the kernel). intensity is the total emitted power
   * scaled into the sampling weight, so doubling width OR intensity
   * gives the same illumination at the same scene point.
   *
   * Inside a raster Scene: degrades to a single PointLight at the
   * center (raster has no shadow rays / no soft shadow primitive
   * cheap enough). Inside RayTracedScene: full soft-shadow
   * treatment. Sprint 7.5.6.h. */
  AreaLight: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "light",
    ins: [
      { n: "posX",      t: "param" },
      { n: "posY",      t: "param" },
      { n: "posZ",      t: "param" },
      { n: "dirX",      t: "param" },
      { n: "dirY",      t: "param" },
      { n: "dirZ",      t: "param" },
      { n: "width",     t: "param" },
      { n: "height",    t: "param" },
      { n: "colorR",    t: "param" },
      { n: "colorG",    t: "param" },
      { n: "colorB",    t: "param" },
      { n: "intensity", t: "param" }
    ],
    outs: [{ n: "light", t: "light" }],
    params: {
      posX: 0, posY: 3, posZ: 0,
      dirX: 0, dirY: -1, dirZ: 0,
      width: 2.0, height: 2.0,
      colorR: 1.0, colorG: 0.97, colorB: 0.92,
      intensity: 4.0
    },
    methods: {},
    description: "Rectangular area light source (RT-only). posX/Y/Z is the CENTER of the panel; dirX/Y/Z is the normal direction it faces (dirY=-1 = ceiling panel pointing down). width / height are world-units along the panel's tangent / bitangent. Inside RayTracedScene: the kernel uniform-samples one point on the rectangle per shadow ray + each primary samples a different sub-position, so TDS temporal averaging produces TRUE SOFT SHADOWS with a real penumbra (no PCF / PCSS hack). Doubling width or intensity gives equivalent total illumination. Falls back to a PointLight at the center inside a raster Scene (no shadow-ray equivalent there). Intensity scales by area implicitly via the kernel's MC weight, so an intensity of 4 with a 2x2 panel = the same surface radiance as intensity 4 with a 4x4."
  },

  /* DayNightCycle -- Sprint 7.5.4.c. Time-of-day driver. Outputs a
   * single `timeOfDay` param in [0, 1] that Sun + ProceduralSky
   * both consume so they stay in sync. Conventions:
   *   0.00 midnight   0.25 sunrise   0.50 noon   0.75 sunset
   *
   * Two modes:
   *   - phase input WIRED: emits the phase value verbatim (clamped /
   *     wrapped to [0,1]). Wire `MasterClock.phase → phase` with a
   *     slow clock (bpm=2 -> 30s day, bpm=0.5 -> 2min day) for an
   *     auto-cycling scene.
   *   - phase input UNWIRED: emits `manual` (a stored param). Lets
   *     you freeze the scene at a specific time-of-day during
   *     authoring -- twist the slider to find the look you want. */
  DayNightCycle: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "daynight",
    ins: [
      { n: "phase",  t: "param" },
      { n: "manual", t: "param" }
    ],
    outs: [{ n: "timeOfDay", t: "param" }],
    params: { manual: 0.5 },
    methods: {},
    description: "Time-of-day driver for Sun + ProceduralSky. Outputs a 0..1 timeOfDay phase: 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset. Wire `MasterClock.phase → phase` for an auto-cycle (set the MasterClock to a slow bpm: 2 = 30s day, 1 = 60s day, 0.5 = 2min day). Leave `phase` unwired to freeze the scene at `manual` for authoring. The same timeOfDay should feed BOTH Sun and ProceduralSky so the rendered sun-disk on the sky matches the direction the DirectionalLight comes from."
  },

  /* Sun -- Sprint 7.5.4.c. DirectionalLight whose direction + color
   * are driven by timeOfDay (via DayNightCycle or a literal slider).
   * Direction goes around an arc (east-rise, overhead-noon, west-
   * set). Color tints warm-red at the horizon, neutral-warm-white
   * overhead -- matches the sun-disk color rendered by Procedural-
   * Sky exactly (same math both sides). Below horizon -> intensity
   * 0 so the scene goes dark for night (env still emits a dim blue
   * ambient via ProceduralSky's night palette).
   *
   * Optional tintR/G/B let you push the sun warm/cool independent
   * of the elevation-driven default. intensityScale scales the
   * computed intensity (use 0.5 for an overcast feel, 1.5 for
   * harsh-noon). */
  Sun: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "light",
    ins: [
      { n: "timeOfDay",      t: "param" },
      { n: "tintR",          t: "param" },
      { n: "tintG",          t: "param" },
      { n: "tintB",          t: "param" },
      { n: "intensityScale", t: "param" }
    ],
    outs: [{ n: "light", t: "light" }],
    params: {
      timeOfDay: 0.5,
      tintR: 1.0, tintG: 1.0, tintB: 1.0,
      intensityScale: 1.0
    },
    methods: {},
    description: "DirectionalLight driven by timeOfDay. Wire `DayNightCycle.timeOfDay → Sun.timeOfDay` for an animated cycle (or set timeOfDay manually to freeze). Direction follows an east-up-west arc; color tints sunset-warm at the horizon, neutral-warm-white overhead. Below horizon (timeOfDay near midnight) the sun's intensity falls to 0 so the scene dims into night naturally. Pairs with ProceduralSky on the same timeOfDay so the sun-disk on the sky matches the DirectionalLight's direction. tintR/G/B and intensityScale let you customize without touching the elevation-driven defaults."
  },

  /* ProceduralSky -- Sprint 7.5.4.c. Hand-tuned Rayleigh+Mie style
   * atmospheric scattering. Drives the env IBL ambient on PBR
   * surfaces (and, eventually, sky pixels in screen-space). Wire
   * `DayNightCycle.timeOfDay → ProceduralSky.timeOfDay` then
   * `ProceduralSky.env → Scene.environment` and you have an animated
   * day-night sky.
   *
   * params:
   *   timeOfDay -- 0..1 phase (see DayNightCycle for convention)
   *   turbidity -- atmosphere haze [0.5, 5.0]. Higher = more washed-
   *                out + warmer horizon at sunset.
   *   mieG      -- forward-scatter anisotropy [0, 0.95]. 0.76 is a
   *                standard textbook value; higher = tighter sun
   *                glow, lower = broader.
   *   intensity -- overall multiplier. Bump to 1.5+ for brighter
   *                reflections on chrome surfaces.
   *
   * NOT physically accurate (no integrated transmittance, no proper
   * optical depth math). Reads as "sky" through the day/night cycle
   * and that's the goal for v1; replace with a real Hosek-Wilkie
   * implementation in a future sprint. */
  ProceduralSky: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "environment",
    ins: [
      { n: "timeOfDay", t: "param" },
      { n: "turbidity", t: "param" },
      { n: "mieG",      t: "param" },
      { n: "intensity", t: "param" },
      // 7.5.4.c-polish -- 0..1, controls moon's lit fraction.
      // 0 / 1 = new moon (no visible disk), 0.5 = full moon. Wire
      // a very slow MasterClock for an animated lunar cycle (a real
      // month is 29.5 days; in 60s-day units that's a 30-min loop).
      { n: "moonPhase",     t: "param" },
      // Sprint 7.5.4.d -- cloud layer. coverage=0 turns clouds off
      // entirely (default). 0.3-0.7 is typical for partly cloudy.
      // density scales how thick / opaque the clouds read; wind
      // drifts the noise field over time.
      { n: "cloudCoverage", t: "param" },
      { n: "cloudDensity",  t: "param" },
      { n: "windSpeedX",    t: "param" },
      { n: "windSpeedZ",    t: "param" }
    ],
    outs: [{ n: "env", t: "environment" }],
    params: {
      timeOfDay: 0.5,
      turbidity: 1.0,
      mieG:      0.76,
      intensity: 1.0,
      moonPhase: 0.5,
      cloudCoverage: 0.0,
      cloudDensity:  1.0,
      windSpeedX:    0.0,
      windSpeedZ:    0.0
    },
    methods: {},
    description: "Hand-tuned atmospheric-scattering sky. timeOfDay drives a day/night cycle: noon -> blue zenith + pale horizon, sunset -> orange-red sky + dim ground, midnight -> deep blue night sky. turbidity pushes the daytime color toward warmer/hazier tones (high turbidity = orange sunsets bleeding longer into the day). mieG controls the forward-scatter anisotropy: 0.76 gives a textbook sun-halo; higher = tighter glow, lower = broader fuzzy sun. Wire `DayNightCycle.timeOfDay` into this AND into the Sun node so the sky's sun-disk + the DirectionalLight come from the same direction at the same color. NOT physically accurate (no integrated transmittance) but reads as 'sky' through the cycle. Hosek-Wilkie implementation is a future polish."
  },

  /* HDRI -- Sprint 7.5.4.b. Loads an equirectangular .hdr file
   * (Radiance RGBE format) and exposes it as a true HDR environment.
   * Drives both IBL ambient on PBR surfaces AND the sky background
   * pass. Currently ships with one bundled test HDRI from PolyHaven
   * (Table Mountain pure-sky 4K); add more entries to assets/hdri/
   * + the `preset` paramOptions to expand the dropdown.
   *
   *   preset    -- which bundled HDRI to load. The HDR data parses
   *                + uploads once on first selection, then caches
   *                in Visual._hdriCache for the session.
   *   intensity -- multiplier on the HDR values. 1.0 = literal HDR
   *                (some values may exceed 1 -> clip in the LDR
   *                framebuffer; lower intensity to dial exposure
   *                down). Try 0.5 for dim, 2.0 for bright.
   *
   * The first frame after selecting a new preset has a ~200-500ms
   * stall while the .hdr file is fetched + parsed + uploaded; that's
   * one-shot per file per session. Subsequent renders are free. */
  HDRI: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "environment",
    ins: [
      { n: "url",       t: "param" },
      { n: "preset",    t: "param" },
      { n: "intensity", t: "param" }
    ],
    outs: [{ n: "env", t: "environment" }],
    params: {
      url: "",
      preset: "table-mountain",
      intensity: 1.0
    },
    methods: {},
    paramOptions: {
      preset: ["table-mountain"]
    },
    description: "Equirectangular HDR environment map. Set `url` to a Radiance .hdr from the compile-server asset host — `server:<id>` (drop an .hdr from the Assets tab), `asset:<name>`, or a direct URL — OR leave it blank and pick a bundled `preset` (table-mountain, a 4K PolyHaven sky). When wired into Scene.environment: drives IBL ambient on PBR surfaces (chrome reflects the sky), the visible sky background pass, and the same sample_env path as ProceduralSky / GradientSky. intensity scales the loaded values (down for an LDR display, up for stronger reflections). Bigger HDRs = more GPU memory (a 4K eats ~64 MB)."
  },

  /* Skybox -- Sprint 7.5.4.b. Currently a thin wrapper around the
   * HDRI path: takes an equirect image (HDR or future LDR) and
   * binds it as the env source. Distinct from HDRI conceptually
   * (Skybox = "the background sky," HDRI = "the lighting source")
   * but mechanically the same code path until we add a true
   * 6-face cubemap pipeline. Use HDRI for now if you want IBL +
   * sky from one node; use Skybox for a future LDR-only sky. */
  Skybox: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "environment",
    ins: [
      { n: "preset",    t: "param" },
      { n: "intensity", t: "param" }
    ],
    outs: [{ n: "env", t: "environment" }],
    params: {
      preset: "table-mountain",
      intensity: 1.0
    },
    methods: {},
    paramOptions: {
      preset: ["table-mountain"]
    },
    description: "Skybox node -- equirect image as the visible sky background + IBL source. Currently the same code path as HDRI (Radiance .hdr equirect). Distinguished from HDRI conceptually but mechanically identical until a 6-face cubemap pipeline ships. Use HDRI for now."
  },

  /* GradientSky -- Sprint 7.5.4 / Phase 7 §5.4. Cheap procedural sky:
   * three-stop vertical gradient (top, horizon, bottom) that the
   * Scene's PBR / Phong ambient term samples instead of the
   * hardcoded blue-gray hemisphere. Wire `env` into Scene's
   * `environment` input.
   *
   *   skyR/G/B      -- color at direction.y = +1 (straight up)
   *   horizonR/G/B  -- color at direction.y =  0 (equator)
   *   groundR/G/B   -- color at direction.y = -1 (straight down)
   *   intensity     -- overall multiplier; 1.0 = literal RGB,
   *                    higher = brighter IBL contribution
   *
   * Reads in fs_pbr's sample_env() via .y on the surface normal
   * (for diffuse) and the reflection vector (for specular). A
   * metallic ball with a saturated sky vs warm ground will visibly
   * reflect both halves, which is the whole point of having a real
   * env source. Cheap fallback when an HDRI / Skybox isn't wanted. */
  GradientSky: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "environment",
    ins: [
      { n: "skyR",      t: "param" },
      { n: "skyG",      t: "param" },
      { n: "skyB",      t: "param" },
      { n: "horizonR",  t: "param" },
      { n: "horizonG",  t: "param" },
      { n: "horizonB",  t: "param" },
      { n: "groundR",   t: "param" },
      { n: "groundG",   t: "param" },
      { n: "groundB",   t: "param" },
      { n: "intensity", t: "param" }
    ],
    outs: [{ n: "env", t: "environment" }],
    params: {
      // Defaults: a soft daytime-blue overhead, warm horizon, dim
      // ground. Same family as the pre-7.5.4 hardcoded hemisphere
      // but with a 3rd horizon stop for a richer transition.
      skyR: 0.40, skyG: 0.60, skyB: 0.95,
      horizonR: 0.85, horizonG: 0.78, horizonB: 0.65,
      groundR: 0.18, groundG: 0.15, groundB: 0.12,
      intensity: 1.0
    },
    methods: {},
    description: "Cheap procedural sky for IBL ambient. Three-stop vertical gradient: sky (color at +Y), horizon (color at equator), ground (color at -Y), with smooth-stepped transitions across the horizon. intensity scales the whole output -- bump to 1.5+ for stronger reflections on chrome / mirror finishes. Wire `env` into Scene's `environment` input -- replaces the hardcoded blue-gray hemisphere-IBL with this gradient. Same family as ProceduralSky / HDRI / Skybox (all Phase 7 §5.4); GradientSky is the cheapest of the four since there's no texture loading or scattering math. Defaults give a daytime sky -> warm horizon -> dim ground. Try (skyR=0.04, skyG=0.04, skyB=0.12) + (horizonR=0.4, G=0.3, B=0.5) + (groundR=0.05, G=0.05, B=0.08) for night. Or warm-uniform (sky=0.95, horizon=0.8, ground=0.55) for a sunset glow."
  },

  /* Custom ramp / curve shaper. Takes any 0..1 signal in, applies the
   * chosen curve, outputs 0..1. Same curve set the slider editor uses
   * (linear / log / exp / sCurve) plus an extra expSteep (x⁴) for
   * steeper exponential mappings. Drop this in between an LFO / env /
   * slider output and a Mul or filter cutoff to reshape the modulation
   * without touching the source node. shape is constructor-time +
   * runtime — change live and recompile if you want a different curve
   * (the dropdown sets the value; the codegen ships the new constant).
   *
   * Input is clamped to [0, 1]. To apply curves to bipolar signals
   * (e.g. a sine), shift+scale into [0,1] with Add/Mul first. */
  Ramp: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "GammaRamp",
    helperClass:
`class GammaRamp {
    float lut_[64];
    int shape_ = 0;
public:
    GammaRamp() {
        for (int i = 0; i < 64; i++) lut_[i] = (float)i / 63.f;
    }
    void setShape(float s) { shape_ = (int)s; }
    void setLut(const float* src, int n) {
        if (n > 64) n = 64;
        for (int i = 0; i < n; i++) lut_[i] = src[i];
    }
    float operator()(float x) {
        if (x < 0.f) x = 0.f; else if (x > 1.f) x = 1.f;
        switch (shape_) {
            case 1: return std::log10(1.f + 9.f * x);
            case 2: return x * x;
            case 3: return x * x * (3.f - 2.f * x);
            case 4: return x * x * x * x;
            case 5: {
                const float fi = x * 63.f;
                const int   i0 = (int)fi;
                const int   i1 = i0 < 63 ? i0 + 1 : 63;
                const float t = fi - i0;
                return lut_[i0] * (1.f - t) + lut_[i1] * t;
            }
        }
        return x;
    }
};`,
    ins: [{ n: "in", t: "audio" }],
    outs: [{ n: "out", t: "audio" }],
    params: { shape: "linear" },
    methods: { shape: "setShape" },
    paramOptions: { shape: ["linear", "log", "exp", "sCurve", "expSteep", "custom"] },
    enumMap:      { shape: { linear: "0", log: "1", exp: "2", sCurve: "3", expSteep: "4", custom: "5" } },
    uiOnlyParams: ["curveTable"],
    extraHeaders: ["<cmath>"],
    // When shape=custom, emit a static constexpr LUT inside the ctor
    // body and bind it via setLut. extraCtor entries can be functions
    // that receive the node and return a literal C++ string — used
    // here for per-instance data; static-string entries with {id}
    // substitution still work alongside.
    extraCtor: [
      (n) => {
        if (!n.params || n.params.shape !== "custom") return null;
        const tbl = n.params.curveTable;
        if (!Array.isArray(tbl) || tbl.length === 0) return null;
        const N = tbl.length;
        const vals = tbl.map(v => {
          const f = Number(v);
          return (isFinite(f) ? f : 0).toFixed(4) + "f";
        }).join(", ");
        return [
          "        {",
          `            static constexpr float ${n.id}_lut[] = { ${vals} };`,
          `            ${n.id}.setLut(${n.id}_lut, ${N});`,
          "        }"
        ].join("\n");
      }
    ],
    description: "Reshape a 0..1 signal through a curve (linear / log / exp / sCurve / expSteep / custom). 'custom' opens a drawable editor — sketch any response. Drop between an LFO/envelope/slider and a destination to shape modulation."
  },

  /* Phase 5.1 — master clock. Single instance per patch (typically).
   * Tracks elapsed samples → emits one-sample gate ticks on bar /
   * beat / quarter / eighth / sixteenth boundaries plus a 0..1
   * phase ramp per beat and the live BPM as a param-rate float.
   *
   * Output ticks read as plain audio-rate floats (1.0 for one sample
   * on the boundary, 0.0 otherwise). Wired into a gate input they
   * fire AD/AHD/etc. via the existing Schmitt-trigger codegen; wired
   * into a param input they nudge a setter once per division.
   *
   * Sample rate is read from gam::sampleRate() at construction —
   * which the worklet sets via preview_set_sr before preview_init,
   * so timing is locked to the AudioContext's actual rate. */
  MasterClock: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaMasterClock",
    helperClass:
`class GammaMasterClock {
    float bpm_ = 120.f;
    float spb_ = 24000.f;
    float sr_ = 48000.f;
    double sampleCount_ = 0.0;
    int prevBeat_ = -1;
    int prevHalf_ = -1;
    int prev16_  = -1;
    void recalc() { spb_ = sr_ * 60.f / (bpm_ > 0.f ? bpm_ : 1.f); }
public:
    struct Out { float bpm, bar, beat, quarter, eighth, sixteenth, phase; };
    GammaMasterClock() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc();
    }
    void setBpm(float v) { bpm_ = v; recalc(); }
    void reset() { sampleCount_ = 0.0; prevBeat_ = -1; prevHalf_ = -1; prev16_ = -1; }
    Out operator()() {
        Out o = { bpm_, 0.f, 0.f, 0.f, 0.f, 0.f, 0.f };
        const double curBeat = sampleCount_ / spb_;
        const int beatIdx = (int)curBeat;
        const int halfIdx = (int)(curBeat * 2.0);
        const int idx16   = (int)(curBeat * 4.0);
        if (beatIdx != prevBeat_) {
            o.beat = 1.f; o.quarter = 1.f;
            if ((beatIdx & 3) == 0) o.bar = 1.f;
            prevBeat_ = beatIdx;
        }
        if (halfIdx != prevHalf_) { o.eighth = 1.f; prevHalf_ = halfIdx; }
        if (idx16   != prev16_)   { o.sixteenth = 1.f; prev16_ = idx16; }
        o.phase = (float)(curBeat - beatIdx);
        sampleCount_ += 1.0;
        return o;
    }
};`,
    ins: [{ n: "trig", t: "gate" }],   // optional reset trigger
    outs: [
      { n: "bpm",       t: "param", access: ".bpm" },
      { n: "bar",       t: "clock", access: ".bar" },
      { n: "beat",      t: "clock", access: ".beat" },
      { n: "quarter",   t: "clock", access: ".quarter" },
      { n: "eighth",    t: "clock", access: ".eighth" },
      { n: "sixteenth", t: "clock", access: ".sixteenth" },
      { n: "phase",     t: "audio", access: ".phase" }
    ],
    params: { bpm: 120 },
    methods: { bpm: "setBpm" },
    gateMethods: { trig: "reset" },
    autoExpose: ["bpm"],
    description: "Master clock. Outputs BPM (param), bar/beat/quarter/eighth/sixteenth tick outputs, and a 0..1 phase ramp per beat. trig resets the clock to bar 1. Wire any tick output into a gate input (AD.trig, sequencer step) for tempo-locked rhythms, OR into any shader-frag param port (Plasma.clockReact, etc.) for visual tempo sync — the framework substitutes a cubic-decay envelope per subdivision for tick outputs, the raw 0..1 ramp for phase, the static value for bpm (Phase 6.5.4). Single source of truth for tempo across audio + visual sides of the patch."
  },

  /* Phase 5.5 — tempo-locked LFO. Cheaper than MasterClock when you
   * just want sub-audio-rate modulation in sync with a tempo and
   * don't need the bar/beat/etc. gate-tick fan-out. divs gives
   * cycles per beat (1 = once per beat, 2 = twice per beat, 0.5 =
   * once per two beats). Shape picks sine / triangle / saw / ramp.
   * Outputs are bipolar (-1..1) for sine/tri/saw, unipolar (0..1)
   * for ramp — pair with Add+Mul if you need a different range. */
  LFOClock: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaLFOClock",
    helperClass:
`class GammaLFOClock {
    float bpm_ = 120.f;
    float div_ = 1.f;
    float sr_  = 48000.f;
    int   shape_ = 0;
    double phase_ = 0.0;
public:
    GammaLFOClock() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setBpm(float v)   { bpm_   = v; }
    void setDiv(float v)   { div_   = v; }
    void setShape(float s) { shape_ = (int)s; }
    void reset() { phase_ = 0.0; }
    float operator()() {
        const double inc = (double)bpm_ / 60.0 * (double)div_ / (double)sr_;
        phase_ += inc;
        if (phase_ >= 1.0) phase_ -= (int)phase_;
        const float p = (float)phase_;
        switch (shape_) {
            case 1: return p < 0.5f ? (4.f * p - 1.f) : (3.f - 4.f * p);
            case 2: return 1.f - 2.f * p;
            case 3: return p;
            default: return std::sin(p * 6.28318530718f);
        }
    }
};`,
    ins: [{ n: "trig", t: "gate" }],
    outs: [{ n: "out", t: "audio" }],
    params: { bpm: 120, div: 1, shape: "sine" },
    methods: { bpm: "setBpm", div: "setDiv", shape: "setShape" },
    paramOptions: { shape: ["sine", "triangle", "saw", "ramp"] },
    enumMap:      { shape: { sine: "0", triangle: "1", saw: "2", ramp: "3" } },
    gateMethods: { trig: "reset" },
    extraHeaders: ["<cmath>"],
    autoExpose: ["bpm", "div"],
    description: "Tempo-locked LFO. div = cycles per beat. Wire trig from a clock to phase-lock with the patch. Bipolar output for sine/tri/saw, unipolar for ramp."
  },

  /* Phase 5.3 — Euclidean rhythm. Distributes `hits` evenly across
   * `steps`, advancing one step per clock-edge on `clock` (wire
   * MasterClock.eighth or .sixteenth in). Outputs a one-sample 1.f
   * pulse on each hit, 0.f otherwise. rotation shifts the pattern
   * around (e.g. rotation=2 turns "X--X--X--X--X--X" into
   * "--X--X--X--X--X--X"). Pattern rebuilds whenever hits/steps
   * change (constructor-time only — change + recompile to apply). */
  EuclideanRhythm: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaEuclidean",
    helperClass:
`class GammaEuclidean {
    static constexpr int MAX_STEPS = 64;
    bool pattern_[MAX_STEPS];
    int hits_     = 4;
    int steps_    = 16;
    int rotation_ = 0;
    int curStep_  = -1;
    int prev_     = 0;
    void recalc() {
        for (int i = 0; i < MAX_STEPS; i++) pattern_[i] = false;
        if (steps_ <= 0) return;
        const int H = (hits_ < 0) ? 0 : (hits_ > steps_ ? steps_ : hits_);
        for (int i = 0; i < H; i++) {
            const int idx = (i * steps_) / H;
            if (idx < steps_) pattern_[idx] = true;
        }
    }
public:
    GammaEuclidean() { recalc(); }
    void setHits(float v)     { hits_ = (int)v; recalc(); }
    void setSteps(float v)    { int n = (int)v; if (n < 1) n = 1; if (n > MAX_STEPS) n = MAX_STEPS; steps_ = n; recalc(); }
    void setRotation(float v) { rotation_ = (int)v; }
    void reset()              { curStep_ = -1; prev_ = 0; }
    float operator()(float clk) {
        const int cur = (clk > 0.5f) ? 1 : 0;
        const bool edge = cur && !prev_;
        prev_ = cur;
        if (edge) {
            curStep_ = (curStep_ + 1) % steps_;
            int idx = (curStep_ + rotation_) % steps_;
            if (idx < 0) idx += steps_;
            return pattern_[idx] ? 1.f : 0.f;
        }
        return 0.f;
    }
};`,
    ins: [
      { n: "clock", t: "clock" },
      { n: "trig",  t: "gate" }
    ],
    outs: [{ n: "out", t: "clock" }],
    params: { hits: 4, steps: 16, rotation: 0 },
    methods: { hits: "setHits", steps: "setSteps", rotation: "setRotation" },
    gateMethods: { trig: "reset" },
    autoExpose: ["hits", "steps", "rotation"],
    description: "Euclidean rhythm — distributes N hits evenly across M steps. Wire a clock signal (e.g. MasterClock.sixteenth) into clock; out fires a one-sample gate when the current step is a hit."
  },

  /* Phase 5.2 — 16-step gate sequencer. Pattern stored as a 16-bit
   * boolean array in node.params.steps; the props pane renders an
   * interactive grid for editing. Advances one step per clock-edge,
   * wraps. trig resets to step 0. */
  StepSeq16: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaStepSeq16",
    helperClass:
`class GammaStepSeq16 {
    bool steps_[16];
    int  cur_  = -1;
    int  prev_ = 0;
public:
    GammaStepSeq16() { for (int i = 0; i < 16; i++) steps_[i] = false; }
    void setStep(int i, float v) { if (i >= 0 && i < 16) steps_[i] = v > 0.5f; }
    void reset() { cur_ = -1; prev_ = 0; }
    float operator()(float clk) {
        const int cur = (clk > 0.5f) ? 1 : 0;
        const bool edge = cur && !prev_;
        prev_ = cur;
        if (edge) {
            cur_ = (cur_ + 1) % 16;
            return steps_[cur_] ? 1.f : 0.f;
        }
        return 0.f;
    }
};`,
    ins: [
      { n: "clock", t: "clock" },
      { n: "trig",  t: "gate" }
    ],
    outs: [{ n: "out", t: "clock" }],
    params: { steps: [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false] },
    methods: {},
    gateMethods: { trig: "reset" },
    uiOnlyParams: ["steps"],
    kind: "stepSeq",
    stepCount: 16,
    extraCtor: [
      (n) => {
        const steps = (n.params && Array.isArray(n.params.steps)) ? n.params.steps : [];
        if (!steps.some(s => !!s)) return null;
        const lines = ["        // pattern"];
        for (let i = 0; i < 16; i++) {
          if (steps[i]) lines.push(`        ${n.id}.setStep(${i}, 1.f);`);
        }
        return lines.join("\n");
      }
    ],
    description: "16-step gate sequencer. Wire a clock signal (MasterClock.sixteenth) into clock. Edit the pattern with the step-grid in the properties pane. trig resets to step 0."
  },

  /* Phase 5.2 — 32-step variant of StepSeq16. Same machinery, longer
   * pattern. Useful for two-bar rhythmic phrases at sixteenth-note
   * resolution. */
  StepSeq32: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaStepSeq32",
    helperClass:
`class GammaStepSeq32 {
    bool steps_[32];
    int  cur_  = -1;
    int  prev_ = 0;
public:
    GammaStepSeq32() { for (int i = 0; i < 32; i++) steps_[i] = false; }
    void setStep(int i, float v) { if (i >= 0 && i < 32) steps_[i] = v > 0.5f; }
    void reset() { cur_ = -1; prev_ = 0; }
    float operator()(float clk) {
        const int cur = (clk > 0.5f) ? 1 : 0;
        const bool edge = cur && !prev_;
        prev_ = cur;
        if (edge) {
            cur_ = (cur_ + 1) % 32;
            return steps_[cur_] ? 1.f : 0.f;
        }
        return 0.f;
    }
};`,
    ins: [
      { n: "clock", t: "clock" },
      { n: "trig",  t: "gate" }
    ],
    outs: [{ n: "out", t: "clock" }],
    params: { steps: new Array(32).fill(false) },
    methods: {},
    gateMethods: { trig: "reset" },
    uiOnlyParams: ["steps"],
    kind: "stepSeq",
    stepCount: 32,
    extraCtor: [
      (n) => {
        const steps = (n.params && Array.isArray(n.params.steps)) ? n.params.steps : [];
        if (!steps.some(s => !!s)) return null;
        const lines = ["        // pattern"];
        for (let i = 0; i < 32; i++) {
          if (steps[i]) lines.push(`        ${n.id}.setStep(${i}, 1.f);`);
        }
        return lines.join("\n");
      }
    ],
    description: "32-step gate sequencer. Two bars of sixteenth-note rhythm. Same UI / wiring as StepSeq16."
  },

  /* Phase 5.4 — Arpeggiator. notes is a comma-separated list of
   * semitone offsets (e.g. "0, 4, 7" = major triad, "0, 3, 7, 10" =
   * minor 7). On each clock-edge, advances through the list per the
   * mode (up / down / upDown / random) and outputs the resulting
   * frequency relative to baseFreq. Wire freq into Sine.freq + the
   * clock's gate output into Sine.trig (or AD.trig) for note-on
   * articulation. */
  Arp: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaArp",
    helperClass:
`class GammaArp {
    static constexpr int MAX_NOTES = 16;
    float notes_[MAX_NOTES];
    int   nNotes_ = 0;
    float baseFreq_ = 220.f;
    int   mode_ = 0;
    int   cur_  = -1;
    int   dir_  = 1;
    int   prev_ = 0;
    unsigned rng_ = 0x12345u;
    int randIdx() {
        rng_ = rng_ * 1664525u + 1013904223u;
        return (int)((rng_ >> 8) % (unsigned)nNotes_);
    }
public:
    void setBaseFreq(float v) { baseFreq_ = v; }
    void setMode(float m)     { mode_ = (int)m; }
    void clearNotes()         { nNotes_ = 0; }
    void addNote(float semi)  { if (nNotes_ < MAX_NOTES) notes_[nNotes_++] = semi; }
    void reset()              { cur_ = -1; dir_ = 1; prev_ = 0; }
    float operator()(float clk) {
        const int cur = (clk > 0.5f) ? 1 : 0;
        const bool edge = cur && !prev_;
        prev_ = cur;
        if (edge && nNotes_ > 0) {
            switch (mode_) {
                case 0: cur_ = (cur_ + 1) % nNotes_; break;
                case 1: cur_--; if (cur_ < 0) cur_ = nNotes_ - 1; break;
                case 2:
                    cur_ += dir_;
                    if (cur_ >= nNotes_) { cur_ = nNotes_ > 1 ? nNotes_ - 2 : 0; dir_ = -1; }
                    if (cur_ < 0)        { cur_ = nNotes_ > 1 ? 1 : 0; dir_ = 1; }
                    break;
                case 3: cur_ = randIdx(); break;
            }
        }
        if (cur_ < 0 || cur_ >= nNotes_) return baseFreq_;
        return baseFreq_ * std::pow(2.f, notes_[cur_] / 12.f);
    }
};`,
    ins: [
      { n: "clock", t: "clock" },
      { n: "freq",  t: "param" },
      { n: "trig",  t: "gate" }
    ],
    outs: [{ n: "freq", t: "audio" }],
    params: { freq: 220, mode: "up", notes: "0, 4, 7, 12" },
    methods: { freq: "setBaseFreq", mode: "setMode" },
    paramOptions: { mode: ["up", "down", "upDown", "random"] },
    enumMap:      { mode: { up: "0", down: "1", upDown: "2", random: "3" } },
    gateMethods: { trig: "reset" },
    autoExpose: ["freq"],
    uiOnlyParams: ["notes"],
    extraHeaders: ["<cmath>"],
    extraCtor: [
      (n) => {
        const raw = (n.params && typeof n.params.notes === "string") ? n.params.notes : "";
        const list = raw.split(",").map(s => s.trim()).filter(s => s.length).map(Number).filter(v => isFinite(v));
        if (!list.length) return null;
        const lines = [`        ${n.id}.clearNotes();`];
        list.slice(0, 16).forEach(v => {
          lines.push(`        ${n.id}.addNote(${Number(v).toFixed(4)}f);`);
        });
        return lines.join("\n");
      }
    ],
    description: "Arpeggiator. notes = comma-separated semitone offsets (e.g. \"0, 4, 7\" = major triad). On each clock-edge, advances per mode (up/down/upDown/random) + outputs baseFreq scaled by the offset. Wire freq into Sine.freq."
  },

  /* Automation lane — drawable parameter automation. The user
   * sketches a curve in the modal; the node plays it back over a
   * configurable number of measures, BPM-synced. Output is the
   * curve's value remapped from [0..1] (storage range) into
   * [min..max] (output range). Wire the output into ANY param
   * input — Sine.freq, Biquad.cutoff, Mul.b, etc.
   *
   * Trigger model:
   *   • trig (gate) — restart playback from index 0.
   *   • If loop is on, the curve plays forever, wrapping at the
   *     end of each cycle. Else it plays once and holds the last
   *     value (or returns to the first if no trigger).
   * BPM model:
   *   • bpm (param) — wire from MasterClock.bpm for tempo-lock.
   *     Total length = bars × 4 beats × (60/bpm) seconds (4/4).
   *   • Without a wire, the internal default applies (120 BPM).
   *
   * The curveTable stores the drawn shape at AUTO_LANE_RES (256)
   * samples; codegen emits it as a static constexpr LUT loaded
   * via setLut at construction time. */
  AutomationLane: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaAutoLane",
    helperClass:
`class GammaAutoLane {
    static constexpr int N = 256;
    float lut_[N];
    float bpm_ = 120.f;
    float bars_ = 4.0f;       // 4/4 — total length = bars * 4 beats
    float minVal_ = 0.f;
    float maxVal_ = 1.f;
    bool  loop_ = false;
    bool  playing_ = false;
    float phase_ = 0.f;        // [0, N-1] float index
    float sr_ = 48000.f;
    float lengthSec_() const {
        const float bps = (bpm_ > 0.f ? bpm_ : 120.f) / 60.f;
        return (bars_ > 0.f ? bars_ : 1.f) * 4.f / bps;
    }
public:
    GammaAutoLane() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        for (int i = 0; i < N; i++) lut_[i] = 0.5f;
    }
    void setBpm(float v)   { bpm_ = v; }
    void setBars(float v)  { bars_ = (v < 0.25f) ? 0.25f : v; }
    void setMin(float v)   { minVal_ = v; }
    void setMax(float v)   { maxVal_ = v; }
    void setLoop(float v)  { loop_ = v > 0.5f; }
    void setLut(const float* src, int n) {
        if (n > N) n = N;
        for (int i = 0; i < n; i++) lut_[i] = src[i];
    }
    void trigger() { phase_ = 0.f; playing_ = true; }
    float lookup_(float fi) const {
        if (fi < 0.f) fi = 0.f;
        if (fi > (float)(N - 1)) fi = (float)(N - 1);
        const int i0 = (int)fi;
        const int i1 = (i0 < N - 1) ? i0 + 1 : N - 1;
        const float t = fi - (float)i0;
        return lut_[i0] * (1.f - t) + lut_[i1] * t;
    }
    float operator()() {
        const float v = lookup_(phase_);
        if (playing_) {
            const float step = (float)(N - 1) / (lengthSec_() * sr_);
            phase_ += step;
            if (phase_ >= (float)(N - 1)) {
                if (loop_) phase_ -= (float)(N - 1);
                else      { phase_ = (float)(N - 1); playing_ = false; }
            }
        }
        return minVal_ + (maxVal_ - minVal_) * v;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "bpm",  t: "param" },
      { n: "bars", t: "param" }
    ],
    outs: [{ n: "out", t: "param" }],
    params: { bars: 4, bpm: 120, min: 0, max: 1, loop: 1 },
    methods: { bars: "setBars", bpm: "setBpm", min: "setMin", max: "setMax", loop: "setLoop" },
    gateMethods: { trig: "trigger" },
    uiOnlyParams: ["curveTable"],
    kind: "autoLane",
    extraCtor: [
      (n) => {
        const tbl = n.params && n.params.curveTable;
        if (!Array.isArray(tbl) || !tbl.length) return null;
        const vals = tbl.map(v => Number(v).toFixed(4) + "f").join(", ");
        return [
          "        {",
          `            static constexpr float ${n.id}_lut[] = { ${vals} };`,
          `            ${n.id}.setLut(${n.id}_lut, ${tbl.length});`,
          "        }"
        ].join("\n");
      }
    ],
    description: "Drawable BPM-synced automation curve. Sketch the shape, set bars + min/max, wire trig to start (or set loop=1 for continuous) and bpm from MasterClock for tempo-lock. Output is a param-rate signal — wire into any param input."
  },

  /* MultiAutomationLane — 4 parallel automation lanes sharing the
   * same trig + bpm + bars. Each lane has its own drawn curve and
   * its own [min, max] output range. Outputs are 4 separate param
   * signals (out1..out4) so a single trigger can sweep four
   * different parameters in lock-step.
   *
   * Multi-output codegen: lanes are exposed as four `.l[0..3]`
   * accesses. Storage shape: node.params.lanes is an array of 4
   * entries each holding { name, min, max, curveTable }. */
  MultiAutomationLane: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaMultiAutoLane",
    helperClass:
`class GammaMultiAutoLane {
    static constexpr int N = 256;
    static constexpr int LANES = 4;
    float lut_[LANES][N];
    float minVal_[LANES] = { 0.f, 0.f, 0.f, 0.f };
    float maxVal_[LANES] = { 1.f, 1.f, 1.f, 1.f };
    float bpm_ = 120.f;
    float bars_ = 4.0f;
    bool  loop_ = false;
    bool  playing_ = false;
    float phase_ = 0.f;
    float sr_ = 48000.f;
    float lengthSec_() const {
        const float bps = (bpm_ > 0.f ? bpm_ : 120.f) / 60.f;
        return (bars_ > 0.f ? bars_ : 1.f) * 4.f / bps;
    }
public:
    struct Out { float l[LANES]; };
    GammaMultiAutoLane() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        for (int k = 0; k < LANES; k++)
            for (int i = 0; i < N; i++) lut_[k][i] = 0.5f;
    }
    void setBpm(float v)   { bpm_ = v; }
    void setBars(float v)  { bars_ = (v < 0.25f) ? 0.25f : v; }
    void setLoop(float v)  { loop_ = v > 0.5f; }
    void setLaneRange(int lane, float lo, float hi) {
        if (lane < 0 || lane >= LANES) return;
        minVal_[lane] = lo; maxVal_[lane] = hi;
    }
    void setMin1(float v) { minVal_[0] = v; }  void setMax1(float v) { maxVal_[0] = v; }
    void setMin2(float v) { minVal_[1] = v; }  void setMax2(float v) { maxVal_[1] = v; }
    void setMin3(float v) { minVal_[2] = v; }  void setMax3(float v) { maxVal_[2] = v; }
    void setMin4(float v) { minVal_[3] = v; }  void setMax4(float v) { maxVal_[3] = v; }
    void setLut(int lane, const float* src, int n) {
        if (lane < 0 || lane >= LANES) return;
        if (n > N) n = N;
        for (int i = 0; i < n; i++) lut_[lane][i] = src[i];
    }
    void trigger() { phase_ = 0.f; playing_ = true; }
    float lookup_(int lane, float fi) const {
        if (fi < 0.f) fi = 0.f;
        if (fi > (float)(N - 1)) fi = (float)(N - 1);
        const int i0 = (int)fi;
        const int i1 = (i0 < N - 1) ? i0 + 1 : N - 1;
        const float t = fi - (float)i0;
        return lut_[lane][i0] * (1.f - t) + lut_[lane][i1] * t;
    }
    Out operator()() {
        Out o;
        for (int k = 0; k < LANES; k++) {
            const float v = lookup_(k, phase_);
            o.l[k] = minVal_[k] + (maxVal_[k] - minVal_[k]) * v;
        }
        if (playing_) {
            const float step = (float)(N - 1) / (lengthSec_() * sr_);
            phase_ += step;
            if (phase_ >= (float)(N - 1)) {
                if (loop_) phase_ -= (float)(N - 1);
                else      { phase_ = (float)(N - 1); playing_ = false; }
            }
        }
        return o;
    }
};`,
    ins: [
      { n: "trig", t: "gate" },
      { n: "bpm",  t: "param" },
      { n: "bars", t: "param" }
    ],
    outs: [
      { n: "out1", t: "param", access: ".l[0]" },
      { n: "out2", t: "param", access: ".l[1]" },
      { n: "out3", t: "param", access: ".l[2]" },
      { n: "out4", t: "param", access: ".l[3]" }
    ],
    params: { bars: 4, bpm: 120, loop: 1, min1: 0, max1: 1, min2: 0, max2: 1, min3: 0, max3: 1, min4: 0, max4: 1 },
    methods: {
      bars: "setBars", bpm: "setBpm", loop: "setLoop",
      min1: "setMin1", max1: "setMax1",
      min2: "setMin2", max2: "setMax2",
      min3: "setMin3", max3: "setMax3",
      min4: "setMin4", max4: "setMax4"
    },
    gateMethods: { trig: "trigger" },
    uiOnlyParams: ["lanes"],
    kind: "multiAutoLane",
    extraCtor: [
      (n) => {
        const lanes = n.params && n.params.lanes;
        if (!Array.isArray(lanes) || !lanes.length) return null;
        const parts = [];
        lanes.forEach((lane, i) => {
          const tbl = lane && lane.curveTable;
          if (!Array.isArray(tbl) || !tbl.length) return;
          const vals = tbl.map(v => Number(v).toFixed(4) + "f").join(", ");
          parts.push(`        {`);
          parts.push(`            static constexpr float ${n.id}_lut${i}[] = { ${vals} };`);
          parts.push(`            ${n.id}.setLut(${i}, ${n.id}_lut${i}, ${tbl.length});`);
          parts.push(`        }`);
        });
        return parts.length ? parts.join("\n") : null;
      }
    ],
    description: "Four parallel BPM-synced automation lanes sharing the same trig / bpm / bars. Each lane has its own drawn curve + min/max range, output as out1..out4. Useful for sweeping multiple synth parameters in lock-step (e.g., cutoff up + resonance down + amp envelope all from one trigger)."
  },

  /* Phase 5 extra — Piano Roll. A drawable monophonic note sequencer.
   * Notes carry { start, dur, midi, vel }; on each clock-edge the
   * playhead advances one step and any note whose start matches the
   * current step fires (single-sample gate pulse) + sets curFreq +
   * curVel. patternLen wraps the playhead. Editor lives in a modal
   * — click+drag to draw a note (start..end in steps), click an
   * existing note to delete. */
  PianoRoll: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaPianoRoll",
    helperClass:
`class GammaPianoRoll {
    static constexpr int MAX_NOTES = 128;
    struct Note { int start, dur, midi; float vel; };
    Note notes_[MAX_NOTES];
    int  nNotes_     = 0;
    int  patternLen_ = 16;
    int  curStep_    = -1;
    int  prev_       = 0;
    float curFreq_   = 220.f;
    float curVel_    = 1.f;
    float gatePulse_ = 0.f;
public:
    struct Out { float freq, gate, vel; };
    void setPatternLen(float v) {
        int n = (int)v;
        if (n < 1) n = 1;
        if (n > 256) n = 256;
        patternLen_ = n;
    }
    void clearNotes() { nNotes_ = 0; }
    void addNote(float start, float dur, float midi, float vel) {
        if (nNotes_ >= MAX_NOTES) return;
        notes_[nNotes_].start = (int)start;
        notes_[nNotes_].dur   = (int)dur > 0 ? (int)dur : 1;
        notes_[nNotes_].midi  = (int)midi;
        notes_[nNotes_].vel   = (vel < 0.f) ? 0.f : (vel > 1.f ? 1.f : vel);
        nNotes_++;
    }
    void reset() { curStep_ = -1; prev_ = 0; gatePulse_ = 0.f; }
    Out operator()(float clk) {
        Out o;
        const int cur = (clk > 0.5f) ? 1 : 0;
        const bool edge = cur && !prev_;
        prev_ = cur;
        gatePulse_ = 0.f;
        if (edge) {
            curStep_ = (curStep_ + 1) % patternLen_;
            for (int i = 0; i < nNotes_; i++) {
                if (notes_[i].start == curStep_) {
                    curFreq_   = 440.f * std::pow(2.f, ((float)notes_[i].midi - 69.f) / 12.f);
                    curVel_    = notes_[i].vel;
                    gatePulse_ = 1.f;
                    break;
                }
            }
        }
        o.freq = curFreq_;
        o.gate = gatePulse_;
        o.vel  = curVel_;
        return o;
    }
};`,
    ins: [
      { n: "clock", t: "clock" },
      { n: "trig",  t: "gate" }
    ],
    outs: [
      { n: "freq", t: "audio", access: ".freq" },
      { n: "gate", t: "clock", access: ".gate" },
      { n: "vel",  t: "audio", access: ".vel"  }
    ],
    params: { patternLen: 16, notes: [] },
    methods: { patternLen: "setPatternLen" },
    gateMethods: { trig: "reset" },
    autoExpose: ["patternLen"],
    uiOnlyParams: ["notes"],
    kind: "pianoRoll",
    extraHeaders: ["<cmath>"],
    extraCtor: [
      (n) => {
        const list = (n.params && Array.isArray(n.params.notes)) ? n.params.notes : [];
        if (!list.length) return null;
        const lines = [`        ${n.id}.clearNotes();`];
        list.slice(0, 128).forEach(note => {
          if (!note || typeof note !== "object") return;
          const s = Math.round(Number(note.start) || 0);
          const d = Math.round(Number(note.dur)   || 1);
          const m = Math.round(Number(note.midi)  || 60);
          const v = Number(note.vel);
          const vc = isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
          lines.push(`        ${n.id}.addNote(${s}.f, ${d}.f, ${m}.f, ${vc.toFixed(3)}f);`);
        });
        return lines.join("\n");
      }
    ],
    description: "Piano-roll sequencer. Wire a clock signal (e.g. MasterClock.sixteenth) into clock; click 'Edit pattern' in props to open the drawable editor. Outputs freq + gate + velocity per note-on."
  },

  /* Phase 5 extra — Multi-track Piano Roll. Four independent monophonic
   * sequencers running off one shared clock, each with its own pattern
   * length and notes. Storage: each note carries a `track` field
   * (0..3); the modal shows track tabs in the toolbar to switch which
   * one you're editing, with inactive-track notes rendered dimly for
   * context. Outputs: 4 sets of {freq, gate, vel} = 12 ports total.
   * Wire each track's freq into a separate oscillator and gate into a
   * separate envelope to get four-voice polyphonic playback. */
  MultiPianoRoll: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaMultiPianoRoll",
    helperClass:
`class GammaMultiPianoRoll {
    static constexpr int MAX_NOTES = 256;
    static constexpr int N_TRACKS  = 4;
    struct Note { int track, start, dur, midi; float vel; };
    Note  notes_[MAX_NOTES];
    int   nNotes_ = 0;
    int   patternLen_[N_TRACKS] = { 16, 16, 16, 16 };
    int   playhead_  [N_TRACKS] = { -1, -1, -1, -1 };
    float curFreq_   [N_TRACKS] = { 220.f, 220.f, 220.f, 220.f };
    float curVel_    [N_TRACKS] = { 1.f, 1.f, 1.f, 1.f };
    float gatePulse_ [N_TRACKS] = { 0.f, 0.f, 0.f, 0.f };
    int   prev_ = 0;
public:
    struct Out {
        float freq[N_TRACKS];
        float gate[N_TRACKS];
        float vel [N_TRACKS];
    };
    void clearNotes() { nNotes_ = 0; }
    void addNote(float track, float start, float dur, float midi, float vel) {
        if (nNotes_ >= MAX_NOTES) return;
        int t = (int)track; if (t < 0) t = 0; if (t >= N_TRACKS) t = N_TRACKS - 1;
        notes_[nNotes_++] = { t, (int)start, (int)dur, (int)midi, vel };
    }
    void setPatternLen(float track, float len) {
        int t = (int)track;
        int n = (int)len; if (n < 1) n = 1;
        if (t >= 0 && t < N_TRACKS) patternLen_[t] = n;
    }
    void reset() {
        for (int t = 0; t < N_TRACKS; t++) { playhead_[t] = -1; gatePulse_[t] = 0.f; }
        prev_ = 0;
    }
    Out operator()(float clk) {
        Out o;
        for (int t = 0; t < N_TRACKS; t++) gatePulse_[t] = 0.f;
        const int cur = (clk > 0.5f) ? 1 : 0;
        const bool edge = cur && !prev_;
        prev_ = cur;
        if (edge) {
            for (int t = 0; t < N_TRACKS; t++) {
                playhead_[t] = (playhead_[t] + 1) % patternLen_[t];
            }
            for (int i = 0; i < nNotes_; i++) {
                const int t = notes_[i].track;
                if (t < 0 || t >= N_TRACKS) continue;
                if (notes_[i].start == playhead_[t]) {
                    curFreq_[t] = 440.f * std::pow(2.f, (notes_[i].midi - 69) / 12.f);
                    curVel_ [t] = notes_[i].vel;
                    gatePulse_[t] = 1.f;
                }
            }
        }
        for (int t = 0; t < N_TRACKS; t++) {
            o.freq[t] = curFreq_  [t];
            o.gate[t] = gatePulse_[t];
            o.vel [t] = curVel_   [t];
        }
        return o;
    }
};`,
    ins: [
      { n: "clock", t: "clock" },
      { n: "trig",  t: "gate" }
    ],
    outs: [
      { n: "freq1", t: "audio", access: ".freq[0]" },
      { n: "gate1", t: "clock", access: ".gate[0]" },
      { n: "vel1",  t: "audio", access: ".vel[0]"  },
      { n: "freq2", t: "audio", access: ".freq[1]" },
      { n: "gate2", t: "clock", access: ".gate[1]" },
      { n: "vel2",  t: "audio", access: ".vel[1]"  },
      { n: "freq3", t: "audio", access: ".freq[2]" },
      { n: "gate3", t: "clock", access: ".gate[2]" },
      { n: "vel3",  t: "audio", access: ".vel[2]"  },
      { n: "freq4", t: "audio", access: ".freq[3]" },
      { n: "gate4", t: "clock", access: ".gate[3]" },
      { n: "vel4",  t: "audio", access: ".vel[3]"  }
    ],
    params: {
      patternLens: [16, 16, 16, 16],
      notes: [],
      activeTrack: 0,
      defaultVels: [1, 1, 1, 1]
    },
    methods: {},
    gateMethods: { trig: "reset" },
    uiOnlyParams: ["notes", "patternLens", "activeTrack", "defaultVels"],
    kind: "multiPianoRoll",
    extraHeaders: ["<cmath>"],
    extraCtor: [
      (n) => {
        const list = (n.params && Array.isArray(n.params.notes)) ? n.params.notes : [];
        const lens = (n.params && Array.isArray(n.params.patternLens)) ? n.params.patternLens : [16, 16, 16, 16];
        const lines = [`        ${n.id}.clearNotes();`];
        for (let t = 0; t < 4; t++) {
          const v = Math.max(1, Math.round(Number(lens[t]) || 16));
          lines.push(`        ${n.id}.setPatternLen(${t}.f, ${v}.f);`);
        }
        list.slice(0, 256).forEach(note => {
          if (!note || typeof note !== "object") return;
          const tr = Math.max(0, Math.min(3, Math.round(Number(note.track) || 0)));
          const s = Math.round(Number(note.start) || 0);
          const d = Math.round(Number(note.dur)   || 1);
          const m = Math.round(Number(note.midi)  || 60);
          const vc = isFinite(Number(note.vel)) ? Math.max(0, Math.min(1, Number(note.vel))) : 1;
          lines.push(`        ${n.id}.addNote(${tr}.f, ${s}.f, ${d}.f, ${m}.f, ${vc.toFixed(3)}f);`);
        });
        return lines.join("\n");
      }
    ],
    description: "Multi-track piano roll — four independent monophonic sequencers off one shared clock, each with its own pattern length. Outputs freq/gate/vel per track for routing into per-voice synth chains. Click 'Edit pattern' to open the editor (track tabs in the toolbar)."
  },

  /* Phase 3.5 — multi-output state-variable filter via helperClass.
   * Andy Simper TPT (topology-preserving) form: zero-delay-feedback,
   * stable at high cutoffs. Returns LP/HP/BP/BR all from one struct,
   * one operator() call per sample (codegen binds + indexes by access). */
  StateVariableFilter: {
    category: "Filter", color: COLOR.filter, header: null,
    cppType: "GammaSVF",
    helperClass:
`class GammaSVF {
    float ic1eq = 0.f, ic2eq = 0.f;
    float g_ = 0.f, k_ = 1.f, a1_ = 0.f, a2_ = 0.f, a3_ = 0.f;
    static constexpr float SR_ = 48000.f;
    void recalc() {
        a1_ = 1.f / (1.f + g_ * (g_ + k_));
        a2_ = g_ * a1_;
        a3_ = g_ * a2_;
    }
public:
    struct Out { float lp, hp, bp, br; };
    GammaSVF() { freq(1000.f); res(0.7f); }
    void freq(float fc) { g_ = tanf(3.14159265f * fc / SR_); recalc(); }
    void res(float r)   {
        if (r < 0.f) r = 0.f; else if (r > 1.f) r = 1.f;
        k_ = 2.f - 2.f * r;
        recalc();
    }
    Out operator()(float v0) {
        float v3 = v0 - ic2eq;
        float v1 = a1_ * ic1eq + a2_ * v3;
        float v2 = ic2eq + a2_ * ic1eq + a3_ * v3;
        ic1eq = 2.f * v1 - ic1eq;
        ic2eq = 2.f * v2 - ic2eq;
        Out o;
        o.lp = v2;
        o.hp = v0 - k_ * v1 - v2;
        o.bp = v1;
        o.br = o.lp + o.hp;
        return o;
    }
};`,
    ins: [{n:"in", t:"audio"}, {n:"cutoff", t:"param"}, {n:"q", t:"param"}],
    outs: [
      {n:"LP", t:"audio", access: ".lp"},
      {n:"HP", t:"audio", access: ".hp"},
      {n:"BP", t:"audio", access: ".bp"},
      {n:"BR", t:"audio", access: ".br"}
    ],
    params: { cutoff: 1000, q: 0.7 },
    methods: { cutoff: "freq", q: "res" },
    description: "TPT state-variable filter — LP, HP, BP, BR all from one struct (one call/sample)."
  },

  /* Phase 3.5 — naive Moog ladder. Stilson/Smith-style 4-pole LP with
   * tanh-saturated stages. Self-resonance at res >= 4. Hardcoded SR
   * (48 kHz) here; refactor to runtime SR when domain integration lands. */
  MoogLadder: {
    category: "Filter", color: COLOR.filter, header: null,
    cppType: "GammaMoog",
    helperClass:
`class GammaMoog {
    float p_[4] = {0.f, 0.f, 0.f, 0.f};
    float fc_ = 0.5f;
    float res_ = 0.f;
    static constexpr float SR_ = 48000.f;
public:
    GammaMoog() { freq(1000.f); res(0.f); }
    void freq(float hz) {
        float f = hz * 2.f / SR_;
        if (f > 0.95f) f = 0.95f; else if (f < 1e-4f) f = 1e-4f;
        fc_ = f;
    }
    void res(float r) {
        if (r < 0.f) r = 0.f; else if (r > 4.f) r = 4.f;
        res_ = r;
    }
    float operator()(float in) {
        float x = in - res_ * p_[3];
        p_[0] += fc_ * (tanhf(x)     - tanhf(p_[0]));
        p_[1] += fc_ * (tanhf(p_[0]) - tanhf(p_[1]));
        p_[2] += fc_ * (tanhf(p_[1]) - tanhf(p_[2]));
        p_[3] += fc_ * (tanhf(p_[2]) - tanhf(p_[3]));
        return p_[3];
    }
};`,
    ins: [{n:"in", t:"audio"}, {n:"cutoff", t:"param"}, {n:"q", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { cutoff: 1000, q: 1.5 },
    methods: { cutoff: "freq", q: "res" },
    description: "Naive Moog ladder — 4-pole LP with tanh saturation. Self-resonates at q≈4."
  },

  /* Legacy single-mode Biquad variants — kept for back-compat with .gpatch
   * files saved before the unified Biquad shipped. New patches should use
   * the Biquad node above with the mode dropdown. */
  BiquadLP: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::Biquad<>",
    ins: [{n:"in", t:"audio"}, {n:"cutoff", t:"param"}, {n:"q", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { cutoff: 1200, q: 1.4 },
    methods: { cutoff: "freq", q: "res" },
    extraCtor: ["{id}.type(gam::LOW_PASS);"],
    description: "Biquad lowpass (legacy — prefer Biquad with mode=LOW_PASS)"
  },
  BiquadHP: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::Biquad<>",
    ins: [{n:"in", t:"audio"}, {n:"cutoff", t:"param"}, {n:"q", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { cutoff: 200, q: 1 },
    methods: { cutoff: "freq", q: "res" },
    extraCtor: ["{id}.type(gam::HIGH_PASS);"],
    description: "Biquad highpass (legacy — prefer Biquad with mode=HIGH_PASS)"
  },
  BiquadBP: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::Biquad<>",
    ins: [{n:"in", t:"audio"}, {n:"cutoff", t:"param"}, {n:"q", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { cutoff: 800, q: 4 },
    methods: { cutoff: "freq", q: "res" },
    extraCtor: ["{id}.type(gam::BAND_PASS);"],
    description: "Biquad bandpass (legacy — prefer Biquad with mode=BAND_PASS)"
  },
  BiquadBR: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::Biquad<>",
    ins: [{n:"in", t:"audio"}, {n:"cutoff", t:"param"}, {n:"q", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { cutoff: 800, q: 8 },
    methods: { cutoff: "freq", q: "res" },
    extraCtor: ["{id}.type(gam::BAND_REJECT);"],
    description: "Biquad notch / band-reject (legacy — prefer Biquad with mode=BAND_REJECT)"
  },
  OnePole: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::OnePole<>",
    ins: [{n:"in", t:"audio"}, {n:"cutoff", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { cutoff: 800 },
    methods: { cutoff: "freq" },
    description: "First-order lowpass (one-pole)"
  },
  OneZero: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::OneZero<>",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    description: "First-order zero filter"
  },
  Reson: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::Reson<>",
    ins: [{n:"in", t:"audio"}, {n:"freq", t:"param"}, {n:"width", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 1000, width: 100 },
    methods: { freq: "freq", width: "width" },
    description: "Two-pole resonator"
  },
  AllPass1: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::AllPass1<>",
    ins: [{n:"in", t:"audio"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 1000 },
    methods: { freq: "freq" },
    description: "First-order allpass"
  },
  BlockDC: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::BlockDC<>",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: { width: 35 },
    methods: { width: "width" },
    description: "DC blocker (highpass at low freq)"
  },
  BlockNyq: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::BlockNyq<>",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: { width: 35 },
    methods: { width: "width" },
    description: "Nyquist blocker (lowpass near sr/2)"
  },
  Integrator: {
    category: "Filter", color: COLOR.filter, header: "Filter",
    cppType: "gam::Integrator<>",
    ins: [{n:"in", t:"audio"}, {n:"leak", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { leak: 0.999 },
    methods: { leak: "leak" },
    description: "Leaky integrator"
  },

  /* ---- Delays (Delay.h) ---- */
  Delay: {
    category: "Delay", color: COLOR.delay, header: "Delay",
    cppType: "gam::Delay<>",
    ins: [{n:"in", t:"audio"}, {n:"time", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { time: 0.25, maxTime: 1.0 },
    methods: { time: "delay", maxTime: "maxDelay" },
    description: "Linear-interpolated fractional delay"
  },
  Delay1: {
    category: "Delay", color: COLOR.delay, header: null,
    cppType: "",
    kind: "delay1",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    description: "One-sample delay — use to break feedback cycles"
  },
  Comb: {
    category: "Delay", color: COLOR.delay, header: "Delay",
    cppType: "gam::Comb<>",
    ins: [{n:"in", t:"audio"}, {n:"time", t:"param"}, {n:"ffd", t:"param"}, {n:"fbk", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { time: 0.01, ffd: 0.5, fbk: 0.5 },
    methods: { time: "delay", ffd: "ffd", fbk: "fbk" },
    description: "Comb filter (feedforward + feedback)"
  },

  /* PingPong — stereo delay where each side's output feeds the
   * other side's input through a feedback gain. Mono input fans
   * out to the L line; L's tap feeds R; R's tap feeds back into
   * L. Both outputs carry the dry signal blended with their own
   * delayed tap by `mix`. Time + feedback are continuous setters
   * so an LFO can wobble either. Multi-output L / R; wire into
   * OutputStereo for the bouncing-stereo effect. */
  PingPong: {
    category: "Delay", color: COLOR.delay, header: "Delay",
    cppType: "GammaPingPong",
    helperClass:
`class GammaPingPong {
    gam::Delay<> dL_, dR_;
    float feedback_ = 0.5f;
    float mix_ = 0.5f;
public:
    GammaPingPong() {
        dL_.maxDelay(2.0f);
        dR_.maxDelay(2.0f);
        dL_.delay(0.5f);
        dR_.delay(0.5f);
    }
    void setTime(float v) {
        if (v < 0.001f) v = 0.001f;
        if (v > 2.0f)   v = 2.0f;
        dL_.delay(v);
        dR_.delay(v);
    }
    void setFeedback(float v) { feedback_ = (v < 0.f) ? 0.f : (v > 0.99f ? 0.99f : v); }
    void setMix(float v)      { mix_ = (v < 0.f) ? 0.f : (v > 1.f ? 1.f : v); }
    struct Out { float l, r; };
    Out operator()(float in) {
        // Read each line's tap before writing — separates read/write
        // so the feedback path is correctly one-sample old.
        const float lOut = dL_();
        const float rOut = dR_();
        // Cross-couple: L gets in + R's tail; R gets L's tail.
        dL_.write(in + rOut * feedback_);
        dR_.write(lOut * feedback_);
        Out o;
        const float dryGain = 1.f - mix_;
        o.l = in * dryGain + lOut * mix_;
        o.r = in * dryGain + rOut * mix_;
        return o;
    }
};`,
    ins: [
      { n: "in",       t: "audio" },
      { n: "time",     t: "param" },
      { n: "feedback", t: "param" },
      { n: "mix",      t: "param" }
    ],
    outs: [
      { n: "L", t: "audio", access: ".l" },
      { n: "R", t: "audio", access: ".r" }
    ],
    params: { time: 0.5, feedback: 0.5, mix: 0.5 },
    methods: { time: "setTime", feedback: "setFeedback", mix: "setMix" },
    description: "Stereo ping-pong delay. Mono in, stereo out; each side's tail bounces into the other through a feedback gain. mix blends dry signal with the delayed taps. Wire L / R into OutputStereo for the classic ping-pong bounce."
  },

  /* MultiTap — single delay line with 4 read taps at independently
   * configurable times. Sums the taps with per-tap gain into a mono
   * output. Useful for textured delay effects (e.g., short slap-back
   * + long ambient tail) and for rhythmic patterns where the taps
   * land on specific subdivisions. */
  MultiTap: {
    category: "Delay", color: COLOR.delay, header: "Delay",
    cppType: "GammaMultiTap4",
    helperClass:
`class GammaMultiTap4 {
    gam::Multitap<> mt_;
    float gains_[4] = { 1.0f, 0.7f, 0.5f, 0.3f };
public:
    GammaMultiTap4() : mt_(2.0f, 4) {
        mt_.delay(0.125f, 0);
        mt_.delay(0.250f, 1);
        mt_.delay(0.375f, 2);
        mt_.delay(0.500f, 3);
    }
    void setTap_(float v, int i) {
        if (i < 0 || i >= 4) return;
        if (v < 0.f)   v = 0.f;
        if (v > 2.0f)  v = 2.0f;
        mt_.delay(v, i);
    }
    void setT1(float v) { setTap_(v, 0); }
    void setT2(float v) { setTap_(v, 1); }
    void setT3(float v) { setTap_(v, 2); }
    void setT4(float v) { setTap_(v, 3); }
    void setG1(float v) { gains_[0] = v; }
    void setG2(float v) { gains_[1] = v; }
    void setG3(float v) { gains_[2] = v; }
    void setG4(float v) { gains_[3] = v; }
    float operator()(float in) {
        const float out =
            gains_[0] * mt_.read(0) +
            gains_[1] * mt_.read(1) +
            gains_[2] * mt_.read(2) +
            gains_[3] * mt_.read(3);
        mt_.write(in);
        return out;
    }
};`,
    ins: [
      { n: "in", t: "audio" },
      { n: "t1", t: "param" }, { n: "g1", t: "param" },
      { n: "t2", t: "param" }, { n: "g2", t: "param" },
      { n: "t3", t: "param" }, { n: "g3", t: "param" },
      { n: "t4", t: "param" }, { n: "g4", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { t1: 0.125, g1: 1.0, t2: 0.25, g2: 0.7, t3: 0.375, g3: 0.5, t4: 0.5, g4: 0.3 },
    methods: {
      t1: "setT1", g1: "setG1",
      t2: "setT2", g2: "setG2",
      t3: "setT3", g3: "setG3",
      t4: "setT4", g4: "setG4"
    },
    description: "Four-tap delay with per-tap time + gain. Sums all four taps into a single mono output. No internal feedback — pair with a Mul + Add cycle through Delay1 if you want one. Useful for clusters, slap-backs, rhythmic patterns."
  },

  /* TempoSyncDelay — delay whose time is computed from an incoming
   * BPM and a beat-fraction multiplier. Wire `MasterClock.bpm` into
   * bpm; set division to 0.25 for a 1/16 note, 1.0 for a 1/4 note,
   * 2.0 for a 1/2 note, etc. The internal delay line caps at 4 s
   * (to handle slow tempos / long divisions cleanly). */
  TempoSyncDelay: {
    category: "Delay", color: COLOR.delay, header: "Delay",
    cppType: "GammaTempoDelay",
    helperClass:
`class GammaTempoDelay {
    gam::Delay<> d_;
    float bpm_ = 120.f;
    float division_ = 1.0f;
    float feedback_ = 0.5f;
    float mix_ = 0.5f;
    void recalc_() {
        const float secPerBeat = 60.f / (bpm_ > 0.f ? bpm_ : 120.f);
        float t = secPerBeat * division_;
        if (t < 0.001f) t = 0.001f;
        if (t > 4.0f)   t = 4.0f;
        d_.delay(t);
    }
public:
    GammaTempoDelay() {
        d_.maxDelay(4.0f);
        recalc_();
    }
    void setBpm(float v)      { bpm_ = v; recalc_(); }
    void setDivision(float v) { division_ = v; recalc_(); }
    void setFeedback(float v) { feedback_ = (v < 0.f) ? 0.f : (v > 0.99f ? 0.99f : v); }
    void setMix(float v)      { mix_ = (v < 0.f) ? 0.f : (v > 1.f ? 1.f : v); }
    float operator()(float in) {
        const float tap = d_();
        d_.write(in + tap * feedback_);
        return in * (1.f - mix_) + tap * mix_;
    }
};`,
    ins: [
      { n: "in",       t: "audio" },
      { n: "bpm",      t: "param" },
      { n: "division", t: "param" },
      { n: "feedback", t: "param" },
      { n: "mix",      t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { bpm: 120, division: 1.0, feedback: 0.5, mix: 0.5 },
    methods: { bpm: "setBpm", division: "setDivision", feedback: "setFeedback", mix: "setMix" },
    description: "Tempo-synced delay. Wire MasterClock.bpm → bpm; division is the beat-fraction multiplier (0.25 = 1/16, 0.5 = 1/8, 1.0 = 1/4, 2.0 = 1/2, 4.0 = 1/1). Common idiom: dotted = 1.5×, triplet = 2/3×."
  },

  /* ---- Multi-output (codegen binds these to a temporary; consumers index into it) ---- */
  /* gam::Pan (NOT Pan2 — that name was a registry typo). operator()(in)
   * returns Vec<2,T> which exposes [0]=L and [1]=R. setter is .pos. */
  Pan2: {
    category: "Effect", color: COLOR.effect, header: "Effects",
    cppType: "gam::Pan<>",
    ins: [{n:"in", t:"audio"}, {n:"pan", t:"param"}],
    outs: [{n:"L", t:"audio", access: "[0]"}, {n:"R", t:"audio", access: "[1]"}],
    params: { pan: 0 },
    methods: { pan: "pos" },
    description: "Equal-power stereo panner. pan ∈ [-1, 1]."
  },
  /* gam::Hilbert lives in Filter.h, not Effects.h. operator()(in)
   * returns a gam::Complex which exposes [0]=real and [1]=imag —
   * the existing access pattern is correct. */
  Hilbert: {
    category: "Effect", color: COLOR.effect, header: "Filter",
    cppType: "gam::Hilbert<>",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"real", t:"audio", access: "[0]"}, {n:"imag", t:"audio", access: "[1]"}],
    params: {},
    description: "Hilbert transformer — splits input into real and imaginary parts (analytic signal)"
  },

  /* ---- Stereo utilities ----
   * Three small helper-class composites that operate on a stereo
   * pair. All follow the same pattern: L is the implicit operator()
   * argument (the codegen's signalInput pick); R (and any other
   * audio input) is plumbed through a per-sample setter. Outputs
   * use the multi-out struct + .access pattern.
   *
   * Math:
   *   M = (L + R) * 0.5     S = (L - R) * 0.5
   *   L = M + S              R = M - S
   * MidSide encodes; SideMid decodes; StereoWidener does both with
   * a width gain on the side channel in between (1 = unchanged,
   * 0 = mono, >1 = wider). */
  MidSide: {
    category: "Effect", color: COLOR.effect, header: null,
    cppType: "GammaMidSide",
    helperClass:
`class GammaMidSide {
    float r_ = 0.f;
public:
    void setR(float v) { r_ = v; }
    struct Out { float m, s; };
    Out operator()(float l) {
        Out o;
        o.m = (l + r_) * 0.5f;
        o.s = (l - r_) * 0.5f;
        return o;
    }
};`,
    ins: [
      { n: "L", t: "audio" },
      { n: "R", t: "audio" }
    ],
    outs: [
      { n: "M", t: "audio", access: ".m" },
      { n: "S", t: "audio", access: ".s" }
    ],
    params: {},
    methods: { R: "setR" },
    description: "Mid/Side encoder. L+R→M (sum), L-R→S (difference). Wire stereo into L/R and route M/S separately for mid/side processing (e.g. compress M with one chain, EQ S with another, then SideMid back to L/R)."
  },
  SideMid: {
    category: "Effect", color: COLOR.effect, header: null,
    cppType: "GammaSideMid",
    helperClass:
`class GammaSideMid {
    float s_ = 0.f;
public:
    void setS(float v) { s_ = v; }
    struct Out { float l, r; };
    Out operator()(float m) {
        Out o;
        o.l = m + s_;
        o.r = m - s_;
        return o;
    }
};`,
    ins: [
      { n: "M", t: "audio" },
      { n: "S", t: "audio" }
    ],
    outs: [
      { n: "L", t: "audio", access: ".l" },
      { n: "R", t: "audio", access: ".r" }
    ],
    params: {},
    methods: { S: "setS" },
    description: "Side/Mid decoder. Inverse of MidSide: M+S→L, M−S→R. Use to convert back to L/R after processing the M and S channels separately."
  },
  StereoWidener: {
    category: "Effect", color: COLOR.effect, header: null,
    cppType: "GammaStereoWidener",
    helperClass:
`class GammaStereoWidener {
    float r_ = 0.f;
    float width_ = 1.f;
public:
    void setR(float v)     { r_ = v; }
    void setWidth(float v) { width_ = (v < 0.f) ? 0.f : v; }
    struct Out { float l, r; };
    Out operator()(float l) {
        const float m = (l + r_) * 0.5f;
        const float s = (l - r_) * 0.5f * width_;
        Out o;
        o.l = m + s;
        o.r = m - s;
        return o;
    }
};`,
    ins: [
      { n: "L",     t: "audio" },
      { n: "R",     t: "audio" },
      { n: "width", t: "param" }
    ],
    outs: [
      { n: "L", t: "audio", access: ".l" },
      { n: "R", t: "audio", access: ".r" }
    ],
    params: { width: 1.0 },
    methods: { R: "setR", width: "setWidth" },
    description: "Stereo widener. Internally encodes L/R → M/S, scales the side channel by width, then decodes back. width=1 = pass-through; <1 collapses toward mono; >1 widens. Often paired with MonoMaker on the low end to keep bass mono while widening highs."
  },

  /* HaasDelay — single-channel short delay for stereo width via
   * the Haas effect. Mono in fans out to L straight and R delayed
   * by 5–30 ms. The brain perceives this as a wider stereo image
   * without summing-to-mono cancellation issues. Set delay around
   * 15 ms for a subtle widening, 30+ ms for a clear "doubling"
   * effect (you start hearing it as a discrete echo past 35 ms). */
  HaasDelay: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<Gamma/Delay.h>"],
    cppType: "GammaHaas",
    helperClass:
`class GammaHaas {
    gam::Delay<> d_;
public:
    GammaHaas() {
        d_.maxDelay(0.05f);
        d_.delay(0.015f);
    }
    void setDelay(float ms) {
        const float s = ms * 0.001f;
        d_.delay((s < 0.001f) ? 0.001f : (s > 0.05f ? 0.05f : s));
    }
    struct Out { float l, r; };
    Out operator()(float in) {
        Out o;
        o.l = in;
        o.r = d_(in);
        return o;
    }
};`,
    ins: [
      { n: "in",    t: "audio" },
      { n: "delay", t: "param" }
    ],
    outs: [
      { n: "L", t: "audio", access: ".l" },
      { n: "R", t: "audio", access: ".r" }
    ],
    params: { delay: 15 },
    methods: { delay: "setDelay" },
    description: "Haas-effect stereo widener. Mono in → L straight + R delayed by `delay` ms (1–50). 10–25 ms reads as natural widening, 30+ ms starts to sound like a slap-back. Mono-compatible since the delayed copy doesn't cancel against the original at most listening distances."
  },

  /* MonoMaker — crossover that forces low frequencies to mono.
   * Splits each channel into low + high via complementary
   * Biquad LP/HP at `cutoff`; lows are summed and applied to
   * both outputs, highs preserve the original L/R. Common on
   * mastering bus to keep bass tight + centered while letting
   * mids/highs stay wide. Pair with `StereoWidener` (above the
   * cutoff) for a clean separation. */
  MonoMaker: {
    category: "Effect", color: COLOR.effect, header: "Filter",
    cppType: "GammaMonoMaker",
    helperClass:
`class GammaMonoMaker {
    gam::Biquad<> lpfL_, lpfR_, hpfL_, hpfR_;
    float r_ = 0.f;
    float cutoff_ = 120.f;
public:
    GammaMonoMaker() {
        lpfL_.type(gam::LOW_PASS);  lpfL_.freq(120.f);
        lpfR_.type(gam::LOW_PASS);  lpfR_.freq(120.f);
        hpfL_.type(gam::HIGH_PASS); hpfL_.freq(120.f);
        hpfR_.type(gam::HIGH_PASS); hpfR_.freq(120.f);
    }
    void setR(float v) { r_ = v; }
    void setCutoff(float v) {
        cutoff_ = (v < 20.f) ? 20.f : (v > 1000.f ? 1000.f : v);
        lpfL_.freq(cutoff_); lpfR_.freq(cutoff_);
        hpfL_.freq(cutoff_); hpfR_.freq(cutoff_);
    }
    struct Out { float l, r; };
    Out operator()(float l) {
        const float lLo = lpfL_(l),  rLo = lpfR_(r_);
        const float lHi = hpfL_(l),  rHi = hpfR_(r_);
        const float mono = (lLo + rLo) * 0.5f;
        Out o;
        o.l = mono + lHi;
        o.r = mono + rHi;
        return o;
    }
};`,
    ins: [
      { n: "L",      t: "audio" },
      { n: "R",      t: "audio" },
      { n: "cutoff", t: "param" }
    ],
    outs: [
      { n: "L", t: "audio", access: ".l" },
      { n: "R", t: "audio", access: ".r" }
    ],
    params: { cutoff: 120 },
    methods: { R: "setR", cutoff: "setCutoff" },
    description: "Forces stereo bass below `cutoff` Hz to mono. Below cutoff: (L+R)/2 to both channels. Above cutoff: L and R pass through. Default 120 Hz handles typical bass / kick. Wire stereo into L/R, route the output L/R into OutputStereo (or downstream stereo nodes)."
  },

  /* ---- Effects (Effects.h) ---- */
  /* gam::ReverbMS lives in Spatial.h, NOT Effects.h. The previous
   * `header: "Effects"` was including the wrong file → compile fail.
   * It also requires a one-time .resize(flavor) call before output
   * is non-zero — the default-constructed reverb has zero combs and
   * zero allpasses, which routes input → silence. extraCtor below
   * sets it to FREEVERB on instantiation (Jezar's algorithm: 8
   * combs + 4 allpasses). decay() and damping() are the chained
   * setters; both return ReverbMS&, so the patch ctor's chained
   * call site has to discard them — already what generateCode does. */
  ReverbMS: {
    category: "Effect", color: COLOR.effect, header: "Spatial",
    cppType: "gam::ReverbMS<>",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: { decay: 0.85, damping: 0.5 },
    methods: { decay: "decay", damping: "damping" },
    extraCtor: ["{id}.resize(gam::FREEVERB);"],
    description: "Moorer-Schroeder reverb (Jezar's Freeverb topology — 8 combs + 4 allpasses). decay sets the comb-loop gain; damping sets the per-comb low-pass amount."
  },

  /* ---- Additional reverb topologies --------------------------------
   * ReverbMS already wraps Gamma's gam::ReverbMS (Freeverb). The three
   * helper-class reverbs below cover the rest of the canonical
   * topology palette: a Schroeder-flavored plate (dense / bright),
   * a spring emulation (chirpy / dispersed), and an 8-line FDN
   * (mathematically clean, parameter-tunable into anything from
   * room to cathedral). All four share the wet/dry mix idiom so
   * they're drop-in interchangeable on a send-effect bus. */

  /* PlateReverb — 4 input diffuser allpasses → 4 parallel comb
   * filters with per-line LP damping → 2 series output allpasses.
   * Tunings biased toward longer/denser than Freeverb so the
   * character is recognizably "plate" (no clear early reflections,
   * smooth bright tail). All delay lengths in samples assume 48 kHz
   * and scale at construction if the audio context's sample rate
   * differs (small drift in plate character is acceptable; the
   * topology is what matters). */
  PlateReverb: {
    category: "Effect", color: COLOR.effect, header: null,
    cppType: "GammaPlateReverb",
    extraHeaders: ["<cmath>"],
    helperClass:
`class GammaPlateReverb {
    // Allpass diffusers (input chain) — four short, prime-related lengths.
    static constexpr int AP1=142, AP2=107, AP3=379, AP4=277;
    // Comb filters (tank) — longer than Freeverb for plate density.
    static constexpr int CB1=1687, CB2=1601, CB3=2053, CB4=2251;
    // Output allpasses (smear + decorrelate L/R).
    static constexpr int APO1=556, APO2=441;
    float bAP1[AP1] = {0}, bAP2[AP2] = {0}, bAP3[AP3] = {0}, bAP4[AP4] = {0};
    float bCB1[CB1] = {0}, bCB2[CB2] = {0}, bCB3[CB3] = {0}, bCB4[CB4] = {0};
    float bAPO1[APO1] = {0}, bAPO2[APO2] = {0};
    int   pAP1=0, pAP2=0, pAP3=0, pAP4=0;
    int   pCB1=0, pCB2=0, pCB3=0, pCB4=0;
    int   pAPO1=0, pAPO2=0;
    float lp1=0, lp2=0, lp3=0, lp4=0;     // damping LP state per comb
    float decay_ = 0.85f;
    float damping_ = 0.5f;
    float mix_ = 0.4f;
    static constexpr float APG = 0.5f;    // allpass gain (Schroeder)
    static float ap_(float in, float* buf, int& p, int N) {
        const float dl = buf[p];
        const float v  = in + dl * APG;
        buf[p] = v;
        const float out = dl - v * APG;
        p = (p + 1) % N;
        return out;
    }
public:
    void setDecay(float v)   { decay_   = (v < 0.f) ? 0.f : (v > 0.99f ? 0.99f : v); }
    void setDamping(float v) { damping_ = (v < 0.f) ? 0.f : (v > 0.99f ? 0.99f : v); }
    void setMix(float v)     { mix_     = (v < 0.f) ? 0.f : (v > 1.f   ? 1.f   : v); }
    float operator()(float in) {
        // Input diffusion — 4 cascaded allpasses smooth transients
        // into a dense impulse train before the tank sees them.
        float x = ap_(in, bAP1, pAP1, AP1);
              x = ap_(x,  bAP2, pAP2, AP2);
              x = ap_(x,  bAP3, pAP3, AP3);
              x = ap_(x,  bAP4, pAP4, AP4);
        // 4 parallel combs, each with a one-pole LP in the feedback
        // path for damping (high-frequency loss with each round trip).
        const float d = damping_;
        const float fb = decay_;
        float c1 = bCB1[pCB1]; lp1 += (1.f - d) * (c1 - lp1); bCB1[pCB1] = x + lp1 * fb; pCB1 = (pCB1 + 1) % CB1;
        float c2 = bCB2[pCB2]; lp2 += (1.f - d) * (c2 - lp2); bCB2[pCB2] = x + lp2 * fb; pCB2 = (pCB2 + 1) % CB2;
        float c3 = bCB3[pCB3]; lp3 += (1.f - d) * (c3 - lp3); bCB3[pCB3] = x + lp3 * fb; pCB3 = (pCB3 + 1) % CB3;
        float c4 = bCB4[pCB4]; lp4 += (1.f - d) * (c4 - lp4); bCB4[pCB4] = x + lp4 * fb; pCB4 = (pCB4 + 1) % CB4;
        float wet = (c1 + c2 + c3 + c4) * 0.25f;
        // Output diffusion — two more allpasses smear the comb tails.
        wet = ap_(wet, bAPO1, pAPO1, APO1);
        wet = ap_(wet, bAPO2, pAPO2, APO2);
        return in * (1.f - mix_) + wet * mix_;
    }
};`,
    ins: [
      { n: "in",       t: "audio" },
      { n: "decay",    t: "param" },
      { n: "damping",  t: "param" },
      { n: "mix",      t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { decay: 0.85, damping: 0.5, mix: 0.4 },
    methods: { decay: "setDecay", damping: "setDamping", mix: "setMix" },
    description: "Plate-style reverb — 4 input diffusers → 4 parallel combs (with per-line LP damping) → 2 output allpasses. Bigger / denser / brighter than ReverbMS by default; classic plate character. mix is wet level (0=dry, 1=wet)."
  },

  /* SpringReverb — characteristic "boing" comes from chirp dispersion
   * in real springs, which we approximate by cascading short allpass
   * filters with a single feedback delay line. Highpass on input
   * mimics the spring's natural HF emphasis; tremolo on output adds
   * the metallic shimmer without going to a full physical model. Not
   * a strict spring simulation — recognizable character at a tiny
   * fraction of a true Karjalainen-style waveguide. */
  SpringReverb: {
    category: "Effect", color: COLOR.effect, header: null,
    cppType: "GammaSpringReverb",
    extraHeaders: ["<cmath>"],
    helperClass:
`class GammaSpringReverb {
    // Six cascaded allpasses with mismatched coefficients produce
    // frequency-dependent group delay — the dispersion that gives
    // springs their signature chirp on transients.
    float ap1=0, ap2=0, ap3=0, ap4=0, ap5=0, ap6=0;
    float ag1=0.6f, ag2=0.55f, ag3=0.7f, ag4=0.65f, ag5=0.5f, ag6=0.75f;
    // Feedback delay line — short (~30 ms) to keep the spring "tight."
    static constexpr int DL = 1300;
    float buf[DL] = {0};
    int   pBuf = 0;
    // Highpass + lowpass tone shaping. Spring's natural response
    // emphasizes ~200 Hz–4 kHz, rolls off the rest.
    float hp = 0, lp = 0;
    // Tremolo for "metallic shimmer."
    float trem_ = 0.f;
    float sr_ = 48000.f;
    float decay_ = 0.6f;
    float tone_  = 0.5f;
    float mix_   = 0.4f;
    static float ap_(float in, float& s, float g) {
        const float v = in + s * g;
        const float out = s - v * g;
        s = v;
        return out;
    }
public:
    GammaSpringReverb() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
    }
    void setDecay(float v) { decay_ = (v < 0.f) ? 0.f : (v > 0.95f ? 0.95f : v); }
    void setTone(float v)  { tone_  = (v < 0.f) ? 0.f : (v > 1.f   ? 1.f   : v); }
    void setMix(float v)   { mix_   = (v < 0.f) ? 0.f : (v > 1.f   ? 1.f   : v); }
    float operator()(float in) {
        // Soft highpass — cuts sub frequencies that don't belong in a spring.
        hp += 0.005f * (in - hp);
        float x = in - hp;
        // 6 cascaded allpass — dispersion. Each tap nudges the group
        // delay differently per frequency, giving the chirp.
        x = ap_(x, ap1, ag1);
        x = ap_(x, ap2, ag2);
        x = ap_(x, ap3, ag3);
        x = ap_(x, ap4, ag4);
        x = ap_(x, ap5, ag5);
        x = ap_(x, ap6, ag6);
        // Mix in the delay-line feedback for the actual reverb tail.
        const float dl = buf[pBuf];
        const float fb = x + dl * decay_;
        buf[pBuf] = fb;
        pBuf = (pBuf + 1) % DL;
        // Tone (LP) — 0 dark, 1 bright.
        lp += (0.05f + tone_ * 0.4f) * (fb - lp);
        // Tremolo at ~5 Hz, depth scaled by tone for shimmer.
        trem_ += (5.f * 6.2831853f) / sr_;
        if (trem_ > 6.2831853f) trem_ -= 6.2831853f;
        const float tremMod = 1.f + 0.04f * std::sin(trem_) * tone_;
        const float wet = lp * tremMod;
        return in * (1.f - mix_) + wet * mix_;
    }
};`,
    ins: [
      { n: "in",     t: "audio" },
      { n: "decay",  t: "param" },
      { n: "tone",   t: "param" },
      { n: "mix",    t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { decay: 0.6, tone: 0.5, mix: 0.4 },
    methods: { decay: "setDecay", tone: "setTone", mix: "setMix" },
    description: "Spring-style reverb — cascaded allpasses for chirp dispersion + short feedback delay + tone-shaping LP/HP + 5 Hz tremolo for metallic shimmer. Distinctive 'boing' character on transients; decay controls feedback gain, tone shifts the spectrum dark→bright."
  },

  /* FDN8 — 8-line Feedback Delay Network. Eight delay lines fed
   * back through a Hadamard mixing matrix, producing dense even
   * decay across the spectrum. This is the modern Lexicon /
   * Eventide foundational topology — tunable into anything from
   * tight room (small delays + low decay) to cathedral (long
   * delays + high decay). Coprime delay lengths avoid resonant
   * ringing. Per-line one-pole LP gives frequency-dependent
   * decay (HF dies first, like real rooms). */
  FDN8: {
    category: "Effect", color: COLOR.effect, header: null,
    cppType: "GammaFDN8",
    extraHeaders: ["<cmath>"],
    helperClass:
`class GammaFDN8 {
    // 8 coprime delay lengths (~40 ms to ~125 ms at 48 kHz). Coprime
    // = no shared factors → modes don't reinforce → smoother decay.
    static constexpr int N1=2003, N2=2741, N3=3163, N4=3527;
    static constexpr int N5=4153, N6=4691, N7=5227, N8=6029;
    float d1[N1]={0}, d2[N2]={0}, d3[N3]={0}, d4[N4]={0};
    float d5[N5]={0}, d6[N6]={0}, d7[N7]={0}, d8[N8]={0};
    int p1=0,p2=0,p3=0,p4=0,p5=0,p6=0,p7=0,p8=0;
    float lp1=0,lp2=0,lp3=0,lp4=0,lp5=0,lp6=0,lp7=0,lp8=0;
    float decay_   = 0.85f;
    float damping_ = 0.3f;
    float mix_     = 0.4f;
public:
    void setDecay(float v)   { decay_   = (v < 0.f) ? 0.f : (v > 0.99f ? 0.99f : v); }
    void setDamping(float v) { damping_ = (v < 0.f) ? 0.f : (v > 0.99f ? 0.99f : v); }
    void setMix(float v)     { mix_     = (v < 0.f) ? 0.f : (v > 1.f   ? 1.f   : v); }
    float operator()(float in) {
        // Read delay outputs.
        const float y1 = d1[p1], y2 = d2[p2], y3 = d3[p3], y4 = d4[p4];
        const float y5 = d5[p5], y6 = d6[p6], y7 = d7[p7], y8 = d8[p8];
        // Hadamard 8x8 mix — preserves energy, maximally diffusing.
        // Pre-multiplied by 1/sqrt(8) = 0.3535... folded into the
        // decay_ scaling so we don't pay 8 muls per sample.
        const float k = 0.35355339f * decay_;
        const float n1 = (y1+y2+y3+y4+y5+y6+y7+y8) * k;
        const float n2 = (y1-y2+y3-y4+y5-y6+y7-y8) * k;
        const float n3 = (y1+y2-y3-y4+y5+y6-y7-y8) * k;
        const float n4 = (y1-y2-y3+y4+y5-y6-y7+y8) * k;
        const float n5 = (y1+y2+y3+y4-y5-y6-y7-y8) * k;
        const float n6 = (y1-y2+y3-y4-y5+y6-y7+y8) * k;
        const float n7 = (y1+y2-y3-y4-y5-y6+y7+y8) * k;
        const float n8 = (y1-y2-y3+y4-y5+y6+y7-y8) * k;
        // Per-line damping LP, then write the new state back.
        const float a = 1.f - damping_;
        lp1 += a * (n1 + in - lp1); d1[p1] = lp1; p1 = (p1+1) % N1;
        lp2 += a * (n2 + in - lp2); d2[p2] = lp2; p2 = (p2+1) % N2;
        lp3 += a * (n3 + in - lp3); d3[p3] = lp3; p3 = (p3+1) % N3;
        lp4 += a * (n4 + in - lp4); d4[p4] = lp4; p4 = (p4+1) % N4;
        lp5 += a * (n5 - in - lp5); d5[p5] = lp5; p5 = (p5+1) % N5;
        lp6 += a * (n6 - in - lp6); d6[p6] = lp6; p6 = (p6+1) % N6;
        lp7 += a * (n7 - in - lp7); d7[p7] = lp7; p7 = (p7+1) % N7;
        lp8 += a * (n8 - in - lp8); d8[p8] = lp8; p8 = (p8+1) % N8;
        // Output sum, normalized.
        const float wet = (y1+y2+y3+y4+y5+y6+y7+y8) * 0.125f;
        return in * (1.f - mix_) + wet * mix_;
    }
};`,
    ins: [
      { n: "in",       t: "audio" },
      { n: "decay",    t: "param" },
      { n: "damping",  t: "param" },
      { n: "mix",      t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { decay: 0.85, damping: 0.3, mix: 0.4 },
    methods: { decay: "setDecay", damping: "setDamping", mix: "setMix" },
    description: "8-line Feedback Delay Network — coprime delays + Hadamard mixing matrix + per-line LP damping. Modern Lexicon-style topology; tune decay (feedback gain) + damping (HF rolloff) for anything from small room to cathedral."
  },

  Burst: {
    category: "Effect", color: COLOR.effect, header: "Effects",
    cppType: "gam::Burst",
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    description: "Filtered noise burst (configure freq1/freq2/decay in ctor by hand)"
  },
  /* The Gamma class is gam::Pluck (not PluckedString — that was a
   * registry typo). Self-driven (no audio input — the helper has its
   * own internal noise + decay envelope); trig fires reset() to
   * restart the envelope. */
  PluckedString: {
    category: "Effect", color: COLOR.effect, header: "Effects",
    cppType: "gam::Pluck",
    ins: [{n:"trig", t:"gate"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 220 },
    methods: { freq: "freq" },
    description: "Karplus-Strong plucked string (Gamma's gam::Pluck — internal noise + decay envelope, comb-filter delay loop)."
  },
  FreqShift: {
    category: "Effect", color: COLOR.effect, header: "Effects",
    cppType: "gam::FreqShift<>",
    ins: [{n:"in", t:"audio"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 100 },
    methods: { freq: "freq" },
    description: "Hilbert-based frequency shifter"
  },
  /* gam::Chirplet lives in Oscillator.h, not Effects.h. */
  Chirplet: {
    category: "Effect", color: COLOR.effect, header: "Oscillator",
    cppType: "gam::Chirplet<>",
    ins: [{n:"trig", t:"gate"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    description: "Frequency-swept Gaussian-windowed sinusoid (configure in ctor)"
  },

  /* ---- Modulation effects ----
   * All five share the same shape: an LFO drives one or more time-
   * domain operations (gain, delay-tap, allpass freq) to produce a
   * cyclic modulation. Wraps gam::LFO + (Delay or AllPass1) per
   * effect. Use `rate` to set LFO frequency in Hz, `depth` to set
   * the modulation amount, and `mix` (where present) to blend dry
   * vs. wet. */

  /* Tremolo — amplitude modulation. LFO scales the input gain.
   * depth=0 → bypass; depth=1 → input fully gated by LFO. */
  Tremolo: {
    category: "Effect", color: COLOR.effect, header: "Oscillator",
    cppType: "GammaTremolo",
    helperClass:
`class GammaTremolo {
    gam::LFO<> lfo_;
    float depth_ = 0.5f;
public:
    GammaTremolo() { lfo_.freq(5.f); }
    void setRate(float v)  { lfo_.freq(v); }
    void setDepth(float v) { depth_ = (v < 0.f) ? 0.f : (v > 1.f ? 1.f : v); }
    float operator()(float in) {
        // LFO.cos() returns -1..1; remap to 0..1 so the gain modulates
        // between (1 - depth) and 1.0 rather than going negative.
        const float m = 0.5f + 0.5f * lfo_.cos();
        return in * (1.f - depth_ + depth_ * m);
    }
};`,
    ins: [
      { n: "in",    t: "audio" },
      { n: "rate",  t: "param" },
      { n: "depth", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { rate: 5, depth: 0.5 },
    methods: { rate: "setRate", depth: "setDepth" },
    description: "Tremolo — LFO-modulated amplitude. rate in Hz; depth ∈ [0,1] sets how much the gain is modulated (0 = bypass, 1 = full chop)."
  },

  /* Vibrato — pitch modulation via short delay-tap modulation. The
   * LFO sweeps the delay time around a base offset; varying delay
   * = effective pitch shift. depth in ms (0..7); base delay 8ms so
   * the read tap stays inside the buffer at any LFO position. */
  Vibrato: {
    category: "Effect", color: COLOR.effect, header: "Oscillator",
    extraHeaders: ["<Gamma/Delay.h>"],
    cppType: "GammaVibrato",
    helperClass:
`class GammaVibrato {
    gam::Delay<> d_;
    gam::LFO<> lfo_;
    float depthSec_ = 0.005f;
    float baseSec_ = 0.008f;
public:
    GammaVibrato() {
        d_.maxDelay(0.05f);
        d_.delay(baseSec_);
        lfo_.freq(5.f);
    }
    void setRate(float v)   { lfo_.freq(v); }
    void setDepth(float ms) {
        const float s = ms * 0.001f;
        depthSec_ = (s < 0.f) ? 0.f : (s > 0.007f ? 0.007f : s);
    }
    float operator()(float in) {
        const float lfoVal = lfo_.cos();           // -1..1
        const float t = baseSec_ + depthSec_ * lfoVal;
        d_.delay(t);
        return d_(in);
    }
};`,
    ins: [
      { n: "in",    t: "audio" },
      { n: "rate",  t: "param" },
      { n: "depth", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { rate: 5, depth: 5 },
    methods: { rate: "setRate", depth: "setDepth" },
    description: "Vibrato — pitch wobble via short LFO-modulated delay. rate in Hz; depth in ms (0..7). Wet-only output (the modulation is the effect)."
  },

  /* Flanger — vibrato with feedback, blended dry/wet. The feedback
   * path through the LFO-swept delay creates the comb-filter sweep
   * that's the signature flanger sound. depth in ms; feedback
   * clamped to 0.95 so it can't fully self-oscillate. */
  Flanger: {
    category: "Effect", color: COLOR.effect, header: "Oscillator",
    extraHeaders: ["<Gamma/Delay.h>"],
    cppType: "GammaFlanger",
    helperClass:
`class GammaFlanger {
    gam::Delay<> d_;
    gam::LFO<> lfo_;
    float depthSec_ = 0.002f;
    float baseSec_ = 0.005f;
    float feedback_ = 0.5f;
    float mix_ = 0.5f;
public:
    GammaFlanger() {
        d_.maxDelay(0.02f);
        lfo_.freq(0.5f);
    }
    void setRate(float v)     { lfo_.freq(v); }
    void setDepth(float ms)   {
        const float s = ms * 0.001f;
        depthSec_ = (s < 0.f) ? 0.f : (s > 0.004f ? 0.004f : s);
    }
    void setFeedback(float v) { feedback_ = (v < 0.f) ? 0.f : (v > 0.95f ? 0.95f : v); }
    void setMix(float v)      { mix_ = (v < 0.f) ? 0.f : (v > 1.f ? 1.f : v); }
    float operator()(float in) {
        // LFO 0..1 so the swept delay is always positive.
        const float lfoVal = 0.5f + 0.5f * lfo_.cos();
        const float t = baseSec_ - depthSec_ + 2.f * depthSec_ * lfoVal;
        d_.delay(t);
        const float wet = d_();              // read tap
        d_.write(in + wet * feedback_);      // write input + feedback
        return in * (1.f - mix_) + wet * mix_;
    }
};`,
    ins: [
      { n: "in",       t: "audio" },
      { n: "rate",     t: "param" },
      { n: "depth",    t: "param" },
      { n: "feedback", t: "param" },
      { n: "mix",      t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { rate: 0.5, depth: 2, feedback: 0.5, mix: 0.5 },
    methods: { rate: "setRate", depth: "setDepth", feedback: "setFeedback", mix: "setMix" },
    description: "Flanger — comb-filter sweep via LFO-modulated short delay with feedback. rate in Hz; depth in ms; feedback adds the resonant whoosh; mix blends dry/wet."
  },

  /* Phaser — cascaded allpass filters with LFO-swept frequencies.
   * The phase shifts cancel at certain frequencies, producing the
   * sweeping notch filter "phase" sound. Two variants (Phaser4 and
   * Phaser6) share the same GammaPhaserT<N> template; codegen
   * emits the helper class only once thanks to class-name dedup. */
  Phaser4: {
    category: "Effect", color: COLOR.effect, header: "Oscillator",
    extraHeaders: ["<Gamma/Filter.h>"],
    cppType: "GammaPhaserT<4>",
    helperClass:
`template<int STAGES> class GammaPhaserT {
    gam::AllPass1<> ap_[STAGES];
    gam::LFO<> lfo_;
    float depth_ = 0.7f;       // 0..1 — controls the LFO sweep range
    float feedback_ = 0.0f;
    float mix_ = 0.5f;
    float fbSample_ = 0.f;
public:
    GammaPhaserT() {
        for (int i = 0; i < STAGES; i++) ap_[i].freq(800.f);
        lfo_.freq(0.5f);
    }
    void setRate(float v)     { lfo_.freq(v); }
    void setDepth(float v)    { depth_ = (v < 0.f) ? 0.f : (v > 1.f ? 1.f : v); }
    void setFeedback(float v) { feedback_ = (v < 0.f) ? 0.f : (v > 0.95f ? 0.95f : v); }
    void setMix(float v)      { mix_ = (v < 0.f) ? 0.f : (v > 1.f ? 1.f : v); }
    float operator()(float in) {
        const float lfoVal = 0.5f + 0.5f * lfo_.cos();   // 0..1
        const float f = 200.f + 4000.f * depth_ * lfoVal;
        for (int i = 0; i < STAGES; i++) ap_[i].freq(f);
        float v = in + fbSample_ * feedback_;
        for (int i = 0; i < STAGES; i++) v = ap_[i](v);
        fbSample_ = v;
        return in * (1.f - mix_) + v * mix_;
    }
};`,
    ins: [
      { n: "in",       t: "audio" },
      { n: "rate",     t: "param" },
      { n: "depth",    t: "param" },
      { n: "feedback", t: "param" },
      { n: "mix",      t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { rate: 0.5, depth: 0.7, feedback: 0, mix: 0.5 },
    methods: { rate: "setRate", depth: "setDepth", feedback: "setFeedback", mix: "setMix" },
    description: "4-stage phaser — cascaded allpass filters whose cutoffs sweep with an LFO. rate in Hz; depth controls the sweep range; feedback emphasizes the resonant peaks."
  },
  Phaser6: {
    category: "Effect", color: COLOR.effect, header: "Oscillator",
    extraHeaders: ["<Gamma/Filter.h>"],
    cppType: "GammaPhaserT<6>",
    helperClass:
`template<int STAGES> class GammaPhaserT {
    gam::AllPass1<> ap_[STAGES];
    gam::LFO<> lfo_;
    float depth_ = 0.7f;
    float feedback_ = 0.0f;
    float mix_ = 0.5f;
    float fbSample_ = 0.f;
public:
    GammaPhaserT() {
        for (int i = 0; i < STAGES; i++) ap_[i].freq(800.f);
        lfo_.freq(0.5f);
    }
    void setRate(float v)     { lfo_.freq(v); }
    void setDepth(float v)    { depth_ = (v < 0.f) ? 0.f : (v > 1.f ? 1.f : v); }
    void setFeedback(float v) { feedback_ = (v < 0.f) ? 0.f : (v > 0.95f ? 0.95f : v); }
    void setMix(float v)      { mix_ = (v < 0.f) ? 0.f : (v > 1.f ? 1.f : v); }
    float operator()(float in) {
        const float lfoVal = 0.5f + 0.5f * lfo_.cos();
        const float f = 200.f + 4000.f * depth_ * lfoVal;
        for (int i = 0; i < STAGES; i++) ap_[i].freq(f);
        float v = in + fbSample_ * feedback_;
        for (int i = 0; i < STAGES; i++) v = ap_[i](v);
        fbSample_ = v;
        return in * (1.f - mix_) + v * mix_;
    }
};`,
    ins: [
      { n: "in",       t: "audio" },
      { n: "rate",     t: "param" },
      { n: "depth",    t: "param" },
      { n: "feedback", t: "param" },
      { n: "mix",      t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { rate: 0.5, depth: 0.7, feedback: 0, mix: 0.5 },
    methods: { rate: "setRate", depth: "setDepth", feedback: "setFeedback", mix: "setMix" },
    description: "6-stage phaser — extra two allpass stages over Phaser4 for a deeper, more chorus-like swirl."
  },

  /* AutoPan — LFO-modulated stereo panning. Mono input, stereo
   * output. Uses a simple linear pan law (sum of L and R always
   * equals input × 1) since auto-pan typically wants symmetric
   * gains rather than constant-power pan. */
  AutoPan: {
    category: "Effect", color: COLOR.effect, header: "Oscillator",
    cppType: "GammaAutoPan",
    helperClass:
`class GammaAutoPan {
    gam::LFO<> lfo_;
    float depth_ = 1.f;
public:
    GammaAutoPan() { lfo_.freq(0.5f); }
    void setRate(float v)  { lfo_.freq(v); }
    void setDepth(float v) { depth_ = (v < 0.f) ? 0.f : (v > 1.f ? 1.f : v); }
    struct Out { float l, r; };
    Out operator()(float in) {
        const float pos = lfo_.cos() * depth_;     // -depth .. +depth
        const float lGain = 0.5f * (1.f - pos);
        const float rGain = 0.5f * (1.f + pos);
        Out o;
        o.l = in * lGain;
        o.r = in * rGain;
        return o;
    }
};`,
    ins: [
      { n: "in",    t: "audio" },
      { n: "rate",  t: "param" },
      { n: "depth", t: "param" }
    ],
    outs: [
      { n: "L", t: "audio", access: ".l" },
      { n: "R", t: "audio", access: ".r" }
    ],
    params: { rate: 0.5, depth: 1 },
    methods: { rate: "setRate", depth: "setDepth" },
    description: "Auto-pan — LFO-driven stereo panner. rate in Hz; depth ∈ [0,1] (1 = full L↔R sweep). Mono in, stereo out — wire L/R into OutputStereo."
  },

  /* AutoFilter — LFO-modulated filter cutoff. The LFO sweeps the
   * cutoff up and down by `depth` octaves around `baseFreq`,
   * with a `mode` enum picking LP / HP / BP. Equivalent to wiring
   * `LFO → some math → Biquad.freq` but baked into one node so
   * the common case is a single drop-in. */
  AutoFilter: {
    category: "Effect", color: COLOR.effect, header: "Oscillator",
    extraHeaders: ["<Gamma/Filter.h>", "<cmath>"],
    cppType: "GammaAutoFilter",
    helperClass:
`class GammaAutoFilter {
    gam::Biquad<> filter_;
    gam::LFO<> lfo_;
    float depth_ = 1.0f;          // octaves of sweep at full LFO swing
    float baseFreq_ = 800.f;
    int   mode_ = 0;              // 0=LP, 1=HP, 2=BP
public:
    GammaAutoFilter() {
        filter_.type(gam::LOW_PASS);
        filter_.freq(baseFreq_);
        filter_.res(0.7f);
        lfo_.freq(0.5f);
    }
    void setRate(float v)  { lfo_.freq(v); }
    void setDepth(float v) { depth_ = (v < 0.f) ? 0.f : (v > 4.f ? 4.f : v); }
    void setBase(float v)  { baseFreq_ = (v < 20.f) ? 20.f : (v > 12000.f ? 12000.f : v); }
    void setRes(float v)   { filter_.res((v < 0.5f) ? 0.5f : (v > 20.f ? 20.f : v)); }
    void setMode(float m) {
        mode_ = (int)m;
        switch (mode_) {
            case 1: filter_.type(gam::HIGH_PASS); break;
            case 2: filter_.type(gam::BAND_PASS); break;
            default: filter_.type(gam::LOW_PASS); break;
        }
    }
    float operator()(float in) {
        // Exponential sweep — ±depth octaves around baseFreq.
        const float f = baseFreq_ * std::pow(2.f, depth_ * lfo_.cos());
        const float clamped = (f < 20.f) ? 20.f : (f > 18000.f ? 18000.f : f);
        filter_.freq(clamped);
        return filter_(in);
    }
};`,
    ins: [
      { n: "in",    t: "audio" },
      { n: "rate",  t: "param" },
      { n: "depth", t: "param" },
      { n: "base",  t: "param" },
      { n: "res",   t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { rate: 0.5, depth: 1, base: 800, res: 0.7, mode: "LP" },
    methods: { rate: "setRate", depth: "setDepth", base: "setBase", res: "setRes", mode: "setMode" },
    paramOptions: { mode: ["LP", "HP", "BP"] },
    enumMap:      { mode: { LP: "0", HP: "1", BP: "2" } },
    description: "LFO-modulated filter (LP/HP/BP). Cutoff sweeps ±`depth` octaves around `base` Hz at `rate` Hz. res sets resonance. Equivalent to wiring an LFO into a Biquad's freq but with the exponential-octave mapping baked in (so depth=1 = ±1 octave regardless of base)."
  },

  /* TubeSat — asymmetric tube-style soft saturation. tanh on the
   * positive half-cycle, faster-rolling exponential on the
   * negative half-cycle (the "12AX7-ish" curve). bias shifts the
   * input DC offset before saturation, giving the classic
   * even-harmonics warmth at small biases. drive is the input
   * gain (output is auto-compensated so volume stays roughly
   * constant). */
  TubeSat: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaTubeSat",
    helperClass:
`class GammaTubeSat {
    float drive_ = 1.f;
    float bias_ = 0.f;
public:
    void setDrive(float v) { drive_ = (v < 0.1f) ? 0.1f : (v > 10.f ? 10.f : v); }
    void setBias(float v)  { bias_ = (v < -1.f) ? -1.f : (v > 1.f ? 1.f : v); }
    float operator()(float in) {
        const float x = in * drive_ + bias_;
        // Asymmetric: tanh up top, sharper exp on the bottom.
        const float y = (x >= 0.f) ? std::tanh(x) : -(1.f - std::exp(x));
        return y / drive_;   // gain compensation
    }
};`,
    ins: [
      { n: "in",    t: "audio" },
      { n: "drive", t: "param" },
      { n: "bias",  t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { drive: 1.0, bias: 0.0 },
    methods: { drive: "setDrive", bias: "setBias" },
    description: "Tube-style soft saturation. Asymmetric curve (tanh top, exp bottom) for the even-harmonic warmth. drive controls input gain (output auto-compensated); bias shifts DC pre-saturation for the classic 12AX7 bias-into-distortion sound."
  },

  /* TapeSat — symmetric soft saturation with a touch of hysteresis
   * so the curve has a tiny memory of its previous output. This is
   * the audible "sag" of analog tape — fast transients soften, low-
   * end fattens. drive is the input gain. */
  TapeSat: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaTapeSat",
    helperClass:
`class GammaTapeSat {
    float drive_ = 1.f;
    float prev_ = 0.f;
public:
    void setDrive(float v) { drive_ = (v < 0.1f) ? 0.1f : (v > 10.f ? 10.f : v); }
    float operator()(float in) {
        const float x = in * drive_;
        const float y = std::tanh(x);
        // Mild one-pole hysteresis — the saturated value remembers
        // a small fraction of the previous output. Adds tape-like
        // softening on transients and low-end body.
        const float HYST = 0.06f;
        const float out = y * (1.f - HYST) + prev_ * HYST;
        prev_ = out;
        return out / drive_;
    }
};`,
    ins: [
      { n: "in",    t: "audio" },
      { n: "drive", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { drive: 1.0 },
    methods: { drive: "setDrive" },
    description: "Tape-style soft saturation. Symmetric tanh + slight hysteresis (one-pole feedback of previous output) for the analog-tape sag — softens transients, adds low-end body. drive = input gain (output auto-compensated)."
  },

  /* Diode — diode-style soft clipping. sign(x) * (1 - exp(-|x|))
   * gives a smoother knee than tanh and a different harmonic
   * character — more of an "edge" sound at moderate drive,
   * compresses harder at extreme drive. */
  Diode: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaDiode",
    helperClass:
`class GammaDiode {
    float drive_ = 1.f;
public:
    void setDrive(float v) { drive_ = (v < 0.1f) ? 0.1f : (v > 10.f ? 10.f : v); }
    float operator()(float in) {
        const float x = in * drive_;
        const float ax = std::fabs(x);
        const float sgn = (x >= 0.f) ? 1.f : -1.f;
        return sgn * (1.f - std::exp(-ax)) / drive_;
    }
};`,
    ins: [
      { n: "in",    t: "audio" },
      { n: "drive", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { drive: 1.0 },
    methods: { drive: "setDrive" },
    description: "Diode-style soft clip via signed exponential softening. sign(x)·(1−e^−|x|) — smoother knee than tanh, bites harder at high drive. Use as a softer alternative to SoftClip for guitar / drums / anywhere you want grit without harsh top-end."
  },

  /* ---- Dynamics ----
   * Seven nodes that share the same shape: a single-pole envelope
   * detector (peak-style |in| → smoothed env via attack / release
   * coefficients) feeds a gain computer that produces a per-sample
   * gain factor based on threshold, ratio, and various extra
   * params. Each node bakes in its own gain-computer law:
   *   • Compressor — gain = (thresh + (env-thresh)/ratio) / env when env > thresh
   *   • Limiter    — brick wall: gain = thresh / env when env > thresh
   *   • Expander   — gain = (env/thresh)^(ratio-1) when env < thresh
   *   • NoiseGate  — hysteresis gate: open / hold / close with
   *                  separate attack/release on the gain envelope
   *   • Sidechain  — Compressor with the envelope reading from a
   *                  key input instead of in
   *   • Ducker     — Sidechain with a single `reduction` amount
   *                  (no ratio knob — fixed attenuation when key
   *                  exceeds threshold)
   *   • MultibandComp — three crossover-split bands, three
   *                  independent compressors, summed back. */

  Compressor: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaCompressor",
    helperClass:
`class GammaCompressor {
    /* Linear-amplitude compressor — env tracks |in| via a one-pole
     * smoother (attack on rise, release on fall). When env exceeds
     * threshold, the excess is reduced by ratio. Soft-knee math
     * skipped for compactness; the per-sample cost is one abs +
     * one compare + one divide on the gain path. makeup is a
     * post-gain multiplier the user dials in to compensate for
     * the dB lost to compression. */
    float env_ = 0.f;
    float thresh_ = 0.5f;
    float ratio_ = 4.f;
    float makeup_ = 1.f;
    float attackMs_ = 5.f, releaseMs_ = 80.f;
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
    void recalc_() {
        ka_ = 1.f - std::exp(-1.f / (attackMs_  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (releaseMs_ * sr_ * 0.001f));
    }
public:
    GammaCompressor() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc_();
    }
    void setThreshold(float t) { thresh_ = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setRatio(float r)     { ratio_ = (r < 1.f) ? 1.f : (r > 50.f ? 50.f : r); }
    void setAttack(float ms)   { attackMs_ = (ms < 0.05f) ? 0.05f : ms; recalc_(); }
    void setRelease(float ms)  { releaseMs_ = (ms < 1.f)  ? 1.f  : ms; recalc_(); }
    void setMakeup(float m)    { makeup_ = (m < 0.f) ? 0.f : (m > 8.f ? 8.f : m); }
    float operator()(float in) {
        const float a = (in < 0.f) ? -in : in;
        const float k = (a > env_) ? ka_ : kr_;
        env_ += k * (a - env_);
        float gain = 1.f;
        if (env_ > thresh_) {
            const float reduced = thresh_ + (env_ - thresh_) / ratio_;
            gain = reduced / env_;
        }
        return in * gain * makeup_;
    }
};`,
    ins: [
      { n: "in",        t: "audio" },
      { n: "threshold", t: "param" },
      { n: "ratio",     t: "param" },
      { n: "attack",    t: "param" },
      { n: "release",   t: "param" },
      { n: "makeup",    t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { threshold: 0.5, ratio: 4, attack: 5, release: 80, makeup: 1 },
    methods: { threshold: "setThreshold", ratio: "setRatio", attack: "setAttack", release: "setRelease", makeup: "setMakeup" },
    description: "Linear-amplitude compressor. threshold ∈ [0,1] (peak amplitude), ratio ≥ 1, attack/release in ms, makeup is post-gain. Above threshold, gain = (thresh + (env−thresh)/ratio)/env."
  },

  /* Limiter — brick-wall variant with very fast attack. Same
   * envelope detector + gain computer as Compressor but the
   * gain law is just (thresh / env) above threshold (effective
   * ratio = ∞:1). No lookahead — that would need a delay line
   * and two-pass compute; quality preview-grade limiting.
   * Default attack 1 ms, release 50 ms. */
  Limiter: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaLimiter",
    helperClass:
`class GammaLimiter {
    float env_ = 0.f;
    float thresh_ = 0.95f;
    float attackMs_ = 1.f, releaseMs_ = 50.f;
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
    void recalc_() {
        ka_ = 1.f - std::exp(-1.f / (attackMs_  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (releaseMs_ * sr_ * 0.001f));
    }
public:
    GammaLimiter() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc_();
    }
    void setThreshold(float t) { thresh_ = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setAttack(float ms)   { attackMs_ = (ms < 0.05f) ? 0.05f : ms; recalc_(); }
    void setRelease(float ms)  { releaseMs_ = (ms < 1.f)  ? 1.f  : ms; recalc_(); }
    float operator()(float in) {
        const float a = (in < 0.f) ? -in : in;
        const float k = (a > env_) ? ka_ : kr_;
        env_ += k * (a - env_);
        const float gain = (env_ > thresh_) ? (thresh_ / env_) : 1.f;
        return in * gain;
    }
};`,
    ins: [
      { n: "in",        t: "audio" },
      { n: "threshold", t: "param" },
      { n: "attack",    t: "param" },
      { n: "release",   t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { threshold: 0.95, attack: 1, release: 50 },
    methods: { threshold: "setThreshold", attack: "setAttack", release: "setRelease" },
    description: "Brick-wall peak limiter. ∞:1 ratio above threshold, fast attack (default 1 ms). Use on the master bus to catch overshoots without affecting the body of the signal. No lookahead — overshoots within one envelope-attack period may slip through."
  },

  /* Expander — inverse compressor. Below threshold, gain falls
   * off as `(env/thresh)^(ratio-1)`. ratio=1 → bypass. ratio→∞
   * approaches a hard gate (use NoiseGate for that explicit
   * shape). Useful for cleaning up the noise floor on quiet
   * passages without abrupt gating. */
  Expander: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaExpander",
    helperClass:
`class GammaExpander {
    float env_ = 0.f;
    float thresh_ = 0.1f;
    float ratio_ = 2.f;
    float attackMs_ = 5.f, releaseMs_ = 80.f;
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
    void recalc_() {
        ka_ = 1.f - std::exp(-1.f / (attackMs_  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (releaseMs_ * sr_ * 0.001f));
    }
public:
    GammaExpander() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc_();
    }
    void setThreshold(float t) { thresh_ = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setRatio(float r)     { ratio_ = (r < 1.f) ? 1.f : (r > 50.f ? 50.f : r); }
    void setAttack(float ms)   { attackMs_ = (ms < 0.05f) ? 0.05f : ms; recalc_(); }
    void setRelease(float ms)  { releaseMs_ = (ms < 1.f)  ? 1.f  : ms; recalc_(); }
    float operator()(float in) {
        const float a = (in < 0.f) ? -in : in;
        const float k = (a > env_) ? ka_ : kr_;
        env_ += k * (a - env_);
        float gain = 1.f;
        if (env_ < thresh_) {
            const float ratioBelow = env_ / thresh_;
            gain = std::pow((ratioBelow > 0.f) ? ratioBelow : 0.f, ratio_ - 1.f);
        }
        return in * gain;
    }
};`,
    ins: [
      { n: "in",        t: "audio" },
      { n: "threshold", t: "param" },
      { n: "ratio",     t: "param" },
      { n: "attack",    t: "param" },
      { n: "release",   t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { threshold: 0.1, ratio: 2, attack: 5, release: 80 },
    methods: { threshold: "setThreshold", ratio: "setRatio", attack: "setAttack", release: "setRelease" },
    description: "Downward expander — below threshold the signal is attenuated by the ratio. Smoother than NoiseGate (no hysteresis hard switching). Useful for low-noise tails and quiet passages."
  },

  /* NoiseGate — hard gate with hysteresis (open and close at
   * different thresholds so the gate doesn't chatter on
   * transients near the threshold) and configurable hold time
   * (gate stays open `hold` ms after the signal falls below
   * close-threshold, so quick gaps in speech don't chop the
   * tail). The gain itself is smoothed via attack/release so
   * there's no clicking on transitions. */
  NoiseGate: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaNoiseGate",
    helperClass:
`class GammaNoiseGate {
    float env_ = 0.f;
    float openThresh_ = 0.1f;
    float closeThresh_ = 0.07f;     // 70% of open — hysteresis
    float gain_ = 0.f;              // current smoothed gain
    float attackMs_ = 1.f, releaseMs_ = 100.f;
    float holdMs_ = 50.f;
    int   holdSamples_ = 0;
    bool  open_ = false;
    float ka_ = 1.f, kr_ = 1.f;
    float kaEnv_ = 1.f, krEnv_ = 1.f;
    float sr_ = 48000.f;
    void recalc_() {
        ka_   = 1.f - std::exp(-1.f / (attackMs_  * sr_ * 0.001f));
        kr_   = 1.f - std::exp(-1.f / (releaseMs_ * sr_ * 0.001f));
        kaEnv_ = 1.f - std::exp(-1.f / (3.f  * sr_ * 0.001f));   // 3ms env attack
        krEnv_ = 1.f - std::exp(-1.f / (30.f * sr_ * 0.001f));   // 30ms env release
    }
public:
    GammaNoiseGate() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc_();
    }
    void setThreshold(float t) {
        openThresh_  = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t);
        closeThresh_ = openThresh_ * 0.7f;     // 30% hysteresis
    }
    void setAttack(float ms)  { attackMs_ = (ms < 0.05f) ? 0.05f : ms; recalc_(); }
    void setRelease(float ms) { releaseMs_ = (ms < 1.f)  ? 1.f  : ms; recalc_(); }
    void setHold(float ms)    { holdMs_ = (ms < 0.f) ? 0.f : ms; }
    float operator()(float in) {
        const float a = (in < 0.f) ? -in : in;
        const float kE = (a > env_) ? kaEnv_ : krEnv_;
        env_ += kE * (a - env_);
        // Hysteresis state machine
        if (open_) {
            if (env_ < closeThresh_) {
                if (holdSamples_ > 0) holdSamples_--;
                else open_ = false;
            } else {
                holdSamples_ = (int)(holdMs_ * sr_ * 0.001f);
            }
        } else if (env_ > openThresh_) {
            open_ = true;
            holdSamples_ = (int)(holdMs_ * sr_ * 0.001f);
        }
        // Smooth target gain so transitions don't click
        const float target = open_ ? 1.f : 0.f;
        const float k = (target > gain_) ? ka_ : kr_;
        gain_ += k * (target - gain_);
        return in * gain_;
    }
};`,
    ins: [
      { n: "in",        t: "audio" },
      { n: "threshold", t: "param" },
      { n: "attack",    t: "param" },
      { n: "release",   t: "param" },
      { n: "hold",      t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { threshold: 0.1, attack: 1, release: 100, hold: 50 },
    methods: { threshold: "setThreshold", attack: "setAttack", release: "setRelease", hold: "setHold" },
    description: "Hard gate with hysteresis. Opens at threshold, closes at 70% of threshold (no chatter). hold = how long the gate stays open after the signal drops; attack/release smooth the gain transitions. Use on mics to remove room tone between phrases."
  },

  /* Sidechain — Compressor with a separate key input. Wire
   * audio you want compressed into `in`, the trigger signal
   * (e.g. kick drum bus) into `key`. The detector reads from
   * key, the gain is applied to in. Same gain-computer law as
   * Compressor; just a different signal goes into the
   * envelope detector. */
  Sidechain: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaSidechain",
    helperClass:
`class GammaSidechain {
    float env_ = 0.f, key_ = 0.f;
    float thresh_ = 0.4f, ratio_ = 4.f, makeup_ = 1.f;
    float attackMs_ = 5.f, releaseMs_ = 80.f;
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
    void recalc_() {
        ka_ = 1.f - std::exp(-1.f / (attackMs_  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (releaseMs_ * sr_ * 0.001f));
    }
public:
    GammaSidechain() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc_();
    }
    void setKey(float v)       { key_ = v; }
    void setThreshold(float t) { thresh_ = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setRatio(float r)     { ratio_ = (r < 1.f) ? 1.f : (r > 50.f ? 50.f : r); }
    void setAttack(float ms)   { attackMs_ = (ms < 0.05f) ? 0.05f : ms; recalc_(); }
    void setRelease(float ms)  { releaseMs_ = (ms < 1.f)  ? 1.f  : ms; recalc_(); }
    void setMakeup(float m)    { makeup_ = (m < 0.f) ? 0.f : (m > 8.f ? 8.f : m); }
    float operator()(float in) {
        // Envelope tracks the key input, NOT in.
        const float a = (key_ < 0.f) ? -key_ : key_;
        const float k = (a > env_) ? ka_ : kr_;
        env_ += k * (a - env_);
        float gain = 1.f;
        if (env_ > thresh_) {
            const float reduced = thresh_ + (env_ - thresh_) / ratio_;
            gain = reduced / env_;
        }
        return in * gain * makeup_;
    }
};`,
    ins: [
      { n: "in",        t: "audio" },
      { n: "key",       t: "audio" },
      { n: "threshold", t: "param" },
      { n: "ratio",     t: "param" },
      { n: "attack",    t: "param" },
      { n: "release",   t: "param" },
      { n: "makeup",    t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { threshold: 0.4, ratio: 4, attack: 5, release: 80, makeup: 1 },
    methods: { key: "setKey", threshold: "setThreshold", ratio: "setRatio", attack: "setAttack", release: "setRelease", makeup: "setMakeup" },
    description: "Sidechain compressor. Audio in `in` is compressed by the envelope of `key`. Classic use: pad audio in `in`, kick bus in `key`, ratio 4 + 5 ms attack / 100 ms release for the EDM 'pumping' effect."
  },

  /* Ducker — simpler sidechain variant. Instead of a ratio knob,
   * just a `reduction` ∈ [0,1] that's the maximum attenuation
   * applied when the key signal is well above threshold. The
   * attenuation scales linearly between threshold and full-scale
   * key. Good fit for "dim the music when the announcement
   * comes in" — radio voiceover, in-game dialog mix. */
  Ducker: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaDucker",
    helperClass:
`class GammaDucker {
    float env_ = 0.f, key_ = 0.f;
    float thresh_ = 0.3f;
    float reduction_ = 0.5f;
    float attackMs_ = 10.f, releaseMs_ = 200.f;
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
    void recalc_() {
        ka_ = 1.f - std::exp(-1.f / (attackMs_  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (releaseMs_ * sr_ * 0.001f));
    }
public:
    GammaDucker() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc_();
    }
    void setKey(float v)        { key_ = v; }
    void setThreshold(float t)  { thresh_ = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setReduction(float r)  { reduction_ = (r < 0.f) ? 0.f : (r > 1.f ? 1.f : r); }
    void setAttack(float ms)    { attackMs_ = (ms < 0.05f) ? 0.05f : ms; recalc_(); }
    void setRelease(float ms)   { releaseMs_ = (ms < 1.f)  ? 1.f  : ms; recalc_(); }
    float operator()(float in) {
        const float a = (key_ < 0.f) ? -key_ : key_;
        const float k = (a > env_) ? ka_ : kr_;
        env_ += k * (a - env_);
        float gain = 1.f;
        if (env_ > thresh_) {
            const float overshoot = (env_ - thresh_) / (1.f - thresh_);
            const float clamped = (overshoot > 1.f) ? 1.f : ((overshoot < 0.f) ? 0.f : overshoot);
            gain = 1.f - clamped * reduction_;
        }
        return in * gain;
    }
};`,
    ins: [
      { n: "in",        t: "audio" },
      { n: "key",       t: "audio" },
      { n: "threshold", t: "param" },
      { n: "reduction", t: "param" },
      { n: "attack",    t: "param" },
      { n: "release",   t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { threshold: 0.3, reduction: 0.5, attack: 10, release: 200 },
    methods: { key: "setKey", threshold: "setThreshold", reduction: "setReduction", attack: "setAttack", release: "setRelease" },
    description: "Ducker — auto-attenuates `in` when `key` exceeds threshold. reduction ∈ [0,1] is the maximum attenuation amount (0=bypass, 1=mute). Smoother attack/release than Sidechain by default. Use for voice-over-music ducking."
  },

  /* MultibandComp — split into 3 bands via Biquad LP/HP at user-
   * configurable crossover frequencies; compress each band with
   * its own threshold + ratio; sum back. Each band has its own
   * envelope detector (3 ms attack / 50 ms release — fixed for
   * compactness). All three thresholds + ratios + makeup gains
   * are exposed; per-band attack/release would explode the
   * param count, can be a follow-up. */
  MultibandComp: {
    category: "Effect", color: COLOR.effect, header: "Filter",
    extraHeaders: ["<cmath>"],
    cppType: "GammaMultibandComp",
    helperClass:
`class GammaMultibandComp {
    /* Three-band crossover (LR-style 12 dB/oct via cascaded
     * Biquads — not phase-perfect but cheap and audibly fine).
     * Each band has its own envelope + gain computer + makeup.
     * Bands sum to recover the original spectrum at unity gain
     * with zero compression on every band. */
    gam::Biquad<> lowLP_, midHP_, midLP_, highHP_;
    float env_[3] = { 0.f, 0.f, 0.f };
    float thresh_[3] = { 0.5f, 0.5f, 0.5f };
    float ratio_[3]  = { 4.f, 4.f, 4.f };
    float makeup_[3] = { 1.f, 1.f, 1.f };
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
public:
    GammaMultibandComp() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        lowLP_.type(gam::LOW_PASS);   lowLP_.freq(200.f);
        midHP_.type(gam::HIGH_PASS);  midHP_.freq(200.f);
        midLP_.type(gam::LOW_PASS);   midLP_.freq(2000.f);
        highHP_.type(gam::HIGH_PASS); highHP_.freq(2000.f);
        ka_ = 1.f - std::exp(-1.f / (3.f  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (50.f * sr_ * 0.001f));
    }
    void setLowFreq(float f)  { lowLP_.freq(f); midHP_.freq(f); }
    void setHighFreq(float f) { midLP_.freq(f); highHP_.freq(f); }
    void setLowThresh(float t)  { thresh_[0] = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setMidThresh(float t)  { thresh_[1] = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setHighThresh(float t) { thresh_[2] = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setLowRatio(float r)   { ratio_[0] = (r < 1.f) ? 1.f : (r > 50.f ? 50.f : r); }
    void setMidRatio(float r)   { ratio_[1] = (r < 1.f) ? 1.f : (r > 50.f ? 50.f : r); }
    void setHighRatio(float r)  { ratio_[2] = (r < 1.f) ? 1.f : (r > 50.f ? 50.f : r); }
    void setLowMakeup(float m)  { makeup_[0] = (m < 0.f) ? 0.f : (m > 8.f ? 8.f : m); }
    void setMidMakeup(float m)  { makeup_[1] = (m < 0.f) ? 0.f : (m > 8.f ? 8.f : m); }
    void setHighMakeup(float m) { makeup_[2] = (m < 0.f) ? 0.f : (m > 8.f ? 8.f : m); }
    float compressBand_(int b, float bandIn) {
        const float a = (bandIn < 0.f) ? -bandIn : bandIn;
        const float k = (a > env_[b]) ? ka_ : kr_;
        env_[b] += k * (a - env_[b]);
        float gain = 1.f;
        if (env_[b] > thresh_[b]) {
            const float reduced = thresh_[b] + (env_[b] - thresh_[b]) / ratio_[b];
            gain = reduced / env_[b];
        }
        return bandIn * gain * makeup_[b];
    }
    float operator()(float in) {
        // Split. midLP/midHP are cascaded so the mid band is
        // bandpassed through the two crossovers.
        const float low  = lowLP_(in);
        const float midHi = midHP_(in);   // > low cutoff
        const float mid   = midLP_(midHi); // also < high cutoff = mid band
        const float high  = highHP_(in);   // > high cutoff
        return compressBand_(0, low) + compressBand_(1, mid) + compressBand_(2, high);
    }
};`,
    ins: [
      { n: "in",         t: "audio" },
      { n: "lowFreq",    t: "param" },
      { n: "highFreq",   t: "param" },
      { n: "lowThresh",  t: "param" },
      { n: "midThresh",  t: "param" },
      { n: "highThresh", t: "param" },
      { n: "lowRatio",   t: "param" },
      { n: "midRatio",   t: "param" },
      { n: "highRatio",  t: "param" },
      { n: "lowMakeup",  t: "param" },
      { n: "midMakeup",  t: "param" },
      { n: "highMakeup", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { lowFreq: 200, highFreq: 2000, lowThresh: 0.5, midThresh: 0.5, highThresh: 0.5, lowRatio: 4, midRatio: 4, highRatio: 4, lowMakeup: 1, midMakeup: 1, highMakeup: 1 },
    methods: {
      lowFreq: "setLowFreq", highFreq: "setHighFreq",
      lowThresh: "setLowThresh", midThresh: "setMidThresh", highThresh: "setHighThresh",
      lowRatio: "setLowRatio",   midRatio: "setMidRatio",   highRatio: "setHighRatio",
      lowMakeup: "setLowMakeup", midMakeup: "setMidMakeup", highMakeup: "setHighMakeup"
    },
    description: "3-band compressor. Splits at lowFreq + highFreq via Biquad LP/HP crossovers; each band has its own threshold / ratio / makeup. Useful for separately controlling bass body, midrange punch, and high-end air on a master bus or program material."
  },

  /* UpwardComp — pulls *quiet* signals up toward threshold rather than
   * pushing peaks down. Useful for raising sustain tails on a piano,
   * thickening room ambience, lifting reverb decays, or "clarifying"
   * vocals without squashing transients. Gain law in dB:
   *   out_dB = thresh_dB - (thresh_dB - in_dB) / ratio   (when in < thresh)
   *   out_dB = in_dB                                     (when in ≥ thresh)
   * In linear amplitude that's gain = (thresh/env)^((ratio-1)/ratio).
   * Capped at 50× (≈ 34 dB) so a near-zero env doesn't blow up. */
  UpwardComp: {
    category: "Effect", color: COLOR.effect, header: null,
    extraHeaders: ["<cmath>"],
    cppType: "GammaUpwardComp",
    helperClass:
`class GammaUpwardComp {
    float env_ = 0.f;
    float thresh_ = 0.1f;
    float ratio_ = 2.f;
    float makeup_ = 1.f;
    float attackMs_ = 5.f, releaseMs_ = 80.f;
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
    static constexpr float maxGain_ = 50.f;
    void recalc_() {
        ka_ = 1.f - std::exp(-1.f / (attackMs_  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (releaseMs_ * sr_ * 0.001f));
    }
public:
    GammaUpwardComp() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        recalc_();
    }
    void setThreshold(float t) { thresh_ = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setRatio(float r)     { ratio_ = (r < 1.f) ? 1.f : (r > 50.f ? 50.f : r); }
    void setAttack(float ms)   { attackMs_ = (ms < 0.05f) ? 0.05f : ms; recalc_(); }
    void setRelease(float ms)  { releaseMs_ = (ms < 1.f)  ? 1.f  : ms; recalc_(); }
    void setMakeup(float m)    { makeup_ = (m < 0.f) ? 0.f : (m > 8.f ? 8.f : m); }
    float operator()(float in) {
        const float a = (in < 0.f) ? -in : in;
        const float k = (a > env_) ? ka_ : kr_;
        env_ += k * (a - env_);
        float gain = 1.f;
        if (env_ < thresh_ && env_ > 1e-6f) {
            // Pull quiet signals up. exponent = (ratio-1)/ratio so at
            // ratio=∞ this approaches gain = thresh/env (full upward
            // limit), at ratio=1 it approaches 1× (no boost).
            const float exponent = (ratio_ - 1.f) / ratio_;
            gain = std::pow(thresh_ / env_, exponent);
            if (gain > maxGain_) gain = maxGain_;
        }
        return in * gain * makeup_;
    }
};`,
    ins: [
      { n: "in",        t: "audio" },
      { n: "threshold", t: "param" },
      { n: "ratio",     t: "param" },
      { n: "attack",    t: "param" },
      { n: "release",   t: "param" },
      { n: "makeup",    t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { threshold: 0.1, ratio: 2, attack: 5, release: 80, makeup: 1 },
    methods: { threshold: "setThreshold", ratio: "setRatio", attack: "setAttack", release: "setRelease", makeup: "setMakeup" },
    description: "Upward compressor — boosts quiet signals (env < threshold) toward the threshold by ratio. Above threshold the signal passes through unchanged. Boost is capped at 50× (~34 dB). Use for thickening sustain, raising tails, parallel-compression-style detail lift."
  },

  /* OTT — "Over The Top". 3-band parallel up+down compression with
   * a single Depth knob, modeled on Xfer's plugin (a fixture in
   * EDM/dubstep mastering and sound design). Each band runs through
   * a downward compressor (squashes peaks at thresh ≥ ~0.5) followed
   * by an upward compressor (lifts quiet tails at thresh ≤ ~0.1).
   * The signature aggressive character comes from doing *both* on
   * three independently-EQ'd bands at fast time constants.
   *
   * Depth (0..1) crossfades the entire wet processed signal against
   * dry — it's the one knob the user actually rides. Per-band thresh
   * up/down + per-band makeup let you sculpt the response; ratios
   * are fixed internally at 3:1 (classic OTT) to keep the param
   * count manageable. Crossover defaults match MultibandComp
   * (200 Hz / 2 kHz). */
  OTT: {
    category: "Effect", color: COLOR.effect, header: "Filter",
    extraHeaders: ["<cmath>"],
    cppType: "GammaOTT",
    helperClass:
`class GammaOTT {
    gam::Biquad<> lowLP_, midHP_, midLP_, highHP_;
    float envD_[3] = { 0.f, 0.f, 0.f };
    float envU_[3] = { 0.f, 0.f, 0.f };
    float threshD_[3] = { 0.5f, 0.5f, 0.5f };
    float threshU_[3] = { 0.1f, 0.1f, 0.1f };
    float makeup_[3]  = { 1.f, 1.f, 1.f };
    float depth_ = 1.f;
    float ka_ = 1.f, kr_ = 1.f;
    float sr_ = 48000.f;
    static constexpr float ratioD_ = 3.f;
    static constexpr float ratioU_ = 3.f;
    static constexpr float upExp_  = (ratioU_ - 1.f) / ratioU_;
    static constexpr float maxUpGain_ = 50.f;
public:
    GammaOTT() {
        const float sr = (float)gam::sampleRate();
        if (sr > 1.f) sr_ = sr;
        lowLP_.type(gam::LOW_PASS);   lowLP_.freq(200.f);
        midHP_.type(gam::HIGH_PASS);  midHP_.freq(200.f);
        midLP_.type(gam::LOW_PASS);   midLP_.freq(2000.f);
        highHP_.type(gam::HIGH_PASS); highHP_.freq(2000.f);
        // Faster envelope than MultibandComp — OTT is supposed to grab
        // transients aggressively (3 ms attack / 50 ms release).
        ka_ = 1.f - std::exp(-1.f / (3.f  * sr_ * 0.001f));
        kr_ = 1.f - std::exp(-1.f / (50.f * sr_ * 0.001f));
    }
    void setLowFreq(float f)      { lowLP_.freq(f); midHP_.freq(f); }
    void setHighFreq(float f)     { midLP_.freq(f); highHP_.freq(f); }
    void setDepth(float d)        { depth_ = (d < 0.f) ? 0.f : (d > 1.f ? 1.f : d); }
    void setLowThreshD(float t)   { threshD_[0] = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setMidThreshD(float t)   { threshD_[1] = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setHighThreshD(float t)  { threshD_[2] = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setLowThreshU(float t)   { threshU_[0] = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setMidThreshU(float t)   { threshU_[1] = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setHighThreshU(float t)  { threshU_[2] = (t < 0.001f) ? 0.001f : (t > 1.f ? 1.f : t); }
    void setLowMakeup(float m)    { makeup_[0] = (m < 0.f) ? 0.f : (m > 8.f ? 8.f : m); }
    void setMidMakeup(float m)    { makeup_[1] = (m < 0.f) ? 0.f : (m > 8.f ? 8.f : m); }
    void setHighMakeup(float m)   { makeup_[2] = (m < 0.f) ? 0.f : (m > 8.f ? 8.f : m); }
    float processBand_(int b, float bandIn) {
        // Downward stage — env tracks |in|, gain reduces above thresh.
        const float a = (bandIn < 0.f) ? -bandIn : bandIn;
        const float k = (a > envD_[b]) ? ka_ : kr_;
        envD_[b] += k * (a - envD_[b]);
        float gainD = 1.f;
        if (envD_[b] > threshD_[b]) {
            const float reduced = threshD_[b] + (envD_[b] - threshD_[b]) / ratioD_;
            gainD = reduced / envD_[b];
        }
        const float postDown = bandIn * gainD;
        // Upward stage — env recomputed on the post-down signal so the
        // upward thresh references the already-squashed level.
        const float aU = (postDown < 0.f) ? -postDown : postDown;
        const float kU = (aU > envU_[b]) ? ka_ : kr_;
        envU_[b] += kU * (aU - envU_[b]);
        float gainU = 1.f;
        if (envU_[b] < threshU_[b] && envU_[b] > 1e-6f) {
            gainU = std::pow(threshU_[b] / envU_[b], upExp_);
            if (gainU > maxUpGain_) gainU = maxUpGain_;
        }
        return postDown * gainU * makeup_[b];
    }
    float operator()(float in) {
        const float low   = lowLP_(in);
        const float midHi = midHP_(in);
        const float mid   = midLP_(midHi);
        const float high  = highHP_(in);
        const float wet =
            processBand_(0, low) +
            processBand_(1, mid) +
            processBand_(2, high);
        // Global dry/wet — depth=0 returns the original input untouched
        // (perfect bypass), depth=1 returns full processed signal.
        return in + depth_ * (wet - in);
    }
};`,
    ins: [
      { n: "in",         t: "audio" },
      { n: "depth",      t: "param" },
      { n: "lowFreq",    t: "param" },
      { n: "highFreq",   t: "param" },
      { n: "lowThreshD",  t: "param" },
      { n: "midThreshD",  t: "param" },
      { n: "highThreshD", t: "param" },
      { n: "lowThreshU",  t: "param" },
      { n: "midThreshU",  t: "param" },
      { n: "highThreshU", t: "param" },
      { n: "lowMakeup",  t: "param" },
      { n: "midMakeup",  t: "param" },
      { n: "highMakeup", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: {
      depth: 1, lowFreq: 200, highFreq: 2000,
      lowThreshD: 0.5, midThreshD: 0.5, highThreshD: 0.5,
      lowThreshU: 0.1, midThreshU: 0.1, highThreshU: 0.1,
      lowMakeup: 1, midMakeup: 1, highMakeup: 1
    },
    methods: {
      depth: "setDepth",
      lowFreq: "setLowFreq", highFreq: "setHighFreq",
      lowThreshD: "setLowThreshD", midThreshD: "setMidThreshD", highThreshD: "setHighThreshD",
      lowThreshU: "setLowThreshU", midThreshU: "setMidThreshU", highThreshU: "setHighThreshU",
      lowMakeup: "setLowMakeup",   midMakeup: "setMidMakeup",   highMakeup: "setHighMakeup"
    },
    description: "OTT-style 3-band parallel up+down compressor. Each band: downward comp (3:1) → upward comp (3:1). depth crossfades dry/wet (0=bypass, 1=full). threshD = downward threshold (squashes peaks), threshU = upward threshold (lifts tails). Aggressive program-material processor — drums, bass, full mixes."
  },

  /* ---- Analysis (Analysis.h) ---- */
  EnvFollow: {
    category: "Analysis", color: COLOR.analysis, header: "Analysis",
    cppType: "gam::EnvFollow<>",
    ins: [{n:"in", t:"audio"}, {n:"freq", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { freq: 10 },
    methods: { freq: "lag" },
    description: "Envelope follower (lowpassed magnitude)"
  },
  ZeroCross: {
    category: "Analysis", color: COLOR.analysis, header: "Analysis",
    cppType: "gam::ZeroCross<>",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    description: "Counts zero crossings (rough freq estimator)"
  },

  /* ---- Conversion (scl::, inline functions) ---- */
  /* Inline math — `gam::scl::mtof` / `ftom` aren't actually in
   * Gamma (only the dB-conversion helpers are). The standard
   * MIDI conversion is two lines of cmath; emit it directly. */
  MtoF: {
    category: "Convert", color: COLOR.convert, header: "cmath",
    cppType: "",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    template: "(440.f * powf(2.f, ({in} - 69.f) / 12.f))",
    description: "MIDI note → frequency (Hz). 69 = A4 = 440 Hz reference."
  },
  FtoM: {
    category: "Convert", color: COLOR.convert, header: "cmath",
    cppType: "",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    template: "(69.f + 12.f * log2f({in} / 440.f))",
    description: "Frequency (Hz) → MIDI note. Inverse of MtoF."
  },
  DBtoA: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    template: "gam::scl::dBToAmp({in})",
    description: "Decibels → linear amplitude"
  },
  AtoDB: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    template: "gam::scl::ampTodB({in})",
    description: "Linear amplitude → decibels"
  },

  /* ---- Math (inline expressions) ---- */
  Mul: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "",
    ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    template: "({a} * {b})",
    description: "Multiply two signals"
  },
  Add: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "",
    ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    template: "({a} + {b})",
    description: "Sum two signals"
  },
  Sub: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "",
    ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    template: "({a} - {b})",
    description: "Subtract b from a"
  },
  Neg: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    template: "(-{in})",
    description: "Invert sign"
  },
  Abs: {
    category: "Math", color: COLOR.math, header: "scl",
    cppType: "",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: {},
    template: "gam::scl::abs({in})",
    description: "Absolute value"
  },
  Const: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "",
    ins: [],
    outs: [{n:"out", t:"audio"}],
    params: { value: 1 },
    template: "{value}",
    description: "Constant value"
  },
  Clip: {
    category: "Math", color: COLOR.math, header: "scl",
    cppType: "",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: { min: -1, max: 1 },
    template: "gam::scl::clip({in}, {max}, {min})",
    description: "Clamp to [min, max]"
  },
  Scale: {
    category: "Math", color: COLOR.math, header: "scl",
    cppType: "",
    ins: [{n:"in", t:"audio"}],
    outs: [{n:"out", t:"audio"}],
    params: { inMin: -1, inMax: 1, outMin: 0, outMax: 1 },
    template: "(({in} - {inMin}) / ({inMax} - {inMin}) * ({outMax} - {outMin}) + {outMin})",
    description: "Linear remap from [inMin,inMax] to [outMin,outMax]"
  },
  Mix: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "",
    ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}, {n:"mix", t:"param"}],
    outs: [{n:"out", t:"audio"}],
    params: { mix: 0.5 },
    template: "({a} + (({b}) - ({a})) * {mix})",
    description: "Crossfade: a when mix=0, b when mix=1"
  },

  /* ---- Routing / Mixing primitives ----
   * PatchMatrix is the swiss-army router; VCA / AudioBus / MasterMix
   * are the building blocks of a typical mixer topology (per-voice
   * gain → submix → master). Each uses noSigArg + setter codegen for
   * its multiple audio inputs (see prepareSample's "Audio-input setter
   * codegen" pass), so they don't need template-style inlining. */

  /* 8×8 audio routing/mixing matrix. Each cell holds a gain — output[j]
   * is the sum over i of input[i] × gain[i][j]. Click cells in the
   * matrix editor to toggle 0↔1, drag vertically for finer levels.
   * Used as a swiss-army router for sends, submixes, or cross-modulation. */
  PatchMatrix: {
    category: "Convert", color: COLOR.convert, header: null,
    cppType: "GammaPatchMatrix",
    helperClass:
`class GammaPatchMatrix {
    static constexpr int N = 8;
    float in_[N]    = {0,0,0,0,0,0,0,0};
    float gain_[N][N];
public:
    GammaPatchMatrix() {
        for (int i = 0; i < N; i++) for (int j = 0; j < N; j++) gain_[i][j] = 0.f;
    }
    void setIn0(float v) { in_[0] = v; }
    void setIn1(float v) { in_[1] = v; }
    void setIn2(float v) { in_[2] = v; }
    void setIn3(float v) { in_[3] = v; }
    void setIn4(float v) { in_[4] = v; }
    void setIn5(float v) { in_[5] = v; }
    void setIn6(float v) { in_[6] = v; }
    void setIn7(float v) { in_[7] = v; }
    void setGain(float i, float j, float g) {
        int ii = (int)i, jj = (int)j;
        if (ii >= 0 && ii < N && jj >= 0 && jj < N) gain_[ii][jj] = g;
    }
    struct Out { float v[N]; };
    Out operator()() {
        Out o;
        for (int j = 0; j < N; j++) {
            float s = 0.f;
            for (int i = 0; i < N; i++) s += in_[i] * gain_[i][j];
            o.v[j] = s;
        }
        return o;
    }
};`,
    ins: [
      { n: "in1", t: "audio" }, { n: "in2", t: "audio" },
      { n: "in3", t: "audio" }, { n: "in4", t: "audio" },
      { n: "in5", t: "audio" }, { n: "in6", t: "audio" },
      { n: "in7", t: "audio" }, { n: "in8", t: "audio" }
    ],
    outs: [
      { n: "out1", t: "audio", access: ".v[0]" },
      { n: "out2", t: "audio", access: ".v[1]" },
      { n: "out3", t: "audio", access: ".v[2]" },
      { n: "out4", t: "audio", access: ".v[3]" },
      { n: "out5", t: "audio", access: ".v[4]" },
      { n: "out6", t: "audio", access: ".v[5]" },
      { n: "out7", t: "audio", access: ".v[6]" },
      { n: "out8", t: "audio", access: ".v[7]" }
    ],
    params: {
      matrix: [
        [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0]
      ]
    },
    methods: {
      in1: "setIn0", in2: "setIn1", in3: "setIn2", in4: "setIn3",
      in5: "setIn4", in6: "setIn5", in7: "setIn6", in8: "setIn7"
    },
    uiOnlyParams: ["matrix"],
    kind: "patchMatrix",
    noSigArg: true,
    extraCtor: [
      (n) => {
        const m = (n.params && Array.isArray(n.params.matrix)) ? n.params.matrix : [];
        const lines = [];
        for (let i = 0; i < 8; i++) {
          const row = Array.isArray(m[i]) ? m[i] : [];
          for (let j = 0; j < 8; j++) {
            const g = Number(row[j]) || 0;
            if (g === 0) continue;
            lines.push(`        ${n.id}.setGain(${i}.f, ${j}.f, ${g.toFixed(4)}f);`);
          }
        }
        return lines.length ? lines.join("\n") : null;
      }
    ],
    description: "8×8 audio routing matrix. output[j] = Σᵢ input[i] × gain[i][j]. Click cells to toggle 0↔1, drag vertically for finer levels (-1..+1). Useful as a swiss-army router for sends, submixes, or cross-modulation."
  },

  /* Voltage-Controlled Amplifier — audio in × gain → audio out. The
   * gain input accepts CV (audio-rate or param-rate) so envelopes,
   * LFOs, or any modulator can drive amplitude. Slider sets the
   * static value; CV input replaces it sample-by-sample if wired. */
  VCA: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "GammaVCA",
    helperClass:
`class GammaVCA {
    float gain_ = 1.f;
public:
    void setGain(float g) { gain_ = g; }
    float operator()(float in) { return in * gain_; }
};`,
    ins: [
      { n: "in",   t: "audio" },
      { n: "gain", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { gain: 1.0 },
    methods: { gain: "setGain" },
    autoExpose: ["gain"],
    description: "Voltage-controlled amplifier — audio × gain → audio. Slider sets gain (0..1+); wire any audio/param/env into `gain` for sample-rate amplitude modulation. Same effect as Mul + Slider in one node."
  },

  /* 4-input audio bus — sums four inputs with per-input level sliders.
   * Use as a submix (e.g. drum bus, pad bus) before the master mix.
   * Levels are param-rate so you can wire envelopes / LFOs into them. */
  AudioBus: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "GammaAudioBus",
    helperClass:
`class GammaAudioBus {
    float in_[4]  = {0,0,0,0};
    float lvl_[4] = {1.f, 1.f, 1.f, 1.f};
public:
    void setIn0(float v) { in_[0] = v; }
    void setIn1(float v) { in_[1] = v; }
    void setIn2(float v) { in_[2] = v; }
    void setIn3(float v) { in_[3] = v; }
    void setLevel0(float v) { lvl_[0] = v; }
    void setLevel1(float v) { lvl_[1] = v; }
    void setLevel2(float v) { lvl_[2] = v; }
    void setLevel3(float v) { lvl_[3] = v; }
    float operator()() {
        return in_[0]*lvl_[0] + in_[1]*lvl_[1] + in_[2]*lvl_[2] + in_[3]*lvl_[3];
    }
};`,
    ins: [
      { n: "in1", t: "audio" }, { n: "in2", t: "audio" },
      { n: "in3", t: "audio" }, { n: "in4", t: "audio" },
      { n: "lvl1", t: "param" }, { n: "lvl2", t: "param" },
      { n: "lvl3", t: "param" }, { n: "lvl4", t: "param" }
    ],
    outs: [{ n: "out", t: "audio" }],
    params: { lvl1: 1.0, lvl2: 1.0, lvl3: 1.0, lvl4: 1.0 },
    methods: {
      in1: "setIn0", in2: "setIn1", in3: "setIn2", in4: "setIn3",
      lvl1: "setLevel0", lvl2: "setLevel1", lvl3: "setLevel2", lvl4: "setLevel3"
    },
    noSigArg: true,
    autoExpose: ["lvl1", "lvl2", "lvl3", "lvl4"],
    description: "4-channel audio bus — sums four inputs with per-channel level sliders. Use as a submix before the master mix. Levels are sample-rate so envelopes/LFOs can modulate them."
  },

  /* Master mix — final stereo summing node. 4 channels with per-
   * channel level + pan (0=L, 1=R), plus a master volume slider.
   * Outputs L/R for OutputStereo. The "main bus" of the patch. */
  MasterMix: {
    category: "Math", color: COLOR.math, header: null,
    cppType: "GammaMasterMix",
    helperClass:
`class GammaMasterMix {
    float in_[4]  = {0,0,0,0};
    float lvl_[4] = {1.f, 1.f, 1.f, 1.f};
    float pan_[4] = {0.5f, 0.5f, 0.5f, 0.5f};
    float master_ = 1.f;
public:
    struct Out { float l, r; };
    void setIn0(float v) { in_[0] = v; }
    void setIn1(float v) { in_[1] = v; }
    void setIn2(float v) { in_[2] = v; }
    void setIn3(float v) { in_[3] = v; }
    void setLevel0(float v) { lvl_[0] = v; }
    void setLevel1(float v) { lvl_[1] = v; }
    void setLevel2(float v) { lvl_[2] = v; }
    void setLevel3(float v) { lvl_[3] = v; }
    void setPan0(float v)   { pan_[0] = v; }
    void setPan1(float v)   { pan_[1] = v; }
    void setPan2(float v)   { pan_[2] = v; }
    void setPan3(float v)   { pan_[3] = v; }
    void setMaster(float v) { master_ = v; }
    Out operator()() {
        Out o = { 0.f, 0.f };
        for (int i = 0; i < 4; i++) {
            const float s = in_[i] * lvl_[i];
            const float p = pan_[i];
            o.l += s * (1.f - p);
            o.r += s * p;
        }
        o.l *= master_;
        o.r *= master_;
        return o;
    }
};`,
    ins: [
      { n: "in1", t: "audio" }, { n: "in2", t: "audio" },
      { n: "in3", t: "audio" }, { n: "in4", t: "audio" },
      { n: "lvl1", t: "param" }, { n: "lvl2", t: "param" },
      { n: "lvl3", t: "param" }, { n: "lvl4", t: "param" },
      { n: "pan1", t: "param" }, { n: "pan2", t: "param" },
      { n: "pan3", t: "param" }, { n: "pan4", t: "param" },
      { n: "master", t: "param" }
    ],
    outs: [
      { n: "L", t: "audio", access: ".l" },
      { n: "R", t: "audio", access: ".r" }
    ],
    params: {
      lvl1: 1.0, lvl2: 1.0, lvl3: 1.0, lvl4: 1.0,
      pan1: 0.5, pan2: 0.5, pan3: 0.5, pan4: 0.5,
      master: 1.0
    },
    methods: {
      in1: "setIn0", in2: "setIn1", in3: "setIn2", in4: "setIn3",
      lvl1: "setLevel0", lvl2: "setLevel1", lvl3: "setLevel2", lvl4: "setLevel3",
      pan1: "setPan0", pan2: "setPan1", pan3: "setPan2", pan4: "setPan3",
      master: "setMaster"
    },
    noSigArg: true,
    autoExpose: ["lvl1", "lvl2", "lvl3", "lvl4", "pan1", "pan2", "pan3", "pan4", "master"],
    description: "Master mixer — 4 stereo-summed channels with per-channel level + pan (0=L, 1=R), master volume. Outputs L/R for OutputStereo. The 'main bus' of the patch."
  },

  /* ---- Sinks ---- */
  Output: {
    category: "Sink", color: COLOR.sink, header: null,
    cppType: "",
    ins: [{n:"L", t:"audio"}],
    outs: [],
    params: {},
    description: "Mono output"
  },
  OutputStereo: {
    category: "Sink", color: COLOR.sink, header: null,
    cppType: "",
    ins: [{n:"L", t:"audio"}, {n:"R", t:"audio"}],
    outs: [],
    params: {},
    description: "Stereo output (operator() returns std::pair<float,float>)"
  },

  /* Phase 6.1.7 — visual sink. Like Output / OutputStereo for the
   * audio side, this is the entry point for the visual layer's
   * render pipeline. cppType is empty + the node name isn't
   * Output/OutputStereo, so the existing audio codegen ignores it
   * naturally — it's only reachable from texture-typed wires which
   * carry zero audio dependencies.
   *
   * Today the visual canvas already runs a smoke-clear render loop
   * regardless of whether VisualOutput exists in the graph. Once
   * shader nodes ship in 6.4.x, the render loop will walk the graph
   * from VisualOutput backward and chain shader passes into the
   * framebuffer; until then, dropping VisualOutput is a documentation
   * placeholder + a pre-wired socket for the first user-controllable
   * texture wire (which arrives with the first shader node). */
  VisualOutput: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    ins: [{ n: "in", t: "texture" }],
    outs: [],
    // Phase 6.5 — `display` indexes into state.rig.displays. Default
    // 0 means "render to display 0 of the auto-created 1-display rig"
    // — preserves single-display behavior for patches that don't care
    // about the rig system. The props pane renders this as a dropdown
    // sourced from the live rig.displays list (see renderProps).
    params:  { display: 0 },
    methods: { display: null },
    description: "Visual sink — wire a texture into in to drive the visual layer for the chosen display. Multiple VisualOutput nodes wired to the same shader render the SHARED image across the rig (the shader runs once per display with display-specific u_view + u_world_uv). Press L to enter Live Mode and see the rig fullscreen."
  },

  /* Phase 6.6.4b — RigGizmo. Patch-level overlay node that draws a
   * 2D HUD on top of the visual canvas: labels on each display tile,
   * warp / edge-blend status badges, and intensity highlight pulses
   * driven by an optional audio "level" input. The node has no codegen
   * — it's purely a UX surface that exists in the patch so the gizmo
   * is per-patch toggleable + serializable. */
  RigGizmo: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    ins:  [{ n: "level", t: "audio" }],
    outs: [],
    params:  {
      // 0..1 — base highlight brightness. Audio level (when wired)
      // multiplies into this, so intensity=0 keeps audio reactivity
      // visible while intensity=1 stays bright even with silence.
      intensity: 0.5,
      // labels: "none" | "index" | "name". Index draws the array
      // index (0, 1, 2…); name uses display.name from the rig.
      labelMode: "index",
      // toggle warp / blend badges in the overlay AND on the inset
      // gizmo's frustums. Both default on so a freshly-dropped node
      // shows everything; the user can hide what they don't want.
      showWarp:  true,
      showBlend: true,
      // outline-tile rectangles. Off in audio-reactive setups where
      // only the brightness pulse matters; on for QC of which tile
      // is which.
      outlineTiles: true
    },
    methods: { intensity: null, labelMode: null, showWarp: null, showBlend: null, outlineTiles: null },
    description: "Patch-level rig HUD — overlays display tiles with labels (index/name), warp/blend status badges, and audio-reactive highlights. Drop one in the patch to enable; only the first RigGizmo's params take effect (the node is global). Tile preview only — non-tile modes hide the overlay."
  },

  /* Phase 6.6.25 — Mesh Text. Converted from the original 2D
   * overlay form into a proper shader-frag whose output goes to
   * a VisualOutput, so text now renders on the dome surface,
   * projector-correct via the gnomonic-fix template, and can be
   * fed into BlendShader / MaskShader / etc. as a texture.
   *
   * Architecture:
   *   • def.wgsl is a function (node) => string -- the user's
   *     `text` param compiles into the shader as a const
   *     glyph-index array, alongside the static 5x7 bitmap font.
   *     v0.1.98 dynamic-WGSL infra handles the hot-reload + cache.
   *   • Char set: A-Z + a-z (auto-uppercased) + 0-9 + space + - +
   *     . + ! (40 glyphs). Unsupported chars render as space.
   *   • Max text length 32 (fixed-size const array in WGSL).
   *
   * Old 2D-overlay form deprecated: shader-frag-kind Text nodes
   * are filtered out of the _drawTextOverlay loop below, so this
   * is a clean replacement -- old patches that had Text overlay
   * lose the 2D rendering but gain the dome rendering with their
   * existing 'text' + 'r/g/b' + 'plateOpacity' params still
   * recognized (overlay-only params like font / fontSize / x / y
   * / perDisplay get ignored). */
  Text: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "text",         t: "param" },
      { n: "yawDeg",       t: "param" },
      { n: "pitchDeg",     t: "param" },
      { n: "sizeDeg",      t: "param" },
      { n: "r",            t: "param" },
      { n: "g",            t: "param" },
      { n: "b",            t: "param" },
      { n: "plateOpacity", t: "param" },
      { n: "bgR",          t: "param" },
      { n: "bgG",          t: "param" },
      { n: "bgB",          t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      text: "GAMMA NODE",
      yawDeg: 0,
      pitchDeg: 0,
      sizeDeg: 16,
      r: 1.0, g: 1.0, b: 1.0,
      plateOpacity: 0.0,
      bgR: 0.0, bgG: 0.0, bgB: 0.0
    },
    methods: {},
    uniformBytes: 112,
    wgsl: function (node) { return _buildTextShaderWGSL(node); },
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.yawDeg       === "number") ? p.yawDeg       : 0;
      scratch[17] = (typeof p.pitchDeg     === "number") ? p.pitchDeg     : 0;
      scratch[18] = (typeof p.sizeDeg      === "number") ? p.sizeDeg      : 16;
      scratch[19] = (typeof p.plateOpacity === "number") ? p.plateOpacity : 0.0;
      scratch[20] = (typeof p.r === "number") ? p.r : 1.0;
      scratch[21] = (typeof p.g === "number") ? p.g : 1.0;
      scratch[22] = (typeof p.b === "number") ? p.b : 1.0;
      scratch[23] = 0;
      scratch[24] = (typeof p.bgR === "number") ? p.bgR : 0.0;
      scratch[25] = (typeof p.bgG === "number") ? p.bgG : 0.0;
      scratch[26] = (typeof p.bgB === "number") ? p.bgB : 0.0;
      scratch[27] = 0;
    },
    description: "Mesh text — bitmap A-Z + 0-9 + space + dash + period + ! rendered on the dome surface via the shader-frag pipeline. Char set: A-Z, a-z (auto-uppercased), 0-9, space, '-', '.', '!' — anything else becomes a space. Wire `out` to a VisualOutput to project it onto a display, or to BlendShader.inA + a backdrop on inB for overlay. text: up to 32 chars (truncated). yawDeg/pitchDeg: text center on the sphere in degrees. sizeDeg: vertical angular size (16° readable from sweet-spot). r/g/b: text color [0..1]. plateOpacity [0..1]: background plate alpha (0 = transparent, useful for overlay; >0 paints a bgColor rectangle behind the text). bgR/G/B: plate color."
  },

  /* Phase 6.2.x — first two shader-frag nodes. Both are kind:
   * "shader-frag" with a hand-authored WGSL body shipped inline.
   * The renderer (in the Visual subsystem above) recognizes
   * kind === "shader-frag" + the wgsl/uniformBytes/writeUniforms
   * trio and runs them through the standard shader pipeline at
   * binding 0.
   *
   * Uniform-buffer layout shared across all shader-frag nodes:
   *   bytes 0–15  — u_resolution: vec4f (w, h, 1/w, 1/h)
   *   bytes 16–19 — u_time: f32 (seconds since device acquired)
   *   bytes 20–23 — u_dt:   f32 (seconds since previous frame)
   *   bytes 24–31 — _pad: vec2f (round to 16-byte alignment)
   *   bytes 32+   — per-node params (registry-defined)
   * Preamble is auto-written each frame by the renderer; each node's
   * writeUniforms(node, scratch) function fills offset 8+ (= byte 32+)
   * from the node's params. */

  /* SolidColor — flat-fill the framebuffer with a single user-set
   * RGB. Three params (r/g/b). Useful as a sanity test of the whole
   * pipeline + as a backdrop layer once composition shaders ship. */
  SolidColor: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins:  [
      { n: "r", t: "param" },
      { n: "g", t: "param" },
      { n: "b", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: { r: 0.20, g: 0.55, b: 0.85 },
    methods: { r: null, g: null, b: null },   // no audio codegen — params live entirely on the GPU
    uniformBytes: 80,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  color:        vec4f,
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
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
  return u.color;
}`,
    writeUniforms(node, scratch) {
      // scratch = 20 floats (80 B). Preamble fills [0..15] (incl.
      // u_view at [8..11], u_world_uv at [12..15]). User color fills
      // [16..19]. SolidColor doesn't use UV/world_uv → it ignores
      // those and just outputs a flat color across whichever display
      // it's assigned to (same color on every display).
      const p = node.params || {};
      scratch[16] = (typeof p.r === "number") ? p.r : 0.5;
      scratch[17] = (typeof p.g === "number") ? p.g : 0.5;
      scratch[18] = (typeof p.b === "number") ? p.b : 0.5;
      scratch[19] = 1.0;   // alpha — opaque always
    },
    description: "Flat color fill — outputs a uniform RGB color across the entire framebuffer. r/g/b each ∈ [0, 1]. Wire into VisualOutput.in for a solid backdrop, or into BlendShader (Phase 6.4) as one of its inputs."
  },

  /* Phase 7.1 — Webcam. Live camera feed via getUserMedia, sampled
   * through device.importExternalTexture each frame. Outputs a
   * texture that plugs into the existing composition chain like any
   * other visual source. First render kicks the permission prompt;
   * the node renders nothing (clear-color) until the user accepts +
   * the first frame decodes (~50-500ms typical webcam warm-up).
   *
   * Params:
   *   mirrored   — 1 = horizontal flip (selfie cam style), 0 = pass-through
   *   exposure   — output gain (1 = pass-through, >1 boosts, <1 darkens)
   *   tint_{rgb} — multiplied per-channel for color grading
   *
   * Aspect handling: video frames sampled with clamped UV; viewer's
   * aspect drives the framebuffer fit. cover-style fit so the video
   * fills the framebuffer (cropping the longer side) instead of
   * leaving black bars. */
  Webcam: {
    category: "Visual", color: COLOR.visual, header: null,
    // v0.3.19 — Webcam doubles as a wire-routable audio source. cppType
    // declares a GammaVideoSrc member; helperClass is duplicated across
    // VideoFile / Webcam / ScreenShare with identical content + dedup'd
    // by class name in generateCode -- a patch with only a Webcam (no
    // VideoFile) still gets the class definition emitted. Audio outs
    // are silent until the user enables audio in the props pane.
    cppType: "GammaVideoSrc",
    helperClass:
`class GammaVideoSrc {
    /* See VideoFile entry for full comment. Duplicate of the same
     * class definition; generateCode dedups by class name so only one
     * copy reaches the C++ output even when a patch has multiple
     * video sources of mixed type. */
    float l_ = 0.f;
    float r_ = 0.f;
public:
    void setL(float v) { l_ = v; }
    void setR(float v) { r_ = v; }
    void setSample(float l, float r) { l_ = l; r_ = r; }
    struct Out { float l, r; };
    Out operator()() {
        Out o; o.l = l_; o.r = r_; return o;
    }
};`,
    kind: "shader-frag",
    bindLayout: "video-source",
    ins:  [
      { n: "mirrored",  t: "param" },
      { n: "exposure",  t: "param" },
      { n: "tint_r",    t: "param" },
      { n: "tint_g",    t: "param" },
      { n: "tint_b",    t: "param" }
    ],
    outs: [
      { n: "out",  t: "texture" },
      // v0.3.19 — audio outlets. Silent unless audioEnabled and the
      // browser grants mic-with-video. Direct playback is NEVER on
      // for Webcam (would create echo) -- the audio path is patch-
      // routing only.
      { n: "outL", t: "audio", access: ".l" },
      { n: "outR", t: "audio", access: ".r" }
    ],
    params: {
      mirrored: 1, exposure: 1.0, tint_r: 1.0, tint_g: 1.0, tint_b: 1.0,
      audioEnabled: 0,   // off by default; enabling re-prompts getUserMedia
      volume: 1.0        // applied to the routing path (not direct playback)
    },
    methods: { mirrored: null, exposure: null, tint_r: null, tint_g: null, tint_b: null, audioEnabled: null, volume: null },
    uiOnlyParams: ["audioEnabled", "volume"],
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,   // x=mirrored, y=exposure, z=_, w=_
  tint:         vec4f,   // r, g, b, _
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var videoTex: texture_external;
@group(0) @binding(2) var videoSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

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
  // v0.3.18 — "contain" letterbox fit. Earlier versions did a "cover"
  // crop (fill canvas, lose content on the longer axis). Now we fit
  // the entire video inside the canvas + emit transparent bars on
  // the bar axis. Matches the landmark-overlay's _videoFitRect so
  // VideoFile + its downstream HandLandmarker / PoseLandmarker /
  // FaceLandmarker show the same visible frame -- no surprise crop
  // when wiring a video through detection.
  //
  // Bars are transparent (alpha 0) so a downstream BlendShader can
  // composite this layer over a different source. In stand-alone use
  // the scratch-layer clear color (black) shows through.
  let videoDim = vec2f(textureDimensions(videoTex));
  let fbDim    = u.u_resolution.xy;
  let videoAR  = videoDim.x / videoDim.y;
  let fbAR     = fbDim.x    / fbDim.y;
  var uv       = in.uv;
  if (videoAR > fbAR) {
    // Video wider than canvas — fit width, bars top/bottom.
    uv.y = (uv.y - 0.5) * (videoAR / fbAR) + 0.5;
  } else {
    // Video taller than canvas — fit height, bars left/right.
    uv.x = (uv.x - 0.5) * (fbAR / videoAR) + 0.5;
  }
  if (u.params.x > 0.5) { uv.x = 1.0 - uv.x; }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let color = textureSampleBaseClampToEdge(videoTex, videoSampler, uv);
  let rgb = color.rgb * u.params.y * u.tint.rgb;
  return vec4f(rgb, color.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.mirrored === "number") ? p.mirrored : 1.0;
      scratch[17] = (typeof p.exposure === "number") ? p.exposure : 1.0;
      scratch[18] = 0;
      scratch[19] = 0;
      scratch[20] = (typeof p.tint_r === "number") ? p.tint_r : 1.0;
      scratch[21] = (typeof p.tint_g === "number") ? p.tint_g : 1.0;
      scratch[22] = (typeof p.tint_b === "number") ? p.tint_b : 1.0;
      scratch[23] = 0;
    },
    description: "Live webcam feed via getUserMedia. Click ▶ once (or wire into VisualOutput + WebGPU render) to trigger the browser's camera permission prompt. Plugs into BlendShader / ColorCorrect / MaskShader chains like any other visual source — turn the editor into a VJ tool with one wire. mirrored=1 flips horizontally (selfie cam); exposure scales output gain; tint_{r,g,b} multiplies per-channel."
  },

  /* VideoFile (v0.3.11) — file-driven video source.
   *
   * Same WGSL pipeline as Webcam (shares the cached pipeline because
   * the source text matches); the only difference is where the
   * underlying <video> element's src comes from. fileUrl is a
   * standard URL string: a blob URL (browser-local picked file) or
   * an http(s) URL (CORS-cleared video). The properties panel
   * renders a "Pick file…" button on click that opens an OS file
   * picker → URL.createObjectURL → params.fileUrl. URLs typed in
   * directly also work (server-hosted videos with CORS).
   *
   * The element is created with loop=true so the video repeats
   * indefinitely. Use a downstream BlendShader to mix it with
   * other content. Also pluggable into the new "video" input on
   * HandLandmarker / PoseLandmarker / FaceLandmarker / HandKeyboard
   * so MediaPipe runs detection on the file frames instead of the
   * live camera. */
  VideoFile: {
    category: "Visual", color: COLOR.visual, header: null,
    // v0.3.19 — VideoFile is now ALSO a wire-routable audio source.
    // GammaVideoSrc is a pass-through stereo container; the worklet
    // calls setL/setR per sample with the file's audio track data,
    // and the operator() returns Out{l,r} so downstream nodes can
    // read outL / outR. helperClass below ships the class definition;
    // Webcam (same cppType) dedups against it.
    cppType: "GammaVideoSrc",
    helperClass:
`class GammaVideoSrc {
    /* Stereo pass-through for video / mic audio routed through the
     * worklet's input 1 (one stereo channel pair per source). The
     * worklet writes inputs[1][2N] / [2N+1] to wasm buffers each
     * quantum, then the wrapper's tick body calls setL/setR per
     * sample BEFORE operator() reads gPatch. Consumers reach the
     * latest sample via the .l / .r accessors on Out. */
    float l_ = 0.f;
    float r_ = 0.f;
public:
    void setL(float v) { l_ = v; }
    void setR(float v) { r_ = v; }
    void setSample(float l, float r) { l_ = l; r_ = r; }
    struct Out { float l, r; };
    Out operator()() {
        Out o; o.l = l_; o.r = r_; return o;
    }
};`,
    kind: "shader-frag",
    bindLayout: "video-source",
    ins: [
      { n: "mirrored", t: "param" },
      { n: "exposure", t: "param" },
      { n: "tint_r",   t: "param" },
      { n: "tint_g",   t: "param" },
      { n: "tint_b",   t: "param" },
      // v0.3.16 — gate input. On rising edge (e.g. from MasterClock.bar
      // / .beat / .sixteenth / .phase or a Button.trig) the video seeks
      // back to currentTime = 0. Wire MasterClock.bar → trig for a clip
      // that re-syncs on every bar.
      { n: "trig",     t: "gate" }
    ],
    outs: [
      { n: "out",  t: "texture" },
      // v0.3.19 — wire-routable audio outlets. Wire outL/outR into any
      // audio-rate node (Filter, Reverb, MasterMix, Output). When at
      // least one wire exists from this node, direct playback through
      // the browser default device is suppressed -- the patch IS the
      // audio path. With no wires, the file plays through
      // MES->Gain->ctx.destination (volume slider applies; the legacy
      // v0.3.16 behavior).
      { n: "outL", t: "audio", access: ".l" },
      { n: "outR", t: "audio", access: ".r" }
    ],
    params: {
      fileUrl: "",
      // v0.3.15 — transport state, persisted with the patch.
      paused: 0,
      playbackRate: 1.0,
      // v0.3.16 — audio playback of the file's audio track. Plays
      // through the browser's default audio device (NOT through the
      // patch's audio worklet yet -- a wire-routable audio outlet
      // that integrates with codegen is the next ticket). audioEnabled
      // mutes the track when 0; volume scales when enabled.
      audioEnabled: 1,
      volume: 1.0,
      mirrored: 0, exposure: 1.0,
      tint_r: 1.0, tint_g: 1.0, tint_b: 1.0
    },
    methods: { fileUrl: null, paused: null, playbackRate: null, audioEnabled: null, volume: null, mirrored: null, exposure: null, tint_r: null, tint_g: null, tint_b: null },
    uiOnlyParams: ["fileUrl", "paused", "playbackRate", "audioEnabled", "volume"],
    uniformBytes: 96,
    // Same WGSL as Webcam -- pipeline cache hashes the source so
    // both nodes share the compiled pipeline.
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,   // x=mirrored, y=exposure, z=_, w=_
  tint:         vec4f,   // r, g, b, _
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var videoTex: texture_external;
@group(0) @binding(2) var videoSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

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
  // v0.3.18 — "contain" letterbox fit; see Webcam shader for the full
  // comment. Shared with Webcam (pipeline cache hashes the source).
  let videoDim = vec2f(textureDimensions(videoTex));
  let fbDim    = u.u_resolution.xy;
  let videoAR  = videoDim.x / videoDim.y;
  let fbAR     = fbDim.x    / fbDim.y;
  var uv       = in.uv;
  if (videoAR > fbAR) {
    uv.y = (uv.y - 0.5) * (videoAR / fbAR) + 0.5;
  } else {
    uv.x = (uv.x - 0.5) * (fbAR / videoAR) + 0.5;
  }
  if (u.params.x > 0.5) { uv.x = 1.0 - uv.x; }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let color = textureSampleBaseClampToEdge(videoTex, videoSampler, uv);
  let rgb = color.rgb * u.params.y * u.tint.rgb;
  return vec4f(rgb, color.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.mirrored === "number") ? p.mirrored : 0;
      scratch[17] = (typeof p.exposure === "number") ? p.exposure : 1.0;
      scratch[18] = 0;
      scratch[19] = 0;
      scratch[20] = (typeof p.tint_r === "number") ? p.tint_r : 1.0;
      scratch[21] = (typeof p.tint_g === "number") ? p.tint_g : 1.0;
      scratch[22] = (typeof p.tint_b === "number") ? p.tint_b : 1.0;
      scratch[23] = 0;
    },
    description: "Plays back a video file as a texture. Click the node's 'Pick file…' button in the props panel to load a local video, or paste an http(s) URL into fileUrl. Loops indefinitely; same WGSL pipeline as Webcam (shared compiled pipeline). Wire `out` → BlendShader / VisualOutput, or wire into the `video` input of any MediaPipe landmark node to run detection on the file's frames instead of the live camera. mirrored=1 flips horizontally; exposure scales output gain; tint_{r,g,b} multiplies per-channel."
  },

  /* v0.3.22 — ScreenShare. getDisplayMedia()-backed video source: lets
   * the user pick a screen, window, or browser tab and feed it through
   * the patch's visual + audio graph like any other video node.
   *
   * Architecture mirrors Webcam / VideoFile:
   *   - cppType: GammaVideoSrc -- the same C++ helper class (dedup'd by
   *     name from the VideoFile entry's helperClass). Wire-routable audio
   *     out via outL/outR exactly like the other two.
   *   - kind: shader-frag + bindLayout: "video-source" -- same WGSL +
   *     contain-fit letterbox shader as Webcam/VideoFile; the pipeline
   *     cache hashes the source so all three share one compiled artifact.
   *
   * Critical caveat: getDisplayMedia() MUST be invoked from a user
   * gesture (the spec requires it; browsers reject auto-invocation).
   * So we DON'T auto-init from the render loop -- the user must hit
   * the "Pick screen / window / tab…" button in the props pane.
   *
   * Selection lifecycle:
   *   - User picks → MediaStream returned → videoEl bound to it →
   *     rendering kicks in next frame.
   *   - User stops sharing via the browser's "Stop sharing" UI →
   *     videoTrack.onended fires → _disposeVideoSource clears the
   *     entry → render falls back to blank.
   *   - User picks a different source (re-click the button) → existing
   *     stream disposed → fresh pick.
   *
   * Audio: getDisplayMedia({ audio: true }) gives system audio on
   * supported platforms (Chrome / Edge on Windows when sharing a tab
   * or window with "Share audio" checked; not all permutations).
   * Where supported, the audio track is routed through GammaVideoSrc
   * exactly like VideoFile's MES path -- pipe outL/outR through
   * BiquadLP / Reverb / MasterMix or feed it to the screen recorder
   * for tutorials with patched-in DSP. */
  ScreenShare: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "GammaVideoSrc",
    // Duplicate of VideoFile / Webcam helperClass; dedup'd by class
    // name so a ScreenShare-only patch still gets the C++ definition.
    helperClass:
`class GammaVideoSrc {
    /* See VideoFile entry for full comment. Duplicate definition;
     * generateCode dedups by class name. */
    float l_ = 0.f;
    float r_ = 0.f;
public:
    void setL(float v) { l_ = v; }
    void setR(float v) { r_ = v; }
    void setSample(float l, float r) { l_ = l; r_ = r; }
    struct Out { float l, r; };
    Out operator()() {
        Out o; o.l = l_; o.r = r_; return o;
    }
};`,
    kind: "shader-frag",
    bindLayout: "video-source",
    ins: [
      { n: "mirrored", t: "param" },
      { n: "exposure", t: "param" },
      { n: "tint_r",   t: "param" },
      { n: "tint_g",   t: "param" },
      { n: "tint_b",   t: "param" }
    ],
    outs: [
      { n: "out",  t: "texture" },
      { n: "outL", t: "audio", access: ".l" },
      { n: "outR", t: "audio", access: ".r" }
    ],
    params: {
      // Mirror defaults OFF for screenshare (text would be backwards
      // otherwise -- the mirror flag is purely a selfie-cam convenience).
      mirrored: 0,
      exposure: 1.0,
      tint_r: 1.0, tint_g: 1.0, tint_b: 1.0,
      // Audio defaults ON since screen-share audio is the marquee use
      // case (recording tutorials, capturing system sound). The browser
      // permission flow is the gate -- the user explicitly checks "Share
      // audio" in the picker, so we don't need a second opt-in.
      audioEnabled: 1,
      volume: 1.0
    },
    methods: { mirrored: null, exposure: null, tint_r: null, tint_g: null, tint_b: null, audioEnabled: null, volume: null },
    uiOnlyParams: ["audioEnabled", "volume"],
    uniformBytes: 96,
    // Same WGSL as Webcam / VideoFile -- pipeline cache shares the
    // compiled pipeline across all three video-source nodes.
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,   // x=mirrored, y=exposure, z=_, w=_
  tint:         vec4f,   // r, g, b, _
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var videoTex: texture_external;
@group(0) @binding(2) var videoSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

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
  // v0.3.18 contain letterbox; see Webcam shader for the full comment.
  let videoDim = vec2f(textureDimensions(videoTex));
  let fbDim    = u.u_resolution.xy;
  let videoAR  = videoDim.x / videoDim.y;
  let fbAR     = fbDim.x    / fbDim.y;
  var uv       = in.uv;
  if (videoAR > fbAR) {
    uv.y = (uv.y - 0.5) * (videoAR / fbAR) + 0.5;
  } else {
    uv.x = (uv.x - 0.5) * (fbAR / videoAR) + 0.5;
  }
  if (u.params.x > 0.5) { uv.x = 1.0 - uv.x; }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let color = textureSampleBaseClampToEdge(videoTex, videoSampler, uv);
  let rgb = color.rgb * u.params.y * u.tint.rgb;
  return vec4f(rgb, color.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.mirrored === "number") ? p.mirrored : 0;
      scratch[17] = (typeof p.exposure === "number") ? p.exposure : 1.0;
      scratch[18] = 0;
      scratch[19] = 0;
      scratch[20] = (typeof p.tint_r === "number") ? p.tint_r : 1.0;
      scratch[21] = (typeof p.tint_g === "number") ? p.tint_g : 1.0;
      scratch[22] = (typeof p.tint_b === "number") ? p.tint_b : 1.0;
      scratch[23] = 0;
    },
    description: "Screen / window / browser-tab share via getDisplayMedia. Click the node's 'Pick screen / window / tab…' button in the props pane to open the browser's source picker (this requires a user gesture per the spec — auto-init from the render loop is not allowed). Same letterbox WGSL pipeline as Webcam / VideoFile. Stops automatically when the user clicks the browser's 'Stop sharing' UI. Wire `out` → BlendShader / VisualOutput / any landmark node. Audio outL/outR are populated when the user checks 'Share audio' in the picker (Chrome / Edge on Windows; the option appears for tab + window shares, not full-screen on most setups)."
  },

  /* Phase 7.1b — HandLandmarker (MediaPipe Tasks Vision).
   *
   * Real-time hand tracking via MediaPipe's WASM-GPU pipeline. Runs
   * its own webcam stream (separate from any Webcam node in the patch),
   * detects up to 4 hands at 21 landmarks each, exposes per-hand
   * derived params via output ports.
   *
   * First wire-out lazy-loads MediaPipe Tasks from jsdelivr (~3MB,
   * cached) + the HandLandmarker model from Google storage (~5MB
   * float16 build). Permission prompt fires the first time. Until
   * the model + camera are warm, outputs read 0.
   *
   * Output values are normalized:
   *   numHands              integer (0..maxHands)
   *   h{1,2,3,4}_x          wrist x position, 0..1 (left=0, right=1)
   *   h{1,2,3,4}_y          wrist y position, 0..1 (top=0, bottom=1)
   *   h{1,2,3,4}_z          wrist depth, ~-0.1..+0.1 typical
   *   h{1,2,3,4}_pinch      thumb-tip ↔ index-tip distance, 0..0.3 typical
   *                          (small = pinch, large = open spread)
   *   h{1,2,3,4}_open       0=fist, 1=fully-spread hand (heuristic)
   *   h{1,2,3,4}_rot        wrist→middle-base angle, -1..1 (radians/π)
   *
   * Wire pinch → Plasma.speed for "squeeze to slow down" interaction;
   * wire h1_y → ColorCorrect.brightness for "hand height = scene
   * brightness", etc. Audio-side wiring is shader-shader only today;
   * driving a BiquadLP.cutoff with hand position needs the live-control
   * → SAB → worklet → C++ setter bridge (Phase 6.5+ follow-on). */
  HandLandmarker: {
    category: "AI", color: COLOR.ai, header: null,
    // v0.3.6 — cppType + helperClass so HandLandmarker outputs reach
    // the audio side too. The class has 13 setters (one per output
    // value) and a struct-returning operator()() so the existing
    // multi-output codegen path wires e.g. h1_pinch → BiquadLP.cutoff
    // at sample rate the same way Slider → BiquadLP.cutoff already
    // works. JS pushes the latest detection values to each setter
    // every render frame via _pushLiveControlsToWorklet (sub-1ms,
    // a single quantum's worth of latency to audio).
    cppType: "GammaHandLandmarkerSource",
    helperClass:
`class GammaHandLandmarkerSource {
    /* JS-driven value sink. Each setter parks the latest MediaPipe
     * detection result into its slot; operator()() returns the
     * whole struct so downstream nodes can read individual fields
     * via the codegen's outs[].access pattern. No per-sample work
     * inside the class -- pure storage.
     *
     * v0.3.7 — added "present" (0 or 1) at slot 13 as a clean binary
     * gate: 1 when any hand is detected, 0 otherwise. The h1_open
     * gate from v0.3.6 dropped to zero on a closed fist even with
     * the hand clearly tracked, so it wasn't a reliable "is anything
     * there" trigger -- "present" fixes that. */
    float v_[14] = {0};
public:
    void setNumHands(float v) { v_[0]  = v; }
    void setH1X(float v)      { v_[1]  = v; }
    void setH1Y(float v)      { v_[2]  = v; }
    void setH1Z(float v)      { v_[3]  = v; }
    void setH1Pinch(float v)  { v_[4]  = v; }
    void setH1Open(float v)   { v_[5]  = v; }
    void setH1Rot(float v)    { v_[6]  = v; }
    void setH2X(float v)      { v_[7]  = v; }
    void setH2Y(float v)      { v_[8]  = v; }
    void setH2Z(float v)      { v_[9]  = v; }
    void setH2Pinch(float v)  { v_[10] = v; }
    void setH2Open(float v)   { v_[11] = v; }
    void setH2Rot(float v)    { v_[12] = v; }
    void setPresent(float v)  { v_[13] = v; }
    struct Out {
        float numHands, h1_x, h1_y, h1_z, h1_pinch, h1_open, h1_rot,
              h2_x, h2_y, h2_z, h2_pinch, h2_open, h2_rot, present;
    };
    Out operator()() {
        return { v_[0],  v_[1],  v_[2],  v_[3],  v_[4],  v_[5],  v_[6],
                 v_[7],  v_[8],  v_[9],  v_[10], v_[11], v_[12], v_[13] };
    }
};`,
    kind: "ai-vision-canvas",
    // v0.3.11 — optional "video" texture input. When wired (typically
    // from Webcam / VideoFile / ScreenShare), the detector samples
    // the SOURCE node's underlying <video> element instead of opening
    // its own getUserMedia camera stream. Lets one webcam stream
    // feed multiple detectors, or run MediaPipe over a pre-recorded
    // video file. Unwired = falls back to own camera (original
    // behaviour).
    ins: [{ n: "video", t: "texture" }],
    outs: [
      { n: "out",      t: "texture" },
      // Multi-output struct fields — codegen reads ".field" off the
      // operator()() return value for each downstream sample.
      // v0.3.7 — "present" is a binary 0/1 gate (1 when any hand is
      // detected, 0 otherwise). Use this when you want a clean
      // "tracking is alive" trigger that doesn't depend on gesture
      // pose -- closed fist still reads as 1.
      { n: "present",  t: "param", access: ".present" },
      { n: "numHands", t: "param", access: ".numHands" },
      { n: "h1_x",     t: "param", access: ".h1_x" },
      { n: "h1_y",     t: "param", access: ".h1_y" },
      { n: "h1_z",     t: "param", access: ".h1_z" },
      { n: "h1_pinch", t: "param", access: ".h1_pinch" },
      { n: "h1_open",  t: "param", access: ".h1_open" },
      { n: "h1_rot",   t: "param", access: ".h1_rot" },
      { n: "h2_x",     t: "param", access: ".h2_x" },
      { n: "h2_y",     t: "param", access: ".h2_y" },
      { n: "h2_z",     t: "param", access: ".h2_z" },
      { n: "h2_pinch", t: "param", access: ".h2_pinch" },
      { n: "h2_open",  t: "param", access: ".h2_open" },
      { n: "h2_rot",   t: "param", access: ".h2_rot" }
    ],
    params: {
      // UI-only config params (steer the detector + the canvas overlay
      // style; not exposed as audio setters).
      maxHands: 2, minConfidence: 0.5, bgMode: 1, mirrored: 1,
      lineWidth: 2.5, dotRadius: 4,
      // Live param values (JS-driven; auto-exposed as setters so the
      // worklet can receive them per frame via postMessage).
      present: 0, numHands: 0,
      h1_x: 0,     h1_y: 0,     h1_z: 0,
      h1_pinch: 0, h1_open: 0,  h1_rot: 0,
      h2_x: 0,     h2_y: 0,     h2_z: 0,
      h2_pinch: 0, h2_open: 0,  h2_rot: 0
    },
    methods: {
      maxHands: null, minConfidence: null, bgMode: null, mirrored: null,
      lineWidth: null, dotRadius: null,
      present: "setPresent",
      numHands: "setNumHands",
      h1_x: "setH1X", h1_y: "setH1Y", h1_z: "setH1Z",
      h1_pinch: "setH1Pinch", h1_open: "setH1Open", h1_rot: "setH1Rot",
      h2_x: "setH2X", h2_y: "setH2Y", h2_z: "setH2Z",
      h2_pinch: "setH2Pinch", h2_open: "setH2Open", h2_rot: "setH2Rot"
    },
    // UI-only params don't show up in the Monitor's exposed-setter
    // panel + don't get included in collectExposedSetters.
    uiOnlyParams: ["maxHands", "minConfidence", "bgMode", "mirrored", "lineWidth", "dotRadius"],
    // Auto-expose every live-value port so the audio worklet receives
    // them via the standard setter dispatch table -- same path Slider
    // uses.
    autoExpose: [
      "present", "numHands",
      "h1_x", "h1_y", "h1_z", "h1_pinch", "h1_open", "h1_rot",
      "h2_x", "h2_y", "h2_z", "h2_pinch", "h2_open", "h2_rot"
    ],
    description: "Real-time hand-landmark detection via MediaPipe (WASM+GPU). Outputs (1) a texture showing the camera feed with a skeleton overlay drawn on top, colour-coded by handedness (phosphor=left, cyan=right), and (2) per-hand position / pinch / openness / rotation as param wires that drive BOTH shader uniforms AND audio-node params at sample rate. Wire `out` → VisualOutput to see what the detector sees; wire e.g. `h1_pinch` → BiquadLP.cutoff for gesture-controlled filter sweeps. First use prompts for camera permission + downloads ~8MB of model + WASM (cached after). bgMode=0 makes the overlay transparent for blending over a separate source."
  },

  /* PoseLandmarker (MediaPipe Tasks Vision, v0.3.9).
   *
   * Full-body pose detection: 33 landmarks per detected person.
   * Same WASM+GPU pipeline as HandLandmarker; same ai-vision-canvas
   * rendering path; same JS→worklet setter push every frame. We
   * surface the most useful joints (head, shoulders, elbows, wrists,
   * hips, knees, ankles) as 24 output ports — full 33-landmark
   * raw data is overkill for VJ + audio-control use cases. */
  PoseLandmarker: {
    category: "AI", color: COLOR.ai, header: null,
    cppType: "GammaPoseLandmarkerSource",
    helperClass:
`class GammaPoseLandmarkerSource {
    /* Same shape as GammaHandLandmarkerSource -- JS-driven storage
     * + one struct-returning operator()(). 24 setter slots covering
     * the major body joints. */
    float v_[24] = {0};
public:
    void setPresent(float v)         { v_[0]  = v; }
    void setNumPoses(float v)        { v_[1]  = v; }
    void setNoseX(float v)           { v_[2]  = v; }
    void setNoseY(float v)           { v_[3]  = v; }
    void setLShoulderX(float v)      { v_[4]  = v; }
    void setLShoulderY(float v)      { v_[5]  = v; }
    void setRShoulderX(float v)      { v_[6]  = v; }
    void setRShoulderY(float v)      { v_[7]  = v; }
    void setLElbowX(float v)         { v_[8]  = v; }
    void setLElbowY(float v)         { v_[9]  = v; }
    void setRElbowX(float v)         { v_[10] = v; }
    void setRElbowY(float v)         { v_[11] = v; }
    void setLWristX(float v)         { v_[12] = v; }
    void setLWristY(float v)         { v_[13] = v; }
    void setRWristX(float v)         { v_[14] = v; }
    void setRWristY(float v)         { v_[15] = v; }
    void setLHipX(float v)           { v_[16] = v; }
    void setLHipY(float v)           { v_[17] = v; }
    void setRHipX(float v)           { v_[18] = v; }
    void setRHipY(float v)           { v_[19] = v; }
    void setLKneeX(float v)          { v_[20] = v; }
    void setLKneeY(float v)          { v_[21] = v; }
    void setRKneeX(float v)          { v_[22] = v; }
    void setRKneeY(float v)          { v_[23] = v; }
    struct Out {
        float present, numPoses,
              nose_x, nose_y,
              lshoulder_x, lshoulder_y, rshoulder_x, rshoulder_y,
              lelbow_x, lelbow_y, relbow_x, relbow_y,
              lwrist_x, lwrist_y, rwrist_x, rwrist_y,
              lhip_x, lhip_y, rhip_x, rhip_y,
              lknee_x, lknee_y, rknee_x, rknee_y;
    };
    Out operator()() {
        return { v_[0],  v_[1],  v_[2],  v_[3],  v_[4],  v_[5],  v_[6],  v_[7],
                 v_[8],  v_[9],  v_[10], v_[11], v_[12], v_[13], v_[14], v_[15],
                 v_[16], v_[17], v_[18], v_[19], v_[20], v_[21], v_[22], v_[23] };
    }
};`,
    kind: "ai-vision-canvas",
    // v0.3.11 — optional "video" texture input. When wired (from
    // Webcam / VideoFile / etc), MediaPipe samples the source's
    // underlying <video> element instead of opening own camera.
    ins: [{ n: "video", t: "texture" }],
    outs: [
      { n: "out",         t: "texture" },
      { n: "present",     t: "param", access: ".present"     },
      { n: "numPoses",    t: "param", access: ".numPoses"    },
      { n: "nose_x",      t: "param", access: ".nose_x"      },
      { n: "nose_y",      t: "param", access: ".nose_y"      },
      { n: "lshoulder_x", t: "param", access: ".lshoulder_x" },
      { n: "lshoulder_y", t: "param", access: ".lshoulder_y" },
      { n: "rshoulder_x", t: "param", access: ".rshoulder_x" },
      { n: "rshoulder_y", t: "param", access: ".rshoulder_y" },
      { n: "lelbow_x",    t: "param", access: ".lelbow_x"    },
      { n: "lelbow_y",    t: "param", access: ".lelbow_y"    },
      { n: "relbow_x",    t: "param", access: ".relbow_x"    },
      { n: "relbow_y",    t: "param", access: ".relbow_y"    },
      { n: "lwrist_x",    t: "param", access: ".lwrist_x"    },
      { n: "lwrist_y",    t: "param", access: ".lwrist_y"    },
      { n: "rwrist_x",    t: "param", access: ".rwrist_x"    },
      { n: "rwrist_y",    t: "param", access: ".rwrist_y"    },
      { n: "lhip_x",      t: "param", access: ".lhip_x"      },
      { n: "lhip_y",      t: "param", access: ".lhip_y"      },
      { n: "rhip_x",      t: "param", access: ".rhip_x"      },
      { n: "rhip_y",      t: "param", access: ".rhip_y"      },
      { n: "lknee_x",     t: "param", access: ".lknee_x"     },
      { n: "lknee_y",     t: "param", access: ".lknee_y"     },
      { n: "rknee_x",     t: "param", access: ".rknee_x"     },
      { n: "rknee_y",     t: "param", access: ".rknee_y"     }
    ],
    params: {
      // Config (UI-only, not exposed as audio setters).
      maxPoses: 1, minConfidence: 0.5, bgMode: 1, mirrored: 1,
      lineWidth: 3, dotRadius: 5,
      // Live values (JS-driven; auto-exposed).
      present: 0, numPoses: 0,
      nose_x: 0, nose_y: 0,
      lshoulder_x: 0, lshoulder_y: 0, rshoulder_x: 0, rshoulder_y: 0,
      lelbow_x: 0, lelbow_y: 0, relbow_x: 0, relbow_y: 0,
      lwrist_x: 0, lwrist_y: 0, rwrist_x: 0, rwrist_y: 0,
      lhip_x: 0, lhip_y: 0, rhip_x: 0, rhip_y: 0,
      lknee_x: 0, lknee_y: 0, rknee_x: 0, rknee_y: 0
    },
    methods: {
      maxPoses: null, minConfidence: null, bgMode: null, mirrored: null,
      lineWidth: null, dotRadius: null,
      present: "setPresent", numPoses: "setNumPoses",
      nose_x: "setNoseX", nose_y: "setNoseY",
      lshoulder_x: "setLShoulderX", lshoulder_y: "setLShoulderY",
      rshoulder_x: "setRShoulderX", rshoulder_y: "setRShoulderY",
      lelbow_x: "setLElbowX", lelbow_y: "setLElbowY",
      relbow_x: "setRElbowX", relbow_y: "setRElbowY",
      lwrist_x: "setLWristX", lwrist_y: "setLWristY",
      rwrist_x: "setRWristX", rwrist_y: "setRWristY",
      lhip_x: "setLHipX", lhip_y: "setLHipY",
      rhip_x: "setRHipX", rhip_y: "setRHipY",
      lknee_x: "setLKneeX", lknee_y: "setLKneeY",
      rknee_x: "setRKneeX", rknee_y: "setRKneeY"
    },
    uiOnlyParams: ["maxPoses", "minConfidence", "bgMode", "mirrored", "lineWidth", "dotRadius"],
    autoExpose: [
      "present", "numPoses",
      "nose_x", "nose_y",
      "lshoulder_x", "lshoulder_y", "rshoulder_x", "rshoulder_y",
      "lelbow_x", "lelbow_y", "relbow_x", "relbow_y",
      "lwrist_x", "lwrist_y", "rwrist_x", "rwrist_y",
      "lhip_x", "lhip_y", "rhip_x", "rhip_y",
      "lknee_x", "lknee_y", "rknee_x", "rknee_y"
    ],
    description: "Full-body pose detection via MediaPipe (WASM+GPU). Detects 33 landmarks per person; surfaces the major joints (head / shoulders / elbows / wrists / hips / knees) as param wires that drive shader uniforms AND audio params at sample rate. Wire `out` → VisualOutput to see the skeleton overlay; wire e.g. `rwrist_y` → BiquadLP.cutoff for body-controlled filter sweeps. First use prompts for camera permission + downloads ~3MB of model + WASM (cached). bgMode=0 = transparent overlay."
  },

  /* FaceLandmarker (MediaPipe Tasks Vision, v0.3.9).
   *
   * 468-point face mesh + 52 blendshapes (expression coefficients).
   * Raw 468 landmarks aren't useful as port wires (way too many); we
   * expose the high-level position (face center) + the 14 most
   * useful blendshapes as 0..1 expression values. Smile, jaw drop,
   * eye blinks, brow movements — drive a synth filter from a grin
   * or fade a shader's brightness with a blink. */
  FaceLandmarker: {
    category: "AI", color: COLOR.ai, header: null,
    cppType: "GammaFaceLandmarkerSource",
    helperClass:
`class GammaFaceLandmarkerSource {
    /* 18 slots: 2 detection + 2 position + 14 blendshapes. */
    float v_[18] = {0};
public:
    void setPresent(float v)            { v_[0]  = v; }
    void setNumFaces(float v)           { v_[1]  = v; }
    void setFaceX(float v)              { v_[2]  = v; }
    void setFaceY(float v)              { v_[3]  = v; }
    void setJawOpen(float v)            { v_[4]  = v; }
    void setMouthSmileLeft(float v)     { v_[5]  = v; }
    void setMouthSmileRight(float v)    { v_[6]  = v; }
    void setMouthFrownLeft(float v)     { v_[7]  = v; }
    void setMouthFrownRight(float v)    { v_[8]  = v; }
    void setMouthPucker(float v)        { v_[9]  = v; }
    void setEyeBlinkLeft(float v)       { v_[10] = v; }
    void setEyeBlinkRight(float v)      { v_[11] = v; }
    void setEyeWideLeft(float v)        { v_[12] = v; }
    void setEyeWideRight(float v)       { v_[13] = v; }
    void setBrowDownLeft(float v)       { v_[14] = v; }
    void setBrowDownRight(float v)      { v_[15] = v; }
    void setBrowInnerUp(float v)        { v_[16] = v; }
    void setCheekPuff(float v)          { v_[17] = v; }
    struct Out {
        float present, numFaces,
              face_x, face_y,
              jawOpen,
              mouthSmileLeft, mouthSmileRight,
              mouthFrownLeft, mouthFrownRight,
              mouthPucker,
              eyeBlinkLeft, eyeBlinkRight,
              eyeWideLeft,  eyeWideRight,
              browDownLeft, browDownRight,
              browInnerUp,
              cheekPuff;
    };
    Out operator()() {
        return { v_[0],  v_[1],  v_[2],  v_[3],
                 v_[4],  v_[5],  v_[6],  v_[7],  v_[8],  v_[9],
                 v_[10], v_[11], v_[12], v_[13],
                 v_[14], v_[15], v_[16], v_[17] };
    }
};`,
    kind: "ai-vision-canvas",
    // v0.3.11 — optional "video" texture input. When wired (from
    // Webcam / VideoFile / etc), MediaPipe samples the source's
    // underlying <video> element instead of opening own camera.
    ins: [{ n: "video", t: "texture" }],
    outs: [
      { n: "out",             t: "texture" },
      { n: "present",         t: "param", access: ".present"         },
      { n: "numFaces",        t: "param", access: ".numFaces"        },
      { n: "face_x",          t: "param", access: ".face_x"          },
      { n: "face_y",          t: "param", access: ".face_y"          },
      { n: "jawOpen",         t: "param", access: ".jawOpen"         },
      { n: "mouthSmileLeft",  t: "param", access: ".mouthSmileLeft"  },
      { n: "mouthSmileRight", t: "param", access: ".mouthSmileRight" },
      { n: "mouthFrownLeft",  t: "param", access: ".mouthFrownLeft"  },
      { n: "mouthFrownRight", t: "param", access: ".mouthFrownRight" },
      { n: "mouthPucker",     t: "param", access: ".mouthPucker"     },
      { n: "eyeBlinkLeft",    t: "param", access: ".eyeBlinkLeft"    },
      { n: "eyeBlinkRight",   t: "param", access: ".eyeBlinkRight"   },
      { n: "eyeWideLeft",     t: "param", access: ".eyeWideLeft"     },
      { n: "eyeWideRight",    t: "param", access: ".eyeWideRight"    },
      { n: "browDownLeft",    t: "param", access: ".browDownLeft"    },
      { n: "browDownRight",   t: "param", access: ".browDownRight"   },
      { n: "browInnerUp",     t: "param", access: ".browInnerUp"     },
      { n: "cheekPuff",       t: "param", access: ".cheekPuff"       }
    ],
    params: {
      maxFaces: 1, minConfidence: 0.5, bgMode: 1, mirrored: 1,
      lineWidth: 1.0, dotRadius: 1.5,
      present: 0, numFaces: 0,
      face_x: 0, face_y: 0,
      jawOpen: 0,
      mouthSmileLeft: 0, mouthSmileRight: 0,
      mouthFrownLeft: 0, mouthFrownRight: 0,
      mouthPucker: 0,
      eyeBlinkLeft: 0, eyeBlinkRight: 0,
      eyeWideLeft: 0, eyeWideRight: 0,
      browDownLeft: 0, browDownRight: 0,
      browInnerUp: 0,
      cheekPuff: 0
    },
    methods: {
      maxFaces: null, minConfidence: null, bgMode: null, mirrored: null,
      lineWidth: null, dotRadius: null,
      present: "setPresent", numFaces: "setNumFaces",
      face_x: "setFaceX", face_y: "setFaceY",
      jawOpen: "setJawOpen",
      mouthSmileLeft:  "setMouthSmileLeft",  mouthSmileRight:  "setMouthSmileRight",
      mouthFrownLeft:  "setMouthFrownLeft",  mouthFrownRight:  "setMouthFrownRight",
      mouthPucker:     "setMouthPucker",
      eyeBlinkLeft:    "setEyeBlinkLeft",    eyeBlinkRight:    "setEyeBlinkRight",
      eyeWideLeft:     "setEyeWideLeft",     eyeWideRight:     "setEyeWideRight",
      browDownLeft:    "setBrowDownLeft",    browDownRight:    "setBrowDownRight",
      browInnerUp:     "setBrowInnerUp",
      cheekPuff:       "setCheekPuff"
    },
    uiOnlyParams: ["maxFaces", "minConfidence", "bgMode", "mirrored", "lineWidth", "dotRadius"],
    autoExpose: [
      "present", "numFaces",
      "face_x", "face_y",
      "jawOpen",
      "mouthSmileLeft", "mouthSmileRight",
      "mouthFrownLeft", "mouthFrownRight",
      "mouthPucker",
      "eyeBlinkLeft", "eyeBlinkRight",
      "eyeWideLeft",  "eyeWideRight",
      "browDownLeft", "browDownRight",
      "browInnerUp",
      "cheekPuff"
    ],
    description: "468-point face mesh + 52 blendshape coefficients via MediaPipe. We surface the most expressive 14 blendshapes (jaw open, smile, frown, pucker, blinks, brow movement, cheek puff) as 0..1 param wires. Drive a filter cutoff from a grin, gate a shader brightness with a blink, sweep a delay's feedback with brow movement. First use downloads ~6MB of model. bgMode=1 shows camera + mesh overlay; bgMode=0 is overlay-only."
  },

  /* HandKeyboard (v0.3.10) — MediaPipe hand tracking → musical scale.
   *
   * Same detector + ai-vision-canvas pipeline as HandLandmarker but
   * the resolver maps hand x-position (0..1 across the camera frame)
   * to a scale-degree index, then to a MIDI note + frequency. Outputs:
   *   gate (1 when hand tracked, 0 when not — drives envelope trigs)
   *   freq (Hz, the currently-pointed note)
   *   midi (the same note as a MIDI number, for downstream re-mapping)
   *   present (alias of gate)
   *   out  (camera + hand skeleton + scale-zone guide lines)
   *
   * Params:
   *   scaleRoot   MIDI note for the bottom-left zone (default 60 = C4)
   *   scaleMode   major | minor | pentatonic | chromatic
   *   octaves     1..4 (how many octaves span the camera horizontally)
   *   mirrored    1 = selfie cam flip (matches your hand to display)
   *
   * Wire freq → Sine.freq, gate → AD.trig: classic mono synth voice
   * controlled by hand position. Pentatonic mode + 2 octaves on a
   * spread arm-reach is comfortable for live "playing" gestures. */
  HandKeyboard: {
    category: "AI", color: COLOR.ai, header: null,
    cppType: "GammaHandKeyboardSource",
    helperClass:
`class GammaHandKeyboardSource {
    /* JS pushes gate / freq / midi each frame. operator()() returns
     * the struct so each downstream consumer reads its own field at
     * sample rate. note_idx is the integer step within the chosen
     * scale (0..totalSteps-1); useful for indexing wavetables /
     * triggering per-step events. */
    float v_[5] = {0};
public:
    void setPresent(float v)  { v_[0] = v; }
    void setGate(float v)     { v_[1] = v; }
    void setFreq(float v)     { v_[2] = v; }
    void setMidi(float v)     { v_[3] = v; }
    void setNoteIdx(float v)  { v_[4] = v; }
    struct Out { float present, gate, freq, midi, note_idx; };
    Out operator()() { return { v_[0], v_[1], v_[2], v_[3], v_[4] }; }
};`,
    kind: "ai-vision-canvas",
    // v0.3.11 — optional "video" texture input. When wired (from
    // Webcam / VideoFile / etc), MediaPipe samples the source's
    // underlying <video> element instead of opening own camera.
    ins: [{ n: "video", t: "texture" }],
    outs: [
      { n: "out",      t: "texture" },
      { n: "present",  t: "param", access: ".present"  },
      // gate intentionally typed as "audio" not "param" -- wires to
      // AD.trig / Env.trig (gate ports) accept audio-typed signals
      // via SIGNAL_PORT_TYPES, and an audio-typed gate output reads
      // sample-by-sample at the worklet's quantum so envelope retrig
      // happens within ~3ms of the hand entering / leaving frame.
      { n: "gate",     t: "audio", access: ".gate"     },
      { n: "freq",     t: "param", access: ".freq"     },
      { n: "midi",     t: "param", access: ".midi"     },
      { n: "note_idx", t: "param", access: ".note_idx" }
    ],
    params: {
      // Config / mapping (UI-only).
      scaleRoot: 60, scaleMode: "pentatonic", octaves: 2,
      maxHands: 1, minConfidence: 0.5, bgMode: 1, mirrored: 1,
      lineWidth: 2.5, dotRadius: 4,
      // Live values (JS-driven; auto-exposed).
      present: 0, gate: 0, freq: 220, midi: 60, note_idx: 0
    },
    methods: {
      scaleRoot: null, scaleMode: null, octaves: null,
      maxHands: null, minConfidence: null, bgMode: null, mirrored: null,
      lineWidth: null, dotRadius: null,
      present: "setPresent", gate: "setGate",
      freq: "setFreq", midi: "setMidi", note_idx: "setNoteIdx"
    },
    paramOptions: { scaleMode: ["major", "minor", "pentatonic", "chromatic"] },
    uiOnlyParams: [
      "scaleRoot", "scaleMode", "octaves",
      "maxHands", "minConfidence", "bgMode", "mirrored", "lineWidth", "dotRadius"
    ],
    autoExpose: ["present", "gate", "freq", "midi", "note_idx"],
    description: "MediaPipe hand tracking → musical scale. x-position across the camera selects a step in the chosen scale (major/minor/pentatonic/chromatic) over N octaves; outputs the matching gate + freq + MIDI note. Wire freq → Sine.freq and gate → AD.trig for a mono hand-synth voice. Camera + skeleton + scale-zone guide lines render to `out` so you can SEE where each note lives in the frame."
  },

  /* v0.3.37 -- BlobTracker. Classical-CV blob detection + temporal
   * tracking. Three detection modes: luma threshold (find bright OR
   * dark regions), color match (find pixels close to a target RGB),
   * and motion (frame-differencing to find moving regions). Connected-
   * components pass on a downsampled 160x90 mask gives stable per-
   * blob centroid + bounding box + area. Greedy nearest-neighbor
   * matching across frames assigns stable IDs to up to 4 simultaneous
   * blobs; exponential smoothing keeps positions stable.
   *
   * Same ai-vision-canvas pattern as MediaPipe landmarks but no ML
   * model -- just clean classical CV. Output ports follow the same
   * convention so wiring is consistent with HandLandmarker /
   * PoseLandmarker (present + numBlobs + bN_x / bN_y / bN_size).
   * Render path mirrors the landmarks too: source video as
   * background, bounding box + centroid + stable ID labelled on top,
   * with the standard mirror flag for selfie-cam UX. */
  BlobTracker: {
    category: "AI", color: COLOR.ai, header: null,
    cppType: "GammaBlobTrackerSource",
    helperClass:
`class GammaBlobTrackerSource {
    /* JS-driven value sink. Same shape as the MediaPipe landmark
     * sources -- each setter parks the latest detection field into
     * its slot; operator()() returns the whole struct so downstream
     * nodes read individual blobs via the codegen's outs[].access
     * pattern. */
    float v_[14] = {0};
public:
    void setPresent(float v)   { v_[0]  = v; }
    void setNumBlobs(float v)  { v_[1]  = v; }
    void setB1X(float v)       { v_[2]  = v; }
    void setB1Y(float v)       { v_[3]  = v; }
    void setB1Size(float v)    { v_[4]  = v; }
    void setB2X(float v)       { v_[5]  = v; }
    void setB2Y(float v)       { v_[6]  = v; }
    void setB2Size(float v)    { v_[7]  = v; }
    void setB3X(float v)       { v_[8]  = v; }
    void setB3Y(float v)       { v_[9]  = v; }
    void setB3Size(float v)    { v_[10] = v; }
    void setB4X(float v)       { v_[11] = v; }
    void setB4Y(float v)       { v_[12] = v; }
    void setB4Size(float v)    { v_[13] = v; }
    struct Out {
        float present, numBlobs,
              b1_x, b1_y, b1_size,
              b2_x, b2_y, b2_size,
              b3_x, b3_y, b3_size,
              b4_x, b4_y, b4_size;
    };
    Out operator()() {
        return { v_[0],  v_[1],  v_[2],  v_[3],  v_[4],
                 v_[5],  v_[6],  v_[7],  v_[8],  v_[9],
                 v_[10], v_[11], v_[12], v_[13] };
    }
};`,
    kind: "ai-vision-canvas",
    ins: [{ n: "video", t: "texture" }],
    outs: [
      { n: "out",       t: "texture" },
      { n: "present",   t: "param", access: ".present" },
      { n: "numBlobs",  t: "param", access: ".numBlobs" },
      { n: "b1_x",      t: "param", access: ".b1_x" },
      { n: "b1_y",      t: "param", access: ".b1_y" },
      { n: "b1_size",   t: "param", access: ".b1_size" },
      { n: "b2_x",      t: "param", access: ".b2_x" },
      { n: "b2_y",      t: "param", access: ".b2_y" },
      { n: "b2_size",   t: "param", access: ".b2_size" },
      { n: "b3_x",      t: "param", access: ".b3_x" },
      { n: "b3_y",      t: "param", access: ".b3_y" },
      { n: "b3_size",   t: "param", access: ".b3_size" },
      { n: "b4_x",      t: "param", access: ".b4_x" },
      { n: "b4_y",      t: "param", access: ".b4_y" },
      { n: "b4_size",   t: "param", access: ".b4_size" }
    ],
    params: {
      // UI-only config.
      mode: 0,                  // 0=luma, 1=color, 2=motion
      threshold: 0.6,           // luma threshold OR motion threshold (mode-dependent)
      targetR: 1.0, targetG: 0.2, targetB: 0.2,
      colorTolerance: 0.25,
      minBlobSize: 30,          // pixels in the 160x90 sample grid (~2% of frame)
      maxBlobs: 4,
      smoothing: 0.6,           // exponential alpha; 0 = no smoothing, 0.9 = heavy
      mirrored: 1,
      bgMode: 1,                // 0=clear, 1=video, 2=mask preview
      lineWidth: 2.5, dotRadius: 5,
      // Live (auto-exposed).
      present: 0, numBlobs: 0,
      b1_x: 0, b1_y: 0, b1_size: 0,
      b2_x: 0, b2_y: 0, b2_size: 0,
      b3_x: 0, b3_y: 0, b3_size: 0,
      b4_x: 0, b4_y: 0, b4_size: 0
    },
    methods: {
      mode: null, threshold: null,
      targetR: null, targetG: null, targetB: null, colorTolerance: null,
      minBlobSize: null, maxBlobs: null, smoothing: null,
      mirrored: null, bgMode: null, lineWidth: null, dotRadius: null,
      present: "setPresent", numBlobs: "setNumBlobs",
      b1_x: "setB1X", b1_y: "setB1Y", b1_size: "setB1Size",
      b2_x: "setB2X", b2_y: "setB2Y", b2_size: "setB2Size",
      b3_x: "setB3X", b3_y: "setB3Y", b3_size: "setB3Size",
      b4_x: "setB4X", b4_y: "setB4Y", b4_size: "setB4Size"
    },
    paramOptions: { mode: ["luma", "color", "motion", "value"] },
    uiOnlyParams: [
      "mode", "threshold", "targetR", "targetG", "targetB", "colorTolerance",
      "minBlobSize", "maxBlobs", "smoothing",
      "mirrored", "bgMode", "lineWidth", "dotRadius"
    ],
    autoExpose: [
      "present", "numBlobs",
      "b1_x", "b1_y", "b1_size",
      "b2_x", "b2_y", "b2_size",
      "b3_x", "b3_y", "b3_size",
      "b4_x", "b4_y", "b4_size"
    ],
    description: "Classical-CV blob tracker. Detects up to 4 simultaneous blobs via thresholded connected-components analysis on a downsampled 160×90 mask of the input. Four modes: 'luma' = Rec.709-weighted luminance (find bright spots in real-world video); 'color' = pixels within colorTolerance of (targetR, targetG, targetB) in RGB-distance space (find e.g. a red ball); 'motion' = frame-differencing on luma (any moving region above threshold); 'value' = max(R, G, B) per pixel — picks up SATURATED COLORS regardless of hue, where luma underweights red (0.21) and blue (0.07) into invisibility. Use 'value' for synthetic content like ShapeTunnel / Plasma / Butterflies where shapes are vivid colors. Per-blob outputs: x/y centroid in [0,1] UV and size as fraction of frame area. Greedy nearest-neighbor matching across frames assigns stable IDs; exponential smoothing on x/y/size keeps positions stable. minBlobSize is in 160×90 grid pixels (~14400 total; 30 = ~0.2% min coverage). Renders to `out` with the source video as background plus per-blob bounding box + centroid + ID label colored by HSL hue cycle. No ML model required -- runs on any browser, no permission prompts beyond getUserMedia."
  },

  /* Gradient — 2-color linear blend along a configurable angle.
   * Eight params: angle (radians), rA/gA/bA (start color), rB/gB/bB
   * (end color). Useful as a backdrop or as a luma source for masks
   * once composition shaders ship. */
  Gradient: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins:  [
      { n: "angle", t: "param" },
      { n: "rA",    t: "param" },
      { n: "gA",    t: "param" },
      { n: "bA",    t: "param" },
      { n: "rB",    t: "param" },
      { n: "gB",    t: "param" },
      { n: "bB",    t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      angle: 0.0,
      rA: 0.05, gA: 0.10, bA: 0.20,
      rB: 0.85, gB: 0.55, bB: 0.20
    },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  colorA:       vec4f,
  colorB:       vec4f,
  angleAndPad:  vec4f,    // x = angle (radians); yzw unused
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
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
  // Map local uv [0,1] into the rig's master canvas via this
  // display's u_world_uv slice. For single-display rigs world_uv
  // == in.uv (slice covers [0,1]); for multi-display rigs the
  // gradient renders as ONE continuous gradient across the whole
  // rig, with the seam landing wherever displays meet on the
  // master canvas.
  let world_uv = mix(u.u_world_uv.xy, u.u_world_uv.zw, in.uv);
  let angle = u.angleAndPad.x;
  let dir = vec2f(cos(angle), sin(angle));
  let centered = world_uv - vec2f(0.5);
  let t = clamp(dot(centered, dir) + 0.5, 0.0, 1.0);
  return mix(u.colorA, u.colorB, t);
}`,
    writeUniforms(node, scratch) {
      // 112-byte buffer = 28 f32 indices. WGSL struct alignment with
      // angleAndPad as the trailing vec4 (instead of a stray vec3
      // after a scalar — vec3 has align 16 in WGSL even though it
      // only carries 12 bytes, which would balloon the struct to 128
      // and mismatch the buffer size).
      //   bytes  0–15  / indices  0–3   → u_resolution    (preamble)
      //   bytes 16–19  / index    4     → u_time          (preamble)
      //   bytes 20–23  / index    5     → u_dt            (preamble)
      //   bytes 24–31  / indices  6–7   → _pad0           (preamble)
      //   bytes 32–47  / indices  8–11  → u_view          (preamble)
      //   bytes 48–63  / indices 12–15  → u_world_uv      (preamble)
      //   bytes 64–79  / indices 16–19  → colorA          (user)
      //   bytes 80–95  / indices 20–23  → colorB          (user)
      //   bytes 96–111 / indices 24–27  → angleAndPad     (user; .x = angle)
      const p = node.params || {};
      scratch[16] = (typeof p.rA === "number") ? p.rA : 0.05;
      scratch[17] = (typeof p.gA === "number") ? p.gA : 0.10;
      scratch[18] = (typeof p.bA === "number") ? p.bA : 0.20;
      scratch[19] = 1.0;
      scratch[20] = (typeof p.rB === "number") ? p.rB : 0.85;
      scratch[21] = (typeof p.gB === "number") ? p.gB : 0.55;
      scratch[22] = (typeof p.bB === "number") ? p.bB : 0.20;
      scratch[23] = 1.0;
      scratch[24] = (typeof p.angle === "number") ? p.angle : 0.0;
      scratch[25] = 0;
      scratch[26] = 0;
      scratch[27] = 0;
    },
    description: "Linear gradient — interpolates colorA → colorB along an angle (radians). Default is dark teal → warm amber along +x. r/g/b each ∈ [0, 1]; angle wraps 0..2π. Wire into VisualOutput for a moving sunset backdrop (animate angle from a clock signal once 6.5's bridge nodes ship)."
  },

  /* MeshTest — calibration grid pattern. White grid lines + center
   * crosshair + colored corner quadrants (R / G / B / Y) so the
   * operator can verify warp + projection orientation at a glance.
   * Different from a generic checker pattern: every cell carries
   * orientation info (which corner you're looking at), so during
   * warp editing you can tell "the top-left of the source image
   * lands HERE" without ambiguity. */
  MeshTest: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins:  [
      { n: "density",   t: "param" },   // grid lines per unit (1..32)
      { n: "lineWidth", t: "param" },   // 0..0.05 in UV
      { n: "brightness",t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      density:    8,
      lineWidth:  0.006,
      brightness: 1.0
    },
    methods: {},
    uniformBytes: 80,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,    // x = density, y = lineWidth, z = brightness, w = _
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
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
  // Use world_uv so a SHARED-consumer MeshTest spans the whole rig
  // continuously — same idiom as Gradient. Solo-consumer collapses
  // world_uv to in.uv which fills one display.
  let wuv = mix(u.u_world_uv.xy, u.u_world_uv.zw, in.uv);

  let density    = max(u.params.x, 1.0);
  let lineWidth  = clamp(u.params.y, 0.0001, 0.05);
  let brightness = max(u.params.z, 0.0);

  // Quadrant tinting — R top-left, G top-right, B bottom-left,
  // Y bottom-right. Soft so the grid lines stay legible on top.
  let leftHalf = step(wuv.x, 0.5);
  let topHalf  = step(wuv.y, 0.5);
  let tintR = vec3<f32>(0.55, 0.10, 0.10) * leftHalf       * topHalf;
  let tintG = vec3<f32>(0.10, 0.55, 0.10) * (1.0-leftHalf) * topHalf;
  let tintB = vec3<f32>(0.10, 0.10, 0.55) * leftHalf       * (1.0-topHalf);
  let tintY = vec3<f32>(0.55, 0.50, 0.10) * (1.0-leftHalf) * (1.0-topHalf);
  var col = tintR + tintG + tintB + tintY;

  // Major grid lines: white, lit when fract(uv * density) is within
  // lineWidth of an integer.
  let g = fract(wuv * density);
  let dist = min(g, 1.0 - g);
  let line = smoothstep(lineWidth, 0.0, min(dist.x, dist.y));
  col = mix(col, vec3<f32>(1.0), line * 0.85);

  // Center crosshair (at world UV 0.5) drawn brighter so the user
  // can find "true center" through warp deformation.
  let cdist = abs(wuv - vec2<f32>(0.5));
  let cross = step(min(cdist.x, cdist.y), lineWidth * 1.6);
  col = mix(col, vec3<f32>(0.95, 1.0, 0.65), cross * 0.7);

  // Edge frame so the display boundary reads even after warp.
  let edge = max(
    step(wuv.x, lineWidth) + step(1.0 - lineWidth, wuv.x),
    step(wuv.y, lineWidth) + step(1.0 - lineWidth, wuv.y)
  );
  col = mix(col, vec3<f32>(1.0), clamp(edge, 0.0, 1.0));

  return vec4<f32>(col * brightness, 1.0);
}`,
    writeUniforms(node, scratch) {
      // 80-byte buffer = 20 f32 indices.
      //   indices  0–7   → preamble
      //   indices  8–11  → u_view
      //   indices 12–15  → u_world_uv
      //   indices 16–19  → params (density, lineWidth, brightness, _)
      const p = node.params || {};
      scratch[16] = (typeof p.density    === "number") ? p.density    : 8;
      scratch[17] = (typeof p.lineWidth  === "number") ? p.lineWidth  : 0.006;
      scratch[18] = (typeof p.brightness === "number") ? p.brightness : 1.0;
      scratch[19] = 0;
    },
    description: "Calibration grid — colored corner quadrants (R/G/B/Y) + white grid lines + center crosshair + edge frame. Wire into VisualOutput to verify warp meshes, edge blends, and projection orientation. params: density (grid lines per unit, 1..32), lineWidth (UV thickness 0..0.05), brightness."
  },

  /* Phase 6.4 — Plasma. Classic demoscene effect: four sinusoids
   * combined into a colorful ripple. speed / scale / paletteOffset
   * params drive animation rate / wavelength / hue rotation. */
  Plasma: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins:  [
      { n: "speed",         t: "param" },
      { n: "scale",         t: "param" },
      { n: "paletteOffset", t: "param" },
      // Phase 6.5.2 — audio reactivity (master output peak).
      { n: "audioReact",    t: "param" },
      // Phase 6.5.3 — bass-band reactivity from FFT bins 0..7
      // (~20-80 Hz). Kick drums pulse plasma independent of level.
      { n: "bassReact",     t: "param" },
      // Phase 6.5.4 — clock-driven speed boost. Wire MasterClock.beat
      // here for a cubic-decay pulse on every beat; MasterClock.phase
      // for a continuous 0..1 ramp per beat. Manual constant in the
      // props panel also works. Typed `clock` so the cyan double-line
      // wire reads visually as a tempo connection.
      { n: "clockReact",    t: "clock" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: { speed: 1.0, scale: 1.0, paletteOffset: 0.0, audioReact: 0.0, bassReact: 0.0, clockReact: 0.0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,    // x=speed, y=scale, z=paletteOffset, w=audioReact
  params2:      vec4f,    // x=bassReact, y=clockReact, zw=_
};
@group(0) @binding(0) var<uniform> u: U;

// Phase 6.5.2 / 6.5.3 / 6.5.4 — audio uniform.
//   values[0].x   = worklet master output peak this quantum (0..1)
//   values[0].yzw, values[1..2.zyx] reserved for future audio-rate slots
//   values[2].w   = MasterClock bpm                  (raw, e.g. 120.0)
//   values[3].x   = MasterClock bar       envelope   (1 at downbeat -> ~0 between bars)
//   values[3].y   = MasterClock beat      envelope   (1 at every beat)
//   values[3].z   = MasterClock sixteenth envelope   (1 every 1/16 note)
//   values[3].w   = MasterClock phase (0..1 ramp per beat, continuous)
//   fft[k/4][k%4] = 256 log-spaced FFT magnitude bins (0..1)
// The clock slots are populated by the first MasterClock node in the
// patch (none -> zero). Any shader can read u_audio.values[3].y for
// "pulse on every beat" without needing a wired clockReact param.
// The wired path (e.g. MasterClock.beat -> Plasma.clockReact) still
// works -- it just lives in u.params2.y instead of u_audio.
struct AudioU {
  values: array<vec4<f32>, 4>,
  fft:    array<vec4<f32>, 64>,
};
@group(0) @binding(3) var<uniform> u_audio: AudioU;

// Read FFT bin k (0..255) as a scalar.
fn fft_bin(k: u32) -> f32 {
  let v = u_audio.fft[k / 4u];
  let lane = k & 3u;
  if (lane == 0u) { return v.x; }
  if (lane == 1u) { return v.y; }
  if (lane == 2u) { return v.z; }
  return v.w;
}

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let world_uv = mix(u.u_world_uv.xy, u.u_world_uv.zw, in.uv);
  let p = (world_uv - vec2f(0.5)) * u.params.y * 8.0;
  // params.w = audioReact, params2.x = bassReact, params2.y = clockReact.
  // peak_speed: scales with the master-peak audio bridge slot;
  // bass_speed: average of FFT bins 0..7 (~20-80 Hz) -- kick drums;
  // clock_speed: the clockReact value AS-IS. When MasterClock.beat
  //   is wired to Plasma.clockReact, the framework substitutes a
  //   cubic-decay beat envelope (1 at downbeat, ~0 between beats),
  //   producing the same on-the-beat pulse. When MasterClock.phase
  //   is wired instead, it's a continuous 0..1 ramp per beat. Or
  //   manual constant via the props panel.
  let peak_speed = u.params.w * u_audio.values[0].x;
  var bass: f32 = 0.0;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { bass = bass + fft_bin(i); }
  bass = bass * 0.125;
  let bass_speed = u.params2.x * bass;
  let clock_speed = u.params2.y;
  let t = u.u_time * (u.params.x + peak_speed + bass_speed + clock_speed);
  var v: f32 = 0.0;
  v = v + sin(p.x * 1.5 + t);
  v = v + sin(p.y * 1.5 + t * 1.3);
  v = v + sin((p.x + p.y) * 1.5 + t * 0.7);
  v = v + sin(sqrt(p.x * p.x + p.y * p.y) * 1.5 - t);
  v = v * 0.25;
  let phase = v * 3.14159265 + u.params.z;
  let r = sin(phase)             * 0.5 + 0.5;
  let g = sin(phase + 2.094395)  * 0.5 + 0.5;
  let b = sin(phase + 4.188790)  * 0.5 + 0.5;
  return vec4f(r, g, b, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.speed         === "number") ? p.speed         : 1.0;
      scratch[17] = (typeof p.scale         === "number") ? p.scale         : 1.0;
      scratch[18] = (typeof p.paletteOffset === "number") ? p.paletteOffset : 0.0;
      scratch[19] = (typeof p.audioReact    === "number") ? p.audioReact    : 0.0;
      scratch[20] = (typeof p.bassReact     === "number") ? p.bassReact     : 0.0;
      scratch[21] = (typeof p.clockReact    === "number") ? p.clockReact    : 0.0;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "Plasma — classic demoscene 4-sinusoid color ripple. Animates with u_time × speed; scale controls wavelength; paletteOffset rotates the hue mapping. audioReact (Phase 6.5.2): scales the audio master peak into the animation speed. bassReact (Phase 6.5.3): same but from FFT bins 0..7 (~20-80 Hz). clockReact (Phase 6.5.4): added directly to the speed term — wire MasterClock.beat → Plasma.clockReact for an on-the-beat cubic-decay pulse, MasterClock.phase for a continuous 0..1 ramp per beat, or set a manual constant in the props panel. Single MasterClock per patch drives all visual + audio nodes."
  },

  /* Phase 6.4 — Checkerboard. Two-color N×N grid. Used for
   * orientation tests, retro patterns, and as a backdrop layer for
   * compositions. UV space is the world (rig-spanning) so a SHARED
   * shader across multiple displays produces one continuous board. */
  Checkerboard: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins:  [
      { n: "size", t: "param" },
      { n: "mode", t: "param" },
      { n: "rA",   t: "param" },
      { n: "gA",   t: "param" },
      { n: "bA",   t: "param" },
      { n: "rB",   t: "param" },
      { n: "gB",   t: "param" },
      { n: "bB",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      size: 24,
      mode: 3,                                // 0 = HEALPix, 1 = Lambert, 2 = cube, 3 = octahedral (default), 4 = cosine-corrected lat/long
      rA: 0.92, gA: 0.92, bA: 0.92,
      rB: 0.08, gB: 0.08, bB: 0.08
    },
    methods: {},
    uniformBytes: 144,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,    // (yaw, pitch, roll, fov_h_deg)
  u_world_uv:    vec4f,
  colorA:        vec4f,
  colorB:        vec4f,
  sizeAndPad:    vec4f,    // x=size (cells around 360° azimuth), yzw=_
  // Phase 6.6.20.3 — surface-aware shader uniforms.
  u_surface:     vec4f,    // (type, radius, param_a, param_b)
  u_surface_path: vec4f,   // (yawStart, yawEnd, _, _)
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// Convert a fragment's framebuffer UV to global (yaw, pitch) on the
// rig sphere. Uses the inverse gnomonic projection of a perspective
// projector at the rig center: a UV maps to a 3D ray, the ray's
// (yaw, pitch) is its angular direction on the sphere. Linear-fov
// approximation breaks down at large fov; atan() recovers the
// correct angle from any fov (including 90° cube-face displays).
fn frag_to_global_angles(uv: vec2f) -> vec2f {
  // 6.6.20.24 — proper gnomonic-to-sphere math via projector basis
  // rotation. The previous form added atan(local_x) to yaw and
  // atan(local_y) to pitch independently, which is only correct
  // when the projector points along the equator (pitch=0). For
  // tilted projectors (AlloSphere top / bottom rings, polar caps)
  // this caused adjacent projectors to compute different (yaw,
  // pitch) for the same world point at their shared boundary —
  // the visible X-shape crosses + doubled lines in calibration
  // captures.
  //
  // Correct math: build the projector's world basis (right, up,
  // forward) from its pose, rotate the fragment's local direction
  // (local_x along right, local_y along up, +1 forward) into world
  // space, then re-extract (yaw, pitch). Identical results across
  // every projector that shares a boundary point.
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  // Convention: yaw=0 forward = +Z; yaw=+90 = +X; pitch=+90 = +Y.
  let fwd = vec3f(sy * cp, sp, cy * cp);
  // Up reference flips to +Z near the poles to keep the cross
  // product non-degenerate (looking straight up, world Y becomes
  // co-linear with forward).
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  let dir = normalize(local_x * right + local_y * up + fwd);
  let pitch_out = asin(clamp(dir.y, -1.0, 1.0));
  let yaw_out   = atan2(dir.x, dir.z);
  // 57.29577951 = 180 / PI.
  return vec2f(yaw_out * 57.29577951, pitch_out * 57.29577951);
}

// Phase 6.6.20.4 — HEALPix RING pixelization.
// "Hierarchical Equal Area isoLatitude Pixelization" (Górski et al.
// 2005, doi:10.1086/427976). The de-facto standard in cosmology +
// astronomy for equal-solid-angle sphere tessellation. Each pixel
// has identical area = 4π/(12·nside²); cells follow iso-latitude
// rings → no axis-aligned seams (unlike cube map), no polar
// bunching (unlike equirect), no cube edges (unlike Path B Lambert).
//
// Reference: https://healpix.sourceforge.io/
//            https://en.wikipedia.org/wiki/HEALPix
//            Górski, K. M. et al., "HEALPix: A Framework for
//              High-Resolution Discretization and Fast Analysis
//              of Data Distributed on the Sphere," ApJ 622:759 (2005).
//
// Returns vec2<i32>(ring_global, pix_in_ring) where:
//   ring_global ∈ [1, 4·nside-1]  (ring number from north pole)
//   pix_in_ring ∈ [0, ring_pixel_count)
//
// (ring + pix_in_ring) parity gives a clean 2-color checker that
// alternates both within a ring AND across rings. HEALPix cells are
// diamond-shaped at the equator transitioning to triangular at the
// poles; with this parity rule the checker reads visually clean.
fn healpix_ang2cell(theta: f32, phi: f32, nside: i32) -> vec2<i32> {
  let z  = cos(theta);
  let za = abs(z);
  // tt = phi / (π/2), wrapped to [0, 4).
  let TWO_PI = 6.28318530718;
  let phi_n = phi - TWO_PI * floor(phi / TWO_PI);
  let tt = phi_n * 0.6366197723675814;   // 2/π
  if (za <= 0.6666666666666667) {
    // Equatorial belt — 2·nside+1 rings, each with 4·nside pixels.
    let nside_f = f32(nside);
    let temp1 = nside_f * (0.5 + tt);
    let temp2 = nside_f * z * 0.75;
    let jp = i32(floor(temp1 - temp2));
    let jm = i32(floor(temp1 + temp2));
    let ir = nside + 1 + jp - jm;          // ring offset within belt, 1..2·nside+1
    let kshift = 1 - (ir & 1);
    // Floor division by 2 — WGSL int / rounds toward zero, so go via
    // float floor to get math floor for negative numerators.
    let num = jp + jm - nside + kshift + 1;
    var ip = i32(floor(f32(num) * 0.5));
    let ppr = 4 * nside;
    ip = ((ip % ppr) + ppr) % ppr;
    let ring_global = nside + ir - 1;      // global ring index from north pole
    return vec2<i32>(ring_global, ip);
  }
  // Polar caps — pixel count grows from 4 at pole-adjacent ring to
  // 4·(nside-1) at the last cap ring.
  let tp = tt - floor(tt);
  let tmp = f32(nside) * sqrt(3.0 * (1.0 - za));
  let jp = i32(floor(tp * tmp));
  let jm = i32(floor((1.0 - tp) * tmp));
  let ir = jp + jm + 1;                    // ring from pole, 1..nside-1
  var ip = i32(floor(tt * f32(ir)));
  let four_ir = 4 * ir;
  if (ip >= four_ir) { ip = ip - four_ir; }
  if (ip < 0)        { ip = ip + four_ir; }
  if (z > 0.0) {
    return vec2<i32>(ir, ip);              // north cap: ring counts from north pole
  }
  return vec2<i32>(4 * nside - ir, ip);    // south cap: convert to global ring
}

// Phase 6.6.20.3 — surface-aware equal-area normalization (Lambert).
// Maps a (yaw, pitch) global direction to (u, v) ∈ [0, 1]² using the
// natural surface parameterization:
//   sphere / swept-arc / no-surface → (yaw_norm, sin(pitch)_norm)
//                                      Lambert cylindrical equal-area;
//                                      cells uniform in solid angle.
//   cylinder / swept-vertical       → (yaw_norm, y_clamped_norm)
//                                      cells uniform in arc-length × Y.
fn surface_uv_norm(yaw_deg: f32, pitch_deg: f32) -> vec2f {
  let stype = u32(u.u_surface.x + 0.5);
  let yawStart = u.u_surface_path.x;
  let yawEnd   = u.u_surface_path.y;
  let yawSpan  = max(yawEnd - yawStart, 0.001);
  let yawWrap  = yaw_deg - 360.0 * floor((yaw_deg - yawStart) / 360.0);
  let u_norm   = (yawWrap - yawStart) / yawSpan;
  var v_norm: f32 = 0.5;
  if (stype == 2u || stype == 4u) {
    // Cylinder / swept-vertical: y at intersection = R·tan(pitch),
    // clamped to [yMin, yMax]. Linear in y → uniform area on cylinder.
    let R    = u.u_surface.y;
    let yMin = u.u_surface.z;
    let yMax = u.u_surface.w;
    let pitchRad = pitch_deg * 0.01745329;
    let cosP = cos(pitchRad);
    var cy: f32 = 0.0;
    if (abs(cosP) > 1e-4) {
      cy = R * tan(pitchRad);
    } else {
      // Near-vertical ray → clamp to nearest cap
      cy = sign(pitch_deg) * (abs(yMax) + abs(yMin)) * 100.0;
    }
    let cyClamped = clamp(cy, yMin, yMax);
    v_norm = (cyClamped - yMin) / max(yMax - yMin, 0.001);
  } else {
    // Sphere / swept-arc / no-surface: equal-area v = sin(pitch).
    var pStart: f32 = -90.0;
    var pEnd:   f32 =  90.0;
    if (stype == 3u) {
      pStart = u.u_surface.z;
      pEnd   = u.u_surface.w;
    }
    let sinStart = sin(pStart * 0.01745329);
    let sinEnd   = sin(pEnd   * 0.01745329);
    let sinP     = sin(pitch_deg * 0.01745329);
    v_norm = (sinP - sinStart) / max(sinEnd - sinStart, 0.001);
  }
  return vec2f(u_norm, v_norm);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Phase 6.6.20.4 — HEALPix is the default cell tessellation.
  // sizeAndPad.y = mode: 0 = HEALPix (uniform-equal-area, this commit),
  //                       1 = Lambert equal-area cylindrical (Path B
  //                           from 6.6.20.3),
  //                       2 = legacy cube-mapped (6.6.17 fallback).
  //
  // HEALPix gives genuinely uniform cells on the sphere with NO
  // axis-aligned seams — a single connected pixelization with
  // diamond-shaped cells at the equator transitioning smoothly to
  // triangular cells at the poles. Cells are equal solid angle =
  // 4π/(12·nside²). Default mode for surface-aware Checkerboard.
  let mode = i32(u.sizeAndPad.y + 0.5);
  let ang  = frag_to_global_angles(in.uv);
  let size = max(u.sizeAndPad.x, 4.0);
  if (mode == 0) {
    // HEALPix RING pixelization. nside = size/4 → 4·nside pixels
    // around the equator (matches the user's 'size' mental model
    // of "cells around the equator").
    let nside = max(1, i32(floor(size * 0.25 + 0.5)));
    let theta = (90.0 - ang.y) * 0.01745329;   // colatitude (north pole = 0)
    let phi   = ang.x * 0.01745329 + 3.14159265;
    let cell  = healpix_ang2cell(theta, phi, nside);
    let parity = (cell.x + cell.y) & 1;        // (ring + pix_in_ring) parity
    return select(u.colorB, u.colorA, parity == 0);
  }
  if (mode == 1) {
    // Lambert equal-area (Path B from 6.6.20.3) with polar-cap
    // mitigation. The Lambert sin-pitch substitution is mathematically
    // perfect equal-area, but at v→0 or v→1 the cells degenerate
    // visually into thin pizza slices that read as a singular dot
    // at the pole. Fix: in the topmost + bottommost bands, halve
    // the yaw cell count (cells become wider in those bands). Each
    // halving step keeps the cells roughly square in solid-angle
    // dimensions and removes the visible point-singularity.
    let uv = surface_uv_norm(ang.x, ang.y);
    let v_size = max(2.0, floor(size * 0.5 + 0.5));
    let cellV = floor(uv.y * v_size);
    // How close to either pole — 0 at equator, ~v_size/2 at poles.
    let pole_dist = abs(cellV - (v_size - 1.0) * 0.5);
    let pole_max  = (v_size - 1.0) * 0.5;
    // For the outermost 2 bands on each side, divide h_cells by 2;
    // for the very edge band, divide by 4. Keeps it even (parity
    // alternates correctly within rings).
    var h_div: f32 = 1.0;
    if (pole_dist > pole_max - 0.1)        { h_div = 4.0; }
    else if (pole_dist > pole_max - 1.1)   { h_div = 2.0; }
    let h_cells = max(2.0, floor(size / h_div + 0.5));
    let cellU = floor(uv.x * h_cells);
    let parity = (i32(cellU) + i32(cellV)) & 1;
    return select(u.colorB, u.colorA, parity == 0);
  }
  // mode == 2: legacy cube-mapped (6.6.17 fallback).
  let yr2 = ang.x * 0.01745329;
  let pr2 = ang.y * 0.01745329;
  let dx2 = sin(yr2) * cos(pr2);
  let dy2 = sin(pr2);
  let dz2 = cos(yr2) * cos(pr2);
  let absX = abs(dx2);
  let absY = abs(dy2);
  let absZ = abs(dz2);
  if (mode == 4) {
    // Phase 6.6.20.6 — COSINE-CORRECTED LAT/LONG.
    // The Bourke aesthetic: discrete cell count per latitude band,
    // adjusted by cos(latitude) so cells stay roughly square in
    // solid-angle dimensions. Visible row-step transitions where
    // adjacent rows have different cell counts (e.g. equator has
    // 24, mid-lat has 20, polar band has 4). Closest match to the
    // user's Bourke checker reference image.
    let v_cells4 = max(2.0, floor(size * 0.5 + 0.5));
    let pitch_norm = clamp((ang.y + 90.0) / 180.0, 0.0, 0.99999);
    let cellV4 = floor(pitch_norm * v_cells4);
    let band_pitch_deg = (cellV4 + 0.5) / v_cells4 * 180.0 - 90.0;
    let cos_lat = max(0.001, cos(band_pitch_deg * 0.01745329));
    let h_cells = max(2.0, floor(size * cos_lat * 0.5 + 0.5) * 2.0);
    let yaw_norm = clamp((ang.x + 180.0) / 360.0, 0.0, 0.99999);
    let cellU4 = floor(yaw_norm * h_cells);
    let parity4 = (i32(cellU4) + i32(cellV4)) & 1;
    return select(u.colorB, u.colorA, parity4 == 0);
  }
  if (mode == 3) {
    // Phase 6.6.20.6 — OCTAHEDRAL mapping. Folds the sphere onto an
    // octahedron, then onto a single 2D square. Cells are
    // approximately equal-area on the sphere (~5x variation, not
    // perfectly uniform — Engelhardt & Dachsbacher 2008,
    // "Octahedron Environment Maps"). ONE visible seam at the y=0
    // great circle where the bottom hemisphere is folded outward;
    // otherwise no axis seams, no polar singularity, and roughly
    // square cells everywhere.
    //
    // Algorithm: L1-normalize the direction (|x|+|y|+|z|=1), then
    // project to a unit square. For y >= 0 (top hemisphere), use
    // (x, z) directly. For y < 0 (bottom hemisphere), reflect across
    // the diagonals: (x, z) → ((1 - |z|)·sign(x), (1 - |x|)·sign(z)).
    // This gives a continuous mapping covering the whole sphere on
    // a [-1, 1]² square.
    let sumAbs = absX + absY + absZ;
    let n = vec3f(dx2, dy2, dz2) / max(sumAbs, 1e-6);
    var oct = vec2f(n.x, n.z);
    if (n.y < 0.0) {
      let signX = select(-1.0, 1.0, oct.x >= 0.0);
      let signZ = select(-1.0, 1.0, oct.y >= 0.0);
      oct = vec2f((1.0 - abs(oct.y)) * signX, (1.0 - abs(oct.x)) * signZ);
    }
    let oct_uv = oct * 0.5 + 0.5;            // [0, 1]²
    let cellU3 = floor(oct_uv.x * size);
    let cellV3 = floor(oct_uv.y * size);
    let parity3 = (i32(cellU3) + i32(cellV3)) & 1;
    return select(u.colorB, u.colorA, parity3 == 0);
  }
  // mode == 2: cube
  var faceU: f32 = 0.0;
  var faceV: f32 = 0.0;
  if (absX >= absY && absX >= absZ) {
    faceU = dz2 / dx2; faceV = dy2 / absX;
  } else if (absY >= absZ) {
    faceU = dx2 / absY; faceV = dz2 / dy2;
  } else {
    faceU = dx2 / dz2; faceV = dy2 / absZ;
  }
  let N = max(1.0, floor(size * 0.25 + 0.5));
  let cellU2 = floor((faceU + 1.0) * 0.5 * N);
  let cellV2 = floor((faceV + 1.0) * 0.5 * N);
  let parity2 = (i32(cellU2) + i32(cellV2)) & 1;
  return select(u.colorB, u.colorA, parity2 == 0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      // colorA at 16-19, colorB at 20-23, sizeAndPad at 24-27.
      // sizeAndPad: x = size, y = mode (0/1/2), z/w = reserved.
      // 6.6.20.3 — u_surface at 28-31, u_surface_path at 32-35.
      scratch[16] = (typeof p.rA === "number") ? p.rA : 0.92;
      scratch[17] = (typeof p.gA === "number") ? p.gA : 0.92;
      scratch[18] = (typeof p.bA === "number") ? p.bA : 0.92;
      scratch[19] = 1.0;
      scratch[20] = (typeof p.rB === "number") ? p.rB : 0.08;
      scratch[21] = (typeof p.gB === "number") ? p.gB : 0.08;
      scratch[22] = (typeof p.bB === "number") ? p.bB : 0.08;
      scratch[23] = 1.0;
      scratch[24] = (typeof p.size === "number") ? p.size : 24;
      scratch[25] = (typeof p.mode === "number") ? p.mode : 0;
      scratch[26] = 0; scratch[27] = 0;
      _packSurfaceUniforms(scratch, 28);
    },
    description: "Checkerboard — uniform cells on the rig's screen surface. mode: 0 = HEALPix (Górski 2005 — equal-area diamond cells, herringbone aesthetic); 1 = Lambert cylindrical (sin-pitch, polar-cap halving); 2 = cube-mapped (6 face seams); 3 = octahedral (default — single seam at equator, square cell shapes, roughly equal-area); 4 = cosine-corrected lat/long (Bourke aesthetic — discrete cells-per-row, row-step seams, closest to classic sphere-checker references). size: cells around the equator. See docs/HEALPIX.md for the math + tradeoffs."
  },

  /* Phase 6.4 — Voronoi. Cellular noise with edge highlighting and
   * per-cell randomized colors. density controls cell count per
   * world-UV unit; edgeThickness widens the dark borders; seed lets
   * the user dial in a different cell pattern. */
  Voronoi: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins:  [
      { n: "density",       t: "param" },
      { n: "edgeThickness", t: "param" },
      { n: "seed",          t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: { density: 24, edgeThickness: 0.08, seed: 0.5 },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=density (cells around 360°), y=edgeThickness, z=seed, w=_
  // Phase 6.6.20.3 — surface-aware uniforms.
  u_surface:     vec4f,    // (type, radius, param_a, param_b)
  u_surface_path: vec4f,   // (yawStart, yawEnd, _, _)
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn hash22(p: vec2f) -> vec2f {
  let h = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(h) * 43758.5453123);
}

fn frag_to_global_angles(uv: vec2f) -> vec2f {
  // 6.6.20.24 — proper gnomonic→sphere via projector basis rotation
  // (see WireframeCalibration shader for full comment).
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  let fwd = vec3f(sy * cp, sp, cy * cp);
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  let dir = normalize(local_x * right + local_y * up + fwd);
  let pitch_out = asin(clamp(dir.y, -1.0, 1.0));
  let yaw_out   = atan2(dir.x, dir.z);
  return vec2f(yaw_out * 57.29577951, pitch_out * 57.29577951);
}

// Phase 6.6.20.3 — surface-aware equal-area helper. Same as
// Checkerboard's; duplicated because each WGSL body is a self-
// contained module (no cross-shader linkage in inline WGSL).
fn surface_uv_norm(yaw_deg: f32, pitch_deg: f32) -> vec2f {
  let stype = u32(u.u_surface.x + 0.5);
  let yawStart = u.u_surface_path.x;
  let yawEnd   = u.u_surface_path.y;
  let yawSpan  = max(yawEnd - yawStart, 0.001);
  let yawWrap  = yaw_deg - 360.0 * floor((yaw_deg - yawStart) / 360.0);
  let u_norm   = (yawWrap - yawStart) / yawSpan;
  var v_norm: f32 = 0.5;
  if (stype == 2u || stype == 4u) {
    let R    = u.u_surface.y;
    let yMin = u.u_surface.z;
    let yMax = u.u_surface.w;
    let pitchRad = pitch_deg * 0.01745329;
    let cosP = cos(pitchRad);
    var cy: f32 = 0.0;
    if (abs(cosP) > 1e-4) {
      cy = R * tan(pitchRad);
    } else {
      cy = sign(pitch_deg) * (abs(yMax) + abs(yMin)) * 100.0;
    }
    v_norm = (clamp(cy, yMin, yMax) - yMin) / max(yMax - yMin, 0.001);
  } else {
    var pStart: f32 = -90.0;
    var pEnd:   f32 =  90.0;
    if (stype == 3u) {
      pStart = u.u_surface.z;
      pEnd   = u.u_surface.w;
    }
    let sinStart = sin(pStart * 0.01745329);
    let sinEnd   = sin(pEnd   * 0.01745329);
    let sinP     = sin(pitch_deg * 0.01745329);
    v_norm = (sinP - sinStart) / max(sinEnd - sinStart, 0.001);
  }
  return vec2f(u_norm, v_norm);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Phase 6.6.20.3 — SURFACE-AWARE EQUAL-AREA Voronoi.
  // Cells distributed equally on the physical screen surface using
  // the same Lambert cylindrical equal-area parameterization as
  // Checkerboard. Sphere/swept-arc → uniform solid-angle cells;
  // cylinder/swept-vertical → uniform arc-length × Y cells. The 3x3
  // neighbor scan happens in local cell coords; visible only as a
  // thin seam at the yaw boundary or near the pole row, identical
  // to Checkerboard's seams.
  let ang   = frag_to_global_angles(in.uv);
  let suv   = surface_uv_norm(ang.x, ang.y);
  let density = max(u.params.x, 1.0);
  let v_density = max(2.0, floor(density * 0.5 + 0.5));
  let scaled = vec2f(suv.x * density, suv.y * v_density);
  let cell = floor(scaled);
  let frag = scaled - cell;
  let seed = vec2f(u.params.z, u.params.z * 1.7);
  var minDist:  f32 = 9999.0;
  var minDist2: f32 = 9999.0;
  var minCell:  vec2f = vec2f(0.0);
  for (var y: i32 = -1; y <= 1; y = y + 1) {
    for (var x: i32 = -1; x <= 1; x = x + 1) {
      let off = vec2f(f32(x), f32(y));
      let pt = off + hash22(cell + off + seed);
      let d = length(frag - pt);
      if (d < minDist)       { minDist2 = minDist; minDist = d; minCell = cell + off; }
      else if (d < minDist2) { minDist2 = d; }
    }
  }
  let edge = smoothstep(0.0, max(u.params.y, 0.001), minDist2 - minDist);
  let cellHash = hash22(minCell + seed);
  let r = cellHash.x;
  let g = cellHash.y;
  let b = fract(cellHash.x + cellHash.y);
  return vec4f(vec3f(r, g, b) * edge, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      // params at 16-19. 6.6.20.3 — u_surface at 20-23, u_surface_path at 24-27.
      scratch[16] = (typeof p.density       === "number") ? p.density       : 8;
      scratch[17] = (typeof p.edgeThickness === "number") ? p.edgeThickness : 0.05;
      scratch[18] = (typeof p.seed          === "number") ? p.seed          : 0.5;
      scratch[19] = 0;
      _packSurfaceUniforms(scratch, 20);
    },
    description: "Voronoi cellular noise — surface-aware equal-area cells on the rig screen (sphere/cylinder/swept). F2-F1 edge highlighting + per-cell random color. density: cells around the equator. edgeThickness: dark border width. seed: shifts the cell pattern."
  },

  /* Phase 7 §5.5.b — ProceduralTerrain. Noise-based heightmap source
   * for the Terrain node (§5.5.a, ships next). Pure-procedural fBm
   * (or ridge multifractal when `ridges` is nonzero) sampled per-
   * fragment in UV space. Output `out` is a single-channel-ish
   * texture (R = G = B = height) the Terrain node samples in its
   * vertex shader to displace an XZ grid.
   *
   * Why a shader-frag and not a static texture: the user can drive
   * `seed` from MasterClock for an animated landscape, or wire
   * `frequency` to a slider to dial scale live without rebaking.
   * The texture is regenerated each frame at framebuffer resolution,
   * which is cheap (one fullscreen triangle pass).
   *
   * Stop-go: this + the §5.5.a Terrain node (queued) closes out the
   * "ProceduralTerrain → Terrain → Scene" demo from ROADMAP.md. */
  ProceduralTerrain: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "type",          t: "param" },
      { n: "seed",          t: "param" },
      { n: "frequency",     t: "param" },
      { n: "octaves",       t: "param" },
      { n: "lacunarity",    t: "param" },
      { n: "gain",          t: "param" },
      { n: "ridges",        t: "param" },
      // v0.3.128 game-dev upgrade -- five post-processing knobs
      // that turn raw fBm into a recognizable terrain style.
      { n: "warpAmount",    t: "param" },
      { n: "warpFreq",      t: "param" },
      { n: "erosion",       t: "param" },
      { n: "continentMask", t: "param" },
      { n: "terrace",       t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      type:          "fbm",
      seed:          1.234,
      frequency:     4.0,
      octaves:       5,
      lacunarity:    2.0,
      gain:          0.5,
      ridges:        0.0,
      warpAmount:    0.0,
      warpFreq:      1.0,
      erosion:       0.0,
      continentMask: 0.0,
      terrace:       0.0
    },
    paramOptions: { type: ["fbm", "ridges", "billowy"] },
    methods: {},
    // 16-float preamble + 12 params + 4 pad = 32 floats = 128 bytes.
    uniformBytes: 128,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  _pad0:        vec2f,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  seed:          f32,
  frequency:     f32,
  octaves:       f32,
  lacunarity:    f32,
  gain:          f32,
  ridges:        f32,
  noiseType:     f32,
  warpAmount:    f32,
  warpFreq:      f32,
  erosion:       f32,
  continentMask: f32,
  terrace:       f32,
  _pad1:         vec2f,
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var pp = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  let pos = pp[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// 2-component hash seeded by u.seed. Stable across frames.
fn _hash2(p: vec2f) -> f32 {
  let h = vec2f(dot(p, vec2f(127.1, 311.7)),
                dot(p, vec2f(269.5, 183.3)));
  return fract(sin(h.x + h.y + u.seed) * 43758.5453);
}

// 2D value noise: smoothed bilinear interp of hashed corners.
fn _value_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = _hash2(i);
  let b = _hash2(i + vec2f(1.0, 0.0));
  let c = _hash2(i + vec2f(0.0, 1.0));
  let d = _hash2(i + vec2f(1.0, 1.0));
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// Standard fBm: sum of N octaves of value noise.
fn _fbm(p0: vec2f, octs: i32, lac: f32, gn: f32) -> f32 {
  var p = p0;
  var amp: f32 = 1.0;
  var sum: f32 = 0.0;
  var maxAmp: f32 = 0.0;
  for (var i = 0; i < octs; i = i + 1) {
    sum = sum + _value_noise(p) * amp;
    maxAmp = maxAmp + amp;
    p = p * lac;
    amp = amp * gn;
  }
  return sum / max(maxAmp, 1e-6);
}

// Ridge multifractal: each octave is (1 - |2n - 1|)^2 -- sharp
// ridges where the underlying value noise crosses 0.5. Reads as
// mountain crests vs fBm's rolling hills.
fn _ridges_noise(p0: vec2f, octs: i32, lac: f32, gn: f32) -> f32 {
  var p = p0;
  var amp: f32 = 1.0;
  var sum: f32 = 0.0;
  var maxAmp: f32 = 0.0;
  for (var i = 0; i < octs; i = i + 1) {
    let nv = _value_noise(p);
    let r  = 1.0 - abs(2.0 * nv - 1.0);
    sum = sum + r * r * amp;
    maxAmp = maxAmp + amp;
    p = p * lac;
    amp = amp * gn;
  }
  return sum / max(maxAmp, 1e-6);
}

// Billowy: per-octave |2n - 1|. Puffy mound look -- the
// flavor-inverse of ridges. Good for cloud-like / rocky outcrops.
fn _billowy_noise(p0: vec2f, octs: i32, lac: f32, gn: f32) -> f32 {
  var p = p0;
  var amp: f32 = 1.0;
  var sum: f32 = 0.0;
  var maxAmp: f32 = 0.0;
  for (var i = 0; i < octs; i = i + 1) {
    sum = sum + abs(2.0 * _value_noise(p) - 1.0) * amp;
    maxAmp = maxAmp + amp;
    p = p * lac;
    amp = amp * gn;
  }
  return sum / max(maxAmp, 1e-6);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let baseFreq = max(u.frequency, 0.001);
  let nOcts = i32(clamp(u.octaves, 1.0, 8.0));
  let lac = u.lacunarity;
  let gn  = u.gain;

  // 1. Domain warping. Offset the sample UV by another fbm
  //    evaluation. Turns stripey fbm into meandering organic
  //    features (rivers / coastlines / convoluted ridges).
  //    warpFreq scales the warp relative to base: ~0.5 = larger
  //    swirly warps; ~2 = fine wiggling.
  var uv = in.uv;
  if (u.warpAmount > 0.001) {
    let warpScale = baseFreq * max(u.warpFreq, 0.01);
    let wp = uv * warpScale;
    let wx = _fbm(wp + vec2f(13.7, 91.2), 3, 2.0, 0.5);
    let wy = _fbm(wp + vec2f(47.3, 31.1), 3, 2.0, 0.5);
    uv = uv + (vec2f(wx, wy) - vec2f(0.5)) * u.warpAmount;
  }

  // 2. Base sample by type.
  let p = uv * baseFreq;
  let typeIdx = i32(u.noiseType + 0.5);
  var n: f32;
  if (typeIdx == 1) {
    n = _ridges_noise(p, nOcts, lac, gn);
  } else if (typeIdx == 2) {
    n = _billowy_noise(p, nOcts, lac, gn);
  } else {
    n = _fbm(p, nOcts, lac, gn);
  }

  // 3. Optional secondary ridges mix on top of the base type.
  //    Backward-compat slider that v0.3.127's params used as the
  //    only ridge control. Independent of the type pick, so
  //    type=fbm + ridges=1 still produces ridge-like output.
  if (u.ridges > 0.001 && typeIdx != 1) {
    let r = _ridges_noise(p, nOcts, lac, gn);
    n = mix(n, r, clamp(u.ridges, 0.0, 1.0));
  }

  // 4. Continental mask (radial falloff). Pushes the edges of the
  //    UV toward 0, leaving an island / continent-shaped landmass
  //    centered on the UV space. Strength controls falloff
  //    steepness: 0.3 = soft coastal fade, 1.0 = strong island.
  if (u.continentMask > 0.001) {
    let center = in.uv - vec2f(0.5);
    let d = length(center) * 2.0;
    let edge = pow(clamp(1.0 - d, 0.0, 1.0), 1.0 + u.continentMask * 3.0);
    n = mix(0.0, n, edge);
  }

  // 5. Erosion fakery via power remapping. Raises noise to a
  //    power > 1 to settle valleys (push low values lower) while
  //    keeping peaks. Doesn't simulate actual hydraulic / thermal
  //    erosion; imitates the silhouette result cheaply.
  if (u.erosion > 0.001) {
    let nc = clamp(n, 0.0, 1.0);
    let exponent = 1.0 + u.erosion * 2.0;
    n = pow(nc, exponent);
  }

  // 6. Terrace quantization (plateau / mesa look). 8-step
  //    quantization blended with the smooth value by terrace
  //    weight. 0 = smooth, 1 = full plateaus.
  if (u.terrace > 0.001) {
    let steps: f32 = 8.0;
    let nc = clamp(n, 0.0, 1.0);
    let quantized = floor(nc * steps) / max(steps - 1.0, 1.0);
    n = mix(nc, quantized, clamp(u.terrace, 0.0, 1.0));
  }

  let h = clamp(n, 0.0, 1.0);
  return vec4f(h, h, h, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      // type dropdown -- map enum string to numeric index for shader.
      const TYPE_MAP = { "fbm": 0, "ridges": 1, "billowy": 2 };
      const typeIdx = (typeof p.type === "string" && TYPE_MAP[p.type] !== undefined)
                    ? TYPE_MAP[p.type] : 0;
      scratch[16] = (typeof p.seed       === "number") ? p.seed       : 1.234;
      scratch[17] = (typeof p.frequency  === "number") ? p.frequency  : 4.0;
      scratch[18] = (typeof p.octaves    === "number") ? p.octaves    : 5.0;
      scratch[19] = (typeof p.lacunarity === "number") ? p.lacunarity : 2.0;
      scratch[20] = (typeof p.gain       === "number") ? p.gain       : 0.5;
      scratch[21] = (typeof p.ridges     === "number") ? p.ridges     : 0.0;
      scratch[22] = typeIdx;
      scratch[23] = (typeof p.warpAmount    === "number") ? p.warpAmount    : 0.0;
      scratch[24] = (typeof p.warpFreq      === "number") ? p.warpFreq      : 1.0;
      scratch[25] = (typeof p.erosion       === "number") ? p.erosion       : 0.0;
      scratch[26] = (typeof p.continentMask === "number") ? p.continentMask : 0.0;
      scratch[27] = (typeof p.terrace       === "number") ? p.terrace       : 0.0;
      scratch[28] = 0; scratch[29] = 0; scratch[30] = 0; scratch[31] = 0;
    },
    description: "Game-dev procedural heightmap (Phase 7 §5.5.b/c-3). type picks the base algorithm: 'fbm' (rolling hills, default), 'ridges' (sharp mountain crests via (1-|2n-1|)²), 'billowy' (puffy mounds). frequency / octaves / lacunarity / gain / seed are the standard fBm knobs; ridges is a secondary 0..1 mix that layers ridge math on top of any base type. Five post-processing layers stack on the base — each goes from no-op at 0 to fully applied at 1: warpAmount + warpFreq (domain warp — biggest single visual upgrade; turns stripey noise into meandering organic features); erosion (power remap that settles valleys); continentMask (radial falloff for island / continent shapes); terrace (8-step plateau quantization for mesa / cliff terrain). Wire `out` into Terrain.heightmap or any other texture sink. Recipes: mountains = type=ridges + erosion 0.4 + warpAmount 0.5. archipelago = type=ridges + continentMask 0.7 + warpAmount 0.3. mesa = type=fbm + terrace 0.7 + erosion 0.2. canyons = type=fbm + warpAmount 0.8 + erosion 0.6."
  },

  /* Phase 7 §5.5.d — TerrainErosion. Hydraulic + thermal erosion
   * approximation as a 1-texture-in / 1-out composition shader.
   * Drops between ProceduralTerrain → Terrain.heightmap to carve
   * the raw fBm into something geologically plausible (valleys
   * smoothed, ridges sharpened, talus settled). True iterative
   * hydraulic erosion needs frame-to-frame feedback infra (not
   * built yet — see §5.5.e roadmap); this is a multi-scale
   * single-pass approximation that captures the silhouette
   * character without per-droplet simulation. Cost: O(iterations
   * × 8) texture samples per fragment, ~80 samples at default. */
  TerrainErosion: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",         t: "texture" },
      { n: "thermal",    t: "param" },
      { n: "hydraulic",  t: "param" },
      { n: "talus",      t: "param" },
      { n: "iterations", t: "param" },
      { n: "radius",     t: "param" },
      { n: "strength",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer:    0,
      thermal:    0.85,
      hydraulic:  0.85,
      talus:      0.01,
      iterations: 8,
      radius:     4.0,
      strength:   1.0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=thermal, z=hydraulic, w=talus
  params2:       vec4f,    // x=iterations, y=radius, z=strength, w=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn _sampleH(uv: vec2<f32>, layer: u32) -> f32 {
  // Clamp to edge to avoid wrap-around erosion artifacts at borders.
  let uvc = clamp(uv, vec2<f32>(0.001), vec2<f32>(0.999));
  return textureSampleLevel(fbHistory, fbSampler, uvc, layer, 0.0).r;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer      = u32(max(0.0, u.params.x));
  let thermal    = clamp(u.params.y,  0.0, 1.0);
  let hydraulic  = clamp(u.params.z,  0.0, 1.0);
  let talus      = max(0.0, u.params.w);
  let iters      = i32(clamp(u.params2.x, 1.0, 32.0));
  let baseRadius = max(0.5, u.params2.y);
  let strength   = clamp(u.params2.z, 0.0, 1.0);
  let texel      = vec2<f32>(1.0) / u.u_resolution.xy;

  let h0 = _sampleH(in.uv, layer);
  var erodedH = h0;

  // Multi-radius erosion. Each iteration samples 8 neighbors at a
  // progressively larger radius (radius doubles per iteration). At
  // each scale we apply COMPOUNDING thermal + hydraulic passes on
  // erodedH (not on h0) so the deltas accumulate. This is a
  // single-pass stand-in for true frame-to-frame iterative erosion
  // (which needs feedback infra -- lands with §5.5.e).
  for (var i: i32 = 0; i < iters; i = i + 1) {
    let r = baseRadius * pow(1.5, f32(i));   // 1x, 1.5x, 2.25x, 3.4x ...
    let o = texel * r;

    let nW  = _sampleH(in.uv + vec2<f32>(-o.x,  0.0), layer);
    let nE  = _sampleH(in.uv + vec2<f32>( o.x,  0.0), layer);
    let nN  = _sampleH(in.uv + vec2<f32>( 0.0,  o.y), layer);
    let nS  = _sampleH(in.uv + vec2<f32>( 0.0, -o.y), layer);
    let nNW = _sampleH(in.uv + vec2<f32>(-o.x,  o.y), layer);
    let nNE = _sampleH(in.uv + vec2<f32>( o.x,  o.y), layer);
    let nSW = _sampleH(in.uv + vec2<f32>(-o.x, -o.y), layer);
    let nSE = _sampleH(in.uv + vec2<f32>( o.x, -o.y), layer);

    let nbrAvg = (nW + nE + nN + nS + nNW + nNE + nSW + nSE) * 0.125;
    let minNbr = min(min(min(nW, nE), min(nN, nS)),
                     min(min(nNW, nNE), min(nSW, nSE)));

    // Thermal erosion: when slope to lowest neighbor exceeds the
    // talus angle, blend toward the min neighbor by a fraction
    // proportional to (slope - talus). Smoothstep so the transition
    // around talus is gentle instead of stepping.
    let slope = max(0.0, erodedH - minNbr);
    let thermalBlend = thermal * smoothstep(talus, talus + 0.04, slope);
    erodedH = mix(erodedH, minNbr, thermalBlend);

    // Hydraulic erosion: blend toward neighbor average where the
    // surface is convex (ridges get smoothed by runoff). Concave
    // areas (valleys) get LESS blending so they hold their shape
    // -- mimics sediment deposition pooling in low spots. The
    // smoothstep gates the blend so flat regions stay flat.
    let curvature = nbrAvg - erodedH;
    let convexAmt = smoothstep(0.0, 0.02, -curvature);
    let hydroBlend = hydraulic * convexAmt;
    erodedH = mix(erodedH, nbrAvg, hydroBlend);
  }

  let outH = clamp(mix(h0, erodedH, strength), 0.0, 1.0);
  return vec4<f32>(outH, outH, outH, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer    === "number") ? p.inLayer    : 0;
      scratch[17] = (typeof p.thermal    === "number") ? p.thermal    : 0.85;
      scratch[18] = (typeof p.hydraulic  === "number") ? p.hydraulic  : 0.85;
      scratch[19] = (typeof p.talus      === "number") ? p.talus      : 0.01;
      scratch[20] = (typeof p.iterations === "number") ? p.iterations : 8;
      scratch[21] = (typeof p.radius     === "number") ? p.radius     : 4.0;
      scratch[22] = (typeof p.strength   === "number") ? p.strength   : 1.0;
      scratch[23] = 0;
    },
    description: "Hydraulic + thermal erosion approximation (Phase 7 §5.5.d). Drops between ProceduralTerrain → Terrain.heightmap to carve raw fBm into geologically plausible terrain. thermal: settles material on slopes steeper than talus (talus = slope threshold in heightmap units, 0.02–0.08 typical). hydraulic: smooths convex ridges via averaged neighbors (concave valleys retain shape, mimicking sediment deposition). iterations: number of multi-radius passes (more = more pronounced; 8–16 looks good, max 32). radius: starting neighbor-sample radius in framebuffer pixels. strength: overall mix vs original heightmap (1 = full erosion, 0 = pass-through). True iterative hydraulic erosion (per-droplet simulation with feedback) lands when chunked-streaming infra arrives — see §5.5.e."
  },

  /* Phase 6.6.20.7 — WireframeCalibration. AlloSphere-style
   * calibration pattern: lat/long sphere wireframe + 3 axis-aligned
   * great circles (RGB-coded) + 3 beacon small-circles around the
   * cardinal axes (RGB-coded). All rendered as thin lines on the
   * unit sphere, using each fragment's global (yaw, pitch) to
   * compute angular distance to each line.
   *
   * Reference: AlloLib calibration_pattern.cpp (UCSB AlloSphere
   * Research Facility) — the pattern used for the actual physical
   * calibration of their 26-projector dome.
   *
   * Use this together with Auto-blend (hard cuts) to verify
   * projector calibration: every line in the wireframe should
   * connect smoothly across projector boundaries. If a line
   * shifts/breaks at a boundary, that projector's pose / FOV /
   * warp mesh is off and needs adjusting. */
  WireframeCalibration: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "lineWidth",    t: "param" },
      { n: "gridMode",     t: "param" },
      { n: "slices",       t: "param" },
      { n: "stacks",       t: "param" },
      { n: "beaconRadius", t: "param" },
      { n: "showGrid",     t: "param" },
      { n: "showGreat",    t: "param" },
      { n: "showBeacons",  t: "param" },
      { n: "bgR",          t: "param" },
      { n: "bgG",          t: "param" },
      { n: "bgB",          t: "param" },
      { n: "gridR",        t: "param" },
      { n: "gridG",        t: "param" },
      { n: "gridB",        t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      lineWidth: 0.4,
      gridMode: 0,                            // 0 = lat/long (AlloSphere ref), 1 = octahedral (uniform, no polar bunching)
      slices: 24,
      stacks: 12,
      beaconRadius: 5,
      showGrid: 1,
      showGreat: 1,
      showBeacons: 1,
      bgR: 0, bgG: 0, bgB: 0,
      gridR: 0.4, gridG: 0.4, gridB: 0.4
    },
    methods: {},
    uniformBytes: 128,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  u_layer:      f32,
  u_fov_v_deg:  f32,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  bgColor:      vec4f,
  gridColor:    vec4f,
  params:       vec4f,    // x=line_w_deg, y=slices, z=stacks, w=beacon_r_deg
  flags:        vec4f,    // x=show_grid, y=show_great, z=show_beacons, w=gridMode (0=lat/long, 1=octahedral)
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn frag_to_global_angles(uv: vec2f) -> vec2f {
  // 6.6.20.24 — proper gnomonic→sphere via projector basis rotation
  // (see WireframeCalibration shader for full comment).
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  let fwd = vec3f(sy * cp, sp, cy * cp);
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  let dir = normalize(local_x * right + local_y * up + fwd);
  let pitch_out = asin(clamp(dir.y, -1.0, 1.0));
  let yaw_out   = atan2(dir.x, dir.z);
  return vec2f(yaw_out * 57.29577951, pitch_out * 57.29577951);
}

// Smooth line ramp: 1.0 at distance 0, fades to 0 at distance line_w.
// Phase 6.6.20.12: tried fwidth-based screen-space AA here but it
// "thickens" the line beyond the user's chosen angular width, which
// is wrong for high-accuracy scientific projection. Reverted —
// the proper fix lives in the warp/blend mesh density (Phase
// 6.6.20.13 bumped both to 32x32 for pixel-accurate boundaries).
fn line_alpha(angular_dist_deg: f32, line_w_deg: f32) -> f32 {
  return 1.0 - smoothstep(line_w_deg * 0.5, line_w_deg, angular_dist_deg);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let ang = frag_to_global_angles(in.uv);
  let yaw   = ang.x;
  let pitch = ang.y;
  let cp = cos(pitch * 0.01745329);
  let sp = sin(pitch * 0.01745329);
  let cy = cos(yaw   * 0.01745329);
  let sy = sin(yaw   * 0.01745329);
  // Unit direction vector. Convention matches the rest of the editor:
  //   yaw=0 forward = +Z; yaw=+90 = +X (right); pitch=+90 = +Y (up).
  let D = vec3f(sy * cp, sp, cy * cp);

  let line_w  = max(0.05, u.params.x);
  let slices  = max(2.0,  u.params.y);
  let stacks  = max(2.0,  u.params.z);
  let beacon  = max(0.5,  u.params.w);

  var color = u.bgColor.rgb;

  // 1. Sphere wireframe grid. Two modes:
  //    flags.w == 0 → lat/long (default, AlloSphere reference). Has
  //    visible polar bunching on near-pole projector views — that
  //    convergence is geometrically real, just visible because lines
  //    cluster.
  //    flags.w == 1 → octahedral. Folds sphere onto an 8-face
  //    octahedron, then onto a single 2D square. Grid lines are
  //    uniformly spaced in oct space → uniform on the sphere with
  //    no polar singularity. ONE seam at the y=0 great circle (the
  //    octahedral fold line).
  if (u.flags.x > 0.5) {
    let gridMode = i32(u.flags.w + 0.5);
    var grid_alpha: f32 = 0.0;
    if (gridMode == 1) {
      // Octahedral grid. Encode D into [-1, 1]² oct space.
      let sumAbs = abs(D.x) + abs(D.y) + abs(D.z);
      let n_oct = D / max(sumAbs, 1e-6);
      var oct = vec2f(n_oct.x, n_oct.z);
      if (n_oct.y < 0.0) {
        let signX = select(-1.0, 1.0, oct.x >= 0.0);
        let signZ = select(-1.0, 1.0, oct.y >= 0.0);
        oct = vec2f((1.0 - abs(oct.y)) * signX, (1.0 - abs(oct.x)) * signZ);
      }
      // Grid lines at integer multiples of (2/slices) in oct space.
      let oct_u = oct.x * f32(slices) * 0.5;     // [-slices/2, slices/2]
      let oct_v = oct.y * f32(stacks) * 0.5;     // [-stacks/2, stacks/2]
      let du = abs(oct_u - round(oct_u));        // ∈ [0, 0.5]
      let dv = abs(oct_v - round(oct_v));
      // Convert oct-space distance to approximate angular distance.
      // The octahedron face spans 90° on the sphere; in oct space
      // each face is 1.0 unit. So 1 unit oct ≈ 90° angular ≈
      // 90/slices degrees per cell-side at default slices.
      // Scale by slice-density so line_w_deg means roughly the same
      // visible thickness in both modes.
      let oct_to_deg = 180.0 / f32(slices);
      let mer_alpha = line_alpha(du * oct_to_deg, line_w);
      let par_alpha = line_alpha(dv * oct_to_deg, line_w);
      grid_alpha = max(mer_alpha, par_alpha);
    } else {
      // Lat/long grid (legacy / AlloSphere reference).
      let yaw_spacing = 360.0 / slices;
      let yaw_nearest = round(yaw / yaw_spacing) * yaw_spacing;
      let dy_rad = (yaw - yaw_nearest) * 0.01745329;
      let mer_dist = asin(clamp(abs(sin(dy_rad)) * cp, 0.0, 1.0)) * 57.29578;
      let mer_alpha = line_alpha(mer_dist, line_w);
      let pitch_spacing = 180.0 / stacks;
      let pitch_nearest = round(pitch / pitch_spacing) * pitch_spacing;
      let par_dist = abs(pitch - pitch_nearest);
      let par_alpha = line_alpha(par_dist, line_w);
      grid_alpha = max(mer_alpha, par_alpha);
    }
    color = mix(color, u.gridColor.rgb, grid_alpha * u.gridColor.a);
  }

  // 2. Three colored great circles — one per coordinate plane.
  // Each great circle is the intersection of the sphere with a plane
  // through the origin. Distance from D (on sphere) to that plane
  // = arcsin(|D·N|) where N is the plane normal.
  if (u.flags.y > 0.5) {
    let gw = line_w * 1.5;     // slightly thicker than grid
    // XZ plane (y=0). Equator. Normal = +Y. Color = red (matches
    // AlloLib's mXZCircle).
    let xz_dist = asin(clamp(abs(D.y), 0.0, 1.0)) * 57.29578;
    color = mix(color, vec3f(1.0, 0.18, 0.18), line_alpha(xz_dist, gw));
    // XY plane (z=0). Normal = +Z. Color = green.
    let xy_dist = asin(clamp(abs(D.z), 0.0, 1.0)) * 57.29578;
    color = mix(color, vec3f(0.18, 1.0, 0.18), line_alpha(xy_dist, gw));
    // YZ plane (x=0). Normal = +X. Color = blue.
    let yz_dist = asin(clamp(abs(D.x), 0.0, 1.0)) * 57.29578;
    color = mix(color, vec3f(0.18, 0.18, 1.0), line_alpha(yz_dist, gw));
  }

  // 3. Beacon circles — small circles at angular radius 'beacon'
  // around each cardinal +axis. Helps orient the viewer (each
  // beacon is on the side it labels).
  if (u.flags.z > 0.5) {
    let bw = line_w * 1.5;
    // +X beacon (right side). Show only when D.x > 0 so the beacon
    // appears on +X side, not also on -X side. Distance from +X
    // axis = arccos(D.x).
    if (D.x > 0.0) {
      let x_dist = acos(clamp(D.x, -1.0, 1.0)) * 57.29578;
      color = mix(color, vec3f(1.0, 0.18, 0.18), line_alpha(abs(x_dist - beacon), bw));
    }
    // +Y beacon (top). Distance from +Y = arccos(D.y) = 90 - pitch.
    if (D.y > 0.0) {
      let y_dist = acos(clamp(D.y, -1.0, 1.0)) * 57.29578;
      color = mix(color, vec3f(0.18, 1.0, 0.18), line_alpha(abs(y_dist - beacon), bw));
    }
    // +Z beacon (front). Distance from +Z = arccos(D.z).
    if (D.z > 0.0) {
      let z_dist = acos(clamp(D.z, -1.0, 1.0)) * 57.29578;
      color = mix(color, vec3f(0.18, 0.18, 1.0), line_alpha(abs(z_dist - beacon), bw));
    }
  }

  return vec4f(color, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      // bgColor at 16-19, gridColor at 20-23, params at 24-27, flags at 28-31.
      scratch[16] = (typeof p.bgR === "number") ? p.bgR : 0;
      scratch[17] = (typeof p.bgG === "number") ? p.bgG : 0;
      scratch[18] = (typeof p.bgB === "number") ? p.bgB : 0;
      scratch[19] = 1.0;
      scratch[20] = (typeof p.gridR === "number") ? p.gridR : 0.4;
      scratch[21] = (typeof p.gridG === "number") ? p.gridG : 0.4;
      scratch[22] = (typeof p.gridB === "number") ? p.gridB : 0.4;
      scratch[23] = 1.0;
      scratch[24] = (typeof p.lineWidth    === "number") ? p.lineWidth    : 0.4;
      scratch[25] = (typeof p.slices       === "number") ? p.slices       : 24;
      scratch[26] = (typeof p.stacks       === "number") ? p.stacks       : 12;
      scratch[27] = (typeof p.beaconRadius === "number") ? p.beaconRadius : 5;
      scratch[28] = (typeof p.showGrid     === "number") ? p.showGrid     : 1;
      scratch[29] = (typeof p.showGreat    === "number") ? p.showGreat    : 1;
      scratch[30] = (typeof p.showBeacons  === "number") ? p.showBeacons  : 1;
      scratch[31] = (typeof p.gridMode     === "number") ? p.gridMode     : 0;  // 0 = lat/long, 1 = octahedral
    },
    description: "WireframeCalibration — AlloSphere-style 3D wireframe pattern (lat/long sphere grid + 3 RGB-coded great circles + 3 beacon circles around cardinal axes). Lines stay sub-pixel-thin everywhere on the sphere → no polar distortion, regardless of viewing direction. Pair with Auto-blend (hard cuts) to verify projector calibration: every line should connect smoothly at projector boundaries; any shift/break reveals miscalibrated pose, FOV, or warp. lineWidth: line angular thickness in degrees (0.4 default). slices/stacks: lat/long grid density. beaconRadius: angular radius of cardinal-axis beacons in degrees. show*: toggle each layer (1=on, 0=off). bgR/G/B: background color. gridR/G/B: lat/long grid line color. Reference: AlloLib calibration_pattern.cpp."
  },

  /* Phase 6.6.21 — GammaScreensaver. Bouncing "GAMMA NODE" logo
   * across the dome. Triangle-wave bounces in (yaw, pitch); hue
   * cycles slowly. 5×7 bitmap font drawn directly in angular
   * coords so the text reads correctly across all projectors and
   * sits at constant angular size from the sweet-spot. Designed
   * to be a fun + theme-appropriate idle pattern. */
  GammaScreensaver: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "speed",   t: "param" },
      { n: "logoW",   t: "param" },
      { n: "logoH",   t: "param" },
      { n: "bgGrid",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: { speed: 1.0, logoW: 80, logoH: 16, bgGrid: 1 },
    methods: {},
    uniformBytes: 80,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  u_layer:      f32,
  u_fov_v_deg:  f32,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,    // x=speed, y=logoW_deg, z=logoH_deg, w=bgGrid
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn frag_to_global_angles(uv: vec2f) -> vec2f {
  // 6.6.20.24 — proper gnomonic→sphere via projector basis rotation
  // (see WireframeCalibration shader for full comment).
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  let fwd = vec3f(sy * cp, sp, cy * cp);
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  let dir = normalize(local_x * right + local_y * up + fwd);
  let pitch_out = asin(clamp(dir.y, -1.0, 1.0));
  let yaw_out   = atan2(dir.x, dir.z);
  return vec2f(yaw_out * 57.29577951, pitch_out * 57.29577951);
}

// 5x7 bitmap font for "GAMMA NODE". Glyph indices:
//   0=G  1=A  2=M  3=N  4=O  5=D  6=E  7=space
fn glyph_pixel(g: u32, x: i32, y: i32) -> bool {
  if (x < 0 || x > 4 || y < 0 || y > 6) { return false; }
  if (g == 0u) {                                          // G
    if (y == 0) { return x >= 1 && x <= 3; }
    if (y == 1) { return x == 0 || x == 4; }
    if (y == 2) { return x == 0; }
    if (y == 3) { return x == 0 || (x >= 2 && x <= 4); }
    if (y == 4) { return x == 0 || x == 4; }
    if (y == 5) { return x == 0 || x == 4; }
    if (y == 6) { return x >= 1 && x <= 3; }
  }
  if (g == 1u) {                                          // A
    if (y == 0) { return x == 2; }
    if (y == 1) { return x == 1 || x == 3; }
    if (y == 2) { return x == 0 || x == 4; }
    if (y == 3) { return x == 0 || x == 4; }
    if (y == 4) { return true; }
    if (y == 5) { return x == 0 || x == 4; }
    if (y == 6) { return x == 0 || x == 4; }
  }
  if (g == 2u) {                                          // M
    if (y == 0) { return x == 0 || x == 4; }
    if (y == 1) { return x == 0 || x == 1 || x == 3 || x == 4; }
    if (y == 2) { return x == 0 || x == 2 || x == 4; }
    if (y == 3) { return x == 0 || x == 2 || x == 4; }
    if (y == 4) { return x == 0 || x == 4; }
    if (y == 5) { return x == 0 || x == 4; }
    if (y == 6) { return x == 0 || x == 4; }
  }
  if (g == 3u) {                                          // N
    if (y == 0) { return x == 0 || x == 4; }
    if (y == 1) { return x == 0 || x == 1 || x == 4; }
    if (y == 2) { return x == 0 || x == 2 || x == 4; }
    if (y == 3) { return x == 0 || x == 2 || x == 4; }
    if (y == 4) { return x == 0 || x == 3 || x == 4; }
    if (y == 5) { return x == 0 || x == 4; }
    if (y == 6) { return x == 0 || x == 4; }
  }
  if (g == 4u) {                                          // O
    if (y == 0) { return x >= 1 && x <= 3; }
    if (y == 1) { return x == 0 || x == 4; }
    if (y == 2) { return x == 0 || x == 4; }
    if (y == 3) { return x == 0 || x == 4; }
    if (y == 4) { return x == 0 || x == 4; }
    if (y == 5) { return x == 0 || x == 4; }
    if (y == 6) { return x >= 1 && x <= 3; }
  }
  if (g == 5u) {                                          // D
    if (y == 0) { return x >= 0 && x <= 3; }
    if (y == 1) { return x == 0 || x == 4; }
    if (y == 2) { return x == 0 || x == 4; }
    if (y == 3) { return x == 0 || x == 4; }
    if (y == 4) { return x == 0 || x == 4; }
    if (y == 5) { return x == 0 || x == 4; }
    if (y == 6) { return x >= 0 && x <= 3; }
  }
  if (g == 6u) {                                          // E
    if (y == 0) { return true; }
    if (y == 1) { return x == 0; }
    if (y == 2) { return x == 0; }
    if (y == 3) { return x >= 0 && x <= 3; }
    if (y == 4) { return x == 0; }
    if (y == 5) { return x == 0; }
    if (y == 6) { return true; }
  }
  return false;
}

// HSV → RGB. Hue ∈ [0, 1].
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> vec3f {
  let i = floor(h * 6.0);
  let f = h * 6.0 - i;
  let p = v * (1.0 - s);
  let q = v * (1.0 - f * s);
  let t = v * (1.0 - (1.0 - f) * s);
  let mod_i = i32(i) - 6 * (i32(i) / 6);
  if (mod_i == 0) { return vec3f(v, t, p); }
  if (mod_i == 1) { return vec3f(q, v, p); }
  if (mod_i == 2) { return vec3f(p, v, t); }
  if (mod_i == 3) { return vec3f(p, q, v); }
  if (mod_i == 4) { return vec3f(t, p, v); }
  return vec3f(v, p, q);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let ang = frag_to_global_angles(in.uv);
  let yaw   = ang.x;
  let pitch = ang.y;

  let speed  = max(0.0, u.params.x);
  let W      = max(10.0, u.params.y);          // logo width  (degrees)
  let H      = max(4.0,  u.params.z);          // logo height (degrees)
  let t      = u.u_time * speed;

  // Triangle-wave bouncing animation. Yaw drifts farther + faster
  // than pitch so the path is a deliberate, slightly irregular
  // wander instead of a Lissajous loop. yaw range = ±60°,
  // pitch range = ±25°. Period ≈ 20 s yaw / 33 s pitch.
  let trX_phase = fract(t * 0.05);
  let trY_phase = fract(t * 0.03 + 0.5);
  let yaw_c   = (abs(trX_phase * 4.0 - 2.0) - 1.0) * 60.0;
  let pitch_c = (abs(trY_phase * 4.0 - 2.0) - 1.0) * 25.0;

  // Color cycles slowly. Phase shift on each pitch bounce gives a
  // "DVD logo color flips on bounce" feel without needing state.
  let bounce_n = floor(t * 0.06);
  let hue_base = fract(t * 0.013 + bounce_n * 0.137);
  let logo_color = hsv_to_rgb(hue_base, 0.85, 1.0);

  // Yaw delta with proper ±180° wrap.
  var dy = yaw - yaw_c;
  if (dy >  180.0) { dy = dy - 360.0; }
  if (dy < -180.0) { dy = dy + 360.0; }
  let dp = pitch - pitch_c;

  // Background. Optional subtle 30°-spaced grid crosshair.
  var color = vec3f(0.0);
  if (u.params.w > 0.5) {
    let g_pitch = abs(pitch - round(pitch / 30.0) * 30.0);
    let g_yaw   = abs(yaw   - round(yaw   / 30.0) * 30.0);
    if (min(g_pitch, g_yaw) < 0.18) {
      color = vec3f(0.045, 0.06, 0.10);
    }
  }

  // Inside logo box?
  if (abs(dy) <= W * 0.5 && abs(dp) <= H * 0.5) {
    let x_norm = (dy + W * 0.5) / W;          // [0, 1]  — left-to-right
    let y_norm = (dp + H * 0.5) / H;          // [0, 1]  — bottom-to-top

    // 10 chars × 6 cells (5 letter + 1 spacing) = 60 cols, 7 rows.
    let col = i32(floor(x_norm * 60.0));
    let row = i32(floor((1.0 - y_norm) * 7.0));     // flip y → top-down read

    let letter_idx = col / 6;
    let local_col  = col - letter_idx * 6;

    // String "GAMMA NODE": 0,1,2,2,1,7,3,4,5,6
    var glyph_id: u32 = 7u;
    if (letter_idx == 0) { glyph_id = 0u; }
    if (letter_idx == 1) { glyph_id = 1u; }
    if (letter_idx == 2) { glyph_id = 2u; }
    if (letter_idx == 3) { glyph_id = 2u; }
    if (letter_idx == 4) { glyph_id = 1u; }
    if (letter_idx == 5) { glyph_id = 7u; }
    if (letter_idx == 6) { glyph_id = 3u; }
    if (letter_idx == 7) { glyph_id = 4u; }
    if (letter_idx == 8) { glyph_id = 5u; }
    if (letter_idx == 9) { glyph_id = 6u; }

    if (local_col >= 0 && local_col < 5 && row >= 0 && row <= 6) {
      if (glyph_pixel(glyph_id, local_col, row)) {
        color = logo_color;
      }
    }

    // Subtle bounding-box outline so the logo has a "card" feel.
    let edge_dist_x = min(W * 0.5 - abs(dy), 0.5);
    let edge_dist_y = min(H * 0.5 - abs(dp), 0.5);
    if (min(edge_dist_x, edge_dist_y) < 0.2) {
      color = mix(color, logo_color * 0.4, 0.7);
    }
  }

  return vec4f(color, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.speed  === "number") ? p.speed  : 1.0;
      scratch[17] = (typeof p.logoW  === "number") ? p.logoW  : 80;
      scratch[18] = (typeof p.logoH  === "number") ? p.logoH  : 16;
      scratch[19] = (typeof p.bgGrid === "number") ? p.bgGrid : 1;
    },
    description: "GammaScreensaver — bouncing 'GAMMA NODE' logo across the dome (DVD-style idle pattern). Triangle-wave bounces in yaw + pitch with constant angular velocity; hue cycles slowly with a phase nudge on each pitch bounce. Text drawn directly in angular (yaw, pitch) coordinates so it stays projector-correct everywhere on the sphere/cylinder. speed: animation rate (1.0 default). logoW/logoH: angular width + height of the logo in degrees (80 × 16 default → readable from sweet-spot, leaves dome-wide travel space). bgGrid: 0/1 subtle 30°-spaced background crosshair (1 default)."
  },

  /* Phase 6.6.21 — StarNest. Volumetric "fly through fractal star
   * cluster" effect. Port of Pablo Roman Andrioli's classic
   * Shadertoy "Star Nest" (https://www.shadertoy.com/view/XlfGRj),
   * modified so the ray direction comes from the projector basis
   * instead of screen-space UV — every projector renders the same
   * 3D scene from the rig center, lines + density stay continuous
   * across boundaries. The volumetric fold + iterated abs/dot
   * formula is unchanged from the original. Heavy on per-fragment
   * ALU (volsteps × iterations = 340 inner-loop iterations / pixel)
   * — drop framebuffer res below 1080² if you see frame stuttering. */
  StarNest: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "zoom",       t: "param" },
      { n: "speed",      t: "param" },
      { n: "tile",       t: "param" },
      { n: "formuparam", t: "param" },
      { n: "darkmatter", t: "param" },
      { n: "brightness", t: "param" },
      { n: "distfading", t: "param" },
      { n: "saturation", t: "param" },
      // Phase 6.6.32 — Gamma reactivity.
      { n: "audioReact", t: "param" },
      { n: "bassReact",  t: "param" },
      { n: "clockReact", t: "clock" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      zoom:       0.800,
      speed:      0.010,
      tile:       0.850,
      formuparam: 0.530,
      darkmatter: 0.300,
      brightness: 0.0015,
      distfading: 0.730,
      saturation: 0.850,
      audioReact: 0.0,
      bassReact:  0.0,
      clockReact: 0.0
    },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  u_layer:      f32,
  u_fov_v_deg:  f32,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,    // x=zoom, y=formuparam, z=darkmatter, w=brightness
  params2:      vec4f,    // x=distfading, y=saturation, z=tile, w=speed
  params3:      vec4f,    // x=audioReact, y=bassReact, z=clockReact, w=_
};
@group(0) @binding(0) var<uniform> u: U;

// Phase 6.6.32 — audio bridge (see Plasma for full struct docs).
struct AudioU {
  values: array<vec4<f32>, 4>,
  fft:    array<vec4<f32>, 64>,
};
@group(0) @binding(3) var<uniform> u_audio: AudioU;

fn fft_bin(k: u32) -> f32 {
  let v = u_audio.fft[k / 4u];
  let lane = k & 3u;
  if (lane == 0u) { return v.x; }
  if (lane == 1u) { return v.y; }
  if (lane == 2u) { return v.z; }
  return v.w;
}

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// Returns the fragment's WORLD direction (cartesian) on the unit
// sphere — proper basis-rotated form (see WireframeCalibration
// shader for the gnomonic-fix template comment).
fn frag_world_dir(uv: vec2f) -> vec3f {
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  let fwd = vec3f(sy * cp, sp, cy * cp);
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  return normalize(local_x * right + local_y * up + fwd);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Constants that match the original Shadertoy defines.
  let iterations: i32 = 17;
  let volsteps:   i32 = 20;
  let stepsize:   f32 = 0.1;

  let zoom       = u.params.x;
  let formuparam = u.params.y;
  let darkmatter = u.params.z;
  let brightness = u.params.w;
  let distfading = u.params2.x;
  let saturation = u.params2.y;
  let tile       = u.params2.z;
  let speed      = u.params2.w;

  // World direction from the projector basis, scaled by zoom. This
  // replaces Shadertoy's vec3(uv*zoom, 1) — same role (the per-
  // fragment ray direction) but dome-correct instead of flat.
  let dir = frag_world_dir(in.uv) * zoom;

  let time = u.u_time * speed + 0.25;

  // Camera position drifts through space. Shadertoy's original
  // version uses mouse-driven 'from' rotation (a1=0.5, a2=0.8 at
  // mouse=center); we match those defaults so the static frame
  // looks like the canonical Shadertoy preview, then add a tiny
  // time-driven oscillation on top. Phase 6.6.21.1: stripped a
  // larger animation that was placing 'from' in low-density
  // void regions on the first frames -> all-black output. The
  // backticks-in-WGSL-comments thing closes the JS template
  // literal early; never use backticks inside an embedded shader.
  let a1 = 0.5 + sin(time * 0.20) * 0.10;
  let a2 = 0.8 + cos(time * 0.15) * 0.10;
  let cosA1 = cos(a1);
  let sinA1 = sin(a1);
  let cosA2 = cos(a2);
  let sinA2 = sin(a2);

  // 'from' is a RESERVED KEYWORD in WGSL (reserved for future use,
  // per the spec list alongside 'await', 'import', 'class', etc.).
  // Renamed to cam_pos. The original Shadertoy uses 'from' as a
  // GLSL identifier where it's free; do not paste GLSL ray-march
  // names verbatim into WGSL.
  var cam_pos = vec3<f32>(1.0, 0.5, 0.5) + vec3<f32>(time * 2.0, time, -2.0);
  let fxz_x =  cam_pos.x * cosA1 + cam_pos.z * sinA1;
  let fxz_z = -cam_pos.x * sinA1 + cam_pos.z * cosA1;
  cam_pos = vec3<f32>(fxz_x, cam_pos.y, fxz_z);
  let fxy_x =  cam_pos.x * cosA2 + cam_pos.y * sinA2;
  let fxy_y = -cam_pos.x * sinA2 + cam_pos.y * cosA2;
  cam_pos = vec3<f32>(fxy_x, fxy_y, cam_pos.z);

  // Phase 6.6.32 — audio reactivity. peak modulates brightness
  // (bright frames on loud audio), bass modulates step size
  // (sub-bass kicks "pull" the depth field forward), clockReact
  // adds a per-beat brightness pulse when wired from MasterClock.
  let peak = u_audio.values[0].x;
  var bass: f32 = 0.0;
  for (var k: u32 = 0u; k < 8u; k = k + 1u) { bass = bass + fft_bin(k); }
  bass = bass * 0.125;
  let audioBri  = 1.0 + u.params3.x * peak + u.params3.z;
  let bassStep  = 1.0 + u.params3.y * bass;

  // Volumetric raymarch. Each step folds the world into a tiled
  // "kaleidoscope" cell, then iterates the abs(p)/dot(p,p) - param
  // formula — that's what produces the iridescent star-cluster
  // structure. v accumulates color along the ray, fade falls off
  // with distance + dark-matter density.
  var s:    f32 = 0.1;
  var fade: f32 = 1.0;
  var v:    vec3<f32> = vec3<f32>(0.0, 0.0, 0.0);
  let tile2 = tile * 2.0;

  for (var r: i32 = 0; r < volsteps; r = r + 1) {
    var p = cam_pos + s * dir * 0.5;
    // Tile fold: p = abs(tile - mod(p, tile*2))
    let pmod = p - tile2 * floor(p / tile2);
    p = abs(vec3<f32>(tile, tile, tile) - pmod);

    var pa: f32 = 0.0;
    var a:  f32 = 0.0;
    for (var i: i32 = 0; i < iterations; i = i + 1) {
      let dpp = max(dot(p, p), 0.0001);      // guard /0 at origin
      p = abs(p) / dpp - vec3<f32>(formuparam, formuparam, formuparam);
      let pl = length(p);
      a = a + abs(pl - pa);
      pa = pl;
    }
    let dm = max(0.0, darkmatter - a * a * 0.001);
    let a3 = a * a * a;
    if (r > 6) { fade = fade * (1.0 - dm); }
    v = v + vec3<f32>(fade, fade, fade);
    // Phase 6.6.32 — Gamma Node color ramp. Replaces the original
    // (s, s^2, s^4) warm-orange temperature curve with a phosphor-
    // green / info-cyan / amber distance ramp that matches the
    // editor's instrument palette. Near (small s): dim green; mid:
    // cyan-green; far: cyan dominant with amber highlights.
    let chR = s * s * s * 0.35;        // sparse amber/red at distance
    let chG = s * 0.95;                 // phosphor dominant
    let chB = s * s * 1.05;             // cyan rises with depth
    v = v + vec3<f32>(chR, chG, chB) * a3 * brightness * audioBri * fade;
    fade = fade * distfading;
    s = s + stepsize * bassStep;
  }

  // Saturation adjust: blend toward grayscale by (1 - saturation).
  let lv = length(v);
  v = mix(vec3<f32>(lv, lv, lv), v, saturation);
  // Original Shadertoy uses *0.01 with HDR output. Our framebuffer
  // is LDR -> exposure-tonemap to keep highlights visible without
  // crushing midtones to black. 1 - exp(-v*0.02) is a standard
  // photographic-curve approximation; max() guards against NaN
  // from accumulated overflow on extreme parameter values.
  let toned = vec3<f32>(1.0) - exp(-max(v * 0.020, vec3<f32>(0.0)));
  return vec4<f32>(toned, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      // params at 16-19, params2 at 20-23.
      scratch[16] = (typeof p.zoom       === "number") ? p.zoom       : 0.800;
      scratch[17] = (typeof p.formuparam === "number") ? p.formuparam : 0.530;
      scratch[18] = (typeof p.darkmatter === "number") ? p.darkmatter : 0.300;
      scratch[19] = (typeof p.brightness === "number") ? p.brightness : 0.0015;
      scratch[20] = (typeof p.distfading === "number") ? p.distfading : 0.730;
      scratch[21] = (typeof p.saturation === "number") ? p.saturation : 0.850;
      scratch[22] = (typeof p.tile       === "number") ? p.tile       : 0.850;
      scratch[23] = (typeof p.speed      === "number") ? p.speed      : 0.010;
      // Phase 6.6.32 — params3 (audio reactivity).
      scratch[24] = (typeof p.audioReact === "number") ? p.audioReact : 0.0;
      scratch[25] = (typeof p.bassReact  === "number") ? p.bassReact  : 0.0;
      scratch[26] = (typeof p.clockReact === "number") ? p.clockReact : 0.0;
      scratch[27] = 0;
    },
    description: "StarNest — Gamma Node take on the volumetric fly-through-fractal-stars effect. Same kaleidoscope-fold + iterated abs(p)/dot(p,p) - param formula as Pablo Roman Andrioli's Shadertoy original, but the per-ray color ramp re-keyed from the warm-orange temperature curve to a phosphor-green / info-cyan / amber palette that matches the rest of the editor. Ray direction comes from the projector basis (gnomonic-fix template) — same scene across every dome boundary. zoom: ray scale (0.8). speed: time multiplier (0.01). tile: kaleidoscope cell size (0.85). formuparam: fractal 'magic number' (0.53; try 0.4–0.6). darkmatter: dark-region density (0.30). brightness: emission scale (0.0015). distfading: per-step fade (0.73). saturation: 0=grayscale, 1=full color. audioReact: scales master peak into brightness. bassReact: scales bass FFT (bins 0..7) into step size — kicks pull the depth field forward. clockReact: wire MasterClock.beat for an on-the-beat brightness pulse. Heavy: 340 inner iterations/fragment; drop framebuffer res if it stutters on the dome."
  },

  /* Phase 6.6.27 — Butterflies. Volumetric ray-trace of 8 (or
   * fewer) butterflies orbiting the rig center, with procedural
   * 5x7 wing texture (lots of nested distance fields per fragment).
   * Port of jorge2017a2's "8 butterflies dancing" Shadertoy with
   * one big change: camera is FIXED at the origin (= rig center
   * = sweet-spot), butterflies orbit AROUND the user via the same
   * butterflyPath. No camera rotation -- each fragment's ray dir
   * is its projector world direction (gnomonic-fix template), so
   * the butterflies are projector-boundary-consistent across the
   * AlloSphere or any other rig.
   *
   * Output is RGBA with alpha=1 where a butterfly is hit, alpha=0
   * elsewhere. Designed to be wired into BlendShader.inA + a
   * backdrop on inB (mode=5 alpha-over): butterflies float over
   * whatever your background shader draws. */
  Butterflies: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "speed",       t: "param" },
      { n: "numActive",   t: "param" },
      // Phase 6.6.32 — Gamma reactivity. Master peak, bass FFT,
      // and clock-wirable speed boost.
      { n: "audioReact",  t: "param" },
      { n: "bassReact",   t: "param" },
      { n: "clockReact",  t: "clock" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: { speed: 1.0, numActive: 8, audioReact: 0.0, bassReact: 0.0, clockReact: 0.0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  u_layer:      f32,
  u_fov_v_deg:  f32,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,    // x=speed, y=numActive, z=audioReact, w=bassReact
  params2:      vec4f,    // x=clockReact, yzw=_
};
@group(0) @binding(0) var<uniform> u: U;

// Phase 6.6.32 — audio bridge (see Plasma for full struct docs).
struct AudioU {
  values: array<vec4<f32>, 4>,
  fft:    array<vec4<f32>, 64>,
};
@group(0) @binding(3) var<uniform> u_audio: AudioU;

fn fft_bin(k: u32) -> f32 {
  let v = u_audio.fft[k / 4u];
  let lane = k & 3u;
  if (lane == 0u) { return v.x; }
  if (lane == 1u) { return v.y; }
  if (lane == 2u) { return v.z; }
  return v.w;
}

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn frag_world_dir(uv: vec2f) -> vec3f {
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  let fwd = vec3f(sy * cp, sp, cy * cp);
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  return normalize(local_x * right + local_y * up + fwd);
}

// --- IQ value noise ---
fn hash11(n: f32) -> f32 { return fract(sin(n) * 43758.5453123); }

fn noise2(x: vec2<f32>) -> f32 {
  let p = floor(x);
  let f0 = fract(x);
  let f = f0 * f0 * (3.0 - 2.0 * f0);
  let n = p.x + p.y * 157.0;
  return mix(
    mix(hash11(n + 0.0),   hash11(n + 1.0),   f.x),
    mix(hash11(n + 157.0), hash11(n + 158.0), f.x),
    f.y
  );
}

fn fbm2(p: vec2<f32>) -> f32 {
  var f: f32 = 0.0;
  for (var i: i32 = 1; i <= 9; i = i + 1) {
    let x = exp2(f32(i));
    f = f + (noise2(p * x) - 0.5) / x;
  }
  return f;
}

fn sq(x: f32) -> f32 { return x * x; }

fn rot2(a: f32, v: vec2<f32>) -> vec2<f32> {
  let c = cos(a); let s = sin(a);
  return vec2<f32>(c * v.x + s * v.y, c * v.y - s * v.x);
}

// --- Wing geometry (hardcoded vertex positions) ---
fn wing0Node(i: i32) -> vec3<f32> {
  if (i < 1) { return vec3<f32>(-0.23,  0.0,   1.0); }
  if (i < 2) { return vec3<f32>(-0.7,   0.25,  1.0); }
  if (i < 3) { return vec3<f32>(-0.4,   0.8,   1.0); }
  if (i < 4) { return vec3<f32>(-0.8,   0.24,  1.3); }
  if (i < 5) { return vec3<f32>(-0.8,   0.84,  0.6); }
  if (i < 6) { return vec3<f32>(-0.9,   0.4,   1.2); }
  if (i < 7) { return vec3<f32>(-1.04,  0.6,   1.2); }
  return vec3<f32>(-0.1, -0.1, 1.0);
}

fn wing1Node(i: i32) -> vec3<f32> {
  if (i < 1) { return vec3<f32>( 0.1,   0.3,  1.0); }
  if (i < 2) { return vec3<f32>(-0.3,   0.4,  1.0); }
  if (i < 3) { return vec3<f32>(-0.3,   0.2,  1.0); }
  if (i < 4) { return vec3<f32>(-0.25, -0.1,  1.0); }
  if (i < 5) { return vec3<f32>(-0.2,  -0.25, 1.0); }
  if (i < 6) { return vec3<f32>(-0.05, -0.5,  1.0); }
  return vec3<f32>( 0.5, -0.2, 1.0);
}

fn wing0NodeT(i: i32) -> vec3<f32> {
  return (wing0Node(i) + vec3<f32>(-0.7, -0.05, 0.0)) * vec3<f32>(0.84, 0.7, 1.0);
}

fn wing1NodeT(i: i32) -> vec3<f32> {
  return (wing1Node(i) + vec3<f32>(-0.7, -0.05, 0.0)) * vec3<f32>(0.84, 0.7, 1.0);
}

fn wing0Tex(p_in: vec2<f32>) -> vec3<f32> {
  let p = rot2(-0.7, p_in + vec2<f32>(0.3, 0.0));
  var cn: i32 = 0;
  var cnd: f32 = 1e3;
  for (var i: i32 = 0; i < 8; i = i + 1) {
    let d = distance(p, wing0NodeT(i).xy);
    if (d < cnd) { cnd = d; cn = i; }
  }
  var s = 0.04 + pow(max(0.0, -p.y * 0.4), 1.3) + pow(max(0.0, -p.x - 1.0), 1.3) * 0.1;
  s = s + 0.2 * (1.0 - smoothstep(0.0, 0.4, distance(p, vec2<f32>(-1.2, 0.2)))) +
          0.2 * (1.0 - smoothstep(0.0, 0.3, distance(p, vec2<f32>(-1.0, 0.5))));
  var c: f32 = 0.0;
  for (var j: i32 = 0; j < 8; j = j + 1) {
    if (j == cn) { continue; }
    let n0 = wing0NodeT(cn);
    let n1 = wing0NodeT(j);
    let nd = n1.xy - n0.xy;
    let d = dot(p - (n0.xy + nd * 0.5), normalize(nd)) + s * n0.z;
    c = c + sq(max(0.0, d));
  }
  let p0 = sq(max(0.0, dot(p - vec2<f32>(-0.5, 0.0), normalize(vec2<f32>(1.0, -0.9)))));
  c = c + sq(max(0.0, (distance(p + vec2<f32>(0.6, 1.45), vec2<f32>(0.0)) - 2.0 + s))) + p0 +
          sq(max(0.0, dot(p - vec2<f32>(-0.6, -0.2), normalize(vec2<f32>(-0.3, -0.9)))));
  let c2 = sq(max(0.0, (distance(p + vec2<f32>(0.6, 1.55), vec2<f32>(0.0)) - 2.0))) + p0 +
           sq(max(0.0, dot(p - vec2<f32>(-0.6, -0.2), normalize(vec2<f32>(-0.3, -0.9))) - 0.1));
  let xa = vec2<f32>(-1.7, 0.0);
  let xb = vec2<f32>(-0.8, -0.3);
  let xs = vec2<f32>(0.6, 1.0);
  let t_clamped = clamp(dot(p - xa, xb - xa) / dot(xb - xa, xb - xa), 0.0, 1.0);
  let u_mix = mix(xa, xb, floor(t_clamped * 5.0 + 0.5) / 5.0);
  let x = max(
    1.0 - smoothstep(0.06, 0.07, distance(p, vec2<f32>(-1.2, 0.3))),
    1.0 - smoothstep(0.02, 0.025, length((p - u_mix) * xs))
  );
  return vec3<f32>(
    1.0 - smoothstep(s - 0.015, s - 0.015 + 0.006, sqrt(c)),
    1.0 - smoothstep(0.1, 0.106, sqrt(c2) - 0.03),
    x
  );
}

fn wing1Tex(p_in: vec2<f32>) -> vec3<f32> {
  let p = p_in + vec2<f32>(0.0, 0.16);
  var cn: i32 = 0;
  var cnd: f32 = 1e3;
  for (var i: i32 = 0; i < 7; i = i + 1) {
    let d = distance(p, wing1NodeT(i).xy);
    if (d < cnd) { cnd = d; cn = i; }
  }
  let s = 0.04 + pow(max(0.0, -p.y * 0.4), 1.3) + pow(max(0.0, -p.x - 1.0), 1.3) * 0.1;
  var c: f32 = 0.0;
  for (var j: i32 = 0; j < 7; j = j + 1) {
    if (j == cn) { continue; }
    let n0 = wing1NodeT(cn);
    let n1 = wing1NodeT(j);
    let nd = n1.xy - n0.xy;
    let d = dot(p - (n0.xy + nd * 0.5), normalize(nd)) + s * n0.z;
    c = c + sq(max(0.0, d));
  }
  let p0 = sq(max(0.0, dot(p - vec2<f32>(-0.5, -0.4), normalize(vec2<f32>(1.0, -0.7)))));
  let p1 = sq(max(0.0, dot(p - vec2<f32>(-0.3, 0.3), normalize(-vec2<f32>(0.1, -0.9)))));
  c = c + sq(max(0.0, (distance(p + vec2<f32>(0.52, -0.1), vec2<f32>(0.0)) - 0.5))) + p0 + p1;
  let c2 = sq(max(0.0, (distance(p + vec2<f32>(0.5, 0.0), vec2<f32>(0.0)) - 0.53))) + p0 + p1;
  let xr: f32 = 0.7;
  let xa = vec2<f32>(-0.4, 0.05);
  let pd = rot2(-0.2, p - xa);
  let raw_ang = atan2(pd.y, pd.x);
  let clamped_ang = clamp(raw_ang, -3.1, -1.8);
  let ang = mix(-3.1, -1.8, floor((clamped_ang + 3.1) / 1.299 * 6.0 + 0.5) / 6.0);
  let x = 1.0 - smoothstep(0.02, 0.025, distance(pd, vec2<f32>(cos(ang), sin(ang)) * xr));
  return vec3<f32>(
    1.0 - smoothstep(s - 0.015, s - 0.015 + 0.006, sqrt(c)),
    1.0 - smoothstep(0.1, 0.106, sqrt(c2) - 0.03),
    x
  );
}

fn wing_color(p_in: vec2<f32>) -> vec4<f32> {
  let p = p_in + fbm2(p_in * 4.0) * 0.02;
  // Phase 6.6.32 — Gamma Node palette: phosphor green wing surface
  // shading into info-cyan along the inner edge, with amber accent
  // at the wing-edge / vein highlights. Replaces jorge2017a2's
  // warm-orange Shadertoy original. Same noise-driven mixT keeps
  // the organic per-wing texture variation; the colors are just
  // re-keyed to the editor's instrument palette.
  let phosphor = vec3<f32>(0.78, 0.91, 0.35);
  let cyan     = vec3<f32>(0.51, 0.91, 1.00);
  let amber    = vec3<f32>(0.95, 0.55, 0.18);
  let mixT = fbm2(p * vec2<f32>(1.0, 16.0)) * 0.40 +
             pow(clamp((p.y * 4.0 - abs(p.x) * 2.0) / 3.0, 0.0, 1.0), 2.0);
  let edgeT = pow(clamp(-p.x * 0.5, 0.0, 1.0), 1.5);
  var wc = mix(phosphor, cyan, mixT);
  wc = mix(wc, amber, edgeT * 0.45);
  wc = pow(wc, vec3<f32>(1.3)) * 0.9;
  let c0 = wing0Tex(p);
  let c1 = wing1Tex(p);
  var col = mix(mix(vec3<f32>(0.0), c0.x * wc, c0.y), c1.x * wc, c1.y);
  // Vein highlights pick up the secondary palette instead of plain
  // white — body gets phosphor sparkle, wings get cyan glints.
  col = mix(col, phosphor * 1.3, c0.z);
  col = mix(col, cyan * 1.2, c1.z);
  return vec4<f32>(col, max(c0.y, c1.y));
}

// Ray-plane intersection for one wing, returns (wing_u, wing_v, t).
fn traceWing(ro: vec3<f32>, rd: vec3<f32>, bo: vec3<f32>, bd: vec3<f32>, flap: f32) -> vec3<f32> {
  let up = vec3<f32>(0.0, 1.0, 0.0);
  let c = cross(bd, up);
  let flapangle = mix(20.0 * 0.0174532925, 150.0 * 0.0174532925, flap);
  let w = cos(flapangle) * c + sin(flapangle) * up;
  let denom = dot(rd, w);
  let t = -dot(ro, w) / denom;
  let s = cross(w, bd);
  let rp = ro + rd * t;
  return vec3<f32>(dot(rp, s), dot(rp, bd), t);
}

fn traceButterfly(ro_in: vec3<f32>, rd_in: vec3<f32>, bo_in: vec3<f32>, bd: vec3<f32>, flap_in: f32) -> vec4<f32> {
  let flap = pow(flap_in, 0.75);
  var bo = bo_in;
  bo.y = bo.y - flap * 0.5;
  var ro = ro_in - bo;
  var rd = rd_in;
  let up = vec3<f32>(0.0, 1.0, 0.0);
  let c = cross(bd, up);

  let w0 = traceWing(ro, rd, bo, bd, flap);

  // Reflect ro + rd across the c axis to get the mirrored wing.
  ro = ro - dot(ro, c) * 2.0 * c;
  rd = rd - dot(rd, c) * 2.0 * c;
  let w1 = traceWing(ro, rd, bo, bd, flap);

  if (max(abs(w0.x), abs(w0.y)) > 2.0 && max(abs(w1.x), abs(w1.y)) > 2.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1e4);
  }
  let c0 = wing_color(w0.xy);
  let c1 = wing_color(w1.xy);
  let u0 = c0.a > 0.0 && w0.z > 0.0;
  let u1 = c1.a > 0.0 && w1.z > 0.0;
  if (!u0 && !u1) { return vec4<f32>(0.0, 0.0, 0.0, 1e4); }
  if (u0 && !u1)  { return vec4<f32>(c0.rgb, w0.z); }
  if (!u0 && u1)  { return vec4<f32>(c1.rgb, w1.z); }
  return mix(vec4<f32>(c0.rgb, w0.z), vec4<f32>(c1.rgb, w1.z), step(w1.z, w0.z));
}

fn butterflyPath(t: f32) -> vec3<f32> {
  return vec3<f32>(cos(t), cos(t * 0.22) + sin(t * 4.0) * 0.1, sin(t * 1.3)) * 4.0;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Phase 6.6.32 — audio-reactive speed + brightness.
  //   audioReact * master peak  → boost orbit speed during loud frames
  //   bassReact  * mean(fft 0-7) → boost flap rate on kick drums
  //   clockReact (wirable from MasterClock) → also boosts speed
  let peak = u_audio.values[0].x;
  var bass: f32 = 0.0;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { bass = bass + fft_bin(i); }
  bass = bass * 0.125;
  let audioBoost = u.params.z * peak + u.params2.x;            // speed term
  let bassBoost  = u.params.w * bass;                          // flap term
  let time = u.u_time * (max(0.01, u.params.x) + audioBoost);
  let nactive = i32(clamp(u.params.y, 1.0, 8.0));

  // Camera at the rig center; rd from the projector basis.
  let ro = vec3<f32>(0.0, 0.0, 0.0);
  let rd = frag_world_dir(in.uv);

  var col = vec3<f32>(0.0);
  var depth: f32 = 1e3;

  for (var i: i32 = 0; i < 8; i = i + 1) {
    if (i >= nactive) { break; }
    let t = time + f32(i) * 10.2;
    let bo = butterflyPath(t);
    let bp_next = butterflyPath(t + 0.01);
    let bd_xz = normalize(bp_next.xz - bo.xz);
    let bd = vec3<f32>(bd_xz.x, 0.0, bd_xz.y);
    // bassBoost scales the per-butterfly flap rate so kick drums
    // visibly flutter the wings without affecting orbit speed.
    let flap = 0.5 + 0.5 * cos(t * (9.0 + bassBoost * 24.0));
    let b = traceButterfly(ro, rd, bo, bd, flap);
    let hit = b.a < depth;
    col = select(col, b.rgb, hit);
    depth = min(depth, b.a);
  }

  let alpha = select(0.0, 1.0, depth < 1e2);
  // sqrt() gamma curve — same as the Shadertoy original, but
  // applied to our Gamma palette instead of the warm-orange set.
  let outRgb = sqrt(max(col, vec3<f32>(0.0)));
  return vec4<f32>(outRgb, alpha);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.speed       === "number") ? p.speed       : 1.0;
      scratch[17] = (typeof p.numActive   === "number") ? p.numActive   : 8;
      scratch[18] = (typeof p.audioReact  === "number") ? p.audioReact  : 0.0;
      scratch[19] = (typeof p.bassReact   === "number") ? p.bassReact   : 0.0;
      scratch[20] = (typeof p.clockReact  === "number") ? p.clockReact  : 0.0;
      scratch[21] = 0; scratch[22] = 0; scratch[23] = 0;
    },
    description: "Butterflies — Gamma Node take on the volumetric butterfly ray-trace. 8 butterflies orbit the rig center / sweet-spot; each fragment's ray direction comes from the projector basis (gnomonic-fix template) so the scene stays continuous across every dome boundary. Wings re-keyed from the original orange palette to the editor's phosphor-green / info-cyan / amber instrument theme. Output is RGBA — alpha=1 only where a butterfly is hit, so the obvious composition is Butterflies → BlendShader.inA + a backdrop on inB with mode=5 (alpha-over). speed: orbit time multiplier (1.0). numActive: butterfly count 1..8. audioReact: scales master output peak into orbit speed. bassReact: scales mean FFT bins 0..7 into per-butterfly flap rate so kick drums flutter the wings. clockReact: wire MasterClock.beat for on-the-beat speed pulses. Expensive: ~340 inner-loop iterations per fragment; drop framebuffer res if it stutters."
  },

  /* Phase 6.4 — NoiseShader. Simplex 2D fBm with octaves. Output is
   * grayscale 0..1 (interpret as height field, mask, or modulator).
   * scale controls primary frequency; octaves stacks rougher detail
   * (1..8); seed shifts the noise field. */
  NoiseShader: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins:  [
      { n: "scale",   t: "param" },
      { n: "octaves", t: "param" },
      { n: "seedX",   t: "param" },
      { n: "seedY",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: { scale: 8, octaves: 4, seedX: 0, seedY: 0 },
    methods: {},
    uniformBytes: 80,
    wgsl:
`struct U {
  u_resolution: vec4f,
  u_time:       f32,
  u_dt:         f32,
  u_layer:      f32,
  u_fov_v_deg:  f32,
  u_view:       vec4f,
  u_world_uv:   vec4f,
  params:       vec4f,    // x=scale (cycles around 360°), y=octaves, z=seedX, w=seedY
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn hash22(p: vec2f) -> vec2f {
  let h = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(h) * 43758.5453);
}

// Simplex 2D — Inigo Quilez's compact form.
fn snoise2(p: vec2f) -> f32 {
  let K1: f32 = 0.366025404; // (sqrt(3)-1)/2
  let K2: f32 = 0.211324865; // (3-sqrt(3))/6
  let i = floor(p + (p.x + p.y) * K1);
  let a = p - i + (i.x + i.y) * K2;
  let m = step(a.y, a.x);
  let o = vec2f(m, 1.0 - m);
  let b = a - o + K2;
  let c = a - 1.0 + 2.0 * K2;
  let h = max(vec3f(0.5) - vec3f(dot(a, a), dot(b, b), dot(c, c)), vec3f(0.0));
  let n = h * h * h * h * vec3f(
    dot(a, hash22(i)),
    dot(b, hash22(i + o)),
    dot(c, hash22(i + vec2f(1.0)))
  );
  return dot(n, vec3f(70.0));
}

fn frag_to_global_angles(uv: vec2f) -> vec2f {
  // 6.6.20.24 — proper gnomonic→sphere via projector basis rotation
  // (see WireframeCalibration shader for full comment).
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  let fwd = vec3f(sy * cp, sp, cy * cp);
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  let dir = normalize(local_x * right + local_y * up + fwd);
  let pitch_out = asin(clamp(dir.y, -1.0, 1.0));
  let yaw_out   = atan2(dir.x, dir.z);
  return vec2f(yaw_out * 57.29577951, pitch_out * 57.29577951);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Phase 6.4 polish — angular sampling. scale = noise cycles around
  // 360° azimuth; same per 360° pitch (so cycles match in both
  // directions, matching the equiangular cell convention used by
  // Checkerboard / Voronoi). Each display reads from the SAME
  // angular noise field as its neighbors so patterns continue
  // smoothly across rig seams.
  let ang = frag_to_global_angles(in.uv);
  let seed = vec2f(u.params.z, u.params.w);
  let cycles_per_deg = max(u.params.x, 0.001) / 360.0;
  let p = ang * cycles_per_deg + seed;
  let octaves = i32(clamp(u.params.y, 1.0, 8.0));
  var n: f32   = 0.0;
  var amp: f32 = 1.0;
  var freq: f32 = 1.0;
  var norm: f32 = 0.0;
  for (var i: i32 = 0; i < 8; i = i + 1) {
    if (i >= octaves) { break; }
    n    = n    + amp * snoise2(p * freq);
    norm = norm + amp;
    amp  = amp  * 0.5;
    freq = freq * 2.0;
  }
  let g = (n / max(norm, 0.001)) * 0.5 + 0.5;
  return vec4f(vec3f(g), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.scale   === "number") ? p.scale   : 4;
      scratch[17] = (typeof p.octaves === "number") ? p.octaves : 4;
      scratch[18] = (typeof p.seedX   === "number") ? p.seedX   : 0;
      scratch[19] = (typeof p.seedY   === "number") ? p.seedY   : 0;
    },
    description: "NoiseShader — simplex 2D fBm output as grayscale [0, 1]. scale: primary frequency in world-UV units; octaves: roughness layers (1..8, each adds half-amplitude detail at double frequency); seedX/Y: shift the noise field. Useful as a height field, mask, or modulator into other shaders."
  },

  /* v0.3.21 — MatrixRain. High-fidelity classic Matrix digital-rain
   * shader. Reuses the editor's built-in 40-glyph 5x7 ASCII font (the
   * same one GammaScreensaver uses) so cells show recognizable
   * letters + digits, not random noise. Three rendering touches make
   * it read as the *classic* Wachowski-style cascade rather than a
   * generic stream-of-pixels:
   *
   *   1. Bright leading head. Each falling streak's head cell renders
   *      in near-white (pale green); the rest of the trail fades from
   *      that into the streak color (default green) over `trailLen`
   *      cells. The head also gets a brightness boost (headBoost
   *      param) so it pops on dark backgrounds.
   *
   *   2. Smooth quadratic trail fade. Distance from head -> intensity
   *      uses fade^2 instead of linear, matching the Matrix film's
   *      perceptual roll-off (each character in the trail dims fast
   *      then settles).
   *
   *   3. Per-cell glyph swap. Characters within a single trail
   *      shuffle on their own staggered timeline (per-cell hash adds
   *      a phase offset) so the streak doesn't look like one frozen
   *      column of letters scrolling -- the *character* at each row
   *      also flickers, just like the film.
   *
   * Surface-aware via the standard frag_to_global + surface_uv_norm
   * pair so the rain tiles cleanly across every rig topology
   * (sphere / cylinder / swept-arc / swept-vertical) without polar
   * bunching or projector-seam splits. */
  MatrixRain: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "cellsX",        t: "param" },
      { n: "cellsY",        t: "param" },
      { n: "streamsPerCol", t: "param" },
      { n: "trailLen",      t: "param" },
      { n: "speed",         t: "param" },
      { n: "brightness",    t: "param" },
      { n: "headBoost",     t: "param" },
      { n: "colorR",        t: "param" },
      { n: "colorG",        t: "param" },
      { n: "colorB",        t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      cellsX: 64, cellsY: 40,
      streamsPerCol: 2, trailLen: 14,
      speed: 1.0, brightness: 1.0, headBoost: 2.0,
      colorR: 0.0, colorG: 1.0, colorB: 0.0
    },
    methods: {},
    uniformBytes: 144,
    wgsl:
`struct U {
  u_resolution:   vec4f,
  u_time:         f32,
  u_dt:           f32,
  u_layer:        f32,
  u_fov_v_deg:    f32,
  u_view:         vec4f,
  u_world_uv:     vec4f,
  params:         vec4f,   // x=cellsX, y=cellsY, z=streamsPerCol, w=trailLen
  params2:        vec4f,   // x=speed, y=brightness, z=headBoost, w=_
  color:          vec4f,   // x=R, y=G, z=B, w=_
  u_surface:      vec4f,
  u_surface_path: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn frag_to_global_angles(uv: vec2f) -> vec2f {
  // 6.6.20.24 -- proper gnomonic basis rotation (see WireframeCalibration).
  let fov_h_rad = u.u_view.w   * 0.0174532925;
  let fov_v_rad = u.u_fov_v_deg * 0.0174532925;
  let local_x = (uv.x - 0.5) * 2.0 * tan(fov_h_rad * 0.5);
  let local_y = (0.5 - uv.y) * 2.0 * tan(fov_v_rad * 0.5);
  let yaw_rad   = u.u_view.x * 0.0174532925;
  let pitch_rad = u.u_view.y * 0.0174532925;
  let cy = cos(yaw_rad);   let sy = sin(yaw_rad);
  let cp = cos(pitch_rad); let sp = sin(pitch_rad);
  let fwd = vec3f(sy * cp, sp, cy * cp);
  var up_ref = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.999) { up_ref = vec3f(0.0, 0.0, 1.0); }
  let right = normalize(cross(up_ref, fwd));
  let up    = cross(fwd, right);
  let dir = normalize(local_x * right + local_y * up + fwd);
  let pitch_out = asin(clamp(dir.y, -1.0, 1.0));
  let yaw_out   = atan2(dir.x, dir.z);
  return vec2f(yaw_out * 57.29577951, pitch_out * 57.29577951);
}

fn surface_uv_norm(yaw_deg: f32, pitch_deg: f32) -> vec2f {
  // Lambert cylindrical equal-area surface mapping (see Voronoi for
  // the full comment). Returns normalized (u, v) on the active rig
  // surface so cell layouts hold their aspect across topology.
  let stype = u32(u.u_surface.x + 0.5);
  let yawStart = u.u_surface_path.x;
  let yawEnd   = u.u_surface_path.y;
  let yawSpan  = max(yawEnd - yawStart, 0.001);
  let yawWrap  = yaw_deg - 360.0 * floor((yaw_deg - yawStart) / 360.0);
  let u_norm   = (yawWrap - yawStart) / yawSpan;
  var v_norm: f32 = 0.5;
  if (stype == 2u || stype == 4u) {
    let R    = u.u_surface.y;
    let yMin = u.u_surface.z;
    let yMax = u.u_surface.w;
    let pitchRad = pitch_deg * 0.01745329;
    let cosP = cos(pitchRad);
    var cy: f32 = 0.0;
    if (abs(cosP) > 1e-4) {
      cy = R * tan(pitchRad);
    } else {
      cy = sign(pitch_deg) * (abs(yMax) + abs(yMin)) * 100.0;
    }
    v_norm = (clamp(cy, yMin, yMax) - yMin) / max(yMax - yMin, 0.001);
  } else {
    var pStart: f32 = -90.0;
    var pEnd:   f32 =  90.0;
    if (stype == 3u) {
      pStart = u.u_surface.z;
      pEnd   = u.u_surface.w;
    }
    let sinStart = sin(pStart * 0.01745329);
    let sinEnd   = sin(pEnd   * 0.01745329);
    let sinP     = sin(pitch_deg * 0.01745329);
    v_norm = (sinP - sinStart) / max(sinEnd - sinStart, 0.001);
  }
  return vec2f(u_norm, v_norm);
}

fn mod_f(a: f32, b: f32) -> f32 { return a - b * floor(a / b); }
fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// 5x7 ASCII font -- A-Z (0-25), 0-9 (26-35), space/dash/period/!
// (36-39). Same bitmap data the GammaScreensaver shader uses; each
// u32 row encodes 5 column bits with MSB = col 0 (so col x is bit
// 4-x). 40 glyphs * 7 rows = 280 entries.
const FONT: array<u32, 280> = array<u32, 280>(
  14u, 17u, 17u, 31u, 17u, 17u, 17u,   // A
  30u, 17u, 17u, 30u, 17u, 17u, 30u,   // B
  14u, 17u, 16u, 16u, 16u, 17u, 14u,   // C
  30u, 17u, 17u, 17u, 17u, 17u, 30u,   // D
  31u, 16u, 16u, 30u, 16u, 16u, 31u,   // E
  31u, 16u, 16u, 30u, 16u, 16u, 16u,   // F
  14u, 17u, 16u, 23u, 17u, 17u, 14u,   // G
  17u, 17u, 17u, 31u, 17u, 17u, 17u,   // H
  31u,  4u,  4u,  4u,  4u,  4u, 31u,   // I
   7u,  2u,  2u,  2u,  2u, 18u, 12u,   // J
  17u, 18u, 20u, 24u, 20u, 18u, 17u,   // K
  16u, 16u, 16u, 16u, 16u, 16u, 31u,   // L
  17u, 27u, 21u, 17u, 17u, 17u, 17u,   // M
  17u, 25u, 21u, 19u, 17u, 17u, 17u,   // N
  14u, 17u, 17u, 17u, 17u, 17u, 14u,   // O
  30u, 17u, 17u, 30u, 16u, 16u, 16u,   // P
  14u, 17u, 17u, 17u, 21u, 18u, 13u,   // Q
  30u, 17u, 17u, 30u, 20u, 18u, 17u,   // R
  15u, 16u, 16u, 14u,  1u,  1u, 30u,   // S
  31u,  4u,  4u,  4u,  4u,  4u,  4u,   // T
  17u, 17u, 17u, 17u, 17u, 17u, 14u,   // U
  17u, 17u, 17u, 17u, 17u, 10u,  4u,   // V
  17u, 17u, 17u, 17u, 21u, 21u, 10u,   // W
  17u, 17u, 10u,  4u, 10u, 17u, 17u,   // X
  17u, 17u, 10u,  4u,  4u,  4u,  4u,   // Y
  31u,  2u,  4u,  8u, 16u, 16u, 31u,   // Z
  14u, 17u, 19u, 21u, 25u, 17u, 14u,   // 0
   4u, 12u,  4u,  4u,  4u,  4u, 14u,   // 1
  14u, 17u,  1u,  2u,  4u,  8u, 31u,   // 2
  30u,  1u,  1u, 14u,  1u,  1u, 30u,   // 3
   2u,  6u, 10u, 18u, 31u,  2u,  2u,   // 4
  31u, 16u, 16u, 30u,  1u,  1u, 30u,   // 5
  14u, 17u, 16u, 30u, 17u, 17u, 14u,   // 6
  31u,  1u,  2u,  4u,  8u,  8u,  8u,   // 7
  14u, 17u, 17u, 14u, 17u, 17u, 14u,   // 8
  14u, 17u, 17u, 15u,  1u, 17u, 14u,   // 9
   0u,  0u,  0u,  0u,  0u,  0u,  0u,   // (space, glyph 36 -- skipped at sample time)
   0u,  0u,  0u, 14u,  0u,  0u,  0u,   // dash
   0u,  0u,  0u,  0u,  0u, 12u, 12u,   // period
   4u,  4u,  4u,  4u,  4u,  0u,  4u    // !
);

// Sample the glyph at integer grid (x in [0,5), y in [0,7)) for the
// given glyph id (mod 36 keeps it in A-Z / 0-9; space and punctuation
// would leave large dark gaps in trails, breaking the cascade look).
fn glyph_bit(gx: i32, gy: i32, id: u32) -> f32 {
  if (gx < 0 || gx > 4 || gy < 0 || gy > 6) { return 0.0; }
  let g = id % 36u;
  let row = FONT[g * 7u + u32(gy)];
  let bit = (row >> u32(4 - gx)) & 1u;
  return f32(bit);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Surface-aware UV: cells follow equal-area parameterization of the
  // current rig surface so the rain tiles cleanly across sphere /
  // cylinder / swept rigs. Without this the polar bunching on a sphere
  // would crush dozens of cells into one pixel at zenith / nadir.
  let ang = frag_to_global_angles(in.uv);
  let suv = surface_uv_norm(ang.x, ang.y);

  let cellsX        = max(2.0, floor(u.params.x));
  let cellsY        = max(2.0, floor(u.params.y));
  let streamsPerCol = clamp(floor(u.params.z), 1.0, 8.0);
  let trailLen      = max(2.0, u.params.w);
  let speed         = max(u.params2.x, 0.0);
  let brightness    = max(u.params2.y, 0.0);
  let headBoost     = max(u.params2.z, 1.0);

  let cells     = vec2f(cellsX, cellsY);
  let inv_cells = 1.0 / cells;
  let pix_raw   = vec2f(mod_f(suv.x, inv_cells.x), mod_f(suv.y, inv_cells.y));
  let cell      = floor(suv * cells);
  // Sub-pixel within the cell, scaled with a small horizontal gutter
  // (5% each side) so adjacent glyphs don't kiss + a 15% top/bottom
  // gutter so the cascade reads as a stack of discrete characters.
  let cell_uv   = pix_raw * cells;
  let sub_pix   = vec2f(cell_uv.x * 0.9 + 0.05,
                        cell_uv.y * 0.85 + 0.075);
  // Integer grid coords inside the 5x7 glyph cell.
  let gx        = i32(floor(sub_pix.x * 5.0));
  let gy        = i32(floor(sub_pix.y * 7.0));

  let t = u.u_time * speed;

  // Streak head + intensity. For each (column, stream) pair we compute
  // the head's current y position from a per-stream phase + speed,
  // then derive distance-from-head at this cell. Multiple streams per
  // column give Matrix-density without tiling.
  //
  // Cycle is trailLen + cellsY + buffer so a stream's head fully
  // crosses + exits before re-spawning at the top; otherwise back-to-
  // back streams would merge into one continuous bar.
  let cycle      = cellsY + trailLen + 6.0;
  var intensity: f32 = 0.0;
  var head_mix:  f32 = 0.0;
  let max_streams = i32(streamsPerCol);
  for (var k: i32 = 0; k < 8; k = k + 1) {
    if (k >= max_streams) { break; }
    let k_f       = f32(k);
    // Per-(col, stream) speed in [0.25, 0.65] cells/sec.
    let seed      = vec2f(cell.x, k_f);
    let col_speed = 0.25 + abs(mod_f(cos(seed.x * 363.435 + seed.y * 234.323), 0.4));
    // Phase: uniform random offset within the cycle so streams don't
    // sync across columns.
    let phase     = hash21(seed) * cycle;
    let head_y    = mod_f(t * col_speed + phase, cycle);
    let dist      = head_y - cell.y;
    if (dist >= 0.0 && dist <= trailLen) {
      // Quadratic fade -- more aggressive than linear so cells close
      // to the head dominate visually. Matches the film's roll-off.
      // (Note: var name is fade_q not smooth -- the latter is a WGSL
      // reserved keyword, caught in v0.3.23. Also: no backticks in
      // this comment -- they close the JS template literal.)
      let fade   = 1.0 - dist / trailLen;
      let fade_q = fade * fade;
      intensity  = max(intensity, fade_q);
      // Head mask: distance to head, linearly fading over the first
      // ~1 cell. step(dist, 1.0) would be hard-binary; the gradient
      // softens the head highlight.
      let head_w = clamp(1.0 - dist, 0.0, 1.0);
      head_mix   = max(head_mix, head_w);
    }
  }

  // Per-cell glyph id with staggered timing so trail characters
  // shuffle on their own clocks. Cells with a faster glyph-swap rate
  // look "alive" -- the iconic Matrix character flicker.
  let cell_seed   = hash21(cell);
  let swap_rate   = 1.0 + cell_seed * 3.5;       // 1.0..4.5 Hz per cell
  let glyph_time  = floor(t * swap_rate + cell_seed * 17.0);
  let glyph_id    = u32(hash21(vec2f(cell.x, cell.y + glyph_time)) * 100.0);

  let g = glyph_bit(gx, gy, glyph_id);

  // Color: trail color (default green) lerped toward near-white at
  // the head. headBoost scales the head's overall intensity so it
  // pops + reads as the "leading character."
  let trail_color = u.color.rgb;
  let head_color  = vec3f(0.85, 1.0, 0.9);
  let pixel_color = mix(trail_color, head_color, head_mix);
  let head_amp    = 1.0 + head_mix * (headBoost - 1.0);

  let out_intensity = g * intensity * head_amp * brightness;
  let result        = pixel_color * out_intensity;
  return vec4f(result, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.cellsX        === "number") ? p.cellsX        : 64;
      scratch[17] = (typeof p.cellsY        === "number") ? p.cellsY        : 40;
      scratch[18] = (typeof p.streamsPerCol === "number") ? p.streamsPerCol : 2;
      scratch[19] = (typeof p.trailLen      === "number") ? p.trailLen      : 14;
      scratch[20] = (typeof p.speed         === "number") ? p.speed         : 1.0;
      scratch[21] = (typeof p.brightness    === "number") ? p.brightness    : 1.0;
      scratch[22] = (typeof p.headBoost     === "number") ? p.headBoost     : 2.0;
      scratch[23] = 0;
      scratch[24] = (typeof p.colorR        === "number") ? p.colorR        : 0.0;
      scratch[25] = (typeof p.colorG        === "number") ? p.colorG        : 1.0;
      scratch[26] = (typeof p.colorB        === "number") ? p.colorB        : 0.0;
      scratch[27] = 0;
      _packSurfaceUniforms(scratch, 28);
    },
    description: "Classic Matrix digital rain. Vertical cascades of A-Z / 0-9 glyphs fall across the rig surface; each streak has a bright near-white leading character that fades into the streak color (default green) over `trailLen` cells. cellsX/Y set the character grid density (default 64×40); streamsPerCol controls density (1-4 simultaneous streams per column, default 2); trailLen is the trail length in cells; speed multiplies time; brightness scales overall intensity; headBoost is how much brighter the head reads vs the trail (default 2×); colorR/G/B is the streak color. Glyphs swap per-cell on staggered timelines so trails flicker with character-level life. Surface-aware via the standard gnomonic + Lambert mapping — no polar bunching or seam splits on sphere / cylinder / swept-arc / swept-vertical rigs."
  },

  /* v0.3.38 -- ShapeTunnel. Pseudo-3D scene generator: random SDF
   * primitives (sphere / box / torus / octahedron) flying past a
   * camera through an infinite tunnel. Per-fragment ray-march
   * (analytic SDF union, 48 max steps, 8 simultaneous shapes).
   * Each shape's Z position cycles through the tunnel over time;
   * when a shape crosses the near plane it re-spawns at the far
   * plane with new randomized (x, y, type, color, rotation) via
   * hash-of-(shape_id, lap_count).
   *
   * Audio/reactive integration: camOffsetX/Y let upstream control
   * sources (BlobTracker, HandLandmarker, MasterClock) drive the
   * camera position laterally. Wire BlobTracker.b1_x through a
   * Sub(0.5) + Mul(scale) chain into camOffsetX for "tracked
   * blob steers the camera" effects.
   *
   * Cost: ~48 SDF evals * 8 shapes per step worst-case = ~3000
   * ops/fragment in cluttered regions, but rays missing all shapes
   * advance fast (big SDF distance per step) so empty rays bail
   * in 5-10 steps. ~6-10 ms at 1080p on mid-range discrete GPU. */
  ShapeTunnel: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "speed",         t: "param" },
      { n: "density",       t: "param" },
      { n: "tunnelRadius",  t: "param" },
      { n: "fogDensity",    t: "param" },
      { n: "camOffsetX",    t: "param" },
      { n: "camOffsetY",    t: "param" },
      { n: "baseHue",       t: "param" },
      { n: "shapeMix",      t: "param" },
      { n: "seedOffset",    t: "param" },
      { n: "fov",           t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      speed: 1.0,
      density: 8,         // 4..12 shapes simultaneously
      tunnelRadius: 4.0,  // corridor width
      fogDensity: 0.12,   // exponential distance fog
      camOffsetX: 0.0,    // -1..1 lateral camera shift (drive from BlobTracker etc)
      camOffsetY: 0.0,
      baseHue: 220.0,     // 0..360 base color hue (cool blue default)
      shapeMix: 1.0,      // 0 = spheres only; 1 = mixed types
      seedOffset: 0.42,
      fov: 60.0
    },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=speed, y=density, z=tunnelRadius, w=fogDensity
  params2:       vec4f,    // x=camOffsetX, y=camOffsetY, z=baseHue (deg), w=shapeMix
  params3:       vec4f,    // x=seedOffset, y=fov, zw=_
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// === Hash helpers ===
fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn hash22(p: vec2f) -> vec2f {
  return vec2f(hash21(p), hash21(p + vec2f(17.4, 27.1)));
}

// === SDF primitives (Inigo Quilez's standard set) ===
fn sdf_sphere(p: vec3f, r: f32) -> f32 {
  return length(p) - r;
}
fn sdf_box(p: vec3f, s: vec3f) -> f32 {
  let q = abs(p) - s;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
fn sdf_torus(p: vec3f, big_r: f32, small_r: f32) -> f32 {
  let q = vec2f(length(p.xz) - big_r, p.y);
  return length(q) - small_r;
}
fn sdf_octa(p: vec3f, s: f32) -> f32 {
  return (abs(p.x) + abs(p.y) + abs(p.z) - s) * 0.5773502;
}

// === Rotation helpers ===
fn rot_y(p: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
fn rot_x(p: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

// === HSV -> RGB (Sam Hocevar lolengine.net 2013) ===
fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3f {
  let k = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(vec3f(h, h, h) + k.xyz) * 6.0 - vec3f(k.w));
  return v * mix(vec3f(k.x), clamp(p - vec3f(k.x), vec3f(0.0), vec3f(1.0)), s);
}

// Compute the SDF for one shape at this point + return its hue too.
// Returns vec2(distance, hue_0_to_1).
fn shape_sdf(p: vec3f, shape_id: i32, t: f32, density: f32, period: f32,
             tunnel_R: f32, shape_mix: f32, seed_off: f32) -> vec2f {
  let i_f = f32(shape_id);
  let base_off = i_f / density * period;
  let phase = t + base_off + seed_off * period;
  let lap = floor(phase / period);
  let frac_in_lap = fract(phase / period);

  // Shape's Z position: far plane at phase=0 -> near plane at phase=1.
  // Place far plane at +period, near at -2 (just behind camera at z=-1).
  let z_pos = mix(-2.0, period, 1.0 - frac_in_lap);

  // Re-randomize (x, y, type, hue, rotation) every lap.
  let seed = vec2f(i_f, lap) + vec2f(seed_off * 91.7, 0.0);
  let rand_xy = (hash22(seed) - vec2f(0.5)) * tunnel_R * 1.6;
  let size_var = 0.4 + hash21(seed + vec2f(7.3, 0.0)) * 0.7;
  let hue_var  = hash21(seed + vec2f(11.1, 0.0));
  let rot_a    = hash21(seed + vec2f(13.7, 0.0)) * 6.28318 + t * (0.4 + hash21(seed + vec2f(17.3, 0.0)) * 0.6);
  let type_f   = hash21(seed + vec2f(19.1, 0.0)) * 4.0;
  let shape_type = i32(mix(0.0, type_f, shape_mix));   // 0 when shape_mix=0 -> all spheres

  // Translate point to shape-local space + rotate.
  var p_local = p - vec3f(rand_xy.x, rand_xy.y, z_pos);
  p_local = rot_y(p_local, rot_a);
  p_local = rot_x(p_local, rot_a * 0.7);

  var d: f32;
  if (shape_type == 0) {
    d = sdf_sphere(p_local, size_var * 0.5);
  } else if (shape_type == 1) {
    d = sdf_box(p_local, vec3f(size_var * 0.35));
  } else if (shape_type == 2) {
    d = sdf_torus(p_local, size_var * 0.42, size_var * 0.14);
  } else {
    d = sdf_octa(p_local, size_var * 0.55);
  }
  return vec2f(d, hue_var);
}

// Union of all N shapes. Returns (min_distance, hue_of_closest).
fn scene_sdf(p: vec3f, t: f32, density: f32, period: f32,
             tunnel_R: f32, shape_mix: f32, seed_off: f32) -> vec2f {
  var best_d = 1e9;
  var best_h = 0.0;
  let n = i32(clamp(density, 1.0, 12.0));
  for (var i: i32 = 0; i < 12; i = i + 1) {
    if (i >= n) { break; }
    let info = shape_sdf(p, i, t, density, period, tunnel_R, shape_mix, seed_off);
    if (info.x < best_d) {
      best_d = info.x;
      best_h = info.y;
    }
  }
  return vec2f(best_d, best_h);
}

// SDF normal via central differences -- 6 extra scene evals per
// shaded fragment. Heavy but needed for proper lighting; the
// shader bails on misses before this gets called.
fn scene_normal(p: vec3f, t: f32, density: f32, period: f32,
                tunnel_R: f32, shape_mix: f32, seed_off: f32) -> vec3f {
  let eps = 0.001;
  let dx = scene_sdf(p + vec3f(eps, 0.0, 0.0), t, density, period, tunnel_R, shape_mix, seed_off).x
         - scene_sdf(p - vec3f(eps, 0.0, 0.0), t, density, period, tunnel_R, shape_mix, seed_off).x;
  let dy = scene_sdf(p + vec3f(0.0, eps, 0.0), t, density, period, tunnel_R, shape_mix, seed_off).x
         - scene_sdf(p - vec3f(0.0, eps, 0.0), t, density, period, tunnel_R, shape_mix, seed_off).x;
  let dz = scene_sdf(p + vec3f(0.0, 0.0, eps), t, density, period, tunnel_R, shape_mix, seed_off).x
         - scene_sdf(p - vec3f(0.0, 0.0, eps), t, density, period, tunnel_R, shape_mix, seed_off).x;
  return normalize(vec3f(dx, dy, dz));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let t          = u.u_time * u.params.x;
  let density    = clamp(u.params.y, 4.0, 12.0);
  let tunnel_R   = max(u.params.z, 0.5);
  let fog_d      = max(u.params.w, 0.0);
  let cam_x      = clamp(u.params2.x, -1.5, 1.5) * tunnel_R * 0.5;
  let cam_y      = clamp(u.params2.y, -1.5, 1.5) * tunnel_R * 0.5;
  let base_hue   = u.params2.z / 360.0;
  let shape_mix  = clamp(u.params2.w, 0.0, 1.0);
  let seed_off   = u.params3.x;
  let fov_rad    = max(u.params3.y, 1.0) * 0.01745329;

  // Period: how far apart shapes are spaced in Z. tunnel_R * 6 keeps
  // density visually consistent across different tunnel widths.
  let period = tunnel_R * 6.0;

  // Ray setup -- pinhole camera.
  let aspect = u.u_resolution.x / max(u.u_resolution.y, 1.0);
  let ndc = vec2f((in.uv.x - 0.5) * 2.0 * aspect,
                  (0.5 - in.uv.y) * 2.0);
  let f_inv = 1.0 / tan(fov_rad * 0.5);
  let ray_dir = normalize(vec3f(ndc.x, ndc.y, f_inv));
  let ray_orig = vec3f(cam_x, cam_y, -1.0);

  // Ray march. Bail early on far plane miss; converge on hit.
  var z_total = 0.0;
  var hit = false;
  var hit_hue = 0.0;
  var hit_p   = vec3f(0.0);
  for (var i_step: i32 = 0; i_step < 48; i_step = i_step + 1) {
    let p = ray_orig + ray_dir * z_total;
    let info = scene_sdf(p, t, density, period, tunnel_R, shape_mix, seed_off);
    if (info.x < 0.002) {
      hit = true;
      hit_hue = info.y;
      hit_p = p;
      break;
    }
    z_total = z_total + info.x * 0.9;
    if (z_total > period + 3.0) { break; }
  }

  // Background: deep tunnel haze. Subtle radial vignette toward
  // center reads as "looking down a corridor."
  let radial = length(ndc) * 0.5;
  let bg = vec3f(0.015, 0.02, 0.05) * (1.0 - clamp(radial * 0.4, 0.0, 0.7));
  if (!hit) { return vec4f(bg, 1.0); }

  // Lambert shading + rim light.
  let n = scene_normal(hit_p, t, density, period, tunnel_R, shape_mix, seed_off);
  let light_dir = normalize(vec3f(0.4, 0.6, -0.7));
  let lambert = max(dot(n, light_dir), 0.0);
  let rim = pow(1.0 - max(dot(n, -ray_dir), 0.0), 2.5);
  let ambient = 0.18;
  let lit = ambient + lambert * 0.7 + rim * 0.4;

  let albedo = hsv2rgb(fract(base_hue + hit_hue * 0.6), 0.85, 1.0);
  var color = albedo * lit;

  // Distance fog. Shapes far from camera fade into the bg.
  let fog_t = 1.0 - exp(-z_total * fog_d);
  color = mix(color, bg, fog_t);

  return vec4f(color, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.speed         === "number") ? p.speed         : 1.0;
      scratch[17] = (typeof p.density       === "number") ? p.density       : 8;
      scratch[18] = (typeof p.tunnelRadius  === "number") ? p.tunnelRadius  : 4.0;
      scratch[19] = (typeof p.fogDensity    === "number") ? p.fogDensity    : 0.12;
      scratch[20] = (typeof p.camOffsetX    === "number") ? p.camOffsetX    : 0.0;
      scratch[21] = (typeof p.camOffsetY    === "number") ? p.camOffsetY    : 0.0;
      scratch[22] = (typeof p.baseHue       === "number") ? p.baseHue       : 220.0;
      scratch[23] = (typeof p.shapeMix      === "number") ? p.shapeMix      : 1.0;
      scratch[24] = (typeof p.seedOffset    === "number") ? p.seedOffset    : 0.42;
      scratch[25] = (typeof p.fov           === "number") ? p.fov           : 60.0;
      scratch[26] = 0; scratch[27] = 0;
    },
    description: "Pseudo-3D infinite-tunnel scene generator. Random SDF primitives (sphere / box / torus / octahedron) fly past the camera through a corridor; per-fragment ray-march (48 steps, up to 12 simultaneous shapes) gives proper depth, occlusion, and Lambert + rim lighting. Each shape cycles through the tunnel and re-randomizes its (x, y, type, color, rotation) every lap via hash-of-(shape_id, lap_count). speed: flying rate (audio-reactive via wire). density: 4-12 shapes in flight. tunnelRadius: corridor width (shape spread). fogDensity: exponential distance fog. camOffsetX/Y: lateral camera shift in [-1, 1] — wire BlobTracker.b1_x or HandLandmarker.h1_x through Sub(0.5)+Mul(2) for camera-follows-tracking effects. baseHue: 0-360 deg base color hue (220 = cool blue default; 0 = warm red). shapeMix: 0 = spheres only, 1 = full mix of all four primitives. seedOffset: shifts the random sequence (try different values for fresh-feeling spawns). fov: camera field of view."
  },

  /* Phase 6.3.2 — FeedbackShader (visual Delay1). The "ping-pong"
   * shader that reads its own previous frame and blends it with a
   * generative pattern. Used for trails, reaction-diffusion, decay
   * visualizers. bindLayout: "feedback" gets it the second pipeline
   * cache key + a different bind-group layout (uniform + sampled
   * 2D-array texture + sampler).
   *
   * The texture binding samples Visual.feedbackArray which is
   * populated by an end-of-frame copyTextureToTexture from the
   * framebuffer. So FeedbackShader sees what the WHOLE composite
   * output was last frame — including itself + any other shaders
   * that wrote to other display layers. Per-display isolation +
   * proper chain-aware feedback ships in 6.3.4 with per-node
   * intermediate textures.
   *
   * Built-in pattern: a sin-time generator wobbles around the canvas
   * to give the feedback something to "trail." User params control
   * decay (how much of last frame survives) + tint + speed. */
  FeedbackShader: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "feedback",
    ins:  [
      { n: "decay",  t: "param" },
      { n: "tintR",  t: "param" },
      { n: "tintG",  t: "param" },
      { n: "tintB",  t: "param" },
      { n: "speed",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: { decay: 0.94, tintR: 1.0, tintG: 1.0, tintB: 1.0, speed: 0.6 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,    // (Phase 6.3.2) array-layer index of this shader's
  _pad0:         f32,    //   framebuffer write target — i.e. THIS display.
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=decay, y=tintR, z=tintG, w=tintB
  speedAndPad:   vec4f,    // x=speed, yzw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
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
  // Sample THIS display's previous frame from the per-layer history
  // texture. u.u_layer is the framebuffer array-layer index that this
  // shader's pass writes to — same layer to read history from.
  let prev = textureSampleLevel(fbHistory, fbSampler, in.uv, u32(u.u_layer), 0.0);

  // Generative seed: a moving radial pattern so there's something
  // to "trail." Without a seed signal the feedback fades to black
  // (which is also fine — that's a pure decay visualizer).
  let world_uv = mix(u.u_world_uv.xy, u.u_world_uv.zw, in.uv);
  let centered = world_uv - vec2f(0.5);
  let angle    = atan2(centered.y, centered.x) + u.u_time * u.speedAndPad.x;
  let radius   = length(centered);
  let pulse    = max(0.0, 0.5 + 0.5 * cos(angle * 6.0 - radius * 12.0 - u.u_time * 2.0));
  let seedColor = pulse * vec3f(u.params.y, u.params.z, u.params.w) * (1.0 - smoothstep(0.4, 0.5, radius));

  let decay = clamp(u.params.x, 0.0, 0.999);
  let blended = prev.rgb * decay + seedColor * (1.0 - decay * 0.85);
  return vec4f(blended, 1.0);
}`,
    writeUniforms(node, scratch) {
      // 96-byte buffer = 24 f32 indices:
      //   indices  0–7   → preamble (u_resolution, u_time, u_dt, pad)
      //   indices  8–11  → u_view
      //   indices 12–15  → u_world_uv
      //   indices 16–19  → params (decay, tintR, tintG, tintB)
      //   indices 20–23  → speedAndPad (speed, 0, 0, 0)
      const p = node.params || {};
      scratch[16] = (typeof p.decay === "number") ? p.decay : 0.94;
      scratch[17] = (typeof p.tintR === "number") ? p.tintR : 1.0;
      scratch[18] = (typeof p.tintG === "number") ? p.tintG : 1.0;
      scratch[19] = (typeof p.tintB === "number") ? p.tintB : 1.0;
      scratch[20] = (typeof p.speed === "number") ? p.speed : 0.6;
      scratch[21] = 0; scratch[22] = 0; scratch[23] = 0;
    },
    description: "Feedback shader (visual Delay1) — samples its own previous frame, blends with a generative seed pattern. Use for trails / reaction-diffusion / decay visualizers. params: decay (0..1, how much of last frame survives), tintR/G/B (seed color), speed (rotation rate). Wire into VisualOutput. PHASE 6.3.2 NOTE: this MVP uses a global previous-frame texture (whole composite output last frame, layer 0 only); per-display + chain-aware feedback ships in 6.3.4 with per-node intermediates."
  },

  /* =========================================================
   * Phase 6.6.22 — Composition shader-frags. Read existing
   * display layers (last frame) and transform / combine them.
   *
   * Architecture: all composition nodes use bindLayout: "feedback"
   * which gives them a sampled view of Visual.feedbackArray (a
   * full copy of last frame's framebuffer). Each composition
   * node has 'inputXLayer' params that name a display index
   * (0..N-1) to sample from. The user wires upstream shader-
   * frags to their own VisualOutputs (one per intermediate
   * display layer), then a composition node's VO writes the
   * combined result to its own layer.
   *
   * 1-frame lag: composition reads last frame's content of the
   * input layers. Imperceptible at 60 fps, sidesteps the
   * read/write-same-texture-in-one-pass issue without needing
   * intermediate scratch textures or topological sorting.
   *
   * NOT YET WIRED THROUGH INPUT PORTS: the UX path of
   * "wire ShaderA's `out` into BlendShader's `inA`" requires a
   * graph-walker that resolves each input port to its
   * downstream-VO display layer, plus error states when the
   * source has no VO. That's Phase 6.6.23. For 6.6.22 the
   * user types layer indices into the params manually.
   * ========================================================= */

  /* BlendShader — 5 standard layer-blend modes between two
   * source layers. Mode is an integer 0..4. Mix is the global
   * opacity / mix factor 0..1. */
  BlendShader: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "inA",  t: "texture" },
      { n: "inB",  t: "texture" },
      { n: "mix",  t: "param" },
      { n: "mode", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    // Phase 6.6.24 — when inA / inB are wired, the framework
    // resolves each upstream source to its downstream-VO display
    // layer and writes the index here, OVERRIDING the manual
    // params below. Manual fallback still applies when nothing's
    // wired (the user can type a layer index while building).
    textureInputSlots: { inA: 16, inB: 17 },
    params: { inALayer: 0, inBLayer: 1, mix: 0.5, mode: 0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inALayer, y=inBLayer, z=mix, w=mode
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layerA = u32(max(0.0, u.params.x));
  let layerB = u32(max(0.0, u.params.y));
  let mix_t  = clamp(u.params.z, 0.0, 1.0);
  let mode   = i32(u.params.w + 0.5);
  let sampleA = textureSampleLevel(fbHistory, fbSampler, in.uv, layerA, 0.0);
  let sampleB = textureSampleLevel(fbHistory, fbSampler, in.uv, layerB, 0.0);
  let A = sampleA.rgb;
  let B = sampleB.rgb;
  var blended: vec3<f32> = A;
  if (mode == 0)      { blended = mix(A, B, mix_t); }                                              // normal
  else if (mode == 1) { blended = A + B * mix_t; }                                                 // add
  else if (mode == 2) { blended = mix(A, A * B, mix_t); }                                          // multiply
  else if (mode == 3) { blended = mix(A, vec3<f32>(1.0) - (vec3<f32>(1.0) - A) * (vec3<f32>(1.0) - B), mix_t); }  // screen
  else if (mode == 4) { // overlay
    let lo = 2.0 * A * B;
    let hi = vec3<f32>(1.0) - 2.0 * (vec3<f32>(1.0) - A) * (vec3<f32>(1.0) - B);
    let mask = step(vec3<f32>(0.5), A);
    blended = mix(A, mix(lo, hi, mask), mix_t);
  }
  else { // mode == 5 — alpha-over (A composited on top of B by A's alpha)
    blended = mix(B, A, sampleA.a * mix_t);
  }
  return vec4<f32>(clamp(blended, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inALayer === "number") ? p.inALayer : 0;
      scratch[17] = (typeof p.inBLayer === "number") ? p.inBLayer : 1;
      scratch[18] = (typeof p.mix      === "number") ? p.mix      : 0.5;
      scratch[19] = (typeof p.mode     === "number") ? p.mode     : 0;
    },
    description: "BlendShader — combine two upstream texture sources with one of 6 blend modes (normal, add, multiply, screen, overlay, alpha-over). Wire ShaderA's `out` to `inA` and ShaderB's `out` to `inB`; the framework auto-allocates scratch framebuffer layers for upstream sources that don't have their own VisualOutput (Phase 6.6.26). mix: 0..1 blend amount. mode: 0=normal, 1=add, 2=multiply, 3=screen, 4=overlay, 5=alpha-over (A composited on B by A's framebuffer alpha — use with Butterflies or any other source that writes per-pixel alpha). inALayer/inBLayer params are manual-fallback layer indices used when the corresponding texture port is unwired."
  },

  /* MaskShader — multiply input A's RGB by input B's luminance.
   * Lets you use any shader-frag (Voronoi, NoiseShader, etc.) as
   * a mask over another shader. invert flips the mask polarity. */
  MaskShader: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "color",    t: "texture" },
      { n: "mask",     t: "texture" },
      { n: "invert",   t: "param" },
      { n: "softness", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { color: 16, mask: 17 },
    params: { colorLayer: 0, maskLayer: 1, invert: 0, softness: 0.0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=colorLayer, y=maskLayer, z=invert, w=softness
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let cLayer = u32(max(0.0, u.params.x));
  let mLayer = u32(max(0.0, u.params.y));
  let invert = u.params.z > 0.5;
  let soft   = clamp(u.params.w, 0.0, 0.5);
  let color = textureSampleLevel(fbHistory, fbSampler, in.uv, cLayer, 0.0).rgb;
  let m_rgb = textureSampleLevel(fbHistory, fbSampler, in.uv, mLayer, 0.0).rgb;
  // Rec. 709 luminance.
  var luma = dot(m_rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  if (invert) { luma = 1.0 - luma; }
  // Optional soft edge: smoothstep around 0.5 with given width.
  let mask = select(luma, smoothstep(0.5 - soft, 0.5 + soft, luma), soft > 0.001);
  return vec4<f32>(color * mask, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.colorLayer === "number") ? p.colorLayer : 0;
      scratch[17] = (typeof p.maskLayer  === "number") ? p.maskLayer  : 1;
      scratch[18] = (typeof p.invert     === "number") ? p.invert     : 0;
      scratch[19] = (typeof p.softness   === "number") ? p.softness   : 0.0;
    },
    description: "MaskShader — multiply colorLayer's RGB by maskLayer's luminance (Rec. 709). Use any pattern shader as a mask over any other. colorLayer/maskLayer: display indices. invert: 0/1 to flip mask polarity. softness: 0..0.5 — adds a smoothstep edge around 0.5 for softer transitions (0 = hard luma multiply)."
  },

  /* ColorCorrect — single-input color grading. Brightness,
   * contrast, saturation, hue rotation. */
  ColorCorrect: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",         t: "texture" },
      { n: "brightness", t: "param" },
      { n: "contrast",   t: "param" },
      { n: "saturation", t: "param" },
      { n: "hueShift",   t: "param" },
      { n: "gamma",      t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, brightness: 0.0, contrast: 1.0, saturation: 1.0, hueShift: 0.0, gamma: 1.0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=brightness, z=contrast, w=saturation
  params2:       vec4f,    // x=hueShift (deg), y=gamma, zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// Hue rotation in YIQ-rotation form. Cheap + good enough for
// real-time. Returns rotated RGB.
fn hue_rotate(rgb: vec3<f32>, deg: f32) -> vec3<f32> {
  let r = deg * 0.0174532925;
  let c = cos(r);
  let s = sin(r);
  // Rotation matrix around the (1,1,1) axis (luminance preserving).
  let k = 1.0 / 3.0;
  let one_c = 1.0 - c;
  let m00 = c + k * one_c;          let m01 = k * one_c - s * sqrt(k); let m02 = k * one_c + s * sqrt(k);
  let m10 = k * one_c + s * sqrt(k); let m11 = c + k * one_c;          let m12 = k * one_c - s * sqrt(k);
  let m20 = k * one_c - s * sqrt(k); let m21 = k * one_c + s * sqrt(k); let m22 = c + k * one_c;
  return vec3<f32>(
    rgb.r * m00 + rgb.g * m01 + rgb.b * m02,
    rgb.r * m10 + rgb.g * m11 + rgb.b * m12,
    rgb.r * m20 + rgb.g * m21 + rgb.b * m22
  );
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  var c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  // Brightness: additive offset.
  c = c + vec3<f32>(u.params.y);
  // Contrast around 0.5.
  c = (c - vec3<f32>(0.5)) * u.params.z + vec3<f32>(0.5);
  // Saturation: blend toward Rec. 709 luminance.
  let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  c = mix(vec3<f32>(luma), c, u.params.w);
  // Hue rotation.
  if (abs(u.params2.x) > 0.001) { c = hue_rotate(c, u.params2.x); }
  // Gamma.
  let g = max(u.params2.y, 0.001);
  c = pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / g));
  return vec4<f32>(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer    === "number") ? p.inLayer    : 0;
      scratch[17] = (typeof p.brightness === "number") ? p.brightness : 0.0;
      scratch[18] = (typeof p.contrast   === "number") ? p.contrast   : 1.0;
      scratch[19] = (typeof p.saturation === "number") ? p.saturation : 1.0;
      scratch[20] = (typeof p.hueShift   === "number") ? p.hueShift   : 0.0;
      scratch[21] = (typeof p.gamma      === "number") ? p.gamma      : 1.0;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "ColorCorrect — single-input color grading. inLayer: source display index. brightness: ±, additive (0=neutral). contrast: ×, around 0.5 (1=neutral). saturation: 0=grayscale, 1=neutral, >1 boost. hueShift: degrees, ±180. gamma: >0, 1=neutral."
  },

  /* Pixelate — sample input at low-res grid (nearest neighbor). */
  Pixelate: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",       t: "texture" },
      { n: "cellSize", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, cellSize: 32 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=cellSize, zw=_
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let cell  = max(1.0, u.params.y);
  let res   = u.u_resolution.xy;
  // Snap UV to cell-center grid.
  let snapped_px = (floor(in.uv * res / cell) + vec2<f32>(0.5)) * cell;
  let snapped_uv = snapped_px / res;
  let c = textureSampleLevel(fbHistory, fbSampler, snapped_uv, layer, 0.0).rgb;
  return vec4<f32>(c, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer  === "number") ? p.inLayer  : 0;
      scratch[17] = (typeof p.cellSize === "number") ? p.cellSize : 32;
      scratch[18] = 0; scratch[19] = 0;
    },
    description: "Pixelate — snap-sample the input layer to a low-res grid (nearest neighbor). inLayer: source display index. cellSize: grid cell size in framebuffer pixels. Larger = chunkier."
  },

  /* Posterize — quantize colors to N levels per channel. */
  Posterize: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",     t: "texture" },
      { n: "levels", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, levels: 4 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=levels, zw=_
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer  = u32(max(0.0, u.params.x));
  let levels = max(2.0, u.params.y);
  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  let q = floor(c * levels) / max(1.0, levels - 1.0);
  return vec4<f32>(clamp(q, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.levels  === "number") ? p.levels  : 4;
      scratch[18] = 0; scratch[19] = 0;
    },
    description: "Posterize — quantize each color channel to N discrete levels (cel-shading look). inLayer: source display index. levels: 2..16 typical (2=1-bit per channel, 4=cartoon)."
  },

  /* EdgeDetect — Sobel kernel + threshold + tint. */
  EdgeDetect: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",        t: "texture" },
      { n: "threshold", t: "param" },
      { n: "edgeR",     t: "param" },
      { n: "edgeG",     t: "param" },
      { n: "edgeB",     t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, threshold: 0.15, edgeR: 1.0, edgeG: 1.0, edgeB: 1.0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=threshold, z=edgeR, w=edgeG
  params2:       vec4f,    // x=edgeB, yzw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn luma_at(uv: vec2<f32>, layer: u32) -> f32 {
  let c = textureSampleLevel(fbHistory, fbSampler, uv, layer, 0.0).rgb;
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let thr   = max(0.001, u.params.y);
  let texel = vec2<f32>(1.0) / u.u_resolution.xy;
  // 3x3 Sobel
  let tl = luma_at(in.uv + vec2<f32>(-texel.x, -texel.y), layer);
  let tc = luma_at(in.uv + vec2<f32>(0.0,      -texel.y), layer);
  let tr = luma_at(in.uv + vec2<f32>( texel.x, -texel.y), layer);
  let ml = luma_at(in.uv + vec2<f32>(-texel.x,  0.0),     layer);
  let mr = luma_at(in.uv + vec2<f32>( texel.x,  0.0),     layer);
  let bl = luma_at(in.uv + vec2<f32>(-texel.x,  texel.y), layer);
  let bc = luma_at(in.uv + vec2<f32>(0.0,       texel.y), layer);
  let br = luma_at(in.uv + vec2<f32>( texel.x,  texel.y), layer);
  let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  let mag = sqrt(gx * gx + gy * gy);
  let edge = smoothstep(thr, thr * 2.0, mag);
  let tint = vec3<f32>(u.params.z, u.params.w, u.params2.x);
  return vec4<f32>(tint * edge, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer   === "number") ? p.inLayer   : 0;
      scratch[17] = (typeof p.threshold === "number") ? p.threshold : 0.15;
      scratch[18] = (typeof p.edgeR     === "number") ? p.edgeR     : 1.0;
      scratch[19] = (typeof p.edgeG     === "number") ? p.edgeG     : 1.0;
      scratch[20] = (typeof p.edgeB     === "number") ? p.edgeB     : 1.0;
      scratch[21] = 0; scratch[22] = 0; scratch[23] = 0;
    },
    description: "EdgeDetect — 3×3 Sobel kernel on input luma + smoothstep threshold + RGB tint. inLayer: source display index. threshold: edge sensitivity (lower = more edges, 0.15 default). edgeR/G/B: edge color (white default). Background is black so it composites cleanly via BlendShader add mode."
  },

  /* Blur — 13-tap radial Gaussian approximation in one pass.
   * Quality ~95% of true separable 2-pass Gaussian for the
   * radii a screen-saver / live-vis user reaches for; one
   * pass keeps it cheap. */
  Blur: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",     t: "texture" },
      { n: "radius", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, radius: 4 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=radius (px), zw=_
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer  = u32(max(0.0, u.params.x));
  let radius = max(0.5, u.params.y);
  let texel  = vec2<f32>(1.0) / u.u_resolution.xy;
  // 13-tap radial sample pattern (concentric rings).
  let offs = array<vec2<f32>, 13>(
    vec2<f32>( 0.0,  0.0),
    vec2<f32>( 1.0,  0.0), vec2<f32>(-1.0,  0.0), vec2<f32>( 0.0,  1.0), vec2<f32>( 0.0, -1.0),
    vec2<f32>( 0.7,  0.7), vec2<f32>(-0.7,  0.7), vec2<f32>( 0.7, -0.7), vec2<f32>(-0.7, -0.7),
    vec2<f32>( 1.7,  0.0), vec2<f32>(-1.7,  0.0), vec2<f32>( 0.0,  1.7), vec2<f32>( 0.0, -1.7)
  );
  // Gaussian weights matched to the offsets (sigma ~= radius * 0.5).
  let wts = array<f32, 13>(
    0.20,
    0.10, 0.10, 0.10, 0.10,
    0.06, 0.06, 0.06, 0.06,
    0.025, 0.025, 0.025, 0.025
  );
  var acc = vec3<f32>(0.0);
  var w_sum = 0.0;
  for (var i: i32 = 0; i < 13; i = i + 1) {
    let sample_uv = in.uv + offs[i] * texel * radius;
    acc = acc + textureSampleLevel(fbHistory, fbSampler, sample_uv, layer, 0.0).rgb * wts[i];
    w_sum = w_sum + wts[i];
  }
  return vec4<f32>(acc / max(w_sum, 0.0001), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.radius  === "number") ? p.radius  : 4;
      scratch[18] = 0; scratch[19] = 0;
    },
    description: "Blur — 13-tap radial Gaussian approximation in one pass. inLayer: source display index. radius: blur radius in framebuffer pixels (~95% quality of true separable 2-pass Gaussian for typical screensaver radii; one pass keeps it cheap)."
  },

  /* =========================================================================
   * v0.3.30 — Video-edit suite, sprint 3: Blur / Filter.
   *
   * Five composition shader-frag nodes covering the per-pixel
   * convolution / order-statistic / morphological family. All
   * follow the same 1-texture-in / 1-out pattern as sprints 1 + 2.
   * Glow / SoftGlow deferred -- they need multi-pass infrastructure
   * (bright-pass -> downsample-blur-upsample pyramid -> additive
   * composite) which doesn't exist yet; for now express them as a
   * chain of existing nodes (Levels-as-threshold -> Blur ->
   * BlendShader in screen mode).
   * ======================================================================== */

  /* MotionBlur — temporal smoothing. Blends the previous frame on
   * top of the current at `amount` (0..1) so fast camera motion
   * smears across multiple frames. Cheap (no per-pixel velocity
   * sampling, just temporal accumulation). Useful as polish for
   * walkable-terrain demos where chunk pop-in or fast turns look
   * choppy. amount=0 = pass-through, amount=0.5 = noticeable trail,
   * amount=0.85+ = exaggerated streaking ("ghost" effect). */
  MotionBlur: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition-feedback",
    ins: [
      { n: "in",     t: "texture" },
      { n: "amount", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, amount: 0.35 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=amount, zw=_
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory:  texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler:  sampler;
@group(0) @binding(4) var fbFeedback: texture_2d_array<f32>;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer  = u32(max(0.0, u.params.x));
  let amount = clamp(u.params.y, 0.0, 0.98);     // cap so we never freeze
  // Current frame: read from the composition chain (fbHistory at
  // the input layer = whatever was wired into the 'in' port).
  let cur = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  // Previous frame: this MotionBlur's OWN output last frame, lives
  // at u_layer in fbFeedback (the composition-feedback binding).
  let outLayer = u32(max(0.0, u.u_layer));
  let prev = textureSampleLevel(fbFeedback, fbSampler, in.uv, outLayer, 0.0);
  return mix(cur, prev, amount);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.amount  === "number") ? p.amount  : 0.35;
      scratch[18] = 0; scratch[19] = 0;
    },
    description: "Temporal motion blur. Blends the previous frame on top of the current at `amount` (0..1). amount=0 is pass-through; amount=0.35 smooths fast camera motion without leaving heavy trails; amount=0.7+ leaves visible ghost trails. Cheap (single texture-sample feedback, no velocity reconstruction). Pair with FPCamera turning quickly to mask chunk-pop or LOD-shimmer artifacts."
  },

  /* Underwater — Phase 7 §5.5.h-22. Post-process tint + depth fog
   * applied when the patch's first FPCamera/Camera is below seaLevel.
   * Auto-detects via state lookup in writeUniforms; pass-through above
   * water. Tint deepens with depth (more blue + lower visibility the
   * deeper you go). Wire AFTER Scene's post chain, before the final
   * output node. */
  Underwater: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",          t: "texture" },
      { n: "seaLevel",    t: "param" },
      { n: "tintR",       t: "param" },
      { n: "tintG",       t: "param" },
      { n: "tintB",       t: "param" },
      { n: "fogDensity",  t: "param" },
      { n: "maxDepth",    t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer:    0,
      seaLevel:   0,
      tintR:      0.10, tintG: 0.30, tintB: 0.45,
      fogDensity: 0.85,
      maxDepth:   80
    },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  // p.x = inLayer
  // p.y = camDepth (sea - camY; positive when underwater, <=0 above)
  // p.z = fogDensity (how strongly the tint blends in with depth)
  // p.w = maxDepth (depth at which tint maxes out)
  params:        vec4f,
  // tint.rgb = underwater color, tint.a = unused
  tint:          vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let depth = u.params.y;
  // Above water -> straight pass-through, zero cost.
  if (depth <= 0.0) {
    return textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  }
  let fogD = max(0.0, u.params.z);
  let maxD = max(1.0, u.params.w);
  let depthN = clamp(depth / maxD, 0.0, 1.0);
  // Subtle UV wobble for the "looking through water" feel. Amplitude
  // scales with depth so the wobble grows as you go deeper.
  let wob = 0.0035 * depthN;
  let warpedU = in.uv + vec2f(sin(in.uv.y * 38.0 + u.u_time * 1.7) * wob,
                              cos(in.uv.x * 32.0 + u.u_time * 1.3) * wob);
  let src = textureSampleLevel(fbHistory, fbSampler, warpedU, layer, 0.0).rgb;
  // Blend toward the tint; deeper = more saturated tint. Fog density
  // controls how aggressively the tint takes over.
  let blendT = clamp(depthN * fogD, 0.0, 0.98);
  let tinted = mix(src, u.tint.rgb, blendT);
  // Light-from-above shaft suggestion: vertical brightness gradient
  // makes upper pixels slightly brighter (sun streaming down through
  // water) and lower pixels slightly darker. Cheap visual cue.
  let upBias = (1.0 - in.uv.y) - 0.5;
  let shafted = tinted * (1.0 + upBias * 0.12 * depthN);
  return vec4f(shafted, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      const seaLevel = (typeof p.seaLevel === "number") ? p.seaLevel : 0;
      // Detect underwater by looking up the patch's FPCamera/Camera
      // and reading its posY. Falls back to 0 (above water) if nothing
      // wired. Doing it here in JS keeps the shader stateless across
      // patches without the AlloSphere/composition-uniform layout
      // having to grow a camera-eye slot.
      let camY = 0;
      try {
        if (typeof state !== "undefined" && state && Array.isArray(state.nodes)) {
          const cam = state.nodes.find(n => n && (n.type === "FPCamera" || n.type === "Camera"));
          if (cam && cam.params && typeof cam.params.posY === "number") {
            camY = cam.params.posY;
          }
        }
      } catch (_) { /* state not in scope */ }
      const depth = Math.max(0, seaLevel - camY);
      scratch[16] = (typeof p.inLayer    === "number") ? p.inLayer    : 0;
      scratch[17] = depth;
      scratch[18] = (typeof p.fogDensity === "number") ? p.fogDensity : 0.85;
      scratch[19] = (typeof p.maxDepth   === "number") ? p.maxDepth   : 80;
      scratch[20] = (typeof p.tintR      === "number") ? p.tintR      : 0.10;
      scratch[21] = (typeof p.tintG      === "number") ? p.tintG      : 0.30;
      scratch[22] = (typeof p.tintB      === "number") ? p.tintB      : 0.45;
      scratch[23] = 0;
    },
    description: "Post-process underwater tint + depth fog + subtle UV wobble. Activates automatically when the patch's FPCamera/Camera posY is below seaLevel; above water it's a zero-cost pass-through. Tint deepens with how far below the surface the camera is (capped at maxDepth). Wire AFTER the Scene's post chain, before the final output node."
  },

  /* DirectionalBlur — 13-tap Gaussian-weighted samples along a single
   * axis. Motion-blur look (horizontal scroll, vertical streaks, etc).
   * Direction is angle in degrees; length is the half-extent of the
   * blur kernel in framebuffer pixels. */
  DirectionalBlur: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",     t: "texture" },
      { n: "angle",  t: "param" },
      { n: "length", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, angle: 0, length: 0 },   // length=0 -> pass-through
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=angleDeg, z=lengthPx, w=_
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer  = u32(max(0.0, u.params.x));
  let angle  = u.params.y * 0.01745329;
  let lenPx  = max(u.params.z, 0.0);
  if (lenPx < 0.001) {
    // Exact identity at length=0.
    return textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  }
  let texel = vec2f(1.0) / u.u_resolution.xy;
  let dir   = vec2f(cos(angle), sin(angle));
  // 13-tap Gaussian along the line, t in [-1, 1].
  let offs = array<f32, 13>(-1.0, -0.83, -0.67, -0.5, -0.33, -0.17, 0.0, 0.17, 0.33, 0.5, 0.67, 0.83, 1.0);
  let wts  = array<f32, 13>(0.020, 0.040, 0.066, 0.092, 0.114, 0.126, 0.131, 0.126, 0.114, 0.092, 0.066, 0.040, 0.020);
  var acc = vec3f(0.0);
  var w_sum = 0.0;
  for (var i: i32 = 0; i < 13; i = i + 1) {
    let off = dir * offs[i] * lenPx * texel;
    acc = acc + textureSampleLevel(fbHistory, fbSampler, in.uv + off, layer, 0.0).rgb * wts[i];
    w_sum = w_sum + wts[i];
  }
  return vec4f(acc / max(w_sum, 0.0001), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.angle   === "number") ? p.angle   : 0;
      scratch[18] = (typeof p.length  === "number") ? p.length  : 0;
      scratch[19] = 0;
    },
    description: "Single-axis Gaussian blur — motion-blur / streak look. angle: direction in degrees (0 = horizontal, 90 = vertical). length: kernel half-extent in framebuffer pixels (0 = pass-through). Identity default (length=0). Wire MasterClock.beat or a Slider to length for rhythmic motion-blur sweeps."
  },

  /* Defocus — circular kernel sample with optional highlight bloom.
   * Looks like an out-of-focus camera lens (bokeh): bright pixels
   * expand into uniform circles, dark areas stay blurred. */
  Defocus: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",       t: "texture" },
      { n: "radius",   t: "param" },
      { n: "bokeh",    t: "param" }   // boost amount for bright pixels (0 = uniform disc, >0 = bokeh)
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, radius: 0, bokeh: 1.5 },   // radius=0 -> pass-through
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=radiusPx, z=bokehBoost, w=_
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer  = u32(max(0.0, u.params.x));
  let radius = max(u.params.y, 0.0);
  let boost  = max(u.params.z, 0.0);
  if (radius < 0.001) {
    return textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  }
  let texel = vec2f(1.0) / u.u_resolution.xy;
  // 13-tap disk pattern: center + 6 inner-ring (0.5R hex) + 6 outer-ring (1.0R hex).
  let offs = array<vec2f, 13>(
    vec2f( 0.0,    0.0),
    vec2f( 0.5,    0.0   ), vec2f(-0.5,    0.0   ),
    vec2f( 0.25,   0.433 ), vec2f(-0.25,   0.433 ),
    vec2f( 0.25,  -0.433 ), vec2f(-0.25,  -0.433 ),
    vec2f( 1.0,    0.0   ), vec2f(-1.0,    0.0   ),
    vec2f( 0.5,    0.866 ), vec2f(-0.5,    0.866 ),
    vec2f( 0.5,   -0.866 ), vec2f(-0.5,   -0.866 )
  );
  // Inner ring slightly heavier than outer; matches the visual
  // weight of a Gaussian-ish disk while keeping bright pixels'
  // bokeh circles uniformly bright (no central hot-spot).
  let wts = array<f32, 13>(
    0.10,
    0.10, 0.10, 0.10, 0.10, 0.10, 0.10,
    0.05, 0.05, 0.05, 0.05, 0.05, 0.05
  );
  var acc = vec3f(0.0);
  var w_sum = 0.0;
  for (var i: i32 = 0; i < 13; i = i + 1) {
    let off = offs[i] * radius * texel;
    var c = textureSampleLevel(fbHistory, fbSampler, in.uv + off, layer, 0.0).rgb;
    // Bokeh: bright pixels get a luminance-weighted boost so they
    // bloom out into distinct discs (the classic out-of-focus
    // highlight). boost=0 reduces to a uniform disc blur.
    let lum = dot(c, vec3f(0.299, 0.587, 0.114));
    c = c * (1.0 + boost * lum * lum);
    acc = acc + c * wts[i];
    w_sum = w_sum + wts[i];
  }
  let result = acc / max(w_sum, 0.0001);
  // Tone-map back -- the bokeh boost can push values >1 which would
  // clip ugly. Reinhard-style compression on highlights only.
  return vec4f(result / (vec3f(1.0) + result * 0.3), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.radius  === "number") ? p.radius  : 0;
      scratch[18] = (typeof p.bokeh   === "number") ? p.bokeh   : 1.5;
      scratch[19] = 0;
    },
    description: "Out-of-focus lens blur (bokeh). radius: disc radius in framebuffer pixels (0 = pass-through). bokeh: highlight bloom boost — 0 reduces to uniform disc blur, higher values (1.5..3) give the classic camera-bokeh look where bright pixels expand into distinct uniform discs. Reinhard tone-mapping on the output prevents bloom clipping. Wire EnvFollow → radius for audio-reactive defocus."
  },

  /* Sharpen — unsharp mask. Subtracts a 4-tap cross-shaped blur from
   * the center pixel, scales the difference, adds it back. amount=0
   * is pass-through; typical useful range 0.3..2.0; >3 starts to
   * artifact (halos around edges). */
  Sharpen: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",     t: "texture" },
      { n: "amount", t: "param" },
      { n: "radius", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, amount: 0, radius: 1 },   // amount=0 -> pass-through
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=amount, z=radiusPx, w=_
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer  = u32(max(0.0, u.params.x));
  let amount = u.params.y;
  let radius = max(u.params.z, 0.5);
  let texel  = vec2f(1.0) / u.u_resolution.xy;
  let center = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  if (abs(amount) < 0.001) { return vec4f(center, 1.0); }
  // 4-tap cross blur estimate (cheap; sufficient for an unsharp mask).
  let l = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f(-radius, 0.0) * texel, layer, 0.0).rgb;
  let r = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f( radius, 0.0) * texel, layer, 0.0).rgb;
  let t = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f( 0.0, -radius) * texel, layer, 0.0).rgb;
  let b = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f( 0.0,  radius) * texel, layer, 0.0).rgb;
  let blurred = (l + r + t + b) * 0.25;
  let sharp = center + (center - blurred) * amount;
  return vec4f(clamp(sharp, vec3f(0.0), vec3f(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.amount  === "number") ? p.amount  : 0;
      scratch[18] = (typeof p.radius  === "number") ? p.radius  : 1;
      scratch[19] = 0;
    },
    description: "Unsharp-mask sharpening. amount: 0 = pass-through, typical 0.3..2.0 for sharper edges, >3 artifacts (halos). radius: edge-detection radius in framebuffer pixels — small (~1) emphasizes fine detail, larger (~3-5) emphasizes mid-frequency contrast. Subtracts a 4-tap cross blur from the center, multiplies the difference by amount, adds back. Cheap (5 samples per pixel)."
  },

  /* Morph — erode / dilate. Per-channel min (erode) or max (dilate)
   * over a 3x3 kernel. Great for matte cleanup: erode shrinks alpha
   * regions, dilate grows them. Also a stylized look on RGB
   * (dilate spreads bright pixels, erode pulls them in). */
  Morph: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",     t: "texture" },
      { n: "radius", t: "param" },
      { n: "mode",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    paramOptions: { mode: ["erode", "dilate"] },
    params: { inLayer: 0, radius: 0, mode: 0 },   // radius=0 -> pass-through
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=radiusPx, z=mode (0=erode, 1=dilate), w=_
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer  = u32(max(0.0, u.params.x));
  let radius = max(u.params.y, 0.0);
  let dilate = i32(u.params.z + 0.5) == 1;
  let texel  = vec2f(1.0) / u.u_resolution.xy;
  if (radius < 0.001) {
    return textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  }
  var result = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  // 3x3 kernel (8 neighbors + center). Per-channel reduce.
  for (var y: i32 = -1; y <= 1; y = y + 1) {
    for (var x: i32 = -1; x <= 1; x = x + 1) {
      if (x == 0 && y == 0) { continue; }
      let off = vec2f(f32(x), f32(y)) * radius * texel;
      let s = textureSampleLevel(fbHistory, fbSampler, in.uv + off, layer, 0.0).rgb;
      if (dilate) { result = max(result, s); }
      else        { result = min(result, s); }
    }
  }
  return vec4f(result, 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.radius  === "number") ? p.radius  : 0;
      scratch[18] = (typeof p.mode    === "number") ? p.mode    : 0;
      scratch[19] = 0;
    },
    description: "Morphological erode / dilate over a 3x3 kernel. radius: kernel-tap offset in framebuffer pixels (0 = pass-through). mode: 'erode' takes per-channel min (shrinks bright regions, grows dark gaps); 'dilate' takes per-channel max (grows bright regions, shrinks dark gaps). Classic alpha-mask cleanup pair: erode-then-dilate (opening) removes small bright specks, dilate-then-erode (closing) fills small dark gaps. Also a stylized look on RGB content."
  },

  /* CustomFilter — user-defined 3x3 convolution kernel. The escape
   * hatch for "I know the kernel I want." Defaults to identity
   * (center=1, rest=0). 9 weight sliders + gain + bias in the
   * props pane; ChannelMix-style identity-default. */
  CustomFilter: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",  t: "texture" },
      { n: "w00", t: "param" }, { n: "w01", t: "param" }, { n: "w02", t: "param" },
      { n: "w10", t: "param" }, { n: "w11", t: "param" }, { n: "w12", t: "param" },
      { n: "w20", t: "param" }, { n: "w21", t: "param" }, { n: "w22", t: "param" },
      { n: "gain", t: "param" },
      { n: "bias", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      w00: 0, w01: 0, w02: 0,
      w10: 0, w11: 1, w12: 0,
      w20: 0, w21: 0, w22: 0,
      gain: 1, bias: 0
    },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=w00, z=w01, w=w02
  params2:       vec4f,    // x=w10, y=w11, z=w12, w=w20
  params3:       vec4f,    // x=w21, y=w22, z=gain, w=bias
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let texel = vec2f(1.0) / u.u_resolution.xy;
  let gain  = u.params3.z;
  let bias  = u.params3.w;
  // Unrolled 3x3 convolution.
  let s00 = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f(-1.0, -1.0) * texel, layer, 0.0).rgb;
  let s01 = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f( 0.0, -1.0) * texel, layer, 0.0).rgb;
  let s02 = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f( 1.0, -1.0) * texel, layer, 0.0).rgb;
  let s10 = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f(-1.0,  0.0) * texel, layer, 0.0).rgb;
  let s11 = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f( 0.0,  0.0) * texel, layer, 0.0).rgb;
  let s12 = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f( 1.0,  0.0) * texel, layer, 0.0).rgb;
  let s20 = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f(-1.0,  1.0) * texel, layer, 0.0).rgb;
  let s21 = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f( 0.0,  1.0) * texel, layer, 0.0).rgb;
  let s22 = textureSampleLevel(fbHistory, fbSampler, in.uv + vec2f( 1.0,  1.0) * texel, layer, 0.0).rgb;
  let acc = s00 * u.params.y  + s01 * u.params.z  + s02 * u.params.w  +
            s10 * u.params2.x + s11 * u.params2.y + s12 * u.params2.z +
            s20 * u.params2.w + s21 * u.params3.x + s22 * u.params3.y;
  let out_c = acc * gain + vec3f(bias);
  return vec4f(clamp(out_c, vec3f(0.0), vec3f(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.w00 === "number") ? p.w00 : 0;
      scratch[18] = (typeof p.w01 === "number") ? p.w01 : 0;
      scratch[19] = (typeof p.w02 === "number") ? p.w02 : 0;
      scratch[20] = (typeof p.w10 === "number") ? p.w10 : 0;
      scratch[21] = (typeof p.w11 === "number") ? p.w11 : 1;
      scratch[22] = (typeof p.w12 === "number") ? p.w12 : 0;
      scratch[23] = (typeof p.w20 === "number") ? p.w20 : 0;
      scratch[24] = (typeof p.w21 === "number") ? p.w21 : 0;
      scratch[25] = (typeof p.w22 === "number") ? p.w22 : 0;
      scratch[26] = (typeof p.gain === "number") ? p.gain : 1;
      scratch[27] = (typeof p.bias === "number") ? p.bias : 0;
    },
    description: "User-defined 3x3 convolution kernel — the escape hatch when you know the matrix you want. 9 weight params (w00..w22, row-major) define the kernel; gain scales the result; bias adds a constant. Identity default = center pixel only (pass-through). Recipes: Laplacian edge-detect (w11=-4, w01=w10=w12=w21=1, rest=0); emboss (w00=-2, w11=1, w22=2, gain=1, bias=0.5); box blur (all=1/9, gain=1); sharpen (w11=5, w01=w10=w12=w21=-1, rest=0)."
  },

  /* =========================================================================
   * v0.3.31 -- CRT shader, full Lottes implementation.
   * v0.3.33 -- high-fidelity upgrades: halation, AA shadow mask,
   *            beam dynamics, color temperature.
   *
   * Port of Timothy Lottes' CRT shader from libretro/common-shaders
   * (crt-lottes.cg). High-fidelity single-pass CRT emulation: barrel-
   * warped frame, per-scanline gaussian weight, horizontal pixel
   * filtering (3-tap + 5-tap rows), soft bloom (5-row pyramid of
   * 5/7/7/7/5 taps), and four shadow-mask variants (slot mask,
   * aperture grille, VGA-stretched, VGA-stretched-2x).
   *
   * v0.3.33 adds four upgrades on top of the baseline Lottes:
   *
   *   1. HALATION -- wide soft phosphor halo from light scattering
   *      inside the CRT glass tube. Distinct from bloom: bloom is in
   *      the emulated-pixel grid (sharp), halation samples directly
   *      from the output framebuffer at large pixel offsets (soft).
   *      12-tap radial pattern (4 cardinal inner + 8 outer).
   *
   *   2. ANTI-ALIASED shadow mask. Lottes' if-else step branches
   *      produce pixel-chunky boundaries between adjacent phosphor
   *      cells; smoothstep transitions clean those edges up at zero
   *      added texture sample cost.
   *
   *   3. BEAM DYNAMICS -- brightness-aware scanline thickening.
   *      Real CRT beams saturate the phosphor at high intensity so
   *      bright scanlines look thicker than dark ones. Modeled as a
   *      luminance-driven boost that kicks in past 40% luma.
   *
   *   4. COLOR TEMPERATURE -- single-slider warmth shift. Approximates
   *      a Bradford-style chromatic adaptation from cool early-tube
   *      P1 phosphors to warm late-era P22 phosphors.
   *
   * Math constants for the Lottes core (hardScan=-8, hardPix=-3,
   * warpX=0.031, warpY=0.041, maskDark=0.5, maskLight=1.5, shape=2.0,
   * bloom=1/16) come verbatim from his .cg source -- the look matches
   * the libretro reference. Gamma handled via the cheap c*c <-> sqrt
   * approximation (gamma 2.0; close enough to sRGB at typical CRT
   * brightness ranges + saves the sRGB-decode cost on the 55 fetches).
   *
   * Cost: ~55 texture samples per fragment with halation + bloom on;
   * ~12 with both off. At 1080p on a mid-range discrete GPU lands
   * around 5-8 ms with everything on. Set bloomAmount or halationAmount
   * to 0 to skip those phases if you're frame-budget constrained.
   *
   * virtualW / virtualH set the EMULATED pixel grid (default
   * 320x240 = NES / arcade era). The input texture is sampled as
   * if it had this resolution -- so any upstream chain renders to
   * the framebuffer at full res, then this node pretends it's a
   * lower-res signal driving the CRT. Crank to 640x480 / 1280x720
   * for cleaner CRT-on-modern-content looks.
   *
   * Reference: github.com/libretro/common-shaders/blob/master/crt/
   *            shaders/crt-lottes.cg (Timothy Lottes, AMD, 2014).
   * ======================================================================== */
  CRT: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition-feedback",
    ins: [
      { n: "in",                t: "texture" },
      { n: "virtualW",          t: "param" },
      { n: "virtualH",          t: "param" },
      { n: "curvature",         t: "param" },
      { n: "scanlineHardness",  t: "param" },
      { n: "pixelHardness",     t: "param" },
      { n: "maskType",          t: "param" },
      { n: "maskStrength",      t: "param" },
      { n: "brightness",        t: "param" },
      { n: "bloomAmount",       t: "param" },
      { n: "shape",             t: "param" },
      // v0.3.33 high-fidelity upgrade params.
      { n: "halationAmount",    t: "param" },
      { n: "halationRadius",    t: "param" },
      { n: "beamDynamics",      t: "param" },
      { n: "temperature",       t: "param" },
      // v0.3.34 highest-fidelity upgrade params.
      { n: "convergence",       t: "param" },
      { n: "persistence",       t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    paramOptions: { maskType: ["none", "slot-mask", "aperture-grille", "VGA-stretched", "VGA-stretched-2x"] },
    params: {
      inLayer: 0,
      // 320x240 = classic NES / arcade era. The whole point of the
      // CRT shader is faking low-res content on a high-res panel;
      // setting this to 1920x1080 makes the effects subtle.
      virtualW: 320, virtualH: 240,
      // Lottes' constants verbatim. curvature single-axis here;
      // the WGSL splits it into x/y internally with the same 0.031/
      // 0.041 ratio (1.3x for y).
      curvature: 0.031,
      scanlineHardness: -8.0,
      pixelHardness: -3.0,
      maskType: 3,           // VGA-stretched -- the most "modern CRT" look
      maskStrength: 1.0,
      brightness: 1.0,
      bloomAmount: 0.0625,   // 1/16, Lottes default
      shape: 2.0,            // gaussian shape exponent
      // v0.3.33 -- high-fidelity additions.
      halationAmount: 0.04,  // wide phosphor halo amplitude
      halationRadius: 10.0,  // halo radius in output framebuffer pixels
      beamDynamics: 0.5,     // brightness-aware scanline thickness boost
      temperature: 0.0,      // color temperature shift (-1=cool, +1=warm)
      // v0.3.34 -- highest-fidelity additions.
      convergence: 0.0,      // RGB beam misalignment in output pixels (0 = perfect)
      persistence: 0.0       // phosphor decay (0 = none, ~0.4 = subtle trail, 0.8 = strong)
    },
    methods: {},
    uniformBytes: 144,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=virtualW, z=virtualH, w=curvature
  params2:       vec4f,    // x=scanHardness, y=pixHardness, z=maskType, w=maskStrength
  params3:       vec4f,    // x=brightness, y=bloomAmount, z=shape, w=halationAmount
  params4:       vec4f,    // x=halationRadius, y=beamDynamics, z=temperature, w=convergence
  params5:       vec4f,    // x=persistence, yzw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;
// v0.3.34 -- second sampled texture for the phosphor-persistence
// path. Bound via the composition-feedback hybrid layout; reads
// last-frame composite output. Last frame's CRT result lives at the
// same display layer as this frame's, so sampling u_layer at the
// same UV gives the previous-frame value at the same screen pixel.
@group(0) @binding(4) var fbFeedback: texture_2d_array<f32>;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// === Lottes CRT building blocks (ported from crt-lottes.cg). ===

// v0.3.34 -- proper sRGB transfer functions. Piecewise linear at
// dark values + power curve elsewhere, matching the IEC 61966-2-1
// standard. ~5% more accurate than the c*c approximation we used
// in v0.3.31-33, especially in shadow regions where bloom and
// halation compound the gamma error.
fn to_linear(c: vec3f) -> vec3f {
  let cutoff = vec3f(0.04045);
  let lo = c / 12.92;
  let hi = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(hi, lo, c < cutoff);
}
fn to_srgb(c: vec3f) -> vec3f {
  let c_safe = max(c, vec3f(0.0));
  let cutoff = vec3f(0.0031308);
  let lo = c_safe * 12.92;
  let hi = 1.055 * pow(c_safe, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(hi, lo, c_safe < cutoff);
}

// Generalized Gaussian. shape=2 = standard gaussian; lower shape
// (~1.3) gives wider tails (softer look); higher (~4) gives squarer
// pulses (sharper scanlines).
fn gaus(pos: f32, scale: f32, shape: f32) -> f32 {
  return exp2(scale * pow(abs(pos), shape));
}

// Distance from the current UV to the nearest emulated-texel center,
// in emulated-pixel units. Range roughly [-0.5, 0.5] per axis.
fn dist_pix(pos: vec2f, tex_size: vec2f) -> vec2f {
  let p = pos * tex_size;
  return -((p - floor(p)) - vec2f(0.5));
}

// Point-sample the upstream framebuffer at one emulated-texel offset
// from pos, with the brightness boost + ToLinear baked in.
fn fetch_pix(pos: vec2f, off: vec2f, layer: u32, tex_size: vec2f, bright: f32) -> vec3f {
  let p = (floor(pos * tex_size + off) + vec2f(0.5)) / tex_size;
  let c = textureSampleLevel(fbHistory, fbSampler, p, layer, 0.0).rgb;
  return to_linear(c) * bright;
}

// 3-tap horizontal gaussian (used for the +/-1 scanlines either side
// of the active line).
fn horz3(pos: vec2f, off: f32, layer: u32, tex_size: vec2f, scale: f32, shape: f32, bright: f32) -> vec3f {
  let b = fetch_pix(pos, vec2f(-1.0, off), layer, tex_size, bright);
  let c = fetch_pix(pos, vec2f( 0.0, off), layer, tex_size, bright);
  let d = fetch_pix(pos, vec2f( 1.0, off), layer, tex_size, bright);
  let dst = dist_pix(pos, tex_size).x;
  let wb = gaus(dst - 1.0, scale, shape);
  let wc = gaus(dst + 0.0, scale, shape);
  let wd = gaus(dst + 1.0, scale, shape);
  return (b * wb + c * wc + d * wd) / (wb + wc + wd);
}

// 5-tap horizontal gaussian (used for the active scanline -- one
// extra tap each side gives smoother color in the focal row).
fn horz5(pos: vec2f, off: f32, layer: u32, tex_size: vec2f, scale: f32, shape: f32, bright: f32) -> vec3f {
  let a = fetch_pix(pos, vec2f(-2.0, off), layer, tex_size, bright);
  let b = fetch_pix(pos, vec2f(-1.0, off), layer, tex_size, bright);
  let c = fetch_pix(pos, vec2f( 0.0, off), layer, tex_size, bright);
  let d = fetch_pix(pos, vec2f( 1.0, off), layer, tex_size, bright);
  let e = fetch_pix(pos, vec2f( 2.0, off), layer, tex_size, bright);
  let dst = dist_pix(pos, tex_size).x;
  let wa = gaus(dst - 2.0, scale, shape);
  let wb = gaus(dst - 1.0, scale, shape);
  let wc = gaus(dst + 0.0, scale, shape);
  let wd = gaus(dst + 1.0, scale, shape);
  let we = gaus(dst + 2.0, scale, shape);
  return (a * wa + b * wb + c * wc + d * wd + e * we) / (wa + wb + wc + wd + we);
}

// 7-tap horizontal gaussian for the bloom phase. Wider kernel +
// softer hardness (hardBloomPix = -1.5 by default) for the diffuse
// halo around bright phosphors.
fn horz7(pos: vec2f, off: f32, layer: u32, tex_size: vec2f, scale: f32, shape: f32, bright: f32) -> vec3f {
  let a = fetch_pix(pos, vec2f(-3.0, off), layer, tex_size, bright);
  let b = fetch_pix(pos, vec2f(-2.0, off), layer, tex_size, bright);
  let c = fetch_pix(pos, vec2f(-1.0, off), layer, tex_size, bright);
  let d = fetch_pix(pos, vec2f( 0.0, off), layer, tex_size, bright);
  let e = fetch_pix(pos, vec2f( 1.0, off), layer, tex_size, bright);
  let f = fetch_pix(pos, vec2f( 2.0, off), layer, tex_size, bright);
  let g = fetch_pix(pos, vec2f( 3.0, off), layer, tex_size, bright);
  let dst = dist_pix(pos, tex_size).x;
  let wa = gaus(dst - 3.0, scale, shape);
  let wb = gaus(dst - 2.0, scale, shape);
  let wc = gaus(dst - 1.0, scale, shape);
  let wd = gaus(dst + 0.0, scale, shape);
  let we = gaus(dst + 1.0, scale, shape);
  let wf = gaus(dst + 2.0, scale, shape);
  let wg = gaus(dst + 3.0, scale, shape);
  return (a * wa + b * wb + c * wc + d * wd + e * we + f * wf + g * wg)
       / (wa + wb + wc + wd + we + wf + wg);
}

// Scanline weight at vertical offset 'off' from the current line.
// dst is signed distance to the nearest scanline center in emulated
// pixels; Gaus shapes the falloff. (No backticks in WGSL comments --
// they close the JS template literal.)
fn scan_w(pos: vec2f, off: f32, tex_size: vec2f, scale: f32, shape: f32) -> f32 {
  let dst = dist_pix(pos, tex_size).y;
  return gaus(dst + off, scale, shape);
}

// Anti-aliased shadow mask. Same 4 patterns as Lottes' original
// but with smoothstep transitions between the R / G / B regions
// instead of hard if-else step branches. Eliminates the visibly
// chunky pixel boundary between adjacent phosphors at the cost of
// a few extra smoothstep calls per fragment. AA_W is the
// transition width in normalized triplet units.
//
// pos is fragment-space (output pixel coords), not UV -- the mask
// is tied to physical screen pixels so it doesn't move when the
// warp shifts the source UV.
//   1 = slot mask (RGB triplets in offset rows, classic NTSC TV)
//   2 = aperture grille (continuous vertical RGB columns, Trinitron)
//   3 = VGA-stretched (diagonal RGB stripes, modern PC CRT)
//   4 = VGA-stretched at 2x vertical (coarser variant of 3)
fn mask_channel_weights(t: f32, aa: f32) -> vec3f {
  // R region [0, 0.333), G region [0.333, 0.666), B region [0.666, 1).
  // Smoothstep across each boundary over a band of width 2*aa.
  let aa_h = max(aa, 0.005);
  let r_w = 1.0 - smoothstep(0.333 - aa_h, 0.333 + aa_h, t);
  let g_w = smoothstep(0.333 - aa_h, 0.333 + aa_h, t)
          - smoothstep(0.666 - aa_h, 0.666 + aa_h, t);
  let b_w = smoothstep(0.666 - aa_h, 0.666 + aa_h, t);
  return vec3f(r_w, g_w, b_w);
}

fn shadow_mask(in_pos: vec2f, mask_type: i32, mask_dark: f32, mask_light: f32) -> vec3f {
  var mask = vec3f(mask_dark);
  var pos = in_pos;
  let aa = 0.04;   // ~4% of triplet width = ~0.12 pixels at the mask's native scale
  if (mask_type == 1) {
    var mask_line = mask_light;
    var odd: f32 = 0.0;
    if (fract(pos.x / 6.0) < 0.5) { odd = 1.0; }
    if (fract((pos.y + odd) / 2.0) < 0.5) { mask_line = mask_dark; }
    let t = fract(pos.x / 3.0);
    let w = mask_channel_weights(t, aa);
    mask = vec3f(mix(mask_dark, mask_light, w.x),
                 mix(mask_dark, mask_light, w.y),
                 mix(mask_dark, mask_light, w.z));
    mask = mask * mask_line;
  } else if (mask_type == 2) {
    let t = fract(pos.x / 3.0);
    let w = mask_channel_weights(t, aa);
    mask = vec3f(mix(mask_dark, mask_light, w.x),
                 mix(mask_dark, mask_light, w.y),
                 mix(mask_dark, mask_light, w.z));
  } else if (mask_type == 3) {
    pos.x = pos.x + pos.y * 3.0;
    let t = fract(pos.x / 6.0);
    let w = mask_channel_weights(t, aa);
    mask = vec3f(mix(mask_dark, mask_light, w.x),
                 mix(mask_dark, mask_light, w.y),
                 mix(mask_dark, mask_light, w.z));
  } else if (mask_type == 4) {
    let pf = floor(pos * vec2f(1.0, 0.5));
    let p2x = pf.x + pf.y * 3.0;
    let t = fract(p2x / 6.0);
    let w = mask_channel_weights(t, aa);
    mask = vec3f(mix(mask_dark, mask_light, w.x),
                 mix(mask_dark, mask_light, w.y),
                 mix(mask_dark, mask_light, w.z));
  }
  return mask;
}

// === v0.3.33 high-fidelity additions ===

// Halation -- wide, soft phosphor halo from light scattering inside
// the CRT glass tube. Distinct from bloom: bloom is in the emulated-
// pixel grid (sharp); halation samples directly from the framebuffer
// at output-pixel offsets (soft). 12-tap radial pattern: 4 cardinal
// at inner radius + 8 octagonal at outer radius. Adds depth/glow
// around bright phosphors without affecting their core sharpness.
fn halation_sample(uv: vec2f, layer: u32, radius_px: f32) -> vec3f {
  let texel = vec2f(1.0) / u.u_resolution.xy;
  let inner_r = radius_px * 0.6;
  // 12 sample offsets, normalized so * radius gives the right
  // distance. Inner ring is at 0.6 (=inner_r/radius_px).
  let offs = array<vec2f, 12>(
    // Inner ring (4 cardinal) -- weighted heavier
    vec2f( 0.6,  0.0), vec2f(-0.6,  0.0),
    vec2f( 0.0,  0.6), vec2f( 0.0, -0.6),
    // Outer ring (4 cardinal + 4 diagonal)
    vec2f( 1.0,  0.0), vec2f(-1.0,  0.0),
    vec2f( 0.0,  1.0), vec2f( 0.0, -1.0),
    vec2f( 0.707,  0.707), vec2f(-0.707,  0.707),
    vec2f( 0.707, -0.707), vec2f(-0.707, -0.707)
  );
  let wts = array<f32, 12>(
    0.12, 0.12, 0.12, 0.12,    // inner cardinal (heavier)
    0.06, 0.06, 0.06, 0.06,    // outer cardinal
    0.045, 0.045, 0.045, 0.045 // outer diagonal
  );
  var acc = vec3f(0.0);
  var w_sum = 0.0;
  for (var i: i32 = 0; i < 12; i = i + 1) {
    let p = uv + offs[i] * radius_px * texel;
    let s = textureSampleLevel(fbHistory, fbSampler, p, layer, 0.0).rgb;
    acc = acc + to_linear(s) * wts[i];
    w_sum = w_sum + wts[i];
  }
  return acc / max(w_sum, 0.001);
}

// Color temperature shift. temp in [-1, 1]: negative = cooler tube
// (early monochromes / weak red phosphor), positive = warmer (late-
// era P22 phosphors with strong red). Multiplicative; identity at
// temp=0. Approximates a Bradford-style chromatic adaptation
// without the full matrix math.
fn apply_temperature(c: vec3f, temp: f32) -> vec3f {
  let warm = clamp(temp, 0.0, 1.0);
  let cool = clamp(-temp, 0.0, 1.0);
  let shift = vec3f(
    1.0 + warm * 0.15 - cool * 0.10,
    1.0 + warm * 0.02 - cool * 0.05,
    1.0 - warm * 0.18 + cool * 0.20
  );
  return c * shift;
}

// === v0.3.34 highest-fidelity additions ===

// Tri pass factored out so the convergence-error path can re-run it
// three times with channel-specific UV offsets. Same math as the
// Lottes Tri: Horz5 active row + Horz3 rows above/below, weighted
// by scanline gaussian. 11 texture samples per call.
fn tri_pass(uv: vec2f, layer: u32, virt_size: vec2f, pix_hard: f32, scan_hard: f32, gauss_shape: f32, bright: f32) -> vec3f {
  let row_a = horz3(uv, -1.0, layer, virt_size, pix_hard, gauss_shape, bright);
  let row_b = horz5(uv,  0.0, layer, virt_size, pix_hard, gauss_shape, bright);
  let row_c = horz3(uv,  1.0, layer, virt_size, pix_hard, gauss_shape, bright);
  let w_a = scan_w(uv, -1.0, virt_size, scan_hard, gauss_shape);
  let w_b = scan_w(uv,  0.0, virt_size, scan_hard, gauss_shape);
  let w_c = scan_w(uv,  1.0, virt_size, scan_hard, gauss_shape);
  return row_a * w_a + row_b * w_b + row_c * w_c;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer        = u32(max(0.0, u.params.x));
  let virt_w       = max(u.params.y, 1.0);
  let virt_h       = max(u.params.z, 1.0);
  let virt_size    = vec2f(virt_w, virt_h);
  let curvature    = max(u.params.w, 0.0);
  let scan_hard    = u.params2.x;
  let pix_hard     = u.params2.y;
  let mask_type    = i32(u.params2.z + 0.5);
  let mask_str     = clamp(u.params2.w, 0.0, 1.0);
  let bright       = max(u.params3.x, 0.0);
  let bloom_amt    = max(u.params3.y, 0.0);
  let gauss_shape  = max(u.params3.z, 0.5);
  let halation_amt = max(u.params3.w, 0.0);
  let halation_rad = max(u.params4.x, 0.5);
  let beam_dyn     = clamp(u.params4.y, 0.0, 1.0);
  let temp         = clamp(u.params4.z, -1.0, 1.0);
  let convergence  = max(u.params4.w, 0.0);
  let persistence  = clamp(u.params5.x, 0.0, 0.95);

  // Barrel warp -- pulls UV in toward center based on distance from
  // the opposite axis, mimicking the bulge of a CRT glass tube.
  // Lottes splits warp into x/y; we apply a 1.3x ratio between them
  // (matches his 0.031/0.041 default ratio).
  var p = in.uv * 2.0 - vec2f(1.0);
  let warp_v = vec2f(curvature, curvature * 1.3225806);   // 0.041/0.031 = 1.3225
  p = p * vec2f(1.0 + (p.y * p.y) * warp_v.x,
                1.0 + (p.x * p.x) * warp_v.y);
  let warped = p * 0.5 + vec2f(0.5);

  // Outside the warped frame: black bezel. Without this you'd see
  // wraparound or mirrored edges in the curved-corner regions.
  if (warped.x < 0.0 || warped.x > 1.0 || warped.y < 0.0 || warped.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  // === Tri: 3 horizontal rows combined by scanline weight. ===
  // Active row uses Horz5 (5-tap) for cleaner color; +/-1 rows use
  // Horz3 (3-tap) since their contribution is heavily attenuated by
  // the scanline weighting anyway.
  //
  // v0.3.34 -- convergence error: real CRT electron beams for R / G
  // / B were slightly misaligned (a few thousandths of an inch). When
  // convergence > 0 we run Tri three separate times with channel-
  // specific UV offsets (R shifted left, B shifted right, G centered)
  // and assemble the per-channel results. 22 extra texture samples
  // when active; identity (single Tri) when convergence=0.
  var color: vec3f;
  if (convergence > 0.01) {
    let texel_x = 1.0 / u.u_resolution.x;
    let off_r = vec2f(-convergence * texel_x, 0.0);
    let off_b = vec2f( convergence * texel_x, 0.0);
    let r_tri = tri_pass(warped + off_r, layer, virt_size, pix_hard, scan_hard, gauss_shape, bright);
    let g_tri = tri_pass(warped,         layer, virt_size, pix_hard, scan_hard, gauss_shape, bright);
    let b_tri = tri_pass(warped + off_b, layer, virt_size, pix_hard, scan_hard, gauss_shape, bright);
    color = vec3f(r_tri.r, g_tri.g, b_tri.b);
  } else {
    color = tri_pass(warped, layer, virt_size, pix_hard, scan_hard, gauss_shape, bright);
  }

  // === Beam dynamics: brightness-aware scanline thickness. ===
  // Real CRT beams thicken with intensity -- bright pixels saturate
  // the phosphor + the scanline gap appears smaller. Modeled here
  // as a luminance-driven brightness boost that kicks in past ~0.4
  // luma; the boost is shaped so dark regions get no change and
  // highlights get up to ~50% extra intensity (which after the
  // post-bloom dynamic range translates to thicker visible scans).
  if (beam_dyn > 0.001) {
    let lum = dot(color, vec3f(0.2126, 0.7152, 0.0722));
    let boost = 1.0 + beam_dyn * smoothstep(0.4, 1.0, lum) * 0.5;
    color = color * boost;
  }

  // === Bloom: 5-row pyramid (5/7/7/7/5 taps) with softer scanline
  // weights (hardBloomScan = -2). Skipped at bloom_amt=0 to save
  // ~31 texture samples. ===
  if (bloom_amt > 0.001) {
    let bloom_pix  = -1.5;
    let bloom_scan = -2.0;
    let bl_a = horz5(warped, -2.0, layer, virt_size, bloom_pix, gauss_shape, bright);
    let bl_b = horz7(warped, -1.0, layer, virt_size, bloom_pix, gauss_shape, bright);
    let bl_c = horz7(warped,  0.0, layer, virt_size, bloom_pix, gauss_shape, bright);
    let bl_d = horz7(warped,  1.0, layer, virt_size, bloom_pix, gauss_shape, bright);
    let bl_e = horz5(warped,  2.0, layer, virt_size, bloom_pix, gauss_shape, bright);
    let bw_a = scan_w(warped, -2.0, virt_size, bloom_scan, gauss_shape);
    let bw_b = scan_w(warped, -1.0, virt_size, bloom_scan, gauss_shape);
    let bw_c = scan_w(warped,  0.0, virt_size, bloom_scan, gauss_shape);
    let bw_d = scan_w(warped,  1.0, virt_size, bloom_scan, gauss_shape);
    let bw_e = scan_w(warped,  2.0, virt_size, bloom_scan, gauss_shape);
    let bloom = bl_a * bw_a + bl_b * bw_b + bl_c * bw_c + bl_d * bw_d + bl_e * bw_e;
    color = color + bloom * bloom_amt;
  }

  // === Halation: wide soft phosphor glow from light scattering
  // in the CRT glass. 12 taps at output-framebuffer-pixel offsets
  // (not the emulated grid). Skipped at halation_amt=0. ===
  if (halation_amt > 0.001) {
    let halo = halation_sample(warped, layer, halation_rad);
    color = color + halo * halation_amt;
  }

  // === Shadow mask (AA'd in v0.3.33): physical-pixel grid (not UV),
  // so it doesn't move when the warp shifts the source. ===
  if (mask_type > 0) {
    let frag_xy = in.uv * u.u_resolution.xy;
    let m = shadow_mask(frag_xy, mask_type, 0.5, 1.5);
    color = color * mix(vec3f(1.0), m, mask_str);
  }

  // === Color temperature: shift the white point. ===
  if (abs(temp) > 0.001) {
    color = apply_temperature(color, temp);
  }

  // === v0.3.34 phosphor persistence: blend in last frame's output. ===
  // Real CRT phosphors decay over a few milliseconds (P22 ~1-2 ms),
  // so on a 60Hz display some of the previous frame's brightness
  // carries into the current frame. We sample fbFeedback (last
  // frame's composite output) at the CRT's OWN output display layer
  // (u_layer = where this CRT pass writes -- NOT inLayer which is
  // the upstream's input layer) so we read last frame's CRT result
  // at the same screen position. Max-blend in linear space:
  // preserves both new sharp content + old decaying brights, which
  // is how real phosphor decay reads.
  if (persistence > 0.001) {
    let out_layer = u32(max(0.0, u.u_layer));
    let prev_srgb = textureSampleLevel(fbFeedback, fbSampler, in.uv, out_layer, 0.0).rgb;
    let prev_lin  = to_linear(prev_srgb);
    color = max(color, prev_lin * persistence);
  }

  // sRGB encode (proper IEC 61966-2-1 transfer function, matching
  // the decode in fetch_pix and persistence sample).
  let out_c = to_srgb(color);
  return vec4f(clamp(out_c, vec3f(0.0), vec3f(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer          === "number") ? p.inLayer          : 0;
      scratch[17] = (typeof p.virtualW         === "number") ? p.virtualW         : 320;
      scratch[18] = (typeof p.virtualH         === "number") ? p.virtualH         : 240;
      scratch[19] = (typeof p.curvature        === "number") ? p.curvature        : 0.031;
      scratch[20] = (typeof p.scanlineHardness === "number") ? p.scanlineHardness : -8.0;
      scratch[21] = (typeof p.pixelHardness    === "number") ? p.pixelHardness    : -3.0;
      scratch[22] = (typeof p.maskType         === "number") ? p.maskType         : 3;
      scratch[23] = (typeof p.maskStrength     === "number") ? p.maskStrength     : 1.0;
      scratch[24] = (typeof p.brightness       === "number") ? p.brightness       : 1.0;
      scratch[25] = (typeof p.bloomAmount      === "number") ? p.bloomAmount      : 0.0625;
      scratch[26] = (typeof p.shape            === "number") ? p.shape            : 2.0;
      scratch[27] = (typeof p.halationAmount   === "number") ? p.halationAmount   : 0.04;
      scratch[28] = (typeof p.halationRadius   === "number") ? p.halationRadius   : 10.0;
      scratch[29] = (typeof p.beamDynamics     === "number") ? p.beamDynamics     : 0.5;
      scratch[30] = (typeof p.temperature      === "number") ? p.temperature      : 0.0;
      scratch[31] = (typeof p.convergence      === "number") ? p.convergence      : 0.0;
      scratch[32] = (typeof p.persistence      === "number") ? p.persistence      : 0.0;
      scratch[33] = 0; scratch[34] = 0; scratch[35] = 0;
    },
    description: "Highest-fidelity CRT emulation. Lottes single-pass core (barrel warp + Tri scanline gaussian + 5-row bloom pyramid + four shadow-mask variants) + v0.3.33 additions (halation, AA mask, beam dynamics, color temperature) + v0.3.34 additions: CONVERGENCE ERROR (RGB beam misalignment via per-channel Tri offsets; +22 samples when active), PHOSPHOR PERSISTENCE (last-frame max-blend trail via the hybrid composition-feedback bind layout; +1 sample when active), and PROPER sRGB GAMMA (IEC 61966-2-1 transfer function in place of the v0.3.31-33 c*c approximation). virtualW/H: emulated resolution (320x240 = arcade/NES; bump for subtler modern-content looks). curvature: barrel intensity (0.031 default). scanlineHardness / pixelHardness: negative gaussian scales. maskType: 0=none, 1=slot, 2=aperture grille, 3=VGA-stretched (default), 4=VGA-stretched-2x. bloomAmount: in-pixel-grid glow (0 = skip 31 samples). halationAmount: wide soft glow (0 = skip 12 samples). beamDynamics: highlight scan thickening. temperature: -1 cool to +1 warm. convergence: RGB beam offset in OUTPUT pixels (0 = perfect; ~0.5 = subtle vintage; ~1.5 = pronounced fringing). persistence: phosphor decay (0 = none; ~0.4 = subtle trail like P22; ~0.8 = long-decay P39 phosphor look). Cost: ~12-90 samples per fragment depending on which features are on; 1080p budget 5-12 ms with everything maxed (mid-range discrete GPU). Royale-style multi-pass subpixel rendering deferred to multi-pass infrastructure ticket."
  },

  /* =========================================================================
   * v0.3.36 -- Video-edit suite, sprint 4: Effect / Stylize.
   *
   * Seven composition shader-frag nodes covering the "give me a look"
   * stylize category. All single-pass, identity-default state is
   * pass-through across the board (per the design conventions in
   * ROADMAP §5.2). Math choices are principled where it matters
   * (proper sRGB gamma on color-grading paths, physically-motivated
   * radial falloffs on lens-mimicking nodes); cheap approximations
   * only where the visual difference is imperceptible.
   * ======================================================================== */

  /* Vignette -- radial darkening, photography-style. Distance from
   * a configurable center, smoothstep falloff with controllable
   * radius + softness + intensity. Roundness param interpolates
   * between true-circle (0) and "extended/squarish" (1) falloff
   * via an Lp-norm trick. Color param controls what the picture
   * darkens TO (black by default; warm grey or cool blue for
   * cinematic looks). */
  Vignette: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",        t: "texture" },
      { n: "centerX",   t: "param" },
      { n: "centerY",   t: "param" },
      { n: "radius",    t: "param" },
      { n: "softness",  t: "param" },
      { n: "intensity", t: "param" },
      { n: "roundness", t: "param" },
      { n: "colorR",    t: "param" },
      { n: "colorG",    t: "param" },
      { n: "colorB",    t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      centerX: 0.5, centerY: 0.5,
      radius: 0.7,
      softness: 0.4,
      intensity: 0.0,    // 0 = pass-through; identity default
      roundness: 0.0,    // 0 = circle (Euclidean), 1 = squarish (Lp norm with p=4)
      colorR: 0.0, colorG: 0.0, colorB: 0.0
    },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=centerX, z=centerY, w=radius
  params2:       vec4f,    // x=softness, y=intensity, z=roundness, w=_
  params3:       vec4f,    // x=colorR, y=colorG, z=colorB, w=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let cx    = u.params.y;
  let cy    = u.params.z;
  let r     = max(u.params.w, 0.001);
  let soft  = max(u.params2.x, 0.001);
  let amt   = clamp(u.params2.y, 0.0, 1.0);
  let round = clamp(u.params2.z, 0.0, 1.0);

  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);

  // Distance from center, with aspect correction so a circle on a
  // 16:9 framebuffer is a true circle not an ellipse. delta is in
  // square-pixel units relative to height.
  let aspect = u.u_resolution.x / max(u.u_resolution.y, 1.0);
  let delta = (in.uv - vec2f(cx, cy)) * vec2f(aspect, 1.0);
  // Lp-norm distance: p=2 (Euclidean circle) when round=0, p=4
  // (squarish corner) when round=1. Linearly interpolating the
  // exponent gives a clean roundness slider.
  let p_exp = mix(2.0, 4.0, round);
  let dist = pow(pow(abs(delta.x), p_exp) + pow(abs(delta.y), p_exp), 1.0 / p_exp);

  // Smoothstep darken: 0 inside the radius, ramping to 1 over soft.
  let v = smoothstep(r, r + soft, dist) * amt;
  let vig_color = vec3f(u.params3.x, u.params3.y, u.params3.z);
  let out_c = mix(c.rgb, vig_color, v);
  return vec4f(out_c, c.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer   === "number") ? p.inLayer   : 0;
      scratch[17] = (typeof p.centerX   === "number") ? p.centerX   : 0.5;
      scratch[18] = (typeof p.centerY   === "number") ? p.centerY   : 0.5;
      scratch[19] = (typeof p.radius    === "number") ? p.radius    : 0.7;
      scratch[20] = (typeof p.softness  === "number") ? p.softness  : 0.4;
      scratch[21] = (typeof p.intensity === "number") ? p.intensity : 0.0;
      scratch[22] = (typeof p.roundness === "number") ? p.roundness : 0.0;
      scratch[23] = 0;
      scratch[24] = (typeof p.colorR    === "number") ? p.colorR    : 0.0;
      scratch[25] = (typeof p.colorG    === "number") ? p.colorG    : 0.0;
      scratch[26] = (typeof p.colorB    === "number") ? p.colorB    : 0.0;
      scratch[27] = 0;
    },
    description: "Photographic vignette — radial darkening (or color shift) toward the corners. centerX/Y: vignette center in [0,1] UV (default 0.5, 0.5). radius: inner edge of falloff (within this distance, image is untouched). softness: width of the smoothstep falloff. intensity: 0 = pass-through (identity), 1 = full darken to colorRGB at the corners. roundness: 0 = true circle (aspect-corrected so it's circular on widescreen framebuffers, not elliptical), 1 = squarish Lp-norm shape (extended into corners). colorR/G/B: what the picture darkens TO (default black; warm grey for cinematic, dark blue for night-look)."
  },

  /* ChromaticAberration -- radial RGB channel separation. Models lens
   * dispersion: red light bends less than blue, so red goes outward
   * and blue goes inward relative to the optical axis (center). The
   * effect grows with distance from center (no aberration at the
   * sweet spot, maximum at the edges) following a power curve. */
  ChromaticAberration: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",            t: "texture" },
      { n: "amount",        t: "param" },
      { n: "falloffPower",  t: "param" },
      { n: "centerX",       t: "param" },
      { n: "centerY",       t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      amount: 0.0,        // 0 = identity; ~0.01 subtle, ~0.05 noticeable, ~0.15 pronounced
      falloffPower: 2.0,  // distance^p: 2 = quadratic (physical lens), 1 = linear, 4 = sharper at edges
      centerX: 0.5, centerY: 0.5
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=amount, z=falloffPower, w=_
  params2:       vec4f,    // x=centerX, y=centerY, zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer  = u32(max(0.0, u.params.x));
  let amount = u.params.y;
  let pow_x  = max(u.params.z, 0.1);
  let cx     = u.params2.x;
  let cy     = u.params2.y;

  if (abs(amount) < 0.0001) {
    return textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  }

  // Radial direction from center to this fragment.
  let centered = in.uv - vec2f(cx, cy);
  let dist = length(centered);
  // Falloff: 0 at center, 1 at distance 0.7 (~corner of normalized
  // square). Power curve gives finer control over edge falloff.
  let falloff = pow(min(dist / 0.7, 1.0), pow_x);
  // Direction unit vector (safe at center via small epsilon).
  let dir = centered / max(dist, 1e-6);
  // Per-channel offset: R outward, B inward, G centered.
  let off_r =  dir * amount * falloff;
  let off_b = -dir * amount * falloff;

  let r = textureSampleLevel(fbHistory, fbSampler, in.uv + off_r, layer, 0.0).r;
  let g = textureSampleLevel(fbHistory, fbSampler, in.uv,         layer, 0.0).g;
  let b = textureSampleLevel(fbHistory, fbSampler, in.uv + off_b, layer, 0.0).b;
  let a = textureSampleLevel(fbHistory, fbSampler, in.uv,         layer, 0.0).a;
  return vec4f(r, g, b, a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer       === "number") ? p.inLayer       : 0;
      scratch[17] = (typeof p.amount        === "number") ? p.amount        : 0.0;
      scratch[18] = (typeof p.falloffPower  === "number") ? p.falloffPower  : 2.0;
      scratch[19] = 0;
      scratch[20] = (typeof p.centerX       === "number") ? p.centerX       : 0.5;
      scratch[21] = (typeof p.centerY       === "number") ? p.centerY       : 0.5;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "Radial chromatic aberration — models lens dispersion. Red shifts outward, blue inward; green stays at the unshifted position. amount: maximum offset in normalized UV (0 = pass-through; 0.01 subtle, 0.05 noticeable, 0.15 pronounced). falloffPower: distance^p shape (2 = quadratic / physically motivated, 1 = linear, 4 = sharper edge-only). centerX/Y: optical axis (default 0.5, 0.5 = frame center). Identity at amount=0."
  },

  /* FilmGrain -- animated procedural noise. Hash-based per-pixel
   * dither at the OUTPUT framebuffer resolution scaled to a
   * configurable cell size, animated via u.u_time. Optional
   * luminance-weighted strength (more grain in shadows than
   * highlights, mimicking real silver-halide film). Chroma /
   * mono mix controls whether the grain is monochromatic
   * (single noise value applied to all 3 channels) or chromatic
   * (independent noise per channel; reads as colored speckle). */
  FilmGrain: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",                t: "texture" },
      { n: "amount",            t: "param" },
      { n: "grainSize",         t: "param" },
      { n: "chromaMix",         t: "param" },
      { n: "speed",             t: "param" },
      { n: "luminanceWeight",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      amount: 0.0,           // 0 = identity; 0.05 subtle, 0.15 noticeable, 0.3 heavy
      grainSize: 1.5,        // grain cell size in framebuffer pixels (1 = per-pixel, 3 = chunky)
      chromaMix: 0.3,        // 0 = pure mono noise, 1 = full chromatic noise
      speed: 24.0,           // animation rate (frames-per-second feel; 24 = filmic)
      luminanceWeight: 0.6   // 0 = uniform grain, 1 = much more grain in shadows
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=amount, z=grainSize, w=chromaMix
  params2:       vec4f,    // x=speed, y=luminanceWeight, zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// 3D hash for animated grain. The 3rd dimension is time (in
// quantized frame steps) so the grain re-shuffles per frame.
// Triple-prime constants for good distribution.
fn hash13(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer       = u32(max(0.0, u.params.x));
  let amount      = u.params.y;
  let grain_size  = max(u.params.z, 0.5);
  let chroma_mix  = clamp(u.params.w, 0.0, 1.0);
  let speed       = max(u.params2.x, 0.1);
  let lum_weight  = clamp(u.params2.y, 0.0, 1.0);

  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  if (abs(amount) < 0.0001) { return c; }

  // Quantize the UV to grain cells. Cell size in framebuffer pixels.
  let cell_uv = floor(in.uv * u.u_resolution.xy / grain_size);
  // Time step: u.u_time * speed, floored to discrete "film frames".
  let t_step = floor(u.u_time * speed);

  // Mono noise (single value per cell).
  let n_mono = hash13(vec3f(cell_uv.x, cell_uv.y, t_step)) - 0.5;
  // Chroma noise (per-channel independent).
  let n_r = hash13(vec3f(cell_uv.x, cell_uv.y, t_step +   1.7)) - 0.5;
  let n_g = hash13(vec3f(cell_uv.x, cell_uv.y, t_step +   3.3)) - 0.5;
  let n_b = hash13(vec3f(cell_uv.x, cell_uv.y, t_step +   7.1)) - 0.5;
  let n_chroma = vec3f(n_r, n_g, n_b);
  let n = mix(vec3f(n_mono), n_chroma, chroma_mix);

  // Luminance weighting: shadows get more grain than highlights
  // (real film's grain visibility curve). lum_weight=0 disables.
  let lum = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lum_mod = mix(1.0, 1.0 - 0.7 * lum, lum_weight);

  let out_rgb = c.rgb + n * amount * lum_mod;
  return vec4f(clamp(out_rgb, vec3f(0.0), vec3f(1.0)), c.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer          === "number") ? p.inLayer          : 0;
      scratch[17] = (typeof p.amount           === "number") ? p.amount           : 0.0;
      scratch[18] = (typeof p.grainSize        === "number") ? p.grainSize        : 1.5;
      scratch[19] = (typeof p.chromaMix        === "number") ? p.chromaMix        : 0.3;
      scratch[20] = (typeof p.speed            === "number") ? p.speed            : 24.0;
      scratch[21] = (typeof p.luminanceWeight  === "number") ? p.luminanceWeight  : 0.6;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "Animated film grain. Hash-based noise quantized to configurable cell size, re-shuffled per discrete time step (mimics film's per-frame grain pattern). amount: noise intensity (0 = identity, 0.05 subtle, 0.15 noticeable, 0.3 heavy). grainSize: grain cell in framebuffer pixels (1 = per-pixel chatter, 3 = chunky, 6 = visible grain spots). chromaMix: 0 = monochromatic (same noise to all channels), 1 = independent per-channel (colored speckle). speed: animation rate in frames-per-second feel (24 = filmic motion-picture). luminanceWeight: shadows get more grain than highlights (mimics real silver-halide film's grain visibility curve); 0 = uniform, 1 = strong shadow-bias."
  },

  /* HotSpot -- lens flare anchor. A bright point with radial
   * gaussian falloff plus an optional anamorphic horizontal streak
   * (the "blue beam" from sci-fi lens flares). Composed ADDITIVELY
   * over the input -- intended to be wired AFTER a darker pass so
   * the flare reads as light. Doesn't sample the input at offsets;
   * just adds a procedural flare to the existing color. */
  HotSpot: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",              t: "texture" },
      { n: "centerX",         t: "param" },
      { n: "centerY",         t: "param" },
      { n: "coreRadius",      t: "param" },
      { n: "intensity",       t: "param" },
      { n: "colorR",          t: "param" },
      { n: "colorG",          t: "param" },
      { n: "colorB",          t: "param" },
      { n: "spikeAngle",      t: "param" },
      { n: "spikeLength",     t: "param" },
      { n: "spikeIntensity",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      centerX: 0.5, centerY: 0.5,
      coreRadius: 0.05,
      intensity: 0.0,       // 0 = identity
      colorR: 1.0, colorG: 0.85, colorB: 0.6,   // warm white-ish (sun)
      spikeAngle: 0.0,      // degrees; 0 = horizontal anamorphic streak
      spikeLength: 0.4,
      spikeIntensity: 0.7
    },
    methods: {},
    uniformBytes: 128,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=centerX, z=centerY, w=coreRadius
  params2:       vec4f,    // x=intensity, y=colorR, z=colorG, w=colorB
  params3:       vec4f,    // x=spikeAngle (deg), y=spikeLength, z=spikeIntensity, w=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer   = u32(max(0.0, u.params.x));
  let cx      = u.params.y;
  let cy      = u.params.z;
  let core_r  = max(u.params.w, 0.001);
  let amt     = max(u.params2.x, 0.0);
  let flare_c = vec3f(u.params2.y, u.params2.z, u.params2.w);
  let spike_deg     = u.params3.x;
  let spike_len     = max(u.params3.y, 0.001);
  let spike_int     = max(u.params3.z, 0.0);

  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  if (amt < 0.0001) { return c; }

  // Aspect-correct distance from center so the core is circular.
  let aspect = u.u_resolution.x / max(u.u_resolution.y, 1.0);
  let centered = (in.uv - vec2f(cx, cy)) * vec2f(aspect, 1.0);

  // Gaussian core. Power-2 falloff at distance / core_r.
  let core_d = length(centered) / core_r;
  let core_gauss = exp(-core_d * core_d);

  // Anamorphic streak: rotate the fragment into spike-local space,
  // gaussian falloff along the perpendicular axis (sharp streak),
  // exponential falloff along the parallel axis (long beam).
  let ang = spike_deg * 0.01745329;
  let cs = cos(ang); let sn = sin(ang);
  let local = vec2f(cs * centered.x + sn * centered.y,
                   -sn * centered.x + cs * centered.y);
  // streak: thin in y (perpendicular), long in x (parallel)
  let streak_perp = local.y / 0.01;         // 0.01 = streak thinness
  let streak_par  = local.x / spike_len;
  let streak = exp(-streak_perp * streak_perp) * exp(-streak_par * streak_par * 0.3);

  let flare = flare_c * (core_gauss + streak * spike_int) * amt;
  return vec4f(c.rgb + flare, c.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer         === "number") ? p.inLayer         : 0;
      scratch[17] = (typeof p.centerX         === "number") ? p.centerX         : 0.5;
      scratch[18] = (typeof p.centerY         === "number") ? p.centerY         : 0.5;
      scratch[19] = (typeof p.coreRadius      === "number") ? p.coreRadius      : 0.05;
      scratch[20] = (typeof p.intensity       === "number") ? p.intensity       : 0.0;
      scratch[21] = (typeof p.colorR          === "number") ? p.colorR          : 1.0;
      scratch[22] = (typeof p.colorG          === "number") ? p.colorG          : 0.85;
      scratch[23] = (typeof p.colorB          === "number") ? p.colorB          : 0.6;
      scratch[24] = (typeof p.spikeAngle      === "number") ? p.spikeAngle      : 0.0;
      scratch[25] = (typeof p.spikeLength     === "number") ? p.spikeLength     : 0.4;
      scratch[26] = (typeof p.spikeIntensity  === "number") ? p.spikeIntensity  : 0.7;
      scratch[27] = 0;
    },
    description: "Lens flare anchor. Adds a bright point with gaussian core + optional anamorphic horizontal streak (the 'blue beam' from sci-fi lens flares) ADDITIVELY over the input. centerX/Y: flare position in UV. coreRadius: gaussian core size (0.05 = small bright sun, 0.2 = large sky glow). intensity: 0 = identity, 1 = full brightness. colorR/G/B: flare tint (default warm white = sun-like). spikeAngle: anamorphic streak angle in degrees (0 = horizontal). spikeLength: streak extent in normalized UV. spikeIntensity: streak brightness relative to the core. Identity at intensity=0."
  },

  /* LightRays -- crepuscular rays / god rays. Per-fragment march
   * from this pixel back toward a source point, accumulating
   * brightness with exponential decay along the way. Reads
   * brightness from the upstream framebuffer at each step; bright
   * areas near the light source contribute most. Classic post-FX
   * approach (Mitchell 2007, Sousa 2008). */
  LightRays: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",            t: "texture" },
      { n: "centerX",       t: "param" },
      { n: "centerY",       t: "param" },
      { n: "intensity",     t: "param" },
      { n: "decay",         t: "param" },
      { n: "density",       t: "param" },
      { n: "exposure",      t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      centerX: 0.5, centerY: 0.3,   // light source position (default upper-center for "sky")
      intensity: 0.0,                // 0 = identity
      decay: 0.96,                   // per-step brightness retention (closer to 1 = longer rays)
      density: 0.9,                  // step length factor (1 = full distance, 0.5 = tighter samples)
      exposure: 0.25                 // final composite scale on the ray accumulation
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=centerX, z=centerY, w=intensity
  params2:       vec4f,    // x=decay, y=density, z=exposure, w=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer    = u32(max(0.0, u.params.x));
  let cx       = u.params.y;
  let cy       = u.params.z;
  let amt      = max(u.params.w, 0.0);
  let decay    = clamp(u.params2.x, 0.0, 0.999);
  let density  = clamp(u.params2.y, 0.05, 2.0);
  let exposure = max(u.params2.z, 0.0);

  let base = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  if (amt < 0.0001) { return base; }

  // Step from the fragment toward the light source. 32 samples is
  // enough for smooth rays without obvious banding.
  let NUM_SAMPLES: i32 = 32;
  let n_f = f32(NUM_SAMPLES);
  let center = vec2f(cx, cy);
  let delta = (center - in.uv) * (density / n_f);

  var uv = in.uv;
  var illum = 1.0;
  var acc = vec3f(0.0);
  for (var i: i32 = 0; i < NUM_SAMPLES; i = i + 1) {
    uv = uv + delta;
    let s = textureSampleLevel(fbHistory, fbSampler, uv, layer, 0.0).rgb;
    acc = acc + s * illum;
    illum = illum * decay;
  }
  // Normalize by sample count + scale by exposure + intensity.
  let rays = acc * (exposure / n_f);
  return vec4f(base.rgb + rays * amt, base.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer    === "number") ? p.inLayer    : 0;
      scratch[17] = (typeof p.centerX    === "number") ? p.centerX    : 0.5;
      scratch[18] = (typeof p.centerY    === "number") ? p.centerY    : 0.3;
      scratch[19] = (typeof p.intensity  === "number") ? p.intensity  : 0.0;
      scratch[20] = (typeof p.decay      === "number") ? p.decay      : 0.96;
      scratch[21] = (typeof p.density    === "number") ? p.density    : 0.9;
      scratch[22] = (typeof p.exposure   === "number") ? p.exposure   : 0.25;
      scratch[23] = 0;
    },
    description: "Crepuscular rays / god rays — radial light scatter from a configurable source point. Per-fragment marches 32 samples back toward the source, accumulating brightness with exponential decay; bright areas near the source produce visible 'beams' through the rest of the frame. centerX/Y: light source UV (default 0.5, 0.3 = upper-center sky position). intensity: 0 = identity, 1 = full strength. decay: per-step brightness retention (0.96 = subtle long rays, 0.85 = sharper short rays). density: step length factor (1 = full march, 0.5 = tighter sampling near source). exposure: final composite scale. Best when upstream has high-contrast bright spots (sun, lit windows, plasma highlights) — the rays form from whatever is bright at each step's UV. ~32 texture samples per fragment when active."
  },

  /* Vortex -- radial twirl / swirl. Rotates the sample UV around
   * a center by an angle that grows with distance from center,
   * bounded by a falloff radius. Looks like swirling water or a
   * black hole's accretion disk distortion. */
  Vortex: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",        t: "texture" },
      { n: "centerX",   t: "param" },
      { n: "centerY",   t: "param" },
      { n: "strength",  t: "param" },
      { n: "radius",    t: "param" },
      { n: "falloff",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      centerX: 0.5, centerY: 0.5,
      strength: 0.0,    // 0 = identity; angle scale in radians
      radius: 0.5,      // effect extent in normalized UV
      falloff: 2.0      // power curve on the (1 - distance/radius) envelope (2 = smooth, 1 = linear)
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=centerX, z=centerY, w=strength
  params2:       vec4f,    // x=radius, y=falloff, zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer    = u32(max(0.0, u.params.x));
  let cx       = u.params.y;
  let cy       = u.params.z;
  let strength = u.params.w;
  let radius   = max(u.params2.x, 0.001);
  let falloff  = max(u.params2.y, 0.1);

  if (abs(strength) < 0.0001) {
    return textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  }

  // Aspect-correct centered coords so the swirl is circular.
  let aspect = u.u_resolution.x / max(u.u_resolution.y, 1.0);
  let centered = (in.uv - vec2f(cx, cy)) * vec2f(aspect, 1.0);
  let dist = length(centered);

  // Envelope: max rotation at center, falls to 0 at radius edge.
  let env = pow(max(1.0 - dist / radius, 0.0), falloff);
  let theta = strength * env;
  let cs = cos(theta); let sn = sin(theta);

  // Rotate the centered coord by -theta (inverse-mapping output -> input).
  let rotated = vec2f(cs * centered.x - sn * centered.y,
                      sn * centered.x + cs * centered.y);
  // Un-aspect + re-translate to UV.
  let sample_uv = rotated / vec2f(aspect, 1.0) + vec2f(cx, cy);

  return textureSampleLevel(fbHistory, fbSampler, sample_uv, layer, 0.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer   === "number") ? p.inLayer   : 0;
      scratch[17] = (typeof p.centerX   === "number") ? p.centerX   : 0.5;
      scratch[18] = (typeof p.centerY   === "number") ? p.centerY   : 0.5;
      scratch[19] = (typeof p.strength  === "number") ? p.strength  : 0.0;
      scratch[20] = (typeof p.radius    === "number") ? p.radius    : 0.5;
      scratch[21] = (typeof p.falloff   === "number") ? p.falloff   : 2.0;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "Radial twirl — rotates sample UV around a center by an angle that grows with distance, bounded by a falloff envelope. strength: max rotation in radians at the center (0 = identity; PI = half-turn; 4*PI = aggressive swirl). centerX/Y: swirl center. radius: effect extent in UV; beyond this distance the swirl tapers to 0. falloff: power curve on the (1 - d/r) envelope (2 = smooth, 1 = linear, 4 = sharp center). Wire MasterClock.phase * 4 → strength for continuous rotation; clock.bar → strength for rhythmic swirls."
  },

  /* PseudoColor -- luma-driven gradient remap. Maps grayscale
   * luminance through a 3-stop gradient (shadow / mid / highlight)
   * to produce false-color looks. midpoint param adjusts where
   * the mid color sits on the 0..1 luma axis. Useful for
   * heat-map / thermal / infrared / hot-cold visualizations. */
  PseudoColor: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",         t: "texture" },
      { n: "shadowR",    t: "param" },
      { n: "shadowG",    t: "param" },
      { n: "shadowB",    t: "param" },
      { n: "midR",       t: "param" },
      { n: "midG",       t: "param" },
      { n: "midB",       t: "param" },
      { n: "highR",      t: "param" },
      { n: "highG",      t: "param" },
      { n: "highB",      t: "param" },
      { n: "midpoint",   t: "param" },
      { n: "mix",        t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      // Default = "thermal/infrared" preset: deep blue -> magenta -> warm yellow.
      shadowR: 0.0, shadowG: 0.0, shadowB: 0.3,
      midR:    0.7, midG:    0.0, midB:    0.5,
      highR:   1.0, highG:   0.9, highB:   0.2,
      midpoint: 0.5,
      mix: 0.0           // 0 = identity (pass through original); 1 = full pseudo-color remap
    },
    methods: {},
    uniformBytes: 128,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=shadowR, z=shadowG, w=shadowB
  params2:       vec4f,    // x=midR, y=midG, z=midB, w=highR
  params3:       vec4f,    // x=highG, y=highB, z=midpoint, w=mix
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer    = u32(max(0.0, u.params.x));
  let shadow_c = vec3f(u.params.y,  u.params.z,  u.params.w);
  let mid_c    = vec3f(u.params2.x, u.params2.y, u.params2.z);
  let high_c   = vec3f(u.params2.w, u.params3.x, u.params3.y);
  let midpt    = clamp(u.params3.z, 0.05, 0.95);
  let amt      = clamp(u.params3.w, 0.0, 1.0);

  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  if (amt < 0.0001) { return c; }

  // Rec.709 luminance.
  let lum = clamp(dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);

  // Piecewise interpolation between (shadow, mid, high) anchored at
  // (0, midpt, 1). Smoothstep gives the bands a soft transition.
  var remap: vec3f;
  if (lum < midpt) {
    let t = lum / max(midpt, 0.0001);
    remap = mix(shadow_c, mid_c, smoothstep(0.0, 1.0, t));
  } else {
    let t = (lum - midpt) / max(1.0 - midpt, 0.0001);
    remap = mix(mid_c, high_c, smoothstep(0.0, 1.0, t));
  }
  return vec4f(mix(c.rgb, remap, amt), c.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer  === "number") ? p.inLayer  : 0;
      scratch[17] = (typeof p.shadowR  === "number") ? p.shadowR  : 0.0;
      scratch[18] = (typeof p.shadowG  === "number") ? p.shadowG  : 0.0;
      scratch[19] = (typeof p.shadowB  === "number") ? p.shadowB  : 0.3;
      scratch[20] = (typeof p.midR     === "number") ? p.midR     : 0.7;
      scratch[21] = (typeof p.midG     === "number") ? p.midG     : 0.0;
      scratch[22] = (typeof p.midB     === "number") ? p.midB     : 0.5;
      scratch[23] = (typeof p.highR    === "number") ? p.highR    : 1.0;
      scratch[24] = (typeof p.highG    === "number") ? p.highG    : 0.9;
      scratch[25] = (typeof p.highB    === "number") ? p.highB    : 0.2;
      scratch[26] = (typeof p.midpoint === "number") ? p.midpoint : 0.5;
      scratch[27] = (typeof p.mix      === "number") ? p.mix      : 0.0;
    },
    description: "Luma-driven false-color remap (thermal / infrared / heat-map looks). Maps Rec.709 luminance through a 3-stop gradient: shadow color at luma=0, mid color at luma=midpoint, high color at luma=1, with smoothstep transitions between bands. mix: 0 = identity (pass-through), 1 = full remap. Default palette is a thermal-IR preset: deep blue shadows → magenta midtones → warm yellow highlights. For sepia: shadow=(0.3, 0.1, 0.05), mid=(0.7, 0.5, 0.3), high=(1.0, 0.95, 0.8). For X-ray: invert luma upstream then remap with shadow=black, mid=cyan, high=white. midpoint shifts where the mid color anchors on the 0..1 luma axis."
  },

  /* =========================================================================
   * v0.3.42 -- Video-edit suite, sprint 5: Mask + Matte + Keyer.
   *
   * Eight composition shader-frag nodes covering two complementary
   * classes:
   *
   *   MASK GENERATORS output a grayscale (R=G=B=A) mask texture
   *   describing where pixels are "in" (1.0) vs "out" (0.0). Wire
   *   into BlendShader.mask, MaskShader, or any downstream node
   *   that consumes a single-channel signal.
   *
   *   KEYERS take an input texture + output the input RGBA with
   *   alpha replaced by a keying decision. Wire to BlendShader for
   *   transparent compositing over a different background.
   *
   * All mask SDFs are aspect-corrected so circles stay circular on
   * widescreen framebuffers. Smoothstep falloffs everywhere -- no
   * hard edges. ======================================================================== */

  /* RectangleMask -- rounded-rect SDF generator. No texture input.
   * Outputs grayscale mask + alpha-channel mirror so it can drive
   * either alpha-aware (BlendShader.mask) or luma-aware downstream
   * nodes. */
  RectangleMask: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "centerX",  t: "param" },
      { n: "centerY",  t: "param" },
      { n: "halfW",    t: "param" },
      { n: "halfH",    t: "param" },
      { n: "rounding", t: "param" },
      { n: "feather",  t: "param" },
      { n: "invert",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      centerX: 0.5, centerY: 0.5,
      halfW: 0.3, halfH: 0.2,
      rounding: 0.0,
      feather: 0.005,
      invert: 0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=centerX, y=centerY, z=halfW, w=halfH
  params2:       vec4f,    // x=rounding, y=feather, z=invert, w=_
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let cx = u.params.x;
  let cy = u.params.y;
  let hw = max(u.params.z, 0.001);
  let hh = max(u.params.w, 0.001);
  let rounding = clamp(u.params2.x, 0.0, min(hw, hh));
  let feather  = max(u.params2.y, 0.0001);
  let invert   = u.params2.z > 0.5;

  // Aspect-correct so the rect stays rect on widescreen + the
  // rounded corners are true circular arcs.
  let aspect = u.u_resolution.x / max(u.u_resolution.y, 1.0);
  let p = (in.uv - vec2f(cx, cy)) * vec2f(aspect, 1.0);
  // Standard SDF for rounded rect (Inigo Quilez).
  let q = abs(p) - (vec2f(hw, hh) - vec2f(rounding));
  let sd = min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - rounding;

  // sd < 0 = inside; > 0 = outside. Smoothstep falloff over feather.
  var mask = 1.0 - smoothstep(0.0, feather, sd);
  if (invert) { mask = 1.0 - mask; }
  return vec4f(vec3f(mask), mask);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.centerX  === "number") ? p.centerX  : 0.5;
      scratch[17] = (typeof p.centerY  === "number") ? p.centerY  : 0.5;
      scratch[18] = (typeof p.halfW    === "number") ? p.halfW    : 0.3;
      scratch[19] = (typeof p.halfH    === "number") ? p.halfH    : 0.2;
      scratch[20] = (typeof p.rounding === "number") ? p.rounding : 0.0;
      scratch[21] = (typeof p.feather  === "number") ? p.feather  : 0.005;
      scratch[22] = (typeof p.invert   === "number") ? p.invert   : 0;
      scratch[23] = 0;
    },
    description: "Rounded-rect mask generator. centerX/Y is the rect center in [0,1] UV; halfW/H is the half-size (so the rect spans [center-half, center+half]). rounding is the corner radius in aspect-corrected normalized units (0 = sharp corners; halfW or halfH = full ellipse). feather is the smoothstep transition width (~0.005 default for hard edges; ~0.05 for very soft). invert flips inside/outside. Output is a grayscale + alpha mirror -- wire into BlendShader.mask for stencil compositing or MaskShader for direct alpha-multiply on a color source."
  },

  /* EllipseMask -- aspect-corrected ellipse / circle SDF generator. */
  EllipseMask: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "centerX", t: "param" },
      { n: "centerY", t: "param" },
      { n: "radiusX", t: "param" },
      { n: "radiusY", t: "param" },
      { n: "feather", t: "param" },
      { n: "invert",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      centerX: 0.5, centerY: 0.5,
      radiusX: 0.25, radiusY: 0.25,
      feather: 0.005,
      invert: 0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=centerX, y=centerY, z=radiusX, w=radiusY
  params2:       vec4f,    // x=feather, y=invert, zw=_
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let cx = u.params.x;
  let cy = u.params.y;
  let rx = max(u.params.z, 0.001);
  let ry = max(u.params.w, 0.001);
  let feather = max(u.params2.x, 0.0001);
  let invert  = u.params2.y > 0.5;

  let aspect = u.u_resolution.x / max(u.u_resolution.y, 1.0);
  let p = (in.uv - vec2f(cx, cy)) * vec2f(aspect, 1.0);
  // Approximate SDF for an ellipse (exact form is iterative).
  // length(p / radii) - 1 gives the implicit boundary; scaling by
  // the smaller radius converts implicit distance back to roughly
  // world-distance for the feather smoothstep.
  let implicit = length(p / vec2f(rx, ry)) - 1.0;
  let sd = implicit * min(rx, ry);

  var mask = 1.0 - smoothstep(0.0, feather, sd);
  if (invert) { mask = 1.0 - mask; }
  return vec4f(vec3f(mask), mask);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.centerX === "number") ? p.centerX : 0.5;
      scratch[17] = (typeof p.centerY === "number") ? p.centerY : 0.5;
      scratch[18] = (typeof p.radiusX === "number") ? p.radiusX : 0.25;
      scratch[19] = (typeof p.radiusY === "number") ? p.radiusY : 0.25;
      scratch[20] = (typeof p.feather === "number") ? p.feather : 0.005;
      scratch[21] = (typeof p.invert  === "number") ? p.invert  : 0;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "Aspect-corrected ellipse / circle mask. centerX/Y is the ellipse center in [0,1] UV; radiusX/Y is the half-axis lengths. Set radiusX = radiusY for a true circle (stays circular on widescreen because of internal aspect correction). feather is the smoothstep transition width. invert flips inside/outside. Output is grayscale + alpha-mirror like RectangleMask -- composable into any downstream mask consumer."
  },

  /* PolygonMask -- regular N-sided polygon SDF. */
  PolygonMask: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    ins: [
      { n: "centerX",  t: "param" },
      { n: "centerY",  t: "param" },
      { n: "radius",   t: "param" },
      { n: "sides",    t: "param" },
      { n: "rotation", t: "param" },
      { n: "feather",  t: "param" },
      { n: "invert",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    params: {
      centerX: 0.5, centerY: 0.5,
      radius: 0.25,
      sides: 6,
      rotation: 0.0,
      feather: 0.005,
      invert: 0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=centerX, y=centerY, z=radius, w=sides
  params2:       vec4f,    // x=rotation (deg), y=feather, z=invert, w=_
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let cx       = u.params.x;
  let cy       = u.params.y;
  let radius   = max(u.params.z, 0.001);
  let sides    = max(floor(u.params.w), 3.0);
  let rotation = u.params2.x * 0.01745329;
  let feather  = max(u.params2.y, 0.0001);
  let invert   = u.params2.z > 0.5;

  let aspect = u.u_resolution.x / max(u.u_resolution.y, 1.0);
  let p = (in.uv - vec2f(cx, cy)) * vec2f(aspect, 1.0);

  // Regular polygon SDF: for each fragment, find which "edge" of the
  // polygon it's closest to (by snapping the polar angle to the
  // nearest edge-bisector), then signed-distance is the projection
  // onto that edge's normal minus the apothem (radius * cos(half
  // angle)).
  let two_pi = 6.28318530;
  let edge_step = two_pi / sides;
  let ang = atan2(p.y, p.x) - rotation;
  let snapped = floor((ang + 0.5 * edge_step) / edge_step) * edge_step + rotation;
  let normal = vec2f(cos(snapped), sin(snapped));
  let apothem = radius * cos(0.5 * edge_step);
  let sd = dot(p, normal) - apothem;

  var mask = 1.0 - smoothstep(0.0, feather, sd);
  if (invert) { mask = 1.0 - mask; }
  return vec4f(vec3f(mask), mask);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.centerX  === "number") ? p.centerX  : 0.5;
      scratch[17] = (typeof p.centerY  === "number") ? p.centerY  : 0.5;
      scratch[18] = (typeof p.radius   === "number") ? p.radius   : 0.25;
      scratch[19] = (typeof p.sides    === "number") ? p.sides    : 6;
      scratch[20] = (typeof p.rotation === "number") ? p.rotation : 0.0;
      scratch[21] = (typeof p.feather  === "number") ? p.feather  : 0.005;
      scratch[22] = (typeof p.invert   === "number") ? p.invert   : 0;
      scratch[23] = 0;
    },
    description: "Regular N-sided polygon mask. centerX/Y is the center in [0,1] UV; radius is the circumscribed-circle radius (distance from center to vertex). sides controls the polygon: 3 = triangle, 4 = square (rotation=45 for diamond), 5 = pentagon, 6 = hexagon, ... up to ~32 for near-circle. rotation in degrees. feather is the smoothstep transition width. invert flips inside/outside. Output is grayscale + alpha mirror. Aspect-corrected so the polygon stays regular on widescreen framebuffers."
  },

  /* RangeMask -- threshold a channel (luma / R / G / B) of the input
   * into a mask. Pixels with the chosen channel value in [low, high]
   * become 1.0; outside the range becomes 0.0; smoothstep softness
   * on both boundaries. */
  RangeMask: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",       t: "texture" },
      { n: "mode",     t: "param" },
      { n: "low",      t: "param" },
      { n: "high",     t: "param" },
      { n: "softness", t: "param" },
      { n: "invert",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    paramOptions: { mode: ["luma", "R", "G", "B"] },
    params: {
      inLayer: 0,
      mode: 0,        // 0=luma, 1=R, 2=G, 3=B
      low: 0.25,
      high: 0.75,
      softness: 0.02,
      invert: 0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=mode, z=low, w=high
  params2:       vec4f,    // x=softness, y=invert, zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer    = u32(max(0.0, u.params.x));
  let mode     = i32(u.params.y + 0.5);
  let lo       = u.params.z;
  let hi       = u.params.w;
  let soft     = max(u.params2.x, 0.0001);
  let invert   = u.params2.y > 0.5;
  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  var v: f32;
  if (mode == 1)      { v = c.r; }
  else if (mode == 2) { v = c.g; }
  else if (mode == 3) { v = c.b; }
  else                { v = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)); }
  // Bandpass: ramp up from lo, ramp down at hi.
  let in_lo = smoothstep(lo - soft, lo + soft, v);
  let in_hi = 1.0 - smoothstep(hi - soft, hi + soft, v);
  var mask = in_lo * in_hi;
  if (invert) { mask = 1.0 - mask; }
  return vec4f(vec3f(mask), mask);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer  === "number") ? p.inLayer  : 0;
      scratch[17] = (typeof p.mode     === "number") ? p.mode     : 0;
      scratch[18] = (typeof p.low      === "number") ? p.low      : 0.25;
      scratch[19] = (typeof p.high     === "number") ? p.high     : 0.75;
      scratch[20] = (typeof p.softness === "number") ? p.softness : 0.02;
      scratch[21] = (typeof p.invert   === "number") ? p.invert   : 0;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "Threshold a channel of the input into a mask. mode picks the channel: 'luma' (Rec.709 weighted RGB), 'R', 'G', 'B'. Pixels with that channel value in [low, high] map to 1.0; outside the range maps to 0.0 with smoothstep softness on both edges. invert flips inside/outside. Output is grayscale + alpha mirror. Use cases: extract shadows (mode=luma, low=0, high=0.3), extract highlights (low=0.7, high=1), extract a specific color band via per-channel mode."
  },

  /* LumaKeyer -- replace alpha with a luma-bandpass keying decision.
   * Output preserves input RGB; alpha follows the keyer math. Wire
   * to BlendShader for transparent compositing over a different bg. */
  LumaKeyer: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",       t: "texture" },
      { n: "low",      t: "param" },
      { n: "high",     t: "param" },
      { n: "softness", t: "param" },
      { n: "invert",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      low: 0.0,
      high: 1.0,
      softness: 0.02,
      invert: 0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=low, z=high, w=softness
  params2:       vec4f,    // x=invert, yzw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer    = u32(max(0.0, u.params.x));
  let lo       = u.params.y;
  let hi       = u.params.z;
  let soft     = max(u.params.w, 0.0001);
  let invert   = u.params2.x > 0.5;
  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  let luma = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let in_lo = smoothstep(lo - soft, lo + soft, luma);
  let in_hi = 1.0 - smoothstep(hi - soft, hi + soft, luma);
  var alpha = in_lo * in_hi;
  if (invert) { alpha = 1.0 - alpha; }
  return vec4f(c.rgb, alpha * c.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer  === "number") ? p.inLayer  : 0;
      scratch[17] = (typeof p.low      === "number") ? p.low      : 0.0;
      scratch[18] = (typeof p.high     === "number") ? p.high     : 1.0;
      scratch[19] = (typeof p.softness === "number") ? p.softness : 0.02;
      scratch[20] = (typeof p.invert   === "number") ? p.invert   : 0;
      scratch[21] = 0; scratch[22] = 0; scratch[23] = 0;
    },
    description: "Luma-bandpass keyer. Output preserves RGB; alpha is the bandpass result: pixels with Rec.709 luma in [low, high] keep alpha=1, outside the range get alpha=0, smoothstep softness on both edges. invert flips (alpha=0 inside the band, 1 outside -- band-stop). Identity at low=0, high=1, invert=0. Wire to BlendShader for keyed compositing over a different bg. Use cases: silhouette extraction (low=0, high=0.4) drops dark pixels; highlight isolation (low=0.7, high=1) keeps only bright."
  },

  /* ChromaKeyer -- green/blue/red-screen keying via HSV color
   * distance. Pixels with hue+saturation close to (targetR/G/B) get
   * alpha=0 (keyed out); pixels far from the key get alpha=1 (kept).
   * Optional spill suppression desaturates near-key residuals. */
  ChromaKeyer: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",              t: "texture" },
      { n: "targetR",         t: "param" },
      { n: "targetG",         t: "param" },
      { n: "targetB",         t: "param" },
      { n: "tolerance",       t: "param" },
      { n: "softness",        t: "param" },
      { n: "spillSuppress",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      targetR: 0.0, targetG: 1.0, targetB: 0.0,   // classic chroma green
      tolerance: 0.15,
      softness: 0.05,
      spillSuppress: 0.5
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=targetR, z=targetG, w=targetB
  params2:       vec4f,    // x=tolerance, y=softness, z=spillSuppress, w=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// RGB -> HSV (Sam Hocevar, lolengine.net 2013). Branch-free.
fn rgb2hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer  = u32(max(0.0, u.params.x));
  let target = vec3f(u.params.y, u.params.z, u.params.w);
  let tol    = max(u.params2.x, 0.0001);
  let soft   = max(u.params2.y, 0.0001);
  let spill  = clamp(u.params2.z, 0.0, 1.0);

  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  let hsv = rgb2hsv(c.rgb);
  let tgt_hsv = rgb2hsv(target);

  // Hue distance: circular, so take the shorter arc.
  let h_raw = abs(hsv.x - tgt_hsv.x);
  let h_dist = min(h_raw, 1.0 - h_raw);
  // Combined chroma distance: hue weighted heavily, saturation
  // weighted less. Value (brightness) ignored -- a dark green
  // shadow should still key as green.
  let dist = h_dist * 2.0 + abs(hsv.y - tgt_hsv.y) * 0.5;
  // keyed=0 means matches target (transparent); keyed=1 means kept.
  let keyed = smoothstep(tol, tol + soft, dist);

  // Spill suppression: desaturate the residual near-target pixels
  // on the EDGE between keyed and kept (where keyed ~= 0.5). Reduces
  // the green tint that bleeds onto foreground hair / edges.
  var rgb = c.rgb;
  if (spill > 0.001) {
    let edge_factor = (1.0 - keyed) * keyed * 4.0;   // peaks at 1 when keyed=0.5
    let amt = clamp(edge_factor * spill, 0.0, 1.0);
    let lum = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
    rgb = mix(rgb, vec3f(lum), amt);
  }
  return vec4f(rgb, keyed * c.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer        === "number") ? p.inLayer        : 0;
      scratch[17] = (typeof p.targetR        === "number") ? p.targetR        : 0.0;
      scratch[18] = (typeof p.targetG        === "number") ? p.targetG        : 1.0;
      scratch[19] = (typeof p.targetB        === "number") ? p.targetB        : 0.0;
      scratch[20] = (typeof p.tolerance      === "number") ? p.tolerance      : 0.15;
      scratch[21] = (typeof p.softness       === "number") ? p.softness       : 0.05;
      scratch[22] = (typeof p.spillSuppress  === "number") ? p.spillSuppress  : 0.5;
      scratch[23] = 0;
    },
    description: "Chroma keyer for green/blue/red-screen compositing. Converts input to HSV, computes distance from the target color (hue weighted 4x heavier than saturation; value ignored so dark-green shadows still key correctly), then alpha = smoothstep(tolerance, tolerance + softness, dist). target* defaults to pure chroma green (0, 1, 0); switch to (0, 0, 1) for blue screen or (1, 0, 0) for red. tolerance ~= 0.15 is a good middle ground; raise for permissive keying, lower for strict. spillSuppress desaturates pixels on the keyed-vs-kept edge band (where green bleeds onto foreground hair / edges); 0 disables, 1 = full edge desaturation."
  },

  /* DifferenceKeyer -- two-input keyer. Compares input against a
   * reference 'clean plate'; pixels close to the reference get
   * alpha=0 (background), pixels different get alpha=1 (foreground).
   * Useful when no chroma screen is available (architectural shots,
   * static-camera live action). */
  DifferenceKeyer: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",        t: "texture" },
      { n: "reference", t: "texture" },
      { n: "threshold", t: "param" },
      { n: "softness",  t: "param" },
      { n: "invert",    t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16, reference: 17 },
    params: {
      inLayer: 0, refLayer: 1,
      threshold: 0.15,
      softness: 0.05,
      invert: 0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=refLayer, z=threshold, w=softness
  params2:       vec4f,    // x=invert, yzw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let inLayer  = u32(max(0.0, u.params.x));
  let refLayer = u32(max(0.0, u.params.y));
  let thresh   = u.params.z;
  let soft     = max(u.params.w, 0.0001);
  let invert   = u.params2.x > 0.5;
  let cIn  = textureSampleLevel(fbHistory, fbSampler, in.uv, inLayer,  0.0);
  let cRef = textureSampleLevel(fbHistory, fbSampler, in.uv, refLayer, 0.0);
  // Euclidean RGB distance. length(x.rgb-y.rgb) ranges 0..sqrt(3)
  // -- normalize threshold parameter so 0..1 covers the useful range.
  let diff = length(cIn.rgb - cRef.rgb);
  var alpha = smoothstep(thresh - soft, thresh + soft, diff);
  if (invert) { alpha = 1.0 - alpha; }
  return vec4f(cIn.rgb, alpha * cIn.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer   === "number") ? p.inLayer   : 0;
      scratch[17] = (typeof p.refLayer  === "number") ? p.refLayer  : 1;
      scratch[18] = (typeof p.threshold === "number") ? p.threshold : 0.15;
      scratch[19] = (typeof p.softness  === "number") ? p.softness  : 0.05;
      scratch[20] = (typeof p.invert    === "number") ? p.invert    : 0;
      scratch[21] = 0; scratch[22] = 0; scratch[23] = 0;
    },
    description: "Two-input difference keyer. Compares 'in' against 'reference' (a clean-plate / empty-scene capture); pixels within `threshold` Euclidean RGB distance of the reference are keyed out (alpha=0, treated as background); pixels different from the reference are kept (alpha=1, treated as foreground). Best when the camera is static + you can grab a frame before the subject enters. invert flips. Use cases: architectural compositing, live-event keying without a chroma screen, motion isolation against a known still."
  },

  /* MatteControl -- alpha matte cleanup. Choke (erode the matte
   * inward), spread (dilate the matte outward), gamma adjustment
   * on the alpha curve, and optional premultiplied-alpha output.
   * Wire AFTER any keyer to clean up the resulting matte. */
  MatteControl: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",          t: "texture" },
      { n: "choke",       t: "param" },
      { n: "spread",      t: "param" },
      { n: "gamma",       t: "param" },
      { n: "premultiply", t: "param" },
      { n: "radius",      t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      choke: 0.0,           // 0..1 -- how much to erode the alpha matte
      spread: 0.0,          // 0..1 -- how much to dilate the alpha matte
      gamma: 1.0,           // alpha curve (1 = linear; <1 softens; >1 sharpens)
      premultiply: 0,       // 0 = straight alpha; 1 = pre-multiplied RGB by alpha
      radius: 1.0           // morph kernel radius in framebuffer pixels
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=choke, z=spread, w=gamma
  params2:       vec4f,    // x=premultiply, y=radius, zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer    = u32(max(0.0, u.params.x));
  let choke    = clamp(u.params.y, 0.0, 1.0);
  let spread   = clamp(u.params.z, 0.0, 1.0);
  let gamma    = max(u.params.w, 0.001);
  let premult  = u.params2.x > 0.5;
  let radius   = max(u.params2.y, 0.0);

  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  var alpha = c.a;

  // Morphological alpha cleanup. 8-tap 3x3 kernel; min for erode
  // (choke), max for dilate (spread). Mix per-fragment so both
  // can apply at controlled amounts.
  if (radius > 0.001 && (choke > 0.001 || spread > 0.001)) {
    let texel = vec2f(1.0) / u.u_resolution.xy;
    var amin = alpha;
    var amax = alpha;
    for (var y: i32 = -1; y <= 1; y = y + 1) {
      for (var x: i32 = -1; x <= 1; x = x + 1) {
        if (x == 0 && y == 0) { continue; }
        let off = vec2f(f32(x), f32(y)) * radius * texel;
        let na = textureSampleLevel(fbHistory, fbSampler, in.uv + off, layer, 0.0).a;
        amin = min(amin, na);
        amax = max(amax, na);
      }
    }
    alpha = mix(alpha, amin, choke);
    alpha = mix(alpha, amax, spread);
  }

  // Gamma curve on alpha. >1 sharpens the matte edge (harder
  // transition); <1 softens.
  alpha = pow(clamp(alpha, 0.0, 1.0), 1.0 / gamma);

  var rgb = c.rgb;
  if (premult) { rgb = rgb * alpha; }
  return vec4f(rgb, alpha);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer     === "number") ? p.inLayer     : 0;
      scratch[17] = (typeof p.choke       === "number") ? p.choke       : 0.0;
      scratch[18] = (typeof p.spread      === "number") ? p.spread      : 0.0;
      scratch[19] = (typeof p.gamma       === "number") ? p.gamma       : 1.0;
      scratch[20] = (typeof p.premultiply === "number") ? p.premultiply : 0;
      scratch[21] = (typeof p.radius      === "number") ? p.radius      : 1.0;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "Alpha matte cleanup. Wire AFTER any keyer (LumaKeyer / ChromaKeyer / DifferenceKeyer) to tighten the resulting matte. choke (0..1) erodes the matte inward -- removes alpha noise / fringes / spill at the keyed boundary. spread (0..1) dilates the matte outward -- fills small holes inside the foreground. radius is the morph kernel sample distance in framebuffer pixels (1 = single-pixel, 3 = chunky). gamma applies a power curve to the cleaned alpha (>1 = sharper edge transition; <1 = softer). premultiply switches between straight alpha (RGB unchanged, alpha separate) and premultiplied alpha (RGB pre-multiplied by alpha) for downstream compositors that expect one or the other."
  },

  /* =========================================================================
   * v0.3.43 -- Video-edit suite, sprint 6: Composite extensions.
   *
   * Six composition shader-frag nodes that fill out the canonical
   * compositing toolbox alongside BlendShader (which covers the
   * general-purpose Merge / blend-modes case). These add:
   *
   *   - Dissolve: single-mix cross-fade (saves a click + makes the
   *     intent explicit when "I just want a fade" is the whole task).
   *   - ChannelCombiner: re-route per-channel data between up to four
   *     texture inputs. Foundation for any "build my own RGBA from
   *     pieces" workflow.
   *   - ChannelBooleans: per-channel arithmetic between two inputs
   *     (add / subtract / multiply / divide / min / max / diff /
   *     screen).
   *   - MatteCombine: set operations on two single-channel masks.
   *   - AlphaCompose: canonical alpha-over with straight /
   *     premultiplied switches on both input and output.
   *   - Premultiply: standalone premultiply / unpremultiply utility.
   *
   * All six use the standard composition bindLayout (texture array
   * at binding 1, sampler at binding 2). Identity defaults where the
   * concept allows: Dissolve mix=0 passes A through; ChannelBooleans
   * op=2 (multiply) with one all-ones input passes the other through;
   * Premultiply mode=0 (premultiply) with alpha=1 passes through. */

  /* Dissolve -- two-input cross-fade by a single mix scalar. The
   * canonical "fade between A and B" node. BlendShader can do this
   * (mode=normal, mix=0..1) but the dedicated entry is faster to
   * find + reads more clearly in a saved patch. */
  Dissolve: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "inA", t: "texture" },
      { n: "inB", t: "texture" },
      { n: "mix", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { inA: 16, inB: 17 },
    params: {
      inALayer: 0, inBLayer: 1,
      mix: 0.0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inALayer, y=inBLayer, z=mix, w=_
  params2:       vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layerA = u32(max(0.0, u.params.x));
  let layerB = u32(max(0.0, u.params.y));
  let mix_t  = clamp(u.params.z, 0.0, 1.0);
  let cA = textureSampleLevel(fbHistory, fbSampler, in.uv, layerA, 0.0);
  let cB = textureSampleLevel(fbHistory, fbSampler, in.uv, layerB, 0.0);
  return mix(cA, cB, mix_t);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inALayer === "number") ? p.inALayer : 0;
      scratch[17] = (typeof p.inBLayer === "number") ? p.inBLayer : 1;
      scratch[18] = (typeof p.mix      === "number") ? p.mix      : 0.0;
      scratch[19] = 0;
      scratch[20] = 0; scratch[21] = 0; scratch[22] = 0; scratch[23] = 0;
    },
    description: "Cross-fade two textures by a single mix scalar. Output = lerp(inA, inB, mix). At mix=0 output = inA (identity for inA); at mix=1 output = inB; intermediate values blend linearly. BlendShader with mode=normal does the same math, but Dissolve is the canonical short-name entry for fade transitions in compositing patches. Per-pixel linear interpolation -- no special handling of alpha (premultiply both inputs upstream if you want correct alpha-aware fades)."
  },

  /* ChannelCombiner -- four texture inputs, per-output-channel source
   * picker + per-output-channel source-channel picker. Lets you build
   * an arbitrary RGBA out of pieces from different textures. */
  ChannelCombiner: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "srcR",   t: "texture" },
      { n: "srcG",   t: "texture" },
      { n: "srcB",   t: "texture" },
      { n: "srcA",   t: "texture" },
      { n: "pickR",  t: "param" },
      { n: "pickG",  t: "param" },
      { n: "pickB",  t: "param" },
      { n: "pickA",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { srcR: 16, srcG: 17, srcB: 18, srcA: 19 },
    paramOptions: {
      pickR: ["R", "G", "B", "A", "luma", "0", "1"],
      pickG: ["R", "G", "B", "A", "luma", "0", "1"],
      pickB: ["R", "G", "B", "A", "luma", "0", "1"],
      pickA: ["R", "G", "B", "A", "luma", "0", "1"]
    },
    params: {
      srcRLayer: 0, srcGLayer: 0, srcBLayer: 0, srcALayer: 0,
      pickR: 0,   // R
      pickG: 1,   // G
      pickB: 2,   // B
      pickA: 3    // A
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=srcRLayer, y=srcGLayer, z=srcBLayer, w=srcALayer
  params2:       vec4f,    // x=pickR, y=pickG, z=pickB, w=pickA
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn pick_channel(c: vec4f, mode: i32) -> f32 {
  if (mode == 0) { return c.r; }
  if (mode == 1) { return c.g; }
  if (mode == 2) { return c.b; }
  if (mode == 3) { return c.a; }
  if (mode == 4) { return dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)); }
  if (mode == 5) { return 0.0; }
  return 1.0;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let lR = u32(max(0.0, u.params.x));
  let lG = u32(max(0.0, u.params.y));
  let lB = u32(max(0.0, u.params.z));
  let lA = u32(max(0.0, u.params.w));
  let pR = i32(u.params2.x + 0.5);
  let pG = i32(u.params2.y + 0.5);
  let pB = i32(u.params2.z + 0.5);
  let pA = i32(u.params2.w + 0.5);
  let cR = textureSampleLevel(fbHistory, fbSampler, in.uv, lR, 0.0);
  let cG = textureSampleLevel(fbHistory, fbSampler, in.uv, lG, 0.0);
  let cB = textureSampleLevel(fbHistory, fbSampler, in.uv, lB, 0.0);
  let cA = textureSampleLevel(fbHistory, fbSampler, in.uv, lA, 0.0);
  return vec4f(
    pick_channel(cR, pR),
    pick_channel(cG, pG),
    pick_channel(cB, pB),
    pick_channel(cA, pA)
  );
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.srcRLayer === "number") ? p.srcRLayer : 0;
      scratch[17] = (typeof p.srcGLayer === "number") ? p.srcGLayer : 0;
      scratch[18] = (typeof p.srcBLayer === "number") ? p.srcBLayer : 0;
      scratch[19] = (typeof p.srcALayer === "number") ? p.srcALayer : 0;
      scratch[20] = (typeof p.pickR === "number") ? p.pickR : 0;
      scratch[21] = (typeof p.pickG === "number") ? p.pickG : 1;
      scratch[22] = (typeof p.pickB === "number") ? p.pickB : 2;
      scratch[23] = (typeof p.pickA === "number") ? p.pickA : 3;
    },
    description: "Recombine R/G/B/A from up to four separate input textures. Each output channel takes its value from a chosen source texture (srcR / srcG / srcB / srcA) and a chosen source channel (pickR / pickG / pickB / pickA = R, G, B, A, luma, 0, or 1). Default state at all-default-wires-into-same-texture passes through unchanged (pickR=R, pickG=G, pickB=B, pickA=A). Use cases: copy alpha from a mask into a color image (wire color into srcR/G/B, mask into srcA, pickA=R or luma); build a thermal/IR fake-color image from a luma source; pack three single-channel masks into RGB; swap channels (BGR/RGB); zero out a channel entirely. All four texture inputs are independent -- wire one or wire four."
  },

  /* ChannelBooleans -- per-channel arithmetic between two inputs.
   * Eight ops: add, subtract, multiply, divide, min, max, difference,
   * screen. Per-channel toggle so RGB can use one op and A another. */
  ChannelBooleans: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "inA",       t: "texture" },
      { n: "inB",       t: "texture" },
      { n: "opRGB",     t: "param" },
      { n: "opA",       t: "param" },
      { n: "amount",    t: "param" },
      { n: "clampOut",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { inA: 16, inB: 17 },
    paramOptions: {
      opRGB: ["add", "subtract", "multiply", "divide", "min", "max", "difference", "screen"],
      opA:   ["add", "subtract", "multiply", "divide", "min", "max", "difference", "screen", "fromA", "fromB"]
    },
    params: {
      inALayer: 0, inBLayer: 1,
      opRGB: 2,        // multiply (identity when inB=1)
      opA: 8,          // fromA -- pass A's alpha through
      amount: 1.0,     // lerp(inA, op(inA,inB), amount); 0 = pass inA, 1 = full op
      clampOut: 1
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inALayer, y=inBLayer, z=opRGB, w=opA
  params2:       vec4f,    // x=amount, y=clampOut, zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn do_op(a: f32, b: f32, mode: i32) -> f32 {
  if (mode == 0) { return a + b; }
  if (mode == 1) { return a - b; }
  if (mode == 2) { return a * b; }
  if (mode == 3) { return a / max(b, 1.0e-5); }
  if (mode == 4) { return min(a, b); }
  if (mode == 5) { return max(a, b); }
  if (mode == 6) { return abs(a - b); }
  if (mode == 7) { return 1.0 - (1.0 - a) * (1.0 - b); }
  if (mode == 8) { return a; }
  return b;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layerA = u32(max(0.0, u.params.x));
  let layerB = u32(max(0.0, u.params.y));
  let opRGB  = i32(u.params.z + 0.5);
  let opA    = i32(u.params.w + 0.5);
  let amt    = clamp(u.params2.x, 0.0, 1.0);
  let do_clamp = u.params2.y > 0.5;
  let cA = textureSampleLevel(fbHistory, fbSampler, in.uv, layerA, 0.0);
  let cB = textureSampleLevel(fbHistory, fbSampler, in.uv, layerB, 0.0);
  let r = do_op(cA.r, cB.r, opRGB);
  let g = do_op(cA.g, cB.g, opRGB);
  let b = do_op(cA.b, cB.b, opRGB);
  let a = do_op(cA.a, cB.a, opA);
  var c_out = vec4f(r, g, b, a);
  c_out = mix(cA, c_out, amt);
  if (do_clamp) { c_out = clamp(c_out, vec4f(0.0), vec4f(1.0)); }
  return c_out;
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inALayer === "number") ? p.inALayer : 0;
      scratch[17] = (typeof p.inBLayer === "number") ? p.inBLayer : 1;
      scratch[18] = (typeof p.opRGB    === "number") ? p.opRGB    : 2;
      scratch[19] = (typeof p.opA      === "number") ? p.opA      : 8;
      scratch[20] = (typeof p.amount   === "number") ? p.amount   : 1.0;
      scratch[21] = (typeof p.clampOut === "number") ? p.clampOut : 1;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "Per-channel arithmetic between two inputs. opRGB applies to the R, G, B channels; opA applies to alpha independently (with bonus 'fromA' and 'fromB' modes that pass an input's alpha straight through). Ops: add (sum), subtract (A-B), multiply (A*B), divide (A/B), min (darker), max (lighter), difference (|A-B|), screen (1 - (1-A)(1-B), inverse-multiply). amount blends back toward inA: 0 = pass inA unchanged; 1 = full op result; intermediate fades. clampOut clamps to [0,1] -- turn off for HDR/extended-range workflow. Use cases: shadow extraction (multiply against a luma mask), difference matte (op=difference), highlight retention (screen + alpha-mask compose)."
  },

  /* MatteCombine -- set operations on two single-channel masks.
   * Treats each input's alpha channel (or red if alpha is unset)
   * as the mask, applies the chosen set operation, outputs a
   * grayscale + alpha-mirror mask. */
  MatteCombine: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "inA",     t: "texture" },
      { n: "inB",     t: "texture" },
      { n: "op",      t: "param" },
      { n: "channel", t: "param" },
      { n: "invert",  t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { inA: 16, inB: 17 },
    paramOptions: {
      op: ["union", "intersect", "subtractAB", "subtractBA", "exclusiveOr", "average"],
      channel: ["alpha", "luma", "R", "G", "B"]
    },
    params: {
      inALayer: 0, inBLayer: 1,
      op: 0,           // union
      channel: 0,      // alpha
      invert: 0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inALayer, y=inBLayer, z=op, w=channel
  params2:       vec4f,    // x=invert, yzw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

fn read_mask(c: vec4f, channel: i32) -> f32 {
  if (channel == 1) { return dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)); }
  if (channel == 2) { return c.r; }
  if (channel == 3) { return c.g; }
  if (channel == 4) { return c.b; }
  return c.a;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layerA  = u32(max(0.0, u.params.x));
  let layerB  = u32(max(0.0, u.params.y));
  let op_kind = i32(u.params.z + 0.5);
  let channel = i32(u.params.w + 0.5);
  let invert  = u.params2.x > 0.5;
  let cA = textureSampleLevel(fbHistory, fbSampler, in.uv, layerA, 0.0);
  let cB = textureSampleLevel(fbHistory, fbSampler, in.uv, layerB, 0.0);
  let a = read_mask(cA, channel);
  let b = read_mask(cB, channel);
  var m: f32;
  if (op_kind == 0)      { m = max(a, b); }                   // union
  else if (op_kind == 1) { m = min(a, b); }                   // intersect
  else if (op_kind == 2) { m = max(a - b, 0.0); }             // subtractAB (A not B)
  else if (op_kind == 3) { m = max(b - a, 0.0); }             // subtractBA (B not A)
  else if (op_kind == 4) { m = a + b - 2.0 * a * b; }         // XOR / exclusion
  else                   { m = 0.5 * (a + b); }               // average
  if (invert) { m = 1.0 - m; }
  m = clamp(m, 0.0, 1.0);
  return vec4f(vec3f(m), m);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inALayer === "number") ? p.inALayer : 0;
      scratch[17] = (typeof p.inBLayer === "number") ? p.inBLayer : 1;
      scratch[18] = (typeof p.op       === "number") ? p.op       : 0;
      scratch[19] = (typeof p.channel  === "number") ? p.channel  : 0;
      scratch[20] = (typeof p.invert   === "number") ? p.invert   : 0;
      scratch[21] = 0; scratch[22] = 0; scratch[23] = 0;
    },
    description: "Combine two single-channel masks via set operations. op picks the operation: union (max -- pixel is masked if either input is); intersect (min -- both inputs must agree); subtractAB (A but not B -- erase B-region from A); subtractBA (B but not A); exclusiveOr (XOR -- masked if exactly one input is, neither when both agree); average (50/50 blend). channel picks which channel of each input is treated as the mask value: alpha, luma (Rec.709), R, G, or B. invert flips the final result. Output is a grayscale + alpha-mirror mask. Use cases: combine two RectangleMask + EllipseMask into a complex region; subtract a hole from a mask; XOR two masks for an outline."
  },

  /* AlphaCompose -- explicit alpha-over composite with separate
   * straight/premultiplied switches for input and output. The
   * canonical "A on top of B" node; complements BlendShader's more
   * general mode-driven blends. */
  AlphaCompose: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "foreground",      t: "texture" },
      { n: "background",      t: "texture" },
      { n: "fgPremultiplied", t: "param" },
      { n: "outPremultiplied", t: "param" },
      { n: "opacity",         t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { foreground: 16, background: 17 },
    params: {
      fgLayer: 0, bgLayer: 1,
      fgPremultiplied: 0,
      outPremultiplied: 0,
      opacity: 1.0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=fgLayer, y=bgLayer, z=fgPremultiplied, w=outPremultiplied
  params2:       vec4f,    // x=opacity, yzw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let fgLayer = u32(max(0.0, u.params.x));
  let bgLayer = u32(max(0.0, u.params.y));
  let fgPre   = u.params.z > 0.5;
  let outPre  = u.params.w > 0.5;
  let opacity = clamp(u.params2.x, 0.0, 1.0);
  let cFg = textureSampleLevel(fbHistory, fbSampler, in.uv, fgLayer, 0.0);
  let cBg = textureSampleLevel(fbHistory, fbSampler, in.uv, bgLayer, 0.0);
  // Convert fg to premultiplied form, then apply opacity by
  // scaling both fg.a and fg.rgb together.
  var fg_rgb_pm = select(cFg.rgb * cFg.a, cFg.rgb, fgPre);
  var fg_a      = cFg.a * opacity;
  fg_rgb_pm     = fg_rgb_pm * opacity;
  // Background -- composite math runs in premultiplied space.
  // Standard alpha-over: out_pm = fg_pm + bg_pm * (1 - fg_a).
  let bg_rgb_pm = cBg.rgb * cBg.a;
  let bg_a      = cBg.a;
  let out_a      = fg_a + bg_a * (1.0 - fg_a);
  let out_rgb_pm = fg_rgb_pm + bg_rgb_pm * (1.0 - fg_a);
  // Convert back to straight alpha unless the user wanted
  // premultiplied output.
  var out_rgb = out_rgb_pm;
  if (!outPre) {
    out_rgb = select(out_rgb_pm / out_a, vec3f(0.0), out_a < 1.0e-5);
  }
  return vec4f(out_rgb, out_a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.fgLayer          === "number") ? p.fgLayer          : 0;
      scratch[17] = (typeof p.bgLayer          === "number") ? p.bgLayer          : 1;
      scratch[18] = (typeof p.fgPremultiplied  === "number") ? p.fgPremultiplied  : 0;
      scratch[19] = (typeof p.outPremultiplied === "number") ? p.outPremultiplied : 0;
      scratch[20] = (typeof p.opacity          === "number") ? p.opacity          : 1.0;
      scratch[21] = 0; scratch[22] = 0; scratch[23] = 0;
    },
    description: "Alpha-over composite -- the canonical 'foreground on top of background' compositing operation. Math is the Porter-Duff over: out_rgb = fg_rgb*fg_a + bg_rgb*bg_a*(1-fg_a); out_a = fg_a + bg_a*(1-fg_a). fgPremultiplied tells the node whether the foreground input already has its RGB scaled by alpha (output from MatteControl with premultiply=1, or from any node that emits premultiplied RGBA) or carries straight alpha (the usual case). outPremultiplied controls the output convention -- match what the downstream node expects. opacity scales the foreground alpha in [0,1] for fade-in / fade-out without re-rendering the input. Use cases: place a chroma-keyed subject over a background plate; layer multiple keyed elements; build a transparent overlay UI on top of a video stream."
  },

  /* Premultiply -- standalone premultiply / unpremultiply utility. */
  Premultiply: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",   t: "texture" },
      { n: "mode", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    paramOptions: { mode: ["premultiply", "unpremultiply"] },
    params: {
      inLayer: 0,
      mode: 0       // premultiply
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=mode, zw=_
  params2:       vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let mode  = i32(u.params.y + 0.5);
  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0);
  if (mode == 1) {
    // Unpremultiply -- divide RGB by alpha. Guard against zero.
    let rgb = select(c.rgb / c.a, vec3f(0.0), c.a < 1.0e-5);
    return vec4f(rgb, c.a);
  }
  // Premultiply -- scale RGB by alpha.
  return vec4f(c.rgb * c.a, c.a);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.mode    === "number") ? p.mode    : 0;
      scratch[18] = 0; scratch[19] = 0;
      scratch[20] = 0; scratch[21] = 0; scratch[22] = 0; scratch[23] = 0;
    },
    description: "Switch RGBA between straight-alpha and premultiplied-alpha conventions. mode=premultiply scales RGB by alpha (canonical convention for correct alpha-over math + linear filtering); mode=unpremultiply divides RGB by alpha (recover the original color values from a premultiplied source). Use when a downstream node expects one convention but the input is the other. Zero-alpha pixels are clamped to (0,0,0) in unpremultiply mode rather than blowing up to infinity."
  },

  /* =========================================================================
   * v0.3.24 — Video-edit suite, sprint 1: Transform.
   *
   * Four composition shader-frag nodes covering the basic 2D transform
   * category. All use bindLayout: "composition" + textureInputSlots
   * pattern -- standard 1-texture-in / 1-texture-out shape, the `in`
   * port's framebuffer layer auto-resolves into params.x (inLayer)
   * at render time (see _resolveTextureInputLayer).
   *
   * Identity-default convention: every param's default value yields
   * pass-through behavior when first dropped. Lets a user mid-chain
   * insert a Transform without breaking the existing look until they
   * touch a slider. Documented in ROADMAP §5.2 design conventions.
   * ======================================================================== */

  /* Transform — translate / rotate / scale around an anchor, with
   * four edge modes for out-of-bounds samples. */
  Transform: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",         t: "texture" },
      { n: "rotateDeg",  t: "param" },
      { n: "scaleX",     t: "param" },
      { n: "scaleY",     t: "param" },
      { n: "anchorX",    t: "param" },
      { n: "anchorY",    t: "param" },
      { n: "translateX", t: "param" },
      { n: "translateY", t: "param" },
      { n: "edgeMode",   t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    paramOptions: { edgeMode: ["clamp", "wrap", "black", "mirror"] },
    params: {
      inLayer: 0,
      rotateDeg: 0,
      scaleX: 1.0, scaleY: 1.0,
      anchorX: 0.5, anchorY: 0.5,
      translateX: 0.0, translateY: 0.0,
      edgeMode: 0
    },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=rotateDeg, z=scaleX, w=scaleY
  params2:       vec4f,    // x=anchorX, y=anchorY, z=translateX, w=translateY
  params3:       vec4f,    // x=edgeMode, yzw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// Mirror-repeat for one axis: maps any real value into [0, 1] with a
// triangle wave (period 2, reflects at integer boundaries).
fn mirror_uv(uv: vec2f) -> vec2f {
  let m = uv - 2.0 * floor(uv * 0.5);   // mod 2 -> [0, 2)
  return select(m, 2.0 - m, m > vec2f(1.0));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer       = u32(max(0.0, u.params.x));
  let rot_rad     = -u.params.y * 0.01745329;       // negate: inverse-map output -> input
  let scale       = vec2f(max(u.params.z, 0.0001), max(u.params.w, 0.0001));
  let anchor      = vec2f(u.params2.x, u.params2.y);
  let translate   = vec2f(u.params2.z, u.params2.w);
  let edge        = i32(u.params3.x + 0.5);

  // Inverse-map: shift to anchor, undo translate, rotate by -theta,
  // undo scale, shift back. Output uv -> source uv.
  var p = in.uv - anchor;
  p = p - translate;
  let cr = cos(rot_rad); let sr = sin(rot_rad);
  let pr = vec2f(cr * p.x - sr * p.y, sr * p.x + cr * p.y);
  let ps = pr / scale;
  var sample_uv = ps + anchor;

  // Edge handling. edge=0 clamp, 1 wrap, 2 black, 3 mirror.
  let outside = sample_uv.x < 0.0 || sample_uv.x > 1.0 ||
                sample_uv.y < 0.0 || sample_uv.y > 1.0;
  if (outside) {
    if (edge == 1) {
      sample_uv = sample_uv - floor(sample_uv);
    } else if (edge == 2) {
      return vec4f(0.0, 0.0, 0.0, 0.0);
    } else if (edge == 3) {
      sample_uv = mirror_uv(sample_uv);
    } else {
      sample_uv = clamp(sample_uv, vec2f(0.0), vec2f(1.0));
    }
  }
  return textureSampleLevel(fbHistory, fbSampler, sample_uv, layer, 0.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer    === "number") ? p.inLayer    : 0;
      scratch[17] = (typeof p.rotateDeg  === "number") ? p.rotateDeg  : 0;
      scratch[18] = (typeof p.scaleX     === "number") ? p.scaleX     : 1.0;
      scratch[19] = (typeof p.scaleY     === "number") ? p.scaleY     : 1.0;
      scratch[20] = (typeof p.anchorX    === "number") ? p.anchorX    : 0.5;
      scratch[21] = (typeof p.anchorY    === "number") ? p.anchorY    : 0.5;
      scratch[22] = (typeof p.translateX === "number") ? p.translateX : 0.0;
      scratch[23] = (typeof p.translateY === "number") ? p.translateY : 0.0;
      scratch[24] = (typeof p.edgeMode   === "number") ? p.edgeMode   : 0;
      scratch[25] = 0; scratch[26] = 0; scratch[27] = 0;
    },
    description: "Translate, rotate, and scale the input around an anchor point. translateX/Y are in normalized [0, 1] framebuffer units (0.1 shifts 10% of frame width); rotateDeg is degrees CCW; scaleX/Y scale around anchor (1.0 = identity); anchorX/Y is the pivot in [0, 1] (default 0.5, 0.5 = center). edgeMode picks out-of-bounds behavior: clamp (edge pixels stretch), wrap (tile), black (transparent), mirror (reflect). All-default state is pass-through."
  },

  /* Crop — rect bounds in normalized UV. Outside the rect emits the
   * configured bg color (transparent by default so a downstream
   * BlendShader / Merge handles the composite cleanly). Softness
   * feathers the rect edges over a normalized falloff distance. */
  Crop: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",       t: "texture" },
      { n: "cropX",    t: "param" },
      { n: "cropY",    t: "param" },
      { n: "cropW",    t: "param" },
      { n: "cropH",    t: "param" },
      { n: "softness", t: "param" },
      { n: "bgR",      t: "param" },
      { n: "bgG",      t: "param" },
      { n: "bgB",      t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      cropX: 0.0, cropY: 0.0,
      cropW: 1.0, cropH: 1.0,
      softness: 0.0,
      bgR: 0.0, bgG: 0.0, bgB: 0.0
    },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=cropX, z=cropY, w=cropW
  params2:       vec4f,    // x=cropH, y=softness, zw=_
  params3:       vec4f,    // x=bgR, y=bgG, z=bgB, w=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer    = u32(max(0.0, u.params.x));
  let cx       = u.params.y;
  let cy       = u.params.z;
  let cw       = u.params.w;
  let ch       = u.params2.x;
  let softness = max(u.params2.y, 0.0001);   // tiny floor so smoothstep stays well-defined when soft=0

  let uv = in.uv;
  // Distance from each edge (normalized to softness). Inside = positive.
  let dx_left  = (uv.x - cx) / softness;
  let dx_right = (cx + cw - uv.x) / softness;
  let dy_top   = (uv.y - cy) / softness;
  let dy_bot   = (cy + ch - uv.y) / softness;
  // smoothstep falls to 0 at the edge; product gives a single mask
  // value that's 1 inside, 0 outside, smooth at the boundary.
  let fx = smoothstep(0.0, 1.0, min(dx_left, dx_right));
  let fy = smoothstep(0.0, 1.0, min(dy_top, dy_bot));
  let mask = clamp(fx * fy, 0.0, 1.0);

  let c  = textureSampleLevel(fbHistory, fbSampler, uv, layer, 0.0);
  // Bg alpha follows the mask inverse so the cropped region punches
  // through to alpha=0 (transparent) -- BlendShader composite friendly.
  let bg = vec4f(u.params3.x, u.params3.y, u.params3.z, 0.0);
  return mix(bg, c, mask);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer  === "number") ? p.inLayer  : 0;
      scratch[17] = (typeof p.cropX    === "number") ? p.cropX    : 0.0;
      scratch[18] = (typeof p.cropY    === "number") ? p.cropY    : 0.0;
      scratch[19] = (typeof p.cropW    === "number") ? p.cropW    : 1.0;
      scratch[20] = (typeof p.cropH    === "number") ? p.cropH    : 1.0;
      scratch[21] = (typeof p.softness === "number") ? p.softness : 0.0;
      scratch[22] = 0; scratch[23] = 0;
      scratch[24] = (typeof p.bgR      === "number") ? p.bgR      : 0.0;
      scratch[25] = (typeof p.bgG      === "number") ? p.bgG      : 0.0;
      scratch[26] = (typeof p.bgB      === "number") ? p.bgB      : 0.0;
      scratch[27] = 0;
    },
    description: "Rect crop in normalized [0, 1] UV. Inside the rect samples the input; outside emits the configured bg color with alpha=0 (transparent so a downstream BlendShader composites cleanly). cropX/Y is the top-left corner; cropW/H is the rect size. softness feathers the rect edges over a normalized falloff distance (0 = hard edges; 0.05 ~= ~5% of frame width feather). Default rect 0,0,1,1 is pass-through."
  },

  /* Letterbox — fit input to a target aspect ratio inside the framebuffer.
   * Pillarbox (vertical bars) when target_aspect < framebuffer_aspect;
   * letterbox (horizontal bars) when >. Bars take a user color. The input
   * gets stretched into the target rect at full UV [0, 1]. */
  Letterbox: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",      t: "texture" },
      { n: "aspectW", t: "param" },
      { n: "aspectH", t: "param" },
      { n: "barR",    t: "param" },
      { n: "barG",    t: "param" },
      { n: "barB",    t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      aspectW: 16, aspectH: 9,
      barR: 0.0, barG: 0.0, barB: 0.0
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=aspectW, z=aspectH, w=_
  bar:           vec4f,    // x=R, y=G, z=B, w=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer    = u32(max(0.0, u.params.x));
  let aw       = max(u.params.y, 0.001);
  let ah       = max(u.params.z, 0.001);
  let target_ar = aw / ah;
  let fb_ar    = u.u_resolution.x / max(u.u_resolution.y, 0.001);

  // Centered rect with target aspect, contained inside the framebuffer.
  var rect_w = 1.0;
  var rect_h = 1.0;
  if (fb_ar > target_ar) {
    // Framebuffer is wider than target -- pillarbox.
    rect_w = target_ar / fb_ar;
  } else {
    // Framebuffer is taller -- letterbox.
    rect_h = fb_ar / target_ar;
  }
  let rect_x = (1.0 - rect_w) * 0.5;
  let rect_y = (1.0 - rect_h) * 0.5;

  let uv = in.uv;
  if (uv.x < rect_x || uv.x > rect_x + rect_w ||
      uv.y < rect_y || uv.y > rect_y + rect_h) {
    return vec4f(u.bar.x, u.bar.y, u.bar.z, 1.0);
  }
  // Inside: remap uv to full [0, 1] across the rect and sample.
  let in_uv = vec2f((uv.x - rect_x) / rect_w, (uv.y - rect_y) / rect_h);
  return textureSampleLevel(fbHistory, fbSampler, in_uv, layer, 0.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.aspectW === "number") ? p.aspectW : 16;
      scratch[18] = (typeof p.aspectH === "number") ? p.aspectH : 9;
      scratch[19] = 0;
      scratch[20] = (typeof p.barR    === "number") ? p.barR    : 0.0;
      scratch[21] = (typeof p.barG    === "number") ? p.barG    : 0.0;
      scratch[22] = (typeof p.barB    === "number") ? p.barB    : 0.0;
      scratch[23] = 0;
    },
    description: "Contain-fit the input into a target aspect ratio inside the framebuffer. When framebuffer is wider than target → pillarbox (vertical bars left+right); when taller → letterbox (horizontal bars top+bottom). aspectW/H express the target ratio (16, 9 = widescreen; 4, 3 = retro 4:3; 1, 1 = square). The input is stretched into the target rect at full UV [0, 1]. barR/G/B picks the bar color (default black)."
  },

  /* Resize — filter-mode picker for the sample step. Mostly useful as
   * a "preserve pixel art through downstream linear-filter chains"
   * helper: insert Resize(mode=nearest) after a Pixelate / low-res
   * shader, then Blur / ColorCorrect downstream won't smear the
   * chunky pixels into smooth gradients. Doesn't change resolution
   * (the framebuffer array is fixed-size) -- just affects sampler
   * behavior at this point in the chain. */
  Resize: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",   t: "texture" },
      { n: "mode", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    paramOptions: { mode: ["linear", "nearest"] },
    params: { inLayer: 0, mode: 0 },
    methods: {},
    uniformBytes: 80,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=mode (0=linear, 1=nearest), zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let mode  = u32(u.params.y + 0.5);
  var uv    = in.uv;
  if (mode == 1u) {
    // Nearest-neighbor: snap to texel center. The fbSampler is set
    // up linear, but snapping the UV gives the same result as a
    // nearest filter (the sampled point lands exactly on a texel
    // center so linear interpolation degenerates to picking that
    // texel's value).
    let texel = vec2f(1.0) / max(u.u_resolution.xy, vec2f(1.0));
    uv = (floor(uv / texel) + vec2f(0.5)) * texel;
  }
  return textureSampleLevel(fbHistory, fbSampler, uv, layer, 0.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.mode    === "number") ? p.mode    : 0;
      scratch[18] = 0; scratch[19] = 0;
    },
    description: "Filter-mode picker for the sample step. Doesn't resample — the framebuffer array is fixed-resolution — but lets the chain swap between linear (default smooth filtering) and nearest (snap-to-texel, preserves pixel art through downstream linear-filter chains). Useful as a chain stabilizer: Pixelate → Resize(nearest) → Blur keeps the chunky pixels readable after blur, vs Pixelate → Blur which smears the pixel grid into mush."
  },

  /* =========================================================================
   * v0.3.26 — Video-edit suite, sprint 2: Color (6 of 8 nodes).
   *
   * Per-pixel color math. Same composition shader-frag shape as the
   * Transform suite -- 1 texture in, 1 out, identity-default state
   * is pass-through. ColorCurves + HueCurves are deferred to a
   * follow-up sub-sprint because they need a curve-editor UI in the
   * props pane (16-point LUT with draggable control points).
   *
   * Coverage rationale: we already have ColorCorrect (kitchen-sink:
   * brightness + contrast + saturation + hueShift + gamma in one
   * node). The new individual nodes are for users who want fewer
   * knobs per node with finer slider granularity per param, or who
   * want to wire MasterClock / Slider to ONE specific param without
   * the rest tagging along.
   * ======================================================================== */

  /* BrightnessContrast — additive brightness, multiplicative contrast
   * around 0.5, output gamma. Identity defaults: 0 / 1 / 1. */
  BrightnessContrast: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",         t: "texture" },
      { n: "brightness", t: "param" },
      { n: "contrast",   t: "param" },
      { n: "gamma",      t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, brightness: 0.0, contrast: 1.0, gamma: 1.0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=brightness, z=contrast, w=gamma
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  var c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  // Contrast around 0.5 (the perceptual midpoint), then brightness offset.
  c = (c - vec3f(0.5)) * u.params.z + vec3f(0.5) + vec3f(u.params.y);
  // Gamma (clamp denominator + clamp post-pow to keep negatives + inf out).
  let g = max(u.params.w, 0.001);
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / g));
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer    === "number") ? p.inLayer    : 0;
      scratch[17] = (typeof p.brightness === "number") ? p.brightness : 0.0;
      scratch[18] = (typeof p.contrast   === "number") ? p.contrast   : 1.0;
      scratch[19] = (typeof p.gamma      === "number") ? p.gamma      : 1.0;
    },
    description: "Brightness + contrast + gamma in one focused node. brightness: additive offset (-1..+1, 0 = neutral). contrast: multiplier around 0.5 (1 = neutral, 2 = double, 0.5 = half). gamma: output gamma (1 = linear, <1 darkens midtones, >1 brightens). All-default state is pass-through. Use this instead of ColorCorrect when you want one knob per node + want to wire MasterClock / Slider to ONE specific param without the rest tagging along."
  },

  /* Levels — classic photo-grading levels tool. Per-master input
   * black/white/gamma + output black/white remap. */
  Levels: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",       t: "texture" },
      { n: "inBlack",  t: "param" },
      { n: "inWhite",  t: "param" },
      { n: "gamma",    t: "param" },
      { n: "outBlack", t: "param" },
      { n: "outWhite", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, inBlack: 0.0, inWhite: 1.0, gamma: 1.0, outBlack: 0.0, outWhite: 1.0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=inBlack, z=inWhite, w=gamma
  params2:       vec4f,    // x=outBlack, y=outWhite, zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let inBlk = u.params.y;
  let inWht = u.params.z;
  let gamma = max(u.params.w, 0.001);
  let outBlk = u.params2.x;
  let outWht = u.params2.y;
  var c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  // Remap input range to [0, 1]. Guard divide-by-zero when user
  // drags inBlack >= inWhite (degenerate -- produces a hard threshold).
  let span = max(inWht - inBlk, 0.0001);
  c = clamp((c - vec3f(inBlk)) / span, vec3f(0.0), vec3f(1.0));
  // Apply gamma to the normalized signal.
  c = pow(c, vec3f(1.0 / gamma));
  // Remap to output range.
  c = c * (outWht - outBlk) + vec3f(outBlk);
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer  === "number") ? p.inLayer  : 0;
      scratch[17] = (typeof p.inBlack  === "number") ? p.inBlack  : 0.0;
      scratch[18] = (typeof p.inWhite  === "number") ? p.inWhite  : 1.0;
      scratch[19] = (typeof p.gamma    === "number") ? p.gamma    : 1.0;
      scratch[20] = (typeof p.outBlack === "number") ? p.outBlack : 0.0;
      scratch[21] = (typeof p.outWhite === "number") ? p.outWhite : 1.0;
      scratch[22] = 0; scratch[23] = 0;
    },
    description: "Photo-grading levels: remap input range [inBlack, inWhite] through a gamma curve onto output range [outBlack, outWhite]. Identity default = 0, 1, 1, 0, 1 (pass-through). inBlack > 0 clips shadows; inWhite < 1 clips highlights; gamma <1 darkens midtones, >1 brightens. outBlack > 0 floors blacks (washed-out look), outWhite < 1 caps highlights."
  },

  /* HsvShift — global hue rotate + saturation + value scale.
   * Lighter-weight than ColorCorrect when you only want HSV. */
  HsvShift: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",       t: "texture" },
      { n: "hueShift", t: "param" },
      { n: "sat",      t: "param" },
      { n: "val",      t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, hueShift: 0.0, sat: 1.0, val: 1.0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=hueShiftDeg, z=sat, w=val
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// RGB <-> HSV from Sam Hocevar's reference (lolengine.net 2013).
// Branch-free, decent speed, good for in-shader use.
fn rgb2hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer    = u32(max(0.0, u.params.x));
  let hueShift = u.params.y / 360.0;   // degrees -> fraction of full hue circle
  let sat_g    = max(u.params.z, 0.0);
  let val_g    = max(u.params.w, 0.0);
  var c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  var hsv = rgb2hsv(c);
  hsv.x = fract(hsv.x + hueShift);
  hsv.y = clamp(hsv.y * sat_g, 0.0, 1.0);
  hsv.z = hsv.z * val_g;
  c = hsv2rgb(hsv);
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer  === "number") ? p.inLayer  : 0;
      scratch[17] = (typeof p.hueShift === "number") ? p.hueShift : 0.0;
      scratch[18] = (typeof p.sat      === "number") ? p.sat      : 1.0;
      scratch[19] = (typeof p.val      === "number") ? p.val      : 1.0;
    },
    description: "HSV space color shift. hueShift in degrees (±180 wraps full circle). sat: 0 = grayscale, 1 = neutral, >1 boosts. val: 0 = black, 1 = neutral, >1 brightens (clipped at 1). All-default state is pass-through. Useful when you want clock-driven hue rotation without dragging contrast / gamma along for the ride."
  },

  /* Invert — RGB invert with a mix knob (0 = pass-through, 1 = full
   * invert). Default mix is 0 to honor the identity-default rule. */
  Invert: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",  t: "texture" },
      { n: "mix", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: { inLayer: 0, mix: 1.0 },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=mix (0=pass-through, 1=full invert), zw=_
  _pad1:         vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let m     = clamp(u.params.y, 0.0, 1.0);
  let c     = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  let inv   = vec3f(1.0) - c;
  return vec4f(mix(c, inv, m), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.mix     === "number") ? p.mix     : 1.0;
      scratch[18] = 0; scratch[19] = 0;
    },
    description: "RGB invert. mix scalars between original (0) and full invert (1, the photographic negative). Default mix = 1.0 so a freshly-dropped Invert node actually inverts; flip to 0 for pass-through. Wire MasterClock to mix for rhythmic invert flashes; wire EnvFollow for amplitude-reactive negation."
  },

  /* ChannelMix — 3x3 RGB matrix. Identity defaults to the I matrix
   * (diagonal = 1, off-diagonal = 0). Use for channel swaps,
   * black-and-white film conversion (custom luminance weights),
   * desaturation, sepia, color-space approximations. */
  ChannelMix: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in",  t: "texture" },
      { n: "rr", t: "param" }, { n: "rg", t: "param" }, { n: "rb", t: "param" },
      { n: "gr", t: "param" }, { n: "gg", t: "param" }, { n: "gb", t: "param" },
      { n: "br", t: "param" }, { n: "bg", t: "param" }, { n: "bb", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      rr: 1.0, rg: 0.0, rb: 0.0,
      gr: 0.0, gg: 1.0, gb: 0.0,
      br: 0.0, bg: 0.0, bb: 1.0
    },
    methods: {},
    uniformBytes: 112,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, y=rr, z=rg, w=rb
  params2:       vec4f,    // x=gr, y=gg, z=gb, w=br
  params3:       vec4f,    // x=bg, y=bb, zw=_
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  // Each output channel = dot product of input RGB with that row.
  let m_r = vec3f(u.params.y,  u.params.z,  u.params.w);   // rr, rg, rb
  let m_g = vec3f(u.params2.x, u.params2.y, u.params2.z);  // gr, gg, gb
  let m_b = vec3f(u.params2.w, u.params3.x, u.params3.y);  // br, bg, bb
  let out_c = vec3f(dot(c, m_r), dot(c, m_g), dot(c, m_b));
  return vec4f(clamp(out_c, vec3f(0.0), vec3f(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = (typeof p.rr      === "number") ? p.rr      : 1.0;
      scratch[18] = (typeof p.rg      === "number") ? p.rg      : 0.0;
      scratch[19] = (typeof p.rb      === "number") ? p.rb      : 0.0;
      scratch[20] = (typeof p.gr      === "number") ? p.gr      : 0.0;
      scratch[21] = (typeof p.gg      === "number") ? p.gg      : 1.0;
      scratch[22] = (typeof p.gb      === "number") ? p.gb      : 0.0;
      scratch[23] = (typeof p.br      === "number") ? p.br      : 0.0;
      scratch[24] = (typeof p.bg      === "number") ? p.bg      : 0.0;
      scratch[25] = (typeof p.bb      === "number") ? p.bb      : 1.0;
      scratch[26] = 0; scratch[27] = 0;
    },
    description: "3x3 RGB channel mixer. Each output channel is a weighted sum of input RGB: out.r = rr*in.r + rg*in.g + rb*in.b, same for G and B. Identity default = I matrix (pass-through). Recipes: black-and-white via (rr=gg=bb=0.2126, _g=_g=0.7152, _b=0.0722) on all rows gives Rec.709 luma in all channels. Sepia ~= (0.393, 0.769, 0.189 / 0.349, 0.686, 0.168 / 0.272, 0.534, 0.131). RB channel swap = swap rr/rb and br/bb rows."
  },

  /* ChannelCombiner — pick output channels from any of 4 separate
   * texture inputs, each input's specific channel. Use cases: blend
   * pre-keyed alpha from one source with color from another; assemble
   * a final image from individual channel masks. */
  ChannelCombiner: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "srcR",  t: "texture" },
      { n: "srcG",  t: "texture" },
      { n: "srcB",  t: "texture" },
      { n: "srcA",  t: "texture" },
      { n: "pickR", t: "param" },
      { n: "pickG", t: "param" },
      { n: "pickB", t: "param" },
      { n: "pickA", t: "param" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { srcR: 16, srcG: 17, srcB: 18, srcA: 19 },
    paramOptions: {
      pickR: ["R", "G", "B", "A", "Luma"],
      pickG: ["R", "G", "B", "A", "Luma"],
      pickB: ["R", "G", "B", "A", "Luma"],
      pickA: ["R", "G", "B", "A", "Luma"]
    },
    params: {
      layerR: 0, layerG: 0, layerB: 0, layerA: 0,
      pickR: 0, pickG: 1, pickB: 2, pickA: 3
    },
    methods: {},
    uniformBytes: 96,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=layerR, y=layerG, z=layerB, w=layerA
  params2:       vec4f,    // x=pickR, y=pickG, z=pickB, w=pickA
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// Pick one channel by index: 0=R, 1=G, 2=B, 3=A, 4=Luma.
fn pick_chan(s: vec4f, idx: i32) -> f32 {
  if (idx == 1) { return s.g; }
  if (idx == 2) { return s.b; }
  if (idx == 3) { return s.a; }
  if (idx == 4) { return dot(s.rgb, vec3f(0.2126, 0.7152, 0.0722)); }
  return s.r;   // default + idx == 0
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let lR = u32(max(0.0, u.params.x));
  let lG = u32(max(0.0, u.params.y));
  let lB = u32(max(0.0, u.params.z));
  let lA = u32(max(0.0, u.params.w));
  let pR = i32(u.params2.x + 0.5);
  let pG = i32(u.params2.y + 0.5);
  let pB = i32(u.params2.z + 0.5);
  let pA = i32(u.params2.w + 0.5);
  let sR = textureSampleLevel(fbHistory, fbSampler, in.uv, lR, 0.0);
  let sG = textureSampleLevel(fbHistory, fbSampler, in.uv, lG, 0.0);
  let sB = textureSampleLevel(fbHistory, fbSampler, in.uv, lB, 0.0);
  let sA = textureSampleLevel(fbHistory, fbSampler, in.uv, lA, 0.0);
  return vec4f(
    pick_chan(sR, pR),
    pick_chan(sG, pG),
    pick_chan(sB, pB),
    pick_chan(sA, pA)
  );
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.layerR === "number") ? p.layerR : 0;
      scratch[17] = (typeof p.layerG === "number") ? p.layerG : 0;
      scratch[18] = (typeof p.layerB === "number") ? p.layerB : 0;
      scratch[19] = (typeof p.layerA === "number") ? p.layerA : 0;
      scratch[20] = (typeof p.pickR  === "number") ? p.pickR  : 0;
      scratch[21] = (typeof p.pickG  === "number") ? p.pickG  : 1;
      scratch[22] = (typeof p.pickB  === "number") ? p.pickB  : 2;
      scratch[23] = (typeof p.pickA  === "number") ? p.pickA  : 3;
    },
    description: "Recombine RGBA from up to 4 different texture sources. Each output channel (R / G / B / A) picks both a SOURCE (wire srcR / srcG / srcB / srcA) and a CHANNEL of that source (pickR / pickG / pickB / pickA — picks R, G, B, A, or Luma of the corresponding source). With all four srcs wired to the same upstream and picks at default RGBA, output = input (identity). Use cases: pull alpha from a key node while keeping color from the unkeyed source; assemble an image from per-channel masks; swap channels (wire same src to all 4, set pickR=B and pickB=R for an R↔B swap). Unwired sources fall back to layer 0."
  },

  /* v0.3.29 — ColorCurves. Per-channel paint-drawable curve LUT.
   *
   * Four 64-point curves (Master applied first to all channels, then
   * R / G / B individually). 64 entries gives smooth photo-quality
   * grades -- bumped from 16 in v0.3.28 after the curves felt too
   * coarse for serious work. Each curve sampled per-pixel with
   * linear interp between adjacent points; identity default is a
   * linear ramp (point[i] = i/63) so all-default state is pass-
   * through.
   *
   * UI: dedicated modal opened from the props pane. PAINT-DRAWABLE
   * -- click+drag along the curve to redraw it directly (no per-
   * point handles to chase down). Points between consecutive
   * pointer events are linearly interpolated so fast drags don't
   * leave gaps. "Smooth" button applies a 3-tap moving average for
   * cleanup. 4 channel tabs (Master / R / G / B) pick which curve
   * is being painted; the other three render as faint overlays so
   * the full grade reads in context.
   *
   * Uniform layout: preamble (64 B) + params (16 B) + 4 curves
   * (4 * array<vec4f, 16> = 4 * 256 B = 1024 B) = 1104 B total.
   * WGSL accesses points via dynamic uniform indexing
   * (u.curveM[block][component]) which avoids a 64-entry inline
   * unpack -- crucial when each fragment does 6 LUT samples
   * (master applied to each channel, then per-channel curve). */
  ColorCurves: {
    category: "Visual", color: COLOR.visual, header: null,
    cppType: "",
    kind: "shader-frag",
    bindLayout: "composition",
    ins: [
      { n: "in", t: "texture" }
    ],
    outs: [{ n: "out", t: "texture" }],
    textureInputSlots: { in: 16 },
    params: {
      inLayer: 0,
      // 64-point identity ramps. Modal's Reset button restores these
      // exact values. IIFEs keep the registry literal readable.
      curveMaster: (function(){ const a = new Array(64); for (let i = 0; i < 64; i++) a[i] = i / 63; return a; })(),
      curveR:      (function(){ const a = new Array(64); for (let i = 0; i < 64; i++) a[i] = i / 63; return a; })(),
      curveG:      (function(){ const a = new Array(64); for (let i = 0; i < 64; i++) a[i] = i / 63; return a; })(),
      curveB:      (function(){ const a = new Array(64); for (let i = 0; i < 64; i++) a[i] = i / 63; return a; })()
    },
    methods: {},
    uiOnlyParams: ["curveMaster", "curveR", "curveG", "curveB"],
    uniformBytes: 1104,
    wgsl:
`struct U {
  u_resolution:  vec4f,
  u_time:        f32,
  u_dt:          f32,
  u_layer:       f32,
  u_fov_v_deg:   f32,
  u_view:        vec4f,
  u_world_uv:    vec4f,
  params:        vec4f,    // x=inLayer, yzw=_
  curveM:        array<vec4f, 16>,
  curveR:        array<vec4f, 16>,
  curveG:        array<vec4f, 16>,
  curveB:        array<vec4f, 16>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fbHistory: texture_2d_array<f32>;
@group(0) @binding(2) var fbSampler: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let pos = p[vi];
  var out: VsOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv  = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

// Sample one of the four curves. curve_id picks which (0=M, 1=R,
// 2=G, 3=B); t in [0, 1] is the input value. WGSL allows dynamic
// indexing on uniform arrays + vec components, so we look up
// directly without copying a function-scope array first. Two
// (block, component) decompositions of i0 and i1 -- u.curveX[i/4]
// is a vec4f, [i%4] picks one of its four entries.
fn sample_curve(t: f32, curve_id: u32) -> f32 {
  let xf   = clamp(t, 0.0, 1.0) * 63.0;
  let i0   = i32(floor(xf));
  let frac = xf - f32(i0);
  let i1   = min(i0 + 1, 63);
  let b0 = i0 / 4; let c0 = i0 % 4;
  let b1 = i1 / 4; let c1 = i1 % 4;
  var v0: f32 = 0.0;
  var v1: f32 = 0.0;
  if (curve_id == 0u) {
    v0 = u.curveM[b0][c0];  v1 = u.curveM[b1][c1];
  } else if (curve_id == 1u) {
    v0 = u.curveR[b0][c0];  v1 = u.curveR[b1][c1];
  } else if (curve_id == 2u) {
    v0 = u.curveG[b0][c0];  v1 = u.curveG[b1][c1];
  } else {
    v0 = u.curveB[b0][c0];  v1 = u.curveB[b1][c1];
  }
  return mix(v0, v1, frac);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let layer = u32(max(0.0, u.params.x));
  let c = textureSampleLevel(fbHistory, fbSampler, in.uv, layer, 0.0).rgb;
  // Master first -- applied identically to all three channels.
  let mR = sample_curve(c.r, 0u);
  let mG = sample_curve(c.g, 0u);
  let mB = sample_curve(c.b, 0u);
  // Then per-channel curves.
  let oR = sample_curve(mR, 1u);
  let oG = sample_curve(mG, 2u);
  let oB = sample_curve(mB, 3u);
  return vec4f(clamp(vec3f(oR, oG, oB), vec3f(0.0), vec3f(1.0)), 1.0);
}`,
    writeUniforms(node, scratch) {
      const p = node.params || {};
      scratch[16] = (typeof p.inLayer === "number") ? p.inLayer : 0;
      scratch[17] = 0; scratch[18] = 0; scratch[19] = 0;
      // Each curve packs 64 entries into 16 consecutive vec4f slots
      // (64 floats). Layout: curveM at 20..83, curveR at 84..147,
      // curveG at 148..211, curveB at 212..275. Total uniform floats
      // used: 16 (preamble) + 4 (params) + 4*64 = 276. uniformBytes
      // = 276 * 4 = 1104.
      const packCurve = (arr, baseOff) => {
        const a = (Array.isArray(arr) && arr.length >= 64) ? arr : null;
        for (let i = 0; i < 64; i++) {
          scratch[baseOff + i] = a ? a[i] : (i / 63);
        }
      };
      packCurve(p.curveMaster,  20);
      packCurve(p.curveR,       84);
      packCurve(p.curveG,      148);
      packCurve(p.curveB,      212);
    },
    description: "Per-channel paint-drawable curve LUT for color grading. Edit four 64-point curves: Master (applied first, all channels equally) then R / G / B individually. Click 'Edit curves…' in the props pane to open the modal; click+drag along the plot to redraw the curve directly (paint mode, like Photoshop's pencil — no per-point handles to chase). 'Smooth' applies a 3-tap moving average for cleanup. Identity default is a linear ramp (pass-through). Composes Master-then-per-channel, the standard pro color-grading pipeline order. Use cases: S-curve contrast push, channel-specific shadow/highlight tints, color-temperature shifts via opposing R/B curves."
  },

  /* ---- B1: Math, single-arg trig (cmath) ---- */
  Sin:    { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "sinf({in})",   description: "sin(x), x in radians" },
  Cos:    { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "cosf({in})",   description: "cos(x), x in radians" },
  Tan:    { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "tanf({in})",   description: "tan(x), x in radians" },
  Asin:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "asinf({in})",  description: "Inverse sine" },
  Acos:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "acosf({in})",  description: "Inverse cosine" },
  Atan:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "atanf({in})",  description: "Inverse tangent" },
  Sinh:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "sinhf({in})",  description: "Hyperbolic sine" },
  Cosh:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "coshf({in})",  description: "Hyperbolic cosine" },
  Tanh:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "tanhf({in})",  description: "Hyperbolic tangent (soft saturator)" },

  /* ---- B1: Math, exp / log / power (cmath) ---- */
  Exp:    { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "expf({in})",   description: "e^x" },
  Exp2:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "exp2f({in})",  description: "2^x" },
  Log:    { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "logf({in})",   description: "Natural log" },
  Log2:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "log2f({in})",  description: "Log base 2" },
  Log10:  { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "log10f({in})", description: "Log base 10" },
  Sqrt:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "sqrtf({in})",  description: "Square root" },
  Cbrt:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "cbrtf({in})",  description: "Cube root" },
  Squared:{ category: "Math", color: COLOR.math, header: null, cppType: "",     ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "({in} * {in})",        description: "x squared" },
  Cubed:  { category: "Math", color: COLOR.math, header: null, cppType: "",     ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "({in} * {in} * {in})", description: "x cubed" },
  Recip:  { category: "Math", color: COLOR.math, header: null, cppType: "",     ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(1.f / {in})",         description: "Reciprocal: 1/x" },

  /* ---- B1: Math, rounding / sign (cmath) ---- */
  Sign:   { category: "Math", color: COLOR.math, header: null,    cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "({in} > 0.f ? 1.f : ({in} < 0.f ? -1.f : 0.f))", description: "+1, -1, or 0 by sign" },
  Floor:  { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "floorf({in})",                                description: "Round toward -infinity" },
  Ceil:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "ceilf({in})",                                 description: "Round toward +infinity" },
  Round:  { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "roundf({in})",                                description: "Round to nearest" },
  Trunc:  { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "truncf({in})",                                description: "Round toward zero" },
  Frac:   { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "({in} - floorf({in}))",                       description: "Fractional part" },

  /* ---- B1: Math, two-arg (cmath) ---- */
  Pow:    { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "powf({a}, {b})",   description: "a raised to b" },
  Atan2:  { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "atan2f({a}, {b})", description: "atan2(a, b)" },
  Mod:    { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "fmodf({a}, {b})",  description: "a mod b" },
  Hypot:  { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "hypotf({a}, {b})", description: "sqrt(a^2 + b^2)" },
  Min:    { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "fminf({a}, {b})",  description: "Smaller of a, b" },
  Max:    { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "fmaxf({a}, {b})",  description: "Larger of a, b" },
  Div:    { category: "Math", color: COLOR.math, header: null,    cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "({a} / {b})",          description: "a divided by b" },

  /* ---- B1: Comparison (output is 1.0 or 0.0) ---- */
  Eq:     { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({a} == {b}) ? 1.f : 0.f)", description: "1 if a equals b, else 0" },
  Neq:    { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({a} != {b}) ? 1.f : 0.f)", description: "1 if a differs from b" },
  Lt:     { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({a} <  {b}) ? 1.f : 0.f)", description: "1 if a < b" },
  Gt:     { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({a} >  {b}) ? 1.f : 0.f)", description: "1 if a > b" },
  Lte:    { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({a} <= {b}) ? 1.f : 0.f)", description: "1 if a <= b" },
  Gte:    { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({a} >= {b}) ? 1.f : 0.f)", description: "1 if a >= b" },

  /* ---- B1: Logic ---- */
  And:    { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "((({a} > 0.f) && ({b} > 0.f)) ? 1.f : 0.f)", description: "Logical AND (positive=true)" },
  Or:     { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "((({a} > 0.f) || ({b} > 0.f)) ? 1.f : 0.f)", description: "Logical OR" },
  Xor:    { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "((({a} > 0.f) != ({b} > 0.f)) ? 1.f : 0.f)", description: "Logical XOR" },
  Not:    { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({in} > 0.f) ? 0.f : 1.f)", description: "Logical NOT" },

  /* ---- B1: Selection / routing ----
   * Five conditional / multiplexer nodes that cover the common
   * routing patterns:
   *   • If         — the gate-style "cond > 0 ? a : b" — the right
   *                  shape when cond is a trigger / gate / clock
   *                  output (anything that's already 0/1).
   *   • IfGreater  — cond compared to a configurable threshold.
   *                  Lets you switch on continuous signals like
   *                  frequency, BPM, envelope output, etc.
   *   • IfLess     — same but inverted comparator.
   *   • IfRange    — windowed select: cond within [min,max] picks
   *                  a, otherwise b. Useful for "is the BPM in a
   *                  certain range" or "is the pitch in this
   *                  octave" style switching.
   *   • Selector4  — 4-way mux with a normalized 0..1 selector
   *                  input. Wire a counter or LFO into sel and
   *                  the output cycles through a/b/c/d. Pairs
   *                  well with sequencers for pattern A/B/C/D
   *                  switching.
   * For continuous-signal blending use Crossfade (linear) or Lerp
   * — those don't switch, they interpolate. */
  If:        { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"cond", t:"audio"}, {n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({cond} > 0.f) ? {a} : {b})", description: "Gate-style select: cond > 0 picks a, else b. Wire any gate / trigger / clock-tick into cond. For continuous-signal thresholds use IfGreater / IfLess / IfRange." },
  IfGreater: { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"cond", t:"audio"}, {n:"thresh", t:"param"}, {n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: { thresh: 0.5 }, template: "(({cond} > {thresh}) ? {a} : {b})", description: "Threshold select: cond > thresh picks a, else b. Useful for switching on a frequency / BPM / envelope crossing a level." },
  IfLess:    { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"cond", t:"audio"}, {n:"thresh", t:"param"}, {n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: { thresh: 0.5 }, template: "(({cond} < {thresh}) ? {a} : {b})", description: "Threshold select: cond < thresh picks a, else b." },
  IfRange:   { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"cond", t:"audio"}, {n:"min", t:"param"}, {n:"max", t:"param"}, {n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: { min: 0, max: 1 }, template: "(({cond} >= {min} && {cond} <= {max}) ? {a} : {b})", description: "Window select: cond ∈ [min, max] picks a, else b. e.g. 'BPM between 100 and 130 → pattern A else pattern B'." },
  Selector4: { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"sel", t:"param"}, {n:"a", t:"audio"}, {n:"b", t:"audio"}, {n:"c", t:"audio"}, {n:"d", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({sel} < 0.25f) ? {a} : (({sel} < 0.5f) ? {b} : (({sel} < 0.75f) ? {c} : {d})))", description: "4-way multiplexer. sel ∈ [0,1] picks one of a/b/c/d in equal quarters. Wire a counter, LFO, or step sequencer into sel for pattern routing." },
  Crossfade: { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}, {n:"x", t:"param"}], outs: [{n:"out", t:"audio"}], params: { x: 0.5 }, template: "((1.f - {x}) * {a} + {x} * {b})", description: "Linear crossfade: a at x=0, b at x=1 — smooth blend, not a switch." },
  Lerp:      { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}, {n:"x", t:"param"}], outs: [{n:"out", t:"audio"}], params: { x: 0.5 }, template: "({a} + {x} * ({b} - {a}))",       description: "Linear interpolate from a to b — alias of Crossfade with the lerp identity, useful when wiring x outside [0,1] for extrapolation." },
  /* Smoothstep clamps its input to [0,1] before applying the cubic.
   * Without the clamp, inputs outside that range produce values
   * that explode (cubic grows fast) — typical bug when wiring an
   * unbounded modulator into the input expecting "smoothstep" to
   * just-work. */
  Smoothstep:{ category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(({in} <= 0.f) ? 0.f : (({in} >= 1.f) ? 1.f : ({in} * {in} * (3.f - 2.f * {in}))))", description: "Hermite smoothstep — eases in and out. Input clamped to [0,1]." },

  /* ---- B1: Range mapping ---- */
  /* Wrap / Fold / Quantize each guard against a degenerate range
   * (min == max for the first two, step == 0 for Quantize). Without
   * the guards the substituted expression divides by 0 and produces
   * NaN, which then poisons every downstream sample. The conditional
   * branch keeps the cost small (one compare per sample on the safe
   * path; same as before plus a select). */
  Wrap: { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}, {n:"min", t:"param"}, {n:"max", t:"param"}], outs: [{n:"out", t:"audio"}], params: { min: 0, max: 1 }, template: "((({max}) == ({min})) ? ({in}) : ({min} + fmodf(fmodf({in} - {min}, {max} - {min}) + ({max} - {min}), {max} - {min})))", description: "Wrap input into [min, max] (modulo). min==max passes input through." },
  Fold: { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}, {n:"min", t:"param"}, {n:"max", t:"param"}], outs: [{n:"out", t:"audio"}], params: { min: -1, max: 1 }, template: "((({max}) == ({min})) ? ({min}) : (({in} > {max} || {in} < {min}) ? ({max} - fabsf(fmodf({in} - {min}, 2.f * ({max} - {min})) - ({max} - {min}))) : {in}))", description: "Fold (reflect) input into [min, max]. min==max clamps to that value." },
  Quantize: { category: "Math", color: COLOR.math, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}, {n:"step", t:"param"}], outs: [{n:"out", t:"audio"}], params: { step: 0.1 }, template: "((({step}) == 0.f) ? ({in}) : (roundf({in} / {step}) * {step}))", description: "Snap to nearest multiple of step. step=0 passes input through." },

  /* ---- B1: Conversion (semitones, ratios) ---- */
  Semi:  { category: "Convert", color: COLOR.convert, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "powf(2.f, {in} / 12.f)", description: "Semitone offset → frequency ratio" },
  Cents: { category: "Convert", color: COLOR.convert, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "powf(2.f, {in} / 1200.f)", description: "Cents offset → frequency ratio" },

  /* ---- B1: Stateful primitives (simple ones — bigger ones in B4) ---- */
  RingMod: { category: "Effect", color: COLOR.effect, header: null, cppType: "", ins: [{n:"a", t:"audio"}, {n:"b", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "({a} * {b})", description: "Ring modulator (just multiplication, but named)" },
  PhaseInvert: { category: "Math", color: COLOR.math, header: null, cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "(-{in})", description: "Multiply by -1" },
  SoftClip: { category: "Effect", color: COLOR.effect, header: "cmath", cppType: "", ins: [{n:"in", t:"audio"}], outs: [{n:"out", t:"audio"}], params: {}, template: "tanhf({in})", description: "Soft clip via tanh" },

  /* ============================================================
   * Phase A.1 placeholder nodes — typed-vector port verification
   *
   * These three are the smoke test for the new `vector` and
   * `llm-attn` port types (added to VISUAL_PORT_TYPES this sprint)
   * and the new runtime-only node kinds ("llm-op", "llm-sink",
   * "llm-viz"). They have NO runtime behavior yet — the actual
   * dispatchers ship in Phase B (Ollama → src/ai/ollama.js) and
   * Phase D (LLM-from-scratch → src/llm/dispatcher.js).
   *
   * Verification: drop a VectorSource → VectorSink in a patch, see
   * the magenta `vector` wire connect. Drop the same pair with
   * unrelated wire types and see them refuse (portsCompatible →
   * false). The patch's emitted `.h` is unchanged regardless of
   * how many of these you wire in — codegen skip via
   * isRuntimeOnlyKind() in src/codegen/index.js.
   * ============================================================ */
  VectorSource: {
    category: "AI", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-op",
    ins: [],
    outs: [{ n: "vec", t: "vector" }],
    params: { dim: 4 },
    description: "Phase A.1 placeholder — emits a static Float32Array of length `dim` with values [0..dim-1] on its `vec` output. Used to smoke-test the new typed-vector wire system. No runtime behavior; replaced by real LLMEmbed / TokenEmbedding nodes in Phases B + D."
  },
  VectorSink: {
    category: "AI", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-sink",
    ins: [{ n: "vec", t: "vector" }],
    outs: [],
    params: {},
    description: "Phase A.1 placeholder — receives a `vector` input and displays its shape + first few values in the node body. No runtime behavior yet (Phase A.2 adds the node-body renderer). Used to smoke-test typed-vector wire compatibility."
  },
  AttnViz: {
    category: "AI", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-viz",
    ins: [{ n: "attn", t: "llm-attn" }],
    outs: [{ n: "tex", t: "texture" }],
    params: {},
    description: "Phase A.1 placeholder — receives an `llm-attn` input (attention weights [B,H,T,T] + token labels) and outputs a `texture` port for downstream Materials. No runtime behavior yet; the real AttentionGraph3D (port of LLMAttention3D.jsx) ships in Phase D sprint llm-10."
  },

  /* Phase C sprint tektite-5c -- TektiteGraph.
   *
   * The Tektite-unique upgrade vs Obsidian: the knowledge graph isn't
   * a sandboxed pane but a first-class TEXTURE SOURCE in the visual
   * node pipeline. The force-directed layout from the Tektite tab's
   * 🕸 Graph button (sprint tektite-5b) renders here to an offscreen
   * canvas and uploads to a GPUTexture each frame, exposed as the
   * `tex` output. Wire it into Sprite.texture, ShaderFrag.uniform,
   * or any other texture consumer in the visual pipeline.
   *
   * mode = "global" walks the whole vault. mode = "local" centers on
   *   the editor's currently-loaded note + depth-hop BFS neighborhood.
   * minDegree filters out isolated notes (degree < threshold) in
   *   global mode; useful for hiding orphans in noisy vaults.
   * width / height set the output texture resolution (default 512^2,
   *   max 2048^2).
   *
   * Runtime-only (no C++ codegen). Layout settles within ~250
   * iterations (~4 seconds at 60 Hz), after which the texture stays
   * static until a config param changes.
   * ============================================================ */
  TektiteGraph: {
    category: "AI", color: COLOR.ai, header: null,
    cppType: "", kind: "tektite-graph",
    ins: [
      { n: "mode",      t: "text"  },
      { n: "depth",     t: "param" },
      { n: "minDegree", t: "param" },
      { n: "centerId",  t: "text"  }
    ],
    outs: [
      { n: "tex", t: "texture" }
    ],
    params: {
      mode:      "global",
      depth:     2,
      minDegree: 0,
      centerId:  "",
      width:     512,
      height:    512,
      bgR:       0.04, bgG: 0.05, bgB: 0.09,
      edgeR:     0.61, edgeG: 0.81, edgeB: 1.0, edgeA: 0.30,
      nodeR:     0.78, nodeG: 0.91, nodeB: 0.35
    },
    paramOptions: { mode: ["global", "local"] },
    description: "Renders the Tektite vault as a force-directed graph onto a live GPUTexture (default 512×512). Wire `tex` into **Sprite.texture** (then Sprite → Scene2D → VisualOutput) to render the live knowledge graph. Direct-to-VisualOutput wiring is not currently supported; future sprint will add it. `mode=local` centers on the currently-loaded note + `depth`-hop neighborhood; `mode=global` walks the whole vault with optional `minDegree` filter. Background, edge, and node colors are configurable (RGB params 0-1). The layout matches what the 🕸 Graph button shows. **Tektite-unique upgrade — Obsidian's graph view is sandboxed in a pane; ours flows into the audio/visual node pipeline.**"
  },

  /* ============================================================
   * Phase C sprint tektite-10b -- spatial card kinds.
   *
   * Path A unification: TextCard / NoteCard / LinkCard / BaseCard
   * become first-class node types on the main canvas. The Tektite
   * Canvas modal becomes (sprint 10c) a palette-filtered preset of
   * the main canvas; the Tektite Graph modal (sprint 10d) becomes a
   * GraphCard render. For now these card kinds are no-codegen,
   * runtime-only (kind: "tektite-card-*"). They flow data through
   * standard text/param ports so they can wire into LLM / Sprite /
   * etc. when needed.
   *
   * Width / height params let the user resize per-card; defaults
   * match the Tektite Canvas modal's sizes so a docs-canvas
   * imported as cards looks identical.
   *
   * The JSON-Canvas color slots (1-6) are honored via the `color`
   * param so cards round-trip cleanly between the spatial-canvas
   * mode and the main canvas.
   * ============================================================ */
  TextCard: {
    category: "Tektite", color: COLOR.tektite, header: null,
    cppType: "", kind: "tektite-card-text",
    ins: [],
    outs: [{ n: "text", t: "text" }],
    params: {
      text:       "New text card.\n\nClick to edit. Drag corner to resize.",
      width:      260,
      height:     80,
      color:      "",
      linkedFile: ""    // Sprint 10d -- optional vault note id; when
                         // set, edits sync two-way with the vault
    },
    paramOptions: { color: ["", "1", "2", "3", "4", "5", "6"] },
    description: "Phase C sprint tektite-10b/10d -- editable spatial card holding markdown text.  Click body to edit; outputs `text` so an LLM / SystemPrompt / classifier can read the body. Set `linkedFile` to a vault note id and edits sync TWO-WAY with that note (changes here save to the vault; changes in Tektite refresh the card). `color` maps to JSON Canvas palette slot (1=red 2=orange 3=yellow 4=green 5=cyan 6=purple). Resizes from the corner."
  },
  NoteCard: {
    category: "Tektite", color: COLOR.tektite, header: null,
    cppType: "", kind: "tektite-card-note",
    ins: [],
    outs: [
      { n: "text",  t: "text" },
      { n: "title", t: "text" }
    ],
    params: {
      file:   "",
      width:  320,
      height: 400,
      color:  ""
    },
    paramOptions: { color: ["", "1", "2", "3", "4", "5", "6"] },
    description: "Phase C sprint tektite-10b -- spatial card embedding a vault note. Set `file` to a note id or title; the card outputs `text` (the note's content) and `title`. Wire `text` into LLMChat.system / LLMClassifier.input / etc.  In 10c-10d the Tektite Canvas + Graph modals will both render their note embeds as NoteCard instances."
  },
  LinkCard: {
    category: "Tektite", color: COLOR.tektite, header: null,
    cppType: "", kind: "tektite-card-link",
    ins: [],
    outs: [{ n: "url", t: "text" }],
    params: {
      url:        "https://example.com",
      label:      "",         // optional display label
      width:      320,
      height:     120,
      color:      "",
      linkedFile: ""    // Sprint 10d -- optional vault note id; when
                         // set, url comes from the note's frontmatter
                         // `url:` field + edits sync back
    },
    paramOptions: { color: ["", "1", "2", "3", "4", "5", "6"] },
    description: "Phase C sprint tektite-10b/10d -- editable URL card. Click URL to edit; outputs `url` as a text wire so downstream nodes (LLMChat, Sprite via fetch wrappers, etc.) consume it. Set `linkedFile` to a vault note id and the url + label sync TWO-WAY with that note's `url:` and `label:` frontmatter fields."
  },
  BaseCard: {
    category: "Tektite", color: COLOR.tektite, header: null,
    cppType: "", kind: "tektite-card-base",
    ins: [],
    outs: [
      { n: "rows",  t: "text" },   // JSON-serialized result set
      { n: "count", t: "param" }
    ],
    params: {
      baseId: "",    // vault id of a `tektite-base: true` note
      view:   "table",
      width:  480,
      height: 320,
      color:  ""
    },
    paramOptions: {
      view:  ["table", "list", "cards"],
      color: ["", "1", "2", "3", "4", "5", "6"]
    },
    description: "Phase C sprint tektite-10b -- spatial card embedding a Base (typed-frontmatter tabular view, sprint tektite-8). Set `baseId` to a base-note id; the card runs the base's filter + sort and outputs the result rows as a JSON-serialized `text` wire + a `count` scalar. Useful for piping a filtered note set into an LLM batch operation. The card-side rendering lands in sprint tektite-10c."
  },

  /* Phase C sprint tektite-10e -- GraphCard. Force-directed view of
   * the vault graph (notes = nodes, [[wikilinks]] = edges) embedded
   * as a card on the main canvas. Mirrors the 🕸 Graph modal's
   * renderer in a card-sized canvas; click a graph node to open it
   * in a popout. ⛶ button on the card opens the full-screen modal
   * for workspace-scale exploration. Outputs the currently selected
   * note id so downstream cards / LLM nodes can react.
   *
   * The TektiteGraph node (AI category, kind tektite-graph) renders
   * to a GPUTexture for the visual pipeline; GraphCard renders to
   * the DOM for direct interaction. Same underlying graph + layout. */
  GraphCard: {
    category: "Tektite", color: COLOR.tektite, header: null,
    cppType: "", kind: "tektite-card-graph",
    ins: [],
    outs: [
      { n: "selectedId", t: "text"  },
      { n: "count",      t: "param" }
    ],
    params: {
      mode:      "global",
      // Sprint 10s -- layout matches the modal's 14 layouts.
      layout:    "force",
      depth:     2,
      minDegree: 0,
      centerId:  "",
      width:     360,
      height:    260,
      color:     ""
    },
    paramOptions: {
      mode:   ["global", "local"],
      layout: [
        "force", "tree", "radial", "sunburst",
        "embedding-2d", "galaxy", "timeline", "calendar",
        "matrix", "chord", "sankey", "tagcloud", "geo", "kanban"
      ],
      color:  ["", "1", "2", "3", "4", "5", "6"]
    },
    description: "Phase C sprint tektite-10e + 10s -- live view of the vault graph as a card. Both scope (global/local) and layout (all 14: force / tree / radial / sunburst / embedding-2d / galaxy / timeline / calendar / matrix / chord / sankey / tagcloud / geo / kanban) are dropdowns on the card; ⛶ expands to the full 🕸 Graph modal with the same config. Click a graph node to open it in a popout. Outputs `selectedId` (the clicked note's id) so downstream cards / LLM nodes can react to selection."
  },

  /* Phase C sprint tektite-10m -- CanvasCard.  Wraps a legacy Tektite
   * Canvas doc (JSON-Canvas backed, see src/tektite/canvas.js) inside
   * a card on the main canvas.  The body shows a read-only preview of
   * the canvas's cards + an `⛶ Open` button that hands off to the
   * legacy Canvas modal for editing.  Use this when you want to nest
   * a docs-canvas inside a normal patch -- e.g. an architecture
   * diagram embedded next to the audio graph that drives it. */
  CanvasCard: {
    category: "Tektite", color: COLOR.tektite, header: null,
    cppType: "", kind: "tektite-card-canvas",
    ins: [],
    outs: [
      { n: "cardCount", t: "param" },
      { n: "edgeCount", t: "param" }
    ],
    params: {
      canvasId: "",
      width:    320,
      height:   200,
      color:    ""
    },
    paramOptions: { color: ["", "1", "2", "3", "4", "5", "6"] },
    description: "Phase C sprint tektite-10m -- embed a Tektite Canvas doc (JSON-Canvas backed) as a card on the main editor canvas. Set `canvasId` to the vault id of a `tektite-canvas: true` note, or click 🔗 in the card body to pick / create one. The body shows a thumbnail of the canvas's cards + edges; click ⛶ Open to edit in the full Canvas modal."
  },

  /* ============================================================
   * Phase B sprint 4 — Ollama-backed LLM nodes (MVP)
   *
   * Five wirable nodes that drive the editor's Ollama integration
   * from inside the graph instead of from the User DSP AI panel.
   * Two pure string sources (kind: "llm-op") and three gate-triggered
   * async fetchers (kind: "llm-sink"). All five route through
   * src/ai/llm-runtime.js's dispatcher; none of them participate in
   * C++ codegen (isRuntimeOnlyKind() in src/codegen/index.js).
   *
   * Verify path:
   *   1. Drop SystemPrompt, set its `text` param.
   *   2. Drop LLMChat, set its `prompt` param to something.
   *   3. Wire SystemPrompt.text -> LLMChat.system.
   *   4. Drop a Button, wire Button.clicked -> LLMChat.trigger.
   *   5. Hit Run on a patch (Play). Click the Button. Tokens stream
   *      into the LLMChat node body live. When done, the accumulated
   *      text lands on params.text + the `done` port pulses for one
   *      tick (chain another node off it to react).
   * ============================================================ */
  SystemPrompt: {
    category: "AI/LLM", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-op",
    ins: [],
    outs: [{ n: "text", t: "text" }],
    params: { text: "You are a helpful assistant." },
    description: "Static system-prompt source. Type the prompt into the `text` param; downstream LLMChat / LLMGenerate nodes consume it via their `system` input. Pure passthrough (no runtime call) — just a string source on the wire."
  },
  LLMModelPicker: {
    category: "AI/LLM", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-op",
    ins: [],
    outs: [{ n: "model", t: "text" }],
    params: { model: "llama3.2" },
    description: "Model-name source. Type an Ollama model tag (e.g. `llama3.2`, `qwen3:8b`, `gpt-oss:120b-cloud`) into the `model` param. Wire `model` into LLMChat/LLMGenerate/LLMEmbed to override their default. Doesn't probe Ollama — Settings → Provider → Refresh models shows what's actually installed."
  },
  LLMChat: {
    category: "AI/LLM", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-sink",
    ins: [
      { n: "prompt",  t: "text" },
      { n: "system",  t: "text" },
      { n: "model",   t: "text" },
      { n: "trigger", t: "gate" }
    ],
    outs: [
      { n: "text", t: "text" },
      { n: "done", t: "gate" }
    ],
    params: {
      prompt: "Write a haiku about transformers.",
      system: "",
      model:  "",
      trigger: 0,
      text:   "",
      done:   0
    },
    uiOnlyParams: ["text", "done"],
    description: "Streams a chat response from the configured Ollama daemon (Settings → Provider → Local Ollama). On `trigger` rising edge, calls /api/chat with system + prompt + model. Tokens land in the node body live via the Phase A.2 streaming primitive; the accumulated text lands on the `text` output port and the `done` gate pulses once. Inputs prefer wired values; unwired inputs use their local params. Empty model defaults to the active provider model in Settings."
  },
  LLMGenerate: {
    category: "AI/LLM", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-sink",
    ins: [
      { n: "prompt",  t: "text" },
      { n: "system",  t: "text" },
      { n: "model",   t: "text" },
      { n: "trigger", t: "gate" }
    ],
    outs: [
      { n: "text", t: "text" },
      { n: "done", t: "gate" }
    ],
    params: {
      prompt: "Write a single sentence about a llama.",
      system: "",
      model:  "",
      trigger: 0,
      text:   "",
      done:   0
    },
    uiOnlyParams: ["text", "done"],
    description: "Single-shot text completion via Ollama /api/generate. Same shape as LLMChat but cheaper for stateless prompts (no chat history overhead). On `trigger` rising edge, fires the request; tokens stream into the node body; accumulated text lands on `text` and `done` pulses once. Use this over LLMChat for prompt-template style work where every request stands alone."
  },
  LLMEmbed: {
    category: "AI/Embed", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-sink",
    ins: [
      { n: "text",    t: "text" },
      { n: "model",   t: "text" },
      { n: "trigger", t: "gate" }
    ],
    outs: [
      { n: "vec",  t: "vector" },
      { n: "done", t: "gate" }
    ],
    params: {
      text:    "Hello world.",
      model:   "nomic-embed-text",
      trigger: 0,
      dim:     0,
      done:    0
    },
    uiOnlyParams: ["dim", "done"],
    description: "Embeds the input string via Ollama /api/embed. On `trigger` rising edge, calls the embed endpoint with the resolved text + model. The resulting Float32Array lands on the `vec` output port (consume with anything expecting a Phase A.1 `vector` -- VectorSink to inspect shape, future Tektite MD viz, etc). `done` pulses once on completion. Default model is `nomic-embed-text` — install with `ollama pull nomic-embed-text`."
  },

  /* ============================================================
   * Phase B sprint 6 -- stretch nodes.
   *
   * Six nodes that compose on top of the MVP five from sprint B.4:
   *
   *   ConversationMemory  -- rolling N-turn buffer; serializes to .gpatch
   *   EmbedSimilarity     -- cosine similarity scalar between two vectors
   *   LLMClassifier       -- constrained-choice classifier
   *   VoiceToLLM          -- mic → STT → LLMChat composite (Web Speech API)
   *   LLMToTTS            -- text → SpeechSynthesis sink
   *   JSONFormat          -- JSON-mode chat with a single-field extractor
   *
   * All dispatched from src/ai/llm-runtime.js. ConversationMemory +
   * EmbedSimilarity are llm-op (cheap, runs every tick); the four
   * llm-sinks each have an AbortController so a second trigger
   * cancels the in-flight stream + starts a new one.
   * ============================================================ */
  ConversationMemory: {
    category: "AI/LLM", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-op",
    ins: [
      { n: "userMsg",         t: "text" },
      { n: "assistantMsg",    t: "text" },
      { n: "appendUser",      t: "gate" },
      { n: "appendAssistant", t: "gate" },
      { n: "clear",           t: "gate" }
    ],
    outs: [
      { n: "messages", t: "text" },
      { n: "count",    t: "param" }
    ],
    params: {
      userMsg:         "",
      assistantMsg:    "",
      appendUser:      0,
      appendAssistant: 0,
      clear:           0,
      maxTurns:        10,
      history:         [],
      messages:        "[]",
      count:           0
    },
    uiOnlyParams: ["messages", "count"],
    description: "Rolling chat-history buffer. On `appendUser` rising edge, pushes {role:'user', content: userMsg} onto an internal history array; same for `appendAssistant`. `clear` wipes the buffer. The `messages` output emits the JSON-serialized array; pipe it into a downstream LLMChat (or read history[] via the `.gpatch`). Trims oldest turns to `maxTurns * 2` entries. The `history` param persists in saved `.gpatch` so a chat session survives reload."
  },

  EmbedSimilarity: {
    category: "AI/Embed", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-op",
    ins: [
      { n: "a", t: "vector" },
      { n: "b", t: "vector" }
    ],
    outs: [
      { n: "similarity", t: "param" }
    ],
    params: { similarity: 0 },
    uiOnlyParams: ["similarity"],
    description: "Cosine similarity between two vector inputs. Reads both Float32Array buffers per tick and outputs a scalar in [-1, 1] (1 = identical direction, 0 = orthogonal). Wire two LLMEmbed nodes in and drive an audio param, shader uniform, or threshold gate downstream. Vectors must have the same length; mismatch outputs 0."
  },

  LLMClassifier: {
    category: "AI/LLM", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-sink",
    ins: [
      { n: "input",   t: "text" },
      { n: "labels",  t: "text" },
      { n: "model",   t: "text" },
      { n: "trigger", t: "gate" }
    ],
    outs: [
      { n: "label", t: "text" },
      { n: "done",  t: "gate" }
    ],
    params: {
      input:   "I love this!",
      labels:  "positive,negative,neutral",
      model:   "",
      trigger: 0,
      label:   "",
      done:    0
    },
    uiOnlyParams: ["label", "done"],
    description: "Constrained classifier. On `trigger` rising edge, asks the LLM to pick exactly one of `labels` (comma-separated) for `input`. Uses a tight system prompt + low max-tokens to force a single-word reply. Output snapped back to the closest matching label string (case-insensitive). Use for smart-link wiring (classify intent → branch behavior) or telemetry labeling."
  },

  VoiceToLLM: {
    category: "AI/LLM", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-sink",
    ins: [
      { n: "record",  t: "gate" },
      { n: "system",  t: "text" },
      { n: "model",   t: "text" }
    ],
    outs: [
      { n: "userText",      t: "text" },
      { n: "assistantText", t: "text" },
      { n: "done",          t: "gate" }
    ],
    params: {
      record:        0,
      system:        "",
      model:         "",
      userText:      "",
      assistantText: "",
      done:          0
    },
    uiOnlyParams: ["userText", "assistantText", "done"],
    description: "Voice-in, LLM-out. On `record` rising edge, starts Web Speech API recognition; on falling edge OR `recognition.end`, finalizes the transcript, fires LLMChat with it, streams the response into `assistantText`. `userText` updates live as the user speaks. Requires a Chromium-based browser (SpeechRecognition unsupported in Firefox). Holds the mic only between rising + falling edge of `record`."
  },

  LLMToTTS: {
    category: "AI/LLM", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-sink",
    ins: [
      { n: "text",  t: "text" },
      { n: "speak", t: "gate" },
      { n: "rate",  t: "param" },
      { n: "pitch", t: "param" }
    ],
    outs: [
      { n: "done", t: "gate" }
    ],
    params: {
      text:  "Hello world.",
      speak: 0,
      rate:  1.0,
      pitch: 1.0,
      voice: "",
      done:  0
    },
    uiOnlyParams: ["done"],
    description: "Speaks `text` via browser SpeechSynthesis on `speak` rising edge. `rate` is 0.1-10 (default 1), `pitch` is 0-2 (default 1), `voice` is a substring match against navigator's voice list (e.g. 'Daniel', 'Samantha' — leave blank for system default). `done` pulses once on utterance end. Useful as a sink for LLMChat.text → LLMToTTS.text for round-trip voice conversations."
  },

  JSONFormat: {
    category: "AI/LLM", color: COLOR.ai, header: null,
    cppType: "", kind: "llm-sink",
    ins: [
      { n: "prompt",  t: "text" },
      { n: "schema",  t: "text" },
      { n: "field",   t: "text" },
      { n: "model",   t: "text" },
      { n: "trigger", t: "gate" }
    ],
    outs: [
      { n: "value", t: "text" },
      { n: "raw",   t: "text" },
      { n: "done",  t: "gate" }
    ],
    params: {
      prompt:  "Pick a random integer 0-100 and a colour name.",
      schema:  "{ number: int, color: string }",
      field:   "number",
      model:   "",
      trigger: 0,
      value:   "",
      raw:     "",
      done:    0
    },
    uiOnlyParams: ["value", "raw", "done"],
    description: "LLM-as-controller. Calls Ollama with `format: 'json'` mode + a system prompt incorporating `schema`. On success, parses the response and extracts the top-level `field` into `value` (as text). The full JSON lands on `raw` for downstream consumers. Wire `value` into a NumFromText / param to use the LLM as a parameter source — e.g. 'choose a melody mode from {dorian, lydian, mixolydian}'."
  }
};