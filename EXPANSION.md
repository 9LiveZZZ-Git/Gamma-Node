# Gamma Node Editor — Expansion Roadmap

This document is a forward-looking companion to `SPEC.md`. The V1 prototype covers ~55 nodes from the Gamma library proper; this roadmap covers **what's missing for a professional DSP environment**, plus two bigger architectural additions: a custom `.gdsp` user-node format and a built-in editor for authoring them.

The first sections are a (long) menu of concrete nodes to add. Each entry is tagged with a complexity marker so it's easy to see what's a quick registry update vs. what needs new infrastructure:

| Tag | Meaning |
|-----|---------|
| `[gamma]`     | Wraps an existing Gamma class. Just add a registry entry. |
| `[composite]` | Built from existing Gamma primitives via a small wrapper class. |
| `[new-cpp]`   | Needs new C++ DSP code (no Gamma equivalent or substantially different design). |
| `[multi-out]` | Needs the multi-output codegen path (§13 M3). |
| `[block]`     | Needs block-rate codegen (§13 M4). |
| `[enum]`      | Needs enum/dropdown property UI (§13 M3). |
| `[host]`      | Needs host integration (MIDI, OSC, file IO, AlloLib `Parameter`). |
| `[gpu]`       | WebGPU compute path. Does not pass through C++/WASM. |
| `[viz]`       | Visualization sink — node renders something into its body, no audio output. |

---

## Part 1 · Easy wins (more from Gamma proper)

Gamma classes that exist but were deferred from V1, plus a few that are templates of templates:

| Node | Class | Notes | Tag |
|------|-------|-------|-----|
| `Pan2` | `gam::Pan2<>` | Equal-power panner; returns `Vec2`. | `[gamma]` `[multi-out]` |
| `Hilbert` | `gam::Hilbert<>` | Returns real + imaginary; analytic-signal helper. | `[gamma]` `[multi-out]` |
| `SamplePlayer` | `gam::SamplePlayer<>` | Disk-loaded buffer with rate + position. Needs file-path property. | `[gamma]` `[host]` |
| `Vowel` | (formant filter bank) | 5-vowel formant filter; needs vowel-index dropdown. | `[gamma]` `[enum]` |
| `Sweep` | `gam::Sweep<>` | Linear sweep generator. | `[gamma]` |
| `TableSine` | `gam::TableSine<>` | Pre-baked sine table; cheaper than `Sine` for fixed rates. | `[gamma]` |
| `Triangle` | (LFO mode) | Bandlimited triangle. Currently reachable only via `LFO`. | `[gamma]` |
| `ChebyN<8>` | `gam::ChebyN<8>` | 8-coefficient Chebyshev waveshaper. | `[gamma]` `[enum]` |
| `Recorder` | `gam::Recorder<>` | Captures into a circular buffer. | `[gamma]` `[host]` |
| `OnsetDetector` | `gam::OnsetDetector` | Spectral-flux onset detector from `Analysis.h`. | `[gamma]` `[block]` |
| `STFT` | `gam::STFT` | Short-time FFT analyzer/resynthesizer. | `[gamma]` `[block]` |
| `Voices<8>` | `gam::Voices<…, 8>` | Polyphony manager — better surfaced as a patch-level toggle than a node, but worth offering as a node too. | `[gamma]` `[enum]` |

---

## Part 2 · Gen-like primitives (Max/MSP gen~ vocabulary)

These are template (inline) nodes — no member declaration, just expression substitution. Easy to add in bulk because they all follow the same pattern: `template: "func({in})"` or `template: "({a} OP {b})"`. Almost all `[gamma]` because they reduce to single C++ expressions.

**Math, single-arg**

| Node | Template | |
|------|----------|---|
| `Sin` | `sinf({in})` | `[gamma]` |
| `Cos` | `cosf({in})` | `[gamma]` |
| `Tan` | `tanf({in})` | `[gamma]` |
| `Asin` | `asinf({in})` | `[gamma]` |
| `Acos` | `acosf({in})` | `[gamma]` |
| `Atan` | `atanf({in})` | `[gamma]` |
| `Sinh` | `sinhf({in})` | `[gamma]` |
| `Cosh` | `coshf({in})` | `[gamma]` |
| `Tanh` | `tanhf({in})` | `[gamma]` |
| `Exp` | `expf({in})` | `[gamma]` |
| `Exp2` | `exp2f({in})` | `[gamma]` |
| `Log` | `logf({in})` | `[gamma]` |
| `Log2` | `log2f({in})` | `[gamma]` |
| `Log10` | `log10f({in})` | `[gamma]` |
| `Sqrt` | `sqrtf({in})` | `[gamma]` |
| `Cbrt` | `cbrtf({in})` | `[gamma]` |
| `Sign` | `({in} > 0.f ? 1.f : ({in} < 0.f ? -1.f : 0.f))` | `[gamma]` |
| `Floor` | `floorf({in})` | `[gamma]` |
| `Ceil` | `ceilf({in})` | `[gamma]` |
| `Round` | `roundf({in})` | `[gamma]` |
| `Trunc` | `truncf({in})` | `[gamma]` |
| `Frac` | `({in} - floorf({in}))` | `[gamma]` |
| `Square` | `({in} * {in})` | `[gamma]` |
| `Cube` | `({in} * {in} * {in})` | `[gamma]` |
| `Recip` | `(1.f / {in})` | `[gamma]` |

**Math, two-arg**

| Node | Template | |
|------|----------|---|
| `Pow` | `powf({a}, {b})` | `[gamma]` |
| `Atan2` | `atan2f({a}, {b})` | `[gamma]` |
| `Mod` | `fmodf({a}, {b})` | `[gamma]` |
| `Hypot` | `hypotf({a}, {b})` | `[gamma]` |
| `Min` | `fminf({a}, {b})` | `[gamma]` |
| `Max` | `fmaxf({a}, {b})` | `[gamma]` |
| `Div` | `({a} / {b})` | `[gamma]` |

**Comparison / logic** (output is `1.f` or `0.f`)

| Node | Template | |
|------|----------|---|
| `Eq` | `({a} == {b} ? 1.f : 0.f)` | `[gamma]` |
| `Neq` | `({a} != {b} ? 1.f : 0.f)` | `[gamma]` |
| `Lt` | `({a} < {b} ? 1.f : 0.f)` | `[gamma]` |
| `Gt` | `({a} > {b} ? 1.f : 0.f)` | `[gamma]` |
| `Lte` | `({a} <= {b} ? 1.f : 0.f)` | `[gamma]` |
| `Gte` | `({a} >= {b} ? 1.f : 0.f)` | `[gamma]` |
| `And` | `(({a} > 0.f && {b} > 0.f) ? 1.f : 0.f)` | `[gamma]` |
| `Or` | `(({a} > 0.f \|\| {b} > 0.f) ? 1.f : 0.f)` | `[gamma]` |
| `Not` | `({in} > 0.f ? 0.f : 1.f)` | `[gamma]` |
| `Xor` | `(({a} > 0.f) != ({b} > 0.f) ? 1.f : 0.f)` | `[gamma]` |

**Selection / routing**

| Node | Template | |
|------|----------|---|
| `If` | `({cond} > 0.f ? {a} : {b})` | `[gamma]` |
| `Selector2` | 2-input multiplexer driven by `sel` param | `[gamma]` |
| `Selector4` | 4-input mux | `[gamma]` |
| `Switch` | 1-in, N-out demux | `[gamma]` |
| `Crossfade` | `((1.f - {x}) * {a} + {x} * {b})` | `[gamma]` |

**Range mapping** (already have `Scale` and `Clip`)

| Node | Template | |
|------|----------|---|
| `Wrap` | `(fmodf(fmodf({in} - {min}, {max} - {min}) + {max} - {min}, {max} - {min}) + {min})` | `[gamma]` |
| `Fold` | bounce-fold reflection between min/max | `[gamma]` |
| `Lerp` | `({a} + {x} * ({b} - {a}))` | `[gamma]` |
| `Smoothstep` | Hermite smooth interpolation | `[gamma]` |
| `Quantize` | Round to nearest `step` | `[gamma]` |
| `Polynomial` | `Σ aᵢ · xⁱ` for fixed-degree polynomial waveshaping | `[gamma]` |

**Stateful primitives** (need members — `[composite]` instead of pure template)

| Node | Behaviour | |
|------|-----------|---|
| `Counter` | Integer accumulator, resets on gate | `[composite]` |
| `Phasor` | 0..1 ramp at given frequency | `[composite]` |
| `Accum` | Sample-by-sample summation | `[composite]` |
| `Slew` | First-order slew limiter (separate up/down rates) | `[composite]` |
| `SampleAndHold` | Holds input value when triggered | `[composite]` |
| `Latch` | Like S&H but level-triggered | `[composite]` |
| `Delta` | Difference between current and previous sample | `[composite]` |
| `History` | Read N samples back (variable-length tap) | `[composite]` |
| `Edge` | Outputs 1 sample of `1.f` on rising edge | `[composite]` |
| `Change` | Outputs `1.f` while input is changing | `[composite]` |
| `Glide` | Exponential portamento between target values | `[composite]` |
| `MovingAvgN` | N-sample running average | `[composite]` |

---

## Part 3 · Composite synthesis nodes

Things that don't exist as a single Gamma class but compose well from primitives. Each gets its own helper class emitted alongside the patch.

**FM / phase modulation**

| Node | Description | |
|------|-------------|---|
| `FMOp` | DX-style operator: sine + envelope + level + ratio + detune | `[composite]` |
| `FM4` | 4-operator FM with selectable algorithm (a la DX21) | `[composite]` `[enum]` |
| `FM6` | 6-operator FM with DX7-compatible 32 algorithms | `[composite]` `[enum]` |
| `PMOsc` | Single-op phase modulation (input modulates sine phase) | `[composite]` |
| `FBSine` | Self-feedback sine (Yamaha-style) | `[composite]` |
| `RingMod` | Bipolar multiplier (already covered by `Mul`, but worth a named node) | `[gamma]` |

**Wavetable / vector**

| Node | Description | |
|------|-------------|---|
| `WavetableOsc` | Single-cycle table; user supplies `float[N]` table | `[composite]` `[host]` |
| `WavetableBank` | Bank of N tables, scannable by `position` param | `[composite]` |
| `Wavescan2D` | XY position into 2D table grid (vector synth) | `[composite]` |
| `MultiPhasorOsc` | Sum of harmonics with independent phases | `[composite]` |
| `AdditiveOsc` | N partials with per-partial amp + freq | `[composite]` |

**Karplus-Strong family** (Gamma's `PluckedString` is one variant)

| Node | Description | |
|------|-------------|---|
| `KSString` | Classic K-S with allpass + lowpass | `[composite]` |
| `KSDamped` | K-S with damping control | `[composite]` |
| `KSExciter` | Pluck/strike noise burst → K-S | `[composite]` |
| `WaveguideString` | Two delay lines with reflections (more accurate string) | `[new-cpp]` |
| `WaveguideTube` | Open/closed tube model | `[new-cpp]` |

**Granular**

| Node | Description | |
|------|-------------|---|
| `GranularPlayer` | Asynchronous grain cloud from a sample | `[composite]` `[host]` |
| `GrainScheduler` | Trigger pattern + grain shape control | `[composite]` |
| `LiveGranulator` | Granulates the input signal in real time | `[new-cpp]` |

**Distortion / nonlinearity**

| Node | Description | |
|------|-------------|---|
| `SoftClip` | `tanhf({in})` | `[gamma]` |
| `HardClip` | Already covered by `Clip` | `[gamma]` |
| `Foldback` | Wave folding (Buchla-style) | `[composite]` |
| `BitCrush` | Bit-depth reduction + sample-rate decimation | `[composite]` |
| `TubeSat` | Class-A tube saturation curve | `[composite]` |
| `TapeSat` | Tape compression + soft saturation | `[composite]` |
| `Diode` | Asymmetric diode clipping | `[composite]` |
| `WaveShaper` | Look-up-table waveshaper from user-supplied curve | `[new-cpp]` `[host]` |

**Modulation effects**

| Node | Description | |
|------|-------------|---|
| `Chorus` | LFO-modulated short delay (existing `Chorus` in Effects.h fits) | `[gamma]` |
| `Flanger` | Comb-based, feedback flanger | `[composite]` |
| `Phaser4` | 4-stage allpass phaser | `[composite]` |
| `Phaser6` | 6-stage | `[composite]` |
| `Tremolo` | LFO * input | `[composite]` |
| `Vibrato` | Pitch wobble via short delay modulation | `[composite]` |
| `AutoPan` | LFO-driven stereo panner | `[composite]` `[multi-out]` |
| `AutoFilter` | LFO-modulated filter cutoff | `[composite]` |

**Dynamics**

| Node | Description | |
|------|-------------|---|
| `Compressor` | EnvFollow + gain calc (knee/ratio/attack/release) | `[composite]` |
| `Limiter` | Lookahead peak limiter | `[composite]` |
| `Expander` | Inverse-compressor below threshold | `[composite]` |
| `NoiseGate` | Hard gate with hysteresis | `[composite]` |
| `Sidechain` | Compressor with separate key input | `[composite]` |
| `MultibandComp` | 3-band crossover + per-band compressor | `[composite]` |
| `Ducker` | Auto-attenuates A when B exceeds threshold | `[composite]` |
| `OTT` | Upward + downward 3-band (Xfer-style) | `[composite]` |

**Time-based effects**

| Node | Description | |
|------|-------------|---|
| `TapeDelay` | Delay with wow/flutter | `[composite]` |
| `BBDDelay` | Bucket-brigade emulation (chorus-flavoured delay) | `[composite]` |
| `FilterDelay` | Delay with filter in the feedback path | `[composite]` |
| `PingPong` | Stereo delay with channel-bouncing feedback | `[composite]` `[multi-out]` |
| `MultiTap` | Multiple taps from a single delay line | `[composite]` `[multi-out]` |
| `GrainDelay` | Delay output is granulated | `[composite]` |
| `TempoSyncDelay` | BPM-synced delay times (1/4, 1/8, 1/16…) | `[composite]` `[host]` |

**Reverbs**

| Node | Description | |
|------|-------------|---|
| `Plate` | 4×4 FDN plate reverb | `[new-cpp]` |
| `Spring` | Allpass-cascade spring emulation | `[new-cpp]` |
| `Hall` | Larger FDN with predelay | `[new-cpp]` |
| `Room` | Smaller, denser early reflections | `[new-cpp]` |
| `FDN8` | Generic 8-line feedback delay network | `[new-cpp]` |
| `FreeVerb` | Schroeder reverb (Comb + Allpass) | `[composite]` |
| `ConvolutionReverb` | Long-IR convolution; FFT-based | `[new-cpp]` `[block]` |
| `ShimmerReverb` | Reverb + pitch-shift in feedback | `[new-cpp]` |

**Stereo / utility**

| Node | Description | |
|------|-------------|---|
| `MidSide` | L/R → M/S encoder | `[composite]` `[multi-out]` |
| `SideMid` | M/S → L/R decoder | `[composite]` `[multi-out]` |
| `StereoWidener` | Side-channel boost | `[composite]` `[multi-out]` |
| `HaasDelay` | Single-channel short delay for stereo width | `[composite]` `[multi-out]` |
| `MonoMaker` | Force mono below cutoff | `[composite]` `[multi-out]` |
| `PhaseInvert` | Multiply by -1 (already `Neg`, but named) | `[gamma]` |

---

## Part 4 · Filters (beyond Biquad)

The current registry stops at second-order. Pro-grade DSP wants more.

| Node | Description | |
|------|-------------|---|
| `StateVariableFilter` | Simultaneous LP/HP/BP/BR outputs from one structure | `[new-cpp]` `[multi-out]` |
| `LadderFilter` | Moog-style 4-pole 24 dB/oct with self-oscillation | `[new-cpp]` |
| `DiodeLadder` | TB-303-style ladder | `[new-cpp]` |
| `SallenKey` | 2-pole Sallen-Key topology (more analog character than Biquad) | `[new-cpp]` |
| `MS20Filter` | Korg MS-20 OTA filter emulation | `[new-cpp]` |
| `K35Filter` | Korg 35 lowpass | `[new-cpp]` |
| `SteinerParker` | Steiner-Parker filter | `[new-cpp]` |
| `FormantFilter` | Configurable vowel formant bank | `[new-cpp]` `[enum]` |
| `Butterworth4` | 4th-order Butterworth | `[new-cpp]` |
| `Butterworth8` | 8th-order Butterworth | `[new-cpp]` |
| `LinkwitzRiley` | LR2/LR4 crossover filters | `[new-cpp]` `[multi-out]` |
| `ParametricEQ` | Single-band peaking with freq/gain/Q | `[gamma]` |
| `EQ3` | 3-band shelf+peak+shelf | `[composite]` |
| `EQ8` | 8-band parametric (Pultec/Massive style) | `[composite]` |
| `GraphicEQ` | 31-band fixed-Q parametric | `[composite]` |
| `CombArray` | Bank of `N` parallel comb filters (chord filter) | `[composite]` |
| `KarplusFilter` | Lowpass + allpass tuned for K-S delay loops | `[composite]` |

---

## Part 5 · Analyzers

Most current Gamma analysis is `EnvFollow` and `ZeroCross`. Real DSP wants more.

| Node | Description | |
|------|-------------|---|
| `RMSDetector` | Windowed RMS | `[composite]` |
| `PeakDetector` | True peak with hold/release | `[composite]` |
| `TruePeak` | Oversampled true-peak (ITU-R BS.1770) | `[new-cpp]` |
| `LoudnessLUFS` | Integrated, short-term, momentary LUFS | `[new-cpp]` `[block]` |
| `DCMeter` | DC offset measurement | `[composite]` |
| `ZeroCrossingRate` | ZCR per block (rough fundamental-freq estimator) | `[composite]` `[block]` |
| `SpectralCentroid` | "Brightness" — first moment of spectrum | `[new-cpp]` `[block]` |
| `SpectralRolloff` | Frequency below which 85% of energy lies | `[new-cpp]` `[block]` |
| `SpectralFlatness` | Wiener entropy (tonal vs. noisy) | `[new-cpp]` `[block]` |
| `SpectralFlux` | Frame-to-frame magnitude difference | `[new-cpp]` `[block]` |
| `MFCC` | Mel-frequency cepstral coefficients (ML-grade timbre features) | `[new-cpp]` `[block]` `[multi-out]` |
| `Chromagram` | 12-bin pitch class histogram | `[new-cpp]` `[block]` `[multi-out]` |
| `PitchTracker` | Autocorrelation-based F0 estimator | `[new-cpp]` `[block]` |
| `YINTracker` | YIN algorithm (more accurate than autocorr) | `[new-cpp]` `[block]` |
| `KeyEstimator` | Key + mode classification from chroma | `[new-cpp]` `[block]` |
| `BeatTracker` | Tempo + beat phase estimation | `[new-cpp]` `[block]` |
| `OnsetDetector` | Spectral-flux based note onsets | `[gamma]` `[block]` |
| `TransientDetector` | Sample-rate transient detector (for compression sidechain) | `[composite]` |
| `EnvelopeShape` | Attack/decay slope estimation | `[composite]` |

---

## Part 6 · Spectral processing

Frequency-domain effects. All are `[block]` because FFT-based.

| Node | Description | |
|------|-------------|---|
| `SpectralFreeze` | Lock magnitudes, randomize phases (a la Paulstretch's freeze) | `[new-cpp]` `[block]` |
| `SpectralBlur` | Low-pass the spectrogram in time | `[new-cpp]` `[block]` |
| `SpectralGate` | Threshold gate per-bin | `[new-cpp]` `[block]` |
| `SpectralSubtract` | Subtract reference spectrum (denoise) | `[new-cpp]` `[block]` |
| `SpectralRobotize` | Phase randomization | `[new-cpp]` `[block]` |
| `SpectralWarp` | Frequency-axis nonlinear warp | `[new-cpp]` `[block]` |
| `PitchShifter` | Phase-vocoder pitch shift | `[new-cpp]` `[block]` |
| `TimeStretch` | Phase-vocoder stretch (decoupled from pitch) | `[new-cpp]` `[block]` |
| `Vocoder` | Channel-bank vocoder (carrier × modulator envelopes) | `[composite]` |
| `CrossSynth` | Spectral envelope of A imposed on excitation of B | `[new-cpp]` `[block]` |

---

## Part 7 · MIDI and host input

These nodes don't have audio inputs — they source values from outside the audio graph. Each generates a setter on the patch class that the host (`AlloApp`) calls.

| Node | Description | |
|------|-------------|---|
| `MIDINoteIn` | Last-note pitch + velocity + gate (mono priority) | `[host]` |
| `MIDIPolyIn` | Per-voice note allocation (works with `Voices` wrapper) | `[host]` |
| `MIDICCIn` | Specific CC# with optional smoothing | `[host]` |
| `MIDIPitchBend` | -1..1 with selectable range | `[host]` |
| `MIDIChannelPressure` | Mono aftertouch | `[host]` |
| `MIDIPolyAftertouch` | Per-key pressure | `[host]` |
| `MIDIClock` | 24 PPQ MIDI clock → BPM + phase | `[host]` |
| `MIDIRaw` | Raw MIDI message stream (for advanced routing) | `[host]` |
| `ParameterIn` | Bound to `al::Parameter` — connects to AlloLib GUI sliders | `[host]` |
| `ParameterOut` | Sends value back to a `Parameter` (for analysis displays) | `[host]` |
| `KeyboardIn` | Computer keyboard → note (test without MIDI hardware) | `[host]` |
| `MouseXY` | Mouse position normalized to [-1,1] | `[host]` |
| `TouchIn` | Multi-touch pad input | `[host]` |
| `OSCIn` | OSC message at given path | `[host]` |
| `OSCOut` | Send OSC message from audio graph | `[host]` |
| `GamepadAxis` | Game controller axis | `[host]` |
| `IMUIn` | Phone/tablet accelerometer (via OSC bridge) | `[host]` |

---

## Part 8 · Sequencing and rhythm

| Node | Description | |
|------|-------------|---|
| `Clock` | BPM-driven pulse generator | `[composite]` `[host]` |
| `ClockDivider` | /2, /3, /4 etc. dividers | `[composite]` |
| `ClockMultiplier` | x2, x3, x4 | `[composite]` |
| `StepSequencer` | 16-step value sequencer | `[composite]` `[multi-out]` |
| `Step32` | 32-step | `[composite]` |
| `EuclideanRhythm` | Bjorklund's algorithm — N hits over M steps | `[composite]` |
| `ProbGate` | Pass-through gate with per-trigger probability | `[composite]` |
| `RandomGate` | Random gate at given rate | `[composite]` |
| `TurningPoint` | Turing-machine style probabilistic looper | `[composite]` |
| `MarkovGen` | First-order Markov chain over note set | `[new-cpp]` |
| `ChordGen` | Note → chord member notes | `[composite]` `[multi-out]` |
| `ScaleQuantizer` | Snap to major/minor/modes/microtonal | `[composite]` `[enum]` |
| `Arp` | Arpeggiator with up/down/random/asplayed modes | `[composite]` `[enum]` `[multi-out]` |
| `NoteSlicer` | Cycle through pre-defined note list | `[composite]` |

---

## Part 9 · Spatial / multichannel

| Node | Description | |
|------|-------------|---|
| `Pan2` | Already in Part 1 | `[gamma]` `[multi-out]` |
| `Pan3` | LR + Center | `[composite]` `[multi-out]` |
| `Pan4` | Quadraphonic | `[composite]` `[multi-out]` |
| `Pan8` | 7.1 surround | `[composite]` `[multi-out]` |
| `AmbiEncode1` | 1st-order ambisonic (W,X,Y,Z) | `[composite]` `[multi-out]` |
| `AmbiEncode3` | 3rd-order ambisonic (16 channels) | `[composite]` `[multi-out]` |
| `AmbiDecode` | Ambisonic → speaker array | `[composite]` `[multi-out]` |
| `BinauralHRTF` | HRTF-based binaural rendering | `[new-cpp]` `[multi-out]` |
| `DistanceAtten` | 1/r attenuation + air absorption | `[composite]` |
| `DopplerShift` | Velocity-driven pitch shift | `[composite]` |
| `AlloSphereSpatializer` | Maps to AlloSphere dome speaker layout | `[new-cpp]` `[multi-out]` `[host]` |

---

## Part 10 · Visualization sinks

These don't produce audio — they render a small display inside the node body, using its data input(s).

| Node | Description | |
|------|-------------|---|
| `Scope` | Time-domain waveform scope | `[viz]` |
| `XYScope` | XY (Lissajous) scope | `[viz]` |
| `SpectrumDisplay` | Magnitude spectrum (FFT) | `[viz]` `[block]` |
| `Spectrogram` | 2D time-frequency display | `[viz]` `[block]` |
| `Meter` | Peak/RMS bargraph | `[viz]` |
| `LUFSMeter` | Loudness meter with target line | `[viz]` `[block]` |
| `Histogram` | Value distribution histogram | `[viz]` |
| `Phasometer` | Goniometer (correlation) | `[viz]` |
| `ValueReadout` | Numeric display of param value | `[viz]` |

These integrate into the existing per-sample model by writing into a small ring buffer the node's render code reads on a 30 Hz UI frame timer.

---

## Part 11 · GPU compute (WebGPU)

WebGPU compute is fundamentally different from per-sample C++. Three architectural realities:

1. **Block-rate.** Compute shaders process buffers, not single samples. Any GPU node has a buffer-sized boundary.
2. **JS-side, not WASM-side.** The audio thread (Web Audio `AudioWorkletProcessor`) talks to WebGPU; the C++ patch can't.
3. **Latency.** GPU dispatch + readback adds 1–2 buffers of latency, making GPU nodes unsuitable for hot signal paths.

The cleanest way to fit GPU into this editor: **a GPU node is a tap on the audio bus.** The C++ patch writes its mono/stereo output to a JS-readable buffer; the JS side runs the configured GPU compute pipeline; the result is mixed back via a return tap before being sent to the device. Inside the editor, a GPU node looks like an `Effect` node, but the codegen emits both C++ scaffolding (write the bus) and JS metadata (the shader to run).

| Node | Description | |
|------|-------------|---|
| `GPUConvolution` | Long-IR convolution on GPU (1000+ ms IRs cheap) | `[gpu]` `[block]` |
| `GPUFFT` | Forward + inverse FFT on GPU; useful as a building block | `[gpu]` `[block]` |
| `GPUSpectralFreeze` | FFT freeze with 100k+ bins | `[gpu]` `[block]` |
| `GPUWaveshape` | Lookup waveshape from a 4096-sample texture | `[gpu]` |
| `GPUGranular` | Massively parallel grain synthesizer (1000s of grains) | `[gpu]` `[block]` |
| `GPUPaulstretch` | Real-time Paulstretch | `[gpu]` `[block]` |
| `GPUNeural` | Run a small NN inference per buffer (timbre transfer, pitch detection) | `[gpu]` `[block]` |
| `GPUCustom` | User-supplied WGSL shader, bound to input/output buffers | `[gpu]` `[block]` `[host]` |

GPU nodes need a separate runtime story — see "GPU pipeline" below.

---

## Part 12 · "Different types of paths" — envelope shapes

The current envelope nodes (`AD`, `ADSR`, `Decay`, `Seg`, `SegExp`) cover the basics. Pro DSP wants more shape variety:

| Node | Description | |
|------|-------------|---|
| `LinearEnv` | Pure linear-segment N-stage envelope | `[gamma]` |
| `ExpEnv` | Exponential N-stage (already roughly `Env<N>` w/ negative curvature) | `[gamma]` |
| `LogEnv` | Logarithmic approach | `[gamma]` |
| `SCurveEnv` | Sigmoidal segments | `[composite]` |
| `BezierPath` | User-drawn Bezier curve, sampled along trigger duration | `[new-cpp]` `[host]` |
| `MultiSegEnv8` | 8-segment env with per-segment curve + level + sustain point | `[gamma]` |
| `LoopEnv` | Loops between two break-points (LFO with envelope shape) | `[gamma]` |
| `RandomEnv` | Each trigger picks new random target levels | `[composite]` |
| `MorphEnv` | Crossfade between two envelope shapes | `[composite]` |
| `TempoSyncEnv` | Length is BPM-synced (1/4, 1/8…) | `[composite]` `[host]` |
| `Trapezoid` | Attack-hold-release with no curve | `[composite]` |
| `PerlinEnv` | Smooth random walk (Perlin noise driven) | `[new-cpp]` |
| `BrownianEnv` | Random-walk envelope | `[new-cpp]` |

---

# Custom user nodes — the `.gdsp` format

The biggest leap from V1: let users author their own node types in C++ and have them appear in the palette like built-ins.

## Format

A `.gdsp` file is a **single C++ class** preceded by a metadata header in `// @gdsp-*` comments:

```cpp
// @gdsp-name        BitCrush
// @gdsp-category    UserDSP
// @gdsp-description Sample-rate and bit-depth reducer
// @gdsp-color       #c8e85a
// @gdsp-input       in    audio
// @gdsp-input       bits  param  8
// @gdsp-input       rate  param  0.5
// @gdsp-output      out   audio
// @gdsp-method      bits  setBits

class BitCrush {
    float held = 0.f;
    float phase = 0.f;
    float rate_  = 0.5f;
    int   bits_  = 8;
public:
    void rate(float v)    { rate_ = v; }
    void setBits(float v) { bits_ = (int)v; }

    float operator()(float in) {
        phase += rate_;
        if (phase >= 1.f) {
            phase -= 1.f;
            float step = float(1 << bits_);
            held = floorf(in * step) / step;
        }
        return held;
    }
};
```

### Header directives

| Directive | Required | Meaning |
|-----------|----------|---------|
| `@gdsp-name` | yes | C++ class name; also the palette entry name |
| `@gdsp-category` | yes | Palette category. New categories are appended automatically. |
| `@gdsp-description` | no | Tooltip + properties-pane summary |
| `@gdsp-color` | no | `#rrggbb` strip + dot color (defaults to chartreuse) |
| `@gdsp-input` | ≥1 | `<name> <audio\|param\|gate> [default]` |
| `@gdsp-output` | ≥1 | `<name> <audio\|param>` |
| `@gdsp-method` | no | Maps `<param>` to a non-identity setter `<method>` |
| `@gdsp-gate` | no | Maps `<gate>` to a method other than `reset` |
| `@gdsp-header` | no | Additional `#include` to inject (e.g. for STL math) |

### Class shape

For a single-input single-output node, the class must define:

- One setter per param: either `void <paramName>(float)` (default) or `void <method>(float)` if `@gdsp-method` redirects it.
- One `void <gateName>()` per gate input — defaults to `void reset()`.
- `float operator()(float in)` for nodes with one audio input, or `float operator()()` for sources.

Multi-output user nodes need the same multi-output codegen path that built-ins do (Part 1 Pan2/Hilbert) — deferred until that ships.

### Codegen integration

When a patch uses a user DSP node, the generated header looks like:

```cpp
#pragma once
#include <Gamma/Gamma.h>
// ... patch-required Gamma headers ...

// ---- User DSP ----
class BitCrush {
    /* user's class body verbatim, header comments stripped */
};
class TubeSaturator {
    /* … */
};

// ---- Patch ----
class MyPatch {
    BitCrush  n7;
    TubeSaturator n8;
    // ... built-in Gamma members ...
public:
    // ... ctor, setters, operator() ...
};
```

User classes are emitted in the order they were registered, deduplicated, and only included if a node of that type appears in the patch.

### Storage

V1 prototype: in-memory only (lost on reload). V2: persist as files in a `.gdsp/` folder in the project tree, scanned on editor load. The file format is just `.gdsp` (single class per file, named after the class). Multiple-class files are not supported — keeps the file-tree → palette mapping 1:1.

### Library distribution

Once `.gdsp` is in place, the obvious next move is a community library — a folder of contributed `.gdsp` files (e.g., `community-gdsp/svf.gdsp`, `community-gdsp/moog-ladder.gdsp`). The palette gets a "Community" sub-category that scans this folder.

---

# Bottom editor view

Add a fourth tab to the bottom panel: **User DSP**.

## Layout

```
┌────────────────────────────────────────────────────────────┐
│ Properties  │  Generated C++  │  .gpatch JSON  │ User DSP* │  ← tabs
├────────────────────────────────────────────────────────────┤
│ ┌──────────────┐ ┌─────────────────────────────────────┐  │
│ │ User DSP     │ │ // @gdsp-name BitCrush              │  │
│ │              │ │ // @gdsp-category UserDSP           │  │
│ │ ▸ BitCrush   │ │ // @gdsp-input  in    audio         │  │
│ │ ▸ TubeSat    │ │ // @gdsp-input  bits  param 8       │  │
│ │ ▸ SVF        │ │ // @gdsp-output out   audio         │  │
│ │              │ │                                      │  │
│ │ [+ New]      │ │ class BitCrush {                     │  │
│ │              │ │   ...                                │  │
│ │              │ │ };                                   │  │
│ │              │ │                                      │  │
│ │              │ │ ┌───────┐ ┌──────────┐ ┌─────────┐  │  │
│ │              │ │ │Save & │ │Validate  │ │ Export  │  │  │
│ │              │ │ │Add    │ │only      │ │ .gdsp   │  │  │
│ │              │ │ └───────┘ └──────────┘ └─────────┘  │  │
│ └──────────────┘ └─────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

- Left column: list of currently-loaded user DSP files with hover-to-select.
- Right pane: code editor with C++ syntax highlighting. CodeMirror or Monaco (CodeMirror 6 is lighter-weight and serves the prototype well).
- Buttons:
  - **Save & Add** — parse, validate, register the type, refresh the palette. Replaces the existing entry if the name matches.
  - **Validate only** — parse and report errors without registering. Good for iterating on a class that's already in use.
  - **Export .gdsp** — download the current source as a `.gdsp` file.

## Validation pipeline

When the user clicks Save & Add:

1. Parse `// @gdsp-*` comments. Emit clear errors for missing required fields.
2. Light syntax check: regex-based scan for `class <Name>` matching `@gdsp-name`, presence of an `operator()` declaration, and that all declared inputs/outputs/methods correspond to expected method signatures. The browser can't fully type-check C++, so this is best-effort.
3. **Smoke compile** (V2): post the source to a server-side Emscripten endpoint that compiles a stub `int main(){ MyClass c; return 0; }` and returns errors. Until that exists, validation stays advisory.

## Registry interaction

When a user DSP node is registered:

```js
TYPES["BitCrush"] = {
  category: "UserDSP",
  color: "#c8e85a",
  header: null,
  description: "Sample-rate and bit-depth reducer",
  cppType: "BitCrush",
  ins: [{n:"in", t:"audio"}, {n:"bits", t:"param"}, {n:"rate", t:"param"}],
  outs: [{n:"out", t:"audio"}],
  params: { bits: 8, rate: 0.5 },
  methods: { bits: "setBits", rate: "rate" },
  isUserDsp: true   // codegen flag
};
USER_DSP_SOURCES["BitCrush"] = /* class body */;
```

The palette re-renders, the new node appears under its category, and from that point it behaves identically to a built-in.

## Persistence

In the standalone HTML prototype: localStorage (the file is loaded as a normal page, not an artifact). On load, scan `localStorage.gdsp:*` keys and rehydrate the registry.

In AlloLib Studio Online integration: the IDE's file system. `.gdsp/` directory adjacent to `.gpatch/`. File watcher → palette refresh.

---

# GPU pipeline

The C++ → WASM build is for sample-rate DSP. WebGPU adds a **parallel pipeline** for block-rate processing. The architecture:

```
┌──────────────────┐      ┌───────────────────┐      ┌──────────────────┐
│   AudioWorklet   │      │   WebGPU compute  │      │  AudioWorklet    │
│   (C++/WASM)     │ ───→ │   (per-block)     │ ───→ │  output mix      │
│   patch()        │      │   shaders         │      │                  │
└──────────────────┘      └───────────────────┘      └──────────────────┘
        │                                                      │
        └────────── direct path (low latency) ─────────────────┘
```

Inside the editor, GPU nodes attach to a **send/return bus**: any audio wire passing through a GPU node is intercepted by the JS host, routed through the configured WebGPU pipeline, and mixed back. The codegen emits a small bus-accessor in the C++ patch (a `setBus(int idx, float* buffer)` method); the JS side reads/writes those buffers and dispatches compute.

For a `GPUCustom` node, the user attaches a WGSL shader file the same way they attach a `.gdsp` — via the User DSP editor, but with a separate `.wgsl` extension and slightly different metadata directives:

```wgsl
// @wgsl-name MyShader
// @wgsl-category GPUCustom
// @wgsl-input  in   buffer  size=512
// @wgsl-input  gain param
// @wgsl-output out  buffer  size=512

@group(0) @binding(0) var<storage, read>       in_buf:  array<f32>;
@group(0) @binding(1) var<storage, read_write> out_buf: array<f32>;
@group(0) @binding(2) var<uniform>             gain:    f32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    out_buf[id.x] = in_buf[id.x] * gain;
}
```

GPU is its own milestone — V3 territory. Mentioning it here so the architecture has a place for it without locking in details prematurely.

---

# Implementation order

A pragmatic recommendation, optimizing for "biggest unlock per week of work":

### Wave 1 — quick wins (1 week)

Pure registry additions, no new infrastructure:

- All Part 2 single-arg and two-arg math primitives (~40 nodes, all `[gamma]`, all template-based)
- All Part 2 comparison/logic nodes (~10)
- All Part 2 selection/routing templates (~5)
- The `[gamma]` entries from Part 1 that don't need new infrastructure (`Sweep`, `TableSine`, `Triangle`)
- `SoftClip`, `RingMod`, `PhaseInvert` from Part 3 (template-based)

Net: ~60 new nodes, no UI changes.

### Wave 2 — User DSP (2 weeks)

Self-contained feature, unblocks community contribution:

- Bottom-panel "User DSP" tab
- `.gdsp` parser
- CodeMirror integration
- Codegen integration (emit user classes before patch class)
- localStorage persistence

This is the highest-leverage single addition because it lets users add their own nodes faster than I can ship registry entries.

### Wave 3 — composite nodes (3 weeks)

The Part 3 list — FM ops, dynamics, modulation effects, time effects. Each needs a small wrapper class. Since the User DSP system from Wave 2 lets users author these in `.gdsp`, you can ship a starter library of `.gdsp` files instead of hardcoding them — the same content arrives faster and is editable by users.

### Wave 4 — multi-output codegen (2 weeks)

Unlocks: `Pan2`, `Hilbert`, `StateVariableFilter`, all spatial nodes, MFCC, Chromagram, multi-tap delays, mid/side encode, and dozens more. Single change to the codegen path; cascading benefit.

### Wave 5 — host integration (3 weeks)

MIDI, OSC, Parameter binding. Requires AlloLib Studio Online to expose its event system to the patch class. After this, sequencer nodes from Part 8 become useful.

### Wave 6 — block-rate codegen (4 weeks)

The single biggest infrastructure leap. Unlocks: all Part 5 spectral analyzers, all Part 6 spectral processing, `LoudnessLUFS`, MFCC, BeatTracker, ConvolutionReverb, OnsetDetector. The `operator()` signature changes for nodes inside a block-rate region; the codegen has to handle the boundary.

### Wave 7 — visualization sinks (2 weeks)

Part 10. Requires per-node render hooks and a 30 Hz UI clock, plus careful design of the ring-buffer protocol so audio thread isn't blocked.

### Wave 8 — GPU pipeline (open-ended)

Part 11. Architecturally the most involved. Worth sketching a single `GPUCustom` node first, getting one round-trip working end-to-end, then expanding.

### Total realistic timeline

For a single person working ~half-time, Waves 1–4 are achievable in a quarter. Waves 5–7 add another quarter. GPU is its own thing.

For a class project (MAT201): Waves 1 and 2 are the right scope. They produce a tool that's already substantially more capable than V1, and User DSP turns the work of building all the other waves into a community pursuit instead of a solo grind.
