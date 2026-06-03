# Gamma Node Editor

A browser-native visual programming environment for real-time audio + visuals. Patches compile to [Gamma](https://github.com/AlloSphere-Research-Group/Gamma) DSP C++ on demand and run as live WebAssembly in the page. Single self-contained HTML file, no framework, no build step.

**[Try it live →](https://9livezzz-git.github.io/Gamma-Node/)**  ·  [Specification](SPEC.md)  ·  [Compile server](https://github.com/9LiveZZZ-Git/gamma-compile-server)

<!-- A screenshot or short GIF of the editor would belong here. -->

---

## What is it?

Drag nodes from a palette, wire them together, hit ▶ to compile and play. Around **210 built-in audio nodes** (synthesis, filters, dynamics, modulation, delays, reverbs, sampling, sequencing, analysis) plus a full **WebGPU visual layer** (shader-frag, 3D scenes, post-processing, video / webcam / screen-share input, hardware ray tracing on M-series Macs). An **AI panel** for authoring custom `.gdsp` nodes; **voice and handwriting** input; **touch + iPad** UX; a **live performance** mode. Saves to a JSON `.gpatch` and exports byte-stable C++ for [AlloLib](https://github.com/AlloSphere-Research-Group/allolib) projects.

Designed as the visual companion to [AlloLib Studio Online](https://allolib.dev) — beginners patch interactively without writing a `gam::` declaration by hand, advanced users use the editor as scaffolding before taking the generated code over, and live performers run the whole loop in-browser.

> **Optional power-up — hardware ray tracing.** On Apple Silicon (M-series), an optional native binary alongside the compile daemon runs real path-traced rendering (glass, mirrors, soft shadows via area lights, MetalFX TDS denoising + upscaling) and streams the result back into the editor as a regular texture. Falls back gracefully to the WebGPU raster path without it.

---

## Quick start

### 1. Try it in your browser (no install)

**[Open the live editor →](https://9livezzz-git.github.io/Gamma-Node/)**

Hit the **Demos** button in the top-right and pick one — **Audio Basic** (QWERTY-keyboard synth) or **Plasma + Clock** (audio-reactive visualizer) are good first picks. Click ▶ to compile + play.

A Chromium-based browser is recommended (Chrome, Edge, Brave, Arc) — the AI panel uses WebGPU and the real-time audio path needs cross-origin isolation (the bundled service worker handles that). **Safari 18+** works for everything except the local WebGPU-Gemma provider; the cloud Anthropic provider works fine there.

### 2. Run it locally

```bash
git clone https://github.com/9LiveZZZ-Git/Gamma-Node
cd Gamma-Node

# Either just open the file:
open    gamma-node-editor.html      # macOS — double-click works too
start   gamma-node-editor.html      # Windows
xdg-open gamma-node-editor.html     # Linux

# Or serve the directory (recommended — some features want a real origin):
python -m http.server               # http://localhost:8000/gamma-node-editor.html
```

### 3. Add the compile server for real-time audio

The browser-only path uses an in-browser WASM clang that handles trivial patches but reliably OOMs on Gamma's template-heavy headers (the in-browser clang hits a ~4 GB Wasm memory ceiling). For full audio with 5–15 s compile times, install the local [compile-server daemon](#real-time-audio--the-compile-server).

---

## What you can build

- **Synths** — wire `KeyboardIn` → oscillators → envelopes → filters → effects. Save the `.gpatch`, export the `.h` and drop it into your AlloApp.
- **Live visualizers** — WebGPU shader-frag nodes that react to audio amplitude + FFT bins + MasterClock pulses, composed and chained like any other graph.
- **3D scenes** — primitives + transforms + PBR / Phong / Unlit / Glass / Mirror materials + Directional / Point / Spot / Area lights. Hardware ray-traced on M-series Macs, rasterized everywhere else, with the same node graph driving both.
- **Games** — 2D + 3D Rapier physics, character controllers, sprites, prefabs, state machines, leaderboard nodes.
- **Gestural instruments** — webcam → MediaPipe hand / pose / face landmarks → audio params. The **2-Hand Theremin** demo is a worked example.
- **Live performance rigs** — multi-display dome / cylinder / cube projection with mesh warp + edge-blend + per-display calibration; iPad authors / triggers, Mac runs the audio + WebGPU rendering.

---

## Features at a glance

### Audio
- **~210 nodes**: oscillators (sine, saw, square, triangle, supersaw, 6 composite shapes, FM2 / FM4, wavetable scan), noise, envelopes (AD / AHD / ADSR + drawable `EnvDraw`), filters (Biquad, SVF, Moog ladder, Hilbert, formant), delays (PingPong, MultiTap, TempoSync, Haas), reverbs (Plate, Spring, FDN8, FM4), full dynamics (Compressor, Limiter, Expander, NoiseGate, Sidechain, Ducker, MultibandComp, OTT, UpwardComp), modulation (Tremolo, Vibrato, Flanger, Phaser4 / Phaser6, AutoPan), saturation (TubeSat, TapeSat, Diode), stereo utilities (MidSide, StereoWidener, MonoMaker, Pan2, HaasDelay), sample / mic / voice players, **MasterClock + StepSeq16 / 32 + EuclideanRhythm + Arp + AutomationLane**, analysis (envelope follower, pitch detector, RMS, FFT).
- **Real-time preview** — ▶ compiles the current patch to WebAssembly and routes it into an `AudioWorklet`. Monitor tab shows VU / scope / FFT / on-screen piano. `KeyboardIn` makes your QWERTY keyboard a one-octave instrument inside any patch.
- **Custom nodes via `.gdsp`** — write a C++ class with `// @gdsp-*` metadata comments and it joins the palette. Validate / save / submit-to-community from inside the editor.

### Visuals (WebGPU)
- **Shader-frag nodes**, generative — Plasma, Voronoi, NoiseShader, Gradient, Checkerboard, MeshTest, WireframeCalibration, GammaScreensaver, StarNest, Butterflies, Text.
- **Shader-frag nodes**, composition — BlendShader (6 modes incl. alpha-over), MaskShader, ColorCorrect, Pixelate, Posterize, EdgeDetect, Blur, FeedbackShader (ping-pong FBO).
- **3D primitives** — Box, Sphere, Cylinder, Capsule, Cone, Plane, Terrain, Capsule, GLB loader. Transforms (Translate, Rotate, Scale). Materials (UnlitMat, PhongMat, PhysicalMat, TerrainMaterial, ShaderMat, GlassMat, MirrorMat). Lights (DirectionalLight, PointLight, SpotLight, AreaLight, Sun, DayNightCycle). HDRI / Skybox / GradientSky / ProceduralSky environment.
- **Audio-reactive uniforms** — SAB → GPU uniform bridge. Master peak, 256 log-spaced FFT bins, MasterClock bar / beat / sixteenth / phase all addressable as `u_audio` from any shader-frag.
- **Texture inputs** — `Webcam`, `VideoFile`, `ScreenShare` (live media → texture), `HDRI` / `Skybox` (environment), `LoadGLB` (streamed meshes from the compile-server asset host).
- **Hardware ray tracing** (optional, M-series Mac) — `RayTracedScene` node renders true path tracing with MetalFX TDS denoise + upscale; falls back to the raster path everywhere else.
- **Custom `shader-frag` `.gdsp`** — write WGSL with `// @gdsp-*` metadata, ship it as a community node. Dynamic-WGSL bodies (`def.wgsl` as `(node) => string`) compile per-node.
- **Live mode** — `L` collapses the editor to a borderless full-screen canvas with audio still playing. Hide-graph (`H`) keeps panels and HUD but drops the node surface.

### AI panel — `.gdsp` co-authoring, vision input, voice
- **[Gemma 4](https://ai.google.dev/gemma)** local (E2B / E4B via Transformers.js + WebGPU) — no API key, no cloud. ~500 MB / 1.5 GB one-time download cached in IndexedDB.
- **[Anthropic Claude](https://www.anthropic.com/claude)** — cloud, user-supplied API key stored only in this browser.
- **`✎` Handwriting** → node spawning. Sketch a node name on the canvas; the matching node appears at the box location. Multi-tier cascade: shape gesture (circle → Button, line → Slider) → ink rasterizer → Tesseract OCR (confidence-gated) → multimodal VLM with structured-JSON classification → low-confidence top-3 correction chips. Supports chain syntax — writing `Sine | AD | Mul | Output` spawns and auto-wires all four.
- **`🎤` Voice** → AI prompt. Whisper-tiny transcription (~75 MB, English-only, WebAssembly) feeds the AI prompt for generate / modify / fix / explain.
- **`VoiceTrigger` + `KeywordSpotter`** nodes — in-patch voice activation with per-node trigger-word recording UI. Useful for live performance where the patch should react to spoken cues.

### Touch + iPad
- Pinch-zoom + two-finger pan (Maps-style anchor math).
- Long-press for an action menu — *Duplicate / Group / Delete* on nodes, *Duplicate / Ungroup / Delete* on collapsed groups.
- Wire-drop snaps to nearby compatible ports with hysteresis — tuned for fingertip imprecision.
- Apple Pencil routes to the handwriting tool, never to canvas hit-tests.
- LAN setup so an iPad on Wi-Fi can drive a Mac running the compile + ray-trace daemons.

### Live performance + distributed rig
- **Live mode** (`L`) and Hide-graph (`H`) for on-stage moments.
- **Multi-display rig** — up to 32 displays. Templates for single, side-by-side, quarter-wrap, half-wrap, full-wrap-16, cube, allosphere-like, allosphere-real.
- **Calibration** — mesh warp (Bourke / MPCDI / Bezier-patch authoring per Sajadi-Majumder), edge-blend with auto-overlap detection, per-display pose / FOV / keystone, AI-assisted iterative calibration (a vision API analyzes captured wireframes and proposes corrections).
- **Theater preview** — 3D explorable view of your rig with warp + blend rendered on the actual swept surface.

---

## Real-time audio — the compile server

The editor's ▶ button compiles the current patch to WebAssembly and routes the bytes into an `AudioWorklet` for live playback. Two compile paths:

1. **In-browser Wasmer clang** (default if no daemon is running). Works for trivial patches but reliably OOMs on Gamma's template-heavy headers — the in-browser clang hits a ~4 GB Wasm memory ceiling.
2. **Local compile daemon** (recommended). The [`gamma-compile-server`](https://github.com/9LiveZZZ-Git/gamma-compile-server) Express daemon runs on `127.0.0.1:8765`, drives a real Emscripten + Gamma toolchain on your machine, and returns the compiled Wasm in 5–15 seconds.

### Running the daemon

Requires **Node 20+** and **git** on your `PATH`.

```bash
# Coming soon (npm publish in progress):
npx @9livezzz/gamma-compile-server

# Until then, clone + run locally:
git clone https://github.com/9LiveZZZ-Git/gamma-compile-server
cd gamma-compile-server
npm install
node bin/gamma-compile-server.js
```

First run downloads ~700 MB (Emscripten SDK + Gamma source) into a per-OS cache directory. Subsequent runs start in seconds. Open the editor at <https://9livezzz-git.github.io/Gamma-Node/> and click ▶ — the editor auto-detects the daemon (status pill reads `local-cli detected`) and routes compile requests through it.

### CLI flags

```
gamma-compile-server [--port 8765] [--host 127.0.0.1]
                     [--allowOrigin <url>]... [--cacheDir <path>]
                     [--skipSetup] [--setupOnly]
```

Default cache directories:

| OS | Path |
|------|------|
| Windows | `%LOCALAPPDATA%\gamma-compile` |
| macOS   | `~/Library/Caches/gamma-compile` |
| Linux   | `~/.cache/gamma-compile` |

### Why a daemon

Native Emscripten produces full-fidelity Gamma builds in seconds on any dev machine; in-browser clang fundamentally can't, regardless of flag tuning. The daemon is the simplest fast path that keeps the editor itself a single static HTML file.

---

## Patching from an iPad / phone (LAN setup)

Real-time audio preview needs the compile daemon, and the daemon doesn't run on iOS. The workaround: run the daemon on a Mac or PC on the same network and point the iPad at it.

**On the host machine** (the one with the toolchain):

```bash
# 1. Start the daemon, opened to LAN, allow-listing the URL you'll serve
#    the editor from. Replace 192.168.1.42 with this machine's LAN IP
#    (`ipconfig getifaddr en0` on macOS, `ip a` on Linux, `ipconfig`
#    on Windows).
cd gamma-compile-server
node bin/gamma-compile-server.js \
  --host 0.0.0.0 \
  --allowOrigin "http://192.168.1.42:8000"

# 2. Serve the editor over plain HTTP from the same host. Browsers block
#    fetches from HTTPS pages (the GitHub Pages copy) to non-localhost
#    HTTP URLs, so we host the editor over HTTP too. In a separate
#    terminal:
cd Gamma-Node
python -m http.server 8000
```

**On the iPad / phone:**

1. Open `http://192.168.1.42:8000/gamma-node-editor.html` in Safari.
2. User DSP tab → ⚙ Settings → scroll to **Compile server**.
3. Set **Server URL** to `http://192.168.1.42:8765`, tap **Test connection** (should turn green with `✓ reachable v0.2.0`), tap **Save**.
4. Hit ▶ on a patch — compile routes through the host machine. Compile time stays the same as desktop.

> ⚠ `--host 0.0.0.0` exposes `/compile` to your LAN; the endpoint runs Emscripten on whatever C++ it receives. **Only do this on a trusted network** (your home Wi-Fi, not a coffee shop).

---

## Hardware ray tracing (optional, M-series Mac)

The editor has a `RayTracedScene` node that mirrors the regular raster `Scene` node's inputs (meshes, transforms, camera, lights, materials) but renders the result with **true path tracing** instead of rasterization — real refraction through `GlassMat`, real mirror chains through `MirrorMat`, real soft shadows from `AreaLight`, hardware-accelerated traversal, and Apple's MetalFX temporal denoiser + upscaler doing the cleanup.

The rendering itself happens in a separate native binary, `gamma-rt-engine` (Rust + Metal), that lives alongside `gamma-compile-server`. The editor talks to the engine over a local WebSocket and consumes the streamed frames as a regular `texture` output — so downstream nodes (BlendShader, CRT, post-processing, VisualOutput) consume it like any other layer.

### Hardware support

| GPU | RT path | Status |
|---|---|---|
| Apple M3 / M4 / M5 | Metal-RT hardware traversal + MetalFX denoise + upscale | Production-grade. Holds 60 fps at `preview` preset / 720p |
| Apple M1 / M2 | Metal-RT software traversal (MPS) + MetalFX | Preview-quality at `draft` preset. Software traversal is the bottleneck |
| Anything else | Falls back to raster `Scene` automatically | RT node displays a status-coded fallback color (no engine = dark navy; engine error = red) |

PC (NVIDIA / AMD / Intel Arc) Vulkan-RT support is planned but not yet shipped.

### Installing the engine

Requires **Rust 1.78+** and **Xcode Command Line Tools** (for the Metal SDK headers).

```bash
# The engine lives in the same repo as the compile daemon, in a sibling
# rt-engine/ directory. Clone, build, run:
git clone https://github.com/9LiveZZZ-Git/gamma-compile-server
cd gamma-compile-server
cargo build --release --manifest-path rt-engine/Cargo.toml

# Then start the engine. Two patterns work:
#
# A) Auto-spawn: just start the compile-server normally; it'll spawn
#    the engine as a child process on first /health probe.
node bin/gamma-compile-server.js
#
# B) Run separately (better for iterating on engine code — the engine
#    logs go to their own terminal, and you can Ctrl-C + restart the
#    engine without touching the compile-server).
#    Terminal 1:
cargo run --release --manifest-path rt-engine/Cargo.toml
#    Terminal 2:
node bin/gamma-compile-server.js
```

Engine listens on `ws://127.0.0.1:9100/`. The editor probes `/health` on the compile-server to discover the engine, then connects to the engine **directly** (Chrome's mixed-content rules explicitly allow `ws://` to loopback from `https://` origins).

### Quality presets

The `RayTracedScene` node has a `quality` dropdown that drives both samples-per-pixel and bounce depth:

| Preset | spp | bounces | What it's for |
|---|---|---|---|
| `draft` | 1 | 2 | Live editing. Intentionally grainy; TDS handles the bulk of the cleanup |
| `preview` | 4 | 4 | The default. "Looks OK in motion"; targets 60 fps at 720p on M4 |
| `final` | 16 | 8 | Render-grade. Multi-bounce, denoised. Use for stills + recorded video |

Plus a `displaySize` (480p / 600p / 720p / 900p / 1080p) and `renderScale` (`native` / `quality` / `balanced` / `performance` / `ultra`) pair — same DLSS/FSR convention. At `balanced` the kernel shades at 66 % of the display dim and MetalFX upscales to native; `performance` is 50 %, `ultra` is 35 %.

Try the **RT Quality Preset** demo from the demo browser to see all of these working together.

### Troubleshooting

- **Node viewport is dark navy:** engine isn't responding. Most likely the compile-server hasn't been started, or the engine binary isn't built. Check the compile-server's startup log.
- **Node viewport is dark crimson:** editor connected to the compile-server but couldn't reach the engine. Verify `gamma-rt-engine` is running on port 9100 (`lsof -i :9100` on macOS).
- **Node viewport is bright red:** the engine started, the WS connected, but the engine reported an error (shader compile failure, scene parse error, OOM). Open the browser console — the message is in `[rt-scene] engine error:` and the engine's stdout has the matching warn line.
- **Node viewport is amber:** WS closed unexpectedly; the editor will auto-reconnect within 2 s. Common after a `cargo build` if you forgot to restart the engine process.
- **"Port 9100 already in use; assuming external instance":** the compile-server saw an orphaned engine from a previous run. Kill it (`pkill gamma-rt-engine` or `lsof -ti :9100 | xargs kill`) and restart the compile-server so it spawns the fresh binary.

---

## Touch gestures reference

| Gesture | Effect |
|---|---|
| Single-finger drag on a node | Move it |
| Single-finger drag on an out-port | Draw a wire (snaps to nearby compatible input ports) |
| Single-finger drag on empty canvas | Marquee-select |
| **Long-press a node** (~½ s, hold still) | Pop the **action menu** above it: *Duplicate · Group · Delete*. Slide finger onto a chip and lift to commit, or release first and tap a chip. The Group chip shows only when ≥ 2 nodes are already selected. |
| **Long-press a group** (collapsed block or expanded header) | Same gesture, group-aware menu: *Duplicate · Ungroup · Delete*. Duplicate clones every member + the internal wiring; Ungroup dissolves the wrapper but keeps members; Delete wipes the group AND every node inside it. |
| Two-finger pinch | Zoom toward midpoint |
| Two-finger drag (with pinch) | Pan |
| Apple Pencil | Routes to handwriting / draw tool, never to canvas hit-tests |

Hover-to-preview affordances (e.g. tooltips on long node titles) don't fire on touch — tap to select instead; the properties pane shows the same info.

---

## Project files

| File | What it is |
|------|------------|
| `gamma-node-editor.html` | The editor. Single self-contained HTML file (HTML + inline CSS + vanilla JavaScript, no framework, no build step). |
| `coi-serviceworker.min.js` | Local copy of the COOP/COEP service worker that enables cross-origin isolation on GitHub Pages. Patched to bypass localhost so the daemon's `/compile` requests reach the loopback adapter. |
| `assets/gamma-wasm-v3.tar.gz` | Pre-built Gamma archive — fallback for the in-browser compile path. |
| `SPEC.md` | Canonical specification — file format, codegen algorithm, UX, AlloLib integration. |
| `VERSION` | Auto-bumped per push. |

## How codegen works (one-line version)

Topo-sort the graph from sinks back to sources, declare a C++ member for each stateful Gamma unit, inline math/conversion templates at use sites, and return a single expression from `operator()`. Same patch JSON always emits byte-identical C++. See `SPEC.md` §7 for the full algorithm.

## Status

**Audio (Phases 0–5):** feature-complete for v1. Codegen correctness, editor polish, User DSP UX, multi-output codegen, real-time audio preview via local daemon, master-clock + sequencing + automation. AI panel, voice / handwriting input, group nodes, full touch + iPad UX.

**Visuals (Phases 6–7 in progress):** WebGPU-native pipeline shipping in waves. Done so far: shader-frag nodes, audio-reactive uniforms, dynamic-WGSL `.gdsp` kind, video input + edit suite, 3D scene primitives + transforms + materials + lights, glass + mirror RT materials, hardware ray tracing via the optional `gamma-rt-engine` (Phase 7 §5.6 — Mac path complete with MetalFX denoise + upscale; PC Vulkan-RT path queued).

---

## Acknowledgments

### The foundation

**The [Gamma DSP library](https://github.com/AlloSphere-Research-Group/Gamma) was created by [Lance Putnam](https://github.com/LancePutnam)** at the [AlloSphere Research Group, UC Santa Barbara](https://github.com/AlloSphere-Research-Group). This editor is a visual layer on top of his work — every audible node in the palette is a wrapper around a Gamma class he wrote. **None of this exists without Gamma.** The [AlloLib](https://github.com/AlloSphere-Research-Group/allolib) framework provides the runtime substrate that compiled patches plug into; [AlloLib Studio Online](https://allolib.dev) is the parent project this editor was designed to be the visual companion to.

### Open-source libraries

- **[Three.js](https://threejs.org/)** — glTF / GLB loading and EXR decoding behind the `LoadGLB` and PBR-texture pipelines.
- **[Rapier](https://rapier.rs/)** ([@dimforge](https://github.com/dimforge)) — 2D + 3D physics simulation (rigid bodies, colliders, joints, raycasting, contact-force events) behind every Physics node.
- **[@huggingface/transformers](https://github.com/huggingface/transformers.js)** — Transformers.js, the in-browser runtime for Gemma 4 + Whisper-tiny inference.
- **[MediaPipe Tasks Vision](https://developers.google.com/mediapipe)** — Hand / Pose / Face / Blob Landmarker for the gesture and vision nodes (gesture-controlled synths, the 2-Hand Theremin).
- **[Tesseract.js](https://tesseract.projectnaptha.com/)** — OCR primary path for the `✎` handwriting tool.
- **[@wasmer/sdk](https://github.com/wasmerio/wasmer-js)** — in-browser WASM clang fallback for compile.
- **[Emscripten](https://emscripten.org/)** — the toolchain the local compile-server drives to produce Gamma audio bytes.
- **[CodeMirror 5](https://codemirror.net/5/)** — the User DSP code editor.
- **[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)** — cross-origin isolation on GitHub Pages (a requirement for the `SharedArrayBuffer`-based audio path).

### AI models

- **Google [Gemma 4](https://ai.google.dev/gemma)** (E2B / E4B) — local LLM for `.gdsp` generation, vision (handwriting), and audio (speech-to-text). Runs entirely in-browser via Transformers.js + WebGPU.
- **Anthropic [Claude](https://www.anthropic.com/claude)** — optional cloud LLM (user-supplied key).
- **OpenAI [Whisper-tiny](https://github.com/openai/whisper)** — legacy speech-to-text fallback for the `🎤` voice tool, via Transformers.js.
- **Google MediaPipe** Hand / Pose / Face Landmarker models — on-device vision behind the gesture nodes.

### Asset libraries

- **[Poly Haven](https://polyhaven.com/)** — CC0 HDRIs, PBR texture sets, and models used in the PBR / lighting / hidden-alley demos.
- **[m3-org/base-meshes](https://github.com/m3-org/base-meshes)** — CC0 base-mesh library (apple, acorn, anvil, axe, …) used in the GLB Asset Test demo.
- **[SpectraStudios/SourceCityToolkit_glb](https://github.com/SpectraStudios/SourceCityToolkit_glb)** — modular city / urban building GLBs.

### Algorithms & papers

The editor implements (or stands on the shoulders of) the following published work:

- **HEALPix sphere pixelization** — Górski et al. 2005, *ApJ* 622:759, [10.1086/427976](https://doi.org/10.1086/427976) — default Checkerboard cell mode on curved screens.
- **Bezier-patch projector warp authoring** — Sajadi & Majumder, *IEEE TVCG* 2012 — the smooth-warp mode in the calibration editor.
- **Quadric image transfer for projection mapping** — Raskar et al., *IEEE CG&A* / *CVPR* — informs the two-pass render approach for 3D scenes on curved screens.
- **Gnomonic projection math** — Snyder, USGS *Professional Paper 1395*; Blinn, *IEEE CG&A* 1988 — basis of the per-fragment frag-to-global angle math for AlloSphere boundary correctness.
- **$P point-cloud gesture recognizer** — Vatavu, Anthony, Wobbrock — basis of the (currently experimental) offline stroke matcher in the handwriting cascade.
- **Position-based dynamics** — Müller, Heidelberger, Hennix, Ratcliff — basis of the Verlet + distance-constraint `Rope3D` / `Cloth3D` / `SoftBody3D` nodes.

### Historical / inspirational

- **[Léon Theremin](https://en.wikipedia.org/wiki/L%C3%A9on_Theremin)** (1920) — the original two-hand gestural-pitch instrument the gesture-theremin demo descends from.
- **The Demoscene** — the Plasma / Voronoi / Tunnel / StarNest / Butterflies shader-frags are direct ports and tributes; StarNest is a port of Pablo Roman Andrioli's Shadertoy.

---

## License

To be decided. Until a license is published, the code is © the author; this repository is public for evaluation and demonstration. Open an issue if you need clarity on a specific use case.
