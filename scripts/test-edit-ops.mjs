#!/usr/bin/env node
/**
 * Edit mode's furniture edits (src/edit-ops.js) on the demo house. No
 * framework, no install:
 *   node scripts/test-edit-ops.mjs
 *   node scripts/test-edit-ops.mjs --write <dir>
 *       also writes an export with a move, a rotation, a param change and a
 *       delete over the two JSON files in <dir> -- a temp COPY of
 *       houses/demo -- for CI's house-profiles job to run
 *       `validate-house.py --strict` on. <dir> must be outside the repo.
 *
 * WHAT THIS GUARDS
 *   1. moveItem / rotateItem / setParam / deleteItem change only their item:
 *      every other item is the SAME object (structural sharing), the input
 *      document is never mutated, and the result compiles with the change.
 *   2. Snapping (1 cm), rotation folding, the anchor rules (a free item
 *      moves by `at`, a wall-anchored one by `centre`, and never rotates),
 *      mirror keys, and the shape check.
 *   3. The export of an edited document (src/profile-export.js) changes ONLY
 *      the edited items' lines: untouched items are byte-identical.
 *   4. Confinement: a free move stays in its room polygon and slides along a
 *      wall (an L-shaped room included); a wall item's span is its own
 *      room's stretch of the wall.
 *   5. Live slider bounds (a desk's topHeight between minHeight and
 *      maxHeight) and the dependent re-clamp.
 *   6. The camera-relative arrow nudge and the Frame panel's log distance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const readRaw = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail).slice(0, 600) : '')); }
}

const E = await imp('src/edit-ops.js');
const { HouseLoader } = await imp('src/house-loader.js');
const { exportProfile } = await imp('src/profile-export.js');
const { parseWithSpans } = await imp('src/json-layout.js');
const { controlsFor } = await imp('src/furniture/controls.js');
const desk = await imp('src/furniture/standing-desk.js');

const geoText = readRaw('houses/demo/geometry.json');
const roomsText = readRaw('houses/demo/rooms.json');
const fresh = () => JSON.parse(geoText);
const compile = d => HouseLoader.compile(d, 'houses/demo/');
const compiledItem = (d, id) => compile(d).furniture.find(f => f.id === id);
const sameOthers = (a, b, ids) => a.furniture.every(f => ids.includes(f.id) || b.furniture.includes(f));

console.log('1. ops change only their item');
{
  const d = fresh();
  const snapshot = JSON.stringify(d);
  const m = E.moveItem(d, 'study_chair', { at: [700.4, 130.6] });
  check('move: at snapped to 1 cm', JSON.stringify(E.findItem(m, 'study_chair').at) === '[700,131]', E.findItem(m, 'study_chair').at);
  check('move: every other item is the same object', sameOthers(d, m, ['study_chair']));
  check('move: the rest of the document is shared', m.rooms === d.rooms && m.walls === d.walls);
  check('move: the input is not mutated', JSON.stringify(d) === snapshot);
  const cm = compiledItem(m, 'study_chair');
  check('move: compiles at the new place', cm && cm.x === 700 && cm.y === 131, cm && [cm.x, cm.y]);

  const w = E.moveItem(d, 'study_desk', { centre: 700.6 });
  check('move (wall): centre snapped and compiled along the wall', E.findItem(w, 'study_desk').centre === 701 && compiledItem(w, 'study_desk').x === 701);
  let threw = null;
  try { E.moveItem(d, 'study_desk', { at: [1, 2] }); } catch (e) { threw = e.message; }
  check('move (wall): an `at` move is refused (never re-anchors)', /wall-anchored/.test(threw || ''), threw);
  threw = null;
  try { E.moveItem(d, 'study_chair', { centre: 5 }); } catch (e) { threw = e.message; }
  check('move (free): a `centre` move is refused', /free-standing/.test(threw || ''), threw);

  const r = E.rotateItem(d, 'study_chair', 90);
  check('rotate: 180 + 90 = 270', E.findItem(r, 'study_chair').rotation === 270);
  check('rotate: compiles with the turn', compiledItem(r, 'study_chair').rotationDeg === 270);
  check('rotate: wraps past 360', E.findItem(E.rotateItem(r, 'study_chair', 105), 'study_chair').rotation === 15);
  check('rotate: wraps below 0', E.findItem(E.rotateItem(d, 'study_chair', -195), 'study_chair').rotation === 345);
  const noRot = E.rotateItem(d, 'store_crate', -15);
  check('rotate: an item with no rotation key gets one (345)', E.findItem(noRot, 'store_crate').rotation === 345);
  threw = null;
  try { E.rotateItem(d, 'study_desk', 15); } catch (e) { threw = e.message; }
  check('rotate: a wall-anchored item is refused', /faces into its room/.test(threw || ''), threw);

  const p = E.setParam(d, 'study_desk', 'topHeight', 110);
  check('setParam: written', E.findItem(p, 'study_desk').params.topHeight === 110);
  check('setParam: key order kept (topHeight stays third)', Object.keys(E.findItem(p, 'study_desk').params).join() === 'width,depth,topHeight,height');
  check('setParam: compiles with it', compiledItem(p, 'study_desk').params.topHeight === 110);
  check('setParam: the original params untouched', E.findItem(d, 'study_desk').params.topHeight === 74);
  const pc = E.setParam(d, 'study_chair', 'seatHeight', 50);
  check('setParam: an item with no params gets them', E.findItem(pc, 'study_chair').params.seatHeight === 50);
  const mir = E.setParam(d, 'store_crate', 'width', 70, { mirror: ['depth'] });
  check('setParam: mirror writes the other keys too', E.findItem(mir, 'store_crate').params.width === 70 && E.findItem(mir, 'store_crate').params.depth === 70);

  const del = E.deleteItem(d, 'lounge_sideboard');
  check('delete: gone', !E.findItem(del, 'lounge_sideboard') && del.furniture.length === d.furniture.length - 1);
  check('delete: compiles without it', !compile(del).furniture.some(f => f.id === 'lounge_sideboard'));
  check('delete: others shared', del.furniture.every(f => d.furniture.includes(f)));
  threw = null;
  try { E.deleteItem(d, 'nope'); } catch (e) { threw = e.message; }
  check('delete: an unknown id throws', /no furniture item/.test(threw || ''));
}

console.log('2. shape check');
{
  const d = fresh();
  check('every demo item passes', d.furniture.every(f => E.checkFurnitureItem(f).length === 0), d.furniture.map(f => E.checkFurnitureItem(f)).filter(x => x.length));
  check('both anchors refused', E.checkFurnitureItem(Object.assign({}, E.findItem(d, 'study_chair'), { wall: 1, centre: 2 })).length > 0);
  check('at must be [x, y]', E.checkFurnitureItem(Object.assign({}, E.findItem(d, 'study_chair'), { at: [1] })).length > 0);
  check('a wall item with a rotation refused', E.checkFurnitureItem(Object.assign({}, E.findItem(d, 'study_desk'), { rotation: 90 })).length > 0);
  check('normDeg', E.normDeg(-15) === 345 && E.normDeg(720) === 0 && E.normDeg(359.96) === 0);
}

console.log('3. export: untouched items byte-identical');
let edited = null;
{
  let d = fresh();
  d = E.moveItem(d, 'study_chair', { at: [700, 131] });
  d = E.rotateItem(d, 'bedroom_wardrobe', 15);
  d = E.moveItem(d, 'study_desk', { centre: 720 });
  d = E.setParam(d, 'study_desk', 'topHeight', 100);
  d = E.deleteItem(d, 'store_crate');
  const out = exportProfile({ geometryText: geoText, roomsText }, { geometry: d, rooms: E.dropItemBindings(JSON.parse(roomsText), 'store_crate') });
  edited = out;
  check('parses back to the edited document', JSON.stringify(JSON.parse(out.geometry)) === JSON.stringify(d));
  // Each item's ORIGINAL source text (its span in the served file): every
  // untouched one must appear in the export verbatim, an edited one must not.
  const spans = parseWithSpans(geoText).m.find(m => m.k === 'furniture').n.items.map(n => geoText.slice(n.s, n.e));
  const touched = new Set(['study_chair', 'bedroom_wardrobe', 'study_desk', 'store_crate']);
  const idOf = t => JSON.parse(t).id;
  const keep = spans.filter(t => !touched.has(idOf(t)));
  check('every untouched item\'s text is in the export byte for byte (' + keep.length + ')', keep.length === spans.length - 4 &&
    keep.every(t => out.geometry.includes(t)), keep.filter(t => !out.geometry.includes(t)).map(idOf));
  check('... and no edited one is', spans.filter(t => touched.has(idOf(t))).every(t => !out.geometry.includes(t)));
  const before = geoText.split('\n'), after = out.geometry.split('\n');
  const removed = before.filter(l => !after.includes(l));
  check('a handful of lines changed, not the file (' + removed.length + ')', removed.length > 0 && removed.length <= 10, removed.length);
  check('rooms.json: only the deleted item\'s binding is gone', JSON.stringify(JSON.parse(out.rooms)) === JSON.stringify(E.dropItemBindings(JSON.parse(roomsText), 'store_crate')) &&
    !(JSON.parse(out.rooms).sensors.items || {}).store_crate && !!JSON.parse(roomsText).sensors.items.store_crate);
  const rDoc = JSON.parse(roomsText);
  check('dropItemBindings: an unbound id returns the same object', E.dropItemBindings(rDoc, 'study_chair') === rDoc);
  const rNext = E.dropItemBindings(rDoc, 'store_crate');
  check('dropItemBindings: the input is not mutated, the rest shared', !!rDoc.sensors.items.store_crate && rNext.rooms === rDoc.rooms);
  check('the export compiles', compile(JSON.parse(out.geometry)).furniture.length === fresh().furniture.length - 1);
  const noop = exportProfile({ geometryText: geoText, roomsText }, { geometry: fresh(), rooms: JSON.parse(roomsText) });
  check('a no-op export is byte-identical', noop.geometry === geoText);
}

console.log('4. confinement');
{
  const house = compile(fresh());
  const study = house.rooms.study.poly;
  const chair = compiledItem(fresh(), 'study_chair');
  const from = [chair.x, chair.y];
  check('inside: the target is kept', JSON.stringify(E.confineToPoly(study, from, [from[0] + 10, from[1] + 10])) === JSON.stringify([from[0] + 10, from[1] + 10]));
  const far = E.confineToPoly(study, from, [from[0] + 5000, from[1] + 7]);
  check('a drag through a wall slides along it (keeps the in-room axis)', far[0] === from[0] && far[1] === from[1] + 7, far);
  const out = E.confineToPoly(study, from, [-500, -500]);
  check('a target out on both axes stays put', out[0] === from[0] && out[1] === from[1], out);
  // An L-shaped room: a 300 x 300 square missing its top-right 150 x 150.
  const L = [[0, 0], [150, 0], [150, 150], [300, 150], [300, 300], [0, 300]];
  check('L room: into the notch is refused, sliding the free axis', JSON.stringify(E.confineToPoly(L, [100, 100], [200, 100])) === '[100,100]' &&
    JSON.stringify(E.confineToPoly(L, [100, 200], [200, 200])) === '[200,200]');
  check('L room: a diagonal into the notch keeps the legal axis', JSON.stringify(E.confineToPoly(L, [100, 160], [200, 140])) === '[100,140]' ||
    JSON.stringify(E.confineToPoly(L, [100, 160], [200, 140])) === '[200,160]', E.confineToPoly(L, [100, 160], [200, 140]));

  // Wall span: the study desk on wall 1 (the house's north wall, shared by
  // several rooms) keeps to the study's stretch of it.
  const w1 = house.wallsById[1];
  const deskC = compiledItem(fresh(), 'study_desk');
  const span = E.wallSpan(w1, study, deskC.y, 1);
  const xs = study.map(p => p[0]);
  check('wall span: axis x for a horizontal wall', span.axis === 'x');
  check('wall span: narrowed to the study (inside the wall\'s own extent)', span.lo >= Math.min(...xs) - 1 && span.hi <= Math.max(...xs) + 1 &&
    span.lo > Math.min(w1.x1, w1.x2) + 1, { span, xs: [Math.min(...xs), Math.max(...xs)], wall: [w1.x1, w1.x2] });
  check('wall span: holds the desk', deskC.x >= span.lo && deskC.x <= span.hi);
  const noPoly = E.wallSpan(w1, null, 0, 1);
  check('wall span: no room polygon -> the whole wall', noPoly.lo === Math.min(w1.x1, w1.x2) && noPoly.hi === Math.max(w1.x1, w1.x2));
  // Inward-wound: the same wall given with its ends swapped spans the same.
  const swapped = E.wallSpan({ x1: w1.x2, y1: w1.y2, x2: w1.x1, y2: w1.y1 }, study, deskC.y, 1);
  check('wall span: independent of the wall\'s winding', swapped.lo === span.lo && swapped.hi === span.hi);
}

console.log('5. live slider bounds');
{
  const controls = controlsFor('standing-desk', desk.DEFAULTS, desk.CONTROLS);
  const top = controls.find(c => c.key === 'topHeight');
  const params = Object.assign({}, desk.DEFAULTS, { minHeight: 70, maxHeight: 120 });
  const r = E.liveRange('standing-desk', top, params);
  check('desk topHeight narrowed to [minHeight, maxHeight]', r.min === 70 && r.max === 120, r);
  check('a type with no rule keeps its static range', JSON.stringify(E.liveRange('box', { key: 'width', min: 1, max: 9 }, {})) === '{"min":1,"max":9}');
  const w = E.paramWrites('standing-desk', controls, params, 'topHeight', 140);
  check('a write above maxHeight is clamped', w.topHeight === 120, w);
  const dep = E.paramWrites('standing-desk', controls, Object.assign({}, params, { topHeight: 74 }), 'minHeight', 90);
  check('raising minHeight lifts topHeight with it', dep.minHeight === 90 && dep.topHeight === 90, dep);
  const none = E.paramWrites('standing-desk', controls, Object.assign({}, params, { topHeight: 100 }), 'minHeight', 80);
  check('no dependent write when it still fits', none.topHeight === undefined, none);
}

console.log('6. nudge and distance scale');
{
  // th = 0: the camera sits at +x looking toward -x.
  check('Up moves away from the viewer (-x at th 0)', JSON.stringify(E.nudgeDir('ArrowUp', 0)) === '[-1,0]');
  check('Right is screen right (-y at th 0)', JSON.stringify(E.nudgeDir('ArrowRight', 0)) === '[0,-1]');
  check('Down is toward the viewer at th PI/2 (+y)', JSON.stringify(E.nudgeDir('ArrowDown', Math.PI / 2)) === '[0,1]');
  check('another key: null', E.nudgeDir('a', 0) === null);
  check('distance ends', E.sliderToDist(0) === E.DIST_MIN && E.sliderToDist(E.DIST_STEPS) === E.DIST_MAX);
  check('distance round trip (3.2 m)', Math.abs(E.sliderToDist(E.distToSlider(3.2)) - 3.2) < 0.02);
  const span = E.distToSlider(10) - E.distToSlider(1);
  check('1-10 m takes over half the travel (was 15% linear)', span / E.DIST_STEPS > 0.5, span / E.DIST_STEPS);
}

const at = process.argv.indexOf('--write');
if (at > 0) {
  const dir = path.resolve(process.argv[at + 1] || '');
  if (!process.argv[at + 1] || dir.startsWith(root + path.sep)) { console.error('--write needs a directory outside the repo'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'geometry.json'), edited.geometry);
  fs.writeFileSync(path.join(dir, 'rooms.json'), edited.rooms);
  console.log('  wrote the edited export to ' + dir);
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
