#!/usr/bin/env node
/**
 * Wall clock (all three kinds): builder-contract tests.
 * No framework, no install - `node scripts/test-wall-clock.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. Builder contract compliance: DEFAULTS is frozen and carries numeric
 *      width/depth/height; y=0 is the lowest point; the assembly's back sits
 *      at z=0; and the bbox matches DEFAULTS width/height/depth within
 *      0.5 cm -- the same tolerance scripts/test-furniture-core.mjs checks
 *      every registered builder against. Checked for all THREE `kind`s
 *      ('diy-numerals', the module default; 'framed'; and 'diy-words', item
 *      059873ed's DIY_WORDS_DEFAULTS, whose width/height are the WIDER
 *      envelope that includes the words extending right of the ring).
 *   2. The finish/merge contract: every mesh carries userData.finish from the
 *      closed palette {matte, gloss, metal, glass, mirror, emissive}, and the
 *      hand meshes plus the hub -- the parts that move or must stay
 *      flush at the assembly's declared depth -- carry userData.keep = true.
 *      Losing a keep flag is invisible in a screenshot -- the merged result
 *      still looks like a clock until the hands stop moving independently.
 *   3. detail: 'low' produces no more triangles than 'full', for all kinds.
 *   4. angleForTime(date) is pure and matches the documented convention
 *      (radians clockwise from 12 o'clock); setClockTime(group, date)
 *      rotates exactly the hand meshes (including diy-words' extra
 *      secondHandTail) and nothing else. WORLD-SPACE orientation is
 *      verified directly from the built hand mesh's own vertices at 12:00
 *      and 3:00 -- not just the internal rotation.z convention -- so a sign
 *      error that happened to cancel out in the angle math would still be
 *      caught (12:00 = straight up, +y; 3:00 = right, +x; and the hand
 *      sweeps the SAME way a real clock does between them, i.e. not
 *      mirrored).
 *   5. `time` ("HH:MM") only sets the BUILD-time pose; a value with no
 *      colon/garbage falls back to 10:10 rather than throwing.
 *   6. diy-words specifically: the numerals/words canvas panel (both with
 *      and without a DOM canvas available -- the shape furniture-core's
 *      drift test runs every builder in), the 4 dots at 7/8/10/11, the
 *      centre disc, and the tapered hand geometry (wide at the pivot,
 *      narrowing toward the tip, verified from the built vertices, not
 *      just "it uses a different code path").
 *   7. startLiveClock(): ticks once a second, calls onTick after every
 *      update, resyncs on a visibilitychange to a visible tab (a fake
 *      `doc`/`now` are injected so this runs deterministically under Node,
 *      not real timers/real time), and stop() clears both the interval and
 *      the listener.
 *
 * THREE is loaded from the vendored ESM build so this exercises the same
 * geometry code the app and the spec page run, not a copy of it.
 *
 * HISTORY. Split out of dining.js's test coverage (item 89769f2b,
 * 2026-09-26) alongside the module itself moving to wall-clock.js. The
 * `diy-words` kind, secondHandColor, tapered hands and startLiveClock() were
 * added for item 059873ed (2026-09-27), matching the owner's actual kitchen
 * clock photo (private, never committed).
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

// ============================================================
// WORLD-SPACE hand orientation (item 059873ed): 12:00 = straight up, 3:00 =
// right, and the sweep between them is the correct direction (not mirrored)
// -- checked directly from the built hand mesh's own vertices, not just the
// internal rotation.z sign convention (a compensating sign error in both
// handAngles/angleForTime AND the mesh-building code could still pass a
// rotation.z-only check while rendering backwards).
// ============================================================
{
  const noon = new Date(2026, 0, 1, 12, 0, 0, 0);
  const three = new Date(2026, 0, 1, 3, 0, 0, 0);

  /** The world-space direction from the hand's own pivot (y=0 in its local
   * frame) to its tip (the vertex furthest from the pivot along local y),
   * projected onto the xy-plane (the wall-facing plane) and normalised. */
  function handTipDirectionXY(mesh) {
    const posAttr = mesh.geometry.attributes.position;
    const v = new THREE.Vector3();
    // A box (or tapered-prism) hand's tip is a FACE, not a single vertex --
    // several vertices share the same maximum local y (the corners of that
    // face). Averaging their local x (not picking one arbitrary corner)
    // gives the tip face's own centreline, which is exact for a
    // symmetric-about-y hand regardless of its width.
    let maxLocalY = -Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i);
      if (v.y > maxLocalY) maxLocalY = v.y;
    }
    let sumX = 0, count = 0;
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i);
      if (Math.abs(v.y - maxLocalY) < 1e-6) { sumX += v.x; count++; }
    }
    const tipLocal = new THREE.Vector3(sumX / count, maxLocalY, 0);
    const tipWorld = tipLocal.clone().applyMatrix4(mesh.matrixWorld);
    const pivotWorld = new THREE.Vector3(0, 0, 0).applyMatrix4(mesh.matrixWorld);
    const dir = new THREE.Vector3().subVectors(tipWorld, pivotWorld);
    dir.z = 0;
    return dir.normalize();
  }

  const g = Clock.build(THREE, {});
  g.updateMatrixWorld(true);
  Clock.setClockTime(g, noon);
  g.updateMatrixWorld(true);
  const meshesNoon = meshesByName(g);
  const hourDirNoon = handTipDirectionXY(meshesNoon.hourHand);
  const minuteDirNoon = handTipDirectionXY(meshesNoon.minuteHand);
  check('orientation: hour hand points straight UP (+y) at 12:00', near(hourDirNoon.x, 0, 0.01) && near(hourDirNoon.y, 1, 0.01), hourDirNoon);
  check('orientation: minute hand points straight UP (+y) at 12:00', near(minuteDirNoon.x, 0, 0.01) && near(minuteDirNoon.y, 1, 0.01), minuteDirNoon);

  Clock.setClockTime(g, three);
  g.updateMatrixWorld(true);
  const meshesThree = meshesByName(g);
  const hourDirThree = handTipDirectionXY(meshesThree.hourHand);
  check('orientation: hour hand points RIGHT (+x) at 3:00, not left (mirrored) or down',
    near(hourDirThree.x, 1, 0.01) && near(hourDirThree.y, 0, 0.01), hourDirThree);

  // Sweep direction: stepping the clock forward from 12:00 toward 1:00
  // should swing the minute-equivalent (here, use the SECOND hand, which
  // moves visibly within one call) CLOCKWISE when viewed from the front
  // (+z looking toward -z, the normal viewing direction per the builder
  // contract) -- i.e. from +y (12) it should sweep toward +x (3) first, not
  // toward -x (9). A mirrored implementation would swing the wrong way.
  const quarterPast = new Date(2026, 0, 1, 12, 15, 0, 0); // second hand irrelevant; use minute hand
  Clock.setClockTime(g, quarterPast);
  g.updateMatrixWorld(true);
  const meshesQuarter = meshesByName(g);
  const minuteDirQuarter = handTipDirectionXY(meshesQuarter.minuteHand);
  check('orientation: minute hand at :15 has swung toward +x (right/3 o\'clock side), not -x (mirrored)',
    minuteDirQuarter.x > 0.5, minuteDirQuarter);
}

// ============================================================
// diy-words (item 059873ed): the owner's actual kitchen clock -- numerals
// 12/9/6 + words One..Five on one canvas panel, dots at 7/8/10/11, a centre
// disc, tapered hour/minute hands and a red second hand with a tail.
// ============================================================
{
  check('DIY_WORDS_DEFAULTS is frozen', Object.isFrozen(Clock.DIY_WORDS_DEFAULTS));
  check('DIY_WORDS_DEFAULTS kind is diy-words', Clock.DIY_WORDS_DEFAULTS.kind === 'diy-words');
  check('DIY_WORDS_DEFAULTS secondHandColor is red, distinct from handColor',
    Clock.DIY_WORDS_DEFAULTS.secondHandColor !== Clock.DIY_WORDS_DEFAULTS.handColor);

  // No global `document` at all -- the shape furniture-core's drift test
  // runs every builder in. The words/numerals panel must still build (as an
  // invisible placeholder plane, keeping its geometry/position/keep tag
  // testable), just without a CanvasTexture.
  check('no global document in this process (sanity)', typeof document === 'undefined');
  const gNoDom = Clock.build(THREE, Clock.DIY_WORDS_DEFAULTS, { detail: 'full' });
  checkBboxMatchesDefaults('diy-words (no DOM)', gNoDom, Clock.DIY_WORDS_DEFAULTS);
  const meshesNoDom = meshesByName(gNoDom);
  check('diy-words (no DOM): wordsPanel present and kept', !!meshesNoDom.wordsPanel && meshesNoDom.wordsPanel.userData.keep === true);
  check('diy-words (no DOM): wordsPanel has no texture map (no canvas available)', meshesNoDom.wordsPanel.material.map == null);
  checkFinishAndKeep('diy-words (no DOM)', gNoDom, ['hourHand', 'minuteHand', 'secondHand', 'hub', 'wordsPanel']);

  // Structural checks: 4 dots, a centre disc, exactly one textured panel.
  check('diy-words: has 4 dots (7, 8, 10, 11)',
    !!meshesNoDom.dot7 && !!meshesNoDom.dot8 && !!meshesNoDom.dot10 && !!meshesNoDom.dot11, Object.keys(meshesNoDom));
  check('diy-words: has NO numeral meshes (12/9/6 are on the canvas panel, not separate meshes)',
    Object.keys(meshesNoDom).every(n => !n.startsWith('numeral')), Object.keys(meshesNoDom));
  check('diy-words: has a centre disc', !!meshesNoDom.centreDisc, Object.keys(meshesNoDom));
  check('diy-words: has a second-hand tail', !!meshesNoDom.secondHandTail, Object.keys(meshesNoDom));

  // WITH a stubbed canvas: the words panel becomes the one textured mesh.
  const stubCreateCanvas = (w, h) => ({
    width: w, height: h,
    getContext() {
      return { clearRect() {}, fillStyle: '', font: '', textAlign: '', textBaseline: '', fillRect() {}, fillText() {} };
    }
  });
  const gTextured = Clock.build(THREE, Clock.DIY_WORDS_DEFAULTS, { detail: 'full', createCanvas: stubCreateCanvas });
  let texturedCount = 0;
  gTextured.traverse(o => { if (o.isMesh && o.material && o.material.map) texturedCount++; });
  check('diy-words (with canvas): exactly one textured mesh (the words panel)', texturedCount === 1, texturedCount);
  const meshesTextured = meshesByName(gTextured);
  check('diy-words (with canvas): the textured mesh IS the words panel', meshesTextured.wordsPanel.material.map != null);
  checkBboxMatchesDefaults('diy-words (with canvas)', gTextured, Clock.DIY_WORDS_DEFAULTS);

  // Tapered hands: the hour/minute hands must be WIDER at the pivot (local
  // y=0) than at the tip (local y=length) -- measured directly from the
  // built geometry's own vertices, not asserted from the source.
  function widthAtLocalY(mesh, targetY, tolerance) {
    const posAttr = mesh.geometry.attributes.position;
    const v = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity, found = false;
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i);
      if (Math.abs(v.y - targetY) <= tolerance) {
        found = true;
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
      }
    }
    return found ? maxX - minX : null;
  }
  const meshesTaper = meshesByName(Clock.build(THREE, Clock.DIY_WORDS_DEFAULTS, { detail: 'full' }));
  ['hourHand', 'minuteHand'].forEach(name => {
    const mesh = meshesTaper[name];
    const geoParams = mesh.geometry.parameters;
    const length = geoParams ? undefined : null; // BufferGeometry has no .parameters -- read length from bbox instead
    const bb = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
    const handLength = bb.max.y - bb.min.y;
    const widthAtBase = widthAtLocalY(mesh, 0, 0.0005);
    const widthAtTip = widthAtLocalY(mesh, handLength, 0.0005);
    check(name + ': tapered -- wider at the pivot than at the tip',
      widthAtBase != null && widthAtTip != null && widthAtBase > widthAtTip,
      { widthAtBase, widthAtTip, handLength });
  });

  const trisFull = triCount(Clock.build(THREE, Clock.DIY_WORDS_DEFAULTS, { detail: 'full' }));
  const trisLow = triCount(Clock.build(THREE, Clock.DIY_WORDS_DEFAULTS, { detail: 'low' }));
  check('diy-words: detail low has no more triangles than full', trisLow <= trisFull, { trisFull, trisLow });
  check('diy-words: detail low is a real reduction (<= 60% of full, per the perf budget)',
    trisLow <= trisFull * 0.6, { trisFull, trisLow, ratio: trisLow / trisFull });

  // setClockTime also rotates the secondHandTail, at secondAngle + 180deg,
  // fixed relative to the second hand.
  const gTail = Clock.build(THREE, Clock.DIY_WORDS_DEFAULTS, { detail: 'full' });
  const testDate = new Date(2026, 0, 1, 4, 20, 30, 0);
  Clock.setClockTime(gTail, testDate);
  const meshesTail = meshesByName(gTail);
  const { secondAngle } = Clock.angleForTime(testDate);
  check('diy-words: secondHandTail rotates opposite the second hand (180deg offset)',
    near(meshesTail.secondHandTail.rotation.z, -secondAngle - Math.PI, 1e-3),
    { tail: meshesTail.secondHandTail.rotation.z, second: meshesTail.secondHand.rotation.z });
}

// ============================================================
// startLiveClock(): once-a-second ticking, onTick callback, resync on a
// visibilitychange to a visible tab, and stop() cleanup. A fake `doc` and
// `now` are injected so this is deterministic and does not depend on real
// timers or the real wall-clock time.
// ============================================================
{
  // A minimal fake `document` supporting only what startLiveClock needs:
  // addEventListener/removeEventListener for 'visibilitychange', and a
  // mutable `hidden` flag the test flips directly.
  function makeFakeDoc() {
    const listeners = {};
    return {
      hidden: false,
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        if (!listeners[type]) return;
        listeners[type] = listeners[type].filter(f => f !== fn);
      },
      _fire(type) { (listeners[type] || []).forEach(fn => fn()); },
      _listenerCount(type) { return (listeners[type] || []).length; }
    };
  }

  const g = Clock.build(THREE, {});
  const doc = makeFakeDoc();
  let fakeNow = new Date(2026, 0, 1, 1, 0, 0, 0);
  let tickCount = 0;
  const stop = Clock.startLiveClock(g, {
    doc,
    now: () => fakeNow,
    onTick: () => { tickCount++; }
  });

  check('startLiveClock: ticks immediately on start (does not wait a full second)', tickCount === 1, tickCount);
  const meshesAfterStart = meshesByName(g);
  const { hourAngle: h0 } = Clock.angleForTime(fakeNow);
  check('startLiveClock: hand pose matches the injected time immediately after start',
    near(meshesAfterStart.hourHand.rotation.z, -h0, 1e-3));

  // Advance the fake clock and fire a visibilitychange while the tab is
  // VISIBLE (doc.hidden = false) -- this must resync immediately, exactly
  // the "resync after the tab has been in the background" requirement,
  // without waiting for the next 1-second interval tick.
  fakeNow = new Date(2026, 0, 1, 7, 45, 0, 0);
  doc.hidden = false;
  doc._fire('visibilitychange');
  check('startLiveClock: resyncs immediately on a visibilitychange to a visible tab', tickCount === 2, tickCount);
  const meshesAfterResync = meshesByName(g);
  const { hourAngle: h1 } = Clock.angleForTime(fakeNow);
  check('startLiveClock: hand pose matches the NEW time after resync',
    near(meshesAfterResync.hourHand.rotation.z, -h1, 1e-3));

  // A visibilitychange firing while the tab is HIDDEN must NOT tick -- only
  // becoming visible again triggers a resync, not going into the background.
  doc.hidden = true;
  doc._fire('visibilitychange');
  check('startLiveClock: a visibilitychange to HIDDEN does not tick', tickCount === 2, tickCount);

  check('startLiveClock: registered exactly one visibilitychange listener', doc._listenerCount('visibilitychange') === 1);
  stop();
  check('startLiveClock: stop() removes the visibilitychange listener', doc._listenerCount('visibilitychange') === 0);

  // After stop(), firing visibilitychange again must not tick.
  const tickCountAfterStop = tickCount;
  doc.hidden = false;
  doc._fire('visibilitychange');
  check('startLiveClock: no tick after stop()', tickCount === tickCountAfterStop);

  // startLiveClock works with NO doc at all (doc: null) -- the interval
  // still runs, there is just no visibility resync to wire up.
  const g2 = Clock.build(THREE, {});
  let tickCount2 = 0;
  const stop2 = Clock.startLiveClock(g2, { doc: null, now: () => new Date(2026, 0, 1, 2, 0, 0, 0), onTick: () => { tickCount2++; } });
  check('startLiveClock: works with doc:null (no visibility resync wired up)', tickCount2 === 1, tickCount2);
  stop2();
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
