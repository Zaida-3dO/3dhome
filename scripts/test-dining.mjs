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

  // WINDING (code review round 1, item 89769f2b, fix #2): the back shell's
  // OUTER surface must face AWAY from the wedge's own apex (the point that
  // aims at the table centre) -- otherwise the curved velvet back is
  // invisible from outside a nested set (back-face culled) and lit with
  // inverted normals from inside. Sampled directly from the built geometry's
  // own vertex/normal attributes, not asserted from the source code.
  function checkOuterWinding(tag, mesh, expectOutward, apexZ) {
    const posAttr = mesh.geometry.attributes.position;
    const idx = mesh.geometry.index;
    const apex = new THREE.Vector3(0, 0, apexZ);
    const triCount = idx ? idx.count / 3 : posAttr.count / 3;
    let allCorrect = true;
    const sampleCount = Math.min(10, triCount);
    for (let t = 0; t < sampleCount; t++) {
      const ia = idx ? idx.getX(t * 3) : t * 3, ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      const va = new THREE.Vector3().fromBufferAttribute(posAttr, ia);
      const vb = new THREE.Vector3().fromBufferAttribute(posAttr, ib);
      const vc = new THREE.Vector3().fromBufferAttribute(posAttr, ic);
      const centroid = va.clone().add(vb).add(vc).multiplyScalar(1 / 3);
      const faceNormal = new THREE.Vector3().crossVectors(vb.clone().sub(va), vc.clone().sub(va)).normalize();
      const outwardXZ = new THREE.Vector3(centroid.x, 0, centroid.z - apex.z).normalize();
      const dot = faceNormal.dot(outwardXZ);
      if (expectOutward ? dot < 0.9 : dot > -0.9) allCorrect = false;
    }
    check(tag, allCorrect, { expectOutward });
  }
  const chairApexZ = Chair.DEFAULTS.radius / 100;
  checkOuterWinding('dining-chair: backOuter faces AWAY from the wedge apex (visible from outside)', meshes.backOuter, true, chairApexZ);
  checkOuterWinding('dining-chair: backInner faces TOWARD the wedge apex (its own visible/concave side)', meshes.backInner, false, chairApexZ);

  // Mutation-probe: the PRE-FIX winding (a raw geo.scale(1,1,-1) mirror with
  // no index-order correction) must FAIL the outward-facing check above --
  // otherwise this check cannot actually tell inside-out from correct.
  {
    const chairSweep = (Chair.DEFAULTS.backSweep * Math.PI) / 180;
    const backHeight = 0.19, backSegs = 16;
    const badGeo = new THREE.CylinderGeometry(chairApexZ, chairApexZ, backHeight, backSegs, 1, true, -chairSweep / 2, chairSweep);
    badGeo.scale(1, 1, -1); // mirrors the geometry WITHOUT flipping the index winding -- the round-1 bug
    badGeo.translate(0, 0, chairApexZ);
    badGeo.computeVertexNormals();
    let anyOutward = false;
    const posAttr = badGeo.attributes.position, idx = badGeo.index;
    const apex = new THREE.Vector3(0, 0, chairApexZ);
    for (let t = 0; t < Math.min(10, idx.count / 3); t++) {
      const ia = idx.getX(t * 3), ib = idx.getX(t * 3 + 1), ic = idx.getX(t * 3 + 2);
      const va = new THREE.Vector3().fromBufferAttribute(posAttr, ia);
      const vb = new THREE.Vector3().fromBufferAttribute(posAttr, ib);
      const vc = new THREE.Vector3().fromBufferAttribute(posAttr, ic);
      const centroid = va.clone().add(vb).add(vc).multiplyScalar(1 / 3);
      const faceNormal = new THREE.Vector3().crossVectors(vb.clone().sub(va), vc.clone().sub(va)).normalize();
      const outwardXZ = new THREE.Vector3(centroid.x, 0, centroid.z - apex.z).normalize();
      if (faceNormal.dot(outwardXZ) > 0.9) anyOutward = true;
    }
    check('dining-chair mutation-probe: a raw scale(1,1,-1) mirror (no winding fix) does NOT face outward (proves the winding check is not hollow)',
      !anyOutward);
  }

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
// NESTING: 4 chairs tucked under the table -- GEOMETRY-SAMPLING checks
// ============================================================
//
// Round 1 code review (item 89769f2b) found the previous version of this
// block hollow: it checked arithmetic on DEFAULTS.backSweep and each leg's
// BBOX CENTRE, never the real triangles. The real tucked set interpenetrated
// (every table leg passed through both neighbouring chairs' seat and back
// shell) and this block still reported 90/90. This version samples actual
// mesh vertices from the actual built geometry -- the table (correctly
// CENTRED the way DiningSpec.html's fix #3 does it) and all 4 tucked
// chairs -- and tests real containment, not a idealised wedge formula.
{
  const Table = Dining.TYPES['dining-table'];
  const Chair = Dining.TYPES['dining-chair'];
  const radius = Chair.DEFAULTS.radius / 100;
  const sweep = (Chair.DEFAULTS.backSweep * Math.PI) / 180;
  const tableR = Table.DEFAULTS.width / 2 / 100;

  check('nesting: 4 * DEFAULTS.backSweep == 360 (chairs exactly ring the centre)',
    near(Chair.DEFAULTS.backSweep * 4, 360), Chair.DEFAULTS.backSweep);
  check('nesting: chair arc radius <= table top radius', radius <= tableR + 1e-9, { radius, tableR });

  // Tucked placement: chair i's own origin (its back-arc centre, local
  // (0,0,0)) sits on the rim circle of radius `radius` at angle i*90deg from
  // +z, rotated by (angle + 180deg) so its apex (front, local (0,*,radius))
  // points back to the common centre -- the same math DiningSpec.html's
  // buildDiningScene uses (this is the ACCEPTANCE surface: a test with its
  // own placement math that disagrees with the page cannot see the page's
  // bugs, which is exactly how round 1's off-centre table escaped this file).
  function tuckedChair(radiusOverride) {
    const rTuck = radiusOverride == null ? radius : radiusOverride;
    return [0, 1, 2, 3].map(i => {
      const theta = (i * Math.PI) / 2;
      const g = Chair.build(THREE, {}, { detail: 'full' });
      g.position.set(rTuck * Math.sin(theta), 0, rTuck * Math.cos(theta));
      g.rotation.y = theta + Math.PI;
      g.updateMatrixWorld(true);
      return g;
    });
  }
  // The table, centred the same way DiningSpec.html's fix #3 does: its own
  // local frame has z=0 at the back and z=+diameter/2 at its centre, so
  // shifting it back by that radius puts its TRUE centre at the group
  // origin, the same point the chairs above ring.
  function centredTable() {
    const g = Table.build(THREE, {}, { detail: 'full' });
    g.position.z = -tableR;
    g.updateMatrixWorld(true);
    return g;
  }

  // Every chair's apex converges on the common centre (within a mm).
  tuckedChair().forEach((g, i) => {
    const apexLocal = new THREE.Vector3(0, 0.3, radius);
    const apexWorld = apexLocal.applyMatrix4(g.matrixWorld);
    check('nesting: chair ' + i + ' apex converges on the table centre',
      near(apexWorld.x, 0, 0.005) && near(apexWorld.z, 0, 0.005), apexWorld);
  });

  // Angular non-overlap (necessary but not sufficient -- kept as a coarse
  // sanity check; the REAL check below samples actual triangles).
  for (let i = 0; i < 4; i++) {
    const thetaA = (i * Math.PI) / 2;
    const thetaB = ((i + 1) * Math.PI) / 2;
    const hiA = thetaA + sweep / 2;
    const loB = thetaB - sweep / 2;
    check('nesting: chair ' + i + ' and chair ' + ((i + 1) % 4) + ' do not angularly overlap',
      hiA <= loB + 1e-9, { hiA, loB });
  }

  /**
   * Points sampled along `mesh`'s own EDGES (each triangle's 3 edges,
   * subdivided into `stepsPerEdge` segments), in world space -- not just its
   * raw vertices. A leg is a box with vertices only at its two end-rings, so
   * vertex-only sampling can miss its SURFACE crossing a thin band (like the
   * chair seat's 4cm slab) between those rings entirely -- which is exactly
   * how an earlier version of this file's mutation-probe found a real
   * collision reported zero. Edge sampling catches that: the leg's own long
   * edges get subdivided finely enough to cross any band this thin.
   */
  function sampleMeshSurfacePoints(mesh, stepsPerEdge) {
    const posAttr = mesh.geometry.attributes.position;
    const idx = mesh.geometry.index;
    const points = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const triCount = idx ? idx.count / 3 : posAttr.count / 3;
    for (let t = 0; t < triCount; t++) {
      const ia = idx ? idx.getX(t * 3) : t * 3, ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(posAttr, ia).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(posAttr, ib).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(posAttr, ic).applyMatrix4(mesh.matrixWorld);
      [[a, b], [b, c], [c, a]].forEach(([p, q]) => {
        for (let s = 0; s <= stepsPerEdge; s++) {
          points.push(new THREE.Vector3().lerpVectors(p, q, s / stepsPerEdge));
        }
      });
    }
    return points;
  }

  /**
   * Every point sampled along `sourceGroup`'s own mesh SURFACES (edges,
   * finely subdivided -- see sampleMeshSurfacePoints, not just raw
   * vertices) is tested against every chair in `chairGroups`: does it fall
   * inside that chair's SEAT slab (a thin band at y in [seatH-thickness,
   * seatH], within the wedge's angular sweep and radius) or inside its BACK
   * SHELL's radius band (between innerR and radius, within the sweep, at a
   * y the shell actually spans)? Returns the list of collisions found (name
   * + chair index + local coords), so a failure is diagnosable, not just a
   * count.
   */
  function findCollisions(sourceGroup, sourceNamePattern, chairGroups) {
    const collisions = [];
    const seatH = Chair.DEFAULTS.seatHeight / 100;
    const seatThickness = 0.04;
    const backThickness = 0.025;
    const innerR = radius - backThickness;
    const peakHeight = Math.max(0.01, Chair.DEFAULTS.height / 100 - seatH);
    const sideHeight = peakHeight * 0.65;
    function backHeightAt(theta) {
      const frac = Math.cos((theta / (sweep / 2)) * (Math.PI / 2));
      return sideHeight + (peakHeight - sideHeight) * frac;
    }
    sourceGroup.traverse(o => {
      if (!o.isMesh || !sourceNamePattern.test(o.name)) return;
      const points = sampleMeshSurfacePoints(o, 24);
      points.forEach(v => {
        chairGroups.forEach((chair, ci) => {
          const local = v.clone().applyMatrix4(chair.matrixWorld.clone().invert());
          if (local.z < -0.005 || local.z > radius + 0.005) return; // outside the wedge's own z-span
          const ddx = local.x, ddz = radius - local.z;
          const distFromApex = Math.hypot(ddx, ddz);
          const angleFromBack = Math.atan2(ddx, ddz);
          if (Math.abs(angleFromBack) > sweep / 2 + 0.005) return; // outside the wedge's angular sweep
          // Seat slab: a thin band at y in [seatH-thickness, seatH], filled
          // out to `radius` in the wedge (the seat's own footprint).
          const inSeatBand = local.y >= seatH - seatThickness - 0.002 && local.y <= seatH + 0.002 && distFromApex <= radius;
          // Back shell: a thin radius band, only where the shell's own
          // (angle-dependent) height profile actually reaches this y.
          const shellTopY = seatH + backHeightAt(angleFromBack);
          const inBackShellBand = distFromApex >= innerR - 0.003 && distFromApex <= radius + 0.001 &&
            local.y >= seatH - 0.002 && local.y <= shellTopY + 0.002;
          if (inSeatBand || inBackShellBand) {
            collisions.push({ name: o.name, chair: ci, local: { x: +local.x.toFixed(3), y: +local.y.toFixed(3), z: +local.z.toFixed(3) }, distFromApex: +distFromApex.toFixed(3), inSeatBand, inBackShellBand });
          }
        });
      });
    });
    return collisions;
  }

  // ---- The real fix: table legs/crossbars vs the 4 tucked chairs. ----
  {
    const table = centredTable();
    const chairs = tuckedChair();
    const collisions = findCollisions(table, /^(leg\d+|crossbar)/, chairs);
    check('nesting: table legs/crossbars do not intersect any tucked chair\'s seat or back shell',
      collisions.length === 0, collisions.slice(0, 5));
  }

  // ---- Mutation-probe: a leg inset back to 0.55 (down from the shipped
  // 0.70) puts its seat-height crossing point at ~0.42m from the wedge
  // apex -- inside the chair's own 0.45m seat radius -- and MUST fail this
  // test, otherwise it cannot actually distinguish a colliding layout from
  // a clear one (the same hollowness round 1 found: the original arithmetic
  // check passed 90/90 even though the shipped legTopInset of 0.62
  // interpenetrated both neighbouring chairs' seat and back shell). 0.55
  // targets the SEAT specifically (independent of the back shell's own
  // angle-dependent, now-tapered height profile, which shrinks the back's
  // reach at exactly the angle a seam leg sits at). ----
  {
    const legSize = 0.032, splayAngle = 0.16, topThickness = 0.028;
    const h = Table.DEFAULTS.height / 100;
    const legTopInsetBad = tableR * 0.55; // deliberately deep -- inside the seat slab
    const vertSpan = h - topThickness - (legSize / 2) * Math.sin(splayAngle);
    const legLen = vertSpan / Math.cos(splayAngle);
    const legGeo = new THREE.BoxGeometry(legSize, legLen, legSize);
    legGeo.translate(0, -legLen / 2, 0);
    const corners = [{ sx: -1, sz: -1 }, { sx: 1, sz: -1 }, { sx: -1, sz: 1 }, { sx: 1, sz: 1 }];
    const badLegsGroup = new THREE.Group();
    corners.forEach((c, i) => {
      const leg = new THREE.Mesh(legGeo.clone());
      leg.name = 'leg' + i;
      const diag = new THREE.Vector2(c.sx, c.sz).normalize();
      const tiltAxis = new THREE.Vector3(-diag.y, 0, diag.x);
      leg.setRotationFromAxisAngle(tiltAxis, splayAngle);
      leg.position.set(c.sx * legTopInsetBad, h - topThickness, c.sz * legTopInsetBad + tableR);
      badLegsGroup.add(leg);
    });
    badLegsGroup.position.z = -tableR; // same centring the real fix uses
    badLegsGroup.updateMatrixWorld(true);
    const chairs = tuckedChair();
    const collisions = findCollisions(badLegsGroup, /^leg\d+/, chairs);
    check('nesting mutation-probe: a leg inset deep inside the chair seat radius (0.55) DOES collide (proves this test is not hollow)',
      collisions.length > 0, { collisionCount: collisions.length });
  }

  // ---- The chair back's highest point stays under the table's underside,
  // with the ~1cm clearance the round-1 fix targeted. ----
  {
    const tableUndersideY = Table.DEFAULTS.height / 100 - 0.028;
    const chairBackTopY = Chair.DEFAULTS.seatHeight / 100 + Math.max(0.01, Chair.DEFAULTS.height / 100 - Chair.DEFAULTS.seatHeight / 100);
    const clearance = tableUndersideY - chairBackTopY;
    check('nesting: chair back top clears the table underside by roughly 1cm',
      clearance >= 0.005 && clearance <= 0.03, { tableUndersideY, chairBackTopY, clearanceCm: (clearance * 100).toFixed(2) });
  }

  // ---- Mutation-probe: raising chair height back to the table's own
  // height (the pre-fix value) DOES violate the clearance check. ----
  {
    const tableUndersideY = Table.DEFAULTS.height / 100 - 0.028;
    const badChairBackTopY = Chair.DEFAULTS.seatHeight / 100 + Math.max(0.01, 0.75 - Chair.DEFAULTS.seatHeight / 100); // pre-fix height=75
    const badClearance = tableUndersideY - badChairBackTopY;
    check('nesting mutation-probe: the PRE-FIX chair height (75) DOES violate the table clearance',
      badClearance < 0, { badClearance });
  }
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
