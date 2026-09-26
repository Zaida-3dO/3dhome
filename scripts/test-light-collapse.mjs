#!/usr/bin/env node
/**
 * Room-light collapse (task cd6d5d05): src/light-merge.js, and the scene's
 * use of it. No framework, no install: `node scripts/test-light-collapse.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. A room channel's fixtures become ONE light (TWO in a room longer than
 *      4 m, one per half along its long axis -- x or z, whichever is longer).
 *   2. The light sits at the fixtures' intensity-weighted centroid and
 *      carries their summed intensity (so the room's total light is kept),
 *      and reaches every point the furthest fixture's light reached.
 *   3. The scene: fixture builders no longer create one PointLight each,
 *      every merged light carries its gain, and syncLights multiplies the
 *      channel's per-fixture intensity by it -- so on/off, brightness and
 *      colour still reach every merged light. Below ultra a cornice is at
 *      most two lights, carrying the share of its 3 or 5 they stand for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const L = await import(pathToFileURL(path.join(root, 'src/light-merge.js')).href);

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const E = (x, z, extra) => Object.assign({ x, y: 2.4, z, intensity: 1, distance: 5, decay: 1.8 }, extra || {});

// ---- 1. one light, or two in a long room --------------------------------------------
{
  const box = { minX: 0, maxX: 3.9, minZ: 0, maxZ: 3.3 };      // 3.9 m: under the 4 m split
  const six = [E(1, 1), E(2, 1), E(3, 1), E(1, 2.3), E(2, 2.3), E(3, 2.3)];
  const one = L.collapseEmitters(six, box);
  check('six downlights in a 3.9 m room -> ONE light', one.length === 1 && one[0].count === 6, one.length);
  const long = { minX: 0, maxX: 6, minZ: 0, maxZ: 3 };           // 6 m along x
  const two = L.collapseEmitters([E(0.5, 1), E(1.5, 2), E(4.5, 1), E(5.5, 2)], long);
  check('a 6 m room -> TWO lights, split along x', two.length === 2 && two[0].count === 2 && two[1].count === 2 &&
    two[0].x < 3 && two[1].x > 3, two.map(t => [t.x, t.count]));
  const deep = { minX: 0, maxX: 3, minZ: -3, maxZ: 3 };           // 6 m along z
  const twoZ = L.collapseEmitters([E(1, -2), E(2, -2.5), E(1, 2), E(2, 2.5)], deep);
  check('a room long in z splits along z', twoZ.length === 2 && twoZ[0].z < 0 && twoZ[1].z > 0,
    twoZ.map(t => [t.z, t.count]));
  const lone = L.collapseEmitters([E(1, 1)], long);
  check('one fixture in a long room -> one light', lone.length === 1 && lone[0].count === 1);
  const sided = L.collapseEmitters([E(0.5, 1), E(1, 2)], long);
  check('all fixtures in one half -> one light', sided.length === 1 && sided[0].count === 2);
  check('threshold is 4 m: 4.0 does not split, 4.01 does',
    L.collapseEmitters([E(1, 1), E(3, 1)], { minX: 0, maxX: 4.0, minZ: 0, maxZ: 3 }).length === 1 &&
    L.collapseEmitters([E(1, 1), E(3, 1)], { minX: 0, maxX: 4.01, minZ: 0, maxZ: 3 }).length === 2);
  // Far-apart fixtures in a short room: a cove strip along the ceiling and
  // one behind the sofa never become one light in mid-air between them.
  const cove = E(1.9, 0.2, { y: 2.36, distance: 2.5 }), sofa = E(0.2, 1.6, { y: 0.6, distance: 2.5 });
  const accents = L.collapseEmitters([cove, sofa], { minX: 0, maxX: 3.9, minZ: 0, maxZ: 3.3 });
  check('fixtures more than SPREAD_M apart -> two lights, each where its fixture was', accents.length === 2 &&
    accents.some(a => near(a.y, 2.36) && near(a.x, 1.9)) && accents.some(a => near(a.y, 0.6) && near(a.x, 0.2)),
    accents.map(a => [a.x, a.y, a.z]));
  check('...and a third strip joins the nearer end', L.collapseEmitters([cove, sofa, E(1.5, 0.2, { y: 2.36 })],
    { minX: 0, maxX: 3.9, minZ: 0, maxZ: 3.3 }).map(g => g.count).sort().join() === '1,2');
  check('a box given max-before-min is normalised',
    L.collapseEmitters([E(0.5, 1), E(5.5, 1)], { minX: 6, maxX: 0, minZ: 3, maxZ: 0 }).length === 2);
  check('no emitters -> no lights', L.collapseEmitters([], long).length === 0);
}

// ---- 2. centroid, intensity, reach ----------------------------------------------------
{
  const box = { minX: 0, maxX: 3, minZ: 0, maxZ: 3 };
  const m = L.collapseEmitters([E(0, 0, { intensity: 3 }), E(2, 0, { intensity: 1 })], box)[0];
  check('intensity-weighted centroid', near(m.x, 0.5) && near(m.z, 0) && near(m.y, 2.4), m);
  check('summed intensity (x MERGED_GAIN)', near(m.intensity, 4 * L.MERGED_GAIN), m.intensity);
  // Reach: the far fixture is 1.5 m from the centroid and had a 5 m range,
  // so the merged light must reach 6.5 m to cover what it lit.
  check('reach covers the furthest fixture\'s pool', near(m.distance, 6.5), m.distance);
  const inf = L.collapseEmitters([E(0, 0, { distance: 0 }), E(1, 0)], box)[0];
  check('an infinite-range member keeps the merged light infinite (0)', inf.distance === 0, inf.distance);
  check('decay is kept', m.decay === 1.8);
  const lone = L.collapseEmitters([E(1, 1, { intensity: 1 })], box)[0];
  check('a lone fixture keeps its intensity exactly (no merge gain)', lone.intensity === 1 && lone.count === 1);
  check('a merge scales the sum by MERGED_GAIN (< 1: one central light over-lights the middle)',
    L.MERGED_GAIN > 0 && L.MERGED_GAIN < 1);
}

// ---- 3. the scene uses it ------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  const builders = src.slice(src.indexOf('const addDownlight = '), src.indexOf('const fixtureY = '));
  check('fixture builders create no PointLight of their own', builders.length > 0 && !/new THREE\.PointLight/.test(builders));
  check('each channel collapses its emitters into gain-carrying lights',
    /collapseEmitters\(emitters, \{ minX: tx\(rm\.x1\)/.test(src) && /pl\.userData\.gain = m\.intensity;/.test(src));
  check('syncLights scales main AND accent lights by their gain',
    /l\.intensity = mb \* 0\.6 \* lightGain\(l\)/.test(src) && /l\.intensity = ab \* 0\.3 \* lightGain\(l\)/.test(src));
  check('an unmerged light has gain 1', /const lightGain = l => \(l\.userData && l\.userData\.gain > 0 \? l\.userData\.gain : 1\);/.test(src));
  check('cornice: at most 2 per cornice below ultra, each carrying its share, on build and on every HA update',
    /cornicePerCornice: tier === 'ultra' \? null : 2,/.test(src) && /const gain = want\[i\] \/ counts\[i\];/.test(src) &&
    /CORNICE_GLOW_INTENSITY \* gain/.test(src) && /CORNICE_GLOW_INTENSITY \* k \* \(g\.userData\.gain \|\| 1\)/.test(src));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
