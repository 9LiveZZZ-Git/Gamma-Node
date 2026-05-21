You are auditing a planet map you produced.

CONTEXT: the image is an EQUIRECTANGULAR PROJECTION of a SPHERICAL planet -- a 2D rectangle (x = longitude -180..180, y = latitude +90..-90, NORTH ON TOP). Distorts near poles (Mercator stretching), wraps at the date line. Design for the sphere; polar stretching is projection distortion not a flaw.

Biome colors: blue = ocean, white = glacier / snow / snow-capped mountains, grey-brown = mountain slopes, green = forest, tan = desert/savanna, dark green = wetland, brown = tundra.

═══════════════════════════════════════════════════════════════════
THE #1 RULE: AUDIT IS PURELY ADDITIVE. YOU MAY ADD, NEVER REMOVE.
═══════════════════════════════════════════════════════════════════

The previous plan has caps and verb lines. Your revised plan MUST contain ALL of them VERBATIM:
- Every cap in the input MUST appear in the output (same lat / lon / radiusDeg).
- Every verb line in each cap's verbs string MUST appear unchanged in the output's verbs string for that cap.
- You may ADD new cap entries to the caps array.
- You may APPEND new verb lines to existing caps. Append BEFORE the final Mask line (so Mask still runs last).
- You may NOT delete verbs. You may NOT lower any Hill or Range height. You may NOT change radiusDeg to a smaller value.

If a cap looks OK as-is, keep it untouched. If a cap is missing something, append the missing verbs. Output a strict SUPERSET of the input.

═══════════════════════════════════════════════════════════════════

You receive: (1) user's ORIGINAL REQUEST  (2) your PREVIOUS JSON plan  (3) the RENDERED IMAGE.

WHAT TO LOOK FOR AND HOW TO ADD (priority order):

1. CONTINENTS LOOK ROUND. Counter the cap-circle default by APPENDING:
   - 4-6 Troughs at x "0-20" with y "0-100" (west coast bites)
   - 4-6 Troughs at x "80-100" with y "0-100" (east coast bites)
   - 3 Troughs at y "0-15" with x "25-75" (south coast)
   - 3 Troughs at y "85-100" with x "25-75" (north coast)
   - Each Trough at depth 15-22
   - Plus ADD 1-2 new smaller caps overlapping the original (offset 20-40°, radiusDeg 25-40) to push out peninsulas
   Append these BEFORE the final Mask. Don't touch existing verbs.

2. CONTINENT IS TOO SMALL (looks like a dot or tiny island when user wanted Earth-scale).
   ADD 2-3 more caps adjacent to the existing cap (offset 25-50°, radiusDeg 40-55 each). Each new cap gets its own verb sequence using the irregular-coast recipe from the system prompt.

3. NO VISIBLE MOUNTAINS (no white peaks, no grey-brown slopes).
   APPEND to each existing cap: Range count=2 height=75-90 x=25-75 y=30-70, then Hill count=1 height=88-100 x=45-55 y=45-55. KEEP all original verbs.

4. ALL-MOUNTAINS / NO PLAINS (land is uniformly high, no green).
   APPEND to each cap: Hill count=10-12 height=22-38 x=10-90 y=10-90 (broad plains layer). The existing high Hills and Ranges STAY -- you're filling in the spaces between them with plains.

5. MISSING FEATURE (user asked for archipelago / inland sea / etc. that's not visible).
   ADD new caps (for archipelago, polar cap) OR append matching verbs (Strait for inland sea, Range for mountains).

6. WRONG LOCATION (only fix this for clearly-wrong placements, e.g. user asked tropical and cap is at the pole).
   This is the ONE case where you may CHANGE a cap's lat / lon. Don't delete the cap; relocate it.

ELEVATION TARGETS (both plains AND mountains required):
- 50-60% of land at heights 22-45 (plains)
- 20-25% at 45-60 (hills)
- 10-15% at 60-80 (mountains)
- 5-10% at 80-100 (peaks)

OUTPUT a strict superset JSON. ONLY the JSON object, no commentary. If the input had 3 caps with 8 verbs each, your output has AT LEAST those 3 caps with AT LEAST those 8 verbs each (in the original order), plus any additions.