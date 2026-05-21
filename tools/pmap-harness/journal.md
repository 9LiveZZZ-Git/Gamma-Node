# PlanetMap prompt refinement journal

Target: refine `prompts/system.md` so the LLM reliably emits JSON
plans that render to Earth-stylistically-matching planets (irregular
coastlines, plain-dominant land with visible mountain ranges, 2
distinct continents, 20-30% land coverage). Reference image:
`refs/earth.png`.

The harness renders at N=4000 cells × seaLevel=0.5 for fast iteration.
The editor itself uses N=60-240k in production but the relative
stylistic outcomes are visible at 4k.

---

## 0001-baseline @ 2026-05-20

**Hypothesis:** Establish baseline. Use system.md as-is with 8 caps (Americas 4 + Eurasia-Africa 4).

**Change to system.md:** none for measurement; afterwards bumped plains heights 22-38 → 40-55 and required Mt-Everest peak to be OFF-CENTER (not at x=50 y=50), with updated examples to match. Reasoning: render showed a "snow-bullseye" — central peak stacked at (50,50), green ring of plains, sand-ring coast.

**Result:** land 7.55%, only ONE visible blob (S. America). Eurasia-Africa caps barely emerged from sea (plains were 22-38, too low to survive Mask 1.5 edge falloff). The one visible cap is a perfect concentric donut.

**Next:** measure if plains-height bump fixes the land-fraction collapse and if off-center peak kills the bullseye.

---

## 0002-raise-plains @ 2026-05-20

**Hypothesis:** Plains at 40-55 will survive Mask edge falloff and form continent shelf.

**Change to system.md:** plains 40-55, peak off-center.

**Result:** land 7.40% (no change). Same bullseye, same Eurasia-Africa missing. Realized I misunderstood the sealevel convention.

**Next:** investigate the actual sealevel convention.

---

## 0003-sealevel-fix @ 2026-05-20

**Hypothesis:** Sealevel = 50 (DSL units) per harness `--sealevel 0.5`. Bumping plains to 60-72 should survive Mask.

**Change to system.md:** ALL heights rescaled to (raw_height = old + ~30); examples too.

**Result:** land 6.58% — WORSE. Discovered via code inspection: `_planetPostDSL` remaps Azgaar's internal sealevel 0.20 to the harness 0.5 via piecewise-linear. So the ORIGINAL "20 = sea level" was correct on the raw scale, and my "fix" was wrong. ALSO discovered: Hill is a LOCAL BFS blob, not a uniform layer. Stacked Hills cluster blobs in the cap interior → bullseye. The right fix is to use `Add <value> all` to lift the WHOLE cap.

**Next:** revert heights, prepend `Add 25-30 all 0 0` to every cap.

---

## 0004-add-lift @ 2026-05-20

**Hypothesis:** `Add 25-30 all 0 0` at start of cap raises every cell, breaking the bullseye and increasing coverage.

**Change to system.md:** sealevel = 20 (reverted); first verb of every cap is `Add 25-30 all`; Hill plain heights dropped back to 10-22; example caps updated.

**Result:** land 9.50% — first real improvement. TWO continents visible (Americas + Eurasia-Africa-like). S. America still bullseye but coastline visible. Other caps too small.

**Next:** raise Add to 38-45 (closer to sealevel + Mask falloff cushion).

---

## 0005-higher-add @ 2026-05-20

**Hypothesis:** Add 38-45 covers Mask falloff and produces fuller continents.

**Change to system.md:** Add → 38-45, trough depths bumped to 22-32.

**Result:** land 8.15% — DOWN from 0004. Bullseye persists.

**Next:** drop Range/Hill heights, remove secondary peaks.

---

## 0006-moderate-mtns @ 2026-05-20

**Hypothesis:** lower Range/Hill heights stop the central dome stacking.

**Change to system.md:** Range 55-72, Hill peak 60-72, no secondary peaks.

**Result:** land 9.78% (best). S America still bullseye. Realized too many Hills stacking centrally.

---

## 0007-fewer-hills @ 2026-05-20

**Change to system.md:** Hill count 14 → 5 max.

**Result:** land 8.8%. S America still bullseye even with fewer Hills.

---

## 0008-low-mtns @ 2026-05-20

**Change to system.md:** Range 35-48 (was 42-55), Hill peak 48-58 (was 55-68).

**Result:** land 10.27% (new best). Africa-Eurasia caps render fine. S America STILL bullseye — diagnosed: Range and Hill peak BFS halos overlap on same side of cap.

---

## 0009-opposite-mtns @ 2026-05-20

**Change:** force Range and Peak on OPPOSITE sides of cap.

**Result:** land 10.42% (new best). Still bullseye in S America — BFS halos still meet in cap interior even from opposite sides.

---

## 0010-mask-linear @ 2026-05-20

**Change:** Mask power 1.5 → 1.0.

**Result:** land 9.98% (regression). Mask barely matters.

---

## 0011-no-mask @ 2026-05-20

**Change:** REMOVE Mask entirely. Tighten Eurasia-Africa cap spacing.

**Result:** land 15.6% (HUGE jump). 3 continents visible. S America bullseye larger though (no Mask softening).

---

## 0012-low-add @ 2026-05-20

**Change:** Add 38-45 → 28-35 (lower base lift reduces clamp risk).

**Result:** land 14.7%. Eurasia-Africa now shows as ONE Earth-like continent. S America still dome.

---

## 0013-two-ranges @ 2026-05-20

**Change:** Replace Range+Hill-peak with TWO Ranges on opposite sides.

**Result:** land 14.67%. Still bullseye — diagnosed: 5 Hill blobs + Range spine = clamp to 1.0 = snow. Real cause: Hill count + height too high.

---

## 0014-low-hills @ 2026-05-20

**Change:** Hill 5 height 10-20 → Hill 3 height 5-12.

**Result:** land 10.03% (regression). Snow dome MUCH smaller, but lost land coverage to smoothing/cleanup.

---

## 0015-add-land-boost @ 2026-05-20

**Change:** Add `Add 12 land 0 0` as last verb to lift all land cells.

**Result:** land 14.55%, but SNOW DOME BACK — Add 12 land bumped brown-mountain cells past snow threshold.

---

## 0016-filtered-add @ 2026-05-20

**Change:** `Add 12 land 0 0` → `Add 12 20-45 0 0` (filter to plain heights only).

**Result:** land 11.28%. S America cap looks PROPERLY Earth-like: brown mountains, green plains, small snow patch, irregular coast. But Eurasia-Africa shrunk to tiny island. Lost coverage in flat caps.

**Next:** boost Add 12 to Add 15 or widen the filter to 20-55 to catch more cells.

---

## 0017-wider-filter @ 2026-05-20

**Change:** `Add 12 20-45` → `Add 14 20-60`.

**Result:** land 12.83% but bullseye returned (boosted foothills to snow).

---

## 0018-add10 @ 2026-05-20

**Change:** `Add 14 20-60` → `Add 10 20-55`.

**Result:** land 14.67%. Bullseye still in S America cap.

---

## 0019-diag-ranges @ 2026-05-20

**Change:** Place 2 Ranges in DIAGONAL quadrants (west-south + east-north), heights 32-40.

**Result:** land 9.4%. S America mostly brown mountain (snow tiny). Eurasia-Africa lost.

---

## 0020-low-ranges @ 2026-05-20

**Change:** Range heights 35-42 (lowered from 38-45).

**Result:** land 11.03%. Still bullseye — discovered Hill 3 5-12 IS the cause! Hill BFS fills the entire cap at near-constant 0.05-0.15 due to blobPower 0.93 at N=4000. 3 hills × 0.12 = +0.36 added to EVERY cap cell, which when combined with Add+Range spine clamps to 1.0 = snow.

---

## 0021-no-hill @ 2026-05-20

**Change:** REMOVE Hill verb entirely.

**Result:** land 6.78% — ONE clean continent, NO snow, but smallest land yet. Hills WERE necessary for cap-edge coverage.

---

## 0022-one-low-hill @ 2026-05-20

**Change:** `Hill 1 5-8` (one hill, very low height).

**Result:** land 8.28%. Best stylistic result — irregular Earth-like continent, no snow, sand coast, hint of brown mountain. Eurasia-Africa still missing.

---

## 0023-add35 @ 2026-05-20

**Change:** Add 30 → 35 (slight lift bump).

**Result:** land 8.67%. Same single-continent picture, slightly bigger.

---

## 0024-production-N @ 2026-05-20

**Test:** rendered 0023 plan at N=60000 (production cell count).

**Result:** land 8.40% (similar). Confirms the cap-layout problem is independent of N.

---

## STOP — see PLATEAU.md
