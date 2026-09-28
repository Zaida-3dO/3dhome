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

   backgroundOf(t)  [optional]
       Returns a THREE.Color-constructible value (hex number or CSS string)
       for the scene background, re-evaluated on every `t` change alongside
       buildModel. Defaults to the original fixed 0x1a1a1c for every page
       that does not pass it, so DoorSpec/WindowSpec/etc. are unaffected.
       Added for WallPanelSpec's hex-cluster mode (2026-09-26, review round
       2): the default dark background made the dark-green felt (#1e3228,
       rgb ~22,32,27) nearly invisible against it (rgb 26,26,28).

   initialView  [optional]
       { th, ph, r, target: [x, y, z] } -- the orbit camera's starting
       pose and its fixed look target (kept across rebuilds instead of the
       default (0, heightOf/2, 0)). Added for StripLightSpec's close-up,
       which has to look UP at tubes mounted under shelves. Pages that do
       not pass it are unaffected.

   initialSun  [optional]
       'morning' | 'noon' | 'evening' | 'night': the time of day the view
       opens on (default noon; ?sun= in the URL beats it). StripLightSpec's
       close-up opens on night, where strip lights are judged.

   nightRoom  [optional]
       'spots' (default) | 'downlights': which of the house's two kinds of
       room lighting the item stands under at night (GENERIC_ROOMS in
       render-rig.js) -- a bedroom's single spot-cluster light, or a living
       room's six downlights. ?room= in the URL beats it.

   rigOf(t)  [retired, ignored]
       Chose between the old spec lights and a copy of the house's night
       rig. Every view now renders with the house's own rig (below), so there
       is nothing to choose; the prop is accepted and ignored.

   -------------------------------------------------------------------
   LIGHTING: THE HOUSE'S OWN (item 7938c4e3, 2026-09-28)
   -------------------------------------------------------------------
   A spec page shows an item as it will look in the house. The renderer
   settings (ACES tone mapping at the house's exposure, colour space,
   PCF shadows), the sun and hemisphere sky fill, the time-of-day
   presets, the night room light and the finish look all come from
   src/render-rig.js -- the SAME module src/home3d-scene.js lights the
   house with -- so the two cannot drift. There is NO environment map,
   as in the house: a mirror or polished metal reads the way it will in
   the house, and palette finishes get the house's no-env roughness and
   metalness (applyLiveFinishes).

   A time-of-day row under the view buttons picks morning / noon /
   evening / night (default noon; `?sun=<preset>` pins it, for
   reproducible captures). Night is the house's night sky plus a generic
   room's lights: its main ceiling light(s) and the room shadow spot, at
   100% and 4000 K, built as the house builds a room's and hung in front of
   the item, where a house room's lights sit relative to its furniture
   (GENERIC_ROOMS in render-rig.js; the nightRoom prop picks the room).

   The sun's shadow uses the house's settings exactly (map size, depth
   bias, normal bias, near/far and the sun's distance, so the bias is
   the same ~2 cm in the world); only its frustum differs: it is fitted
   tightly round the item's shadow casters and the shadows they throw on
   the floor (fitSunShadow), where the house fits it to the house.

   render-rig.js is plain ESM. Babel's in-browser transform turns a
   literal dynamic import into require(), so it is loaded through a
   Function-built import() resolved against THIS script's own URL -- which
   is what lets the private pages under houses/<id>/specs/ (which load this
   file from three directories up) find it too. The view is built at once
   and lit when the module arrives, a few milliseconds later.

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

   (C) MIRRORS: no environment map any more (see LIGHTING above). The old
       env-cube capture is gone; userData.isMirror is still honoured by
       nothing here and harmless to set.

   (D) BACKDROPS IN THE HOUSE'S FINISHES
       Tag a staging floor or wall in buildModel with
         mesh.userData.specBackdrop = 'floor';   // or 'wall'
       and the harness gives it the house's own finish (src/room-finishes.js):
       the Ashy Oak floor across the mesh's UV extent, or the painted wall.
       Colours picked for the old bright rig read near-black under the house
       rig and hid contact shadows (96db53af).
   ===================================================================== */

/* SPEC-ISO-DISTANCE-BEGIN -- plain JS, no JSX: scripts/test-spec-three.mjs
   extracts this block and runs it, so keep it self-contained.
   How far the iso camera must stand, looking at its target from the orbit
   angles (th, ph), for every one of `points` ([x, y, z] in metres, relative
   to the target -- the item's bounding-box corners) to land inside `fill` of
   the frame's WIDTH, given the canvas `aspect` (width / height) and the
   camera's VERTICAL field of view `fovDeg`.
   Portrait canvases only: the reported crop is a phone's (390 px), where the
   canvas is taller than wide and the horizontal field of view is the narrow
   one. A landscape canvas (aspect >= 1: every desktop) gets `minDistance`,
   the fixed 3.8 m every page has always used, so desktop framing is exactly
   as it was. On portrait only the width is fitted, and exactly (the box, not
   a bounding sphere), so an item whose width already fits stays at 3.8 m
   too; the height is the roomy axis there. Never beyond `maxDistance` (the
   orbit's own zoom limit). (From PR #89, folded in by item 7938c4e3.) */
function specIsoDistance(points, th, ph, aspect, fovDeg, minDistance, maxDistance, fill) {
  if (!(aspect < 1)) return Math.min(maxDistance ?? Infinity, minDistance ?? 0);
  // camera "back" axis (target -> camera), as syncCam places it, and its
  // horizontal "right" axis (worldUp x back)
  const bx = Math.sin(ph) * Math.sin(th), by = Math.cos(ph), bz = Math.sin(ph) * Math.cos(th);
  const rl = Math.hypot(bz, bx) || 1;
  const rx = bz / rl, rz = -bx / rl;
  const tanH = Math.tan(fovDeg * Math.PI / 360) * aspect * (fill ?? 1);
  let need = 0;
  for (const [x, y, z] of points) {
    const px = x * rx + z * rz, pz = x * bx + y * by + z * bz;
    // the point sits pz nearer the camera than the target; at distance d it
    // is (d - pz) deep and must satisfy |px| <= (d - pz) * tanH
    need = Math.max(need, pz + Math.abs(px) / tanH);
  }
  return Math.min(maxDistance ?? Infinity, Math.max(minDistance ?? 0, need));
}
/* SPEC-ISO-DISTANCE-END */
if (typeof window !== 'undefined') window.specIsoDistance = specIsoDistance;

/* ---- the shared rig (src/render-rig.js) ---------------------------------
   Loaded once per page, resolved against this script's own URL (see the
   header). window.specRenderRig is the module once it has arrived;
   window.specRenderRigReady the promise. A page that fails to load it logs
   why and keeps rendering unlit rather than throwing inside React. */
const SPEC_SUN_PRESETS = ['morning', 'noon', 'evening', 'night'];
/** The orbit's zoom limit (m): far enough for the balcony's iso fit on a phone. */
const SPEC_MAX_DISTANCE = 20;
const SPEC_RIG_READY = (function loadSpecRig() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.specRenderRigReady) return window.specRenderRigReady;
  const tag = document.querySelector('script[src$="spec-three.jsx"]');
  const url = new URL('../src/render-rig.js', tag ? tag.src : window.location.href).href;
  // new Function keeps the literal import() away from Babel (see the header).
  const load = new Function('u', 'return import(u);');
  window.specRenderRigReady = load(url).then(m => { window.specRenderRig = m; return m; },
    e => { console.error('[spec-three] could not load the shared render rig from ' + url, e); return null; });
  return window.specRenderRigReady;
})();

/** The time-of-day preset a view opens on: ?sun=<preset>, else the page's
    initialSun prop, else noon. */
function specInitialSun(pageDefault) {
  try {
    const q = new URLSearchParams(window.location.search).get('sun');
    if (SPEC_SUN_PRESETS.indexOf(q) !== -1) return q;
  } catch (e) { /* no location: the default */ }
  if (SPEC_SUN_PRESETS.indexOf(pageDefault) !== -1) return pageDefault;
  return 'noon';
}

/** The night room a view's item stands in: ?room=<kind>, else the page's
    nightRoom prop, else 'spots' (see GENERIC_ROOMS in render-rig.js). */
function specNightRoom(pageDefault) {
  const kinds = ['spots', 'downlights'];
  try {
    const q = new URLSearchParams(window.location.search).get('room');
    if (kinds.indexOf(q) !== -1) return q;
  } catch (e) { /* no location: the default */ }
  return kinds.indexOf(pageDefault) !== -1 ? pageDefault : 'spots';
}

function ThreeView({ t, buildModel, animate, heightOf, backgroundOf, presetHeight, initialView, initialSun, nightRoom, rigOf }) {
  const canvasRef = React.useRef(null);
  const stateRef = React.useRef({});
  // keep latest callbacks without re-running the init effect
  const cbRef = React.useRef({});
  cbRef.current = { buildModel, animate, heightOf, backgroundOf, initialView, nightRoom };
  const [sunPreset, setSunPreset] = React.useState(() => specInitialSun(initialSun));

  // ---- initialise scene once ----------------------------------------
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    const W = canvas.clientWidth, H = canvas.clientHeight;
    renderer.setSize(W, H, false);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;

    const scene = new THREE.Scene();
    // Replaced by the daylight sky colour once the rig is lit, unless the
    // page passes backgroundOf.
    scene.background = new THREE.Color(cbRef.current.backgroundOf ? cbRef.current.backgroundOf(t) : 0x1a1a1c);
    const cam = new THREE.PerspectiveCamera(35, W / H, 0.01, 50);

    const sceneRoot = new THREE.Group();
    scene.add(sceneRoot);

    const target = new THREE.Vector3(0, 1, 0);
    let orb = { th: 0.6, ph: 1.15, r: 3.8, drag: false, px: 0, py: 0 };
    const iv = cbRef.current.initialView;
    if (iv) {
      orb.th = iv.th; orb.ph = iv.ph; orb.r = iv.r;
      if (iv.target) target.set(iv.target[0], iv.target[1], iv.target[2]);
    }
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
      orb.drag = true; orb.isoAuto = false; orb.px = e.clientX; orb.py = e.clientY;
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
      orb.isoAuto = false;
      orb.r = Math.max(0.4, Math.min(SPEC_MAX_DISTANCE, orb.r + e.deltaY * 0.003));
      syncCam();
    }, { passive: false });

    const onResize = () => {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      cam.aspect = W / H; cam.updateProjectionMatrix();
      renderer.setSize(W, H, false);
      // Still on the automatic iso framing (nobody has orbited or zoomed):
      // refit it to the new aspect, so a window narrowed to a phone's width
      // or a rotated phone keeps the whole item in frame.
      if (orb.isoAuto && stateRef.current.isoDistance) { orb.r = stateRef.current.isoDistance(); syncCam(); }
    };
    window.addEventListener('resize', onResize);

    // ---- boxes ------------------------------------------------------------
    // World-box corners ([x, y, z], absolute) of the visible meshes under
    // sceneRoot that pass `keep`. Flat meshes (thinner than 1 cm on some
    // axis: a floor disc or plane) are always skipped -- staging must not
    // push the iso camera back or stretch the sun's shadow frustum.
    const _box = new THREE.Box3(), _size = new THREE.Vector3();
    function worldCorners(keep) {
      const pts = [];
      sceneRoot.traverse(o => {
        if (!o.isMesh || !o.visible || !o.geometry) return;
        if (keep && !keep(o)) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        _box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
        if (_box.isEmpty()) return;
        _box.getSize(_size);
        if (Math.min(_size.x, _size.y, _size.z) < 0.01) return;
        for (let i = 0; i < 8; i++) {
          pts.push([i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z]);
        }
      });
      return pts;
    }

    // ---- iso framing (PR #89) ------------------------------------------
    // The item's corners relative to the look target. Backdrops -- the pages
    // build their walls and floors to RECEIVE shadows only -- are skipped
    // whenever anything else is left (some builders mark their own meshes
    // receive-only too; then everything counts).
    function itemCorners() {
      sceneRoot.updateMatrixWorld(true);
      let pts = worldCorners(o => !(o.receiveShadow && !o.castShadow));
      if (!pts.length) pts = worldCorners(null);
      return pts.map(p => [p[0] - target.x, p[1] - target.y, p[2] - target.z]);
    }
    function isoDistance() {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      const pts = itemCorners();
      const d = (pts.length && W > 0 && H > 0)
        ? specIsoDistance(pts, orb.th, orb.ph, W / H, cam.fov, 3.8, SPEC_MAX_DISTANCE, 0.92)
        : 3.8;
      canvas.dataset.isoDistance = d.toFixed(3); // read by browser checks
      return d;
    }

    // ---- lighting: the house's rig (src/render-rig.js) -------------------
    // Built when the module arrives (attachRig); `lit` holds what it made.
    // backdrops: the house floor/wall materials, shared across rebuilds.
    const lit = { rig: null, sky: null, room: [], preset: 'noon', curve: null, backdrops: new Map() };
    // Shadow casters for the sun's frustum: every visible caster, else (a
    // page whose meshes cast nothing) every mesh, so the frustum still sits
    // on the item.
    function casterCorners() {
      sceneRoot.updateMatrixWorld(true);
      const pts = worldCorners(o => o.castShadow);
      return pts.length ? pts : worldCorners(null);
    }
    // Fit the sun's shadow frustum round the casters (their shadows fall
    // inside it by construction). Runs on every rebuild and time-of-day change, and
    // every frame on a page with an animate() (a door swinging must stay
    // inside it).
    function fitShadow() {
      if (!lit.rig) return;
      lit.rig.fitSunShadow(lit.sky.sun, casterCorners());
    }
    // Place the sun (and, at night, the room light) for the current preset
    // about the item's centre, then refit the shadow.
    function relight() {
      if (!lit.rig) return;
      const R = lit.rig;
      const pts = casterCorners();
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
      const cx = pts.length ? (x0 + x1) / 2 : 0, cz = pts.length ? (z0 + z1) / 2 : 0;
      lit.sky.sun.target.position.set(cx, 0, cz);
      lit.curve = R.applyDaylight(lit.sky, R.presetSun(lit.preset, { hasSite: false }),
        { centre: [cx, cz], shadowed: true });
      // Night: the room's lights hang at the generic room's centre, in front
      // of and beside the item (its front face is the casters' +z side), as
      // a house room's main light sits relative to its furniture.
      const night = lit.preset === 'night';
      // (Re)build the room's lights when the page's room kind changes.
      const kind = specNightRoom(cbRef.current.nightRoom);
      if (kind !== lit.roomKind) {
        for (const l of lit.room) { if (l.target) scene.remove(l.target); scene.remove(l); if (l.dispose) l.dispose(); }
        lit.room = R.createGenericRoomLights(THREE, { kind });
        for (const l of lit.room) { if (l.target) scene.add(l.target); scene.add(l); }
        lit.roomKind = kind;
        canvas.dataset.nightRoom = kind;   // read by browser checks
      }
      R.placeGenericRoomLights(lit.room, cx, pts.length ? z1 : 0);
      for (const l of lit.room) l.visible = night;
      if (!cbRef.current.backgroundOf) {
        const b = lit.curve.background;
        scene.background.setRGB(b[0], b[1], b[2]);
      }
      fitShadow();
      canvas.dataset.sunPreset = lit.preset;   // read by browser checks
    }
    function attachRig(R) {
      if (!R || lit.rig) return;
      lit.rig = R;
      R.applyRendererSettings(THREE, renderer);
      // Light order as the house adds them: hemisphere, sun target, sun.
      lit.sky = R.createSkyRig(THREE, { castShadow: true });
      scene.add(lit.sky.hemi);
      scene.add(lit.sky.sun.target);
      scene.add(lit.sky.sun);
      R.applyLiveFinishes(sceneRoot);
      R.applyRoomBackdrops(THREE, sceneRoot, lit.backdrops);
      relight();
    }
    function setSunPresetNow(preset) {
      lit.preset = SPEC_SUN_PRESETS.indexOf(preset) !== -1 ? preset : 'noon';
      relight();
    }

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
      const shellWalls = [];
      let ceiling = null;
      sceneRoot.traverse(o => {
        if (!o.isMesh) return;
        if (o.userData && o.userData.shellWall) shellWalls.push(o);
        if (o.userData && o.userData.fadeCeiling) ceiling = o;
      });
      stateRef.current._shellWalls = shellWalls;
      stateRef.current._ceiling = ceiling;
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

      if (anim) fitShadow();
      renderer.render(scene, cam);
    })();

    stateRef.current = {
      scene, sceneRoot, cam, target, orb, syncCam, renderer, ctx, _h: 1.0,
      collectRoomMeshes, isoDistance, lit, relight, setSunPresetNow,
      applyFinishes: () => {
        if (!lit.rig) return;
        lit.rig.applyLiveFinishes(sceneRoot);
        lit.rig.applyRoomBackdrops(THREE, sceneRoot, lit.backdrops);
      },
      _shellWalls: [], _ceiling: null,
    };
    // For browser checks (the canvas cannot be read back from outside a
    // frame): the view's state, its lights included.
    canvas.specView = stateRef.current;
    lit.preset = SPEC_SUN_PRESETS.indexOf(sunPreset) !== -1 ? sunPreset : 'noon';
    let disposed = false;
    if (window.specRenderRig) attachRig(window.specRenderRig);
    else SPEC_RIG_READY.then(R => { if (!disposed) attachRig(R); });

    // view preset switcher (same five presets as DoorSpec)
    stateRef.current.setView = (id) => {
      const h = (stateRef.current._h ?? 1.0);
      const views = {
        iso:     { th: 0.6,            ph: 1.15,       r: null, target: [0, h / 2, 0] },
        front:   { th: 0,              ph: Math.PI / 2, r: 3.4, target: [0, h / 2, 0] },
        edge:    { th: Math.PI / 2 - 0.05, ph: Math.PI / 2, r: 1.5, target: [0, h / 2, 0] },
        closeup: { th: 0.4,            ph: 1.4,        r: 0.9, target: [0, h * 0.4, 0] },
        top:     { th: 0.0,            ph: 0.05,       r: 3.0, target: [0, h * 0.5, 0] },
      };
      const v = views[id]; if (!v) return;
      orb.th = v.th; orb.ph = v.ph;
      target.set(...v.target);
      // iso stands back far enough to fit the whole item at THIS canvas's
      // aspect (after the target moves: the radius is measured from it).
      orb.r = v.r ?? isoDistance();
      orb.isoAuto = v.r == null;
      syncCam();
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      // Release the WebGL context itself, not just its resources: a spec page
      // that switches objects (SpecPage in tweaks-panel.jsx) unmounts one
      // ThreeView and mounts another each time, and browsers cap live contexts.
      renderer.forceContextLoss();
    };
  }, []);

  // ---- time of day ----------------------------------------------------
  React.useEffect(() => {
    const s = stateRef.current;
    if (s && s.setSunPresetNow) s.setSunPresetNow(sunPreset);
  }, [sunPreset]);

  // ---- (re)build geometry whenever t changes ------------------------
  React.useEffect(() => {
    const s = stateRef.current;
    if (!s || !s.sceneRoot) return;
    s.t = t;

    // background can react to `t` too (e.g. WallPanelSpec lightens it in
    // hex mode so the felt colour reads against it) -- no-op for every page
    // that does not pass backgroundOf, whose background is the daylight sky.
    if (cbRef.current.backgroundOf) s.scene.background.set(cbRef.current.backgroundOf(t));

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
    const ivt = cbRef.current.initialView && cbRef.current.initialView.target;
    if (ivt) s.target.set(ivt[0], ivt[1], ivt[2]);
    else s.target.set(0, h / 2, 0);
    s.syncCam();

    const group = new THREE.Group();
    group.name = 'itemRoot';
    s.sceneRoot.add(group);

    // reset per-build context stash (keep the object identity)
    for (const k of Object.keys(s.ctx)) delete s.ctx[k];

    if (cbRef.current.buildModel) cbRef.current.buildModel(t, group, THREE, s.ctx);

    // the house's finish look, then re-aim the sun at what was built
    if (s.applyFinishes) s.applyFinishes();
    if (s.relight) s.relight();
    // refresh opt-in room-feature mesh lists (no-ops if nothing is tagged).
    if (s.collectRoomMeshes) s.collectRoomMeshes();

    // The first build opens on the iso view: frame it to fit the item (a
    // page with its own initialView keeps that). Later rebuilds (a tweak
    // changed) keep whatever zoom the viewer has chosen.
    if (!s._framed) {
      s._framed = true;
      if (!cbRef.current.initialView) {
        s.orb.r = s.isoDistance();
        s.orb.isoAuto = true;
        s.syncCam();
      }
    }
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
      <div className="row" role="radiogroup" aria-label="Time of day">
        {SPEC_SUN_PRESETS.map(id => (
          <button key={id} type="button" role="radio" aria-checked={id === sunPreset}
            className={'btn' + (id === sunPreset ? ' active' : '')} data-sun-preset={id}
            onClick={() => setSunPreset(id)}>{id}</button>
        ))}
      </div>
      <div className="legend">Drag to orbit · scroll to zoom · lit as in the house, at the time of day above.</div>
    </>
  );
}
