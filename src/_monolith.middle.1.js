

/* Display order in the palette. "Sample" was missing here even though
 * the registry has Sample-category entries (SamplePlayer / Stereo /
 * Granular / MicInput) — they were silently dropped from the list.
 * Added between Noise and Envelope so audio sources cluster together.
 * Other category names introduced via @gdsp-category that aren't in
 * this list still render — the new browser code falls through any
 * category present in the data but missing from the order. */
const CATEGORY_ORDER = [
  // Audio
  "Oscillator", "Sample", "Noise", "Envelope", "Filter", "Delay", "Effect", "Analysis", "Convert", "Math",
  // 3D scene + render (split out of the old "Visual" bucket)
  "Scene", "Geometry", "Material", "Transform", "Terrain",
  // Game systems
  "Physics", "Game", "UI", "Sprite",
  // Visual FX / compositing
  "Source", "Generator", "Composite",
  // Misc + legacy "Visual" catch-all (kept for any stragglers)
  "AI", "Visual", "Sink", "User DSP"
];

