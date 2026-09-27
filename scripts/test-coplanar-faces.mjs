#!/usr/bin/env node
/**
 * No two faces of one furniture item may z-fight.
 * No framework, no install: `node scripts/test-coplanar-faces.mjs`.
 *
 * WHY. The owner's review found a shimmer of diagonal dotted streaks across
 * the TV screen and every photo frame, jagged vertical edges on the cabinet
 * mirror panes and jagged edges on the TV console, all changing as the view
 * turned (items 7cea6f9f, 19c25304). Each was two surfaces at the same depth:
 * a screen box whose face sat exactly on the body's face, a mirror pane
 * running under its stile in the stile's plane, a dark console top whose end
 * faces shared the white sides' planes. The depth buffer cannot order such a
 * pair, so which one wins flips per pixel and per frame.
 *
 * THE RULE (scripts/lib-coplanar.mjs): two triangles from different meshes
 * of one item, facing the same way, within TOL (1 mm) of one plane and
 * overlapping by more than 1 mm^2, fail. Faces that only touch along an edge,
 * and back-to-back faces, are fine. A pair whose two materials shade every
 * pixel identically (same finish, colour, side, opacity, ...) is counted but
 * exempt: whichever wins, the pixel is the same.
 *
 * SCOPE: every cabinet preset on the Cabinet spec page and every small-items
 * type/preset, each at 'full' and 'low' detail. (The detector finds fights
 * in some OTHER builders too -- bed, kitchen, radiator, plant -- which belong
 * to their own crews and are tracked separately.)
 *
 * SELF-TEST first: a flush overlay pair and a same-finish different-colour
 * flush pair MUST be caught; a 2 mm-separated pair and an identical-look
 * flush pair must not fail.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const { findCoplanarFights } = await imp('scripts/lib-coplanar.mjs');
const { makeFinish } = await imp('src/furniture/finishes.js');
const SI = await imp('src/furniture/small-items.js');
const C = await imp('src/furniture/cabinet.js');
const { CABINET_PRESETS } = await imp('scripts/lib-cabinet-presets.mjs');

const TOL = 0.001;
const VERBOSE = process.argv.includes('--verbose');
let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// ---- self-test -------------------------------------------------------------
function pair(THREE, gap, finishA, colorA, finishB, colorB) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.05).translate(0, 0.15, 0.025), makeFinish(THREE, finishA, colorA));
  body.name = 'body';
  // A thin overlay whose front face is `gap` in front of the body's front face.
  const over = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.004).translate(0, 0.15, 0.05 + gap - 0.002), makeFinish(THREE, finishB, colorB));
  over.name = 'overlay';
  g.add(body, over);
  return g;
}
{
  const flush = findCoplanarFights(THREE, pair(THREE, 0, 'matte', '#111111', 'emissive', '#1a2733'), { tol: TOL });
  check('self-test: a flush screen on a body is caught', flush.fights.length > 0, flush);
  const near = findCoplanarFights(THREE, pair(THREE, 0.0005, 'matte', '#111111', 'emissive', '#1a2733'), { tol: TOL });
  check('self-test: a screen 0.5 mm proud is still caught (within 1 mm)', near.fights.length > 0, near);
  const apart = findCoplanarFights(THREE, pair(THREE, 0.002, 'matte', '#111111', 'emissive', '#1a2733'), { tol: TOL });
  check('self-test: a screen 2 mm proud passes', apart.fights.length === 0, apart.fights);
  const tint = findCoplanarFights(THREE, pair(THREE, 0, 'matte', '#f2f0ec', 'matte', '#ffffff'), { tol: TOL });
  check('self-test: same finish, different colour, flush is caught', tint.fights.length > 0, tint);
  const same = findCoplanarFights(THREE, pair(THREE, 0, 'matte', '#ffffff', 'matte', '#ffffff'), { tol: TOL });
  check('self-test: identical look, flush, is exempt (not a failure)', same.fights.length === 0 && same.identical.length > 0, same);
  const strict = findCoplanarFights(THREE, pair(THREE, 0, 'matte', '#ffffff', 'matte', '#ffffff'), { tol: TOL, identicalLookExempt: false });
  check('self-test: identical look is still DETECTED when the exemption is off', strict.fights.length > 0, strict);
}

// ---- the builders ----------------------------------------------------------
function run(tag, build, params) {
  ['full', 'low'].forEach(detail => {
    let g;
    try { g = build(THREE, params, { detail }); } catch (e) {
      check(tag + ' [' + detail + ']: builds', false, String(e && e.message || e));
      return;
    }
    const r = findCoplanarFights(THREE, g, { tol: TOL });
    check(tag + ' [' + detail + ']: no two faces z-fight (coplanar within 1 mm, overlapping)', r.fights.length === 0,
      r.fights.slice(0, 6).map(f => f.a + ' <-> ' + f.b + ' gap ' + (f.gap * 1000).toFixed(2) + 'mm area ' + (f.area * 1e4).toFixed(2) + 'cm2'));
    if (VERBOSE) console.log(tag + ' [' + detail + ']: ' + r.fights.length + ' fights, ' + r.identical.length + ' identical-look pairs exempt');
  });
}

// Cabinet: every preset on the spec page.
Object.keys(CABINET_PRESETS).forEach(k => run('cabinet ' + k, C.build, CABINET_PRESETS[k].params));

// Small items: every type at DEFAULTS plus the presets the spec page offers.
const T = SI.TYPES;
const P = (type, delta) => Object.assign({}, T[type].DEFAULTS, delta || {});
const SMALL = [
  ['tv: thin', 'tv', P('tv')],
  ['tv: on stand', 'tv', P('tv', { stand: true, height: T.tv.DEFAULTS.height + T.tv.DEFAULTS.standHeight, depth: T.tv.DEFAULTS.standDepth })],
  ['tv: picture-frame', 'tv', P('tv', { bezelStyle: 'picture-frame' })],
  ['photo-frame: single', 'photo-frame', P('photo-frame')],
  ['photo-frame: 4 panels', 'photo-frame', P('photo-frame', { width: 140, height: 40, panels: 4 })],
  ['photo-frame: 5 panels', 'photo-frame', P('photo-frame', { width: 250, height: 60, panels: 5 })],
  ['speaker: wall trapezoid', 'speaker', P('speaker')],
  ['speaker: wall box', 'speaker', P('speaker', { boxShape: true })],
  ['speaker: no grille', 'speaker', P('speaker', { grille: false })],
  ['speaker: floor-standing', 'speaker', P('speaker', { kind: 'floor-standing', width: 16.5, depth: 24, height: 90 })],
  ['speaker: floor-standing, 3 mids', 'speaker', P('speaker', { kind: 'floor-standing', width: 16.5, depth: 24, height: 90, midDrivers: 3 })],
  ['speaker: ceiling down', 'speaker', P('speaker', { kind: 'ceiling', width: 18.5, depth: 18.5, height: 31, firing: 'down' })],
  ['speaker: ceiling angled', 'speaker', P('speaker', { kind: 'ceiling', width: 18.5, depth: 18.5, height: 31, firing: 'angled' })],
  ['speaker: ceiling up', 'speaker', P('speaker', { kind: 'ceiling', width: 18.5, depth: 18.5, height: 31, firing: 'up' })],
  ['speaker: centre', 'speaker', P('speaker', { kind: 'centre', width: 45, depth: 20, height: 16.5 })],
  ['subwoofer', 'subwoofer', P('subwoofer')],
  ['tube-floor-lamp: all-round', 'tube-floor-lamp', P('tube-floor-lamp')],
  ['tube-floor-lamp: one-sided', 'tube-floor-lamp', P('tube-floor-lamp', { oneSidedGlow: true })],
  ['coat-rack: 3 coats', 'coat-rack', P('coat-rack', { coats: 3, height: 65 })],
  ['mirror: rect', 'mirror', P('mirror')],
  ['mirror: round', 'mirror', P('mirror', { shape: 'round' })],
  ['mirror: pebble', 'mirror', P('mirror', { shape: 'pebble' })],
  ['mirror: triangle', 'mirror', P('mirror', { shape: 'triangle', width: 55, height: 70 })],
  ['shelf: single', 'shelf', P('shelf')],
  ['shelf: LED edge', 'shelf', P('shelf', { led: true })],
  ['shelf: stack of 3', 'shelf', P('shelf', { levels: [30, 30], height: 75 })],
  ['shelf: back panel', 'shelf', P('shelf', { width: 180, depth: 22, height: 20, backPanel: true })],
  ['shelf: back panel + LED', 'shelf', P('shelf', { width: 180, depth: 22, height: 20, backPanel: true, led: true })],
  ['monitor: flat', 'monitor', P('monitor')],
  ['monitor: flat on riser', 'monitor', P('monitor', { riser: true, depth: 25 })],
  ['monitor: curved', 'monitor', P('monitor', { curved: true })],
  ['pc-tower', 'pc-tower', P('pc-tower')]
];
SMALL.forEach(([tag, type, p]) => run(tag, T[type].build, p));

console.log(`test-coplanar-faces: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
