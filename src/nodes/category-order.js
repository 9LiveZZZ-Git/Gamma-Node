

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
  // Phase A.2 — LLM + knowledge-management subcategories.
  // Slash-separated names are kept as flat category strings today; the
  // browser falls through to _brCatMeta defaults for unknown bins, then
  // displays them as discrete rails in the palette. A future polish
  // sprint may render the `X/Y` pattern as nested groups.
  //   AI/LLM   = Ollama chat / generate / model select / system prompt.
  //   AI/Embed = Ollama embedding nodes; Tektite MD embedder consumers.
  //   AI/Viz   = AI-side visualizations (vision overlays, embedding maps).
  //   LLM/Build, LLM/Train, LLM/Viz = the from-scratch transformer node
  //                                   families (data / embeddings /
  //                                   attention / transformer block /
  //                                   training / inference / viz).
  //   Notes    = Tektite MD note-source / corpus / query nodes.
  "AI/LLM", "AI/Embed", "AI/Viz",
  "LLM/Build", "LLM/Train", "LLM/Viz",
  "Notes",
  // Misc + legacy "Visual" catch-all (kept for any stragglers)
  "AI", "Visual", "Sink", "User DSP"
];

