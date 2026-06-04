/* Build / fetch a mesh's GPU buffers. DebugTriangle is the only
 * mesh-gen kind in sprint 7.5.3a; future primitives will dispatch
 * here based on node.type with vertex data built procedurally
 * (Box: 36 verts + indices; Sphere: stacks*slices interpolated;
 * etc). Cache keyed by node.id; invalidated when params that change
 * geometry change (sprint 7.5.3b handles invalidation via a
 * version counter set when relevant params mutate). */
function _ensureMeshBuffers(meshEntry) {
  const node = meshEntry.node;
  // Phase 8 sprint 8-7b: synthesized detail-patch entries (added by
  // _resolveSceneMeshes when a PlanetMesh is in the scene) share the
  // PlanetMesh node but use a static (u, v) grid buffer cached
  // globally per gridDim.
  if (meshEntry.isPlanetDetailPatch) {
    const gridDim = Math.max(2, Math.min(256, Math.floor(
      (node.params && node.params.detailPatchGridDim) || 96
    )));
    return _ensurePlanetDetailPatchBuffer(gridDim);
  }
  // §5.5.e-6 -- TiledTerrain uses incremental per-chunk streaming
  // (own VBO+IBO per chunk, dropped/built individually as the camera
  // disc shifts). Route to the dedicated path so the monolithic
  // cache-or-rebuild logic below is bypassed entirely.
  if (node.type === "TiledTerrain") {
    return _ensureTiledTerrainChunks(node);
  }
  if (node.type === "Clouds3D") {
    return _ensureClouds3DChunks(node);
  }
  // §planet-spec Phase 6b -- Planet uses the same per-chunk streaming
  // pattern (per-chunk VBOs + two-phase placeholder/upgrade build under
  // a time budget) so deep maxDepth + flying close to the surface
  // doesn't stall the main thread on monolithic-mesh rebuilds.
  if (node.type === "Planet") {
    return _ensurePlanetChunks(node);
  }
  // Sprint 9-2: PlanetMesh routes through the cube-sphere quadtree
  // streaming path (same per-chunk pattern Planet uses, but reading
  // elevation from the wired PlanetMap's cell graph). Replaces the
  // sprint 9-1 static cube-sphere single-mesh builder, which is now
  // unreachable but kept in the file as a reference fallback.
  if (node.type === "PlanetMesh") {
    return _ensurePlanetMeshChunks(node);
  }
  const cached = Visual.meshBufferCache.get(node.id);
  if (cached && _meshCacheKey(node) === cached.cacheKey) return cached;
  // Params changed -- destroy + rebuild. Cheap (just a couple of
  // GPU buffers); avoids stale geometry when the user tweaks
  // dimensions in the props pane.
  if (cached) {
    try { cached.vertexBuffer && cached.vertexBuffer.destroy(); } catch (_) {}
    try { cached.indexBuffer  && cached.indexBuffer.destroy();  } catch (_) {}
    Visual.meshBufferCache.delete(node.id);
  }
  if (!Visual.device) return null;
  const built = _buildMeshData(node);
  if (!built) return null;
  const { verts, indices, chunks } = built;
  const vertexBuffer = Visual.device.createBuffer({
    label: "mesh-vb-" + node.id,
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(verts);
  vertexBuffer.unmap();
  let indexBuffer = null, indexCount = 0;
  if (indices) {
    indexBuffer = Visual.device.createBuffer({
      label: "mesh-ib-" + node.id,
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint32Array(indexBuffer.getMappedRange()).set(indices);
    indexBuffer.unmap();
    indexCount = indices.length;
  }
  // Sprint 5.10 -- compute the local-space AABB from vertex data so
  // the encoder can frustum-cull this mesh. Cheap (one pass over
  // verts) and cached alongside the GPU buffers; invalidated by the
  // same cacheKey check above when geometry params change.
  const aabb = _computeLocalAABB(verts);
  const out = {
    vertexBuffer,
    vertexCount: verts.length / 11,  // Sprint 7.5.3c push 6: 11 floats per vertex (pos + color + normal + uv)
    indexBuffer,
    indexCount,
    cacheKey: _meshCacheKey(node),
    aabbMin: aabb.min,
    aabbMax: aabb.max,
    // §5.5.e-2 -- per-chunk draw ranges + AABBs. Only set for
    // TiledTerrain (it's the only mesh-gen that emits chunks[]
    // from _buildMeshData). When present, the encoder issues one
    // drawIndexed per visible chunk + skips off-frustum chunks.
    chunks: chunks || null
  };
  Visual.meshBufferCache.set(node.id, out);
  return out;
}

/* Sprint 5.10 -- local-space AABB from interleaved vertex data.
 * Vertex stride is 11 floats: pos (3) + color (3) + normal (3) + uv
 * (2); position is at indices 0..2. Returns { min: [x,y,z], max:
 * [x,y,z] }. Empty verts -> degenerate zero-size AABB at origin
 * (caller's cull test treats this as outside the frustum). */
function _computeLocalAABB(verts) {
  if (!verts || verts.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const stride = 11;
  const n = verts.length / stride;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = i * stride;
    const px = verts[k], py = verts[k + 1], pz = verts[k + 2];
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/* Sprint 5.10 -- AABB-vs-frustum test. 6-plane SAT: for each plane
 * (a, b, c, d) with normal pointing inside the frustum, find the
 * AABB corner farthest along the normal (the "positive corner");
 * if even that corner is on the negative side of the plane, the
 * AABB is fully outside the frustum -> cull. Otherwise either
 * intersecting or inside -> draw.
 *
 * worldMin / worldMax are the WORLD-SPACE AABB after transforming
 * the local-space AABB through the mesh's model matrix. Cheap to
 * derive: pass the 8 local corners through the matrix + take new
 * min/max. */
function _aabbInsideFrustum(planes, worldMin, worldMax) {
  for (let p = 0; p < 6; p++) {
    const a = planes[p * 4 + 0];
    const b = planes[p * 4 + 1];
    const c = planes[p * 4 + 2];
    const d = planes[p * 4 + 3];
    const px = (a > 0) ? worldMax[0] : worldMin[0];
    const py = (b > 0) ? worldMax[1] : worldMin[1];
    const pz = (c > 0) ? worldMax[2] : worldMin[2];
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/* Sprint 5.10 -- transform a local AABB through a model matrix to
 * get the world-space AABB. Transforms all 8 corners then takes
 * min/max (vs the cheaper but less accurate "transform center +
 * extend by half-diagonal" — the 8-corner version is tight under
 * rotation, which matters when meshes are rotated 45° away from
 * axis-aligned). worldMin / worldMax are written into the supplied
 * Float32Array(3) outputs to avoid per-frame allocation. */
function _transformAABB(localMin, localMax, model, outMin, outMax) {
  let nx = Infinity, ny = Infinity, nz = Infinity;
  let xx = -Infinity, xy = -Infinity, xz = -Infinity;
  const m0 = model[0], m1 = model[1], m2 = model[2];
  const m4 = model[4], m5 = model[5], m6 = model[6];
  const m8 = model[8], m9 = model[9], m10 = model[10];
  const m12 = model[12], m13 = model[13], m14 = model[14];
  for (let i = 0; i < 8; i++) {
    const x = (i & 1) ? localMax[0] : localMin[0];
    const y = (i & 2) ? localMax[1] : localMin[1];
    const z = (i & 4) ? localMax[2] : localMin[2];
    const wx = m0 * x + m4 * y + m8  * z + m12;
    const wy = m1 * x + m5 * y + m9  * z + m13;
    const wz = m2 * x + m6 * y + m10 * z + m14;
    if (wx < nx) nx = wx; if (wx > xx) xx = wx;
    if (wy < ny) ny = wy; if (wy > xy) xy = wy;
    if (wz < nz) nz = wz; if (wz > xz) xz = wz;
  }
  outMin[0] = nx; outMin[1] = ny; outMin[2] = nz;
  outMax[0] = xx; outMax[1] = xy; outMax[2] = xz;
}

/* Param-fingerprint string used to invalidate the mesh cache when a
 * primitive's dimensions / segment counts change. Each primitive
 * type lists the params that actually affect geometry. */
function _meshCacheKey(node) {
  const p = node.params || {};
  switch (node.type) {
    case "DebugTriangle": return "tri:" + (p.scale || 1);
    case "Box":           return "box:" + [p.width, p.height, p.depth].join(",");
    case "Sphere":        return "sph:" + [p.radius, p.stacks, p.slices].join(",");
    case "Capsule":       return "cap:" + [p.radius, p.halfHeight, p.slices].join(",");
    case "DestructibleBody3D": return "destruct:" + node.id + ":" + (node.params && node.params.destroyed ? "d" + Math.floor(performance.now()) : "s");
    case "Rope3D":        return "rope:" + node.id + ":" + (node._ropeVer || 0);
    case "Cloth3D":       return "cloth:" + node.id + ":" + (node._clothVer || 0);
    case "SoftBody3D":    return "soft:" + node.id + ":" + (node._sbVer || 0);
    case "LoadGLB":       return "glb:" + node.id + ":" + (node.params && node.params.url) + ":" + (node.params && node.params.scale) + ":" + (node.params && node.params.autoFit) + ":" + (node._glbState || "") + ":" + (node._glbVer || 0);
    case "Planet":        {
      // §planet-spec Phase 4.c/e -- include a quantized PLANET-LOCAL
      // camera position so the quadtree rebuilds when the camera
      // crosses a finest-depth chunk boundary. Quantum = radius /
      // 2^maxDepth (≈ leaf-chunk edge near the camera). The center
      // params shift the cam-to-planet origin -- two Planet nodes at
      // different centers can share the same camera and still rebuild
      // independently.
      const r = (typeof p.radius === "number") ? p.radius : 1000;
      const md = Math.max(0, Math.min(14, Math.floor((typeof p.maxDepth === "number") ? p.maxDepth : 6)));
      const quantum = r / Math.pow(2, md);
      const cxC = (typeof p.centerX === "number") ? p.centerX : 0;
      const cyC = (typeof p.centerY === "number") ? p.centerY : 0;
      const czC = (typeof p.centerZ === "number") ? p.centerZ : 0;
      const c = _planetCameraPos(node);
      const qx = Math.round((c.x - cxC) / quantum);
      const qy = Math.round((c.y - cyC) / quantum);
      const qz = Math.round((c.z - czC) / quantum);
      return "plt:" + [
        p.radius, p.polarRadiusRatio,
        p.centerX, p.centerY, p.centerZ,
        p.segments, p.maxDepth, p.splitFactor,
        p.heightScale, p.seaLevel,
        p.seed, p.frequency, p.octaves, p.lacunarity, p.gain, p.ridges,
        qx, qy, qz
      ].join(",");
    }
    case "PlanetMesh":    {
      // §planet-spec Phase 7.d-azgaar -- cache key includes the wired
      // PlanetMap's cells key so editing PlanetMap (or its painter)
      // rebuilds the mesh from updated cell elevations.
      let pmKey = "no-map";
      if (state && Array.isArray(state.edges)) {
        const edge = state.edges.find(e =>
          e && e.to && e.to.node === node.id && e.to.port === "heightmap"
        );
        if (edge && edge.from) {
          const src = state.nodes.find(n => n && n.id === edge.from.node);
          if (src && src.type === "PlanetMap") {
            pmKey = _planetMapCacheKey(src);
          }
        }
      }
      return "pmesh:" + [
        p.radius, p.polarRadiusRatio,
        p.centerX, p.centerY, p.centerZ,
        p.heightScale, p.seaLevel,
        pmKey
      ].join(",");
    }
    case "Plane":         return "pln:" + [p.width, p.depth].join(",");
    case "Sprite":        return "spr:" + [p.width, p.height, p.anchorX, p.anchorY, p.tintR, p.tintG, p.tintB, p.tintA].join(",");
    case "Tilemap2D":     return "tmap:" + [p.tileData, p.tileSize, p.originX, p.originY,
                                            p.color1R, p.color1G, p.color1B,
                                            p.color2R, p.color2G, p.color2B,
                                            p.color3R, p.color3G, p.color3B,
                                            p.color4R, p.color4G, p.color4B,
                                            p.color5R, p.color5G, p.color5B,
                                            p.skipRenderChars,
                                            // Phase 2 tileset fields. tileMap object
                                            // stringified so JSON identity invalidates
                                            // when the user remaps chars.
                                            p.tileset || "",
                                            (typeof p.tileMap === "object" ? JSON.stringify(p.tileMap) : (p.tileMap || "")),
                                            p.tilesetFramesX || 0,
                                            p.tilesetFramesY || 0,
                                            p.depthZ || 0].join(",");
    case "TileSpriteOverlay": {
      // Cache key includes the wired tilemap's tileData + this node's
      // params so the overlay mesh rebuilds on tile-data mutation
      // (PickupCollector clearing collected eggs). Bob amplitude > 0
      // also bakes a time bucket into the key so the bob is visible.
      const tmap = (typeof _findWiredOrFirst === "function")
        ? _findWiredOrFirst(node, "tilemap", "Tilemap2D") : null;
      const tdata = tmap ? (tmap.params && tmap.params.tileData) || "" : "";
      const bobBucket = (p.bobAmplitude > 0)
        ? Math.floor(performance.now() / 60) : 0;
      return "tso:" + [
        tdata, p.tileChar, p.scale, p.anchorX, p.anchorY,
        p.frame, p.framesX, p.framesY,
        p.tintR, p.tintG, p.tintB, p.tintA,
        p.bobAmplitude, p.bobSpeed, bobBucket,
        p.depthZ
      ].join(",");
    }
    case "ParallaxLayer2D": {
      // Mesh follows the camera, so the cache key includes the
      // (quantized) camera position. 0.05 world-unit quantum is
      // small enough that scroll feels smooth + large enough that
      // we don't rebuild the mesh every render frame for static
      // cameras. Also include canvas dims so a resize rebuilds.
      let cposX = 0, cposY = 0;
      let camSrc = null;
      if (node._levelCameraNodeId) {
        camSrc = state.nodes.find(n => n && n.id === node._levelCameraNodeId);
      } else if (state && Array.isArray(state.edges)) {
        const wire = state.edges.find(e =>
          e && e.to && e.to.node === node.id && e.to.port === "camera"
        );
        if (wire && wire.from) {
          camSrc = state.nodes.find(n => n && n.id === wire.from.node);
        }
      }
      if (camSrc && camSrc.params) {
        cposX = camSrc.params.posX || 0;
        cposY = camSrc.params.posY || 0;
      }
      const qX = Math.round(cposX * 20) / 20;   // 0.05 unit quantum
      const qY = Math.round(cposY * 20) / 20;
      const cw = (typeof Visual !== "undefined" && Visual.canvas) ? (Visual.canvas.width  | 0) : 0;
      const ch = (typeof Visual !== "undefined" && Visual.canvas) ? (Visual.canvas.height | 0) : 0;
      return "plx:" + [
        qX, qY, cw, ch,
        p.parallaxX, p.texWorldWidth,
        p.screenScaleY, p.screenAnchorY, p.worldOffsetY,
        p.tintR, p.tintG, p.tintB, p.tintA,
        p.depthZ
      ].join(",");
    }
    case "SpriteScatter2D":
      return "ss2d:" + [
        p.positions, p.scale, p.anchorX, p.anchorY,
        p.frame, p.framesX, p.framesY,
        p.tintR, p.tintG, p.tintB, p.tintA,
        p.depthZ
      ].join(",");
    case "Torus":         return "tor:" + [p.majorRadius, p.minorRadius, p.majorSlices, p.minorSlices].join(",");
    case "Cylinder":      return "cyl:" + [p.radius, p.height, p.slices].join(",");
    case "Cone":          return "con:" + [p.radius, p.height, p.slices].join(",");
    case "Terrain":       {
      // v0.3.126 §5.5.c-3 -- include heightmap-wired state so the
      // mesh cache rebuilds when the user wires / unwires
      // ProceduralTerrain (flat-grid vs CPU-displaced).
      const wired = Array.isArray(state.edges) && state.edges.some(e =>
        e && e.to && e.to.node === node.id && e.to.port === "heightmap"
      );
      return "ter:" + [
        p.sizeMode, p.worldSize, p.heightScale, p.yOffset, p.segments,
        p.seed, p.frequency, p.octaves, p.lacunarity, p.gain, p.ridges,
        wired ? "g" : "c"
      ].join(",");
    }
    case "TerrainHorizon": {
      // §5.5.h-23 -- include the macro-tile in the key so crossing
      // tileSize triggers a rebuild centered on the new tile. Also
      // include the upstream TiledTerrain's noise params so the
      // horizon stays in sync with the chunked disc.
      const tile = _terrainHorizonMacroTile(node);
      const tt = (state && Array.isArray(state.nodes))
        ? state.nodes.find(n => n && n.type === "TiledTerrain") : null;
      const ttp = (tt && tt.params) || {};
      const ip  = tt ? _findTiledIslandParams(tt) : null;
      // §planet-spec Phase 1.5 -- visAltLow/visAltHigh DON'T need to
      // be in the cache key (the mesh geometry is identical at any
      // altitude; only the fragment shader's discard threshold
      // changes, and that's a per-frame uniform).
      // §planet-spec Phase 3 -- noiseFreqScale gone; octavesCap added.
      return "thr:" + [
        p.extent, p.subdivisions, p.tileSize, p.yBias, p.octavesCap,
        tile.tx, tile.tz,
        ttp.seed, ttp.frequency, ttp.octaves, ttp.lacunarity, ttp.gain,
        ttp.ridges, ttp.plateau, ttp.heightScale, ttp.yOffset,
        ip ? (ip.mode + ":" + ip.maskFreq + ":" + ip.maskSeed + ":" + ip.maskThreshold +
              ":" + ip.maskSoftness + ":" + ip.sinkDepth) : "i0"
      ].join(",");
    }
    // TiledTerrain doesn't use _meshCacheKey -- _ensureTiledTerrainChunks
    // manages its own per-chunk cache keyed by (tileX, tileZ, lod).
    case "Water":         {
      // §planet-spec Phase 6b -- with a Planet in the patch, Water is
      // a static 6-face cube-sphere shell wrapping the planet at sea
      // radius. Geometry depends only on Planet's center/radius/polRatio
      // and the seaLevel offset -- NOT on the camera (the sphere
      // wraps everything from any angle). No camera quantum needed.
      const planet = _findPlanetForProjection();
      if (planet) {
        return "water-sph:" + [
          p.seaLevel || 0,
          planet.cx, planet.cy, planet.cz, planet.r, planet.polRatio
        ].join(",");
      }
      return "water:" + (p.seaLevel || 0);
    }
    default:              return node.type;
  }
}

