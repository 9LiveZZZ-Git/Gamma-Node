# Open Options — Decision Menu

> **Status (current build):**
> - **Provider stack:** Gemma 4 E4B is the default local provider via `@huggingface/transformers` + WebGPU. Anthropic Claude remains as optional cloud backup. WebLLM and OpenAI removed.
> - **One model, three jobs:** Gemma 4 E4B handles `.gdsp` text generation, pen-tablet handwriting recognition, AND speech-to-text. Whisper-tiny kept as no-WebGPU fallback for voice when Anthropic is active.
> - **Shipped:** A0 (cloud HWR) → A4 (Gemma local HWR by default + Anthropic fallback). **B1** — registry now 110 nodes. **C6** — streaming on for both providers.
> - **Documented:** §13.6 covers fine-tuning Gemma 4 E4B with Unsloth (~17 GB VRAM, ~4 hr training, three suggested fine-tune targets: HWR closed-vocabulary, .gdsp idioms, voice commands).

This is a menu, not a roadmap. Pick what you want; skip what you don't. Each option has a one-line summary, a "what it costs" line, and a "what it unlocks" line so you can decide quickly.

Options are grouped into three buckets:

- **A · Handwriting recognition path** — pick one (or "stay on current path")
- **B · Roadmap features from EXPANSION.md** — pick any subset
- **C · Meta / infrastructure** — pick any subset

---

## A · Handwriting recognition path

The Gemma 4 migration reshuffled this section. You're currently on **A1 (baseline Gemma)**, with **A4 (Anthropic cloud)** automatically active when the user picks the optional Anthropic provider.

### A1 · Baseline Gemma 4 E4B (current default)
- **What:** Strokes → PNG → local Gemma 4 E4B via transformers.js → fuzzy-match against registry. The model card explicitly names "handwriting recognition" as a trained capability.
- **Costs:** Zero per recognition. ~1.5 GB initial download for E4B (or ~500 MB for E2B), cached in IndexedDB. Requires WebGPU.
- **Quality:** Projected ~95% on cleanly-written single words (untested on the full 110-name vocabulary).
- **Latency:** ~50–200 ms after warm-up; first-run includes ~1–3 min model load.
- **When to keep:** the default. Works offline, no API costs, vocabulary adapts instantly when new node types are added.

### A2 · Fine-tuned Gemma 4 E4B via Unsloth (recommended next step)
- **What:** Take the deployed Gemma 4 E4B and fine-tune a LoRA adapter on synthetic handwriting samples of the registry node names + collected real samples. Merge and re-export ONNX → swap the URL in the `gemma` provider's `defaultModel`.
- **Costs:** ~17 GB VRAM for training (RTX 4090 / A5000 / paid Colab L4). ~3 hours dataset prep + ~4 hours training. Bundle stays the same as baseline (replaces the URL in editor settings).
- **Quality:** Projected 99%+ on the closed registry vocabulary, with general HWR capability preserved for user-DSP types.
- **Latency:** Same as baseline (~50–200 ms).
- **When to pick:** when you have time to spend a day on it. Highest-leverage of the three fine-tunes documented in §13.6 (HWR, .gdsp idioms, voice commands) — least labor-intensive, highest impact.
- **Toolchain:** Unsloth has day-zero Gemma 4 support. Detailed recipe and gotchas in SPEC §13.6.

### A3 · Closed-vocabulary classifier (graceful-degradation backup)
- **What:** Tiny CNN that maps `image → which-of-N-classes` over the registry, plus an "unknown" class. Runs on WebAssembly (no WebGPU needed).
- **Costs:** ~5 MB bundle. ~3 hours to build synthetic-data pipeline + train. Re-train when registry meaningfully changes (~minutes).
- **Quality:** Projected 99%+ on closed vocabulary; "unknown" class catches off-list writing.
- **Latency:** ~5 ms.
- **When to pick:** for users on machines that *can't* run Gemma 4 (no WebGPU, mobile browsers, old Chromebooks). Position as a fallback when WebGPU detection fails, *not* as a primary replacement for Gemma — Gemma already does this job for everyone with WebGPU.

### A4 · Anthropic Claude (current alternate, on-demand)
- **What:** Strokes → PNG → Claude Sonnet 4.5 vision API → fuzzy-match against registry. Activated when user picks Anthropic provider in settings.
- **Costs:** ~0.5–1¢ per recognition. Requires API key. Online only.
- **Quality:** ~95% empirically on cleanly-written single words.
- **Latency:** 1–3 s (network round-trip).
- **When to keep:** for users without WebGPU who'd rather pay per-call than load Whisper-tiny + a classifier. Already shipped as the "Anthropic (Claude) — optional" provider.

### A5 · TrOCR (no longer recommended)
- **What:** Microsoft's `trocr-base-handwritten`, fine-tuned via stock HuggingFace + PEFT (Unsloth doesn't formally support its VisionEncoderDecoder architecture).
- **Why it's been demoted:** strictly worse than A2 for this editor. Single-task model (HWR only), separate ~330 MB bundle on top of Gemma's already-loaded weights, no Unsloth support, no advantage on closed-vocabulary accuracy. Listed for completeness in SPEC §14.1.2; not recommended.

**Current recommendation:** stay on A1 (baseline Gemma) for now. When registry stabilizes after Waves 4–5 of EXPANSION.md and you have a day to spend, do A2 (Unsloth fine-tune). Add A3 (classifier) only if mobile/no-WebGPU support becomes a real priority.

---

## B · Roadmap features from EXPANSION.md

These are scoped from EXPANSION.md, in roughly increasing complexity. Each is independently buildable.

### B1 · Wave 1: registry-only quick wins (~60 nodes)
- **What:** Add all the math primitives, comparison/logic, selection/routing templates from EXPANSION.md Part 2. All template-based, all `[gamma]` tag, no infrastructure changes.
- **Effort:** ~1 day. Just registry entries.
- **Result:** node count goes from 56 → ~115. The math/logic vocabulary that makes complex patches actually expressible.
- **Risk:** zero. Pure registry additions.

### B2 · Multi-output codegen
- **What:** Codegen path that handles nodes returning `Vec2`, `std::pair`, etc. — binds the call to a temporary, then each output port reads `.first`/`.second` or `[0]`/`[1]`.
- **Effort:** ~2 weeks (per EXPANSION.md Wave 4 estimate).
- **Unlocks:** `Pan2`, `Hilbert`, `StateVariableFilter` (LP/HP/BP/BR simultaneous outputs from one node), `MidSide` encoders, multi-tap delays, MFCC, Chromagram, `LinkwitzRiley` crossovers, dozens more.
- **Why it matters:** single biggest infrastructure win per dollar of work. Cascading benefits.

### B3 · Filter expansion (after B2)
- **What:** Build the Part 4 filter list — `StateVariableFilter`, Moog ladder, diode ladder, Sallen-Key, MS-20, K35, formant, Butterworth N-order, Linkwitz-Riley, parametric/3-band/8-band/graphic EQ. ~17 new nodes.
- **Effort:** ~1 week per filter family if from scratch; less if community `.gdsp` files cover them.
- **Result:** professional-grade filter section.

### B4 · Composite synthesis library (Part 3)
- **What:** Big composite library — FM ops (1/4/6 op), wavetable family, granular, distortion (BitCrush, Foldback, Tube/Tape), modulation FX (Phaser, Flanger, Chorus), full dynamics, time-based delays, reverbs.
- **Effort:** ~3 weeks if hand-coded as registry entries with custom C++ classes. Much faster if shipped as a starter `.gdsp` library — community can contribute.
- **Decision point:** are these built-in nodes or community `.gdsp`? My take: ship a few canonical ones built-in (Compressor, Chorus, Plate reverb), let the rest live as `.gdsp` files in a `community-gdsp/` folder.

### B5 · Block-rate codegen (after B2)
- **What:** Codegen path for nodes that operate on buffers (FFT-based effects, spectral analyzers). Patch can have block-rate "regions" inside the per-sample graph; codegen handles the boundary.
- **Effort:** ~4 weeks. The biggest single infrastructure leap.
- **Unlocks:** all of EXPANSION.md Part 5 (analyzers — RMSDetector, LUFS, MFCC, BeatTracker), Part 6 (spectral processing — SpectralFreeze, PitchShifter, TimeStretch, Vocoder), `ConvolutionReverb`.
- **Why it's hard:** the per-sample model in V1 is a clean abstraction; introducing block-rate islands in a sample-rate graph is gnarly. Latency at boundaries is real and has to be exposed.

### B6 · MIDI / OSC / host integration (Part 7)
- **What:** Nodes that source values from outside the audio graph — MIDI note in, CC, pitch bend, OSC paths, AlloLib `Parameter` binding, mouse/touch/keyboard input.
- **Effort:** ~3 weeks. Requires AlloLib Studio Online to expose its event system to the patch class.
- **Unlocks:** the editor becomes useful for actual playable instruments, not just static patches.
- **Dependency:** ideally wait for IDE integration (Milestone 2 of §16) so the `Parameter` binding has a real home.

### B7 · Visualization sinks (Part 10)
- **What:** Scope, XYScope, SpectrumDisplay, Spectrogram, Meter, LUFSMeter, Histogram, Phasometer. Render inside the node body itself via a 30 Hz ring-buffer protocol.
- **Effort:** ~2 weeks for the framework; per-viz time after that is small.
- **Unlocks:** debugging patches. Worth a lot for teaching contexts (MAT201).

### B8 · GPU compute via WebGPU (Part 11)
- **What:** GPU-accelerated nodes for long-IR convolution, massive granular synthesis, neural OCR/timbre transfer. Custom WGSL shader nodes via a `.wgsl` extension parallel to `.gdsp`.
- **Effort:** open-ended. ~4 weeks for the architecture (send/return bus pattern, JS↔WASM↔WebGPU pipeline), plus per-shader work.
- **Why defer:** GPU is the most architecturally involved feature. Worth doing once you've stabilized the editor and have specific GPU use cases (e.g., the "Fly Away" visualizer integration).

### B9 · Polyphony wrapper (per spec §11)
- **What:** Wraps the patch class in a polyphonic outer class with `noteOn(freq)` and round-robin voice allocation.
- **Effort:** ~3 days.
- **Useful:** soon, since most musical use cases need polyphony.

### B10 · Pan/zoom + undo/multi-select (per spec §16, Milestone 1)
- **What:** Production polish — canvas pan and zoom, undo stack with coalescing, multi-select via marquee, copy/paste/duplicate of subgraphs.
- **Effort:** ~2 weeks. Per spec §16 Milestone 1.
- **Why important:** the editor isn't really pleasant to use without these. M1 was already on the roadmap.

---

## C · Meta / infrastructure

### C1 · Replace textarea with CodeMirror 6
- **What:** Real code editor for the User DSP source — syntax highlighting, bracket matching, autocomplete, multi-cursor.
- **Effort:** ~1 day. CodeMirror 6 is well-documented and has C++ language support.
- **Cost:** ~150 KB added to the bundle. The current standalone-HTML constraint can absorb that.
- **Worth it:** yes, especially once you start authoring nontrivial `.gdsp` files.

### C2 · Server-proxy AI provider
- **What:** When integrated into AlloLib Studio Online, the IDE owns the API key and proxies calls. Adds a fourth entry to the `PROVIDERS` map: `proxy`.
- **Effort:** ~2 days editor-side; the IDE-side endpoint is its own thing.
- **Why:** removes the "everyone needs their own API key" friction for class deployments.
- **Dependency:** IDE integration (Milestone 2).

### C3 · Voice commands for editor actions (deferred from §14.3)
- **What:** Hold-to-speak voice control for "delete this," "save," "switch to generated code," "select all," etc. ~10–20 commands.
- **Effort:** ~1 week. The microphone capture and transcription paths already exist; this is just the command vocabulary + grammar + binding layer.
- **Open question:** rule-based pattern matching vs. LLM-routed (transcript + tool descriptions → which tool to call). LLM-routed is more flexible but slower and costs API tokens.

### C4 · Mobile gesture redesign (deferred from §15.6)
- **What:** Long-press context menu, pinch-to-zoom, two-finger pan, virtual keyboard handling. Currently mobile is "doesn't break," not "pleasant."
- **Effort:** ~2 weeks done well. Touch event handling is fiddly and varies across iOS/Android.
- **When to pick:** if mobile is actually a target. For MAT201 most students are on laptops; mobile is bonus.

### C5 · Server-side `.gdsp` smoke-compile validator
- **What:** When user clicks Validate, post the source to a server-side Emscripten endpoint that compiles a stub `int main(){ MyClass c; return 0; }` and returns errors. Catches bad C++ before WASM build.
- **Effort:** ~1 week including the server endpoint.
- **Why:** current validation is regex-based and misses real C++ errors. Surfacing errors in the editor is much better UX than waiting for the build to fail.

### C6 · Streaming LLM responses
- **What:** Both Anthropic and OpenAI APIs support streaming. Currently the editor waits for the whole response, then renders.
- **Effort:** ~2 days. Server-Sent Events handling, partial fence-stripping, incremental display.
- **Cost:** zero infrastructure; pure UX.
- **Worth it:** medium. Generations are ~5–15 s end-to-end; streaming makes them feel instant. WebLLM also supports streaming; same code path can serve both.

### C7 · Community `.gdsp` library
- **What:** A `community-gdsp/` folder shipped with the editor (or fetched on first load) containing curated user DSP files. Palette gets a "Community" sub-category.
- **Effort:** ~1 week for the loading + UI; then ongoing curation.
- **Why important:** this is where the User DSP feature actually pays off. Gives every user instant access to a library of pro-grade nodes.
- **Decision point:** how is the library distributed? Bundled into the HTML? Fetched from a GitHub repo on load? GitHub fetch is more flexible but adds a network dependency.

### C8 · `.gpatch` examples library
- **What:** Same as C7 but for full patches. 10–20 example `.gpatch` files demonstrating idiomatic Gamma usage.
- **Effort:** ~1 week of patch-authoring time.
- **Why important:** beginners need worked examples. MAT201 specifically benefits.

### C9 · Real-time audio preview (browser-side)
- **What:** Run the generated C++ via Emscripten to WASM in an `AudioWorklet`. Click "Play" in the editor and hear the patch.
- **Effort:** ~3 weeks. Needs an Emscripten build of Gamma + the WASM ↔ AudioWorklet plumbing + a UI for play/stop/reset.
- **Why huge:** removes the AlloLib Studio Online dependency for the editor's primary audio feedback loop. The editor becomes self-contained.
- **Dependency:** none, but it's a separate lane of work.

### C10 · Patch versioning / git-friendly format
- **What:** Make `.gpatch` more diffable — sort nodes by id, sort edges deterministically, normalize coordinates. Maybe a separate `.gpatch.lock` with the canonical form.
- **Effort:** ~2 days.
- **Why useful:** if patches end up in version control (likely in MAT201 group projects), diffs become readable.

---

## Staging plan (per current selection)

Based on the chosen direction — A0 stays active with A1 hybrid as long-term goal, all of B and all of C, with C6 prioritized — here's the recommended order:

**B (roadmap features):**

| Stage | Item | Effort | Status |
|-------|------|--------|--------|
| 1 | B1 — registry quick wins | 1 day | ✅ done — 110 nodes |
| 2 | B10 — pan/zoom, undo, multi-select | ~2 weeks | open |
| 3 | B2 — multi-output codegen | ~2 weeks | open — unlocks B3 |
| 4 | B3 — filter expansion | ~1 week per family | needs B2 |
| 5 | B9 — polyphony wrapper | ~3 days | open |
| 6 | B7 — visualization sinks | ~2 weeks | open |
| 7 | B5 — block-rate codegen | ~4 weeks | needs B2 |
| 8 | B6 — MIDI / host integration | ~3 weeks | needs IDE |
| 9 | B4 — composite library | ~3 weeks (or .gdsp community) | parallelizable |
| 10 | B8 — GPU compute | open-ended | needs B5 |

**C (meta / infrastructure):**

| Stage | Item | Effort | Status |
|-------|------|--------|--------|
| 1 | C6 — streaming LLM responses | ~2 days | ✅ done |
| 2 | C1 — CodeMirror 6 | ~1 day | open |
| 3 | C10 — git-friendly .gpatch | ~2 days | open |
| 4 | C8 — .gpatch examples library | ~1 week | open |
| 5 | C7 — community .gdsp library | ~1 week | open |
| 6 | C5 — smoke-compile validator | ~1 week | needs server |
| 7 | C3 — voice commands for actions | ~1 week | open |
| 8 | C2 — server-proxy AI provider | ~2 days | needs IDE |
| 9 | C9 — real-time audio preview | ~3 weeks | open |
| 10 | C4 — mobile gesture redesign | ~2 weeks | open |

**Reasoning for the order:** B1 first because pure value, zero risk. B10 second because the editor isn't pleasant without pan/zoom/undo and you'll feel friction immediately. B2 (multi-output) third because it unblocks B3, B7, dozens of nodes — biggest leverage per dollar. B5 before B6 because B6 needs IDE integration that doesn't exist yet. C6 first in C because you said it's your favorite and it's cheap. C1 (CodeMirror) immediately after because the textarea is genuinely painful for nontrivial .gdsp work.

**Llama 3.2 11B Vision deferred:** see the box at the top. Three blockers — the model isn't in MLC's converted-models list (issue #617, no movement); even simpler vision models (Phi-3.5, Gemma-3) currently fail to load in WebLLM (issue #727, October 2025); and the bundle would be ~6 GB on top of those upstream blockers. Editor's provider code is shaped to accept vision inputs once any of this changes. For local-vision today, the practical path is Ollama + a CORS relay (a fourth provider entry to add when you want it).

---

## Suggested decision frame

If you want **one thing to do next:** B1. It's pure value, zero risk, takes a day, and immediately makes the editor more capable.

If you want **the highest-leverage thing:** B2 (multi-output codegen). Two weeks of work that unlocks 30+ nodes across multiple categories.

If you want **the thing that would make this a real product:** C9 (real-time audio preview). The editor becomes a self-contained instrument once you can hear what you're patching.

If you want **the thing that helps your specific projects:** depends which project.
- For **Fly Away** (audio-reactive WebGL2): B7 (visualization sinks) for debugging the audio analysis side, B5 (block-rate / spectral) for the FFT-based reactivity, eventually B8 (GPU) for the visualizer compute.
- For **1-bite** (gate sequencer): B6 (MIDI/host) so the sequencer can be driven by your DAW, B9 (polyphony) for the multi-voice version.
- For **AlloLib Studio Online integration**: C2 (server-proxy AI) and C5 (smoke-compile validator) are exactly the things that make IDE integration smooth.

Pick whatever's interesting. I can build any of these, or break any of them down further if you want more detail before deciding.
