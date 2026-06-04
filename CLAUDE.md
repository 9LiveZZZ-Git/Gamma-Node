# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

This is a **single-file web application** built from a `src/` tree by a zero-dependency `build.mjs`. The shipped/Pages/emailable artifact is the single `gamma-node-editor.html` at the repo root; the source you edit lives under `src/`. No package manager, no test runner, no lint config. External libraries (`@huggingface/transformers`, `three`, `@dimforge/rapier3d-compat`, etc.) are pulled from a CDN via dynamic `import()` at runtime when the relevant feature is first used.

**Workflow:**

```
src/shell.html             HTML skeleton with INLINE_CSS, INLINE_JS, APP_VERSION placeholders
src/styles/app.css         CSS (one file today; can be split by area later)
src/build-order.json       concatenation order manifest (read by build.mjs)
src/<subsystem>/*.js       all editor JS, organized by subsystem (see tree below)
VERSION                    root file = source of truth for APP_VERSION
build.mjs                  read manifest -> concat -> inline -> write gamma-node-editor.html
```

The src/ tree (~99k lines / 90 .js files + 3 WGSL shader files across 14 subsystems):

```
src/
  shell.html                  HTML skeleton + placeholder tokens
  build-order.json            ordered manifest of every .js file
  styles/app.css              all CSS, inlined into one <style>
  core/         (6)           preamble + state-decl + state-helpers
                              + undo-redo + state (groups/reset/makeNode
                              + DOM refs + udsp text) + wire-eval
  nodes/        (4)           registry, gdsp, colors, category-order
  codegen/      (1)           exprFor + gatherHeaders + inputExpr + generateCode
  demos/        (1)           _demos array
  hwr/          (1)           handwriting recognition (touchscreen, $P, Tesseract,
                              VLM, matcher, chips, tryCreateFromLabel)
  physics/      (4)           rapier (2D + 3D Rapier integration), destruct-pbd
                              (Voronoi fracture + rope/cloth/soft PBD), controllers
                              (TPC + BlobController3D), game-inputs (KeyAxis2D,
                              PlatformerBody2D, Pickups, LevelGoals)
  planet/       (2)           index (cells + biomes + climate + rivers + verbs +
                              Earth DEM core), runtime (SVT + chunks + mesh + LUTs)
  rig/          (11)          pane, warp-editor, gizmo, calibration, warp-data,
                              iterative-calib, importers, auto-warp, tile-layout,
                              templates, surface
  visual/       (29)          rendering subsystem -- see "Visual subsystem" below
    shaders/    (3)           mesh.wgsl.js, sprite.wgsl.js, atmosphere.wgsl.js
  audio/        (5)           osc-in, osc-out, preview, voice-input, keyword-spotter
  ai/           (1)           settings (PROVIDERS map + AI assistant UI)
  ui/           (22)          panes, modals, browsers, palette, render, props,
                              tabs, capture, modes, etc.
  persistence/  (2)           export (WAV / HTML / .gpatch), patch-load
  assets/       (2)           registry (samples + sprites + folders), parallax-bg
```

To edit: change files under `src/`, run `node build.mjs`, commit BOTH the `src/` changes AND the regenerated `gamma-node-editor.html`. **Don't hand-edit `gamma-node-editor.html`** — it's a build artifact (regeneration will overwrite hand edits). The `<!-- GENERATED FROM src/ -->` comment at the top of the built file is the reminder.

**Concatenation-bundle model.** Every file in `build-order.json` is concatenated in order into one `<script>` block. There are no `import`/`export` statements between subsystem files; they all share one global scope at runtime. A function in `src/visual/scene-pass.js` calls `_buildRenderPlan` from `src/visual/render-plan.js` by bare name, just as it did when both lived in one file. This is intentional — it preserves the original code's structure and makes pure-relocation splits trivial to verify. The cost is that you can't `import` from these files individually (they're not ES modules); the win is that the editor stays a single emailable HTML artifact with zero runtime dependencies.

**The byte-identical invariant.** Moving code between files (further peeling, reorganizing) must be a *pure relocation* — never reorder, rewrite, or split a function across files. After a pure relocation, `node build.mjs` must regenerate a `gamma-node-editor.html` byte-identical to the pre-relocation one (modulo the APP_VERSION token). `git diff gamma-node-editor.html` should be empty. A non-empty diff after a "relocation" commit means the relocation was wrong. Code *changes* are a separate kind of commit from relocations, with a reviewable diff. See `docs/MODULARIZATION.md` §4 + §7 for the full safety contract.

The 74 byte-identical relocations in the M0–M2.14 series (~v0.3.620 → v0.3.686, monolith fully dismantled) all followed this contract; the extractor scripts that did them live in `scripts/m*-extract.mjs` as worked examples of the brace-counter + template-aware cut algorithm.

**Running it:** open `gamma-node-editor.html` in a Chromium-based browser (Chrome/Edge for WebGPU). For local development, just double-click the file or serve the directory with any static server (`python -m http.server`, `npx serve`, etc.). No install step.

**Design docs live locally in `docs/` and are gitignored** — they are not part of the public repo. Reference them when present:

- `docs/ROADMAP.md` — **active roadmap and direction**. Read this first if it exists; it supersedes the older docs on direction questions. As of 2026-05-03 the editor is on a Stance-B trajectory: self-contained visual programming environment for audio + shaders + 3D + video + sequencing, with AlloLib export as a feature (not the canonical path). The README still says "visual patcher for Gamma DSP" — that's a deliberate lag until visual phases ship.
- `docs/SPEC.md` — original specification, written when the editor was Stance A (AlloLib scaffolding). Still authoritative for §§4–10 (file format, codegen, basic UX). Sections that talk about "intended deliverable" are out of date — see ROADMAP for current direction.
- `docs/EXPANSION.md` — original forward-looking node/feature list. Largely subsumed by ROADMAP phases 4+; still useful as a reference for which Gamma classes haven't been wrapped yet.
- `docs/OPTIONS.md` — original decision menu. Check the status box at top.
- `docs/UNSLOTH-WORKFLOW.md` — step-by-step recipe for fine-tuning Gemma 4 on a `.gdsp` corpus and deploying the result to the editor's AI panel via ONNX export + transformers.js. Not yet executed; the user expressed interest in Unsloth's models specifically — they're for fine-tuning workflows, not direct browser inference, so we'd convert them through `optimum`. Read this before doing any fine-tune work.
- `docs/LLM-KNOWLEDGE-PHASE.md` — **major roadmap branch locked 2026-06-04.** Plan for a 27-sprint LLM + knowledge-management phase covering: (A) shared foundations (new `vector` + `llm-attn` port types, `llm-op`/`llm-sink`/`llm-viz`/`notes-source` node kinds), (B) Ollama integration (5 MVP + 6 stretch nodes, local + cloud variants), (C) **Tektite MD** (in-house markdown PKM + 14 visualization modes, replaces nothing externally — fully unifies notes + patches + .gdsp + assets + demos into one interactive graph), (D) LLM-from-scratch nodes (37 nodes for building/training a transformer in the editor with WebGPU autograd + a port of `LLMAttention3D.jsx` as a 3D attention viz node). Read this before starting any LLM-related work; it supersedes ROADMAP and is the active direction.

If `docs/` is missing, work from this CLAUDE.md plus the code; don't assume the docs exist on every machine.

When the spec and the prototype disagree, **the prototype is what users actually use**, but the spec is what they expect the prototype to *become*. Make changes that move the prototype toward the spec, not away from it.

## Architecture: graph → C++ codegen

The editor is a graph editor whose *output* is C++ code, not audio. There is no runtime graph interpreter. Codegen runs in JavaScript at save time; the emitted header is what the user compiles to WebAssembly via AlloLib Studio Online's existing pipeline.

The single most important data structure is the **node type registry** (`const TYPES`, defined in `src/nodes/registry.js`). Every supported Gamma class is one entry. Adding new node coverage usually means adding a registry entry — no codegen changes needed — provided the node fits one of the two existing shapes:

- **Member nodes** (`cppType` non-empty, e.g. `"gam::Sine<>"`): emit a class member, initialize params in the constructor via the `methods` map (param-name → Gamma setter name), and emit `id(in_expr)` or `id()` at use sites.
- **Template nodes** (`cppType: ""`, `template` provided): emit no member. The `template` string is inlined at every use site with `{portName}` / `{paramName}` substituted. All math/conversion/logic primitives are this shape — that's why Wave 1 of EXPANSION.md added 60 nodes in a day.

Codegen lives in `src/codegen/index.js` (`exprFor` + `gatherHeaders` + `inputExpr` + `generateCode` + `node_methods`). The pipeline: topo-sort from sinks, emit declarations for member nodes, emit ctor body, emit exposed setters, emit per-sample setter calls for param-rate edges, then recursively build the return expression from the `Output`/`OutputStereo` sink. Substituted expressions are wrapped in defensive parens to preserve precedence — the redundant parens in generated C++ are intentional, the compiler removes them.

Read `SPEC.md` §5 (registry shape) and §7 (codegen algorithm) before touching anything in the registry or codegen path. §10 (feedback loops via `Delay1`) explains why cycles are rejected unless they pass through a one-sample delay.

## Two file formats to keep straight

- **`.gpatch`** — JSON, the patch document (nodes, edges, params, exposed setters). Spec §4. The editor saves/loads this; codegen emits a `{name}.h` from it. The `.gpatch` is source of truth, the `.h` is a build artifact. Load path lives in `src/persistence/patch-load.js` (`_applyLoadedPatch`); save / HTML / WAV exports are in `src/persistence/export.js`.
- **`.gdsp`** — C++ class with `// @gdsp-*` metadata comments declaring inputs/outputs/params. Lets users define custom nodes that join the palette alongside the built-in registry. Parsed by `parseGdsp` / `buildUserDspDef` in `src/nodes/gdsp.js`. Stored in `localStorage` under `gamma-editor-userdsp-v1`.

## AI panel (User DSP tab)

Provider-agnostic via the `PROVIDERS` map in `src/ai/settings.js`. Two backends:

- **`gemma`** (default) — Gemma 4 E4B via `@huggingface/transformers` + WebGPU, runs locally. Handles text, image (handwriting recognition), and audio (speech-to-text). ~1.5 GB initial download cached in IndexedDB.
- **`anthropic`** (optional) — Claude via the Anthropic API, user-supplied key stored in `localStorage` under `gamma-editor-ai-settings-v1`. Uses `anthropic-dangerous-direct-browser-access: true` for browser CORS.

The system prompt for `.gdsp` generation is built fresh from `gdspFormatSpec()` rather than hardcoded — keep it that way so the prompt stays in sync with what `parseGdsp` actually accepts.

## Visual subsystem (`src/visual/`)

WebGPU pipeline organized into 29 files (plus 3 `.wgsl.js` shader strings):

- **Core + namespace**: `core.js` (`const Visual` device / context / cache singleton), `framebuffer.js` (FBO + blit pipeline), `projection.js` (resolution + projection + rig composite encoder).
- **Pipelines**: `pipelines.js` (ShaderMat + mesh pipeline cache + HDRI), `sprite-sky.js` (sprite + sky), `rig-composite-pipeline.js`, `warp-pipeline.js`, `theater-pipeline.js`, `mesh-cache.js`, `mesh-builders.js`, `scene-builders.js`.
- **Render plan + pass encoders**: `render-plan.js` (`_buildRenderPlan` — per-VO scratch-slot allocator), `scene-pass.js` (`_encodeScenePass` — the big 3D pass), `shader-frag-pass.js` (composition passes), `theater-pass.js`, `rt-scene.js` (RayTracedScene WS client).
- **Render loop + perf**: `render-loop.js` (`renderVisualFrame`), `render-loop-controls.js` (start/stop), `perf.js` (MSAA + counters), `perf-overlay.js` (HUD + blit + fnv1a).
- **Sources + cameras**: `video-sources.js` (video + MediaPipe Hand/Pose/Face/HandKeyboard/BlobTracker), `fp-cameras.js`, `minimap-altimeter.js`, `scene-graph.js` (mat4 family + camera evaluation + transforms + Level2D/Tilemap2D expansion + _encodeShaderFragPassForVO + _encodeVisualGraph).
- **Atmosphere + shader cache**: `atmosphere.js` (LUT renderer), `shader-cache.js` (audio + clock uniforms + shader layouts + pipeline cache + instance).
- **Shaders**: `shaders/mesh.wgsl.js` (~160 KB — struct Light + struct PerScene + struct PerDraw, one vertex shader + three fragment entry points), `shaders/sprite.wgsl.js`, `shaders/atmosphere.wgsl.js`.

## Ray-tracing engine (Phase 7 §5.6)

`RayTracedScene` is a sink node implemented in `src/visual/rt-scene.js` that streams frames from a separate native binary — `gamma-rt-engine` (Rust + Vulkan-RT or Metal-RT), shipped in a sibling `rt-engine/` directory inside the `gamma-compile-server` monorepo, **not** in this checkout. The editor opens a WS to the engine, sends an initial scene patch, then per-frame diff patches (materials / lights / camera / quality) as the user drags sliders. Frames come back H.264-encoded, decoded via WebCodecs into a `GPUTexture` downstream nodes consume like any other texture.

Design doc: `docs/RAYTRACING.md`. Sprint tags `7.5.6.a`–`7.5.6.h` track the phases. As of 2026-05-14 we're in **§5.6.f (denoising)** — engine-side `MTLFXTemporalDenoisedScaler` work is underway (see RAYTRACING.md for the four required aux textures + depth/jitter conventions). Editor's role this sprint: the Tier-5 quality WS patch in `src/visual/rt-scene.js` (`_rtScenePollAndSend`) resolves the `quality` preset (draft/preview/final → 1/4/16 spp, 2/4/8 bounces per §5.6.g) and ships it per frame. Extra samples at higher presets target edge / disocclusion noise that TDS history validation can't clear on its own.

When editing: engine code lives in the other repo. In this checkout you can only change the editor-side protocol and the spec doc. When a commit references engine behavior, trust the spec doc + the sprint tag, not the local code.

## Conventions worth preserving

- **No build step, no dependencies on disk.** Don't introduce npm/yarn/bundler tooling without an explicit reason. The "single HTML file you can email someone" property is load-bearing.
- **Vanilla JS, no framework.** DOM is mutated directly via `getElementById` and string templates. Don't introduce React/Vue/etc.
- **Codegen output must remain human-readable.** Advanced users are expected to take the generated `.h` over and edit it by hand (SPEC §1.1). Defensive parens around substituted expressions are fine; cryptic minified output is not.
- **Registry entries are hand-curated, not generated.** Method names (`methods` map) come from inspecting Gamma headers. SPEC §5 "Verification status" lists entries built from header inspection that may need fixing on first compile — fix the registry entry, don't patch the generated code.
