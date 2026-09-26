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
import { flattenGroup, buildBuckets, createMaterialSet, concatGeometries, neverFades } from './furniture/merge.js';

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

/**
 * Build the furniture synchronously from already-loaded builders.
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
 * @returns {{root, beauty, shadowProxies, byId, warnings, stats, depthPrecompile, materials}}
 */
export function buildFurnitureSync(THREE, items, builders, opts) {
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

  (items || []).forEach(item => {
    const builder = builders && builders.get(item.type);
    if (!builder) { skipped++; return; }   // the registry already warned
    if (low && item.priority === 'minor') { skipped++; return; }
    const params = Object.assign({}, builder.DEFAULTS, item.params || {});
    const placement = resolvePlacement(item, params);
    let flat;
    try {
      flat = buildPlaced(item, builder, params, placement, detail);
    } catch (e) {
      warn('furniture "' + item.id + '" (' + item.type + ') failed to build: ' +
        (e && e.message ? e.message : e) + ' -- skipped');
      skipped++;
      return;
    }
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
  });

  const materials = createMaterialSet(THREE);
  const beauty = buildBuckets(THREE, tagged, materials);

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
    rooms.forEach(r => {
      if (r.tris <= roomCap) return;
      toLow(r);
      if (r.tris > roomCap) {
        warn('shadow proxy for room "' + r.room + '" is ' + r.tris + ' triangles even at low detail, over the ' +
          roomCap + ' per-room cap -- its builders low detail is not low enough');
      }
    });
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
    proxyMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    proxyMaterial.userData.furniture = 'proxy';
    rooms.forEach(r => {
      if (!r.parts.length) { r.lowOwned.forEach(p => p.geometry.dispose()); return; }
      const geo = concatGeometries(THREE, r.parts, { positionOnly: true });
      const proxy = new THREE.Mesh(geo, proxyMaterial);
      proxy.name = 'furniture-proxy:' + r.room;
      proxy.castShadow = true;
      proxy.receiveShadow = false;
      proxy.frustumCulled = true;
      if (r.low) {
        // The coarse caster must not sit in front of the full-detail surface
        // it shadows (acne); push its depth away from the light. The packing
        // MUST match three's own shadow depth material, or every shadow read
        // of this caster decodes garbage (plan review nit 1).
        proxy.customDepthMaterial = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2
        });
        extraDisposables.push(proxy.customDepthMaterial);
        proxyLowRooms.push(r.room);
      }
      proxy.userData = { furniture: 'proxy', room: r.room, detail: r.low ? 'low' : 'full', triangles: r.tris };
      shadowProxies.push(proxy);
      // The low build exists only for this proxy, which has copied it.
      r.lowOwned.forEach(p => p.geometry.dispose());
    });
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
  return { root, beauty, shadowProxies, byId, warnings, stats, depthPrecompile,
    materials: materials.all, extraDisposables };
}

/**
 * The async form: load the builders (unless `opts.builders` is given), then
 * build. Resolves to the same shape as buildFurnitureSync.
 */
export async function buildFurniture(THREE, items, opts) {
  const o = opts || {};
  const builders = o.builders || await loadFurnitureModules(items, o.loadOpts);
  return buildFurnitureSync(THREE, items, builders, o);
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
 * @param {function(Map): Object} ctx.build   builders -> buildFurnitureSync result
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
