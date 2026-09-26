/**
 * dining.js - the kitchen dining set: a round table, its chairs, and a wall
 * clock (two styles). A multi-type module per the builder contract (see
 * docs/house-profile.md, "Multi-type modules").
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Each TYPES[key] exports DEFAULTS (frozen, cm, includes width/depth/
 *     height) and build(THREE, params, { detail: 'full' | 'low' }) -> Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0 and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 * See docs/house-profile.md, "Furniture".
 *
 * REFERENCE. Modelled from real kitchen photos of this house (a small round
 * space-saving set: a white gloss round top on a slim pedestal base, with
 * four low-back chairs whose tapered legs tuck fully under the rim) and,
 * separately, a DIY wall clock seen in the living room (numerals/dots stuck
 * straight on the wall around a plain hands unit, no visible face disc).
 * `wall-clock` therefore models BOTH the `framed` style (a conventional round
 * face + rim + hands) and the `diy-numerals` style the photo actually shows.
 *
 * REGISTRY NOTE. `clock` was already pre-seeded in registry.js pointing at
 * small-items.js (a module that does not exist on this branch). This module
 * does not repoint or touch that entry -- small-items.js is someone else's
 * territory. It registers a NEW type, `wall-clock`, instead. See the PR
 * description for why.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// dining-table - round top on a slim pedestal base.
// ---------------------------------------------------------------------------

const TABLE_DEFAULTS = Object.freeze({
  width: 100,     // diameter, cm (also used as `depth` -- see build())
  depth: 100,
  height: 75,
  topColor: '#f2f0eb',
  topFinish: 'gloss',
  baseColor: '#1c1c1c',
  baseFinish: 'matte'
});

/**
 * A round table only has one horizontal size, `diameter`, but the builder
 * contract's bbox check needs width AND depth to both equal it -- so both
 * DEFAULTS keys carry the same number and a caller only needs to override
 * one of them (or neither) to resize the whole thing evenly.
 */
function buildDiningTable(THREE, params, opts) {
  const p = Object.assign({}, TABLE_DEFAULTS, params || {});
  const diameter = Math.min(p.width, p.depth) / 100;
  const r = diameter / 2;
  const h = p.height / 100;
  const detail = opts && opts.detail === 'low';

  const topThickness = 0.04;
  const segments = detail ? 20 : 48;

  const group = new THREE.Group();
  group.name = 'furniture:dining-table';

  // Top: a short cylinder, its top face at y = h.
  const topGeo = new THREE.CylinderGeometry(r, r, topThickness, segments);
  topGeo.translate(0, h - topThickness / 2, r);
  const top = new THREE.Mesh(topGeo, makeFinish(THREE, p.topFinish, p.topColor));
  top.name = 'tabletop';
  if (isKeptFinish(top.material.userData.finish)) top.userData.keep = true;
  group.add(top);

  // Pedestal: a slim column rising from a wider round foot, centred under
  // the top. Two stacked cylinders read as a real pedestal base without
  // needing a lathed profile.
  const footR = r * 0.32;
  const footH = 0.03;
  const footGeo = new THREE.CylinderGeometry(footR, footR * 1.08, footH, segments);
  footGeo.translate(0, footH / 2, r);
  const foot = new THREE.Mesh(footGeo, makeFinish(THREE, p.baseFinish, p.baseColor));
  foot.name = 'pedestalFoot';
  group.add(foot);

  const colR = footR * 0.55;
  const colH = h - topThickness - footH;
  const colGeo = new THREE.CylinderGeometry(colR, colR * 1.15, colH, detail ? 10 : 20);
  colGeo.translate(0, footH + colH / 2, r);
  const column = new THREE.Mesh(colGeo, makeFinish(THREE, p.baseFinish, p.baseColor));
  column.name = 'pedestalColumn';
  group.add(column);

  return group;
}

// ---------------------------------------------------------------------------
// dining-chair - low-back chair, tapered A-frame legs, from the photo.
// ---------------------------------------------------------------------------

const CHAIR_DEFAULTS = Object.freeze({
  width: 45,
  depth: 50,
  height: 75,
  seatHeight: 45,
  seatColor: '#1a1a1a',
  seatFinish: 'matte',
  legColor: '#1a1a1a',
  legFinish: 'matte'
});

function buildDiningChair(THREE, params, opts) {
  const p = Object.assign({}, CHAIR_DEFAULTS, params || {});
  const w = p.width / 100, d = p.depth / 100, h = p.height / 100;
  const seatH = Math.min(p.seatHeight / 100, h - 0.02);
  const detail = opts && opts.detail === 'low';

  const group = new THREE.Group();
  group.name = 'furniture:dining-chair';

  // Leg radius at the floor -- legs are the widest thing at the very edges of
  // the footprint, so every other part (seat, back) is sized to stay INSIDE
  // half width/depth minus this, and leg endpoints are placed at exactly
  // half width/depth minus this. That is what pins the overall bbox to
  // width/depth/height exactly, independent of the splay trig below.
  const legBotR = Math.min(0.018, w * 0.03, d * 0.03);
  const halfW = w / 2 - legBotR;
  const frontZ = d - legBotR;
  const backZ = legBotR;

  // Seat: a padded-looking box, slightly rounded by chamfering is out of
  // scope for 'low' -- a plain box reads fine at furniture scale.
  const seatThickness = 0.10;
  const seatDepth = frontZ - backZ;
  const seatGeo = new THREE.BoxGeometry(halfW * 2, seatThickness, seatDepth);
  seatGeo.translate(0, seatH - seatThickness / 2, backZ + seatDepth / 2);
  const seat = new THREE.Mesh(seatGeo, makeFinish(THREE, p.seatFinish, p.seatColor));
  seat.name = 'seat';
  if (isKeptFinish(seat.material.userData.finish)) seat.userData.keep = true;
  group.add(seat);

  // Low back: a short padded panel rising from the seat's back edge, exactly
  // filling the remaining height up to h.
  const backHeight = Math.max(0.01, h - seatH);
  const backThickness = 0.06;
  const backGeo = new THREE.BoxGeometry(halfW * 2, backHeight, backThickness);
  backGeo.translate(0, seatH + backHeight / 2, backZ + backThickness / 2);
  const back = new THREE.Mesh(backGeo, makeFinish(THREE, p.seatFinish, p.seatColor));
  back.name = 'back';
  if (isKeptFinish(back.material.userData.finish)) back.userData.keep = true;
  group.add(back);

  // Four straight, gently tapered legs, one under each corner of the seat --
  // the "tucked fully under the rim" look from the photo, without a tilted
  // cylinder's elliptical-footprint overshoot putting any point outside the
  // declared width/depth/height envelope (a vertical cylinder's own footprint
  // is exactly its radius around its axis, in every direction, so insetting
  // the axis by legBotR keeps the WHOLE leg inside the bbox by construction).
  const legTopR = 0.012;
  const legSegments = detail ? 6 : 10;
  const legLen = seatH - seatThickness;
  const legGeo = new THREE.CylinderGeometry(legTopR, legBotR, legLen, legSegments);
  legGeo.translate(0, legLen / 2, 0);
  const corners = [
    { sx: -1, z: backZ },
    { sx: 1, z: backZ },
    { sx: -1, z: frontZ },
    { sx: 1, z: frontZ }
  ];
  corners.forEach((leg, i) => {
    const mesh = new THREE.Mesh(legGeo.clone(), makeFinish(THREE, p.legFinish, p.legColor));
    mesh.name = 'leg' + i;
    mesh.position.set(leg.sx * halfW, 0, leg.z);
    group.add(mesh);
  });

  return group;
}

// ---------------------------------------------------------------------------
// wall-clock - `framed` (round face + hands) or `diy-numerals` (numerals
// stuck on the wall around a central hands unit, no face disc).
// ---------------------------------------------------------------------------

const CLOCK_DEFAULTS = Object.freeze({
  width: 30,
  depth: 4,
  height: 30,
  kind: 'diy-numerals',    // 'framed' | 'diy-numerals' -- the photo is diy-numerals
  diameter: 30,
  faceColor: '#f5f2ea',
  rimColor: '#1a1a1a',
  numeralColor: '#1a1a1a',
  handColor: '#1a1a1a',
  time: '10:10'            // "HH:MM", the INITIAL hand pose only -- see setClockTime()
});

/**
 * "HH:MM" -> hour/minute/second hand angles, radians clockwise from 12
 * o'clock. Seconds are not encoded in "HH:MM" so they default to 0 -- this is
 * only ever used to lay out the STARTING pose at build time; a live scene
 * calls setClockTime() with a real Date immediately after and every tick
 * after that.
 */
function handAngles(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  const h = m ? (parseInt(m[1], 10) % 12) : 10;
  const min = m ? (parseInt(m[2], 10) % 60) : 10;
  const secondAngle = 0;
  const minuteAngle = (min / 60) * TAU;
  const hourAngle = ((h + min / 60) / 12) * TAU;
  return { hourAngle, minuteAngle, secondAngle };
}

/**
 * Hour/minute/second hand angles for a real Date, same convention as
 * handAngles(): radians clockwise from 12 o'clock. Pure -- reads only the
 * Date's local hour/minute/second/ms, never the DOM or a clock.
 */
export function angleForTime(date) {
  const h = date.getHours() % 12;
  const min = date.getMinutes();
  const sec = date.getSeconds() + date.getMilliseconds() / 1000;
  const secondAngle = (sec / 60) * TAU;
  const minuteAngle = ((min + sec / 60) / 60) * TAU;
  const hourAngle = ((h + min / 60) / 12) * TAU;
  return { hourAngle, minuteAngle, secondAngle };
}

/**
 * Rotate a built `wall-clock` group's hands to show `date` (a JS Date;
 * defaults to now). Pure with respect to everything except the three named
 * hand meshes' `.rotation.z` -- it does not touch geometry, materials or any
 * other part of the group, so it is cheap enough to call every animation
 * frame, and safe to call on a group built at any `time` default.
 *
 * THE LIVE SCENE calls this once a MINUTE (the minute hand is the coarsest
 * visible movement that matters at furniture scale, and re-laying every
 * frame for a wall clock nobody is standing next to is wasted work); the
 * spec page below calls it every SECOND so the second hand is visibly live
 * while tweaking. Both are valid callers -- this helper itself has no
 * opinion on cadence.
 *
 * @param {Object} group  a THREE.Group returned by wall-clock's build()
 * @param {Date} [date]   defaults to `new Date()`
 */
export function setClockTime(group, date) {
  const d = date || new Date();
  const { hourAngle, minuteAngle, secondAngle } = angleForTime(d);
  const hour = group.getObjectByName('hourHand');
  const minute = group.getObjectByName('minuteHand');
  const second = group.getObjectByName('secondHand');
  if (hour) hour.rotation.z = -hourAngle;
  if (minute) minute.rotation.z = -minuteAngle;
  if (second) second.rotation.z = -secondAngle;
}

/**
 * @param {number} totalDepth  the item's own declared depth (metres) -- the
 *   hub, the deepest part, is placed with its FRONT face exactly at
 *   totalDepth, so the whole assembly's z-extent matches params.depth exactly
 *   (the builder contract's bbox check) regardless of kind.
 * @param {number} backZ  where the hands' own back face should land (metres,
 *   in the caller's frame) -- callers pass whatever z their own geometry
 *   already treats as "flush with the wall/face".
 */
function addHands(THREE, group, radius, handColor, time, detail, backZ, totalDepth) { // eslint-disable-line no-unused-vars
  const { hourAngle, minuteAngle, secondAngle } = handAngles(time);
  const handThickness = Math.max(0.003, Math.min(0.008, (totalDepth - backZ) * 0.3));
  const z = backZ + handThickness / 2;
  const mat = makeFinish(THREE, 'matte', handColor);

  const hourLen = radius * 0.5, minuteLen = radius * 0.72, secondLen = radius * 0.78;
  const handW = radius * 0.06, secondW = radius * 0.02;

  function hand(name, length, width, angle, matInstance) {
    const geo = new THREE.BoxGeometry(width, length, handThickness);
    // Pivot at one end: shift geometry so y=0 is the pivot, tip at +y.
    geo.translate(0, length / 2, 0);
    const mesh = new THREE.Mesh(geo, matInstance);
    mesh.name = name;
    mesh.position.set(0, 0, z);
    // Clockwise from 12 o'clock (+y) -> rotate about z by -angle.
    mesh.rotation.z = -angle;
    // Hands move every frame/minute in the live scene: keep them their own
    // draw rather than folding into the merged static-furniture bucket, the
    // same way any moving or emissive part is kept (see finishes.js).
    mesh.userData.keep = true;
    return mesh;
  }
  group.add(hand('hourHand', hourLen, handW, hourAngle, mat));
  group.add(hand('minuteHand', minuteLen, handW * 0.7, minuteAngle, mat.clone()));
  group.add(hand('secondHand', secondLen, secondW, secondAngle, mat.clone()));

  // The hub is the deepest part: its FRONT face lands exactly at totalDepth
  // so the group's overall z-extent equals params.depth precisely.
  const hubThickness = Math.max(0.004, totalDepth - backZ);
  const hubGeo = new THREE.CylinderGeometry(radius * 0.05, radius * 0.05, hubThickness, detail ? 8 : 16);
  hubGeo.rotateX(Math.PI / 2);
  hubGeo.translate(0, 0, totalDepth - hubThickness / 2);
  const hub = new THREE.Mesh(hubGeo, mat.clone());
  hub.name = 'hub';
  hub.userData.keep = true;
  group.add(hub);
}

function buildFramedClock(THREE, p, detail, totalDepth) {
  const group = new THREE.Group();
  group.name = 'furniture:wall-clock:framed';
  const r = (p.diameter / 100) / 2;
  const segments = detail ? 20 : 40;
  // The rim + face take up most of the declared depth; hands and the hub
  // (the deepest part) fit in what is left, driven by totalDepth below.
  const faceThickness = Math.max(0.006, totalDepth * 0.5);

  const rimGeo = new THREE.CylinderGeometry(r, r, faceThickness, segments);
  rimGeo.rotateX(Math.PI / 2);
  rimGeo.translate(0, 0, faceThickness / 2); // back face at local z = 0
  const rim = new THREE.Mesh(rimGeo, makeFinish(THREE, 'matte', p.rimColor));
  rim.name = 'rim';
  group.add(rim);

  const faceR = r * 0.92;
  const faceThin = 0.005;
  const faceGeo = new THREE.CylinderGeometry(faceR, faceR, faceThin, segments);
  faceGeo.rotateX(Math.PI / 2);
  faceGeo.translate(0, 0, faceThickness + faceThin / 2);
  const face = new THREE.Mesh(faceGeo, makeFinish(THREE, 'matte', p.faceColor));
  face.name = 'face';
  group.add(face);

  // Twelve tick marks around the face.
  const tickCount = 12;
  for (let i = 0; i < tickCount; i++) {
    const a = (i / tickCount) * TAU;
    const isQuarter = i % 3 === 0;
    const tickLen = faceR * (isQuarter ? 0.14 : 0.08);
    const tickGeo = new THREE.BoxGeometry(faceR * 0.025, tickLen, 0.004);
    tickGeo.translate(0, faceR * 0.88 - tickLen / 2, 0);
    const tick = new THREE.Mesh(tickGeo, makeFinish(THREE, 'matte', p.numeralColor));
    tick.name = 'tick' + i;
    tick.position.z = faceThickness + faceThin;
    tick.rotation.z = -a;
    group.add(tick);
  }

  // Hands sit just in front of the face, which is itself in front of the
  // rim -- the rim's own back face is already at z = 0 (see rimGeo above).
  addHands(THREE, group, faceR, p.handColor, p.time, detail, faceThickness + faceThin, totalDepth);
  return group;
}

function buildDiyNumeralsClock(THREE, p, detail, totalDepth) {
  const group = new THREE.Group();
  group.name = 'furniture:wall-clock:diy-numerals';
  const r = (p.diameter / 100) / 2;
  const markThickness = Math.max(0.003, totalDepth * 0.3); // stuck straight on the wall

  // Numerals/dots stuck straight on the wall: at 12/3/6/9 a flat numeral
  // plaque (a small box standing in for the printed digit), and a plain dot
  // at the other eight hours -- matching the reference photo, where only a
  // few positions carry a printed number ("12", "9", "6" are the ones the
  // photo shows) and the rest are unmarked dots.
  //
  // The ring radius is shrunk by the numeral's own half-extent so the
  // FARTHEST point of the farthest numeral lands exactly on the declared
  // diameter, never past it -- otherwise a fixed 0.88*r ring radius plus the
  // numeral's box half-width overshoots the bbox the contract test measures.
  // The plaque is kept SQUARE (equal half-width/half-height) specifically so
  // one inset works whichever axis a numeral sits on (12/6 are on the y axis,
  // 3/9 on the x axis) -- an oblong plaque would need a per-position inset.
  const numeralHalf = r * 0.09;
  const numeralHalfW = numeralHalf, numeralHalfH = numeralHalf;
  const ringR = r - numeralHalf;
  const numeralPositions = [0, 3, 6, 9];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const x = ringR * Math.sin(a);
    const y = ringR * Math.cos(a);
    let mark;
    if (numeralPositions.includes(i)) {
      const geo = new THREE.BoxGeometry(numeralHalfW * 2, numeralHalfH * 2, markThickness);
      geo.translate(0, 0, markThickness / 2); // back face at local z = 0
      mark = new THREE.Mesh(geo, makeFinish(THREE, 'matte', p.numeralColor));
      mark.name = 'numeral' + i;
    } else {
      const geo = new THREE.CylinderGeometry(r * 0.035, r * 0.035, markThickness, detail ? 6 : 10);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, 0, markThickness / 2); // back face at local z = 0
      mark = new THREE.Mesh(geo, makeFinish(THREE, 'matte', p.numeralColor));
      mark.name = 'dot' + i;
    }
    mark.position.set(x, y, 0);
    group.add(mark);
  }

  // Hands + hub mount flush on the wall too -- their own back face at z = 0.
  addHands(THREE, group, r, p.handColor, p.time, detail, 0, totalDepth);
  return group;
}

function buildWallClock(THREE, params, opts) {
  const p = Object.assign({}, CLOCK_DEFAULTS, params || {});
  const detail = opts && opts.detail === 'low';
  const totalDepth = p.depth / 100;
  const group = p.kind === 'diy-numerals'
    ? buildDiyNumeralsClock(THREE, p, detail, totalDepth)
    : buildFramedClock(THREE, p, detail, totalDepth);
  group.name = 'furniture:wall-clock';
  // Both builders draw centred on x = 0, back already at z = 0 and every part
  // within [0, totalDepth] (see addHands' hub placement). Lift only in y so
  // the bottom of the whole assembly sits at the contract's y = 0.
  const h = p.height / 100;
  const wrapper = new THREE.Group();
  wrapper.name = 'furniture:wall-clock';
  group.position.y += h / 2;
  wrapper.add(group);
  return wrapper;
}

export const TYPES = {
  'dining-table': { DEFAULTS: TABLE_DEFAULTS, build: buildDiningTable },
  'dining-chair': { DEFAULTS: CHAIR_DEFAULTS, build: buildDiningChair },
  'wall-clock': { DEFAULTS: CLOCK_DEFAULTS, build: buildWallClock }
};
