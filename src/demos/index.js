const _demos = [
  /* Phase 8.B.15 / §8.F -- GLB Asset Test. Verifies the asset pipeline
   * end-to-end: LoadGLB streams a SpectraStudios city building + two
   * m3-org props from the compile-server asset host and renders them.
   * Free-fly camera (WASD + mouse in live mode) so the GLBs' scale /
   * orientation doesn't matter for inspection. Requires the
   * compile-server running (it auto-fetches the seed assets). */
  {
    id: "glb-asset-test",
    name: "GLB Asset Test",
    sub: "LoadGLB · compile-server assets · 4 base-mesh props",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(18,22,32,0.95)"/>
      <circle cx="22" cy="26" r="6" fill="rgba(200,70,70,0.9)"/>
      <ellipse cx="42" cy="28" rx="4" ry="6" fill="rgba(150,110,60,0.9)"/>
      <g stroke="rgba(180,180,190,0.9)" stroke-width="2" fill="none"><line x1="58" y1="32" x2="64" y2="18"/></g>
      <polygon points="60,16 70,14 68,22 60,22" fill="rgba(170,170,180,0.9)"/>
      <path d="M 80 30 L 92 30 L 90 22 L 86 22 L 86 18 L 82 18 L 82 22 Z" fill="rgba(100,105,120,0.95)"/>
      <rect x="6" y="34" width="88" height="3" fill="rgba(90,90,90,0.6)"/>
    </svg>`,
    build: () => {
      // Ground reference plane
      const groundBox = makeNode("Box", 440, 160, { width: 24, height: 1, depth: 16 });
      const groundMat = makeNode("PhysicalMat", 620, 160, { r: 0.28, g: 0.3, b: 0.32, metallic: 0, roughness: 0.95 });
      const groundT = makeNode("Translate", 800, 160, { x: 0, y: -0.5, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundMat, port: "mesh" } });
      state.edges.push({ from: { node: groundMat, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Four m3-org base-mesh props in a row. autoFit:2.5 normalizes
      // each to ~2.5 units tall regardless of source scale + rests it
      // on the ground, so they line up cleanly. A tint per prop.
      const props = [
        { url: "server:apple",  x: -6, tint: { r: 0.85, g: 0.25, b: 0.25 } },
        { url: "server:acorn",  x: -2, tint: { r: 0.6,  g: 0.45, b: 0.25 } },
        { url: "server:axe",    x:  2, tint: { r: 0.7,  g: 0.7,  b: 0.75 } },
        { url: "server:anvil",  x:  6, tint: { r: 0.4,  g: 0.42, b: 0.48 } }
      ];
      const meshSlots = [];
      const readyNodes = [];
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        const row = 300 + i * 110;
        const glb = makeNode("LoadGLB", 40, row, { url: p.url, scale: 1, autoFit: 2.5 });
        const mat = makeNode("PhysicalMat", 280, row, { r: p.tint.r, g: p.tint.g, b: p.tint.b, metallic: 0.1, roughness: 0.6 });
        const t = makeNode("Translate", 520, row, { x: p.x, y: 0, z: 0 });
        state.edges.push({ from: { node: glb, port: "mesh" }, to: { node: mat, port: "mesh" } });
        state.edges.push({ from: { node: mat, port: "mesh" }, to: { node: t, port: "mesh" } });
        meshSlots.push(t);
        readyNodes.push(glb);
      }

      // Slow orbit camera so all four props are framed (no flying
      // needed). LFO drives the camera X to drift around the row.
      const cam = makeNode("FPCamera", 1100, 60, {
        posX: 0, posY: 4, posZ: 12, yaw: 180, pitch: -14,
        fov: 60, near: 0.05, far: 500, walkMode: 0, walkSpeed: 10
      });
      const light = makeNode("DirectionalLight", 1100, 160, { dirX: -0.4, dirY: -1, dirZ: -0.5, intensity: 1.4 });
      const scene = makeNode("Scene3D", 1300, 60, { clearR: 0.5, clearG: 0.62, clearB: 0.78 });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      for (let i = 0; i < meshSlots.length && i + 2 <= 8; i++) {
        state.edges.push({ from: { node: meshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 2) } });
      }
      const vo = makeNode("VisualOutput", 1500, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // Sum the 4 ready flags → a "loaded N/4" HUD.
      let readySrc = { node: readyNodes[0], port: "ready" };
      for (let i = 1; i < readyNodes.length; i++) {
        const add = makeNode("Add", -260, 300 + i * 70, {});
        state.edges.push({ from: readySrc, to: { node: add, port: "a" } });
        state.edges.push({ from: { node: readyNodes[i], port: "ready" }, to: { node: add, port: "b" } });
        readySrc = { node: add, port: "out" };
      }
      const hud = makeNode("HUDText", 1300, 220, {
        prefix: "props loaded ", suffix: " / 4", value: 0, decimals: 0,
        corner: "top-left", fontSize: 15, color: "#9bd0ff", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: readySrc, to: { node: hud, port: "value" } });
      state.edges.push({ from: { node: hud, port: "hud" }, to: { node: scene, port: "hud1" } });
      const hudHelp = makeNode("HUDText", 1300, 300, {
        text: "LoadGLB streams 4 m3-org base meshes (apple · acorn · axe · anvil) from the compile-server, each auto-fit to 2.5u. Needs the server running. Boxes are placeholders until each parses. Live mode: WASD + mouse to look closer.",
        value: NaN, corner: "bottom-left", fontSize: 11, color: "#fff", opacity: 0.72, margin: 18
      });
      state.edges.push({ from: { node: hudHelp, port: "hud" }, to: { node: scene, port: "hud2" } });
    }
  },

  /* Phase 8.§A.4 -- PBR Texture Test. Verifies per-material texture
   * maps end-to-end: a brick wall + brick sphere driven by a Poly
   * Haven brick set (albedo JPG + normal/roughness EXR) streamed from
   * the compile-server, lit by an HDRI environment (A.5) plus a key
   * light so the normal-map relief reads. A plain grey ground + a
   * chrome ball (no maps) confirm untextured meshes still render
   * unchanged and that the HDRI reflects. Needs the server running
   * with the brick_wall_006 set + flower_hillside HDRI imported. */
  {
    id: "pbr-texture-test",
    name: "PBR Texture Test",
    sub: "material maps · albedo+normal+rough · HDRI",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,16,14,0.96)"/>
      <g fill="rgba(150,80,55,0.92)" stroke="rgba(40,26,20,0.9)" stroke-width="0.8">
        <rect x="8"  y="10" width="16" height="6"/><rect x="26" y="10" width="16" height="6"/>
        <rect x="0"  y="18" width="14" height="6"/><rect x="16" y="18" width="16" height="6"/><rect x="34" y="18" width="12" height="6"/>
        <rect x="8"  y="26" width="16" height="6"/><rect x="26" y="26" width="16" height="6"/>
      </g>
      <circle cx="66" cy="24" r="9" fill="rgba(150,80,55,0.92)"/>
      <circle cx="86" cy="24" r="8" fill="rgba(220,225,235,0.95)"/>
      <circle cx="83" cy="21" r="2.5" fill="rgba(255,255,255,0.9)"/>
      <rect x="0" y="36" width="100" height="8" fill="rgba(70,72,78,0.85)"/>
    </svg>`,
    build: () => {
      const BRICK = {
        albedoMap: "server:brick_wall_006_diff_2k",
        normalMap: "server:brick_wall_006_nor_gl_2k",
        roughMap:  "server:brick_wall_006_rough_2k"
      };

      // Plain grey ground -- NO maps, so it proves untextured meshes
      // are byte-identical after the A.4 shader change (white/identity
      // defaults = no-op).
      const ground   = makeNode("Box",         40,  60, { width: 30, height: 1, depth: 30 });
      const groundMat = makeNode("PhysicalMat", 280, 60, { r: 0.3, g: 0.31, b: 0.33, metallic: 0, roughness: 0.95 });
      const groundT  = makeNode("Translate",   520, 60, { x: 0, y: -0.5, z: 0 });
      state.edges.push({ from: { node: ground,    port: "mesh" }, to: { node: groundMat, port: "mesh" } });
      state.edges.push({ from: { node: groundMat, port: "mesh" }, to: { node: groundT,   port: "mesh" } });

      // Brick wall -- a wide thin box; each face gets a full copy of
      // the brick set. Albedo tint left white so the texture shows true.
      const wall    = makeNode("Box",         40, 200, { width: 8, height: 5, depth: 0.4 });
      const wallMat = makeNode("PhysicalMat", 280, 200, { r: 1, g: 1, b: 1, metallic: 0, roughness: 1, ...BRICK });
      const wallT   = makeNode("Translate",   520, 200, { x: 0, y: 2.5, z: -3 });
      state.edges.push({ from: { node: wall,    port: "mesh" }, to: { node: wallMat, port: "mesh" } });
      state.edges.push({ from: { node: wallMat, port: "mesh" }, to: { node: wallT,   port: "mesh" } });

      // Brick sphere -- shows the maps wrapping curved UVs + normal
      // relief catching the key light.
      const bSphere = makeNode("Sphere",      40, 360, { radius: 1.6, stacks: 48, slices: 64 });
      const bMat    = makeNode("PhysicalMat", 280, 360, { r: 1, g: 1, b: 1, metallic: 0, roughness: 1, ...BRICK });
      const bT      = makeNode("Translate",   520, 360, { x: 4.2, y: 1.6, z: 0 });
      state.edges.push({ from: { node: bSphere, port: "mesh" }, to: { node: bMat, port: "mesh" } });
      state.edges.push({ from: { node: bMat,    port: "mesh" }, to: { node: bT,   port: "mesh" } });

      // Chrome ball -- no maps; mirrors the HDRI so A.5 env is visible.
      const cSphere = makeNode("Sphere",      40, 520, { radius: 1.3, stacks: 48, slices: 64 });
      const cMat    = makeNode("PhysicalMat", 280, 520, { r: 0.95, g: 0.96, b: 0.98, metallic: 1, roughness: 0.05 });
      const cT      = makeNode("Translate",   520, 520, { x: -4.2, y: 1.3, z: 0 });
      state.edges.push({ from: { node: cSphere, port: "mesh" }, to: { node: cMat, port: "mesh" } });
      state.edges.push({ from: { node: cMat,    port: "mesh" }, to: { node: cT,   port: "mesh" } });

      // HDRI environment (A.5) + a key light for crisp normal relief.
      const hdri  = makeNode("HDRI", 40, 700, { url: "server:flower_hillside_1k", intensity: 1.0 });
      const light = makeNode("DirectionalLight", 40, 820, { dirX: -0.5, dirY: -0.85, dirZ: -0.35, intensity: 1.5 });

      // Slow orbit camera so relief + reflections move.
      const clk    = makeNode("MasterClock", 40, 940, { bpm: 2 });
      const mulTau = makeNode("Mul",        260, 940, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        460, 920);
      const cosC   = makeNode("Cos",        460, 1020);
      const mulCx  = makeNode("Mul",        640, 920, { b: 9 });
      const mulCz  = makeNode("Mul",        640, 1020, { b: 9 });
      const cam    = makeNode("Camera",     860, 940, {
        posX: 0, posY: 3, posZ: 9, targetX: 0, targetY: 1.5, targetZ: 0,
        fov: 52, near: 0.05, far: 500, mode: 0
      });
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"   }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"   }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"   }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulCz,  port: "out"   }, to: { node: cam,    port: "posZ" } });

      const scene = makeNode("Scene3D", 1100, 200, { clearR: 0.5, clearG: 0.6, clearB: 0.72 });
      const vo    = makeNode("VisualOutput", 1340, 200, { display: 0 });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: wallT,   port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: bT,      port: "mesh" }, to: { node: scene, port: "mesh3" } });
      state.edges.push({ from: { node: cT,      port: "mesh" }, to: { node: scene, port: "mesh4" } });
      state.edges.push({ from: { node: hdri,    port: "env"    }, to: { node: scene, port: "environment" } });
      state.edges.push({ from: { node: light,   port: "light"  }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: cam,     port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: scene,   port: "out"    }, to: { node: vo,    port: "in" } });

      const help = makeNode("HUDText", 1100, 360, {
        text: "PBR maps streamed from the compile-server: brick wall + sphere use albedo (JPG) + normal + roughness (EXR). Grey ground & chrome ball have no maps. Needs the server running with the brick_wall_006 set + flower_hillside HDRI imported.",
        value: NaN, corner: "bottom-left", fontSize: 11, color: "#fff", opacity: 0.74, margin: 18
      });
      state.edges.push({ from: { node: help, port: "hud" }, to: { node: scene, port: "hud1" } });
    }
  },

  /* Phase 8.§B sprint 6 -- Blob's Adventure: First Hops. The capstone
   * skeleton's first playable level + the proof that the foundation
   * nodes (BlobController3D + ThirdPersonCamera) drive a capsule end to
   * end. Blob is a dynamic capsule RigidBody3D; KeyAxis2D feeds the
   * controller (camera-relative WASD + Space jump); a ThirdPersonCamera
   * trails it and feeds its yaw back so movement stays camera-relative.
   * Static box platforms lead up to a green goal pad. Grass ground +
   * daytime HDRI stream from the compile-server; the jump emits a synth
   * blip. Title / win / stage-machine + prefabs land in the next push. */
  {
    id: "blob-first-hops",
    name: "Blob's Adventure",
    sub: "First Hops · BlobController3D + ThirdPersonCamera",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <defs><linearGradient id="ba-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8fc7f2"/><stop offset="1" stop-color="#cfe9ff"/></linearGradient></defs>
      <rect width="100" height="44" fill="url(#ba-sky)"/>
      <rect x="0" y="34" width="100" height="10" fill="rgba(95,150,70,0.95)"/>
      <rect x="20" y="28" width="14" height="5" fill="rgba(120,120,128,0.95)"/>
      <rect x="44" y="22" width="14" height="5" fill="rgba(120,120,128,0.95)"/>
      <rect x="68" y="16" width="16" height="5" fill="rgba(90,200,120,0.95)"/>
      <ellipse cx="12" cy="29" rx="5" ry="6.5" fill="rgba(110,220,130,0.97)"/>
      <circle cx="12" cy="26" r="1.2" fill="#1a3a22"/><circle cx="15" cy="26" r="1.2" fill="#1a3a22"/>
    </svg>`,
    build: () => {
      // Deliberately minimal: flat-colored materials, a single sun, a
      // clear-color sky. NO HDRI / streamed textures / SFX yet — get the
      // blob moving + the camera trailing cleanly first, then layer art
      // and audio back on once the core feels right.
      const world = makeNode("PhysicsWorld3D", -260, 40, { gravityX: 0, gravityY: -18, gravityZ: 0, subSteps: 8 });
      const scene = makeNode("Scene3D", 1180, 220, { clearR: 0.6, clearG: 0.74, clearB: 0.92 });
      const vo    = makeNode("VisualOutput", 1420, 220, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // helper: a static collidable flat-colored box, wired to a scene slot
      const staticBox = (row, x, y, z, w, h, d, col, slotPort) => {
        const rb  = makeNode("RigidBody3D", -260, row, { type: "static", initX: x, initY: y, initZ: z });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: rb, port: "world" } });
        const cc  = makeNode("BoxCollider3D", -80, row, { halfX: w / 2, halfY: h / 2, halfZ: d / 2, friction: 0.9 });
        state.edges.push({ from: { node: rb, port: "bodyId" }, to: { node: cc, port: "body" } });
        const mesh = makeNode("Box", 100, row, { width: w, height: h, depth: d });
        const m    = makeNode("PhysicalMat", 280, row, { r: col[0], g: col[1], b: col[2], metallic: 0, roughness: 0.8, vertexMix: 0 });
        const t    = makeNode("Translate", 460, row, { x, y, z });
        state.edges.push({ from: { node: mesh, port: "mesh" }, to: { node: m, port: "mesh" } });
        state.edges.push({ from: { node: m, port: "mesh" }, to: { node: t, port: "mesh" } });
        state.edges.push({ from: { node: t, port: "mesh" }, to: { node: scene, port: slotPort } });
        return t;
      };

      // Ground + a short path of platforms up to a goal pad (flat colors)
      staticBox(140,  0,    0,   0,   40, 1,   40, [0.36, 0.58, 0.34], "mesh1");
      staticBox(240,  4,    1.2, -2,  3,  0.5, 3,  [0.62, 0.62, 0.66], "mesh2");
      staticBox(340,  8,    2.4, -5,  3,  0.5, 3,  [0.62, 0.62, 0.66], "mesh3");
      staticBox(440,  5,    3.6, -9,  3,  0.5, 3,  [0.62, 0.62, 0.66], "mesh4");
      staticBox(540,  0,    4.6, -12, 4.5,0.5, 4.5,[0.62, 0.62, 0.66], "mesh5");
      staticBox(640,  0,    4.95,-12, 1.8,0.3, 1.8,[0.25, 0.95, 0.4],  "mesh6");

      // ── Blob: dynamic capsule, body-driven Translate
      const blob = makeNode("RigidBody3D", -260, 760, { type: "dynamic", initX: 0, initY: 2.2, initZ: 0, linearDamping: 0.1, ccd: 1 });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: blob, port: "world" } });
      const blobC = makeNode("CapsuleCollider3D", -80, 760, { radius: 0.45, halfHeight: 0.45, friction: 0.4, restitution: 0, density: 1 });
      state.edges.push({ from: { node: blob, port: "bodyId" }, to: { node: blobC, port: "body" } });
      const blobMesh = makeNode("Capsule", 100, 760, { radius: 0.45, halfHeight: 0.45, slices: 20 });
      const blobMat  = makeNode("PhysicalMat", 280, 760, { r: 0.4, g: 0.82, b: 0.5, metallic: 0, roughness: 0.5, vertexMix: 0 });
      const blobT    = makeNode("Translate", 460, 760);
      state.edges.push({ from: { node: blobMesh, port: "mesh" }, to: { node: blobMat, port: "mesh" } });
      state.edges.push({ from: { node: blobMat, port: "mesh" }, to: { node: blobT, port: "mesh" } });
      state.edges.push({ from: { node: blob, port: "x" }, to: { node: blobT, port: "x" } });
      state.edges.push({ from: { node: blob, port: "y" }, to: { node: blobT, port: "y" } });
      state.edges.push({ from: { node: blob, port: "z" }, to: { node: blobT, port: "z" } });
      state.edges.push({ from: { node: blobT, port: "mesh" }, to: { node: scene, port: "mesh7" } });

      // ── Input → controller, camera-relative
      const keys = makeNode("KeyAxis2D", -260, 900);
      const ctrl = makeNode("BlobController3D", -40, 900, { moveSpeed: 6, jumpSpeed: 10, airControl: 0.5 });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ctrl, port: "world" } });
      state.edges.push({ from: { node: blob, port: "bodyId" }, to: { node: ctrl, port: "body" } });
      state.edges.push({ from: { node: keys, port: "x" },    to: { node: ctrl, port: "inputX" } });
      state.edges.push({ from: { node: keys, port: "y" },    to: { node: ctrl, port: "inputZ" } });
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: ctrl, port: "jump" } });

      // ── Third-person follow camera (feeds yaw back for camera-relative move)
      const cam = makeNode("ThirdPersonCamera", 700, 60, { mode: 1, distance: 5, height: 2, orbitYaw: 0, orbitPitch: -8, shoulder: 0.9, fov: 62, smooth: 0.16 });
      state.edges.push({ from: { node: blob, port: "x" }, to: { node: cam, port: "targetX" } });
      state.edges.push({ from: { node: blob, port: "y" }, to: { node: cam, port: "targetY" } });
      state.edges.push({ from: { node: blob, port: "z" }, to: { node: cam, port: "targetZ" } });
      state.edges.push({ from: { node: cam, port: "yaw" },    to: { node: ctrl, port: "camYaw" } });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });

      // ── A single sun (hemisphere ambient is built into the PBR shader)
      const sun = makeNode("DirectionalLight", 700, 200, { dirX: -0.4, dirY: -0.85, dirZ: -0.3, intensity: 1.5 });
      state.edges.push({ from: { node: sun, port: "light" }, to: { node: scene, port: "light1" } });

      const help = makeNode("HUDText", 1180, 380, {
        text: "BLOB — First Hops · Live mode + WASD to move, Space to jump. Reach the green pad.",
        value: NaN, corner: "top-left", fontSize: 13, color: "#eafff0", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: help, port: "hud" }, to: { node: scene, port: "hud1" } });
    }
  },

  {
    id: "audio-basic",
    name: "Audio Basic",
    sub: "keyboard · biquad LP",
    type: "audio",
    thumb: `<svg viewBox="0 0 100 44">
      <g fill="var(--phosphor)" opacity="0.85">
        <rect x="6"  y="12" width="8" height="20"/>
        <rect x="16" y="12" width="8" height="20"/>
        <rect x="26" y="12" width="8" height="20"/>
        <rect x="36" y="12" width="8" height="20"/>
        <rect x="46" y="12" width="8" height="20"/>
        <rect x="56" y="12" width="8" height="20"/>
        <rect x="66" y="12" width="8" height="20"/>
        <rect x="76" y="12" width="8" height="20"/>
      </g>
      <g fill="var(--instr-bg)" opacity="0.95">
        <rect x="12" y="12" width="4" height="13"/>
        <rect x="22" y="12" width="4" height="13"/>
        <rect x="42" y="12" width="4" height="13"/>
        <rect x="52" y="12" width="4" height="13"/>
        <rect x="62" y="12" width="4" height="13"/>
      </g>
    </svg>`,
    build: () => {
      const k  = makeNode("KeyboardIn", 40,  60);
      const a  = makeNode("Sine",      220,  60, { freq: 220 });
      const b  = makeNode("AD",        220, 230, { attack: 0.01, decay: 0.6 });
      const sc = makeNode("Slider",     40, 380, { value: 1200, min: 80, max: 12000 });
      const sq = makeNode("Slider",    220, 380, { value: 1.4,  min: 0.5, max: 10 });
      const c  = makeNode("Mul",       400, 130);
      const d  = makeNode("BiquadLP",  580, 110, { cutoff: 1200, q: 1.4 });
      const e  = makeNode("Output",    760, 130);
      state.edges.push({ from: { node: k,  port: "freq" }, to: { node: a, port: "freq" } });
      state.edges.push({ from: { node: k,  port: "gate" }, to: { node: b, port: "trig" } });
      state.edges.push({ from: { node: a,  port: "out"  }, to: { node: c, port: "a"    } });
      state.edges.push({ from: { node: b,  port: "out"  }, to: { node: c, port: "b"    } });
      state.edges.push({ from: { node: c,  port: "out"  }, to: { node: d, port: "in"   } });
      state.edges.push({ from: { node: sc, port: "out"  }, to: { node: d, port: "cutoff" } });
      state.edges.push({ from: { node: sq, port: "out"  }, to: { node: d, port: "q"    } });
      state.edges.push({ from: { node: d,  port: "out"  }, to: { node: e, port: "in"   } });
    }
  },
  {
    id: "plasma-clock",
    name: "Plasma + Clock",
    sub: "tempo-driven swirl",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-plasma" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0"   stop-color="rgba(200,232,90,0.6)"/>
          <stop offset="0.5" stop-color="rgba(131,232,255,0.5)"/>
          <stop offset="1"   stop-color="rgba(232,90,160,0.6)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-plasma)" opacity="0.7"/>
      <path d="M 0 22 Q 25 4 50 22 T 100 22" stroke="rgba(255,255,255,0.6)" stroke-width="1" fill="none"/>
      <path d="M 0 30 Q 25 12 50 30 T 100 30" stroke="rgba(255,255,255,0.4)" stroke-width="0.8" fill="none"/>
    </svg>`,
    build: () => {
      const m = makeNode("MasterClock",  40,  60, { bpm: 120 });
      const p = makeNode("Plasma",      280,  60, { speed: 1, scale: 1, audioReact: 0, bassReact: 0, clockReact: 0 });
      const v = makeNode("VisualOutput",520,  60, { display: 0 });
      state.edges.push({ from: { node: m, port: "beat" }, to: { node: p, port: "clockReact" } });
      state.edges.push({ from: { node: p, port: "out"  }, to: { node: v, port: "in" } });
    }
  },
  {
    id: "starnest",
    name: "Star Nest",
    sub: "volumetric fractal stars",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.7)"/>
      <g fill="var(--phosphor)">
        <circle cx="10" cy="8"  r="0.8"/>
        <circle cx="25" cy="20" r="1.2"/>
        <circle cx="42" cy="12" r="0.6"/>
        <circle cx="55" cy="30" r="1.0"/>
        <circle cx="68" cy="18" r="0.9"/>
        <circle cx="78" cy="34" r="0.7"/>
        <circle cx="90" cy="14" r="1.3"/>
        <circle cx="15" cy="36" r="0.5"/>
        <circle cx="30" cy="5"  r="0.6"/>
        <circle cx="48" cy="38" r="0.4"/>
        <circle cx="72" cy="7"  r="0.5"/>
        <circle cx="60" cy="6"  r="0.8"/>
      </g>
      <g fill="rgba(131,232,255,0.7)">
        <circle cx="35" cy="26" r="0.5"/>
        <circle cx="62" cy="22" r="0.4"/>
        <circle cx="85" cy="28" r="0.3"/>
      </g>
    </svg>`,
    build: () => {
      const s = makeNode("StarNest",     40,  60);
      const v = makeNode("VisualOutput",320,  60, { display: 0 });
      state.edges.push({ from: { node: s, port: "out" }, to: { node: v, port: "in" } });
    }
  },
  {
    id: "butterflies-on-stars",
    name: "Butterflies on Stars",
    sub: "alpha-over composition",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.85)"/>
      <g fill="var(--phosphor)" opacity="0.6">
        <circle cx="10" cy="10" r="0.7"/>
        <circle cx="84" cy="9"  r="0.6"/>
        <circle cx="92" cy="34" r="0.5"/>
        <circle cx="20" cy="35" r="0.4"/>
      </g>
      <g fill="rgba(232,140,60,0.8)">
        <path d="M 50 22 Q 35 6 25 16 Q 35 24 50 22 Z"/>
        <path d="M 50 22 Q 65 6 75 16 Q 65 24 50 22 Z"/>
        <path d="M 50 22 Q 38 38 30 34 Q 40 28 50 22 Z"/>
        <path d="M 50 22 Q 62 38 70 34 Q 60 28 50 22 Z"/>
        <line x1="50" y1="14" x2="50" y2="32" stroke="rgba(0,0,0,0.7)" stroke-width="1"/>
      </g>
    </svg>`,
    build: () => {
      const s = makeNode("StarNest",      40,  60);
      const b = makeNode("Butterflies",   40, 240);
      const bl = makeNode("BlendShader", 280, 130, { mode: 5, mix: 1.0 });
      const v = makeNode("VisualOutput", 520, 130, { display: 0 });
      state.edges.push({ from: { node: b,  port: "out" }, to: { node: bl, port: "inA" } });
      state.edges.push({ from: { node: s,  port: "out" }, to: { node: bl, port: "inB" } });
      state.edges.push({ from: { node: bl, port: "out" }, to: { node: v,  port: "in"  } });
    }
  },
  {
    /* v0.3.27 — Color Grade demo. Showcases the sprint-2 Color suite:
     * Levels + HsvShift + ChannelMix arranged into a tempo-driven
     * sepia/amber chain over a clock-reactive Plasma.
     *
     * The hueShift is driven by MasterClock.beat * 120, so each beat
     * pulses the hue 120° away from neutral then decays back -- a
     * subtle but clearly clock-locked color wobble. Levels lifts the
     * blacks + adds gamma curl, ChannelMix applies the classic photo-
     * sepia matrix (Microsoft's reference values, widely-used) before
     * the visual hits the output. */
    id: "color-grade",
    name: "Color Grade",
    sub: "plasma · levels · hsv · sepia",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-cg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0"   stop-color="rgba(232,180,90,0.8)"/>
          <stop offset="0.5" stop-color="rgba(180,120,40,0.7)"/>
          <stop offset="1"   stop-color="rgba(80,40,0,0.85)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-cg)"/>
      <path d="M 0 24 Q 30 6 50 22 T 100 20" stroke="rgba(255,220,150,0.7)" stroke-width="1.2" fill="none"/>
      <path d="M 0 32 Q 30 12 50 30 T 100 28" stroke="rgba(255,200,120,0.5)" stroke-width="0.9" fill="none"/>
    </svg>`,
    build: () => {
      // v0.3.29 — soft S-curve preset for the ColorCurves master
      // channel at 64-point fidelity. 40% blend between the identity
      // ramp and a smoothstep -- gentle contrast push that nudges
      // shadows down + highlights up without crushing either end.
      // Identity-default on R/G/B leaves color cast to the ChannelMix
      // downstream.
      const identityCurveN = () => Array.from({ length: 64 }, (_, i) => i / 63);
      const sCurveN = () => {
        const a = new Array(64);
        for (let i = 0; i < 64; i++) {
          const x  = i / 63;
          const ss = x * x * (3 - 2 * x);   // smoothstep(0, 1, x)
          a[i] = x + 0.4 * (ss - x);        // 40% toward the smoothstep
        }
        return a;
      };

      const m   = makeNode("MasterClock",   40,  60, { bpm: 120 });
      const p   = makeNode("Plasma",       280,  60, { speed: 1.0, scale: 1.0, clockReact: 0.6 });
      const l   = makeNode("Levels",       540,  60, { inBlack: 0.15, inWhite: 0.95, gamma: 0.9, outBlack: 0.0, outWhite: 1.0 });
      const cc  = makeNode("ColorCurves",  800,  60, {
        curveMaster: sCurveN(),
        curveR: identityCurveN(),
        curveG: identityCurveN(),
        curveB: identityCurveN()
      });
      const mul = makeNode("Mul",          340, 320, { b: 120 });
      const h   = makeNode("HsvShift",    1060,  60, { hueShift: 0, sat: 1.2, val: 1.0 });
      const cm  = makeNode("ChannelMix",  1320,  60, {
        // Classic photo-sepia matrix (Microsoft reference values).
        rr: 0.393, rg: 0.769, rb: 0.189,
        gr: 0.349, gg: 0.686, gb: 0.168,
        br: 0.272, bg: 0.534, bb: 0.131
      });
      const v   = makeNode("VisualOutput", 1580,  60, { display: 0 });

      // Visual chain: Plasma → Levels → ColorCurves(S-curve) →
      // HsvShift → ChannelMix → Output.
      state.edges.push({ from: { node: p,   port: "out"  }, to: { node: l,   port: "in" } });
      state.edges.push({ from: { node: l,   port: "out"  }, to: { node: cc,  port: "in" } });
      state.edges.push({ from: { node: cc,  port: "out"  }, to: { node: h,   port: "in" } });
      state.edges.push({ from: { node: h,   port: "out"  }, to: { node: cm,  port: "in" } });
      state.edges.push({ from: { node: cm,  port: "out"  }, to: { node: v,   port: "in" } });

      // Clock reactivity: MasterClock.beat drives Plasma's built-in
      // reactivity AND a hue pulse via Mul. Mul.b = 120 so the cubic-
      // decay beat envelope (0..1) scales to a 0..120° hue swing each
      // beat -- gives a rhythmic color flash without overpowering the
      // sepia base.
      state.edges.push({ from: { node: m,   port: "beat" }, to: { node: p,   port: "clockReact" } });
      state.edges.push({ from: { node: m,   port: "beat" }, to: { node: mul, port: "a" } });
      state.edges.push({ from: { node: mul, port: "out"  }, to: { node: h,   port: "hueShift" } });
    }
  },
  {
    /* v0.3.35 — Matrix CRT demo, rebuilt from a hand-tuned user patch
     * (matrix___defocus.gpatch). Bigger MatrixRain (512x64 grid with
     * 8 streams per column), Pixelate downsample to chunky 8-px cells
     * BEFORE the CRT pass (so the CRT scanlines and mask sit over
     * proper retro-pixel-art chunks), CRT-processed result blended
     * 50/50 with the un-CRT'd pixelated rain (visible character
     * structure stays sharp + the CRT layer adds the phosphor halo
     * and warp on top), Defocus tail (radius=0 default so it's a
     * chain-able no-op the user can dial up for a "lens out of
     * focus" look without breaking the chain).
     *
     * Chain:
     *   MatrixRain -> Pixelate -> CRT ---+
     *                      \             +--> BlendShader --> Defocus --> Output
     *                       `------------'  (mix=0.5, mode=normal)
     *
     * The Pixelate output is wired to BOTH the CRT's input AND the
     * BlendShader's inB, so blendshader interpolates the CRT'd output
     * (inA) with the raw-pixelated source (inB) at mix=0.5. This
     * cuts the CRT's signature ~50% darkening that the shadow mask
     * causes while keeping all the CRT character (phosphor halo,
     * scanlines, curvature). */
    id: "matrix-crt",
    name: "Matrix CRT",
    sub: "blended rain · pixelate · CRT · defocus",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,8,0,0.95)"/>
      <!-- green characters in columns -->
      <g fill="rgba(110, 255, 130, 0.9)" font-family="monospace" font-size="6" font-weight="bold">
        <text x="6"  y="10">7</text>
        <text x="6"  y="18">A</text>
        <text x="6"  y="26">3</text>
        <text x="20" y="14">M</text>
        <text x="20" y="22">9</text>
        <text x="20" y="30">X</text>
        <text x="20" y="38">2</text>
        <text x="34" y="18">K</text>
        <text x="34" y="26">5</text>
        <text x="48" y="10">Q</text>
        <text x="48" y="18">1</text>
        <text x="48" y="26">F</text>
        <text x="62" y="14">8</text>
        <text x="62" y="22">N</text>
        <text x="62" y="30">7</text>
        <text x="76" y="10">D</text>
        <text x="76" y="18">4</text>
        <text x="90" y="18">Z</text>
        <text x="90" y="26">6</text>
        <text x="90" y="34">P</text>
      </g>
      <!-- brighter head characters -->
      <g fill="rgba(240, 255, 220, 1.0)" font-family="monospace" font-size="6" font-weight="bold">
        <text x="20" y="38">2</text>
        <text x="48" y="26">F</text>
        <text x="76" y="18">4</text>
      </g>
      <!-- scanline overlay (horizontal stripes) -->
      <g stroke="rgba(0, 0, 0, 0.45)" stroke-width="1">
        <line x1="0" y1="3"  x2="100" y2="3"  />
        <line x1="0" y1="9"  x2="100" y2="9"  />
        <line x1="0" y1="15" x2="100" y2="15" />
        <line x1="0" y1="21" x2="100" y2="21" />
        <line x1="0" y1="27" x2="100" y2="27" />
        <line x1="0" y1="33" x2="100" y2="33" />
        <line x1="0" y1="39" x2="100" y2="39" />
      </g>
      <!-- subtle barrel bulge edges (vignette corners) -->
      <radialGradient id="dg-crt-vig" cx="0.5" cy="0.5" r="0.75">
        <stop offset="0.65" stop-color="rgba(0,0,0,0)"/>
        <stop offset="1"    stop-color="rgba(0,0,0,0.5)"/>
      </radialGradient>
      <rect width="100" height="44" fill="url(#dg-crt-vig)"/>
    </svg>`,
    build: () => {
      // Node positions match the source patch (matrix___defocus.gpatch).
      const mr = makeNode("MatrixRain",   40,   83, {
        // Dense grid -- 512 columns of 64 rows, 8 streams per column.
        // streamsPerCol clamps to 8 in the shader so this is the max.
        cellsX: 512, cellsY: 64,
        streamsPerCol: 8, trailLen: 16,
        speed: 1.0, brightness: 1.0, headBoost: 4.0,
        colorR: 0.0, colorG: 1.0, colorB: 0.2
      });
      const px  = makeNode("Pixelate",   100,  324, { cellSize: 8 });
      const crt = makeNode("CRT",        310,  265, {
        virtualW: 320, virtualH: 240,
        curvature: 0.05,
        scanlineHardness: -8.0,
        pixelHardness:    -3.0,
        maskType: 3,
        maskStrength: 0.85,
        brightness: 1.15,
        bloomAmount: 0.18,
        shape: 2.0,
        halationAmount: 0.04,
        halationRadius: 10,
        beamDynamics: 0.5,
        temperature: 0
      });
      const bl  = makeNode("BlendShader", 355,  62, { mix: 0.5, mode: 0 });
      const fc  = makeNode("Defocus",     529, 167, { radius: 0, bokeh: 0.2 });
      const v   = makeNode("VisualOutput", 717, 84, { display: 0 });

      // Visual chain (matches the source patch's edges verbatim).
      state.edges.push({ from: { node: mr,  port: "out" }, to: { node: px,  port: "in"  } });
      state.edges.push({ from: { node: px,  port: "out" }, to: { node: crt, port: "in"  } });
      // BlendShader inputs: CRT'd version on inA, raw pixelate on inB.
      // mix=0.5 + mode=0 (normal/lerp) means 50/50 blend.
      state.edges.push({ from: { node: crt, port: "out" }, to: { node: bl,  port: "inA" } });
      state.edges.push({ from: { node: px,  port: "out" }, to: { node: bl,  port: "inB" } });
      state.edges.push({ from: { node: bl,  port: "out" }, to: { node: fc,  port: "in"  } });
      state.edges.push({ from: { node: fc,  port: "out" }, to: { node: v,   port: "in"  } });
    }
  },
  {
    /* v0.3.39 -- Tunnel CRT demo. Showcases three v0.3.3x features
     * at once: the ShapeTunnel (v0.3.38 ray-marched SDF pseudo-3D
     * flying shapes), the BlobTracker (v0.3.37 classical-CV blob
     * detection), and the CRT shader stack (v0.3.31-34 high-fidelity
     * emulation).
     *
     * Chain (texture):
     *   ShapeTunnel -> BlobTracker.video -> CRT -> VisualOutput
     *
     * The BlobTracker WATCHES THE SHAPES flying past in the tunnel
     * (via the `video` texture input -- same default-cam-vs-upstream
     * pattern as HandLandmarker / PoseLandmarker etc). Its overlay
     * draws tracking boxes + centroids around each detected SDF
     * shape; the CRT then puts the whole scene under vintage glass.
     *
     * The boxes follow the shapes from far-distance through near-
     * plane with stable IDs (greedy nearest-neighbor matching
     * across frames). Each blob keeps the same color + ID number
     * for as long as it's visible -- you watch a shape gain and
     * keep e.g. "#3 25%" across its flight, then lose its label
     * when it exits near-plane.
     *
     * BlobTracker params tuned for SDF shape detection:
     *  - mode=0 (luma), threshold=0.35: SDF shapes shaded with
     *    Lambert+rim peak around 0.5-0.9 luma; a 0.35 threshold
     *    catches the well-lit foreground shapes.
     *  - minBlobSize=80: filters out very distant shapes (small
     *    in pixel count).
     *  - mirrored=0: ShapeTunnel output isn't a selfie cam.
     *
     * (Param-level feedback from BlobTracker.b1_x back into
     * ShapeTunnel.camOffsetX would be the cool next step, but the
     * visual-side _resolveNodeParams currently doesn't recursively
     * evaluate math template nodes (Sub / Mul / etc), so a Sub +
     * Mul chain between them would be inert. Logged as a future
     * ticket; for this demo the focus is the visual chain.) */
    id: "tunnel-crt",
    name: "Tunnel CRT",
    sub: "SDF tunnel · blob tracking · CRT",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-tcrt" cx="0.5" cy="0.5" r="0.9">
          <stop offset="0"   stop-color="rgba(60, 180, 255, 0.85)"/>
          <stop offset="0.5" stop-color="rgba(120, 90, 220, 0.85)"/>
          <stop offset="1"   stop-color="rgba(8, 4, 20, 1.0)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-tcrt)"/>
      <!-- distant tunnel point -->
      <circle cx="50" cy="22" r="3" fill="rgba(180, 220, 255, 0.9)"/>
      <!-- mid-distance shapes with tracking boxes -->
      <g>
        <polygon points="30,18 35,22 30,26 25,22" fill="rgba(255, 180, 90, 0.85)"/>
        <rect x="24" y="16" width="12" height="12" fill="none" stroke="rgba(120, 220, 255, 0.95)" stroke-width="0.8"/>
        <text x="26" y="15" fill="rgba(120, 220, 255, 1)" font-family="monospace" font-size="3" font-weight="bold">#1</text>
      </g>
      <g>
        <polygon points="70,18 75,22 70,26 65,22" fill="rgba(220, 90, 200, 0.85)"/>
        <rect x="64" y="16" width="12" height="12" fill="none" stroke="rgba(255, 180, 90, 0.95)" stroke-width="0.8"/>
        <text x="66" y="15" fill="rgba(255, 180, 90, 1)" font-family="monospace" font-size="3" font-weight="bold">#2</text>
      </g>
      <!-- near shapes (no box, too close) -->
      <circle cx="18" cy="32" r="5" fill="rgba(120, 230, 180, 0.9)"/>
      <rect x="76" y="6" width="8" height="8" fill="rgba(255, 200, 80, 0.9)" transform="rotate(20 80 10)"/>
      <!-- scanline overlay -->
      <g stroke="rgba(0, 0, 0, 0.35)" stroke-width="1">
        <line x1="0" y1="6"  x2="100" y2="6"  />
        <line x1="0" y1="14" x2="100" y2="14" />
        <line x1="0" y1="22" x2="100" y2="22" />
        <line x1="0" y1="30" x2="100" y2="30" />
        <line x1="0" y1="38" x2="100" y2="38" />
      </g>
    </svg>`,
    build: () => {
      const st  = makeNode("ShapeTunnel",   40,  80, {
        speed: 0.8, density: 8, tunnelRadius: 4.0,
        fogDensity: 0.13,
        camOffsetX: 0.0, camOffsetY: 0.0,
        baseHue: 215.0, shapeMix: 1.0,
        seedOffset: 0.42, fov: 65.0
      });
      // BlobTracker takes ShapeTunnel.out as its video input. The
      // upstream wire means it falls into the texture-source path
      // (same convention as HandLandmarker etc) -- the own-camera
      // path is bypassed, no webcam permission prompt for this demo.
      //
      // mode=3 ('value' / max-channel) is the right choice for
      // ShapeTunnel's saturated colored shapes. Rec.709 luma
      // (mode=0) would weight red and blue too low (0.21 and 0.07
      // respectively) -- a fully-bright red shape would peak at
      // luma=0.21, below threshold 0.35, and miss detection
      // entirely. Max-channel treats all hues equally so every
      // bright shape gets caught.
      const bt  = makeNode("BlobTracker",  340,  80, {
        mode: 3, threshold: 0.45,
        minBlobSize: 40, maxBlobs: 4,
        smoothing: 0.55,
        mirrored: 0,
        bgMode: 1,
        lineWidth: 3.0, dotRadius: 6
      });
      const crt = makeNode("CRT",          660,  80, {
        virtualW: 480, virtualH: 360,
        curvature: 0.04,
        scanlineHardness: -8.0, pixelHardness: -3.0,
        maskType: 3, maskStrength: 0.75,
        brightness: 1.1, bloomAmount: 0.14, shape: 2.0,
        halationAmount: 0.05, halationRadius: 12,
        beamDynamics: 0.45, temperature: -0.15,
        convergence: 0.4, persistence: 0.25
      });
      const v   = makeNode("VisualOutput", 940,  80, { display: 0 });

      // Visual chain: ShapeTunnel -> BlobTracker.video -> CRT -> Output.
      state.edges.push({ from: { node: st,  port: "out" }, to: { node: bt,  port: "video" } });
      state.edges.push({ from: { node: bt,  port: "out" }, to: { node: crt, port: "in"    } });
      state.edges.push({ from: { node: crt, port: "out" }, to: { node: v,   port: "in"    } });
    }
  },

  /* v0.3.44 -- Keyer Pipeline demo. Showcases the sprint-5 (Mask +
   * Matte + Keyer) -> sprint-6 (Composite extensions) chain end-to-
   * end with synthetic sources -- no webcam permission, no external
   * footage. Plasma plays the part of a "live green-screen source":
   * its cycling palette passes through yellow-green regions which
   * the ChromaKeyer hooks onto. MatteControl chokes the resulting
   * matte inward to remove the green spill, then AlphaCompose runs
   * a Porter-Duff over against a high-frequency NoiseShader plate.
   * Swap Plasma for Webcam / VideoFile and retune ChromaKeyer to
   * apply this to actual green-screen footage. */
  {
    id: "keyer-pipeline",
    name: "Keyer Pipeline",
    sub: "chroma key -> matte -> compose",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-kp-noise" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0"   stop-color="rgba(40,50,80,0.95)"/>
          <stop offset="0.5" stop-color="rgba(70,90,140,0.95)"/>
          <stop offset="1"   stop-color="rgba(30,40,70,0.95)"/>
        </linearGradient>
        <radialGradient id="dg-kp-fg" cx="0.45" cy="0.5" r="0.45">
          <stop offset="0"   stop-color="rgba(230,90,170,0.95)"/>
          <stop offset="0.7" stop-color="rgba(255,210,90,0.85)"/>
          <stop offset="1"   stop-color="rgba(255,210,90,0)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-kp-noise)"/>
      <g opacity="0.55" fill="rgba(255,255,255,0.5)">
        <circle cx="14" cy="10" r="0.6"/><circle cx="32" cy="6"  r="0.5"/>
        <circle cx="60" cy="9"  r="0.5"/><circle cx="86" cy="12" r="0.6"/>
        <circle cx="20" cy="38" r="0.5"/><circle cx="72" cy="36" r="0.5"/>
      </g>
      <path d="M 28 8 Q 55 -2 75 14 Q 85 30 60 38 Q 30 42 22 26 Q 18 14 28 8 Z"
            fill="url(#dg-kp-fg)"/>
      <path d="M 38 16 Q 50 12 58 20 Q 60 28 50 30 Q 40 30 38 22 Q 36 18 38 16 Z"
            fill="none" stroke="rgba(180,255,200,0.7)" stroke-width="0.6"
            stroke-dasharray="2 2"/>
    </svg>`,
    build: () => {
      const fg = makeNode("Plasma", 40, 60, {
        speed: 0.6, scale: 1.2, paletteOffset: 0.0,
        audioReact: 0.0, bassReact: 0.0, clockReact: 0.0
      });
      const key = makeNode("ChromaKeyer", 260, 60, {
        targetR: 0.0, targetG: 1.0, targetB: 0.4,
        tolerance: 0.22, softness: 0.08, spillSuppress: 0.5
      });
      const matte = makeNode("MatteControl", 480, 60, {
        choke: 0.25, spread: 0.05, gamma: 1.2,
        premultiply: 0, radius: 1.5
      });
      const bg = makeNode("NoiseShader", 40, 280, {
        scale: 14, octaves: 5, seedX: 0.31, seedY: 0.77
      });
      const comp = makeNode("AlphaCompose", 720, 170, {
        fgPremultiplied: 0, outPremultiplied: 0, opacity: 1.0
      });
      const vo = makeNode("VisualOutput", 940, 170, { display: 0 });
      state.edges.push({ from: { node: fg,    port: "out" }, to: { node: key,   port: "in"         } });
      state.edges.push({ from: { node: key,   port: "out" }, to: { node: matte, port: "in"         } });
      state.edges.push({ from: { node: matte, port: "out" }, to: { node: comp,  port: "foreground" } });
      state.edges.push({ from: { node: bg,    port: "out" }, to: { node: comp,  port: "background" } });
      state.edges.push({ from: { node: comp,  port: "out" }, to: { node: vo,    port: "in"         } });
    }
  },

  /* v0.3.44 -- Mask Set Ops demo. Two SDF mask generators
   * (RectangleMask + EllipseMask) combined via MatteCombine's
   * subtractAB operation produce a rounded rectangle with an
   * elliptical hole punched through the middle. The resulting mask
   * gates a Plasma color source via MaskShader. Trivial swap to
   * union / intersect / exclusiveOr / average to see the other
   * set operations. */
  {
    id: "mask-set-ops",
    name: "Mask Set Ops",
    sub: "rect minus ellipse over plasma",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-mso" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0"   stop-color="rgba(200,232,90,0.85)"/>
          <stop offset="0.5" stop-color="rgba(131,232,255,0.7)"/>
          <stop offset="1"   stop-color="rgba(232,90,160,0.85)"/>
        </linearGradient>
        <mask id="dg-mso-mask">
          <rect width="100" height="44" fill="black"/>
          <rect x="20" y="9" width="60" height="26" rx="4" fill="white"/>
          <ellipse cx="50" cy="22" rx="11" ry="8" fill="black"/>
        </mask>
      </defs>
      <rect width="100" height="44" fill="rgba(8,8,14,1)"/>
      <rect width="100" height="44" fill="url(#dg-mso)" mask="url(#dg-mso-mask)"/>
      <rect x="20" y="9"  width="60" height="26" rx="4"
            fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.5"/>
      <ellipse cx="50" cy="22" rx="11" ry="8"
               fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.5"/>
    </svg>`,
    build: () => {
      const rect = makeNode("RectangleMask", 40, 60, {
        centerX: 0.5, centerY: 0.5,
        halfW: 0.35, halfH: 0.25,
        rounding: 0.06, feather: 0.01, invert: 0
      });
      const ell = makeNode("EllipseMask", 40, 240, {
        centerX: 0.5, centerY: 0.5,
        radiusX: 0.18, radiusY: 0.18,
        feather: 0.01, invert: 0
      });
      // op=2 = subtractAB (A but not B -- rect minus ellipse).
      // channel=0 = alpha (mask generators output alpha-mirror).
      const comb = makeNode("MatteCombine", 280, 150, {
        op: 2, channel: 0, invert: 0
      });
      const col = makeNode("Plasma", 280, 340, {
        speed: 0.8, scale: 1.5, paletteOffset: 0.3,
        audioReact: 0.0, bassReact: 0.0, clockReact: 0.0
      });
      const mask = makeNode("MaskShader", 540, 240, {
        invert: 0, softness: 0.0
      });
      const vo = makeNode("VisualOutput", 780, 240, { display: 0 });
      state.edges.push({ from: { node: rect, port: "out" }, to: { node: comb, port: "inA"   } });
      state.edges.push({ from: { node: ell,  port: "out" }, to: { node: comb, port: "inB"   } });
      state.edges.push({ from: { node: col,  port: "out" }, to: { node: mask, port: "color" } });
      state.edges.push({ from: { node: comb, port: "out" }, to: { node: mask, port: "mask"  } });
      state.edges.push({ from: { node: mask, port: "out" }, to: { node: vo,   port: "in"    } });
    }
  },

  /* v0.3.44 -- Channel Routing demo. ChannelCombiner pulls R, G, B
   * from a Plasma and Alpha from an EllipseMask's red channel
   * (mask generators output (m,m,m,m) so any channel works). The
   * result is a colorful disc that fades transparently at the
   * edges. AlphaCompose places it over a high-frequency NoiseShader
   * plate so the soft vignette shape is unambiguous. The same
   * pattern handles the inverse: alpha from a keyed source, RGB
   * re-graded from a different source. */
  {
    id: "channel-routing",
    name: "Channel Routing",
    sub: "rgb from A · alpha from B",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-cr-noise" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0"   stop-color="rgba(80,70,90,0.95)"/>
          <stop offset="0.5" stop-color="rgba(120,110,130,0.85)"/>
          <stop offset="1"   stop-color="rgba(60,55,75,0.95)"/>
        </linearGradient>
        <radialGradient id="dg-cr-disc" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0"   stop-color="rgba(230,90,170,1)"/>
          <stop offset="0.5" stop-color="rgba(255,210,90,0.95)"/>
          <stop offset="0.85" stop-color="rgba(131,232,255,0.5)"/>
          <stop offset="1"   stop-color="rgba(131,232,255,0)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-cr-noise)"/>
      <g opacity="0.4" stroke="rgba(255,255,255,0.4)" stroke-width="0.4">
        <line x1="0"  y1="14" x2="100" y2="11"/>
        <line x1="0"  y1="22" x2="100" y2="25"/>
        <line x1="0"  y1="32" x2="100" y2="29"/>
      </g>
      <circle cx="50" cy="22" r="17" fill="url(#dg-cr-disc)"/>
    </svg>`,
    build: () => {
      const rgb = makeNode("Plasma", 40, 60, {
        speed: 0.7, scale: 1.3, paletteOffset: 0.1,
        audioReact: 0.0, bassReact: 0.0, clockReact: 0.0
      });
      const alpha = makeNode("EllipseMask", 40, 240, {
        centerX: 0.5, centerY: 0.5,
        radiusX: 0.32, radiusY: 0.32,
        feather: 0.12, invert: 0
      });
      const bg = makeNode("NoiseShader", 40, 420, {
        scale: 22, octaves: 3, seedX: 0.5, seedY: 0.5
      });
      // pickR=0 (R), pickG=1 (G), pickB=2 (B), pickA=0 (read R from
      // the mask source -- mask generators output m in every channel
      // so any pick works; R is the simplest).
      const comb = makeNode("ChannelCombiner", 320, 150, {
        pickR: 0, pickG: 1, pickB: 2, pickA: 0
      });
      const comp = makeNode("AlphaCompose", 600, 300, {
        fgPremultiplied: 0, outPremultiplied: 0, opacity: 1.0
      });
      const vo = makeNode("VisualOutput", 820, 300, { display: 0 });
      // Plasma fans out into srcR + srcG + srcB; mask into srcA.
      state.edges.push({ from: { node: rgb,   port: "out" }, to: { node: comb, port: "srcR"       } });
      state.edges.push({ from: { node: rgb,   port: "out" }, to: { node: comb, port: "srcG"       } });
      state.edges.push({ from: { node: rgb,   port: "out" }, to: { node: comb, port: "srcB"       } });
      state.edges.push({ from: { node: alpha, port: "out" }, to: { node: comb, port: "srcA"       } });
      state.edges.push({ from: { node: comb,  port: "out" }, to: { node: comp, port: "foreground" } });
      state.edges.push({ from: { node: bg,    port: "out" }, to: { node: comp, port: "background" } });
      state.edges.push({ from: { node: comp,  port: "out" }, to: { node: vo,   port: "in"         } });
    }
  },

  /* Sprint 7.5.3a -- 3D Triangle smoke test. The minimal-viable
   * patch exercising the new Camera + Scene + DebugTriangle path:
   * one RGB triangle in front of a default-pose camera, output to
   * VisualOutput. Validates depth buffer + mesh pipeline + camera
   * matrix evaluation end-to-end. Replaced by richer demos when
   * sprint 7.5.3b ships proper primitives. */
  {
    id: "scene-3d-triangle",
    name: "3D Triangle",
    sub: "scene · camera · depth",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-3d-tri-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0"   stop-color="rgba(12, 18, 36, 1)"/>
          <stop offset="1"   stop-color="rgba(4, 6, 14, 1)"/>
        </linearGradient>
        <linearGradient id="dg-3d-tri-fill" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"    stop-color="rgba(255, 90, 90, 0.95)"/>
          <stop offset="0.5"  stop-color="rgba(90, 230, 130, 0.95)"/>
          <stop offset="1"    stop-color="rgba(120, 170, 255, 0.95)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-3d-tri-bg)"/>
      <polygon points="25,32 75,32 50,9" fill="url(#dg-3d-tri-fill)" opacity="0.95"/>
      <polygon points="25,32 75,32 50,9" fill="none"
               stroke="rgba(255,255,255,0.4)" stroke-width="0.6"/>
      <text x="50" y="42" text-anchor="middle"
            font-family="monospace" font-size="4.4"
            fill="rgba(180,200,255,0.7)" letter-spacing="0.10em">3D</text>
    </svg>`,
    build: () => {
      const tri = makeNode("DebugTriangle", 40,  60, { scale: 1.0 });
      const cam = makeNode("Camera",        40, 240, {
        posX: 0, posY: 0, posZ: 4,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 60, near: 0.1, far: 100, mode: 0
      });
      const scn = makeNode("Scene",         300, 140, {
        clearR: 0.04, clearG: 0.05, clearB: 0.09
      });
      const vo  = makeNode("VisualOutput",  540, 140, { display: 0 });
      state.edges.push({ from: { node: tri, port: "mesh"   }, to: { node: scn, port: "mesh1"  } });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: scn, port: "out"    }, to: { node: vo,  port: "in"     } });
    }
  },

  /* Sprint 7.5.3a -- 3D Orbit. The smoke test triangle with a camera
   * orbiting it in the XZ plane, tempo-locked to a MasterClock.
   * Validates several things on top of the 3D Triangle demo:
   *   - Camera params follow wired inputs (posX/posZ updated each frame)
   *   - The math-template recursion in _resolveNodeParams resolves
   *     chains like "MasterClock.phase -> Mul -> Sin -> Mul -> Camera.posX"
   *     without an audio runtime needed (everything JS-side mirrors)
   *   - MasterClock.phase is continuous-at-the-wrap (phase 0 == phase 1)
   *     because sin/cos have period 2π, so a beat-synced ramp produces
   *     a smooth orbit without discontinuities at beat boundaries
   *
   * Math chain (one full orbit per beat):
   *   MasterClock.phase -> Mul(2*pi) -> ┬-> Sin -> Mul(2.5) -> Camera.posX
   *                                     └-> Cos -> Mul(2.5) -> Camera.posZ
   *
   * bpm=30 means each beat lasts 2 seconds, so one full orbit takes 2s.
   * Drop a different bpm to change speed; wire a Slider into MasterClock.bpm
   * for live control. radius=2.5 world units = comfortable distance for
   * the default triangle (halfsize ~1) at fov=60. posY stays 0 -- the
   * orbit is in the horizontal XZ plane. */
  {
    id: "scene-3d-orbit",
    name: "3D Orbit",
    sub: "masterclock → sin/cos → camera",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-3d-orbit-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0"   stop-color="rgba(14, 22, 44, 1)"/>
          <stop offset="1"   stop-color="rgba(4, 8, 18, 1)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-3d-orbit-bg)"/>
      <!-- orbit ring -->
      <ellipse cx="50" cy="24" rx="34" ry="8" fill="none"
               stroke="rgba(131,232,255,0.4)" stroke-width="0.7"
               stroke-dasharray="2 3"/>
      <!-- triangle in middle -->
      <polygon points="42,26 58,26 50,16" fill="rgba(200,232,90,0.85)"
               stroke="rgba(255,255,255,0.4)" stroke-width="0.5"/>
      <!-- camera dot orbiting -->
      <circle cx="82" cy="22" r="2.2" fill="rgba(255,180,90,0.95)"/>
      <text x="82" y="32" text-anchor="middle"
            font-family="monospace" font-size="3.6"
            fill="rgba(255,180,90,0.85)">CAM</text>
    </svg>`,
    build: () => {
      // Animation source: MasterClock at 30 BPM. .phase output is a
      // continuous 0..1 ramp per beat, so at bpm=30 (one beat = 2s)
      // the orbit cycle is also 2s. The JS-side mirror in
      // _masterClockOutputValue gives the same value at frame rate
      // without needing the audio runtime.
      const clk    = makeNode("MasterClock",   40,  40, { bpm: 30 });
      // Convert phase (0..1) -> angle (0..2π) so Sin/Cos see a full
      // revolution per beat. Use _isMathTemplateType chain (Mul/Sin/Cos)
      // -- these all have JS-side mirrors and pass through _resolveNodeParams.
      const mulTau = makeNode("Mul",          240,  40, { b: 6.283185307 });
      const sinN   = makeNode("Sin",          420,  40);
      const cosN   = makeNode("Cos",          420, 130);
      // Scale to orbit radius. 2.5 world units = comfortable distance
      // for the default triangle (halfsize ~1) at fov=60.
      const mulRx  = makeNode("Mul",          580,  40,  { b: 2.5 });
      const mulRz  = makeNode("Mul",          580, 130, { b: 2.5 });

      const tri = makeNode("DebugTriangle",    40, 240, { scale: 1.0 });
      const cam = makeNode("Camera",           40, 340, {
        posX: 0, posY: 0, posZ: 0,            // overridden by wires
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 60, near: 0.1, far: 100, mode: 0
      });
      const scn = makeNode("Scene",           780, 200, {
        clearR: 0.04, clearG: 0.05, clearB: 0.09
      });
      const vo  = makeNode("VisualOutput",   1020, 200, { display: 0 });

      // Math chain: clock.phase -> 2π -> Sin/Cos -> radius -> camera xz.
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinN,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: cosN,   port: "in" } });
      state.edges.push({ from: { node: sinN,   port: "out"   }, to: { node: mulRx,  port: "a" } });
      state.edges.push({ from: { node: cosN,   port: "out"   }, to: { node: mulRz,  port: "a" } });
      // Math chain -> Camera position.
      state.edges.push({ from: { node: mulRx,  port: "out"    }, to: { node: cam, port: "posX"  } });
      state.edges.push({ from: { node: mulRz,  port: "out"    }, to: { node: cam, port: "posZ"  } });
      // Scene wiring.
      state.edges.push({ from: { node: tri,    port: "mesh"   }, to: { node: scn, port: "mesh1"  } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: scn,    port: "out"    }, to: { node: vo,  port: "in"     } });
    }
  },

  /* Sprint 7.5.3b -- Primitive showcase. All four Scene mesh inputs
   * occupied by different primitives, each Translate'd to a unique
   * x position so they form a row. Validates that the multi-mesh
   * path works + each primitive type renders correctly. Camera
   * positioned far enough back to see all four. */
  {
    id: "scene-3d-primitives",
    name: "3D Primitives",
    sub: "box · sphere · cone · torus",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(10, 16, 32, 1)"/>
      <!-- 4 primitives in a row -->
      <rect x="9"  y="16" width="14" height="14" fill="rgba(255,90,90,0.85)"
            stroke="rgba(255,255,255,0.4)" stroke-width="0.5"/>
      <circle cx="36" cy="23" r="7"
              fill="rgba(120,200,255,0.85)"
              stroke="rgba(255,255,255,0.4)" stroke-width="0.5"/>
      <polygon points="58,30 66,15 74,30" fill="rgba(255,200,90,0.85)"
               stroke="rgba(255,255,255,0.4)" stroke-width="0.5"/>
      <ellipse cx="88" cy="23" rx="7.5" ry="5.5"
               fill="rgba(230,90,180,0.85)"
               stroke="rgba(255,255,255,0.4)" stroke-width="0.5"/>
      <ellipse cx="88" cy="23" rx="3" ry="2"
               fill="rgba(10, 16, 32, 1)"/>
    </svg>`,
    build: () => {
      const box  = makeNode("Box",       40,  40, { width: 1, height: 1, depth: 1 });
      const sph  = makeNode("Sphere",    40, 140, { radius: 0.6, stacks: 16, slices: 24 });
      const con  = makeNode("Cone",      40, 240, { radius: 0.6, height: 1.2, slices: 24 });
      const tor  = makeNode("Torus",     40, 340, { majorRadius: 0.7, minorRadius: 0.25, majorSlices: 24, minorSlices: 12 });
      const tBox = makeNode("Translate", 280,  40, { x: -3, y: 0, z: 0 });
      const tSph = makeNode("Translate", 280, 140, { x: -1, y: 0, z: 0 });
      const tCon = makeNode("Translate", 280, 240, { x:  1, y: 0, z: 0 });
      const tTor = makeNode("Translate", 280, 340, { x:  3, y: 0, z: 0 });
      const cam  = makeNode("Camera",    520, 200, {
        posX: 0, posY: 1.5, posZ: 6,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 55, near: 0.1, far: 100, mode: 0
      });
      const scn  = makeNode("Scene",     760, 200, { clearR: 0.04, clearG: 0.05, clearB: 0.09 });
      const vo   = makeNode("VisualOutput", 980, 200, { display: 0 });
      state.edges.push({ from: { node: box, port: "mesh" }, to: { node: tBox, port: "mesh" } });
      state.edges.push({ from: { node: sph, port: "mesh" }, to: { node: tSph, port: "mesh" } });
      state.edges.push({ from: { node: con, port: "mesh" }, to: { node: tCon, port: "mesh" } });
      state.edges.push({ from: { node: tor, port: "mesh" }, to: { node: tTor, port: "mesh" } });
      state.edges.push({ from: { node: tBox, port: "mesh" }, to: { node: scn, port: "mesh1" } });
      state.edges.push({ from: { node: tSph, port: "mesh" }, to: { node: scn, port: "mesh2" } });
      state.edges.push({ from: { node: tCon, port: "mesh" }, to: { node: scn, port: "mesh3" } });
      state.edges.push({ from: { node: tTor, port: "mesh" }, to: { node: scn, port: "mesh4" } });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: scn, port: "out" }, to: { node: vo, port: "in" } });
    }
  },

  /* Sprint 7.5.3b -- Spinning Box. The cleanest "is the transform
   * stack working?" demo. A single Box, rotated around Y by an angle
   * driven from MasterClock.phase * 360, so the box completes one
   * full revolution per beat. At bpm=60 that's one rotation per
   * second -- visually obvious + obviously tempo-locked. */
  {
    id: "scene-3d-spinbox",
    name: "Spinning Box",
    sub: "masterclock × rotate · 1 rev / beat",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(10, 16, 32, 1)"/>
      <!-- box in mid-rotation: skewed perspective view -->
      <polygon points="36,12 64,12 76,22 48,22" fill="rgba(96,220,96,0.85)"
               stroke="rgba(255,255,255,0.45)" stroke-width="0.6"/>
      <polygon points="36,12 36,32 48,42 48,22" fill="rgba(255,90,90,0.85)"
               stroke="rgba(255,255,255,0.45)" stroke-width="0.6"/>
      <polygon points="48,22 76,22 76,42 48,42" fill="rgba(96,140,255,0.85)"
               stroke="rgba(255,255,255,0.45)" stroke-width="0.6"/>
    </svg>`,
    build: () => {
      const clk     = makeNode("MasterClock", 40,  40, { bpm: 60 });
      // phase * 360 = degrees per beat (one full revolution).
      const mul     = makeNode("Mul",         240, 40, { b: 360 });
      const box     = makeNode("Box",         40,  200, { width: 1.2, height: 1.2, depth: 1.2 });
      const rot     = makeNode("Rotate",      280, 200, { angleX: 20, angleY: 0, angleZ: 0 });
      const cam     = makeNode("Camera",      40,  340, {
        posX: 0, posY: 0.5, posZ: 4,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 60, near: 0.1, far: 100, mode: 0
      });
      const scn     = makeNode("Scene",       560, 200, { clearR: 0.04, clearG: 0.05, clearB: 0.09 });
      const vo      = makeNode("VisualOutput",780, 200, { display: 0 });
      state.edges.push({ from: { node: clk, port: "phase" }, to: { node: mul, port: "a" } });
      state.edges.push({ from: { node: mul, port: "out"   }, to: { node: rot, port: "angleY" } });
      state.edges.push({ from: { node: box, port: "mesh"  }, to: { node: rot, port: "mesh" } });
      state.edges.push({ from: { node: rot, port: "mesh"  }, to: { node: scn, port: "mesh1" } });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: scn, port: "out"   }, to: { node: vo,  port: "in" } });
    }
  },

  /* Sprint 7.5.3b -- Bouncing Sphere. Sphere with a Translate whose
   * Y is driven by sin(MasterClock.phase * 2π) * 1.0, so the sphere
   * bobs +/- 1 world-unit per beat. Demonstrates the math chain
   * resolves into a transform param (not just into a Camera param
   * as in the orbit demo). */
  {
    id: "scene-3d-bounce",
    name: "Bouncing Sphere",
    sub: "sin(phase × 2π) · vertical bob",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(10, 16, 32, 1)"/>
      <!-- ground line -->
      <line x1="10" y1="36" x2="90" y2="36" stroke="rgba(120,180,255,0.4)" stroke-width="0.6"/>
      <!-- 3 sphere positions to suggest bouncing -->
      <circle cx="30" cy="32" r="5" fill="rgba(180,220,255,0.5)"/>
      <circle cx="50" cy="20" r="5" fill="rgba(180,220,255,0.85)"
              stroke="rgba(255,255,255,0.4)" stroke-width="0.5"/>
      <circle cx="70" cy="32" r="5" fill="rgba(180,220,255,0.5)"/>
    </svg>`,
    build: () => {
      const clk    = makeNode("MasterClock", 40,  40, { bpm: 60 });
      // phase * 2π -> Sin -> bob in [-1, 1]; scale by 1.0 for ±1 unit bob.
      const mulTau = makeNode("Mul",         240, 40, { b: 6.283185307 });
      const sinN   = makeNode("Sin",         420, 40);
      const mulAmp = makeNode("Mul",         600, 40, { b: 1.0 });
      const sph    = makeNode("Sphere",      40,  200, { radius: 0.5, stacks: 16, slices: 24 });
      const trn    = makeNode("Translate",   280, 200, { x: 0, y: 0, z: 0 });
      const cam    = makeNode("Camera",      40,  340, {
        posX: 0, posY: 0, posZ: 4,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 60, near: 0.1, far: 100, mode: 0
      });
      const scn    = makeNode("Scene",       560, 200, { clearR: 0.04, clearG: 0.05, clearB: 0.09 });
      const vo     = makeNode("VisualOutput",780, 200, { display: 0 });
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinN,   port: "in" } });
      state.edges.push({ from: { node: sinN,   port: "out"   }, to: { node: mulAmp, port: "a" } });
      state.edges.push({ from: { node: mulAmp, port: "out"   }, to: { node: trn,    port: "y" } });
      state.edges.push({ from: { node: sph,    port: "mesh"  }, to: { node: trn,    port: "mesh" } });
      state.edges.push({ from: { node: trn,    port: "mesh"  }, to: { node: scn,    port: "mesh1" } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: scn,   port: "camera" } });
      state.edges.push({ from: { node: scn,    port: "out"   }, to: { node: vo,     port: "in" } });
    }
  },

  /* Sprint 7.5.3c -- Lit Trio. Box, Sphere, Torus side-by-side
   * with PhongMat applied (each a different color), one
   * DirectionalLight overhead-front. Camera orbits slowly so the
   * Phong specular highlight sweeps across the surfaces -- the
   * clearest visual cue that lighting is actually working. */
  {
    id: "scene-3d-lit-trio",
    name: "Lit Trio",
    sub: "phong · box · sphere · torus",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-lit-sphere" cx="0.35" cy="0.35" r="0.7">
          <stop offset="0" stop-color="rgba(255,255,255,0.95)"/>
          <stop offset="0.5" stop-color="rgba(120,200,255,0.95)"/>
          <stop offset="1" stop-color="rgba(40,80,160,1)"/>
        </radialGradient>
        <linearGradient id="dg-lit-box" x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0" stop-color="rgba(255,200,180,0.95)"/>
          <stop offset="1" stop-color="rgba(180,80,60,1)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(8, 12, 24, 1)"/>
      <!-- box -->
      <polygon points="10,30 22,30 22,20 14,16 10,18" fill="url(#dg-lit-box)"
               stroke="rgba(255,255,255,0.35)" stroke-width="0.5"/>
      <polygon points="14,16 22,12 22,20" fill="rgba(255,235,210,0.9)"
               stroke="rgba(255,255,255,0.35)" stroke-width="0.5"/>
      <!-- sphere -->
      <circle cx="48" cy="22" r="9" fill="url(#dg-lit-sphere)"/>
      <ellipse cx="44" cy="18" rx="2.4" ry="1.6" fill="rgba(255,255,255,0.5)"/>
      <!-- torus -->
      <ellipse cx="82" cy="22" rx="9" ry="6"
               fill="none" stroke="rgba(220,140,255,0.85)" stroke-width="3"/>
      <ellipse cx="79" cy="20" rx="2.5" ry="1.5"
               fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.4"/>
    </svg>`,
    build: () => {
      // Three primitives with distinct PhongMat colors
      const box  = makeNode("Box",     40,  40, { width: 1, height: 1, depth: 1 });
      const sph  = makeNode("Sphere",  40, 200, { radius: 0.7, stacks: 24, slices: 32 });
      const tor  = makeNode("Torus",   40, 360, { majorRadius: 0.75, minorRadius: 0.22, majorSlices: 32, minorSlices: 16 });
      // Materials (PhongMat -- each its own color).
      // vertexMix kept at 0 so the material color shows pure; tweak
      // to ~0.3 to see the per-vertex color blended with the
      // material.
      const mBox = makeNode("PhongMat",   240,  40, { r: 0.95, g: 0.45, b: 0.30, shininess: 24, ambient: 0.15, vertexMix: 0.0 });
      const mSph = makeNode("PhongMat",   240, 200, { r: 0.40, g: 0.70, b: 0.95, shininess: 64, ambient: 0.18, vertexMix: 0.0 });
      const mTor = makeNode("PhongMat",   240, 360, { r: 0.78, g: 0.42, b: 0.95, shininess: 48, ambient: 0.18, vertexMix: 0.0 });
      // Spread them out along X.
      const tBox = makeNode("Translate",  440,  40, { x: -2.6, y: 0, z: 0 });
      const tSph = makeNode("Translate",  440, 200, { x:  0,   y: 0, z: 0 });
      const tTor = makeNode("Translate",  440, 360, { x:  2.6, y: 0, z: 0 });
      // Camera orbit so the specular sweeps -- slower than 3D Orbit
      // (one revolution every 8 seconds = bpm=7.5 at 1 orbit/beat).
      // Use bpm=30 with mul 0.25 to compose more naturally.
      const clk    = makeNode("MasterClock", 660,  40, { bpm: 30 });
      const mulQ   = makeNode("Mul",         840,  40, { b: 0.25 });   // 0.25 of phase per beat
      const mulTau = makeNode("Mul",        1020,  40, { b: 6.283185307 });
      const sinN   = makeNode("Sin",        1200,  40);
      const cosN   = makeNode("Cos",        1200, 130);
      const mulRx  = makeNode("Mul",        1360,  40, { b: 4.5 });
      const mulRz  = makeNode("Mul",        1360, 130, { b: 4.5 });
      const cam    = makeNode("Camera",      660, 240, {
        posX: 0, posY: 1.2, posZ: 0,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 50, near: 0.1, far: 100, mode: 0
      });
      // Directional light: above-front, slight warm tint.
      const light  = makeNode("DirectionalLight", 660, 400, {
        dirX: 0.4, dirY: 1.0, dirZ: 0.5,
        colorR: 1.0, colorG: 0.97, colorB: 0.85, intensity: 1.1
      });
      const scn    = makeNode("Scene",      1540, 200, { clearR: 0.03, clearG: 0.04, clearB: 0.07 });
      const vo     = makeNode("VisualOutput", 1780, 200, { display: 0 });
      // Mesh -> material -> translate chain.
      state.edges.push({ from: { node: box, port: "mesh" }, to: { node: mBox, port: "mesh" } });
      state.edges.push({ from: { node: sph, port: "mesh" }, to: { node: mSph, port: "mesh" } });
      state.edges.push({ from: { node: tor, port: "mesh" }, to: { node: mTor, port: "mesh" } });
      state.edges.push({ from: { node: mBox, port: "mesh" }, to: { node: tBox, port: "mesh" } });
      state.edges.push({ from: { node: mSph, port: "mesh" }, to: { node: tSph, port: "mesh" } });
      state.edges.push({ from: { node: mTor, port: "mesh" }, to: { node: tTor, port: "mesh" } });
      // Camera orbit math.
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulQ,   port: "a" } });
      state.edges.push({ from: { node: mulQ,   port: "out"   }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinN,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: cosN,   port: "in" } });
      state.edges.push({ from: { node: sinN,   port: "out"   }, to: { node: mulRx,  port: "a" } });
      state.edges.push({ from: { node: cosN,   port: "out"   }, to: { node: mulRz,  port: "a" } });
      state.edges.push({ from: { node: mulRx,  port: "out"   }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulRz,  port: "out"   }, to: { node: cam,    port: "posZ" } });
      // Scene wiring.
      state.edges.push({ from: { node: tBox,  port: "mesh"   }, to: { node: scn, port: "mesh1" } });
      state.edges.push({ from: { node: tSph,  port: "mesh"   }, to: { node: scn, port: "mesh2" } });
      state.edges.push({ from: { node: tTor,  port: "mesh"   }, to: { node: scn, port: "mesh3" } });
      state.edges.push({ from: { node: cam,   port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light"  }, to: { node: scn, port: "light1" } });
      state.edges.push({ from: { node: scn,   port: "out"    }, to: { node: vo,  port: "in" } });
    }
  },

  /* Sprint 7.5.3c push 2 -- PBR Showcase. Three spheres
   * demonstrating the metallic + roughness axes that PhysicalMat
   * exposes:
   *
   *   left   = dielectric (plastic feel)  metallic=0   roughness=0.35
   *   middle = mixed (anodized metal)     metallic=0.5 roughness=0.5
   *   right  = polished metal             metallic=1.0 roughness=0.15
   *
   * Lit by an orbiting PointLight + a quiet fill DirectionalLight
   * left as the default warm-white above-front. The PointLight
   * sweeping past makes the difference between dielectric speculars
   * (white) and metal speculars (albedo-tinted) immediately obvious.
   *
   * PointLight orbit: MasterClock(bpm=20).phase * 2π through Sin/Cos
   * for a 3-second period at ~3-unit radius, height +2. */
  {
    id: "scene-3d-pbr-showcase",
    name: "PBR Showcase",
    sub: "dielectric · mixed · polished metal",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-pbr-plastic" cx="0.35" cy="0.35" r="0.7">
          <stop offset="0" stop-color="rgba(255,255,255,0.9)"/>
          <stop offset="0.3" stop-color="rgba(240,150,90,0.9)"/>
          <stop offset="1" stop-color="rgba(120,40,20,1)"/>
        </radialGradient>
        <radialGradient id="dg-pbr-mixed" cx="0.4" cy="0.35" r="0.8">
          <stop offset="0" stop-color="rgba(255,255,255,0.95)"/>
          <stop offset="0.45" stop-color="rgba(220,180,100,0.95)"/>
          <stop offset="1" stop-color="rgba(80,55,20,1)"/>
        </radialGradient>
        <radialGradient id="dg-pbr-chrome" cx="0.4" cy="0.3" r="0.8">
          <stop offset="0" stop-color="rgba(255,255,255,1)"/>
          <stop offset="0.2" stop-color="rgba(220,225,235,1)"/>
          <stop offset="0.7" stop-color="rgba(110,120,140,1)"/>
          <stop offset="1" stop-color="rgba(30,40,60,1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(8, 10, 18, 1)"/>
      <circle cx="20" cy="24" r="9" fill="url(#dg-pbr-plastic)"/>
      <circle cx="50" cy="24" r="9" fill="url(#dg-pbr-mixed)"/>
      <circle cx="80" cy="24" r="9" fill="url(#dg-pbr-chrome)"/>
      <!-- ground reflection hint -->
      <rect x="0" y="34" width="100" height="10" fill="rgba(40,50,80,0.3)"/>
    </svg>`,
    build: () => {
      const sph1 = makeNode("Sphere", 40,  40, { radius: 0.8, stacks: 32, slices: 48 });
      const sph2 = makeNode("Sphere", 40, 200, { radius: 0.8, stacks: 32, slices: 48 });
      const sph3 = makeNode("Sphere", 40, 360, { radius: 0.8, stacks: 32, slices: 48 });
      // Three PhysicalMat configs spanning the metallic / roughness axes.
      const mat1 = makeNode("PhysicalMat", 260,  40, { r: 0.95, g: 0.50, b: 0.30, metallic: 0.0, roughness: 0.35 });
      const mat2 = makeNode("PhysicalMat", 260, 200, { r: 0.92, g: 0.78, b: 0.30, metallic: 0.5, roughness: 0.50 });
      const mat3 = makeNode("PhysicalMat", 260, 360, { r: 0.78, g: 0.80, b: 0.85, metallic: 1.0, roughness: 0.15 });
      const tr1  = makeNode("Translate",   480,  40, { x: -2.4, y: 0, z: 0 });
      const tr2  = makeNode("Translate",   480, 200, { x:  0,   y: 0, z: 0 });
      const tr3  = makeNode("Translate",   480, 360, { x:  2.4, y: 0, z: 0 });
      const cam  = makeNode("Camera",      700,  60, {
        posX: 0, posY: 0.6, posZ: 5,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 50, near: 0.1, far: 100, mode: 0
      });
      // Orbiting PointLight. MasterClock(20bpm).phase * 2π through
      // Sin/Cos for the position. 3-unit radius, height +2.
      const clk    = makeNode("MasterClock", 700,  200, { bpm: 20 });
      const mulTau = makeNode("Mul",         900, 200, { b: 6.283185307 });
      const sinN   = makeNode("Sin",        1080, 200);
      const cosN   = makeNode("Cos",        1080, 290);
      const mulRx  = makeNode("Mul",        1240, 200, { b: 3 });
      const mulRz  = makeNode("Mul",        1240, 290, { b: 3 });
      const light  = makeNode("PointLight",  700, 360, {
        posX: 0, posY: 2.0, posZ: 0,
        colorR: 1.0, colorG: 0.95, colorB: 0.80,
        intensity: 2.0, range: 10.0
      });
      const scn    = makeNode("Scene",      1480, 200, { clearR: 0.02, clearG: 0.03, clearB: 0.06 });
      const vo     = makeNode("VisualOutput", 1700, 200, { display: 0 });
      // Mesh -> material -> transform chain
      state.edges.push({ from: { node: sph1, port: "mesh" }, to: { node: mat1, port: "mesh" } });
      state.edges.push({ from: { node: sph2, port: "mesh" }, to: { node: mat2, port: "mesh" } });
      state.edges.push({ from: { node: sph3, port: "mesh" }, to: { node: mat3, port: "mesh" } });
      state.edges.push({ from: { node: mat1, port: "mesh" }, to: { node: tr1,  port: "mesh" } });
      state.edges.push({ from: { node: mat2, port: "mesh" }, to: { node: tr2,  port: "mesh" } });
      state.edges.push({ from: { node: mat3, port: "mesh" }, to: { node: tr3,  port: "mesh" } });
      // Light orbit math -> PointLight.posX, .posZ
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinN,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: cosN,   port: "in" } });
      state.edges.push({ from: { node: sinN,   port: "out"   }, to: { node: mulRx,  port: "a" } });
      state.edges.push({ from: { node: cosN,   port: "out"   }, to: { node: mulRz,  port: "a" } });
      state.edges.push({ from: { node: mulRx,  port: "out"   }, to: { node: light,  port: "posX" } });
      state.edges.push({ from: { node: mulRz,  port: "out"   }, to: { node: light,  port: "posZ" } });
      // Scene wiring
      state.edges.push({ from: { node: tr1,   port: "mesh"   }, to: { node: scn, port: "mesh1" } });
      state.edges.push({ from: { node: tr2,   port: "mesh"   }, to: { node: scn, port: "mesh2" } });
      state.edges.push({ from: { node: tr3,   port: "mesh"   }, to: { node: scn, port: "mesh3" } });
      state.edges.push({ from: { node: cam,   port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light"  }, to: { node: scn, port: "light1" } });
      state.edges.push({ from: { node: scn,   port: "out"    }, to: { node: vo,  port: "in"     } });
    }
  },

  /* Phase 7 §5.5.a — Terrain Landscape. The stop-go demo for the
   * Terrain node: built-in fBm heightmap → PhongMat for lit
   * shading → Scene with a directional "sun" light. Slow camera
   * orbit so the surface normals sweep visibly across the lit
   * face. Peaks land at Y = 0 (default yOffset), valleys descend
   * to Y = -12 with the default heightScale -- camera positioned
   * above (posY = 14) looking slightly downward so the whole
   * patch reads as "overlooking a landscape" rather than the
   * upside-down-ceiling problem the bare Terrain hit in v0.3.120. */
  {
    id: "scene-terrain",
    name: "Terrain Landscape",
    sub: "fBm heightmap · phong · sun",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-ter-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"    stop-color="rgba(70, 110, 170, 1)"/>
          <stop offset="0.55" stop-color="rgba(170, 195, 220, 1)"/>
          <stop offset="1"    stop-color="rgba(220, 200, 160, 1)"/>
        </linearGradient>
        <linearGradient id="dg-ter-ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"   stop-color="rgba(110, 90, 70, 1)"/>
          <stop offset="0.7" stop-color="rgba(70, 95, 55, 1)"/>
          <stop offset="1"   stop-color="rgba(40, 60, 40, 1)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-ter-sky)"/>
      <!-- Mountain silhouettes (back-to-front for depth) -->
      <polygon points="0,30 12,18 24,26 36,14 48,22 60,16 72,24 84,18 100,28 100,44 0,44"
               fill="rgba(60, 80, 100, 0.85)"/>
      <polygon points="0,36 14,26 28,32 42,22 56,30 68,24 82,30 96,26 100,32 100,44 0,44"
               fill="rgba(80, 100, 80, 0.92)"/>
      <polygon points="0,44 10,34 22,40 34,32 46,38 58,32 70,40 82,34 94,38 100,40 100,44"
               fill="url(#dg-ter-ground)"/>
      <!-- Snow on the highest peak -->
      <polygon points="34,32 36,14 38,32" fill="rgba(245, 245, 255, 0.95)"/>
      <!-- Sun -->
      <circle cx="78" cy="11" r="3.5" fill="rgba(255, 235, 180, 0.9)"/>
    </svg>`,
    build: () => {
      // Terrain: medium preset (100u square), 6-octave fBm, gentle
      // ridges for a mountain-y feel without going full crag. The
      // built-in noise params are kept for reference but the actual
      // displacement comes from the wired ProceduralTerrain below
      // (§5.5.c-3 GPU vertex-shader path).
      const ter = makeNode("Terrain", 40, 40, {
        sizeMode:   "medium",
        worldSize:  100,
        heightScale: 12,
        yOffset:    0,
        segments:   96,
        // These noise params are also passed to the ProceduralTerrain
        // below so the visual shape matches the §5.5.a CPU fallback
        // if the user un-wires the heightmap.
        seed:       7.42,
        frequency:  2.5,
        octaves:    6,
        lacunarity: 2.05,
        gain:       0.5,
        ridges:     0.35
      });
      // ProceduralTerrain feeds the heightmap input -- vs_terrain
      // samples this texture per-vertex for Y displacement on the
      // GPU instead of running noise CPU-side. v0.3.128 game-dev
      // upgrade adds warpAmount (organic meandering) + erosion
      // (settled valleys) on top of the ridge fbm for a more
      // realistic mountain landscape.
      const proc = makeNode("ProceduralTerrain", -440, 40, {
        type:          "ridges",
        seed:          7.42,
        frequency:     2.5,
        octaves:       6,
        lacunarity:    2.05,
        gain:          0.5,
        ridges:        0.0,        // base already ridges via type
        warpAmount:    0.35,
        warpFreq:      0.6,
        erosion:       0.15,       // light power-remap; main carving handled by TerrainErosion below
        continentMask: 0.0,
        terrace:       0.0
      });
      // §5.5.d TerrainErosion: hydraulic + thermal pass that
      // smooths convex ridges, settles material on slopes above
      // the talus threshold, and lets concave valleys hold
      // sediment. Drops in between ProceduralTerrain and Terrain
      // for a noticeably more geologically-plausible silhouette
      // (vs the bare procedural heightmap, which has uniform
      // sharpness everywhere).
      const ero = makeNode("TerrainErosion", -200, 40, {
        thermal:    0.9,
        hydraulic:  0.9,
        talus:      0.005,
        iterations: 8,
        radius:     5.0,
        strength:   1.0
      });
      // TerrainMaterial: altitude- and slope-blended bands so the
      // valleys read as sand, mid-slopes as grass, upper slopes
      // as rock, peaks as snow. slopeRockiness=2 pushes the rock
      // band onto steep cliffs at any altitude. softness=1.2
      // gives gentle transitions instead of hard stripes.
      const mat = makeNode("TerrainMaterial", 280, 40, {
        color1R: 0.85, color1G: 0.78, color1B: 0.55, alt1: -8,
        color2R: 0.36, color2G: 0.52, color2B: 0.26, alt2: -4,
        color3R: 0.45, color3G: 0.40, color3B: 0.35, alt3: -1,
        color4R: 0.94, color4G: 0.95, color4B: 0.98,
        softness: 1.2, slopeRockiness: 2.0,
        shininess: 8, ambient: 0.20, vertexMix: 0.0
      });
      // Slow MasterClock-driven camera orbit (one revolution every
      // 32 beats at 30 bpm = 64s) so the sun-side specular sweeps
      // across the surface. Radius ~50 keeps the whole patch in
      // view without falling off the edge.
      const clk    = makeNode("MasterClock", 40, 220, { bpm: 30 });
      const mulQ   = makeNode("Mul",        240, 220, { b: 0.03125 }); // 1/32 phase per beat
      const mulTau = makeNode("Mul",        420, 220, { b: 6.283185307 });
      const sinN   = makeNode("Sin",        600, 200);
      const cosN   = makeNode("Cos",        600, 280);
      const mulRx  = makeNode("Mul",        780, 200, { b: 50 });
      const mulRz  = makeNode("Mul",        780, 280, { b: 50 });
      const cam = makeNode("Camera", 980, 240, {
        posX: 0,  posY: 14, posZ: 50,
        targetX: 0, targetY: -2, targetZ: 0,
        fov: 55, near: 0.1, far: 500, mode: 0
      });
      // Sun-like directional light from above-front with a warm
      // golden tint. Intensity slightly above 1 to compensate for
      // the matte Phong shininess.
      const light = makeNode("DirectionalLight", 40, 400, {
        dirX: 0.4, dirY: 0.85, dirZ: 0.3,
        colorR: 1.0, colorG: 0.92, colorB: 0.78,
        intensity: 1.25
      });
      const scn = makeNode("Scene", 1200, 240, {
        clearR: 0.45, clearG: 0.62, clearB: 0.82
      });
      const vo  = makeNode("VisualOutput", 1440, 240, { display: 0 });

      // Mesh chain + heightmap wire (§5.5.c-3 GPU displacement),
      // now routed through TerrainErosion (§5.5.d) for a final
      // pass before the heightmap reaches the displaced vertex
      // shader.
      state.edges.push({ from: { node: proc, port: "out"  }, to: { node: ero, port: "in"        } });
      state.edges.push({ from: { node: ero,  port: "out"  }, to: { node: ter, port: "heightmap" } });
      state.edges.push({ from: { node: ter,  port: "mesh" }, to: { node: mat, port: "mesh"      } });
      state.edges.push({ from: { node: mat,  port: "mesh" }, to: { node: scn, port: "mesh1"     } });
      // Camera orbit math: phase * (1/32) * 2π → sin/cos → posX/posZ.
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulQ,   port: "a" } });
      state.edges.push({ from: { node: mulQ,   port: "out"   }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinN,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: cosN,   port: "in" } });
      state.edges.push({ from: { node: sinN,   port: "out"   }, to: { node: mulRx,  port: "a" } });
      state.edges.push({ from: { node: cosN,   port: "out"   }, to: { node: mulRz,  port: "a" } });
      state.edges.push({ from: { node: mulRx,  port: "out"   }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulRz,  port: "out"   }, to: { node: cam,    port: "posZ" } });
      // Scene wiring.
      state.edges.push({ from: { node: cam,   port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light"  }, to: { node: scn, port: "light1" } });
      state.edges.push({ from: { node: scn,   port: "out"    }, to: { node: vo,  port: "in"     } });
    }
  },

  /* Phase 7 §5.5.e -- Walkable Terrain. The showcase for TiledTerrain
   * + FPCamera + TerrainMaterial. Click the visual canvas to engage
   * pointer-lock; WASD to move, mouse to look, Shift to sprint. Top-
   * right minimap shows the chunk grid + your tile. Chunks regen as
   * you cross boundaries so the world is effectively infinite.
   *
   * Defaults: chunkSize=32u, chunkRadius=4 (9x9 chunks visible) at
   * segments=16 -> 81 chunks, ~23k verts. heightScale=20 (rolling-
   * hills scale at 1u=1m). Wire the chunkSize / radius / noise
   * params via the ⚙ Tiling Config popup on the TiledTerrain node. */
  {
    id: "scene-walkable-terrain",
    name: "Walkable Terrain",
    sub: "infinite chunks · FPCamera · WASD",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-walk-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"    stop-color="rgba(100, 140, 200, 1)"/>
          <stop offset="0.6"  stop-color="rgba(180, 200, 220, 1)"/>
          <stop offset="1"    stop-color="rgba(220, 200, 170, 1)"/>
        </linearGradient>
        <linearGradient id="dg-walk-grass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(110,150,90,1)"/>
          <stop offset="1" stop-color="rgba(70,100,60,1)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-walk-sky)"/>
      <polygon points="0,30 14,18 28,28 42,16 56,24 70,18 84,26 100,28 100,44 0,44" fill="rgba(70,90,110,0.7)"/>
      <polygon points="0,38 16,30 32,34 48,28 64,32 80,28 96,32 100,34 100,44 0,44" fill="url(#dg-walk-grass)"/>
      <!-- minimap corner -->
      <rect x="78" y="4"  width="18" height="18" fill="rgba(10,16,28,0.85)" stroke="rgba(110,220,180,0.6)" stroke-width="0.6"/>
      <line x1="87" y1="4"  x2="87" y2="22" stroke="rgba(110,220,180,0.25)" stroke-width="0.4"/>
      <line x1="78" y1="13" x2="96" y2="13" stroke="rgba(110,220,180,0.25)" stroke-width="0.4"/>
      <circle cx="87" cy="13" r="1.4" fill="rgba(180,240,255,1)"/>
    </svg>`,
    build: () => {
      // §5.5.e-4 -- TiledTerrain at TRUE-MOUNTAIN scale at 1u=1m.
      // 25×25 chunks (radius=12) at chunkSize=256m = 6400m visible
      // disc. heightScale=3000m peaks (Everest-class), with
      // frequency=0.0008 (1 feature every ~1250m) + octaves=4
      // (smoother, fewer high-freq wiggles) so the world has a few
      // PROMINENT mountains instead of a noisy ridge salad.
      // ridges=0.7 sharpens crests. yOffset=3000 puts valleys at
      // Y=0 (sea level) and peaks at Y=+3000, so the player walks
      // on the surface with mountains rising above.
      const ter = makeNode("TiledTerrain", 40, 80, {
        // §5.5.e-12 -- bigger render distance. radius=24 +
        // chunkSize=256m = 6.1km radius / 12.5km diameter visible
        // disc. 49×49 = 2401 chunks; the 5-LOD-ring distribution
        // keeps total verts ~200k. Outer ring (LOD 4) is silhouette-
        // only at this distance, which is fine for far peaks.
        chunkSize:   256,
        chunkRadius: 24,
        segments:    24,
        heightScale: 3000,
        yOffset:     3000,
        seed:        7.42,
        frequency:   0.0005,    // 1 major feature every ~2km
        octaves:     4,
        lacunarity:  2.10,
        gain:        0.45,
        ridges:      0.35,
        plateau:     0.7,
        forwardBias: 0.20,      // smaller bias at huge radius
        // §5.5.e-8 built-in erosion. Baked into chunks at build time
        // so there's no per-frame cost -- the 3-second first-load
        // absorbs the extra fBm calls. Carves ridges, settles
        // valleys for natural weathered terrain.
        erosionThermal:    0.65,
        erosionHydraulic:  0.55,
        erosionTalus:      0.02,
        erosionIterations: 4,
        erosionRadius:     80,
        erosionStrength:   0.6,
        anchorMode:  "auto"
      });
      // TerrainMaterial: auto-detects upstream TiledTerrain and
      // scales alt bands by heightScale/12. At heightScale=3000 the
      // bandScale = 250, so alt1=2 → 500m, alt2=6 → 1500m, alt3=10
      // → 2500m. With yOffset=3000 the terrain spans Y=0..3000m:
      //   0..500m   : grass (valleys / lowlands)
      //   500..1500 : forest / dark green
      //   1500..2500: rock (alpine slopes)
      //   2500+     : snow (peaks above the snow line)
      const mat = makeNode("TerrainMaterial", 280, 80, {
        // band 1: grass valleys (bright spring green)
        color1R: 0.36, color1G: 0.58, color1B: 0.26, alt1: 2,
        // band 2: forest / mid-altitude (darker green)
        color2R: 0.26, color2G: 0.40, color2B: 0.18, alt2: 6,
        // band 3: alpine rock (warm gray)
        color3R: 0.48, color3G: 0.42, color3B: 0.36, alt3: 10,
        // band 4: snow caps (cool white)
        color4R: 0.94, color4G: 0.96, color4B: 0.98,
        softness: 2.0, slopeRockiness: 2.5,
        shininess: 6, ambient: 0.22, vertexMix: 0.0,
        detailScale: 0.4, detailStrength: 0.25,
        microScale: 2.0, microStrength: 0.15,
        edgeJitter: 1.0, bumpStrength: 0.3, snowMaskAmount: 0.85
      });
      // FPCamera in WALK mode -- posY auto-clamps to (terrainHeight
      // + eyeHeight). Spawn at world (0, 100, 0); the first tick
      // resolves the actual ground Y at origin and snaps the player
      // onto it. far=8000 covers the 6.4km disc + 3km vertical
      // (distance to far peaks ≈ sqrt(3200² + 3000²) ≈ 4.4km).
      const cam = makeNode("FPCamera", 520, 80, {
        posX: 0, posY: 100, posZ: 0,
        yaw: 0, pitch: 0.02,
        // far=15000m exceeds the 5km radius + 3km vertical max
        // distance (sqrt(5000² + 3000²) ≈ 5830m) by ~3x for a clear
        // horizon. 20/20 vision can resolve mountains 50km+ in
        // perfect conditions; we cap at 15km for memory + a bit of
        // distance haze flavor.
        fov: 70, near: 0.5, far: 25000,
        walkMode: 1,
        walkSpeed: 14, lookSpeed: 2.2,
        mouseSensitivity: 0.0025, eyeHeight: 1.7
      });
      const light = makeNode("DirectionalLight", 40, 280, {
        dirX: 0.4, dirY: 0.85, dirZ: 0.3,
        colorR: 1.0, colorG: 0.94, colorB: 0.82,
        intensity: 1.3
      });
      const scn = makeNode("Scene", 760, 80, {
        clearR: 0.62, clearG: 0.75, clearB: 0.88
      });
      // §5.5.e-7 MotionBlur smooths fast camera turns / chunk pop-in.
      // amount=0.30 is light -- noticeable on quick sweeps, invisible
      // on slow movement. Crank to 0.6+ for stylized "speed-feel".
      const mb = makeNode("MotionBlur", 940, 80, { amount: 0.30 });
      const vo = makeNode("VisualOutput", 1140, 80, { display: 0 });
      // §5.5.e-4 Minimap HUD node. Renders the actual terrain top-
      // down (heightmap colored by altitude) + camera dot + heading
      // into a fixed-position overlay. Multiple HUD nodes will share
      // this pattern -- drop a node into the patch to enable, remove
      // to hide. Range=1 matches the terrain's visible disc; >1 shows
      // more world (zoomed out), <1 zooms in.
      const map = makeNode("Minimap", 280, 280, {
        corner: "top-right",
        size: 200,
        margin: 18,
        range: 1.2
      });

      state.edges.push({ from: { node: ter, port: "mesh"   }, to: { node: mat, port: "mesh"   } });
      state.edges.push({ from: { node: mat, port: "mesh"   }, to: { node: scn, port: "mesh1"  } });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light"} , to: { node: scn, port: "light1" } });
      state.edges.push({ from: { node: scn, port: "out"    }, to: { node: mb,  port: "in"     } });
      state.edges.push({ from: { node: mb,  port: "out"    }, to: { node: vo,  port: "in"     } });
      // §5.5.g -- Minimap.hud → Scene.hud1: makes the minimap "belong"
      // to this Scene. The overlay only renders when this wire exists
      // (and we're in live mode + this Scene is feeding a VisualOutput).
      state.edges.push({ from: { node: map, port: "hud"    }, to: { node: scn, port: "hud1"   } });
    }
  },

  /* Phase 7 §5.5.e-11 — Archipelago Islands. Demo of TiledTerrain's
   * archipelago mode: low-frequency noise mask gives multiple
   * distinct islands you can walk between (on the ocean floor for
   * now -- swimming arrives with the Water node). Smaller per-
   * island terrain (height 1500m, frequency tuned for ~1.5km
   * features so islands have visible peaks + valleys). Minimap
   * shows the island silhouettes against ocean blue. */
  {
    id: "scene-archipelago-islands",
    name: "Archipelago Islands",
    sub: "multiple islands · noise-mask coast",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-arch-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"    stop-color="rgba(110, 160, 210, 1)"/>
          <stop offset="0.7"  stop-color="rgba(180, 210, 230, 1)"/>
          <stop offset="1"    stop-color="rgba(220, 220, 200, 1)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-arch-sky)"/>
      <rect x="0" y="28" width="100" height="16" fill="rgba(35, 75, 120, 0.85)"/>
      <polygon points="10,28 22,18 34,26 30,28" fill="rgba(80,110,75,0.92)"/>
      <polygon points="42,28 55,14 70,22 76,28" fill="rgba(60,95,65,0.92)"/>
      <polygon points="78,28 88,22 96,26 96,28" fill="rgba(80,110,75,0.92)"/>
      <polygon points="55,14 58,12 62,18" fill="rgba(240,240,250,0.9)"/>
      <rect x="76" y="2" width="22" height="22" fill="rgba(10,16,28,0.85)" stroke="rgba(110,220,180,0.6)" stroke-width="0.4"/>
      <rect x="78" y="6"  width="3" height="3" fill="rgba(80,110,75,0.7)"/>
      <rect x="85" y="14" width="6" height="3" fill="rgba(80,110,75,0.7)"/>
      <rect x="91" y="9"  width="3" height="3" fill="rgba(80,110,75,0.7)"/>
      <circle cx="87" cy="13" r="1.4" fill="rgba(255,220,90,1)"/>
    </svg>`,
    build: () => {
      // Archipelago: islandMode="archipelago" + a low-freq noise
      // mask defines island vs ocean. heightScale=1500m gives
      // visible-from-distance peaks without towering over the sea.
      // yOffset=1500 puts island peaks at +1500m, valleys at sea
      // level. sinkDepth=1700 sinks the ocean floor to -200m so
      // the player walks at -200m+1.7m=-198m on the ocean floor
      // between islands. islandMaskFreq=0.00012 ~ one mask cycle
      // per 8km -> several distinct islands in the visible disc.
      const ter = makeNode("TiledTerrain", 40, 80, {
        chunkSize:   256,
        chunkRadius: 32,
        segments:    24,
        // §5.5.h-2 -- bigger more-distinct islands, deeper ocean.
        // heightScale=1200 + yOffset=1500 → island terrain spans
        // +300m (coastal valleys) to +1500m (peaks). sinkDepth=3000
        // → ocean basin floor at -1500m, so swimming between islands
        // means crossing a real deep-water gap.
        heightScale: 1200,
        yOffset:     1500,
        seed:        13.7,
        frequency:   0.0008,    // 1 feature per ~1.2km within an island
        octaves:     5,
        lacunarity:  2.05,
        gain:        0.5,
        ridges:      0.45,
        plateau:     0.4,
        forwardBias: 0.2,
        erosionThermal:    0.7,
        erosionHydraulic:  0.55,
        erosionTalus:      0.02,
        erosionIterations: 4,
        erosionRadius:     80,
        erosionStrength:   0.55,
        islandMode:          "archipelago",
        // §planet-spec Phase 3 -- continental-scale mask. Old 0.0003
        // (3km island periods) is replaced by 0.000003 (333km
        // continent periods). The TiledTerrain fbm noise itself
        // stays at 0.0008 (archipelago-scale variation), so within
        // a continent you still see undulating terrain at km scale;
        // the LARGE-SCALE shape (land vs ocean across hundreds of
        // km) is what's now driven by a continental-frequency mask.
        // Seed 1.2 puts (0,0) on land (mask~0.71) regardless of
        // freq (mask at origin is just hash(0,0,seed)), so spawn is
        // still on a continent. From orbit the horizon impostor's
        // low-octave noise reveals the continent silhouettes.
        islandMaskFreq:      0.000003,
        islandMaskSeed:      1.2,
        islandMaskThreshold: 0.50,
        // §5.5.h-11 -- wider softness (was 0.06). Combined with the new
        // f^2 coastal peak squash this gives islands a long gentle
        // slope from coast to interior, with broad shallow-water
        // bands and room for proper beaches.
        islandMaskSoftness:  0.20,
        islandSinkDepth:     3000,
        // §5.5.h-10 -- bigger and more aggressive beaches. Strength 1.0
        // gives full flattening to the beach plane where beach noise is
        // high; freq=0.00035 (period ~2.9km) widens individual beach
        // patches to about a kilometer across, so they read as actual
        // beaches rather than narrow sand strips.
        islandBeachStrength: 1.0,
        islandBeachFreq:     0.00035,
        anchorMode:  "auto"
      });
      // Material: same band defaults as Walkable Terrain but with
      // lower alts since this terrain is shorter (max ~1500m).
      // bandScale = heightScale/12 = 125, so alt=2 -> 250m,
      // alt=4 -> 500m, alt=8 -> 1000m. Snow above ~1000m.
      const mat = makeNode("TerrainMaterial", 280, 80, {
        color1R: 0.78, color1G: 0.72, color1B: 0.52, alt1: 2,   // shore sand at low altitudes
        color2R: 0.36, color2G: 0.58, color2B: 0.26, alt2: 4,   // grass
        color3R: 0.48, color3G: 0.42, color3B: 0.36, alt3: 8,   // rock
        color4R: 0.94, color4G: 0.96, color4B: 0.98,            // snow
        softness: 1.5, slopeRockiness: 2.0,
        shininess: 6, ambient: 0.22, vertexMix: 0.0,
        detailScale: 0.4, detailStrength: 0.20,
        microScale: 2.0, microStrength: 0.12,
        edgeJitter: 0.8, bumpStrength: 0.25, snowMaskAmount: 0.85
      });
      // FPCamera. With islandMaskSeed=2.0 the mask at (0,0) is ~0.52
      // (just above threshold=0.5), so the spawn sits on coastal land
      // with water in clear view. pitch=-0.18 (~10° down) so the
      // player looks at the sea-level water surface immediately on
      // entering live mode. Fly mode (walkMode=0) so the user can
      // hop between islands without having to walk the ocean floor.
      const cam = makeNode("FPCamera", 520, 80, {
        // §5.5.h-25 -- start above the highest expected island peak
        // at spawn (yOff=1500 + peak height varies with island mask)
        // so the player doesn't load inside terrain.
        posX: 0, posY: 1700, posZ: 0,
        yaw: 0, pitch: -0.18,
        // §planet-spec Phase 5+ -- far plane 100,000 km (~16 Earth
        // radii) covers the entire Planet from any altitude up to
        // geostationary orbit. With reverse-Z + depth32float this is
        // essentially free precision-wise (depth precision is
        // concentrated at the near plane; far plane scaling has no
        // cost in our setup). The old far=2000km clipped the planet's
        // visible cap edge at altitudes >~500km, which is what made
        // the planet "fade to black" rather than show as a sphere.
        fov: 70, near: 0.5, far: 100000000,
        walkMode: 0,
        // §5.5.h-27 -- fast initial fly speed. Hold X in-game to
        // crank further (4×/sec geometric ramp, up to 50 km/s cap)
        // or Z to slow down. With walkSpeed=500 the user reaches
        // 20km altitude (curve fully on) in ~10 seconds without
        // even pressing X.
        walkSpeed: 500, lookSpeed: 2.2,
        mouseSensitivity: 0.0025, eyeHeight: 1.7
      });
      // §5.5.h-10 -- Sun + ProceduralSky replace the static
      // DirectionalLight. timeOfDay=0.42 is late morning -- sun high
      // enough for bright lighting but angled enough that beaches cast
      // visible shadows. turbidity 1.3 = slight tropical haze on the
      // horizon. cloudCoverage 0.35 = partly cloudy, drifting slowly.
      const sun = makeNode("Sun", 40, 280, {
        timeOfDay: 0.42,
        tintR: 1.0, tintG: 0.96, tintB: 0.88,
        intensityScale: 1.2
      });
      // §5.5.h-14 -- ProceduralSky no longer renders clouds (cloud
      // coverage=0); they're now a real mesh node (Clouds3D) so they
      // sit at a fixed world altitude with proper geometric parallax.
      const sky = makeNode("ProceduralSky", 220, 280, {
        timeOfDay: 0.42,
        turbidity: 1.3,
        mieG: 0.78,
        intensity: 1.0,
        cloudCoverage: 0.0,
        cloudDensity: 0.0,
        windSpeedX: 0.0,
        windSpeedZ: 0.0
      });
      // §5.5.h-14 -- volumetric-ish 3D clouds at world Y=2500. Real
      // mesh so the standard projection pipeline handles parallax
      // (under both translation AND rotation) without any of the
      // angular-distortion games the sky-pass shell had to play.
      // §planet-spec Phase 4.e -- Planet replaces the TerrainHorizon
      // impostor. Earth radius (6.378e6 m) centered at (0, -R - 5000)
      // so Planet's surface near spawn is at y=-5000 -- 5km below
      // local sea level. That puts the entire Planet mesh BELOW
      // TiledTerrain's ocean basin (lowest point y=-1500), so from
      // ground level the ocean basin occludes Planet and there's no
      // z-fighting between Planet's continents and the local archipelago.
      //
      // From altitude (past the chunked-disc edge), Planet shows the
      // global curving ocean + ~200m continent reliefs as far horizon
      // detail. From orbit you see the whole planet's continent
      // layout via the per-vertex color palette baked from the same
      // h ∈ [0,1] used for displacement.
      //
      // frequency 5e-7 → ~13000km wavelength (planet circumference
      // 40075km, ~3 continents per great circle). seed 7.3, seaLevel
      // 0.45 = mild land bias.
      const PLANET_R = 6378000;
      const PLANET_POL = 0.9966;     // WGS84 Earth flattening
      const horizon = makeNode("Planet", 280, 680, {
        radius:           PLANET_R,
        polarRadiusRatio: PLANET_POL,
        centerX:          0,
        // §planet-spec Phase 5+ -- Planet's POLE (not center) aligned
        // with world Y=0. For an oblate spheroid the pole sits at
        // center + R*polRatio (not center+R), so centerY must compensate
        // by polRatio to put the pole at world Y=0. With polRatio=0.9966
        // and R=6378km, that's a 21km correction vs centerY=-R.
        // Without this, the spawn projection landed at Y=-19991 ("20km
        // below sea level" bug).
        centerY:          -PLANET_R * PLANET_POL,
        centerZ:          0,
        segments:         16,
        maxDepth:         9,           // ≈ 25km per leaf at the camera-facing point
        splitFactor:      5.0,
        // §planet-spec Phase 5+ -- bumped contrast for legibility from
        // orbit. heightScale 3000 puts continent peaks at ~3km above
        // sea level (still well below TiledTerrain's 1500m spawn so
        // local terrain dominates at ground level). seaLevel 0.42 →
        // ~58% land, gives clearly recognisable continent shapes.
        // ridges 0.6 sharpens mountain spines so they read as ranges
        // rather than blobs at planet scale.
        heightScale:      3000,
        seaLevel:         0.42,
        seed:             7.3,
        frequency:        5e-7,
        octaves:          5,
        lacunarity:       2.0,
        gain:             0.5,
        ridges:           0.6
      });
      const clouds = makeNode("Clouds3D", 40, 680, {
        // §5.5.h-18 -- chunked cloud streaming with rounded tops AND
        // bottoms. 1.8km chunks × 21×21 disc -> 38km visible cloud
        // area. 28 segments per chunk at inner LOD = ~64m per vertex,
        // way finer detail than the old single-mesh build could afford.
        // §planet-spec Phase 2-batch -- chunkRadius bumped 5 -> 10
        // so the cloud layer doesn't shrink to a small disc beneath
        // the camera at 20km+ altitudes.
        altitude:    2500,
        puffHeight:  650,
        bottomRound: 0.7,
        chunkSize:   1800,
        chunkRadius: 10,
        segments:    28,
        coverage:    0.45,
        density:     1.0,
        scale:       0.0008,
        seed:        11.3,
        colorR:      1.0, colorG: 1.0, colorB: 1.0
      });
      const scn = makeNode("Scene", 760, 80, {
        // ProceduralSky drives the visible background -- clear color is
        // a fallback for when the env wire is missing.
        clearR: 0.62, clearG: 0.75, clearB: 0.88
      });
      const mb = makeNode("MotionBlur", 940, 80, { amount: 0.30 });
      const vo = makeNode("VisualOutput", 1140, 80, { display: 0 });
      const map = makeNode("Minimap", 280, 280, {
        corner: "top-right",
        size: 220,
        margin: 18,
        range: 1.4               // zoomed out a bit so multiple islands fit
      });
      // §5.5.h-27 -- altitude readout so the user can tell when
      // they're at curve altitude (curveAltLow=1km in this demo)
      // or space (80km+). Plus hint for X/Z speed adjust.
      const alt = makeNode("Altimeter", 280, 480, {
        corner:    "top-left",
        margin:    18,
        opacity:   0.92,
        showSpeed: 1
      });
      // §5.5.h-4 Water. With LOD-matched bilinear sampling in
      // fs_water, the depth field now matches the rendered mesh
      // exactly -- no need to widen foam to hide mismatch. Back to
      // tighter realistic defaults.
      const water = makeNode("Water", 40, 480, {
        seaLevel: 0,
        colorR: 0.10, colorG: 0.32, colorB: 0.48,
        waveFreq: 0.012, waveSpeed: 0.6, waveAmp: 1.0,
        fresnelStrength: 1.0,
        skyR: 0.62, skyG: 0.78, skyB: 0.92,
        // §5.5.h-9 -- wider foam + much deeper shallow band so the
        // turquoise shallow tint reads clearly from far away.
        foamWidth: 18,
        shallowDepth: 220,
        waveShoreFreq: 0.018,
        foamR: 0.96, foamG: 0.97, foamB: 1.00
      });

      state.edges.push({ from: { node: ter, port: "mesh"   }, to: { node: mat, port: "mesh"   } });
      state.edges.push({ from: { node: mat, port: "mesh"   }, to: { node: scn, port: "mesh1"  } });
      // Water as a second mesh slot. No material wire needed -- the
      // Water node bakes fs_water into the encoder when its mesh
      // hits a Scene slot.
      state.edges.push({ from: { node: water,  port: "mesh" }, to: { node: scn, port: "mesh2" } });
      // §5.5.h-14 -- Clouds3D as a third mesh slot. Like Water, the
      // node bakes fs_clouds into the encoder; no Material wire.
      state.edges.push({ from: { node: clouds, port: "mesh" }, to: { node: scn, port: "mesh3" } });
      // §planet-spec Phase 4.e -- Planet as the fourth mesh slot
      // (variable named `horizon` for continuity with the old wiring;
      // the geometry is now a real cube-sphere quadtree, not the old
      // flat-plane impostor). Renders unlit-vc with the terrain
      // palette baked into vertex colors.
      state.edges.push({ from: { node: horizon, port: "mesh" }, to: { node: scn, port: "mesh4" } });
      // §5.5.h-5 -- explicit terrain reference wire. Water's
      // heightmap input takes a TiledTerrain reference so the
      // shader can sample the same LOD-discretized field the
      // rendered terrain mesh uses. Without this wire the foam
      // disabled (open ocean everywhere).
      state.edges.push({ from: { node: ter, port: "heightmap" }, to: { node: water, port: "heightmap" } });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: sun, port: "light"} ,  to: { node: scn, port: "light1" } });
      state.edges.push({ from: { node: sky, port: "env"   } , to: { node: scn, port: "environment" } });
      // §5.5.h-22 -- post chain: Scene -> MotionBlur -> Underwater
      // -> VisualOutput. Underwater is a zero-cost pass-through above
      // sea level; when the camera dives below it kicks in with a
      // blue tint, depth fog, and subtle UV wobble for the "you're
      // submerged" look.
      const uw = makeNode("Underwater", 1040, 80, {
        seaLevel:   0,
        tintR:      0.06, tintG: 0.24, tintB: 0.36,
        fogDensity: 0.95,
        maxDepth:   60
      });
      state.edges.push({ from: { node: scn, port: "out" }, to: { node: mb,  port: "in"  } });
      state.edges.push({ from: { node: mb,  port: "out" }, to: { node: uw,  port: "in"  } });
      state.edges.push({ from: { node: uw,  port: "out" }, to: { node: vo,  port: "in"  } });
      state.edges.push({ from: { node: map, port: "hud" }, to: { node: scn, port: "hud1" } });
      state.edges.push({ from: { node: alt, port: "hud" }, to: { node: scn, port: "hud2" } });
    }
  },

  /* planet-spec Phase 4.a -- Planet preview. The spherified-cube
   * primitive (no height yet, no LOD) orbited by a camera so the
   * shape reads as a sphere with visible per-face grid lines via
   * the normal-as-RGB vertex color. Foundation for the foot-to-orbit
   * planet that will replace TerrainHorizon. */
  {
    id: "scene-planet-preview",
    name: "Planet (preview)",
    sub: "spherified cube + fBm + LOD",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-planet-prev" cx="0.5" cy="0.45" r="0.55">
          <stop offset="0"    stop-color="rgba(200, 230, 255, 1)"/>
          <stop offset="0.6"  stop-color="rgba(110, 170, 220, 1)"/>
          <stop offset="1"    stop-color="rgba(20, 40, 80, 1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(4, 8, 18, 1)"/>
      <circle cx="50" cy="22" r="16" fill="url(#dg-planet-prev)"/>
      <!-- a few latitude lines suggesting the cube-grid -->
      <ellipse cx="50" cy="22" rx="16" ry="4" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="0.4"/>
      <ellipse cx="50" cy="22" rx="14" ry="13" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.4"/>
      <line x1="34" y1="22" x2="66" y2="22" stroke="rgba(255,255,255,0.18)" stroke-width="0.4"/>
    </svg>`,
    build: () => {
      // Phase 4.c -- per-face quadtree LOD. Radius bumped to 50 (vs
      // 5 in 4.b) so the LOD ramp has room to operate: chunks near
      // the camera-facing point split to maxDepth=6 while back-face
      // chunks stay at depth=0 (one cube face = one chunk). Camera
      // orbits at radius * 2.4 = 120.
      const RADIUS = 50;
      const planet = makeNode("Planet",     40,  80, {
        radius:      RADIUS,
        segments:    16,         // verts/chunk side; 17² = 289 per chunk
        maxDepth:    6,
        splitFactor: 5.0,
        heightScale: 5.0,        // 10% of radius
        seaLevel:    0.5,
        seed:        7.3,
        frequency:   0.7,
        octaves:     7,
        lacunarity:  2.0,
        gain:        0.5,
        ridges:      0.35
      });
      const clk    = makeNode("MasterClock",    40, 220, { bpm: 12 });
      const mulTau = makeNode("Mul",           240, 220, { b: 6.283185307 });
      const sinN   = makeNode("Sin",           420, 180);
      const cosN   = makeNode("Cos",           420, 280);
      const mulRx  = makeNode("Mul",           580, 180, { b: RADIUS * 2.4 });
      const mulRz  = makeNode("Mul",           580, 280, { b: RADIUS * 2.4 });
      const cam    = makeNode("Camera",         40, 420, {
        posX: 0, posY: RADIUS * 0.4, posZ: 0,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 50, near: 0.1, far: 1000, mode: 0
      });
      const scn    = makeNode("Scene",         780, 200, {
        clearR: 0.015, clearG: 0.022, clearB: 0.045
      });
      const vo     = makeNode("VisualOutput", 1020, 200, { display: 0 });

      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulTau, port: "a"   } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinN,   port: "in"  } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: cosN,   port: "in"  } });
      state.edges.push({ from: { node: sinN,   port: "out"   }, to: { node: mulRx,  port: "a"   } });
      state.edges.push({ from: { node: cosN,   port: "out"   }, to: { node: mulRz,  port: "a"   } });
      state.edges.push({ from: { node: mulRx,  port: "out"   }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulRz,  port: "out"   }, to: { node: cam,    port: "posZ" } });
      state.edges.push({ from: { node: planet, port: "mesh"   }, to: { node: scn,   port: "mesh1" } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: scn,   port: "camera" } });
      state.edges.push({ from: { node: scn,    port: "out"    }, to: { node: vo,    port: "in"     } });
    }
  },

  /* §planet-spec Phase 6 -- Foot-to-Orbit Planet demo. The unified
   * cube-sphere architecture's "look": one Planet node providing
   * everything from meter-scale ground terrain (deep quadtree LOD
   * under the camera) to the global view from orbit. No TiledTerrain,
   * no Water node, no separate Clouds3D. FPCamera walk-mode locks to
   * Planet's heightfield via _fpcSampleGroundY's planet fallback so
   * you actually walk on the spherical surface. Fly up to orbit and
   * the same surface curves into a sphere with the same continents. */
  {
    id: "scene-planet-foot-to-orbit",
    name: "Foot-to-Orbit Planet",
    sub: "Planet only · walk on sphere · fly to orbit",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-fto-planet" cx="0.5" cy="0.45" r="0.6">
          <stop offset="0"    stop-color="rgba(150, 200, 130, 1)"/>
          <stop offset="0.45" stop-color="rgba(110, 150, 90, 1)"/>
          <stop offset="0.7"  stop-color="rgba(60, 110, 160, 1)"/>
          <stop offset="1"    stop-color="rgba(10, 20, 50, 1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(2, 6, 14, 1)"/>
      <!-- a few stars -->
      <circle cx="12" cy="8"  r="0.5" fill="rgba(255,255,255,0.9)"/>
      <circle cx="84" cy="10" r="0.4" fill="rgba(255,235,200,0.8)"/>
      <circle cx="92" cy="22" r="0.5" fill="rgba(220,235,255,0.9)"/>
      <circle cx="8"  cy="32" r="0.4" fill="rgba(255,250,220,0.8)"/>
      <!-- planet -->
      <circle cx="50" cy="22" r="18" fill="url(#dg-fto-planet)"/>
      <!-- continent suggestions -->
      <path d="M 40 18 Q 46 14 52 17 Q 56 20 50 24 Q 44 25 40 18" fill="rgba(80,120,60,0.6)"/>
      <path d="M 58 26 Q 64 28 63 32 Q 56 30 58 26" fill="rgba(80,120,60,0.55)"/>
      <!-- person standing on edge -->
      <circle cx="50" cy="3.5" r="0.8" fill="rgba(255,240,210,1)"/>
      <line x1="50" y1="4.3" x2="50" y2="5.5" stroke="rgba(255,240,210,1)" stroke-width="0.4"/>
    </svg>`,
    build: () => {
      // Earth-scale planet centered so its POLE sits at world Y=0
      // (because polRatio < 1 compresses the surface on Y). With this
      // alignment, the FPCamera spawned at world (0, h, 0) is at
      // altitude h above the planet's pole surface; _fpcSampleGroundY
      // queries Planet directly when there's no TiledTerrain in the
      // patch, so walk mode locks the player to the spherical surface.
      const PLANET_R   = 6378000;
      const PLANET_POL = 0.9966;
      // §planet-spec Phase 7.d-azgaar -- PlanetMesh replaces Planet
      // here. Reads PlanetMap's cell graph directly, one mesh vertex
      // per cell. Each peak cell IS a vertex with its own elevation
      // (no cubemap-bake smoothing). Mirrors Azgaar's 3D scene mode.
      // Drawback: no chunking, no LOD -- the whole planet is one mesh
      // with ~60k verts. Fine for orbital views; not for foot-level
      // detail (each triangle is ~130km wide). Use Planet (chunked,
      // cubemap-backed) for foot-level scenarios when those exist.
      const planet = makeNode("PlanetMesh", 40, 80, {
        radius:           PLANET_R,
        polarRadiusRatio: PLANET_POL,
        centerX:          0,
        centerY:          -PLANET_R * PLANET_POL,
        centerZ:          0,
        // Sprint 10-5b-fix v2: back to realistic 10000 per user. Earth-
        // scale Everest is 8848 m; 10000 m heightScale puts the highest
        // chunk vertex at ~7.4 km above sea level (zoom-3 DEM smoothing
        // means we never see the actual 8848 m peak). Mountains will
        // read flat from orbit -- ground-level DEM tiles (sprint 10-6)
        // are what'll restore foot-level relief. Until then this is
        // 'looks like Earth from space' but not 'dramatic mountains.'
        heightScale:      10000,
        // Sprint 10-5b-fix v3: seaLevel 0.55 -> 0.5 to match the DEM
        // mapping. _earthElevationAt puts m=0 (real sea level) at
        // normalized elev=0.5, so seaLevel=0.5 = the cubemap and the
        // render-side ocean/land threshold agree. 0.55 drowned every
        // pixel below ~885 m: Amazon basin, most of Africa, Himalayan
        // foothills all rendered as ocean even though they're land.
        seaLevel:         0.5,
        // §bonus-quality-restore (2026-05-25) -- AGL-correct horizon
        // cull + clamp shipped (foot-11/12). Visible chunk count is
        // now driven by actual visibility, not over-counted far-side
        // chunks. Restoring quality:
        //   segments    16 → 32   (4× denser mesh per chunk: 1089
        //                          verts vs 289; smoother silhouettes
        //                          at close range)
        //   maxDepth    16 → 18   (4× deeper subdivide: ~38 m wide
        //                          chunks at deepest, vs 152 m before;
        //                          much sharper near-camera triangles)
        //   splitFactor 2.5 → 3.5 (40% larger subdivision radius;
        //                          smoother LOD blend)
        // Crank back to 64/20/5 in a future sprint when SVT
        // generation moves to a Worker. Current values are the
        // "looks great + 60 fps at foot" sweet spot.
        segments:         32,
        maxDepth:         18,
        splitFactor:      3.5,
        subdivide:        1  // one Loop subdivision pass -- smooths cell-faceting
      });

      // Late-morning Sun + ProceduralSky -- same setup as the
      // archipelago demo so the lighting reads similarly.
      const sun = makeNode("Sun", 40, 280, {
        timeOfDay: 0.42,
        tintR: 1.0, tintG: 0.96, tintB: 0.88,
        intensityScale: 1.2
      });
      const sky = makeNode("ProceduralSky", 220, 280, {
        timeOfDay: 0.42,
        turbidity: 1.3,
        cloudCoverage: 0
      });

      // §planet-spec Phase 7.h-overhaul -- spawn at the EQUATOR, not
      // the pole. Position: 100km altitude above (lon 0°, lat 0°),
      // which on this planet (centered at world y = -PLANET_R * POL,
      // north pole at world y=0) lands at world (PLANET_R + 100km,
      // -PLANET_R * POL, 0).
      //
      // Orientation set explicitly via target + upX/Y/Z so the new
      // 6DoF flight-mode tick uses it directly (no yaw/pitch
      // derivation). Looking east tangent to the equator with a 20°
      // downward tilt toward the planet (-X). Camera-up = radial
      // outward + same 20° tilt to stay perpendicular to forward.
      // Once on the planet, U/O roll, IJKL pitch/yaw, Space/Ctrl
      // move you radially up/down regardless of camera tilt.
      const EQUATOR_ALT = 100000;
      const EQUATOR_X = PLANET_R + EQUATOR_ALT;
      const EQUATOR_Y = -PLANET_R * PLANET_POL;
      const TILT = 0.35;
      const FWD_X = -Math.sin(TILT), FWD_Z = Math.cos(TILT);
      const UP_X  =  Math.cos(TILT), UP_Z  = Math.sin(TILT);
      const cam = makeNode("FPCamera", 520, 80, {
        posX:    EQUATOR_X, posY: EQUATOR_Y, posZ: 0,
        targetX: EQUATOR_X + FWD_X, targetY: EQUATOR_Y, targetZ: FWD_Z,
        upX:     UP_X,      upY:  0,         upZ:  UP_Z,
        fov: 70, near: 0.5, far: 100000000,
        walkMode: 0,
        walkSpeed: 2000, lookSpeed: 2.2,
        mouseSensitivity: 0.0025, eyeHeight: 1.7
      });

      // §planet-spec Phase 6+ (water) -- Water node auto-detects Planet
      // and emits a 4000km × 4000km subdivided mesh (65² = 4225 verts)
      // projected onto the sphere, centered on camera XZ. fs_water
      // handles waves + foam + sky-Fresnel reflection. Beyond the
      // water mesh's extent, Planet's own h<seaLevel ocean cells
      // continue the surface at the same Y -- the boundary is invisible.
      // §planet-spec Phase 7.d follow-up -- Water removed from this
      // demo for now. The Water mesh (sphere shell at seaLevel) clips
      // against Planet's per-cell elevation in a visible polkadot
      // pattern when seaLevel is raised above 0; at seaLevel=0 it
      // z-fights Planet's own h<seaLevel ocean cells. The proper fix
      // is a fs_water shader-side discard (sample Planet's heightmap
      // per-fragment, only render where Planet.h < seaLevel) -- bigger
      // pipeline change, deferred. Planet's own blue ocean cells fill
      // in the ocean look in the meantime.

      // §planet-spec Phase 7.a -- PlanetMap node owns a 6-face cubemap
      // of normalized heights baked from the same 3D fBm Planet would
      // sample directly. Wired into Planet's heightmap input below;
      // Planet now reads from this texture instead of running fBm
      // per-vertex. Visual is unchanged on first load (proves the
      // data flow); Phase 7.d painter will then make the cubemap
      // editable and the planet's terrain follows.
      //
      // Noise params MUST match Planet's params or the bake won't
      // line up with what Planet would have computed -- the visible
      // would shift even though the field is the same fBm function.
      const pmap = makeNode("PlanetMap", 40, 580, {
        resolution: 512,                  // 512² × 6 = 1.5M texels (~3MB R16 in .gpatch)
        cellCount:  240000,               // ~46km arc per cell at Earth scale; 4× density vs old 60k. Loop subdivision then takes it to ~960k verts on the mesh -- color resolution comparable to a 512² cubemap. First-load triangulation takes 5-6 sec.
        seed:       3.7,
        // PlanetMap samples noise in UNIT-SPHERE space (cells are
        // points on the unit sphere, max coord = 1). Old freq=5e-7
        // was the Planet-node convention for WORLD-space coords
        // (Earth-radius scale); at unit-sphere scale that wavelength
        // is 2 million units = the entire sphere fits inside one
        // noise lattice cell = nearly constant elevation everywhere.
        // freq=1.5 gives ~3 continents per great circle on the unit
        // sphere. octaves=7 with lacunarity=2 means highest octave
        // wavelength ≈ 0.012 (per cell), matches the cell density.
        frequency:  1.5,
        octaves:    7,
        lacunarity: 2.0,
        gain:       0.5,
        ridges:     0.55,
        jitter:     0.4                  // perturb Fibonacci positions for organic Voronoi boundaries
      });

      const scn = makeNode("Scene", 760, 80, {
        clearR: 0.02, clearG: 0.03, clearB: 0.06
      });
      const alt = makeNode("Altimeter", 280, 480, {
        corner:    "top-left",
        margin:    18,
        opacity:   0.92,
        showSpeed: 1
      });
      const map = makeNode("Minimap", 280, 680, {
        corner:  "top-right",
        size:    220,
        margin:  18,
        opacity: 0.92,
        range:   1.0
      });
      const vo  = makeNode("VisualOutput", 1140, 80, { display: 0 });

      // Phase 8 sprint 8-7b: the camera-anchored fine-detail patch
      // is now folded into PlanetMesh (auto-rendered alongside the
      // coarse mesh). Sprint 8-7's separate PlanetDetailPatch node
      // was awkward extra graph wiring; users only need to enable
      // / configure via PlanetMesh.detailPatch* params now.

      state.edges.push({ from: { node: pmap,   port: "heightmap" }, to: { node: planet, port: "heightmap" } });
      state.edges.push({ from: { node: planet, port: "mesh"   }, to: { node: scn, port: "mesh1" } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: sun,    port: "light"  }, to: { node: scn, port: "light1" } });
      state.edges.push({ from: { node: sky,    port: "env"    }, to: { node: scn, port: "environment" } });
      state.edges.push({ from: { node: scn,    port: "out"    }, to: { node: vo,  port: "in"     } });
      state.edges.push({ from: { node: alt,    port: "hud"    }, to: { node: scn, port: "hud1" } });
      state.edges.push({ from: { node: map,    port: "hud"    }, to: { node: scn, port: "hud2" } });
    }
  },

  /* Phase 7 §5.5.c-2 — Triplanar Terrain. Showcase for the
   * texture-triplanar ShaderMat preset: ProceduralTerrain emits a
   * high-frequency noise field as a texture, ShaderMat projects
   * it onto the Terrain mesh via three world-axis planes blended
   * by the surface normal. Cliffs, ridges, and flat ground all
   * pick up the texture without UV stretching -- the classic
   * solve for terrain texturing.
   *
   * ProceduralTerrain params are tuned for a rocky-texture feel
   * (higher frequency than the Terrain's own noise, more ridges)
   * rather than for landscape shape -- you're using it as a noise
   * source, not as the heightmap. */
  {
    id: "scene-terrain-triplanar",
    name: "Triplanar Terrain",
    sub: "procedural noise · world-axis projection",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-tri-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"    stop-color="rgba(140, 160, 200, 1)"/>
          <stop offset="1"    stop-color="rgba(210, 195, 170, 1)"/>
        </linearGradient>
        <pattern id="dg-tri-rock" patternUnits="userSpaceOnUse" width="6" height="6"
                 patternTransform="rotate(15)">
          <rect width="6" height="6" fill="rgba(95, 78, 68, 1)"/>
          <circle cx="2" cy="2" r="1.2" fill="rgba(70, 58, 52, 1)"/>
          <circle cx="4.5" cy="4.5" r="0.8" fill="rgba(125, 105, 92, 1)"/>
        </pattern>
      </defs>
      <rect width="100" height="44" fill="url(#dg-tri-sky)"/>
      <!-- Sky-side mountain silhouettes (textured) -->
      <polygon points="0,32 14,18 28,26 42,12 56,22 70,18 84,26 100,30 100,44 0,44"
               fill="url(#dg-tri-rock)" stroke="rgba(45, 35, 30, 0.6)" stroke-width="0.5"/>
      <!-- Highlight texture seam at the peak -->
      <path d="M 42 12 L 38 22 L 46 20 Z" fill="rgba(140, 115, 95, 0.8)"/>
      <!-- Sun glint -->
      <circle cx="80" cy="9" r="3" fill="rgba(255, 235, 190, 0.85)"/>
    </svg>`,
    build: () => {
      // The mesh: same Terrain shape as the basic terrain demo.
      const ter = makeNode("Terrain", 40, 40, {
        sizeMode:   "medium",
        worldSize:  100,
        heightScale: 12,
        yOffset:    0,
        segments:   96,
        seed:       7.42,
        frequency:  2.5,
        octaves:    6,
        lacunarity: 2.05,
        gain:       0.5,
        ridges:     0.35
      });
      // The texture source: a HIGHER-frequency ProceduralTerrain
      // (different seed) used purely as a noise pattern. Ridges
      // raised so the noise reads as cracked-rock veining instead
      // of soft fbm hills. Wired into ShaderMat.texture; the plan
      // walker auto-schedules its render into a scratch slot
      // before the Scene's pass, then the triplanar sampler reads
      // that scratch slot per fragment.
      const proc = makeNode("ProceduralTerrain", 40, 240, {
        seed:       12.5,
        frequency:  8.0,
        octaves:    6,
        lacunarity: 2.1,
        gain:       0.55,
        ridges:     0.65
      });
      // ShaderMat with the texture-triplanar preset (index 5).
      // freq reinterpreted as world scale: 0.06 = one wrap per
      // ~17 units, which lands ~5 wraps across the 100u terrain.
      // time reinterpreted as triplanar sharpness (4 = standard).
      // intensity scales overall brightness; r/g/b tints the
      // pattern toward warm-rock.
      const sm = makeNode("ShaderMat", 320, 40, {
        preset: 5,                  // texture-triplanar
        r: 0.78, g: 0.66, b: 0.52,
        time: 4.0,                  // sharpness
        freq: 0.06,                 // world scale
        intensity: 1.0
      });
      // Camera orbit -- same pattern as the basic Terrain demo so
      // the user can compare side-by-side.
      const clk    = makeNode("MasterClock", 40, 440, { bpm: 30 });
      const mulQ   = makeNode("Mul",        240, 440, { b: 0.03125 });
      const mulTau = makeNode("Mul",        420, 440, { b: 6.283185307 });
      const sinN   = makeNode("Sin",        600, 420);
      const cosN   = makeNode("Cos",        600, 500);
      const mulRx  = makeNode("Mul",        780, 420, { b: 50 });
      const mulRz  = makeNode("Mul",        780, 500, { b: 50 });
      const cam = makeNode("Camera", 980, 460, {
        posX: 0,  posY: 14, posZ: 50,
        targetX: 0, targetY: -2, targetZ: 0,
        fov: 55, near: 0.1, far: 500, mode: 0
      });
      const light = makeNode("DirectionalLight", 40, 620, {
        dirX: 0.4, dirY: 0.85, dirZ: 0.3,
        colorR: 1.0, colorG: 0.92, colorB: 0.78,
        intensity: 1.25
      });
      const scn = makeNode("Scene", 1200, 460, {
        clearR: 0.45, clearG: 0.62, clearB: 0.82
      });
      const vo  = makeNode("VisualOutput", 1440, 460, { display: 0 });

      // Mesh + material chain. ProceduralTerrain feeds the
      // ShaderMat's texture input (this is the wire that exercises
      // the triplanar preset's texture sampling).
      state.edges.push({ from: { node: ter,  port: "mesh" }, to: { node: sm,  port: "mesh"    } });
      state.edges.push({ from: { node: proc, port: "out"  }, to: { node: sm,  port: "texture" } });
      state.edges.push({ from: { node: sm,   port: "mesh" }, to: { node: scn, port: "mesh1"   } });
      // Camera orbit
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulQ,   port: "a" } });
      state.edges.push({ from: { node: mulQ,   port: "out"   }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinN,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: cosN,   port: "in" } });
      state.edges.push({ from: { node: sinN,   port: "out"   }, to: { node: mulRx,  port: "a" } });
      state.edges.push({ from: { node: cosN,   port: "out"   }, to: { node: mulRz,  port: "a" } });
      state.edges.push({ from: { node: mulRx,  port: "out"   }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulRz,  port: "out"   }, to: { node: cam,    port: "posZ" } });
      // Scene wiring
      state.edges.push({ from: { node: cam,   port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light"  }, to: { node: scn, port: "light1" } });
      state.edges.push({ from: { node: scn,   port: "out"    }, to: { node: vo,  port: "in"     } });
    }
  },

  /* Sprint 7.5.3c push 3 -- RGB Stage Lights. Three colored
   * point lights (red / green / blue) at the corners of a triangle
   * around a chrome sphere. Demonstrates multi-light summing +
   * how PBR materials blend overlapping colored lights into
   * complex highlights.
   *
   * The lights orbit slowly around the sphere (each on its own
   * Phasor at a slightly different freq for visual variety) so
   * the colored regions sweep across the sphere -- the classic
   * "rainbow chrome" look. */
  {
    id: "scene-3d-rgb-stage",
    name: "RGB Stage",
    sub: "3 colored lights · chrome sphere",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-rgb-r" cx="0.3" cy="0.35" r="0.6">
          <stop offset="0" stop-color="rgba(255,90,90,1)"/>
          <stop offset="1" stop-color="rgba(120,30,30,0)"/>
        </radialGradient>
        <radialGradient id="dg-rgb-g" cx="0.7" cy="0.35" r="0.6">
          <stop offset="0" stop-color="rgba(90,255,120,0.9)"/>
          <stop offset="1" stop-color="rgba(30,120,40,0)"/>
        </radialGradient>
        <radialGradient id="dg-rgb-b" cx="0.5" cy="0.75" r="0.6">
          <stop offset="0" stop-color="rgba(120,150,255,1)"/>
          <stop offset="1" stop-color="rgba(40,60,120,0)"/>
        </radialGradient>
        <radialGradient id="dg-rgb-chrome" cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" stop-color="rgba(255,255,255,1)"/>
          <stop offset="0.5" stop-color="rgba(200,210,240,1)"/>
          <stop offset="1" stop-color="rgba(60,70,100,1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(6, 8, 16, 1)"/>
      <ellipse cx="50" cy="22" rx="55" ry="14" fill="url(#dg-rgb-r)" opacity="0.65"/>
      <ellipse cx="50" cy="22" rx="55" ry="14" fill="url(#dg-rgb-g)" opacity="0.65"/>
      <ellipse cx="50" cy="22" rx="55" ry="14" fill="url(#dg-rgb-b)" opacity="0.65"/>
      <circle cx="50" cy="22" r="12" fill="url(#dg-rgb-chrome)"/>
    </svg>`,
    build: () => {
      const sph    = makeNode("Sphere",      40,  40, { radius: 0.9, stacks: 32, slices: 48 });
      // metallic 0.85 + roughness 0.22 gives a chrome-ish surface
      // that still has a tiny diffuse contribution + visible
      // (not pinpoint) highlights. Combined with the new
      // hemisphere-IBL ambient, the sphere reads as polished
      // metal without needing a real environment map.
      const mat    = makeNode("PhysicalMat", 260, 40, { r: 0.85, g: 0.85, b: 0.88, metallic: 0.85, roughness: 0.22 });
      const cam    = makeNode("Camera",      40, 200, {
        posX: 0, posY: 0.4, posZ: 4.2,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 50, near: 0.1, far: 100, mode: 0
      });
      // Three orbiting point lights at different phases on the
      // same clock so the relative motion stays stable.
      const clk    = makeNode("MasterClock", 40, 320, { bpm: 24 });
      const mulTau = makeNode("Mul",        240, 320, { b: 6.283185307 });
      // Light 1 (red): orbit phase 0
      const sinR   = makeNode("Sin",        420, 200);
      const cosR   = makeNode("Cos",        420, 280);
      const mulRx  = makeNode("Mul",        600, 200, { b: 2.5 });
      const mulRz  = makeNode("Mul",        600, 280, { b: 2.5 });
      const lightR = makeNode("PointLight", 780, 200, {
        posY: 1.2, colorR: 1.0, colorG: 0.25, colorB: 0.25,
        intensity: 5.0, range: 6
      });
      // Light 2 (green): orbit phase 2π/3 (offset by adding to angle)
      const addG   = makeNode("Add",        420, 380, { b: 2.094 }); // +120°
      const sinG   = makeNode("Sin",        600, 380);
      const cosG   = makeNode("Cos",        600, 460);
      const mulGx  = makeNode("Mul",        780, 380, { b: 2.5 });
      const mulGz  = makeNode("Mul",        780, 460, { b: 2.5 });
      const lightG = makeNode("PointLight", 960, 380, {
        posY: -0.6, colorR: 0.25, colorG: 1.0, colorB: 0.30,
        intensity: 5.0, range: 6
      });
      // Light 3 (blue): orbit phase 4π/3
      const addB   = makeNode("Add",        420, 560, { b: 4.189 }); // +240°
      const sinB   = makeNode("Sin",        600, 560);
      const cosB   = makeNode("Cos",        600, 640);
      const mulBx  = makeNode("Mul",        780, 560, { b: 2.5 });
      const mulBz  = makeNode("Mul",        780, 640, { b: 2.5 });
      const lightB = makeNode("PointLight", 960, 560, {
        posY: 1.2, colorR: 0.25, colorG: 0.35, colorB: 1.0,
        intensity: 5.0, range: 6
      });

      const scn    = makeNode("Scene",     1200, 300, { clearR: 0.02, clearG: 0.03, clearB: 0.06 });
      const vo     = makeNode("VisualOutput", 1400, 300, { display: 0 });

      // Mesh + material chain
      state.edges.push({ from: { node: sph, port: "mesh" }, to: { node: mat, port: "mesh" } });

      // Shared math: clock.phase → ×2π → angle
      state.edges.push({ from: { node: clk, port: "phase" }, to: { node: mulTau, port: "a" } });

      // Light R: angle → sin/cos → scale → pos
      state.edges.push({ from: { node: mulTau, port: "out" }, to: { node: sinR, port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out" }, to: { node: cosR, port: "in" } });
      state.edges.push({ from: { node: sinR, port: "out" }, to: { node: mulRx, port: "a" } });
      state.edges.push({ from: { node: cosR, port: "out" }, to: { node: mulRz, port: "a" } });
      state.edges.push({ from: { node: mulRx, port: "out" }, to: { node: lightR, port: "posX" } });
      state.edges.push({ from: { node: mulRz, port: "out" }, to: { node: lightR, port: "posZ" } });

      // Light G: angle + 120° → sin/cos → scale → pos
      state.edges.push({ from: { node: mulTau, port: "out" }, to: { node: addG, port: "a" } });
      state.edges.push({ from: { node: addG, port: "out" }, to: { node: sinG, port: "in" } });
      state.edges.push({ from: { node: addG, port: "out" }, to: { node: cosG, port: "in" } });
      state.edges.push({ from: { node: sinG, port: "out" }, to: { node: mulGx, port: "a" } });
      state.edges.push({ from: { node: cosG, port: "out" }, to: { node: mulGz, port: "a" } });
      state.edges.push({ from: { node: mulGx, port: "out" }, to: { node: lightG, port: "posX" } });
      state.edges.push({ from: { node: mulGz, port: "out" }, to: { node: lightG, port: "posZ" } });

      // Light B: angle + 240° → sin/cos → scale → pos
      state.edges.push({ from: { node: mulTau, port: "out" }, to: { node: addB, port: "a" } });
      state.edges.push({ from: { node: addB, port: "out" }, to: { node: sinB, port: "in" } });
      state.edges.push({ from: { node: addB, port: "out" }, to: { node: cosB, port: "in" } });
      state.edges.push({ from: { node: sinB, port: "out" }, to: { node: mulBx, port: "a" } });
      state.edges.push({ from: { node: cosB, port: "out" }, to: { node: mulBz, port: "a" } });
      state.edges.push({ from: { node: mulBx, port: "out" }, to: { node: lightB, port: "posX" } });
      state.edges.push({ from: { node: mulBz, port: "out" }, to: { node: lightB, port: "posZ" } });

      // Scene
      state.edges.push({ from: { node: mat,    port: "mesh"   }, to: { node: scn, port: "mesh1"  } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: lightR, port: "light"  }, to: { node: scn, port: "light1" } });
      state.edges.push({ from: { node: lightG, port: "light"  }, to: { node: scn, port: "light2" } });
      state.edges.push({ from: { node: lightB, port: "light"  }, to: { node: scn, port: "light3" } });
      state.edges.push({ from: { node: scn,    port: "out"    }, to: { node: vo,  port: "in"     } });
    }
  },

  /* Sprint 7.5.3c push 3 -- Spotlight Stage. A tight downward
   * SpotLight illuminating a row of PBR primitives on a Plane
   * "stage". The spot's cone cuts a visible bright disc on the
   * plane + lights only the meshes inside its reach. Sweeping
   * the spot's direction param horizontally produces a classic
   * "stage scan" sweep. */
  {
    id: "scene-3d-spotlight",
    name: "Spotlight Stage",
    sub: "spotlight · cone falloff",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-spot-cone" x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0" stop-color="rgba(255,240,180,0.85)"/>
          <stop offset="0.7" stop-color="rgba(255,200,120,0.55)"/>
          <stop offset="1" stop-color="rgba(255,200,120,0)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(8, 8, 18, 1)"/>
      <!-- spotlight cone -->
      <polygon points="46,6 54,6 70,34 30,34" fill="url(#dg-spot-cone)" opacity="0.7"/>
      <!-- plane ground -->
      <rect x="10" y="34" width="80" height="6" fill="rgba(120,100,60,0.4)"/>
      <ellipse cx="50" cy="34" rx="20" ry="3.5" fill="rgba(255,210,140,0.4)"/>
      <!-- spheres on stage -->
      <circle cx="36" cy="29" r="4.5" fill="rgba(200,210,235,0.6)"/>
      <circle cx="50" cy="28" r="5"   fill="rgba(255,235,180,0.95)"/>
      <circle cx="64" cy="29" r="4.5" fill="rgba(200,210,235,0.6)"/>
    </svg>`,
    build: () => {
      const plane = makeNode("Plane",        40,   40, { width: 8, depth: 6 });
      const mPlan = makeNode("PhysicalMat",  260,  40, { r: 0.35, g: 0.30, b: 0.25, metallic: 0.0, roughness: 0.85 });
      const tPlan = makeNode("Translate",    480,  40, { x: 0, y: -0.6, z: 0 });

      const sph1  = makeNode("Sphere",       40,  200, { radius: 0.5, stacks: 24, slices: 32 });
      const mat1  = makeNode("PhysicalMat",  260, 200, { r: 0.9, g: 0.9, b: 0.9, metallic: 1.0, roughness: 0.20 });
      const tr1   = makeNode("Translate",    480, 200, { x: -1.8, y: 0, z: 0 });
      const sph2  = makeNode("Sphere",       40,  340, { radius: 0.6, stacks: 24, slices: 32 });
      const mat2  = makeNode("PhysicalMat",  260, 340, { r: 0.92, g: 0.4, b: 0.6, metallic: 0.0, roughness: 0.30 });
      const tr2   = makeNode("Translate",    480, 340, { x: 0, y: 0, z: 0 });
      const sph3  = makeNode("Sphere",       40,  480, { radius: 0.5, stacks: 24, slices: 32 });
      const mat3  = makeNode("PhysicalMat",  260, 480, { r: 0.92, g: 0.78, b: 0.30, metallic: 0.85, roughness: 0.35 });
      const tr3   = makeNode("Translate",    480, 480, { x: 1.8, y: 0, z: 0 });

      const cam   = makeNode("Camera",       720,  40, {
        posX: 0, posY: 1.0, posZ: 4.5,
        targetX: 0, targetY: -0.1, targetZ: 0,
        fov: 55, near: 0.1, far: 100, mode: 0
      });

      // Spotlight overhead-front. Sweep the dirX horizontally over
      // time so the cone scans across the row of spheres.
      const clk     = makeNode("MasterClock", 720, 200, { bpm: 30 });
      const mulTau  = makeNode("Mul",         900, 200, { b: 6.283185307 });
      const sinDir  = makeNode("Sin",        1080, 200);
      const mulSwp  = makeNode("Mul",        1260, 200, { b: 0.7 });    // ±0.7 horizontal sweep
      const spot    = makeNode("SpotLight",  1440, 200, {
        posX: 0, posY: 3.5, posZ: 0.5,
        dirX: 0, dirY: -1, dirZ: -0.05,
        colorR: 1.0, colorG: 0.92, colorB: 0.75,
        intensity: 3.0, range: 12,
        innerAngle: 12, outerAngle: 22
      });

      const scn   = makeNode("Scene",        1680, 280, { clearR: 0.02, clearG: 0.02, clearB: 0.04 });
      const vo    = makeNode("VisualOutput", 1900, 280, { display: 0 });

      // Mesh chains: plane + 3 spheres each get a material + translate.
      state.edges.push({ from: { node: plane, port: "mesh" }, to: { node: mPlan, port: "mesh" } });
      state.edges.push({ from: { node: mPlan, port: "mesh" }, to: { node: tPlan, port: "mesh" } });
      state.edges.push({ from: { node: sph1,  port: "mesh" }, to: { node: mat1,  port: "mesh" } });
      state.edges.push({ from: { node: mat1,  port: "mesh" }, to: { node: tr1,   port: "mesh" } });
      state.edges.push({ from: { node: sph2,  port: "mesh" }, to: { node: mat2,  port: "mesh" } });
      state.edges.push({ from: { node: mat2,  port: "mesh" }, to: { node: tr2,   port: "mesh" } });
      state.edges.push({ from: { node: sph3,  port: "mesh" }, to: { node: mat3,  port: "mesh" } });
      state.edges.push({ from: { node: mat3,  port: "mesh" }, to: { node: tr3,   port: "mesh" } });

      // Sweep math: clock.phase → ×2π → sin → ×0.7 → spot.dirX
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinDir, port: "in" } });
      state.edges.push({ from: { node: sinDir, port: "out"   }, to: { node: mulSwp, port: "a" } });
      state.edges.push({ from: { node: mulSwp, port: "out"   }, to: { node: spot,   port: "dirX" } });

      // Scene wiring (Plane = mesh1; 3 spheres = mesh2..mesh4)
      state.edges.push({ from: { node: tPlan, port: "mesh"   }, to: { node: scn, port: "mesh1"  } });
      state.edges.push({ from: { node: tr1,   port: "mesh"   }, to: { node: scn, port: "mesh2"  } });
      state.edges.push({ from: { node: tr2,   port: "mesh"   }, to: { node: scn, port: "mesh3"  } });
      state.edges.push({ from: { node: tr3,   port: "mesh"   }, to: { node: scn, port: "mesh4"  } });
      state.edges.push({ from: { node: cam,   port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: spot,  port: "light"  }, to: { node: scn, port: "light1" } });
      state.edges.push({ from: { node: scn,   port: "out"    }, to: { node: vo,  port: "in"     } });
    }
  },

  /* Sprint 7.5.3c push 4 -- ShaderMat Showcase. Four spheres each
   * with a different ShaderMat preset:
   *   left      iridescent  (oil-slick rainbow)
   *   center-L  plasma      (4-sine plasma scrolling on surface)
   *   center-R  scanlines   (sci-fi hologram stripes)
   *   right     fresnelEdge (rim-light fake)
   *
   * MasterClock.phase × 2π drives time for the animated presets.
   * Camera is static; each sphere is on its own static Translate.
   * No lights wired -- the presets are self-shading. */
  {
    id: "scene-3d-shadermat",
    name: "ShaderMat Showcase",
    sub: "iridescent · plasma · scanlines · fresnel",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-sm-iri" cx="0.4" cy="0.35" r="0.7">
          <stop offset="0"   stop-color="rgba(220,150,255,1)"/>
          <stop offset="0.5" stop-color="rgba(120,220,180,0.95)"/>
          <stop offset="1"   stop-color="rgba(255,200,90,1)"/>
        </radialGradient>
        <radialGradient id="dg-sm-pls" cx="0.5" cy="0.5" r="0.7">
          <stop offset="0"   stop-color="rgba(255,180,90,1)"/>
          <stop offset="0.5" stop-color="rgba(230,90,170,0.95)"/>
          <stop offset="1"   stop-color="rgba(80,130,255,1)"/>
        </radialGradient>
        <linearGradient id="dg-sm-scn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"    stop-color="rgba(120,230,255,0.4)"/>
          <stop offset="0.2"  stop-color="rgba(180,250,255,1)"/>
          <stop offset="0.35" stop-color="rgba(120,230,255,0.4)"/>
          <stop offset="0.55" stop-color="rgba(180,250,255,1)"/>
          <stop offset="0.7"  stop-color="rgba(120,230,255,0.4)"/>
          <stop offset="0.9"  stop-color="rgba(180,250,255,1)"/>
        </linearGradient>
        <radialGradient id="dg-sm-rim" cx="0.5" cy="0.5" r="0.55">
          <stop offset="0"    stop-color="rgba(20,30,50,1)"/>
          <stop offset="0.65" stop-color="rgba(40,80,160,0.6)"/>
          <stop offset="0.92" stop-color="rgba(200,230,255,1)"/>
          <stop offset="1"    stop-color="rgba(255,255,255,0.4)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(6, 8, 16, 1)"/>
      <circle cx="14" cy="22" r="8" fill="url(#dg-sm-iri)"/>
      <circle cx="38" cy="22" r="8" fill="url(#dg-sm-pls)"/>
      <circle cx="62" cy="22" r="8" fill="url(#dg-sm-scn)"
              stroke="rgba(180,250,255,0.4)" stroke-width="0.4"/>
      <circle cx="86" cy="22" r="8" fill="url(#dg-sm-rim)"/>
    </svg>`,
    build: () => {
      // Animation source: MasterClock.phase × 2π gives 0..2π per
      // beat. Wired to each ShaderMat.time for periodic animation.
      const clk    = makeNode("MasterClock", 40,  40, { bpm: 30 });
      const mulTau = makeNode("Mul",        220,  40, { b: 6.283185307 });

      const sph1 = makeNode("Sphere",       40, 180, { radius: 0.7, stacks: 32, slices: 48 });
      const sph2 = makeNode("Sphere",       40, 320, { radius: 0.7, stacks: 32, slices: 48 });
      const sph3 = makeNode("Sphere",       40, 460, { radius: 0.7, stacks: 32, slices: 48 });
      const sph4 = makeNode("Sphere",       40, 600, { radius: 0.7, stacks: 32, slices: 48 });

      // Each ShaderMat with a different preset index + tuned params.
      const m1 = makeNode("ShaderMat", 260, 180, {
        preset: 0,  // iridescent
        r: 0.6, g: 0.85, b: 1.0,
        freq: 1.2, intensity: 1.0
      });
      const m2 = makeNode("ShaderMat", 260, 320, {
        preset: 1,  // plasma
        r: 0.2, g: 0.3, b: 0.8,
        freq: 1.5, intensity: 1.0
      });
      const m3 = makeNode("ShaderMat", 260, 460, {
        preset: 2,  // scanlines
        r: 0.2, g: 0.8, b: 1.0,
        freq: 2.0, intensity: 1.0
      });
      const m4 = makeNode("ShaderMat", 260, 600, {
        preset: 3,  // fresnelEdge
        r: 0.6, g: 0.85, b: 1.0,
        freq: 1.5, intensity: 1.0
      });

      // Spread along X.
      const tr1 = makeNode("Translate",     480, 180, { x: -3.6, y: 0, z: 0 });
      const tr2 = makeNode("Translate",     480, 320, { x: -1.2, y: 0, z: 0 });
      const tr3 = makeNode("Translate",     480, 460, { x:  1.2, y: 0, z: 0 });
      const tr4 = makeNode("Translate",     480, 600, { x:  3.6, y: 0, z: 0 });

      const cam = makeNode("Camera",        700, 320, {
        posX: 0, posY: 0.2, posZ: 6,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 60, near: 0.1, far: 100, mode: 0
      });
      const scn = makeNode("Scene",         940, 320, { clearR: 0.02, clearG: 0.03, clearB: 0.06 });
      const vo  = makeNode("VisualOutput", 1180, 320, { display: 0 });

      // Time pipe
      state.edges.push({ from: { node: clk, port: "phase" }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out" }, to: { node: m1, port: "time" } });
      state.edges.push({ from: { node: mulTau, port: "out" }, to: { node: m2, port: "time" } });
      state.edges.push({ from: { node: mulTau, port: "out" }, to: { node: m3, port: "time" } });
      state.edges.push({ from: { node: mulTau, port: "out" }, to: { node: m4, port: "time" } });

      // Mesh chains
      state.edges.push({ from: { node: sph1, port: "mesh" }, to: { node: m1, port: "mesh" } });
      state.edges.push({ from: { node: sph2, port: "mesh" }, to: { node: m2, port: "mesh" } });
      state.edges.push({ from: { node: sph3, port: "mesh" }, to: { node: m3, port: "mesh" } });
      state.edges.push({ from: { node: sph4, port: "mesh" }, to: { node: m4, port: "mesh" } });
      state.edges.push({ from: { node: m1,   port: "mesh" }, to: { node: tr1, port: "mesh" } });
      state.edges.push({ from: { node: m2,   port: "mesh" }, to: { node: tr2, port: "mesh" } });
      state.edges.push({ from: { node: m3,   port: "mesh" }, to: { node: tr3, port: "mesh" } });
      state.edges.push({ from: { node: m4,   port: "mesh" }, to: { node: tr4, port: "mesh" } });

      // Scene
      state.edges.push({ from: { node: tr1, port: "mesh"   }, to: { node: scn, port: "mesh1"  } });
      state.edges.push({ from: { node: tr2, port: "mesh"   }, to: { node: scn, port: "mesh2"  } });
      state.edges.push({ from: { node: tr3, port: "mesh"   }, to: { node: scn, port: "mesh3"  } });
      state.edges.push({ from: { node: tr4, port: "mesh"   }, to: { node: scn, port: "mesh4"  } });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: scn, port: "out"    }, to: { node: vo,  port: "in"     } });
    }
  },

  /* Sprint 7.5.3c push 5 -- Shader-as-Texture demo. Four 3D
   * primitives wrapping four different upstream shader-frag
   * outputs as their surface texture via ShaderMat(preset=texture).
   * The plan walker auto-schedules each upstream into a scratch
   * slot before the Scene's pass; the spherical UV projection
   * maps the 2D shader output onto each 3D shape.
   *
   *   StarNest    → Sphere      (volumetric stars wrapped globally)
   *   Voronoi     → Box         (cellular pattern per-face-ish)
   *   MatrixRain  → Torus       (rain wrapping the donut surface)
   *   Plasma      → Cylinder    (plasma flowing around the curve)
   *
   * A slow camera orbit shows how the shader rotates with the
   * surface (since UV is sphericial-from-world-pos, the camera
   * sees the texture wrap stay attached to each shape). */
  {
    id: "scene-3d-shader-tex",
    name: "Shaders as Textures",
    sub: "starnest · voronoi · matrix · plasma",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-stx-stars" cx="0.4" cy="0.5" r="0.6">
          <stop offset="0"   stop-color="rgba(180,200,255,1)"/>
          <stop offset="0.5" stop-color="rgba(60,80,150,1)"/>
          <stop offset="1"   stop-color="rgba(10,15,40,1)"/>
        </radialGradient>
        <pattern id="dg-stx-vor" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="rgba(120,90,200,1)"/>
          <circle cx="3" cy="3" r="2.5" fill="rgba(160,140,240,0.7)"/>
        </pattern>
        <linearGradient id="dg-stx-mtx" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"    stop-color="rgba(0,80,40,1)"/>
          <stop offset="0.3"  stop-color="rgba(20,255,80,1)"/>
          <stop offset="0.6"  stop-color="rgba(0,120,50,1)"/>
          <stop offset="1"    stop-color="rgba(0,30,15,1)"/>
        </linearGradient>
        <radialGradient id="dg-stx-pls" cx="0.5" cy="0.5" r="0.7">
          <stop offset="0"   stop-color="rgba(255,200,90,1)"/>
          <stop offset="0.5" stop-color="rgba(230,90,170,1)"/>
          <stop offset="1"   stop-color="rgba(60,100,200,1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(4, 6, 12, 1)"/>
      <circle cx="14" cy="22" r="8" fill="url(#dg-stx-stars)"/>
      <rect   cx="38" cy="22" x="30" y="14" width="16" height="16" fill="url(#dg-stx-vor)"
              stroke="rgba(255,255,255,0.35)" stroke-width="0.4"/>
      <ellipse cx="62" cy="22" rx="9" ry="6" fill="url(#dg-stx-mtx)"
               stroke="rgba(100,255,120,0.4)" stroke-width="0.4"/>
      <rect cx="86" cy="22" x="80" y="13" width="12" height="18" rx="2"
            fill="url(#dg-stx-pls)" stroke="rgba(255,255,255,0.35)" stroke-width="0.4"/>
    </svg>`,
    build: () => {
      // Upstream visuals (no VisualOutput needed; the plan walker
      // schedules them into scratch slots before Scene renders).
      const stars  = makeNode("StarNest",     40,  40, {});
      const vor    = makeNode("Voronoi",      40, 200, { density: 16, edgeThickness: 0.06, seed: 0.4 });
      const mtx    = makeNode("MatrixRain",   40, 360, {});
      const plas   = makeNode("Plasma",       40, 520, { speed: 0.6, scale: 1.5 });

      // Meshes.
      const sph    = makeNode("Sphere",      240,  40, { radius: 0.8, stacks: 32, slices: 48 });
      const box    = makeNode("Box",         240, 200, { width: 1.4, height: 1.4, depth: 1.4 });
      const tor    = makeNode("Torus",       240, 360, { majorRadius: 0.9, minorRadius: 0.35, majorSlices: 32, minorSlices: 16 });
      const cyl    = makeNode("Cylinder",    240, 520, { radius: 0.7, height: 1.6, slices: 32 });

      // ShaderMat(texture) per mesh.
      const m1 = makeNode("ShaderMat", 460,  40, { preset: 4, r: 1, g: 1, b: 1, freq: 1.0, intensity: 1.3 });
      const m2 = makeNode("ShaderMat", 460, 200, { preset: 4, r: 1, g: 1, b: 1, freq: 1.2, intensity: 1.1 });
      const m3 = makeNode("ShaderMat", 460, 360, { preset: 4, r: 1, g: 1, b: 1, freq: 1.5, intensity: 1.3 });
      const m4 = makeNode("ShaderMat", 460, 520, { preset: 4, r: 1, g: 1, b: 1, freq: 1.0, intensity: 1.4 });

      // Position them in a row.
      const tr1 = makeNode("Translate", 700,  40, { x: -3.6, y: 0, z: 0 });
      const tr2 = makeNode("Translate", 700, 200, { x: -1.2, y: 0, z: 0 });
      const tr3 = makeNode("Translate", 700, 360, { x:  1.2, y: 0, z: 0 });
      const tr4 = makeNode("Translate", 700, 520, { x:  3.6, y: 0, z: 0 });

      // Slow camera orbit.
      const clk    = makeNode("MasterClock", 940,  40, { bpm: 15 });
      const mulTau = makeNode("Mul",        1140, 40, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        1320, 40);
      const cosC   = makeNode("Cos",        1320, 130);
      const mulCx  = makeNode("Mul",        1480, 40,  { b: 1.5 });    // small horizontal pan
      const mulCz  = makeNode("Mul",        1480, 130, { b: 0.8 });
      const addCz  = makeNode("Add",        1660, 130, { b: 7.0 });    // base distance
      const cam    = makeNode("Camera",      940, 260, {
        posX: 0, posY: 0.4, posZ: 7,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 55, near: 0.1, far: 100, mode: 0
      });

      const scn    = makeNode("Scene",      1900, 320, { clearR: 0.02, clearG: 0.03, clearB: 0.05 });
      const vo     = makeNode("VisualOutput",2120, 320, { display: 0 });

      // Upstream visual -> material.texture
      state.edges.push({ from: { node: stars, port: "out" }, to: { node: m1, port: "texture" } });
      state.edges.push({ from: { node: vor,   port: "out" }, to: { node: m2, port: "texture" } });
      state.edges.push({ from: { node: mtx,   port: "out" }, to: { node: m3, port: "texture" } });
      state.edges.push({ from: { node: plas,  port: "out" }, to: { node: m4, port: "texture" } });

      // Mesh -> material -> translate.
      state.edges.push({ from: { node: sph, port: "mesh" }, to: { node: m1, port: "mesh" } });
      state.edges.push({ from: { node: box, port: "mesh" }, to: { node: m2, port: "mesh" } });
      state.edges.push({ from: { node: tor, port: "mesh" }, to: { node: m3, port: "mesh" } });
      state.edges.push({ from: { node: cyl, port: "mesh" }, to: { node: m4, port: "mesh" } });
      state.edges.push({ from: { node: m1,  port: "mesh" }, to: { node: tr1, port: "mesh" } });
      state.edges.push({ from: { node: m2,  port: "mesh" }, to: { node: tr2, port: "mesh" } });
      state.edges.push({ from: { node: m3,  port: "mesh" }, to: { node: tr3, port: "mesh" } });
      state.edges.push({ from: { node: m4,  port: "mesh" }, to: { node: tr4, port: "mesh" } });

      // Camera orbit math: clock.phase → sin/cos → posX, posZ
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"   }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"   }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCz,  port: "out"   }, to: { node: addCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"   }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: addCz,  port: "out"   }, to: { node: cam,    port: "posZ" } });

      // Scene wiring.
      state.edges.push({ from: { node: tr1, port: "mesh"   }, to: { node: scn, port: "mesh1"  } });
      state.edges.push({ from: { node: tr2, port: "mesh"   }, to: { node: scn, port: "mesh2"  } });
      state.edges.push({ from: { node: tr3, port: "mesh"   }, to: { node: scn, port: "mesh3"  } });
      state.edges.push({ from: { node: tr4, port: "mesh"   }, to: { node: scn, port: "mesh4"  } });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scn, port: "camera" } });
      state.edges.push({ from: { node: scn, port: "out"    }, to: { node: vo,  port: "in"     } });
    }
  },

  /* Sprint 7.5.6.a part 2h -- RT engine demo. Single sphere lit by
   * an orbiting camera, rendered via hardware ray tracing through
   * the local gamma-rt-engine subprocess (auto-spawned by the
   * compile-server). Exercises both pieces of part 2e: scene data
   * (mesh + clear color) shipped to the engine at connect, and live
   * camera Params updates as the clock-driven orbit ticks. The
   * "Hardware RT" sub indicates the editor is offloading rendering
   * to the engine instead of doing it on the editor's WebGPU. */
  {
    id: "rt-sphere-orbit",
    name: "RT Torus (orbit)",
    sub: "shadows · cook-torrance · live camera",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-rt-tor" cx="0.55" cy="0.4" r="0.55">
          <stop offset="0"   stop-color="rgba(230,235,255,1)"/>
          <stop offset="0.45" stop-color="rgba(130,170,220,1)"/>
          <stop offset="1"   stop-color="rgba(20,30,60,1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(4,6,12,1)"/>
      <!-- orbit ellipse hinting at camera path -->
      <ellipse cx="50" cy="22" rx="34" ry="9"
               fill="none" stroke="rgba(232,140,60,0.45)"
               stroke-width="0.5" stroke-dasharray="2 2"/>
      <!-- torus silhouette w/ visible shadowed hole -->
      <ellipse cx="50" cy="22" rx="14" ry="6.5" fill="url(#dg-rt-tor)"
               stroke="rgba(255,255,255,0.18)" stroke-width="0.3"/>
      <ellipse cx="50" cy="22" rx="5"  ry="2"   fill="rgba(0,0,0,0.85)"/>
      <text x="84" y="10" text-anchor="end"
            font-family="monospace" font-size="5"
            fill="rgba(232,140,60,0.85)"
            letter-spacing="0.08em">RT</text>
    </svg>`,
    build: () => {
      // Torus picked over Sphere so c-3 self-shadowing is visible:
      // the inside of the donut hole gets shadowed by the outside as
      // the camera orbits. Also a nicer surface to look at via PBR.
      const sph = makeNode("Torus", 40, 60, {
        majorRadius: 0.85, minorRadius: 0.32, majorSlices: 36, minorSlices: 18
      });

      // Orbit math: clock.phase (0..1) → ×τ → sin/cos → posX/posZ.
      // BPM=12 → one orbit every ~5 seconds. Slow enough to watch.
      const clk    = makeNode("MasterClock", 40, 340, { bpm: 12 });
      const mulTau = makeNode("Mul",        260, 340, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        460, 320);
      const cosC   = makeNode("Cos",        460, 420);
      const mulCx  = makeNode("Mul",        640, 320, { b: 2.6 });
      const mulCz  = makeNode("Mul",        640, 420, { b: 2.6 });
      const cam    = makeNode("Camera",     860, 340, {
        posX: 0, posY: 0.4, posZ: 2.6,
        targetX: 0, targetY: 0, targetZ: 0,
        fov: 55, near: 0.1, far: 100, mode: 0
      });

      const rt = makeNode("RayTracedScene", 1100, 80, { clearR: 0.03, clearG: 0.04, clearB: 0.08 });
      const vo = makeNode("VisualOutput",   1340, 80, { display: 0 });

      // Geometry → RT scene.
      state.edges.push({ from: { node: sph, port: "mesh" }, to: { node: rt, port: "mesh1" } });

      // Camera-orbit math chain.
      state.edges.push({ from: { node: clk,    port: "phase" }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"   }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"   }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"   }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"   }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulCz,  port: "out"   }, to: { node: cam,    port: "posZ" } });
      state.edges.push({ from: { node: cam,    port: "camera"}, to: { node: rt,     port: "camera" } });

      // RT scene → output.
      state.edges.push({ from: { node: rt, port: "out" }, to: { node: vo, port: "in" } });
    }
  },

  /* Sprint 7.5.6.a part 2e-2 / c-3 -- the "ball on ground" demo
   * that combines transform composition (Translate node positioning
   * the sphere above the floor plane) + cast shadows (the sphere's
   * shadow falls on the plane via the RT shadow-ray path). Chrome
   * sphere + matte floor + warm directional light from upper-right.
   * Slow camera orbit shows the shadow rotating with the light angle. */
  {
    id: "rt-shadows",
    name: "RT Shadows",
    sub: "ball on ground · cast shadow · live",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-rt-shd-ball" cx="0.55" cy="0.4" r="0.5">
          <stop offset="0"   stop-color="rgba(245,250,255,1)"/>
          <stop offset="0.5" stop-color="rgba(150,180,220,1)"/>
          <stop offset="1"   stop-color="rgba(30,50,90,1)"/>
        </radialGradient>
        <linearGradient id="dg-rt-shd-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(110,110,120,1)"/>
          <stop offset="1" stop-color="rgba(60,55,55,1)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(4,6,12,1)"/>
      <!-- floor strip -->
      <rect x="0" y="28" width="100" height="16" fill="url(#dg-rt-shd-floor)"/>
      <!-- shadow ellipse on floor -->
      <ellipse cx="52" cy="33" rx="14" ry="2.3" fill="rgba(0,0,0,0.55)"/>
      <!-- ball above floor -->
      <circle cx="50" cy="22" r="9" fill="url(#dg-rt-shd-ball)"/>
      <text x="92" y="10" text-anchor="end"
            font-family="monospace" font-size="5"
            fill="rgba(232,140,60,0.85)"
            letter-spacing="0.08em">RT</text>
    </svg>`,
    build: () => {
      // ── Floor plane (matte gray, sits at y=0). shininess=32 keeps
      // the Phong specular highlight tight; low values (<16) saturate
      // the floor with broad white specular and lose the matte look.
      const plane    = makeNode("Plane",       40,  60, { width: 6, depth: 6 });
      const planeMat = makeNode("PhongMat",   280,  60, {
        r: 0.55, g: 0.55, b: 0.58, shininess: 32, ambient: 0.18
      });

      // ── Sphere (chrome, translated up so it sits ON the plane)
      const sph    = makeNode("Sphere",       40, 240, {
        radius: 0.6, stacks: 24, slices: 36
      });
      const sphTr  = makeNode("Translate",   280, 240, { x: 0, y: 0.6, z: 0 });
      const sphMat = makeNode("PhysicalMat", 500, 240, {
        r: 0.85, g: 0.85, b: 0.90, metallic: 1.0, roughness: 0.18
      });

      // ── Warm directional light from upper-right-front, so the
      // sphere shadow falls toward camera-left on the plane.
      const light = makeNode("DirectionalLight", 40, 460, {
        dirX: 0.5, dirY: 1.0, dirZ: 0.5,
        colorR: 1.0, colorG: 0.95, colorB: 0.85,
        intensity: 1.4
      });

      // ── Slow camera orbit so the shadow + reflection move with the view.
      const clk    = makeNode("MasterClock", 40, 620, { bpm: 8 });
      const mulTau = makeNode("Mul",        260, 620, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        460, 600);
      const cosC   = makeNode("Cos",        460, 700);
      const mulCx  = makeNode("Mul",        640, 600, { b: 2.6 });
      const mulCz  = makeNode("Mul",        640, 700, { b: 2.6 });
      const cam    = makeNode("Camera",     860, 620, {
        posX: 0, posY: 1.1, posZ: 2.6,
        targetX: 0, targetY: 0.4, targetZ: 0,
        fov: 50, near: 0.1, far: 100, mode: 0
      });

      const rt = makeNode("RayTracedScene", 1100, 280, {
        clearR: 0.04, clearG: 0.05, clearB: 0.09
      });
      const vo = makeNode("VisualOutput",   1340, 280, { display: 0 });

      // ── Wiring
      // Plane chain: Plane → PhongMat → RT.mesh1
      state.edges.push({ from: { node: plane,    port: "mesh"   }, to: { node: planeMat, port: "mesh" } });
      state.edges.push({ from: { node: planeMat, port: "mesh"   }, to: { node: rt,       port: "mesh1" } });
      // Sphere chain: Sphere → Translate(0, 0.6, 0) → PhysicalMat → RT.mesh2
      state.edges.push({ from: { node: sph,    port: "mesh"   }, to: { node: sphTr,  port: "mesh" } });
      state.edges.push({ from: { node: sphTr,  port: "mesh"   }, to: { node: sphMat, port: "mesh" } });
      state.edges.push({ from: { node: sphMat, port: "mesh"   }, to: { node: rt,     port: "mesh2" } });
      // Light + camera + output
      state.edges.push({ from: { node: light,  port: "light"  }, to: { node: rt, port: "light1" } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: rt, port: "camera" } });
      // Camera orbit math
      state.edges.push({ from: { node: clk,    port: "phase"  }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"    }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"    }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"    }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulCz,  port: "out"    }, to: { node: cam,    port: "posZ" } });
      state.edges.push({ from: { node: rt,     port: "out"    }, to: { node: vo,     port: "in" } });
    }
  },

  /* Sprint 7.5.6.d -- glass + mirror demo. Two balls on a matte floor:
   * left = clear glass (ior=1.5, refracts the floor + sky behind it),
   * right = chrome mirror (reflects floor, sky, and the glass ball).
   * Slow orbit so you see the refraction distortion shift as the camera
   * moves. Showcases the c-3/d bounce loop -- each ball can fire 4-6
   * reflection/refraction rays per pixel via the hardware RT cores. */
  {
    id: "rt-glass-mirror",
    name: "RT Glass + Mirror",
    sub: "refraction · reflection · live",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-rt-gm-glass" cx="0.5" cy="0.45" r="0.5">
          <stop offset="0"    stop-color="rgba(220,240,255,0.95)"/>
          <stop offset="0.65" stop-color="rgba(160,200,235,0.75)"/>
          <stop offset="0.95" stop-color="rgba(230,240,255,0.95)"/>
          <stop offset="1"    stop-color="rgba(180,200,235,1)"/>
        </radialGradient>
        <radialGradient id="dg-rt-gm-mirror" cx="0.5" cy="0.4" r="0.55">
          <stop offset="0"   stop-color="rgba(240,245,255,1)"/>
          <stop offset="0.5" stop-color="rgba(140,165,200,1)"/>
          <stop offset="1"   stop-color="rgba(30,40,70,1)"/>
        </radialGradient>
        <linearGradient id="dg-rt-gm-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(90,90,100,1)"/>
          <stop offset="1" stop-color="rgba(40,40,45,1)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(4,6,12,1)"/>
      <rect x="0" y="29" width="100" height="15" fill="url(#dg-rt-gm-floor)"/>
      <ellipse cx="32" cy="34" rx="11" ry="1.8" fill="rgba(0,0,0,0.45)"/>
      <ellipse cx="70" cy="34" rx="11" ry="1.8" fill="rgba(0,0,0,0.65)"/>
      <circle cx="32" cy="23" r="9" fill="url(#dg-rt-gm-glass)"
              stroke="rgba(255,255,255,0.45)" stroke-width="0.5"/>
      <circle cx="70" cy="23" r="9" fill="url(#dg-rt-gm-mirror)"/>
      <text x="92" y="10" text-anchor="end"
            font-family="monospace" font-size="5"
            fill="rgba(232,140,60,0.85)"
            letter-spacing="0.08em">RT</text>
    </svg>`,
    build: () => {
      // Floor (matte gray Phong so glass refracts visible texture).
      // shininess=32 keeps the highlight tight -- shininess<16 makes
      // Blinn-Phong's specular cover most of the floor at full
      // intensity, which clips to pure white. ambient=0.2 lifts the
      // shadow side enough to read.
      const plane    = makeNode("Plane",       40,  40, { width: 8, depth: 8 });
      const planeMat = makeNode("PhongMat",   280,  40, {
        r: 0.55, g: 0.55, b: 0.58, shininess: 32, ambient: 0.2
      });

      // Glass ball -- left side
      const glassBall = makeNode("Sphere",     40, 220, {
        radius: 0.5, stacks: 32, slices: 48
      });
      const glassTr  = makeNode("Translate",  280, 220, { x: -0.7, y: 0.5, z: 0 });
      const glassMat = makeNode("GlassMat",   500, 220, {
        r: 0.95, g: 0.97, b: 1.0, ior: 1.5
      });

      // Mirror ball -- right side
      const mirrorBall = makeNode("Sphere",   40, 420, {
        radius: 0.5, stacks: 32, slices: 48
      });
      const mirrorTr  = makeNode("Translate", 280, 420, { x: 0.7, y: 0.5, z: 0 });
      const mirrorMat = makeNode("MirrorMat", 500, 420, {
        r: 0.95, g: 0.95, b: 0.95
      });

      // Light + camera + outputs
      const light = makeNode("DirectionalLight", 40, 620, {
        dirX: 0.3, dirY: 1.0, dirZ: 0.4,
        colorR: 1.0, colorG: 0.97, colorB: 0.9,
        intensity: 1.0
      });

      const clk    = makeNode("MasterClock", 40, 800, { bpm: 6 });
      const mulTau = makeNode("Mul",        260, 800, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        460, 780);
      const cosC   = makeNode("Cos",        460, 880);
      const mulCx  = makeNode("Mul",        640, 780, { b: 2.8 });
      const mulCz  = makeNode("Mul",        640, 880, { b: 2.8 });
      const cam    = makeNode("Camera",     860, 800, {
        posX: 0, posY: 0.9, posZ: 2.8,
        targetX: 0, targetY: 0.4, targetZ: 0,
        fov: 55, near: 0.1, far: 100, mode: 0
      });

      const rt = makeNode("RayTracedScene", 1100, 320, {
        clearR: 0.04, clearG: 0.05, clearB: 0.09
      });
      const vo = makeNode("VisualOutput",   1340, 320, { display: 0 });

      // ── Floor chain
      state.edges.push({ from: { node: plane,    port: "mesh"  }, to: { node: planeMat, port: "mesh" } });
      state.edges.push({ from: { node: planeMat, port: "mesh"  }, to: { node: rt,       port: "mesh1" } });
      // ── Glass-ball chain
      state.edges.push({ from: { node: glassBall, port: "mesh" }, to: { node: glassTr,  port: "mesh" } });
      state.edges.push({ from: { node: glassTr,   port: "mesh" }, to: { node: glassMat, port: "mesh" } });
      state.edges.push({ from: { node: glassMat,  port: "mesh" }, to: { node: rt,       port: "mesh2" } });
      // ── Mirror-ball chain
      state.edges.push({ from: { node: mirrorBall, port: "mesh" }, to: { node: mirrorTr,  port: "mesh" } });
      state.edges.push({ from: { node: mirrorTr,   port: "mesh" }, to: { node: mirrorMat, port: "mesh" } });
      state.edges.push({ from: { node: mirrorMat,  port: "mesh" }, to: { node: rt,        port: "mesh3" } });
      // ── Light + camera-orbit + output
      state.edges.push({ from: { node: light,  port: "light"  }, to: { node: rt, port: "light1" } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: rt, port: "camera" } });
      state.edges.push({ from: { node: clk,    port: "phase"  }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"    }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"    }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"    }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulCz,  port: "out"    }, to: { node: cam,    port: "posZ" } });
      state.edges.push({ from: { node: rt,     port: "out"    }, to: { node: vo,     port: "in" } });
    }
  },

  /* Sprint 7.5.6.f.3.d-fix6 -- quality preset comparison harness.
   * The scene piles on the things extra spp + bounces actually fix:
   * a mirror ball reflecting two glass balls + a warm-colored floor.
   *
   *   draft   (1 spp, 2 bounces): glass refraction terminates after
   *           one in/out pair so the mirror BEHIND the glass shows
   *           as solid sky color through it. Floor specular caustic
   *           under each glass ball is firefly-grainy. Mirror's
   *           reflection of the glass-front shows as sky too.
   *   preview (4 spp, 4 bounces): glass refraction reveals the floor
   *           + opposite glass through it. Mirror reflects the glass
   *           balls cleanly. Per-frame noise mostly cleared by TDS.
   *   final   (16 spp, 8 bounces): mirror -> glass-in -> glass-out
   *           -> scene chain resolves; you can see the floor color
   *           through nested refraction. Static-frame noise drops
   *           to near-zero on the glass + mirror surfaces.
   *
   * Toggle the `quality` knob on the RayTracedScene node to A/B.
   * Orbit is slow (bpm=4, ~15s per revolution) so you can pause-
   * watch noise behavior between preset switches. Mirror is set
   * back behind the two glass balls so it dominates center-frame
   * and gets refracted through the glass at the same time. */
  {
    id: "rt-quality-preset",
    name: "RT Quality Preset",
    sub: "draft / preview / final · A/B",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <radialGradient id="dg-rt-qp-mirror" cx="0.5" cy="0.4" r="0.55">
          <stop offset="0"   stop-color="rgba(240,245,255,1)"/>
          <stop offset="0.5" stop-color="rgba(140,165,200,1)"/>
          <stop offset="1"   stop-color="rgba(30,40,70,1)"/>
        </radialGradient>
        <radialGradient id="dg-rt-qp-glass" cx="0.5" cy="0.45" r="0.5">
          <stop offset="0"    stop-color="rgba(220,240,255,0.95)"/>
          <stop offset="0.7"  stop-color="rgba(160,200,235,0.75)"/>
          <stop offset="1"    stop-color="rgba(180,200,235,1)"/>
        </radialGradient>
        <linearGradient id="dg-rt-qp-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(150,90,60,1)"/>
          <stop offset="1" stop-color="rgba(70,40,28,1)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="rgba(3,4,8,1)"/>
      <rect x="0" y="32" width="100" height="12" fill="url(#dg-rt-qp-floor)"/>
      <ellipse cx="20" cy="33" rx="7"  ry="1.2" fill="rgba(0,0,0,0.45)"/>
      <ellipse cx="50" cy="34" rx="13" ry="1.8" fill="rgba(0,0,0,0.7)"/>
      <ellipse cx="80" cy="33" rx="7"  ry="1.2" fill="rgba(0,0,0,0.45)"/>
      <circle cx="50" cy="22" r="11" fill="url(#dg-rt-qp-mirror)"/>
      <circle cx="20" cy="26" r="7"  fill="url(#dg-rt-qp-glass)"
              stroke="rgba(255,255,255,0.4)" stroke-width="0.4"/>
      <circle cx="80" cy="26" r="7"  fill="url(#dg-rt-qp-glass)"
              stroke="rgba(255,255,255,0.4)" stroke-width="0.4"/>
      <text x="92" y="10" text-anchor="end"
            font-family="monospace" font-size="5"
            fill="rgba(232,140,60,0.85)"
            letter-spacing="0.08em">QP</text>
    </svg>`,
    build: () => {
      // Warm-colored floor -- the saturation makes indirect bounces
      // from the `final` preset (8 bounces) visibly tint the upper
      // hemisphere of the spheres. A neutral gray floor would hide
      // this difference. shininess=24 keeps the specular highlight
      // small enough that diffuse bounce dominates.
      const plane    = makeNode("Plane",       40,  40, { width: 8, depth: 8 });
      const planeMat = makeNode("PhongMat",   280,  40, {
        r: 0.85, g: 0.55, b: 0.35, shininess: 24, ambient: 0.18
      });

      // Left glass ball -- foreground, slightly toward camera
      const glass1Ball = makeNode("Sphere",     40, 220, { radius: 0.4, stacks: 32, slices: 48 });
      const glass1Tr   = makeNode("Translate", 280, 220, { x: -0.85, y: 0.4, z: 0.6 });
      const glass1Mat  = makeNode("GlassMat",  500, 220, { r: 0.95, g: 1.0, b: 0.98, ior: 1.5 });

      // Right glass ball -- mirror image of left
      const glass2Ball = makeNode("Sphere",     40, 420, { radius: 0.4, stacks: 32, slices: 48 });
      const glass2Tr   = makeNode("Translate", 280, 420, { x:  0.85, y: 0.4, z: 0.6 });
      const glass2Mat  = makeNode("GlassMat",  500, 420, { r: 0.98, g: 0.95, b: 1.0, ior: 1.5 });

      // Mirror ball -- back center, large enough to dominate center
      // frame even with glass in front. The bounce-budget stressor:
      // mirror -> reflects glass-front -> glass refracts -> resolves
      // into floor/sky. At MAX_BOUNCES=2 the mirror's reflection of
      // glass shows as sky color; at MAX_BOUNCES=4+ the floor color
      // resolves through the chain.
      const mirrorBall = makeNode("Sphere",     40, 620, { radius: 0.65, stacks: 40, slices: 56 });
      const mirrorTr   = makeNode("Translate", 280, 620, { x: 0.0, y: 0.65, z: -0.5 });
      const mirrorMat  = makeNode("MirrorMat", 500, 620, { r: 0.92, g: 0.92, b: 0.96 });

      // Bright warm directional light -- positioned so the glass
      // balls cast visible refractive caustics on the floor (the
      // single-sample firefly noise high-spp cleans up the most).
      const light = makeNode("DirectionalLight", 40, 820, {
        dirX: 0.25, dirY: 1.0, dirZ: 0.3,
        colorR: 1.0, colorG: 0.96, colorB: 0.88,
        intensity: 1.15
      });

      // Slow orbit -- bpm=4 ~= 15s per revolution. Slow enough you
      // can stare at a preset switch and watch the noise settle (or
      // not). Pause-friendly.
      const clk    = makeNode("MasterClock", 40, 1020, { bpm: 4 });
      const mulTau = makeNode("Mul",        260, 1020, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        460, 1000);
      const cosC   = makeNode("Cos",        460, 1100);
      const mulCx  = makeNode("Mul",        640, 1000, { b: 3.0 });
      const mulCz  = makeNode("Mul",        640, 1100, { b: 3.0 });
      const cam    = makeNode("Camera",     860, 1020, {
        posX: 0, posY: 1.1, posZ: 3.0,
        targetX: 0, targetY: 0.4, targetZ: 0,
        fov: 50, near: 0.1, far: 100, mode: 0
      });

      // Starting preset = preview (the default). User toggles
      // `quality` to draft (0) / final (2) to A/B. The preset
      // drives spp + bounces on the engine side; samples / bounces
      // params remain at 0 so they follow the preset.
      const rt = makeNode("RayTracedScene", 1100, 320, {
        quality: 1,
        clearR: 0.03, clearG: 0.03, clearB: 0.06
      });
      const vo = makeNode("VisualOutput",   1340, 320, { display: 0 });

      // ── Floor chain
      state.edges.push({ from: { node: plane,    port: "mesh" }, to: { node: planeMat, port: "mesh" } });
      state.edges.push({ from: { node: planeMat, port: "mesh" }, to: { node: rt,       port: "mesh1" } });
      // ── Left glass chain
      state.edges.push({ from: { node: glass1Ball, port: "mesh" }, to: { node: glass1Tr,  port: "mesh" } });
      state.edges.push({ from: { node: glass1Tr,   port: "mesh" }, to: { node: glass1Mat, port: "mesh" } });
      state.edges.push({ from: { node: glass1Mat,  port: "mesh" }, to: { node: rt,        port: "mesh2" } });
      // ── Right glass chain
      state.edges.push({ from: { node: glass2Ball, port: "mesh" }, to: { node: glass2Tr,  port: "mesh" } });
      state.edges.push({ from: { node: glass2Tr,   port: "mesh" }, to: { node: glass2Mat, port: "mesh" } });
      state.edges.push({ from: { node: glass2Mat,  port: "mesh" }, to: { node: rt,        port: "mesh3" } });
      // ── Mirror chain
      state.edges.push({ from: { node: mirrorBall, port: "mesh" }, to: { node: mirrorTr,  port: "mesh" } });
      state.edges.push({ from: { node: mirrorTr,   port: "mesh" }, to: { node: mirrorMat, port: "mesh" } });
      state.edges.push({ from: { node: mirrorMat,  port: "mesh" }, to: { node: rt,        port: "mesh4" } });
      // ── Light + camera-orbit + output
      state.edges.push({ from: { node: light,  port: "light"  }, to: { node: rt, port: "light1" } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: rt, port: "camera" } });
      state.edges.push({ from: { node: clk,    port: "phase"  }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"    }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"    }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"    }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulCz,  port: "out"    }, to: { node: cam,    port: "posZ" } });
      state.edges.push({ from: { node: rt,     port: "out"    }, to: { node: vo,     port: "in" } });
    }
  },

  /* Sprint 7.5.4 — GradientSky showcase. Three PBR balls
   * (matte / glossy / chrome) on a slightly glossy plane, lit by a
   * warm-white DirectionalLight that mimics a sunset key + a wired
   * GradientSky overhead. The chrome ball makes the env reflection
   * obvious (you can read the sky / horizon / ground bands directly
   * on its surface); the matte ball picks up the env via diffuse
   * fill; the glossy middle one shows the in-between. Slow orbit
   * (bpm=4, ~15s per revolution) so the user can watch the env
   * reflection shift across the chrome surface as the camera moves.
   *
   * Colors lean sunset (warm sky, peach horizon, dim ground) because
   * that triplet has the most visible spread — daytime + horizon are
   * too similar to read distinctly on the chrome. Twist any of the
   * GradientSky color params live to see the response. */
  {
    id: "gradient-sky-showcase",
    name: "Gradient Sky",
    sub: "matte / glossy / chrome · env reflections",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-gs-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"    stop-color="rgba(255,140,55,1)"/>
          <stop offset="0.55" stop-color="rgba(220,110,80,1)"/>
          <stop offset="0.95" stop-color="rgba(50,30,25,1)"/>
        </linearGradient>
        <radialGradient id="dg-gs-chrome" cx="0.5" cy="0.4" r="0.55">
          <stop offset="0"   stop-color="rgba(255,205,165,1)"/>
          <stop offset="0.5" stop-color="rgba(195,110,80,1)"/>
          <stop offset="1"   stop-color="rgba(45,25,15,1)"/>
        </radialGradient>
        <radialGradient id="dg-gs-glossy" cx="0.5" cy="0.4" r="0.55">
          <stop offset="0"   stop-color="rgba(220,180,150,1)"/>
          <stop offset="0.7" stop-color="rgba(140,90,80,1)"/>
          <stop offset="1"   stop-color="rgba(60,40,35,1)"/>
        </radialGradient>
        <radialGradient id="dg-gs-matte" cx="0.5" cy="0.4" r="0.55">
          <stop offset="0"   stop-color="rgba(180,150,130,1)"/>
          <stop offset="1"   stop-color="rgba(95,75,70,1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-gs-sky)"/>
      <rect x="0" y="32" width="100" height="12" fill="rgba(40,25,20,0.92)"/>
      <ellipse cx="22" cy="34" rx="7" ry="1.2" fill="rgba(0,0,0,0.5)"/>
      <ellipse cx="50" cy="34" rx="7" ry="1.2" fill="rgba(0,0,0,0.5)"/>
      <ellipse cx="78" cy="34" rx="7" ry="1.2" fill="rgba(0,0,0,0.5)"/>
      <circle cx="22" cy="26" r="7" fill="url(#dg-gs-matte)"/>
      <circle cx="50" cy="26" r="7" fill="url(#dg-gs-glossy)"/>
      <circle cx="78" cy="26" r="7" fill="url(#dg-gs-chrome)"/>
    </svg>`,
    build: () => {
      // ── Floor: slightly glossy PBR. Picks up sky tint diffusely +
      // shows a wide horizon reflection if the camera angle is right.
      const plane    = makeNode("Plane",      40,  40, { width: 8, depth: 8 });
      const planeMat = makeNode("PhysicalMat",280,  40, {
        r: 0.35, g: 0.30, b: 0.28,
        metallic: 0.0, roughness: 0.55
      });

      // ── Matte ball (left). roughness=0.85 -> mostly diffuse, env
      // contributes via sample_env(normal) only. Reads as "object
      // illuminated by the sky color" rather than reflecting it.
      const ballMatte = makeNode("Sphere",     40, 220, { radius: 0.5, stacks: 32, slices: 48 });
      const trMatte   = makeNode("Translate", 280, 220, { x: -1.4, y: 0.5, z: 0 });
      const matMatte  = makeNode("PhysicalMat",500, 220, {
        r: 0.78, g: 0.72, b: 0.68,
        metallic: 0.0, roughness: 0.85
      });

      // ── Glossy ball (middle). roughness=0.3 -> visible env
      // reflection but softened. The horizon band is the most
      // recognizable feature.
      const ballGlossy = makeNode("Sphere",     40, 420, { radius: 0.5, stacks: 32, slices: 48 });
      const trGlossy   = makeNode("Translate", 280, 420, { x: 0.0, y: 0.5, z: 0 });
      const matGlossy  = makeNode("PhysicalMat",500, 420, {
        r: 0.55, g: 0.45, b: 0.40,
        metallic: 0.0, roughness: 0.30
      });

      // ── Chrome ball (right). metallic=1, roughness=0.05 -> near-
      // mirror specular off F0. The env shows on its surface as a
      // direct sky / horizon / ground band -- the whole point of
      // wiring environment.
      const ballChrome = makeNode("Sphere",     40, 620, { radius: 0.5, stacks: 32, slices: 48 });
      const trChrome   = makeNode("Translate", 280, 620, { x: 1.4, y: 0.5, z: 0 });
      const matChrome  = makeNode("PhysicalMat",500, 620, {
        r: 0.95, g: 0.95, b: 0.97,
        metallic: 1.0, roughness: 0.05
      });

      // ── Sunset GradientSky. Warm overhead, peach horizon, dim
      // ground -- max color spread on the chrome surface. Twist any
      // of these live to see the response on all three balls.
      const sky = makeNode("GradientSky", 40, 820, {
        skyR: 1.00, skyG: 0.55, skyB: 0.30,
        horizonR: 0.85, horizonG: 0.45, horizonB: 0.35,
        groundR: 0.12, groundG: 0.08, groundB: 0.06,
        intensity: 1.4
      });

      // ── Warm key light from upper-front; complements the sunset.
      const light = makeNode("DirectionalLight", 40, 1020, {
        dirX: 0.35, dirY: 0.65, dirZ: 0.40,
        colorR: 1.0, colorG: 0.78, colorB: 0.60,
        intensity: 1.1
      });

      // ── Slow orbit. ~15s/revolution at bpm=4.
      const clk    = makeNode("MasterClock", 40, 1220, { bpm: 4 });
      const mulTau = makeNode("Mul",        260, 1220, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        460, 1200);
      const cosC   = makeNode("Cos",        460, 1300);
      const mulCx  = makeNode("Mul",        640, 1200, { b: 3.2 });
      const mulCz  = makeNode("Mul",        640, 1300, { b: 3.2 });
      const cam    = makeNode("Camera",     860, 1220, {
        posX: 0, posY: 1.1, posZ: 3.2,
        targetX: 0, targetY: 0.4, targetZ: 0,
        fov: 50, near: 0.1, far: 100, mode: 0
      });

      const scene = makeNode("Scene",       1100, 320, {
        clearR: 0.05, clearG: 0.03, clearB: 0.04
      });
      const vo = makeNode("VisualOutput",   1340, 320, { display: 0 });

      // ── Floor
      state.edges.push({ from: { node: plane,    port: "mesh" }, to: { node: planeMat, port: "mesh" } });
      state.edges.push({ from: { node: planeMat, port: "mesh" }, to: { node: scene,    port: "mesh1" } });
      // ── Matte
      state.edges.push({ from: { node: ballMatte, port: "mesh" }, to: { node: trMatte,  port: "mesh" } });
      state.edges.push({ from: { node: trMatte,   port: "mesh" }, to: { node: matMatte, port: "mesh" } });
      state.edges.push({ from: { node: matMatte,  port: "mesh" }, to: { node: scene,    port: "mesh2" } });
      // ── Glossy
      state.edges.push({ from: { node: ballGlossy, port: "mesh" }, to: { node: trGlossy,  port: "mesh" } });
      state.edges.push({ from: { node: trGlossy,   port: "mesh" }, to: { node: matGlossy, port: "mesh" } });
      state.edges.push({ from: { node: matGlossy,  port: "mesh" }, to: { node: scene,     port: "mesh3" } });
      // ── Chrome
      state.edges.push({ from: { node: ballChrome, port: "mesh" }, to: { node: trChrome,  port: "mesh" } });
      state.edges.push({ from: { node: trChrome,   port: "mesh" }, to: { node: matChrome, port: "mesh" } });
      state.edges.push({ from: { node: matChrome,  port: "mesh" }, to: { node: scene,     port: "mesh4" } });
      // ── Sky / light / camera / out
      state.edges.push({ from: { node: sky,    port: "env"    }, to: { node: scene,  port: "environment" } });
      state.edges.push({ from: { node: light,  port: "light"  }, to: { node: scene,  port: "light1" } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: scene,  port: "camera" } });
      state.edges.push({ from: { node: clk,    port: "phase"  }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"    }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"    }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"    }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulCz,  port: "out"    }, to: { node: cam,    port: "posZ" } });
      state.edges.push({ from: { node: scene,  port: "out"    }, to: { node: vo,     port: "in" } });
    }
  },

  /* Sprint 7.5.4.c -- Day / Night Cycle showcase. The whole §5.4.c
   * trio (DayNightCycle + Sun + ProceduralSky) wired up against a
   * trio of PBR balls + a glossy floor. MasterClock(bpm=0.6) drives
   * the cycle through ~100 seconds per day -- short enough to watch
   * the whole arc in a sitting, long enough to enjoy each phase.
   * Sun's direction + color + the sky's appearance all derive from
   * the SAME timeOfDay so the directional shadow matches the
   * apparent sun position in the sky exactly.
   *
   * To see specific times-of-day, disconnect the MasterClock from
   * DayNightCycle and twist its `manual` slider. 0.25 = sunrise,
   * 0.5 = noon, 0.75 = sunset, 0.0 = midnight. */
  {
    id: "day-night-cycle",
    name: "Day / Night Cycle",
    sub: "sun + procedural sky · 100s loop",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-dn-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"   stop-color="rgba(255,140,55,1)"/>
          <stop offset="0.5" stop-color="rgba(180,90,75,1)"/>
          <stop offset="1"   stop-color="rgba(15,18,40,1)"/>
        </linearGradient>
        <radialGradient id="dg-dn-sun" cx="0.85" cy="0.5" r="0.18">
          <stop offset="0"   stop-color="rgba(255,235,170,1)"/>
          <stop offset="0.5" stop-color="rgba(255,170,90,0.7)"/>
          <stop offset="1"   stop-color="rgba(255,140,55,0)"/>
        </radialGradient>
        <radialGradient id="dg-dn-chrome" cx="0.5" cy="0.4" r="0.55">
          <stop offset="0"   stop-color="rgba(255,180,120,1)"/>
          <stop offset="0.5" stop-color="rgba(180,90,75,1)"/>
          <stop offset="1"   stop-color="rgba(35,25,50,1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-dn-sky)"/>
      <ellipse cx="85" cy="22" rx="16" ry="16" fill="url(#dg-dn-sun)"/>
      <rect x="0" y="32" width="100" height="12" fill="rgba(20,15,18,0.92)"/>
      <ellipse cx="50" cy="34" rx="9" ry="1.4" fill="rgba(0,0,0,0.55)"/>
      <circle cx="50" cy="24" r="9" fill="url(#dg-dn-chrome)"/>
    </svg>`,
    build: () => {
      // ── Three PBR balls so you can read the day/night color
      // shift across material types simultaneously.
      const plane    = makeNode("Plane",      40,  40, { width: 10, depth: 10 });
      const planeMat = makeNode("PhysicalMat",280,  40, {
        r: 0.30, g: 0.28, b: 0.30,
        metallic: 0.0, roughness: 0.55
      });

      const matteBall = makeNode("Sphere",     40, 220, { radius: 0.55, stacks: 32, slices: 48 });
      const matteTr   = makeNode("Translate", 280, 220, { x: -1.5, y: 0.55, z: 0 });
      const matteMat  = makeNode("PhysicalMat",500, 220, {
        r: 0.78, g: 0.74, b: 0.68,
        metallic: 0.0, roughness: 0.80
      });

      const glossyBall = makeNode("Sphere",     40, 420, { radius: 0.55, stacks: 32, slices: 48 });
      const glossyTr   = makeNode("Translate", 280, 420, { x: 0.0, y: 0.55, z: 0 });
      const glossyMat  = makeNode("PhysicalMat",500, 420, {
        r: 0.55, g: 0.50, b: 0.46,
        metallic: 0.2, roughness: 0.30
      });

      const chromeBall = makeNode("Sphere",     40, 620, { radius: 0.55, stacks: 32, slices: 48 });
      const chromeTr   = makeNode("Translate", 280, 620, { x: 1.5, y: 0.55, z: 0 });
      const chromeMat  = makeNode("PhysicalMat",500, 620, {
        r: 0.95, g: 0.95, b: 0.97,
        metallic: 1.0, roughness: 0.05
      });

      // ── Day/night infrastructure. Slow clock -> DayNightCycle
      // -> Sun + ProceduralSky. Single source of truth for time-of-
      // day; Sun and sky stay perfectly in sync.
      const clkDay = makeNode("MasterClock", 40, 820, { bpm: 0.6 });
      const dnc    = makeNode("DayNightCycle", 280, 820, { manual: 0.5 });
      const sun    = makeNode("Sun",         500, 820, {
        timeOfDay: 0.5,
        tintR: 1.0, tintG: 1.0, tintB: 1.0,
        intensityScale: 1.0
      });
      const sky    = makeNode("ProceduralSky", 500, 1020, {
        timeOfDay: 0.5, turbidity: 1.2, mieG: 0.78, intensity: 1.0,
        // 7.5.4.d -- partly cloudy with slow westward drift.
        cloudCoverage: 0.45, cloudDensity: 1.0,
        windSpeedX: 0.8, windSpeedZ: 0.3
      });

      // ── Camera orbit (independent slow clock so it doesn't sync
      // to the day-night cycle visibly).
      const clkCam = makeNode("MasterClock", 40, 1220, { bpm: 3 });
      const mulTau = makeNode("Mul",        260, 1220, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        460, 1200);
      const cosC   = makeNode("Cos",        460, 1300);
      const mulCx  = makeNode("Mul",        640, 1200, { b: 3.6 });
      const mulCz  = makeNode("Mul",        640, 1300, { b: 3.6 });
      const cam    = makeNode("Camera",     860, 1220, {
        posX: 0, posY: 1.2, posZ: 3.6,
        targetX: 0, targetY: 0.5, targetZ: 0,
        fov: 50, near: 0.1, far: 100, mode: 0
      });

      const scene = makeNode("Scene",       1100, 320, {
        clearR: 0.02, clearG: 0.02, clearB: 0.04,
        // 7.5.4.e -- atmospheric perspective via fog. Pulled from
        // env-horizon color, so the far edges of the floor (and the
        // back of the chrome ball's reflection) tint toward whatever
        // the sky is doing -- sunset orange, midday blue, midnight
        // navy. 0.09 gives ~50% fog at the floor's far corners,
        // clearly visible without overwhelming the foreground.
        // Drop to 0.05 + fogHeight=2.0 for subtle ground fog only;
        // bump to 0.20+ for overcast / smoggy.
        fogDensity: 0.09, fogStart: 2.2, fogHeight: 0.0, fogAuto: 1.0
      });
      const vo = makeNode("VisualOutput",   1340, 320, { display: 0 });

      // ── Floor + 3 balls
      state.edges.push({ from: { node: plane,    port: "mesh" }, to: { node: planeMat, port: "mesh" } });
      state.edges.push({ from: { node: planeMat, port: "mesh" }, to: { node: scene,    port: "mesh1" } });
      state.edges.push({ from: { node: matteBall, port: "mesh" }, to: { node: matteTr,  port: "mesh" } });
      state.edges.push({ from: { node: matteTr,   port: "mesh" }, to: { node: matteMat, port: "mesh" } });
      state.edges.push({ from: { node: matteMat,  port: "mesh" }, to: { node: scene,    port: "mesh2" } });
      state.edges.push({ from: { node: glossyBall, port: "mesh" }, to: { node: glossyTr,  port: "mesh" } });
      state.edges.push({ from: { node: glossyTr,   port: "mesh" }, to: { node: glossyMat, port: "mesh" } });
      state.edges.push({ from: { node: glossyMat,  port: "mesh" }, to: { node: scene,     port: "mesh3" } });
      state.edges.push({ from: { node: chromeBall, port: "mesh" }, to: { node: chromeTr,  port: "mesh" } });
      state.edges.push({ from: { node: chromeTr,   port: "mesh" }, to: { node: chromeMat, port: "mesh" } });
      state.edges.push({ from: { node: chromeMat,  port: "mesh" }, to: { node: scene,     port: "mesh4" } });
      // ── Day-night wiring. Single timeOfDay drives Sun + Sky.
      state.edges.push({ from: { node: clkDay, port: "phase"     }, to: { node: dnc, port: "phase" } });
      state.edges.push({ from: { node: dnc,    port: "timeOfDay" }, to: { node: sun, port: "timeOfDay" } });
      state.edges.push({ from: { node: dnc,    port: "timeOfDay" }, to: { node: sky, port: "timeOfDay" } });
      state.edges.push({ from: { node: sun,    port: "light"     }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: sky,    port: "env"       }, to: { node: scene, port: "environment" } });
      // ── Camera orbit + output
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: scene,  port: "camera" } });
      state.edges.push({ from: { node: clkCam, port: "phase"  }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"    }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"    }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"    }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulCz,  port: "out"    }, to: { node: cam,    port: "posZ" } });
      state.edges.push({ from: { node: scene,  port: "out"    }, to: { node: vo,     port: "in" } });
    }
  },

  /* Sprint 5.4-rt -- RT Day / Night Cycle. Same setup as the raster
   * day-night-cycle but with RayTracedScene as the sink, plus one
   * glass ball + one mirror ball to take advantage of what RT
   * specifically delivers (proper refraction + recursive reflection
   * of the day-night sky). With the 5.4-rt engine sprint the kernel
   * honors ProceduralSky's atmospheric scattering + sun-disk + moon
   * + stars + Milky Way + clouds, AND atmospheric-perspective fog --
   * all the same env wiring as the raster sibling.
   *
   * Compare side-by-side with day-night-cycle: this one's chrome
   * sphere reflects the sun-disk with crisp recursion (raster only
   * shows IBL-blurred sky), the glass refracts the sky into the
   * floor caustic-style, and the mirror reflects the moon at night.
   * Otherwise identical lighting / fog / cloud behavior. */
  {
    id: "rt-day-night-cycle",
    name: "RT Day / Night Cycle",
    sub: "ray-traced sun + sky · glass + chrome",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-rtdn-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"   stop-color="rgba(255,140,55,1)"/>
          <stop offset="0.5" stop-color="rgba(180,90,75,1)"/>
          <stop offset="1"   stop-color="rgba(15,18,40,1)"/>
        </linearGradient>
        <radialGradient id="dg-rtdn-sun" cx="0.85" cy="0.5" r="0.18">
          <stop offset="0"   stop-color="rgba(255,235,170,1)"/>
          <stop offset="0.5" stop-color="rgba(255,170,90,0.7)"/>
          <stop offset="1"   stop-color="rgba(255,140,55,0)"/>
        </radialGradient>
        <radialGradient id="dg-rtdn-chrome" cx="0.5" cy="0.4" r="0.55">
          <stop offset="0"   stop-color="rgba(255,180,120,1)"/>
          <stop offset="0.5" stop-color="rgba(180,90,75,1)"/>
          <stop offset="1"   stop-color="rgba(35,25,50,1)"/>
        </radialGradient>
        <radialGradient id="dg-rtdn-glass" cx="0.5" cy="0.4" r="0.55">
          <stop offset="0"    stop-color="rgba(255,210,170,0.95)"/>
          <stop offset="0.65" stop-color="rgba(220,140,95,0.75)"/>
          <stop offset="1"    stop-color="rgba(255,200,160,1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-rtdn-sky)"/>
      <ellipse cx="85" cy="22" rx="14" ry="14" fill="url(#dg-rtdn-sun)"/>
      <rect x="0" y="32" width="100" height="12" fill="rgba(20,15,18,0.92)"/>
      <ellipse cx="30" cy="34" rx="7"  ry="1.2" fill="rgba(0,0,0,0.5)"/>
      <ellipse cx="55" cy="34" rx="7"  ry="1.2" fill="rgba(0,0,0,0.55)"/>
      <ellipse cx="80" cy="34" rx="7"  ry="1.2" fill="rgba(0,0,0,0.5)"/>
      <circle cx="30" cy="25" r="8" fill="url(#dg-rtdn-glass)"
              stroke="rgba(255,220,180,0.45)" stroke-width="0.4"/>
      <circle cx="55" cy="25" r="8" fill="url(#dg-rtdn-chrome)"/>
      <circle cx="80" cy="25" r="8" fill="rgba(255,210,180,0.92)"/>
      <text x="92" y="9" text-anchor="end"
            font-family="monospace" font-size="5"
            fill="rgba(232,140,60,0.85)"
            letter-spacing="0.08em">RT</text>
    </svg>`,
    build: () => {
      // ── Floor (same as raster day-night-cycle).
      const plane    = makeNode("Plane",      40,  40, { width: 10, depth: 10 });
      const planeMat = makeNode("PhysicalMat",280,  40, {
        r: 0.30, g: 0.28, b: 0.30,
        metallic: 0.0, roughness: 0.55
      });

      // ── Glass ball (RT-only flavor; raster falls back to a high-
      // metallic PhysicalMat approximation which isn't bad but lacks
      // refraction.) IOR 1.5 = window glass.
      const glassBall = makeNode("Sphere",     40, 220, { radius: 0.55, stacks: 32, slices: 48 });
      const glassTr   = makeNode("Translate", 280, 220, { x: -1.5, y: 0.55, z: 0 });
      const glassMat  = makeNode("GlassMat",  500, 220, {
        r: 0.96, g: 0.98, b: 1.00, ior: 1.5
      });

      // ── Glossy PBR (middle).
      const glossyBall = makeNode("Sphere",     40, 420, { radius: 0.55, stacks: 32, slices: 48 });
      const glossyTr   = makeNode("Translate", 280, 420, { x: 0.0, y: 0.55, z: 0 });
      const glossyMat  = makeNode("PhysicalMat",500, 420, {
        r: 0.55, g: 0.50, b: 0.46,
        metallic: 0.2, roughness: 0.30
      });

      // ── Chrome (right). Same as raster day-night-cycle.
      const chromeBall = makeNode("Sphere",     40, 620, { radius: 0.55, stacks: 32, slices: 48 });
      const chromeTr   = makeNode("Translate", 280, 620, { x: 1.5, y: 0.55, z: 0 });
      const chromeMat  = makeNode("PhysicalMat",500, 620, {
        r: 0.95, g: 0.95, b: 0.97,
        metallic: 1.0, roughness: 0.05
      });

      // ── Day/night infrastructure. Identical to raster -- the env
      // wire works the same on raster Scene + RayTracedScene now.
      const clkDay = makeNode("MasterClock", 40, 820, { bpm: 0.6 });
      const dnc    = makeNode("DayNightCycle", 280, 820, { manual: 0.5 });
      const sun    = makeNode("Sun",         500, 820, {
        timeOfDay: 0.5,
        tintR: 1.0, tintG: 1.0, tintB: 1.0,
        intensityScale: 1.0
      });
      const sky    = makeNode("ProceduralSky", 500, 1020, {
        timeOfDay: 0.5, turbidity: 1.2, mieG: 0.78, intensity: 1.0,
        cloudCoverage: 0.45, cloudDensity: 1.0,
        windSpeedX: 0.8, windSpeedZ: 0.3
      });

      // ── Camera orbit (slow + independent clock).
      const clkCam = makeNode("MasterClock", 40, 1220, { bpm: 3 });
      const mulTau = makeNode("Mul",        260, 1220, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        460, 1200);
      const cosC   = makeNode("Cos",        460, 1300);
      const mulCx  = makeNode("Mul",        640, 1200, { b: 3.6 });
      const mulCz  = makeNode("Mul",        640, 1300, { b: 3.6 });
      const cam    = makeNode("Camera",     860, 1220, {
        posX: 0, posY: 1.2, posZ: 3.6,
        targetX: 0, targetY: 0.5, targetZ: 0,
        fov: 50, near: 0.1, far: 100, mode: 0
      });

      // ── RayTracedScene sink. Same env + fog wiring as raster.
      const rt = makeNode("RayTracedScene", 1100, 320, {
        quality: 1,                                          // preview
        clearR: 0.02, clearG: 0.02, clearB: 0.04,
        fogDensity: 0.09, fogStart: 2.2, fogHeight: 0.0, fogAuto: 1.0
      });
      const vo = makeNode("VisualOutput",   1340, 320, { display: 0 });

      // ── Mesh chains
      state.edges.push({ from: { node: plane,    port: "mesh" }, to: { node: planeMat, port: "mesh" } });
      state.edges.push({ from: { node: planeMat, port: "mesh" }, to: { node: rt,       port: "mesh1" } });
      state.edges.push({ from: { node: glassBall, port: "mesh" }, to: { node: glassTr,  port: "mesh" } });
      state.edges.push({ from: { node: glassTr,   port: "mesh" }, to: { node: glassMat, port: "mesh" } });
      state.edges.push({ from: { node: glassMat,  port: "mesh" }, to: { node: rt,       port: "mesh2" } });
      state.edges.push({ from: { node: glossyBall, port: "mesh" }, to: { node: glossyTr,  port: "mesh" } });
      state.edges.push({ from: { node: glossyTr,   port: "mesh" }, to: { node: glossyMat, port: "mesh" } });
      state.edges.push({ from: { node: glossyMat,  port: "mesh" }, to: { node: rt,        port: "mesh3" } });
      state.edges.push({ from: { node: chromeBall, port: "mesh" }, to: { node: chromeTr,  port: "mesh" } });
      state.edges.push({ from: { node: chromeTr,   port: "mesh" }, to: { node: chromeMat, port: "mesh" } });
      state.edges.push({ from: { node: chromeMat,  port: "mesh" }, to: { node: rt,        port: "mesh4" } });
      // ── Day-night wiring -- identical to raster Scene path
      state.edges.push({ from: { node: clkDay, port: "phase"     }, to: { node: dnc, port: "phase" } });
      state.edges.push({ from: { node: dnc,    port: "timeOfDay" }, to: { node: sun, port: "timeOfDay" } });
      state.edges.push({ from: { node: dnc,    port: "timeOfDay" }, to: { node: sky, port: "timeOfDay" } });
      state.edges.push({ from: { node: sun,    port: "light"     }, to: { node: rt,  port: "light1" } });
      state.edges.push({ from: { node: sky,    port: "env"       }, to: { node: rt,  port: "environment" } });
      // ── Camera orbit + output
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: rt,     port: "camera" } });
      state.edges.push({ from: { node: clkCam, port: "phase"  }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"    }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"    }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"    }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulCz,  port: "out"    }, to: { node: cam,    port: "posZ" } });
      state.edges.push({ from: { node: rt,     port: "out"    }, to: { node: vo,     port: "in" } });
    }
  },

  /* Sprint 7.5.4.b -- HDRI showcase. The bundled PolyHaven Table
   * Mountain pure-sky 4K HDR wired into Scene.environment. Three
   * PBR balls (matte / glossy / chrome) so you can read the HDR's
   * reflection at every roughness. No DayNightCycle / Sun -- the
   * HDR's own sun + sky drive both ambient illumination AND the
   * visible background. First load takes ~500ms (one-time fetch +
   * parse + GPU upload); after that the texture is cached. */
  {
    id: "hdri-showcase",
    name: "HDRI Sky",
    sub: "real HDR · table mountain 4K",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-hdri-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"   stop-color="rgba(120,165,210,1)"/>
          <stop offset="0.6" stop-color="rgba(195,205,220,1)"/>
          <stop offset="1"   stop-color="rgba(245,232,205,1)"/>
        </linearGradient>
        <radialGradient id="dg-hdri-chrome" cx="0.5" cy="0.4" r="0.55">
          <stop offset="0"   stop-color="rgba(220,235,250,1)"/>
          <stop offset="0.5" stop-color="rgba(170,195,225,1)"/>
          <stop offset="1"   stop-color="rgba(50,60,75,1)"/>
        </radialGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-hdri-sky)"/>
      <rect x="0" y="32" width="100" height="12" fill="rgba(80,70,55,0.85)"/>
      <ellipse cx="50" cy="34" rx="11" ry="1.5" fill="rgba(0,0,0,0.5)"/>
      <circle cx="50" cy="24" r="10" fill="url(#dg-hdri-chrome)"/>
    </svg>`,
    build: () => {
      const plane    = makeNode("Plane",      40,  40, { width: 10, depth: 10 });
      const planeMat = makeNode("PhysicalMat",280,  40, {
        r: 0.55, g: 0.50, b: 0.46,
        metallic: 0.0, roughness: 0.50
      });

      const matteBall = makeNode("Sphere",     40, 220, { radius: 0.55, stacks: 32, slices: 48 });
      const matteTr   = makeNode("Translate", 280, 220, { x: -1.5, y: 0.55, z: 0 });
      const matteMat  = makeNode("PhysicalMat",500, 220, {
        r: 0.85, g: 0.78, b: 0.70,
        metallic: 0.0, roughness: 0.85
      });

      const glossyBall = makeNode("Sphere",     40, 420, { radius: 0.55, stacks: 32, slices: 48 });
      const glossyTr   = makeNode("Translate", 280, 420, { x: 0.0, y: 0.55, z: 0 });
      const glossyMat  = makeNode("PhysicalMat",500, 420, {
        r: 0.65, g: 0.55, b: 0.50,
        metallic: 0.2, roughness: 0.25
      });

      const chromeBall = makeNode("Sphere",     40, 620, { radius: 0.55, stacks: 32, slices: 48 });
      const chromeTr   = makeNode("Translate", 280, 620, { x: 1.5, y: 0.55, z: 0 });
      const chromeMat  = makeNode("PhysicalMat",500, 620, {
        r: 0.95, g: 0.95, b: 0.97,
        metallic: 1.0, roughness: 0.05
      });

      // HDRI env source. preset selects which bundled file to load;
      // intensity scales the loaded values.
      const hdri = makeNode("HDRI", 40, 820, {
        preset: "table-mountain",
        intensity: 1.0
      });

      // Slow camera orbit
      const clk    = makeNode("MasterClock", 40, 1020, { bpm: 3 });
      const mulTau = makeNode("Mul",        260, 1020, { b: 6.283185307 });
      const sinC   = makeNode("Sin",        460, 1000);
      const cosC   = makeNode("Cos",        460, 1100);
      const mulCx  = makeNode("Mul",        640, 1000, { b: 3.6 });
      const mulCz  = makeNode("Mul",        640, 1100, { b: 3.6 });
      const cam    = makeNode("Camera",     860, 1020, {
        posX: 0, posY: 1.2, posZ: 3.6,
        targetX: 0, targetY: 0.5, targetZ: 0,
        fov: 50, near: 0.1, far: 100, mode: 0
      });

      const scene = makeNode("Scene",       1100, 320, {
        clearR: 0.5, clearG: 0.65, clearB: 0.85
      });
      const vo = makeNode("VisualOutput",   1340, 320, { display: 0 });

      // ── Mesh chains
      state.edges.push({ from: { node: plane,    port: "mesh" }, to: { node: planeMat, port: "mesh" } });
      state.edges.push({ from: { node: planeMat, port: "mesh" }, to: { node: scene,    port: "mesh1" } });
      state.edges.push({ from: { node: matteBall, port: "mesh" }, to: { node: matteTr,  port: "mesh" } });
      state.edges.push({ from: { node: matteTr,   port: "mesh" }, to: { node: matteMat, port: "mesh" } });
      state.edges.push({ from: { node: matteMat,  port: "mesh" }, to: { node: scene,    port: "mesh2" } });
      state.edges.push({ from: { node: glossyBall, port: "mesh" }, to: { node: glossyTr,  port: "mesh" } });
      state.edges.push({ from: { node: glossyTr,   port: "mesh" }, to: { node: glossyMat, port: "mesh" } });
      state.edges.push({ from: { node: glossyMat,  port: "mesh" }, to: { node: scene,     port: "mesh3" } });
      state.edges.push({ from: { node: chromeBall, port: "mesh" }, to: { node: chromeTr,  port: "mesh" } });
      state.edges.push({ from: { node: chromeTr,   port: "mesh" }, to: { node: chromeMat, port: "mesh" } });
      state.edges.push({ from: { node: chromeMat,  port: "mesh" }, to: { node: scene,     port: "mesh4" } });
      // ── HDRI -> env, camera, orbit, output
      state.edges.push({ from: { node: hdri,   port: "env"    }, to: { node: scene,  port: "environment" } });
      state.edges.push({ from: { node: cam,    port: "camera" }, to: { node: scene,  port: "camera" } });
      state.edges.push({ from: { node: clk,    port: "phase"  }, to: { node: mulTau, port: "a" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: sinC,   port: "in" } });
      state.edges.push({ from: { node: mulTau, port: "out"    }, to: { node: cosC,   port: "in" } });
      state.edges.push({ from: { node: sinC,   port: "out"    }, to: { node: mulCx,  port: "a" } });
      state.edges.push({ from: { node: cosC,   port: "out"    }, to: { node: mulCz,  port: "a" } });
      state.edges.push({ from: { node: mulCx,  port: "out"    }, to: { node: cam,    port: "posX" } });
      state.edges.push({ from: { node: mulCz,  port: "out"    }, to: { node: cam,    port: "posZ" } });
      state.edges.push({ from: { node: scene,  port: "out"    }, to: { node: vo,     port: "in" } });
    }
  },

  {
    id: "mesh-text",
    name: "Mesh Text",
    sub: "dome-positioned text",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.85)"/>
      <text x="50" y="28" text-anchor="middle"
            font-family="monospace" font-size="11" font-weight="bold"
            fill="var(--phosphor)" letter-spacing="0.08em">GAMMA</text>
    </svg>`,
    build: () => {
      const t = makeNode("Text",         40,  60, { text: "GAMMA NODE", yawDeg: 0, pitchDeg: 0, sizeDeg: 20 });
      const v = makeNode("VisualOutput",320,  60, { display: 0 });
      state.edges.push({ from: { node: t, port: "out" }, to: { node: v, port: "in" } });
    }
  },
  {
    id: "screensaver",
    name: "Screensaver",
    sub: "bouncing GAMMA NODE logo",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.85)"/>
      <text x="42" y="20" text-anchor="middle"
            font-family="monospace" font-size="7" font-weight="bold"
            fill="rgba(232,140,60,0.9)" letter-spacing="0.04em">GAMMA</text>
      <text x="62" y="34" text-anchor="middle"
            font-family="monospace" font-size="7" font-weight="bold"
            fill="rgba(131,232,255,0.85)" letter-spacing="0.04em">NODE</text>
    </svg>`,
    build: () => {
      const s = makeNode("GammaScreensaver", 40, 60);
      const v = makeNode("VisualOutput",    320, 60, { display: 0 });
      state.edges.push({ from: { node: s, port: "out" }, to: { node: v, port: "in" } });
    }
  },

  /* Phase 7.1 — Webcam VJ demo. Loading this asks for camera
   * permission on first frame, then puts a live mirrored webcam
   * feed through ColorCorrect (boosted saturation + slight contrast)
   * for a "VJ-ready" look. Drop a BlendShader between Webcam and
   * ColorCorrect with another source (Plasma, StarNest, etc) for
   * full VJ overlays. */
  {
    id: "webcam-vj",
    name: "Webcam VJ",
    sub: "live camera → colour-graded",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.85)"/>
      <circle cx="50" cy="22" r="11" fill="none" stroke="var(--phosphor)" stroke-width="1.4"/>
      <circle cx="50" cy="22" r="5"  fill="var(--phosphor)" opacity="0.6"/>
      <circle cx="62" cy="14" r="1.2" fill="rgba(232,140,60,0.95)"/>
      <text x="50" y="40" text-anchor="middle"
            font-family="monospace" font-size="5" fill="rgba(255,255,255,0.55)"
            letter-spacing="0.08em">LIVE</text>
    </svg>`,
    build: () => {
      const cam = makeNode("Webcam", 40, 80, { mirrored: 1, exposure: 1.05, tint_r: 1.0, tint_g: 1.0, tint_b: 1.0 });
      const cc  = makeNode("ColorCorrect", 280, 80, { brightness: 0.0, contrast: 1.10, saturation: 1.25, hueShift: 0, gamma: 1.0 });
      const vo  = makeNode("VisualOutput", 520, 80, { display: 0 });
      state.edges.push({ from: { node: cam, port: "out" }, to: { node: cc, port: "in" } });
      state.edges.push({ from: { node: cc,  port: "out" }, to: { node: vo, port: "in" } });
    }
  },

  /* Phase 7.1b — Gesture VJ. MediaPipe HandLandmarker drives a Plasma
   * shader via the wired-param resolver: pinch fingers → slow down
   * the animation; raise / lower hand → shift the colour palette;
   * spread hand → boost the saturation. First load asks for the
   * camera + downloads ~8MB of MediaPipe model. */
  {
    id: "gesture-vj",
    name: "Gesture VJ",
    sub: "live hand landmarks",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.85)"/>
      <rect x="14" y="5" width="72" height="34" rx="3"
            fill="rgba(178,100,200,0.08)"
            stroke="rgba(178,100,200,0.55)" stroke-width="0.7"/>
      <!-- skeleton sketch: wrist + 5 fingers w/ landmark dots -->
      <g stroke="rgba(200,232,90,0.95)" stroke-width="1.0" stroke-linecap="round" fill="rgba(200,232,90,0.95)">
        <line x1="50" y1="33" x2="50" y2="24"/>
        <line x1="50" y1="24" x2="42" y2="14"/>
        <line x1="50" y1="24" x2="48" y2="10"/>
        <line x1="50" y1="24" x2="55" y2="10"/>
        <line x1="50" y1="24" x2="60" y2="14"/>
        <line x1="50" y1="24" x2="62" y2="20"/>
        <circle cx="50" cy="33" r="1.5"/>
        <circle cx="50" cy="24" r="1.1"/>
        <circle cx="42" cy="14" r="1.0"/>
        <circle cx="48" cy="10" r="1.0"/>
        <circle cx="55" cy="10" r="1.0"/>
        <circle cx="60" cy="14" r="1.0"/>
        <circle cx="62" cy="20" r="1.0"/>
      </g>
      <text x="50" y="42" text-anchor="middle"
            font-family="monospace" font-size="4.5" fill="rgba(178,100,200,0.85)"
            letter-spacing="0.12em">MEDIAPIPE</text>
    </svg>`,
    build: () => {
      // v0.3.5 — simplified to "see what the detector sees." Wires the
      // HandLandmarker texture output (camera + colour-coded skeleton
      // overlay) straight into VisualOutput. The detector also exposes
      // per-hand h1_pinch / h1_y / h1_open / etc as param outputs --
      // the audio-side wiring (drive a BiquadLP cutoff from h1_y,
      // sweep a Sine freq from h1_pinch, etc) lands in the next
      // sprint once the live-control → SAB → worklet → C++ setter
      // bridge is in place.
      const hands = makeNode("HandLandmarker", 40, 80, {
        maxHands: 2, minConfidence: 0.5, bgMode: 1, mirrored: 1
      });
      const vo    = makeNode("VisualOutput",   360, 80, { display: 0 });
      state.edges.push({ from: { node: hands, port: "out" }, to: { node: vo, port: "in" } });
    }
  },

  /* v0.3.6 — Gesture-controlled audio demo. Closes Path A
   * (live-control → JS-side push → worklet setter → C++ class) by
   * driving an actual audio chain from MediaPipe values:
   *   h1_pinch  →  Sine.freq    (mapped through Mul + Add to a
   *                              useful Hz range; pinch tighter to
   *                              lower the pitch, spread to raise)
   *   h1_y      →  BiquadLP.cutoff (hand height = filter cutoff,
   *                                 wrist down = closed, wrist up
   *                                 = open)
   *   h1_open   →  Mul.b        (gate: fist mutes, spread fingers
   *                              open up the amplitude)
   * Plus the visual side: HandLandmarker.out → VisualOutput so the
   * user sees their hand tracked while playing the synth.
   *
   * Press ▶ to compile + play. First load: camera permission +
   * MediaPipe model download + Gamma compile. Then make sounds with
   * your hand. */
  {
    id: "gesture-synth",
    name: "Gesture Synth",
    sub: "pinch + wave → audible",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.85)"/>
      <g stroke="rgba(200,232,90,0.9)" stroke-width="0.8" stroke-linecap="round" fill="rgba(200,232,90,0.9)">
        <circle cx="22" cy="22" r="0.9"/>
        <circle cx="18" cy="14" r="0.7"/>
        <circle cx="22" cy="10" r="0.7"/>
        <circle cx="26" cy="12" r="0.7"/>
        <line x1="22" y1="22" x2="18" y2="14" stroke-width="0.6"/>
        <line x1="22" y1="22" x2="22" y2="10" stroke-width="0.6"/>
        <line x1="22" y1="22" x2="26" y2="12" stroke-width="0.6"/>
      </g>
      <!-- arrow → -->
      <path d="M 38 22 L 56 22 M 50 18 L 56 22 L 50 26"
            stroke="rgba(178,100,200,0.85)" stroke-width="1.0" fill="none" stroke-linecap="round"/>
      <!-- waveform -->
      <path d="M 60 22 Q 65 14 70 22 T 80 22 T 90 22"
            stroke="rgba(131,232,255,0.9)" stroke-width="1.2" fill="none" stroke-linecap="round"/>
      <text x="50" y="40" text-anchor="middle"
            font-family="monospace" font-size="4.2" fill="rgba(178,100,200,0.75)"
            letter-spacing="0.10em">GESTURE → AUDIO</text>
    </svg>`,
    build: () => {
      const hands = makeNode("HandLandmarker", 40,  60, {
        maxHands: 1, minConfidence: 0.5, bgMode: 1, mirrored: 1
      });
      const vo    = makeNode("VisualOutput",   360, 60, { display: 0 });
      state.edges.push({ from: { node: hands, port: "out" }, to: { node: vo, port: "in" } });

      // pinch (~0..0.30) → freq via a Mul (gain 2000) + Add (base 220).
      // Tight pinch ≈ 220 Hz, full spread ≈ 220 + 0.30*2000 = 820 Hz.
      const sine  = makeNode("Sine",      40, 240, { freq: 220 });
      const mulF  = makeNode("Mul",      220, 240, { b: 2000 });   // scale pinch
      const addF  = makeNode("Add",      400, 240, { b: 220 });    // base freq
      state.edges.push({ from: { node: hands, port: "h1_pinch" }, to: { node: mulF, port: "a" } });
      state.edges.push({ from: { node: mulF,  port: "out"     }, to: { node: addF, port: "a" } });
      state.edges.push({ from: { node: addF,  port: "out"     }, to: { node: sine, port: "freq" } });

      // h1_y (0=top, 1=bottom) → BiquadLP cutoff. Hand UP = bright,
      // hand DOWN = closed. Invert via (1 - y), then map 0..1 → 200..8200 Hz.
      const inv   = makeNode("Mul",      40, 380, { b: -1 });
      const inv2  = makeNode("Add",     220, 380, { b: 1 });
      const mulC  = makeNode("Mul",     400, 380, { b: 8000 });
      const addC  = makeNode("Add",     580, 380, { b: 200 });
      state.edges.push({ from: { node: hands, port: "h1_y" }, to: { node: inv,  port: "a" } });
      state.edges.push({ from: { node: inv,   port: "out" }, to: { node: inv2, port: "a" } });
      state.edges.push({ from: { node: inv2,  port: "out" }, to: { node: mulC, port: "a" } });
      state.edges.push({ from: { node: mulC,  port: "out" }, to: { node: addC, port: "a" } });

      // v0.3.7 — presence-gated amplitude. HandLandmarker.present is
      // 1 when any hand is tracked, 0 otherwise. Multiply through a
      // 0.5 scale so the gated tone sits at a comfortable level
      // (Sine is ±1 peak; ×0.5 → ±0.5 → ~ -6 dBFS).
      const filt = makeNode("BiquadLP", 760, 240, { cutoff: 1200, q: 1.4 });
      const lvl  = makeNode("Mul",      940, 380, { b: 0.5 });
      const amp  = makeNode("Mul",      940, 240);
      const out  = makeNode("Output",  1120, 240);
      state.edges.push({ from: { node: sine, port: "out"     }, to: { node: filt, port: "in"     } });
      state.edges.push({ from: { node: addC, port: "out"     }, to: { node: filt, port: "cutoff" } });
      state.edges.push({ from: { node: filt, port: "out"     }, to: { node: amp,  port: "a"      } });
      state.edges.push({ from: { node: hands, port: "present" }, to: { node: lvl,  port: "a"     } });
      state.edges.push({ from: { node: lvl,  port: "out"     }, to: { node: amp,  port: "b"      } });
      state.edges.push({ from: { node: amp,  port: "out"     }, to: { node: out,  port: "L"      } });
    }
  },

  /* Hand Piano (v0.3.10) — HandKeyboard plays scale notes from
   * hand x-position. Same gate / freq pair you'd get from KeyboardIn,
   * but driven by where your hand points across the camera frame.
   *
   * Pentatonic mode (minor) × 2 octaves → 10 zones across the screen.
   * Sweep your hand left-to-right and you walk up the scale; raise /
   * lower for tonal contour (h1_y modulates the filter). gate drives
   * an AD envelope so each note has a pluck attack — much more
   * musical than a continuous tone. */
  {
    id: "hand-piano",
    name: "Hand Piano",
    sub: "hand-x → scale notes",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.85)"/>
      <!-- piano keys -->
      <g fill="rgba(200,232,90,0.18)" stroke="rgba(178,100,200,0.45)" stroke-width="0.4">
        <rect x="10" y="24" width="9" height="16"/>
        <rect x="19" y="24" width="9" height="16"/>
        <rect x="28" y="24" width="9" height="16"/>
        <rect x="37" y="24" width="9" height="16"/>
        <rect x="46" y="24" width="9" height="16"/>
        <rect x="55" y="24" width="9" height="16"/>
        <rect x="64" y="24" width="9" height="16"/>
        <rect x="73" y="24" width="9" height="16"/>
        <rect x="82" y="24" width="9" height="16"/>
      </g>
      <!-- one highlighted key -->
      <rect x="46" y="24" width="9" height="16" fill="rgba(200,232,90,0.55)" stroke="rgba(200,232,90,0.95)" stroke-width="0.6"/>
      <!-- hand sketch -->
      <g stroke="rgba(131,232,255,0.95)" stroke-width="0.7" stroke-linecap="round" fill="rgba(131,232,255,0.95)">
        <line x1="50" y1="20" x2="50" y2="10" stroke-width="0.5"/>
        <circle cx="50" cy="20" r="1.0"/>
        <circle cx="50" cy="10" r="0.8"/>
      </g>
    </svg>`,
    build: () => {
      // HandKeyboard: pentatonic × 2 octaves, rooted at A3 (69 - 12 = 57)
      // so the comfortable midrange sits where most hands naturally rest.
      const kb   = makeNode("HandKeyboard", 40, 60, {
        scaleRoot: 57, scaleMode: "pentatonic", octaves: 2,
        maxHands: 1, minConfidence: 0.5, bgMode: 1, mirrored: 1
      });
      const vo   = makeNode("VisualOutput", 360, 60, { display: 0 });
      state.edges.push({ from: { node: kb, port: "out" }, to: { node: vo, port: "in" } });

      // Sine voice — kb.freq → Sine.freq, kb.gate triggers an AD envelope
      // that gates the amplitude.
      const sine = makeNode("Sine",      40, 240, { freq: 220 });
      const env  = makeNode("AD",       220, 240, { attack: 0.005, decay: 0.45 });
      const amp  = makeNode("Mul",      420, 240);
      const lvl  = makeNode("Mul",      420, 340, { b: 0.5 });

      state.edges.push({ from: { node: kb,   port: "freq" }, to: { node: sine, port: "freq" } });
      state.edges.push({ from: { node: kb,   port: "gate" }, to: { node: env,  port: "trig" } });
      state.edges.push({ from: { node: sine, port: "out"  }, to: { node: amp,  port: "a"    } });
      state.edges.push({ from: { node: env,  port: "out"  }, to: { node: lvl,  port: "a"    } });
      state.edges.push({ from: { node: lvl,  port: "out"  }, to: { node: amp,  port: "b"    } });

      // Light low-pass filter to round off the edges, then Output.
      const filt = makeNode("BiquadLP", 600, 240, { cutoff: 3500, q: 0.7 });
      const out  = makeNode("Output",   780, 240);
      state.edges.push({ from: { node: amp,  port: "out" }, to: { node: filt, port: "in" } });
      state.edges.push({ from: { node: filt, port: "out" }, to: { node: out,  port: "L"  } });
    }
  },

  /* 2-Hand Theremin — true gestural theremin. Right hand height controls
   * pitch (exponential, ~3 octaves A2→A5, musically natural); left hand
   * pinch acts as the volume-antenna's gate — notes only sound when the
   * left thumb + index touch. Both hands must be visible. Hand assignment
   * is SPATIAL (rightmost-on-screen hand = pitch hand) so it works
   * regardless of which hand MediaPipe detects first, AND the user can
   * see what the detector sees via the live skeleton overlay
   * (phosphor=left, cyan=right). Smoothstep on the pinch gate avoids
   * zipper clicks; both-present guard keeps it silent when a hand
   * leaves the frame. */
  {
    id: "two-hand-theremin",
    name: "2-Hand Theremin",
    sub: "right=pitch · left pinch=gate",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(8,10,14,0.95)"/>
      <!-- gate hand (left, phosphor) pinching -->
      <g stroke="rgba(200,232,90,0.95)" stroke-width="0.7" stroke-linecap="round" fill="rgba(200,232,90,0.95)">
        <circle cx="20" cy="28" r="1.3"/>
        <line x1="20" y1="28" x2="16" y2="22"/>
        <line x1="20" y1="28" x2="22" y2="22"/>
        <circle cx="16" cy="22" r="0.9"/>
        <circle cx="22" cy="22" r="0.9"/>
        <line x1="16" y1="22" x2="22" y2="22" stroke-dasharray="1 1.4"/>
      </g>
      <!-- pitch hand (right, cyan) high -->
      <g stroke="rgba(131,232,255,0.95)" stroke-width="0.7" stroke-linecap="round" fill="rgba(131,232,255,0.95)">
        <circle cx="80" cy="14" r="1.3"/>
        <line x1="80" y1="14" x2="74" y2="6"/>
        <line x1="80" y1="14" x2="80" y2="5"/>
        <line x1="80" y1="14" x2="86" y2="6"/>
        <line x1="80" y1="14" x2="88" y2="11"/>
        <circle cx="74" cy="6" r="0.7"/>
        <circle cx="80" cy="5" r="0.7"/>
        <circle cx="86" cy="6" r="0.7"/>
        <circle cx="88" cy="11" r="0.7"/>
      </g>
      <!-- waveform between -->
      <path d="M 36 32 Q 41 26 46 32 T 56 32 T 66 32"
            stroke="rgba(178,100,200,0.85)" stroke-width="1.0" fill="none" stroke-linecap="round"/>
      <text x="50" y="42" text-anchor="middle"
            font-family="monospace" font-size="4.2" fill="rgba(178,100,200,0.85)"
            letter-spacing="0.12em">THEREMIN</text>
    </svg>`,
    build: () => {
      // ── Vision: MediaPipe hand landmarker + live preview into VisualOutput
      const hands = makeNode("HandLandmarker", 40, 60, {
        maxHands: 2, minConfidence: 0.5, bgMode: 1, mirrored: 1
      });
      const vo = makeNode("VisualOutput", 360, 60, { display: 0 });
      state.edges.push({ from: { node: hands, port: "out" }, to: { node: vo, port: "in" } });

      // ── Spatial hand assignment. MediaPipe returns hands by detection
      // order, not handedness — so we sort by horizontal position.
      // MediaPipe's x is the RAW camera coord (the `mirrored` flag only
      // flips the visualization, not the data). In selfie view the user's
      // RIGHT hand therefore has the LOWER h_x. So:
      //   diff = h2_x − h1_x  → positive when h1 is the user's right hand
      //   selH1R = (Sign(diff) + 1) / 2  → 1 if h1 is right hand, 0 else
      //   selH2R = 1 − selH1R
      const xDiff = makeNode("Sub", 40, 200);
      state.edges.push({ from: { node: hands, port: "h2_x" }, to: { node: xDiff, port: "a" } });
      state.edges.push({ from: { node: hands, port: "h1_x" }, to: { node: xDiff, port: "b" } });
      const xSign = makeNode("Sign", 200, 200);
      state.edges.push({ from: { node: xDiff, port: "out" }, to: { node: xSign, port: "in" } });
      const selBias = makeNode("Add", 360, 200, { b: 1 });
      state.edges.push({ from: { node: xSign, port: "out" }, to: { node: selBias, port: "a" } });
      const selH1R = makeNode("Mul", 520, 200, { b: 0.5 });
      state.edges.push({ from: { node: selBias, port: "out" }, to: { node: selH1R, port: "a" } });
      const selH2R = makeNode("Sub", 680, 200, { a: 1 });
      state.edges.push({ from: { node: selH1R, port: "out" }, to: { node: selH2R, port: "b" } });

      // ── Pitch-hand Y = weighted blend of h1_y and h2_y, picked spatially.
      const w1y = makeNode("Mul", 40, 340);
      state.edges.push({ from: { node: hands, port: "h1_y" }, to: { node: w1y, port: "a" } });
      state.edges.push({ from: { node: selH1R, port: "out" }, to: { node: w1y, port: "b" } });
      const w2y = makeNode("Mul", 200, 340);
      state.edges.push({ from: { node: hands, port: "h2_y" }, to: { node: w2y, port: "a" } });
      state.edges.push({ from: { node: selH2R, port: "out" }, to: { node: w2y, port: "b" } });
      const pitchY = makeNode("Add", 360, 340);
      state.edges.push({ from: { node: w1y, port: "out" }, to: { node: pitchY, port: "a" } });
      state.edges.push({ from: { node: w2y, port: "out" }, to: { node: pitchY, port: "b" } });

      // ── Gate-hand pinch = the OTHER hand's pinch (user's left). When h1
      // is the right hand (selH1R=1), the gate-hand is h2, so use h2_pinch.
      const w1p = makeNode("Mul", 40, 460);
      state.edges.push({ from: { node: hands, port: "h1_pinch" }, to: { node: w1p, port: "a" } });
      state.edges.push({ from: { node: selH2R, port: "out" }, to: { node: w1p, port: "b" } });
      const w2p = makeNode("Mul", 200, 460);
      state.edges.push({ from: { node: hands, port: "h2_pinch" }, to: { node: w2p, port: "a" } });
      state.edges.push({ from: { node: selH1R, port: "out" }, to: { node: w2p, port: "b" } });
      const gatePinch = makeNode("Add", 360, 460);
      state.edges.push({ from: { node: w1p, port: "out" }, to: { node: gatePinch, port: "a" } });
      state.edges.push({ from: { node: w2p, port: "out" }, to: { node: gatePinch, port: "b" } });

      // ── Pitch curve: freq = 110 · exp((1 − pitchY) · ln 8)
      //   pitchY=1 (hand at bottom) → 110 Hz (A2)
      //   pitchY=0 (hand at top)    → 880 Hz (A5)   — three octaves of glide
      // Exponential mapping is musically natural — same #semitones per cm
      // at any height, like a real theremin antenna's field.
      const yInv = makeNode("Sub", 520, 340, { a: 1 });
      state.edges.push({ from: { node: pitchY, port: "out" }, to: { node: yInv, port: "b" } });
      const expArg = makeNode("Mul", 680, 340, { b: 2.0794 });   // ln(8) ≈ 3 octaves
      state.edges.push({ from: { node: yInv, port: "out" }, to: { node: expArg, port: "a" } });
      const ratio = makeNode("Exp", 840, 340);
      state.edges.push({ from: { node: expArg, port: "out" }, to: { node: ratio, port: "in" } });
      const freq = makeNode("Mul", 1000, 340, { b: 110 });
      state.edges.push({ from: { node: ratio, port: "out" }, to: { node: freq, port: "a" } });

      // ── Pinch gate: pinch≈0 (thumb+index touching) → gate=1; pinch≥~0.17
      // (fingers apart) → gate=0. Wider continuous response than a hard
      // threshold gives the feel of a real theremin's volume antenna —
      // a smoothly modulated loudness, not an on/off switch.
      const pNorm = makeNode("Mul", 520, 460, { b: 6 });
      state.edges.push({ from: { node: gatePinch, port: "out" }, to: { node: pNorm, port: "a" } });
      const sm = makeNode("Smoothstep", 680, 460);
      state.edges.push({ from: { node: pNorm, port: "out" }, to: { node: sm, port: "in" } });
      const pinchGate = makeNode("Sub", 840, 460, { a: 1 });   // 1 − smoothstep
      state.edges.push({ from: { node: sm, port: "out" }, to: { node: pinchGate, port: "b" } });
      // Gate slew: a 5 Hz lowpass (~30 ms time constant) gives the audible
      // soft swell of a theremin's volume hand instead of a discrete click.
      // It's the single most "theremin-y" thing after vibrato.
      const gateSmooth = makeNode("BiquadLP", 1000, 460, { cutoff: 5, q: 0.7 });
      state.edges.push({ from: { node: pinchGate, port: "out" }, to: { node: gateSmooth, port: "in" } });

      // ── Both-hands-present guard: silent unless numHands ≥ 2.
      const nhSub = makeNode("Sub", 40, 580, { b: 1.99 });
      state.edges.push({ from: { node: hands, port: "numHands" }, to: { node: nhSub, port: "a" } });
      const nhScale = makeNode("Mul", 200, 580, { b: 100 });
      state.edges.push({ from: { node: nhSub, port: "out" }, to: { node: nhScale, port: "a" } });
      const bothPresent = makeNode("Smoothstep", 360, 580);
      state.edges.push({ from: { node: nhScale, port: "out" }, to: { node: bothPresent, port: "in" } });
      const fullGate = makeNode("Mul", 1160, 520);
      state.edges.push({ from: { node: gateSmooth, port: "out" }, to: { node: fullGate, port: "a" } });
      state.edges.push({ from: { node: bothPresent, port: "out" }, to: { node: fullGate, port: "b" } });

      // ── Pitch smoothing: lowpass the per-frame freq updates so the
      // pitch glides instead of stair-stepping at MediaPipe's ~60 Hz
      // refresh rate. 22 Hz cutoff ≈ 7 ms time constant — responsive
      // but zipper-free.
      const freqSmooth = makeNode("BiquadLP", 1160, 340, { cutoff: 22, q: 0.7 });
      state.edges.push({ from: { node: freq, port: "out" }, to: { node: freqSmooth, port: "in" } });

      // ── Vibrato — the defining theremin sonic feature. Without it,
      // even a perfect sine sounds like a tone generator. ~5.5 Hz at
      // ±1.8% (~31 cents) is gentle, always-on, performer-like.
      // vibFactor = 1 + 0.018 · sin(2π · 5.5 t) ∈ [0.982, 1.018]
      const vibLFO = makeNode("Sine", 40, 760, { freq: 5.5 });
      const vibDepth = makeNode("Mul", 220, 760, { b: 0.018 });
      state.edges.push({ from: { node: vibLFO, port: "out" }, to: { node: vibDepth, port: "a" } });
      const vibFactor = makeNode("Add", 400, 760, { b: 1 });
      state.edges.push({ from: { node: vibDepth, port: "out" }, to: { node: vibFactor, port: "a" } });
      const modFreq = makeNode("Mul", 1320, 340);
      state.edges.push({ from: { node: freqSmooth, port: "out" }, to: { node: modFreq, port: "a" } });
      state.edges.push({ from: { node: vibFactor, port: "out" }, to: { node: modFreq, port: "b" } });

      // ── Fundamental + gentle 2nd harmonic for theremin warmth. A pure
      // sine sounds clinical; a small dose (~13%) of 2nd harmonic
      // approximates the soft heterodyne overtones of a real theremin
      // circuit without making it brassy.
      const fund = makeNode("Sine", 1480, 340, { freq: 220 });
      state.edges.push({ from: { node: modFreq, port: "out" }, to: { node: fund, port: "freq" } });
      const h2Freq = makeNode("Mul", 1320, 440, { b: 2 });
      state.edges.push({ from: { node: modFreq, port: "out" }, to: { node: h2Freq, port: "a" } });
      const h2 = makeNode("Sine", 1480, 440, { freq: 440 });
      state.edges.push({ from: { node: h2Freq, port: "out" }, to: { node: h2, port: "freq" } });
      const h2Scaled = makeNode("Mul", 1640, 440, { b: 0.13 });
      state.edges.push({ from: { node: h2, port: "out" }, to: { node: h2Scaled, port: "a" } });
      const blended = makeNode("Add", 1640, 340);
      state.edges.push({ from: { node: fund, port: "out" }, to: { node: blended, port: "a" } });
      state.edges.push({ from: { node: h2Scaled, port: "out" }, to: { node: blended, port: "b" } });

      // ── Soft tube-style saturation. 1.3× pre-boost, Tanh rounds the
      // peaks for vacuum-tube warmth without audible clipping.
      const preSat = makeNode("Mul", 1800, 340, { b: 1.3 });
      state.edges.push({ from: { node: blended, port: "out" }, to: { node: preSat, port: "a" } });
      const warmed = makeNode("Tanh", 1960, 340);
      state.edges.push({ from: { node: preSat, port: "out" }, to: { node: warmed, port: "in" } });

      // ── Apply the gate
      const voice = makeNode("Mul", 2120, 340);
      state.edges.push({ from: { node: warmed, port: "out" }, to: { node: voice, port: "a" } });
      state.edges.push({ from: { node: fullGate, port: "out" }, to: { node: voice, port: "b" } });

      // ── PlateReverb — theremins almost always perform with reverb.
      // Decay 0.85, damping 0.45, mix 0.32 = a medium-hall character that
      // smooths the sustain without washing out the pitch articulation.
      const preRev = makeNode("Mul", 2280, 340, { b: 0.5 });
      state.edges.push({ from: { node: voice, port: "out" }, to: { node: preRev, port: "a" } });
      const reverb = makeNode("PlateReverb", 2440, 340, { decay: 0.85, damping: 0.45, mix: 0.32 });
      state.edges.push({ from: { node: preRev, port: "out" }, to: { node: reverb, port: "in" } });

      // ── Final level + stereo Output
      const finalAmp = makeNode("Mul", 2600, 340, { b: 0.7 });
      state.edges.push({ from: { node: reverb, port: "out" }, to: { node: finalAmp, port: "a" } });
      const out = makeNode("Output", 2760, 340);
      state.edges.push({ from: { node: finalAmp, port: "out" }, to: { node: out, port: "L" } });
      state.edges.push({ from: { node: finalAmp, port: "out" }, to: { node: out, port: "R" } });
    }
  },

  /* ─── Advanced (multi-node) demos ───────────────────────────── */

  {
    id: "ensemble-16",
    name: "16-Track Ensemble",
    sub: "drums · bass · pad · fx",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.5)"/>
      <g fill="var(--phosphor)" opacity="0.8">
        <rect x="6"   y="32" width="3" height="6"/>
        <rect x="12"  y="28" width="3" height="10"/>
        <rect x="18"  y="22" width="3" height="16"/>
        <rect x="24"  y="26" width="3" height="12"/>
        <rect x="30"  y="20" width="3" height="18"/>
        <rect x="36"  y="30" width="3" height="8"/>
        <rect x="42"  y="24" width="3" height="14"/>
        <rect x="48"  y="18" width="3" height="20"/>
        <rect x="54"  y="26" width="3" height="12"/>
        <rect x="60"  y="22" width="3" height="16"/>
        <rect x="66"  y="14" width="3" height="24"/>
        <rect x="72"  y="20" width="3" height="18"/>
        <rect x="78"  y="28" width="3" height="10"/>
        <rect x="84"  y="24" width="3" height="14"/>
        <rect x="90"  y="32" width="3" height="6"/>
      </g>
      <line x1="0" y1="38" x2="100" y2="38" stroke="var(--phosphor)" stroke-width="0.4" opacity="0.4"/>
    </svg>`,
    build: () => {
      // v0.2.16 polished arrangement -- per-track effects chains,
      // proper parallel FX sends, glue compression on the master bus,
      // and stereo placement so the elements occupy distinct space.
      //
      // Signal layout (left → right in the patch):
      //   Sequencers (col 1) → Voices (col 2) → Per-voice mults (col 3)
      //   → Sub-busses + FX chains (col 4)
      //   → Master mix (4 channels) → Master comp → Limiters → Output

      // ── Tempo + drum patterns ─────────────────────────────
      const clk = makeNode("MasterClock", 40, 40, { bpm: 124 });

      const stepsKick  = [true,false,false,false,true,false,false,false,true,false,false,false,true,false,false,false];
      const stepsSnare = [false,false,false,false,true,false,false,false,false,false,false,false,true,false,false,false];
      const stepsHat   = [true,false,true,false,true,false,true,false,true,false,true,false,true,false,true,false];

      const kickSeq  = makeNode("StepSeq16",       220,  40, { steps: stepsKick  });
      const snareSeq = makeNode("StepSeq16",       220, 140, { steps: stepsSnare });
      const hatSeq   = makeNode("StepSeq16",       220, 240, { steps: stepsHat   });
      const percSeq  = makeNode("EuclideanRhythm", 220, 340, { hits: 5, steps: 16, rotation: 1 });

      // MasterClock.sixteenth -> every sequencer
      state.edges.push({ from: { node: clk, port: "sixteenth" }, to: { node: kickSeq,  port: "clock" } });
      state.edges.push({ from: { node: clk, port: "sixteenth" }, to: { node: snareSeq, port: "clock" } });
      state.edges.push({ from: { node: clk, port: "sixteenth" }, to: { node: hatSeq,   port: "clock" } });
      state.edges.push({ from: { node: clk, port: "sixteenth" }, to: { node: percSeq,  port: "clock" } });

      // ── Drum voices: oscillator/noise × AD envelope ───────
      const kickOsc = makeNode("Sine",       420,  40, { freq: 55 });
      const kickEnv = makeNode("AD",         420, 100, { attack: 0.001, decay: 0.18 });
      const kickMul = makeNode("Mul",        600,  60);
      state.edges.push({ from: { node: kickSeq, port: "out" }, to: { node: kickEnv, port: "trig" } });
      state.edges.push({ from: { node: kickOsc, port: "out" }, to: { node: kickMul, port: "a" } });
      state.edges.push({ from: { node: kickEnv, port: "out" }, to: { node: kickMul, port: "b" } });

      const snareNoi = makeNode("NoiseWhite", 420, 140);
      const snareEnv = makeNode("AD",         420, 200, { attack: 0.001, decay: 0.10 });
      const snareMul = makeNode("Mul",        600, 160);
      state.edges.push({ from: { node: snareSeq, port: "out" }, to: { node: snareEnv, port: "trig" } });
      state.edges.push({ from: { node: snareNoi, port: "out" }, to: { node: snareMul, port: "a" } });
      state.edges.push({ from: { node: snareEnv, port: "out" }, to: { node: snareMul, port: "b" } });

      const hatNoi = makeNode("NoiseWhite", 420, 240);
      const hatEnv = makeNode("AD",         420, 300, { attack: 0.001, decay: 0.04 });
      const hatMul = makeNode("Mul",        600, 260);
      state.edges.push({ from: { node: hatSeq, port: "out" }, to: { node: hatEnv, port: "trig" } });
      state.edges.push({ from: { node: hatNoi, port: "out" }, to: { node: hatMul, port: "a" } });
      state.edges.push({ from: { node: hatEnv, port: "out" }, to: { node: hatMul, port: "b" } });

      const percOsc = makeNode("Sine",      420, 340, { freq: 380 });
      const percEnv = makeNode("AD",        420, 400, { attack: 0.001, decay: 0.06 });
      const percMul = makeNode("Mul",       600, 360);
      state.edges.push({ from: { node: percSeq, port: "out" }, to: { node: percEnv, port: "trig" } });
      state.edges.push({ from: { node: percOsc, port: "out" }, to: { node: percMul, port: "a" } });
      state.edges.push({ from: { node: percEnv, port: "out" }, to: { node: percMul, port: "b" } });

      // ── Drum submix + glue compression ────────────────────
      // 4-channel bus sums all drums, then a Compressor adds gentle
      // glue (2.5:1 above 0.6 threshold, 1.3× makeup) so transients
      // sit together instead of stacking peaks.
      const drumBus  = makeNode("AudioBus",   800, 200, { lvl1: 1.0, lvl2: 0.85, lvl3: 0.55, lvl4: 0.55 });
      const drumComp = makeNode("Compressor", 980, 200, { threshold: 0.6, ratio: 2.5, attack: 6, release: 90, makeup: 1.3 });
      state.edges.push({ from: { node: kickMul,  port: "out" }, to: { node: drumBus,  port: "in1" } });
      state.edges.push({ from: { node: snareMul, port: "out" }, to: { node: drumBus,  port: "in2" } });
      state.edges.push({ from: { node: hatMul,   port: "out" }, to: { node: drumBus,  port: "in3" } });
      state.edges.push({ from: { node: percMul,  port: "out" }, to: { node: drumBus,  port: "in4" } });
      state.edges.push({ from: { node: drumBus,  port: "out" }, to: { node: drumComp, port: "in" } });

      // ── Parallel FX send: snare + perc -> PlateReverb ─────
      // True parallel send: reverbBus sums the "wet candidates", the
      // PlateReverb runs at mix=1.0 (fully wet, no dry pass-through),
      // and its output joins the master mix as its own channel
      // alongside the dry drumComp. Kick stays bone-dry so the low
      // end doesn't get smeared by reverb diffusion.
      const reverbBus = makeNode("AudioBus",   980, 320, { lvl1: 1.0, lvl2: 0.7, lvl3: 0, lvl4: 0 });
      const reverb    = makeNode("PlateReverb",1160, 320, { decay: 0.7, mix: 1.0 });
      state.edges.push({ from: { node: snareMul,  port: "out" }, to: { node: reverbBus, port: "in1" } });
      state.edges.push({ from: { node: percMul,   port: "out" }, to: { node: reverbBus, port: "in2" } });
      state.edges.push({ from: { node: reverbBus, port: "out" }, to: { node: reverb,    port: "in"  } });

      // ── Bass: HP-clean -> LP -> compressor (controlled low end) ─
      const bassSeq = makeNode("StepSeq16", 220, 480, {
        steps: [true,false,false,true,false,false,true,false,
                true,false,false,true,false,true,false,false]
      });
      const bassOsc  = makeNode("Sine",       420, 480, { freq: 82.4 });   // E2
      const bassEnv  = makeNode("AD",         420, 540, { attack: 0.005, decay: 0.30 });
      const bassMul  = makeNode("Mul",        600, 500);
      const bassHp   = makeNode("BiquadHP",   760, 500, { cutoff: 45,  q: 0.7 });   // sub-clean
      const bassLp   = makeNode("BiquadLP",   920, 500, { cutoff: 700, q: 2.0 });   // body resonance
      const bassComp = makeNode("Compressor",1080, 500, { threshold: 0.55, ratio: 3, attack: 4, release: 70, makeup: 1.25 });
      state.edges.push({ from: { node: clk,     port: "sixteenth" }, to: { node: bassSeq,  port: "clock" } });
      state.edges.push({ from: { node: bassSeq, port: "out"      }, to: { node: bassEnv,  port: "trig"  } });
      state.edges.push({ from: { node: bassOsc, port: "out"      }, to: { node: bassMul,  port: "a"     } });
      state.edges.push({ from: { node: bassEnv, port: "out"      }, to: { node: bassMul,  port: "b"     } });
      state.edges.push({ from: { node: bassMul, port: "out"      }, to: { node: bassHp,   port: "in"    } });
      state.edges.push({ from: { node: bassHp,  port: "out"      }, to: { node: bassLp,   port: "in"    } });
      state.edges.push({ from: { node: bassLp,  port: "out"      }, to: { node: bassComp, port: "in"    } });

      // ── Pad: detuned Sines -> LP -> Tremolo -> tempo delay ─
      // Tremolo adds slow amplitude motion (0.4 Hz, 18% depth) so the
      // sustained tone breathes; TempoSyncDelay locked to a 1/8 note
      // adds rhythmic echoes that lock to the kick pattern.
      const padA       = makeNode("Sine",          420, 640, { freq: 220.0 });   // A3
      const padB       = makeNode("Sine",          420, 700, { freq: 220.4 });   // A3 + ~3 cents detune
      const padSum     = makeNode("Add",           600, 660);
      const padLp      = makeNode("BiquadLP",      760, 660, { cutoff: 1400, q: 0.7 });
      const padTrem    = makeNode("Tremolo",       920, 660, { rate: 0.4, depth: 0.18 });
      const padDelay   = makeNode("TempoSyncDelay",1080, 660, { division: 0.5, feedback: 0.42, mix: 0.22 });
      state.edges.push({ from: { node: padA,     port: "out" }, to: { node: padSum,   port: "a" } });
      state.edges.push({ from: { node: padB,     port: "out" }, to: { node: padSum,   port: "b" } });
      state.edges.push({ from: { node: padSum,   port: "out" }, to: { node: padLp,    port: "in" } });
      state.edges.push({ from: { node: padLp,    port: "out" }, to: { node: padTrem,  port: "in" } });
      state.edges.push({ from: { node: padTrem,  port: "out" }, to: { node: padDelay, port: "in" } });
      // Wire MasterClock.bpm into the delay so changing tempo keeps it locked.
      state.edges.push({ from: { node: clk, port: "bpm" }, to: { node: padDelay, port: "bpm" } });

      // ── Master mix (4 channels, panned for stereo placement) ─
      //   ch1 = drum bus (post-comp)   center
      //   ch2 = reverb return           slight left wash (0.4)
      //   ch3 = bass (post-comp)        center
      //   ch4 = pad (post-delay)        slight right (0.65)
      const mix = makeNode("MasterMix", 1320, 360, {
        lvl1: 1.0,  lvl2: 0.5,  lvl3: 0.9,  lvl4: 0.7,
        pan1: 0.5,  pan2: 0.4,  pan3: 0.5,  pan4: 0.65,
        master: 0.85
      });
      state.edges.push({ from: { node: drumComp, port: "out" }, to: { node: mix, port: "in1" } });
      state.edges.push({ from: { node: reverb,   port: "out" }, to: { node: mix, port: "in2" } });
      state.edges.push({ from: { node: bassComp, port: "out" }, to: { node: mix, port: "in3" } });
      state.edges.push({ from: { node: padDelay, port: "out" }, to: { node: mix, port: "in4" } });

      // ── Master bus polish: glue compression then brick-wall limit ─
      // Per-channel master compressor (gentle 2:1 above 0.7 with slow
      // attack so transients are preserved, fast release for transparency)
      // then a Limiter as a safety net before the output. Limiter
      // threshold is linear amplitude, not dB.
      const masterCompL = makeNode("Compressor", 1500, 320, { threshold: 0.7, ratio: 2, attack: 10, release: 100, makeup: 1.1 });
      const masterCompR = makeNode("Compressor", 1500, 400, { threshold: 0.7, ratio: 2, attack: 10, release: 100, makeup: 1.1 });
      state.edges.push({ from: { node: mix, port: "L" }, to: { node: masterCompL, port: "in" } });
      state.edges.push({ from: { node: mix, port: "R" }, to: { node: masterCompR, port: "in" } });

      const limL = makeNode("Limiter", 1680, 320, { threshold: 0.95, attack: 1, release: 80 });
      const limR = makeNode("Limiter", 1680, 400, { threshold: 0.95, attack: 1, release: 80 });
      state.edges.push({ from: { node: masterCompL, port: "out" }, to: { node: limL, port: "in" } });
      state.edges.push({ from: { node: masterCompR, port: "out" }, to: { node: limR, port: "in" } });

      const out = makeNode("OutputStereo", 1860, 360);
      state.edges.push({ from: { node: limL, port: "out" }, to: { node: out, port: "L" } });
      state.edges.push({ from: { node: limR, port: "out" }, to: { node: out, port: "R" } });
    }
  },

  {
    id: "composite-stack",
    name: "Composite Stack",
    sub: "stars · plasma · butterflies · text",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <defs>
        <linearGradient id="dg-stk" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0"   stop-color="rgba(0,0,0,1)"/>
          <stop offset="0.5" stop-color="rgba(200,232,90,0.35)"/>
          <stop offset="1"   stop-color="rgba(131,232,255,0.5)"/>
        </linearGradient>
      </defs>
      <rect width="100" height="44" fill="url(#dg-stk)"/>
      <g fill="var(--phosphor)" opacity="0.9">
        <circle cx="12" cy="10" r="0.7"/><circle cx="28" cy="14" r="0.5"/>
        <circle cx="55" cy="9"  r="0.8"/><circle cx="82" cy="14" r="0.6"/>
        <circle cx="20" cy="36" r="0.5"/><circle cx="72" cy="33" r="0.7"/>
      </g>
      <g fill="rgba(232,140,60,0.9)">
        <path d="M 50 22 Q 38 12 32 17 Q 40 23 50 22 Z"/>
        <path d="M 50 22 Q 62 12 68 17 Q 60 23 50 22 Z"/>
      </g>
      <text x="50" y="38" text-anchor="middle" font-family="monospace" font-size="6" font-weight="bold" fill="rgba(255,255,255,0.85)" letter-spacing="0.06em">GAMMA</text>
    </svg>`,
    build: () => {
      const clk    = makeNode("MasterClock", 40, 40, { bpm: 120 });

      // Layer A: StarNest (cosmic backdrop, audio-reactive)
      const stars  = makeNode("StarNest",     40, 160, { audioReact: 4, bassReact: 6 });

      // Layer B: Plasma (mid-layer, beat-synced)
      const plasma = makeNode("Plasma",       40, 320, { speed: 0.4, audioReact: 2, clockReact: 0 });

      // Layer C: Butterflies (overlay, alpha-clean)
      const butter = makeNode("Butterflies",  40, 480, { speed: 1.2, audioReact: 3, bassReact: 4 });

      // Layer D: Text overlay
      const text   = makeNode("Text",         40, 640, { text: "GAMMA NODE", yawDeg: 0, pitchDeg: -25, sizeDeg: 10, r: 0.78, g: 0.91, b: 0.35 });

      // Beat-sync: clock drives all three reactive shaders
      state.edges.push({ from: { node: clk, port: "beat" }, to: { node: plasma, port: "clockReact" } });
      state.edges.push({ from: { node: clk, port: "beat" }, to: { node: butter, port: "clockReact" } });
      state.edges.push({ from: { node: clk, port: "beat" }, to: { node: stars,  port: "clockReact" } });

      // Composition chain:
      //   stars + plasma   (mode=2 multiply)   -> mix1
      //   mix1 + butterflies (mode=5 alpha-over) -> mix2
      //   mix2 + text      (mode=5 alpha-over) -> mix3
      //   mix3 through ColorCorrect              -> VO
      const mix1 = makeNode("BlendShader", 280, 240, { mode: 4, mix: 0.55 });   // overlay
      const mix2 = makeNode("BlendShader", 480, 320, { mode: 5, mix: 1.0 });    // alpha-over
      const mix3 = makeNode("BlendShader", 680, 400, { mode: 5, mix: 1.0 });    // alpha-over
      const cc   = makeNode("ColorCorrect",880, 400, { brightness: 0.05, contrast: 1.15, saturation: 1.2, hueShift: 0, gamma: 1.0 });
      const vo   = makeNode("VisualOutput",1080, 400, { display: 0 });

      // Wire blends
      state.edges.push({ from: { node: stars,  port: "out" }, to: { node: mix1, port: "inA" } });
      state.edges.push({ from: { node: plasma, port: "out" }, to: { node: mix1, port: "inB" } });

      state.edges.push({ from: { node: butter, port: "out" }, to: { node: mix2, port: "inA" } });
      state.edges.push({ from: { node: mix1,   port: "out" }, to: { node: mix2, port: "inB" } });

      state.edges.push({ from: { node: text,   port: "out" }, to: { node: mix3, port: "inA" } });
      state.edges.push({ from: { node: mix2,   port: "out" }, to: { node: mix3, port: "inB" } });

      state.edges.push({ from: { node: mix3, port: "out" }, to: { node: cc, port: "in" } });
      state.edges.push({ from: { node: cc,   port: "out" }, to: { node: vo, port: "in" } });
    }
  },

  {
    id: "allosphere-dome",
    name: "AlloSphere Dome",
    sub: "26-projector calibration · stars",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(0,0,0,0.7)"/>
      <!-- dome silhouette -->
      <path d="M 8 38 Q 50 -2 92 38 Z" fill="rgba(200,232,90,0.10)" stroke="var(--phosphor)" stroke-width="0.7" opacity="0.9"/>
      <!-- projector frusta -->
      <g stroke="rgba(131,232,255,0.85)" stroke-width="0.5" fill="none">
        <line x1="20" y1="38" x2="30" y2="14"/>
        <line x1="35" y1="38" x2="42" y2="8"/>
        <line x1="50" y1="38" x2="50" y2="6"/>
        <line x1="65" y1="38" x2="58" y2="8"/>
        <line x1="80" y1="38" x2="70" y2="14"/>
      </g>
      <g fill="rgba(232,140,60,0.9)">
        <circle cx="20" cy="38" r="1.2"/>
        <circle cx="35" cy="38" r="1.2"/>
        <circle cx="50" cy="38" r="1.2"/>
        <circle cx="65" cy="38" r="1.2"/>
        <circle cx="80" cy="38" r="1.2"/>
      </g>
    </svg>`,
    build: () => {
      // Switch the rig to the 26-projector AlloSphere preset.
      // applyRigTemplate populates state.rig.displays + reallocates
      // the framebuffer; nothing else in the demo needs to touch
      // the rig directly.
      try { applyRigTemplate("allosphere-real"); }
      catch (e) { console.warn("[demo:allosphere] applyRigTemplate failed:", e); }
      const displayCount = (state.rig && state.rig.displays && state.rig.displays.length) || 26;

      // One source -> all displays. The framework runs the shader
      // once per VO with the VO's display pose, so each projector
      // sees its own pose-correct view of the same world scene.
      const clk   = makeNode("MasterClock", 40, 40, { bpm: 100 });
      const stars = makeNode("StarNest",    40, 160, { audioReact: 3, bassReact: 4 });
      state.edges.push({ from: { node: clk, port: "beat" }, to: { node: stars, port: "clockReact" } });

      // Lay out the VOs in a 7×4 grid below the shader source.
      // Same grid the tile-preview composite uses for 26 displays,
      // so the on-canvas layout reads like the visual output.
      const cols = 7;
      for (let i = 0; i < displayCount; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = 280 + col * 140;
        const y = 40  + row * 110;
        const vo = makeNode("VisualOutput", x, y, { display: i });
        state.edges.push({ from: { node: stars, port: "out" }, to: { node: vo, port: "in" } });
      }

      // A second pass of WireframeCalibration on display 0 so the
      // user has a "calibration check" reference. They can swap it
      // for any other shader without rewiring the 26 VOs.
      const cal  = makeNode("WireframeCalibration", 40, 320, {
        lineWidth: 0.5, slices: 24, stacks: 12, showGreat: 1, showBeacons: 1
      });
      // No edge wired by default — the user toggles by re-wiring
      // VOs to `cal` instead of `stars`. Comment in the patch will
      // remind them.
      void cal;
    }
  },

  /* Sprint 8.0.2 -- Scene2D + Scene25D smoke demo. Three sprites
   * arranged in a horizontal row, fed into a Scene2D + OrthoCamera2D
   * for the top output AND a Scene25D + OrthoCamera25D for the bottom.
   * Same source meshes; both scene types share a Translate per sprite
   * to position them in world space. */
  {
    id: "scene-2d-25d-demo",
    name: "Scene 2D + 2.5D",
    sub: "ortho cameras + sprites",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(10,18,34,0.85)"/>
      <g opacity="0.95">
        <rect x="14" y="6"  width="10" height="14" fill="rgba(240,120,80,0.95)"/>
        <rect x="30" y="6"  width="10" height="14" fill="rgba(120,220,180,0.95)"/>
        <rect x="46" y="6"  width="10" height="14" fill="rgba(160,140,240,0.95)"/>
      </g>
      <g opacity="0.95" transform="translate(0,22)">
        <polygon points="14,12 24,12 28,8 18,8" fill="rgba(240,120,80,0.9)"/>
        <polygon points="30,12 40,12 44,8 34,8" fill="rgba(120,220,180,0.9)"/>
        <polygon points="46,12 56,12 60,8 50,8" fill="rgba(160,140,240,0.9)"/>
      </g>
      <text x="76" y="14" fill="var(--phosphor)" font-size="8">2D</text>
      <text x="73" y="36" fill="var(--phosphor)" font-size="8">2.5D</text>
    </svg>`,
    build: () => {
      // Three colored sprites, 1×1 world units each, anchored at center
      // (default). tintR/G/B set the per-sprite color via vertex color.
      const s1 = makeNode("Sprite", 40,  60, { width: 1, height: 1, tintR: 0.95, tintG: 0.48, tintB: 0.32 });
      const s2 = makeNode("Sprite", 40, 200, { width: 1, height: 1, tintR: 0.48, tintG: 0.85, tintB: 0.72 });
      const s3 = makeNode("Sprite", 40, 340, { width: 1, height: 1, tintR: 0.65, tintG: 0.55, tintB: 0.95 });
      // Translate each into a horizontal row at y=0 z=0.
      const t1 = makeNode("Translate", 240,  60, { x: -2, y: 0, z: 0 });
      const t2 = makeNode("Translate", 240, 200, { x:  0, y: 0, z: 0 });
      const t3 = makeNode("Translate", 240, 340, { x:  2, y: 0, z: 0 });
      state.edges.push({ from: { node: s1, port: "mesh" }, to: { node: t1, port: "mesh" } });
      state.edges.push({ from: { node: s2, port: "mesh" }, to: { node: t2, port: "mesh" } });
      state.edges.push({ from: { node: s3, port: "mesh" }, to: { node: t3, port: "mesh" } });

      // ── Top: Scene2D ────────────────────────────────────────
      const cam2d = makeNode("OrthoCamera2D", 440,  60, {
        posX: 0, posY: 0,
        orthoSize: 3,
        pixelSnap: 1, pixelsPerUnit: 64
      });
      const sc2d  = makeNode("Scene2D", 640, 60, {
        clearR: 0.05, clearG: 0.07, clearB: 0.13
      });
      state.edges.push({ from: { node: t1,    port: "mesh"   }, to: { node: sc2d, port: "mesh1"  } });
      state.edges.push({ from: { node: t2,    port: "mesh"   }, to: { node: sc2d, port: "mesh2"  } });
      state.edges.push({ from: { node: t3,    port: "mesh"   }, to: { node: sc2d, port: "mesh3"  } });
      state.edges.push({ from: { node: cam2d, port: "camera" }, to: { node: sc2d, port: "camera" } });
      const vo2d = makeNode("VisualOutput", 880, 60, { display: 0 });
      state.edges.push({ from: { node: sc2d, port: "out" }, to: { node: vo2d, port: "in" } });

      // ── Bottom: Scene25D ────────────────────────────────────
      const cam25 = makeNode("OrthoCamera25D", 440, 280, {
        posX: 0, posY: 0, posZ: 0,
        angle: "iso",
        distance: 12,
        orthoSize: 4
      });
      const sc25  = makeNode("Scene25D", 640, 280, {
        clearR: 0.10, clearG: 0.13, clearB: 0.18,
        fogDensity: 0
      });
      // Wire the SAME three translated sprites into Scene25D too --
      // tests that one mesh chain can feed multiple scenes.
      state.edges.push({ from: { node: t1,    port: "mesh"   }, to: { node: sc25, port: "mesh1"  } });
      state.edges.push({ from: { node: t2,    port: "mesh"   }, to: { node: sc25, port: "mesh2"  } });
      state.edges.push({ from: { node: t3,    port: "mesh"   }, to: { node: sc25, port: "mesh3"  } });
      state.edges.push({ from: { node: cam25, port: "camera" }, to: { node: sc25, port: "camera" } });
      const vo25 = makeNode("VisualOutput", 880, 280, { display: 1 });
      state.edges.push({ from: { node: sc25, port: "out" }, to: { node: vo25, port: "in" } });
    }
  },

  /* Sprint plat-2a-render -- Sprite Texture Test. Smallest possible
   * patch that exercises the sprite pipeline end-to-end: ImageURL
   * with the preset:test4x4 built-in (64×64, 2×2 colored quadrants)
   * → Sprite (texture wired) → Translate (z=-1 to sit in front of
   * any background) → Scene2D + OrthoCamera2D → VisualOutput.
   *
   * Expected output: a single quad showing a 2×2 grid of colored
   * blocks. UV orientation is correct when:
   *   - top-left of sprite      = RED
   *   - top-right of sprite     = GREEN
   *   - bottom-left of sprite   = BLUE
   *   - bottom-right of sprite  = YELLOW
   * (Matches the preset's drawn pattern; the shader's V-flip lines
   *  up the image's top with the sprite's top in screen space.) */
  {
    id: "sprite-texture-test",
    name: "Sprite Texture Test",
    sub: "test4x4 → Sprite → Scene2D",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(10,18,34,0.85)"/>
      <g>
        <rect x="34" y="6"  width="16" height="16" fill="rgb(255,48,48)"/>
        <rect x="50" y="6"  width="16" height="16" fill="rgb(48,255,48)"/>
        <rect x="34" y="22" width="16" height="16" fill="rgb(48,96,255)"/>
        <rect x="50" y="22" width="16" height="16" fill="rgb(255,255,48)"/>
      </g>
    </svg>`,
    build: () => {
      const img = makeNode("ImageURL", 40, 60, {
        url: "preset:test4x4",
        filterMode: "nearest"
      });
      const spr = makeNode("Sprite", 240, 60, {
        width: 3, height: 3,
        anchorX: 0.5, anchorY: 0.5,
        framesX: 1, framesY: 1, frame: 0,
        tintR: 1, tintG: 1, tintB: 1, tintA: 1
      });
      state.edges.push({ from: { node: img, port: "texture" }, to: { node: spr, port: "texture" } });
      const t = makeNode("Translate", 440, 60, { x: 0, y: 0, z: -1 });
      state.edges.push({ from: { node: spr, port: "mesh" }, to: { node: t, port: "mesh" } });
      const cam = makeNode("OrthoCamera2D", 240, 240, {
        posX: 0, posY: 0,
        orthoSize: 3,
        pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 640, 60, {
        clearR: 0.08, clearG: 0.10, clearB: 0.16
      });
      state.edges.push({ from: { node: t,    port: "mesh"   }, to: { node: scene, port: "mesh1"  } });
      state.edges.push({ from: { node: cam,  port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 860, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });
    }
  },

  /* Sprint platformer-1 -- Platformer 2D demo. A single-screen
   * platformer wired entirely from nodes:
   *   KeyAxis2D       -- WASD + Space
   *   PlatformerBody2D -- physics + ground clamp
   *   Tilemap2D       -- the level
   *   Sprite          -- the player
   *   OrthoCamera2D   -- camera follow (posX wired to player.x)
   *   Scene2D + VO    -- the actual render
   * Hold A/D to walk, Space to jump. The camera tracks the player
   * horizontally; the tilemap holds the world steady. */
  {
    id: "platformer-2d",
    name: "Platformer 2D",
    sub: "WASD + Space · camera follow",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(28,40,68,0.85)"/>
      <g fill="rgba(85,140,90,0.95)">
        <rect x="0"  y="30" width="40" height="6"/>
        <rect x="48" y="30" width="20" height="6"/>
        <rect x="76" y="22" width="24" height="6"/>
        <rect x="30" y="22" width="10" height="4"/>
      </g>
      <g fill="rgba(105,68,42,0.95)">
        <rect x="0"  y="36" width="100" height="8"/>
      </g>
      <rect x="20" y="22" width="6" height="8" fill="rgba(240,180,80,1)"/>
    </svg>`,
    build: () => {
      // ─── Input ────────────────────────────────────────────────
      const keys = makeNode("KeyAxis2D", 40, 60, {
        keyLeft: "KeyA", keyRight: "KeyD",
        keyJump: "Space"
      });

      // ─── Physics body ─────────────────────────────────────────
      const body = makeNode("PlatformerBody2D", 280, 60, {
        walkSpeed: 6,
        gravity:   22,
        jumpForce: 11,
        airControl: 0.85,
        width: 0.6, height: 1.0,
        groundY:   -10,          // safety net well below the tilemap
        initX: -4, initY: 0
      });
      state.edges.push({ from: { node: keys, port: "x"    }, to: { node: body, port: "inputX" } });
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: body, port: "jump"   } });
      // tilemap wire added BELOW once `level` exists -- see after Tilemap2D.

      // ─── Level (tilemap) ──────────────────────────────────────
      // 32×9 grid. '.' = sky, '1' = grass (top), '2' = dirt (under),
      // '3' = stone platform, '4' = coin marker. Centered on world (0,0)
      // and lifted so its bottom row sits at world y = -4 (groundY-1).
      const level = makeNode("Tilemap2D", 40, 240, {
        tileData:
          "................................\n" +
          "................................\n" +
          "................................\n" +
          "................3333............\n" +
          "..........4.....................\n" +
          ".....33333......................\n" +
          "................................\n" +
          "11111111111111111111111111111111\n" +
          "22222222222222222222222222222222",
        tileSize: 1,
        originX: 0, originY: 0,
        color1R: 0.30, color1G: 0.62, color1B: 0.38,   // grass-green
        color2R: 0.42, color2G: 0.28, color2B: 0.18,   // dirt-brown
        color3R: 0.62, color3G: 0.62, color3B: 0.72,   // stone-platform
        color4R: 0.95, color4G: 0.82, color4B: 0.30    // coin-gold
      });
      // Tilemap → body for collision. Solid chars '1', '2', '3', '#'
      // by default (PlatformerBody2D.solidChars = "123#"); '4' (coin)
      // and '.' / ' ' are passable.
      state.edges.push({ from: { node: level, port: "mesh" }, to: { node: body, port: "tilemap" } });

      // ─── Player ───────────────────────────────────────────────
      const player = makeNode("Sprite", 280, 240, {
        width: 0.6, height: 1.0,
        anchorX: 0.5, anchorY: 0,         // pin-by-feet so y = ground line
        tintR: 0.95, tintG: 0.55, tintB: 0.20
      });
      // z = -1 puts the player WELL in front of the tilemap (at z=0)
      // so the reverse-Z depth test ("greater") doesn't reject it.
      // Proper fix lives in the Scene2D-dedicated pipeline (deferred).
      const playerT = makeNode("Translate", 460, 240, { x: 0, y: 0, z: -1 });
      state.edges.push({ from: { node: player, port: "mesh" }, to: { node: playerT, port: "mesh" } });
      state.edges.push({ from: { node: body,   port: "x"    }, to: { node: playerT, port: "x"    } });
      state.edges.push({ from: { node: body,   port: "y"    }, to: { node: playerT, port: "y"    } });

      // ─── Camera (follow X, fixed Y) ───────────────────────────
      const cam = makeNode("OrthoCamera2D", 460, 60, {
        posX: 0, posY: 0,
        orthoSize: 5,                     // 10 world units tall view
        pixelSnap: 0
      });
      state.edges.push({ from: { node: body, port: "x" }, to: { node: cam, port: "posX" } });

      // ─── Scene + output ───────────────────────────────────────
      const scene = makeNode("Scene2D", 680, 200, {
        clearR: 0.45, clearG: 0.72, clearB: 0.88     // sky-blue
      });
      // mesh1 = level (back), mesh2 = player (front)
      state.edges.push({ from: { node: level,    port: "mesh"   }, to: { node: scene, port: "mesh1"  } });
      state.edges.push({ from: { node: playerT,  port: "mesh"   }, to: { node: scene, port: "mesh2"  } });
      state.edges.push({ from: { node: cam,      port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 900, 200, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });
    }
  },

  /* Platformer 2D · Animated -- full intro → playing → won flow.
   *
   * Uses the §8.A engine foundation on top of the animated
   * platformer: StateMachine + StageManager drive three stages;
   * OnAwake[playing] auto-resets body/eggs/goal on each entry;
   * UIPanel + UIText + UIButton for intro and win screens.
   * Level2D + parallax stay untagged so the background is visible
   * behind the intro/won panels.
   *
   * The placeholder sprite + folder are auto-created on first load
   * via _ensureHeroPlaceholderAsset (idempotent). To swap in a real
   * character: open Assets tab, replace the 'hero-placeholder'
   * sprite, or change the ImageURL.url to 'asset:<your-name>'. */
  {
    id: "platformer-2d-animated",
    name: "Platformer 2D · Animated",
    sub: "WASD + Space · animated sprite · intro/playing/won stages",
    type: "visual",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(28,40,68,0.85)"/>
      <g fill="rgba(85,140,90,0.95)">
        <rect x="0"  y="30" width="40" height="6"/>
        <rect x="48" y="30" width="20" height="6"/>
        <rect x="76" y="22" width="24" height="6"/>
        <rect x="30" y="22" width="10" height="4"/>
      </g>
      <g fill="rgba(105,68,42,0.95)">
        <rect x="0"  y="36" width="100" height="8"/>
      </g>
      <g fill="rgba(232,90,58,1)">
        <rect x="20" y="22" width="6" height="6"/>
        <rect x="20" y="28" width="2" height="2"/>
        <rect x="24" y="28" width="2" height="2"/>
      </g>
      <g fill="rgba(255,255,255,1)">
        <rect x="21" y="23" width="1" height="1"/>
        <rect x="24" y="23" width="1" height="1"/>
      </g>
    </svg>`,
    build: () => {
      // Kick off the placeholder-sprite + folder bootstrap. This runs
      // async; the ImageURL below will start with an unresolved asset
      // and pick up the blob the moment _ensureHeroPlaceholderAsset
      // finishes saving (typically within ~50ms of demo load).
      _ensureHeroPlaceholderAsset();
      // platformer-level-1 also ships egg + flag default assets so
      // they show up in the Assets tab on first load. The demo
      // itself uses tile-based visuals (cream squares / red squares)
      // for the egg / flag, but the sprites are available to drop
      // into custom levels.
      _ensureEggPickupAsset();
      _ensureGoalFlagAsset();
      _ensureParallaxBgAssets();
      _ensureGrassTuftAsset();

      // ─── Stage flow (intro → playing → won) ───────────────
      const tagStage = (id, name) => {
        const n = state.nodes.find(x => x && x.id === id);
        if (n) n.stage = name;
      };
      const fsm = makeNode("StateMachine", 40, -80, {
        states: "intro,playing,won",
        transitions: JSON.stringify([
          { from: 0, to: 1 },
          { from: 1, to: 2 },
          { from: 2, to: 0 }
        ]),
        initialState: 0
      });
      const mgr = makeNode("StageManager", 280, -80, {
        stages: "intro,playing,won",
        active: 0
      });
      state.edges.push({ from: { node: fsm, port: "current" }, to: { node: mgr, port: "active" } });
      const playAwake = makeNode("OnAwake", 520, -80);
      tagStage(playAwake, "playing");

      // ─── Input ────────────────────────────────────────────────
      const keys = makeNode("KeyAxis2D", 40, 60, {
        keyLeft: "KeyA", keyRight: "KeyD",
        keyJump: "Space"
      });

      // ─── Physics body ─────────────────────────────────────────
      const body = makeNode("PlatformerBody2D", 280, 60, {
        walkSpeed: 6,
        gravity:   22,
        jumpForce: 11,
        airControl: 0.85,
        width: 0.5, height: 0.9,
        groundY:   -12,
        // Level is ~80 cells wide centered on x=0; -34 puts the
        // player on the leftmost ground stretch.
        initX: -34, initY: 0
      });
      state.edges.push({ from: { node: keys, port: "x"    }, to: { node: body, port: "inputX" } });
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: body, port: "jump"   } });

      // ─── Level (Level2D: tilemap + 3 parallax + scatter) ─────
      // 80 cols × 15 rows side-scroller. Layout legend:
      //   '.' / ' '  empty (sky)
      //   '1'        grass top
      //   '2'        dirt
      //   '3'        stone platform
      //   '4'        egg pickup (passable, collectible via PickupCollector)
      //   '5'        goal flag (passable, latched via LevelGoal2D)
      // Row 13-14 is full-width bedrock so falling through a gap
      // doesn't end the level -- the player drops 2 cells onto safety
      // floor and can climb back via the next platform.
      //
      // Path: start col 5 on ground → walk right → jump 4-cell gap
      // (cols 12-15) → continue on ground → jump 4-cell gap (cols
      // 26-29) → continue → reach right ground (col 30-79) → climb
      // staircase on the right (cols 64-78 going up) → flag at row 2
      // col 77 on top of step-4 platform.
      //
      // Rebuilt v0.3.464 to use Level2D: 5 demo nodes (Tilemap2D +
      // 3x ParallaxLayer2D + SpriteScatter2D) + 4 ImageURL textures
      // collapsed into ONE Level2D with 5 layers. Edit via the
      // Level Editor modal (⚙ button on the node). Layers carry
      // their texture URLs inline, so no separate ImageURL wires.
      const levelTileData =
        "................................................................................\n" + //  0 sky
        "................................................................................\n" + //  1 sky
        ".............................................................................5..\n" + //  2 flag (col 77)
        "...................................................................33333333333..\n" + //  3 step-4 / flag platform (cols 67-77)
        ".........................................................................4......\n" + //  4 egg above step-3 (col 73)
        "......................................................................333333....\n" + //  5 step-3 platform (cols 70-75)
        "......................................................................4.........\n" + //  6 egg above step-2 (col 70)
        "...................................................................333333.......\n" + //  7 step-2 platform (cols 67-72)
        "..........4...........4.................4.........4..............4..............\n" + //  8 mid-air eggs
        "................3333................33333.......................333333..........\n" + //  9 mid platforms + step-1
        "................................................................................\n" + // 10 air
        "111111111111....1111111111....11111111111111111111111111111111111111111111111111\n" + // 11 grass top w/ 2 jumps
        "222222222222....2222222222....22222222222222222222222222222222222222222222222222\n" + // 12 dirt w/ gaps
        "11111111111111111111111111111111111111111111111111111111111111111111111111111111\n" + // 13 bedrock grass
        "22222222222222222222222222222222222222222222222222222222222222222222222222222222";    // 14 bedrock dirt
      const grassScatterPositions =
        "-36,-3.5,0.55;-32,-3.5,0.7;-29,-3.5,0.5;" +
        "-22,-3.5,0.6,0,1;-19,-3.5,0.55;-15,-3.5,0.65;" +
        " -4,-3.5,0.55;  1,-3.5,0.7,0,1;  6,-3.5,0.5;" +
        " 14,-3.5,0.6;  19,-3.5,0.5,0,1; 24,-3.5,0.7;" +
        " 28,-3.5,0.55; 32,-3.5,0.55,0,1; 35,-3.5,0.6";
      const level = makeNode("Level2D", 40, 280, {
        layers: JSON.stringify([
          // Backgrounds (drawn back-to-front via depthZ + reverse-Z).
          {
            type: "parallax", name: "sky", depthZ: 60,
            parallaxX: 0.0, texWorldWidth: 30,
            screenScaleY: 1.0, screenAnchorY: 0.5, worldOffsetY: 0,
            tintR: 1, tintG: 1, tintB: 1, tintA: 1,
            texture: "asset:parallax-sky",
            wrapMode: "repeat-x", filterMode: "linear"
          },
          {
            type: "parallax", name: "mountains", depthZ: 40,
            parallaxX: 0.12, texWorldWidth: 36,
            screenScaleY: 0.7, screenAnchorY: 0.42, worldOffsetY: 0,
            tintR: 1, tintG: 1, tintB: 1, tintA: 1,
            texture: "asset:parallax-mountains",
            wrapMode: "repeat-x", filterMode: "linear"
          },
          {
            type: "parallax", name: "forest", depthZ: 20,
            parallaxX: 0.35, texWorldWidth: 28,
            screenScaleY: 0.32, screenAnchorY: 0.38, worldOffsetY: 0,
            tintR: 1, tintG: 1, tintB: 1, tintA: 1,
            texture: "asset:parallax-forest",
            wrapMode: "repeat-x", filterMode: "nearest"
          },
          // Main terrain (collidable). Vertex-color path: no tileset
          // so colors come from the per-char color1R/G/B etc. '4' +
          // '5' are skipped in render (the TileSpriteOverlay draws
          // the egg + flag sprites at those cells' world positions).
          {
            type: "tilemap", name: "level", depthZ: 0, collides: true,
            tileSize: 1, originX: 0, originY: 0,
            tileData: levelTileData,
            color1R: 0.30, color1G: 0.62, color1B: 0.38,
            color2R: 0.42, color2G: 0.28, color2B: 0.18,
            color3R: 0.62, color3G: 0.62, color3B: 0.72,
            color4R: 0.97, color4G: 0.91, color4B: 0.78,
            color5R: 0.92, color5G: 0.25, color5B: 0.30,
            skipRenderChars: "45",
            tileset: "", tileMap: {}, tilesetFramesX: 4, tilesetFramesY: 2
          },
          // Foreground grass tufts (decoration; z=-0.3 sits between
          // level z=0 and eggs z=-0.4).
          {
            type: "scatter", name: "grass-tufts", depthZ: -0.3,
            texture: "asset:grass-tuft", filterMode: "nearest", wrapMode: "clamp",
            positions: grassScatterPositions,
            scale: 0.6, anchorX: 0.5, anchorY: 0,
            frame: 0, framesX: 1, framesY: 1,
            tintR: 1, tintG: 1, tintB: 1, tintA: 1
          }
        ], null, 2)
      });
      // Phase 5a: PlatformerBody2D accepts a Level2D on its `tilemap`
      // input and resolves it to the first collidable tilemap layer.
      state.edges.push({ from: { node: level, port: "mesh" }, to: { node: body, port: "tilemap" } });

      // ─── Gameplay: pickups + goal ─────────────────────────────
      const eggs = makeNode("PickupCollector", 280, 480, { tileChar: "4" });
      state.edges.push({ from: { node: level, port: "mesh" }, to: { node: eggs, port: "tilemap" } });
      // PickupCollector body input is a numeric param (x/y read inside
      // the tick via _findWiredOrFirst), but the wire still has to
      // exist for the resolver to prefer this body over auto-discovery
      // when the user adds more bodies later. Wire to anything on the
      // body output side that exists.
      state.edges.push({ from: { node: body, port: "x" }, to: { node: eggs, port: "body" } });

      const goal = makeNode("LevelGoal2D", 520, 480, { tileChar: "5" });
      state.edges.push({ from: { node: level, port: "mesh" }, to: { node: goal, port: "tilemap" } });
      state.edges.push({ from: { node: body,  port: "x"    }, to: { node: goal, port: "body"    } });

      // ─── Animation state machine ──────────────────────────────
      // Defaults match the placeholder sheet's frame layout, so no
      // per-state frame string tweaks needed for the demo.
      const anim = makeNode("AnimationState2D", 520, 60, {
        fps: 10,
        walkThreshold: 0.2,
        idleFrames: "0",
        walkFrames: "1,2,3,2",
        jumpFrames: "4",
        fallFrames: "5"
      });
      state.edges.push({ from: { node: body, port: "vx"       }, to: { node: anim, port: "vx"       } });
      state.edges.push({ from: { node: body, port: "vy"       }, to: { node: anim, port: "vy"       } });
      state.edges.push({ from: { node: body, port: "grounded" }, to: { node: anim, port: "grounded" } });
      state.edges.push({ from: { node: body, port: "facing"   }, to: { node: anim, port: "facing"   } });

      // ─── Texture (placeholder sprite sheet) ───────────────────
      const tex = makeNode("ImageURL", 40, 460, {
        url: "asset:hero-placeholder",
        filterMode: "nearest",
        scale: 32
      });

      // ─── Player sprite ────────────────────────────────────────
      const player = makeNode("Sprite", 280, 280, {
        width: 0.6, height: 0.9,
        anchorX: 0.5, anchorY: 0,
        framesX: 6, framesY: 1,
        // Tint stays neutral (1,1,1,1) so the sheet's own colors show.
        tintR: 1, tintG: 1, tintB: 1, tintA: 1
      });
      state.edges.push({ from: { node: tex,  port: "texture" }, to: { node: player, port: "texture" } });
      state.edges.push({ from: { node: anim, port: "frame"   }, to: { node: player, port: "frame"   } });
      state.edges.push({ from: { node: anim, port: "flipX"   }, to: { node: player, port: "flipX"   } });

      // ─── Translate player to body position ────────────────────
      const playerT = makeNode("Translate", 760, 280, { x: 0, y: 0, z: -1 });
      state.edges.push({ from: { node: player, port: "mesh" }, to: { node: playerT, port: "mesh" } });
      state.edges.push({ from: { node: body,   port: "x"    }, to: { node: playerT, port: "x"    } });
      state.edges.push({ from: { node: body,   port: "y"    }, to: { node: playerT, port: "y"    } });

      // ─── Camera ───────────────────────────────────────────────
      // posY=-1 + orthoSize=6 frames the playable area (grass top
      // y≈-4.5, bedrock fallback y≈-5.5, sky platforms up to y≈3)
      // without cutting off either extreme on a normal 16:9 viewport.
      const cam = makeNode("OrthoCamera2D", 760, 60, {
        posX: 0, posY: -1,
        orthoSize: 6,
        pixelSnap: 0
      });
      state.edges.push({ from: { node: body, port: "x" }, to: { node: cam, port: "posX" } });

      // ─── Egg + flag sprite overlays ───────────────────────────
      // Each TileSpriteOverlay renders one textured quad per matching
      // tile-cell, all batched through the sprite pipeline in a single
      // draw call. PickupCollector mutating the tilemap (removing
      // collected eggs) auto-rebuilds these meshes via the cache key.
      // Both wrap their output in a Translate(z=-0.4) so they draw IN
      // FRONT of the level (z=0) under reverse-Z depth ordering.
      const eggTex = makeNode("ImageURL", 760, 360, {
        url: "asset:egg-pickup",
        filterMode: "nearest",
        scale: 16
      });
      const eggOverlay = makeNode("TileSpriteOverlay", 1000, 360, {
        tileChar: "4",
        scale: 0.45,                 // small egg ~half a tile (Stardew-ish)
        anchorX: 0.5, anchorY: 0.5,
        framesX: 1, framesY: 1, frame: 0,
        tintR: 1, tintG: 1, tintB: 1, tintA: 1,
        bobAmplitude: 0.08, bobSpeed: 2.4,
        // depthZ baked into the verts; -0.4 puts eggs IN FRONT of
        // the level (z=0). No Translate wrapper needed.
        depthZ: -0.4
      });
      state.edges.push({ from: { node: level,  port: "mesh"    }, to: { node: eggOverlay, port: "tilemap" } });
      state.edges.push({ from: { node: eggTex, port: "texture" }, to: { node: eggOverlay, port: "texture" } });

      const flagTex = makeNode("ImageURL", 760, 540, {
        url: "asset:goal-flag",
        filterMode: "nearest",
        scale: 16
      });
      const flagOverlay = makeNode("TileSpriteOverlay", 1000, 540, {
        tileChar: "5",
        scale: 1.1,                  // ~1 tile wide × 1.65 tall (16x24 sprite at 16px/u)
        anchorX: 0.5, anchorY: 0,    // bottom-pinned so flag rests on cell floor
        framesX: 1, framesY: 1, frame: 0,
        tintR: 1, tintG: 1, tintB: 1, tintA: 1,
        bobAmplitude: 0, bobSpeed: 0,
        depthZ: -0.4
      });
      state.edges.push({ from: { node: level,   port: "mesh"    }, to: { node: flagOverlay, port: "tilemap" } });
      state.edges.push({ from: { node: flagTex, port: "texture" }, to: { node: flagOverlay, port: "texture" } });

      // Parallax + scatter layers + main tilemap are all inside the
      // Level2D node above (5 layers total). Level2D's camera input
      // is INTENTIONALLY LEFT UNWIRED -- if we explicitly wired
      // `cam.camera -> level.camera`, the graph would form a cycle:
      //   body.x -> cam.posX -> cam.camera -> level.camera ->
      //   level.mesh -> body.tilemap -> body.x
      // The cycle detector flags any SCC without a Delay1 (correct
      // for audio; conservative for per-frame visuals where each leg
      // is effectively a one-frame delay). Level2D's parallax
      // expansion already falls back to "first OrthoCamera2D in
      // patch" when no camera is wired -- which finds this `cam`
      // automatically. Same effective behavior, no cycle warning.

      // ─── Scene + output ───────────────────────────────────────
      // Level2D expansion produces 5 mesh entries (sky / mountains /
      // forest / tilemap / grass-tufts), all of which feed into
      // Scene2D through ONE mesh wire. Each layer bakes its depthZ
      // into verts, so reverse-Z depth ordering is preserved
      // regardless of slot order. Z values:
      //   sky       z=60  (parallax 0, locked to screen)
      //   mountains z=40  (parallax 0.12)
      //   forest    z=20  (parallax 0.35)
      //   level     z=0
      //   grass     z=-0.3 (in front of level)
      //   eggs      z=-0.4
      //   flag      z=-0.4
      //   player    z=-1   (via existing Translate wrapper)
      const scene = makeNode("Scene2D", 1240, 200, {
        clearR: 0.45, clearG: 0.72, clearB: 0.88
      });
      // One Level2D wire = all 5 layers; other meshes get their own.
      state.edges.push({ from: { node: level,       port: "mesh"   }, to: { node: scene, port: "mesh1"  } });
      state.edges.push({ from: { node: eggOverlay,  port: "mesh"   }, to: { node: scene, port: "mesh2"  } });
      state.edges.push({ from: { node: flagOverlay, port: "mesh"   }, to: { node: scene, port: "mesh3"  } });
      state.edges.push({ from: { node: playerT,     port: "mesh"   }, to: { node: scene, port: "mesh4"  } });
      state.edges.push({ from: { node: cam,         port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 1460, 200, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // ─── HUDs (egg counter + goal hint) ───────────────────────
      const hudEggs = makeNode("HUDText", 1240, 460, {
        text: "",
        prefix: "Eggs ",
        suffix: "",
        decimals: 0,
        corner: "top-left",
        fontSize: 16,
        color: "#fcefb4",
        opacity: 0.95,
        margin: 18
      });
      state.edges.push({ from: { node: eggs,    port: "collected" }, to: { node: hudEggs, port: "value" } });
      state.edges.push({ from: { node: hudEggs, port: "hud"       }, to: { node: scene,   port: "hud1"  } });

      const hudGoal = makeNode("HUDText", 1460, 460, {
        text: "Reach the flag →",
        // value=NaN keeps it in static-text mode regardless of wires.
        value: NaN,
        prefix: "",
        suffix: "",
        decimals: 0,
        corner: "top-right",
        fontSize: 13,
        color: "#9bf",
        opacity: 0.85,
        margin: 18
      });
      state.edges.push({ from: { node: hudGoal, port: "hud" }, to: { node: scene, port: "hud2" } });

      // §8.A-reset -- Restart button (bottom-left). Fan-out wires the
      // click pulse into body.reset / eggs.reset / goal.reset all at
      // once so one tap returns the level to its initial state.
      const restartBtn = makeNode("UIButton", 1240, 600, {
        label: "↺ RESTART",
        x: 12, y: 12,
        width: 140, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: body, port: "reset" } });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: eggs, port: "reset" } });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: goal, port: "reset" } });

      // ─── Tag gameplay nodes → "playing" ────────────────────
      [keys, body, anim, player, playerT, eggs, goal,
       eggOverlay, flagOverlay, hudEggs, hudGoal, restartBtn
      ].forEach(id => tagStage(id, "playing"));

      // OnAwake(playing) resets game state on each stage entry
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: body, port: "reset" } });
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: eggs, port: "reset" } });
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: goal, port: "reset" } });

      // Goal reached → auto-transition to won
      state.edges.push({ from: { node: goal, port: "reached" }, to: { node: fsm, port: "trans1" } });

      // ─── Intro UI (stage="intro") ──────────────────────────
      const introPanel = makeNode("UIPanel", 1460, 360, {
        x: 0, y: -40, width: 460, height: 280,
        color: "#0a1018", borderColor: "#9bd0ff", borderWidth: 2,
        borderRadius: 12, opacity: 0.94, corner: "center"
      });
      tagStage(introPanel, "intro");
      const introTitle = makeNode("UIText", 1460, 440, {
        text: "PLATFORMER", x: 0, y: -100, fontSize: 36, width: 400,
        color: "#cfe9ff", align: "center", opacity: 0.95, corner: "center"
      });
      tagStage(introTitle, "intro");
      const introSub = makeNode("UIText", 1460, 520, {
        text: "WASD + Space  ·  collect eggs · reach the flag",
        x: 0, y: -40, fontSize: 14, width: 420,
        color: "#9bd0ff", align: "center", opacity: 0.75, corner: "center"
      });
      tagStage(introSub, "intro");
      const startBtn = makeNode("UIButton", 1460, 600, {
        label: "▶  START",
        x: 0, y: 40, width: 200, height: 56,
        color: "#3a5a78", hoverColor: "#5a82a8",
        textColor: "#ffffff", borderColor: "#9bd0ff", borderWidth: 1.5,
        borderRadius: 8, fontSize: 18, opacity: 0.95, corner: "center"
      });
      tagStage(startBtn, "intro");
      state.edges.push({ from: { node: startBtn, port: "clicked" }, to: { node: fsm, port: "trans0" } });

      // ─── Won UI (stage="won") ──────────────────────────────
      const wonPanel = makeNode("UIPanel", 1460, 700, {
        x: 0, y: -40, width: 420, height: 260,
        color: "#2a1a08", borderColor: "#f5c878", borderWidth: 2,
        borderRadius: 12, opacity: 0.94, corner: "center"
      });
      tagStage(wonPanel, "won");
      const wonTitle = makeNode("UIText", 1460, 780, {
        text: "YOU WIN!", x: 0, y: -100, fontSize: 42, width: 400,
        color: "#fcefb4", align: "center", opacity: 0.95, corner: "center"
      });
      tagStage(wonTitle, "won");
      const wonSub = makeNode("UIText", 1460, 840, {
        text: "all eggs collected · flag reached",
        x: 0, y: -40, fontSize: 14,
        color: "#f5c878", align: "center", opacity: 0.7, corner: "center"
      });
      tagStage(wonSub, "won");
      const againBtn = makeNode("UIButton", 1460, 920, {
        label: "↺  PLAY AGAIN",
        x: 0, y: 40, width: 220, height: 52,
        color: "#5a3a1c", hoverColor: "#8a5e30",
        textColor: "#fcefb4", borderColor: "#f5c878", borderWidth: 1.5,
        borderRadius: 8, fontSize: 16, opacity: 0.95, corner: "center"
      });
      tagStage(againBtn, "won");
      state.edges.push({ from: { node: againBtn, port: "clicked" }, to: { node: fsm, port: "trans2" } });
    }
  },

  /* Phase 8.A.1 -- lifecycle event smoke test. Drops the four
   * lifecycle nodes (OnAwake / OnStart / OnUpdate / OnDestroy) and
   * wires each trigger into a HUDText readout so the user can SEE
   * the phase transitions on load + on reset. Type resetScene() in
   * the browser devtools console to cycle: OnDestroy fires once,
   * then OnAwake + OnStart fire one frame each, then OnUpdate
   * resumes its continuous fire. */
  {
    id: "lifecycle-test",
    name: "Lifecycle Test",
    sub: "OnAwake / OnStart / OnUpdate / OnDestroy · resetScene() in console",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g font-family="ui-monospace, monospace" font-size="7" fill="rgba(252,239,180,0.95)">
        <text x="6"  y="11">OnAwake</text>
        <text x="6"  y="22">OnStart</text>
        <text x="6"  y="33">OnUpdate (dt)</text>
      </g>
      <g fill="rgba(103,255,128,0.85)">
        <rect x="62" y="6"  width="6" height="6"/>
        <rect x="62" y="17" width="6" height="6"/>
        <rect x="62" y="28" width="6" height="6"/>
      </g>
    </svg>`,
    build: () => {
      const awake   = makeNode("OnAwake",   40,  60);
      const start   = makeNode("OnStart",   40, 200);
      const update  = makeNode("OnUpdate",  40, 340);
      const destroy = makeNode("OnDestroy", 40, 500);

      const cam = makeNode("OrthoCamera2D", 280, 60, {
        posX: 0, posY: 0, orthoSize: 4, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 600, 200, {
        clearR: 0.04, clearG: 0.06, clearB: 0.10
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 820, 200, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // Four HUDText readouts (Scene2D has 4 hud ports). Each shows
      // the persistent fireCount + (for OnUpdate) the running elapsed
      // time. fireCount is the right thing to show on screen -- it
      // proves the event fired even though the HUD wasn't yet visible
      // when OnAwake pulsed on frame 0. To watch the one-frame
      // trigger pulse in real time, open devtools + look at the
      // "[lifecycle] X fired" console log.
      const mkHud = (y, prefix, suffix, decimals, color) =>
        makeNode("HUDText", 280, y, {
          prefix, suffix,
          value: 0,
          decimals,
          corner:  "top-left",
          fontSize: 14,
          color,
          opacity: 0.95,
          margin:  18
        });
      const hudAwake   = mkHud( 60, "OnAwake   fired = ",  "x",   0, "#67ff80");
      const hudStart   = mkHud(120, "OnStart   fired = ",  "x",   0, "#67ff80");
      const hudElapsed = mkHud(180, "OnUpdate  elapsed = ", " s", 2, "#67c8ff");
      const hudDestroy = mkHud(240, "OnDestroy fired = ",  "x",   0, "#ff8c50");

      state.edges.push({ from: { node: awake,   port: "fireCount" }, to: { node: hudAwake,   port: "value" } });
      state.edges.push({ from: { node: start,   port: "fireCount" }, to: { node: hudStart,   port: "value" } });
      state.edges.push({ from: { node: update,  port: "elapsed"   }, to: { node: hudElapsed, port: "value" } });
      state.edges.push({ from: { node: destroy, port: "fireCount" }, to: { node: hudDestroy, port: "value" } });

      state.edges.push({ from: { node: hudAwake,   port: "hud" }, to: { node: scene, port: "hud1" } });
      state.edges.push({ from: { node: hudStart,   port: "hud" }, to: { node: scene, port: "hud2" } });
      state.edges.push({ from: { node: hudElapsed, port: "hud" }, to: { node: scene, port: "hud3" } });
      state.edges.push({ from: { node: hudDestroy, port: "hud" }, to: { node: scene, port: "hud4" } });
    }
  },

  /* Phase 8.A.2 -- Stage management smoke test. Two stages (menu,
   * game), each with its own OnAwake/OnStart/OnDestroy listeners
   * tagged via node.stage. A StageManager drives the active stage;
   * the user toggles by editing StageManager.active in the props
   * panel (0 = menu, 1 = game). Watch the console for per-stage
   * transitions. */
  {
    id: "stage-test",
    name: "Stage Test",
    sub: "StageManager + per-stage lifecycle · edit `active` in props panel to switch",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g font-family="ui-monospace, monospace" font-size="7" fill="rgba(252,239,180,0.95)">
        <text x="6" y="13">menu</text>
        <text x="6" y="26">game</text>
        <text x="48" y="13">Awake/Start</text>
        <text x="48" y="26">Awake/Start</text>
      </g>
      <g fill="rgba(103,200,255,0.85)">
        <rect x="38" y="10" width="3" height="3"/>
        <rect x="38" y="23" width="3" height="3"/>
      </g>
    </svg>`,
    build: () => {
      // ─── StageManager ─────────────────────────────────────
      const mgr = makeNode("StageManager", 40, 60, {
        stages: "menu,game",
        active: 0
      });

      // ─── Per-stage lifecycle nodes ────────────────────────
      // node.stage binds a lifecycle node to a specific stage; OnAwake
      // fires when that stage activates, OnDestroy when it deactivates.
      // Set on the node object directly (not a param) so the binding
      // is structural -- survives serialize / load via _omitRuntimeKeys
      // which only filters _-prefixed runtime fields.
      const tagStage = (nodeId, stageName) => {
        const n = state.nodes.find(x => x && x.id === nodeId);
        if (n) n.stage = stageName;
      };

      const menuAwake   = makeNode("OnAwake",   320,  60);  tagStage(menuAwake,   "menu");
      const menuStart   = makeNode("OnStart",   320, 160);  tagStage(menuStart,   "menu");
      const menuDestroy = makeNode("OnDestroy", 320, 260);  tagStage(menuDestroy, "menu");

      const gameAwake   = makeNode("OnAwake",   320, 380);  tagStage(gameAwake,   "game");
      const gameStart   = makeNode("OnStart",   320, 480);  tagStage(gameStart,   "game");
      const gameDestroy = makeNode("OnDestroy", 320, 580);  tagStage(gameDestroy, "game");

      // ─── Per-stage visible meshes (8.A.2-filtering proof) ─
      // Two Box meshes, one tagged per stage. Mesh emission is
      // filtered by stage -- when active = menu (0), only menuBox
      // is rendered; when active = game (1), only gameBox. Watch
      // the canvas: a green cube appears in menu, a red box in game.
      const menuBox = makeNode("Box", 600, 360, {
        width: 1.5, height: 1.5, depth: 1.5,
        colorR: 0.4, colorG: 0.9, colorB: 0.5
      });
      tagStage(menuBox, "menu");
      const menuBoxT = makeNode("Translate", 720, 360, { x: -1.5, y: 0, z: -3 });
      state.edges.push({ from: { node: menuBox, port: "mesh" }, to: { node: menuBoxT, port: "mesh" } });

      const gameBox = makeNode("Box", 600, 480, {
        width: 1.5, height: 1.5, depth: 1.5,
        colorR: 0.95, colorG: 0.4, colorB: 0.45
      });
      tagStage(gameBox, "game");
      const gameBoxT = makeNode("Translate", 720, 480, { x: 1.5, y: 0, z: -3 });
      state.edges.push({ from: { node: gameBox, port: "mesh" }, to: { node: gameBoxT, port: "mesh" } });

      // ─── Scene + HUD ──────────────────────────────────────
      const cam = makeNode("OrthoCamera2D", 600, 60, {
        posX: 0, posY: 0, orthoSize: 4, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 880, 200, {
        clearR: 0.04, clearG: 0.06, clearB: 0.10
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 1080, 200, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // Four HUD readouts -- one per stage event we care about.
      const mkHud = (y, prefix, suffix, color) =>
        makeNode("HUDText", 600, y, {
          prefix, suffix, value: 0, decimals: 0,
          corner: "top-left", fontSize: 13, color,
          opacity: 0.95, margin: 18
        });
      const hudMenuAwake   = mkHud( 60, "menu  Awake   fired = ",  "x", "#67ff80");
      const hudMenuDestroy = mkHud(110, "menu  Destroy fired = ",  "x", "#ff8c50");
      const hudGameAwake   = mkHud(180, "game  Awake   fired = ",  "x", "#67ff80");
      const hudGameDestroy = mkHud(230, "game  Destroy fired = ",  "x", "#ff8c50");

      state.edges.push({ from: { node: menuAwake,   port: "fireCount" }, to: { node: hudMenuAwake,   port: "value" } });
      state.edges.push({ from: { node: menuDestroy, port: "fireCount" }, to: { node: hudMenuDestroy, port: "value" } });
      state.edges.push({ from: { node: gameAwake,   port: "fireCount" }, to: { node: hudGameAwake,   port: "value" } });
      state.edges.push({ from: { node: gameDestroy, port: "fireCount" }, to: { node: hudGameDestroy, port: "value" } });

      state.edges.push({ from: { node: hudMenuAwake,   port: "hud" }, to: { node: scene, port: "hud1" } });
      state.edges.push({ from: { node: hudMenuDestroy, port: "hud" }, to: { node: scene, port: "hud2" } });
      state.edges.push({ from: { node: hudGameAwake,   port: "hud" }, to: { node: scene, port: "hud3" } });
      state.edges.push({ from: { node: hudGameDestroy, port: "hud" }, to: { node: scene, port: "hud4" } });
      // (menuStart / gameStart are also wired but not visible -- HUD
      // ports max out at 4. Check console logs for their fires.)

      // Each box gets its own mesh slot. When its stage is
      // inactive, _resolveSceneMeshes drops the chain so the
      // slot is empty -- the box disappears.
      state.edges.push({ from: { node: menuBoxT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: gameBoxT, port: "mesh" }, to: { node: scene, port: "mesh2" } });
    }
  },

  /* Phase 8.A.2 capstone -- Stage Cycle demo.
   *
   * Three stages (title / play / won) wired through a Slider so the
   * user can drag through the stage cycle and watch:
   *   * the active mesh swap (one Box per stage, distinct positions)
   *   * the active HUD swap (per-stage title HUDs hide when their
   *     stage is inactive, thanks to the 8.A.2-filtering HUD-tick
   *     filter)
   *   * the props-panel stage dot recolor (click any stage-tagged
   *     node to see its dot turn green/orange/gray based on the
   *     current StageManager.active value)
   *
   * One untagged HUD ("Stage Cycle  ·  drag slider...") stays visible
   * across all stages -- demonstrates the "_global = persistent"
   * convention. */
  {
    id: "stage-cycle",
    name: "Stage Cycle",
    sub: "Slider → StageManager · 3 stages with per-stage meshes + HUDs",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g font-family="ui-monospace, monospace" font-size="6.5" fill="rgba(252,239,180,0.9)">
        <text x="6"  y="11">title</text>
        <text x="6"  y="22">play</text>
        <text x="6"  y="33">won</text>
      </g>
      <g fill="rgba(103,200,255,0.85)">
        <rect x="42" y="7"  width="42" height="3"/>
        <rect x="42" y="18" width="42" height="3"/>
        <rect x="42" y="29" width="42" height="3"/>
        <rect x="62" y="6"  width="3" height="5"/>
        <rect x="55" y="17" width="3" height="5"/>
        <rect x="70" y="28" width="3" height="5"/>
      </g>
    </svg>`,
    build: () => {
      // ─── State manager + driver ───────────────────────────
      const mgr = makeNode("StageManager", 40, 60, {
        stages: "title,play,won",
        active: 0
      });
      const slider = makeNode("Slider", 280, 60, {
        value: 0, min: 0, max: 2, curve: "linear"
      });
      state.edges.push({ from: { node: slider, port: "out" }, to: { node: mgr, port: "active" } });

      const tagStage = (nodeId, stageName) => {
        const n = state.nodes.find(x => x && x.id === nodeId);
        if (n) n.stage = stageName;
      };

      // ─── Per-stage meshes (different positions + sizes) ───
      // Box has hard-coded face colors (+X red / +Y green / etc) so
      // the three boxes look distinct mostly by position + scale.
      const titleBox = makeNode("Box", 40, 280, { width: 1.5, height: 1.5, depth: 1.5 });
      tagStage(titleBox, "title");
      const titleBoxT = makeNode("Translate", 200, 280, { x: 0, y: 0.5, z: -3 });
      state.edges.push({ from: { node: titleBox, port: "mesh" }, to: { node: titleBoxT, port: "mesh" } });

      const playBox = makeNode("Box", 40, 420, { width: 0.9, height: 0.9, depth: 0.9 });
      tagStage(playBox, "play");
      const playBoxT = makeNode("Translate", 200, 420, { x: -1.8, y: 0, z: -3 });
      state.edges.push({ from: { node: playBox, port: "mesh" }, to: { node: playBoxT, port: "mesh" } });

      const playBox2 = makeNode("Box", 40, 540, { width: 0.9, height: 0.9, depth: 0.9 });
      tagStage(playBox2, "play");
      const playBox2T = makeNode("Translate", 200, 540, { x: 1.8, y: 0, z: -3 });
      state.edges.push({ from: { node: playBox2, port: "mesh" }, to: { node: playBox2T, port: "mesh" } });

      const wonBox = makeNode("Box", 40, 680, { width: 2.0, height: 2.0, depth: 2.0 });
      tagStage(wonBox, "won");
      const wonBoxT = makeNode("Translate", 200, 680, { x: 0, y: 0, z: -3 });
      state.edges.push({ from: { node: wonBox, port: "mesh" }, to: { node: wonBoxT, port: "mesh" } });

      // ─── Scene + camera ───────────────────────────────────
      const cam = makeNode("OrthoCamera2D", 600, 60, {
        posX: 0, posY: 0, orthoSize: 4, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 880, 200, {
        clearR: 0.05, clearG: 0.08, clearB: 0.13
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 1080, 200, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // Three mesh slots -- one per stage's first box. The play
      // stage's SECOND box piggybacks on the chain through scene.mesh4
      // (we have 4 mesh slots before the painter algorithm wraps).
      state.edges.push({ from: { node: titleBoxT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: playBoxT,  port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: playBox2T, port: "mesh" }, to: { node: scene, port: "mesh3" } });
      state.edges.push({ from: { node: wonBoxT,   port: "mesh" }, to: { node: scene, port: "mesh4" } });

      // ─── Per-stage HUDs + one global instruction ──────────
      // The global HUD stays visible across all 3 stages
      // (no .stage tag = "_global"). The 3 stage HUDs hide via
      // the tick-time _isNodeActive check.
      const mkHud = (prefix, color, opts) =>
        makeNode("HUDText", 600, opts.y, Object.assign({
          prefix, value: NaN, text: opts.text || "",
          decimals: 0, corner: opts.corner || "top-left",
          fontSize: opts.fontSize || 14, color, opacity: 0.95, margin: 18
        }, opts.extra || {}));

      const hudInstr = mkHud("", "#9bf", {
        y: 60, corner: "bottom-left", fontSize: 11,
        text: "Stage Cycle  ·  drag the slider value 0/1/2 to switch  ·  click any tagged node to see its stage dot"
      });

      const hudTitle = mkHud("", "#67ff80", { y: 120, fontSize: 16, text: "title  ·  Stage Cycle Demo" });
      tagStage(hudTitle, "title");

      const hudPlay  = mkHud("", "#67c8ff", { y: 180, fontSize: 16, text: "play   ·  gameplay running" });
      tagStage(hudPlay, "play");

      const hudWon   = mkHud("", "#ff8c50", { y: 240, fontSize: 16, text: "won    ·  STAGE COMPLETE" });
      tagStage(hudWon, "won");

      state.edges.push({ from: { node: hudInstr, port: "hud" }, to: { node: scene, port: "hud1" } });
      state.edges.push({ from: { node: hudTitle, port: "hud" }, to: { node: scene, port: "hud2" } });
      state.edges.push({ from: { node: hudPlay,  port: "hud" }, to: { node: scene, port: "hud3" } });
      state.edges.push({ from: { node: hudWon,   port: "hud" }, to: { node: scene, port: "hud4" } });
    }
  },

  /* Phase 8.A.3.1 -- PrefabInstance smoke test.
   *
   * Hardcoded "Box Prefab" template = a Box + a Translate joined by
   * a mesh wire. Three instances at different x/size overrides
   * appear as three single-node "PrefabInstance" blocks in the
   * graph view; their internal Box+Translate children spawn into
   * state.nodes but render() hides them. The Scene2D's mesh1..mesh3
   * inputs wire to each instance.mesh; the wire resolver
   * (_prefabResolveFromEndpoint) redirects each to the exposed
   * child's mesh internally.
   *
   * Click any of the three instance nodes -- the props panel shows
   * `templateName`, `templateInline`, plus the exposed-param fields
   * x / y / size. Editing those fields propagates to the matching
   * child node each tick + the canvas updates immediately. */
  {
    id: "prefab-demo",
    name: "Prefab Demo",
    sub: "PrefabInstance · 3 boxes from one template with per-instance overrides",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g fill="rgba(180,140,90,0.85)" stroke="rgba(220,180,120,1)" stroke-width="0.6">
        <rect x="14" y="14" width="14" height="14"/>
        <rect x="42" y="10" width="20" height="20"/>
        <rect x="74" y="16" width="12" height="12"/>
      </g>
      <g font-family="ui-monospace, monospace" font-size="6" fill="rgba(252,239,180,0.9)">
        <text x="6" y="40">Box Prefab × 3</text>
      </g>
    </svg>`,
    build: () => {
      // ─── Template definition (would normally come from a .gpatch
      // with prefabMeta -- here we inline it as a JS literal). The
      // template defines the "internal" subgraph PLUS the prefabMeta
      // listing which params + ports are exposed to the instance.
      const template = {
        patchName: "Box Prefab",
        version: 2,
        nodes: [
          { id: "t_box",   type: "Box",       params: { width: 0.8, height: 0.8, depth: 0.8 } },
          { id: "t_trans", type: "Translate", params: { x: 0, y: 0, z: -3 } }
        ],
        edges: [
          { from: { node: "t_box", port: "mesh" }, to: { node: "t_trans", port: "mesh" } }
        ],
        prefabMeta: {
          exposedParams: [
            { label: "x",    nodeId: "t_trans", paramName: "x"     },
            { label: "y",    nodeId: "t_trans", paramName: "y"     },
            { label: "size", nodeId: "t_box",   paramName: "width" }
          ],
          exposedPorts: [
            { label: "mesh", nodeId: "t_trans", portName: "mesh", direction: "out" }
          ]
        }
      };
      const tplJson = JSON.stringify(template);

      // ─── Three instances with distinct overrides ──────────
      const inst1 = makeNode("PrefabInstance", 40,  60, {
        templateName: "Box Prefab", templateInline: tplJson,
        x: -2.5, y:  0,   size: 0.8
      });
      const inst2 = makeNode("PrefabInstance", 40, 180, {
        templateName: "Box Prefab", templateInline: tplJson,
        x:  0.0, y:  0.3, size: 1.2
      });
      const inst3 = makeNode("PrefabInstance", 40, 300, {
        templateName: "Box Prefab", templateInline: tplJson,
        x:  2.5, y:  0,   size: 0.8
      });

      // ─── Scene + camera ───────────────────────────────────
      const cam = makeNode("OrthoCamera2D", 320, 60, {
        posX: 0, posY: 0, orthoSize: 4, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 560, 200, {
        clearR: 0.05, clearG: 0.07, clearB: 0.11
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 760, 200, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // Wires from instance.mesh land on the INSTANCE node visually,
      // but _prefabResolveFromEndpoint redirects them to the
      // exposed child's mesh port at resolution time.
      state.edges.push({ from: { node: inst1, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: inst2, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: inst3, port: "mesh" }, to: { node: scene, port: "mesh3" } });

      // Instruction HUD.
      const hud = makeNode("HUDText", 560, 380, {
        text: "Prefab Demo  ·  click any of the 3 PrefabInstance nodes  ·  edit x / y / size in the props panel  ·  one template, per-instance overrides",
        value: NaN,
        corner: "bottom-left",
        fontSize: 11,
        color: "#9bf",
        opacity: 0.85,
        margin: 18
      });
      state.edges.push({ from: { node: hud, port: "hud" }, to: { node: scene, port: "hud1" } });
    }
  },

  /* Phase 8.A.4 -- Transform Hierarchy demo.
   *
   * Shows the parent/child pattern via mesh-chain composition (the
   * existing Translate/Rotate/Scale infrastructure already supports
   * nesting; what's new in 8.A.4 is the MeshWorldPosition readback).
   *
   * One Slider drives the parent's X position. Both the parent's
   * Translate and the child's outer Translate read from that slider
   * via standard wire fan-out, so both follow in lockstep. The
   * child has an extra LOCAL Translate(x=+1.2, y=+0.6) chained
   * BEFORE the parent transform, so its world position =
   * parent.translate * child.localOffset = (slider + 1.2, 0.6).
   *
   * MeshWorldPosition on the child's outermost transform reads
   * back the actual world position the renderer is using, proving
   * the matrix composition math; HUDs show the live worldX/Y. */
  {
    id: "transform-hierarchy",
    name: "Transform Hierarchy",
    sub: "Parent/child via mesh chain · MeshWorldPosition readback into HUDs",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g fill="rgba(180,140,90,0.85)" stroke="rgba(220,180,120,1)" stroke-width="0.6">
        <rect x="36" y="20" width="14" height="14"/>
      </g>
      <g fill="rgba(103,200,255,0.85)" stroke="rgba(160,220,255,1)" stroke-width="0.6">
        <rect x="58" y="14" width="8" height="8"/>
      </g>
      <g stroke="rgba(160,220,255,0.5)" stroke-width="0.5" stroke-dasharray="1,1">
        <line x1="44" y1="27" x2="62" y2="18"/>
      </g>
      <g font-family="ui-monospace, monospace" font-size="6" fill="rgba(252,239,180,0.9)">
        <text x="6" y="40">parent → child</text>
      </g>
    </svg>`,
    build: () => {
      // Slider drives the parent's X. Fan-out feeds both Translates.
      const slider = makeNode("Slider", 40, 60, {
        value: 0, min: -3, max: 3, curve: "linear"
      });

      // ─── Parent chain ─────────────────────────────────────
      const parentBox = makeNode("Box", 40, 200, {
        width: 1.0, height: 1.0, depth: 1.0
      });
      const parentT = makeNode("Translate", 240, 200, { x: 0, y: 0, z: -3 });
      state.edges.push({ from: { node: parentBox, port: "mesh" }, to: { node: parentT, port: "mesh" } });
      state.edges.push({ from: { node: slider, port: "out"  }, to: { node: parentT, port: "x" } });

      // ─── Child chain ──────────────────────────────────────
      // Box -> Translate(localOffset) -> Translate(parentX shared) -> Scene
      // Matrix = parentT_copy * childOff * pos
      //        = (slider, 0, -3) * (1.2, 0.6, 0) * (0, 0, 0)
      //        = (slider + 1.2, 0.6, -3)
      const childBox = makeNode("Box", 40, 340, {
        width: 0.5, height: 0.5, depth: 0.5
      });
      const childOff = makeNode("Translate", 240, 340, { x: 1.2, y: 0.6, z: 0 });
      state.edges.push({ from: { node: childBox, port: "mesh" }, to: { node: childOff, port: "mesh" } });
      const parentT_child = makeNode("Translate", 440, 340, { x: 0, y: 0, z: -3 });
      state.edges.push({ from: { node: childOff,   port: "mesh" }, to: { node: parentT_child, port: "mesh" } });
      state.edges.push({ from: { node: slider,     port: "out"  }, to: { node: parentT_child, port: "x"    } });

      // ─── World-position readback ──────────────────────────
      const worldPos = makeNode("MeshWorldPosition", 640, 340);
      state.edges.push({ from: { node: parentT_child, port: "mesh" }, to: { node: worldPos, port: "mesh" } });

      // ─── Scene + camera ───────────────────────────────────
      const cam = makeNode("OrthoCamera2D", 440, 60, {
        posX: 0, posY: 0, orthoSize: 4, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 880, 200, {
        clearR: 0.04, clearG: 0.06, clearB: 0.10
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 1080, 200, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      state.edges.push({ from: { node: parentT,        port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: parentT_child,  port: "mesh" }, to: { node: scene, port: "mesh2" } });

      // ─── HUDs ─────────────────────────────────────────────
      const mkHud = (y, prefix, suffix, color, decimals, valueNaN) =>
        makeNode("HUDText", 880, y, Object.assign({
          prefix, suffix,
          value: valueNaN ? NaN : 0,
          decimals,
          corner:  "top-left",
          fontSize: 14,
          color,
          opacity: 0.95,
          margin: 18
        }));
      const hudParentX = mkHud( 60, "parent worldX = ",    "", "#cfe9ff", 2, false);
      const hudChildX  = mkHud(120, "child  worldX = ",    "", "#67ff80", 2, false);
      const hudChildY  = mkHud(180, "child  worldY = ",    "", "#67ff80", 2, false);
      // For the parent's world X, use a parallel MeshWorldPosition.
      const parentPos = makeNode("MeshWorldPosition", 640, 200);
      state.edges.push({ from: { node: parentT, port: "mesh" }, to: { node: parentPos, port: "mesh" } });
      state.edges.push({ from: { node: parentPos, port: "worldX" }, to: { node: hudParentX, port: "value" } });
      state.edges.push({ from: { node: worldPos,  port: "worldX" }, to: { node: hudChildX,  port: "value" } });
      state.edges.push({ from: { node: worldPos,  port: "worldY" }, to: { node: hudChildY,  port: "value" } });

      const hudInstr = makeNode("HUDText", 880, 460, {
        text: "Drag the Slider  -  parent moves  -  child follows at local offset (+1.2, +0.6)  -  MeshWorldPosition reports world coords",
        value: NaN,
        corner:  "bottom-left",
        fontSize: 11,
        color:   "#9bf",
        opacity: 0.85,
        margin:  18
      });
      state.edges.push({ from: { node: hudParentX, port: "hud" }, to: { node: scene, port: "hud1" } });
      state.edges.push({ from: { node: hudChildX,  port: "hud" }, to: { node: scene, port: "hud2" } });
      state.edges.push({ from: { node: hudChildY,  port: "hud" }, to: { node: scene, port: "hud3" } });
      state.edges.push({ from: { node: hudInstr,   port: "hud" }, to: { node: scene, port: "hud4" } });
    }
  },

  /* Phase 8.A.5.1 -- Pool / spawn demo (Wwise-style voice pool).
   *
   * Press Space to spawn a "bullet" Box at the slider-controlled X
   * position. The Pool holds 8 voice slots; each spawn allocates the
   * next inactive voice (or steals the oldest active when all full).
   * Voices auto-despawn after 1.5 seconds.
   *
   * The bullet template is a Box + Translate; spawning sets the
   * Translate's x/y to the pool's spawn-time inputs. activeCount
   * HUD shows live voice count. */
  {
    id: "pool-demo",
    name: "Pool Demo",
    sub: "Wwise-style voice pool · Space to spawn · slider aims X",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g fill="rgba(180,140,90,0.85)" stroke="rgba(220,180,120,1)" stroke-width="0.4">
        <rect x="8"  y="10" width="6" height="6"/>
        <rect x="22" y="14" width="6" height="6"/>
        <rect x="38" y="8"  width="6" height="6"/>
        <rect x="56" y="16" width="6" height="6"/>
        <rect x="72" y="12" width="6" height="6"/>
        <rect x="86" y="6"  width="6" height="6"/>
      </g>
      <g font-family="ui-monospace, monospace" font-size="6" fill="rgba(252,239,180,0.9)">
        <text x="6" y="36">8 voices · auto-recycle</text>
      </g>
    </svg>`,
    build: () => {
      // Bullet voice template -- a Box + Translate. exposedParams
      // x / y get set on spawn; exposed mesh out feeds the Pool's
      // aggregated mesh emission.
      const bulletTemplate = {
        patchName: "Bullet",
        version: 2,
        nodes: [
          { id: "t_box",   type: "Box",       params: { width: 0.4, height: 0.4, depth: 0.4 } },
          { id: "t_trans", type: "Translate", params: { x: 0, y: 0, z: -3 } }
        ],
        edges: [
          { from: { node: "t_box", port: "mesh" }, to: { node: "t_trans", port: "mesh" } }
        ],
        prefabMeta: {
          exposedParams: [
            { label: "x", nodeId: "t_trans", paramName: "x" },
            { label: "y", nodeId: "t_trans", paramName: "y" }
          ],
          exposedPorts: [
            { label: "mesh", nodeId: "t_trans", portName: "mesh", direction: "out" }
          ]
        }
      };

      // ─── Input ───────────────────────────────────────────
      // KeyAxis2D.jump is a gate that fires on Space press.
      const keys = makeNode("KeyAxis2D", 40, 60, {
        keyLeft: "KeyA", keyRight: "KeyD",
        keyJump: "Space"
      });
      // Slider controls spawn X (drag to aim).
      const aim = makeNode("Slider", 40, 200, {
        value: 0, min: -3, max: 3, curve: "linear"
      });

      // ─── Pool ────────────────────────────────────────────
      const pool = makeNode("Pool", 280, 60, {
        templateName: "Bullet",
        templateInline: JSON.stringify(bulletTemplate),
        maxVoices: 8,
        voiceLifetime: 1.5
      });
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: pool, port: "spawn" } });
      state.edges.push({ from: { node: aim,  port: "out"  }, to: { node: pool, port: "x"     } });

      // ─── Scene ───────────────────────────────────────────
      const cam = makeNode("OrthoCamera2D", 280, 220, {
        posX: 0, posY: 0, orthoSize: 4, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 520, 60, {
        clearR: 0.04, clearG: 0.06, clearB: 0.10
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 720, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      state.edges.push({ from: { node: pool, port: "mesh" }, to: { node: scene, port: "mesh1" } });

      // ─── HUDs ────────────────────────────────────────────
      const hudCount = makeNode("HUDText", 520, 220, {
        prefix: "active voices = ",
        suffix: " / 8",
        value: 0,
        decimals: 0,
        corner: "top-left",
        fontSize: 14,
        color: "#67ff80",
        opacity: 0.95,
        margin: 18
      });
      state.edges.push({ from: { node: pool,     port: "activeCount" }, to: { node: hudCount, port: "value" } });
      state.edges.push({ from: { node: hudCount, port: "hud"         }, to: { node: scene,    port: "hud1"  } });

      const hudInstr = makeNode("HUDText", 520, 360, {
        text: "Pool demo  ·  press SPACE to spawn  ·  drag slider to aim X  ·  voices auto-despawn after 1.5s  ·  9th press steals oldest",
        value: NaN,
        corner: "bottom-left",
        fontSize: 11,
        color: "#9bf",
        opacity: 0.85,
        margin: 18
      });
      state.edges.push({ from: { node: hudInstr, port: "hud" }, to: { node: scene, port: "hud2" } });
    }
  },

  /* Phase 8.A.5.2 -- Audio Pool / polyphonic synth demo.
   *
   * Same Pool node, this time with audioEnabled=1 so each spawn
   * fires a real OscillatorNode through Web Audio. Slider controls
   * frequency (220-660 Hz); each Space press allocates a voice at
   * that freq, plays a triangle-wave with AR envelope, auto-stops
   * after voiceLifetime. Multiple voices = real polyphony.
   *
   * Pool.mesh still renders the bullet boxes for visual feedback.
   * Pool.audio (JS mirror) feeds a HUD showing the summed envelope
   * amplitude. */
  {
    id: "pool-audio-demo",
    name: "Pool Audio",
    sub: "Polyphonic synth via Pool · Space spawns a note · slider sets freq",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g fill="rgba(103,200,255,0.85)">
        <rect x="10" y="20" width="3" height="6"/>
        <rect x="18" y="14" width="3" height="14"/>
        <rect x="26" y="10" width="3" height="22"/>
        <rect x="34" y="14" width="3" height="14"/>
        <rect x="42" y="20" width="3" height="6"/>
        <rect x="54" y="22" width="3" height="2"/>
        <rect x="62" y="16" width="3" height="12"/>
        <rect x="70" y="12" width="3" height="20"/>
        <rect x="78" y="16" width="3" height="12"/>
        <rect x="86" y="22" width="3" height="2"/>
      </g>
      <g font-family="ui-monospace, monospace" font-size="6" fill="rgba(252,239,180,0.9)">
        <text x="6" y="40">Wwise-style synth</text>
      </g>
    </svg>`,
    build: () => {
      const bulletTemplate = {
        patchName: "AudioBullet",
        version: 2,
        nodes: [
          { id: "t_box",   type: "Box",       params: { width: 0.4, height: 0.4, depth: 0.4 } },
          { id: "t_trans", type: "Translate", params: { x: 0, y: 0, z: -3 } }
        ],
        edges: [
          { from: { node: "t_box", port: "mesh" }, to: { node: "t_trans", port: "mesh" } }
        ],
        prefabMeta: {
          exposedParams: [
            { label: "x", nodeId: "t_trans", paramName: "x" },
            { label: "y", nodeId: "t_trans", paramName: "y" }
          ],
          exposedPorts: [
            { label: "mesh", nodeId: "t_trans", portName: "mesh", direction: "out" }
          ]
        }
      };

      const keys = makeNode("KeyAxis2D", 40, 60, {
        keyLeft: "KeyA", keyRight: "KeyD",
        keyJump: "Space"
      });
      const freqKnob = makeNode("Slider", 40, 200, {
        value: 330, min: 110, max: 880, curve: "linear"
      });
      const aimX = makeNode("Slider", 40, 340, {
        value: 0, min: -3, max: 3, curve: "linear"
      });

      const pool = makeNode("Pool", 280, 60, {
        templateName:    "AudioBullet",
        templateInline:  JSON.stringify(bulletTemplate),
        maxVoices:       8,
        voiceLifetime:   1.0,
        audioEnabled:    1,
        audioWaveform:   "triangle",
        audioGain:       0.12,
        audioAttack:     0.02,
        audioRelease:    0.35,
        audioBaseFreq:   330
      });
      state.edges.push({ from: { node: keys,     port: "jump" }, to: { node: pool, port: "spawn" } });
      state.edges.push({ from: { node: freqKnob, port: "out"  }, to: { node: pool, port: "freq"  } });
      state.edges.push({ from: { node: aimX,     port: "out"  }, to: { node: pool, port: "x"     } });

      const cam = makeNode("OrthoCamera2D", 280, 220, {
        posX: 0, posY: 0, orthoSize: 4, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 520, 60, {
        clearR: 0.04, clearG: 0.06, clearB: 0.10
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 720, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      state.edges.push({ from: { node: pool, port: "mesh" }, to: { node: scene, port: "mesh1" } });

      const hudVoices = makeNode("HUDText", 520, 240, {
        prefix: "voices = ",
        suffix: " / 8",
        value:  0,
        decimals: 0,
        corner: "top-left",
        fontSize: 13,
        color:  "#67ff80",
        opacity: 0.95,
        margin: 18
      });
      const hudAudio = makeNode("HUDText", 520, 320, {
        prefix: "audio = ",
        value:  0,
        decimals: 3,
        corner: "top-left",
        fontSize: 13,
        color:  "#67c8ff",
        opacity: 0.95,
        margin: 18
      });
      const hudFreq = makeNode("HUDText", 520, 400, {
        prefix: "freq = ",
        suffix: " Hz",
        value:  0,
        decimals: 0,
        corner: "top-left",
        fontSize: 13,
        color:  "#cfe9ff",
        opacity: 0.95,
        margin: 18
      });
      state.edges.push({ from: { node: pool,     port: "activeCount" }, to: { node: hudVoices, port: "value" } });
      state.edges.push({ from: { node: pool,     port: "audio"       }, to: { node: hudAudio,  port: "value" } });
      state.edges.push({ from: { node: freqKnob, port: "out"         }, to: { node: hudFreq,   port: "value" } });

      state.edges.push({ from: { node: hudVoices, port: "hud" }, to: { node: scene, port: "hud1" } });
      state.edges.push({ from: { node: hudAudio,  port: "hud" }, to: { node: scene, port: "hud2" } });
      state.edges.push({ from: { node: hudFreq,   port: "hud" }, to: { node: scene, port: "hud3" } });

      const hudInstr = makeNode("HUDText", 720, 320, {
        text: "Audio Pool  ·  click the canvas FIRST (browser autoplay)  ·  press SPACE to play a note  ·  drag freq slider for pitch  ·  drag aim slider for X  ·  8 voices polyphonic  ·  voice steal on 9th",
        value: NaN,
        corner: "bottom-left",
        fontSize: 11,
        color: "#9bf",
        opacity: 0.85,
        margin: 18
      });
      state.edges.push({ from: { node: hudInstr, port: "hud" }, to: { node: scene, port: "hud4" } });
    }
  },

  /* Phase 8.I.1 -- StateMachine + StageManager integration demo.
   *
   * Three states cycle by Space key:  intro -> playing -> won -> intro.
   * StateMachine.current drives StageManager.active so the per-stage
   * cubes + HUDs swap on every transition. Reset key (R) jumps
   * back to intro from anywhere.
   *
   * Three transitions all wired to KeyAxis2D.jump (Space); each
   * transition's from-state filter ensures only ONE fires per
   * press, picking the right one based on current state. */
  {
    id: "fsm-demo",
    name: "State Machine",
    sub: "StateMachine -> StageManager · Space cycles · R resets",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g fill="rgba(103,200,255,0.85)" stroke="rgba(160,220,255,1)" stroke-width="0.6">
        <circle cx="18" cy="22" r="6"/>
        <circle cx="50" cy="22" r="6"/>
        <circle cx="82" cy="22" r="6"/>
      </g>
      <g stroke="rgba(252,239,180,0.85)" stroke-width="0.8" fill="none">
        <path d="M 26 22 L 42 22"/><path d="M 40 20 L 42 22 L 40 24"/>
        <path d="M 58 22 L 74 22"/><path d="M 72 20 L 74 22 L 72 24"/>
        <path d="M 82 12 Q 50 -2 18 12" stroke-dasharray="2,2"/>
      </g>
      <g font-family="ui-monospace, monospace" font-size="5.5" fill="rgba(252,239,180,0.9)">
        <text x="6" y="40">intro -> play -> won (loop)</text>
      </g>
    </svg>`,
    build: () => {
      // Input
      const keys = makeNode("KeyAxis2D", 40, 60, {
        keyLeft: "KeyA", keyRight: "KeyD",
        keyJump: "Space"
      });
      // Use a separate KeyAxis2D for the reset key so we get a
      // distinct gate output. (Hack: reuse keys.jump for reset via
      // a Slider toggle, or just instantiate a second KeyAxis2D
      // bound to KeyR.) Simpler: one KeyAxis2D with keyJump=Space,
      // a Slider for "reset request" the user can click to fire.
      const resetTrig = makeNode("Slider", 40, 200, {
        value: 0, min: 0, max: 1, curve: "linear"
      });

      // StateMachine: 3-state cycle intro(0) -> playing(1) -> won(2) -> intro(0)
      const fsm = makeNode("StateMachine", 280, 60, {
        states:       "intro,playing,won",
        transitions:  JSON.stringify([
          { from: 0, to: 1 },   // trans0: intro    -> playing  (Space)
          { from: 1, to: 2 },   // trans1: playing  -> won      (Space)
          { from: 2, to: 0 }    // trans2: won      -> intro    (Space)
        ]),
        initialState: 0
      });
      // All three transN inputs wired to Space -- only the one
      // matching the current state fires per press.
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: fsm, port: "trans0" } });
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: fsm, port: "trans1" } });
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: fsm, port: "trans2" } });
      // Reset slider snaps to 1 = trigger reset back to intro.
      state.edges.push({ from: { node: resetTrig, port: "out" }, to: { node: fsm, port: "reset" } });

      // StageManager driven by FSM
      const mgr = makeNode("StageManager", 520, 60, {
        stages: "intro,playing,won",
        active: 0
      });
      state.edges.push({ from: { node: fsm, port: "current" }, to: { node: mgr, port: "active" } });

      const tagStage = (nodeId, stageName) => {
        const n = state.nodes.find(x => x && x.id === nodeId);
        if (n) n.stage = stageName;
      };

      // Per-stage boxes -- distinct positions
      const introBox = makeNode("Box", 40, 360, { width: 1.5, height: 1.5, depth: 1.5 });
      tagStage(introBox, "intro");
      const introT = makeNode("Translate", 200, 360, { x: 0, y: 0.5, z: -3 });
      state.edges.push({ from: { node: introBox, port: "mesh" }, to: { node: introT, port: "mesh" } });

      const playBox = makeNode("Box", 40, 480, { width: 0.8, height: 0.8, depth: 0.8 });
      tagStage(playBox, "playing");
      const playT = makeNode("Translate", 200, 480, { x: -1.5, y: 0, z: -3 });
      state.edges.push({ from: { node: playBox, port: "mesh" }, to: { node: playT, port: "mesh" } });

      const wonBox = makeNode("Box", 40, 600, { width: 2.0, height: 2.0, depth: 2.0 });
      tagStage(wonBox, "won");
      const wonT = makeNode("Translate", 200, 600, { x: 0, y: 0, z: -3 });
      state.edges.push({ from: { node: wonBox, port: "mesh" }, to: { node: wonT, port: "mesh" } });

      // Scene + cam + output
      const cam = makeNode("OrthoCamera2D", 760, 60, {
        posX: 0, posY: 0, orthoSize: 4, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 1000, 200, {
        clearR: 0.04, clearG: 0.06, clearB: 0.10
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 1200, 200, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      state.edges.push({ from: { node: introT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: playT,  port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: wonT,   port: "mesh" }, to: { node: scene, port: "mesh3" } });

      // HUDs: FSM state info
      const hudCurrent = makeNode("HUDText", 760, 360, {
        prefix: "state #",
        value: 0,
        decimals: 0,
        corner: "top-left",
        fontSize: 14,
        color: "#67ff80",
        opacity: 0.95,
        margin: 18
      });
      const hudPrev = makeNode("HUDText", 760, 440, {
        prefix: "previous #",
        value: 0,
        decimals: 0,
        corner: "top-left",
        fontSize: 13,
        color: "#cfe9ff",
        opacity: 0.90,
        margin: 18
      });
      const hudCount = makeNode("HUDText", 760, 520, {
        prefix: "transitions = ",
        value: 0,
        decimals: 0,
        corner: "top-left",
        fontSize: 13,
        color: "#67c8ff",
        opacity: 0.90,
        margin: 18
      });
      state.edges.push({ from: { node: fsm, port: "current"         }, to: { node: hudCurrent, port: "value" } });
      state.edges.push({ from: { node: fsm, port: "previousState"   }, to: { node: hudPrev,    port: "value" } });
      state.edges.push({ from: { node: fsm, port: "transitionCount" }, to: { node: hudCount,   port: "value" } });
      state.edges.push({ from: { node: hudCurrent, port: "hud" }, to: { node: scene, port: "hud1" } });
      state.edges.push({ from: { node: hudPrev,    port: "hud" }, to: { node: scene, port: "hud2" } });
      state.edges.push({ from: { node: hudCount,   port: "hud" }, to: { node: scene, port: "hud3" } });

      const hudInstr = makeNode("HUDText", 1000, 460, {
        text: "State Machine demo  ·  press SPACE to cycle (intro -> playing -> won -> intro)  ·  drag reset slider to 1 then back to 0 for jump-to-intro  ·  cubes swap via StageManager",
        value: NaN,
        corner: "bottom-left",
        fontSize: 11,
        color: "#9bf",
        opacity: 0.85,
        margin: 18
      });
      state.edges.push({ from: { node: hudInstr, port: "hud" }, to: { node: scene, port: "hud4" } });
    }
  },

  /* Phase 8.A.7 -- Capstone: fully-wired intro → playing → won.
   *
   * Showcases the wire-everything refactor:
   *   - 3 Scene2D nodes (intro / playing / won), each wired into
   *     StageManager.in0/in1/in2. StageManager.out → VisualOutput.
   *   - UI visibility via StageManager.active0/1/2 → widget.show
   *     (no tagStage calls for UI nodes).
   *   - Gameplay nodes keep stage tags for tick filtering.
   *   - StateMachine drives StageManager.active for transitions.
   *
   * Flow: title screen → click START → fresh game → collect egg +
   * touch flag → WIN screen → click PLAY AGAIN → back to title. */
  {
    id: "engine-capstone",
    name: "Engine Capstone",
    sub: "3 scenes → StageManager → VisualOutput · fully wired",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="6" y="8" width="28" height="28" rx="2" fill="rgba(58,74,96,0.85)" stroke="rgba(155,208,255,1)" stroke-width="0.6"/>
      <text x="20" y="25" font-family="ui-sans-serif" font-size="6" fill="#fff" text-anchor="middle">PLAY</text>
      <g stroke="rgba(252,239,180,0.7)" stroke-width="0.8" fill="none">
        <path d="M 36 22 L 44 22"/><path d="M 42 20 L 44 22 L 42 24"/>
      </g>
      <rect x="46" y="8" width="22" height="28" rx="2" fill="rgba(45,90,55,0.85)" stroke="rgba(105,255,128,1)" stroke-width="0.6"/>
      <text x="57" y="25" font-family="ui-sans-serif" font-size="5" fill="#fff" text-anchor="middle">GAME</text>
      <g stroke="rgba(252,239,180,0.7)" stroke-width="0.8" fill="none">
        <path d="M 70 22 L 78 22"/><path d="M 76 20 L 78 22 L 76 24"/>
      </g>
      <rect x="80" y="8" width="14" height="28" rx="2" fill="rgba(120,90,40,0.85)" stroke="rgba(252,239,180,1)" stroke-width="0.6"/>
      <text x="87" y="25" font-family="ui-sans-serif" font-size="5" fill="#fff" text-anchor="middle">WIN</text>
    </svg>`,
    build: () => {
      const tagStage = (id, name) => {
        const n = state.nodes.find(x => x && x.id === id);
        if (n) n.stage = name;
      };

      // ─── State graph + stage manager ──────────────────────
      const fsm = makeNode("StateMachine", 40, 60, {
        states: "intro,playing,won",
        transitions: JSON.stringify([
          { from: 0, to: 1 },
          { from: 1, to: 2 },
          { from: 2, to: 0 }
        ]),
        initialState: 0
      });
      const mgr = makeNode("StageManager", 280, 60, {
        stages: "intro,playing,won",
        active: 0
      });
      state.edges.push({ from: { node: fsm, port: "current" }, to: { node: mgr, port: "active" } });

      // ─── OnAwake[stage="playing"] -> auto-reset gameplay ──
      const playAwake = makeNode("OnAwake", 520, 60);
      tagStage(playAwake, "playing");

      // ─── Gameplay (tagged "playing" for tick filtering) ────
      const keys = makeNode("KeyAxis2D", 40, 200, {
        keyLeft: "KeyA", keyRight: "KeyD", keyJump: "Space"
      });
      tagStage(keys, "playing");
      const body = makeNode("PlatformerBody2D", 280, 200, {
        walkSpeed: 5, gravity: 22, jumpForce: 10, airControl: 0.85,
        width: 0.6, height: 0.9, groundY: -8, initX: -5, initY: 0
      });
      tagStage(body, "playing");
      state.edges.push({ from: { node: keys, port: "x"    }, to: { node: body, port: "inputX" } });
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: body, port: "jump"   } });

      const level = makeNode("Level2D", 40, 360, {
        layers: JSON.stringify([{
          type: "tilemap", name: "level", depthZ: 0, collides: true,
          tileSize: 1, originX: 0, originY: 0,
          tileData:
            "...............\n...............\n...............\n" +
            ".............5.\n...4.....3333..\n..............3\n" +
            "11111111111111.\n22222222222222.",
          color1R: 0.30, color1G: 0.62, color1B: 0.38,
          color2R: 0.42, color2G: 0.28, color2B: 0.18,
          color3R: 0.62, color3G: 0.62, color3B: 0.72,
          color4R: 0.97, color4G: 0.91, color4B: 0.78,
          color5R: 0.92, color5G: 0.25, color5B: 0.30,
          skipRenderChars: "",
          tileset: "", tileMap: {}, tilesetFramesX: 4, tilesetFramesY: 2
        }], null, 2)
      });
      tagStage(level, "playing");
      state.edges.push({ from: { node: level, port: "mesh" }, to: { node: body, port: "tilemap" } });

      const eggs = makeNode("PickupCollector", 520, 200, { tileChar: "4" });
      tagStage(eggs, "playing");
      state.edges.push({ from: { node: level, port: "mesh" }, to: { node: eggs, port: "tilemap" } });
      state.edges.push({ from: { node: body,  port: "x"    }, to: { node: eggs, port: "body"    } });
      const goal = makeNode("LevelGoal2D", 760, 200, { tileChar: "5" });
      tagStage(goal, "playing");
      state.edges.push({ from: { node: level, port: "mesh" }, to: { node: goal, port: "tilemap" } });
      state.edges.push({ from: { node: body,  port: "x"    }, to: { node: goal, port: "body"    } });

      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: body, port: "reset" } });
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: eggs, port: "reset" } });
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: goal, port: "reset" } });
      state.edges.push({ from: { node: goal, port: "reached" }, to: { node: fsm, port: "trans1" } });

      const playerBox = makeNode("Box", 40, 540, { width: 0.55, height: 0.85, depth: 0.55 });
      tagStage(playerBox, "playing");
      const playerT = makeNode("Translate", 240, 540, { x: 0, y: 0, z: -2.5 });
      tagStage(playerT, "playing");
      state.edges.push({ from: { node: playerBox, port: "mesh" }, to: { node: playerT, port: "mesh" } });
      state.edges.push({ from: { node: body,      port: "x"    }, to: { node: playerT, port: "x"    } });
      state.edges.push({ from: { node: body,      port: "y"    }, to: { node: playerT, port: "y"    } });

      // ─── Camera (shared; follows body.x during playing) ───
      const cam = makeNode("OrthoCamera2D", 760, 360, {
        posX: 0, posY: -1, orthoSize: 5, pixelSnap: 0
      });
      state.edges.push({ from: { node: body, port: "x" }, to: { node: cam, port: "posX" } });

      // ─── 3 Scene2D nodes → StageManager → VisualOutput ────
      const sceneIntro = makeNode("Scene2D", 1000, 100, {
        clearR: 0.18, clearG: 0.22, clearB: 0.32
      });
      const scenePlay = makeNode("Scene2D", 1000, 240, {
        clearR: 0.45, clearG: 0.72, clearB: 0.88
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scenePlay, port: "camera" } });
      state.edges.push({ from: { node: level,   port: "mesh" }, to: { node: scenePlay, port: "mesh1" } });
      state.edges.push({ from: { node: playerT, port: "mesh" }, to: { node: scenePlay, port: "mesh2" } });
      const sceneWon = makeNode("Scene2D", 1000, 380, {
        clearR: 0.22, clearG: 0.16, clearB: 0.08
      });

      // Route scenes through StageManager
      state.edges.push({ from: { node: sceneIntro, port: "out" }, to: { node: mgr, port: "in0" } });
      state.edges.push({ from: { node: scenePlay,  port: "out" }, to: { node: mgr, port: "in1" } });
      state.edges.push({ from: { node: sceneWon,   port: "out" }, to: { node: mgr, port: "in2" } });
      const vo = makeNode("VisualOutput", 1240, 200, { display: 0 });
      state.edges.push({ from: { node: mgr, port: "out" }, to: { node: vo, port: "in" } });

      // ─── Intro UI (visibility via show wire) ──────────────
      const introPanel = makeNode("UIPanel", 1240, 360, {
        x: 0, y: -40, width: 460, height: 280,
        color: "#0a1018", borderColor: "#9bd0ff", borderWidth: 2,
        borderRadius: 12, opacity: 0.94, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introPanel, port: "show" } });
      const introTitle = makeNode("UIText", 1240, 440, {
        text: "GAMMA ENGINE", x: 0, y: -100, fontSize: 36, width: 400,
        color: "#cfe9ff", align: "center", opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introTitle, port: "show" } });
      const introSub = makeNode("UIText", 1240, 500, {
        text: "WASD + Space  ·  walk to the flag",
        x: 0, y: -40, fontSize: 14, width: 400,
        color: "#9bd0ff", align: "center", opacity: 0.75, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introSub, port: "show" } });
      const startBtn = makeNode("UIButton", 1240, 560, {
        label: "▶  START",
        x: 0, y: 30, width: 200, height: 56,
        color: "#3a5a78", hoverColor: "#5a82a8",
        textColor: "#ffffff", borderColor: "#9bd0ff", borderWidth: 1.5,
        borderRadius: 8, fontSize: 18, opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: startBtn, port: "show" } });
      state.edges.push({ from: { node: startBtn, port: "clicked" }, to: { node: fsm, port: "trans0" } });

      // ─── Won UI (visibility via show wire) ─────────────────
      const wonPanel = makeNode("UIPanel", 1240, 640, {
        x: 0, y: -40, width: 420, height: 260,
        color: "#2a1a08", borderColor: "#f5c878", borderWidth: 2,
        borderRadius: 12, opacity: 0.94, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: wonPanel, port: "show" } });
      const wonTitle = makeNode("UIText", 1240, 720, {
        text: "YOU WIN", x: 0, y: -100, fontSize: 42, width: 400,
        color: "#fcefb4", align: "center", opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: wonTitle, port: "show" } });
      const wonSub = makeNode("UIText", 1240, 780, {
        text: "the flag was reached", x: 0, y: -40, fontSize: 14, width: 400,
        color: "#f5c878", align: "center", opacity: 0.7, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: wonSub, port: "show" } });
      const againBtn = makeNode("UIButton", 1240, 840, {
        label: "↺  PLAY AGAIN",
        x: 0, y: 40, width: 220, height: 52,
        color: "#5a3a1c", hoverColor: "#8a5e30",
        textColor: "#fcefb4", borderColor: "#f5c878", borderWidth: 1.5,
        borderRadius: 8, fontSize: 16, opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: againBtn, port: "show" } });
      state.edges.push({ from: { node: againBtn, port: "clicked" }, to: { node: fsm, port: "trans2" } });

      // ─── Playing HUDs + restart (visibility via show wire) ─
      const eggsHud = makeNode("HUDText", 1440, 200, {
        prefix: "eggs ", suffix: " / ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 16, color: "#fcefb4", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: eggsHud, port: "show" } });
      state.edges.push({ from: { node: eggs, port: "collected" }, to: { node: eggsHud, port: "value" } });
      state.edges.push({ from: { node: eggsHud, port: "hud" }, to: { node: scenePlay, port: "hud1" } });
      const restartBtn = makeNode("UIButton", 1440, 300, {
        label: "↺  restart",
        x: 12, y: 12, width: 120, height: 32,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1,
        borderRadius: 4, fontSize: 12, opacity: 0.92,
        corner: "top-right"
      });
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: restartBtn, port: "show" } });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: body, port: "reset" } });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: eggs, port: "reset" } });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: goal, port: "reset" } });
    }
  },

  /* Phase 8.D.1 -- UI widgets + StateMachine integration demo.
   *
   * On-screen UIPanel background + UIText title + UIButton. Each
   * button click fires the StateMachine's trans inputs; current
   * state drives a StageManager that swaps three different-sized
   * cubes. Same architecture as the State Machine demo, but the
   * Space-key input is replaced with a clickable on-screen button. */
  {
    id: "ui-demo",
    name: "UI Button",
    sub: "UIPanel + UIText + UIButton -> StateMachine -> StageManager",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="14" y="8" width="72" height="28" rx="3"
            fill="rgba(58,74,96,0.85)" stroke="rgba(155,208,255,1)" stroke-width="0.8"/>
      <text x="50" y="26" font-family="ui-sans-serif" font-size="9" fill="#ffffff" text-anchor="middle">START</text>
    </svg>`,
    build: () => {
      // FSM
      const fsm = makeNode("StateMachine", 40, 60, {
        states: "intro,playing,won",
        transitions: JSON.stringify([
          { from: 0, to: 1 },
          { from: 1, to: 2 },
          { from: 2, to: 0 }
        ]),
        initialState: 0
      });
      // StageManager + per-stage cubes
      const mgr = makeNode("StageManager", 280, 60, {
        stages: "intro,playing,won",
        active: 0
      });
      state.edges.push({ from: { node: fsm, port: "current" }, to: { node: mgr, port: "active" } });
      const tagStage = (id, name) => {
        const n = state.nodes.find(x => x && x.id === id);
        if (n) n.stage = name;
      };
      const introBox = makeNode("Box", 40, 360, { width: 1.5, height: 1.5, depth: 1.5 });
      tagStage(introBox, "intro");
      const introT = makeNode("Translate", 200, 360, { x: 0, y: 0, z: -3 });
      state.edges.push({ from: { node: introBox, port: "mesh" }, to: { node: introT, port: "mesh" } });

      const playBox = makeNode("Box", 40, 480, { width: 0.9, height: 0.9, depth: 0.9 });
      tagStage(playBox, "playing");
      const playT = makeNode("Translate", 200, 480, { x: -1.5, y: 0, z: -3 });
      state.edges.push({ from: { node: playBox, port: "mesh" }, to: { node: playT, port: "mesh" } });

      const wonBox = makeNode("Box", 40, 600, { width: 2.0, height: 2.0, depth: 2.0 });
      tagStage(wonBox, "won");
      const wonT = makeNode("Translate", 200, 600, { x: 0, y: 0, z: -3 });
      state.edges.push({ from: { node: wonBox, port: "mesh" }, to: { node: wonT, port: "mesh" } });

      // Scene
      const cam = makeNode("OrthoCamera2D", 520, 60, {
        posX: 0, posY: 0, orthoSize: 4, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 760, 200, {
        clearR: 0.04, clearG: 0.06, clearB: 0.10
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      const vo = makeNode("VisualOutput", 960, 200, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });
      state.edges.push({ from: { node: introT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: playT,  port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: wonT,   port: "mesh" }, to: { node: scene, port: "mesh3" } });

      // UI widgets -- the actual point of the demo.
      const panel = makeNode("UIPanel", 760, 360, {
        x: 0, y: -60, width: 360, height: 220,
        color: "#0a0e16", borderColor: "#5a7090", borderWidth: 1.5,
        borderRadius: 10, opacity: 0.92, corner: "center"
      });
      const title = makeNode("UIText", 760, 480, {
        text: "GAMMA", x: 0, y: -120, fontSize: 38,
        color: "#cfe9ff", align: "center", opacity: 0.95,
        corner: "center"
      });
      const subtitle = makeNode("UIText", 760, 560, {
        text: "click to advance state", x: 0, y: -70, fontSize: 14,
        color: "#9bd0ff", align: "center", opacity: 0.75,
        corner: "center"
      });
      const startBtn = makeNode("UIButton", 760, 640, {
        label: "START", x: 0, y: 0, width: 220, height: 56,
        color: "#3a5a78", hoverColor: "#5a82a8",
        textColor: "#ffffff", borderColor: "#9bd0ff", borderWidth: 1.5,
        borderRadius: 8, fontSize: 18, opacity: 0.95,
        corner: "center"
      });
      // Button click fires all three trans inputs; only the one whose
      // `from` matches the FSM's current state actually fires.
      state.edges.push({ from: { node: startBtn, port: "clicked" }, to: { node: fsm, port: "trans0" } });
      state.edges.push({ from: { node: startBtn, port: "clicked" }, to: { node: fsm, port: "trans1" } });
      state.edges.push({ from: { node: startBtn, port: "clicked" }, to: { node: fsm, port: "trans2" } });

      // Stage-tag the UI widgets so they ONLY show in the intro stage.
      // After the first click, the FSM advances to "playing" and the
      // menu UI disappears (stage filtering). Click again in "playing"
      // (it won't -- button is hidden), so user uses Space or props.
      // Actually leave the button UNTAGGED so it stays visible across
      // states (Wwise-style restart button).
      tagStage(panel, "intro");
      tagStage(title, "intro");
      tagStage(subtitle, "intro");
      // startBtn stays untagged -- always visible so user can advance
      // through all stages with clicks.

      // Status HUD shows current state + transitions
      const hudState = makeNode("HUDText", 960, 360, {
        prefix: "state = ",
        value: 0, decimals: 0,
        corner: "top-right",
        fontSize: 14, color: "#67ff80", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: { node: fsm, port: "current" }, to: { node: hudState, port: "value" } });
      state.edges.push({ from: { node: hudState, port: "hud" }, to: { node: scene, port: "hud1" } });
      const hudClicks = makeNode("HUDText", 960, 440, {
        prefix: "clicks = ",
        value: 0, decimals: 0,
        corner: "top-right",
        fontSize: 14, color: "#67c8ff", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: { node: fsm, port: "transitionCount" }, to: { node: hudClicks, port: "value" } });
      state.edges.push({ from: { node: hudClicks, port: "hud" }, to: { node: scene, port: "hud2" } });
    }
  },

  /* Phase 8.B.1 -- 2D Physics Sandbox. Rapier 2D foundation demo:
   * 5 dynamic boxes + 1 circle drop onto a static ground + slope.
   * Restart button resets all bodies to initial positions. */
  {
    id: "physics-sandbox-2d",
    name: "2D Physics Sandbox",
    sub: "Rapier 2D · boxes + circle drop onto ground + slope",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="5" y="32" width="90" height="4" rx="1" fill="rgba(100,100,100,0.8)"/>
      <line x1="55" y1="32" x2="85" y2="24" stroke="rgba(100,100,100,0.8)" stroke-width="3"/>
      <rect x="20" y="10" width="7" height="7" rx="1" fill="rgba(80,160,220,0.85)" transform="rotate(15 23 13)"/>
      <rect x="38" y="18" width="7" height="7" rx="1" fill="rgba(220,120,80,0.85)"/>
      <rect x="30" y="24" width="7" height="7" rx="1" fill="rgba(80,200,120,0.85)" transform="rotate(-10 33 27)"/>
      <rect x="14" y="20" width="7" height="7" rx="1" fill="rgba(180,100,220,0.85)" transform="rotate(8 17 23)"/>
      <rect x="44" y="8" width="7" height="7" rx="1" fill="rgba(220,180,80,0.85)" transform="rotate(-5 47 11)"/>
      <circle cx="55" cy="14" r="4" fill="rgba(220,200,80,0.85)"/>
    </svg>`,
    build: () => {
      // Physics world
      const world = makeNode("PhysicsWorld2D", 40, 60, {
        gravityX: 0, gravityY: -9.8, subSteps: 4
      });

      // Ground: static body + wide box collider
      const groundBody = makeNode("RigidBody2D", 40, 200, {
        type: "static", initX: 0, initY: -4, initRotation: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: groundBody, port: "world" } });
      const groundColl = makeNode("BoxCollider2D", 280, 200, {
        width: 20, height: 1, friction: 0.8, restitution: 0.1
      });
      state.edges.push({ from: { node: groundBody, port: "bodyId" }, to: { node: groundColl, port: "body" } });

      // Ground visual (static, not physics-driven)
      const groundBox = makeNode("Box", 520, 200, { width: 20, height: 1, depth: 1 });
      const groundT = makeNode("Translate", 700, 200, { x: 0, y: -4, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Slope: static body + box collider
      const slopeBody = makeNode("RigidBody2D", 40, 340, {
        type: "static", initX: 5, initY: -2, initRotation: 20
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: slopeBody, port: "world" } });
      const slopeColl = makeNode("BoxCollider2D", 280, 340, {
        width: 6, height: 0.4, friction: 0.5, restitution: 0.2
      });
      state.edges.push({ from: { node: slopeBody, port: "bodyId" }, to: { node: slopeColl, port: "body" } });

      // Slope visual (Rotate before Translate so the box rotates
      // in place, matching the physics body's local rotation)
      const slopeBox = makeNode("Box", 520, 340, { width: 6, height: 0.4, depth: 1 });
      const slopeR = makeNode("Rotate", 700, 340, { angleZ: 20 });
      const slopeT = makeNode("Translate", 880, 340, { x: 5, y: -2, z: 0 });
      state.edges.push({ from: { node: slopeBox, port: "mesh" }, to: { node: slopeR, port: "mesh" } });
      state.edges.push({ from: { node: slopeR, port: "mesh" }, to: { node: slopeT, port: "mesh" } });

      // 5 dynamic boxes at staggered positions + 1 circle
      const dynamicBodies = [];
      const xOff = [-1.5, 0.5, 4.5, 5.5, -0.8];
      const yOff = [4, 6, 8, 10, 12];
      const rotOff = [0, 15, -10, 8, -5];
      const colors = [
        { r: 0.3, g: 0.6, b: 0.9 },
        { r: 0.9, g: 0.45, b: 0.3 },
        { r: 0.3, g: 0.8, b: 0.5 },
        { r: 0.7, g: 0.4, b: 0.85 },
        { r: 0.85, g: 0.7, b: 0.3 }
      ];

      const meshSlots = [];
      meshSlots.push(groundT);
      meshSlots.push(slopeT);

      for (let i = 0; i < 5; i++) {
        const body = makeNode("RigidBody2D", 40, 500 + i * 140, {
          type: "dynamic", initX: xOff[i], initY: yOff[i],
          initRotation: rotOff[i], linearDamping: 0.1, angularDamping: 0.1
        });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: body, port: "world" } });
        const coll = makeNode("BoxCollider2D", 280, 500 + i * 140, {
          width: 0.8, height: 0.8, density: 1, friction: 0.6, restitution: 0.25
        });
        state.edges.push({ from: { node: body, port: "bodyId" }, to: { node: coll, port: "body" } });

        const box = makeNode("Box", 520, 500 + i * 140, { width: 0.8, height: 0.8, depth: 0.8 });
        const rot = makeNode("Rotate", 700, 500 + i * 140);
        const trans = makeNode("Translate", 880, 500 + i * 140, { z: -1 });
        state.edges.push({ from: { node: box,  port: "mesh" }, to: { node: rot,   port: "mesh" } });
        state.edges.push({ from: { node: body, port: "rotation" }, to: { node: rot, port: "angleZ" } });
        state.edges.push({ from: { node: rot,  port: "mesh" }, to: { node: trans, port: "mesh" } });
        state.edges.push({ from: { node: body, port: "x" }, to: { node: trans, port: "x" } });
        state.edges.push({ from: { node: body, port: "y" }, to: { node: trans, port: "y" } });

        dynamicBodies.push(body);
        meshSlots.push(trans);
      }

      // Circle body
      const circBody = makeNode("RigidBody2D", 40, 1200, {
        type: "dynamic", initX: 3, initY: 14, initRotation: 0,
        linearDamping: 0.05, angularDamping: 0.05
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: circBody, port: "world" } });
      const circColl = makeNode("CircleCollider2D", 280, 1200, {
        radius: 0.5, density: 1, friction: 0.4, restitution: 0.5
      });
      state.edges.push({ from: { node: circBody, port: "bodyId" }, to: { node: circColl, port: "body" } });
      const circBox = makeNode("Box", 520, 1200, { width: 0.9, height: 0.9, depth: 0.9 });
      const circTrans = makeNode("Translate", 700, 1200, { z: -1 });
      state.edges.push({ from: { node: circBox,  port: "mesh" }, to: { node: circTrans, port: "mesh" } });
      state.edges.push({ from: { node: circBody, port: "x" }, to: { node: circTrans, port: "x" } });
      state.edges.push({ from: { node: circBody, port: "y" }, to: { node: circTrans, port: "y" } });
      dynamicBodies.push(circBody);
      meshSlots.push(circTrans);

      // Camera + Scene2D
      const cam = makeNode("OrthoCamera2D", 1060, 60, {
        posX: 0, posY: 2, orthoSize: 8, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 1240, 60, {
        clearR: 0.12, clearG: 0.14, clearB: 0.2
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      for (let i = 0; i < meshSlots.length && i < 8; i++) {
        state.edges.push({ from: { node: meshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 1) } });
      }
      const vo = makeNode("VisualOutput", 1420, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // Restart button
      const restartBtn = makeNode("UIButton", 1240, 200, {
        label: "↺  RESTART",
        x: 12, y: 12, width: 140, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      for (const b of dynamicBodies) {
        state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: b, port: "reset" } });
      }

      // Body count HUD
      const hudBodies = makeNode("HUDText", 1240, 300, {
        prefix: "bodies ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 14, color: "#67c8ff", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: world, port: "bodyCount" }, to: { node: hudBodies, port: "value" } });
      state.edges.push({ from: { node: hudBodies, port: "hud" }, to: { node: scene, port: "hud1" } });
    }
  },

  /* Phase 8.B.2 -- Cannon demo. UISlider sets launch angle +
   * power, UIButton fires a projectile (resets the dynamic body
   * with initVx/initVy computed from the slider values).
   * Shows kinematics arc, raycast aim line, and hit detection. */
  {
    id: "physics-cannon-2d",
    name: "2D Cannon",
    sub: "Rapier 2D · UISlider aim · UIButton fire · parabolic arc",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="5" y="32" width="90" height="4" rx="1" fill="rgba(100,100,100,0.8)"/>
      <line x1="15" y1="32" x2="35" y2="14" stroke="rgba(180,160,100,0.9)" stroke-width="3" stroke-linecap="round"/>
      <path d="M 35 14 Q 55 -5 75 32" stroke="rgba(255,120,80,0.7)" stroke-width="1.2" fill="none" stroke-dasharray="3 2"/>
      <circle cx="35" cy="14" r="3" fill="rgba(255,200,80,1)"/>
      <rect x="72" y="20" width="8" height="12" rx="1" fill="rgba(100,180,100,0.8)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld2D", 40, 60, {
        gravityX: 0, gravityY: -9.8, subSteps: 4
      });

      // Ground
      const groundBody = makeNode("RigidBody2D", 40, 180, {
        type: "static", initX: 0, initY: -4, initRotation: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: groundBody, port: "world" } });
      const groundColl = makeNode("BoxCollider2D", 280, 180, {
        width: 30, height: 1, friction: 0.8, restitution: 0.1
      });
      state.edges.push({ from: { node: groundBody, port: "bodyId" }, to: { node: groundColl, port: "body" } });
      const groundBox = makeNode("Box", 520, 180, { width: 30, height: 1, depth: 1 });
      const groundT = makeNode("Translate", 700, 180, { x: 0, y: -4, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Target wall
      const wallBody = makeNode("RigidBody2D", 40, 320, {
        type: "static", initX: 8, initY: -1.5, initRotation: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: wallBody, port: "world" } });
      const wallColl = makeNode("BoxCollider2D", 280, 320, {
        width: 1, height: 4, friction: 0.5, restitution: 0.2
      });
      state.edges.push({ from: { node: wallBody, port: "bodyId" }, to: { node: wallColl, port: "body" } });
      const wallBox = makeNode("Box", 520, 320, { width: 1, height: 4, depth: 1 });
      const wallT = makeNode("Translate", 700, 320, { x: 8, y: -1.5, z: 0 });
      state.edges.push({ from: { node: wallBox, port: "mesh" }, to: { node: wallT, port: "mesh" } });

      // Projectile: dynamic body, launched with initVx/initVy
      // from UISliders. FIRE button triggers reset which applies
      // the initial velocity.
      const projBody = makeNode("RigidBody2D", 40, 460, {
        type: "dynamic", initX: -6, initY: -3,
        initVx: 8, initVy: 10,
        linearDamping: 0, angularDamping: 0.5
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: projBody, port: "world" } });
      const projColl = makeNode("CircleCollider2D", 280, 460, {
        radius: 0.3, density: 2, friction: 0.5, restitution: 0.4
      });
      state.edges.push({ from: { node: projBody, port: "bodyId" }, to: { node: projColl, port: "body" } });
      const projBox = makeNode("Box", 520, 460, { width: 0.6, height: 0.6, depth: 0.6 });
      const projT = makeNode("Translate", 700, 460, { z: -1 });
      state.edges.push({ from: { node: projBox, port: "mesh" }, to: { node: projT, port: "mesh" } });
      state.edges.push({ from: { node: projBody, port: "x" }, to: { node: projT, port: "x" } });
      state.edges.push({ from: { node: projBody, port: "y" }, to: { node: projT, port: "y" } });

      // Target boxes: dynamic, stacked on the wall
      const targets = [];
      for (let i = 0; i < 3; i++) {
        const tb = makeNode("RigidBody2D", 40, 600 + i * 100, {
          type: "dynamic", initX: 8, initY: -2 + i * 1.1,
          linearDamping: 0.2, angularDamping: 0.2
        });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: tb, port: "world" } });
        const tc = makeNode("BoxCollider2D", 280, 600 + i * 100, {
          width: 0.8, height: 0.8, density: 0.5, friction: 0.5, restitution: 0.15
        });
        state.edges.push({ from: { node: tb, port: "bodyId" }, to: { node: tc, port: "body" } });
        const tBox = makeNode("Box", 520, 600 + i * 100, { width: 0.8, height: 0.8, depth: 0.8 });
        const tR = makeNode("Rotate", 700, 600 + i * 100);
        const tT = makeNode("Translate", 880, 600 + i * 100, { z: -0.5 });
        state.edges.push({ from: { node: tBox, port: "mesh" }, to: { node: tR, port: "mesh" } });
        state.edges.push({ from: { node: tb, port: "rotation" }, to: { node: tR, port: "angleZ" } });
        state.edges.push({ from: { node: tR, port: "mesh" }, to: { node: tT, port: "mesh" } });
        state.edges.push({ from: { node: tb, port: "x" }, to: { node: tT, port: "x" } });
        state.edges.push({ from: { node: tb, port: "y" }, to: { node: tT, port: "y" } });
        targets.push({ body: tb, mesh: tT });
      }

      // Camera + Scene
      const cam = makeNode("OrthoCamera2D", 1060, 60, {
        posX: 1, posY: 0, orthoSize: 7, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 1240, 60, {
        clearR: 0.08, clearG: 0.1, clearB: 0.16
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: wallT, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: projT, port: "mesh" }, to: { node: scene, port: "mesh3" } });
      for (let i = 0; i < targets.length && i + 4 <= 8; i++) {
        state.edges.push({ from: { node: targets[i].mesh, port: "mesh" }, to: { node: scene, port: "mesh" + (i + 4) } });
      }
      const vo = makeNode("VisualOutput", 1420, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // UISlider: launch power (maps to initVx)
      const powerSlider = makeNode("UISlider", 40, 960, {
        label: "POWER", min: 2, max: 18, value: 8, step: 0.5,
        x: 12, y: 100, width: 180, height: 28,
        corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: powerSlider, port: "value" }, to: { node: projBody, port: "initVx" } });

      // UISlider: launch angle (maps to initVy)
      const angleSlider = makeNode("UISlider", 40, 1060, {
        label: "ANGLE", min: 0, max: 20, value: 10, step: 0.5,
        x: 12, y: 136, width: 180, height: 28,
        corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: angleSlider, port: "value" }, to: { node: projBody, port: "initVy" } });

      // FIRE button
      const fireBtn = makeNode("UIButton", 1240, 200, {
        label: "FIRE",
        x: 12, y: 12, width: 160, height: 48,
        color: "#6a2a1a", hoverColor: "#a04020",
        textColor: "#ffcc88", borderColor: "#ff8844", borderWidth: 2,
        borderRadius: 6, fontSize: 20, opacity: 0.95,
        corner: "bottom-left"
      });
      state.edges.push({ from: { node: fireBtn, port: "clicked" }, to: { node: projBody, port: "reset" } });
      // Also reset targets on fire so they re-stack
      for (const t of targets) {
        state.edges.push({ from: { node: fireBtn, port: "clicked" }, to: { node: t.body, port: "reset" } });
      }

      // HUD: projectile velocity
      const hudVx = makeNode("HUDText", 1240, 300, {
        prefix: "vx ", value: 0, decimals: 1,
        corner: "top-left", fontSize: 14, color: "#ff8844", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: projBody, port: "vx" }, to: { node: hudVx, port: "value" } });
      state.edges.push({ from: { node: hudVx, port: "hud" }, to: { node: scene, port: "hud1" } });

      const hudVy = makeNode("HUDText", 1240, 380, {
        prefix: "vy ", value: 0, decimals: 1,
        corner: "top-left", fontSize: 14, color: "#ffcc88", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: projBody, port: "vy" }, to: { node: hudVy, port: "value" } });
      state.edges.push({ from: { node: hudVy, port: "hud" }, to: { node: scene, port: "hud2" } });
    }
  },

  /* Phase 8.B.3 -- Pendulum + Trigger Zone. RevoluteJoint2D swings
   * a dynamic body from a static anchor; sensor zone at the bottom
   * fires ContactEvent2D, counting passes on a HUD. */
  {
    id: "physics-pendulum-2d",
    name: "2D Pendulum",
    sub: "RevoluteJoint2D · sensor trigger zone · contact counter",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <circle cx="50" cy="8" r="3" fill="rgba(100,100,100,0.8)"/>
      <line x1="50" y1="8" x2="35" y2="30" stroke="rgba(180,180,180,0.7)" stroke-width="1.5"/>
      <circle cx="35" cy="30" r="5" fill="rgba(80,160,220,0.85)"/>
      <rect x="20" y="34" width="60" height="6" rx="1" fill="rgba(100,220,100,0.3)" stroke="rgba(100,220,100,0.6)" stroke-width="0.5"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld2D", 40, 60, {
        gravityX: 0, gravityY: -9.8, subSteps: 4
      });

      // Anchor: static body at top
      const anchor = makeNode("RigidBody2D", 40, 180, {
        type: "static", initX: 0, initY: 3
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: anchor, port: "world" } });
      const anchorColl = makeNode("BoxCollider2D", 280, 180, {
        width: 0.4, height: 0.4, density: 1
      });
      state.edges.push({ from: { node: anchor, port: "bodyId" }, to: { node: anchorColl, port: "body" } });
      const anchorBox = makeNode("Box", 520, 180, { width: 0.4, height: 0.4, depth: 0.4 });
      const anchorT = makeNode("Translate", 700, 180, { x: 0, y: 3, z: 0 });
      state.edges.push({ from: { node: anchorBox, port: "mesh" }, to: { node: anchorT, port: "mesh" } });

      // Pendulum bob: dynamic body, starts offset to the right
      // and below the anchor. anchorBy=3 on the joint creates a
      // 3-unit arm (joint attaches 3 units above bob's center).
      const bob = makeNode("RigidBody2D", 40, 340, {
        type: "dynamic", initX: 3, initY: 0,
        linearDamping: 0.02, angularDamping: 0.1
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: bob, port: "world" } });
      const bobColl = makeNode("CircleCollider2D", 280, 340, {
        radius: 0.4, density: 3, friction: 0.3, restitution: 0.2
      });
      state.edges.push({ from: { node: bob, port: "bodyId" }, to: { node: bobColl, port: "body" } });
      const bobBox = makeNode("Box", 520, 340, { width: 0.8, height: 0.8, depth: 0.8 });
      const bobT = makeNode("Translate", 700, 340, { z: -1 });
      state.edges.push({ from: { node: bobBox, port: "mesh" }, to: { node: bobT, port: "mesh" } });
      state.edges.push({ from: { node: bob, port: "x" }, to: { node: bobT, port: "x" } });
      state.edges.push({ from: { node: bob, port: "y" }, to: { node: bobT, port: "y" } });

      // Revolute joint: anchorA=(0,0) on the static anchor,
      // anchorB=(0,3) on the bob = joint attaches 3 units above
      // bob's center, creating a 3-unit pendulum arm.
      const joint = makeNode("RevoluteJoint2D", 40, 500, {
        anchorAx: 0, anchorAy: 0, anchorBx: 0, anchorBy: 3
      });
      state.edges.push({ from: { node: anchor, port: "bodyId" }, to: { node: joint, port: "bodyA" } });
      state.edges.push({ from: { node: bob, port: "bodyId" }, to: { node: joint, port: "bodyB" } });

      // Trigger zone: sensor at the pendulum's lowest point (y=0).
      // Bob hangs 3 units below anchor at y=3, lowest point = y=0.
      const triggerBody = makeNode("RigidBody2D", 40, 640, {
        type: "static", initX: 0, initY: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: triggerBody, port: "world" } });
      const triggerColl = makeNode("BoxCollider2D", 280, 640, {
        width: 1.5, height: 2, isSensor: 1
      });
      state.edges.push({ from: { node: triggerBody, port: "bodyId" }, to: { node: triggerColl, port: "body" } });
      const triggerBox = makeNode("Box", 520, 640, { width: 1.5, height: 2, depth: 1 });
      const triggerT = makeNode("Translate", 700, 640, { x: 0, y: 0, z: 1 });
      state.edges.push({ from: { node: triggerBox, port: "mesh" }, to: { node: triggerT, port: "mesh" } });

      // Contact event: bob <-> trigger zone
      const contact = makeNode("ContactEvent2D", 40, 780, {});
      state.edges.push({ from: { node: bob, port: "bodyId" }, to: { node: contact, port: "bodyA" } });
      state.edges.push({ from: { node: triggerBody, port: "bodyId" }, to: { node: contact, port: "bodyB" } });

      // Camera + Scene
      const cam = makeNode("OrthoCamera2D", 1060, 60, {
        posX: 0, posY: 0, orthoSize: 5, pixelSnap: 0
      });
      const scene = makeNode("Scene2D", 1240, 60, {
        clearR: 0.08, clearG: 0.1, clearB: 0.16
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: anchorT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: bobT, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: triggerT, port: "mesh" }, to: { node: scene, port: "mesh3" } });
      const vo = makeNode("VisualOutput", 1420, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUD: pass counter
      const hudCount = makeNode("HUDText", 1240, 200, {
        prefix: "passes ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 18, color: "#67ff80", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: { node: contact, port: "enterCount" }, to: { node: hudCount, port: "value" } });
      state.edges.push({ from: { node: hudCount, port: "hud" }, to: { node: scene, port: "hud1" } });

      // HUD: touching status
      const hudTouch = makeNode("HUDText", 1240, 280, {
        prefix: "touching ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 14, color: "#ffcc44", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: contact, port: "touching" }, to: { node: hudTouch, port: "value" } });
      state.edges.push({ from: { node: hudTouch, port: "hud" }, to: { node: scene, port: "hud2" } });

      // Restart
      const restartBtn = makeNode("UIButton", 1240, 360, {
        label: "↺  RESTART",
        x: 12, y: 12, width: 140, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: bob, port: "reset" } });
    }
  },

  /* Phase 8.B.4 -- Physics Platformer. Same tilemap as the Engine
   * Capstone level, but the player is a RigidBody2D + CapsuleCollider2D
   * driven by keyboard forces, colliding with a TilemapCollider2D
   * that auto-builds Rapier colliders from the Level2D. Real physics
   * under the hood instead of the arcade PlatformerBody2D. */
  {
    id: "physics-platformer-2d",
    name: "Physics Platformer",
    sub: "RigidBody2D + TilemapCollider2D · real physics",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <g fill="rgba(85,140,90,0.95)">
        <rect x="0" y="30" width="40" height="6"/>
        <rect x="50" y="30" width="50" height="6"/>
      </g>
      <rect x="0" y="36" width="100" height="8" fill="rgba(105,68,42,0.95)"/>
      <circle cx="25" cy="26" r="4" fill="rgba(80,160,220,0.85)"/>
      <text x="70" y="12" font-family="ui-monospace" font-size="5" fill="rgba(255,200,100,0.8)">RAPIER</text>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld2D", 40, 60, {
        gravityX: 0, gravityY: -12, subSteps: 4
      });

      // Level2D with a simple platformer layout
      const level = makeNode("Level2D", 40, 200, {
        layers: JSON.stringify([{
          type: "tilemap", name: "level", depthZ: 0, collides: true,
          tileSize: 1, originX: 0, originY: 0,
          tileData:
            ".....................\n" +
            ".....................\n" +
            ".....................\n" +
            "....................\n" +
            "........3333........\n" +
            ".....................\n" +
            "....333.....333.....\n" +
            ".....................\n" +
            "111111111...11111111\n" +
            "222222222...22222222",
          color1R: 0.30, color1G: 0.62, color1B: 0.38,
          color2R: 0.42, color2G: 0.28, color2B: 0.18,
          color3R: 0.62, color3G: 0.62, color3B: 0.72,
          skipRenderChars: "",
          tileset: "", tileMap: {}, tilesetFramesX: 4, tilesetFramesY: 2
        }], null, 2)
      });

      // TilemapCollider2D: auto-builds Rapier colliders from level
      const tmColl = makeNode("TilemapCollider2D", 280, 200, {
        friction: 0.6, restitution: 0.05
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: tmColl, port: "world" } });
      state.edges.push({ from: { node: level, port: "mesh" }, to: { node: tmColl, port: "tilemap" } });

      // Player: dynamic capsule body, fixedRotation so it stays upright
      const player = makeNode("RigidBody2D", 40, 380, {
        type: "dynamic", initX: -6, initY: 2,
        fixedRotation: 1, linearDamping: 6, angularDamping: 1,
        gravityScale: 1, forceScale: 6, impulseScale: 3
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: player, port: "world" } });
      const playerColl = makeNode("CapsuleCollider2D", 280, 380, {
        radius: 0.25, halfHeight: 0.2, density: 1, friction: 0.3, restitution: 0
      });
      state.edges.push({ from: { node: player, port: "bodyId" }, to: { node: playerColl, port: "body" } });

      // Player visual
      const playerBox = makeNode("Box", 520, 380, { width: 0.5, height: 0.9, depth: 0.5 });
      const playerT = makeNode("Translate", 700, 380, { z: -1 });
      state.edges.push({ from: { node: playerBox, port: "mesh" }, to: { node: playerT, port: "mesh" } });
      state.edges.push({ from: { node: player, port: "x" }, to: { node: playerT, port: "x" } });
      state.edges.push({ from: { node: player, port: "y" }, to: { node: playerT, port: "y" } });

      // Keyboard → forces. Wire KeyAxis2D.x (-1/0/+1) directly
      // into forceX; forceScale=15 multiplies it into real force.
      // Jump (0 or 1) → impulseY; impulseScale=5 for jump kick.
      const keys = makeNode("KeyAxis2D", 40, 520, {
        keyLeft: "KeyA", keyRight: "KeyD", keyJump: "Space"
      });
      state.edges.push({ from: { node: keys, port: "x" }, to: { node: player, port: "forceX" } });
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: player, port: "impulseY" } });

      // Camera follows player
      const cam = makeNode("OrthoCamera2D", 700, 60, {
        posX: 0, posY: 0, orthoSize: 6, pixelSnap: 0
      });
      state.edges.push({ from: { node: player, port: "x" }, to: { node: cam, port: "posX" } });

      // Scene + output
      const scene = makeNode("Scene2D", 900, 60, {
        clearR: 0.45, clearG: 0.72, clearB: 0.88
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: level, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: playerT, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      const vo = makeNode("VisualOutput", 1100, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUD: collider count
      const hudColl = makeNode("HUDText", 900, 200, {
        prefix: "colliders ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 14, color: "#67c8ff", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: tmColl, port: "colliderCount" }, to: { node: hudColl, port: "value" } });
      state.edges.push({ from: { node: hudColl, port: "hud" }, to: { node: scene, port: "hud1" } });

      // Restart
      const restartBtn = makeNode("UIButton", 900, 300, {
        label: "↺  RESTART",
        x: 12, y: 12, width: 140, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: player, port: "reset" } });
    }
  },

  /* Phase 8.B.5 -- 2D Physics Capstone Puzzle. Push a box into a
   * sensor goal zone while avoiding a swinging pendulum hazard.
   * Full intro→playing→won flow using the wire-everything pattern:
   * 3 Scene2D → StageManager → VisualOutput, UI via show wires. */
  {
    id: "physics-puzzle-2d",
    name: "2D Physics Puzzle",
    sub: "push box to goal · pendulum hazard · intro/play/won",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="5" y="32" width="90" height="4" rx="1" fill="rgba(100,100,100,0.8)"/>
      <rect x="30" y="24" width="8" height="8" rx="1" fill="rgba(80,160,220,0.85)"/>
      <rect x="70" y="28" width="12" height="4" rx="1" fill="rgba(100,220,100,0.3)" stroke="rgba(100,220,100,0.6)" stroke-width="0.5"/>
      <circle cx="50" cy="8" r="2" fill="rgba(150,150,150,0.6)"/>
      <line x1="50" y1="8" x2="42" y2="24" stroke="rgba(200,80,80,0.7)" stroke-width="1.5"/>
      <circle cx="42" cy="24" r="3" fill="rgba(220,80,80,0.85)"/>
    </svg>`,
    build: () => {
      const tagStage = (id, name) => {
        const n = state.nodes.find(x => x && x.id === id);
        if (n) n.stage = name;
      };

      // ─── FSM + StageManager ────────────────────────────────
      const fsm = makeNode("StateMachine", 40, 60, {
        states: "intro,playing,won",
        transitions: JSON.stringify([
          { from: 0, to: 1 },
          { from: 1, to: 2 },
          { from: 2, to: 0 }
        ]),
        initialState: 0
      });
      const mgr = makeNode("StageManager", 280, 60, {
        stages: "intro,playing,won",
        active: 0
      });
      state.edges.push({ from: { node: fsm, port: "current" }, to: { node: mgr, port: "active" } });
      const playAwake = makeNode("OnAwake", 520, 60);
      tagStage(playAwake, "playing");

      // ─── Physics world ─────────────────────────────────────
      const world = makeNode("PhysicsWorld2D", 40, 160, {
        gravityX: 0, gravityY: -9.8, subSteps: 4
      });

      // ─── Ground ────────────────────────────────────────────
      const ground = makeNode("RigidBody2D", 40, 280, {
        type: "static", initX: 0, initY: -3
      });
      tagStage(ground, "playing");
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider2D", 280, 280, {
        width: 16, height: 1, friction: 0.8, restitution: 0
      });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      const groundBox = makeNode("Box", 520, 280, { width: 16, height: 1, depth: 1 });
      const groundT = makeNode("Translate", 700, 280, { x: 0, y: -3, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // ─── Player (WASD control) ─────────────────────────────
      const player = makeNode("RigidBody2D", 40, 420, {
        type: "dynamic", initX: -5, initY: -1,
        fixedRotation: 1, linearDamping: 5, gravityScale: 1,
        forceScale: 8, impulseScale: 4
      });
      tagStage(player, "playing");
      state.edges.push({ from: { node: world, port: "world" }, to: { node: player, port: "world" } });
      const playerC = makeNode("CapsuleCollider2D", 280, 420, {
        radius: 0.25, halfHeight: 0.15, density: 1, friction: 0.4
      });
      state.edges.push({ from: { node: player, port: "bodyId" }, to: { node: playerC, port: "body" } });
      const keys = makeNode("KeyAxis2D", 40, 560, {
        keyLeft: "KeyA", keyRight: "KeyD", keyJump: "Space"
      });
      tagStage(keys, "playing");
      state.edges.push({ from: { node: keys, port: "x" }, to: { node: player, port: "forceX" } });
      state.edges.push({ from: { node: keys, port: "jump" }, to: { node: player, port: "impulseY" } });
      const playerBox = makeNode("Box", 520, 420, { width: 0.5, height: 0.8, depth: 0.5 });
      const playerTr = makeNode("Translate", 700, 420, { z: -1 });
      state.edges.push({ from: { node: playerBox, port: "mesh" }, to: { node: playerTr, port: "mesh" } });
      state.edges.push({ from: { node: player, port: "x" }, to: { node: playerTr, port: "x" } });
      state.edges.push({ from: { node: player, port: "y" }, to: { node: playerTr, port: "y" } });

      // ─── Pushable box ──────────────────────────────────────
      const crate = makeNode("RigidBody2D", 40, 700, {
        type: "dynamic", initX: 0, initY: -1.5,
        linearDamping: 2, angularDamping: 2
      });
      tagStage(crate, "playing");
      state.edges.push({ from: { node: world, port: "world" }, to: { node: crate, port: "world" } });
      const crateC = makeNode("BoxCollider2D", 280, 700, {
        width: 0.9, height: 0.9, density: 0.8, friction: 0.7, restitution: 0.1
      });
      state.edges.push({ from: { node: crate, port: "bodyId" }, to: { node: crateC, port: "body" } });
      const crateBox = makeNode("Box", 520, 700, { width: 0.9, height: 0.9, depth: 0.9 });
      const crateR = makeNode("Rotate", 700, 700);
      const crateTr = makeNode("Translate", 880, 700, { z: -0.5 });
      state.edges.push({ from: { node: crateBox, port: "mesh" }, to: { node: crateR, port: "mesh" } });
      state.edges.push({ from: { node: crate, port: "rotation" }, to: { node: crateR, port: "angleZ" } });
      state.edges.push({ from: { node: crateR, port: "mesh" }, to: { node: crateTr, port: "mesh" } });
      state.edges.push({ from: { node: crate, port: "x" }, to: { node: crateTr, port: "x" } });
      state.edges.push({ from: { node: crate, port: "y" }, to: { node: crateTr, port: "y" } });

      // ─── Goal sensor zone ──────────────────────────────────
      const goalBody = makeNode("RigidBody2D", 40, 840, {
        type: "static", initX: 5, initY: -2
      });
      tagStage(goalBody, "playing");
      state.edges.push({ from: { node: world, port: "world" }, to: { node: goalBody, port: "world" } });
      const goalC = makeNode("BoxCollider2D", 280, 840, {
        width: 1.5, height: 1.5, isSensor: 1
      });
      state.edges.push({ from: { node: goalBody, port: "bodyId" }, to: { node: goalC, port: "body" } });
      const goalBox = makeNode("Box", 520, 840, { width: 1.5, height: 1.5, depth: 1 });
      const goalTr = makeNode("Translate", 700, 840, { x: 5, y: -2, z: 1 });
      state.edges.push({ from: { node: goalBox, port: "mesh" }, to: { node: goalTr, port: "mesh" } });

      // Contact: crate enters goal zone → win
      const goalContact = makeNode("ContactEvent2D", 280, 960, {});
      state.edges.push({ from: { node: crate, port: "bodyId" }, to: { node: goalContact, port: "bodyA" } });
      state.edges.push({ from: { node: goalBody, port: "bodyId" }, to: { node: goalContact, port: "bodyB" } });
      state.edges.push({ from: { node: goalContact, port: "enterTrigger" }, to: { node: fsm, port: "trans1" } });

      // ─── Pendulum hazard ───────────────────────────────────
      const pendAnchor = makeNode("RigidBody2D", 40, 1080, {
        type: "static", initX: 0, initY: 3
      });
      tagStage(pendAnchor, "playing");
      state.edges.push({ from: { node: world, port: "world" }, to: { node: pendAnchor, port: "world" } });
      const pendAnchorC = makeNode("BoxCollider2D", 280, 1080, {
        width: 0.3, height: 0.3
      });
      state.edges.push({ from: { node: pendAnchor, port: "bodyId" }, to: { node: pendAnchorC, port: "body" } });
      const pendBob = makeNode("RigidBody2D", 40, 1200, {
        type: "dynamic", initX: -3, initY: 1, linearDamping: 0.01
      });
      tagStage(pendBob, "playing");
      state.edges.push({ from: { node: world, port: "world" }, to: { node: pendBob, port: "world" } });
      const pendBobC = makeNode("CircleCollider2D", 280, 1200, {
        radius: 0.35, density: 4, friction: 0.2, restitution: 0.3
      });
      state.edges.push({ from: { node: pendBob, port: "bodyId" }, to: { node: pendBobC, port: "body" } });
      const pendJoint = makeNode("RevoluteJoint2D", 40, 1320, {
        anchorAx: 0, anchorAy: 0, anchorBx: 0, anchorBy: 2
      });
      state.edges.push({ from: { node: pendAnchor, port: "bodyId" }, to: { node: pendJoint, port: "bodyA" } });
      state.edges.push({ from: { node: pendBob, port: "bodyId" }, to: { node: pendJoint, port: "bodyB" } });
      const pendBox = makeNode("Box", 520, 1200, { width: 0.7, height: 0.7, depth: 0.7 });
      const pendTr = makeNode("Translate", 700, 1200, { z: -0.5 });
      state.edges.push({ from: { node: pendBox, port: "mesh" }, to: { node: pendTr, port: "mesh" } });
      state.edges.push({ from: { node: pendBob, port: "x" }, to: { node: pendTr, port: "x" } });
      state.edges.push({ from: { node: pendBob, port: "y" }, to: { node: pendTr, port: "y" } });
      const anchorVis = makeNode("Box", 520, 1080, { width: 0.3, height: 0.3, depth: 0.3 });
      const anchorVisTr = makeNode("Translate", 700, 1080, { x: 0, y: 3, z: 0 });
      state.edges.push({ from: { node: anchorVis, port: "mesh" }, to: { node: anchorVisTr, port: "mesh" } });

      // ─── Resets ────────────────────────────────────────────
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: player, port: "reset" } });
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: crate, port: "reset" } });
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: pendBob, port: "reset" } });

      // ─── Camera ────────────────────────────────────────────
      const cam = makeNode("OrthoCamera2D", 900, 60, {
        posX: 0, posY: 0, orthoSize: 5, pixelSnap: 0
      });

      // ─── 3 scenes → StageManager → VO ─────────────────────
      const sceneIntro = makeNode("Scene2D", 1100, 60, { clearR: 0.12, clearG: 0.14, clearB: 0.22 });
      const scenePlay = makeNode("Scene2D", 1100, 180, { clearR: 0.2, clearG: 0.25, clearB: 0.35 });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scenePlay, port: "camera" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scenePlay, port: "mesh1" } });
      state.edges.push({ from: { node: playerTr, port: "mesh" }, to: { node: scenePlay, port: "mesh2" } });
      state.edges.push({ from: { node: crateTr, port: "mesh" }, to: { node: scenePlay, port: "mesh3" } });
      state.edges.push({ from: { node: goalTr, port: "mesh" }, to: { node: scenePlay, port: "mesh4" } });
      state.edges.push({ from: { node: pendTr, port: "mesh" }, to: { node: scenePlay, port: "mesh5" } });
      state.edges.push({ from: { node: anchorVisTr, port: "mesh" }, to: { node: scenePlay, port: "mesh6" } });
      const sceneWon = makeNode("Scene2D", 1100, 300, { clearR: 0.18, clearG: 0.22, clearB: 0.12 });
      state.edges.push({ from: { node: sceneIntro, port: "out" }, to: { node: mgr, port: "in0" } });
      state.edges.push({ from: { node: scenePlay, port: "out" }, to: { node: mgr, port: "in1" } });
      state.edges.push({ from: { node: sceneWon, port: "out" }, to: { node: mgr, port: "in2" } });
      const vo = makeNode("VisualOutput", 1300, 180, { display: 0 });
      state.edges.push({ from: { node: mgr, port: "out" }, to: { node: vo, port: "in" } });

      // ─── Intro UI ──────────────────────────────────────────
      const introPanel = makeNode("UIPanel", 1300, 360, {
        x: 0, y: -30, width: 400, height: 240,
        color: "#0a1018", borderColor: "#9bd0ff", borderWidth: 2,
        borderRadius: 10, opacity: 0.94, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introPanel, port: "show" } });
      const introTitle = makeNode("UIText", 1300, 440, {
        text: "PHYSICS PUZZLE", x: 0, y: -80, fontSize: 32, width: 380,
        color: "#cfe9ff", align: "center", opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introTitle, port: "show" } });
      const introSub = makeNode("UIText", 1300, 500, {
        text: "push the crate into the green zone",
        x: 0, y: -30, fontSize: 13, width: 380,
        color: "#9bd0ff", align: "center", opacity: 0.7, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introSub, port: "show" } });
      const startBtn = makeNode("UIButton", 1300, 560, {
        label: "▶  START",
        x: 0, y: 30, width: 180, height: 48,
        color: "#3a5a78", hoverColor: "#5a82a8",
        textColor: "#fff", borderColor: "#9bd0ff", borderWidth: 1.5,
        borderRadius: 8, fontSize: 16, opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: startBtn, port: "show" } });
      state.edges.push({ from: { node: startBtn, port: "clicked" }, to: { node: fsm, port: "trans0" } });

      // ─── Won UI ────────────────────────────────────────────
      const wonPanel = makeNode("UIPanel", 1300, 640, {
        x: 0, y: -30, width: 360, height: 220,
        color: "#1a2a08", borderColor: "#a0e060", borderWidth: 2,
        borderRadius: 10, opacity: 0.94, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: wonPanel, port: "show" } });
      const wonTitle = makeNode("UIText", 1300, 720, {
        text: "SOLVED!", x: 0, y: -80, fontSize: 38, width: 340,
        color: "#d0ff80", align: "center", opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: wonTitle, port: "show" } });
      const againBtn = makeNode("UIButton", 1300, 800, {
        label: "↺  PLAY AGAIN",
        x: 0, y: 20, width: 200, height: 44,
        color: "#3a5a20", hoverColor: "#5a8a30",
        textColor: "#d0ff80", borderColor: "#a0e060", borderWidth: 1.5,
        borderRadius: 8, fontSize: 15, opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: againBtn, port: "show" } });
      state.edges.push({ from: { node: againBtn, port: "clicked" }, to: { node: fsm, port: "trans2" } });

      // ─── Playing restart ───────────────────────────────────
      const restartBtn = makeNode("UIButton", 1300, 900, {
        label: "↺  restart",
        x: 12, y: 12, width: 120, height: 32,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1,
        borderRadius: 4, fontSize: 12, opacity: 0.92,
        corner: "top-right"
      });
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: restartBtn, port: "show" } });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: player, port: "reset" } });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: crate, port: "reset" } });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: pendBob, port: "reset" } });
    }
  },

  /* Phase 8.B.9 -- Sphere Sweep Aim. A Spherecast3D sweeps a sphere
   * from a fixed origin toward a row of boxes; an ANGLE slider tilts
   * the cast up/down. A marker sphere snaps to the swept sphere's
   * center at the moment of impact. Demonstrates the swept-shape
   * query (distinct from a static OverlapSphere). */
  {
    id: "spherecast-aim-3d",
    name: "Sphere Sweep Aim",
    sub: "Spherecast3D · swept-shape query · aim slider",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <circle cx="14" cy="30" r="4" fill="rgba(120,200,255,0.9)"/>
      <line x1="18" y1="29" x2="64" y2="18" stroke="rgba(120,200,255,0.5)" stroke-width="1.5" stroke-dasharray="3 2"/>
      <circle cx="64" cy="18" r="6" fill="none" stroke="rgba(255,90,90,0.9)" stroke-width="1.5"/>
      <g fill="rgba(180,140,90,0.85)" stroke="rgba(220,180,120,1)" stroke-width="0.5">
        <rect x="70" y="14" width="9" height="14"/>
        <rect x="82" y="12" width="9" height="16"/>
      </g>
      <rect x="5" y="34" width="90" height="3" fill="rgba(100,100,100,0.6)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 4
      });

      // Ground
      const ground = makeNode("RigidBody3D", 40, 160, { type: "static", initX: 0, initY: 0, initZ: 0 });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 240, 160, { halfX: 16, halfY: 0.5, halfZ: 8, friction: 0.8 });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      const groundBox = makeNode("Box", 440, 160, { width: 32, height: 1, depth: 16 });
      const groundMat = makeNode("PhysicalMat", 620, 160, { r: 0.3, g: 0.32, b: 0.3, metallic: 0, roughness: 0.9 });
      const groundT = makeNode("Translate", 800, 160, { x: 0, y: 0, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundMat, port: "mesh" } });
      state.edges.push({ from: { node: groundMat, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Vertical column of 4 STATIC boxes at the same distance (x≈0),
      // climbing in Y with small gaps, plus a tall back-wall behind.
      // Same distance = the AIM Y slider maps evenly to box height, so
      // the swept sphere scans cleanly up the column. The back wall
      // catches aims above the top box so it never flies into the void.
      const SWEEP_R = 0.6;
      const HALF = 0.7;                 // half-extent of each column box
      const COL_X = 0;                  // all boxes share this X
      const boxMeshSlots = [];
      const cols = [
        { y: 1.2, c: { r: 0.82, g: 0.45, b: 0.30 } },
        { y: 3.0, c: { r: 0.55, g: 0.72, b: 0.45 } },
        { y: 4.8, c: { r: 0.45, g: 0.55, b: 0.82 } },
        { y: 6.6, c: { r: 0.82, g: 0.72, b: 0.38 } }
      ];
      let stepRow = 300;
      for (const s of cols) {
        const tb = makeNode("RigidBody3D", 40, stepRow, { type: "static", initX: COL_X, initY: s.y, initZ: 0 });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: tb, port: "world" } });
        const tc = makeNode("BoxCollider3D", 220, stepRow, { halfX: HALF, halfY: HALF, halfZ: HALF, friction: 0.7 });
        state.edges.push({ from: { node: tb, port: "bodyId" }, to: { node: tc, port: "body" } });
        const bm = makeNode("Box", 400, stepRow, { width: HALF * 2, height: HALF * 2, depth: HALF * 2 });
        const mat = makeNode("PhysicalMat", 560, stepRow, { r: s.c.r, g: s.c.g, b: s.c.b, metallic: 0.05, roughness: 0.65 });
        // Static body: drive the mesh from FIXED coords (body readback
        // is 0 on the first frames, which would flash the box at origin).
        const t = makeNode("Translate", 720, stepRow, { x: COL_X, y: s.y, z: 0 });
        state.edges.push({ from: { node: bm, port: "mesh" }, to: { node: mat, port: "mesh" } });
        state.edges.push({ from: { node: mat, port: "mesh" }, to: { node: t, port: "mesh" } });
        boxMeshSlots.push(t);
        stepRow += 70;
      }
      // Tall back-wall (static) behind the column so high aims (above
      // the top box) always hit something instead of flying off.
      const wallBody = makeNode("RigidBody3D", 40, stepRow, { type: "static", initX: 4, initY: 5, initZ: 0 });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: wallBody, port: "world" } });
      const wallColl = makeNode("BoxCollider3D", 220, stepRow, { halfX: 0.5, halfY: 6, halfZ: 3, friction: 0.7 });
      state.edges.push({ from: { node: wallBody, port: "bodyId" }, to: { node: wallColl, port: "body" } });
      const wallBox = makeNode("Box", 400, stepRow, { width: 1, height: 12, depth: 6 });
      const wallMat = makeNode("PhysicalMat", 560, stepRow, { r: 0.4, g: 0.4, b: 0.45, metallic: 0.1, roughness: 0.8 });
      const wallT = makeNode("Translate", 720, stepRow, { x: 4, y: 5, z: 0 });
      state.edges.push({ from: { node: wallBox, port: "mesh" }, to: { node: wallMat, port: "mesh" } });
      state.edges.push({ from: { node: wallMat, port: "mesh" }, to: { node: wallT, port: "mesh" } });
      boxMeshSlots.push(wallT);

      // Spherecast3D: fixed origin on the left, sweeping toward +X.
      // AIM Y tilts dirY so the sweep climbs the column.
      const cast = makeNode("Spherecast3D", 40, 760, {
        originX: -9, originY: 1.2, originZ: 0,
        dirX: 1, dirY: 0, dirZ: 0,
        radius: SWEEP_R, maxDistance: 30
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: cast, port: "world" } });

      // AIM Y slider drives dirY. Range chosen so the whole travel maps
      // onto the column (bottom box at 0, top box near 0.6).
      const aim = makeNode("UISlider", 40, 900, {
        label: "AIM Y", min: -0.05, max: 0.75, value: 0, step: 0.01,
        x: 12, y: 12, width: 220, height: 30, corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: aim, port: "value" }, to: { node: cast, port: "dirY" } });

      // Marker sphere rendered at the swept sphere's center at impact.
      // Fixed radius == cast radius (mesh-gen radius isn't wire-driven).
      const marker = makeNode("Sphere", 280, 760, { radius: SWEEP_R, stacks: 16, slices: 24 });
      const markerMat = makeNode("PhysicalMat", 460, 760, { r: 0.95, g: 0.25, b: 0.25, metallic: 0.1, roughness: 0.3 });
      const markerT = makeNode("Translate", 640, 760);
      state.edges.push({ from: { node: marker, port: "mesh" }, to: { node: markerMat, port: "mesh" } });
      state.edges.push({ from: { node: markerMat, port: "mesh" }, to: { node: markerT, port: "mesh" } });
      state.edges.push({ from: { node: cast, port: "hitX" }, to: { node: markerT, port: "x" } });
      state.edges.push({ from: { node: cast, port: "hitY" }, to: { node: markerT, port: "y" } });
      state.edges.push({ from: { node: cast, port: "hitZ" }, to: { node: markerT, port: "z" } });

      // Origin marker (small cyan sphere at the cast source)
      const origin = makeNode("Sphere", 280, 900, { radius: 0.25, stacks: 10, slices: 14 });
      const originMat = makeNode("PhysicalMat", 460, 900, { r: 0.4, g: 0.8, b: 1.0, metallic: 0.3, roughness: 0.3 });
      const originT = makeNode("Translate", 640, 900, { x: -9, y: 1.0, z: 0 });
      state.edges.push({ from: { node: origin, port: "mesh" }, to: { node: originMat, port: "mesh" } });
      state.edges.push({ from: { node: originMat, port: "mesh" }, to: { node: originT, port: "mesh" } });

      // Camera + light + scene
      const cam = makeNode("FPCamera", 1100, 60, {
        posX: -2, posY: 5, posZ: 19, pitch: -6, yaw: 180, fov: 62, near: 0.1, far: 200, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 1100, 140, { dirX: -0.4, dirY: -1, dirZ: -0.4, intensity: 1.3 });
      const scene = makeNode("Scene3D", 1300, 60, { clearR: 0.12, clearG: 0.14, clearB: 0.2 });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: markerT, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: originT, port: "mesh" }, to: { node: scene, port: "mesh3" } });
      for (let i = 0; i < boxMeshSlots.length && i + 4 <= 8; i++) {
        state.edges.push({ from: { node: boxMeshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 4) } });
      }
      const vo = makeNode("VisualOutput", 1500, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUDs: hit state + distance
      const hudHit = makeNode("HUDText", 1300, 200, {
        prefix: "hit ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 16, color: "#ff6a6a", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: { node: cast, port: "hit" }, to: { node: hudHit, port: "value" } });
      state.edges.push({ from: { node: hudHit, port: "hud" }, to: { node: scene, port: "hud1" } });
      const hudDist = makeNode("HUDText", 1300, 280, {
        prefix: "distance ", value: 0, decimals: 2,
        corner: "top-left", fontSize: 14, color: "#9bd0ff", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: cast, port: "distance" }, to: { node: hudDist, port: "value" } });
      state.edges.push({ from: { node: hudDist, port: "hud" }, to: { node: scene, port: "hud2" } });
      const hudHelp = makeNode("HUDText", 1300, 360, {
        text: "Drag AIM Y: the swept sphere climbs the staircase, stopping at the first box it touches (red marker = swept sphere center at impact). Aim high → it clears the steps and hits the back wall.",
        value: NaN, corner: "bottom-left", fontSize: 11, color: "#cfe9ff", opacity: 0.7, margin: 18
      });
      state.edges.push({ from: { node: hudHelp, port: "hud" }, to: { node: scene, port: "hud3" } });
    }
  },

  /* Phase 8.B.11 -- Wrecking Ball. A heavy sphere hangs from a static
   * ceiling anchor on a RopeJoint3D (max-distance constraint) with a
   * Rope3D visual tube. Released from the side, it swings down and
   * smashes a wall of destructible bricks. */
  {
    id: "wrecking-ball-3d",
    name: "Wrecking Ball",
    sub: "RopeJoint3D + Rope3D · PBD rope · smashes bricks",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="6" y="4" width="40" height="3" fill="rgba(120,120,130,0.9)"/>
      <line x1="14" y1="7" x2="30" y2="26" stroke="rgba(180,150,90,0.9)" stroke-width="1.5"/>
      <circle cx="32" cy="29" r="7" fill="rgba(90,95,110,0.95)" stroke="rgba(150,160,180,1)" stroke-width="0.8"/>
      <g fill="rgba(180,110,70,0.9)" stroke="rgba(220,160,110,1)" stroke-width="0.5">
        <rect x="64" y="22" width="11" height="11"/>
        <rect x="76" y="22" width="11" height="11"/>
        <rect x="70" y="11" width="11" height="11"/>
      </g>
      <rect x="5" y="36" width="90" height="3" fill="rgba(100,100,100,0.6)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 10
      });

      // Ground
      const ground = makeNode("RigidBody3D", 40, 160, { type: "static", initX: 0, initY: 0, initZ: 0 });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 240, 160, { halfX: 18, halfY: 0.5, halfZ: 10, friction: 0.8 });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      const groundBox = makeNode("Box", 440, 160, { width: 36, height: 1, depth: 20 });
      const groundMat = makeNode("PhysicalMat", 620, 160, { r: 0.3, g: 0.32, b: 0.3, metallic: 0, roughness: 0.9 });
      const groundT = makeNode("Translate", 800, 160, { x: 0, y: 0, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundMat, port: "mesh" } });
      state.edges.push({ from: { node: groundMat, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Ceiling anchor (static) + small visual cube
      const ANCHOR = { x: 0, y: 9, z: 0 };
      const anchor = makeNode("RigidBody3D", 40, 280, { type: "static", initX: ANCHOR.x, initY: ANCHOR.y, initZ: ANCHOR.z });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: anchor, port: "world" } });
      const anchorC = makeNode("BoxCollider3D", 240, 280, { halfX: 0.6, halfY: 0.3, halfZ: 0.6, isSensor: 1 });
      state.edges.push({ from: { node: anchor, port: "bodyId" }, to: { node: anchorC, port: "body" } });
      const anchorBox = makeNode("Box", 440, 280, { width: 1.2, height: 0.6, depth: 1.2 });
      const anchorMat = makeNode("PhysicalMat", 620, 280, { r: 0.5, g: 0.5, b: 0.55, metallic: 0.4, roughness: 0.5 });
      const anchorT = makeNode("Translate", 800, 280, { x: ANCHOR.x, y: ANCHOR.y, z: ANCHOR.z });
      state.edges.push({ from: { node: anchorBox, port: "mesh" }, to: { node: anchorMat, port: "mesh" } });
      state.edges.push({ from: { node: anchorMat, port: "mesh" }, to: { node: anchorT, port: "mesh" } });

      // Wrecking ball: heavy dynamic sphere. It hangs straight down
      // from the anchor (initY = anchorY - LEN) and gets a sideways
      // shove (initVx) so it swings into the wall. Straight-down start
      // keeps the rope taut + the joint consistent at rest (the rigid-
      // rod fallback couples orientation to position, so a raised start
      // would snap). Rope short enough to clear the ground at the
      // bottom: anchorY - LEN - radius = 9 - 6.5 - 1.3 = 1.2 > 0.5.
      const ROPE_LEN = 6.5;
      const ball = makeNode("RigidBody3D", 40, 420, {
        type: "dynamic", initX: 0, initY: ANCHOR.y - ROPE_LEN, initZ: 0,
        initVx: 8, initVy: 0, initVz: 0,
        linearDamping: 0.04, angularDamping: 0.1, ccd: 1
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ball, port: "world" } });
      const ballC = makeNode("SphereCollider3D", 240, 420, { radius: 1.3, density: 8, friction: 0.5, restitution: 0.1 });
      state.edges.push({ from: { node: ball, port: "bodyId" }, to: { node: ballC, port: "body" } });
      const ballMesh = makeNode("Sphere", 440, 420, { radius: 1.3, stacks: 18, slices: 26 });
      const ballMat = makeNode("PhysicalMat", 620, 420, { r: 0.32, g: 0.34, b: 0.4, metallic: 0.9, roughness: 0.25 });
      const ballT = makeNode("Translate", 800, 420);
      state.edges.push({ from: { node: ballMesh, port: "mesh" }, to: { node: ballMat, port: "mesh" } });
      state.edges.push({ from: { node: ballMat, port: "mesh" }, to: { node: ballT, port: "mesh" } });
      state.edges.push({ from: { node: ball, port: "x" }, to: { node: ballT, port: "x" } });
      state.edges.push({ from: { node: ball, port: "y" }, to: { node: ballT, port: "y" } });
      state.edges.push({ from: { node: ball, port: "z" }, to: { node: ballT, port: "z" } });

      // RopeJoint3D: physical max-distance constraint anchor↔ball.
      const ropeJoint = makeNode("RopeJoint3D", 40, 560, {
        length: ROPE_LEN,
        anchorAx: 0, anchorAy: 0, anchorAz: 0,
        anchorBx: 0, anchorBy: 0, anchorBz: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ropeJoint, port: "world" } });
      state.edges.push({ from: { node: anchor, port: "bodyId" }, to: { node: ropeJoint, port: "bodyA" } });
      state.edges.push({ from: { node: ball, port: "bodyId" }, to: { node: ropeJoint, port: "bodyB" } });

      // Rope3D: visual PBD tube following anchor → ball.
      const rope = makeNode("Rope3D", 280, 560, {
        segments: 18, radius: 0.12, stiffness: 1, gravity: -9.8,
        r: 0.5, g: 0.36, b: 0.2
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: rope, port: "world" } });
      state.edges.push({ from: { node: anchor, port: "bodyId" }, to: { node: rope, port: "attachA" } });
      state.edges.push({ from: { node: ball, port: "bodyId" }, to: { node: rope, port: "attachB" } });
      const ropeMat = makeNode("PhysicalMat", 520, 560, { r: 0.5, g: 0.36, b: 0.2, metallic: 0.1, roughness: 0.8 });
      state.edges.push({ from: { node: rope, port: "mesh" }, to: { node: ropeMat, port: "mesh" } });

      // Wall: 2×2 grid of destructible bricks at x≈3 (in the swing path)
      const wallDests = [], wallBodies = [], wallMeshSlots = [];
      const bw = 1.4;
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          const bx = 2 + col * 0.05;
          const by = 0.5 + bw * 0.5 + row * (bw + 0.04);
          const bz = (col - 0.5) * (bw + 0.1);
          const row0 = 700 + (row * 2 + col) * 70;
          const tb = makeNode("RigidBody3D", 40, row0, { type: "static", initX: bx, initY: by, initZ: bz });
          state.edges.push({ from: { node: world, port: "world" }, to: { node: tb, port: "world" } });
          const tc = makeNode("BoxCollider3D", 200, row0, { halfX: bw*0.5, halfY: bw*0.5, halfZ: bw*0.5, density: 0.8, friction: 0.6 });
          state.edges.push({ from: { node: tb, port: "bodyId" }, to: { node: tc, port: "body" } });
          const sb = makeNode("Box", 360, row0, { width: bw, height: bw, depth: bw });
          const fr = makeNode("FractureMesh", 520, row0, { fragments: 9, seed: 7 + row * 2 + col, interiorR: 0.4, interiorG: 0.28, interiorB: 0.2 });
          state.edges.push({ from: { node: sb, port: "mesh" }, to: { node: fr, port: "mesh" } });
          const db = makeNode("DestructibleBody3D", 680, row0, { damageThreshold: 150, fragmentLifetime: 12, radialImpulse: 2.5, maxDepth: 1, subFragments: 0 });
          state.edges.push({ from: { node: world, port: "world" }, to: { node: db, port: "world" } });
          state.edges.push({ from: { node: tb, port: "bodyId" }, to: { node: db, port: "body" } });
          state.edges.push({ from: { node: sb, port: "mesh" }, to: { node: db, port: "mesh" } });
          state.edges.push({ from: { node: fr, port: "mesh" }, to: { node: db, port: "fracture" } });
          const dm = makeNode("PhysicalMat", 840, row0, { r: 0.78, g: 0.45, b: 0.3, metallic: 0, roughness: 0.7 });
          state.edges.push({ from: { node: db, port: "mesh" }, to: { node: dm, port: "mesh" } });
          wallBodies.push(tb); wallDests.push(db); wallMeshSlots.push(dm);
        }
      }

      // RESET button — re-raise the ball + restore the wall
      const resetBtn = makeNode("UIButton", 40, 1000, {
        label: "↺  RESET",
        x: 12, y: 12, width: 140, height: 38,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 14, opacity: 0.92, corner: "bottom-left"
      });
      state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: ball, port: "reset" } });
      for (const db of wallDests) state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: db, port: "reset" } });
      for (const tb of wallBodies) state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: tb, port: "reset" } });

      // Camera + light + scene
      const cam = makeNode("FPCamera", 1100, 60, {
        posX: 1, posY: 6, posZ: 20, pitch: -10, yaw: 180, fov: 62, near: 0.1, far: 300, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 1100, 140, { dirX: -0.4, dirY: -1, dirZ: -0.4, intensity: 1.3 });
      const scene = makeNode("Scene3D", 1300, 60, { clearR: 0.5, clearG: 0.65, clearB: 0.82 });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: ropeMat, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: ballT, port: "mesh" }, to: { node: scene, port: "mesh3" } });
      state.edges.push({ from: { node: anchorT, port: "mesh" }, to: { node: scene, port: "mesh4" } });
      for (let i = 0; i < wallMeshSlots.length && i + 5 <= 8; i++) {
        state.edges.push({ from: { node: wallMeshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 5) } });
      }
      const vo = makeNode("VisualOutput", 1500, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUD
      const hudHelp = makeNode("HUDText", 1300, 200, {
        text: "Heavy ball on a RopeJoint3D (max-distance) swings from the anchor and smashes the bricks. The Rope3D tube is a PBD chain following both ends. RESET to swing again.",
        value: NaN, corner: "bottom-left", fontSize: 11, color: "#fff", opacity: 0.7, margin: 18
      });
      state.edges.push({ from: { node: hudHelp, port: "hud" }, to: { node: scene, port: "hud1" } });
    }
  },

  /* Phase 8.B.12 -- Flag in Wind. A Cloth3D pinned along its left
   * edge to a pole, fluttering under a Wind3D (+Z) + per-particle
   * turbulence. A WIND slider tunes the strength. */
  {
    id: "flag-wind-3d",
    name: "Flag in Wind",
    sub: "Cloth3D · PBD grid · wind flutter",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="16" y="6" width="2.5" height="34" fill="rgba(150,150,160,0.9)"/>
      <path d="M 18 9 Q 36 4 54 9 Q 72 14 90 9 L 90 26 Q 72 31 54 26 Q 36 21 18 26 Z" fill="rgba(200,60,70,0.9)"/>
      <path d="M 18 9 Q 36 4 54 9 Q 72 14 90 9" fill="none" stroke="rgba(255,140,150,0.7)" stroke-width="0.8"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 4
      });

      // Ground
      const groundBox = makeNode("Box", 440, 160, { width: 30, height: 1, depth: 20 });
      const groundMat = makeNode("PhysicalMat", 620, 160, { r: 0.28, g: 0.3, b: 0.28, metallic: 0, roughness: 0.9 });
      const groundT = makeNode("Translate", 800, 160, { x: 0, y: -0.5, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundMat, port: "mesh" } });
      state.edges.push({ from: { node: groundMat, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Pole (visual only): tall thin box at x=0
      const poleBox = makeNode("Box", 440, 280, { width: 0.35, height: 8, depth: 0.35 });
      const poleMat = makeNode("PhysicalMat", 620, 280, { r: 0.55, g: 0.55, b: 0.6, metallic: 0.6, roughness: 0.4 });
      const poleT = makeNode("Translate", 800, 280, { x: 0, y: 4, z: 0 });
      state.edges.push({ from: { node: poleBox, port: "mesh" }, to: { node: poleMat, port: "mesh" } });
      state.edges.push({ from: { node: poleMat, port: "mesh" }, to: { node: poleT, port: "mesh" } });

      // Wind (drives the cloth via its sample output)
      const wind = makeNode("Wind3D", 40, 420, {
        dirX: 0.3, dirY: 0, dirZ: 1, strength: 6, turbulence: 0.5, scale: 0.5
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: wind, port: "world" } });

      // Cloth flag: pinned left edge to the pole, hangs + flutters
      const flag = makeNode("Cloth3D", 280, 420, {
        originX: 0.25, originY: 7.4, originZ: 0,
        width: 6, height: 4, resX: 20, resY: 13,
        stiffness: 0.85, gravity: -9.8, turbulence: 0.6,
        pinEdge: "left", r: 0.78, g: 0.18, b: 0.22
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: flag, port: "world" } });
      state.edges.push({ from: { node: wind, port: "sampleX" }, to: { node: flag, port: "windX" } });
      state.edges.push({ from: { node: wind, port: "sampleY" }, to: { node: flag, port: "windY" } });
      state.edges.push({ from: { node: wind, port: "sampleZ" }, to: { node: flag, port: "windZ" } });
      const flagMat = makeNode("PhysicalMat", 520, 420, { r: 0.78, g: 0.18, b: 0.22, metallic: 0.0, roughness: 0.75 });
      state.edges.push({ from: { node: flag, port: "mesh" }, to: { node: flagMat, port: "mesh" } });

      // WIND slider → Wind3D.strength
      const windS = makeNode("UISlider", 40, 560, {
        label: "WIND", min: 0, max: 18, value: 6, step: 0.5,
        x: 12, y: 12, width: 220, height: 30, corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: windS, port: "value" }, to: { node: wind, port: "strength" } });
      // STIFFNESS slider → Cloth3D.stiffness
      const stiffS = makeNode("UISlider", 40, 620, {
        label: "STIFFNESS", min: 0.1, max: 1, value: 0.85, step: 0.05,
        x: 12, y: 48, width: 220, height: 30, corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: stiffS, port: "value" }, to: { node: flag, port: "stiffness" } });

      // Camera + light + scene
      const cam = makeNode("FPCamera", 1100, 60, {
        posX: 5, posY: 5, posZ: 13, pitch: -6, yaw: 198, fov: 62, near: 0.1, far: 200, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 1100, 140, { dirX: -0.4, dirY: -0.7, dirZ: -0.6, intensity: 1.3 });
      const scene = makeNode("Scene3D", 1300, 60, { clearR: 0.45, clearG: 0.6, clearB: 0.8 });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: poleT, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: flagMat, port: "mesh" }, to: { node: scene, port: "mesh3" } });
      const vo = makeNode("VisualOutput", 1500, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUD
      const hudHelp = makeNode("HUDText", 1300, 200, {
        text: "Cloth3D PBD flag pinned along its left edge to the pole. Wind3D (+Z) + per-particle turbulence flutter it. Drag WIND for gusts; STIFFNESS for floppy↔taut.",
        value: NaN, corner: "bottom-left", fontSize: 11, color: "#fff", opacity: 0.72, margin: 18
      });
      state.edges.push({ from: { node: hudHelp, port: "hud" }, to: { node: scene, port: "hud1" } });
    }
  },

  /* Phase 8.B.13 -- Jelly Drop. A SoftBody3D cube drops onto the
   * ground and wobbles. STIFFNESS + VOLUME sliders shape the bounce;
   * RESET drops it again. */
  {
    id: "jelly-drop-3d",
    name: "Jelly Drop",
    sub: "SoftBody3D · PBD lattice · squash + bounce",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="5" y="36" width="90" height="3" fill="rgba(100,100,100,0.6)"/>
      <path d="M 32 36 Q 30 22 40 18 Q 50 14 60 18 Q 70 22 68 36 Z" fill="rgba(110,210,150,0.85)" stroke="rgba(170,255,200,0.9)" stroke-width="0.8"/>
      <ellipse cx="44" cy="23" rx="5" ry="3" fill="rgba(200,255,220,0.5)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 4
      });

      // Ground (visual box; top at y=0 = the soft body's groundY)
      const groundBox = makeNode("Box", 440, 160, { width: 24, height: 1, depth: 24 });
      const groundMat = makeNode("PhysicalMat", 620, 160, { r: 0.3, g: 0.32, b: 0.3, metallic: 0, roughness: 0.9 });
      const groundT = makeNode("Translate", 800, 160, { x: 0, y: -0.5, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundMat, port: "mesh" } });
      state.edges.push({ from: { node: groundMat, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Jelly cube: dropped from y=6, bounces on groundY=0
      const jelly = makeNode("SoftBody3D", 280, 320, {
        originX: 0, originY: 6, originZ: 0,
        size: 2.6, res: 5,
        stiffness: 0.55, volumePreserve: 0.6, bounce: 0.5,
        gravity: -9.8, groundY: 0,
        r: 0.45, g: 0.85, b: 0.6
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: jelly, port: "world" } });
      const jellyMat = makeNode("PhysicalMat", 520, 320, { r: 0.45, g: 0.85, b: 0.6, metallic: 0.1, roughness: 0.35 });
      state.edges.push({ from: { node: jelly, port: "mesh" }, to: { node: jellyMat, port: "mesh" } });

      // STIFFNESS + VOLUME sliders
      const stiffS = makeNode("UISlider", 40, 500, {
        label: "STIFFNESS", min: 0.1, max: 1, value: 0.55, step: 0.05,
        x: 12, y: 12, width: 220, height: 30, corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: stiffS, port: "value" }, to: { node: jelly, port: "stiffness" } });
      const volS = makeNode("UISlider", 40, 560, {
        label: "VOLUME", min: 0, max: 1, value: 0.6, step: 0.05,
        x: 12, y: 48, width: 220, height: 30, corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: volS, port: "value" }, to: { node: jelly, port: "volumePreserve" } });
      const bounceS = makeNode("UISlider", 40, 620, {
        label: "BOUNCE", min: 0, max: 0.9, value: 0.45, step: 0.05,
        x: 12, y: 84, width: 220, height: 30, corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: bounceS, port: "value" }, to: { node: jelly, port: "bounce" } });

      // RESET button → re-drop the jelly
      const resetBtn = makeNode("UIButton", 40, 690, {
        label: "↺  DROP AGAIN",
        x: 12, y: 12, width: 160, height: 38,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 14, opacity: 0.92, corner: "bottom-right"
      });
      state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: jelly, port: "reset" } });

      // Camera + light + scene
      const cam = makeNode("FPCamera", 1100, 60, {
        posX: 0, posY: 4, posZ: 11, pitch: -12, yaw: 180, fov: 60, near: 0.1, far: 200, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 1100, 140, { dirX: -0.4, dirY: -1, dirZ: -0.5, intensity: 1.3 });
      const scene = makeNode("Scene3D", 1300, 60, { clearR: 0.16, clearG: 0.2, clearB: 0.28 });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: jellyMat, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      const vo = makeNode("VisualOutput", 1500, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUD
      const hudHelp = makeNode("HUDText", 1300, 200, {
        text: "SoftBody3D PBD jelly: a res⁴ particle lattice held by distance constraints. STIFFNESS = overall springiness, VOLUME = shape retention (low = squashes flat, high = bouncy cube), BOUNCE = floor restitution. DROP AGAIN to reset.",
        value: NaN, corner: "bottom-left", fontSize: 11, color: "#fff", opacity: 0.72, margin: 18
      });
      state.edges.push({ from: { node: hudHelp, port: "hud" }, to: { node: scene, port: "hud1" } });
    }
  },

  /* Phase 8.B.14 -- Time Scrub. Bodies drop + settle while a
   * PhysicsRecord captures ~5s. A single SCRUB slider (1 = live,
   * drag left = rewind) replays the recording frame-by-frame. */
  {
    id: "time-scrub-3d",
    name: "Time Scrub",
    sub: "PhysicsRecord + PhysicsReplay · rewind physics",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="10" y="34" width="80" height="3" rx="1" fill="rgba(120,140,180,0.7)"/>
      <circle cx="30" cy="34" r="3.5" fill="rgba(120,170,255,0.95)"/>
      <rect x="50" y="29" width="7" height="7" rx="1" fill="rgba(220,140,90,0.9)" transform="rotate(20 53 32)"/>
      <circle cx="70" cy="34" r="3" fill="rgba(150,220,160,0.9)"/>
      <path d="M 22 12 A 10 10 0 1 1 22 22" fill="none" stroke="rgba(252,239,180,0.9)" stroke-width="1.5"/>
      <path d="M 22 22 L 19 18 L 25 18 Z" fill="rgba(252,239,180,0.9)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 4
      });

      // Ground
      const ground = makeNode("RigidBody3D", 40, 160, { type: "static", initX: 0, initY: 0, initZ: 0 });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 240, 160, { halfX: 12, halfY: 0.5, halfZ: 12, friction: 0.7 });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      const groundBox = makeNode("Box", 440, 160, { width: 24, height: 1, depth: 24 });
      const groundMat = makeNode("PhysicalMat", 620, 160, { r: 0.3, g: 0.32, b: 0.3, metallic: 0, roughness: 0.9 });
      const groundT = makeNode("Translate", 800, 160, { x: 0, y: 0, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundMat, port: "mesh" } });
      state.edges.push({ from: { node: groundMat, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // 6 dynamic bodies (boxes + spheres) dropping from staggered heights
      const drops = [
        { shape: "box",    x: -3, y: 8,  z: 0,  vx: 1,  c: { r: 0.85, g: 0.45, b: 0.3 } },
        { shape: "sphere", x: -1, y: 10, z: 1,  vx: -1, c: { r: 0.45, g: 0.75, b: 0.55 } },
        { shape: "box",    x: 1,  y: 9,  z: -1, vx: 0,  c: { r: 0.5, g: 0.6, b: 0.9 } },
        { shape: "sphere", x: 3,  y: 11, z: 0,  vx: -2, c: { r: 0.85, g: 0.7, b: 0.35 } },
        { shape: "box",    x: 0,  y: 7,  z: 2,  vx: 0.5,c: { r: 0.7, g: 0.45, b: 0.8 } },
        { shape: "sphere", x: -2, y: 12, z: -2, vx: 1.5,c: { r: 0.4, g: 0.8, b: 0.85 } }
      ];
      const bodies = [], meshSlots = [];
      for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        const row = 300 + i * 70;
        const tb = makeNode("RigidBody3D", 40, row, {
          type: "dynamic", initX: d.x, initY: d.y, initZ: d.z,
          initVx: d.vx, initVy: 0, initVz: 0
        });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: tb, port: "world" } });
        let coll, mesh;
        if (d.shape === "box") {
          coll = makeNode("BoxCollider3D", 200, row, { halfX: 0.7, halfY: 0.7, halfZ: 0.7, density: 1, friction: 0.5, restitution: 0.35 });
          mesh = makeNode("Box", 360, row, { width: 1.4, height: 1.4, depth: 1.4 });
        } else {
          coll = makeNode("SphereCollider3D", 200, row, { radius: 0.7, density: 1, friction: 0.4, restitution: 0.5 });
          mesh = makeNode("Sphere", 360, row, { radius: 0.7, stacks: 14, slices: 20 });
        }
        state.edges.push({ from: { node: tb, port: "bodyId" }, to: { node: coll, port: "body" } });
        const mat = makeNode("PhysicalMat", 540, row, { r: d.c.r, g: d.c.g, b: d.c.b, metallic: 0.1, roughness: 0.5 });
        const t = makeNode("Translate", 720, row);
        state.edges.push({ from: { node: mesh, port: "mesh" }, to: { node: mat, port: "mesh" } });
        state.edges.push({ from: { node: mat, port: "mesh" }, to: { node: t, port: "mesh" } });
        state.edges.push({ from: { node: tb, port: "x" }, to: { node: t, port: "x" } });
        state.edges.push({ from: { node: tb, port: "y" }, to: { node: t, port: "y" } });
        state.edges.push({ from: { node: tb, port: "z" }, to: { node: t, port: "z" } });
        state.edges.push({ from: { node: tb, port: "rotX" }, to: { node: t, port: "rotX" } });
        state.edges.push({ from: { node: tb, port: "rotY" }, to: { node: t, port: "rotY" } });
        state.edges.push({ from: { node: tb, port: "rotZ" }, to: { node: t, port: "rotZ" } });
        bodies.push(tb); meshSlots.push(t);
      }

      // Record + replay
      const rec = makeNode("PhysicsRecord", 280, 760, { record: 1, maxFrames: 300 });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: rec, port: "world" } });
      const replay = makeNode("PhysicsReplay", 520, 760, { frame: 1, enabled: 1 });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: replay, port: "world" } });
      state.edges.push({ from: { node: rec, port: "recording" }, to: { node: replay, port: "recording" } });

      // SCRUB slider (1 = live, drag left = rewind)
      const scrub = makeNode("UISlider", 40, 900, {
        label: "TIME", min: 0, max: 1, value: 1, step: 0.005,
        x: 12, y: 12, width: 280, height: 32, corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: scrub, port: "value" }, to: { node: replay, port: "frame" } });

      // RESET button: clear recording + re-drop
      const resetBtn = makeNode("UIButton", 40, 960, {
        label: "↺  RE-RECORD",
        x: 12, y: 12, width: 160, height: 38,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 14, opacity: 0.92, corner: "bottom-right"
      });
      state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: rec, port: "reset" } });
      for (const b of bodies) state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: b, port: "reset" } });

      // Camera + light + scene
      const cam = makeNode("FPCamera", 1100, 60, {
        posX: 0, posY: 6, posZ: 16, pitch: -14, yaw: 180, fov: 60, near: 0.1, far: 200, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 1100, 140, { dirX: -0.4, dirY: -1, dirZ: -0.5, intensity: 1.3 });
      const scene = makeNode("Scene3D", 1300, 60, { clearR: 0.13, clearG: 0.16, clearB: 0.22 });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      for (let i = 0; i < meshSlots.length && i + 2 <= 8; i++) {
        state.edges.push({ from: { node: meshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 2) } });
      }
      const vo = makeNode("VisualOutput", 1500, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUDs: frame count + scrub frame index
      const hudFrames = makeNode("HUDText", 1300, 200, {
        prefix: "recorded ", suffix: " frames", value: 0, decimals: 0,
        corner: "top-left", fontSize: 14, color: "#9bd0ff", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: { node: rec, port: "frameCount" }, to: { node: hudFrames, port: "value" } });
      state.edges.push({ from: { node: hudFrames, port: "hud" }, to: { node: scene, port: "hud1" } });
      const hudIdx = makeNode("HUDText", 1300, 280, {
        prefix: "scrub frame ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 13, color: "#ffcc66", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: replay, port: "frameIndex" }, to: { node: hudIdx, port: "value" } });
      state.edges.push({ from: { node: hudIdx, port: "hud" }, to: { node: scene, port: "hud2" } });
      const hudHelp = makeNode("HUDText", 1300, 360, {
        text: "PhysicsRecord captures ~5s of the drop. Drag TIME left to rewind: the world freezes and snaps to the recorded frame (right edge = live). RE-RECORD clears + drops again.",
        value: NaN, corner: "bottom-left", fontSize: 11, color: "#fff", opacity: 0.72, margin: 18
      });
      state.edges.push({ from: { node: hudHelp, port: "hud" }, to: { node: scene, port: "hud3" } });
    }
  },

  /* Phase 8.B.10 -- Gravity Well. A ForceField3D (attract) at the
   * origin pulls a ring of debris into orbit. World gravity is 0 so
   * the field is the only force. A STRENGTH slider tunes the pull. */
  {
    id: "gravity-well-3d",
    name: "Gravity Well",
    sub: "ForceField3D · orbiting debris · gravity off",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(8,10,20,0.95)"/>
      <circle cx="50" cy="22" r="6" fill="rgba(255,200,120,0.95)"/>
      <ellipse cx="50" cy="22" rx="34" ry="11" fill="none" stroke="rgba(120,170,255,0.55)" stroke-width="1"/>
      <ellipse cx="50" cy="22" rx="22" ry="7" fill="none" stroke="rgba(120,170,255,0.4)" stroke-width="0.8"/>
      <circle cx="84" cy="22" r="2.2" fill="rgba(200,120,90,0.95)"/>
      <circle cx="28" cy="25" r="1.8" fill="rgba(120,200,160,0.95)"/>
      <circle cx="60" cy="15" r="1.6" fill="rgba(180,160,240,0.95)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: 0, gravityZ: 0, subSteps: 4
      });

      // Central star: static sphere the debris can bounce off.
      const star = makeNode("RigidBody3D", 40, 180, { type: "static", initX: 0, initY: 0, initZ: 0 });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: star, port: "world" } });
      const starC = makeNode("SphereCollider3D", 220, 180, { radius: 1.5, restitution: 0.6, friction: 0.2 });
      state.edges.push({ from: { node: star, port: "bodyId" }, to: { node: starC, port: "body" } });
      const starMesh = makeNode("Sphere", 400, 180, { radius: 1.5, stacks: 20, slices: 28 });
      const starMat = makeNode("PhysicalMat", 560, 180, { r: 1.0, g: 0.8, b: 0.45, metallic: 0.2, roughness: 0.35 });
      const starT = makeNode("Translate", 720, 180, { x: 0, y: 0, z: 0 });
      state.edges.push({ from: { node: starMesh, port: "mesh" }, to: { node: starMat, port: "mesh" } });
      state.edges.push({ from: { node: starMat, port: "mesh" }, to: { node: starT, port: "mesh" } });

      // ForceField3D — attract everything toward the origin.
      const field = makeNode("ForceField3D", 40, 320, {
        x: 0, y: 0, z: 0, strength: 18, radius: 40, falloff: 1, mode: "attract"
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: field, port: "world" } });

      // Ring of debris with tangential initial velocities → orbits.
      const R = 9, SPD = 9;
      const debris = [];
      const dcols = [
        { r: 0.85, g: 0.4, b: 0.3 }, { r: 0.45, g: 0.75, b: 0.55 },
        { r: 0.5, g: 0.6, b: 0.9 }, { r: 0.85, g: 0.7, b: 0.35 },
        { r: 0.7, g: 0.45, b: 0.8 }, { r: 0.4, g: 0.8, b: 0.85 }
      ];
      const meshSlots = [];
      for (let i = 0; i < 6; i++) {
        const th = (i / 6) * Math.PI * 2;
        const px = R * Math.cos(th), pz = R * Math.sin(th);
        const py = (i % 2 === 0 ? 0.6 : -0.6);
        const vx = -Math.sin(th) * SPD, vz = Math.cos(th) * SPD;
        const rad = 0.4 + (i % 3) * 0.12;
        const db = makeNode("RigidBody3D", 40, 460 + i * 70, {
          type: "dynamic", initX: px, initY: py, initZ: pz,
          initVx: vx, initVy: 0, initVz: vz, linearDamping: 0
        });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: db, port: "world" } });
        const dc = makeNode("SphereCollider3D", 220, 460 + i * 70, { radius: rad, density: 1, restitution: 0.5, friction: 0.3 });
        state.edges.push({ from: { node: db, port: "bodyId" }, to: { node: dc, port: "body" } });
        const dm = makeNode("Sphere", 400, 460 + i * 70, { radius: rad, stacks: 12, slices: 18 });
        const c = dcols[i];
        const dmat = makeNode("PhysicalMat", 560, 460 + i * 70, { r: c.r, g: c.g, b: c.b, metallic: 0.3, roughness: 0.4 });
        const dt = makeNode("Translate", 720, 460 + i * 70);
        state.edges.push({ from: { node: dm, port: "mesh" }, to: { node: dmat, port: "mesh" } });
        state.edges.push({ from: { node: dmat, port: "mesh" }, to: { node: dt, port: "mesh" } });
        state.edges.push({ from: { node: db, port: "x" }, to: { node: dt, port: "x" } });
        state.edges.push({ from: { node: db, port: "y" }, to: { node: dt, port: "y" } });
        state.edges.push({ from: { node: db, port: "z" }, to: { node: dt, port: "z" } });
        debris.push(db);
        meshSlots.push(dt);
      }

      // STRENGTH slider
      const strS = makeNode("UISlider", 40, 900, {
        label: "STRENGTH", min: 0, max: 50, value: 18, step: 1,
        x: 12, y: 12, width: 220, height: 30, corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: strS, port: "value" }, to: { node: field, port: "strength" } });

      // RESET button — re-fling the debris into their starting orbits
      const resetBtn = makeNode("UIButton", 40, 960, {
        label: "↺  RESET",
        x: 12, y: 12, width: 120, height: 34,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92, corner: "bottom-right"
      });
      for (const db of debris) {
        state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: db, port: "reset" } });
      }

      // Camera (above, looking down at the orbital plane) + light + scene
      const cam = makeNode("FPCamera", 1100, 60, {
        posX: 0, posY: 17, posZ: 19, pitch: -38, yaw: 180, fov: 60, near: 0.1, far: 300, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 1100, 140, { dirX: -0.3, dirY: -1, dirZ: -0.4, intensity: 1.2 });
      const scene = makeNode("Scene3D", 1300, 60, { clearR: 0.03, clearG: 0.04, clearB: 0.08 });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: starT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      for (let i = 0; i < meshSlots.length && i + 2 <= 8; i++) {
        state.edges.push({ from: { node: meshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 2) } });
      }
      const vo = makeNode("VisualOutput", 1500, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUD: affected count + help
      const hudAff = makeNode("HUDText", 1300, 200, {
        prefix: "in field ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 15, color: "#9bd0ff", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: { node: field, port: "affected" }, to: { node: hudAff, port: "value" } });
      state.edges.push({ from: { node: hudAff, port: "hud" }, to: { node: scene, port: "hud1" } });
      const hudHelp = makeNode("HUDText", 1300, 280, {
        text: "ForceField3D (attract) pulls the debris toward the star · world gravity is OFF · drag STRENGTH: low = wide orbits, high = tight spirals + bounces off the star",
        value: NaN, corner: "bottom-left", fontSize: 11, color: "#cfe9ff", opacity: 0.7, margin: 18
      });
      state.edges.push({ from: { node: hudHelp, port: "hud" }, to: { node: scene, port: "hud2" } });
    }
  },

  /* Phase 8.B.6 -- 3D Physics Sandbox. Boxes + spheres drop onto
   * a ground plane + slope. Demonstrates all 3D collider shapes
   * (box, sphere, capsule) with restitution for bouncing. */
  {
    id: "physics-sandbox-3d",
    name: "3D Physics Sandbox",
    sub: "Rapier 3D · boxes + spheres + capsule · ground + slope",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="5" y="32" width="90" height="4" rx="1" fill="rgba(100,100,100,0.8)"/>
      <line x1="60" y1="32" x2="90" y2="22" stroke="rgba(100,100,100,0.8)" stroke-width="3"/>
      <rect x="15" y="12" width="7" height="7" rx="1" fill="rgba(80,160,220,0.85)" transform="rotate(10 18 15)"/>
      <rect x="35" y="18" width="7" height="7" rx="1" fill="rgba(220,120,80,0.85)"/>
      <circle cx="55" cy="14" r="4" fill="rgba(220,200,80,0.85)"/>
      <rect x="25" y="8" width="4" height="10" rx="2" fill="rgba(120,220,120,0.85)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 4
      });

      // Ground
      const ground = makeNode("RigidBody3D", 40, 180, {
        type: "static", initX: 0, initY: 0, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 280, 180, {
        halfX: 12, halfY: 0.5, halfZ: 12, friction: 0.7, restitution: 0.1
      });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      const groundBox = makeNode("Box", 520, 180, { width: 24, height: 1, depth: 24 });
      const groundT = makeNode("Translate", 700, 180, { x: 0, y: 0, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Seesaw: dynamic plank on a static pivot (RevoluteJoint2D
      // doesn't exist in 3D yet, so use a FixedJoint-free approach:
      // the plank is dynamic with a narrow pivot body below it)
      const pivot = makeNode("RigidBody3D", 40, 300, {
        type: "static", initX: 0, initY: 1.2, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: pivot, port: "world" } });
      const pivotC = makeNode("BoxCollider3D", 280, 300, {
        halfX: 0.3, halfY: 0.6, halfZ: 2, friction: 0.5
      });
      state.edges.push({ from: { node: pivot, port: "bodyId" }, to: { node: pivotC, port: "body" } });
      const plank = makeNode("RigidBody3D", 40, 380, {
        type: "dynamic", initX: 0, initY: 2, initZ: 0,
        angularDamping: 0.3
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: plank, port: "world" } });
      const plankC = makeNode("BoxCollider3D", 280, 380, {
        halfX: 5, halfY: 0.15, halfZ: 2, friction: 0.5, restitution: 0.1
      });
      state.edges.push({ from: { node: plank, port: "bodyId" }, to: { node: plankC, port: "body" } });
      const pivotBox = makeNode("Box", 520, 300, { width: 0.6, height: 1.2, depth: 4 });
      const pivotT = makeNode("Translate", 700, 300, { x: 0, y: 1.2, z: 0 });
      state.edges.push({ from: { node: pivotBox, port: "mesh" }, to: { node: pivotT, port: "mesh" } });
      const plankBox = makeNode("Box", 520, 380, { width: 10, height: 0.3, depth: 4 });
      const plankR = makeNode("Rotate", 700, 380);
      const plankT = makeNode("Translate", 880, 380);
      state.edges.push({ from: { node: plankBox, port: "mesh" }, to: { node: plankR, port: "mesh" } });
      state.edges.push({ from: { node: plank, port: "rotZ" }, to: { node: plankR, port: "angleZ" } });
      state.edges.push({ from: { node: plankR, port: "mesh" }, to: { node: plankT, port: "mesh" } });
      state.edges.push({ from: { node: plank, port: "x" }, to: { node: plankT, port: "x" } });
      state.edges.push({ from: { node: plank, port: "y" }, to: { node: plankT, port: "y" } });
      state.edges.push({ from: { node: plank, port: "z" }, to: { node: plankT, port: "z" } });

      // Dynamic objects: 3 boxes, 2 spheres, 1 capsule
      const dynBodies = [];
      const objects = [
        { type: "box",     x: -2, y: 6,  z: -1, halfX: 0.4, halfY: 0.4, halfZ: 0.4 },
        { type: "box",     x: 0,  y: 8,  z: 0,  halfX: 0.5, halfY: 0.3, halfZ: 0.5 },
        { type: "box",     x: 5,  y: 10, z: 1,  halfX: 0.35, halfY: 0.35, halfZ: 0.35 },
        { type: "sphere",  x: -3, y: 12, z: 2,  radius: 0.4 },
        { type: "sphere",  x: 1,  y: 14, z: -2, radius: 0.5 },
        { type: "capsule", x: 3,  y: 16, z: 0,  radius: 0.25, halfHeight: 0.4 }
      ];
      const meshSlots = [groundT, pivotT, plankT];
      for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        const b = makeNode("RigidBody3D", 40, 420 + i * 100, {
          type: "dynamic", initX: o.x, initY: o.y, initZ: o.z,
          linearDamping: 0.05, angularDamping: 0.1
        });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: b, port: "world" } });
        let c;
        if (o.type === "box") {
          c = makeNode("BoxCollider3D", 280, 420 + i * 100, {
            halfX: o.halfX, halfY: o.halfY, halfZ: o.halfZ,
            density: 1, friction: 0.5, restitution: 0.35
          });
        } else if (o.type === "capsule") {
          c = makeNode("CapsuleCollider3D", 280, 420 + i * 100, {
            radius: o.radius, halfHeight: o.halfHeight,
            density: 1, friction: 0.4, restitution: 0.3
          });
        } else {
          c = makeNode("SphereCollider3D", 280, 420 + i * 100, {
            radius: o.radius, density: 1, friction: 0.4, restitution: 0.5
          });
        }
        state.edges.push({ from: { node: b, port: "bodyId" }, to: { node: c, port: "body" } });
        let bx;
        if (o.type === "sphere") {
          bx = makeNode("Sphere", 520, 500 + i * 100, { radius: o.radius, stacks: 12, slices: 16 });
        } else if (o.type === "capsule") {
          bx = makeNode("Capsule", 520, 500 + i * 100, { radius: o.radius, halfHeight: o.halfHeight, slices: 10 });
        } else {
          bx = makeNode("Box", 520, 500 + i * 100, { width: o.halfX*2, height: o.halfY*2, depth: o.halfZ*2 });
        }
        const rot = makeNode("Rotate", 650, 500 + i * 100);
        const tr = makeNode("Translate", 800, 500 + i * 100);
        state.edges.push({ from: { node: bx, port: "mesh" }, to: { node: rot, port: "mesh" } });
        state.edges.push({ from: { node: b, port: "rotX" }, to: { node: rot, port: "angleX" } });
        state.edges.push({ from: { node: b, port: "rotY" }, to: { node: rot, port: "angleY" } });
        state.edges.push({ from: { node: b, port: "rotZ" }, to: { node: rot, port: "angleZ" } });
        state.edges.push({ from: { node: rot, port: "mesh" }, to: { node: tr, port: "mesh" } });
        state.edges.push({ from: { node: b, port: "x" }, to: { node: tr, port: "x" } });
        state.edges.push({ from: { node: b, port: "y" }, to: { node: tr, port: "y" } });
        state.edges.push({ from: { node: b, port: "z" }, to: { node: tr, port: "z" } });
        dynBodies.push(b);
        meshSlots.push(tr);
      }

      // Camera + Scene3D
      const cam = makeNode("FPCamera", 900, 60, {
        posX: 0, posY: 8, posZ: 16, pitch: -20, yaw: 180,
        fov: 60, near: 0.1, far: 200, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 900, 180, {
        dirX: -0.5, dirY: -1, dirZ: -0.3, intensity: 1.2
      });
      const scene = makeNode("Scene3D", 1100, 60, {
        clearR: 0.12, clearG: 0.14, clearB: 0.22
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      for (let i = 0; i < meshSlots.length && i < 8; i++) {
        state.edges.push({ from: { node: meshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 1) } });
      }
      const vo = makeNode("VisualOutput", 1300, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // UISlider: drop X position (wires into all bodies' initX)
      const dropX = makeNode("UISlider", 1100, 400, {
        label: "DROP X", min: -8, max: 8, value: 0, step: 0.5,
        x: 12, y: 60, width: 180, height: 28,
        corner: "bottom-left", opacity: 0.9
      });

      // HUD
      const hudBodies = makeNode("HUDText", 1100, 200, {
        prefix: "bodies ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 14, color: "#67c8ff", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: world, port: "bodyCount" }, to: { node: hudBodies, port: "value" } });
      state.edges.push({ from: { node: hudBodies, port: "hud" }, to: { node: scene, port: "hud1" } });

      // Restart
      const restartBtn = makeNode("UIButton", 1100, 300, {
        label: "↺  DROP AGAIN",
        x: 12, y: 12, width: 160, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      for (const b of dynBodies) {
        state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: b, port: "reset" } });
      }
    }
  },

  /* Sprint D.7 -- Cannon vs Wall. Fire a cannonball at a wall of
   * destructible boxes. Full UI: power + angle sliders, FIRE
   * button, fragment counter, reset. Hierarchical sub-fracture. */
  {
    id: "cannon-wall-3d",
    name: "3D Cannon vs Wall",
    sub: "Voronoi destruction · hierarchical · aim + fire",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="65" y="8" width="8" height="28" rx="1" fill="rgba(180,120,70,0.85)"/>
      <rect x="73" y="8" width="8" height="28" rx="1" fill="rgba(160,100,60,0.85)"/>
      <rect x="69" y="2" width="8" height="8" rx="1" fill="rgba(140,90,55,0.8)"/>
      <circle cx="20" cy="30" r="4" fill="rgba(80,80,90,0.9)"/>
      <line x1="24" y1="28" x2="40" y2="20" stroke="rgba(150,150,150,0.7)" stroke-width="2"/>
      <rect x="5" y="36" width="90" height="4" rx="1" fill="rgba(100,100,100,0.6)"/>
    </svg>`,
    build: () => {
      const tagStage = (id, name) => {
        const n = state.nodes.find(x => x && x.id === id);
        if (n) n.stage = name;
      };

      // ─── FSM + StageManager (intro -> playing -> won) ─────
      const fsm = makeNode("StateMachine", -240, 60, {
        states: "intro,playing,won",
        transitions: JSON.stringify([
          { from: 0, to: 1 },  // trans0: intro -> playing (LOAD)
          { from: 1, to: 2 },  // trans1: playing -> won (3 shots fired)
          { from: 2, to: 0 },  // trans2: won -> intro (PLAY AGAIN)
          { from: 1, to: 0 }   // trans3: playing -> intro (MENU)
        ]),
        initialState: 0
      });
      const mgr = makeNode("StageManager", -40, 60, {
        stages: "intro,playing,won",
        active: 0
      });
      state.edges.push({ from: { node: fsm, port: "current" }, to: { node: mgr, port: "active" } });

      // ─── Shot counter: 3 fires before round ends ──────────
      const shotCount = makeNode("EdgeCount", -240, 200, {
        max: 3, count: 0
      });
      tagStage(shotCount, "playing");

      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 10
      });
      tagStage(world, "playing");

      // Ground
      const ground = makeNode("RigidBody3D", 40, 160, {
        type: "static", initX: 0, initY: 0, initZ: 0
      });
      tagStage(ground, "playing");
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 280, 160, {
        halfX: 15, halfY: 0.5, halfZ: 10, friction: 0.7
      });
      tagStage(groundC, "playing");
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      const groundBox = makeNode("Box", 520, 160, { width: 30, height: 1, depth: 20 });
      tagStage(groundBox, "playing");
      const groundMat = makeNode("PhysicalMat", 700, 160, {
        r: 0.32, g: 0.3, b: 0.28, metallic: 0, roughness: 0.9
      });
      tagStage(groundMat, "playing");
      const groundT = makeNode("Translate", 880, 160, { x: 0, y: 0, z: 0 });
      tagStage(groundT, "playing");
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundMat, port: "mesh" } });
      state.edges.push({ from: { node: groundMat, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Wall: 3×2 grid of destructible boxes
      const wallBodies = [];
      const wallDests = [];
      const wallMeshSlots = [];
      const brickW = 2.5, brickH = 2, brickD = 2;
      const colors = [
        { r: 0.75, g: 0.42, b: 0.28 },
        { r: 0.7, g: 0.38, b: 0.25 },
        { r: 0.65, g: 0.35, b: 0.22 }
      ];
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const bx = (col - 1) * (brickW + 0.1);
          const by = 0.5 + brickH * 0.5 + row * (brickH + 0.05);
          const tb = makeNode("RigidBody3D", 40, 280 + (row*3+col) * 60, {
            type: "static", initX: 6 + bx, initY: by, initZ: 0
          });
          tagStage(tb, "playing");
          state.edges.push({ from: { node: world, port: "world" }, to: { node: tb, port: "world" } });
          const tc = makeNode("BoxCollider3D", 200, 280 + (row*3+col) * 60, {
            halfX: brickW*0.5, halfY: brickH*0.5, halfZ: brickD*0.5,
            density: 0.8, friction: 0.6, restitution: 0.05
          });
          tagStage(tc, "playing");
          state.edges.push({ from: { node: tb, port: "bodyId" }, to: { node: tc, port: "body" } });
          // Source mesh + fracture + destructible
          const sb = makeNode("Box", 360, 280 + (row*3+col) * 60, {
            width: brickW, height: brickH, depth: brickD
          });
          tagStage(sb, "playing");
          const fr = makeNode("FractureMesh", 520, 280 + (row*3+col) * 60, {
            fragments: 9, seed: 42 + row * 3 + col,
            interiorR: 0.45, interiorG: 0.32, interiorB: 0.22
          });
          tagStage(fr, "playing");
          state.edges.push({ from: { node: sb, port: "mesh" }, to: { node: fr, port: "mesh" } });
          // maxDepth: 1 disables sub-fracture (sub-Voronoi of a small
          // Voronoi cell produces near-degenerate hulls that Rapier
          // panics on). For showcasing sub-fracture, see "3D Destruction".
          const db = makeNode("DestructibleBody3D", 680, 280 + (row*3+col) * 60, {
            damageThreshold: 200, fragmentLifetime: 12, radialImpulse: 2.5,
            maxDepth: 1, subFragments: 0
          });
          tagStage(db, "playing");
          state.edges.push({ from: { node: world, port: "world" }, to: { node: db, port: "world" } });
          state.edges.push({ from: { node: tb, port: "bodyId" }, to: { node: db, port: "body" } });
          state.edges.push({ from: { node: sb, port: "mesh" }, to: { node: db, port: "mesh" } });
          state.edges.push({ from: { node: fr, port: "mesh" }, to: { node: db, port: "fracture" } });
          const cl = colors[(row + col) % 3];
          const dm = makeNode("PhysicalMat", 840, 280 + (row*3+col) * 60, {
            r: cl.r, g: cl.g, b: cl.b, metallic: 0, roughness: 0.75
          });
          tagStage(dm, "playing");
          state.edges.push({ from: { node: db, port: "mesh" }, to: { node: dm, port: "mesh" } });
          wallBodies.push(tb);
          wallDests.push(db);
          wallMeshSlots.push(dm);
        }
      }

      // Cannonball: launched with initVx from sliders
      const ball = makeNode("RigidBody3D", 40, 700, {
        type: "dynamic", initX: -8, initY: 2, initZ: 0,
        initVx: 12, initVy: 4, ccd: 1
      });
      tagStage(ball, "playing");
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ball, port: "world" } });
      const ballC = makeNode("SphereCollider3D", 200, 700, {
        radius: 0.5, density: 15, friction: 0.3, restitution: 0.2
      });
      tagStage(ballC, "playing");
      state.edges.push({ from: { node: ball, port: "bodyId" }, to: { node: ballC, port: "body" } });
      const ballMesh = makeNode("Sphere", 360, 700, { radius: 0.5, stacks: 14, slices: 20 });
      tagStage(ballMesh, "playing");
      const ballMat = makeNode("PhysicalMat", 520, 700, {
        r: 0.25, g: 0.25, b: 0.28, metallic: 0.95, roughness: 0.15
      });
      tagStage(ballMat, "playing");
      const ballT = makeNode("Translate", 680, 700);
      tagStage(ballT, "playing");
      state.edges.push({ from: { node: ballMesh, port: "mesh" }, to: { node: ballMat, port: "mesh" } });
      state.edges.push({ from: { node: ballMat, port: "mesh" }, to: { node: ballT, port: "mesh" } });
      state.edges.push({ from: { node: ball, port: "x" }, to: { node: ballT, port: "x" } });
      state.edges.push({ from: { node: ball, port: "y" }, to: { node: ballT, port: "y" } });
      state.edges.push({ from: { node: ball, port: "z" }, to: { node: ballT, port: "z" } });

      // UISliders: power + angle. Max power capped at 18 — above
      // that the cannonball tunnels through static brick colliders
      // even with CCD on (Rapier's CCD vs static is best-effort).
      const powerSlider = makeNode("UISlider", 40, 840, {
        label: "POWER", min: 6, max: 18, value: 12, step: 0.5,
        x: 12, y: 100, width: 180, height: 28,
        corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: powerSlider, port: "value" }, to: { node: ball, port: "initVx" } });
      const angleSlider = makeNode("UISlider", 40, 900, {
        label: "ANGLE", min: 0, max: 8, value: 4, step: 0.5,
        x: 12, y: 136, width: 180, height: 28,
        corner: "bottom-left", opacity: 0.92
      });
      state.edges.push({ from: { node: angleSlider, port: "value" }, to: { node: ball, port: "initVy" } });

      // FIRE button
      const fireBtn = makeNode("UIButton", 40, 960, {
        label: "FIRE",
        x: 12, y: 12, width: 140, height: 44,
        color: "#6a2a1a", hoverColor: "#a04020",
        textColor: "#ffcc88", borderColor: "#ff8844", borderWidth: 2,
        borderRadius: 6, fontSize: 18, opacity: 0.95,
        corner: "bottom-left"
      });
      state.edges.push({ from: { node: fireBtn, port: "clicked" }, to: { node: ball, port: "reset" } });
      state.edges.push({ from: { node: fireBtn, port: "clicked" }, to: { node: shotCount, port: "trigger" } });
      // When shotCount.limitHit latches (3 shots fired), transition to "won"
      state.edges.push({ from: { node: shotCount, port: "limitHit" }, to: { node: fsm, port: "trans1" } });

      // RESET ALL button
      const resetBtn = makeNode("UIButton", 1100, 300, {
        label: "↺  RESET ALL",
        x: 12, y: 12, width: 160, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: ball, port: "reset" } });
      state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: shotCount, port: "reset" } });
      for (const db of wallDests) {
        state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: db, port: "reset" } });
      }
      for (const tb of wallBodies) {
        state.edges.push({ from: { node: resetBtn, port: "clicked" }, to: { node: tb, port: "reset" } });
      }

      // ─── Playing Scene3D (camera, light, scene meshes) ────
      const cam = makeNode("FPCamera", 1100, 60, {
        posX: -4, posY: 4, posZ: 10, pitch: -10, yaw: 210,
        fov: 60, near: 0.1, far: 200, walkMode: 0
      });
      tagStage(cam, "playing");
      const light = makeNode("DirectionalLight", 1100, 140, {
        dirX: -0.4, dirY: -1, dirZ: -0.5, intensity: 1.3
      });
      tagStage(light, "playing");
      const scenePlay = makeNode("Scene3D", 1300, 60, {
        clearR: 0.5, clearG: 0.65, clearB: 0.82
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scenePlay, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scenePlay, port: "light1" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scenePlay, port: "mesh1" } });
      state.edges.push({ from: { node: ballT, port: "mesh" }, to: { node: scenePlay, port: "mesh2" } });
      for (let i = 0; i < wallMeshSlots.length && i + 3 <= 8; i++) {
        state.edges.push({ from: { node: wallMeshSlots[i], port: "mesh" }, to: { node: scenePlay, port: "mesh" + (i + 3) } });
      }

      // ─── Intro Scene3D (dark backdrop for the title screen) ─
      const sceneIntro = makeNode("Scene3D", 1300, 460, {
        clearR: 0.06, clearG: 0.08, clearB: 0.14
      });

      // Route scenes through StageManager
      state.edges.push({ from: { node: sceneIntro, port: "out" }, to: { node: mgr, port: "in0" } });
      state.edges.push({ from: { node: scenePlay,  port: "out" }, to: { node: mgr, port: "in1" } });
      const vo = makeNode("VisualOutput", 1500, 60, { display: 0 });
      state.edges.push({ from: { node: mgr, port: "out" }, to: { node: vo, port: "in" } });

      // ─── Intro UI (visibility via show wire) ──────────────
      const introPanel = makeNode("UIPanel", 1500, 460, {
        x: 0, y: -40, width: 480, height: 280,
        color: "#0a1018", borderColor: "#ff8844", borderWidth: 2,
        borderRadius: 12, opacity: 0.94, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introPanel, port: "show" } });
      const introTitle = makeNode("UIText", 1500, 540, {
        text: "CANNON vs WALL", x: 0, y: -110, fontSize: 30, width: 440,
        color: "#ffcc88", align: "center", opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introTitle, port: "show" } });
      const introSub = makeNode("UIText", 1500, 600, {
        text: "Voronoi destruction · hierarchical sub-fracture",
        x: 0, y: -56, fontSize: 12, width: 440,
        color: "#ff8844", align: "center", opacity: 0.7, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introSub, port: "show" } });
      const introHelp = makeNode("UIText", 1500, 660, {
        text: "POWER + ANGLE sliders aim · FIRE launches · bricks shatter on impact",
        x: 0, y: -16, fontSize: 11, width: 440,
        color: "#cfe9ff", align: "center", opacity: 0.6, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: introHelp, port: "show" } });
      const startBtn = makeNode("UIButton", 1500, 720, {
        label: "▶  LOAD CANNON",
        x: 0, y: 40, width: 220, height: 54,
        color: "#6a2a1a", hoverColor: "#a04020",
        textColor: "#ffcc88", borderColor: "#ff8844", borderWidth: 1.5,
        borderRadius: 8, fontSize: 17, opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: startBtn, port: "show" } });
      state.edges.push({ from: { node: startBtn, port: "clicked" }, to: { node: fsm, port: "trans0" } });

      // Show in-game UI only during 'playing'
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: powerSlider, port: "show" } });
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: angleSlider, port: "show" } });
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: fireBtn, port: "show" } });
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: resetBtn, port: "show" } });

      // ─── BACK TO MENU button (only visible while playing) ──
      const menuBtn = makeNode("UIButton", 1500, 800, {
        label: "← MENU",
        x: 12, y: 56, width: 100, height: 30,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1,
        borderRadius: 4, fontSize: 12, opacity: 0.9,
        corner: "bottom-right"
      });
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: menuBtn, port: "show" } });
      // trans3: playing -> intro (early-out via MENU button)
      state.edges.push({ from: { node: menuBtn, port: "clicked" }, to: { node: fsm, port: "trans3" } });
      // Returning to menu resets everything (including shot counter)
      state.edges.push({ from: { node: menuBtn, port: "clicked" }, to: { node: ball, port: "reset" } });
      state.edges.push({ from: { node: menuBtn, port: "clicked" }, to: { node: shotCount, port: "reset" } });
      for (const db of wallDests) {
        state.edges.push({ from: { node: menuBtn, port: "clicked" }, to: { node: db, port: "reset" } });
      }
      for (const tb of wallBodies) {
        state.edges.push({ from: { node: menuBtn, port: "clicked" }, to: { node: tb, port: "reset" } });
      }

      // ─── OnAwake[stage="playing"] -> auto-reset on entry ──
      const playAwake = makeNode("OnAwake", 1500, 880);
      tagStage(playAwake, "playing");
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: ball, port: "reset" } });
      state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: shotCount, port: "reset" } });
      for (const db of wallDests) {
        state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: db, port: "reset" } });
      }
      for (const tb of wallBodies) {
        state.edges.push({ from: { node: playAwake, port: "trigger" }, to: { node: tb, port: "reset" } });
      }

      // ─── Won stage: scene + UI (PLAY AGAIN button) ────────
      const sceneWon = makeNode("Scene3D", 1300, 600, {
        clearR: 0.18, clearG: 0.10, clearB: 0.06
      });
      state.edges.push({ from: { node: sceneWon, port: "out" }, to: { node: mgr, port: "in2" } });

      const wonPanel = makeNode("UIPanel", 1700, 60, {
        x: 0, y: -40, width: 440, height: 260,
        color: "#2a1a08", borderColor: "#f5c878", borderWidth: 2,
        borderRadius: 12, opacity: 0.94, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: wonPanel, port: "show" } });
      const wonTitle = makeNode("UIText", 1700, 140, {
        text: "ROUND OVER", x: 0, y: -100, fontSize: 34, width: 420,
        color: "#fcefb4", align: "center", opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: wonTitle, port: "show" } });
      const wonSub = makeNode("UIText", 1700, 200, {
        text: "3 cannonballs fired · inspect the destruction",
        x: 0, y: -50, fontSize: 13, width: 420,
        color: "#f5c878", align: "center", opacity: 0.7, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: wonSub, port: "show" } });
      const againBtn = makeNode("UIButton", 1700, 260, {
        label: "↺  PLAY AGAIN",
        x: 0, y: 40, width: 220, height: 52,
        color: "#5a3a1c", hoverColor: "#8a5e30",
        textColor: "#fcefb4", borderColor: "#f5c878", borderWidth: 1.5,
        borderRadius: 8, fontSize: 16, opacity: 0.95, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: againBtn, port: "show" } });
      // trans2: won -> intro
      state.edges.push({ from: { node: againBtn, port: "clicked" }, to: { node: fsm, port: "trans2" } });

      // ─── Shots-remaining HUD (playing only) ───────────────
      const hudShots = makeNode("HUDText", 1300, 280, {
        prefix: "shots left ", value: 3, decimals: 0,
        corner: "top-left", fontSize: 16, color: "#ff8844", opacity: 0.95, margin: 18
      });
      tagStage(hudShots, "playing");
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: hudShots, port: "show" } });
      state.edges.push({ from: { node: shotCount, port: "remaining" }, to: { node: hudShots, port: "value" } });
      state.edges.push({ from: { node: hudShots, port: "hud" }, to: { node: scenePlay, port: "hud2" } });

      // ─── Score = total fragments across all destructibles ──
      // Chain Adds: ((((d0 + d1) + d2) + d3) + d4) + d5
      let scoreSrc = { node: wallDests[0], port: "fragmentCount" };
      for (let i = 1; i < wallDests.length; i++) {
        const addN = makeNode("Add", -500, 800 + i * 60, {});
        tagStage(addN, "playing");
        state.edges.push({ from: scoreSrc, to: { node: addN, port: "a" } });
        state.edges.push({ from: { node: wallDests[i], port: "fragmentCount" }, to: { node: addN, port: "b" } });
        scoreSrc = { node: addN, port: "out" };
      }
      // scoreSrc now refers to the final sum

      // ─── HUDs (only on playing scene) ─────────────────────
      const hudFrags = makeNode("HUDText", 1300, 200, {
        prefix: "score ", value: 0, decimals: 0,
        corner: "top-right", fontSize: 16, color: "#ffcc44", opacity: 0.95, margin: 18
      });
      tagStage(hudFrags, "playing");
      state.edges.push({ from: { node: mgr, port: "active1" }, to: { node: hudFrags, port: "show" } });
      state.edges.push({ from: scoreSrc, to: { node: hudFrags, port: "value" } });
      state.edges.push({ from: { node: hudFrags, port: "hud" }, to: { node: scenePlay, port: "hud1" } });

      // ─── Leaderboard on intro screen (top scores) ─────────
      const board = makeNode("Leaderboard", 1500, 940, {
        x: 0, y: 200, width: 320, height: 240,
        title: "TOP SCORES",
        lsKey: "gamma-cannon-leaderboard-v1",
        maxEntries: 5,
        color: "#0a1018", borderColor: "#ff8844", borderWidth: 2,
        textColor: "#ffcc88", titleColor: "#ff8844",
        fontSize: 14, titleFontSize: 18, opacity: 0.94, corner: "center"
      });
      state.edges.push({ from: { node: mgr, port: "active0" }, to: { node: board, port: "show" } });
      // Submit happens when shotCount.limitHit latches (3 shots fired)
      state.edges.push({ from: scoreSrc, to: { node: board, port: "score" } });
      state.edges.push({ from: { node: shotCount, port: "limitHit" }, to: { node: board, port: "submit" } });

      // ─── Final score on the won screen ────────────────────
      const wonScore = makeNode("HUDText", 1700, 320, {
        prefix: "final score: ", value: 0, decimals: 0,
        corner: "center", fontSize: 22, color: "#fcefb4", opacity: 0.9, margin: 0
      });
      state.edges.push({ from: { node: mgr, port: "active2" }, to: { node: wonScore, port: "show" } });
      state.edges.push({ from: scoreSrc, to: { node: wonScore, port: "value" } });
      state.edges.push({ from: { node: wonScore, port: "hud" }, to: { node: sceneWon, port: "hud1" } });
    }
  },

  /* Sprint D.6 -- 3D Destruction demo. Drop a heavy sphere onto
   * a destructible box. Box shatters into Voronoi fragments. */
  {
    id: "destruction-3d",
    name: "3D Destruction",
    sub: "Voronoi fracture · impact threshold · fragment scatter",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="30" y="22" width="14" height="14" rx="1" fill="rgba(180,140,80,0.85)" transform="rotate(5 37 29)"/>
      <polygon points="37,22 44,18 50,25 44,29" fill="rgba(140,100,60,0.7)"/>
      <polygon points="30,29 28,36 37,36" fill="rgba(120,90,50,0.6)"/>
      <circle cx="50" cy="10" r="5" fill="rgba(220,80,80,0.85)"/>
      <rect x="10" y="36" width="80" height="4" rx="1" fill="rgba(100,100,100,0.6)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 8
      });

      // Ground
      const ground = makeNode("RigidBody3D", 40, 180, {
        type: "static", initX: 0, initY: 0, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 280, 180, {
        halfX: 10, halfY: 0.5, halfZ: 10, friction: 0.6
      });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      // Ground visual: dark concrete PhysicalMat
      const groundBox = makeNode("Box", 520, 180, { width: 20, height: 1, depth: 20 });
      const groundMat = makeNode("PhysicalMat", 700, 180, {
        r: 0.35, g: 0.33, b: 0.3, metallic: 0, roughness: 0.85
      });
      const groundT = makeNode("Translate", 880, 180, { x: 0, y: 0, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundMat, port: "mesh" } });
      state.edges.push({ from: { node: groundMat, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Destructible box: warm terracotta/brick color
      const targetBody = makeNode("RigidBody3D", 40, 340, {
        type: "static", initX: 0, initY: 2.5, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: targetBody, port: "world" } });
      const targetColl = makeNode("BoxCollider3D", 280, 340, {
        halfX: 2, halfY: 2, halfZ: 2, density: 1, friction: 0.5, restitution: 0.1
      });
      state.edges.push({ from: { node: targetBody, port: "bodyId" }, to: { node: targetColl, port: "body" } });

      const srcBox = makeNode("Box", 40, 460, { width: 4, height: 4, depth: 4 });
      const fracture = makeNode("FractureMesh", 280, 460, {
        fragments: 25, seed: 42,
        interiorR: 0.45, interiorG: 0.3, interiorB: 0.2
      });
      state.edges.push({ from: { node: srcBox, port: "mesh" }, to: { node: fracture, port: "mesh" } });
      const destBody = makeNode("DestructibleBody3D", 520, 400, {
        damageThreshold: 300, fragmentLifetime: 10, radialImpulse: 2,
        maxDepth: 2, subFragments: 4
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: destBody, port: "world" } });
      state.edges.push({ from: { node: targetBody, port: "bodyId" }, to: { node: destBody, port: "body" } });
      state.edges.push({ from: { node: srcBox, port: "mesh" }, to: { node: destBody, port: "mesh" } });
      state.edges.push({ from: { node: fracture, port: "mesh" }, to: { node: destBody, port: "fracture" } });
      // Material for the destructible box: terracotta brick
      const destMat = makeNode("PhysicalMat", 700, 400, {
        r: 0.75, g: 0.42, b: 0.28, metallic: 0, roughness: 0.7
      });

      // Heavy sphere: dark steel, CCD on to prevent tunneling
      const ball = makeNode("RigidBody3D", 40, 560, {
        type: "dynamic", initX: 0, initY: 10, initZ: 0, ccd: 1
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ball, port: "world" } });
      const ballC = makeNode("SphereCollider3D", 280, 560, {
        radius: 0.6, density: 10, friction: 0.4, restitution: 0.3
      });
      state.edges.push({ from: { node: ball, port: "bodyId" }, to: { node: ballC, port: "body" } });
      const ballMesh = makeNode("Sphere", 520, 560, { radius: 0.6, stacks: 16, slices: 24 });
      const ballMat = makeNode("PhysicalMat", 700, 560, {
        r: 0.5, g: 0.5, b: 0.55, metallic: 0.9, roughness: 0.25
      });
      const ballT = makeNode("Translate", 880, 560);
      state.edges.push({ from: { node: ballMesh, port: "mesh" }, to: { node: ballMat, port: "mesh" } });
      state.edges.push({ from: { node: ballMat, port: "mesh" }, to: { node: ballT, port: "mesh" } });
      state.edges.push({ from: { node: ball, port: "x" }, to: { node: ballT, port: "x" } });
      state.edges.push({ from: { node: ball, port: "y" }, to: { node: ballT, port: "y" } });
      state.edges.push({ from: { node: ball, port: "z" }, to: { node: ballT, port: "z" } });

      // Camera + Scene3D
      const cam = makeNode("FPCamera", 900, 60, {
        posX: 0, posY: 4, posZ: 8, pitch: -15, yaw: 180,
        fov: 60, near: 0.1, far: 200, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 900, 180, {
        dirX: -0.5, dirY: -1, dirZ: -0.3, intensity: 1.2
      });
      const scene = makeNode("Scene3D", 1100, 60, {
        clearR: 0.15, clearG: 0.18, clearB: 0.28
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      // Destructible box mesh → material → scene
      state.edges.push({ from: { node: destBody, port: "mesh" }, to: { node: destMat, port: "mesh" } });
      state.edges.push({ from: { node: destMat, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: ballT, port: "mesh" }, to: { node: scene, port: "mesh3" } });
      const vo = makeNode("VisualOutput", 1300, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUDs
      const hudDest = makeNode("HUDText", 1100, 200, {
        prefix: "destroyed ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 16, color: "#ff8844", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: { node: destBody, port: "destroyed" }, to: { node: hudDest, port: "value" } });
      state.edges.push({ from: { node: hudDest, port: "hud" }, to: { node: scene, port: "hud1" } });
      const hudFrags = makeNode("HUDText", 1100, 280, {
        prefix: "fragments ", value: 0, decimals: 0,
        corner: "top-left", fontSize: 14, color: "#ffcc44", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: destBody, port: "fragmentCount" }, to: { node: hudFrags, port: "value" } });
      state.edges.push({ from: { node: hudFrags, port: "hud" }, to: { node: scene, port: "hud2" } });

      // Reset
      const restartBtn = makeNode("UIButton", 1100, 360, {
        label: "↺  RESET",
        x: 12, y: 12, width: 120, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: destBody, port: "reset" } });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: ball, port: "reset" } });
    }
  },

  /* Sprint D.1 -- Contact Force demo. Drop a sphere onto a box,
   * HUD shows live contact force magnitude. */
  {
    id: "contact-force-3d",
    name: "3D Contact Force",
    sub: "Rapier 3D · impact force detection · HUD readout",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="25" y="28" width="50" height="8" rx="1" fill="rgba(100,100,100,0.8)"/>
      <circle cx="50" cy="14" r="6" fill="rgba(220,100,80,0.85)"/>
      <text x="50" y="42" font-family="ui-monospace" font-size="5" fill="rgba(255,200,100,0.8)" text-anchor="middle">F=123</text>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 8
      });

      // Ground
      const ground = makeNode("RigidBody3D", 40, 180, {
        type: "static", initX: 0, initY: 0, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 280, 180, {
        halfX: 8, halfY: 0.5, halfZ: 8, friction: 0.6, restitution: 0.1
      });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      const groundBox = makeNode("Box", 520, 180, { width: 16, height: 1, depth: 16 });
      const groundT = makeNode("Translate", 700, 180, { x: 0, y: 0, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Target box (static, receives impacts)
      const target = makeNode("RigidBody3D", 40, 320, {
        type: "static", initX: 0, initY: 1.5, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: target, port: "world" } });
      const targetC = makeNode("BoxCollider3D", 280, 320, {
        halfX: 1, halfY: 1, halfZ: 1, friction: 0.5, restitution: 0.3
      });
      state.edges.push({ from: { node: target, port: "bodyId" }, to: { node: targetC, port: "body" } });
      const targetBox = makeNode("Box", 520, 320, { width: 2, height: 2, depth: 2 });
      const targetT = makeNode("Translate", 700, 320, { x: 0, y: 1.5, z: 0 });
      state.edges.push({ from: { node: targetBox, port: "mesh" }, to: { node: targetT, port: "mesh" } });

      // Falling sphere
      const ball = makeNode("RigidBody3D", 40, 460, {
        type: "dynamic", initX: 0, initY: 8, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ball, port: "world" } });
      const ballC = makeNode("SphereCollider3D", 280, 460, {
        radius: 0.5, density: 5, friction: 0.4, restitution: 0.5
      });
      state.edges.push({ from: { node: ball, port: "bodyId" }, to: { node: ballC, port: "body" } });
      const ballMesh = makeNode("Sphere", 520, 460, { radius: 0.5, stacks: 12, slices: 16 });
      const ballT = makeNode("Translate", 700, 460);
      state.edges.push({ from: { node: ballMesh, port: "mesh" }, to: { node: ballT, port: "mesh" } });
      state.edges.push({ from: { node: ball, port: "x" }, to: { node: ballT, port: "x" } });
      state.edges.push({ from: { node: ball, port: "y" }, to: { node: ballT, port: "y" } });
      state.edges.push({ from: { node: ball, port: "z" }, to: { node: ballT, port: "z" } });

      // ContactForce3D: measures impact between ball and target
      const cf = makeNode("ContactForce3D", 40, 600, {});
      state.edges.push({ from: { node: world, port: "world" }, to: { node: cf, port: "world" } });
      state.edges.push({ from: { node: ball, port: "bodyId" }, to: { node: cf, port: "bodyA" } });
      state.edges.push({ from: { node: target, port: "bodyId" }, to: { node: cf, port: "bodyB" } });

      // Camera + Scene
      const cam = makeNode("FPCamera", 900, 60, {
        posX: 0, posY: 5, posZ: 8, pitch: -20, yaw: 180,
        fov: 60, near: 0.1, far: 200, walkMode: 0
      });
      const scene = makeNode("Scene3D", 1100, 60, { clearR: 0.15, clearG: 0.18, clearB: 0.28 });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: groundT, port: "mesh" }, to: { node: scene, port: "mesh1" } });
      state.edges.push({ from: { node: targetT, port: "mesh" }, to: { node: scene, port: "mesh2" } });
      state.edges.push({ from: { node: ballT, port: "mesh" }, to: { node: scene, port: "mesh3" } });
      const vo = makeNode("VisualOutput", 1300, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUDs
      const hudForce = makeNode("HUDText", 1100, 200, {
        prefix: "force ", value: 0, decimals: 1,
        corner: "top-left", fontSize: 18, color: "#ff8844", opacity: 0.95, margin: 18
      });
      state.edges.push({ from: { node: cf, port: "forceMagnitude" }, to: { node: hudForce, port: "value" } });
      state.edges.push({ from: { node: hudForce, port: "hud" }, to: { node: scene, port: "hud1" } });
      const hudMax = makeNode("HUDText", 1100, 280, {
        prefix: "peak ", value: 0, decimals: 1,
        corner: "top-left", fontSize: 14, color: "#ffcc44", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: cf, port: "maxForce" }, to: { node: hudMax, port: "value" } });
      state.edges.push({ from: { node: hudMax, port: "hud" }, to: { node: scene, port: "hud2" } });

      // Drop again
      const restartBtn = makeNode("UIButton", 1100, 360, {
        label: "↺  DROP",
        x: 12, y: 12, width: 120, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: ball, port: "reset" } });
    }
  },

  /* Phase 8.B.7 -- 3D Ragdoll. 7-body humanoid held together with
   * BallJoint3D. Drops onto a ground plane. PUSH button applies a
   * random impulse to the torso. */
  {
    id: "physics-ragdoll-3d",
    name: "3D Ragdoll",
    sub: "Rapier 3D · 7-body humanoid · BallJoint3D",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <circle cx="50" cy="8" r="4" fill="rgba(220,180,120,0.85)"/>
      <rect x="46" y="12" width="8" height="12" rx="1" fill="rgba(80,140,200,0.85)"/>
      <line x1="46" y1="14" x2="38" y2="22" stroke="rgba(220,180,120,0.8)" stroke-width="2"/>
      <line x1="54" y1="14" x2="62" y2="22" stroke="rgba(220,180,120,0.8)" stroke-width="2"/>
      <line x1="48" y1="24" x2="44" y2="36" stroke="rgba(80,100,160,0.8)" stroke-width="2"/>
      <line x1="52" y1="24" x2="56" y2="36" stroke="rgba(80,100,160,0.8)" stroke-width="2"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 10
      });

      // Ground
      const ground = makeNode("RigidBody3D", 40, 180, {
        type: "static", initX: 0, initY: 0, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 280, 180, {
        halfX: 10, halfY: 0.5, halfZ: 10, friction: 0.6, restitution: 0.1
      });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      const groundBox = makeNode("Box", 520, 180, { width: 20, height: 1, depth: 20 });
      const groundT = makeNode("Translate", 700, 180, { x: 0, y: 0, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Ragdoll parts: head, torso, L/R arms, L/R legs
      // Simple 6-part ragdoll standing on the ground. PUSH to topple.
      // 6 bodies: head, torso, armL, armR, legL, legR. All visible.
      // Feet start at y≈1 (ground at y=0.5). No falling — starts in place.
      const bps = {
        head: [0, 4.0],  torso: [0, 2.8],
        armL: [-0.7, 2.5], armR: [0.7, 2.5],
        legL: [-0.25, 1.3], legR: [0.25, 1.3]
      };
      const jws = {
        neck: [0, 3.5], shoulderL: [-0.5, 3.2], shoulderR: [0.5, 3.2],
        hipL: [-0.25, 2.0], hipR: [0.25, 2.0]
      };
      const defs = [
        { name: "head", shape: "sphere", radius: 0.35 },
        { name: "torso", shape: "box", halfX: 0.4, halfY: 0.7, halfZ: 0.25 },
        { name: "armL", shape: "capsule", radius: 0.1, halfHeight: 0.4 },
        { name: "armR", shape: "capsule", radius: 0.1, halfHeight: 0.4 },
        { name: "legL", shape: "capsule", radius: 0.12, halfHeight: 0.5 },
        { name: "legR", shape: "capsule", radius: 0.12, halfHeight: 0.5 }
      ];
      const bodies = {};
      const meshSlots = [groundT];
      for (const d of defs) {
        const p = bps[d.name];
        const b = makeNode("RigidBody3D", 40, 300 + meshSlots.length * 80, {
          type: "dynamic", initX: p[0], initY: p[1], initZ: 0,
          linearDamping: 1.0, angularDamping: 2.0
        });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: b, port: "world" } });
        let c;
        if (d.shape === "sphere") c = makeNode("SphereCollider3D", 280, 300 + meshSlots.length * 80, { radius: d.radius, density: 1, friction: 0.6 });
        else if (d.shape === "capsule") c = makeNode("CapsuleCollider3D", 280, 300 + meshSlots.length * 80, { radius: d.radius, halfHeight: d.halfHeight, density: 1, friction: 0.6 });
        else c = makeNode("BoxCollider3D", 280, 300 + meshSlots.length * 80, { halfX: d.halfX, halfY: d.halfY, halfZ: d.halfZ, density: 1, friction: 0.6 });
        state.edges.push({ from: { node: b, port: "bodyId" }, to: { node: c, port: "body" } });
        let mesh;
        if (d.shape === "sphere") mesh = makeNode("Sphere", 520, 300 + meshSlots.length * 80, { radius: d.radius, stacks: 10, slices: 14 });
        else if (d.shape === "capsule") mesh = makeNode("Capsule", 520, 300 + meshSlots.length * 80, { radius: d.radius, halfHeight: d.halfHeight, slices: 10 });
        else mesh = makeNode("Box", 520, 300 + meshSlots.length * 80, { width: d.halfX*2, height: d.halfY*2, depth: d.halfZ*2 });
        const rot = makeNode("Rotate", 650, 300 + meshSlots.length * 80);
        const tr = makeNode("Translate", 800, 300 + meshSlots.length * 80);
        state.edges.push({ from: { node: mesh, port: "mesh" }, to: { node: rot, port: "mesh" } });
        state.edges.push({ from: { node: b, port: "rotX" }, to: { node: rot, port: "angleX" } });
        state.edges.push({ from: { node: b, port: "rotY" }, to: { node: rot, port: "angleY" } });
        state.edges.push({ from: { node: b, port: "rotZ" }, to: { node: rot, port: "angleZ" } });
        state.edges.push({ from: { node: rot, port: "mesh" }, to: { node: tr, port: "mesh" } });
        state.edges.push({ from: { node: b, port: "x" }, to: { node: tr, port: "x" } });
        state.edges.push({ from: { node: b, port: "y" }, to: { node: tr, port: "y" } });
        state.edges.push({ from: { node: b, port: "z" }, to: { node: tr, port: "z" } });
        bodies[d.name] = b;
        meshSlots.push(tr);
      }

      // 5 ball joints. Anchors = jointWorld - bodyPos (exact match).
      const makeJ = (bA, bB, jwName) => {
        const aA = [jws[jwName][0] - bps[bA][0], jws[jwName][1] - bps[bA][1], 0];
        const aB = [jws[jwName][0] - bps[bB][0], jws[jwName][1] - bps[bB][1], 0];
        const j = makeNode("BallJoint3D", 40, 1000 + Object.keys(bodies).length * 20, {
          anchorAx: aA[0], anchorAy: aA[1], anchorAz: 0,
          anchorBx: aB[0], anchorBy: aB[1], anchorBz: 0
        });
        state.edges.push({ from: { node: bodies[bA], port: "bodyId" }, to: { node: j, port: "bodyA" } });
        state.edges.push({ from: { node: bodies[bB], port: "bodyId" }, to: { node: j, port: "bodyB" } });
      };
      makeJ("torso", "head", "neck");
      makeJ("torso", "armL", "shoulderL");
      makeJ("torso", "armR", "shoulderR");
      makeJ("torso", "legL", "hipL");
      makeJ("torso", "legR", "hipR");

      // Camera + Scene3D
      const cam = makeNode("FPCamera", 900, 60, {
        posX: 0, posY: 3, posZ: 6, pitch: -10, yaw: 180,
        fov: 60, near: 0.1, far: 200, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 900, 180, {
        dirX: -0.5, dirY: -1, dirZ: -0.3, intensity: 1.2
      });
      const scene = makeNode("Scene3D", 1100, 60, {
        clearR: 0.15, clearG: 0.18, clearB: 0.28
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      for (let i = 0; i < meshSlots.length && i < 8; i++) {
        state.edges.push({ from: { node: meshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 1) } });
      }
      const vo = makeNode("VisualOutput", 1300, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // PUSH button — applies random impulse to torso
      const pushBtn = makeNode("UIButton", 1100, 200, {
        label: "PUSH",
        x: 12, y: 12, width: 120, height: 40,
        color: "#5a2a1a", hoverColor: "#8a4020",
        textColor: "#ffcc88", borderColor: "#ff8844", borderWidth: 1.5,
        borderRadius: 6, fontSize: 16, opacity: 0.95,
        corner: "bottom-left"
      });
      state.edges.push({ from: { node: pushBtn, port: "clicked" }, to: { node: bodies.torso, port: "impulseX" } });

      // DROP AGAIN
      const restartBtn = makeNode("UIButton", 1100, 300, {
        label: "↺  DROP",
        x: 12, y: 12, width: 120, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      for (const name of Object.keys(bodies)) {
        state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: bodies[name], port: "reset" } });
      }
    }
  },

  /* Phase 8.0.3-b -- 3D Terrain Bouncer. Terrain + heightfield
   * collider + balls. Flat ground safety net verified working. */
  {
    id: "terrain-bouncer-3d",
    name: "3D Terrain Bouncer",
    sub: "Rapier 3D · terrain heightfield · falling balls",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="10" y="30" width="80" height="4" rx="1" fill="rgba(100,100,100,0.8)"/>
      <circle cx="50" cy="18" r="5" fill="rgba(220,180,80,0.85)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 4
      });

      // Terrain visual
      const terrain = makeNode("Terrain", 40, 200, {
        sizeMode: "custom", worldSize: 40, heightScale: 6,
        yOffset: 0, segments: 48,
        seed: 3.14, frequency: 1.5, octaves: 4,
        lacunarity: 2.0, gain: 0.5, ridges: 0.2
      });

      // TerrainCollider heightfield
      const tc = makeNode("TerrainCollider", 280, 200, {
        useTrimesh: 1, trimeshRes: 32, trimeshSize: 40
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: tc, port: "world3d" } });
      state.edges.push({ from: { node: terrain, port: "mesh" }, to: { node: tc, port: "terrain" } });

      // Flat ground safety net below terrain (verified working)
      const ground = makeNode("RigidBody3D", 40, 340, {
        type: "static", initX: 0, initY: -10, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 280, 340, {
        halfX: 30, halfY: 0.5, halfZ: 30, friction: 0.5
      });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });

      // 3 falling balls
      const balls = [];
      const bPos = [{ x: 0, y: 8, z: 0 }, { x: -4, y: 12, z: 3 }, { x: 5, y: 16, z: -2 }];
      const meshSlots = [terrain];
      for (let i = 0; i < bPos.length; i++) {
        const b = makeNode("RigidBody3D", 40, 460 + i * 120, {
          type: "dynamic", initX: bPos[i].x, initY: bPos[i].y, initZ: bPos[i].z,
          linearDamping: 0.1, angularDamping: 0.3
        });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: b, port: "world" } });
        const c = makeNode("SphereCollider3D", 280, 460 + i * 120, {
          radius: 0.5, density: 1, friction: 0.5, restitution: 0.5
        });
        state.edges.push({ from: { node: b, port: "bodyId" }, to: { node: c, port: "body" } });
        const bx = makeNode("Sphere", 520, 460 + i * 120, { radius: 0.5, stacks: 12, slices: 16 });
        const tr = makeNode("Translate", 700, 460 + i * 120);
        state.edges.push({ from: { node: bx, port: "mesh" }, to: { node: tr, port: "mesh" } });
        state.edges.push({ from: { node: b, port: "x" }, to: { node: tr, port: "x" } });
        state.edges.push({ from: { node: b, port: "y" }, to: { node: tr, port: "y" } });
        state.edges.push({ from: { node: b, port: "z" }, to: { node: tr, port: "z" } });
        balls.push(b);
        meshSlots.push(tr);
      }

      // Camera + Scene3D
      const cam = makeNode("FPCamera", 900, 60, {
        posX: 0, posY: 8, posZ: 25, pitch: -15, yaw: 180,
        fov: 60, near: 0.1, far: 300, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 900, 200, {
        dirX: -0.5, dirY: -1, dirZ: -0.3, intensity: 1.2
      });
      const scene = makeNode("Scene3D", 1100, 60, {
        clearR: 0.45, clearG: 0.65, clearB: 0.85
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      for (let i = 0; i < meshSlots.length && i < 8; i++) {
        state.edges.push({ from: { node: meshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 1) } });
      }
      const vo = makeNode("VisualOutput", 1300, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUD
      const hudY = makeNode("HUDText", 1100, 200, {
        prefix: "ball0.y ", value: 0, decimals: 2,
        corner: "top-left", fontSize: 14, color: "#ffcc44", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: balls[0], port: "y" }, to: { node: hudY, port: "value" } });
      state.edges.push({ from: { node: hudY, port: "hud" }, to: { node: scene, port: "hud1" } });

      // Restart
      const restartBtn = makeNode("UIButton", 1100, 300, {
        label: "↺  DROP AGAIN",
        x: 12, y: 12, width: 160, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      for (const b of balls) {
        state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: b, port: "reset" } });
      }
    }
  },

  /* Phase 8.0.3-c -- Splash Test. Cubes fall through a Water
   * surface with WaterCollider sensor. Ground catches them below. */
  {
    id: "splash-test-3d",
    name: "3D Splash Test",
    sub: "Rapier 3D · Water node · WaterCollider sensor · ground",
    type: "advanced",
    thumb: `<svg viewBox="0 0 100 44">
      <rect width="100" height="44" fill="rgba(20,28,40,0.9)"/>
      <rect x="0" y="26" width="100" height="12" rx="0" fill="rgba(40,80,140,0.4)"/>
      <line x1="0" y1="26" x2="100" y2="26" stroke="rgba(80,160,220,0.6)" stroke-width="1"/>
      <circle cx="30" cy="12" r="4" fill="rgba(220,180,80,0.85)"/>
      <circle cx="60" cy="18" r="3" fill="rgba(220,100,80,0.85)"/>
      <circle cx="50" cy="30" r="3.5" fill="rgba(80,160,220,0.5)"/>
    </svg>`,
    build: () => {
      const world = makeNode("PhysicsWorld3D", 40, 60, {
        gravityX: 0, gravityY: -9.8, gravityZ: 0, subSteps: 4
      });

      // Ground below water
      const ground = makeNode("RigidBody3D", 40, 180, {
        type: "static", initX: 0, initY: -6, initZ: 0
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: ground, port: "world" } });
      const groundC = makeNode("BoxCollider3D", 280, 180, {
        halfX: 15, halfY: 0.5, halfZ: 15, friction: 0.5, restitution: 0.2
      });
      state.edges.push({ from: { node: ground, port: "bodyId" }, to: { node: groundC, port: "body" } });
      const groundBox = makeNode("Box", 520, 180, { width: 30, height: 1, depth: 30 });
      const groundT = makeNode("Translate", 700, 180, { x: 0, y: -6, z: 0 });
      state.edges.push({ from: { node: groundBox, port: "mesh" }, to: { node: groundT, port: "mesh" } });

      // Water visual (real Water node at seaLevel=0)
      const water = makeNode("Water", 40, 320, {
        seaLevel: 0,
        colorR: 0.08, colorG: 0.28, colorB: 0.45,
        waveFreq: 0.015, waveSpeed: 0.8, waveAmp: 0.6,
        fresnelStrength: 1.0,
        skyR: 0.55, skyG: 0.72, skyB: 0.88
      });

      // WaterCollider sensor at the water surface
      const waterColl = makeNode("WaterCollider", 280, 320, {
        yLevel: 0, sizeX: 30, sizeZ: 30
      });
      state.edges.push({ from: { node: world, port: "world" }, to: { node: waterColl, port: "world3d" } });

      // 4 cubes falling from above
      const bodies = [];
      const bPos = [
        { x: -3, y: 6, z: -2 },
        { x: 2, y: 9, z: 1 },
        { x: 4, y: 12, z: -3 },
        { x: -1, y: 15, z: 2 }
      ];
      const meshSlots = [groundT, water];
      for (let i = 0; i < bPos.length; i++) {
        const p = bPos[i];
        const b = makeNode("RigidBody3D", 40, 460 + i * 120, {
          type: "dynamic", initX: p.x, initY: p.y, initZ: p.z,
          linearDamping: 0.1, angularDamping: 0.2
        });
        state.edges.push({ from: { node: world, port: "world" }, to: { node: b, port: "world" } });
        const c = makeNode("SphereCollider3D", 280, 460 + i * 120, {
          radius: 0.5, density: 2, friction: 0.3, restitution: 0.4
        });
        state.edges.push({ from: { node: b, port: "bodyId" }, to: { node: c, port: "body" } });
        const bx = makeNode("Sphere", 520, 460 + i * 120, { radius: 0.5, stacks: 12, slices: 16 });
        const tr = makeNode("Translate", 700, 460 + i * 120);
        state.edges.push({ from: { node: bx, port: "mesh" }, to: { node: tr, port: "mesh" } });
        state.edges.push({ from: { node: b, port: "x" }, to: { node: tr, port: "x" } });
        state.edges.push({ from: { node: b, port: "y" }, to: { node: tr, port: "y" } });
        state.edges.push({ from: { node: b, port: "z" }, to: { node: tr, port: "z" } });
        bodies.push(b);
        meshSlots.push(tr);
      }

      // Camera + Scene3D
      const cam = makeNode("FPCamera", 900, 60, {
        posX: 0, posY: 5, posZ: 14, pitch: -18, yaw: 180,
        fov: 60, near: 0.1, far: 200, walkMode: 0
      });
      const light = makeNode("DirectionalLight", 900, 200, {
        dirX: -0.4, dirY: -1, dirZ: -0.3, intensity: 1.2
      });
      const scene = makeNode("Scene3D", 1100, 60, {
        clearR: 0.5, clearG: 0.68, clearB: 0.85
      });
      state.edges.push({ from: { node: cam, port: "camera" }, to: { node: scene, port: "camera" } });
      state.edges.push({ from: { node: light, port: "light" }, to: { node: scene, port: "light1" } });
      for (let i = 0; i < meshSlots.length && i < 8; i++) {
        state.edges.push({ from: { node: meshSlots[i], port: "mesh" }, to: { node: scene, port: "mesh" + (i + 1) } });
      }
      const vo = makeNode("VisualOutput", 1300, 60, { display: 0 });
      state.edges.push({ from: { node: scene, port: "out" }, to: { node: vo, port: "in" } });

      // HUD: body count + first ball Y
      const hudY = makeNode("HUDText", 1100, 300, {
        prefix: "ball0.y ", value: 0, decimals: 2,
        corner: "top-left", fontSize: 14, color: "#67c8ff", opacity: 0.9, margin: 18
      });
      state.edges.push({ from: { node: bodies[0], port: "y" }, to: { node: hudY, port: "value" } });
      state.edges.push({ from: { node: hudY, port: "hud" }, to: { node: scene, port: "hud1" } });

      // Restart
      const restartBtn = makeNode("UIButton", 1100, 400, {
        label: "↺  DROP AGAIN",
        x: 12, y: 12, width: 160, height: 36,
        color: "#2a3a50", hoverColor: "#5a7090",
        textColor: "#cfe9ff", borderColor: "#9bd0ff", borderWidth: 1.2,
        borderRadius: 4, fontSize: 13, opacity: 0.92,
        corner: "bottom-right"
      });
      for (const b of bodies) {
        state.edges.push({ from: { node: restartBtn, port: "clicked" }, to: { node: b, port: "reset" } });
      }
    }
  }
];