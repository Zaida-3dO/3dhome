#!/usr/bin/env node
/**
 * Kitchen builders (src/furniture/kitchen.js): the behaviour the generic
 * builder contract in test-furniture-core.mjs cannot see. No framework, no
 * install: `node scripts/test-furniture-kitchen.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. The envelope beyond DEFAULTS: sinks, splashbacks, corners, every
 *      handle style, narrow doors, mixed wall heights, a top freezer. The
 *      only parts allowed above a base run's `height` (the worktop top) are
 *      the ones tagged aboveWorktop -- a tap and a splashback.
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

/** The envelope checks: bbox == width/depth, centred, bottom at 0, back at 0, and height == params. */
function checkEnvelope(tag, impl, params) {
  const p = Object.assign({}, impl.DEFAULTS, params);
  const g = build(impl, params);
  const all = meshes(g);
  const above = all.filter(m => m.userData.aboveWorktop === true);
  const body = unionBox(all.filter(m => m.userData.aboveWorktop !== true));
  const whole = boxCm(g);
  check(tag + ': width == params', near(whole.x1 - whole.x0, p.width), { whole, width: p.width });
  check(tag + ': centred on x', near((whole.x0 + whole.x1) / 2, 0), whole);
  check(tag + ': bottom at y = 0', near(whole.y0, 0), whole);
  check(tag + ': back at z = 0', near(whole.z0, 0), whole);
  check(tag + ': depth == params', near(whole.z1 - whole.z0, p.depth), { whole, depth: p.depth });
  check(tag + ': height (without tap/splashback) == params', near(body.y1, p.height), { body, height: p.height });
  [...new Set(above.map(m => m.name))].forEach(name => {
    const b = unionBox(above.filter(m => m.name === name));
    check(tag + ': the ' + name + ' stands on the worktop', near(b.y0, p.height, 0.05), b);
  });
  const bad = all.filter(m => Fin.partFinish(m).error);
  check(tag + ': every part has a palette finish', bad.length === 0, bad.map(m => m.name));
  const low = build(impl, params, 'low');
  const tri = gr => meshes(gr).reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
  check(tag + ': low detail is lighter', tri(low) <= tri(g), { full: tri(g), low: tri(low) });
  return { g, above };
}

// ---- 1. envelopes beyond DEFAULTS ------------------------------------------------
{
  const sink = checkEnvelope('base with inset sink + splashback', BASE, {
    width: 214, corner: 'right',
    modules: [{ kind: 'sink', width: 60 }, { kind: 'hob', width: 60, splashback: 60 },
      { kind: 'cabinet', width: 34 }, { kind: 'corner', width: 60 }],
  });
  check('sink run: the tap and the splashback are the parts above the worktop',
    sink.above.some(m => m.name === 'tap') && sink.above.some(m => m.name === 'splashback') &&
    sink.above.every(m => m.name === 'tap' || m.name === 'splashback'), sink.above.map(m => m.name));
  checkEnvelope('base with undermount sink, no tap', BASE, { modules: [{ kind: 'sink', width: 80, bowl: 'undermount', tap: false }, { kind: 'washer', width: 60 }, { kind: 'filler', width: 40 }] });
  ['bar', 'knob', 'rail', 'none'].forEach(h => checkEnvelope('base, handleStyle ' + h, BASE, { handleStyle: h, corner: 'left',
    modules: [{ kind: 'corner', width: 100 }, { kind: 'cabinet', width: 80 }] }));
  checkEnvelope('base, narrow doors', BASE, { width: 83, modules: [{ kind: 'cabinet', width: 34 }, { kind: 'cabinet', width: 34, hinge: 'right' }, { kind: 'cabinet', width: 15 }] });
  checkEnvelope('wall, mixed heights + canopy', WALL, { height: 86, modules: [{ kind: 'cabinet', width: 60 }, { kind: 'hood', width: 60, style: 'canopy', height: 66 }, { kind: 'open', width: 60, height: 66 }] });
  checkEnvelope('wall, chimney only', WALL, { width: 60, modules: [{ kind: 'hood', width: 60 }] });
  checkEnvelope('fridge, top freezer, left hinge', FRIDGE, { freezer: 'top', hinge: 'left', width: 70, height: 200 });

  // The above-worktop rule can fail: a splashback whose tag is removed must be caught.
  const g = build(BASE, { modules: [{ kind: 'hob', width: 60, splashback: 60 }], width: 60 });
  const sb = meshes(g, m => m.name === 'splashback')[0];
  sb.userData.aboveWorktop = false;
  const body = unionBox(meshes(g, m => m.userData.aboveWorktop !== true));
  check('probe: an untagged splashback breaks the height envelope', !near(body.y1, BASE.DEFAULTS.height), body);
}

// ---- 1b. narrow doors keep their handles on the door ----------------------------
{
  [34, 15].forEach(w => {
    const g = build(BASE, { width: w, modules: [{ kind: 'cabinet', width: w }] });
    const door = boxCm(meshes(g, m => m.name === 'door')[0]);
    const h = boxCm(meshes(g, m => m.name === 'handle')[0]);
    check('a ' + w + ' cm door keeps its handle inside it', h.x0 > door.x0 && h.x1 < door.x1, { door, h });
    check('a ' + w + ' cm door is one door', meshes(g, m => m.name === 'door').length === 1);
  });
  const g = build(BASE, { width: 34, modules: [{ kind: 'cabinet', width: 34, hinge: 'left' }] });
  const gR = build(BASE, { width: 34, modules: [{ kind: 'cabinet', width: 34, hinge: 'right' }] });
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
  check('L: the example runs differ in depth (60 against 65)', ex.b.depth !== (ex.a.depth || BASE.DEFAULTS.depth), ex.b.depth);
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
  const p = { width: 154, modules: [{ kind: 'cabinet', width: 60 }, { kind: 'dishwasher', width: 60 }, { kind: 'cabinet', width: 34 }],
    sink: { at: 60, width: 95, depth: 50, bowl: 'inset', drainer: 'right' } };
  const env = checkEnvelope('base with a run-level 95 cm sink', BASE, p);
  const g = env.g;
  const out = unionBox(meshes(g, m => m.name === 'sink' || m.name === 'sink-rim'));
  check('run-level sink: 95 cm wide, centred `at` 60 cm from the left end', near(out.x1 - out.x0, 95, 0.05) && near((out.x0 + out.x1) / 2, -77 + 60, 0.05), out);
  check('run-level sink: spans the module boundary at 60 cm', out.x0 < -17 && out.x1 > -17, out);
  check('run-level sink: 50 cm deep', near(out.z1 - out.z0, 50, 0.05), out);
  check('run-level sink: its plate is flush with the worktop', near(out.y1, BASE.DEFAULTS.height, 0.01), out);
  check('run-level sink: has a tap', env.above.some(m => m.name === 'tap'));
  const covering = meshes(g, m => m.name === 'worktop').map(boxCm)
    .filter(b => b.x0 < out.x1 - 0.01 && b.x1 > out.x0 + 0.01 && b.z0 < out.z1 - 0.01 && b.z1 > out.z0 + 0.01);
  check('run-level sink: the worktop is cut for it', covering.length === 0, covering);
  // The bowl is beside the drainer, not across it.
  const bowl = unionBox(meshes(g, m => m.name === 'sink'));
  check('drainer right: the bowl is in the left part of the sink', bowl.x1 < (out.x0 + out.x1) / 2 + 5, { bowl, out });

  warnings.length = 0;
  const off = build(BASE, { sink: { at: 5, width: 95 } });
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
  check('L: a 56 cm wall unit hangs 65 cm over the worktop (its LED recess 1 cm up)', short.length > 0 && short.every(b => near(b.y0, 88.5 + 65 + 1, 0.05)), short);
  const tall = meshes(L.wall, m => m.name === 'carcass').map(boxCm).filter(b => b.y1 - b.y0 > 60);
  check('L: a 72 cm wall unit hangs 49 cm over the worktop (its LED recess 1 cm up)', tall.length > 0 && tall.every(b => near(b.y0, 88.5 + 49 + 1, 0.05)), tall);
  check('L: the fridge-freezer meets the top line', near(boxCm(L.fridge).y1, ex.wallTop, 0.05), boxCm(L.fridge));
  check('elevationForTop: 209.5 top, 72 run -> 137.5', near(K.elevationForTop(209.5, { height: 72 }), 137.5, 1e-9));

  ['under-led', 'top-led'].forEach(name => {
    const leds = [...meshes(L.wall, m => m.name === name), ...meshes(L.wallB, m => m.name === name)];
    check('L: ' + name + ' strips exist, emissive and kept', leds.length >= 3 &&
      leds.every(m => Fin.partFinish(m).finish === 'emissive' && Fin.partKeep(m).keep === true), leds.length);
    const ret = meshes(L.wall, m => m.name === name).map(boxCm).find(b => b.z1 - b.z0 > b.x1 - b.x0);
    const bS = meshes(L.wallB, m => m.name === name).map(boxCm).filter(b => b.z1 - b.z0 > b.x1 - b.x0)
      .sort((p, q) => p.z0 - q.z0)[0];
    check('L: ' + name + ' turns the wall corner and meets the other run\'s strip', !!ret && !!bS &&
      near(ret.z1, bS.z0, 0.05) && near(ret.x0, bS.x0, 0.05) && near(ret.y0, bS.y0, 0.05), { ret, bS });
  });
  const under = meshes(L.wall, m => m.name === 'under-led').map(boxCm);
  check('L: under-cabinet strips follow each module\'s own bottom (72 and 56 differ)',
    new Set(under.map(b => Math.round(b.y0))).size === 2, under.map(b => b.y0));
  check('L: no LED under the hood', under.every(b => b.x1 <= 125 + 0.05 || b.x0 >= 185 - 0.05), under);

  // Probe: the continuity check fails when the wall owner is told the wrong depth.
  const wrong = JSON.parse(JSON.stringify(ex));
  wrong.wall.cornerDepth = 40;
  const Lw = placeL(wrong);
  const r = meshes(Lw.wall, m => m.name === 'top-led').map(boxCm).find(b => b.z1 - b.z0 > b.x1 - b.x0);
  const q = meshes(Lw.wallB, m => m.name === 'top-led').map(boxCm).filter(b => b.z1 - b.z0 > b.x1 - b.x0).sort((p, q2) => p.z0 - q2.z0)[0];
  check('probe: a wrong wall cornerDepth breaks the top strip', !!r && !!q && !near(r.x0, q.x0, 0.05), { r, q });

  // One LED colour everywhere: four draws. A second colour is the fifth.
  check('L with plinth, under and top strips in one colour: four draws or fewer', draws(Object.values(L)).size <= 4, [...draws(Object.values(L))]);
  const two = JSON.parse(JSON.stringify(ex));
  two.wall.underLedColor = two.wallB.underLedColor = '#4060ff';
  check('probe: a second LED colour costs the fifth draw', draws(Object.values(placeL(two))).size === 5, [...draws(Object.values(placeL(two)))]);

  const f = build(FRIDGE, {});
  const ds = meshes(f, m => m.name === 'door').map(boxCm).sort((p, q2) => p.y0 - q2.y0);
  check('fridge: freezer door is freezerHeight (93) over the plinth (13)', near(ds[0].y0, 13, 0.2) && near(ds[0].y1, 13 + 93, 0.2), ds[0]);
  check('fridge: stands on a recessed plinth', meshes(f, m => m.name === 'plinth').length === 1 &&
    boxCm(meshes(f, m => m.name === 'plinth')[0]).z1 <= FRIDGE.DEFAULTS.depth - 7.9);
  check('fridge: plinthLed draws a strip', meshes(build(FRIDGE, { plinthLed: true }), m => m.name === 'plinth-led').length === 1);
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
