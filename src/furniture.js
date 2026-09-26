/**
 * furniture.js - turn a house's compiled `furniture[]` into scene meshes.
 *
 * The data layer (house-loader.js compileFurniture, furniture/place.js,
 * furniture/registry.js) decides WHERE each item stands. This module builds
 * each item with its registered builder, places it, and hands the lot to
 * furniture/merge.js, which folds it into a few draws per room. It returns a
 * single Group for the scene to attach, plus the meshes the scene needs to
 * know about individually.
 *
 *   beauty meshes    merged buckets. castShadow = false, receiveShadow = true.
 *   shadow proxies   ONE per furnished room: a position-only copy of exactly
 *                    the beauty geometry of that room's casters, drawn with a
 *                    material that writes neither colour nor depth. It is
 *                    invisible in the beauty pass and casts in every shadow
 *                    pass with the shared depth material. See plan amendment
 *                    A1, and docs/house-profile.md "Furniture: how it renders".
 *
 * Why a proxy and not castShadow on the beauty meshes: a caster draws in the
 * sun pass AND in every room SpotLight pass whose frustum it touches. One
 * merged caster per room bounds that at one draw per pass per room. Why not a
 * layer: r160's shadow traversal tests an object's layers against the MAIN
 * camera, never the shadow camera, so a proxy on its own layer casts nothing.
 *
 * Pure ESM with THREE injected, so the Node tests drive the same code the
 * scene does.
 */
import { loadBuilders } from './furniture/registry.js';
import { resolvePlacement, footprintRect, pickFadeWall } from './furniture/place.js';
import { flattenGroup, groupBuckets, buildBucketMesh, createMaterialSet, concatGeometries, neverFades } from './furniture/merge.js';

/** An item casts (through its room's proxy) when it stands on the floor and is tall enough to matter. */
export const CASTER_MAX_ELEVATION = 30;   // cm: elevation must be BELOW this
export const CASTER_MIN_HEIGHT = 40;      // cm: height must be AT LEAST this
/** `fade: "auto"` only considers an item whose top is above this (cm). */
export const FADE_MIN_TOP = 100;
/** Proxy triangle caps (plan A1). */
export const PROXY_ROOM_TRI_CAP = 15000;
export const PROXY_TOTAL_TRI_CAP = 60000;

const DEG = Math.PI / 180;

/** Does this item cast a shadow (through its room's proxy)? */
export function isCaster(item, params) {
  const elev = item.elevation || 0;
  const h = params && typeof params.height === 'number' ? params.height : 0;
  return elev < CASTER_MAX_ELEVATION && h >= CASTER_MIN_HEIGHT;
}

/**
 * The ONE wall an item fades with, or null (plan §2.5).
 *
 *   fade: "never"     -> null
 *   fade: {wall: id}  -> id (an explicit override, either anchor form)
 *   fade: "auto"      -> only when elevation + height > FADE_MIN_TOP:
 *                        a wall-anchored item fades with its host wall if that
 *                        wall is exterior; a free item with pickFadeWall() over
 *                        its footprint.
 *
 * A corner unit belongs to the run that owns the corner and so fades with
 * that run's host wall -- which is exactly what the wall anchor gives it.
 */
export function resolveFadeWall(item, params, placement, walls) {
  if (item.fade === 'never') return null;
  if (item.fade && typeof item.fade === 'object' && item.fade.wall != null) return item.fade.wall;
  const top = (item.elevation || 0) + (params && typeof params.height === 'number' ? params.height : 0);
  if (!(top > FADE_MIN_TOP)) return null;
  if (item.origin === 'back') return item.exterior ? item.hostWallId : null;
  const w = params && typeof params.width === 'number' ? params.width : 0;
  const d = params && typeof params.depth === 'number' ? params.depth : 0;
  if (!(w > 0 && d > 0)) return null;
  const fp = footprintRect(placement.x, placement.y, placement.rotationDeg, w, d);
  return pickFadeWall(fp, walls || []);
}

/**
 * Put a built group where the item stands. The builder's local frame is
 * metres with the back face at z = 0 and the front facing +z; plan rotation
 * is CLOCKWISE (seen from above, y south) and three.js's rotation.y is
 * anticlockwise, hence the minus: local +z lands on world
 * (sin(-r), cos(-r)) = (-sin r, cos r), the plan front vector.
 */
export function placeGroup(group, placement, tx, tz) {
  group.position.set(tx(placement.x), (placement.elevation || 0) * 0.01, tz(placement.y));
  group.rotation.set(0, -placement.rotationDeg * DEG, 0);
  group.updateMatrixWorld(true);
  return group;
}

/** Start loading every builder the items need. Never rejects. */
export function loadFurnitureModules(items, opts) {
  const types = (items || []).map(i => i.type);
  return loadBuilders(types, opts || {});
}

function disposeBuilt(group) {
  const geos = new Set(), mats = new Set();
  group.traverse(o => {
    if (o.geometry) geos.add(o.geometry);
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
  });
  geos.forEach(g => g.dispose());
  mats.forEach(m => m.dispose());
}

/** Slice length for buildFurnitureSliced (ms of work between yields). */
export const BUILD_SLICE_MS = 8;

/**
 * Build the furniture synchronously from already-loaded builders, in ONE
 * task. The Node tests and anything that wants the whole result at once use
 * this; the live scene uses buildFurnitureSliced, which runs the SAME steps
 * with yields in between (perf budget B2: no furniture task over 50 ms).
 *
 * @param {Object} THREE
 * @param {Array<Object>} items   house.furniture (compiled by house-loader)
 * @param {Map<string,{DEFAULTS, build}>} builders  from loadFurnitureModules
 * @param {Object} opts
 * @param {function} opts.tx  plan x (cm) -> world x (m)
 * @param {function} opts.tz  plan y (cm) -> world z (m)
 * @param {Object} opts.quality  { tier, sunShadow, roomShadowLights }
 * @param {Array<Object>} [opts.walls]  compiled walls, for pickFadeWall
 * @param {number} [opts.roomTriCap]   default PROXY_ROOM_TRI_CAP
 * @param {number} [opts.totalTriCap]  default PROXY_TOTAL_TRI_CAP
 * @param {string} [opts.bucketScope]  'house' (default) or 'room' -- see merge.js
 * @param {string} [opts.proxyScope]   'house' (default: one full + one low proxy) or 'room'
 * @returns {{root, beauty, shadowProxies, byId, warnings, stats, depthPrecompile, materials}}
 */
export function buildFurnitureSync(THREE, items, builders, opts) {
  const steps = furnitureBuildSteps(THREE, items, builders, opts);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/** Hand the main thread back: scheduler.yield, else a message-channel tick, else setTimeout(0). */
export function yieldToMain() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (g.scheduler && typeof g.scheduler.yield === 'function') return g.scheduler.yield();
  if (typeof g.MessageChannel === 'function') {
    return new Promise(resolve => {
      const ch = new g.MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * The same build, TIME-SLICED: the steps run until `opts.sliceMs` (default
 * BUILD_SLICE_MS) of work has passed, then the main thread is handed back
 * (`opts.yieldFn`, default yieldToMain) before the next slice. A step is one
 * item built and flattened, one bucket merged, or one room's shadow proxy,
 * and items are taken room by room, so no slice runs longer than its budget
 * plus one step.
 *
 * `opts.isCancelled()` is asked after every yield. Once it answers true the
 * build stops, frees every geometry it had made, and resolves to null: a
 * scene disposed mid-build gets nothing attached (plan amendment A2).
 *
 * Resolves to the buildFurnitureSync result, whose stats also carry
 * `slices` and `longestSliceMs`.
 */
export async function buildFurnitureSliced(THREE, items, builders, opts) {
  const o = opts || {};
  const budget = o.sliceMs != null ? o.sliceMs : BUILD_SLICE_MS;
  const yieldFn = o.yieldFn || yieldToMain;
  const cancelled = typeof o.isCancelled === 'function' ? o.isCancelled : () => false;
  const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();
  const steps = furnitureBuildSteps(THREE, items, builders, o);
  let slices = 1, longest = 0, longestAt = null, t0 = now();
  for (;;) {
    const r = steps.next();
    if (r.done) {
      if (now() - t0 > longest) { longest = now() - t0; longestAt = 'finish'; }
      r.value.stats.slices = slices;
      r.value.stats.longestSliceMs = Math.round(longest * 10) / 10;
      // The step that ENDED the longest slice -- where to look first if a
      // slice runs long on some device.
      r.value.stats.longestSliceAt = longestAt;
      return r.value;
    }
    const spent = now() - t0;
    if (spent >= budget) {
      if (spent > longest) { longest = spent; longestAt = r.value || null; }
      await yieldFn();
      if (cancelled()) { steps.return(); return null; }
      slices++;
      t0 = now();
    }
  }
}

/**
 * The build as a generator: it yields after every unit of work, and
 * RETURNS the result. Abandoning it part-way (generator.return()) frees
 * every geometry it had made so far.
 */
function* furnitureBuildSteps(THREE, items, builders, opts) {
  const o = opts || {};
  const q = o.quality || {};
  const low = q.tier === 'low';
  const detail = low ? 'low' : 'full';
  // Criterion 5: no proxies on the low tier, and none when nothing would cast.
  const wantProxies = !low && !!(q.sunShadow || q.roomShadowLights);
  const roomCap = o.roomTriCap != null ? o.roomTriCap : PROXY_ROOM_TRI_CAP;
  const totalCap = o.totalTriCap != null ? o.totalTriCap : PROXY_TOTAL_TRI_CAP;
  const warnings = [];
  const warn = m => { warnings.push(m); console.warn('[furniture] ' + m); };

  const byId = {};
  const tagged = [];          // { part, room, fadeWallId }
  const made = [];            // every geometry this build owns, until it returns
  let finished = false;
  const casters = new Map();  // room -> [{ item, builder, params, placement, parts }]
  let skipped = 0;

  function buildPlaced(item, builder, params, placement, det) {
    const group = builder.build(THREE, params, { detail: det });
    if (!group || !group.isObject3D) throw new Error('build() did not return a THREE.Object3D');
    placeGroup(group, placement, o.tx, o.tz);
    const flat = flattenGroup(THREE, group, { label: 'furniture "' + item.id + '" (' + item.type + ')' });
    disposeBuilt(group);
    return flat;
  }

  // Room by room (stable within a room), so a slice boundary falls between
  // rooms as often as the budget allows.
  const order = (items || []).map((item, i) => ({ item, i }));
  const roomRank = new Map();
  order.forEach(e => { if (!roomRank.has(e.item.room)) roomRank.set(e.item.room, roomRank.size); });
  order.sort((a, b) => (roomRank.get(a.item.room) - roomRank.get(b.item.room)) || (a.i - b.i));
  try {
  for (const { item } of order) {
    const builder = builders && builders.get(item.type);
    if (!builder) { skipped++; continue; }   // the registry already warned
    if (low && item.priority === 'minor') { skipped++; continue; }
    const params = Object.assign({}, builder.DEFAULTS, item.params || {});
    const placement = resolvePlacement(item, params);
    let flat;
    try {
      flat = buildPlaced(item, builder, params, placement, detail);
    } catch (e) {
      warn('furniture "' + item.id + '" (' + item.type + ') failed to build: ' +
        (e && e.message ? e.message : e) + ' -- skipped');
      skipped++;
      continue;
    }
    flat.parts.forEach(p => made.push(p.geometry));
    flat.warnings.forEach(warn);
    const fadeWallId = resolveFadeWall(item, params, placement, o.walls);
    const caster = isCaster(item, params);
    let tris = 0;
    flat.parts.forEach(p => {
      tris += p.triangles;
      tagged.push({ part: p, room: item.room, fadeWallId: fadeWallId });
    });
    byId[item.id] = { id: item.id, room: item.room, type: item.type, placement: placement,
      fadeWallId: fadeWallId, caster: caster, triangles: tris, parts: flat.parts.length };
    if (caster && wantProxies) {
      if (!casters.has(item.room)) casters.set(item.room, []);
      casters.get(item.room).push({ item, builder, params, placement, parts: flat.parts });
    }
    yield 'item ' + item.id;
  }

  const materials = createMaterialSet(THREE);
  const beauty = [];
  for (const b of groupBuckets(tagged, o.bucketScope === 'room' ? 'room' : 'house').values()) {
    const mesh = buildBucketMesh(THREE, b, materials);
    made.push(mesh.geometry);
    beauty.push(mesh);
    yield 'bucket ' + b.key.slice(0, 40);
  }

  // ---- Shadow proxies (plan A1, nit 4) ------------------------------------
  const shadowProxies = [];
  const proxyLowRooms = [];
  let depthPrecompile = null;
  let proxyMaterial = null;
  const extraDisposables = [];
  if (wantProxies && casters.size) {
    // Glass and other translucent parts (a beam cone, a globe) cast no
    // opaque shadow.
    const castParts = parts => parts.filter(p => !neverFades(p));
    const triCount = parts => parts.reduce((s, p) => s + p.triangles, 0);
    const rooms = [];
    casters.forEach((entries, room) => {
      const parts = [];
      entries.forEach(e => castParts(e.parts).forEach(p => parts.push(p)));
      rooms.push({ room, entries, parts, tris: triCount(parts), low: false, lowOwned: [] });
    });
    const toLow = r => {
      if (r.low) return;
      const parts = [];
      r.entries.forEach(e => {
        try {
          const flat = buildPlaced(e.item, e.builder, e.params, e.placement, 'low');
          flat.parts.forEach(p => made.push(p.geometry));
          castParts(flat.parts).forEach(p => parts.push(p));
          flat.parts.forEach(p => r.lowOwned.push(p));
        } catch (err) {
          // A builder that builds 'full' but throws on 'low': keep its full parts.
          castParts(e.parts).forEach(p => parts.push(p));
        }
      });
      r.parts = parts;
      r.tris = triCount(parts);
      r.low = true;
    };
    // Per-room cap: a room over it takes its proxy from a 'low' build.
    for (const r of rooms) {
      if (r.tris <= roomCap) continue;
      toLow(r);
      yield 'low proxy build ' + r.room;
      if (r.tris > roomCap) {
        warn('shadow proxy for room "' + r.room + '" is ' + r.tris + ' triangles even at low detail, over the ' +
          roomCap + ' per-room cap -- its builders low detail is not low enough');
      }
    }
    // Total cap: drop the LARGEST remaining full-detail room to 'low' until
    // the total fits or every room is already low.
    let total = rooms.reduce((s, r) => s + r.tris, 0);
    while (total > totalCap) {
      const cand = rooms.filter(r => !r.low).sort((a, b) => b.tris - a.tris)[0];
      if (!cand) break;
      toLow(cand);
      total = rooms.reduce((s, r) => s + r.tris, 0);
    }
    if (total > totalCap) {
      warn('shadow proxies total ' + total + ' triangles, over the ' + totalCap + ' cap even at low detail');
    }
    // Invisible in the beauty pass, so WHICH program draws it there does not
    // matter -- and these are exactly the glow bucket's material settings
    // (vertex-coloured, transparent, front side), so the proxy shares that
    // program instead of compiling one of its own. No colour attribute is
    // needed: WebGL reads a missing attribute as a constant.
    proxyMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false,
      vertexColors: true, transparent: true, opacity: 1 });
    proxyMaterial.userData.furniture = 'proxy';
    // HOUSE-wide proxies by default (task f17a127f): every full-detail room's
    // casters in ONE proxy and every capped (low-detail) room's in another,
    // so a pass draws at most two furniture casters. Per-room proxies drew
    // their neighbours too -- each room SpotLight's frustum takes in about
    // half the house -- which was +50 draws across the ten room passes on
    // the full-house fixture, against a line budget of <= 40. A house-wide
    // proxy is drawn in every pass (its bounds are the house), but the maps
    // only re-render when something invalidates them, never per frame.
    // The per-room caps above still decide WHICH rooms go low.
    // `proxyScope: 'room'` keeps one proxy per room.
    const groups = [];
    if (o.proxyScope === 'room') {
      rooms.forEach(r => groups.push([r]));
    } else {
      const full = rooms.filter(r => !r.low), lowRooms = rooms.filter(r => r.low);
      if (full.length) groups.push(full);
      if (lowRooms.length) groups.push(lowRooms);
    }
    for (const grp of groups) {
      const parts = [];
      grp.forEach(r => r.parts.forEach(p => parts.push(p)));
      const isLow = grp[0].low;
      const names = grp.map(r => r.room);
      if (!parts.length) { grp.forEach(r => r.lowOwned.forEach(p => p.geometry.dispose())); continue; }
      const geo = concatGeometries(THREE, parts, { positionOnly: true });
      made.push(geo);
      const proxy = new THREE.Mesh(geo, proxyMaterial);
      proxy.name = 'furniture-proxy:' + (o.proxyScope === 'room' ? names[0] : (isLow ? 'house-low' : 'house'));
      proxy.castShadow = true;
      proxy.receiveShadow = false;
      proxy.frustumCulled = true;
      if (isLow) {
        // The coarse caster must not sit in front of the full-detail surface
        // it shadows (acne); push its depth away from the light. The packing
        // MUST match three's own shadow depth material, or every shadow read
        // of this caster decodes garbage (plan review nit 1).
        proxy.customDepthMaterial = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2
        });
        extraDisposables.push(proxy.customDepthMaterial);
        names.forEach(n => proxyLowRooms.push(n));
      }
      const tris = grp.reduce((n, r) => n + r.tris, 0);
      proxy.userData = { furniture: 'proxy', room: names.length === 1 ? names[0] : null, rooms: names,
        detail: isLow ? 'low' : 'full', triangles: tris };
      shadowProxies.push(proxy);
      // The low build exists only for this proxy, which has copied it.
      grp.forEach(r => r.lowOwned.forEach(p => p.geometry.dispose()));
      yield 'proxy ' + proxy.name;
    }
    // What precompiles the shadow DEPTH program. renderer.compile() builds
    // only beauty programs; the shadow pass draws every caster with a depth
    // material whose side is flipped (FrontSide -> BackSide) and into a
    // render target. A MeshDepthMaterial with three's own RGBA packing and
    // BackSide, compiled while a render target is bound, has the same program
    // key as both the shadow map's internal depth material and any
    // customDepthMaterial above (polygon offset is GL state, not a define).
    if (shadowProxies.length) {
      const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.BackSide });
      depthPrecompile = new THREE.Mesh(shadowProxies[0].geometry, m);
      depthPrecompile.name = 'furniture-depth-precompile';
      extraDisposables.push(m);
    }
  }

  // Part geometries were copied into the buckets; free the copies.
  tagged.forEach(t => t.part.geometry.dispose());

  const root = new THREE.Group();
  root.name = 'furniture';
  beauty.forEach(m => root.add(m));
  shadowProxies.forEach(m => root.add(m));

  let beautyTris = 0, proxyTris = 0;
  beauty.forEach(m => { beautyTris += m.userData.triangles; });
  shadowProxies.forEach(m => { proxyTris += m.userData.triangles; });
  const stats = {
    items: Object.keys(byId).length,
    skipped: skipped,
    beautyDraws: beauty.length,
    proxyDraws: shadowProxies.length,
    beautyTriangles: beautyTris,
    proxyTriangles: proxyTris,
    proxyLowRooms: proxyLowRooms,
    detail: detail
  };
  if (proxyMaterial) extraDisposables.push(proxyMaterial);
  const result = { root, beauty, shadowProxies, byId, warnings, stats, depthPrecompile,
    materials: materials.all, extraDisposables: extraDisposables.concat(materials.textures) };
  finished = true;
  return result;
  } finally {
    // Abandoned part-way (a cancelled sliced build): free what was made.
    if (!finished) made.forEach(g => g.dispose());
  }
}

/**
 * The async form: load the builders (unless `opts.builders` is given), then
 * build, time-sliced. Resolves to the same shape as buildFurnitureSync (or
 * null if `opts.isCancelled` answered true part-way).
 */
export async function buildFurniture(THREE, items, opts) {
  const o = opts || {};
  const builders = o.builders || await loadFurnitureModules(items, o.loadOpts);
  return buildFurnitureSliced(THREE, items, builders, o);
}

/**
 * The fade registrations the scene should make: every beauty bucket with a
 * fade wall, EXCEPT glass and anything translucent (plan A3 -- the fade loop
 * would drive them to opacity 1). merge.js already never gives glass a fade wall; this is the
 * second lock, at the point of registration.
 * @returns {Array<{mesh, wallId}>}
 */
export function fadeRegistrations(result) {
  const out = [];
  (result && result.beauty || []).forEach(mesh => {
    const wallId = mesh.userData.fadeWallId;
    if (wallId == null) return;
    if (mesh.userData.finish === 'glass') return;
    if (mesh.userData.translucent) return;
    if (mesh.material && mesh.material.userData && mesh.material.userData.finish === 'glass') return;
    out.push({ mesh, wallId });
  });
  return out;
}

/**
 * The attach sequence (plan amendment A2, review nits 2 and 3), kept here as
 * a pure function of its collaborators so the Node tests drive the exact
 * code the scene runs.
 *
 *   1. Wait for BOTH the scene's own precompile (`precompileDone`: the
 *      existing chain AFTER its catch/restore, so it always resolves) and the
 *      builder modules.
 *   2. Build, unless the scene was disposed meanwhile.
 *   3. Compile the furniture's programs BEFORE it is ever drawn:
 *      compileAsync(root, cam, scene) with shadowMap.enabled set as the
 *      scene's precompile sets it (and restored afterwards, as that one
 *      restores it), plus the shadow DEPTH program, which compile() never
 *      builds on its own -- compiled with a render target bound, because the
 *      shadow pass draws into one and that changes the program key.
 *   4. Attach, unless the scene was disposed meanwhile -- in which case every
 *      furniture geometry and material is freed instead.
 *
 * Furniture never delays onReady or the house's own precompile. A failure
 * anywhere is a console warning and a house without furniture, never an
 * unhandled rejection.
 *
 * @param {Object} ctx
 * @param {Promise} ctx.precompileDone
 * @param {Promise<Map>} ctx.modulesLoaded
 * @param {function(): boolean} ctx.isDisposed
 * @param {function(Map): (Object|Promise<?Object>)} ctx.build   builders -> a build result, or a
 *          promise of one (the sliced build); null means "cancelled, nothing to attach"
 * @param {Object} ctx.renderer   WebGLRenderer (or a test double)
 * @param {Object} ctx.camera
 * @param {Object} ctx.scene
 * @param {boolean} ctx.wantShadows
 * @param {function(): Object} [ctx.makeRenderTarget]  a 1x1 WebGLRenderTarget
 * @param {function(Object)} ctx.attach   adds result.root to the scene
 * @returns {Promise<?Object>} the attached result, or null
 */
export function scheduleFurnitureAttach(ctx) {
  const ren = ctx.renderer;
  const warn = (msg, e) => console.warn('[Home3DScene] ' + msg, e);
  return Promise.all([ctx.precompileDone, ctx.modulesLoaded])
    .then(([, builders]) => (ctx.isDisposed() ? null : ctx.build(builders)))
    .then(result => {
      if (!result) return null;
      if (ctx.isDisposed()) { disposeFurniture(result); return null; }
      const shadowWasEnabled = ren.shadowMap.enabled;
      ren.shadowMap.enabled = ctx.wantShadows;
      let compiled;
      if (typeof ren.compileAsync === 'function') {
        const jobs = [Promise.resolve().then(() => ren.compileAsync(result.root, ctx.camera, ctx.scene))];
        if (result.depthPrecompile && ctx.wantShadows && typeof ctx.makeRenderTarget === 'function') {
          jobs.push(Promise.resolve().then(() => {
            const prev = ren.getRenderTarget();
            const rt = ctx.makeRenderTarget();
            let p;
            try {
              ren.setRenderTarget(rt);
              p = ren.compileAsync(result.depthPrecompile, ctx.camera, ctx.scene);
            } finally {
              ren.setRenderTarget(prev);
            }
            return Promise.resolve(p).then(() => rt.dispose(), e => { rt.dispose(); throw e; });
          }));
        }
        compiled = Promise.all(jobs);
      } else {
        compiled = Promise.resolve();
      }
      return compiled
        .catch(e => warn('furniture precompile failed; compiling on first draw.', e))
        .then(() => {
          ren.shadowMap.enabled = shadowWasEnabled;
          if (ctx.isDisposed()) { disposeFurniture(result); return null; }
          ctx.attach(result);
          return result;
        });
    })
    .catch(e => { warn('furniture could not be built or attached; the house renders without it.', e); return null; });
}

/** Free every geometry and material the furniture owns, and detach it. */
export function disposeFurniture(result) {
  if (!result) return;
  const geos = new Set();
  if (result.root) {
    result.root.traverse(o => { if (o.geometry) geos.add(o.geometry); });
    if (result.root.parent) result.root.parent.remove(result.root);
  }
  geos.forEach(g => g.dispose());
  if (result.materials) result.materials.forEach(m => m.dispose());
  (result.extraDisposables || []).forEach(m => m.dispose());
}
