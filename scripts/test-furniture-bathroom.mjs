#!/usr/bin/env node
/**
 * Bathroom fittings (src/furniture/bathroom.js): every generic preset meets
 * the builder contract, stays inside its triangle caps, and the geometry does
 * what the params say. No framework, no install:
 * `node scripts/test-furniture-bathroom.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks every type at its DEFAULTS;
 * this file adds the PRESETS, the caps, and the behaviour of each builder:
 *   - loft winding: the ceramic skins are single-sided, so a flipped winding
 *     would render them inside-out -- the outer wall must face out, a bowl
 *     floor up and a basin's underside down
 *   - vanity-counter: the countertop is notched round the basin, the basin
 *     never pokes into the counter below the countertop, basinAt is measured
 *     from the left end, and vanityEnvelope() agrees with what is built
 *   - toilet: the flush plate's top is `height`, the seat sits on seatHeight
 *   - shower-set: showerSetEnvelope() agrees with what is built; the valve and
 *     riser land where their floor heights and offset say
 *   - shower-screen: doors, handles, jambs and mullions on the right sides
 *   - bathtub: the plug follows wasteEnd; towel-rail: rung count
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const B = await imp('src/furniture/bathroom.js');
const Fin = await imp('src/furniture/finishes.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.5 : tol);

function bboxCm(obj) {
  let top = obj;
  while (top.parent) top = top.parent;   // a part's box needs its parents' matrices too
  top.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return { minX: b.min.x * 100, maxX: b.max.x * 100, minY: b.min.y * 100, maxY: b.max.y * 100, minZ: b.min.z * 100, maxZ: b.max.z * 100 };
}
function triangles(group) {
  let n = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return n;
}
function named(group, name) {
  const out = [];
  group.traverse(o => { if (o.isMesh && o.name === name) out.push(o); });
  return out;
}
function build(type, params, detail) {
  const T = B.TYPES[type];
  return T.build(THREE, Object.assign({}, T.DEFAULTS, params), { detail: detail || 'full' });
}

// ---- 1. every preset: the contract, the caps, no lights ------------------------
for (const [name, preset] of Object.entries(B.PRESETS)) {
  const T = B.TYPES[preset.type];
  check(name + ': type is registered in bathroom.js', !!T, preset.type);
  if (!T) continue;
  const p = Object.assign({}, T.DEFAULTS, preset.params);
  const full = T.build(THREE, p, { detail: 'full' });
  const low = T.build(THREE, p, { detail: 'low' });
  const b = bboxCm(full);
  check(name + ': width == params', near(b.maxX - b.minX, p.width), { b, w: p.width });
  check(name + ': centred on x', near((b.maxX + b.minX) / 2, 0), b);
  check(name + ': bottom at y = 0', near(b.minY, 0), b);
  check(name + ': height == params', near(b.maxY - b.minY, p.height), { b, h: p.height });
  check(name + ': back at z = 0', near(b.minZ, 0), b);
  check(name + ': depth == params', near(b.maxZ - b.minZ, p.depth), { b, d: p.depth });
  let bad = [], unkept = [], lights = 0;
  full.traverse(o => {
    if (o.isLight) lights++;
    if (!o.isMesh) return;
    const f = Fin.partFinish(o, o.material);
    if (f.error) bad.push(o.name + ': ' + f.error);
    else if (Fin.isKeptFinish(f.finish) && Fin.partKeep(o, o.material).keep !== true) unkept.push(o.name);
    if (o.material.side !== THREE.FrontSide) bad.push(o.name + ': not FrontSide');
    if (o.material.map) bad.push(o.name + ': has a texture');
  });
  check(name + ': palette finishes, FrontSide, no textures', bad.length === 0, bad);
  check(name + ': glass/mirror/emissive parts kept', unkept.length === 0, unkept);
  check(name + ': adds no lights', lights === 0);
  const cap = B.TRIANGLE_CAPS[preset.type];
  const tf = triangles(full), tl = triangles(low);
  check(name + ': full triangles within cap', tf <= cap.full, { tf, cap });
  check(name + ': low triangles within cap', tl <= cap.low, { tl, cap });
  check(name + ': low <= full', tl <= tf, { tf, tl });
  if (tf > 300) check(name + ': low <= 60% of full', tl <= 0.6 * tf, { tf, tl });
}
check('every type has a cap', Object.keys(B.TYPES).every(t => B.TRIANGLE_CAPS[t]));
check('every type has a preset', Object.keys(B.TYPES).every(t => Object.values(B.PRESETS).some(p => p.type === t)));

// ---- 2. loft winding ------------------------------------------------------------
// Triangle normals of an indexed loft, in the order loftRR emits them: bands
// first (2 * ringPoints per band), then capFirst, then capLast.
function triNormals(geo) {
  const pos = geo.attributes.position, idx = geo.index.array, out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    a.fromBufferAttribute(pos, idx[i]); b.fromBufferAttribute(pos, idx[i + 1]); c.fromBufferAttribute(pos, idx[i + 2]);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    out.push({ n, centre: new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3) });
  }
  return out;
}
{
  // A two-ring outer wall around the origin must face out; a capped floor up.
  const seg = 3, n = 4 * (seg + 1);
  const g = B.loftRR(THREE, [
    { y: 0, w: 0.6, back: -0.2, front: 0.2, rb: 0.05, rf: 0.05 },
    { y: 0.3, w: 0.6, back: -0.2, front: 0.2, rb: 0.05, rf: 0.05 }
  ], { seg, capFirst: true, capLast: true });
  const tn = triNormals(g);
  const walls = tn.slice(0, 2 * n);
  const outward = walls.filter(t => t.n.x * t.centre.x + t.n.z * t.centre.z > 0).length;
  check('loftRR: every outer-wall triangle faces outward', outward === walls.length, { outward, of: walls.length });
  const capDown = tn.slice(2 * n, 3 * n), capUp = tn.slice(3 * n, 4 * n);
  check('loftRR: capFirst faces down', capDown.every(t => t.n.y < -0.99));
  check('loftRR: capLast faces up', capUp.every(t => t.n.y > 0.99));

  // The real bath: its first band (floor -> rim, the outer panel) faces out and
  // its bowl floor (the last cap) faces up.
  const bath = build('bathtub', {});
  const shell = named(bath, 'bathShell')[0];
  const bn = triNormals(shell.geometry);
  const ring = 4 * (5 + 1);
  const panel = bn.slice(0, 2 * ring);
  check('bathtub: outer panel faces outward', panel.every(t => t.n.x * t.centre.x + t.n.z * (t.centre.z - 0.35) > 0));
  check('bathtub: bowl floor faces up', bn.slice(bn.length - ring).every(t => t.n.y > 0.99));

  // The basin: capFirst is its underside (down), capLast its bowl floor (up).
  const van = build('vanity-counter', {});
  const bowl = named(van, 'basinBody')[0];
  const vn = triNormals(bowl.geometry);
  check('vanity-counter: basin underside faces down', vn.slice(vn.length - 2 * ring, vn.length - ring).every(t => t.n.y < -0.99));
  check('vanity-counter: basin bowl floor faces up', vn.slice(vn.length - ring).every(t => t.n.y > 0.99));
}

// ---- 3. vanity-counter ---------------------------------------------------------------
{
  const p = Object.assign({}, B.TYPES['vanity-counter'].DEFAULTS, { width: 140, basinAt: 105 });
  const g = B.TYPES['vanity-counter'].build(THREE, p, { detail: 'full' });
  const basin = named(g, 'basinBody')[0];
  const bb = bboxCm(basin);
  check('vanity: basinAt is measured from the LEFT end (-x)', near((bb.minX + bb.maxX) / 2, -70 + 105, 0.2), bb);
  check('vanity: basin is basinWidth wide', near(bb.maxX - bb.minX, p.basinWidth, 0.2), bb);
  check('vanity: basin front is the envelope depth', near(bb.maxZ, p.depth, 0.2), bb);
  check('vanity: basin rim is basinLip above the countertop', near(bb.maxY, p.counterHeight + p.basinLip, 0.3), bb);
  // The countertop never covers the basin's footprint (the notch).
  const tops = [];
  g.traverse(o => { if (o.isMesh && /^countertop/.test(o.name)) tops.push(bboxCm(o)); });
  check('vanity: countertop is three slabs round the notch', tops.length === 3, tops.length);
  const overlaps = tops.filter(t => t.maxX > bb.minX + 0.1 && t.minX < bb.maxX - 0.1 && t.maxZ > bb.minZ + 0.1);
  check('vanity: no countertop slab over the basin footprint', overlaps.length === 0, overlaps);
  // Below the countertop's underside, no basin vertex is behind the counter face.
  const pos = basin.geometry.attributes.position;
  const under = (p.counterHeight - p.topThick) / 100, cd = p.counterDepth / 100;
  let behind = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < under - 1e-4 && pos.getZ(i) < cd - 1e-4) behind++;
  check('vanity: basin never pokes into the counter below the countertop', behind === 0, behind);
  // The tap rises exactly to `height`.
  const lever = bboxCm(named(g, 'basinTapLever')[0]);
  check('vanity: tap top is `height`', near(lever.maxY, p.height, 0.05), lever);
  // vanityEnvelope agrees with the build for every vanity preset.
  Object.entries(B.PRESETS).filter(([, q]) => q.type === 'vanity-counter').forEach(([name, q]) => {
    const e = B.vanityEnvelope(q.params);
    const got = bboxCm(build('vanity-counter', q.params));
    check(name + ': vanityEnvelope == built box', near(got.maxX - got.minX, e.width) && near(got.maxY, e.height) && near(got.maxZ, e.depth), { e, got });
  });
  // basinAt clamps onto the counter.
  const clamped = bboxCm(named(build('vanity-counter', { basinAt: 0 }), 'basinBody')[0]);
  check('vanity: basinAt past the end clamps onto the counter', near(clamped.minX, -60, 0.2), clamped);
}

// ---- 4. toilet --------------------------------------------------------------------------
{
  const p = B.TYPES.toilet.DEFAULTS;
  const g = build('toilet', {});
  const plate = bboxCm(named(g, 'wcFlushPlate')[0]);
  check('toilet: flush plate top is `height`', near(plate.maxY, p.height, 0.05), plate);
  check('toilet: flush plate on the wall (back at z = 0)', near(plate.minZ, 0, 0.2), plate);
  const seat = bboxCm(named(g, 'wcSeat')[0]);
  check('toilet: seat sits on seatHeight', near(seat.minY, p.seatHeight, 0.05), seat);
  check('toilet: lid top is toiletLidTop()', near(bboxCm(named(g, 'wcLid')[0]).maxY, B.toiletLidTop(p.seatHeight), 0.05));
  const bare = build('toilet', { flushPlate: false, height: B.toiletLidTop(p.seatHeight) });
  check('toilet: no plate -> no plate mesh', named(bare, 'wcFlushPlate').length === 0);
  const pan = bboxCm(named(g, 'wcPan')[0]);
  check('toilet: pan is width x depth', near(pan.maxX - pan.minX, p.width) && near(pan.maxZ, p.depth), pan);
}

// ---- 5. shower-set -----------------------------------------------------------------------
Object.entries(B.PRESETS).filter(([, q]) => q.type === 'shower-set').forEach(([name, q]) => {
  const p = Object.assign({}, B.TYPES['shower-set'].DEFAULTS, q.params);
  const e = B.showerSetEnvelope(THREE, p);
  check(name + ': params carry the envelope', near(p.width, e.width, 0.1) && near(p.height, e.height, 0.1) && near(p.depth, e.depth, 0.1), { p: [p.width, p.height, p.depth], e });
  const g = build('shower-set', p);
  const valve = bboxCm(named(g, 'showerBarValve')[0]);
  check(name + ': valve centre at valveHeight - bottom', near((valve.minY + valve.maxY) / 2, p.valveHeight - e.bottom, 0.1), { valve, e });
  check(name + ': valve centre at valveX', near((valve.minX + valve.maxX) / 2, e.valveX, 0.1), { valve, e });
  const riser = bboxCm(named(g, 'showerRiser')[0]);
  check(name + ': riser is riserOffset from the valve', near((riser.minX + riser.maxX) / 2 - e.valveX, p.riserOffset, 0.1), { riser, e });
  check(name + ': riser spans riserFrom..riserTo', near(riser.minY, p.riserFrom - e.bottom, 0.1) && near(riser.maxY, p.riserTo - e.bottom, 0.1), riser);
  check(name + ': spout iff spoutHeight', (named(g, 'bathSpout').length === 1) === (p.spoutHeight != null));
  const lowG = B.TYPES['shower-set'].build(THREE, p, { detail: 'low' });
  const lv = bboxCm(named(lowG, 'showerBarValve')[0]);
  check(name + ': low detail sits where full does', near(lv.minY + lv.maxY, valve.minY + valve.maxY, 0.01) && near(lv.minX, valve.minX, 0.01), { lv, valve });
});

// ---- 6. shower-screen ----------------------------------------------------------------------
{
  const q = B.PRESETS['Shower glazing: fixed + door'].params;
  const g = build('shower-screen', q);
  const door = bboxCm(named(g, 'screenDoorGlass')[0]), fixed = bboxCm(named(g, 'screenFixedGlass')[0]);
  check('screen: panels run left to right (fixed, then door)', fixed.maxX < door.minX, { fixed, door });
  check('screen: one mullion between two panels', named(g, 'screenMullion').length === 1);
  const handle = bboxCm(named(g, 'screenDoorHandle')[0]);
  check('screen: hinge right -> handle at the door\'s left (latch) edge', handle.maxX < (door.minX + door.maxX) / 2, { handle, door });
  check('screen: handle on the front (room) side', near(handle.maxZ, q.depth, 0.05), handle);
  const left = build('shower-screen', Object.assign({}, q, { hinge: 'left' }));
  const hl = bboxCm(named(left, 'screenDoorHandle')[0]);
  check('screen: hinge left -> handle at the door\'s right edge', hl.minX > (door.minX + door.maxX) / 2, hl);

  const rail = build('shower-screen', {});
  check('screen rail: no mullion', named(rail, 'screenMullion').length === 0);
  const jamb = bboxCm(named(rail, 'screenHingeJamb')[0]);
  check('screen rail: jamb at the hinge (right) end', near(jamb.maxX, 35, 0.05), jamb);
  const jl = bboxCm(named(build('shower-screen', { hinge: 'left' }), 'screenHingeJamb')[0]);
  check('screen rail: hinge left -> jamb at the left end', near(jl.minX, -35, 0.05), jl);
}

// ---- 7. bathtub and towel-rail ------------------------------------------------------------
{
  const w = bboxCm(named(build('bathtub', {}), 'bathWaste')[0]);
  check('bathtub: wasteEnd right -> plug at +x', w.minX > 40, w);
  const wl = bboxCm(named(build('bathtub', { wasteEnd: 'left' }), 'bathWaste')[0]);
  check('bathtub: wasteEnd left -> plug at -x', wl.maxX < -40, wl);
  check('towel-rail: rungs == params.rungs', named(build('towel-rail', { rungs: 9 }), 'railRung').length === 9);
  check('towel-rail: low detail keeps some rungs', named(build('towel-rail', { rungs: 9 }, 'low'), 'railRung').length >= 2);
}

// ---- 8. paramsDiff (Copy JSON) -------------------------------------------------------------
check('paramsDiff keeps only changed keys',
  JSON.stringify(B.paramsDiff('bathtub', Object.assign({}, B.TYPES.bathtub.DEFAULTS, { width: 160 }))) === '{"width":160}');

if (failures) { console.error(failures + ' failed, ' + passes + ' passed'); process.exit(1); }
console.log('ok -- ' + passes + ' passed, 0 failed');
