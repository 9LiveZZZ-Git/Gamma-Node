/* Encode the theater-mode render pass. Replaces _encodeRigComposite
 * + _encodeWarpPasses for the frame when previewMode === "theater".
 * Returns true if the pass was successfully encoded. */
function _encodeTheaterPass(enc, dtSec) {
  if (!Visual.device || !Visual.context || !Visual.theaterPipeline ||
      !Visual.theaterBindGroup || !Visual.theaterUniformBuffer ||
      !Visual.theaterVertexBuffer || !Visual.theaterIndexBuffer ||
      !Visual.theaterDispParamsBuffer) return false;

  // Step the camera from currently-held keys / touch sticks before
  // computing the matrix so the very next frame reflects the input.
  _theaterStepCamera(dtSec || 0);

  const displays = (state && state.rig && state.rig.displays) || [];
  const layerCount = Math.min(displays.length, RIG_MAX_DISPLAYS);
  if (layerCount === 0) return false;

  // Build mesh geometry — one mesh per display; warp meshes used when
  // the display has them, identity 1×1 otherwise. Single drawIndexed
  // covers everything.
  const geom = _buildTheaterMeshGeometry(displays);
  if (geom.indexCount === 0) return false;
  const scratch = Visual._theaterScratch;
  Visual.device.queue.writeBuffer(
    Visual.theaterVertexBuffer, 0,
    scratch.verts.buffer, scratch.verts.byteOffset, geom.vertBytes
  );
  Visual.device.queue.writeBuffer(
    Visual.theaterIndexBuffer, 0,
    scratch.idx.buffer, scratch.idx.byteOffset, geom.idxBytes
  );

  // Pack per-display blend params (gamma, blackLift, power, _) and
  // write to the uniform array indexed by layer in the shader.
  const dpBuf = new Float32Array(RIG_MAX_DISPLAYS * 4);
  for (let i = 0; i < layerCount; i++) {
    const d = displays[i] || {};
    const eb = d.edgeBlend || _defaultEdgeBlend();
    dpBuf[i * 4 + 0] = eb.gamma;
    dpBuf[i * 4 + 1] = eb.blackLift;
    dpBuf[i * 4 + 2] = eb.power;
    dpBuf[i * 4 + 3] = 0;
  }
  Visual.device.queue.writeBuffer(Visual.theaterDispParamsBuffer, 0, dpBuf.buffer, dpBuf.byteOffset, dpBuf.byteLength);

  // View-projection matrix.
  const cw = Visual.canvas.width, ch = Visual.canvas.height;
  const aspect = (cw && ch) ? cw / ch : 1;
  const vp = _theaterViewProjMatrix(Visual.theaterCam, aspect);
  Visual.device.queue.writeBuffer(Visual.theaterUniformBuffer, 0, vp.buffer, vp.byteOffset, vp.byteLength);

  let canvasView;
  try { canvasView = Visual.context.getCurrentTexture().createView(); }
  catch (e) { return false; }

  const pass = enc.beginRenderPass({
    label: "theater-pass",
    colorAttachments: [{
      view: canvasView,
      clearValue: { r: 0, g: 0, b: 0, a: 1.0 },     // pure black, no skybox
      loadOp: "clear",
      storeOp: "store"
    }]
    // No depth attachment — additive blending makes order irrelevant
    // and lets overlap zones sum correctly.
  });
  pass.setPipeline(Visual.theaterPipeline);
  pass.setBindGroup(0, Visual.theaterBindGroup);
  pass.setVertexBuffer(0, Visual.theaterVertexBuffer);
  pass.setIndexBuffer(Visual.theaterIndexBuffer, "uint32");
  pass.drawIndexed(geom.indexCount);
  pass.end();
  return true;
}

/* Rebuild the rig composite bind group when the framebuffer changes
 * (display count, resolution). Layout is fixed; the texture-array
 * view + sampler + uniform buffer get rebound. */
function _rebuildRigCompositeBindGroup() {
  if (!Visual.device || !Visual.framebufferArrayView ||
      !Visual.rigCompositeBindGroupLayout || !Visual.blitSampler ||
      !Visual.rigCompositeUniformBuffer || !Visual.rigDisplaysBuffer) return;
  Visual.rigCompositeBindGroup = Visual.device.createBindGroup({
    label: "rig-composite-bg",
    layout: Visual.rigCompositeBindGroupLayout,
    entries: [
      { binding: 0, resource: Visual.framebufferArrayView },
      { binding: 1, resource: Visual.blitSampler },
      { binding: 2, resource: { buffer: Visual.rigCompositeUniformBuffer } },
      { binding: 3, resource: { buffer: Visual.rigDisplaysBuffer } }
    ]
  });
}

