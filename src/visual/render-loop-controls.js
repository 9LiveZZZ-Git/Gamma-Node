function _tickVideoFileTrigs() {
  if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return;
  for (const node of state.nodes) {
    if (!node || node.type !== "VideoFile") continue;
    const src = _videoSources.get(node.id);
    if (!src || !src.videoEl) continue;
    // Find the wire feeding `trig`.
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "trig");
    if (!wire || !wire.from) {
      // No wire -- clear any retained state so a future wire-add doesn't
      // see a stale "lastValue" that suppresses the first edge.
      _videoFileTrigState.delete(node.id);
      continue;
    }
    const srcNode = state.nodes.find(n => n && n.id === wire.from.node);
    if (!srcNode) continue;
    let v = 0;
    if (srcNode.type === "MasterClock") {
      v = _masterClockOutputValue(srcNode, wire.from.port);
    } else if (srcNode.type === "Slider") {
      v = (srcNode.params && typeof srcNode.params.value === "number")
        ? srcNode.params.value : 0;
    } else if (srcNode.type === "HandLandmarker") {
      v = _handLandmarkerValue(srcNode, wire.from.port);
    } else if (srcNode.type === "PoseLandmarker") {
      v = _poseLandmarkerValue(srcNode, wire.from.port);
    } else if (srcNode.type === "FaceLandmarker") {
      v = _faceLandmarkerValue(srcNode, wire.from.port);
    } else if (srcNode.type === "HandKeyboard") {
      v = _handKeyboardValue(srcNode, wire.from.port);
    }
    const last = _videoFileTrigState.get(node.id) || 0;
    _videoFileTrigState.set(node.id, v);
    if (last <= 0.5 && v > 0.5) {
      try { src.videoEl.currentTime = 0; } catch (_) {}
    }
  }
}

function startVisualRenderLoop() {
  if (_visualRafHandle != null) return;
  _visualRafHandle = requestAnimationFrame(_visualRenderTick);
}
function stopVisualRenderLoop() {
  if (_visualRafHandle != null) {
    cancelAnimationFrame(_visualRafHandle);
    _visualRafHandle = null;
  }
}

