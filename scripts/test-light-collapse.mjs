#!/usr/bin/env node
/**
 * Room-light collapse (task cd6d5d05): src/light-merge.js, and the scene's
 * use of it. No framework, no install: `node scripts/test-light-collapse.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. A room channel's fixtures become ONE light, or TWO when they are more
 *      than SPREAD_M apart -- decided by the fixtures' spread, never by the
 *      room's size (a tight cluster in a long room is one light; fixtures at
 *      either end of any room are two).
 *   2. A merged light sits at its fixtures' intensity-weighted centroid and
 *      mean height -- always inside their own bounding box, never at the
 *      room's centre -- reaches every point the furthest fixture reached, and
 *      gives the floor the SAME mean irradiance the separate fixtures did.
 *      A lone fixture is untouched. Strips (merge: false) are never merged.
 *   3. The scene: fixture builders no longer create one PointLight each,
 *      strips are passed merge: false, every merged light carries its gain,
 *      and syncLights multiplies the channel's per-fixture intensity by it.
 *      Below ultra a cornice is at most two lights carrying its share.
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

// ---- 1. one light or two: by the fixtures' spread ---------------------------------------
{
  const box = { minX: 0, maxX: 3.9, minZ: 0, maxZ: 3.3 };
  const six = [E(1, 1), E(2, 1), E(3, 1), E(1, 2.3), E(2, 2.3), E(3, 2.3)];
  const one = L.collapseEmitters(six, box);
  check('six downlights within 2.5 m of each other -> ONE light', one.length === 1 && one[0].count === 6, one.length);
  const long = { minX: 0, maxX: 8, minZ: 0, maxZ: 3 };
  const ends = L.collapseEmitters([E(0.5, 1), E(1.5, 2), E(6.5, 1), E(7.5, 2)], long);
  check('fixtures at both ends of a long room -> TWO lights, one per end', ends.length === 2 &&
    ends.every(e => e.count === 2) && Math.min(...ends.map(e => e.x)) < 2 && Math.max(...ends.map(e => e.x)) > 6,
    ends.map(t => [t.x, t.count]));
  const tight = L.collapseEmitters([E(3.5, 1), E(4.5, 1), E(3.5, 2), E(4.5, 2)], long);
  check('a tight cluster in a LONG room -> ONE light (room size decides nothing)', tight.length === 1, tight.length);
  const small = { minX: 0, maxX: 3.9, minZ: 0, maxZ: 3.3 };
  const apart = L.collapseEmitters([E(0.2, 0.2), E(3.7, 3.1)], small);
  check('fixtures more than 2.5 m apart in a SMALL room -> TWO lights', apart.length === 2, apart.length);
  check('threshold: 2.5 m apart is one light, 2.51 m is two',
    L.collapseEmitters([E(0, 0), E(2.5, 0)], small).length === 1 && L.collapseEmitters([E(0, 0), E(2.51, 0)], small).length === 2);
  const three = L.collapseEmitters([E(0, 0), E(0.5, 0), E(5, 0)], long);
  check('a third fixture joins the nearer end', three.map(g => g.count).sort().join() === '1,2');
  check('no emitters -> no lights', L.collapseEmitters([], long).length === 0);
}

// ---- 2. position, reach, irradiance; lone fixtures; strips ----------------------------------
{
  const box = { minX: 0, maxX: 3, minZ: 0, maxZ: 3 };
  const m = L.collapseEmitters([E(0.5, 1, { intensity: 3, y: 2.4 }), E(2, 1, { intensity: 1, y: 2.0 })], box)[0];
  check('intensity-weighted centroid AND mean height', near(m.x, 0.875) && near(m.z, 1) && near(m.y, 2.3), [m.x, m.y, m.z]);
  // Under-cupboard strips on opposite walls of a demo-like kitchen, at 1.45 m,
  // 2.37 m apart: IF they were merged, the light must stay inside their own
  // bounding box (between them, at their height), never at the room centre.
  const k1 = E(4.3, 0.25, { y: 1.45, distance: 2.5, decay: 2 }), k2 = E(4.3, 2.62, { y: 1.45, distance: 2.5, decay: 2 });
  const kBox = { minX: 3.05, maxX: 5.55, minZ: 0.05, maxZ: 2.75 };
  const inBox = (p, pts) => ['x', 'y', 'z'].every(ax => p[ax] >= Math.min(...pts.map(q => q[ax])) - 1e-9 &&
    p[ax] <= Math.max(...pts.map(q => q[ax])) + 1e-9);
  const km = L.collapseEmitters([k1, k2], kBox)[0];
  check('a merged light lies inside its fixtures\' bounding box, at their height', km.count === 2 && inBox(km, [k1, k2]) &&
    near(km.y, 1.45), [km.x, km.y, km.z]);
  const rnd = [E(0.3, 0.4, { y: 2.4 }), E(1.9, 0.2, { y: 2.3 }), E(1.1, 1.8, { y: 2.45 }), E(0.2, 2.1, { y: 2.4, intensity: 2 })];
  const rm = L.collapseEmitters(rnd, box);
  check('...for any group it forms', rm.every(g => inBox(g, g.members.map(i => rnd[i]))));
  // Strips: merge false -> one light per strip, exactly where it was.
  const strips = L.collapseEmitters([k1, k2], kBox, { merge: false });
  check('strips (merge: false) are never merged: each keeps its own light, position and intensity', strips.length === 2 &&
    near(strips[0].z, 0.25) && near(strips[1].z, 2.62) && strips.every(g => g.intensity === 1 && g.distance === 2.5));
  // Reach: the far fixture is 1.5 m from the centroid and had a 5 m range.
  const r2 = L.collapseEmitters([E(0, 0), E(2, 0), E(1, 0)], box)[0];
  check('reach covers the furthest fixture\'s pool', near(r2.distance, 6), r2.distance);
  const inf = L.collapseEmitters([E(0, 0, { distance: 0 }), E(1, 0)], box)[0];
  check('an infinite-range member keeps the merged light infinite (0)', inf.distance === 0, inf.distance);
  check('decay is kept', m.decay === 1.8);
  // Irradiance: the merged light gives the floor the same MEAN irradiance
  // the separate fixtures did, with three's own falloff.
  const room = { minX: 0, maxX: 3.9, minZ: 0, maxZ: 3.3 };
  const dl = [E(1, 1), E(2, 1), E(3, 1), E(1, 2.3), E(2, 2.3), E(3, 2.3)].map(e => Object.assign(e, { y: 2.43, distance: 7 }));
  const mm = L.collapseEmitters(dl, room)[0];
  const meanE = lights => { let s = 0, n = 0; for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) {
    const px = room.minX + (room.maxX - room.minX) * (i + 0.5) / 40, pz = room.minZ + (room.maxZ - room.minZ) * (j + 0.5) / 40;
    lights.forEach(l => { s += (l.intensity || 0) * L.floorIrradiance(l, px, 0, pz); }); n++; } return s / n; };
  const before = meanE(dl), after = meanE([mm]);
  check('merged light matches the floor\'s mean irradiance (within 2% on an independent 40x40 grid)',
    Math.abs(after / before - 1) < 0.02, { before, after });
  check('...which is LESS than the summed intensity (a central light over-lights the floor)', mm.intensity < 6, mm.intensity);
  check('three.js falloff: 1/max(d^decay, 0.01), windowed to the cutoff',
    near(L.attenuation(2, 0, 2), 0.25) && near(L.attenuation(2, 4, 2), 0.25 * Math.pow(1 - 1 / 16, 2)) && L.attenuation(5, 4, 2) === 0);
  const lone = L.collapseEmitters([E(1, 1, { intensity: 1 })], box)[0];
  check('a lone fixture keeps its intensity and position exactly', lone.intensity === 1 && lone.count === 1 && near(lone.x, 1));
}

// ---- 3. the scene uses it ------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  const builders = src.slice(src.indexOf('const addDownlight = '), src.indexOf('const fixtureY = '));
  check('fixture builders create no PointLight of their own', builders.length > 0 && !/new THREE\.PointLight/.test(builders));
  check('strips are passed merge: false', /\{ merge: g\.fixtureType !== 'strip', floorY: FY \}/.test(src));
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
