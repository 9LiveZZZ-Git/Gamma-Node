# Gamma Node Editor — Specification

A visual patching environment for the Gamma synthesis library, integrated into AlloLib Studio Online. Patches authored in the node editor compile down to plain Gamma C++ that drops directly into an `AlloApp`.

---

## 1. Overview

Gamma is a sample-by-sample DSP library. Every unit (`Sine`, `AD`, `Biquad`, `Delay`, …) is a stateful C++ object with an `operator()` that pulls one sample, plus parameter setters. The node editor exposes that vocabulary as a graph: nodes are units, wires are signal flow, and the patch compiles to a single C++ class that the user instantiates inside their AlloApp's `onSound()`.

There is no runtime graph interpreter. Codegen runs in JavaScript at save time; the resulting C++ is what actually compiles to WebAssembly. The graph is gone by the time the build kicks off.

### 1.1 Audience

Students working in MAT201 and AlloSphere researchers using AlloLib Studio Online. Two distinct flows:

- **Beginners** patch interactively, copy generated C++ into their main file, and never write a `gam::` declaration by hand.
- **Advanced users** treat the editor as scaffolding — patch a rough idea visually, then drop into the generated code and edit by hand.

Both flows must be served by the same tool.

### 1.2 Deliverable surface

- A modal/popup React component embedded in AlloLib Studio Online's IDE.
- A `.gpatch` file type recognized by the project tree.
- Two invocation paths from the IDE: open a `.gpatch` file, or "Insert Gamma patch" from the command palette.

---

## 2. Goals and non-goals

### Goals

- Cover the ~50 most-used Gamma classes through hand-curated node descriptors.
- Round-trip without information loss: `(JSON ↔ editor)` and `(JSON ↔ C++)` must both be lossless in the JSON → other direction.
- Deterministic codegen. Same patch JSON always emits byte-identical C++.
- Generated C++ must be human-readable enough that an advanced user can take it over.
- Zero new C++ runtime. Only Gamma + the existing AlloLib build pipeline.

### Non-goals (V1)

- Generic dataflow editor. This is Gamma-specific; the type system, codegen, and palette are all hand-fitted to Gamma's idioms.
- Live audio inside the editor itself. The editor generates code; AlloLib's existing build/run pipeline produces the audio.
- Visual programming for graphics or control logic. Audio only.
- Custom DSP nodes (user-defined node types). Deferred to V2.
- Modulation matrices, macro controls, or preset banks. The exposed-parameter mechanism is enough for V1.

---

## 3. Invocation modes

### 3.1 File mode (canonical)

`.gpatch` files live in the project tree. Double-click opens the editor in a modal. The modal owns the file. On save (`Cmd/Ctrl-S`):

1. The editor writes the JSON back to the `.gpatch` file.
2. The editor emits a sibling header file at `generated/{name}.h` (path configurable per-project).
3. The IDE's file watcher picks up the new header; the next build pulls it in.

User C++ that consumes the patch:

```cpp
#include "generated/MyPatch.h"

struct App : al::App {
    MyPatch patch;
    void onSound(AudioIOData& io) override {
        while (io()) io.out(0) = patch();
    }
};
```

The `.gpatch` JSON is the source of truth. The `.h` is a build artifact; deleting it and rebuilding regenerates it.

### 3.2 Insert mode (one-off)

From the command palette: **Gamma: Insert patch at cursor**. Opens the same editor in a modal, no associated file. On accept, the editor pastes the generated class body at the cursor wrapped in marker comments:

```cpp
// @gamma-patch-begin {"version":1,"nodes":[...],"edges":[...],"exposed":{...}}
class MyPatch {
    gam::Sine<>  n1;
    gam::AD<>    n2;
    gam::Biquad<> n4;
public:
    MyPatch() { /* … */ }
    void freq(float v) { n1.freq(v); }
    void trigger()     { n2.reset(); }
    float operator()() {
        return n4((n1() * n2()));
    }
};
// @gamma-patch-end
```

If the user later puts the cursor between the markers and reinvokes the command, the editor opens preloaded from the embedded JSON. Round-trip works because the JSON rides along in comments.

The IDE must lock the region between the markers against manual edits, or warn on save that hand-edits will be overwritten on next round-trip. Recommended: a soft warning, not a hard lock — advanced users may want to take over the generated code.

---

## 4. File format: `.gpatch` (JSON)

```json
{
  "version": 1,
  "patchName": "MyPatch",
  "filename": "MyPatch.gpatch",
  "nodes": [
    {
      "id": "n1",
      "type": "Sine",
      "x": 40,
      "y": 60,
      "params": { "freq": 220 }
    }
  ],
  "edges": [
    { "from": { "node": "n1", "port": "out" },
      "to":   { "node": "n3", "port": "a"   } }
  ],
  "exposed": {
    "n1.freq": true,
    "n2.trig": true
  }
}
```

### Field rules

- **`version`** (int, required). Starts at 1. Bumped on any non-additive schema change. Loader rejects unknown major versions.
- **`patchName`** (string, optional). Defaults to filename stem. Used as the generated class name. Must be a valid C++ identifier; loader sanitizes by replacing non-alphanumeric chars with `_`.
- **`filename`** (string, optional). Display name. The prototype writes this on save; the canonical loader uses the actual file path it's reading from and ignores this field.
- **`nodes[]`**. Each node has `id` (string, unique within the patch), `type` (must be in the registry), `x`/`y` (numbers, in canvas pixel space), and `params` (object, only keys declared in the type's params schema).
- **`edges[]`**. Each edge has `from` and `to`, each with `node` (id reference) and `port` (port name from the type definition).
- **`exposed`** (object). Keys are `"{nodeId}.{portOrParam}"`. Truthy values mean expose-as-setter (or `trigger()` for gate inputs). Absent or falsy means the parameter is fixed at its `params` value.

### Reserved (not emitted by the V1 prototype)

These are fields the canonical loader should accept but ignore if missing, and that the editor will start emitting in later versions:

- **`rate`** (`"sample" | "block"`, default `"sample"`). Whether the generated `operator()` returns one sample or fills a block. The V1 prototype is sample-rate only.
- **`view`** (`{ pan: {x,y}, zoom: number }`). Editor camera position. The V1 prototype doesn't yet implement pan/zoom and so doesn't persist camera state.

### Backwards-compat policy

- New fields may be added freely; older loaders ignore them.
- Node `type` removals require a migration in the loader (rename map).
- Param renames within a type require a migration in the loader (key rename).
- Migrations are versioned; the loader applies them in order.

---

## 5. Node type registry

Every Gamma class supported by the editor has a hand-written descriptor:

```ts
type NodeType = {
  category:     "Oscillator" | "Noise" | "Envelope" | "Filter" | "Delay"
              | "Effect" | "Analysis" | "Convert" | "Math" | "Sink";
  color:        string;             // hex, drives strip + palette dot + wire colour
  header:       string | null;      // Gamma/<header>.h to include; null for math/sink/inline
  description:  string;             // tooltip + properties-pane summary

  // For "member" nodes (most stateful Gamma units)
  cppType:      string;             // e.g. "gam::Sine<>"; "" for template/inline nodes
  ins:          { n: string; t: "audio" | "param" | "gate" }[];
  outs:         { n: string; t: "audio" | "param" | "gate" }[];
  params:       Record<string, number>;        // default values (used in ctor + UI)
  methods?:     Record<string, string>;        // param-name → Gamma setter name
  gateMethods?: Record<string, string>;        // gate-port → method on trigger ("reset" default)
  extraCtor?:   string[];                      // raw lines emitted in ctor; "{id}" interpolated

  // For "template" nodes (math / conversion / sink / Const — no member declared)
  template?:    string;             // inline C++ expression with {portName} / {paramName} placeholders
};
```

The registry has two species. **Member nodes** (`cppType` non-empty) declare a class member, initialize it in the ctor via the `methods` map, and emit `id(in)` or `id()` at use sites. **Template nodes** (`cppType` empty, `template` provided) emit no member; their template substitutes `{portName}` for the upstream expression of each input port and `{paramName}` for the literal param value, with the result wrapped in parens to preserve operator precedence.

Examples of each:

```ts
// Member node — Biquad lowpass
BiquadLP: {
  category:    "Filter",
  color:       "#1d9e75",
  header:      "Filter",
  description: "Biquad lowpass",
  cppType:     "gam::Biquad<>",
  ins:         [{n:"in", t:"audio"}, {n:"cutoff", t:"param"}, {n:"q", t:"param"}],
  outs:        [{n:"out", t:"audio"}],
  params:      { cutoff: 1200, q: 1.4 },
  methods:     { cutoff: "freq", q: "res" },
  extraCtor:   ["{id}.type(gam::LOW_PASS);"]
}

// Member node with two distinct gate methods — ADSR
ADSR: {
  category:    "Envelope",
  color:       "#d8a030",
  header:      "Envelope",
  description: "Attack-Decay-Sustain-Release envelope",
  cppType:     "gam::ADSR<>",
  ins:         [{n:"trig", t:"gate"}, {n:"rel", t:"gate"}],
  outs:        [{n:"out", t:"audio"}],
  params:      { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.4, amp: 1 },
  methods:     { attack: "attack", decay: "decay", sustain: "sustain",
                 release: "release", amp: "amp" },
  gateMethods: { trig: "reset", rel: "release" }
}

// Template node — MIDI to frequency
MtoF: {
  category:    "Convert",
  color:       "#6dc5b5",
  header:      null,
  description: "MIDI note → frequency (Hz)",
  cppType:     "",
  ins:         [{n:"in", t:"audio"}],
  outs:        [{n:"out", t:"audio"}],
  params:      {},
  template:    "gam::scl::mtof({in})"
}

// Template node — multiply two signals
Mul: {
  category:    "Math",
  color:       "#888780",
  header:      null,
  description: "Multiply two signals",
  cppType:     "",
  ins:         [{n:"a", t:"audio"}, {n:"b", t:"audio"}],
  outs:        [{n:"out", t:"audio"}],
  params:      {},
  template:    "({a} * {b})"
}
```

### V1 node coverage

| Category   | Count | Nodes |
|------------|-------|-------|
| Oscillator | 10    | `Sine`, `Saw`, `Square`, `Impulse`, `LFO`, `Buzz`, `DSF`, `SineD`, `SineR`, `CSine` |
| Noise      | 4     | `NoiseWhite`, `NoisePink`, `NoiseBrown`, `NoiseBinary` |
| Envelope   | 6     | `AD`, `ADSR`, `Decay`, `Gate`, `Seg`, `SegExp` |
| Filter     | 11    | `BiquadLP`, `BiquadHP`, `BiquadBP`, `BiquadBR`, `OnePole`, `OneZero`, `Reson`, `AllPass1`, `BlockDC`, `BlockNyq`, `Integrator` |
| Delay      | 3     | `Delay`, `Delay1`, `Comb` |
| Effect     | 7     | `ReverbMS`, `Burst`, `PluckedString`, `FreqShift`, `Chirplet`, `RingMod`, `SoftClip` |
| Analysis   | 2     | `EnvFollow`, `ZeroCross` |
| Convert    | 6     | `MtoF`, `FtoM`, `DBtoA`, `AtoDB`, `Semi`, `Cents` |
| Math       | 59    | Core: `Mul`, `Add`, `Sub`, `Neg`, `Abs`, `Const`, `Clip`, `Scale`, `Mix`, `PhaseInvert`. Trig: `Sin`, `Cos`, `Tan`, `Asin`, `Acos`, `Atan`, `Sinh`, `Cosh`, `Tanh`. Exp/log/power: `Exp`, `Exp2`, `Log`, `Log2`, `Log10`, `Sqrt`, `Cbrt`, `Squared`, `Cubed`, `Recip`. Rounding/sign: `Sign`, `Floor`, `Ceil`, `Round`, `Trunc`, `Frac`. Two-arg: `Pow`, `Atan2`, `Mod`, `Hypot`, `Min`, `Max`, `Div`. Comparison: `Eq`, `Neq`, `Lt`, `Gt`, `Lte`, `Gte`. Logic: `And`, `Or`, `Xor`, `Not`. Selection: `If`, `Crossfade`, `Lerp`, `Smoothstep`. Range: `Wrap`, `Fold`, `Quantize`. |
| Sink       | 2     | `Output`, `OutputStereo` |
| **Total**  | **110** | |

The math/logic/conversion expansion (Wave 1 of EXPANSION.md) lifts the registry from 56 to 110 nodes. All new entries are template-based (no class members), reducing to inline C++ expressions at codegen time. Stdlib headers (`<cmath>`) are detected automatically and included only when needed.

### Deferred to V1.5+ (deliberate omissions)

- **Multi-output classes** — `Pan2`, `Hilbert`. Codegen needs to bind the result to a temporary so each output port reads a different field (`.first` / `.second` for `std::pair`, `[0]` / `[1]` for `Vec2`). Not hard, but it's a separate code path and worth doing once with care.
- **File-loading classes** — `SamplePlayer`, `SoundFile`. Need a path field in the node descriptor and a story for how AlloLib Studio Online marshals files into the WASM filesystem.
- **Block-rate / spectral classes** — `DFT`, `STFT`, `SDFT`. These don't fit the per-sample `operator()` shape; need a block-rate codegen path.
- **Enum-configured classes** — `Vowel` (vowel index), `ChebyN` (template `<N>` order), `Domain` switching. Need an enum/dropdown in the properties pane.
- **Voice managers** — `Voices<V>`, `Scheduler`. These wrap a synth class rather than acting as a node; better exposed as a "polyphony" toggle on the patch (§11) than as in-graph nodes.
- **System / IO** — `AudioIO`, `Recorder`, `Print`. These belong in the user's `AlloApp`, not inside the patch graph.
- **Low-level utilities** — `Containers`, `Strategy`, `Types`, `arr`, `gen`, `ipl`, `mem`, `tbl`, `rnd`. These are namespaces of helper types/functions; not nodes.

### Verification status

The node descriptors were built by inspecting `Gamma.h`, the full source of `Envelope.h`, and prior knowledge of the rest of the library. Several entries contain method names the codegen calls verbatim. Items with **higher confidence** (verified against header source): all envelope nodes, all oscillator method names for `freq`, the Biquad variants, `OnePole`, `Delay`. Items with **lower confidence** that may need adjustment when the build first fails: `Reson.width` (could be `bw` or `q`), `Comb.ffd` / `Comb.fbk` (could differ — Comb has `feeds(ffd, fbk)` as a combined setter in some versions), `Burst` and `Chirplet` (currently exposing only the gate, with construction-time params left as a TODO), `Integrator.leak`. Treat these as starting points; if a particular setter doesn't compile, edit the registry entry rather than the generated code.

### Templates and instantiations

Most Gamma classes are templates. V1 pins to `<>` (default `float` plus default interpolation/domain). For classes whose template parameter materially changes behaviour, variants are exposed as separate node types rather than via a UI for picking template arguments.

The V1 prototype applies this pattern to `Biquad` only — the `BiquadLP`, `BiquadHP`, `BiquadBP`, `BiquadBR` nodes are the same `gam::Biquad<>` member with a different `type()` call in `extraCtor`. The same shape generalizes to other templated classes when their non-default instantiations become relevant; e.g.,

- `Delay` → currently `gam::Delay<>` (linear interp). V1.5 candidates: `DelayAllpass` (`<float, ipl::AllPass>`), `DelayCubic` (`<float, ipl::Cubic>`).

This keeps node descriptors flat and avoids cluttering the properties pane with template-parameter UI. Scales cleanly: roughly 5 variants per templated class is comfortable.

---

## 6. Type system and connection rules

Three port types, each colour-coded:

| Type   | Colour    | Stroke pattern | Meaning |
|--------|-----------|----------------|---------|
| audio  | teal      | solid          | per-sample signal |
| param  | purple    | dashed         | control-rate value (drives a setter) |
| gate   | amber     | solid          | momentary trigger event |

### Connection legality matrix

| from \ to | audio in | param in | gate in |
|-----------|----------|----------|---------|
| audio out | ✓        | ✓ (with warning) | ✗ |
| param out | ✓ (rare) | ✓        | ✗ |
| gate out  | ✗        | ✗        | ✓ |

Notes:

- **Audio → param** is permitted. In Gamma everything is just a number, so audio can drive a setter; the codegen emits a per-sample setter call. The editor warns when this is the *only* upstream of a param input ("audio modulation may sound rough — consider a filter").
- **Param → audio** is allowed but emits a warning ("control signal used as audio — typically silent below ~20 Hz").
- **Gate** is strictly its own lane. Gates emit C++ method calls on a clock, not a per-sample value. They cannot be "summed" or "filtered."
- **Multi-output to same input is forbidden.** Each input port has at most one incoming edge. Sum or scale explicitly via `Add`/`Mul`.

### Disconnection UX

Clicking an input port picks up its existing wire (if any) and lets the user drop it elsewhere. Releasing on empty space cancels and the wire is removed. Releasing on a different valid input port re-routes the connection. This matches Reaktor and Max gen~ conventions.

---

## 7. Code generation

### 7.1 Output structure

Each patch emits a single header containing one class:

```cpp
// Auto-generated by Gamma node editor — do not edit.
// Source: MyPatch.gpatch  (regenerate by saving the .gpatch file)

#pragma once
#include <Gamma/Gamma.h>
#include <Gamma/Oscillator.h>
#include <Gamma/Envelope.h>
#include <Gamma/Filter.h>
// ... only the headers needed for nodes used in this patch

class MyPatch {
    // -- members, in node-id order --
    gam::Sine<>   n1;
    gam::AD<>     n2;
    gam::Biquad<> n4;

public:
    MyPatch() {
        // -- constructor body, in node order --
        n1.freq(220.0f);
        n2.attack(0.01f); n2.decay(0.6f);
        n4.type(gam::LOW_PASS); n4.freq(1200.0f); n4.res(1.4f);
    }

    // -- exposed setters, in declaration order of the editor --
    void freq(float v)    { n1.freq(v); }
    void trigger()        { n2.reset(); }

    // -- per-sample tick --
    float operator()() {
        return n4((n1() * n2()));
    }
};
```

This snippet is the conceptual structure — what the patch *means*. The actual codegen emits the same operations with extra defensive parentheses around every substituted expression. See §7.2 for a worked example that shows the literal output.

### 7.2 Algorithm

The codegen distinguishes two node shapes, encoded in the registry:

**Member nodes** (`cppType` non-empty) declare a class member, initialize parameters in the constructor, and emit a method-call expression at use site:

- Declaration: `gam::Sine<> n1;`
- Ctor init: `n1.freq(220.f);` for each `params[k]`, using `methods[k]` lookup to map param name → Gamma setter (e.g. `cutoff` → `freq`, `q` → `res` on Biquad)
- Read expression: `n1(in_expr)` for nodes with one audio input, `n1()` for sources

**Template nodes** (`cppType` empty, `template` provided) inline a C++ expression with `{portName}` and `{paramName}` placeholders. No member is declared; the expression is substituted directly into the consuming expression:

- `Mul`'s template: `({a} * {b})` → `((n1()) * (n2()))` 
- `MtoF`'s template: `gam::scl::mtof({in})` → `gam::scl::mtof((60.f))`
- `Const`'s template: `{value}` → `(60.f)`
- `Scale`'s template: `(({in} - {inMin}) / ({inMax} - {inMin}) * ({outMax} - {outMin}) + {outMin})`

The full algorithm:

1. **Topo-sort** the graph from sinks back to sources. Reject cycles unless a `Delay1` node is on the path (§10).
2. **Emit declarations** for every member node.
3. **Emit ctor body**: for each member node, emit `extraCtor` lines (with `{id}` substituted), then init each param via `methods[k]`. Template nodes emit nothing in the ctor — their params are inlined at use sites.
4. **Emit setters** for every entry in `state.exposed`:
   - Param exposure on a member node → `void {paramName}(float v) { id.method(v); }`. Template node params can't be exposed (no member to call); the editor disables that checkbox.
   - Gate exposure → `void {gateName}() { id.{gateMethod}(); }`. The default `gateMethod` is `reset`; ADSR's release gate uses `release`.
   - Name collisions resolved by appending `_{nodeId}`.
5. **Emit per-sample setters**: for any member node whose param input has an incoming edge, emit `id.method(upstream_expr);` at the top of `operator()`.
6. **Emit return**: starting from the `Output` (or `OutputStereo`) sink, recursively build the return expression via `exprFor`. Member nodes emit `id(in_expr)`. Template nodes substitute placeholders. Math nodes (which are template nodes) fold to infix operators.

A worked example: MIDI 60 → MtoF → Sine → BiquadLP cutoff modulated by an LFO scaled to 400–2400 Hz → Output:

```cpp
class MyPatch {
    gam::Sine<>   n8;
    gam::LFO<>    n9;
    gam::Biquad<> n11;
public:
    MyPatch() {
        n8.freq(440.f);
        n9.freq(2.f);
        n9.mod(0.5f);
        n11.type(gam::LOW_PASS);
        n11.freq(1200.f);
        n11.res(1.4f);
    }

    float operator()() {
        n8.freq(gam::scl::mtof(((60.f))));
        n11.freq((((n9()) - (-1.f)) / ((1.f) - (-1.f)) * ((2400.f) - (400.f)) + (400.f)));
        return n11(n8());
    }
};
```

The redundant parentheses are intentional — the template substitution wraps every substituted value in parens to prevent operator-precedence surprises. The C++ compiler removes them with zero overhead.

### 7.3 Inlining vs. naming intermediate values

V1 inlines everything into a single returned expression. This produces compact, readable code for small patches and lets the C++ compiler optimize freely.

For patches with **fan-out** (one node feeding multiple inputs), inlining would duplicate stateful calls. Detect fan-out in the topo sort: any node whose output feeds more than one input gets a named local:

```cpp
float operator()() {
    auto _n1 = n1();              // fan-out: read once
    return n4(_n1 * _n1);         // used in both branches
}
```

Stateless nodes (`Sine`, `Mul`) are still safe to inline even with fan-out, but the rule "fan-out → bind to local" is simple and correct.

### 7.4 Parameter-rate edges

When a `param` input has an incoming wire (rather than a constant), the param's setter is called every sample before the read:

```cpp
float operator()() {
    n4.freq(lfo() * 800.f + 1200.f);   // dynamic cutoff
    return n4(n1());
}
```

This is what the user means when they wire an LFO into a filter cutoff. The codegen detects "param input with incoming edge" and lifts the setter call into the per-sample block.

### 7.5 Header inclusion

Track which Gamma headers are needed by which node types. Emit only the headers required by nodes present in the patch. Map at build time:

```ts
const HEADERS = {
  Sine: "Gamma/Oscillator.h",
  AD:   "Gamma/Envelope.h",
  Biquad: "Gamma/Filter.h",
  // ...
};
```

---

## 8. AlloLib integration

### 8.1 Build pipeline

AlloLib Studio Online compiles C++ to WebAssembly via Emscripten. The node editor adds one step before the existing build:

```
.gpatch file changed
  → JS regenerates {name}.h
  → file watcher triggers existing C++ → WASM build
  → page reloads
```

No new toolchain. The editor's codegen runs in the browser, not on a server.

### 8.2 Domain attachment

Gamma's `Domain` system propagates sample rate to all units attached to it. The generated patch class does **not** call `gam::sampleRate()` itself — the user's `AlloApp` already configures the global domain. Users who want a separate domain (e.g., a downsampled modulation graph) construct one and pass it; V1 doesn't expose this, V2 should.

### 8.3 Wiring into `AudioIOData`

The generated class is mono by default. For stereo, use the `OutputStereo` sink, which produces a `std::pair<float, float>`:

```cpp
void onSound(AudioIOData& io) override {
    while (io()) {
        auto [l, r] = patch();
        io.out(0) = l;
        io.out(1) = r;
    }
}
```

Multi-out (more than 2 channels) is deferred. AlloLib's spatial audio is an explicit V2 feature (§13).

### 8.4 Parameter binding

The generated class's exposed setters integrate trivially with AlloLib's `Parameter` system:

```cpp
struct App : al::App {
    MyPatch patch;
    al::Parameter cutoff{"cutoff", "", 1200.f, 100.f, 8000.f};
    al::Parameter freq  {"freq",   "", 220.f,  20.f,  2000.f};

    void onCreate() override {
        cutoff.registerChangeCallback([this](float v) { patch.cutoff(v); });
        freq.registerChangeCallback  ([this](float v) { patch.freq(v);   });
    }
};
```

This is the workflow the editor's "expose as setter" checkbox is designed for.

---

## 9. Editor UI/UX

### 9.1 Layout

```
┌────────────────────────────────────────────────────────────┐
│ header: filename · stats              [open] [save] [gen]  │
├──────────┬─────────────────────────────────────────────────┤
│  search  │                                                 │
│ ▼ Osc 10 │              canvas (pan + zoom)                │
│   Sine   │                                                 │
│   Saw    │                                                 │
│   ...    │                                                 │
│ ▶ Noise 4│                                                 │
│ ▼ Env 6  │                                                 │
│   AD     │                                                 │
│   ...    │                                                 │
├──────────┴─────────────────────────────────────────────────┤
│ tabs: Properties · Generated C++ · .gpatch JSON            │
│                                                            │
│ pane content                                               │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 9.2 Palette (left sidebar)

With ~55 nodes, the palette is search-first:

- **Search input** at top filters by node name *and* description (case-insensitive substring match). When the search has any text, all matching categories auto-expand and non-matching items are hidden.
- **Collapsible category headers** with item counts. Clicking the header toggles the section. State is per-session (not persisted).
- **Items** show a colored category dot + node name. Hovering shows a tooltip with the node description (native `title` attr).
- Width is 248 px to comfortably fit the longest names (`OutputStereo`, `PluckedString`).
- Categories are presented in a fixed order: Oscillator, Noise, Envelope, Filter, Delay, Effect, Analysis, Convert, Math, Sink. This roughly mirrors signal-flow order (sources → modifiers → sinks) which helps when reading the palette top-to-bottom.

Keyboard: pressing `/` from anywhere outside an input focuses the search box (Vim / GitHub convention).

### 9.3 Canvas

- **Pan**: middle-click drag, or space+drag, or two-finger trackpad scroll.
- **Zoom**: mouse wheel, zoom-toward-cursor; clamp to [0.25, 2.0]. Shift+wheel for finer steps.
- **Background**: subtle dot grid, 16 px in world space. Fades when zoomed out below 0.5×.
- **Selection**: click a node to select; shift-click to add to selection; drag on empty canvas to marquee-select.
- **Multi-select drag**: dragging any selected node moves all selected nodes by the same delta.
- **Snap**: optional 8 px snap, toggleable via a header toggle. Off by default.

### 9.4 Wires

- Bezier with horizontal control points proportional to horizontal distance (`dx * 0.5 + 24`), giving comfortable curves at all aspect ratios.
- Hover state on a wire shows a small handle at midpoint; clicking the handle deletes the wire.
- Color-coded by type (§6).

### 9.5 Nodes

- 140 px wide, dynamic height (3 px strip + 26 px header + 20 px per port row + 7 px footer).
- Strip color encodes category.
- Header is the drag handle; clicking the body selects without dragging.
- Port row shows port name on the side of the node opposite the dot.

### 9.6 Properties pane

When a node is selected:
- Type, id, category dot, and one-line description at top.
- One row per parameter: `<name>` `<number input>` `<expose checkbox>` (or "inline param" label for template nodes whose params can't be exposed as a runtime setter).
- One row per gate input: `<name>` `<gate · methodName()>` `<expose as trigger() checkbox>`. The gate-method label shows which Gamma method the trigger calls (`reset` for most, `release` for ADSR's release gate).

Editing a number input updates the node's params live; the C++ pane updates immediately.

### 9.7 Keyboard shortcuts

| Keys | Action |
|------|--------|
| `Del` / `Backspace` | Delete selected nodes and their connections |
| `/` | Focus search box (when not in an input) |
| `Cmd/Ctrl-S` | Save `.gpatch` (file mode only) |
| `Cmd/Ctrl-Z` / `Cmd/Ctrl-Shift-Z` | Undo / redo |
| `Cmd/Ctrl-D` | Duplicate selected nodes (with their internal wires) |
| `Cmd/Ctrl-A` | Select all |
| `Cmd/Ctrl-C` / `Cmd/Ctrl-V` | Copy / paste (subgraph as JSON) |
| `Space` | Hold to pan with drag |
| `1` / `2` / `3` | Switch tabs (Properties / C++ / JSON) |
| `Cmd/Ctrl-K` | Open node-add palette as quick-pick at cursor |

### 9.8 Undo

Single linear undo stack. Each user action (add node, delete, move, connect, disconnect, edit param, toggle expose) pushes the previous state. Coalesce consecutive `move` operations on the same node within 250 ms. Coalesce consecutive `param-edit` operations on the same param within 500 ms.

History stack capped at 200 entries. Older entries dropped from the bottom.

### 9.9 Validation

Run on every save and every render:

- **Cycles without `Delay1`**: red glow on the implicated nodes; tooltip "feedback requires an explicit Delay1 node."
- **Disconnected `Output`**: amber glow on the output node; tooltip "patch has no connection to output."
- **Multi-edge to one input**: should be impossible to create, but if loaded from disk, last edge wins, others dropped with a console warning.
- **Unknown node `type` on load**: rendered as a placeholder "unknown" node with red border; codegen replaces with `0.f` and emits a warning comment.

---

## 10. Feedback loops

Gamma is sample-by-sample, so feedback requires a one-sample delay element to break the cycle. The editor enforces this by refusing to topo-sort cycles unless an explicit `Delay1` node is on the path:

```
[Sine] → [Mul] ────┐
              ↑    ↓
            [Delay1] ← [LP]
```

Codegen for `Delay1`:

```cpp
class MyPatch {
    float n7_z = 0.f;                       // Delay1 state
    // ...
    float operator()() {
        float n7_out = n7_z;                // read previous sample
        // ... downstream uses n7_out ...
        n7_z = /* new value computed this sample */;
        return /* ... */;
    }
};
```

`Delay1` reads the previous sample's value (state held in a single float member) and writes this sample's value. Any cycle in the graph must pass through at least one `Delay1`; the editor visually highlights cycles missing one.

---

## 11. Polyphony

V1 emits a monophonic class. Polyphony is a wrapper provided as a separate generated class:

```cpp
template <int N>
class MyPatchPoly {
    MyPatch voices[N];
    // round-robin voice allocation
    int next = 0;
public:
    void noteOn(float freq) {
        voices[next].freq(freq);
        voices[next].trigger();
        next = (next + 1) % N;
    }
    float operator()() {
        float s = 0.f;
        for (auto& v : voices) s += v();
        return s * (1.f / N);
    }
};
```

The editor offers a "polyphony: N" toggle in the header. When set, codegen emits both `MyPatch` and `MyPatchPoly`. The user picks which to instantiate.

`noteOn(freq)` exists only if the patch has at least one exposed `freq` setter and at least one exposed gate. Otherwise the wrapper exposes only `operator()` and a generic `trigger()`. Voice stealing is round-robin in V1; V2 may add note-priority strategies.

---

## 12. Spatial extension (V2)

This is the feature unique to AlloLib Studio Online and the AlloSphere — Faust, Reaktor, and gen~ don't have it.

### 12.1 Spatial node

A `Spatial` sink node accepts:
- audio in (the signal to place)
- `x`, `y`, `z` param inputs (position in world space)
- a config dropdown for AlloSphere speaker layout vs. binaural vs. stereo downmix

Codegen targets `al::DistAtten` + `al::Spatializer` from AlloCore:

```cpp
class MyPatch {
    gam::Sine<> n1;
    al::Spatializer* spat;        // injected from AlloApp
public:
    void setSpatializer(al::Spatializer* s) { spat = s; }
    void operator()(al::AudioIOData& io) {
        float s = n1();
        spat->renderSample(io, al::Vec3f(0.f, 0.f, 1.f), s);
    }
};
```

The presence of any `Spatial` node changes the `operator()` signature to take `AudioIOData&` (because spatial output writes to multiple channels). This is why the patch class is generated, not interpreted — the call shape changes based on graph contents.

### 12.2 AlloSphere speaker config

The AlloSphere has a fixed dome speaker layout. The editor reads it from the AlloLib Studio Online project config (if present) and presents a dropdown of named layouts. Falls back to stereo if not running in AlloSphere context.

---

## 13. AI assistant for `.gdsp` authoring

The User DSP tab includes an LLM-backed authoring panel (the **✨ AI** button) that generates, modifies, fixes, and explains `.gdsp` source. The same pipeline also handles handwriting recognition for the pen-tablet tool (§14.1) and speech-to-text for the voice button (§14.2). This section documents the architecture and setup paths.

### 13.1 Architecture

The assistant is provider-agnostic. A `PROVIDERS` map exposes a uniform interface:

```ts
type Provider = {
  defaultModel: string;
  requiresKey: boolean;
  supportsImage: boolean;
  supportsAudio: boolean;
  call(args: {
    system: string;
    user: string;
    model: string;
    key?: string;
    onToken?: (chunk: string) => void;
    image?: string;          // base64 PNG
    audio?: Float32Array;    // 16kHz mono
  }): Promise<string>;
};
```

Two backends ship in V1:

| Provider | Where inference runs | Image | Audio | API key | First-use cost |
|----------|----------------------|-------|-------|---------|----------------|
| `gemma` (default) | User's GPU (local, transformers.js + WebGPU) | ✓ | ✓ | None | ~1.5 GB model download (E4B), cached in IndexedDB |
| `anthropic` (optional) | Anthropic API (cloud) | ✓ | ✗ | User-supplied | API tokens (~1¢ per call at Sonnet rates) |

Adding a third provider is one map entry. When the editor is integrated into AlloLib Studio Online, the right move is a `proxy` provider whose `call` POSTs to an IDE endpoint that holds the key server-side.

**One model, three jobs:** Gemma 4 E4B handles all three modalities — `.gdsp` text generation, pen-tablet handwriting recognition, and speech-to-text — through a single `any-to-any` pipeline. This consolidates what was previously a three-model stack (text LLM + vision LLM + Whisper-tiny) into one, at the cost of a larger initial download.

### 13.2 Prompt construction

The system prompt is built fresh from a `gdspFormatSpec()` function rather than hardcoded as a static string. This guarantees the spec the model sees stays in sync with the directives the parser actually accepts. The prompt covers required directives, optional directives, the class-shape contract (`operator()` signature, setter naming for params and gates), and a complete BitCrush example as an in-context demonstration.

Four user-facing modes shape the user message:

- **Generate from scratch** — `"Generate a complete .gdsp file for: {description}"`
- **Modify current source** — embeds the current editor contents and the user's instruction
- **Fix validation error** — embeds the broken source plus the validator's error message; auto-prefilled when the editor's status line shows an error
- **Explain current source** — read-only mode; returns prose, no code

All non-explain modes return code that's run through `cleanGdspResponse` to strip markdown fences before being shown for review. Apply / Discard buttons gate whether the suggestion overwrites the editor.

For multimodal inputs (HWR image, voice audio), the input modality is placed BEFORE the text instruction in the user content array, per Google's recommendation for Gemma 4.

### 13.3 Setting up: Gemma 4 (default, local)

Gemma 4 runs entirely in the browser via WebGPU using `@huggingface/transformers`. After the initial weight download, inference is fully offline — nothing leaves the machine.

**Hardware and browser requirements:**

- WebGPU-capable browser. Chrome and Edge ship WebGPU on all platforms. Safari supports it on macOS Sonoma+ and iOS 18+. Firefox: not yet on stable, behind a flag in Nightly.
- A discrete GPU or unified-memory machine. ~4 GB free VRAM for E4B (recommended), ~3 GB for E2B. Integrated GPUs work but slowly.
- ~2× the model size in free disk for the IndexedDB cache.

**One-time setup:** the default. Open the User DSP tab, click **✨ AI**, type a prompt, hit Run.

**First Run experience:**

1. Status line shows `loading model… (12%)`, `(34%)`, etc. as the weights download. Allow 1–3 minutes for E4B (~1.5 GB compressed) on a typical home connection.
2. Once at 100%, the model expands and compiles WebGPU shaders (another 10–30 seconds with no progress bar — this is normal). Total in-memory footprint after loading all encoders is ~5 GB for E4B / ~3.2 GB for E2B.
3. Generation begins. Streaming tokens flow into the result panel as the model emits them.

**Subsequent runs** are fast: the model stays in browser memory until the page is closed. Even after a page reload, IndexedDB caches the weights so only the WebGPU shader rebuild runs (10–30 seconds), not the download.

**Available models:**

| Model | Size (download / loaded) | Notes |
|-------|--------------------------|-------|
| `onnx-community/gemma-4-E4B-it-ONNX` | ~1.5 GB / ~5 GB | Default. Effective 4B parameters via PLE. Best quality among local options. |
| `onnx-community/gemma-4-E2B-it-ONNX` | ~500 MB / ~3.2 GB | Effective 2B. Lower-VRAM machines (8 GB unified memory, integrated GPUs). Quality is meaningfully below E4B but viable. |

Both variants natively process text, images, and audio. The 26B-A4B (MoE) and 31B (Dense) Gemma 4 models exist but are too heavy for browsers — they need 18+ GB VRAM and are intended for server / Ollama deployment.

**Vision capabilities (Gemma 4 model card):**

- Object detection with native bounding box output
- Document/PDF parsing
- Screen and UI understanding
- Chart comprehension
- OCR (multilingual)
- **Handwriting recognition** (explicitly named in the model card — directly relevant to the pen-tablet tool)
- "Pointing" (designating points/regions in an image)

Variable image aspect ratio and resolution. Image token budget is configurable: 70, 140, 280, 560, or 1120 tokens per image. Lower budget = faster inference, less detail. The editor's HWR pathway uses the default budget; tune in `ensureGemmaPipeline` if needed.

**Audio capabilities (E2B/E4B only):**

- USM-style conformer encoder.
- Maximum 30 seconds per input.
- Speech recognition + speech-to-translated-text across multiple languages.
- 16 kHz mono Float32Array input format. The editor handles MediaRecorder → AudioBuffer → Float32Array conversion via `blobToAudioFloat32`.

**Privacy implications:**

After the initial weight download from the Hugging Face CDN (which serves model weights only — no telemetry on what you generate), every prompt, every handwriting sample, every voice utterance stays on your machine. There is no logging, no key, no API roundtrip. If you're working with a `.gdsp` you don't want shared with a third party (e.g., a research project under embargo, a class assignment with proprietary samples), use this path — it's the default.

**Limitations:**

- Quality on `.gdsp` code generation is below Claude Sonnet 4.5 but reportedly better than Qwen-Coder-7B (the previous local-only option). Use **Fix validation error** mode when the first attempt doesn't compile.
- Inference is slower than cloud APIs. A typical 500-token generation takes 5–15 seconds on Apple Silicon, 10–30 seconds on a recent Nvidia GPU. The cloud APIs return in 2–4 seconds.
- The `<|think|>` token is enabled by default in Gemma 4. The editor's prompts are direct enough that thinking content is minimal, but if you see verbose reasoning in the output, the cleanup function strips it.
- WebGPU has no fp16 support on some older GPUs. If load fails with `webgpu shader compilation error`, fall back to E2B (smaller weights, more conservative kernels).

### 13.4 Setting up: Anthropic (optional, cloud)

The Anthropic provider remains available as an optional cloud backup for users who want top-tier code quality at the cost of API spend, or whose machines can't run Gemma 4 (no WebGPU, low VRAM).

1. Open the User DSP tab and click **⚙**.
2. Set Provider to **Anthropic (Claude) — optional**.
3. Set the model (defaults to `claude-sonnet-4-5`).
4. Paste your API key. Save.

The key lives in `localStorage` under `gamma-editor-ai-settings-v1`. It goes to Anthropic only and is never sent anywhere else. **Clear key** in settings wipes it.

CORS note: Anthropic requires `anthropic-dangerous-direct-browser-access: true` for browser calls; the editor sends it automatically.

If Anthropic tightens browser policies in the future, fall back to the IDE-proxy path described in §13.1.

The Anthropic provider supports image input (used for handwriting recognition when this provider is selected) but does not support audio input. Voice transcription falls back to bundled Whisper-tiny in this case (~75 MB, English-only, runs on WebAssembly so works without WebGPU).

### 13.5 Operational notes

- **Costs are on the user.** No editor-side rate limiting; spam the Run button and you'll get rate-limit errors from Anthropic, or saturate your local GPU when running Gemma.
- **Streaming is on for both providers.** Tokens stream into the result panel as the model generates them. Anthropic streams via Server-Sent Events; Gemma streams via transformers.js's `TextStreamer` callback. The Apply button only appears once the stream completes (and the response has been fence-stripped). Any partial output remains visible after a streaming error so the user can copy what they have.
- **The model cannot run the validator.** It writes source; the editor parses it. If the model writes plausible-looking but wrong directives (e.g., `@gdsp-input  freq number`), validation rejects on Save & Add.
- **No automatic compile.** The validator only checks the directive contract. Bad C++ in the class body fails at the WASM build, not at validation. Use **Fix validation error** with the build error message pasted into the prompt as the workflow.

### 13.6 Fine-tuning Gemma 4 with Unsloth

For the editor's specific use cases — recognizing the closed vocabulary of registry node names, generating idiomatically-correct `.gdsp` source, recognizing voice commands in the editor's domain — fine-tuning Gemma 4 E4B (or E2B) on synthetic in-domain data is a high-leverage path. Unsloth (`unslothai/unsloth`) has day-zero support and is the recommended toolchain.

**Why Unsloth here.** Unsloth provides ~1.5–2× faster training and ~60–70% less VRAM than stock HuggingFace + PEFT for Gemma 4 specifically. It supports vision, text, audio, and RL fine-tuning for all four Gemma 4 variants (E2B, E4B, 26B-A4B, 31B). It fixes a number of universal bugs in Gemma 4 training (not Unsloth-specific) that affect raw HuggingFace pipelines. Day-zero documented support is a meaningful upgrade over the TrOCR situation analyzed earlier (where Unsloth's `FastVisionModel` doesn't support the encoder-decoder architecture).

**Hardware requirements (LoRA fine-tuning, approximate):**

| Model | VRAM | Practical hardware |
|-------|------|--------------------|
| E2B LoRA | 8–10 GB | Free Google Colab T4, RTX 3060+, M-series Macs with 16+ GB unified memory |
| E4B LoRA | 17 GB | RTX 4090, A5000, paid Colab L4 |
| 26B-A4B LoRA | >40 GB | A100, H100. Use rank 16 + 16-bit LoRA (no QLoRA — MoE quirks) |
| 31B QLoRA | 22 GB | RTX 5090, A6000 |

For the editor's purposes, **E4B is the right target**: same model that runs in the browser at inference time, so what you fine-tune is what users get. Free-Colab users start with E2B and accept the smaller model.

**Three suggested fine-tuning targets for this editor:**

1. **Handwriting accuracy on registry node names.** Generate ~25k synthetic samples (50 freely-licensed handwriting fonts × 110 node names × ~5 augmentations each: rotation, shear, ink-thickness variation, additive noise). Mix in 10–20% real handwritten samples from collaborators (e.g., a class assignment in MAT201) to improve generalization. Fine-tune the vision layers. Expected outcome: HWR accuracy on the closed vocabulary climbs from baseline ~95% to 99%+.

2. **`.gdsp` generation quality on Gamma idioms.** Build a corpus of ~200–500 hand-curated `.gdsp` files (the existing community library, plus generated examples covering each major DSP category — oscillators, filters, envelopes, distortion, etc.). Fine-tune the text path. Expected outcome: fewer validation errors on first generation, fewer iterations needed in **Fix validation error** mode, more idiomatic use of Gamma's API patterns.

3. **Voice command vocabulary** (when §14.3 is built). Synthetic + real audio samples covering the editor's command vocabulary ("delete this," "save patch," "switch to generated code," etc.) across 50+ speakers and accents. Fine-tune the audio path. Expected outcome: command recognition that's much more robust than zero-shot Gemma.

These can be combined into a single multi-task LoRA adapter or kept separate (one adapter per task, swapped at inference time depending on what the user is doing).

**Practical fine-tuning recipe (E4B LoRA, simplified):**

```python
from unsloth import FastModel
import torch

model, tokenizer = FastModel.from_pretrained(
    model_name = "unsloth/gemma-4-E4B-it",
    max_seq_length = 4096,
    load_in_4bit = True,         # QLoRA
    full_finetuning = False,
)

model = FastModel.get_peft_model(
    model,
    finetune_vision_layers     = True,   # for HWR
    finetune_language_layers   = True,   # for .gdsp text
    finetune_attention_modules = True,
    finetune_mlp_modules       = True,
    r = 16,                              # LoRA rank
    lora_alpha = 16,
    lora_dropout = 0,
    bias = "none",
    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj",
                      "gate_proj", "up_proj", "down_proj"],
    random_state = 3407,
)
```

Train with `SFTTrainer` from TRL using the chat template. Critical: use the same chat template at inference time as at training time, or quality collapses.

**Gotchas documented in the Unsloth Gemma 4 guide:**

- **Multimodal loss starts high (13–15) and that's normal.** Unsloth notes this is a quirk of Gemma 4 multimodal training. Llama 3.2 Vision starts at 3–4, Pixtral at ~8. Don't panic; the model is learning.
- **Reasoning preservation.** Gemma 4 has a `<|think|>` token. If your training data is direct-answer-only (no thinking), the fine-tuned model loses some reasoning ability. Mix at least 75% of examples with reasoning-style traces if you want to preserve it. For a focused HWR fine-tune you don't need reasoning, so this isn't a concern; for the `.gdsp` generation fine-tune it might be.
- **MoE rank for 26B-A4B.** Use rank 16 LoRA, not QLoRA. Don't drop below; the MoE routing destabilizes at very low ranks.
- **Multimodal prompts: image/audio FIRST, then text.** Same as inference. If you reverse them, training degrades silently.
- **CUDA 13.2 incompatibility.** Don't use the CUDA 13.2 runtime for any GGUF; produces poor outputs. Stick with CUDA 12.x for now.

**Deployment after fine-tuning:**

The trained adapter (typically 50–200 MB depending on rank) can be:
- **Merged into the base model** and re-exported as ONNX → loaded into the editor via the same `transformers.js` pipeline. Browser users get the fine-tuned model on first download.
- **Kept as a separate LoRA adapter file** loaded at inference time on top of the base ONNX. transformers.js LoRA support is improving but not yet as smooth as the merged-and-exported route.
- **Exported to GGUF** for server-side Ollama deployment if you want to centralize the fine-tuned model and have the editor talk to it via a proxy provider (§13.1).

For the editor, the merged-and-exported route is the simplest: one ONNX checkpoint, one URL change in the `gemma` provider's `defaultModel`, ship it. The fine-tuned model can live at e.g. `huggingface.co/<your-org>/gamma-editor-gemma-4-E4B-merged-ONNX`.

**Time and cost estimates for the three suggested fine-tunes (E4B):**

| Task | Dataset prep | Training (RTX 4090) | Total wall clock |
|------|--------------|---------------------|------------------|
| HWR closed-vocabulary | ~3 hours (script + augmentation) | ~4 hours (3 epochs, 25k samples) | ~7 hours |
| `.gdsp` generation | ~1 week (corpus curation) | ~6 hours (5 epochs, 500 samples) | ~1 week |
| Voice commands | ~2 days (audio collection) | ~2 hours (3 epochs, 5k samples) | ~3 days |

The HWR fine-tune is the highest-leverage and least labor-intensive — it's the obvious first one to do.

---

## 14. Alternative input methods

The editor supports three input modalities beyond mouse + keyboard: pen tablet, voice (Whisper), and touch. Each is opt-in and degrades gracefully when the underlying capability is missing.

### 14.1 Pen tablet — draw-to-create

A toolbar above the canvas exposes two tool modes: **Select** (default, current behaviour) and **Draw**. Switching to Draw mode — or simply touching the canvas with a stylus regardless of mode — engages a pen-aware capture layer.

The interaction:

1. **Drag a rectangle** on empty canvas. Pointerdown to pointerup defines the box. Boxes smaller than 30×24 px are rejected as misclicks.
2. **Write a label inside the box.** Strokes are captured as ink and rendered live. Multiple strokes are accumulated into one label.
3. **Tap ✓ Recognize** on the floating finalize button next to the box. Strokes are rasterized to PNG and sent to a vision-capable LLM with a constrained prompt: "Reply with EXACTLY ONE word: the closest matching node type from this list — or UNKNOWN if none clearly matches. Available types: ..."
4. The reply is run through a fuzzy-matcher (exact → case-insensitive → prefix → substring) against `Object.keys(TYPES)`. On match, a node of that type is created at the box's position and selected. On miss or `UNKNOWN`, a status message reports the failure.

Pen detection uses `PointerEvent.pointerType === "pen"`. This means a stylus auto-engages drawing regardless of the active tool — matching the convention of every drawing app since the Wacom era.

**HWR backend (current default):**

Handwriting recognition routes through whichever provider is selected in AI settings. With **Gemma 4** (default), the strokes-as-PNG go to the local Gemma model with the constrained prompt. Gemma 4's model card explicitly names "handwriting recognition" as a trained capability, and the model handles the editor's closed-vocabulary use case without requiring a network round-trip. With **Anthropic** (optional), the same image goes to Claude Sonnet 4.5 via the cloud — useful as a backup when WebGPU isn't available.

**Empty-box fallback:** if the user draws a box but writes no strokes, ✓ Recognize prompts for a typed label instead. This gives keyboard users access to the same draw-to-create flow.

**Privacy:** with Gemma (default), strokes never leave the machine — the rasterized PNG is fed directly to the local pipeline. With Anthropic (optional), the small (typically <30 KB) PNG goes only to the configured cloud provider, exactly the same path as `.gdsp` AI requests.

### 14.1.1 Trade-offs of the two HWR paths

| Property | Gemma 4 E4B (default) | Anthropic Claude (optional) |
|----------|------------------------|------------------------------|
| Accuracy on cleanly-written single words | Projected ~95% baseline; 99%+ after fine-tuning (§13.6) | ~95% empirically |
| Latency | ~50–200 ms after warm-up; first run includes ~1–3 min model load | 1–3 s (network round-trip) |
| Cost per recognition | Zero (local) | ~0.5–1¢ at Sonnet rates |
| Setup | None — just a WebGPU browser | API key |
| Offline | Yes (after initial weight download) | No |
| Vocabulary | Open — Gemma 4 is fully general | Open — Claude is fully general |
| Failure modes | Hallucinated names, off-list responses (caught by fuzzy-matcher) | Same |

The vocabulary-adapts-instantly property is preserved with both paths since neither uses a closed-classifier architecture. Every new node added to the registry is reflected in the prompt's type list and immediately covered by recognition.

### 14.1.2 Path to higher accuracy: fine-tuning

The default Gemma 4 path works well out of the box for cleanly-written single words from a constrained vocabulary, but accuracy can be pushed materially higher with domain-specific fine-tuning. Three options, ordered from "best for this editor" to "alternate architectures":

**A. Fine-tune Gemma 4 E4B via Unsloth** *(recommended).* Same model that runs at inference time. Train a LoRA adapter on synthetic handwritten samples of the registry node names plus collected real samples. Merge and re-export ONNX → swap the URL in the `gemma` provider's `defaultModel`. Detailed plan and gotchas in §13.6.

- **Toolchain:** Unsloth has day-zero Gemma 4 support with full multimodal fine-tuning (vision, text, audio). E4B LoRA needs 17 GB VRAM (RTX 4090 / A5000 / paid Colab L4). E2B works on free Colab T4.
- **Data:** ~25k synthetic samples (50 handwriting fonts × 110 node names × ~5 augmentations each) plus optional ~1k real samples from collaborators.
- **Training:** ~4 hours on RTX 4090 for a focused HWR fine-tune.
- **Outcome:** projected lift from ~95% baseline to 99%+ on the closed vocabulary. Open-vocabulary recognition for user-DSP types stays equally good (the language layers remain general-purpose).

**B. Closed-vocabulary classifier.** Architecturally simpler than fine-tuning a 4B model: distilled MobileNet-V3-small or a custom 5-layer CNN with a softmax over `len(TYPES)` classes plus an "unknown" class.

- **Bundle:** ~5 MB after quantization (vs ~5 GB for E4B in memory).
- **Latency:** ~5 ms per recognition. Runs comfortably in browser via ONNX Runtime Web with WebAssembly only — no WebGPU needed.
- **Caveat:** vocabulary is closed at training time. New node types added to the registry after training aren't recognized. Mitigations: keep an "unknown" class that falls back to Gemma 4 recognition, or re-train on registry changes (minutes).
- **When to pick:** if you want HWR to work on machines that *can't* run Gemma 4 — old Chromebooks, low-VRAM laptops, mobile browsers without WebGPU. The classifier is a graceful-degradation backup, not a primary path.

**C. Fine-tune TrOCR.** The path that dominated the discussion before Gemma 4 shipped. Microsoft's `microsoft/trocr-base-handwritten` (BEiT encoder + RoBERTa decoder, ~330 MB) is still a valid open-vocabulary HWR model, but it's strictly worse than Gemma 4 E4B for the editor's purposes:

- TrOCR is single-task (HWR only). Gemma 4 E4B is one model that already serves three jobs (text, image, audio) in the editor.
- TrOCR's VisionEncoderDecoder architecture isn't supported by Unsloth's `FastVisionModel`, so you fall back to stock HuggingFace + PEFT — slower and more VRAM-hungry than the Unsloth path Gemma 4 enjoys.
- Standalone bundle (~330 MB) saves disk vs Gemma E4B (~1.5 GB), but if you're already loading Gemma for the other modalities, TrOCR is pure overhead.

Listed for completeness; not recommended unless you're shipping an HWR-only product and have no other reason to load Gemma.

**Recommendation:** stay on baseline Gemma 4 E4B for V1 (the default that just shipped). When you have time and want a meaningful accuracy bump, fine-tune via Unsloth — Path A. Path B (classifier) is a useful add-on for graceful degradation on no-WebGPU machines, not a primary replacement.

### 14.2 Voice input

A 🎤 button in the canvas tools row enables voice-to-prompt. Tap once to start recording (button turns red, status line shows "Recording…"); tap again to stop. The audio is transcribed and the transcript fills the AI prompt input in the User DSP tab. The user reviews and clicks Run as usual.

Two transcription paths, chosen automatically based on the active provider:

1. **Gemma 4 native audio** (default when Gemma is the active provider). The MediaRecorder webm blob is decoded to a 16 kHz mono Float32Array via `OfflineAudioContext` and fed to the Gemma 4 pipeline as an `audio` input. Both E2B and E4B variants have the same USM-style conformer encoder; max 30 s per clip. Same model as the rest of the AI pipeline, so no extra download.

2. **Whisper-tiny via transformers.js** (fallback when Anthropic is the active provider, or when WebGPU isn't available). Loads `Xenova/whisper-tiny.en` (~75 MB, cached after first use) via the same `@huggingface/transformers` dynamic import already used for Gemma. WebGPU is *not* required for Whisper-tiny — it uses WebAssembly with optional WebGPU acceleration — so this path covers users on machines that can't run Gemma.

The Whisper-tiny path uses the English-only variant for download size. For multilingual support, swap to `Xenova/whisper-tiny` (multilingual but slightly less accurate on English) or `Xenova/whisper-base` (~150 MB, better quality). Or — in the future — fine-tune Gemma 4 multilingually for a unified model that handles the editor's command vocabulary across more languages (see §13.6).

**Setup:**

For the Gemma path, no setup is needed beyond the WebGPU browser requirement that Gemma already needs. The model loads on first use; subsequent uses are instant. The audio encoder adds modest weight to the already-loaded Gemma pipeline (no separate download).

For the Whisper-tiny fallback, no setup is needed either. The model loads on first use; subsequent uses are instant.

**Microphone permission:** browsers prompt the user the first time `getUserMedia({ audio: true })` is called. Permission persists for the origin. If denied, the editor reports the error and the user can re-enable in browser settings.

**Use cases:**

- Speak a node-type name to create a node ("ADSR envelope") — transcript fills the AI prompt; running it generates `.gdsp` source describing that node.
- Describe a custom DSP idea in plain language ("a fuzz pedal with a tone control before the clipping stage") — transcript fills the prompt; the AI assistant generates the `.gdsp`.
- This is voice-to-prompt, *not* voice-to-direct-action. The transcript always shows in the prompt for review before any change is committed.

### 14.3 Voice commands for editor actions (deferred)

Reusing Whisper for editor control — "delete this node," "save patch," "switch to generated code," "pan left" — is a natural extension that's deferred to a later iteration. The architectural pieces are in place (microphone capture, transcription) but the command vocabulary and grammar need design:

- A wake-word or hold-to-speak modality, since unprompted always-on transcription burns tokens (cloud) or compute (local) with no benefit.
- A phrase-to-action mapping. Either rule-based (regex patterns over the transcript) or LLM-routed (transcript + tool description list → which tool to call). LLM-routed is more flexible but slower and costlier.
- Disambiguation when a phrase could match multiple actions ("save" → save .gpatch, save .gdsp, or save settings?).
- Audio playback control specifically: the editor currently has no audio playback — patches generate C++ that runs through the AlloLib build pipeline. Voice control over playback requires that infrastructure to exist first, which lives outside this editor's scope.

A reasonable implementation when this is ready: hold-to-speak via a 🎙 toolbar button (different from the 🎤 voice-to-prompt button) → transcript → if the transcript matches a registered command pattern, execute; otherwise fall back to voice-to-prompt behaviour. The command vocabulary stays small (10–20 commands) for a V1.

### 14.4 Touch (without stylus)

Plain-finger touch on the canvas behaves like a mouse: tap to select, drag a node header to move, drag port-to-port to wire. Port hit targets are enlarged on narrow viewports (§15) so they're usable with a fingertip rather than a precise pointer.

A fingertip is intentionally *not* treated as a stylus — drawing requires either explicit Draw mode (toolbar toggle) or a real `pointerType: "pen"` event. This avoids accidentally entering draw mode when the user is just trying to scroll or tap.

---

## 15. Mobile and responsive design

The desktop-first layout (248 px palette + canvas + 240 px footer) doesn't fit on phone screens. The editor detects narrow viewports via CSS media queries and JavaScript `matchMedia`, then adapts the layout.

### 15.1 Breakpoints

| Range | Layout |
|-------|--------|
| ≥ 720 px | Full desktop layout |
| 480–719 px | Tablet / narrow desktop: collapsible palette, scrollable tabs, larger ports |
| < 480 px | Phone: hide non-essential UI affordances (canvas hint, brand mark, stats) |

### 15.2 Palette — slide-out drawer

On narrow viewports, the palette is positioned absolutely off-screen and slides in from the left when the user taps a hamburger menu (☰) at top-left of the canvas. Tapping a node from the palette closes the drawer automatically so the user can immediately drop the node into place. A box-shadow on the open palette makes it visually distinct from the canvas underneath.

### 15.3 Touch-target sizing

Apple's HIG and Google's Material specs both call for 44×44 px minimum touch targets. The editor doesn't quite hit that for ports (those would dominate the node body) but increases them substantially on narrow viewports:

- Port hit area: 11×11 → 18×18 px.
- Port offset adjusted so they still align with the node edge.
- Node width: 140 → 156 px to compensate for larger port overhangs.

The port colour-coding and dashed/solid distinction are preserved.

### 15.4 Footer

- Fixed height reduced from 240 → 200 px.
- Tab row becomes horizontally scrollable to handle the four-tab row on narrow widths.
- User DSP pane's left list collapses from 200 → 100 px on viewports under 480 px.

### 15.5 Header

- Brand "Gamma · node editor" mark hidden under 480 px.
- Stats ("5 nodes · 4 connections") hidden under 720 px.
- Toolbar buttons compress (smaller padding, smaller font) under 720 px.

### 15.6 Gesture conflicts (deferred)

Several mobile-only gestures need design and aren't yet implemented:

- **Long-press for context menu** on a selected node — would replace the keyboard's Delete and Cmd-D. Conflicts with browser's native long-press selection handling on iOS Safari.
- **Pinch-to-zoom on the canvas** — currently the canvas isn't zoomable at all (deferred to milestone M1, §14). When implemented, the pinch gesture has to take precedence over browser pinch-zoom of the page itself, which requires `touch-action: none` on the canvas and careful event handling.
- **Two-finger pan** — same caveat. Browser default is page scroll; the editor needs `touch-action: pan-x pan-y` if pan is enabled, but that conflicts with pinch.
- **Virtual keyboard handling** — when the user taps the AI prompt input on a phone, the on-screen keyboard reduces visible viewport height. The footer needs to either resize gracefully or absolute-position the AI panel above the keyboard. Currently it just gets covered.

### 15.7 What's still desktop-only (and should stay)

- The User DSP textarea editor. C++ on a phone keyboard is painful regardless of UI quality. The voice-to-prompt path (§14.2) is the recommended mobile workflow for `.gdsp` authoring.
- Multi-select (drag marquee). Touch marquee selection is awkward; long-press-to-multi-select is a better fit and is part of the deferred gesture work.
- Keyboard shortcuts. Phones don't have physical keyboards; the relevant shortcuts (Delete, Save) already have on-screen equivalents (Delete button, Save button). No work needed.

---

## 16. Implementation plan

### Status — V1 prototype (complete)

The accompanying `gamma-node-editor.html` is a working V1 prototype that demonstrates everything in §§4–10:

- 56 nodes across 10 categories (full breakdown in §5).
- Search-filterable / collapsible palette (§9.2).
- Drag, connect, disconnect, delete, properties pane with expose-as-setter checkboxes (§9.5–9.6).
- Two-pattern codegen producing valid Gamma C++ (§7), including per-sample setter hoisting for param-rate edges (§7.4) and header-include minimization (§7.5).
- `.gpatch` save/load with round-trip (§4).
- Stereo output via `OutputStereo` returning `std::pair<float,float>`.

What's intentionally absent from the prototype, and what each milestone below adds:

### Milestone 1 — production polish (2 weeks)

Take the prototype to a level appropriate for daily use in MAT201:

- Pan + zoom on the canvas (§9.3). Currently fixed view.
- Undo stack with coalescing (§9.8).
- Multi-select + marquee + group drag (§9.3).
- Copy / paste / duplicate of subgraphs.
- Validation overlay: cycles without `Delay1` highlighted; disconnected `Output` flagged (§9.9).
- Replace remaining best-effort method names in the registry with verified ones from a build pass against actual Gamma source.

### Milestone 2 — IDE integration (2 weeks)

Mount inside AlloLib Studio Online:

- Modal component embedded in the IDE.
- File-tree handler for the `.gpatch` extension; double-click opens, save writes both `.gpatch` and the sibling `generated/{name}.h`.
- File watcher → header regeneration → existing C++ → WASM build.
- "Insert Gamma patch" command palette entry with the marker-comment round-trip (§3.2).

### Milestone 3 — coverage extensions (3 weeks)

Add the categories deliberately deferred from V1:

- Multi-output codegen path (binds node call to a temporary; readers index into `.first`/`.second` or `[0]`/`[1]`). Unlocks `Pan2`, `Hilbert`.
- Enum-property UI in the properties pane. Unlocks `Vowel`, and lets the four `Biquad*` variants collapse back into a single `Biquad` node with a type dropdown.
- File-path property type. Unlocks `SamplePlayer` once the IDE's WASM filesystem story is settled.
- Polyphony wrapper (§11) toggleable from the header.
- 10+ example `.gpatch` files for MAT201.

### Milestone 4 — V2 features (open-ended)

- Spatial node + AlloSphere speaker config (§12).
- Custom node types (user-defined C++ wrapping).
- Block-rate codegen (`rate: "block"`) — unlocks `DFT`, `STFT`.
- Live param sliders bound to `Parameter` instances at build time.
- Shareable patches via URL.

---

## 17. Open questions

- **`SamplePlayer` and the WASM filesystem.** The node descriptor needs a file-path property. The IDE has to marshal the chosen audio file into the Emscripten build's virtual filesystem (`--preload-file` or runtime `FS.writeFile`). Defer until the AlloLib Studio Online file-system access pattern is documented.

- **Single patch per file, or multiple?** V1: single. Multi-patch files are convenient for related synths (drum kit voices, stereo bus + reverb) but complicate the codegen-emits-one-header model. Revisit if there's user demand; the file format would need to wrap `nodes`/`edges`/`exposed` in a `patches[]` array.

- **Real-time editing** (recompile-on-change with smooth audio handoff): out of scope for V1. The user saves, the build runs, the audio engine restarts. Anything smoother requires hot-swapping which is a non-trivial Gamma extension — e.g., constructing the new patch, copying state where shape matches, atomically swapping the active pointer.

- **Method-name verification.** The V1 prototype ships several registry entries built from header inspection rather than from an actual successful build. The first integration sprint should compile a representative patch using each member node and fix anything the compiler rejects (see §5 "Verification status").

---

## 18. References

- Gamma library: https://github.com/AlloSphere-Research-Group/Gamma
- AlloLib: https://github.com/AlloSphere-Research-Group/allolib
- AlloLib Studio Online: existing project context
- Faust (functional DSP language, comparable scope): https://faust.grame.fr/
- gen~ (Max/MSP, comparable interactive patcher): https://docs.cycling74.com/max8/vignettes/gen_overview
- Reaktor Core (closest analogue in the commercial space): https://www.native-instruments.com/en/products/komplete/synths/reaktor-6/

---

*Last revised: prototype phase. This document tracks the prototype HTML implementation; deviations should be reflected here before being merged into the main editor.*
