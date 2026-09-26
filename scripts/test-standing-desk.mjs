#!/usr/bin/env node
/**
 * Standing desk builder: bbox matches the requested size, and the height
 * clamp actually clamps. No framework, no install -
 * `node scripts/test-standing-desk.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. buildStandingDesk(THREE, opts) returns a group whose bounding box
 *      matches the requested width/depth/height (top surface = height +
 *      topThickness; underside of the top = height).
 *   2. A height outside [minHeight, maxHeight] is clamped into range rather
 *      than honoured -- the acceptance criterion for the height slider.
 *   3. An absent height defaults to the midpoint of the range rather than
 *      throwing or silently drawing at 0.
 *   4. The legs are two distinct columns (not a single centred pedestal),
 *      each a front-to-back foot bar spanning the desk's full depth -- the
 *      "flat T-foot legs" look this spec targets.
 *
 * The builder is exercised with the real vendored three.js module, so this
 * runs the same geometry code the spec page does.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const { buildStandingDesk, clampHeight } = await imp('src/standing-desk.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function bboxOf(group) {
  const box = new THREE.Box3().setFromObject(group);
  return { min: box.min, max: box.max };
}

// ---- 1. bbox matches width/depth/height at a mid-range height ----------
{
  const { group, clampedHeight } = buildStandingDesk(THREE, {
    width: 120, depth: 80, height: 95, minHeight: 72, maxHeight: 120, topThickness: 2.5
  });
  const b = bboxOf(group);
  check('clampedHeight unchanged when in range', clampedHeight === 95, clampedHeight);
  check('bbox width matches (x)', near(b.max.x - b.min.x, 1.20, 1e-3), b);
  check('bbox depth matches (z)', near(b.max.z - b.min.z, 0.80, 1e-3), b);
  check('bbox spans floor to top surface (y)', near(b.min.y, 0, 5e-3) &&
    near(b.max.y, 0.95 + 0.025, 1e-3), b);
  check('desk is centred on x=0', near(b.max.x, -b.min.x, 1e-3), b);
  check('desk is centred on z=0', near(b.max.z, -b.min.z, 1e-3), b);
}

// ---- 2. height clamps into [minHeight, maxHeight] -----------------------
{
  const low = buildStandingDesk(THREE, { width: 120, depth: 80, height: 40, minHeight: 72, maxHeight: 120 });
  check('height below range clamps to minHeight', low.clampedHeight === 72, low.clampedHeight);
  const high = buildStandingDesk(THREE, { width: 120, depth: 80, height: 500, minHeight: 72, maxHeight: 120 });
  check('height above range clamps to maxHeight', high.clampedHeight === 120, high.clampedHeight);
  check('clampHeight() matches the builder for the same inputs',
    clampHeight(40, 72, 120) === 72 && clampHeight(500, 72, 120) === 120);
}

// ---- 3. absent height defaults to the range midpoint ---------------------
{
  const mid = clampHeight(undefined, 72, 120);
  check('absent height defaults to the midpoint', mid === 96, mid);
  const { clampedHeight } = buildStandingDesk(THREE, { width: 120, depth: 80, minHeight: 72, maxHeight: 120 });
  check('builder defaults an absent height the same way', clampedHeight === 96, clampedHeight);
}

// ---- 4. two distinct legs, each a full-depth foot bar ---------------------
{
  const { group } = buildStandingDesk(THREE, { width: 120, depth: 80, height: 95, minHeight: 72, maxHeight: 120 });
  const feet = [];
  group.traverse(o => { if (o.name === 'legFoot') feet.push(o); });
  check('exactly two foot bars', feet.length === 2, feet.length);
  if (feet.length === 2) {
    const [a, b] = feet;
    check('feet sit on opposite sides of centre', Math.sign(a.position.x) !== Math.sign(b.position.x), [a.position.x, b.position.x]);
    const footGeoDepth = a.geometry.parameters.depth;
    check('foot bar spans the full desk depth (front-to-back)', near(footGeoDepth, 0.80, 1e-3), footGeoDepth);
  }
  const uppers = [];
  group.traverse(o => { if (o.name === 'legColumnUpper') uppers.push(o); });
  check('exactly two telescoping upper stages', uppers.length === 2, uppers.length);
}

// ---- 5. telescoping columns visibly extend more at max than at min -------
// The lower sleeve is fixed (sized to minHeight); the upper stage's bottom
// stays put (a constant overlap into the sleeve) while its TOP -- and hence
// its own height -- grows as the desk stands taller. That growing extension,
// not any single position, is "visibly telescoping".
{
  const atMin = buildStandingDesk(THREE, { width: 120, depth: 80, height: 72, minHeight: 72, maxHeight: 120 });
  const atMax = buildStandingDesk(THREE, { width: 120, depth: 80, height: 120, minHeight: 72, maxHeight: 120 });
  function upperExtents(group) {
    let bottom = null, top = null, h = null;
    group.traverse(o => {
      if (o.name === 'legColumnUpper') {
        h = o.geometry.parameters.height;
        bottom = o.position.y - h / 2;
        top = o.position.y + h / 2;
      }
    });
    return { bottom, top, h };
  }
  const min = upperExtents(atMin.group);
  const max = upperExtents(atMax.group);
  check('upper stage bottom (overlap into the sleeve) stays fixed',
    near(min.bottom, max.bottom, 1e-6), { min, max });
  check('upper stage top rises with height', max.top > min.top, { min, max });
  check('upper stage extension (height) grows with desk height', max.h > min.h, { min, max });
  const lowerH = o => { let hh = null; o.group.traverse(n => { if (n.name === 'legColumnLower') hh = n.geometry.parameters.height; }); return hh; };
  check('lower sleeve height is unchanged by desk height', lowerH(atMin) === lowerH(atMax), { atMin: lowerH(atMin), atMax: lowerH(atMax) });
}

console.log(`${passes} passed, ${failures} failed.`);
if (failures > 0) process.exit(1);
