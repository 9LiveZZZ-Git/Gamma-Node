/* Sprint 7.5.3a -- (re)allocate the depth + MSAA color textures at
 * the current Visual.msaaSampleCount. Called from _allocateFramebuffer
 * and from setMsaaSampleCount when the HUD pill cycles. The MSAA
 * color texture is only allocated when sampleCount > 1; the depth
 * texture is always allocated (with matching sampleCount). */
function _ensureMsaa3DTextures() {
  if (!Visual.device || !Visual.fbWidth || !Visual.fbHeight) return;
  const sc = Math.max(1, Visual.msaaSampleCount | 0);
  // Depth -- always allocated.
  if (Visual.depthTexture) {
    try { Visual.depthTexture.destroy(); } catch (_) {}
  }
  Visual.depthTexture = Visual.device.createTexture({
    label: "visual-depth-" + sc + "x-" + Visual.resolutionKey,
    size: [Visual.fbWidth, Visual.fbHeight, 1],
    sampleCount: sc,
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT
  });
  Visual.depthTextureView = Visual.depthTexture.createView({ label: "visual-depth-view" });
  // MSAA color -- only when sc > 1. We render into this and resolve
  // to the framebuffer layer at end-of-pass.
  if (Visual.msaaColorTexture) {
    try { Visual.msaaColorTexture.destroy(); } catch (_) {}
    Visual.msaaColorTexture     = null;
    Visual.msaaColorTextureView = null;
  }
  if (sc > 1) {
    Visual.msaaColorTexture = Visual.device.createTexture({
      label: "visual-msaa-color-" + sc + "x-" + Visual.resolutionKey,
      size: [Visual.fbWidth, Visual.fbHeight, 1],
      sampleCount: sc,
      format: Visual.fbFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    Visual.msaaColorTextureView = Visual.msaaColorTexture.createView({ label: "visual-msaa-color-view" });
  }
  // The mesh pipeline is sampleCount-keyed, so changing sc means
  // future _ensureMeshPipeline(sc) calls hit a fresh cache slot.
  // Existing entries for other sample counts stay -- cheap, lets
  // the user toggle 1x <-> 4x without paying shader compile cost
  // on every flip.
}

function setMsaaSampleCount(n) {
  n = (n === 4 || n === 8) ? n : 1;
  if (n === Visual.msaaSampleCount) return;
  Visual.msaaSampleCount = n;
  _ensureMsaa3DTextures();
  _updateMsaaPill();
}
function cycleMsaa() {
  // 1 -> 4 -> 8 -> 1. 8x is not universally supported, but WebGPU
  // surfaces a validation error at pipeline create time which we
  // catch + display in the HUD; we still LET the user try it on
  // adapters that have it.
  const cur = Visual.msaaSampleCount;
  setMsaaSampleCount(cur === 1 ? 4 : (cur === 4 ? 8 : 1));
}
function _updateMsaaPill() {
  const pill = document.getElementById("msaa-pill");
  if (!pill) return;
  const sc = Visual.msaaSampleCount;
  pill.textContent = sc + "x MSAA";
  pill.classList.toggle("active", sc > 1);
  pill.title = sc === 1
    ? "MSAA disabled (1x). Click to cycle 1x -> 4x -> 8x. Affects only 3D Scene passes; existing shader-frag passes stay single-sample."
    : "MSAA " + sc + "x. Click to cycle. Anti-aliases triangle edges in Scene render passes via WebGPU resolveTarget. Costs ~" + sc + "x the depth + color memory of the 3D pass.";
}

// Sprint 7.5.3a -- one-shot diagnostic logs so we can see exactly
// where the 3D render path stops if a smoke-test demo shows blank.
// Each flag is flipped true on first success so we don't spam the
// console every frame.
const _SCENE_DIAG = { pipeline: false, instance: false, encode: false, draw: false, cull: false };

/* =========================================================================
 * §bonus-perf-diag (2026-05-25) -- focused per-frame perf counters for
 * the SVT/DEM transition slow zone. User reports 9 fps at foot, drop
 * happens "exactly where SVT ends and DEM begins". This block makes
 * the suspect hot paths visible:
 *
 *   chunksVisible   -- total visible chunks this frame (cull-pass count)
 *   chunksBuilt     -- chunks rebuilt this frame (CPU vertex noise +
 *                      DEM resample + GPU upload)
 *   chunkBuildMs    -- ms spent in chunk build this frame
 *   demTilesFetched -- DEM tile fetches kicked off this frame
 *   demTilesArrived -- DEM tile arrivals this frame (each triggers
 *                      _invalidateChunksForTile → chunk rebuilds)
 *   chunksInvalidated -- chunks killed by tile arrivals this frame
 *   svtPagesGenThisFrame -- pages drained from SVT queue this frame
 *
 * Updated by the chunk-build path + DEM loader + SVT tick. Dumped to
 * console every 60 frames if any counter > 0. Also surfaced via
 * window.__PERFSTATS so user can poll from console:
 *   __PERFSTATS.snapshot()
 */
const _PERFSTATS = {
  frame: 0,
  chunksVisible: 0,
  chunksBuilt: 0,
  chunkBuildMs: 0,
  demTilesFetched: 0,
  demTilesArrived: 0,
  chunksInvalidated: 0,
  svtPagesGenThisFrame: 0,
  // Rolling totals so a snapshot has the cumulative picture too.
  totalChunksBuilt: 0,
  totalDemTilesFetched: 0,
  totalDemTilesArrived: 0,
  totalChunksInvalidated: 0,
  // Frame-time stats (rolling 60-frame window).
  frameMs: 0,
  frameMsWindow: [],
};
function _perfFrameReset() {
  _PERFSTATS.frame++;
  _PERFSTATS.chunksVisible = 0;
  _PERFSTATS.chunksBuilt = 0;
  _PERFSTATS.chunkBuildMs = 0;
  _PERFSTATS.chunkPhQueue = 0;
  _PERFSTATS.chunkUpQueue = 0;
  _PERFSTATS.demTilesFetched = 0;
  _PERFSTATS.demTilesArrived = 0;
  _PERFSTATS.chunksInvalidated = 0;
  _PERFSTATS.svtPagesGenThisFrame = 0;
}
function _perfFrameDump() {
  // §bonus-perf-diag v2 -- dump every 30 frames (was 60) so we get
  // more samples during a slow-down period. Always dumps (even when
  // counters near 0) so we always see the frame-time line at any
  // altitude. fps is the headline metric -- median of frameMsWindow
  // so a single spike doesn't poison the average; draws is the last
  // frame's count, useful for tracking per-chunk overhead.
  if (_PERFSTATS.frame % 30 !== 0) return;
  let medMs = 0;
  if (_PERFSTATS.frameMsWindow.length > 0) {
    const sorted = _PERFSTATS.frameMsWindow.slice().sort((a, b) => a - b);
    medMs = sorted[Math.floor(sorted.length / 2)];
  }
  const fps = medMs > 0 ? (1000 / medMs).toFixed(1) : "?";
  const draws = (typeof Visual !== "undefined" && Visual.perf)
    ? Visual.perf.drawCalls : 0;
  // §log-quiet -- the [perf] line is useful when chasing perf, noise
  // otherwise. Gated behind window.__PLANET_LOG (default off). Set
  // window.__PLANET_LOG = true in console to re-enable.
  if (!(typeof window !== "undefined" && window.__PLANET_LOG)) return;
  console.log("[perf] f=" + _PERFSTATS.frame
    + " fps=" + fps + " (" + medMs.toFixed(1) + "ms)"
    + " draws=" + draws
    + " vis=" + _PERFSTATS.chunksVisible
    + " built=" + _PERFSTATS.chunksBuilt + "(" + _PERFSTATS.chunkBuildMs.toFixed(1) + "ms)"
    + " qPh=" + _PERFSTATS.chunkPhQueue + " qUp=" + _PERFSTATS.chunkUpQueue
    + " demFetch=" + _PERFSTATS.demTilesFetched
    + " demArrive=" + _PERFSTATS.demTilesArrived
    + " invald=" + _PERFSTATS.chunksInvalidated
    + " svtPg=" + _PERFSTATS.svtPagesGenThisFrame
    + " | cumDEM=" + _PERFSTATS.totalDemTilesArrived
    + "/" + _PERFSTATS.totalDemTilesFetched);
}
if (typeof window !== "undefined") {
  window.__PERFSTATS = _PERFSTATS;
  window.__PERFSTATS.snapshot = function () {
    return {
      frame: _PERFSTATS.frame,
      chunksVisible: _PERFSTATS.chunksVisible,
      chunksBuilt: _PERFSTATS.chunksBuilt,
      chunkBuildMs: _PERFSTATS.chunkBuildMs,
      demTilesFetched: _PERFSTATS.demTilesFetched,
      demTilesArrived: _PERFSTATS.demTilesArrived,
      chunksInvalidated: _PERFSTATS.chunksInvalidated,
      svtPagesGenThisFrame: _PERFSTATS.svtPagesGenThisFrame,
      total: {
        chunksBuilt: _PERFSTATS.totalChunksBuilt,
        demTilesFetched: _PERFSTATS.totalDemTilesFetched,
        demTilesArrived: _PERFSTATS.totalDemTilesArrived,
        chunksInvalidated: _PERFSTATS.totalChunksInvalidated,
      }
    };
  };
}

