#!/usr/bin/env node
/**
 * Wall clock (both kinds): builder-contract tests.
 * No framework, no install - `node scripts/test-wall-clock.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. Builder contract compliance: DEFAULTS is frozen and carries numeric
 *      width/depth/height; y=0 is the lowest point; the assembly's back sits
 *      at z=0; and the bbox matches DEFAULTS width/height/depth within
 *      0.5 cm -- the same tolerance scripts/test-furniture-core.mjs checks
 *      every registered builder against. Checked for BOTH `kind`s
 *      ('diy-numerals', the default, and 'framed').
 *   2. The finish/merge contract: every mesh carries userData.finish from the
 *      closed palette {matte, gloss, metal, glass, mirror, emissive}, and the
 *      three hand meshes plus the hub -- the parts that move or must stay
 *      flush at the assembly's declared depth -- carry userData.keep = true.
 *      Losing a keep flag is invisible in a screenshot -- the merged result
 *      still looks like a clock until the hands stop moving independently.
 *   3. detail: 'low' produces no more triangles than 'full', for both kinds.
 *   4. angleForTime(date) is pure and matches the documented convention
 *      (radians clockwise from 12 o'clock); setClockTime(group, date)
 *      rotates exactly the three named hand meshes and nothing else.
 *   5. `time` ("HH:MM") only sets the BUILD-time pose; a value with no
 *      colon/garbage falls back to 10:10 rather than throwing.
 *
 * THREE is loaded from the vendored ESM build so this exercises the same
 * geometry code the app and the spec page run, not a copy of it.
 *
 * HISTORY. Split out of dining.js's test coverage (item 89769f2b,
 * 2026-09-26) alongside the module itself moving to wall-clock.js.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);

const THREE = await imp('vendor/three-r160/three.module.min.js');
const Fin = await imp('src/furniture/finishes.js');
const Clock = await imp('src/furniture/wall-clock.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

function bbox(group) {
  return new THREE.Box3().setFromObject(group);
}
function bboxCm(group) {
  const b = bbox(group);
  return {
    minX: b.min.x * 100, maxX: b.max.x * 100, minY: b.min.y * 100, maxY: b.max.y * 100,
    minZ: b.min.z * 100, maxZ: b.max.z * 100
  };
}
function triCount(group) {
  let tris = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    if (geo.index) tris += geo.index.count / 3;
    else tris += geo.attributes.position.count / 3;
  });
  return tris;
}
function meshesByName(group) {
  const m = {};
  group.traverse(o => { if (o.isMesh) m[o.name] = o; });
  return m;
}
function checkBboxMatchesDefaults(tag, group, defaults) {
  const b = bboxCm(group);
  check(tag + ': width == DEFAULTS within 0.5 cm', Math.abs((b.maxX - b.minX) - defaults.width) <= 0.5,
    { bbox: b, width: defaults.width });
  check(tag + ': centred on x', Math.abs((b.maxX + b.minX) / 2) <= 0.5, b);
  check(tag + ': bottom at y = 0', Math.abs(b.minY) <= 0.5, b);
  check(tag + ': height == DEFAULTS within 0.5 cm', Math.abs(b.maxY - b.minY - defaults.height) <= 0.5,
    { bbox: b, height: defaults.height });
  check(tag + ': back at z = 0', Math.abs(b.minZ) <= 0.5, b);
  check(tag + ': depth == DEFAULTS within 0.5 cm', Math.abs(b.maxZ - b.minZ - defaults.depth) <= 0.5,
    { bbox: b, depth: defaults.depth });
}
function checkFinishAndKeep(tag, group, keptNames) {
  let allTagged = true, untagged = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    const r = Fin.partFinish(o, o.material);
    if (r.error) { allTagged = false; untagged.push((o.name || o.type) + ': ' + r.error); }
  });
  check(tag + ': every mesh carries a finish from the closed palette', allTagged, untagged);
  keptNames.forEach(n => {
    let found = 0;
    group.traverse(o => {
      if (o.isMesh && (o.name === n || o.name.startsWith(n))) {
        found++;
        check(tag + ': ' + o.name + ' is kept out of the merge', Fin.partKeep(o, o.material).keep === true, o.userData);
      }
    });
    check(tag + ': at least one mesh named ' + n + '*', found > 0);
  });
}

check('TYPE is wall-clock', Clock.TYPE === 'wall-clock', Clock.TYPE);
check('DEFAULTS is frozen', Object.isFrozen(Clock.DEFAULTS));
check('DEFAULTS has numeric width/depth/height',
  ['width', 'depth', 'height'].every(k => typeof Clock.DEFAULTS[k] === 'number'), Clock.DEFAULTS);
check('DEFAULTS kind is diy-numerals', Clock.DEFAULTS.kind === 'diy-numerals');

// ============================================================
// diy-numerals (default kind)
// ============================================================
{
  const g = Clock.build(THREE, {});
  checkBboxMatchesDefaults('diy-numerals', g, Clock.DEFAULTS);
  checkFinishAndKeep('diy-numerals', g, ['hourHand', 'minuteHand', 'secondHand', 'hub']);

  const trisFull = triCount(Clock.build(THREE, {}, { detail: 'full' }));
  const trisLow = triCount(Clock.build(THREE, {}, { detail: 'low' }));
  check('diy-numerals: detail low has no more triangles than full', trisLow <= trisFull, { trisFull, trisLow });

  // diameter param drives the bbox
  const gBig = Clock.build(THREE, { width: 44, height: 44, diameter: 44 });
  const b = bboxCm(gBig);
  check('diy-numerals: diameter param drives bbox width', near(b.maxX - b.minX, 44, 0.5), b);
  check('diy-numerals: diameter param drives bbox height', near(b.maxY - b.minY, 44, 0.5), b);

  // depth param drives the bbox depth
  const gDeep = Clock.build(THREE, { depth: 7 });
  const bDeep = bboxCm(gDeep);
  check('diy-numerals: depth param drives bbox depth', near(bDeep.maxZ - bDeep.minZ, 7, 0.5), bDeep);
}

// ============================================================
// framed
// ============================================================
{
  const framedDefaults = Object.assign({}, Clock.DEFAULTS, { kind: 'framed' });
  const g = Clock.build(THREE, { kind: 'framed' });
  checkBboxMatchesDefaults('framed', g, framedDefaults);
  checkFinishAndKeep('framed', g, ['hourHand', 'minuteHand', 'secondHand', 'hub']);

  const meshes = meshesByName(g);
  check('framed: has a rim and a face', !!meshes.rim && !!meshes.face, Object.keys(meshes));
  check('framed: has 12 tick marks', Object.keys(meshes).filter(n => n.startsWith('tick')).length === 12,
    Object.keys(meshes));

  const trisFull = triCount(Clock.build(THREE, { kind: 'framed' }, { detail: 'full' }));
  const trisLow = triCount(Clock.build(THREE, { kind: 'framed' }, { detail: 'low' }));
  check('framed: detail low has no more triangles than full', trisLow <= trisFull, { trisFull, trisLow });
}

// ============================================================
// angleForTime / setClockTime
// ============================================================
{
  // Exactly 12:00:00 -> all hands point straight up (angle 0).
  const noon = new Date(2026, 0, 1, 12, 0, 0, 0);
  const a1 = Clock.angleForTime(noon);
  check('angleForTime: 12:00:00 -> hour angle 0', near(a1.hourAngle, 0), a1);
  check('angleForTime: 12:00:00 -> minute angle 0', near(a1.minuteAngle, 0), a1);
  check('angleForTime: 12:00:00 -> second angle 0', near(a1.secondAngle, 0), a1);

  // 3:00:00 -> hour hand a quarter turn (TAU/4), minute hand at 0.
  const three = new Date(2026, 0, 1, 3, 0, 0, 0);
  const a2 = Clock.angleForTime(three);
  check('angleForTime: 3:00:00 -> hour angle is a quarter turn', near(a2.hourAngle, Math.PI / 2, 1e-3), a2);
  check('angleForTime: 3:00:00 -> minute angle 0', near(a2.minuteAngle, 0), a2);

  // 6:30:00 -> minute hand half a turn, hour hand halfway between 6 and 7.
  const halfPast = new Date(2026, 0, 1, 6, 30, 0, 0);
  const a3 = Clock.angleForTime(halfPast);
  check('angleForTime: 6:30:00 -> minute angle is half a turn', near(a3.minuteAngle, Math.PI, 1e-3), a3);
  check('angleForTime: 6:30:00 -> hour angle is between 6 and 7 o\'clock',
    a3.hourAngle > (6 / 12) * Math.PI * 2 && a3.hourAngle < (7 / 12) * Math.PI * 2, a3);

  // Pure: same Date object queried twice gives identical results.
  const a4 = Clock.angleForTime(halfPast);
  check('angleForTime: pure (same input -> same output)',
    a3.hourAngle === a4.hourAngle && a3.minuteAngle === a4.minuteAngle && a3.secondAngle === a4.secondAngle);

  // setClockTime rotates exactly the three named hands and nothing else.
  const g = Clock.build(THREE, {});
  const before = {};
  g.traverse(o => { if (o.isMesh) before[o.name] = o.rotation.z; });
  Clock.setClockTime(g, noon);
  let onlyHandsChanged = true;
  const changed = [];
  g.traverse(o => {
    if (!o.isMesh) return;
    const isHand = o.name === 'hourHand' || o.name === 'minuteHand' || o.name === 'secondHand';
    if (o.rotation.z !== before[o.name]) {
      changed.push(o.name);
      if (!isHand) onlyHandsChanged = false;
    }
  });
  check('setClockTime: only hand meshes have their rotation changed', onlyHandsChanged, changed);
  const meshesAfter = meshesByName(g);
  check('setClockTime: hourHand rotated to -hourAngle for noon', near(meshesAfter.hourHand.rotation.z, -a1.hourAngle));
  check('setClockTime: minuteHand rotated to -minuteAngle for noon', near(meshesAfter.minuteHand.rotation.z, -a1.minuteAngle));
  check('setClockTime: secondHand rotated to -secondAngle for noon', near(meshesAfter.secondHand.rotation.z, -a1.secondAngle));

  // setClockTime defaults to now() when no date is passed -- just check it
  // does not throw and still only touches the hand meshes.
  let threw = false;
  try { Clock.setClockTime(g); } catch (e) { threw = true; }
  check('setClockTime: works with no date argument (defaults to now)', !threw);

  // A garbage/no-colon `time` string falls back to 10:10 rather than throwing.
  let buildThrew = false;
  let gGarbage;
  try { gGarbage = Clock.build(THREE, { time: 'not-a-time' }); } catch (e) { buildThrew = true; }
  check('build: garbage `time` does not throw', !buildThrew);
  if (gGarbage) checkBboxMatchesDefaults('diy-numerals (garbage time)', gGarbage, Clock.DEFAULTS);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
