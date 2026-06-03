/* ── Sprint D.2 -- Voronoi fracture algorithm ────────────────────────
 * Splits a convex mesh into N convex fragments via 3D Voronoi
 * cells clipped against the original mesh boundary.
 *
 * Input: verts (11-float-per-vertex), indices, seedCount, seed.
 * Output: array of { verts, indices, centroid } per fragment.
 *
 * Algorithm:
 * 1. Extract positions from the 11-float vertex format.
 * 2. Generate N seed points inside the mesh AABB (seeded PRNG).
 * 3. For each seed, build its Voronoi cell as the intersection of
 *    half-planes defined by perpendicular bisectors to neighbors.
 * 4. Clip each cell against the mesh's AABB (simple box clip).
 * 5. Triangulate each cell face + generate the 11-float vertex
 *    format with normals and interior-face coloring.
 */
function _voronoiFracture(verts, indices, seedCount, rngSeed, interiorColor) {
  seedCount = Math.max(2, Math.min(32, seedCount || 8));
  const ic = interiorColor || [0.3, 0.25, 0.2];

  // Extract positions from 11-float vertex data
  const vertCount = verts.length / 11;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertCount; i++) {
    const x = verts[i*11], y = verts[i*11+1], z = verts[i*11+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const pad = 0.001;
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;
  const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;

  // Seeded PRNG (simple LCG)
  let _s = Math.abs(Math.round((rngSeed || 42) * 1000)) | 1;
  const rand = () => { _s = (_s * 1664525 + 1013904223) & 0x7fffffff; return _s / 0x7fffffff; };

  // Generate seed points inside AABB
  const seeds = [];
  for (let i = 0; i < seedCount; i++) {
    seeds.push([minX + rand() * sx, minY + rand() * sy, minZ + rand() * sz]);
  }

  // For each seed, compute the Voronoi cell clipped to the AABB.
  // The cell is the intersection of half-planes (perpendicular
  // bisectors between this seed and every other seed) with the AABB.
  // We represent the cell as a convex polyhedron via half-plane clipping.
  const fragments = [];

  for (let si = 0; si < seedCount; si++) {
    const s = seeds[si];
    // Start with AABB as a set of vertices
    let poly = [
      [minX, minY, minZ], [maxX, minY, minZ], [maxX, maxY, minZ], [minX, maxY, minZ],
      [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ]
    ];

    // Clip by each bisector plane (between this seed and every other)
    for (let sj = 0; sj < seedCount; sj++) {
      if (si === sj) continue;
      const o = seeds[sj];
      // Plane: normal = (o - s), point = midpoint of s and o
      const nx = o[0] - s[0], ny = o[1] - s[1], nz = o[2] - s[2];
      const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
      const pnx = nx/len, pny = ny/len, pnz = nz/len;
      const mx = (s[0]+o[0])*0.5, my = (s[1]+o[1])*0.5, mz = (s[2]+o[2])*0.5;
      const d = pnx*mx + pny*my + pnz*mz;
      // Keep the half where dot(v, n) < d (the side containing s)
      poly = _clipConvexByPlane(poly, pnx, pny, pnz, d);
      if (poly.length < 4) break;
    }
    if (poly.length < 4) continue;

    // Compute centroid of the clipped cell
    let cx = 0, cy = 0, cz = 0;
    for (const v of poly) { cx += v[0]; cy += v[1]; cz += v[2]; }
    cx /= poly.length; cy /= poly.length; cz /= poly.length;

    // Build the convex hull faces via gift-wrapping of the point set
    const cellMesh = _convexPolyToMesh(poly, ic);
    if (cellMesh) {
      cellMesh.centroid = [cx, cy, cz];
      fragments.push(cellMesh);
    }
  }
  return fragments;
}

// Clip a convex point cloud by a half-plane (keep points where dot(v,n) <= d).
// Returns the clipped point set (convex hull vertices of the clipped region).
function _clipConvexByPlane(pts, nx, ny, nz, d) {
  const inside = [];
  for (const p of pts) {
    if (p[0]*nx + p[1]*ny + p[2]*nz <= d + 0.0001) inside.push(p);
  }
  if (inside.length === pts.length) return pts;
  if (inside.length === 0) return [];
  // Also add intersection points of edges crossing the plane
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const da = a[0]*nx + a[1]*ny + a[2]*nz - d;
    const db = b[0]*nx + b[1]*ny + b[2]*nz - d;
    if ((da > 0) !== (db > 0)) {
      const t = da / (da - db);
      inside.push([a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1]), a[2] + t*(b[2]-a[2])]);
    }
  }
  return inside;
}

// Convert a convex point cloud to a renderable mesh (11-float verts + indices).
// Uses convex hull via simple face enumeration for small point sets.
function _convexPolyToMesh(pts, interiorColor) {
  if (pts.length < 4) return null;
  // Compute centroid
  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= pts.length; cy /= pts.length; cz /= pts.length;

  // Build convex hull faces using simple approach:
  // For each triple of points, check if all other points are on one side.
  const faces = [];
  const eps = 0.0001;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      for (let k = j + 1; k < pts.length; k++) {
        const a = pts[i], b = pts[j], c = pts[k];
        // Face normal
        const e1x = b[0]-a[0], e1y = b[1]-a[1], e1z = b[2]-a[2];
        const e2x = c[0]-a[0], e2y = c[1]-a[1], e2z = c[2]-a[2];
        let fnx = e1y*e2z - e1z*e2y, fny = e1z*e2x - e1x*e2z, fnz = e1x*e2y - e1y*e2x;
        const fl = Math.sqrt(fnx*fnx + fny*fny + fnz*fnz);
        if (fl < eps) continue;
        fnx /= fl; fny /= fl; fnz /= fl;
        const fd = fnx*a[0] + fny*a[1] + fnz*a[2];
        // Check all other points are on one side
        let allBelow = true, allAbove = true;
        for (let m = 0; m < pts.length; m++) {
          if (m === i || m === j || m === k) continue;
          const dot = fnx*pts[m][0] + fny*pts[m][1] + fnz*pts[m][2] - fd;
          if (dot > eps) allBelow = false;
          if (dot < -eps) allAbove = false;
        }
        if (!allBelow && !allAbove) continue;
        // Orient normal outward (away from centroid)
        const cd = fnx*cx + fny*cy + fnz*cz - fd;
        if (cd > 0) { fnx = -fnx; fny = -fny; fnz = -fnz; }
        faces.push({ verts: [i, j, k], nx: fnx, ny: fny, nz: fnz });
      }
    }
  }
  if (faces.length < 4) return null;

  // Build 11-float vertex buffer + index buffer
  const ic = interiorColor;
  const vertData = new Float32Array(faces.length * 3 * 11);
  const idxData = new Uint32Array(faces.length * 3);
  let vi = 0, ii = 0;
  for (const f of faces) {
    for (let fi = 0; fi < 3; fi++) {
      const p = pts[f.verts[fi]];
      vertData[vi++] = p[0]; vertData[vi++] = p[1]; vertData[vi++] = p[2];
      vertData[vi++] = ic[0]; vertData[vi++] = ic[1]; vertData[vi++] = ic[2];
      vertData[vi++] = f.nx; vertData[vi++] = f.ny; vertData[vi++] = f.nz;
      vertData[vi++] = 0; vertData[vi++] = 0;
    }
    const base = ii;
    idxData[ii++] = base; idxData[ii++] = base + 1; idxData[ii++] = base + 2;
  }
  return { verts: vertData, indices: idxData };
}

function _tickFractureMeshes() {
  if (!state || !Array.isArray(state.nodes)) return;
  for (const fn of state.nodes) {
    if (!fn || fn.type !== "FractureMesh") continue;
    if (fn._fractureComputed) continue;
    const fp = fn.params = fn.params || {};
    // Find the upstream mesh source via the "mesh" wire
    const wire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === fn.id && e.to.port === "mesh");
    if (!wire || !wire.from) continue;
    const srcNode = state.nodes.find(n => n && n.id === wire.from.node);
    if (!srcNode) continue;
    // Build the source mesh data
    const meshData = _buildMeshData(srcNode);
    if (!meshData || !meshData.verts || !meshData.indices) continue;
    // Run Voronoi fracture
    const count = Math.max(2, Math.min(32, Math.round(fp.fragments || 8)));
    const seed = fp.seed || 42;
    const ic = [fp.interiorR || 0.3, fp.interiorG || 0.25, fp.interiorB || 0.2];
    const frags = _voronoiFracture(meshData.verts, meshData.indices, count, seed, ic);
    fn._fragments = frags;
    fn._fractureComputed = true;
    fp.fractureReady = 1;
    console.log("[fracture] " + fn.id + ": " + frags.length + " fragments from " + count + " seeds");
  }
}

/* ── Sprint D.5 -- Visual fragment rendering ────────────────────────
 * When destroyed=0, passes through the solid mesh unchanged.
 * When destroyed=1, builds a combined mesh from all active fragment
 * bodies, each transformed by its Rapier body's world position. */
function _buildDestructibleMesh(node) {
  const dp = node.params || {};
  if (!dp.destroyed) {
    // Solid state: build source mesh translated to body position
    const meshWire = state.edges && state.edges.find(e =>
      e && e.to && e.to.node === node.id && e.to.port === "mesh");
    if (meshWire && meshWire.from) {
      const srcNode = state.nodes.find(n => n && n.id === meshWire.from.node);
      if (srcNode) {
        const md = _buildMeshData(srcNode);
        if (!md || !md.verts) return null;
        // Find the wired body to get its world position
        const bodyRef = _findWiredBodyNodePort3D(node, "body");
        if (bodyRef && bodyRef.params) {
          const _bp = bodyRef.params;
          const bx = _bp.x || _bp.initX || 0;
          const by = _bp.y || _bp.initY || 0;
          const bz = _bp.z || _bp.initZ || 0;
          if (bx !== 0 || by !== 0 || bz !== 0) {
            const vc = md.verts.length / 11;
            const tv = new Float32Array(md.verts.length);
            for (let i = 0; i < vc; i++) {
              const s = i * 11;
              tv[s] = md.verts[s] + bx;
              tv[s+1] = md.verts[s+1] + by;
              tv[s+2] = md.verts[s+2] + bz;
              for (let c = 3; c < 11; c++) tv[s+c] = md.verts[s+c];
            }
            return { verts: tv, indices: md.indices };
          }
        }
        return md;
      }
    }
    return null;
  }

  // Destroyed state: combine all fragment meshes with per-body transforms
  if (!node._fragmentBodies || !node._fragmentMeshes) return null;
  const bodies = node._fragmentBodies;
  const frags = node._fragmentMeshes;
  if (bodies.length === 0) return null;

  // Count total verts + indices
  let totalVerts = 0, totalIdx = 0;
  for (const fb of bodies) {
    if (!fb.frag) continue;
    totalVerts += fb.frag.verts.length / 11;
    totalIdx += fb.frag.indices.length;
  }
  if (totalVerts === 0) return null;

  const verts = new Float32Array(totalVerts * 11);
  const indices = new Uint32Array(totalIdx);
  let vi = 0, ii = 0, baseVert = 0;

  for (const fb of bodies) {
    if (!fb.frag) continue;
    const pos = fb.handle.translation();
    const fv = fb.frag.verts;
    const fi = fb.frag.indices;
    const vc = fv.length / 11;

    // Copy verts: subtract centroid (verts are in original local space,
    // body pos already includes centroid), then add body world pos
    const cx = fb.frag.centroid ? fb.frag.centroid[0] : 0;
    const cy = fb.frag.centroid ? fb.frag.centroid[1] : 0;
    const cz = fb.frag.centroid ? fb.frag.centroid[2] : 0;
    for (let v = 0; v < vc; v++) {
      const src = v * 11;
      verts[vi++] = (fv[src]   - cx) + pos.x;
      verts[vi++] = (fv[src+1] - cy) + pos.y;
      verts[vi++] = (fv[src+2] - cz) + pos.z;
      for (let c = 3; c < 11; c++) verts[vi++] = fv[src+c];
    }
    // Copy indices with base offset
    for (let i = 0; i < fi.length; i++) {
      indices[ii++] = fi[i] + baseVert;
    }
    baseVert += vc;
  }

  return { verts, indices };
}

/* ── Sprint D.4 -- DestructibleBody3D tick ──────────────────────────
 * Monitors a wired RigidBody3D for impact. When any nearby body
 * experiences a big Δv, removes the solid body from the world and
 * spawns fragment bodies from the FractureMesh's cache. */
function _tickDestructibles3D(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  if (!_rapier3dModule) return;
  const RAPIER = _rapier3dModule;

  // Validate that the convex hull point array describes a non-degenerate
  // 3D shape. Rapier panics with "unreachable" on hulls that are
  // collinear, near-coplanar, sub-millimetre, or have < 4 unique pts.
  const _validHull = (hp) => {
    if (!hp || hp.length < 12) return false;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const seen = new Set();
    for (let i = 0; i < hp.length; i += 3) {
      const x = hp[i], y = hp[i+1], z = hp[i+2];
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return false;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      seen.add(Math.round(x*1000) + "," + Math.round(y*1000) + "," + Math.round(z*1000));
    }
    if (seen.size < 4) return false;
    const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
    // Need span on ALL three axes (no flat hulls) and a minimum volume
    if (sx < 0.05 || sy < 0.05 || sz < 0.05) return false;
    if (sx * sy * sz < 0.0005) return false;
    return true;
  };

  // Global fragment-body cap across all destructibles. Past this,
  // refuse to spawn more (sub-fracture is skipped, fresh impacts log
  // a notice). Prevents Rapier from drowning.
  const MAX_TOTAL_FRAGMENTS = 80;
  let totalFrags = 0;
  for (const _dn of state.nodes) {
    if (_dn && _dn.type === "DestructibleBody3D" && _dn._fragmentBodies) {
      totalFrags += _dn._fragmentBodies.length;
    }
  }

  for (const dn of state.nodes) {
    if (!dn || dn.type !== "DestructibleBody3D") continue;
    if (!_isNodeActive(dn)) continue;
    const dp = dn.params = dn.params || {};
    const dr = _resolveNodeParams(dn);

    // Find the wired RigidBody3D via "body" input
    const bodyRef = _findWiredBodyNodePort3D(dn, "body");
    // Find the 3D world via "world" input
    let worldNode = null;
    for (const e of state.edges) {
      if (e && e.to && e.to.node === dn.id && e.to.port === "world" && e.from) {
        worldNode = state.nodes.find(n => n && n.id === e.from.node && n.type === "PhysicsWorld3D");
        if (worldNode) break;
      }
    }
    if (!worldNode || !worldNode._rapierWorld) continue;
    const world = worldNode._rapierWorld;
    const bodyMap3d = worldNode._bodyMap;

    // Reset: clean up fragments, restore solid
    const resetNow = typeof dr.reset === "number" ? dr.reset : 0;
    const resetEdge = resetNow >= 0.5 && (dp._prevReset || 0) < 0.5;
    dp._prevReset = resetNow;
    if (resetEdge && dn._fragmentBodies) {
      for (const fb of dn._fragmentBodies) {
        try { world.removeRigidBody(fb.handle); } catch (_) {}
      }
      dn._fragmentBodies = null;
      dp.destroyed = 0;
      dp.fragmentCount = 0;
    }

    // ── Solid state: monitor nearby impacts ──────────────────
    if (!dp.destroyed && bodyRef && bodyMap3d && bodyMap3d.has(bodyRef.id)) {
      const solidEntry = bodyMap3d.get(bodyRef.id);
      const solidPos = solidEntry.handle.translation();

      // Check all bodies for velocity changes near the solid body.
      // Use own _destructVelSnap (captured before _tickPhysics3D
      // overwrites _prevVel) for accurate Δv across the step.
      const threshold = typeof dr.damageThreshold === "number" ? dr.damageThreshold : 500;
      let maxForce = 0;
      if (!dn._velSnaps) dn._velSnaps = new Map();
      // Pull the brick's BoxCollider half-extents so the tunneling
      // fallback knows the AABB to test against.
      let halfX = 1, halfY = 1, halfZ = 1;
      for (const e of state.edges) {
        if (e && e.from && e.from.node === bodyRef.id && e.to) {
          const cn = state.nodes.find(n => n && n.id === e.to.node);
          if (cn && cn.type === "BoxCollider3D" && cn.params) {
            halfX = (typeof cn.params.halfX === "number") ? cn.params.halfX : halfX;
            halfY = (typeof cn.params.halfY === "number") ? cn.params.halfY : halfY;
            halfZ = (typeof cn.params.halfZ === "number") ? cn.params.halfZ : halfZ;
            break;
          }
        }
      }
      for (const [nid, entry] of bodyMap3d) {
        if (nid === bodyRef.id) continue;
        const bvel = entry.handle.linvel();
        const snap = dn._velSnaps.get(nid);
        const bpv = snap || { x: bvel.x, y: bvel.y, z: bvel.z };
        dn._velSnaps.set(nid, { x: bvel.x, y: bvel.y, z: bvel.z });
        const bdvx = bvel.x - bpv.x, bdvy = bvel.y - bpv.y, bdvz = bvel.z - bpv.z;
        const bdv = Math.sqrt(bdvx*bdvx + bdvy*bdvy + bdvz*bdvz);
        let bmass = 1; try { bmass = entry.handle.mass(); } catch (_) {}
        const bf = bdv * bmass / Math.max(0.001, dtSec);
        const bp2 = entry.handle.translation();
        const dx = bp2.x - solidPos.x, dy = bp2.y - solidPos.y, dz = bp2.z - solidPos.z;
        if (bf > maxForce && dx*dx + dy*dy + dz*dz < 16) {
          maxForce = bf;
          dn._impactPos = { x: bp2.x, y: bp2.y, z: bp2.z };
          dn._impactVel = { x: bvel.x, y: bvel.y, z: bvel.z };
        }
        // Tunneling fallback: any fast body inside (or barely outside)
        // the brick's AABB counts as a direct hit, even if Rapier's
        // contact step missed the collision.
        const speed = Math.sqrt(bvel.x*bvel.x + bvel.y*bvel.y + bvel.z*bvel.z);
        if (speed > 5) {
          const ax = Math.abs(dx) - halfX, ay = Math.abs(dy) - halfY, az = Math.abs(dz) - halfZ;
          if (ax < 0.5 && ay < 0.5 && az < 0.5) {
            const tunnelF = bmass * speed * 60;  // synthetic |Δp/Δt|
            if (tunnelF > maxForce) {
              maxForce = tunnelF;
              dn._impactPos = { x: bp2.x, y: bp2.y, z: bp2.z };
              dn._impactVel = { x: bvel.x, y: bvel.y, z: bvel.z };
            }
          }
        }
      }

      if (maxForce > threshold && totalFrags < MAX_TOTAL_FRAGMENTS) {
        // ── DESTROY ──────────────────────────────────────
        const solidVel = solidEntry.handle.linvel();
        // Remove the solid body from Rapier
        try { world.removeRigidBody(solidEntry.handle); } catch (_) {}
        bodyMap3d.delete(bodyRef.id);
        dp.destroyed = 1;

        // Find fragments from FractureMesh
        let fragments = null;
        const fracWire = state.edges && state.edges.find(e =>
          e && e.to && e.to.node === dn.id && e.to.port === "fracture");
        if (fracWire && fracWire.from) {
          const fracNode = state.nodes.find(n => n && n.id === fracWire.from.node);
          if (fracNode && fracNode._fragments) fragments = fracNode._fragments;
        }

        if (fragments && fragments.length > 0) {
          const radImp = typeof dr.radialImpulse === "number" ? dr.radialImpulse : 3;
          dn._fragmentBodies = [];
          dn._fragmentMeshes = fragments;
          dn._fragmentSpawnTime = performance.now() / 1000;

          for (const frag of fragments) {
            if (!frag.centroid) continue;
            const fx = solidPos.x + frag.centroid[0];
            const fy = solidPos.y + frag.centroid[1];
            const fz = solidPos.z + frag.centroid[2];
            const fbDesc = new RAPIER.RigidBodyDesc(RAPIER.RigidBodyType.Dynamic)
              .setTranslation(fx, fy, fz).setLinearDamping(0.3).setAngularDamping(0.5);
            const fbHandle = world.createRigidBody(fbDesc);
            fbHandle.setLinvel({ x: solidVel.x, y: solidVel.y, z: solidVel.z }, true);
            // Convex hull collider
            const fv = frag.verts, fvc = fv.length / 11;
            const hp = new Float32Array(fvc * 3);
            for (let i = 0; i < fvc; i++) {
              hp[i*3] = fv[i*11] - frag.centroid[0];
              hp[i*3+1] = fv[i*11+1] - frag.centroid[1];
              hp[i*3+2] = fv[i*11+2] - frag.centroid[2];
            }
            try {
              let fcd = _validHull(hp) ? RAPIER.ColliderDesc.convexHull(hp) : null;
              if (!fcd) fcd = RAPIER.ColliderDesc.ball(0.15);
              fcd.setDensity(0.5).setFriction(0.5).setRestitution(0.15);
              world.createCollider(fcd, fbHandle);
            } catch (_) {
              world.createCollider(RAPIER.ColliderDesc.ball(0.15), fbHandle);
            }
            // Impact-directed scatter: fragments near the impact
            // point get more force, far fragments barely move
            const impP = dn._impactPos || solidPos;
            const impV = dn._impactVel || { x: 0, y: -5, z: 0 };
            const ifx = fx - impP.x, ify = fy - impP.y, ifz = fz - impP.z;
            const ifd = Math.sqrt(ifx*ifx + ify*ify + ifz*ifz) || 0.1;
            const falloff = Math.max(0.1, 1.0 / (1.0 + ifd * 2));
            const imp = radImp * falloff;
            fbHandle.applyImpulse({
              x: (ifx/ifd * imp) + impV.x * 0.3 * falloff,
              y: (ify/ifd * imp) + Math.abs(impV.y) * 0.2 * falloff + imp * 0.3,
              z: (ifz/ifd * imp) + impV.z * 0.3 * falloff
            }, true);
            dn._fragmentBodies.push({ handle: fbHandle, frag });
          }
          dp.fragmentCount = dn._fragmentBodies.length;
          console.log("[destruct] " + dn.id + " shattered: " + dp.fragmentCount + " fragments (force=" + Math.round(maxForce) + ")");
        }
      }
    }

    // ── Destroyed: fragment lifetime + hierarchical sub-fracture ──
    if (dp.destroyed && dn._fragmentBodies) {
      const lifetime = typeof dr.fragmentLifetime === "number" ? dr.fragmentLifetime : 5;
      const maxDepth = Math.max(1, Math.min(4, typeof dr.maxDepth === "number" ? dr.maxDepth : 2));
      const subCount = Math.max(2, Math.min(8, typeof dr.subFragments === "number" ? dr.subFragments : 4));
      const threshold = typeof dr.damageThreshold === "number" ? dr.damageThreshold : 500;
      const radImp = typeof dr.radialImpulse === "number" ? dr.radialImpulse : 3;

      // Check each fragment for sub-fracture (skip if we're at cap)
      const newFrags = [];
      const removeIdxs = new Set();
      const subFractureAllowed = totalFrags < MAX_TOTAL_FRAGMENTS;
      for (let fi = 0; fi < dn._fragmentBodies.length && subFractureAllowed; fi++) {
        const fb = dn._fragmentBodies[fi];
        const depth = fb.depth || 1;
        if (depth >= maxDepth) continue;
        const vel = fb.handle.linvel();
        const pv = fb._prevVel || { x: vel.x, y: vel.y, z: vel.z };
        fb._prevVel = { x: vel.x, y: vel.y, z: vel.z };
        const dvx = vel.x - pv.x, dvy = vel.y - pv.y, dvz = vel.z - pv.z;
        const dv = Math.sqrt(dvx*dvx + dvy*dvy + dvz*dvz);
        let mass = 0.5; try { mass = fb.handle.mass(); } catch (_) {}
        const force = dv * mass / Math.max(0.001, dtSec);
        if (force <= threshold * 0.5) continue;

        // Sub-fracture this fragment
        const fragPos = fb.handle.translation();
        const fragVel = fb.handle.linvel();
        try { world.removeRigidBody(fb.handle); } catch (_) {}
        removeIdxs.add(fi);

        // Generate sub-fragments from this fragment's verts
        const subFrags = _voronoiFracture(
          fb.frag.verts, fb.frag.indices, subCount,
          42 + fi + depth * 100,
          [0.35, 0.28, 0.22]
        );
        for (const sf of subFrags) {
          if (!sf.centroid) continue;
          const sx = fragPos.x + (sf.centroid[0] - (fb.frag.centroid ? fb.frag.centroid[0] : 0));
          const sy = fragPos.y + (sf.centroid[1] - (fb.frag.centroid ? fb.frag.centroid[1] : 0));
          const sz = fragPos.z + (sf.centroid[2] - (fb.frag.centroid ? fb.frag.centroid[2] : 0));
          const sbd = new RAPIER.RigidBodyDesc(RAPIER.RigidBodyType.Dynamic)
            .setTranslation(sx, sy, sz).setLinearDamping(0.4).setAngularDamping(0.6);
          const sbh = world.createRigidBody(sbd);
          sbh.setLinvel({ x: fragVel.x, y: fragVel.y, z: fragVel.z }, true);
          try {
            const svc = sf.verts.length / 11;
            const shp = new Float32Array(svc * 3);
            for (let i = 0; i < svc; i++) {
              shp[i*3] = sf.verts[i*11] - sf.centroid[0];
              shp[i*3+1] = sf.verts[i*11+1] - sf.centroid[1];
              shp[i*3+2] = sf.verts[i*11+2] - sf.centroid[2];
            }
            let scd = _validHull(shp) ? RAPIER.ColliderDesc.convexHull(shp) : null;
            if (!scd) scd = RAPIER.ColliderDesc.ball(0.05);
            scd.setDensity(0.3).setFriction(0.4).setRestitution(0.1);
            world.createCollider(scd, sbh);
          } catch (_) {
            world.createCollider(RAPIER.ColliderDesc.ball(0.05), sbh);
          }
          const imp = radImp * 0.5;
          const dx = sf.centroid[0], dy = sf.centroid[1], dz = sf.centroid[2];
          const dl = Math.sqrt(dx*dx + dy*dy + dz*dz) || 0.1;
          sbh.applyImpulse({ x: dx/dl*imp, y: dy/dl*imp + imp*0.3, z: dz/dl*imp }, true);
          newFrags.push({ handle: sbh, frag: sf, depth: depth + 1 });
        }
        if (!dn._subFractureLogged) {
          console.log("[destruct] sub-fracture depth " + (depth+1) + ": " + subFrags.length + " sub-pieces");
          dn._subFractureLogged = true;
        }
      }
      // Remove fractured fragments, add new ones
      if (removeIdxs.size > 0) {
        dn._fragmentBodies = dn._fragmentBodies.filter((_, i) => !removeIdxs.has(i));
        dn._fragmentBodies.push(...newFrags);
        dp.fragmentCount = dn._fragmentBodies.length;
      }

      // Lifetime cleanup
      const elapsed = performance.now() / 1000 - (dn._fragmentSpawnTime || 0);
      if (elapsed > lifetime) {
        for (const fb of dn._fragmentBodies) {
          try { world.removeRigidBody(fb.handle); } catch (_) {}
        }
        dn._fragmentBodies = [];
        dp.fragmentCount = 0;
      }
    }
  }
}

/* Phase 8.B.11 -- resolve a Rope3D endpoint. If `port` (attachA /
 * attachB) is wired to a RigidBody3D, track that body's live position
 * (params.x/y/z, written by the physics readback; falls back to
 * initX/Y/Z for static bodies whose readback stays 0). Otherwise use
 * the (fx,fy,fz) world-point fallback. */
function _ropeEndpoint(node, port, fx, fy, fz) {
  const ref = (typeof _findWiredBodyNodePort3D === "function") ? _findWiredBodyNodePort3D(node, port) : null;
  if (ref && ref.params) {
    const bp = ref.params;
    // Static/kinematic bodies don't get position readback (their
    // params.x/y/z stay 0), so use initX/Y/Z. Dynamic bodies are
    // read back every physics tick (which runs before _tickRopes),
    // so their params.x/y/z are current — use them directly even
    // when they're legitimately 0 (e.g. a pendulum at bottom dead
    // centre). Falls back to init then the world-point param.
    const isStatic = (bp.type === "static" || bp.type === "fixed" || bp.type === "kinematic");
    if (isStatic) {
      return {
        x: (typeof bp.initX === "number") ? bp.initX : fx,
        y: (typeof bp.initY === "number") ? bp.initY : fy,
        z: (typeof bp.initZ === "number") ? bp.initZ : fz
      };
    }
    return {
      x: (typeof bp.x === "number") ? bp.x : ((typeof bp.initX === "number") ? bp.initX : fx),
      y: (typeof bp.y === "number") ? bp.y : ((typeof bp.initY === "number") ? bp.initY : fy),
      z: (typeof bp.z === "number") ? bp.z : ((typeof bp.initZ === "number") ? bp.initZ : fz)
    };
  }
  return { x: fx, y: fy, z: fz };
}

/* Phase 8.B.11 -- Position-Based-Dynamics rope solver. One Verlet
 * integration + Jakobsen distance-constraint pass per Rope3D per
 * frame. Endpoints are pinned (inverse mass 0) to their resolved
 * positions; interior particles fall under gravity + wind and the
 * distance constraints keep the segment lengths near `restLen`. */
function _tickRopes(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  if (!(dtSec > 0) || dtSec > 0.05) dtSec = 1 / 60;
  for (const rn of state.nodes) {
    if (!rn || rn.type !== "Rope3D") continue;
    if (!_isNodeActive(rn)) continue;
    const rp = rn.params = rn.params || {};
    const r = _resolveNodeParams(rn);
    const segs = Math.max(2, Math.min(64, Math.round(typeof r.segments === "number" ? r.segments : 16)));
    const N = segs + 1;
    const stiffness = Math.max(0, Math.min(1, typeof r.stiffness === "number" ? r.stiffness : 1));
    const grav = typeof r.gravity === "number" ? r.gravity : -9.8;
    const wx = r.windX || 0, wy = r.windY || 0, wz = r.windZ || 0;

    const A = _ropeEndpoint(rn, "attachA", r.ax || 0, r.ay || 0, r.az || 0);
    const B = _ropeEndpoint(rn, "attachB", r.bx || 0, r.by || 0, r.bz || 0);

    // (Re)initialize the particle chain when missing or resized.
    if (!rn._particles || rn._particles.length !== N) {
      rn._particles = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t, z = A.z + (B.z - A.z) * t;
        rn._particles.push({ x, y, z, px: x, py: y, pz: z });
      }
      const d0 = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
      rn._restLen = Math.max(0.02, d0 / segs);
    }
    const P = rn._particles;
    const rest = rn._restLen;
    const invMass = (i) => (i === 0 || i === N - 1) ? 0 : 1;

    // Verlet integration (interior particles accelerate; endpoints are
    // overwritten by the pin below so their integration is harmless).
    const dt2 = dtSec * dtSec;
    const damp = 0.99;
    for (let i = 0; i < N; i++) {
      const p = P[i];
      const vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp, vz = (p.z - p.pz) * damp;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.x += vx + wx * dt2;
      p.y += vy + (grav + wy) * dt2;
      p.z += vz + wz * dt2;
    }
    // Pin endpoints to the resolved attach positions.
    P[0].x = A.x; P[0].y = A.y; P[0].z = A.z;
    P[N - 1].x = B.x; P[N - 1].y = B.y; P[N - 1].z = B.z;

    // Jakobsen distance constraints (a few iterations for stiffness).
    const ITER = 12;
    for (let k = 0; k < ITER; k++) {
      for (let i = 0; i < N - 1; i++) {
        const a = P[i], b = P[i + 1];
        const wa = invMass(i), wb = invMass(i + 1);
        const wsum = wa + wb;
        if (wsum === 0) continue;
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const corr = ((d - rest) / d) * stiffness;
        const ka = (wa / wsum) * corr, kb = (wb / wsum) * corr;
        a.x += dx * ka; a.y += dy * ka; a.z += dz * ka;
        b.x -= dx * kb; b.y -= dy * kb; b.z -= dz * kb;
      }
    }

    // Outputs + mesh-rebuild version bump.
    const tip = P[N - 1];
    rp.tipX = tip.x; rp.tipY = tip.y; rp.tipZ = tip.z;
    rn._ropeVer = (rn._ropeVer || 0) + 1;
  }
}

/* Phase 8.B.12 -- Position-Based-Dynamics cloth solver. A grid of
 * (resX+1)×(resY+1) particles, Verlet integrated with gravity + wind
 * + turbulence, held together by structural / shear / bend distance
 * constraints (Jakobsen, a few iterations). One edge is pinned by
 * `pinEdge`. Particles + grid dims are stashed on the node for
 * _buildClothMesh to triangulate. */
function _tickCloths(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  if (!(dtSec > 0) || dtSec > 0.05) dtSec = 1 / 60;
  for (const cn of state.nodes) {
    if (!cn || cn.type !== "Cloth3D") continue;
    if (!_isNodeActive(cn)) continue;
    const cp = cn.params = cn.params || {};
    const r = _resolveNodeParams(cn);
    const nx = Math.max(2, Math.min(40, Math.round(typeof r.resX === "number" ? r.resX : 16)));
    const ny = Math.max(2, Math.min(40, Math.round(typeof r.resY === "number" ? r.resY : 10)));
    const W = typeof r.width === "number" ? r.width : 6;
    const H = typeof r.height === "number" ? r.height : 4;
    const ox = r.originX || 0, oy = (typeof r.originY === "number" ? r.originY : 6), oz = r.originZ || 0;
    const stiff = Math.max(0.05, Math.min(1, typeof r.stiffness === "number" ? r.stiffness : 0.9));
    const grav = typeof r.gravity === "number" ? r.gravity : -9.8;
    const turb = typeof r.turbulence === "number" ? r.turbulence : 0.6;
    const wx = r.windX || 0, wy = r.windY || 0, wz = r.windZ || 0;
    const pinEdge = (typeof cp.pinEdge === "string") ? cp.pinEdge : "left";

    const cols = nx + 1, rows = ny + 1;
    const idx = (i, j) => j * cols + i;

    // (Re)initialize the particle grid + per-particle pinned flag when
    // the resolution or origin changes (origin change = a moved cloth).
    const sig = nx + "x" + ny + ":" + ox + "," + oy + "," + oz + ":" + W + "," + H + ":" + pinEdge;
    if (!cn._cloth || cn._clothSig !== sig) {
      const P = new Array(cols * rows);
      const pinned = new Array(cols * rows).fill(false);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = ox + (i / nx) * W;
          const y = oy - (j / ny) * H;
          const z = oz;
          P[idx(i, j)] = { x, y, z, px: x, py: y, pz: z, hx: x, hy: y, hz: z };
        }
      }
      const pin = (i, j) => { pinned[idx(i, j)] = true; };
      if (pinEdge === "left")        for (let j = 0; j < rows; j++) pin(0, j);
      else if (pinEdge === "right")  for (let j = 0; j < rows; j++) pin(cols - 1, j);
      else if (pinEdge === "top")    for (let i = 0; i < cols; i++) pin(i, 0);
      else if (pinEdge === "bottom") for (let i = 0; i < cols; i++) pin(i, rows - 1);
      else if (pinEdge === "top-corners") { pin(0, 0); pin(cols - 1, 0); }
      cn._cloth = P;
      cn._clothPinned = pinned;
      cn._clothDims = { nx, ny, cols, rows };
      cn._clothRest = { x: W / nx, y: H / ny };
      cn._clothSig = sig;   // <- without this the guard re-inits (flat) every frame
    }
    const P = cn._cloth, pinned = cn._clothPinned;
    const restX = cn._clothRest.x, restY = cn._clothRest.y;
    const restD = Math.hypot(restX, restY);     // shear (diagonal) rest

    // Verlet integration.
    const dt2 = dtSec * dtSec;
    const damp = 0.98;
    const t = performance.now() / 1000;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = P[idx(i, j)];
        if (pinned[idx(i, j)]) { p.x = p.hx; p.y = p.hy; p.z = p.hz; p.px = p.x; p.py = p.y; p.pz = p.z; continue; }
        // Per-particle turbulence (cheap value-noise) — gives flutter
        // even with a steady base wind.
        const tu = turb * Math.sin(t * 2.1 + i * 0.6 + j * 0.4);
        const tv = turb * Math.cos(t * 1.7 + j * 0.5);
        const ax = wx + tu;
        const ay = grav + wy;
        const az = wz + tv;
        const vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp, vz = (p.z - p.pz) * damp;
        p.px = p.x; p.py = p.y; p.pz = p.z;
        p.x += vx + ax * dt2;
        p.y += vy + ay * dt2;
        p.z += vz + az * dt2;
      }
    }

    // Distance constraints. Structural (right/down), shear (diag),
    // bend (2 apart). Jakobsen with pinned = infinite mass.
    const solve = (ai, aj, bi, bj, rest, k) => {
      const a = P[idx(ai, aj)], b = P[idx(bi, bj)];
      const pa = pinned[idx(ai, aj)], pb = pinned[idx(bi, bj)];
      if (pa && pb) return;
      let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-6;
      const corr = ((d - rest) / d) * k;
      const wa = pa ? 0 : 1, wb = pb ? 0 : 1, ws = wa + wb;
      const ka = (wa / ws) * corr, kb = (wb / ws) * corr;
      a.x += dx * ka; a.y += dy * ka; a.z += dz * ka;
      b.x -= dx * kb; b.y -= dy * kb; b.z -= dz * kb;
    };
    const ITER = 8;
    const kStruct = stiff, kShear = stiff * 0.8, kBend = stiff * 0.4;
    for (let it = 0; it < ITER; it++) {
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          if (i + 1 < cols) solve(i, j, i + 1, j, restX, kStruct);
          if (j + 1 < rows) solve(i, j, i, j + 1, restY, kStruct);
          if (i + 1 < cols && j + 1 < rows) solve(i, j, i + 1, j + 1, restD, kShear);
          if (i + 1 < cols && j - 1 >= 0)   solve(i, j, i + 1, j - 1, restD, kShear);
          if (i + 2 < cols) solve(i, j, i + 2, j, restX * 2, kBend);
          if (j + 2 < rows) solve(i, j, i, j + 2, restY * 2, kBend);
        }
      }
    }

    cp.vertexCount = cols * rows;
    cn._clothVer = (cn._clothVer || 0) + 1;
  }
}

/* Phase 8.B.13 -- Position-Based-Dynamics soft-body (jelly) solver.
 * A res³ particle lattice, Verlet integrated under gravity, bounced
 * off the ground plane, held together by distance constraints:
 * structural (axis-aligned neighbours) at full stiffness + diagonal
 * (face/cube diagonals) scaled by volumePreserve. Particles + the
 * precomputed constraint list live on the node; _buildSoftBodyMesh
 * renders the deforming shell. */
function _tickSoftBodies(dtSec) {
  if (!state || !Array.isArray(state.nodes)) return;
  if (!(dtSec > 0) || dtSec > 0.05) dtSec = 1 / 60;
  for (const sn of state.nodes) {
    if (!sn || sn.type !== "SoftBody3D") continue;
    if (!_isNodeActive(sn)) continue;
    const sp = sn.params = sn.params || {};
    const r = _resolveNodeParams(sn);
    const R = Math.max(2, Math.min(8, Math.round(typeof r.res === "number" ? r.res : 4)));
    const size = Math.max(0.2, typeof r.size === "number" ? r.size : 2.5);
    const ox = r.originX || 0, oy = (typeof r.originY === "number" ? r.originY : 6), oz = r.originZ || 0;
    const stiff = Math.max(0.05, Math.min(1, typeof r.stiffness === "number" ? r.stiffness : 0.85));
    const vol = Math.max(0, Math.min(1, typeof r.volumePreserve === "number" ? r.volumePreserve : 0.8));
    const bounce = Math.max(0, Math.min(0.95, typeof r.bounce === "number" ? r.bounce : 0.4));
    const grav = typeof r.gravity === "number" ? r.gravity : -9.8;
    const groundY = typeof r.groundY === "number" ? r.groundY : 0;

    const idx = (i, j, k) => (k * R + j) * R + i;
    const sig = R + ":" + size + ":" + ox + "," + oy + "," + oz;

    // Reset on rising edge, or (re)init when the lattice signature
    // changes (size / res / origin edited).
    const resetNow = typeof r.reset === "number" ? r.reset : 0;
    const resetEdge = resetNow >= 0.5 && (sp._sbPrevReset || 0) < 0.5;
    sp._sbPrevReset = resetNow;

    if (!sn._sb || sn._sbSig !== sig || resetEdge) {
      const P = new Array(R * R * R);
      const step = size / (R - 1);
      const base = { x: ox - size / 2, y: oy - size / 2, z: oz - size / 2 };
      for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
        const x = base.x + i * step, y = base.y + j * step, z = base.z + k * step;
        P[idx(i, j, k)] = { x, y, z, px: x, py: y, pz: z };
      }
      // Precompute the constraint list once: each particle to neighbours
      // within ±1 on each axis (no duplicates: only b-index > a-index).
      const cons = [];
      for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
        const a = idx(i, j, k);
        for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0 && dk === 0) continue;
          const ni = i + di, nj = j + dj, nk = k + dk;
          if (ni < 0 || nj < 0 || nk < 0 || ni >= R || nj >= R || nk >= R) continue;
          const b = idx(ni, nj, nk);
          if (b <= a) continue;
          const order = Math.abs(di) + Math.abs(dj) + Math.abs(dk);   // 1=axis, 2=face-diag, 3=cube-diag
          const A = P[a], B = P[b];
          const rest = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
          cons.push({ a, b, rest, diag: order > 1 });
        }
      }
      sn._sb = P;
      sn._sbCons = cons;
      sn._sbR = R;
      sn._sbSig = sig;
    }
    const P = sn._sb, cons = sn._sbCons;

    // Verlet integration + ground bounce. Low damping = it keeps
    // jiggling after impact (the soft/jelly read).
    const dt2 = dtSec * dtSec;
    const damp = 0.999;
    for (let n = 0; n < P.length; n++) {
      const p = P[n];
      let vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp, vz = (p.z - p.pz) * damp;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.x += vx; p.y += vy + grav * dt2; p.z += vz;
      if (p.y < groundY) {
        p.y = groundY;
        // Reflect vertical velocity (bounce) + apply ground friction.
        p.py = p.y + vy * bounce;
        p.px = p.x - vx * 0.7;
        p.pz = p.z - vz * 0.7;
      }
    }

    // Distance constraints. Structural at full stiffness, diagonals
    // scaled by volumePreserve (shape/volume retention knob). Fewer
    // iterations = softer/wobblier (more jelly).
    const ITER = 5;
    const kDiag = stiff * vol;
    for (let it = 0; it < ITER; it++) {
      for (let c = 0; c < cons.length; c++) {
        const cc = cons[c];
        const a = P[cc.a], b = P[cc.b];
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-6;
        const k = cc.diag ? kDiag : stiff;
        const corr = ((d - cc.rest) / d) * k * 0.5;
        const cx = dx * corr, cy = dy * corr, cz = dz * corr;
        a.x += cx; a.y += cy; a.z += cz;
        b.x -= cx; b.y -= cy; b.z -= cz;
      }
      // Re-clamp to the ground after each constraint pass so the body
      // doesn't sink (constraints can pull particles below the floor).
      for (let n = 0; n < P.length; n++) { if (P[n].y < groundY) P[n].y = groundY; }
    }

    // Centroid output.
    let cx = 0, cy = 0, cz = 0;
    for (let n = 0; n < P.length; n++) { cx += P[n].x; cy += P[n].y; cz += P[n].z; }
    const inv = 1 / P.length;
    sp.centerX = cx * inv; sp.centerY = cy * inv; sp.centerZ = cz * inv;
    sn._sbVer = (sn._sbVer || 0) + 1;
  }
}