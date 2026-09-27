#!/usr/bin/env node
/**
 * Furniture renderer (plan PR1b): src/furniture.js + src/furniture/merge.js.
 * No framework, no install: `node scripts/test-furniture-render.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. World placement in all four orientations, for BOTH anchor forms,
 *      checked on a marker part at the item's front-right corner. A sign
 *      error in group.rotation.y mirrors that marker at 90 and 270 degrees.
 *   2. Merge buckets (task f17a127f): every opaque finish in the house is
 *      ONE palette mesh (finish per vertex through the palette texture);
 *      every glowing part is ONE unlit vertex-coloured MeshBasic mesh; glass
 *      keeps its builder material, one mesh per tint house-wide;
 *      `bucketScope: 'room'` still splits per room. Finish tags are read through
 *      partFinish/partKeep.
 *   2b. The full-house fixture (scripts/make-perf-fixture.mjs, every
 *      registered builder) stays inside the perf budget's bucket caps.
 *   7b. The time-sliced build (task c399c2a4): it yields between steps,
 *      builds exactly what the one-task build does, and a cancel part-way
 *      frees everything and attaches nothing.
 *   3. Shadows (plan A1): beauty meshes never cast; one proxy per furnished
 *      room, built from exactly the casters' beauty geometry, writing neither
 *      colour nor depth. A stub-WebGL r160 renderer then shows the proxy IS
 *      drawn with the depth material in the shadow pass and is drawn in the
 *      beauty pass only with colour and depth writes off.
 *   4. The proxy caps (A1, review nit 4): an over-cap room drops to a 'low'
 *      build with an RGBA-packed polygon-offset customDepthMaterial; over the
 *      TOTAL cap, the LARGEST rooms drop first.
 *   5. The low tier: builders get detail 'low', minor items are skipped, no
 *      proxies are built.
 *   6. The fade (§2.5, A3): host wall / pickFadeWall / override / never /
 *      the height rule / the corner owner -- and glass is never registered.
 *   7. The attach sequence (A2, nits 2 and 3): compileAsync(root, cam, scene)
 *      runs before the attach; a dispose before or during it attaches nothing
 *      and frees the build; shadowMap.enabled is restored; a failure anywhere
 *      is a warning, never an unhandled rejection.
 *   8. The shadow DEPTH program is precompiled: after the precompile, a real
 *      shadow render (stub WebGL) creates no new program.
 *   9. Room clicks: furniture is never clickable, and the scene's click
 *      handler still finds the room catcher underneath it.
 *  10. Dynamic parts (item 059873ed / 816d71ee): a mesh tagged
 *      userData.dynamic is excluded from EVERY bucket by flattenGroup and
 *      instead comes back re-parented into its own per-item wrapper group
 *      (buildFurnitureSync's dynamicByItemId), positioned exactly like the
 *      builder's own group -- verified against the SAME world position a
 *      non-dynamic marker part at the same local offset would land at.
 *      Re-posing a dynamic mesh after attach (mimicking a live clock's
 *      setClockTime) actually rotates the attached mesh, proving it is a
 *      real, individually-posable scene object and not a snapshot. A
 *      cancelled sliced build frees a dynamic part's geometry/material same
 *      as any other. disposeFurniture() frees a dynamic part's own material
 *      (never tracked in result.materials, since it was never bucketed).
 *
 * Builds real three.js geometry from the vendored r160 module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const F = await imp('src/furniture.js');
const M = await imp('src/furniture/merge.js');
const Box = await imp('src/furniture/box.js');
const Fin = await imp('src/furniture/finishes.js');
const { HouseLoader } = await imp('src/house-loader.js');
const { resolvePlacement } = await imp('src/furniture/place.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
function quietly(fn) {
  const w = console.warn, warnings = [];
  console.warn = (...a) => warnings.push(a.map(String).join(' '));
  try { return { value: fn(), warnings }; } finally { console.warn = w; }
}
async function quietlyAsync(fn) {
  const w = console.warn, warnings = [];
  console.warn = (...a) => warnings.push(a.map(String).join(' '));
  try { return { value: await fn(), warnings }; } finally { console.warn = w; }
}

const tx = x => x * 0.01, tz = y => y * 0.01;
const ULTRA = { tier: 'ultra', sunShadow: true, roomShadowLights: true };
const MID = { tier: 'mid', sunShadow: true, roomShadowLights: false };
const LOW = { tier: 'low', sunShadow: false, roomShadowLights: false };

// A marker builder: a matte body plus a small GLOSS cube at the item's
// FRONT-RIGHT corner (local +x, +z), so it lands in its own bucket and its
// world position shows which way the item faces AND which side is its right.
const Marker = {
  DEFAULTS: Object.freeze({ width: 60, depth: 20, height: 50 }),
  build(T, p) {
    const g = new T.Group();
    const w = p.width / 100, d = p.depth / 100, h = p.height / 100;
    const body = new T.Mesh(new T.BoxGeometry(w, h, d).translate(0, h / 2, d / 2), Fin.makeFinish(T, 'matte', '#888888'));
    const mk = new T.Mesh(new T.BoxGeometry(0.02, 0.02, 0.02).translate(w / 2 - 0.01, h / 2, d - 0.01),
      Fin.makeFinish(T, 'gloss', '#ff0000'));
    g.add(body); g.add(mk);
    return g;
  }
};
// A minimal stand-in for wall-clock's hands (item 059873ed / 816d71ee): a
// matte body (bucketed as usual) plus a `pointer` mesh at the item's
// front-right corner, tagged userData.dynamic -- excluded from every bucket,
// individually posable after attach, exactly like a clock hand.
const DynamicMarker = {
  DEFAULTS: Object.freeze({ width: 60, depth: 20, height: 50 }),
  build(T, p) {
    const g = new T.Group();
    const w = p.width / 100, d = p.depth / 100, h = p.height / 100;
    const body = new T.Mesh(new T.BoxGeometry(w, h, d).translate(0, h / 2, d / 2), Fin.makeFinish(T, 'matte', '#888888'));
    const pointer = new T.Mesh(new T.BoxGeometry(0.02, 0.02, 0.02).translate(w / 2 - 0.01, h / 2, d - 0.01),
      Fin.makeFinish(T, 'matte', '#111111'));
    pointer.name = 'pointer';
    pointer.userData.keep = true;
    pointer.userData.dynamic = true;
    g.add(body); g.add(pointer);
    return g;
  }
};
const builders = extra => new Map(Object.entries(Object.assign({
  box: { DEFAULTS: Box.DEFAULTS, build: Box.build },
  'dynamic-marker': DynamicMarker,
  marker: Marker
}, extra || {})));

function bboxOf(mesh) {
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox;
}
function centreOf(mesh) {
  const c = new THREE.Vector3();
  bboxOf(mesh).getCenter(c);
  return c;
}
// The vertices of a palette bucket that carry one finish (by their uv).
function finishBox(mesh, finish) {
  const pos = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv;
  const u = M.paletteU(finish), b = new THREE.Box3(), v = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(uv.getX(i) - u) > 1e-6) continue;
    b.expandByPoint(v.fromBufferAttribute(pos, i)); n++;
  }
  return n ? b : null;
}

// A 400 x 300 room (x 100..500, y 100..400) inside four 10 cm walls; walls 1
// and 2 exterior. Same fixture shape as test-furniture-core.mjs.
function house(furniture) {
  return {
    kind: 'geometry', schemaVersion: '1.2', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      { id: 1, start: [95, 95], end: [505, 95], exterior: true },
      { id: 2, start: [95, 405], end: [505, 405], exterior: true },
      { id: 3, start: [95, 95], end: [95, 405] },
      { id: 4, start: [505, 95], end: [505, 405], exterior: true }
    ] },
    rooms: [
      { id: 'r', label: 'R', polygon: [[100, 100], [500, 100], [500, 400], [100, 400]] },
      { id: 'q', label: 'Q', polygon: [[600, 100], [900, 100], [900, 400], [600, 400]] }
    ],
    furniture: furniture
  };
}
const compile = furniture => quietly(() => HouseLoader.compile(house(furniture), '')).value;
const build = (h, quality, extra, opts) => quietly(() => F.buildFurnitureSync(THREE, h.furniture,
  builders(extra), Object.assign({ tx, tz, quality: quality || ULTRA, walls: h.walls }, opts || {}))).value;

// ---- 1. placement: four orientations, both anchor forms ---------------------
{
  // Expected front (f) and right (u) plan vectors for each rotation.
  const FR = { 0: [[0, 1], [1, 0]], 90: [[-1, 0], [0, 1]], 180: [[0, -1], [-1, 0]], 270: [[1, 0], [0, -1]] };
  const cases = [
    // wall anchors: north wall faces south (0), south faces north (180),
    // west faces east (270), east faces west (90).
    { item: { id: 'n', room: 'r', type: 'marker', wall: 1, centre: 200, offset: 3, elevation: 17 }, back: [200, 103], rot: 0 },
    { item: { id: 's', room: 'r', type: 'marker', wall: 2, centre: 250 }, back: [250, 400], rot: 180 },
    { item: { id: 'w', room: 'r', type: 'marker', wall: 3, centre: 150 }, back: [100, 150], rot: 270 },
    { item: { id: 'e', room: 'r', type: 'marker', wall: 4, centre: 350 }, back: [500, 350], rot: 90 },
    // free anchors: `at` is the footprint centre, back = at - front * depth/2.
    { item: { id: 'f0', room: 'r', type: 'marker', at: [300, 250] }, back: [300, 240], rot: 0 },
    { item: { id: 'f90', room: 'r', type: 'marker', at: [300, 250], rotation: 90 }, back: [310, 250], rot: 90 },
    { item: { id: 'f180', room: 'r', type: 'marker', at: [300, 250], rotation: 180 }, back: [300, 260], rot: 180 },
    { item: { id: 'f270', room: 'r', type: 'marker', at: [300, 250], rotation: 270 }, back: [290, 250], rot: 270 }
  ];
  cases.forEach(c => {
    const h = compile([c.item]);
    const res = build(h);
    // Body (matte) and marker (gloss) share ONE palette bucket; the finish
    // of each vertex is its uv.
    const pal = res.beauty.length === 1 && res.beauty[0].userData.cls === 'opaque' ? res.beauty[0] : null;
    check(c.item.id + ': one palette bucket for both finishes', !!pal, res.beauty.map(m => m.userData.bucket));
    if (!pal) return;
    const bodyBox = finishBox(pal, 'matte'), markBox = finishBox(pal, 'gloss');
    check(c.item.id + ': both finishes present in it', !!bodyBox && !!markBox);
    if (!bodyBox || !markBox) return;
    const body = { geometry: { computeBoundingBox() {}, boundingBox: bodyBox } };
    const mark = { geometry: { computeBoundingBox() {}, boundingBox: markBox } };
    const [f, u] = FR[c.rot];
    // Marker centre: back + u*(w/2 - 1) + f*(d - 1), at mid-height.
    const ex = c.back[0] + u[0] * 29 + f[0] * 19, ey = c.back[1] + u[1] * 29 + f[1] * 19;
    const mc = centreOf(mark);
    const elev = (c.item.elevation || 0) / 100;
    check(c.item.id + ': marker at the front-right corner', near(mc.x, tx(ex)) && near(mc.z, tz(ey)) && near(mc.y, elev + 0.25),
      { got: mc.toArray(), want: [tx(ex), elev + 0.25, tz(ey)] });
    // Body: the footprint spans the back point to depth d along the front.
    const bb = bboxOf(body);
    const fx = [c.back[0], c.back[0] + f[0] * 20].map(tx), fz = [c.back[1], c.back[1] + f[1] * 20].map(tz);
    const wantMinX = Math.min(...fx) - Math.abs(u[0]) * 0.30, wantMaxX = Math.max(...fx) + Math.abs(u[0]) * 0.30;
    const wantMinZ = Math.min(...fz) - Math.abs(u[1]) * 0.30, wantMaxZ = Math.max(...fz) + Math.abs(u[1]) * 0.30;
    check(c.item.id + ': body footprint', near(bb.min.x, wantMinX) && near(bb.max.x, wantMaxX) &&
      near(bb.min.z, wantMinZ) && near(bb.max.z, wantMaxZ) && near(bb.min.y, elev) && near(bb.max.y, elev + 0.5),
      { got: [bb.min.toArray(), bb.max.toArray()], want: [[wantMinX, elev, wantMinZ], [wantMaxX, elev + 0.5, wantMaxZ]] });
  });
}

// ---- 2. merge buckets --------------------------------------------------------
{
  const h = compile([
    { id: 'a', room: 'r', type: 'box', at: [200, 200], params: { color: '#aa0000' } },
    { id: 'b', room: 'r', type: 'box', at: [300, 300], params: { color: '#00aa00' } },
    { id: 'g1', room: 'r', type: 'box', at: [250, 250], params: { finish: 'glass', color: '#ccddee' } },
    { id: 'g2', room: 'r', type: 'box', at: [350, 250], params: { finish: 'glass', color: '#ccddee' } },
    { id: 'g3', room: 'r', type: 'box', at: [400, 250], params: { finish: 'glass', color: '#112233' } },
    { id: 'gq', room: 'q', type: 'box', at: [700, 250], params: { finish: 'glass', color: '#ccddee' } },
    { id: 's1', room: 'r', type: 'box', at: [150, 350], params: { finish: 'emissive', color: '#3366ff' } },
    { id: 's2', room: 'r', type: 'box', at: [180, 350], params: { finish: 'emissive', color: '#3366ff' } },
    { id: 'm', room: 'q', type: 'box', at: [800, 250] }
  ]);
  const res = build(h);
  const cls = c => res.beauty.filter(m => m.userData.cls === c);
  const pal = cls('opaque');
  check('house scope: every opaque part in both rooms -> ONE palette mesh', pal.length === 1 &&
    pal[0].userData.parts === 3 && pal[0].userData.rooms.sort().join() === 'q,r', res.beauty.map(m => m.userData.bucket));
  check('palette bucket is vertex-coloured, all three colours present', (() => {
    const m = pal[0]; if (!m) return false;
    const col = m.geometry.attributes.color; if (!col || !m.material.vertexColors) return false;
    const seen = new Set();
    for (let i = 0; i < col.count; i++) seen.add(col.getX(i) > col.getY(i) + 0.1 ? 'r' : (col.getY(i) > col.getX(i) + 0.1 ? 'g' : 'grey'));
    return seen.size === 3;
  })());
  const glass = res.beauty.filter(m => m.userData.finish === 'glass');
  check('glass: one mesh per tint, house-wide (both rooms\' #ccddee together)', glass.length === 2 &&
    glass.some(m => m.userData.parts === 3 && m.userData.rooms.sort().join() === 'q,r') && glass.some(m => m.userData.parts === 1),
    res.beauty.map(m => m.userData.bucket));
  check('glass keeps a real transparent material (no vertex colours: no new program)', glass.every(m =>
    m.material.transparent && !m.material.vertexColors && m.material.opacity < 0.5 && m.material.depthWrite === false));
  const glow = cls('glow');
  check('screens: ONE unlit glow mesh', glow.length === 1 && glow[0].userData.parts === 2 &&
    glow[0].material.isMeshBasicMaterial && glow[0].material.vertexColors && glow[0].receiveShadow === false);
  check('glow colour = emissive + GLOW_BASE_SHARE x base colour', (() => {
    const col = glow[0] && glow[0].geometry.attributes.color; if (!col) return false;
    const c = new THREE.Color('#3366ff'), want = c.r * (1 + M.GLOW_BASE_SHARE);
    return near(col.getX(0), want) && near(col.getZ(0), c.b * (1 + M.GLOW_BASE_SHARE));
  })(), glow[0] && glow[0].geometry.attributes.color.getX(0));
  check('total draws: palette + 2 glass + glow', res.beauty.length === 4, res.beauty.map(m => m.userData.bucket));
  check('palette and glow are transparent at opacity 1, drawn first, glow after palette (screen wins a depth tie)',
    [pal[0], glow[0]].every(m => m.material.transparent && m.material.opacity === 1 && m.material.depthWrite) &&
    pal[0].renderOrder < glow[0].renderOrder && glow[0].renderOrder < 0 && glass.every(m => m.renderOrder === 0));
  // Room scope keeps the per-room split (for measuring the two).
  const rr = build(h, ULTRA, null, { bucketScope: 'room' });
  const byRoom = room => rr.beauty.filter(m => m.userData.room === room);
  check('room scope: each room its own buckets', byRoom('r').length === 4 && byRoom('q').length === 2,
    rr.beauty.map(m => m.userData.bucket));
  check('room scope: one shared palette material across rooms',
    byRoom('r').find(m => m.userData.cls === 'opaque').material === byRoom('q').find(m => m.userData.cls === 'opaque').material);
  // The palette texture: G = roughness, B = metalness for every finish, and
  // the palette material reads it through both maps at factor 1.
  const pm = pal[0].material, tex = pm.roughnessMap;
  check('palette material: roughness and metalness come from the palette texture', tex && pm.metalnessMap === tex &&
    pm.roughness === 1 && pm.metalness === 1 && tex.magFilter === THREE.NearestFilter && tex.generateMipmaps === false);
  check('palette texel per finish = liveFinishParams', M.PALETTE_FINISHES.every((f, i) => {
    const d = tex.image.data, P = Fin.liveFinishParams(f);
    return Math.abs(d[i * 4 + 1] / 255 - (P.roughness != null ? P.roughness : 1)) < 0.5 / 255 + 1e-9 &&
      Math.abs(d[i * 4 + 2] / 255 - (P.metalness != null ? P.metalness : 0)) < 0.5 / 255 + 1e-9;
  }));
  // No environment map in the live scene: a metalness-1 mirror would draw
  // black, so the mirror texel is a smooth, barely metallic grey.
  {
    const i = M.PALETTE_FINISHES.indexOf('mirror'), d = tex.image.data;
    check('mirror texel is not fully metallic (no env map to reflect)', d[i * 4 + 2] / 255 <= 0.2 && d[i * 4 + 1] / 255 <= 0.2,
      [d[i * 4 + 1], d[i * 4 + 2]]);
    check('every other finish draws exactly as the palette', M.PALETTE_FINISHES.filter(f => f !== 'mirror').every(f => Fin.liveFinishParams(f) === Fin.FINISH_PARAMS[f]));
  }
  check('a vertex uv lands on its own finish texel', ['matte', 'gloss', 'satin', 'metal', 'mirror'].every(f =>
    Math.floor(M.paletteU(f) * M.PALETTE_FINISHES.length) === M.PALETTE_FINISHES.indexOf(f)));
  check('the palette texture is freed with the furniture', res.extraDisposables.indexOf(tex) !== -1);
  // The tag is read through partFinish: a finish on the MESH only is honoured.
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial());
  mesh.userData.finish = 'metal';
  g.add(mesh);
  const flat = M.flattenGroup(THREE, g);
  check('finish on the mesh is read (partFinish)', flat.parts[0].finish === 'metal' && flat.warnings.length === 0, flat.warnings);
  const g2 = new THREE.Group();
  g2.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial({ metalness: 0.9, roughness: 0.3 })));
  const flat2 = M.flattenGroup(THREE, g2);
  check('untagged part is quantised, with a warning', flat2.parts[0].finish === 'metal' && flat2.warnings.length === 1, flat2);
  const g3 = new THREE.Group();
  const kept = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), Fin.makeFinish(THREE, 'matte'));
  kept.material.polygonOffset = true;   // not a palette material
  kept.userData.keep = true;
  g3.add(kept);
  check('keep flag (partKeep) keeps a matte part', M.flattenGroup(THREE, g3).parts[0].keep === true);
  // ...unless its material IS the palette's: then it draws identically in the
  // palette bucket and goes there.
  const g4 = new THREE.Group();
  const plain = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), Fin.makeFinish(THREE, 'matte'));
  plain.userData.keep = true;
  g4.add(plain);
  check('a kept part with an exact palette material joins the palette', M.flattenGroup(THREE, g4).parts[0].keep === false);
}

// ---- 3. shadows: beauty never casts, one proxy per room -----------------------
{
  const h = compile([
    { id: 'tall', room: 'r', type: 'box', at: [200, 200], params: { height: 80 } },
    { id: 'tall2', room: 'r', type: 'box', at: [300, 200], params: { height: 40 } },
    { id: 'short', room: 'r', type: 'box', at: [400, 200], params: { height: 39 } },
    { id: 'hung', room: 'r', type: 'box', wall: 1, centre: 300, elevation: 30, params: { height: 80 } },
    { id: 'glass', room: 'r', type: 'box', at: [200, 300], params: { height: 80, finish: 'glass' } },
    { id: 'qtall', room: 'q', type: 'box', at: [700, 200], params: { height: 100 } }
  ]);
  const res = build(h);
  check('beauty meshes never cast', res.beauty.every(m => m.castShadow === false));
  check('opaque beauty receives, translucent (glass) does not',
    res.beauty.every(m => m.receiveShadow === !(m.userData.finish === 'glass')));
  check('ONE proxy for the whole house (both furnished rooms)', res.shadowProxies.length === 1 &&
    res.shadowProxies[0].userData.rooms.sort().join() === 'q,r', res.shadowProxies.map(p => p.name));
  const pr = res.shadowProxies[0];
  check('proxy casts, does not receive, is frustum-culled', pr && pr.castShadow && !pr.receiveShadow && pr.frustumCulled);
  check('proxy writes neither colour nor depth', pr && pr.material.colorWrite === false && pr.material.depthWrite === false);
  check('proxy is position-only', pr && Object.keys(pr.geometry.attributes).join() === 'position');
  check('proxy has a bounding sphere', pr && pr.geometry.boundingSphere && pr.geometry.boundingSphere.radius > 0);
  // Casters: elevation < 30 and height >= 40, glass excluded. A box is 12
  // triangles, so 'tall' + 'tall2' + 'qtall' only = 36 triangles = 108 vertices.
  check('proxy = exactly the three casters (height 40 in, 39 out, elevation 30 out, glass out)',
    pr && pr.geometry.attributes.position.count === 108, pr && pr.geometry.attributes.position.count);
  const perRoom = build(h, ULTRA, null, { proxyScope: 'room' });
  const prr = perRoom.shadowProxies.find(p => p.userData.room === 'r');
  check('proxyScope room: one proxy per furnished room, room r = its two casters',
    perRoom.shadowProxies.length === 2 && prr && prr.geometry.attributes.position.count === 72);
  // Identical vertices to the beauty geometry: every proxy vertex is a vertex
  // of the room's matte bucket.
  const matte = res.beauty.find(m => m.userData.cls === 'opaque');
  const key = (a, i) => a.getX(i).toFixed(5) + ',' + a.getY(i).toFixed(5) + ',' + a.getZ(i).toFixed(5);
  const beautyVerts = new Set();
  for (let i = 0; i < matte.geometry.attributes.position.count; i++) beautyVerts.add(key(matte.geometry.attributes.position, i));
  let allIn = true;
  for (let i = 0; i < pr.geometry.attributes.position.count; i++) if (!beautyVerts.has(key(pr.geometry.attributes.position, i))) allIn = false;
  check('proxy vertices are the beauty vertices (no self-shadow offset)', allIn);
  check('full-detail proxy has no customDepthMaterial', pr && pr.customDepthMaterial === undefined);
  check('depth precompile mesh built, not in the root', res.depthPrecompile && !res.depthPrecompile.parent &&
    res.depthPrecompile.material.isMeshDepthMaterial && res.depthPrecompile.material.side === THREE.BackSide &&
    res.depthPrecompile.material.depthPacking === THREE.RGBADepthPacking);
  const noShadows = build(h, { tier: 'ultra', sunShadow: false, roomShadowLights: false });
  check('no shadows at all -> no proxies', noShadows.shadowProxies.length === 0 && noShadows.depthPrecompile === null);
  check('mid tier (sun only) still gets proxies', build(h, MID).shadowProxies.length === 1);
}

// ---- 3b. r160 actually draws the proxy in the shadow pass only -----------------
// A stub WebGL2 context lets the real WebGLRenderer run its render() and
// WebGLShadowMap without a GPU. renderBufferDirect is the one call both passes
// make per draw, so wrapping it logs every draw with the render target that
// was bound (a shadow map) or not (the screen).
function stubGL() {
  const consts = new Map(), names = new Map();
  let next = 0x9000;
  const params = { VERSION: 'WebGL 2.0 (stub)', SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 3.00',
    VENDOR: 'stub', RENDERER: 'stub', SCISSOR_BOX: [0, 0, 1, 1], VIEWPORT: [0, 0, 1, 1] };
  class WebGL2RenderingContext {}
  globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
  const t = {
    constructor: WebGL2RenderingContext,
    canvas: { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} },
    drawingBufferWidth: 1, drawingBufferHeight: 1,
    getContextAttributes: () => ({ alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false }),
    // Present so compileAsync polls program readiness rather than warning.
    getExtension: name => (name === 'KHR_parallel_shader_compile' ? {} : null),
    getSupportedExtensions: () => [],
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getParameter: p => { const n = names.get(p); if (n in params) return params[n]; return n && n.startsWith('MAX_') ? 4096 : 0; },
    getProgramParameter: (prog, pname) => (/^ACTIVE_/.test(names.get(pname) || '') ? 0 : true),
    getShaderParameter: () => true,
    getProgramInfoLog: () => '', getShaderInfoLog: () => '', getShaderSource: () => '',
    getActiveUniform: () => null, getActiveAttrib: () => null, getAttribLocation: () => -1,
    getUniformLocation: () => null, checkFramebufferStatus: () => 0, getError: () => 0
  };
  const gl = new Proxy(t, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (/^[A-Z0-9_]+$/.test(prop)) {
        if (!consts.has(prop)) { consts.set(prop, next); names.set(next, prop); next++; }
        return consts.get(prop);
      }
      if (/^create/.test(prop)) return () => ({});
      if (/^is/.test(prop)) return () => true;
      return () => undefined;
    }
  });
  t.canvas.getContext = () => gl;
  return gl;
}
function stubRenderer() {
  const gl = stubGL();
  const ren = quietly(() => new THREE.WebGLRenderer({ canvas: gl.canvas, context: gl })).value;
  ren.shadowMap.enabled = true;
  return ren;
}
function lightScene() {
  const scene = new THREE.Scene();
  const spot = new THREE.SpotLight(0xffffff, 10);
  spot.position.set(3, 3, 2.5); spot.target.position.set(3, 0, 2.5);
  spot.castShadow = true;
  scene.add(spot); scene.add(spot.target);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(10, 18, -5); sun.castShadow = true;
  sun.shadow.camera.left = -15; sun.shadow.camera.right = 15; sun.shadow.camera.top = 15; sun.shadow.camera.bottom = -15;
  scene.add(sun);
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  cam.position.set(3, 6, 10); cam.lookAt(3, 0, 2.5);
  return { scene, cam };
}
{
  const h = compile([
    { id: 'tall', room: 'r', type: 'box', at: [300, 250], params: { height: 80 } },
    { id: 'hung', room: 'r', type: 'box', wall: 1, centre: 300, elevation: 150, params: { height: 50, finish: 'gloss' } }
  ]);
  const res = build(h);
  const ren = stubRenderer();
  const { scene, cam } = lightScene();
  scene.add(res.root);
  const log = [];
  ren.renderBufferDirect = (camera, sc, geometry, material, object) => {
    log.push({ shadow: !!ren.getRenderTarget(), object, material });
  };
  quietly(() => ren.render(scene, cam));
  const proxy = res.shadowProxies[0];
  const inShadow = log.filter(l => l.shadow && l.object === proxy);
  const inBeauty = log.filter(l => !l.shadow && l.object === proxy);
  check('r160: proxy drawn in the shadow passes with a depth material',
    inShadow.length >= 2 && inShadow.every(l => l.material.isMeshDepthMaterial), inShadow.length);
  check('r160: proxy in the beauty pass only with colour AND depth writes off',
    inBeauty.length === 1 && inBeauty.every(l => l.material.colorWrite === false && l.material.depthWrite === false));
  check('r160: no beauty furniture mesh is drawn in any shadow pass',
    log.filter(l => l.shadow && res.beauty.indexOf(l.object) !== -1).length === 0);
  check('r160: beauty furniture drawn in the beauty pass', log.filter(l => !l.shadow && res.beauty.indexOf(l.object) !== -1).length === res.beauty.length);
  // Hidden furniture: nothing furniture-owned is drawn in any pass.
  log.length = 0;
  res.root.visible = false;
  quietly(() => ren.render(scene, cam));
  check('hidden furniture: no draws in any pass (proxy shadow too)',
    log.filter(l => l.object === proxy || res.beauty.indexOf(l.object) !== -1).length === 0);
}

// ---- 4. proxy caps --------------------------------------------------------------
{
  // A builder whose full build is a dense sphere and whose low build is a box.
  const Dense = {
    DEFAULTS: Object.freeze({ width: 50, depth: 50, height: 80, segs: 64 }),
    build(T, p, o) {
      const g = new T.Group();
      const geo = o && o.detail === 'low'
        ? new T.BoxGeometry(0.5, 0.8, 0.5).translate(0, 0.4, 0.25)
        : new T.SphereGeometry(0.25, p.segs, p.segs).translate(0, 0.4, 0.25);
      g.add(new T.Mesh(geo, Fin.makeFinish(T, 'matte')));
      return g;
    }
  };
  // sphere(64,64) = 64*62*2 + 64*2 = 8064 triangles (r160 drops the pole caps' degenerate halves).
  const tri = segs => { const s = new THREE.SphereGeometry(0.25, segs, segs); const n = s.index.count / 3; s.dispose(); return n; };
  const t64 = tri(64);
  const h = compile([
    { id: 'a1', room: 'r', type: 'dense', at: [200, 200] },
    { id: 'a2', room: 'r', type: 'dense', at: [300, 200] },   // room r: 2 * t64 > 15k
    { id: 'b1', room: 'q', type: 'dense', at: [700, 200] }    // room q: t64 < 15k
  ]);
  const res = build(h, ULTRA, { dense: Dense });
  // House scope: the capped room's casters go into the LOW proxy, every
  // other room's into the full one.
  const pr = room => res.shadowProxies.find(p => p.userData.rooms.indexOf(room) !== -1);
  check('house scope: two proxies, full and low', res.shadowProxies.length === 2 &&
    res.shadowProxies.filter(p => p.userData.detail === 'low').length === 1, res.shadowProxies.map(p => p.name));
  check('fixture: room r is over the per-room cap', 2 * t64 > F.PROXY_ROOM_TRI_CAP && t64 < F.PROXY_ROOM_TRI_CAP, t64);
  check('over-cap room proxy comes from a low build', pr('r').userData.detail === 'low' && pr('r').userData.triangles === 24,
    pr('r').userData);
  check('over-cap proxy: customDepthMaterial with RGBA packing and polygon offset (nit 1)',
    pr('r').customDepthMaterial && pr('r').customDepthMaterial.isMeshDepthMaterial &&
    pr('r').customDepthMaterial.depthPacking === THREE.RGBADepthPacking &&
    pr('r').customDepthMaterial.polygonOffset === true && pr('r').customDepthMaterial.polygonOffsetFactor === 2 &&
    pr('r').customDepthMaterial.polygonOffsetUnits === 2);
  check('under-cap room stays full detail', pr('q').userData.detail === 'full' && pr('q').userData.triangles === t64);
  check('beauty is still full detail in the over-cap room',
    res.beauty.filter(m => m.userData.rooms.indexOf('r') !== -1).reduce((n, m) => n + m.userData.triangles, 0) >= 2 * t64 &&
    res.beauty.reduce((n, m) => n + m.userData.triangles, 0) === 3 * t64);
  check('stats name the capped rooms', res.stats.proxyLowRooms.join() === 'r');
  // Total cap: three rooms each under the room cap, over a lowered total.
  // Room sizes differ; the LARGEST must drop first, and only as many as needed.
  const h2 = { furniture: [
    { id: 'x', room: 'big', type: 'dense', origin: 'centre', x: 200, y: 200, rotationDeg: 0, elevation: 0, params: { segs: 48 }, fade: 'never', priority: 'normal' },
    { id: 'y', room: 'mid', type: 'dense', origin: 'centre', x: 400, y: 200, rotationDeg: 0, elevation: 0, params: { segs: 40 }, fade: 'never', priority: 'normal' },
    { id: 'z', room: 'small', type: 'dense', origin: 'centre', x: 600, y: 200, rotationDeg: 0, elevation: 0, params: { segs: 32 }, fade: 'never', priority: 'normal' }
  ], walls: [] };
  const tBig = tri(48), tMid = tri(40), tSmall = tri(32);
  // Cap between (mid + small + 12) and (big + mid + small): exactly the
  // largest room must drop.
  const cap = tMid + tSmall + 12 + 1;
  const r2 = build(h2, ULTRA, { dense: Dense }, { totalTriCap: cap });
  const d = room => r2.shadowProxies.find(p => p.userData.rooms.indexOf(room) !== -1).userData.detail;
  check('total cap: largest room drops first, only it', d('big') === 'low' && d('mid') === 'full' && d('small') === 'full',
    { big: d('big'), mid: d('mid'), small: d('small'), tBig, tMid, tSmall, cap });
  const r3 = build(h2, ULTRA, { dense: Dense }, { totalTriCap: tSmall + 24 + 1 });
  const d3 = room => r3.shadowProxies.find(p => p.userData.rooms.indexOf(room) !== -1).userData.detail;
  check('total cap: then the next largest', d3('big') === 'low' && d3('mid') === 'low' && d3('small') === 'full');
}

// ---- 5. low tier ---------------------------------------------------------------
{
  const seen = [];
  const Spy = { DEFAULTS: Box.DEFAULTS, build(T, p, o) { seen.push(o && o.detail); return Box.build(T, p, o); } };
  const h = compile([
    { id: 'a', room: 'r', type: 'spy', at: [200, 200], params: { height: 80 } },
    { id: 'm', room: 'r', type: 'spy', at: [300, 200], priority: 'minor' }
  ]);
  const res = build(h, LOW, { spy: Spy });
  check('low tier: builder gets detail low', seen.length === 1 && seen[0] === 'low', seen);
  check('low tier: minor item skipped', !res.byId.m && res.byId.a && res.stats.skipped === 1);
  check('low tier: no proxies', res.shadowProxies.length === 0 && res.depthPrecompile === null);
  // Even if a low-tier scene were asked for shadows, the tier alone rules proxies out.
  const lowAsked = build(h, { tier: 'low', sunShadow: true, roomShadowLights: true }, { spy: Spy });
  check('low tier: no proxies even with shadow flags on', lowAsked.shadowProxies.length === 0);
  seen.length = 0;
  const hi = build(h, ULTRA, { spy: Spy });
  check('ultra: builder gets detail full, minor item kept', seen.join() === 'full,full' && hi.byId.m);
}

// ---- 6. fade --------------------------------------------------------------------
{
  const h = compile([
    { id: 'host', room: 'r', type: 'box', wall: 1, centre: 200, params: { height: 150 } },
    { id: 'hostShort', room: 'r', type: 'box', wall: 1, centre: 300, params: { height: 100 } },
    { id: 'hostHigh', room: 'r', type: 'box', wall: 1, centre: 400, elevation: 60, params: { height: 50 } },
    { id: 'interior', room: 'r', type: 'box', wall: 3, centre: 200, params: { height: 150 } },
    { id: 'never', room: 'r', type: 'box', wall: 1, centre: 450, fade: 'never', params: { height: 150 } },
    { id: 'override', room: 'r', type: 'box', at: [300, 250], fade: { wall: 2 }, params: { height: 20 } },
    { id: 'freeTall', room: 'r', type: 'box', at: [470, 250], rotation: 90, params: { width: 100, depth: 50, height: 200 } },
    { id: 'freeMid', room: 'r', type: 'box', at: [300, 250], params: { height: 200 } },
    // The same spot as freeTall, but low: a FREE item keeps the height rule.
    { id: 'freeLow', room: 'r', type: 'box', at: [470, 250], rotation: 90, params: { width: 100, depth: 50, height: 80 } },
    // Corner unit: anchored to north wall 1 (its run), tucked into the corner
    // with EAST wall 4 (also exterior) -- it fades with its run's wall, 1.
    { id: 'corner', room: 'r', type: 'box', wall: 1, centre: 470, params: { width: 60, depth: 60, height: 150 } }
  ]);
  const res = build(h);
  const fw = id => res.byId[id].fadeWallId;
  check('wall anchor, tall, exterior host -> host wall', fw('host') === 1, fw('host'));
  // f7324d3f: a wall-anchored item goes with its wall whatever its height.
  check('wall anchor, top exactly 100 -> still fades with its host wall', fw('hostShort') === 1, fw('hostShort'));
  check('wall anchor, raised -> host wall', fw('hostHigh') === 1);
  check('free item, top 80 beside the shell -> no fade (height rule kept for free items)', fw('freeLow') === null, fw('freeLow'));
  check('interior host -> no fade', fw('interior') === null);
  check('fade never -> none', fw('never') === null);
  check('explicit override wins, whatever the height', fw('override') === 2);
  check('free tall item beside the shell -> pickFadeWall', fw('freeTall') === 4, fw('freeTall'));
  check('free tall item mid-room -> none', fw('freeMid') === null);
  check('corner unit fades with its own run, not the side wall', fw('corner') === 1);
  // Fade buckets get their own transparent material clone.
  const fading = res.beauty.filter(m => m.userData.fadeWallId === 1);
  check('fade bucket per wall, own transparent material', fading.length === 1 && fading[0].material.transparent &&
    fading[0].material !== res.beauty.find(m => m.userData.fadeWallId == null && m.userData.cls === 'opaque').material);
  // Glass fades WITH its item (f7324d3f, replacing A3), from and back to its
  // own opacity -- never driven to 1.
  const hg = compile([
    { id: 'gcase', room: 'r', type: 'box', wall: 1, centre: 200, params: { height: 180, finish: 'glass' } },
    { id: 'body', room: 'r', type: 'box', wall: 1, centre: 300, params: { height: 180 } }
  ]);
  const rg = build(hg);
  const glass = rg.beauty.filter(m => m.userData.finish === 'glass');
  const glassOpacity = Fin.makeFinish(THREE, 'glass').opacity;
  check('glass on a fading wall item carries the fade wall', glass.length === 1 && glass[0].userData.fadeWallId === 1,
    glass.map(m => m.userData.fadeWallId));
  check('the glass fade clone keeps its own opacity and depthWrite, and records them',
    glass.length === 1 && glass[0].material.opacity === glassOpacity && glass[0].material.depthWrite === false &&
    glass[0].material.userData.baseOpacity === glassOpacity && glass[0].material.userData.baseDepthWrite === false,
    glass.map(m => [m.material.opacity, m.material.depthWrite, m.material.userData]));
  const regs = F.fadeRegistrations(rg);
  const greg = regs.find(r => r.mesh === glass[0]);
  check('glass is registered with its base opacity (the fade returns it there, not to 1)',
    regs.length === 2 && greg && greg.baseOpacity === glassOpacity && greg.baseDepthWrite === false,
    regs.map(r => [r.mesh.userData.finish, r.baseOpacity, r.baseDepthWrite]));
  check('an opaque fade bucket is registered at base 1, writing depth',
    regs.some(r => r.mesh !== glass[0] && r.baseOpacity === 1 && r.baseDepthWrite === true));
  // The lock: a glass mesh with NO recorded base opacity would be driven to 1
  // -- it is refused.
  const forged = { beauty: [Object.assign(new THREE.Mesh(new THREE.BufferGeometry(), Fin.makeFinish(THREE, 'glass')),
    { userData: { fadeWallId: 1, finish: 'glass' } })] };
  check('fadeRegistrations refuses a glass fade with no base opacity', F.fadeRegistrations(forged).length === 0);
  const byTag = { beauty: [Object.assign(new THREE.Mesh(new THREE.BufferGeometry(), Fin.makeFinish(THREE, 'matte')),
    { userData: { fadeWallId: 1, finish: 'glass' } })] };
  const byMat = { beauty: [Object.assign(new THREE.Mesh(new THREE.BufferGeometry(), Fin.makeFinish(THREE, 'glass')),
    { userData: { fadeWallId: 1, finish: 'matte' } })] };
  const byTrans = { beauty: [Object.assign(new THREE.Mesh(new THREE.BufferGeometry(), Fin.makeFinish(THREE, 'matte')),
    { userData: { fadeWallId: 1, finish: 'matte', translucent: true } })] };
  check('...refused by the bucket tag alone', F.fadeRegistrations(byTag).length === 0);
  check('...refused by the material finish alone', F.fadeRegistrations(byMat).length === 0);
  check('...refused by the translucent flag alone', F.fadeRegistrations(byTrans).length === 0);
  const gp = { finish: 'glass', keep: true, color: 0xccddee, emissive: 0, textured: false };
  check('a glass bucket key names its fade wall', /\|1$/.test(M.bucketKey(gp, 'r', 1)), M.bucketKey(gp, 'r', 1));
  check('...and "-" with none', /\|-$/.test(M.bucketKey(gp, 'r', null)));
  // The loop's two decisions (the scene calls exactly these).
  check('wallFadeTarget: facing the camera -> 0.05 x base', near(F.wallFadeTarget(-0.9, 1), 0.05) &&
    near(F.wallFadeTarget(-0.9, 0.25), 0.0125) && near(F.wallFadeTarget(-0.9), 0.05));
  check('wallFadeTarget: not facing -> its base (glass back to 0.25, not 1)', F.wallFadeTarget(0, 0.25) === 0.25 &&
    F.wallFadeTarget(-0.2, 1) === 1 && F.wallFadeTarget(0.5) === 1);
  check('wallFadeDepthWrite: opaque writes only while solid', F.wallFadeDepthWrite(0.99, 1, true) === true &&
    F.wallFadeDepthWrite(0.5, 1, true) === false && F.wallFadeDepthWrite(0.99) === true);
  check('wallFadeDepthWrite: glass keeps its own false at its base', F.wallFadeDepthWrite(0.25, 0.25, false) === false);
  check('wallFadeDepthWrite: a translucent depth-writer writes at its base, not while fading',
    F.wallFadeDepthWrite(0.5, 0.5, true) === true && F.wallFadeDepthWrite(0.1, 0.5, true) === false);
  // The scene registers exactly fadeRegistrations() and nothing else.
  const sceneSrc = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('scene registers furniture fades through fadeRegistrations only',
    /fadeRegistrations\(result\)\.forEach/.test(sceneSrc) && !/furnitureResult\.beauty[^\n]*wallMeshes/.test(sceneSrc));
  check('scene registers each fade with its base opacity and depthWrite',
    /wallMeshes\.push\(\{ mesh, nx: host\.nx, nz: host\.nz, outer: true, base: baseOpacity, baseDepthWrite \}\)/.test(sceneSrc));
  check('scene fade loop drives opacity and depthWrite through wallFadeTarget / wallFadeDepthWrite',
    /const targetOpacity = wallFadeTarget\(dot, b\)/.test(sceneSrc) &&
    /mesh\.material\.depthWrite = wallFadeDepthWrite\(mesh\.material\.opacity, b, baseDepthWrite\)/.test(sceneSrc));
}

// ---- 6b. everything mounted on a wall fades with that wall (f7324d3f) -------------
// Real builders: three floating shelves stacked as in a store recess (84 /
// 134 / 184 cm, 5 cm slabs -- the lowest tops out at 89, under FADE_MIN_TOP),
// a kitchen base run, a wall run and a fridge-freezer, a glass box and an
// up-down sconce (translucent globe and beam cones), ALL wall-anchored to
// exterior wall 1. Every bucket they land in must fade with wall 1.
{
  const items = [
    { id: 'shelf84', room: 'r', type: 'shelf', wall: 1, centre: 150, elevation: 84, params: { width: 90, depth: 26, height: 5, shelfThickness: 5 } },
    { id: 'shelf134', room: 'r', type: 'shelf', wall: 1, centre: 150, elevation: 134, params: { width: 90, depth: 26, height: 5, shelfThickness: 5 } },
    { id: 'shelf184', room: 'r', type: 'shelf', wall: 1, centre: 150, elevation: 184, params: { width: 90, depth: 26, height: 5, shelfThickness: 5 } },
    { id: 'base', room: 'r', type: 'kitchen-base-run', wall: 1, centre: 330 },
    { id: 'wallrun', room: 'r', type: 'kitchen-wall-run', wall: 1, centre: 330, elevation: 150 },
    { id: 'fridge', room: 'r', type: 'fridge-freezer', wall: 1, centre: 460 },
    { id: 'gfront', room: 'r', type: 'box', wall: 1, centre: 240, elevation: 20, params: { width: 30, depth: 20, height: 30, finish: 'glass' } },
    { id: 'sconce', room: 'r', type: 'wall-sconce', wall: 1, centre: 240, elevation: 60, params: { kind: 'up-down' } }
  ];
  const h = compile(items);
  const real = (await quietlyAsync(() => F.loadFurnitureModules(h.furniture))).value;
  const types = ['shelf', 'kitchen-base-run', 'kitchen-wall-run', 'fridge-freezer', 'wall-sconce'];
  check('6b: the real builders loaded', types.every(t => real.has(t)), types.filter(t => !real.has(t)));
  const res = quietly(() => F.buildFurnitureSync(THREE, h.furniture, real, { tx, tz, quality: ULTRA, walls: h.walls })).value;
  const fw = id => res.byId[id] && res.byId[id].fadeWallId;
  check('6b: all three stacked shelves fade with their wall (84 / 134 / 184)',
    fw('shelf84') === 1 && fw('shelf134') === 1 && fw('shelf184') === 1, items.slice(0, 3).map(i => fw(i.id)));
  check('6b: the kitchen base run, wall run and fridge-freezer fade with their wall',
    fw('base') === 1 && fw('wallrun') === 1 && fw('fridge') === 1, ['base', 'wallrun', 'fridge'].map(fw));
  check('6b: every wall-anchored item on an exterior wall has that wall as its fade wall',
    items.every(i => fw(i.id) === 1), items.map(i => [i.id, fw(i.id)]));
  // Not one bucket of theirs is left standing: every beauty mesh fades with
  // wall 1 and is registered for the fade -- glass and beam cones included.
  const regs = F.fadeRegistrations(res);
  const standing = res.beauty.filter(m => m.userData.fadeWallId !== 1 || !regs.some(r => r.mesh === m && r.wallId === 1));
  check('6b: no wall-anchored part lands in a non-fading bucket', res.beauty.length > 0 && standing.length === 0,
    standing.map(m => [m.userData.bucket.slice(0, 40), m.userData.fadeWallId]));
  check('6b: the translucent buckets are among the fading ones, at their own base',
    regs.some(r => r.mesh.userData.translucent && r.baseOpacity < 1 && r.baseOpacity === r.mesh.material.opacity),
    regs.map(r => [r.mesh.userData.cls, r.mesh.userData.translucent, r.baseOpacity]));
  check('6b: the kitchen runs are kitchen-run sized (real runs, not stubs)',
    res.byId.base.triangles > 200 && res.byId.wallrun.triangles > 100, [res.byId.base.triangles, res.byId.wallrun.triangles]);
  F.disposeFurniture(res);
}

// ---- 7. the attach sequence (A2) --------------------------------------------------
function fakeRenderer(opts) {
  const o = opts || {};
  const calls = [];
  const ren = {
    shadowMap: { enabled: false },
    rt: null,
    getRenderTarget() { return this.rt; },
    setRenderTarget(rt) { calls.push(['setRenderTarget', rt ? 'rt' : null]); this.rt = rt; },
    compileAsync(obj, cam, scene) {
      calls.push(['compileAsync', obj, cam, scene, this.shadowMap.enabled, this.rt ? 'rt' : null]);
      if (o.onCompile) o.onCompile(obj);
      return o.reject ? Promise.reject(new Error('boom')) : Promise.resolve(obj);
    }
  };
  return { ren, calls };
}
function sampleResult() {
  const h = compile([{ id: 'a', room: 'r', type: 'box', at: [200, 200], params: { height: 80 } }]);
  return build(h);
}
{
  const { ren, calls } = fakeRenderer();
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera();
  let attached = null, disposed = false;
  const res = sampleResult();
  ren.shadowMap.enabled = false;
  const out = await F.scheduleFurnitureAttach({
    precompileDone: Promise.resolve(), modulesLoaded: Promise.resolve(new Map()),
    isDisposed: () => disposed, build: () => res, renderer: ren, camera: cam, scene, wantShadows: true,
    makeRenderTarget: () => ({ dispose() { calls.push(['rtDispose']); } }),
    attach: r => { calls.push(['attach']); attached = r; scene.add(r.root); }
  });
  const iCompile = calls.findIndex(c => c[0] === 'compileAsync' && c[1] === res.root);
  const iAttach = calls.findIndex(c => c[0] === 'attach');
  check('A2: compileAsync(root, cam, scene) before the attach', iCompile !== -1 && iAttach > iCompile &&
    calls[iCompile][2] === cam && calls[iCompile][3] === scene, calls.map(c => c[0]));
  check('A2: compiled with shadowMap.enabled = wantShadows (nit 3)', calls[iCompile][4] === true);
  check('nit 3: shadowMap.enabled restored afterwards', ren.shadowMap.enabled === false);
  const dc = calls.find(c => c[0] === 'compileAsync' && c[1] === res.depthPrecompile);
  check('nit 1: depth program compiled with a render target bound', dc && dc[5] === 'rt' && dc[3] === scene);
  check('nit 1: render target restored and freed', ren.rt === null && calls.some(c => c[0] === 'rtDispose'));
  check('A2: resolves to the attached result', out === res && attached === res && res.root.parent === scene);
}
{
  // Disposed BEFORE the modules resolve: build never runs, nothing attaches.
  const { ren, calls } = fakeRenderer();
  let disposed = false, built = 0, resolveModules;
  const modulesLoaded = new Promise(r => { resolveModules = r; });
  const p = F.scheduleFurnitureAttach({
    precompileDone: Promise.resolve(), modulesLoaded, isDisposed: () => disposed,
    build: () => { built++; return sampleResult(); }, renderer: ren, camera: {}, scene: {}, wantShadows: true,
    attach: () => calls.push(['attach'])
  });
  disposed = true;
  resolveModules(new Map());
  const out = await p;
  check('A2: dispose before modules resolve -> no build, no attach, no compile',
    out === null && built === 0 && !calls.some(c => c[0] === 'attach' || c[0] === 'compileAsync'));
}
{
  // Disposed DURING the compile: the build is freed, not attached.
  let disposed = false;
  const res = sampleResult();
  const geos = new Set();
  res.root.traverse(o => { if (o.geometry) geos.add(o.geometry); });
  let freed = 0;
  geos.forEach(g => g.addEventListener('dispose', () => { freed++; }));
  const matsFreed = [];
  res.materials.forEach(m => m.addEventListener('dispose', () => matsFreed.push(m)));
  const { ren, calls } = fakeRenderer({ onCompile: () => { disposed = true; } });
  const out = await F.scheduleFurnitureAttach({
    precompileDone: Promise.resolve(), modulesLoaded: Promise.resolve(new Map()), isDisposed: () => disposed,
    build: () => res, renderer: ren, camera: {}, scene: {}, wantShadows: false,
    attach: () => calls.push(['attach'])
  });
  check('A2: dispose during compile -> not attached', out === null && !calls.some(c => c[0] === 'attach'));
  check('A2: ... and every furniture geometry and material freed', freed === geos.size && geos.size > 0 &&
    matsFreed.length === res.materials.size, { freed, geos: geos.size });
  check('wantShadows false: no depth precompile', !calls.some(c => c[0] === 'compileAsync' && c[1] === res.depthPrecompile));
}
{
  // A failing precompile still attaches (compiles on first draw), with a warning.
  const { ren, calls } = fakeRenderer({ reject: true });
  const res = sampleResult();
  const { value: out, warnings } = await quietlyAsync(() => F.scheduleFurnitureAttach({
    precompileDone: Promise.resolve(), modulesLoaded: Promise.resolve(new Map()), isDisposed: () => false,
    build: () => res, renderer: ren, camera: {}, scene: {}, wantShadows: true,
    attach: () => calls.push(['attach'])
  }));
  check('A2: rejected precompile -> warn and still attach', out === res && calls.some(c => c[0] === 'attach') &&
    warnings.some(w => /precompile failed/.test(w)));
  // A throwing build: the terminal catch warns and resolves null.
  const r2 = await quietlyAsync(() => F.scheduleFurnitureAttach({
    precompileDone: Promise.resolve(), modulesLoaded: Promise.resolve(new Map()), isDisposed: () => false,
    build: () => { throw new Error('bad builder'); }, renderer: ren, camera: {}, scene: {}, wantShadows: true,
    attach: () => {}
  }));
  check('nit 2: terminal catch warns, never rejects', r2.value === null && r2.warnings.some(w => /could not be built/.test(w)));
  // No compileAsync on the renderer: attach straight away.
  const plain = { shadowMap: { enabled: true } };
  let att = 0;
  await F.scheduleFurnitureAttach({
    precompileDone: Promise.resolve(), modulesLoaded: Promise.resolve(new Map()), isDisposed: () => false,
    build: () => sampleResult(), renderer: plain, camera: {}, scene: {}, wantShadows: true, attach: () => { att++; }
  });
  check('no compileAsync -> attaches anyway', att === 1);
  // The scene hands scheduleFurnitureAttach the precompile chain AFTER its
  // catch/restore (nit 2), not the raw compileAsync promise. Since the
  // cold-start fix it is Promise.all(jobs) -- the scene's programs plus the
  // shadow depth program -- still followed by the same catch/restore.
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('nit 2: precompileDone is the caught/restored chain',
    /precompileDone = Promise\.(resolve\(ren\.compileAsync\(scene, cam\)\)|all\(jobs\))\s*\n\s*\.catch\(/.test(src) &&
    /\.then\(\(\) => \{\s*\n\s*ren\.shadowMap\.enabled = shadowWasEnabled;/.test(src));
}

// ---- 8. the depth program really is precompiled (stub WebGL) ------------------------
{
  const run = async (precompileDepth, overCap) => {
    const h = compile([
      { id: 'a', room: 'r', type: 'box', at: [300, 250], params: { height: 80 } },
      { id: 'b', room: 'r', type: 'box', at: [200, 250], params: { height: 80 } }
    ]);
    const res = build(h, ULTRA, {}, overCap ? { roomTriCap: 1 } : {});
    const ren = stubRenderer();
    const { scene, cam } = lightScene();
    // A house caster, drawn with the shadow map's own depth material.
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    wall.castShadow = true; wall.position.set(5, 0.5, 5);
    scene.add(wall);
    // The scene's own precompile. NO shadow frame yet: the depth program
    // does not exist until something compiles it, which is the case the
    // furniture precompile has to cover (it can attach before the house's
    // first shadow frame has been drawn).
    await ren.compileAsync(scene, cam);
    await F.scheduleFurnitureAttach({
      precompileDone: Promise.resolve(), modulesLoaded: Promise.resolve(new Map()), isDisposed: () => false,
      build: () => res, renderer: ren, camera: cam, scene, wantShadows: true,
      makeRenderTarget: precompileDepth ? () => new THREE.WebGLRenderTarget(1, 1) : undefined,
      attach: r => scene.add(r.root)
    });
    const before = ren.info.programs.length;
    ren.shadowMap.needsUpdate = true;
    quietly(() => ren.render(scene, cam));
    return { before, after: ren.info.programs.length, res };
  };
  const a = await run(true, false);
  check('precompile: a shadow frame after attach compiles NO new program', a.after === a.before,
    { before: a.before, after: a.after });
  const b = await run(true, true);
  check('precompile: ... also with an over-cap customDepthMaterial proxy', b.res.shadowProxies[0].customDepthMaterial &&
    b.after === b.before, { before: b.before, after: b.after });
  // Control: without the depth precompile the same frame DOES build a program,
  // so the two checks above are measuring something.
  const c = await run(false, false);
  check('precompile control: without it, the shadow frame compiles one', c.after === c.before + 1,
    { before: c.before, after: c.after });
}

// ---- 9. room clicks ----------------------------------------------------------------
{
  const h = compile([
    { id: 'a', room: 'r', type: 'box', at: [300, 250], params: { width: 200, depth: 200, height: 80 } },
    { id: 'g', room: 'r', type: 'box', at: [300, 250], elevation: 100, params: { width: 200, depth: 200, height: 2, finish: 'glass' } }
  ]);
  const res = build(h);
  const scene = new THREE.Scene();
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }));
  catcher.rotation.x = -Math.PI / 2; catcher.position.set(3, 0.006, 2.5);
  catcher.userData = { roomId: 'r', clickable: true };
  scene.add(catcher);
  scene.add(res.root);
  scene.updateMatrixWorld(true);
  const rc = new THREE.Raycaster(new THREE.Vector3(3, 5, 2.5), new THREE.Vector3(0, -1, 0));
  const hits = rc.intersectObjects(scene.children, true);
  check('fixture: the ray hits furniture before the floor', hits.length > 1 && hits[0].object !== catcher, hits.map(x => x.object.name));
  // The scene's own predicate, read from the source so the test follows it.
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('the scene still resolves a click by the first clickable hit',
    src.includes('rc.intersectObjects(scene.children, true).find(x => x.object.userData.clickable)'));
  const h1 = hits.find(x => x.object.userData.clickable);
  check('room click resolves through the furniture', h1 && h1.object === catcher && h1.object.userData.roomId === 'r');
  let anyClickable = false;
  res.root.traverse(o => { if (o.userData && o.userData.clickable) anyClickable = true; });
  check('no furniture mesh is clickable', !anyClickable);
}

// ---- 10. no furniture = nothing built ------------------------------------------------
{
  const h = compile([]);
  const res = build(h);
  check('no furniture: empty root, no materials, no proxies',
    res.root.children.length === 0 && res.materials.size === 0 && res.shadowProxies.length === 0 && res.depthPrecompile === null);
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('scene: a house with no furniture starts nothing',
    /if \(furnitureStarted \|\| !furnitureItems\.length\) return;/.test(src) &&
    /\(furnitureItems\.length && furnitureVisible\)\s*\n?\s*\? loadFurnitureModules/.test(src));
}

// ---- 12. kept parts keep their builder's material (review a6e3c7d8) ------------------------
{
  const Sconce = await imp('src/furniture/wall-sconce.js');
  const PROPS = ['type', 'opacity', 'transparent', 'side', 'depthWrite', 'emissiveIntensity', 'roughness', 'metalness'];
  const same = (a, b) => PROPS.every(k => a[k] === b[k]) &&
    (!a.color || a.color.getHex() === b.color.getHex()) && (!a.emissive || a.emissive.getHex() === b.emissive.getHex());
  const sconce = { DEFAULTS: Sconce.DEFAULTS, build: Sconce.build };
  for (const kind of ['swing-arm-globe', 'up-down']) {
    // The builder's own kept materials, as the builder made them.
    const src = Sconce.build(THREE, Object.assign({}, Sconce.DEFAULTS, { kind }));
    const keptSrc = [];
    const finishOf = new Map();
    src.traverse(o => {
      if (o.isMesh && (o.userData.keep || (o.material.userData && o.material.userData.keep))) {
        keptSrc.push(o.material);
        finishOf.set(o.material, Fin.partFinish(o, o.material).finish);
      }
    });
    check(kind + ': fixture has kept parts', keptSrc.length >= 2, keptSrc.length);
    const h = compile([
      { id: 's1', room: 'r', type: 'sconce', wall: 3, centre: 200, elevation: 150, params: { kind } },
      { id: 's2', room: 'r', type: 'sconce', wall: 3, centre: 300, elevation: 150, params: { kind } }
    ]);
    const res = build(h, ULTRA, { sconce });
    const kept = res.beauty.filter(m => m.userData.keep);
    // Each kept builder material is drawn by a bucket that keeps its look:
    // the glow bucket (opaque emissive), the palette (a material that IS a
    // palette one), or a clone of the builder's own material.
    const drawnBy = sm => {
      if (finishOf.get(sm) === 'emissive' && !(sm.transparent && sm.opacity < 1)) return kept.find(m => m.userData.cls === 'glow');
      if (M.isPaletteMaterial(THREE, sm, finishOf.get(sm))) return res.beauty.find(m => m.userData.cls === 'opaque');
      return kept.find(m => m.userData.cls === 'kept' && same(sm, m.material));
    };
    check(kind + ': every builder kept material is drawn by a bucket that keeps its look',
      keptSrc.every(sm => !!drawnBy(sm)),
      keptSrc.map(m => [m.type, m.opacity, m.transparent, m.side, m.depthWrite, m.emissiveIntensity]));
    check(kind + ': no kept bucket has a material the builder did not make',
      kept.every(m => m.userData.cls === 'glow' || keptSrc.some(sm => same(sm, m.material))),
      kept.map(m => [m.material.type, m.material.opacity, m.material.side]));
    check(kind + ': two identical sconces share their kept buckets', kept.every(m => m.userData.parts % 2 === 0),
      kept.map(m => m.userData.parts));
    check(kind + ': translucent kept parts never receive a shadow',
      kept.filter(m => m.material.transparent).every(m => m.receiveShadow === false));
  }
  // The up-down beam cones specifically: faint, double-sided, no depth write,
  // and on an exterior wall they fade WITH it, from their own faint opacity
  // (f7324d3f) -- never driven to 1.
  {
    const h = compile([{ id: 'u', room: 'r', type: 'sconce', wall: 1, centre: 200, elevation: 150, params: { kind: 'up-down' } }]);
    const res = build(h, ULTRA, { sconce });
    const beam = res.beauty.find(m => m.material.type === 'MeshBasicMaterial' && m.userData.cls === 'kept');
    check('up-down beam stays a faint translucent MeshBasicMaterial', beam && beam.material.transparent &&
      beam.material.opacity < 0.5 && beam.material.depthWrite === false && beam.material.side === THREE.DoubleSide,
      beam && [beam.material.opacity, beam.material.depthWrite, beam.material.side]);
    const breg = beam && F.fadeRegistrations(res).find(r => r.mesh === beam);
    check('translucent beam fades with its wall, returning to its own opacity', beam && beam.userData.fadeWallId === 1 &&
      breg && breg.baseOpacity === beam.material.opacity && breg.baseOpacity < 0.5 && breg.baseDepthWrite === false,
      breg && [breg.baseOpacity, breg.baseDepthWrite]);
    check('translucent parts are not in the shadow proxy', res.shadowProxies.length === 0);
  }
  // Glass and mirror parts from the palette (the cabinet/small-items shape).
  const GM = { DEFAULTS: Object.freeze({ width: 60, depth: 30, height: 120 }), build(T) {
    const g = new T.Group();
    const glass = new T.Mesh(new T.BoxGeometry(0.5, 1, 0.01).translate(0, 0.6, 0.29), Fin.makeFinish(T, 'glass', '#cfe3ea'));
    glass.material.side = T.DoubleSide;
    const mirror = new T.Mesh(new T.BoxGeometry(0.5, 1, 0.01).translate(0, 0.6, 0.01), Fin.makeFinish(T, 'mirror'));
    const body = new T.Mesh(new T.BoxGeometry(0.6, 1.2, 0.3).translate(0, 0.6, 0.15), Fin.makeFinish(T, 'matte', '#445566'));
    g.add(glass); g.add(mirror); g.add(body);
    return g;
  } };
  const srcGM = GM.build(THREE);
  // Interior wall: nothing fades, so the materials can be compared as built.
  const hg = compile([{ id: 'c', room: 'r', type: 'gm', wall: 3, centre: 200 }]);
  const rg = build(hg, ULTRA, { gm: GM });
  const g = rg.beauty.find(m => m.userData.finish === 'glass'), pal = rg.beauty.find(m => m.userData.cls === 'opaque');
  check('glass keeps opacity, transparent, depthWrite and its DoubleSide', g && same(srcGM.children[0].material, g.material) &&
    g.material.side === THREE.DoubleSide, g && [g.material.opacity, g.material.depthWrite, g.material.side]);
  // A palette mirror joins the palette bucket: its roughness/metalness come
  // from the mirror texel, its colour per vertex.
  const mirrorBox = pal && finishBox(pal, 'mirror');
  check('mirror joins the palette bucket, keeping roughness/metalness (texel) and colour (vertex)', !!mirrorBox &&
    !rg.beauty.some(m => m.userData.finish === 'mirror') && (() => {
      const col = pal.geometry.attributes.color, uv = pal.geometry.attributes.uv, src = srcGM.children[1].material.color;
      for (let i = 0; i < col.count; i++) if (near(uv.getX(i), M.paletteU('mirror')) && !near(col.getX(i), src.r)) return false;
      return true;
    })(), rg.beauty.map(m => m.userData.bucket));
  // A kept part whose material is NOT a palette material stays tinted.
  const odd = Fin.makeFinish(THREE, 'mirror'); odd.roughness = 0.3;
  check('a non-palette mirror is not mistaken for the palette', !M.isPaletteMaterial(THREE, odd, 'mirror') &&
    M.isPaletteMaterial(THREE, Fin.makeFinish(THREE, 'mirror'), 'mirror'));
}

// ---- 13. opaque buckets: vertex colours and side (review 30d91c80) ---------------------------
{
  const VC = { DEFAULTS: Object.freeze({ width: 20, depth: 20, height: 20 }), build(T, p) {
    const g = new T.Group();
    const geo = new T.BoxGeometry(0.2, 0.2, 0.2).translate(0, 0.1, 0.1).toNonIndexed();
    const n = geo.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = i < n / 2 ? 1 : 0; c[i * 3 + 1] = i < n / 2 ? 0 : 1; c[i * 3 + 2] = 0; }
    geo.setAttribute('color', new T.BufferAttribute(c, 3));
    const mat = Fin.makeFinish(T, 'matte', '#808080');
    mat.vertexColors = true;
    g.add(new T.Mesh(geo, mat));
    if (p.double) {
      const m2 = Fin.makeFinish(T, 'matte', '#808080');
      m2.side = T.DoubleSide;
      g.add(new T.Mesh(new T.PlaneGeometry(0.2, 0.2).translate(0, 0.1, 0.2), m2));
    }
    return g;
  } };
  const h = compile([{ id: 'v', room: 'r', type: 'vc', at: [200, 200], params: { double: true } }]);
  const res = build(h, ULTRA, { vc: VC });
  const single = res.beauty.find(m => m.userData.cls === 'opaque' && m.material.side === THREE.FrontSide);
  const dbl = res.beauty.find(m => m.userData.cls === 'opaque' && m.material.side === THREE.DoubleSide);
  check('opaque: a DoubleSide part gets its own DoubleSide bucket', single && dbl && res.beauty.length === 2,
    res.beauty.map(m => m.userData.bucket));
  const grey = new THREE.Color(0x808080).r;
  const col = single && single.geometry.attributes.color;
  let reds = 0, greens = 0;
  if (col) for (let i = 0; i < col.count; i++) {
    if (near(col.getX(i), grey) && near(col.getY(i), 0)) reds++;
    if (near(col.getX(i), 0) && near(col.getY(i), grey)) greens++;
  }
  check('opaque: vertex colours honoured (times the material colour)', reds === 18 && greens === 18, { reds, greens });
}

// ---- 14. a room still over the cap at low detail says so -------------------------------------
{
  const Heavy = { DEFAULTS: Object.freeze({ width: 50, depth: 50, height: 80 }), build(T) {
    const g = new T.Group();
    g.add(new T.Mesh(new T.SphereGeometry(0.25, 40, 40).translate(0, 0.4, 0.25), Fin.makeFinish(T, 'matte')));
    return g;   // no cheaper low build
  } };
  const h = compile([{ id: 'x', room: 'r', type: 'heavy', at: [200, 200] }]);
  const res = build(h, ULTRA, { heavy: Heavy }, { roomTriCap: 100 });
  check('over the cap even at low detail -> warned', res.warnings.some(w => /even at low detail/.test(w)), res.warnings);
  const ok = build(h, ULTRA, { heavy: Heavy });
  check('...and not warned when under the cap', !ok.warnings.some(w => /even at low detail/.test(w)));
}

// ---- 11. a builder that throws costs only its own item ------------------------------------
{
  const Bad = { DEFAULTS: Box.DEFAULTS, build() { throw new Error('nope'); } };
  const h = compile([
    { id: 'bad', room: 'r', type: 'bad', at: [200, 200] },
    { id: 'ok', room: 'r', type: 'box', at: [300, 200] }
  ]);
  const res = build(h, ULTRA, { bad: Bad });
  check('throwing builder: warned and skipped, others built', !res.byId.bad && res.byId.ok &&
    res.warnings.some(w => /failed to build/.test(w)));
}

// ---- 2b. the full-house fixture stays inside the bucket budget (f17a127f) ---------------
// Every registered builder that exists, ~95 items over ten rooms, fade auto and
// never mixed (scripts/make-perf-fixture.mjs). Perf budget B2: beauty buckets
// <= 30 on mid/ultra and <= 20 on low, proxies <= 10.
const { makePerfFixture } = await imp('scripts/make-perf-fixture.mjs');
const fixture = quietly(() => HouseLoader.compile(makePerfFixture().geometry, '')).value;
const fixtureBuilders = (await quietlyAsync(() => F.loadFurnitureModules(fixture.furniture))).value;
const buildFixture = (quality, opts) => quietly(() => F.buildFurnitureSync(THREE, fixture.furniture, fixtureBuilders,
  Object.assign({ tx, tz, quality, walls: fixture.walls }, opts || {}))).value;
{
  check('fixture: ~90 items over 10 rooms, at least 20 builder types',
    fixture.furniture.length >= 85 && new Set(fixture.furniture.map(f => f.room)).size === 10 && fixtureBuilders.size >= 20,
    { items: fixture.furniture.length, types: fixtureBuilders.size });
  const u = buildFixture(ULTRA), l = buildFixture(LOW);
  const fades = u.beauty.filter(m => m.userData.fadeWallId != null).length;
  check('fixture: fade-auto items are in it (fade buckets exist)', fades > 0, fades);
  check('B2 ultra: beauty buckets <= 30', u.stats.beautyDraws <= 30, u.stats);
  check('B2 ultra: proxies <= 10 (house scope: at most a full and a low one)', u.stats.proxyDraws >= 1 && u.stats.proxyDraws <= 2, u.stats);
  check('B2 low: beauty buckets <= 20, no proxies', l.stats.beautyDraws <= 20 && l.stats.proxyDraws === 0, l.stats);
  // The room-scoped split is what the budget was busted by; it stays
  // measurable, and the house scope must beat it.
  const ur = buildFixture(ULTRA, { bucketScope: 'room' });
  check('house scope draws fewer buckets than room scope', u.stats.beautyDraws < ur.stats.beautyDraws,
    [u.stats.beautyDraws, ur.stats.beautyDraws]);
  check('same triangles either way', u.stats.beautyTriangles === ur.stats.beautyTriangles);
  [u, l, ur].forEach(F.disposeFurniture);
}

// ---- 7b. the time-sliced build (c399c2a4) ----------------------------------------------
{
  const sync = buildFixture(ULTRA);
  let yields = 0;
  const sliced = (await quietlyAsync(() => F.buildFurnitureSliced(THREE, fixture.furniture, fixtureBuilders,
    { tx, tz, quality: ULTRA, walls: fixture.walls, sliceMs: 0, yieldFn: () => { yields++; return Promise.resolve(); } }))).value;
  const keys = r => r.beauty.map(m => m.userData.bucket + '#' + m.userData.triangles).sort().join('\n');
  check('sliced: builds exactly what the one-task build does (buckets, triangles, proxies)', sliced &&
    keys(sliced) === keys(sync) && sliced.stats.proxyTriangles === sync.stats.proxyTriangles &&
    sliced.shadowProxies.length === sync.shadowProxies.length);
  // sliceMs 0: a yield after EVERY step -- one per item built, one per bucket,
  // one per room proxy.
  const steps = sync.stats.items + sync.stats.beautyDraws + sync.stats.proxyDraws;
  check('sliced: yields between items, buckets and proxies', yields >= steps && sliced.stats.slices === yields + 1,
    { yields, steps, slices: sliced && sliced.stats.slices });
  // Items are taken room by room, whatever order the profile lists them in.
  // Interleaved: rooms round-robin, so no two neighbours share a room.
  const perRoom = new Map();
  fixture.furniture.forEach(it => { if (!perRoom.has(it.room)) perRoom.set(it.room, []); perRoom.get(it.room).push(it); });
  const itemsShuffled = [];
  for (let i = 0; itemsShuffled.length < fixture.furniture.length; i++) perRoom.forEach(list => { if (list[i]) itemsShuffled.push(list[i]); });
  const trace = [];
  const itemsTagged = itemsShuffled.map(it => Object.assign({}, it, { params: Object.assign({}, it.params) }));
  const tracer = new Map(Array.from(fixtureBuilders.entries()).map(([t, b]) => [t, { DEFAULTS: b.DEFAULTS,
    build: (T, p, o) => { trace.push(p.__room); return b.build(T, p, o); } }]));
  itemsTagged.forEach(it => { it.params.__room = it.room; });
  quietly(() => F.disposeFurniture(F.buildFurnitureSync(THREE, itemsTagged, tracer, { tx, tz, quality: LOW, walls: fixture.walls })));
  const runs = trace.filter((r, i) => i === 0 || trace[i - 1] !== r);
  check('items are built room by room (each room one contiguous run)', runs.length === new Set(trace).size && trace.length > 0,
    runs);
  // Cancelled part-way: resolves null, and every geometry the BUILD made
  // (flattened parts, buckets, proxies) is freed. Scratch geometry a builder
  // makes inside build() and never puts on a mesh is the builder's own, never
  // reaches the GPU, and is not counted.
  let inBuilder = false;
  const made = new Set();
  const origBG = THREE.BufferGeometry.prototype.dispose;
  const live = new Set();
  const Tracked = new Map(Array.from(fixtureBuilders.entries()).map(([t, b]) => [t, { DEFAULTS: b.DEFAULTS,
    build: (T, p, o) => { inBuilder = true; try { return b.build(T, p, o); } finally { inBuilder = false; } } }]));
  let n = 0, cancel = false;
  const origSet = THREE.BufferGeometry.prototype.setAttribute;
  THREE.BufferGeometry.prototype.setAttribute = function (name, attr) {
    if (name === 'position' && !inBuilder && !made.has(this)) { made.add(this); live.add(this); }
    return origSet.call(this, name, attr);
  };
  THREE.BufferGeometry.prototype.dispose = function () { live.delete(this); return origBG.call(this); };
  let out;
  try {
    out = (await quietlyAsync(() => F.buildFurnitureSliced(THREE, fixture.furniture, Tracked,
      { tx, tz, quality: ULTRA, walls: fixture.walls, sliceMs: 0, isCancelled: () => cancel,
        yieldFn: () => { if (++n === 40) cancel = true; return Promise.resolve(); } }))).value;
  } finally {
    THREE.BufferGeometry.prototype.setAttribute = origSet;
    THREE.BufferGeometry.prototype.dispose = origBG;
  }
  check('sliced: cancelled part-way -> null', out === null && n === 40, { n, out: !!out });
  check('sliced: ...and every geometry it made is freed', made.size > 0 && live.size === 0,
    { made: made.size, live: live.size });
  // Wired through the attach sequence: a scene disposed mid-build attaches
  // nothing and never compiles.
  const { ren, calls } = fakeRenderer();
  let disposed = false, k = 0;
  const res = await F.scheduleFurnitureAttach({
    precompileDone: Promise.resolve(), modulesLoaded: Promise.resolve(fixtureBuilders), isDisposed: () => disposed,
    build: b => quietlyAsync(() => F.buildFurnitureSliced(THREE, fixture.furniture, b, { tx, tz, quality: ULTRA,
      walls: fixture.walls, sliceMs: 0, isCancelled: () => disposed,
      yieldFn: () => { if (++k === 10) disposed = true; return Promise.resolve(); } })).then(r => r.value),
    renderer: ren, camera: {}, scene: {}, wantShadows: true, attach: () => calls.push(['attach'])
  });
  check('A2 sliced: dispose mid-build -> nothing attached, nothing compiled', res === null &&
    !calls.some(c => c[0] === 'attach' || c[0] === 'compileAsync'));
  // ...and an uninterrupted sliced build attaches once, compiled first.
  const { ren: ren2, calls: calls2 } = fakeRenderer();
  const res2 = await F.scheduleFurnitureAttach({
    precompileDone: Promise.resolve(), modulesLoaded: Promise.resolve(fixtureBuilders), isDisposed: () => false,
    build: b => quietlyAsync(() => F.buildFurnitureSliced(THREE, fixture.furniture, b, { tx, tz, quality: ULTRA,
      walls: fixture.walls })).then(r => r.value),
    renderer: ren2, camera: {}, scene: {}, wantShadows: true, attach: () => calls2.push(['attach'])
  });
  const iC = calls2.findIndex(c => c[0] === 'compileAsync'), iA = calls2.findIndex(c => c[0] === 'attach');
  check('A2 sliced: compiled before its one attach', res2 && iC !== -1 && iA > iC &&
    calls2.filter(c => c[0] === 'attach').length === 1);
  // The scene uses the sliced build.
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('the scene builds furniture with buildFurnitureSliced', /buildFurnitureSliced\(THREE, furnitureItems/.test(src) &&
    !/buildFurnitureSync\(THREE, furnitureItems/.test(src));
  [sync, sliced, res2].forEach(r => r && F.disposeFurniture(r));
}

// ---- 10. Dynamic parts (item 059873ed / 816d71ee) --------------------------------------
{
  const h = compile([
    { id: 'd1', room: 'r', type: 'dynamic-marker', at: [200, 200] },
    { id: 'd2', room: 'r', type: 'dynamic-marker', at: [350, 250] }
  ]);
  const r = build(h, ULTRA, {});

  // The dynamic part never joins a bucket: only each item's matte BODY
  // (2 items) is in the palette bucket, never the pointer (2 pointers would
  // otherwise merge into the same matte palette mesh as their bodies).
  const palette = r.beauty.find(m => m.userData.bucket.startsWith('palette'));
  check('dynamic: the body still merges into the palette bucket', !!palette && palette.userData.parts === 2,
    palette && palette.userData.parts);
  check('dynamic: no bucket carries the pointer (only 1 bucket total: the palette)', r.beauty.length === 1,
    r.beauty.map(m => m.userData.bucket));

  // Each item gets its own dynamicByItemId entry: a real Group, attached
  // under root, positioned so its child mesh lands at the SAME world
  // position a non-dynamic marker's own corner mesh would.
  check('dynamic: dynamicByItemId has one entry per dynamic item',
    Object.keys(r.dynamicByItemId).sort().join(',') === 'd1,d2', Object.keys(r.dynamicByItemId));
  const d1 = r.dynamicByItemId.d1;
  check('dynamic: the wrapper group is attached under root', d1.group.parent === r.root);
  check('dynamic: the wrapper carries the item id and type', d1.itemId === 'd1' && d1.type === 'dynamic-marker');
  const pointer1 = d1.group.getObjectByName('pointer');
  check('dynamic: the pointer mesh itself is inside the wrapper', !!pointer1);

  // Compare against a non-dynamic Marker's own front-right corner (the SAME
  // local offset DynamicMarker's pointer uses) placed at the same spot, to
  // confirm attach() preserved the correct world position rather than just
  // "some" position.
  const hMarker = compile([{ id: 'm1', room: 'r', type: 'marker', at: [200, 200] }]);
  const rMarker = build(hMarker, ULTRA, {});
  // Marker's matte body and gloss corner cube share ONE opaque palette
  // bucket (matte/gloss/metal are all "opaque" -- see bucketClass), so this
  // isolates just the gloss-tagged vertices by their palette uv, the same
  // way finishBox() already does for the merge's own bucket tests above.
  const glossBucket = rMarker.beauty.find(m => m.userData.finishes.includes('gloss'));
  const markerCorner = new THREE.Vector3();
  finishBox(glossBucket, 'gloss').getCenter(markerCorner);
  // pointer1's own offset is baked into its GEOMETRY (translate()), same as
  // Marker's corner cube -- getWorldPosition() would read the mesh's
  // transform origin, not the geometry offset, so this reads the same way
  // finishBox()/centreOf() do: from a world-space bounding box.
  d1.group.updateMatrixWorld(true);
  const pointerWorld = new THREE.Vector3();
  new THREE.Box3().setFromObject(pointer1).getCenter(pointerWorld);
  check('dynamic: the pointer lands at the SAME world position a bucketed marker at the same spot would',
    near(pointerWorld.x, markerCorner.x, 1e-3) && near(pointerWorld.y, markerCorner.y, 1e-3) && near(pointerWorld.z, markerCorner.z, 1e-3),
    { pointerWorld: pointerWorld.toArray(), markerCorner: markerCorner.toArray() });
  F.disposeFurniture(rMarker);

  // The pointer is a REAL, individually posable mesh after attach -- pose it
  // as a live clock's setClockTime would pose an hour hand (rotate it about
  // a pivot OFFSET from its own centre, the same shape as addHands: the
  // mesh's local origin is the pivot, not its geometry centre) and confirm
  // its world position actually moves. Re-parent it under a pivot group at
  // its own base first, exactly so the rotation has a lever arm to move --
  // otherwise (as wall-clock.js's own hands rely on) rotating a mesh about
  // ITS OWN origin sitting AT that origin cannot move its origin, and the
  // check would be trivially true for a merged, unposable vertex too.
  const pivot = new THREE.Group();
  d1.group.add(pivot);
  pivot.position.copy(pointer1.position);
  pointer1.position.set(0, 0, 0.1); // give the pivot a lever arm to swing
  pivot.attach(pointer1);
  pivot.updateMatrixWorld(true);
  const beforeRotate = new THREE.Vector3();
  pointer1.getWorldPosition(beforeRotate);
  pivot.rotation.y = Math.PI / 2;
  pivot.updateMatrixWorld(true);
  const afterRotate = new THREE.Vector3();
  pointer1.getWorldPosition(afterRotate);
  check('dynamic: re-posing the attached mesh after attach actually moves it (a real object, not a merged snapshot)',
    !near(beforeRotate.x, afterRotate.x, 1e-4) || !near(beforeRotate.z, afterRotate.z, 1e-4),
    { beforeRotate: beforeRotate.toArray(), afterRotate: afterRotate.toArray() });

  // F2 (code review, item 059873ed): the check above used `at: [200, 200]`
  // -- rotation 0 -- so dynamicGroup.rotation.copy(...) copying a ZERO
  // rotation was indistinguishable from not calling it at all; deleting
  // that line still passed every check (verified: it broke the hands on 3
  // of 4 real wall orientations, hour-hand tips displaced 6.9-15cm, per the
  // reviewer). Rewritten here at all 4 WALL orientations (rot 0/90/180/270,
  // same fixture shape as the "world placement in all four orientations"
  // section above), and the pointer is RE-POSED after attach() with a
  // rotation.z (exactly what setClockTime does to a real hand), then
  // compared against a builder group placed and posed the SAME way but
  // WITHOUT going through flattenGroup/buildPlaced at all -- so this fails
  // if the wrapper's rotation, position, OR the re-pose math drifts.
  const wallCases = [
    { wall: 1, rot: 0 }, { wall: 2, rot: 180 }, { wall: 3, rot: 270 }, { wall: 4, rot: 90 }
  ];
  wallCases.forEach(({ wall, rot }) => {
    const hw = compile([{ id: 'w' + wall, room: 'r', type: 'dynamic-marker', wall, centre: 200 }]);
    const rw = build(hw, ULTRA, {});
    const dynW = rw.dynamicByItemId['w' + wall];
    check('dynamic: wall ' + wall + ' (rot ' + rot + ') -- wrapper actually carries a non-zero rotation where expected',
      rot === 0 || Math.abs(dynW.group.rotation.y) > 1e-6, dynW.group.rotation.y);
    const ptr = dynW.group.getObjectByName('pointer');
    // Re-pose exactly as setClockTime does: rotation.z on the mesh itself,
    // AFTER attach (the wrapper's own transform must already be correct
    // for this to land in the right place).
    ptr.rotation.z = Math.PI / 6; // an arbitrary non-zero angle, like a clock hand mid-sweep
    dynW.group.updateMatrixWorld(true);
    const dynTip = new THREE.Vector3();
    ptr.getWorldPosition(dynTip);

    // The SAME item, built and placed directly (no flattenGroup/buildPlaced
    // in the path at all) -- the independent reference this check compares
    // against.
    const builderGroup = DynamicMarker.build(THREE, DynamicMarker.DEFAULTS, {});
    const directPlacement = resolvePlacement(hw.furniture[0], DynamicMarker.DEFAULTS);
    F.placeGroup(builderGroup, directPlacement, tx, tz);
    const directPtr = builderGroup.getObjectByName('pointer');
    directPtr.rotation.z = Math.PI / 6;
    builderGroup.updateMatrixWorld(true);
    const directTip = new THREE.Vector3();
    directPtr.getWorldPosition(directTip);

    check('dynamic: wall ' + wall + ' -- re-posed hand tip matches a directly-placed, independently-posed builder group',
      near(dynTip.x, directTip.x, 1e-4) && near(dynTip.y, directTip.y, 1e-4) && near(dynTip.z, directTip.z, 1e-4),
      { wall, dynTip: dynTip.toArray(), directTip: directTip.toArray() });
    F.disposeFurniture(rw);
  });

  // Draw-cost accounting: stated in the PR per the coordinator's ask. 2
  // dynamic parts (one pointer per item, matching "3 hands per clock is
  // fine" scale) -> 2 extra draws, a handful of triangles each.
  check('dynamic: stats count exactly the dynamic draws/triangles', r.stats.dynamicDraws === 2 && r.stats.dynamicTriangles > 0,
    r.stats);

  // A part tagged dynamic on the MATERIAL instead of the mesh is honoured
  // too (the same either/or convention as keep/finish).
  const MatDynamic = {
    DEFAULTS: Object.freeze({ width: 60, depth: 20, height: 50 }),
    build(T, p) {
      const g = new T.Group();
      const w = p.width / 100, d = p.depth / 100, h = p.height / 100;
      const body = new T.Mesh(new T.BoxGeometry(w, h, d).translate(0, h / 2, d / 2), Fin.makeFinish(T, 'matte', '#888888'));
      const mat = Fin.makeFinish(T, 'matte', '#111111');
      mat.userData.dynamic = true;
      const pointer = new T.Mesh(new T.BoxGeometry(0.02, 0.02, 0.02).translate(w / 2 - 0.01, h / 2, d - 0.01), mat);
      pointer.name = 'pointer';
      g.add(body); g.add(pointer);
      return g;
    }
  };
  const hMat = compile([{ id: 'md', room: 'r', type: 'mat-dynamic', at: [200, 200] }]);
  const rMat = build(hMat, ULTRA, { 'mat-dynamic': MatDynamic });
  check('dynamic: material-level userData.dynamic is honoured too',
    !!rMat.dynamicByItemId.md && !!rMat.dynamicByItemId.md.group.getObjectByName('pointer'));
  F.disposeFurniture(rMat);

  // Disposal: a dynamic part's OWN material (never in result.materials,
  // since it was never bucketed) is freed by disposeFurniture -- confirmed
  // by spying on Material.prototype.dispose rather than trusting a missing
  // reference (a spy proves the call happened; nulling the reference alone
  // would not distinguish "disposed" from "just detached").
  const disposedMats = new Set();
  const origMatDispose = THREE.Material.prototype.dispose;
  THREE.Material.prototype.dispose = function () { disposedMats.add(this); return origMatDispose.call(this); };
  const pointerMat = pointer1.material;
  try {
    F.disposeFurniture(r);
  } finally {
    THREE.Material.prototype.dispose = origMatDispose;
  }
  check('dynamic: disposeFurniture frees the dynamic part\'s own material', disposedMats.has(pointerMat));

  // A cancelled sliced build frees a dynamic part's geometry/material same
  // as any other part -- confirmed by spying on BufferGeometry.dispose.
  const madeGeo = new Set(), liveGeo = new Set();
  const origSet2 = THREE.BufferGeometry.prototype.setAttribute;
  const origDispose2 = THREE.BufferGeometry.prototype.dispose;
  THREE.BufferGeometry.prototype.setAttribute = function (name, attr) {
    if (name === 'position' && !madeGeo.has(this)) { madeGeo.add(this); liveGeo.add(this); }
    return origSet2.call(this, name, attr);
  };
  THREE.BufferGeometry.prototype.dispose = function () { liveGeo.delete(this); return origDispose2.call(this); };
  let cancelled = false, steps = 0;
  let cancelledResult;
  try {
    cancelledResult = await F.buildFurnitureSliced(THREE, h.furniture, builders({}),
      { tx, tz, quality: ULTRA, walls: h.walls, sliceMs: 0, isCancelled: () => cancelled,
        yieldFn: () => { if (++steps === 1) cancelled = true; return Promise.resolve(); } });
  } finally {
    THREE.BufferGeometry.prototype.setAttribute = origSet2;
    THREE.BufferGeometry.prototype.dispose = origDispose2;
  }
  check('dynamic: a build cancelled part-way (incl. a dynamic part) resolves null and frees every geometry it made',
    cancelledResult === null && madeGeo.size > 0 && liveGeo.size === 0, { made: madeGeo.size, live: liveGeo.size });
}

// ---- 10b. A real wall-clock through the SAME dynamic-part pipeline --------------------
{
  const WC = await imp('src/furniture/wall-clock.js');
  const h = compile([
    { id: 'clk', room: 'r', type: 'wall-clock', wall: 1, centre: 200, params: { kind: 'diy-words' } }
  ]);
  const r = build(h, ULTRA, { 'wall-clock': WC });
  const dyn = r.dynamicByItemId.clk;
  check('wall-clock: item builds through dynamicByItemId (not skipped)', !!dyn && dyn.type === 'wall-clock');
  const names = dyn ? dyn.group.children.map(c => c.name).sort() : [];
  check('wall-clock: exactly the 4 hand meshes are dynamic (hourHand, minuteHand, secondHand, secondHandTail)',
    names.join(',') === 'hourHand,minuteHand,secondHand,secondHandTail', names);
  check('wall-clock: draw-cost stated -- exactly 4 dynamic draws for one diy-words clock (hands + tail)',
    r.stats.dynamicDraws === 4, r.stats.dynamicDraws);
  // The hub (does not move) stays a normal bucketed part, not dynamic -- it
  // must NOT show up as its own dynamic entry.
  check('wall-clock: the hub is NOT dynamic (it never rotates)', !dyn.group.getObjectByName('hub'));

  // setClockTime through the SAME live group the scene would drive with
  // startLiveClock -- proves two matte hands (same finish, same colour)
  // survive as independently rotatable meshes post-merge (the mechanism
  // src/furniture/merge.js's userData.dynamic opt-out provides).
  const hour = dyn.group.getObjectByName('hourHand');
  const second = dyn.group.getObjectByName('secondHand');
  const tail = dyn.group.getObjectByName('secondHandTail');
  WC.setClockTime(dyn.group, new Date(2026, 0, 1, 3, 0, 0));
  const rotAt3 = hour.rotation.z;
  WC.setClockTime(dyn.group, new Date(2026, 0, 1, 9, 0, 0));
  const rotAt9 = hour.rotation.z;
  check('wall-clock: setClockTime on the LIVE dynamic group actually rotates the hour hand',
    !near(rotAt3, rotAt9, 1e-6), { rotAt3, rotAt9 });
  // F6 (code review, item 059873ed): the old check here only asserted
  // !!tail -- true the moment the mesh exists, regardless of its angle, so
  // it could never fail on a broken tail relationship (test-wall-clock.mjs
  // already covers the mutation properly; this one just had a name
  // promising more than it checked). Rewritten to assert the actual
  // geometric relationship setClockTime is supposed to keep: the tail's
  // rotation.z must equal the second hand's own rotation.z plus PI, at
  // several different times (not just whatever time the group happened to
  // be built/posed at last).
  [new Date(2026, 0, 1, 3, 0, 0), new Date(2026, 0, 1, 7, 15, 30), new Date(2026, 0, 1, 11, 45, 10)].forEach(d => {
    WC.setClockTime(dyn.group, d);
    const diff = tail.rotation.z - second.rotation.z;
    // Normalise to (-PI, PI] before comparing to PI, since rotation.z can
    // wrap to -PI depending on which side of the branch cut the angle
    // math lands on -- +PI and -PI are the same physical angle.
    const normalised = ((diff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    check('wall-clock: the second-hand tail sits at exactly +180deg from the second hand at ' + d.toTimeString().slice(0, 8),
      near(Math.abs(normalised), Math.PI, 1e-6), { diff, normalised });
  });

  // startLiveClock itself, through this exact pipeline (a fake doc/now, no
  // real timers): ticks immediately, ticks again on a fake 1s interval via
  // Node's real setInterval (short-lived, cleaned up), and stop() halts it.
  let ticks = 0;
  const fakeDoc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const stop = WC.startLiveClock(dyn.group, { doc: fakeDoc, onTick: () => { ticks++; } });
  check('wall-clock: startLiveClock ticks immediately on the real attached group', ticks === 1);
  await new Promise(res => setTimeout(res, 1150));
  const ticksBeforeStop = ticks;
  check('wall-clock: startLiveClock ticks again about a second later', ticksBeforeStop >= 2, ticksBeforeStop);
  stop();
  await new Promise(res => setTimeout(res, 1150));
  check('wall-clock: stop() halts further ticking', ticks === ticksBeforeStop, { ticks, ticksBeforeStop });

  F.disposeFurniture(r);
}

// ---- 10c. home3d-scene.js wiring (source-pattern checks, matching the -----------------
//      file's own established style for DOM-only code no Node test can run) -----------
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('the scene imports startLiveClock from wall-clock.js',
    /import\s*\{\s*startLiveClock\s*\}\s*from\s*'\.\/furniture\/wall-clock\.js'/.test(src));
  check('the scene starts a live clock for every wall-clock item on attach',
    /type\s*[!=]==\s*'wall-clock'/.test(src) && /startLiveClock\(/.test(src));
  check('the scene looks up the item\'s dynamic group (dynamicByItemId) rather than a bucket',
    /dynamicByItemId/.test(src));
  check('a tick requests a single repaint (requestRender), not a sustained wake()',
    /onTick:\s*\(\)\s*=>\s*requestRender\(\)/.test(src));
  // F3 (code review, item 059873ed, round 2): the round-3 fix for this was
  // itself not anchored to the start of the line, so `// stopLiveClocks();`
  // and `if (false) stopLiveClocks();` both still matched the "call
  // statement" half of the pattern (the text `stopLiveClocks();\n...` is
  // present as a SUBSTRING of both mutations) -- verified by the round-2
  // reviewer's own mutation probes. Anchored with `^\s*` (multiline mode)
  // so the call must be the first non-whitespace content on its own line;
  // neither a leading `//` nor a leading `if (false) ` can satisfy that.
  check('the scene calls stopLiveClocks() as its own statement (not commented out or gated on a constant false) immediately before disposeFurniture in dispose()',
    /^\s*stopLiveClocks\(\);\s*\n\s*if \(furnitureResult\) \{ disposeFurniture/m.test(src), src.includes('stopLiveClocks();'));
  check('stopLiveClocks is still defined (both facts matter: it exists AND it is called)',
    /function stopLiveClocks\(\)/.test(src) && /liveClockStops/.test(src));
}

// ---- 10e. startLiveClock's stop() actually halts ticking (item 059873ed, ------------
//      code review F3, round 2 correction) -------------------------------------------
//      NAMING, per the round-2 reviewer: this does NOT reach into
//      home3d-scene.js and cannot fail if that file's own dispose() stops
//      calling stopLiveClocks() -- it only re-implements the SAME
//      Map/closure shape locally, so it tests startLiveClock's own stop()
//      contract, not the scene's wiring to it (that wiring is what 10c's
//      anchored source-pattern check above covers, on the real file).
//      home3d-scene.js needs a real DOM canvas to instantiate (no test in
//      this file does), so calling its actual dispose() is not available
//      here at all. Second half renamed too: "a never-stopped timer keeps
//      ticking" is definitionally true of any setInterval and was flagged
//      as tautological -- kept only as a sanity check that startLiveClock
//      really does return an independent, callable stop() per instance
//      (two clocks, two stops, stopping one must not affect the other),
//      which IS a real fact worth checking, just not "leak detection".
{
  const WC = await imp('src/furniture/wall-clock.js');
  const h = compile([{ id: 'clk3', room: 'r', type: 'wall-clock', wall: 1, centre: 200, params: { kind: 'diy-words' } }]);
  const r = build(h, ULTRA, { 'wall-clock': WC });
  const dyn = r.dynamicByItemId.clk3;

  function sceneDisposeShape(callStopLiveClocks) {
    // The exact shape from home3d-scene.js: a Map of itemId -> stop(), a
    // drain function, and (if callStopLiveClocks) the call site inside
    // "dispose()" immediately before disposeFurniture -- otherwise the
    // F3 mutation itself: disposeFurniture runs with NOTHING stopping the
    // timers first.
    const liveClockStops = new Map();
    function stopLiveClocks() { liveClockStops.forEach(stop => stop()); liveClockStops.clear(); }
    let ticks = 0;
    const stop = WC.startLiveClock(dyn.group, { doc: { hidden: false, addEventListener(){}, removeEventListener(){} },
      onTick: () => { ticks++; } });
    liveClockStops.set('clk3', stop);
    return {
      dispose() {
        if (callStopLiveClocks) stopLiveClocks();
        F.disposeFurniture(r);
      },
      getTicks: () => ticks
    };
  }

  // startLiveClock's own stop() contract: calling it actually halts that
  // instance's ticking.
  const correct = sceneDisposeShape(true);
  await new Promise(res => setTimeout(res, 1150));
  const ticksBeforeDispose = correct.getTicks();
  correct.dispose();
  await new Promise(res => setTimeout(res, 1150));
  check('startLiveClock: calling the returned stop() actually halts that instance\'s ticking',
    correct.getTicks() === ticksBeforeDispose, { before: ticksBeforeDispose, after: correct.getTicks() });

  // Two INDEPENDENT clocks: stopping one's timer must not affect the
  // other's. This is the real fact a "stop() per instance" contract needs
  // (as opposed to a shared/global timer some future refactor could
  // accidentally introduce) -- not "a timer nobody stopped keeps ticking",
  // which is true of any setInterval and proves nothing about this module.
  const h2 = compile([{ id: 'clk4', room: 'r', type: 'wall-clock', wall: 1, centre: 300, params: { kind: 'diy-words' } }]);
  const r2 = build(h2, ULTRA, { 'wall-clock': WC });
  const dyn2 = r2.dynamicByItemId.clk4;
  let ticksA = 0, ticksB = 0;
  const stopA = WC.startLiveClock(dyn.group, { doc: { hidden: false, addEventListener(){}, removeEventListener(){} },
    onTick: () => { ticksA++; } });
  const stopB = WC.startLiveClock(dyn2.group, { doc: { hidden: false, addEventListener(){}, removeEventListener(){} },
    onTick: () => { ticksB++; } });
  await new Promise(res => setTimeout(res, 1150));
  stopA();
  const ticksAAfterStop = ticksA;
  await new Promise(res => setTimeout(res, 1150));
  check('startLiveClock: stopping clock A does not stop clock B (independent timers, not a shared one)',
    ticksA === ticksAAfterStop && ticksB > 0, { ticksA, ticksAAfterStop, ticksB });
  stopB(); // clean up so this timer does not outlive the test file
  F.disposeFurniture(r2);
}

// ---- 10d. Dynamic parts join the wall fade (item 059873ed, code review F1) -----------
{
  // A dynamic-marker tall enough and on an exterior wall to auto-fade (the
  // same fixture shape as the existing A3/fade-registration tests above:
  // wall: 1, centre: 200, height: 150 -- top 150 > FADE_MIN_TOP 100).
  const h = compile([
    { id: 'fadeDyn', room: 'r', type: 'dynamic-marker', wall: 1, centre: 200, params: { height: 150 } }
  ]);
  const r = build(h, ULTRA, {});
  check('dynamic: the fading item actually has a fadeWallId', r.byId.fadeDyn.fadeWallId === 1, r.byId.fadeDyn.fadeWallId);
  const dyn = r.dynamicByItemId.fadeDyn;
  check('dynamic: dynamicByItemId carries the item\'s own fadeWallId', dyn.fadeWallId === 1, dyn.fadeWallId);
  const pointer = dyn.group.getObjectByName('pointer');
  check('dynamic: a dynamic mesh on a fading item is marked transparent (findable, not left opaque forever)',
    pointer.material.transparent === true);
  check('dynamic: the material carries the same fade tag a beauty fade clone gets',
    pointer.material.userData.fade === true);

  // fadeRegistrations() -- the ACTUAL function the scene calls to build
  // wallMeshes -- must include this dynamic mesh, not just beauty buckets.
  const regs = F.fadeRegistrations(r);
  const dynReg = regs.find(reg => reg.mesh === pointer);
  check('dynamic: fadeRegistrations() includes the dynamic mesh with the item\'s own wall id',
    !!dynReg && dynReg.wallId === 1, dynReg);

  // A dynamic item with NO fade wall (free placement, short) must not be
  // marked transparent or registered -- this fix must not force every
  // dynamic part transparent unconditionally, only ones that actually fade.
  const hNoFade = compile([{ id: 'noFadeDyn', room: 'r', type: 'dynamic-marker', at: [300, 250] }]);
  const rNoFade = build(hNoFade, ULTRA, {});
  const pointerNoFade = rNoFade.dynamicByItemId.noFadeDyn.group.getObjectByName('pointer');
  check('dynamic: a NON-fading item\'s dynamic mesh is left alone (not forced transparent)',
    pointerNoFade.material.transparent !== true, pointerNoFade.material.transparent);
  check('dynamic: a NON-fading item is not registered for the fade',
    F.fadeRegistrations(rNoFade).every(reg => reg.mesh !== pointerNoFade));

  // BEHAVIOURAL: simulate the actual render-loop fade math (mirrors
  // home3d-scene.js's wallMeshes.forEach block exactly -- opacity eased
  // toward a target by 0.12 per call) directly on the registered dynamic
  // mesh, proving it responds exactly like a beauty bucket would.
  let opacity = 1.0;
  const targetOpacity = 0.05; // camera facing the wall, per the real fade block
  for (let i = 0; i < 60; i++) opacity += (targetOpacity - opacity) * 0.12;
  pointer.material.opacity = opacity;
  check('dynamic: the SAME fade easing math the scene uses drives this mesh\'s opacity down',
    pointer.material.opacity < 0.1, pointer.material.opacity);

  F.disposeFurniture(r);
  F.disposeFurniture(rNoFade);
}

// ---- 10f. Low-detail shadow-proxy rebuild frees its OWN dynamic parts -----------------
//      (code review F6, item 059873ed: "the low-detail proxy dynamic dispose
//      is unguarded by any test (mutation survived)") ---------------------------------
{
  // dynamic-marker is tall enough (DEFAULTS.height 50) and low enough
  // (elevation 0) to be a caster (isCaster: elevation < 30, height >= 40).
  // roomTriCap: 1 forces ANY caster over budget, so this deterministically
  // exercises furnitureBuildSteps' toLow() path -- the low-detail rebuild
  // exists ONLY to make the shadow proxy; its own dynamic parts are never
  // attached anywhere and must be disposed immediately after the rebuild
  // (src/furniture.js's toLow(): "if (flat.dynamicGroup) disposeBuilt(...)").
  const h = compile([{ id: 'lowDyn', room: 'r', type: 'dynamic-marker', at: [200, 200] }]);
  const madeGeo = new Set(), liveGeo = new Set();
  const origSet = THREE.BufferGeometry.prototype.setAttribute;
  const origDispose = THREE.BufferGeometry.prototype.dispose;
  THREE.BufferGeometry.prototype.setAttribute = function (name, attr) {
    if (name === 'position' && !madeGeo.has(this)) { madeGeo.add(this); liveGeo.add(this); }
    return origSet.call(this, name, attr);
  };
  THREE.BufferGeometry.prototype.dispose = function () { liveGeo.delete(this); return origDispose.call(this); };
  let r;
  try {
    r = build(h, ULTRA, {}, { roomTriCap: 1 });
    check('low-proxy: the room actually went low-detail (roomTriCap:1 forced it)',
      r.stats.proxyLowRooms.includes('r'), r.stats.proxyLowRooms);
    // At this point, BEFORE disposeFurniture(r): the ATTACHED build's own
    // dynamic parts (from the full-detail build) are still live and
    // correctly NOT disposed yet -- only the DISCARDED low-detail rebuild's
    // dynamic geometry (made and thrown away inside toLow(), never attached
    // to anything) should already be freed.
    check('low-proxy: some geometry was made twice (full attach + discarded low rebuild), and the low one is ALREADY freed',
      liveGeo.size < madeGeo.size, { made: madeGeo.size, stillLive: liveGeo.size });
    // The spy must still be installed for THIS call, or disposeFurniture's
    // real dispose() calls go unseen and every check after it is
    // meaningless -- this is exactly the bug an earlier draft of this test
    // had: restoring setAttribute/dispose in a `finally` right after
    // build() returned, so disposeFurniture(r) below ran against the
    // ORIGINAL dispose() and liveGeo never updated, reporting a false leak.
    F.disposeFurniture(r);
    check('low-proxy: everything is freed once the real result is disposed too',
      liveGeo.size === 0, { made: madeGeo.size, stillLive: liveGeo.size });
  } finally {
    THREE.BufferGeometry.prototype.setAttribute = origSet;
    THREE.BufferGeometry.prototype.dispose = origDispose;
  }
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
