# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

This is a **single-file web application**, not a typical Node project. There is no build, no package manager, no test runner, no lint config. Everything ships in `gamma-node-editor.html` (~3700 lines: HTML + inline CSS + inline vanilla JS, no framework). External libraries (`@huggingface/transformers`) are pulled from a CDN via dynamic `import()` at runtime when the AI panel is first used.

**Running it:** open `gamma-node-editor.html` in a Chromium-based browser (Chrome/Edge for WebGPU). For local development, just double-click the file or serve the directory with any static server (`python -m http.server`, `npx serve`, etc.). No install step.

**Design docs live locally in `docs/` and are gitignored** — they are not part of the public repo. Reference them when present:

- `docs/ROADMAP.md` — **active roadmap and direction**. Read this first if it exists; it supersedes the older docs on direction questions. As of 2026-05-03 the editor is on a Stance-B trajectory: self-contained visual programming environment for audio + shaders + 3D + video + sequencing, with AlloLib export as a feature (not the canonical path). The README still says "visual patcher for Gamma DSP" — that's a deliberate lag until visual phases ship.
- `docs/SPEC.md` — original specification, written when the editor was Stance A (AlloLib scaffolding). Still authoritative for §§4–10 (file format, codegen, basic UX). Sections that talk about "intended deliverable" are out of date — see ROADMAP for current direction.
- `docs/EXPANSION.md` — original forward-looking node/feature list. Largely subsumed by ROADMAP phases 4+; still useful as a reference for which Gamma classes haven't been wrapped yet.
- `docs/OPTIONS.md` — original decision menu. Check the status box at top.

If `docs/` is missing, work from this CLAUDE.md plus the code; don't assume the docs exist on every machine.

When the spec and the prototype disagree, **the prototype is what users actually use**, but the spec is what they expect the prototype to *become*. Make changes that move the prototype toward the spec, not away from it.

## Architecture: graph → C++ codegen

The editor is a graph editor whose *output* is C++ code, not audio. There is no runtime graph interpreter. Codegen runs in JavaScript at save time; the emitted header is what the user compiles to WebAssembly via AlloLib Studio Online's existing pipeline.

The single most important data structure is the **node type registry** (`TYPES`, defined around `gamma-node-editor.html:1056`). Every supported Gamma class is one entry. Adding new node coverage usually means adding a registry entry — no codegen changes needed — provided the node fits one of the two existing shapes:

- **Member nodes** (`cppType` non-empty, e.g. `"gam::Sine<>"`): emit a class member, initialize params in the constructor via the `methods` map (param-name → Gamma setter name), and emit `id(in_expr)` or `id()` at use sites.
- **Template nodes** (`cppType: ""`, `template` provided): emit no member. The `template` string is inlined at every use site with `{portName}` / `{paramName}` substituted. All math/conversion/logic primitives are this shape — that's why Wave 1 of EXPANSION.md added 60 nodes in a day.

Codegen lives in `exprFor` (around `gamma-node-editor.html:2118`) and the surrounding helpers (`gatherHeaders`, `inputExpr`, etc.). The pipeline: topo-sort from sinks, emit declarations for member nodes, emit ctor body, emit exposed setters, emit per-sample setter calls for param-rate edges, then recursively build the return expression from the `Output`/`OutputStereo` sink. Substituted expressions are wrapped in defensive parens to preserve precedence — the redundant parens in generated C++ are intentional, the compiler removes them.

Read `SPEC.md` §5 (registry shape) and §7 (codegen algorithm) before touching anything in the registry or codegen path. §10 (feedback loops via `Delay1`) explains why cycles are rejected unless they pass through a one-sample delay.

## Two file formats to keep straight

- **`.gpatch`** — JSON, the patch document (nodes, edges, params, exposed setters). Spec §4. The editor saves/loads this; codegen emits a `{name}.h` from it. The `.gpatch` is source of truth, the `.h` is a build artifact.
- **`.gdsp`** — C++ class with `// @gdsp-*` metadata comments declaring inputs/outputs/params. Lets users define custom nodes that join the palette alongside the built-in registry. Parsed by `parseGdsp` / `buildUserDspDef` (around `gamma-node-editor.html:1656`). Stored in `localStorage` under `gamma-editor-userdsp-v1`.

## AI panel (User DSP tab)

Provider-agnostic via the `PROVIDERS` map (around `gamma-node-editor.html:2700`). Two backends:

- **`gemma`** (default) — Gemma 4 E4B via `@huggingface/transformers` + WebGPU, runs locally. Handles text, image (handwriting recognition), and audio (speech-to-text). ~1.5 GB initial download cached in IndexedDB.
- **`anthropic`** (optional) — Claude via the Anthropic API, user-supplied key stored in `localStorage` under `gamma-editor-ai-settings-v1`. Uses `anthropic-dangerous-direct-browser-access: true` for browser CORS.

The system prompt for `.gdsp` generation is built fresh from `gdspFormatSpec()` rather than hardcoded — keep it that way so the prompt stays in sync with what `parseGdsp` actually accepts.

## Conventions worth preserving

- **No build step, no dependencies on disk.** Don't introduce npm/yarn/bundler tooling without an explicit reason. The "single HTML file you can email someone" property is load-bearing.
- **Vanilla JS, no framework.** DOM is mutated directly via `getElementById` and string templates. Don't introduce React/Vue/etc.
- **Codegen output must remain human-readable.** Advanced users are expected to take the generated `.h` over and edit it by hand (SPEC §1.1). Defensive parens around substituted expressions are fine; cryptic minified output is not.
- **Registry entries are hand-curated, not generated.** Method names (`methods` map) come from inspecting Gamma headers. SPEC §5 "Verification status" lists entries built from header inspection that may need fixing on first compile — fix the registry entry, don't patch the generated code.
