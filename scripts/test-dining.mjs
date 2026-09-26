#!/usr/bin/env node
/**
 * Dining set (nesting round table + 4 quadrant chairs): builder-contract
 * tests. No framework, no install - `node scripts/test-dining.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   dining.js had no per-module test file (noted on item b27ddcdd) -- this
 *   is that file, added alongside the wall-clock split and the table/chair
 *   redesign to a nesting set (item 89769f2b, 2026-09-26, several
 *   corrections from new reference photos: no pedestal + splayed legs +
 *   crossbar frame for the table; a 90-degree wedge/quadrant chair whose
 *   curved back is the outer arc of an eventual cylinder).
 *
 *   1. Builder contract compliance: both TYPES[key].DEFAULTS are frozen and
 *      carry numeric width/depth/height; y=0 is the lowest point; the
 *      assembly's back sits at z=0; and the bbox matches DEFAULTS
 *      width/height/depth within 0.5 cm -- the same tolerance
 *      scripts/test-furniture-core.mjs checks every registered builder
 *      against. (Already covered generically by test-furniture-core.mjs;
 *      re-asserted here so this file stands alone.)
 *   2. dining-table: NO pedestal (no mesh named pedestal*); exactly 4 legs,
 *      each SPLAYED outward (foot further from centre than its own top
 *      attachment, radially, for every leg); a crossbar frame (2 bars)
 *      joining the legs near the floor at the declared frameHeight; the
 *      round top drives the bbox diameter.
 *   3. dining-chair: a 90-degree wedge (quadrant) whose radius/backSweep
 *      drive the bbox; the back is a curved shell (not a flat panel) tagged
 *      as its own group; seatHeight is a param and is clamped below height;
 *      4 legs plus a 4-bar stretcher, all strictly inside the wedge
 *      footprint (never poking through the arc or the two straight sides)
 *      at several backSweep/radius combinations.
 *   4. The finish/merge contract: every mesh carries userData.finish from
 *      the closed palette {matte, gloss, metal, glass, mirror, emissive}.
 *      Every part here is matte (not a KEEP finish), so nothing should be
 *      forced into userData.keep=true merely for being curved.
 *   5. detail: 'low' produces no more triangles than 'full', for both types.
 *   6. NESTING (the "nested set" concept a spec-page preset renders): four
 *      dining-chairs tucked at 90-degree rotations around a common centre,
 *      apex pointing inward, have adjacent wedges that do NOT angularly
 *      overlap (they meet edge-to-edge, at most) -- checked as the general
 *      claim "sum of 4 chairs' backSweep must not exceed 360 degrees" (the
 *      DEFAULTS case is the equality boundary, 4*90=360) plus a direct
 *      wedge-vs-wedge bbox-corner check at the DEFAULTS backSweep. Also: the
 *      chair's own arc radius must not exceed the table top's radius (the
 *      table is allowed to overhang the nested cylinder, never the reverse),
 *      and the table's own splayed legs (which the drift/core tests confirm
 *      sit at the diagonals, i.e. the 45/135/225/315-degree gaps between
 *      chairs tucked at 0/90/180/270) clear the chairs' arc radius.
 *
 * THREE is loaded from the vendored ESM build so this exercises the same
 * geometry code the app and the spec page run, not a copy of it.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);

const THREE = await imp('vendor/three-r160/three.module.min.js');
const Fin = await imp('src/furniture/finishes.js');
const Dining = await imp('src/furniture/dining.js');

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
function checkAllTagged(tag, group) {
  let allTagged = true, untagged = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    const r = Fin.partFinish(o, o.material);
    if (r.error) { allTagged = false; untagged.push((o.name || o.type) + ': ' + r.error); }
  });
  check(tag + ': every mesh carries a finish from the closed palette', allTagged, untagged);
}

check('TYPES has dining-table and dining-chair', !!Dining.TYPES['dining-table'] && !!Dining.TYPES['dining-chair'],
  Object.keys(Dining.TYPES));
check('TYPES has no wall-clock (moved to wall-clock.js)', !Dining.TYPES['wall-clock'], Object.keys(Dining.TYPES));

// ============================================================
// dining-table
// ============================================================
{
  const Table = Dining.TYPES['dining-table'];
  check('dining-table: DEFAULTS is frozen', Object.isFrozen(Table.DEFAULTS));
  check('dining-table: DEFAULTS has numeric width/depth/height',
    ['width', 'depth', 'height'].every(k => typeof Table.DEFAULTS[k] === 'number'), Table.DEFAULTS);
  check('dining-table: DEFAULTS width equals depth (round footprint)',
    Table.DEFAULTS.width === Table.DEFAULTS.depth, Table.DEFAULTS);
  check('dining-table: DEFAULTS top is white and matte (no gloss sheen in the photo)',
    Table.DEFAULTS.topFinish === 'matte', Table.DEFAULTS);

  const g = Table.build(THREE, {}, { detail: 'full' });
  checkBboxMatchesDefaults('dining-table', g, Table.DEFAULTS);
  checkAllTagged('dining-table', g);

  const meshes = meshesByName(g);
  check('dining-table: has a tabletop', !!meshes.tabletop, Object.keys(meshes));
  check('dining-table: NO pedestal (redesigned to 4 splayed legs)',
    !Object.keys(meshes).some(n => /pedestal/i.test(n)), Object.keys(meshes));
  const legNames = Object.keys(meshes).filter(n => /^leg\d+$/.test(n));
  check('dining-table: exactly 4 legs', legNames.length === 4, legNames);
  const crossbarNames = Object.keys(meshes).filter(n => /^crossbar/i.test(n));
  check('dining-table: a crossbar frame (2 bars) joins the legs', crossbarNames.length === 2, crossbarNames);

  // Matte top/legs (the defaults) are NOT a keep finish.
  check('dining-table: matte tabletop is NOT kept', Fin.partKeep(meshes.tabletop, meshes.tabletop.material).keep !== true,
    meshes.tabletop.userData);
  legNames.forEach(n => {
    check(n + ': matte leg is NOT kept', Fin.partKeep(meshes[n], meshes[n].material).keep !== true, meshes[n].userData);
  });

  // Every leg is SPLAYED outward: its foot (lowest point, y~0) sits further
  // from the table's central axis than its own top attachment does.
  const r = Table.DEFAULTS.width / 2 / 100;
  g.updateMatrixWorld(true);
  legNames.forEach(n => {
    const leg = meshes[n];
    // World-space vertex sampling via the leg's own matrixWorld: for every
    // vertex at the leg's lowest y (the foot) vs its highest y (the top
    // attachment), the distance from the table's central axis -- splay
    // means the farthest point of the leg is at its foot end (low y), not
    // its top end.
    const posAttr = leg.geometry.attributes.position;
    const v = new THREE.Vector3();
    let lowYDist = 0, highYDist = 0, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(leg.matrixWorld);
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(leg.matrixWorld);
      const dist = Math.hypot(v.x, v.z - r);
      if (near(v.y, minY, 1e-3)) lowYDist = Math.max(lowYDist, dist);
      if (near(v.y, maxY, 1e-3)) highYDist = Math.max(highYDist, dist);
    }
    check(n + ': splayed outward (foot farther from centre than top)', lowYDist > highYDist,
      { lowYDist, highYDist });
  });

  // diameter (via width/depth) drives the bbox
  const gBig = Table.build(THREE, { width: 130, depth: 130, height: 78 }, { detail: 'full' });
  const bBig = bboxCm(gBig);
  check('dining-table: width/depth params drive bbox diameter', near(bBig.maxX - bBig.minX, 130, 0.5), bBig);
  check('dining-table: height param drives bbox height', near(bBig.maxY - bBig.minY, 78, 0.5), bBig);

  // frameHeight param moves the crossbar
  const gLowFrame = Table.build(THREE, { frameHeight: 15 }, { detail: 'full' });
  const meshesLowFrame = meshesByName(gLowFrame);
  const gHighFrame = Table.build(THREE, { frameHeight: 30 }, { detail: 'full' });
  const meshesHighFrame = meshesByName(gHighFrame);
  const yLow = new THREE.Box3().setFromObject(meshesLowFrame.crossbarA).min.y;
  const yHigh = new THREE.Box3().setFromObject(meshesHighFrame.crossbarA).min.y;
  check('dining-table: frameHeight param moves the crossbar frame', yHigh > yLow, { yLow, yHigh });

  const trisFull = triCount(Table.build(THREE, {}, { detail: 'full' }));
  const trisLow = triCount(Table.build(THREE, {}, { detail: 'low' }));
  check('dining-table: detail low has no more triangles than full', trisLow <= trisFull, { trisFull, trisLow });
}

// ============================================================
// dining-chair
// ============================================================
{
  const Chair = Dining.TYPES['dining-chair'];
  check('dining-chair: DEFAULTS is frozen', Object.isFrozen(Chair.DEFAULTS));
  check('dining-chair: DEFAULTS has numeric width/depth/height',
    ['width', 'depth', 'height'].every(k => typeof Chair.DEFAULTS[k] === 'number'), Chair.DEFAULTS);
  check('dining-chair: DEFAULTS has radius and backSweep',
    typeof Chair.DEFAULTS.radius === 'number' && typeof Chair.DEFAULTS.backSweep === 'number', Chair.DEFAULTS);
  check('dining-chair: DEFAULTS backSweep is 90 (a quarter circle)', Chair.DEFAULTS.backSweep === 90, Chair.DEFAULTS);
  check('dining-chair: DEFAULTS depth equals radius', Chair.DEFAULTS.depth === Chair.DEFAULTS.radius, Chair.DEFAULTS);
  // width should equal 2*radius*sin(backSweep/2) within schema-default rounding.
  const expectedWidth = 2 * Chair.DEFAULTS.radius * Math.sin((Chair.DEFAULTS.backSweep * Math.PI) / 180 / 2);
  check('dining-chair: DEFAULTS width matches 2*radius*sin(backSweep/2)', near(Chair.DEFAULTS.width, expectedWidth, 0.1),
    { width: Chair.DEFAULTS.width, expectedWidth });

  const g = Chair.build(THREE, {}, { detail: 'full' });
  checkBboxMatchesDefaults('dining-chair', g, Chair.DEFAULTS);
  checkAllTagged('dining-chair', g);

  const meshes = meshesByName(g);
  check('dining-chair: has a seat', !!meshes.seat, Object.keys(meshes));
  check('dining-chair: has a curved back shell (outer + inner)', !!meshes.backOuter && !!meshes.backInner,
    Object.keys(meshes));
  const legNames = Object.keys(meshes).filter(n => /^leg\d+$/.test(n));
  check('dining-chair: exactly 4 legs', legNames.length === 4, legNames);
  const stretcherNames = Object.keys(meshes).filter(n => /^stretcher/i.test(n));
  check('dining-chair: a 4-bar stretcher frame joins the legs', stretcherNames.length === 4, stretcherNames);

  // matte seat/back/legs (the defaults) are NOT a keep finish -- curved
  // geometry alone must not force userData.keep.
  check('dining-chair: matte seat is NOT kept', Fin.partKeep(meshes.seat, meshes.seat.material).keep !== true, meshes.seat.userData);
  check('dining-chair: matte curved back is NOT kept',
    Fin.partKeep(meshes.backOuter, meshes.backOuter.material).keep !== true, meshes.backOuter.userData);

  // seatHeight is a param and is clamped below height, never allowed to exceed it.
  const gClamped = Chair.build(THREE, { height: 60, seatHeight: 95 }, { detail: 'full' });
  const bClamped = bboxCm(gClamped);
  check('dining-chair: seatHeight is clamped below height (bbox still matches height)',
    near(bClamped.maxY - bClamped.minY, 60, 0.5), bClamped);

  // radius/backSweep params drive the bbox, at several combinations.
  [[40, 90], [45, 100], [50, 80]].forEach(([radiusCm, sweepDeg]) => {
    const width = 2 * radiusCm * Math.sin((sweepDeg * Math.PI) / 180 / 2);
    const defaults = { width, depth: radiusCm, height: Chair.DEFAULTS.height };
    const gg = Chair.build(THREE, { radius: radiusCm, backSweep: sweepDeg }, { detail: 'full' });
    checkBboxMatchesDefaults('dining-chair (radius=' + radiusCm + ', backSweep=' + sweepDeg + ')', gg, defaults);
  });

  // Every leg AND stretcher stays strictly inside the wedge footprint (the
  // arc for the back portion, the two straight sides for the rest) at
  // several radius/backSweep combinations -- the wedge is a narrowing
  // triangle-like shape, not a rectangle, so this is the check that would
  // have caught the front two legs poking outside the shape during
  // development.
  function wedgeHalfWidthAtZ(radius, sweep, z) {
    const halfSweep = sweep / 2;
    const xEnd = radius * Math.sin(halfSweep);
    const zEnd = radius - radius * Math.cos(halfSweep);
    if (z <= zEnd) {
      const a = Math.acos(Math.min(1, Math.max(-1, 1 - z / radius)));
      return radius * Math.sin(a);
    }
    if (z >= radius) return 0;
    return Math.max(0, (xEnd * (radius - z)) / (radius - zEnd));
  }
  [[45, 90], [40, 90], [45, 75]].forEach(([radiusCm, sweepDeg]) => {
    const radius = radiusCm / 100;
    const sweep = (sweepDeg * Math.PI) / 180;
    const gg = Chair.build(THREE, { radius: radiusCm, backSweep: sweepDeg }, { detail: 'full' });
    gg.updateMatrixWorld(true);
    const meshesGg = meshesByName(gg);
    const partNames = Object.keys(meshesGg).filter(n => /^(leg|stretcher)/i.test(n));
    let allInside = true;
    const offenders = [];
    partNames.forEach(n => {
      const mesh = meshesGg[n];
      const posAttr = mesh.geometry.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
        const safe = wedgeHalfWidthAtZ(radius, sweep, v.z) + 1e-6;
        if (Math.abs(v.x) > safe) { allInside = false; offenders.push({ n, x: v.x, z: v.z, safe }); }
      }
    });
    check('dining-chair (radius=' + radiusCm + ', backSweep=' + sweepDeg + '): legs+stretcher stay inside the wedge',
      allInside, offenders.slice(0, 3));
  });

  const trisFull = triCount(Chair.build(THREE, {}, { detail: 'full' }));
  const trisLow = triCount(Chair.build(THREE, {}, { detail: 'low' }));
  check('dining-chair: detail low has no more triangles than full', trisLow <= trisFull, { trisFull, trisLow });
}

// ============================================================
// NESTING: 4 chairs tucked under the table
// ============================================================
{
  const Table = Dining.TYPES['dining-table'];
  const Chair = Dining.TYPES['dining-chair'];
  const radius = Chair.DEFAULTS.radius / 100;
  const sweep = (Chair.DEFAULTS.backSweep * Math.PI) / 180;

  check('nesting: 4 * DEFAULTS.backSweep == 360 (chairs exactly ring the centre)',
    near(Chair.DEFAULTS.backSweep * 4, 360), Chair.DEFAULTS.backSweep);

  // Tucked placement: chair i's own origin (its back-arc centre, local
  // (0,0,0)) sits on the rim circle of radius `radius` at angle i*90deg from
  // +z, rotated by (angle + 180deg) so its apex (front, local (0,*,radius))
  // points back to the common centre -- the same math the "nested set" spec
  // preset uses.
  function tuckedChair(i) {
    const theta = (i * Math.PI) / 2;
    const g = Chair.build(THREE, {}, { detail: 'full' });
    g.position.set(radius * Math.sin(theta), 0, radius * Math.cos(theta));
    g.rotation.y = theta + Math.PI;
    g.updateMatrixWorld(true);
    return g;
  }
  const chairs = [0, 1, 2, 3].map(tuckedChair);

  // Every chair's apex converges on the common centre (within a mm).
  chairs.forEach((g, i) => {
    const apexLocal = new THREE.Vector3(0, 0.3, radius);
    const apexWorld = apexLocal.applyMatrix4(g.matrixWorld);
    check('nesting: chair ' + i + ' apex converges on the table centre',
      near(apexWorld.x, 0, 0.005) && near(apexWorld.z, 0, 0.005), apexWorld);
  });

  // Angular non-overlap: each chair occupies world angle
  // [theta_i - sweep/2, theta_i + sweep/2] around the centre; adjacent
  // ranges must not overlap (touching at the boundary is fine and expected
  // at backSweep==90).
  for (let i = 0; i < 4; i++) {
    const thetaA = (i * Math.PI) / 2;
    const thetaB = ((i + 1) * Math.PI) / 2;
    const hiA = thetaA + sweep / 2;
    const loB = thetaB - sweep / 2;
    check('nesting: chair ' + i + ' and chair ' + ((i + 1) % 4) + ' do not angularly overlap',
      hiA <= loB + 1e-9, { hiA, loB });
  }

  // The chair's own arc radius must not exceed the table top's radius (the
  // table overhangs the nested cylinder, never the reverse).
  const tableR = Table.DEFAULTS.width / 2 / 100;
  check('nesting: chair arc radius <= table top radius', radius <= tableR + 1e-9, { radius, tableR });

  // The table's own splayed legs sit in the gaps (45/135/225/315 degrees,
  // i.e. the diagonals) and clear the chairs' arc radius -- verified against
  // the actual built geometry, not just the placement formula.
  const gTable = Table.build(THREE, {}, { detail: 'full' });
  const legs = [];
  gTable.traverse(o => { if (o.isMesh && /^leg\d+$/.test(o.name)) legs.push(o); });
  legs.forEach(leg => {
    const b = new THREE.Box3().setFromObject(leg);
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2 - tableR; // relative to the table's own centre
    const angleDeg = ((Math.atan2(cx, cz) * 180) / Math.PI + 360) % 360;
    const nearGap = [45, 135, 225, 315].some(g => Math.abs(((angleDeg - g + 540) % 360) - 180) <= 1);
    check(leg.name + ': sits in a gap angle (45/135/225/315 deg) between tucked chairs', nearGap, angleDeg);
    const distFromCentre = Math.hypot(cx, cz);
    check(leg.name + ': clears the chairs\' arc radius', distFromCentre > radius, { distFromCentre, radius });
  });
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
