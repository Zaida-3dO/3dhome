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
import { flattenGroup, groupBuckets, buildBucketMesh, createMaterialSet, concatGeometries, isTranslucent } from './furniture/merge.js';

/** An item casts (through its room's proxy) when it stands on the floor and is tall enough to matter. */
export const CASTER_MAX_ELEVATION = 30;   // cm: elevation must be BELOW this
export const CASTER_MIN_HEIGHT = 40;      // cm: height must be AT LEAST this
/** `fade: "auto"` only considers a FREE item whose top is above this (cm); a wall-anchored one always fades with its exterior host wall. */
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
 *   fade: "auto"      -> a WALL-ANCHORED item fades with its host wall if
 *                        that wall is exterior, WHATEVER its height (task
 *                        f7324d3f: a floating shelf 84 cm up, top 89, stayed
 *                        standing when its wall faded while the two above it
 *                        went with it -- and so would a 90 cm base run).
 *                        A FREE item only when elevation + height >
 *                        FADE_MIN_TOP, with pickFadeWall() over its footprint.
 *
 * A corner unit belongs to the run that owns the corner and so fades with
 * that run's host wall -- which is exactly what the wall anchor gives it.
 */
export function resolveFadeWall(item, params, placement, walls) {
  if (item.fade === 'never') return null;
  if (item.fade && typeof item.fade === 'object' && item.fade.wall != null) return item.fade.wall;
  // Mounted on the wall: it goes exactly when the wall goes. No height gate.
  if (item.origin === 'back') return item.exterior ? item.hostWallId : null;
  const top = (item.elevation || 0) + (params && typeof params.height === 'number' ? params.height : 0);
  if (!(top > FADE_MIN_TOP)) return null;
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

/**
 * The furniture item whose world box contains `point` ({x, y, z}, metres),
 * from a build result's byId, grown by `pad` metres (default 1 cm) so a hit
 * exactly on a face counts. The SMALLEST containing box wins, so a robot on
 * a rug, or a lamp on a table, is found rather than what it stands on.
 * Returns { id, type } or null. Only items in `onlyIds` (a Set) when given.
 */
export function furnitureItemAt(byId, point, onlyIds, pad) {
  if (!byId || !point) return null;
  const p = pad == null ? 0.01 : pad;
  let best = null, bestVol = Infinity;
  Object.keys(byId).forEach(id => {
    if (onlyIds && !onlyIds.has(id)) return;
    const b = byId[id].worldBox;
    if (!b) return;
    if (point.x < b.min[0] - p || point.x > b.max[0] + p || point.y < b.min[1] - p || point.y > b.max[1] + p ||
      point.z < b.min[2] - p || point.z > b.max[2] + p) return;
    const vol = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
    if (vol < bestVol) { bestVol = vol; best = { id, type: byId[id].type }; }
  });
  return best;
}

/** How long one builder's prepare() may take before the build goes ahead without it (ms). */
export const PREPARE_TIMEOUT_MS = 15000;

/**
 * Start loading every builder the items need, then let any builder that
 * exports prepare(items, ctx) fetch its assets (model.js loads its .glb
 * files here). All of it happens BEFORE the first build slice and in
 * parallel with the scene's precompile, so build() stays synchronous and
 * the network never lands inside a slice. Never rejects: a prepare() that
 * throws or hangs is a warning, and its items fail (and are skipped) at
 * build time.
 */
export async function loadFurnitureModules(items, opts) {
  const o = opts || {};
  const list = items || [];
  const builders = await loadBuilders(list.map(i => i.type), o);
  const timeout = o.prepareTimeoutMs != null ? o.prepareTimeoutMs : PREPARE_TIMEOUT_MS;
  const jobs = [];
  builders.forEach((b, type) => {
    if (typeof b.prepare !== 'function') return;
    const mine = list.filter(i => i.type === type);
    let t;
    const timer = new Promise(resolve => { t = setTimeout(() => resolve('timeout'), timeout); });
    jobs.push(Promise.race([
      Promise.resolve().then(() => b.prepare(mine, o.prepareCtx || {})),
      timer
    ]).then(r => {
      if (r === 'timeout') console.warn('[furniture] type "' + type + '": prepare() took longer than ' + timeout + ' ms -- building without it');
    }, e => {
      console.warn('[furniture] type "' + type + '": prepare() failed: ' + (e && e.message ? e.message : e));
    }).finally(() => clearTimeout(t)));
  });
  await Promise.all(jobs);
  return builders;
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
  const dynamicGroups = [];   // { itemId, type, group } -- see buildPlaced
  let finished = false;
  const casters = new Map();  // room -> [{ item, builder, params, placement, parts }]
  let skipped = 0;

  // A dynamic part (userData.dynamic -- a clock's hands, an LED strip
  // segment) is pulled OUT of its builder's group before that group is
  // disposed, and re-parented into a small per-item wrapper positioned
  // exactly like placeGroup positions the builder's own group (so its world
  // transform is unchanged: THREE.Object3D#attach re-parents while
  // preserving world position/rotation/scale). The wrapper -- not the
  // dynamic mesh itself -- is what the scene attaches, so the mesh keeps
  // following the item's placement without needing its own copy of the
  // placement math.
  function buildPlaced(item, builder, params, placement, det) {
    // assetBase: the profile directory, for a type that loads a file from it.
    const group = builder.build(THREE, params, { detail: det, assetBase: item.assetBase });
    if (!group || !group.isObject3D) throw new Error('build() did not return a THREE.Object3D');
    placeGroup(group, placement, o.tx, o.tz);
    // The placed item's world box (metres), kept on byId so a tap on the
    // merged buckets can still name the item it landed on (home3d-scene's
    // furnitureItemAt -- how a bound robot vacuum is clicked).
    const wb = new THREE.Box3().setFromObject(group);
    const worldBox = wb.isEmpty() ? null : { min: wb.min.toArray(), max: wb.max.toArray() };
    const flat = flattenGroup(THREE, group, { label: 'furniture "' + item.id + '" (' + item.type + ')' });
    let dynamicGroup = null;
    if (flat.dynamic.length) {
      dynamicGroup = new THREE.Group();
      dynamicGroup.name = 'furniture-dynamic:' + item.id;
      dynamicGroup.position.copy(group.position);
      dynamicGroup.rotation.copy(group.rotation);
      dynamicGroup.updateMatrixWorld(true);
      flat.dynamic.forEach(mesh => dynamicGroup.attach(mesh));
      dynamicGroup.userData = { furniture: 'dynamic', itemId: item.id, type: item.type };
    }
    disposeBuilt(group);
    return { parts: flat.parts, warnings: flat.warnings, dynamicGroup: dynamicGroup, worldBox: worldBox };
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
      fadeWallId: fadeWallId, caster: caster, triangles: tris, parts: flat.parts.length,
      dynamicParts: flat.dynamicGroup ? flat.dynamicGroup.children.length : 0, worldBox: flat.worldBox };
    if (caster && wantProxies) {
      if (!casters.has(item.room)) casters.set(item.room, []);
      casters.get(item.room).push({ item, builder, params, placement, parts: flat.parts });
    }
    if (flat.dynamicGroup) {
      // A dynamic part sits OUTSIDE every merge bucket (that is the whole
      // point of userData.dynamic), so it never went through
      // materials.forFade() -- the fade loop would otherwise never touch
      // it, and a clock's hands would float fully opaque over their own
      // faded host wall (found in code review, item 059873ed finding F1).
      // Fixed generically here, not in wall-clock.js, so any future
      // dynamic part (the desk LED strip, item 816d71ee) inherits it: mark
      // each dynamic mesh's OWN material transparent (each already has its
      // own material instance -- see addHands' mat/mat.clone() split, no
      // two dynamic meshes on one item share one material object, so this
      // cannot leak opacity onto an unrelated mesh), and carry the item's
      // own fadeWallId alongside the group so the caller can register it
      // exactly like a beauty bucket.
      if (fadeWallId != null) {
        flat.dynamicGroup.traverse(o => {
          if (!o.isMesh || !o.material) return;
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
            m.transparent = true;
            m.userData = Object.assign({}, m.userData, { fade: true });
          });
        });
      }
      dynamicGroups.push({ itemId: item.id, type: item.type, group: flat.dynamicGroup, fadeWallId: fadeWallId });
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
    const castParts = parts => parts.filter(p => !isTranslucent(p));
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
          // This low-detail rebuild is ONLY for the shadow proxy (an
          // invisible, position-only geometry) -- its own dynamic parts (a
          // second set of clock hands, say) are never attached to the scene
          // and must be freed here, or they leak: disposeBuilt() already
          // skipped them (buildPlaced re-parented them out of the disposed
          // group before that call), precisely so the ATTACHED build's
          // dynamic parts survive; this discarded low-detail build has no
          // such attachment coming, so it disposes its own.
          if (flat.dynamicGroup) disposeBuilt(flat.dynamicGroup);
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
  // Dynamic parts (item 059873ed / 816d71ee): each item's small wrapper
  // group, holding the meshes merge.js excluded from every bucket, added
  // to the scene graph as its own draws so it can keep being posed after
  // the house is built (a clock's hands, an LED strip segment).
  const dynamicByItemId = {};
  dynamicGroups.forEach(({ itemId, type, group, fadeWallId }) => {
    root.add(group);
    dynamicByItemId[itemId] = { itemId, type, group, fadeWallId };
  });

  let beautyTris = 0, proxyTris = 0, dynamicTris = 0, dynamicDraws = 0;
  beauty.forEach(m => { beautyTris += m.userData.triangles; });
  shadowProxies.forEach(m => { proxyTris += m.userData.triangles; });
  dynamicGroups.forEach(({ group }) => {
    group.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      dynamicDraws++;
      const idx = o.geometry.index;
      dynamicTris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
    });
  });
  const stats = {
    items: Object.keys(byId).length,
    skipped: skipped,
    beautyDraws: beauty.length,
    proxyDraws: shadowProxies.length,
    beautyTriangles: beautyTris,
    proxyTriangles: proxyTris,
    proxyLowRooms: proxyLowRooms,
    detail: detail,
    // Every dynamic part is its OWN permanent draw call (merge.js's own
    // header note: never amortised by the merge), so this is the direct
    // cost of every item.js's dynamic parts across the house -- worth
    // watching against perf-audit-furniture.md's draw budget as more
    // builders adopt userData.dynamic.
    dynamicDraws: dynamicDraws,
    dynamicTriangles: dynamicTris
  };
  if (proxyMaterial) extraDisposables.push(proxyMaterial);
  const result = { root, beauty, shadowProxies, dynamicByItemId, byId, warnings, stats, depthPrecompile,
    materials: materials.all, extraDisposables: extraDisposables.concat(materials.textures) };
  finished = true;
  return result;
  } finally {
    // Abandoned part-way (a cancelled sliced build): free what was made.
    if (!finished) {
      made.forEach(g => g.dispose());
      dynamicGroups.forEach(({ group }) => disposeBuilt(group));
    }
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
 * fade wall, glass and translucent ones included (task f7324d3f: everything
 * mounted on a wall goes with it). Each carries the opacity and depthWrite
 * the fade returns to (`baseOpacity`, `baseDepthWrite`, recorded by merge.js's
 * forFade clone). The lock that replaces plan A3's: a glass or translucent
 * mesh WITHOUT a recorded base opacity is refused, since the loop would drive
 * it back to 1.0 and turn it solid.
 *
 * ALSO covers dynamic parts (item 059873ed finding F1): a dynamic mesh sits
 * outside every merge bucket, so it is never in `result.beauty` and was
 * previously invisible to this function entirely -- a clock's hands stayed
 * fully opaque while their own host wall faded out around them. Each
 * dynamic mesh on an item with a fadeWallId was already marked
 * `transparent = true` at build time (buildPlaced, furnitureBuildSteps), so
 * registering it here is enough for the existing fade loop to drive its
 * opacity exactly like a beauty bucket's. Every dynamic part TODAY is
 * opaque (a clock's matte hands), so this records `baseOpacity: 1,
 * baseDepthWrite: true` explicitly -- the same "safe, fully-opaque" base
 * task f7324d3f's own glass/translucent lock exists to require, rather than
 * leaving these two fields `undefined` and relying on wallFadeTarget's/
 * wallFadeDepthWrite's `base == null -> 1` fallback to happen to land on
 * the same number. A translucent dynamic part (a future LED diffuser, item
 * 816d71ee) would still need this reworked to record its OWN real base
 * rather than the hardcoded 1 here -- tracked separately as c333108d, not
 * fixed in this PR, since no dynamic part is translucent today.
 * @returns {Array<{mesh, wallId, baseOpacity, baseDepthWrite}>}
 */
export function fadeRegistrations(result) {
  const out = [];
  (result && result.beauty || []).forEach(mesh => {
    const wallId = mesh.userData.fadeWallId;
    if (wallId == null) return;
    const mud = (mesh.material && mesh.material.userData) || {};
    const see = mesh.userData.finish === 'glass' || !!mesh.userData.translucent || mud.finish === 'glass';
    const recorded = typeof mud.baseOpacity === 'number';
    if (see && !recorded) return;
    out.push({ mesh, wallId, baseOpacity: recorded ? mud.baseOpacity : 1, baseDepthWrite: mud.baseDepthWrite !== false });
  });
  Object.keys(result && result.dynamicByItemId || {}).forEach(itemId => {
    const dyn = result.dynamicByItemId[itemId];
    if (dyn.fadeWallId == null) return;
    dyn.group.traverse(o => {
      if (!o.isMesh || !o.material) return;
      out.push({ mesh: o, wallId: dyn.fadeWallId, baseOpacity: 1, baseDepthWrite: true });
    });
  });
  return out;
}

/**
 * The opacity a registered wall-fade mesh eases toward: 0.05 of its base
 * when its wall faces the camera (dot of the wall's outward normal with the
 * view direction below -0.3), its base otherwise. `base` is 1 for walls,
 * fittings and opaque furniture, and a translucent bucket's own opacity.
 */
export function wallFadeTarget(dot, base) {
  const b = base == null ? 1 : base;
  return (dot < -0.3 ? 0.05 : 1.0) * b;
}

/**
 * Whether a registered wall-fade mesh writes depth at `opacity`. An opaque
 * one writes only while effectively solid (the acoustic-slat black-half fix);
 * a translucent one keeps its builder's depthWrite at its base and never
 * writes while fading.
 */
export function wallFadeDepthWrite(opacity, base, baseDepthWrite) {
  const b = base == null ? 1 : base;
  if (b < 1) return baseDepthWrite !== false && opacity > b * 0.98;
  return opacity > 0.98;
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

/**
 * Free every geometry and material the furniture owns, and detach it.
 *
 * Materials are collected by traversing `result.root` rather than trusting
 * only `result.materials` (the bucket materials from createMaterialSet):
 * a dynamic part (userData.dynamic -- a clock's hands, an LED strip
 * segment) keeps its OWN builder-made material, never folded into a bucket,
 * so it is not in `result.materials` at all and would otherwise leak. The
 * traversal also re-visits every bucket mesh's material, which is already
 * in `result.materials` -- harmless, since both are collected into the same
 * Set before disposing.
 *
 * Any live clock (or other per-item ticker) on a dynamic part must be
 * stopped by the CALLER before this runs (see home3d-scene.js's
 * stopLiveClocks(), called from dispose() immediately before this function)
 * -- disposeFurniture only frees three.js resources, it does not know which
 * dynamic groups were animated or how to stop them.
 */
export function disposeFurniture(result) {
  if (!result) return;
  const geos = new Set();
  const mats = new Set();
  if (result.root) {
    result.root.traverse(o => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
    });
    if (result.root.parent) result.root.parent.remove(result.root);
  }
  geos.forEach(g => g.dispose());
  // Textures the bucket materials carry (a model's map, a sign's canvas):
  // dispose() only frees the GPU copy, and three re-uploads a texture that
  // is used again, so a texture shared with a later scene stays valid.
  // Collected from `mats` (the FULL traversal set, not just
  // result.materials -- the narrower set of bucket materials) so a dynamic
  // part's own texture (a future textured LED segment, say) is freed too,
  // for the same reason `mats` itself was widened from result.materials in
  // item 059873ed's round-3 fix: result.materials only ever holds bucket
  // materials, and a dynamic part's material is never bucketed.
  const texs = new Set();
  mats.forEach(m => {
    for (const k in m) { const v = m[k]; if (v && v.isTexture) texs.add(v); }
    m.dispose();
  });
  (result.extraDisposables || []).forEach(m => m.dispose());
  texs.forEach(t => t.dispose());
}
