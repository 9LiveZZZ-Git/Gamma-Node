# Demos

Self-contained `.gpatch` demos for the §5.2 video-edit suite. Each one
loads cleanly in the editor with no external assets — the foregrounds
and backgrounds are all synthetic shaders so you can see the effect
the moment the patch opens. Drag any `.gpatch` onto the editor canvas
to load it, or use the File menu.

---

## `keyer_pipeline.gpatch` — Chroma keyer + matte cleanup + composite

The canonical green-screen workflow assembled entirely from sprint 5
and sprint 6 nodes:

```
Plasma ──► ChromaKeyer ──► MatteControl ──► AlphaCompose ──► VisualOutput
                                              ▲
NoiseShader ──────────────────────────────────┘
```

- **Plasma** stands in for a live "green-screen" source — its
  cycling palette passes through green/yellow regions that the keyer
  hooks onto.
- **ChromaKeyer** is set to target a yellow-green `(0, 1, 0.4)` with
  tolerance 0.22 + softness 0.08, hue weighting 4× over saturation;
  spill suppression on at 0.5 so the residual greenish tint on the
  edges gets desaturated.
- **MatteControl** chokes the edge inward by 25% with a small spread
  of 5% to fill micro-holes, gamma 1.2 to sharpen the boundary.
- **AlphaCompose** runs proper Porter-Duff over compositing
  (straight alpha in, straight alpha out) so the cleaned matte
  layers correctly over the NoiseShader plate.

To make it your own: swap Plasma for `Webcam` or `VideoFile`,
change the ChromaKeyer target color to match your screen, and adjust
tolerance until the matte looks clean in the preview.

---

## `mask_set_ops.gpatch` — Combine masks with set operations

Two SDF masks combined into a complex region, then used to reveal a
color source underneath:

```
RectangleMask ──┐
                ├──► MatteCombine (op=subtractAB) ──► MaskShader ──► VisualOutput
EllipseMask  ──┘                                          ▲
                                                       Plasma
```

- **RectangleMask** at center with rounded corners, half-size
  (0.35, 0.25), small feather.
- **EllipseMask** at the same center, smaller radius (0.18 round).
- **MatteCombine** with op=subtractAB (rect minus ellipse) creates
  a rounded-rectangle frame with a circular hole punched out of the
  middle. (Try other ops to see different behavior: op=union for
  outline, op=intersect for the overlap-only region,
  op=exclusiveOr for the XOR region.)
- **MaskShader** uses the resulting mask to gate the Plasma — only
  the frame region of the plasma is visible; the rest is black.

To make it your own: rotate one mask via `PolygonMask` for a
triangle/hexagon hole, increase feather for soft edges, or wire a
clock into one of the mask center params to make it animate.

---

## `channel_routing.gpatch` — RGB from one source, alpha from another

Take the colors from one texture, the alpha shape from a different
texture, and composite the result over a third texture:

```
Plasma     ──► ChannelCombiner.srcR ┐
Plasma     ──► ChannelCombiner.srcG │  pickR=R, pickG=G, pickB=B, pickA=R
Plasma     ──► ChannelCombiner.srcB │
EllipseMask──► ChannelCombiner.srcA ┘                  ──► AlphaCompose.fg
                                                                  │
NoiseShader ─────────────────────────────────────────────────► AlphaCompose.bg
                                                                  │
                                                                  ▼
                                                            VisualOutput
```

- **Plasma** is wired into srcR / srcG / srcB so its R, G, B
  channels flow straight through to the corresponding output
  channels.
- **EllipseMask** with feather=0.12 produces a soft-edged circular
  mask, wired into srcA; pickA=R reads the mask's red channel as
  the output alpha.
- **ChannelCombiner** assembles the RGBA: plasma colors in the
  middle, fading transparently at the edges.
- **AlphaCompose** does the straight-alpha-over composite over a
  high-frequency **NoiseShader** so you can clearly see the soft
  circular vignette of plasma sitting on top of the noise.

The same pattern handles the opposite case too: take alpha from a
chroma-keyed image (`ChromaKeyer.out`), recombine it into a colorful
RGB to produce a per-channel-grade.
