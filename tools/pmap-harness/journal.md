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

(empty -- agent appends entries below as it iterates)
