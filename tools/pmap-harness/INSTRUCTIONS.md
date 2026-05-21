# PlanetMap prompt-harness iteration loop

You are an autonomous agent refining a system prompt for a planet-map
generator. The user wants the system to **reliably produce output that
stylistically matches Earth's landmass** (irregular continental
shapes, plain-to-mountain ratio, coastline detail, ocean placement)
when given the reference image `refs/earth.png`.

Your job: run a refinement loop. Each iteration you (a) role-play as
the LLM and emit a JSON plan, (b) render it, (c) visually compare to
the reference, (d) edit the system prompt to fix the worst flaw,
(e) log what you did. Continue until output reliably matches Earth's
landmass style across multiple seeds, OR until your token budget is
near exhaustion.

## Working directory

All paths in this doc are relative to `tools/pmap-harness/`.

- `prompts/system.md` — **THE FILE YOU ARE REFINING.** Current draft.
- `prompts/audit.md` — secondary system prompt for audit passes (don't edit unless you've stabilized system.md and want to do paired audit-cycle iterations).
- `refs/earth.png` — the target reference image. Compare your renders against this.
- `refs/MANIFEST.json` — credits + URLs for all 20 ref images.
- `runs/NNNN-<slug>/` — per-iteration artifacts. Create a new one each iteration.
- `journal.md` — append-only log of what you tried and what happened.
- `render.mjs` — the renderer. Run it via Bash.

## One iteration

1. **Read** `prompts/system.md` (current state) and `journal.md` (history). If journal exists, read its last 5 entries; if not, treat as iteration 1.

2. **Choose** the next iteration number `N` (4-digit, zero-padded). Slug = a 1-3 word tag for what you're trying (e.g. `0003-stronger-troughs`).

3. **Generate a JSON plan as if you were the LLM responding to** the prompt below. Write it to `runs/NNNN-<slug>/plan.json`. Treat `prompts/system.md` as your system prompt and use this user prompt:

   ```
   Reference image: refs/earth.png. Generate an EARTH-LIKE planet
   with 2 huge continents (Americas-shape + Eurasia/Africa-shape),
   irregular coastlines, mountain ranges, broad plains. Target land
   coverage 20-30%.
   ```

   You will literally read `refs/earth.png` via the Read tool to see it, then write out a plan. Do NOT think of this as a separate API call — you (this agent) ARE the LLM.

   Output format = exactly the JSON schema your system.md prescribes. No commentary, no markdown fences.

4. **Render**: run `node render.mjs --plan runs/NNNN-<slug>/plan.json --out runs/NNNN-<slug>/result.png --cells 4000 --sealevel 0.5` via Bash. Capture stdout into `runs/NNNN-<slug>/render.log`.

5. **Compare** the result with the reference. Read both PNGs side by side:

   - `refs/earth.png` (target)
   - `runs/NNNN-<slug>/result.png` (your output)

   Write a critique to `runs/NNNN-<slug>/critique.md` covering:
   - **Land fraction**: target ≈ 0.20-0.30, what did you get?
   - **Continent shapes**: are they circular blobs or irregular polygons? Where are the worst round edges?
   - **Mountain placement**: are there visible mountain ranges with peaks? Or just uniform hills?
   - **Coastline detail**: count visible peninsulas, bays, capes. Earth has many; circular blobs have ~zero.
   - **Continent count**: did you produce 2 distinct landmasses or did they merge / fragment?
   - **Continent size relative to planet**: too small / too big / right? Compare to Earth's combined landmasses (~22% of surface).
   - **Plain-to-mountain ratio**: what fraction looks like plains (green) vs mountains (brown/white)? Earth = mostly plains.
   - **Single worst flaw**: pick ONE thing to fix next iteration.

6. **Edit** `prompts/system.md` to address the worst flaw. Make TARGETED, SURGICAL edits — strengthening one rule, adding one example, removing one ambiguity. **Never** rewrite the prompt wholesale; small focused changes let you isolate cause and effect.

7. **Append to journal.md** in this exact format:

   ```
   ## NNNN-<slug> @ <ISO timestamp>

   **Hypothesis:** what you're trying to fix and why.

   **Change to system.md:** 1-2 sentences describing the edit.

   **Result:** key metrics + qualitative observation (1-3 sentences).

   **Next:** what to try next iteration.

   ---
   ```

8. **Commit?** Don't commit the editor or harness changes — the user reviews periodically. But ALL your iteration artifacts (under `runs/`, `journal.md`, edits to `prompts/system.md`) live in the working copy and are visible to the user.

9. **Stop conditions** (check before starting next iteration):
   - **Converged**: 3 iterations in a row produce stylistically-matching output (irregular ≥5-peninsula coastlines, visible mountain ranges, land 20-30%, 2 distinct continents). Write `CONVERGED.md` with a summary, stop.
   - **Plateaued**: 10 iterations with no measurable improvement on the worst-flaw axis. Write `PLATEAU.md`, stop.
   - **Token budget**: your context window is filling up. Wrap up with a summary in `journal.md` and stop. The user can spawn a fresh agent to continue from journal state.

## Important constraints

- **Do NOT modify** the editor's `gamma-node-editor.html` file. Your work product is just `prompts/system.md`. Once it's good, the user will copy the refined prompt back into the editor.
- **Do NOT call any external APIs.** All LLM behavior is your own role-play. The renderer is pure Node + Puppeteer, no external calls except loading the local editor HTML.
- **Stylistic match, not pixel-exact.** We're NOT trying to put the Americas at lon -80; we want the system to RELIABLY produce continents that LOOK like Earth's (irregular, varied, mountainous interior, flat coasts). Use multiple seeds (different lat/lon values in your plans) across iterations to test reliability.
- **Don't burn iterations on noise.** If you change the system prompt and the result barely shifts, double-check that the render actually used the new prompt (look at plan.json: does it reflect the new instruction?). If the LLM (you) didn't follow your own new instruction, the instruction is weak — strengthen it, don't add a workaround elsewhere.
- **Pikes-Peak rule**: real mountains are LAYERED — main spine, foothills, isolated peaks. NOT one big average raise. If renders show a single broad uniform mountain dome instead of a spiky ridgeline, the system prompt needs to emphasize verb stacking for prominence variation.

## Useful Bash commands

- Run renderer: `node render.mjs --plan PATH --out PATH --cells 4000 --sealevel 0.5`
- Quick land % from metrics: `cat runs/NNNN-*/result.metrics.json | head -10`
- List iterations done: `ls runs/`
- Diff prompts between iterations: `diff runs/0003-*/system-snapshot.md runs/0004-*/system-snapshot.md` (snapshot system.md into the iteration dir if you want this).

## Initial state

The very first iteration is `0001-baseline`. Use the system.md as currently extracted from the editor, run it, score it, then start refining. Treat the first run as your baseline measurement.

Begin now.
