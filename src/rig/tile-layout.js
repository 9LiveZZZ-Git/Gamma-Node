/* Pick a sensible rectangular tile layout for N displays. Hand-tuned
 * for the common cases (1/2/3/4/6/8/16 — covers all built-in
 * templates), generic fallback for arbitrary counts (e.g. MPCDI
 * imports). */
function _rigTileLayout(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 4, rows: 1 };
  if (n === 6) return { cols: 3, rows: 2 };
  if (n === 8) return { cols: 4, rows: 2 };
  if (n === 12) return { cols: 4, rows: 3 };
  if (n === 16) return { cols: 4, rows: 4 };
  if (n === 20) return { cols: 5, rows: 4 };
  if (n === 24) return { cols: 6, rows: 4 };
  // 26 = AlloSphere real layout. 7×4 wastes 2 cells but groups by
  // the rig's 4 elevation rings (5 + 9 + 8 + 4 displays per ring),
  // which is more legible than a 6×5 lat/lon-style grid.
  if (n === 26) return { cols: 7, rows: 4 };
  if (n === 32) return { cols: 8, rows: 4 };
  // Generic: closest-to-square layout that fits N.
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

