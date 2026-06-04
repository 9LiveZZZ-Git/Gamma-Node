/* Build vertex + index arrays for a mesh-gen node. Returns {verts,
 * indices} or null on unknown type. Vertex layout is (pos.xyz,
 * color.rgb) interleaved float32 -- matches the pipeline's vertex
 * buffer layout exactly. Color is generated per-primitive: Box uses
 * distinct per-face colors; everything else uses normal-derived
 * shading (color = (normal + 1) * 0.5, so each direction maps to
 * a distinct hue) for an immediately-legible 3D shape. Materials
 * in sprint 7.5.3c replace this with proper lit shading. */
function _buildMeshData(node) {
  switch (node.type) {
    case "DebugTriangle": return _buildDebugTriangle(node);
    case "Box":           return _buildBox(node);
    case "Sphere":        return _buildSphere(node);
    case "Capsule":       return _buildCapsule(node);
    case "DestructibleBody3D": return _buildDestructibleMesh(node);
    case "Rope3D":        return _buildRopeMesh(node);
    case "Cloth3D":       return _buildClothMesh(node);
    case "SoftBody3D":    return _buildSoftBodyMesh(node);
    case "LoadGLB":       return _buildGLBMesh(node);
    case "Planet":        return _buildPlanet(node);
    case "PlanetMesh":    return _buildPlanetMesh(node);
    case "Plane":         return _buildPlane(node);
    case "Sprite":        return _buildSprite(node);
    case "Tilemap2D":         return _buildTilemap2D(node);
    case "TileSpriteOverlay": return _buildTileSpriteOverlay(node);
    case "ParallaxLayer2D":   return _buildParallaxLayer2D(node);
    case "SpriteScatter2D":   return _buildSpriteScatter2D(node);
    case "Torus":         return _buildTorus(node);
    case "Cylinder":      return _buildCylinder(node);
    case "Cone":          return _buildCone(node);
    case "Terrain":       return _buildTerrain(node);
    case "Water":            return _buildWater(node);
    case "TerrainHorizon":   return _buildTerrainHorizon(node);
    // Clouds3D handled by the chunked streaming path in
    // _ensureMeshBuffers; not reachable here.
    default: return null;
  }
}

function _buildDebugTriangle(node) {
  const s = (node.params && typeof node.params.scale === "number") ? node.params.scale : 1.0;
  // pos.xyz  color.rgb       normal.xyz  uv.xy  -- triangle faces +Z, normal = (0, 0, 1).
  const verts = new Float32Array([
    -0.866*s, -0.5*s, 0,     1, 0, 0,      0, 0, 1,   0,   0,
     0.866*s, -0.5*s, 0,     0, 1, 0,      0, 0, 1,   1,   0,
     0,        1.0*s, 0,     0.3, 0.5, 1,  0, 0, 1,   0.5, 1
  ]);
  return { verts, indices: null };
}

/* Rope3D -- tube mesh swept along the PBD particle polyline (set by
 * _tickRopes). K-sided ring per particle, oriented by a parallel-
 * transport-ish frame; rings connected by quads. 11-float vertex
 * format (pos3 + color3 + normal3 + uv2). Falls back to a straight
 * line between the attach points if the sim hasn't run yet. */
function _buildRopeMesh(node) {
  const p = node.params || {};
  const radius = Math.max(0.01, (typeof p.radius === "number") ? p.radius : 0.12);
  const col = [
    (typeof p.r === "number") ? p.r : 0.45,
    (typeof p.g === "number") ? p.g : 0.32,
    (typeof p.b === "number") ? p.b : 0.2
  ];
  // Particle centerline. If the sim hasn't populated _particles yet,
  // synthesize a straight segment from the static attach params.
  let pts = (node._particles && node._particles.length >= 2)
    ? node._particles.map(q => [q.x, q.y, q.z])
    : null;
  if (!pts) {
    const ax = p.ax || 0, ay = (typeof p.ay === "number") ? p.ay : 6, az = p.az || 0;
    const bx = p.bx || 0, by = p.by || 0, bz = p.bz || 0;
    const segs = Math.max(2, Math.min(64, Math.round((typeof p.segments === "number") ? p.segments : 16)));
    pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push([ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t]);
    }
  }
  const M = pts.length;          // rings
  const K = 6;                   // sides per ring
  const verts = new Float32Array(M * K * 11);
  const indices = new Uint32Array((M - 1) * K * 6);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1e-6; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
  let v = 0;
  for (let i = 0; i < M; i++) {
    // Tangent via central difference.
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(M - 1, i + 1)];
    let tan = norm(sub(next, prev));
    if (!isFinite(tan[0])) tan = [0, 1, 0];
    // Frame: pick an up not parallel to tangent.
    let up = (Math.abs(tan[1]) > 0.9) ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(tan, up));
    const w = norm(cross(tan, u));
    const c = pts[i];
    const tv = i / (M - 1);
    for (let k = 0; k < K; k++) {
      const ang = (k / K) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const nx = u[0] * ca + w[0] * sa, ny = u[1] * ca + w[1] * sa, nz = u[2] * ca + w[2] * sa;
      verts[v++] = c[0] + nx * radius; verts[v++] = c[1] + ny * radius; verts[v++] = c[2] + nz * radius;
      verts[v++] = col[0]; verts[v++] = col[1]; verts[v++] = col[2];
      verts[v++] = nx; verts[v++] = ny; verts[v++] = nz;
      verts[v++] = k / K; verts[v++] = tv;
    }
  }
  let ii = 0;
  for (let i = 0; i < M - 1; i++) {
    for (let k = 0; k < K; k++) {
      const a = i * K + k;
      const b = i * K + (k + 1) % K;
      const c = (i + 1) * K + k;
      const d = (i + 1) * K + (k + 1) % K;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }
  return { verts, indices };
}

/* Cloth3D -- triangulate the PBD particle grid (set by _tickCloths)
 * into a mesh. Per-vertex normals from the grid tangents. The scene
 * pipeline is cullMode:"none", so a single-sided grid shows both
 * faces. Falls back to a flat resting sheet from params if the sim
 * hasn't run yet. 11-float verts (pos3 + color3 + normal3 + uv2). */
function _buildClothMesh(node) {
  const p = node.params || {};
  const col = [
    (typeof p.r === "number") ? p.r : 0.7,
    (typeof p.g === "number") ? p.g : 0.2,
    (typeof p.b === "number") ? p.b : 0.25
  ];
  let P = node._cloth, dims = node._clothDims;
  if (!P || !dims) {
    // Flat fallback from params.
    const nx = Math.max(2, Math.min(40, Math.round((typeof p.resX === "number") ? p.resX : 16)));
    const ny = Math.max(2, Math.min(40, Math.round((typeof p.resY === "number") ? p.resY : 10)));
    const W = (typeof p.width === "number") ? p.width : 6;
    const H = (typeof p.height === "number") ? p.height : 4;
    const ox = p.originX || 0, oy = (typeof p.originY === "number") ? p.originY : 6, oz = p.originZ || 0;
    const cols = nx + 1, rows = ny + 1;
    P = new Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      P[j * cols + i] = { x: ox + (i / nx) * W, y: oy - (j / ny) * H, z: oz };
    }
    dims = { nx, ny, cols, rows };
  }
  const { cols, rows } = dims;
  const idx = (i, j) => j * cols + i;
  const verts = new Float32Array(cols * rows * 11);
  let v = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = P[idx(i, j)];
      // Tangents via neighbor differences (clamped at edges).
      const r0 = P[idx(Math.min(cols - 1, i + 1), j)], l0 = P[idx(Math.max(0, i - 1), j)];
      const d0 = P[idx(i, Math.min(rows - 1, j + 1))], u0 = P[idx(i, Math.max(0, j - 1))];
      const tx = r0.x - l0.x, ty = r0.y - l0.y, tz = r0.z - l0.z;
      const bx = d0.x - u0.x, by = d0.y - u0.y, bz = d0.z - u0.z;
      // normal = tangent × bitangent
      let nxN = ty * bz - tz * by, nyN = tz * bx - tx * bz, nzN = tx * by - ty * bx;
      const nl = Math.hypot(nxN, nyN, nzN) || 1e-6;
      nxN /= nl; nyN /= nl; nzN /= nl;
      verts[v++] = c.x; verts[v++] = c.y; verts[v++] = c.z;
      verts[v++] = col[0]; verts[v++] = col[1]; verts[v++] = col[2];
      verts[v++] = nxN; verts[v++] = nyN; verts[v++] = nzN;
      verts[v++] = i / (cols - 1); verts[v++] = j / (rows - 1);
    }
  }
  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let ii = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = idx(i, j), b = idx(i + 1, j), cc = idx(i, j + 1), d = idx(i + 1, j + 1);
      indices[ii++] = a; indices[ii++] = cc; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = cc; indices[ii++] = d;
    }
  }
  return { verts, indices };
}

/* SoftBody3D -- render the deforming shell of the res³ particle
 * lattice (set by _tickSoftBodies). INDEXED with shared surface
 * vertices + SMOOTH (area-weighted) normals accumulated across all
 * adjacent faces — so the cube edges round off and the jelly reads
 * smooth rather than faceted. Falls back to the rest cube. */
function _buildSoftBodyMesh(node) {
  const p = node.params || {};
  const col = [
    (typeof p.r === "number") ? p.r : 0.55,
    (typeof p.g === "number") ? p.g : 0.85,
    (typeof p.b === "number") ? p.b : 0.65
  ];
  let P = node._sb, R = node._sbR;
  if (!P || !R) {
    R = Math.max(2, Math.min(8, Math.round((typeof p.res === "number") ? p.res : 5)));
    const size = Math.max(0.2, (typeof p.size === "number") ? p.size : 2.5);
    const ox = p.originX || 0, oy = (typeof p.originY === "number") ? p.originY : 6, oz = p.originZ || 0;
    const step = size / (R - 1), base = { x: ox - size/2, y: oy - size/2, z: oz - size/2 };
    P = new Array(R*R*R);
    for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++)
      P[(k*R+j)*R+i] = { x: base.x+i*step, y: base.y+j*step, z: base.z+k*step };
  }
  const idx = (i, j, k) => (k * R + j) * R + i;
  // One shared vertex per SURFACE particle (so edge/corner verts are
  // shared between faces and their normals average → rounded edges).
  const vmap = new Map();
  const vparts = [];
  const isSurf = (i, j, k) => i === 0 || i === R-1 || j === 0 || j === R-1 || k === 0 || k === R-1;
  for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    if (isSurf(i, j, k)) { vmap.set(idx(i, j, k), vparts.length); vparts.push(idx(i, j, k)); }
  }
  const VN = vparts.length;
  const px = new Float32Array(VN), py = new Float32Array(VN), pz = new Float32Array(VN);
  const nx = new Float32Array(VN), ny = new Float32Array(VN), nz = new Float32Array(VN);
  for (let v = 0; v < VN; v++) { const q = P[vparts[v]]; px[v] = q.x; py[v] = q.y; pz[v] = q.z; }

  const tri = [];
  const quad = (a, b, c, d) => {
    const va = vmap.get(a), vb = vmap.get(b), vc = vmap.get(c), vd = vmap.get(d);
    tri.push(va, vb, vc, va, vc, vd);
  };
  for (let a = 0; a < R - 1; a++) {
    for (let b = 0; b < R - 1; b++) {
      quad(idx(0, a, b), idx(0, a, b+1), idx(0, a+1, b+1), idx(0, a+1, b));            // -X
      quad(idx(R-1, a, b), idx(R-1, a+1, b), idx(R-1, a+1, b+1), idx(R-1, a, b+1));    // +X
      quad(idx(a, 0, b), idx(a+1, 0, b), idx(a+1, 0, b+1), idx(a, 0, b+1));            // -Y
      quad(idx(a, R-1, b), idx(a, R-1, b+1), idx(a+1, R-1, b+1), idx(a+1, R-1, b));    // +Y
      quad(idx(a, b, 0), idx(a, b+1, 0), idx(a+1, b+1, 0), idx(a+1, b, 0));            // -Z
      quad(idx(a, b, R-1), idx(a+1, b, R-1), idx(a+1, b+1, R-1), idx(a, b+1, R-1));    // +Z
    }
  }
  // Accumulate face normals into shared verts (area-weighted = raw
  // cross product, not normalized per-face).
  for (let t = 0; t < tri.length; t += 3) {
    const i0 = tri[t], i1 = tri[t+1], i2 = tri[t+2];
    const e1x = px[i1]-px[i0], e1y = py[i1]-py[i0], e1z = pz[i1]-pz[i0];
    const e2x = px[i2]-px[i0], e2y = py[i2]-py[i0], e2z = pz[i2]-pz[i0];
    const fx = e1y*e2z - e1z*e2y, fy = e1z*e2x - e1x*e2z, fz = e1x*e2y - e1y*e2x;
    nx[i0]+=fx; ny[i0]+=fy; nz[i0]+=fz;
    nx[i1]+=fx; ny[i1]+=fy; nz[i1]+=fz;
    nx[i2]+=fx; ny[i2]+=fy; nz[i2]+=fz;
  }
  const verts = new Float32Array(VN * 11);
  for (let v = 0; v < VN; v++) {
    let a = nx[v], b = ny[v], c = nz[v];
    const l = Math.hypot(a, b, c) || 1e-6; a/=l; b/=l; c/=l;
    const o = v * 11;
    verts[o] = px[v]; verts[o+1] = py[v]; verts[o+2] = pz[v];
    verts[o+3] = col[0]; verts[o+4] = col[1]; verts[o+5] = col[2];
    verts[o+6] = a; verts[o+7] = b; verts[o+8] = c;
    verts[o+9] = 0; verts[o+10] = 0;
  }
  return { verts, indices: new Uint32Array(tri) };
}

/* ── Phase 8.B.15 / §8.F -- LoadGLB glTF import ───────────────────── */
let _threeModPromise = null;
/* Lazy-load three.js + GLTFLoader from a CDN that resolves the bare
 * "three" import inside the loader (esm.sh). Same dynamic-import
 * pattern as Rapier / transformers.js — no build step, no bundling. */
function _ensureThree() {
  if (_threeModPromise) return _threeModPromise;
  console.log("[glb] loading three.js + GLTFLoader…");
  _threeModPromise = (async () => {
    const THREE = await import("https://esm.sh/three@0.160.0");
    const mod = await import("https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js");
    console.log("[glb] three.js ready");
    return { THREE, GLTFLoader: mod.GLTFLoader };
  })();
  return _threeModPromise;
}

/* Resolve a LoadGLB url param to a fetchable URL. server:<id> streams
 * from the compile-server asset host; asset:<name> resolves through
 * the cached server manifest; http(s) is used directly. */
function _resolveGLBUrl(url) {
  if (typeof url !== "string" || !url) return null;
  const base = _serverAssetsBase || (typeof localServerEndpoint === "string" ? localServerEndpoint : null);
  if (url.startsWith("server:")) {
    const id = url.slice(7);
    return base ? base + "/assets/" + encodeURIComponent(id) : null;
  }
  if (url.startsWith("asset:")) {
    const name = url.slice(6).toLowerCase();
    const hit = (_serverAssets || []).find(a => a && (a.id === name || (a.name || "").toLowerCase() === name));
    if (hit && base) return base + "/assets/" + encodeURIComponent(hit.id);
    return null;
  }
  if (/^https?:\/\//.test(url)) return url;
  return null;
}

/* Merge every Mesh primitive in a parsed glTF into one editor-format
 * buffer (pos3 + color3 + normal3 + uv2), world-transformed, with the
 * material base color baked into the vertex color. */
function _gltfToEditorMesh(gltf, THREE, params) {
  const scale = (params && typeof params.scale === "number") ? params.scale : 1;
  const verts = [], indices = [];
  let vbase = 0;
  const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!root) return { verts: new Float32Array(0), indices: new Uint32Array(0) };
  root.updateMatrixWorld(true);
  const vtmp = new THREE.Vector3(), ntmp = new THREE.Vector3();
  const wm = new THREE.Matrix4(), im = new THREE.Matrix4();
  root.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    const g = obj.geometry;
    const pos = g.attributes && g.attributes.position;
    if (!pos) return;
    const nrm = g.attributes.normal, uv = g.attributes.uv, idx = g.index;
    let cr = 0.8, cg = 0.8, cb = 0.8;
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    if (mat && mat.color) { cr = mat.color.r; cg = mat.color.g; cb = mat.color.b; }
    const count = pos.count;
    // InstancedMesh (common in city kits for repeated windows / props):
    // emit the geometry once PER INSTANCE, composing each instance
    // matrix with the object's world matrix. Plain meshes = 1 pass.
    const instN = (obj.isInstancedMesh && obj.count) ? obj.count : 1;
    for (let inst = 0; inst < instN; inst++) {
      if (obj.isInstancedMesh) { obj.getMatrixAt(inst, im); wm.multiplyMatrices(obj.matrixWorld, im); }
      else { wm.copy(obj.matrixWorld); }
      const nm = new THREE.Matrix3().getNormalMatrix(wm);
      for (let i = 0; i < count; i++) {
        vtmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(wm);
        let nx = 0, ny = 1, nz = 0;
        if (nrm) { ntmp.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyMatrix3(nm).normalize(); nx = ntmp.x; ny = ntmp.y; nz = ntmp.z; }
        const u = uv ? uv.getX(i) : 0, v = uv ? uv.getY(i) : 0;
        verts.push(vtmp.x * scale, vtmp.y * scale, vtmp.z * scale, cr, cg, cb, nx, ny, nz, u, v);
      }
      if (idx) { for (let i = 0; i < idx.count; i++) indices.push(vbase + idx.getX(i)); }
      else { for (let i = 0; i < count; i++) indices.push(vbase + i); }
      vbase += count;
    }
  });
  // autoFit > 0: normalize to a consistent size regardless of the
  // source mesh's units. Centers on X/Z, rests the base at y=0, and
  // scales so the largest dimension = autoFit world units. Fixes the
  // "props come at wildly different scales / off-origin" problem.
  const autoFit = (params && typeof params.autoFit === "number") ? params.autoFit : 0;
  if (autoFit > 0 && verts.length) {
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < verts.length; i += 11) {
      const x = verts[i], y = verts[i+1], z = verts[i+2];
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
    const maxDim = Math.max(mxx - mnx, mxy - mny, mxz - mnz) || 1;
    const s = autoFit / maxDim;
    const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2;
    for (let i = 0; i < verts.length; i += 11) {
      verts[i]   = (verts[i]   - cx)  * s;
      verts[i+1] = (verts[i+1] - mny) * s;   // base sits on y = 0
      verts[i+2] = (verts[i+2] - cz)  * s;
    }
  }
  return { verts: new Float32Array(verts), indices: new Uint32Array(indices) };
}

async function _loadGLB(node) {
  node._glbState = "loading";
  node._glbUrl = node.params && node.params.url;
  try {
    const u0 = node.params && node.params.url;
    // server:/asset: urls need the compile-server base — probe it (and
    // the manifest for asset:<name>) if the Assets tab hasn't already.
    if (typeof u0 === "string" && (u0.startsWith("server:") || u0.startsWith("asset:"))) {
      if (!_serverAssetsBase && typeof probeLocalServer === "function") {
        try { await probeLocalServer(); } catch (_) {}
        if (!_serverAssetsBase && typeof localServerEndpoint === "string") _serverAssetsBase = localServerEndpoint;
      }
      if (u0.startsWith("asset:") && (!_serverAssets || !_serverAssets.length) &&
          typeof brRefreshServerAssets === "function") {
        try { await brRefreshServerAssets(); } catch (_) {}
      }
    }
    const url = _resolveGLBUrl(u0);
    if (!url) throw new Error("unresolved url: " + (node.params && node.params.url) + " (compile-server running?)");
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const { THREE, GLTFLoader } = await _ensureThree();
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      try { loader.parse(buf, "", resolve, reject); } catch (e) { reject(e); }
    });
    const mesh = _gltfToEditorMesh(gltf, THREE, node.params);
    if (!mesh.verts.length) throw new Error("no geometry in glTF");
    // Free three.js GPU/CPU resources — we only keep the extracted
    // vertex buffers, so the parsed scene + its (often large) embedded
    // textures shouldn't linger and balloon memory.
    try {
      const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      root && root.traverse(o => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const mm of mats) {
          if (!mm) continue;
          for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"]) {
            if (mm[k] && mm[k].dispose) mm[k].dispose();
          }
          if (mm.dispose) mm.dispose();
        }
      });
    } catch (_) {}
    node._glbMesh = mesh;
    node._glbState = "ready";
    node._glbVer = (node._glbVer || 0) + 1;
    if (node.params) node.params.ready = 1;
    console.log("[glb] " + node.id + " loaded: " + (mesh.verts.length / 11) + " verts");
  } catch (e) {
    console.warn("[glb] " + node.id + " load failed:", e && e.message);
    node._glbState = "error";
    if (node.params) node.params.ready = 0;
  }
}

/* Small placeholder cube shown while a GLB loads / on error. */
function _glbPlaceholder() {
  const h = 0.5, c = [0.45, 0.5, 0.6];
  const fb = _buildBox({ params: { width: 1, height: 1, depth: 1 } });
  // recolor to a neutral grey-blue
  for (let i = 0; i < fb.verts.length; i += 11) { fb.verts[i+3] = c[0]; fb.verts[i+4] = c[1]; fb.verts[i+5] = c[2]; }
  return fb;
}

function _buildGLBMesh(node) {
  // Kick a (re)load when first seen or when the url changed.
  if (!node._glbState || (node.params && node.params.url !== node._glbUrl)) {
    node._glbState = "queued";
    node._glbMesh = null;
    _loadGLB(node);
  }
  if (node._glbState === "ready" && node._glbMesh) return node._glbMesh;
  return _glbPlaceholder();
}

/* ── Phase 8.B.15 A.4 -- PhysicalMat PBR texture maps ────────────── */
/* Decode one map URL (server:/asset:/http) into a GPUTexture view.
 * jpg/png/webp via createImageBitmap; .exr via three.js EXRLoader
 * (FloatType → RGBA8). `fmt` = the WebGPU texture format. */
async function _loadMatTexture(rawUrl, fmt) {
  if (rawUrl.startsWith("server:") || rawUrl.startsWith("asset:")) {
    // Make sure the manifest is loaded — the EXR-vs-bitmap sniff below
    // needs the on-disk filename, and a demo may load before the user
    // ever opens the Assets tab.
    if ((!_serverAssets || !_serverAssets.length) && typeof brRefreshServerAssets === "function") {
      try { await brRefreshServerAssets(); } catch (_) {}
    }
    if (!_serverAssetsBase && typeof probeLocalServer === "function") {
      try { await probeLocalServer(); } catch (_) {}
      if (!_serverAssetsBase && typeof localServerEndpoint === "string") _serverAssetsBase = localServerEndpoint;
    }
  }
  const url = _resolveGLBUrl(rawUrl) || (/^https?:\/\//.test(rawUrl) ? rawUrl : null);
  if (!url) throw new Error("unresolved url: " + rawUrl);
  // Server/asset ids are slugged without an extension, so sniff the
  // real on-disk filename from the manifest to decide EXR-vs-bitmap
  // (Poly Haven ships normal/rough maps as .exr).
  let isExr = /\.exr(\?|$)/i.test(rawUrl) || /\.exr(\?|$)/i.test(url);
  if (!isExr && (rawUrl.startsWith("server:") || rawUrl.startsWith("asset:"))) {
    const ref = rawUrl.replace(/^(server|asset):/, "").toLowerCase();
    const hit = (_serverAssets || []).find(a => a && (a.id === ref || (a.name || "").toLowerCase() === ref));
    if (hit && /\.exr$/i.test(hit.file || hit.name || "")) isExr = true;
  }
  if (isExr) {
    const { THREE } = await _ensureThree();
    const mod = await import("https://esm.sh/three@0.160.0/examples/jsm/loaders/EXRLoader.js");
    const loader = new mod.EXRLoader();
    if (loader.setDataType) loader.setDataType(THREE.FloatType);
    const tex = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
    const w = tex.image.width, h = tex.image.height, src = tex.image.data;
    const ch = Math.max(1, Math.round(src.length / (w * h)));
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const r = src[i * ch] || 0, g = (ch > 1 ? src[i * ch + 1] : src[i * ch]) || 0, b = (ch > 2 ? src[i * ch + 2] : src[i * ch]) || 0;
      out[i*4]   = Math.max(0, Math.min(255, Math.round(r * 255)));
      out[i*4+1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      out[i*4+2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      out[i*4+3] = 255;
    }
    const gt = Visual.device.createTexture({
      label: "mat-exr", size: [w, h, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    Visual.device.queue.writeTexture({ texture: gt }, out, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
    if (tex.dispose) tex.dispose();
    return gt.createView({ label: "mat-exr-view" });
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const gt = Visual.device.createTexture({
    label: "mat-tex", size: [bmp.width, bmp.height, 1], format: fmt,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  });
  Visual.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: gt }, [bmp.width, bmp.height]);
  if (bmp.close) bmp.close();
  return gt.createView({ label: "mat-tex-view" });
}

/* Kick off (idempotent) loads for a PhysicalMat node's map params,
 * stashing the resolved views as node._mapAlbedo / _mapNormal /
 * _mapRough / _mapMetal. The draw loop reads those + rebinds the slot. */
function _ensureMatTextures(node) {
  if (!node || !node.params || !Visual.device) return;
  const p = node.params;
  const jobs = [
    ["albedoMap", "_mapAlbedo", "rgba8unorm"],
    ["normalMap", "_mapNormal", "rgba8unorm"],
    ["roughMap",  "_mapRough",  "rgba8unorm"],
    ["metalMap",  "_mapMetal",  "rgba8unorm"]
  ];
  for (const [param, key, fmt] of jobs) {
    const url = (typeof p[param] === "string") ? p[param].trim() : "";
    const sk = key + "Url";
    if (!url) { node[key] = null; node[sk] = ""; continue; }
    if (node[sk] === url) continue;       // already loading/loaded this url
    node[sk] = url;
    node[key] = null;
    _loadMatTexture(url, fmt)
      .then(view => { node[key] = view; })
      .catch(e => console.warn("[mat] " + param + " (" + url + ") failed: " + (e && e.message)));
  }
}

/* Box -- 24 verts (4 per face, NOT shared between faces) so each
 * face can have its own color/normal. 36 indices = 6 faces × 2
 * triangles × 3 verts. Standard cube oriented with +Y up.
 *
 * Face colors (Pantone-ish): +X red, -X cyan, +Y green, -Y magenta,
 * +Z blue, -Z yellow. Easy to identify which face you're looking at. */
function _buildBox(node) {
  const p = node.params || {};
  const hw = ((typeof p.width  === "number") ? p.width  : 1) * 0.5;
  const hh = ((typeof p.height === "number") ? p.height : 1) * 0.5;
  const hd = ((typeof p.depth  === "number") ? p.depth  : 1) * 0.5;
  // Face order: +X, -X, +Y, -Y, +Z, -Z. Each face: 4 verts in
  // CCW order viewed from outside, with explicit normal. Per-face
  // UVs cover the full 0..1 square so each face gets a complete
  // copy of the source texture.
  const faces = [
    { c: [1.00, 0.22, 0.22], n: [ 1, 0, 0], verts: [
      [ hw, -hh, -hd], [ hw,  hh, -hd], [ hw,  hh,  hd], [ hw, -hh,  hd] ]},  // +X
    { c: [0.22, 0.92, 0.95], n: [-1, 0, 0], verts: [
      [-hw, -hh,  hd], [-hw,  hh,  hd], [-hw,  hh, -hd], [-hw, -hh, -hd] ]},  // -X
    { c: [0.45, 0.96, 0.35], n: [ 0, 1, 0], verts: [
      [-hw,  hh,  hd], [ hw,  hh,  hd], [ hw,  hh, -hd], [-hw,  hh, -hd] ]},  // +Y
    { c: [0.96, 0.35, 0.92], n: [ 0,-1, 0], verts: [
      [-hw, -hh, -hd], [ hw, -hh, -hd], [ hw, -hh,  hd], [-hw, -hh,  hd] ]},  // -Y
    { c: [0.40, 0.55, 1.00], n: [ 0, 0, 1], verts: [
      [-hw, -hh,  hd], [ hw, -hh,  hd], [ hw,  hh,  hd], [-hw,  hh,  hd] ]},  // +Z
    { c: [0.98, 0.92, 0.30], n: [ 0, 0,-1], verts: [
      [ hw, -hh, -hd], [-hw, -hh, -hd], [-hw,  hh, -hd], [ hw,  hh, -hd] ]}   // -Z
  ];
  // Per-face UV order matches the vert order: BL, TL, TR, BR.
  // Triangulation (0,1,2 / 0,2,3) traces the full unit square.
  const faceUvs = [[0, 0], [0, 1], [1, 1], [1, 0]];
  const verts = new Float32Array(24 * 11);
  const indices = new Uint32Array(36);
  let v = 0, i = 0, base = 0;
  for (const f of faces) {
    for (let k = 0; k < 4; k++) {
      const pos = f.verts[k];
      const uv  = faceUvs[k];
      verts[v++] = pos[0]; verts[v++] = pos[1]; verts[v++] = pos[2];
      verts[v++] = f.c[0]; verts[v++] = f.c[1]; verts[v++] = f.c[2];
      verts[v++] = f.n[0]; verts[v++] = f.n[1]; verts[v++] = f.n[2];
      verts[v++] = uv[0];  verts[v++] = uv[1];
    }
    indices[i++] = base + 0; indices[i++] = base + 1; indices[i++] = base + 2;
    indices[i++] = base + 0; indices[i++] = base + 2; indices[i++] = base + 3;
    base += 4;
  }
  return { verts, indices };
}

/* Sphere -- UV sphere with `stacks` horizontal slices + `slices`
 * vertical meridians. (stacks+1)*(slices+1) verts, 2*stacks*slices*3
 * indices. Color from surface normal (= normalized position for a
 * unit sphere) mapped (n + 1) * 0.5 -- each direction is a distinct
 * pastel hue. */
function _buildSphere(node) {
  const p = node.params || {};
  const r = (typeof p.radius === "number") ? p.radius : 1;
  const stacks = Math.max(2, Math.min(64, Math.floor((typeof p.stacks === "number") ? p.stacks : 16)));
  const slices = Math.max(3, Math.min(128, Math.floor((typeof p.slices === "number") ? p.slices : 24)));
  // Equirectangular UV: u = slice (longitude), v = stack (latitude
  // from north pole). The seam at u=0/1 is automatically handled
  // by including sl=slices vertex (same position as sl=0, but with
  // u=1 instead of u=0).
  const verts = new Float32Array((stacks + 1) * (slices + 1) * 11);
  const indices = new Uint32Array(stacks * slices * 6);
  let v = 0, i = 0;
  for (let st = 0; st <= stacks; st++) {
    const phi = Math.PI * (st / stacks);                // 0..π (north pole to south)
    const sphi = Math.sin(phi), cphi = Math.cos(phi);
    const vv = st / stacks;
    for (let sl = 0; sl <= slices; sl++) {
      const theta = 2 * Math.PI * (sl / slices);        // 0..2π around Y
      const sth = Math.sin(theta), cth = Math.cos(theta);
      const nx = sphi * cth, ny = cphi, nz = sphi * sth;
      verts[v++] = r * nx; verts[v++] = r * ny; verts[v++] = r * nz;
      verts[v++] = nx * 0.5 + 0.5;
      verts[v++] = ny * 0.5 + 0.5;
      verts[v++] = nz * 0.5 + 0.5;
      verts[v++] = nx; verts[v++] = ny; verts[v++] = nz;
      verts[v++] = sl / slices; verts[v++] = vv;
    }
  }
  for (let st = 0; st < stacks; st++) {
    for (let sl = 0; sl < slices; sl++) {
      const a = st * (slices + 1) + sl;
      const b = a + slices + 1;
      indices[i++] = a;     indices[i++] = b;     indices[i++] = a + 1;
      indices[i++] = a + 1; indices[i++] = b;     indices[i++] = b + 1;
    }
  }
  return { verts, indices };
}

function _buildCapsule(node) {
  const p = node.params || {};
  const r = Math.max(0.01, (typeof p.radius === "number") ? p.radius : 0.25);
  const hh = Math.max(0, (typeof p.halfHeight === "number") ? p.halfHeight : 0.5);
  const sl = Math.max(4, Math.min(48, Math.floor((typeof p.slices === "number") ? p.slices : 12)));
  const capStacks = Math.max(2, Math.floor(sl / 2));
  const totalStacks = capStacks * 2 + 1;
  const vertCount = (totalStacks + 1) * (sl + 1);
  const verts = new Float32Array(vertCount * 11);
  const indices = new Uint32Array(totalStacks * sl * 6);
  let vi = 0, ii = 0;
  for (let st = 0; st <= totalStacks; st++) {
    let phi, yOff;
    if (st <= capStacks) {
      phi = Math.PI * 0.5 * (st / capStacks);
      yOff = hh;
    } else if (st <= capStacks * 2) {
      phi = Math.PI * 0.5;
      yOff = hh - (st - capStacks) / capStacks * 2 * hh;
    } else {
      phi = Math.PI * 0.5 + Math.PI * 0.5 * ((st - capStacks * 2) / capStacks);
      yOff = -hh;
    }
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let s = 0; s <= sl; s++) {
      const th = 2 * Math.PI * (s / sl);
      const nx = sp * Math.cos(th), nz = sp * Math.sin(th), ny = cp;
      const px = r * nx, py = r * ny + yOff, pz = r * nz;
      verts[vi++] = px; verts[vi++] = py; verts[vi++] = pz;
      verts[vi++] = nx * 0.5 + 0.5; verts[vi++] = ny * 0.5 + 0.5; verts[vi++] = nz * 0.5 + 0.5;
      verts[vi++] = nx; verts[vi++] = ny; verts[vi++] = nz;
      verts[vi++] = s / sl; verts[vi++] = st / totalStacks;
    }
  }
  for (let st = 0; st < totalStacks; st++) {
    for (let s = 0; s < sl; s++) {
      const a = st * (sl + 1) + s, b = a + sl + 1;
      indices[ii++] = a; indices[ii++] = b; indices[ii++] = a + 1;
      indices[ii++] = a + 1; indices[ii++] = b; indices[ii++] = b + 1;
    }
  }
  return { verts, indices };
}

