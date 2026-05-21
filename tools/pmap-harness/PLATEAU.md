# PLATEAU — refinement halted after 24 iterations

## Summary

Across 24 iterations the system prompt's understanding of the
PlanetMap DSL was significantly improved. Baseline (0001) produced
land=7.55% with a single concentric-ring blob; best stylistic result
(0022/0023) produces an Earth-like green continent with irregular
coast, brown mountain hints, sand beaches, no snow dome, at
land=8-9%. Land coverage never reached the 22-30% target.

## Best stylistic result so far

**`runs/0022-one-low-hill/`** and `runs/0023-add35/`.

Single irregular green continent with:
- irregular sand coastline (peninsulas, bays)
- broad green plains (dominant)
- hint of brown mountain (Range spine + halo)
- NO snow dome
- but only ONE continent visible (Eurasia-Africa caps fail to manifest)

## Key learned constraints baked into `prompts/system.md`

1. **Sea level = 20 (raw DSL units)**, NOT 50. The harness `--sealevel 0.5` invokes a piecewise remap from Azgaar's internal AZ_SL=0.20 to the user's 0.5. So the raw DSL scale uses 20 as sealevel.

2. **`Add <value> all 0 0` is the ONLY uniform-lift verb.** Every cap MUST start with `Add 32-40 all 0 0` to lift the whole cap above sealevel. Without this, Hills+Ranges only create localized blobs and most of the cap is ocean (bullseye).

3. **Hill BFS at N=4000 fills the entire cap.** blobPower = 0.93 makes propagation near-constant (a value x propagates to x^0.93 ≈ x for x < 1). So a Hill at height 12 adds +0.12 to ALMOST EVERY cap cell, NOT just locally. This is the most important pathology — multiple Hills stack, clamp to 1.0 = snow dome. ONE Hill at height 5-8 is the maximum safe usage.

4. **Use TWO RANGES in OPPOSITE QUADRANTS**, height 32-42 each. Range BFS spine cells get +0.40 max; ring 1 gets +0.13; ring 2 +0.06; ring 3 +0.03. Combined with Add 30 base: spine cells reach 0.70-0.72 = brown mountain (not snow). Diagonal placement (west-south + east-north) keeps the two ranges' BFS halos non-overlapping.

5. **`Mask <power>` is HARMFUL at the user's sealevel.** Mask multiplies outer cap cells by `t^power`, dropping them below sealevel. Removing the Mask verb improved land coverage 6→15%.

6. **`Add <value> <min>-<max>` filtered lift** rescues cap-edge cells from the post-DSL smoothing/cleanup which drops them to ocean. `Add 10 20-55` adds +0.10 to plain/foothill cells (raw 20-55), doesn't trigger snow because mountain spines (≥ 60) aren't touched.

7. **Trough depths must EXCEED Add-lift** but not by too much. With Add 30 + smoothing, troughs at depth 20-25 punch through to ocean and create coastal bites. Depths > 30 over-eat and destroy land.

## Why I stopped

Diminishing returns after 0022. The remaining open issue — getting Eurasia-Africa cluster to manifest as a 2nd visible continent — appears to be a CAP-LAYOUT problem (high-latitude caps have small spherical area in equirect; multi-cap clusters at lat 30-50 don't overlap enough to form one big mass). Tightening cap spacing didn't help because the underlying problem is that each individual cap is already small in spherical-area at high latitude.

Verified at N=60000 (production cell count) that the same layout produces the same outcome. So this isn't an artifact of the N=4000 harness.

## What the next agent should try

1. **Use radius 60-70 instead of 45-55 for high-latitude caps**, to compensate for equirect compression. Currently the prompt says caps in a continent cluster span 80-110° total — but at high lat that needs LARGER per-cap radius.
2. **Test with a different seed** (jitter, noise.seed) to see if the per-cap RNG matters. The harness defaults noise.seed=7.3.
3. **Try the audit-pass workflow** (prompts/audit.md) — instructions say "don't touch unless system.md is stable". It probably IS stable enough now to start paired audit-cycle work.
4. **Validate inside the editor at N=240k**. The harness uses N=4000 (and the test N=60k matched), but the editor's UI has features the harness skips (e.g., user can tweak noise + jitter sliders).

## Files of interest

- `prompts/system.md` — final refined prompt (1.5x more rules than baseline).
- `runs/0022-one-low-hill/result.png` — best result.
- `runs/0001-baseline/result.png` — baseline for comparison.
- `journal.md` — full per-iteration log.
