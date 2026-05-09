# Gamma Node — auto-capture calibration bundle

Generated 2026-05-09T18:28:41.826Z by Gamma Node v0.1.80.

## Capture options

- **Auto-prep:** ON — Auto-warp + hard-cut Auto-blend applied before capture (warp: applied, blend: applied). Restored to user's previous warp meshes after capture.
- **Coverage-aware:** ON — Cardinal directions outside the surface's coverage range were skipped.
- **Per-display:** ON — Captured one frame per projector aimed at that projector's pose direction (most diagnostic for finding which projector is misaligned).

## Files

- `*_<direction>.png` — theater-view screenshots. Two kinds:
  - `*_front` / `*_right` / `*_back` / `*_left` / `*_up` / `*_down` — cardinal axes
  - `*_display-NN-<id>-<name>` — one per projector, aimed at that projector's pose
- `calibration-meta.json` — full rig configuration at capture
  time (surface, displays, poses, warp kinds, capture options).

## Directions captured (30)

### Cardinal (4/6)
- **front** — yaw 0.0°, pitch 0.0°
- **right** — yaw 90.0°, pitch 0.0°
- **back** — yaw 180.0°, pitch 0.0°
- **left** — yaw -90.0°, pitch 0.0°

### Per-display (26)
- **display-00-ar0-Allo-1** — yaw -144.0°, pitch 55.0°
- **display-01-ar1-Allo-2** — yaw -69.5°, pitch 54.5°
- **display-02-ar2-Allo-3** — yaw 0.0°, pitch 58.0°
- **display-03-ar3-Allo-4** — yaw 68.0°, pitch 59.5°
- **display-04-ar4-Allo-5** — yaw 140.5°, pitch 59.5°
- **display-05-ar5-Allo-6** — yaw -160.0°, pitch 18.5°
- **display-06-ar6-Allo-7** — yaw -120.0°, pitch 17.0°
- **display-07-ar7-Allo-8** — yaw -80.0°, pitch 18.5°
- **display-08-ar8-Allo-9** — yaw -40.0°, pitch 15.0°
- **display-09-ar9-Allo-10** — yaw 0.0°, pitch 20.0°
- **display-10-ar10-Allo-11** — yaw 40.0°, pitch 16.0°
- **display-11-ar11-Allo-12** — yaw 80.0°, pitch 20.0°
- **display-12-ar12-Allo-13** — yaw 119.0°, pitch 20.0°
- **display-13-ar13-Allo-14** — yaw 162.5°, pitch 14.5°
- **display-14-ar14-Allo-15** — yaw -155.0°, pitch -17.5°
- **display-15-ar15-Allo-16** — yaw -110.5°, pitch -20.0°
- **display-16-ar16-Allo-17** — yaw -70.0°, pitch -17.0°
- **display-17-ar17-Allo-18** — yaw -16.5°, pitch -20.0°
- **display-18-ar18-Allo-19** — yaw 16.5°, pitch -17.0°
- **display-19-ar19-Allo-20** — yaw 61.5°, pitch -19.0°
- **display-20-ar20-Allo-21** — yaw 106.0°, pitch -16.0°
- **display-21-ar21-Allo-22** — yaw 157.5°, pitch -16.0°
- **display-22-ar22-Allo-23** — yaw -135.0°, pitch -55.5°
- **display-23-ar23-Allo-24** — yaw -45.0°, pitch -55.0°
- **display-24-ar24-Allo-25** — yaw 45.0°, pitch -55.5°
- **display-25-ar25-Allo-26** — yaw 135.0°, pitch -55.0°

## Capture configurations (1)

- current

## How to read

For each capture, calibration verification guidelines:

- **Lines should connect across projector boundaries.** A clean
  edge means good calibration; shift/break means a projector's
  pose, FOV, or warp is off.
- **Beacon circles should center on cardinal axes** (red on +X,
  green on +Y, blue on +Z if WireframeCalibration is the source).
- **In per-display captures**, the targeted projector's coverage
  should be centered in the frame. Mismatches: rotation = pose
  yaw/pitch off; size = FOV off; barrel/pincushion = warp off.
- **Cell parity should alternate evenly** if Checkerboard is the
  source.

## Auto-analysis

A future Gamma Node release will feed this bundle (PNGs + meta JSON)
to a Claude API or Gemma 4 vision endpoint for automatic misalignment
scoring + per-display correction proposals (Δyaw, Δpitch, Δfov, warp
adjustments). The bundle format is designed to be self-contained for
this.
