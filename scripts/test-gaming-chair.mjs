#!/usr/bin/env node
/**
 * Gaming chair builder (src/furniture/gaming-chair.js). No framework, no
 * install - `node scripts/test-gaming-chair.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. The furniture contract: metres, floor at y = 0, the chair's back at
 *      z = 0, x centred, front facing +z -- at EVERY recline, since reclining
 *      moves the rearmost point.
 *   2. The published size-L dimensions land in the geometry: seat width and
 *      depth, seat height (and that it moves the seat but not the base),
 *      backrest height and shoulder width, wheelbase diameter.
 *   3. Recline is an angle between the seat and the backrest, measured on the
 *      built geometry; the armrests do not recline with it.
 *   4. Colour placement: the colourway paints the seat and the backrest FRONT
 *      only; the back/sides, base, casters, armrests and lever stay black.
 *      A colour leaking onto the back is exactly the mistake a render hides
 *      from the front 3/4 view.
 *   5. 'low' detail is genuinely cheaper, and both stay inside a mobile budget.
 *   6. Adjustables clamp to the chair's real ranges; toFurnitureJSON emits
 *      only the keys that differ from DEFAULTS.
 *   7. DEFAULTS.width/height/depth (the furniture data layer's envelope) match
 *      the built bbox at the default pose within 0.5 cm.
 *
 * Builds real three.js geometry from the vendored module (plain ESM, no DOM).
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const C = await imp('src/furniture/gaming-chair.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const CM = 0.01;

function find(g, name) {
  const o = g.getObjectByName(name);
  if (!o) throw new Error('missing part ' + name);
  return o;
}
function bbox(o) { return new THREE.Box3().setFromObject(o); }
function union(g, names) {
  const b = new THREE.Box3();
  for (const n of names) b.union(bbox(find(g, n)));
  return b;
}
function tris(g) {
  let n = 0;
  g.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    n += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  });
  return n;
}
function worldVerts(o) {
  const out = [];
  o.updateMatrixWorld(true);
  o.traverse(m => {
    if (!m.isMesh) return;
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld));
  });
  return out;
}

// ---- 1. contract: exports + frame --------------------------------------------
check('TYPE', C.TYPE === 'gaming-chair', C.TYPE);
check('DEFAULTS frozen', Object.isFrozen(C.DEFAULTS));
check('buildGamingChair alias', C.buildGamingChair === C.build);

for (const reclineDeg of [90, 95, 120, 155]) {
  for (const detail of ['full', 'low']) {
    const g = C.build(THREE, { reclineDeg }, { detail });
    const b = bbox(g);
    const tag = `recline ${reclineDeg} ${detail}`;
    check(`${tag}: floor at y=0`, near(b.min.y, 0, 1e-6), b.min.y);
    check(`${tag}: back at z=0`, near(b.min.z, 0, 1e-6), b.min.z);
    check(`${tag}: x centred`, near(b.min.x + b.max.x, 0, 1e-6), [b.min.x, b.max.x]);
    // front faces +z: the seat's front edge is ahead of the backrest
    const seatFront = bbox(find(g, 'seatCushion')).max.z;
    const backZ = bbox(find(g, 'backrestBack')).getCenter(new THREE.Vector3()).z;
    check(`${tag}: seat front is +z of the backrest`, seatFront > backZ + 0.3, [seatFront, backZ]);
    check(`${tag}: userData.type`, g.userData.type === 'gaming-chair');
  }
}

// envelope: DEFAULTS width/height/depth match the built bbox at the default pose
for (const detail of ['full', 'low']) {
  const size = bbox(C.build(THREE, {}, { detail })).getSize(new THREE.Vector3());
  const D = C.DEFAULTS;
  for (const [k, v] of [['width', size.x], ['height', size.y], ['depth', size.z]]) {
    check(`DEFAULTS.${k} is a number`, typeof D[k] === 'number', D[k]);
    check(`${detail}: DEFAULTS.${k} matches the built bbox within 0.5 cm`, near(v, D[k] * CM, 0.005), [v * 100, D[k]]);
  }
}
check('default pose is recline 95 / seat 47', C.DEFAULTS.reclineDeg === 95 && C.DEFAULTS.seatHeight === 47);

// ---- 2. published dimensions -------------------------------------------------
{
  const g = C.build(THREE, { reclineDeg: 90 });
  const D = C.DEFAULTS;
  const seat = union(g, ['seatCushion', 'seatBolster_L', 'seatBolster_R']);
  check('seat width across bolsters', near(seat.max.x - seat.min.x, D.seatWidth * CM, 0.01), seat.max.x - seat.min.x);
  check('seat depth', near(seat.max.z - seat.min.z, D.seatDepth * CM, 0.01), seat.max.z - seat.min.z);
  const cushion = bbox(find(g, 'seatCushion'));
  check('seat height = cushion top', near(cushion.max.y, D.seatHeight * CM, 0.002), cushion.max.y);
  check('bolsters stand proud of the cushion', bbox(find(g, 'seatBolster_L')).max.y > cushion.max.y + 0.03);

  const back = union(g, ['backrestFront', 'backrestBack']);
  check('backrest height (upright)', near(back.max.y - back.min.y, D.backrestHeight * CM, 0.005), back.max.y - back.min.y);
  check('backrest shoulder width', near(back.max.x - back.min.x, D.backrestWidth * CM, 0.005), back.max.x - back.min.x);

  // shoulder wings: the backrest front is wider at the shoulders than at the lumbar
  const fv = worldVerts(find(g, 'backrestFront'));
  const y0 = back.min.y, H = back.max.y - back.min.y;
  const widthAt = f => {
    const band = fv.filter(v => Math.abs(v.y - (y0 + f * H)) < H * 0.03);
    return Math.max(...band.map(v => v.x)) - Math.min(...band.map(v => v.x));
  };
  check('racing silhouette: shoulders wider than the lumbar pinch', widthAt(0.66) > widthAt(0.28) + 0.05, [widthAt(0.66), widthAt(0.28)]);
  check('racing silhouette: head section narrower than the shoulders', widthAt(0.9) < widthAt(0.66) - 0.1, [widthAt(0.9), widthAt(0.66)]);
  // the wings wrap forward: the edges of the front surface sit ahead of its centre line
  const shoulderBand = fv.filter(v => Math.abs(v.y - (y0 + 0.66 * H)) < H * 0.03);
  const edgeZ = Math.max(...shoulderBand.map(v => v.z));
  const centreZ = shoulderBand.reduce((m, v) => (Math.abs(v.x) < Math.abs(m.x) ? v : m)).z;
  check('shoulder wings wrap forward', edgeZ - centreZ > 0.05, edgeZ - centreZ);

  // wheelbase: farthest base/caster point from the gas-lift axis
  const lift = bbox(find(g, 'gasLift')).getCenter(new THREE.Vector3());
  let r = 0;
  for (let i = 0; i < 5; i++) for (const v of worldVerts(find(g, 'baseArm_' + i))) r = Math.max(r, Math.hypot(v.x - lift.x, v.z - lift.z));
  check('wheelbase diameter', near(2 * r, D.baseDiameter * CM, 0.01), 2 * r);

  // five casters, twin wheels each, sitting on the floor
  for (let i = 0; i < 5; i++) {
    const wheels = find(g, 'caster_' + i).children.filter(c => c.name.startsWith('casterWheel_'));
    check(`caster ${i} is twin-wheel`, wheels.length === 2, wheels.length);
    check(`caster ${i} on the floor`, near(bbox(find(g, 'caster_' + i)).min.y, 0, 1e-6));
  }
}

// seat height moves the seat and armrests, not the base
{
  const lo = C.build(THREE, { seatHeight: 44.5 }), hi = C.build(THREE, { seatHeight: 51 });
  const dy = bbox(find(hi, 'seatCushion')).max.y - bbox(find(lo, 'seatCushion')).max.y;
  check('seat height travel 6.5 cm', near(dy, 0.065, 0.001), dy);
  const pdy = bbox(find(hi, 'armPad_L')).max.y - bbox(find(lo, 'armPad_L')).max.y;
  check('arm pads ride with the seat', near(pdy, 0.065, 0.001), pdy);
  check('base does not move', near(bbox(find(hi, 'baseHub')).max.y, bbox(find(lo, 'baseHub')).max.y, 1e-6));
  check('gas lift lengthens', bbox(find(hi, 'gasLift')).max.y - bbox(find(lo, 'gasLift')).max.y > 0.06);
}

// arm height is measured from the seat top
{
  const g = C.build(THREE, { armHeight: 30 });
  const d = bbox(find(g, 'armPad_R')).max.y - bbox(find(g, 'seatCushion')).max.y;
  check('arm pad top = seat top + armHeight', near(d, 0.30, 0.002), d);
}

// ---- 3. recline --------------------------------------------------------------
function reclineOf(g) {
  const p = new THREE.Vector3().fromArray(g.userData.pivot);
  const t = find(g, 'backrestTop').getWorldPosition(new THREE.Vector3());
  // angle between the seat (pointing +z, forward) and the backrest (pivot -> top)
  const v = t.sub(p).normalize();
  return Math.acos(Math.max(-1, Math.min(1, v.z))) * 180 / Math.PI;
}
for (const deg of [90, 110, 135, 155]) {
  const a = reclineOf(C.build(THREE, { reclineDeg: deg }));
  check(`recline ${deg} measured on geometry`, near(a, deg, 0.1), a);
}
{
  const up = C.build(THREE, { reclineDeg: 90 }), down = C.build(THREE, { reclineDeg: 155 });
  const topUp = find(up, 'backrestTop').getWorldPosition(new THREE.Vector3());
  const topDown = find(down, 'backrestTop').getWorldPosition(new THREE.Vector3());
  check('reclined backrest is lower', topDown.y < topUp.y - 0.3, [topUp.y, topDown.y]);
  // armrests do not recline: same position relative to the seat
  const rel = g => bbox(find(g, 'armPad_L')).getCenter(new THREE.Vector3()).sub(bbox(find(g, 'seatCushion')).getCenter(new THREE.Vector3()));
  check('armrests do not recline', rel(up).distanceTo(rel(down)) < 1e-6, [rel(up), rel(down)]);
  check('neck pillow reclines with the backrest', find(down, 'neckPillow').parent.name === 'backrestPivot');
}

// ---- 4. colour placement -----------------------------------------------------
{
  const PINK = C.PRESETS.pink.primaryColor, MINT = C.PRESETS.mint.primaryColor;
  check('presets are distinct colourways', PINK !== MINT);
  const g = C.build(THREE, { primaryColor: PINK });
  const hex = n => '#' + find(g, n).material.color.getHexString();
  const lum = n => { const c = find(g, n).material.color; return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };
  for (const n of ['seatCushion', 'seatBolster_L', 'seatBolster_R', 'backrestFront']) {
    check(`${n} carries the colourway`, hex(n) === PINK, hex(n));
  }
  const black = ['backrestBack', 'backrestSides', 'armPad_L', 'armPad_R', 'armPost_L', 'armPost_R',
                 'reclineLever', 'baseHub', 'baseLeg_0', 'casterWheel_0_L', 'gasLift', 'neckPillow'];
  for (const n of black) {
    check(`${n} is black`, lum(n) < 0.02, hex(n));
    check(`${n} material comes from makeFinish`, find(g, n).material.userData.finish === find(g, n).userData.finish, n);
    check(`${n} is not the colourway`, hex(n) !== PINK, hex(n));
  }
  check('back panel follows backColor', (() => {
    const g2 = C.build(THREE, { backColor: '#223344' });
    return '#' + find(g2, 'backrestBack').material.color.getHexString() === '#223344'
        && '#' + find(g2, 'backrestSides').material.color.getHexString() === '#223344';
  })());
  // the colourway surface faces FORWARD and the black one faces back
  const n = new THREE.Vector3();
  const front = find(g, 'backrestFront').geometry, back = find(g, 'backrestBack').geometry;
  front.computeVertexNormals(); back.computeVertexNormals();
  let fz = 0, bz = 0;
  for (let i = 0; i < front.attributes.normal.count; i++) fz += n.fromBufferAttribute(front.attributes.normal, i).z;
  for (let i = 0; i < back.attributes.normal.count; i++) bz += n.fromBufferAttribute(back.attributes.normal, i).z;
  check('backrest front faces +z', fz > 0, fz);
  check('backrest back faces -z', bz < 0, bz);
  // pillow wordmark is white; logo + embossed wordmark are a darker tone of the colourway
  check('pillow wordmark is white', '#' + find(g, 'pillowWordmark').material.color.getHexString() === C.DEFAULTS.labelColor.toLowerCase());
  // merge fidelity: flat colours from the finish set, small marks kept separate
  const finishes = new Set();
  let meshes = 0, textured = 0, unfinished = [];
  g.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    if (!C.FINISHES.includes(o.userData.finish)) unfinished.push(o.name);
    finishes.add(o.userData.finish);
    for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'alphaMap']) if (o.material[k]) textured++;
  });
  check('every mesh has a finish from the set', meshes > 0 && unfinished.length === 0, unfinished);
  check('no textures anywhere', textured === 0, textured);
  check('leather is gloss, the back is matte, the gas lift is metal',
    find(g, 'seatCushion').userData.finish === 'gloss' && find(g, 'backrestBack').userData.finish === 'matte'
    && find(g, 'gasLift').userData.finish === 'metal', [...finishes]);
  for (const n of ['backrestLogo', 'backrestWordmark', 'pillowWordmark']) {
    check(`${n} is kept separate`, find(g, n).userData.keep === true);
  }
  check('bulk parts are mergeable', !find(g, 'seatCushion').userData.keep && !find(g, 'baseLeg_0').userData.keep);
  const logo = find(g, 'backrestLogo').material.color, prim = new THREE.Color(PINK);
  check('logo is a darker tone of the colourway', logo.r < prim.r && logo.g < prim.g && logo.b < prim.b && near(logo.r / prim.r, logo.g / prim.g, 0.02)); // 8-bit hex rounding via makeFinish
}

// ---- 5. detail levels + budget -----------------------------------------------
{
  const full = C.build(THREE, {}, { detail: 'full' });
  const low = C.build(THREE, {}, { detail: 'low' });
  const tf = tris(full), tl = tris(low);
  check("'low' has fewer triangles than 'full'", tl < tf * 0.6, [tl, tf]);
  check('full stays within a mobile budget', tf < 8000, tf);
  check("'low' drops the logo and wordmarks", !low.getObjectByName('backrestLogo') && !low.getObjectByName('pillowWordmark') && !low.getObjectByName('lumbarKnob_L'));
  check("'low' keeps single-wheel casters", find(low, 'caster_0').children.length === 1);
  check("'low' keeps the dimensions", near(bbox(low).max.y, bbox(full).max.y, 0.005), [bbox(low).max.y, bbox(full).max.y]);
  check("default detail is 'full'", C.build(THREE).userData.detail === 'full');
}

// ---- 6. clamping + JSON ------------------------------------------------------
{
  const p = C.resolveParams({ seatHeight: 30, reclineDeg: 200, armHeight: -5 });
  check('seat height clamps low', p.seatHeight === 44.5, p.seatHeight);
  check('recline clamps high', p.reclineDeg === 155, p.reclineDeg);
  check('arm height clamps low', p.armHeight === 20, p.armHeight);
  check('non-numeric falls back to default', C.resolveParams({ seatHeight: 'x' }).seatHeight === C.DEFAULTS.seatHeight);
  const j = C.toFurnitureJSON(Object.assign({}, C.DEFAULTS, { primaryColor: '#e9a3ab', reclineDeg: 120 }));
  check('furniture JSON type', j.type === 'gaming-chair');
  check('furniture JSON only differing keys', JSON.stringify(j.params) === JSON.stringify({ primaryColor: '#e9a3ab', reclineDeg: 120 }), j.params);
}

console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
