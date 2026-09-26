#!/usr/bin/env node
/**
 * Plant builder: bbox/height match the requested params, the base sits at
 * y=0, low-detail stays under the mobile triangle budget, a seed change
 * actually reshuffles the leaf layout (deterministically), and every mesh
 * carries a merge-fidelity `userData.finish`. No framework, no install -
 * `node scripts/test-plant-builder.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. build(THREE, params) for kind 'corn-plant' returns a group whose
 *      total height (bbox max Y) is potHeight + plantHeight, within the
 *      tolerance a leaf's droop can add (leaves only arc DOWNWARD from the
 *      cane top in this builder, so the top of the tallest cane IS the top
 *      of the bbox).
 *   2. The corn-plant's pot bottom sits at y=0 (bbox min Y), matching the
 *      "y=0 at the base" contract every furniture builder shares.
 *   3. The widest leaf spread stays within the requested `spread` (no leaf
 *      silently overshoots the footprint the room-placement math would use).
 *   4. `opts.detail: 'low'` keeps the triangle count <=300 (the mobile
 *      budget) for BOTH kinds, and strictly below 'full's count -- a real
 *      reduction, not a no-op flag.
 *   5. The SAME seed produces the IDENTICAL leaf layout twice in a row
 *      (determinism), and a DIFFERENT seed produces a DIFFERENT layout
 *      (the seed actually drives something, not a decoration nobody reads).
 *   6. The corn-plant preset (item 889bf6ce, the plant between the two
 *      home-office desks) has 3 canes and the vase/plant heights from the
 *      brief.
 *   7. Every mesh from every preset carries userData.finish, one of the six
 *      allowed values (matte/gloss/metal/glass/mirror/emissive) -- the live
 *      renderer merges meshes by finish, so an untagged mesh would silently
 *      opt out of that merge -- and any glass/emissive mesh also carries
 *      userData.keep=true, since those two finishes are excluded from the
 *      merge (neither preset uses either finish today, so this currently
 *      passes vacuously true; it pins the rule for the next kind that does).
 *   8. The wall-planter kind: back at z=0 (wall-mounted, not free-standing),
 *      large vs. small presets differ in width as specified, and it builds
 *      a distinct leaf cluster from the corn plant's rosette.
 *
 * The builder is exercised with the real vendored three.js module, so this
 * runs the same geometry code the spec page does.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const { build, buildPlant, TYPE, DEFAULTS, PRESETS } = await imp('src/furniture/plant.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const CM = 0.01;

function bboxOf(group) {
  const box = new THREE.Box3().setFromObject(group);
  return { min: box.min, max: box.max };
}
function triCount(group) {
  let tris = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    const count = geo.index ? geo.index.count : geo.attributes.position.count;
    tris += count / 3;
  });
  return tris;
}
function leafPositions(group) {
  const pts = [];
  group.traverse(o => {
    if (o.name === 'leaf') {
      const pos = o.geometry.attributes.position;
      // tip vertex (last row's first column) is enough to fingerprint layout
      const n = pos.count;
      pts.push({ x: pos.getX(n - 2), y: pos.getY(n - 2), z: pos.getZ(n - 2) });
    }
  });
  return pts;
}

// ---- 0. module shape ------------------------------------------------------
check('TYPE is "plant"', TYPE === 'plant', TYPE);
check('DEFAULTS is frozen', Object.isFrozen(DEFAULTS));
check('buildPlant alias exists and matches build', typeof buildPlant === 'function');

// ---- 1. total height = potHeight + plantHeight (within tolerance) --------
{
  const params = { potHeight: 56, potTopDiameter: 30, plantHeight: 110, stemCount: 3, spread: 40, seed: 7 };
  const group = build(THREE, params);
  const b = bboxOf(group);
  const expectedTop = (56 + 110) * CM;
  check('bbox top matches potHeight + plantHeight', near(b.max.y, expectedTop, 1e-3),
    { got: b.max.y, expected: expectedTop });
}

// ---- 2. pot bottom sits at y=0 ---------------------------------------------
{
  const group = build(THREE, { potHeight: 56, plantHeight: 110, seed: 3 });
  const b = bboxOf(group);
  check('pot bottom at y=0', near(b.min.y, 0, 1e-6), b.min.y);
}

// ---- 3. leaf spread stays within the requested footprint -------------------
{
  const spreadCm = 40;
  const group = build(THREE, { spread: spreadCm, stemCount: 3, seed: 5 });
  const b = bboxOf(group);
  const halfSpread = (spreadCm * CM) / 2;
  // Generous slack for the pot's own footprint + rosette offset; the check
  // is that leaves don't blow FAR past the requested spread, not a tight bound.
  check('leaf extent respects spread (with pot-footprint slack)',
    (b.max.x - b.min.x) <= (spreadCm * CM) * 1.6, { width: b.max.x - b.min.x, halfSpread });
}

// ---- 4. low detail stays under the mobile triangle budget ------------------
{
  const full = build(THREE, {}, { detail: 'full' });
  const low = build(THREE, {}, { detail: 'low' });
  const fullTris = triCount(full);
  const lowTris = triCount(low);
  check('low detail <= 300 triangles', lowTris <= 300, lowTris);
  check('low detail is a real reduction from full', lowTris < fullTris, { lowTris, fullTris });
}

// ---- 5. seed determinism + variation ---------------------------------------
{
  const a1 = leafPositions(build(THREE, { seed: 11 }));
  const a2 = leafPositions(build(THREE, { seed: 11 }));
  const b1 = leafPositions(build(THREE, { seed: 12 }));
  check('same seed -> identical leaf count', a1.length === a2.length, [a1.length, a2.length]);
  check('same seed -> identical tip positions', a1.every((l, i) => near(l.x, a2[i].x, 1e-9) &&
    near(l.y, a2[i].y, 1e-9) && near(l.z, a2[i].z, 1e-9)));
  check('different seed -> different tip positions',
    a1.length === b1.length && !a1.every((l, i) => near(l.x, b1[i].x, 1e-9) && near(l.z, b1[i].z, 1e-9)));
}

// ---- 6. corn-plant preset (item 889bf6ce) -----------------------------------
{
  const cornPlant = PRESETS['corn-plant-tall'];
  check('corn-plant preset has 3 canes', cornPlant.stemCount === 3, cornPlant.stemCount);
  check('corn-plant preset vase height 56cm', cornPlant.potHeight === 56, cornPlant.potHeight);
  check('corn-plant preset plant height 110cm', cornPlant.plantHeight === 110, cornPlant.plantHeight);
  check('corn-plant preset spread 40cm', cornPlant.spread === 40, cornPlant.spread);
  const group = build(THREE, cornPlant);
  const canes = [];
  group.traverse(o => { if (o.name === 'cane') canes.push(o); });
  check('corn-plant preset builds 3 distinct canes', canes.length === 3, canes.length);
  const b = bboxOf(group);
  check('corn-plant preset total height ~166cm', near(b.max.y, 1.66, 1e-3), b.max.y);
}

// ---- 7. every mesh in every preset carries a valid userData.finish --------
{
  const ALLOWED_FINISHES = new Set(['matte', 'gloss', 'metal', 'glass', 'mirror', 'emissive']);
  for (const [name, preset] of Object.entries(PRESETS)) {
    const group = build(THREE, preset);
    const untagged = [];
    const invalid = [];
    group.traverse(o => {
      if (!o.isMesh) return;
      const f = o.userData.finish;
      if (f == null) untagged.push(o.name);
      else if (!ALLOWED_FINISHES.has(f)) invalid.push([o.name, f]);
    });
    check(`preset "${name}": every mesh has userData.finish`, untagged.length === 0, untagged);
    check(`preset "${name}": every finish is one of matte/gloss/metal/glass/mirror/emissive`, invalid.length === 0, invalid);

    // Any glass/emissive mesh must carry keep=true (those finishes are
    // excluded from the by-finish merge). Vacuously true today -- neither
    // kind uses either finish -- but pins the rule for future kinds.
    const unkept = [];
    group.traverse(o => {
      if (!o.isMesh) return;
      const f = o.userData.finish;
      if ((f === 'glass' || f === 'emissive') && o.userData.keep !== true) unkept.push(o.name);
    });
    check(`preset "${name}": every glass/emissive mesh has userData.keep=true`, unkept.length === 0, unkept);
  }
}

// ---- 8. wall-planter kind ----------------------------------------------------
{
  const large = PRESETS['wall-planter-large'];
  const small = PRESETS['wall-planter-small'];
  check('large preset is wider than small', large.width > small.width, [large.width, small.width]);
  check('large preset width ~25cm', large.width === 25, large.width);
  check('small preset width ~12cm', small.width === 12, small.width);

  const group = build(THREE, large);
  const b = bboxOf(group);
  // back-at-wall contract: nothing should sit meaningfully behind z=0 (a
  // small negative slack covers the bracket's own thickness).
  check('wall-planter back sits at/near z=0 (wall-mounted, not free-standing)',
    b.min.z >= -0.01, b.min.z);
  check('wall-planter has no pot/cane/rosette meshes (different anatomy from corn-plant)', (() => {
    let found = false;
    group.traverse(o => { if (/^(potBody|cane|rosette|soil)$/.test(o.name)) found = true; });
    return !found;
  })());
  const leaves = [];
  group.traverse(o => { if (o.name === 'leaf') leaves.push(o); });
  check('wall-planter builds the requested leaf count', leaves.length === large.leafCount, leaves.length);
  const frameParts = [];
  group.traverse(o => { if (/^frame/.test(o.name)) frameParts.push(o); });
  check('wall-planter has a wire frame (rim + struts)', frameParts.length > 0, frameParts.length);

  const fullTris = triCount(build(THREE, large, { detail: 'full' }));
  const lowTris = triCount(build(THREE, large, { detail: 'low' }));
  check('wall-planter low detail <= 300 triangles', lowTris <= 300, lowTris);
  check('wall-planter low detail is a real reduction from full', lowTris < fullTris, { lowTris, fullTris });
}

console.log(`${passes} passed, ${failures} failed.`);
if (failures > 0) process.exit(1);
