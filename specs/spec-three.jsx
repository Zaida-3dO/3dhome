/* =====================================================================
   SPEC THREE  ·  reusable ThreeView for 3D-item spec pages
   ---------------------------------------------------------------------
   Factored verbatim from DoorSpec's ThreeView: renderer, lights
   (ambient + key + fill), hand-rolled orbit camera (orb {th,ph,r}),
   pointer-drag / wheel-zoom, resize handler, RAF loop, view presets.

   A spec page uses it like:

     <ThreeView
        t={t}
        buildModel={(t, group, THREE, ctx) => { ... build meshes ... }}
        animate={(t, ctx, dt) => { ... optional per-frame lerp ... }}
        heightOf={t => t.wallHeight * 0.01}   // optional: focus height
     />

   Contracts
   ---------
   buildModel(t, group, THREE, ctx)
       Called on mount and on every change to `t`. `group` is a fresh
       THREE.Group already added to the scene root (the previous one is
       torn down + disposed for you). Add all item meshes to `group`.
       Stash anything the animate loop needs on `ctx` (a persistent
       per-view object), e.g. ctx.sash = pivotGroup.

   animate(t, ctx, dt)   [optional]
       Called every RAF frame. Use for kinematics (lerp a pivot toward a
       target angle, etc.). `dt` is a smoothing factor (~0.15, matching
       DoorSpec's door lerp). No-op if not supplied.

   heightOf(t)  [optional]
       Returns the focus height (m) used to centre the camera + presets.
       Defaults to 1.0 (DoorSpec centred on ~half door height).

   -------------------------------------------------------------------
   OPT-IN ROOM FEATURES (added for the bathroom specs — 2026-07-18)
   -------------------------------------------------------------------
   All of the below are STRICTLY OPT-IN via userData markers set inside
   buildModel. Pages that set no markers (DoorSpec, WindowSpec,
   CurtainSpec, BalconyWindowSpec) behave EXACTLY as before — the render
   loop simply finds no marked meshes and does nothing extra.

   (A) OUTSIDE-TRANSPARENT SHELL WALLS
       On any wall mesh you want to fade when the camera looks at its
       BACK from outside the room, set:

         mesh.userData.shellWall = { nx, nz };

       where (nx, nz) is the wall's OUTWARD normal in world XZ (unit
       length; the component along the wall's thickness axis, pointing
       AWAY from the room centre). Example for the four shell walls of a
       box room centred on origin:
         S wall (at +Z, faces +Z outward): { nx: 0,  nz:  1 }
         N wall (at -Z, faces -Z outward): { nx: 0,  nz: -1 }
         E wall (at +X, faces +X outward): { nx: 1,  nz:  0 }
         W wall (at -X, faces -X outward): { nx:-1,  nz:  0 }

       Each frame the loop computes camDir = normalize(target - camPos)
       and dot = nx*camDir.x + nz*camDir.z; if dot > 0.3 (we're outside
       looking at the wall's back) it eases the wall toward opacity 0.05,
       else toward 1.0. depthWrite tracks opacity>0.98.

       The loop AUTO-ENABLES transparency: on first sight of a shellWall
       mesh it sets material.transparent = true and opacity = 1 for you,
       so buildModel does NOT need to pre-configure the material. This
       works for BOTH a single Material AND a Material[] array (per-face
       materials from makeWallMaterials): every material in the array is
       eased together, so a tiled wall fades as one.

   (B) OUTSIDE-TRANSPARENT CEILING
       On the ceiling mesh set:

         mesh.userData.fadeCeiling = true;

       (Optionally mesh.userData.roomHeightM = <m>; if omitted the loop
       uses heightOf(t), i.e. the same focus height passed in.) When the
       camera Y rises above roomHeightM the ceiling eases to opacity 0
       (see-through from above), else back to 1.0. transparency is
       auto-enabled the same way as shell walls.

   (C) MIRROR REFLECTIONS (scene.environment)
       The loop installs a CubeCamera + WebGLCubeRenderTarget and sets
       scene.environment to its texture, so EVERY MeshStandardMaterial in
       the scene gets image-based reflections (harmless on pages with no
       metal). This is what makes makeMirrorMaterial actually reflect the
       room instead of reading black. The cube is captured a few frames
       after each rebuild (settle frames), positioned at the room centre
       (target). Meshes tagged mesh.userData.isMirror = true are HIDDEN
       during the cube capture so a mirror never reflects itself.
       buildModel only needs to tag mirror meshes with
       userData.isMirror = true (optional but recommended); no other work.
   ===================================================================== */

function ThreeView({ t, buildModel, animate, heightOf, presetHeight }) {
  const canvasRef = React.useRef(null);
  const stateRef = React.useRef({});
  // keep latest callbacks without re-running the init effect
  const cbRef = React.useRef({});
  cbRef.current = { buildModel, animate, heightOf };

  // ---- initialise scene once ----------------------------------------
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    const W = canvas.clientWidth, H = canvas.clientHeight;
    renderer.setSize(W, H, false);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1c);
    const cam = new THREE.PerspectiveCamera(35, W / H, 0.01, 50);

    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2, 4, 3);
    key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xb8c8ff, 0.3);
    fill.position.set(-2, 1, -2);
    scene.add(fill);

    const sceneRoot = new THREE.Group();
    scene.add(sceneRoot);

    // ---- environment cube (mirror reflections) ------------------------
    // A CubeCamera renders the room into a cube render-target; setting
    // scene.environment to it gives every MeshStandardMaterial image-based
    // reflections. Backward-compatible: pages with no metal surfaces are
    // visually unchanged (a dim room env doesn't noticeably alter matte
    // plaster/wood), it just fixes the "mirror is black" bug. The cube is
    // (re)captured a few frames after each rebuild — see envCapture below.
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, {
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    });
    const cubeCam = new THREE.CubeCamera(0.05, 50, cubeRT);
    scene.add(cubeCam);
    scene.environment = cubeRT.texture;
    // frames-remaining counter: >0 means "capture the env cube this frame".
    // Set to a few frames on each rebuild so materials/positions settle.
    let envCaptureFrames = 3;

    const target = new THREE.Vector3(0, 1, 0);
    let orb = { th: 0.6, ph: 1.15, r: 3.8, drag: false, px: 0, py: 0 };
    function syncCam() {
      cam.position.set(
        target.x + orb.r * Math.sin(orb.ph) * Math.sin(orb.th),
        target.y + orb.r * Math.cos(orb.ph),
        target.z + orb.r * Math.sin(orb.ph) * Math.cos(orb.th)
      );
      cam.lookAt(target);
    }
    syncCam();

    canvas.addEventListener('pointerdown', e => {
      orb.drag = true; orb.px = e.clientX; orb.py = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!orb.drag) return;
      const dx = e.clientX - orb.px, dy = e.clientY - orb.py;
      orb.th -= dx * 0.005;
      orb.ph = Math.max(0.1, Math.min(Math.PI - 0.1, orb.ph - dy * 0.005));
      orb.px = e.clientX; orb.py = e.clientY;
      syncCam();
    });
    canvas.addEventListener('pointerup', e => {
      orb.drag = false;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      orb.r = Math.max(0.4, Math.min(10, orb.r + e.deltaY * 0.003));
      syncCam();
    }, { passive: false });

    const onResize = () => {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      cam.aspect = W / H; cam.updateProjectionMatrix();
      renderer.setSize(W, H, false);
    };
    window.addEventListener('resize', onResize);

    // persistent context object handed to buildModel / animate
    const ctx = {};

    // ---- opt-in room-fade helpers -------------------------------------
    // Ease opacity on a mesh that may carry EITHER a single Material or a
    // Material[] (per-face array from makeWallMaterials). Auto-enables
    // transparency on first touch so buildModel needn't pre-configure it.
    const _camDir = new THREE.Vector3();
    const _seenMats = new Set();
    function easeMeshOpacity(mesh, targetOpacity, k) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      _seenMats.clear();
      for (const m of mats) {
        // dedupe: makeWallMaterials repeats ONE outer-mat instance across 5
        // faces; ease each distinct material exactly once per frame so all
        // faces fade at the same rate (not 5x faster on the shared instance).
        if (!m || _seenMats.has(m)) continue;
        _seenMats.add(m);
        if (!m.transparent) { m.transparent = true; m.needsUpdate = true; }
        m.opacity += (targetOpacity - m.opacity) * k;
        m.depthWrite = m.opacity > 0.98;
      }
    }
    // Collect the marked meshes once per rebuild (cheap; the room is small).
    // Defined here as a closure; wired onto stateRef in the assignment below
    // so the [t] rebuild effect can refresh the lists after each build.
    const collectRoomMeshes = () => {
      const shellWalls = [], mirrors = [];
      let ceiling = null;
      sceneRoot.traverse(o => {
        if (!o.isMesh) return;
        if (o.userData && o.userData.shellWall) shellWalls.push(o);
        if (o.userData && o.userData.fadeCeiling) ceiling = o;
        if (o.userData && o.userData.isMirror) mirrors.push(o);
      });
      stateRef.current._shellWalls = shellWalls;
      stateRef.current._ceiling = ceiling;
      stateRef.current._mirrors = mirrors;
    };

    let raf, last = performance.now();
    (function loop() {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const frameDt = Math.min(0.05, (now - last) / 1000); last = now;
      const t = stateRef.current.t;
      const anim = cbRef.current.animate;
      if (anim && t) anim(t, ctx, 0.15, frameDt);

      // (A) shell-wall fade: transparent when the camera looks at the wall's
      // back from outside the room. Uses the SAME look target as the camera.
      const shellWalls = stateRef.current._shellWalls;
      if (shellWalls && shellWalls.length) {
        _camDir.subVectors(target, cam.position).normalize();
        for (const mesh of shellWalls) {
          const sw = mesh.userData.shellWall;
          const dot = sw.nx * _camDir.x + sw.nz * _camDir.z;
          easeMeshOpacity(mesh, dot > 0.3 ? 0.05 : 1.0, 0.12);
        }
      }
      // (B) ceiling fade: see-through once the camera rises above room height.
      const ceiling = stateRef.current._ceiling;
      if (ceiling) {
        const roomH = (ceiling.userData.roomHeightM != null)
          ? ceiling.userData.roomHeightM
          : (stateRef.current._h ?? 1.0);
        easeMeshOpacity(ceiling, cam.position.y > roomH ? 0 : 1.0, 0.12);
      }

      // (C) env cube capture (mirror reflections). Only when scheduled, and
      // with mirror meshes hidden so they don't reflect themselves.
      if (envCaptureFrames > 0) {
        envCaptureFrames--;
        const mirrors = stateRef.current._mirrors || [];
        const hidden = [];
        for (const m of mirrors) { hidden.push(m.visible); m.visible = false; }
        cubeCam.position.copy(target);
        const prevEnv = scene.environment;
        scene.environment = null; // avoid feedback while capturing
        cubeCam.update(renderer, scene);
        scene.environment = prevEnv;
        for (let i = 0; i < mirrors.length; i++) mirrors[i].visible = hidden[i];
      }

      renderer.render(scene, cam);
    })();

    stateRef.current = {
      scene, sceneRoot, cam, target, orb, syncCam, renderer, ctx, _h: 1.0,
      cubeRT, cubeCam, collectRoomMeshes,
      // called by the [t] rebuild effect to re-capture the env cube (mirror
      // reflections) after new geometry lands.
      scheduleEnvCapture: () => { envCaptureFrames = 3; },
      _shellWalls: [], _ceiling: null, _mirrors: [],
    };

    // view preset switcher (same five presets as DoorSpec)
    stateRef.current.setView = (id) => {
      const h = (stateRef.current._h ?? 1.0);
      const views = {
        iso:     { th: 0.6,            ph: 1.15,       r: 3.8, target: [0, h / 2, 0] },
        front:   { th: 0,              ph: Math.PI / 2, r: 3.4, target: [0, h / 2, 0] },
        edge:    { th: Math.PI / 2 - 0.05, ph: Math.PI / 2, r: 1.5, target: [0, h / 2, 0] },
        closeup: { th: 0.4,            ph: 1.4,        r: 0.9, target: [0, h * 0.4, 0] },
        top:     { th: 0.0,            ph: 0.05,       r: 3.0, target: [0, h * 0.5, 0] },
      };
      const v = views[id]; if (!v) return;
      orb.th = v.th; orb.ph = v.ph; orb.r = v.r;
      target.set(...v.target);
      syncCam();
    };

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      cubeRT.dispose();
      renderer.dispose();
    };
  }, []);

  // ---- (re)build geometry whenever t changes ------------------------
  React.useEffect(() => {
    const s = stateRef.current;
    if (!s || !s.sceneRoot) return;
    s.t = t;

    // tear down previous group + dispose geometry
    while (s.sceneRoot.children.length) {
      const c = s.sceneRoot.children[0];
      s.sceneRoot.remove(c);
      c.traverse && c.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      if (c.geometry) c.geometry.dispose();
    }

    // focus height for camera + presets
    const h = (cbRef.current.heightOf ? cbRef.current.heightOf(t) : 1.0);
    s._h = h;
    s.target.set(0, h / 2, 0);
    s.syncCam();

    const group = new THREE.Group();
    group.name = 'itemRoot';
    s.sceneRoot.add(group);

    // reset per-build context stash (keep the object identity)
    for (const k of Object.keys(s.ctx)) delete s.ctx[k];

    if (cbRef.current.buildModel) cbRef.current.buildModel(t, group, THREE, s.ctx);

    // refresh opt-in room-feature mesh lists + re-capture the mirror env cube
    // now that new geometry is in the scene (no-ops if nothing is tagged).
    if (s.collectRoomMeshes) s.collectRoomMeshes();
    if (s.scheduleEnvCapture) s.scheduleEnvCapture();
  }, [t]);

  return (
    <>
      <canvas id="c3d" ref={canvasRef}></canvas>
      <div className="row">
        {['iso', 'front', 'edge', 'closeup', 'top'].map(id => (
          <button key={id} className="btn"
            onClick={() => stateRef.current.setView && stateRef.current.setView(id)}>{id}</button>
        ))}
      </div>
      <div className="legend">Drag to orbit · scroll to zoom.</div>
    </>
  );
}
