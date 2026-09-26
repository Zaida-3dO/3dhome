#!/usr/bin/env node
/**
 * Kitchen builders (src/furniture/kitchen.js): the behaviour the generic
 * builder contract in test-furniture-core.mjs cannot see. No framework, no
 * install: `node scripts/test-furniture-kitchen.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. The envelope beyond DEFAULTS, with no exceptions: sinks and taps,
 *      hood splashbacks, corners, every handle style, narrow doors, mixed
 *      wall heights, a top freezer. Every bbox equals width/depth/height;
 *      the worktop pieces tile the run around their cut-outs; low detail is
 *      at most 60% of full once full passes 300 triangles.
 *   2. Modules run LEFT TO RIGHT in local +x, and `width` is authoritative
 *      (a short list is padded with a filler, a long one scaled).
 *   3. The hob is flush in the worktop over its own module; the oven front is
 *      set back from the door fronts.
 *   4. The L: the two base runs' worktops meet at the corner without
 *      overlapping (bounding boxes), and the plinth LED is continuous round it.
 *   5. The merged kitchen is four draws or fewer.
 *   6. Copy JSON's diff against DEFAULTS.
 *
 * Every check that could pass vacuously has a probe proving it can fail.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const K = await imp('src/furniture/kitchen.js');
const Fin = await imp('src/furniture/finishes.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// The builders warn (to the console) on purpose for mismatched widths and
// unknown kinds. Capture those so the test output stays readable and the
// warnings themselves can be asserted.
const warnings = [];
const savedWarn = console.warn;
console.warn = m => warnings.push(String(m));

const BASE = K.TYPES['kitchen-base-run'], WALL = K.TYPES['kitchen-wall-run'], FRIDGE = K.TYPES['fridge-freezer'];
const build = (impl, params, detail) => impl.build(THREE, Object.assign({}, impl.DEFAULTS, params), { detail: detail || 'full' });

function boxCm(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return { x0: b.min.x * 100, x1: b.max.x * 100, y0: b.min.y * 100, y1: b.max.y * 100, z0: b.min.z * 100, z1: b.max.z * 100 };
}
function meshes(group, pred) {
  const out = [];
  group.traverse(o => { if (o.isMesh && (!pred || pred(o))) out.push(o); });
  return out;
}
function unionBox(list) {
  const b = new THREE.Box3();
  list.forEach(m => { m.updateMatrixWorld(true); b.union(new THREE.Box3().setFromObject(m)); });
  return { x0: b.min.x * 100, x1: b.max.x * 100, y0: b.min.y * 100, y1: b.max.y * 100, z0: b.min.z * 100, z1: b.max.z * 100 };
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.5 : tol);

const tri = gr => meshes(gr).reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);

/**
 * The worktop pieces tile the run's W x D exactly once, except over the
 * cut-outs (a hob, a sink), which no piece may cover. Sampled on a 1 cm grid.
 * Returns the number of bad sample points.
 */
function worktopTiling(g, p) {
  const tops = meshes(g, m => m.name === 'worktop').map(boxCm);
  const holes = meshes(g, m => m.name === 'hob' || m.name === 'sink' || m.name === 'sink-rim').map(boxCm);
  const inside = (b, x, z) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1;
  let bad = 0;
  // Off the half-centimetre grid, so no sample lands exactly on an edge.
  for (let x = -p.width / 2 + 0.37; x < p.width / 2; x += 1) {
    for (let z = 0.41; z < p.depth; z += 1) {
      const n = tops.filter(b => inside(b, x, z)).length;
      const hole = holes.some(b => inside(b, x, z));
      if (hole ? n !== 0 : n !== 1) bad++;
    }
  }
  return bad;
}

/** The envelope checks: bbox == width/depth/height exactly (no exceptions), centred, bottom at 0, back at 0. */
function checkEnvelope(tag, impl, params) {
  const p = Object.assign({}, impl.DEFAULTS, params);
  const g = build(impl, params);
  const all = meshes(g);
  const whole = boxCm(g);
  check(tag + ': width == params', near(whole.x1 - whole.x0, p.width), { whole, width: p.width });
  check(tag + ': centred on x', near((whole.x0 + whole.x1) / 2, 0), whole);
  check(tag + ': bottom at y = 0', near(whole.y0, 0), whole);
  check(tag + ': back at z = 0', near(whole.z0, 0), whole);
  check(tag + ': depth == params', near(whole.z1 - whole.z0, p.depth), { whole, depth: p.depth });
  check(tag + ': height == params (the whole envelope)', near(whole.y1 - whole.y0, p.height), { whole, height: p.height });
  const bad = all.filter(m => Fin.partFinish(m).error);
  check(tag + ': every part has a palette finish', bad.length === 0, bad.map(m => m.name));
  const low = build(impl, params, 'low');
  const tf = tri(g), tl = tri(low);
  check(tag + ': low detail is lighter', tl <= tf, { full: tf, low: tl });
  if (tf > 300) check(tag + ': low detail is at most 60% of full (full > 300)', tl <= 0.6 * tf, { full: tf, low: tl, ratio: tl / tf });
  if (impl === BASE) {
    check(tag + ': worktop pieces tile the run around the cut-outs (full)', worktopTiling(g, p) === 0, worktopTiling(g, p));
    check(tag + ': worktop pieces tile the run around the cut-outs (low)', worktopTiling(low, p) === 0, worktopTiling(low, p));
  }
  return { g, low, p };
}

// ---- 1. envelopes beyond DEFAULTS -- no exceptions ------------------------------------
{
  // A sink with a tap: `height` is the envelope, the worktop is worktopHeight.
  const tapRun = { width: 210, corner: 'right', height: 118.5,
    modules: [{ kind: 'sink', width: 60 }, { kind: 'hob', width: 60 }, { kind: 'cabinet', width: 30 }, { kind: 'corner', width: 60 }] };
  const t = checkEnvelope('base with inset sink + tap', BASE, tapRun);
  const tap = unionBox(meshes(t.g, m => m.name === 'tap'));
  const top = unionBox(meshes(t.g, m => m.name === 'worktop'));
  check('tap run: the worktop is at worktopHeight', near(top.y1, 88.5, 0.01), top);
  check('tap run: the tap rises from the worktop to exactly height', near(tap.y0, 88.5, 0.01) && near(tap.y1, 118.5, 0.01), tap);
  check('tap run: the tap is the only thing above the worktop',
    meshes(t.g, m => boxCm(m).y1 > 88.5 + 0.01).every(m => m.name === 'tap'),
    meshes(t.g, m => boxCm(m).y1 > 88.5 + 0.01).map(m => m.name));
  check('tap run: low detail keeps the tap, so the envelope holds there too', near(boxCm(t.low).y1, 118.5, 0.01), boxCm(t.low));
  check('baseRunHeight: worktop + the tap', K.baseRunHeight(tapRun) === 88.5 + K.TAP_RISE && K.baseRunHeight({}) === 88.5);

  checkEnvelope('base with a run-level sink + tap', BASE, { width: 180, height: 118.5,
    modules: [{ kind: 'cabinet', width: 60 }, { kind: 'dishwasher', width: 60 }, { kind: 'cabinet', width: 60 }],
    sink: { at: 70, width: 90 } });
  checkEnvelope('base with undermount sink, no tap', BASE, { modules: [{ kind: 'sink', width: 80, bowl: 'undermount', tap: false }, { kind: 'washer', width: 60 }, { kind: 'filler', width: 40 }] });
  ['bar', 'knob', 'rail', 'none'].forEach(h => checkEnvelope('base, handleStyle ' + h, BASE, { handleStyle: h, corner: 'left',
    modules: [{ kind: 'corner', width: 100 }, { kind: 'cabinet', width: 80 }] }));
  checkEnvelope('base, narrow doors', BASE, { width: 75, modules: [{ kind: 'cabinet', width: 30 }, { kind: 'cabinet', width: 30, hinge: 'right' }, { kind: 'cabinet', width: 15 }] });
  checkEnvelope('base, defaults with a hob', BASE, {});

  // Mismatches still hold the envelope, and say so.
  warnings.length = 0;
  const noTap = checkEnvelope('base, height above the worktop but no tap', BASE, { height: 95 });
  check('no tap: the worktop is drawn at height instead, with a warning',
    near(unionBox(meshes(noTap.g, m => m.name === 'worktop')).y1, 95, 0.01) && warnings.some(w => /no tap to fill it/.test(w)), warnings);
  warnings.length = 0;
  const noRoom = checkEnvelope('base, a tap but no room for it', BASE, { modules: [{ kind: 'sink', width: 60 }], width: 60 });
  check('no room: the tap is omitted, with a warning',
    meshes(noRoom.g, m => m.name === 'tap').length === 0 && warnings.some(w => /tap omitted/.test(w)), warnings);
  warnings.length = 0;
  build(BASE, { width: 60, modules: [{ kind: 'hob', width: 60, splashback: 60 }] });
  check('a base-run splashback is refused (it belongs to the hood now)', warnings.some(w => /belongs to the wall run/.test(w)), warnings);

  // Wall runs: mixed heights, a canopy, and a hood's splashback down to the worktop.
  checkEnvelope('wall, mixed heights + canopy', WALL, { height: 85, modules: [{ kind: 'cabinet', width: 60 }, { kind: 'hood', width: 60, style: 'canopy', height: 65 }, { kind: 'open', width: 60, height: 65 }] });
  checkEnvelope('wall, chimney only', WALL, { width: 60, modules: [{ kind: 'hood', width: 60 }] });
  const sbRun = { width: 180, height: 120, modules: [{ kind: 'cabinet', width: 60, height: 70 },
    { kind: 'hood', width: 60, height: 60, splashback: 60 }, { kind: 'cabinet', width: 60, height: 55 }] };
  const sb = checkEnvelope('wall, hood with a splashback', WALL, sbRun);
  const panel = boxCm(meshes(sb.g, m => m.name === 'splashback')[0]);
  check('wall splashback: hangs from the hood down to the run\'s bottom', near(panel.y0, 0, 0.01) && near(panel.y1, 60, 0.01) && panel.z1 <= 0.5, panel);
  warnings.length = 0;
  build(WALL, { width: 60, height: 70, modules: [{ kind: 'hood', width: 60, height: 60, splashback: 40 }] });
  check('wall splashback longer than the room under the hood: clamped, with a warning', warnings.some(w => /fits under the hood/.test(w)), warnings);

  checkEnvelope('fridge, top freezer, left hinge', FRIDGE, { freezer: 'top', hinge: 'left', width: 70, height: 200 });
  const ft = checkEnvelope('fridge with a top LED', FRIDGE, { topLed: true, plinthLed: true });
  const tl = meshes(ft.g, m => m.name === 'top-led');
  check('fridge topLed: a kept emissive strip flush with its top', tl.length === 1 && near(boxCm(tl[0]).y1, FRIDGE.DEFAULTS.height, 0.01) &&
    Fin.partKeep(tl[0]).keep === true && Fin.partFinish(tl[0]).finish === 'emissive');
  check('fridge: no top LED unless asked', meshes(build(FRIDGE, {}), m => m.name === 'top-led').length === 0);

  // The envelope check can fail: lift the tap 1 cm and it must be caught.
  const g = build(BASE, tapRun);
  meshes(g, m => m.name === 'tap').forEach(m => { m.position.y += 0.01; });
  check('probe: a tap 1 cm past height breaks the envelope check', !near(boxCm(g).y1 - boxCm(g).y0, 118.5, 0.5), boxCm(g));
  // The tiling check can fail: drop the strip in front of the hob.
  const h = build(BASE, {});
  const hob = boxCm(meshes(h, m => m.name === 'hob')[0]);
  const front = meshes(h, m => m.name === 'worktop').find(m => { const b = boxCm(m); return near(b.z0, hob.z1, 0.01) && near(b.x0, hob.x0, 0.01); });
  front.parent.remove(front);
  check('probe: a missing worktop strip in front of the hob is caught', worktopTiling(h, BASE.DEFAULTS) > 0);
}

// Every piece of the example L holds its envelope too.
[['a', BASE], ['b', BASE], ['wall', WALL], ['wallB', WALL], ['fridge', FRIDGE]].forEach(([k, impl]) => {
  checkEnvelope('EXAMPLE_L.' + k, impl, JSON.parse(JSON.stringify(K.EXAMPLE_L[k])));
});

// ---- 1a. the sink bowl reads from above ---------------------------------------------
{
  const g = build(BASE, { width: 180, height: 118.5, modules: [{ kind: 'cabinet', width: 60 }, { kind: 'dishwasher', width: 60 }, { kind: 'cabinet', width: 60 }],
    sink: { at: 70, width: 90, drainer: 'right' } });
  const bowl = unionBox(meshes(g, m => m.name === 'sink'));
  // A ray straight down through the middle of the bowl's opening.
  const rc = new THREE.Raycaster(new THREE.Vector3((bowl.x0 + bowl.x1) / 200, 2, (bowl.z0 + bowl.z1) / 200), new THREE.Vector3(0, -1, 0));
  g.updateMatrixWorld(true);
  const hits = rc.intersectObjects(meshes(g), false);
  check('sink: looking down into the bowl, the first thing hit is the steel bowl', hits.length > 0 && hits[0].object.name === 'sink',
    hits.slice(0, 3).map(h => h.object.name + '@' + (h.point.y * 100).toFixed(1)));
  check('sink: the carcass is cut down under it', meshes(g, m => m.name === 'carcass').some(m => boxCm(m).y1 < 88.5 - 20), meshes(g, m => m.name === 'carcass').map(m => boxCm(m).y1));
}

// ---- 1c. the owner's corner module cannot be narrower than the other leg -------------
{
  warnings.length = 0;
  const g = build(BASE, { width: 178, corner: 'left', cornerDepth: 60, modules: [{ kind: 'corner', width: 58 }, { kind: 'cabinet', width: 60 }, { kind: 'cabinet', width: 60 }] });
  const blind = unionBox(meshes(g, m => m.name === 'blind-panel'));
  check('a 58 cm corner module against a 60 cm leg is drawn 60 wide', near(blind.x1 - blind.x0, 60 - 0.3, 0.05), blind);
  check('...with a warning naming the clash', warnings.some(w => /cannot clash/.test(w)), warnings);
  const doors = meshes(g, m => m.name === 'door').map(boxCm).sort((a, b) => a.x0 - b.x0);
  check('...and the neighbour gives up the difference', near(doors[0].x0, -89 + 60 + 0.15, 0.05), doors[0]);
}

// ---- 1b. narrow doors keep their handles on the door ----------------------------
{
  [30, 15].forEach(w => {
    const g = build(BASE, { width: w, modules: [{ kind: 'cabinet', width: w }] });
    const door = boxCm(meshes(g, m => m.name === 'door')[0]);
    const h = boxCm(meshes(g, m => m.name === 'handle')[0]);
    check('a ' + w + ' cm door keeps its handle inside it', h.x0 > door.x0 && h.x1 < door.x1, { door, h });
    check('a ' + w + ' cm door is one door', meshes(g, m => m.name === 'door').length === 1);
  });
  const g = build(BASE, { width: 30, modules: [{ kind: 'cabinet', width: 30, hinge: 'left' }] });
  const gR = build(BASE, { width: 30, modules: [{ kind: 'cabinet', width: 30, hinge: 'right' }] });
  const hx = gg => { const b = boxCm(meshes(gg, m => m.name === 'handle')[0]); return (b.x0 + b.x1) / 2; };
  check('hinge left puts the handle on the right edge, hinge right on the left', hx(g) > 0 && hx(gR) < 0, { left: hx(g), right: hx(gR) });
  const two = build(BASE, { width: 80, modules: [{ kind: 'cabinet', width: 80 }] });
  check('an 80 cm cabinet has two doors', meshes(two, m => m.name === 'door').length === 2);
}

// ---- 2. left to right, and width is authoritative -----------------------------
{
  const g = build(BASE, { width: 180, modules: [{ kind: 'dishwasher', width: 60 }, { kind: 'oven', width: 60 }, { kind: 'drawers', width: 60 }] });
  const cx = name => { const b = unionBox(meshes(g, m => m.name === name)); return (b.x0 + b.x1) / 2; };
  check('modules run left to right in local +x', cx('dishwasher') < cx('oven-door') && cx('oven-door') < cx('drawer'),
    { dishwasher: cx('dishwasher'), oven: cx('oven-door'), drawers: cx('drawer') });
  check('first module starts at -width/2', near(unionBox(meshes(g, m => m.name === 'dishwasher')).x0, -90, 0.2));

  warnings.length = 0;
  const lay = K.layoutModules([{ kind: 'cabinet', width: 60 }], 100, { kinds: K.BASE_MODULE_KINDS });
  check('short modules: a filler closes the gap at the right', lay.length === 2 && lay[1].kind === 'filler' && near(lay[1].x1 - lay[1].x0, 40, 0.01), lay);
  check('short modules: warns', warnings.some(w => /filler closes the gap/.test(w)), warnings);
  const layR = K.layoutModules([{ kind: 'corner', width: 60 }], 100, { kinds: K.BASE_MODULE_KINDS, corner: 'right' });
  check('short modules, corner right: the filler goes on the left', layR[0].kind === 'filler' && layR[1].kind === 'corner', layR);
  const big = K.layoutModules([{ kind: 'cabinet', width: 60 }, { kind: 'cabinet', width: 60 }], 100, { kinds: K.BASE_MODULE_KINDS });
  check('long modules: scaled to fit', near(big[0].x1 - big[0].x0, 50, 0.01) && near(big[1].x1, 50, 0.01), big);
  const unk = K.layoutModules([{ kind: 'fridge', width: 60 }, { kind: 'cabinet' }], 60, { kinds: K.BASE_MODULE_KINDS });
  check('unknown kind drawn as cabinet, widthless module skipped', unk.length === 1 && unk[0].kind === 'cabinet', unk);
}

// ---- 3. hob flush over its module; oven set back --------------------------------
{
  const p = Object.assign({}, BASE.DEFAULTS, { modules: [{ kind: 'drawers', width: 60 }, { kind: 'oven', width: 60, hob: true }, { kind: 'cabinet', width: 60 }] });
  const g = BASE.build(THREE, p, { detail: 'full' });
  const hob = boxCm(meshes(g, m => m.name === 'hob')[0]);
  const top = unionBox(meshes(g, m => m.name === 'worktop'));
  check('hob top is flush with the worktop (within 2 mm, never above)', hob.y1 <= p.height + 1e-6 && p.height - hob.y1 <= 0.2, { hob, H: p.height });
  check('hob sits within its own module (the middle one)', hob.x0 >= -30 && hob.x1 <= 30, hob);
  check('worktop still spans the run', near(top.x0, -90, 0.01) && near(top.x1, 90, 0.01) && near(top.z1, p.depth, 0.01), top);
  const ovenZ = boxCm(meshes(g, m => m.name === 'oven-door')[0]).z1;
  const doorZ = boxCm(meshes(g, m => m.name === 'door')[0]).z1;
  check('oven front is set back from the door fronts', ovenZ < doorZ - 0.5, { ovenZ, doorZ });
  // No worktop piece may cover the hob (probe: the cut-out is real).
  const covering = meshes(g, m => m.name === 'worktop').map(boxCm)
    .filter(b => b.x0 < hob.x1 - 0.01 && b.x1 > hob.x0 + 0.01 && b.z0 < hob.z1 - 0.01 && b.z1 > hob.z0 + 0.01);
  check('no worktop piece covers the hob', covering.length === 0, covering);
}

// ---- 4. the L: worktops meet without overlap; LED continuous ------------------------
function placeL(ex) {
  const poses = K.exampleLPoses(ex);
  const out = {};
  [['a', BASE], ['b', BASE], ['wall', WALL], ['wallB', WALL], ['fridge', FRIDGE]].forEach(([k, impl]) => {
    const g = impl.build(THREE, Object.assign({}, impl.DEFAULTS, ex[k]), { detail: 'full' });
    g.position.set(poses[k].x / 100, poses[k].y / 100, poses[k].z / 100);
    g.rotation.y = poses[k].rotY;
    g.updateMatrixWorld(true);
    out[k] = g;
  });
  return out;
}
/** Overlap of two boxes in plan, in cm2 (0 when they only touch). */
function planOverlap(a, b) {
  const dx = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const dz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  return dx > 0.01 && dz > 0.01 ? dx * dz : 0;
}
function worktopReport(L) {
  const wa = meshes(L.a, m => m.name === 'worktop').map(boxCm);
  const wb = meshes(L.b, m => m.name === 'worktop').map(boxCm);
  let overlap = 0;
  wa.forEach(x => wb.forEach(y => { overlap += planOverlap(x, y); }));
  const A = unionBox(meshes(L.a, m => m.name === 'worktop')), B = unionBox(meshes(L.b, m => m.name === 'worktop'));
  return { overlap, A, B };
}
{
  const ex = JSON.parse(JSON.stringify(K.EXAMPLE_L));
  const L = placeL(ex);
  const r = worktopReport(L);
  check('L: the base runs\' worktops do not overlap', r.overlap === 0, r);
  check('L: they meet -- B starts at A\'s front edge', near(r.B.z0, r.A.z1, 0.01), r);
  check('L: the owner\'s worktop runs to the side wall', near(r.A.x0, 0, 0.01), r);
  check('L: B\'s worktop sits against the side wall, within A\'s corner', near(r.B.x0, 0, 0.01) && r.B.x1 <= r.A.x1, r);
  check('L: the example runs differ in depth (60 against 62)', ex.b.depth !== (ex.a.depth || BASE.DEFAULTS.depth), ex.b.depth);
  check('L: B\'s worktop is its own depth deep', near(r.B.x1 - r.B.x0, ex.b.depth, 0.01), r);
  // No gap: the corner square in front of the side wall -- B's depth wide,
  // A's depth deep -- is covered entirely by A's worktop.
  const sq = { x0: 0, x1: ex.b.depth, z0: 0, z1: r.A.z1 };
  const covered = meshes(L.a, m => m.name === 'worktop').map(boxCm).reduce((n, b) => n + planOverlap(b, sq), 0);
  check('L: no gap -- the owner\'s worktop covers the whole corner square', near(covered, (sq.x1 - sq.x0) * (sq.z1 - sq.z0), 1), { covered, sq });

  // Probe: pull B 5 cm into the corner and the overlap test must fire.
  const poses = K.exampleLPoses(ex);
  L.b.position.z = (poses.b.z - 5) / 100;
  L.b.updateMatrixWorld(true);
  check('probe: a run pushed into the corner is caught as an overlap', worktopReport(L).overlap > 0);

  // Plinth LED, continuous round the corner.
  const L2 = placeL(ex);
  const leds = [...meshes(L2.a, m => m.name === 'plinth-led'), ...meshes(L2.b, m => m.name === 'plinth-led')];
  check('L: LED parts are emissive and kept', leds.length >= 3 &&
    leds.every(m => Fin.partFinish(m).finish === 'emissive' && Fin.partKeep(m).keep === true), leds.length);
  // The owner's return strip runs forward to A's front edge; B's strip reaches
  // its own corner end. They must meet: same plan line, touching ends.
  const ret = meshes(L2.a, m => m.name === 'plinth-led').map(boxCm).find(b => b.z1 - b.z0 > b.x1 - b.x0);
  const bStrip = meshes(L2.b, m => m.name === 'plinth-led').map(boxCm).find(b => b.z1 - b.z0 > b.x1 - b.x0);
  check('L: the owner turns its LED along the plinth return', !!ret, ret);
  check('L: B\'s LED runs along its plinth', !!bStrip, bStrip);
  if (ret && bStrip) {
    check('L: LED continuous round the corner (return meets B\'s strip)', near(ret.z1, bStrip.z0, 0.05) && near(ret.x0, bStrip.x0, 0.05), { ret, bStrip });
  }
  const along = meshes(L2.a, m => m.name === 'plinth-led').map(boxCm).find(b => b.x1 - b.x0 > b.z1 - b.z0);
  if (along && ret) check('L: the owner\'s LED meets its own return', near(along.x0, ret.x0, 0.05), { along, ret });
  const flaggedEnd = ex.a.modules[0].width + ex.a.modules[1].width;
  if (along) check('L: owner\'s LED spans the two flagged modules only (corner + drawers)', near(along.x1, flaggedEnd, 0.05), { along, flaggedEnd });

  // Probe: tell the owner the wrong depth for the other run and the LED no
  // longer meets round the corner -- the continuity check can fail.
  const wrong = JSON.parse(JSON.stringify(ex));
  wrong.a.cornerDepth = 60;
  const L3 = placeL(wrong);
  const ret3 = meshes(L3.a, m => m.name === 'plinth-led').map(boxCm).find(b => b.z1 - b.z0 > b.x1 - b.x0);
  const b3 = meshes(L3.b, m => m.name === 'plinth-led').map(boxCm).find(b => b.z1 - b.z0 > b.x1 - b.x0);
  check('probe: a wrong cornerDepth breaks LED continuity', !!ret3 && !!b3 && !near(ret3.x0, b3.x0, 0.05), { ret3, b3 });

  // An unflagged run draws no LED.
  check('no plinthLed flag, no LED', meshes(build(BASE, {}), m => m.name === 'plinth-led').length === 0);
}

// ---- 5. four draws or fewer ----------------------------------------------------
/**
 * What the renderer's merge will draw: one bucket per opaque palette finish
 * (colour rides a vertex attribute), plus one per distinct kept material
 * (finish + colour) -- the kept parts keep a real material, and parts that
 * share one batch.
 */
function draws(groups) {
  const buckets = new Set();
  groups.forEach(g => meshes(g).forEach(m => {
    const f = Fin.partFinish(m).finish;
    const kept = Fin.partKeep(m).keep === true || Fin.isKeptFinish(f);
    buckets.add(kept ? 'kept:' + f + ':' + m.material.color.getHexString() : f);
  }));
  return buckets;
}
{
  const ex = JSON.parse(JSON.stringify(K.EXAMPLE_L));
  const L = placeL(ex);
  const d = draws(Object.values(L));
  check('the example L (LED on) merges to four draws or fewer', d.size <= 4, [...d]);
  ['matte', 'gloss', 'metal'].forEach(f => {
    const L3 = placeL(Object.assign({}, ex, { a: Object.assign({}, ex.a, { frontFinish: f }) }));
    check('fronts in ' + f + ': still four draws or fewer', draws(Object.values(L3)).size <= 4, [...draws(Object.values(L3))]);
  });
  // Probe: a glass visor is the documented extra draw, and the counter sees it.
  const glassy = JSON.parse(JSON.stringify(ex));
  glassy.wall.modules.forEach(m => { if (m.kind === 'hood') m.visor = 'glass'; });
  check('probe: a glass visor costs the fifth draw', draws(Object.values(placeL(glassy))).size === 5, [...draws(Object.values(placeL(glassy)))]);
}

// ---- 6. wall run: tops aligned, mixed heights ---------------------------------------
{
  const g = build(WALL, { height: 86, modules: [{ kind: 'cabinet', width: 60 }, { kind: 'cabinet', width: 60, height: 66 }] });
  const cs = meshes(g, m => m.name === 'carcass').map(boxCm).sort((a, b) => a.x0 - b.x0);
  check('wall run: tops aligned at the run height', near(cs[0].y1, 86, 0.01) && near(cs[1].y1, 86, 0.01), cs);
  check('wall run: a 66 cm module hangs 20 cm higher', near(cs[1].y0, 20, 0.01) && near(cs[0].y0, 0, 0.01), cs);
  const hood = build(WALL, { modules: [{ kind: 'hood', width: 60, height: 50 }], width: 60 });
  const flue = boxCm(meshes(hood, m => m.name === 'hood-flue')[0]);
  check('chimney hood: the flue runs to the run\'s top', near(flue.y1, WALL.DEFAULTS.height, 0.01), flue);
}

// ---- 7. fridge-freezer -----------------------------------------------------------
{
  const g = build(FRIDGE, {});
  const ds = meshes(g, m => m.name === 'door').map(boxCm).sort((a, b) => a.y0 - b.y0);
  check('fridge: two doors', ds.length === 2, ds.length);
  check('fridge: bottom freezer is the shorter door', (ds[0].y1 - ds[0].y0) < (ds[1].y1 - ds[1].y0), ds);
  check('fridge: doors cover the full height', near(ds[1].y1, FRIDGE.DEFAULTS.height, 0.3), ds);
  const top = meshes(build(FRIDGE, { freezer: 'top' }), m => m.name === 'door').map(boxCm).sort((a, b) => a.y0 - b.y0);
  check('fridge: top freezer is the shorter, upper door', (top[1].y1 - top[1].y0) < (top[0].y1 - top[0].y0), top);
}

// ---- 8. blind corner -------------------------------------------------------------
{
  const g = build(BASE, { width: 100, corner: 'left', modules: [{ kind: 'corner', width: 100 }] });
  const blind = boxCm(meshes(g, m => m.name === 'blind-panel')[0]);
  const hs = meshes(g, m => m.name === 'handle').map(boxCm);
  check('blind corner: the blind panel is at the corner end', near(blind.x0, -50, 0.2), blind);
  check('blind corner: no handle on the blind panel', hs.length === 1 && hs.every(h => h.x0 >= blind.x1), { blind, hs });
  const gR = build(BASE, { width: 100, corner: 'right', modules: [{ kind: 'corner', width: 100 }] });
  check('blind corner, right: the blind panel is at the right end', near(boxCm(meshes(gR, m => m.name === 'blind-panel')[0]).x1, 50, 0.2));
  const small = build(BASE, { width: 64, corner: 'left', modules: [{ kind: 'corner', width: 64 }] });
  check('a 64 cm corner is all blind panel (no sliver door)', meshes(small, m => m.name === 'door').length === 0);
}

// ---- 8b. a run-level sink spanning two modules --------------------------------------
{
  const p = { width: 150, height: 118.5, modules: [{ kind: 'cabinet', width: 60 }, { kind: 'dishwasher', width: 60 }, { kind: 'cabinet', width: 30 }],
    sink: { at: 60, width: 90, depth: 50, bowl: 'inset', drainer: 'right' } };
  const env = checkEnvelope('base with a run-level 90 cm sink', BASE, p);
  const g = env.g;
  const out = unionBox(meshes(g, m => m.name === 'sink' || m.name === 'sink-rim'));
  check('run-level sink: 90 cm wide, centred `at` 60 cm from the left end', near(out.x1 - out.x0, 90, 0.05) && near((out.x0 + out.x1) / 2, -75 + 60, 0.05), out);
  check('run-level sink: spans the module boundary at 60 cm', out.x0 < -15 && out.x1 > -15, out);
  check('run-level sink: 50 cm deep', near(out.z1 - out.z0, 50, 0.05), out);
  check('run-level sink: its plate is flush with the worktop', near(out.y1, BASE.DEFAULTS.worktopHeight, 0.01), out);
  check('run-level sink: has a tap', meshes(g, m => m.name === 'tap').length > 0);
  const covering = meshes(g, m => m.name === 'worktop').map(boxCm)
    .filter(b => b.x0 < out.x1 - 0.01 && b.x1 > out.x0 + 0.01 && b.z0 < out.z1 - 0.01 && b.z1 > out.z0 + 0.01);
  check('run-level sink: the worktop is cut for it', covering.length === 0, covering);
  // The bowl is beside the drainer, not across it.
  const bowl = unionBox(meshes(g, m => m.name === 'sink'));
  check('drainer right: the bowl is at the left, a drainer of 20 cm or more to its right', near(bowl.x0, out.x0 + 2, 0.05) && bowl.x1 < out.x1 - 20, { bowl, out });

  warnings.length = 0;
  const off = build(BASE, { sink: { at: 5, width: 90 } });
  const o2 = unionBox(meshes(off, m => m.name === 'sink' || m.name === 'sink-rim'));
  check('a sink placed past the end is moved inside the run, with a warning',
    o2.x0 >= -90 - 0.01 && warnings.some(w => /does not fit/.test(w)), { o2, warnings });
  check('no sink by default', meshes(build(BASE, {}), m => m.name === 'sink').length === 0);
}

// ---- 8c. wall LEDs, tops, and the fridge on the top line ---------------------------
{
  const ex = JSON.parse(JSON.stringify(K.EXAMPLE_L));
  const L = placeL(ex);
  const tops = ['wall', 'wallB'].map(k => boxCm(L[k]).y1);
  check('L: both wall runs top out on the top line', tops.every(t => near(t, ex.wallTop, 0.05)), tops);
  const short = meshes(L.wall, m => m.name === 'carcass').map(boxCm).filter(b => b.y1 - b.y0 < 60);
  check('L: a 55 cm wall unit hangs from the top line (its LED recess 1 cm up)', short.length > 0 && short.every(b => near(b.y0, ex.wallTop - 55 + 1, 0.05)), short);
  const tall = meshes(L.wall, m => m.name === 'carcass').map(boxCm).filter(b => b.y1 - b.y0 > 60);
  check('L: a 70 cm wall unit hangs from the top line (its LED recess 1 cm up)', tall.length > 0 && tall.every(b => near(b.y0, ex.wallTop - 70 + 1, 0.05)), tall);
  const sbp = meshes(L.wall, m => m.name === 'splashback').map(boxCm);
  check('L: the hood splashback reaches down to the worktop', sbp.length === 1 && near(sbp[0].y0, 88.5, 0.05), sbp);
  check('L: the fridge-freezer meets the top line', near(boxCm(L.fridge).y1, ex.wallTop, 0.05), boxCm(L.fridge));
  check('elevationForTop: 210 top, 70 run -> 140', near(K.elevationForTop(210, { height: 70 }), 140, 1e-9));

  ['under-led', 'top-led'].forEach(name => {
    const leds = [...meshes(L.wall, m => m.name === name), ...meshes(L.wallB, m => m.name === name)];
    check('L: ' + name + ' strips exist, emissive and kept', leds.length >= 3 &&
      leds.every(m => Fin.partFinish(m).finish === 'emissive' && Fin.partKeep(m).keep === true), leds.length);
    // Wall runs do not corner: no strip turns along a return.
    const turned = leds.map(boxCm).filter(b => b.z1 - b.z0 > b.x1 - b.x0 && b.x1 - b.x0 < 2 && Math.abs(b.z1 - b.z0) < 40);
    check('L: ' + name + ' does not turn a wall corner (wall runs do not corner)', meshes(L.wall, m => m.name === name).map(boxCm).every(b => b.x1 - b.x0 > b.z1 - b.z0), turned);
  });
  const under = meshes(L.wall, m => m.name === 'under-led').map(boxCm);
  check('L: under-cabinet strips follow each module\'s own bottom (70 and 55 differ)',
    new Set(under.map(b => Math.round(b.y0))).size === 2, under.map(b => b.y0));
  const hoodX = unionBox(meshes(L.wall, m => m.name === 'hood'));
  check('L: no LED under the hood', under.every(b => b.x1 <= hoodX.x0 + 0.05 || b.x0 >= hoodX.x1 - 0.05), { under, hoodX });

  // One LED colour everywhere: four draws. A second colour is the fifth.
  check('L with plinth, under and top strips in one colour: four draws or fewer', draws(Object.values(L)).size <= 4, [...draws(Object.values(L))]);
  const two = JSON.parse(JSON.stringify(ex));
  two.wall.underLedColor = two.wallB.underLedColor = '#4060ff';
  check('probe: a second LED colour costs the fifth draw', draws(Object.values(placeL(two))).size === 5, [...draws(Object.values(placeL(two)))]);

  const f = build(FRIDGE, {});
  const ds = meshes(f, m => m.name === 'door').map(boxCm).sort((p, q2) => p.y0 - q2.y0);
  check('fridge: freezer door is freezerHeight (90) over the plinth (13)', near(ds[0].y0, 13, 0.2) && near(ds[0].y1, 13 + 90, 0.2), ds[0]);
  check('fridge: stands on a recessed plinth', meshes(f, m => m.name === 'plinth').length === 1 &&
    boxCm(meshes(f, m => m.name === 'plinth')[0]).z1 <= FRIDGE.DEFAULTS.depth - 7.9);
  check('fridge: plinthLed draws a strip', meshes(build(FRIDGE, { plinthLed: true }), m => m.name === 'plinth-led').length === 1);
}

const GAPCM = 0.15;   // the half shadow gap each front is inset by (kitchen.js GAP)

// ---- 10. owner-import fixes -----------------------------------------------------------
/** Every part lies inside the run's declared envelope (a bare wall run need not fill it). */
function contained(g, p) {
  const b = boxCm(g);
  return b.x0 >= -p.width / 2 - 0.5 && b.x1 <= p.width / 2 + 0.5 && b.y0 >= -0.5 && b.y1 <= p.height + 0.5 &&
    b.z0 >= -0.5 && b.z1 <= p.depth + 0.5;
}

// 10.1 A wall run's unused width is bare wall, and modules can be placed with `at`.
{
  const p = Object.assign({}, WALL.DEFAULTS, { width: 180, height: 120,
    modules: [{ kind: 'hood', width: 60, at: 70, height: 60, style: 'chimney', splashback: 60 }] });
  const g = WALL.build(THREE, p, { detail: 'full' });
  check('bare wall run: no filler panel, no carcass, no door', meshes(g, m => /filler|carcass|door/.test(m.name)).length === 0,
    meshes(g).map(m => m.name));
  const hood = unionBox(meshes(g, m => /hood/.test(m.name) || m.name === 'splashback'));
  check('bare wall run: the hood sits at 70-130 cm from the left end', near(hood.x0, -90 + 70, 0.01) && near(hood.x1, -90 + 130, 0.01), hood);
  check('bare wall run: everything drawn is inside the envelope', contained(g, p), boxCm(g));
  check('bare wall run: its height is still the whole envelope (splashback to top line)', near(boxCm(g).y0, 0, 0.01) && near(boxCm(g).y1, 120, 0.01), boxCm(g));
  const lf = WALL.build(THREE, Object.assign({}, p, { fill: 'filler' }), { detail: 'full' });
  const fl = meshes(lf, m => m.name === 'filler').map(boxCm).sort((a, b) => a.x0 - b.x0);
  check('fill: "filler" closes both sides of the hood', fl.length === 2 && near(fl[0].x0, -90 + GAPCM, 0.05) && near(fl[1].x1, 90 - GAPCM, 0.05), fl);
  check('fill: "filler" fills the width exactly', near(boxCm(lf).x1 - boxCm(lf).x0, 180, 0.5), boxCm(lf));
  const lay = K.layoutWallModules([{ kind: 'cabinet', width: 60 }, { kind: 'gap', width: 40 }, { kind: 'cabinet', width: 60 }], 200, 'bare');
  check('a gap module takes width and the next module follows it', lay.length === 3 && near(lay[2].x0, -100 + 100, 0.01) && near(lay[2].x1, 60, 0.01), lay);
  const gw = WALL.build(THREE, Object.assign({}, WALL.DEFAULTS, { width: 200, modules: [{ kind: 'cabinet', width: 60 }, { kind: 'gap', width: 40 }, { kind: 'cabinet', width: 60 }] }), { detail: 'full' });
  check('a gap module draws nothing', meshes(gw, m => m.name === 'carcass').map(boxCm).every(b => b.x1 <= -40 + 0.01 || b.x0 >= 0 - 0.01));
  warnings.length = 0;
  const ov = K.layoutWallModules([{ kind: 'cabinet', width: 60 }, { kind: 'cabinet', width: 60, at: 30 }], 200, 'bare');
  check('an `at` that overlaps is pushed right, with a warning', near(ov[1].x0, -40, 0.01) && warnings.some(w => /overlaps/.test(w)), { ov, warnings });
  warnings.length = 0;
  const past = K.layoutWallModules([{ kind: 'cabinet', width: 60, at: 170 }], 200, 'bare');
  check('a module past the end is cut short, with a warning', near(past[0].x1, 100, 0.01) && warnings.some(w => /past the end/.test(w)), { past, warnings });
  // Base runs keep their filler, and may have a bare `gap` under the worktop.
  const bp = Object.assign({}, BASE.DEFAULTS, { width: 180, modules: [{ kind: 'cabinet', width: 60 }, { kind: 'gap', width: 60 }, { kind: 'cabinet', width: 60 }] });
  const bg = BASE.build(THREE, bp, { detail: 'full' });
  check('base gap: no carcass or plinth under it', meshes(bg, m => m.name === 'carcass' || m.name === 'plinth').map(boxCm)
    .every(b => b.x1 <= -30 + 0.01 || b.x0 >= 30 - 0.01));
  check('base gap: the worktop runs over it', worktopTiling(bg, bp) === 0);
  checkEnvelope('base with a gap', BASE, bp);
}

// 10.2 hinge "top": a lift-up flap, handle along its bottom edge, hinge line along its top.
[[BASE, 'base'], [WALL, 'wall']].forEach(([impl, tag]) => {
  const p = Object.assign({}, impl.DEFAULTS, { width: 60, modules: [{ kind: 'cabinet', width: 60, height: impl === WALL ? 40 : undefined, hinge: 'top' }] });
  if (impl === WALL) p.height = 40;
  const g = impl.build(THREE, p, { detail: 'full' });
  const flap = meshes(g, m => m.name === 'flap').map(boxCm);
  check(tag + ' hinge top: one flap, no side door', flap.length === 1 && meshes(g, m => m.name === 'door').length === 0, meshes(g).map(m => m.name));
  const h = meshes(g, m => m.name === 'handle').map(boxCm)[0];
  const line = meshes(g, m => m.name === 'door-gap').map(boxCm)[0];
  check(tag + ' hinge top: the handle is horizontal, centred, in the lower quarter of the flap', !!h && h.x1 - h.x0 > h.y1 - h.y0 &&
    near((h.x0 + h.x1) / 2, 0, 0.05) && (h.y0 + h.y1) / 2 < flap[0].y0 + (flap[0].y1 - flap[0].y0) / 4, { h, flap });
  check(tag + ' hinge top: the hinge line runs along the top edge', !!line && line.x1 - line.x0 > 50 && near(line.y1, flap[0].y1, 0.05), { line, flap });
  checkEnvelope(tag + ' with a top-hinged flap', impl, p);
});
{
  const wide = build(BASE, { width: 90, modules: [{ kind: 'cabinet', width: 90, hinge: 'top' }] });
  check('a 90 cm top-hinged cabinet is one flap, not two doors', meshes(wide, m => m.name === 'flap').length === 1 && meshes(wide, m => m.name === 'door').length === 0);
}

// 10.3 Wall runs do not corner: a 70 cm cabinet from the wall is ONE door; `corner` is ignored.
{
  warnings.length = 0;
  const p = { width: 130, height: 70, corner: 'left', modules: [{ kind: 'cabinet', width: 70, hinge: 'left' }, { kind: 'cabinet', width: 60, hinge: 'right' }] };
  const g = build(WALL, p);
  const ds = meshes(g, m => m.name === 'door').map(boxCm).sort((a, b) => a.x0 - b.x0);
  check('wall: the 70 cm cabinet from the wall is one door', ds.length === 2 && near(ds[0].x1 - ds[0].x0, 70 - 0.3, 0.05), ds);
  check('wall: no blind panel on a wall run', meshes(g, m => m.name === 'blind-panel').length === 0);
  check('wall: `corner` is ignored, with a warning', warnings.some(w => /do not corner/.test(w)), warnings);
  warnings.length = 0;
  const c = build(WALL, { width: 60, modules: [{ kind: 'corner', width: 60 }] });
  check('wall: a `corner` module is drawn as a cabinet, with a warning', meshes(c, m => m.name === 'door').length === 1 &&
    meshes(c, m => m.name === 'blind-panel').length === 0 && warnings.some(w => /drawn as a cabinet/.test(w)));
  check('wall DEFAULTS carry no corner', !('corner' in WALL.DEFAULTS) && !('cornerDepth' in WALL.DEFAULTS));
  // Base runs still corner.
  check('base: corner still gives a blind panel', meshes(build(BASE, { width: 100, corner: 'left', modules: [{ kind: 'corner', width: 100 }] }), m => m.name === 'blind-panel').length === 1);
  // With no hinge, a wide cabinet still gets two doors.
  check('no hinge, 80 cm: two doors', meshes(build(WALL, { width: 80, modules: [{ kind: 'cabinet', width: 80 }] }), m => m.name === 'door').length === 2);
}

// 10.4 Every wall door shows which way it opens: handle on the opening edge, hinge line on the other.
{
  ['left', 'right'].forEach(hinge => {
    [BASE, WALL].forEach(impl => {
      const g = build(impl, { width: 60, modules: [{ kind: 'cabinet', width: 60, hinge: hinge }] });
      const d = boxCm(meshes(g, m => m.name === 'door')[0]);
      const h = boxCm(meshes(g, m => m.name === 'handle')[0]);
      const l = boxCm(meshes(g, m => m.name === 'door-gap')[0]);
      const hc = (h.x0 + h.x1) / 2, lc = (l.x0 + l.x1) / 2;
      const ok = hinge === 'left' ? (lc < d.x0 + 1 && hc > 0) : (lc > d.x1 - 1 && hc < 0);
      check((impl === WALL ? 'wall' : 'base') + ' hinge ' + hinge + ': hinge line on the hinge edge, handle on the other', ok, { d, h, l });
    });
  });
  const ex = JSON.parse(JSON.stringify(K.EXAMPLE_L));
  ['wall', 'wallB'].forEach(k => {
    const g = WALL.build(THREE, Object.assign({}, WALL.DEFAULTS, ex[k]), { detail: 'full' });
    const fronts = meshes(g, m => m.name === 'door' || m.name === 'flap').length;
    check('EXAMPLE_L.' + k + ': every wall door has a handle and a hinge line', fronts > 0 &&
      meshes(g, m => m.name === 'handle').length === fronts && meshes(g, m => m.name === 'door-gap').length === fronts,
      { fronts, handles: meshes(g, m => m.name === 'handle').length, lines: meshes(g, m => m.name === 'door-gap').length });
  });
  const low = build(WALL, { width: 60, modules: [{ kind: 'cabinet', width: 60, hinge: 'left' }] }, 'low');
  check('low detail drops the hinge line and the handle', meshes(low, m => m.name === 'door-gap' || m.name === 'handle').length === 0);
  // The hinge line merges into the matte bucket: no extra draw for the example L.
  check('hinge lines cost no draw', draws(Object.values(placeL(JSON.parse(JSON.stringify(K.EXAMPLE_L))))).size <= 4);
}

// ---- 11. Load JSON cannot take bad data -----------------------------------------------
{
  const slots = ['kitchen-base-run', 'kitchen-base-run', 'kitchen-wall-run', 'kitchen-wall-run', 'fridge-freezer'];
  const entry = params => JSON.stringify([{ type: 'kitchen-base-run', params: params }]);
  const throwsWith = (text, re) => { try { K.parseKitchenJson(text, slots, THREE); return false; } catch (e) { return re.test(e.message); } };
  // The two review repros: both used to report "Loaded." and then blank the page.
  check('Load JSON: modules "x" is refused before anything is swapped', throwsWith(entry({ modules: 'x' }), /modules must be an array/));
  check('Load JSON: modules [null] is refused', throwsWith(entry({ modules: [null] }), /modules\[0\] must be an object/));
  check('Load JSON: a widthless module is refused', throwsWith(entry({ modules: [{ kind: 'cabinet' }] }), /width must be a positive number/));
  check('Load JSON: an unknown hinge is refused', throwsWith(entry({ modules: [{ kind: 'cabinet', width: 60, hinge: 'up' }] }), /hinge must be left, right or top/));
  check('Load JSON: a non-numeric width is refused', throwsWith(entry({ width: '180' }), /width must be a positive number/));
  check('Load JSON: a wrong type in a slot is refused', throwsWith(JSON.stringify([{ type: 'fridge-freezer', params: {} }]), /should be a kitchen-base-run/));
  check('Load JSON: not an array is refused', throwsWith('{}', /expected an array/));
  // What Copy JSON gives round-trips, and a wall corner from an older export is dropped.
  const ex = JSON.parse(JSON.stringify(K.EXAMPLE_L));
  const keys = ['a', 'b', 'wall', 'wallB', 'fridge'];
  const text = JSON.stringify(keys.map((k, i) => ({ type: slots[i], params: K.paramsDiff(slots[i], Object.assign({}, K.TYPES[slots[i]].DEFAULTS, ex[k])) })));
  let back = null;
  try { back = K.parseKitchenJson(text, slots, THREE); } catch (e) { back = e.message; }
  check('Load JSON: the example L round-trips through Copy JSON', Array.isArray(back) && back.length === 5 &&
    back[2].modules.length === ex.wall.modules.length && back[0].corner === 'left', back);
  const old = JSON.parse(text);
  old[2].params.corner = 'left'; old[2].params.cornerDepth = 30;
  const b2 = K.parseKitchenJson(JSON.stringify(old), slots, THREE);
  check('Load JSON: a wall run corner from an older export is dropped', !('corner' in b2[2]) && !('cornerDepth' in b2[2]), Object.keys(b2[2]));
  check('Load JSON: ...so the result validates against the wall-run rules', K.validateParams('kitchen-wall-run', b2[2]).length === 0);
  // The trial build is real: a builder that throws is reported, not swallowed.
  // A THREE that cannot build anything stands in for a builder that throws.
  const T2 = {};
  check('Load JSON: a piece that does not build is refused', (() => { try { K.parseKitchenJson(JSON.stringify([{ type: 'kitchen-base-run', params: {} }]), slots, T2); return false; } catch (e) { return /entry 1 does not build/.test(e.message); } })());
}

// ---- 9. Copy JSON ------------------------------------------------------------------
{
  const d = K.paramsDiff('kitchen-base-run', Object.assign({}, BASE.DEFAULTS, { corner: 'left', frontColor: '#223344' }));
  check('paramsDiff keeps only changed keys, plus a run\'s width',
    JSON.stringify(Object.keys(d).sort()) === JSON.stringify(['corner', 'frontColor', 'width']), d);
  const m = K.paramsDiff('kitchen-base-run', Object.assign({}, BASE.DEFAULTS, { modules: [{ kind: 'sink', width: 60 }] }));
  check('paramsDiff notices a changed module list', Array.isArray(m.modules) && m.modules[0].kind === 'sink', m);
  check('paramsDiff: unchanged fridge is empty', JSON.stringify(K.paramsDiff('fridge-freezer', Object.assign({}, FRIDGE.DEFAULTS))) === '{}');
  check('paramsDiff: unknown type is null', K.paramsDiff('nope', {}) === null);
}

console.warn = savedWarn;
console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
